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
  // reworded by anyone tightening prose; a destination path, a declaration
  // requirement and the sentence stating why the two channels fail differently
  // are things a reviewer executes, and changing any of them changes what the
  // console does.
  {
    id: "RV1",
    what: "REVIEWER: the review's destination is unnamed — 'file it somewhere'",
    file: REVIEWER,
    find: "1. **`/outbox/<task-id>/files/review.md` — the whole review.**",
    replace: "1. **The whole review, filed wherever suits you.**",
    expect: "red",
  },
  {
    id: "RV2",
    what: "REVIEWER: the two caps stop failing differently — the reason for the split",
    file: REVIEWER,
    find: "**Same ceiling, opposite failure:**",
    replace: "**Both are capped:**",
    expect: "red",
  },
  {
    id: "RV3",
    what: "REVIEWER: the collator's copy of the split instruction is dropped",
    file: ROLE,
    find: "**Tell each reviewer to file its long review at `/outbox/<task-id>/files/review.md` — its own\ntask id, not yours — to declare that file in its envelope's `artifacts` array, and to keep the\n`notes` FIELD of `/outbox/<task-id>/result.json` to a short summary.**",
    replace: "**Tell each reviewer to write a thorough review.**",
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
   */
  {
    id: "RV4",
    what: "REVIEWER: the file is promised to rescue a broken envelope — the plausible lie",
    file: REVIEWER,
    find: "**It does\nnot rescue the lens.**",
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
  {
    id: "RV15",
    what: "GRANT: bash is granted to the reviewer in the TRACKED config",
    file: EXAMPLE,
    /*
     * ANCHORED THROUGH `./roles/reviewer.md` RATHER THAN ON THE `tools:` LINE
     * ALONE, which is RV17's spelling arriving in the tracked file for the same
     * reason it was needed in the live one. The triage console's `triage` role
     * carries a byte-identical grant by deliberate copy, so the bare line now
     * matches twice and a two-match anchor mutates whichever the replacer
     * reaches first. `mutation-anchors.test.ts` caught it the day the role
     * landed; this is the re-anchor it asked for.
     */
    find: "    tools: [read, write, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    replace: "    tools: [read, write, grep, find, ls, bash]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
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
  {
    id: "RV22",
    what: "SPLIT: the review file need not be declared, so the harvest contradicts it",
    file: REVIEWER,
    find: "**And DECLARE the file in the envelope's `artifacts` array**",
    replace: "**The file needs no further mention**",
    expect: "red",
  },
  /**
   * THE CAPS DRIFT FROM THE CODE. The document's numbers are asserted against
   * `MAX_REPLY_ARTIFACT_BYTES`, `MAX_REPLY_INLINE_BYTES` and `MAX_TEXT` rather
   * than as string literals, so a doc that states a cap the fleet does not
   * enforce reddens. The previous probe hard-coded "64 KiB", which pinned the
   * prose to itself and would have stayed green through exactly this edit.
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
  {
    id: "RV24",
    what: "CAPS: the `notes` ceiling is dropped, so the two channels look unbounded",
    file: REVIEWER,
    find: "at the same 65536 bytes",
    replace: "at some size or other",
    expect: "red",
  },
  {
    id: "RV25",
    what: "SPLIT: the collator's brief stops requiring the artifact declaration",
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
   * THE WORKED ENVELOPE, which is the part of a prompt a model copies most
   * literally. An example that the real schema refuses teaches the exact shape
   * the harvester throws away — and this one is now parsed against
   * `ResultEnvelopeSchema` rather than eyeballed.
   */
  {
    id: "RV27",
    what: "EXAMPLE: the worked envelope stops claiming the review file",
    file: REVIEWER,
    find: '  "artifacts": [{"kind": "file", "path": "/outbox/<task-id>/files/review.md"}],\n',
    replace: "",
    expect: "red",
  },
  {
    id: "RV28",
    what: "EXAMPLE: the worked envelope carries a wire tag the schema refuses",
    file: REVIEWER,
    find: '  "schema": "pifleet.result/v1",',
    replace: '  "schema": "pifleet.review/v1",',
    expect: "red",
  },
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
  {
    id: "RV16",
    what: "GRANT: `write` is removed from the TRACKED config — the role cannot report",
    file: EXAMPLE,
    // Re-anchored with RV15, and for that entry's reason: `triage` copies this
    // grant byte for byte, so the bare `tools:` line is no longer unique here.
    find: "    tools: [read, write, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    replace: "    tools: [read, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
    expect: "red",
  },
  {
    id: "RV17",
    what: "GRANT: the live config diverges from the tracked one",
    file: FLEET,
    find: "    tools: [read, write, grep, find, ls]\n    skills: [pifleet-worker]\n    append_system_prompt_file: ./roles/reviewer.md",
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
