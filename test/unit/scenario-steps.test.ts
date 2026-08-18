/**
 * The scenario partition rule (`test/fixtures/scenario-steps.ts`).
 *
 * This logic decides which script each worker in a fleet runs, and until it was
 * extracted it had no direct test at all: it lived inside `fake-pi.ts`, an
 * executable that consumes stdin at import time, so the only way to exercise it
 * was to stand up a live sixteen-worker fleet and infer the rule from the
 * outcome. The completion-tracker simulator that reads the same scenarios is
 * session-BLIND — it replays every prompt step in order — so it cannot see this
 * rule either, and a scenario edit that stranded fourteen workers would have
 * left both green while the e2e fleet hung to its deadline.
 *
 * The last block is the one that matters most: it asserts the partition over
 * the REAL `noisy-fleet.json`, for all sixteen real worker ids.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stepsForSession, type PartitionableStep } from "../fixtures/scenario-steps.ts";

const SCENARIO_DIR = new URL("../fixtures/scenarios/", import.meta.url).pathname;

interface PromptStep extends PartitionableStep {
  emit?: Array<Record<string, unknown>>;
}

describe("stepsForSession — the partition rule", () => {
  const steps: PartitionableStep[] = [
    { on: "prompt", sessions: ["eng-1"] },
    { on: "prompt", sessions: ["eng-2"] },
    { on: "prompt" },
    { on: "get_state" },
  ];

  test("a session-specific step wins outright over the unrestricted fallback", () => {
    // Not a merge: eng-1 gets its own step and NOT the fallback. Merging would
    // make the meaning depend on document order across two different intents,
    // and would walk a noisy worker onto the fallback on its second dispatch.
    expect(stepsForSession(steps, "prompt", "eng-1")).toEqual([{ on: "prompt", sessions: ["eng-1"] }]);
    expect(stepsForSession(steps, "prompt", "eng-2")).toEqual([{ on: "prompt", sessions: ["eng-2"] }]);
  });

  test("an unnamed session falls back to the unrestricted step", () => {
    expect(stepsForSession(steps, "prompt", "eng-9")).toEqual([{ on: "prompt" }]);
  });

  test("a command with no steps at all is empty and silent", () => {
    // Normal: most commands are unscripted and fall through to the double's
    // defaults. Warning here would print on nearly every RPC.
    const warnings: string[] = [];
    expect(stepsForSession(steps, "get_session_stats", "eng-1", (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a session left with no applicable step WARNS rather than falling silent", () => {
    // The hazard: narrow the fallback and fourteen workers ack their prompt,
    // emit nothing, and hang to their full deadline looking healthy.
    const narrowed: PartitionableStep[] = [
      { on: "prompt", sessions: ["eng-1"] },
      { on: "prompt", sessions: ["eng-2"] },
    ];
    const warnings: string[] = [];
    expect(stepsForSession(narrowed, "prompt", "eng-9", (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("eng-9");
    expect(warnings[0]).toContain("no unrestricted fallback");
  });
});

describe("noisy-fleet.json partitions all sixteen ISC-158 workers", () => {
  const WORKERS = Array.from({ length: 16 }, (_, i) => `eng-${i + 1}`);
  const NOISY = ["eng-1", "eng-2"];

  test("every worker draws exactly one prompt script, and the right one", async () => {
    const doc = JSON.parse(
      await Bun.file(join(SCENARIO_DIR, "noisy-fleet.json")).text(),
    ) as { steps: PromptStep[] };

    for (const worker of WORKERS) {
      const warnings: string[] = [];
      const drawn = stepsForSession(doc.steps, "prompt", worker, (m) => warnings.push(m));
      // Exactly one: two would make the double's cursor advance to a different
      // script on a second dispatch, which is not what any of these scenarios
      // mean. Zero is the silent hang.
      expect(drawn).toHaveLength(1);
      expect(warnings).toEqual([]);

      const emits = drawn[0]!.emit ?? [];
      const floods = emits.some((e) => "noise" in e);
      // The scripts are distinguishable by their content, not merely present:
      // eng-1 and eng-2 flood a pipe, the other fourteen sleep 50ms. That 50ms
      // is the arithmetic floor the e2e latency assertion leans on.
      expect(floods).toBe(NOISY.includes(worker));
      if (!floods) {
        expect(emits).toContainEqual({ delay_ms: 50 });
      }
    }
  });

  test("the flood volumes match the constants the e2e test asserts against", async () => {
    // Drift check in BOTH directions. The e2e file duplicates these as
    // constants and asserts `>= NOISE_LINES`, which only catches the scenario
    // shrinking; a scenario that grew would leave that assertion passing while
    // silently no longer describing the fleet.
    const doc = JSON.parse(
      await Bun.file(join(SCENARIO_DIR, "noisy-fleet.json")).text(),
    ) as { steps: PromptStep[] };

    for (const worker of NOISY) {
      const drawn = stepsForSession(doc.steps, "prompt", worker);
      const noise = (drawn[0]!.emit ?? []).find((e) => "noise" in e) as
        | { noise: { stream: string; lines: number; bytes: number } }
        | undefined;
      expect(noise).toBeDefined();
      expect(noise!.noise.lines).toBe(2000);
      expect(noise!.noise.bytes).toBe(400);
    }
  });
});
