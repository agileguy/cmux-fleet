/**
 * `harvestTask` actually VALIDATES a `ticket-ops.json` it finds (ISC-332).
 *
 * ## Why this file exists when `ticket-artifact.test.ts` is green
 *
 * ISC-332 was graded `[~]` for one reason, and it was not that the schema is
 * wrong: `parseTicketOpsArtifact` had NO caller in `src/` — its sole occurrence
 * was its own definition — so every test over it was a test of a module nothing
 * ran. The harvester MEASURED every outbox artifact (real `bytes`, real
 * `sha256`, published to `derived.artifacts`) and parsed none of them, so a
 * worker that wrote a document claiming `match: "exact"` beside two differing
 * values produced a green harvest and a `success` verdict, with the
 * malformation waiting for whoever opened the file later. That is the
 * "surprise at read time" the criterion names.
 *
 * So, following `harvest-reconcile-wiring.test.ts` exactly: **nothing here
 * imports the thing it is proving is wired.** No `parseTicketOpsArtifact`, no
 * `TicketOpsArtifactSchema`, no `reconcileArtifactClaims`. These probes drive
 * `harvestTask` — the function `pifleet artifacts` calls — and assert on the
 * `Harvest` it emits. Deleting the validation call leaves
 * `ticket-artifact.test.ts` and `harvest-reconcile.test.ts` entirely green and
 * turns this file red, which is the split that makes the wiring checkable
 * rather than assumed.
 *
 * ## Why this fixture builds a REAL git repository
 *
 * `harvest-reconcile-wiring.test.ts` gets to use `host_workdir: "unset"`
 * because it only asserts on `discrepancies`. This file has to assert on the
 * VERDICT, and without a worktree `base_is_ancestor` is false, so `adjudicate`
 * returns `unknown` before it weighs anything — a verdict that is already not
 * `success`, which would let a probe for "no longer `success`" pass against a
 * harvester that does no validation at all. The repository is what makes the
 * control reach a genuine `success`, and a control that cannot reach the value
 * under test proves nothing.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestTask } from "../../src/harvest/index.ts";
import { runPaths, workerOutboxDir, type RunPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-ticketops";
const WORKER = "tick-1";
const TASK = "T-004";
const BODY = "<p>Root cause: the probe targets 8080.</p>";

/** The one artifact name the harvester validates — spelled here, not imported. */
const TICKET_OPS = "ticket-ops.json";

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

/** A well-formed ticket-ops document, so each probe perturbs exactly one thing. */
function wellFormed(): Record<string, unknown> {
  return {
    schema: "pifleet.ticket-ops/v1",
    task_id: TASK,
    worker: WORKER,
    epoch: 1,
    operation: "update",
    ticket_host: "tickets.example.test",
    generated_at: "2026-08-28T10:00:00.000Z",
    updates: [
      {
        ticket: "ISSUE-412",
        requested: "Replace the description with the root-cause writeup.",
        fields: [
          { field: "description", mode: "replace", sent: BODY, read_back: BODY, match: "exact" },
        ],
        verdict: "success",
      },
    ],
    verdict: "success",
  };
}

/**
 * The malformation the criterion names: `match: "exact"` beside two values that
 * are not equal. A worker asserting its own round trip succeeded when the
 * document it wrote proves it did not.
 */
function malformed(): Record<string, unknown> {
  const a = wellFormed();
  (a["updates"] as Array<Record<string, unknown>>)[0]!["fields"] = [
    {
      field: "description",
      mode: "replace",
      sent: BODY,
      read_back: "<p>something else entirely</p>",
      match: "exact",
    },
  ];
  return a;
}

interface Fixture {
  run: RunPaths;
  cleanup: () => Promise<void>;
}

/**
 * A run whose task would harvest `success`: a real base commit, a real change
 * on top of it, and an envelope whose `files_changed` agrees with the diff.
 *
 * `onDisk` is written into the outbox `files/` directory and claimed verbatim,
 * so the reconciler's own over/under-claim findings stay silent and any
 * discrepancy this file sees is the one it is looking for.
 */
async function scaffold(onDisk: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-ticketops-"));
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
      brief: "ticket-ops validation fixture",
      repo,
      host_workdir: repo,
      container_workdir: "/workspace",
      branch: "main",
      base_ref: base,
      outbox: `/outbox/${TASK}`,
      deadline_s: 1500,
    }),
  );

  const taskOutbox = join(workerOutboxDir(run.root, WORKER), TASK);
  const files = join(taskOutbox, "files");
  await mkdir(files, { recursive: true });
  for (const [name, body] of Object.entries(onDisk)) {
    await writeFile(join(files, name), body);
  }
  await writeFile(
    join(taskOutbox, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: TASK,
      epoch: 1,
      worker: WORKER,
      status: "success",
      branch: "main",
      files_changed: [{ path: "note.txt", change: "added" }],
      artifacts: Object.keys(onDisk).map((name) => ({
        kind: "file",
        path: `/outbox/${TASK}/files/${name}`,
      })),
    }),
  );

  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Findings that name the ticket-ops document specifically. */
function ticketOpsFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("ticket-ops artifact"));
}

describe("harvestTask validates the ticket-ops artifact it finds (ISC-332)", () => {
  /**
   * THE CONTROL, AND IT COMES FIRST.
   *
   * A fixture that cannot reach `success` would satisfy every "not success"
   * assertion below for the one reason that proves nothing — the same trap
   * `harvest-reconcile-wiring.test.ts` and `harvest-fd-lifetime.test.ts`
   * measure their fixtures against. This also IS the "a well-formed artifact
   * passes cleanly and changes nothing" probe: same fixture, same claims, one
   * valid document, and the harvest is indistinguishable from one with no
   * ticket-ops document in it at all.
   */
  test(
    "a well-formed ticket-ops.json passes cleanly and changes nothing",
    async () => {
      const f = await scaffold({ [TICKET_OPS]: JSON.stringify(wellFormed()) });
      try {
        const { harvest } = await harvestTask(f.run, TASK);

        // The fixture really does reach the value under test.
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        expect(harvest.verdict).toBe("success");
        expect(ticketOpsFindings(harvest.discrepancies)).toEqual([]);

        // Validation is a READ, not a rewrite: the inventory is untouched.
        expect(harvest.derived.artifacts).toHaveLength(1);
        expect(harvest.derived.artifacts[0]!.path.endsWith(TICKET_OPS)).toBe(true);
        expect(harvest.derived.artifacts[0]!.bytes).toBe(
          JSON.stringify(wellFormed()).length,
        );
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(2),
  );

  test(
    "a malformed ticket-ops.json is reported and the verdict degrades",
    async () => {
      const f = await scaffold({ [TICKET_OPS]: JSON.stringify(malformed()) });
      try {
        const { harvest } = await harvestTask(f.run, TASK);

        const found = ticketOpsFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(TICKET_OPS);
        expect(found[0]).toContain("validation");

        /*
         * The whole point of the criterion. `success` is what this used to
         * return, with the finding — if it was produced at all — printed
         * underneath it.
         */
        expect(harvest.verdict).not.toBe("success");
        expect(harvest.verdict).toBe("failed");
        expect(harvest.reasons.join("\n")).toContain("ISC-332");

        /*
         * The task is still HARVESTED. A worker that writes garbage must not
         * cost the operator the rest of the report, which is what a throw out
         * of the reconciler would have done — `harvestAll` catches a failing
         * harvest and substitutes an `unavailable` row for the whole task.
         */
        expect(harvest.derived.artifacts).toHaveLength(1);
        expect(harvest.derived.files_changed.map((c) => c.path)).toEqual(["note.txt"]);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(2),
  );

  test(
    "a ticket-ops.json that is not JSON at all is reported, not thrown",
    async () => {
      const f = await scaffold({ [TICKET_OPS]: "{ this is not json" });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        const found = ticketOpsFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("not parseable JSON");
        expect(harvest.verdict).toBe("failed");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(2),
  );

  /**
   * VALIDATION IS OPT-IN BY THE ARTIFACT'S NAME, NOT BY THE WORKER'S ROLE.
   *
   * Two things are pinned by one probe. The narrow one: the harvester does not
   * try to schema-check every JSON file an arbitrary role happens to write, so
   * an `engineer` emitting a `coverage.json` is not graded against a ticket
   * contract it never claimed to satisfy. The load-bearing one: the selector
   * is a property of the DOCUMENT's filename — fixed by `skills/ticket-ops`,
   * inherited by any role that adopts the skill — and not `worker.role ===
   * "ticketing"`, which a rename in `fleet.yaml` would switch off in silence.
   */
  test(
    "the same malformed body under another name is not validated",
    async () => {
      const f = await scaffold({ "coverage.json": JSON.stringify(malformed()) });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        expect(ticketOpsFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(2),
  );
});
