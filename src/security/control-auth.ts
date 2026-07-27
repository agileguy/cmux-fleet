/**
 * Control-socket authentication (SRD §12.7).
 *
 * The sockets are filesystem-permission protected, which is sufficient against
 * another USER and insufficient against another PROCESS of the same user —
 * including a worker that escaped its container, the precise adversary Phase 3
 * exists to bound. Reaching the socket must not be the same thing as being
 * allowed to command it: every request must carry a per-run secret the caller
 * could only have learned by reading a 0600 file in the run directory.
 *
 * Three provenance rules, enforced here and nowhere else:
 *
 * 1. The secret comes from a CSPRNG. Never from the run id, the pid, or the
 *    clock — a worker can see all of those, and a derivable secret is no
 *    secret at all.
 * 2. The secret lives in exactly one file, mode 0600, created exclusively.
 *    Two processes racing to mint it must converge on ONE value; a server
 *    holding secret A while the file says B locks every client out.
 * 3. The secret never appears in a log line, a ledger record, an error
 *    message, or a socket response. A token in the supervisor log is the same
 *    failure as the credential it protects.
 */

import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ControlAuthSchema, type ControlAuth } from "../contracts.ts";
import type { RunPaths } from "../run/paths.ts";

/** Request field every socket verb must carry. */
export const AUTH_FIELD = "auth";

/** 256 bits from the CSPRNG, lowercase hex — the shape the seam's regex fixes. */
export function generateControlSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Mint a fresh `ControlAuth` record for a run. Validated against the seam. */
export function createControlAuth(runId: string, now: Date = new Date()): ControlAuth {
  return ControlAuthSchema.parse({
    schema: "pifleet.controlauth/v1",
    run_id: runId,
    secret: generateControlSecret(),
    created_at: now.toISOString(),
  });
}

/** A run whose auth record is missing or unreadable — not a socket failure. */
export class ControlAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlAuthError";
  }
}

/** Read the run's auth record, or null when none has been minted yet. */
export async function readControlAuth(run: RunPaths): Promise<ControlAuth | null> {
  const file = Bun.file(run.controlAuthJson);
  if (!(await file.exists())) return null;
  return ControlAuthSchema.parse(JSON.parse(await file.text()));
}

/**
 * Read the run's auth record, minting one if none exists.
 *
 * `up` calls this first, so in production it is the creator and everything
 * else a reader. The mint path also serves components that are separately
 * runnable — a restarted daemon, a supervisor launched directly by an
 * integration test — without each growing its own generation code.
 *
 * Creation is EXCLUSIVE: the record is written to a private temp file (mode
 * 0600 at open, so no window where the secret is world-readable) and then
 * `link(2)`ed to the final name, which is atomic and fails EEXIST if anyone
 * else won the race. The loser adopts the winner's secret by re-reading. A
 * tmp-and-rename here would be wrong twice over: rename clobbers, so two
 * racing minters would each keep serving their OWN secret while the file
 * holds the other's — and every client would then be refused by one of them.
 */
export async function ensureControlAuth(run: RunPaths): Promise<ControlAuth> {
  const existing = await readControlAuth(run);
  if (existing !== null) return existing;

  const auth = createControlAuth(run.runId);
  const path = run.controlAuthJson;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(auth, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    // Lost the race; the other minter's secret is THE secret now.
    const winner = await readControlAuth(run);
    if (winner === null) throw new ControlAuthError(`control auth vanished mid-mint for run ${run.runId}`);
    return winner;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return auth;
}

/** The run's secret, or a plain-spoken error when the run has none. */
export async function loadControlSecret(run: RunPaths): Promise<string> {
  const auth = await readControlAuth(run);
  if (auth === null) {
    throw new ControlAuthError(
      `no control-auth record for run ${run.runId} (expected ${run.controlAuthJson}); ` +
        `was this run created by 'pifleet up'?`,
    );
  }
  return auth.secret;
}

/**
 * Timing-safe secret comparison.
 *
 * `===` is wrong here: string equality bails at the first differing character,
 * so the response time measures how many leading characters matched — an
 * oracle that lets a caller on the same machine recover the secret one
 * character at a time. `timingSafeEqual` compares every byte unconditionally.
 *
 * It also DEMANDS equal-length inputs. The naive guard — return false early on
 * a length mismatch — reintroduces a (smaller) leak: the fast path tells the
 * caller the length is wrong. So the mismatch branch still performs a full
 * comparison of the expected secret against itself and discards the result;
 * both branches do the same work and both return through the same path.
 */
export function secretsEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Structured refusal — what an unauthenticated caller gets instead of a verb. */
export interface AuthRefusal extends Record<string, unknown> {
  ok: false;
  authenticated: false;
  code: "auth_missing" | "auth_invalid";
  error: string;
}

/**
 * Gate one request. Returns null when the token is right, a structured refusal
 * otherwise — never throws, because a caller who can crash the server by
 * sending garbage has a denial of service wearing an auth check.
 *
 * The two refusals are deliberately distinct: a missing token means an old or
 * miswired client and the error says so plainly; a wrong token means the
 * caller is guessing. Neither message echoes the token or the secret.
 */
export function checkAuth(msg: Record<string, unknown>, secret: string): AuthRefusal | null {
  const provided = msg[AUTH_FIELD];
  if (typeof provided !== "string" || provided.length === 0) {
    return {
      ok: false,
      authenticated: false,
      code: "auth_missing",
      error:
        "unauthenticated: request carries no 'auth' token; this run's control " +
        "sockets require the per-run secret from control-auth.json (an older " +
        "client that predates socket auth must be upgraded)",
    };
  }
  if (!secretsEqual(secret, provided)) {
    return {
      ok: false,
      authenticated: false,
      code: "auth_invalid",
      error: "unauthenticated: 'auth' token does not match this run's control secret",
    };
  }
  return null;
}
