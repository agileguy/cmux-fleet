/**
 * THE chain, in one motion: `up` -> supervisor -> container -> dispatch ->
 * settle -> harvest (ISC-290).
 *
 * ## Why this file exists, and why it is one test
 *
 * Every SEGMENT of this chain already has a probe. `container-launch.test.ts`
 * proves the supervisor spawns the launch record's argv verbatim (ISC-287),
 * `image.test.ts` proves the recorded argv starts a container that runs Pi and
 * answers on stdout (ISC-286), `down-teardown.test.ts` proves `down` reaps it
 * (ISC-288), and `relay.test.ts` proves a live inference round-trips through
 * the egress relay (ISC-258). ISC-290's own close-out says in as many words why
 * that is not enough: *"a criterion that says 'end to end' must not be closed
 * by three probes that each cover a segment"*. Three green segments and a
 * broken join is a fleet that looks alive and settles nothing.
 *
 * So this is ONE test that starts at `pifleet up` with a real config and stops
 * at a harvested verdict, with no seam faked in between. It is deliberately not
 * split: splitting it would reintroduce exactly the per-segment shape the
 * criterion refuses.
 *
 * ## What "completes a real RPC turn" is asserted BY
 *
 * Not liveness. A worker that starts, hangs, and is killed at its deadline
 * still produces a settled task, a harvest, and a clean `down` — that is
 * precisely what the first two ISC-290 runs did on 2026-08-23/24, and reading
 * only the exit codes would have called them successes. The evidence that
 * separates a completed turn from a wedge is in the worker's own state file:
 *
 *   - `last_event: "agent_end"` — the turn ENDED, and ended naturally rather
 *     than on an abort or a deadline. The wedged runs froze after `turn_start`
 *     and never emitted it.
 *   - `tool_calls >= 1` with `tool_errors === 0` — the model emitted NATIVE
 *     tool calls and they worked. The wedge was a model leaking a tool call as
 *     prose; a run with zero tool calls is the ISC-108 `no_tool_calls` failure,
 *     not a completed turn.
 *   - the task record's `verdict: "success"`, `reason: "quiesced"` — the
 *     supervisor decided the epoch was over because the worker went quiet
 *     having finished, not because a timer fired (`timed_out`).
 *   - the worktree's content hash at quiesce DIFFERS from the baseline hash
 *     `up` captured before the worker existed — the turn changed the tree.
 *     This is the model-independent half of "real work produced".
 *   - `add.js` gained the `subtract` the brief asked for and kept its `add` —
 *     the model-dependent half, and the one that makes this a test of the
 *     product rather than of process liveness.
 *
 * ## What is deliberately NOT asserted: `artifacts`' own verdict
 *
 * The harvest leg is asserted to reach `harvest_status: "complete"`, NOT to
 * return `verdict: "success"`. That is not a softened assertion, it is the
 * measured truth of the run this criterion was closed against. Re-run by hand
 * on 2026-08-24 against the operator's successful run
 * (`artifacts --run 2026-08-24T17-18-05Z-7f40 --task t1 --json`):
 *
 *     "verdict":"unknown", "harvest_status":"complete",
 *     "reasons":["no result envelope; verdict rests on derived facts alone", ...]
 *     "derived":{"commits":[],"files_changed":[], ...}
 *
 * The worker did the work and left it UNCOMMITTED, so the git-derived facts see
 * nothing and the adjudicator has nothing to certify from — `unknown` is the
 * lattice identity, which is the correct answer to "no envelope, no commits".
 * Asserting `success` here would be asserting something the reference run does
 * not do, and the test would have failed on the very run that proved the
 * criterion. Whether a worker SHOULD be committing is a different criterion.
 *
 * What ISC-290 needs from this leg is that harvest RAN and completed over the
 * chain's output, which `harvest_status` is exactly the field for (SRD §8.4:
 * trustworthiness is orthogonal to the verdict). `tree_hash_quiesce` and
 * `tree_hash_harvest` are asserted equal for the same reason ISC-154 exists —
 * a harvest that observed a different tree than the supervisor quiesced on has
 * not harvested this turn's work.
 *
 * ## Gating
 *
 * `PIFLEET_DOCKER=1` plus a reachable live oMLX plus `OMLX_API_KEY`, computed
 * with the SAME predicate `relay.test.ts` uses for its live probes — a `401`
 * counts as reachable, because it proves the TCP path and the HTTP server and
 * says only that no key was sent. The base URL the gate dials honours
 * `PIFLEET_OMLX_BASE_URL`, which is `model-probe.test.ts`'s existing variable
 * and existing default (`http://localhost:8000/v1`).
 *
 * `PIFLEET_OMLX_MODEL` is REQUIRED once the gate is open, and its absence
 * FAILS rather than skips — `model-probe.test.ts`'s shape, for its reason:
 * *"a skip silently reachable from a half-configured environment is how a
 * criterion reports green having never executed"*.
 *
 * THE MODEL IS NAMED, NEVER INFERRED, and `probeModel`'s docstring in
 * `model-probe.test.ts` records the cost of the alternative: auto-selecting the
 * first served chat model cold-loaded a 35B into a 24GB cap and SIGABRT'd the
 * operator's oMLX, taking every other tenant's warm model with it. A test suite
 * must not pick its own GPU workload. It matters more here than there, because
 * this file does not send one probe — it hands a model an agentic task and lets
 * it run for as long as its deadline allows.
 *
 * Choosing WHICH model is not free either, and ISA.md records the measurements:
 * `Qwen3-Coder-30B-A3B-Instruct-4bit` leaked a tool call as raw text in 1 of 3
 * identical attempts and produced a 1519-second generation on this exact
 * conversation shape — that unreliability is what wedged the chain twice during
 * the ISC-290 diagnosis. `Qwen3.5-35B-A3B-8bit` and `GLM-4.5-Air-MLX-4bit` were
 * both 3/3 on the same probe, and `Qwen3.5-35B-A3B-8bit` is the one that has
 * actually been measured completing THIS chain (run 3: settled `success` in 13
 * seconds, 4 turns, 3 tool calls, 0 tool errors). Naming a model that has only
 * been measured on a single-call probe would be a weaker claim than it looks.
 *
 * That last sentence was then TESTED, by ignoring it. `ci.yml` pinned
 * `GLM-4.5-Air-MLX-4bit` for this job anyway, on the reasoning that both were
 * 3/3 on the tools-bearing probe and GLM is cheaper — which is true, and about
 * a different question. This chain failed intermittently for two days, and on
 * 2026-08-26 it failed twice locally in two DIFFERENT ways: once with the
 * server returning `stopReason: "error"` on the generation after the `read`
 * tool call, once with zero tool calls emitted at all. Re-pointed at
 * `Qwen3.5-35B-A3B-8bit` on the same host, shim and container, it settled
 * `success` 7 runs out of 7 in 12.3-15.8s — 3 of those 7 against the brief
 * exactly as it ships below, the other 4 against a firmer wording that was
 * tried and then reverted. So the single-call probe genuinely does not predict
 * this, and `ci.yml` now names the 35B.
 *
 * ## Where it runs
 *
 * Nowhere but a machine with both a Docker daemon and a reachable oMLX, which
 * today means the operator's. It is listed in `ci.yml`'s container job and
 * PINNED BY NAME as an expected skip, so a rename, a deletion, or an un-skip
 * goes red and says which — the treatment ISC-258's live relay probe already
 * gets. An accounted-for skip is not coverage, and ISC-290 stays `[~]` on
 * exactly that distinction.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { spawnCli, type CliResult } from "../support/spawn-cli.ts";
import { seedGitRepo } from "../fixtures/synthetic-repo.ts";
import { gateBudget } from "../support/budget.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { daemonScratchRoot } from "../../src/container/mounts.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";

/**
 * Where the HOST reaches oMLX. Same variable and same default as
 * `model-probe.test.ts`, so an operator whose server is not on `localhost`
 * configures one name rather than two.
 */
const BASE_URL = process.env["PIFLEET_OMLX_BASE_URL"] ?? "http://localhost:8000/v1";

/**
 * Is a real oMLX up? `401` counts — it means the TCP path and the HTTP server
 * are both there and only the key is missing, which is what a reachable oMLX
 * looks like without credentials. Lifted verbatim from `relay.test.ts` rather
 * than reinvented: two spellings of "is oMLX there" is two answers.
 */
async function omlxReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3_000) });
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

const OMLX_KEY = process.env["OMLX_API_KEY"] ?? "";
const CHAIN_LIVE = DOCKER && OMLX_KEY !== "" && (await omlxReachable());

if (!DOCKER) {
  console.warn(
    "[skip] the ISC-290 full-chain test needs a Docker daemon and a built worker image. " +
      "Run with PIFLEET_DOCKER=1 after 'pifleet image build --toolchain node'.",
  );
} else if (!CHAIN_LIVE) {
  console.warn(
    `[skip] the ISC-290 full-chain test needs a reachable ${BASE_URL} and OMLX_API_KEY.`,
  );
}

/** The pifleet checkout: source of `fleet.example.yaml`, `roles/` and `skills/`. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * The task's own deadline, and the reason the number is small.
 *
 * The supervisor settles a wedged worker `timed_out` at this bound, and the
 * scheduler's stall ceiling is this plus its 600 s grace — so this value, not
 * the test budget, is what decides how long a BROKEN run takes to report. The
 * reference run settled in 13 s; five minutes is two orders of magnitude of
 * headroom for a one-function edit and still bounds a wedge at a legible time.
 */
const TASK_DEADLINE_S = 300;

/**
 * The gates this test waits on, which are also the ceilings `gateBudget` is
 * built from — the helper's docstring asks for exactly that rather than a
 * spawn count borrowed from a differently-shaped test.
 *
 * `up` gets the largest of the four because it is doing the most: the image
 * gate, the egress network, the relay, and the native-tool-call probe, which
 * can COLD-LOAD the model (19.4 s measured for a 4-bit MoE, more for an 8-bit
 * 35B) before the 60 s idle gate even starts.
 */
const UP_GATE_MS = 300_000;
const DISPATCH_GATE_MS = TASK_DEADLINE_S * 1_000 + 120_000;
const HARVEST_GATE_MS = 60_000;
const DOWN_GATE_MS = 120_000;

interface Rig {
  base: string;
  runsRoot: string;
  repo: string;
  configPath: string;
  tasksPath: string;
  runId: string;
}

const rigs: Rig[] = [];
afterAll(async () => {
  for (const rig of rigs) {
    if (rig.runId !== "") {
      // Belt and braces: the test downs its own fleet, and this catches the run
      // a FAILING test left behind. A supervisor and a container that outlive
      // the suite are not a tidiness problem — the next run adopts the same
      // named relay and egress network.
      await cli(rig, ["down", "--run", rig.runId, "--prune", "--force", "--json"]).catch(() => {});
    }
    await rm(rig.base, { recursive: true, force: true }).catch(() => {});
  }
});

function cli(rig: Rig, args: readonly string[]): Promise<CliResult> {
  return spawnCli(args, {
    env: {
      PIFLEET_RUNS_DIR: rig.runsRoot,
      /**
       * Emphatically EMPTY, not merely unmentioned.
       *
       * `up` reads this once and branches the whole run on it: a non-empty
       * value means the Pi DOUBLE, which skips the image gate and writes a
       * process launch record instead of a container one. An operator with it
       * exported — and this repo's own integration suite is full of runs that
       * set it — would get a green result here having launched no container at
       * all, which is the one thing this criterion is about.
       */
      PIFLEET_PI_COMMAND: "",
    },
  });
}

/**
 * The fleet config, DERIVED from `fleet.example.yaml` rather than authored.
 *
 * This is load-bearing, not convenience. `up`'s image gate demands the exact
 * tag `renderAllWorkers` computed, and that tag is
 * `<image_prefix>:<pi_version>-<toolchain>-<hash>` where the hash covers
 * `pi_version`, the toolchain, `apt_packages` and the digests of
 * `docker/Dockerfile`, `docker/verbgate` and `docker/entrypoint.sh`. A
 * hand-written `docker:` block that drifted from the shipped example by one
 * field would produce a tag nothing has built, and the test would fail at the
 * gate with a message about a missing image rather than anything to do with
 * the chain. Reading the example is what keeps `pifleet image build` and this
 * test agreeing about which image is wanted, permanently.
 *
 * What is overridden is only what a test MUST own: where the repo is, which
 * model, how many workers, and no cloud identity.
 */
async function writeConfig(rig: Rig, model: string): Promise<void> {
  /**
   * Typed loosely on purpose. This function's job is to hand `up` a YAML file
   * it will parse and validate with the real schema; re-declaring that schema
   * here would give the test its own second opinion about the config shape,
   * and the two would disagree the first time a key moved.
   */
  const example = parseYaml(
    await readFile(join(REPO_ROOT, "fleet.example.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const section = (key: string): Record<string, unknown> => {
    const v = example[key];
    if (typeof v !== "object" || v === null) {
      throw new Error(`fleet.example.yaml has no \`${key}:\` section to override`);
    }
    return v as Record<string, unknown>;
  };

  example["name"] = "isc-290-full-chain";

  const runCfg = section("run");
  runCfg["repo"] = rig.repo;
  // One worker, one task, one generation at a time: this test is about the
  // chain, and concurrency would only add ways for it to be slow.
  runCfg["max_concurrent"] = 1;
  // `run.root` is left as the example has it and does not matter —
  // `PIFLEET_RUNS_DIR` is what `runsRoot()` actually reads.

  const llmCfg = section("llm");
  llmCfg["model"] = model;
  /**
   * The allowlist is narrowed to the ONE model this run may use, rather than
   * left as the example's three.
   *
   * `up` checks the allowlist and then PROBES every allowlisted model for
   * native tool calls. Leaving three in would spend two extra cold loads on
   * the operator's GPU to prove nothing this test asserts, and would make the
   * run fail if any unrelated model on the allowlist happened to be unserved.
   */
  llmCfg["models_allowlist"] = [model];

  /**
   * Where the RELAY dials, and the paired egress rule.
   *
   * Unset (the CI shape) leaves the schema default — oMLX on the Docker host —
   * which is what a runner with a `localhost:8000` gets. Set (the operator's
   * shape) points the relay at a LAN peer, and §5.9 requires the matching
   * `egress.allow` entry as a SEPARATE decision: the relay is the single hole
   * in a deny-all bridge carrying untrusted model output, and one string
   * should not be enough to aim it at an arbitrary machine. The test writes
   * both together because it is aiming its own relay at its own upstream, but
   * it still writes both, so the config it produces is one an operator could
   * have written by hand.
   */
  const upstream = process.env["PIFLEET_TEST_RELAY_UPSTREAM"] ?? "";
  if (upstream !== "") {
    const [host, port] = upstream.split(":");
    if (host === undefined || port === undefined || !/^\d+$/.test(port)) {
      throw new Error(
        `PIFLEET_TEST_RELAY_UPSTREAM must be host:port with an explicit port, got "${upstream}"`,
      );
    }
    llmCfg["relay_upstream"] = upstream;
    example["egress"] = { allow: [{ host, port: Number(port) }] };
  }

  // No Google identity. A runner has none, and this chain needs none — the
  // engineer role does not set `cloud_access`, so the only effect of leaving
  // `adc: true` would be a credential plan for a credential that is not there.
  section("cloud")["adc"] = false;

  /**
   * One role and one worker.
   *
   * The example's other five roles are dropped rather than kept-and-ignored:
   * their `append_system_prompt_file` values are relative to the CONFIG's
   * directory, and this config lives in a temp directory that has no `roles/`.
   * The one role that survives gets an ABSOLUTE path into the checkout, so the
   * worker is briefed with the same `roles/engineer.md` a real run gets rather
   * than with silence.
   */
  const engineer = section("roles")["engineer"] as Record<string, unknown>;
  engineer["append_system_prompt_file"] = join(REPO_ROOT, "roles", "engineer.md");
  /**
   * The ROLE's model, set as well as `llm.model`, because the role is what
   * actually wins.
   *
   * Not defensive tidying — measured. Setting only `llm.model` left the
   * example's `roles.engineer.model` in place, `defaults <- roles <- worker`
   * resolved the worker to THAT model, and `up` refused at the allowlist gate:
   * *"worker eng-1 resolves to model Qwen3-Coder-30B-A3B-Instruct-4bit, which
   * is not in llm.models_allowlist"*. Which is the gate working correctly, on a
   * config the test had written wrong.
   *
   * Set here rather than deleted so the config states the model at the level
   * that decides it, instead of depending on merge semantics to fall through.
   */
  engineer["model"] = model;
  example["roles"] = { engineer };
  example["workers"] = [{ id: "eng-1", role: "engineer" }];

  await writeFile(rig.configPath, stringifyYaml(example), "utf8");
}

/** The one task, in the shape `dispatch --auto --tasks` reads (`pifleet.tasklist/v1`). */
async function writeTaskList(rig: Rig): Promise<void> {
  await writeFile(
    rig.tasksPath,
    JSON.stringify({
      schema: "pifleet.tasklist/v1",
      tasks: [
        {
          id: "t1",
          title: "Add a subtract function",
          /**
           * PLAIN, and deliberately kept that way.
           *
           * When this probe failed on 2026-08-26 the first fix attempted was a
           * firmer brief — one that spelled out "you MUST write to disk" and
           * restated completion as an on-disk predicate. That fix was aimed at
           * a cause that did not exist: the captured event stream showed the
           * model had ALREADY decided to edit, and the turn died because the
           * server returned `stopReason: "error"` on the follow-up generation.
           * A second run failed differently again, with zero tool calls.
           *
           * The real variable was the model, not the wording (see `ci.yml`'s
           * `container-live` env). So the brief stays at the difficulty a real
           * task has. Hardening it would have tuned the prompt until a model
           * that cannot drive this chain appeared to — which is the same
           * mistake as retrying until green, spelled differently.
           */
          brief:
            "In add.js there is an exported `add` function. Add an exported `subtract(a, b)` " +
            "function beside it that returns a - b. Change nothing else in the file.",
          worker: "eng-1",
          acceptance: ["add.js exports both add and subtract"],
          deadline_s: TASK_DEADLINE_S,
        },
      ],
    }),
    "utf8",
  );
}

/**
 * A repository with exactly the shape the reference run used.
 *
 * Small on purpose. The criterion is about the CHAIN completing, so the task
 * has to be one a small local model reliably finishes — a large repo would be
 * testing the model's context handling and reporting the result as a fleet
 * defect.
 */
const ADD_JS = "export function add(a, b) {\n  return a + b;\n}\n";

/**
 * Where the rig lives, and why it is emphatically NOT `os.tmpdir()`.
 *
 * MEASURED, not anticipated. Sited under `os.tmpdir()` this test failed at
 * `up` with ISC-292's mount preflight refusing six bind-mount sources at once
 * — the worktree, the outbox, the sessions dir, the skills bundle, the
 * cloud-allow file and the system-append file — each reported as *"the host
 * has ... and the container sees nothing there at all — the mount would come
 * up EMPTY"*. That refusal is correct: on macOS only directories shared into
 * the VM are mountable, Colima shares `$HOME` and does NOT share
 * `/var/folders/...`, and mounting an unshared path presents the worker an
 * empty directory while the host content sits untouched. A fleet that runs,
 * finds nothing and says nothing is precisely what that gate exists to
 * prevent, and a test rig that trips it is testing its own siting.
 *
 * `daemonScratchRoot()` is IMPORTED rather than respelled as
 * `join(homedir(), ...)`, because it is the product's own answer to "a
 * directory the container runtime can see" — `PIFLEET_SCRATCH_DIR` when set,
 * `~/.pifleet/scratch` otherwise. A test that hardcoded its own answer could
 * agree with itself on a machine where the product disagreed, which is the
 * same class of error as re-typing `DOCKER_HOST_LOOPBACK`.
 */
async function makeRig(): Promise<Rig> {
  const scratch = daemonScratchRoot();
  await mkdir(scratch, { recursive: true });
  const base = await mkdtemp(join(scratch, "pifleet-isc290-"));
  const rig: Rig = {
    base,
    runsRoot: join(base, "runs"),
    repo: join(base, "repo"),
    configPath: join(base, "fleet.yaml"),
    tasksPath: join(base, "tasks.json"),
    runId: "",
  };
  rigs.push(rig);
  await seedGitRepo(rig.repo, {
    files: { "add.js": ADD_JS, "README.md": "# pifleet full-chain fixture\n" },
  });
  return rig;
}

/** `docker inspect` on one container, as a plain string answer. */
async function inspect(name: string, format: string): Promise<string> {
  const p = Bun.spawn(["docker", "inspect", "--format", format, name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

function json<T>(r: CliResult, what: string): T {
  try {
    return JSON.parse(r.stdout.trim()) as T;
  } catch {
    throw new Error(`${what} did not emit JSON (exit ${r.code}):\n${r.stdout}\n${r.stderr}`);
  }
}

/**
 * What the erroring tool calls actually SAID.
 *
 * `expect(state.tool_errors).toBe(0)` knows a count and nothing else, which is
 * the least useful thing a remote failure can tell you: the first CI run of
 * this test reported `Received: 10` and left no way to ask what the ten were.
 * The supervisor already logs every event verbatim to `events.jsonl` before it
 * counts anything (`supervisor/index.ts` — the log is deliberately not
 * conditional), so the answer is sitting on disk in the rig at the moment the
 * assertion fires. This reads it back rather than re-running the chain to find
 * out.
 *
 * Deliberately total: a diagnostic that can itself throw would replace the real
 * failure with its own, so an unreadable or malformed log degrades to a note
 * saying so.
 */
async function toolErrorDigest(eventsJsonl: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(eventsJsonl, "utf8");
  } catch (e) {
    return `(could not read ${eventsJsonl}: ${e instanceof Error ? e.message : String(e)})`;
  }
  const failed: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line is not worth failing the diagnostic over.
    }
    const ev = (rec as { event?: { type?: string; isError?: boolean } }).event;
    if (ev?.type !== "tool_execution_end" || ev.isError !== true) continue;
    failed.push(JSON.stringify(ev).slice(0, 400));
  }
  return failed.length === 0
    ? "(no erroring tool_execution_end events found in the log)"
    : failed.join("\n");
}

/**
 * EVERYTHING the model did this turn, for the one failure that cannot be
 * diagnosed from its own assertion message.
 *
 * `tool_errors === 0` and `last_event === "agent_end"` can both hold while the
 * worktree is untouched, and when that happened on 2026-08-26 the failure said
 * only that the tree hash had not moved. That is the same sentence whether the
 * model read the file and stopped, wrote to the wrong path, or wrote the
 * identical bytes back — three different findings, one of which is a fleet
 * defect and two of which are not.
 *
 * Deliberately SHAPE-AGNOSTIC. The event records come from Pi, not from this
 * repo, so this reads `type` and probes a few plausible name fields rather
 * than asserting a schema: a digest that throws on an unfamiliar event would
 * replace the diagnosis with a second mystery.
 */
async function turnDigest(eventsJsonl: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(eventsJsonl, "utf8");
  } catch (e) {
    return `(could not read ${eventsJsonl}: ${e instanceof Error ? e.message : String(e)})`;
  }
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = (rec as { event?: Record<string, unknown> }).event;
    if (ev === undefined || typeof ev["type"] !== "string") continue;
    const type = ev["type"];
    if (!type.includes("tool") && !type.includes("text") && !type.includes("message")) {
      continue;
    }
    const name =
      (ev["name"] as string | undefined) ??
      (ev["toolName"] as string | undefined) ??
      (ev["tool"] as string | undefined) ??
      "";
    // `message_end` carries `stopReason` and `usage`, which is where an EMPTY
    // generation announces itself; 300 chars truncated both away.
    const budget = type === "message_end" || type === "message_start" ? 1_400 : 300;
    lines.push(`${type}${name === "" ? "" : ` name=${name}`}: ${JSON.stringify(ev).slice(0, budget)}`);
  }
  return lines.length === 0
    ? "(no tool or text events in the log at all — the turn produced nothing to inspect)"
    : lines.join("\n");
}

/**
 * The UPSTREAM's own refusal, if the model server declined a generation.
 *
 * This exists because of a misdiagnosis worth not repeating. On 2026-08-26 this
 * probe failed on main with `agent_end`, one successful tool call, zero tool
 * errors and an unchanged worktree, and every reading of that said "the model
 * chose not to edit" — so the first fix attempted was a firmer brief. Captured
 * locally against the same tunnel CI uses, the events said something else:
 *
 *     "stopReason":"error","responseModel":"keepalive",
 *     "errorMessage":"Prefill context too large for available memory
 *      (pre-chunk guard at 0 tokens, kv_len=0): predicted peak would exceed
 *      prefill safety cap 96.8GB (90% of effective ceiling 107.5GB)"
 *
 * The generation after the tool result was REFUSED by oMLX — at `kv_len=0`,
 * predicting a 96.8GB peak for a conversation of a few dozen tokens. Nothing in
 * the fleet was wrong, and nothing about the brief would have changed it.
 *
 * So this is checked BEFORE the tree-hash assertion, and it is the difference
 * between a probe that says "the turn changed nothing" and one that says which
 * component refused. A retry or a softer assertion would have buried it.
 */
async function upstreamRefusal(eventsJsonl: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(eventsJsonl, "utf8");
  } catch {
    return null; // absence of the log is the tree assertion's problem, not this one.
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (rec as { event?: { message?: Record<string, unknown> } }).event?.message;
    if (msg === undefined || msg["stopReason"] !== "error") continue;
    const detail = typeof msg["errorMessage"] === "string" ? msg["errorMessage"] : "(no errorMessage)";
    const model = typeof msg["responseModel"] === "string" ? msg["responseModel"] : "(unknown)";
    return `responseModel=${model}: ${detail}`;
  }
  return null;
}

interface RunJson {
  worktrees: Array<{ workerId: string; path: string; branch: string; baselineTree: string }>;
}

describe("the whole chain, in one motion (ISC-290)", () => {
  test.skipIf(!CHAIN_LIVE)(
    "a worker container launched by up completes a real RPC turn end to end",
    async () => {
      /**
       * NAMED, never inferred, and a FAILURE rather than a skip. See the file
       * header: the alternative aborted the operator's inference server twice.
       */
      const model = process.env["PIFLEET_OMLX_MODEL"] ?? "";
      expect(
        model,
        "PIFLEET_OMLX_MODEL must name the model to run this chain against. It is deliberately " +
          "not inferred — auto-selecting a served model cold-loaded a 35B into a 24GB cap and " +
          "SIGABRT'd the host's oMLX (see probeModel in model-probe.test.ts). ISA.md measures " +
          "Qwen3.5-35B-A3B-8bit completing this chain.",
      ).not.toBe("");

      const rig = await makeRig();
      await writeConfig(rig, model);
      await writeTaskList(rig);

      // --- up: preflight, image gate, network, relay, tool-call probe,
      //     worktree, skills, daemon, supervisor, container, idle.
      const up = await cli(rig, [
        "up",
        "--config",
        rig.configPath,
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code, `up failed:\n${up.stdout}\n${up.stderr}`).toBe(0);
      const upPayload = json<{ run_id: string; backend: string; workers: Array<{ id: string }> }>(
        up,
        "up --json",
      );
      expect(upPayload.run_id).toBeTruthy();
      expect(upPayload.workers.map((w) => w.id)).toEqual(["eng-1"]);
      rig.runId = upPayload.run_id;

      const run = runPaths(rig.runId, rig.runsRoot);
      const wp = workerPaths(run, "eng-1");

      /**
       * A CONTAINER, and specifically not the double.
       *
       * Asserted from the launch record rather than inferred from the run
       * succeeding, because the double path succeeds too — it just proves
       * nothing this criterion asks about. `argv[0]` is checked as well as
       * `kind`, so a record that CLAIMED to be a container while naming some
       * other program could not satisfy this.
       */
      const launch = JSON.parse(await readFile(wp.launchJson, "utf8")) as {
        kind: string;
        argv: string[];
        container: string;
        image: string;
      };
      expect(launch.kind).toBe("container");
      expect(launch.argv[0]).toBe("docker");
      expect(launch.container).not.toBe("");
      expect(launch.image).not.toBe("");

      const runJson = JSON.parse(await readFile(run.runJson, "utf8")) as RunJson;
      const worktree = runJson.worktrees.find((w) => w.workerId === "eng-1");
      expect(worktree, "up recorded no worktree for eng-1").toBeDefined();
      const baselineTree = worktree!.baselineTree;
      expect(baselineTree).not.toBe("");

      // --- dispatch: one real task, driven to a terminal state by the scheduler.
      const dispatch = await cli(rig, [
        "dispatch",
        "--auto",
        "--run",
        rig.runId,
        "--tasks",
        rig.tasksPath,
        "--json",
      ]);
      expect(dispatch.code, `dispatch --auto failed:\n${dispatch.stdout}\n${dispatch.stderr}`).toBe(
        0,
      );
      const schedule = json<Array<{ id: string; state: string; verdict: string | null }>>(
        dispatch,
        "dispatch --auto --json",
      );
      expect(schedule).toHaveLength(1);
      expect(schedule[0]!.id).toBe("t1");
      expect(schedule[0]!.state).toBe("done");
      expect(schedule[0]!.verdict).toBe("success");

      // --- settle: the supervisor's own terminal record for the epoch.
      const record = await readTaskRecord(taskRecordPath(wp, "t1"));
      expect(record, "no task record was written for t1").not.toBeNull();
      expect(record!.verdict).toBe("success");
      /**
       * `quiesced`, not merely non-empty. The two ISC-290 wedges settled with
       * `timed_out` at the deadline and produced a task record that satisfies
       * every OTHER assertion about a record existing — the reason field is
       * what separates "the worker finished" from "a timer fired".
       */
      expect(record!.reason).toBe("quiesced");
      expect(record!.epoch).toBe(1);
      expect(record!.tree_hash, "the supervisor took no quiesce sample").not.toBeNull();

      // --- the container the chain actually ran in is REAL and still up.
      const state = await readWorkerState(wp);
      expect(state, "no worker state was written").not.toBeNull();
      expect(state!.container?.name).toBe(launch.container);
      expect(state!.container?.image).toBe(launch.image);
      expect(
        await inspect(launch.container, "{{.State.Running}}"),
        `the container ${launch.container} the supervisor launched is not running`,
      ).toBe("true");

      /**
       * THE TURN COMPLETED. This block, not the exit codes, is what this
       * criterion turns on — see the file header for what each field rules out.
       */
      expect(state!.last_event, "the turn never ended naturally").toBe("agent_end");
      expect(state!.turns).toBeGreaterThanOrEqual(1);
      expect(state!.tool_calls, "the model completed a turn without calling a tool").toBeGreaterThanOrEqual(1);
      expect(
        state!.tool_errors,
        `${state!.tool_errors} of ${state!.tool_calls} tool call(s) errored. ` +
          `The ratio matters as much as the count — a model that flails once and recovers ` +
          `is not the same failure as a chain whose tool dispatch is broken. What they said:\n` +
          (await toolErrorDigest(wp.eventsJsonl)),
      ).toBe(0);

      /**
       * UPSTREAM FIRST. If the model server refused a generation, every
       * assertion below reports a symptom and names the wrong component.
       */
      const refusal = await upstreamRefusal(wp.eventsJsonl);
      expect(
        refusal,
        `the model server REFUSED a generation mid-turn. This is an upstream failure, not a ` +
          `fleet defect — the container launched, the RPC turn ran, and the tool call ` +
          `succeeded before it. What the server said:\n${refusal}`,
      ).toBeNull();

      // --- REAL WORK: the tree changed, and changed into what was asked for.
      //
      // The digest is attached because this assertion CANNOT be diagnosed from
      // its own message: a turn that read the file and stopped, one that wrote
      // to the wrong path, and one that wrote identical bytes all fail here
      // with the same sentence, and only one of the three is a fleet defect.
      expect(
        record!.tree_hash,
        "the worktree at quiesce is byte-identical to the baseline up captured — the turn " +
          "completed without changing anything. Everything upstream of this line passed, so " +
          "the container launched, the RPC turn ran, and tools dispatched without error; " +
          "what the model actually did with them is below.\n" +
          (await turnDigest(wp.eventsJsonl)),
      ).not.toBe(baselineTree);

      const produced = await readFile(join(worktree!.path, "add.js"), "utf8");
      expect(produced).toMatch(/\bfunction\s+add\s*\(/);
      expect(produced, `add.js gained no subtract:\n${produced}`).toMatch(
        /\bfunction\s+subtract\s*\(/,
      );

      /**
       * And the ORIGINAL is untouched. Worktree isolation is not what this
       * criterion is about, but a chain that "succeeded" by editing the
       * operator's checkout in place would be a worse outcome than a failure,
       * and this costs one read.
       */
      expect(await readFile(join(rig.repo, "add.js"), "utf8")).toBe(ADD_JS);

      // --- harvest: the last leg, over this turn's output.
      const artifacts = await cli(rig, [
        "artifacts",
        "--run",
        rig.runId,
        "--task",
        "t1",
        "--json",
      ]);
      expect(
        artifacts.code,
        `artifacts failed:\n${artifacts.stdout}\n${artifacts.stderr}`,
      ).toBe(0);
      const harvest = json<{
        task_id: string;
        worker: string;
        epoch: number;
        harvest_status: string;
        session_path: string | null;
        facts: { tree_hash_quiesce: string | null; tree_hash_harvest: string | null };
      }>(artifacts, "artifacts --json");
      expect(harvest.task_id).toBe("t1");
      expect(harvest.worker).toBe("eng-1");
      expect(harvest.epoch).toBe(1);
      // See the file header for why this, and not `verdict`, is the assertion.
      expect(harvest.harvest_status).toBe("complete");
      expect(harvest.facts.tree_hash_quiesce).toBe(record!.tree_hash);
      expect(
        harvest.facts.tree_hash_harvest,
        "harvest observed a different tree than the supervisor quiesced on",
      ).toBe(harvest.facts.tree_hash_quiesce);

      // --- down: the container the chain created is reaped.
      const down = await cli(rig, ["down", "--run", rig.runId, "--json"]);
      expect(down.code, `down failed:\n${down.stdout}\n${down.stderr}`).toBe(0);
      expect(
        await inspect(launch.container, "{{.State.Running}}"),
        `down left ${launch.container} behind`,
      ).not.toBe("true");
    },
    gateBudget([UP_GATE_MS, DISPATCH_GATE_MS, HARVEST_GATE_MS, DOWN_GATE_MS]),
  );
});
