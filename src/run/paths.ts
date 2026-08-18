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
