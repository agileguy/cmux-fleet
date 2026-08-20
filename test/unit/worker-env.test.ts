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
    expect(plan.vars["PIFLEET_LLM_BASE_URL"]).toBe("http://host.docker.internal:8000/v1");
    expect(plan.vars["PIFLEET_LLM_MODELS"]).toBe("TestModel");
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
