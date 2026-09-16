/**
 * The credential sweep has a NEEDLE SUPPLIER, and it fires (ISC-333).
 *
 * ## Why this file exists when `ticket-artifact.test.ts` is green
 *
 * `findCredentialLeaks` has had a full unit suite for as long as it has
 * existed, and every case in it hands the function its own needles. That suite
 * stayed green through the entire period the detector could not detect: the
 * production path supplied `[]`, so the sweep ran over an empty needle set on
 * every real harvest, found nothing by construction, and published a clean
 * result. A worker echoed its credential and this repo's own detector said
 * nothing, because nothing had given it anything to look for.
 *
 * So these probes never import `findCredentialLeaks`, `resolveWorkerNeedles`,
 * `reconcileArtifactClaims`, or the observer target parse functions, and they
 * spell every artifact name as a string. They build a run directory, put a synthetic
 * secret in a worker's grant and in its output, and drive `harvestTask` — the
 * function `pifleet artifacts` and `pifleet report` call. Deleting the supplier
 * leaves every direct test of the sweep green and turns this file red, which is
 * the split that makes the wiring checkable rather than assumed. It is the
 * shape `harvest-reconcile-wiring.test.ts` established, applied to the layer
 * that was still missing.
 *
 * ## THE FIXTURE WRITES THE STORE WITH THE PRODUCTION WRITER, and that is the
 * ## part this file got wrong the first time
 *
 * The reader is not imported; the WRITER is — `writeWorkerSecretFiles`, the
 * same function `materializeWorkerInputs` calls. That asymmetry is the whole
 * control, and it was bought with a near miss worth writing down.
 *
 * Before ISC-343, this fixture hand-wrote `KEY=value` into the env file. That
 * encoded the delivery layout of the day into the test, so when ISC-337..342
 * moved granted secrets out of the environment and into 0444 files, the
 * supplier went blind against every real run — and this file stayed GREEN,
 * because its fixture was still producing the old layout for it to read. Two
 * sibling changes, each correct alone, each fully tested, and the detector
 * between them silently switched off.
 *
 * Sourcing the fixture from the writer closes that by construction. The layout
 * on disk is now whatever the production writer decides it is, so a future
 * change to delivery moves the fixture with it, and a supplier that did not
 * follow is a red build here rather than a quiet zero on the next real
 * harvest. A fixture that hand-writes what the code under test expects to find
 * proves the two agree with the fixture, not with each other.
 *
 * ## The control comes first, and it is doing real work here
 *
 * A leak assertion over a fixture whose artifact the outbox scan refuses, or
 * whose envelope never parses, passes for the one reason that proves nothing.
 * Worse for this particular criterion: a fixture that cannot reach `success`
 * would satisfy every "not success" assertion below for a reason unrelated to
 * the sweep. The first test measures the fixture — a clean artifact reconciles
 * with no finding and harvests `success` — so "degrades to failed" below is a
 * movement rather than a coincidence.
 *
 * ## Why this fixture builds a REAL git repository
 *
 * The same reason `harvest-ticket-ops-wiring.test.ts` does, and it is not
 * optional here. `harvest-reconcile-wiring.test.ts` gets away with
 * `host_workdir: "unset"` because it asserts only on `discrepancies`. This file
 * asserts on the VERDICT, and the clamp is deliberately a clamp:
 * `rank("unknown")` is -1, below every gradeable verdict, so a harvest with no
 * worktree is left exactly as it was and a credential hit would appear to
 * change nothing. A fixture without a base commit and a change on top of it
 * would make the criterion's central assertion untestable — while looking
 * green if it were written the other way round.
 *
 * ## THE SECRET IN THIS FILE IS SYNTHETIC
 *
 * `tkt_FAKE_NEEDLE_...` is a literal invented for this test. Nothing reaches a
 * real credential store, and a fixture that needed one would be the criterion
 * failing in a new way.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestTask } from "../../src/harvest/index.ts";
import { runPaths, workerOutboxDir, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import {
  secretContainerPath,
  secretPointerName,
  writeWorkerSecretFiles,
  type WorkerEnvPlan,
} from "../../src/run/worker-env.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-sweep";
const WORKER = "w1";
const TASK = "t1";

/** The granted variable's name, as `fleet.yaml` would spell it. */
const SECRET_NAME = "TICKET_API_TOKEN";

/**
 * The synthetic credential. Long enough to clear `MIN_NEEDLE_BYTES`, and
 * deliberately NOT shaped like anything the schema's own hygiene rules catch:
 * no `Authorization:` prefix, no `?token=` query parameter. If those fired
 * instead, the finding would prove the schema works and say nothing about
 * whether the needle sweep ran — which is the whole question.
 */
const SECRET = "tkt_FAKE_NEEDLE_a4f1c09e2b7d3856";

/** A value too short to be a needle: it would match honest prose everywhere. */
const SHORT_SECRET_NAME = "TICKET_ENV";
const SHORT_SECRET = "prod";

/** The clamp `reconcile.ts` applies to a refused ticket-ops document. */
const CEILING = "failed";

interface Fixture {
  run: RunPaths;
  cleanup: () => Promise<void>;
}

function ticketOps(notes: string): string {
  return JSON.stringify({
    schema: "pifleet.ticket-ops/v1",
    task_id: TASK,
    worker: WORKER,
    epoch: 1,
    operation: "query",
    ticket_host: "tickets.example.invalid",
    generated_at: new Date().toISOString(),
    no_change_needed: false,
    queried: [{ ticket: "T-9", fields: [{ field: "State", value: "Open" }] }],
    updates: [],
    commands: ["curl -H 'Authorization: Token <redacted>' https://tickets.example.invalid/T-9"],
    verdict: "success",
    notes,
  });
}

async function sh(argv: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${await new Response(p.stderr).text()}`);
  }
  return out;
}

/**
 * A run whose task would harvest `success` — a real base commit, a real change
 * on top of it, an envelope whose `files_changed` agrees with the diff — plus
 * the part this file is about: a worker whose GRANT is recorded in its launch
 * record and whose 0600 env file carries the value.
 *
 * The ticket-ops document is claimed verbatim, so the reconciler's own
 * over/under-claim findings stay silent and any discrepancy this file sees is
 * the one it is looking for.
 *
 * `granted: null` models the `PIFLEET_PI_COMMAND` double — no launch record at
 * all, which is how a run directory looks when no container was ever started
 * and therefore when no env file was ever handed to anything.
 */
async function scaffold(opts: {
  notes: string;
  granted: Record<string, string> | null;
  /**
   * The outbox artifact to write and claim, defaulting to the ticket-ops
   * document built from `notes`. The name is spelled by the caller as a string,
   * never imported from the selector it exercises.
   */
  artifact?: { name: string; body: string };
  /**
   * How the run directory DELIVERED the grant, defaulting to what `up` writes
   * today.
   *
   * `"files"` builds the store through `writeWorkerSecretFiles` and gives the
   * env file only the `<NAME>_FILE` pointers, exactly as `buildWorkerEnv`
   * does. `"env"` reproduces a run directory written BEFORE delivery moved:
   * values in the env file, no store at all. Both must sweep, because
   * `pifleet report` is pointed at a run directory rather than at a version of
   * this CLI, and the runs that carry credentials in their env files are
   * precisely the ones written before the credentials moved out of them.
   */
  delivery?: "files" | "env";
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-sweep-wiring-"));
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
      brief: "credential sweep fixture",
      repo,
      host_workdir: repo,
      container_workdir: "/workspace",
      branch: "main",
      base_ref: base,
      outbox: `/outbox/${TASK}`,
      deadline_s: 1500,
    }),
  );

  const wp = workerPaths(run, WORKER);
  await mkdir(wp.dir, { recursive: true });
  if (opts.granted !== null) {
    await writeFile(
      wp.launchJson,
      JSON.stringify({
        kind: "container",
        argv: ["docker", "run", "--env-file", wp.envFile, "pifleet/worker:test"],
        container: `pifleet-${RUN_ID}-${WORKER}`,
        image: "pifleet/worker:test",
        credential: null,
        secret_names: Object.keys(opts.granted),
      }),
    );
    const delivery = opts.delivery ?? "files";
    /*
     * TWO fleet-set variables the reader must NOT treat as needles, present in
     * BOTH layouts, and the second one is the load-bearing decoy.
     *
     * A supplier that swept the whole env file instead of the recorded grant
     * would take `tickets.example.invalid` as a needle — and that string
     * appears in the artifact's own `ticket_host` and `commands` fields,
     * legitimately, in every ticket-ops document ever written. So that mistake
     * reports a credential leak on the CLEAN fixture below, and on every real
     * harvest forever. It is long enough to clear the length floor, so the
     * floor cannot mask it either.
     */
    const fleetVars = [`PI_TASK_ID=${TASK}`, "PI_TICKET_HOST=tickets.example.invalid"];

    if (delivery === "files") {
      /*
       * THE STORE, WRITTEN BY THE PRODUCTION WRITER. The fixture states the
       * grant; `writeWorkerSecretFiles` decides the filenames, the modes and
       * the bytes. Only the two fields it reads are populated, and the cast is
       * confined to this line so that adding a field the writer needs is a
       * compile error here rather than a silent no-op on disk.
       */
      const plan = {
        secretNames: Object.keys(opts.granted),
        secretFiles: Object.entries(opts.granted).map(([name, value]) => ({ name, value })),
      } as unknown as WorkerEnvPlan;
      await writeWorkerSecretFiles(wp.secretsDir, plan);
      /*
       * And the env file as `buildWorkerEnv` renders it once delivery moved:
       * the POINTER under `<NAME>_FILE`, never the value. A supplier that kept
       * reading this file finds nothing under the bare granted name, which is
       * exactly the blindness ISC-343 exists to catch.
       */
      const lines = [
        ...Object.keys(opts.granted).map(
          (k) => `${secretPointerName(k)}=${secretContainerPath(k)}`,
        ),
        ...fleetVars,
      ];
      await writeFile(wp.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    } else {
      // The LEGACY layout, written the way `serializeEnvFile` wrote it before
      // delivery moved: `KEY=value`, no quoting, no escapes — docker's
      // `--env-file` has none, and a fixture that quoted its values would
      // prove the reader against a format nothing ever produced.
      const lines = [
        ...Object.entries(opts.granted).map(([k, v]) => `${k}=${v}`),
        ...fleetVars,
      ];
      await writeFile(wp.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    }
  }

  const taskOutbox = join(workerOutboxDir(run.root, WORKER), TASK);
  const files = join(taskOutbox, "files");
  await mkdir(files, { recursive: true });
  const artifact = opts.artifact ?? { name: "ticket-ops.json", body: ticketOps(opts.notes) };
  await writeFile(join(files, artifact.name), artifact.body);
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
      artifacts: [{ kind: "file", path: `/outbox/${TASK}/files/${artifact.name}` }],
    }),
  );
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Findings about the ticket-ops document only. */
function ticketFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("ticket-ops"));
}

const CLEAN_NOTES = "queried T-9 and read its State field back; nothing needed changing";

describe("the harvest sweeps a worker's own output for the credentials it was granted (ISC-333)", () => {
  test(
    "the fixture really does accept the artifact and reconcile it cleanly",
    async () => {
      const f = await scaffold({ notes: CLEAN_NOTES, granted: { [SECRET_NAME]: SECRET } });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        // A refused envelope or a refused outbox entry would make every
        // assertion in this file vacuous.
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
        expect(harvest.derived.artifacts.map((a) => a.path).join(" ")).toContain("ticket-ops.json");
        expect(ticketFindings(harvest.discrepancies)).toEqual([]);
        // And the fixture GRADES: a clean run of it reaches the top verdict,
        // so "degrades to failed" below is a movement and not a coincidence.
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * THE CRITERION. A worker echoed its own credential into the document it
   * publishes; the harvest that reads that document must refuse it and must
   * not come back `success`.
   */
  test(
    "a granted credential in the worker's own artifact is reported and clamps the verdict",
    async () => {
      const f = await scaffold({
        notes: `called the API with ${SECRET} to read T-9`,
        granted: { [SECRET_NAME]: SECRET },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        const found = ticketFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("contains a credential");
        // The PATH is named, which is what makes the finding actionable.
        expect(found[0]).toContain("notes");
        // The verdict degrades through the ceiling `reconcile.ts` already
        // applies to a malformed ticket-ops artifact — not a second mechanism.
        expect(harvest.verdict).toBe(CEILING);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * A finding that quotes the secret has spread it one hop further — into the
   * report, the operator's terminal, and the orchestrator's context. That is
   * the failure this whole mechanism exists to stop, wearing the uniform of
   * the fix.
   *
   * Asserted over the WHOLE rendered harvest and not just the finding string,
   * because the value could reach the operator through any published field:
   * a reason, a digest line, an artifact label.
   */
  test(
    "the finding names the variable's location and never quotes its value",
    async () => {
      const f = await scaffold({
        notes: `called the API with ${SECRET} to read T-9`,
        granted: { [SECRET_NAME]: SECRET },
      });
      try {
        const { harvest, facts } = await harvestTask(f.run, TASK);
        const rendered = `${JSON.stringify(harvest)}\n${JSON.stringify(facts)}`;
        expect(rendered).not.toContain(SECRET);
        // Not a prefix of it either — a truncated token is still a token's
        // worth of head start, and "we only printed the first eight characters"
        // is how a redaction becomes a disclosure.
        expect(rendered).not.toContain(SECRET.slice(0, 12));
        // The probe is only meaningful if the sweep actually fired.
        expect(harvest.verdict).toBe(CEILING);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * The other half of "it fires": it does not fire on everything.
   *
   * A clean artifact from a worker that HOLDS the credential must reconcile
   * exactly as one from a worker that holds nothing. Compared against the
   * no-grant run rather than against a hand-written expectation, so the claim
   * is "the grant changed nothing" and not "the grant produced this list".
   */
  test(
    "a clean artifact from a worker holding the secret changes nothing",
    async () => {
      const withGrant = await scaffold({
        notes: CLEAN_NOTES,
        granted: { [SECRET_NAME]: SECRET },
      });
      const without = await scaffold({ notes: CLEAN_NOTES, granted: null });
      try {
        const a = await harvestTask(withGrant.run, TASK);
        const b = await harvestTask(without.run, TASK);
        expect(a.harvest.discrepancies).toEqual(b.harvest.discrepancies);
        expect(a.harvest.verdict).toBe(b.harvest.verdict);
        expect(ticketFindings(a.harvest.discrepancies)).toEqual([]);
      } finally {
        await withGrant.cleanup();
        await without.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * A one-character needle matches every document, so a sweep that accepted
   * short values would report a leak on every harvest — the same "reporting
   * everything is reporting nothing" failure as an empty needle, arriving
   * through a value that is technically non-empty.
   *
   * `prod` is a real thing to put in `secrets:` and it appears in the honest
   * notes below. The sweep must ignore it while still catching the long one in
   * the same grant, which is what separates a length floor from a switch.
   */
  test(
    "a granted value too short to be a needle is ignored, and the long one still fires",
    async () => {
      const quiet = await scaffold({
        notes: `checked the ${SHORT_SECRET} instance and found nothing to change`,
        granted: { [SHORT_SECRET_NAME]: SHORT_SECRET },
      });
      const loud = await scaffold({
        notes: `checked the ${SHORT_SECRET} instance with ${SECRET}`,
        granted: { [SHORT_SECRET_NAME]: SHORT_SECRET, [SECRET_NAME]: SECRET },
      });
      try {
        const q = await harvestTask(quiet.run, TASK);
        expect(ticketFindings(q.harvest.discrepancies)).toEqual([]);
        expect(q.harvest.verdict).toBe("success");

        const l = await harvestTask(loud.run, TASK);
        expect(ticketFindings(l.harvest.discrepancies)).toHaveLength(1);
        expect(l.harvest.verdict).toBe(CEILING);
      } finally {
        await quiet.cleanup();
        await loud.cleanup();
      }
    },
    cliBudget(6),
  );

  /**
   * ISC-343. THE SUPPLIER FOLLOWED THE STORE WHEN THE STORE MOVED.
   *
   * Every probe above runs on the CURRENT layout by default, so they already
   * assert the supplier reads the store. This one asserts the other half —
   * that moving delivery did not orphan the run directories written before it
   * moved — and it is the half that fails silently, because a harvest of an
   * old run produces a clean report either way.
   *
   * `pifleet report` takes a run directory, not a version of this CLI. The
   * runs whose env files still carry credentials are exactly the ones written
   * before the credentials moved out of env files, which makes them exactly
   * the history worth sweeping.
   */
  test(
    "a run directory written before delivery moved is still swept (ISC-343)",
    async () => {
      const f = await scaffold({
        notes: `called the API with ${SECRET} to read T-9`,
        granted: { [SECRET_NAME]: SECRET },
        delivery: "env",
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        const found = ticketFindings(harvest.discrepancies);
        expect(found, "the legacy env-file layout must still supply needles").toHaveLength(1);
        expect(found[0]).toContain("contains a credential");
        expect(harvest.verdict).toBe(CEILING);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * The control for the probe above, and the one that would have caught the
   * near miss on its own.
   *
   * A legacy fixture proves the fallback; it does NOT prove the primary, and a
   * supplier that read only the env file would pass the legacy probe while
   * being blind on every current run. So this builds a run in the CURRENT
   * layout and REMOVES the env file entirely. Nothing but the store can supply
   * a needle, so a supplier that never learned to read it has no second source
   * to hide behind.
   *
   * It also pins the direction: the env file that is present in the real
   * current layout carries `<NAME>_FILE=/secrets/<NAME>`, and a reader that
   * took that pointer as the value would sweep for a path. Deleting the file
   * makes that impossible to pass by accident.
   */
  test(
    "with only the secret store on disk, the sweep still fires (ISC-343)",
    async () => {
      const f = await scaffold({
        notes: `called the API with ${SECRET} to read T-9`,
        granted: { [SECRET_NAME]: SECRET },
      });
      try {
        await rm(join(workerPaths(f.run, WORKER).envFile), { force: true });
        const { harvest } = await harvestTask(f.run, TASK);
        const found = ticketFindings(harvest.discrepancies);
        expect(found, "the secret store alone must supply needles").toHaveLength(1);
        expect(found[0]).toContain("contains a credential");
        expect(harvest.verdict).toBe(CEILING);
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * The pointer is not a needle.
   *
   * In the current layout the env file carries `TICKET_API_TOKEN_FILE` whose
   * value is `/secrets/TICKET_API_TOKEN` — a path, long enough to clear the
   * length floor, sitting under a name derived from a granted one. A supplier
   * that fell back to the env file WHILE a store existed, or that matched
   * granted names by prefix, would sweep for that string.
   *
   * The artifact below names the container path in its `commands` field, which
   * is an entirely honest thing for a ticket-ops document to do — the skill's
   * documented call reads the credential from exactly that path. So the wrong
   * supplier reports a credential leak on a CLEAN artifact, and it reports it
   * on every real harvest of every worker holding a secret.
   */
  test(
    "the container path a worker legitimately names is not treated as a needle (ISC-343)",
    async () => {
      const f = await scaffold({
        notes: `read the token from ${secretContainerPath(SECRET_NAME)} and queried T-9`,
        granted: { [SECRET_NAME]: SECRET },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        expect(ticketFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});

/**
 * SRD-OBSERVER-ROLES Phase 2 task 2.4: the same supplier reaches the observer
 * target artifacts.
 *
 * `observer-docker-ops.json` is swept inside its own parse. A direct test of
 * that parse hands it needles, and so stays green if the harvest never passes
 * any. These probes drive `harvestTask` over a run directory whose grant is
 * written by the production writer, so the needles can only arrive the way
 * they arrive in production.
 */
const DOCKER_OPS = "observer-docker-ops.json";

/** §5.6's document, well formed, with one evidence line the caller chooses. */
function observerDockerOps(evidence: string): string {
  return JSON.stringify({
    schema: "pifleet.observer-docker-ops/v1",
    worker: WORKER,
    sweep_id: null,
    window_opened_at: null,
    services: [
      {
        name: "web-1",
        namespace: "docker-host-a",
        assessment: "healthy",
        coverage: [
          { channel: "state", result: "answered" },
          { channel: "logs", result: "answered" },
        ],
        selector: "name=web-1",
        window: "300s",
        evidence_ref: [evidence],
        container_id: "4f1c2b9d8e7a",
        image: "nginx:1.27",
        restart_count: 0,
      },
    ],
  });
}

/** Findings about the docker document only. */
function observerFindings(discrepancies: readonly string[]): string[] {
  return discrepancies.filter((d) => d.includes("observer-docker-ops"));
}

const CLEAN_EVIDENCE = "observe-docker docker-host-a inspect web-1: State.Status=running";

describe("the harvest sweeps an observer-docker-ops.json for the credentials the worker was granted", () => {
  /**
   * THE CONTROL, FIRST. A clean document from a worker that HOLDS the secret
   * reaches `success` with no observer finding, so `failed` below is a movement.
   */
  test(
    "a clean observer-docker-ops.json from a worker holding the secret harvests success",
    async () => {
      const f = await scaffold({
        notes: CLEAN_NOTES,
        granted: { [SECRET_NAME]: SECRET },
        artifact: { name: DOCKER_OPS, body: observerDockerOps(CLEAN_EVIDENCE) },
      });
      try {
        const { harvest } = await harvestTask(f.run, TASK);
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
        expect(harvest.derived.artifacts.map((a) => a.path).join(" ")).toContain(DOCKER_OPS);
        expect(observerFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );

  /**
   * THE PROBE. The granted credential, echoed into the observer's evidence, is
   * reported and clamps the task, and neither the value nor its head reaches
   * anything the harvest renders.
   */
  test(
    "a granted credential in observer-docker-ops.json is reported, fails the task, and is never repeated",
    async () => {
      const f = await scaffold({
        notes: CLEAN_NOTES,
        granted: { [SECRET_NAME]: SECRET },
        artifact: { name: DOCKER_OPS, body: observerDockerOps(`docker login used ${SECRET}`) },
      });
      try {
        const { harvest, facts } = await harvestTask(f.run, TASK);
        const found = observerFindings(harvest.discrepancies);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("contains a credential");
        expect(found[0]).toContain("evidence_ref");
        expect(harvest.verdict).toBe(CEILING);

        const rendered = `${JSON.stringify(harvest)}\n${JSON.stringify(facts)}`;
        expect(rendered).not.toContain(SECRET);
        expect(rendered).not.toContain(SECRET.slice(0, 12));
      } finally {
        await f.cleanup();
      }
    },
    cliBudget(3),
  );
});
