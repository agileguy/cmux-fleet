/**
 * Mutation battery 5 — the collation envelope and the role file that produces it.
 *
 * Runs entirely inside a throwaway worktree; the live checkout is never written
 * to. Restore-first across both files, checksum verified after every step, hard
 * timeout in case a mutation makes a suite hang rather than fail.
 *
 * Prefix key. `C` mutates the CONTRACT (`src/run/collation.ts`). `R` mutates the
 * ROLE DOCUMENT (`roles/collator.md`), which is source in every sense that
 * matters: it is the program the collator executes, and a wrong path in it costs
 * a review as surely as a wrong constant. `NC` are negative controls. `NO` are
 * semantic no-ops. `U` are mutations expected GREEN because nothing reaches them
 * — declared here so the gaps in `collation-contract.mutations.md` are named
 * rather than counted.
 *
 * Shape and argument taken unchanged from `collator-relay.battery.ts`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE WORKTREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source files in place. Pointing it at a live checkout is
 * how a transient broken state gets read by something that spawns containers
 * from the tree, which cost a worker once.
 *
 *   git worktree add /tmp/wt HEAD --detach
 *   ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
 *   cp src/run/collation.ts roles/collator.md ... /tmp/wt/...   # uncommitted work
 *   bun run test/mutation/collation-contract.battery.ts /tmp/wt
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error(
    "usage: collation-contract.battery.ts <throwaway-worktree>  (never the live checkout)",
  );
}
const SRC = `${W}/src/run/collation.ts`;
const ROLE = `${W}/roles/collator.md`;
/**
 * The reviewer's briefing — two files, because `load.ts` concatenates role and
 * worker briefings into one prompt (D10's mechanism). A claim corrected in one
 * and left standing in the other is a briefing that contradicts itself, so both
 * are mutable here.
 */
const REVIEWER = `${W}/roles/reviewer.md`;
const XFILE = `${W}/roles/review/cross-file-contracts.md`;
/**
 * The LANGUAGE seat's aspect file, which is a third briefing fragment for the
 * same reason `XFILE` is a second: `load.ts` concatenates role and worker
 * briefings, so this file and `roles/reviewer.md` are read as one instruction.
 *
 * It is mutable here because its angle is now DERIVED FROM THE TARGET rather
 * than named in advance, and that is a claim about the fleet that can rot. It
 * was `typescript-language.md` while this console's integration target is a
 * Python project — a seat briefed on the wrong language for every run, which
 * the collator had been working around inside each brief it wrote.
 */
const LANGFILE = `${W}/roles/review/implementation-language.md`;
/**
 * The TRACKED config, which is the one CI grades against and therefore the one a
 * capability probe must be mutated in. `fleet.yaml` is gitignored, so a mutation
 * there proves nothing about a clean checkout.
 */
const EXAMPLE = `${W}/fleet.example.yaml`;
/** The operator's own, copied in and restored like the rest. */
const FLEET = `${W}/fleet.yaml`;
const TESTFILES = [
  "test/unit/collation.test.ts",
  "test/unit/collator-role.test.ts",
  "test/unit/reviewer-role.test.ts",
  /**
   * ADDED with the language-seat mutations. It is the only suite that reads the
   * resolved WORKER config — `resolveWorker`'s worker → role → default
   * precedence — so it is the only one that can see a `toolchain` override come
   * back onto `rev-lang-1`. Without it that mutation would be applied and
   * reported green for want of anything looking.
   *
   * It is GATED on `fleet.yaml` existing (`describe.skipIf`), and the battery
   * copies the operator's own into the worktree, so the guarded block runs here.
   * On a machine with no `fleet.yaml` those assertions skip and the mutations
   * that depend on them would report green — which is the same gap the anchors
   * guard records for untracked targets, and is why `FLEET` mutations are
   * declared as such rather than trusted.
   */
  "test/unit/review-plan.test.ts",
];

/**
 * The pristine copy is taken FROM THE WORKTREE at start-up rather than from a
 * side file, so the battery can never restore a stale version over newer work —
 * the failure mode that silently reverts a fix and reports every mutation green.
 */
const PRISTINE: Record<string, string> = {
  [SRC]: readFileSync(SRC, "utf8"),
  [ROLE]: readFileSync(ROLE, "utf8"),
  [REVIEWER]: readFileSync(REVIEWER, "utf8"),
  [XFILE]: readFileSync(XFILE, "utf8"),
  [LANGFILE]: readFileSync(LANGFILE, "utf8"),
  [FLEET]: readFileSync(FLEET, "utf8"),
  [EXAMPLE]: readFileSync(EXAMPLE, "utf8"),
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TIMEOUT_MS = 30_000;

interface M {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  expect: "red" | "green";
  also?: Array<{ file?: string; find: string; replace: string }>;
}

const MUTATIONS: M[] = [
  // ── Attribution: the numerator §6.8 asks for. ────────────────────────────
  {
    id: "C1",
    what: "ATTRIBUTION: raised_by need only name a lens, not one that REPORTED",
    file: SRC,
    find: '        } else if (!reported.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    replace: '        } else if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    expect: "red",
  },
  {
    id: "C2",
    what: "ATTRIBUTION: a repeated reviewer is accepted, turning 1/3 into 2/3",
    file: SRC,
    find: '        if (claimed.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    replace: '        if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    expect: "red",
  },
  {
    id: "C3",
    what: "ATTRIBUTION: a worker outside the lens table may raise a finding",
    file: SRC,
    find: '        if (!seenWorkers.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    replace: '        if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "raised_by"],',
    expect: "red",
  },
  {
    id: "C4",
    what: "ATTRIBUTION: raised_by may be empty",
    file: SRC,
    find: "    raised_by: z.array(workerId).min(1, {",
    replace: "    raised_by: z.array(workerId).min(0, {",
    expect: "red",
  },
  // ── Contradiction: dissent recorded as dissent. ──────────────────────────
  {
    id: "C5",
    what: "CONTRADICTION: one lens may both raise and dispute a finding",
    file: SRC,
    find: '        if (claimed.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    replace: '        if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    expect: "red",
  },
  {
    id: "C6",
    what: "CONTRADICTION: a lens that never reported may dispute a finding",
    file: SRC,
    find: '        } else if (!reported.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    replace: '        } else if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    expect: "red",
  },
  // ── The denominator. ─────────────────────────────────────────────────────
  {
    id: "C7",
    what: "DENOMINATOR: one worker may hold two lenses",
    file: SRC,
    find: "      if (seenWorkers.has(lens.worker)) {",
    replace: "      if (false) {",
    expect: "red",
  },
  {
    id: "C8",
    what: "DENOMINATOR: one aspect may have two rows",
    file: SRC,
    find: "      if (seenAspects.has(lens.aspect)) {",
    replace: "      if (false) {",
    expect: "red",
  },
  {
    id: "C9",
    what: "DENOMINATOR: a collation in which NO lens reported is accepted",
    file: SRC,
    find: "    if (reported.size === 0) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "C10",
    what: "DENOMINATOR: lenses[] may be empty",
    file: SRC,
    find: "      .min(1, {\n        error:\n          \"lenses[] is empty,",
    replace: "      .min(0, {\n        error:\n          \"lenses[] is empty,",
    expect: "red",
  },
  // ── D8's line: the words this document may not borrow. ───────────────────
  {
    id: "C11",
    what: "D8: an `acceptance` field is accepted",
    file: SRC,
    find: "    acceptance: notHere(",
    replace: "    acceptance: z.unknown().optional(), acceptanceUnused: notHere(",
    expect: "red",
  },
  {
    id: "C12",
    what: "D8: a `verified` field is accepted",
    file: SRC,
    find: "    verified: notHere(",
    replace: "    verified: z.unknown().optional(), verifiedUnused: notHere(",
    expect: "red",
  },
  {
    id: "C13",
    what: "D8: a second `status` inside the artifact is accepted",
    file: SRC,
    find: "    status: notHere(",
    replace: "    status: z.unknown().optional(), statusUnused: notHere(",
    expect: "red",
  },
  {
    id: "C14",
    what: "STRICT: unknown keys pass through instead of being refused",
    file: SRC,
    find: "  .strict()\n  .superRefine((v, ctx) => {",
    replace: "  .loose()\n  .superRefine((v, ctx) => {",
    expect: "red",
  },
  // ── The location: typed here, resolved by the census. ────────────────────
  {
    id: "C15",
    what: "LOCATION: a control character in a path is accepted",
    file: SRC,
    find: "    if (control !== null) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "C16",
    what: "LOCATION: the refusal ECHOES the path it refuses (the injection)",
    file: SRC,
    find: "          `a finding's \\`file\\` holds a control character (0x${code}) at index ` +\n          `${control.index}.",
    replace: "          `a finding's \\`file\\` ${p} holds a control character (0x${code}) at index ` +\n          `${control.index}.",
    expect: "red",
  },
  {
    id: "C17",
    what: "LOCATION: a fractional line number is accepted",
    file: SRC,
    find: '    line: z.number().int({ error: "a finding\'s `line` must be a whole number" }),',
    replace: "    line: z.number(),",
    expect: "red",
  },
  {
    id: "C18",
    what: "LOCATION: `file` and `line` become optional — a bare prose finding is legal",
    file: SRC,
    find: "    file: findingPath,",
    replace: "    file: findingPath.optional(),",
    expect: "red",
  },
  /**
   * The OTHER direction, and the pair C15/C19 is what pins the division of
   * labour rather than merely describing it. Refusing a traversal here looks
   * more careful and is the wrong layer: the census resolves it per finding
   * against the real workdir, and refusing the document costs every other
   * finding in it.
   */
  {
    id: "C19",
    what: "LAYER: containment is re-decided here as a string rule, refusing the document",
    file: SRC,
    find: "    // eslint-disable-next-line no-control-regex -- matching control characters is the point\n    const control = /[\\x00-\\x1f\\x7f]/.exec(p);",
    replace: '    if (p.split("/").includes("..")) {\n      ctx.addIssue({ code: "custom", message: "traversal" });\n      return;\n    }\n    // eslint-disable-next-line no-control-regex -- matching control characters is the point\n    const control = /[\\x00-\\x1f\\x7f]/.exec(p);',
    expect: "red",
  },
  // ── The count, authored and derived. ─────────────────────────────────────
  {
    id: "C20",
    what: "COUNT: finding_count becomes optional",
    file: SRC,
    find: "      .max(MAX_ITEMS, {\n        error:\n          `finding_count above ${MAX_ITEMS}",
    replace: "      .optional().max(MAX_ITEMS, {\n        error:\n          `finding_count above ${MAX_ITEMS}",
    expect: "red",
  },
  {
    id: "C21",
    what: "COUNT: a declared count disagreeing with the list is REFUSED (deletes the datum)",
    file: SRC,
    find: "    const reported = new Set(v.lenses.filter((l) => l.reported).map((l) => l.worker));",
    replace: '    if (v.finding_count !== v.findings.length) {\n      ctx.addIssue({ code: "custom", path: ["finding_count"], message: "count disagrees" });\n    }\n    const reported = new Set(v.lenses.filter((l) => l.reported).map((l) => l.worker));',
    expect: "red",
  },
  {
    id: "C22",
    what: "COUNT: the ceiling trusts finding_count instead of counting the list",
    file: SRC,
    find: "      if (read.collation.findings.length === 0) {",
    replace: "      if (read.collation.finding_count === 0) {",
    expect: "red",
  },
  // ── readCollation: the three outcomes. ───────────────────────────────────
  {
    id: "C23",
    what: "READ: an absent artifact is reported as a refusal rather than as missing",
    file: SRC,
    find: '  if (bytes === null) return { kind: "missing" };',
    replace:
      '  if (bytes === null) return { kind: "refused", code: "not_json", reason: "absent" };',
    expect: "red",
  },
  {
    id: "C24",
    what: "READ: the byte cap is removed",
    file: SRC,
    find: '  if (Buffer.byteLength(bytes, "utf8") > MAX_COLLATION_BYTES) {',
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "C25",
    what: "READ: the D5 link is not checked — a collation filed against any parent",
    file: SRC,
    find: "  if (collation.task_id !== expected) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "C26",
    what: "READ: bad JSON is reported as a schema failure",
    file: SRC,
    find: '      code: "not_json",\n      reason: `the collation artifact is not JSON',
    replace: '      code: "schema",\n      reason: `the collation artifact is not JSON',
    expect: "red",
  },
  // ── The ceiling. ─────────────────────────────────────────────────────────
  {
    id: "C27",
    what: "CEILING: the task-id guard is removed — every task's success is capped",
    file: SRC,
    find: "  if (!isCollationTaskId(taskId)) return { status: claimed, reason: null };",
    replace: "  if (false) return { status: claimed, reason: null };",
    expect: "red",
  },
  {
    id: "C28",
    what: "CEILING: the claim is no longer the antecedent — the instrument SUPPLIES a verdict",
    file: SRC,
    find: '  if (claimed !== "success") return { status: claimed, reason: null };',
    replace: "  if (false) return { status: claimed, reason: null };",
    expect: "red",
  },
  {
    id: "C29",
    what: "CEILING: a missing collation lets a success claim stand",
    file: SRC,
    find: '    case "missing":\n      return {\n        status: "partial",',
    replace: '    case "missing":\n      return {\n        status: "success",',
    expect: "red",
  },
  {
    id: "C30",
    what: "CEILING: an unreadable collation lets a success claim stand",
    file: SRC,
    find: '    case "refused":\n      return {\n        status: "partial",',
    replace: '    case "refused":\n      return {\n        status: "success",',
    expect: "red",
  },
  {
    id: "C31",
    what: "CEILING: zero findings with success is recorded as success (§6.8 rule 3 deleted)",
    file: SRC,
    find: "      if (read.collation.findings.length === 0) {\n        return {\n          status: \"partial\",",
    replace: "      if (read.collation.findings.length === 0) {\n        return {\n          status: \"success\",",
    expect: "red",
  },
  // ── The accessors. ───────────────────────────────────────────────────────
  {
    id: "C32",
    what: "COVERAGE: `missing` names workers instead of aspects",
    file: SRC,
    find: "    missing: collation.lenses.filter((l) => !l.reported).map((l) => l.aspect),",
    replace: "    missing: collation.lenses.filter((l) => !l.reported).map((l) => l.worker),",
    expect: "red",
  },
  {
    id: "C33",
    what: "COVERAGE: `total` counts only the lenses that reported",
    file: SRC,
    find: "    total: collation.lenses.length,",
    replace: "    total: collation.lenses.filter((l) => l.reported).length,",
    expect: "red",
  },
  {
    id: "C34",
    what: "ROSTER: reportedReviewers returns every lens, reported or not",
    file: SRC,
    find: "  return collation.lenses.filter((l) => l.reported).map((l) => l.worker);",
    replace: "  return collation.lenses.map((l) => l.worker);",
    expect: "red",
  },
  {
    id: "C35",
    what: "PATH: the artifact path drops its spellability guard",
    file: SRC,
    find: "  if (!spellable(taskId)) {\n    throw new Error(\n      `task id ${JSON.stringify(taskId)} cannot name a path segment, so no collation path was `",
    replace: "  if (false) {\n    throw new Error(\n      `task id ${JSON.stringify(taskId)} cannot name a path segment, so no collation path was `",
    expect: "red",
  },
  {
    id: "C36",
    what: "PATH: the artifact lands beside the envelope instead of under files/",
    file: SRC,
    find: "  return `/outbox/${taskId}/files/${COLLATION_ARTIFACT_NAME}`;",
    replace: "  return `/outbox/${taskId}/${COLLATION_ARTIFACT_NAME}`;",
    expect: "red",
  },
  {
    id: "C37",
    what: "TAG: the wire tag is not checked by name",
    file: SRC,
    find: "    schema: z.literal(COLLATION_SCHEMA, {",
    replace: "    schema: z.string().optional().default(COLLATION_SCHEMA), schemaUnused: z.never({",
    expect: "red",
  },
  // ── The role document. It is source. ─────────────────────────────────────
  {
    id: "R1",
    what: "ROLE: the fan-out is documented at the path that has never existed",
    file: ROLE,
    find: "writes the file to `/outbox/<task-id>/dispatch-request.json`",
    replace: "writes the file to `/outbox/fanout.json`",
    expect: "red",
  },
  {
    id: "R2",
    what: "ROLE: turn one is told to claim `partial` (the pre-§6.6 reading)",
    file: ROLE,
    find: '**3. Call `submit_report` with `status: "success"`.**',
    replace: '**3. Call `submit_report` with `status: "partial"`.**',
    expect: "red",
  },
  {
    id: "R3",
    what: "ROLE: the worked example shows all three lenses reporting",
    file: ROLE,
    find: '{"aspect": "lang",    "worker": "rev-lang-1", "reported": false, "note": "the lens timed out"}',
    replace: '{"aspect": "lang",    "worker": "rev-lang-1", "reported": true}',
    expect: "red",
  },
  {
    id: "R4",
    what: "ROLE: the worked example no longer demonstrates a contradiction",
    file: ROLE,
    find: '      "raised_by": ["rev-arch-1"],\n      "disputed_by": ["rev-ctx-1"]',
    replace: '      "raised_by": ["rev-arch-1", "rev-ctx-1"]',
    expect: "red",
  },
  {
    id: "R5",
    what: "ROLE: the example names a reviewer outside the console's roster",
    file: ROLE,
    find: '{"worker": "rev-lang-1", "title": "<one line>", "brief": "<the language brief>"}',
    replace: '{"worker": "rev-sec-1", "title": "<one line>", "brief": "<the language brief>"}',
    expect: "red",
  },
  {
    id: "R6",
    what: "ROLE: the example's own finding_count disagrees with its list",
    file: ROLE,
    find: '  "finding_count": 2,',
    replace: '  "finding_count": 3,',
    expect: "red",
  },
  {
    id: "R7",
    what: "ROLE: the document names a mount the collator does not have",
    file: ROLE,
    find: "The reports live at\n`/replies/<child-task-id>.json`",
    replace: "The reports live at\n`/policy/dispatch/<child-task-id>.json`",
    expect: "red",
  },
  {
    id: "R8",
    what: "ROLE: the collation example carries the wrong wire tag",
    file: ROLE,
    find: '  "schema": "pifleet.collation/v1",',
    replace: '  "schema": "pifleet.collate/v1",',
    expect: "red",
  },
  {
    id: "R9",
    what: "ROLE: the derived collation id is dropped from the turn-one instruction",
    file: ROLE,
    find: "`T-arch`, `T-context`, `T-lang` and `T-collate` —",
    replace: "`T-arch`, `T-context` and `T-lang` —",
    expect: "red",
  },
  {
    id: "R10",
    what: "ROLE: the D8 statement is removed from the grading section",
    file: ROLE,
    find: "**This check is not acceptance and must not be described as acceptance.**",
    replace: "**This check is how a review is accepted.**",
    expect: "red",
  },
  // ── The reviewer's briefing, and the mitigation pinned at both ends. ─────
  //
  // RE-ANCHORED 2026-09-05, when the contract these four measure was rewritten:
  // the long review now goes in `files/review.md` and `notes` carries a summary
  // of it. The previous anchors pointed at "put your whole review in the
  // envelope's `notes`", which is the instruction that was REMOVED — RV3's had
  // already rotted to 0x against a partial fix and was reported on every run.
  //
  // Re-anchored to the INSTRUCTIONS rather than to their headings. A heading is
  // reworded by anyone tightening prose; a destination path and a routing
  // instruction are things a reviewer executes, and changing either of them
  // changes what the console does.
  //
  // RE-ANCHORED AGAIN 2026-09-10 (SRD-WORKER-DISPATCH-EXTENSION task 8.1). The
  // role file no longer tells the reviewer to write `result.json` by hand, so
  // the anchors move onto the sentences that survived the Phase C deletion —
  // shorter fragments, chosen to survive a re-wrap rather than to quote a whole
  // wrapped line. RV2 and RV24 are GONE with the `notes` ceiling and the
  // asymmetry built on it: `SUBMIT_REPORT_PARAMETERS` caps `notes` at 20000 and
  // throws in front of the model, so the two channels no longer share a ceiling
  // and the over-cap `notes` no longer destroys an envelope. RV27 and RV28 are
  // GONE with the worked `json` envelope, which a model copying it would now
  // have refused under `additionalProperties: false`.
  {
    id: "RV1",
    what: "REVIEWER: the review's destination is unnamed — 'file it somewhere'",
    file: REVIEWER,
    find: "It lands at `/outbox/<task-id>/files/review.md`.",
    replace: "File it wherever suits you.",
    expect: "red",
  },
  /**
   * RE-ANCHORED 2026-09-11, onto the ROUTE clause, after `a1ae886` rewrote the
   * paragraph this quoted whole.
   *
   * ## Why the old anchor could not survive that commit
   *
   * It quoted all three wrapped lines verbatim, including where they wrap. The
   * middle line was the sentence `a1ae886` had to change — the collator was
   * ordering reviewers to declare the review in `artifacts`, which
   * `roles/reviewer.md` now tells them not to do — so NO wording that fixes the
   * contradiction leaves this matching. That is the rule stated 20 lines above
   * being broken by the case directly under it: short fragments, chosen to
   * survive a re-wrap rather than to quote a whole wrapped line.
   *
   * ## Why the ROUTE clause, and not the other three fragments measured
   *
   * All four occur exactly 1x in the current `roles/collator.md`. Only this one
   * makes the case mutate what its `what:` says, MEASURED rather than reasoned:
   *
   * - `**Tell each reviewer to file its long review at` — the honest weakening,
   *   mandatory to optional (*"A reviewer may, if it likes, file its long review
   *   at ..."*), leaves all four suites GREEN: 195 pass. Every probe on this
   *   paragraph reads further down the sentence. A case whose `expect: "red"`
   *   depends on the `replace:` happening to delete some other probe's literal
   *   is not measuring the document.
   * - `Tell each reviewer to file its long review` — reddens, but only by
   *   destroying `file its long review`, the marker `sliceFrom` scopes BOTH
   *   collator probes with. The failure is *"roles/collator.md no longer
   *   contains file its long review"*, a marker lookup, and it takes RV26's
   *   guard down as collateral while the destination, the route and the
   *   summary ceiling all survive verbatim in the mutated document. The case
   *   would claim the split was dropped; the split would still be there.
   * - `` `notes` FIELD of `/outbox/<task-id>/result.json` to a short summary.** ``
   *   — reddens, on *"the collator does not say `notes` is a field"*. That is
   *   the notes-is-a-FIELD-not-a-PATH contract, which is a different claim, and
   *   again the red is a property of the `replace:` dropping that literal
   *   rather than of the summary half going.
   *
   * The ROUTE clause is the one fragment whose removal reddens the probe named
   * for this case's own subject — *"the collator does not name the route that
   * declares the review"*, inside *"the collator's copy instructs the same split
   * the reviewer's does"*. `` `report` entry `` occurs ONCE in the whole
   * document, so deleting it here is genuinely detectable; the destination path
   * is stated twice (here and in the turn-two delivery section), so a case
   * anchored on that would have been unfalsifiable.
   *
   * It is also the half the document itself nominates: **"The ROUTE is the half
   * worth repeating", because it is the half still capable of going wrong: a
   * review sent out by any other route has nothing appending anything for it.**
   * The `replace:` is the brief that says exactly that — a destination with no
   * route — rather than the long form's *"write a thorough review"*, which no
   * longer fits the span being replaced.
   */
  {
    id: "RV3",
    what: "REVIEWER: the collator's copy of the split stops naming the route that files the review",
    file: ROLE,
    find: "by passing it as the one `report` entry of its `submit_report` call",
    replace: "by whatever route it likes",
    expect: "red",
  },
  /**
   * THE FALSE CLAIM, pinned by requiring its correction.
   *
   * The tempting thing to write here is that the file survives a broken
   * envelope, so the review gets through regardless. It does not:
   * `relay.ts` sets `succeeded: harvested.verdict === "success"`, an unparseable
   * envelope settles `unknown`, and only surviving lenses have a reply
   * published. A reviewer that believed otherwise would treat the artifact as a
   * safety net and go back to writing long envelopes, which is the defect this
   * whole change removes — arriving by way of a sentence that reads like
   * reassurance.
   *
   * The lie survives Phase C in a narrower form: the model can no longer produce
   * an unparseable envelope, but a lens that never called `submit_report`, or
   * whose task settled anything other than `success`, still has no reply
   * published — and the filed artifact still does not change that.
   */
  {
    id: "RV4",
    what: "REVIEWER: the file is promised to rescue a lens that did not report — the plausible lie",
    file: REVIEWER,
    find: "**It does not rescue the lens.**",
    replace: "**It also rescues the lens.**",
    expect: "red",
  },
  {
    id: "RV5",
    what: "REVIEWER: the design note stops naming which fix was taken",
    file: SRC,
    find: " * **Take A shipped.**",
    replace: " * **Something shipped.**",
    expect: "red",
  },
  {
    id: "RV6",
    what: "REVIEWER: the design note drops the cap's cost",
    file: SRC,
    find: " * **The cap's cost is paid, not hidden.**",
    replace: " * **The cap is free.**",
    expect: "red",
  },
  {
    id: "RV7",
    what: "REVIEWER: the false diff premise is restored in the role file",
    file: REVIEWER,
    find: "**Review what the brief names, against what the brief says it is for.**",
    replace: "**Review the diff against its stated intent.**",
    expect: "red",
  },
  {
    id: "RV8",
    what: "REVIEWER: the `There is no diff` correction is removed",
    file: REVIEWER,
    find: "**There is no diff.**",
    replace: "The change is in front of you.",
    expect: "red",
  },
  /**
   * The ASYMMETRIC arm of RV8. The correction can be present in
   * `roles/reviewer.md` while the aspect file concatenated after it still tells
   * the reviewer to work from a diff — one prompt contradicting itself, which
   * neither file alone can detect.
   */
  {
    id: "RV9",
    what: "REVIEWER: the false diff premise is restored in the ASPECT file only",
    file: XFILE,
    find: "**Read past the changed files.**",
    replace: "**Read past the diff.**",
    expect: "red",
  },
  {
    id: "RV10",
    what: "REVIEWER: the aspect file points at the task envelope again",
    file: XFILE,
    find: "**Verify the requirements one at a time.** If your brief states what the change is for,",
    replace: "**Verify the requirements one at a time.** If the task envelope states what the change is for,",
    expect: "red",
  },
  {
    id: "RV11",
    what: "REVIEWER: the document points at /policy/task for the intent (the plausible wrong fix)",
    file: REVIEWER,
    find: "and, when your task was staged, the same brief again at `/policy/dispatch`.",
    replace: "and the envelope at `/policy/task`.",
    expect: "red",
  },
  {
    id: "RV12",
    what: "REVIEWER: a reviewer is pointed at a sibling's reply (the sequential fan-out)",
    file: REVIEWER,
    find: "**Quote file and line, and quote the file as `/workspace/...`.**",
    replace: "Read `/replies/<child-task-id>.json` for what the others found. **Quote file and line, and quote the file as `/workspace/...`.**",
    expect: "red",
  },
  {
    id: "RV13",
    what: "REVIEWER: the container-path spelling guidance is dropped",
    file: REVIEWER,
    find: "Write the path the way the container sees it —\n`/workspace/src/rpc/epoch.ts`, line 183 — **not** the repo-relative form",
    replace: "Give the location",
    expect: "red",
  },
  {
    id: "RV14",
    what: "REVIEWER: the collator loses its instruction for a `path:line` it is handed",
    file: ROLE,
    find: "`src/foo.ts:12`, split it and make it absolute — the number belongs in `line`.",
    replace: "Split any suffix off the path.",
    expect: "red",
  },
  /**
   * RE-ANCHORED 2026-09-11 (task 8.2), AND THE COMMENT MOVED OUT OF THE OBJECT.
   *
   * The anchor this replaces was `tools: [read, write, grep, find, ls]`, which
   * task 7.1 narrowed to the grant below. It had matched NOTHING since — zero
   * occurrences in `fleet.example.yaml`, so the replacer rewrote nothing, the
   * suite passed on unmutated source, and the case reported GREEN-as-expected
   * while proving that the file still contains a string it no longer contains.
   *
   * **It hid because this comment used to sit between `file:` and `find:`.**
   * `mutation-anchors.test.ts` could not see a case shaped that way, so the one
   * guard that exists to catch a dead anchor skipped the two cases that had
   * one. The prose moves above the object for that reason, which is the shape
   * every other case in this battery already uses.
   *
   * The three-line form is kept rather than reduced to the `tools:` line alone.
   * That line is unique in both configs today — `triage` no longer copies the
   * reviewer's grant byte for byte — but it was not unique when RV15 was first
   * anchored, and re-narrowing to it would reintroduce the two-match hazard the
   * moment another role's grant converges again.
   */
  {
    id: "RV15",
    what: "GRANT: bash is granted to the reviewer in the TRACKED config",
    file: EXAMPLE,
    find: "    tools: [read, grep, find, ls, submit_report]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    replace: "    tools: [read, grep, find, ls, submit_report, bash]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    expect: "red",
  },
  // ── The file/summary split, added 2026-09-05 with the contract it measures. ─
  {
    id: "RV21",
    what: "SPLIT: the envelope may hold the whole review again — the pre-fix contract",
    file: REVIEWER,
    find: "with a SHORT `notes`: one line",
    replace: "with the whole review in `notes`: one line",
    expect: "red",
  },
  /**
   * RE-POINTED FROM THE CLAIM TO THE ROUTE, 2026-09-10 (task 8.1).
   *
   * This mutated *"And DECLARE the file in the envelope's `artifacts` array"*,
   * an instruction the reviewer no longer carries out: `composeEnvelope` appends
   * every `report` file to `artifacts` itself. What remains mutable is the
   * sentence that says so — a document that instead told the reviewer to declare
   * the file by hand sends it back to writing a claim `artifactMissingProblem`
   * refuses, or out by a route with nothing appending anything.
   */
  {
    id: "RV22",
    what: "SPLIT: the declaration is handed back to the model, which no longer writes one",
    file: REVIEWER,
    find: "`submit_report` declares it for you",
    replace: "declare it yourself in the envelope's `artifacts` array",
    expect: "red",
  },
  /**
   * THE CAPS DRIFT FROM THE CODE. The document's numbers are asserted against
   * `MAX_REPLY_ARTIFACT_BYTES` and `MAX_REPLY_INLINE_BYTES` rather than as
   * string literals, so a doc that states a cap the fleet does not enforce
   * reddens. The previous probe hard-coded "64 KiB", which pinned the prose to
   * itself and would have stayed green through exactly this edit.
   *
   * `MAX_TEXT` was the third number here and came out with RV24 on 2026-09-10:
   * the binding ceiling on a reviewer's `notes` is `SUBMIT_REPORT_PARAMETERS`'
   * 20000, checked in front of the model, not the envelope schema's 65536
   * checked on the host. These two are still the host's, still applied where the
   * model cannot see them, and still the only numbers in the section.
   */
  /**
   * RV23 SURVIVED ON ITS FIRST RUN, and the probe was the defect.
   *
   * `reviewer-role.test.ts` asserted `toContain("64 KiB")` over the whole
   * section. The section says the number TWICE — once as the cap and once as
   * *"64 KiB of prose is roughly ten thousand words"* — so mutating the cap to
   * 32 KiB left the second occurrence satisfying the match and the suite stayed
   * green. A document stating a limit the fleet does not enforce is precisely
   * what that probe exists to refuse, and it could not see one. The probe now
   * pins the number inside the clause that states the cap; RV23b is the same
   * mutation on the other cap, because one fix that only reached one of the two
   * numbers would look identical from here.
   */
  {
    id: "RV23",
    what: "CAPS: the document states a per-file cap the relay does not enforce",
    file: REVIEWER,
    find: "cap: 64 KiB per file",
    replace: "cap: 32 KiB per file",
    expect: "red",
  },
  {
    id: "RV23b",
    what: "CAPS: the per-reply cap drifts instead of the per-file one",
    file: REVIEWER,
    find: "and 256 KiB across all of them",
    replace: "and 512 KiB across all of them",
    expect: "red",
  },
  /**
   * RELABELLED 2026-09-11. The anchor still matches 1x and the case still
   * reddens; what had gone wrong is the `what:`, which is the harder half to
   * notice because nothing goes red for it.
   *
   * It read *"the collator's brief stops REQUIRING the artifact declaration"*.
   * Until `a1ae886` that was true: `roles/collator.md` ordered the collator to
   * tell each reviewer *"to declare that file in its envelope's `artifacts`
   * array"*, and this mutation removed the order. `a1ae886` INVERTED that
   * sentence — the brief now says **"Do NOT tell it to declare that file in its
   * envelope's `artifacts` array"** — so the identical anchor moved into the
   * prohibition, and this mutation now removes a PROHIBITION. Measured: it
   * reddens on *"the collator still orders the hand-declaration
   * `roles/reviewer.md` tells reviewers not to make"*, the probe `a1ae886`
   * flipped to assert the prohibition positively. Same red, opposite meaning.
   *
   * ## THIS IS THE SECOND TIME A TWIN WAS RE-POINTED ALONE
   *
   * RV25 is the collator-side twin of RV22, and that pairing is the whole point
   * of both: two role documents that must say the same thing, with one case per
   * end. Task 8.1 re-pointed RV22 from the claim to the route on the reviewer's
   * side and did not reach RV25 — and the console then ran with two prompts
   * issuing opposite instructions about the same field for a full round, with
   * both ends green, because each probe only ever read its own end. That is the
   * contradiction `a1ae886` cleaned up, and this stale label is the same miss
   * wearing its other face: a document changed, its twin's case not re-read.
   *
   * **A battery has now been bitten by this shape twice.** When one end of a
   * pinned pair is re-pointed, the other end's case is part of the change —
   * re-read its `find:` AND its `what:`, because the anchor can keep matching
   * through an inversion that makes the label a lie.
   */
  {
    id: "RV25",
    what: "SPLIT: the collator's brief stops FORBIDDING the artifact declaration",
    file: ROLE,
    find: "to declare that file in its envelope's `artifacts` array",
    replace: "and nothing more",
    expect: "red",
  },
  {
    id: "RV26",
    what: "SPLIT: the collator's copy promises the file survives a broken envelope",
    file: ROLE,
    find: "has no reply published for it at all",
    replace: "still reaches you through its artifacts",
    expect: "red",
  },
  /**
   * RV27 AND RV28 ARE GONE, 2026-09-10 (task 8.1), and this is the record of
   * what went with them.
   *
   * They mutated the worked `json` envelope in `roles/reviewer.md` — the part of
   * a prompt a model copies most literally — and `reviewer-role.test.ts` parsed
   * that block through `ResultEnvelopeSchema` rather than eyeballing it. Phase C
   * deleted the block: a reviewer holds no `write`, `submit_report` composes the
   * envelope, and `schema`/`task_id`/`epoch`/`worker` are ABSENT from
   * `SUBMIT_REPORT_PARAMETERS` under `additionalProperties: false`, so a model
   * copying the example earns a validation error.
   *
   * **The coverage is not replaced.** No probe in this battery now mutates a
   * worked example in that file, because it has none. The equivalent for the new
   * contract is an example `submit_report` ARGUMENT checked against
   * `SUBMIT_REPORT_PARAMETERS`; writing one is an addition rather than a
   * deletion and was outside task 8.1.
   */
  // ── Turn one ENDS: the polling defect, measured on run 5. ────────────────
  /**
   * The collator wrote both files correctly and then spent its last twelve tool
   * calls looking for something to do. The document already forbade polling; what
   * it lacked was a statement of what DONE looks like, what happens next, and why
   * looking is uninformative rather than merely disallowed. These three mutate
   * each of those in turn, because a document that keeps only one of them is the
   * document that produced the defect.
   */
  {
    id: "R11",
    what: "TURN ONE: the envelope stops being named as the turn's last tool call",
    file: ROLE,
    find: "**4. `submit_report` is the LAST TOOL CALL of turn one, and it ends the turn for you.**",
    replace: "**4. Then stop.**",
    expect: "red",
  },
  {
    id: "R12",
    what: "TURN ONE: the collator is no longer told the second turn arrives as a prompt",
    file: ROLE,
    find: "turn two arrives as a NEW PROMPT carrying a new brief and a\nnew task id",
    replace: "turn two happens later",
    expect: "red",
  },
  {
    id: "R13",
    what: "TURN ONE: polling is forbidden but no longer shown to be pointless",
    file: ROLE,
    find: "`/replies` during turn one is empty, and empty is the\nCORRECT state",
    replace: "Do not look at `/replies`",
    expect: "red",
  },
  // ── The language seat's angle is the TARGET's language. ──────────────────
  /**
   * `rev-lang-1` ran a TypeScript-named angle against a Python target for the
   * whole of this console's life so far. Both halves are mutated: the aspect
   * file that carries the angle, and the WORKER CONFIG that chooses the file and
   * the image. A fix to either alone leaves the console wrong.
   */
  /**
   * R14 SURVIVED ON ITS FIRST RUN, and the probe was the defect again — this
   * time in the arm that matters most.
   *
   * The probe tested `\bTypeScript\b` CASE-SENSITIVELY against the angle
   * statement. Headings in that file are upper case, so restoring the literal
   * old heading — `THE TYPESCRIPT AND JAVASCRIPT LANGUAGE SPECIALIST` — was
   * invisible to it. The probe was blind to the exact defect it was written for,
   * in the exact form that defect actually had on disk for the life of this
   * console.
   *
   * Three arms now, because one is not enough to tell a fixed probe from a lucky
   * one: R14 is the historical heading verbatim, R14b is mixed case (the form
   * the broken probe DID catch, so a regression that only restored
   * case-sensitivity still reddens here), and R14c names a different language
   * entirely — the mistake this seat would make NEXT, once someone assumes the
   * Python target is permanent.
   */
  {
    id: "R14",
    what: "ANGLE: the language seat pre-commits to a language again (UPPER CASE)",
    file: LANGFILE,
    find: "## Your angle: THE IMPLEMENTATION LANGUAGE OF THE REPOSITORY IN FRONT OF YOU",
    replace: "## Your angle: THE TYPESCRIPT AND JAVASCRIPT LANGUAGE SPECIALIST",
    expect: "red",
  },
  {
    id: "R14b",
    what: "ANGLE: the seat pre-commits in MIXED case, the form the broken probe DID catch",
    file: LANGFILE,
    find: "## Your angle: THE IMPLEMENTATION LANGUAGE OF THE REPOSITORY IN FRONT OF YOU",
    replace: "## Your angle: the TypeScript language specialist",
    expect: "red",
  },
  {
    id: "R14c",
    what: "ANGLE: the seat pre-commits to Python — the mistake this seat would make NEXT",
    file: LANGFILE,
    find: "## Your angle: THE IMPLEMENTATION LANGUAGE OF THE REPOSITORY IN FRONT OF YOU",
    replace: "## Your angle: THE PYTHON LANGUAGE SPECIALIST",
    expect: "red",
  },
  {
    id: "R15",
    what: "ANGLE: the seat is no longer told to settle the language from evidence",
    file: LANGFILE,
    find: "first thing you do is settle it",
    replace: "first thing to bear in mind is the language",
    expect: "red",
  },
  {
    id: "R16",
    what: "ANGLE: the seat stops having to say which language it settled on",
    file: LANGFILE,
    find: "**Say which language\nyou settled on in the first line of your review**",
    replace: "**Get on with it**",
    expect: "red",
  },
  {
    id: "R17",
    what: "ANGLE: the angle collapses to 'consider the language' with no defect classes",
    file: LANGFILE,
    find: "### 3. Errors that become values instead of stops",
    replace: "### 3. Anything else worth saying",
    expect: "red",
  },
  /**
   * THE CONFIG HALF, and it is mutated in `fleet.yaml` rather than
   * `fleet.example.yaml` because the example declares none of this console's
   * seats — `review-plan.test.ts` says so in its own header. That makes this an
   * UNTRACKED target: the anchors guard skips it by design, and the battery is
   * the only thing that checks it. Recorded here so the gap is named rather than
   * discovered.
   */
  {
    id: "R18",
    what: "CONFIG: the language seat is pointed back at the TypeScript aspect file",
    file: FLEET,
    find: "     append_system_prompt_file: ./roles/review/implementation-language.md}",
    replace: "     append_system_prompt_file: ./roles/review/typescript-language.md}",
    expect: "red",
  },
  {
    id: "R19",
    what: "CONFIG: `toolchain: node` returns to the seat whose job is not to assume a language",
    file: FLEET,
    find: "     model: ollama-cloud/glm-5.3,\n     append_system_prompt_file:",
    replace: "     model: ollama-cloud/glm-5.3, toolchain: node,\n     append_system_prompt_file:",
    expect: "red",
  },
  {
    id: "R20",
    what: "SIBLINGS: the other aspect files still describe seat three as a TypeScript seat",
    file: XFILE,
    find: "architecture/security and the implementation language.",
    replace: "architecture/security and TypeScript/JavaScript specifics.",
    expect: "red",
  },
  // ── `file` is a path, not a sentence — the census shape rule, in the brief. ─
  /**
   * The grader stopped counting a prose `file` as located. The refusal teaches a
   * collator that after the turn is spent; the briefing teaches it before. R21
   * removes the rule, and R22 makes the document's worked example DISAGREE with
   * the grader — which is the failure that matters, because a document offering
   * an example the census refuses is worse than one that says nothing.
   */
  {
    id: "R21",
    what: "LOCATION: the brief stops saying `file` must be a path, not prose",
    file: ROLE,
    find: "- **`file` MUST NAME A PATH, and a sentence in that field costs the finding its location.**",
    replace: "- **Fill in `file` as best you can.**",
    expect: "red",
  },
  {
    id: "R22",
    what: "LOCATION: the document's uncounted example is one the census actually counts",
    file: ROLE,
    find: "`the error handling could be tightened` does not",
    replace: "`src/relay.ts` does not",
    expect: "red",
  },
  {
    id: "R23",
    what: "LOCATION: prose is no longer directed to `statement`, so it stays in `file`",
    file: ROLE,
    find: "**Prose belongs in `statement`**",
    replace: "Prose is fine anywhere",
    expect: "red",
  },
  // ── G1: the denominator, checked against config. ─────────────────────────
  {
    id: "G1",
    what: "DENOMINATOR: a lens row may be OMITTED — a 2/3 review records a clean 2/2",
    file: SRC,
    find: "    if (got === undefined) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "G2",
    what: "DENOMINATOR: an extra row may pad the table with a reader that does not exist",
    file: SRC,
    find: "    if (!expected.has(worker)) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "G3",
    what: "DENOMINATOR: a row may carry another lens's aspect",
    file: SRC,
    find: "    if (got !== aspect) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "G4",
    what: "DENOMINATOR: the table is checked as a SUBSET rather than as a set equality",
    file: SRC,
    find: "  for (const worker of declared.keys()) {",
    replace: "  for (const worker of [] as string[]) {",
    expect: "red",
  },
  // ── G5: the structural binding, and its ordering. ────────────────────────
  {
    id: "G5",
    what: "BINDING: the document is trusted about which task it belongs to",
    file: SRC,
    find: "  if (collation.task_id !== ctx.taskId) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "G6",
    what: "BINDING: the seats come from the DOCUMENT rather than from config",
    file: SRC,
    find: "  const seats = ctx.aspects ?? REVIEW_CONSOLE_ASPECTS;",
    replace: "  const seats = collation.lenses.map((l) => ({ worker: l.worker, aspect: l.aspect }));",
    expect: "red",
  },
  {
    id: "G7",
    what: "BINDING: the derivation check is put where the structural one belongs",
    file: SRC,
    find: "  if (collation.task_id !== ctx.taskId) {",
    replace: "  if (collation.task_id !== collationTaskId(collation.parent_task_id)) {",
    expect: "red",
  },
  // ── X3/X4: the survivors a review found. ─────────────────────────────────
  {
    id: "P2",
    what: "CAP: the byte cap counts UTF-16 units, admitting 2x the bytes",
    file: SRC,
    find: '  if (Buffer.byteLength(bytes, "utf8") > MAX_COLLATION_BYTES) {',
    replace: "  if (bytes.length > MAX_COLLATION_BYTES) {",
    expect: "red",
  },
  {
    id: "P3",
    what: "DISPUTE: the not-a-lens arm is removed, so the refusal names the wrong rule",
    file: SRC,
    find: '        if (!seenWorkers.has(w)) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    replace: '        if (false) {\n          ctx.addIssue({\n            code: "custom",\n            path: ["findings", i, "disputed_by"],',
    expect: "red",
  },
  {
    id: "P4",
    what: "ID BOUND: a task id may be 6400 characters at the schema",
    file: SRC,
    find: "    .max(MAX_RELAY_TASK_ID_CHARS, {",
    replace: "    .max(6400, {",
    expect: "red",
  },
  // ── H5: the cap may only ever lower. ─────────────────────────────────────
  {
    id: "H5",
    what: "LOWER-ONLY: the rank comparison is dropped — a failed review rescues itself",
    file: SRC,
    find: "  if (b >= a) return { status: current, reason: null };",
    replace: "  if (false) return { status: current, reason: null };",
    expect: "red",
  },
  {
    id: "H6",
    what: "NO-OP: the explicit out-of-lattice guard, which `b >= a` already covers",
    file: SRC,
    find: "  if (a < 0 || b < 0) return { status: current, reason: null };",
    replace: "  if (b < 0) return { status: current, reason: null };",
    expect: "green",
  },
  {
    id: "H7",
    what: "LOWER-ONLY: the cap ignores the ceiling's no-op arm and always applies",
    file: SRC,
    find: "  if (ceiling.reason === null) return { status: current, reason: null };",
    replace: "  if (false) return { status: current, reason: null };",
    expect: "red",
  },
  {
    id: "H8",
    what: "LOCATION ARM: a relative path is reported as the arm that can fail",
    file: SRC,
    find: '  return file.startsWith("/") ? "workdir_absolute" : "relative";',
    replace: '  return "workdir_absolute";',
    expect: "red",
  },
  // ── The grant, and the two halves independently pinned. ──────────────────
  /**
   * RV16 AND RV17 CHANGED THEIR MUTATION, not just their anchor — 2026-09-11.
   *
   * Both used to remove `write` from the reviewer's grant, on the premise that a
   * reviewer without it *"cannot report"*. **Task 7.1 already removed `write`**,
   * so that edit is now a no-op on a role that does not hold it: the string is
   * absent, nothing is rewritten, and a case that cannot change the tree cannot
   * redden. The premise died with the grant, and the anchor died with it.
   *
   * The live mutation is REMOVING `submit_report`, and it is the same claim
   * pointed at the tool that took `write`'s place. `config/schema.ts` makes
   * {write, edit, bash} the writer set and this role holds none of them; nothing
   * host-side writes `result.json` (`harvest/outbox.ts` only reads it). So
   * `submit_report` is the only verb that can put an envelope anywhere, and a
   * reviewer stripped of it is state 1 of `review-plan.test.ts`'s three-state
   * history exactly: every lens missing, `relay.ts` answering `not_collated`, no
   * collation dispatched, and the fan-out task settling `success` with the review
   * showing green. That is the worst signature in this console's history, which
   * is why it is the one worth pinning.
   *
   * **The two halves are graded by DIFFERENT suites, and that is the point of
   * keeping both.** RV16 mutates the TRACKED `fleet.example.yaml`, which
   * `reviewer-role.test.ts` parses with `grantedTools` and CI therefore grades.
   * RV17 mutates the operator's gitignored `fleet.yaml`, which only
   * `review-plan.test.ts`'s `describe.skipIf(!HAVE_CONFIG)` block reads — it
   * resolves the three `rev-*` seats through `resolveWorker`, and none of them
   * declares its own `tools:`, so the role's grant is what they inherit. That
   * block SKIPS on a machine without the file, which is why RV17 was invisible
   * rather than merely dead: `atHead` returns null for an untracked target and
   * the anchors guard skips it instead of reporting it. The battery copies the
   * operator's `fleet.yaml` into the worktree, so it runs here.
   */
  {
    id: "RV16",
    what: "GRANT: `submit_report` is removed from the TRACKED config — the role cannot report",
    file: EXAMPLE,
    find: "    tools: [read, grep, find, ls, submit_report]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    replace: "    tools: [read, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    expect: "red",
  },
  {
    id: "RV17",
    what: "GRANT: `submit_report` is removed from the LIVE config — the role cannot report",
    file: FLEET,
    find: "    tools: [read, grep, find, ls, submit_report]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    replace: "    tools: [read, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    expect: "red",
  },
  {
    id: "RV18",
    what: "PATHS: a fresh invented path under a real mount (the first-segment hole)",
    file: REVIEWER,
    find: "**Rank by consequence.**",
    replace: "The task envelope is at `/policy/envelope.json`.\n\n**Rank by consequence.**",
    expect: "red",
  },
  {
    id: "RV19",
    what: "CAPABILITY: a fresh false claim in wording no denylist held",
    file: REVIEWER,
    find: "**Give the failing case.**",
    replace: "Start from the diff and work outwards. **Give the failing case.**",
    expect: "red",
  },
  {
    id: "RV20",
    what: "PATHS: an invented path in the COLLATOR document, likewise",
    file: ROLE,
    find: "## WHAT YOU DELIVER ON TURN TWO",
    replace: "The reports also live at `/outbox/reports-v2/<child-task-id>.json`.\n\n## WHAT YOU DELIVER ON TURN TWO",
    expect: "red",
  },
  // ── Negative controls: must stay green or the battery reddens on anything. ─
  {
    id: "NC1",
    what: "NEGATIVE CONTROL: rename the local `reported` set in the cross-field pass",
    file: SRC,
    find: "    const reported = new Set(v.lenses.filter((l) => l.reported).map((l) => l.worker));\n    if (reported.size === 0) {",
    replace: "    const spoke = new Set(v.lenses.filter((l) => l.reported).map((l) => l.worker));\n    if (spoke.size === 0) {",
    expect: "green",
    also: [
      { find: "        } else if (!reported.has(w)) {", replace: "        } else if (!spoke.has(w)) {" },
      { find: "        } else if (!reported.has(w)) {", replace: "        } else if (!spoke.has(w)) {" },
    ],
  },
  {
    id: "NC2",
    what: "NEGATIVE CONTROL: rename the issue renderer",
    file: SRC,
    find: "function firstIssue(err: z.ZodError): string {",
    replace: "function describeIssue(err: z.ZodError): string {",
    expect: "green",
    also: [{ find: "reason: firstIssue(result.error)", replace: "reason: describeIssue(result.error)" }],
  },
  /**
   * CONTROLS FOR THE TWO PROBES THAT WERE JUST TIGHTENED, and the reason they
   * are worth their runtime.
   *
   * RV23's and R14's fixes both made a probe match MORE narrowly — one pinned a
   * number to the clause that states it, the other went case-insensitive. The
   * failure mode of that kind of repair is over-fitting: a probe so tight that
   * ordinary rewording reddens it gets loosened again by the next person, and
   * the coverage is lost for good. These two reword prose in exactly the
   * sections those probes guard, and must stay GREEN.
   */
  {
    id: "NC3",
    what: "NEGATIVE CONTROL: reword the angle's closing advice, changing nothing checkable",
    file: LANGFILE,
    find: "**Prefer the demonstrable.**",
    replace: "**Favour the demonstrable.**",
    expect: "green",
  },
  {
    id: "NC4",
    what: "NEGATIVE CONTROL: reword prose in the caps section, leaving every number alone",
    file: REVIEWER,
    find: "For scale, 64 KiB of prose is roughly ten thousand words.",
    replace: "That is a great deal of prose.",
    expect: "green",
  },
  // ── Semantic no-ops: the mutation genuinely changes nothing. ─────────────
  {
    id: "NO1",
    what: "NO-OP: the zero-findings test spelled `< 1` instead of `=== 0`",
    file: SRC,
    find: "      if (read.collation.findings.length === 0) {",
    replace: "      if (read.collation.findings.length < 1) {",
    expect: "green",
  },
  /**
   * Not a no-op, and it was filed as one on the first pass. Renaming the key
   * removes the NAMED refusal and leaves `.strict()`'s generic "unrecognized
   * key" behind — a document is still rejected, so it reads like a no-op, and
   * the reason a reader would act on is gone. It sits with the reds because the
   * distinction between "refused" and "refused with the argument" is the entire
   * value of `notHere` over `.strict()`.
   */
  {
    id: "C38",
    what: "D8: `verified` loses its named refusal and falls to `.strict()`'s generic one",
    file: SRC,
    find: "    verified: notHere(",
    replace: "    zzzverified: notHere(",
    expect: "red",
  },
  {
    id: "NO2",
    what: "NO-OP: the `not_json` refusal's wording changes",
    file: SRC,
    find: "      reason: `the collation artifact is not JSON: ${(err as Error).message}`,",
    replace: "      reason: `the collation artifact does not parse as JSON: ${(err as Error).message}`,",
    expect: "green",
  },
  // ── Expected GREEN because nothing reaches them. Declared, not counted. ───
  {
    id: "U1",
    what: "UNCOVERED: the lens `note` loses its length bound",
    file: SRC,
    find: "    note: z.string().max(MAX_COLLATION_STATEMENT).optional(),",
    replace: "    note: z.string().optional(),",
    expect: "green",
  },
  {
    id: "U2",
    what: "UNCOVERED: the findings array loses its cap",
    file: SRC,
    find: "    findings: z.array(CollationFindingSchema).max(MAX_COLLATION_FINDINGS),",
    replace: "    findings: z.array(CollationFindingSchema),",
    expect: "green",
  },
  {
    id: "U3",
    what: "UNCOVERED: the lens array loses its cap",
    file: SRC,
    find: "      .max(MAX_COLLATION_LENSES),",
    replace: "      .max(9999),",
    expect: "green",
  },
  {
    id: "U5",
    what: "UNCOVERED: the statement loses its length bound",
    file: SRC,
    find: "      .max(MAX_COLLATION_STATEMENT),",
    replace: "      .max(99999999),",
    expect: "green",
  },
  {
    id: "U6",
    what: "UNCOVERED: a refusal loses the field path prefix that says WHERE",
    file: SRC,
    find: '  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";\n  return `${where}${issue.message}`;',
    replace: "  return issue.message;",
    expect: "green",
  },
  {
    id: "U7",
    what: "UNCOVERED: disputed_by loses its cap",
    file: SRC,
    find: "    disputed_by: z.array(workerId).max(MAX_COLLATION_LENSES).default([]),",
    replace: "    disputed_by: z.array(workerId).default([]),",
    expect: "green",
  },
  /**
   * The reviewer role's JUDGEMENT content, which is most of it and is not
   * decidable. Recorded as a mutation so the boundary is measured rather than
   * asserted: what these probes hold is the document's CLAIMS ABOUT THE SYSTEM,
   * and everything else in it is guidance a person has to read.
   */
  {
    id: "U8",
    what: "UNCOVERED: the whole `Give the failing case` instruction is deleted",
    file: REVIEWER,
    find: '**Give the failing case.** "This could break with concurrent access" is a guess.',
    replace: "**Guess freely.**",
    expect: "green",
  },
  {
    id: "U9",
    what: "UNCOVERED: the ranking instruction is inverted",
    file: REVIEWER,
    find: "A correctness bug that silently produces a wrong answer outranks a\nmissing test",
    replace: "A naming preference outranks a\ncorrectness bug",
    expect: "green",
  },
];

function restore(): void {
  for (const [path, body] of Object.entries(PRISTINE)) {
    writeFileSync(path, body);
    if (sha(readFileSync(path, "utf8")) !== sha(body)) throw new Error(`RESTORE FAILED: ${path}`);
  }
}

async function runTests(): Promise<"pass" | "fail" | "TIMEOUT"> {
  return await new Promise((resolve) => {
    const child = spawn("bun", ["test", ...TESTFILES], { cwd: W });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("TIMEOUT");
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "pass" : "fail");
    });
  });
}

let findings = 0;
restore();

/**
 * The BASELINE is measured rather than assumed. A battery whose suite is already
 * red reports every mutation as "caught", which is the most flattering possible
 * failure and the one nobody notices.
 */
const baseline = await runTests();
process.stdout.write(`BASELINE | unmutated worktree | ${baseline}\n\n`);
if (baseline !== "pass") {
  throw new Error("the unmutated suite is not green; every result below would be meaningless");
}

for (const m of MUTATIONS) {
  restore();
  const src = readFileSync(m.file, "utf8");
  const count = src.split(m.find).length - 1;
  if (count < 1) {
    process.stdout.write(`${m.id} | ${m.what} | PRIMARY ANCHOR MATCHED 0x — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
  /*
   * A multi-match anchor is applied to the FIRST occurrence only where the
   * mutation says so via `also` (the two `reported.has` arms are byte-identical
   * apart from the path they name), and is otherwise a defect in the anchor. The
   * distinction is explicit rather than inferred: an anchor that silently
   * mutated two sites would report one mutation's result for two changes.
   */
  if (count !== 1 && m.also === undefined) {
    process.stdout.write(`${m.id} | ${m.what} | PRIMARY ANCHOR MATCHED ${count}x — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
  writeFileSync(m.file, src.replace(m.find, m.replace));
  let bad = "";
  for (const extra of m.also ?? []) {
    const f = extra.file ?? m.file;
    const cur = readFileSync(f, "utf8");
    if (!cur.includes(extra.find)) {
      bad = "secondary anchor matched 0x";
      break;
    }
    writeFileSync(f, cur.replace(extra.find, extra.replace));
  }
  if (bad !== "") {
    process.stdout.write(`${m.id} | ${m.what} | ${bad} — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
  const outcome = await runTests();
  restore();
  const reddened = outcome !== "pass";
  const ok = m.expect === "red" ? reddened : !reddened;
  if (!ok) findings += 1;
  process.stdout.write(
    `${m.id} | ${m.what} | expected ${m.expect} | got ${outcome} | ${ok ? "as expected" : "*** UNEXPECTED ***"}\n`,
  );
}

restore();
const allOk = Object.entries(PRISTINE).every(([p, b]) => sha(readFileSync(p, "utf8")) === sha(b));
process.stdout.write(`\n=== ALL FILES RESTORED OK: ${allOk}\n=== UNEXPECTED RESULTS: ${findings}\n`);
