/**
 * Test-only preload that SIGKILLs the process at an exact syscall boundary of
 * `writeJsonAtomic` (ISC-143, ISC-156).
 *
 * Crash-consistency claims are only worth what their kill is worth. The test
 * this replaced spawned a writer, slept 150ms, and sent SIGKILL — which kills
 * "sometime during a write cycle", proves whichever boundary the scheduler
 * happened to pick that run, and reports the same PASS whether it landed
 * before the first byte or after the directory fsync. A protocol with five
 * ordered steps needs five ordered proofs, and a sleep cannot name which one
 * it produced.
 *
 * So the kill is issued by the dying process itself, from inside a wrapper
 * around the two `node:fs/promises` calls the protocol is built from. `bun
 * --preload <this file> <entrypoint>` installs the wrapper before the
 * entrypoint's first import, so it covers both the static
 * `import ... from "node:fs/promises"` in the supervisor and the lazy
 * `await import("node:fs/promises")` inside `writeJsonAtomic` — no production
 * code knows this exists, and nothing here can run unless a test puts the
 * file on the command line.
 *
 * The boundaries, in protocol order:
 *
 *   open      the temp file exists and is empty; no byte of the new value
 *             has been written
 *   write     the whole body is in the temp file, not yet on the platter
 *   fsync     the body is durable in the temp file; the directory entry
 *             still names the OLD version
 *   rename    the commit point has passed: the target names the new inode
 *   dirfsync  the directory entry itself is durable
 *
 * Everything at or before `fsync` must leave the previous version whole;
 * everything from `rename` on must leave the new one whole. Nothing may leave
 * a half of either.
 *
 * Configuration is entirely by environment, because the process under test is
 * spawned rather than called:
 *
 *   PIFLEET_TEST_KILL_AT     one of the five boundary names above
 *   PIFLEET_TEST_KILL_PATH   the atomic-write TARGET to arm (not the temp)
 *   PIFLEET_TEST_KILL_TRACE  file to append `<boundary>\t<target>` lines to
 *
 * The trace is what makes a passing test mean something: it is written
 * synchronously, one line per completed step, so after the kill the last line
 * IS the boundary the process died at. A test that asserts only on the
 * surviving file cannot tell `write` from `fsync` — both leave the previous
 * version and a full temp file — and would report a green run for a kill that
 * landed somewhere else entirely.
 */

import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/** Ordered names of the syscall boundaries this fixture can kill at. */
export type KillBoundary = "open" | "write" | "fsync" | "rename" | "diropen" | "dirfsync";

const KILL_AT = process.env["PIFLEET_TEST_KILL_AT"] ?? "";
const KILL_PATH = process.env["PIFLEET_TEST_KILL_PATH"] ?? "";
const TRACE = process.env["PIFLEET_TEST_KILL_TRACE"] ?? "";

/**
 * The temp-name marker `writeJsonAtomic` builds its temp path from.
 *
 * Matching on it is how a wrapper that only sees `open(tmp, "w")` recovers the
 * TARGET the cycle will commit to — which is the only name a caller can arm,
 * since the temp carries a per-call UUID nobody can predict.
 */
const TMP_MARK = ".tmp-";

/** The target an atomic-write temp path belongs to, or `null` if it is not one. */
function targetOfTemp(path: string): string | null {
  const i = path.lastIndexOf(TMP_MARK);
  return i === -1 ? null : path.slice(0, i);
}

/**
 * The armed write cycle, from its `open` to its directory fsync.
 *
 * At most one exists at a time, and while it exists every OTHER atomic write
 * is held at `open` (see `hold`). Two cycles running against the same
 * directory are indistinguishable from outside: both call `open(dir, "r")`
 * with identical arguments, so a `dirfsync` kill could land on the wrong
 * one's directory fsync — a race, and this fixture exists to remove races,
 * not to relocate them. Holding is safe precisely because the armed cycle
 * ends in SIGKILL: the held writes are writes a crashed process never
 * performed.
 */
interface ArmedCycle {
  target: string;
  dir: string;
  renamed: boolean;
}
let armed: ArmedCycle | null = null;
const held: Array<() => void> = [];

function releaseHeld(): void {
  armed = null;
  for (const resume of held.splice(0)) resume();
}

/**
 * Record a completed boundary, then kill if it is the armed one.
 *
 * `appendFileSync` deliberately: the trace must be on disk before the signal,
 * and SIGKILL cannot be caught to flush anything afterwards. A self-directed
 * SIGKILL is delivered before `process.kill` returns, so the next step of the
 * protocol never starts — which is the whole point.
 */
function note(boundary: KillBoundary, target: string): void {
  if (TRACE !== "") appendFileSync(TRACE, `${boundary}\t${target}\n`);
  if (boundary === KILL_AT && target === KILL_PATH) process.kill(process.pid, "SIGKILL");
}

const live = await import("node:fs/promises");
/**
 * Snapshot the real functions BEFORE mocking.
 *
 * `mock.module` mutates the module namespace in place rather than shadowing
 * it, so a wrapper that calls `live.open` calls ITSELF. The first version of
 * this file did exactly that and died with `Maximum call stack size exceeded`
 * on every boundary — a stack overflow that reads like a bug in the code under
 * test rather than in the harness watching it.
 */
const real = { ...live };

/**
 * Wrap the handle so its `writeFile`/`sync` land on the trace.
 *
 * A Proxy rather than a three-method stand-in: `writeJsonAtomic` uses three
 * methods today, and a stand-in silently drops whatever it uses tomorrow.
 */
function tracked(handle: FileHandle, target: string, kind: "file" | "dir"): FileHandle {
  return new Proxy(handle, {
    get(t, prop, receiver): unknown {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "writeFile" && prop !== "sync") return fn.bind(t);
      return async (...args: unknown[]): Promise<unknown> => {
        if (prop === "writeFile") {
          const out = await fn.apply(t, args);
          note("write", target);
          return out;
        }
        if (kind === "file") {
          const out = await fn.apply(t, args);
          note("fsync", target);
          return out;
        }
        // The directory fsync is allowed to fail — `writeJsonAtomic` swallows
        // EINVAL on filesystems that do not support it — and the boundary is
        // "the attempt returned", not "the attempt succeeded". Noting only on
        // success would make this boundary silently unreachable on such a
        // filesystem, and an unreachable boundary is an untested one.
        try {
          const out = await fn.apply(t, args);
          note("dirfsync", target);
          return out;
        } catch (err) {
          note("dirfsync", target);
          throw err;
        } finally {
          // The armed cycle is over. Reached only when the configured boundary
          // was never hit — a misconfigured test — and releasing here turns
          // that into an ordinary failing assertion rather than a spawn that
          // hangs forever on the held writes with nothing on stdout.
          releaseHeld();
        }
      };
    },
  });
}

const patched = {
  ...real,

  async open(path: unknown, flags?: unknown, mode?: unknown): Promise<FileHandle> {
    const p = String(path);

    // An atomic write's temp file: `open(tmp, "w")`. The `"w"` test matters —
    // `ensureControlAuth` opens ITS temp with `"wx"` and must stay untouched.
    if (flags === "w") {
      const target = targetOfTemp(p);
      if (target !== null) {
        if (armed === null && target === KILL_PATH) {
          const handle = await real.open(p, "w", mode as number | undefined);
          armed = { target, dir: dirname(target), renamed: false };
          note("open", target);
          return tracked(handle, target, "file");
        }
        // Some other file's cycle while the armed one is in flight. Park it;
        // it resumes only if the armed cycle somehow finishes without a kill.
        if (armed !== null) await new Promise<void>((resume) => held.push(resume));
      }
      return real.open(p, "w", mode as number | undefined);
    }

    // The directory fsync handle: `open(dir, "r")`, which only the armed
    // cycle can be issuing, because every competing cycle is held above.
    if (flags === "r" && armed !== null && armed.renamed && p === armed.dir) {
      const handle = await real.open(p, "r", mode as number | undefined);
      note("diropen", armed.target);
      return tracked(handle, armed.target, "dir");
    }

    return real.open(p, flags as string | undefined, mode as number | undefined);
  },

  async rename(from: unknown, to: unknown): Promise<void> {
    await real.rename(String(from), String(to));
    const target = String(to);
    if (armed !== null && armed.target === target) armed.renamed = true;
    note("rename", target);
  },
};

mock.module("node:fs/promises", () => ({ ...patched, default: patched }));

// Backstop for an armed cycle that ends in an ERROR rather than at a boundary
// — an ENOSPC on the temp write, say. Same reasoning as the `finally` above:
// a held write must never be the reason a test reports nothing at all.
process.on("beforeExit", () => {
  if (armed !== null) releaseHeld();
});
