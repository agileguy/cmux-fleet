/**
 * The two halves of the ISC-126 second-uid probe, run INSIDE a container.
 *
 * This file is never imported by the test process. It is executed by the `bun`
 * inside a probe container, once as `server` and repeatedly as `client` under
 * different uids, and it talks to its caller in one JSON line on stdout.
 * `test/integration/control-socket-uid.test.ts` is the only caller and carries
 * the reasoning for why the probe has this shape at all.
 *
 * ## Why the server is production's `serveJsonlSocket` and not a stand-in
 *
 * The criterion is about THE CONTROL SOCKET, so the thing accepting the
 * connection has to be the function that serves it. A hand-rolled `Bun.listen`
 * with a uid check copied into it would assert that a copy works — the mistake
 * `container-env.test.ts` records ISC-255 catching in `adc.test.ts`, where a
 * test built its own shape and then proved things about the shape.
 *
 * ## Why TWO sockets
 *
 * They isolate the two independent gates, and only the second one is the new
 * control:
 *
 *   - `tight/` keeps production's permissions, which `serveJsonlSocket` now
 *     sets to 0700 in code. Another uid is refused at `connect(2)` by the
 *     kernel, before the accept handler is ever reached.
 *   - `open/` is deliberately chmodded to 0777, socket and directory both,
 *     AFTER the server is listening. That reproduces exactly the state ISC-126
 *     measured under `umask 000` — the state in which the old code let another
 *     uid straight through to the auth token — and leaves the accept-time
 *     credential check as the ONLY thing that can refuse.
 *
 * A probe with only `tight/` would pass on the strength of the permission bits
 * and prove nothing about the uid check. A probe with only `open/` would not
 * show that production's own permissions are correct. Both, or neither.
 *
 * ## The secret comes from the environment, not argv
 *
 * `docker exec -e` rather than a positional argument, for the reason
 * `security/relay.ts` records against `OMLX_API_KEY`: argv is visible in `ps`,
 * in `docker inspect`, and in any log that echoes a command. This one protects
 * nothing real — it is minted for one container that is about to be deleted —
 * but a test that models the careless shape is how the careless shape gets
 * copied into something that does.
 */

const SECRET_ENV = "PIFLEET_PROBE_SECRET";

function secret(): string {
  const s = process.env[SECRET_ENV];
  if (s === undefined || s.length === 0) {
    throw new Error(`${SECRET_ENV} is not set; the probe cannot authenticate`);
  }
  return s;
}

async function runServer(root: string): Promise<void> {
  // DYNAMIC, and it has to stay that way. The client half of this file runs as
  // the PROBING uid, from a copy planted at the container root, and must not
  // depend on the bind-mounted repository being readable by that uid. A
  // top-level import of `registry.ts` would drag `src/` and `node_modules/`
  // into the client's load path, where host ownership passes straight through
  // on Linux (`container/mounts.ts` records that measurement) — so the probe
  // would fail on CI for a mount-permission reason wearing a uid-refusal
  // costume, which is the exact confusion ISC-126 refused to ship.
  const { serveJsonlSocket } = await import("../../src/run/registry.ts");
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const tightDir = join(root, "tight");
  const openDir = join(root, "open");
  await mkdir(tightDir, { recursive: true });
  await mkdir(openDir, { recursive: true });

  const tightSock = join(tightDir, "s.sock");
  const openSock = join(openDir, "s.sock");

  const handler = async (msg: Record<string, unknown>) => {
    // `served: true` is the thing the test looks for. It can only be produced
    // by a request that got PAST both gates and reached a verb.
    if (msg["cmd"] === "ping") return { ok: true, served: true, uid: process.getuid?.() ?? null };
    return { ok: false, error: `unknown verb ${String(msg["cmd"])}` };
  };

  await serveJsonlSocket(tightSock, handler, { secret: secret() });
  await serveJsonlSocket(openSock, handler, { secret: secret() });

  // Defeat the filesystem gate on the open socket, on purpose and only here.
  // Order matters: `serveJsonlSocket` sets 0700 on both, so this must come
  // after it or it would be silently undone.
  await chmod(openDir, 0o777);
  await chmod(openSock, 0o777);

  await writeFile(join(root, "ready"), `${process.getuid?.() ?? -1}\n`);
  // Hold the process open. The container is torn down by the test.
  await new Promise(() => {});
}

interface ClientVerdict extends Record<string, unknown> {
  uid: number | null;
  connect: "ok" | "error";
  errno: string | null;
  /** The single response line, if the server sent one before closing. */
  response: Record<string, unknown> | null;
  closedByServer: boolean;
}

async function runClient(path: string): Promise<void> {
  const verdict: ClientVerdict = {
    uid: process.getuid?.() ?? null,
    connect: "error",
    errno: null,
    response: null,
    closedByServer: false,
  };

  let settle!: () => void;
  const closed = new Promise<void>((r) => {
    settle = r;
  });

  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          for (const line of chunk.toString().split("\n")) {
            const t = line.trim();
            if (t.length === 0) continue;
            try {
              verdict.response = JSON.parse(t) as Record<string, unknown>;
            } catch {
              verdict.response = { unparsed: t };
            }
          }
        },
        close() {
          verdict.closedByServer = true;
          settle();
        },
        error() {
          settle();
        },
      },
    });
  } catch (err) {
    // EACCES from the kernel on a 0700 directory lands here, and so does
    // ENOENT when the directory cannot even be traversed. Both are refusals;
    // the test distinguishes them from a served request, not from each other.
    verdict.errno = String((err as { code?: unknown }).code ?? err);
    console.log(JSON.stringify(verdict));
    return;
  }

  verdict.connect = "ok";
  socket.write(`${JSON.stringify({ cmd: "ping", auth: secret() })}\n`);
  await Promise.race([closed, Bun.sleep(3000)]);
  try {
    socket.end();
  } catch {
    // Already closed by the server — the refusal path.
  }
  console.log(JSON.stringify(verdict));
}

const [mode, arg] = process.argv.slice(2);
if (mode === "server") {
  if (arg === undefined) throw new Error("server mode needs a root directory");
  await runServer(arg);
} else if (mode === "client") {
  if (arg === undefined) throw new Error("client mode needs a socket path");
  await runClient(arg);
  process.exit(0);
} else {
  throw new Error(`unknown mode ${String(mode)}`);
}
