/**
 * THE SEAM (SRD-FLEET-MONITOR D2, §6.6.1, ISC-491).
 *
 * `renderFleet(model): string[]`. Above this line the monitor is a pure function
 * from a `FleetModel` to lines; below it, Ink. **The point of the file is that
 * nothing above it can tell**, and the measure of whether that is true is D2's
 * own: swapping Ink for hand-rolled ANSI later means reimplementing the two
 * functions here and changing no test in `test/unit/monitor-render.test.ts`.
 *
 * Ink was the owner's decision on 2026-09-02, taken against the SRD's own
 * recommendation, and it is only cheap to unwind because of this file. So this
 * file stays small: one capture stream, one mount, one unmount, and one switch.
 * Every line of layout lives under `views/` — `fleet.tsx`, `worker.tsx`,
 * `history.tsx`, `report.tsx` and the `chrome.tsx` they share — all of which a
 * replacement would delete; every line here is the twenty a replacement would
 * rewrite.
 *
 * **The dispatch is the one thing that grew, and it grew by a switch rather than
 * by a component.** §6.2's four views could have been one `<Monitor model>` that
 * branched internally, which would have kept this file at its original length
 * and moved the branch below the seam. It is here instead because the branch is
 * on `model.view`, which is MODEL state, and a toolkit swap must be able to see
 * which view it is reimplementing without reading a reconciler.
 *
 * ## Why `ink-testing-library` is NOT used, though the SRD's probe used it
 *
 * **One reason, and it is decisive on its own: it is a devDependency**
 * (`package.json:32`). This module is production source — the monitor imports it
 * to paint a pane — so importing a devDependency here works on a developer's
 * machine and fails on any install that omits dev dependencies. That is a defect
 * discovered by someone other than the author, which is the worst kind. The whole
 * of what the library provides is the eleven lines of `Capture` below, and `ink`
 * is already a runtime dependency, so the substitution costs nothing.
 *
 * **A second reason was claimed here and MEASURED FALSE; it is corrected rather
 * than deleted, because the correction is the useful part.** The claim was that
 * the library's stdout hard-codes `columns` to 100 with no way to set it
 * (`node_modules/ink-testing-library/build/index.js` — `get columns() { return
 * 100; }`), and that a seam built on it therefore could not express §6.5's
 * degradation ladder or ISC-484/ISC-485. The hard-coding is real; the
 * consequence is not. `views/fleet.tsx` puts `width={model.columns}` on its root
 * `Box`, and an explicit width governs Ink's layout entirely — rendering the same
 * model through a stream reporting 100 columns and one reporting 200 produces
 * **byte-identical frames**, including for content long enough to truncate. So
 * the width requirement is carried by the component, not by the stream, and this
 * argument never held. It was found by a mutation that replaced `model.columns`
 * with `100` here and was NOT killed by any test — which is the correct outcome
 * for a mutant that changes no behaviour, and the wrong outcome for a comment
 * asserting that it would.
 *
 * `Capture` is still constructed from `model.columns` rather than from a
 * constant. Not because anything currently reads it, but because a stream that
 * reported a width contradicting the model would be a trap for the first
 * component that omitted an explicit width — and agreeing with the model costs
 * one identifier.
 *
 * ## `debug: true` is load-bearing
 *
 * It makes Ink write the complete frame as plain text on every render instead of
 * emitting cursor-addressing escapes. Without it a caller would receive ANSI
 * control sequences interleaved with content and every assertion in this design
 * would be written against escape codes — which is the "a component tree is not
 * pinnable" claim §6.6.1 refuted, arriving again by a different route.
 */

import { EventEmitter } from "node:events";
import { createElement } from "react";
import type { ReactElement } from "react";
import { render } from "ink";

import type { FleetModel } from "./model.ts";
import { COLOUR, PLAIN, PaletteProvider } from "./views/chrome.tsx";
import { Fleet } from "./views/fleet.tsx";
import { History } from "./views/history.tsx";
import { RunReport } from "./views/report.tsx";
import { Worker } from "./views/worker.tsx";

/**
 * A stdout Ink can write to that is not a terminal.
 *
 * `EventEmitter` because Ink attaches a `resize` listener to whatever it is
 * given; `columns` because that is how Ink learns the width. Only the LAST frame
 * is kept — Ink writes several during a mount and the earlier ones are
 * intermediate reconciler passes, not renderings anyone asked for.
 */
class Capture extends EventEmitter {
  readonly columns: number;
  lastFrame: string | undefined = undefined;

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  // An arrow property rather than a method: Ink stores the stream and calls
  // `stdout.write(...)`, and a prototype method detached from its receiver would
  // lose `this`.
  write = (frame: string): void => {
    this.lastFrame = frame;
  };
}

/**
 * THE DISPATCH — one view per `model.view.kind` (§6.2, D8).
 *
 * It is BEHIND `renderFleet` rather than beside it. A second exported entry
 * point — `renderWorker(model)` — was the obvious shape and is the wrong one.
 * `model.view` is a discriminated union precisely so that a worker view without
 * a selection is not representable (`model.ts:343-355`), and two doors would
 * hand that guarantee back: a caller holding a `{kind: "worker"}` model could
 * call `renderFleet` and get a fleet frame for a selection nobody asked to
 * leave. **One model, one view field, one function — the union decides, not the
 * call site.**
 *
 * `switch` with no `default`: `ViewState` is exhausted, so this function's
 * declared return type holds only while every arm is covered, and a fifth view
 * fails the typecheck HERE rather than silently rendering the fleet. A
 * `default` would install exactly that silence and would look like robustness.
 *
 * Each view is handed its OWN region and the selection out of `view`, never the
 * whole model — **ISC-503 expressed as a parameter list rather than as a rule
 * somebody has to remember.** `Fleet` takes the model because view 1's content
 * IS three regions at once (runs, containers, git); the other three take one
 * region each and are structurally unable to reach a second.
 */
function viewElement(model: FleetModel): ReactElement {
  const view = model.view;
  const now = model.now;
  const columns = model.columns;
  switch (view.kind) {
    case "fleet":
      return createElement(Fleet, { model });
    case "worker":
      return createElement(Worker, { detail: model.detail, selection: view, now, columns });
    case "history":
      return createElement(History, { history: model.history, now, columns });
    case "report":
      return createElement(RunReport, { report: model.report, selection: view, now, columns });
  }
}

/**
 * The frame, as lines.
 *
 * **The NAME stays `renderFleet` although it now renders four views**, and that
 * is a deliberate trade rather than an oversight. D2's seam is about the SHAPE
 * — `(model) => string[]`, with Ink entirely below it — and every assertion in
 * `monitor-render.test.ts` names this function. A rename would touch all of
 * them to prove nothing, at exactly the moment three new views land and a
 * readable diff is worth most. The cost is a name narrower than its function,
 * recorded here so the next reader does not mistake it for a missing dispatch.
 *
 * Mount, read, unmount — in that order, and the order is not incidental.
 * `unmount()` writes a final frame of its own, so reading after it returns the
 * teardown rather than the content (measured: the last write after unmount is
 * `"\n"`). Reading first is the difference between this function returning the
 * fleet and returning a blank line.
 *
 * **The `undefined` case throws rather than coalescing to `""`.** §6.6.1's own
 * sketch writes `(lastFrame() ?? "")`, and that idiom is wrong here: it yields
 * `[""]`, a frame that renders as one empty line and is indistinguishable from a
 * fleet that legitimately had nothing to say. This entire design exists to keep
 * "I could not look" apart from "I looked and there was nothing" (ISC-479,
 * `model.ts:57-65`), and silently defaulting at the seam would reintroduce the
 * conflation one layer above every test that guards against it. Ink's first
 * render is synchronous, so reaching this is a programming error and not a
 * runtime state; a caller that wants to survive it can catch a named error,
 * which it cannot do with an empty string.
 */
export function renderFleet(model: FleetModel, opts?: { readonly colour?: boolean }): string[] {
  const stdout = new Capture(model.columns);
  /*
   * COLOUR IS OPT-IN, and the default is what every test in this design
   * compares against.
   *
   * **Two independent gates, and both must be open.** This flag decides whether
   * the components set `color` props at all; `chalk`'s own level — computed
   * once from the real `process.stdout` when it is imported — decides whether
   * those props produce SGR escapes. In a pane both are open and the frame is
   * coloured; piped or redirected, chalk's gate closes on its own and the frame
   * is plain text a grep can read, with no flag needed. A capture stream that
   * declared itself a TTY was tried and does nothing: chalk is not consulted
   * per-stream, so the honest mechanism is the ambient one every CLI uses. Ink emits SGR escapes inline, so a coloured frame turns
   * `toContain("wrote 11m ago")` into a comparison against
   * `\x1b[32mwrote 11m ago\x1b[39m`. One component tree produces both, so the
   * painted frame cannot drift from the asserted one — what differs between
   * them is escapes and nothing else, which is why the severity bullet is
   * present in the plain frame too rather than appearing only when styled.
   */
  const instance = render(
    createElement(
      PaletteProvider,
      { value: opts?.colour === true ? COLOUR : PLAIN },
      viewElement(model),
    ),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: new EventEmitter() as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const frame = stdout.lastFrame;
  instance.unmount();
  instance.cleanup();
  if (frame === undefined) throw new Error("renderFleet: Ink produced no frame");
  return frame.split("\n");
}
