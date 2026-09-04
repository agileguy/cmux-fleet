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
/** Not tracked by git; copied into the worktree and restored like the rest. */
const FLEET = `${W}/fleet.yaml`;
const TESTFILES = [
  "test/unit/collation.test.ts",
  "test/unit/collator-role.test.ts",
  "test/unit/reviewer-role.test.ts",
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
  [FLEET]: readFileSync(FLEET, "utf8"),
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
    find: "  if (!spellable(taskId)) {",
    replace: "  if (false) {",
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
    find: "**2. Write `/outbox/<task-id>/dispatch-request.json`**",
    replace: "**2. Write `/outbox/fanout.json`**",
    expect: "red",
  },
  {
    id: "R2",
    what: "ROLE: turn one is told to claim `partial` (the pre-§6.6 reading)",
    file: ROLE,
    find: '**3. Write your result envelope with `status: "success"` and end your turn.**',
    replace: '**3. Write your result envelope with `status: "partial"` and end your turn.**',
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
    find: "— for a task `T` they are `T-arch`, `T-context`, `T-lang` and `T-collate` —",
    replace: "— for a task `T` they are `T-arch`, `T-context` and `T-lang` —",
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
  {
    id: "RV1",
    what: "REVIEWER: the notes instruction is deleted from the reviewer's own role",
    file: REVIEWER,
    find: "## PUT YOUR WHOLE REVIEW IN THE ENVELOPE'S `notes`",
    replace: "## On writing it up",
    expect: "red",
  },
  {
    id: "RV2",
    what: "REVIEWER: the WHY is dropped — the instruction becomes a preference",
    file: REVIEWER,
    find: "path, size and checksum,\nand **not the contents**.",
    replace: "path, size and checksum.",
    expect: "red",
  },
  {
    id: "RV3",
    what: "REVIEWER: the collator's copy of the instruction is dropped (the braces)",
    file: ROLE,
    find: "**Tell each reviewer to put its whole review in its result envelope's `notes`.**",
    replace: "**Tell each reviewer to write a thorough review.**",
    expect: "red",
  },
  {
    id: "RV4",
    what: "REVIEWER: the mitigation stops being labelled a mitigation",
    file: REVIEWER,
    find: "**This is a workaround, and it is written here so it is not mistaken for the design.**",
    replace: "**This is how the console works.**",
    expect: "red",
  },
  {
    id: "RV5",
    what: "REVIEWER: the design note stops naming a recommendation",
    file: SRC,
    find: " * **Take A.**",
    replace: " * **Either would do.**",
    expect: "red",
  },
  {
    id: "RV6",
    what: "REVIEWER: the design note drops the recommendation's cost",
    file: SRC,
    find: " * **A's cost, stated rather than buried:**",
    replace: " * **A is free:**",
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
    find: "**Quote file and line.**",
    replace: "Read `/replies/<child-task-id>.json` for what the others found. **Quote file and line.**",
    expect: "red",
  },
  {
    id: "RV13",
    what: "REVIEWER: the location's spelling guidance is dropped",
    file: REVIEWER,
    find: "Give the path\nrepo-relative and the line as a bare number",
    replace: "Give the location",
    expect: "red",
  },
  {
    id: "RV14",
    what: "REVIEWER: the collator loses its instruction for a `path:line` it is handed",
    file: ROLE,
    find: "If a reviewer gave you\n  `src/foo.ts:12`, split it: the number belongs in `line`.",
    replace: "Split any suffix off the path.",
    expect: "red",
  },
  {
    id: "RV15",
    what: "REVIEWER: bash is granted to the reviewer role in config",
    file: FLEET,
    find: "    tools: [read, grep, find, ls]        # NO bash — see §12.1",
    replace: "    tools: [read, grep, find, ls, bash]  # NO bash — see §12.1",
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
    id: "U4",
    what: "UNCOVERED: a task id may be 6400 characters",
    file: SRC,
    find: "    .max(64, { error: `${label} is longer than 64 characters — it names a path segment` })",
    replace: "    .max(6400, { error: `${label} is longer than 64 characters — it names a path segment` })",
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
