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
 * Three rules shape this module:
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
 * 3. **Nothing depends on the ORDER `--workers` named ids in.** The skill
 *    bundle is per-ROLE but `skills:` is per-WORKER overridable
 *    (`config/load.ts`'s `pick`), so the bundle is planned as the UNION across
 *    every named worker of a role, in a pre-pass, before anything is written.
 *    Keyed on the role alone and populated from whichever worker arrived first,
 *    it produced different on-disk bytes from the same config depending on
 *    argument order — and, worse, skipped the missing-bundle refusal entirely
 *    whenever the offending skill belonged to a later worker of an
 *    already-cached role.
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
import {
  ConfigError,
  expandPath,
  resolveWorker,
  type LoadedConfig,
  type ResolvedWorker,
} from "../config/load.ts";
import { renderWorker } from "../config/render.ts";
import { makeWorkerAccessible, makeWorkerReadable } from "../container/mounts.ts";
import { EXIT } from "../contracts.ts";
import { resolvedWithin } from "../harvest/outbox.ts";
import {
  roleSkillsDir,
  skillsSourceRoot,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "./paths.ts";

/**
 * Bounds on the skill-tree walk, matching the shape `security/repo-hazards.ts`
 * and `harvest/outbox.ts` already use.
 *
 * A skill source is operator-controlled today, so these are defence in depth
 * rather than an active exploit — but the docstring below claims parity with
 * those walks, and a claimed control that is not implemented is worse than an
 * absent one. Each bound answers a way a copy stops terminating: an enormous
 * directory, an enormous file buffered whole, and a tree deep enough to
 * exhaust the stack.
 */
export const MAX_SKILL_DIR_ENTRIES = 10_000;
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_DEPTH = 16;

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
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "MaterializeError";
  }
}

/** One worker's materialized inputs, as facts rather than intentions. */
export interface MaterializedWorker {
  workerId: string;
  role: string;
  outboxDir: string;
  /**
   * The worker's OWN resolved skill list — the names `render` turns into
   * `--skill /skills/<name>`. Recorded because the bundle is per-role and this
   * list is per-worker, which is precisely where the two used to diverge.
   */
  skillNames: readonly string[];
  skillsDir: string;
  cloudAllow: string;
  /** null when the worker has no briefing content (render's own predicate). */
  systemAppendMd: string | null;
  /** null when `cloud.kubeconfig` is null or the worker has no cloud access. */
  kubeconfig: string | null;
  /** The config-named file the kubeconfig was copied FROM; null when none was. */
  kubeconfigSource: string | null;
}

/** Called as each worker finishes, so a failure part-way leaves a record of what exists. */
export type MaterializedWorkerSink = (worker: MaterializedWorker) => Promise<void>;

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

/**
 * lstat, or null when the path genuinely does not exist.
 *
 * ONLY `ENOENT` becomes null. Every other stat failure propagates, because a
 * bare `catch { return null }` reported `EACCES` on an unreadable parent as
 * "no bundle exists" — a config diagnosis (exit 2) for an environment fault
 * (exit 3), sending the operator to edit a config that was already correct.
 * Never follows a final symlink.
 */
async function shapeOf(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Refuse a DESTINATION that is a symlink, before writing through it.
 *
 * The source side refuses links so a bundle cannot import content from outside
 * itself; this is the other direction, and it was missing. `mkdir` and `chmod`
 * both FOLLOW a symlink, so a link planted at a destination path would have
 * pifleet reopen the permissions of whatever it points at — directly against
 * `makeWorkerAccessible`'s own stated contract that callers only aim it at
 * directories pifleet created under the run root.
 *
 * Exit 3, not 2: every destination here is inside a run directory with a fresh
 * `runId`, so a link there is tampering or a broken environment, never
 * something an operator wrote in a config.
 */
async function refuseSymlinkDestination(path: string): Promise<void> {
  const st = await shapeOf(path);
  if (st !== null && st.isSymbolicLink()) {
    throw new MaterializeError(
      `the destination ${path}`,
      "it is a symlink, and mkdir/chmod would follow it out of the run directory",
    );
  }
}

/**
 * Refuse a name that is not a single, safe path segment.
 *
 * `FleetConfigSchema` already rejects these at load, which is where a name
 * that cannot be spelled stops being able to escape. This is the belt to that
 * pair of braces: `materializeRoleSkills` is exported and a future caller
 * reaching it without schema validation must still be safe, because the two
 * joins below become `mkdir`, `chmod` and `writeFile` on the host.
 */
function assertContained(root: string, name: string, what: string): string {
  const path = join(root, name);
  if (!resolvedWithin(root, path)) {
    throw new ConfigError(
      `${what} "${name}" escapes ${root} — a skill name is a mount path segment, ` +
        `not a path`,
    );
  }
  return path;
}

/**
 * Recursive, symlink-refusing, bounded, mode-setting copy of one skill bundle.
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
export async function copySkillTree(src: string, dst: string, depth = 0): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) {
    throw new ConfigError(
      `skill bundle nests deeper than ${MAX_SKILL_DEPTH} directories at ${src}`,
    );
  }
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
  await refuseSymlinkDestination(dst);
  await mkdir(dst, { recursive: true });
  await makeWorkerAccessible(dst, false);

  // Sorted so a bundle copies in a stable order; a failure part-way through
  // then names the same entry on every run rather than a filesystem-order one.
  const names = (await readdir(src)).sort();
  if (names.length > MAX_SKILL_DIR_ENTRIES) {
    throw new ConfigError(
      `skill bundle directory ${src} holds ${names.length} entries, over the ` +
        `${MAX_SKILL_DIR_ENTRIES} cap — that is a payload, not a bundle`,
    );
  }
  for (const name of names) {
    // `readdir` yields basenames, so neither join can traverse; checked anyway
    // because "it cannot contain a separator" is an assumption about another
    // API rather than a property of this loop.
    const from = assertContained(src, name, "skill bundle entry");
    const to = assertContained(dst, name, "skill bundle entry");
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) {
      throw new ConfigError(
        `symlink in skill bundle: ${from} — a bundle is mounted as instruction and a ` +
          `link resolves outside it, so links are refused rather than followed (SRD §5.4)`,
      );
    }
    if (entry.isDirectory()) {
      await copySkillTree(from, to, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      // A FIFO wedges whoever opens it; a device or socket has no meaning in a
      // bundle at all. Neither is something to copy or to skip quietly.
      throw new ConfigError(`non-regular entry in skill bundle: ${from}`);
    }
    // From the lstat, BEFORE a byte is buffered — `harvest/outbox.ts`'s rule,
    // and for its reason: a cap checked after `readFile` is the OOM it exists
    // to prevent.
    if (entry.size > MAX_SKILL_FILE_BYTES) {
      throw new ConfigError(
        `skill file ${from} is ${entry.size} bytes, over the ${MAX_SKILL_FILE_BYTES} cap`,
      );
    }
    await refuseSymlinkDestination(to);
    await writeFile(to, await readFile(from));
    await makeWorkerReadable(to, true);
  }
}

/**
 * Copy a set of skill bundles into one role's `roleSkillsDir()`.
 *
 * Keyed by ROLE because the mount is: `render.ts` emits
 * `<run>/skills/<role>:/skills:ro` for every worker of that role. `skillNames`
 * must therefore be the UNION over every named worker of the role, not any one
 * worker's list — see this module's third rule. Workers of a role consequently
 * share a directory containing each other's bundles; only `--skill` decides
 * what each actually loads, and that is a property of `render.ts`'s per-role
 * mount rather than something this function may change.
 *
 * Idempotent, but only when what is already on disk is COMPLETE for this call.
 * A destination that exists but is missing a requested bundle is re-copied,
 * because "a cached bundle smaller than the one asked for" is exactly the
 * defect the per-role cache used to have.
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
  const targets = skillNames.map((name) => ({
    name,
    from: assertContained(sourceRoot, name, "skill name"),
    to: assertContained(dst, name, "skill name"),
  }));

  const existing = await shapeOf(dst);
  if (existing !== null && existing.isDirectory()) {
    let complete = true;
    for (const t of targets) {
      if ((await shapeOf(t.to)) === null) {
        complete = false;
        break;
      }
    }
    if (complete) return dst;
  }

  await refuseSymlinkDestination(dst);
  await mkdir(dst, { recursive: true });
  // The `<run-dir>/skills` PARENT has to be traversable or the 0755 bundle
  // beneath it is unreachable regardless of its own mode: permission is
  // checked at every path component. `dirname` of the authoritative path
  // rather than a second join, so this cannot name a different directory than
  // the mount does.
  await makeWorkerAccessible(dirname(dst), false);
  await makeWorkerAccessible(dst, false);

  for (const t of targets) {
    if ((await shapeOf(t.from)) === null) {
      // Loud and pathed, like `render.ts`'s missing-briefing-file refusal. The
      // alternative is a bundle that silently shrinks by one skill, which
      // reads at run time as an agent that ignored its instructions.
      throw new ConfigError(
        `role "${role}" configures skill "${t.name}", but no bundle exists at ${t.from} — ` +
          `skill bundles are sourced from <repo>/skills/<name>/ ` +
          `(override the source root with PIFLEET_SKILLS_DIR)`,
      );
    }
    await copySkillTree(t.from, t.to);
  }
  return dst;
}

/** One role's bundle plan: the union of its workers' skill lists. */
interface RoleBundlePlan {
  role: string;
  /** Union across every NAMED worker of this role, sorted so it is order-free. */
  skills: string[];
  /** Which worker first named each skill — the id a refusal has to cite. */
  namedBy: Map<string, string>;
}

/**
 * Resolve the named, configured workers and plan one bundle per role.
 *
 * Membership is an explicit test against `workers:`, exactly as
 * `assertModelsAllowed` does and for the same reason: Phase 1 `--workers`
 * legitimately names ids that exist only as a `PIFLEET_PI_COMMAND` double, and
 * those have no configured mounts to create. A `catch { continue }` around
 * `resolveWorker` would have swallowed unrelated resolution failures with it.
 */
function planRoleBundles(
  loaded: LoadedConfig,
  workerIds: readonly string[],
): { workers: ResolvedWorker[]; plans: Map<string, RoleBundlePlan> } {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  const workers: ResolvedWorker[] = [];
  const plans = new Map<string, RoleBundlePlan>();

  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    const w = resolveWorker(loaded, workerId);
    workers.push(w);
    let plan = plans.get(w.role);
    if (plan === undefined) {
      plan = { role: w.role, skills: [], namedBy: new Map() };
      plans.set(w.role, plan);
    }
    for (const skill of w.skills) {
      if (plan.namedBy.has(skill)) continue;
      plan.namedBy.set(skill, w.id);
      plan.skills.push(skill);
    }
  }
  // Sorted so the bundle's contents, the copy order and any refusal all depend
  // on the config alone — never on the order `--workers` happened to list ids.
  for (const plan of plans.values()) plan.skills.sort();
  return { workers, plans };
}

/**
 * Refuse every missing bundle BEFORE anything is written.
 *
 * Up front rather than inside the copy loop, because a refusal that fires
 * after three roles have been materialized leaves a half-built run dir behind
 * a message about the fourth. Every skill of every named worker is checked,
 * so the refusal cannot be skipped by a cache hit — which is how a nonexistent
 * bundle named only by a later worker of an already-seen role used to sail
 * straight through.
 */
async function assertSkillSourcesExist(
  plans: Map<string, RoleBundlePlan>,
  sourceRoot: string,
): Promise<void> {
  for (const plan of plans.values()) {
    for (const skill of plan.skills) {
      const from = assertContained(sourceRoot, skill, "skill name");
      if ((await shapeOf(from)) !== null) continue;
      throw new ConfigError(
        `worker "${plan.namedBy.get(skill)!}": role "${plan.role}" configures skill ` +
          `"${skill}", but no bundle exists at ${from} — skill bundles are sourced ` +
          `from <repo>/skills/<name>/ (override the source root with PIFLEET_SKILLS_DIR)`,
      );
    }
  }
}

/**
 * Materialize every host path `buildDockerArgv` would bind-mount, for every
 * named worker that config actually defines.
 *
 * `onWorker` is invoked as each worker COMPLETES, not once at the end. A
 * failure part-way through leaves real directories and files on disk for the
 * workers already done, and a caller that only records them after the whole
 * batch returns has no record of any of it — the exact forensic gap on the one
 * path this module exists to make loud.
 *
 * Serial by design. There is no throughput argument for parallelizing a handful
 * of small copies, and serial keeps the ledger `seq` the caller writes per
 * worker in an order that means something.
 */
export async function materializeWorkerInputs(
  loaded: LoadedConfig,
  run: RunPaths,
  workerIds: readonly string[],
  onWorker?: MaterializedWorkerSink,
): Promise<MaterializedWorker[]> {
  const sourceRoot = skillsSourceRoot();
  const { workers, plans } = planRoleBundles(loaded, workerIds);
  // Wrapped so a stat that fails for an ENVIRONMENT reason — an unreadable
  // source root, EACCES on a parent — arrives as exit 3 rather than escaping
  // raw as an undiagnosed internal error.
  await establishing("the skill bundle sources", () =>
    assertSkillSourcesExist(plans, sourceRoot),
  );

  /** One bundle per role, from the planned UNION — complete before first use. */
  const skillsByRole = new Map<string, string>();
  const out: MaterializedWorker[] = [];
  /** The host-default kubeconfig note is about the RUN, so it is said once. */
  let notedHostDefaultKubeconfig = false;

  for (const w of workers) {
    const workerId = w.id;
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
      await refuseSymlinkDestination(paths.dir);
      await mkdir(paths.dir, { recursive: true });
      await mkdir(outboxDir, { recursive: true });
      /**
       * Every directory on the way to a mounted file, not just the leaf.
       *
       * `cloud-allow`, `system-append.md` and the kubeconfig all live under
       * `<run>/workers/<id>/`, and traversal is checked at EVERY component —
       * so under `umask 077` the run root, `workers/` and `workers/<id>/` all
       * land at 0700 and three carefully-chmod'd 0644 files become
       * unreachable to uid 10001. Nothing errors; the mounts just come up
       * unreadable, which is the same silent failure this module exists to
       * prevent, reintroduced by omission. Read-only is enough: nothing writes
       * at these levels, they only have to be walkable.
       */
      await makeWorkerAccessible(run.root, false);
      await makeWorkerAccessible(run.workersDir, false);
      await makeWorkerAccessible(paths.dir, false);
      await makeWorkerAccessible(dirname(outboxDir), false);
      await makeWorkerAccessible(outboxDir, true);
    });

    let skillsDir = skillsByRole.get(w.role);
    if (skillsDir === undefined) {
      const plan = plans.get(w.role)!;
      skillsDir = await establishing(`the skill bundle for role ${w.role}`, async () => {
        try {
          return await materializeRoleSkills(run.root, w.role, plan.skills, sourceRoot);
        } catch (err) {
          // The bundle is per-ROLE so `materializeRoleSkills` cannot name a
          // worker, but the operator's next move is to edit a `workers:` or
          // `roles:` entry — and the id of the worker that first needed this
          // bundle is what points them at the right one.
          if (err instanceof ConfigError) {
            throw new ConfigError(`worker "${workerId}": ${err.message}`);
          }
          throw err;
        }
      });
      skillsByRole.set(w.role, skillsDir);
    }

    /**
     * A ZERO-BYTE REGULAR FILE at 0444, and the shape matters more than the
     * content.
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
     * 0444, not 0644, because verbgate refuses every verb (exit 78) when the
     * policy is writable by the uid consulting it — and on macOS the Docker VM
     * squashes ownership to the container user, so at 0644 the file reads as
     * owner-writable INSIDE the container and only the `:ro` mount flag stands
     * between that check and a fleet-wide refusal. A policy file is the one
     * thing nothing should ever hold write permission on, by any path.
     *
     * WHOEVER WIRES DISPATCH-TIME REWRITING: chmod 0644, write IN PLACE
     * (truncate + write), chmod back to 0444 — never tmp + rename. A bind
     * mount pins the INODE, so a rename swaps the file the host sees while the
     * container keeps reading the old one, for the life of the container, with
     * both sides believing the policy changed.
     */
    await establishing(`the cloud policy for ${workerId}`, async () => {
      await refuseSymlinkDestination(paths.cloudAllow);
      await writeFile(paths.cloudAllow, "");
      await makeWorkerReadable(paths.cloudAllow, false);
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
        await refuseSymlinkDestination(briefing.hostPath);
        await writeFile(briefing.hostPath, briefing.content);
        await makeWorkerReadable(briefing.hostPath, true);
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
        // "The path you named is not a readable file" is the operator's
        // mistake (exit 2); EIO, EMFILE and friends are the environment's
        // (exit 3), and reporting the second as the first sends them to edit
        // a config that is already right.
        const code = (err as NodeJS.ErrnoException).code ?? "";
        const operatorFault = ["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(code);
        const detail = err instanceof Error ? err.message : String(err);
        if (!operatorFault) {
          throw new MaterializeError(`the kubeconfig for ${workerId} from ${src}`, err);
        }
        throw new ConfigError(
          `cloud.kubeconfig for worker "${workerId}" names ${src}, which could not be read: ${detail}`,
        );
      }
      if (src === join(homedir(), ".kube", "config") && !notedHostDefaultKubeconfig) {
        // Once per run: the note is about the CONFIG, and repeating it per
        // worker turns one finding into a wall an operator scrolls past.
        notedHostDefaultKubeconfig = true;
        process.stderr.write(
          `note: cloud.kubeconfig is the host default ${src} — SRD §5.5 expects a ` +
            `filtered copy, and every context in it is reachable from every ` +
            `cloud_access worker\n`,
        );
      }
      await establishing(`the kubeconfig for ${workerId}`, async () => {
        await refuseSymlinkDestination(paths.kubeconfig);
        await writeFile(paths.kubeconfig, bytes);
        await makeWorkerReadable(paths.kubeconfig, true);
      });
      kubeconfig = paths.kubeconfig;
      kubeconfigSource = src;
    }

    const materialized: MaterializedWorker = {
      workerId,
      role: w.role,
      outboxDir,
      skillNames: w.skills,
      skillsDir,
      cloudAllow: paths.cloudAllow,
      systemAppendMd,
      kubeconfig,
      kubeconfigSource,
    };
    out.push(materialized);
    await onWorker?.(materialized);
  }
  return out;
}
