/**
 * THE BATTERIES' ANCHORS STILL MATCH THE CODE THEY CLAIM TO MUTATE.
 *
 * ## The gap this closes, stated as the problem rather than as the fix
 *
 * `test/mutation/*.battery.ts` are named so that `bun test` does not collect
 * them — deliberately, because each one runs the unit suite dozens of times and
 * belongs in a human's hands, not on every push. The cost of that decision is
 * that **nothing notices when a battery stops being about the code.** An anchor
 * is a literal string matched against a source file; rename a variable, reflow a
 * condition, and the anchor matches `0x`. The battery reports
 * `ANCHOR MATCHED 0x — NOT APPLIED` and counts it as a finding, which is honest
 * — but only to whoever runs it, and the whole point of not running it in CI is
 * that mostly nobody does.
 *
 * So the EXPENSIVE half stays manual and the CHEAP half runs here: every
 * `find` anchor in every battery must occur exactly once in the file it names.
 * That is a millisecond of string search per anchor and it catches the only
 * failure mode a stale battery has. A battery whose anchors all still match may
 * still be measuring the wrong thing; a battery whose anchors do not match is
 * measuring nothing at all, and this is the difference between the two.
 *
 * ## Why parse the battery rather than export a table from it
 *
 * Importing a battery would run it — they execute at module scope, mutate files
 * and spawn `bun test`. Reading them as text is the only safe form, and it is
 * also the honest one: what is checked is the literal a human will read in the
 * table beside it.
 *
 * ## COMMITTED STATE ON BOTH SIDES, and the trade that buys
 *
 * Both the battery and the code it anchors to are read from `HEAD`, not from the
 * working tree. A battery is committed evidence about committed code, and the
 * repository is worked in by more than one person at a time: reading the working
 * tree makes this test fail whenever anybody is mid-edit on a file some battery
 * happens to anchor to, which is a red that says nothing about the batteries and
 * trains people to ignore it.
 *
 * The cost, stated: locally this lags by one commit — a change that breaks an
 * anchor is caught on the run AFTER it is committed, not before. In CI, where
 * `HEAD` is the commit under test, there is no lag and that is the authority.
 * The discipline it enforces is the right one anyway: a battery must be updated
 * in the SAME commit as the code it measures.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;

/**
 * A file as `HEAD` has it, or `null` when `HEAD` does not have it.
 *
 * `null` rather than a throw for a file that is not committed yet: a battery
 * added in the working tree has nothing to check against and is skipped, which
 * is the same lag the header describes and not an error.
 */
function atHead(relPath: string): string | null {
  const p = Bun.spawnSync(["git", "show", `HEAD:${relPath}`], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return null;
  return p.stdout.toString();
}

/** The committed batteries, by repo-relative path. */
function batteryPaths(): string[] {
  const p = Bun.spawnSync(["git", "ls-tree", "--name-only", "HEAD", "test/mutation/"], {
    cwd: REPO,
    stdout: "pipe",
  });
  return p.stdout
    .toString()
    .split("\n")
    .filter((f) => f.endsWith(".battery.ts"));
}

/**
 * The path constants a battery binds at the top, so `file: CORE` can be resolved
 * to a real path without executing anything.
 *
 * Both shipped batteries spell these as `const NAME = \`${W}/relative/path\``,
 * where `W` is the worktree argument. The worktree is a checkout of this
 * repository, so the relative half is what matters and `${W}` is dropped.
 */
function pathConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/^const (\w+) = `\$\{W\}\/([^`]+)`;$/gm)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * A TypeScript string literal, as the bytes it denotes.
 *
 * Hand-written rather than `JSON.parse`, because the batteries legitimately use
 * single quotes and embed literal `\u0000`/`\u0001` — the adoption guard's
 * comparison key is built from them — and neither survives a naive quote swap.
 * Only the escapes these files actually contain are handled, and an unknown one
 * yields the character itself, which is what TypeScript does.
 */
function unquote(literal: string): string {
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[++i]!;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "0") out += "\u0000";
    else if (next === "u") {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === "x") {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else out += next;
  }
  return out;
}

/**
 * Every `find:` literal, with the constant naming the file it applies to.
 *
 * ## WHAT THE GAP BETWEEN `file:` AND `find:` TOLERATES — read this before
 * ## adding a comment to a mutation case
 *
 * **A comment above a `find:` is safe.** The gap accepts any run of whitespace,
 * `//` line comments, `/* … *\/` block comments, and `what:` lines, in any
 * order and any number. Annotate a case freely; the guard still sees it.
 *
 * It did not always. The gap used to be `\s*\n\s*(?:what: …)?`, which tolerated
 * whitespace and one optional `what:` line and NOTHING else — so a case that
 * explained itself in a comment above its own `find:` became invisible to this
 * guard, silently, with no count anywhere that would show it. That is the worst
 * shape a guard can fail in: it went on passing while watching fewer cases than
 * it claimed. On the day it was found it was blind to four cases across three
 * batteries — `collation-contract`'s `RV15` and `RV16` (both anchored on a
 * string that had occurred 0 times in `fleet.example.yaml` since task 7.1, dead
 * for days and reported by nobody), `collator-relay`'s `M13`, and
 * `envelope-attribution`'s `E3`. `RV15`'s own comment records that this guard
 * demanded the re-anchor it was hiding.
 *
 * ## Why the comment forms end at a newline rather than being skipped loosely
 *
 * `//[^\n]*\n` and `what: [^\n]*\n` require the newline, and a block comment is
 * consumed whole. Without that, `[^\n]*` could give back characters until
 * `find:` matched INSIDE a comment — and these batteries are prose-heavy enough
 * to quote an old anchor in the comment explaining why it moved. Making the
 * line forms consume to end-of-line removes that path entirely: a `find:` in a
 * comment is never reachable as a property.
 *
 * ## Why it cannot reach a LATER case's `find:`
 *
 * Every alternative in the gap consumes at least one character and none of them
 * matches `replace:`, `expect:`, `}` or `{`, so the gap cannot cross a case
 * boundary: an entry with no `find:` of its own fails to match and is skipped
 * rather than borrowing its neighbour's. The count assertion in "the batteries
 * are found and their anchors are parsed" is what keeps that honest — it
 * compares what this parser sees against what the batteries declare, so a
 * future blind spot is a red test rather than a quiet subtraction.
 */
function anchors(source: string): Array<{ file: string; find: string }> {
  const out: Array<{ file: string; find: string }> = [];
  // Entries are `file: CONST,` followed by `find: "…"` or `find:\n  "…" +\n …`,
  // with whitespace / comments / `what:` lines allowed between the two.
  for (const m of source.matchAll(
    /file: (\w+),(?:\s|\/\/[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/|what: [^\n]*\n)*find:\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s*\+\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))*)/g,
  )) {
    const parts = [...m[2]!.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].map((p) =>
      unquote(p[0]!),
    );
    out.push({ file: m[1]!, find: parts.join("") });
  }
  return out;
}

/**
 * How many entries DECLARE a `file:`, counted without the `find:` parser.
 *
 * The second opinion that makes the blind spot above expressible as a number.
 * `anchors()` can only under-count — a case it cannot parse just vanishes — so
 * a guard built only from `anchors()` can never notice it is watching less than
 * it was. This counts the same entries by a different feature of the syntax,
 * and the two disagreeing is the alarm.
 *
 * `file: string;` in the entry INTERFACE is not counted: the comma is required,
 * and a type field ends in a semicolon.
 */
function declaredFileEntries(source: string): number {
  return [...source.matchAll(/^[ \t]*file: \w+,/gm)].length;
}

const BATTERIES = batteryPaths();

/**
 * WHICH BATTERIES THIS GUARD ENFORCES, and why it is a list rather than "all".
 *
 * A battery is enforced once its own author has re-anchored it. Enforcing every
 * battery the day this guard landed would have turned an existing, already-drifted
 * battery into a red branch for somebody who was mid-change in a different file —
 * punishing the person who happened to be working when the guard arrived, for rot
 * that predates it.
 *
 * **An unenforced battery is not silent.** Its rot is printed on every run and
 * counted below, so the list cannot quietly become the whole repository: the
 * report is the pressure, and adding a name here is the one-line move that turns
 * it into a failure.
 *
 * `review-grading.battery.ts` is enforced from the commit that introduced this
 * guard, because a guard whose author exempted their own work would be worth
 * nothing at all.
 *
 * `collation-contract.battery.ts` joined it on 2026-09-05, when its author
 * re-anchored it. It had ONE stale anchor, printed on every run and read by
 * nobody: it pointed at *"Tell each reviewer to put its whole review in its
 * result envelope's `notes`"*, an instruction that had already been partly
 * rewritten under it — so the mutation it names had not been applied for some
 * time and the battery was reporting a finding for its own rot. Rewriting that
 * contract broke three more anchors at once, which is the case this list exists
 * for: a battery is re-anchored in the same commit as the code it measures, and
 * enforcing it is what makes that true next time rather than this time only.
 *
 * `wedged-seat.battery.ts` joined on 2026-09-05, the moment it became readable
 * at all. It had shipped naming its target in a module constant rather than per
 * entry, which parsed to ZERO anchors — so it was not merely unenforced, it was
 * unwatched, and it failed the vacuity check above for every battery in the
 * tree. Enforcing it in the same commit that made it parseable is the point: a
 * battery that is only *reported* on the day it is fixed is a battery that
 * quietly rots from the next day.
 *
 * **Being on this list is a claim about the anchors, not about the battery.**
 * It says every `find` still matches its target exactly once. It does not say
 * the battery still measures the right thing — only running it says that, and
 * `collation-contract.mutations.md` is where that result is written down.
 */
const ENFORCED = new Set([
  "test/mutation/review-grading.battery.ts",
  "test/mutation/collation-contract.battery.ts",
  "test/mutation/wedged-seat.battery.ts",
  // Enforced from the commit that introduced it. A battery that is merely
  // *reported* on the day it lands is one that quietly rots from the next day,
  // and its author exempting their own work would be worth nothing at all —
  // the same argument this list already records for the two entries above.
  "test/mutation/unrecognised-outbox.battery.ts",
  /*
   * `envelope-attribution.battery.ts` joined on 2026-09-04, re-anchored by the
   * change that broke it.
   *
   * It measures `missingLensNote` and the collation brief, and adding the
   * outbox clause moved FIVE of its anchors at once — the note expression, the
   * `null` arm, the `absent` arm, and both negative controls' child literals.
   * That is precisely the case this list exists for: the anchors were stale the
   * moment the clause landed, and its rot would have been printed to a stderr
   * nobody reads while the battery measured nothing.
   *
   * Re-anchored and RE-RUN in the same change: 20/20 as expected, 0 findings —
   * so this is a claim about the anchors that is backed, this once, by a claim
   * about the battery too. E3's mutation deliberately KEEPS the new clause and
   * changes only the claim about the reviewer, so a red there still means what
   * it meant before.
   */
  "test/mutation/envelope-attribution.battery.ts",
  /*
   * `harvest-recovery.battery.ts` is enforced from the commit that introduces
   * it, on the same argument the entry three above records: a battery that is
   * only REPORTED on the day it lands is one that quietly rots from the next
   * day, and its own author exempting their own work would be worth nothing at
   * all.
   *
   * It anchors ten expressions in `relay.ts` — the adapter's recovery listing,
   * the core's capture off the rejection, both arms of the note clause, the
   * brief block and its filter, and the success arm's flag. Every one of them
   * is code a later edit to this area passes straight through, which is what
   * makes the anchors worth watching rather than the mutations alone.
   */
  "test/mutation/harvest-recovery.battery.ts",
]);

describe("every mutation battery still anchors to the code it claims to mutate", () => {
  /**
   * TESTING THE TESTER. A parser that silently matched nothing would pass every
   * assertion below by vacuity — the same failure `monitor-readonly.test.ts`
   * guards against with `walks its own fixture`.
   */
  test("the batteries are found and their anchors are parsed", () => {
    expect(BATTERIES.length).toBeGreaterThanOrEqual(2);
    for (const b of BATTERIES) {
      const source = atHead(b)!;
      expect(source, `${b} is listed by git but could not be read`).not.toBeNull();
      expect(pathConstants(source).size, `${b} binds no \${W} path constants`).toBeGreaterThan(0);
      expect(anchors(source).length, `${b} yielded no anchors`).toBeGreaterThan(5);
      /**
       * NOT VACUOUS *AND NOT PARTIAL*. The check above only says the parser saw
       * SOMETHING; this says it saw EVERYTHING. A parser that quietly skips the
       * cases it cannot spell still passes every assertion in this file, because
       * a case it never yields is a case it never checks — which is exactly how
       * two dead anchors in `collation-contract` survived days of green runs.
       */
      expect(
        anchors(source).length,
        `${b}: ${declaredFileEntries(source)} entries declare a \`file:\` but the parser sees ` +
          `${anchors(source).length}. The difference is invisible cases — anchors nothing checks. ` +
          `Widen the gap in anchors() to cover however they are now written.`,
      ).toBe(declaredFileEntries(source));
    }
  });

  /**
   * THE BLIND SPOT, PINNED TO A FIXTURE RATHER THAN TO THE LIVE BATTERIES.
   *
   * The count assertion above is the live measurement, and it is the one that
   * would catch a regression today. It is not enough on its own: it only holds
   * while the batteries happen to contain a commented case, so the day somebody
   * tidies the last comment out of `test/mutation/`, the old narrow gap would
   * pass again and the guard would go quietly blind a second time.
   *
   * This fixture never changes and therefore never stops testing. The expected
   * list is exact — order, pairing and count — so it fails on an over-match as
   * loudly as on an under-match.
   */
  test("anchors() sees a case whose file: and find: are separated by comments", () => {
    const fixture = [
      "  {",
      '    id: "PLAIN",',
      '    what: "no comment at all — the shape that always parsed",',
      "    file: SRC,",
      '    find: "plain",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
      "  {",
      '    id: "LINE",',
      "    file: SRC,",
      "    // A line comment saying why this anchor moved.",
      '    find: "after-line-comment",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
      "  {",
      '    id: "BLOCK",',
      "    file: SRC,",
      "    /*",
      "     * A block comment — the shape RV15 and RV16 shipped with, and the one",
      "     * that hid them from this guard for days.",
      "     */",
      '    find: "after-block-comment",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
      "  {",
      '    id: "MIXED",',
      "    file: SRC,",
      "",
      "    // A line comment, a blank line, a block comment and a what: line,",
      "    /* in no particular order, */",
      '    what: "a what: that FOLLOWS file: instead of preceding it",',
      "    // and one more line comment for good measure.",
      '    find: "after-everything",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
      "  {",
      '    id: "DECOY",',
      "    file: SRC,",
      '    // Task 7.1 moved this: the old anchor was find: "line-decoy".',
      '    /* An earlier draft used find: "block-decoy" here. */',
      '    find: "the-real-one",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
      "  {",
      '    id: "NOFIND",',
      "    file: SRC,",
      '    note: "a malformed entry that declares no find: of its own",',
      "  },",
      "  {",
      '    id: "AFTER",',
      "    file: OTHER,",
      '    find: "belongs-to-AFTER",',
      '    replace: "x",',
      '    expect: "red",',
      "  },",
    ].join("\n");

    expect(anchors(fixture)).toEqual([
      { file: "SRC", find: "plain" },
      { file: "SRC", find: "after-line-comment" },
      { file: "SRC", find: "after-block-comment" },
      { file: "SRC", find: "after-everything" },
      // A `find:` quoted INSIDE a comment is text, not a property: the line and
      // block forms are consumed to their close, so neither decoy is reachable.
      { file: "SRC", find: "the-real-one" },
      /*
       * `NOFIND` yields nothing AND does not borrow `AFTER`'s anchor. This is
       * the over-match half: a gap loose enough to skip a comment is loose
       * enough to skip a whole entry, and then one case's `file:` pairs with a
       * later case's `find:` — a wrong pairing checks the wrong file, which is
       * worse than the blind spot it was widened to fix.
       */
      { file: "OTHER", find: "belongs-to-AFTER" },
    ]);
  });

  for (const battery of BATTERIES) {
    test(`${battery}: every anchor occurs exactly once in its target`, () => {
      const source = atHead(battery)!;
      const consts = pathConstants(source);
      const cache = new Map<string, string>();
      const bad: string[] = [];
      const skipped = new Set<string>();
      let checked = 0;

      for (const a of anchors(source)) {
        const rel = consts.get(a.file);
        if (rel === undefined) {
          bad.push(`unknown file constant ${a.file}`);
          continue;
        }
        /**
         * A TARGET GIT DOES NOT TRACK IS SKIPPED, NOT FAILED — and `fleet.yaml`
         * is the reason. It is gitignored by house rule, and a battery that
         * mutates the fleet config is anchoring to a file that by design has no
         * committed form. Failing on it would make this guard demand that a
         * deliberate .gitignore entry be reversed.
         *
         * Skips are COUNTED below so the check cannot go vacuous: a battery all
         * of whose targets stopped being tracked would otherwise pass while
         * measuring nothing, which is the failure this whole file exists about.
         */
        let body = cache.get(rel);
        if (body === undefined) {
          const committed = atHead(rel);
          if (committed === null) {
            skipped.add(rel);
            continue;
          }
          body = committed;
          cache.set(rel, body);
        }
        checked += 1;
        const n = body.split(a.find).length - 1;
        if (n !== 1) {
          bad.push(`${rel}: anchor matched ${n}x — ${JSON.stringify(a.find.slice(0, 70))}`);
        }
      }

      /*
       * Reported as a LIST rather than one failure per anchor. A refactor
       * typically breaks several at once, and an operator fixing a battery needs
       * to see all of them before deciding whether the battery is still the
       * right shape or should be rewritten.
       */
      if (bad.length > 0 && !ENFORCED.has(battery)) {
        // Visible on every run, so an unenforced battery cannot drift quietly.
        process.stderr.write(
          `mutation-anchors: ${battery} is NOT enforced and has ${bad.length} stale anchor(s):\n` +
            `${bad.map((b) => `  ${b}`).join("\n")}\n` +
            `  Re-anchor it and add it to ENFORCED in ${"test/unit/mutation-anchors.test.ts"}.\n`,
        );
      }
      if (ENFORCED.has(battery)) {
        expect(bad, `${battery} has anchors that no longer match:\n${bad.join("\n")}`).toEqual([]);
      }
      // Not vacuous: at least one anchor was actually compared against committed
      // source. `skipped` names the untracked targets so the gap is visible.
      expect(
        checked,
        `${battery} checked no anchors; untracked targets: ${[...skipped].join(", ") || "none"}`,
      ).toBeGreaterThan(0);
    });
  }
});
