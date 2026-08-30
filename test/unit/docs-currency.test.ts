/**
 * The documentation says what the code does — checked, not asserted.
 *
 * ## Why this file exists
 *
 * A 2026-08-30 audit found eleven divergences between `Docs/SRD.md` and the
 * implementation. The pattern across all of them was sharper than any single
 * finding: documentation currency tracked PROXIMITY TO EXECUTING CODE.
 * `skills/*` are mounted into workers and `fleet.example.yaml` is built by CI,
 * and both were current. `Docs/SRD.md` and `CHANGELOG.md` are executed by
 * nothing, and had drifted for eleven merged PRs — including the mount table's
 * flat claim that "nothing else is mounted", written while three mounts it did
 * not list were being emitted, two of them the security-relevant ones.
 *
 * Prose cannot be kept current by intending to keep it current. These probes
 * derive the four MECHANICAL claims from the source of truth and fail when the
 * document disagrees, which is the same move `harvest/needles.ts` makes for the
 * credential sweep (ISC-343): read the needles from where the values actually
 * live, so moving them cannot silently switch the detector off.
 *
 * ## What is and is not covered
 *
 * COVERED, because it is derivable: the set of container mount paths, the set
 * of registered CLI commands, the set of top-level config keys, and the set of
 * exit codes. Each is a set-equality assertion against a document section.
 *
 * NOT COVERED: whether the PROSE around each row is true. No test can read
 * §12.4 and decide whether its account of credential delivery is honest. These
 * probes catch the drift that is countable — a row that was never added, a
 * command that was never listed — which is precisely the drift the audit found.
 * The judgement half still needs a reader.
 *
 * ## The probes never import the mechanism
 *
 * Every extraction below reads the source file as TEXT and matches on the
 * literal the production code emits. Importing `buildDockerArgv` to ask it for
 * its mounts would make the probe agree with the code by construction while
 * proving nothing about the DOCUMENT, which is the artifact under test.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const SRD = read("Docs/SRD.md");
const README = read("README.md");

/** The body of one `### N.M` section, up to the next heading of any depth. */
function srdSection(heading: string): string {
  const start = SRD.indexOf(heading);
  expect(start, `SRD is missing the heading ${heading}`).toBeGreaterThanOrEqual(0);
  const after = SRD.slice(start + heading.length);
  const nextIdx = after.search(/\n#{2,3} /);
  return nextIdx === -1 ? after : after.slice(0, nextIdx);
}

describe("the SRD's mount table names every mount the renderer emits", () => {
  /**
   * `render.ts` is the single writer of `-v` flags for a worker container.
   * Container paths are the right key rather than host paths: the host side is
   * a run-scoped variable the table spells with placeholders, while the
   * container side is a literal the code and the document must agree on.
   */
  function emittedContainerPaths(): string[] {
    const src = read("src/config/render.ts");
    const found = new Set<string>();
    // `argv.push("-v", `${x}:/container/path`)` and `...:${CONST}:ro`
    for (const m of src.matchAll(/argv\.push\("-v",\s*`[^`]*?:(\/[A-Za-z0-9/._-]+)(?::ro)?`\)/g)) {
      found.add(m[1]!);
    }
    // The two mounts whose container path is a named constant.
    for (const [constName, file] of [
      ["SECRETS_MOUNT", "src/run/worker-env.ts"],
      ["BRIEFING_MOUNT", "src/config/render.ts"],
    ] as const) {
      if (!src.includes(constName)) continue;
      const m = read(file).match(new RegExp(`${constName}\\s*=\\s*"(/[^"]+)"`));
      expect(m, `${constName} should be a string literal in ${file}`).not.toBeNull();
      found.add(m![1]!);
    }
    // The named volume is a mount too, and the table carries it.
    if (src.includes("pifleet-piagent-")) found.add("/home/pi/.pi/agent");
    return [...found].sort();
  }

  /**
   * ROWS ONLY, never the whole section. The first version of this probe
   * searched the §5.5 section text and was DECORATIVE: deleting the `/secrets`
   * row left it green, because the erratum immediately below the table names
   * `/secrets` in prose. A probe that a mutation cannot redden is not evidence,
   * and this one was caught by mutating it rather than by reading it.
   */
  function claimedContainerPaths(): string[] {
    const table = srdSection("### 5.5 Mount table");
    return [...table.matchAll(/^\|[^|]*\|\s*`(\/[A-Za-z0-9/._-]+)`/gm)].map((m) => m[1]!);
  }

  test("every container path in render.ts appears as a §5.5 table ROW", () => {
    const emitted = emittedContainerPaths();
    const claimed = new Set(claimedContainerPaths());
    // Two CONTROLS: either extractor silently matching nothing would make the
    // assertion below pass while proving nothing.
    expect(emitted.length, "mount extractor found nothing — the regex has rotted").toBeGreaterThanOrEqual(7);
    expect(claimed.size, "no §5.5 table rows parsed — the table shape changed").toBeGreaterThanOrEqual(7);

    const missing = emitted.filter((p) => !claimed.has(p));
    expect(
      missing,
      `§5.5 has no table row for these container paths that src/config/render.ts mounts: ${missing.join(", ")}. ` +
        `Add a row — and fill the Condition column, because a mount added without one reads as unconditional.`,
    ).toEqual([]);
  });

  test("§5.5 does not claim more mounts than the renderer emits", () => {
    const emitted = new Set(emittedContainerPaths());
    const claimed = claimedContainerPaths();
    expect(claimed.length, "no table rows parsed — the table shape changed").toBeGreaterThanOrEqual(7);
    const phantom = [...new Set(claimed)].filter((p) => !emitted.has(p));
    expect(
      phantom,
      `§5.5 lists mounts src/config/render.ts does not emit: ${phantom.join(", ")}`,
    ).toEqual([]);
  });
});

describe("the SRD's CLI table names every command the CLI registers", () => {
  function registeredCommands(): string[] {
    const dir = join(ROOT, "src/cli/commands");
    const names = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      // `.command("name")`, `.command("name <action>")`, `.command("name [x...]")`
      for (const m of src.matchAll(/\.command\("([a-z][a-z0-9-]*)/g)) names.add(m[1]!);
    }
    return [...names].sort();
  }

  test("every registered command appears in §10", () => {
    const table = srdSection("## 10. CLI surface");
    const cmds = registeredCommands();
    expect(cmds.length, "extractor found no commands — the regex has rotted").toBeGreaterThanOrEqual(20);
    const missing = cmds.filter((c) => !table.includes(`\`pifleet ${c}`));
    expect(
      missing,
      `§10's command table is missing: ${missing.join(", ")}. A command absent from the surface ` +
        `table is one no operator reading the design knows exists.`,
    ).toEqual([]);
  });
});

describe("the SRD documents every top-level config key", () => {
  test("every key of FleetConfigSchema is named somewhere in the SRD", () => {
    const schema = read("src/config/schema.ts");
    const block = schema.match(/FleetConfigSchema = z\n\s*\.object\(\{([\s\S]*?)\n\s*\}\)/);
    expect(block, "could not locate FleetConfigSchema's object literal").not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]!);
    expect(keys.length, "extractor found no config keys — the shape changed").toBeGreaterThanOrEqual(10);

    // `name` and `version` are too generic to grep for meaningfully; every
    // other key is a distinctive token the document must carry.
    const generic = new Set(["name", "version"]);
    const missing = keys
      .filter((k) => !generic.has(k))
      .filter((k) => !new RegExp(`(^|[^a-z_])${k}:`, "m").test(SRD));
    expect(
      missing,
      `these top-level fleet.yaml keys appear in no section of the SRD: ${missing.join(", ")}. ` +
        `A key of a .strict() schema is spellable by every operator; one the design never mentions ` +
        `is reachable only by reading src/config/schema.ts.`,
    ).toEqual([]);
  });
});

describe("the SRD's exit ladder carries every exit code", () => {
  test("every EXIT value appears in §10's ladder", () => {
    const contracts = read("src/contracts.ts");
    const block = contracts.match(/export const EXIT = \{([\s\S]*?)\n\} as const;/);
    expect(block, "could not locate the EXIT table").not.toBeNull();
    const codes = [...block![1]!.matchAll(/^\s*[A-Z_]+:\s*(\d+),/gm)].map((m) => m[1]!);
    expect(codes.length, "extractor found no exit codes").toBeGreaterThanOrEqual(8);

    /**
     * THE LADDER LINE, not the section. Searching the section was decorative
     * for the same reason the mount probe was: this section's own erratum says
     * "`8` was missing from this ladder", so deleting `8` FROM the ladder left
     * the probe green. Found by mutation, not by reading.
     */
    const section = srdSection("## 10. CLI surface");
    const ladderLine = section
      .split("\n")
      .find((l) => /^`\d`[^\n]*>[^\n]*`0` success\.$/.test(l.trim()));
    expect(ladderLine, "could not locate §10's exit ladder line").toBeDefined();

    const missing = codes.filter((c) => !ladderLine!.includes(`\`${c}\``));
    expect(
      missing,
      `§10's exit ladder omits: ${missing.join(", ")}. Exit 8 was missing for the whole of its ` +
        `existence, and it ranks FIRST in EXIT_SEVERITY.`,
    ).toEqual([]);
  });
});

describe("the README's criteria count matches the ISA", () => {
  /**
   * The sentence this replaces named ISC-129 as still open eleven days after
   * it was closed. A count is the checkable half of that claim, so it is
   * checked; the prose naming WHICH criteria is not, and still needs a reader.
   */
  test("the number of [~] criteria the README states is the number ISA.md carries", () => {
    const isa = read("ISA.md");
    const tilde = [...isa.matchAll(/^- \[~\] ISC-/gm)].length;
    const open = [...isa.matchAll(/^- \[ \] ISC-/gm)].length;
    expect(tilde, "no [~] criteria found — the ISA's marker syntax changed").toBeGreaterThan(0);

    const words: Record<number, string> = {
      1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five",
      6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten",
    };
    const word = words[tilde];
    expect(word, `ISA has ${tilde} [~] criteria — extend the word map`).toBeDefined();
    expect(
      README.includes(`${word} are graded \`[~]\``),
      `README should say "${word} are graded \`[~]\`" — ISA.md carries ${tilde}.`,
    ).toBe(true);

    if (open === 0) {
      expect(
        README.includes("zero `[ ]`"),
        "ISA.md has no `[ ]` criteria; the README should say so",
      ).toBe(true);
    }
  });
});
