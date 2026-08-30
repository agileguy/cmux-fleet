/**
 * ISC-363 — every repo path and every pifleet-owned constant the SRD names
 * resolves in the tree.
 *
 * ## Why this exists
 *
 * The 2026-08-30 documentation audit (#121) verified §17's 89 criteria by
 * extracting every identifier and grepping for it BY HAND. That found four
 * dead names and cost an agent two hours. The check is mechanical, so a build
 * should do it — and unlike the audit's judgement half, this half generalises:
 * it is the same operation for every section of the document, forever.
 *
 * It catches the class the audit named "the wrong instrument" — prose that
 * describes a real behaviour while naming a symbol, file or constant that does
 * not exist. That class is invisible to a reader who knows the system (the
 * sentence reads correctly) and fatal to a reader who does not (the name is
 * the only handle they have).
 *
 * ## Two corpora, and the split is not arbitrary
 *
 * **Paths are swept over the WHOLE document, errata included.** A path is a
 * pointer, not a claim: an erratum that says "`src/foo.ts:12` proves the old
 * text wrong" is still pointing at code that must exist, and a stale pointer
 * in an erratum misleads exactly as much as one in normative prose.
 *
 * **Identifiers are swept over NORMATIVE prose only, with block-quote lines
 * stripped.** An erratum correcting a wrong constant HAS to spell the wrong
 * constant, so sweeping errata would make every correction a failure. This is
 * ISC-357's finding reused rather than rediscovered — that probe was decorative
 * until it stopped scanning errata.
 *
 * Measured, not assumed: over the whole document the identifier sweep flags
 * `ADC_FILE_PATH` and `PIFLEET_PI_BIN`, both of which appear ONLY inside
 * errata that exist to say they are wrong. Stripping block quotes removes both
 * and removes no true finding.
 *
 * ## What it deliberately does not sweep
 *
 * Bare lowercase words in backticks (`compact`, `blocked`) are not swept.
 * English prose puts ordinary words in backticks constantly, and the false
 * positive rate would force an allowlist longer than the findings. The
 * `symbol()` call form was measured too — five tokens, none missing — and is
 * not worth a probe of its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const SRD = readFileSync(`${ROOT}Docs/SRD.md`, "utf8");

/** Fenced blocks are diagrams and illustrative examples, not claims. */
const WITHOUT_FENCES = SRD.replace(/```[\s\S]*?```/g, "");

/** Errata must be free to spell the name they are correcting. */
const NORMATIVE = WITHOUT_FENCES.split("\n")
  .filter((l) => !l.trimStart().startsWith(">"))
  .join("\n");

function backticked(text: string): Set<string> {
  return new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));
}

function sourceCorpus(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(`${ROOT}src`);
  walk(`${ROOT}docker`);
  return parts.join("\n");
}

/**
 * Constants owned by something other than pifleet, which therefore cannot be
 * expected to appear in `src/`. Each entry needs a reason; a bare allowlist is
 * how a probe rots into a no-op one exemption at a time.
 */
const EXTERNAL_CONSTANTS = new Map<string, string>([
  ["CMUX_SOCKET_PATH", "cmux's own environment, read by the cmux binary — pifleet never sets it"],
  ["CMUX_SOCKET", "cmux's deprecated socket alias, named in §4.1's account of cmux's interface"],
  ["CMUX_SOCKET_MODE", "named by §17 precisely to say it does NOT exist — a negative claim"],
  ["CMUX_SOCKET_PASSWORD", "cmux's own environment; §17 records that pifleet does not inject it"],
]);

describe("every repo path the SRD names exists", () => {
  const PATH_SHAPE = /^(src|docker|test|\.github)\/[A-Za-z0-9_./*-]+(:\d+(-\d+)?)?$/;

  function citedPaths(): string[] {
    return [...backticked(WITHOUT_FENCES)].filter((t) => PATH_SHAPE.test(t)).sort();
  }

  test("no cited path is missing from the tree", () => {
    const cited = citedPaths();
    // CONTROL: an extractor that matched nothing would pass vacuously. The
    // document cited 151 paths when this was written; a floor well under that
    // still catches total rot without failing on ordinary editing.
    expect(cited.length, "path extractor found almost nothing — the regex has rotted").toBeGreaterThanOrEqual(60);

    const missing = cited.filter((t) => {
      const base = t.split(":")[0]!;
      // A glob stands for a set, and the set may legitimately be empty.
      if (base.includes("*")) return false;
      return !existsSync(`${ROOT}${base}`);
    });
    expect(
      missing,
      `the SRD cites these paths and they do not exist:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("every pifleet-owned constant the SRD names appears in the code", () => {
  const CONST_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;

  test("no normative CONSTANT_CASE name is absent from src/ and docker/", () => {
    const corpus = sourceCorpus();
    const cited = [...backticked(NORMATIVE)].filter((t) => CONST_SHAPE.test(t)).sort();

    // CONTROL: same reason as above. 21 such names existed when this was
    // written; the floor is set below that and above zero.
    expect(cited.length, "constant extractor found nothing — the regex has rotted").toBeGreaterThanOrEqual(10);

    // CONTROL: an allowlist that grew to cover every finding would make this
    // probe a no-op. It is small by construction and this pins that.
    expect(EXTERNAL_CONSTANTS.size, "the external allowlist has grown — justify each entry").toBeLessThanOrEqual(6);

    const missing = cited.filter((t) => !EXTERNAL_CONSTANTS.has(t) && !corpus.includes(t));
    expect(
      missing,
      `the SRD names these constants in normative prose and nothing in src/ or docker/ defines them:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  test("every allowlisted constant is still actually cited, so the list cannot go stale", () => {
    const all = backticked(WITHOUT_FENCES);
    const unused = [...EXTERNAL_CONSTANTS.keys()].filter((t) => !all.has(t));
    expect(
      unused,
      `these constants are allowlisted but no longer appear in the SRD — drop them:\n  ${unused.join("\n  ")}`,
    ).toEqual([]);
  });
});
