/**
 * A repository whose code must not reach a hosted vendor, and the gate that
 * stops it — mechanically, at `up`, before a container exists.
 *
 * ## Why this is code and not a sentence in a role file
 *
 * `roles/collator.md` already carried the refusal, in as many words: if the
 * target's remote is Broadcom GHE or either AppNeta org, refuse the review and
 * report `blocked`. It did not fire. Three full reviews of
 * `github.com/dan-elliott-appneta/rally-cli` went to three hosted third-party
 * vendors while that sentence sat in the collator's own briefing.
 *
 * It failed for a reason worth stating, because it is the same reason twice on
 * this branch: **the document named a condition and never named the probe.** It
 * said "if the remote is X" to a worker that has no `bash`, no `git`, and was
 * never told the remote is legible at `/workspace/.git/config` — which it is,
 * measured. A rule whose fact the reader cannot reach is not a weak rule, it is
 * a decoration.
 *
 * And even repaired, prose would be the wrong instrument. A refusal enforced by
 * asking a hosted model to decline to read the code it was dispatched to read is
 * a refusal whose enforcement is the thing being guarded against. This gate runs
 * on the operator's machine, before the mount.
 *
 * ## What it can and cannot see, stated so nothing implies more
 *
 * - **It reads `origin`.** A repository with no remote, or whose remote was
 *   removed, is NOT classified sensitive — there is nothing left to classify.
 *   A local clone of an AppNeta repo with `git remote remove origin` passes this
 *   gate. That is a real hole and it is named rather than papered over; closing
 *   it needs a signal that survives the remote's deletion, which `.git` does not
 *   carry.
 * - **It matches on the host and org**, in both URL spellings a git remote takes
 *   (`https://host/org/…` and `git@host:org/…`), because a pattern that only
 *   matched one would pass every SSH checkout on the machine.
 * - **It does not read file contents.** Proprietary code in a repo with a
 *   personal remote is invisible here, by construction.
 */
import { runGit, type GitResult } from "../harvest/git.ts";

/**
 * The remotes whose code may not go to a hosted provider.
 *
 * These are the operator's three standing rules, and they are spelled here as
 * the matcher rather than in prose so that the rule and its enforcement cannot
 * drift apart — which is exactly what happened while the only copy lived in
 * `roles/collator.md`.
 */
export const SENSITIVE_REMOTE_PATTERNS: readonly string[] = [
  "github.gwd.broadcom.net",
  "github.com/appneta/",
  "github.com/dan-elliott-appneta/",
];

/**
 * The pattern a remote URL matches, or `null`.
 *
 * SSH remotes are rewritten to the `host/path` shape first (`git@h:org/r` →
 * `h/org/r`) so one pattern list covers both spellings. Matching is
 * case-insensitive because git hosts are.
 */
export function sensitiveRemote(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === "") return null;
  const normalized = url.trim().replace(/^[^@\s]+@([^:/\s]+):/, "$1/");
  const haystack = normalized.toLowerCase();
  for (const pattern of SENSITIVE_REMOTE_PATTERNS) {
    if (haystack.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

/** `origin`'s URL, or `null` when the repo has no origin (or is not a repo). */
export async function originRemote(
  repoRoot: string,
  run: (cwd: string, args: string[]) => Promise<GitResult> = runGit,
): Promise<string | null> {
  const res = await run(repoRoot, ["remote", "get-url", "origin"]);
  if (res.code !== 0) return null;
  const url = res.stdout.trim();
  return url === "" ? null : url;
}

/** One worker that would carry this repo's code to a vendor. */
export interface HostedCarrier {
  readonly workerId: string;
  readonly provider: string;
}

/**
 * The refusal text, or `null` when the run may proceed.
 *
 * ## Consent echoes the REMOTE, not a boolean
 *
 * `run.hosted_repo_consent` holds the remote URL the operator is consenting to
 * send, and it must match the one actually resolved. A boolean would be wrong
 * here in a way that matters on this fleet specifically: the launch directory
 * overrides `run.repo`, so the same `fleet.yaml` sends whatever repository the
 * operator happened to `cd` into. A `true` written once for a repo they thought
 * about would silently cover every repo they did not. An echoed URL cannot
 * transfer, and a wrong echo refuses and prints both strings.
 */
export function hostedRepoRefusal(args: {
  readonly repoRoot: string;
  readonly remote: string | null;
  readonly carriers: readonly HostedCarrier[];
  readonly consent: string | null;
}): string | null {
  const { repoRoot, remote, carriers, consent } = args;
  const matched = sensitiveRemote(remote);
  if (matched === null) return null;
  if (carriers.length === 0) return null;
  if (consent !== null && consent.trim() === (remote ?? "").trim()) return null;

  const rule = "=".repeat(78);
  const lines = [
    rule,
    "REFUSED: this repository may not be sent to a hosted provider.",
    "",
    `  repo:    ${repoRoot}`,
    `  remote:  ${remote ?? "(none)"}`,
    `  matched: ${matched}`,
    "",
    `  ${carriers.length} worker(s) would carry its contents to a vendor:`,
  ];
  for (const c of carriers) lines.push(`    ${c.workerId}  provider=${c.provider}`);
  lines.push(
    "",
    "  This is the refusal roles/collator.md states and could not enforce: a worker",
    "  with no bash, asked to check a remote it was never told how to read. It is",
    "  enforced here instead, on your machine, before any container is created.",
    "",
    "  To send it anyway, echo the remote back in fleet.yaml — the exact string:",
    `    run:`,
    `      hosted_repo_consent: ${remote ?? ""}`,
    "",
    "  It echoes the URL rather than taking a boolean because the launch directory",
    "  overrides run.repo, so a blanket yes written for one repository would cover",
    "  every other one you later launch from.",
    rule,
    "",
  );
  if (consent !== null) {
    lines.splice(
      lines.length - 2,
      0,
      `  (run.hosted_repo_consent is set, but to a different remote: ${consent})`,
    );
  }
  return lines.join("\n");
}
