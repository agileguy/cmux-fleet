/**
 * `skills/observer-docker-ops/SKILL.md` pinned to the scripts it documents (SRD-OBSERVER-ROLES §5.2,
 * §5.4). A worker routes each exit by the stderr text the skill quotes, so the skill's verbs, events
 * actions and quoted refusal lines must match what the scripts accept and print. Every file is read
 * as text, in the style of `docs-currency.test.ts`; `docker-forced-command` is `sh` and cannot be
 * imported.
 *
 *  1. the skill's verb set equals `docker-forced-command`'s verb `case` arms (the extractor fails
 *     loudly, rather than silently skipping, on any two-space-indented arm head it does not recognise)
 *  2. the skill's events actions equal the `event=` filters in
 *     `test/fixtures/observe/docker-cli-shapes.json` `.events.action_allowlist.filters`
 *  3. the skill quotes `observe-ssh: refused before ssh ran`, and `docker/observe-ssh` prints it
 *  4. the skill quotes the forced command's unknown-verb refusal line, prefix included
 *  5. "not a recognised verb" appears in exactly one `refuse()` message in `docker-forced-command`,
 *     and it is the catch-all `*)` arm's
 *  6. the skill's tail= cap and since=/tail= digit ceiling equal the script's `-le` cap and
 *     `DIGITS_MAX`, read from both files rather than hard-coded here
 *  7. the skill's exit-1 row's quoted stderr fragments are each measured in a real docker_errors
 *     stderr line (both docker versions), and `docker/observe-docker`'s `--help` text names every
 *     one of them plus "not a recognised verb"
 *
 *  8. the skill's action-verb rule — an action the checks (`state`, `health`, `logs`, `stats`,
 *     `events`) have no row for is recorded on `state` as `forbidden` — names a real channel
 *     (`ObserverDockerChannelSchema`) and the real coverage/task words (`forbidden`,
 *     `indeterminate`, `blocked`, `not_attempted`)
 *
 *  9. the skill's survey-then-filter rule ("Surveying containers when the brief names none"):
 *     the worked command's jq projection is exactly `{Names, State, Status}` (set equality, still
 *     checked as a subset of `PS_FORMAT`'s fields read from `docker-forced-command`, never
 *     hard-coded here); the worked command, run EXACTLY as extracted under both `bash` and `sh`
 *     with `observe-docker` on PATH as a real executable stub (never a shell function — the
 *     hyphenated name is invalid there) that prints a partial line and exits 255, actually PRINTS
 *     that captured status on its own line rather than jq's (a piped `pipefail` form cannot —
 *     pipefail reports the RIGHTMOST failure, and the worker's bash tool starts a new shell per
 *     call so a bare `$rc` never survives to be read back); and the input table's `selector`
 *     default names the rule
 *
 * 10. the skill's "where the tokens are" passage: the variable it tells the worker to read for
 *     the docker kind equals the one `docker/observe-ssh` assigns in its `docker)` case arm (read
 *     from that file's text, never hard-coded here), the worked listing command reads that
 *     variable rather than a literal `/secrets/...` path (matched as a whole identifier, not a
 *     prefix), and the input table's `target` row points at the passage
 *
 * 11. the token-listing `awk` command, extracted from the skill, actually runs under `sh` against
 *     a constructed targets file (a `#` comment line, a blank line, space- and tab-separated
 *     fields, two targets) and prints exactly the two tokens, one per line — never the host, port
 *     or user
 *
 * 12. a `docker/observe-ssh` refusal that names the targets file and a line number
 *     (`<targets_var> line <n>`) is documented as a fleet configuration fault — `blocked`,
 *     `indeterminate`, no retry — in its own table row, ordered ABOVE the generic "your own call
 *     was malformed" row (the table is read top to bottom, first match wins), and the quoted
 *     wording is pinned against `docker/observe-ssh`'s own `refuse()` text
 *
 * Not covered, in general: when a channel is `forbidden` rather than a call to fix — that is prose
 * judgement, except for the one case choice 8 pins: an action verb (restart, stop, start, kill, rm,
 * exec, pause, or any other change to a container) is always `forbidden` on `state`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ObserverAssessmentSchema,
  ObserverCoverageResultSchema,
  ObserverDockerChannelSchema,
} from "../../src/harvest/observer-target-artifacts.ts";
import { StatusSchema } from "../../src/contracts.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SKILL_PATH = "skills/observer-docker-ops/SKILL.md";
const FORCED_COMMAND_PATH = "scripts/observe/docker-forced-command";
const OBSERVE_SSH_PATH = "docker/observe-ssh";
const OBSERVE_DOCKER_PATH = "docker/observe-docker";
const SHAPES_FIXTURE_PATH = "test/fixtures/observe/docker-cli-shapes.json";
const RENDERED_FIXTURE_PATH = "test/fixtures/observe/docker-forced-command-rendered.json";

const SKILL = read(SKILL_PATH);
const FORCED_COMMAND = read(FORCED_COMMAND_PATH);
const OBSERVE_SSH = read(OBSERVE_SSH_PATH);
const OBSERVE_DOCKER = read(OBSERVE_DOCKER_PATH);

// -----------------------------------------------------------------------------
// 1. verb set: the skill's table vs. the forced command's `case` arms
// -----------------------------------------------------------------------------

/**
 * Every two-space-indented line inside `case ${verb} in ... esac` is an arm
 * head; nested `case` blocks sit deeper. Each must be `*)` or `<verb>)`, and
 * any other shape fails here, because a regex that skipped it would leave a new
 * arm uncounted on both sides of the comparison.
 */
function verbsFromForcedCommand(src: string): Set<string> {
  const start = src.indexOf("case ${verb} in");
  expect(start, "docker-forced-command's `case ${verb} in` is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
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
    expect(m, `an arm head in docker-forced-command's verb case does not fit "*)" or "  <verb>)": ${JSON.stringify(line)}`).not.toBeNull();
    verbs.push(m![1]!);
  }
  expect(verbs.length, "no verb arms matched in the case block — the extractor has rotted").toBeGreaterThanOrEqual(6);
  return new Set(verbs);
}

/**
 * `| `<verb>` | ... | ... |` rows inside "## The verb grammar", up to the
 * next `## ` heading. Rows only — the header row (`| Verb | ... |`) has no
 * backticks around `Verb` and does not match.
 */
function verbsFromSkill(src: string): Set<string> {
  const heading = "## The verb grammar";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's `## The verb grammar` heading is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt + heading.length);
  const nextHeadingOffset = after.search(/\n## /);
  const section = nextHeadingOffset === -1 ? after : after.slice(0, nextHeadingOffset);
  const verbs = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
  expect(verbs.length, "no verb rows matched in the skill's table — the extractor has rotted").toBeGreaterThanOrEqual(6);
  return new Set(verbs);
}

describe("the skill's verb set is exactly the forced command's verb arms", () => {
  test("every verb the forced command accepts is one the skill documents", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromSkill(SKILL);
    const missing = [...real].filter((v) => !documented.has(v));
    expect(missing, `docker-forced-command accepts these verbs and the skill does not list them: ${missing.join(", ")}`).toEqual([]);
  });

  test("every verb the skill documents is one the forced command accepts", () => {
    const real = verbsFromForcedCommand(FORCED_COMMAND);
    const documented = verbsFromSkill(SKILL);
    const bogus = [...documented].filter((v) => !real.has(v));
    expect(bogus, `the skill documents these verbs and docker-forced-command does not accept them: ${bogus.join(", ")}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 2. events actions: the skill's list vs. the measured fixture's filters
// -----------------------------------------------------------------------------

/** The `event=<action>` filter values out of the MEASURED shapes fixture, never retyped by hand. */
function eventsActionsFromFixture(): string[] {
  const shapes = JSON.parse(read(SHAPES_FIXTURE_PATH)) as {
    events: { action_allowlist: { filters: string[] } };
  };
  const filters = shapes.events?.action_allowlist?.filters ?? [];
  expect(filters.length, "the shapes fixture's .events.action_allowlist.filters is empty — this probe has rotted").toBeGreaterThan(0);
  const actions = filters.filter((f) => f.startsWith("event=")).map((f) => f.slice("event=".length));
  expect(actions.length, "no event= filters found in the shapes fixture — the extractor has rotted").toBeGreaterThanOrEqual(6);
  return actions;
}

/**
 * The backtick-quoted action words in the skill's "`events` returns container
 * lifecycle and health events only:" sentence, up to its "— eleven actions"
 * anchor. Anchored to that sentence, not the whole document, so a mutation
 * elsewhere in the file cannot satisfy it by accident.
 */
function eventsActionsFromSkill(src: string): string[] {
  const marker = "returns container lifecycle and health events only:**";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the skill's events-actions sentence is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt + marker.length);
  const anchor = "eleven actions";
  const anchorAt = after.indexOf(anchor);
  expect(anchorAt, "the skill's 'eleven actions' anchor is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const listText = after.slice(0, anchorAt);
  const actions = [...listText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
  expect(actions.length, "no action words matched before the anchor — the extractor has rotted").toBeGreaterThanOrEqual(6);
  return actions;
}

describe("the skill's events-action list equals the measured action allowlist", () => {
  test("every action the fixture measures is one the skill lists", () => {
    const measured = new Set(eventsActionsFromFixture());
    const documented = new Set(eventsActionsFromSkill(SKILL));
    const missing = [...measured].filter((a) => !documented.has(a));
    expect(missing, `the shapes fixture measures these actions and the skill does not list them: ${missing.join(", ")}`).toEqual([]);
  });

  test("every action the skill lists is one the fixture measures", () => {
    const measured = new Set(eventsActionsFromFixture());
    const documented = new Set(eventsActionsFromSkill(SKILL));
    const bogus = [...documented].filter((a) => !measured.has(a));
    expect(bogus, `the skill lists these actions and the shapes fixture never measured them: ${bogus.join(", ")}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 3. the shim's own refusal text
// -----------------------------------------------------------------------------

describe("the skill quotes the shim's own refusal text, and observe-ssh actually prints it", () => {
  const NEEDLE = "observe-ssh: refused before ssh ran";

  test("the skill quotes it", () => {
    expect(SKILL).toContain(NEEDLE);
  });

  test("docker/observe-ssh's refuse() actually prints it", () => {
    // CONTROL: the printf line this proves exists, read straight from source,
    // so a rewritten refuse() that drops the phrase turns this red rather
    // than the assertion above alone (which the skill's own text could
    // satisfy by coincidence if this test did not also read the shim).
    expect(OBSERVE_SSH).toMatch(/printf 'observe-ssh: refused before ssh ran: /);
    expect(OBSERVE_SSH).toContain(NEEDLE);
  });
});

// -----------------------------------------------------------------------------
// 4. the forced command's verb-refusal wording
// -----------------------------------------------------------------------------

/** The catch-all `*)` arm's `refuse "${verb}" "..."` message, read from source. */
function unknownVerbRefusalMessage(src: string): string {
  const m = src.match(/\*\)\s*\n\s*refuse "\$\{verb\}" "([^"]+)"\s*\n\s*;;\s*\nesac/);
  expect(m, "the catch-all verb-refusal arm in docker-forced-command has changed shape — this probe has rotted").not.toBeNull();
  return m![1]!;
}

describe("the skill's verb-refusal wording is exactly what the forced command prints", () => {
  test("the forced command's unknown-verb line is the one the skill quotes", () => {
    const FRAGMENT = "not a recognised verb";
    expect(SKILL).toContain(`docker-forced-command: refused "<verb>": ${FRAGMENT}`);
    // The prefix comes from refuse(), the reason from the catch-all arm; the skill quotes both.
    expect(FORCED_COMMAND).toContain(String.raw`printf 'docker-forced-command: refused "%s": %s\n'`);
    const real = unknownVerbRefusalMessage(FORCED_COMMAND);
    expect(
      real.startsWith(FRAGMENT),
      `docker-forced-command's unknown-verb message is "${real}", which does not start with "${FRAGMENT}"`,
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 5. "not a recognised verb" names exactly one refuse() message, the catch-all's
// -----------------------------------------------------------------------------

/** Every `refuse "<first>" "<reason>"` call's reason string, read from source, in call order. */
function refuseReasons(src: string): string[] {
  const reasons = [...src.matchAll(/refuse\s+"[^"]*"\s+"([^"]*)"/g)].map((m) => m[1]!);
  // CONTROL: this script has many refuse() call sites; a pattern that stopped
  // matching any of them would make the uniqueness check below pass vacuously
  // (zero occurrences of the fragment "is" a unique count of zero, not one).
  expect(reasons.length, "no refuse() calls matched in docker-forced-command — the extractor has rotted").toBeGreaterThanOrEqual(20);
  return reasons;
}

describe('"not a recognised verb" appears in exactly one refuse() message, the catch-all\'s', () => {
  const FRAGMENT = "not a recognised verb";

  test("exactly one refuse() reason contains the phrase", () => {
    const withFragment = refuseReasons(FORCED_COMMAND).filter((r) => r.includes(FRAGMENT));
    expect(
      withFragment,
      `expected exactly one refuse() reason to contain "${FRAGMENT}", found: ${JSON.stringify(withFragment)}`,
    ).toHaveLength(1);
  });

  test("that one reason is the catch-all `*)` arm's", () => {
    const catchAll = unknownVerbRefusalMessage(FORCED_COMMAND);
    expect(catchAll.includes(FRAGMENT), `the catch-all arm's message ("${catchAll}") does not contain "${FRAGMENT}"`).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 6. numeric limits: the skill's tail= cap and since=/tail= digit ceiling
//    match the script that actually enforces them. Both numbers are read
//    from the files below — neither is hard-coded here.
// -----------------------------------------------------------------------------

/** The real, enforced tail cap: the numeric literal in `[ "${value}" -le <N> ]`. */
function tailCapFromScript(src: string): number {
  const m = src.match(/\[\s*"\$\{value\}"\s*-le\s*(\d+)\s*\]/);
  expect(m, "docker-forced-command's tail `-le` cap check is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/** The real digit-count ceiling: the `DIGITS_MAX=<N>` assignment. */
function digitsMaxFromScript(src: string): number {
  const m = src.match(/^DIGITS_MAX=(\d+)$/m);
  expect(m, "docker-forced-command's DIGITS_MAX assignment is gone — this probe has rotted").not.toBeNull();
  return Number(m![1]);
}

/**
 * Every place the skill states the tail cap as a number: the verb-grammar
 * table's `M <= <N>`, the measured-facts bullet's "capped at <N>", and the
 * "Bounded reads" section's "caps it at <N>". Illustrative uses of the cap
 * elsewhere (e.g. a `tail=500` example computing the 50KB-wall math) are not
 * statements of the cap and are deliberately not matched here.
 */
function tailCapMentionsFromSkill(src: string): number[] {
  const nums = [
    ...[...src.matchAll(/M <= (\d+)/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/capped at (\d+)\b/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/caps it at\s+(\d+)\b/g)].map((m) => Number(m[1])),
  ];
  expect(nums.length, "no tail-cap statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(3);
  return nums;
}

/** Every "`<N> to <M> digits`" statement of the since=/tail= digit-count ceiling (the digit count spans a markdown line wrap, hence `\s+`). */
function digitsMaxMentionsFromSkill(src: string): number[] {
  const nums = [...src.matchAll(/\d+\s+to\s+(\d+)\s+digits/g)].map((m) => Number(m[1]));
  expect(nums.length, "no '<N> to <M> digits' statements matched in the skill — the extractor has rotted").toBeGreaterThanOrEqual(2);
  return nums;
}

describe("the skill's numeric limits match the script that enforces them", () => {
  test("every tail-cap number the skill states equals the script's -le cap", () => {
    const real = tailCapFromScript(FORCED_COMMAND);
    for (const stated of tailCapMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a tail cap of ${stated}, docker-forced-command enforces -le ${real}`).toBe(real);
    }
  });

  test("every since=/tail= digit ceiling the skill states equals DIGITS_MAX", () => {
    const real = digitsMaxFromScript(FORCED_COMMAND);
    for (const stated of digitsMaxMentionsFromSkill(SKILL)) {
      expect(stated, `the skill states a digit ceiling of ${stated}, docker-forced-command's DIGITS_MAX is ${real}`).toBe(real);
    }
  });
});

// -----------------------------------------------------------------------------
// 7. exit-1 fragments: the skill's quoted stderr text vs. measured docker_errors,
//    and observe-docker's --help text naming all of them
// -----------------------------------------------------------------------------

/** The backtick-quoted fragments in the skill's `| \`1\` with ... on stderr |` table row. */
function exit1FragmentsFromSkill(src: string): string[] {
  const marker = "| `1` with ";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the skill's exit-1 table row is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt + marker.length);
  const anchor = " on stderr |";
  const anchorAt = after.indexOf(anchor);
  expect(anchorAt, "the skill's exit-1 row's 'on stderr' anchor is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const listText = after.slice(0, anchorAt);
  const fragments = [...listText.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  expect(fragments.length, "no backticked fragments matched in the skill's exit-1 row — the extractor has rotted").toBeGreaterThanOrEqual(3);
  return fragments;
}

/** `.runs[<version>].docker_errors.{daemon_unreachable,socket_permission_denied}.stderr_first_line`, one row per version per kind, read from the MEASURED rendered fixture. */
function stderrLinesFromFixture(): { version: string; kind: string; line: string }[] {
  const fixture = JSON.parse(read(RENDERED_FIXTURE_PATH)) as {
    runs: Record<string, { docker_errors?: Record<string, { stderr_first_line?: string }> }>;
  };
  const versions = Object.keys(fixture.runs ?? {});
  expect(versions.length, "the rendered fixture has no .runs versions — this probe has rotted").toBeGreaterThanOrEqual(2);
  const lines: { version: string; kind: string; line: string }[] = [];
  for (const version of versions) {
    for (const kind of ["daemon_unreachable", "socket_permission_denied"]) {
      const line = fixture.runs[version]?.docker_errors?.[kind]?.stderr_first_line;
      expect(line, `the rendered fixture is missing .runs["${version}"].docker_errors.${kind}.stderr_first_line`).toBeTruthy();
      lines.push({ version, kind, line: line! });
    }
  }
  return lines;
}

describe("the skill's exit-1 fragments match measured docker_errors, and --help names them", () => {
  test("every quoted fragment occurs in at least one measured stderr_first_line", () => {
    const fragments = exit1FragmentsFromSkill(SKILL);
    const lines = stderrLinesFromFixture();
    for (const fragment of fragments) {
      const hit = lines.some(({ line }) => line.includes(fragment));
      expect(hit, `no docker_errors stderr_first_line contains the skill's quoted fragment "${fragment}"`).toBe(true);
    }
  });

  test("every measured stderr_first_line contains at least one quoted fragment", () => {
    const fragments = exit1FragmentsFromSkill(SKILL);
    const lines = stderrLinesFromFixture();
    for (const { version, kind, line } of lines) {
      const hit = fragments.some((fragment) => line.includes(fragment));
      expect(hit, `docker_errors.${kind}.stderr_first_line for docker ${version} ("${line}") matches none of the skill's quoted fragments`).toBe(true);
    }
  });

  test("observe-docker --help names every fragment and the verb-refusal phrase", () => {
    const fragments = exit1FragmentsFromSkill(SKILL);
    for (const fragment of fragments) {
      expect(OBSERVE_DOCKER.includes(fragment), `docker/observe-docker's --help text does not name "${fragment}"`).toBe(true);
    }
    expect(
      OBSERVE_DOCKER.includes("not a recognised verb"),
      'docker/observe-docker\'s --help text does not name "not a recognised verb"',
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 8. the action-verb rule: an action the checks have no row for still names a
//    real channel, `forbidden`, and the other real coverage/task words
// -----------------------------------------------------------------------------

/**
 * The action-verb rule bullet, anchored on its own lead sentence and closed
 * at the next list item or blank line, so a mutation elsewhere in the file
 * cannot satisfy anything below by accident.
 */
function actionVerbRuleBullet(src: string): string {
  const marker = "**An action verb — restart, stop, start, kill, rm, exec, pause, or any other change to a";
  const markerAt = src.indexOf(marker);
  expect(markerAt, "the skill's action-verb rule bullet is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(markerAt);
  const ends = [after.indexOf("\n\n"), after.indexOf("\n- ")].filter((i) => i > 0);
  expect(ends.length, "the action-verb rule bullet never ends — this probe has rotted").toBeGreaterThan(0);
  return after.slice(0, Math.min(...ends));
}

describe("the skill's action-verb rule names a real channel for an action the checks have no row for", () => {
  const DOCKER_CHANNELS = new Set<string>(ObserverDockerChannelSchema.options);

  test("the rule records the channel as `state` — a real member of ObserverDockerChannelSchema", () => {
    const bullet = actionVerbRuleBullet(SKILL);
    const m = bullet.match(/Record `([a-z]+)` as `forbidden`/);
    expect(m, "the rule's 'Record `<channel>` as `forbidden`' sentence is gone — this probe has rotted").not.toBeNull();
    const channel = m![1]!;
    expect(DOCKER_CHANNELS.has(channel), `the rule records "${channel}" as the channel, which is not a member of ObserverDockerChannelSchema (${[...DOCKER_CHANNELS].join(", ")})`).toBe(true);
    expect(channel).toBe("state");
  });

  test("the rule marks the row `indeterminate`, the refusal in `evidence_ref`, the task `blocked` — and says `not_attempted` is wrong here", () => {
    const bullet = actionVerbRuleBullet(SKILL);
    const COVERAGE_RESULTS = new Set<string>(ObserverCoverageResultSchema.options);
    const ASSESSMENTS = new Set<string>(ObserverAssessmentSchema.options);
    const STATUSES = new Set<string>(StatusSchema.options);
    expect(bullet).toContain("`forbidden`");
    expect(bullet).toContain("`indeterminate`");
    expect(bullet).toContain("`blocked`");
    expect(bullet).toContain("`evidence_ref`");
    expect(bullet).toContain("`not_attempted`");
    expect(COVERAGE_RESULTS.has("forbidden")).toBe(true);
    expect(ASSESSMENTS.has("indeterminate")).toBe(true);
    expect(STATUSES.has("blocked")).toBe(true);
    expect(COVERAGE_RESULTS.has("not_attempted")).toBe(true);
    expect(bullet, "the rule does not say marking every channel not_attempted is wrong here").toMatch(/not_attempted`\s+is wrong/);
  });

  test("the exit table's `77` unrecognised-verb row points at the action-verb bullet itself", () => {
    // Extract the 77 unrecognised-verb ROW alone, not a whole-file toContain,
    // so a pointer phrase that merely exists somewhere else in the file
    // cannot satisfy this by accident.
    const marker = '| `77` with `docker-forced-command: refused "<verb>": not a recognised verb';
    const markerAt = SKILL.indexOf(marker);
    expect(markerAt, "the skill's 77 unrecognised-verb table row is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
    const lineEnd = SKILL.indexOf("\n", markerAt);
    expect(lineEnd, "the 77 unrecognised-verb row never ends — this probe has rotted").toBeGreaterThan(markerAt);
    const row = SKILL.slice(markerAt, lineEnd);

    // The phrase the row uses to identify the bullet must actually be how the
    // action-verb bullet itself starts — the same anchor choice 8's
    // `actionVerbRuleBullet` uses — so a row that names some OTHER bullet, or
    // one that has drifted from the bullet's real wording, goes red.
    const pointerPhrase = "An action verb — restart, stop, start, kill, rm, exec, pause";
    expect(row, "the 77 row no longer names the action-verb bullet by a phrase that identifies it").toContain(pointerPhrase);
    const bullet = actionVerbRuleBullet(SKILL);
    expect(bullet, "the phrase the 77 row points at is not how the action-verb bullet actually starts").toContain(pointerPhrase);
  });
});

// -----------------------------------------------------------------------------
// 9. the survey-then-filter rule: the worked command's jq projection keeps
//    only real `ps` template fields, the worked command preserves
//    observe-docker's exit code through the pipe, and the input table's
//    selector default points at the rule.
// -----------------------------------------------------------------------------

/**
 * The "## Surveying containers when the brief names none" section, from its
 * own heading to the next `## ` heading. Anchored on the heading text, so a
 * mutation that drops the whole section turns this red rather than silently
 * matching an unrelated part of the file.
 */
function surveySection(src: string): string {
  const heading = "## Surveying containers when the brief names none";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's 'Surveying containers when the brief names none' heading is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt + heading.length);
  const nextHeadingOffset = after.search(/\n## /);
  return nextHeadingOffset === -1 ? after : after.slice(0, nextHeadingOffset);
}

/** The fenced worked command inside the survey section — the recipe itself, not prose about it. */
function surveyWorkedCommand(src: string): string {
  const section = surveySection(src);
  const m = section.match(/```\n([\s\S]*?)\n```/);
  expect(m, "the survey section's fenced worked command is gone — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/** The jq projection's field names, out of the worked command's `{Field, Field, ...}` object literal. */
function jqProjectionFields(command: string): string[] {
  const m = command.match(/jq\s+-c\s+'\{([^}]*)\}'/);
  expect(m, "the worked command's jq projection literal is gone — this probe has rotted").not.toBeNull();
  const fields = m![1]!.split(",").map((f) => f.trim()).filter(Boolean);
  expect(fields.length, "no fields matched in the jq projection literal — the extractor has rotted").toBeGreaterThanOrEqual(1);
  return fields;
}

/**
 * The real `ps` template's field set: the keys in `docker-forced-command`'s
 * `PS_FORMAT` literal, read from source — never retyped by hand here. This is
 * the same 11-field template the skill's measured-facts bullet describes.
 */
function psTemplateFieldsFromForcedCommand(src: string): Set<string> {
  const m = src.match(/^PS_FORMAT='(\{.*\})'$/m);
  expect(m, "docker-forced-command's PS_FORMAT literal is gone — this probe has rotted").not.toBeNull();
  const fields = [...m![1]!.matchAll(/"([A-Za-z]+)":\{\{json/g)].map((mm) => mm[1]!);
  expect(fields.length, "no fields matched in PS_FORMAT — the extractor has rotted").toBeGreaterThanOrEqual(9);
  return new Set(fields);
}

describe("the survey-then-filter rule's jq projection only ever keeps real ps template fields", () => {
  test("every field the worked command's jq projection keeps is in the forced command's ps template", () => {
    const command = surveyWorkedCommand(SKILL);
    const projected = jqProjectionFields(command);
    const real = psTemplateFieldsFromForcedCommand(FORCED_COMMAND);
    const bogus = projected.filter((f) => !real.has(f));
    expect(bogus, `the worked command's jq projection keeps these fields and docker-forced-command's ps template does not have them: ${bogus.join(", ")}`).toEqual([]);
  });

  test("the projection is exactly {Names, State, Status} — widening it (e.g. to Labels) goes red", () => {
    const command = surveyWorkedCommand(SKILL);
    const projected = new Set(jqProjectionFields(command));
    expect(projected).toEqual(new Set(["Names", "State", "Status"]));
  });
});

describe("the survey-then-filter rule's worked command prints observe-docker's own exit status, not jq's", () => {
  /**
   * Runs `command` EXACTLY as extracted from the skill — no harness-appended
   * echo of its own — under `shell`, with `observe-docker` on PATH as a REAL
   * EXECUTABLE SCRIPT in a temp dir, never a shell function: `observe-docker`
   * is not a valid function name in sh or dash (the hyphen makes it so), so a
   * function definition would itself fail to parse there, silently hiding the
   * very regression this test exists to catch. The stub prints a PARTIAL
   * JSON line with NO trailing newline and exits 255 — the exact scenario the
   * skill's prose measures (an ssh drop mid-stream, or a 77 with non-JSON
   * output). `<target>` is the skill's documentation placeholder, never meant
   * to be typed literally, so it is substituted with a plain word before the
   * shell ever sees it; the stub ignores its arguments regardless.
   *
   * The captured status is read back from the `observe-docker exit: <n>`
   * line the worked command itself is now required to print, since the
   * worker's bash tool starts a new shell per call and `$rc` alone would not
   * survive to be read.
   */
  function runWorkedCommand(shell: "bash" | "sh", command: string): { statusLine: string | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "observe-docker-stub-"));
    try {
      const stubPath = join(dir, "observe-docker");
      writeFileSync(stubPath, ["#!/bin/sh", "printf '{\"Names\":\"a\"'", "exit 255", ""].join("\n"), { mode: 0o755 });
      const script = command.replace(/<target>/g, "test-target");
      const proc = Bun.spawnSync([shell, "-c", script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString();
      const m = stdout.match(/observe-docker exit: (\S+)/);
      return { statusLine: m ? m[1]! : null, stdout, stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("bash: the printed status line carries 255 — observe-docker's own status — even though jq then fails on the partial line", () => {
    const command = surveyWorkedCommand(SKILL);
    const { statusLine, stdout, stderr } = runWorkedCommand("bash", command);
    expect(
      statusLine,
      `no "observe-docker exit: <n>" line in output (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    ).not.toBeNull();
    expect(Number(statusLine)).toBe(255);
  });

  test("sh: the printed status line carries 255 too — the worked command is POSIX, not bash-only", () => {
    const command = surveyWorkedCommand(SKILL);
    const { statusLine, stdout, stderr } = runWorkedCommand("sh", command);
    expect(
      statusLine,
      `no "observe-docker exit: <n>" line in output (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    ).not.toBeNull();
    expect(Number(statusLine)).toBe(255);
  });

  test("a mutant with the status-printing part removed prints no status line at all — this probe would catch that regression", () => {
    // Derived from the REAL worked command by stripping its own trailing
    // status-print segment, rather than hand-typing the old wording, so this
    // stays anchored to whatever the worked command actually says (mutation
    // item 1: "remove the status print from SKILL.md" goes red here).
    const command = surveyWorkedCommand(SKILL);
    const mutated = command.replace(/;\s*printf 'observe-docker exit: %s\\n' "\$rc"\s*$/, "");
    expect(mutated, "could not strip the status-print segment from the worked command — the extractor has rotted").not.toBe(command);
    const { statusLine, stdout } = runWorkedCommand("bash", mutated);
    expect(statusLine, `expected no status line after stripping the print, but got: ${JSON.stringify(stdout)}`).toBeNull();
  });
});

describe("the input table's selector default points at the survey-then-filter rule", () => {
  test("the selector row's default cell names the rule's heading", () => {
    const rows = [...SKILL.matchAll(/^\| selector \|.*\|$/gm)];
    expect(rows.length, "the input table's selector row is gone — this probe has rotted").toBeGreaterThanOrEqual(1);
    expect(rows[0]![0]!).toContain("Surveying containers when the brief names none");
  });

  test("the heading the pointer names actually exists in the skill", () => {
    expect(SKILL).toContain("## Surveying containers when the brief names none");
  });
});

// -----------------------------------------------------------------------------
// 10. the tokens-file variable: the skill tells the worker to read the same
//     variable `docker/observe-ssh` assigns for the docker kind, the worked
//     listing command reads that variable rather than a literal path, and the
//     input table's `target` row points at the passage.
// -----------------------------------------------------------------------------

/**
 * `docker/observe-ssh`'s `targets_var=<NAME>` assignment inside the `docker)`
 * arm of `case ${kind} in`. Sliced to that arm alone (up to the `vm)` arm that
 * follows it), so a mutation that only touched the `vm)` arm's variable cannot
 * satisfy this by accident.
 */
function targetsVarFromObserveSsh(src: string): string {
  const armAt = src.indexOf("\n  docker)\n");
  expect(armAt, "docker/observe-ssh's `docker)` case arm is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const nextArmAt = src.indexOf("\n  vm)\n", armAt);
  expect(nextArmAt, "docker/observe-ssh's `vm)` case arm is gone — this probe has rotted").toBeGreaterThan(armAt);
  const block = src.slice(armAt, nextArmAt);
  const m = block.match(/targets_var=(\S+)/);
  expect(m, "no `targets_var=` assignment found in the docker) arm — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/**
 * The "## Calling the target, and reading its exit" section, from its own
 * heading to the next `## ` heading. Anchored on the heading text, so a
 * mutation that drops the whole section turns this red rather than silently
 * matching an unrelated part of the file. (This section is not the one
 * choice 9's `surveySection`/`surveyWorkedCommand` read — that is "##
 * Surveying containers when the brief names none" — so the two probes never
 * compete for the same fenced block.)
 */
function callingTargetSection(src: string): string {
  const heading = "## Calling the target, and reading its exit";
  const headingAt = src.indexOf(heading);
  expect(headingAt, "the skill's 'Calling the target, and reading its exit' heading is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const after = src.slice(headingAt + heading.length);
  const nextHeadingOffset = after.search(/\n## /);
  return nextHeadingOffset === -1 ? after : after.slice(0, nextHeadingOffset);
}

/** The fenced worked command that lists the enrolled tokens, inside that section. */
function tokensWorkedCommand(src: string): string {
  const section = callingTargetSection(src);
  const m = section.match(/```\n([\s\S]*?)\n```/);
  expect(m, "the 'Calling the target' section's fenced worked command is gone — this probe has rotted").not.toBeNull();
  return m![1]!;
}

/**
 * The shell variable name the worked command reads, e.g. `OBSERVER_DOCKER_TARGETS_FILE`
 * out of `"$OBSERVER_DOCKER_TARGETS_FILE"`. Matched as a whole shell identifier — letters
 * of EITHER case, digits and underscore, per POSIX's variable-name grammar — never a bare
 * substring check, so a rename to a merely-prefixed or merely-suffixed variant is caught
 * rather than passing by coincidence — the same reason choice 6's numeric extractors read
 * a full assignment, not a fragment. The character class must include lowercase: a class of
 * uppercase-digits-underscore only stops at the first lowercase character it meets, so it
 * would read `OBSERVER_DOCKER_TARGETS_FILE` out of `$OBSERVER_DOCKER_TARGETS_FILEx` too —
 * silently matching a PREFIX of a different, longer identifier, exactly the "merely-suffixed
 * variant" this docblock promises to catch.
 */
function tokensVarFromWorkedCommand(command: string): string {
  const m = command.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/);
  expect(m, "no shell variable reference found in the worked command — this probe has rotted").not.toBeNull();
  return m![1]!;
}

describe("the skill points the worker at the same tokens-file variable docker/observe-ssh reads for the docker kind", () => {
  test("the variable named in observe-ssh's docker) arm is the one the skill's worked command reads", () => {
    const real = targetsVarFromObserveSsh(OBSERVE_SSH);
    expect(real).toBe("OBSERVER_DOCKER_TARGETS_FILE");
    const command = tokensWorkedCommand(SKILL);
    const named = tokensVarFromWorkedCommand(command);
    expect(named, `the worked command reads $${named}, docker/observe-ssh's docker) arm assigns ${real}`).toBe(real);
  });

  test("the worked command reads the variable, not a literal /secrets/ path", () => {
    const command = tokensWorkedCommand(SKILL);
    expect(command, `the worked command names a literal /secrets/ path instead of reading the variable: ${JSON.stringify(command)}`).not.toMatch(/\/secrets\//);
  });

  test("the input table's target row points at the 'Calling the target' passage", () => {
    const rows = [...SKILL.matchAll(/^\| target \|.*\|$/gm)];
    expect(rows.length, "the input table's target row is gone — this probe has rotted").toBeGreaterThanOrEqual(1);
    expect(rows[0]![0]!).toContain("Calling the target, and reading its exit");
  });

  test("the heading the pointer names actually exists in the skill", () => {
    expect(SKILL).toContain("## Calling the target, and reading its exit");
  });
});

// -----------------------------------------------------------------------------
// 11. the token-listing awk command, extracted from the skill, actually runs
//     under `sh` and prints just the tokens — a real targets file, not a
//     description of one.
// -----------------------------------------------------------------------------

describe("the token-listing awk command actually extracts just the tokens", () => {
  test("stdout is exactly the two tokens, one per line — never the host, port or user", () => {
    const command = tokensWorkedCommand(SKILL);
    const dir = mkdtempSync(join(tmpdir(), "observer-docker-targets-"));
    const targetsFile = join(dir, "targets");
    try {
      writeFileSync(
        targetsFile,
        [
          "# a comment line, skipped",
          "",
          "alpha  docker-a.example 22 svc-a",
          "beta\tdocker-b.example\t2222\tsvc-b",
          "",
        ].join("\n"),
      );
      const proc = Bun.spawnSync(["sh", "-c", command], {
        env: { ...process.env, OBSERVER_DOCKER_TARGETS_FILE: targetsFile },
      });
      const stdout = proc.stdout.toString();
      expect(proc.exitCode, `awk exited non-zero; stderr was: ${proc.stderr.toString()}`).toBe(0);
      expect(stdout, `stderr was: ${proc.stderr.toString()}`).toBe("alpha\nbeta\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// 12. a docker/observe-ssh refusal that names the targets file and a line
//     number is documented as a fleet configuration fault, distinct from the
//     generic "your own call was malformed" row.
// -----------------------------------------------------------------------------

describe("a refused targets file is documented as a fleet configuration fault, not a malformed call", () => {
  const NEEDLE = "<targets_var> line <n>";

  /**
   * The fleet-configuration-fault paragraph below the table, anchored on its
   * OWN opening words and closed at its own blank line — the same
   * anchor-and-close shape `actionVerbRuleBullet` uses above for choice 8,
   * and the one the VM twin's equivalent passage is read by. A window
   * measured backwards a fixed distance from NEEDLE's first occurrence (the
   * old approach) could just as easily land on words from the table's new
   * row above, which quotes this same NEEDLE — anchoring on the paragraph's
   * own wording is what keeps this test reading the paragraph, specifically.
   */
  function fleetConfigFaultParagraph(src: string): string {
    const marker = "A `77` whose `observe-ssh: refused before ssh ran` line goes on to name `<targets_var> line <n>`";
    const markerAt = src.indexOf(marker);
    expect(markerAt, "the skill's fleet-configuration-fault paragraph is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
    const after = src.slice(markerAt);
    const end = after.indexOf("\n\n");
    expect(end, "the fleet-configuration-fault paragraph never ends — this probe has rotted").toBeGreaterThan(0);
    return after.slice(0, end);
  }

  test("the skill states it in one paragraph, with the real task/row words and no retry", () => {
    const paragraph = fleetConfigFaultParagraph(SKILL).replace(/\s+/g, " ");
    expect(paragraph).toContain(NEEDLE);
    expect(paragraph).toContain("configuration fault");
    expect(paragraph).toContain("`blocked`");
    expect(paragraph).toContain("`indeterminate`");
    expect(paragraph).toContain("no retry");
  });

  test("docker/observe-ssh actually refuses a malformed targets-file line with `${targets_var} line ${lineno}`", () => {
    // CONTROL: read straight from source, so a rewritten parse_line that
    // drops this wording turns this red rather than the skill's own prose
    // alone (which could satisfy the assertion above by coincidence).
    expect(OBSERVE_SSH).toContain('refuse "${targets_var} line ${lineno}');
  });

  test("the targets-file row sits ABOVE the generic 'your own call was malformed' row", () => {
    // Anchored on each row's own opening text, which differs after the verb
    // clause ("...on stderr, naming `<targets_var>..." vs. "...on stderr |"),
    // so each marker can only match its own row, never the other one.
    const newRowMarker = "| `77` with `observe-ssh: refused before ssh ran` on stderr, naming `<targets_var> line <n>`";
    const newRowAt = SKILL.indexOf(newRowMarker);
    expect(newRowAt, "the skill's targets-file-refusal table row is gone — this probe has rotted").toBeGreaterThanOrEqual(0);

    const genericMarker = "| `77` with `observe-ssh: refused before ssh ran` on stderr |";
    const genericAt = SKILL.indexOf(genericMarker);
    expect(genericAt, "the skill's generic malformed-call table row is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
    expect(genericAt, "the two row markers matched the same text — they must identify two distinct rows").not.toBe(newRowAt);

    // The required mutation: swapping the two rows' order turns this red.
    expect(
      newRowAt,
      "the targets-file-refusal row must sit ABOVE the generic malformed-call row, so a worker reading top to bottom hits it first",
    ).toBeLessThan(genericAt);
  });
});
