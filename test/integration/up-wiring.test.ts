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
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { BRIEFING_MOUNT, renderWorker } from "../../src/config/render.ts";
import { DEFAULT_BRANCH_PREFIX } from "../../src/config/schema.ts";
import { EXIT, type LedgerRecord } from "../../src/contracts.ts";
import { runPaths, workerBranch, workerPaths } from "../../src/run/paths.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { readRunWorktrees } from "../../src/run/state.ts";
import { inspectCloneDirt } from "../../src/run/worktree.ts";
import { QUARANTINE_SUFFIX } from "../../src/security/repo-hazards.ts";
// The ISC-56 decoy waits for its own process to become visible to the very
// scan `up` runs, rather than sleeping a hopeful interval — see
// `startDecoyTrainingRun`.
import { checkMlxTrainingGuard } from "../../src/safety/mlx-training-guard.ts";
import { git, gitOk, seedGitRepo } from "../fixtures/synthetic-repo.ts";
import { cliBudget } from "../support/budget.ts";

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
  /** Where this rig's `gcloud` shim records every argv it was handed. */
  gcloudCalls: string;
  /**
   * This rig's fixture ADC file, pointed at by `GOOGLE_APPLICATION_CREDENTIALS`
   * in `env`. Pinning it is what makes the identity assertions deterministic:
   * `resolveIdentity` reads the ADC principal FIRST and only falls back to the
   * `gcloud config get-value account` shim when the file cannot name one, so
   * without a fixture the behaviour would depend on whether the developer's
   * real ADC happens to carry an `account` field. (Measured: on the machine
   * this was written on, `gcloud auth application-default login` wrote
   * `"account": ""` — present and empty — so the fallback fires. On a machine
   * where it is populated it would not, and an unpinned test would flip.)
   */
  adcFile: string;
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
  // ISC-266 audit: this hook was the one timeout in the file carrying a flat
  // hand-written number (120_000) instead of a derived one, and it had gone
  // UNDER-budgeted. It spawns one `down` per run directory per rig, and every
  // `makeRig` registers a rig (single `rigs.push`, in `makeRig` itself), so the
  // counted upper bound is the number of `makeRig` CALLS — 26 in this file, not
  // estimated. cliBudget(26) = 296_400 ms; the old flat 120_000 was already
  // exceeded by cliBudget(15) = 171_000. Counting rather than estimating is the
  // criterion's own instruction, and this is the case it was written for: the
  // budget silently stopped matching the work as the file grew.
  //
  // Charging every `down` the expensive per-spawn rate is deliberately
  // conservative — rigs whose test never reached `up` contribute zero spawns —
  // because the failure mode here is not a slow suite, it is the one this
  // hook's own docstring above exists to prevent: a timed-out `afterAll`
  // truncates the loop mid-way and leaks detached supervisors onto the
  // developer's machine, which this project has already paid for.
}, cliBudget(26));

/**
 * A `docker` that answers the whole egress surface `up` touches, without a
 * daemon: the internal bridge, the relay's non-internal uplink, and the relay
 * container itself.
 *
 * Two details make it a faithful stand-in rather than a rubber stamp:
 *
 *  1. `network inspect` reports `Internal: true` for every name EXCEPT the
 *     `-uplink` one, which reports false. That is not cosmetic — it is the
 *     exact pair of opposite assertions `ensureEgressNetwork` and
 *     `ensureUplinkNetwork` make, and a shim answering `true` to both would
 *     hide a relay wired onto an internal network that could never reach the
 *     Docker host.
 *  2. `inspect` (container) is STATEFUL via a marker file: "no such object"
 *     until `run` has been called, "running" after. `ensureEgressRelay`
 *     re-inspects after creating, because `docker run -d` exiting 0 means the
 *     container STARTED, not that it stayed up — a shim that reported a
 *     running container before anything ran would absorb that check.
 *
 * Everything else still fails loudly, for the reason the gcloud shim does: a
 * silent `exit 0` stand-in absorbs a changed docker invocation instead of
 * surfacing it.
 */
async function writeDockerShim(binDir: string): Promise<void> {
  const shim = join(binDir, "docker");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      // Marker for "the relay container has been created", per shim dir so
      // parallel rigs never see each other's relay.
      'STATE="$(dirname "$0")/.relay-created"',
      'case "$1" in',
      "  network)",
      '    case "$2" in',
      "      inspect)",
      // The uplink MUST report non-internal or ensureUplinkNetwork refuses it.
      '        case "$3" in',
      "          *-uplink)",
      `            printf '[{"Name":"%s","Id":"wiring-shim-uplink","Internal":false}]\\n' "$3"`,
      "            ;;",
      "          *)",
      `            printf '[{"Name":"%s","Id":"wiring-shim","Internal":true}]\\n' "$3"`,
      "            ;;",
      "        esac",
      "        ;;",
      "      create|connect)",
      "        ;;",
      "      *)",
      '        echo "docker shim: unexpected network argv: $*" >&2',
      "        exit 1",
      "        ;;",
      "    esac",
      "    ;;",
      "  run)",
      // ---------------------------------------------------------------
      // The ISC-260 probe container, stood in for.
      //
      // `up` now issues its native-tool-call probe as
      // `docker run --rm -i --network <egress> <image> node -e <script>`,
      // reading the request off stdin. This shim cannot run a container, so
      // it runs THE SAME SCRIPT on the host through `bun -e`, with stdin
      // piped straight through. The script is production's own text, lifted
      // out of the argv it was about to be handed to Docker in — not a
      // reimplementation that could drift away from it.
      //
      // BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT PROVE. It does NOT
      // prove the probe ran inside the egress network; it cannot, because
      // there is no network here. That claim needs a real daemon and is
      // proven in `test/integration/probe-in-network.test.ts`, which puts a
      // stub oMLX on the bridge where the HOST cannot reach it at all, so a
      // probe issued from the host fails outright. What this file proves is
      // the WIRING: that `up` issues the probe, against the configured
      // endpoint, carrying tools, at the right point in the sequence, and
      // refuses with the right exit code. Deleting
      // `assertModelsSupportToolCalls` from `up.ts` still drops
      // `stub.requests.length` to 0 and turns these tests red, which is the
      // mutation this file has always existed to catch.
      //
      // The `sed` is this stand-in's one liberty, and it stands in for a
      // real mechanism rather than papering over one: on the bridge,
      // `host.docker.internal` resolves to the relay, which forwards to the
      // Docker host. Here it resolves to loopback, where the stub is. The
      // fixture must keep spelling the base URL `host.docker.internal`
      // because `omlxRelayTarget` refuses every other host — so the rewrite
      // lives here, in the Docker stand-in, and NOT in the product, which is
      // the whole point of ISC-260.
      '    case " $* " in',
      '      *" pifleet.probe=native-tool-calls "*)',
      "        script=''",
      "        prev=''",
      '        for a in "$@"; do',
      '          if [ "$prev" = "-e" ]; then script="$a"; fi',
      '          prev="$a"',
      "        done",
      '        if [ -z "$script" ]; then',
      '          echo "docker shim: probe run carried no -e script: $*" >&2',
      "          exit 1",
      "        fi",
      // A missing `bun` would leave stdout empty, which the transport reports
      // as "exited without a readable result" — true, but three steps removed
      // from the cause. Say it here instead.
      "        if ! command -v bun >/dev/null 2>&1; then",
      '          echo "docker shim: bun is not on PATH; cannot stand in for the probe container" >&2',
      "          exit 1",
      "        fi",
      "        sed 's/host\\.docker\\.internal/127.0.0.1/g' | bun -e \"$script\"",
      "        exit $?",
      "        ;;",
      "    esac",
      '    : > "$STATE"',
      '    echo "wiring-shim-relay-id"',
      "    ;;",
      "  inspect)",
      '    if [ -f "$STATE" ]; then',
      `      printf '[{"Name":"/%s","Id":"wiring-shim-relay-id","State":{"Running":true}}]\\n' "$2"`,
      "    else",
      '      echo "Error: No such object: $2" >&2',
      "      exit 1",
      "    fi",
      "    ;;",
      "  rm)",
      '    rm -f "$STATE"',
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
 * The account the fixture ADC FILE names, when a test asks for one.
 *
 * Deliberately unequal to `SHIM_ACCOUNT`, because the two are read out of two
 * different credential stores and the only way to prove the right one was
 * consulted is to make them disagree. On a machine where the operator's
 * `gcloud auth login` and `gcloud auth application-default login` happen to
 * name the same address — the common case, and the case on the machine this
 * was written on — a test using one value could not tell the stores apart.
 */
const ADC_ONLY_ACCOUNT = "wiring-adc-principal@example.test";

/**
 * A `gcloud` that answers `config get-value account` with a fixed account.
 * `resolveIdentity` runs exactly that argv — a local config read, no token
 * minting — so this is the whole surface the shim has to cover. Same loud
 * failure on anything else as the docker shim, for the same reason: a silent
 * stand-in would absorb a changed gcloud invocation instead of surfacing it.
 *
 * It also APPENDS every invocation's argv to `callLog`, one line each, before
 * dispatching. ISC-48's load-bearing claim is a NEGATIVE — an impersonating
 * run never asks the host who the operator is — and a subprocess that was
 * never spawned leaves nothing in stdout, a ledger, or a run dir to assert on.
 * The log is the only place its absence becomes evidence. Recording
 * unconditionally, including on the unexpected-argv branch, makes an empty log
 * mean "no gcloud call of ANY kind", which is strictly stronger than "no
 * account read" and cannot be satisfied by a call this shim failed to classify.
 */
async function writeGcloudShim(binDir: string, callLog: string): Promise<void> {
  const shim = join(binDir, "gcloud");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      // The log path arrives through the ENVIRONMENT, not interpolated into the
      // script body. It used to be single-quoted inline, which breaks outright
      // on any path containing a `'` — and TMPDIR is not ours to constrain, so
      // that was a fixture that would fail on someone else's machine for a
      // reason having nothing to do with the code under test.
      `PIFLEET_SHIM_LOG=${JSON.stringify(callLog)}`,
      // A failed append must be LOUD. ISC-48's load-bearing claim is that the
      // log is EMPTY for an impersonating run, so a shim that silently failed
      // to write would manufacture that evidence — the one failure mode this
      // test cannot tolerate, and the reason the write is checked at all.
      `if ! printf '%s\\n' "$*" >> "$PIFLEET_SHIM_LOG"; then`,
      `  echo "gcloud shim: cannot append to $PIFLEET_SHIM_LOG" >&2`,
      "  exit 90",
      "fi",
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

/**
 * Every gcloud argv this rig's CLI ran, in order. An absent file is a genuine
 * zero rather than a missing observation: `makeRig` installs the shim and
 * points it at this path unconditionally, so "no file" can only mean "the shim
 * never executed".
 */
async function readGcloudCalls(rig: Rig): Promise<string[]> {
  const f = Bun.file(rig.gcloudCalls);
  if (!(await f.exists())) return [];
  return (await f.text()).split("\n").filter((l) => l !== "");
}

/**
 * `up`'s per-worker grant lines, keyed by worker id. Keyed rather than
 * filtered because ISC-49 is a claim about EVERY `cloud_access` worker, and a
 * `find` for one id would pass just as happily on a run that printed a line
 * for one worker and silently skipped the others.
 */
function credentialPlanLines(records: LedgerRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    if (r.actor !== "cli-up" || r.event !== "credential_plan") continue;
    // `String(undefined)` is the string `"undefined"`, which is truthy, has
    // non-zero length, and contains none of the things the ISC-48/49 tests
    // assert are absent — so a record that lost its `plan` field entirely
    // would satisfy every `not.toContain` in this file vacuously while looking
    // like a real line. Assert the type before coercing, so a missing field is
    // a failure here rather than a silent pass three tests away.
    const plan = r.detail?.["plan"];
    expect(typeof plan).toBe("string");
    out.set(r.worker ?? "(unattributed)", plan as string);
  }
  return out;
}

/**
 * Knobs for the fixture config. Every field is optional and every default
 * reproduces the original single-worker, no-`cloud:`-block document, so a call
 * site that asks for nothing gets exactly what it got before.
 */
interface FleetOptions {
  cloudAccess?: boolean;
  modelsAllowlist?: string[];
  /** Role named by `eng-1`. A name absent from `roles:` is a config defect. */
  workerRole?: string;
  /** Extra `engineer:` role fields, written into its flow mapping. */
  roleFields?: string[];
  /** `cloud.kubeconfig`; omitted entirely when absent, as the schema default is null. */
  kubeconfig?: string;
  /**
   * `cloud.impersonate_service_account`. RUN-GLOBAL in this schema, not
   * per-role — which is why ISC-48 compares two separate `up` invocations
   * rather than two roles in one document: there is no config that makes one
   * worker impersonate while its neighbour does not.
   */
  impersonateServiceAccount?: string;
  /** `cloud.quota_project`. */
  quotaProject?: string;
  /** `cloud.adc_mode`; omitted leaves the schema default (`token`). */
  adcMode?: "token" | "file";
  /**
   * Workers beyond `eng-1`. A role name not yet in `roles:` is declared as an
   * empty role; `cloudAccess` is written on the WORKER entry (legal —
   * `WorkerEntrySchema` extends `RoleFieldsSchema`, and `resolveWorker` gives
   * the entry precedence over its role), so each worker's grant is stated at
   * the worker rather than inferred from whichever one declared the role first.
   */
  extraWorkers?: { id: string; role: string; cloudAccess?: boolean }[];
  /**
   * The ISC-53 native-tool-call gate, TRI-STATE on purpose.
   *
   *  - `false` — the key is written, explicitly OFF. Every test in this file
   *    that is not about ISC-53 passes this, and passing it explicitly is the
   *    point: the fixture STATES the gate's absence.
   *  - `true` — written on. The ISC-53 tests pass this and point `llmBaseUrl`
   *    at a stub they own.
   *  - OMITTED — no key at all, which is what a real operator's fleet.yaml
   *    looks like, and the only shape that exercises the SCHEMA DEFAULT.
   */
  requireNativeToolCalls?: boolean;
  /** `llm.base_url`; only the ISC-53 tests set it, at their stub server. */
  llmBaseUrl?: string;
  /**
   * The `account` field written into this rig's fixture ADC file.
   *
   * Default `""` — present but empty, which is the shape `gcloud auth
   * application-default login` actually produced on the machine this was
   * written on, and which forces `resolveIdentity` down to its documented
   * `gcloud config get-value account` fallback (the shim, i.e. SHIM_ACCOUNT).
   * Every pre-existing test wants that, because it is what they were written
   * against.
   *
   * Set it to a real address to exercise the OTHER branch: the ADC file naming
   * its own principal, which must then WIN over the config account. Those are
   * two different credential stores and the grant line has to name the one the
   * token is minted from.
   */
  adcAccount?: string;
}

/** Minimal valid fleet.yaml naming the shimmed network and the seeded repo. */
function fleetYaml(repo: string, opts: FleetOptions = {}): string {
  const roleFields = [
    ...(opts.cloudAccess === true ? ["cloud_access: true"] : []),
    ...(opts.roleFields ?? []),
  ];
  /**
   * `cloud:` is emitted only when some field asks for it. `CloudSchema` is
   * `prefault({})`, so an absent block and an empty one are the same document
   * — but writing the key unconditionally would change the fixture every other
   * test in this file loads, for no gain.
   */
  const cloudFields = [
    ...(opts.kubeconfig === undefined ? [] : [`  kubeconfig: ${opts.kubeconfig}`]),
    ...(opts.adcMode === undefined ? [] : [`  adc_mode: ${opts.adcMode}`]),
    ...(opts.quotaProject === undefined ? [] : [`  quota_project: ${opts.quotaProject}`]),
    ...(opts.impersonateServiceAccount === undefined
      ? []
      : [`  impersonate_service_account: ${opts.impersonateServiceAccount}`]),
  ];
  const extraWorkers = opts.extraWorkers ?? [];
  // Distinct role names the extra workers introduce; `engineer` is already
  // declared above with the fixture's own fields.
  const extraRoles = [...new Set(extraWorkers.map((w) => w.role))].filter((r) => r !== "engineer");
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
    ...(cloudFields.length === 0 ? [] : ["cloud:", ...cloudFields]),
    "llm:",
    "  model: wiring-test-model",
    ...(opts.llmBaseUrl === undefined ? [] : [`  base_url: ${opts.llmBaseUrl}`]),
    /**
     * Written only when a caller has an opinion — the same convention
     * `models_allowlist` uses below, and the reason for it is the same.
     *
     * `require_native_tool_calls` defaults to TRUE in the schema, so with this
     * key absent every `up` in this file sends a real `tools`-bearing request
     * to `llm.base_url` — which resolves to `localhost:8000`, a machine-local
     * oMLX that no CI runner has and that serves nothing called
     * `wiring-test-model` even here. Measured: four tests in this file
     * (egress/hazard ordering, the ISC-190 allow case, the ISC-251 grant line,
     * and the §5.5 mount materialization) failed with exit 3 —
     * `ToolCallProbeUnavailableError` — for that reason alone, having nothing
     * to do with what any of them assert. So those tests state
     * `requireNativeToolCalls: false` and mean it. Making four unrelated
     * controls depend on a live inference server would be weakening the gate by
     * another route.
     *
     * What this spelling FIXES: the key used to be emitted unconditionally as
     * `${opts.requireNativeToolCalls === true}`, so `false` was written even
     * when no caller asked for it and no config in this file ever omitted the
     * key. The schema's own default was therefore never proven to reach the
     * CLI — flipping `require_native_tool_calls` to `false` in
     * `config/schema.ts` left this entire file green, on a gate SRD §5.9 calls
     * mandatory. `the gate is ON by default` below is the test that closes it.
     */
    ...(opts.requireNativeToolCalls === undefined
      ? []
      : [`  require_native_tool_calls: ${opts.requireNativeToolCalls}`]),
    // Omitted by default, which is the shape of every other test in this file:
    // an empty allowlist constrains nothing, so the ISC-190 gate stays
    // invisible until a test asks for it.
    ...(opts.modelsAllowlist === undefined
      ? []
      : [`  models_allowlist: [${opts.modelsAllowlist.join(", ")}]`]),
    "roles:",
    `  engineer: {${roleFields.join(", ")}}`,
    ...extraRoles.map((r) => `  ${r}: {}`),
    "workers:",
    `  - {id: eng-1, role: ${opts.workerRole ?? "engineer"}}`,
    ...extraWorkers.map(
      (w) =>
        `  - {id: ${w.id}, role: ${w.role}` +
        `${w.cloudAccess === undefined ? "" : `, cloud_access: ${w.cloudAccess}`}}`,
    ),
    "",
  ].join("\n");
}

async function makeRig(opts: FleetOptions = {}): Promise<Rig> {
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
  //
  // The call log is per-rig — one scratch dir per `makeRig`, and `makeRig` is
  // called once per fixture — so a zero read by one test can never be another
  // test's run having not written yet, nor another test's calls be mistaken
  // for this one's.
  const gcloudCalls = join(base, "gcloud-calls.log");
  await writeGcloudShim(bin, gcloudCalls);
  /**
   * The fixture ADC file. Written for EVERY rig, not only the cloud ones, for
   * the same reason both shims are installed unconditionally: the developer's
   * real `~/.config/gcloud/application_default_credentials.json` must never be
   * what a test happens to read. `GOOGLE_APPLICATION_CREDENTIALS` is gcloud's
   * own override for the ADC location and `hostAdcFile()` honours it, so this
   * redirects production's lookup rather than reaching past it through a
   * test-only seam.
   *
   * It is NOT a credential and grants nothing — the refresh_token is a literal
   * marker string. It exists so `resolveIdentity` has a deterministic file to
   * read.
   */
  const adcFile = join(base, "adc.json");
  await writeFile(
    adcFile,
    JSON.stringify({
      type: "authorized_user",
      account: opts.adcAccount ?? "",
      client_id: "fixture.apps.googleusercontent.com",
      client_secret: "fixture-not-a-real-secret",
      refresh_token: "1//fixture-not-a-real-token",
    }),
  );
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
  await writeFile(configPath, fleetYaml(repo, { requireNativeToolCalls: false, ...opts }));
  const rig: Rig = {
    base,
    root,
    repo,
    configPath,
    gcloudCalls,
    adcFile,
    runId: "",
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}`,
      // The shim shadows the real docker for the CLI and everything it spawns.
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      // Pins whose ADC `resolveIdentity` reads. See `Rig.adcFile`.
      GOOGLE_APPLICATION_CREDENTIALS: adcFile,
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

      // …and the relay that reopens the oMLX endpoint through it was ensured
      // too. Without it the bridge denies the fleet its own model server, and
      // every worker starts healthy and accomplishes nothing (SRD §5.9).
      const relay = cliUp.find((r) => r.event === "egress_relay_ready");
      expect(relay).toBeDefined();
      expect(relay!.detail?.["name"]).toBe(`pifleet-egress-relay-${NETWORK}`);
      // Ordering is the same requirement the hazard assertions below carry: a
      // relay ensured after the supervisors launch is a relay the first turns
      // could not use.
      expect(relay!.seq).toBeGreaterThan(egress!.seq);

      /**
       * The ledger is `up`'s CLAIM; the shim's marker file is the FACT.
       *
       * This assertion exists because the obvious one does not work. Deleting
       * the `ensureEgressRelay` call and leaving the ledger append behind was
       * measured to keep every detail-field assertion above green — `name` is
       * derivable from the network name and `created: true` is just a boolean
       * — which is the exact failure mode this file's header describes for
       * `egress_network_ready`. `ensureEgressNetwork` had `internal: true` to
       * pin it with; `ensureEgressRelay` has no comparable value in its
       * return, so the proof has to come from outside the ledger.
       *
       * The shim writes this marker only from its `run` branch, so the file
       * existing means a real `docker run` argv was built and executed.
       */
      expect(await Bun.file(join(rig.base, "bin", ".relay-created")).exists()).toBe(true);

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
    // ISC-266 audit: stands. One `up` spawn derives cliBudget(1) = 11_400 ms;
    // measured idle is 1264-1273 ms. Not reduced.
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
      // The relay is gated on the same config as the network it attaches to:
      // with no config there is no egress network, so relaying onto one would
      // be meaningless — and creating a durable container anyway would be a
      // side effect of running `up` in an empty directory.
      expect(events).not.toContain("egress_relay_ready");
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
    const runIds = await readdir(rig.root);
    // Non-vacuous: `up` mkdirs the run directory before it reads the config, so
    // the refusals below happen with the directory already on disk. Without
    // this line the loop body could simply never execute and the assertions
    // would pass by not running.
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds) {
      const run = runPaths(runId, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      expect((await mergeLedger(run)).records).toEqual([]);
    }
  });

  test("a schema-invalid config named by --config exits 2 with the field error", async () => {
    const rig = await makeRig();
    const bad = join(rig.base, "bad-schema.yaml");
    // Valid YAML, invalid document: an unknown key is a field-level error.
    await writeFile(bad, `${fleetYaml(rig.repo, { requireNativeToolCalls: false })}surprise_key: true\n`);
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
      fleetYaml(rig.repo, {
        requireNativeToolCalls: false,
        modelsAllowlist: ["probed-model-a", "probed-model-b"],
      }),
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
    const runIds = await readdir(rig.root);
    // Non-vacuous: `up` mkdirs the run directory before it reads the config, so
    // the refusals below happen with the directory already on disk. Without
    // this line the loop body could simply never execute and the assertions
    // would pass by not running.
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds) {
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
        fleetYaml(rig.repo, {
          requireNativeToolCalls: false,
          modelsAllowlist: ["wiring-test-model", "probed-model-b"],
        }),
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
        requireNativeToolCalls: false,
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

    const runIds = await readdir(rig.root);
    // Non-vacuous: `up` mkdirs the run directory before it reads the config, so
    // the refusals below happen with the directory already on disk. Without
    // this line the loop body could simply never execute and the assertions
    // would pass by not running.
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds) {
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
    await writeFile(
      gated,
      fleetYaml(rig.repo, {
        requireNativeToolCalls: false,
        modelsAllowlist: ["probed-model-a"],
      }),
    );
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
    /**
     * Named `host.docker.internal`, NOT `127.0.0.1`, though the stub binds
     * loopback. The reason has changed since this comment was last written,
     * and the new one is simpler.
     *
     * It used to be a coincidence that had to be explained: the ISC-53 gate
     * probed from the HOST through `hostFacingBaseUrl`, which rewrote the
     * hostname and preserved the port, while the relay demanded the literal
     * `host.docker.internal` — and this one spelling happened to satisfy
     * both. That rewrite is gone (ISC-260); the product transforms
     * `llm.base_url` in no way at all.
     *
     * So there is now ONE requirement, not two: `omlxRelayTarget` accepts
     * `host.docker.internal` and refuses every other host, because it is the
     * only name the deny-all bridge resolves. This fixture writes the URL a
     * real fleet.yaml writes, and the probe dials it verbatim exactly as a
     * worker would.
     *
     * Reaching the loopback stub from there is the docker SHIM's problem, and
     * it is solved where a topology problem belongs — see the probe branch in
     * `writeDockerShim`. In production the same hop is real: the bridge
     * resolves the name to the relay, and the relay forwards to the host.
     */
    baseUrl: `http://host.docker.internal:${server.port}/v1`,
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
      const runIds = await readdir(rig.root);
      // Non-vacuous — see the identical guard above.
      expect(runIds.length).toBeGreaterThan(0);
      for (const runId of runIds) {
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
    /**
     * Spelled `host.docker.internal`, and it has to be, which is a
     * consequence of the ISC-260 reordering worth stating.
     *
     * This URL used to be `127.0.0.1:<port>` and reached the probe first,
     * because the probe used to run BEFORE the relay was built. The probe now
     * runs from inside the egress network, so it cannot run until that
     * network and its relay exist — and `omlxRelayTarget` refuses any host
     * but `host.docker.internal`. A loopback spelling now fails at the RELAY
     * with exit 3 and a message about `llm.base_url`, which is the same exit
     * code for an entirely different reason: the test would still be green
     * while no longer testing the probe at all.
     *
     * With this spelling the relay accepts it, the probe runs, the shim
     * rewrites it to the dead loopback port, and the connection is refused —
     * which is the failure this test is actually about.
     */
    const deadUrl = `http://host.docker.internal:${probe.port}/v1`;
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

  /**
   * The gate is ON when nobody says otherwise — the shape a real fleet.yaml has.
   *
   * Every other test in this file writes `require_native_tool_calls`
   * explicitly, and the fixture used to emit the key unconditionally, so no
   * config anywhere ever OMITTED it. §5.9 calls this gate mandatory, and the
   * schema encodes that as `.default(true)` — but nothing proved that default
   * survived the trip through `parseConfig` into `up`. Flipping it to `false`
   * in `config/schema.ts` left the whole file green, which is a mandatory
   * control held in place by nothing at all.
   *
   * So: no key, a stub that answers in prose, and the refusal must still
   * happen. `stub.requests.length` is the load-bearing assertion — an exit 2
   * from some unrelated cause would satisfy the code alone.
   */
  test("the gate is ON by default, with no key in fleet.yaml at all", async () => {
    const rig = await makeRig();
    const stub = stubOmlx(STUB_PROSE);
    try {
      const defaulted = join(rig.base, "no-gate-key.yaml");
      // requireNativeToolCalls deliberately absent — see `fleetYaml`.
      const yaml = fleetYaml(rig.repo, { llmBaseUrl: stub.baseUrl });
      expect(yaml).not.toContain("require_native_tool_calls");
      await writeFile(defaulted, yaml);

      const up = await runCli(rig, [
        "up",
        "--config",
        defaulted,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
      ]);

      expect(up.code).toBe(EXIT.USAGE);
      expect(up.stderr).toContain("prose");
      // The probe genuinely fired, from a config that never mentioned it.
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0]!.path).toBe("/v1/chat/completions");
    } finally {
      await stub.stop();
    }
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
  /**
   * 30s, not 300. `stop()` reaps this in a `finally`, but a SIGKILLed test RUN
   * never reaches it — and an orphan named `mlx_lm.lora` makes the ISC-56 guard
   * refuse every `up` on the developer's own machine until it exits. Five
   * minutes of that is a self-inflicted outage on the host this project is
   * developed on; 30s still outlives every test in this file.
   */
  await writeFile(script, "#!/bin/sh\nsleep 30\n");
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

      /**
       * A STRONGER claim than the other refusals in this file, and the
       * difference is real rather than stylistic.
       *
       * The ISC-53 and ISC-190 gates read the config, which `up` does only
       * AFTER it has created the run directory — so their "launches nothing"
       * assertion is about an existing directory being empty. The MLX guard
       * runs earlier still, before that mkdir, so a refusal here must leave the
       * runs root with no run directory in it at all.
       *
       * This was previously written as the same `for (const runId of await
       * readdir(rig.root))` loop the others use. That loop iterated zero times
       * here, so it asserted nothing whatsoever — the exact vacuity the review
       * flagged, and it only became visible once the loop was required to be
       * non-empty.
       */
      expect(await readdir(rig.root)).toEqual([]);
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
      /**
       * …and the mode this fixture never mentions is named as `token`.
       *
       * `adc_mode` is absent from this config, so `token` here is the SCHEMA
       * DEFAULT arriving intact through `planCredential` — the half of ISC-49's
       * "prints the ADC mode" that an explicit `adc_mode:` fixture cannot
       * check, because an explicit value would still print if the default were
       * broken. The ISC-49 case below sets `file` and asserts the same field;
       * between them both modes are exercised, which is what makes the line a
       * report of the mode rather than a constant that happens to read right.
       */
      expect(line).toContain("token mode");
    },
    90_000,
  );

  /**
   * The grant line must name the identity from the store the TOKEN IS MINTED
   * FROM — and that is ADC, not `gcloud config get-value account`.
   *
   * These are two different stores. `gcloud auth login` writes the config
   * account; `gcloud auth application-default login` writes ADC. They
   * routinely differ: an operator who logged in as one account and ran the ADC
   * login as another has two perfectly valid, unequal answers on one machine.
   * `mintArgv` mints with `gcloud auth application-default print-access-token`
   * and `file` mode hands over `application_default_credentials.json`, so in
   * BOTH modes the granted identity is ADC's — yet `resolveIdentity` read only
   * the config account, and the test above pinned `SHIM_ACCOUNT` (the config
   * account) as correct. The suite was therefore asserting that a possibly
   * wrong identity was the right one.
   *
   * The fixture makes the two stores DISAGREE on purpose, which is the only
   * arrangement that can tell them apart: the ADC file names
   * `ADC_ONLY_ACCOUNT`, the shim answers `SHIM_ACCOUNT`. The line must carry
   * the first and not the second. On a fixture where the two matched, this
   * test would pass under either implementation and prove nothing — which is
   * exactly why the defect survived: on the machine this was written on, the
   * operator's two stores happen to name the same address.
   *
   * Mutation check: reverting `resolveIdentity` to read the config account
   * first turns this red on `not.toContain(SHIM_ACCOUNT)` while leaving every
   * other test in this file green — which is why this is a separate case
   * rather than an extra assertion on the test above.
   */
  test(
    "the ADC file's own principal wins over the gcloud config account",
    async () => {
      const rig = await makeRig({ cloudAccess: true, adcAccount: ADC_ONLY_ACCOUNT });
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
      const line = credentialPlanLines(records).get("eng-1");
      expect(line).toBeDefined();
      expect(line).toContain(ADC_ONLY_ACCOUNT);
      // THE assertion: the other store's answer must not appear. Both are
      // valid-looking addresses, so only their difference distinguishes a
      // correct resolution from a plausible one.
      expect(line).not.toContain(SHIM_ACCOUNT);
      expect(line).not.toContain("(adc user)");

      // …and the config account was never even asked for, because ADC answered
      // offline. Stronger than "the line does not mention it", and the same
      // shape of evidence ISC-48 relies on.
      expect(await readGcloudCalls(rig)).toEqual([]);
    },
    90_000,
  );
});

/**
 * ISC-48 — "with `impersonate_service_account` set, the token's identity is
 * the SA, not the launching user's account."
 *
 * Two claims live in that sentence and only one of them is positive. The
 * positive one — the grant line names the SA — is cheap, and a wrong
 * implementation could still satisfy it by naming the SA while ALSO reading
 * and minting for the operator. The negative one is the security property:
 * "not the launching user's account" means the launching user's account is not
 * merely unprinted but never consulted, because a run that resolves the
 * operator's identity has already reached for the credential the SA exists to
 * avoid, and would mint against it the moment Phase 1's planning became a mint.
 *
 * `up` gets that right by construction — `describeCredentialPlan` reads
 * `plan.impersonateServiceAccount` directly, and the `resolveIdentity` call is
 * guarded on some plan having NO impersonation — but "by construction" is
 * exactly the kind of correctness that a later refactor drops without a single
 * test going red. Mutating that guard to `plans.some((p) => p.plan.kind ===
 * "inject")` leaves every grant line byte-identical, because the resolved
 * account is then computed and thrown away. Nothing downstream changes. Only
 * the subprocess count does.
 *
 * So the assertion is on the subprocess count, and the control half is in the
 * same test on purpose: an empty call log proves nothing unless the same shim,
 * written by the same function, is shown recording a call when one is made.
 * Without it a typo in the log path would pass this test forever.
 */
describe("impersonation replaces the launching user's identity outright (ISC-48)", () => {
  /** Plausibly shaped and obviously synthetic; no such project exists. */
  const SERVICE_ACCOUNT = "deploy-bot@pifleet-test.iam.gserviceaccount.com";

  test(
    "every worker's grant names the SA, and the operator's own account is never read",
    async () => {
      // Impersonating: BOTH workers have cloud access, and `cloud:` is
      // run-global, so this is a run in which no worker's plan can want the
      // ADC user — the shape under which the guard must skip resolution.
      const impersonating = await makeRig({
        cloudAccess: true,
        impersonateServiceAccount: SERVICE_ACCOUNT,
        extraWorkers: [{ id: "eng-2", role: "engineer" }],
      });

      /**
       * Before anything else: prove THIS rig's log records what it is given.
       *
       * The whole test rests on an empty log, and that zero has to be a
       * MEASUREMENT rather than an absence of measuring. The control at the
       * bottom is a DIFFERENT rig — its own `mkdtemp` base, its own
       * `gcloudCalls` path, its own shim install — so any failure confined to
       * this one (shim not written, `bin` missing from PATH, PATH ordering
       * putting the real gcloud first, the log's directory gone) yields an
       * empty log here and a green test. That is exactly the hazard the
       * control is supposed to have closed, and a control in another rig
       * cannot speak for this one.
       *
       * So: one throwaway call through THIS rig's PATH, assert it landed in
       * THIS rig's log, then truncate and let `up` write into a log now known
       * to work. The verb is deliberately one the shim does not recognise,
       * which also exercises the unexpected-argv branch that records
       * unconditionally — making an empty log mean "no gcloud call of ANY
       * kind", not merely "no account read".
       */
      const probe = Bun.spawnSync(["gcloud", "pifleet-shim-liveness-probe"], {
        env: { ...process.env, ...impersonating.env },
      });
      // The shim's unexpected-argv branch exits 1. 90 would be its "cannot
      // append" path and 127 would mean it was never on PATH at all — both are
      // the silent-empty-log failure this probe exists to convert into a red.
      expect(probe.exitCode).toBe(1);
      expect(await readGcloudCalls(impersonating)).toEqual(["pifleet-shim-liveness-probe"]);
      await writeFile(impersonating.gcloudCalls, "");
      expect(await readGcloudCalls(impersonating)).toEqual([]);

      const up = await runCli(impersonating, [
        "up",
        "--config",
        impersonating.configPath,
        "--workers",
        "eng-1,eng-2",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      impersonating.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      const merged = await mergeLedger(runPaths(impersonating.runId, impersonating.root));
      expect(merged.errors).toEqual([]);
      const lines = credentialPlanLines(merged.records);
      // Every worker got a line — not just the one an assertion happened to ask
      // about.
      expect([...lines.keys()].sort()).toEqual(["eng-1", "eng-2"]);
      for (const [worker, line] of lines) {
        expect(`${worker}: ${line}`).toContain(SERVICE_ACCOUNT);
        // The identity is the SA INSTEAD OF the operator's, not alongside it.
        expect(line).not.toContain(SHIM_ACCOUNT);
        // …and not the placeholder either, which would be a different way of
        // failing to name the SA.
        expect(line).not.toContain("(adc user)");
      }

      // THE assertion. Not "the account is absent from the line" — that
      // survives the mutation — but "nothing ever asked the host for it".
      // Meaningful because the liveness probe above already proved THIS rig's
      // log records what it is given.
      expect(await readGcloudCalls(impersonating)).toEqual([]);

      // Control: the same shim, the same fixture, impersonation removed. This
      // is what makes the zero above evidence rather than an artefact of a log
      // nothing could ever write to.
      const asOperator = await makeRig({ cloudAccess: true });
      const plainUp = await runCli(asOperator, [
        "up",
        "--config",
        asOperator.configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(plainUp.code).toBe(EXIT.SUCCESS);
      asOperator.runId = (JSON.parse(plainUp.stdout.trim()) as { run_id: string }).run_id;
      // Exactly one call: the log is live, AND the resolution is memoized
      // across the run rather than re-shelled per worker.
      expect(await readGcloudCalls(asOperator)).toEqual(["config get-value account"]);
    },
    // ISC-266 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 2581-2732 ms. Not reduced.
    120_000,
  );
});

/**
 * ISC-49 — "`up` prints the granted identity, project, and ADC mode for every
 * `cloud_access` worker."
 *
 * Three nouns and a quantifier, and the quantifier is the part that fails
 * quietly. `describeCredentialPlan` assembles all three into one line, so a
 * test that inspects a single worker is really only testing the formatter that
 * `adc.test.ts` already owns. What `up` adds is the loop: one line PER NAMED
 * WORKER, including the ones that got nothing. A regression that planned only
 * the first worker, or only the cloud ones, or resolved a per-worker identity
 * and let a later worker overwrite an earlier one's line, leaves the formatter
 * untouched and every unit test green.
 *
 * So: three workers over two roles, and every line is read back by id. The
 * `cloud_access: false` worker is not a control decoration — SRD §5.8 makes
 * "this worker has no credential" a statement the run is required to make, so
 * its line is as load-bearing as the other two, and it must not carry an
 * identity, a project, or a mode it was never granted.
 *
 * `adc_mode: file` deliberately, against the schema default: the ISC-251 case
 * above pins `token` arriving from the default, and a suite that only ever ran
 * the default could not tell "prints the mode" from "prints the word token".
 */
describe("up states the grant for every worker, cloud or not (ISC-49)", () => {
  const QUOTA_PROJECT = "pifleet-test-project-49";

  test(
    "identity, project and mode appear per cloud worker — and none of them for a worker without cloud access",
    async () => {
      const rig = await makeRig({
        // `engineer` carries the grant; `eng-1` and `eng-2` inherit it.
        cloudAccess: true,
        adcMode: "file",
        quotaProject: QUOTA_PROJECT,
        extraWorkers: [
          { id: "eng-2", role: "engineer" },
          // A second role with no grant at all, and the denial restated on the
          // worker so the fixture says what it means rather than relying on the
          // reader knowing `cloud_access` defaults to false.
          { id: "quiet-1", role: "scribe", cloudAccess: false },
        ],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,eng-2,quiet-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      const { records, errors } = await mergeLedger(runPaths(rig.runId, rig.root));
      expect(errors).toEqual([]);
      const lines = credentialPlanLines(records);
      // EVERY named worker, not merely the cloud ones: the §5.8 requirement is
      // that the grant is never silent, and silence about a worker that got
      // nothing is still silence.
      expect([...lines.keys()].sort()).toEqual(["eng-1", "eng-2", "quiet-1"]);

      for (const workerId of ["eng-1", "eng-2"]) {
        const line = lines.get(workerId)!;
        // Identity — the account the gcloud shim reported, not the placeholder.
        expect(line).toContain(SHIM_ACCOUNT);
        expect(line).not.toContain("(adc user)");
        // Project — the distinctive fixture value, so a hard-coded or inherited
        // project cannot pass.
        expect(line).toContain(QUOTA_PROJECT);
        expect(line).not.toContain("(no quota project)");
        // Mode — the configured `file`, NOT the schema default the sibling test
        // pins. A line that ignored `cloud.adc_mode` would say `token mode`.
        expect(line).toContain("file mode");
        expect(line).not.toContain("token mode");
      }

      /**
       * The worker that was granted nothing says so, and says nothing else. If
       * this line ever carried the identity or the project, an operator
       * auditing the run would read a grant into a worker that has none — the
       * precise inverse of the failure §5.8's "never silent" rule exists to
       * prevent, and harder to notice, because it reads like a normal line.
       */
      const quiet = lines.get("quiet-1")!;
      expect(quiet).toContain("no credential");
      expect(quiet).toContain("cloud_access: false");
      expect(quiet).not.toContain(SHIM_ACCOUNT);
      expect(quiet).not.toContain(QUOTA_PROJECT);
      expect(quiet).not.toContain("file mode");
      expect(quiet).not.toContain("token mode");

      // And the identity really was resolved once for the whole run, not once
      // per cloud worker — two cloud workers, one subprocess.
      expect(await readGcloudCalls(rig)).toEqual(["config get-value account"]);
    },
    // ISC-266 audit: stands. One `up` spawn derives cliBudget(1) = 11_400 ms;
    // measured idle is 1692-1773 ms. Not reduced.
    120_000,
  );

  /**
   * …and the same lines reach the OPERATOR, not only the ledger.
   *
   * §5.8 says `pifleet up` PRINTS the grant. The ledger append and the
   * `process.stdout.write` are two separate statements guarded by
   * `opts.json !== true`, so deleting the print leaves every ledger assertion
   * above green while the human-facing half — the only half an operator
   * running `up` by hand ever sees — is gone.
   */
  test(
    "without --json the grant lines are printed on stdout, one per worker",
    async () => {
      const rig = await makeRig({
        cloudAccess: true,
        adcMode: "file",
        quotaProject: QUOTA_PROJECT,
        extraWorkers: [{ id: "quiet-1", role: "scribe", cloudAccess: false }],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,quiet-1",
        "--backend",
        "headless",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      // Recovered from disk rather than stdout, because this run prints prose.
      const [runId] = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
      rig.runId = runId ?? "";

      expect(up.stdout).toContain(`eng-1: google: file mode as ${SHIM_ACCOUNT}, project ${QUOTA_PROJECT}`);
      expect(up.stdout).toContain("quiet-1: google: no credential (cloud_access: false)");
    },
    // ISC-266 audit: stands. One `up` spawn derives cliBudget(1) = 11_400 ms;
    // measured idle is 1446-1533 ms. Not reduced.
    120_000,
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
          requireNativeToolCalls: false,
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

/**
 * ISC-119 — a hostile repository changes nothing about the run.
 *
 * `test/integration/hostile-repo.test.ts` proves the SCANNER: hand it a seeded
 * tree and every payload class is detected, quarantined, and demonstrably does
 * not fire. What it cannot prove is that the thing a WORKER actually opens has
 * been through that scanner, because it never creates one — it calls
 * `neutralizeRepoHazards` directly on the seeded tree, and no run exists in
 * that file at all (its own header says so).
 *
 * That gap was not theoretical. A worker mounts `<repo>/.worktrees/<id>` at
 * `/workspace`, which is a CLONE — so it carries the TRACKED hazards
 * (`AGENTS.md`, `.pi/extensions/`) and none of the untracked ones
 * (`.git/config` keys, `.git/hooks/`), an entirely different hazard profile
 * from the tree the scanner suite exercises. Before this test the only
 * clone-side assertion anywhere was that `AGENTS.md.pifleet-quarantined`
 * exists (in the egress/ordering test above). `.pi/extensions/` — the
 * in-process-EXECUTION class, the highest-consequence one, and the one ISC-119
 * names FIRST — was never checked in the clone at all.
 *
 * `.pi/extensions/hostile.ts` is the criterion's own filename, deliberately.
 */
describe("a hostile repo changes nothing about the run (ISC-119)", () => {
  test(
    "a committed .pi/extensions and AGENTS.md never reach the worker's workspace",
    async () => {
      const rig = await makeRig();
      // `makeRig` already seeds and commits the root AGENTS.md; this arms the
      // other half of the criterion's sentence and commits it, so the clone
      // carries it the way a real hostile repository would.
      await mkdir(join(rig.repo, ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(rig.repo, ".pi", "extensions", "hostile.ts"),
        "// FIXTURE PAYLOAD — Pi executes this in-process if it is discovered.\nexport const activate = (): void => {};\n",
      );
      await gitOk(rig.repo, "add", "-A");
      await gitOk(rig.repo, "commit", "-q", "-m", "arm the repository");

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

      const wt = (await readRunWorktrees(runPaths(rig.runId, rig.root))).byWorker.get("eng-1");
      expect(wt).toBeDefined();

      // Control: the clone is genuinely the tree the payloads were committed
      // into. Without this, every absence below is equally consistent with
      // "neutralized" and "this test is looking at the wrong directory".
      expect(await Bun.file(join(wt!.path, "README.md")).exists()).toBe(true);

      // THE assertion. `<repo>/.worktrees/<id>` is mounted at `/workspace` and
      // Pi discovers context files and extensions from its cwd — so these two
      // paths ARE the run's exposure, and both are gone from it.
      for (const rel of ["AGENTS.md", join(".pi", "extensions")]) {
        await expect(lstat(join(wt!.path, rel))).rejects.toThrow();
      }

      // Renamed aside, not deleted: a worker whose legitimate file vanished
      // with no record gets debugged as a mystery (repo-hazards.ts's own rule).
      //
      // BOTH halves need this, not just `.pi/extensions`. The absence loop
      // above is `rejects.toThrow()` with no matcher, so on its own it passes
      // on ANY rejection — including the one a fixture that never committed
      // the file would produce. The quarantine assertion is what separates
      // "the scanner neutralized it" from "it was never there", and until now
      // only `.pi/extensions` had one; `AGENTS.md` was resting on the vacuous
      // half alone. Mirrors the same pairing in the hazard-ordering test above.
      expect(await Bun.file(join(wt!.path, `AGENTS.md${QUARANTINE_SUFFIX}`)).exists()).toBe(true);
      expect(
        await Bun.file(join(wt!.path, ".pi", `extensions${QUARANTINE_SUFFIX}`, "hostile.ts")).text(),
      ).toContain("FIXTURE PAYLOAD");

      // "Changes nothing about the run" in the one place it is measurable
      // without a container: the run's own dirty accounting. Quarantine is a
      // rename of tracked files, so without `captureWorktreeBaseline` running
      // after it, an armed repository would make every worker read as holding
      // work before it had done any — and `down --prune` would refuse it.
      expect(await inspectCloneDirt(wt!)).toMatchObject({ dirty: false, statusLines: 0 });

      // And the operator's own checkout keeps both files, unrenamed (SRD
      // §12.8): `up` DETECTS there and neutralizes only in the clone.
      expect(await Bun.file(join(rig.repo, ".pi", "extensions", "hostile.ts")).exists()).toBe(true);
      expect(await Bun.file(join(rig.repo, "AGENTS.md")).exists()).toBe(true);
    },
    // ISC-266 audit: one `up` spawn, so cliBudget(1) = 11_400 ms is the derived
    // floor. Held at this file's 90_000 convention because an `up` spawn is not
    // the "grade a run and exit" shape PER_SPAWN_IDLE_MS was measured on — it
    // launches a supervisor and then waits on an idle gate, which the budget
    // model does not attempt to cost. Not reduced.
    90_000,
  );
});

/**
 * ISC-123 and ISC-124 — a run moves no ref outside `fleet/<run-id>/*`, and
 * leaves the operator's `git status --porcelain` unchanged.
 *
 * Both are properties of a RUN, so this drives the real CLI rather than
 * `createWorkerWorktrees` in isolation: the ref surface a run touches is the
 * union of the clone, the parent-side remote registration, and the
 * `.git/info/exclude` write, and only an actual `up` exercises all three in
 * the order that matters.
 *
 * THE FIXTURE IS DELIBERATELY NOT PRISTINE. ISC-124 says "unchanged", not
 * "empty" — an assertion that porcelain is `""` afterwards would pass equally
 * for a run that discarded the operator's uncommitted work, which is the
 * failure the criterion exists to forbid. So the checkout carries a modified
 * tracked file, a staged addition and an untracked file before `up` starts,
 * and the comparison is byte-for-byte against what was there.
 *
 * Likewise the repository carries more than one ref (a second branch and a
 * tag) so that "no ref moved" is a statement about a SET rather than about
 * `main` alone.
 */
describe("a run moves no ref outside fleet/<run-id>/* (ISC-123, ISC-124)", () => {
  /** `<sha> <ref>` lines → a map, so a diff names the ref that moved. */
  function parseRefs(showRef: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of showRef.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      out.set(line.slice(sp + 1), line.slice(0, sp));
    }
    return out;
  }

  test(
    "the operator's refs and porcelain are byte-identical across a run, and only the worker's own branch moves",
    async () => {
      const rig = await makeRig();

      await writeFile(join(rig.repo, "README.md"), "# edited by the operator, uncommitted\n");
      await writeFile(join(rig.repo, "operator-scratch.txt"), "untracked operator work\n");
      await writeFile(join(rig.repo, "staged.txt"), "staged operator work\n");
      await gitOk(rig.repo, "add", "staged.txt");
      await gitOk(rig.repo, "branch", "side");
      await gitOk(rig.repo, "tag", "v1");

      const refsBefore = await gitOk(rig.repo, "show-ref");
      const headBefore = await gitOk(rig.repo, "symbolic-ref", "HEAD");
      const statusBefore = (await git(rig.repo, "status", "--porcelain")).stdout;
      // The fixture is genuinely dirty and genuinely multi-ref, so neither
      // assertion below can pass by comparing nothing to nothing.
      expect(statusBefore).not.toBe("");
      expect(parseRefs(refsBefore).size).toBeGreaterThan(1);

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

      // ISC-124. Byte-for-byte, including the staged/untracked/modified mix.
      // The `.worktrees/<id>` clone `up` just created inside this checkout is
      // suppressed by the `.git/info/exclude` entry `excludeWorktreesDir`
      // writes; without it this reads `?? .worktrees/` and goes red here.
      expect((await git(rig.repo, "status", "--porcelain")).stdout).toBe(statusBefore);

      // ISC-123, operator side — and stronger than the criterion asks: not one
      // ref moved, appeared or vanished. `up` registers a `worker-<id>` REMOTE
      // in this repository; a remote is config, and fetching through it would
      // create `refs/remotes/worker-eng-1/*`, which is exactly the kind of ref
      // this forbids.
      expect(await gitOk(rig.repo, "show-ref")).toBe(refsBefore);
      expect(await gitOk(rig.repo, "symbolic-ref", "HEAD")).toBe(headBefore);

      // ISC-123, worker side. The clone is where the run is ALLOWED to move a
      // ref, and `fleet/<run-id>/<worker>` is the only one.
      const wt = (await readRunWorktrees(runPaths(rig.runId, rig.root))).byWorker.get("eng-1");
      expect(wt).toBeDefined();
      const workerRef = `refs/heads/${workerBranch(DEFAULT_BRANCH_PREFIX, rig.runId, "eng-1")}`;
      const cloneBefore = parseRefs(await gitOk(wt!.path, "show-ref"));
      expect(cloneBefore.has(workerRef)).toBe(true);

      // A worker committing on its branch is the whole point of the checkout;
      // doing it here is what makes the loop below a real measurement rather
      // than an observation that nothing happened at all.
      await gitOk(wt!.path, "commit", "--allow-empty", "-q", "-m", "the worker's own commit");
      const cloneAfter = parseRefs(await gitOk(wt!.path, "show-ref"));

      for (const [ref, sha] of cloneAfter) {
        if (ref.startsWith(`refs/heads/${DEFAULT_BRANCH_PREFIX}/${rig.runId}/`)) continue;
        // Compared as an object so a failure NAMES the ref that moved rather
        // than printing two bare shas. The `??` covers a ref that did not
        // exist before at all, which must read as a change, not as undefined.
        expect({ ref, sha }).toEqual({ ref, sha: cloneBefore.get(ref) ?? "<absent before>" });
      }
      expect([...cloneBefore.keys()].sort()).toEqual([...cloneAfter.keys()].sort());
      // The CONTROL for that loop: the one ref the run may move, moved.
      expect(cloneAfter.get(workerRef)).not.toBe(cloneBefore.get(workerRef));

      // …and the operator's checkout is still untouched after the worker
      // committed, which is the half a snapshot taken at `up` cannot show.
      expect(await gitOk(rig.repo, "show-ref")).toBe(refsBefore);
      expect((await git(rig.repo, "status", "--porcelain")).stdout).toBe(statusBefore);
    },
    // ISC-266 audit: one `up` spawn; same reasoning as the ISC-119 test above.
    90_000,
  );
});
