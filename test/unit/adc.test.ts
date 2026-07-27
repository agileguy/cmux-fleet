/**
 * security/adc.ts — minting, materials, verification, and the durable record.
 *
 * The assertions that matter most are the NEGATIVE ones: the token value must
 * not appear in the record, in argv, or in an error message, and
 * `refresh_token_absent` must be false when a refresh token IS present. Each
 * was verified to fail against a deliberately broken implementation before
 * being trusted (mutations listed per test).
 */

import { describe, expect, test } from "bun:test";
import type { Exec, ExecOptions, ExecResult } from "../../src/container/run.ts";
import {
  ADC_FILE_PATH,
  InjectError,
  MintError,
  TOKEN_FILE,
  describeCredentialPlan,
  fileModeMaterials,
  gcloudMinter,
  injectArgv,
  injectToken,
  mintArgv,
  planCredential,
  proveRefreshTokenAbsent,
  recordInjection,
  resolveIdentity,
  tokenModeMaterials,
  tokenModeStartupEnv,
} from "../../src/security/adc.ts";

const TOKEN = "ya29.fake-access-token-value-a1b2c3";

/** An Exec that records every call and replays canned results. */
function fakeExec(results: Partial<ExecResult>[] = []): {
  exec: Exec;
  calls: { argv: string[]; opts: ExecOptions | undefined }[];
} {
  const calls: { argv: string[]; opts: ExecOptions | undefined }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, opts });
    const r = results.shift() ?? {};
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...r };
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

describe("minting is argv arrays against the host ADC", () => {
  // Mutation check: joining mintArgv into a single shell string fails the
  // array-shape assertion; dropping `application-default` fails the pin.
  test("mintArgv pins the exact gcloud invocation", () => {
    expect(mintArgv(null)).toEqual([
      "gcloud",
      "auth",
      "application-default",
      "print-access-token",
    ]);
  });

  test("impersonation is a single --flag=value token, no shell parsing", () => {
    const argv = mintArgv("deploy@proj.iam.gserviceaccount.com");
    expect(argv).toContain(
      "--impersonate-service-account=deploy@proj.iam.gserviceaccount.com",
    );
    // Every element is one argv token; none is a composed shell string.
    for (const a of argv) expect(a).not.toMatch(/[|;&<>]/);
  });

  test("a successful mint returns the trimmed token and the caller's identity", async () => {
    const { exec, calls } = fakeExec([{ stdout: `${TOKEN}\n` }]);
    const mint = gcloudMinter(exec, { impersonateServiceAccount: null, identity: "dan@x.com" });
    const minted = await mint();
    expect(minted.token).toBe(TOKEN);
    expect(minted.identity).toBe("dan@x.com");
    expect(calls[0]!.argv[0]).toBe("gcloud");
  });

  /**
   * Mutation check: catching the failure inside gcloudMinter and returning an
   * empty token turns this red. A swallowed mint failure becomes a worker
   * that silently loses cloud access — the exact §12.4 failure.
   */
  test("a failed mint throws a named error carrying stderr, not the token", async () => {
    const { exec } = fakeExec([
      { code: 1, stdout: TOKEN, stderr: "ERROR: reauth required" },
    ]);
    const mint = gcloudMinter(exec, { impersonateServiceAccount: null, identity: "dan@x.com" });
    const err = await mint().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MintError);
    expect((err as Error).message).toContain("reauth required");
    // The failed stdout may hold a partial token; it must not reach the log.
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("an empty token is a mint failure, not a blank credential", async () => {
    const { exec } = fakeExec([{ stdout: "\n" }]);
    const mint = gcloudMinter(exec, { impersonateServiceAccount: null, identity: "dan@x.com" });
    expect(mint()).rejects.toBeInstanceOf(MintError);
  });

  test("resolveIdentity returns the SA when impersonating, without shelling out", async () => {
    const { exec, calls } = fakeExec();
    const id = await resolveIdentity(exec, "sa@proj.iam.gserviceaccount.com");
    expect(id).toBe("sa@proj.iam.gserviceaccount.com");
    expect(calls).toHaveLength(0);
  });

  test("resolveIdentity falls back to the gcloud account", async () => {
    const { exec } = fakeExec([{ stdout: "dan@example.com\n" }]);
    expect(await resolveIdentity(exec, null)).toBe("dan@example.com");
  });
});

// ---------------------------------------------------------------------------
// refresh_token_absent — verified, never assumed
// ---------------------------------------------------------------------------

describe("proveRefreshTokenAbsent inspects what actually crosses", () => {
  // Mutation check: `return true;` at the top of proveRefreshTokenAbsent
  // turns the two negative tests red.
  test("token-mode materials carry no refresh token", () => {
    expect(proveRefreshTokenAbsent(tokenModeMaterials(TOKEN))).toBe(true);
  });

  test("false when the injected file IS an authorized_user ADC blob", () => {
    const adc = JSON.stringify({
      type: "authorized_user",
      client_id: "x.apps.googleusercontent.com",
      refresh_token: "1//0fake-refresh-token",
    });
    const m = fileModeMaterials(adc);
    expect(proveRefreshTokenAbsent(m)).toBe(false);
    expect(m.files[ADC_FILE_PATH]).toBeDefined();
  });

  test("false when a refresh token is smuggled through an env value", () => {
    const m = tokenModeMaterials(TOKEN);
    m.env["GOOGLE_CREDS"] = '{"refresh_token":"1//0oops"}';
    expect(proveRefreshTokenAbsent(m)).toBe(false);
  });

  test("the startup env is pointers only — no secret to leak via the env file", () => {
    const env = tokenModeStartupEnv();
    expect(env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"]).toBe(TOKEN_FILE);
    // The run-dir env file is a durable artifact; a token here has escaped.
    for (const v of Object.values(env)) expect(v).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// cloud_access: false — no credential, observably
// ---------------------------------------------------------------------------

describe("planCredential makes the no-credential case a value", () => {
  const base = {
    adcMode: "token" as const,
    impersonateServiceAccount: null,
    quotaProject: null,
  };

  // Mutation check: making planCredential ignore cloudAccess and always
  // return an inject plan turns this red (acceptance 13).
  test("cloud_access: false yields a none plan, printable by `up`", () => {
    const plan = planCredential({ cloudAccess: false, ...base });
    expect(plan).toEqual({ kind: "none", reason: "cloud_access_false" });
    expect(describeCredentialPlan(plan)).toContain("no credential");
  });

  test("cloud_access: true yields an inject plan naming mode and identity", () => {
    const plan = planCredential({
      cloudAccess: true,
      ...base,
      impersonateServiceAccount: "sa@p.iam.gserviceaccount.com",
      quotaProject: "proj-1",
    });
    expect(plan.kind).toBe("inject");
    const line = describeCredentialPlan(plan);
    expect(line).toContain("token");
    expect(line).toContain("sa@p.iam.gserviceaccount.com");
    expect(line).toContain("proj-1");
  });
});

// ---------------------------------------------------------------------------
// Injection into a running container
// ---------------------------------------------------------------------------

describe("injectToken sends the token over stdin, never argv", () => {
  // Mutation check: appending the token to the exec argv (echo-style) turns
  // the argv scan red; dropping the stdin option turns the stdin pin red.
  test("argv is docker exec against the container, with no token in it", async () => {
    const { exec, calls } = fakeExec([{}]);
    await injectToken(exec, "pifleet-r1-eng-1", TOKEN);
    const call = calls[0]!;
    expect(call.argv.slice(0, 3)).toEqual(["docker", "exec", "-i"]);
    expect(call.argv).toContain("pifleet-r1-eng-1");
    for (const a of call.argv) expect(a).not.toContain(TOKEN);
    expect(call.opts?.stdin).toBe(TOKEN);
  });

  test("the write script lands in tmpfs with an atomic rename and 0600 umask", () => {
    const script = injectArgv("c")[6]!;
    expect(script).toContain("umask 077");
    expect(script).toContain(`${TOKEN_FILE}.tmp`);
    expect(script).toContain(`mv ${TOKEN_FILE}.tmp ${TOKEN_FILE}`);
    // /tmp because the root fs is read-only and /workspace + /outbox are
    // harvested back to the host (SRD §5.6) — tmpfs dies with the container.
    expect(TOKEN_FILE.startsWith("/tmp/")).toBe(true);
  });

  // Mutation check: ignoring the exit code in injectToken turns this red —
  // the silent version leaves a dead token and a confusing task failure.
  test("a failed exec throws a named error rather than silently succeeding", async () => {
    const { exec } = fakeExec([{ code: 1, stderr: "No such container: c" }]);
    const err = await injectToken(exec, "c", TOKEN).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InjectError);
    expect((err as Error).message).toContain("No such container");
  });
});

// ---------------------------------------------------------------------------
// The durable record
// ---------------------------------------------------------------------------

describe("recordInjection produces a token-free, schema-valid record", () => {
  const args = {
    worker: "eng-1",
    mode: "token" as const,
    identity: "dan@example.com",
    expiresAt: "2026-07-27T12:00:00.000Z",
    generation: 2,
    materials: tokenModeMaterials(TOKEN),
    now: () => 1234,
  };

  // Mutation check: threading the token into any record field (identity was
  // the mutation used) turns the serialization scan red.
  test("the serialized record never contains the token value", () => {
    const record = recordInjection(args);
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(record.schema).toBe("pifleet.credential/v1");
    expect(record.generation).toBe(2);
    expect(record.injected_mono).toBe(1234);
  });

  // Mutation check: hardcoding refresh_token_absent: true in recordInjection
  // turns this red — the field must be COMPUTED from the materials.
  test("refresh_token_absent reflects the materials, not an assumption", () => {
    const clean = recordInjection(args);
    expect(clean.refresh_token_absent).toBe(true);

    const dirty = recordInjection({
      ...args,
      mode: "file",
      materials: fileModeMaterials('{"refresh_token":"1//0x"}'),
    });
    expect(dirty.refresh_token_absent).toBe(false);
  });
});
