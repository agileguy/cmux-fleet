#!/usr/bin/env node
/**
 * The escape-attempt honeypot (ISC-125).
 *
 * ## What this is for
 *
 * Everything else in this fleet's container posture is PREVENTION: `--user
 * 10001`, `--cap-drop ALL`, `--read-only`, `--security-opt
 * no-new-privileges`, an `--internal` network, and above all NO Docker socket
 * mount (ISC-25/26/29/30). Prevention that works leaves no record, and that
 * is the gap this file closes: an operator running the numbers at the end of
 * a run cannot tell "no worker ever tried" from "a worker tried every hour
 * and the flags held". Those are very different runs.
 *
 * ## Why a honeypot rather than a syscall monitor
 *
 * `/var/run/docker.sock` does not exist in a worker container, so a worker
 * that opens it gets `ENOENT` and the host sees nothing. A `--cap-drop ALL`
 * container's FAILED syscall is invisible from outside without auditd or
 * seccomp-notify, neither of which this fleet requires of the host. The only
 * detector that works with what a plain Docker daemon gives us is a live
 * AF_UNIX listener bound at that path: the attempt becomes a `connect(2)`
 * that lands somewhere we control.
 *
 * A named pipe was ruled out on MECHANISM, not taste. A Docker client issues
 * `connect(2)` on an AF_UNIX socket; against a FIFO that fails `ENOTSOCK` and
 * never unblocks a reader, so the cheap `cat`-in-the-background variant
 * detects nothing a real client does.
 *
 * ## Why it records the CONNECT and nothing else
 *
 * The listener accepts, records, and destroys the connection without reading
 * a byte or writing one. Two reasons, and the second is the important one:
 *
 *  - The connect IS the attempt. A client that opens the socket and sends
 *    nothing has still tried to reach the Docker daemon, and a detector that
 *    waited for a well-formed HTTP request would miss it.
 *  - A detector that spoke any part of the Docker API would BE a capability.
 *    The whole point is that reaching this path grants nothing; a client gets
 *    a reset (`curl` reports exit 56) and learns only that something is
 *    listening.
 *
 * ## Why the paths are constants and not environment
 *
 * `docker/verbgate` learned this the hard way and says so in its own header:
 * the subject of a control must not get to configure the control. If the
 * ledger path came from the environment, a worker could point the honeypot's
 * evidence at `/dev/null` and the detector would still report itself armed.
 * The ONE thing the environment decides is whether this process runs at all,
 * and that decision is made by `docker/entrypoint.sh` from a variable
 * delivered through `--env-file` — a file written on the host, outside every
 * mount the worker can reach.
 *
 * ## Failing loudly
 *
 * Every error path here exits non-zero, and the entrypoint treats this
 * process's death as fatal to the whole worker (the owner decision recorded
 * against ISC-125). A honeypot whose listener has silently died reports "no
 * escape attempt" when it was simply not watching, and a detector that cannot
 * be observed failing is worth less than no detector at all. The cost — a
 * worker container that ends when its listener ends — was accepted
 * explicitly, because the alternative is a run report that cannot tell clean
 * from unwatched.
 */

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The bait. `/var/run` is a symlink to `/run` on Debian, so this resolves onto
 * the tmpfs `buildDockerArgv` mounts there — the only writable place in a
 * `--read-only` container that a Docker client would ever look.
 */
const SOCKET_PATH = "/var/run/docker.sock";

/**
 * The evidence channel, and it is deliberately the SAME file `docker/verbgate`
 * writes: `/outbox/ledger/verbgate.jsonl`.
 *
 * Reusing it is not laziness, it is the whole reason this criterion became
 * buildable. ISC-172 made that file a trail the host takes custody of on every
 * daemon tick, whose truncation is DETECTED and RECORDED even when a worker
 * rewrites it in place with same-length rows. A second file would need a
 * second collector with its own frontier fingerprint to get the same property,
 * which is new transport for no new guarantee.
 *
 * The collector wraps every worker-authored line in a `line` string field, so
 * a worker cannot forge a top-level collector record however it fills this
 * file. It CAN forge an `escape_attempt` row — but forging an alarm against
 * yourself is not an attack, and the row it cannot forge away is the one
 * already collected.
 */
const LEDGER_PATH = "/outbox/ledger/verbgate.jsonl";

/**
 * How many individual attempts get their own row before recording collapses to
 * a single flood marker.
 *
 * A worker that discovers the socket can connect to it in a loop, and an
 * unbounded detector would let it fill the operator's audit trail with its own
 * noise — burying, among other things, the verbgate rows sharing this file.
 * The count is not lost when the cap is hit; only the per-attempt rows stop.
 */
const MAX_ATTEMPT_ROWS = 100;

/** ISO-8601 with milliseconds, matching every other record in this repo. */
function now() {
  return new Date().toISOString();
}

/**
 * Append one record, or die.
 *
 * `appendFileSync` opens with `O_APPEND`, so concurrent writers — verbgate
 * runs as its own process in this container — interleave whole lines rather
 * than corrupting each other, and the write needs no lock.
 *
 * A failure here is FATAL rather than logged. This process exists to produce
 * exactly these rows; one that cannot write them is not a degraded detector,
 * it is an absent one wearing a running process's clothes.
 */
function record(row) {
  try {
    fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(row)}\n`);
  } catch (err) {
    process.stderr.write(`pifleet-honeypot: cannot write ${LEDGER_PATH}: ${String(err)}\n`);
    process.exit(1);
  }
}

let attempts = 0;
let flooded = false;

const server = net.createServer((conn) => {
  attempts += 1;
  if (attempts <= MAX_ATTEMPT_ROWS) {
    record({
      ts: now(),
      event: "escape_attempt",
      target: SOCKET_PATH,
      /**
       * Which attempt this is, so a report can tell one connect from a
       * hundred without counting rows that the cap may have stopped emitting.
       */
      seq: attempts,
    });
  } else if (!flooded) {
    flooded = true;
    record({ ts: now(), event: "escape_attempt_flood", target: SOCKET_PATH, after: MAX_ATTEMPT_ROWS });
  }
  // Nothing is read and nothing is written. See the header: a detector that
  // answered would be a capability.
  conn.destroy();
});

server.on("error", (err) => {
  process.stderr.write(`pifleet-honeypot: cannot listen on ${SOCKET_PATH}: ${String(err)}\n`);
  process.exit(1);
});

/**
 * Clean shutdown. The entrypoint sends SIGTERM when the WORKER has finished,
 * which is the only ordering in which this process ending is not a fault, so
 * it is the only one that exits 0.
 */
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}

try {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
} catch (err) {
  process.stderr.write(`pifleet-honeypot: cannot create ${path.dirname(LEDGER_PATH)}: ${String(err)}\n`);
  process.exit(1);
}

server.listen(SOCKET_PATH, () => {
  /**
   * The `armed` row is written only AFTER a successful bind, and that order is
   * the point: this row is the claim "from this timestamp, a connect to the
   * Docker socket in this container would have been recorded". Emitting it
   * before the bind would make it a claim about intent.
   *
   * It is also what lets `pifleet report` distinguish THREE states rather than
   * two — attempts observed, watched-and-clean, and never-watched. Without it
   * a report can only say "no attempts recorded", which is exactly the
   * sentence that means nothing.
   */
  record({ ts: now(), event: "honeypot_armed", target: SOCKET_PATH });
  /**
   * STDERR, NEVER STDOUT, and this is not a style preference.
   *
   * The worker container's STDOUT IS THE RPC STREAM — JSONL over
   * stdin/stdout, per `src/rpc/client.ts`. This process is started by
   * `docker/entrypoint.sh` and inherits its descriptors, so a single line
   * written here lands in the middle of that stream, ahead of Pi's first
   * message, and the worker dies during startup with nothing anywhere saying
   * why.
   *
   * It shipped that way. `container-live` — the only job that drives a real
   * `up` through the real RPC path — is what caught it, seven minutes into a
   * run, as `worker eng-1 died during startup`. Every probe in
   * `test/integration/honeypot.test.ts` passed on the broken code: they all
   * run `PIFLEET_WORKER_BIN=/bin/bash` and read the two streams MERGED, which
   * is exactly the reading that cannot see this. There is now a case there
   * that reads stdout ALONE and asserts it carries the worker's bytes and
   * nothing else.
   */
  process.stderr.write(`pifleet-honeypot: armed at ${SOCKET_PATH}\n`);
});
