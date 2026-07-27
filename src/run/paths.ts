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
import { join } from "node:path";

/** Root under which every run directory lives. */
export function runsRoot(env: Record<string, string | undefined> = process.env): string {
  return env["PIFLEET_RUNS_DIR"] ?? join(homedir(), ".pifleet", "runs");
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
  daemonPid: string;
  daemonLog: string;
  daemonSock: string;
  ledgerDir: string;
  inboxDir: string;
  sessionsDir: string;
  workersDir: string;
}

export function runPaths(runId: string, root: string = runsRoot()): RunPaths {
  const base = join(root, runId);
  return {
    runId,
    root: base,
    runJson: join(base, "run.json"),
    registryJson: join(base, "registry.json"),
    daemonPid: join(base, "daemon.pid"),
    daemonLog: join(base, "daemon.log"),
    daemonSock: socketPath(runId, "@daemon"),
    ledgerDir: join(base, "ledger"),
    inboxDir: join(base, "inbox"),
    sessionsDir: join(base, "sessions"),
    workersDir: join(base, "workers"),
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
