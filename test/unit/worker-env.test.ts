/**
 * The worker container's `--env-file` (`run/worker-env.ts`).
 *
 * The value of these tests is that the variable NAMES are not this module's to
 * choose. `docker/entrypoint.sh` reads them to render `~/.pi/agent/models.json`
 * before exec'ing Pi, and Pi registers an oMLX provider only when that file
 * lists models — so a renamed or dropped variable does not crash anything. It
 * produces the worker that script's own header warns about: one that "streams
 * tokens happily and can reach no model at all". Nothing else in the system
 * fails on that, which is exactly why it is asserted here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig, resolveWorker, ConfigError } from "../../src/config/load.ts";
import {
  buildWorkerEnv,
  serializeEnvFile,
  writeWorkerEnvFile,
} from "../../src/run/worker-env.ts";
import { CREDENTIAL_ENV_VARS } from "../../src/security/adc.ts";
import { policyFromConfig } from "../../src/security/egress.ts";
import {
  LEGACY_RELAY_LISTEN_ALIAS,
  PROXY_LISTEN_ALIAS,
  PROXY_LISTEN_PORT,
  RELAY_LISTEN_ALIAS,
  proxyPolicyFor,
} from "../../src/security/relay.ts";

function baseDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "env-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel" },
    roles: { eng: {}, cloudy: { cloud_access: true } },
    workers: [
      { id: "w1", role: "eng" },
      { id: "wc", role: "cloudy" },
    ],
    ...over,
  };
}

async function load(doc: Record<string, unknown>) {
  return parseConfig(stringify(doc), "/tmp/fleet.yaml");
}

describe("ISC-298: git's ownership guard is disarmed for /workspace", () => {
  /**
   * The SECOND of ISC-298's two blockers, and the one the permission fix does
   * not reach.
   *
   * Git refuses on OWNERSHIP and ignores mode (CVE-2022-24765). On a Linux
   * Docker host a fully world-writable `/workspace` owned by another uid still
   * answers `fatal: detected dubious ownership` for `status`, `add`, `commit`
   * and `diff` — so a worker could write its files and could not commit them,
   * which is strictly worse than the failure the widening fixed.
   *
   * Asserted on the env PLAN rather than by running a container, for the same
   * reason the permission probe in `worktree.test.ts` is asserted on mode bits:
   * macOS squashes bind-mount ownership, so a container started here never
   * reaches the refusal, and a local container test would be green on this
   * machine and silent about the runner. `container-live` exercises the
   * consequence on real Linux.
   */
  test("a worker with a /workspace mount gets safe.directory for it", async () => {
    const loaded = await load(baseDoc());
    for (const id of ["w1", "wc"]) {
      const plan = buildWorkerEnv(loaded, resolveWorker(loaded, id), {});
      expect(plan.vars["GIT_CONFIG_COUNT"]).toBe("1");
      expect(plan.vars["GIT_CONFIG_KEY_0"]).toBe("safe.directory");
      // The CONTAINER path, and specifically not `*`. The wildcard is the form
      // most answers to this error reach for, and it disables the check for
      // every repository the container can see rather than the one tree the
      // worker has business in.
      expect(plan.vars["GIT_CONFIG_VALUE_0"]).toBe("/workspace");
    }
  });

  /**
   * `shared-ro` is included deliberately: that mount is the operator's OWN
   * checkout, owned by the operator, so a read-only role running `git log`
   * meets the identical refusal. Covering only `worktree` would leave half the
   * mounted roles broken on Linux.
   */
  test("a read-only code mount needs it too — the tree is still owned by someone else", async () => {
    const loaded = await load(
      baseDoc({
        roles: { eng: {}, cloudy: { cloud_access: true }, rev: { isolation: "shared-ro" } },
        workers: [
          { id: "w1", role: "eng" },
          { id: "wc", role: "cloudy" },
          { id: "wr", role: "rev" },
        ],
      }),
    );
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wr"), {});
    expect(plan.vars["GIT_CONFIG_VALUE_0"]).toBe("/workspace");
  });

  /**
   * And `none` gets nothing. A setting emitted unconditionally is one nobody
   * notices has stopped tracking the mount it exists for — this is what keeps
   * the assertion above non-vacuous.
   */
  test("a worker with no code mount is given no git config at all", async () => {
    const loaded = await load(
      baseDoc({
        roles: { eng: {}, cloudy: { cloud_access: true }, field: { isolation: "none" } },
        workers: [
          { id: "w1", role: "eng" },
          { id: "wc", role: "cloudy" },
          { id: "wf", role: "field" },
        ],
      }),
    );
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wf"), {});
    expect(Object.keys(plan.vars).filter((k) => k.startsWith("GIT_CONFIG"))).toEqual([]);
  });
});

describe("the --env-file contract with docker/entrypoint.sh", () => {
  /**
   * The three names the entrypoint actually branches on. It guards with
   * `[ -n "${PIFLEET_LLM_BASE_URL:-}" ] && [ -n "${PIFLEET_LLM_MODELS:-}" ]`
   * before writing models.json at all, so either one missing is silent.
   */
  test("emits the provider, base URL and model names the entrypoint reads", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {});
    expect(plan.vars["PIFLEET_LLM_PROVIDER"]).toBe("omlx");
    expect(plan.vars["PIFLEET_LLM_BASE_URL"]).toBe("http://omlx.pifleet.internal:8000/v1");
    expect(plan.vars["PIFLEET_LLM_MODELS"]).toBe("TestModel");
  });

  /**
   * The escape-attempt honeypot is armed for EVERY worker (ISC-125), with no
   * role, config or role-override path that can turn it off.
   *
   * Asserted across both workers and asserted as the literal `"1"`, because
   * `docker/entrypoint.sh` compares against that string: any other truthy
   * spelling ("true", "yes") leaves the listener unstarted, the worker running
   * perfectly, and the run reported as NOT WATCHED — a failure whose only
   * symptom is a line in a report nobody reads until something has gone wrong.
   */
  test("every worker's env arms the escape-attempt honeypot (ISC-125)", async () => {
    const loaded = await load(baseDoc());
    for (const id of ["w1", "wc"]) {
      const plan = buildWorkerEnv(loaded, resolveWorker(loaded, id), {});
      expect(plan.vars["PIFLEET_HONEYPOT"]).toBe("1");
    }
  });

  /**
   * `models_allowlist` is a GATE on what a worker may be configured with
   * (ISC-190), not a list to register. Registering it would hand every worker
   * a provider entry for models it is not permitted to use.
   */
  test("registers the worker's own model, never the allowlist", async () => {
    const loaded = await load(
      baseDoc({ llm: { model: "TestModel", models_allowlist: ["TestModel", "OtherModel"] } }),
    );
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {});
    expect(plan.vars["PIFLEET_LLM_MODELS"]).toBe("TestModel");
    expect(plan.vars["PIFLEET_LLM_MODELS"]).not.toContain("OtherModel");
  });

  /**
   * An absent key is OMITTED, not written blank.
   *
   * `KEY=` and an unset KEY are different to the entrypoint's `-n` guards, and
   * a blank value is the shape that reaches the container and fails deep
   * inside it — the failure mode `materialize.ts` kept the missing-file
   * tripwire for.
   */
  test("an unset oMLX key omits the variable and is reported, not written empty", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {});
    expect(plan.missingApiKey).toBe(true);
    expect(plan.apiKeyEnvName).toBe("OMLX_API_KEY");
    expect(Object.keys(plan.vars)).not.toContain("OMLX_API_KEY");
    expect(serializeEnvFile(plan.vars)).not.toContain("OMLX_API_KEY=");
  });

  test("a present key is carried, under the configured name", async () => {
    const loaded = await load(baseDoc({ llm: { model: "TestModel", api_key_env: "MY_KEY" } }));
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), { MY_KEY: "s3cret" });
    expect(plan.missingApiKey).toBe(false);
    expect(plan.vars["MY_KEY"]).toBe("s3cret");
  });
});

describe("credentials in a durable artifact (SRD §12.4)", () => {
  /**
   * ISC-45's shape: the assertion is over the whole CREDENTIAL_ENV_VARS set,
   * not whichever var today's default mode uses. Asserting one name would go
   * vacuous the moment the delivery mechanism changed.
   */
  test("a cloud_access: false worker gets NONE of the credential env vars", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {});
    for (const name of CREDENTIAL_ENV_VARS) {
      expect(Object.keys(plan.vars)).not.toContain(name);
    }
  });

  /**
   * The env-file is read back by `status` and `report`, so it may carry the
   * POINTER to a token file and never a token. `adc.ts:tokenModeStartupEnv`
   * is the authority on that split.
   */
  test("a token-mode cloud worker gets the pointer, never a token value", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    expect(plan.vars["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"]).toBeDefined();
    // The two vars that would carry the SECRET ITSELF must never appear.
    expect(Object.keys(plan.vars)).not.toContain("CLOUDSDK_AUTH_ACCESS_TOKEN");
    expect(Object.keys(plan.vars)).not.toContain("GOOGLE_OAUTH_ACCESS_TOKEN");
  });
});

describe("serialization into a format with no escaping", () => {
  /**
   * Docker splits at the first `=` and takes the rest of the LINE. A newline
   * therefore does not escape — it starts a new declaration, which is env-var
   * injection through a config value. There is no escape to apply, so it is
   * refused rather than rewritten.
   */
  test("a newline in a value is refused, not escaped", () => {
    expect(() => serializeEnvFile({ A: "one\nB=two" })).toThrow(ConfigError);
    expect(() => serializeEnvFile({ A: "one\rB=two" })).toThrow(ConfigError);
  });

  test("an `=` inside a value needs nothing, because only the first splits", () => {
    expect(serializeEnvFile({ URL: "http://h/v1?a=b" })).toBe("URL=http://h/v1?a=b\n");
  });

  test("a key that is not an environment name is refused", () => {
    expect(() => serializeEnvFile({ "not a key": "v" })).toThrow(ConfigError);
  });

  test("an empty plan is an empty file, not a stray newline", () => {
    expect(serializeEnvFile({})).toBe("");
  });
});

describe("the file on disk", () => {
  /**
   * 0600 because this carries the Class 1 oMLX key, and it costs nothing:
   * `--env-file` is parsed by the docker CLIENT on the host and is never
   * mounted, so unlike the briefing or the cloud policy the container never
   * opens it and it does not need the worker-readable bit.
   */
  test("is written 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envfile-"));
    const path = join(dir, "env");
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), { OMLX_API_KEY: "k" });
    const written = await writeWorkerEnvFile(path, plan);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
    // What the writer returned IS what landed — a caller recording the content
    // must not be recording something the file does not hold.
    expect(await readFile(path, "utf8")).toBe(written);
  });
});

/**
 * The launch record, written where the render already happens.
 *
 * `materializeWorkerInputs` is the one place `renderWorker` is called on the
 * `up` path. Writing the argv there — rather than having the supervisor
 * re-render from config — is what makes "what launches" and "what `render`
 * prints" the SAME object rather than two computations that have to agree.
 * That distinction is ISC-188's, and it matters more here than it did there: a
 * detached supervisor does not share the cwd or environment that config
 * resolution depends on, so its "same" render could legitimately differ with
 * nothing looking wrong.
 */
describe("the launch record", () => {
  test("carries the argv renderWorker produces, element for element", async () => {
    const { mkdtemp: mkdt } = await import("node:fs/promises");
    const { runPaths, workerPaths } = await import("../../src/run/paths.ts");
    const { materializeWorkerInputs } = await import("../../src/run/materialize.ts");
    const { renderWorker } = await import("../../src/config/render.ts");
    const { readWorkerLaunch } = await import("../../src/run/state.ts");
    const { loadConfig } = await import("../../src/config/load.ts");

    // The run-dir guard inside materialize compares against `runsRoot()`, so
    // the env has to name the same root the test uses. Restored after.
    const root = await mkdt(join(tmpdir(), "launchrec-"));
    const prev = process.env["PIFLEET_RUNS_DIR"];
    process.env["PIFLEET_RUNS_DIR"] = root;
    try {
      const loaded = await loadConfig(
        join(new URL("../../", import.meta.url).pathname, "fleet.example.yaml"),
      );
      const run = runPaths("lr1", root);
      await materializeWorkerInputs(loaded, run, ["eng-1"], async () => {}, {
        writeLaunchRecord: true,
      });

      const record = await readWorkerLaunch(workerPaths(run, "eng-1"));
      expect(record).not.toBeNull();
      const rendered = await renderWorker(loaded, "eng-1", { runId: "lr1" });
      expect(record!.argv).toEqual(rendered.docker);
      expect(record!.image).toBe(rendered.image);
      // The name has ONE definition (`run/paths.ts:workerContainerName`), so
      // the record and the `--name` on the argv cannot disagree.
      expect(record!.argv[record!.argv.indexOf("--name") + 1]).toBe(record!.container);
    } finally {
      if (prev === undefined) delete process.env["PIFLEET_RUNS_DIR"];
      else process.env["PIFLEET_RUNS_DIR"] = prev;
    }
  }, 30_000);
});

/**
 * ISC-263 — the route that makes a `cloud_access` worker's credential usable.
 *
 * Before the CONNECT proxy existed, `cloud_access: true` granted ADC and no
 * path to spend it on: a Docker network alias cannot be a wildcard, so
 * `*.googleapis.com` had no live route off the `--internal` bridge at all.
 * These assertions are on the env PLAN, which is what `--env-file` renders, so
 * they fail if the proxy is configured and no worker is ever told about it —
 * the "correct module beside a path nothing exercises" shape this repo has
 * recorded ten times.
 */
describe("ISC-263: a cloud_access worker is routed through the CONNECT proxy", () => {
  test("HTTPS_PROXY names the proxy alias, in both spellings clients read", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    expect(plan.vars["HTTPS_PROXY"]).toBe(`http://${PROXY_LISTEN_ALIAS}:${PROXY_LISTEN_PORT}`);
    // Lowercase too: curl and requests read the lowercase form, and a fleet
    // that set only one spelling would work under some clients and not others.
    expect(plan.vars["https_proxy"]).toBe(plan.vars["HTTPS_PROXY"]);
  });

  /**
   * HTTP_PROXY is deliberately absent, and this asserts the DECISION rather
   * than merely observing today's behaviour. The proxy answers `405` to
   * anything that is not CONNECT, so advertising it as an HTTP proxy would
   * advertise a capability it explicitly refuses.
   */
  test("HTTP_PROXY is NOT set — the proxy speaks CONNECT only", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    expect(plan.vars["HTTP_PROXY"]).toBeUndefined();
    expect(plan.vars["http_proxy"]).toBeUndefined();
  });

  /**
   * The footgun, asserted directly.
   *
   * `proxyPolicyFor` carries no `llm` rule, so a model request that DID enter
   * the proxy would be denied `default-deny` — every worker stalling with no
   * tool calls, which is SRD §5.9's exact quiet-failure shape. Both relay
   * spellings are required because ISC-264's transition means a config may
   * still name the legacy alias.
   */
  test("NO_PROXY exempts BOTH relay aliases, so model traffic never enters the proxy", async () => {
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    const exempt = plan.vars["NO_PROXY"]!.split(",");
    expect(exempt).toContain(RELAY_LISTEN_ALIAS);
    expect(exempt).toContain(LEGACY_RELAY_LISTEN_ALIAS);
    expect(plan.vars["no_proxy"]).toBe(plan.vars["NO_PROXY"]);
  });

  /**
   * The other half of ISC-45's observability claim: `cloud_access: false` must
   * be observable as the ABSENCE of the whole set, and the proxy route is now
   * part of that set. A worker with no credential has nothing to spend at
   * Google and must not be handed a route there either.
   *
   * ## RESTATED 2026-08-28 (ISC-309), and the rename is the whole point
   *
   * This test was called "a cloud_access: false worker gets no proxy route at
   * all". That sentence is now FALSE as a general claim: `egress_access: true`
   * grants the route with `cloud_access: false`, deliberately, because the two
   * were welded together by one `if` and a worker needing only a network route
   * had to be handed a Google identity to get it.
   *
   * The ASSERTION is unchanged and still passes, because `w1` in this fixture
   * sets neither flag — which is exactly why the rename matters rather than
   * being cosmetic. A test whose name claims more than its fixture exercises
   * is the shape that reads as coverage and is not; anyone grepping for the
   * old sentence would have concluded the route was unreachable without
   * `cloud_access`, and been wrong. The condition that carries the meaning is
   * NEITHER grant, and it says so now.
   *
   * The route-with-no-grant case, and the anti-criterion that the Google
   * variables stay absent in it, live in `test/unit/worker-secrets.test.ts`
   * (ISC-309, ISC-310).
   */
  test("a worker with NEITHER grant gets no proxy route at all", async () => {
    const loaded = await load(baseDoc());
    const w = resolveWorker(loaded, "w1");
    expect(w.cloudAccess).toBe(false);
    expect(w.egressAccess).toBe(false);
    const plan = buildWorkerEnv(loaded, w, {});
    for (const k of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      expect(plan.vars[k]).toBeUndefined();
    }
  });

  test("the proxy route survives serialization to the env file docker reads", async () => {
    // `serializeEnvFile` throws on anything that would not round-trip, and a
    // URL is the shape most likely to carry something it refuses.
    const loaded = await load(baseDoc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    const text = serializeEnvFile(plan.vars);
    expect(text).toContain(`HTTPS_PROXY=http://${PROXY_LISTEN_ALIAS}:${PROXY_LISTEN_PORT}`);
  });
});

/**
 * The policy the proxy is given, and the one rule it must NOT carry.
 */
describe("ISC-263: the proxy's policy", () => {
  test("carries the configured Google hosts on 443", async () => {
    const loaded = await load(
      baseDoc({ egress: { google_hosts: ["*.googleapis.com", "oauth2.googleapis.com"] } }),
    );
    const rules = proxyPolicyFor(loaded.config).rules;
    expect(rules.map((r) => r.host)).toContain("*.googleapis.com");
    for (const r of rules) expect(r.port).toBe(443);
  });

  test("carries explicit egress.allow entries with their own ports", async () => {
    const loaded = await load(
      baseDoc({ egress: { allow: [{ host: "artifacts.example.com", port: 8443 }] } }),
    );
    const rules = proxyPolicyFor(loaded.config).rules;
    const hit = rules.find((r) => r.host === "artifacts.example.com");
    expect(hit?.port).toBe(8443);
  });

  /**
   * The omission, asserted rather than described. Model traffic reaches the
   * relay's port-forward listener under a different name; an `llm` rule here
   * would authorize a destination this path is not meant to serve, in the one
   * place a reader checks to learn what the proxy can reach.
   */
  test("carries NO llm rule, unlike policyFromConfig", async () => {
    const loaded = await load(baseDoc());
    const proxyRules = proxyPolicyFor(loaded.config).rules;
    expect(proxyRules.map((r) => r.name)).not.toContain("llm");
    // The control: the general policy DOES have one, so the absence above is
    // this function's doing and not an empty config.
    expect(policyFromConfig(loaded.config).rules.map((r) => r.name)).toContain("llm");
  });
});
