/**
 * ISC-31 and ISC-127 read back out of `docker inspect`, against a container
 * started from the argv PRODUCTION rendered (SRD §5.5, §5.6).
 *
 * Both criteria are worded as observations on a real container — "`docker
 * inspect` shows no cloud provider key in any container's environment", "the
 * run-dir is not mounted in any container" — so both need a real container.
 * The unit halves (`test/unit/container-env.test.ts` for ISC-31,
 * `test/unit/render.test.ts` for ISC-127) catch the mistake at the point it is
 * typed and run with no daemon on every push; this catches a container whose
 * actual shape differs from the argv, which is the only failure the argv-level
 * check structurally cannot see.
 *
 * ## The container is production's, not this file's
 *
 * This does NOT hand-build a `docker run`. It calls `renderWorker` for the
 * argv and `materializeWorkerInputs` to create the host paths that argv
 * mounts — the same two functions `up` uses — and then changes exactly three
 * things, each of which is a way of running the same container without an
 * agent in it:
 *
 *   1. `-d` and a sleeping entrypoint replace the `pi` command, so the
 *      container is alive to be inspected instead of exiting immediately.
 *   2. `--name` is made unique per test, so concurrent runs do not collide.
 *   3. the image is the locally built test image.
 *
 * Every flag that bears on either criterion — the `-e` set, the `--env-file`,
 * and the whole `-v` mount table — is passed through UNTOUCHED. That is the
 * property that makes this evidence about production rather than about a
 * shape a test invented, and it is the specific mistake ISC-255 records
 * adc.test.ts having made for a whole phase.
 *
 * ## What it cannot prove, stated plainly
 *
 * `up` does not launch worker containers today — nothing in `src/` execs
 * `buildDockerArgv`'s output, and the mint/inject wiring is tracked as
 * ISC-248. So this starts the container the argv describes rather than
 * observing one a real run left behind. It is a faithful execution of
 * production's own argv, not a recording of production running.
 *
 * The `--env-file` is written EMPTY here, and production writes it not at all
 * (`run/materialize.ts` says why: an empty env file is semantically wrong for
 * a real worker, so leaving it absent makes a premature launch fail loudly).
 * An empty file is therefore the honest stand-in: it adds nothing to the
 * environment, so what `docker inspect` reports is exactly the image's baked
 * `ENV` plus whatever the argv's `-e` flags add — which is the surface both
 * criteria are about.
 *
 * `isolation: none` is used deliberately. It is a supported production shape
 * (SRD §5.5 — a role that works against live systems rather than the repo),
 * and it keeps `/workspace` out of the mount table so this file needs no git
 * worktree to exist. The `/workspace` mount is the one an operator can point
 * anywhere, and the ancestor case that creates is covered where it belongs:
 * at the argv altitude in render.test.ts, which can drive `run.repo` through
 * every value without needing the directory to be real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { realExec } from "../../src/container/run.ts";
import { makeDaemonScratch } from "../../src/container/mounts.ts";
import { loadConfig } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { materializeWorkerInputs } from "../../src/run/materialize.ts";
import { ensureControlAuth } from "../../src/security/control-auth.ts";
import { CREDENTIAL_ENV_VARS } from "../../src/security/adc.ts";
import { classifyRunDirExposure, runPaths } from "../../src/run/paths.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] container-env integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

const PERMITTED_KEY = "OMLX_API_KEY";

/** Same structural rule as the unit half; see it for why `_FILE` is excluded. */
function isSecretShaped(name: string): boolean {
  if (name === PERMITTED_KEY) return false;
  if (name.endsWith("_FILE")) return false;
  return /(^|_)(KEY|SECRET|TOKEN|CREDENTIALS?|PASSWORD|PASSWD)$/.test(name);
}

/**
 * Per-test budget for the two Docker-gated cases below, which had none.
 *
 * This was the only Docker-gated file in the suite running on bun's 5000 ms
 * default, against a body that does `makeDaemonScratch` + `loadConfig` +
 * `materializeWorkerInputs` + `renderWorker` + `ensureControlAuth` +
 * `docker run -d` + `docker inspect`, with a `docker rm -f` in teardown.
 *
 * MEASURED on this machine, warm daemon, image already built, load 3.25:
 * whole file 371-391 ms across three runs; per test 170 ms and 152 ms;
 * `docker inspect` 20-50 ms; `docker run -d` plus `docker rm -f` 200-230 ms.
 * Three docker spawns per test, worst single ~250 ms rounded up.
 *
 * Deriving from those numbers the way ISC-266 derives `cliBudget` — worst
 * spawn x count x 3 (load inflation) x 2 (headroom) — gives 250 x 3 x 3 x 2 =
 * 4500 ms, which is UNDER bun's default. That result is the argument for this
 * constant rather than against it: it shows the 5 s default only looks
 * adequate because the daemon here is warm and the image already present,
 * which is the exact shape ISC-266 records — a budget that fits an idle
 * machine and fails elsewhere.
 *
 * The dominant term is not measurable on this box: on CI the first
 * `docker run` follows a build step against a cold daemon and a fresh overlay,
 * where container creation is orders of magnitude slower than 200 ms. Picking
 * a tight number from a warm measurement whose variation is not understood is
 * the ISC-267 mistake, so this matches the value every sibling Docker-gated
 * file already uses (`adc.test.ts`, eight times). It is still BOUNDED on
 * purpose: a genuinely hung `docker` fails, it just fails later.
 *
 * Deliberately NOT `cliBudget(N)`. That helper is calibrated to pifleet CLI
 * startup at 1900 ms per spawn; these tests spawn `docker`, which is a
 * different cost with a different distribution, so borrowing the number would
 * be a derivation in appearance only.
 */
const DOCKER_TEST_TIMEOUT_MS = 60_000;

const containers: string[] = [];
const scratches: string[] = [];
/**
 * Captured BEFORE the fixture sets it, and restored in the SAME hook that
 * deletes the directory it points at.
 *
 * `startRenderedWorker` assigns `PIFLEET_RUNS_DIR` to a `makeDaemonScratch`
 * directory and nothing put it back, while `afterEach` below `rm -rf`s that
 * directory — so this file finished holding the environment variable that
 * every run path in the codebase derives from, pointed at a path that no
 * longer exists.
 *
 * That leak is not theoretical and it is not confined to this file. bun does
 * NOT execute test files in argument order — measured, passing `zzz aaa mmm`
 * and `aaa mmm zzz` both ran `zzz, mmm, aaa` — it uses `readdir()` order,
 * which differs between APFS and a fresh Linux clone. The container job's real
 * order puts this file SECOND of seven, so five Docker-gated files ran after
 * it inheriting the dangling value. No argument of the form "this file sorts
 * last" can be relied on, which is exactly why the fix is to not leak rather
 * than to be positioned safely.
 *
 * Restored in `afterEach` rather than `afterAll` deliberately: the scratch is
 * destroyed per test, so anything later than that leaves a window in which the
 * variable names a deleted directory even within this file.
 */
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
afterEach(async () => {
  // Only containers THIS file started, by the exact name it chose.
  await Promise.all(containers.splice(0).map((n) => realExec(["docker", "rm", "-f", n])));
  for (const d of scratches.splice(0)) await rm(d, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

interface Started {
  name: string;
  runDir: string;
  /** The argv production rendered, before this file's three adjustments. */
  rendered: string[];
}

/**
 * Render + materialize + run one worker, and return its container name.
 *
 * The fixture root comes from `makeDaemonScratch`, not `os.tmpdir()`: on macOS
 * the Docker VM shares only a declared set of host directories and `/tmp` is
 * NOT among them, so a bind mount from there succeeds and comes up EMPTY
 * (`container/mounts.ts` documents the measurement). A CI runner is Linux and
 * does not care; using the daemon-visible root regardless is what lets the
 * same file run in both places.
 */
async function startRenderedWorker(): Promise<Started> {
  const root = await makeDaemonScratch("container-env");
  scratches.push(root);
  const repo = join(root, "repo");
  const runsDir = join(root, "runs"); // a SIBLING of the checkout (ISC-127)
  await mkdir(join(repo, "roles"), { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(repo, "roles", "eng.md"), "Engineer briefing.\n");
  process.env["PIFLEET_RUNS_DIR"] = runsDir;

  await writeFile(
    join(repo, "fleet.yaml"),
    stringify({
      version: 2,
      name: "container-env",
      // `network: none` so this needs no pre-created bridge; every other
      // docker setting is left at its schema default, which is the production
      // posture (read-only root, pids limit, memory, cpus).
      docker: { pi_version: "0.79.6", network: "none" },
      run: { root: "./decoy", repo: ".", budget: { tokens_ceiling: 1_000_000 } },
      llm: { model: "M", api_key_env: PERMITTED_KEY },
      // cloud_access ON — the role most likely to acquire a credential, and so
      // the one worth inspecting.
      cloud: { adc: true, adc_mode: "token" },
      roles: {
        eng: {
          model: "M",
          append_system_prompt_file: "./roles/eng.md",
          cloud_access: true,
          isolation: "none",
        },
      },
      workers: [{ id: "eng-1", role: "eng" }],
    }),
  );

  const loaded = await loadConfig(join(repo, "fleet.yaml"));
  const run = runPaths("envtest", runsDir);
  await materializeWorkerInputs(loaded, run, ["eng-1"]);
  // The 0600 per-run control secret, minted through production's own path.
  // ISC-127's whole subject: without it the containment check below has no
  // file to be about and passes on an `ENOENT` fallback instead. See that
  // assertion for the measurement.
  await ensureControlAuth(run);
  const rendered = await renderWorker(loaded, "eng-1", { runId: "envtest" });

  // The one input production deliberately leaves unwritten. Empty, so it
  // contributes nothing to the environment being inspected — see the header.
  const envFileIdx = rendered.docker.indexOf("--env-file");
  expect(envFileIdx).toBeGreaterThan(0);
  await writeFile(rendered.docker[envFileIdx + 1]!, "");

  const imageIdx = rendered.docker.indexOf(rendered.image);
  expect(imageIdx).toBeGreaterThan(0);
  const name = `pifleet-envtest-${Math.random().toString(36).slice(2, 10)}`;
  containers.push(name);

  // Flags between `docker run` and the image, with `-i`/`--rm` dropped (this
  // container is detached and removed explicitly) and `--name` repointed.
  const flags: string[] = [];
  for (let i = 2; i < imageIdx; i++) {
    const a = rendered.docker[i]!;
    if (a === "-i" || a === "--rm") continue;
    if (a === "--name") {
      flags.push("--name", name);
      i++;
      continue;
    }
    flags.push(a);
  }

  const r = await realExec([
    "docker", "run", "-d",
    ...flags,
    "--entrypoint", "bash", IMAGE, "-c", "sleep 300",
  ]);
  expect(`${r.code}: ${r.stderr.trim()}`).toBe("0: ");
  return { name, runDir: run.root, rendered: rendered.docker };
}

/** The container's environment, exactly as `docker inspect` reports it. */
async function envOf(name: string): Promise<string[]> {
  const r = await realExec(["docker", "inspect", name, "--format", "{{json .Config.Env}}"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout.trim()) as string[];
}

interface DockerMount {
  Source?: string;
  Destination?: string;
}

async function mountsOf(name: string): Promise<DockerMount[]> {
  const r = await realExec(["docker", "inspect", name, "--format", "{{json .Mounts}}"]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout.trim()) ?? []) as DockerMount[];
}

describe.skipIf(!DOCKER)("docker inspect on a rendered worker (ISC-31, ISC-127)", () => {
  /**
   * ISC-31's literal instrument.
   *
   * Every variable is checked by NAME against the structural secret shape and
   * against `adc.ts`'s own `CREDENTIAL_ENV_VARS`, and the assertion is a
   * rendered string so a failure names the offending variable rather than
   * printing `false is not true`.
   *
   * The image's baked `ENV` is inside this set, which is the reason the check
   * belongs here and not only at the argv altitude: a Dockerfile that started
   * baking a key would be invisible to every argv assertion in the repo.
   * Measured on the current image: PATH, NODE_VERSION, YARN_VERSION,
   * PI_OFFLINE, HOME, PIFLEET_CONTAINER, CLOUDSDK_CONFIG,
   * CLOUDSDK_CORE_DISABLE_PROMPTS, USE_GKE_GCLOUD_AUTH_PLUGIN — three gcloud
   * variables, all of which are configuration pointers rather than
   * credentials.
   *
   * Mutation check: adding `-e AWS_SECRET_ACCESS_KEY=...` to `buildDockerArgv`
   * turns this red. See the ISA close-out for the run.
   */
  test("no cloud provider key appears in the container environment (ISC-31)", async () => {
    const { name } = await startRenderedWorker();
    const env = await envOf(name);
    // Not vacuous: the image bakes a handful of variables, so an empty result
    // would mean `docker inspect` was misread rather than that the env is clean.
    expect(env.length).toBeGreaterThan(3);

    for (const entry of env) {
      const varName = entry.slice(0, Math.max(entry.indexOf("="), 0));
      expect(`${varName} (secret-shaped: ${isSecretShaped(varName)})`).toBe(
        `${varName} (secret-shaped: false)`,
      );
      for (const cred of CREDENTIAL_ENV_VARS) {
        // The pointer var is permitted BY NAME and carries a path, never a
        // token; the other three carry values and must be absent outright.
        if (cred === "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE") continue;
        expect(`${varName} === ${cred}`).not.toBe(`${cred} === ${cred}`);
      }
    }

    // "only OMLX_API_KEY" — the criterion's parenthetical. Today the rendered
    // worker sets no key at all, which is strictly stronger; asserting the
    // subset rather than the presence keeps this true either way.
    const keyNames = env
      .map((e) => e.slice(0, Math.max(e.indexOf("="), 0)))
      .filter((n) => /(^|_)KEY$/.test(n));
    for (const n of keyNames) expect(n).toBe(PERMITTED_KEY);
  }, DOCKER_TEST_TIMEOUT_MS);

  /**
   * ISC-127's literal instrument: the run-dir is not in `.Mounts`.
   *
   * Sources are `realpath`-normalised on both sides, for the reason ISC-44's
   * equivalent records: a lexical compare passes a symlinked source, and
   * `/tmp -> /private/tmp` on macOS is the everyday case. The run dir is
   * normalised too, or the comparison is between a resolved source and an
   * unresolved directory and every relation reads clean.
   *
   * The positive half is asserted first and is not decoration: this container
   * really does mount several run-dir CHILDREN, so "no mount is the run dir"
   * is a statement about a populated mount table rather than an empty one.
   *
   * Mutation check: adding `argv.push("-v", `${opts.run.root}:/rundir`)` to
   * `buildDockerArgv` turns this red. See the ISA close-out for the run.
   */
  test("the run directory is not mounted in the container (ISC-127)", async () => {
    const { name, runDir } = await startRenderedWorker();
    const mounts = await mountsOf(name);
    const norm = async (p: string): Promise<string> => realpath(p).catch(() => p);
    const runDirReal = await norm(runDir);

    const sources: string[] = [];
    for (const m of mounts) {
      if (!m.Source || m.Source === "") continue;
      sources.push(await norm(m.Source));
    }

    // Populated, and populated with run-dir children specifically.
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.startsWith(`${runDirReal}/`))).toBe(true);

    // The criterion. `classifyRunDirExposure` is production's own predicate,
    // so this and the launcher's guard cannot disagree about what counts.
    for (const s of sources) {
      expect(`${s} -> ${classifyRunDirExposure(s, runDirReal) ?? "clean"}`).toBe(`${s} -> clean`);
    }

    /**
     * What the criterion protects, named directly: the per-run control-socket
     * secret must not be reachable through any mount.
     *
     * This block was CONDITIONALLY VACUOUS and the condition was "macOS", i.e.
     * the platform it was written on. `control-auth.json` is minted by the
     * supervisor and `startRenderedWorker` never started one, so the file did
     * not exist, so `realpath` threw `ENOENT` and `norm`'s `.catch(() => p)`
     * handed back the UNRESOLVED path — while `runDirReal` beside it was
     * resolved. On this machine the scratch root is under `/var/folders/...`,
     * which is reached through the `/var -> /private/var` symlink, so the two
     * strings shared no prefix at all and every comparison below passed on the
     * mismatch rather than on the property. The mount table was never actually
     * consulted.
     *
     * Two changes, and the first is the one that matters: the secret is now
     * really minted, through `ensureControlAuth` — production's own path, not
     * a hand-written stand-in — so `realpath` resolves it and the check is
     * about the run directory that exists. It is also derived from
     * `runDirReal` rather than re-normalised independently, because a resolved
     * path compared against an unresolved one is exactly the failure being
     * fixed and re-deriving it invites the same drift back.
     *
     * `expect(exists)` first, because an assertion that the secret is not
     * inside any mount is worthless if the secret is not anywhere.
     */
    const secret = join(runDirReal, "control-auth.json");
    expect(await Bun.file(secret).exists()).toBe(true);
    for (const s of sources) {
      // Root-aware, for the reason `render.test.ts`'s equivalent records: when
      // `s` is `/` the naive `${s}/` builds `"//"` and prefixes nothing, so the
      // one mount that exposes everything would read clean.
      const prefix = s === "/" ? "/" : `${s}/`;
      expect(`${secret} under ${s}: ${secret.startsWith(prefix)}`).toBe(
        `${secret} under ${s}: false`,
      );
    }
  }, DOCKER_TEST_TIMEOUT_MS);
});
