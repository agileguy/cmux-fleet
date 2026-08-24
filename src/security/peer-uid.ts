/**
 * Peer credentials on a unix socket, and the accept-time uid gate built on
 * them (ISC-126).
 *
 * ## What this module exists to replace
 *
 * Before it, the control socket's protection against ANOTHER USER was not a
 * control at all — it was a side effect of the operator's shell. `run/registry.
 * ts` created the socket directory with `mkdir(..., { recursive: true })` and
 * no mode, and `Bun.listen({ unix: path })` with no subsequent `chmod`, so both
 * the socket and its directory inherited the ambient umask. Measured on the
 * maintainer's machine at umask 022: socket 0755, directory 0755. Another uid
 * could not WRITE the socket, and `connect(2)` to a unix socket requires write
 * permission, so another uid was in fact refused — with EACCES from the KERNEL,
 * on the strength of a number the operator's shell chooses.
 *
 * That protection INVERTS. Run the daemon from a shell at `umask 000` and the
 * same code produces a 0777 socket in a 0777 directory, and another uid
 * connects successfully. `security/control-auth.ts` then becomes the only thing
 * standing between that uid and the verbs — the layer whose own header calls
 * itself the SECOND line, on the stated basis that "the sockets are filesystem-
 * permission protected, which is sufficient against another USER". So the
 * token's threat model rested on a property nothing established, nothing
 * asserted, and one `umask` call could silently revoke.
 *
 * Two things fix that, and both are needed:
 *
 *   1. `registry.ts` now chmods the socket directory and the socket to 0700
 *      EXPLICITLY, so the filesystem gate is code rather than umask. `mkdir`'s
 *      `mode` option is not sufficient on its own for two reasons: it is masked
 *      by the umask on the way through, and it does nothing at all when the
 *      directory already exists — which is the common case, since the run
 *      directory is created before the daemon starts.
 *   2. This module, which asks the KERNEL who is on the other end of an
 *      accepted connection and refuses when it is not us. That one does not
 *      care what the permission bits say, so it holds even if a future change,
 *      an operator, or an installer widens them again.
 *
 * Belt and braces is deliberate. The permission bits are the cheaper gate and
 * they stop the connection before it is ever accepted; the credential check is
 * the one that cannot be undone from outside the process.
 *
 * ## The mechanism, measured rather than assumed
 *
 * There is no portable POSIX call for this, so it is two calls behind one
 * interface, chosen by platform. Both were measured on 2026-08-24 rather than
 * taken from documentation, because every one of the following facts is a
 * thing a reasonable person would have guessed wrong:
 *
 *   - `Bun.listen`'s socket object exposes `fd`, and in the `open` handler it
 *     is the ACCEPTED CONNECTION's descriptor, not the listener's. Probed on
 *     both platforms: fd 6 on macOS, fd 13 in a Linux container, and
 *     `getpeereid`/`SO_PEERCRED` on it returned the connecting process's uid
 *     both times. Nothing in Bun's typings says this; the property is not in
 *     the public `Socket` type, which is why the read below goes through a
 *     narrow cast with its own explanation.
 *   - macOS (bun 1.3.11, darwin arm64): `dlopen("libc.dylib")` resolves and
 *     `getpeereid(fd, &uid, &gid)` returns 0 with uid 501, matching
 *     `process.getuid()`.
 *   - Linux (bun 1.3.12, Debian bookworm/glibc, arm64):
 *     `dlopen("libc.so")` FAILS — `libc.so` is a linker script on glibc, not a
 *     shared object, and the error is "cannot open shared object". `libc.so.6`
 *     is the name that works. Since `bun:ffi`'s `suffix` is `so` on Linux, the
 *     obvious `libc.${suffix}` spelling is the one that does NOT work there,
 *     and works on macOS, which is exactly how this would have shipped broken
 *     on the only platform CI runs.
 *   - glibc does NOT export `getpeereid` at all — measured, not inferred:
 *     `dlopen("libc.so.6", { getpeereid })` throws `Symbol "getpeereid" not
 *     found`. It is a BSD function. musl DOES export it, which is why it stays
 *     in the fallback chain rather than being made darwin-only.
 *   - `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &ucred, &len)` on Linux returns
 *     0 with `optlen` 12 and `{ pid: 1, uid: 0, gid: 0 }` for a peer running as
 *     root inside a container — matching `process.getuid()` there.
 *
 * SOL_SOCKET (1) and SO_PEERCRED (17) are the asm-generic values, correct on
 * x86_64 and aarch64 — the two architectures this project runs on. They differ
 * on alpha, mips, parisc and sparc. The code does not detect the architecture
 * and does not need to: a wrong optname makes `getsockopt` return non-zero, and
 * a non-zero return is reported as UNAVAILABLE rather than as an answer. The
 * failure mode of being wrong here is a lost check that says so, never a uid
 * invented from an uninitialised buffer.
 *
 * ## Why an unavailable check FAILS OPEN, said plainly
 *
 * If neither call can be made — an unsupported platform, an exotic libc, a
 * `bun:ffi` that cannot dlopen — `classifyPeer` returns `peer_uid_unavailable`
 * and ALLOWS the connection, after saying so. That is a deliberate trade and it
 * is the weaker half of this module, so it is stated here rather than buried:
 *
 *   - Failing CLOSED would refuse EVERY connection, including the daemon's own
 *     legitimate clients, on any platform where the FFI hiccups. That is a
 *     self-inflicted denial of service with no operator workaround, and it
 *     converts a defence-in-depth layer into a single point of failure.
 *   - Failing open is not failing to nothing. The 0700 directory is set by code
 *     in the same commit and does not depend on this module working, so on an
 *     exotic platform the criterion still holds by the filesystem gate — which
 *     is where it stood before, minus the umask dependency.
 *   - Both platforms pifleet actually supports are MEASURED above to have a
 *     working check. The fail-open branch is for platforms this project does
 *     not run on, and if it ever fires on one that it does, the log line names
 *     the reason instead of leaving a silent hole.
 *
 * ## What a uid check does not do
 *
 * It does not stop another PROCESS OF THE SAME USER — including a worker that
 * escaped its container, which is the adversary Phase 3 is about. That is
 * precisely the gap `security/control-auth.ts` exists to close, and this module
 * does not reduce its importance by one bit. It closes the OTHER half, the one
 * control-auth's header assumed was already handled. Nor does it stop root:
 * root passes any filesystem check and can read the secret out of the run
 * directory anyway, so no socket-level control is meaningful against it.
 */

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

/** `SOL_SOCKET` on Linux (asm-generic). See the header on architecture scope. */
const SOL_SOCKET = 1;
/** `SO_PEERCRED` on Linux (asm-generic). See the header on architecture scope. */
const SO_PEERCRED = 17;
/** `struct ucred` is three 32-bit fields: pid, uid, gid. */
const UCRED_BYTES = 12;

/**
 * libc names tried in order, first one that dlopens wins.
 *
 * `libc.${suffix}` is FIRST because it is the one that works on macOS, and
 * LAST-resort on Linux where it is a linker script — see the header. The musl
 * names are spelled out because musl has no `libc.so.6` and its soname carries
 * the architecture.
 */
const LIBC_CANDIDATES = [
  `libc.${suffix}`,
  "libc.so.6",
  "libc.musl-x86_64.so.1",
  "libc.musl-aarch64.so.1",
  "libc.musl-armhf.so.1",
] as const;

type PeerCredSymbols = {
  getpeereid?: (fd: number, uid: number, gid: number) => number;
  getsockopt?: (fd: number, level: number, name: number, val: number, len: number) => number;
};

interface LoadedLibc {
  readonly symbols: PeerCredSymbols;
  readonly libName: string;
  readonly has: { getpeereid: boolean; getsockopt: boolean };
}

/**
 * Resolution is LAZY and CACHED, and the cache holds failures too.
 *
 * Lazy because importing this module must never be able to crash a process
 * that is not about to accept a connection — `registry.ts` is imported by the
 * CLI, by tests, and transitively by a good deal else, and a module that
 * dlopens at import time turns "this platform has an odd libc" into "pifleet
 * does not start". Cached because the answer cannot change within a process
 * and each accept would otherwise pay a dlopen.
 */
let libcCache: LoadedLibc | null | undefined;

function loadLibc(): LoadedLibc | null {
  if (libcCache !== undefined) return libcCache;
  libcCache = null;
  for (const libName of LIBC_CANDIDATES) {
    // The two symbols are dlopened SEPARATELY on purpose. `dlopen` throws when
    // ANY requested symbol is missing, so asking for both at once would make a
    // glibc — which has `getsockopt` but not `getpeereid` — look like a libc
    // with neither, and the Linux path would silently never be reached.
    let getpeereid: PeerCredSymbols["getpeereid"];
    let getsockopt: PeerCredSymbols["getsockopt"];
    try {
      const lib = dlopen(libName, {
        getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      getpeereid = lib.symbols.getpeereid as unknown as PeerCredSymbols["getpeereid"];
    } catch {
      // Absent on glibc. Expected, not exceptional.
    }
    try {
      const lib = dlopen(libName, {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      });
      getsockopt = lib.symbols.getsockopt as unknown as PeerCredSymbols["getsockopt"];
    } catch {
      // Should not happen on any POSIX libc, but a missing symbol is a reason
      // to try the next candidate rather than to throw.
    }
    if (getpeereid === undefined && getsockopt === undefined) continue;
    libcCache = {
      symbols: { getpeereid, getsockopt },
      libName,
      has: { getpeereid: getpeereid !== undefined, getsockopt: getsockopt !== undefined },
    };
    return libcCache;
  }
  return libcCache;
}

/** Credentials of the process on the other end of an accepted connection. */
export interface PeerCred {
  uid: number;
  gid: number;
  /** Only `SO_PEERCRED` reports it; `getpeereid` does not. */
  pid: number | null;
}

export type PeerCredResult =
  | { ok: true; cred: PeerCred; via: "getpeereid" | "SO_PEERCRED"; libName: string }
  | { ok: false; reason: string };

/**
 * Ask the kernel who is on the other end of `fd`.
 *
 * `fd` must be an ACCEPTED connection, not a listener. Passing a listener is
 * not a silent wrong answer: `getpeereid` and `SO_PEERCRED` both fail on an
 * unconnected socket, and a failure is reported as `ok: false`.
 *
 * Never throws. Every failure — no libc, no symbol, a non-zero syscall return —
 * comes back as a reason string, because the only caller is an accept handler
 * and a throw there would take down the server that is supposed to be refusing
 * one connection.
 */
export function readPeerCred(fd: number): PeerCredResult {
  if (!Number.isInteger(fd) || fd < 0) {
    return { ok: false, reason: `not a file descriptor: ${String(fd)}` };
  }
  const libc = loadLibc();
  if (libc === null) {
    return {
      ok: false,
      reason: `no libc could be opened for peer-credential lookup (tried ${LIBC_CANDIDATES.join(", ")})`,
    };
  }

  // getpeereid FIRST: it is the BSD/macOS call and also musl's, it answers in
  // one shot, and it needs no per-architecture constants. glibc does not have
  // it, which is why SO_PEERCRED follows rather than replaces it.
  const { getpeereid, getsockopt } = libc.symbols;
  if (getpeereid !== undefined) {
    const uidBuf = new Uint32Array(1);
    const gidBuf = new Uint32Array(1);
    const rc = getpeereid(fd, ptr(uidBuf), ptr(gidBuf));
    if (rc === 0) {
      return {
        ok: true,
        cred: { uid: uidBuf[0] as number, gid: gidBuf[0] as number, pid: null },
        via: "getpeereid",
        libName: libc.libName,
      };
    }
  }

  if (getsockopt !== undefined) {
    const cred = new Uint32Array(3);
    // `optlen` is IN-OUT: the kernel reads the buffer size from it and writes
    // back how many bytes it filled. It is checked on the way out, because a
    // short write would mean the struct is not the one assumed here and the
    // uid field would be read from the wrong offset.
    const optlen = new Uint32Array([UCRED_BYTES]);
    const rc = getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(optlen));
    if (rc === 0 && optlen[0] === UCRED_BYTES) {
      return {
        ok: true,
        cred: { pid: cred[0] as number, uid: cred[1] as number, gid: cred[2] as number },
        via: "SO_PEERCRED",
        libName: libc.libName,
      };
    }
    return {
      ok: false,
      reason:
        `getsockopt(SO_PEERCRED) returned ${rc} with optlen ${String(optlen[0])} ` +
        `(expected 0 and ${UCRED_BYTES}) on ${process.platform}/${process.arch} via ${libc.libName}`,
    };
  }

  return {
    ok: false,
    reason: `${libc.libName} exports neither getpeereid nor a usable getsockopt`,
  };
}

/** The three outcomes of the accept-time gate. */
export type PeerVerdictCode = "peer_uid_match" | "peer_uid_denied" | "peer_uid_unavailable";

export interface PeerVerdict {
  /** False ONLY for `peer_uid_denied`. `peer_uid_unavailable` allows — see the header. */
  allowed: boolean;
  code: PeerVerdictCode;
  /** The uid the kernel reported, or null when it could not be read. */
  peerUid: number | null;
  /** Operator-facing sentence. Never contains a secret; there is none in scope here. */
  detail: string;
}

/**
 * This process's own uid, or null on a platform where there is no such thing.
 *
 * Separate from `classifyPeer` so the default can be read, logged and asserted
 * without accepting a connection first.
 */
export function ownUid(): number | null {
  const get = process.getuid;
  return typeof get === "function" ? get.call(process) : null;
}

/**
 * Decide whether the peer on `fd` may command this socket.
 *
 * `expectedUid` is the ONLY uid allowed through. It is a plain number and there
 * is deliberately no value meaning "skip the check": every value narrows the
 * gate to exactly one uid, so a caller cannot disable this by passing anything.
 * `registry.ts` passes `ownUid()` and exposes an override solely so a test can
 * point the gate at a uid the connecting process does not have, which is how
 * the refusal path is exercised on a machine with only one uid available.
 *
 * Passing `null` for `expectedUid` means the platform could not report our own
 * uid, which is the same unavailability case as a failed credential read and is
 * treated identically.
 */
export function classifyPeer(fd: number, expectedUid: number | null): PeerVerdict {
  if (expectedUid === null) {
    return {
      allowed: true,
      code: "peer_uid_unavailable",
      peerUid: null,
      detail:
        "peer uid not checked: this platform does not report the server's own uid " +
        "(process.getuid is unavailable), so there is nothing to compare against",
    };
  }
  const read = readPeerCred(fd);
  if (!read.ok) {
    return {
      allowed: true,
      code: "peer_uid_unavailable",
      peerUid: null,
      detail: `peer uid not checked: ${read.reason}`,
    };
  }
  if (read.cred.uid === expectedUid) {
    return {
      allowed: true,
      code: "peer_uid_match",
      peerUid: read.cred.uid,
      detail: `peer uid ${read.cred.uid} matches this process (via ${read.via})`,
    };
  }
  return {
    allowed: false,
    code: "peer_uid_denied",
    peerUid: read.cred.uid,
    detail:
      `refused: connecting process runs as uid ${read.cred.uid}, this control socket ` +
      `only serves uid ${expectedUid} (via ${read.via})`,
  };
}

/** Structured refusal a denied peer receives before the connection is closed. */
export interface PeerRefusal extends Record<string, unknown> {
  ok: false;
  authenticated: false;
  code: "peer_uid_denied";
  error: string;
}

/**
 * The refusal line written to a denied peer.
 *
 * A denied peer is ANSWERED and then disconnected rather than silently dropped,
 * for the same reason `checkAuth` answers rather than crashes: a silent drop is
 * indistinguishable from a hang, and the operator debugging it at 3am is far
 * more often a misconfigured client of their own than an intruder. It discloses
 * nothing the peer did not already know — they connected, so a socket is
 * plainly there — and it carries no secret, because the token is never in scope
 * on this path: the gate runs at ACCEPT, before a single byte has been read.
 */
export function peerRefusal(verdict: PeerVerdict): PeerRefusal {
  return {
    ok: false,
    authenticated: false,
    code: "peer_uid_denied",
    error: `unauthorized: ${verdict.detail}`,
  };
}
