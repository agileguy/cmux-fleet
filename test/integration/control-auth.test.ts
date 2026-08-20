/**
 * Control-socket auth, end to end (SRD §12.7).
 *
 * The adversary is another PROCESS of the same user — one that can reach the
 * socket file. These probes prove that reaching is no longer commanding: a
 * caller without the run's secret is refused on EVERY verb of both servers
 * (the daemon and a real detached supervisor), the refusal is structured
 * rather than a crash or a hang, and the server answers an authorized call
 * immediately after refusing a hostile one.
 *
 * `ping` gets explicit coverage because it is the verb everyone forgets: an
 * unauthenticated ping is an oracle for whether a run exists.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processStartTime,
  readRegistry,
  socketRequest,
  startRegistryDaemon,
} from "../../src/run/registry.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { readWorkerState } from "../../src/run/state.ts";
import {
  generateControlSecret,
  loadControlSecret,
} from "../../src/security/control-auth.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-auth-int-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Unique per process, like every socket-using test here: `socketPath` hashes
 * `(run_id, worker_id)` into the SHARED os.tmpdir(), so a fixed run id makes
 * two concurrent test processes answer each other's RPCs.
 */
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `auth-run-${name}-${RUN_TAG}`;

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("daemon socket auth", () => {
  /** Every verb the daemon serves. A new verb belongs in this list. */
  const DAEMON_VERBS: Array<Record<string, unknown>> = [
    { cmd: "ping" },
    { cmd: "register_worker", entry: { worker: "w-x", pid: 1, pgid: 1, started: "x", registered_at: "x" } },
    { cmd: "deregister_worker", worker: "w-x" },
    { cmd: "get_registry" },
    { cmd: "shutdown" },
  ];

  test("wrong secret is refused on every verb — and the daemon survives all of it", async () => {
    const root = await freshRoot();
    const run = runPaths(testRunId("d1"), root);
    await mkdir(run.root, { recursive: true });
    const daemon = await startRegistryDaemon(run);
    try {
      const secret = await loadControlSecret(run);
      const wrong = generateControlSecret();
      expect(wrong).not.toBe(secret);

      for (const verb of DAEMON_VERBS) {
        const reply = await socketRequest(run.daemonSock, verb, { secret: wrong });
        expect(reply["ok"]).toBe(false);
        expect(reply["code"]).toBe("auth_invalid");
      }

      // The refused register_worker must not have mutated anything.
      expect((await readRegistry(run))?.workers["w-x"]).toBeUndefined();

      // The refused shutdown must not have shut anything down, and a refusal
      // is not a wedge: an authorized call right after succeeds (requirement:
      // failure is a clean refusal, not a crash and not a hang).
      const pong = await socketRequest(run.daemonSock, { cmd: "ping" }, { secret });
      expect(pong["ok"]).toBe(true);
      expect(pong["pid"]).toBe(process.pid);
    } finally {
      await daemon.stop();
    }
  }, cliBudget(1));

  test("a missing token is refused with a message an old client can act on", async () => {
    const root = await freshRoot();
    const run = runPaths(testRunId("d2"), root);
    await mkdir(run.root, { recursive: true });
    const daemon = await startRegistryDaemon(run);
    try {
      // No `secret` option: exactly what a pre-auth client sends.
      const reply = await socketRequest(run.daemonSock, { cmd: "ping" });
      expect(reply["ok"]).toBe(false);
      expect(reply["code"]).toBe("auth_missing");
      expect(String(reply["error"])).toContain("upgraded");
      // And the response never leaks what the right answer would have been.
      expect(JSON.stringify(reply)).not.toContain(await loadControlSecret(run));
    } finally {
      await daemon.stop();
    }
  }, cliBudget(1));

  test("the correct secret is accepted and verbs actually execute", async () => {
    const root = await freshRoot();
    const run = runPaths(testRunId("d3"), root);
    await mkdir(run.root, { recursive: true });
    const daemon = await startRegistryDaemon(run);
    try {
      const secret = await loadControlSecret(run);
      const entry = { worker: "w-1", pid: 1, pgid: 1, started: "s", registered_at: "r" };
      const reg = await socketRequest(run.daemonSock, { cmd: "register_worker", entry }, { secret });
      expect(reg["ok"]).toBe(true);
      expect((await readRegistry(run))?.workers["w-1"]).toBeDefined();
    } finally {
      await daemon.stop();
    }
  }, cliBudget(1));
});

describe("supervisor control-socket auth", () => {
  /**
   * Every verb the supervisor serves. `dispatch` needs no envelope here: the
   * gate must refuse BEFORE any parsing, or a hostile caller could probe the
   * schema with crafted envelopes.
   */
  const SUPERVISOR_VERBS: Array<Record<string, unknown>> = [
    { cmd: "ping" },
    { cmd: "status" },
    { cmd: "dispatch" },
    { cmd: "steer", message: "x" },
    { cmd: "abort" },
    { cmd: "shutdown" },
  ];

  test(
    "a real supervisor refuses a wrong and a missing token on every verb, stays alive, then obeys an authorized shutdown",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("s1");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: run.root,
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: {
          PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}`,
        },
        logPath: wp.supervisorLog,
      });
      cleanups.push(async () => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already gone — the expected end state.
        }
      });

      expect(await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000)).toBe(true);

      const secret = await loadControlSecret(run);
      const wrong = generateControlSecret();

      // Wrong token: refused on every verb, including the shutdown that would
      // otherwise be a same-uid kill switch, and including ping — the
      // existence oracle.
      for (const verb of SUPERVISOR_VERBS) {
        const reply = await socketRequest(wp.controlSock, verb, { secret: wrong });
        expect(reply["ok"]).toBe(false);
        expect(reply["code"]).toBe("auth_invalid");
      }
      // Missing token: same gate, distinct code.
      const bare = await socketRequest(wp.controlSock, { cmd: "ping" });
      expect(bare["code"]).toBe("auth_missing");

      // The refused shutdown did not take: the supervisor still answers an
      // authorized ping, through the same client the CLI uses.
      expect(await processStartTime(pid)).not.toBeNull();
      const pong = await controlCall(run, "eng-1", { cmd: "ping" });
      expect(pong["ok"]).toBe(true);
      expect(pong["worker"]).toBe("eng-1");

      // And the authorized shutdown works — auth refuses strangers, not owners.
      const bye = await controlCall(run, "eng-1", { cmd: "shutdown" });
      expect(bye["ok"]).toBe(true);
      expect(await waitFor(async () => (await processStartTime(pid)) === null, 10_000)).toBe(true);
    },
    cliBudget(3),
  );
});
