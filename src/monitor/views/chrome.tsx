/**
 * The chrome every view shares: the palette, the age vocabulary, the region
 * line, and THE FLOOR RULE (SRD-FLEET-MONITOR §6.4, §6.5, D14, ISC-484,
 * ISC-485, ISC-505).
 *
 * ## Why this file exists, stated as the failure it prevents
 *
 * Views 2-4 need every primitive `views/fleet.tsx` had already written for view
 * 1: a palette that is off by default, an age that coarsens the way `ago` does,
 * a region line that keeps §6.4's three renderings apart, a fixed-width cell, a
 * rule, and a refusal. Four copies of `coarseAge` is the two-spellings hazard
 * ISC-345 records, arriving by the least interesting route — **`status.ts` and
 * this monitor already agree on `< 60` seconds and `< 3600` minutes, and a
 * fourth copy is a fourth place for that agreement to lapse.** So the
 * primitives moved down here and `fleet.tsx` imports them; its rendering did
 * not change by a byte, which the pinned frame in `monitor-render.test.ts`
 * enforces.
 *
 * A second, sharper reason: **the palette CONTEXT must be one object.** Two
 * modules each calling `createContext` produce two independent contexts, and a
 * `PaletteProvider` from one would not be seen by a `usePalette` in the other —
 * so view 2 would silently render plain inside a coloured frame. That is not a
 * failure any assertion in this design would catch, because the plain and
 * coloured frames are required to carry the same TEXT; it would show up only in
 * a pane, to an operator, as a view that lost its colour.
 *
 * ## THE FLOOR RULE, which is the load-bearing export
 *
 * §6.5 forbids dropping some columns and D14 says that below the width those
 * columns need, the monitor refuses with a sentence naming the required size.
 * `FLOOR_COLUMNS` in `fleet.tsx` derives that number rather than measuring a
 * terminal, and §9 Q3 was closed by that derivation rather than by a probe.
 *
 * Views 2-4 need the same treatment, and the temptation is to write three more
 * `const FLOOR_… = 30`. **A number picked per view is exactly what ISC-485
 * refused**, and four independently-picked numbers cannot be checked against
 * each other at all. So the rule is reified: a view declares WHICH of its cells
 * may never be dropped, by name and width, and its floor follows. That makes
 * ISC-505 assertable as one property over four views — *"every view's floor is
 * the width its own never-dropped cells need, it draws at that width, and it
 * refuses one column below it"* — rather than as four remembered constants that
 * a reader has to take on trust.
 *
 * ## What is NOT counted in a floor, and why the omission is deliberate
 *
 * Full-width lines — region headings, the staleness markers, event text, report
 * body. `fleet.tsx` states the reason and it holds for every view: those lines
 * truncate or wrap on their own and do not have to fit BESIDE anything, so a
 * floor that included them would refuse to draw panes on which the view is
 * perfectly readable. The consequence is worth naming because it looks like a
 * defect: **a view built entirely out of full-width lines has almost no columns
 * to sum** — view 4 is that view, and the sum gives it 3.
 *
 * ## The second clause, which the sum alone got WRONG
 *
 * A floor of 3 was accepted as the rule's honest output, and the ISC-505 sweep
 * then falsified it. The sweep asserts that every view refuses one column below
 * its floor; view 4 did refuse at two columns, and the refusal came out as
 * hard-broken fragments, because no word of it fits in two columns. **D14 says a
 * refusal beats a misleading layout, which is false when the refusal IS the
 * misleading layout** — so a floor lower than the view's own refusal needs is
 * not an honest low number, it is a wrong one.
 *
 * Hence {@link refusalMinimum}: every floor is at least one column wider than
 * the longest word of the sentence it would have to print. Still derived —
 * it is a property of a string this module already owns — and it binds only for
 * a view whose columns sum to less. Views 1-3 are untouched by it.
 */

import { Box, Text } from "ink";
import { createContext, useContext } from "react";

import { regionAgeMs } from "../model.ts";
import type { Region } from "../model.ts";

/**
 * COLOUR IS OFF BY DEFAULT AND THAT IS NOT A STYLE PREFERENCE.
 *
 * Every byte-pinned assertion in `monitor-render.test.ts` compares plain text.
 * Ink emits SGR escapes inline when a `color` prop is set, so a coloured frame
 * turns `expect(row).toContain("wrote 11m ago")` into a comparison against
 * `\x1b[32mwrote 11m ago\x1b[39m` — every one of those tests would have to be
 * rewritten against escape codes, which is the "a component tree is not
 * pinnable" problem §6.6.1 refuted, arriving by a different route.
 *
 * So the palette is a CONTEXT with a plain default, and only `renderFleet`'s
 * caller turns it on. Tests get text; the pane gets colour; one component tree
 * produces both, so a styled frame cannot drift from the asserted one.
 */
export interface Palette {
  readonly on: boolean;
  readonly dim: string | undefined;
  readonly heading: string | undefined;
  readonly alarm: string | undefined;
  readonly warn: string | undefined;
  readonly live: string | undefined;
  readonly quiet: string | undefined;
  /**
   * The phase cell's `Busy`. Deliberately NOT `live` (green).
   *
   * The row already says "something is happening" once, in the bullet. A
   * second green on the same row would make the two look like one fact stated
   * twice; blue makes the phase readable as its own column while leaving the
   * bullet the thing that carries severity.
   */
  readonly busy: string | undefined;
  /**
   * The workspace group heading.
   *
   * **ITS OWN ENTRY THOUGH IT IS THE SAME YELLOW AS {@link warn}, and the
   * duplication is the point rather than an oversight.** This palette's stated
   * discipline is that "the assignment is by SEVERITY and not by category":
   * `warn` means *has never spoken, needs a look*. A workspace heading is not a
   * finding and must never be read as one — but it is structure the eye should
   * be able to land on without reading, which is what the owner asked for.
   *
   * Two names for one colour costs a line here and buys the ability to change
   * either without changing the other. Had the heading reused `warn`, a later
   * decision to make warnings orange would silently repaint every group
   * heading, and a reader looking at the frame could not tell which of the two
   * meanings a yellow line carried.
   */
  readonly workspace: string | undefined;
}

export const PLAIN: Palette = {
  on: false,
  dim: undefined,
  heading: undefined,
  alarm: undefined,
  warn: undefined,
  live: undefined,
  quiet: undefined,
  busy: undefined,
  workspace: undefined,
};

/**
 * The pane palette.
 *
 * Chosen against a DARK terminal, which is what the console runs in, and kept
 * to the eight ANSI names rather than 256-colour or truecolour so it inherits
 * whatever theme the operator has configured instead of fighting it.
 *
 * The assignment is by SEVERITY and not by category, which is the point:
 * `container-gone` is red because it is the one row that always means
 * something is wrong; `no-transcript` is yellow because it means "has never
 * spoken", which needs a look but is not itself a fault (Q1(b) — it must never
 * be read as "stuck"); `active` is green; everything a monitor cannot judge is
 * grey. An operator scanning the pane should be able to find the red without
 * reading a word.
 */
export const COLOUR: Palette = {
  on: true,
  dim: "gray",
  heading: "cyan",
  alarm: "red",
  warn: "yellow",
  live: "green",
  quiet: "white",
  busy: "blue",
  workspace: "yellow",
};

const PaletteContext = createContext<Palette>(PLAIN);
export const PaletteProvider = PaletteContext.Provider;
export const usePalette = (): Palette => useContext(PaletteContext);

/**
 * The row gutter, in characters.
 *
 * Every view indents its rows by two spaces and then either a severity bullet
 * and a space, or two more spaces. Four either way, which is why one constant
 * serves both and why every floor below starts from it.
 */
export const INDENT = 4;

/**
 * How long ago, in the coarsest unit that still says something — seconds under a
 * minute, minutes under an hour, hours above.
 *
 * **This duplicates `ago` (`status.ts:39-45`) deliberately and the duplication is
 * argued rather than overlooked.** `ago` takes an ISO string; every age here is
 * already milliseconds from `regionAgeMs` (`model.ts:83`), so reusing it would
 * mean formatting a stamp back into a string to parse it again. More decisively,
 * `status.ts` is a `commander` command module under `src/cli/commands/`, and
 * ISC-468 requires the monitor's transitive import list to contain nothing that
 * dispatches — importing a formatter from there would drag the CLI, the registry
 * and the state writer into the viewer's closure to save nine lines.
 *
 * The two must agree on the BOUNDARIES, and they do: `< 60` seconds, `< 3600`
 * minutes, hours above. A monitor that said `90s` where `status` said `1m` would
 * make an operator comparing two panes doubt both.
 */
export function coarseAge(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3_600)}h`;
}

/**
 * §6.4's three renderings, which must not collapse, in one place so they cannot
 * drift apart between regions — or, now, between views.
 *
 * **The `never` case is decided by the ABSENCE OF AN AGE rather than by the
 * status tag**, which is not a stylistic choice: `model.ts:75-85` defines a
 * never-read region as one that "has no age, and rendering one as `0ms` would be
 * the same lie ISC-477 guards against from the other side". Reading the null
 * back out is that definition used rather than restated, so a future change to
 * `regionAgeMs` cannot leave this function confidently printing `as of 0s` for a
 * region nothing ever read.
 *
 * `summary` is applied only in the `ok` case, and that is what keeps ISC-479
 * satisfiable: `no data` and `none running` are produced by different branches
 * and can never be spelled by the same code path.
 */
export function regionLine<T>(
  label: string,
  region: Region<T>,
  now: number,
  summary: (value: T) => string,
): string {
  const age = regionAgeMs(region, now);
  // `no data` is reached two ways and both state the same fact: this region has
  // no age. `regionAgeMs` returns `null` exactly for `never` (`model.ts:83-85`),
  // so today the two are the same test — but they are written as two because
  // they fail differently. Testing the RETURN keeps the line correct if `Region`
  // ever grows a fourth status whose age is unknown; testing the STATUS is what
  // narrows `region` for the branches below. Dropping either one costs a real
  // thing: without the first, a future status renders `as of NaN`; without the
  // second, this does not typecheck.
  if (age === null || region.status === "never") return `${label} — no data`;
  const asOf = `${label} — as of ${coarseAge(age)}`;
  // ISC-478: the reason stands IN PLACE of the content. There is no branch here
  // that can append it beside a retained value, because `Region.failed` carries
  // no value to retain (`model.ts:47-56`) — the type does the enforcing and this
  // function only has to not invent one.
  if (region.status === "failed") return `${asOf} — refresh failed: ${region.reason}`;
  return `${asOf} — ${summary(region.value)}`;
}

/**
 * A fixed-width cell.
 *
 * `truncate-end` rather than `wrap`: a wrapped cell pushes every row below it
 * down and destroys the column alignment that is the entire reason an operator
 * can scan six workers in a glance. **The cost is real and is not hidden** — an
 * id longer than its column loses characters, silently, which is the class of
 * thing §6.5 argues against. It is accepted for CELLS because the honest
 * alternative is the refusal ISC-485 specifies, which is what happens below the
 * floor. It is NOT accepted for prose the view did not compose — see
 * {@link BodyLine}.
 */
export function Cell({
  width,
  color,
  dimColor,
  bold,
  children,
}: {
  width: number;
  color?: string | undefined;
  dimColor?: boolean;
  bold?: boolean;
  children: string;
}) {
  return (
    <Box width={width}>
      <Text wrap="truncate-end" color={color} dimColor={dimColor} bold={bold}>
        {children}
      </Text>
    </Box>
  );
}

/**
 * A line of content the view did not compose, rendered WRAPPED rather than
 * truncated.
 *
 * **The asymmetry with {@link Cell} is deliberate and it is §6.4's argument
 * applied one level down.** A cell truncates because the alternative — a
 * wrapped cell — destroys the column alignment that makes a fleet table
 * scannable, and the loss is bounded and visible (an id runs to its column
 * edge). An event line or a report line has no column to protect and no bound:
 * truncating it silently deletes whatever the line was about, which is the same
 * class of defect as a window that starts mid-history without saying so
 * (ISC-504). Wrapping costs vertical space and loses nothing.
 *
 * Views 2 and 4 are the two that carry such content, and both use this.
 */
export function BodyLine({
  color,
  dimColor,
  children,
}: {
  color?: string | undefined;
  dimColor?: boolean;
  children: string;
}) {
  return (
    <Text wrap="wrap" color={color} dimColor={dimColor}>
      {children}
    </Text>
  );
}

/**
 * A full-width rule, drawn with the character §6.5's degradation never has to
 * think about: it is one line of the frame's own width and it truncates to
 * nothing interesting.
 *
 * ASCII `-` when colour is off, box-drawing `─` when it is on. **This is the one
 * place the plain and coloured frames differ in TEXT rather than only in
 * escapes**, and it is deliberate: a rule is pure decoration, so a piped frame
 * that a grep or a diff reads is better off with the character that survives
 * every encoding, while the pane gets the one that looks like a rule. Nothing
 * downstream parses it — unlike the severity bullet, which carries meaning and
 * is therefore present in both.
 */
export function Rule({ width }: { width: number }) {
  const p = usePalette();
  return <Text dimColor={p.on}>{(p.on ? "─" : "-").repeat(Math.max(0, width))}</Text>;
}

/**
 * A region's header line: bold, and RED when that region's own refresh failed.
 *
 * The failure colour is on the heading rather than only in the reason text
 * because §6.4's requirement is that a stale or broken region be findable at a
 * glance. An operator scanning three headings should not have to read them to
 * see which one stopped working.
 */
export function RegionHeading({ text, failed }: { text: string; failed: boolean }) {
  const p = usePalette();
  return (
    <Text wrap="truncate-end" bold={p.on} color={failed ? p.alarm : p.heading}>
      {text}
    </Text>
  );
}

/**
 * The severity bullet: `●` coloured, `*` plain.
 *
 * It earns its column by carrying severity where the eye lands first, and it is
 * present in BOTH frames rather than appearing only when styled — a monitor
 * whose row structure changed with its styling would make every assertion in
 * this design a claim about the wrong frame.
 */
export function Bullet({ color }: { color?: string | undefined }) {
  const p = usePalette();
  return (
    <>
      <Text>{"  "}</Text>
      <Text color={color}>{p.on ? "●" : "*"}</Text>
      <Text>{" "}</Text>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE FLOOR RULE (§6.5, D14, ISC-485, ISC-505)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One view's never-dropped cells, declared so its floor can be DERIVED from
 * them rather than picked.
 *
 * The names are carried alongside the widths and are not decoration: a floor
 * that fails should be able to say WHICH column it is the width of, and a test
 * iterating four views should be able to report `history: run-id 8 + age 10 +
 * state 10` rather than `expected 32, got 30`.
 */
export interface ViewFloor {
  /** The view's name, as it appears in the refusal sentence. */
  readonly view: string;
  /** `[name, width]` for every cell §6.5 forbids this view from dropping. */
  readonly neverDropped: readonly (readonly [string, number])[];
  /** The row gutter this view's cells start after — 4 with a bullet, 2 without. */
  readonly gutter: number;
  /**
   * The derived floor: the gutter plus those widths, or the width its own
   * refusal needs to stay legible, whichever is larger. Carried alongside its
   * inputs so a test can re-derive it rather than remember it.
   */
  readonly columns: number;
}

/**
 * The refusal sentence, in ONE place, because two things need it: the component
 * that prints it and the floor that has to be wide enough to print it.
 *
 * It names both numbers on `RunDirMountError`'s pattern (`paths.ts:755-791`) —
 * a refusal an operator can act on beats one they have to investigate — and it
 * names the VIEW, which view 1's refusal did not have to when there was one
 * floor. There are four now and they differ, so an operator who widened a pane
 * until the fleet drew and then pressed a key needs to be told which floor they
 * have just hit.
 */
export function refusalSentence(view: string, needed: number, have: number): string {
  return `pifleet monitor's ${view} view needs at least ${needed} columns; this pane has ${have}.`;
}

/**
 * THE FLOOR OF THE FLOOR: a view may never be narrower than its own refusal.
 *
 * **This was found by a test rather than reasoned out, and the finding is the
 * useful part.** View 4 owns no columns — it is built entirely of full-width
 * lines — so the sum rule gave it a floor of 3, which is the rule's honest
 * output and was accepted as such. The ISC-505 sweep then asserted that every
 * view refuses one column below its floor, and view 4 failed: at two columns
 * Ink has no choice but to break `needs` mid-word, so the frame contains the
 * refusal's characters and no readable sentence. **A refusal nobody can read is
 * not a refusal**, and D14's whole content is that a refusal beats a misleading
 * layout — which is false if the refusal is itself the misleading layout.
 *
 * So the floor is raised to the longest WORD the refusal would print. Below
 * that width a token is hard-broken and the sentence stops being one; at or
 * above it, Ink wraps at spaces and every word survives. That is still derived
 * — it is a property of the sentence this module already owns — and it is not a
 * number anybody chose.
 *
 * `999` stands in for the width the sentence will quote, which is circular
 * otherwise: the floor is what the sentence names and the sentence's length
 * depends on it. Three digits is an upper bound on any floor these views
 * produce (the largest today is 32), so the probe over-estimates by nothing
 * that matters — every numeric token is shorter than `monitor's` regardless.
 */
export function longestRefusalWord(view: string): number {
  return refusalSentence(view, 999, 999)
    .split(" ")
    .reduce((longest, word) => Math.max(longest, word.length), 0);
}

/**
 * The floor a view's refusal imposes: one column WIDER than its longest word.
 *
 * The `+ 1` is not padding. A refusal is only ever shown BELOW the floor, so the
 * widest pane that will ever render it is `floor - 1` — and for the sentence to
 * wrap on spaces there, `floor - 1` must be at least the longest word. Setting
 * the floor equal to the longest word instead leaves exactly one width, the
 * widest one the refusal ever sees, at which it is hard-broken. That off-by-one
 * is the whole content of this function and it was caught by the ISC-505 sweep
 * asserting legibility at `floor - 1` rather than at some convenient width.
 *
 * Nothing below `floor - 1` is helped, and nothing can be: a four-column pane
 * cannot hold `monitor's` under any policy. The claim is bounded to the width
 * where a choice exists.
 */
function refusalMinimum(view: string): number {
  return longestRefusalWord(view) + 1;
}

/**
 * Derive a view's floor from the cells it may not drop.
 *
 * The gutter is added HERE rather than by each caller because forgetting it is
 * the mistake that produces a floor one gutter too small — a view that agrees
 * to draw at a width where its first column starts past the right edge.
 *
 * It defaults to {@link INDENT} because three of the four views open a row with
 * two spaces, a severity bullet and a space. View 4 has no rows and no bullet —
 * its body begins at two — so it passes its own, which is a parameter rather
 * than a subtraction at the call site for a reason: a caller correcting a
 * constant it was given is how the constant stops meaning anything.
 *
 * The `max` against {@link refusalMinimum} binds only for a view whose columns
 * sum to less than its own refusal's longest word. Today that is view 4 alone,
 * and the three views with real columns are unaffected — `FLOOR_COLUMNS` is
 * still 32, which the pinned frames in `monitor-render.test.ts` enforce.
 */
export function deriveFloor(
  view: string,
  neverDropped: readonly (readonly [string, number])[],
  gutter: number = INDENT,
): ViewFloor {
  const cells = neverDropped.reduce((sum, [, w]) => sum + w, gutter);
  return { view, neverDropped, gutter, columns: Math.max(cells, refusalMinimum(view)) };
}

/**
 * The refusal, shared so all four views refuse in the same voice — and drawn
 * from {@link refusalSentence}, so the sentence the floor was sized against is
 * the sentence that gets printed.
 *
 * It WRAPS rather than truncating, which is the one place in these views where
 * wrapping is unambiguously right: a truncated refusal would read `pifleet
 * monitor's fleet view needs at` and be exactly the unreadable output the
 * refusal exists to avoid. `refusalMinimum` is what guarantees the wrap lands
 * on spaces rather than mid-word.
 */
export function FloorRefusal({ floor, have }: { floor: ViewFloor; have: number }) {
  const p = usePalette();
  return (
    <Text wrap="wrap" color={p.alarm} bold={p.on}>
      {refusalSentence(floor.view, floor.columns, have)}
    </Text>
  );
}
