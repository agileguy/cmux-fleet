/**
 * ISC-292 against a daemon whose filesystem is NOT the client's — the first
 * reproducible reader the criterion has ever had.
 *
 * ## Why this file exists when `doctor-preflight.test.ts` already covers ISC-292
 *
 * That suite asserts an AGREEMENT: whatever the ambient runtime does with a
 * path, `doctor`'s verdict matches an independent measurement of it. That is
 * the right shape for a test that must pass on every runtime, and it has one
 * consequence it states honestly — on a native Linux daemon every path is
 * shared, so the interesting half never runs. The hazard is asserted about
 * whatever the machine happens to be, and on CI the machine is never the one
 * where the hazard exists.
 *
 * The reason it was left there was a belief that the hazard is a macOS-VM
 * property, and that a test cannot ask a native daemon to forget a path it can
 * plainly see. THE BELIEF IS WRONG, and this file is what wrongness bought:
 * the hazard is not about macOS, it is about a daemon whose root filesystem
 * differs from that of the client talking to it. macOS produces that with a
 * VM. Docker-in-Docker produces it ON ANY HOST, on demand, in a container.
 *
 * `PROBE_DIND_IMAGE` started `--privileged` with its 2375 published is a
 * SECOND daemon — confirmed distinct rather than assumed: `docker info`
 * through it reports `Alpine Linux v3.24 (containerized) / 29.7.2` where the
 * ambient daemon reports `Ubuntu 24.04.2 / 28.4.0`. It has its own root, its
 * own image store, and no knowledge whatsoever of `/Users/...`. Point a client
 * at it and the ISC-292 condition is not simulated, it is present.
 *
 * ## The three assertions and why none of them is redundant
 *
 * 1. THE GUARD REFUSES. A host path this checkout really has, mounted through
 *    the remote daemon, is thrown on by `assertBindMountsVisible` with
 *    `exitCode` 3. This is the direction the criterion is about and the
 *    direction no existing test can reach.
 *
 * 2. THE GUARD PASSES SOMETHING. Test 1 on its own is satisfied by a probe
 *    that refuses everything — including one broken so badly it never starts a
 *    container, since `probeBindMountSources` correctly treats an unusable
 *    probe as a refusal. So a path the remote daemon GENUINELY HAS must not be
 *    refused. It is arranged by bind-mounting a host directory into the dind
 *    container AT ITS OWN PATH, so the inner daemon resolves the very string
 *    the client sends and finds real content behind it. Note what this rules
 *    out: a named volume would not work as a positive control, because
 *    `bindMountSources` does not report one as a host path and the guard would
 *    pass VACUOUSLY — a pass that measured nothing, which is the exact failure
 *    mode this criterion exists to close.
 *
 * 3. THE PREMISE ITSELF. Raw `docker run -v <host-only>:/probe:ro` against the
 *    remote daemon EXITS 0 AND SHOWS AN EMPTY DIRECTORY. This one pins the
 *    HAZARD rather than the guard, and it is the load-bearing one for the
 *    long term. Every line of `mount-preflight.ts` is justified by Docker
 *    silently inventing a directory instead of erroring. If Docker ever
 *    changes that — if a missing bind source becomes a startup failure — then
 *    the guard is still correct but no longer NECESSARY, and the project
 *    should be told rather than left maintaining a probe container per launch
 *    for a condition the runtime now handles. Tests 1 and 2 would both stay
 *    green through that change; only this one goes red, and its going red is
 *    the message. Read a failure here as "the justification changed", not as
 *    "the guard broke".
 *
 * ## What it costs and why it is gated separately
 *
 * `PIFLEET_DIND` rather than `PIFLEET_DOCKER`, because this is materially more
 * expensive than the other Docker-gated suites and materially more demanding
 * of the host: it needs `--privileged`, it pulls two images, and the second
 * pull happens INSIDE the inner daemon, whose image store starts empty. A
 * developer running `PIFLEET_DOCKER=1` for a quick check should not silently
 * acquire that. The skip is announced, exactly as the other gated suites
 * announce theirs, so a machine that never runs this never merely appears to.
 *
 * WHAT IT ASSUMES: that the ambient `docker` CLI can run a privileged
 * container and publish a port to loopback. On colima and on a GitHub runner
 * it can. Where it cannot, the gate is the answer — leave it unset.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MountNotVisibleError, assertBindMountsVisible } from "../../src/container/mount-preflight.ts";
import { realExec, type Exec } from "../../src/container/run.ts";
import { containerBudget } from "../support/budget.ts";
import { PROBE_BUN_IMAGE, PROBE_DIND_IMAGE } from "../support/probe-image.ts";

const DIND = process.env["PIFLEET_DIND"] === "1";

if (!DIND) {
  console.warn(
    "[skip] test/integration/mount-preflight-remote.test.ts needs a container daemon it can " +
      "run --privileged docker-in-docker on. Run with PIFLEET_DIND=1.",
  );
}

/**
 * Unique per PROCESS, not per file.
 *
 * bun runs test files in one process here, but two `bun test` invocations on
 * one machine — a developer's and a watcher's, or two CI shards — would
 * otherwise collide on the name and the second `docker run` would fail with a
 * conflict that reads like a product bug. The pid makes the collision
 * impossible instead of unlikely.
 */
const DIND_NAME = `pifleet-isc292-dind-${process.pid}`;

/** A host directory this checkout really has, with regular files in it. */
const HOST_ONLY_DIR = join(new URL("../../", import.meta.url).pathname, "docker");

/**
 * How long the inner daemon gets to start answering.
 *
 * It is not ready when `docker run -d` returns: dockerd inside the container
 * still has to come up, and measured locally that takes a few seconds. Polling
 * `docker info` is the only honest readiness signal — a fixed sleep either
 * wastes time or races, and the race would surface as a connection error
 * attributed to the mount code rather than to startup.
 */
const DAEMON_READY_MS = 60_000;
const DAEMON_POLL_MS = 500;

/** Raw `docker`, on whichever daemon `env` points at. */
function docker(args: string[], env?: Record<string, string>) {
  return realExec(["docker", ...args], { timeoutMs: 300_000, ...(env ? { env } : {}) });
}

/** Where the tests will find the inner daemon once `beforeAll` has published it. */
let dockerHost = "";
/** A host path that the inner daemon ALSO has, at the identical string. */
let sharedDir = "";

/**
 * The seam that carries `DOCKER_HOST` to the probe's child process.
 *
 * `realExec` does support a per-call `env`, merged over `process.env` — but
 * `probeBindMountSources` calls `exec(argv, { timeoutMs })` and forwards no
 * env, so an `ExecOptions` field is not reachable from here. The `exec`
 * parameter `assertBindMountsVisible` already takes for testability is, and
 * wrapping it is strictly better than the alternative: mutating
 * `process.env.DOCKER_HOST` around the call would leak into any concurrently
 * running test in this process and would have to be restored correctly on the
 * throwing path, which is most of this file.
 */
function remoteExec(): Exec {
  return (argv, opts = {}) =>
    realExec(argv, { ...opts, env: { ...opts.env, DOCKER_HOST: dockerHost } });
}

/**
 * Per-TEST gating, not `describe.skipIf`, and the difference is not cosmetic.
 *
 * `describe.skipIf` reports the block's `beforeAll` and `afterAll` as skipped
 * tests too — measured, this file read 5 skips for 3 tests. The `container`
 * job DERIVES its `TOTAL_EXPECTED` by running its file list with every gate
 * closed and counting what bun reports, then checks the gated run against it,
 * so a file whose count changes with the gate makes that accounting disagree
 * with itself. `doctor-preflight.test.ts` already reaches for this idiom; it is
 * the one that keeps the two runs comparable.
 */
const it = test.skipIf(!DIND);

describe("ISC-292 against a remote daemon (docker-in-docker)", () => {
  beforeAll(async () => {
    // The hooks are NOT gated by the `describe`, so they run even when every
    // test in the block is skipped. Returning early is what keeps a gate-closed
    // run from starting a daemon nothing is going to ask anything of.
    if (!DIND) return;
    /**
     * Created BEFORE the daemon container, because it is bind-mounted into it.
     * Under `homedir()` rather than `os.tmpdir()` on purpose: on the macOS
     * runtime this was written against, `$HOME` is the only host share, and a
     * positive control that the OUTER daemon could not see either would fail
     * for a reason that has nothing to do with what it is asserting.
     */
    sharedDir = await mkdtemp(join(homedir(), "pifleet-isc292-shared-"));
    // A SHELL_SAFE name so `borrowWitness` adopts it and the guard never has
    // to write a sentinel of its own into a directory under test.
    await writeFile(join(sharedDir, "witness.txt"), "visible-to-the-inner-daemon\n");

    const started = await docker([
      "run", "-d",
      "--privileged",
      "--name", DIND_NAME,
      // Ephemeral loopback port. A fixed one would be a second thing that can
      // collide between concurrent runs, after the container name.
      "-p", "127.0.0.1:0:2375",
      // Empty means "serve plain TCP on 2375". With the default, dind
      // generates certs and refuses unauthenticated clients on 2376, and the
      // failure looks like the daemon never started.
      "-e", "DOCKER_TLS_CERTDIR=",
      // The positive control, mounted at its own path so the string the client
      // sends resolves inside the inner daemon.
      "-v", `${sharedDir}:${sharedDir}`,
      PROBE_DIND_IMAGE,
    ]);
    if (started.code !== 0) {
      throw new Error(`could not start the dind daemon: ${started.stderr.trim()}`);
    }

    const port = await docker(["port", DIND_NAME, "2375"]);
    const mapped = port.stdout.trim().split("\n")[0]?.trim();
    if (!mapped) throw new Error(`no published port for ${DIND_NAME}: ${port.stderr.trim()}`);
    dockerHost = `tcp://${mapped}`;

    const env = { DOCKER_HOST: dockerHost };
    const deadline = Date.now() + DAEMON_READY_MS;
    let last = "";
    for (;;) {
      const info = await docker(["info", "--format", "{{.ServerVersion}}"], env);
      if (info.code === 0) break;
      last = info.stderr.trim();
      if (Date.now() > deadline) {
        throw new Error(`the dind daemon never answered within ${DAEMON_READY_MS}ms: ${last}`);
      }
      await Bun.sleep(DAEMON_POLL_MS);
    }

    /**
     * REQUIRED, not an optimisation. The inner daemon's image store is empty
     * and `--network none` on the probe means it cannot pull one for itself.
     * Without this every probe fails on a missing image, `probeBindMountSources`
     * correctly reports the refusal, and test 1 passes for entirely the wrong
     * reason — which is the failure test 2 exists to catch.
     */
    const pulled = await docker(["pull", PROBE_BUN_IMAGE], env);
    if (pulled.code !== 0) {
      throw new Error(`could not pull ${PROBE_BUN_IMAGE} into the dind daemon: ${pulled.stderr.trim()}`);
    }
  }, containerBudget(40));

  afterAll(async () => {
    if (!DIND) return;
    // `-v` as well as `-f`: the dind image declares `VOLUME /var/lib/docker`,
    // so a bare `rm -f` leaves an anonymous volume holding the inner daemon's
    // whole image store behind on every run.
    await docker(["rm", "-f", "-v", DIND_NAME]).catch(() => {});
    if (sharedDir) await rm(sharedDir, { recursive: true, force: true }).catch(() => {});
  }, containerBudget(2));

  it("refuses a host path the remote daemon cannot see", async () => {
    const argv = ["docker", "run", "--rm", "-v", `${HOST_ONLY_DIR}:/workspace:ro`, PROBE_BUN_IMAGE, "true"];

    let caught: unknown;
    try {
      await assertBindMountsVisible([argv], PROBE_BUN_IMAGE, remoteExec());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MountNotVisibleError);
    const err = caught as MountNotVisibleError;
    /**
     * The LITERAL 3, not `EXIT.BACKEND_UNAVAILABLE`. The exit code is the only
     * channel a machine caller has, so it is a published contract and this is
     * the test that pins it; importing the same constant the production code
     * uses would compare it with itself and stay green through a renumbering
     * that broke every script reading it.
     */
    expect(err.exitCode).toBe(3);
    // Naming the offending path is most of the diagnosis's value — a refusal
    // that does not say WHICH mount is a refusal the operator cannot act on.
    expect(err.message).toContain(HOST_ONLY_DIR);
  }, containerBudget(2));

  it("does not refuse a path the remote daemon really has", async () => {
    const argv = ["docker", "run", "--rm", "-v", `${sharedDir}:/workspace:ro`, PROBE_BUN_IMAGE, "true"];

    // No `expect().resolves` shorthand: on a failure this way puts the guard's
    // own diagnosis — which names the path and what the container saw — into
    // the test output, instead of an assertion message about a rejected
    // promise. The whole point of the control is diagnosing why it broke.
    await assertBindMountsVisible([argv], PROBE_BUN_IMAGE, remoteExec());
  }, containerBudget(2));

  it("the hazard itself: a missing bind source mounts EMPTY and exits 0", async () => {
    const r = await remoteExec()(
      [
        "docker", "run", "--rm",
        "-v", `${HOST_ONLY_DIR}:/probe:ro`,
        "--entrypoint", "/bin/sh",
        PROBE_BUN_IMAGE,
        "-c", "ls -A /probe | wc -l",
      ],
      { timeoutMs: 120_000 },
    );

    // Exits 0. This is the silence the guard exists to break: no error, no
    // warning, nothing in a log — a worker would simply find nothing.
    expect(r.code).toBe(0);
    // And the directory it invented is empty, while the host's has files.
    expect(r.stdout.trim()).toBe("0");
  }, containerBudget(2));
});
