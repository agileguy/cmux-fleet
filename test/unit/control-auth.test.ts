/**
 * Control-socket auth primitives (SRD §12.7).
 *
 * What lives here and not in integration: the comparator's truth table, the
 * secret's shape and provenance, the on-disk record's mode and exclusivity,
 * and the request gate's refusal taxonomy — everything provable without a
 * socket. The end-to-end facts (a live daemon refuses a wrong token on every
 * verb and survives it) live in test/integration/control-auth.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ControlAuthSchema, EXIT } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import { StateReadError } from "../../src/run/state.ts";
import {
  AUTH_FIELD,
  checkAuth,
  CONTROL_AUTH_SCHEMA,
  ControlAuthError,
  ControlAuthSchemaError,
  createControlAuth,
  ensureControlAuth,
  generateControlSecret,
  loadControlSecret,
  readControlAuth,
  secretsEqual,
} from "../../src/security/control-auth.ts";

describe("generateControlSecret", () => {
  test("is 256 bits of lowercase hex — the exact shape the seam's regex fixes", () => {
    const s = generateControlSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls never agree — a constant here is a skeleton key for every run", () => {
    expect(generateControlSecret()).not.toBe(generateControlSecret());
  });

  test("the secret is not derived from the run id", () => {
    // Same run id, two mints: derivation of any kind would make these equal,
    // and a worker that knows its own run id could then mint the token.
    const a = createControlAuth("r-fixed");
    const b = createControlAuth("r-fixed");
    expect(a.secret).not.toBe(b.secret);
  });

  test("createControlAuth output round-trips through the shared seam schema", () => {
    const auth = createControlAuth("r-1");
    expect(ControlAuthSchema.parse(auth)).toEqual(auth);
    expect(auth.run_id).toBe("r-1");
  });
});

describe("secretsEqual — the timing-safe comparator", () => {
  const secret = generateControlSecret();

  test("equal secrets compare equal", () => {
    expect(secretsEqual(secret, secret)).toBe(true);
  });

  test("unequal secrets of the same length compare unequal", () => {
    const other = secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0");
    expect(other).toHaveLength(secret.length);
    expect(secretsEqual(secret, other)).toBe(false);
  });

  test("length mismatch is a refusal, not a crash", () => {
    // timingSafeEqual throws on unequal lengths; the wrapper must absorb the
    // case, and must not absorb it by returning early.
    expect(secretsEqual(secret, secret.slice(0, 32))).toBe(false);
    expect(secretsEqual(secret, `${secret}00`)).toBe(false);
  });

  test("empty inputs", () => {
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual(secret, "")).toBe(false);
    expect(secretsEqual("", secret)).toBe(false);
  });
});

describe("checkAuth — the request gate", () => {
  const secret = generateControlSecret();

  test("a correct token passes", () => {
    expect(checkAuth({ cmd: "ping", [AUTH_FIELD]: secret }, secret)).toBeNull();
  });

  test("a missing token is refused, and the error says so plainly", () => {
    const refusal = checkAuth({ cmd: "ping" }, secret);
    expect(refusal).not.toBeNull();
    expect(refusal?.ok).toBe(false);
    expect(refusal?.code).toBe("auth_missing");
    // An old client must be able to read WHY it was refused (requirement 5).
    expect(refusal?.error).toContain("auth");
    expect(refusal?.error).toContain("upgraded");
  });

  test("a non-string or empty token is a missing token, not a comparison", () => {
    expect(checkAuth({ cmd: "ping", [AUTH_FIELD]: 42 }, secret)?.code).toBe("auth_missing");
    expect(checkAuth({ cmd: "ping", [AUTH_FIELD]: "" }, secret)?.code).toBe("auth_missing");
  });

  test("a wrong token is refused with a distinct code", () => {
    const refusal = checkAuth({ cmd: "ping", [AUTH_FIELD]: generateControlSecret() }, secret);
    expect(refusal?.code).toBe("auth_invalid");
  });

  test("no refusal ever echoes the secret or the offered token", () => {
    const offered = generateControlSecret();
    for (const refusal of [
      checkAuth({ cmd: "ping" }, secret),
      checkAuth({ cmd: "ping", [AUTH_FIELD]: offered }, secret),
    ]) {
      const body = JSON.stringify(refusal);
      expect(body).not.toContain(secret);
      expect(body).not.toContain(offered);
    }
  });
});

describe("the on-disk record", () => {
  async function scratchRun() {
    const root = await mkdtemp(join(tmpdir(), "pifleet-auth-"));
    // Unique run id per invocation: socketPath is not in play here, but the
    // habit is load-bearing everywhere else in this suite.
    const run = runPaths(`r-auth-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`, root);
    return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  test("ensureControlAuth mints once, mode 0600, and later calls read the same secret", async () => {
    const { run, cleanup } = await scratchRun();
    try {
      const first = await ensureControlAuth(run);
      expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(first.run_id).toBe(run.runId);

      // Owner-only: the whole point is that ANOTHER user's processes cannot
      // read it, and group/world bits would hand the token to them.
      const mode = (await stat(run.controlAuthJson)).mode & 0o777;
      expect(mode).toBe(0o600);

      const second = await ensureControlAuth(run);
      expect(second.secret).toBe(first.secret);
      expect(await loadControlSecret(run)).toBe(first.secret);
    } finally {
      await cleanup();
    }
  });

  test("concurrent mints converge on ONE secret", async () => {
    // Two components racing to create the record — `up` and a directly
    // launched supervisor, or two supervisors in a test — must not each end
    // up serving a different token. link(2) exclusivity picks one winner and
    // the loser adopts.
    const { run, cleanup } = await scratchRun();
    try {
      const [a, b] = await Promise.all([ensureControlAuth(run), ensureControlAuth(run)]);
      expect(a.secret).toBe(b.secret);
      expect(await loadControlSecret(run)).toBe(a.secret);
    } finally {
      await cleanup();
    }
  });

  test("a run with no record: read gives null, load refuses by name", async () => {
    const { run, cleanup } = await scratchRun();
    try {
      expect(await readControlAuth(run)).toBeNull();
      await expect(loadControlSecret(run)).rejects.toThrow(ControlAuthError);
      await expect(loadControlSecret(run)).rejects.toThrow(run.runId);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The durable-format half (ISC-192), and the reason it is three answers.
 *
 * `readControlAuth` used to be one line — `ControlAuthSchema.parse(JSON.parse(
 * await file.text()))` — which answered every non-absent failure with whatever
 * the library threw. That is not a diagnosis: a `ZodError`'s `message` is a
 * pretty-printed JSON array whose first line is the bare character `[`, it
 * carries no `exitCode`, so `contracts.ts`'s diagnosed-failure protocol does
 * not recognise it, and the CLI renders it as a stack trace on exit 1 — a code
 * that is not on the §10 ladder at all.
 *
 * The cases are kept apart because they are answered differently. A file
 * stamped by another build is fixed by running a different binary; a truncated
 * file is fixed by looking at the disk. `loadControlSecret` sits on `up`, the
 * daemon and every supervisor launch, so this is a message read while a run is
 * already in trouble.
 *
 * NEGATIVE FIRST. `rejects.toThrow()` alone would pass against the bare
 * `ZodError` this change removes, so it pins nothing. Every case below asserts
 * what the error is NOT before asserting what it is.
 */
describe("control-auth.json this build cannot read (ISC-192)", () => {
  async function runWithBody(tag: string, body: string) {
    const root = await mkdtemp(join(tmpdir(), `pifleet-authfmt-${tag}-`));
    const run = runPaths(`r-fmt-${tag}`, root);
    await mkdir(dirname(run.controlAuthJson), { recursive: true });
    await writeFile(run.controlAuthJson, body, "utf8");
    return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  /**
   * A reader that RETURNS on an unreadable file is the conflation this suite
   * exists to catch, so "threw nothing" must not be reported as "threw the
   * wrong thing" — it gets its own sentence.
   */
  const NOTHING_THROWN = Symbol("nothing thrown");
  async function refusalFrom(read: () => Promise<unknown>): Promise<Error> {
    let returned: unknown = NOTHING_THROWN;
    try {
      returned = await read();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      return err as Error;
    }
    throw new Error(
      `expected a refusal, but the reader RETURNED ${JSON.stringify(returned) ?? String(returned)} — ` +
        `answering an unreadable control-auth record with a value is the defect, not the fix`,
    );
  }

  /** No reader may hand a caller a raw library error, whatever else it does. */
  function notBareLibraryError(err: Error, what: string): void {
    if (err instanceof z.ZodError || err.name === "ZodError") {
      throw new Error(`${what} leaked a bare ZodError — the wrapper is gone. message: ${err.message}`);
    }
    if (err instanceof SyntaxError || err.name === "SyntaxError") {
      throw new Error(`${what} leaked a bare SyntaxError — the wrapper is gone. message: ${err.message}`);
    }
    // The diagnosed-failure protocol is structural: a numeric `exitCode` is
    // what stops the CLI rendering this as a stack trace on exit 1.
    expect((err as { exitCode?: unknown }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  }

  test("an unrecognised stamp is its OWN answer, and names found, expected and the hatch", async () => {
    const { run, cleanup } = await runWithBody(
      "v2",
      JSON.stringify({
        schema: "pifleet.controlauth/v2",
        run_id: "r-fmt-v2",
        secret: "a".repeat(64),
        created_at: new Date().toISOString(),
      }),
    );
    try {
      const err = await refusalFrom(() => readControlAuth(run));
      notBareLibraryError(err, "readControlAuth on a v2 stamp");
      expect(err).toBeInstanceOf(ControlAuthSchemaError);
      // Found, expected, and the escape — the three things `down.ts`'s
      // `identity_legacy_format` message carries, for the same reason.
      expect(err.message).toContain("pifleet.controlauth/v2");
      expect(err.message).toContain(CONTROL_AUTH_SCHEMA);
      expect(err.message).toContain("the build that created it");
      expect(err.message).toContain(run.controlAuthJson);
    } finally {
      await cleanup();
    }
  });

  test("a stamp is 'unrecognised' even when absent — a body with no stamp names that too", async () => {
    // An older build that predates stamping and a hand-edited file arrive
    // here identically, and both mean "not written by a build this one can
    // read". Reporting it as damage would send the operator to the disk.
    const { run, cleanup } = await runWithBody("nostamp", JSON.stringify({ run_id: "x", secret: "b".repeat(64) }));
    try {
      const err = await refusalFrom(() => readControlAuth(run));
      notBareLibraryError(err, "readControlAuth on an unstamped body");
      expect(err).toBeInstanceOf(ControlAuthSchemaError);
      expect(err.message).toContain("<no schema field>");
    } finally {
      await cleanup();
    }
  });

  test("a truncated file is DAMAGE, not a version skew — a different answer entirely", async () => {
    const { run, cleanup } = await runWithBody("trunc", '{"schema":"pifleet.controlauth/v1","run_id":');
    try {
      const err = await refusalFrom(() => readControlAuth(run));
      notBareLibraryError(err, "readControlAuth on a truncated file");
      expect(err).toBeInstanceOf(StateReadError);
      expect(err).not.toBeInstanceOf(ControlAuthSchemaError);
      // The byte count is the diagnostic: this file is written to a private
      // tmp and link(2)ed into place, so a short read means a premise is
      // wrong rather than that someone typed badly.
      expect(err.message).toContain("bytes on disk");
    } finally {
      await cleanup();
    }
  });

  test("the RIGHT stamp with a wrong field is damage too, and the message names the field", async () => {
    // The stamp says this build owns the document, so a failing field is a
    // real complaint about a document we understand — not a version skew.
    const { run, cleanup } = await runWithBody(
      "badsecret",
      JSON.stringify({
        schema: CONTROL_AUTH_SCHEMA,
        run_id: "r-fmt-badsecret",
        secret: "not-hex",
        created_at: new Date().toISOString(),
      }),
    );
    try {
      const err = await refusalFrom(() => readControlAuth(run));
      notBareLibraryError(err, "readControlAuth on a bad secret field");
      expect(err).toBeInstanceOf(StateReadError);
      // The field path is the whole diagnostic value — a ZodError's own
      // message would print `[` here.
      expect(err.message).toContain("secret");
      expect(err.message).not.toStartWith("[");
    } finally {
      await cleanup();
    }
  });

  test("loadControlSecret propagates the diagnosis rather than flattening it", async () => {
    // `loadControlSecret` is what `up`, the daemon and every supervisor call.
    // Its own `ControlAuthError` is for ABSENCE, and collapsing a version skew
    // into "was this run created by 'pifleet up'?" would send an operator to
    // re-create a run that exists.
    const { run, cleanup } = await runWithBody(
      "load",
      JSON.stringify({ schema: "pifleet.controlauth/v0", run_id: "x", secret: "c".repeat(64) }),
    );
    try {
      const err = await refusalFrom(() => loadControlSecret(run));
      expect(err).toBeInstanceOf(ControlAuthSchemaError);
      expect(err).not.toBeInstanceOf(ControlAuthError);
    } finally {
      await cleanup();
    }
  });

  test("the constant a refusal NAMES and the literal a parse COMPARES stay paired", async () => {
    // `CONTROL_AUTH_SCHEMA` is restated rather than read off the zod object,
    // so nothing but this test keeps the message honest if the schema moves.
    expect(createControlAuth("r-pair").schema).toBe(CONTROL_AUTH_SCHEMA);
    expect(() => ControlAuthSchema.parse({ ...createControlAuth("r-pair"), schema: "other" })).toThrow();
  });
});
