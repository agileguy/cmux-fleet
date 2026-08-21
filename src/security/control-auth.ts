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
import { ControlAuthSchema, EXIT, type ControlAuth } from "../contracts.ts";
import type { RunPaths } from "../run/paths.ts";
import { StateReadError } from "../run/state.ts";

/** Request field every socket verb must carry. */
export const AUTH_FIELD = "auth";

/**
 * The stamp this build writes into `control-auth.json` and the only one it
 * reads back (ISC-192).
 *
 * Restated as a value rather than read off `ControlAuthSchema`, because the
 * schema's literal is what a `parse` COMPARES against and this constant is
 * what a refusal NAMES. Reading it out of the zod object would make the
 * operator-facing message depend on zod's internal shape, which is a library
 * detail; the message an operator reads at 3am should not be one refactor of a
 * dependency away from saying `undefined`. The pairing is pinned by a test
 * rather than by construction, which is the same trade `attended/mode.ts` and
 * `report/collect.ts` make for their stamps.
 */
export const CONTROL_AUTH_SCHEMA = "pifleet.controlauth/v1";

/** 256 bits from the CSPRNG, lowercase hex — the shape the seam's regex fixes. */
export function generateControlSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Mint a fresh `ControlAuth` record for a run. Validated against the seam. */
export function createControlAuth(runId: string, now: Date = new Date()): ControlAuth {
  return ControlAuthSchema.parse({
    schema: CONTROL_AUTH_SCHEMA,
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

/**
 * A `control-auth.json` this build cannot READ because another build wrote it
 * (ISC-192) — as opposed to one this build cannot read because it is damaged.
 *
 * REFUSE BY DESIGN, NAMED, WITH A HATCH. This is `down.ts`'s
 * `identity_legacy_format` argument applied to a durable file instead of to a
 * recorded process identity, and it is the same argument for the same reason:
 * an unrecognised stamp and a corrupt file are different statements about the
 * world, and an operator told the wrong one goes and does the wrong thing. A
 * `ZodError` reading `invalid_literal at schema` says neither — it says a
 * library was unhappy, in a message whose first line is the bare character
 * `[`, and it says it identically for a truncated file.
 *
 * NO UPGRADER, and that is the decision rather than an omission. There is no
 * `v0 → v1` ladder here and none is planned: a control secret is minted per
 * run and held IN MEMORY by whatever daemon and supervisors are already
 * serving that run, so rewriting the file to this build's stamp would not
 * change the value they are comparing against. Re-minting is worse still — it
 * produces a secret NOBODY running holds, which locks every client out of a
 * live run rather than recovering it. A record this build cannot read is
 * therefore a run this build cannot drive, and saying so is the whole of the
 * honest answer.
 *
 * THE HATCH is consequently not a flag on this command: it is the build that
 * created the run. That is named in the message because a refusal an operator
 * cannot act on trains them to reach past it, which is exactly the reflex
 * `down.ts` refuses to train on `--force-identity`.
 *
 * `exitCode` matches `StateReadError` and `RunPolicyUnreadableError`:
 * control-plane state this build cannot read is an environment failure, not a
 * usage error, and §10's ladder has one code for that.
 */
export class ControlAuthSchemaError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly path: string,
    readonly found: string,
  ) {
    super(
      `${path} is stamped ${found}, but this build reads ${JSON.stringify(CONTROL_AUTH_SCHEMA)}; ` +
        `a run's control secret cannot be re-stamped or re-minted while its sockets are live — ` +
        `the daemon and supervisors already serving this run hold the old value in memory — ` +
        `so drive this run with the build that created it, or start a fresh run with this one`,
    );
    this.name = "ControlAuthSchemaError";
  }
}

/**
 * Read the run's auth record, or null when none has been minted yet.
 *
 * THREE ANSWERS, NOT TWO (ISC-192). `null` is absence and a legitimate state —
 * `ensureControlAuth` mints on exactly that. The other two are failures, and
 * they are kept apart because they call for different actions:
 * `ControlAuthSchemaError` says another build wrote this file, and
 * `StateReadError` says this file is damaged. One is answered by changing
 * which binary you run; the other is answered by looking at the disk.
 *
 * The stamp is checked BEFORE the schema, and the order is load-bearing. A
 * future `pifleet.controlauth/v2` that renames or drops a field fails
 * `ControlAuthSchema` on that field, and zod reports whichever issue it
 * reaches first — so a stamp check that ran second would diagnose a
 * version skew as a missing `created_at`, which is true about the bytes and
 * useless about the cause.
 *
 * `StateReadError` rather than a fourth error class of this module's own: it
 * already summarises a `ZodError`'s issues into one readable line (its own
 * docstring explains why the raw message cannot be used), it already carries
 * the §10 exit code, and a second vocabulary for "this file is damaged" would
 * be two names for one fact.
 */
export async function readControlAuth(run: RunPaths): Promise<ControlAuth | null> {
  const path = run.controlAuthJson;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    // Carry the size, for the reason `readValidated` carries the bytes: this
    // file is written to a private tmp and `link(2)`ed into place, so a
    // reader should never see a partial one, and a truncation here means a
    // premise is wrong rather than that someone typed badly.
    throw new StateReadError(path, `${String(err)} — ${text.length} bytes on disk`);
  }

  const stamp = (doc as { schema?: unknown } | null)?.schema;
  if (stamp !== CONTROL_AUTH_SCHEMA) {
    throw new ControlAuthSchemaError(
      path,
      typeof stamp === "string" ? JSON.stringify(stamp) : stamp === undefined ? "<no schema field>" : String(stamp),
    );
  }

  try {
    return ControlAuthSchema.parse(doc);
  } catch (err) {
    throw new StateReadError(path, err);
  }
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
