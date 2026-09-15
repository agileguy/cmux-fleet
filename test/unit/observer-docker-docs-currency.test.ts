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
 * Not covered, in general: when a channel is `forbidden` rather than a call to fix — that is prose
 * judgement, except for the one case choice 8 pins: an action verb (restart, stop, start, kill, rm,
 * exec, pause, or any other change to a container) is always `forbidden` on `state`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("the exit table's `77` unrecognised-verb row points to this rule", () => {
    expect(SKILL).toContain("the report artifact contract's coverage bullet below names the channel (`state`)");
  });
});
