/**
 * The `observer-vm-ops` skill's `§6.7` JSON example parses with the real
 * artifact schema (SRD-OBSERVER-ROLES Phase 5, task 5.6). This is the VM twin
 * of `observer-docker-skill-example.test.ts` — same extraction contract, same
 * anti-vacuity fixtures, same revert-check shape, applied to
 * `skills/observer-vm-ops/SKILL.md` and `parseObserverVmOpsArtifact` instead.
 *
 * Extraction is heading-scoped rather than "the first ```json block in the
 * file" because a lazy extractor would pass by accident against today's
 * skill file, which happens to have only one such block. Pinning it to the
 * literal `## The report artifact contract (§6.7)` heading, requiring
 * exactly one ```json block in the slice up to the next `## ` heading, is
 * what actually forces a future SKILL.md edit to keep the example where the
 * heading says it lives.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z, ZodError } from "zod";

import { ObserverVmOpsArtifactSchema, parseObserverVmOpsArtifact } from "../../src/harvest/observer-target-artifacts.ts";

const SKILL = "skills/observer-vm-ops/SKILL.md";
const HEADING = "## The report artifact contract (§6.7)";
const OPTIONAL_BULLET_START =
  "- **`uptime_s`, `system_state` and `failed_units[]` are optional, and optional means OMITTED.**";

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
 * rather than typed here, so this list tracks `ObserverVmOpsArtifactSchema` even if a field is
 * ever added, renamed or removed from it.
 */
function rowOptionalKeys(): string[] {
  const servicesField = ObserverVmOpsArtifactSchema.shape.services as z.ZodArray<z.ZodObject<z.ZodRawShape>>;
  const rowShape = servicesField.element.shape;
  return Object.entries(rowShape)
    .filter(([, field]) => field instanceof z.ZodOptional)
    .map(([key]) => key);
}

/** A deep-enough clone for mutating one row of the documented example without touching the original. */
function cloneExample(): { services: Array<Record<string, unknown>>; [key: string]: unknown } {
  return structuredClone(realExample()) as { services: Array<Record<string, unknown>>; [key: string]: unknown };
}

describe("observer-vm-ops skill's §6.7 JSON example is a valid artifact (task 5.6)", () => {
  test("the documented example parses with the real artifact parser", () => {
    const example = realExample();
    // Not just "doesn't throw" — the parsed value is asserted a real artifact,
    // so a parser that silently degrades (e.g. strips to `{}`) is still caught.
    const parsed = parseObserverVmOpsArtifact(example);
    expect(parsed.schema).toBe("pifleet.observer-vm-ops/v1");
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
  "schema": "pifleet.observer-vm-ops/v1",
  "worker": "obs-v1",
  "sweep_id": null,
  "window_opened_at": null,
  "services": [
    {
      "name": "vm-1.example.com",
      "namespace": "vm-1",
      "assessment": "healthy",
      "coverage": [{"channel": "reachability", "result": "answered"}],
      "selector": "vm-1",
      "window": "300s",
      "evidence_ref": ["evidence"]
    }
  ]
}
\`\`\``;

  test("a skill with no JSON block at all is refused", () => {
    const fixture = `# observer-vm-ops\n\n${HEADING}\n\nNo example here, only prose.\n`;
    expect(() => documentedExample(fixture)).toThrow(/no ```json block/);
  });

  test("a skill whose JSON example sits under a different heading is refused", () => {
    const fixture = [
      "# observer-vm-ops",
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
      "# observer-vm-ops",
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
  // The SRD's revert checks.
  // -------------------------------------------------------------------------

  test("revert check: `\"assessment\": \"failed\"` in the example turns this red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const mutated = src.replace('"assessment": "healthy"', '"assessment": "failed"');
    expect(mutated).not.toBe(src); // the replace actually matched something
    const example = documentedExample(mutated);
    expect(() => parseObserverVmOpsArtifact(example)).toThrow();
  });

  test("revert check: removing the required `schema` literal turns this red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const mutated = src.replace('"schema": "pifleet.observer-vm-ops/v1",\n  ', "");
    expect(mutated).not.toBe(src);
    const example = documentedExample(mutated);
    expect(() => parseObserverVmOpsArtifact(example)).toThrow();
  });

  test("revert check: a docker channel (`state`) on a coverage row is refused", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const mutated = src.replace('{"channel": "reachability", "result": "answered"},', '{"channel": "state", "result": "answered"},');
    expect(mutated).not.toBe(src);
    const example = documentedExample(mutated);
    expect(() => parseObserverVmOpsArtifact(example)).toThrow();
  });

  // -------------------------------------------------------------------------
  // Optional row fields: OMITTED validates, `null` does not (P6-NULLS).
  // -------------------------------------------------------------------------

  const optionalKeys = rowOptionalKeys();

  test("the schema really does carry the three optional row fields this suite exercises", () => {
    // Anti-vacuity for every loop below: if the schema's shape ever stops
    // reporting these as optional-and-not-nullable, the loops below would
    // silently run zero iterations and pass by doing nothing.
    expect(optionalKeys.sort()).toEqual(["failed_units", "system_state", "uptime_s"]);
  });

  for (const key of optionalKeys) {
    test(`omitting optional field "${key}" from the example still validates`, () => {
      const doc = cloneExample();
      delete doc.services[0]![key];
      expect(() => parseObserverVmOpsArtifact(doc)).not.toThrow();
    });

    test(`setting optional field "${key}" to null fails validation and names "${key}"`, () => {
      const doc = cloneExample();
      doc.services[0]![key] = null;
      let thrown: unknown;
      try {
        parseObserverVmOpsArtifact(doc);
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
      { channel: "reachability", result: "not_attempted" },
      { channel: "system", result: "forbidden" },
      { channel: "units", result: "not_attempted" },
      { channel: "logs", result: "not_attempted" },
      { channel: "resources", result: "not_attempted" },
      { channel: "cloud", result: "not_attempted" },
    ];
    row["evidence_ref"] = ['vm-forced-command: refused "reboot": not a recognised verb'];
    for (const key of optionalKeys) delete row[key];

    const parsed = parseObserverVmOpsArtifact(doc);
    expect(parsed.services[0]!.assessment).toBe("indeterminate");
    expect(parsed.services[0]!.coverage).toContainEqual({ channel: "system", result: "forbidden" });
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
    expect(bullet).toContain("refuses a\n  `null` value");
    expect(bullet).toContain("fails the whole artifact, not just the row");
    expect(bullet).toContain("carries none of these three keys");
  });

  test("revert check: deleting the null-is-refused sentence turns the bullet test red", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", SKILL), "utf8");
    const sentence =
      "Harvest's schema accepts an absent key but refuses a\n  `null` value for any of the three, and that refusal fails the whole artifact, not just the row.\n  ";
    expect(src).toContain(sentence); // the sentence is really there, verbatim
    const mutated = src.replace(sentence, "");
    expect(mutated).not.toBe(src);
    const bullet = optionalFieldsBullet(mutated);
    expect(bullet).not.toContain("refuses a\n  `null` value");
  });
});
