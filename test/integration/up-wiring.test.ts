/**
 * `up`'s security wiring, pinned (review findings 1 and 2).
 *
 * Mutation testing found that deleting the `ensureEgressNetwork` call or the
 * `detectRepoHazards` call from `up.ts` left the entire suite green: both
 * controls were tested exhaustively as modules and held in place by nothing.
 * A control nothing pins is one refactor away from shipping absent, and its
 * unit tests would go on certifying it the whole way down.
 *
 * So this file drives the REAL CLI process (`up` with a real config, a real
 * seeded repo, the fake-pi double) and asserts on two things the mutations
 * change:
 *
 *  1. The ledger. `up` writes every step into its own shard (`cli-up`), where
 *     `seq` is authoritative order — so "hazards were neutralized BEFORE any
 *     supervisor launched" is a comparison of integers, not of wall clocks.
 *     Order is the point: a hazard neutralized after the agent starts is not
 *     neutralized.
 *  2. The disk. The seeded AGENTS.md must actually be quarantined — the
 *     ledger saying so is `up`'s claim, the rename is the fact.
 *
 * The egress assertion is on `detail.internal === true` specifically, not on
 * the event existing: the ledger append is a separate statement from the
 * `ensureEgressNetwork` call, and with the call deleted the event still
 * appears — with `internal: null`. Asserting presence alone would survive
 * exactly the mutation this file exists to catch.
 *
 * Docker is a PATH shim (a network that inspects as Internal: true), so the
 * suite needs no daemon and the "verified internal" answer is deterministic.
 * The shim fails loudly on any argv it does not expect — a silent `exit 0`
 * stand-in would absorb a changed docker invocation instead of surfacing it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { BRIEFING_MOUNT, renderWorker } from "../../src/config/render.ts";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { readRunWorktrees } from "../../src/run/state.ts";
import { inspectCloneDirt } from "../../src/run/worktree.ts";
import { QUARANTINE_SUFFIX } from "../../src/security/repo-hazards.ts";
// The ISC-56 decoy waits for its own process to become visible to the very
// scan `up` runs, rather than sleeping a hopeful interval — see
// `startDecoyTrainingRun`.
import { checkMlxTrainingGuard } from "../../src/safety/mlx-training-guard.ts";
import { seedGitRepo } from "../fixtures/synthetic-repo.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

/** Unique per test process so a parallel run's shim network never collides. */
const NETWORK = `pifleet-egress-wiring-${process.pid.toString(36)}`;

interface Rig {
  /** Scratch base; everything below lives under it and dies with it. */
  base: string;
  /** PIFLEET_RUNS_DIR. */
  root: string;
  /** The `run.repo` target, seeded with a root AGENTS.md hazard. */
  repo: string;
  configPath: string;
  env: Record<string, string>;
  /** Filled in once `up` succeeds, so afterAll can `down` it. */
  runId: string;
}

const rigs: Rig[] = [];
afterAll(async () => {
  /**
   * Belt and braces, same shape as the e2e suite: a failing test must not
   * leave a detached supervisor outliving the run.
   *
   * The run ids are read off DISK rather than out of `rig.runId`, because the
   * cases that leak are exactly the cases that never set it. `up` launches
   * every supervisor and only then waits for them to go idle, so a worker that
   * dies during startup — or the 60s idle gate — fails after the processes
   * exist and before any run id has been captured, and `if (r.runId !== "")`
   * then skipped the teardown for the one shape that needed it. This suite was
   * observed leaking one supervisor plus its fake-pi child per full run.
   */
  for (const r of rigs) {
    let runIds: string[] = [];
    try {
      runIds = (await readdir(r.root)).filter((e) => !e.startsWith("."));
    } catch {
      // The root never got created; there is nothing running to reap.
    }
    for (const runId of runIds) {
      await runCli(r, ["down", "--run", runId, "--json"]).catch(() => {});
    }
    await rm(r.base, { recursive: true, force: true }).catch(() => {});
  }
}, 120_000);

/**
 * A `docker` that answers `network inspect` with an existing INTERNAL network.
 * `ensureEgressNetwork` then verifies and adopts it without ever reaching
 * `network create` — the deterministic happy path, no daemon required.
 */
async function writeDockerShim(binDir: string): Promise<void> {
  const shim = join(binDir, "docker");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "network inspect")',
      `    printf '[{"Name":"%s","Id":"wiring-shim","Internal":true}]\\n' "$3"`,
      "    ;;",
      '  "network create")',
      "    ;;",
      "  *)",
      '    echo "docker shim: unexpected argv: $*" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
}

/**
 * The account the `gcloud` shim reports. Distinctive on purpose: the ISC-251
 * assertion greps the grant line for this exact string, so any drift between
 * "what gcloud said" and "what `up` printed" is a mismatch, not a maybe.
 */
const SHIM_ACCOUNT = "wiring-shim-operator@example.test";

/**
 * A `gcloud` that answers `config get-value account` with a fixed account.
 * `resolveIdentity` runs exactly that argv — a local config read, no token
 * minting — so this is the whole surface the shim has to cover. Same loud
 * failure on anything else as the docker shim, for the same reason: a silent
 * stand-in would absorb a changed gcloud invocation instead of surfacing it.
 */
async function writeGcloudShim(binDir: string): Promise<void> {
  const shim = join(binDir, "gcloud");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'case "$1 $2 $3" in',
      '  "config get-value account")',
      `    echo "${SHIM_ACCOUNT}"`,
      "    ;;",
      "  *)",
      '    echo "gcloud shim: unexpected argv: $*" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
}

/** Minimal valid fleet.yaml naming the shimmed network and the seeded repo. */
function fleetYaml(
  repo: string,
  opts: {
    cloudAccess?: boolean;
    modelsAllowlist?: string[];
    /** Role named by `eng-1`. A name absent from `roles:` is a config defect. */
    workerRole?: string;
    /** Extra `engineer:` role fields, written into its flow mapping. */
    roleFields?: string[];
    /** `cloud.kubeconfig`; omitted entirely when absent, as the schema default is null. */
    kubeconfig?: string;
    /**
     * The ISC-53 native-tool-call gate. OFF unless a test asks for it — see the
     * comment at the emitted key below for why that default is not laziness.
     */
    requireNativeToolCalls?: boolean;
    /** `llm.base_url`; only the ISC-53 tests set it, at their stub server. */
    llmBaseUrl?: string;
  } = {},
): string {
  const roleFields = [
    ...(opts.cloudAccess === true ? ["cloud_access: true"] : []),
    ...(opts.roleFields ?? []),
  ];
  return [
    "version: 2",
    "name: up-wiring",
    "docker:",
    '  pi_version: "0.79.6"',
    `  network: ${NETWORK}`,
    "run:",
    `  repo: ${repo}`,
    "  budget:",
    "    tokens_ceiling: 1000000",
    ...(opts.kubeconfig === undefined ? [] : ["cloud:", `  kubeconfig: ${opts.kubeconfig}`]),
    "llm:",
    "  model: wiring-test-model",
    ...(opts.llmBaseUrl === undefined ? [] : [`  base_url: ${opts.llmBaseUrl}`]),
    /**
     * OFF by default, and this is the load-bearing line in the fixture.
     *
     * `require_native_tool_calls` defaults to TRUE in the schema, so with this
     * key absent every `up` in this file sends a real `tools`-bearing request
     * to `llm.base_url` — which resolves to `localhost:8000`, a machine-local
     * oMLX that no CI runner has and that serves nothing called
     * `wiring-test-model` even here. Measured: four tests in this file
     * (egress/hazard ordering, the ISC-190 allow case, the ISC-251 grant line,
     * and the §5.5 mount materialization) failed with exit 3 —
     * `ToolCallProbeUnavailableError` — for that reason alone, having nothing
     * to do with what any of them assert.
     *
     * The fix is to state the gate's absence rather than to weaken the gate.
     * These tests are about egress, hazards, credentials and mounts; making
     * them depend on a live inference server would make four unrelated
     * controls untestable without one. Same convention as `models_allowlist`
     * above: the gate stays invisible until a test asks for it, and the tests
     * that DO ask for it (ISC-53, below) point `base_url` at a stub they own,
     * so the criterion is proven against a server whose answers are chosen.
     */
    `  require_native_tool_calls: ${opts.requireNativeToolCalls === true}`,
    // Omitted by default, which is the shape of every other test in this file:
    // an empty allowlist constrains nothing, so the ISC-190 gate stays
    // invisible until a test asks for it.
    ...(opts.modelsAllowlist === undefined
      ? []
      : [`  models_allowlist: [${opts.modelsAllowlist.join(", ")}]`]),
    "roles:",
    `  engineer: {${roleFields.join(", ")}}`,
    "workers:",
    `  - {id: eng-1, role: ${opts.workerRole ?? "engineer"}}`,
    "",
  ].join("\n");
}

async function makeRig(opts: { cloudAccess?: boolean } = {}): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-wiring-"));
  const root = join(base, "runs");
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  await mkdir(root, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeDockerShim(bin);
  // Both shims always: only a cloud_access run invokes gcloud, but a shim
  // that is present regardless means any UNEXPECTED gcloud call from another
  // path fails loudly instead of reaching the developer's real gcloud.
  await writeGcloudShim(bin);
  // The seeded hazard. Root-level AGENTS.md is the instruction-file class the
  // scanner quarantines by rename; one is enough to make the wiring visible.
  await writeFile(join(repo, "AGENTS.md"), "# MANDATORY fixture instructions\n");
  // `run.repo` is a real git repository now, because `isolation: worktree`
  // (the schema default, and what this fixture gets) makes `up` clone one
  // checkout per worker. A plain directory is a config error there, not a
  // degraded mode: the operator asked for a per-worker checkout of something
  // that cannot produce one.
  //
  // SYNTHETIC — `git init` in this test's own scratch dir, seeded with its own
  // commits. Never a clone or worktree of this project's repository: `git
  // clone` from a local path HARDLINKS object files by default, so a fixture
  // built that way shares inodes with the real repo and a test that writes
  // into it writes into the real repo's object store. That is not a
  // hypothetical — it is how the spike behind this feature destroyed a pack
  // file. It is also the same discipline `materialize.test.ts` applies to
  // `skills/`, one layer down.
  await seedGitRepo(repo);
  const configPath = join(base, "fleet.yaml");
  await writeFile(configPath, fleetYaml(repo, opts));
  const rig: Rig = {
    base,
    root,
    repo,
    configPath,
    runId: "",
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}`,
      // The shim shadows the real docker for the CLI and everything it spawns.
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
  };
  rigs.push(rig);
  return rig;
}

async function runCli(
  rig: Rig,
  args: string[],
  opts: { cwd?: string; home?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...rig.env,
      // HOME override pins the ~/.config/pifleet/fleet.yaml fallback to a
      // directory the test controls; without it, implicit config resolution
      // depends on whatever the developer's machine happens to contain.
      ...(opts.home !== undefined ? { HOME: opts.home } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

describe("up wires the security controls, in order (review finding 2)", () => {
  test(
    "egress verification and hazard neutralization both happen, and both precede supervisor launch",
    async () => {
      const rig = await makeRig();
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string };
      rig.runId = parsed.run_id;

      const run = runPaths(rig.runId, rig.root);
      const { records, errors } = await mergeLedger(run);
      expect(errors).toEqual([]);
      // `up`'s own shard only: seq is authoritative order within one writer,
      // and cross-shard timestamp order is explicitly advisory.
      const cliUp = records.filter((r) => r.actor === "cli-up").sort((a, b) => a.seq - b.seq);

      // The egress network was VERIFIED internal — not merely mentioned.
      // `internal: true` can only come from `ensureEgressNetwork`'s return
      // value; with the call deleted the event still appears, with null.
      const egress = cliUp.find((r) => r.event === "egress_network_ready");
      expect(egress).toBeDefined();
      expect(egress!.detail?.["network"]).toBe(NETWORK);
      expect(egress!.detail?.["internal"]).toBe(true);

      // The seeded hazard was found and REPORTED, per the ledger…
      const hazards = cliUp.filter((r) => r.event === "repo_hazard");
      const agentsMd = hazards.find((h) => h.detail?.["kind"] === "agents_md");
      expect(agentsMd).toBeDefined();
      // Reported as NOT neutralized: `config.run.repo` is the operator's own
      // working repository, and `up` only detects there.
      expect(agentsMd!.detail?.["neutralized"]).toBe(false);

      // …and the operator's repository is BYTE-FOR-BYTE UNTOUCHED, which is
      // the part `up` cannot merely claim. Quarantining here renamed the
      // operator's real AGENTS.md aside and commented out their
      // `filter.lfs.*` definitions while leaving `filter.lfs.required = true`,
      // hard-failing every later `git add` on an LFS-tracked path — while
      // defending nothing, because workers read `<repo>/.worktrees/<id>`, not
      // this tree. SRD §12.8 requires this checkout be left unchanged.
      expect(await Bun.file(join(rig.repo, "AGENTS.md")).text()).toContain("MANDATORY");
      expect(await Bun.file(join(rig.repo, `AGENTS.md${QUARANTINE_SUFFIX}`)).exists()).toBe(false);

      // ORDER. Both controls precede the first supervisor launch — a hazard
      // neutralized after the agent starts is not neutralized, and a worker
      // attached to an unverified network was never denied anything.
      const firstSupervisor = cliUp.find((r) => r.event === "supervisor_launched");
      expect(firstSupervisor).toBeDefined();
      expect(egress!.seq).toBeLessThan(firstSupervisor!.seq);
      for (const h of hazards) expect(h.seq).toBeLessThan(firstSupervisor!.seq);

      /**
       * THE regression test for the hazard-neutralization-dirties-every-
       * clone fix. The WORKER's clone gets a SECOND `repo_hazard` event —
       * this one carrying `worker: "eng-1"` and `neutralized: true`, from
       * `neutralizeRepoHazards` running against the clone rather than the
       * operator's checkout. Quarantine is a RENAME of a tracked file,
       * which is real, uncommitted change in `git status --porcelain` the
       * instant it happens — so without `captureWorktreeBaseline`, this
       * exact ordinary fixture (a root `AGENTS.md`, which this project's
       * OWN skill-authoring conventions make common) would leave the clone
       * reading as dirty from the moment `up` finished, before "eng-1" did
       * anything at all, and `down --prune` would refuse it without
       * `--force`.
       */
      const cloneHazard = hazards.find((h) => h.worker === "eng-1" && h.detail?.["kind"] === "agents_md");
      expect(cloneHazard).toBeDefined();
      expect(cloneHazard!.detail?.["neutralized"]).toBe(true);

      const recorded = await readRunWorktrees(run);
      const wt = recorded.byWorker.get("eng-1");
      expect(wt).toBeDefined();
      expect(await Bun.file(join(wt!.path, `AGENTS.md${QUARANTINE_SUFFIX}`)).exists()).toBe(true);
      const dirt = await inspectCloneDirt(wt!);
      expect(dirt).toMatchObject({ dirty: false, statusLines: 0 });
    },
    90_000,
  );

  test(
    "with no config anywhere, up proceeds on defaults — and neither control claims to have run",
    async () => {
      // The other half of finding 1's contract, pinned hermetically: absence
      // is a legitimate Phase 1 shape (refusing would be a regression), and
      // an unconfigured run must not FABRICATE egress or hazard events. cwd
      // and HOME both point at empty directories the test owns, so implicit
      // resolution finds nothing regardless of the developer's machine.
      const rig = await makeRig();
      const cwd = join(rig.base, "empty-cwd");
      await mkdir(cwd, { recursive: true });
      const up = await runCli(
        rig,
        ["up", "--workers", "eng-1", "--backend", "headless", "--json"],
        { cwd, home: cwd },
      );
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
      const events = records.filter((r) => r.actor === "cli-up").map((r) => r.event);
      expect(events).toContain("supervisor_launched");
      expect(events).not.toContain("egress_network_ready");
      expect(events).not.toContain("repo_hazard");
      // And the config-gated controls left the would-be repo alone.
      expect(await Bun.file(join(rig.repo, "AGENTS.md")).exists()).toBe(true);
    },
    90_000,
  );
});

describe("a config that exists but cannot be loaded refuses to start (review finding 1)", () => {
  /**
   * The one-character-typo case from the finding: malformed YAML in an
   * implicitly-discovered ./fleet.yaml. The old bare catch read this as "no
   * config", so the run proceeded with no egress network and no hazard scan
   * and said nothing — an unhardened run indistinguishable from a hardened
   * one. Refusal must be a diagnosis (exit 2, one line), not a stack trace,
   * and nothing may have been launched.
   */
  test("malformed YAML in a discovered ./fleet.yaml exits 2 and launches nothing", async () => {
    const rig = await makeRig();
    const cwd = join(rig.base, "typo-cwd");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "fleet.yaml"), "version: [2\n");
    const up = await runCli(rig, ["up", "--workers", "eng-1", "--backend", "headless"], {
      cwd,
      home: cwd,
    });
    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("refusing to start");
    expect(up.stderr).not.toContain("at async");

    // Nothing launched: the run dir may exist (created before config load),
    // but no supervisor was started and no ledger written.
    for (const runId of await readdir(rig.root)) {
      const run = runPaths(runId, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      expect((await mergeLedger(run)).records).toEqual([]);
    }
  });

  test("a schema-invalid config named by --config exits 2 with the field error", async () => {
    const rig = await makeRig();
    const bad = join(rig.base, "bad-schema.yaml");
    // Valid YAML, invalid document: an unknown key is a field-level error.
    await writeFile(bad, `${fleetYaml(rig.repo)}surprise_key: true\n`);
    const up = await runCli(rig, [
      "up",
      "--config",
      bad,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);
    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("refusing to start");
    expect(up.stderr).toContain("surprise_key");
  });

  test("an explicit --config that does not exist is a refusal, never a defaults fallthrough", async () => {
    const rig = await makeRig();
    const up = await runCli(rig, [
      "up",
      "--config",
      join(rig.base, "nonexistent.yaml"),
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);
    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("config not found");
    // The fallthrough would have started a fleet and printed a run id.
    expect(up.stdout).not.toContain("run ");
  });
});

/**
 * ISC-190 / ISC-52 — `models_allowlist` is enforced on the LAUNCH path.
 *
 * `assertModelAllowed` is unit-tested against the resolver, but the criterion
 * is "a worker whose model is not on the list DOES NOT START", and that is a
 * statement about `up`, not about a pure function. This is the same
 * dead-wiring disease the header of this file describes: the check could be
 * deleted from `up.ts` and every unit test would go on certifying it.
 *
 * So both halves run the real CLI: the refusal must launch nothing, and the
 * permitted model must still bring a fleet up. Asserting only the refusal
 * would be satisfied by a gate that refuses every model there is.
 */
describe("models_allowlist is enforced before any worker starts (ISC-190)", () => {
  test("a model outside the allowlist exits 2 and launches nothing", async () => {
    const rig = await makeRig();
    const gated = join(rig.base, "gated.yaml");
    // `wiring-test-model` is what the worker resolves to; the list names two
    // other models, so the fleet's own default is the thing refused.
    await writeFile(
      gated,
      fleetYaml(rig.repo, { modelsAllowlist: ["probed-model-a", "probed-model-b"] }),
    );
    const up = await runCli(rig, [
      "up",
      "--config",
      gated,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);
    expect(up.code).toBe(EXIT.USAGE);
    // Actionable: the worker, the model it resolved to, and the list it missed.
    expect(up.stderr).toContain("eng-1");
    expect(up.stderr).toContain("wiring-test-model");
    expect(up.stderr).toContain("models_allowlist");
    expect(up.stderr).toContain("probed-model-a");
    // A diagnosis, not a crash.
    expect(up.stderr).not.toContain("at async");
    expect(up.stdout).not.toContain("run ");

    // Nothing started. The run dir is created before the config is read, so it
    // may exist — but no supervisor was launched and no ledger written, which
    // is what "does not start" means.
    for (const runId of await readdir(rig.root)) {
      const run = runPaths(runId, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      expect((await mergeLedger(run)).records).toEqual([]);
    }
  });

  test(
    "a model ON the allowlist still starts normally — the gate is a filter, not a wall",
    async () => {
      const rig = await makeRig();
      const allowed = join(rig.base, "allowed.yaml");
      await writeFile(
        allowed,
        fleetYaml(rig.repo, { modelsAllowlist: ["wiring-test-model", "probed-model-b"] }),
      );
      const up = await runCli(rig, [
        "up",
        "--config",
        allowed,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      // …and the fleet genuinely came up, rather than merely exiting 0.
      const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
      expect(records.map((r) => r.event)).toContain("supervisor_launched");
    },
    90_000,
  );

  /**
   * A worker naming an unknown role is refused BEFORE the run touches
   * anything, allowlist present or not.
   *
   * Two independent guards have to hold for this, and this test pins the
   * outcome they jointly produce rather than either one's internals:
   * `FleetConfigSchema.superRefine` rejects the role at parse time (ISC-68),
   * and the `models_allowlist` loop in `up.ts` no longer swallows a
   * `resolveWorker` failure if it ever gets one. Whichever fires, the operator
   * must get exit 2 naming the role.
   *
   * The last assertion is the load-bearing one. Everything downstream of the
   * pre-flight checks mutates something the operator owns — `detectRepoHazards`
   * QUARANTINES `AGENTS.md` by renaming it in their repository. A config defect
   * must not buy a half-applied run, so the seeded hazard being untouched is
   * how "refused before anything happened" is verified rather than assumed.
   */
  test("a worker naming an unknown role is refused before the repo is touched", async () => {
    const rig = await makeRig();
    const badRole = join(rig.base, "bad-role.yaml");
    await writeFile(
      badRole,
      fleetYaml(rig.repo, {
        workerRole: "no-such-role",
        modelsAllowlist: ["probed-model-a"],
      }),
    );
    const up = await runCli(rig, [
      "up",
      "--config",
      badRole,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);
    expect(up.code).toBe(EXIT.USAGE);
    // Named and pathed at the key the operator has to edit — and NOT misfiled
    // as an allowlist miss, which would send them to the wrong key entirely.
    expect(up.stderr).toContain("unknown role");
    expect(up.stderr).toContain("no-such-role");
    expect(up.stderr).not.toContain("models_allowlist");
    // A diagnosis, not a crash.
    expect(up.stderr).not.toContain("at async");
    expect(up.stdout).not.toContain("run ");

    for (const runId of await readdir(rig.root)) {
      const run = runPaths(runId, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      expect((await mergeLedger(run)).records).toEqual([]);
    }
    // The seeded hazard is still where the operator left it, under its own
    // name — and, now that `up` also CLONES, no per-worker checkout was
    // created either. Listing the whole directory is what makes both claims
    // at once: a `.worktrees` entry or an `AGENTS.md.pifleet-quarantined`
    // would each fail this, and each is a distinct way "refused before
    // anything happened" could stop being true.
    expect((await readdir(rig.repo)).sort()).toEqual([".git", "AGENTS.md", "README.md"]);
  });

  /**
   * …and the skip the bare catch existed to provide is still there. Narrowing
   * it to a membership test must not start refusing a `--workers` id that
   * exists only as a `PIFLEET_PI_COMMAND` double, or this fix trades one
   * wrongly-refused fleet for another.
   */
  test("an id absent from workers: is still skipped, not refused", async () => {
    const rig = await makeRig();
    const gated = join(rig.base, "undefined-id.yaml");
    await writeFile(gated, fleetYaml(rig.repo, { modelsAllowlist: ["probed-model-a"] }));
    const up = await runCli(rig, [
      "up",
      "--config",
      gated,
      "--workers",
      "ghost-1",
      "--backend",
      "headless",
      "--json",
    ]);
    // `eng-1`'s model is NOT on this list, so a loop that checked configured
    // workers rather than the named ones would refuse here. `ghost-1` is not in
    // `workers:` at all, so the allowlist has nothing to say about it.
    expect(up.stderr).not.toContain("models_allowlist");
    expect(up.stderr).not.toContain("unknown role");
  });
});

/**
 * ISC-53 — the native-tool-call gate is enforced on the LAUNCH path.
 *
 * Exactly the disease the header of this file describes, and exactly the shape
 * of the ISC-190 pair above: `probeNativeToolCalls` and
 * `assertModelsSupportToolCalls` are exhaustively unit-tested against an
 * injected fetch, and NOTHING would notice if the call were deleted from
 * `up.ts`. The criterion is "a model that answers a `tools`-bearing probe with
 * prose is refused at `up` with exit 2" — a statement about the CLI process,
 * not about a pure function.
 *
 * The server is a stub this file owns rather than the machine's real oMLX. The
 * failure being certified — a model answering a `tools` request in prose — is a
 * property of a specific model's chat template (§5.9 records it on
 * `Qwen3-8B-4bit`), so it cannot be summoned on demand from whatever models a
 * given host happens to serve. A stub makes the answer chosen, makes both
 * directions testable, and makes the whole suite runnable in CI, which has no
 * inference server at all. The live positive half — a REAL oMLX model emitting
 * a real native call — is proven in `test/integration/model-probe.test.ts`.
 */
interface StubOmlx {
  /** `llm.base_url` for a config that should talk to this stub. */
  baseUrl: string;
  /** Every request received, in order. Empty means the gate never fired. */
  requests: { path: string; body: Record<string, unknown> }[];
  stop: () => Promise<void>;
}

/**
 * An oMLX-shaped HTTP server that answers `/chat/completions` with one canned
 * body.
 *
 * Port 0 — the OS picks a free one. A hardcoded port makes two test files (or
 * two checkouts, or a developer's own oMLX) collide on a machine, and the
 * resulting failure looks like a bug in the gate rather than in the harness.
 */
function stubOmlx(body: unknown, status = 200): StubOmlx {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (await req.json()) as Record<string, unknown>;
      } catch {
        // GET /models and friends carry no body; the path alone is the record.
      }
      requests.push({ path: url.pathname, body: parsed });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** A well-formed native tool call — the shape a compatible model returns. */
const STUB_TOOL_CALL = {
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_wiring", type: "function", function: { name: "pifleet_probe", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

/** The §5.9 failure: tools offered, prose returned. */
const STUB_PROSE = {
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Certainly! I will call the probe tool.", tool_calls: null },
      finish_reason: "stop",
    },
  ],
};

describe("the native-tool-call probe gates the launch path (ISC-53)", () => {
  test("a model that answers the probe with prose exits 2 and launches nothing", async () => {
    const rig = await makeRig();
    const stub = stubOmlx(STUB_PROSE);
    try {
      const gated = join(rig.base, "prose.yaml");
      await writeFile(
        gated,
        fleetYaml(rig.repo, { requireNativeToolCalls: true, llmBaseUrl: stub.baseUrl }),
      );
      const up = await runCli(rig, [
        "up",
        "--config",
        gated,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
      ]);

      // The criterion names the code, so it is asserted and not inferred.
      expect(up.code).toBe(EXIT.USAGE);
      // Actionable: which worker, which model, what went wrong, and the knob.
      expect(up.stderr).toContain("eng-1");
      expect(up.stderr).toContain("wiring-test-model");
      expect(up.stderr).toContain("prose");
      expect(up.stderr).toContain("require_native_tool_calls");
      // A diagnosis, not a crash.
      expect(up.stderr).not.toContain("at async");
      expect(up.stdout).not.toContain("run ");

      // The probe genuinely happened, against the endpoint the config named,
      // carrying tools. Without this the test would also pass if `up` had
      // refused for some unrelated reason that happens to exit 2.
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0]!.path).toBe("/v1/chat/completions");
      expect(Array.isArray(stub.requests[0]!.body["tools"])).toBe(true);

      // Nothing started. The run dir is created before the config is read, so
      // it may exist — no supervisor and no ledger is what "does not start"
      // means, same standard the ISC-190 refusal is held to.
      for (const runId of await readdir(rig.root)) {
        const run = runPaths(runId, rig.root);
        expect(await readdir(run.workersDir)).toEqual([]);
        expect((await mergeLedger(run)).records).toEqual([]);
      }
    } finally {
      await stub.stop();
    }
  });

  test(
    "a model that DOES emit a native call still starts — the gate is a filter, not a wall",
    async () => {
      const rig = await makeRig();
      const stub = stubOmlx(STUB_TOOL_CALL);
      try {
        const ok = join(rig.base, "toolcalls.yaml");
        await writeFile(
          ok,
          fleetYaml(rig.repo, { requireNativeToolCalls: true, llmBaseUrl: stub.baseUrl }),
        );
        const up = await runCli(rig, [
          "up",
          "--config",
          ok,
          "--workers",
          "eng-1",
          "--backend",
          "headless",
          "--json",
        ]);
        expect(up.code).toBe(EXIT.SUCCESS);
        rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

        // The fleet genuinely came up rather than merely exiting 0…
        const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
        expect(records.map((r) => r.event)).toContain("supervisor_launched");
        // …and it came up HAVING been probed. This is the assertion that dies
        // if `assertModelsSupportToolCalls` is deleted from `up.ts`: the exit
        // code above would stay 0 and only this count would fall to zero.
        expect(stub.requests.length).toBe(1);
      } finally {
        await stub.stop();
      }
    },
    90_000,
  );

  /**
   * The exit-code split, end to end. oMLX being down says nothing about the
   * model, so reporting it as a usage error would send an operator to edit a
   * `model:` line that is perfectly correct instead of starting their server.
   */
  test("an unreachable oMLX exits 3, not 2", async () => {
    const rig = await makeRig();
    // Bind and immediately release, so the port is real, free, and — barring a
    // deliberate race — listening to nothing. Picking a constant would risk
    // hitting whatever the developer happens to be running.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${probe.port}/v1`;
    await probe.stop(true);

    const gated = join(rig.base, "dead.yaml");
    await writeFile(
      gated,
      fleetYaml(rig.repo, { requireNativeToolCalls: true, llmBaseUrl: deadUrl }),
    );
    const up = await runCli(rig, [
      "up",
      "--config",
      gated,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);
    expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(up.code).not.toBe(EXIT.USAGE);
    // It must say the server could not be reached, NOT that the model is bad.
    expect(up.stderr).toContain("oMLX");
    expect(up.stderr).not.toContain("prose");
  });

  /** §5.9: `require_native_tool_calls: false` "disables both". */
  test("with the gate off, a prose-answering model starts and is never probed", async () => {
    const rig = await makeRig();
    const stub = stubOmlx(STUB_PROSE);
    try {
      const off = join(rig.base, "gate-off.yaml");
      await writeFile(
        off,
        fleetYaml(rig.repo, { requireNativeToolCalls: false, llmBaseUrl: stub.baseUrl }),
      );
      const up = await runCli(rig, [
        "up",
        "--config",
        off,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
      // Not merely "did not refuse": the network was never touched. This is
      // also what makes the default in `fleetYaml` above honest — every other
      // test in this file really does skip the probe rather than getting lucky.
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 90_000);
});

/**
 * ISC-56 — `up` refuses while an MLX training run is active, unless `--i-know`.
 *
 * The parser is unit-tested from canned `ps` strings; this proves the CLI
 * actually runs it, actually reads the real host process list, and actually
 * refuses. A decoy process supplies the training run: the guard's patterns key
 * on the command line, so a `#!/bin/sh` script NAMED `mlx_lm.lora` produces a
 * genuine `ps` entry of exactly the shape a real `mlx_lm.lora` run has, with no
 * GPU, no model weights, and no way to hurt the host.
 *
 * The script sleeps rather than `exec`ing sleep on purpose: `exec` would
 * REPLACE the argv with `sleep`, the decoy would stop matching, and the test
 * would pass or fail on the guard having nothing to find.
 */
interface Decoy {
  pid: number;
  stop: () => Promise<void>;
}

async function startDecoyTrainingRun(dir: string): Promise<Decoy> {
  const script = join(dir, "mlx_lm.lora");
  await writeFile(script, "#!/bin/sh\nsleep 300\n");
  await chmod(script, 0o755);
  const proc = Bun.spawn([script, "--model", "Qwen3-8B", "--train", "--iters", "600"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  /**
   * Wait for the kernel to publish the argv before returning. `Bun.spawn`
   * resolves once the child exists, which is not the same instant `ps` can see
   * its command line — without this the test races the process table and fails
   * intermittently on a loaded machine, which would look like guard flakiness.
   */
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = await checkMlxTrainingGuard();
    if (found.some((m) => m.pid === proc.pid)) break;
    if (Date.now() > deadline) throw new Error(`decoy pid ${proc.pid} never appeared in ps`);
    await Bun.sleep(50);
  }
  return {
    pid: proc.pid,
    stop: async () => {
      proc.kill("SIGKILL");
      // Reaped, not merely signalled. A zombie keeps its command line in `ps`,
      // so an unreaped decoy would make every LATER `up` in this suite refuse
      // with exit 3 — the worst kind of cross-test contamination, because it
      // lands on files that never mentioned MLX.
      await proc.exited;
    },
  };
}

describe("the MLX training guard gates the launch path (ISC-56)", () => {
  test("an active training run refuses `up`, naming the process and the override", async () => {
    const rig = await makeRig();
    const decoy = await startDecoyTrainingRun(rig.base);
    try {
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
      ]);
      // Not a usage error: the command line is fine, the host is busy.
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("refusing to start");
      expect(up.stderr).toContain(String(decoy.pid));
      expect(up.stderr).toContain("mlx_lm.lora");
      // The escape hatch has to be discoverable from the refusal itself.
      expect(up.stderr).toContain("--i-know");
      expect(up.stderr).not.toContain("at async");

      // The guard runs before the run directory is populated, so nothing at
      // all should have been launched.
      for (const runId of await readdir(rig.root)) {
        const run = runPaths(runId, rig.root);
        expect(await readdir(run.workersDir)).toEqual([]);
        expect((await mergeLedger(run)).records).toEqual([]);
      }
    } finally {
      await decoy.stop();
    }
  });

  test(
    "--i-know proceeds, warns on stderr, and records the override in the ledger",
    async () => {
      const rig = await makeRig();
      const decoy = await startDecoyTrainingRun(rig.base);
      try {
        const up = await runCli(rig, [
          "up",
          "--config",
          rig.configPath,
          "--workers",
          "eng-1",
          "--backend",
          "headless",
          "--i-know",
          "--json",
        ]);
        expect(up.code).toBe(EXIT.SUCCESS);
        rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

        // Overridden, not silent. An operator racing a training run must see it.
        expect(up.stderr).toContain("--i-know overrode");
        expect(up.stderr).toContain(String(decoy.pid));

        /**
         * And the DURABLE half. The stderr warning dies with the scrollback;
         * `report` explaining a panicked host months later has only the run
         * directory to read. Asserting the pid inside the event — rather than
         * the event's mere presence — is what makes this fail if the ledger
         * append is ever reduced to a bare marker.
         */
        const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
        const override = records.find((r) => r.event === "mlx_training_guard_overridden");
        expect(override).toBeDefined();
        const matches = (override!.detail as { matches?: { pid: number }[] }).matches ?? [];
        expect(matches.map((m) => m.pid)).toContain(decoy.pid);
        // It really did start, rather than exiting 0 having done nothing.
        expect(records.map((r) => r.event)).toContain("supervisor_launched");
      } finally {
        await decoy.stop();
      }
    },
    90_000,
  );

  /**
   * The converse, and the one that matters most for day-to-day use: with no
   * training run on the host the guard must be INVISIBLE. A guard that refuses
   * every `up` is not a safety feature, and the obvious over-broad
   * implementation — matching /mlx/ — would do exactly that on any machine
   * running the oMLX inference server this fleet requires.
   */
  test("with no training run active, `up` is unaffected", async () => {
    const rig = await makeRig();
    const up = await runCli(rig, [
      "up",
      "--config",
      rig.configPath,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
      "--json",
    ]);
    expect(up.code).toBe(EXIT.SUCCESS);
    rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
    expect(up.stderr).not.toContain("MLX training");
    const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
    expect(records.map((r) => r.event)).not.toContain("mlx_training_guard_overridden");
  }, 90_000);
});

describe("the grant line names the real ADC identity (ISC-251)", () => {
  /**
   * Same disease as the header describes, third strain. `up` wires
   * `resolveIdentity` into `describeCredentialPlan` so the grant line names
   * the account a worker was actually given — and mutation testing showed
   * that replacing that wiring with `undefined` left the whole suite green.
   * Nothing pinned it, and the failure mode is not even a crash: the line
   * quietly reverts to the `"(adc user)"` placeholder, which is exactly the
   * overclaim the wiring was added to fix. A regression here re-ships a
   * defect while every module test keeps certifying the fix.
   *
   * So: a real `up` run, a `cloud_access: true` worker with no impersonation
   * (the one shape that forces identity resolution), and a `gcloud` PATH shim
   * answering with a known account. The ledger's `credential_plan` line must
   * carry that account verbatim — and must NOT carry the placeholder, because
   * "placeholder absent" is the assertion the mutation actually flips.
   */
  test(
    "a cloud_access worker's credential plan carries the resolved account, never the placeholder",
    async () => {
      const rig = await makeRig({ cloudAccess: true });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      const { records, errors } = await mergeLedger(runPaths(rig.runId, rig.root));
      expect(errors).toEqual([]);
      const plan = records.find(
        (r) => r.actor === "cli-up" && r.event === "credential_plan" && r.worker === "eng-1",
      );
      expect(plan).toBeDefined();
      const line = String(plan!.detail?.["plan"]);
      expect(line).toContain(SHIM_ACCOUNT);
      expect(line).not.toContain("(adc user)");
    },
    90_000,
  );
});

/**
 * Every `-v` source a worker's container would mount EXISTS after `up`, with
 * the right shape (SRD §5.5).
 *
 * Same disease as this file's header describes, fourth strain — and the one
 * where the symptom sits furthest from the cause. A `-v` whose host source is
 * missing does not fail: Docker creates it. A missing directory arrives empty,
 * and a missing FILE arrives as an empty DIRECTORY. So deleting the
 * materialization call from `up.ts` leaves every unit test green and `up`
 * exiting 0, while the damage surfaces an hour later as an agent that ignored
 * its skills and a verbgate that refused everything — both of which read as
 * model behaviour rather than as a mount fault.
 *
 * The assertion is therefore driven FROM render rather than from a hand-written
 * list: `renderWorker` is asked for the argv `up` will run, and every `-v`
 * source in it must be a real path of the right type and mode, or be on a
 * two-entry exemption list. A mount added to `render.ts` later with no writer
 * behind it fails here instead of passing unnoticed.
 *
 * `isolation: none` deliberately: nothing creates a per-worker worktree yet, so
 * a `worktree` fixture would be asserting against unimplemented work.
 */
describe("up materializes every host path its containers would mount (SRD §5.5)", () => {
  /** Container target → what its host source must be; keyed by target, because that is what render decides. */
  const EXPECTED: Record<string, { directory: boolean; mode: number }> = {
    "/outbox": { directory: true, mode: 0o777 },
    "/sessions": { directory: true, mode: 0o777 },
    "/skills": { directory: true, mode: 0o755 },
    // 0444, not 0644: verbgate refuses every verb when its allow file is
    // writable by the uid consulting it, and the macOS VM squashes ownership
    // to the container user — so at 0644 only the `:ro` flag stands between
    // that check and a fleet-wide refusal.
    "/policy/cloud-allow": { directory: false, mode: 0o444 },
    [BRIEFING_MOUNT]: { directory: false, mode: 0o644 },
    "/home/pi/.kube/config": { directory: false, mode: 0o644 },
  };
  /** Not a host path at all — Docker owns this one by construction. */
  const NAMED_VOLUME_TARGET = "/home/pi/.pi/agent";

  test(
    "every -v source exists with the right type and mode, and materialization precedes launch",
    async () => {
      const rig = await makeRig();
      const kubeconfig = join(rig.base, "filtered-kubeconfig");
      await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\n");
      const configPath = join(rig.base, "mounts.yaml");
      await writeFile(
        configPath,
        fleetYaml(rig.repo, {
          kubeconfig,
          roleFields: [
            // No `/workspace` mount at all: the worktree that would back one is
            // not this slice's to create.
            "isolation: none",
            // Forces the kubeconfig mount, the one gated on a compound predicate.
            "cloud_access: true",
            // Inline, so the briefing mount is exercised without a second file.
            'append_system_prompt: "wiring briefing"',
          ],
        }),
      );

      const up = await runCli(rig, [
        "up",
        "--config",
        configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
      const run = runPaths(rig.runId, rig.root);

      /**
       * `renderWorker` resolves its own run dir from `runsRoot()`, the seam
       * `up` was pointed at — so this process has to be pointed at the same one
       * to be asking about the same run.
       */
      const before = process.env["PIFLEET_RUNS_DIR"];
      process.env["PIFLEET_RUNS_DIR"] = rig.root;
      try {
        const loaded = await loadConfig(configPath);
        for (const worker of loaded.config.workers) {
          const r = await renderWorker(loaded, worker.id, { runId: rig.runId });

          const unchecked: string[] = [];
          const seen = new Set<string>();
          for (let i = 0; i < r.docker.length; i++) {
            if (r.docker[i] !== "-v") continue;
            const [source, target] = (r.docker[i + 1] ?? "").split(":");
            if (target === NAMED_VOLUME_TARGET) {
              // A `-v` source with no leading `/` IS a named volume, which is
              // precisely why this one needs no host path.
              expect(source).toBe(`pifleet-piagent-${worker.id}`);
              expect(source!.startsWith("/")).toBe(false);
              continue;
            }
            const want = EXPECTED[target ?? ""];
            if (want === undefined) {
              unchecked.push(`${target} <- ${source}`);
              continue;
            }
            const st = await stat(source!);
            expect(st.isDirectory()).toBe(want.directory);
            expect(st.isFile()).toBe(!want.directory);
            expect(st.mode & 0o777).toBe(want.mode);
            seen.add(target!);
          }
          // A mount this test does not know about is a FAILURE, not a skip: an
          // unwritten source is silent, so "nobody added an assertion" must not
          // be indistinguishable from "there was nothing to assert".
          expect(unchecked).toEqual([]);
          // …and every mount it does know about was actually emitted, so a
          // render that stops emitting one cannot pass by producing less.
          expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());

          /**
           * The one deliberate exemption. `--env-file` is NOT materialized: an
           * empty allow list is semantically correct (deny-all for mutating
           * verbs), while an empty env file is semantically wrong — no
           * `base_url`, no API key — and would fail obscurely inside the
           * container instead of loudly at `docker run`.
           */
          const envFile = r.docker[r.docker.indexOf("--env-file") + 1];
          expect(envFile).toBe(workerPaths(run, worker.id).envFile);
          expect(await Bun.file(envFile!).exists()).toBe(false);
        }
      } finally {
        if (before === undefined) delete process.env["PIFLEET_RUNS_DIR"];
        else process.env["PIFLEET_RUNS_DIR"] = before;
      }

      // ORDER, by the same integer-`seq` technique the rest of this file uses.
      // A mount materialized after its container starts is not materialized.
      const { records, errors } = await mergeLedger(run);
      expect(errors).toEqual([]);
      const cliUp = records.filter((r) => r.actor === "cli-up").sort((a, b) => a.seq - b.seq);
      const materialized = cliUp.find(
        (r) => r.event === "worker_inputs_materialized" && r.worker === "eng-1",
      );
      const supervisor = cliUp.find(
        (r) => r.event === "supervisor_launched" && r.worker === "eng-1",
      );
      expect(materialized).toBeDefined();
      expect(supervisor).toBeDefined();
      expect(materialized!.seq).toBeLessThan(supervisor!.seq);
      // The ledger names WHAT was written, not merely that something was —
      // including the worker's own skill list, which is what diagnoses a
      // bundle/`--skill` divergence after the fact.
      expect(materialized!.detail?.["skills"]).toBe(join(run.root, "skills", "engineer"));
      expect(materialized!.detail?.["skill_names"]).toEqual(["pifleet-worker"]);
      expect(materialized!.detail?.["kubeconfig_source"]).toBe(kubeconfig);
    },
    90_000,
  );
});
