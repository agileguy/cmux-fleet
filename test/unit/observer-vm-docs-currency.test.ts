/**
 * `skills/observer-vm-ops/SKILL.md` pinned to `scripts/observe/vm-forced-command`, the credential's
 * only enforcement (SRD-OBSERVER-ROLES §6.2-6.4), and to the two other places that restate the same
 * verb set in prose: `roles/observer-vm.md`'s role prompt and `docker/observe-vm`'s `--help` usage
 * text. Every file is read as text, in the style of `docs-currency.test.ts` and
 * `observer-docker-docs-currency.test.ts`; `vm-forced-command` is `sh` and cannot be imported.
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
 *     the `priority=` digit range, and `disk`'s `timeout` bound — equals what the script enforces
 *     or runs, each value read from both files rather than hard-coded here
 *  4. every extraction proves it found something before it is used, so a moved heading or a
 *     rewritten sentence fails loudly instead of letting a comparison pass on an empty set
 *
 * Not covered: `docker/observe-ssh`'s own refusal text (`observe-ssh: refused before ssh ran`) —
 * that shim is shared with `observer-docker-ops` and is already pinned by
 * `observer-docker-docs-currency.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SKILL_PATH = "skills/observer-vm-ops/SKILL.md";
const FORCED_COMMAND_PATH = "scripts/observe/vm-forced-command";
const ROLE_PATH = "roles/observer-vm.md";
const USAGE_PATH = "docker/observe-vm";

const SKILL = read(SKILL_PATH);
const FORCED_COMMAND = read(FORCED_COMMAND_PATH);
const ROLE = read(ROLE_PATH);
const USAGE = read(USAGE_PATH);

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
  expect(nums.length, "no '<N>-second' statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(2);
  return nums;
}

describe("the skill's lines= cap matches is_lines()'s real upper bound", () => {
  test("every 'M <= N' / '1 to N' / 'capped at N' statement equals the script's real cap", () => {
    const real = linesCapFromScript(FORCED_COMMAND);
    for (const stated of linesCapMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a lines= cap of ${stated}, is_lines() enforces ${real}`).toBe(real);
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

  test("the real first-digit charset excludes '0' — since=0s is genuinely refused by the script, not just described that way", () => {
    const charset = sinceFirstDigitCharsetFromScript(FORCED_COMMAND);
    expect(charset.includes("0"), `is_since_n()'s first-digit charset "${charset}" includes '0'`).toBe(false);
  });

  test("the skill states since=0s is refused", () => {
    expect(SKILL).toMatch(/`since=0s`\s+is refused/);
  });
});

describe("the skill's priority= digit range matches is_priority()'s real bracket expression", () => {
  test("every stated low-high pair equals the script's real bounds", () => {
    const chars = priorityCharsFromScript(FORCED_COMMAND);
    const realLow = chars[0]!;
    const realHigh = chars[chars.length - 1]!;
    for (const [low, high] of priorityRangeMentionsFromSkill(SKILL)) {
      expect(
        [low, high],
        `the skill states a priority range of ${low}-${high}, is_priority() enforces ${realLow}-${realHigh}`,
      ).toEqual([realLow, realHigh]);
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
