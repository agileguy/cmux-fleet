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

import { spawnCli } from "../support/spawn-cli.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { BRIEFING_MOUNT, renderWorker } from "../../src/config/render.ts";
import { TASK_POLICY_MOUNT } from "../../src/run/task-policy.ts";
import { SECRETS_MOUNT } from "../../src/run/worker-env.ts";
import { DEFAULT_BRANCH_PREFIX } from "../../src/config/schema.ts";
import {
  BudgetStateSchema,
  EXIT,
  type LedgerRecord,
  WorkerLaunchSchema,
} from "../../src/contracts.ts";
import { runPaths, workerBranch, workerPaths } from "../../src/run/paths.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { readRunBudgetPolicy, readRunWorktrees } from "../../src/run/state.ts";
import { inspectCloneDirt } from "../../src/run/worktree.ts";
import { QUARANTINE_SUFFIX } from "../../src/security/repo-hazards.ts";
// ISC-410's expected names are DERIVED, never typed: a literal would still pass
// if the composition changed, and `up` would then be creating names this file
// never looks for.
import {
  providerNetworkName,
  relayContainerName,
  uplinkNetworkName,
} from "../../src/security/relay.ts";
// The ISC-56 decoy waits for its own process to become visible to the very
// scan `up` runs, rather than sleeping a hopeful interval — see
// `startDecoyTrainingRun`.
import { checkMlxTrainingGuard } from "../../src/safety/mlx-training-guard.ts";
import { git, gitOk, seedGitRepo } from "../fixtures/synthetic-repo.ts";
import { cliBudget } from "../support/budget.ts";
// ISC-429 drives the REAL preflight against this file's shim, so the guard's
// answer is production's rather than a restatement of it here.
import { MountNotVisibleError, assertBindMountsVisible } from "../../src/container/mount-preflight.ts";
import type { Exec } from "../../src/container/run.ts";

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
   * Where this rig's `docker` shim records every argv it was handed.
   *
   * The ISC-32 ordering claim is a NEGATIVE — the launch was refused before
   * the egress network was touched, and therefore before the relay, the
   * ledger, the hazard scan, the clones, the materialization and every
   * supervisor, all of which are strictly later in `up`. An exit code cannot
   * carry that; this file can.
   */
  dockerCalls: string;
  /**
   * Where this rig's `cmux` shim records every argv it was handed.
   *
   * Same job as `dockerCalls`, for the opposite kind of claim: a backend
   * refusal reports exit 3 whether the backend was probed and found missing or
   * never consulted at all, and those are different bugs. A line in here is
   * what makes "the primary backend WAS probed" evidence.
   */
  cmuxCalls: string;
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
  // counted upper bound is the number of `makeRig` CALLS — 43 in this file, not
  // estimated. cliBudget(43) = 490_200 ms; the old flat 120_000 was already
  // exceeded by cliBudget(15) = 171_000. Counting rather than estimating is the
  // criterion's own instruction, and this is the case it was written for: the
  // budget silently stopped matching the work as the file grew.
  //
  // RE-COUNTED at 28 (was 26) when the MUST FIX A budget-writer tests added two
  // `makeRig` calls. Recounted with `grep -c 'await makeRig('` rather than
  // adjusted by memory — the criterion's whole complaint is that this number
  // stops matching the work silently, and a hand-incremented count is the same
  // failure one step later.
  //
  // RE-COUNTED at 43 when the ISC-32/ISC-189 image-gate, ISC-61 and ISC-271
  // blocks landed, by running that same `grep -c 'await makeRig('` rather
  // than by adding the new call sites to 28. Same method, same reason.
  //
  // RE-COUNTED at 45 when the ISC-271 no-fallback test landed. Note what the
  // re-count found: the number had ALREADY drifted. `grep -c 'await makeRig('`
  // against the previous commit answers 44, not the 43 written above, so one
  // call site had been added without the count moving with it — the exact
  // silent-drift failure this note exists to catch, caught only because the
  // instruction is to re-run the command rather than to add one. 45 is that
  // command's answer on this revision, not 44 + 1.
  //
  // RE-COUNTED at 47 when ISC-189's build-identity test landed, by running
  // `grep -c 'await makeRig('` on this revision rather than by adding 1 to 45.
  // The command's answer is 47, not the 46 an increment would have written —
  // so the number had ALREADY drifted by one again before this block was
  // touched, which is the third time this note has recorded that and the whole
  // reason the instruction is a command rather than an increment.
  //
  // RE-COUNTED at 57 when phase 6's two disclosure blocks landed, by the same
  // command on the merged tree rather than by adding 5 to 47. The answer is 57,
  // and the arithmetic an increment would have produced is 52 — because the
  // number had drifted by FIVE this time, before either block was written. That
  // is the fourth time this note has recorded a drift it did not cause, and the
  // gap is now large enough to be worth naming: 47 was recorded against a
  // revision, the file has grown by other hands since, and nobody re-ran the
  // command because the number looked plausible. A budget that looks plausible
  // is exactly the one nobody checks.
  //
  // The two new blocks contribute 5 of the 57 between them. Both spell their
  // helpers `async () => await makeRig(...)` rather than returning the promise
  // bare, specifically so this command can still see them — a returned promise
  // is invisible to a grep for `await makeRig(`, and a rig this hook must tear
  // down but cannot count is the one that leaks.
  //
  // Charging every `down` the expensive per-spawn rate is deliberately
  // conservative — rigs whose test never reached `up` contribute zero spawns —
  // because the failure mode here is not a slow suite, it is the one this
  // hook's own docstring above exists to prevent: a timed-out `afterAll`
  // truncates the loop mid-way and leaks detached supervisors onto the
  // developer's machine, which this project has already paid for.
}, cliBudget(57));

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
 *  3. `image inspect` answers ABSENT by default — the shape `up`'s launch gate
 *     (ISC-32/ISC-189) exists to refuse — and answers PRESENT only when a rig
 *     asks for it by setting `PIFLEET_SHIM_IMAGE`. Absent is the default
 *     deliberately: a rig that forgets to state which it wants gets the
 *     refusing answer, never the permissive one.
 *  4. When `PIFLEET_SHIM_IMAGE` IS set, the six `docker run` / `docker image
 *     inspect` probes `verifyImage` performs are answered FAITHFULLY — real
 *     uid, real tmpfs behaviour, a real `/workspace` round-trip through the
 *     `-v` source — with exactly ONE degree of freedom:
 *     `PIFLEET_SHIM_PI_VERSION`, the string the image reports for `pi
 *     --version`. That single knob is what lets one rig prove `up` REFUSES a
 *     present-but-wrong image and another prove it ACCEPTS a present-and-right
 *     one, with nothing else differing between them. A shim that failed every
 *     check would make the refusal test pass for the wrong reason — an `up`
 *     that merely issued a malformed docker command would look identical.
 *  5. `image inspect --format {{json .Config.Labels}}` — what
 *     `imageIdentityDrift` reads — is answered from THE REQUESTED TAG, so a
 *     shimmed image agrees with the name it is filed under, which is what a
 *     healthy store looks like. `PIFLEET_SHIM_CONFIG_HASH` is the second and
 *     last degree of freedom: set it and the store holds the one shape neither
 *     of the other two checks can see — an image that is present, that passes
 *     every behavioural check `verifyImage` makes, and whose own build labels
 *     say it came from a different build context than its tag names.
 *
 * WHAT THE VERIFY STAND-IN DOES NOT PROVE, said plainly because this file's
 * probe branch already had to say it once: there is no daemon here and no
 * image, so this proves the WIRING — that `up` consults verification, on the
 * tag it is about to launch, before the first clone, and refuses on the
 * verdict — and NOT that a real stale image is caught by a real Docker. That
 * needs the Docker-gated `container` job, whose file list in
 * `.github/workflows/ci.yml` does not include this file. ISC-189 is graded
 * `[~]` for exactly that residual; ISC-32, the absent half, needs no daemon
 * and is fully proven here.
 *
 * THE SAME BOUNDARY, DRAWN AROUND THE IDENTITY CHECK (item 5), because it is
 * the newest thing here and therefore the easiest to overclaim. What these
 * tests DO prove: that `up` reads an image's build labels back off the tag it
 * is about to launch, compares them to what that tag claims, and refuses —
 * before the first container, the first network call and the first clone —
 * when they disagree, with a diagnosis distinct from both the absent and the
 * failed-verify ones. What they DO NOT prove: that the labels a REAL daemon
 * reports on a REAL image are the ones `buildImage` stamped. This shim answers
 * `{{json .Config.Labels}}` by taking the tag string apart, so the round trip
 * `docker build --label` → image store → `docker image inspect` is asserted
 * nowhere in this file. Nothing here would notice if `buildImage` stopped
 * stamping those labels tomorrow: every rig would keep answering as though it
 * had. Closing that needs a probe in the `container` job which builds an image
 * and files it under another image's tag, and until one exists ISC-189's
 * harder half is WIRED and MUTATION-ISOLATED but NOT daemon-proved.
 *
 * Everything else still fails loudly, for the reason the gcloud shim does: a
 * silent `exit 0` stand-in absorbs a changed docker invocation instead of
 * surfacing it.
 *
 * Every invocation is APPENDED to `callLog` before dispatch, for the same
 * reason the gcloud shim logs: two of the claims below are NEGATIVES —
 * "nothing was cloned", "the egress network was never touched" — and a
 * subprocess that was never spawned leaves nothing to assert on. The log is
 * where an absence becomes evidence, and it makes the ORDERING claim (the
 * refusal preceded every later stage) a comparison of what is in a file
 * rather than an inference from an exit code.
 */
async function writeDockerShim(binDir: string, callLog: string): Promise<void> {
  const shim = join(binDir, "docker");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      // Marker for "the relay container has been created", per shim dir so
      // parallel rigs never see each other's relay.
      'STATE="$(dirname "$0")/.relay-created"',
      // Recorded unconditionally and BEFORE dispatch, including on the
      // unexpected-argv branches, so an empty log means "no docker call of any
      // kind" — strictly stronger than "no call this shim classified".
      `PIFLEET_SHIM_DOCKER_LOG=${JSON.stringify(callLog)}`,
      `if ! printf '%s\\n' "$*" >> "$PIFLEET_SHIM_DOCKER_LOG"; then`,
      `  echo "docker shim: cannot append to $PIFLEET_SHIM_DOCKER_LOG" >&2`,
      "  exit 90",
      "fi",
      'case "$1" in',
      "  network)",
      '    case "$2" in',
      // NOTE: the ids below are 64 hex characters because real Docker network
      // ids are, and ISC-51's containment derives the bridge interface name
      // (`br-<first 12>`) from them. A memorable non-hex id here would be a
      // stand-in that could not stand in.
      "      inspect)",
      // ---------------------------------------------------------------
      // OPT-IN ABSENCE, so `network create` is an observable event (ISC-410).
      //
      // The default answer below is "this network already exists, internal" for
      // EVERY name, which sends `ensureEgressNetwork` down its adopt branch and
      // means no `docker network create` is ever issued. Every pre-existing
      // test in this file was written against that and still gets it.
      //
      // ISC-410 is a claim about what `up` CREATES, and an adopt-only shim can
      // only witness what `up` MENTIONS. So a rig may ask for the other,
      // equally real, daemon state: the network is absent until this shim has
      // seen a `network create` for that exact name, and present afterwards.
      // That is Docker's own behaviour, not a test-only seam, and it is what
      // turns "the unused provider's bridge was never created" into a fact
      // about a create argv rather than an inference from silence.
      //
      // Opt-in rather than default for one reason: flipping it globally would
      // move every other test in this file off the adopt path — including the
      // ISC-189 positive control, which depends on an `-uplink`-named BASE
      // network being refused by the exists-but-not-internal branch that
      // absence would skip.
      //
      // Absence is spelled the way the daemon spells it, because
      // `inspectEgressNetwork` matches on that text and treats every other
      // non-zero exit as a hard failure — a shim inventing its own wording
      // would be caught as "daemon unreachable" three layers away from here.
      '        if [ -n "${PIFLEET_SHIM_NETWORK_ABSENT:-}" ] && [ ! -f "$(dirname "$0")/.net-$3" ]; then',
      '          echo "Error response from daemon: network $3 not found" >&2',
      "          exit 1",
      "        fi",
      // The uplink MUST report non-internal or ensureUplinkNetwork refuses it.
      '        case "$3" in',
      "          *-uplink)",
      `            printf '[{"Name":"%s","Id":"c1a5e0f77b1140e9a2d3c4b5a6978869fedcba9876543210fedcba9876543210","Internal":false,"IPAM":{"Config":[{"Subnet":"172.31.0.0/16","Gateway":"172.31.0.1"}]}}]\\n' "$3"`,
      "            ;;",
      "          *)",
      `            printf '[{"Name":"%s","Id":"a7b3c9d1e5f20486913a2b4c6d8e0f13579bdf02468ace13579bdf02468ace135","Internal":true,"IPAM":{"Config":[{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]}}]\\n' "$3"`,
      "            ;;",
      "        esac",
      "        ;;",
      // `network create <…flags…> <name>` — the name is LAST in both argvs
      // production builds (`--internal <name>` for the bridge, bare `<name>`
      // for the uplink), so the marker is keyed off the final word rather than
      // off a position that differs between the two.
      "      create)",
      '        for a in "$@"; do last="$a"; done',
      '        : > "$(dirname "$0")/.net-$last"',
      "        ;;",
      "      connect)",
      "        ;;",
      "      *)",
      '        echo "docker shim: unexpected network argv: $*" >&2',
      "        exit 1",
      "        ;;",
      "    esac",
      "    ;;",
      "  run)",
      // ---------------------------------------------------------------
      // ISC-292's bind-mount preflight, stood in for.
      //
      // `ensureEgressRelay` now probes its own `-v` sources before it
      // launches, because a checkout outside the runtime's shared set gets
      // three invented empty directories instead of the relay's scripts. The
      // probe is a real container on a real daemon; here there is neither, so
      // without this branch every `up` in this file exits 3 on a mount that
      // is in fact perfectly visible.
      //
      // FIRST among the `run` branches deliberately: the probe argv carries
      // `--read-only`, which the image-verification branch below also keys
      // on, and a probe answered by that branch would report success without
      // ever having looked at a mount.
      //
      // It answers by running PRODUCTION'S OWN probe script — lifted out of
      // the argv, not reimplemented — with each `/probe/<i>` rewritten to the
      // host path that `-v` was about to mount there. That is the same
      // liberty the ISC-260 branch takes and it stands in for a real
      // mechanism: on a shared path, what the container sees IS what the host
      // has, so answering from the host is the faithful stand-in rather than
      // a hard-coded success. A source that genuinely does not exist still
      // reports `x`, and the guard still refuses.
      //
      // The rewrite requires the trailing quote or slash so `/probe/1` cannot
      // match inside `/probe/10`.
      //
      // ONE `sed` COMMAND PER LINE, and that is not style (ISC-429).
      //
      // BSD `sed` — macOS's — reads a script in 4096-byte pieces and treats a
      // piece boundary as a LINE BREAK, whether the script arrived as an
      // argument or through `-f`. A `;`-joined program longer than that gets a
      // substitute command cut in half at byte 4096 and dies with
      // `unterminated substitute pattern`, having written nothing. Newlines
      // are read first, so a program whose every LINE is short is unbounded:
      // measured here at 42 kB against `/usr/bin/sed` on darwin 25.6.
      //
      // The relay's 3-mount probe builds a 694-byte program and never noticed.
      // `up`'s worker probe builds two commands per mount over absolute
      // `$TMPDIR` paths — 6.6 kB for a four-worker fleet — and every one of
      // them died at the boundary. The refusal that reached the operator said
      // "the probe container reported nothing about this path", three layers
      // from the cause, because the failure below was silent: see the exit
      // status check.
      '    case " $* " in',
      '      *":/probe/0:ro "*)',
      "        script=''",
      "        sedexpr=''",
      "        prev=''",
      // A literal newline, spelled the one way POSIX sh has: an open quote and
      // a close quote on the next line.
      "        NL='",
      "'",
      '        for a in "$@"; do',
      '          if [ "$prev" = "-c" ]; then script="$a"; fi',
      '          if [ "$prev" = "-v" ]; then',
      '            case "$a" in',
      "              *:/probe/*:ro)",
      '                src="${a%%:/probe/*}"',
      '                rest="${a#*:/probe/}"',
      '                idx="${rest%%:ro}"',
      `                sedexpr="$sedexpr\${NL}s#/probe/$idx'#$src'#g\${NL}s#/probe/$idx/#$src/#g"`,
      "                ;;",
      "            esac",
      "          fi",
      '          prev="$a"',
      "        done",
      '        if [ -z "$script" ]; then',
      '          echo "docker shim: mount probe carried no -c script: $*" >&2',
      "          exit 1",
      "        fi",
      // THE REWRITE'S OWN FAILURE IS AN ERROR, not an empty answer.
      //
      // This used to be `printf … | sed … | sh`, whose exit status is `sh`'s.
      // A `sed` that aborted fed `sh` an empty script, `sh` exited 0, and the
      // shim reported SUCCESS WITH NO OUTPUT — which `probeBindMountSources`
      // reads as "reported nothing about this path" for every mount, a
      // diagnosis about the container that was true of the shim's own `sed`.
      // Splitting the two makes a broken rewrite exit 1 with sed's own words,
      // which the preflight quotes back as "the probe container exited 1: …".
      `        rewritten="$(printf '%s\\n' "$script" | sed "$sedexpr" 2>&1)"`,
      '        if [ $? -ne 0 ]; then',
      '          echo "docker shim: mount probe rewrite failed: $rewritten" >&2',
      "          exit 1",
      "        fi",
      `        printf '%s\\n' "$rewritten" | sh`,
      "        exit $?",
      "        ;;",
      "    esac",
      // ---------------------------------------------------------------
      // ISC-51's containment call, stood in for WITH STATE.
      //
      // `ensureEgressNetwork` writes the bridge-gateway DROP rule through a
      // privileged container in the host's namespaces, because that is the
      // only privilege pifleet holds. There is no host firewall to write
      // here, so this branch models the one behaviour the product actually
      // depends on: `-C` reports absent until `-I` has run, and present
      // afterwards. A shim that answered 0 to everything would pass the
      // insert AND the verify-after-insert without either meaning anything,
      // which is the same vacuous shape the relay marker file exists to
      // avoid.
      //
      // Keyed on `iptables` rather than on the image, because the image is
      // the pinned digest and this must not have to be re-edited when the
      // digest rolls.
      '    case " $* " in',
      '      *" iptables "*)',
      '        GWBLOCK="$(dirname "$0")/.gateway-blocked"',
      '        case " $* " in',
      '          *" -C "*)  [ -f "$GWBLOCK" ] && exit 0; exit 1 ;;',
      '          *" -I "*)  : > "$GWBLOCK"; exit 0 ;;',
      '          *" -D "*)  rm -f "$GWBLOCK"; exit 0 ;;',
      '          *)',
      '            echo "docker shim: unexpected iptables argv: $*" >&2',
      "            exit 1",
      "            ;;",
      "        esac",
      "        ;;",
      "    esac",
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
      // ---------------------------------------------------------------
      // `verifyImage`'s probes, stood in for (ISC-189).
      //
      // Discriminated on the WORKER IMAGE PREFIX, which is the one thing
      // every verify run carries and the relay run cannot: the relay runs
      // pinned upstream Node, deliberately, so `up` cannot be taken down by
      // an unrelated image problem. Matching on `--read-only` instead would
      // couple this branch to a flag two unrelated subsystems happen to
      // share.
      //
      // Each case answers the way a HEALTHY image would, so the only thing
      // that can fail verification here is the Pi version — see the header.
      '    case " $* " in',
      '      *"pifleet/pi-worker:"*)',
      '        if [ -z "${PIFLEET_SHIM_IMAGE:-}" ]; then',
      // Unreachable in practice — the presence check refuses first — but a
      // shim that silently ran a container for an image it just said was
      // absent would be lying about the thing under test.
      '          echo "docker shim: run against absent image: $*" >&2',
      "          exit 125",
      "        fi",
      '        case " $* " in',
      // `pi --version` through the entrypoint chain. The ONE knob.
      '          *" --version "*)',
      '            echo "pi ${PIFLEET_SHIM_PI_VERSION:-0.0.0-unset}"',
      "            exit 0",
      "            ;;",
      // `id -u` — the uid the image runs as.
      '          *" /usr/bin/id "*)',
      '            echo "10001"',
      "            exit 0",
      "            ;;",
      // Read-only root: the tmpfs accepts a write, `/` does not. Printing
      // TMPFS_OK and NOT printing ROOT_WRITABLE is what a hardened image
      // does, and both halves are load-bearing in `verifyImage`.
      '          *"probe-should-work"*)',
      '            echo "TMPFS_OK"',
      "            exit 0",
      "            ;;",
      // `/workspace` write-through, both directions. Performed for real
      // against the `-v` source, because "the bytes crossed the mount" is
      // the entire content of the check and a hardcoded echo would assert
      // nothing. This is the same liberty the probe branch above takes: it
      // stands in for a real mechanism rather than papering over one.
      '          *"from-container"*)',
      '            src=""',
      '            prev=""',
      '            for a in "$@"; do',
      '              if [ "$prev" = "-v" ]; then',
      '                case "$a" in',
      '                  *":/workspace") src="${a%:/workspace}" ;;',
      "                esac",
      "              fi",
      '              prev="$a"',
      "            done",
      '            if [ -z "$src" ]; then',
      '              echo "docker shim: write-through run carried no -v <host>:/workspace: $*" >&2',
      "              exit 1",
      "            fi",
      '            cat "$src/from-host" || exit 1',
      '            echo "container-wrote-this" > "$src/from-container"',
      "            exit 0",
      "            ;;",
      // ---------------------------------------------------------------
      // THE WORKER CONTAINER ITSELF, stood in for — OPT-IN (ISC-429).
      //
      // Everything above answers a PREFLIGHT. This answers the launch: the
      // `docker run -i … <image> pi --mode rpc …` a supervisor spawns and then
      // speaks JSONL to over stdin/stdout. Without it the run reaches
      // `up`'s idle gate and every worker dies there, so no test in this file
      // could reach a COMPLETED container-path run — which is the whole of the
      // coverage hole ISC-429 records.
      //
      // It stands in the way the two branches above do: by running the real
      // thing on the host. `PIFLEET_SHIM_WORKER_PI` carries the SAME fake-Pi
      // double `PIFLEET_PI_COMMAND` names on the non-container path, so the
      // conversation the supervisor has is the one every other test in this
      // file already trusts — and the argv it is handed is production's own,
      // lifted from after the image rather than reconstructed.
      //
      // ONE path is translated: `--session-dir /sessions` becomes the host
      // directory that `-v …:/sessions` was about to mount there. That is the
      // same liberty the mount-probe branch takes, for the same reason — on a
      // shared path the container's `/sessions` IS that host directory, so
      // writing the transcript there is faithful rather than convenient. Every
      // other flag is passed through untouched.
      //
      // OPT-IN, for the reason `PIFLEET_SHIM_NETWORK_ABSENT` is: unset, the
      // argv falls to the refusal below, so every test written before this
      // branch existed keeps the loud "unexpected worker-image run argv" it
      // was written against. A shim that answered a worker launch by default
      // would let a run that should have stopped somewhere walk past it.
      //
      // WHAT IT DOES NOT PROVE, said plainly: no container is started and no
      // image is entered, so this is not evidence that the real entrypoint
      // execs `pi`, that the mounts land where the argv says, or that the
      // egress network is what the process can reach. Those need the
      // Docker-gated `container` job. What it makes reachable is `up`'s own
      // sequencing AFTER the mount preflight — the idle gate, the summary, the
      // exit code — which is what was unreachable.
      `          *" --session-dir /sessions "*)`,
      '            if [ -z "${PIFLEET_SHIM_WORKER_PI:-}" ]; then',
      '              echo "docker shim: unexpected worker-image run argv: $*" >&2',
      "              exit 1",
      "            fi",
      // The host side of `/sessions`, read off the argv rather than guessed.
      '            sessions=""',
      '            prev=""',
      '            for a in "$@"; do',
      '              if [ "$prev" = "-v" ]; then',
      '                case "$a" in',
      '                  *":/sessions") sessions="${a%:/sessions}" ;;',
      "                esac",
      "              fi",
      '              prev="$a"',
      "            done",
      '            if [ -z "$sessions" ]; then',
      '              echo "docker shim: worker run carried no -v <host>:/sessions: $*" >&2',
      "              exit 1",
      "            fi",
      // Drop everything up to and including the image; what remains is the
      // command production put after it.
      "            while [ $# -gt 0 ]; do",
      '              case "$1" in',
      "                pifleet/pi-worker:*) shift; break ;;",
      "              esac",
      "              shift",
      "            done",
      // Rotate the list once, substituting the one path that cannot survive
      // outside a container.
      "            n=$#",
      "            i=0",
      '            prev=""',
      '            while [ "$i" -lt "$n" ]; do',
      '              a="$1"',
      "              shift",
      '              if [ "$prev" = "--session-dir" ] && [ "$a" = "/sessions" ]; then',
      '                a="$sessions"',
      "              fi",
      '              prev="$a"',
      '              set -- "$@" "$a"',
      "              i=$((i + 1))",
      "            done",
      // Unquoted on purpose: the variable carries a command AND its arguments,
      // exactly as `PIFLEET_PI_COMMAND` does.
      '            exec $PIFLEET_SHIM_WORKER_PI "$@"',
      "            ;;",
      "          *)",
      '            echo "docker shim: unexpected worker-image run argv: $*" >&2',
      "            exit 1",
      "            ;;",
      "        esac",
      "        ;;",
      "    esac",
      '    : > "$STATE"',
      '    echo "wiring-shim-relay-id"',
      "    ;;",
      // ---------------------------------------------------------------
      // The image store. ABSENT unless a rig says otherwise — see header.
      "  image)",
      '    if [ "$2" != "inspect" ]; then',
      '      echo "docker shim: unexpected image argv: $*" >&2',
      "      exit 1",
      "    fi",
      '    if [ -z "${PIFLEET_SHIM_IMAGE:-}" ]; then',
      // Docker's own wording, so the refusal quotes something an operator
      // would recognise from their own terminal rather than a test string.
      '      echo "Error response from daemon: No such image: $3" >&2',
      "      exit 1",
      "    fi",
      '    case " $* " in',
      // `verifyImage`'s tini check reads the entrypoint back out of the
      // image. A healthy answer, so the Pi version stays the only variable.
      '      *"json .Config.Entrypoint"*)',
      `        printf '["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]\\n'`,
      "        ;;",
      // ---------------------------------------------------------------
      // The build labels `imageIdentityDrift` reads back (ISC-189).
      //
      // DERIVED FROM THE REQUESTED TAG, so the default answer is the one a
      // healthy store gives: the image agrees with the name it is filed
      // under. A hardcoded fixture hash here would read as a mismatched
      // image the moment anyone edits `docker/Dockerfile` — the tag moves
      // with its content by design (ISC-160) — and the gate's refusal would
      // then be about this fixture rather than about the product.
      //
      // `PIFLEET_SHIM_CONFIG_HASH` is the one degree of freedom, the same
      // discipline `PIFLEET_SHIM_PI_VERSION` follows: exactly one knob
      // moves, so a refusal can only have come from what the test moved.
      // Set it and the store holds an image whose recorded build identity is
      // not its tag's — the retagged-stale-image shape, and the one a real
      // `docker tag` produces in one command.
      '      *"json .Config.Labels"*)',
      '        ref="${3#*:}"',
      '        hash="${ref##*-}"',
      '        rest="${ref%-*}"',
      '        tc="${rest##*-}"',
      '        pi="${rest%-*}"',
      `        printf '{"pifleet.pi-version":"%s","pifleet.toolchain":"%s","pifleet.config-hash":"%s"}\\n' "$pi" "$tc" "\${PIFLEET_SHIM_CONFIG_HASH:-$hash}"`,
      "        ;;",
      "      *)",
      // What `imagePresent` reads. Non-empty on purpose: an exit 0 with
      // empty stdout is NOT treated as present, and this is the value that
      // proves the distinction is real rather than incidental.
      `        printf 'sha256:wiringshimimageid\\n'`,
      "        ;;",
      "    esac",
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
 * A `cmux` that is NOT INSTALLED, and the reason it is a shim rather than an
 * absence.
 *
 * `CmuxClient` defaults its binary to the bare name `cmux`, so the very first
 * thing `probeCmux` does is run `cmux --version` through PATH. Whether that
 * succeeds is therefore a property of the DEVELOPER'S MACHINE: this suite was
 * written on one with `/opt/homebrew/bin/cmux` installed and `ubuntu-latest`
 * has none, so any test that lets the cmux backend probe for real would take
 * one branch here and the opposite branch in CI. That is the failure this
 * whole shim directory exists to prevent — the same argument `writeGcloudShim`
 * makes about the operator's real gcloud, and a stronger one, because a
 * successful cmux probe does not merely READ the developer's machine, it goes
 * on to create windows and panes in the terminal they are working in.
 *
 * So the shim answers every invocation the way an uninstalled cmux does: exit
 * 1, nothing on stdout. `probeCmux` reads that as `cmux-binary` failed
 * (`DIAG.binaryMissing`), which is a REQUIRED capability, which is what
 * `resolveBackendWithFallback` turns into either a fallback or exit 3.
 *
 * Installed for every rig, not only the ones that name cmux, for exactly the
 * reason both other shims are: a rig that never mentions cmux must still not
 * be able to reach the real one by accident.
 *
 * Every invocation is appended to `callLog` first, so "the primary backend was
 * actually probed" is a fact in a file rather than an inference from an exit
 * code — the same reason the other two shims log.
 */
async function writeCmuxShim(binDir: string, callLog: string): Promise<void> {
  const shim = join(binDir, "cmux");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      `PIFLEET_SHIM_LOG=${JSON.stringify(callLog)}`,
      `if ! printf '%s\\n' "$*" >> "$PIFLEET_SHIM_LOG"; then`,
      `  echo "cmux shim: cannot append to $PIFLEET_SHIM_LOG" >&2`,
      "  exit 90",
      "fi",
      // The message a missing binary would not itself print — the SHELL prints
      // "not found" — but something has to distinguish "the shim answered" from
      // "the shim was never installed" when a test goes red, and stderr is
      // where the backend's own diagnosis quotes the failure.
      'echo "cmux shim: no cmux on this host (test fixture)" >&2',
      "exit 1",
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
 * Every docker argv this rig's CLI ran, in order. Same "absent file is a
 * genuine zero" guarantee as the gcloud log, and for the same reason: the shim
 * is installed and pointed at this path unconditionally in `makeRig`.
 */
async function readDockerCalls(rig: Rig): Promise<string[]> {
  const f = Bun.file(rig.dockerCalls);
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
  adcMode?: "token";
  /**
   * Workers beyond `eng-1`. A role name not yet in `roles:` is declared as an
   * empty role; `cloudAccess` is written on the WORKER entry (legal —
   * `WorkerEntrySchema` extends `RoleFieldsSchema`, and `resolveWorker` gives
   * the entry precedence over its role), so each worker's grant is stated at
   * the worker rather than inferred from whichever one declared the role first.
   */
  extraWorkers?: {
    id: string;
    role: string;
    cloudAccess?: boolean;
    model?: string;
    /**
     * The worker's `secrets:` REQUEST (ISC-415). Every name here must also be
     * on `secretsAllowlist` and must have a value in `hostSecrets`, because
     * `buildWorkerEnv` refuses an unallowlisted name and refuses one the host
     * does not carry — a fixture that forgets either gets a refusal rather
     * than the grant it meant to write.
     */
    secrets?: string[];
    /** The worker's `isolation:`; omitted leaves the schema default. */
    isolation?: string;
  }[];
  /**
   * `secrets.env_allowlist` — the fleet-wide CEILING a worker's `secrets:`
   * request is intersected against (§5.6, §12.4).
   *
   * Omitted by default, like `cloud:` and `providers:` above and for the same
   * reason: an absent block and an empty one mean the same thing to the
   * schema, so writing the key unconditionally would change the document every
   * other test in this file loads for no gain.
   */
  secretsAllowlist?: string[];
  /**
   * Values for the granted secrets, put in the rig's environment.
   *
   * Separate from `secretsAllowlist` on purpose: the allowlist is what the
   * fleet PERMITS and lives in the config, the value is what the host CARRIES
   * and lives in the environment, and `up` reads them from those two different
   * places. Marker strings, never credentials — and the disclosure tests rely
   * on these being distinctive enough that finding one in a banner is proof of
   * a leak rather than a coincidence.
   */
  hostSecrets?: Record<string, string>;
  /**
   * `llm.providers`, written as a map keyed by `name` (ISC-410).
   *
   * Omitted by default, which leaves the FLAT `llm.*` document every other test
   * in this file loads — and that is load-bearing, not tidiness: a flat fleet
   * gets exactly one bridge on `docker.network` verbatim, so writing this key
   * unconditionally would rename the network every other assertion in this file
   * names.
   */
  providers?: {
    name: string;
    hosted: boolean;
    baseUrl: string;
    apiKeyEnv: string;
    relayUpstream: string;
  }[];
  /** `llm.provider`. Must be a key of `providers` when that map is written. */
  llmProvider?: string;
  /**
   * `egress.allow` entries. Omitted by default — the flat fixture's relay
   * carries `host.docker.internal`, which the default policy already permits.
   *
   * A providers map needs one entry per relay target, because `ensureBridgeRelay`
   * refuses to forward a destination `decide()` denies.
   */
  egressAllow?: { host: string; port: number }[];
  /**
   * `PIFLEET_SHIM_NETWORK_ABSENT`: make the shimmed daemon report a network
   * absent until it has been created, so `network create` is observable.
   * See the `inspect` branch of `writeDockerShim` for why it is opt-in.
   */
  shimNetworkAbsent?: boolean;
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
  /**
   * `run.max_concurrent`. Omitted leaves the schema default, which is what
   * every pre-existing test in this file gets.
   *
   * Present so the budget round-trip below can name a value that is NOT the
   * default: `readRunBudgetPolicy` answers a missing cap with
   * `DEFAULT_MAX_CONCURRENT`, so asserting the default proves nothing about
   * whether `up` wrote anything at all.
   */
  maxConcurrent?: number;
  /** `run.budget.tokens_ceiling`. Defaults to the inert 1000000 boilerplate. */
  tokensCeiling?: number;
  /** `run.budget.per_task_reserve_tokens`; omitted leaves the key absent. */
  perTaskReserveTokens?: number;
  /**
   * Tokens the fake agent stamps on each assistant message (A4 `usage`).
   *
   * Opt-in, because the default of 0 writes no `usage` key at all and every
   * other test in this file depends on that transcript shape.
   */
  tokensPerMessage?: number;

  // -------------------------------------------------------------------------
  // Knobs that shape the RIG rather than the fleet.yaml (ISC-32, ISC-189).
  // `fleetYaml` ignores them; `makeRig` turns them into environment.
  // -------------------------------------------------------------------------

  /**
   * Run the CONTAINER path instead of the Pi double.
   *
   * `PIFLEET_PI_COMMAND` is emptied rather than deleted, because `runCli`
   * spreads `process.env` under `rig.env` and a key cannot be removed by
   * spreading. Empty is not a workaround: `up` tests the variable with
   * `.trim() !== ""`, so an empty value IS "no double", by the same rule that
   * governs an unset one — and the config-less requirement that would demand
   * it does not apply, because these rigs always pass `--config`.
   *
   * This is what puts the image gate on the path at all. Every other test in
   * this file keeps the double and therefore never reaches it, which is
   * exactly the intended behaviour: no container is started on that path, so
   * there is no image for a gate to be about.
   */
  containerPath?: boolean;
  /**
   * `PIFLEET_SHIM_WORKER_PI`: let the shim ANSWER a worker container launch
   * with the fake-Pi double, instead of refusing the argv (ISC-429).
   *
   * Meaningful only with `containerPath`, and opt-in for the reason the shim
   * branch records: every test written before it keeps the loud refusal. Set
   * it and a container-path run can get past `up`'s idle gate, which is the
   * only way anything in this file reaches a COMPLETED container-path run.
   */
  workerContainerDouble?: boolean;
  /** `PIFLEET_SHIM_IMAGE`: whether the shimmed image store holds the tag. */
  imagePresent?: boolean;
  /**
   * `PIFLEET_SHIM_PI_VERSION`: what the shimmed image reports for
   * `pi --version`. The single degree of freedom in the verify stand-in — see
   * `writeDockerShim`. Match `docker.pi_version` and verification passes;
   * differ from it and exactly one check fails, which is ISC-24's shape.
   */
  shimPiVersion?: string;
  /**
   * `PIFLEET_SHIM_CONFIG_HASH`: the `pifleet.config-hash` LABEL the shimmed
   * image carries, overriding the one derived from the tag it is filed under.
   *
   * The second degree of freedom in the store stand-in, and the one ISC-189's
   * harder half needs. Left unset, the shimmed image agrees with its own tag
   * and `imageIdentityDrift` finds nothing. Set it to anything else and the
   * store holds the shape a `docker tag` of a stale build produces: present,
   * behaviourally perfect — the shim answers every `verifyImage` probe the way
   * a healthy image does — and NOT the bytes the config asked for.
   */
  shimConfigHash?: string;
  /**
   * `docker.network`. Defaults to the shared internal `NETWORK`.
   *
   * A name ending `-uplink` is answered NON-internal by the shim, which
   * `ensureEgressNetwork` refuses to adopt — giving a fast, distinctively
   * worded failure at the step immediately AFTER the image gate. That is how
   * the ISC-189 positive control proves the gate was passed rather than
   * skipped, without waiting out a 60s idle gate on a fleet whose containers
   * this shim cannot actually run.
   */
  network?: string;
  /**
   * `backend.kind`, written into a `backend:` block (ISC-271).
   *
   * Omitted by default, which is what every other fixture in this file gets
   * and what a real fleet.yaml usually looks like.
   *
   * Omitting it and writing `kind: cmux` used to be INDISTINGUISHABLE after
   * parse — `BackendSchema.kind` carried `.default("cmux")`, so all three of
   * "no block", "`backend: {}`" and "`kind: cmux`" produced the same object,
   * and the ISC-271 block below could only pin the flag half. `kind` is
   * `.optional()` now, an absent block means UNSET, and the config half is
   * proven by the tests that use this option.
   */
  backendKind?: "cmux" | "tmux" | "headless";
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
    // Emitted only when a test asks, for the same reason `cloud:` is: writing
    // the key unconditionally would change the document every other test in
    // this file loads, for no gain.
    ...(opts.backendKind === undefined ? [] : ["backend:", `  kind: ${opts.backendKind}`]),
    "docker:",
    '  pi_version: "0.79.6"',
    `  network: ${opts.network ?? NETWORK}`,
    "run:",
    `  repo: ${repo}`,
    ...(opts.maxConcurrent === undefined ? [] : [`  max_concurrent: ${opts.maxConcurrent}`]),
    "  budget:",
    `    tokens_ceiling: ${opts.tokensCeiling ?? 1000000}`,
    ...(opts.perTaskReserveTokens === undefined
      ? []
      : [`    per_task_reserve_tokens: ${opts.perTaskReserveTokens}`]),
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
    ...(opts.llmProvider === undefined ? [] : [`  provider: ${opts.llmProvider}`]),
    ...(opts.providers === undefined
      ? []
      : [
          "  providers:",
          ...opts.providers.flatMap((p) => [
            `    ${p.name}:`,
            `      hosted: ${p.hosted}`,
            `      base_url: ${p.baseUrl}`,
            `      api_key_env: ${p.apiKeyEnv}`,
            `      relay_upstream: ${p.relayUpstream}`,
          ]),
        ]),
    // Before `roles:` and well before `workers:`, because a top-level key
    // emitted between two list entries would silently truncate the sequence —
    // the same hazard the `egress:` block at the bottom is placed around.
    ...(opts.secretsAllowlist === undefined
      ? []
      : ["secrets:", "  env_allowlist:", ...opts.secretsAllowlist.map((n) => `    - ${n}`)]),
    "roles:",
    `  engineer: {${roleFields.join(", ")}}`,
    ...extraRoles.map((r) => `  ${r}: {}`),
    "workers:",
    `  - {id: eng-1, role: ${opts.workerRole ?? "engineer"}}`,
    ...extraWorkers.map(
      (w) =>
        `  - {id: ${w.id}, role: ${w.role}` +
        `${w.cloudAccess === undefined ? "" : `, cloud_access: ${w.cloudAccess}`}` +
        // `provider/model`, which is how a worker SELECTS a provider — the one
        // input `resolvedProviders` reads and therefore the only way a fixture
        // can leave a declared provider unselected.
        `${w.model === undefined ? "" : `, model: ${w.model}`}` +
        `${w.isolation === undefined ? "" : `, isolation: ${w.isolation}`}` +
        `${w.secrets === undefined ? "" : `, secrets: [${w.secrets.join(", ")}]`}}`,
    ),
    // LAST, after the whole `workers:` sequence — a top-level key emitted
    // between two list entries would silently truncate it.
    ...(opts.egressAllow === undefined
      ? []
      : [
          "egress:",
          "  allow:",
          ...opts.egressAllow.map((a) => `    - {host: ${a.host}, port: ${a.port}}`),
        ]),
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
  const dockerCalls = join(base, "docker-calls.log");
  await writeDockerShim(bin, dockerCalls);
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
  // The third shim, unconditionally, for the reason its docstring gives: the
  // machine this suite runs on must not decide whether the cmux backend probes
  // healthy, and must never have its real terminal driven by a test.
  const cmuxCalls = join(base, "cmux-calls.log");
  await writeCmuxShim(bin, cmuxCalls);
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
    dockerCalls,
    cmuxCalls,
    adcFile,
    runId: "",
    env: {
      PIFLEET_RUNS_DIR: root,
      // Emptied, not omitted, on the container path — see `containerPath`.
      PIFLEET_PI_COMMAND:
        opts.containerPath === true
          ? ""
          : `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}` +
            (opts.tokensPerMessage === undefined
              ? ""
              : ` --tokens-per-message ${opts.tokensPerMessage}`),
      // The shim shadows the real docker for the CLI and everything it spawns.
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      // Pins whose ADC `resolveIdentity` reads. See `Rig.adcFile`.
      GOOGLE_APPLICATION_CREDENTIALS: adcFile,
      // Absent by default: the shim treats an empty value as "no such image",
      // which is the answer the ISC-32 gate exists to refuse.
      ...(opts.imagePresent === true ? { PIFLEET_SHIM_IMAGE: "1" } : {}),
      ...(opts.shimPiVersion === undefined ? {} : { PIFLEET_SHIM_PI_VERSION: opts.shimPiVersion }),
      ...(opts.shimConfigHash === undefined
        ? {}
        : { PIFLEET_SHIM_CONFIG_HASH: opts.shimConfigHash }),
      /**
       * The SAME double the non-container path runs, spelled once above as
       * `PIFLEET_PI_COMMAND` (ISC-429). Two spellings of one command would be
       * two things to keep in step, so the value is built the same way — and
       * a container-path rig that opts in therefore has the conversation
       * every other test in this file already trusts.
       */
      ...(opts.workerContainerDouble === true
        ? {
            PIFLEET_SHIM_WORKER_PI: `${process.execPath} ${FAKE_PI} --scenario ${join(
              SCENARIOS,
              "happy.json",
            )}`,
          }
        : {}),
      /**
       * `verifyImage`'s `/workspace` write-through probe creates a scratch
       * directory under `daemonScratchRoot()`, which defaults to the
       * DEVELOPER's `~/.pifleet/scratch`. Pinned into this rig's own base so a
       * test never writes outside the directory `afterAll` removes — the same
       * discipline `GOOGLE_APPLICATION_CREDENTIALS` applies to the ADC lookup.
       */
      PIFLEET_SCRATCH_DIR: join(base, "scratch"),
      ...(opts.shimNetworkAbsent === true ? { PIFLEET_SHIM_NETWORK_ABSENT: "1" } : {}),
      /**
       * A value for every declared provider's `api_key_env` (ISC-410).
       *
       * `providerApiKeyEnv` refuses to fall back to `llm.api_key_env`, so a
       * provider whose variable is unset produces a worker `up` reports as
       * key-less. Not a refusal — but it would make the run's shape depend on
       * whatever the developer's shell happens to export, which is the same
       * argument the ADC fixture and both shims already make. Marker strings,
       * not credentials.
       */
      ...Object.fromEntries(
        (opts.providers ?? []).map((p) => [p.apiKeyEnv, `fixture-${p.name}-not-a-real-key`]),
      ),
      /**
       * Values for granted `secrets:` (ISC-415). `buildWorkerEnv` raises
       * `SecretMissingFromHostError` for a requested name the host does not
       * carry, so without these a fixture that MEANT to test a grant would be
       * testing a refusal instead — and the disclosure banner it is asserting
       * would never print at all.
       */
      ...(opts.hostSecrets ?? {}),
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
  return spawnCli(args, { cwd: opts.cwd, env: { ...rig.env,
      // HOME override pins the ~/.config/pifleet/fleet.yaml fallback to a
      // directory the test controls; without it, implicit config resolution
      // depends on whatever the developer's machine happens to contain.
      ...(opts.home !== undefined ? { HOME: opts.home } : {}),
    } });
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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 327 ms. Not reduced.
    90_000,
  );
});

/**
 * MUST FIX A — `up` actually WRITES the budget policy into `run.json`.
 *
 * THE MUTATION THIS FILE EXISTS FOR, in its newest instance. Deleting
 * `...runBudgetRecord(loadedConfig?.config.run ?? null),` from `up.ts` left the
 * ENTIRE suite green. `runBudgetRecord` had exactly one production call site —
 * that line — and appeared in tests only in `budget-wiring.test.ts`, twice,
 * both calling it DIRECTLY into a hand-built `run.json`. `budget-halt.test.ts`
 * writes `run.json` by hand and says so in its own header. Every `runJson`
 * reference under `test/` was a fixture; nothing read back what `up` wrote.
 *
 * The production effect of that deletion is not subtle and it is silent: every
 * run gets `tokensCeiling: null` — UNBOUNDED — and the default
 * `max_concurrent`. `tokens_ceiling` becomes a config key with no reader
 * AGAIN, which is the exact defect ISC-235's own docstring cites
 * `max_concurrent` for, reintroduced one line above the docstring that names
 * it. And nothing complains: `readRunBudgetPolicy` treats absence as normal,
 * `note` is null, there is no ledger row and nothing on stderr.
 *
 * The reader end of that seam was closed (round-trip tested in
 * `budget-wiring.test.ts`); the WRITER end was left unproved. These two tests
 * close it from both directions — the policy `up` records, and the ceiling
 * that policy actually enforces.
 */
describe("up records the budget policy the run is dispatched against (MUST FIX A)", () => {
  test(
    "the configured ceiling, cap and reserve survive into run.json and read back exactly",
    async () => {
      /**
       * Every number here is deliberately NOT a default.
       *
       * `readRunBudgetPolicy` answers a missing cap with
       * `DEFAULT_MAX_CONCURRENT` (2), a missing ceiling with null and a
       * missing reserve with 0 — so a fixture using any of those would be
       * satisfied by a `run.json` with no budget block at all, which is
       * precisely the mutated state. 3/4242/11 can only come from the config.
       */
      const rig = await makeRig({
        maxConcurrent: 3,
        tokensCeiling: 4_242,
        perTaskReserveTokens: 11,
      });
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
      const run = runPaths(rig.runId, rig.root);

      // Read back through the SAME reader `dispatch --auto` uses, not through
      // a second parse of the file. A test that re-implemented the read would
      // assert only that its own copy is self-consistent.
      const policy = await readRunBudgetPolicy(run);
      expect(policy).toMatchObject({
        tokensCeiling: 4_242,
        maxConcurrent: 3,
        perTaskReserveTokens: 11,
        note: null,
      });

      // And the raw document carries the keys, so a reader-side default can
      // never be what makes the assertion above pass.
      const doc = JSON.parse(await Bun.file(run.runJson).text()) as {
        max_concurrent: unknown;
        budget: { tokens_ceiling: unknown; per_task_reserve_tokens: unknown } | null;
      };
      expect(doc.max_concurrent).toBe(3);
      expect(doc.budget).toMatchObject({ tokens_ceiling: 4_242, per_task_reserve_tokens: 11 });
    },
    // ONE spawn, counted from the body: a single `up`. The `down` this rig
    // needs is charged to the afterAll hook, which budgets per `makeRig` call.
    cliBudget(1),
  );

  test(
    "a run created by `up` actually HALTS on the ceiling `up` recorded",
    async () => {
      /**
       * The behavioural half, and the one that makes the seam load-bearing
       * rather than merely round-tripped.
       *
       * `budget-halt.test.ts` proves a ceiling halts a run, but it writes
       * `run.json` BY HAND — so it holds identically whether or not `up` can
       * produce that document. This is the same claim starting from a config
       * file and a real `up`: the operator's `tokens_ceiling` reaches the
       * dispatcher and stops the run.
       *
       * 300 against 400 tokens per assistant message, so the FIRST task to
       * settle crosses it — the same reasoning, and the same numbers, as
       * `budget-halt.test.ts`'s `TOKENS_CEILING`.
       */
      const rig = await makeRig({ tokensCeiling: 300, tokensPerMessage: 400 });
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

      const auto = await runCli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(ROOT_URL, "test/fixtures/tasklists/fan.json"),
        "--run",
        rig.runId,
        "--json",
      ]);

      // THE assertion. With the writer deleted the run is unbounded, every
      // task succeeds and this is 0.
      expect(auto.code).toBe(EXIT.BUDGET);
      expect(auto.stderr).toContain("budget ceiling crossed");
      expect(auto.stderr).toContain("tokens_ceiling");

      // Non-vacuous in the other direction too: the halt came from THIS run's
      // recorded ceiling, not from some unrelated refusal that also exits 5.
      const budget = BudgetStateSchema.parse(
        JSON.parse(await Bun.file(runPaths(rig.runId, rig.root).budgetJson).text()),
      );
      expect(budget.tokens_ceiling).toBe(300);
      expect(budget.tokens_spent).toBeGreaterThan(300);
      expect(budget.halted_at).not.toBeNull();
    },
    // TWO spawns, counted: `up` and `dispatch --auto`. `dispatch --auto` is a
    // whole-run driver, the expensive class `PER_SPAWN_IDLE_MS` is measured
    // on, so neither is charged the cheap rate by accident.
    cliBudget(2),
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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  }, cliBudget(2));
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
  }, cliBudget(2));

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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 999 ms. Not reduced.
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
  }, cliBudget(2));

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
  }, cliBudget(2));
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
  }, cliBudget(2));

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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 1052 ms. Not reduced.
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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  },
  // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
  // measured idle is 1032 ms. Not reduced.
  90_000);
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
  }, cliBudget(3));

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
    // ISC-274 audit: stands. Three `up` spawns derive cliBudget(3) = 34_200 ms;
    // measured idle is 1146 ms. Not reduced.
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
  },
  // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
  // measured idle is 1050 ms. Not reduced.
  90_000);
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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 1232 ms. Not reduced.
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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 1070 ms. Not reduced.
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
 * `adc_mode: token` — and the fixture used to say `file` DELIBERATELY, for a
 * reason that no longer has a way to be served. That is worth stating rather
 * than quietly editing.
 *
 * The old contrast was: the ISC-251 case above pins `token` arriving from the
 * schema DEFAULT, and this case pinned an EXPLICIT non-default value, so
 * between them the suite could tell "prints the mode" from "prints the word
 * token". ISC-268 removed `file` — it was accepted by the schema and
 * implemented nowhere, and wiring it would have mounted an account-wide
 * refresh token — so there is now exactly one mode and the contrast is not
 * expressible by any fixture.
 *
 * The lost discrimination is replaced, not merely mourned:
 * `test/unit/adc-plan-mode.test.ts` asserts structurally that
 * `planCredential` carries `role.adcMode` through rather than emitting a
 * literal, which is the property the two-fixture contrast was standing in for.
 * If a second mode ever returns, put it back here — a live fixture is better
 * evidence than a source check, and this note is how the next reader knows to.
 */
describe("up states the grant for every worker, cloud or not (ISC-49)", () => {
  const QUOTA_PROJECT = "pifleet-test-project-49";

  test(
    "identity, project and mode appear per cloud worker — and none of them for a worker without cloud access",
    async () => {
      const rig = await makeRig({
        // `engineer` carries the grant; `eng-1` and `eng-2` inherit it.
        cloudAccess: true,
        adcMode: "token",
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
        // Mode. This USED to assert the configured `file` against the sibling
        // test's schema-default `token`, and the contrast is what proved the
        // line reports `cloud.adc_mode` rather than printing a constant.
        // ISC-268 removed `file`, so no fixture can make that distinction any
        // more; `test/unit/adc-plan-mode.test.ts` pins the link structurally
        // instead. What is still worth asserting here is that the line names a
        // mode at all, and names the one that exists.
        expect(line).toContain("token mode");
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
      expect(quiet).not.toContain("token mode");
      expect(quiet).not.toContain(" mode");

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
        adcMode: "token",
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

      expect(up.stdout).toContain(`eng-1: google: token mode as ${SHIM_ACCOUNT}, project ${QUOTA_PROJECT}`);
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
    // 0444 for the same reason, and it is checked by the same refusal: the
    // gate holds its provenance file to the allow file's integrity bar, so a
    // writable one refuses every verb rather than yielding a forgeable ledger.
    [TASK_POLICY_MOUNT]: { directory: false, mode: 0o444 },
    /*
     * The secret store, present for EVERY worker since D8 — this rig's workers
     * request no `secrets:` and still carry it, because the Class 1 provider
     * key is delivered as a 0444 file in it and no worker requests that.
     *
     * 0755 on the DIRECTORY and not 0700: the mounted inode's own mode is the
     * only one the container consults and it needs the execute bit to traverse
     * to the files below. What 0700 was reaching for is bought one level up
     * instead — `materialize.ts` tightens `<run>/workers/<id>` itself — which
     * costs the container nothing because it enters at the mountpoint in its
     * own namespace rather than walking the host chain.
     */
    [SECRETS_MOUNT]: { directory: true, mode: 0o755 },
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
           * `--env-file` USED to be the one deliberate exemption, and this
           * assertion used to require it ABSENT.
           *
           * The reasoning then was that an empty allow list is semantically
           * correct (deny-all for mutating verbs) while an empty env file is
           * semantically wrong — no `base_url`, no API key — so leaving the
           * path unwritten made a premature `docker run` fail loudly on a
           * missing file instead of quietly on a wrong one. That was a
           * tripwire held until a real writer existed, not a permanent
           * property, and `run/worker-env.ts` is that writer.
           *
           * So the assertion inverts, and is made STRONGER rather than merely
           * flipped: the file must exist, and it must be 0600. The mode is the
           * half worth pinning — this is the only materialized input that
           * carries a secret (the Class 1 oMLX key, SRD §12.4), and it is also
           * the only one the container never opens, because `--env-file` is
           * parsed by the docker client on the host. Nothing else in the
           * `EXPECTED` table above would catch it silently becoming 0644.
           */
          const envFile = r.docker[r.docker.indexOf("--env-file") + 1];
          expect(envFile).toBe(workerPaths(run, worker.id).envFile);
          expect(await Bun.file(envFile!).exists()).toBe(true);
          expect((await stat(envFile!)).mode & 0o777).toBe(0o600);
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
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 1028 ms. Not reduced.
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
    // ISC-274 audit: stands, and deliberately NOT raised. Sixteen spawn-reaching
    // calls sit in this body, so the per-spawn model would derive cliBudget(16) =
    // 182_400 ms. Counted honestly, exactly ONE is a `bun run <cli>` spawn
    // (`runCli`); fourteen are direct `git`/`gitOk` fixture calls and the
    // sixteenth is `makeRig`, which is more of the same. budget.ts calibrates
    // PER_SPAWN_IDLE_MS to CLI startup at ~1900 ms, and a `git rev-parse` costs
    // tens of milliseconds. Charging fifteen cheap calls at the expensive rate
    // would double this ceiling on the strength of a count the model does not
    // describe — the inverse of the ISC-266 mistake, but a fiction either way.
    // Measured idle is 1454 ms; 90_000 is 62x that, well past the 3x contention
    // and 2x safety cliBudget already applies.
    90_000,
  );
});

/**
 * `up` refuses a launch whose images are not there, and not there in the sense
 * the SRD means (ISC-32, ISC-189).
 *
 * WHY THIS FILE AND NOT A UNIT TEST. `container/image.ts` had both primitives
 * for a long time — `verifyImage`, and a `docker image inspect` in `doctor.ts`
 * — while `up.ts` did not contain the string "image" at all. Grading a
 * primitive as though it were its consumer is the exact defect the ISA records
 * against these two criteria, so the assertions here drive the REAL `pifleet up`
 * process against a real config and read the outcome the way an operator would.
 *
 * WHY IT NEEDS NO DAEMON. The `docker` PATH shim answers `image inspect` with
 * Docker's own "No such image" and exit 1 unless a rig asks otherwise, so the
 * absent case is a plain subprocess test that runs in the fast `test` CI job.
 *
 * THE ORDERING IS THE CRITERION. "Refuses to start" and "starts everything,
 * then reports a corpse" differ in exit code, in diagnosis, and in how much
 * state is left behind. What shipped before was the second: `up` created the
 * run directory, cloned a checkout per worker, registered a remote per worker
 * IN THE OPERATOR'S OWN REPOSITORY, materialized every input, launched every
 * supervisor, and only met the dead child at the idle gate ~600 lines later as
 * `worker <id> died during startup` / `EXIT.WORKER_DIED`. So these tests assert
 * the refusal AND the absence of every one of those side effects, using three
 * independent witnesses: the docker call log (nothing after the inspect), the
 * operator's repository (no remote), and the run directory (no clone, no
 * worker state, no ledger).
 */
describe("up refuses to launch against an image it does not have (ISC-32, ISC-189)", () => {
  /** The config pin every rig in this block writes. Must match `fleetYaml`. */
  const PINNED_PI = "0.79.6";

  test(
    "a missing role image is refused, by name, before anything is cloned or launched (ISC-32)",
    async () => {
      const rig = await makeRig({ containerPath: true });
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

      // A refusal, at the code the egress and hazard guards use: the host is
      // not in a state this run can use, and nothing is wrong with the argv.
      // NOT `WORKER_DIED`, which is what this same fleet produced before.
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.code).not.toBe(EXIT.WORKER_DIED);

      // The ROLE is named. This is the criterion's own wording and the whole
      // reason the gate resolves through the renderer rather than checking a
      // bare tag: an operator has to know which `roles:` entry to build for.
      expect(up.stderr).toContain("'engineer'");
      expect(up.stderr).toContain("eng-1");
      expect(up.stderr).toContain("refusing to start");
      expect(up.stderr).toContain("NOT present");
      // The remedy names the toolchain, so the message is actionable rather
      // than merely accurate.
      expect(up.stderr).toContain("pifleet image build --toolchain");
      // And it quotes what docker actually said, so a stopped daemon and a
      // missing build do not read identically.
      expect(up.stderr).toContain("No such image");

      // WITNESS 1 — the docker call log. The gate sits immediately after
      // `assertModelsAllowed` and immediately BEFORE `ensureEgressNetwork`, so
      // an inspect with no network call after it places the refusal ahead of
      // the egress network, the relay, the ledger, the hazard scan, the
      // clones, the materialization and every supervisor, all of which are
      // strictly later in `up`.
      const docker = await readDockerCalls(rig);
      expect(docker.some((c) => c.startsWith("image inspect pifleet/pi-worker:"))).toBe(true);
      expect(docker.filter((c) => c.startsWith("network "))).toEqual([]);
      expect(docker.filter((c) => c.startsWith("run "))).toEqual([]);

      // WITNESS 2 — the operator's repository. `createWorkerWorktrees`
      // registers one remote per worker HERE, in the repo the operator works
      // in, and that side effect outlives a failed `up`. It is the most
      // expensive thing the old behaviour did before discovering the image was
      // missing, and the one an operator would have to clean up by hand.
      expect(await gitOk(rig.repo, "remote")).toBe("");

      // WITNESS 3 — the run directory. It exists (it is created before the
      // config is even read, which is why the gate cannot promise otherwise),
      // but it must hold no clone, no worker state and no ledger record.
      const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
      expect(runIds).toHaveLength(1);
      const run = runPaths(runIds[0]!, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      const { records } = await mergeLedger(run);
      expect(records).toEqual([]);
    },
    // ISC-266/273 audit: ONE `bun run <cli>` spawn (`runCli`). The two `gitOk`
    // calls inside `makeRig`'s `seedGitRepo` and the one here are fixture git,
    // tens of milliseconds each, and charging them the CLI-startup rate would
    // be the fiction the ISC-119 test above declines for the same reason.
    cliBudget(1),
  );

  test(
    "the refusal names the role even when the worker id and the role differ (ISC-32)",
    async () => {
      // `--workers` names `rev-1`; the ROLE is `reviewer`. A gate that echoed
      // the worker id and called it the role would pass the test above, where
      // the fixture's only worker is `eng-1` on role `engineer` and the two
      // strings are similar enough to hide the mistake.
      const rig = await makeRig({
        containerPath: true,
        extraWorkers: [{ id: "rev-1", role: "reviewer" }],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "rev-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("'reviewer'");
      expect(up.stderr).toContain("rev-1");
      // And it did NOT gate on the worker that was not asked for.
      expect(up.stderr).not.toContain("'engineer'");
    },
    cliBudget(1),
  );

  test(
    "an image that is PRESENT but fails verify is refused too, on the verdict (ISC-189)",
    async () => {
      // Present in the store, and reporting a Pi version that is not the pin.
      // This is ISC-24's shape moved onto the launch path: the image exists,
      // the tag resolves, and the bytes are wrong.
      const rig = await makeRig({
        containerPath: true,
        imagePresent: true,
        shimPiVersion: "0.60.0-stale",
      });
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

      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("'engineer'");
      expect(up.stderr).toContain("FAILS verification");
      // The FAILING CHECK is named, and it is the pi-version one specifically
      // — not a shim that answered everything wrong. The shim answers uid,
      // read-only root, tini and write-through the way a healthy image does,
      // so this string can only come from the one knob that was moved.
      expect(up.stderr).toContain("pi-version");
      expect(up.stderr).toContain("0.60.0-stale");
      expect(up.stderr).toContain(PINNED_PI);
      // It is NOT the absent message. The two halves of ISC-189 have different
      // diagnoses and must not collapse into one.
      expect(up.stderr).not.toContain("NOT present");

      // Same ordering witnesses. Verification ran (several `docker run`s
      // against the worker image), and still nothing touched the network, the
      // operator's repository or the run directory.
      const docker = await readDockerCalls(rig);
      expect(docker.some((c) => c.startsWith("image inspect pifleet/pi-worker:"))).toBe(true);
      expect(docker.some((c) => c.startsWith("run ") && c.includes("--version"))).toBe(true);
      expect(docker.filter((c) => c.startsWith("network "))).toEqual([]);
      expect(await gitOk(rig.repo, "remote")).toBe("");
      const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
      expect(runIds).toHaveLength(1);
      expect(await readdir(runPaths(runIds[0]!, rig.root).workersDir)).toEqual([]);
    },
    cliBudget(1),
  );

  test(
    "an image that passes every verify check is STILL refused when its recorded build identity is not its tag's (ISC-189)",
    async () => {
      /**
       * The case the other two cannot reach, and the reason ISC-189 is not a
       * duplicate of ISC-32.
       *
       * `shimPiVersion` is the PIN, not a stale string — so every check
       * `verifyImage` makes would pass: the Pi version matches, uid is 10001,
       * the root refuses a write, tini is PID 1, `/workspace` round-trips.
       * The ONE thing wrong is the image's own account of itself: its
       * `pifleet.config-hash` label says it was built from a different build
       * context than the tag it is filed under names. That is what `docker
       * tag <stale> <current>` produces in one command, and it is the shape
       * `Docs/SRD-COMPLETION.md` calls invisible: presence says yes,
       * behaviour says yes, and the fleet runs on bytes the config never
       * described.
       */
      const rig = await makeRig({
        containerPath: true,
        imagePresent: true,
        shimPiVersion: PINNED_PI,
        shimConfigHash: "0000deadbeef",
      });
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

      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("'engineer'");
      expect(up.stderr).toContain("NOT built from what that tag names");
      // The label that disagreed is NAMED, with both values, so an operator
      // can tell a retagged image from a differently-built one.
      expect(up.stderr).toContain("pifleet.config-hash");
      expect(up.stderr).toContain("0000deadbeef");
      expect(up.stderr).toContain("pifleet image build --toolchain");
      // All three diagnoses stay distinct. A gate that collapsed them would
      // send an operator to rebuild when the image is merely missing, or to
      // hunt a broken image when it is simply the wrong one.
      expect(up.stderr).not.toContain("NOT present");
      expect(up.stderr).not.toContain("FAILS verification");

      // AND IT COST NOTHING TO FIND OUT. This refusal is two `docker image
      // inspect` calls; not one container was started, where the verify
      // refusal above starts several. That is the ordering claim for the new
      // check specifically — it runs before verification, not after it.
      const docker = await readDockerCalls(rig);
      expect(docker.some((c) => c.includes("json .Config.Labels"))).toBe(true);
      expect(docker.filter((c) => c.startsWith("run "))).toEqual([]);
      expect(docker.filter((c) => c.startsWith("network "))).toEqual([]);
      expect(await gitOk(rig.repo, "remote")).toBe("");
      const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
      expect(runIds).toHaveLength(1);
      expect(await readdir(runPaths(runIds[0]!, rig.root).workersDir)).toEqual([]);
    },
    cliBudget(1),
  );

  test(
    "an image that is present AND verifies is accepted, and the run advances past the gate (ISC-189)",
    async () => {
      /**
       * THE POSITIVE CONTROL, and the two refusals above are worth nothing
       * without it: a gate that refused unconditionally would satisfy both.
       *
       * The ONLY difference from the test above is `shimPiVersion` — the
       * version the shimmed image reports. Everything else, the config
       * included, is identical.
       *
       * `network` ends in `-uplink`, which the shim answers NON-internal and
       * `ensureEgressNetwork` refuses to adopt. That is the step immediately
       * after the image gate, so its distinctively-worded failure is the
       * cheapest possible proof that the gate was passed rather than skipped.
       * Letting the run continue instead would mean waiting out a 60s idle
       * gate on containers this shim cannot start, to learn nothing more.
       */
      const rig = await makeRig({
        containerPath: true,
        imagePresent: true,
        shimPiVersion: PINNED_PI,
        network: `${NETWORK}-uplink`,
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--backend",
        "headless",
      ]);

      // The gate SAID it passed, naming the tag and the role it cleared.
      expect(up.stdout).toContain("present and verified");
      expect(up.stdout).toContain("engineer");
      // And it refused for the NEXT reason instead, which is the evidence that
      // execution continued rather than stopping here.
      expect(up.stderr).not.toContain("FAILS verification");
      expect(up.stderr).not.toContain("NOT present");
      expect(up.stderr).toContain("is NOT internal");
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);

      // The network WAS reached this time — the same log line whose absence
      // carries the ordering claim in the two refusals above.
      const docker = await readDockerCalls(rig);
      expect(docker.some((c) => c.startsWith("network inspect"))).toBe(true);
    },
    cliBudget(1),
  );

  test(
    "the Pi double keeps its exemption, and the gate is not consulted at all (ISC-32)",
    async () => {
      /**
       * The scope boundary, stated as a test rather than as a comment.
       *
       * `PIFLEET_PI_COMMAND` means "run the double instead of containers", and
       * `up` starts no container on that path — so there is no image for a
       * gate to be about, and demanding one would refuse every double run in
       * this repository for want of a build. This rig has NO image in the
       * shimmed store and must still reach a successful launch.
       *
       * It is also the guard on the other side: if the gate were ever moved
       * ahead of the double check, this test goes red immediately rather than
       * taking the whole integration suite with it in a way that reads as
       * unrelated breakage.
       */
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

      // Not merely "it worked": the image store was never asked.
      const docker = await readDockerCalls(rig);
      expect(docker.filter((c) => c.startsWith("image "))).toEqual([]);
    },
    cliBudget(1),
  );
});

/**
 * The container count follows `workers:` (ISC-61), measured AT THE CLI.
 *
 * WHY NOT AT THE MODULE, which is the whole point of this block. ISC-61 was
 * graded `[x]` for a long time on two tests that called library functions —
 * `renderAllWorkers` in `test/unit/render.test.ts` and `resolveAllWorkers` in
 * `test/unit/config.test.ts`. Both were true. Both remain true. And the
 * criterion was FALSE in production the entire time, in the direction the
 * wording least suggests: `renderAllWorkers` had ZERO callers in `src/`, and
 * `up` derived its launch set from argv alone with the commander default
 * `"eng-1"` — so `up --backend headless --json` with no `--workers` launched
 * exactly one worker called `eng-1` whether or not any config defined it, and
 * `--workers a1,b2,c3` launched three ids no config defined. Editing `workers:`
 * changed nothing about a run.
 *
 * So the assertion is on the `up --json` worker array, from the real CLI, with
 * two configs that differ in `workers:` LENGTH and in nothing else. A library
 * call cannot close this criterion, because a library call is what left it open.
 *
 * These rigs keep the Pi double, deliberately: this criterion is about the
 * COUNT, and the double is the only way to actually reach a launched,
 * idle fleet without a daemon. The image gate is not on this path — that is
 * the block above's subject, and mixing the two would make a failure here
 * ambiguous between them.
 */
describe("the container count follows workers:, at the CLI (ISC-61)", () => {
  /** `up --json`'s worker array, which is one entry per launched supervisor. */
  async function launchedWorkerIds(rig: Rig): Promise<string[]> {
    const up = await runCli(rig, ["up", "--config", rig.configPath, "--backend", "headless", "--json"]);
    expect(up.stderr === "" || up.code === EXIT.SUCCESS).toBe(true);
    expect(up.code).toBe(EXIT.SUCCESS);
    const parsed = JSON.parse(up.stdout.trim()) as {
      run_id: string;
      workers: { id: string; pid: number; pgid: number }[];
    };
    rig.runId = parsed.run_id;
    return parsed.workers.map((w) => w.id);
  }

  test(
    "adding entries to workers: adds workers to the run, with no other edit and no --workers",
    async () => {
      // ONE worker — the fixture's default document.
      const one = await makeRig();
      // THREE. The only difference between the two fleet.yaml files is two
      // extra lines in `workers:` (and the two role declarations they force,
      // which the schema requires and which name no behaviour).
      const three = await makeRig({
        extraWorkers: [
          { id: "rev-1", role: "reviewer" },
          { id: "qa-1", role: "qa" },
        ],
      });

      // NEITHER command passes `--workers`. That is the criterion: the count
      // has to come from the file.
      expect(await launchedWorkerIds(one)).toEqual(["eng-1"]);
      expect(await launchedWorkerIds(three)).toEqual(["eng-1", "rev-1", "qa-1"]);
    },
    // Two `bun run <cli>` `up` spawns, one per rig. Counted, not estimated.
    cliBudget(2),
  );

  test(
    "--workers still narrows the set it is given, and still wins over the file",
    async () => {
      /**
       * The half that must NOT change. `--workers` is an explicit operator
       * override, and Phase 1 depends on it naming ids that exist only on the
       * command line — a `PIFLEET_PI_COMMAND` double run has no config entry
       * to resolve, and most of this repo's integration suite runs that way.
       *
       * WHAT WAS DECIDED ABOUT UNDEFINED IDS: they are still accepted, exactly
       * as before. `assertModelsAllowed` skips them by an explicit membership
       * test (they have no configured model to check), and `up`'s image gate
       * skips them by the same set (they have no role and so no image). What
       * changed is only the DEFAULT — and on the default path every id came
       * from `workers:`, so both skips become unreachable and every worker is
       * checked. The skip narrowed; it did not widen.
       */
      const rig = await makeRig({
        extraWorkers: [
          { id: "rev-1", role: "reviewer" },
          { id: "qa-1", role: "qa" },
        ],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "rev-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const parsed = JSON.parse(up.stdout.trim()) as {
        run_id: string;
        workers: { id: string }[];
      };
      rig.runId = parsed.run_id;
      // One of the three, and the one named — not the config's first entry,
      // and not the old `"eng-1"` commander default, which this fleet also
      // happens to define and which a regression would silently produce.
      expect(parsed.workers.map((w) => w.id)).toEqual(["rev-1"]);
    },
    cliBudget(1),
  );

  test(
    "with no config there is no list to default to, and up says so instead of inventing one",
    async () => {
      /**
       * The old commander default was the literal string `"eng-1"`. Removing
       * it leaves exactly one shape with no launch set at all — no config AND
       * no `--workers` — and it has to be refused rather than answered with a
       * hard-coded id nobody named.
       *
       * `HOME` is redirected at an empty directory so implicit config
       * resolution genuinely finds nothing: without it this test would depend
       * on whether the developer happens to have `~/.config/pifleet/fleet.yaml`.
       * `cwd` is the rig's base for the same reason — `./fleet.yaml` must not
       * resolve to this repository's own.
       */
      const rig = await makeRig();
      const emptyHome = join(rig.base, "empty-home");
      await mkdir(emptyHome, { recursive: true });
      const up = await runCli(rig, ["up", "--backend", "headless", "--json"], {
        cwd: emptyHome,
        home: emptyHome,
      });
      expect(up.code).toBe(EXIT.USAGE);
      expect(up.stderr).toContain("no workers named");
      // And it did not quietly launch the id the old default carried.
      expect(up.stdout).not.toContain("eng-1");
    },
    cliBudget(1),
  );

  test(
    "--workers naming nothing is a usage error, not an empty fleet",
    async () => {
      const rig = await makeRig();
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        ",, ,",
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.USAGE);
      expect(up.stderr).toContain("no workers named");
      // Distinguished from the no-config message above: an operator who typed
      // the flag needs a different sentence from one who omitted it.
      expect(up.stderr).toContain("--workers was given");
    },
    cliBudget(1),
  );
});

/**
 * The backend `up` selects, and which input decided it (ISC-271).
 *
 * ISC-271 asks that a `fleet.yaml` setting `backend.kind` either GET that
 * backend or be REJECTED — never be silently overridden by the flag default.
 * Both halves are now provable and both are proven here:
 *
 *  - THE FLAG HALF. `--backend` carries no commander default any more, so "the
 *    operator typed it" and "nobody said anything" are different states, and
 *    the reported backend is the one actually selected.
 *  - THE CONFIG HALF. `BackendSchema.kind` is `.optional()` rather than
 *    `.default("cmux")`, so an absent `backend:` block, `backend: {}` and
 *    `backend: {kind: cmux}` are no longer three spellings of one parsed
 *    object. `up` can honour the third without forcing cmux onto the first two.
 *
 * WHAT `backend.kind` NOW COSTS AN OPERATOR, which is the fact the last test
 * in this block exists for. The field became binding in the same change that
 * made it optional, and binding cuts both ways: a config naming a backend this
 * host cannot present is now exit 3 and no fleet, where before the value was
 * read by nothing and every such run silently got headless. "The config
 * decided" is observable in `run.json` whatever the host can run; the
 * CONSEQUENCE of that decision is only observable on the path with no
 * `--backend-fallback`, and a criterion that pins the first without the second
 * grades the half that cannot hurt anyone.
 */
describe("which input decides the backend (ISC-271)", () => {
  test(
    "an explicit --backend still wins, and the run reports the backend it selected",
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
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string; backend: string };
      rig.runId = parsed.run_id;
      // Present AND correct. `backend` used to be the raw flag string, which
      // `JSON.stringify` would have dropped entirely once the commander
      // default was removed — a key that silently vanishes from a
      // machine-readable payload is worse than one that is wrong.
      expect(parsed.backend).toBe("headless");
      // The run record agrees with the payload. Two records of one fact that
      // can disagree is how the `--backend-fallback` case went wrong.
      const runDoc = (await Bun.file(runPaths(parsed.run_id, rig.root).runJson).json()) as {
        backend: string;
      };
      expect(runDoc.backend).toBe("headless");
    },
    cliBudget(1),
  );

  test(
    "with no --backend at all the run still starts, and still reports a real backend",
    async () => {
      /**
       * The regression guard on removing the commander default. `up` with no
       * `--backend` must keep selecting `headless` — the value every run in
       * this repository has been getting — rather than `undefined`, an empty
       * key, or a crash.
       */
      const rig = await makeRig();
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string; backend: string };
      rig.runId = parsed.run_id;
      expect(parsed.backend).toBe("headless");
    },
    cliBudget(1),
  );

  test(
    "a config setting backend.kind IS honoured when no --backend is given (ISC-271)",
    async () => {
      /**
       * The middle term of `explicit --backend > backend.kind > DEFAULT_BACKEND`.
       *
       * This test previously asserted the DEFECT — that `up` selected
       * `headless` despite the config saying `cmux` — and was written to go
       * red the day the schema made `kind` optional. That change has landed
       * (`BackendSchema.kind` is `.optional()`), so the test now asserts the
       * contract instead of the gap.
       *
       * The witness is `run.json`'s `backend`, which `up` writes from
       * `requestedBackend` BEFORE `resolveBackendWithFallback` runs — NOT
       * `--json`'s `backend`, which reports what was finally RESOLVED.
       *
       * That distinction is what makes this test portable, and it is not a
       * detail: whether a cmux server is reachable is a property of the
       * machine, so asserting the resolved value would pass on a developer's
       * Mac with cmux.app running and fail on `ubuntu-latest`, where the
       * fallback fires and resolves to headless. ISC-271 claims the CONFIG
       * DECIDED, and the requested value is where that decision is observable
       * regardless of what the host can actually run. `--backend-fallback` is
       * passed so the run completes either way.
       */
      const rig = await makeRig({ backendKind: "cmux" });
      expect(await Bun.file(rig.configPath).text()).toContain("kind: cmux");
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--backend-fallback",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string; backend: string };
      rig.runId = parsed.run_id;
      const doc = JSON.parse(
        await Bun.file(runPaths(rig.runId, rig.root).runJson).text(),
      ) as { backend: string };
      expect(doc.backend).toBe("cmux");
    },
    cliBudget(1),
  );

  test(
    "an explicit --backend still beats the config (ISC-271)",
    async () => {
      /**
       * The other direction, and the half that makes this a precedence rule
       * rather than an inversion. The criterion is that the flag's DEFAULT
       * must stop winning — not that the flag itself stops winning. An
       * operator who types `--backend headless` against a `kind: cmux` config
       * gets headless.
       */
      const rig = await makeRig({ backendKind: "cmux" });
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
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string; backend: string };
      rig.runId = parsed.run_id;
      const doc = JSON.parse(
        await Bun.file(runPaths(rig.runId, rig.root).runJson).text(),
      ) as { backend: string };
      expect(doc.backend).toBe("headless");
    },
    cliBudget(1),
  );

  test(
    "a config naming an unavailable backend, with no fallback, is exit 3 and NO fleet (ISC-271)",
    async () => {
      /**
       * THE OPERATOR-VISIBLE CONSEQUENCE of `backend.kind` becoming binding,
       * which the three tests above deliberately do not measure.
       *
       * Each of them either types `--backend` or passes `--backend-fallback
       * headless` "so the run completes either way", and then reads
       * `run.json`'s `backend` — a value `up` writes from `requestedBackend`
       * BEFORE `resolveBackendWithFallback` is reached. That proves the CONFIG
       * DECIDED and nothing about what the decision costs. This is the path
       * with no fallback, where `resolveBackendWithFallback` throws
       * `BackendUnavailableError` and the operator gets exit 3 and no fleet.
       *
       * It is the upgrade case stated as a test. `backend.kind` was parsed and
       * read by nothing until this change, so a `fleet.yaml` derived from the
       * shipped example has been running headless on every host regardless of
       * what it said; the same file on this build refuses. That is why the
       * shipped `fleet.example.yaml` no longer writes `kind:` live — see the
       * comment on that block — and this test is what keeps the refusal it
       * describes real rather than asserted in prose.
       *
       * ## WHY THIS IS PORTABLE, which the ISC-271 tests above had to buy by
       * ## asserting the requested value instead of the resolved one
       *
       * Whether cmux is present is a property of the machine: `/opt/homebrew/
       * bin/cmux` on the workstation this was written on, nothing at all on
       * `ubuntu-latest`. A test that let the real binary answer would take one
       * branch here and the other in CI — pass locally, fail in CI, or the
       * reverse — which is precisely what this file is forbidden to ship.
       *
       * So the machine does not get a vote. `makeRig` installs a `cmux` shim
       * FIRST on this rig's PATH (`writeCmuxShim`), and it answers every
       * invocation exit 1 with nothing on stdout, which is what an uninstalled
       * cmux looks like to `probeCmux`'s opening `cmux --version`. The shim
       * shadows a real cmux where one exists and supplies a definite answer
       * where none does, so BOTH hosts run the identical code path: probe →
       * `cmux-binary` required capability fails → no fallback → exit 3. The
       * only host-dependent input has been removed rather than tolerated, and
       * the log assertion below proves the shim was reached rather than
       * bypassed.
       *
       * That is the same discipline the `docker` and `gcloud` shims already
       * apply to this suite; cmux was simply the one external binary nothing
       * had pinned, because until `backend.kind` bound, no fixture could reach
       * it from a config.
       */
      const rig = await makeRig({ backendKind: "cmux" });
      expect(await Bun.file(rig.configPath).text()).toContain("kind: cmux");
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1",
        "--json",
      ]);

      // Exit 3, not 1 and not 0: `BackendUnavailableError` carries the code
      // structurally (contracts.ts) and the CLI maps it straight through.
      expect(up.code, `stderr: ${up.stderr.slice(0, 400)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
      // Named, actionable, and it says which input is missing. An operator
      // reading only "backend unavailable" reaches for the config; this one
      // tells them the flag that completes the run.
      expect(up.stderr).toContain("backend 'cmux' unavailable");
      expect(up.stderr).toContain("no --backend-fallback was given");

      // The primary really WAS probed. Without this, an `up` that refused for
      // some unrelated reason with a coincidentally matching message would
      // satisfy every assertion above.
      const cmuxLog = await Bun.file(rig.cmuxCalls)
        .text()
        .catch(() => "");
      expect(cmuxLog).toContain("--version");

      /**
       * The CONFIG is what asked for cmux — no `--backend` was typed. Read off
       * `run.json`, which `up` wrote before the resolution failed, so the two
       * halves of this test (what was requested, what it cost) rest on one
       * run rather than on two that could disagree.
       */
      const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
      expect(runIds).toHaveLength(1);
      const run = runPaths(runIds[0]!, rig.root);
      const doc = (await Bun.file(run.runJson).json()) as { backend: string };
      expect(doc.backend).toBe("cmux");

      /**
       * AND NO FLEET — measured on the SUPERVISOR's own records, not on the
       * worker directory.
       *
       * `workers/eng-1/` does exist by this point: `up` materializes each
       * worker's inputs long before it resolves a backend, so an
       * empty-directory assertion here would be pinning an ordering that is
       * not the one under test, and it would go red for the wrong reason
       * (measured: the directory is present with `eng-1` in it).
       *
       * `state.json` and `launch.json` are the files a SUPERVISOR writes about
       * ITSELF once it is running, so their absence is the honest statement of
       * "nothing was launched" — `state.json` specifically being the file
       * `down`'s anchor reads to decide there is a process to stop at all. That
       * is the half separating a clean refusal from a half-started run an
       * operator would then have to `down`.
       */
      const wp = workerPaths(run, "eng-1");
      expect(await Bun.file(wp.stateJson).exists()).toBe(false);
      expect(await Bun.file(wp.launchJson).exists()).toBe(false);
    },
    cliBudget(1),
  );
});

/**
 * `up` WARNS when a `tui` worker is launched into an unattended run
 * (TUI spec item 12), and says nothing for every other fleet.
 *
 * ## Why this is a CLI test and not another unit test
 *
 * `unattendedTuiWarning` and `runIsUnattended` are pure and are probed
 * exhaustively in `test/unit/tui-guards.test.ts`. The criterion is about
 * `pifleet up`, and this file's own header records what happens when the two
 * are confused: the `ensureEgressNetwork` and `detectRepoHazards` calls were
 * both deleted from `up.ts` with the whole suite green, because both controls
 * were tested as modules and held in place by nothing. Deleting the
 * `process.stderr.write(tuiWarning)` line would be that defect wearing a new
 * name, and only a run of the real CLI can see it.
 *
 * ## The exit both arms end on is deliberate, and is NOT the tui guard
 *
 * Both tests point `llm.base_url` at a dead port, so both runs end at the
 * ISC-53 native-tool-call probe with exit 3 — an unrelated failure STRICTLY
 * LATER in `up` than the warning. That is what makes the pair a controlled
 * comparison: the two runs differ in exactly one field of YAML, travel the
 * identical path, and reach the identical exit, so any difference on stderr is
 * the warning and nothing else. Letting a fleet actually come up would have
 * cost a real backend, a real pane and ninety seconds to observe one string.
 *
 * `--backend cmux` and not `headless`, because a tui worker on the EFFECTIVE
 * headless backend is refused (spec item 4's second half) by a guard that
 * fires earlier and would mask this one.
 *
 * **NOT COVERED HERE:** the attended arm. `spawnCli` gives the child three
 * pipes, so every run in this file is unattended by `runIsUnattended`'s stream
 * test and there is no pty to hand it. That a person at a terminal gets NO
 * warning is pinned in the unit suite only.
 */
describe("up warns about a tui worker in an unattended run (TUI spec item 12)", () => {
  /** A base_url that is real, free, and listening to nothing. */
  async function deadModelUrl(): Promise<string> {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    // `host.docker.internal` for the reason the ISC-53 test above records at
    // length: the probe runs from inside the egress network, and
    // `omlxRelayTarget` refuses any other host — a loopback spelling would
    // fail at the RELAY, one step earlier, with the same exit code.
    const url = `http://host.docker.internal:${probe.port}/v1`;
    await probe.stop(true);
    return url;
  }

  test(
    "a pane_mode: tui worker gets a warning naming what the mode gives up",
    async () => {
      const rig = await makeRig();
      const cfg = join(rig.base, "tui-unattended.yaml");
      await writeFile(
        cfg,
        fleetYaml(rig.repo, {
          requireNativeToolCalls: true,
          llmBaseUrl: await deadModelUrl(),
          roleFields: ["pane_mode: tui"],
        }),
      );
      const up = await runCli(rig, [
        "up",
        "--config",
        cfg,
        "--workers",
        "eng-1",
        "--backend",
        "cmux",
      ]);

      // The run ended where both arms of this pair end — after the warning.
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);

      // The worker, by name, and the count.
      expect(up.stderr).toContain("pane_mode: tui");
      expect(up.stderr).toContain("eng-1");
      expect(up.stderr).toContain("1 worker(s)");
      /**
       * And WHAT IS GIVEN UP. "Say what is being given up, not just that
       * something is" is the requirement; a warning that said only
       * "unattended tui run" would satisfy every assertion above this comment.
       */
      expect(up.stderr).toContain("pane_mode_tui_is_not_auto_schedulable");
      expect(up.stderr).toContain("docker kill --signal=INT");
      expect(up.stderr).toContain("transcript-derived");

      // On stderr, so a `--json` consumer's one-object stdout stays one object.
      expect(up.stdout).not.toContain("pane_mode");
    },
    cliBudget(1),
  );

  /**
   * THE CONTROL, and the assertion worth keeping if the rest were cut. It
   * differs from the arm above in ONE field of YAML. Every fleet anyone has
   * ever run is this shape, so a guard that fires here fires on everything.
   */
  test(
    "an rpc fleet — every fleet in this repository — gets no warning at all",
    async () => {
      const rig = await makeRig();
      const cfg = join(rig.base, "rpc-unattended.yaml");
      await writeFile(
        cfg,
        fleetYaml(rig.repo, {
          requireNativeToolCalls: true,
          llmBaseUrl: await deadModelUrl(),
        }),
      );
      const up = await runCli(rig, [
        "up",
        "--config",
        cfg,
        "--workers",
        "eng-1",
        "--backend",
        "cmux",
      ]);

      // Non-vacuous: the run really did travel the same path to the same exit,
      // so "no warning" is a difference in OUTPUT rather than in how far the
      // two runs got.
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("oMLX");

      expect(up.stderr).not.toContain("pane_mode");
      expect(up.stderr).not.toContain("docker kill --signal=INT");
    },
    cliBudget(1),
  );
});

/**
 * `up` refuses a `tui` worker on the EFFECTIVE headless backend (TUI spec item
 * 4's second half) — the residual Phase 1 declared and could not close.
 *
 * `config/schema.ts` refuses the document that SAYS `backend.kind: headless`,
 * and `test/unit/config.test.ts` still asserts — deliberately, unchanged — that
 * it does NOT refuse a document with no backend block. It cannot: `parseConfig`
 * has no `--backend` and no `DEFAULT_BACKEND`. This file is the other half, and
 * it needs the real CLI for two reasons a unit test cannot supply: only `up`
 * resolves `--backend > backend.kind > DEFAULT_BACKEND`, and only a process can
 * show the refusal arriving before anything is launched.
 *
 * The third test is the one that matters most to an operator. It is the same
 * config as the second with the `--backend` flag REMOVED, so headless comes
 * from `DEFAULT_BACKEND` — a document with no headless in it, refused for a
 * backend no line of it names.
 */
describe("up refuses a tui worker on the effective headless backend (TUI spec item 4)", () => {
  /** Nothing detached exists behind the refusal — the `up-wiring` house check. */
  async function expectNothingLaunched(rig: Rig): Promise<void> {
    const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
    // Non-vacuous: `up` mkdirs the run directory before it reads the config, so
    // the loop below must actually run.
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds) {
      const run = runPaths(runId, rig.root);
      expect(await readdir(run.workersDir)).toEqual([]);
      expect((await mergeLedger(run)).records).toEqual([]);
    }
  }

  test("--backend headless with a tui worker exits 2 and launches nothing", async () => {
    const rig = await makeRig();
    const cfg = join(rig.base, "tui-headless-flag.yaml");
    // No `backend:` block at all, so the SCHEMA passes this document — which is
    // exactly the surface Phase 1 recorded as out of its reach.
    await writeFile(
      cfg,
      fleetYaml(rig.repo, {
        requireNativeToolCalls: false,
        roleFields: ["pane_mode: tui"],
      }),
    );
    const up = await runCli(rig, [
      "up",
      "--config",
      cfg,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
    ]);

    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("eng-1");
    expect(up.stderr).toContain("pane_mode: tui");
    expect(up.stderr).toContain("headless");
    // WHICH input chose it, and the way out.
    expect(up.stderr).toContain("--backend");
    expect(up.stderr).toContain("--backend cmux");
    // A diagnosis, not a crash.
    expect(up.stderr).not.toContain("at async");

    await expectNothingLaunched(rig);
  }, cliBudget(1));

  /**
   * THE CONTROL. `--backend headless` is what every other test in this file
   * passes and what `DEFAULT_BACKEND` is; a guard that fired without a tui
   * worker would refuse the entire suite and every run this repo has ever done.
   */
  test("--backend headless with an rpc worker still starts normally", async () => {
    const rig = await makeRig();
    const cfg = join(rig.base, "rpc-headless.yaml");
    await writeFile(cfg, fleetYaml(rig.repo, { requireNativeToolCalls: false }));
    const up = await runCli(rig, [
      "up",
      "--config",
      cfg,
      "--workers",
      "eng-1",
      "--backend",
      "headless",
      "--json",
    ]);

    expect(up.code).toBe(EXIT.SUCCESS);
    rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
    // …and it genuinely came up, rather than merely exiting 0.
    const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
    expect(records.map((r) => r.event)).toContain("supervisor_launched");
  }, cliBudget(1));

  /**
   * The commoner accident, and the half Phase 1's note does not mention: no
   * flag, no `backend:` block, so `DEFAULT_BACKEND` answers. The refusal has to
   * say the default chose it — an operator told only "backend is headless"
   * would grep their fleet.yaml for a word that is not in it.
   */
  test(
    "no --backend and no backend block is refused, naming the built-in default",
    async () => {
      const rig = await makeRig();
      const cfg = join(rig.base, "tui-default-headless.yaml");
      await writeFile(
        cfg,
        fleetYaml(rig.repo, {
          requireNativeToolCalls: false,
          roleFields: ["pane_mode: tui"],
        }),
      );
      const up = await runCli(rig, ["up", "--config", cfg, "--workers", "eng-1"]);

      expect(up.code).toBe(EXIT.USAGE);
      expect(up.stderr).toContain("the built-in default");
      // It must not tell the operator they typed a flag they did not type.
      expect(up.stderr).not.toContain("chosen by --backend");
      await expectNothingLaunched(rig);
    },
    cliBudget(1),
  );
});

// ---------------------------------------------------------------------------
// ISC-410 — a DECLARED provider nothing resolves to is inert, ON THE `up` PATH
// ---------------------------------------------------------------------------

/**
 * `test/unit/relay-provider-bridges.test.ts` already proves the PLAN omits an
 * unused provider, and that the plan's input comes from workers the real config
 * loader resolved rather than from `Object.keys(llm.providers)`. That is a
 * strong pin on `egressBridgePlan` and it is not what this block adds.
 *
 * What nothing re-checked is that **`up` creates from the plan**. `up.ts` walks
 * `egressBridges` twice — once to `ensureEgressNetwork` every bridge, once to
 * `ensureBridgeRelay` every bridge — and either loop rewritten to walk the
 * DECLARED providers instead leaves `egressBridgePlan` untouched, every unit
 * test green, and ISC-410 false on the only path an operator ever runs. That is
 * this file's founding defect class verbatim: a control tested exhaustively as
 * a module and held in place by nothing.
 *
 * The criterion's own probe is `docker network ls` and `docker ps` on a live
 * three-provider fleet. This runs the REAL `up` against the PATH shim instead,
 * so it needs no daemon and lands in the fast job — and it pays for that with
 * `shimNetworkAbsent`, which makes the shimmed daemon report a network absent
 * until it has been created. Without it every `ensureEgressNetwork` takes its
 * adopt branch, no `network create` is ever issued, and the strongest available
 * assertion would be about which names `up` MENTIONED.
 *
 * ## Anti-vacuity, which is the whole risk in a negative claim
 *
 * "The string is absent from the log" passes trivially if the log is empty, if
 * `up` exited before the bridge loop, or if the config never reached that code.
 * So the absence is asserted alongside positives read out of THE SAME LOG: the
 * log is non-empty, and both USED providers' bridges, uplinks and relays were
 * created by name. A run that never got near the loop fails those before it
 * reaches the negative, which is the point — the positives are not decoration,
 * they are what makes the negative mean anything.
 *
 * Every expected name is DERIVED, through the same `providerNetworkName` /
 * `uplinkNetworkName` / `relayContainerName` the product composes with. A
 * literal would still pass if the composition changed, and `up` would then be
 * creating names this test never looks for.
 */
describe("a declared-but-unused provider creates nothing (ISC-410)", () => {
  /**
   * Two providers a worker names, one nothing names. The unused key is LAST so
   * a plan built from `Object.keys` would put it last too — an off-by-one that
   * dropped the final entry would then pass this test for the wrong reason —
   * and the three names are chosen so no derived name is a substring of any
   * other, which is what keeps `toContain` from being satisfied by an overlap.
   */
  const PROVIDERS = [
    {
      name: "alpha",
      hosted: false,
      baseUrl: "http://alpha.house.test:8000/v1",
      apiKeyEnv: "ALPHA_API_KEY",
      relayUpstream: "192.168.86.49:8000",
    },
    {
      name: "bravo",
      hosted: true,
      baseUrl: "https://bravo.example.test/v1",
      apiKeyEnv: "BRAVO_API_KEY",
      relayUpstream: "104.18.0.1:443",
    },
    {
      name: "charlie",
      hosted: true,
      baseUrl: "https://charlie.example.test/v1",
      apiKeyEnv: "CHARLIE_API_KEY",
      relayUpstream: "104.18.0.2:443",
    },
  ];

  const USED = ["alpha", "bravo"];
  const UNUSED = "charlie";

  test(
    "three declared, two resolved: only the two resolved bridges are created",
    async () => {
      const rig = await makeRig({
        providers: PROVIDERS,
        llmProvider: "alpha",
        shimNetworkAbsent: true,
        /**
         * EVERY provider's upstream is allowed, INCLUDING the unused one.
         *
         * The two used providers need it — `ensureBridgeRelay` refuses to
         * forward a destination the policy denies. Charlie does not need it and
         * that is exactly why it is here: with charlie's upstream denied, "no
         * network for charlie" would have a second, duller explanation, and a
         * `up` that DID iterate declared providers would fail on the policy
         * before it ever reached a `network create`. Allowing it removes the
         * alternative and leaves only the claim under test.
         */
        egressAllow: PROVIDERS.map((p) => ({
          host: p.relayUpstream.split(":")[0]!,
          port: Number(p.relayUpstream.split(":")[1]),
        })),
        // `eng-1` inherits `llm.provider: alpha`; `eng-2` SELECTS bravo through
        // its model prefix. Nothing anywhere selects charlie.
        extraWorkers: [{ id: "eng-2", role: "engineer", model: "bravo/wiring-test-model" }],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,eng-2",
        "--backend",
        "headless",
        "--json",
      ]);
      // `toMatchObject` on the pair rather than `toBe` on the code alone: a
      // refusal here is almost always a fixture problem (an unallowed relay
      // target, an undeclared provider), and the diff quotes `stderr` so the
      // cause is named HERE instead of being reconstructed from an exit code.
      // stderr is carried, never asserted — an unrelated warning must not turn
      // this test red.
      expect({ code: up.code, stderr: up.stderr }).toMatchObject({ code: EXIT.SUCCESS });
      rig.runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      const calls = await readDockerCalls(rig);
      // ANTI-VACUITY 1. An absent or empty log satisfies every negative below
      // without `up` having run a single docker command.
      expect(calls.length).toBeGreaterThan(0);

      const created = calls
        .filter((l) => l.startsWith("network create "))
        .map((l) => l.split(/\s+/).at(-1));

      // ANTI-VACUITY 2. The POSITIVE half, from the same log: both resolved
      // providers' bridges — and their uplinks — were created BY NAME. An `up`
      // that exited before the bridge loop, or one whose config never carried
      // the providers map, fails here rather than passing the negative below.
      for (const p of USED) {
        const net = providerNetworkName(NETWORK, p);
        expect(created).toContain(net);
        expect(created).toContain(uplinkNetworkName(net));
      }

      // …and each of those bridges got its relay STARTED, which is the second
      // half of what a bridge is. `run` argv only: an `inspect` of the same
      // name is `up` asking, not `up` creating.
      for (const p of USED) {
        const relay = relayContainerName(providerNetworkName(NETWORK, p));
        expect(calls.some((l) => l.startsWith("run ") && l.includes(relay))).toBe(true);
      }

      // THE CRITERION. The declared-and-unused provider's derived names appear
      // in NO docker argv of any kind — not created, not inspected, not
      // connected, not run. Absence from the whole log is strictly stronger
      // than absence from the create lines: `up` cannot have created a network
      // it never named.
      const unusedNet = providerNetworkName(NETWORK, UNUSED);
      const unusedNames = [unusedNet, uplinkNetworkName(unusedNet), relayContainerName(unusedNet)];
      for (const name of unusedNames) {
        // Asserted per name rather than per line so a failure reports WHICH
        // derived name leaked, not merely that some line was wrong.
        expect(calls.filter((l) => l.includes(name))).toEqual([]);
      }

      // The same claim once more against the COUNT, because every assertion
      // above is shaped "these are present / that one is not" and none of them
      // would notice a third bridge under a name nothing here predicts. Two
      // providers resolved: two bridges, two uplinks.
      expect(created.filter((n) => n !== undefined && n.startsWith(`${NETWORK}-`)).length).toBe(4);

      // And `up`'s own claim agrees with the daemon log. The ledger is the
      // surface an operator reads; a fleet that created two bridges while
      // reporting three would be lying in the direction ISC-410 cares about.
      const { records } = await mergeLedger(runPaths(rig.runId, rig.root));
      const readied = records
        .filter((r) => r.actor === "cli-up" && r.event === "egress_network_ready")
        .map((r) => r.detail?.["network"])
        .sort();
      expect(readied).toEqual(USED.map((p) => providerNetworkName(NETWORK, p)).sort());
    },
    // ISC-274 audit: stands. Two `up` spawns derive cliBudget(2) = 22_800 ms;
    // measured idle is 1965 ms (bun printed the per-test figure when this case
    // failed under the Object.keys mutation), 2.23 s wall for a filtered
    // single-test run including module load. Not reduced, for the reason every
    // ceiling in this file keeps 90_000: the derived value is the FLOOR the
    // audit checks against, not the value shipped.
    90_000,
  );
});

/**
 * The disclosure banner and the launch record name the same workers
 * (ISC-416, ISC-417).
 *
 * ## What "the same set" means, stated before it is asserted
 *
 * The two surfaces are produced at different moments and one of them is not
 * always produced at all, so "the same set" is not self-evident and a
 * comparison picked because it went green would be worth nothing. Three sets,
 * over one run:
 *
 *   W — the workers this run SELECTS (`--workers`).
 *   B — the worker ids the printed banner names.
 *   L — the workers with a `launch.json` on disk.
 *   D — the members of L whose record carries a non-null `disclosure`.
 *
 * **ISC-416 is `B` against the world:** the banner names every worker whose
 * context leaves the machine, compared against a set typed into this file as a
 * LITERAL, over W. It cannot be compared against anything `disclosureFor`
 * produces, because that is the function under test — if it wrongly returned
 * `null` for a worker that should be disclosed, the banner would omit it, the
 * record would omit it, and any comparison between the two would agree
 * perfectly while both were wrong. That is the "asserted against itself" shape,
 * and only a literal from a config this file wrote can see through it.
 *
 * **ISC-417 is the two surfaces against each other: `D = B ∩ L`.**
 *
 * Scoped to `L` because the anti-criterion's subject is a worker STOOD UP
 * silently, and a worker `up` never stood up cannot have been. That is not a
 * convenience: `WorkerLaunchSchema`'s own docblock defines a missing record as
 * meaning the run went through the `PIFLEET_PI_COMMAND` double, "which starts
 * no container". The double run below is that case, held as its own test so
 * the boundary is visible rather than inferred.
 *
 * **On the container-path run below `L = W`, so `B ∩ L` collapses to `B` and
 * the assertion is full equality.** The intersection exists to keep the
 * criterion WELL-DEFINED on a partial run — one refused after some records
 * were written — not to soften it here.
 *
 * A mismatch fails in EITHER direction and both have a witness on disk:
 *
 *   - a record marked hosted whose worker the banner never named is a SILENT
 *     STAND-UP — the operator was told nothing about a worker already talking
 *     to a vendor, which is the whole of what §7.3's banner is the control for;
 *   - a banner row whose own launch record carries no disclosure means the
 *     recorded answer contradicts what the operator was told, and §7.3 wants
 *     the record precisely so "was this run's ticket credential exposed to a
 *     vendor" has an answer rather than a reconstruction.
 *
 * Neither direction is `⊆` in disguise: `D ⊆ B` alone would let a banner
 * promise go unrecorded, and `B ⊆ D` alone would let a record name a worker
 * nobody was told about.
 *
 * ## Anti-vacuity, which is where a set comparison goes to die
 *
 * `∅ = ∅ ∩ ∅` is true. Every guard below exists because some way of reaching
 * that is reachable by a real mutation:
 *
 *   - `L = W` is asserted, so deleting every launch record does not empty the
 *     domain into agreement;
 *   - the banner PARSE is asserted to have found exactly `|D|` rows, so a regex
 *     that silently matched nothing cannot supply `B = ∅`;
 *   - the fixture has both a hosted and a non-hosted launched worker, so
 *     neither "everything is disclosed" nor "nothing is" satisfies it;
 *   - `provider` and `cloud_access` vary across the disclosed rows, so a row
 *     that hard-coded either value fails;
 *   - each row is asserted to appear on exactly ONE stream, so a banner written
 *     to both cannot be quietly deduped into looking correct.
 *
 * ## Why this rig refuses, and why that is the right probe
 *
 * `containerPath: true` is what makes `up` write launch records at all — the
 * double writes none. Against the docker PATH shim such a run reaches
 * `assertBindMountsVisible` and exits 3, and it does so in about 1.7s rather
 * than waiting out the 60s idle gate on containers this shim cannot start.
 * Every worker's record is on disk by then, because materialization precedes
 * that guard. The refusal is therefore AFTER the state these criteria are about
 * and is not part of them — and `L = W` is asserted rather than assumed, so a
 * refusal that ever moved EARLIER would fail this file instead of quietly
 * shrinking the domain it compares over.
 */
describe("the disclosure banner and the launch record name the same workers (ISC-416, ISC-417)", () => {
  /** Must match `fleetYaml`'s `docker.pi_version`, as in the ISC-32 block. */
  const PINNED_PI_VERSION = "0.79.6";

  /**
   * One local provider and two hosted ones.
   *
   * TWO hosted providers rather than one so `provider` VARIES across the
   * disclosed rows: with a single vendor a row that printed a constant would
   * pass. The names are chosen so none is a substring of another.
   */
  const PROVIDERS = [
    {
      name: "alpha",
      hosted: false,
      baseUrl: "http://alpha.house.test:8000/v1",
      apiKeyEnv: "ALPHA_API_KEY",
      relayUpstream: "192.168.86.49:8000",
    },
    {
      name: "bravo",
      hosted: true,
      baseUrl: "https://bravo.example.test/v1",
      apiKeyEnv: "BRAVO_API_KEY",
      relayUpstream: "104.18.0.1:443",
    },
    {
      name: "charlie",
      hosted: true,
      baseUrl: "https://charlie.example.test/v1",
      apiKeyEnv: "CHARLIE_API_KEY",
      relayUpstream: "104.18.0.2:443",
    },
  ];

  /**
   * W. `eng-1` and `eng-2` inherit `llm.provider: alpha`; the other two select
   * a hosted provider through their model prefix.
   *
   * TWO undisclosed workers rather than one, and the reason is a mutation
   * rather than symmetry. With a single undisclosed worker, ANY defect that
   * records a row for a worker the banner never named necessarily records one
   * for every worker — `L \ D` empties, and the non-degeneracy guard fires
   * before the set comparison is ever reached. The comparison would then never
   * be shown to catch that direction, only the guard. A second undisclosed
   * worker leaves `L \ D` non-empty under a one-worker mutation, so the
   * EQUALITY is what reddens and the direction it names is the real one.
   */
  const SELECTED = ["eng-1", "eng-2", "rev-1", "qa-1"];

  /**
   * THE LITERAL — ISC-416's expectation, and the one set in this file that does
   * not come from the code under test.
   *
   * It is derived by hand from `PROVIDERS` and the worker list below: `rev-1`
   * resolves to `bravo` and `qa-1` to `charlie`, both `hosted: true`; `eng-1`
   * resolves to `alpha`, which is not. If someone edits the fixture without
   * editing this, the test fails — which is the correct cost of an expectation
   * that refuses to be derived from the thing it is checking.
   */
  const HOSTED_BY_FIXTURE = ["qa-1", "rev-1"];

  /**
   * `cloud_access` per disclosed worker, also a literal.
   *
   * `rev-1` holds a Google identity and `qa-1` does not, which is what makes
   * this field discriminating — and it is the D10 case §7.4 names as the one to
   * watch, so the banner claiming it correctly is not a detail.
   */
  const CLOUD_ACCESS_BY_FIXTURE: Record<string, string> = { "rev-1": "true", "qa-1": "false" };

  /**
   * A banner row, parsed on STRUCTURE rather than on prose.
   *
   * The row lines are `key=value` and the header and footer are sentences, so
   * this pins exactly the fields ISC-416 is about and stays green if the header
   * is later reworded — while a change to the ROW format reddens it, which is
   * correct, because the row IS the surface the criterion is about.
   *
   * A substring search for a worker id was rejected outright: `up` also prints
   * `eng-1: 1 hazard(s) in its checkout` and `rev-1: /…/worktrees/rev-1 on
   * fleet/…`, so `text.includes(id)` is satisfied by output with nothing to do
   * with disclosure, and `B` would be right for the wrong reason on a run whose
   * banner printed nothing at all.
   */
  const ROW = /^(?:!!| {2}) (\S+) {2}role=(\S+) {2}provider=(\S+) {2}isolation=(\S+) {2}repo=(.*)$/;

  interface BannerRow {
    workerId: string;
    role: string;
    provider: string;
    isolation: string;
    repo: string;
  }

  function bannerRows(text: string): BannerRow[] {
    const out: BannerRow[] = [];
    for (const line of text.split("\n")) {
      const m = ROW.exec(line);
      if (m === null) continue;
      out.push({
        workerId: m[1]!,
        role: m[2]!,
        provider: m[3]!,
        isolation: m[4]!,
        repo: m[5]!,
      });
    }
    return out;
  }

  /** The `cloud_access=` continuation line for one worker, five spaces in. */
  function cloudAccessFor(text: string, workerId: string): string | null {
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      const m = ROW.exec(line);
      if (m === null || m[1] !== workerId) continue;
      const next = lines[i + 1] ?? "";
      const c = /^ {5}cloud_access=(\S+) {2}secrets=(.*)$/.exec(next);
      return c === null ? null : c[1]!;
    }
    return null;
  }

  /**
   * L and its records, read through `WorkerLaunchSchema` rather than as raw
   * JSON: a record that stopped satisfying the contract must fail HERE, where
   * the file is named, rather than as a missing property three assertions away.
   */
  async function launchRecords(
    rig: Rig,
    ids: readonly string[],
  ): Promise<Map<string, ReturnType<typeof WorkerLaunchSchema.parse>>> {
    const runIds = (await readdir(rig.root)).filter((e) => !e.startsWith("."));
    expect(runIds).toHaveLength(1);
    rig.runId = runIds[0]!;
    const run = runPaths(rig.runId, rig.root);
    const out = new Map<string, ReturnType<typeof WorkerLaunchSchema.parse>>();
    for (const id of ids) {
      const p = workerPaths(run, id).launchJson;
      if (!(await Bun.file(p).exists())) continue;
      out.set(id, WorkerLaunchSchema.parse(await Bun.file(p).json()));
    }
    return out;
  }

  /** The three-provider fleet, on the path that actually writes launch records. */
  async function hostedRig(opts: { containerPath: boolean }): Promise<Rig> {
    return makeRig({
      containerPath: opts.containerPath,
      imagePresent: opts.containerPath,
      ...(opts.containerPath ? { shimPiVersion: PINNED_PI_VERSION } : {}),
      providers: PROVIDERS,
      llmProvider: "alpha",
      // Every provider's upstream, including the two hosted ones:
      // `ensureBridgeRelay` refuses to forward a destination the policy denies,
      // and a refusal there would stop the run before any record was written.
      egressAllow: PROVIDERS.map((p) => ({
        host: p.relayUpstream.split(":")[0]!,
        port: Number(p.relayUpstream.split(":")[1]),
      })),
      extraWorkers: [
        // Second undisclosed worker — see `SELECTED` for why there are two.
        { id: "eng-2", role: "engineer" },
        { id: "rev-1", role: "reviewer", model: "bravo/wiring-test-model", cloudAccess: true },
        { id: "qa-1", role: "qa", model: "charlie/wiring-test-model" },
      ],
    });
  }

  test(
    "the banner names every hosted worker and no other, and the SAME set is in the launch records (ISC-416)",
    async () => {
      const rig = await hostedRig({ containerPath: true });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        SELECTED.join(","),
        "--backend",
        "headless",
      ]);

      // The rig's refusal, stated so a DIFFERENT failure is not mistaken for
      // the expected one. Exit 3 at the mount preflight is this shim's floor
      // (see the block header); anything else means the run stopped somewhere
      // this test has not reasoned about, and the sets below would be measured
      // over a state nobody chose.
      expect({ code: up.code, stderr: up.stderr.slice(-400) }).toMatchObject({
        code: EXIT.BACKEND_UNAVAILABLE,
      });
      expect(up.stderr).toContain("bind-mount source(s) are not visible");

      // ---------------------------------------------------------------
      // B, and the two-stream rule. Exactly one stream carries each row;
      // a banner written to both would double-count, and a parser that
      // deduped would hide it.
      // ---------------------------------------------------------------
      const onOut = bannerRows(up.stdout);
      const onErr = bannerRows(up.stderr);
      expect(onErr).toEqual([]);
      const rows = onOut;

      // THE PARSE ITSELF, asserted before anything is concluded from it. A
      // regex that matched nothing would supply `B = ∅`, and `∅ = ∅ ∩ L` is
      // true — the criterion would pass on a banner that printed nothing.
      expect(rows).toHaveLength(HOSTED_BY_FIXTURE.length);

      // ISC-416, against the LITERAL rather than against the derivation.
      const B = rows.map((r) => r.workerId).sort();
      expect(B).toEqual([...HOSTED_BY_FIXTURE].sort());

      // And the row CONTENT, from the same literal — `provider` varies across
      // the two rows, so a banner printing a constant fails here.
      const byId = new Map(rows.map((r) => [r.workerId, r]));
      expect(byId.get("rev-1")).toMatchObject({
        role: "reviewer",
        provider: "bravo",
        isolation: "worktree",
        repo: rig.repo,
      });
      expect(byId.get("qa-1")).toMatchObject({
        role: "qa",
        provider: "charlie",
        isolation: "worktree",
        repo: rig.repo,
      });
      for (const [id, expected] of Object.entries(CLOUD_ACCESS_BY_FIXTURE)) {
        expect(cloudAccessFor(up.stdout, id)).toBe(expected);
      }

      // ---------------------------------------------------------------
      // The RECORD half of ISC-416 — "the SAME list appears in the launch
      // record", and its probe: "a hosted worker missing from it fails".
      // ---------------------------------------------------------------
      const records = await launchRecords(rig, SELECTED);
      // L = W. Without this the record comparison could be over a shrunken
      // domain and nobody would see it.
      expect([...records.keys()].sort()).toEqual([...SELECTED].sort());

      const D = [...records.entries()]
        .filter(([, r]) => r.disclosure !== null)
        .map(([id]) => id)
        .sort();
      expect(D).toEqual([...HOSTED_BY_FIXTURE].sort());

      // The non-hosted worker's record says `null` — a DECISION, not an
      // omission. Without this the field could be "always present" and the
      // set comparison above would still hold.
      expect(records.get("eng-1")!.disclosure).toBeNull();

      // The recorded row, field by field, against the same literal the banner
      // was checked against. `worker_id` is compared to the DIRECTORY the file
      // was read from, which is what makes a row written into the wrong
      // worker's record a failure rather than a relabelling.
      expect(records.get("rev-1")!.disclosure).toMatchObject({
        worker_id: "rev-1",
        role: "reviewer",
        provider: "bravo",
        isolation: "worktree",
        repo: rig.repo,
        cloud_access: true,
      });
      expect(records.get("qa-1")!.disclosure).toMatchObject({
        worker_id: "qa-1",
        role: "qa",
        provider: "charlie",
        isolation: "worktree",
        repo: rig.repo,
        cloud_access: false,
      });

      /*
       * The two routes to the granted names, compared on disk.
       *
       * `secret_names` at the top level copies `WorkerEnvPlan.secretNames` (the
       * DELIVERED grant); `disclosure.secret_names` copies the row's
       * `secretNames` (the deduped REQUEST). They are equal only because every
       * exclusion in `buildWorkerEnv`'s grant loop throws rather than skipping.
       *
       * STATED PLAINLY: on this fixture both are EMPTY, because
       * `up-wiring.test.ts`'s rig has no knob for granting a worker `secrets:`.
       * So this is a shape check, not a drift detector — it would not catch a
       * throw turned into a `continue`. `test/unit/disclosure.test.ts` carries
       * that equality properly; this is here so the two fields are compared at
       * all on the real write path, and the residual is written down rather
       * than left to be discovered by whoever trusts this line.
       */
      for (const id of HOSTED_BY_FIXTURE) {
        const r = records.get(id)!;
        expect(r.disclosure!.secret_names).toEqual(r.secret_names);
      }
    },
    cliBudget(1),
  );

  test(
    "a mismatch between the banner and the record fails in EITHER direction (ISC-417)",
    async () => {
      const rig = await hostedRig({ containerPath: true });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        SELECTED.join(","),
        "--backend",
        "headless",
      ]);
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);

      const rows = bannerRows(up.stdout);
      // The parse, again asserted non-empty before it is used — this test can
      // be run alone and must not be able to pass on an empty banner.
      expect(rows.length).toBeGreaterThan(0);
      const B = new Set(rows.map((r) => r.workerId));

      const records = await launchRecords(rig, SELECTED);
      const L = new Set(records.keys());
      // The domain, pinned. `L = W` here, so `B ∩ L` below is `B` — the
      // intersection is what keeps this well-defined on a PARTIAL run, and
      // this assertion is what stops it becoming an escape hatch on this one.
      expect([...L].sort()).toEqual([...SELECTED].sort());

      const D = new Set(
        [...records.entries()].filter(([, r]) => r.disclosure !== null).map(([id]) => id),
      );

      // Both sides non-degenerate: at least one launched worker IS disclosed
      // and at least one is NOT. Without this, "all" and "none" both satisfy
      // an equality that then means nothing.
      expect(D.size).toBeGreaterThan(0);
      expect(L.size - D.size).toBeGreaterThan(0);

      // THE CRITERION: D = B ∩ L.
      const expected = [...B].filter((id) => L.has(id)).sort();
      expect([...D].sort()).toEqual(expected);

      // Stated once more as the two directions the criterion names, so a
      // failure message says WHICH way it broke rather than printing two sets
      // and leaving the reader to diff them.
      expect([...D].filter((id) => !B.has(id))).toEqual([]); // stood up, never announced
      expect(expected.filter((id) => !D.has(id))).toEqual([]); // announced, not recorded
    },
    cliBudget(1),
  );

  test(
    "on the Pi double the banner still prints and there is no record to compare it to (ISC-417 boundary)",
    async () => {
      /**
       * The case that makes the scope of ISC-417 explicit rather than implied.
       *
       * `PIFLEET_PI_COMMAND` starts no container, so `up` writes no launch
       * record — `WorkerLaunchSchema`'s docblock calls that absence meaningful
       * and not a gap. `L` is therefore empty and `D = B ∩ L` is vacuously
       * true, which is CORRECT: nothing was stood up, so nothing was stood up
       * silently.
       *
       * It is a test rather than a comment because the tempting "fix" for a
       * vacuous case is to widen the comparison to W — and that would make
       * ISC-417 fail on every double run in this repository, for a fleet that
       * disclosed perfectly and created nothing. The banner still prints, which
       * is the half that must NOT be conditional on the launch path: the double
       * sends real context to a real vendor.
       */
      const rig = await hostedRig({ containerPath: false });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        SELECTED.join(","),
        "--backend",
        "headless",
      ]);
      expect({ code: up.code, stderr: up.stderr.slice(-400) }).toMatchObject({
        code: EXIT.SUCCESS,
      });

      // B is unchanged by the launch path.
      const rows = bannerRows(up.stdout);
      expect(rows).toHaveLength(HOSTED_BY_FIXTURE.length);
      expect(rows.map((r) => r.workerId).sort()).toEqual([...HOSTED_BY_FIXTURE].sort());

      // And L is empty — for every selected worker, not just the disclosed ones.
      const records = await launchRecords(rig, SELECTED);
      expect([...records.keys()]).toEqual([]);
    },
    cliBudget(1),
  );
});

describe("up discloses what leaves the machine (ISC-414, ISC-415)", () => {
  /**
   * A value that must never reach a terminal. `secretNames` is a `string[]` of
   * NAMES and structurally cannot carry this, which is the whole reason the
   * type is what it is — so finding it in a stream is proof of a real leak
   * rather than a formatting slip.
   */
  const TICKET_VALUE = "sentinel-ticket-value-e41d";

  const DISCLOSURE_PROVIDERS = [
    {
      name: "alpha",
      hosted: false,
      baseUrl: "http://alpha.house.test:8000/v1",
      apiKeyEnv: "ALPHA_API_KEY",
      relayUpstream: "192.168.86.49:8000",
    },
    {
      name: "bravo",
      hosted: true,
      baseUrl: "https://bravo.example.test/v1",
      apiKeyEnv: "BRAVO_API_KEY",
      relayUpstream: "104.18.0.1:443",
    },
  ];

  /**
   * The banner's row grammar, parsed rather than substring-matched.
   *
   * A `toContain("cred-1")` against whole stdout passes when `cred-1` appears
   * in the success summary and the banner never printed at all — which is
   * precisely the silent bring-up ISC-417 forbids, sailing past a green test.
   * Parsing rows means an assertion about the BANNER can only be satisfied by
   * the banner.
   */
  interface ParsedRow {
    mark: string;
    id: string;
    role: string;
    provider: string;
    isolation: string;
    repo: string;
    cloudAccess: string;
    secrets: string[];
  }

  /**
   * BOTH of a row's lines are parsed, and the second one is why.
   *
   * A `expect(up.stderr).toContain("TICKET_API_TOKEN")` looks like it asserts
   * the banner discloses the grant. It does not, and this was caught by a
   * mutation rather than by reading: `up` ALREADY prints an unrelated
   * `pifleet: sec-1 is granted host secrets by name: TICKET_API_TOKEN` line to
   * stderr, so that assertion stayed green with the banner's secret list
   * emptied — the exact "a green test certifies the wrong thing" failure this
   * repo keeps closing. Reading the name off the row's OWN continuation line
   * means only the banner can satisfy it.
   */
  const bannerRows = (text: string): ParsedRow[] => {
    const lines = text.split("\n");
    const out: ParsedRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const head = /^(!!|  ) (\S+)  role=(\S+)  provider=(\S+)  isolation=(\S+)  repo=(.*)$/.exec(
        lines[i]!,
      );
      if (head === null) continue;
      // The continuation line is part of the ROW, so a banner that printed a
      // head with no tail is malformed and must not parse as a valid row.
      const tail = /^ {5}cloud_access=(\S+)  secrets=(.*)$/.exec(lines[i + 1] ?? "");
      expect({ id: head[2], tail: lines[i + 1] }).toMatchObject({ id: head[2] });
      if (tail === null) continue;
      out.push({
        mark: head[1]!,
        id: head[2]!,
        role: head[3]!,
        provider: head[4]!,
        isolation: head[5]!,
        repo: head[6]!,
        cloudAccess: tail[1]!,
        secrets: tail[2] === "(none)" ? [] : tail[2]!.split(","),
      });
    }
    return out;
  };

  /**
   * `await makeRig(` spelled out rather than returned bare, and that is not a
   * style choice: the `afterAll` hook's budget is counted with
   * `grep -c 'await makeRig('`, so a helper that returned the promise
   * unawaited would add two rigs the counting command cannot see — the exact
   * silent drift that hook's docstring has already recorded three times.
   */
  const disclosureRig = async () =>
    await makeRig({
      providers: DISCLOSURE_PROVIDERS,
      llmProvider: "alpha",
      requireNativeToolCalls: false,
      egressAllow: DISCLOSURE_PROVIDERS.map((p) => ({
        host: p.relayUpstream.split(":")[0]!,
        port: Number(p.relayUpstream.split(":")[1]),
      })),
      secretsAllowlist: ["TICKET_API_TOKEN"],
      hostSecrets: { TICKET_API_TOKEN: TICKET_VALUE },
      extraWorkers: [
        // ISC-414: hosted provider AND a Google identity. The draft refused
        // exactly this worker.
        {
          id: "cred-1",
          role: "engineer",
          model: "bravo/wiring-test-model",
          cloudAccess: true,
        },
        // ISC-415: hosted provider AND a granted secret. The draft refused
        // this one too.
        {
          id: "sec-1",
          role: "engineer",
          model: "bravo/wiring-test-model",
          secrets: ["TICKET_API_TOKEN"],
        },
      ],
    });

  test(
    "a credentialled worker on a hosted provider stands up, and up says so on stdout",
    async () => {
      const rig = await disclosureRig();
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,cred-1,sec-1",
        "--backend",
        "headless",
      ]);
      // HALF ONE OF BOTH CRITERIA. D10 permits this configuration; a refusal
      // here is the draft behaviour reinstated. `stderr` is quoted in the diff
      // so a fixture problem names itself instead of arriving as a bare 2.
      expect({ code: up.code, stderr: up.stderr }).toMatchObject({ code: EXIT.SUCCESS });
      // The non-json path prints `run <id>` rather than a JSON payload, so the
      // id for teardown is read from that line.
      const runId = /^run (\S+)$/m.exec(up.stdout)?.[1];
      // ANTI-VACUITY: the run really did come up, so "it was not refused" is a
      // fact about a fleet rather than about an early exit.
      expect(runId).toBeDefined();
      rig.runId = runId as string;

      // HALF TWO. The banner, on stdout, parsed as rows.
      const rows = bannerRows(up.stdout);
      expect(rows.map((r) => r.id).sort()).toEqual(["cred-1", "sec-1"]);

      // The NON-hosted worker is absent — asserted on rows, since `eng-1` also
      // appears in `up`'s success summary further down the same stream.
      expect(rows.some((r) => r.id === "eng-1")).toBe(false);

      // Every field §7.3 names, on the rows that carry it.
      for (const row of rows) {
        expect(row.provider).toBe("bravo");
        expect(row.role).toBe("engineer");
        expect(row.isolation).toBe("worktree");
        // §7.3: the credentialled line is the most conspicuous one `up` prints.
        expect(row.mark).toBe("!!");
      }

      /*
       * ISC-414 and ISC-415, read off the ROWS rather than off the stream.
       *
       * `cred-1` holds the Google identity and no secret; `sec-1` holds the
       * granted secret and no identity. Asserting each on its own worker is
       * what makes the two criteria separable — a banner that carried one
       * field for both workers, or that leaked `sec-1`'s grant onto `cred-1`,
       * fails here rather than satisfying a stream-wide `toContain`.
       */
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("cred-1")?.cloudAccess).toBe("true");
      expect(byId.get("cred-1")?.secrets).toEqual([]);
      expect(byId.get("sec-1")?.cloudAccess).toBe("false");
      expect(byId.get("sec-1")?.secrets).toEqual(["TICKET_API_TOKEN"]);

      // NAMES ONLY. The widest-audience surface this feature has — a terminal,
      // then scrollback, then a screen share.
      expect(up.stdout).not.toContain(TICKET_VALUE);
      expect(up.stderr).not.toContain(TICKET_VALUE);
    },
    // One `up` spawn. Counted, not estimated.
    cliBudget(1),
  );

  /**
   * THE TWO-SIDED `--json` PROBE.
   *
   * `--json`'s payload is a single object every machine consumer parses —
   * every `JSON.parse(up.stdout.trim())` in this file is one — so the banner
   * cannot go to stdout on that path without crashing the consumers it is
   * meant to inform. It is REDIRECTED to stderr, never suppressed.
   *
   * Both directions are asserted IN ONE RUN, and that is the entire point of
   * the test. "Absent from stdout" alone passes when the banner was dropped
   * altogether — a silent bring-up of a credentialled worker on a vendor,
   * reached through the flag a script is most likely to use, which is ISC-417's
   * forbidden state arriving green. "Present on stderr" alone says nothing
   * about whether stdout still parses. Neither half is worth anything without
   * the other.
   */
  test(
    "--json keeps stdout parseable and moves the same banner to stderr",
    async () => {
      const rig = await disclosureRig();
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,cred-1,sec-1",
        "--backend",
        "headless",
        "--json",
      ]);
      expect({ code: up.code, stderr: up.stderr }).toMatchObject({ code: EXIT.SUCCESS });

      // DIRECTION ONE: stdout is still a single parseable object. This is the
      // assertion that fails if the banner is written to stdout under --json.
      const parsed = JSON.parse(up.stdout.trim()) as { run_id: string };
      rig.runId = parsed.run_id;
      expect(rig.runId).toBeDefined();
      expect(bannerRows(up.stdout)).toHaveLength(0);
      expect(up.stdout).not.toContain("DISCLOSURE");

      // DIRECTION TWO: it is on stderr, naming the SAME workers the non-json
      // run named. Dropping the banner passes direction one and fails here.
      expect(up.stderr).toContain("DISCLOSURE");
      const rows = bannerRows(up.stderr);
      expect(rows.map((r) => r.id).sort()).toEqual(["cred-1", "sec-1"]);
      // Off the rows, never off the stream — `up` prints an unrelated grant
      // line naming the same variable to this very stream. See `bannerRows`.
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("cred-1")?.cloudAccess).toBe("true");
      expect(byId.get("sec-1")?.secrets).toEqual(["TICKET_API_TOKEN"]);
      expect(up.stderr).not.toContain(TICKET_VALUE);
    },
    cliBudget(1),
  );
});

/**
 * A container-path `up` can reach a SUCCESSFUL run against this file's shim
 * (ISC-429).
 *
 * ## The defect, named
 *
 * The mount-probe branch of `writeDockerShim` rewrites production's own probe
 * script by building one `sed` program out of two `s###g` commands per `-v`
 * flag. Those commands used to be joined with `; `, which put the whole program
 * on ONE LINE.
 *
 * macOS's BSD `sed` reads a script in 4096-byte pieces and treats a piece
 * boundary as a line break — whether the script arrives as an argument or
 * through `-f`. Measured here on darwin 25.6: a single-line program of 4095
 * bytes compiles, one of 4102 dies with `unterminated substitute pattern`
 * reported against "line 2". Newlines are read first, so a program whose every
 * LINE is short has no ceiling at all: 42 kB compiles fine.
 *
 * `ensureEgressRelay`'s probe carries 3 mounts and builds a 694-byte program,
 * which is why the relay half always worked. `up`'s worker probe carries
 * several mounts per worker over absolute `$TMPDIR` paths — 6,608 bytes for a
 * four-worker fleet — and crossed the boundary every single time.
 *
 * ## Why it presented as silence rather than as an error
 *
 * The branch ended `printf … | sed "$sedexpr" | sh`, and a pipeline's exit
 * status is its LAST command's. `sed` aborted, wrote nothing, and `sh` read an
 * empty script and exited 0 — so the shim reported SUCCESS WITH NO OUTPUT.
 * `probeBindMountSources` reads `code === 0` and an unparseable (empty) stdout
 * as "the probe container reported nothing about this path", once per mount,
 * and `assertBindMountsVisible` refuses the launch with exit 3. The diagnosis
 * an operator saw was about the container; the fault was in the shim's `sed`.
 *
 * Both halves are fixed: one command per line removes the ceiling, and the
 * rewrite's exit status is now checked separately from `sh`'s, so a future
 * failure there is loud.
 *
 * ## What this block is for
 *
 * ISC-429 records the consequence as a COVERAGE HOLE. Every container-path run
 * in this file stopped at that guard, so nothing here could assert what a
 * COMPLETED container-path run does. Getting past the guard is necessary and
 * not sufficient: the run then reaches `up`'s idle gate, where a supervisor
 * waits on a container this shim cannot start. `PIFLEET_SHIM_WORKER_PI` — the
 * opt-in worker stand-in — closes that half, and the first test below is the
 * criterion's own probe: a container-path `up` that exits 0.
 *
 * ## The vacuity this block has to answer, said before the tests
 *
 * A shim can be made to satisfy "one `up` exits 0" by answering everything
 * affirmatively, which turns a test double into a rubber stamp and silently
 * guts every other assertion in this file. The fix must therefore keep the
 * property the branch's own comment claims: **a source that genuinely does not
 * exist still reports `x`, and the guard still refuses.**
 *
 * Test 2 is that control, and it is driven at TWO altitudes because production
 * cannot express the first one on its own. `probeBindMountSources` SKIPS a
 * source that is missing from the host — deliberately, and it says why: `docker
 * run -v <missing>:<dst>` CREATES the source, so probing one would make the
 * diagnostic the thing that materialized the directory it asked about. So
 * "delete a mount source and watch the run refuse" is not a probe this product
 * has; a deleted source is ISC-188's criterion, not ISC-292's. What is left is:
 *
 *   - the SHIM's own answer for a path that is not there, asked directly with
 *     an argv in `probeArgv`'s shape, over a mount set large enough that the
 *     old `; `-joined program would not have compiled; and
 *   - the GUARD's behaviour when the container's answer and the host's
 *     measurement disagree, driven through the real `assertBindMountsVisible`.
 *
 * Neither passes against a shim that answers affirmatively, and the first could
 * not even have been asked of the one this file had yesterday.
 */
describe("a container-path up can reach a successful run (ISC-429)", () => {
  /** Must match `fleetYaml`'s `docker.pi_version`, as in the ISC-32 block. */
  const PINNED_PI_VERSION = "0.79.6";

  /**
   * The line length BSD sed will compile, and the whole reason this block
   * exists. Measured, not looked up — see the header.
   */
  const SED_LINE_CEILING = 4096;

  /**
   * The shim, addressed as a program rather than through PATH.
   *
   * `assertBindMountsVisible` builds an argv beginning with the literal
   * `docker`; this maps that first word onto the shim this file writes and
   * passes the rest through untouched, so what the guard measures is the same
   * text a real `docker` would have received.
   */
  function shimExec(binDir: string): Exec {
    return async (argv) => {
      const proc = Bun.spawn([join(binDir, "docker"), ...argv.slice(1)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, stdout, stderr, timedOut: false };
    };
  }

  /**
   * `n` mount sources, each a directory holding one witness file.
   *
   * The count is a floor checked below rather than a matter of taste: the point
   * of the fixture is that the program the shim builds from it is LONGER than
   * the line BSD sed will compile.
   */
  async function seedMountSources(
    base: string,
    n: number,
  ): Promise<Array<{ src: string; witness: string; size: number }>> {
    const out: Array<{ src: string; witness: string; size: number }> = [];
    for (let i = 0; i < n; i += 1) {
      // A long-ish name, because the program's length is a function of the
      // PATHS: a fixture with three-character directory names would sit under
      // the ceiling however many of them there were.
      const src = join(base, `mount-source-for-the-bind-preflight-${String(i).padStart(3, "0")}`);
      await mkdir(src, { recursive: true });
      const body = `witness-${i}\n`;
      await writeFile(join(src, "witness.txt"), body);
      out.push({ src, witness: "witness.txt", size: Buffer.byteLength(body) });
    }
    return out;
  }

  /**
   * How many bytes of `sed` program the shim's probe branch builds for a mount
   * set.
   *
   * A DERIVATION, not a second copy of the rewrite: it is used only to check
   * that a fixture is big enough to be about the ceiling at all. If the
   * rewrite's shape changes this stops describing it, which is a cost the two
   * `toBeGreaterThan` assertions below make visible rather than silent.
   */
  function rewriteProgramBytes(sources: readonly string[]): number {
    return sources.reduce(
      (n, src, i) => n + `\ns#/probe/${i}'#${src}'#g\ns#/probe/${i}/#${src}/#g`.length,
      0,
    );
  }

  /** `probeArgv`'s shape: read-only, network-less, every mount `:ro`. */
  function probeLikeArgv(mounts: readonly { src: string; ask: string }[], tag: string): string[] {
    const argv = ["docker", "run", "--rm", "--read-only", "--network", "none"];
    for (const [i, m] of mounts.entries()) argv.push("-v", `${m.src}:/probe/${i}:ro`);
    const lines = [
      `probe() { if [ -h "$2" ]; then echo "$1 l 0"; ` +
        `elif [ -f "$2" ]; then echo "$1 f $(wc -c < "$2" | tr -d ' ')"; ` +
        `elif [ -d "$2" ]; then echo "$1 d 0"; else echo "$1 x 0"; fi; }`,
      ...mounts.map((m, i) => `probe ${i} '/probe/${i}${m.ask}'`),
    ];
    argv.push("--entrypoint", "/bin/sh", tag, "-c", lines.join("\n"));
    return argv;
  }

  test(
    "a container-path up exits 0, and the mount preflight it passed really ran",
    async () => {
      const rig = await makeRig({
        containerPath: true,
        workerContainerDouble: true,
        imagePresent: true,
        shimPiVersion: PINNED_PI_VERSION,
        /*
         * FOUR workers, which is what makes this the criterion's own probe
         * rather than a smaller case that would have squeaked under the
         * ceiling. The assertion below measures the fixture instead of
         * trusting this comment.
         */
        extraWorkers: [
          { id: "eng-2", role: "engineer" },
          { id: "rev-1", role: "reviewer" },
          { id: "qa-1", role: "qa" },
        ],
      });
      const up = await runCli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--workers",
        "eng-1,eng-2,rev-1,qa-1",
        "--backend",
        "headless",
        "--json",
      ]);

      // THE CRITERION. `stderr` is carried into the failure message rather
      // than asserted, because the whole value of this probe when it breaks is
      // reading WHERE the run stopped.
      expect({ code: up.code, stderr: up.stderr.slice(-600) }).toMatchObject({
        code: EXIT.SUCCESS,
      });

      /**
       * A COMPLETED run, not merely a zero. `up` prints this payload after the
       * idle gate, so a worker in it is one whose supervisor was OBSERVED idle
       * — and `launch.json` exists only on the container path, so its presence
       * is what says this run was not quietly the `PIFLEET_PI_COMMAND` double.
       */
      const parsed = JSON.parse(up.stdout.trim()) as {
        run_id: string;
        workers: Array<{ id: string }>;
      };
      rig.runId = parsed.run_id;
      expect(parsed.workers.map((w) => w.id).sort()).toEqual(["eng-1", "eng-2", "qa-1", "rev-1"]);
      const run = runPaths(rig.runId, rig.root);
      for (const id of ["eng-1", "eng-2", "rev-1", "qa-1"]) {
        const launch = WorkerLaunchSchema.parse(
          await Bun.file(workerPaths(run, id).launchJson).json(),
        );
        expect(launch.image).toContain("pifleet/pi-worker:");
      }

      /**
       * ANTI-VACUITY FOR THIS TEST. `exit 0` is also what a run that never
       * reached the preflight would produce, and `assertBindMountsVisible` is
       * called only when some worker has a launch argv. So the shim's own call
       * log is read for the probe argv, and the mount set it carries is
       * measured against the ceiling the fix exists for: a fixture that shrank
       * under it would keep passing while proving nothing about ISC-429.
       */
      const calls = (await Bun.file(rig.dockerCalls).text()).split("\n");
      const probes = calls
        .filter((c) => c.includes(":/probe/0:ro "))
        .map((c) => [...c.matchAll(/(\S+):\/probe\/\d+:ro/g)].map((m) => m[1]!));
      expect(probes.length).toBeGreaterThan(0);
      const widest = probes.sort((a, b) => b.length - a.length)[0]!;
      expect(rewriteProgramBytes(widest)).toBeGreaterThan(SED_LINE_CEILING);
    },
    /*
     * ISC-274 audit: one `up` spawn from this body, so `cliBudget(1)`. It is
     * NOT one process — this `up` starts four supervisors and four fake-Pi
     * doubles behind them — but every one of those is detached and the
     * command's own wait is the idle gate, whose cost `budget.ts` already
     * charges through PER_SPAWN_IDLE_MS. `cliBudget(1)` is 11_400 ms; a
     * one-worker version of this run measured 2.2 s.
     */
    cliBudget(1),
  );

  test(
    "the same shim still reports a path that is not there, and the guard still refuses",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "pifleet-mount-shim-"));
      const bin = join(base, "bin");
      await mkdir(bin, { recursive: true });
      await writeDockerShim(bin, join(base, "docker-calls.log"));
      const exec = shimExec(bin);
      const sources = await seedMountSources(base, 30);

      /**
       * HALF ONE — the shim's own discrimination, asked directly.
       *
       * Directly, because production never asks about a path it did not just
       * measure: `probeBindMountSources` skips a missing source outright (see
       * the block header). The argv is `probeArgv`'s shape, and the mount set
       * is asserted to be over the ceiling — so this is a question the shim
       * could not have answered AT ALL before the fix, and what is asserted is
       * that its answers DIFFER from each other rather than that they exist.
       */
      expect(rewriteProgramBytes(sources.map((s) => s.src))).toBeGreaterThan(SED_LINE_CEILING);
      const mounts = sources.map((s, i) => ({
        src: s.src,
        // One mount in thirty asks about a file nobody wrote. Every other asks
        // about the witness that is really there.
        ask: i === 7 ? "/no-such-witness.txt" : `/${s.witness}`,
      }));
      const answered = await exec(probeLikeArgv(mounts, "pifleet/pi-worker:probe"));
      expect({ code: answered.code, stderr: answered.stderr }).toMatchObject({ code: 0 });
      const lines = answered.stdout.trim().split("\n");
      // Thirty answers, not "some output": a rewrite that silently dropped
      // mounts would still produce a stdout.
      expect(lines).toHaveLength(30);
      expect(lines[7]).toBe("7 x 0");
      expect(lines.filter((l) => l.endsWith(" x 0"))).toHaveLength(1);
      for (const [i, s] of sources.entries()) {
        if (i === 7) continue;
        expect(lines[i]).toBe(`${i} f ${s.size}`);
      }

      /**
       * HALF TWO — the REAL guard, over the REAL shim, still refuses.
       *
       * The disagreement is one production can actually reach and one the
       * probe script is explicitly built to catch: `pathKind` stats the source
       * and FOLLOWS symlinks, so the host measures a regular file of a known
       * size, while the in-container script tests `-h` FIRST and answers `l`.
       * The two answers differ, and a shim that had been softened into
       * agreeing with whatever it was asked would not produce that.
       */
      const realFile = join(base, "kubeconfig-target");
      await writeFile(realFile, "apiVersion: v1\n");
      const link = join(base, "kubeconfig-symlink");
      await symlink(realFile, link);

      const argvs = [
        ...sources.map((s) => ["docker", "run", "-v", `${s.src}:/workspace`, "img"]),
        ["docker", "run", "-v", `${link}:/home/pi/.kube/config:ro`, "img"],
      ];
      let caught: unknown;
      try {
        await assertBindMountsVisible(argvs, "pifleet/pi-worker:probe", exec);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MountNotVisibleError);
      const err = caught as MountNotVisibleError;
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain(link);
      // ONLY that one. A shim reporting nothing about everything would name
      // all thirty-one paths and still satisfy the two assertions above.
      for (const s of sources) expect(err.message).not.toContain(s.src);

      /*
       * THE CONTROL FOR THE CONTROL: drop the symlink and the same guard, over
       * the same shim and the same thirty sources, RESOLVES. Without it,
       * "it refused" is indistinguishable from "it refuses everything" — which
       * is precisely the state this fix was undoing.
       */
      await assertBindMountsVisible(argvs.slice(0, -1), "pifleet/pi-worker:probe", exec);

      await rm(base, { recursive: true, force: true });
    },
    /*
     * ISC-274 audit: no `up` spawn, but three shim invocations — one direct
     * and two through `assertBindMountsVisible`, which charges one probe
     * container per call. `cliBudget(3)` is the model's own answer for three
     * spawn-reaching calls; the shim is a `/bin/sh` script and far cheaper than
     * the CLI startup that figure is calibrated to, so this is generous rather
     * than tight, which is the direction budget.ts asks for.
     */
    cliBudget(3),
  );
});
