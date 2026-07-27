/**
 * `up`'s security wiring, pinned (review findings 1 and 2).
 *
 * Mutation testing found that deleting the `ensureEgressNetwork` call or the
 * `neutralizeRepoHazards` call from `up.ts` left the entire suite green: both
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
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { QUARANTINE_SUFFIX } from "../../src/security/repo-hazards.ts";

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
  // Belt and braces, same shape as the e2e suite: a failing test must not
  // leave a detached supervisor outliving the run.
  for (const r of rigs) {
    if (r.runId !== "") await runCli(r, ["down", "--run", r.runId, "--json"]).catch(() => {});
    await rm(r.base, { recursive: true, force: true }).catch(() => {});
  }
});

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

/** Minimal valid fleet.yaml naming the shimmed network and the seeded repo. */
function fleetYaml(repo: string): string {
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
    "llm:",
    "  model: wiring-test-model",
    "roles:",
    "  engineer: {}",
    "workers:",
    "  - {id: eng-1, role: engineer}",
    "",
  ].join("\n");
}

async function makeRig(): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-wiring-"));
  const root = join(base, "runs");
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  await mkdir(root, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeDockerShim(bin);
  // The seeded hazard. Root-level AGENTS.md is the instruction-file class the
  // scanner quarantines by rename; one is enough to make the wiring visible.
  await writeFile(join(repo, "AGENTS.md"), "# MANDATORY fixture instructions\n");
  const configPath = join(base, "fleet.yaml");
  await writeFile(configPath, fleetYaml(repo));
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
