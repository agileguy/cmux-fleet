/**
 * Test-only preload that SIGKILLs the process at an exact syscall boundary of
 * `writeJsonAtomic` or `appendJsonl` (ISC-143, ISC-156).
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
 * around the `node:fs/promises` calls the protocols are built from. `bun
 * --preload <this file> <entrypoint>` installs the wrapper before the
 * entrypoint's first import, so it covers both the static
 * `import ... from "node:fs/promises"` in the supervisor and the lazy
 * `await import("node:fs/promises")` inside `writeJsonAtomic` — no production
 * code knows this exists, and nothing here can run unless a test puts the
 * file on the command line.
 *
 * The atomic-write boundaries, in protocol order:
 *
 *   open      the temp file exists and is empty; no byte of the new value
 *             has been written
 *   write     the whole body is in the temp file, not yet on the platter
 *   fsync     the body is durable in the temp file; the directory entry
 *             still names the OLD version
 *   rename    the commit point has passed: the target names the new inode
 *   diropen   the directory handle for the final fsync is open
 *   dirfsync  the directory entry itself is durable
 *
 * Everything at or before `fsync` must leave the previous version whole;
 * everything from `rename` on must leave the new one whole. Nothing may leave
 * a half of either.
 *
 * And one boundary off the atomic-write path entirely:
 *
 *   append    one `appendJsonl` record has reached the file
 *
 * ISC-156 names the ledger as well as the state file — "leaves state
 * recoverable AND the ledger readable" — and the ledger does not go through
 * `writeJsonAtomic` at all. Without this boundary the ledger half of the
 * criterion has no test behind it.
 *
 * Configuration is entirely by environment, because the process under test is
 * spawned rather than called:
 *
 *   PIFLEET_TEST_KILL_AT     one of the boundary names above
 *   PIFLEET_TEST_KILL_PATH   the atomic-write TARGET, or the appended file
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
import { fileURLToPath } from "node:url";

/** Ordered names of the syscall boundaries this fixture can kill at. */
export type KillBoundary =
  | "open"
  | "write"
  | "fsync"
  | "rename"
  | "diropen"
  | "dirfsync"
  | "append";

const KILL_AT = process.env["PIFLEET_TEST_KILL_AT"] ?? "";
const KILL_PATH = process.env["PIFLEET_TEST_KILL_PATH"] ?? "";
const TRACE = process.env["PIFLEET_TEST_KILL_TRACE"] ?? "";
/** Nothing is held, armed or tracked unless a test named a boundary AND a path. */
const ENABLED = KILL_AT !== "" && KILL_PATH !== "";

/**
 * How long the armed cycle waits at its own `open` for foreign cycles to drain.
 *
 * Generous, because it is not a race budget: the writes being waited on are
 * already in flight and take microseconds. It exists so a cycle that ends in a
 * way this fixture does not recognise fails LOUDLY instead of parking the
 * process forever and reporting a test timeout with nothing on stdout.
 */
const DRAIN_BUDGET_MS = 5_000;

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
 * One atomic-write cycle, from its `open(tmp, "w")` to its directory fsync.
 *
 * Cycles are tracked INDIVIDUALLY rather than counted, because the step that
 * needs attributing — `open(dir, "r")` — carries no identity at all. Two cycles
 * writing different files into the same directory issue byte-identical calls,
 * and `state.json` and `fence.json` are exactly that: same worker directory
 * (`run/paths.ts`), written concurrently on two independent chains (the
 * supervisor's 250ms heartbeat flush and its fence chain).
 *
 * Matching a directory open on PATH alone therefore lets a FOREIGN cycle
 * satisfy the armed cycle's kill trigger. Measured on this repo's own
 * `dirfsync` case: 12 misattributions in 30 runs, and in every one the armed
 * cycle's own directory entry was never fsync'd — the test would have been
 * reporting on a write it did not perform, which is the precise class of bug
 * the ISC-156 cases exist to catch.
 */
interface Cycle {
  target: string;
  dir: string;
  tmp: string;
  /** Set when this cycle's own `rename` has returned. */
  renamed: boolean;
  /** Set when this cycle's own directory handle has been opened. */
  diropened: boolean;
}

/** Every cycle between its `open(tmp, "w")` and its directory fsync. */
const inflight = new Set<Cycle>();
/** Resumers for cycles parked at `open` for the lifetime of the armed cycle. */
const held: Array<() => void> = [];
/** Resumers waiting for `inflight` to empty so the armed cycle may start. */
const draining: Array<() => void> = [];

let armed: Cycle | null = null;
/**
 * Set the moment the armed cycle's `open` is seen and cleared only when that
 * cycle ends.
 *
 * Between those two points the armed cycle is waiting for foreign cycles to
 * finish, and no NEW foreign cycle may start — otherwise the set it is waiting
 * on can be refilled faster than it drains by a heartbeat that never stops.
 */
let arming = false;

function releaseHeld(): void {
  armed = null;
  arming = false;
  for (const resume of held.splice(0)) resume();
}

/** Wake the armed cycle once no foreign cycle can be mistaken for it. */
function releaseDrained(): void {
  if (inflight.size !== 0) return;
  for (const resume of draining.splice(0)) resume();
}

/** End a cycle, whether it finished its directory fsync or died on an error. */
function endCycle(cycle: Cycle): void {
  inflight.delete(cycle);
  // Reached when the configured boundary was never hit — a misconfigured test,
  // or an ENOSPC on the temp write. Releasing here turns that into an ordinary
  // failing assertion rather than a spawn that hangs forever on the held
  // writes with nothing on stdout.
  if (cycle === armed) releaseHeld();
  releaseDrained();
}

/** Park the armed cycle at its own `open` until every foreign cycle is done. */
async function drain(): Promise<void> {
  if (inflight.size === 0) return;
  let resume = (): void => {};
  const parked = new Promise<void>((r) => {
    resume = r;
  });
  draining.push(resume);
  // Safe from deadlock by construction: the fence write is AWAITED by the
  // supervisor while the heartbeat's state flush is fire-and-forget, so
  // nothing being waited on is itself waiting on the armed cycle.
  const expired = await Promise.race([
    parked.then(() => false),
    new Promise<boolean>((r) => {
      const t = setTimeout(() => r(true), DRAIN_BUDGET_MS);
      t.unref();
    }),
  ]);
  if (expired) {
    arming = false;
    throw new Error(
      `kill-at-boundary: ${inflight.size} atomic write(s) still in flight after ` +
        `${DRAIN_BUDGET_MS}ms; refusing to arm rather than risk attributing the kill ` +
        `to another cycle's directory fsync`,
    );
  }
}

/**
 * The cycle a `open(dir, "r")` belongs to, or `null` if it is not one of ours.
 *
 * While a cycle is armed the answer is forced, not searched: the armed cycle is
 * the ONLY atomic write in flight, because `drain()` waited for the ones that
 * predated it and every later one is held at its `open`. Anything else opening
 * that directory is therefore a cycle this fixture failed to account for, and
 * that is a hard failure — a fixture that guesses here is a fixture that can
 * report a green run for a directory fsync the armed cycle never performed.
 */
function claimDirOpen(dir: string): Cycle | null {
  if (armed !== null && armed.dir === dir) {
    if (!armed.renamed) {
      throw new Error(
        `kill-at-boundary: a directory open on ${dir} arrived before the armed cycle ` +
          `(${armed.target}) had renamed — another cycle is in flight and its fsync ` +
          `would be recorded as the armed cycle's`,
      );
    }
    if (armed.diropened) {
      throw new Error(
        `kill-at-boundary: a SECOND directory open on ${dir} arrived for the armed ` +
          `cycle (${armed.target}) — the first was already claimed, so this one belongs ` +
          `to a foreign cycle and its fsync would be misattributed`,
      );
    }
    armed.diropened = true;
    return armed;
  }
  for (const cycle of inflight) {
    if (cycle.dir === dir && cycle.renamed && !cycle.diropened) {
      cycle.diropened = true;
      return cycle;
    }
  }
  return null;
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
type FsPromises = typeof live;
/**
 * Snapshot the real functions BEFORE mocking.
 *
 * `mock.module` mutates the module namespace in place rather than shadowing
 * it, so a wrapper that calls `live.open` calls ITSELF. The first version of
 * this file did exactly that and died with `Maximum call stack size exceeded`
 * on every boundary — a stack overflow that reads like a bug in the code under
 * test rather than in the harness watching it.
 */
const real: FsPromises = { ...live };

/**
 * A `PathLike` as the string the protocol names it by.
 *
 * `String(path)` is wrong for two of the three members of that union: a `URL`
 * stringifies to `file:///…`, which matches no target, and a `Buffer`
 * stringifies through its own `toString` only by luck of encoding. Nothing in
 * this repo passes either today — which is exactly why the wrong version would
 * have gone unnoticed until something did.
 */
function pathString(path: Parameters<FsPromises["open"]>[0]): string {
  if (typeof path === "string") return path;
  if (path instanceof URL) return fileURLToPath(path);
  return path.toString("utf8");
}

/** `appendFile` takes a path OR an already-open handle; only the path is armable. */
function isFileHandle(file: Parameters<FsPromises["appendFile"]>[0]): file is FileHandle {
  return typeof file === "object" && file !== null && "fd" in file;
}

/**
 * Wrap the handle so its `writeFile`/`sync` land on the trace.
 *
 * A Proxy rather than a three-method stand-in: `writeJsonAtomic` uses three
 * methods today, and a stand-in silently drops whatever it uses tomorrow.
 */
function trackedFile(handle: FileHandle, cycle: Cycle): FileHandle {
  return new Proxy(handle, {
    get(t, prop, receiver): unknown {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "writeFile" && prop !== "sync") return fn.bind(t);
      return async (...args: unknown[]): Promise<unknown> => {
        let out: unknown;
        try {
          out = await fn.apply(t, args);
        } catch (err) {
          // The armed cycle is over and it never reached a boundary. Without
          // this the held writes are never released and every subsequent
          // atomic write in the process parks forever — and in the supervisor
          // the `beforeExit` backstop cannot save it, because a live control
          // socket keeps the event loop from ever draining.
          endCycle(cycle);
          throw err;
        }
        note(prop === "writeFile" ? "write" : "fsync", cycle.target);
        return out;
      };
    },
  });
}

/** Wrap a directory handle so its `sync` ends the cycle it belongs to. */
function trackedDir(handle: FileHandle, cycle: Cycle, notes: boolean): FileHandle {
  return new Proxy(handle, {
    get(t, prop, receiver): unknown {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "sync") return fn.bind(t);
      return async (...args: unknown[]): Promise<unknown> => {
        // The directory fsync is allowed to fail — `writeJsonAtomic` swallows
        // EINVAL on filesystems that do not support it — and the boundary is
        // "the attempt returned", not "the attempt succeeded". Noting only on
        // success would make this boundary silently unreachable on such a
        // filesystem, and an unreachable boundary is an untested one.
        try {
          const out = await fn.apply(t, args);
          if (notes) note("dirfsync", cycle.target);
          return out;
        } catch (err) {
          if (notes) note("dirfsync", cycle.target);
          throw err;
        } finally {
          endCycle(cycle);
        }
      };
    },
  });
}

const patched: FsPromises = {
  ...real,

  async open(...args: Parameters<FsPromises["open"]>): Promise<FileHandle> {
    const [path, flags, mode] = args;
    const p = pathString(path);

    // An atomic write's temp file: `open(tmp, "w")`. The `"w"` test matters —
    // `ensureControlAuth` opens ITS temp with `"wx"` and must stay untouched.
    // Only the string form is recognised; `writeJsonAtomic` uses it, and a
    // numeric-flags caller would be a different protocol needing its own map.
    const target = flags === "w" ? targetOfTemp(p) : null;
    if (target !== null && ENABLED) {
      if (armed === null && !arming && target === KILL_PATH) {
        // Claim the arm slot BEFORE awaiting, so a concurrent cycle cannot
        // claim it too, then wait out the cycles that predate this one.
        arming = true;
        await drain();
        const handle = await real.open(p, "w", mode);
        armed = { target, dir: dirname(target), tmp: p, renamed: false, diropened: false };
        inflight.add(armed);
        note("open", target);
        return trackedFile(handle, armed);
      }
      // Another cycle while the armed one is in flight — or while it is
      // waiting to start. Park it; it resumes only if the armed cycle somehow
      // finishes without a kill. Holding is safe precisely because the armed
      // cycle ends in SIGKILL: the held writes are writes a crashed process
      // never performed.
      if (armed !== null || arming) {
        await new Promise<void>((resume) => held.push(resume));
        return real.open(p, "w", mode);
      }
      // An ordinary cycle with nothing armed. Tracked only so that a later
      // arm can wait for it to finish rather than race its directory fsync.
      inflight.add({ target, dir: dirname(target), tmp: p, renamed: false, diropened: false });
      return real.open(p, "w", mode);
    }

    // The directory fsync handle: `open(dir, "r")`.
    if (flags === "r" && ENABLED) {
      const cycle = claimDirOpen(p);
      if (cycle !== null) {
        let handle: FileHandle;
        try {
          handle = await real.open(p, "r", mode);
        } catch (err) {
          endCycle(cycle);
          throw err;
        }
        const isArmed = cycle === armed;
        if (isArmed) note("diropen", cycle.target);
        return trackedDir(handle, cycle, isArmed);
      }
    }

    return real.open(...args);
  },

  async rename(...args: Parameters<FsPromises["rename"]>): Promise<void> {
    const [from, to] = args;
    await real.rename(from, to);
    const target = pathString(to);
    const tmp = pathString(from);
    for (const cycle of inflight) {
      if (cycle.tmp === tmp) cycle.renamed = true;
    }
    note("rename", target);
  },

  async unlink(...args: Parameters<FsPromises["unlink"]>): Promise<void> {
    const p = pathString(args[0]);
    // `writeJsonAtomic` unlinks the temp on ANY failure between open and
    // rename, so this is the one signal that covers every error exit of the
    // first half of the protocol without guessing which step threw.
    for (const cycle of [...inflight]) {
      if (cycle.tmp === p) endCycle(cycle);
    }
    return real.unlink(...args);
  },

  async appendFile(...args: Parameters<FsPromises["appendFile"]>): Promise<void> {
    await real.appendFile(...args);
    const [file] = args;
    // An already-open `FileHandle` carries no path and cannot be armed;
    // `appendJsonl` passes a path, and a handle append is another protocol.
    if (!isFileHandle(file)) note("append", pathString(file));
  },
};

mock.module("node:fs/promises", () => ({ ...patched, default: patched }));

// Backstop for an armed cycle that ends in a way none of the wrappers saw. Same
// reasoning as `endCycle`: a held write must never be the reason a test reports
// nothing at all.
process.on("beforeExit", () => {
  if (armed !== null || arming || held.length > 0) releaseHeld();
});
