/**
 * `skills/observer-vm-ops/SKILL.md` pinned to `scripts/observe/vm-forced-command`, the credential's
 * only enforcement (SRD-OBSERVER-ROLES §6.2-6.4), and to the two other places that restate the same
 * verb set in prose: `roles/observer-vm.md`'s role prompt and `docker/observe-vm`'s `--help` usage
 * text. Every file is read as text, in the style of `docs-currency.test.ts` and
 * `observer-docker-docs-currency.test.ts`; `vm-forced-command` is `sh` and cannot be imported. Every
 * extraction below proves it found something before it is used, so a moved heading or a rewritten
 * sentence fails loudly instead of letting a comparison pass on an empty set — that discipline runs
 * through every section below, not just one of them, so it is stated here once rather than numbered.
 *
 *  1. the skill's verb table, `roles/observer-vm.md`'s verb list and `docker/observe-vm`'s usage
 *     text each equal `vm-forced-command`'s verb `case` arms (the extractor fails loudly, rather
 *     than silently skipping, on any two-space-indented arm head it does not recognise)
 *  2. the skill quotes the forced command's own unknown-verb refusal fragment, prefix included;
 *     the script prints it, in exactly one `refuse()` reason, the catch-all's. The skill makes a
 *     channel `forbidden` on that phrase alone, so no argument refusal may carry it. The fragment
 *     and the printf prefix are typed here, as the Docker twin types them
 *  3. every numeric/shape cap the skill states — the `journal`/`kernel` `lines=` ceiling, the
 *     unit-name byte cap, the `since=` digit-count ceiling and its no-leading-zero first digit,
 *     the `priority=` digit range (compared to the script's bracket expression digit for digit,
 *     not by endpoints alone, so a bracket missing an interior digit cannot pass), and `disk`'s
 *     `timeout` bound — equals what the script enforces or runs, each value read from both files
 *     rather than hard-coded here
 *  4. the exit table's third column ("What the row says") names only real schema members —
 *     `ObserverCoverageResultSchema`, `ObserverAssessmentSchema` and `ObserverVmChannelSchema`
 *     (`src/harvest/observer-target-artifacts.ts`) and `StatusSchema` (`src/contracts.ts`),
 *     imported rather than retyped here. The table's first-match order is pinned too: the
 *     journal-permission row sits above the `0` row, and "anything else" is last
 *  5. `docker/observe-ssh` prints `observe-ssh: refused before ssh ran`, and the skill quotes it —
 *     pinned here as well as by `observer-docker-docs-currency.test.ts`, because the shim is
 *     common to both roles
 *  6. the skill's per-token byte cap and its derived `unit=` ceiling equal `is_argument()`'s real
 *     `-le` bound in `docker/observe-ssh`, read from that function's own body, not typed here
 *  7. the action-verb rule names real channels for an action the checks table has no row for —
 *     `system` for reboot/shutdown/poweroff/halt, `units` for starting/stopping/restarting a unit —
 *     and the real coverage/assessment/task-status words that go with it
 *  8. the action-verb rule's CALL FORM: every action word it names (`reboot`, `shutdown`,
 *     `poweroff`, `halt`, `start`, `stop`, `restart`) is not one of `vm-forced-command`'s own verb
 *     arms, so each lands on the catch-all rather than being folded into `unit`'s argument list;
 *     `unit`'s own arm is pinned refusing a second argument on ARGUMENT COUNT, confirming the call
 *     form the rule forbids (`unit <action> <name>`) really would be misrouted, not just refused
 *  9. a malformed targets file is a FLEET CONFIGURATION FAULT, not a malformed call: pinned against
 *     every `refuse()` call inside `docker/observe-ssh`'s own `parse_line()`, which all name
 *     `${targets_var} line ${lineno}`; the skill's sentence sits inside the enrolled-tokens
 *     passage, before the exit table, never inside its "your own call was malformed" row
 *  10. the skill's fenced `awk` token-listing command is actually EXECUTED, under `sh`, against a
 *      real targets file (a comment line, a blank line, space- and tab-separated fields, two
 *      targets) and must print exactly the two tokens, one per line, nothing else
 *  11. the variable name the skill's "Where the enrolled tokens live" passage tells the worker to
 *      read equals the one `docker/observe-ssh` assigns to `targets_var` in its own `vm)` case arm;
 *      the worked command in that passage reads that variable rather than a hard-coded `/secrets/`
 *      path; and the brief-inputs table's `target` row points at the passage
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ObserverAssessmentSchema,
  ObserverCoverageResultSchema,
  ObserverVmChannelSchema,
  ObserverVmOpsArtifactSchema,
} from "../../src/harvest/observer-target-artifacts.ts";
import { StatusSchema } from "../../src/contracts.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SKILL_PATH = "skills/observer-vm-ops/SKILL.md";
const FORCED_COMMAND_PATH = "scripts/observe/vm-forced-command";
const ROLE_PATH = "roles/observer-vm.md";
const USAGE_PATH = "docker/observe-vm";
const OBSERVE_SSH_PATH = "docker/observe-ssh";

const SKILL = read(SKILL_PATH);
const FORCED_COMMAND = read(FORCED_COMMAND_PATH);
const ROLE = read(ROLE_PATH);
const USAGE = read(USAGE_PATH);
const OBSERVE_SSH = read(OBSERVE_SSH_PATH);

// -----------------------------------------------------------------------------
// 1. verb set: the forced command's `case` arms vs. the skill, the role and the usage text
// -----------------------------------------------------------------------------

/**
 * Every two-space-indented line inside `case ${verb} in ... esac` is an arm
 * head. The helpers' own `case` blocks (`is_lines`, `is_since_n`,
 * `is_priority`) are defined above the dispatch, outside this slice, and arm
 * bodies sit deeper than two spaces, so the first un-indented `\nesac` is the
 * dispatch's own close. Each arm head must be `*)` or `<verb>)`, and any other shape
 * fails here, because a regex that skipped it would leave a new arm
 * uncounted on both sides of the comparison.
 */
function verbsFromForcedCommand(src: string): Set<string> {
  const start = src.indexOf("case ${verb} in");
  expect(start, "vm-forced-command's `case ${verb} in` is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\nesac", start);
  expect(end, "no closing `esac` found after `case ${verb} in` — this probe has rotted").toBeGreaterThan(start);
  const block = src.slice(start, end);
  const armHeadLines = block.split("\n").filter((line) => /^ {2}\S/.test(line));
  // CONTROL: with no arm heads found, the shape check below would pass vacuously.
  expect(armHeadLines.length, "no two-space-indented arm heads found in the case block — the extractor has rotted").toBeGreaterThanOrEqual(9);
  const verbs: string[] = [];
  for (const line of armHeadLines) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === "  *)") continue; // the catch-all, excluded by construction, not by a denylist
    const m = trimmed.match(/^ {2}([a-z][a-z0-9-]*)\)$/);
    expect(m, `an arm head in vm-forced-command's verb case does not fit "*)" or "  <verb>)": ${JSON.stringify(line)}`).not.toBeNull();
    verbs.push(m![1]!);
  }
  expect(verbs.length, "no verb arms matched in the case block — the extractor has rotted").toBeGreaterThanOrEqual(8);
  return new Set(verbs);
}

/**
 * `| `<verb>` | ... | ... |` rows inside "## The verb grammar", up to the
 * next `## ` heading (the section's own `### Measured facts` subsection
 * stays inside the slice — `\n## ` never matches a three-`#` line). The
 * header row (`| Verb | ... |`) has no backticks around `Verb` and does not
 * match.
 */
function verbsFromSkill(src: string): Set<string> {
  const heading = "## The verb grammar";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's `## The verb grammar` heading is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt + heading.length);
  const nextHeadingOffset = after.search(/\n## /);
  const section = nextHeadingOffset === -1 ? after : after.slice(0, nextHeadingOffset);
  const verbs = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
  expect(verbs.length, "no verb rows matched in the skill's table — the extractor has rotted").toBeGreaterThanOrEqual(8);
  return new Set(verbs);
}

/**
 * The backtick-quoted verb list in `roles/observer-vm.md`'s "accepts exactly
 * ... — nothing else executes" sentence, anchored on both ends so a mutation
 * elsewhere in the file cannot satisfy it by accident.
 */
function verbsFromRole(src: string): Set<string> {
  const marker = "accepts exactly";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the role's 'accepts exactly' sentence opener is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt + marker.length);
  const anchor = "— nothing";
  const anchorAt = after.indexOf(anchor);
  expect(anchorAt, "the role's '— nothing' anchor is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const listText = after.slice(0, anchorAt);
  const verbs = [...listText.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
  expect(verbs.length, "no verb names matched before the anchor — the extractor has rotted").toBeGreaterThanOrEqual(8);
  return new Set(verbs);
}

/** The pipe-separated verb list on `docker/observe-vm`'s usage `  verb   <a> | <b> | ...` line. */
function verbsFromUsage(src: string): Set<string> {
  const m = src.match(/^ {2}verb\s+(.+)$/m);
  expect(m, "docker/observe-vm's usage 'verb' line is gone — this probe has rotted").not.toBeNull();
  const verbs = m![1]!
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(verbs.length, "docker/observe-vm's usage 'verb' line parsed to no verbs — the extractor has rotted").toBeGreaterThanOrEqual(8);
  return new Set(verbs);
}

describe("the skill's verb table equals the forced command's verb arms", () => {
  test("every verb the forced command accepts is one the skill documents", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromSkill(SKILL);
    const missing = [...real].filter((v) => !documented.has(v));
    expect(missing, `vm-forced-command accepts these verbs and the skill does not list them: ${missing.join(", ")}`).toEqual([]);
  });

  test("every verb the skill documents is one the forced command accepts", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromSkill(SKILL);
    const bogus = [...documented].filter((v) => !real.has(v));
    expect(bogus, `the skill documents these verbs and vm-forced-command does not accept them: ${bogus.join(", ")}`).toEqual([]);
  });
});

describe("the role's verb list equals the forced command's verb arms", () => {
  test("every verb the forced command accepts is one the role names", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromRole(ROLE);
    const missing = [...real].filter((v) => !documented.has(v));
    expect(missing, `vm-forced-command accepts these verbs and the role does not name them: ${missing.join(", ")}`).toEqual([]);
  });

  test("every verb the role names is one the forced command accepts", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromRole(ROLE);
    const bogus = [...documented].filter((v) => !real.has(v));
    expect(bogus, `the role names these verbs and vm-forced-command does not accept them: ${bogus.join(", ")}`).toEqual([]);
  });
});

describe("docker/observe-vm's usage verb list equals the forced command's verb arms", () => {
  test("every verb the forced command accepts is one the usage text lists", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromUsage(USAGE);
    const missing = [...real].filter((v) => !documented.has(v));
    expect(missing, `vm-forced-command accepts these verbs and the usage text does not list them: ${missing.join(", ")}`).toEqual([]);
  });

  test("every verb the usage text lists is one the forced command accepts", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromUsage(USAGE);
    const bogus = [...documented].filter((v) => !real.has(v));
    expect(bogus, `the usage text lists these verbs and vm-forced-command does not accept them: ${bogus.join(", ")}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 2. the forced command's own unknown-verb refusal wording
// -----------------------------------------------------------------------------

/** The catch-all `*)` arm's `refuse "${verb}" "..."` message, read from source. */
function unknownVerbRefusalMessage(src: string): string {
  const m = src.match(/\*\)\s*\n\s*refuse "\$\{verb\}" "([^"]+)"\s*\n\s*;;\s*\nesac/);
  expect(m, "the catch-all verb-refusal arm in vm-forced-command has changed shape — this probe has rotted").not.toBeNull();
  return m![1]!;
}

describe("the skill's verb-refusal wording is exactly what the forced command prints", () => {
  test("the forced command's unknown-verb line is the one the skill quotes", () => {
    const FRAGMENT = "not a recognised verb";
    expect(SKILL).toContain(`vm-forced-command: refused "<verb>": ${FRAGMENT}`);
    // The prefix comes from refuse(), the reason from the catch-all arm; the skill quotes both.
    expect(FORCED_COMMAND).toContain(String.raw`printf 'vm-forced-command: refused "%s": %s\n'`);
    const real = unknownVerbRefusalMessage(FORCED_COMMAND);
    expect(
      real.startsWith(FRAGMENT),
      `vm-forced-command's unknown-verb message is "${real}", which does not start with "${FRAGMENT}"`,
    ).toBe(true);
  });
});

/** Every `refuse "<first>" "<reason>"` call's reason string, read from source, in call order. */
function refuseReasons(src: string): string[] {
  const reasons = [...src.matchAll(/refuse\s+"[^"]*"\s+"([^"]*)"/g)].map((m) => m[1]!);
  // CONTROL: with no refuse() call matched, zero occurrences of the fragment would pass as unique.
  expect(reasons.length, "no refuse() calls matched in vm-forced-command — the extractor has rotted").toBeGreaterThanOrEqual(20);
  return reasons;
}

describe('"not a recognised verb" appears in exactly one refuse() reason, the catch-all\'s', () => {
  test("the only refuse() reason containing the phrase is the catch-all arm's", () => {
    const FRAGMENT = "not a recognised verb";
    const withFragment = refuseReasons(FORCED_COMMAND).filter((r) => r.includes(FRAGMENT));
    expect(
      withFragment,
      `expected exactly the catch-all's refuse() reason to contain "${FRAGMENT}", found: ${JSON.stringify(withFragment)}`,
    ).toEqual([unknownVerbRefusalMessage(FORCED_COMMAND)]);
  });
});

// -----------------------------------------------------------------------------
// 3. numeric/shape caps: read from both files, never hard-coded here
// -----------------------------------------------------------------------------

/**
 * The source text of one shell function, `<name>() {` through its own
 * closing `}` at column 0 — scoped so a numeric literal inside a DIFFERENT
 * function (all four cap-enforcing functions sit one after another in this
 * script) can never satisfy an extraction meant for this one.
 */
function functionBody(src: string, name: string): string {
  const marker = `${name}() {`;
  const start = src.indexOf(marker);
  expect(start, `${marker} is gone from vm-forced-command — this probe has rotted`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, `no closing "}" found after ${marker} — this probe has rotted`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * The real `lines=`/`M` upper bound: the literal 3-digit case arm inside
 * `is_lines()`. The boundary is enforced by CASE-PATTERN matching, not
 * `-le` (the script's own header, choice 3), so this reads the literal
 * digit-string arm rather than a numeric-comparison operator — the one
 * place this file's caps extraction cannot mirror the Docker twin's
 * `-le`-based `tailCapFromScript` verbatim, because `vm-forced-command`
 * enforces this bound differently.
 */
function linesCapFromScript(src: string): number {
  const body = functionBody(src, "is_lines");
  const m = body.match(/^\s*(\d{3})\) return 0 ;;\s*$/m);
  expect(m, "is_lines()'s literal 3-digit upper-bound case arm is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The real `since=` digit-COUNT ceiling: the highest number in `is_since_n()`'s `case ${#1} in` length list. */
function sinceDigitsMaxFromScript(src: string): number {
  const body = functionBody(src, "is_since_n");
  const m = body.match(/case \$\{#1\} in\s*\n\s*([0-9 |]+)\)\s*first_in/);
  expect(m, "is_since_n()'s digit-count case list is gone — this probe has rotted").not.toBeNull();
  const nums = m![1]!.split("|").map((s) => Number(s.trim()));
  expect(nums.length, "is_since_n()'s digit-count case list parsed to no numbers — the extractor has rotted").toBeGreaterThanOrEqual(9);
  return Math.max(...nums);
}

/** The real first-digit charset `since=`'s `N` must start with: the literal string `first_in` is called against inside `is_since_n()`. */
function sinceFirstDigitCharsetFromScript(src: string): string {
  const body = functionBody(src, "is_since_n");
  const m = body.match(/first_in "\$1" "(\d+)"/);
  expect(m, "is_since_n()'s first-digit charset literal is gone — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/** The real `priority=` digit set: the bracket expression `is_priority()`'s case arm matches against. */
function priorityCharsFromScript(src: string): string {
  const body = functionBody(src, "is_priority");
  const m = body.match(/\[([0-9]+)\]\) return 0 ;;/);
  expect(m, "is_priority()'s bracket-expression case arm is gone — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/** `UNIT_MAX=<N>`, a bare shell assignment — read exactly as the Docker twin reads `DIGITS_MAX=<N>`. */
function unitMaxFromScript(src: string): number {
  const m = src.match(/^UNIT_MAX=(\d+)$/m);
  expect(m, "vm-forced-command's UNIT_MAX assignment is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The real `disk` target argv's timeout bound: the literal, actually-executed `exec timeout <N> df -P -k` line — not the header comment describing it. */
function diskTimeoutFromScript(src: string): number {
  const m = src.match(/exec timeout (\d+) df -P -k/);
  expect(m, "vm-forced-command's disk exec line ('exec timeout <N> df -P -k') is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** Every place the skill states the `lines=` cap as a number: `M <= <N>` (journal and kernel rows), `1 to <N>` (the grammar bullet) and `capped at <N>` (Bounded reads). Illustrative uses elsewhere (e.g. `lines=500` as an example) are not statements of the cap and are deliberately not matched. */
function linesCapMentionsFromSkill(src: string): number[] {
  const nums = [
    ...[...src.matchAll(/M <= (\d+)/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/`lines=<M>` — 1 to (\d+)/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/capped at (\d+) for both `journal` and `kernel`/g)].map((m) => Number(m[1])),
  ];
  expect(nums.length, "no lines= cap statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(4);
  return nums;
}

/** Every place the skill states the unit-name byte cap: `at most <N> bytes` (input table and verb-grammar table) and `<N>-byte cap` (the `unit=` argument note). */
function unitMaxMentionsFromSkill(src: string): number[] {
  const nums = [
    ...[...src.matchAll(/at most (\d+) bytes/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/(\d+)-byte cap/g)].map((m) => Number(m[1])),
  ];
  expect(nums.length, "no unit-name byte-cap statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(3);
  return nums;
}

/** The skill's `since=` digit-count ceiling statement: "`N` is 1 to <N> ASCII digits". */
function sinceDigitsMaxMentionFromSkill(src: string): number {
  const m = src.match(/`N` is 1 to (\d+) ASCII digits/);
  expect(m, "the skill's '`N` is 1 to <N> ASCII digits' statement is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The skill's `since=` first-digit bound statement: "first digit `<X>`-`<Y>`". */
function sinceFirstDigitMentionFromSkill(src: string): [string, string] {
  const m = src.match(/first digit `(\d)`-`(\d)`/);
  expect(m, "the skill's 'first digit `X`-`Y`' statement is gone — this probe has rotted").not.toBeNull();
  return [m![1]!, m![2]!];
}

/** Every place the skill states the `priority=` digit range: "exactly one digit `<X>`-`<Y>`" (grammar bullet) and `priority=<X-Y>` (verb-grammar table). Deliberately anchored past "exactly one"/the `priority=` prefix so `since=`'s unrelated "first digit `1`-`9`" statement cannot be mistaken for this one. */
function priorityRangeMentionsFromSkill(src: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ...[...src.matchAll(/exactly one digit `(\d)`-`(\d)`/g)].map((m) => [m[1]!, m[2]!] as [string, string]),
    ...[...src.matchAll(/priority=<(\d)-(\d)>/g)].map((m) => [m[1]!, m[2]!] as [string, string]),
  ];
  expect(pairs.length, "no priority= range statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(2);
  return pairs;
}

/** Every place the skill states `disk`'s timeout bound in prose: "<N>-second". The verb-grammar table's literal `timeout <N> df -P -k` command is checked separately, as an exact string. */
function diskSecondsMentionsFromSkill(src: string): number[] {
  const nums = [...src.matchAll(/(\d+)-second/g)].map((m) => Number(m[1]));
  expect(nums.length, "no '<N>-second' statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(3);
  return nums;
}

describe("the skill's lines= cap matches the literal 3-digit case arm inside is_lines() — the real accept/reject boundary (500 accepted, 501 refused) is pinned by observe-vm-forced-command.test.ts", () => {
  test("every 'M <= N' / '1 to N' / 'capped at N' statement equals the case arm's literal", () => {
    const real = linesCapFromScript(FORCED_COMMAND);
    for (const stated of linesCapMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a lines= cap of ${stated}, is_lines()'s case arm reads ${real}`).toBe(real);
    }
  });
});

describe("the skill's unit-name byte cap matches UNIT_MAX", () => {
  test("every '<N> bytes' / '<N>-byte cap' statement equals UNIT_MAX", () => {
    const real = unitMaxFromScript(FORCED_COMMAND);
    for (const stated of unitMaxMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a unit-name byte cap of ${stated}, UNIT_MAX is ${real}`).toBe(real);
    }
  });
});

describe("the skill's since= digit-count ceiling and no-leading-zero first digit match is_since_n()", () => {
  test("the digit-count ceiling ('1 to N ASCII digits') equals the script's real ceiling", () => {
    const real = sinceDigitsMaxFromScript(FORCED_COMMAND);
    const stated = sinceDigitsMaxMentionFromSkill(SKILL);
    expect(stated, `the skill states a since= digit-count ceiling of ${stated}, is_since_n() enforces ${real}`).toBe(real);
  });

  test("the first-digit bound ('first digit `X`-`Y`') equals the script's real first-digit charset's own bounds", () => {
    const charset = sinceFirstDigitCharsetFromScript(FORCED_COMMAND);
    const [low, high] = sinceFirstDigitMentionFromSkill(SKILL);
    expect(low, `the skill states the low first-digit bound as ${low}, is_since_n()'s charset is "${charset}"`).toBe(charset[0]!);
    expect(high, `the skill states the high first-digit bound as ${high}, is_since_n()'s charset is "${charset}"`).toBe(
      charset[charset.length - 1]!,
    );
  });

  test("is_since_n()'s first-digit charset literal, read as text, excludes '0' — since=0s's actual refusal by the running script is pinned by observe-vm-forced-command.test.ts, not here", () => {
    const charset = sinceFirstDigitCharsetFromScript(FORCED_COMMAND);
    expect(charset.includes("0"), `is_since_n()'s first-digit charset "${charset}" includes '0'`).toBe(false);
  });

  test("the skill states since=0s is refused", () => {
    expect(SKILL).toMatch(/`since=0s`\s+is refused/);
  });
});

/** Expands an inclusive digit-range pair like ["0", "7"] into its full ascending digit string, "01234567". A partial bracket such as "0347" is a DIFFERENT string from the full expansion of "0"-"7" and fails an exact comparison against it, where an endpoints-only comparison would not. */
function expandDigitRange(low: string, high: string): string {
  const lo = Number(low);
  const hi = Number(high);
  expect(lo, `cannot expand a digit range starting at "${low}"`).toBeLessThanOrEqual(hi);
  let out = "";
  for (let d = lo; d <= hi; d++) out += String(d);
  return out;
}

describe("the skill's priority= digit range matches is_priority()'s real bracket expression, digit for digit", () => {
  test("every stated range, expanded to its full digit string, equals the script's real bracket-expression digits", () => {
    const chars = priorityCharsFromScript(FORCED_COMMAND);
    for (const [low, high] of priorityRangeMentionsFromSkill(SKILL)) {
      const expanded = expandDigitRange(low, high);
      expect(
        expanded,
        `the skill states a priority range of ${low}-${high} (full digit string "${expanded}"), is_priority()'s bracket expression is "${chars}"`,
      ).toBe(chars);
    }
  });
});

describe("the skill's disk timeout bound matches the script's real exec line", () => {
  test("every '<N>-second' statement equals the script's real timeout bound", () => {
    const real = diskTimeoutFromScript(FORCED_COMMAND);
    for (const stated of diskSecondsMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a disk timeout of ${stated}s, vm-forced-command's disk arm runs timeout ${real}`).toBe(real);
    }
  });

  test("the skill's disk row's quoted command exactly matches the script's real exec line", () => {
    const real = diskTimeoutFromScript(FORCED_COMMAND);
    expect(SKILL).toContain(`\`timeout ${real} df -P -k\``);
  });
});

// -----------------------------------------------------------------------------
// 4. the exit table: its third column names only real enum members, and its
//    first-match order is pinned
// -----------------------------------------------------------------------------

/**
 * The exit table's own data rows, `skills/observer-vm-ops/SKILL.md`'s
 * "## Calling the target, and reading its exit" section, sliced from directly
 * after the header row to directly before the section's own closing bold
 * paragraph ("**The unreachable rule...") so a mutation elsewhere in the file
 * cannot satisfy anything below by accident. Every row here has exactly three
 * data columns (measured: every `|`-starting line in this slice splits into 5
 * pieces on `|`, the leading and trailing pieces empty), so column 3 — "What
 * the row says" — is always `cols[3]`. The separator row (`|---|---|---|`) is
 * dropped; it has the same column count but no letters.
 */
function exitTableRows(src: string): Array<{ full: string; rowSays: string }> {
  const heading = "| Exit | What it means | What the row says |";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's exit table header is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt + heading.length);
  const endMarker = "**The unreachable rule";
  const endAt = after.indexOf(endMarker);
  expect(endAt, "the 'The unreachable rule' paragraph after the exit table is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const tableBlock = after.slice(0, endAt);
  const pipeLines = tableBlock.split("\n").filter((l) => l.trim().startsWith("|"));
  const dataLines = pipeLines.filter((l) => !/^\s*\|[\s-]*\|[\s-]*\|[\s-]*\|\s*$/.test(l));
  expect(dataLines.length, "no exit-table data rows found below the header — the extractor has rotted").toBeGreaterThanOrEqual(13);
  return dataLines.map((line) => {
    const cols = line.split("|");
    expect(cols.length, `an exit-table row does not split into exactly 3 '|'-delimited data columns: ${JSON.stringify(line)}`).toBe(5);
    return { full: line, rowSays: cols[3]! };
  });
}

/** Every (channel, result) pair from "the `<channel>` channel is `<result>`" in one row's third column. */
function channelIsPairs(rowSays: string): Array<[string, string]> {
  return [...rowSays.matchAll(/the `([a-z]+)` channel is `([a-z_]+)`/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
}

/** Every (channel, result) pair from "the `<channel>` coverage is `<result>`". */
function coverageIsPairs(rowSays: string): Array<[string, string]> {
  return [...rowSays.matchAll(/the `([a-z]+)` coverage is `([a-z_]+)`/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
}

/** Every bare (channel, result) pair from "`<channel>` is `<result>`" — no "channel"/"coverage" word between the closing backtick and "is", so this cannot double-match the two patterns above. */
function bareIsPairs(rowSays: string): Array<[string, string]> {
  return [...rowSays.matchAll(/`([a-z]+)`\s+is\s+`([a-z_]+)`/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
}

/** Every bare coverage-result token from "the channel is `<result>`" / "that channel is `<result>`" — no channel name given, so only the result half is checkable. */
function genericChannelResultTokens(rowSays: string): string[] {
  return [...rowSays.matchAll(/\b(?:the|that) channel is `([a-z_]+)`/g)].map((m) => m[1]!);
}

/** Every task-status token from "the task status is `<status>`". */
function taskStatusTokens(rowSays: string): string[] {
  return [...rowSays.matchAll(/the task status is `([a-z]+)`/g)].map((m) => m[1]!);
}

/** Every (assessment, coverage-result) pair from "`<assessment>` with coverage `<result>`". */
function assessmentWithCoveragePairs(rowSays: string): Array<[string, string]> {
  return [...rowSays.matchAll(/`([a-z]+)` with coverage `([a-z_]+)`/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
}

/** Every assessment token from "the row is `<assessment>`". */
function rowIsAssessmentTokens(rowSays: string): string[] {
  return [...rowSays.matchAll(/\bthe row is `([a-z]+)`/g)].map((m) => m[1]!);
}

describe("the exit table's third-column tokens are real enum members, imported from source", () => {
  const VM_CHANNELS = new Set<string>(ObserverVmChannelSchema.options);
  const COVERAGE_RESULTS = new Set<string>(ObserverCoverageResultSchema.options);
  const ASSESSMENTS = new Set<string>(ObserverAssessmentSchema.options);
  const STATUSES = new Set<string>(StatusSchema.options);

  function rowsSays(): string[] {
    return exitTableRows(SKILL).map((r) => r.rowSays);
  }

  test("every 'the <channel> channel is <result>' pair names real enum members", () => {
    const pairs = rowsSays().flatMap(channelIsPairs);
    expect(pairs.length, "no 'the <channel> channel is <result>' pairs matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(2);
    for (const [channel, result] of pairs) {
      expect(VM_CHANNELS.has(channel), `the exit table names channel "${channel}", which is not a member of ObserverVmChannelSchema (${[...VM_CHANNELS].join(", ")})`).toBe(true);
      expect(COVERAGE_RESULTS.has(result), `the exit table states the ${channel} channel is "${result}", which is not a member of ObserverCoverageResultSchema (${[...COVERAGE_RESULTS].join(", ")})`).toBe(true);
    }
  });

  test("every 'the <channel> coverage is <result>' pair names real enum members", () => {
    const pairs = rowsSays().flatMap(coverageIsPairs);
    expect(pairs.length, "no 'the <channel> coverage is <result>' pairs matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(1);
    for (const [channel, result] of pairs) {
      expect(VM_CHANNELS.has(channel), `the exit table names channel "${channel}", which is not a member of ObserverVmChannelSchema (${[...VM_CHANNELS].join(", ")})`).toBe(true);
      expect(COVERAGE_RESULTS.has(result), `the exit table states a ${channel} coverage result of "${result}", which is not a member of ObserverCoverageResultSchema (${[...COVERAGE_RESULTS].join(", ")})`).toBe(true);
    }
  });

  test("the bare '<channel> is <result>' pair names real enum members", () => {
    const pairs = rowsSays().flatMap(bareIsPairs);
    expect(pairs.length, "no bare '<channel> is <result>' pair matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(1);
    for (const [channel, result] of pairs) {
      expect(VM_CHANNELS.has(channel), `the exit table names channel "${channel}", which is not a member of ObserverVmChannelSchema (${[...VM_CHANNELS].join(", ")})`).toBe(true);
      expect(COVERAGE_RESULTS.has(result), `the exit table states "${channel}" is "${result}", which is not a member of ObserverCoverageResultSchema (${[...COVERAGE_RESULTS].join(", ")})`).toBe(true);
    }
  });

  test("every generic '(the|that) channel is <result>' token names a real coverage result", () => {
    const tokens = rowsSays().flatMap(genericChannelResultTokens);
    expect(tokens.length, "no generic '(the|that) channel is <result>' tokens matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(4);
    for (const result of tokens) {
      expect(COVERAGE_RESULTS.has(result), `the exit table states a channel result of "${result}", which is not a member of ObserverCoverageResultSchema (${[...COVERAGE_RESULTS].join(", ")})`).toBe(true);
    }
  });

  test("every 'the task status is <status>' token names a real task status", () => {
    const tokens = rowsSays().flatMap(taskStatusTokens);
    expect(tokens.length, "no 'the task status is <status>' tokens matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(5);
    for (const status of tokens) {
      expect(STATUSES.has(status), `the exit table states a task status of "${status}", which is not a member of StatusSchema (${[...STATUSES].join(", ")})`).toBe(true);
    }
  });

  test("every '<assessment> with coverage <result>' pair names real enum members", () => {
    const pairs = rowsSays().flatMap(assessmentWithCoveragePairs);
    expect(pairs.length, "no '<assessment> with coverage <result>' pairs matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(4);
    for (const [assessment, result] of pairs) {
      expect(ASSESSMENTS.has(assessment), `the exit table names assessment "${assessment}", which is not a member of ObserverAssessmentSchema (${[...ASSESSMENTS].join(", ")})`).toBe(true);
      expect(COVERAGE_RESULTS.has(result), `the exit table states coverage "${result}" alongside assessment ${assessment}, which is not a member of ObserverCoverageResultSchema (${[...COVERAGE_RESULTS].join(", ")})`).toBe(true);
    }
  });

  test("every 'the row is <assessment>' token names a real assessment", () => {
    const tokens = rowsSays().flatMap(rowIsAssessmentTokens);
    expect(tokens.length, "no 'the row is <assessment>' tokens matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(4);
    for (const assessment of tokens) {
      expect(ASSESSMENTS.has(assessment), `the exit table states the row is "${assessment}", which is not a member of ObserverAssessmentSchema (${[...ASSESSMENTS].join(", ")})`).toBe(true);
    }
  });

  test("every 'goes in <field>' token names a real field of the VM artifact's row", () => {
    const ROW_FIELDS = new Set<string>(Object.keys(ObserverVmOpsArtifactSchema.shape.services.element.shape));
    const fields = rowsSays().flatMap((says) => [...says.matchAll(/goes in `([a-z_]+)`/g)].map((m) => m[1]!));
    expect(fields.length, "no 'goes in <field>' tokens matched in the exit table — the extractor has rotted").toBeGreaterThanOrEqual(3);
    for (const field of fields) {
      expect(ROW_FIELDS.has(field), `the exit table puts stderr in "${field}", which is not a field of an ObserverVmOpsArtifactSchema row (${[...ROW_FIELDS].join(", ")})`).toBe(true);
    }
  });
});

describe("the exit table's first-match order is pinned", () => {
  test("the journal-permission row sits above the `0` row", () => {
    const rows = exitTableRows(SKILL).map((r) => r.full);
    const permissionIdx = rows.findIndex((r) => r.includes("No journal files were opened due to insufficient permissions."));
    const zeroIdx = rows.findIndex((r) => /^\|\s*`0`\s*\|/.test(r));
    expect(permissionIdx, "the journal-permission row is missing from the exit table — this probe has rotted").toBeGreaterThanOrEqual(0);
    expect(zeroIdx, "the `0` row is missing from the exit table — this probe has rotted").toBeGreaterThanOrEqual(0);
    expect(
      permissionIdx,
      `the journal-permission row (position ${permissionIdx}) must sit above the \`0\` row (position ${zeroIdx}) — the table is read top to bottom, first match wins`,
    ).toBeLessThan(zeroIdx);
  });

  test("every row sits in the order this list gives, and no row is added or removed without changing it", () => {
    // First match wins, so the order IS the contract: a broader row placed above a narrower one
    // silently takes its cases, as a `128`-or-above row once took every `255` from `disk`.
    const EXPECTED = [
      "`journal` or `kernel`, any exit, with `Hint:",
      "`0`",
      "`77` with `observe-ssh: refused before ssh ran`",
      "`77` with `vm-forced-command: refused \"<verb>\": not a recognised verb",
      "`77` with any other `vm-forced-command: refused",
      "`78`",
      "`124` from `disk`",
      "`125` from `disk`, or `126` or `127` from any verb",
      "`255`",
      "`1` with stdout exactly",
      "any non-zero exit from any verb with both stdout and stderr empty",
      "non-zero from `system`",
      "anything else",
    ];
    const exits = exitTableRows(SKILL).map((r) => r.full.split("|")[1]!.trim());
    expect(exits.length, `the exit table has ${exits.length} rows; this list pins ${EXPECTED.length}`).toBe(EXPECTED.length);
    EXPECTED.forEach((prefix, i) => {
      expect(exits[i]!.startsWith(prefix), `exit-table row ${i + 1} is ${JSON.stringify(exits[i])}; expected it to start with ${JSON.stringify(prefix)}`).toBe(true);
    });
  });

  test("the 'anything else' row is last", () => {
    const rows = exitTableRows(SKILL).map((r) => r.full);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.includes("anything else"), `the exit table's last row is not the 'anything else' row: ${JSON.stringify(lastRow)}`).toBe(true);
    // The catch-all fails closed: a non-zero exit nothing above explains is never `answered`.
    const lastRowSays = exitTableRows(SKILL).at(-1)!.rowSays;
    expect(lastRowSays, "the 'anything else' row reads a non-zero exit as answered").not.toContain("`answered`");
    expect(lastRowSays, "the 'anything else' row no longer makes the channel unreachable").toContain("the channel is `unreachable`");
  });
});

// -----------------------------------------------------------------------------
// 5. observe-ssh's own refusal wording, pinned here too
// -----------------------------------------------------------------------------

describe("the skill quotes observe-ssh's own refusal text, and observe-ssh actually prints it", () => {
  const NEEDLE = "observe-ssh: refused before ssh ran";

  test("the skill quotes it", () => {
    expect(SKILL).toContain(NEEDLE);
  });

  test("docker/observe-ssh actually prints it", () => {
    // CONTROL: read straight from source, so a rewritten refuse() that drops
    // the phrase turns this red rather than the assertion above alone (which
    // the skill's own text could satisfy by coincidence if this test did not
    // also read the shim).
    expect(OBSERVE_SSH).toMatch(/printf 'observe-ssh: refused before ssh ran: /);
    expect(OBSERVE_SSH).toContain(NEEDLE);
  });
});

// -----------------------------------------------------------------------------
// 6. the per-token byte cap: derived from is_argument(), not typed here
// -----------------------------------------------------------------------------

/**
 * The real per-token byte cap: the numeric literal in `is_argument()`'s own
 * `[ "${#1}" -le <N> ]` bound, scoped to that function's body (`is_argument()
 * {` through its own closing `}`) so a different validator's literal
 * (`docker/observe-ssh` defines several `is_*` functions, `is_host`'s
 * `<= 253` among them) can never satisfy an extraction meant for this one.
 */
function argumentByteCapFromScript(src: string): number {
  const marker = "is_argument() {";
  const start = src.indexOf(marker);
  expect(start, "docker/observe-ssh's is_argument() is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, "no closing '}' found after is_argument() — this probe has rotted").toBeGreaterThan(start);
  const body = src.slice(start, end);
  const m = body.match(/\[\s*"\$\{#1\}"\s*-le\s*(\d+)\s*\]/);
  expect(m, "is_argument()'s '-le <N>' byte-cap check is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The skill's stated per-token byte cap: "at <N> bytes, in `is_argument()`" (the number and "bytes," wrap onto the next markdown line, hence `\s+`). */
function argumentByteCapMentionFromSkill(src: string): number {
  const m = src.match(/at (\d+)\s+bytes,\s+in `is_argument\(\)`/);
  expect(m, "the skill's 'at <N> bytes, in `is_argument()`' statement is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The skill's stated practical `unit=` byte ceiling: "tops out at <N> bytes in practice". */
function unitPracticalCeilingMentionFromSkill(src: string): number {
  const m = src.match(/tops out at (\d+) bytes in practice/);
  expect(m, "the skill's 'tops out at <N> bytes in practice' statement is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

describe("the skill's per-token byte cap is derived from is_argument(), not typed independently", () => {
  test("the skill states is_argument()'s real byte cap", () => {
    const real = argumentByteCapFromScript(OBSERVE_SSH);
    const stated = argumentByteCapMentionFromSkill(SKILL);
    expect(stated, `the skill states a per-token byte cap of ${stated}, is_argument() enforces -le ${real}`).toBe(real);
  });

  test("the skill states the practical unit= ceiling as the byte cap minus 'unit='.length, not a separately typed number", () => {
    const real = argumentByteCapFromScript(OBSERVE_SSH);
    const stated = unitPracticalCeilingMentionFromSkill(SKILL);
    const KEY = "unit=";
    const expected = real - KEY.length;
    expect(
      stated,
      `the skill states a practical unit= ceiling of ${stated}; is_argument()'s cap (${real}) minus "${KEY}".length (${KEY.length}) is ${expected}`,
    ).toBe(expected);
  });

  test("the skill names is_argument() as the function that enforces the cap", () => {
    expect(SKILL).toContain("is_argument()");
  });
});

// -----------------------------------------------------------------------------
// 7. the action-verb rule: an action the checks table has no row for still
//    names a real channel, `forbidden`, and the other real coverage/task words
// -----------------------------------------------------------------------------

/**
 * The action-verb rule paragraph, anchored on its own lead sentence and
 * closed at the next blank line, so a mutation elsewhere in the file cannot
 * satisfy anything below by accident.
 */
function actionVerbRuleParagraph(src: string): string {
  const marker = "**When the brief asks for an action, not a check.**";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the skill's action-verb rule paragraph is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt);
  const endAt = after.indexOf("\n\n");
  expect(endAt, "the action-verb rule paragraph never ends — this probe has rotted").toBeGreaterThan(0);
  return after.slice(0, endAt);
}

describe("the skill's action-verb rule names real channels for an action the checks table has no row for", () => {
  const VM_CHANNELS = new Set<string>(ObserverVmChannelSchema.options);

  test("`system` maps to reboot/shutdown/poweroff/halt, `units` maps to starting/stopping/restarting a unit — both real channels", () => {
    const paragraph = actionVerbRuleParagraph(SKILL);
    const mapped = [...paragraph.matchAll(/`([a-z]+)` for ([^;.]+)/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
    expect(mapped.length, "no '`<channel>` for <actions>' mappings matched in the rule paragraph — the extractor has rotted").toBeGreaterThanOrEqual(2);
    for (const [channel] of mapped) {
      expect(VM_CHANNELS.has(channel), `the rule maps an action to "${channel}", which is not a member of ObserverVmChannelSchema (${[...VM_CHANNELS].join(", ")})`).toBe(true);
    }
    const byChannel = Object.fromEntries(mapped);
    expect(byChannel["system"], "the rule's `system` mapping is missing, or does not mention reboot").toMatch(/reboot/);
    expect(byChannel["units"], "the rule's `units` mapping is missing, or does not mention restarting a unit").toMatch(/restart/);
  });

  test("the rule marks the channel `forbidden`, the row `indeterminate`, the refusal in `evidence_ref`, the task `blocked` — and says `not_attempted` is wrong here", () => {
    const paragraph = actionVerbRuleParagraph(SKILL);
    const COVERAGE_RESULTS = new Set<string>(ObserverCoverageResultSchema.options);
    const ASSESSMENTS = new Set<string>(ObserverAssessmentSchema.options);
    const STATUSES = new Set<string>(StatusSchema.options);
    expect(paragraph).toContain("`forbidden`");
    expect(paragraph).toContain("`indeterminate`");
    expect(paragraph).toContain("`blocked`");
    expect(paragraph).toContain("`evidence_ref`");
    expect(paragraph).toContain("`not_attempted`");
    expect(COVERAGE_RESULTS.has("forbidden")).toBe(true);
    expect(ASSESSMENTS.has("indeterminate")).toBe(true);
    expect(STATUSES.has("blocked")).toBe(true);
    expect(COVERAGE_RESULTS.has("not_attempted")).toBe(true);
    // Whitespace-normalised: a markdown re-flow that moves where "is wrong"
    // wraps must not change what this requires.
    const normalized = paragraph.replace(/\s+/g, " ");
    expect(normalized, "the rule does not say marking every channel not_attempted is wrong for this case").toMatch(/not_attempted`\s+is wrong/);
  });

  test("the exit table's `77` unrecognised-verb row points to this rule", () => {
    expect(SKILL).toContain('"When the brief asks for an action, not a check" below names which channel');
  });
});

// -----------------------------------------------------------------------------
// 8. the action-verb rule's call form: the action word IS the verb, so it lands
//    on the catch-all — never a second argument tacked onto `unit`
// -----------------------------------------------------------------------------

/** Every action word `reboot`/`shutdown`/`poweroff`/`halt` take no unit argument; `start`/`stop`/`restart` take one. */
const ACTION_WORDS = ["reboot", "shutdown", "poweroff", "halt", "start", "stop", "restart"] as const;
const ACTION_WORDS_WITH_UNIT_ARGUMENT = new Set(["start", "stop", "restart"]);

/** `vm-forced-command`'s own `unit)` case arm — its whole body, from the arm head through its own `;;`. */
function unitArmFromForcedCommand(src: string): string {
  const start = src.indexOf("\n  unit)");
  expect(start, "vm-forced-command's `unit)` arm is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const end = src.indexOf(";;", start);
  expect(end, "no closing ';;' found after the `unit)` arm — this probe has rotted").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the action-verb rule's call form names the action word as the verb itself — not a second argument to `unit`", () => {
  test("none of the rule's action words is one of vm-forced-command's own verb arms — each lands on the catch-all, not a real verb", () => {
    const verbs = verbsFromForcedCommand(FORCED_COMMAND);
    for (const word of ACTION_WORDS) {
      expect(
        verbs.has(word),
        `"${word}" IS one of vm-forced-command's verb arms (${[...verbs].join(", ")}) — the action-verb call form would resolve to a real verb, not the catch-all refusal the rule relies on`,
      ).toBe(false);
    }
  });

  test("the skill's action-verb rule paragraph shows the exact call form for every action word", () => {
    // Whitespace-normalised first (`s.replace(/\s+/g, " ")`), so a markdown
    // re-flow that moves where one of these `observe-vm <target> <word>`
    // phrases wraps cannot change what this requires — the same defence
    // `observer-vm-skill-example.test.ts`'s bullet assertions use.
    const normalized = actionVerbRuleParagraph(SKILL).replace(/\s+/g, " ");
    for (const word of ACTION_WORDS) {
      const expected = ACTION_WORDS_WITH_UNIT_ARGUMENT.has(word)
        ? `observe-vm <target> ${word} <unit>`
        : `observe-vm <target> ${word}`;
      expect(
        normalized,
        `the action-verb rule does not show "${expected}" as the call form for "${word}"`,
      ).toContain(expected);
    }
  });

  test("vm-forced-command's `unit)` arm refuses a second argument on ARGUMENT COUNT, before any verb question is asked", () => {
    // CONTROL: read straight from source, so a rewritten arm turns this red
    // rather than the skill's own text alone (which could say the same thing
    // by coincidence without the script actually enforcing it).
    const arm = unitArmFromForcedCommand(FORCED_COMMAND);
    expect(arm).toContain('[ "$#" -eq 1 ]');
    expect(arm).toContain("unit takes exactly one argument, a unit name; got $#");
  });

  test("the rule states the argument-refusal shape is never 'fixed' into a read, when the brief asked for an action", () => {
    const paragraph = actionVerbRuleParagraph(SKILL);
    expect(paragraph, 'the rule does not say an ARGUMENT-shaped refusal is never "fixed" into a read').toMatch(
      /ARGUMENT refusal is never "fixed" into a read/,
    );
  });
});

// -----------------------------------------------------------------------------
// 9. a malformed targets file: a fleet configuration fault, not a malformed
//    call — pinned against observe-ssh's own parse_line() refusals
// -----------------------------------------------------------------------------

/** `docker/observe-ssh`'s `parse_line()` function body, `parse_line() {` through its own closing `}` at column 0. */
function parseLineBody(src: string): string {
  const start = src.indexOf("parse_line() {");
  expect(start, "docker/observe-ssh's parse_line() is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, "no closing '}' found after parse_line() — this probe has rotted").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("a malformed targets file is a fleet configuration fault, not a malformed call", () => {
  test("every refuse() call inside observe-ssh's parse_line() names `${targets_var} line ${lineno}`", () => {
    const body = parseLineBody(OBSERVE_SSH);
    const refuseCalls = [...body.matchAll(/refuse "([^"]*)"/g)].map((m) => m[1]!);
    expect(refuseCalls.length, "no refuse() calls found inside parse_line() — the extractor has rotted").toBeGreaterThanOrEqual(6);
    for (const msg of refuseCalls) {
      expect(
        msg,
        `a parse_line() refusal does not name "\${targets_var} line \${lineno}": ${JSON.stringify(msg)}`,
      ).toContain("${targets_var} line ${lineno}");
    }
  });

  test("the skill states the rule, inside the enrolled-tokens passage: blocked, indeterminate, not retried", () => {
    const marker = "**A malformed targets file refuses the whole file, not just its own listing.**";
    const markerAt = SKILL.indexOf(marker);
    expect(markerAt, "the skill's malformed-targets-file rule is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
    const after = SKILL.slice(markerAt);
    const endAt = after.indexOf("\n\n");
    expect(endAt, "the malformed-targets-file rule paragraph never ends — this probe has rotted").toBeGreaterThan(0);
    const paragraph = after.slice(0, endAt);
    expect(paragraph).toContain("`<targets_var> line <n>`");
    expect(paragraph).toContain("`blocked`");
    expect(paragraph).toContain("`indeterminate`");
    expect(paragraph, "the rule does not say the call is not retried").toMatch(/not retried/);
    // Placement: inside the same bounded passage the enrolled-tokens tests
    // (section 11) already anchor on, and therefore before the exit table —
    // never folded into its "your own call was malformed" row.
    expect(enrolledTokensPassage(SKILL)).toContain(marker);
  });
});

// -----------------------------------------------------------------------------
// 10. the token-listing command is EXECUTED, not just named
// -----------------------------------------------------------------------------

describe("the skill's fenced awk token-listing command actually extracts tokens when run", () => {
  test("running it under sh against a real targets file yields exactly the two tokens", () => {
    const command = enrolledTokensCommandFromSkill(SKILL);
    expect(command, "the extracted command no longer names OBSERVER_VM_TARGETS_FILE — this probe has rotted").toContain(
      "OBSERVER_VM_TARGETS_FILE",
    );

    const dir = mkdtempSync(join(tmpdir(), "observer-vm-targets-"));
    const targetsFile = join(dir, "targets");
    try {
      // A comment line, a blank line, space-separated fields, tab-separated
      // fields, and two targets — the shapes `observe-ssh`'s own parser (and
      // this command) must both tolerate.
      const contents = ["# a comment line", "", "vm-1  10.0.0.1 22 obs", "\tvm-2\t10.0.0.2\t2222\tobs", ""].join("\n");
      writeFileSync(targetsFile, contents);

      const proc = Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { OBSERVER_VM_TARGETS_FILE: targetsFile },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(
        proc.exitCode,
        `the command exited ${proc.exitCode}; stderr: ${proc.stderr.toString()}`,
      ).toBe(0);
      expect(proc.stdout.toString()).toBe("vm-1\nvm-2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// 11. where the enrolled tokens live: the variable name, the worked command, and
//     the inputs table's pointer to it
// -----------------------------------------------------------------------------

/**
 * `docker/observe-ssh`'s own `targets_var=` assignment inside its `vm)` case
 * arm (not the `docker)` arm right above it, which assigns the same-shaped
 * name for a different kind) — scoped by anchoring on the two-space `vm)` arm
 * head immediately followed by the four-space assignment line.
 */
function vmTargetsVarFromObserveSsh(src: string): string {
  const m = src.match(/\n {2}vm\)\n {4}targets_var=([A-Z_]+)\n/);
  expect(m, "docker/observe-ssh's `vm)` case arm's targets_var assignment is gone — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/** The skill's "Where the enrolled tokens live" paragraph, located once and reused by the extractors below. */
function enrolledTokensPassage(src: string): string {
  const marker = "**Where the enrolled tokens live.**";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the skill's 'Where the enrolled tokens live' paragraph is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt);
  const endAt = after.indexOf("\n\nRead the exit status");
  expect(endAt, "the 'Where the enrolled tokens live' passage never reaches the exit-table lead-in — this probe has rotted").toBeGreaterThan(0);
  return after.slice(0, endAt);
}

/** The `$VARNAME` the passage names as "the value of `$<VAR>`" — the variable the worker is told to read. */
function enrolledTokensVarFromSkill(src: string): string {
  const passage = enrolledTokensPassage(src);
  const m = passage.match(/value of `\$([A-Z_]+)`/);
  expect(m, "the skill's 'value of $<VAR>' statement is gone from the enrolled-tokens passage — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/** The ```sh fenced worked command inside the passage. */
function enrolledTokensCommandFromSkill(src: string): string {
  const passage = enrolledTokensPassage(src);
  const fenceStart = passage.indexOf("```sh");
  expect(fenceStart, "no ```sh fence found in the enrolled-tokens passage — this probe has rotted").toBeGreaterThanOrEqual(0);
  const bodyStart = fenceStart + "```sh".length;
  const fenceEnd = passage.indexOf("```", bodyStart);
  expect(fenceEnd, "the enrolled-tokens passage's ```sh fence never closes — this probe has rotted").toBeGreaterThan(bodyStart);
  return passage.slice(bodyStart, fenceEnd);
}

/** The brief-inputs table's `target` row, "| Input | Form | Default when absent |" through its first data row starting `| target `. */
function inputsTableTargetRow(src: string): string {
  const heading = "| Input | Form | Default when absent |";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's brief-inputs table header is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt);
  const m = after.match(/\n\|\s*target\s*\|.*\|\s*\n/);
  expect(m, "the brief-inputs table's target row is gone — this probe has rotted").not.toBeNull();
  return m![0]!;
}

describe("the skill's enrolled-tokens variable equals docker/observe-ssh's real targets_var for vm", () => {
  test("the variable named in 'value of $<VAR>' is docker/observe-ssh's own vm targets_var", () => {
    const real = vmTargetsVarFromObserveSsh(OBSERVE_SSH);
    const stated = enrolledTokensVarFromSkill(SKILL);
    expect(stated, `the skill tells the worker to read $${stated}; docker/observe-ssh's vm case arm assigns targets_var=${real}`).toBe(real);
  });
});

describe("the skill's worked command reads the variable, never a hard-coded /secrets/ path", () => {
  test("the command references the real variable by name", () => {
    const real = vmTargetsVarFromObserveSsh(OBSERVE_SSH);
    const command = enrolledTokensCommandFromSkill(SKILL);
    expect(command, `the worked command does not reference "$${real}"`).toContain(`"$${real}"`);
  });

  test("the command never hard-codes a /secrets/ path", () => {
    const command = enrolledTokensCommandFromSkill(SKILL);
    expect(command, `the worked command hard-codes a /secrets/ path instead of reading the variable: ${JSON.stringify(command)}`).not.toMatch(
      /\/secrets\//,
    );
  });
});

describe("the brief-inputs table's target row points at the enrolled-tokens passage", () => {
  test("the target row names the 'Where the enrolled tokens live' passage", () => {
    const row = inputsTableTargetRow(SKILL);
    expect(row, `the target row does not point at the enrolled-tokens passage: ${JSON.stringify(row)}`).toContain(
      "Where the enrolled tokens live",
    );
  });
});
