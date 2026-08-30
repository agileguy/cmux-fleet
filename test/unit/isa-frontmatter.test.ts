/**
 * The ISA's headline figure agrees with the ISA's own body.
 *
 * ## Why this exists
 *
 * `progress:` in the frontmatter is the number anyone reads first, and until
 * this test it was maintained entirely by hand. It drifted: PR #22 landed with
 * a body of 213 checked / 268 total and a frontmatter still reading `211/267`,
 * the value from the previous commit.
 *
 * The interesting part is HOW it drifted, because it was not a merge casualty.
 * The `ISA.md` diff between that branch's tip and the merge commit is zero
 * lines, and the branch's own ISA commit changed exactly two lines — both
 * criterion bodies, neither the frontmatter. Nobody dropped it in a conflict
 * resolution; it was simply never updated, because the author counted the body
 * (`grep -c '^- \[x\] ISC-'`) and never looked at the line above it.
 *
 * That is precisely the failure mode a test is for, and it is the most likely
 * line in this repository to drift: `progress:` changes on nearly every branch,
 * so it is the hunk every parallel PR conflicts on and re-resolves by hand.
 * Each resolution is another chance to take the other side by accident.
 *
 * A document whose summary disagrees with its own contents teaches readers to
 * distrust the contents — the same erosion as a self-skipping probe or a flaky
 * guard, both of which this project has spent real effort stamping out. The
 * headline should not be the one part nothing checks.
 *
 * ## Why a unit test and not a guard script
 *
 * It needs no Docker, no network and no fixture — just the file — so it belongs
 * in the fast `test` job where it runs on every push. It is deliberately NOT in
 * `.github/scripts/probe-guard.sh`'s file list: that guard counts probes in the
 * container job, and adding a daemon-free assertion there would cost a
 * multi-minute image build to check a `grep`.
 */

import { describe, expect, test } from "bun:test";

const ISA_PATH = new URL("../../ISA.md", import.meta.url);

/** Every criterion line, whatever its state. `.` matches x, ~, - or a space. */
const ANY_CRITERION = /^- \[.\] ISC-/gm;
const CHECKED = /^- \[x\] ISC-/gm;
const PARTIAL = /^- \[~\] ISC-/gm;
const OPEN = /^- \[ \] ISC-/gm;
/** ISC-368. Retired: the premise was superseded, so the criterion is not live. */
const RETIRED = /^- \[-\] ISC-/gm;

function count(body: string, re: RegExp): number {
  return body.match(re)?.length ?? 0;
}

describe("ISA.md — the headline figure agrees with the body", () => {
  test("progress: <checked>/<total> matches the criteria the file actually contains", async () => {
    const text = await Bun.file(ISA_PATH).text();

    // The frontmatter is the block between the first `---` and the next one.
    // Split on the CLOSING delimiter so a `---` inside a criterion body — and
    // there are several, this file is full of prose — cannot be mistaken for it.
    expect(text.startsWith("---\n")).toBe(true);
    const [head, ...rest] = text.slice(4).split("\n---\n");
    const body = rest.join("\n---\n");
    expect(head).toBeDefined();
    expect(body.length).toBeGreaterThan(0);

    const progress = /^progress: (\d+)\/(\d+)$/m.exec(head!);
    expect(
      progress,
      `ISA.md frontmatter has no 'progress: <checked>/<total>' line. Frontmatter was:\n${head}`,
    ).not.toBeNull();

    const [, statedChecked, statedTotal] = progress!.map(Number) as [number, number, number];

    const checked = count(body, CHECKED);
    const partial = count(body, PARTIAL);
    const open = count(body, OPEN);
    const retired = count(body, RETIRED);
    const total = count(body, ANY_CRITERION);
    const live = checked + partial + open;

    /**
     * The four markers account for every criterion line.
     *
     * Asserted BEFORE the headline comparison, because it is the assumption the
     * comparison rests on. A malformed checkbox — `- [X]` with a capital, or
     * `- []` with no space — still matches `ANY_CRITERION` but none of the
     * four specific patterns, so it would inflate `total` while leaving
     * `checked` alone. Without this line that reads as "the headline is wrong"
     * and sends the next reader to edit the frontmatter, which is the wrong fix
     * and would leave the malformed line in place.
     */
    expect(
      live + retired,
      `Some criterion line is none of [x], [~], [ ] or [-] — likely a malformed checkbox. ` +
        `checked=${checked} partial=${partial} open=${open} retired=${retired} ` +
        `sum=${live + retired} but ${total} lines match '- [.] ISC-'.`,
    ).toBe(total);

    // The headline itself. `progress` counts CHECKED over LIVE — partials are
    // deliberately not credited, which is the same strictness rule that makes a
    // `[~]` mean "measured locally, not re-checked by anything reproducible".
    expect(
      statedChecked,
      `ISA.md frontmatter says ${statedChecked} checked, but the body has ${checked} '[x]' ` +
        `criteria. Recount from the file — do not adjust the body to match the headline.`,
    ).toBe(checked);

    /**
     * ISC-368. The denominator is the LIVE set, and retired criteria are
     * subtracted from it rather than left in to be silently miscounted.
     *
     * Stated as arithmetic rather than as a preference, because the whole
     * point of the marker is that one number stopped meaning one thing: while
     * a superseded criterion sat at `[~]`, `N [~]` meant "N are unproven OR
     * withdrawn", which is two facts under one figure. `[x] + [~] + [ ]` is
     * therefore what `progress:`'s denominator must equal — and `retired:`
     * carries the rest, so the total is REPORTED rather than disappeared.
     */
    expect(
      statedTotal,
      `ISA.md frontmatter says ${statedTotal} total, but the body has ${live} LIVE criteria ` +
        `(${checked} checked, ${partial} partial, ${open} open) plus ${retired} retired. ` +
        `The denominator is the live set; retired criteria are reported by 'retired:'.`,
    ).toBe(live);
  });

  /**
   * ISC-368. `retired: N` is present exactly when the body retires anything,
   * and it is the number the body actually carries.
   *
   * WHY A SECOND FRONTMATTER FIELD AND NOT A FOOTNOTE. Retiring a criterion
   * shrinks the denominator, and a denominator that shrinks with no visible
   * cause is indistinguishable — to the one reader who only ever reads the
   * headline — from criteria being deleted. `350/358` beside `retired: 2`
   * says where the other two went; `350/358` alone does not, and the ISA's
   * whole claim on a reader is that its summary can be trusted without
   * auditing its body.
   *
   * The absent case is asserted too, and in the strict direction: with no
   * retired criteria the field must be ABSENT rather than `retired: 0`. A
   * stale `retired: 2` left behind after both were un-retired is exactly the
   * drift `progress:` itself suffered in PR #22, and the only way to make it
   * impossible is to have one legal spelling per state.
   */
  test("retired: N is present exactly when criteria are retired, and matches", async () => {
    const text = await Bun.file(ISA_PATH).text();
    const [head, ...rest] = text.slice(4).split("\n---\n");
    const body = rest.join("\n---\n");

    const retired = count(body, RETIRED);
    const stated = /^retired: (\d+)$/m.exec(head!);

    if (retired === 0) {
      expect(
        stated,
        `ISA.md frontmatter carries a 'retired:' line but the body retires nothing. ` +
          `Remove the line rather than setting it to 0 — one spelling per state.`,
      ).toBeNull();
      return;
    }

    expect(
      stated,
      `ISA.md body retires ${retired} criteria ('- [-] ISC-') but the frontmatter has no ` +
        `'retired: <n>' line. The denominator in 'progress:' excludes them, so without ` +
        `this field the count of criteria this project has stopped counting is unstated.`,
    ).not.toBeNull();
    expect(
      Number(stated![1]),
      `ISA.md frontmatter says 'retired: ${stated![1]}' but the body has ${retired} ` +
        `'- [-] ISC-' criteria. Recount from the file.`,
    ).toBe(retired);
  });
});
