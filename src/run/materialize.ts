/**
 * The host half of the mount table (SRD §5.5): making the sources exist.
 *
 * `config/render.ts` decides WHAT a worker's `docker run` mounts. Nothing until
 * now decided that those host paths exist, and on a bind mount that gap does
 * not fail — it succeeds wrongly. Docker creates a missing `-v` source rather
 * than refusing: a directory source appears empty, and a FILE source appears as
 * an empty DIRECTORY. So an unmaterialized `/skills` is a worker briefed with
 * no skills, and an unmaterialized `/policy/cloud-allow` is `docker/verbgate`
 * reading a directory — its `[ -r ]` passes, the `while read` loop yields
 * nothing, and the run silently degrades to deny-all while leaving a spurious
 * directory named `cloud-allow` in the run dir. That is the same
 * silent-empty-mount failure class `container/mounts.ts` exists to describe,
 * arriving one layer earlier.
 *
 * Two rules shape this module:
 *
 * 1. **Derived from `renderWorker`, never re-derived.** Whether a worker has a
 *    briefing, what the briefing CONTAINS, and the host path it is written to
 *    all come from the one function that also emits the `-v` — so the writer
 *    and the mount cannot disagree. Re-deriving any of the three here would
 *    rebuild ISC-188's defect in the opposite direction: a file written where
 *    no mount points at it is as silent as a mount pointing at no file.
 *
 * 2. **Partial materialization aborts the whole launch.** There is no
 *    per-worker `catch { continue }`. A worker whose skill bundle failed to
 *    copy would come up with an empty `/skills` and no error anywhere, which is
 *    strictly worse than not coming up at all — and unlike everything from
 *    `launchDetached` onward, nothing here has been spawned yet, so a refusal
 *    costs nothing to reap.
 *
 * NOT materialized here, each for a stated reason:
 *
 *  - `/workspace` — either the operator's own checkout (`shared-ro`) or a
 *    per-worker git worktree that nothing creates yet. Neither is this
 *    module's to write.
 *  - `/sessions` — created and opened by `up` itself, before this runs.
 *  - `pifleet-piagent-<id>` — a named volume; Docker owns it by construction.
 *  - the `--env-file`. Deliberate, and the asymmetry with `cloud-allow` is the
 *    point: an EMPTY allow list is semantically correct (deny-all for mutating
 *    verbs, read verbs unaffected — the right run-time default), while an empty
 *    env file is semantically WRONG. A worker would start with no `base_url`,
 *    no API key and no `CLOUDSDK_*` and fail obscurely deep inside the
 *    container. Leaving the path unwritten makes a premature `docker run` fail
 *    loudly on a MISSING `--env-file` instead of quietly on a wrong one.
 */

import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, expandPath, resolveWorker, type LoadedConfig } from "../config/load.ts";
import { renderWorker } from "../config/render.ts";
import { makeWorkerAccessible, makeWorkerReadable } from "../container/mounts.ts";
import { EXIT } from "../contracts.ts";
import {
  roleSkillsDir,
  skillsSourceRoot,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "./paths.ts";

/**
 * A control that could not be ESTABLISHED — EACCES on the run dir, a full
 * disk, a chmod that would not take.
 *
 * Exit 3 rather than 2, matching the egress-network and hazard-scan guards in
 * `up.ts`: a config or content mistake is the operator's (exit 2), an
 * environment that will not let a control be put in place is not (exit 3).
 * `readonly exitCode` is the structural protocol from `contracts.ts`, the same
 * shape `StateReadError` next door uses.
 */
export class MaterializeError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;
  constructor(what: string, cause: unknown) {
    super(
      `could not materialize ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MaterializeError";
  }
}

/** One worker's materialized inputs, as facts rather than intentions. */
export interface MaterializedWorker {
  workerId: string;
  role: string;
  outboxDir: string;
  skillsDir: string;
  cloudAllow: string;
  /** null when the worker has no briefing content (render's own predicate). */
  systemAppendMd: string | null;
  /** null when `cloud.kubeconfig` is null or the worker has no cloud access. */
  kubeconfig: string | null;
  /** The config-named file the kubeconfig was copied FROM; null when none was. */
  kubeconfigSource: string | null;
}

/**
 * Wrap filesystem work so an environment failure arrives as exit 3 and a
 * content failure keeps its own exit 2.
 *
 * `ConfigError` passes through untouched: a missing skill bundle and a full
 * disk are different problems with different fixes, and collapsing them into
 * one code sends the operator to the wrong one.
 */
async function establishing<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new MaterializeError(what, err);
  }
}

/** lstat, or null when the path does not exist. Never follows a final symlink. */
async function shapeOf(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/**
 * Recursive, symlink-refusing, mode-setting copy of one skill bundle.
 *
 * Symlinks are REFUSED, never dereferenced. A skill tree is copied into a mount
 * the worker reads as INSTRUCTION, and a symlink resolves wherever it points —
 * including outside the bundle, at content nobody reviewed as a skill (SRD
 * §5.4). Following one would launder an arbitrary host file into the agent's
 * prompt. The walk is therefore lstat-first and never descends through a link,
 * the same discipline `security/repo-hazards.ts` and `harvest/outbox.ts` use;
 * refusing links also means the recursion cannot cycle.
 *
 * Exported for direct test.
 */
export async function copySkillTree(src: string, dst: string): Promise<void> {
  const root = await shapeOf(src);
  if (root === null) throw new ConfigError(`skill bundle source does not exist: ${src}`);
  if (root.isSymbolicLink()) {
    throw new ConfigError(
      `skill bundle source is a symlink: ${src} — a bundle is mounted as instruction ` +
        `and a link resolves outside it, so links are refused rather than followed (SRD §5.4)`,
    );
  }
  if (!root.isDirectory()) {
    throw new ConfigError(`skill bundle source is not a directory: ${src}`);
  }
  await mkdir(dst, { recursive: true });
  await makeWorkerAccessible(dst, false);

  // Sorted so a bundle copies in a stable order; a failure part-way through
  // then names the same entry on every run rather than a filesystem-order one.
  for (const name of (await readdir(src)).sort()) {
    const from = join(src, name);
    const to = join(dst, name);
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) {
      throw new ConfigError(
        `symlink in skill bundle: ${from} — a bundle is mounted as instruction and a ` +
          `link resolves outside it, so links are refused rather than followed (SRD §5.4)`,
      );
    }
    if (entry.isDirectory()) {
      await copySkillTree(from, to);
      continue;
    }
    if (!entry.isFile()) {
      // A FIFO wedges whoever opens it; a device or socket has no meaning in a
      // bundle at all. Neither is something to copy or to skip quietly.
      throw new ConfigError(`non-regular entry in skill bundle: ${from}`);
    }
    await writeFile(to, await readFile(from));
    await makeWorkerReadable(to);
  }
}

/**
 * Copy every configured skill bundle for one role into `roleSkillsDir()`.
 *
 * Keyed by ROLE because the mount is: `render.ts` emits
 * `<run>/skills/<role>:/skills:ro` for every worker, so N workers of a role
 * share one host directory and copying it N times would be N writes to the
 * same bytes. Idempotent for that reason — a destination that already exists
 * within this run can only have been written by this function, because `runId`
 * is fresh per run and nothing outside the run dir is touched.
 *
 * Exported for direct test.
 */
export async function materializeRoleSkills(
  runRoot: string,
  role: string,
  skillNames: readonly string[],
  sourceRoot: string,
): Promise<string> {
  const dst = roleSkillsDir(runRoot, role);
  if ((await shapeOf(dst))?.isDirectory() === true) return dst;

  await mkdir(dst, { recursive: true });
  // The `<run-dir>/skills` PARENT has to be traversable or the 0755 bundle
  // beneath it is unreachable regardless of its own mode: permission is
  // checked at every path component. `dirname` of the authoritative path
  // rather than a second join, so this cannot name a different directory than
  // the mount does.
  await makeWorkerAccessible(dirname(dst), false);
  await makeWorkerAccessible(dst, false);

  for (const name of skillNames) {
    const from = join(sourceRoot, name);
    if ((await shapeOf(from)) === null) {
      // Loud and pathed, like `render.ts`'s missing-briefing-file refusal. The
      // alternative is a bundle that silently shrinks by one skill, which
      // reads at run time as an agent that ignored its instructions.
      throw new ConfigError(
        `role "${role}" configures skill "${name}", but no bundle exists at ${from} — ` +
          `skill bundles are sourced from <repo>/skills/<name>/ ` +
          `(override the source root with PIFLEET_SKILLS_DIR)`,
      );
    }
    await copySkillTree(from, join(dst, name));
  }
  return dst;
}

/**
 * Materialize every host path `buildDockerArgv` would bind-mount, for every
 * named worker that config actually defines.
 *
 * Membership is an explicit test against `workers:`, exactly as
 * `assertModelsAllowed` does and for the same reason: Phase 1 `--workers`
 * legitimately names ids that exist only as a `PIFLEET_PI_COMMAND` double, and
 * those have no configured mounts to create. A `catch { continue }` around
 * `resolveWorker` would have swallowed unrelated resolution failures with it.
 *
 * Serial by design. There is no throughput argument for parallelizing a handful
 * of small copies, and serial keeps the ledger `seq` the caller writes per
 * worker in an order that means something.
 */
export async function materializeWorkerInputs(
  loaded: LoadedConfig,
  run: RunPaths,
  workerIds: readonly string[],
): Promise<MaterializedWorker[]> {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  const sourceRoot = skillsSourceRoot();
  /** One bundle per role, populated on first sight — see `materializeRoleSkills`. */
  const skillsByRole = new Map<string, string>();
  const out: MaterializedWorker[] = [];

  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    const w = resolveWorker(loaded, workerId);
    const rendered = await renderWorker(loaded, workerId, { runId: run.runId });
    /**
     * `render` resolves its own run dir from `runsRoot()` and so does `up`, so
     * these agree in every real invocation. Compared anyway because if they
     * ever stopped agreeing the symptom would be files written under one root
     * and mounted from another — silent by construction, which is the whole
     * ISC-188 failure. Not a `ConfigError`: no config can cause it, so it is a
     * bug in pifleet and `EXIT.INTERNAL` is the honest code.
     */
    if (rendered.runDir !== run.root) {
      throw new Error(
        `run directory disagreement for ${workerId}: render says ${rendered.runDir}, ` +
          `up says ${run.root} — the materialized inputs would not be the mounted ones`,
      );
    }
    const paths = workerPaths(run, workerId);

    const outboxDir = workerOutboxDir(run.root, workerId);
    await establishing(`the outbox for ${workerId}`, async () => {
      await mkdir(paths.dir, { recursive: true });
      await mkdir(outboxDir, { recursive: true });
      // The `<run-dir>/outbox` parent needs traversal for the same reason the
      // skills parent does; the leaf is rw because the worker writes results
      // into it.
      await makeWorkerAccessible(dirname(outboxDir), false);
      await makeWorkerAccessible(outboxDir, true);
    });

    let skillsDir = skillsByRole.get(w.role);
    if (skillsDir === undefined) {
      skillsDir = await establishing(`the skill bundle for role ${w.role}`, async () => {
        try {
          return await materializeRoleSkills(run.root, w.role, w.skills, sourceRoot);
        } catch (err) {
          // The bundle is per-ROLE so `materializeRoleSkills` cannot name a
          // worker, but the operator's next move is to edit a `workers:` or
          // `roles:` entry — and the id of the worker that first needed this
          // bundle is what points them at the right one.
          if (err instanceof ConfigError) throw new ConfigError(`worker "${workerId}": ${err.message}`);
          throw err;
        }
      });
      skillsByRole.set(w.role, skillsDir);
    }

    /**
     * A ZERO-BYTE REGULAR FILE, and the shape matters more than the content.
     *
     * Cloud authorization is task-scoped, not run-scoped (SRD §5.10) — it
     * lives in the dispatch envelope, so `up` cannot know the real content and
     * must not invent any. Empty is the correct default: `docker/verbgate`
     * finds no matching line, refuses every mutating verb, and leaves read
     * verbs alone. But the file must EXIST before `docker run`, because a
     * single-file bind mount with no host file makes Docker create a
     * DIRECTORY there instead, and a directory reads as deny-all too — while
     * leaving a spurious `cloud-allow/` in the run dir and no clue why.
     *
     * A comment line would be no safer: verbgate has no comment syntax, so a
     * `#` line is only inert by accident of not matching anything.
     *
     * WHOEVER WIRES DISPATCH-TIME REWRITING: write IN PLACE (truncate + write),
     * never tmp + rename. A bind mount pins the INODE, so a rename swaps the
     * file the host sees while the container keeps reading the old one — for
     * the life of the container, with both sides believing the policy changed.
     */
    await establishing(`the cloud policy for ${workerId}`, async () => {
      await writeFile(paths.cloudAllow, "");
      await makeWorkerReadable(paths.cloudAllow);
    });

    /**
     * Briefing content, path, and existence all come from `render` — the same
     * call that decides whether a `-v` is emitted at all. A worker with no
     * fragments gets no file, matching the absent mount exactly.
     */
    let systemAppendMd: string | null = null;
    if (rendered.systemAppend !== null) {
      const briefing = rendered.systemAppend;
      await establishing(`the briefing for ${workerId}`, async () => {
        await writeFile(briefing.hostPath, briefing.content);
        await makeWorkerReadable(briefing.hostPath);
      });
      systemAppendMd = briefing.hostPath;
    }

    /**
     * A mechanical byte copy, gated on the IDENTICAL predicate `render.ts`
     * uses to emit the mount.
     *
     * `cloud.kubeconfig` names a file the operator has ALREADY filtered — the
     * schema says so and `fleet.example.yaml` says so at the key. Filtering is
     * their act, not pifleet's, so there is no credential logic here at all:
     * read, write, chmod. Naming `$HOME/.kube/config` is likewise their
     * choice; refusing it would be authoring a new security control under
     * cover of materializing a mount, so it is a note on stderr, not an error.
     */
    let kubeconfig: string | null = null;
    let kubeconfigSource: string | null = null;
    const configured = loaded.config.cloud.kubeconfig;
    if (configured !== null && w.cloudAccess) {
      const src = expandPath(configured, loaded.dir);
      let bytes: Buffer;
      try {
        bytes = await readFile(src);
      } catch (err) {
        throw new ConfigError(
          `cloud.kubeconfig for worker "${workerId}" names ${src}, which could not be read: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (src === join(homedir(), ".kube", "config")) {
        process.stderr.write(
          `note: cloud.kubeconfig is the host default ${src} — SRD §5.5 expects a ` +
            `filtered copy, and every context in this file is reachable from ${workerId}\n`,
        );
      }
      await establishing(`the kubeconfig for ${workerId}`, async () => {
        await writeFile(paths.kubeconfig, bytes);
        await makeWorkerReadable(paths.kubeconfig);
      });
      kubeconfig = paths.kubeconfig;
      kubeconfigSource = src;
    }

    out.push({
      workerId,
      role: w.role,
      outboxDir,
      skillsDir,
      cloudAllow: paths.cloudAllow,
      systemAppendMd,
      kubeconfig,
      kubeconfigSource,
    });
  }
  return out;
}
