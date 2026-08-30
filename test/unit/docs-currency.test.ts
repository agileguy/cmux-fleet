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

/**
 * Lines of a section that are TABLE ROWS naming a `cmux <verb>`, and nothing
 * else. Rows only, for the reason the mount probe records: an erratum below a
 * table names the same strings in prose, so a section-wide search cannot be
 * reddened by deleting the row it exists to guard.
 */
function cmuxTableCommands(section: string): Set<string> {
  const found = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`cmux ([a-z][a-z0-9-]*)/gm)) found.add(m[1]!);
  return found;
}

/** Every file under `dir` with one of `exts`, recursively. */
function filesUnder(dir: string, exts: readonly string[], acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) filesUnder(rel, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(rel);
  }
  return acc;
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

describe("every PIFLEET_* variable the SRD names is one the code reads (ISC-357)", () => {
  /**
   * §15 told a reader the Pi double is "selected via `PIFLEET_PI_BIN`". No such
   * variable exists anywhere — the name is `PIFLEET_PI_COMMAND` — and since that
   * variable is the only way to run the acceptance suite at all, the one document
   * that says how to run it said something unusable.
   *
   * An env var name is the ideal subject for a derived check: it is a literal
   * string that must appear identically in the document and in whatever reads it,
   * with no rendering, no synonym and no judgement in between.
   *
   * TWO EXCLUSIONS, both found by mutating this probe rather than by reading it,
   * and the first version had BOTH defects at once — it passed while the defect
   * it exists to catch was still in the document.
   *
   *  1. ERRATUM BLOCKS ARE STRIPPED. An erratum that corrects a wrong variable
   *     name has to SPELL the wrong name, so scanning the whole document makes
   *     the correction indistinguishable from the error. Only unquoted, normative
   *     prose is scanned; a wrong name inside a `>` block is invisible here, which
   *     is the intended trade.
   *  2. THIS FILE IS NOT IN THE CORPUS. The docstring you are reading names
   *     `PIFLEET_PI_BIN`, and while it was in the corpus it SATISFIED the probe on
   *     the document's behalf — the exact shape `test/support/isa-claims.ts`
   *     excludes itself for.
   */
  test("no SRD-named PIFLEET_* variable is absent from src/, docker/ and test/", () => {
    const normative = SRD.split("\n")
      .filter((l) => !l.trimStart().startsWith(">"))
      .join("\n");
    const named = new Set([...normative.matchAll(/PIFLEET_[A-Z0-9_]+/g)].map((m) => m[0]));
    // CONTROL. A count floor would be weak here — normative prose names only two
    // — so pin the one name whose absence WAS the defect. If §15 stops naming the
    // selector at all, this fails rather than passing over an empty set.
    expect(
      [...named].sort(),
      "the SRD's normative prose no longer names PIFLEET_PI_COMMAND — §15 must say how the double is selected",
    ).toContain("PIFLEET_PI_COMMAND");
    expect(named.size, "extractor found too few PIFLEET_* names — the regex has rotted").toBeGreaterThanOrEqual(2);

    const SELF = "test/unit/docs-currency.test.ts";
    const sources = [
      ...filesUnder("src", [".ts"]),
      ...filesUnder("docker", [".sh", ".cjs", ".cts", "Dockerfile", "verbgate"]),
      ...filesUnder("test", [".ts", ".json", ".sh"]),
    ]
      .filter((p) => p !== SELF)
      .map((p) => read(p))
      .join("\n");
    // A CONTROL: a corpus that silently lost most of the tree would still find
    // the common names, so pin its size rather than trusting the walk.
    expect(sources.length, "source corpus is implausibly small — filesUnder() has rotted").toBeGreaterThan(500_000);

    const absent = [...named].filter((n) => !sources.includes(n));
    expect(
      absent,
      `the SRD names these PIFLEET_* variables and nothing in src/, docker/ or test/ mentions them: ` +
        `${absent.join(", ")}. An environment variable the document invents is unusable by the one ` +
        `reader who needs it.`,
    ).toEqual([]);
  });
});

describe("§4.1's table names every cmux command pifleet requires (ISC-358)", () => {
  /**
   * `respawn-pane` has been in `REQUIRED_COMMANDS` — and is how a viewer starts
   * in a split pane, so panes are empty shells without it — while §4.1's table
   * had no row for it at all. `doctor` exits 3 on a missing required command, so
   * the table is the only place an operator learns which commands that means.
   */
  function requiredCommands(): string[] {
    const src = read("src/backends/cmux/capabilities.ts");
    const block = src.match(/REQUIRED_COMMANDS = \[([\s\S]*?)\] as const;/);
    expect(block, "could not locate REQUIRED_COMMANDS").not.toBeNull();
    return [...block![1]!.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!);
  }

  test("every REQUIRED_COMMANDS entry has a §4.1 table ROW", () => {
    const required = requiredCommands();
    const rows = cmuxTableCommands(srdSection("### 4.1 cmux 0.64.20"));
    expect(required.length, "extractor found no required commands").toBeGreaterThanOrEqual(6);
    expect(rows.size, "no §4.1 table rows parsed — the table shape changed").toBeGreaterThanOrEqual(10);

    const missing = required.filter((c) => !rows.has(c));
    expect(
      missing,
      `§4.1's CLI table has no row for these commands, which \`doctor\` treats as required and ` +
        `exits 3 without: ${missing.join(", ")}.`,
    ).toEqual([]);
  });
});

describe("§7.6 names every field of the worker state file (ISC-359)", () => {
  /**
   * The §7.6 block omitted `proc_started` — the process identity the kill ladder
   * and the reaper compare against, deliberately distinct from `started_at`,
   * which the block DID carry — and `credential`, the ADC refresh loop's durable
   * state. A state file documented without either reads as though neither
   * signalling safety nor credential health were control-plane state.
   *
   * Reads the JSON EXAMPLE, not the section, so the erratum explaining the two
   * additions cannot satisfy the probe on their behalf.
   */
  test("every top-level WorkerStateSchema key appears in §7.6's JSON block", () => {
    const contracts = read("src/contracts.ts");
    const block = contracts.match(/export const WorkerStateSchema = z\.object\(\{([\s\S]*?)\n\}\)/);
    expect(block, "could not locate WorkerStateSchema").not.toBeNull();
    const keys = [...block![1]!.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]!);
    expect(keys.length, "extractor found no state keys — the schema shape changed").toBeGreaterThanOrEqual(20);

    const section = srdSection("### 7.6 Worker state file");
    const fence = section.match(/```json\n([\s\S]*?)```/);
    expect(fence, "§7.6 has no ```json block").not.toBeNull();
    const documented = fence![1]!;

    const missing = keys.filter((k) => !documented.includes(`"${k}"`));
    expect(
      missing,
      `§7.6's state.json block omits these WorkerStateSchema fields: ${missing.join(", ")}. ` +
        `A field absent from the block is one no reader of the design knows the control plane holds.`,
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
