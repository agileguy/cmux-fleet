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
import { writeJsonAtomic, LineSplitter, parseLine } from "../util/jsonl.ts";
import type { RunPaths } from "./paths.ts";

// ---------------------------------------------------------------------------
// Process identity — pid + start time, never pid alone.
// ---------------------------------------------------------------------------

export interface ProcessIdentity {
  pid: number;
  /** `ps -o lstart=` output, verbatim. Empty string when the pid is gone. */
  started: string;
}

/** Start time of a pid, or null if no such process. */
export async function processStartTime(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return proc.exitCode === 0 && out.length > 0 ? out : null;
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
 */
export async function serveJsonlSocket(path: string, handler: SocketHandler): Promise<SocketServer> {
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
              response = await handler(msg);
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

export class SocketRequestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message} (${path})`);
    this.name = "SocketRequestError";
  }
}

/** Send one request, await one response line, close. */
export async function socketRequest(
  path: string,
  msg: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
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
      finish(() => reject(new SocketRequestError(path, `no response in ${timeoutMs}ms`)));
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
          finish(() => reject(new SocketRequestError(path, "closed before responding")));
        },
        error(_socket, err) {
          finish(() => reject(new SocketRequestError(path, String(err))));
        },
        connectError(_socket, err) {
          finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`)));
        },
      },
    }).catch((err) => {
      finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`)));
    });
  });
}

// ---------------------------------------------------------------------------
// The daemon: single writer of registry.json
// ---------------------------------------------------------------------------

export interface RegistryDaemon {
  stop(): Promise<void>;
}

/**
 * Start the registry daemon in-process. Verbs are deliberately few: the
 * registry is thin by design (SRD §3.3) — it holds no RPC stream and owns no
 * container, so one crash cannot take the fleet.
 */
export async function startRegistryDaemon(
  run: RunPaths,
  opts: { onShutdown?: () => void } = {},
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
  });

  const daemon: RegistryDaemon = {
    async stop() {
      await server?.stop();
      server = null;
    },
  };
  onShutdown = () => {
    void daemon.stop().then(() => opts.onShutdown?.());
  };
  return daemon;
}

/** Client-side call to the daemon; tolerant of an absent daemon when asked. */
export async function registryCall(
  run: RunPaths,
  msg: Record<string, unknown>,
  opts: { optional?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  try {
    return await socketRequest(run.daemonSock, msg);
  } catch (err) {
    if (opts.optional) return null;
    throw err;
  }
}
