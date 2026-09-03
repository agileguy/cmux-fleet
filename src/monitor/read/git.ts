/**
 * The git strip's reader (SRD-FLEET-MONITOR §6.8, D12, ISC-486, ISC-487).
 *
 * ## What this replaces, and the five things it may not lose
 *
 * `gitWatchCommand` (`operations-plan.ts:696-702`) is one shell line:
 *
 *     git --no-pager -c color.ui=always -C <watchDir> status --short --branch
 *     echo
 *     git --no-pager -c color.ui=always -C <watchDir> log --oneline -10
 *
 * wrapped in `redrawOnChange`. Every flag in it is load-bearing and each was
 * paid for once already:
 *
 * - **`--no-pager`** — without it `git log` finds a terminal on stdout, starts
 *   `less`, and the loop stops at `(END)` waiting for a keypress that never
 *   comes. The pane then shows a plausible commit list and refreshes never,
 *   which `operations-plan.ts:697-703` calls "the exact failure a screenshot
 *   cannot distinguish from success". **This module spawns git directly with no
 *   shell and no tty on stdout, so a pager cannot start** — the flag is passed
 *   anyway, because a future caller that pipes through a shell would resurrect
 *   the bug and the flag costs nothing.
 * - **`-C <watchDir>`, never `cd`** — the console watches *the repository you
 *   were standing in*, which is not necessarily this one (`scripts/operations`
 *   passes `process.cwd()`).
 * - **`--branch` on `status --short`** — the branch line is the point; a short
 *   status without it is a list of paths with no answer to "ahead of what".
 * - **the commit list**, which D12 keeps in full.
 * - **the dirty path list**, which is what makes the strip worth a glance.
 *
 * `-c color.ui=always` is deliberately NOT carried. It existed because the
 * incumbent's `redrawOnChange` compares two strings and colour codes had to
 * survive that comparison; here the renderer owns styling and raw text is what
 * a `(model) => string[]` seam must compare (D2). Colour codes in the model
 * would make every byte-pinned assertion in this design unreadable.
 *
 * ## Q8 reversed the default, and the model carries both halves regardless
 *
 * The owner's answer on 2026-09-02: **status first, commits behind `[c]`** —
 * dirty paths change and a commit list on an idle branch does not. That is a
 * RENDERING decision and it is `GitStrip.commitsExpanded`'s job. This reader
 * always fetches both, so expanding costs no read and no latency; there is
 * nothing here that knows which half is shown.
 */

import { failed, ok, type GitStrip, type Region } from "../model.ts";

/**
 * The commit count. Ten, matching the incumbent exactly — D12 says the content
 * is "kept in full and compressed by default", and fetching fewer than the pane
 * used to show would make the compression lossy at the source rather than at
 * the display, where it can be undone with a keypress.
 */
const COMMITS = 10;

/**
 * A ceiling on how long git may take before the strip reports staleness rather
 * than blocking a clock tick.
 *
 * Not derived from a measurement of git, because the thing being bounded is not
 * git's normal cost — it is the pathological case a monitor must survive: a
 * repository on a stalled network mount, or one mid-`gc` with an index lock
 * held. `status` on a healthy tree is single-digit milliseconds; anything near
 * this ceiling is a repository that cannot answer, and the honest rendering is
 * a failed region saying so rather than a pane that stops repainting.
 */
const TIMEOUT_MS = 5_000;

export interface ReadGitOptions {
  /** The repository to watch. `git -C` target, never a `cd`. */
  readonly watchDir: string;
  readonly now?: () => number;
  /** Injected for tests; defaults to a real spawn. */
  readonly run?: (args: readonly string[]) => Promise<{ ok: boolean; out: string }>;
}

/**
 * `git` argv builders, exported so the anti-criterion can assert on them.
 *
 * **Two separate nullary-ish builders rather than one parameterised runner**,
 * for the reason `docker.ts` gives about its own argv: a builder that accepts a
 * subcommand is one refactor from accepting any git command, and this is a
 * read-only surface. Each takes only the watch directory.
 */
export const statusArgv = (watchDir: string): readonly string[] => [
  "git",
  "--no-pager",
  "-C",
  watchDir,
  "status",
  "--short",
  "--branch",
];

export const logArgv = (watchDir: string): readonly string[] => [
  "git",
  "--no-pager",
  "-C",
  watchDir,
  "log",
  "--oneline",
  `-${COMMITS}`,
];

async function spawnGit(args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn([...args], {
    // No shell, and stdout is a pipe rather than a tty — which is what actually
    // makes a pager impossible, `--no-pager` being belt to that braces.
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { ok: code === 0, out };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the strip. Never throws: a monitor whose git pane can take down the
 * frame is worse than one with no git pane, and the incumbent's `|| true`
 * existed for exactly this — "the pane dies on the first refresh after a
 * `down`, which is exactly when an operator looks at it"
 * (`operations-plan.ts:668-670`).
 */
export async function readGit(opts: ReadGitOptions): Promise<Region<GitStrip>> {
  const now = opts.now ?? Date.now;
  const run = opts.run ?? spawnGit;

  try {
    const [status, log] = await Promise.all([
      run(statusArgv(opts.watchDir)),
      run(logArgv(opts.watchDir)),
    ]);

    if (!status.ok) {
      // A directory that is not a repository is the common case here — the
      // console watches wherever the operator was standing — and it is a
      // FAILED region rather than an empty one, because an empty strip reads
      // as "a clean tree" and that is a different and reassuring claim.
      return failed(`git status failed in ${opts.watchDir}`, now());
    }

    const lines = status.out.split("\n");
    // `--branch` puts the branch line first, prefixed `##`. Its absence means
    // the flag was dropped, and rather than silently rendering a path as a
    // branch the strip says so.
    const first = lines[0] ?? "";
    const branchLine = first.startsWith("##") ? first : "";
    const statusLines = lines.slice(branchLine === "" ? 0 : 1).filter((l) => l.trim() !== "");

    return ok(
      {
        branchLine,
        statusLines,
        // A failed `git log` is survivable where a failed `status` is not: a
        // repository with no commits yet is real and its status is still worth
        // showing. Empty commits with a good status is not a lie.
        commitLines: log.ok ? log.out.split("\n").filter((l) => l.trim() !== "") : [],
        watchDir: opts.watchDir,
        // Q8: status first. The renderer flips this on `[c]`.
        commitsExpanded: false,
      },
      now(),
    );
  } catch (err) {
    return failed(`git unreadable in ${opts.watchDir}: ${String(err)}`, now());
  }
}
