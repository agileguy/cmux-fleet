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

/** Every `find:` literal, with the constant naming the file it applies to. */
function anchors(source: string): Array<{ file: string; find: string }> {
  const out: Array<{ file: string; find: string }> = [];
  // Entries are `file: CONST,` followed by `find: "…"` or `find:\n  "…" +\n …`.
  for (const m of source.matchAll(
    /file: (\w+),\s*\n\s*(?:what: [^\n]*\n\s*)?find:\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s*\+\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))*)/g,
  )) {
    const parts = [...m[2]!.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].map((p) =>
      unquote(p[0]!),
    );
    out.push({ file: m[1]!, find: parts.join("") });
  }
  return out;
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
    }
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
