/**
 * Shared machinery for grading what a ROLE DOCUMENT claims about the runtime.
 *
 * ## Why this exists as a module rather than as two copies
 *
 * `collator-role.test.ts` and `reviewer-role.test.ts` ask the same question of
 * different documents, and the first version of each answered it with its own
 * regex and its own allowlist. A review found the consequence: both guards
 * classified only a path's FIRST SEGMENT against a set of mount roots, so
 * `/outbox/reports-v2/<child-task-id>.json` — a path that has never existed —
 * passed, because `/outbox` is a mount. The historical defect was caught only by
 * a literal `not.toContain("/outbox/reports/")`.
 *
 * **A denylist of past mistakes cannot catch a future one.** So the path check
 * below is POSITIVE and derived: the set of paths a document may name is built
 * from the constants and builders that produce them, and anything else fails.
 * Adding a real path to a role document means adding it here, from the code that
 * makes it real — which is the point, because a path with no code behind it is
 * exactly the claim these probes exist to refuse.
 *
 * ## What is checked by construction, and what is not — stated so the table can
 * repeat it honestly
 *
 * - **Paths: by construction.** Every cited path must be in the derived set or
 *   under `/workspace/`. A new false path reddens without anyone predicting it.
 * - **Capability words: by a NEGATION RULE, not by construction.** A document may
 *   contain the word `diff` only in a sentence that also denies having one. That
 *   catches "Review the diff", "Read past the diff" and "Start from the diff and
 *   work outwards" without enumerating them — and it is a rule about SENTENCES,
 *   so a document could still assert a false capability in words the rule does
 *   not model. It is stronger than a denylist and weaker than understanding.
 * - **Tone, judgement and advice: not checked at all**, deliberately, and
 *   `collation-contract.mutations.md`'s U8/U9 measure that boundary rather than
 *   describing it.
 */
import { readFileSync } from "node:fs";

import { RESULT_ENVELOPE_NAME } from "../../src/contracts.ts";

import {
  COLLATION_ARTIFACT_NAME,
  COLLATION_REPORT_NAME,
  collationArtifactPath,
  collationReportPath,
} from "../../src/run/collation.ts";
import { DISPATCH_POLICY_MOUNT } from "../../src/run/dispatch-policy.ts";
import { DISPATCH_REQUEST_FILE } from "../../src/run/dispatch-request.ts";
import { REPLIES_MOUNT, REPLY_SUFFIX } from "../../src/run/replies.ts";
import { REVIEW_CONSOLE_ASPECTS, childTaskId } from "../../src/run/task-ids.ts";

export const ROOT = new URL("../../", import.meta.url).pathname;

/** The placeholder a role document uses where a task id goes. */
const TASK = "<task-id>";
const CHILD = "<child-task-id>";

/**
 * Container paths a review-console role document may name, each derived from the
 * thing that makes it real.
 *
 * The three mount roots are string literals because `render.ts` writes them
 * inline in `argv.push("-v", …)` with no constant to import; every path BELOW a
 * root is derived. That split is deliberate rather than lazy — a root is one
 * token in one file and its loss is a container that will not start, while a
 * path under a root is exactly where an invented one hides.
 */
export function allowedContainerPaths(): ReadonlySet<string> {
  const paths = new Set<string>([
    "/workspace",
    "/outbox",
    "/skills",
    "/sessions",
    REPLIES_MOUNT,
    DISPATCH_POLICY_MOUNT,
    `/outbox/${TASK}`,
    `/outbox/${TASK}/${DISPATCH_REQUEST_FILE}`,
    // The result envelope, derived from the constant the harvester reads. A role
    // document that cannot cite this path is one whose worker does not write it —
    // `rev-ctx-1` filed its whole review as loose files because `reviewer.md`
    // named `result.json` nowhere.
    `/outbox/${TASK}/${RESULT_ENVELOPE_NAME}`,
    `${REPLIES_MOUNT}/${CHILD}${REPLY_SUFFIX}`,
    collationArtifactPath(TASK.replace(/[<>]/g, "x")).replace("xtask-idx", TASK),
    collationReportPath(TASK.replace(/[<>]/g, "x")).replace("xtask-idx", TASK),
  ]);
  // The worked reply paths in the collator's example brief, one per lens.
  for (const seat of REVIEW_CONSOLE_ASPECTS) {
    paths.add(`${REPLIES_MOUNT}/${childTaskId("T", seat.aspect)}${REPLY_SUFFIX}`);
  }
  return paths;
}

/** Sanity: the two artifact names really are what the builders spell. */
export const ARTIFACT_NAMES = {
  structural: COLLATION_ARTIFACT_NAME,
  prose: COLLATION_REPORT_NAME,
} as const;

/**
 * Every backticked absolute path a document cites.
 *
 * The character class admits `<` and `>` because every interesting path in these
 * documents carries a placeholder, and a class without them ends the match early
 * — the decorative failure ISC-364's own probe shipped with, where the most
 * important path in the file was never examined.
 */
export function citedPaths(text: string): string[] {
  return [...text.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)].map((m) => m[1]!);
}

/**
 * Cited paths that are neither derived nor inside the checkout.
 *
 * `/workspace/...` is admitted wholesale and nothing else is. The checkout's
 * contents are the operator's repository — unknowable here, and a document
 * quoting `/workspace/src/rpc/epoch.ts` as an example location is doing exactly
 * what it should. Everything outside it is a claim about the fleet's own layout,
 * which is checkable and is checked.
 */
export function unknownPaths(text: string): string[] {
  const allowed = allowedContainerPaths();
  return citedPaths(text).filter((p) => !allowed.has(p) && !p.startsWith("/workspace/"));
}

/** Markers that a sentence is DENYING a capability rather than instructing it. */
const NEGATIONS = [
  "no ",
  "not ",
  "never",
  "cannot",
  "without",
  "nothing",
  "lack",
  "unavailable",
  "n't",
];

/**
 * Sentences that use a capability word without denying it.
 *
 * The rule, and its limits, because the limits are what make it honest: a
 * document may say `diff` as often as it likes, and every sentence that says it
 * must also carry a negation. That catches an instruction to work from something
 * the worker does not have, in any wording, without a list of the wordings that
 * were wrong before. What it cannot catch is a false claim expressed without any
 * of these words — a sentence asserting a capability by describing its effect.
 *
 * ## The splitter is load-bearing and the obvious one is wrong
 *
 * These documents are WRAPPED prose, so a naive split on newlines cuts sentences
 * in half — and the half that keeps the capability word may not be the half that
 * keeps the negation. Measured: *"**And you never\nreceive the task envelope**"*
 * split into `"**And you never"` and `"receive the task envelope**; …"`, and the
 * second was reported as an ungrounded claim. A probe that cries wolf on the
 * document's own correction is one that gets its rule deleted.
 *
 * So: paragraph breaks become a sentinel, single newlines become spaces, and only
 * then does it split on sentence enders. `:` is deliberately NOT an ender — a
 * colon introduces a list and the clause after it belongs to the clause before.
 */
export function ungroundedCapabilityClaims(text: string, words: readonly string[]): string[] {
  const out: string[] = [];
  const units = text
    .replace(/\n{2,}/g, "\u00b6")
    .replace(/\n/g, " ")
    .split(/\u00b6|(?<=[.!?])\s+/);
  for (const raw of units) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    const lower = sentence.toLowerCase();
    for (const w of words) {
      if (!new RegExp(`\\b${w}\\b`, "i").test(sentence)) continue;
      if (NEGATIONS.some((n) => lower.includes(n))) continue;
      out.push(`${w}: ${sentence.slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * The tools a role is granted, read out of a yaml config.
 *
 * A regex rather than the yaml parser, and the reason is the one that decides
 * every "should this test load the real thing" question in this repository: the
 * probe must run where the config it is grading might not parse. `config
 * validate` is what proves the file is well-formed; this only needs the one line
 * that carries the grant, and reading it textually means a probe that still
 * reports on a config someone half-edited.
 */
export function grantedTools(configText: string, role: string): readonly string[] {
  const start = configText.indexOf(`\n  ${role}:\n`);
  if (start < 0) throw new Error(`no role block named "${role}" — the probe has rotted`);
  const rest = configText.slice(start + 1);
  const end = rest.search(/\n {2}[a-z_]+:\n/);
  const block = end < 0 ? rest : rest.slice(0, end);
  const m = /^ {4}tools:\s*\[([^\]]*)\]/m.exec(block);
  if (m === null) throw new Error(`role "${role}" has no tools: line — the probe has rotted`);
  return m[1]!
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/**
 * The TRACKED config, which is the one CI has.
 *
 * `fleet.yaml` is gitignored — `ci.yml` is checkout, `bun install`,
 * `bun test test/unit`, with no step that creates it — so a probe that read it
 * unconditionally would be red on every clean checkout. That is the defect
 * `review-plan.test.ts` documents thirteen tests' worth of, and this function
 * exists so no caller has to remember it: the grading arm reads
 * `fleet.example.yaml`, which is committed and always present, and the live file
 * is a SEPARATE, GATED probe.
 */
export function exampleConfig(): string {
  return readFileSync(`${ROOT}fleet.example.yaml`, "utf8");
}
