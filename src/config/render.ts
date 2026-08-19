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
 */

import { join } from "node:path";
import { imageTag } from "../container/image.ts";
import {
  roleSkillsDir,
  runPaths,
  runsRoot,
  workerOutboxDir,
  workerPaths,
  workerWorktree,
  type RunPaths,
  type WorkerPaths,
} from "../run/paths.ts";
import { ConfigError, expandPath, resolveWorker, type LoadedConfig, type ResolvedWorker } from "./load.ts";

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

/** Build the Pi argv for a resolved worker. Pure. */
export function buildPiArgv(w: ResolvedWorker, hasBriefing: boolean): string[] {
  const argv: string[] = ["pi"];
  argv.push("--mode", "rpc");
  argv.push("--session-id", w.id);
  argv.push("--session-dir", "/sessions");
  // Mandatory discovery denials (SRD §12.2): the repo under test may carry
  // `.pi/extensions/*.ts` that Pi would otherwise execute in-process. `--skill`
  // stays additive under `--no-skills`, so nothing configured is lost.
  argv.push("--no-extensions", "--no-skills", "--no-context-files");
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
  const argv: string[] = ["docker", "run", "-i", "--rm"];
  argv.push("--name", `pifleet-${opts.run.runId}-${w.id}`);
  argv.push("--user", "10001:10001");
  argv.push("--security-opt", "no-new-privileges");
  argv.push("--cap-drop", "ALL");
  if (docker.read_only_root) argv.push("--read-only");
  // noexec /tmp blocks "download a binary and run it" while /workspace and
  // /outbox stay writable (SRD §5.6).
  argv.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
  argv.push("--pids-limit", String(docker.pids_limit));
  argv.push("--memory", docker.memory);
  argv.push("--cpus", String(docker.cpus));
  argv.push("--network", docker.network);
  argv.push("--env-file", opts.worker.envFile);

  // Mount table (SRD §5.5). Nothing else is mounted — notably not the main
  // checkout, ~/.ssh, ~/.env, the host ~/.config/gcloud, or the Docker socket.
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
      argv.push("-v", `${workerWorktree(repo, w.id)}:/workspace`);
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

  return {
    workerId: w.id,
    role: w.role,
    runId,
    runDir: run.root,
    image,
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

/** Render every configured worker — one container per `workers:` entry (ISC-61). */
export async function renderAllWorkers(
  loaded: LoadedConfig,
  options: RenderOptions = {},
): Promise<RenderedWorker[]> {
  const out: RenderedWorker[] = [];
  for (const w of loaded.config.workers) {
    out.push(await renderWorker(loaded, w.id, options));
  }
  return out;
}
