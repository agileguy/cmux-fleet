/**
 * `harvestTask` ACTUALLY LISTS THE TASK OUTBOX — the live `rev-lang-1` shape,
 * driven end to end.
 *
 * ## Why this file exists when `harvest-task-outbox.test.ts` is green
 *
 * `harvest/index.ts` carries the lesson in its own words: the rich adjudicator
 * *"had a full passing test suite and ZERO production callers"*, and *"a tested
 * mechanism with no live call site is indistinguishable at runtime from one
 * that was never written"*. `listTaskOutbox` is exactly that kind of mechanism —
 * a small pure-ish function with its own suite — so nothing here imports it.
 * These probes drive `harvestTask`, the function `pifleet artifacts` and the
 * relay adapter both call, and assert on what comes back.
 *
 * ## THE FIXTURE IS THE LIVE DEFECT, byte for byte
 *
 * `rev-lang-1` was dispatched a language review, wrote 12,759 bytes of genuine
 * review to `/outbox/<task>/artifact.json` — the TASK ROOT, under a name it
 * invented, carrying a `"schema"` it confabulated — and wrote no `result.json`
 * and no `files/`. The harvest reported the envelope missing, correctly, and
 * said nothing whatever about the 12,759 bytes sitting one directory from two
 * readers.
 *
 * ## AND THE ASYMMETRIC SIBLING, in the same run
 *
 * A second task, dispatched identically to the same worker, whose outbox holds
 * NOTHING. Both are missing their envelope; they differ only in that one file.
 * A listing that always answered "empty" and one that always answered "not
 * empty" each fail exactly one half of the pair — which is what nine earlier
 * probes on this branch could not say for themselves.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestTask } from "../../src/harvest/index.ts";
import { runPaths, workerOutboxDir, type RunPaths } from "../../src/run/paths.ts";

const RUN_ID = "r-task-outbox";
const WORKER = "rev-lang-1";
/** The task whose outbox holds the review under a name nothing reads. */
const HOLDING = "R-rally-async-6-lang";
/** Its twin, dispatched the same way, whose outbox holds nothing at all. */
const BARE = "R-rally-async-6-bare";

/**
 * The confabulated document, at the size the live worker actually wrote.
 *
 * The `schema` is the one `rev-lang-1` invented — `pifleet.ticketops/v1`, the
 * TICKETING schema, which appears nowhere in a reviewer's mounted material. It
 * is carried here as a CANARY: it is a distinctive string that exists only
 * inside these bytes, so a harvest that ever learned to read this file would be
 * caught by the containment assertion below rather than by review.
 */
const CONFABULATED_SCHEMA = "pifleet.ticketops/v1";
const REVIEW_BYTES = 12_759;

function reviewDocument(): string {
  const head = `{"schema":"${CONFABULATED_SCHEMA}","review":"`;
  const tail = `"}`;
  return head + "x".repeat(REVIEW_BYTES - head.length - tail.length) + tail;
}

interface Fixture {
  run: RunPaths;
  cleanup: () => Promise<void>;
}

/**
 * A run with two dispatched tasks for one worker and no worktree.
 *
 * `host_workdir: "unset"` is load-bearing rather than lazy: `harvestTask` then
 * skips `deriveGitFacts` entirely, so nothing here spawns git and the probe
 * measures the outbox and only the outbox.
 */
async function scaffold(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-task-outbox-wiring-"));
  const run = runPaths(RUN_ID, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });

  for (const taskId of [HOLDING, BARE]) {
    await writeFile(
      join(run.inboxDir, `${taskId}.json`),
      JSON.stringify({
        acceptance: [],
        schema: "pifleet.task/v1",
        task_id: taskId,
        run_id: RUN_ID,
        epoch: 1,
        attempt: 1,
        worker: WORKER,
        dispatched_at: new Date().toISOString(),
        title: taskId,
        brief: "review the change for language correctness",
        repo: root,
        host_workdir: "unset",
        container_workdir: "/workspace",
        branch: `fleet/${RUN_ID}/${WORKER}`,
        base_ref: "0".repeat(40),
        outbox: `/outbox/${taskId}`,
        deadline_s: 1500,
      }),
    );
    // Both task outboxes exist and NEITHER holds a result.json — the live shape.
    await mkdir(join(workerOutboxDir(run.root, WORKER), taskId), { recursive: true });
  }

  // THE ONLY DIFFERENCE between the two tasks.
  await writeFile(
    join(workerOutboxDir(run.root, WORKER), HOLDING, "artifact.json"),
    reviewDocument(),
  );

  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("harvestTask reports what a silent task's outbox actually holds", () => {
  test("the two tasks are missing their envelope in the same way", async () => {
    const f = await scaffold();
    try {
      for (const taskId of [HOLDING, BARE]) {
        const { harvest } = await harvestTask(f.run, taskId);
        // The control: without this both halves of the pair below could be
        // passing for a reason that has nothing to do with the listing.
        expect(harvest.claimed, `${taskId} must have no parsed envelope`).toBeNull();
        expect(harvest.discrepancies.join("\n")).toContain("has no result envelope");
      }
    } finally {
      await f.cleanup();
    }
  });

  test("the populated outbox is reported and the bare one is not", async () => {
    const f = await scaffold();
    try {
      const holding = await harvestTask(f.run, HOLDING);
      const bare = await harvestTask(f.run, BARE);

      expect(holding.taskOutbox).toEqual({
        kind: "unrecognised",
        named: [{ name: "artifact.json", kind: "file", bytes: REVIEW_BYTES }],
        total: 1,
      });
      expect(bare.taskOutbox).toEqual({ kind: "empty" });

      const holdingLines = holding.harvest.discrepancies.join("\n");
      const bareLines = bare.harvest.discrepancies.join("\n");
      expect(holdingLines).toContain("NOT EMPTY");
      expect(holdingLines).toContain(`artifact.json (${REVIEW_BYTES} bytes)`);
      expect(bareLines).not.toContain("NOT EMPTY");
      expect(bareLines).not.toContain("artifact.json");
    } finally {
      await f.cleanup();
    }
  });

  /**
   * THE CONTAINMENT ASSERTION, and it is the most important one here.
   *
   * The whole harvest is serialised and searched for a string that exists ONLY
   * inside those 12,759 bytes. The outbox is worker-authored and this bundle
   * reaches a collation brief — a prompt handed to a model — so a future
   * "helpful" preview, first line, or sniffed schema would be an injection
   * channel that does not exist today. Asserting against a field would miss
   * exactly that; asserting against the serialised whole cannot.
   */
  test("no byte of the unrecognised file reaches the harvest", async () => {
    const f = await scaffold();
    try {
      const bundle = await harvestTask(f.run, HOLDING);
      expect(JSON.stringify(bundle)).not.toContain(CONFABULATED_SCHEMA);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * The finding must survive the trip into the RECORD, not merely the return
   * value: `pifleet artifacts` reads `harvest.discrepancies`, and a fact that
   * lived only on `TaskHarvest` would be invisible to every operator command.
   */
  test("the finding is published as a discrepancy, which is the channel operators scan", async () => {
    const f = await scaffold();
    try {
      const { harvest } = await harvestTask(f.run, HOLDING);
      const found = harvest.discrepancies.filter((d) => d.includes("artifact.json"));
      expect(found.length).toBe(1);
      // Names and sizes, and an explicit disclaimer — never an interpretation.
      expect(found[0]).toContain(`artifact.json (${REVIEW_BYTES} bytes)`);
      expect(found[0]).toContain("nothing was opened");
    } finally {
      await f.cleanup();
    }
  });
});

/**
 * "NO RECORD" AND "A RECORD I COULD NOT READ" ARE DIFFERENT FACTS.
 *
 * One catch used to report both as the first, so a present-but-malformed
 * dispatch record was described as absent. That sentence has a measured cost:
 * a probe of the production harvest on this repository's own review console got
 * back "no dispatch record" for a task whose record was on disk, and it sent
 * the reader hunting a dispatch that never happened instead of the malformed
 * path they had actually built.
 */
describe("an unreadable dispatch record is not an absent one", () => {
  test("a malformed inbox record says it could not be READ", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-inbox-unreadable-"));
    const run = runPaths(RUN_ID, join(root, "runs"));
    await mkdir(run.inboxDir, { recursive: true });
    // Valid JSON prefix, cut mid-token: what a lost disk actually leaves.
    await writeFile(join(run.inboxDir, "T-torn.json"), '{"schema":"pifleet.task/v1","task_i');

    const { harvest } = await harvestTask(run, "T-torn");
    const reasons = harvest.reasons.join(" ");
    expect(reasons).toContain("could not be read");
    // The claim the data does not support, and the one it used to make.
    expect(reasons).not.toContain("no dispatch record");
    await rm(root, { recursive: true, force: true });
  });

  test("a genuinely ABSENT record still says no dispatch record", async () => {
    // The control. Distinguishing the two must not rename the case that was
    // already correct, which is also the only case the old sentence fitted.
    const root = await mkdtemp(join(tmpdir(), "pifleet-inbox-absent-"));
    const run = runPaths(RUN_ID, join(root, "runs"));
    await mkdir(run.inboxDir, { recursive: true });

    const { harvest } = await harvestTask(run, "T-nothing");
    expect(harvest.reasons.join(" ")).toContain("no dispatch record");
    await rm(root, { recursive: true, force: true });
  });
});
