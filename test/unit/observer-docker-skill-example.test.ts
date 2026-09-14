/**
 * The `observer-docker-ops` skill's `§5.6` JSON example parses with the real
 * artifact schema (SRD-OBSERVER-ROLES Phase 4, task 4.6), in the manner
 * `test/unit/triage-verdict.test.ts`'s "the observer's documented row
 * satisfies the gate it is graded by" describe block reads
 * `skills/observer-ops/SKILL.md`'s schema block: read the file, extract its
 * fenced ```json example, parse the extracted text as JSON, then run it
 * through the production parser.
 *
 * ## Schema vs. entry point
 *
 * `parseObserverDockerOpsArtifact` (`src/harvest/observer-target-artifacts.ts`)
 * is used rather than calling `ObserverDockerOpsArtifactSchema.parse` directly.
 * It is the one real callers use — `reconcile.ts` selects
 * `observer-docker-ops.json` by name and parses it through this exact
 * function — and it wraps the schema with the secret sweep the doc's own
 * "Harvest validates the JSON by name, sweeps it for
 * `OBSERVER_DOCKER_SSH_KEY`'s value" line promises. Called with no secrets
 * (its default), the sweep is a no-op, so this exercises strictly more of the
 * real path than the bare schema would, for no extra cost.
 *
 * ## Extraction cannot be "the first ```json block in the file"
 *
 * The skill has exactly one such block today, so "first block" and "the
 * block under the artifact-contract heading" agree on THIS file and a lazy
 * extractor would pass by accident. `documentedExample()` instead requires
 * the block to sit under the literal `## The report artifact contract
 * (§5.6)` heading, in the slice of the document up to (but not including) the
 * next `## ` heading, and requires there be EXACTLY ONE such block in that
 * slice. That is not one arbitrary choice among several — it is a
 * conjunction of both strategies the task allows ("by the section it sits
 * under" AND "by it being the only `json` block"), which is why each fixture
 * below is red for a different reason: no heading match, a heading match with
 * zero blocks inside it, and a heading match with more than one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseObserverDockerOpsArtifact } from "../../src/harvest/observer-target-artifacts.ts";

const SKILL = "skills/observer-docker-ops/SKILL.md";
const HEADING = "## The report artifact contract (§5.6)";

/**
 * Extracts the sole ```json block filed under `HEADING` in `src` and parses
 * it as JSON. Throws — deliberately, this is the behaviour every mutant
 * fixture below is pinning — when the heading is absent, when the section it
 * opens holds no ```json block, or when it holds more than one.
 */
function documentedExample(src: string): unknown {
  const headingIdx = src.indexOf(HEADING);
  if (headingIdx === -1) {
    throw new Error(`no "${HEADING}" heading found`);
  }
  const afterHeading = src.slice(headingIdx + HEADING.length);
  const nextHeadingOffset = afterHeading.search(/^## /m);
  const section = nextHeadingOffset === -1 ? afterHeading : afterHeading.slice(0, nextHeadingOffset);

  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)];
  if (blocks.length === 0) {
    throw new Error(`no \`\`\`json block under "${HEADING}"`);
  }
  if (blocks.length > 1) {
    throw new Error(`expected exactly one \`\`\`json block under "${HEADING}", found ${blocks.length}`);
  }
  return JSON.parse(blocks[0]![1]!);
}

/** Reads and extracts the real skill's own example — no copy pasted in here. */
function realExample(): unknown {
  const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
  return documentedExample(src);
}

describe("observer-docker-ops skill's §5.6 JSON example is a valid artifact (task 4.6)", () => {
  test("the documented example parses with the real artifact parser", () => {
    const example = realExample();
    // Not just "doesn't throw" — the parsed value is asserted a real artifact,
    // so a parser that silently degrades (e.g. strips to `{}`) is still caught.
    const parsed = parseObserverDockerOpsArtifact(example);
    expect(parsed.schema).toBe("pifleet.observer-docker-ops/v1");
    expect(parsed.services.length).toBeGreaterThan(0);
    expect(parsed.services[0]!.assessment).toBe("healthy");
  });

  // -------------------------------------------------------------------------
  // Anti-vacuity: each fixture below must turn the extraction (not just the
  // schema parse) red, and for a different reason each time, so a change that
  // makes extraction sloppy (e.g. "grab any ```json in the file") is caught
  // even though it would still pass against the real skill file unchanged.
  // -------------------------------------------------------------------------

  const VALID_JSON_BLOCK = `\`\`\`json
{
  "schema": "pifleet.observer-docker-ops/v1",
  "worker": "obs-d1",
  "sweep_id": null,
  "window_opened_at": null,
  "services": [
    {
      "name": "web-1",
      "namespace": "docker-host-a",
      "assessment": "healthy",
      "coverage": [{"channel": "state", "result": "answered"}],
      "selector": "name=web-1",
      "window": "300s",
      "evidence_ref": ["evidence"]
    }
  ]
}
\`\`\``;

  test("a skill with no JSON block at all is refused", () => {
    const fixture = `# observer-docker-ops\n\n${HEADING}\n\nNo example here, only prose.\n`;
    expect(() => documentedExample(fixture)).toThrow(/no ```json block/);
  });

  test("a skill whose JSON example sits under a different heading is refused", () => {
    const fixture = [
      "# observer-docker-ops",
      "",
      "## Somewhere else entirely",
      "",
      VALID_JSON_BLOCK,
      "",
      HEADING,
      "",
      "The example lives above, not here.",
      "",
    ].join("\n");
    // Sanity: the block really is in the fixture, just under the wrong heading.
    expect(fixture).toContain("```json");
    expect(() => documentedExample(fixture)).toThrow(/no ```json block under/);
  });

  test("a skill with two json blocks under the heading, second invalid, is refused", () => {
    const INVALID_JSON_BLOCK = `\`\`\`json
{"not": "an artifact"}
\`\`\``;
    const fixture = [
      "# observer-docker-ops",
      "",
      HEADING,
      "",
      VALID_JSON_BLOCK,
      "",
      "A second, bogus block follows.",
      "",
      INVALID_JSON_BLOCK,
      "",
      "## Enrolling a target",
      "",
      "Unrelated trailing section.",
      "",
    ].join("\n");
    expect(() => documentedExample(fixture)).toThrow(/found 2/);
  });

  // -------------------------------------------------------------------------
  // The SRD's two revert checks.
  // -------------------------------------------------------------------------

  test("revert check: `\"assessment\": \"failed\"` in the example turns this red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const mutated = src.replace('"assessment": "healthy"', '"assessment": "failed"');
    expect(mutated).not.toBe(src); // the replace actually matched something
    const example = documentedExample(mutated);
    expect(() => parseObserverDockerOpsArtifact(example)).toThrow();
  });

  test("revert check: removing the required `schema` literal turns this red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const mutated = src.replace('"schema": "pifleet.observer-docker-ops/v1",\n  ', "");
    expect(mutated).not.toBe(src);
    const example = documentedExample(mutated);
    expect(() => parseObserverDockerOpsArtifact(example)).toThrow();
  });
});
