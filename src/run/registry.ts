/**
 * Run registry (SRD §7.7) and the control-plane socket layer.
 *
 * `registry.json` has a SINGLE writer — the daemon. Every mutation is an RPC
 * to it over a unix socket; readers read the file. Two supervisors writing
 * the registry directly would need cross-process file locking, which is
 * exactly the class of coordination the single-writer rule exists to avoid.
 *
 * Process identity is `(pid, started)` — pid plus `ps -o lstart=` start time —
 * never pid alone. Pids recycle: a registry that remembers only the number
 * will happily resurrect a dead supervisor when an unrelated process is
 * assigned its pid, and `down` would then SIGTERM an innocent bystander.
 *
 * The socket protocol is one JSON request line, one JSON response line, over
 * the same `LineSplitter` framing as everything else. Sockets live under
 * `os.tmpdir()` (see run/paths.ts for the 104-byte `sun_path` rationale).
 */

import { z } from "zod";
import type { WorkerState } from "../contracts.ts";
import {
  AUTH_FIELD,
  checkAuth,
  ensureControlAuth,
  loadControlSecret,
} from "../security/control-auth.ts";
import {
  HeartbeatMonitor,
  reapStale,
  type ReaperOps,
  type ReapReport,
} from "../safety/reaper.ts";
// TYPE-ONLY, and it has to stay that way: `kill.ts` imports `processStartTime`
// from this module, so a value import here would close the documented
// `kill.ts -> run/registry.ts -> … -> safety/reaper.ts -> kill.ts` cycle from a
// second direction. A `import type` is erased before it can.
import type { KillOutcome } from "../safety/kill.ts";
import { writeJsonAtomic, LineSplitter, parseLine } from "../util/jsonl.ts";
import { workerPaths, type RunPaths } from "./paths.ts";
import { readWorkerState } from "./state.ts";

// ---------------------------------------------------------------------------
// Process identity — pid + start time, never pid alone.
// ---------------------------------------------------------------------------

export interface ProcessIdentity {
  pid: number;
  /** A `processStartTime` token. Empty string when nothing captured one. */
  started: string;
}

/**
 * The rendering `processStartTime` pins, and the tag it stamps on the result.
 *
 * `ps -o lstart=` RENDERS a timestamp; it does not report one. The rendering
 * is read from the calling process's own environment, so the same live pid at
 * the same instant produces different bytes in different shells — measured on
 * one pid, one instant, this machine:
 *
 *   TZ=UTC               "Thu 20 Aug 06:51:33 2026"
 *   TZ=America/Halifax   "Thu 20 Aug 03:51:33 2026"
 *   TZ=Asia/Tokyo        "Thu 20 Aug 15:51:33 2026"
 *   LC_TIME=de_DE.UTF-8  "Do. 20 Aug. 00:51:33 2026"
 *
 * An identity is captured in the LAUNCHER's environment and compared in the
 * OPERATOR's, and those are routinely different processes: `up` from a local
 * terminal and `down` over SSH (sshd forwards `LC_TIME` under its default
 * `AcceptEnv LANG LC_*`), `up` from launchd or cron with no `TZ` at all and
 * `down` from a shell that sets one, a containerised CLI against a
 * host-launched daemon. Every one of those made a LIVE supervisor compare
 * unequal to its own recorded identity — which the whole kill path reads as
 * "this process is gone". DST is not involved; the offset does not have to
 * change for the two renderings to differ.
 *
 * So the rendering is pinned at the source rather than compensated for at each
 * comparison. `TZ=UTC` fixes the instant, `LC_ALL=C` fixes the field order and
 * the month/weekday names; together they make the string a function of the
 * process alone.
 *
 * The tag is the other half, and it is what makes the format change SURVIVABLE
 * rather than silent. Pinning changes the bytes for every identity already on
 * disk — even on a machine that was already in UTC, because `LC_ALL=C` also
 * reorders the fields ("Thu Aug 20 …" against "Thu 20 Aug …"). An untagged
 * recorded value is therefore not comparable to a tagged one, and it is not a
 * MISMATCH either: "a stranger holds this pid" would be a false statement
 * about the world. Callers detect it with `isPinnedIdentity` and refuse
 * explicitly. See `down`'s `anchorIdentity` for the policy that rests on this.
 */
export const IDENTITY_FORMAT = "utc1";

/** Environment that makes `ps -o lstart=` a function of the process alone. */
const IDENTITY_PS_ENV = { TZ: "UTC", LC_ALL: "C" } as const;

/**
 * Start time of a pid as a tagged, environment-independent token, or null if
 * no such process.
 *
 * Never returns the empty string: an empty `ps` result is "no such process",
 * which is `null`. Callers that persist `?? ""` are recording "capture
 * failed", and `""` must be read as exactly that and never as an identity.
 */
export async function processStartTime(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    // Explicitly, not inherited. This is the whole fix: without it the token
    // carries the caller's TZ and locale into a value that another process,
    // in another environment, is going to compare byte-for-byte.
    env: { ...process.env, ...IDENTITY_PS_ENV },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0 || out.length === 0) return null;
  return `${IDENTITY_FORMAT} ${out}`;
}

/**
 * Whether a recorded `started` was written by a build that pinned the
 * rendering, and can therefore be compared at all.
 *
 * False for `""` (capture failed — see `processStartTime`) and for any value
 * written before the pin existed. No locale renders a weekday as `utc1`, so
 * the tag cannot collide with a legacy value.
 */
export function isPinnedIdentity(recorded: string): boolean {
  return recorded.startsWith(`${IDENTITY_FORMAT} `);
}

/** True only if the pid is alive AND is still the same process we recorded. */
export async function identityAlive(id: ProcessIdentity): Promise<boolean> {
  const started = await processStartTime(id.pid);
  return started !== null && started === id.started;
}

// ---------------------------------------------------------------------------
// Registry schema
// ---------------------------------------------------------------------------

export const RegistryWorkerSchema = z.object({
  worker: z.string(),
  pid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  started: z.string(),
  registered_at: z.string(),
});

export const RegistrySchema = z.object({
  schema: z.literal("pifleet.registry/v1"),
  run_id: z.string(),
  daemon: z.object({ pid: z.number().int().nonnegative(), started: z.string() }),
  workers: z.record(z.string(), RegistryWorkerSchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

export async function readRegistry(run: RunPaths): Promise<Registry | null> {
  const file = Bun.file(run.registryJson);
  if (!(await file.exists())) return null;
  return RegistrySchema.parse(JSON.parse(await file.text()));
}

// ---------------------------------------------------------------------------
// JSONL request/response over a unix socket
// ---------------------------------------------------------------------------

export type SocketHandler = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SocketServer {
  stop(): Promise<void>;
}

/**
 * Serve a one-request-one-response JSONL protocol on a unix socket. A stale
 * socket file from a crashed predecessor is unlinked first: `bind` would
 * otherwise fail EADDRINUSE forever, since nothing cleans up after SIGKILL.
 *
 * The per-run secret is REQUIRED and enforced here, in the framing layer,
 * before any handler sees the request (SRD §12.7). Enforcing per verb inside
 * each handler is how `ping` — the verb everyone forgets — becomes an
 * unauthenticated oracle for whether a run exists; a gate at the framing
 * layer covers every verb any handler will ever add. A refusal is a normal
 * response, not a crash and not a hang: the caller gets a structured error
 * and the server keeps serving.
 */
export async function serveJsonlSocket(
  path: string,
  handler: SocketHandler,
  auth: { secret: string },
): Promise<SocketServer> {
  const { mkdir, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  try {
    await unlink(path);
  } catch {
    // Did not exist — the common case.
  }

  const splitters = new WeakMap<object, LineSplitter>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        let splitter = splitters.get(socket);
        if (splitter === undefined) {
          splitter = new LineSplitter();
          splitters.set(socket, splitter);
        }
        for (const line of splitter.push(chunk)) {
          void (async () => {
            let response: Record<string, unknown>;
            try {
              const msg = parseLine<Record<string, unknown>>(line);
              if (msg === undefined) return;
              const refusal = checkAuth(msg, auth.secret);
              if (refusal !== null) {
                response = refusal;
              } else {
                // The token is stripped before the handler runs: no handler
                // can echo it into a response, a ledger record or a log line,
                // which is rule 3 of security/control-auth.ts made structural.
                const { [AUTH_FIELD]: _token, ...verb } = msg;
                response = await handler(verb);
              }
            } catch (err) {
              response = { ok: false, error: String(err) };
            }
            try {
              socket.write(`${JSON.stringify(response)}\n`);
            } catch {
              // Peer went away mid-response; nothing to do.
            }
          })();
        }
      },
      error() {},
    },
  });

  return {
    async stop() {
      server.stop(true);
      try {
        await unlink(path);
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Whether the request provably never reached the listener.
 *
 * `connect_failed` is the only value that lets a caller retry elsewhere: the
 * socket was never opened, so nothing on the other side saw the message. A
 * timeout or a mid-request close says nothing of the sort — the supervisor
 * may have accepted the dispatch, persisted its fence and started the agent,
 * and merely answered late. Callers that treat those as "never happened" run
 * the same task twice.
 */
export type SocketFailure = "connect_failed" | "timeout" | "closed" | "error";

export class SocketRequestError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly failure: SocketFailure = "error",
  ) {
    super(`${message} (${path})`);
    this.name = "SocketRequestError";
  }

  /**
   * True only when the request cannot have been acted on. Everything else is
   * in doubt, and in doubt must never be retried on another worker.
   */
  get neverDelivered(): boolean {
    return this.failure === "connect_failed";
  }
}

/**
 * Send one request, await one response line, close.
 *
 * When `secret` is given it is stamped onto the outgoing message as the
 * `auth` field. Stamping at the transport keeps the token out of every
 * caller-built message — and therefore out of everything callers persist:
 * `dispatch` records its envelope verbatim in the inbox, and a token inside
 * it would be a secret in a ledger-adjacent file.
 */
export async function socketRequest(
  path: string,
  msg: Record<string, unknown>,
  opts: { timeoutMs?: number; secret?: string } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (opts.secret !== undefined) msg = { ...msg, [AUTH_FIELD]: opts.secret };
  const splitter = new LineSplitter();

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new SocketRequestError(path, `no response in ${timeoutMs}ms`, "timeout")));
    }, timeoutMs);

    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(msg)}\n`);
        },
        data(socket, chunk) {
          for (const line of splitter.push(chunk)) {
            const parsed = parseLine<Record<string, unknown>>(line);
            if (parsed === undefined) continue;
            finish(() => resolve(parsed));
            socket.end();
            return;
          }
        },
        close() {
          finish(() => reject(new SocketRequestError(path, "closed before responding", "closed")));
        },
        error(_socket, err) {
          finish(() => reject(new SocketRequestError(path, String(err), "error")));
        },
        connectError(_socket, err) {
          finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`, "connect_failed")));
        },
      },
    }).catch((err) => {
      finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`, "connect_failed")));
    });
  });
}

// ---------------------------------------------------------------------------
// The daemon: single writer of registry.json
// ---------------------------------------------------------------------------

export interface RegistryDaemon {
  stop(): Promise<void>;
  /**
   * One reaper scan (ISC-236). The interval calls this; tests call it directly
   * so a reap can be driven deterministically rather than waited for — a test
   * that races a timer is the anti-pattern this whole suite avoids.
   */
  reapOnce(): Promise<ReapReport[]>;
}

/**
 * Reaper wiring for the daemon (SRD §13.1, F31).
 *
 * The reaper module scans and kills; it deliberately does not deregister,
 * because `registry.json` has a single writer and that writer is here. So the
 * loop lives in the daemon: `reapStale` returns what it reaped, and the daemon
 * removes exactly those entries through the same serialized chain every other
 * mutation uses. A second write path to registry.json would reintroduce the
 * lost-update race the chain exists to prevent.
 */
export interface ReaperConfig {
  /** `run.heartbeat_interval`, in ms. Staleness is 3× this (§13.1). */
  heartbeatIntervalMs: number;
  /** Scan period. Defaults to the heartbeat interval. */
  scanIntervalMs?: number;
  ops?: ReaperOps;
  /** Overridable so tests need no real state files on disk. */
  readState?: (worker: string) => Promise<WorkerState | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  termGraceMs?: number;
  killGraceMs?: number;
  /**
   * Observability hook — the CLI writes these to the ledger.
   *
   * Called with EVERY reap attempted, including the ones that refused to stop
   * anything. A refusal is the fact an operator most needs to see: a live
   * supervisor that nothing in this run can prove it owns. Filtering those out
   * to keep the ledger tidy would hide exactly the case that needs a human.
   */
  onReap?: (reports: ReapReport[]) => void;
}

/**
 * Whether a reap report authorises removing the worker from the registry.
 *
 * DEREGISTRATION IS A CLAIM, not bookkeeping. `registry.json` is what `status`
 * and `down` read to find out what this run is running; deleting an entry
 * asserts there is no longer a supervisor behind that name. For an outcome that
 * means the supervisor is ALIVE — `group_unconfirmed`, `unconfirmed` — that
 * assertion is false, and it is false in the direction that loses things: the
 * worker becomes invisible to `down`, so nothing ever stops it, and invisible
 * to the reaper's next scan, so nothing ever tries again. It keeps its
 * container, its worktree and its token spend, and no process on the host names
 * it any more.
 *
 * A SECOND EXHAUSTIVE SWITCH, deliberately not a shared predicate with
 * `reaper.ts`'s `supervisorStopped`. The two answers agree today, and they are
 * still two different questions — "may this container be destroyed" and "may
 * this name be forgotten". A seventh `KillOutcome` has to be answered for both,
 * by someone looking at both, and a shared helper would answer the second one
 * silently from a decision made about the first. The `never`-typed default is
 * what forces that: the root cause of the defect this fixes was that adding a
 * union member is invisible to `tsc` for a consumer that only stores the value.
 */
function deregisterOnReap(outcome: KillOutcome): boolean {
  switch (outcome) {
    case "aborted":
    case "terminated":
    case "killed":
    case "already_gone":
      return true;
    case "unconfirmed":
    case "group_unconfirmed":
      return false;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled KillOutcome: ${String(unhandled)}`);
    }
  }
}

/**
 * Start the registry daemon in-process. Verbs are deliberately few: the
 * registry is thin by design (SRD §3.3) — it holds no RPC stream and owns no
 * container, so one crash cannot take the fleet.
 */
export async function startRegistryDaemon(
  run: RunPaths,
  opts: { onShutdown?: () => void; reaper?: ReaperConfig } = {},
): Promise<RegistryDaemon> {
  const started = (await processStartTime(process.pid)) ?? "";
  let registry: Registry = (await readRegistry(run)) ?? {
    schema: "pifleet.registry/v1",
    run_id: run.runId,
    daemon: { pid: process.pid, started },
    workers: {},
  };
  registry = { ...registry, daemon: { pid: process.pid, started } };

  /**
   * Registry writes are serialized through one chain.
   *
   * Each socket line is handled in its own detached async task, so N
   * supervisors registering during `up` land in one tick and interleave
   * read-modify-write on a shared object. Unique temp names stop the file from
   * TEARING, but not from losing an update: two handlers can both snapshot
   * `registry`, and the second write erases the first worker. The supervisor
   * already serializes its own state and fence writes for exactly this reason;
   * the daemon did not, and a lost registration silently downgrades liveness
   * detection to the pid-only path.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const persist = () =>
    serialized(() => writeJsonAtomic(run.registryJson, RegistrySchema.parse(registry)));

  await persist();
  await writeJsonAtomic(run.daemonPid, { pid: process.pid, started });

  let server: SocketServer | null = null;
  let onShutdown: (() => void) | null = null;

  // The run's control secret (SRD §12.7). `up` mints it before launching
  // anything, so this normally reads; the mint path exists for a daemon
  // started directly against a bare run directory (tests, debugging) and is
  // exclusive-create, so racing components converge on one value.
  const controlAuth = await ensureControlAuth(run);

  server = await serveJsonlSocket(run.daemonSock, async (msg) => {
    switch (msg["cmd"]) {
      case "ping":
        return { ok: true, pid: process.pid };
      case "register_worker": {
        const worker = RegistryWorkerSchema.parse(msg["entry"]);
        registry = {
          ...registry,
          workers: { ...registry.workers, [worker.worker]: worker },
        };
        await persist();
        return { ok: true };
      }
      case "deregister_worker": {
        const name = z.string().parse(msg["worker"]);
        const workers = { ...registry.workers };
        delete workers[name];
        registry = { ...registry, workers };
        await persist();
        return { ok: true };
      }
      case "get_registry":
        return { ok: true, registry };
      case "shutdown":
        queueMicrotask(() => onShutdown?.());
        return { ok: true };
      default:
        return { ok: false, error: `unknown cmd: ${String(msg["cmd"])}` };
    }
  }, { secret: controlAuth.secret });

  // -------------------------------------------------------------------------
  // Reaper loop (ISC-236)
  // -------------------------------------------------------------------------

  const monitor = new HeartbeatMonitor(opts.reaper?.now);
  const readState =
    opts.reaper?.readState ??
    ((worker: string) => readWorkerState(workerPaths(run, worker)));

  /**
   * A scan takes a SNAPSHOT of the worker set and reaps against it. Reaping is
   * slow — a kill ladder waits out two grace periods — and registrations land
   * during it, so the reports are applied by NAME against whatever the
   * registry holds at write time rather than by overwriting the snapshot. A
   * worker that registered mid-scan must not be erased by a scan that started
   * before it existed.
   *
   * Only the reports that PROVE the supervisor is gone remove anything;
   * `deregisterOnReap` says why. The rest are still announced, because a
   * refusal is a fact the ledger needs.
   */
  const reapOnce = async (): Promise<ReapReport[]> => {
    const cfg = opts.reaper;
    if (cfg === undefined) return [];
    const reports = await reapStale({
      registry,
      readState,
      monitor,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
      ops: cfg.ops,
      termGraceMs: cfg.termGraceMs,
      killGraceMs: cfg.killGraceMs,
      now: cfg.now,
      sleep: cfg.sleep,
    });
    const gone = reports.filter((r) => deregisterOnReap(r.supervisor));
    if (gone.length > 0) {
      await serialized(async () => {
        const workers = { ...registry.workers };
        for (const r of gone) delete workers[r.worker];
        registry = { ...registry, workers };
        await writeJsonAtomic(run.registryJson, RegistrySchema.parse(registry));
      });
    }
    if (reports.length > 0) cfg.onReap?.(reports);
    return reports;
  };

  let scanning = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.reaper !== undefined) {
    const period = opts.reaper.scanIntervalMs ?? opts.reaper.heartbeatIntervalMs;
    timer = setInterval(() => {
      // A scan outlasting its period must not stack: the ladder's grace
      // periods are seconds long, and overlapping scans would aim two kill
      // ladders at one pid — the second at whatever inherits it.
      if (scanning) return;
      scanning = true;
      void reapOnce()
        .catch(() => {
          // A failed scan is not fatal to the daemon; the next one retries.
        })
        .finally(() => {
          scanning = false;
        });
    }, period);
    // The socket server already holds the loop open; the reaper must not be
    // the reason a daemon refuses to exit.
    timer.unref?.();
  }

  const daemon: RegistryDaemon = {
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await server?.stop();
      server = null;
    },
    reapOnce,
  };
  onShutdown = () => {
    void daemon.stop().then(() => opts.onShutdown?.());
  };
  return daemon;
}

/**
 * Client-side call to the daemon; tolerant of an absent daemon when asked.
 *
 * The run's secret is loaded from the run directory on every call and stamped
 * by the transport. A run with no auth record is as unreachable as one with
 * no daemon — under `optional` both degrade to null, because a best-effort
 * caller (supervisor registration) must not crash over either.
 */
export async function registryCall(
  run: RunPaths,
  msg: Record<string, unknown>,
  opts: { optional?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  try {
    const secret = await loadControlSecret(run);
    return await socketRequest(run.daemonSock, msg, { secret });
  } catch (err) {
    if (opts.optional) return null;
    throw err;
  }
}
