/**
 * A HOSTED provider's Class 1 key is swept from harvested artifacts (ISC-421,
 * SRD D15).
 *
 * ## The gap this closes, and it was measured before it was built against
 *
 * `worker-env.ts` builds `redactable = [apiKeyEnvName, ...secretNames]`, which
 * arms the LOG redactor for the Class 1 key. The harvest sweep reads a
 * DIFFERENT list: `harvest/needles.ts` takes `launch.secret_names`, and
 * `secretNames` deliberately excludes the key (ISC-422). So the credential
 * every worker carries and none requested was never swept from a harvested
 * artifact, for every fleet, on every run — the redactor scrubbing it out of
 * `events.jsonl` while nothing looked for it in the worker's own output.
 *
 * §12.4 accepted that residual twice on the basis that the key "carries no
 * billing authority". A `hosted: true` provider's key is a SUBSCRIPTION
 * credential, and D8 puts its value in a file the worker can `cat`. So the
 * severity changed and the decision had to be re-taken rather than inherited.
 *
 * ## THE PROBE IS END TO END, because the field is not the criterion
 *
 * ISC-421's probe clause says "plant the key's value in a harvested artifact
 * and assert the sweep finds it". A test that asserts `provider_key_name` is
 * populated stops one layer short of the thing that was broken: every seam
 * could be correct and the sweep still return nothing, which is exactly what
 * `resolveWorkerNeedles`' `granted.length === 0` early return did before this
 * change. So the third block below never imports `findCredentialLeaks` or
 * `resolveWorkerNeedles`. It drives `harvestTask` — what `pifleet report` calls
 * — over a run directory whose launch record and secret store were written by
 * `materializeWorkerInputs`, the production writer.
 *
 * That asymmetry is the control, and `harvest-credential-sweep-wiring.test.ts`
 * bought it the hard way: its fixture once hand-wrote the delivery layout, so
 * when delivery moved the supplier went blind and the test stayed green,
 * because the fixture was still producing the old layout for it to read. Here
 * the whole worker directory comes from `up`'s own code path, so a future
 * change that moves the key and does not follow is red here rather than a quiet
 * zero on the next real harvest.
 *
 * ## THE THREE VACUITY TRAPS THIS FIXTURE IS SHAPED AROUND
 *
 * **Equal sentinels.** A fixture where the provider key's value equals a
 * granted secret's value cannot distinguish the new path from the existing one:
 * the sweep would find the value through `secret_names` and the test would pass
 * against the unfixed code. The three sentinels below are distinct and
 * high-entropy, and `w-hosted-grant` holds two of them at once so the two paths
 * are observably separate rather than merely both present.
 *
 * **The eight-byte floor.** `MIN_NEEDLE_BYTES` is 8, and a shorter sentinel is
 * silently dropped — the test would then pass or fail for a reason that has
 * nothing to do with the wiring. Every sentinel here is over forty bytes, and
 * the assertion below pins that rather than assuming it.
 *
 * **No negative twin.** Without a `hosted: false` worker, "the key is always
 * swept" and "the key is swept when hosted" are the same green. `w-local` is
 * that twin: same fleet, same delivery, same planted-value fixture, and its key
 * must NOT become a needle.
 *
 * ## THE COMMON CASE IS A WORKER WITH NO GRANT AT ALL
 *
 * `w-hosted` declares no `secrets:`, so its `secret_names` is `[]`. That is not
 * an edge of this criterion, it is the criterion: ISC-422 asserts the key is
 * absent from the grant list, and a fleet with no `secrets:` block anywhere
 * still hands every worker a provider key. The natural fixture — one that gives
 * the worker a grant as well — makes `granted.length` non-zero and would sweep
 * correctly against an implementation that is broken for the majority of real
 * fleets.
 *
 * ## EVERY VALUE IN THIS FILE IS SYNTHETIC
 *
 * `sentinel-*` are literals invented here. Nothing reaches a real credential
 * store, and a fixture that needed one would be this criterion failing in a new
 * way.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { parseConfig, resolveWorker, type LoadedConfig } from "../../src/config/load.ts";
import { harvestTask } from "../../src/harvest/index.ts";
import { MIN_NEEDLE_BYTES, resolveWorkerNeedles } from "../../src/harvest/needles.ts";
import { materializeWorkerInputs } from "../../src/run/materialize.ts";
import { runPaths, workerOutboxDir, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";
import { cliBudget } from "../support/budget.ts";

/** The one model id both provider blocks serve, so `model:` picks the ENDPOINT. */
const MODEL = "gpt-oss";

/** The operator's spellings — deliberately neither is the `OMLX_API_KEY` default. */
const HOSTED_KEY_VAR = "VENDOR_CLOUD_API_KEY";
const LOCAL_KEY_VAR = "LOCAL_OMLX_KEY";
const GRANT_VAR = "TICKET_API_TOKEN";

/**
 * THREE DISTINCT SENTINELS. See the header: a fixture that reused one value
 * across two delivery paths could not tell them apart, and one under
 * `MIN_NEEDLE_BYTES` would be dropped before the wiring was ever exercised.
 *
 * None is shaped like anything `ticketOpsSchema`'s own hygiene rules catch — no
 * `Authorization:` prefix, no `?token=` — so a finding here is the needle sweep
 * firing rather than the schema refusing the document for an unrelated reason.
 */
const HOSTED_KEY = "sentinel-hosted-subscription-key-8f31c0a742d9";
const LOCAL_KEY = "sentinel-selfhosted-provider-key-1c94ea08b7d5";
const GRANT_VALUE = "sentinel-operator-granted-token-6b2fd913ae40";

const HOST_ENV: Record<string, string | undefined> = {
  [HOSTED_KEY_VAR]: HOSTED_KEY,
  [LOCAL_KEY_VAR]: LOCAL_KEY,
  [GRANT_VAR]: GRANT_VALUE,
};

const cleanups: string[] = [];
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

/**
 * Two providers in one fleet, so the positive and the negative twin differ in
 * `hosted` and in NOTHING else — same delivery, same store, same sweep.
 *
 * `w-hosted` has no `secrets:` on purpose. See the header.
 */
function doc(repo: string): Record<string, unknown> {
  return {
    version: 2,
    name: "provider-key-sweep",
    docker: { pi_version: "0.79.6", network: "pifleet-pks" },
    run: { repo, budget: { tokens_ceiling: 1_000_000 } },
    llm: {
      model: MODEL,
      provider: "omlx",
      providers: {
        omlx: {
          hosted: false,
          base_url: "http://omlx.pifleet.internal:8000/v1",
          api_key_env: LOCAL_KEY_VAR,
        },
        "vendor-cloud": {
          hosted: true,
          base_url: "https://vendor.example.invalid/v1",
          api_key_env: HOSTED_KEY_VAR,
        },
      },
    },
    secrets: { env_allowlist: [GRANT_VAR] },
    roles: { plain: {}, tick: { secrets: [GRANT_VAR] } },
    workers: [
      // The criterion: a hosted worker with NO operator grant at all.
      { id: "w-hosted", role: "plain", model: `vendor-cloud/${MODEL}` },
      // The negative twin: identical, self-hosted.
      { id: "w-local", role: "plain" },
      // The asymmetric case: a hosted worker that ALSO holds a grant, so the
      // two lists are observably different rather than both empty.
      { id: "w-hosted-grant", role: "tick", model: `vendor-cloud/${MODEL}` },
    ],
    egress: { allow: [] },
  };
}

const load = (repo: string): Promise<LoadedConfig> =>
  parseConfig(stringify(doc(repo)), join(tmpdir(), "provider-key-sweep", "fleet.yaml"));

// ---------------------------------------------------------------------------
// The plan — where the decision is made, ONCE
// ---------------------------------------------------------------------------

describe("buildWorkerEnv records the hosted key's NAME, and only when it delivered one", () => {
  const planFor = async (id: string, env: Record<string, string | undefined> = HOST_ENV) => {
    const loaded = await load(".");
    return buildWorkerEnv(loaded, resolveWorker(loaded, id), env);
  };

  test("a hosted worker's plan names its own provider's key variable", async () => {
    const plan = await planFor("w-hosted");
    expect(plan.providerKeyName).toBe(HOSTED_KEY_VAR);
    /*
     * ANTI-VACUITY. The assertion above is satisfied by a plan that names a key
     * it never delivered — which is precisely the state the harvester cannot
     * resolve and would report as a degradation on every run. The name is a
     * promise that a file exists in the store under it, so the same plan must
     * show the file being written.
     */
    expect(plan.secretFiles).toContainEqual({ name: HOSTED_KEY_VAR, value: HOSTED_KEY });
  });

  /**
   * THE NEGATIVE TWIN. Without it, "gated on hosted" and "always added" are
   * indistinguishable — and `apiKeyEnvName` is populated for BOTH workers, so
   * an implementation that copied that field instead would pass every positive
   * assertion in this file.
   */
  test("a self-hosted worker's plan records no key, though it is delivered one", async () => {
    const plan = await planFor("w-local");
    expect(plan.providerKeyName).toBeNull();
    // The distinguishing pair: the diagnostic name IS populated, and it is not
    // what got copied. §12.4's self-hosted residual stays accepted.
    expect(plan.apiKeyEnvName).toBe(LOCAL_KEY_VAR);
    expect(plan.secretFiles).toContainEqual({ name: LOCAL_KEY_VAR, value: LOCAL_KEY });
  });

  /**
   * DELIVERED, not merely CONFIGURED. A hosted provider whose key is absent
   * from the host environment writes no file, so recording the name would be a
   * claim nothing can resolve.
   */
  test("a hosted worker with no key in the host environment records nothing", async () => {
    const plan = await planFor("w-hosted", { [LOCAL_KEY_VAR]: LOCAL_KEY });
    expect(plan.missingApiKey).toBe(true);
    expect(plan.providerKeyName).toBeNull();
    expect(plan.secretFiles).toEqual([]);
  });

  /**
   * ISC-422 RESTATED AT THIS LAYER, because it is the guard on this change.
   *
   * The whole design is that the sweep learns the key from a SECOND field
   * rather than by widening the grant list. A worker holding both makes that
   * checkable: two names, two files, and the key on neither the grant list nor
   * the non-credential declaration.
   */
  test("the grant list is untouched, and the two lists stay distinct", async () => {
    const plan = await planFor("w-hosted-grant");
    expect(plan.secretNames).toEqual([GRANT_VAR]);
    expect(plan.secretNames).not.toContain(HOSTED_KEY_VAR);
    expect(plan.providerKeyName).toBe(HOSTED_KEY_VAR);
    expect(plan.secretFiles.map((f) => f.name).sort()).toEqual([GRANT_VAR, HOSTED_KEY_VAR].sort());
  });

  /**
   * THE FLOOR, pinned rather than assumed. `resolveWorkerNeedles` silently
   * drops a value under `MIN_NEEDLE_BYTES`, so a sentinel that had drifted
   * under it would make every sweep assertion below pass or fail for a reason
   * unrelated to the wiring.
   */
  test("every sentinel clears the needle floor and they are all distinct", () => {
    for (const v of [HOSTED_KEY, LOCAL_KEY, GRANT_VALUE]) {
      expect(v.length).toBeGreaterThanOrEqual(MIN_NEEDLE_BYTES);
    }
    expect(new Set([HOSTED_KEY, LOCAL_KEY, GRANT_VALUE]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The launch record — the artifact the harvester actually opens
// ---------------------------------------------------------------------------

/**
 * Run `materializeWorkerInputs` for one worker and return its paths.
 *
 * The host environment is mutated rather than passed, because that is the only
 * seam `up` has: `buildWorkerEnv` takes `hostEnv` as a parameter, and
 * `materializeWorkerInputs` reaches it through `process.env`. Restored by the
 * caller's `finally`.
 */
async function materializeOne(
  workerId: string,
  slug: string,
  repo = ".",
): Promise<{ run: RunPaths; wp: ReturnType<typeof workerPaths> }> {
  const runsDir = await mkdtemp(join(tmpdir(), `pifleet-pks-${slug}-`));
  cleanups.push(runsDir);
  process.env["PIFLEET_RUNS_DIR"] = runsDir;
  const loaded = await load(repo);
  const run = runPaths(`pks-${slug}`, runsDir);
  await mkdir(run.root, { recursive: true });
  await materializeWorkerInputs(loaded, run, [workerId], undefined, { writeLaunchRecord: true });
  return { run, wp: workerPaths(run, workerId) };
}

/** Set the sentinels in `process.env`, returning a restorer. */
function withHostEnv(): () => void {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(HOST_ENV)) {
    before.set(k, process.env[k]);
    if (v !== undefined) process.env[k] = v;
  }
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("launch.json carries the name, and never the value", () => {
  /**
   * The plan field could be perfect and never reach disk. `harvest/needles.ts`
   * opens THIS file at a moment when the config that produced it is long gone,
   * so an assertion on the in-memory plan proves the wrong artifact correct.
   */
  test("a hosted worker's record names the key beside an empty grant list", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-hosted", "hosted");
      const raw = await readFile(wp.launchJson, "utf8");
      const launch = JSON.parse(raw) as { secret_names: string[]; provider_key_name: string | null };
      expect(launch.provider_key_name).toBe(HOSTED_KEY_VAR);
      // The criterion's own shape: NO operator grant, and a key all the same.
      expect(launch.secret_names).toEqual([]);
      /*
       * A PLAINTEXT CREDENTIAL HERE WOULD BE STRICTLY WORSE THAN THE GAP BEING
       * CLOSED. `launch.json` is read by the supervisor, by `down`, and by
       * anything that renders a launch. A substring sweep of the whole file
       * rather than a key-by-key walk, for `class1-key-file.test.ts`'s reason:
       * a value that arrived by any route appears in the bytes while a
       * field-by-field check looks clean.
       */
      expect(raw).not.toContain(HOSTED_KEY);
      // And the value IS on disk, in the store, under the key's own name — so
      // the record's name resolves to something.
      expect(await readFile(join(wp.secretsDir, HOSTED_KEY_VAR), "utf8")).toBe(HOSTED_KEY);
    } finally {
      restore();
    }
  });

  test("a self-hosted worker's record carries null", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-local", "local");
      const raw = await readFile(wp.launchJson, "utf8");
      const launch = JSON.parse(raw) as { provider_key_name: string | null };
      expect(launch.provider_key_name).toBeNull();
      // Not because nothing was delivered: the local key is in the store.
      expect(await readFile(join(wp.secretsDir, LOCAL_KEY_VAR), "utf8")).toBe(LOCAL_KEY);
      expect(raw).not.toContain(LOCAL_KEY);
    } finally {
      restore();
    }
  });

  /**
   * THE GUARD, read off disk. ISC-422 is a closed criterion asserting the key's
   * NAME is absent from `launch.secret_names`, and collapsing the two lists is
   * the wrong fix this design exists to avoid. It must stay green here.
   */
  test("the grant list on disk still refuses to claim the key", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-hosted-grant", "grant");
      const launch = JSON.parse(await readFile(wp.launchJson, "utf8")) as {
        secret_names: string[];
        provider_key_name: string | null;
      };
      expect(launch.secret_names).toEqual([GRANT_VAR]);
      expect(launch.secret_names).not.toContain(HOSTED_KEY_VAR);
      expect(launch.provider_key_name).toBe(HOSTED_KEY_VAR);
    } finally {
      restore();
    }
  });

  /**
   * THE SUPPLIER, at the layer between the record and the sweep.
   *
   * `NeedleSupply.names` is a SWEEP MANIFEST, not a grant list — its job is to
   * say what was swept, so the key's name is on it. That decision is argued in
   * the field's own docblock; this pins it, and pins that the manifest still
   * distinguishes the two sources by holding both names for a worker that has
   * both.
   */
  test("the supplier sweeps the key's value and names it in the manifest", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-hosted-grant", "supply");
      const supply = await resolveWorkerNeedles(wp);
      expect(supply.needles.sort()).toEqual([HOSTED_KEY, GRANT_VALUE].sort());
      expect(supply.names.sort()).toEqual([HOSTED_KEY_VAR, GRANT_VAR].sort());
      // Nothing failed to resolve, so nothing is noted.
      expect(supply.note).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * THE EARLY RETURN, which is where this change would have shipped broken.
   *
   * `resolveWorkerNeedles` returned `EMPTY` whenever `secret_names` was empty.
   * A hosted worker with no `secrets:` is exactly that record — and it is the
   * common case, not an edge — so the field could be populated perfectly, the
   * resolver wired perfectly, and the sweep still find nothing.
   */
  test("a worker whose ONLY credential is the key still supplies a needle", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-hosted", "only");
      const supply = await resolveWorkerNeedles(wp);
      expect(supply.needles).toEqual([HOSTED_KEY]);
      expect(supply.names).toEqual([HOSTED_KEY_VAR]);
    } finally {
      restore();
    }
  });

  /**
   * THE CHEAP-EMPTY PROMISE, KEPT. `needles.ts` argues for holding plaintext at
   * all on the grounds that a worker with no grant is never resolved. Widening
   * the guard by one disjunct must not widen it to everything: a self-hosted
   * worker with no `secrets:` still supplies nothing.
   */
  test("a self-hosted worker with no grant supplies nothing at all", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-local", "empty");
      const supply = await resolveWorkerNeedles(wp);
      expect(supply.needles).toEqual([]);
      expect(supply.names).toEqual([]);
      expect(supply.note).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * A DEGRADATION IS REPORTED, and reported as what it is.
   *
   * The name is written by the same statement that writes the file, so an
   * unresolvable name means the store was moved, pruned or hand-edited after
   * the run — the sweep is running narrower than the run intended, which is the
   * silence this module exists to end. The note must NOT call the key a grant:
   * that is the claim `secret_names` was kept clean to avoid making.
   */
  test("a key whose store file is gone is noted, and not called a grant", async () => {
    const restore = withHostEnv();
    try {
      const { wp } = await materializeOne("w-hosted", "gone");
      await rm(join(wp.secretsDir, HOSTED_KEY_VAR), { force: true });
      const supply = await resolveWorkerNeedles(wp);
      expect(supply.needles).toEqual([]);
      expect(supply.note).not.toBeNull();
      expect(supply.note).toContain(HOSTED_KEY_VAR);
      expect(supply.note).toContain("hosted provider's API key");
      expect(supply.note).not.toContain("granted");
      // The note names the variable, never its value.
      expect(supply.note).not.toContain(HOSTED_KEY);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// THE CRITERION — plant the value in a harvested artifact, assert the sweep
// finds it (ISC-421's own probe clause)
// ---------------------------------------------------------------------------

const RUN_SLUG = "e2e";
const TASK = "t1";

function ticketOps(worker: string, notes: string): string {
  return JSON.stringify({
    schema: "pifleet.ticket-ops/v1",
    task_id: TASK,
    worker,
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
 * A run that would harvest `success` — a real base commit, a real change on top
 * of it, an envelope whose `files_changed` agrees with the diff — plus the part
 * this block is about: a worker directory written by `materializeWorkerInputs`,
 * and an artifact carrying `notes`.
 *
 * The REAL GIT REPOSITORY is not optional, for the reason
 * `harvest-credential-sweep-wiring.test.ts` records: this block asserts on the
 * VERDICT, and `rank("unknown")` is below every gradeable verdict, so a harvest
 * with no worktree is left exactly as it was and a credential hit would appear
 * to change nothing.
 */
async function scaffold(workerId: string, notes: string): Promise<RunPaths> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-pks-e2e-"));
  cleanups.push(root);
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

  const runsDir = join(root, "runs");
  await mkdir(runsDir, { recursive: true });
  process.env["PIFLEET_RUNS_DIR"] = runsDir;
  const loaded = await load(repo);
  const run = runPaths(`pks-${RUN_SLUG}-${workerId}`, runsDir);
  await mkdir(run.root, { recursive: true });
  /*
   * THE WORKER DIRECTORY COMES FROM THE PRODUCTION WRITER — the launch record
   * AND the 0444 secret store, in one call, from the function `up` calls. See
   * the header: a fixture that hand-writes the layout it expects the reader to
   * find proves the two agree with the fixture, not with each other.
   */
  await materializeWorkerInputs(loaded, run, [workerId], undefined, { writeLaunchRecord: true });

  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(
    join(run.inboxDir, `${TASK}.json`),
    JSON.stringify({
      acceptance: [],
      schema: "pifleet.task/v1",
      task_id: TASK,
      run_id: run.runId,
      epoch: 1,
      attempt: 1,
      worker: workerId,
      dispatched_at: new Date().toISOString(),
      title: TASK,
      brief: "provider key sweep fixture",
      repo,
      host_workdir: repo,
      container_workdir: "/workspace",
      branch: "main",
      base_ref: base,
      outbox: `/outbox/${TASK}`,
      deadline_s: 1500,
    }),
  );

  const taskOutbox = join(workerOutboxDir(run.root, workerId), TASK);
  const files = join(taskOutbox, "files");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "ticket-ops.json"), ticketOps(workerId, notes));
  await writeFile(
    join(taskOutbox, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: TASK,
      epoch: 1,
      worker: workerId,
      status: "success",
      branch: "main",
      files_changed: [{ path: "note.txt", change: "added" }],
      artifacts: [{ kind: "file", path: `/outbox/${TASK}/files/ticket-ops.json` }],
    }),
  );
  return run;
}

const CLEAN_NOTES = "queried T-9 and read its State field back; nothing needed changing";
/** The leak: the worker `cat`s its key file and the value lands in its own artifact. */
const LEAKY_NOTES = (v: string) => `read the provider key file while debugging; it held ${v}`;

/** Findings about the ticket-ops document only. */
const ticketFindings = (d: readonly string[]): string[] => d.filter((x) => x.includes("ticket-ops"));

describe("ISC-421: a hosted provider's key in an artifact is FOUND", () => {
  /**
   * THE CONTROL, and it comes first because it is doing real work. Every "the
   * harvest degraded" assertion below is satisfied by a fixture whose envelope
   * never parses or whose artifact the outbox scan refuses — for reasons with
   * nothing to do with the sweep. This measures the fixture: a clean artifact
   * reconciles with no finding and grades `success`, so "clamps to failed"
   * below is a MOVEMENT rather than a coincidence.
   *
   * Budget matches `harvest-credential-sweep-wiring.test.ts`, whose scaffold
   * this one mirrors spawn for spawn: eight cheap `git` invocations plus the
   * harvest's own, charged at `PER_SPAWN_IDLE_MS` — the EXPENSIVE rate — three
   * times over.
   */
  test(
    "the fixture really does accept the artifact and grade it success",
    async () => {
      const restore = withHostEnv();
      try {
        const run = await scaffold("w-hosted", CLEAN_NOTES);
        const { harvest } = await harvestTask(run, TASK);
        expect(harvest.claimed, "the envelope must parse").not.toBeNull();
        expect(harvest.reasons.join("\n")).not.toContain("outbox file refused");
        expect(harvest.derived.artifacts.map((a) => a.path).join(" ")).toContain("ticket-ops.json");
        expect(ticketFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        restore();
      }
    },
    cliBudget(3),
  );

  /**
   * THE CRITERION, at the altitude its probe clause names.
   *
   * `w-hosted` has NO `secrets:` — `secret_names` is `[]` — so before this
   * change `resolveWorkerNeedles` returned `EMPTY` on the first guard and this
   * artifact harvested clean with its subscription credential in it.
   */
  test(
    "the key's value planted in a harvested artifact is found and clamps the verdict",
    async () => {
      const restore = withHostEnv();
      try {
        const run = await scaffold("w-hosted", LEAKY_NOTES(HOSTED_KEY));
        const { harvest } = await harvestTask(run, TASK);
        expect(ticketFindings(harvest.discrepancies).join("\n")).toContain("credential");
        expect(harvest.verdict).toBe("failed");
        /*
         * THE FINDING DOES NOT QUOTE WHAT IT FOUND. `needles.ts` argues that a
         * sweep which republished the value would spread it one hop further,
         * into the report — the failure it exists to stop, wearing the uniform
         * of the fix. Asserted over the whole rendered harvest, not the
         * discrepancy alone.
         */
        expect(JSON.stringify(harvest)).not.toContain(HOSTED_KEY);
      } finally {
        restore();
      }
    },
    cliBudget(3),
  );

  /**
   * THE NEGATIVE TWIN. Same fleet, same fixture, same planted-value shape — the
   * ONE difference is `hosted: false` on the worker's provider. Without this,
   * "always swept" and "swept when hosted" are the same green, and D15's
   * deliberate gate would be untested.
   */
  test(
    "a self-hosted provider's key in the same artifact is NOT a needle",
    async () => {
      const restore = withHostEnv();
      try {
        const run = await scaffold("w-local", LEAKY_NOTES(LOCAL_KEY));
        const { harvest } = await harvestTask(run, TASK);
        expect(ticketFindings(harvest.discrepancies)).toEqual([]);
        expect(harvest.verdict).toBe("success");
      } finally {
        restore();
      }
    },
    cliBudget(3),
  );

  /**
   * THE ASYMMETRIC CASE. A hosted worker that also holds a grant, leaking the
   * KEY and not the grant.
   *
   * Degenerate fixtures hide narrowing: if the only multi-credential fixture
   * planted both values, an implementation that swept only the grant would
   * still produce a finding and look correct. This plants exactly one, and it
   * is the one that only the new path can reach.
   */
  test(
    "with a grant also held, the key alone in the artifact still fires",
    async () => {
      const restore = withHostEnv();
      try {
        const run = await scaffold("w-hosted-grant", LEAKY_NOTES(HOSTED_KEY));
        const { harvest } = await harvestTask(run, TASK);
        expect(ticketFindings(harvest.discrepancies).join("\n")).toContain("credential");
        expect(harvest.verdict).toBe("failed");
        // The grant's own value was never in this artifact, so nothing here is
        // explained by the pre-existing path.
        expect(JSON.stringify(harvest)).not.toContain(GRANT_VALUE);
      } finally {
        restore();
      }
    },
    cliBudget(3),
  );
});
