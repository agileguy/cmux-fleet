/**
 * The supervisor -> entrypoint channel that produces `~/.pi/agent/models.json`,
 * asserted as a JOIN rather than as two independent halves.
 *
 * `run/worker-env.ts` decides what the worker's environment says, `config/
 * render.ts` decides what Pi's argv says, and `docker/entrypoint.sh` turns the
 * environment into the file Pi reads its provider configuration out of. Nothing
 * in the repo made those three agree, and two of them silently disagreed:
 *
 *   ISC-401 (Defect B) `render.ts` put the WORKER'S RESOLVED provider on
 *                      `pi --provider` while `worker-env.ts` put the FLEET-WIDE
 *                      one in `PIFLEET_LLM_PROVIDER`, which is the provider KEY
 *                      the entrypoint writes. A `provider/`-prefixed model
 *                      launched Pi naming a provider its own models.json did
 *                      not define.
 *   ISC-406 (Defect A) the entrypoint read the credential under a hardcoded
 *                      `${OMLX_API_KEY:-}` while `worker-env.ts` writes it under
 *                      `llm.api_key_env`, whatever the operator configured.
 *
 * Both are the same failure shape, and it is the shape that decides how these
 * tests are written. With ONE provider configured and the default variable name
 * the two sides agree BY COINCIDENCE — the same coincidence `relayGatePolicy`
 * was caught in by ISC-264 — so a test that pins either side to a constant is
 * green against the broken code. What is asserted here is that the two rendered
 * strings MATCH, with the expected value anchored separately to the literal a
 * human wrote in `fleet.yaml`. Mutating either side alone breaks the match;
 * mutating both breaks the anchor.
 *
 * ## Why the real script, and the real env plan
 *
 * These run `docker/entrypoint.sh` itself under the host's bash with `HOME`
 * redirected — the harness `entrypoint-theme.test.ts` and
 * `entrypoint-pane-mode.test.ts` use, and for the same reason: the property is
 * a property of the script's control flow, not of Docker. Re-implementing the
 * `jq -n` here would re-encode the very assumption that was wrong, and a fixture
 * environment written by hand would agree with the entrypoint by construction.
 * So the environment comes from `buildWorkerEnv` and the argv from
 * `buildPiArgv`: every string under test is one a real `up` would produce.
 *
 * `PIFLEET_HONEYPOT` is the one variable dropped from the plan before spawning,
 * and it is dropped rather than overridden so a reader sees the deletion. The
 * plan sets it to "1" for every worker (ISC-125), which makes the entrypoint
 * start `/usr/local/bin/pifleet-honeypot` and treat its death as fatal — on a
 * host that binary does not exist, so the script would poll for a socket and
 * `exit 71` ten seconds later. That is the supervisor at the bottom of the file;
 * everything under test here has already run by then.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig, resolveWorker } from "../../src/config/load.ts";
import { buildPiArgv } from "../../src/config/render.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRYPOINT = join(REPO_ROOT, "docker", "entrypoint.sh");

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function baseDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "models-json-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel" },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
    ...over,
  };
}

interface ModelsJson {
  providers: Record<string, { name: string; baseUrl: string; apiKey: string; models: unknown[] }>;
}

/**
 * What one worker's `up` would actually produce, on both sides of the join.
 *
 * `hostEnv` is a parameter rather than `process.env` because `buildWorkerEnv`
 * is pure in it — the renamed-credential case needs a host that has
 * `OLLAMA_API_KEY` and emphatically does NOT have `OMLX_API_KEY`, and mutating
 * the real process environment to get that would leak between tests.
 */
async function render(
  doc: Record<string, unknown>,
  hostEnv: Record<string, string | undefined>,
): Promise<{ argvProvider: string; models: ModelsJson | null; code: number; stderr: string }> {
  const loaded = await parseConfig(stringify(doc), "/tmp/fleet.yaml");
  const w = resolveWorker(loaded, "w1");
  const plan = buildWorkerEnv(loaded, w, hostEnv);

  const argv = buildPiArgv(w, false);
  const argvProvider = argv[argv.indexOf("--provider") + 1] ?? "";

  const dir = await mkdtemp(join(tmpdir(), "pifleet-modelsjson-"));
  dirs.push(dir);
  await mkdir(join(dir, ".pi", "agent"), { recursive: true });

  // Exits immediately: this file is about what the script wrote BEFORE the
  // launch, so the worker only has to not hang.
  const standIn = join(dir, "stand-in.sh");
  await writeFile(standIn, "#!/bin/sh\nexit 0\n");
  await chmod(standIn, 0o755);

  // Bun replaces the environment wholesale rather than merging, which is `env
  // -i` — and that is the point of §2.2's probe: nothing from the developer's
  // shell can supply a credential the supervisor did not deliver.
  const { PIFLEET_HONEYPOT: _dropped, ...planVars } = plan.vars;
  const env: Record<string, string> = {
    ...planVars,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: dir,
    PIFLEET_WORKER_BIN: standIn,
  };

  const p = Bun.spawn(["bash", ENTRYPOINT], {
    env,
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  const raw = await readFile(join(dir, ".pi", "agent", "models.json"), "utf8").catch(() => null);
  return { argvProvider, models: raw === null ? null : (JSON.parse(raw) as ModelsJson), code, stderr };
}

describe("ISC-401: the resolved provider reaches Pi's argv AND models.json", () => {
  /**
   * THE ASSERTION THIS FILE WAS WRITTEN FOR.
   *
   * `ollama/gpt-oss:120b-cloud` is the SRD's own measured example, and the tag
   * matters: `120b-cloud` is not one of the six `ThinkingLevel` words, so
   * `decomposeModel` leaves it on the model id and this case exercises the
   * provider prefix without also tripping Defect C.
   *
   * Before the fix, measured: `--provider ollama` on the argv and `"omlx"` as
   * the only key in models.json. The prefix resolved to the flag and stopped.
   *
   * Three assertions, and none of them is redundant:
   *   - the two rendered strings match          (mutating EITHER side fails)
   *   - each equals the literal from fleet.yaml (mutating BOTH fails)
   * A single `toBe("ollama")` on one side would be green against the code that
   * shipped, because that side was never the broken one.
   */
  test("a provider/-prefixed model names one provider on both sides", async () => {
    const r = await render(
      baseDoc({ roles: { eng: { model: "ollama/gpt-oss:120b-cloud" } } }),
      { OMLX_API_KEY: "KEY-FOR-SELF-HOSTED" },
    );
    expect(r.models).not.toBeNull();
    const keys = Object.keys(r.models!.providers);
    expect(keys).toHaveLength(1);

    // The join: what Pi is launched naming, and what Pi's own config defines.
    expect(keys[0]).toBe(r.argvProvider);
    // The anchor: the provider the operator actually wrote, derived by neither
    // code path under test.
    expect(r.argvProvider).toBe("ollama");
    expect(keys[0]).toBe("ollama");

    // The prefix is consumed, not carried into the model id.
    expect(r.models!.providers["ollama"]!.models).toEqual([
      { id: "gpt-oss:120b-cloud", name: "gpt-oss:120b-cloud" },
    ]);
  });

  /**
   * The control, and the reason the test above cannot be replaced by it.
   *
   * With no prefix the two sides agree at "omlx" — which they did before the
   * fix as well. This is a regression guard for the common fleet, not a probe
   * of the defect, and saying so here keeps a future reader from mistaking it
   * for one.
   */
  test("an unprefixed model still agrees at the fleet-wide provider", async () => {
    const r = await render(baseDoc(), { OMLX_API_KEY: "KEY-FOR-SELF-HOSTED" });
    const keys = Object.keys(r.models!.providers);
    expect(keys[0]).toBe(r.argvProvider);
    expect(r.argvProvider).toBe("omlx");
  });
});

describe("ISC-406: models.json carries the key under the CONFIGURED name", () => {
  /**
   * §2.2's probe, inverted.
   *
   * The SRD ran the entrypoint's `jq -n` under `env -i` with `api_key_env:
   * OLLAMA_API_KEY` and a supervisor that delivered `OLLAMA_API_KEY` and
   * nothing else, and got `"apiKey": ""`. This asserts the opposite outcome
   * through the same channel, end to end: `buildWorkerEnv` chooses the name,
   * the entrypoint has to find the value under it.
   *
   * `OMLX_API_KEY` IS DELIBERATELY ABSENT from `hostEnv`, and that absence is
   * the whole test. Leaving it set would let the old hardcoded read succeed and
   * the probe would prove nothing — which is precisely how the defect survived
   * this long.
   *
   * The failure it prevents is silent: the entrypoint's guard tests the base
   * URL and the model list and NOT the key, so the container boots, `up`
   * reports success, and the worker authenticates as nobody.
   */
  test("a renamed api_key_env still reaches apiKey", async () => {
    const r = await render(baseDoc({ llm: { model: "TestModel", api_key_env: "OLLAMA_API_KEY" } }), {
      OLLAMA_API_KEY: "KEY-FOR-RENAMED",
    });
    expect(r.models).not.toBeNull();
    const provider = r.models!.providers["omlx"]!;
    expect(provider.apiKey).not.toBe("");
    expect(provider.apiKey).toBe("KEY-FOR-RENAMED");
  });

  /**
   * The credential does not travel twice — asserted as a PROPERTY, so §6.6 does
   * not have to rewrite it.
   *
   * ISC-31 is "`docker inspect` shows no cloud provider key in any container's
   * environment (only `OMLX_API_KEY`)". The shortest fix for the test above —
   * ALSO exporting the key under a fixed fleet-owned alias so the entrypoint
   * could keep reading a literal — puts one credential in the environment under
   * two names, doubling the surface of every `env` dump and crash
   * serialisation. That is why the channel carries a NAME instead, and this is
   * what stops the alias from being reintroduced quietly.
   *
   * "AT MOST ONE", not "exactly one", and the inequality is the whole point of
   * writing it this way. Today the count is 1. Under §6.6's D8 the key moves to
   * a `0444` file on the read-only `/secrets` mount with only
   * `PIFLEET_LLM_API_KEY_FILE` pointing at it, and the count becomes 0 — which
   * is ISC-407, a criterion this change does NOT satisfy and is not trying to.
   * Pinning `["OLLAMA_API_KEY"]` here would make this test fail on the day the
   * property it asserts gets STRONGER.
   *
   * Nothing about the pointer's spelling is asserted anywhere in this file for
   * the same reason: `PIFLEET_LLM_API_KEY_ENV` is a mechanism with a scheduled
   * replacement, and every other test here goes through the rendered
   * `models.json`, which D8 leaves unchanged.
   */
  test("at most one variable in the plan holds the credential value (ISC-31)", async () => {
    const loaded = await parseConfig(
      stringify(baseDoc({ llm: { model: "TestModel", api_key_env: "OLLAMA_API_KEY" } })),
      "/tmp/fleet.yaml",
    );
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {
      OLLAMA_API_KEY: "KEY-FOR-RENAMED",
    });
    const holdingTheValue = Object.entries(plan.vars)
      .filter(([, v]) => v === "KEY-FOR-RENAMED")
      .map(([k]) => k);
    expect(holdingTheValue.length).toBeLessThanOrEqual(1);
  });

  /**
   * The default fleet, unchanged. Green before the fix and after it, and kept
   * because the indirection is new machinery on the path every worker takes.
   */
  test("the default api_key_env still reaches apiKey", async () => {
    const r = await render(baseDoc(), { OMLX_API_KEY: "KEY-FOR-SELF-HOSTED" });
    expect(r.models!.providers["omlx"]!.apiKey).toBe("KEY-FOR-SELF-HOSTED");
  });

  /**
   * A keyless fleet must still BOOT, and this is where bash 3.2 and bash 5.2
   * part company.
   *
   * A local oMLX with no credential is legitimate, so `worker-env.ts` omits the
   * variable entirely rather than writing it blank. The entrypoint then
   * indirects on a name nothing holds. Measured under `env -i` and `set -eu`:
   *
   *   bash 3.2.57 (macOS host)      ${!name:-} -> ""                      exit 0
   *   bash 5.2.15 (bookworm image)  unset name is fine; a MALFORMED name is
   *                                 "invalid variable name", exit 1
   *
   * so the entrypoint tests the name against ENV_KEY_RE's own pattern before
   * indirecting. HONEST LIMIT: on a bash-3.2 host the malformed-name half of
   * this is weak, because 3.2 forgives what 5.2 refuses. In CI it is not —
   * `ubuntu-latest` runs bash 5, which is also what the image runs, and an
   * unguarded indirection fails this case there under `set -e`.
   */
  test("a keyless fleet renders an empty key rather than failing to boot", async () => {
    const r = await render(baseDoc(), {});
    expect(r.code).toBe(0);
    expect(r.models!.providers["omlx"]!.apiKey).toBe("");
  });

  test("a malformed api_key_env degrades to an empty key, not a dead container", async () => {
    const r = await render(baseDoc({ llm: { model: "TestModel", api_key_env: "not-an-ident" } }), {});
    expect(r.code).toBe(0);
    expect(r.models!.providers["omlx"]!.apiKey).toBe("");
  });
});
