/**
 * Granted secrets are FILES, and the environment carries only the path
 * (ISC-334 .. ISC-339).
 *
 * ## The measurement that caused this
 *
 * A worker was told, in its role prompt AND in its mounted skill, never to
 * echo its credential. Its second command was `echo $TICKET_API_TOKEN |
 * head -c 20`. The full value landed in the host's `events.jsonl`, in the
 * session transcript, and — because tool output is fed back to the model — on
 * the wire to the inference server.
 *
 * Redaction at the event seam stops that value PERSISTING. It does not stop it
 * EXISTING. While the value is an environment variable, `echo $NAME`, `env`
 * and `set` are all ordinary things for an agent to do, and each of them is
 * one token away at every turn. So these probes are about the value having
 * stopped being an environment variable at all.
 *
 * ## Why the anti-criterion is spawned rather than looked up
 *
 * `expect(plan.vars["TICKET_API_TOKEN"]).toBeUndefined()` is a statement about
 * a JavaScript object. The criterion is a statement about what a worker's
 * SHELL prints, and the two are only the same thing if `--env-file` delivers
 * exactly `plan.vars` — which is the assumption most worth not making. So
 * ISC-338 runs a real `/bin/sh` with `plan.vars` as its ENTIRE environment and
 * asserts on stdout. The plan under it is built from `fleet.example.yaml`, the
 * document an operator actually copies, not from a fixture written to pass.
 *
 * ## What these probes deliberately do NOT claim
 *
 * That the credential is unreachable. A worker can still `cat` the file, and
 * what it cats lands in the same transcript the `echo` did. The change is from
 * an ACCIDENTAL disclosure to a DELIBERATE one that has to name the file. That
 * is narrower, and it is not a seal.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, parseConfig, resolveWorker } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { materializeWorkerInputs } from "../../src/run/materialize.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import {
  SECRETS_MOUNT,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  SecretFileWriteError,
  buildWorkerEnv,
  secretContainerPath,
  secretPointerName,
  serializeEnvFile,
  writeWorkerEnvFile,
  writeWorkerSecretFiles,
} from "../../src/run/worker-env.ts";

const EXAMPLE = join(import.meta.dir, "..", "..", "fleet.example.yaml");
const REAL_SKILL = join(import.meta.dir, "..", "..", "skills", "pifleet-worker", "SKILL.md");

/**
 * A value distinctive enough that a substring search for it means something.
 *
 * Every "never appears" assertion below is a `.toContain` against this string.
 * A short or wordlike token would make those pass for the wrong reason.
 */
const TOKEN = "tok-canary-6b1f-4ac9-never-in-any-environment";
const BASE_URL = "https://tickets.example.invalid/api/v2";

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const modeOf = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

/** The env plan the SHIPPED example's ticketing worker would launch with. */
async function examplePlan() {
  const loaded = await loadConfig(EXAMPLE);
  return buildWorkerEnv(loaded, resolveWorker(loaded, "tick-1"), {
    TICKET_API_TOKEN: TOKEN,
    TICKET_BASE_URL: BASE_URL,
  });
}

describe("ISC-334: the VALUE is absent from the rendered env file", () => {
  /**
   * The criterion stated directly, against the bytes docker reads.
   *
   * Not against `plan.vars` — that is one step upstream, and the whole failure
   * this replaces was a value reaching a durable artifact. `writeWorkerEnvFile`
   * is what produces that artifact, so the file it wrote is what gets searched.
   */
  test("the token is nowhere in the file writeWorkerEnvFile produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-envfile-"));
    cleanups.push(dir);
    const path = join(dir, "env");
    const plan = await examplePlan();
    await writeWorkerEnvFile(path, plan);
    const bytes = await readFile(path, "utf8");

    expect(bytes).not.toContain(TOKEN);
    // The CONTROL, and it is not optional: an empty file, or a build that
    // stopped delivering the secret at all, satisfies the line above
    // perfectly. The pointer being present is what makes the absence mean
    // "delivered by another route" rather than "not delivered".
    expect(bytes).toContain(`${secretPointerName("TICKET_API_TOKEN")}=`);
  });

  test("nor in the serializer's output for any variable in the plan", async () => {
    const plan = await examplePlan();
    expect(serializeEnvFile(plan.vars)).not.toContain(TOKEN);
    // Every VALUE, not just the one named after the secret: a copy into some
    // other variable is exactly how a delivery guarantee gets undone by
    // something that reads a different key.
    for (const value of Object.values(plan.vars)) expect(value).not.toContain(TOKEN);
  });
});

describe("ISC-335: the environment carries the PATH", () => {
  test("the pointer names the container path, under the mount", async () => {
    const plan = await examplePlan();
    const pointer = plan.vars[secretPointerName("TICKET_API_TOKEN")];
    expect(pointer).toBe(secretContainerPath("TICKET_API_TOKEN"));
    expect(pointer).toBe(`${SECRETS_MOUNT}/TICKET_API_TOKEN`);
  });

  /**
   * The pointer is a PATH and not the value under a different name — asserted
   * because "rename the variable" is the shape this change would degrade into
   * if someone later found the file layer inconvenient, and nothing else here
   * would notice.
   */
  test("the pointer's value is a path, not a credential", async () => {
    const plan = await examplePlan();
    for (const name of ["TICKET_API_TOKEN", "TICKET_BASE_URL"]) {
      const pointer = plan.vars[secretPointerName(name)]!;
      expect(pointer.startsWith(`${SECRETS_MOUNT}/`)).toBe(true);
      expect(pointer).not.toContain(TOKEN);
      expect(pointer).not.toContain(BASE_URL);
    }
  });
});

describe("ISC-338 [ANTI-CRITERION]: a worker that runs `echo $NAME` gets an empty string", () => {
  /**
   * A real shell, with the plan as its ENTIRE environment.
   *
   * `Bun.spawn`'s `env` REPLACES rather than extends, so what this `/bin/sh`
   * can see is exactly what `--env-file` delivers and nothing the test process
   * happens to be holding. `printf %s` rather than `echo` so a trailing
   * newline cannot be mistaken for content.
   */
  async function expand(vars: Record<string, string>, expr: string): Promise<string> {
    const p = Bun.spawn(["/bin/sh", "-c", `printf %s "${expr}"`], {
      env: vars,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return out;
  }

  test("`echo $TICKET_API_TOKEN` expands to nothing, in a real shell", async () => {
    const plan = await examplePlan();
    expect(await expand(plan.vars, "$TICKET_API_TOKEN")).toBe("");
  });

  /**
   * THE CONTROL for the assertion above, and the reason it is a separate test
   * rather than a second line in the same one.
   *
   * An empty expansion is what a BROKEN harness also produces — a bad `env:`
   * option, a shell that never ran, a plan that failed to build. So the same
   * shell, with the same environment, is asked to expand the POINTER, and it
   * must print the container path. One of these going red without the other is
   * a finding; both going red at once is a broken probe.
   */
  test("the pointer DOES expand, in the same shell with the same environment", async () => {
    const plan = await examplePlan();
    expect(await expand(plan.vars, "$TICKET_API_TOKEN_FILE")).toBe(
      secretContainerPath("TICKET_API_TOKEN"),
    );
  });

  /**
   * `env` and `set` are the other two spellings of the same accident, and they
   * do not name a variable — they dump all of them. A worker running either is
   * doing something entirely reasonable, which is precisely why the value must
   * not be there to be swept up.
   */
  test("`env` dumps the whole environment and the token is not in it", async () => {
    const plan = await examplePlan();
    const p = Bun.spawn(["/bin/sh", "-c", "env; set"], {
      env: plan.vars,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("TICKET_API_TOKEN_FILE=");
  });
});

describe("ISC-336: the file the value went to", () => {
  async function written(): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-secretfiles-"));
    cleanups.push(dir);
    const store = join(dir, "secrets");
    await writeWorkerSecretFiles(store, await examplePlan());
    return { dir: store, file: join(store, "TICKET_API_TOKEN") };
  }

  /**
   * 0444, and the number is the one place this implementation deliberately
   * differs from the brief that asked for 0400.
   *
   * 0400 is owner-read-only and the owner is the OPERATOR, while the process
   * that must read the file runs as the image's baked uid 10001. A Linux bind
   * mount passes host ownership through untouched, so a 0400 file is simply
   * unreadable to the worker there — and INVISIBLY so on this machine, because
   * the macOS Docker VM squashes bind-mount ownership to the container user
   * and 0400 reads back perfectly. That is the gotcha `container/mounts.ts`
   * already records for 0600, and CI is `ubuntu-latest`.
   *
   * So the mode is the tightest one uid 10001 can actually read, and what 0400
   * was reaching for is bought a level up — see the worker-directory assertion
   * below. This probe is a host-side `stat` and is therefore platform-neutral:
   * it cannot pass on a Mac for a reason it would fail on Linux.
   */
  test("is 0444 — readable by the worker uid, writable by nobody", async () => {
    const { file } = await written();
    expect(await modeOf(file)).toBe(SECRET_FILE_MODE);
    expect(SECRET_FILE_MODE & 0o222).toBe(0);
  });

  /** The mounted inode needs the execute bit or the container cannot traverse it. */
  test("sits in a directory the worker uid can traverse", async () => {
    const { dir } = await written();
    expect(await modeOf(dir)).toBe(SECRET_DIR_MODE);
    expect(SECRET_DIR_MODE & 0o111).toBe(0o111);
  });

  /**
   * The RAW value and nothing else. No trailing newline, deliberately: the
   * documented call in `skills/ticket-ops/SKILL.md` concatenates these bytes
   * into a curl `header = "..."` line, and a newline would end the header
   * mid-quote.
   */
  test("holds the raw value with no trailing newline", async () => {
    const { file } = await written();
    expect(await readFile(file, "utf8")).toBe(TOKEN);
  });

  test("one file per granted name, and no file for anything else", async () => {
    const { dir } = await written();
    expect(await readFile(join(dir, "TICKET_BASE_URL"), "utf8")).toBe(BASE_URL);
    expect(await stat(join(dir, "PIFLEET_HONEYPOT")).catch(() => null)).toBeNull();
  });
});

describe("ISC-337: the mount is read-only", () => {
  async function ticketingArgv(): Promise<{ argv: string[]; secretsDir: string }> {
    const loaded = await loadConfig(EXAMPLE);
    const rendered = await renderWorker(loaded, "tick-1", { runId: "secfiles-run" });
    const run = runPaths("secfiles-run");
    return { argv: rendered.docker, secretsDir: workerPaths(run, "tick-1").secretsDir };
  }

  /**
   * `:ro` is load-bearing rather than decorative here, for a reason specific to
   * this mount. The host file is 0444, and the macOS VM squashes bind-mount
   * ownership to the container user — so INSIDE the container that file reads
   * as owned by uid 10001, and the mount flag is the only thing left standing
   * between a worker and its own credential store. Exactly the argument
   * `/policy/cloud-allow:ro` already makes about the verbgate policy.
   */
  test("the ticketing worker's secret store is mounted :ro at the fixed path", async () => {
    const { argv, secretsDir } = await ticketingArgv();
    expect(argv).toContain(`${secretsDir}:${SECRETS_MOUNT}:ro`);
  });

  /**
   * The mount is derived from `run/paths.ts` and not joined at the mount site.
   * A bind mount whose two sides disagree does NOT fail — Docker creates the
   * missing source — so the worker would come up with an empty `/secrets` and
   * no error anywhere, which is ISC-188's recorded failure shape applied to a
   * credential.
   */
  test("no writable spelling of the same mount is emitted", async () => {
    const { argv, secretsDir } = await ticketingArgv();
    expect(argv).not.toContain(`${secretsDir}:${SECRETS_MOUNT}`);
    const mounts = argv.filter((a) => a.includes(SECRETS_MOUNT));
    expect(mounts).toEqual([`${secretsDir}:${SECRETS_MOUNT}:ro`]);
  });

  /**
   * A worker that asked for nothing gets NO mount, rather than an empty
   * directory. A mount emitted unconditionally is one nobody notices has
   * stopped tracking the thing it exists for.
   */
  test("a worker with no secrets: gets no mount at all", async () => {
    const loaded = await loadConfig(EXAMPLE);
    const rendered = await renderWorker(loaded, "eng-1", { runId: "secfiles-run" });
    expect(rendered.docker.filter((a) => a.includes(SECRETS_MOUNT))).toEqual([]);
  });
});

describe("ISC-339: a secret file that did not land refuses the launch", () => {
  /**
   * The verification is a RE-READ, not a trusted return value.
   *
   * `writeFile` resolving says the syscalls returned; it does not say the
   * bytes are on disk at the right size, in a regular file, at a mode the
   * worker can read. `/dev/null` is the cleanest available proof of that gap:
   * every write to it succeeds and every read of it comes back empty, so a
   * writer that trusted its own return value would report success on a
   * credential store containing nothing.
   */
  test("a destination that swallows writes is caught by the read-back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-secretnull-"));
    cleanups.push(dir);
    const store = join(dir, "secrets");
    await mkdir(store, { recursive: true });
    await symlink("/dev/null", join(store, "TICKET_API_TOKEN"));

    const err = await writeWorkerSecretFiles(store, await examplePlan()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretFileWriteError);
    // Named, not silent — and the message must not quote what it was writing.
    expect((err as Error).message).toContain("TICKET_API_TOKEN");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  /**
   * The same failure at LAUNCH, which is where it has to be loud. A worker
   * that starts with a credential file missing does not fail at `up` — it
   * fails minutes later inside whatever HTTP call needed the value, which is
   * §5.9's quiet-failure shape with a perfectly well-formed pointer on top.
   */
  test("materializeWorkerInputs rejects, naming the worker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-secretlaunch-"));
    cleanups.push(dir);
    const runsDir = join(dir, "runs");
    const before = process.env["PIFLEET_RUNS_DIR"];
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    process.env["TICKET_TOKEN"] = TOKEN;
    try {
      const doc = {
        version: 2,
        name: "secret-launch-fixture",
        docker: { pi_version: "0.79.6" },
        run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "FixtureModel" },
        secrets: { env_allowlist: ["TICKET_TOKEN"] },
        roles: { tick: { secrets: ["TICKET_TOKEN"] } },
        workers: [{ id: "tick-x", role: "tick" }],
      };
      const path = join(dir, "fleet.yaml");
      await writeFile(path, stringify(doc));
      const loaded = await parseConfig(await Bun.file(path).text(), path);
      const run = runPaths("mat-secret-run", runsDir);
      await mkdir(run.root, { recursive: true });

      // The store is a FILE where a directory has to go, so `mkdir` cannot
      // succeed. A hostile or merely stale run directory is the realistic
      // cause; the point is that the launch stops rather than continuing with
      // an env file pointing at nothing.
      const paths = workerPaths(run, "tick-x");
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.secretsDir, "not a directory\n");

      const err = await materializeWorkerInputs(loaded, run, ["tick-x"]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("tick-x");
      expect((err as Error).message).not.toContain(TOKEN);
      // And the env file that would have pointed at the missing store was
      // never written — the ordering that makes this true is deliberate.
      expect(await stat(paths.envFile).catch(() => null)).toBeNull();
    } finally {
      if (before === undefined) delete process.env["PIFLEET_RUNS_DIR"];
      else process.env["PIFLEET_RUNS_DIR"] = before;
      delete process.env["TICKET_TOKEN"];
    }
  });
});

/**
 * The host-side half of ISC-336, and the reason 0444 is not a regression
 * against the 0600 env file it replaces.
 *
 * World-readable bytes under a world-traversable run directory would be
 * strictly worse than what this change removed. The protection moves up one
 * level instead: at 0700 no other account on the host can traverse into
 * `<run>/workers/<id>` at all. It costs the container nothing, and that is
 * measured rather than assumed — `materialize.ts` records that a bind mount is
 * established by the privileged runtime and the containerized process reaches
 * the path at its MOUNTPOINT in its own namespace, never walking the host
 * chain.
 */
describe("ISC-336: the worker directory holding the store is operator-only", () => {
  test("materialize leaves <run>/workers/<id> at 0700", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-secretdir-"));
    cleanups.push(dir);
    const runsDir = join(dir, "runs");
    const skillsRoot = join(dir, "skillsrc");
    await mkdir(join(skillsRoot, "pifleet-worker"), { recursive: true });
    await writeFile(
      join(skillsRoot, "pifleet-worker", "SKILL.md"),
      await readFile(REAL_SKILL, "utf8"),
    );
    const beforeRuns = process.env["PIFLEET_RUNS_DIR"];
    const beforeSkills = process.env["PIFLEET_SKILLS_DIR"];
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    process.env["PIFLEET_SKILLS_DIR"] = skillsRoot;
    process.env["TICKET_TOKEN"] = TOKEN;
    try {
      const doc = {
        version: 2,
        name: "secret-dir-fixture",
        docker: { pi_version: "0.79.6" },
        run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "FixtureModel" },
        secrets: { env_allowlist: ["TICKET_TOKEN"] },
        roles: { tick: { secrets: ["TICKET_TOKEN"], skills: ["pifleet-worker"] } },
        workers: [{ id: "tick-y", role: "tick" }],
      };
      const path = join(dir, "fleet.yaml");
      await writeFile(path, stringify(doc));
      const loaded = await parseConfig(await Bun.file(path).text(), path);
      const run = runPaths("mat-secret-dir", runsDir);
      await mkdir(run.root, { recursive: true });

      await materializeWorkerInputs(loaded, run, ["tick-y"]);
      const paths = workerPaths(run, "tick-y");
      expect(await modeOf(paths.dir)).toBe(0o700);
      expect(await modeOf(paths.secretsDir)).toBe(SECRET_DIR_MODE);
      expect(await modeOf(join(paths.secretsDir, "TICKET_TOKEN"))).toBe(SECRET_FILE_MODE);
      // And the env file beside it still carries no value.
      expect(await readFile(paths.envFile, "utf8")).not.toContain(TOKEN);
    } finally {
      if (beforeRuns === undefined) delete process.env["PIFLEET_RUNS_DIR"];
      else process.env["PIFLEET_RUNS_DIR"] = beforeRuns;
      if (beforeSkills === undefined) delete process.env["PIFLEET_SKILLS_DIR"];
      else process.env["PIFLEET_SKILLS_DIR"] = beforeSkills;
      delete process.env["TICKET_TOKEN"];
    }
  });
});
