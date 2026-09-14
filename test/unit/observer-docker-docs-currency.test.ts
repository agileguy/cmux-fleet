/**
 * `skills/observer-docker-ops/SKILL.md` pinned to the scripts it documents (SRD-OBSERVER-ROLES §5.2,
 * §5.4). A worker routes each exit by the stderr text the skill quotes, so the skill's verbs, events
 * actions and quoted refusal lines must match what the scripts accept and print. Every file is read
 * as text, in the style of `docs-currency.test.ts`; `docker-forced-command` is `sh` and cannot be
 * imported.
 *
 *  1. the skill's verb set equals `docker-forced-command`'s verb `case` arms
 *  2. the skill's events actions equal the `event=` filters in
 *     `test/fixtures/observe/docker-cli-shapes.json` `.events.action_allowlist.filters`
 *  3. the skill quotes `observe-ssh: refused before ssh ran`, and `docker/observe-ssh` prints it
 *  4. the skill quotes the forced command's unknown-verb refusal line, prefix included
 *
 * Not covered: when a channel is `forbidden` rather than a call to fix. That is prose judgement.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SKILL_PATH = "skills/observer-docker-ops/SKILL.md";
const FORCED_COMMAND_PATH = "scripts/observe/docker-forced-command";
const OBSERVE_SSH_PATH = "docker/observe-ssh";
const SHAPES_FIXTURE_PATH = "test/fixtures/observe/docker-cli-shapes.json";

const SKILL = read(SKILL_PATH);
const FORCED_COMMAND = read(FORCED_COMMAND_PATH);
const OBSERVE_SSH = read(OBSERVE_SSH_PATH);

// -----------------------------------------------------------------------------
// 1. verb set: the skill's table vs. the forced command's `case` arms
// -----------------------------------------------------------------------------

/**
 * The bare-word arms of `case ${verb} in ... esac` — `  ps)`, `  inspect)`,
 * etc. Two-space indent, exactly as the script is written; the catch-all
 * `*)` arm never matches `[a-z]` and is excluded by construction, not by a
 * denylist.
 */
function verbsFromForcedCommand(src: string): Set<string> {
  const start = src.indexOf("case ${verb} in");
  expect(start, "docker-forced-command's `case ${verb} in` is gone — this probe has rotted").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\nesac", start);
  expect(end, "no closing `esac` found after `case ${verb} in` — this probe has rotted").toBeGreaterThan(start);
  const block = src.slice(start, end);
  const verbs = [...block.matchAll(/^ {2}([a-z][a-z-]*)\)\s*$/gm)].map((m) => m[1]!);
  // CONTROL: a regex that stopped matching would make the whole comparison
  // vacuously pass (an empty documented set can never be "missing" anything).
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
