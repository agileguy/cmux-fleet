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
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlAuthSchema } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import {
  AUTH_FIELD,
  checkAuth,
  ControlAuthError,
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
