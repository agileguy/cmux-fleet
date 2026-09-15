/**
 * The signal handling `scripts/observe/characterise-vm` and `scripts/observe/characterise-docker` share.
 * Commit 079c5a6 made every `run()` child spawn `detached`, so a Ctrl-C's SIGINT no longer reaches them;
 * these functions track and stop them explicitly instead.
 *
 * The process tests spawn a real `sleep`, `sh` or `true`, the way the scripts spawn one. None starts
 * docker, ssh or either script's own `main()`. `characterise-vm-parse.test.ts` established the loading
 * trick this file reuses: copy the extensionless script into a temp `.ts` file and `import()` that copy;
 * `if (import.meta.main) await main();` means importing either script never touches ssh or docker.
 *
 * What the tests pin, once per script:
 *
 *  - `run()` tracks every non-`exempt` child it spawns; `stopTrackedChildren()` SIGTERMs each one's
 *    process group and waits for it to exit. An `exempt` child (standing in for the container create)
 *    is left running. Those are two tests, because one negative result cannot stand in for the other.
 *  - `run()`'s own timeout ends the child's whole process group, not just its pid, so a grandchild that
 *    inherits the stdout/stderr pipe cannot hold a timed-out `run()` open.
 *  - once `markStopping()` has run, `run()` refuses a new ordinary child and still runs an exempt one.
 *  - `handleSignal()` is the function `main()`'s three `process.on(signal, …)` callbacks call; the tests
 *    drive it with a fake `write` and a fake `onFirst`.
 *  - `runCleanup()` is the shape `cleanup()` runs, and it calls `stopTrackedChildren()` directly. The
 *    test spawns a real tracked `sleep`, proves it is dead before `removeContainer` runs, and proves
 *    `removeContainer` never runs before `awaitCreate` settles.
 *  - `stopTrackedChildren()` ends a tracked child's own child too, because it signals the group.
 *  - a tracked child that has exited but is not yet reaped does not make the stop path reject. On macOS,
 *    `kill(-pgid)` answers EPERM for that group, and thrown, it once kept the container from being removed.
 *  - a leg of `runCleanup()` that rejects still gets the container removed, once every tracked child is
 *    gone, and the rejection still reaches the caller.
 *  - the call sites inside `main()`, which none of the tests above can reach, are read as text: the
 *    container create and cleanup's `docker rm` pass `{ exempt: true }`, and the first signal calls
 *    `markStopping()` before `cleanup()`. Without `exempt` on `docker rm`, `run()` refuses it once
 *    stopping, and the container outlives the signal.
 *
 * Every `sleep` duration below is `7331.` (vm) / `7332.` (docker), then this test process's pid, then a
 * three-digit suffix per test, so a leftover can be found with `pgrep -fl 'sleep 733[12]\.'`. The pid keeps
 * two runs of this file at the same time off each other's processes, and every match below is anchored to
 * the whole command line, so one run's marker is never mistaken for a longer one.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..", "..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}
interface SignalState {
  count: number;
}
/** Loosely typed on purpose: the two scripts' `run()` take `opts` in a different position (see `callRun`). */
type RunFn = (argv: string[], timeoutMs?: number, a?: unknown, b?: unknown) => Promise<RunResult>;
interface SignalModule {
  run: RunFn;
  stopTrackedChildren: () => Promise<void>;
  markStopping: () => void;
  handleSignal: (
    state: SignalState,
    write: (text: string) => void,
    containerName: string,
    id: string,
    createBoundS: number,
    createLabel: string,
    onFirst: () => void,
  ) => void;
  runCleanup: (awaitCreate: () => Promise<unknown>, removeContainer: () => Promise<void>) => Promise<void>;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Copies `scripts/observe/<name>` into a fresh temp dir as `<name>.ts` and imports that copy. */
async function loadScript(name: "characterise-vm" | "characterise-docker"): Promise<SignalModule> {
  const source = readFileSync(join(ROOT, "scripts", "observe", name), "utf8");
  const dir = mkdtempSync(join(tmpdir(), `${name}-signal-`));
  dirs.push(dir);
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)) as SignalModule;
}

/** `command` as a `pgrep -f` / `pkill -f` pattern matching that whole command line, and nothing longer. */
function exactly(command: string): string {
  return `^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** True while some process's command line is exactly `command` — real `pgrep`, real processes. */
function processAlive(command: string): boolean {
  return Bun.spawnSync(["pgrep", "-f", exactly(command)]).exitCode === 0;
}

/** Polls `predicate` until it is true or `timeoutMs` elapses; returns the last read. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await Bun.sleep(intervalMs);
  }
}

/**
 * Forcibly ends anything left over from one of this file's own tests. It matches a whole command line that
 * carries this process's pid, so a second run of this file at the same time is never touched.
 */
function killLeftovers(command: string): void {
  Bun.spawnSync(["pkill", "-9", "-f", exactly(command)]);
}

/**
 * The behaviours above, run once per script against its own module copy.
 * `callRun` adapts each script's own `run()` shape (vm: `(argv, timeoutMs, opts)`; docker: `(argv,
 * timeoutMs, stdinPath, opts)`) to one call shape for the tests below — `run()`'s own exported signature
 * is untouched, only this test's adapter differs per script.
 */
function signalSuite(label: string, scriptName: "characterise-vm" | "characterise-docker", markerPrefix: string): void {
  describe(label, () => {
    let mod: SignalModule;

    const ready: Promise<void> = loadScript(scriptName).then((m) => {
      mod = m;
    });

    const callRun = async (argv: string[], timeoutMs: number, exempt = false): Promise<RunResult> => {
      await ready;
      return scriptName === "characterise-vm"
        ? mod.run(argv, timeoutMs, { exempt })
        : mod.run(argv, timeoutMs, undefined, { exempt });
    };
    const stop = async (): Promise<void> => {
      await ready;
      return mod.stopTrackedChildren();
    };

    test("an in-flight non-create child is gone after the stop path runs", async () => {
      const marker = `${markerPrefix}101`;
      const needle = `sleep ${marker}`;
      // A long run() timeout: only stopTrackedChildren() may end this child, never run()'s own timer.
      const runPromise = callRun(["sleep", marker], 60_000);
      try {
        expect(await waitUntil(() => processAlive(needle), 2_000), `${needle} never started`).toBe(true);

        await stop();

        const settled = await Promise.race([
          runPromise.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        expect(settled, "run() never settled after stopTrackedChildren()").toBe(true);
        expect(processAlive(needle), `${needle} is still running after the stop path`).toBe(false);
      } finally {
        killLeftovers(needle);
      }
    }, 15_000);

    test("a child standing in for the create is awaited, not killed", async () => {
      const marker = `${markerPrefix}102`;
      const needle = `sleep ${marker}`;
      const runPromise = callRun(["sleep", marker], 60_000, /* exempt */ true);
      try {
        expect(await waitUntil(() => processAlive(needle), 2_000), `${needle} never started`).toBe(true);

        await stop();

        // stopTrackedChildren() must have left an exempt child alone. Give a signal a moment to have
        // reached it if the exemption were broken, rather than trusting a single instantaneous read.
        await Bun.sleep(300);
        expect(processAlive(needle), `stopTrackedChildren() touched the exempt ${needle}`).toBe(true);

        // Stand in for cleanup()'s own `await starting`: end the create ourselves, the way the real
        // create ends on its own once docker finishes with it, and confirm run() settles.
        Bun.spawnSync(["pkill", "-TERM", "-f", exactly(needle)]);
        const settled = await Promise.race([
          runPromise.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        expect(settled, "the exempt run() never settled once stopped directly").toBe(true);
      } finally {
        killLeftovers(needle);
      }
    }, 15_000);

    test("a grandchild holding a pipe does not keep a timed-out run() waiting", async () => {
      const outerMarker = `${markerPrefix}103`;
      const innerMarker = `${markerPrefix}104`;
      const outerNeedle = `sleep ${outerMarker}`;
      const innerNeedle = `sleep ${innerMarker}`;
      // The tracked/immediate child execs straight into `sleep <outerMarker>` (still the same pid run()
      // spawned). Before that exec, it backgrounds an inner `sh` that forks ITS OWN child — a genuine
      // grandchild — running `sleep <innerMarker>`, and waits on it. Neither redirects stdout/stderr, so
      // both inherit run()'s pipes and hold them open; both share the tracked child's process group,
      // because `detached` makes that child the group leader and nothing here calls setsid again.
      const script = `sh -c "sleep ${innerMarker} & wait" & exec sleep ${outerMarker}`;
      const timeoutMs = 1_000;
      const runPromise = callRun(["sh", "-c", script], timeoutMs);
      try {
        // processAlive() matches whole command lines: the wrapping `sh -c` lines also contain
        // `sleep <innerMarker>`, and a substring match would call the grandchild started before it exists.
        expect(
          await waitUntil(() => processAlive(innerNeedle), 2_000),
          `${innerNeedle} (the grandchild) never started`,
        ).toBe(true);

        // From here, run()'s own 1s timeout is the only thing that can end this.
        const boundStarted = Date.now();
        const settled = await Promise.race([
          runPromise.then((r) => ({ ok: true as const, r })),
          Bun.sleep(6_000).then(() => ({ ok: false as const })),
        ]);
        expect(settled.ok, "run() stayed pending past its timeout — a descendant held the pipe open").toBe(true);
        if (settled.ok) {
          expect(settled.r.timedOut).toBe(true);
          // KILL_GRACE_MS is 2s in both scripts; this bounds SIGTERM-not-enough plus SIGKILL plus real
          // process teardown, well short of the 6s race above.
          expect(Date.now() - boundStarted).toBeLessThan(4_000);
        }

        expect(processAlive(outerNeedle), `${outerNeedle} outlived the timed-out run()`).toBe(false);
        expect(processAlive(innerNeedle), `${innerNeedle} (the grandchild) outlived the timed-out run()`).toBe(false);
      } finally {
        killLeftovers(outerNeedle);
        killLeftovers(innerNeedle);
      }
    }, 15_000);

    test("handleSignal: first signal prints the create's bound and the container, then runs onFirst once", async () => {
      await ready;
      const state: SignalState = { count: 0 };
      const written: string[] = [];
      let onFirstCalls = 0;
      mod.handleSignal(state, (text) => written.push(text), "pifleet-char-x-deadbeef", "deadbeef", 122, "container create", () => {
        onFirstCalls += 1;
      });
      expect(state.count).toBe(1);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("pifleet-char-x-deadbeef");
      expect(written[0]).toContain("122s");
      expect(written[0]).toContain("container create");
      expect(written[0]!.endsWith("\n")).toBe(true);
      expect(onFirstCalls).toBe(1);
    });

    test("handleSignal: a later signal warns about SIGKILL and how to find the container, and never re-runs onFirst", async () => {
      await ready;
      const state: SignalState = { count: 0 };
      const written: string[] = [];
      let onFirstCalls = 0;
      const onFirst = () => {
        onFirstCalls += 1;
      };
      mod.handleSignal(state, (text) => written.push(text), "pifleet-char-x-cafef00d", "cafef00d", 182, "dind container create", onFirst);
      mod.handleSignal(state, (text) => written.push(text), "pifleet-char-x-cafef00d", "cafef00d", 182, "dind container create", onFirst);
      mod.handleSignal(state, (text) => written.push(text), "pifleet-char-x-cafef00d", "cafef00d", 182, "dind container create", onFirst);

      expect(state.count).toBe(3);
      expect(written).toHaveLength(3);
      // The first line is the create/bound message; only it may mention "container create".
      expect(written[0]).toContain("container create");
      // Every later line is the SIGKILL warning, naming the container and the way to find it — and never
      // repeats the first message.
      for (const line of written.slice(1)) {
        expect(line).toContain("SIGKILL");
        expect(line).toContain("pifleet-char-x-cafef00d");
        expect(line).toContain("docker ps -a --filter label=pifleet-char=cafef00d");
        expect(line).not.toContain("container create");
        expect(line.endsWith("\n")).toBe(true);
      }
      // onFirst is the first signal's job alone.
      expect(onFirstCalls).toBe(1);
    });

    test("runCleanup: stops a real tracked child before removing anything, in parallel with awaiting the create", async () => {
      const marker = `${markerPrefix}105`;
      const needle = `sleep ${marker}`;
      // A real, non-exempt, tracked child — not a fake `stopOthers` callback. runCleanup() calls the
      // module's own stopTrackedChildren() directly, so this is the only way to prove that call is really
      // there: if it were missing, this sleep would still be alive when removeContainer runs below.
      const runPromise = callRun(["sleep", marker], 60_000);
      try {
        expect(await waitUntil(() => processAlive(needle), 2_000), `${needle} never started`).toBe(true);

        let resolveCreate!: () => void;
        const createDeferred = new Promise<void>((resolve) => {
          resolveCreate = resolve;
        });
        let createCalls = 0;
        let removeCalls = 0;
        let childAliveWhenRemoved: boolean | undefined;

        const cleanupPromise = mod.runCleanup(
          () => {
            createCalls += 1;
            return createDeferred;
          },
          async () => {
            removeCalls += 1;
            childAliveWhenRemoved = processAlive(needle);
          },
        );

        // The create is deliberately left pending here: the stop step must not wait on it, so the tracked
        // child should already be gone well before resolveCreate() below, and removeContainer must not
        // have run yet either.
        expect(await waitUntil(() => !processAlive(needle), 3_000), `${needle} outlived runCleanup's stop step`).toBe(
          true,
        );
        expect(removeCalls, "removeContainer ran before the create settled").toBe(0);

        resolveCreate();
        await cleanupPromise;

        expect(createCalls).toBe(1);
        expect(removeCalls, "removeContainer never ran").toBe(1);
        expect(childAliveWhenRemoved, "removeContainer ran while the tracked child was still alive").toBe(false);

        const settled = await Promise.race([runPromise.then(() => true), Bun.sleep(3_000).then(() => false)]);
        expect(settled, "the tracked child's own run() promise never settled").toBe(true);
      } finally {
        killLeftovers(needle);
      }
    }, 15_000);

    test("the stop path ends a tracked child's whole process group, not just the child", async () => {
      const innerMarker = `${markerPrefix}107`;
      const innerNeedle = `sleep ${innerMarker}`;
      // The tracked child is a shell waiting on a sleep it forked, in its own process group. A SIGTERM to the
      // shell's pid alone ends the shell and leaves that sleep running; only a signal to the group ends both.
      const runPromise = callRun(["sh", "-c", `sleep ${innerMarker} & wait`], 60_000);
      try {
        expect(await waitUntil(() => processAlive(innerNeedle), 2_000), `${innerNeedle} never started`).toBe(true);

        await stop();

        expect(
          await waitUntil(() => !processAlive(innerNeedle), 3_000),
          `${innerNeedle}, the tracked child's own child, outlived the stop path`,
        ).toBe(true);
        const settled = await Promise.race([runPromise.then(() => true), Bun.sleep(3_000).then(() => false)]);
        expect(settled, "run() never settled after the stop path").toBe(true);
      } finally {
        killLeftovers(innerNeedle);
      }
    }, 15_000);

    test("a tracked child that has exited but is not yet reaped does not stop the container being removed", async () => {
      await ready;
      // Called directly, not through callRun(), so nothing yields between the spawn and the block below.
      const runPromise =
        scriptName === "characterise-vm" ? mod.run(["true"], 60_000, {}) : mod.run(["true"], 60_000, undefined, {});
      // `true` exits at once, and nothing can reap it while this blocks the event loop. On macOS, kill(-pgid)
      // then answers EPERM (measured 2026-09-14, Darwin 25.6.0). On Linux the same call succeeds, so this
      // test only discriminates on macOS.
      Bun.sleepSync(300);
      let removeCalls = 0;
      await mod.runCleanup(
        async () => undefined,
        async () => {
          removeCalls += 1;
        },
      );
      expect(removeCalls, "removeContainer never ran").toBe(1);
      expect((await runPromise).code).toBe(0);
    }, 15_000);

    test("runCleanup: a leg that rejects still gets the container removed, only once every tracked child is gone", async () => {
      const marker = `${markerPrefix}108`;
      const needle = `sleep ${marker}`;
      // A tracked child that ignores SIGTERM, so the stop leg takes KILL_GRACE_MS: long enough that removal
      // starting the moment the create leg rejects would find it still running.
      const runPromise = callRun(["sh", "-c", `trap "" TERM; sleep ${marker}`], 60_000);
      try {
        expect(await waitUntil(() => processAlive(needle), 2_000), `${needle} never started`).toBe(true);

        let removeCalls = 0;
        let childAliveWhenRemoved: boolean | undefined;
        const cleanupPromise = mod.runCleanup(
          () => Promise.reject(new Error("create leg failed")),
          async () => {
            removeCalls += 1;
            childAliveWhenRemoved = processAlive(needle);
          },
        );

        await expect(cleanupPromise).rejects.toThrow("create leg failed");
        expect(removeCalls, "removeContainer did not run because a leg rejected").toBe(1);
        expect(childAliveWhenRemoved, "removeContainer ran while a tracked child was still alive").toBe(false);
        const settled = await Promise.race([runPromise.then(() => true), Bun.sleep(3_000).then(() => false)]);
        expect(settled, "the tracked child's own run() promise never settled").toBe(true);
      } finally {
        killLeftovers(needle);
      }
    }, 15_000);

    test("once markStopping() has run, run() refuses a new ordinary child and still runs an exempt one", async () => {
      // A fresh module copy: `stopping` never resets, so the copy the other tests share must never see it.
      const fresh = await loadScript(scriptName);
      const marker = `${markerPrefix}106`;
      const needle = `sleep ${marker}`;
      const freshRun = (argv: string[], exempt: boolean): Promise<RunResult> =>
        scriptName === "characterise-vm" ? fresh.run(argv, 1_000, { exempt }) : fresh.run(argv, 1_000, undefined, { exempt });
      try {
        fresh.markStopping();
        await expect(freshRun(["sleep", marker], false)).rejects.toThrow("stopped by a signal before running");
        expect(processAlive(needle), `${needle} was started after markStopping()`).toBe(false);
        const exempt = await freshRun(["true"], true);
        expect(exempt.code, "an exempt run() did not run after markStopping()").toBe(0);
        expect(exempt.timedOut).toBe(false);
      } finally {
        killLeftovers(needle);
      }
    }, 15_000);
  });
}

signalSuite("characterise-vm: signal handling", "characterise-vm", `7331.${process.pid}`);
signalSuite("characterise-docker: signal handling", "characterise-docker", `7332.${process.pid}`);

/**
 * The call sites inside each script's `main()`, read as text. `main()` needs docker or ssh, so no test
 * above reaches it, and every one of them stays green with this wiring deleted. Each pattern is matched
 * against `main()`'s own body, from its declaration to the end of the file.
 */
const CALL_SITES = {
  "characterise-vm": {
    create: /"start the container",\s*\{ exempt: true \},/,
    remove: /host\(\["docker", "rm", "-f", "-v", name\], undefined, \{ exempt: true \}\)/,
  },
  "characterise-docker": {
    create: /"start dind",\s*\{ exempt: true \},/,
    remove: /run\(\["docker", "rm", "-f", "-v", dindName\], undefined, undefined, \{ exempt: true \}\)/,
  },
} as const;

for (const [scriptName, sites] of Object.entries(CALL_SITES)) {
  describe(`${scriptName}: main()'s signal wiring`, () => {
    const source = readFileSync(join(ROOT, "scripts", "observe", scriptName), "utf8");
    const mainAt = source.indexOf("async function main(): Promise<void> {");
    const mainBody = source.slice(Math.max(mainAt, 0));

    test("main() is found, so the checks below read its body", () => {
      expect(mainAt, `async function main() is gone from ${scriptName}`).toBeGreaterThan(0);
    });

    test("the container create runs exempt, so the stop step never kills it mid-create", () => {
      expect(mainBody).toMatch(sites.create);
    });

    test("cleanup's docker rm runs exempt, so run() does not refuse it once stopping", () => {
      expect(mainBody).toMatch(sites.remove);
    });

    test("stderr errors are handled before the signal handlers that write to it are installed", () => {
      const guardAt = mainBody.indexOf('process.stderr.on("error"');
      const handlersAt = mainBody.indexOf("process.on(signal");
      expect(guardAt, `${scriptName}'s main() never handles a stderr error, so an EPIPE on the first-signal line exits before cleanup`).toBeGreaterThan(-1);
      expect(handlersAt, `${scriptName}'s main() no longer installs its signal handlers`).toBeGreaterThan(-1);
      expect(guardAt, "the stderr error handler is installed after the signal handlers").toBeLessThan(handlersAt);
    });

    test("the first signal calls markStopping() before cleanup()", () => {
      expect(mainBody).toMatch(
        /process\.on\(signal, \(\) => \{\s*handleSignal\([^;]*?\(\) => \{\s*markStopping\(\);\s*void cleanup\(\)\.then\(\(\) => process\.exit\(code\)\);/,
      );
    });
  });
}
