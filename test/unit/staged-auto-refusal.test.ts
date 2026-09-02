/**
 * `--auto` still refuses an adopted-terminal `tui` worker (ISC-453, D13).
 *
 * ## Why this criterion exists at all, when nothing was changed to satisfy it
 *
 * D6 gave the staged route a real epoch and a real task record, which is
 * exactly the obstacle `--auto`'s refusal was written against: a `tui` worker
 * could not be scheduled because nothing could observe its task reaching a
 * terminal state. That obstacle is gone. **The reason for the refusal is not.**
 *
 * D13's sentence: a DAG that blocks on a person reports nothing while it
 * blocks. `--auto` walks a dependency graph and its whole value is that it
 * keeps going; a node whose completion waits on somebody noticing a line in a
 * terminal turns the scheduler into a thing that appears to be working and is
 * not. The staged route makes the outcome OBSERVABLE, which is a different
 * property from making it ARRIVE.
 *
 * So this is an anti-criterion, and it is filed because the change that would
 * break it is one a well-meaning reader would make: "staging settles now, so
 * `--auto` can schedule it." The refusal must survive the removal of its
 * stated obstacle.
 *
 * ## What each probe here can and cannot prove
 *
 * The refusal lives inside `register(program)` in `src/cli/commands/dispatch.ts`
 * — a `commander` action closure, not an exported function — so there is no
 * unit-callable entry point for the `--auto` scheduling loop. Driving it for
 * real needs a fleet, and `test/integration/dispatch-auto.test.ts` builds one
 * but has no `tui` case; adding one would need a container with a pty, which
 * ISC-455 forbids for this block.
 *
 * What IS available is stronger than it first looks, because of a structural
 * accident worth naming: **the routing decision is taken by `planDispatch`,
 * whose only input is the worker's LAUNCH RECORD.** A launch record has no
 * notion of adoption — adoption is recorded in `presentation.json`, a
 * different file written by a different code path — so adoption cannot alter
 * this decision without someone giving `planDispatch` a second input. That is
 * not a check that can be forgotten; it is a change that cannot be made
 * quietly.
 *
 * The three probes below are therefore: the decision itself (behavioural), the
 * shape that keeps adoption out of it (structural), and the reachability of
 * the staged fork from the `--auto` path (ordering). None of them requires a
 * pty, a container, or a terminal.
 */

import { describe, expect, test } from "bun:test";
import { planDispatch } from "../../src/cli/commands/dispatch.ts";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";

const SOURCE = new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname;

/** The rejection's exact spelling. A rename is a contract change for callers. */
const REASON = "pane_mode_tui_is_not_auto_schedulable";

/**
 * CODE, not prose — the same helper `staged-trigger.test.ts` uses and for the
 * same reason. This module's docblocks discuss adoption and the staged route
 * at length precisely to explain why `--auto` does NOT consult them, so a
 * search over the raw text answers the opposite of the question being asked.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function tuiLaunch(): WorkerLaunch {
  return WorkerLaunchSchema.parse({
    kind: "container",
    // `-t` and no `--mode rpc` — the consistent tui shape `launchPaneMode` wants.
    argv: ["docker", "run", "-t", "--name", "pifleet-r-w", "img", "pi"],
    container: "pifleet-r-w",
    image: "img",
    pane_mode: "tui",
  });
}

describe("--auto refuses a tui worker on the launch record, which cannot see adoption", () => {
  /**
   * The decision, behaviourally. An adopted-terminal worker IS a `tui` worker
   * — adoption changes who owns the surface, not how the worker was launched —
   * so the route it plans is the pane route, which is the one `--auto` rejects.
   */
  test("a tui launch record still plans the pane route", () => {
    expect(planDispatch(tuiLaunch())).toEqual({ kind: "pane" });
  });

  /**
   * THE STRUCTURAL GUARANTEE, and the reason this criterion can be graded at
   * all without a fleet.
   *
   * `planDispatch` takes one argument and it is the launch record. Adoption
   * lives in `presentation.json`. For an adopted worker to be scheduled
   * differently, someone would have to widen this signature — a change no
   * reviewer can miss, and the same reasoning `StageDeps` uses to make
   * "`stage` falls through to `send`" fail to compile rather than merely fail
   * a guard.
   */
  test("planDispatch's body consults no presentation and no adoption", async () => {
    const text = await Bun.file(SOURCE).text();
    const from = text.indexOf("export function planDispatch(");
    expect(from, "planDispatch was renamed or removed").toBeGreaterThan(-1);
    const body = code(text.slice(from, text.indexOf("\n}", from)));
    expect(body).not.toContain("presentation");
    expect(body).not.toContain("adopted");
    expect(body).not.toContain("surface");
    // …and it still reads the one input it is allowed to have.
    expect(body).toContain("launchPaneMode(launch)");
  });

  /**
   * REACHABILITY. The staged fork lives inside `sendTaskEnvelope`; the `--auto`
   * loop returns its rejection BEFORE calling it. So there is no path from
   * `--auto` to `stageForAdoptedTerminal` at all — the refusal is not a check
   * the staged route happens to pass, it is a branch the staged route is not
   * downstream of.
   *
   * Pinned on order rather than on absence because `sendTaskEnvelope` is
   * legitimately called by the `--auto` loop for every rpc worker; asserting it
   * is never called would assert `--auto` does nothing.
   */
  test("the auto rejection returns before the loop can reach sendTaskEnvelope", async () => {
    const text = code(await Bun.file(SOURCE).text());
    const reason = text.indexOf(REASON);
    expect(reason, "the auto rejection reason is gone").toBeGreaterThan(-1);
    const rejected = text.indexOf('return { kind: "rejected", reason };', reason);
    const send = text.indexOf("await sendTaskEnvelope({", reason);
    expect(rejected, "the rejection no longer returns").toBeGreaterThan(-1);
    expect(send, "the auto loop no longer dispatches anything").toBeGreaterThan(-1);
    expect(rejected).toBeLessThan(send);
  });

  /**
   * The reason string itself, byte-exact and asserted in three places at once.
   *
   * `up` PRINTS this token to the operator at fleet start
   * (`cli/commands/up.ts`), the ledger records it as a `dispatch_rejected`
   * detail, and `orchestrate/graph.ts` names it in the comment explaining an
   * edge it cannot see. A rename that updated the code and not the warning
   * would leave `up` promising a refusal by a name nothing emits.
   */
  test("the refusal is spelled the same in the code and in the operator warning", async () => {
    const dispatch = await Bun.file(SOURCE).text();
    const up = await Bun.file(
      new URL("../../src/cli/commands/up.ts", import.meta.url).pathname,
    ).text();
    expect(code(dispatch)).toContain(`const reason = "${REASON}"`);
    expect(up).toContain(REASON);
  });
});
