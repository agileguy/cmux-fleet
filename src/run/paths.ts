/**
 * Every run-directory path is computed here and nowhere else.
 *
 * The run dir is the durable record of a run: state files, ledgers, envelopes,
 * transcripts. Two rules shape this module:
 *
 * 1. **One source of truth.** A path computed in two places will eventually be
 *    computed differently in two places, and the supervisor and CLI would then
 *    read different files while believing they share state.
 *
 * 2. **Control sockets do not live in the run dir.** `sun_path` is capped at
 *    ~104 bytes on macOS. The runs root is configurable (`PIFLEET_RUNS_DIR`)
 *    and test scratch directories routinely exceed 100 characters on their
 *    own, so a socket at `<run-dir>/workers/<id>/control.sock` would fail to
 *    bind in exactly the environment the acceptance suite runs in. Sockets are
 *    therefore placed under `os.tmpdir()` with a hashed name that both the
 *    supervisor and the CLI can derive from `(run_id, worker)`.
 */

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Root under which every run directory lives.
 *
 * The configured value is CANONICALIZED, never returned as authored.
 * `PIFLEET_RUNS_DIR` is operator input and every path below is derived from
 * it, ending up as the source half of `docker run -v` flags — and Docker does
 * not reject a relative source there. A `-v` source with no leading `/` is a
 * NAMED VOLUME, so an unresolved root gets the worker a fresh empty volume
 * where the run directory should be: `harvest` then reads an empty `/outbox`
 * and reports a task that produced artifacts as having produced none. Nothing
 * throws, which puts it in the same class as the divergence this module's
 * first rule exists to prevent.
 *
 * A leading `~` is expanded for the same reason and one more: nothing but a
 * shell expands it, so `~/runs` works when typed at a prompt and fails when
 * set from a launcher, a config file, or the detached daemon's env — which
 * are the three ways this variable is actually set. Expansion follows
 * `expandPath` in `config/load.ts`, the convention every other path in this
 * codebase already uses; a relative value resolves against the cwd, because
 * unlike a config path there is no document for it to be relative TO.
 *
 * Resolving HERE rather than at the call sites is what makes it hold: `up`
 * hands this exact string to the detached daemon as its `PIFLEET_RUNS_DIR`
 * and to each supervisor as `--runs-root`, and a relative value would
 * otherwise re-resolve against whatever cwd those inherit — a second answer
 * to the question this module exists to make singular.
 */
export function runsRoot(env: Record<string, string | undefined> = process.env): string {
  return rootFromEnv(env["PIFLEET_RUNS_DIR"], () => join(homedir(), ".pifleet", "runs"));
}

/**
 * Where per-role skill bundles are COPIED FROM (SRD §5.4).
 *
 * There is no config field for this and there should not be: a skill name in
 * `skills:` is a bundle NAME, and `--skill /skills/<name>` hard-codes the
 * container half, so the host half must be equally fixed. Resolved from this
 * module's own location so it survives being run from any cwd, exactly as
 * `up.ts`'s `CLI_ENTRY` does with `import.meta.dir` — `src/run/` is two levels
 * below the repo root, where `skills/` lives beside `src/`.
 *
 * `PIFLEET_SKILLS_DIR` overrides it — the packaging and test seam, the same
 * shape as `PIFLEET_RUNS_DIR` and `PIFLEET_SCRATCH_DIR`, and the only way a
 * test can plant a hostile bundle (a symlink, a missing name) without writing
 * into the repository's real `skills/`.
 */
export function skillsSourceRoot(env: Record<string, string | undefined> = process.env): string {
  return rootFromEnv(env["PIFLEET_SKILLS_DIR"], () =>
    resolve(import.meta.dir, "..", "..", "skills"),
  );
}

/**
 * The expansion every root-valued environment variable in this module gets.
 *
 * Factored out rather than copied because a second spelling of these four
 * lines is a second answer to what `~/x` and `./x` mean here, which is the
 * divergence this module's first rule exists to prevent. `fallback` is lazy so
 * each caller keeps its own default without computing it on the override path.
 */
function rootFromEnv(configured: string | undefined, fallback: () => string): string {
  // An exported-but-cleared variable arrives as "", which `??` passed
  // through; `join("", runId)` is then relative, i.e. the named-volume case
  // with nothing in the path to suggest a variable was ever set.
  if (configured === undefined || configured === "") return fallback();
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

/**
 * Run ids sort lexically because they begin with a UTC timestamp; `latestRunId`
 * depends on that property, so the format is fixed here.
 */
export function newRunId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const suffix = createHash("sha256")
    .update(`${now.getTime()}-${process.pid}-${Math.random()}`)
    .digest("hex")
    .slice(0, 4);
  return `${ts}-${suffix}`;
}

export interface RunPaths {
  runId: string;
  root: string;
  runJson: string;
  registryJson: string;
  /** Per-run control-socket secret (SRD §12.7), mode 0600. Never mounted. */
  controlAuthJson: string;
  daemonPid: string;
  daemonLog: string;
  daemonSock: string;
  ledgerDir: string;
  inboxDir: string;
  sessionsDir: string;
  workersDir: string;
  /**
   * The scheduler's snapshot of the task graph (`ScheduledTask[]`).
   *
   * Named here rather than in either subsystem because two of them meet on
   * it: `dispatch --auto` writes it and `report` reads it. It was NOT in the
   * seam originally, and within one dispatch the two halves had diverged --
   * the reporter had invented a path and a tolerant parser for a file the
   * scheduler never wrote. That is the exact failure a shared seam exists to
   * prevent, and a path is as much a contract as a schema.
   *
   * Absence is normal: a run driven by manual `dispatch` calls has no
   * schedule, and `report` must still describe it.
   */
  scheduleJson: string;
}

export function runPaths(runId: string, root: string = runsRoot()): RunPaths {
  const base = join(root, runId);
  return {
    runId,
    root: base,
    runJson: join(base, "run.json"),
    registryJson: join(base, "registry.json"),
    controlAuthJson: join(base, "control-auth.json"),
    daemonPid: join(base, "daemon.pid"),
    daemonLog: join(base, "daemon.log"),
    daemonSock: socketPath(runId, "@daemon"),
    ledgerDir: join(base, "ledger"),
    inboxDir: join(base, "inbox"),
    sessionsDir: join(base, "sessions"),
    workersDir: join(base, "workers"),
    scheduleJson: join(base, "schedule.json"),
  };
}

export interface WorkerPaths {
  workerId: string;
  dir: string;
  stateJson: string;
  /**
   * Epoch fence (`ack_seq`, `last_seq`, high-water-mark, attempt dedup).
   * A sibling of `state.json` rather than a field inside it: the state schema
   * is the shared seam and the fence must be writable durably BEFORE a
   * dispatch without rewriting unrelated state.
   */
  fenceJson: string;
  presentationJson: string;
  eventsJsonl: string;
  supervisorLog: string;
  controlSock: string;
  tasksDir: string;
  /**
   * The attended record (`AttendedRecord`), written when a pane is handed to
   * a person and never removed afterwards.
   *
   * Beside state rather than inside it, like presentation: whether a human
   * typed into a pane is a fact ABOUT the run, and losing the pane must not
   * lose it. Named here because `steer`/`tui` write it and `report` reads it
   * — the last phase put a path in two places and the halves diverged
   * within a single dispatch.
   */
  attendedJson: string;
  /**
   * The four per-worker container INPUTS (SRD §5.5): the `--env-file`, the
   * concatenated briefing, the verbgate policy, and the filtered kubeconfig.
   *
   * Named here rather than joined at the mount site because `config/render.ts`
   * built all four from its own separately-computed run-dir string, which was
   * not the one `up` uses — so `render`, the command whose entire purpose is to
   * say what `up` will do, described four mounts at paths no run would ever
   * contain (ISC-188). Nothing writes these files yet; naming them now is what
   * stops the eventual writer from inventing a fifth spelling.
   */
  envFile: string;
  systemAppendMd: string;
  cloudAllow: string;
  kubeconfig: string;
}

export function workerPaths(run: RunPaths, workerId: string): WorkerPaths {
  const dir = join(run.workersDir, workerId);
  return {
    workerId,
    dir,
    stateJson: join(dir, "state.json"),
    fenceJson: join(dir, "fence.json"),
    presentationJson: join(dir, "presentation.json"),
    eventsJsonl: join(dir, "events.jsonl"),
    supervisorLog: join(dir, "supervisor.log"),
    controlSock: socketPath(run.runId, workerId),
    tasksDir: join(dir, "tasks"),
    attendedJson: join(dir, "attended.json"),
    envFile: join(dir, "env"),
    systemAppendMd: join(dir, "system-append.md"),
    cloudAllow: join(dir, "cloud-allow"),
    kubeconfig: join(dir, "kubeconfig"),
  };
}

/**
 * Host directory mounted at `/outbox` for a worker (SRD §5.5).
 *
 * Both ends of the outbox contract need this path and they sit in different
 * subsystems: `config/render.ts` builds the `-v` mount that creates it, and
 * `harvest/` reads what the worker left behind in it. It was computed
 * independently in each — the exact hazard this module's first rule exists to
 * prevent, and a worse one than usual, because a divergence here does not
 * throw. Harvest would simply find an empty directory and report a task that
 * produced artifacts as having produced none (ISC-231).
 *
 * Takes the run ROOT rather than `RunPaths`: render works from a run-dir
 * string it is handed, and requiring the full struct there would have kept the
 * duplicate alive purely as a type accommodation.
 */
export function workerOutboxDir(runRoot: string, workerId: string): string {
  return join(runRoot, "outbox", workerId);
}

/**
 * Host directory mounted read-only at `/skills` (SRD §5.5).
 *
 * Keyed by ROLE, not worker: one host directory is shared by every worker of a
 * role. `skills:` is per-worker overridable, so those workers do NOT
 * necessarily load the same set — `run/materialize.ts` fills this directory
 * with the UNION of their lists and each worker's own `--skill` flags select
 * from it. The directory is therefore a superset of what any one worker asked
 * for; see `materializeRoleSkills` for why that is deliberate. Takes the run
 * root as a string for the same reason `workerOutboxDir` does.
 */
export function roleSkillsDir(runRoot: string, role: string): string {
  return join(runRoot, "skills", role);
}

/**
 * The per-worker code checkout mounted rw at `/workspace` (SRD §5.5, §9.1).
 *
 * Named here for the reason this module exists at all: `config/render.ts`
 * open-coded `join(repo, ".worktrees", w.id)` to build the `-v`, and
 * `run/worktree.ts` is the thing that has to CREATE that directory. Two
 * `join()` calls agreeing today is not the same property as one function, and
 * a divergence here has the shape ISC-188 and ISC-231 both had: Docker creates
 * a missing bind-mount source rather than refusing, so a worker pointed at a
 * path nothing populated gets an empty `/workspace` and reports as an agent
 * that changed nothing rather than as a mount fault.
 *
 * Takes the REPO root, not the run root: unlike everything else in this
 * module, this path lives beside the operator's checkout rather than under
 * `~/.pifleet/runs`, because git objects must be on the same filesystem the
 * container bind-mounts and the SRD's §5.5 mount table names it there.
 *
 * NOT run-scoped, deliberately and consequentially: two concurrent runs naming
 * the same worker id resolve to the same directory. `run/worktree.ts` turns
 * that into a loud refusal rather than a silent adoption — see its
 * `StaleWorktreeError`.
 */
export function workerWorktree(repo: string, workerId: string): string {
  return join(repo, ".worktrees", workerId);
}

/**
 * The branch a worker commits on (SRD §9.1), honouring `run.branch_prefix`.
 *
 * `branch_prefix` sat in the schema with ZERO readers while
 * `cli/commands/dispatch.ts` hard-coded the literal `fleet/${runId}/${worker}`
 * into every envelope — so an operator who set `branch_prefix: exp` got a
 * config key that validated, documented itself in `fleet.example.yaml`, and
 * changed nothing. That is the same dead-field shape `models_allowlist` and
 * `--keep-panes` were each caught in, and the fix is the same one: a single
 * helper both the creator and the envelope builder call, so there is no second
 * spelling to drift.
 *
 * A name, not a path — but it belongs to this module's rule rather than to
 * either caller's, for exactly the reason the rule is stated in the header: a
 * value derived in two places will eventually be derived differently in two
 * places, and here the two places are the branch git checks out and the branch
 * the envelope tells the worker it is on.
 */
export function workerBranch(branchPrefix: string, runId: string, workerId: string): string {
  return `${branchPrefix}/${runId}/${workerId}`;
}

/** Ledger shards are per writer (SRD §7.7); the shard name is the writer id. */
export function ledgerShard(run: RunPaths, writerId: string): string {
  return join(run.ledgerDir, `${writerId}.jsonl`);
}

/** Where `dispatch` records the full envelope it sent (SRD §7.1). */
export function inboxTaskPath(run: RunPaths, taskId: string): string {
  return join(run.inboxDir, `${taskId}.json`);
}

/** Terminal per-task record written by the supervisor at settle. */
export function taskRecordPath(worker: WorkerPaths, taskId: string): string {
  return join(worker.tasksDir, `${taskId}.json`);
}

/**
 * How one bind-mount source exposes the RUN DIRECTORY, or `null` (ISC-127).
 *
 * TWO relations, and the asymmetry with `classifyHostGcloudExposure` is the
 * whole content of this function. That one has three, because NOTHING inside
 * the gcloud store may be mounted. Here, everything a worker legitimately gets
 * IS inside the run dir — `<run>/outbox/<id>`, `<run>/sessions`,
 * `<run>/skills/<role>`, `<run>/workers/<id>/cloud-allow`, the briefing, the
 * kubeconfig — so an "inside-the-run-dir" relation would flag the entire §5.5
 * mount table and could only ever be satisfied by weakening it. The criterion
 * says the run DIR is not mounted, and mounting a named child of it is not
 * mounting it.
 *
 * What the two relations actually protect is everything in the run root that
 * is deliberately NOT in that table: `control-auth.json` — the 0600 per-run
 * control-socket secret whose entire threat model (`security/control-auth.ts`)
 * is that a worker cannot read it — plus `registry.json`, `ledger/`, `inbox/`
 * (full task envelopes), `run.json`, and every OTHER worker's `state.json`,
 * `events.jsonl` and outbox. Handing a worker the run root hands it all of
 * that, and hands it the key to the socket that commands its own supervisor.
 *
 * The CONTAINS direction is not hypothetical, and it is the one a mount table
 * built from literals cannot rule out. `run.repo` is operator-settable and is
 * mounted verbatim at `/workspace` under `isolation: shared-ro`; the runs root
 * moves independently via `PIFLEET_RUNS_DIR`. An operator who keeps runs
 * inside the checkout — `run.repo: ~/proj`, `PIFLEET_RUNS_DIR=~/proj/runs`, an
 * ordinary thing to want — mounts the live run directory into the container
 * with no flag anywhere in `render.ts` looking wrong. Measured on this
 * codebase before the guard below existed: the `/workspace` source was an
 * ancestor of `<run>/control-auth.json` and every ISC-127 assertion of the day
 * (there were none) would have stayed green.
 *
 * Comparison is on `resolve()`d paths — lexical, for the reason
 * `classifyHostGcloudExposure` gives: `buildDockerArgv` is synchronous and
 * pure by design and `realpath` is I/O. That closes `..` and trailing-slash
 * spellings and not symlinks; the integration side `realpath`s both ends.
 *
 * Boundaries use an explicit separator, so a sibling runs root named
 * `<run>-backup` is not flagged for a criterion that says nothing about it.
 */
export type RunDirExposure = "is-the-run-dir" | "contains-the-run-dir";

export function classifyRunDirExposure(source: string, runDir: string): RunDirExposure | null {
  const dir = resolve(runDir);
  const s = resolve(source);
  if (s === dir) return "is-the-run-dir";
  if (dir.startsWith(`${s}/`)) return "contains-the-run-dir";
  return null;
}

/** A `docker run` argv that would mount the run directory into a container. */
export class RunDirMountError extends Error {
  constructor(source: string, runDir: string, relation: RunDirExposure) {
    const how =
      relation === "is-the-run-dir" ? "IS the run directory" : "CONTAINS the run directory";
    super(
      `refusing to launch: bind-mount source ${source} ${how} (${runDir}) — the run ` +
        `directory holds control-auth.json, the ledger, the inbox and every other ` +
        `worker's state, none of which is a worker's to read — SRD §5.5 / ISC-127`,
    );
    this.name = "RunDirMountError";
  }
}

/**
 * ISC-127 as a RUNTIME GUARD on the argv production actually launches.
 *
 * Deliberately shaped like `assertNoHostGcloudMount`, and for the reason that
 * one records: a predicate with no importer in `src/` closes nothing. It
 * documents an intention that holds exactly as long as someone remembers to
 * keep asserting it, and the offending path here does not come from a literal
 * in `render.ts` at all — it arrives from `run.repo` and `PIFLEET_RUNS_DIR`,
 * two operator-settable values whose relationship no reviewer reading the
 * mount table can see. Checking the FINISHED argv is the only altitude at
 * which that relationship is knowable.
 *
 * Throwing beats returning a flag: a launcher that ignores a returned warning
 * is the same launcher that would have shipped the mount.
 */
export function assertNoRunDirMount(argv: readonly string[], runDir: string): void {
  argv.forEach((a, i) => {
    if (argv[i - 1] !== "-v" && argv[i - 1] !== "--volume") return;
    const sep = a.indexOf(":");
    const source = sep === -1 ? a : a.slice(0, sep);
    if (!source.startsWith("/")) return; // a named volume, not a host path
    const relation = classifyRunDirExposure(source, runDir);
    if (relation !== null) throw new RunDirMountError(source, runDir, relation);
  });
}

/**
 * Short, deterministic unix-socket path for a worker's control socket (or the
 * daemon's, keyed `@daemon`). Hashed rather than named so the total path stays
 * far below the 104-byte `sun_path` cap regardless of run id or worker id
 * length; deterministic so the CLI needs no lookup to find a live supervisor.
 */
export function socketPath(runId: string, workerId: string): string {
  const h = createHash("sha256").update(`${runId}\0${workerId}`).digest("hex").slice(0, 16);
  return join(tmpdir(), "pifleet", `${h}.sock`);
}

/**
 * Most recent run id under the root, by the lexical order the id format
 * guarantees. Only entries that actually contain a `run.json` count: the root
 * is a directory users can drop stray files into, and a stray name that sorts
 * after every timestamp would otherwise become "the latest run" and every
 * socket path derived from it would dangle (found by the e2e suite).
 */
export async function latestRunId(root: string = runsRoot()): Promise<string | null> {
  const { readdir, stat } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const runs: string[] = [];
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    try {
      await stat(join(root, e, "run.json"));
      runs.push(e);
    } catch {
      // Not a run directory.
    }
  }
  runs.sort();
  return runs.length > 0 ? runs[runs.length - 1]! : null;
}
