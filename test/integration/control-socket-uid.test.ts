/**
 * ISC-126, the criterion itself: the control socket refuses a connection from
 * ANOTHER UID — a real second uid, connecting for real.
 *
 * `test/unit/control-socket-peer-uid.test.ts` proves every layer this rests on
 * without Docker, and it can do everything except be somebody else. That is the
 * one thing a developer machine cannot supply without `sudo`, and it is the
 * whole content of the criterion, so it needs a container.
 *
 * ## The shape, and why it is NOT "bind-mount the socket, connect from a
 * container"
 *
 * That was the obvious design, it is what ISA.md's note anticipated, and it
 * does not work. The note blamed the macOS path: `socketPath()` puts sockets
 * under `os.tmpdir()`, which is `/var/folders/...` there and is not in the
 * Docker VM's shared set, so the container would mount an empty directory and
 * the probe would pass or fail for reasons unrelated to uid.
 *
 * That reasoning is correct and INCOMPLETE, measured 2026-08-24. Repeating the
 * experiment from a directory that IS shared — under `$HOME`, exactly where
 * `container/mounts.ts` says bind mounts do work — the socket appears in the
 * container, `ls -l` shows it as a socket with the right mode, and `connect(2)`
 * returns **ENOTSUP**. It fails identically for a matching uid and a different
 * one, so the shape cannot distinguish the two on macOS AT ALL. The blocker is
 * not the shared set; it is that the VM's filesystem passthrough carries the
 * NAME of a unix socket and not the socket, so no host path can be made to
 * work. Fixing the path would have produced a probe that still proved nothing
 * here, and whose green state could only ever have been seen on CI.
 *
 * So the probe puts BOTH ENDS INSIDE ONE CONTAINER. The socket lives on the
 * container's own filesystem, where it is an ordinary Linux unix socket; the
 * server runs as uid 0 and the probing client as uid 12345, via `docker exec
 * -u`. That is a genuine second uid on a shared kernel, it works on any Docker,
 * and both the red and green states of every assertion below were observed on
 * the maintainer's macOS machine before this shipped.
 *
 * ## What the three probes separate
 *
 * The server opens TWO sockets, and the difference between them is the point:
 *
 *   - `tight/` has production's permissions — 0700, set by `serveJsonlSocket`
 *     in code rather than by the operator's umask. Another uid is refused by
 *     the KERNEL, before accept.
 *   - `open/` is chmodded 0777 on both the directory and the socket after the
 *     listener is up, reproducing exactly the state ISC-126 measured under
 *     `umask 000` — the state in which the old code let another uid through to
 *     the auth token. The accept-time credential check is then the only thing
 *     that can refuse, so probe 2 is the one that proves the CONTROL rather
 *     than the permission bits.
 *
 * The third is the control, and it is what stops the other two from being
 * vacuous: the SAME socket, the SAME secret, the SAME container, from the
 * server's own uid, must be SERVED. Without it, a probe that refused everything
 * — a broken mount, a dead server, a typo in the socket path — would read as a
 * pass. The only variable between probe 2 and probe 3 is the uid.
 *
 * Note what probe 2 also establishes: the request it sends is fully
 * authenticated, carrying the correct per-run secret. It is refused anyway.
 * That is the fact `security/control-auth.ts` needed and did not have — its
 * header calls itself the SECOND line of defence on the basis that filesystem
 * permissions handle another USER, and until now nothing established the first.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { containerBudget, opsBudget } from "../support/budget.ts";
import { PROBE_BUN_IMAGE } from "../support/probe-image.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";

/**
 * The uid the probe connects as. Arbitrary, high, and deliberately not a uid
 * the image defines: it must be someone the server is not, and nothing else
 * about it matters.
 */
const OTHER_UID = 12345;

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const PROBE_SRC = new URL("../support/peer-uid-probe.ts", import.meta.url).pathname;
const SECRET = randomBytes(32).toString("hex");

let containerId = "";
let setupFailure: string | null = null;

interface Verdict {
  uid: number | null;
  connect: "ok" | "error";
  errno: string | null;
  response: Record<string, unknown> | null;
  closedByServer: boolean;
}

async function docker(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err };
}

/** Run the probe's client half as `uid` and parse its single JSON line. */
async function probeAs(uid: number, sockPath: string): Promise<Verdict> {
  const r = await docker([
    "exec",
    "-u",
    String(uid),
    // The secret travels in the ENVIRONMENT, never in argv — argv is visible in
    // `ps` and in `docker inspect`, which is the fix #18 made for the relay's
    // API key and the shape a test should model rather than undo.
    "-e",
    `PIFLEET_PROBE_SECRET=${SECRET}`,
    containerId,
    "bun",
    // The COPY at the container root, not the bind-mounted original: this
    // command runs as a uid that may not be able to read the mount, and a probe
    // that died on a mount permission would look exactly like a uid refusal.
    "/probe.ts",
    "client",
    sockPath,
  ]);
  if (r.code !== 0) {
    throw new Error(`probe client as uid ${uid} exited ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`);
  }
  const line = r.out.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Verdict;
  } catch {
    throw new Error(`probe client as uid ${uid} printed no verdict\nstdout: ${r.out}\nstderr: ${r.err}`);
  }
}

beforeAll(async () => {
  if (!DOCKER) return;
  const run = await docker([
    "run",
    "-d",
    "--user",
    "0:0",
    "-e",
    "HOME=/tmp",
    "-e",
    `PIFLEET_PROBE_SECRET=${SECRET}`,
    "-v",
    `${REPO_ROOT}:/repo:ro`,
    "--entrypoint",
    "sleep",
    PROBE_BUN_IMAGE,
    "600",
  ]);
  if (run.code !== 0) {
    setupFailure = `docker run failed: ${run.err}`;
    return;
  }
  containerId = run.out.trim();

  // The client half is COPIED in rather than read from the mount, so it is
  // readable by any uid regardless of how host ownership lands on this runner.
  const cp = await docker(["cp", PROBE_SRC, `${containerId}:/probe.ts`]);
  if (cp.code !== 0) {
    setupFailure = `docker cp failed: ${cp.err}`;
    return;
  }

  const start = await docker([
    "exec",
    "-d",
    containerId,
    "sh",
    "-c",
    "bun /repo/test/support/peer-uid-probe.ts server /tmp/probe > /tmp/server.log 2>&1",
  ]);
  if (start.code !== 0) {
    setupFailure = `starting the probe server failed: ${start.err}`;
    return;
  }

  // Wait INSIDE the container rather than polling from here: one `docker exec`
  // instead of dozens, and the server log comes back in the same call when it
  // never comes up, which is the difference between "not ready" and knowing
  // why.
  const ready = await docker([
    "exec",
    containerId,
    "sh",
    "-c",
    "for i in $(seq 1 120); do [ -f /tmp/probe/ready ] && exit 0; sleep 0.25; done; " +
      "echo TIMEOUT; cat /tmp/server.log; exit 1",
  ]);
  if (ready.code !== 0) {
    setupFailure = `the probe server never became ready:\n${ready.out}\n${ready.err}`;
  }
}, containerBudget(4));

afterAll(async () => {
  if (containerId !== "") await docker(["rm", "-f", containerId]);
  // One `docker rm -f`, and only when a container was started.
}, opsBudget({ container: 1 }));

/** Fail loudly rather than silently passing when the container never came up. */
function requireSetup(): void {
  if (setupFailure !== null) throw new Error(setupFailure);
}

test.skipIf(!DOCKER)(
  "a different uid cannot reach the control socket at production permissions",
  async () => {
    requireSetup();
    const v = await probeAs(OTHER_UID, "/tmp/probe/tight/s.sock");

    // Refused by the kernel at connect(2): the 0700 directory `serveJsonlSocket`
    // now sets IN CODE cannot be traversed by uid 12345. Which errno the kernel
    // picks (EACCES on the socket, ENOENT when the directory itself cannot be
    // walked) is not asserted — that is a platform spelling, and ISC-199 is the
    // criterion about not pinning those.
    expect(v.uid).toBe(OTHER_UID);
    expect(v.connect).toBe("error");
    expect(v.errno).not.toBeNull();
    expect(v.response).toBeNull();
  },
  containerBudget(1),
);

test.skipIf(!DOCKER)(
  "a different uid is refused at accept even with the filesystem gate removed and a valid token",
  async () => {
    requireSetup();
    const v = await probeAs(OTHER_UID, "/tmp/probe/open/s.sock");

    // THIS is ISC-126. The directory and the socket are both 0777 — the umask
    // 000 state the criterion measured, in which the old code served this
    // request — and the request carries the correct per-run secret, so the auth
    // layer would have passed it. It is refused anyway, by the uid check, at
    // accept, before the verb handler is reached.
    expect(v.uid).toBe(OTHER_UID);
    expect(v.connect).toBe("ok");
    expect(v.response).toMatchObject({
      ok: false,
      authenticated: false,
      code: "peer_uid_denied",
    });
    expect(String(v.response?.["error"])).toContain(String(OTHER_UID));
    expect(v.closedByServer).toBe(true);
    // The verb never ran. `served` is produced only by the handler.
    expect(v.response?.["served"]).toBeUndefined();
  },
  containerBudget(1),
);

test.skipIf(!DOCKER)(
  "the server's own uid is served by that same socket — the refusal is about uid and nothing else",
  async () => {
    requireSetup();
    const v = await probeAs(0, "/tmp/probe/open/s.sock");

    // Same socket, same secret, same container, same instant. Only the uid
    // differs from the probe above. Without this, a probe that refused
    // everything for an unrelated reason would read as a pass.
    expect(v.uid).toBe(0);
    expect(v.connect).toBe("ok");
    expect(v.response).toMatchObject({ ok: true, served: true });
  },
  containerBudget(1),
);
