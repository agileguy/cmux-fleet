/**
 * ISC-507 — the four views are REACHABLE, and a selection that names nothing is
 * refused before anything is read.
 *
 * ## Why this file exists at all
 *
 * Views 2-4 landed in two halves — the readers and the renderers — and both
 * were complete, tested and merged while **nothing could enter them**. The
 * model could hold a `{ kind: "worker" }`, `fetchForView` could fill it, three
 * `.tsx` files could draw it, and the only caller in the repo constructed
 * `{ kind: "fleet" }` as a literal. That is the dead-code shape at its most
 * convincing: every part has tests, and the feature does not exist.
 *
 * So the criterion is about the JOIN, not about any of the parts. What it
 * asserts is that operator input becomes a `ViewState` in exactly one place,
 * that the place either produces a valid one or refuses, and that the refusal
 * is visible to a script and not only to a person.
 *
 * ## The bug this file was written against, kept because it is instructive
 *
 * The first version of the refusal path wrote a message to stderr and set
 * `process.exitCode = EXIT.USAGE`. Every refusal exited **0**. `main` in
 * `src/cli/index.ts` ends `await program.parseAsync(argv); return
 * EXIT.SUCCESS;` and `src/cli/index.ts:153` assigns that return over
 * `process.exitCode` — so an action setting the field is writing to something
 * that is about to be overwritten. The message was right, the behaviour was
 * right, and a caller in a script was told it had succeeded.
 *
 * `expect(err.exitCode).toBe(EXIT.USAGE)` is therefore not ceremony around a
 * type: it is the assertion that fails if someone re-introduces the
 * `process.exitCode` version, which reads as correct in review and cannot be
 * caught by reading stderr.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../../src/contracts.ts";
import { ViewFlagError, viewFromFlags } from "../../src/cli/commands/monitor.ts";
import { composeFleet } from "../../src/monitor/compose.ts";
import { never } from "../../src/monitor/model.ts";

describe("ISC-507: every view is reachable, and only with the selection it needs", () => {
  test("the four names produce the four views", () => {
    expect(viewFromFlags({ view: "fleet" })).toEqual({ kind: "fleet" });
    expect(viewFromFlags({ view: "history" })).toEqual({ kind: "history" });
    expect(viewFromFlags({ view: "report", run: "r1" })).toEqual({ kind: "report", runId: "r1" });
    expect(viewFromFlags({ view: "worker", run: "r1", worker: "eng-1" })).toEqual({
      kind: "worker",
      runId: "r1",
      workerId: "eng-1",
    });
  });

  /**
   * ISC-483's requirement, expressed where an operator meets it: the view you
   * get by naming none is the one that needs no selection.
   */
  test("no --view at all is the fleet, which is the view that needs no input", () => {
    expect(viewFromFlags({})).toEqual({ kind: "fleet" });
  });

  test("a view whose selection is missing refuses, and names what it needs", () => {
    for (const flags of [
      { view: "worker", run: "r1" },
      { view: "worker", worker: "eng-1" },
      { view: "worker" },
    ]) {
      expect(() => viewFromFlags(flags)).toThrow(/--view worker needs both --worker/);
    }
    expect(() => viewFromFlags({ view: "report" })).toThrow(/--view report needs --run/);
  });

  /**
   * THE SUPERFLUOUS FLAG IS ALSO A REFUSAL, and this is the half a reasonable
   * implementation leaves out.
   *
   * `--view history --worker eng-1` has everything the history view needs. The
   * permissive reading renders the run list and ignores `--worker`, which is
   * the same defect class as a viewer showing a stale number confidently: the
   * command did something reasonable and not the thing it was asked for, and
   * the operator walks away believing they asked about `eng-1`.
   */
  test("a selection the view cannot use refuses rather than being ignored", () => {
    expect(() => viewFromFlags({ view: "history", worker: "eng-1" })).toThrow(
      /--view history takes no selection; --worker would be ignored/,
    );
    expect(() => viewFromFlags({ view: "fleet", run: "r1" })).toThrow(
      /--view fleet takes no selection; --run would be ignored/,
    );
    expect(() => viewFromFlags({ view: "report", run: "r1", worker: "eng-1" })).toThrow(
      /--view report takes --run; --worker would be ignored/,
    );
  });

  test("an unknown view names the four that exist", () => {
    expect(() => viewFromFlags({ view: "timeline" })).toThrow(
      /unknown view "timeline". The four are: fleet, worker, history, report/,
    );
  });

  /**
   * The assertion the exit-0 bug would fail. See this file's header.
   */
  test("every refusal carries the USAGE code, not merely a message", () => {
    for (const flags of [
      { view: "worker" },
      { view: "report" },
      { view: "history", worker: "eng-1" },
      { view: "timeline" },
    ]) {
      let caught: unknown;
      try {
        viewFromFlags(flags);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ViewFlagError);
      expect((caught as ViewFlagError).exitCode).toBe(EXIT.USAGE);
    }
  });

  /**
   * The other end of the join: a view the caller names is a view the composed
   * model actually holds, and the fleet view still costs nothing (ISC-502).
   */
  test("composeFleet carries the named view, and the fleet view fetches nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-view-entry-"));

    const fleet = await composeFleet({
      root,
      watchDir: root,
      columns: 100,
      containers: never(),
    });
    expect(fleet.view).toEqual({ kind: "fleet" });
    expect(fleet.history.status).toBe("never");
    expect(fleet.detail.status).toBe("never");
    expect(fleet.report.status).toBe("never");

    const history = await composeFleet({
      root,
      watchDir: root,
      columns: 100,
      containers: never(),
      view: { kind: "history" },
    });
    expect(history.view).toEqual({ kind: "history" });
    // Read and empty — an empty runs root has no history, which is a fact and
    // NOT the `never` above. `model.ts:57-65` is the whole reason these are
    // asserted as different values rather than both as "nothing on screen".
    expect(history.history.status).toBe("ok");
    expect(history.detail.status).toBe("never");
    expect(history.report.status).toBe("never");
  });
});
