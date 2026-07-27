/**
 * A2 — the repository, which is authoritative (SRD §8.2).
 *
 * Everything here is derived by spawning `git` with argv arrays — never a
 * shell string. Branch names and file paths in the worktree are
 * worker-controlled content (SRD §12.2), and a shell would evaluate them; an
 * argv array hands them to git as inert bytes.
 *
 * The one check that gates everything else is `merge-base --is-ancestor
 * <base_ref> HEAD` (ISC-151). If the base was rewritten, `diff base...HEAD`
 * still runs and still produces output — a plausible, possibly tiny diff
 * against whatever merge-base remains — and reporting that as the task's work
 * would let a worker shrink its diff to nothing by rebasing. When the check
 * fails, the diff facts are withheld entirely rather than reported empty:
 * "we could not derive" and "the worker changed nothing" must never share a
 * representation.
 */

import type { z } from "zod";
import { DerivedFactsSchema, FileChangeSchema, type DerivedFacts } from "../contracts.ts";

/** contracts.ts exports the schema without a named type; derive it once here. */
export type FileChange = z.infer<typeof FileChangeSchema>;

/**
 * Diff text larger than this is withheld (with a reason), never truncated:
 * ISC-90 promises the reported diff EQUALS `git diff`, and a silently
 * truncated diff is a wrong diff with extra steps. §12.5 requires the
 * per-task harvest byte cap either way.
 */
export const MAX_DIFF_BYTES = 32 * 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn git in `cwd`. Argv array in, decoded streams out — no shell, ever. */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      // Repo content is untrusted (§12.2): a worktree can carry hooks or a
      // config that executes on invocation. Core commands here don't run
      // hooks, but belt-and-braces costs one env var.
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Parse `git diff --name-status -z` output. `-z` because paths are
 * worker-controlled: a newline or a quoted-escape in a filename breaks the
 * line-oriented format, and NUL cannot appear in a path.
 *
 * Layout: `STATUS\0path\0` per entry, except R/C which carry two paths:
 * `R100\0old\0new\0`.
 */
export function parseNameStatusZ(raw: string): FileChange[] {
  const fields = raw.split("\0");
  const out: FileChange[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === undefined || status === "") break;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const to = fields[i + 2];
      if (to === undefined) break; // torn output; stop rather than invent
      // A copy is a new file from the diff's point of view; a rename is the
      // enum's own word.
      out.push({ path: to, change: kind === "R" ? "renamed" : "added" });
      i += 3;
      continue;
    }
    const path = fields[i + 1];
    if (path === undefined) break;
    const change =
      kind === "A" ? "added" : kind === "D" ? "deleted" : ("modified" as const);
    // M, T (typechange) and anything exotic collapse to "modified": the enum
    // is the wire contract and inventing members breaks every consumer.
    out.push({ path, change });
    i += 2;
  }
  return out;
}

/**
 * Parse `git diff --numstat -z`. Numstat's `-z` layout differs from
 * name-status: `added\tremoved\tpath\0`, and for renames the path field is
 * EMPTY with the two paths following as separate NUL fields —
 * `a\tr\t\0old\0new\0`.
 *
 * Binary files report `-\t-`; they carry no line counts, and 0 would be a
 * false claim, so those entries map to undefined counts.
 */
export function parseNumstatZ(raw: string): Map<string, { added?: number; removed?: number }> {
  const fields = raw.split("\0");
  const out = new Map<string, { added?: number; removed?: number }>();
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    if (rec === undefined || rec === "") break;
    const parts = rec.split("\t");
    const [a, r] = [parts[0], parts[1]];
    // Paths are unquoted under -z, so a filename containing a literal tab
    // splits further — rejoin everything after the two counts.
    const inlinePath = parts.length > 2 ? parts.slice(2).join("\t") : undefined;
    if (a === undefined || r === undefined) break;
    const counts = {
      ...(a === "-" ? {} : { added: Number(a) }),
      ...(r === "-" ? {} : { removed: Number(r) }),
    };
    if (inlinePath !== undefined && inlinePath !== "") {
      out.set(inlinePath, counts);
      i += 1;
      continue;
    }
    // Rename form: the record ended at the second tab; old and new paths are
    // the next two NUL fields, and the NEW path is the one the diff names.
    const to = fields[i + 2];
    if (to === undefined) break;
    out.set(to, counts);
    i += 3;
  }
  return out;
}

/** Attach numstat line counts to name-status entries, keyed by path. */
export function mergeLineCounts(
  changes: FileChange[],
  counts: Map<string, { added?: number; removed?: number }>,
): FileChange[] {
  return changes.map((c) => {
    const n = counts.get(c.path);
    if (n === undefined) return c;
    return {
      ...c,
      ...(n.added !== undefined ? { lines_added: n.added } : {}),
      ...(n.removed !== undefined ? { lines_removed: n.removed } : {}),
    };
  });
}

export interface GitFacts {
  /** DerivedFactsSchema-conformant bundle. E3 owns acceptance/harness/tree hashes. */
  facts: DerivedFacts;
  /** Full `git diff <base>...HEAD` text; null when withheld or unavailable. */
  diffText: string | null;
  /** False when the repository could not be interrogated at all. */
  ok: boolean;
  /** Why any fact above is absent — the caller records these verbatim. */
  reasons: string[];
}

/** The all-null bundle for "the repository told us nothing". */
function emptyFacts(): DerivedFacts {
  return DerivedFactsSchema.parse({
    branch: null,
    base_ref: null,
    head_ref: null,
    base_is_ancestor: false,
    harness: {},
  });
}

/**
 * Derive the repository facts for a worker's worktree (SRD §8.2, A2).
 *
 * `acceptance`, `acceptance_context`, `harness` and the tree hashes stay at
 * their schema defaults — they are engineer E3's surface, and populating them
 * here with guesses would let this module quietly take over an adjudication
 * input that has its own ISCs (ISC-148..150, ISC-154).
 */
export async function deriveGitFacts(worktree: string, baseRef: string): Promise<GitFacts> {
  const reasons: string[] = [];

  const head = await runGit(worktree, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    reasons.push(`not a usable git worktree: ${head.stderr.trim()}`);
    return { facts: emptyFacts(), diffText: null, ok: false, reasons };
  }
  const headRef = head.stdout.trim();

  // Symbolic name is presentation; the SHA above is the identity.
  const branchRes = await runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;

  const baseOk = await runGit(worktree, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  if (baseOk.code !== 0) {
    reasons.push(`base_ref ${baseRef} does not name a commit in this repository`);
    return {
      facts: DerivedFactsSchema.parse({
        branch,
        base_ref: null,
        head_ref: headRef,
        base_is_ancestor: false,
        harness: {},
      }),
      diffText: null,
      ok: true,
      reasons,
    };
  }

  // ISC-151. Exit 0 = ancestor, 1 = not, anything else = git itself failed —
  // and "git failed" must not be read as "not an ancestor", because the
  // response to the two differs: unknown facts vs a rewritten base.
  const anc = await runGit(worktree, ["merge-base", "--is-ancestor", baseRef, "HEAD"]);
  if (anc.code !== 0 && anc.code !== 1) {
    reasons.push(`merge-base --is-ancestor failed: ${anc.stderr.trim()}`);
    return { facts: emptyFacts(), diffText: null, ok: false, reasons };
  }
  if (anc.code === 1) {
    // The base was rewritten out from under the branch. Every diff-derived
    // fact below would be measured against the wrong floor, so none of them
    // is produced: a shrunken diff must not be reported as a clean one.
    reasons.push(`base_ref ${baseRef} is not an ancestor of HEAD; diff facts withheld (ISC-151)`);
    return {
      facts: DerivedFactsSchema.parse({
        branch,
        base_ref: baseRef,
        head_ref: headRef,
        base_is_ancestor: false,
        harness: {},
      }),
      diffText: null,
      ok: true,
      reasons,
    };
  }

  const [logRes, nameStatus, numstat, diff] = await Promise.all([
    runGit(worktree, ["log", "--format=%H", `${baseRef}..HEAD`]),
    runGit(worktree, ["diff", "--name-status", "-z", `${baseRef}...HEAD`]),
    runGit(worktree, ["diff", "--numstat", "-z", `${baseRef}...HEAD`]),
    runGit(worktree, ["diff", `${baseRef}...HEAD`]),
  ]);
  for (const [name, r] of [
    ["log", logRes],
    ["diff --name-status", nameStatus],
    ["diff --numstat", numstat],
    ["diff", diff],
  ] as const) {
    if (r.code !== 0) {
      reasons.push(`git ${name} failed: ${r.stderr.trim()}`);
      return { facts: emptyFacts(), diffText: null, ok: false, reasons };
    }
  }

  let commits = logRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (commits.length > 1_000) {
    // MAX_ITEMS on the schema would reject the whole bundle; keeping the most
    // recent 1000 with a recorded reason preserves the facts we CAN report.
    reasons.push(`commit list truncated from ${commits.length} to 1000 (schema MAX_ITEMS)`);
    commits = commits.slice(0, 1_000);
  }

  const filesChanged = mergeLineCounts(
    parseNameStatusZ(nameStatus.stdout),
    parseNumstatZ(numstat.stdout),
  );

  const diffBytes = Buffer.byteLength(diff.stdout, "utf8");
  let diffText: string | null = diff.stdout;
  if (diffBytes > MAX_DIFF_BYTES) {
    reasons.push(`diff is ${diffBytes} bytes; withheld above ${MAX_DIFF_BYTES} (never truncated — ISC-90)`);
    diffText = null;
  }

  return {
    facts: DerivedFactsSchema.parse({
      branch,
      base_ref: baseRef,
      head_ref: headRef,
      base_is_ancestor: true,
      commits,
      files_changed: filesChanged,
      diff_bytes: diffBytes,
      harness: {},
    }),
    diffText,
    ok: true,
    reasons,
  };
}
