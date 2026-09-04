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
 *    per-worker git worktree, which `run/worktree.ts:createWorkerWorktrees`
 *    creates from `up` before this runs. Not this module's to write.
 *  - `/sessions` — created and opened by `up` itself, before this runs.
 *  - `pifleet-piagent-<id>` — a named volume; Docker owns it by construction.
 *
 * The `--env-file` USED to be on that list, and the reasoning is kept because
 * it explains the shape of what replaced it. The argument was that the
 * asymmetry with `cloud-allow` is the point: an EMPTY allow list is
 * semantically correct (deny-all for mutating verbs, read verbs unaffected —
 * the right run-time default), while an empty env file is semantically WRONG,
 * because a worker would start with no `base_url`, no API key and no
 * `CLOUDSDK_*` and fail obscurely deep inside the container. Leaving the path
 * unwritten made a premature `docker run` fail LOUDLY on a missing
 * `--env-file` instead of quietly on a wrong one — a deliberate tripwire held
 * until a real writer existed.
 *
 * `run/worker-env.ts` is that writer, so the tripwire comes out. What it
 * protected against does not come back: the file is built from
 * `docker/entrypoint.sh`'s stated contract rather than from a guess at what
 * Pi wants, an absent oMLX key OMITS the variable rather than writing it
 * blank (so the entrypoint's `-n` guards see genuinely-unset, not empty), and
 * a missing key is said on stderr instead of silently producing the
 * reaches-no-model worker the old comment describes.
 */

import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { planCredential } from "../security/adc.ts";
// The ONE derivation of "does this worker's context leave the machine". `up.ts`
// prints its banner from the same function; ISC-417 is the assertion that no
// second one exists. See the `disclosure` field below.
import { disclosureFor } from "../security/disclosure.ts";
import { makeWorkerAccessible, makeWorkerReadable } from "../container/mounts.ts";
import {
  EXIT,
  SESSION_ID_RE,
  WorkerLaunchSchema,
  type WorkerLaunch,
} from "../contracts.ts";
import { resolvedWithin } from "../harvest/outbox.ts";
import {
  roleSkillsDir,
  skillsSourceRoot,
  workerOutboxDir,
  workerPaths,
  workerRepliesDir,
  type RunPaths,
  workerContainerName,
} from "./paths.ts";
import { clearDispatchPolicy } from "./dispatch-policy.ts";
import { createRepliesDir } from "./replies.ts";
import { writeTaskPolicy } from "./task-policy.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import {
  SECRETS_MOUNT,
  buildWorkerEnv,
  writeWorkerEnvFile,
  writeWorkerSecretFiles,
} from "./worker-env.ts";

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

/**
 * There is secret material to deliver and no mount to deliver it through.
 *
 * A BUG IN PIFLEET, not a config mistake, and typed that way deliberately: no
 * `fleet.yaml` an operator can write reaches this state. It is reachable only
 * by `config/render.ts` and this module disagreeing about whether the worker's
 * secret store is mounted — the exact divergence D8 removed the predicates to
 * prevent, caught if it is ever re-introduced on one side alone.
 *
 * `EXIT.INTERNAL` for the reason the run-root comparison above uses it: an
 * honest exit code for a defect the operator cannot fix is worth more than a
 * `ConfigError` that sends them looking through their own file for a line that
 * is not wrong.
 *
 * The message names the COUNT of files rather than any name in them. A name
 * here would be `llm.api_key_env` or an operator grant, and neither belongs in
 * a diagnostic that a `report` may quote back; the count is enough to tell a
 * reader which side of the seam moved.
 */
export class SecretStoreNotMountedError extends Error {
  readonly exitCode = EXIT.INTERNAL;
  constructor(
    readonly workerId: string,
    readonly fileCount: number,
    readonly expectedMount: string,
  ) {
    super(
      `worker "${workerId}" has ${fileCount} secret file(s) to deliver but its rendered ` +
        `docker argv carries no ${expectedMount} — the store and its mount have gone out ` +
        `of step, so the worker would start with a well-formed pointer into an empty ` +
        `directory; this is a pifleet bug, not a fleet.yaml mistake`,
    );
    this.name = "SecretStoreNotMountedError";
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
  /**
   * The verbgate's task-provenance file. Rewritten by the SUPERVISOR at each
   * dispatch, not here — materialize only establishes it, at 0444 with no live
   * task, so the mount exists before the first epoch does.
   */
  taskPolicy: string;
  /**
   * The task drop. Rewritten by the staged dispatch route, not here — the same
   * split as `taskPolicy` above and for the same reason: materialize
   * establishes the inode the bind mount pins, and whoever stages a task owns
   * the content.
   */
  dispatchPolicy: string;
  /** null when the worker has no briefing content (render's own predicate). */
  systemAppendMd: string | null;
  /** null when `cloud.kubeconfig` is null or the worker has no cloud access. */
  kubeconfig: string | null;
  /** The config-named file the kubeconfig was copied FROM; null when none was. */
  kubeconfigSource: string | null;
  /** The `--env-file` this worker's container is launched with. */
  envFile: string;
  /** The launch record holding the exact `docker run` argv; null for a double run. */
  launchJson: string | null;
  /** `--name` of the container that argv will create; null for a double run. */
  container: string | null;
  /**
   * The FINISHED `docker run` argv — the same array written to `launch.json`
   * and spawned VERBATIM by the supervisor; null for a double run.
   *
   * Surfaced so `up` can enforce ISC-292 over the argv this run will actually
   * use, rather than over a second rendering of it. Two independent
   * computations of one argv are two things that can disagree after an edit,
   * and a guard that passed on a DIFFERENT argv than the one that launched is
   * worse than no guard: it certifies the wrong bytes. Same reason the image
   * gate in `up` takes its tags from the renderer's output rather than
   * recomputing them.
   */
  launchArgv: readonly string[] | null;
  /** The image that argv runs — an image with a shell, so a probe can use it. */
  image: string | null;
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
  /**
   * The character-class check comes FIRST, and it is the one that matters.
   *
   * `resolvedWithin` answers "did this escape", and for `.` — or `""` — the
   * honest answer is no: the resolved path IS the root, and the containment
   * check returns true. So `materializeRoleSkills(root, role, ["."], src)`
   * copied the entire skills source into the bundle while the safety net
   * reported everything fine. Applying the grammar the schema applies makes
   * the net catch what its docstring claims: a name that is not a single,
   * ordinary path segment is refused before it is ever joined.
   */
  if (!SESSION_ID_RE.test(name) || name.length > 64) {
    throw new ConfigError(
      `${what} "${name}" is not a path segment — it must be 1-64 characters of ` +
        `letters, digits, ".", "_" or "-", beginning and ending alphanumeric`,
    );
  }
  if (!resolvedWithin(root, path) || path === root) {
    throw new ConfigError(
      `${what} "${name}" escapes ${root} — a skill name is a mount path segment, ` +
        `not a path`,
    );
  }
  return path;
}

/**
 * Refuse a DISCOVERED filename that is not a single, safe path segment.
 *
 * Deliberately NOT `assertContained`, and the difference is a regression that
 * one fixed. `assertContained` applies `SESSION_ID_RE` — the grammar for an
 * identifier an operator TYPES into config, where "a name that cannot be
 * spelled cannot escape" is the whole control. A file inside a skill bundle is
 * not that. Nobody named it in a config; it is whatever the bundle's author (or
 * the operating system) put on disk, and the copy has no say in it. Holding
 * those to the config grammar made `copySkillTree` refuse `.DS_Store` — which
 * macOS, this project's own development platform, writes into any directory
 * Finder opens — and with it `.gitignore` and every name containing a space,
 * parens, `@`, `~` or a non-ASCII character. None of those is dangerous to
 * copy, and each arrived as `ConfigError: skill bundle entry "…" is not a path
 * segment`: a config diagnosis, pointing at a file the operator never wrote
 * anywhere, for a bundle that is perfectly fine.
 *
 * What actually matters at that call site is narrower and purely structural —
 * that the name cannot make `join` mean anything other than "one entry inside
 * this directory". So: no empty string, no `.` or `..`, no separator, no NUL.
 * `readdir` yields none of those, but that is an assumption about another API
 * rather than a property of the loop, which is why the loop checked at all.
 * `resolvedWithin` then confirms the same conclusion by a second, independent
 * route, exactly as `assertContained` does.
 *
 * Exported for direct test: no real `readdir` can produce a name that reaches
 * any of these branches.
 */
export function assertEntryContained(root: string, name: string): string {
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new ConfigError(
      `skill bundle entry ${JSON.stringify(name)} is not a single path segment — ` +
        `a bundle entry must be one ordinary directory entry, not "", ".", ".." or a path`,
    );
  }
  const path = join(root, name);
  if (!resolvedWithin(root, path) || path === root) {
    throw new ConfigError(
      `skill bundle entry ${JSON.stringify(name)} escapes ${root} — a bundle is copied ` +
        `entry by entry into its own directory, never through one`,
    );
  }
  return path;
}

/**
 * Recursive, symlink-refusing, `.git`-refusing, bounded, mode-setting copy of
 * one skill bundle.
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
    // API rather than a property of this loop. Checked for the TRAVERSAL
    // properties only — a bundle author's filename is not a config identifier,
    // and holding it to `assertContained`'s grammar refused `.DS_Store`.
    const from = assertEntryContained(src, name);
    const to = assertEntryContained(dst, name);
    /**
     * A `.git` is REFUSED, and this is the one name that is.
     *
     * Relaxing the per-entry check to admit ordinary dotfiles (`.DS_Store`,
     * `.gitignore` — the whole point of that fix) also stopped refusing dotted
     * DIRECTORIES, and `.git` is one. A skill source root that is a real
     * checkout — plausible under a `PIFLEET_SKILLS_DIR` override with a
     * skill-per-repo layout, though not the default `<repo>/skills/<name>/`
     * one — would then copy its entire git database into the directory mounted
     * `:ro` at `/skills` and read as INSTRUCTION, `.git/config` included, and
     * a remote URL there routinely carries an embedded token.
     *
     * That is the hazard this function's own docstring cites for refusing
     * symlinks, reached by a different route: content nobody reviewed as a
     * skill, laundered into the agent's prompt (SRD §5.4). Refused by exact
     * name, as a directory or a file — `.git` is legitimately either, per git's
     * own worktree design. Deliberately NOT a broader junk list: `.gitignore`
     * and `.gitattributes` are ordinary files and still copy.
     */
    if (name === ".git") {
      throw new ConfigError(
        `git checkout in skill bundle: ${from} — a bundle is mounted as instruction, and a ` +
          `.git directory is content nobody reviewed as a skill (its config can carry a ` +
          `credential in a remote URL), so it is refused rather than copied (SRD §5.4)`,
      );
    }
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
 * worker's list — see this module's third rule.
 *
 * KNOWN, DELIBERATE PROPERTY, stated so a later reader does not read it as an
 * oversight: when two workers of one role override `skills:` differently, each
 * one's `/skills:ro` mount CONTAINS the other's bundles. Nothing extra is
 * loaded — `render.ts` still emits `--skill` from each worker's own resolved
 * names — but the readable surface is a superset of what either asked for.
 * That is inherent in "one mount per role" (`render.ts:183`), and narrowing it
 * means either a per-worker mount or a schema rule forcing role-uniform
 * skills. Both are design calls above this function; neither is something to
 * decide by quietly changing what gets copied.
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
  /**
   * The ROLE is checked here too, not only the skill names below.
   *
   * DEFENCE IN DEPTH for this exported function's DIRECT-CALL surface — not the
   * thing standing between `pifleet up` and a traversal, and it should not be
   * read as one. `FleetConfigSchema` applies `SESSION_ID_RE` to every KEY of
   * `roles:`, so a role an operator can DECLARE cannot spell a separator, `.`
   * or `..`.
   *
   * That is the accurate mechanism, and it is narrower than "the role is fully
   * validated before it reaches here" — which is false, so it is not claimed.
   * A worker's `role` FIELD carries no grammar of its own
   * (`WorkerEntrySchema.role` is a bare `shortStr`), and both membership tests
   * it faces walk the PROTOTYPE CHAIN: `schema.ts`'s `w.role in cfg.roles` and
   * `resolveWorker`'s `config.roles[entry.role]`. So the names on
   * `Object.prototype` — `constructor`, `toString`, `valueOf`,
   * `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
   * `toLocaleString` — pass both as though they were declared roles and arrive
   * here as `role`; confirmed by running all seven through `parseConfig` and
   * `resolveWorker`. That is a real defect (the worker silently inherits
   * `defaults` instead of being refused as unknown), but it belongs to
   * `schema.ts`/`load.ts` and is left to a follow-up rather than patched from
   * here.
   *
   * It is also not a traversal, which is why the conclusion above survives it:
   * no key of `Object.prototype` contains `/` or `\`, and none spells `.` or
   * `..`, so nothing reaching here through that gap can escape a join. The
   * check below still earns its line for the reason `assertContained`'s own
   * docstring gives — a future caller reaching this function without schema
   * validation must still be safe — and because every skill NAME here was
   * already held to that standard while the role, joined into the same host
   * path and then mkdir'd and chmod'd through, was trusted outright.
   *
   * The containment root is `join(runRoot, "skills")` rather than
   * `dirname(roleSkillsDir(runRoot, role))` on PRINCIPLE, not on a
   * demonstrated exploit: a trust boundary must never be derived from the
   * value it is validating, because the boundary then moves with whatever it
   * is asked to judge. The derived form is not in fact exploitable today —
   * `assertContained` runs its character-class check first and that check is
   * root-independent, so every traversing role is refused before the root
   * matters at all. But that makes this call's soundness a consequence of the
   * order of two checks inside another function, which is not a property worth
   * depending on.
   */
  assertContained(join(runRoot, "skills"), role, "role name");
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

  // `<run>/skills` is guarded but NOT chmod'd: `mkdir -p` through a symlinked
  // parent would build the bundle inside the link's target, while the parent's
  // own MODE is irrelevant to the container — only `dst` is mounted, and a
  // bind mount is reached at its mountpoint rather than by walking the host
  // chain. See the outbox block in `materializeWorkerInputs` for the whole
  // argument.
  await refuseSymlinkDestination(dirname(dst));
  await refuseSymlinkDestination(dst);
  await mkdir(dst, { recursive: true });
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
  opts: {
    /**
     * Whether to write the launch record — i.e. whether this run intends to
     * start CONTAINERS.
     *
     * A parameter rather than something inferred here, because the decision
     * belongs to `up` and must be made ONCE. The supervisor's rule is simply
     * "a launch record means launch it", so if this module wrote a record
     * whenever a config existed, then a run driven by the
     * `PIFLEET_PI_COMMAND` double would carry a record naming a container
     * nobody meant to start — and the supervisor, correctly following its own
     * rule, would start it. Deciding in one place keeps the run directory
     * honest: no record means no container was ever intended, which is also
     * what stops `down` reaping a name that never existed.
     */
    writeLaunchRecord?: boolean;
    /**
     * Host git working directory exposed read-only for workers to clone from.
     * Threaded straight to `renderWorker`; see `RenderOptions.cloneSource`.
     */
    cloneSource?: string | null;
  } = {},
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
    const rendered = await renderWorker(loaded, workerId, {
      runId: run.runId,
      cloneSource: opts.cloneSource ?? null,
    });
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
      /**
       * ONLY the mounted inodes get their modes set — never the host
       * directories above them.
       *
       * This module briefly chmod'd `<run>/`, `<run>/workers/` and
       * `<run>/workers/<id>/` on the theory that a container traverses the
       * host's directory chain to reach a mounted file, so a 0700 ancestor
       * under `umask 077` would make a 0644 mount unreadable. It does not. A
       * bind mount is established by the privileged runtime, and the
       * containerized process then reaches the path at its MOUNTPOINT inside
       * its own mount namespace — it never walks the host chain and never sees
       * the host path at all. Only the mounted inode's own mode governs what it
       * can do. Verified against a real Linux container: direct host-path
       * access as uid 10001 is correctly denied through a 0700 ancestor, while
       * the same file through a `-v` reads back fine regardless.
       *
       * So those chmods fixed nothing and cost something real — under a
       * hardened umask they widened directories that were correctly 0700, for
       * no container-side benefit. They were also incomplete on their own
       * terms: `~/.pifleet/runs` and `~/.pifleet` sit two levels further up and
       * were never touched. Removed rather than tightened.
       *
       * The symlink guards stay, and are not moot: `mkdir -p` through a
       * symlinked `<run>/outbox` would create the worker's outbox inside the
       * link's target and chmod THAT to 0777, and a symlinked
       * `<run>/workers/<id>` would take every file written below with it.
       */
      await refuseSymlinkDestination(paths.dir);
      await mkdir(paths.dir, { recursive: true });
      await refuseSymlinkDestination(dirname(outboxDir));
      await refuseSymlinkDestination(outboxDir);
      await mkdir(outboxDir, { recursive: true });
      await makeWorkerAccessible(outboxDir, true);
    });

    /**
     * The REPLY PLANE's host directory, established empty so the bind mount has
     * something to pin from launch (SRD-REVIEW-CONSOLE §6.4, D6).
     *
     * The other direction of the exchange the block above sets up, and it is
     * created in its own `establishing` step rather than folded into that one
     * because the two differ in the property that matters: the outbox is widened
     * for WRITING and this is not. A copy-paste that carried `true` down here
     * would hand the worker write permission on the evidence it is graded
     * against, and — through the verbgate's integrity loop, which checks the
     * containing directory as well as the file — would then refuse every verb
     * the worker attempts. Loud, but nowhere near its cause.
     *
     * Established for EVERY worker, not only for a collator, for the reason the
     * task drop above is: `config/render.ts` emits the `-v` unconditionally, and
     * a mount whose source this module skipped would have Docker create the
     * directory itself — the divergence ISC-188 keeps closing, and the one the
     * `/secrets` gate was removed to stop reintroducing. Docker's version would
     * also be created with the daemon's own ownership rather than through
     * `makeWorkerAccessible`, so the mode this whole surface depends on would be
     * whatever the runtime felt like.
     *
     * The symlink guards are the same pair the outbox gets and for the same
     * reason: `mkdir -p` through a symlinked `<run>/replies` would build the
     * directory inside the link's target and chmod THAT.
     */
    const repliesDir = workerRepliesDir(run.root, workerId);
    await establishing(`the reply directory for ${workerId}`, async () => {
      await refuseSymlinkDestination(dirname(repliesDir));
      await refuseSymlinkDestination(repliesDir);
      await createRepliesDir(repliesDir);
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
     * NOBODY IS WIRING DISPATCH-TIME REWRITING: task-scoped cloud
     * authorization was DESCOPED on 2026-08-30 (ISC-366). This write is the
     * only one, the policy is empty for the life of the run, and every
     * mutating verb is refused with exit 77. `cloud_allow[]` is refused at
     * parse time rather than silently ignored (`src/contracts.ts`), so no
     * operator can set a grant this file will not honour.
     *
     * The recipe this note used to address a future writer with — chmod 0644,
     * write IN PLACE (truncate + write), chmod back to 0444, never tmp+rename,
     * because a bind mount pins the INODE and a rename swaps the file the host
     * sees while the container keeps reading the old one for its whole life
     * with both sides believing the policy changed — was correct, and is now
     * implemented in `src/run/task-policy.ts` for the verbgate's task
     * provenance (ISC-362). It is kept here because the hazard belongs to the
     * `/policy` mount rather than to either file, and the next person to add a
     * rewritable policy file needs it.
     */
    await establishing(`the cloud policy for ${workerId}`, async () => {
      await refuseSymlinkDestination(paths.cloudAllow);
      /**
       * chmod-write-chmod, exactly as the note above prescribes for the future
       * rewriter — because "this runs at most once per worker per run" was an
       * invariant nothing enforced. `up.ts` never deduped `--workers`, so
       * `--workers eng-1,eng-1` reached here twice, and the second
       * `writeFile` hit the 0444 the first pass had just set. On POSIX the
       * OWNER of a 0444 file cannot open it for writing either — only
       * CAP_DAC_OVERRIDE bypasses the mode — so a duplicate id aborted the
       * whole launch with an exit-3 environment diagnosis for what is a typo.
       * `up.ts` dedupes now as well; this end is fixed too because idempotence
       * is a property this module already claims everywhere else.
       */
      if ((await shapeOf(paths.cloudAllow)) !== null) {
        await makeWorkerReadable(paths.cloudAllow, true);
      }
      await writeFile(paths.cloudAllow, "");
      await makeWorkerReadable(paths.cloudAllow, false);
    });

    /**
     * The verbgate's task-provenance file, established with no live task so the
     * bind mount has an inode from launch. The supervisor rewrites it IN PLACE
     * at each dispatch (`src/run/task-policy.ts`); this is the call that
     * CREATES the inode that mount pins, which is why it lives here and not in
     * the supervisor. A file a container bind-mounts must exist before
     * `docker run`, or Docker creates a DIRECTORY at the host path instead and
     * the gate reads a provenance file that can never have content.
     */
    await establishing(`the task provenance for ${workerId}`, async () => {
      await refuseSymlinkDestination(paths.taskPolicy);
      await writeTaskPolicy(paths.taskPolicy, null, 0);
    });

    /**
     * The TASK DROP, established the same way and for the same reason
     * (SRD-TUI-DISPATCH §6.2): the staged brief a worker on an adopted terminal
     * reads instead of being typed at, written here with nothing staged so the
     * bind mount has an inode from launch.
     *
     * It is established for EVERY worker and not only for the `tui` ones that
     * can use it. The `-v` in `config/render.ts` is unconditional, and a mount
     * whose source this module skipped would have Docker create a directory at
     * the path instead — the divergence ISC-188 keeps closing, and the one the
     * `/secrets` gate was removed to stop reintroducing. A worker that never
     * stages reads a drop that says nothing is staged, which is a true
     * statement and costs one inode.
     */
    await establishing(`the task drop for ${workerId}`, async () => {
      await refuseSymlinkDestination(paths.dispatchPolicy);
      await clearDispatchPolicy(paths.dispatchPolicy);
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

    /**
     * The `--env-file`, and the launch record that makes `rendered.docker`
     * something other than a preview.
     *
     * Both are written HERE, in the loop that already holds `rendered`, and
     * that placement is the point. `renderWorker` is called once per worker on
     * the `up` path and this is that call; a supervisor that re-rendered from
     * config to get its argv would be a SECOND derivation of the same value,
     * which is the ISC-188 shape with a wider blast radius — a detached
     * supervisor does not share the cwd or environment that config resolution
     * depends on, so its "same" render could differ with nothing looking wrong.
     * Writing the argv the moment it is produced makes launch-equals-preview a
     * property of there being one object, not of two computations agreeing.
     */
    const envPlan = buildWorkerEnv(loaded, w, process.env);

    /**
     * The secret store, written BEFORE the env file that points at it.
     *
     * The order is the point rather than an accident of where the code sits.
     * The env file carries `<NAME>_FILE=/secrets/<NAME>` and nothing else about
     * the credential, so an env file that exists while its files do not is a
     * worker that starts, reads a perfectly well-formed pointer, and gets
     * ENOENT inside its first authenticated call — §5.9's quiet-failure shape
     * with an extra layer of plausibility on top. Writing the values first
     * means the pointer never exists before the thing it points at.
     *
     * UNGATED UNDER D8, and the gate that used to stand here is gone from BOTH
     * sides rather than widened on this one.
     *
     * It read `if (w.secrets.length > 0)` — the IDENTICAL predicate `render.ts`
     * spelled out a second time to decide whether to emit the `-v`. Two
     * conditions that merely agree today would eventually not, and the failure
     * is silent in the usual direction: Docker creates a missing bind-mount
     * source rather than refusing, so a mount without a directory yields an
     * empty `/secrets` and a worker that cannot explain itself.
     *
     * D8 turned that from a latent divergence into the common case. The Class 1
     * provider key is delivered as a file in this store and NO worker requests
     * it, so `w.secrets` is empty for most workers that now hold one. `render.ts`
     * therefore emits the mount unconditionally and this writes the directory
     * unconditionally, which is not two predicates agreeing — it is no
     * predicate at all, and nothing that does not exist can drift.
     *
     * The guard below is the part that survives a future edit to either side.
     */
    {
      await establishing(`the secret files for ${workerId}`, async () => {
        await refuseSymlinkDestination(paths.secretsDir);
        for (const secret of envPlan.secretNames) {
          await refuseSymlinkDestination(join(paths.secretsDir, secret));
        }
        /*
         * TIGHTENING the worker directory to 0700, and the direction is what
         * makes it safe.
         *
         * The secret files themselves must be 0444 — a Linux bind mount passes
         * host ownership through and the worker runs as a baked uid, so an
         * owner-only mode is unreadable exactly where the macOS squash is not
         * there to hide it (see `SECRET_FILE_MODE`). World-readable bytes under
         * a world-traversable run directory is a real host-side regression
         * against the 0600 env file this replaces, so the protection moves up
         * one level: at 0700 no other user on the host can traverse into
         * `<run>/workers/<id>` at all.
         *
         * It costs the container NOTHING, and that is measured rather than
         * assumed — the note on the outbox block above records it: a bind mount
         * is established by the privileged runtime and the containerized
         * process reaches the path at its MOUNTPOINT inside its own namespace.
         * It never walks the host chain. The same block records that an
         * operator running under `umask 077` has had this directory at 0700 all
         * along, with every mount under it working, which is direct evidence
         * for this line rather than an argument for it.
         *
         * That earlier block removed chmods which WIDENED ancestors for no
         * container-side benefit. This is the opposite operation on the same
         * insight, and it has a benefit those did not: it is the only thing
         * standing between a 0444 credential file and every account on the box.
         */
        await chmod(paths.dir, 0o700);
        await writeWorkerSecretFiles(paths.secretsDir, envPlan);
        await makeWorkerAccessible(paths.secretsDir, false);
      });
    }

    /*
     * THE SEAM, RE-CHECKED AT THE ARGV BOUNDARY — and this is the control that
     * outlives any future edit to the two blocks above.
     *
     * Deleting a predicate makes divergence impossible TODAY. It does not stop
     * someone re-introducing one on a single side tomorrow, and the whole
     * lesson of this file's header is that a mount and its source going out of
     * step does not fail — it succeeds wrongly. So the invariant is asserted
     * rather than assumed, and it is asserted against the ARGV THAT WILL
     * ACTUALLY BE RUN rather than against a re-derived copy of `render.ts`'s
     * reasoning. That is this module's Rule 1 — "derived from `renderWorker`,
     * never re-derived" — applied to the one mount that carries a credential.
     *
     * The DANGEROUS DIRECTION is the one checked: material to deliver, with no
     * mount to deliver it through. A worker in that state starts, reads a
     * well-formed `PIFLEET_LLM_API_KEY_FILE` or `<NAME>_FILE`, and fails inside
     * its first authenticated call, nowhere near the cause. The reverse — a
     * mount whose store holds nothing — is harmless and stays legal, because
     * the directory is now written for every worker and a keyless fleet with no
     * grants is a supported setup rather than a defect.
     *
     * It runs BEFORE the env file is written, so a fleet that trips it has no
     * pointer on disk at all. That is the same ordering argument the block
     * above makes, extended one step: the pointer never exists before either
     * the file it names OR the mount that carries it.
     */
    if (envPlan.secretFiles.length > 0) {
      const mount = `${paths.secretsDir}:${SECRETS_MOUNT}:ro`;
      if (!rendered.docker.includes(mount)) {
        throw new SecretStoreNotMountedError(workerId, envPlan.secretFiles.length, mount);
      }
    }

    await establishing(`the env file for ${workerId}`, async () => {
      await refuseSymlinkDestination(paths.envFile);
      await writeWorkerEnvFile(paths.envFile, envPlan);
      // Deliberately NOT `makeWorkerReadable`: `--env-file` is parsed by the
      // docker client on the host and never mounted, so the container never
      // opens it. See `run/worker-env.ts` on why 0600 costs nothing here.
    });
    if (envPlan.missingApiKey) {
      /*
       * A note, not a refusal. A keyless oMLX is a legitimate local setup and
       * `doctor` already owns the "can this fleet reach a model" question with
       * a live probe; failing `up` here would refuse a run that works. Said
       * on stderr because the alternative — silence — reproduces the
       * entrypoint's own worst case, a worker that streams happily and reaches
       * no model, with nothing on the host having mentioned it.
       */
      process.stderr.write(
        `pifleet: ${envPlan.apiKeyEnvName} is not set in this environment, so ${workerId}'s ` +
          `secret store carries no provider key and its env file carries no pointer to one; ` +
          `the worker will only reach a server that needs none\n`,
      );
    }
    if (envPlan.secretNames.length > 0) {
      /*
       * A grant is worth a line. `secrets:` moves values out of the operator's
       * shell and into a container that runs model output, and the whole point
       * of the intersection is that the act is deliberate — so it is stated
       * where the operator is already reading, rather than being inferable
       * only from a 0600 file they would have to go and open.
       *
       * `envPlan.secretNames` and NOT `envPlan.vars` or `envPlan.secretFiles`:
       * the plan carries names and values in separate fields precisely so that
       * a reporting line like this one cannot reach a value. There is no
       * formatting discipline to get wrong here, because the field being
       * interpolated does not contain the secret.
       */
      process.stderr.write(
        `pifleet: ${workerId} is granted host secrets by name: ` +
          `${envPlan.secretNames.join(", ")} (values are written to 0444 files under ` +
          `${paths.secretsDir}, mounted read-only at ${SECRETS_MOUNT}; the worker's ` +
          `environment carries only the paths)\n`,
      );
    }

    /**
     * The credential decision travels WITH the argv, for the reason stated
     * above it: `up` resolves config in a cwd and environment the detached
     * supervisor does not share, so a supervisor that re-derived this could
     * disagree with the container that was actually launched, and nothing
     * would look wrong. `planCredential` is the single function allowed to
     * decide, and this records its output rather than its inputs.
     *
     * ISC-248 is what makes this load-bearing rather than tidy: the
     * supervisor now STARTS a `TokenRefresher` from this field, so a wrong
     * value here is a worker minting the wrong identity — not merely a
     * mislabelled report line.
     */
    const credPlan = planCredential({
      cloudAccess: w.cloudAccess,
      adcMode: loaded.config.cloud.adc_mode,
      impersonateServiceAccount: loaded.config.cloud.impersonate_service_account,
      quotaProject: loaded.config.cloud.quota_project,
    });
    const launch: WorkerLaunch = {
      kind: "container",
      argv: rendered.docker,
      container: workerContainerName(run.runId, workerId),
      image: rendered.image,
      credential:
        credPlan.kind === "none"
          ? null
          : {
              mode: credPlan.mode,
              impersonate_service_account: credPlan.impersonateServiceAccount,
              quota_project: credPlan.quotaProject,
              refresh_s: loaded.config.cloud.token_refresh,
            },
      /*
       * The grant travels with the argv for the same reason the credential
       * plan does, and closes ISC-333's missing half: the harvest needs to
       * know WHICH variables this worker was handed before it can sweep the
       * worker's own output for their values, and `up` is the only place that
       * knows. Re-deriving it at harvest would mean resolving `fleet.yaml`
       * from the harvester's cwd, which `harvest/patterns.ts` forbids for
       * exactly the reason it would be wrong here too: a run outlives the
       * config that produced it.
       *
       * `envPlan.secretNames` and NOT `envPlan.vars`, the same discipline the
       * stderr line above keeps. The field being copied cannot contain a
       * value, so there is no redaction to remember.
       */
      secret_names: envPlan.secretNames,
      /*
       * Written HERE, beside the grant it qualifies, for the reason the field's
       * own docblock gives: the harvester reads a run directory, not a config.
       * A declaration left in `fleet.yaml` would be unreadable at harvest time
       * and would silently re-widen or re-narrow an old run's sweep.
       */
      non_credential_secrets: envPlan.nonCredentialSecretNames,
      /*
       * The Class 1 key's NAME, so the harvest sweep can reach a credential the
       * grant list deliberately does not claim (SRD D15, ISC-421).
       *
       * A PLAIN READ, and this is the fifth field on this record placed here by
       * the same argument — `credential` records `planCredential`'s output,
       * `secret_names` records `WorkerEnvPlan.secretNames`, `pane_mode` records
       * `resolveWorker`'s, `disclosure` records `disclosureFor`'s. `up` resolves
       * config in a cwd and environment the harvester does not share, and the
       * decision this carries folds the provider's `hosted` flag with whether
       * the key was actually in the host environment. Re-deriving either half at
       * harvest time would mean resolving `fleet.yaml` from the harvester's cwd,
       * which `harvest/patterns.ts` forbids for the reason that applies here
       * unchanged: a run outlives the config that produced it.
       *
       * `envPlan.providerKeyName` and not `envPlan.apiKeyEnvName`. The latter is
       * always populated — it is the diagnostic name for the `missingApiKey`
       * message — so copying it would record a key for every keyless and every
       * self-hosted run, and the harvester would report an unresolvable
       * credential on all of them.
       */
      provider_key_name: envPlan.providerKeyName,
      /*
       * The pane mode travels with the argv for the third time on this record,
       * and for the third instance of one reason: `up` resolved it in a cwd and
       * environment the detached supervisor does not share.
       *
       * `w.paneMode` is `resolveWorker`'s output — the same value `render.ts`
       * read one call earlier to decide whether the argv carries `-t`. Taking
       * it from the same struct in the same scope is what makes the two
       * agree: a supervisor that launches detached while the argv lacks `-t`
       * gets a container with no pseudo-TTY and no Pi TUI in it, and a
       * supervisor that launches in the foreground while the argv HAS `-t`
       * gets `the input device is not a TTY` and no container at all. Neither
       * failure names `pane_mode`.
       */
      pane_mode: w.paneMode,
      /*
       * The SAME predicate `render.ts` mounts the dispatch-trigger extension
       * on, written down so a reader does not have to re-derive it from an
       * argv (`WorkerLaunchSchema.auto_trigger`).
       *
       * It is the conjunction and not `w.autoTrigger` alone because
       * `autoTrigger` defaults TRUE on every worker (`config/load.ts`) while
       * the extension is mounted for `tui` workers only — an rpc worker is
       * dispatched down the control socket and has no staged brief to trigger.
       * Recording the raw field would tell `wait` that an rpc worker's stage
       * is on its way when nothing was armed to bring it.
       */
      auto_trigger: w.paneMode === "tui" && w.autoTrigger,
      /*
       * The disclosure row, recorded so a harvested run can be ASKED whether
       * this worker's context crossed to a vendor (SRD §7.3, ISC-416).
       *
       * ## This is a SPELLING MAP and it must stay one
       *
       * `disclosureFor` is the one function that decides whether a worker's
       * context leaves the machine, and `up.ts` prints its banner from the same
       * call. ISC-417 asserts the banner and this record name the same set of
       * workers — so every value below is a plain read from the row, and any
       * expression on a right-hand side here would be a SECOND derivation of a
       * fact the banner derived once. The two would agree until the first edit
       * that touched only one, and then disagree silently, in the direction
       * where the operator is told nothing about a worker already talking to a
       * vendor. That is the failure this criterion exists to make impossible,
       * and it is reachable from here and nowhere else.
       *
       * ## `null` is an ANSWER, not a skip
       *
       * `disclosureFor` returns `null` for a worker whose provider is not
       * `hosted: true` — every local provider, and every flat pre-D7 fleet,
       * whose §6.1 shorthand has no `hosted` field to be true. Writing that
       * `null` is what makes the record's silence a recorded decision rather
       * than a field somebody forgot: a harvest reading `null` knows the
       * question was asked and answered.
       *
       * ## Why `w` and not a re-resolution
       *
       * `w` is `resolveWorker`'s output, the same struct `render.ts` and
       * `buildWorkerEnv` read in this scope — the identical discipline
       * `pane_mode` above keeps. `up.ts` calls `disclosureFor` with the worker
       * it resolved from the same loaded config, so the two calls differ in
       * nothing.
       */
      disclosure: ((row) =>
        row === null
          ? null
          : {
              worker_id: row.workerId,
              role: row.role,
              provider: row.provider,
              isolation: row.isolation,
              repo: row.repo,
              cloud_access: row.cloudAccess,
              secret_names: row.secretNames,
            })(disclosureFor(loaded, w)),
    };
    if (opts.writeLaunchRecord === true) {
      await establishing(`the launch record for ${workerId}`, async () => {
        await refuseSymlinkDestination(paths.launchJson);
        await writeJsonAtomic(paths.launchJson, WorkerLaunchSchema.parse(launch));
      });
    }

    const materialized: MaterializedWorker = {
      workerId,
      role: w.role,
      outboxDir,
      skillNames: w.skills,
      skillsDir,
      cloudAllow: paths.cloudAllow,
      taskPolicy: paths.taskPolicy,
      dispatchPolicy: paths.dispatchPolicy,
      systemAppendMd,
      kubeconfig,
      kubeconfigSource,
      envFile: paths.envFile,
      launchJson: opts.writeLaunchRecord === true ? paths.launchJson : null,
      container: opts.writeLaunchRecord === true ? launch.container : null,
      // Gated on the SAME condition as the two above, because they answer one
      // question: is a container intended at all. On the double path there is
      // no `docker run` argv to guard and no image to guard it in.
      launchArgv: opts.writeLaunchRecord === true ? launch.argv : null,
      image: opts.writeLaunchRecord === true ? launch.image : null,
    };
    out.push(materialized);
    // Wrapped like every other fallible step here. The sink is a ledger
    // append, so its failure mode is a full disk or an unwritable run dir —
    // an environment fault, and it deserves the same exit-3 diagnosis rather
    // than escaping raw as an undiagnosed internal error.
    if (onWorker !== undefined) {
      await establishing(`the record of ${workerId}'s inputs`, () => onWorker(materialized));
    }
  }
  return out;
}
