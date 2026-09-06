/**
 * The ProjectManager run state file (SRD §7.6) — task 5.4.
 *
 * Every fixture here is a REAL file in a real temp directory: `writePmState`
 * writes bytes, `readPmState` reads them back, and the refusals are what the
 * reader does with bytes it does not like. Nothing about the filesystem is
 * mocked, because the property under test is a boundary and a mocked boundary
 * asserts itself.
 *
 * ## Every fixture is ASYMMETRIC, and that is not a slogan here
 *
 * This repository has shipped a filter that survived mutation because every
 * fixture made the two sets equal (`MEMORY`'s "degenerate fixtures hide
 * narrowing"). So each refusal below is paired with a TWIN that differs in
 * exactly the field under test and PARSES. A test that only shows the refusal
 * cannot distinguish "the rule fired" from "the document was broken anyway":
 *
 *  - the file-overlap twin shares a worker count, a task count and a phase
 *    number with the refused fixture, and differs only in whether `a.ts`
 *    appears in both partition entries;
 *  - the dispatch-owner twin has TWO distinct workers in the partition, so a
 *    schema that never compared owner to dispatcher would accept it — a
 *    single-worker fixture would make the comparison vacuous and pass with the
 *    check deleted;
 *  - the empty-partition twin is the SAME phase with the SAME empty partition,
 *    differing only in whether the document claims it complete;
 *  - the `resolvePhaseCompletion` pair is one cursor and two evidence objects,
 *    so an implementation that read the claim and ignored the evidence returns
 *    `complete` for both and the pair goes red on exactly one side.
 *
 * No subprocess is spawned anywhere in this file, so no `budget.ts` allowance
 * applies. `.git` is a real directory made with `mkdir` rather than a `git
 * init`: the reader's path check is an `lstat` for a `.git` entry, and
 * spawning git to produce one would test git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPathOutsideRepositoryError } from "../../src/run/pm-integration.ts";
import {
  PM_RUN_STATUS_CLAIMS,
  PM_REVIEW_VERDICT_KINDS,
  PM_STATE_SCHEMA,
  PmStateDocumentSchema,
  canonicalIntegrationRecordPath,
  intendedTaskIds,
  phaseCompletionClaim,
  pmStatePath,
  readPmState,
  resolvePhaseCompletion,
  toPmStateDocument,
  writePmState,
  type PhaseCompletionClaim,
  type PmStateCursor,
  type PmStateDocument,
} from "../../src/run/pm-state.ts";

// ---------------------------------------------------------------------------
// Compile-time half of the "may not say finished" asymmetry.
//
// These are not decoration: `bun run typecheck` covers `test/**/*.ts`, so
// re-adding `completed_phases` to the cursor or a `complete` arm to the claim
// union fails the build here as well as failing the runtime assertions below.
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;

/** The convenient misuse — `cursor.completed_phases` — must not be spellable. */
type CursorHidesCompletedPhases = Assert<"completed_phases" extends keyof PmStateCursor ? false : true>;
/** The renamed field must be present, or the value would simply be lost. */
type CursorExposesTheClaim = Assert<"phases_claimed_complete_unverified" extends keyof PmStateCursor ? true : false>;
/** The claim union may not carry an arm a caller could mistake for a finish. */
type ClaimHasNoCompleteArm = Assert<[Extract<PhaseCompletionClaim, { kind: "complete" }>] extends [never] ? true : false>;

// Referenced so the aliases are unmistakably live rather than dead code.
const typeLevelGuards: readonly [CursorHidesCompletedPhases, CursorExposesTheClaim, ClaimHasNoCompleteArm] = [
  true,
  true,
  true,
];

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-pmstate-"));
  repo = join(tmp, "operator");
  await mkdir(join(repo, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The base fixture: two phases, two workers, disjoint files.
// ---------------------------------------------------------------------------

/**
 * Phase 0 is claimed complete and fully partitioned across TWO workers with
 * DISJOINT files; phase 1 is the current phase with a single-worker partition.
 * Every negative fixture below is this document with one field changed.
 */
function baseDocument(): PmStateDocument {
  return PmStateDocumentSchema.parse({
    schema: PM_STATE_SCHEMA,
    srd_path: "Docs/SRD-FLEET-PROJECT-MANAGER.md",
    repo_path: repo,
    base_branch: "docs/srd-fleet-project-manager",
    baseline_commit: "ca13812",
    branch_model: "long-lived",
    branch: "feat/fleet-project-manager",
    total_phases: 2,
    current_phase: 1,
    completed_phases: [0],
    status: "in_progress",
    phases: [
      {
        n: 0,
        slug: "integration-path",
        name: "Fetch, hazard-gate and merge a worker's branch",
        partition: [
          { worker: "eng-1", task_ids: ["T-3-1", "T-3-2"], files: ["src/run/pm-integration.ts", "src/a.ts"] },
          { worker: "eng-2", task_ids: ["T-3-3"], files: ["src/b.ts"] },
        ],
        dispatched: [
          { worker: "eng-1", task_id: "T-3-1", run_id: "2026-09-04T03-04-12Z-ce9f" },
          { worker: "eng-1", task_id: "T-3-2", run_id: "2026-09-04T03-04-12Z-ce9f" },
          { worker: "eng-2", task_id: "T-3-3", run_id: "2026-09-04T03-04-12Z-5a52" },
        ],
        integration: { record: canonicalIntegrationRecordPath(0) },
        review: {
          parent_task_id: "T-3-review",
          collate_task_id: "T-3-review-collate",
          coverage: { reported: 3, dispatched: 3 },
          verdict: "APPROVED",
          iteration: 1,
        },
      },
      {
        n: 1,
        slug: "the-skill",
        name: "Workflows/ProjectManager.md and the corrected tables",
        partition: [{ worker: "eng-1", task_ids: ["T-5-4"], files: ["src/run/pm-state.ts"] }],
      },
    ],
    pr_policy: "Do NOT open a PR. Ask the owner when all phases are complete.",
  });
}

/** Write raw bytes straight to §7.6's path, bypassing `writePmState`'s validation. */
async function writeRaw(body: string): Promise<string> {
  const path = pmStatePath(repo);
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

async function readMessage(): Promise<string> {
  try {
    await readPmState(repo);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("readPmState resolved where the test expected it to refuse");
}

/** Everything a phase's partition intends, resolved from the parsed document. */
function phase0TaskIds(doc: PmStateDocument): string[] {
  return intendedTaskIds(doc.phases.find((p) => p.n === 0)!);
}

// ---------------------------------------------------------------------------
describe("the path, the round trip and the host-path refusal", () => {
  test("the file is §7.6's exact path", () => {
    expect(pmStatePath(repo)).toBe(join(repo, ".claude", "project-manager-state.json"));
  });

  test("a directory that is not a repository root is refused, for reading and for writing", async () => {
    const notARepo = join(tmp, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    expect(readPmState(notARepo)).rejects.toBeInstanceOf(HostPathOutsideRepositoryError);
    expect(writePmState(notARepo, baseDocument())).rejects.toBeInstanceOf(HostPathOutsideRepositoryError);
  });

  test("write then read then fold back is the same document, byte for byte", async () => {
    const doc = baseDocument();
    await writePmState(repo, doc);
    const onDisk = JSON.parse(await readFile(pmStatePath(repo), "utf8")) as unknown;
    expect(onDisk).toEqual(doc);

    const cursor = await readPmState(repo);
    expect(toPmStateDocument(cursor)).toEqual(doc);
  });

  test("typeLevelGuards is live", () => {
    expect(typeLevelGuards).toEqual([true, true, true]);
  });
});

// ---------------------------------------------------------------------------
describe("every refusal names the FILE, not just a field", () => {
  /*
   * The point of these three. A raw `ZodError` says `phases.0.partition:
   * Required` and names no file, so an operator resuming a run learns that A
   * state file is malformed without learning WHICH — and this repository keeps
   * three of them side by side in `.claude/`. `durable-reader-wrapping.test.ts`
   * enforces the wrapping structurally; these enforce the MESSAGE, which the
   * scan explicitly says it cannot check ("a `try` whose `catch` rethrows the
   * raw error passes").
   */

  test("a missing file names the path", async () => {
    const msg = await readMessage();
    expect(msg).toContain(pmStatePath(repo));
    expect(msg).toContain("could not read the ProjectManager state file");
  });

  test("invalid JSON names the path and says it is JSON that is wrong", async () => {
    const path = await writeRaw("{ not json ");
    const msg = await readMessage();
    expect(msg).toContain(path);
    expect(msg).toContain("is not valid JSON");
  });

  test("a schema violation names the path AND the offending field", async () => {
    const doc = baseDocument();
    const broken = { ...doc, total_phases: 99 };
    const path = await writeRaw(JSON.stringify(broken, null, 2));

    const msg = await readMessage();
    // The file — the half a bare `ZodError` cannot give.
    expect(msg).toContain(path);
    expect(msg).toContain("is malformed");
    // The field — the half a wrapper must not throw away.
    expect(msg).toContain("total_phases");
  });
});

// ---------------------------------------------------------------------------
describe("`partition` is structurally load-bearing (§7.6)", () => {
  test("the key is required — a phase without it is refused before anything reads it", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) => (p.n === 1 ? { n: p.n, slug: p.slug, name: p.name } : p));
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
    expect(await readMessage()).toContain("partition");
  });

  /*
   * ASYMMETRIC PAIR. Both documents carry phase 1 with `partition: []`. They
   * differ in ONE field — whether `completed_phases` names it — and that field
   * is the whole rule: an unreached phase legitimately has no partition
   * (§6.4 step 3 partitions at the START of a phase), a claimed one cannot.
   * A schema that made `partition` merely `.optional()` accepts both.
   */
  test("an UNREACHED phase may carry an empty partition", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) => (p.n === 1 ? { ...p, partition: [], dispatched: [] } : p));
    // phase 1 is `current_phase`, but current is not yet dispatched or claimed.
    await writePmState(repo, PmStateDocumentSchema.parse({ ...doc, phases }));
    const cursor = await readPmState(repo);
    expect(cursor.phases.find((p) => p.n === 1)!.partition).toEqual([]);
  });

  test("a CLAIMED-COMPLETE phase may not — same empty partition, one field different", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) => (p.n === 1 ? { ...p, partition: [], dispatched: [] } : p));
    await writeRaw(JSON.stringify({ ...doc, phases, completed_phases: [0, 1] }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("listed in completed_phases");
    expect(msg).toContain("empty partition");
  });

  test("a DISPATCHED phase may not either — same empty partition, one field different", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 1
        ? { ...p, partition: [], dispatched: [{ worker: "eng-1", task_id: "T-5-4", run_id: "r" }] }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
    expect(await readMessage()).toContain("empty partition");
  });

  test("an entry naming no task, or no file, is not a partition entry", async () => {
    const doc = baseDocument();

    const noTasks = doc.phases.map((p) =>
      p.n === 1 ? { ...p, partition: [{ worker: "eng-1", task_ids: [], files: ["src/x.ts"] }] } : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases: noTasks }, null, 2));
    expect(await readMessage()).toContain("must name at least one SRD task");

    const noFiles = doc.phases.map((p) =>
      p.n === 1 ? { ...p, partition: [{ worker: "eng-1", task_ids: ["T-5-4"], files: [] }] } : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases: noFiles }, null, 2));
    expect(await readMessage()).toContain("must name at least one file");
  });

  /*
   * ASYMMETRIC PAIR. `baseDocument()` already has two workers with DISJOINT
   * files, and it parses (proved by the round-trip test above). This fixture
   * is the same two workers, the same task ids, the same phase number — and
   * `src/a.ts` moved into eng-2's list as well. Only the overlap differs.
   */
  test("§6.3's rule as a refusal: a file may not have two owners in one round", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            partition: [
              { worker: "eng-1", task_ids: ["T-3-1", "T-3-2"], files: ["src/run/pm-integration.ts", "src/a.ts"] },
              { worker: "eng-2", task_ids: ["T-3-3"], files: ["src/b.ts", "src/a.ts"] },
            ],
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("a file has one owner per round");
  });

  /*
   * THE PAIR THAT MAKES ROUNDS REAL, and the reason the refusal above had to be
   * re-scoped. Both fixtures below are the SAME two entries naming the SAME
   * file `src/a.ts` under the SAME worker. One field differs: `round`.
   *
   * A degenerate version of this pair would prove nothing. If the second
   * fixture also changed the file names, it would parse whether the key were
   * round-scoped or not — the two sets would be disjoint either way and the
   * test would survive reverting the change. `src/a.ts` is deliberately held
   * constant so the ONLY thing separating a refusal from a parse is the round.
   */
  test("the same file in the same round is refused — one worker, twice", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            partition: [
              { worker: "eng-1", round: 1, task_ids: ["T-3-1"], files: ["src/a.ts"] },
              { worker: "eng-1", round: 1, task_ids: ["T-3-2"], files: ["src/a.ts"] },
              { worker: "eng-2", round: 1, task_ids: ["T-3-3"], files: ["src/b.ts"] },
            ],
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("in round 1 of phase 0");
  });

  test("the same file in a LATER round parses — round 2's clone already holds round 1", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            partition: [
              { worker: "eng-1", round: 1, task_ids: ["T-3-1"], files: ["src/a.ts"] },
              { worker: "eng-1", round: 2, task_ids: ["T-3-2"], files: ["src/a.ts"] },
              { worker: "eng-2", round: 1, task_ids: ["T-3-3"], files: ["src/b.ts"] },
            ],
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const cursor = await readPmState(repo);
    const rounds = cursor.phases.find((ph) => ph.n === 0)!.partition.map((e) => e.round);
    expect(rounds).toEqual([1, 2, 1]);
  });

  /*
   * Files are round-scoped; TASKS are not. A task in two rounds is the same
   * "two answers is no answer" problem the two-worker case has — it makes the
   * `dispatched` cross-check unable to say which round a dispatch belongs to.
   */
  test("a task may not be split across two rounds either", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            partition: [
              { worker: "eng-1", round: 1, task_ids: ["T-3-1"], files: ["src/a.ts"] },
              { worker: "eng-2", round: 2, task_ids: ["T-3-1"], files: ["src/b.ts"] },
              { worker: "eng-2", round: 1, task_ids: ["T-3-3"], files: ["src/c.ts"] },
            ],
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("T-3-1");
    expect(msg).toContain("two answers is no answer");
  });

  /*
   * Every state file written before rounds existed omits the key entirely.
   * `baseDocument()` is exactly such a document — none of its literals carry
   * `round` — so this asserts the default on the fixture the whole suite uses.
   */
  test("an entry written without a round is round 1", async () => {
    const doc = baseDocument();
    expect(doc.phases.flatMap((p) => p.partition).map((e) => e.round)).toEqual([1, 1, 1]);

    await writePmState(repo, doc);
    const cursor = await readPmState(repo);
    expect(cursor.phases.find((p) => p.n === 1)!.partition[0]!.round).toBe(1);
  });

  test("round 0, and a fractional round, are not rounds", async () => {
    const doc = baseDocument();
    for (const bad of [0, -1, 1.5]) {
      const phases = doc.phases.map((p) =>
        p.n === 1 ? { ...p, partition: [{ worker: "eng-1", round: bad, task_ids: ["T-5-4"], files: ["src/x.ts"] }] } : p,
      );
      await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
      expect(await readMessage()).toContain("round");
    }
  });

  test("a task may not be assigned to two workers either", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            partition: [
              { worker: "eng-1", task_ids: ["T-3-1", "T-3-2"], files: ["src/run/pm-integration.ts", "src/a.ts"] },
              { worker: "eng-2", task_ids: ["T-3-3", "T-3-1"], files: ["src/b.ts"] },
            ],
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
    // Asserted around the quoting rather than through it: the diagnosis reaches
    // the operator as a JSON-serialised ZodError, so the id is escaped inside it.
    const msg = await readMessage();
    expect(msg).toContain("T-3-1");
    expect(msg).toContain("is assigned to both");
    expect(msg).toContain("eng-2");
  });

  test("a dispatch the partition never assigned is refused", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? { ...p, dispatched: [...p.dispatched, { worker: "eng-1", task_id: "T-3-9", run_id: "r" }] }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("T-3-9");
    expect(msg).toContain("which no partition entry assigns");
  });

  /*
   * ASYMMETRIC. The base document's partition assigns `T-3-1` to eng-1 and
   * `T-3-3` to eng-2 — two DISTINCT owners. Swapping the dispatcher is
   * therefore detectable; a fixture in which one worker owned everything would
   * pass with this check deleted.
   */
  test("a dispatch to a worker the partition did not assign is refused", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0
        ? {
            ...p,
            dispatched: p.dispatched.map((d) => (d.task_id === "T-3-1" ? { ...d, worker: "eng-2" } : d)),
          }
        : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));

    const msg = await readMessage();
    expect(msg).toContain("T-3-1");
    expect(msg).toContain("but the partition assigns it to");
    // Both worker ids must appear, or the message would not say WHICH swap happened.
    expect(msg).toContain("eng-2");
    expect(msg).toContain("eng-1");
  });

  test("a partitioned file must live inside the repository", async () => {
    const doc = baseDocument();
    for (const [bad, expected] of [
      ["/etc/passwd", "must be repo-relative"],
      ["../other-repo/src/x.ts", "must not contain a '..' segment"],
    ] as const) {
      const phases = doc.phases.map((p) =>
        p.n === 1 ? { ...p, partition: [{ worker: "eng-1", task_ids: ["T-5-4"], files: [bad] }] } : p,
      );
      await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
      expect(await readMessage()).toContain(expected);
    }
    // The twin: the same shape with an ordinary repo-relative path parses.
    const ok = doc.phases.map((p) =>
      p.n === 1 ? { ...p, partition: [{ worker: "eng-1", task_ids: ["T-5-4"], files: ["src/ok.ts"] }] } : p,
    );
    await writePmState(repo, PmStateDocumentSchema.parse({ ...doc, phases: ok }));
    await expect(readPmState(repo)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe("the file may not say a phase was finished (§7.6)", () => {
  test("the cursor carries no `completed_phases` at runtime, only the renamed claim", async () => {
    await writePmState(repo, baseDocument());
    const cursor = await readPmState(repo);

    expect(Object.keys(cursor)).not.toContain("completed_phases");
    expect(cursor).not.toHaveProperty("completed_phases");
    expect(cursor.phases_claimed_complete_unverified).toEqual([0]);
  });

  test("`phaseCompletionClaim` has no arm that means finished", async () => {
    await writePmState(repo, baseDocument());
    const cursor = await readPmState(repo);

    const claimed = phaseCompletionClaim(cursor, 0);
    expect(claimed.kind).toBe("claimed_complete_unverified");
    // The claim carries its own falsification recipe (§6.6's table).
    expect(claimed.kind === "claimed_complete_unverified" && claimed.intended_task_ids).toEqual([
      "T-3-1",
      "T-3-2",
      "T-3-3",
    ]);
    expect(claimed.kind === "claimed_complete_unverified" && claimed.verify_with.join("\n")).toContain(
      "pifleet artifacts --task T-3-1",
    );

    // Exhaustive over the union: there is nothing else it can be.
    const kinds = new Set<string>();
    for (const n of [0, 1]) kinds.add(phaseCompletionClaim(cursor, n).kind);
    expect([...kinds].sort()).toEqual(["claimed_complete_unverified", "started_not_claimed_complete"]);
  });

  test("the one direction it IS authoritative in: a phase nobody started", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) => (p.n === 1 ? { ...p, dispatched: [] } : p));
    await writePmState(repo, PmStateDocumentSchema.parse({ ...doc, phases, current_phase: 0 }));
    const cursor = await readPmState(repo);

    expect(phaseCompletionClaim(cursor, 1)).toEqual({ kind: "never_started", phase: 1 });
  });

  test("an unknown phase throws rather than reporting `never_started`", async () => {
    await writePmState(repo, baseDocument());
    const cursor = await readPmState(repo);
    expect(() => phaseCompletionClaim(cursor, 7)).toThrow(RangeError);
    expect(() => phaseCompletionClaim(cursor, 7)).toThrow(/carries no phase 7/);
  });

  /*
   * THE ASYMMETRIC PAIR THAT MATTERS MOST. One cursor, two evidence objects.
   * The document CLAIMS phase 0 complete in both. An implementation that read
   * the claim and ignored the evidence returns `complete` twice and this pair
   * goes red on exactly one side — which is the mutation proof recorded in the
   * commit for this test.
   */
  test("a claim WITHOUT run-tree evidence resolves to `stale_file`, never to complete", async () => {
    const doc = baseDocument();
    await writePmState(repo, doc);
    const cursor = await readPmState(repo);
    const all = phase0TaskIds(doc);

    const partial = resolvePhaseCompletion(cursor, 0, {
      tasks_with_artifacts: ["T-3-1", "T-3-2"],
      task_ids_merged: ["T-3-1", "T-3-2"],
    });
    expect(partial.kind).toBe("stale_file");
    expect(partial.kind === "stale_file" && partial.missing_artifacts).toEqual(["T-3-3"]);
    expect(partial.kind === "stale_file" && partial.unmerged).toEqual(["T-3-3"]);

    const covered = resolvePhaseCompletion(cursor, 0, {
      tasks_with_artifacts: all,
      task_ids_merged: all,
    });
    expect(covered).toEqual({ kind: "complete", phase: 0 });
  });

  test("artifacts without a merge is still not complete — §6.6 asks both questions", async () => {
    const doc = baseDocument();
    await writePmState(repo, doc);
    const cursor = await readPmState(repo);
    const all = phase0TaskIds(doc);

    const notMerged = resolvePhaseCompletion(cursor, 0, {
      tasks_with_artifacts: all,
      task_ids_merged: ["T-3-1"],
    });
    expect(notMerged.kind).toBe("stale_file");
    expect(notMerged.kind === "stale_file" && notMerged.missing_artifacts).toEqual([]);
    expect(notMerged.kind === "stale_file" && notMerged.unmerged).toEqual(["T-3-2", "T-3-3"]);
  });

  test("the run tree wins in the OTHER direction too — evidence beats an absent claim", async () => {
    await writePmState(repo, baseDocument());
    const cursor = await readPmState(repo);

    // Phase 1 is NOT in completed_phases, and its one task has landed.
    expect(resolvePhaseCompletion(cursor, 1, { tasks_with_artifacts: ["T-5-4"], task_ids_merged: ["T-5-4"] })).toEqual({
      kind: "complete",
      phase: 1,
    });
    // The same phase with nothing landed is `incomplete`, not `stale_file`:
    // the file never claimed it, so nothing is stale.
    expect(
      resolvePhaseCompletion(cursor, 1, { tasks_with_artifacts: [], task_ids_merged: [] }).kind,
    ).toBe("incomplete");
  });

  test("no partition means no question to ask, and that is its own outcome", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) => (p.n === 1 ? { ...p, partition: [], dispatched: [] } : p));
    await writePmState(repo, PmStateDocumentSchema.parse({ ...doc, phases }));
    const cursor = await readPmState(repo);

    expect(resolvePhaseCompletion(cursor, 1, { tasks_with_artifacts: [], task_ids_merged: [] })).toEqual({
      kind: "no_partition",
      phase: 1,
    });
  });

  /*
   * ASYMMETRIC PAIR on the run-level status. `claimed_complete` parses and
   * `complete` does not — the same argument one level up: §6.6's "nothing the
   * orchestrator writes is evidence" is not weaker for a run than for a phase.
   */
  test("the run-level status enum has no `complete`", async () => {
    expect(PM_RUN_STATUS_CLAIMS).not.toContain("complete");
    expect(PM_RUN_STATUS_CLAIMS).toContain("claimed_complete");

    const doc = baseDocument();
    await writeRaw(JSON.stringify({ ...doc, status: "complete" }, null, 2));
    expect(await readMessage()).toContain("status");

    await writePmState(repo, PmStateDocumentSchema.parse({ ...doc, status: "claimed_complete" }));
    expect((await readPmState(repo)).status).toBe("claimed_complete");
  });
});

// ---------------------------------------------------------------------------
describe("what the state file may not carry (§6.6's table)", () => {
  test("the schema tag is checked by name", async () => {
    const doc = baseDocument();
    await writeRaw(JSON.stringify({ ...doc, schema: "pifleet.pmstate/v2" }, null, 2));
    expect(await readMessage()).toContain(PM_STATE_SCHEMA);
  });

  test("a phase may not carry commits, a merged flag, or artifacts", async () => {
    const doc = baseDocument();
    for (const [field, needle] of [
      ["commits", "may not carry a commit list"],
      ["merged", "may not record that it merged"],
      ["artifacts", "may not carry artifacts"],
    ] as const) {
      const phases = doc.phases.map((p) => (p.n === 0 ? { ...p, [field]: field === "merged" ? true : [] } : p));
      await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
      const msg = await readMessage();
      expect(msg).toContain(needle);
      // Not merely `.strict()`'s "unrecognized key" — the refusal explains why.
      expect(msg).toContain("§6.6");
    }
  });

  test("the integration block is a POINTER to §7.2's record, for THIS phase", async () => {
    const doc = baseDocument();

    // Right shape, wrong phase — the failure that resumes the wrong merge.
    const wrongPhase = doc.phases.map((p) =>
      p.n === 0 ? { ...p, integration: { record: canonicalIntegrationRecordPath(1) } } : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases: wrongPhase }, null, 2));
    expect(await readMessage()).toContain(canonicalIntegrationRecordPath(0));

    // An inline copy of §7.2's rows is refused by name.
    const inlined = doc.phases.map((p) =>
      p.n === 0 ? { ...p, integration: { record: canonicalIntegrationRecordPath(0), workers: [] } } : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases: inlined }, null, 2));
    expect(await readMessage()).toContain("may not inline");
  });

  test("the phase numbering and the completed list must agree with phases[]", async () => {
    const doc = baseDocument();

    await writeRaw(JSON.stringify({ ...doc, current_phase: 9 }, null, 2));
    expect(await readMessage()).toContain("current_phase 9 names no phase");

    await writeRaw(JSON.stringify({ ...doc, completed_phases: [0, 9] }, null, 2));
    expect(await readMessage()).toContain("names phase 9, which is not in phases[]");

    await writeRaw(JSON.stringify({ ...doc, completed_phases: [0, 0] }, null, 2));
    expect(await readMessage()).toContain("listed twice in completed_phases");
  });

  test("a review may not report more lenses than were dispatched", async () => {
    const doc = baseDocument();
    const phases = doc.phases.map((p) =>
      p.n === 0 ? { ...p, review: { ...p.review!, coverage: { reported: 4, dispatched: 3 } } } : p,
    );
    await writeRaw(JSON.stringify({ ...doc, phases }, null, 2));
    expect(await readMessage()).toContain("exceeds coverage.dispatched");
  });

  test("the verdict vocabulary is pm-verdict.ts's, not a second spelling", () => {
    // The compile-time pin lives in `pm-state.ts`; this is the runtime half.
    expect([...PM_REVIEW_VERDICT_KINDS].sort()).toEqual([
      "APPROVED",
      "APPROVED_WITH_DISSENT",
      "CHANGES_REQUESTED",
      "NO_COLLATION",
      "REVIEW_INCOMPLETE",
      "VOID",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("the live state file is evidence (§0.6 finding E)", () => {
  /*
   * `.claude/project-manager-state.json` is this very run's state, and §0.6 E
   * says §7.6 "specifies the shape that practice already reached". So the
   * schema must accommodate the twelve top-level fields the live file carries
   * that §7.6 does not list, and its 7-character `baseline_commit`. This test
   * asserts exactly that and nothing brittle: `.strict()` must raise NO
   * unrecognized-key issue against the real document.
   *
   * It deliberately does NOT assert which OTHER issues the live file raises,
   * because those are the migration §7.6 prescribes (the `schema` tag and a
   * per-phase `partition`) and asserting them would fail the day it migrates.
   */
  test(".strict() rejects none of the live file's keys", async () => {
    const live = new URL("../../.claude/project-manager-state.json", import.meta.url).pathname;
    const file = Bun.file(live);
    if (!(await file.exists())) return; // not present in every checkout shape

    const doc = JSON.parse(await file.text()) as Record<string, unknown>;
    const result = PmStateDocumentSchema.safeParse(doc);
    const unrecognized = result.success
      ? []
      : result.error.issues.filter((i) => i.code === "unrecognized_keys");
    expect(unrecognized).toEqual([]);

    // And the abbreviated commit practice actually writes is accepted.
    if (typeof doc.baseline_commit === "string") {
      const commitIssues = result.success
        ? []
        : result.error.issues.filter((i) => i.path[0] === "baseline_commit");
      expect(commitIssues).toEqual([]);
    }
  });
});
