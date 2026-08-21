/**
 * A1 — the result envelope, read as UNTRUSTED input (SRD §7.2, §12.5).
 *
 * The envelope is authored by the actor being graded, and the harvester is the
 * first thing that reads it. Without constraints, `{"kind":"file","path":
 * "/Users/dan/.env"}` is an exfiltration primitive — read by the harvester,
 * written into report.md, and from there into the orchestrator's context. The
 * symlink variant needs no envelope at all: `<outbox>/files/x → /etc/passwd`.
 *
 * So the ORDER of operations here is the contract, not an implementation
 * detail:
 *
 *   1. `lstat` — refuse a symlinked or non-regular result.json (a FIFO wedges
 *      the harvester on open) and refuse an oversized one from the stat,
 *      before a single byte is buffered (ISC-122).
 *   2. Parse and schema-validate before any field is dereferenced (ISC-102).
 *   3. Canonicalize and contain every path the envelope names, before that
 *      path could ever be opened (ISC-120, ISC-121).
 *
 * A MISSING envelope is not a failure (ISC-94): the worker may have died
 * before writing it, and the repository facts stand on their own. A REFUSED
 * envelope is different — something was there and it was wrong — and the two
 * cases are distinct variants so the caller cannot conflate them.
 */

import { constants, type Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_ITEMS, ResultEnvelopeSchema, type ResultEnvelope } from "../contracts.ts";

/**
 * Hard byte cap on result.json, enforced from `lstat` BEFORE the read.
 *
 * The schema's MAX_TEXT/MAX_ITEMS bounds reject an oversized *field*, but only
 * after `JSON.parse` has already materialized the whole document — a 2 GB
 * result.json would be buffered, parsed, and only then refused, which is the
 * OOM the bound exists to prevent. 4 MiB is far above any legitimate envelope
 * (the §7.2 example is under 1 KiB) and far below anything that hurts.
 */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

/** Entries walked under `files/` before the scan refuses to continue. */
export const MAX_OUTBOX_ENTRIES = 10_000;

/**
 * Validated artifacts HELD OPEN at once before the scan refuses to hold more.
 *
 * This bound exists because `safe` holds descriptors (ISC-246, as restated)
 * and `MAX_OUTBOX_ENTRIES` does not bound them anywhere near tightly enough.
 * MEASURED, not assumed: a process holding descriptors one-per-entry reaches
 * `EMFILE: too many open files` after 252 opens under a 256 soft limit — the
 * macOS default in plenty of launch contexts — which is forty times below
 * `MAX_OUTBOX_ENTRIES`. Uncapped, a large outbox would not merely fail its own
 * scan; it would drain the process table out from under everything the
 * harvester still has to do afterwards, including writing the report that says
 * what went wrong.
 *
 * 128 is half of that 256 floor, so the scan leaves headroom for the rest of
 * the process even in the worst common environment, and it is far above any
 * legitimate task outbox. Exceeding it is a NAMED refusal, not an exception:
 * refused entries are surfaced through `harvest/index.ts` like every other
 * refusal, so an operator who genuinely needs more artifacts learns why rather
 * than reading an errno.
 *
 * It is a bound, not a guarantee: Node exposes no portable `getrlimit`, so the
 * scan cannot know the ambient soft limit. Where that limit is below this cap,
 * the per-entry open failure is the backstop and reports the errno by name.
 */
export const MAX_HELD_DESCRIPTORS = 128;

/** Where a task's envelope lives and which mounts its paths may refer to. */
export interface OutboxLocation {
  /** Host dir mounted at `/outbox` for this worker: `<run-dir>/outbox/<worker>`. */
  workerOutboxDir: string;
  taskId: string;
  /** The epoch the inbox record assigned; a result for any other epoch is stale. */
  epoch: number;
  /** Container mount point of the worktree (usually `/workspace`). */
  containerWorkdir: string;
  /** Host worktree path, or null when the task had no repo mount. */
  hostWorkdir: string | null;
}

export type OutboxRead =
  | { kind: "missing" }
  | { kind: "refused"; reason: string }
  | { kind: "ok"; envelope: ResultEnvelope };

/**
 * One validated artifact, HELD OPEN (ISC-246, as restated).
 *
 * The descriptor is the point. A scan that returned a path string would be
 * handing a consumer a NAME, and a name is re-resolved every time it is used:
 * whatever `realpath` and `nlink` proved at scan time would have to be taken
 * on trust at read time, with the worker that authored the directory free to
 * act in between. Holding the descriptor means the inode that passed the
 * checks IS the inode a consumer reads, with no second resolution to race.
 */
export interface OutboxFile {
  /**
   * Host path the entry was found at.
   *
   * For REPORTING — this is the name an operator needs to see. It is
   * deliberately not the way to reach the content: re-opening it is the exact
   * re-resolution `handle` exists to avoid.
   */
  path: string;
  /**
   * Open read descriptor on the inode that passed the checks.
   *
   * THE CALLER OWNS IT AND MUST CLOSE IT — `closeOutboxScan` releases a whole
   * scan in one call. Every accepted entry holds one for the lifetime of the
   * scan result, which is what `MAX_HELD_DESCRIPTORS` bounds.
   */
  handle: FileHandle;
}

/** One physically-checked entry under `<outbox>/<task>/files/`. */
export interface OutboxFileScan {
  /** Regular files that passed the checks, each holding an open descriptor. */
  safe: OutboxFile[];
  /** Entries refused, with the reason — surfaced, never silently dropped. */
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Release every descriptor a scan is holding. Idempotent.
 *
 * `safe` is EMPTIED as it is closed, so a second call is a no-op and a
 * double-close is not reachable through this function. A caller that has
 * finished with a scan should call this in a `finally`; there is no finalizer
 * behind it, and a scan dropped without closing leaks one descriptor per
 * accepted artifact.
 */
export async function closeOutboxScan(scan: OutboxFileScan): Promise<void> {
  const held = scan.safe.splice(0);
  await Promise.all(
    held.map(async (f) => {
      // A close that fails has nothing left to release — the descriptor is
      // gone either way, and throwing here would strand its siblings.
      try {
        await f.handle.close();
      } catch {
        /* already closed, or the fd was invalidated under us */
      }
    }),
  );
}

/**
 * True when `candidate` resolves lexically inside `root`.
 *
 * A prefix string check is NOT sufficient and must never come back:
 * `/outbox/T-1-evil` passes a naive `startsWith("/outbox/T-1")`, so a sibling
 * directory named to share a prefix walks straight through. `path.relative`
 * answers the actual question — is the first traversal step `..`?
 *
 * The first-segment comparison (rather than `rel.startsWith("..")`) matters
 * too: a directory legitimately named `..foo` yields `rel === "..foo"`, which
 * a startsWith check would refuse.
 */
export function resolvedWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/**
 * Translate a container path to a host path — ONLY through the known mount
 * table (SRD §12.5). `/outbox` and the container workdir are the only mounts a
 * worker can write artifacts into; any path that starts elsewhere has no host
 * meaning the harvester is willing to compute, and inventing one (e.g. by
 * treating it as host-absolute) is exactly the exfiltration primitive.
 *
 * Returns null for a path outside the table.
 */
export function containerPathToHost(p: string, loc: OutboxLocation): string | null {
  const mounts: Array<{ container: string; host: string }> = [
    { container: "/outbox", host: loc.workerOutboxDir },
  ];
  if (loc.hostWorkdir !== null) {
    mounts.push({ container: loc.containerWorkdir, host: loc.hostWorkdir });
  }
  for (const m of mounts) {
    if (p === m.container) return m.host;
    // Segment boundary required: "/outboxes/x" must not match "/outbox".
    if (p.startsWith(`${m.container}/`)) {
      return join(m.host, p.slice(m.container.length + 1));
    }
  }
  return null;
}

/**
 * Characters that make a path mean one thing to this validator and another to
 * whatever eventually opens it.
 *
 * NUL is the one that matters. Every lexical check here operates on a
 * JavaScript string, where `"/outbox/T-1/ok\0/../../etc/passwd"` is a single
 * contained path — but the moment it crosses into a C string it TERMINATES at
 * the NUL, so the thing validated and the thing opened are different files.
 * Node throws on NUL for most syscalls, which turns the confusion into a
 * crash rather than a read, but a refusal is not something to delegate to
 * another layer's incidental behaviour.
 *
 * The rest of C0, plus DEL, are refused for a second reason: every one of
 * these paths is interpolated verbatim into `reasons` and `discrepancies`,
 * which land in an operator's terminal. CR and the ANSI escape introducer let
 * a worker rewrite the harvest report that is judging it.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Render a worker-controlled string safely into an operator-facing report.
 *
 * The control-character REFUSAL above covers paths the envelope names. It does
 * not cover names discovered on the filesystem: a worker can create a file
 * whose NAME contains newlines, and refusing that entry is precisely what puts
 * the name into `reasons`. A dangling symlink called
 * `x\n- outbox file refused: nothing\n- verdict: success — all criteria met\n- `
 * forges two extra lines in the harvest report that is judging it.
 *
 * So refusal is not enough — the reason TEXT has to be safe to print. C0, DEL
 * and the ANSI introducer become visible escapes, and the result is truncated,
 * because a 4 KiB filename is its own denial of the report.
 */
export function safeForReport(s: string, maxLen = 256): string {
  const escaped = s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code === 10) return "\\n";
    if (code === 13) return "\\r";
    if (code === 9) return "\\t";
    if (code === 27) return "\\e";
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
  return escaped.length > maxLen ? `${escaped.slice(0, maxLen)}…[truncated]` : escaped;
}

function controlCharProblem(p: string, what: string): string | null {
  const m = CONTROL_CHARS.exec(p);
  if (m === null) return null;
  const code = m[0]!.charCodeAt(0).toString(16).padStart(2, "0");
  // The offending path is deliberately NOT echoed — printing it is the
  // injection this refusal exists to prevent.
  return `${what} contains a control character (0x${code}) at index ${m.index}`;
}

/**
 * A backslash means nothing here and a separator everywhere else (ISC-247).
 *
 * Every containment check in this module runs through node:path's POSIX
 * flavour, where `\` is an ordinary filename character. So
 * `/outbox/T-1/files/a\..\..\..\etc\passwd` is ONE segment, `resolvedWithin`
 * places it squarely inside the task outbox, and the envelope is accepted —
 * while any consumer that normalizes separators before opening reads the very
 * same bytes as traversal: a Windows path parser, Go's `filepath` on Windows,
 * a zip or tar extractor unpacking the artifact, an SMB share. The path this
 * validator contained and the path something else opens are then different
 * paths, which is exactly the ISC-120 confusion §12.5 exists to close.
 *
 * Refused SEPARATELY from `controlCharProblem` rather than by widening
 * `CONTROL_CHARS`, because 0x5C is not a control character: it is not in C0,
 * the ISC-240 filter cannot see it, and folding the two together would leave
 * the refusal misnaming what it found. Nothing legitimate in a Linux
 * container's outbox needs a backslash in a filename.
 */
const BACKSLASH = "\\";

function backslashProblem(p: string, what: string): string | null {
  const i = p.indexOf(BACKSLASH);
  if (i === -1) return null;
  // Index only, matching the refusal above: a path that is lying about its own
  // shape is not something to reproduce into an operator's terminal.
  return `${what} contains a backslash (0x5c) at index ${i}`;
}

/**
 * Validate one envelope-named artifact path. Purely lexical — nothing is
 * opened, nothing is stat'd, because refusal must happen BEFORE the path is
 * ever dereferenced (ISC-120). Physical symlink checks belong to
 * `scanOutboxFiles`, which examines what is actually on disk rather than what
 * the envelope claims.
 */
function artifactPathProblem(p: string, loc: OutboxLocation): string | null {
  const control = controlCharProblem(p, "artifact path");
  if (control !== null) return control;
  const separator = backslashProblem(p, "artifact path");
  if (separator !== null) return separator;
  const host = containerPathToHost(p, loc);
  if (host === null) return `artifact path ${p} is outside the mount table`;
  const taskOutbox = join(loc.workerOutboxDir, loc.taskId);
  const inOutbox = resolvedWithin(taskOutbox, host);
  const inWorktree = loc.hostWorkdir !== null && resolvedWithin(loc.hostWorkdir, host);
  if (!inOutbox && !inWorktree) {
    return `artifact path ${p} escapes the task outbox and worktree`;
  }
  return null;
}

/**
 * Validate one `files_changed[].path`. The schema says repo-relative (§7.2);
 * an absolute path or one that climbs out of the worktree is an envelope that
 * is lying about where it worked, and it is refused whole rather than
 * per-entry — a single hostile path means nothing else in the document is
 * worth trusting.
 */
function changedPathProblem(p: string, loc: OutboxLocation): string | null {
  const control = controlCharProblem(p, "files_changed path");
  if (control !== null) return control;
  const separator = backslashProblem(p, "files_changed path");
  if (separator !== null) return separator;
  if (isAbsolute(p)) return `files_changed path ${p} is absolute; the contract is repo-relative`;
  if (loc.hostWorkdir === null) return null; // nothing to contain against; compared later
  if (!resolvedWithin(loc.hostWorkdir, join(loc.hostWorkdir, p))) {
    return `files_changed path ${p} escapes the worktree`;
  }
  return null;
}

/**
 * Read and validate `<outbox>/<task-id>/result.json`.
 *
 * Every refusal reason is a plain string the caller records; none of them
 * throws, because a hostile envelope is an expected input, not an exceptional
 * one — the harvester's job is to keep harvesting the sources that are still
 * trustworthy.
 */
export async function readResultEnvelope(loc: OutboxLocation): Promise<OutboxRead> {
  const path = join(loc.workerOutboxDir, loc.taskId, "result.json");

  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch {
    return { kind: "missing" };
  }
  // lstat, not stat: the envelope itself can be a symlink out of the outbox,
  // and following it to "check the file" is already the dereference §12.5
  // forbids.
  if (st.isSymbolicLink()) return { kind: "refused", reason: "result.json is a symlink" };
  if (!st.isFile()) return { kind: "refused", reason: "result.json is not a regular file" };
  if (st.size > MAX_ENVELOPE_BYTES) {
    return {
      kind: "refused",
      reason: `result.json is ${st.size} bytes; cap is ${MAX_ENVELOPE_BYTES} (ISC-122)`,
    };
  }

  // Read at most cap+1 bytes through the fd. The stat is advisory — a worker
  // can append between the lstat and the read — so the read itself re-enforces
  // the bound: seeing cap+1 bytes proves the file outgrew the cap, and the
  // buffer never grows past it.
  let text: string;
  // The `open` belongs INSIDE the guard. It used to sit outside it, so a
  // file that lstat'd cleanly but could not be opened — mode 000, or an
  // EACCES/ENFILE race in the window after the lstat — threw straight out of
  // a function whose contract three lines up promises it never throws. The
  // throw propagated through `harvestTask` into `harvestAll`'s unguarded
  // loop and out of `pifleet artifacts`, which exited 2 having emitted no
  // JSON at all: one poisoned task destroyed every healthy task's harvest in
  // the same run, which is precisely the outcome §8.4 exists to forbid.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch (err) {
    return { kind: "refused", reason: `result.json could not be opened: ${String(err)}` };
  }
  try {
    // `allocUnsafe`, not `alloc`: every byte is either overwritten by the read
    // or excluded by `subarray(0, bytesRead)`, so zero-filling 4 MiB on every
    // envelope — most of which are a few hundred bytes — buys nothing.
    const buf = Buffer.allocUnsafe(MAX_ENVELOPE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // Independently untested, deliberately. Disabling BOTH size checks fails
    // the suite, so ISC-122's size limb is pinned; disabling only this one
    // does not, because reaching it requires the file to grow between the
    // lstat and the read, and forcing that ordering needs a hook this module
    // does not have. Written down so the silence is not mistaken for
    // coverage — the same note as the containment check below.
    if (bytesRead > MAX_ENVELOPE_BYTES) {
      return {
        kind: "refused",
        reason: `result.json exceeded ${MAX_ENVELOPE_BYTES} bytes during read (ISC-122)`,
      };
    }
    text = buf.subarray(0, bytesRead).toString("utf8");
  } catch (err) {
    return { kind: "refused", reason: `result.json could not be read: ${String(err)}` };
  } finally {
    await fh.close().catch(() => {});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { kind: "refused", reason: `result.json is not valid JSON: ${String(err)}` };
  }

  /**
   * Array lengths BEFORE the schema, because `.max(MAX_ITEMS)` is not a bound
   * on the work done to reach it.
   *
   * zod type-validates every element first and allocates one issue object per
   * FAILING element, then reports the length violation. So an envelope legal
   * by the byte cap but stuffed with invalid elements — `"blockers":[1,1,1,…]`
   * packs 2,097,101 of them into 4 MiB — costs 2.66 GB of resident memory and
   * 1.2 s before returning a refusal whose `issues[0]` is the only issue
   * anyone reads. The byte cap does not bound this: elements can be 2 bytes.
   *
   * Measured both shapes, because they differ by 20x and the difference is
   * the whole finding: 1,048,550 VALID elements cost 127 MB and 46 ms, while
   * 2,097,101 INVALID ones cost 2.66 GB. An early measurement of the valid
   * shape alone made this look like a non-issue.
   *
   * Counting lengths on the already-parsed value is O(fields) and needs no
   * traversal, so zod never sees the oversized array at all.
   */
  if (typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > MAX_ITEMS) {
        return {
          kind: "refused",
          reason: `result.json field ${key} has ${value.length} entries; cap is ${MAX_ITEMS} (ISC-122)`,
        };
      }
    }
  }

  // Schema BEFORE any field access (ISC-102). The parsed value is only ever
  // dereferenced through the zod output, so an envelope that fails here has
  // had exactly zero of its fields read.
  const parsed = ResultEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "refused", reason: `schema violation: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const env = parsed.data;

  // Identity binding. A result.json for another task is a foreign document; a
  // result.json for another epoch is a STALE one — left behind by a previous
  // attempt of the same task — and letting it through would let a dead
  // attempt's `status` downgrade the live attempt's verdict.
  if (env.task_id !== loc.taskId) {
    return { kind: "refused", reason: `envelope task_id ${env.task_id} != ${loc.taskId}` };
  }
  if (env.epoch !== loc.epoch) {
    return { kind: "refused", reason: `envelope epoch ${env.epoch} is stale (expected ${loc.epoch})` };
  }

  for (const a of env.artifacts) {
    const problem = artifactPathProblem(a.path, loc);
    if (problem !== null) return { kind: "refused", reason: problem };
  }
  for (const f of env.files_changed) {
    const problem = changedPathProblem(f.path, loc);
    if (problem !== null) return { kind: "refused", reason: problem };
  }

  return { kind: "ok", envelope: env };
}

/**
 * Physically check everything under `<outbox>/<task-id>/files/` (ISC-121).
 *
 * `lstat` first, `realpath` second, and never a bare open: following the link
 * to see where it goes IS the read the check exists to prevent. Symlinked
 * directories are refused outright rather than resolved — recursing through
 * one is a walk loop waiting to happen, and nothing legitimate needs a
 * directory symlink inside its own outbox.
 *
 * VALIDATE THEN HOLD (ISC-246, as restated). An accepted entry is OPENED and
 * the descriptor is kept in `safe`; `nlink` and "is this a regular file" are
 * then answered by `fstat` ON THAT DESCRIPTOR rather than by a second `lstat`
 * on the name. The name is resolved exactly once, and the inode that passed
 * the checks is the inode the caller receives — there is no later re-open for
 * the authoring worker to race. `O_NOFOLLOW` makes the open itself a check: an
 * entry that `readdir` reported as a plain file and that has become a symlink
 * by the time it is opened fails with `ELOOP` instead of being followed.
 * `O_NONBLOCK` covers the same swap into a FIFO, which would otherwise wedge
 * the open until a writer appeared (§12.5).
 *
 * THE HONESTY PARAGRAPH — what holding descriptors does NOT buy, stated here
 * because this is where the next reader will look for it. **The directory WALK
 * IS STILL PATH-BASED, and that cannot be fixed in this runtime**: Node
 * exposes no `openat` relative to a `FileHandle`, so `readdir` and the
 * `realpath` containment check below both operate on names, re-resolved from
 * the root on every call. A DIRECTORY swapped mid-walk — `files/sub` replaced
 * between the `readdir` that listed it and the `open` of a leaf inside it — is
 * NOT caught, and no amount of descriptor-holding at the leaves catches it.
 * Containment therefore remains a path-time claim: what is pinned is the
 * IDENTITY of each accepted file, not the identity of the tree it was found
 * in. That is a real and deliberate limit, not an oversight to be closed by a
 * test.
 */
export async function scanOutboxFiles(loc: OutboxLocation): Promise<OutboxFileScan> {
  const taskOutbox = join(loc.workerOutboxDir, loc.taskId);
  const filesRoot = join(taskOutbox, "files");
  const out: OutboxFileScan = { safe: [], refused: [] };

  /**
   * The ONLY way an entry enters `refused`.
   *
   * Both fields carry worker-controlled text — the path is a filename off
   * `readdir`, and several reasons interpolate a symlink target — and refused
   * entries are exactly what `harvest/index.ts` renders into `reasons`. A
   * single choke point is the point: a `refused.push` added later cannot
   * forget to sanitize, because there is nothing else to call.
   */
  const refuse = (path: string, reason: string): void => {
    out.refused.push({ path: safeForReport(path), reason: safeForReport(reason, 512) });
  };

  /** Set once the descriptor budget is spent, to unwind the walk. */
  let budgetSpent = false;

  /**
   * The ONLY way an entry enters `safe`, and the only place a descriptor is
   * opened — the counterpart to `refuse` above, and a choke point for the same
   * reason: an accept path added later cannot forget to validate on the
   * descriptor or to close on refusal, because there is nothing else to call.
   *
   * `reportAs` is the name the entry was found under, which is what the
   * operator needs to see. `target` is the path that passed containment, which
   * is what gets opened — for a plain file they are the same name; for an
   * accepted in-outbox symlink they differ, and opening the RESOLVED path is
   * deliberate: it is the path containment was actually measured against.
   *
   * Every exit that is not the final `push` closes the descriptor first. That
   * is the whole fd-lifetime discipline, and it is confined to this function
   * on purpose.
   */
  const holdIfSafe = async (reportAs: string, target: string): Promise<void> => {
    if (out.safe.length >= MAX_HELD_DESCRIPTORS) {
      refuse(reportAs, `more than ${MAX_HELD_DESCRIPTORS} artifacts to hold open; scan stopped`);
      budgetSpent = true;
      return;
    }

    let handle: FileHandle;
    try {
      // O_NOFOLLOW: refuse rather than follow, if the name became a link
      // between the walk and here. O_NONBLOCK: a FIFO swapped in must not
      // wedge this open waiting for a writer.
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      // Named, never an escaping errno: EMFILE (the ambient soft limit is
      // below MAX_HELD_DESCRIPTORS), ELOOP (it is a symlink now and was not
      // during the walk), EACCES, ENOENT (it vanished) all land here.
      const code = (e as NodeJS.ErrnoException).code ?? "unknown";
      refuse(reportAs, `cannot be opened to hold (${code})`);
      return;
    }

    try {
      // fstat, NOT a second lstat on the name: this answers for the inode the
      // descriptor already holds, so nothing between here and the caller's
      // read can change the thing being described.
      const st = await handle.stat();
      if (!st.isFile()) {
        // A directory or FIFO swapped in behind a plain-file dirent. Opening
        // it succeeded; it is still not a regular file.
        refuse(reportAs, "not a regular file");
        return void (await handle.close());
      }
      // A hard link to a file outside the outbox resolves INSIDE it — the link
      // is the inode's second name and realpath cannot see the first. Link
      // count is the only local evidence, so more than one name means the
      // harvester cannot prove the content originated here. Read from the
      // DESCRIPTOR, so a name raised to a second link after the path checks
      // cannot present itself as single-linked.
      if (st.nlink > 1) {
        refuse(reportAs, `file has ${st.nlink} links; may be a hard link to content outside the outbox`);
        return void (await handle.close());
      }
    } catch {
      refuse(reportAs, "file vanished during the scan");
      try {
        await handle.close();
      } catch {
        /* nothing left to release */
      }
      return;
    }

    out.safe.push({ path: reportAs, handle });
  };

  // The containment root must be canonicalized with the same realpath the
  // link targets go through. macOS mounts tmp under a symlink (/var/folders →
  // /private/var/folders), so an un-canonicalized root made EVERY in-outbox
  // symlink compare as escaping — resolvedWithin("/var/…", "/private/var/…")
  // is a wall of "..". A root that itself cannot be resolved has nothing
  // under it to scan.
  // The ROOTS are checked before anything under them is, because realpath on a
  // symlinked root re-roots containment onto whatever the link points at —
  // after which every "contained" verdict below is measured against the
  // attacker's own directory and every escaping link is approved.
  //
  // `files/` needed the same check for a blunter reason: `walk()` was called
  // on it directly, so it was the one path in the tree that never passed
  // through the per-entry `isSymbolicLink()` branch. A worker that replaced
  // its own `files/` with a link to `~/.ssh` had every key inside returned in
  // `safe` with `refused` empty (SRD §12.5).
  for (const [dir, what] of [
    [taskOutbox, "task outbox"],
    [filesRoot, "files/"],
  ] as const) {
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(dir);
    } catch {
      return out; // absent is not hostile: a task may produce no file artifacts
    }
    if (st.isSymbolicLink()) {
      refuse(dir, `${what} is a symlink; refusing to scan through it`);
      return out;
    }
    if (!st.isDirectory()) {
      refuse(dir, `${what} is not a directory`);
      return out;
    }
  }

  let root: string;
  try {
    root = await realpath(taskOutbox);
  } catch {
    return out;
  }

  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // files/ is optional; a task with no file artifacts has none
    }
    for (const e of entries) {
      // The budget was spent deeper in the tree; unwind rather than refuse
      // once per remaining entry. One refusal names the cause.
      if (budgetSpent) return;
      if (++seen > MAX_OUTBOX_ENTRIES) {
        refuse(dir, `more than ${MAX_OUTBOX_ENTRIES} entries; scan stopped`);
        return;
      }
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Resolve WITHOUT following-and-reading: realpath is metadata
        // traversal. A dangling link is refused too — "cannot resolve" is not
        // "safe".
        let target: string;
        try {
          target = await realpath(p);
        } catch {
          refuse(p, "symlink cannot be resolved");
          continue;
        }
        if (!resolvedWithin(root, target)) {
          refuse(p, `symlink escapes the outbox (→ ${target})`);
          continue;
        }
        // In-outbox symlink: harmless as a reference, but only when its
        // target is a regular file. Opened at the RESOLVED path — the one
        // containment was measured against, and by construction not itself a
        // link — then judged on the descriptor. Reported under the name it was
        // found as, so the operator sees the link and not its target.
        await holdIfSafe(p, target);
        continue;
      }
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (e.isFile()) {
        // Containment is re-checked on the ACCEPT path, not only on the
        // symlink path. `isFile()` answers "is this inode a regular file",
        // never "is it the file it appears to be": a hard link is a second
        // name for an inode anywhere on the filesystem, indistinguishable
        // here from a real artifact, and a bind mount under `files/` is the
        // same trick at directory granularity. Neither is caught by the
        // per-entry symlink branch, and §12.5 asks for every path under the
        // outbox to be canonicalized — not merely the ones that announce
        // themselves as links.
        //
        // NOTE, and mind its SCOPE — an earlier revision of this paragraph
        // did not state one, and was read as covering the `nlink` check too,
        // which it must not. It applies ONLY to the `realpath` containment
        // immediately below.
        //
        // No test pins that realpath check, and that is not an oversight to be
        // fixed by writing one: deleting it leaves `harvest-outbox.test.ts` at
        // 40/40 green (measured, not assumed), because every case a unit test
        // can build is already stopped by the root check or the symlink
        // branch. What it defends against is what those two cannot see — a
        // bind mount, or a filesystem where a plain entry resolves elsewhere —
        // which a unit test cannot create without root. Deliberate defence in
        // depth, recorded so a future reader does not mistake silence for
        // coverage.
        //
        // The `nlink` check further down is the OPPOSITE case in every
        // respect, and the claim is left checkable rather than asserted:
        // `harvest-outbox.test.ts` > "a hard link to a file outside the outbox
        // is refused" builds it with an ordinary unprivileged `link(2)` — no
        // root required — and deleting the check turns that test red with the
        // linked private key sitting in `safe`. Nothing above is licence to
        // remove it.
        let real: string;
        try {
          real = await realpath(p);
        } catch {
          refuse(p, "path cannot be resolved");
          continue;
        }
        if (!resolvedWithin(root, real)) {
          refuse(p, `file escapes the outbox (→ ${real})`);
          continue;
        }
        // Opened at `p` rather than at `real`: for a plain entry the two name
        // the same inode, and `p` is the name O_NOFOLLOW can still refuse if
        // it has become a symlink since the walk listed it. `nlink` is then
        // read from the descriptor — see `holdIfSafe`.
        await holdIfSafe(p, p);
        continue;
      }
      // FIFO, socket, device: opening one can block forever (§12.5's wedged
      // harvester) — refused without being touched.
      refuse(p, "not a regular file");
    }
  };

  // The scan hands its descriptors to the caller, so it must not hand back a
  // PARTIAL set it can no longer name. If the walk dies unexpectedly there is
  // no result to own them and every fd opened so far would leak silently;
  // releasing before the throw is the only point at which they are still
  // reachable.
  try {
    await walk(filesRoot);
  } catch (e) {
    await closeOutboxScan(out);
    throw e;
  }
  return out;
}
