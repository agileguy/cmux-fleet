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
import { z, ZodError } from "zod";

import { ObserverDockerOpsArtifactSchema, parseObserverDockerOpsArtifact } from "../../src/harvest/observer-target-artifacts.ts";

const SKILL = "skills/observer-docker-ops/SKILL.md";
const HEADING = "## The report artifact contract (§5.6)";
const OPTIONAL_BULLET_START =
  "- **`container_id`, `image` and `restart_count` are optional, and optional means OMITTED.**";

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

/**
 * Extracts just the optional-fields bullet from `src`, from `OPTIONAL_BULLET_START` up to the
 * next top-level bullet or the next `## ` heading, whichever comes first. Anchored on the bullet
 * itself — not the whole file — so a mutation anywhere else in the document cannot satisfy a test
 * that reads this slice, and a mutation that only removes a sentence INSIDE the bullet can.
 */
function optionalFieldsBullet(src: string): string {
  const idx = src.indexOf(OPTIONAL_BULLET_START);
  if (idx === -1) {
    throw new Error(`bullet starting "${OPTIONAL_BULLET_START}" not found`);
  }
  const rest = src.slice(idx + OPTIONAL_BULLET_START.length);
  const nextBulletOffset = rest.search(/\n- \*\*/);
  const nextHeadingOffset = rest.search(/\n## /);
  const offsets = [nextBulletOffset, nextHeadingOffset].filter((n) => n !== -1);
  const end = offsets.length > 0 ? Math.min(...offsets) : rest.length;
  return OPTIONAL_BULLET_START + rest.slice(0, end);
}

/**
 * The row schema's own optional-and-not-nullable field names, read from the schema's shape
 * rather than typed here, so this list tracks `ObserverDockerOpsArtifactSchema` even if a field
 * is ever added, renamed or removed from it.
 */
function rowOptionalKeys(): string[] {
  const servicesField = ObserverDockerOpsArtifactSchema.shape.services as z.ZodArray<z.ZodObject<z.ZodRawShape>>;
  const rowShape = servicesField.element.shape;
  return Object.entries(rowShape)
    .filter(([, field]) => field instanceof z.ZodOptional)
    .map(([key]) => key);
}

/** A deep-enough clone for mutating one row of the documented example without touching the original. */
function cloneExample(): { services: Array<Record<string, unknown>>; [key: string]: unknown } {
  return structuredClone(realExample()) as { services: Array<Record<string, unknown>>; [key: string]: unknown };
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

  // -------------------------------------------------------------------------
  // Optional row fields: OMITTED validates, `null` does not (P6-NULLS).
  // -------------------------------------------------------------------------

  const optionalKeys = rowOptionalKeys();

  test("the schema really does carry the three optional row fields this suite exercises", () => {
    // Anti-vacuity for every loop below: if the schema's shape ever stops
    // reporting these as optional-and-not-nullable, the loops below would
    // silently run zero iterations and pass by doing nothing.
    expect(optionalKeys.sort()).toEqual(["container_id", "image", "restart_count"]);
  });

  for (const key of optionalKeys) {
    test(`omitting optional field "${key}" from the example still validates`, () => {
      const doc = cloneExample();
      delete doc.services[0]![key];
      expect(() => parseObserverDockerOpsArtifact(doc)).not.toThrow();
    });

    test(`setting optional field "${key}" to null fails validation and names "${key}"`, () => {
      const doc = cloneExample();
      doc.services[0]![key] = null;
      let thrown: unknown;
      try {
        parseObserverDockerOpsArtifact(doc);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ZodError);
      const issues = (thrown as ZodError).issues;
      expect(issues.some((i) => i.path.join(".") === `services.0.${key}`)).toBe(true);
    });
  }

  test("a row whose only call was refused (action-verb rule) validates with no optional keys", () => {
    const doc = cloneExample();
    const row = doc.services[0]!;
    row["assessment"] = "indeterminate";
    row["coverage"] = [
      { channel: "state", result: "forbidden" },
      { channel: "health", result: "not_attempted" },
      { channel: "logs", result: "not_attempted" },
      { channel: "stats", result: "not_attempted" },
      { channel: "events", result: "not_attempted" },
    ];
    row["evidence_ref"] = ['docker-forced-command: refused "restart": not a recognised verb'];
    for (const key of optionalKeys) delete row[key];

    const parsed = parseObserverDockerOpsArtifact(doc);
    expect(parsed.services[0]!.assessment).toBe("indeterminate");
    expect(parsed.services[0]!.coverage).toContainEqual({ channel: "state", result: "forbidden" });
    for (const key of optionalKeys) {
      expect(Object.prototype.hasOwnProperty.call(parsed.services[0]!, key)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // The skill's own text says `null` is refused — anchored on the bullet
  // itself so a mutation elsewhere in the file cannot satisfy this.
  // -------------------------------------------------------------------------

  test("the optional-fields bullet says an unanswered field is omitted, and `null` fails validation", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const bullet = optionalFieldsBullet(src);
    expect(bullet).toContain("optional means OMITTED");
    expect(bullet).toContain("never write `null` in its place");
    expect(bullet).toContain("refuses a `null`\n  value");
    expect(bullet).toContain("fails the whole artifact, not just the row");
    expect(bullet).toContain("carries none of these three keys");
  });

  test("revert check: deleting the null-is-refused sentence turns the bullet test red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const sentence =
      "Harvest's schema accepts an absent key but refuses a `null`\n  value for any of the three, and that refusal fails the whole artifact, not just the row. A row\n  ";
    expect(src).toContain(sentence); // the sentence is really there, verbatim
    const mutated = src.replace(sentence, "");
    expect(mutated).not.toBe(src);
    const bullet = optionalFieldsBullet(mutated);
    expect(bullet).not.toContain("refuses a `null`\n  value");
  });
});
