/**
 * Config → container invocation (SRD §6.3), with no side effects.
 *
 * `renderWorker` computes the exact `docker run` argv and the exact `pi` argv
 * for one worker and spawns nothing (ISC-60). It returns normalized argv
 * ARRAYS with every path canonicalized, so a test compares arrays rather than
 * a byte string that would encode one machine's home directory.
 *
 * Two rules here have a recorded failure behind them:
 *
 *  - `--append-system-prompt` is NOT repeatable — last wins, silently. All
 *    briefing fragments (defaults + role + worker) are therefore concatenated
 *    into ONE file at `<run-dir>/workers/<id>/system-append.md` and exactly
 *    one flag is emitted (ISC-65).
 *  - Pi has no `@` sigil. An `@`-prefixed argument is appended as LITERAL
 *    text, which is how a role briefing becomes a 40-character path string
 *    with no error. Rendering refuses to emit any `@`-prefixed argv element
 *    (ISC-66).
 */

import { join, resolve } from "node:path";
import { imageTag } from "../container/image.ts";
import { ConfigError, expandPath, resolveWorker, type LoadedConfig, type ResolvedWorker } from "./load.ts";

/** Container path the briefing file is mounted at. */
export const BRIEFING_MOUNT = "/briefing/system-append.md";

/** Everything `render` prints and `up` will later execute. */
export interface RenderedWorker {
  workerId: string;
  role: string;
  runId: string;
  /** Host directory this run's state lives under (canonicalized). */
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

/** Build the full `docker run` argv. Pure given the resolved pieces. */
export function buildDockerArgv(
  loaded: LoadedConfig,
  w: ResolvedWorker,
  opts: { runId: string; runDir: string; image: string; piFlags: string[]; hasBriefing: boolean },
): string[] {
  const { docker, run, cloud } = loaded.config;
  const argv: string[] = ["docker", "run", "-i", "--rm"];
  argv.push("--name", `pifleet-${opts.runId}-${w.id}`);
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
  argv.push("--env-file", join(opts.runDir, "workers", w.id, "env"));

  // Mount table (SRD §5.5). Nothing else is mounted — notably not the main
  // checkout, ~/.ssh, ~/.env, the host ~/.config/gcloud, or the Docker socket.
  const repo = expandPath(run.repo, loaded.dir);
  switch (w.isolation) {
    case "worktree":
      argv.push("-v", `${join(repo, ".worktrees", w.id)}:/workspace`);
      break;
    case "shared-ro":
      argv.push("-v", `${repo}:/workspace:ro`);
      break;
    case "none":
      // No code mount at all — the role works against live systems, not the repo.
      break;
  }
  argv.push("-v", `${join(opts.runDir, "outbox", w.id)}:/outbox`);
  argv.push("-v", `${join(opts.runDir, "sessions")}:/sessions`);
  argv.push("-v", `${join(opts.runDir, "skills", w.role)}:/skills:ro`);
  // The verbgate policy is mounted READ-ONLY and separately from /outbox. It
  // used to be read out of /outbox, which the worker owns — so the subject of
  // the policy could rewrite the policy, and the task-scoped cloud grant was a
  // suggestion rather than a control.
  argv.push("-v", `${join(opts.runDir, "workers", w.id, "cloud-allow")}:/policy/cloud-allow:ro`);
  // Container-local Pi state — NEVER the host ~/.pi/agent, which holds real
  // auth and sessions (SRD §5.5).
  argv.push("-v", `pifleet-piagent-${w.id}:/home/pi/.pi/agent`);
  if (opts.hasBriefing) {
    argv.push("-v", `${join(opts.runDir, "workers", w.id, "system-append.md")}:${BRIEFING_MOUNT}:ro`);
  }
  if (cloud.kubeconfig !== null && w.cloudAccess) {
    argv.push("-v", `${join(opts.runDir, "workers", w.id, "kubeconfig")}:/home/pi/.kube/config:ro`);
  }

  argv.push(opts.image);
  // ENTRYPOINT is `tini -- pifleet-entrypoint`, which execs `pi "$@"`, so
  // everything after the image is the Pi flag list (argv[0] excluded).
  argv.push(...opts.piFlags);
  return argv;
}

/** Refuse any `@`-prefixed element (ISC-66) — see the header for why. */
function assertNoAtPaths(argv: string[], what: string): void {
  for (const a of argv) {
    if (a.startsWith("@")) {
      throw new ConfigError(
        `${what} contains an @-prefixed argument (${a}) — Pi has no @ sigil and would treat it as literal text`,
      );
    }
  }
}

/** Render one worker. Reads briefing files; spawns nothing; writes nothing. */
export async function renderWorker(
  loaded: LoadedConfig,
  workerId: string,
  options: RenderOptions = {},
): Promise<RenderedWorker> {
  const runId = options.runId ?? "dry";
  const w = resolveWorker(loaded, workerId);
  const runRoot = expandPath(loaded.config.run.root, loaded.dir);
  const runDir = resolve(runRoot, runId);

  const content = await concatBriefing(w);
  const hasBriefing = content !== null;

  const image = imageTag(loaded.config, w.toolchain);
  const pi = buildPiArgv(w, hasBriefing);
  const docker = buildDockerArgv(loaded, w, {
    runId,
    runDir,
    image,
    piFlags: pi.slice(1),
    hasBriefing,
  });

  assertNoAtPaths(pi, `pi argv for ${w.id}`);
  assertNoAtPaths(docker, `docker argv for ${w.id}`);

  return {
    workerId: w.id,
    role: w.role,
    runId,
    runDir,
    image,
    docker,
    pi,
    systemAppend: hasBriefing
      ? {
          hostPath: join(runDir, "workers", w.id, "system-append.md"),
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
