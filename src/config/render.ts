/**
 * Config → container invocation (SRD §6.3), with no side effects.
 *
 * `renderWorker` computes the exact `docker run` argv and the exact `pi` argv
 * for one worker and spawns nothing (ISC-60). It returns normalized argv
 * ARRAYS with every path canonicalized, so a test compares arrays rather than
 * a byte string that would encode one machine's home directory.
 *
 * Three rules here have a recorded failure behind them:
 *
 *  - `--append-system-prompt` is NOT repeatable — last wins, silently. All
 *    briefing fragments (defaults + role + worker) are therefore concatenated
 *    into ONE file at `<run-dir>/workers/<id>/system-append.md` and exactly
 *    one flag is emitted (ISC-65).
 *  - Pi has no `@` sigil. An `@`-prefixed argument is appended as LITERAL
 *    text, which is how a role briefing becomes a 40-character path string
 *    with no error. Rendering refuses to emit any `@`-prefixed argv element
 *    (ISC-66).
 *  - NO path under the run directory is joined in this file. Every one comes
 *    from `run/paths.ts`, which is where `up` gets them too. This module used
 *    to derive its own run root from `config.run.root` — a field `up` never
 *    reads — so a preview could name mounts the real launch would not use, and
 *    a wrong preview is silent by construction (ISC-188).
 *
 * `pane_mode` (SRD §3.5) reaches exactly two lines in this file, and they are
 * the only two places in `src/` that read it: `-t` on the `docker run` and the
 * ABSENCE of `--mode rpc` on the pi argv. `resolveWorker` has set `paneMode`
 * since the field was added and nothing consumed it, so `pane_mode: tui`
 * parsed, validated, and did nothing — the shape this repo keeps closing. Both
 * branch sites carry the measurement that shaped them.
 */

import { join } from "node:path";
import { imageTag } from "../container/image.ts";
import { WORKER_UID } from "../container/mounts.ts";
import { assertNoHostGcloudMount, gcloudConfigTmpfsArgv } from "../security/adc.ts";
import {
  assertNoRunDirMount,
  assertNoRunDirMountResolved,
  roleSkillsDir,
  runPaths,
  runsRoot,
  workerOutboxDir,
  workerPaths,
  workerWorktree,
  workerContainerName,
  type RunPaths,
  type WorkerPaths,
} from "../run/paths.ts";
import { DISPATCH_POLICY_MOUNT, DISPATCH_TRIGGER_PATH } from "../run/dispatch-policy.ts";
import { TASK_POLICY_MOUNT } from "../run/task-policy.ts";
import { workerEgressNetwork } from "../security/relay.ts";
import { SECRETS_MOUNT } from "../run/worker-env.ts";
import { ConfigError, expandPath, resolveWorker, type LoadedConfig, type ResolvedWorker } from "./load.ts";
import type { Toolchain } from "./schema.ts";
import { THEMES_DIR } from "./themes.ts";

/** Container path the briefing file is mounted at. */
export const BRIEFING_MOUNT = "/briefing/system-append.md";

/** Everything `render` prints and `up` will later execute. */
export interface RenderedWorker {
  workerId: string;
  role: string;
  runId: string;
  /**
   * Host directory this run's state lives under — `runPaths().root`, the same
   * value `up` computes, never a second derivation of it (ISC-188).
   */
  runDir: string;
  image: string;
  /**
   * The toolchain `image` was tagged from.
   *
   * Carried rather than re-derived because `up`'s image gate has to tell an
   * operator WHICH `pifleet image build --toolchain <t>` would produce the tag
   * it just refused, and reading it back out of the tag string would be parsing
   * a value this record already holds. Recomputing it from the config would be
   * a second derivation of the thing `image` is the first derivation of — the
   * same drift ISC-188 exists to prevent one layer up.
   */
  toolchain: Toolchain;
  /** Full `docker run` argv, element 0 = "docker". */
  docker: string[];
  /** The worker process argv as Pi sees it, element 0 = "pi". */
  pi: string[];
  /** The one briefing file: where it goes, and what goes in it. */
  systemAppend: {
    hostPath: string;
    containerPath: string;
    /** Concatenated fragment text, in defaults → role → worker order. */
    content: string;
  } | null;
}

export interface RenderOptions {
  /** Names the run-dir and container; `render` is dry so there is no real run yet. */
  runId?: string;
}

/**
 * Read and concatenate briefing fragments in merge order.
 *
 * File fragments are read here — reading is not spawning — and a missing file
 * is a loud, pathed error rather than a briefing that silently shrinks.
 */
async function concatBriefing(w: ResolvedWorker): Promise<string | null> {
  const parts: string[] = [];
  for (const frag of w.briefing) {
    if (frag.kind === "inline") {
      parts.push(frag.value.trim());
      continue;
    }
    const file = Bun.file(frag.value);
    if (!(await file.exists())) {
      throw new ConfigError(
        `briefing file missing for worker "${w.id}" (${frag.source}): ${frag.value}`,
      );
    }
    parts.push((await file.text()).trim());
  }
  if (parts.length === 0) return null;
  return `${parts.join("\n\n")}\n`;
}

/**
 * Build the Pi argv for a resolved worker. Pure.
 *
 * `--mode rpc` is emitted for every pane mode EXCEPT `tui`, and that one flag
 * is the WHOLE of what `pane_mode: tui` does to this argv.
 *
 * THERE IS NO `--mode tui`. Measured against the shipped worker image,
 * `pi --help` in `pifleet/pi-worker:0.79.6-base` reports exactly:
 *
 *     --mode <mode>   Output mode: text (default), json, or rpc
 *
 * Pi's TUI is `text` — its DEFAULT — attached to a real terminal (SRD §162:
 * "a TTY has one owner"). So a TUI worker is this same argv with the flag left
 * OFF, not a third value for it. Emitting `--mode tui` would be refused by
 * nothing on this path: Pi would take the unrecognized value and the container
 * would come up as something nobody chose, which is why the omission is
 * written as an omission rather than as a second `argv.push`.
 *
 * Everything below this branch is deliberately IDENTICAL in both modes —
 * `--session-id`, `--session-dir`, `--append-system-prompt`, the discovery
 * denials, `--tools`, `--exclude-tools`, `--skill`. SRD §3.5 states the
 * harvest path is "identical" in `tui` because `--session-id` is chosen before
 * launch, and that sentence is a REQUIREMENT rather than an observation: a tui
 * worker whose session flags drifted would write its transcript somewhere
 * `harvest` does not look, and a harvest that finds nothing reports nothing —
 * the run would look alive and produce no record. So the branch covers one
 * flag and no others, and any future flag added here must be added for both.
 *
 * The test is `=== "tui"` rather than `=== "rpc"` so an absent `paneMode`
 * keeps the RPC control plane. `resolveWorker` always sets the field
 * (`load.ts` defaults it to `"rpc"`), but two integration probes hand this
 * function a hand-built object cast to `ResolvedWorker`, and of the two ways
 * to be wrong about an unset value, "started an RPC worker for a pane that
 * wanted a TTY" is loud and "dropped the control plane out from under the
 * supervisor" is not.
 */
export function buildPiArgv(w: ResolvedWorker, hasBriefing: boolean): string[] {
  const argv: string[] = ["pi"];
  if (w.paneMode !== "tui") argv.push("--mode", "rpc");
  argv.push("--session-id", w.id);
  argv.push("--session-dir", "/sessions");
  // Mandatory discovery denials (SRD §12.2): the repo under test may carry
  // `.pi/extensions/*.ts` that Pi would otherwise execute in-process. `--skill`
  // stays additive under `--no-skills`, so nothing configured is lost.
  argv.push("--no-extensions", "--no-skills", "--no-context-files");
  /*
   * Where the bundled colour themes live (`config/themes.ts`).
   *
   * UNCONDITIONAL, which is the same rule the discovery denials above follow
   * and is deliberate on two counts. It keeps the argv identical in both pane
   * modes, which the block above this function requires of every flag that is
   * not the mode switch itself. And it means the 16 bundled names are
   * selectable from inside a pane with `/settings`, not only from `fleet.yaml`
   * — an operator retinting a pane by hand should not need a config edit and a
   * relaunch.
   *
   * Safe against an older image that has no such directory: measured against
   * Pi 0.79.6, a `--theme` path that does not exist is ignored silently rather
   * than refused. Worth knowing rather than assuming, because the failure it
   * would otherwise cause is every worker in the fleet declining to start.
   */
  argv.push("--theme", THEMES_DIR);
  /*
   * The auto-trigger extension (§9 Q4) — the flag that removes the keystroke.
   *
   * `--no-extensions` is already on this argv and STAYS: measured against
   * `pi --help` in this image, it disables *discovery* only — "explicit -e
   * paths still work". So §12.2's denial of repo-supplied `.pi/extensions/*.ts`
   * is untouched, and the only extension that loads is the one pifleet mounts
   * read-only at a path the worker cannot write. The two flags are not in
   * tension; they are the two halves of "run our extension and nobody else's".
   *
   * `tui` only, and the same `w.autoTrigger` predicate `buildDockerArgv` uses
   * for the mount. An rpc worker is dispatched down the control socket and has
   * no staged brief to trigger.
   */
  if (w.paneMode === "tui" && w.autoTrigger) {
    argv.push("--extension", DISPATCH_TRIGGER_PATH);
  }
  argv.push("--provider", w.provider);
  argv.push("--model", w.model);
  if (w.thinking !== undefined) argv.push("--thinking", w.thinking);
  if (w.tools !== undefined) argv.push("--tools", w.tools.join(","));
  if (w.excludeTools !== undefined && w.excludeTools.length > 0) {
    argv.push("--exclude-tools", w.excludeTools.join(","));
  }
  if (hasBriefing) argv.push("--append-system-prompt", BRIEFING_MOUNT);
  for (const skill of w.skills) argv.push("--skill", `/skills/${skill}`);
  return argv;
}

/**
 * Build the full `docker run` argv. Pure given the resolved pieces.
 *
 * Takes the `RunPaths`/`WorkerPaths` structs rather than a run-dir string
 * precisely so no mount can be joined here: every host path below is one this
 * function was HANDED by `run/paths.ts`, which is what makes "the preview and
 * the launch name the same directory" a property of the types rather than of
 * two `join()` calls agreeing (ISC-188).
 */
export function buildDockerArgv(
  loaded: LoadedConfig,
  w: ResolvedWorker,
  opts: {
    run: RunPaths;
    worker: WorkerPaths;
    image: string;
    piFlags: string[];
    hasBriefing: boolean;
  },
): string[] {
  // `loaded.config.run` is deliberately NOT destructured here, and no local is
  // named `run`. The config's run section and the `RunPaths` in `opts.run` are
  // different objects that BOTH carry a `.root`, so a binding named `run`
  // would leave the wrong one one keystroke away from every mount below —
  // `join(run.root, "outbox", w.id)` would compile, typecheck, and silently
  // restore the exact divergence this function was rewritten to close
  // (ISC-188). With the name unbound, that line does not compile at all. The
  // single field this function needs from the section is read at its use site.
  const { docker, cloud } = loaded.config;
  const argv: string[] = ["docker", "run", "-i"];
  /*
   * `-t` for a `tui` worker and for nothing else (SRD §3.5).
   *
   * Placed here so the pair reads as the `-it` it is, and — more to the point
   * — so an `rpc` worker's argv stays BYTE-IDENTICAL to what this function
   * emitted before `pane_mode` was read by anything: `["docker", "run", "-i",
   * "--rm", …]`, with `-t` inserted into the gap rather than the array
   * rebuilt around it. `render.test.ts` pins that whole array with `toEqual`.
   * The risk in wiring `pane_mode` was never the tui path, which had no
   * behaviour to regress; it was moving the default one by a byte.
   *
   * WHAT THIS FLAG DOES NOT CLAIM: that the argv it lands in is runnable
   * as-is. Measured against docker 28.4.0 on 2026-08-31:
   *
   *   docker run --rm -i -t alpine:3 true </dev/null
   *     -> "the input device is not a TTY", exit 1
   *   docker run -d  -i -t alpine:3 sleep 5
   *     -> starts; .Config.Tty=true, .Config.OpenStdin=true
   *
   * The Docker CLI refuses `-t` in the FOREGROUND when its own stdin is not a
   * terminal, and the foreground-with-pipes shape is exactly how the
   * supervisor spawns a worker today — it has to, because RPC mode is a JSONL
   * protocol on that pipe (§3.4 rule 1). The DETACHED form is the one that
   * produces the pseudo-TTY `docker attach` needs. Supplying that launch shape
   * is the rest of the plan: the supervisor must stop owning a tui worker's
   * stdin, and the pane must run `docker attach`. Neither is wired yet, so a
   * `tui` worker renders correctly TODAY and does not run. That is recorded
   * here rather than left to be discovered, because the failure is a one-line
   * CLI error that does not mention `pane_mode`.
   */
  if (w.paneMode === "tui") argv.push("-t");
  argv.push("--rm");
  argv.push("--name", workerContainerName(opts.run.runId, w.id));
  // `WORKER_UID`, not a literal, because the gcloud tmpfs below must be owned
  // by exactly this uid to be writable and a drift between the two is silent:
  // the tmpfs simply mounts root-owned and gcloud degrades to warnings.
  argv.push("--user", `${WORKER_UID}:${WORKER_UID}`);
  argv.push("--security-opt", "no-new-privileges");
  argv.push("--cap-drop", "ALL");
  if (docker.read_only_root) argv.push("--read-only");
  // noexec /tmp blocks "download a binary and run it" while /workspace and
  // /outbox stay writable (SRD §5.6).
  argv.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
  // The escape-attempt honeypot's bait needs somewhere to live (ISC-125).
  //
  // `/var/run` is a symlink to `/run`, the root is read-only, and the tmpfs
  // above covers `/tmp` ONLY — so without this line `pifleet-honeypot` cannot
  // create `/var/run/docker.sock` and the entrypoint refuses to start the
  // worker at all.
  //
  // `uid`/`gid` are NOT optional and their absence is silent in the worst way:
  // a tmpfs with no uid option mounts root-owned 0755, the bind fails EACCES,
  // and the failure surfaces as a container that will not come up rather than
  // as a mount that is wrong. Measured both ways against the real image under
  // the full production shape before this line was written. `WORKER_UID` for
  // the same reason the gcloud tmpfs uses it — a drift between the flag and
  // the image's baked uid has no other symptom.
  //
  // 1m, and small on purpose. The socket inode needs almost nothing, and a
  // generous cap would hand a worker a second writable scratch area that no
  // other control accounts for.
  argv.push(
    "--tmpfs",
    `/run:rw,noexec,nosuid,size=1m,uid=${WORKER_UID},gid=${WORKER_UID}`,
  );
  // The image's baked CLOUDSDK_CONFIG is an ordinary directory on the root
  // filesystem, so `--read-only` above made it unwritable and every gcloud
  // call in a worker crashed with `[Errno 30] Read-only file system` — with a
  // VALID credential present (ISC-255). See `gcloudConfigTmpfsArgv` for the
  // measured evidence and for why each option on it is there.
  //
  // Unconditional, NOT gated on `w.cloudAccess`: gcloud is on the PATH of
  // every worker whatever its credential plan, `USE_GKE_GCLOUD_AUTH_PLUGIN` is
  // baked for all of them, and a `cloud_access: false` worker that runs
  // `gcloud version` should get verbgate's refusal or a clean answer — not a
  // Python traceback about a read-only filesystem, which is a much worse thing
  // to hand an agent than a 77.
  argv.push(...gcloudConfigTmpfsArgv());
  argv.push("--pids-limit", String(docker.pids_limit));
  argv.push("--memory", docker.memory);
  argv.push("--cpus", String(docker.cpus));
  /*
   * THE WORKER'S PROVIDER'S BRIDGE, not the fleet's (D7, §6.5.4).
   *
   * `workerEgressNetwork` is imported rather than re-derived here, and that is
   * the whole point of its existence: `up` CREATES the per-provider bridges
   * through `egressBridgePlan`, this ATTACHES workers to them, and the two
   * deciding separately is a defect Docker will not report. An absent network
   * name is an error, but the BASE network is a clean start onto a bridge whose
   * relay serves a different provider's upstream — a worker dialing its own
   * `base_url` and reaching somebody else's endpoint, with its own credential.
   *
   * A flat fleet is unchanged: the function returns `docker.network` verbatim
   * when there is no `providers:` map.
   */
  argv.push("--network", workerEgressNetwork(loaded.config, docker.network, w.provider));
  argv.push("--env-file", opts.worker.envFile);

  // Mount table (SRD §5.5). Nothing else is mounted — notably not the main
  // checkout, ~/.ssh, ~/.env, `hostGcloudConfigDir()`, or the Docker socket.
  // That directory is named through the constant rather than spelled out in
  // prose here so the comment cannot go stale against the assertion at the
  // bottom of this function, which is what actually enforces it.
  //
  // `run.repo` is the one host path in this function that config legitimately
  // names — it is the operator's checkout, not a run-dir path. It is read at
  // its use site rather than through a local; see the destructure above for
  // why nothing in this function is named `run`.
  const repo = expandPath(loaded.config.run.repo, loaded.dir);
  switch (w.isolation) {
    case "worktree":
      // `workerWorktree`, not a `join` of its own: `run/worktree.ts` CREATES
      // this directory and this line MOUNTS it, and a bind mount does not fail
      // when the two disagree — Docker creates the missing source and the
      // worker comes up with an empty `/workspace`. That is ISC-188's failure
      // shape exactly, which is why the path now has one definition.
      //
      // `opts.run.root`, NOT `repo`, as of ISC-298: the checkout lives under
      // the run dir rather than beside the operator's own, so the widening
      // that lets the container's baked uid write it lands on a directory
      // pifleet owns. The run id is a segment of `root`, so the run-scoping
      // ISC-295 introduced is now structural rather than a third argument
      // this call has to remember to pass. See `workerWorktree`.
      argv.push("-v", `${workerWorktree(opts.run.root, w.id)}:/workspace`);
      break;
    case "shared-ro":
      argv.push("-v", `${repo}:/workspace:ro`);
      break;
    case "none":
      // No code mount at all — the role works against live systems, not the repo.
      break;
  }

  argv.push("-v", `${workerOutboxDir(opts.run.root, w.id)}:/outbox`);
  argv.push("-v", `${opts.run.sessionsDir}:/sessions`);
  argv.push("-v", `${roleSkillsDir(opts.run.root, w.role)}:/skills:ro`);
  // The verbgate policy is mounted READ-ONLY and separately from /outbox. It
  // used to be read out of /outbox, which the worker owns — so the subject of
  // the policy could rewrite the policy, and the task-scoped cloud grant was a
  // suggestion rather than a control.
  argv.push("-v", `${opts.worker.cloudAllow}:/policy/cloud-allow:ro`);
  // Task provenance, same surface and same integrity rule as the allow file:
  // read-only to the worker, rewritten in place by the supervisor at each
  // dispatch. It is NOT environment, because a worker container outlives any
  // one epoch and a worker can rewrite its own environment (ISC-362).
  argv.push("-v", `${opts.worker.taskPolicy}:${TASK_POLICY_MOUNT}:ro`);
  /*
   * The task drop — a SIBLING of the provenance file above, on the same policy
   * surface, under the same integrity rule (SRD-TUI-DISPATCH §6.2, D4).
   *
   * It carries the staged brief for a worker whose terminal belongs to a
   * person, so pifleet has no wire to deliver one on and writes it as a file
   * instead. `:ro` is doing the same work here that it does for `/secrets` and
   * `/policy/cloud-allow`, and it is doing it against a stronger adversary: the
   * macOS Docker VM squashes bind-mount ownership to the container user, so the
   * host's 0444 reads as OWNED by uid 10001 inside the container and the mount
   * flag is the only thing left. `docker/verbgate`'s integrity loop refuses
   * every verb when this file is writable, which means a dropped `:ro` costs
   * the whole worker rather than one forged brief.
   *
   * UNCONDITIONAL, like `/policy/task` and unlike anything gated on a role
   * field. Only a `tui` worker on an adopted terminal can be staged, but the
   * mount is not what decides that — the staging route is — and a `-v` behind a
   * predicate that `materialize.ts` would have to spell a second time is the
   * ISC-188 shape this file keeps closing. A worker that never stages reads a
   * drop saying nothing is staged.
   */
  argv.push("-v", `${opts.worker.dispatchPolicy}:${DISPATCH_POLICY_MOUNT}:ro`);
  /*
   * The secret store, `:ro` like every other input the worker only reads.
   *
   * READ-ONLY is doing real work here and is not decoration. The host file is
   * 0444, and the macOS Docker VM squashes bind-mount ownership to the
   * container user — so inside the container that file reads as OWNED by uid
   * 10001, and the mount flag is what stops a worker rewriting its own
   * credential store and then reporting on what it wrote. Exactly the argument
   * `/policy/cloud-allow:ro` above already makes about the verbgate policy.
   *
   * UNCONDITIONAL UNDER D8, and the gate that used to stand here was removed
   * rather than widened. This is the change ISC-407/ISC-408 rest on, so the
   * reasoning is recorded at length.
   *
   * It read `if (opts.hasSecrets)`, meaning `w.secrets.length > 0`, and
   * `materialize.ts` wrote the directory behind the IDENTICAL predicate,
   * spelled out a second time. Two conditions that merely agree are the shape
   * this repo keeps closing (ISC-188), and the failure here is silent in the
   * usual direction: Docker CREATES a missing bind-mount source rather than
   * refusing, so a mount without a directory yields an empty `/secrets` and a
   * worker that cannot explain itself.
   *
   * D8 makes that divergence the COMMON case rather than a latent one. The
   * Class 1 provider key is now delivered as a file in this store, and no
   * worker requests it — every worker carries it and `w.secrets` is empty for
   * most of them. Under the old gate such a worker got a perfectly well-formed
   * `PIFLEET_LLM_API_KEY_FILE=/secrets/<NAME>` pointing into a directory that
   * was never written and never mounted: §5.9's quiet-failure shape with an
   * extra layer of plausibility on top, which is precisely what §6.6 exists to
   * remove.
   *
   * The gate is DELETED rather than re-spelled because a boolean that is true
   * for every worker is a decision nobody is making, and leaving it as a
   * parameter would keep a knob whose only remaining use is to reintroduce the
   * defect. With no predicate on either side there is nothing left to diverge:
   * `materialize.ts` writes this directory for every worker too, and re-checks
   * this exact argv string before it writes the env file that points into it.
   *
   * THIS SUPERSEDES ISC-340's SECOND CLAUSE — "a worker that asked for no
   * secret gets no mount at all" — and the supersession is deliberate, not
   * collateral. That clause was written when `/secrets` meant "what the
   * operator granted", and the empty-mount argument it rests on ("an empty
   * `/secrets` in a worker granted nothing says less than its absence does")
   * was sound under that meaning. Under D8 `/secrets` means "material this
   * worker holds", and a worker holding nothing is now the rare case — a
   * keyless local oMLX with no grants — rather than the default. ISC-340's
   * FIRST clause, the one the mutation record actually pins, is untouched: the
   * mount is still `:ro`, still at the fixed container path, and still built
   * from `workerPaths().secretsDir` rather than joined here.
   */
  argv.push("-v", `${opts.worker.secretsDir}:${SECRETS_MOUNT}:ro`);
  // Container-local Pi state — NEVER the host ~/.pi/agent, which holds real
  // auth and sessions (SRD §5.5).
  argv.push("-v", `pifleet-piagent-${w.id}:/home/pi/.pi/agent`);
  if (opts.hasBriefing) {
    argv.push("-v", `${opts.worker.systemAppendMd}:${BRIEFING_MOUNT}:ro`);
  }
  if (cloud.kubeconfig !== null && w.cloudAccess) {
    argv.push("-v", `${opts.worker.kubeconfig}:/home/pi/.kube/config:ro`);
  }

  argv.push(opts.image);
  // ENTRYPOINT is `tini -- pifleet-entrypoint`, which execs `pi "$@"`, so
  // everything after the image is the Pi flag list (argv[0] excluded).
  argv.push(...opts.piFlags);

  // ISC-44, enforced rather than described. Every mount above is either a
  // run-dir path or `run.repo`, and `run.repo` is OPERATOR-CONFIGURABLE: a
  // fleet.yaml naming `~` or `~/.config` mounts a directory that CONTAINS the
  // host gcloud auth store at /workspace, handing the worker every account the
  // operator has ever logged in. No literal in this function can be audited to
  // rule that out, because the offending path arrives from config — so the
  // check runs on the finished argv, where the value is knowable. Throwing
  // beats returning a flag: a launcher that ignores a returned warning is the
  // same launcher that would have shipped the mount.
  assertNoHostGcloudMount(argv);
  // ISC-127, enforced on the same argv and for the same reason. The mount
  // table above deliberately names several paths INSIDE the run directory —
  // /outbox, /sessions, /skills, /policy/cloud-allow, the briefing — and
  // deliberately never names the run directory itself, which also holds
  // `control-auth.json`, the ledger, the inbox and every other worker's state.
  // No literal here can rule out the ancestor case: `run.repo` is
  // operator-settable and the runs root moves independently via
  // `PIFLEET_RUNS_DIR`, so a checkout that CONTAINS the runs root mounts the
  // live run directory at /workspace with nothing in this function looking
  // wrong. See `classifyRunDirExposure` for the measured shape of that.
  assertNoRunDirMount(argv, opts.run.root);
  return argv;
}

/**
 * Refuse any `@`-prefixed element (ISC-66) — see the header for why.
 *
 * Exported for direct test. This is an invariant on argv *this module builds*,
 * not a validation of user input: `--skill` prefixes its value with `/skills/`
 * and the briefing path is a constant, so almost no config can produce an `@`.
 * That makes it untestable through `renderWorker` alone — deleting both call
 * sites left the entire suite green, because the fixture contains no `@` and
 * the test was asserting a property of the fixture.
 */
export function assertNoAtPaths(argv: string[], what: string): string[] {
  for (const a of argv) {
    if (a.startsWith("@")) {
      throw new ConfigError(
        `${what} contains an @-prefixed argument (${a}) — Pi has no @ sigil and would treat it as literal text`,
      );
    }
  }
  // Returns the argv so the check can sit IN the data path rather than beside
  // it. As a bare statement it was disable-able three ways — deletion, a
  // comment, `if (false)` — and only deletion was observable, because the test
  // that pinned the call sites grepped this file's source text. A dead call
  // site is the same as no call site. Threaded through the value, removing it
  // fails to compile.
  return argv;
}

/** Render one worker. Reads briefing files; spawns nothing; writes nothing. */
export async function renderWorker(
  loaded: LoadedConfig,
  workerId: string,
  options: RenderOptions = {},
): Promise<RenderedWorker> {
  const runId = options.runId ?? "dry";
  const w = resolveWorker(loaded, workerId);
  /**
   * The run directory comes from `run/paths.ts` and NOWHERE else (ISC-188).
   *
   * It used to be `expandPath(loaded.config.run.root, loaded.dir)`, which is a
   * second, independent answer to a question `runsRoot()` already answers — and
   * the two disagree the moment `PIFLEET_RUNS_DIR` is set, which is how every
   * test rig and the detached daemon are pointed at their runs root. `up` calls
   * `runsRoot()`; `render` read a config field `up` never consults. So the
   * command that exists to say "here is exactly what `up` will run" named an
   * `--env-file`, an `/outbox`, a `/skills` mount and a briefing under a
   * directory the real launch would not use, and nothing failed — a preview is
   * only ever compared to reality by a human, and only if they look.
   *
   * `config.run.root` is therefore not consulted here. It is still parsed and
   * still defaulted (see `RunSchema`), and no other reader exists.
   */
  const run = runPaths(runId, runsRoot());
  const worker = workerPaths(run, w.id);

  const content = await concatBriefing(w);
  const hasBriefing = content !== null;

  const image = imageTag(loaded.config, w.toolchain);
  // The `@` guard is applied AS the value is produced, not as a statement
  // afterwards. Both argvs must pass through it to exist at all.
  const pi = assertNoAtPaths(buildPiArgv(w, hasBriefing), `pi argv for ${w.id}`);
  const docker = assertNoAtPaths(
    buildDockerArgv(loaded, w, {
      run,
      worker,
      image,
      piFlags: pi.slice(1),
      hasBriefing,
    }),
    `docker argv for ${w.id}`,
  );

  // ISC-127's symlink half, which `buildDockerArgv` structurally cannot do:
  // it is synchronous and pure by design, and `realpath` is I/O. This function
  // is `async`, is the only production path that produces a worker argv, and
  // `materializeWorkerInputs` awaits it per worker BEFORE creating anything —
  // so the pre-flight costs nothing architecturally and runs early enough to
  // refuse before any host path exists. The lexical guard above still runs and
  // is not redundant: it is the one that holds for any future synchronous
  // caller of `buildDockerArgv`. See `assertNoRunDirMountResolved` for the
  // routine (`~/repos` -> `/Volumes/...`) shape of what it catches.
  await assertNoRunDirMountResolved(docker, run.root, runsRoot());

  return {
    workerId: w.id,
    role: w.role,
    runId,
    runDir: run.root,
    image,
    toolchain: w.toolchain,
    docker,
    pi,
    systemAppend: hasBriefing
      ? {
          // The SAME string the `-v` above mounts, not a matching one.
          hostPath: worker.systemAppendMd,
          containerPath: BRIEFING_MOUNT,
          content,
        }
      : null,
  };
}

/**
 * Render every configured worker — one container per `workers:` entry (ISC-61).
 *
 * `workerIds` DEFAULTS to the whole `workers:` list, which is the criterion's
 * own sentence and the shape every existing caller uses. It is a parameter
 * rather than an assumption because `up` may be pointed at a subset with
 * `--workers`, and its image gate has to be about the containers this run will
 * actually start — gating on a worker that is not launching would refuse a run
 * for an image nothing needed, and gating on the whole list while launching a
 * subset would be the same bug wearing the opposite sign.
 *
 * WHAT THIS FUNCTION USED TO BE: unreachable. It had ZERO callers in `src/` —
 * only `test/unit/render.test.ts` and `test/e2e/scale-16-workers.test.ts` — so
 * the only function in the tree that mapped a `workers:` list of length N onto
 * N rendered containers was exercised exclusively by tests, while `up` derived
 * its launch set from argv alone and defaulted it to the literal string
 * "eng-1". ISC-61 was graded `[x]` on that arrangement, and was false in
 * production. It is now on the `up` path via the image gate; the count itself
 * is re-checked at the CLI in `test/integration/up-wiring.test.ts`, not here,
 * because a test that calls this function directly is what produced the wrong
 * grade the first time.
 */
export async function renderAllWorkers(
  loaded: LoadedConfig,
  options: RenderOptions = {},
  workerIds: readonly string[] = loaded.config.workers.map((w) => w.id),
): Promise<RenderedWorker[]> {
  const out: RenderedWorker[] = [];
  for (const id of workerIds) {
    out.push(await renderWorker(loaded, id, options));
  }
  return out;
}
