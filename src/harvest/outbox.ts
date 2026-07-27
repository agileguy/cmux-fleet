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

import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ResultEnvelopeSchema, type ResultEnvelope } from "../contracts.ts";

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

/** One physically-checked entry under `<outbox>/<task>/files/`. */
export interface OutboxFileScan {
  /** Host paths of regular files that passed the lstat/realpath checks. */
  safe: string[];
  /** Entries refused, with the reason — surfaced, never silently dropped. */
  refused: Array<{ path: string; reason: string }>;
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
 * Validate one envelope-named artifact path. Purely lexical — nothing is
 * opened, nothing is stat'd, because refusal must happen BEFORE the path is
 * ever dereferenced (ISC-120). Physical symlink checks belong to
 * `scanOutboxFiles`, which examines what is actually on disk rather than what
 * the envelope claims.
 */
function artifactPathProblem(p: string, loc: OutboxLocation): string | null {
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
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_ENVELOPE_BYTES) {
      return {
        kind: "refused",
        reason: `result.json exceeded ${MAX_ENVELOPE_BYTES} bytes during read (ISC-122)`,
      };
    }
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { kind: "refused", reason: `result.json is not valid JSON: ${String(err)}` };
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
 */
export async function scanOutboxFiles(loc: OutboxLocation): Promise<OutboxFileScan> {
  const taskOutbox = join(loc.workerOutboxDir, loc.taskId);
  const filesRoot = join(taskOutbox, "files");
  const out: OutboxFileScan = { safe: [], refused: [] };

  // The containment root must be canonicalized with the same realpath the
  // link targets go through. macOS mounts tmp under a symlink (/var/folders →
  // /private/var/folders), so an un-canonicalized root made EVERY in-outbox
  // symlink compare as escaping — resolvedWithin("/var/…", "/private/var/…")
  // is a wall of "..". A root that itself cannot be resolved has nothing
  // under it to scan.
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
      if (++seen > MAX_OUTBOX_ENTRIES) {
        out.refused.push({ path: dir, reason: `more than ${MAX_OUTBOX_ENTRIES} entries; scan stopped` });
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
          out.refused.push({ path: p, reason: "symlink cannot be resolved" });
          continue;
        }
        if (!resolvedWithin(root, target)) {
          out.refused.push({ path: p, reason: `symlink escapes the outbox (→ ${target})` });
          continue;
        }
        // In-outbox symlink: harmless as a reference, but only when its
        // target is a regular file — checked via the resolved path, which by
        // construction cannot be a link.
        try {
          const ts = await lstat(target);
          if (ts.isFile()) out.safe.push(p);
          else out.refused.push({ path: p, reason: "symlink target is not a regular file" });
        } catch {
          out.refused.push({ path: p, reason: "symlink target vanished" });
        }
        continue;
      }
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (e.isFile()) {
        out.safe.push(p);
        continue;
      }
      // FIFO, socket, device: opening one can block forever (§12.5's wedged
      // harvester) — refused without being touched.
      out.refused.push({ path: p, reason: "not a regular file" });
    }
  };

  await walk(filesRoot);
  return out;
}
