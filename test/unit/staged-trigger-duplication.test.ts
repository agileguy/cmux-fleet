/**
 * ONE ALLOCATION, ONE TURN — the probe for the double-trigger that burned a
 * third of `rev-arch-1`'s context on work it had already finished.
 *
 * ## The defect, as it was measured rather than as it was guessed
 *
 * The standing suspicion was fan-out re-dispatch, and the relay's `already_done`
 * ledger acquitted it: repeat passes log `already dispatched, unchanged` and
 * stage nothing. The real mechanism is that ONE stage fires TWO triggers, from
 * two different senders that do not know about each other:
 *
 *   1. `stageForAdoptedTerminal` STEP 7 types `STAGED_TRIGGER_LINE` at the
 *      pane. The turn starts.
 *   2. ~300ms later `docker/pi-extensions/dispatch-trigger.ts` — mounted
 *      whenever `auto_trigger` is true, which is the DEFAULT
 *      (`config/load.ts`) — sees the same drop and calls
 *      `sendUserMessage(AUTO_TRIGGER_TEXT, { deliverAs: "followUp" })`.
 *
 * `followUp` is the correct choice for that extension in isolation: it queues
 * rather than interrupting. Here it means the second trigger is not discarded,
 * it WAITS — through the whole first turn — and is delivered as a fresh user
 * message the instant the turn ends. `/policy/dispatch` still holds the same
 * task, so the worker reads its own finished task back as new work.
 *
 * Measured, run `2026-09-04T22-10-12Z-b851`, worker `rev-arch-1`, transcript
 * entry 109, in the worker's own words:
 *
 *     "This is the same task I already completed. The dispatch is identical
 *      (same task_id, epoch, worker, outbox)."
 *
 * The two messages in that transcript are 1.1 SECONDS apart by their creation
 * timestamps (1788560666127 and 1788560667244) and 3m49s apart by delivery —
 * the gap is the first turn. That session reached 3,480,664 cumulative input
 * tokens, 455,266 of them after the re-delivery.
 *
 * It was invisible until 2026-09-04 because the host trigger did not work:
 * `CmuxParseError: could not parse composed pane id` made every send a
 * `stage_trigger_deferred`, so the extension was the only trigger and the fleet
 * behaved correctly. Fixing the pane id (`test/unit/staged-trigger.test.ts`,
 * measured in run `2026-09-04T02-28-00Z-e07e`) armed the second sender. Every
 * `tui` session from `2026-09-04T02:50Z` onward shows both.
 *
 * ## Why the fixture is built the way it is
 *
 * The two states this file distinguishes are "typed" and "not typed", and the
 * cheap way to write it — let `sendStagedTrigger` reach for the real `cmux`
 * binary — makes them COINCIDE: with no cmux on the box every arm throws, every
 * arm returns `sent: false`, and the probe passes against the broken code. So
 * the backend is injected and RECORDS, the surface is addressable, and the
 * armed arm must observe ZERO sends where the unarmed arm observes two. The
 * only difference between the arms is the launch record.
 */

import { describe, expect, test } from "bun:test";

import type { Presentation, WorkerLaunch } from "../../src/contracts.ts";
import type { FleetBackend } from "../../src/backends/types.ts";
import { sendStagedTrigger } from "../../src/cli/commands/dispatch.ts";
import { AUTO_TRIGGER_TEXT, STAGED_TRIGGER_LINE } from "../../src/util/pane-text.ts";

/** An adopted cmux surface that CAN be typed at — the non-degenerate case. */
const PRESENTATION: Presentation = {
  schema: "pifleet.presentation/v1",
  worker: "rev-arch-1",
  backend: "headless",
  workspace_ref: "WS-1",
  workspace_name: "review",
  surface_ref: "3AF7EC42-043A-4B96-AB84-D0E4B66B712A",
  window_ref: null,
  adopted_terminal: true,
  surface_backend: "cmux",
  attach_process: null,
} as unknown as Presentation;

function launch(autoTrigger: boolean): WorkerLaunch {
  return {
    kind: "container",
    argv: ["docker", "run", "--rm", "pifleet/pi-worker:test"],
    container: "pifleet-test-rev-arch-1",
    image: "pifleet/pi-worker:test",
    pane_mode: "tui",
    auto_trigger: autoTrigger,
  } as unknown as WorkerLaunch;
}

/**
 * A backend that answers `sendText`/`sendKey` and writes down every call.
 *
 * Deliberately NOT a throwing stub. A stub that failed would make "nothing was
 * typed" true for the wrong reason and hide a regression that types the line
 * anyway.
 */
function recordingBackend(): { backend: FleetBackend; typed: string[]; keys: string[] } {
  const typed: string[] = [];
  const keys: string[] = [];
  const backend = {
    sendText: async (_pane: unknown, text: string): Promise<void> => {
      typed.push(text);
    },
    sendKey: async (_pane: unknown, key: string): Promise<void> => {
      keys.push(key);
    },
  } as unknown as FleetBackend;
  return { backend, typed, keys };
}

describe("a stage on an auto-triggered worker is triggered ONCE", () => {
  /**
   * THE REGRESSION. Fails against the pre-fix body — which types
   * unconditionally — by recording one `sendText` and one `enter`.
   *
   * `sent: true` and `reason: null` are asserted alongside the emptiness
   * because `run/relay.ts` turns any non-null `error` from this route into a
   * `stage_trigger_deferred` REJECTION and drops the lens. A fix that suppressed
   * the keystroke by reporting failure would trade a duplicated review for a
   * discarded one.
   */
  test("an armed worker is not typed at, and the dispatch still reads as landed", async () => {
    const { backend, typed, keys } = recordingBackend();

    const outcome = await sendStagedTrigger("rev-arch-1", PRESENTATION, launch(true), async () => backend);

    expect(typed).toEqual([]);
    expect(keys).toEqual([]);
    expect(outcome.sent).toBe(true);
    expect(outcome.delegated).toBe(true);
    expect(outcome.reason).toBeNull();
  });

  /**
   * THE OTHER DIRECTION, and without it the test above is satisfied by a route
   * that simply stopped typing at all — which would strand every seat
   * `config/load.ts` describes as "the one that wants a human".
   */
  test("an unarmed worker IS typed at, line then submit", async () => {
    const { backend, typed, keys } = recordingBackend();

    const outcome = await sendStagedTrigger("rev-arch-1", PRESENTATION, launch(false), async () => backend);

    expect(typed).toEqual([STAGED_TRIGGER_LINE]);
    expect(keys).toEqual(["enter"]);
    expect(outcome.sent).toBe(true);
    expect(outcome.delegated).toBe(false);
  });

  /**
   * ABSENT launch record — every `PIFLEET_PI_COMMAND` double run, and any run
   * predating the field. `contracts.ts` defaults `auto_trigger` FALSE for
   * exactly this reason and `wait.ts` reads it as `?? false`; the trigger must
   * resolve the same way, or a fix aimed at the live fleet would silently stop
   * triggering the entire double-driven suite.
   */
  test("no launch record types the trigger, as it always did", async () => {
    const { backend, typed, keys } = recordingBackend();

    const outcome = await sendStagedTrigger("rev-arch-1", PRESENTATION, null, async () => backend);

    expect(typed).toEqual([STAGED_TRIGGER_LINE]);
    expect(keys).toEqual(["enter"]);
    expect(outcome.delegated).toBe(false);
  });

  /**
   * The suppression must be keyed on `auto_trigger` and NOT on `pane_mode`.
   *
   * They are different facts and `materialize.ts` writes the conjunction into
   * the record already (`auto_trigger: paneMode === "tui" && autoTrigger`), so
   * a `tui` worker with the extension deliberately switched off still has a
   * `tui` pane_mode — and gating on the mode would leave that seat with no
   * trigger at all and nothing to say so.
   */
  test("pane_mode tui with auto_trigger off is still typed at", async () => {
    const { backend, typed } = recordingBackend();
    const off = { ...launch(false), pane_mode: "tui" } as unknown as WorkerLaunch;

    await sendStagedTrigger("rev-arch-1", PRESENTATION, off, async () => backend);

    expect(typed).toEqual([STAGED_TRIGGER_LINE]);
  });

  /**
   * The two senders must stay TELLABLE APART in a transcript.
   *
   * `supervisor/tui.ts`'s `attributedToStage` recognises only
   * `AUTO_TRIGGER_TEXT`, which is why every staged turn in the run trees logged
   * `attributed_to_stage: false` with an "APPROXIMATE" detail — the host's line
   * won the race and the attribution machinery could not see it. Suppressing
   * the host line hands the turn back to the sender attribution was written
   * for, and that only holds while the strings differ.
   */
  test("the two trigger texts are not the same string", () => {
    expect(AUTO_TRIGGER_TEXT).not.toBe(STAGED_TRIGGER_LINE);
  });
});
