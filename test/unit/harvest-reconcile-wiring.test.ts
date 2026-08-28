/**
 * `harvestTask` actually RUNS the artifact reconciler (SRD §8.4).
 *
 * ## Why this file exists at all, when `harvest-reconcile.test.ts` is green
 *
 * ISC-246 is graded `[~]` for one reason, and it is not that the code is
 * wrong: the outbox scan's accepted list "STILL HAS NO PRODUCTION CONSUMER",
 * so every test over it is a test of a module nothing calls. The same trap is
 * waiting one level up. A reconciler with a full unit suite and no live call
 * site would be indistinguishable at runtime from one that was never written,
 * and the green suite is exactly what would make it look done — the note
 * `harvest/index.ts` already carries about the adjudicator, which had "a full
 * passing test suite and ZERO production callers" while the CLI reached a
 * different code path entirely.
 *
 * So these probes never import the reconciler. They drive `harvestTask`, the
 * function `pifleet artifacts` calls, and assert on the `discrepancies` array
 * of the `Harvest` it emits. Deleting the call in `harvest/index.ts` leaves
 * `harvest-reconcile.test.ts` entirely green and turns this file red, which is
 * the split that makes the wiring checkable rather than assumed.
 *
 * ## The control comes first
 *
 * A fixture whose outbox the scan refuses holds no descriptors, produces no
 * artifacts to reconcile, and passes any "no unexpected discrepancy" assertion
 * for the one reason that proves nothing. The first test measures the fixture
 * itself, exactly as `harvest-fd-lifetime.test.ts` does and for the same
 * reason.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestTask } from "../../src/harvest/index.ts";
import { runPaths, workerOutboxDir, type RunPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-reconcile";
const WORKER = "w1";
const TASK = "t1";

interface Fixture {
  run: RunPaths;
  /** Where accepted artifacts live on the host, for asserting on paths. */
  files: string;
  cleanup: () => Promise<void>;
}

/**
 * A run directory with one dispatched task, an outbox, and an envelope.
 *
 * `host_workdir: "unset"` is load-bearing rather than lazy, for the reason
 * `harvest-fd-lifetime.test.ts` records: `harvestTask` skips `deriveGitFacts`
 * entirely without a worktree, so the probe reaches the outbox path without
 * standing up a git repository it would never look at. It also narrows the
 * mount table to `/outbox` alone, which is the shape the claims below assume.
 */
async function scaffold(opts: {
  onDisk: Record<string, string>;
  claimed: Array<{ kind: string; path: string }> | null;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-reconcile-wiring-"));
  const run = runPaths(RUN_ID, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(
    join(run.inboxDir, `${TASK}.json`),
    JSON.stringify({
      acceptance: [],
      schema: "pifleet.task/v1",
      task_id: TASK,
      run_id: RUN_ID,
      epoch: 1,
      attempt: 1,
      worker: WORKER,
      dispatched_at: new Date().toISOString(),
      title: TASK,
      brief: "artifact reconciliation fixture",
      repo: root,
      host_workdir: "unset",
      container_workdir: "/workspace",
      branch: `fleet/${RUN_ID}/${WORKER}`,
      base_ref: "0000000000000000000000000000000000000000",
      outbox: `/outbox/${TASK}`,
      deadline_s: 1500,
    }),
  );

  const taskOutbox = join(workerOutboxDir(run.root, WORKER), TASK);
  const files = join(taskOutbox, "files");
  await mkdir(files, { recursive: true });
  for (const [name, body] of Object.entries(opts.onDisk)) {
    await writeFile(join(files, name), body);
  }
  if (opts.claimed !== null) {
    await writeFile(
      join(taskOutbox, "result.json"),
      JSON.stringify({
        schema: "pifleet.result/v1",
        task_id: TASK,
        epoch: 1,
        worker: WORKER,
        status: "success",
        artifacts: opts.claimed,
      }),
    );
  }
  return { run, files, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Artifact findings only — git and adjudication push their own lines here. */
function artifactFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("artifact"));
}

describe("harvestTask reconciles the envelope's artifact claims (ISC-246's consumer)", () => {
  test(
    "the fixture really does produce an accepted artifact and a parsed envelope",
    async () => {
      const f = await scaffold({
        onDisk: { "note.md": "real artifact\n" },
        claimed: [{ kind: "file", path: `/outbox/${TASK}/files/note.md` }],
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        // A refused envelope would make every claim assertion below vacuous.
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        // A refused outbox entry would mean nothing was ever held open.
        expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
        expect(artifactFindings(harvest.discrepancies)).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "a claimed artifact that is not in the outbox reaches the harvest report",
    async () => {
      const f = await scaffold({
        onDisk: { "note.md": "real artifact\n" },
        claimed: [
          { kind: "file", path: `/outbox/${TASK}/files/note.md` },
          { kind: "file", path: `/outbox/${TASK}/files/imaginary.md` },
        ],
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        const found = artifactFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("imaginary.md");
        expect(found[0]).toContain("did not accept");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "an artifact the envelope never claims reaches the harvest report",
    async () => {
      const f = await scaffold({
        onDisk: { "declared.md": "declared\n", "smuggled.md": "undeclared\n" },
        claimed: [{ kind: "file", path: `/outbox/${TASK}/files/declared.md` }],
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        const found = artifactFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("smuggled.md");
        expect(found[0]).toContain("does not claim");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * The §12.5 primitive, at the production entry point.
   *
   * A worker naming a host file outside every mount must be reported and never
   * dereferenced. Asserted through the harvest's own `discrepancies` rather
   * than through the reconciler's return, because the point is that the CLI's
   * caller is the one refusing it.
   */
  test(
    "a claim outside the mount table is reported by harvestTask and not read",
    async () => {
      const secret = "ANTHROPIC_API_KEY=sk-do-not-read-me\n";
      const f = await scaffold({
        onDisk: { "note.md": "real artifact\n" },
        claimed: [{ kind: "file", path: `/outbox/${TASK}/files/note.md` }],
      });
      try {
        const planted = join(f.run.root, "planted.env");
        await writeFile(planted, secret);
        // Rewrite the envelope to name the planted file by its host path — the
        // exact shape §12.5 calls an exfiltration primitive.
        await writeFile(
          join(workerOutboxDir(f.run.root, WORKER), TASK, "result.json"),
          JSON.stringify({
            schema: "pifleet.result/v1",
            task_id: TASK,
            epoch: 1,
            worker: WORKER,
            status: "success",
            artifacts: [{ kind: "file", path: planted }],
          }),
        );

        const { harvest } = await harvestTask(f.run, TASK);
        const everything = JSON.stringify(harvest);
        expect(everything).not.toContain("sk-do-not-read-me");

        /*
         * `readResultEnvelope` refuses the whole envelope for an out-of-table
         * artifact path, so in production this claim never reaches the
         * reconciler at all — the refusal is the outer of two independent
         * defences. Asserting the refusal here, and the reconciler's own
         * containment in `harvest-reconcile.test.ts`, is what keeps both
         * checkable: either alone would let the other be deleted silently.
         */
        expect(harvest.claimed).toBeNull();
        expect(harvest.discrepancies.join("\n")).toContain("outside the mount table");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * No envelope is not an envelope claiming nothing (ISC-94).
   *
   * A worker that died before writing `result.json` leaves artifacts on disk
   * that nothing claimed. Reporting each of them would restate the missing
   * envelope once per file, and the harvest already records that absence
   * exactly once.
   */
  test(
    "a missing envelope leaves the outbox's artifacts unreported, not flooded",
    async () => {
      const f = await scaffold({
        onDisk: { "a.md": "one\n", "b.md": "two\n", "c.md": "three\n" },
        claimed: null,
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        expect(harvest.claimed).toBeNull();
        expect(artifactFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.reasons.join("\n")).toContain("no result envelope");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(1),
  );
});
