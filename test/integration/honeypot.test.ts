/**
 * The escape-attempt honeypot, end to end (ISC-125).
 *
 * The criterion is "a seeded escape attempt from inside a container is
 * DETECTED and REPORTED", and the two verbs have historically failed
 * separately: detection was absent because a `--cap-drop ALL` container's
 * failed syscall is invisible from the host, and reporting was absent because
 * the run report carried no security field at all. Both halves are in the same
 * file here on purpose — a probe that stopped at the ledger would prove the
 * first and leave the second exactly as unproved as it was.
 *
 * ## Why these run against a real container and cannot be mocked
 *
 * Every interesting property of this feature is a property of the container:
 * whether a `/run` tmpfs with a uid option lets uid 10001 bind an AF_UNIX
 * socket, whether `curl --unix-socket` against it is observed, whether a
 * supervisor written in bash notices its background child dying, and whether
 * the bytes the listener writes survive the bind mount to the host collector.
 * A test double for any of those would be a test of our beliefs about Docker.
 *
 * ## The chain each probe drives
 *
 *   docker/honeypot.cjs  →  /outbox/ledger/verbgate.jsonl   (in-container)
 *   VerbgateCollector    →  <run>/audit/<worker>.jsonl      (ISC-172 custody)
 *   collectRunReport     →  report.security.escape_watch
 *   renderRunReport      →  what the operator actually reads
 *
 * No link is stubbed. That is the point: three of the four already existed and
 * were separately proved, and the criterion is about them being ONE path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeDaemonScratch, makeWorkerAccessible, WORKER_UID } from "../../src/container/mounts.ts";
import { runPaths, workerOutboxDir, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { VerbgateCollector } from "../../src/run/verbgate-collect.ts";
import { collectRunReport } from "../../src/report/collect.ts";
import { renderRunReport } from "../../src/report/render.ts";
import { containerBudget } from "../support/budget.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] honeypot integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

const scratches: string[] = [];
afterEach(async () => {
  await Promise.all(scratches.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * A run tree with one worker, shaped the way `up` leaves it.
 *
 * `workers/<id>/` is created even though nothing in these probes reads a
 * worker state file, and it is load-bearing: `collectRunReport` enumerates
 * THAT directory to decide which containers to report on, precisely so a
 * worker whose evidence never arrived still gets a row. A run tree with an
 * audit file and no worker directory would report nothing and every assertion
 * below would pass vacuously.
 *
 * `outbox/<id>/ledger` is pre-created and widened for the reason `verbgate`'s
 * own sandbox gives: on Linux a bind mount passes host ownership through, so a
 * directory the container creates belongs to uid 10001 and the runner can
 * neither unlink inside it nor chmod it — `afterEach` then fails with EACCES
 * having asserted everything correctly. macOS squashes ownership and hides it.
 */
async function plantRun(prefix: string): Promise<{ run: RunPaths; worker: string; outbox: string }> {
  const root = await makeDaemonScratch(prefix);
  scratches.push(root);
  const run = runPaths(`r-${prefix}-${process.pid.toString(36)}`, root);
  const worker = "eng-1";
  await mkdir(workerPaths(run, worker).dir, { recursive: true });
  const outbox = workerOutboxDir(run.root, worker);
  await mkdir(join(outbox, "ledger"), { recursive: true });
  await makeWorkerAccessible(outbox, true);
  await makeWorkerAccessible(join(outbox, "ledger"), true);
  return { run, worker, outbox };
}

/**
 * The production launch shape, minus the mounts a worker does not need to
 * demonstrate this.
 *
 * The hardening flags are spelled out rather than taken from
 * `buildDockerArgv` deliberately. `render.test.ts` already asserts that the
 * builder emits these; what is unproved is that the honeypot works UNDER them,
 * and a probe that inherited them from the builder would go green if someone
 * dropped `--cap-drop ALL` from it.
 */
function launchArgv(outbox: string, honeypot: boolean, script: string): string[] {
  return [
    "docker", "run", "--rm",
    "--read-only",
    "--user", `${WORKER_UID}:${WORKER_UID}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--network", "none",
    "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    // The tmpfs the bait lives on. Without the uid option the mount is
    // root-owned 0755 and the bind fails EACCES — measured both ways before
    // `buildDockerArgv` was written, which is why the option is here and not
    // assumed.
    "--tmpfs", `/run:rw,noexec,nosuid,size=1m,uid=${WORKER_UID},gid=${WORKER_UID}`,
    ...(honeypot ? ["-e", "PIFLEET_HONEYPOT=1"] : []),
    "-e", "PIFLEET_WORKER_BIN=/bin/bash",
    "-v", `${outbox}:/outbox`,
    IMAGE,
    "-c", script,
  ];
}

/**
 * Run one worker container through the REAL entrypoint — not `--entrypoint
 * bash`, which every other container probe in this repo uses.
 *
 * That distinction is the test. `docker/entrypoint.sh` is what starts the
 * listener, waits for it to arm, and supervises it; bypassing it would leave
 * the honeypot unstarted and every assertion here would be about a socket that
 * was never bound.
 */
async function runWorker(
  outbox: string,
  script: string,
  opts: { honeypot?: boolean } = {},
): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(launchArgv(outbox, opts.honeypot ?? true, script), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: `${stdout}${stderr}` };
}

/** Like `runWorker`, but keeps the two streams apart. See the probe that uses it. */
async function runWorkerSplit(
  outbox: string,
  script: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(launchArgv(outbox, true, script), { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/** Take host custody of the worker's ledger, then build the run report. */
async function reportFor(run: RunPaths) {
  await new VerbgateCollector(run).collectOnce();
  const collected = await collectRunReport(run, { precheck: async () => [] });
  return {
    report: collected.report,
    text: renderRunReport(collected.report, collected.notes, collected.attended, collected.attendedUnverified),
  };
}

/** The seed the criterion names: reach for the Docker socket. */
const SEED = (n: number) =>
  `for i in $(seq 1 ${n}); do curl -s --max-time 3 --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 2>&1; echo "seed_rc=$?"; done; sleep 0.5`;

describe.skipIf(!DOCKER)("a seeded escape attempt is detected and reported (ISC-125)", () => {
  /**
   * THE CRITERION'S CLOSING PROBE.
   *
   * A worker reaches for `/var/run/docker.sock` from inside its own container,
   * with its own uid, under the full production posture, and the attempt comes
   * out the other end of the chain in the operator's report.
   *
   * `seed_rc=56` is asserted as well as the report row, and it is not
   * decoration: 56 is curl's "connection reset by peer", which is what proves
   * the honeypot ACCEPTED and then hung up rather than the client failing to
   * connect at all. A detector that had never bound would give 7 (couldn't
   * connect) and the attempt would go unrecorded — so without this the probe
   * could not tell "detected and refused" from "no socket there".
   */
  test(
    "a worker that reaches for the Docker socket appears in the run report",
    async () => {
      const { run, worker, outbox } = await plantRun("hpdet");
      const w = await runWorker(outbox, SEED(2));

      expect(w.code).toBe(0);
      // The seed must actually have hit a live listener, or the rest of this
      // test is asserting against a worker that never managed to try.
      expect(w.out).toContain("seed_rc=56");

      const { report, text } = await reportFor(run);
      const watch = report.security.escape_watch.find((e) => e.worker === worker);
      expect(watch, "the report has no row for this worker at all").toBeDefined();
      // Armed AND caught. Either alone is a different, weaker claim: an
      // unarmed row with attempts is impossible, and an armed row with none is
      // the clean case the next test covers.
      expect(watch!.armed).toBe(true);
      expect(watch!.attempts).toBe(2);
      expect(watch!.flooded).toBe(false);
      expect(watch!.first_attempt_at).not.toBeNull();

      // REPORTED, not merely detected — the half that did not exist at all
      // before this criterion. Asserted on the rendered text an operator
      // reads, not only on the JSON, because a field nothing prints is not a
      // report.
      expect(text).toContain("ESCAPE ATTEMPT");
      expect(text).toContain(worker);
      expect(text).toContain("/var/run/docker.sock");
    },
    containerBudget(2),
  );

  /**
   * The positive control, and it carries the sentence that makes the whole
   * feature worth anything.
   *
   * Without it, the probe above is satisfied by a report that shouts on every
   * run. With it, "no attempt observed" is an EARNED claim: the same image,
   * the same launch shape, a worker that simply did not try, and a report that
   * says the detector was armed in one container and saw nothing.
   *
   * The clean line names the container COUNT on purpose. "no escape attempts"
   * reads identically whether the detector ran or was absent, which is the
   * ambiguity this criterion exists to remove.
   */
  test(
    "a worker that does not try is reported as watched and clean",
    async () => {
      const { run, worker, outbox } = await plantRun("hpclean");
      const w = await runWorker(outbox, `echo "worked"; sleep 0.3`);

      expect(w.code).toBe(0);
      expect(w.out).toContain("worked");

      const { report, text } = await reportFor(run);
      const watch = report.security.escape_watch.find((e) => e.worker === worker);
      expect(watch!.armed).toBe(true);
      expect(watch!.attempts).toBe(0);
      expect(text).toContain("escape detector armed in 1 container(s)");
      expect(text).not.toContain("ESCAPE ATTEMPT");
      expect(text).not.toContain("NOT WATCHED");
    },
    containerBudget(2),
  );

  /**
   * THE OWNER DECISION, PROVED: the listener's death is FATAL.
   *
   * This is what makes the clean case above mean anything. A honeypot whose
   * listener has silently died reports "no escape attempt" when it was simply
   * not watching, so the entrypoint supervises both and ends the worker if the
   * detector goes. Without this probe, that guarantee is a comment.
   *
   * The kill targets the process by its `/proc/<pid>/exe` rather than by name.
   * `pkill -f pifleet-honeypot` was tried first and is a VACUOUS probe twice
   * over: `pkill` is not in the image, and the pattern also matches the
   * entrypoint's and the worker's own argv, which contain the literal string
   * from this script. It reported success and killed nothing, and the test
   * passed while proving the opposite of what it claimed.
   *
   * `SURVIVED` is asserted absent as well as the exit code, because an exit 71
   * from any other cause — a script error, a missing binary — would otherwise
   * read as the supervisor doing its job.
   */
  test(
    "killing the listener ends the worker container",
    async () => {
      const { outbox } = await plantRun("hpfatal");
      const w = await runWorker(
        outbox,
        `victim=""
         for p in $(ls /proc | grep -E "^[0-9]+$"); do
           case "$(readlink /proc/$p/exe 2>/dev/null)" in */node) victim=$p ;; esac
         done
         echo "victim=$victim"
         kill -9 "$victim"
         for i in $(seq 1 20); do sleep 0.5; done
         echo "SURVIVED"`,
      );

      // 71 is the entrypoint's code for "the detector went away", distinct
      // from any code the worker itself could return.
      expect(w.code).toBe(71);
      expect(w.out).toContain("ending the worker (ISC-125)");
      expect(w.out).not.toContain("SURVIVED");
    },
    containerBudget(2),
  );

  /**
   * NOTHING THE SUPERVISOR OR THE DETECTOR PRINTS MAY REACH STDOUT.
   *
   * The worker container's stdout IS the RPC stream — JSONL over
   * stdin/stdout, `src/rpc/client.ts`. Both the entrypoint and the honeypot
   * inherit that descriptor, so one stray line lands in the middle of the
   * stream ahead of Pi's first message and the worker dies during startup
   * with nothing anywhere saying why.
   *
   * THIS PROBE EXISTS BECAUSE THAT SHIPPED. `pifleet-honeypot: armed at …`
   * went to stdout, and every probe in this file passed: they all run
   * `PIFLEET_WORKER_BIN=/bin/bash` and read the two streams MERGED, which is
   * precisely the reading that cannot see the defect. `container-live` — the
   * only job that drives a real `up` through the real RPC path — caught it,
   * seven minutes into a run, as `worker eng-1 died during startup`.
   *
   * `toBe`, not `toContain`. The claim is that stdout carries the worker's
   * bytes and NOTHING ELSE, and `toContain` is satisfied by a stream with
   * arbitrary extra lines in it — which is the exact failure.
   *
   * The stderr half is asserted too, and it is not decoration: it is what
   * distinguishes "the detector's output moved to the right stream" from "the
   * detector stopped announcing itself", and only the first is the fix.
   */
  test(
    "the supervisor keeps its own output off the RPC stream",
    async () => {
      const { outbox } = await plantRun("hprpc");
      const w = await runWorkerSplit(outbox, `printf '{"jsonrpc":"2.0"}\\n'`);
      expect(w.code).toBe(0);
      expect(w.stdout).toBe('{"jsonrpc":"2.0"}\n');
      // The listener really did come up — otherwise this probe would pass on a
      // container with no detector in it at all.
      expect(w.stderr).toContain("armed at /var/run/docker.sock");
    },
    containerBudget(2),
  );

  /**
   * The supervisor REPORTS the worker rather than replacing it.
   *
   * This is not about the honeypot at all; it is about what turning a bare
   * `exec` into a supervisor put at risk. Every other container probe in this
   * repo runs `--entrypoint bash`, so nothing else re-checks that a worker's
   * own exit code still reaches Docker — and pifleet's whole verdict ladder
   * reads it: `WORKER_DIED`, the budget halt, and every `failed` in a run
   * report descend from this number.
   *
   * A distinctive code, not 1: a supervisor that collapsed every failure to 1
   * would pass an assertion written against it, and so would one that lost the
   * code entirely and inherited bash's own last status.
   *
   * The specific hazard measured here: `[ -n "${honeypot_pid}" ] && kill …`
   * sits immediately before the `exit "${rc}"` on this path. Under `set -e` a
   * failing `&&` list can end a script, and bash exempts it only because the
   * failing command is not the last in the list. That is a rule, not an
   * intention, and a future edit that reorders those two lines would silently
   * turn every non-zero worker into a 1.
   */
  test(
    "a worker's own exit code survives the supervisor",
    async () => {
      const { outbox } = await plantRun("hprc");
      const w = await runWorker(outbox, `echo "about to fail"; exit 42`);
      expect(w.out).toContain("about to fail");
      expect(w.code).toBe(42);
    },
    containerBudget(2),
  );

  /**
   * `docker stop` still stops it, promptly, through the worker's own handler.
   *
   * The bare `exec` this file replaced made signal delivery free: tini was PID
   * 1 and the worker was its direct child. A supervisor breaks that — tini now
   * signals the SUPERVISOR — so the trap that forwards SIGTERM is load-bearing
   * and nothing else exercises it. `down reaps the container` in
   * container-launch.test.ts is the nearest thing and it runs `alpine:latest`,
   * which has none of this in it.
   *
   * The elapsed-time bound is the assertion that matters. Without the trap the
   * container still dies — Docker SIGKILLs it after the grace period — so a
   * probe that only checked "it stopped" would pass on the broken code and
   * take ten seconds doing it. `--time 5` with a bound well under it separates
   * "handled" from "timed out".
   */
  test(
    "docker stop reaches the worker through the supervisor's trap",
    async () => {
      const { outbox } = await plantRun("hpstop");
      const name = `pifleet-hp-stop-${process.pid.toString(36)}`;
      const argv = launchArgv(outbox, true, `trap 'echo GOT_TERM; exit 0' TERM
         for i in $(seq 1 300); do sleep 1; done`);
      // Detached, and `--rm` dropped so the logs and exit code survive the stop.
      const detached = [...argv];
      detached.splice(detached.indexOf("--rm"), 1, "-d", "--name", name);

      const start = Bun.spawn(detached, { stdout: "ignore", stderr: "pipe" });
      const startErr = await new Response(start.stderr).text();
      expect(await start.exited, `docker run failed: ${startErr}`).toBe(0);
      try {
        // The listener has to be up before the stop, or this measures the
        // arming wait rather than the trap.
        await Bun.sleep(1500);
        const began = performance.now();
        await Bun.spawn(["docker", "stop", "--time", "5", name], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
        const elapsed = performance.now() - began;

        const logs = Bun.spawn(["docker", "logs", name], { stdout: "pipe", stderr: "pipe" });
        const text = `${await new Response(logs.stdout).text()}${await new Response(logs.stderr).text()}`;
        await logs.exited;
        const inspect = Bun.spawn(["docker", "inspect", "-f", "{{.State.ExitCode}}", name], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const code = (await new Response(inspect.stdout).text()).trim();
        await inspect.exited;

        expect(text).toContain("GOT_TERM");
        expect(code).toBe("0");
        expect(elapsed).toBeLessThan(4000);
      } finally {
        await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
      }
    },
    containerBudget(3),
  );

  /**
   * The THIRD state, which is the one an operator would otherwise never learn
   * about: a container nothing was watching.
   *
   * The launch drops `PIFLEET_HONEYPOT=1` — the exact shape of a
   * misconfiguration, since `buildWorkerEnv` sets it unconditionally and there
   * is no switch to turn it off. The worker runs perfectly and the report
   * refuses to call the run clean.
   *
   * `not.toContain` on the clean sentence is half the assertion. A report that
   * printed BOTH "armed in 1 container(s)" and "NOT WATCHED" would be
   * self-contradicting, and only the negative catches that.
   */
  test(
    "a container launched without the detector is reported NOT WATCHED",
    async () => {
      const { run, worker, outbox } = await plantRun("hpunwatched");
      const w = await runWorker(outbox, `echo "worked"; sleep 0.2`, { honeypot: false });

      expect(w.code).toBe(0);
      expect(w.out).toContain("worked");

      const { report, text } = await reportFor(run);
      const watch = report.security.escape_watch.find((e) => e.worker === worker);
      expect(watch, "an unwatched worker must still get a row").toBeDefined();
      expect(watch!.armed).toBe(false);
      expect(watch!.attempts).toBe(0);
      expect(text).toContain("NOT WATCHED");
      expect(text).toContain(worker);
      expect(text).not.toContain("escape detector armed in");
    },
    containerBudget(2),
  );
});
