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
import { DerivedFactsSchema, FileChangeSchema, MAX_ITEMS, type DerivedFacts } from "../contracts.ts";

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

/**
 * Flags that stop a worker-controlled repository from choosing what git runs.
 *
 * `git diff` is not the inert reader it looks like. A `.gitattributes` in the
 * tree can assign a diff driver per path, and `[diff "name"] command = …` in
 * the repo's own config then names a program git EXECUTES — on the host, as
 * the harvester, outside the container the worker is confined to. Textconv
 * and `core.fsmonitor` are the same primitive by other names, and each needs
 * its own control — see `EXT_DIFF_COMMANDS` below for why disabling one of
 * them is what ACTIVATES another. They are disabled here rather than in the
 * caller, because the caller that forgets is the one that runs `diff`.
 *
 * `-c` beats the environment: `GIT_CONFIG_*=/dev/null` neutralizes the global
 * and system files, but the REPOSITORY config (`.git/config`) is not
 * suppressible by env at all, and it is inside the mount the worker writes to.
 */
export const GIT_HARDENING: readonly string[] = [
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.external=",
  // `ext::` URLs name a command in the URL itself — the same "a repository
  // decides what runs" primitive as a diff driver, reached through a different
  // door. Nothing here clones a remote today, so this blocks nothing that
  // works; it is here so that the day someone adds `--recurse-submodules`, a
  // `.gitmodules` with an `ext::` URL is already inert.
  "-c",
  "protocol.ext.allow=never",
];

/**
 * The environment for EVERY git spawn in the harvest subsystem — built from a
 * literal, never from `process.env`.
 *
 * The harvester runs git inside the tree a graded worker just wrote to, on the
 * host, OUTSIDE the container that worker is confined to. Inheriting this
 * process's environment would hand that subprocess
 * `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_*`, `KUBECONFIG` and any shell
 * tokens — turning a contained code-execution primitive into credential
 * exfiltration. This module spread `process.env` once already; the docstring
 * saying so is not a control, which is why `test/unit/harvest-git.test.ts`
 * asserts the spawned env EQUALS this key set exactly, with an independently
 * written literal rather than an import of this one (importing it would make
 * the assertion agree with any mutation applied here).
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` covers `~/.gitconfig` AND `$XDG_CONFIG_HOME/
 * git/config`, but NOT `$HOME/.config/git/attributes` — the global ATTRIBUTES
 * file has no `GIT_CONFIG_*` equivalent and is reachable only via
 * `core.attributesFile` on the command line (verified: with HOME pointed at a
 * repo, a committed `.config/git/attributes` naming a diff driver is honoured
 * and the driver executes). `GIT_ATTR_NOSYSTEM` closes the system-wide
 * attributes file, which has no command-line control at all.
 */
export const HERMETIC_GIT_ENV: Readonly<Record<string, string>> = {
  // Repo content is untrusted (§12.2). PATH is needed to find git itself;
  // nothing else from the harvester's environment crosses this boundary.
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
  HOME: "/dev/null",
  LC_ALL: "C",
  TERM: "dumb",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_EXTERNAL_DIFF: "",
};

/**
 * `--no-ext-diff` and `--no-textconv` disable the two per-path diff drivers a
 * repository can point at a program. BOTH are required, and the reason is the
 * least obvious thing in this file:
 *
 * `.gitattributes` assigns `diff=name`; `[diff "name"]` may then define EITHER
 * `command` (an external diff) OR `textconv` (a filter git runs to render a
 * blob as text). When both are defined, `command` wins and `textconv` is never
 * reached. So adding `--no-ext-diff` alone does not remove the execution — it
 * removes the winner and git FALLS BACK to running textconv. The first version
 * of this hardening did exactly that, turning a dormant driver into a live one:
 *
 *   unhardened          ext-diff ran,  textconv did not
 *   --no-ext-diff only  ext-diff none, TEXTCONV RAN   <- worse than before
 *   both flags          neither ran
 *
 * The integration test named "executes nothing" passed throughout, because its
 * fixture only defined `command`. A test pins the driver it was written for,
 * not the invariant in its title.
 *
 * Both are DIFF-FAMILY options, not top-level ones: passing either to `git`
 * itself fails every invocation with "unknown option" (verified: `rev-parse`,
 * `merge-base` and `init` all exit 129). So they are appended only for the
 * commands that accept them. The first version of `--no-ext-diff` put it in
 * the global list, where it broke those three while the unit tests, which only
 * exercise the output parsers, stayed green.
 *
 * Both findings came from running the reproduction, not from reading the man
 * page.
 */
const EXT_DIFF_COMMANDS = new Set(["diff", "log", "show", "diff-tree", "diff-index", "whatchanged"]);
const DIFF_DRIVER_FLAGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

/**
 * Build the complete hardened argv for a git invocation in `cwd`.
 *
 * Exported because `runGit` is NOT the only place this subsystem spawns git:
 * `harvest/acceptance.ts` runs `show`, `clone` and `checkout` against the same
 * worker-controlled repository. Those three carried their own flagless argv
 * for a whole phase, so the hardening this file documents in detail simply did
 * not apply to them. A second list would have drifted the same way a second
 * time; there is one list, and every git spawn is built by this function.
 */
export function hardenedGitArgv(cwd: string, args: readonly string[]): string[] {
  const sub = args[0] ?? "";
  const argv = EXT_DIFF_COMMANDS.has(sub)
    ? [sub, ...DIFF_DRIVER_FLAGS.filter((f) => !args.includes(f)), ...args.slice(1)]
    : [...args];
  return ["git", "-C", cwd, ...GIT_HARDENING, ...argv];
}

/**
 * Spawn git in `cwd`. Argv array in, decoded streams out — no shell, ever.
 */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const p = Bun.spawn(hardenedGitArgv(cwd, args), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...HERMETIC_GIT_ENV },
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
export async function deriveGitFacts(
  worktree: string,
  baseRef: string,
  /**
   * The git runner, injectable for one reason: two branches below are
   * reachable only when git itself misbehaves, and a real repository cannot
   * be persuaded to produce them on demand.
   *
   * `merge-base --is-ancestor` exiting >=2 means git FAILED, which must not be
   * read as "not an ancestor" — the responses differ (unknown facts vs a
   * rewritten base), and a mutation collapsing the two left the whole suite
   * green while producing full diff facts with `base_is_ancestor: true`. The
   * 32 MiB withhold-not-truncate rule (ISC-90) is the same: no fixture builds
   * a diff that large, so nothing held it in place.
   *
   * A seam this narrow — one function, defaulted, used by tests only — is
   * worth more than two invariants documented in comments and pinned by
   * nothing.
   */
  run: (cwd: string, args: string[]) => Promise<GitResult> = runGit,
): Promise<GitFacts> {
  const runGit = run;
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
  if (commits.length > MAX_ITEMS) {
    // MAX_ITEMS on the schema would reject the whole bundle; keeping the most
    // recent 1000 with a recorded reason preserves the facts we CAN report.
    reasons.push(`commit list truncated from ${commits.length} to ${MAX_ITEMS} (schema MAX_ITEMS)`);
    commits = commits.slice(0, MAX_ITEMS);
  }

  let filesChanged = mergeLineCounts(
    parseNameStatusZ(nameStatus.stdout),
    parseNumstatZ(numstat.stdout),
  );
  if (filesChanged.length > MAX_ITEMS) {
    // The same truncation the commit list has had all along. Without it, a
    // worker touching 1001 files made `DerivedFactsSchema.parse` THROW out of
    // a module whose contract is "return {ok, reasons}, never throw" — and
    // 1001 changed files is an ordinary large refactor, not an attack.
    //
    // Truncation happens HERE, before the schema sees the array, not by
    // catching the ZodError afterwards. Zod validates elements BEFORE
    // enforcing the array's `.max()`, so an over-length array of INVALID
    // elements allocates one issue object per element: measured at length
    // 100000, the valid case cost 20 MB and 77 ms while the invalid case cost
    // 1122 MB and 511 ms — 56x the memory, for input a worker chooses freely.
    // Guarding the count is what keeps that array from ever being parsed.
    reasons.push(
      `file list truncated from ${filesChanged.length} to ${MAX_ITEMS} (schema MAX_ITEMS)`,
    );
    filesChanged = filesChanged.slice(0, MAX_ITEMS);
  }

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
