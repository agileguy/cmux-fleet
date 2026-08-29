/**
 * The harvest SAYS SO when a worker did not honour the outbox contract
 * (ISC-346, ISC-347, ISC-348).
 *
 * ## The measured failure these probes are built from
 *
 * A live ticketing worker completed a task and its output was accepted with no
 * complaint, having broken the contract in three ways at once:
 *
 *   1. it wrote its artifact to `outbox/<worker>/list-tickets-2026-08-29/` — a
 *      directory named after its own idea of the job, not after the dispatched
 *      task id;
 *   2. it wrote no `result.json` anywhere, so there was no envelope at all;
 *   3. it wrote `files/ticket-ops.md` and not `files/ticket-ops.json`, even
 *      though `skills/ticket-ops/SKILL.md` instructs it to write both.
 *
 * The third is the one with teeth. `reconcile.ts` keys BOTH the ticket-ops
 * schema validation AND the credential-leak sweep on the exact filename
 * `ticket-ops.json`, so a worker that writes only the `.md` bypasses both —
 * silently. The document is never validated, and it is never swept for the
 * credential the worker was holding while it talked to the ticket system.
 * Everything downstream reads as clean because nothing ran.
 *
 * That is this repo's recurring shape, and it has now been found four times:
 * a mechanism that is present, tested and invoked, running over an empty
 * input, publishing a clean result (ISC-231 at the mount path, ISC-333 at the
 * needle supplier, ISC-343 and ISC-345 at the value readers). The cure is
 * always the same one — say out loud that nothing was checked, and why.
 *
 * ## THE PROBES NEVER IMPORT THE MECHANISM
 *
 * No `unexplainedOutboxDirs`, no `dispatchedTaskIds`, no
 * `reconcileArtifactClaims`. Every probe drives `harvestTask` — the function
 * `pifleet artifacts` and `pifleet report` call — and asserts on the `Harvest`
 * it emits. Deleting a detector therefore turns this file red rather than
 * leaving a green unit suite over a module nothing runs, which is the split
 * `harvest-credential-sweep-wiring.test.ts` established and the only split
 * that makes wiring checkable rather than assumed.
 *
 * ## THE CONTROL COMES FIRST, and it is doing real work here
 *
 * Two of the three criteria assert an ABSENCE on the clean path — "a normal
 * multi-task run produces no layout findings" — and an absence passes for free
 * against a fixture that harvests nothing. Worse for ISC-348, which asserts a
 * degraded verdict: a fixture that cannot reach `success` satisfies every "not
 * success" assertion for a reason unrelated to the mechanism. So the first
 * describe block measures the fixture — two tasks, both directories correct,
 * both artifacts accepted, both harvesting `success` — and every later
 * assertion is a MOVEMENT away from that, not a coincidence.
 *
 * ## What is built by a production writer, and what is not
 *
 * The run directory's own structure is built from `run/paths.ts` — `runPaths`,
 * `workerOutboxDir`, `workerPaths`, `inboxTaskPath`, `workerVerbgateLedger` —
 * and every dispatch record goes through `TaskEnvelopeSchema` and
 * `writeJsonAtomic`, which is the pair `cli/commands/dispatch.ts` uses to
 * write the durable record. So the layout the reader compares against is the
 * layout production spells, and the ledger exemption below is proved against
 * `workerVerbgateLedger`'s own answer rather than against the string
 * `"ledger"` typed twice.
 *
 * THE ONE THING WITH NO PRODUCTION WRITER IS THE OUTBOX'S CONTENTS, and that
 * is stated rather than papered over: `<outbox>/<task>/result.json` and
 * `<outbox>/<task>/files/*` are written by the WORKER, inside the container,
 * by a model following `skills/pifleet-worker/SKILL.md`. Nothing in `src/`
 * writes them and there is no writer to source them from. They are therefore
 * hand-built here, from the shapes those two skill files document — which is
 * exactly what the defect was: a worker writing something else.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskEnvelopeSchema } from "../../src/contracts.ts";
import { harvestTask } from "../../src/harvest/index.ts";
import {
  inboxTaskPath,
  runPaths,
  workerOutboxDir,
  workerVerbgateLedger,
  type RunPaths,
} from "../../src/run/paths.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-contract";
const WORKER = "tick-1";

/** The two tasks the control run dispatches. Both are legitimate. */
const TASK_A = "my-iteration-2";
const TASK_B = "my-iteration-3";

/**
 * The directory the live worker actually created, reproduced verbatim.
 *
 * A date-stamped description of the job rather than the task id it was given.
 * Kept as the real string because the finding has to name it, and a probe that
 * used `"orphan"` would not show what an operator will actually read.
 */
const MISNAMED_DIR = "list-tickets-2026-08-29";

/** The names the SKILL tells a ticketing worker to write. Spelled, not imported. */
const TICKET_OPS_JSON = "ticket-ops.json";
const TICKET_OPS_MD = "ticket-ops.md";

/** The clamp `reconcile.ts` applies to a ticket-ops document it cannot check. */
const CEILING = "failed";

async function sh(argv: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${err}`);
  return out;
}

/** A ticket-ops document that passes `TicketOpsArtifactSchema` and the sweep. */
function ticketOpsJson(taskId: string): string {
  return JSON.stringify({
    schema: "pifleet.ticket-ops/v1",
    task_id: taskId,
    worker: WORKER,
    epoch: 1,
    operation: "query",
    ticket_host: "tickets.example.invalid",
    generated_at: "2026-08-29T10:00:00.000Z",
    no_change_needed: false,
    queried: [{ ticket: "T-9", fields: [{ field: "State", value: "Open" }] }],
    updates: [],
    commands: ["curl --config /tmp/ticket.curlrc https://tickets.example.invalid/T-9"],
    verdict: "success",
  });
}

/** The human half — the same content, once for a person. */
const TICKET_OPS_MARKDOWN = "# T-9\n\nState: Open. Nothing needed changing.\n";

/** Which files a task's `files/` directory holds, and what the envelope claims. */
interface TaskShape {
  /** Relative to `<outbox>/<task>/files/`. Directories are created as needed. */
  files: Record<string, string>;
  /** Omit the whole `result.json`, as the live worker did. */
  noEnvelope?: boolean;
}

interface Fixture {
  run: RunPaths;
  cleanup: () => Promise<void>;
}

/**
 * A run whose tasks would harvest `success`: a real base commit, a real change
 * on top of it, and an envelope whose `files_changed` agrees with the diff.
 *
 * A REAL GIT REPOSITORY, for the reason `harvest-ticket-ops-wiring.test.ts`
 * gives: without a worktree `base_is_ancestor` is false and `adjudicate`
 * returns `unknown` before it weighs anything, so a probe for "no longer
 * success" would pass against a harvester that detects nothing at all. The
 * clamp under test is a CEILING and `rank("unknown")` is -1, below every
 * gradeable verdict — a harvest that already refused to certify is left
 * exactly as it was, and a fixture that could not reach `success` would make
 * ISC-348's central assertion untestable while looking green.
 *
 * Both tasks share one worktree, which is legitimate and is what a real
 * multi-task worker does; `harvestAll`'s own comment says so.
 */
async function scaffold(opts: {
  tasks: Record<string, TaskShape>;
  /** Extra directories under `<outbox>/<worker>/`, with a file inside each. */
  extraOutboxDirs?: readonly string[];
  /** Loose files at the top of `<outbox>/<worker>/`, by name. */
  looseOutboxFiles?: Record<string, string>;
  /** Write the verbgate ledger at the path `run/paths.ts` names. */
  withVerbgateLedger?: boolean;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-outbox-contract-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await sh(["git", "init", "-q", "-b", "main"], repo);
  await sh(["git", "config", "user.email", "fixture@example.test"], repo);
  await sh(["git", "config", "user.name", "fixture"], repo);
  await writeFile(join(repo, "README.md"), "base\n");
  await sh(["git", "add", "-A"], repo);
  await sh(["git", "commit", "-qm", "base"], repo);
  const base = (await sh(["git", "rev-parse", "HEAD"], repo)).trim();
  await writeFile(join(repo, "note.txt"), "the worker's change\n");
  await sh(["git", "add", "-A"], repo);
  await sh(["git", "commit", "-qm", "work"], repo);

  const run = runPaths(RUN_ID, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });
  const outbox = workerOutboxDir(run.root, WORKER);
  await mkdir(outbox, { recursive: true });

  for (const [taskId, shape] of Object.entries(opts.tasks)) {
    /*
     * THE DISPATCH RECORD, through the production schema and the production
     * atomic write, at the production path. A hand-written JSON blob here
     * would encode today's envelope shape into the fixture, and the reader
     * would then be proved against the fixture rather than against what
     * `dispatch` writes.
     */
    await writeJsonAtomic(
      inboxTaskPath(run, taskId),
      TaskEnvelopeSchema.parse({
        schema: "pifleet.task/v1",
        task_id: taskId,
        run_id: RUN_ID,
        epoch: 1,
        attempt: 1,
        worker: WORKER,
        dispatched_at: "2026-08-29T09:00:00.000Z",
        title: taskId,
        brief: "outbox contract fixture",
        repo,
        host_workdir: repo,
        container_workdir: "/workspace",
        branch: "main",
        base_ref: base,
        acceptance: [],
        outbox: `/outbox/${taskId}`,
        deadline_s: 1500,
      }),
    );

    const taskOutbox = join(outbox, taskId);
    const filesDir = join(taskOutbox, "files");
    await mkdir(filesDir, { recursive: true });
    for (const [rel, body] of Object.entries(shape.files)) {
      const dest = join(filesDir, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, body);
    }
    if (shape.noEnvelope !== true) {
      await writeFile(
        join(taskOutbox, "result.json"),
        JSON.stringify({
          schema: "pifleet.result/v1",
          task_id: taskId,
          epoch: 1,
          worker: WORKER,
          status: "success",
          branch: "main",
          files_changed: [{ path: "note.txt", change: "added" }],
          // Everything on disk is claimed, so the reconciler's own
          // over/under-claim findings stay silent and any discrepancy a probe
          // sees is the one it is looking for.
          artifacts: Object.keys(shape.files).map((rel) => ({
            kind: "file",
            path: `/outbox/${taskId}/files/${rel}`,
          })),
        }),
      );
    }
  }

  for (const name of opts.extraOutboxDirs ?? []) {
    // With content, as the live worker's was: the point of the finding is that
    // whatever is in here was never scanned, so there has to be something in
    // here for that to be a statement about.
    const dir = join(outbox, name, "files");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, TICKET_OPS_MD), TICKET_OPS_MARKDOWN);
  }
  for (const [name, body] of Object.entries(opts.looseOutboxFiles ?? {})) {
    await writeFile(join(outbox, name), body);
  }
  if (opts.withVerbgateLedger === true) {
    /*
     * At the path `run/paths.ts` names, not at a hand-typed `outbox/ledger`.
     * The exemption in `harvest/layout.ts` derives the directory name from this
     * same function, so writing the fixture through it is what makes the two
     * agree with EACH OTHER rather than with a string this file chose.
     */
    const ledger = workerVerbgateLedger(run.root, WORKER);
    await mkdir(join(ledger, ".."), { recursive: true });
    await writeFile(ledger, '{"verb":"gcloud","decision":"allow"}\n');
  }

  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A clean two-task run: both directories named after their dispatched ids. */
function twoCleanTasks(): Record<string, TaskShape> {
  return {
    [TASK_A]: {
      files: { [TICKET_OPS_JSON]: ticketOpsJson(TASK_A), [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN },
    },
    [TASK_B]: {
      files: { [TICKET_OPS_JSON]: ticketOpsJson(TASK_B), [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN },
    },
  };
}

/** Findings about the worker's outbox layout. */
function layoutFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("not a dispatched task id"));
}

/** Findings about a missing result envelope. */
function envelopeFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("no result envelope at"));
}

/** Findings about a ticket-ops document with no machine-readable half. */
function unpairedFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes(`no ${TICKET_OPS_JSON} beside it`));
}

// ---------------------------------------------------------------------------

describe("the control: a correct two-task run reports nothing and grades success", () => {
  /**
   * THE FIXTURE MEASURES ITSELF FIRST.
   *
   * Everything below asserts a movement away from this state, and a movement
   * from a state that was never reached is not a movement. It also pins the
   * single most dangerous false positive in ISC-346 directly: one worker
   * serving two tasks has TWO directories in its outbox, and both are correct
   * while either is being harvested. A check scoped to the task under harvest
   * rather than to every dispatched id would report the sibling on every
   * multi-task run in the fleet — a finding that fires on the normal case,
   * which this repo has already established is worse than no finding.
   */
  test(
    "both tasks harvest success with no layout, envelope or pairing findings",
    async () => {
      const f = await scaffold({ tasks: twoCleanTasks() });
      try {
        for (const taskId of [TASK_A, TASK_B]) {
          const { harvest } = await harvestTask(f.run, taskId);
          expect(harvest.claimed, `${taskId}: the envelope must parse`).not.toBeNull();
          expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
          expect(layoutFindings(harvest.discrepancies), `${taskId}: layout`).toEqual([]);
          expect(layoutFindings(harvest.discrepancies).join(" ")).not.toContain(TASK_B);
          expect(envelopeFindings(harvest.discrepancies), `${taskId}: envelope`).toEqual([]);
          expect(unpairedFindings(harvest.discrepancies), `${taskId}: pairing`).toEqual([]);
          // The fixture GRADES, so "degrades to failed" below is real.
          expect(harvest.verdict, `${taskId}: verdict`).toBe("success");
        }
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * The verbgate ledger is the one non-task directory a worker legitimately
   * creates, and nothing on the host creates it: `docker/verbgate` runs its own
   * `mkdir -p` on the first gated verb. Every run in which a worker touched a
   * gated `gcloud` has one, so a check that reported it would fire on a large
   * fraction of real runs.
   *
   * Written through `workerVerbgateLedger`, so this asserts the exemption
   * against the path production spells rather than against a literal.
   */
  test(
    "the verbgate ledger directory is not reported as an unexplained directory",
    async () => {
      const f = await scaffold({ tasks: twoCleanTasks(), withVerbgateLedger: true });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(layoutFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * A worker may legitimately write extra files. The criterion is about
   * DIRECTORIES that look like task outboxes, and a loose file at the top of
   * the outbox is untidy rather than misrouted — nothing was harvested from a
   * place the harvester was not looking, because a file is not a place.
   *
   * This is also what settles symlinks by construction: `readdir` reports a
   * symlink as a symlink and never as a directory, so no link can be named —
   * let alone followed — out of the run tree.
   */
  test(
    "a loose file at the top of the worker's outbox is not a finding",
    async () => {
      const f = await scaffold({
        tasks: twoCleanTasks(),
        looseOutboxFiles: { "scratch.txt": "notes the worker left behind\n" },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(layoutFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});

describe("ISC-346: an outbox directory no dispatch explains is named", () => {
  /**
   * THE CRITERION, reproduced from the live failure. The worker wrote its
   * whole artifact into a directory named after the job rather than after the
   * task, so the harvester scanned an empty region and reported a clean
   * harvest of nothing.
   */
  test(
    "the misnamed directory is named, and the finding says nothing in it was checked",
    async () => {
      const f = await scaffold({
        tasks: {
          // The dispatched task, harvested as usual — and EMPTY, because the
          // worker's output went somewhere else. This is the live shape.
          [TASK_A]: { files: {} },
        },
        extraOutboxDirs: [MISNAMED_DIR],
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        const found = layoutFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(MISNAMED_DIR);
        expect(found[0]).toContain(WORKER);
        // The CONSEQUENCE, which is the part an operator needs: not "there is
        // a stray directory" but "nothing in it was examined".
        expect(found[0]).toContain("scanned, validated, or swept for credentials");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * IT DOES NOT CLAMP, and the assertion is deliberate rather than incidental.
   *
   * An unexplained directory belongs to no task — that is what makes it
   * unexplained — and one worker serves many tasks, so clamping would lower
   * the verdict of every task that worker ran, including the ones whose own
   * output was complete. The evidence names none of them.
   *
   * Measured against the clean control's verdict rather than against a
   * hand-written expectation, so the claim is "the stray directory changed
   * nothing about the grade" and not "the grade happens to be this string".
   */
  test(
    "it is a discrepancy only: the sibling task's verdict is untouched",
    async () => {
      const dirty = await scaffold({
        tasks: twoCleanTasks(),
        extraOutboxDirs: [MISNAMED_DIR],
      });
      const clean = await scaffold({ tasks: twoCleanTasks() });
      try {
        const a = await harvestTask(dirty.run, TASK_A);
        const b = await harvestTask(clean.run, TASK_A);
        expect(layoutFindings(a.harvest.discrepancies)).toHaveLength(1);
        expect(layoutFindings(b.harvest.discrepancies)).toEqual([]);
        expect(a.harvest.verdict).toBe(b.harvest.verdict);
        expect(a.harvest.verdict).toBe("success");
      } finally {
        await dirty.cleanup();
        await clean.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * THE LIMIT, ASSERTED RATHER THAN LEFT IMPLICIT.
   *
   * The misnamed directory holds a `ticket-ops.md`, and the pairing check in
   * `reconcile.ts` does NOT fire on it — because `scanOutboxFiles` walks only
   * `<outbox>/<task>/files/`, and this file is not in it. That is correct and
   * deliberate: harvesting whatever directory a worker chose would make the
   * region the WORKER picks, which is the §12.5 primitive the harvester exists
   * to refuse.
   *
   * So on the live shape, ISC-346 and ISC-347 fire and ISC-348 does not, and
   * ISC-346's wording carries the credential half instead. Pinning that here
   * means a future change that quietly widened the scan would have to face
   * this test rather than slip past it.
   */
  test(
    "a ticket-ops.md inside the unexplained directory is NOT separately validated",
    async () => {
      const f = await scaffold({
        tasks: { [TASK_A]: { files: {} } },
        extraOutboxDirs: [MISNAMED_DIR],
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(unpairedFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.derived.artifacts).toEqual([]);
        // And the one finding that DID fire says the credential sweep is what
        // was skipped, which is the fact the silence was hiding.
        expect(layoutFindings(harvest.discrepancies)[0]).toContain("swept for credentials");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});

describe("ISC-347: a dispatched task with no result envelope says so", () => {
  /**
   * THE CRITERION. The absence was already recorded in `reasons`, phrased as a
   * routine note — "verdict rests on derived facts alone" — which is where the
   * harvest explains HOW it graded, not what disagreed with the contract. An
   * operator scanning `discrepancies` saw nothing, so a worker that never
   * wrote its result read exactly like one that did.
   */
  test(
    "the missing envelope is a discrepancy naming the task and the contract path",
    async () => {
      const f = await scaffold({
        tasks: { [TASK_A]: { files: {}, noEnvelope: true } },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(harvest.claimed).toBeNull();
        const found = envelopeFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(TASK_A);
        // The CONTAINER spelling — the path the worker was actually given.
        expect(found[0]).toContain(`/outbox/${TASK_A}/result.json`);
        expect(found[0]).toContain("nothing it claims was checked");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * IT DOES NOT CLAMP, and ISC-94 is why.
   *
   * A missing envelope is explicitly not a failure: a worker can be killed
   * after committing real work, and the diff still speaks for it. Clamping
   * would turn every crash-after-commit into `failed` on evidence that says
   * nothing about the work.
   *
   * `unknown` rather than `failed` is the assertion that proves it. With no
   * claim the adjudicator has nothing to weigh against a non-empty diff, so
   * `unknown` is what the harvest reaches on its own — and `failed` is
   * precisely what a clamp would have produced. The control above shows the
   * same fixture reaching `success` when the envelope IS present, so this is a
   * movement caused by the missing claim rather than by the new finding.
   */
  test(
    "the verdict degrades to unknown, not to failed",
    async () => {
      const f = await scaffold({
        tasks: { [TASK_A]: { files: {}, noEnvelope: true } },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(envelopeFindings(harvest.discrepancies)).toHaveLength(1);
        expect(harvest.verdict).toBe("unknown");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * The other half of "it fires": it does not fire on everything. A task whose
   * worker DID write its envelope must produce no such finding, and the whole
   * clean run must be unchanged.
   */
  test(
    "a task with an envelope produces no missing-envelope finding",
    async () => {
      const f = await scaffold({ tasks: twoCleanTasks() });
      try {
        const { harvest } = await harvestTask(f.run, TASK_B);
        expect(envelopeFindings(harvest.discrepancies)).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});

describe("ISC-348: a ticket-ops.md with no ticket-ops.json says what did not run", () => {
  /**
   * THE CRITERION, AND THE ONE THAT MATTERS MOST.
   *
   * `reconcile.ts` keys both the schema validation and the credential sweep on
   * the exact name `ticket-ops.json`. A worker that writes only the `.md`
   * bypasses both, and nothing anywhere reports it: the document reads as a
   * perfectly good artifact, gets a real `sha256` in `derived.artifacts`, and
   * the harvest is clean because nothing examined it.
   *
   * The finding therefore has to convert "nothing was reported" into "nothing
   * was checked, and here is why" — in those words, because "no ticket-ops.json"
   * on its own is a filing complaint an operator can reasonably shrug at.
   */
  test(
    "the finding names the file and states that validation and the sweep did not run",
    async () => {
      const f = await scaffold({
        tasks: { [TASK_A]: { files: { [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN } } },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        const found = unpairedFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(TICKET_OPS_MD);
        expect(found[0]).toContain("DID NOT RUN");
        expect(found[0]).toContain("credential sweep");
        expect(found[0]).toContain("unchecked, not clean");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * IT CLAMPS, and the clamp is the half a discrepancy alone does not satisfy.
   *
   * Without it the task comes back `success` with "this document was never
   * checked" printed underneath — the surprise at read time relocated rather
   * than removed, which is the ISC-332 argument applied to a document that was
   * never written in a checkable form rather than one that was written badly.
   *
   * The REASON is asserted too, and separately. A ceiling that reused ISC-332's
   * sentence would tell an operator a document failed validation when no
   * document was parsed at all, sending them to look for a malformed file that
   * does not exist.
   */
  test(
    "the verdict is clamped to failed and the reason says what was skipped",
    async () => {
      const dirty = await scaffold({
        tasks: { [TASK_A]: { files: { [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN } } },
      });
      const clean = await scaffold({ tasks: twoCleanTasks() });
      try {
        const a = await harvestTask(dirty.run, TASK_A);
        const b = await harvestTask(clean.run, TASK_A);
        expect(b.harvest.verdict, "the control must reach success").toBe("success");
        expect(a.harvest.verdict).toBe(CEILING);
        const why = a.harvest.reasons.join("\n");
        expect(why).toContain(`no ${TICKET_OPS_JSON}`);
        expect(why).toContain("neither the schema validation nor the credential sweep ran");
        // And it does NOT claim a validation failure that never happened.
        expect(why).not.toContain("failed validation");
      } finally {
        await dirty.cleanup();
        await clean.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * PAIRING IS PER-DIRECTORY. The scan walks `files/` recursively, so both
   * halves may legitimately live in a subdirectory — and a `.json` two
   * directories away is a different document about different work. Accepting
   * it as the pair would let one validated file vouch for any number of
   * unvalidated documents elsewhere in the tree.
   *
   * Both directions in one probe, because either alone is passable by a wrong
   * implementation: a check that ignored directories entirely passes the first
   * half, and a check that demanded both at the top level passes the second.
   */
  test(
    "a ticket-ops.json in another directory does not vouch for the document",
    async () => {
      const split = await scaffold({
        tasks: {
          [TASK_A]: {
            files: {
              [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN,
              [`sub/${TICKET_OPS_JSON}`]: ticketOpsJson(TASK_A),
            },
          },
        },
      });
      const together = await scaffold({
        tasks: {
          [TASK_A]: {
            files: {
              [`sub/${TICKET_OPS_MD}`]: TICKET_OPS_MARKDOWN,
              [`sub/${TICKET_OPS_JSON}`]: ticketOpsJson(TASK_A),
            },
          },
        },
      });
      try {
        const a = await harvestTask(split.run, TASK_A);
        expect(unpairedFindings(a.harvest.discrepancies)).toHaveLength(1);
        expect(a.harvest.verdict).toBe(CEILING);

        const b = await harvestTask(together.run, TASK_A);
        expect(unpairedFindings(b.harvest.discrepancies)).toEqual([]);
        expect(b.harvest.verdict).toBe("success");
      } finally {
        await split.cleanup();
        await together.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * The other half of "it does not fire on everything", and the one that would
   * make this criterion a liability if it were wrong.
   *
   * A worker may legitimately write any number of markdown artifacts — an
   * investigation write-up, a log excerpt, a diagram — and
   * `skills/pifleet-worker/SKILL.md` explicitly invites it to. Only the ONE
   * name the ticket-ops skill defines opts a document into this check.
   */
  test(
    "other markdown artifacts, including near-misses, produce no finding",
    async () => {
      const f = await scaffold({
        tasks: {
          [TASK_A]: {
            files: {
              "report.md": "# findings\n",
              "ticket-ops-notes.md": "scratch\n",
              "notes/ticket-ops.txt": "not the document\n",
            },
          },
        },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(unpairedFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * A GAP THE EXISTING CLAMP COULD NEVER REACH, closed as a side effect and
   * worth pinning because nothing else in the suite covers it.
   *
   * The byte-cap clamp in `reconcile.ts` fires only for entries that reached
   * the digest loop, and a scan-REFUSED entry never does. So a worker whose
   * `ticket-ops.json` was refused escaped validation, the sweep AND the
   * ceiling: the refusal was a discrepancy, and the verdict stayed whatever
   * the diff said. With the `.md` beside it, the pairing check catches that
   * shape too, because a refused entry is not in the accepted set.
   *
   * A symlink OUT of the outbox is the refusal used, and it is the one this
   * probe had to be corrected to: an in-outbox symlink is deliberately
   * ACCEPTED by `scanOutboxFiles` — resolved, opened at the target, and
   * reported under the link's own name — so a `ticket-ops.json` symlinked to a
   * sibling is a real, validated pair and correctly produces no finding. The
   * first version of this test assumed otherwise and failed, which is the
   * scan's documented behaviour asserting itself.
   */
  test(
    "a ticket-ops.json the scan refused does not count as the pair",
    async () => {
      const f = await scaffold({
        tasks: { [TASK_A]: { files: { [TICKET_OPS_MD]: TICKET_OPS_MARKDOWN } } },
      });
      try {
        const files = join(workerOutboxDir(f.run.root, WORKER), TASK_A, "files");
        const outside = join(f.run.root, "..", "elsewhere.json");
        await Bun.write(outside, ticketOpsJson(TASK_A));
        const { symlink } = await import("node:fs/promises");
        await symlink(outside, join(files, TICKET_OPS_JSON));

        const { harvest } = await harvestTask(f.run, TASK_A);
        expect(harvest.reasons.join("\n"), "the symlink must be refused").toContain(
          "symlink escapes the outbox",
        );
        expect(unpairedFindings(harvest.discrepancies)).toHaveLength(1);
        expect(harvest.verdict).toBe(CEILING);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});
