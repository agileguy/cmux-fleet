/**
 * The accept-time uid gate on the control socket (ISC-126), everything except
 * the second uid.
 *
 * ## What this file is, and what it deliberately is not
 *
 * ISC-126 says "the control socket refuses a connection from another uid". A
 * second uid is not available on a developer machine without `sudo`, so the
 * criterion's own probe lives in `test/integration/control-socket-uid.test.ts`,
 * where Docker supplies one. THIS file proves everything that probe rests on,
 * in-process and on every push:
 *
 *   - the kernel actually answers the question on this platform, through the
 *     real FFI, on the real descriptor `Bun.listen` hands the accept handler;
 *   - the decision function denies a uid that is not ours and allows one that
 *     is, on that same real descriptor;
 *   - `serveJsonlSocket` is WIRED to that decision — it closes a denied peer
 *     before the handler is reached, even when the request carries a valid
 *     auth token;
 *   - the socket and its directory are 0700 because this code says so, not
 *     because the operator's umask happened to say so.
 *
 * The last one is SUPPORTING EVIDENCE and nothing more, and ISA.md refuses it
 * as a substitute in as many words: a mode-bits assertion proves "the
 * permissions look right on this machine today", which is strictly weaker than
 * "a connection from another uid is refused". It is here because the umask
 * inversion is the specific defect ISC-126 documented — 0777 in a 0777
 * directory at `umask 000` — and a test that flips the umask is the only thing
 * that can show the inversion is gone. It does not close the criterion.
 *
 * ## How the refusal path is reached with only one uid
 *
 * By pointing the gate at a uid the connecting process does not have, via
 * `serveJsonlSocket`'s `expectUid` option. That option cannot weaken anything —
 * every value it takes narrows the gate to exactly one uid and there is no
 * value meaning "skip" — so using it in a test is not a hole being opened for
 * convenience. `security/peer-uid.ts` states the same constraint at the
 * definition.
 */

import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveJsonlSocket, type SocketServer } from "../../src/run/registry.ts";
import { classifyPeer, ownUid, readPeerCred } from "../../src/security/peer-uid.ts";

const SECRET = "b".repeat(64);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

async function socketDir(): Promise<string> {
  // Short prefix on purpose: `sun_path` is 104 bytes on macOS and the run
  // directory layout already spends most of it (see run/paths.ts).
  const dir = await mkdtemp(join(tmpdir(), "pu-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Exchange {
  /** Response lines the server sent before closing, parsed. */
  lines: Array<Record<string, unknown>>;
  /** Whether the server closed the connection without being asked to. */
  closedByServer: boolean;
  connectError: string | null;
}

/** Connect, send one line, read until close or a short quiet period. */
async function exchange(path: string, msg: Record<string, unknown>): Promise<Exchange> {
  const lines: Array<Record<string, unknown>> = [];
  let closedByServer = false;
  let buf = "";
  let settle!: () => void;
  const done = new Promise<void>((r) => {
    settle = r;
  });
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          buf += chunk.toString();
          for (const line of buf.split("\n")) {
            const t = line.trim();
            if (t.length > 0) {
              try {
                lines.push(JSON.parse(t) as Record<string, unknown>);
              } catch {
                // Partial line; the next chunk completes it.
              }
            }
          }
          buf = buf.endsWith("\n") ? "" : (buf.split("\n").pop() ?? "");
        },
        close() {
          closedByServer = true;
          settle();
        },
        error() {
          settle();
        },
      },
    });
  } catch (err) {
    return { lines, closedByServer: false, connectError: String(err) };
  }
  socket.write(`${JSON.stringify(msg)}\n`);
  // Either the server closes us (the refusal path) or it answers and keeps the
  // connection open (the served path). A bounded wait covers both without
  // making the served case take the full timeout.
  const quiet = new Promise<void>((r) => setTimeout(r, 400));
  await Promise.race([done, quiet]);
  socket.end();
  return { lines, closedByServer, connectError: null };
}

// ---------------------------------------------------------------------------
// 1. The kernel answers, through the real FFI, on the real accepted descriptor
// ---------------------------------------------------------------------------

test("the kernel reports the peer's uid on a real accepted connection", async () => {
  const path = join(await socketDir(), "s.sock");
  let seen: ReturnType<typeof readPeerCred> | null = null;
  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        seen = readPeerCred((socket as unknown as { fd: number }).fd);
      },
      data() {},
      error() {},
    },
  });
  const client = await Bun.connect({ unix: path, socket: { data() {}, error() {} } });
  await Bun.sleep(120);
  client.end();
  server.stop(true);

  const result = seen as ReturnType<typeof readPeerCred> | null;
  expect(result).not.toBeNull();
  // This is the assertion that would have caught the `libc.so` mistake: on
  // Linux, `libc.${suffix}` is a linker script and dlopen fails, so a check
  // written the obvious way reports UNAVAILABLE on the only platform CI runs.
  // Requiring `ok` makes an unavailable check a RED test rather than a silently
  // permissive one.
  expect(result?.ok).toBe(true);
  if (result?.ok !== true) return;
  expect(result.cred.uid).toBe(ownUid() as number);
  expect(["getpeereid", "SO_PEERCRED"]).toContain(result.via);
});

// ---------------------------------------------------------------------------
// 2. The decision, on that same real descriptor
// ---------------------------------------------------------------------------

test("classifyPeer allows our own uid and denies any other, on a real fd", async () => {
  const path = join(await socketDir(), "s.sock");
  const mine = ownUid() as number;
  let match: ReturnType<typeof classifyPeer> | null = null;
  let other: ReturnType<typeof classifyPeer> | null = null;
  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        const fd = (socket as unknown as { fd: number }).fd;
        match = classifyPeer(fd, mine);
        // Same connection, same descriptor, same instant — the ONLY thing that
        // differs is the uid the gate is asked to accept. That is what makes
        // this a statement about the decision rather than about the harness.
        other = classifyPeer(fd, mine + 1);
      },
      data() {},
      error() {},
    },
  });
  const client = await Bun.connect({ unix: path, socket: { data() {}, error() {} } });
  await Bun.sleep(120);
  client.end();
  server.stop(true);

  expect(match).not.toBeNull();
  expect((match as unknown as { code: string }).code).toBe("peer_uid_match");
  expect((match as unknown as { allowed: boolean }).allowed).toBe(true);

  expect(other).not.toBeNull();
  expect((other as unknown as { code: string }).code).toBe("peer_uid_denied");
  expect((other as unknown as { allowed: boolean }).allowed).toBe(false);
  expect((other as unknown as { peerUid: number }).peerUid).toBe(mine);
  expect((other as unknown as { detail: string }).detail).toContain(String(mine + 1));
});

// ---------------------------------------------------------------------------
// 3. The wiring: serveJsonlSocket enforces the decision at accept
// ---------------------------------------------------------------------------

test("serveJsonlSocket refuses a peer whose uid is not the one it serves, before any verb runs", async () => {
  const path = join(await socketDir(), "s.sock");
  const mine = ownUid() as number;
  let handlerCalls = 0;
  const logged: string[] = [];
  const server: SocketServer = await serveJsonlSocket(
    path,
    async () => {
      handlerCalls += 1;
      return { ok: true, served: true };
    },
    { secret: SECRET },
    { expectUid: mine + 1, log: (l) => void logged.push(l) },
  );
  cleanups.push(() => server.stop());

  // The request is FULLY VALID — correct verb, correct secret. Everything that
  // could make it fail for another reason is right, so a refusal can only be
  // about the uid. This is also the assertion that shows the uid gate does not
  // depend on the token gate: ISC-126 exists precisely because control-auth.ts
  // was documented as the SECOND line behind a first line that did not exist.
  const result = await exchange(path, { cmd: "ping", auth: SECRET });

  expect(handlerCalls).toBe(0);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({
    ok: false,
    authenticated: false,
    code: "peer_uid_denied",
  });
  expect(String(result.lines[0]?.["error"])).toContain(String(mine));
  expect(result.closedByServer).toBe(true);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("closing the connection");
  expect(logged[0]).toContain(path);
});

test("the same server serves the uid it is configured for — the refusal is about uid, not the harness", async () => {
  const path = join(await socketDir(), "s.sock");
  let handlerCalls = 0;
  const logged: string[] = [];
  const server: SocketServer = await serveJsonlSocket(
    path,
    async () => {
      handlerCalls += 1;
      return { ok: true, served: true };
    },
    { secret: SECRET },
    // No expectUid: the production default, which is this process's own uid.
    { log: (l) => void logged.push(l) },
  );
  cleanups.push(() => server.stop());

  const result = await exchange(path, { cmd: "ping", auth: SECRET });

  expect(handlerCalls).toBe(1);
  expect(result.lines[0]).toMatchObject({ ok: true, served: true });
  // Nothing is logged on the happy path. A gate that narrates every accepted
  // connection is a gate whose refusals are invisible in the noise.
  expect(logged).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. SUPPORTING ONLY — the permission bits are code, not umask
// ---------------------------------------------------------------------------

test("the socket and its directory are 0700 even at umask 000 over a pre-existing wide directory (supporting evidence, not the criterion)", async () => {
  // The directory is created 0777 FIRST, and that detail is the whole test. An
  // earlier draft let `mkdtemp` supply it and asserted 0700 — and that
  // assertion was VACUOUS, proved so by mutation: deleting the `chmod` from
  // `serveJsonlSocket` left the test GREEN, because `mkdtemp` already returns
  // 0700 and `mkdir(..., { recursive: true })` does nothing whatsoever to a
  // directory that already exists.
  //
  // That is also the REAL case. The run directory is created before any socket
  // is served, so `mkdir`'s `mode` argument never applies to it in production
  // and the `chmod` is the only line that can tighten it. A test that never
  // presents an existing wide directory never tests the line that matters.
  const root = await socketDir();
  const dir = join(root, "sock");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o777);
  const path = join(dir, "s.sock");

  // ISC-126 measured the old code producing 0755/0755 at umask 022 and
  // 0777/0777 at umask 000, where another uid connects freely. Setting the
  // umask to 000 here is what makes this test about the CODE: under the old
  // implementation `Bun.listen` would inherit it and the socket would read 0777
  // below.
  const previous = process.umask(0o000);
  try {
    const server = await serveJsonlSocket(path, async () => ({ ok: true }), { secret: SECRET });
    cleanups.push(() => server.stop());
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  } finally {
    process.umask(previous);
  }
});
