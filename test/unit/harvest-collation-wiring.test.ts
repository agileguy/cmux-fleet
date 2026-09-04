/**
 * `harvestTask` actually RUNS §6.8's instrument — SRD-REVIEW-CONSOLE D8.
 *
 * ## Why this file exists when `collation-census.test.ts` is green
 *
 * `harvest/index.ts` carries the lesson in its own words: the rich adjudicator
 * and every criterion it implements *"had a full passing test suite and ZERO
 * production callers"*, so those criteria were satisfied only inside tests of a
 * module nothing ran, and *"a tested mechanism with no live call site is
 * indistinguishable at runtime from one that was never written"*. §6.8's
 * instrument is split across three modules and could acquire that defect in any
 * of them, so nothing here imports the census or the collation contract: these
 * probes drive `harvestTask`, the function `pifleet artifacts` calls, and assert
 * on the `Harvest` it emits.
 *
 * ## The three wires, and each is separately deletable
 *
 * The instrument is deliberately not one function, so "is it wired" is three
 * questions rather than one:
 *
 *  1. **The census reaches the fact bundle and the record.** `reconcile.ts`
 *     reads the artifact through the descriptor the scan holds; `harvestTask`
 *     puts the result in `facts.collation` and publishes it at
 *     `harvest.collation`. Deleting either leaves the census suite green.
 *  2. **`censusCeiling` runs inside `adjudicate`.** §6.8's location rule.
 *  3. **`collationCeiling` runs inside `harvestTask`.** §6.8's third rule and
 *     its `missing`/`refused` siblings, which need the parsed document and the
 *     task id and so cannot live in the pure adjudicator.
 *
 * ## THE CONTROL COMES FIRST, and the guard's negative case is a control too
 *
 * A fixture whose outbox the scan refuses holds no descriptors and passes any
 * "no unexpected finding" assertion for the one reason that proves nothing. And
 * the `missing` arm is powerful enough that its NEGATIVE case has to be pinned
 * explicitly: every task in this fleet is missing a collation artifact, so a
 * guard that stopped working would cap every `success` in the fleet — and a
 * suite that only tested collation tasks would not notice.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestTask } from "../../src/harvest/index.ts";
import { runPaths, workerOutboxDir, type RunPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-collation";
const WORKER = "col-1";
/** `isCollationTaskId` matches the trailing `-collate` segment (§6.6). */
const COLLATE_TASK = "T-1-collate";
/** The fan-out half of the same review. It legitimately writes no collation. */
const FANOUT_TASK = "T-1";

const LENSES = [
  { aspect: "arch", worker: "rev-arch-1", reported: true },
  { aspect: "context", worker: "rev-ctx-1", reported: true },
  { aspect: "lang", worker: "rev-lang-1", reported: true },
];

interface FindingInput {
  statement?: string;
  file: string;
  line: number;
  raised_by: string[];
}

function collationDoc(taskId: string, findings: FindingInput[], over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "pifleet.collation/v1",
    task_id: taskId,
    parent_task_id: taskId.replace(/-collate$/, ""),
    lenses: LENSES,
    finding_count: findings.length,
    findings: findings.map((f) => ({ statement: f.statement ?? "a finding", ...f })),
    ...over,
  });
}

interface Fixture {
  run: RunPaths;
  cleanup: () => Promise<void>;
}

/**
 * A run directory with one dispatched task and an outbox.
 *
 * `host_workdir: "unset"` is load-bearing rather than lazy, and it is also what
 * a `shared-ro` collator really produces: no worktree, so `harvestTask` skips
 * `deriveGitFacts` entirely and the bundle carries `repository: false`. That is
 * the state D9's ISC-93 gate made gradable, and it is why the verdict below
 * rests on the claim — which is the weakness §6.8 is a partial answer to.
 */
async function scaffold(opts: {
  taskId: string;
  status: string | null;
  /** Files under `files/`. Omit `collation.json` to exercise the missing arm. */
  onDisk: Record<string, string>;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-collation-wiring-"));
  const run = runPaths(RUN_ID, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(
    join(run.inboxDir, `${opts.taskId}.json`),
    JSON.stringify({
      acceptance: [],
      schema: "pifleet.task/v1",
      task_id: opts.taskId,
      run_id: RUN_ID,
      epoch: 1,
      attempt: 1,
      worker: WORKER,
      dispatched_at: new Date().toISOString(),
      title: opts.taskId,
      brief: "collation wiring fixture",
      repo: root,
      host_workdir: "unset",
      container_workdir: "/workspace",
      branch: `fleet/${RUN_ID}/${WORKER}`,
      base_ref: "0".repeat(40),
      outbox: `/outbox/${opts.taskId}`,
      deadline_s: 1500,
    }),
  );

  const taskOutbox = join(workerOutboxDir(run.root, WORKER), opts.taskId);
  const files = join(taskOutbox, "files");
  await mkdir(files, { recursive: true });
  for (const [name, body] of Object.entries(opts.onDisk)) {
    await writeFile(join(files, name), body);
  }
  if (opts.status !== null) {
    await writeFile(
      join(taskOutbox, "result.json"),
      JSON.stringify({
        schema: "pifleet.result/v1",
        task_id: opts.taskId,
        epoch: 1,
        worker: WORKER,
        status: opts.status,
        summary: "collated three reviews",
      }),
    );
  }
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("harvestTask publishes the structural census (§6.8's record)", () => {
  test(
    "the fixture really does produce a parsed envelope and an accepted artifact",
    async () => {
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: {
          "collation.json": collationDoc(COLLATE_TASK, [
            { file: "/workspace/src/a.ts", line: 42, raised_by: ["rev-arch-1", "rev-ctx-1"] },
          ]),
        },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        // A refused envelope or a refused outbox entry would make every
        // assertion below vacuous.
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
        expect(harvest.derived.artifacts.length).toBe(1);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "the counts and the consensus bands reach harvest.collation",
    async () => {
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: {
          "collation.json": collationDoc(COLLATE_TASK, [
            {
              file: "/workspace/src/a.ts",
              line: 42,
              raised_by: ["rev-arch-1", "rev-ctx-1", "rev-lang-1"],
            },
            { file: "/workspace/src/b.ts", line: 7, raised_by: ["rev-ctx-1"] },
          ]),
        },
      });
      try {
        const { harvest, facts } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("success");
        expect(harvest.collation).not.toBeNull();
        expect(harvest.collation?.counted).toBe(2);
        expect(harvest.collation?.located).toBe(2);
        expect(harvest.collation?.lenses_total).toBe(3);
        // §6.8: `3/3` and `1/3` visible in the record.
        expect(harvest.collation?.agreement).toEqual([
          { reviewers: 1, findings: 1 },
          { reviewers: 3, findings: 1 },
        ]);
        // D8's anti-criterion, end to end: no acceptance anywhere near it.
        expect(facts.acceptance).toEqual([]);
        expect(harvest.derived.acceptance).toEqual([]);
        // The published copy and the graded copy are the same measurement.
        expect(harvest.collation).toEqual(facts.collation);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "a task with no collation artifact publishes no census",
    async () => {
      const f = await scaffold({
        taskId: "t-ordinary",
        status: "success",
        onDisk: { "note.md": "an ordinary artifact\n" },
      });
      try {
        const { harvest } = await harvestTask(f.run, "t-ordinary");
        expect(harvest.collation).toBeNull();
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );
});

describe("harvestTask applies §6.8's rules (the three wires)", () => {
  test(
    "WIRE 2: a finding with no resolvable file:line caps a claimed success",
    async () => {
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: {
          "collation.json": collationDoc(COLLATE_TASK, [
            { file: "/workspace/src/a.ts", line: 1, raised_by: ["rev-arch-1"] },
            { file: "/etc/passwd", line: 2, raised_by: ["rev-ctx-1"] },
          ]),
        },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("partial");
        expect(harvest.reasons.join(" ")).toContain("no resolvable file:line");
        // The counts survive the cap: a degraded finding is not a discarded one.
        expect(harvest.collation?.counted).toBe(2);
        expect(harvest.collation?.located).toBe(1);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "WIRE 3: zero findings claimed success is recorded partial",
    async () => {
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: { "collation.json": collationDoc(COLLATE_TASK, []) },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("partial");
        expect(harvest.reasons.join(" ")).toContain("zero findings");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "WIRE 3: a collation task claiming success with NO artifact is partial",
    async () => {
      // "Write no artifact" must not be the way out of the instrument.
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: { "review.md": "three reviewers agreed on everything\n" },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("partial");
        expect(harvest.reasons.join(" ")).toContain("collation.json");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * THE GUARD'S NEGATIVE CASE, and it is the most important test in the file.
   *
   * Every task in this fleet is missing a collation artifact. §6.6's fan-out
   * task `T` is missing one legitimately — its whole job is to issue the request
   * and it settles the moment it has. If `isCollationTaskId` ever stopped
   * guarding the `missing` arm, every `success` in the fleet would be capped at
   * `partial` and the previous test would still pass.
   */
  test(
    "the FAN-OUT half of the same review is not capped for having no collation",
    async () => {
      const f = await scaffold({
        taskId: FANOUT_TASK,
        status: "success",
        onDisk: {},
      });
      try {
        const { harvest } = await harvestTask(f.run, FANOUT_TASK);
        expect(harvest.verdict).toBe("success");
        expect(harvest.reasons.join(" ")).not.toContain("collation.json");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "an ordinary build task claiming success is not capped either",
    async () => {
      const f = await scaffold({
        taskId: "t-ordinary",
        status: "success",
        onDisk: { "note.md": "ordinary\n" },
      });
      try {
        const { harvest } = await harvestTask(f.run, "t-ordinary");
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "an unreadable collation is recorded as unreadable and caps a claimed success",
    async () => {
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "success",
        onDisk: { "collation.json": "{ this is not json" },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("partial");
        // "nobody wrote one" and "somebody wrote something unreadable" stay
        // distinguishable in the record, not only in the reason.
        expect(harvest.collation?.readable).toBe(false);
        expect(harvest.collation?.refusal).toBe("not_json");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "a collation task that claims partial is not lifted, and not double-capped",
    async () => {
      // A ceiling can only ever lower. Both rules decline on a non-success
      // claim, so the worker's own downgrade is what stands.
      const f = await scaffold({
        taskId: COLLATE_TASK,
        status: "partial",
        onDisk: { "collation.json": collationDoc(COLLATE_TASK, []) },
      });
      try {
        const { harvest } = await harvestTask(f.run, COLLATE_TASK);
        expect(harvest.verdict).toBe("partial");
        expect(harvest.reasons.join(" ")).not.toContain("zero findings");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );
});
