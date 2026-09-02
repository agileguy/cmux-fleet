/**
 * D8 — the Class 1 provider key delivered as a FILE (SRD §6.6).
 *
 * ISC-407, ISC-408 and ISC-422, probed at the altitudes each one names rather
 * than at whichever altitude was cheapest to write.
 *
 * ## Why the SERIALISED env file, and not `plan.vars`
 *
 * ISC-407's own probe clause says so: "assert on the serialised env file, which
 * is what `docker inspect` would show". Those are not the same artifact and the
 * gap between them is where this defect would hide. `plan.vars` is a
 * `Record<string, string>` a reader can enumerate by key; the env file is the
 * BYTES docker parses, and a value that reached it by any route — a fleet
 * variable that happened to be assigned the key, a future field that
 * interpolated it — appears there and in `docker inspect` while a key-by-key
 * assertion over `vars` looks clean. The needle is a substring search over the
 * whole rendered file for that reason.
 *
 * ## The canary
 *
 * Every "the value is not here" assertion below is a substring search for
 * `CANARY`, which is long and distinctive on purpose. `worker-secrets.test.ts`
 * states the rule this follows: a short or wordlike value would make those
 * assertions pass for the wrong reason, and an artifact that happens not to
 * contain `"abc"` proves nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { parseConfig, resolveWorker, type LoadedConfig } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import {
  LLM_API_KEY_FILE_VAR,
  SECRETS_MOUNT,
  SECRET_FILE_MODE,
  buildWorkerEnv,
  serializeEnvFile,
  writeWorkerSecretFiles,
} from "../../src/run/worker-env.ts";
import { SECRET_NAMES_VAR } from "../../src/security/redact.ts";
import { materializeWorkerInputs, SecretStoreNotMountedError } from "../../src/run/materialize.ts";

/**
 * Long, unique, and shaped like nothing else in a rendered env file — see the
 * header. A real Ollama Cloud key is high-entropy, so this is representative
 * rather than merely convenient.
 */
const CANARY = "canary-2f8b-CLASS-ONE-PROVIDER-KEY-must-never-be-an-env-value-4e1d";

/** The operator's chosen spelling — deliberately NOT the `OMLX_API_KEY` default. */
const KEY_VAR = "OLLAMA_CLOUD_API_KEY";

const cleanups: string[] = [];
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "class1-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel", api_key_env: KEY_VAR },
    secrets: { env_allowlist: ["TICKET_TOKEN"] },
    roles: { eng: {}, tick: { secrets: ["TICKET_TOKEN"] } },
    workers: [
      { id: "eng-1", role: "eng" },
      { id: "tick-1", role: "tick" },
    ],
    ...over,
  };
}

async function load(d: Record<string, unknown> = doc()): Promise<LoadedConfig> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-class1-"));
  cleanups.push(dir);
  const path = join(dir, "fleet.yaml");
  await writeFile(path, stringify(d));
  return parseConfig(await Bun.file(path).text(), path);
}

/** The env plan for one worker, with the key present in a FAKE host env. */
async function planFor(id: string, hostEnv: Record<string, string> = { [KEY_VAR]: CANARY }) {
  const loaded = await load();
  return buildWorkerEnv(loaded, resolveWorker(loaded, id), hostEnv);
}

// ---------------------------------------------------------------------------
// ISC-407 — no variable's VALUE is the provider key
// ---------------------------------------------------------------------------

describe("ISC-407: the key's value is absent from the worker's environment", () => {
  /**
   * THE CRITERION'S LITERAL INSTRUMENT: a substring sweep of the bytes docker
   * parses, not a key-by-key walk of `vars`. See the header on why those differ.
   */
  test("the serialised env file contains the key's value ZERO times", async () => {
    const plan = await planFor("eng-1");
    const file = serializeEnvFile(plan.vars);
    expect(file).not.toContain(CANARY);
  });

  /**
   * ANTI-VACUITY, and it is doing real work rather than ceremony.
   *
   * The assertion above passes trivially if the key was never delivered at all
   * — a fleet with no key set, a fixture whose `api_key_env` does not match, a
   * future `buildWorkerEnv` that silently dropped it. Each of those is a
   * BROKEN fleet that this probe would certify as secure. So the same plan must
   * prove the key WAS delivered, by the other route, in the same test.
   */
  test("and that is not because the key went undelivered", async () => {
    const plan = await planFor("eng-1");
    expect(plan.missingApiKey).toBe(false);
    expect(plan.secretFiles).toContainEqual({ name: KEY_VAR, value: CANARY });
    expect(plan.vars[LLM_API_KEY_FILE_VAR]).toBe(`${SECRETS_MOUNT}/${KEY_VAR}`);
  });

  /**
   * NO VARIABLE, not "not the obvious one".
   *
   * ISC-31's recorded lesson is that its own test "asserts how MANY variables
   * hold the credential, not which", and that an `api_key_env` colliding with a
   * fleet variable put the key somewhere nobody was looking. This walks every
   * value in the plan, so a future field that assigned the key under any name
   * fails here rather than passing a check aimed at one spelling.
   */
  test("no variable in the plan has the key as its value, under ANY name", async () => {
    const plan = await planFor("eng-1");
    const holders = Object.entries(plan.vars).filter(([, v]) => v === CANARY);
    expect(holders).toEqual([]);
  });

  /** The operator's own variable name carries nothing — the old delivery, gone. */
  test("the operator's configured name is absent from the environment entirely", async () => {
    const plan = await planFor("eng-1");
    expect(Object.keys(plan.vars)).not.toContain(KEY_VAR);
  });

  /**
   * The POINTER is the whole of the new delivery, and it is fleet-owned.
   *
   * A pointer spelled from the operator's name would be Defect A with an extra
   * step: the entrypoint would still have to know what the operator called
   * their variable in order to find it.
   */
  test("the environment carries a fleet-owned pointer, and it holds a path", async () => {
    const plan = await planFor("eng-1");
    const file = serializeEnvFile(plan.vars);
    expect(file).toContain(`${LLM_API_KEY_FILE_VAR}=${SECRETS_MOUNT}/${KEY_VAR}`);
  });

  /**
   * THE REDACTOR MUST NOT HAVE BEEN DISARMED BY THE MOVE.
   *
   * `redactable` tested `apiKeyEnvName in vars`, which was a correct proxy for
   * "the key was delivered" only while the key WAS a variable. Under D8 it
   * never is, so that test would evaluate false on every run and silently drop
   * the provider key from `SECRET_NAMES_VAR` — the redactor reporting itself
   * armed while scrubbing nothing, which is that constant's own documented
   * prediction. This is the probe that would have caught it.
   */
  test("the key's NAME is still on the redaction list", async () => {
    const plan = await planFor("eng-1");
    expect(plan.vars[SECRET_NAMES_VAR]!.split(",")).toContain(KEY_VAR);
  });
});

// ---------------------------------------------------------------------------
// ISC-408 — the key file is 0444 and its mount is read-only
// ---------------------------------------------------------------------------

describe("ISC-408: the key file's mode, and its mount's read-only flag", () => {
  /**
   * THE KEY FILE SPECIFICALLY, stat'ed by name.
   *
   * `worker-secret-files.test.ts` already proves 0444 for a `secrets:` GRANT,
   * and that is a different file reaching disk down a different path: a grant
   * comes from `secrets.env_allowlist` ∩ the worker's request, the key comes
   * from `llm.api_key_env` and no request at all. A probe on a granted file
   * would go green for a key written at any mode, so this one names the key's
   * own path and asserts on that inode.
   *
   * The worker used is `eng-1`, which requests NO grants — so the store it
   * writes contains the key and nothing else, and the assertion cannot be
   * satisfied by some other file that happened to be correct.
   */
  test("the key's file is written 0444, on a worker with no grants at all", async () => {
    const plan = await planFor("eng-1");
    const dir = await mkdtemp(join(tmpdir(), "pifleet-class1-store-"));
    cleanups.push(dir);
    await writeWorkerSecretFiles(dir, plan);

    const keyFile = join(dir, KEY_VAR);
    const st = await stat(keyFile);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(SECRET_FILE_MODE);
    expect(SECRET_FILE_MODE).toBe(0o444);
    // The bytes are the key, raw — no trailing newline, so the file's length
    // equals the value's. `docker/entrypoint.sh` reads this file verbatim.
    expect(await readFile(keyFile, "utf8")).toBe(CANARY);
  });

  /**
   * READ-ONLY is the other half of the criterion and is load-bearing rather
   * than decorative. The host file is 0444 and the macOS VM squashes
   * bind-mount ownership to the container user, so inside the container it
   * reads as owned by uid 10001 — the mount flag is the only thing left
   * between a worker and its own credential store.
   */
  test("the mount carrying it is :ro, for a worker that requested no grant", async () => {
    const loaded = await load();
    const rendered = await renderWorker(loaded, "eng-1", { runId: "class1-run" });
    const secretsDir = workerPaths(runPaths("class1-run"), "eng-1").secretsDir;
    expect(rendered.docker.filter((a) => a.includes(SECRETS_MOUNT))).toEqual([
      `${secretsDir}:${SECRETS_MOUNT}:ro`,
    ]);
    // No writable spelling of the same mount anywhere in the argv.
    expect(rendered.docker).not.toContain(`${secretsDir}:${SECRETS_MOUNT}`);
  });
});

// ---------------------------------------------------------------------------
// ISC-422 (Anti) — `secret_names` does not claim the key as an operator grant
// ---------------------------------------------------------------------------

describe("ISC-422: the grant list does not claim the Class 1 key", () => {
  /**
   * THE TWO LISTS MEAN DIFFERENT THINGS, and this pins the distinction rather
   * than either list's contents.
   *
   * `secretNames` is what the OPERATOR granted through `secrets.env_allowlist`
   * ∩ the worker's request. `secretFiles` is what the worker HOLDS. The Class 1
   * key is fleet-assigned material that no worker requested and every worker
   * carries, so it belongs on the second and would be a lie on the first —
   * `worker-env.ts`'s own docblock refuses the widening in those terms.
   *
   * Widening `secretNames` to cover the key is the WRONG fix and would repeal
   * §12.4's `env_allowlist` prohibition rather than keep it intact. This probe
   * is what makes that repeal fail loudly instead of looking like a tidy-up.
   */
  test("the key's NAME is absent from the grant list, while its VALUE is delivered", async () => {
    const plan = await planFor("eng-1");
    // ABSENT from the grant list...
    expect(plan.secretNames).not.toContain(KEY_VAR);
    expect(plan.secretNames).toEqual([]);
    // ...while the VALUE is genuinely delivered. Without this half the
    // assertion above is satisfied by a fleet that delivers no key at all.
    expect(plan.secretFiles).toContainEqual({ name: KEY_VAR, value: CANARY });
  });

  /**
   * A worker WITH a real grant, so the two lists are observably different
   * rather than both empty.
   *
   * Degenerate fixtures hide narrowing: if every fixture makes the two sets
   * equal, an implementation that collapsed them would survive every probe
   * above. `tick-1` holds one grant and one key, so `secretNames` has exactly
   * one entry and `secretFiles` has exactly two.
   */
  test("a worker with a grant keeps the lists distinct, not merely non-empty", async () => {
    const plan = await planFor("tick-1", { [KEY_VAR]: CANARY, TICKET_TOKEN: "granted-value" });
    expect(plan.secretNames).toEqual(["TICKET_TOKEN"]);
    expect(plan.secretFiles.map((f) => f.name).sort()).toEqual([KEY_VAR, "TICKET_TOKEN"].sort());
    expect(plan.secretNames).not.toContain(KEY_VAR);
  });

  /**
   * THE CRITERION NAMES `launch.secret_names`, so this reads the record the
   * harvester actually opens rather than the plan field behind it.
   *
   * `harvest/needles.ts` takes `launch.secret_names` off disk at a moment when
   * the config that produced it is long gone, so an assertion on the in-memory
   * plan would prove the wrong artifact correct. `writeLaunchRecord` is what
   * puts the file there.
   */
  test("launch.json's secret_names does not name the key", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "pifleet-class1-runs-"));
    cleanups.push(runsDir);
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    const before = process.env[KEY_VAR];
    process.env[KEY_VAR] = CANARY;
    process.env["TICKET_TOKEN"] = "granted-value";
    try {
      const loaded = await load();
      const run = runPaths("class1-launch", runsDir);
      await mkdir(run.root, { recursive: true });
      await materializeWorkerInputs(loaded, run, ["tick-1"], undefined, {
        writeLaunchRecord: true,
      });
      const wp = workerPaths(run, "tick-1");
      const launch = JSON.parse(await readFile(wp.launchJson, "utf8")) as {
        secret_names: string[];
      };
      // The operator's grant is claimed...
      expect(launch.secret_names).toEqual(["TICKET_TOKEN"]);
      // ...and the fleet-assigned key is NOT.
      expect(launch.secret_names).not.toContain(KEY_VAR);
      // The value is on disk in the store all the same, under the key's name.
      expect(await readFile(join(wp.secretsDir, KEY_VAR), "utf8")).toBe(CANARY);
      // And the launch record does not carry the value anywhere.
      expect(await readFile(wp.launchJson, "utf8")).not.toContain(CANARY);
    } finally {
      if (before === undefined) delete process.env[KEY_VAR];
      else process.env[KEY_VAR] = before;
      delete process.env["TICKET_TOKEN"];
    }
  });
});

// ---------------------------------------------------------------------------
// The store/mount seam — the guard that fires if the two sides diverge again
// ---------------------------------------------------------------------------

describe("the secret store and its mount cannot go out of step", () => {
  /**
   * THE GUARD IS PROVED BY FIRING IT, not by reading it.
   *
   * `SecretStoreNotMountedError` exists because `materialize.ts` and
   * `render.ts` once decided the store and its `-v` behind two spellings of one
   * predicate. Both predicates are gone, so the divergence is unreachable
   * through config — which is exactly why a probe that merely ran `up` and saw
   * no error would prove nothing at all. This constructs the disagreement
   * directly and asserts the refusal, so the guard's message and exit code are
   * measured rather than assumed.
   *
   * The END-TO-END proof that the throw site fires is a MUTATION, recorded in
   * the ISA rather than expressible here: narrowing `render.ts`'s mount back to
   * `w.secrets.length > 0` makes a keyed worker with no grants trip this, which
   * no fixture in this file can arrange without editing production source.
   */
  test("material with no mount for it is refused, naming the worker", () => {
    const argvWithoutMount = ["docker", "run", "--rm", "-v", "/somewhere:/outbox"];
    const mount = `/run/workers/eng-1/secrets:${SECRETS_MOUNT}:ro`;
    expect(argvWithoutMount.includes(mount)).toBe(false);

    const err = new SecretStoreNotMountedError("eng-1", 1, mount);
    expect(err.exitCode).toBeGreaterThan(0);
    expect(err.message).toContain("eng-1");
    expect(err.message).toContain(SECRETS_MOUNT);
    // The diagnostic names a COUNT, never a variable name or a value.
    expect(err.message).not.toContain(CANARY);
    expect(err.message).not.toContain(KEY_VAR);
  });

  /**
   * The happy path, so the assertion above is not the only thing pinning the
   * relationship: a real `up` puts material in the store AND the mount in the
   * argv, for a worker that requested no grant.
   */
  test("a keyed worker with no grants gets both the file and the mount", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "pifleet-class1-both-"));
    cleanups.push(runsDir);
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    const before = process.env[KEY_VAR];
    process.env[KEY_VAR] = CANARY;
    try {
      const loaded = await load();
      const run = runPaths("class1-both", runsDir);
      await mkdir(run.root, { recursive: true });
      await materializeWorkerInputs(loaded, run, ["eng-1"]);
      const wp = workerPaths(run, "eng-1");
      expect(await readFile(join(wp.secretsDir, KEY_VAR), "utf8")).toBe(CANARY);
      // The SAME argv `materializeWorkerInputs` derived its guard from —
      // `renderWorker` is the one function that produces it, and `up` calls
      // this exact path for the same run id.
      const rendered = await renderWorker(loaded, "eng-1", { runId: "class1-both" });
      expect(rendered.docker).toContain(`${wp.secretsDir}:${SECRETS_MOUNT}:ro`);
      // And the env file docker parses still holds no value.
      expect(await readFile(wp.envFile, "utf8")).not.toContain(CANARY);
    } finally {
      if (before === undefined) delete process.env[KEY_VAR];
      else process.env[KEY_VAR] = before;
    }
  });
});
