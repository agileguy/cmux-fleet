/**
 * Renderer criteria (ISC-60, ISC-61, ISC-62, ISC-63, ISC-65, ISC-66).
 *
 * The exact-argv test compares normalized ARRAYS built from the fixture's own
 * temp directory, so nothing here encodes one machine's home directory. No
 * Docker daemon is touched anywhere in this file — that is the point of
 * ISC-60: `render` must be able to say exactly what `up` would run without
 * being able to run it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stringify } from "yaml";
import { exitCodeForError } from "../../src/cli/index.ts";
import { imageStatus } from "../../src/cli/commands/doctor.ts";
import { EXIT, isExitCoded } from "../../src/contracts.ts";
import { ConfigError, loadConfig, type LoadedConfig } from "../../src/config/load.ts";
import {
  assertNoAtPaths,
  renderAllWorkers,
  renderWorker,
  BRIEFING_MOUNT,
} from "../../src/config/render.ts";
import {
  assetDigestAt,
  BUILD_CONTEXT_ASSETS,
  BuildContextError,
  configHash,
  imageInputs,
  type BuildContextAsset,
  type ImageInputs,
} from "../../src/container/image.ts";
import type { Exec } from "../../src/container/run.ts";
import {
  CONTAINER_GCLOUD_CONFIG_DIR,
  CREDENTIAL_ENV_VARS,
  classifyHostGcloudExposure,
  gcloudConfigTmpfsArgv,
  hostGcloudConfigDir,
} from "../../src/security/adc.ts";
import { WORKER_UID } from "../../src/container/mounts.ts";
import {
  classifyRunDirExposure,
  roleSkillsDir,
  runPaths,
  runsRoot,
  workerOutboxDir,
  workerPaths,
} from "../../src/run/paths.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The digest of a build-context file as computed from the bytes on disk,
 * derived independently of `image.ts` so the ISC-160 assertions compare two
 * separately-arrived-at values rather than a function against itself.
 */
async function digestOnDisk(asset: BuildContextAsset): Promise<string> {
  const text = await readFile(join(REPO_ROOT, "docker", asset), "utf8");
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

const cleanups: string[] = [];
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

/**
 * The config field that used to name the runs root, kept in every fixture as a
 * DECOY (ISC-188).
 *
 * `run.root` is still a schema field with a default, and it is the value
 * `render` used to build its run directory from. It must now appear in no
 * rendered path at all, so it points somewhere `PIFLEET_RUNS_DIR` does not:
 * every existing path assertion below is thereby a live statement that the env
 * var won, and not — as it was when the two happened to name the same
 * directory — a statement that would hold either way.
 */
const DECOY_CONFIG_RUN_ROOT = "./config-runs";

/**
 * A self-contained fixture: config + briefing fragments + runs root, all inside
 * one temp dir so every rendered path is fixture-relative.
 *
 * Sets `PIFLEET_RUNS_DIR` rather than passing a root in, because that is the
 * seam `up` and the detached daemon use and the one `runsRoot()` reads. A
 * test-only injection parameter would have been a second way to answer the
 * question this criterion exists to make singular.
 */
async function fixture(mutate?: (doc: Record<string, unknown>) => void): Promise<{
  dir: string;
  /** PIFLEET_RUNS_DIR for this fixture — the root every rendered path is under. */
  runsDir: string;
  loaded: LoadedConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-render-"));
  cleanups.push(dir);
  /**
   * The runs root is a SIBLING of the checkout, never a child of it (ISC-127).
   *
   * It used to be `join(dir, "runs")`, i.e. inside the directory this fixture
   * also hands to `run.repo` — so `rev-1`, the `shared-ro` worker, mounted a
   * `/workspace` whose source CONTAINED the live run directory, and with it
   * `control-auth.json`, the ledger, the inbox and every other worker's state.
   * That is exactly the layout `assertNoRunDirMount` now refuses, and the
   * fixture was modelling it. A fixture is a claim about a supported shape;
   * this one is now a safe shape, and the unsafe one is asserted against
   * deliberately and by name in the ISC-127 block instead of arriving here by
   * accident. Same `mkdtemp`-sibling form the ISC-188 "moved" case already
   * used two hundred lines below.
   */
  const runsDir = await mkdtemp(join(tmpdir(), "pifleet-render-runs-"));
  cleanups.push(runsDir);
  process.env["PIFLEET_RUNS_DIR"] = runsDir;
  await mkdir(join(dir, "roles"), { recursive: true });
  await writeFile(join(dir, "roles", "common.md"), "Common fleet briefing.\n");
  await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");
  await writeFile(join(dir, "roles", "rev.md"), "Reviewer role briefing.\n");

  const doc: Record<string, unknown> = {
    version: 2,
    name: "render-fixture",
    docker: { pi_version: "0.79.6" },
    run: { root: DECOY_CONFIG_RUN_ROOT, repo: ".", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel", thinking: "medium" },
    defaults: { append_system_prompt_file: "./roles/common.md" },
    roles: {
      eng: {
        model: "Qwen3-Coder-30B-A3B-Instruct-4bit",
        toolchain: "node",
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        skills: ["pifleet-worker", "tdd", "diagnose"],
        append_system_prompt_file: "./roles/eng.md",
      },
      rev: {
        model: "Qwen3.5-35B-A3B-8bit",
        thinking: "high",
        tools: ["read", "grep", "find", "ls"],
        skills: ["pifleet-worker"],
        append_system_prompt_file: "./roles/rev.md",
        isolation: "shared-ro",
      },
    },
    workers: [
      { id: "eng-1", role: "eng", append_system_prompt: "Worker-specific note." },
      { id: "rev-1", role: "rev" },
    ],
  };
  mutate?.(doc);
  await writeFile(join(dir, "fleet.yaml"), stringify(doc));
  return { dir, runsDir, loaded: await loadConfig(join(dir, "fleet.yaml")) };
}

function countOf(argv: string[], flag: string): number {
  return argv.filter((a) => a === flag).length;
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Every host path the docker argv names for RUN STATE: the `--env-file` value
 * plus the host half of each bind mount.
 *
 * Two things are deliberately NOT run state and are excluded rather than
 * special-cased at each call site: the `/workspace` mount, which is the
 * operator's own repository and has nothing to do with the runs root, and
 * `pifleet-piagent-<id>`, which is a named volume and not a path at all.
 */
function runStateHostPaths(argv: string[]): string[] {
  const out: string[] = [];
  const envIdx = argv.indexOf("--env-file");
  if (envIdx !== -1) out.push(argv[envIdx + 1]!);
  argv.forEach((a, i) => {
    if (argv[i - 1] !== "-v") return;
    const sep = a.indexOf(":");
    const host = a.slice(0, sep);
    if (!host.startsWith("/")) return; // named volume
    if (a.slice(sep + 1).startsWith("/workspace")) return; // the operator's repo
    out.push(host);
  });
  return out;
}

/**
 * The host half of EVERY bind mount in the argv, with nothing excluded.
 *
 * The sibling `runStateHostPaths` above drops `/workspace` deliberately and
 * correctly — it answers "is every run-state path under the runs root", and
 * the operator's repo is not run state. Any criterion about what the container
 * can REACH must not use it: `/workspace`'s source is `run.repo`, the one
 * entry in the mount table that comes from operator config rather than from a
 * literal in `render.ts`, and therefore the only one that can be aimed at a
 * sensitive directory. An exemption that is right for one question is a blind
 * spot for the other, so the two have separate helpers rather than a flag.
 */
function allBindMountSources(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (argv[i - 1] !== "-v") return;
    const sep = a.indexOf(":");
    const host = sep === -1 ? a : a.slice(0, sep);
    if (!host.startsWith("/")) return; // named volume, not a host path
    out.push(host);
  });
  return out;
}

function valuesOf(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  });
  return out;
}

// ---------------------------------------------------------------------------

describe("exactly one --append-system-prompt (ISC-65)", () => {
  test("defaults + role + worker fragments fold into ONE flag and one file", async () => {
    const { runsDir, loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    expect(countOf(r.pi, "--append-system-prompt")).toBe(1);
    expect(countOf(r.docker, "--append-system-prompt")).toBe(1);
    expect(valueOf(r.pi, "--append-system-prompt")).toBe(BRIEFING_MOUNT);

    // The one file concatenates all three fragments, in merge order.
    expect(r.systemAppend).not.toBeNull();
    const content = r.systemAppend!.content;
    const a = content.indexOf("Common fleet briefing.");
    const b = content.indexOf("Engineer role briefing.");
    const c = content.indexOf("Worker-specific note.");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(r.systemAppend!.hostPath).toBe(
      join(runsDir, "dry", "workers", "eng-1", "system-append.md"),
    );
  });

  test("no fragments → no flag, no file, no briefing mount", async () => {
    const { loaded } = await fixture((doc) => {
      doc["defaults"] = {};
      const roles = doc["roles"] as Record<string, Record<string, unknown>>;
      delete roles["eng"]!["append_system_prompt_file"];
      doc["workers"] = [{ id: "eng-1", role: "eng" }];
    });
    const r = await renderWorker(loaded, "eng-1");
    expect(countOf(r.pi, "--append-system-prompt")).toBe(0);
    expect(r.systemAppend).toBeNull();
    expect(r.docker.some((a) => a.includes(BRIEFING_MOUNT))).toBe(false);
  });

  test("a missing briefing file is a loud, pathed error", async () => {
    const { loaded } = await fixture((doc) => {
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["append_system_prompt_file"] =
        "./roles/ghost.md";
    });
    await expect(renderWorker(loaded, "eng-1")).rejects.toThrow(/ghost\.md/);
  });
});

describe("no @-prefixed argv (ISC-66)", () => {
  test("no element of any rendered argv starts with @", async () => {
    const { loaded } = await fixture();
    for (const r of await renderAllWorkers(loaded)) {
      for (const a of [...r.docker, ...r.pi]) {
        expect(a.startsWith("@")).toBe(false);
      }
    }
  });

  /**
   * The test above passes against a renderer with NO guard at all: the fixture
   * contains no `@` anywhere, so it asserts a property of the fixture rather
   * than of the code. Deleting both `assertNoAtPaths` calls left the entire
   * suite green.
   *
   * The guard cannot be reached through config — `--skill` prefixes its value
   * with `/skills/`, the briefing path is a constant — so it is an invariant on
   * argv this module builds, and the only honest way to test it is directly.
   */
  test("the guard rejects an @-prefixed element and names it", () => {
    expect(() => assertNoAtPaths(["--model", "@evil"], "pi argv for eng-1")).toThrow(/@evil/);
  });

  test("the guard names which argv it was checking, since two are checked", () => {
    expect(() => assertNoAtPaths(["@x"], "docker argv for eng-1")).toThrow(/docker argv for eng-1/);
  });

  test("the guard passes clean argv through", () => {
    expect(() => assertNoAtPaths(["--model", "m", "--skill", "/skills/@ok"], "x")).not.toThrow();
  });

  /**
   * The guard returns its argv, so `renderWorker` cannot produce `pi` or
   * `docker` without passing through it.
   *
   * This replaced a source-text grep for the call sites, which survived every
   * way of disabling the calls except literal deletion — commenting them out
   * and wrapping them in `if (false)` both left the suite green. A dead call
   * site is the same as no call site, and a test that reads the file's text is
   * asserting about characters rather than behaviour.
   */
  test("the guard is in the data path, not beside it", () => {
    const argv = ["--model", "m"];
    expect(assertNoAtPaths(argv, "x")).toBe(argv); // identity: it IS the value
  });

  test("renderWorker still produces both argvs through the guard", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    expect(r.pi.length).toBeGreaterThan(0);
    expect(r.docker.length).toBeGreaterThan(0);
  });
});

describe("mandatory worker-shaping flags (SRD §12.2, §5.4)", () => {
  test("rpc mode, session identity, and all three discovery denials", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    expect(valueOf(r.pi, "--mode")).toBe("rpc");
    expect(valueOf(r.pi, "--session-id")).toBe("eng-1");
    expect(valueOf(r.pi, "--session-dir")).toBe("/sessions");
    expect(r.pi).toContain("--no-extensions");
    expect(r.pi).toContain("--no-skills");
    expect(r.pi).toContain("--no-context-files");
  });

  test("--skill is repeatable and additive, one per configured skill", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    expect(valuesOf(r.pi, "--skill")).toEqual([
      "/skills/pifleet-worker",
      "/skills/tdd",
      "/skills/diagnose",
    ]);
  });

  test("--tools renders the configured list; omitted entirely when unset", async () => {
    const { loaded } = await fixture((doc) => {
      (doc["roles"] as Record<string, unknown>)["bare"] = {};
      (doc["workers"] as unknown[]).push({ id: "bare-1", role: "bare" });
    });
    const eng = await renderWorker(loaded, "eng-1");
    expect(valueOf(eng.pi, "--tools")).toBe("read,write,edit,bash,grep,find,ls");
    const bare = await renderWorker(loaded, "bare-1");
    expect(bare.pi).not.toContain("--tools");
  });
});

describe("roles differ (ISC-62, ISC-63)", () => {
  test("two roles produce different --model values", async () => {
    const { loaded } = await fixture();
    const eng = await renderWorker(loaded, "eng-1");
    const rev = await renderWorker(loaded, "rev-1");
    expect(valueOf(eng.pi, "--model")).toBe("Qwen3-Coder-30B-A3B-Instruct-4bit");
    expect(valueOf(rev.pi, "--model")).toBe("Qwen3.5-35B-A3B-8bit");
    expect(valueOf(eng.pi, "--model")).not.toBe(valueOf(rev.pi, "--model"));
  });

  test("two roles produce different --skill sets", async () => {
    const { loaded } = await fixture();
    const eng = await renderWorker(loaded, "eng-1");
    const rev = await renderWorker(loaded, "rev-1");
    expect(valuesOf(eng.pi, "--skill")).not.toEqual(valuesOf(rev.pi, "--skill"));
    expect(valuesOf(rev.pi, "--skill")).toEqual(["/skills/pifleet-worker"]);
  });
});

describe("docker argv (SRD §5.6)", () => {
  test("hardening flags are present and read_only_root governs --read-only", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    expect(valueOf(r.docker, "--user")).toBe("10001:10001");
    expect(valueOf(r.docker, "--security-opt")).toBe("no-new-privileges");
    expect(valueOf(r.docker, "--cap-drop")).toBe("ALL");
    expect(r.docker).toContain("--read-only");
    expect(valueOf(r.docker, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,size=256m");
    expect(valueOf(r.docker, "--pids-limit")).toBe("512");
    expect(valueOf(r.docker, "--memory")).toBe("4g");
    expect(valueOf(r.docker, "--cpus")).toBe("2");
    expect(valueOf(r.docker, "--network")).toBe("pifleet-egress");

    const { loaded: soft } = await fixture((doc) => {
      (doc["docker"] as Record<string, unknown>)["read_only_root"] = false;
    });
    const r2 = await renderWorker(soft, "eng-1");
    expect(r2.docker).not.toContain("--read-only");
  });

  test("mount table follows isolation: worktree rw, shared-ro ro, none unmounted", async () => {
    const { dir, loaded } = await fixture((doc) => {
      (doc["roles"] as Record<string, unknown>)["field"] = { isolation: "none" };
      (doc["workers"] as unknown[]).push({ id: "field-1", role: "field" });
    });
    const eng = await renderWorker(loaded, "eng-1"); // run.isolation default → worktree
    expect(eng.docker).toContain(`${join(dir, ".worktrees", "eng-1")}:/workspace`);

    const rev = await renderWorker(loaded, "rev-1"); // role isolation → shared-ro
    expect(rev.docker).toContain(`${dir}:/workspace:ro`);

    const field = await renderWorker(loaded, "field-1"); // none → no code mount
    expect(field.docker.some((a) => a.includes(":/workspace"))).toBe(false);
  });

  test("state mounts: outbox, sessions, skills ro, container-local pi agent volume", async () => {
    const { runsDir, loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const runDir = join(runsDir, "dry");
    expect(r.docker).toContain(`${join(runDir, "outbox", "eng-1")}:/outbox`);
    expect(r.docker).toContain(`${join(runDir, "sessions")}:/sessions`);
    expect(r.docker).toContain(`${join(runDir, "skills", "eng")}:/skills:ro`);
    // NEVER the host ~/.pi/agent — a named volume keeps Dan's auth out (§5.5).
    expect(r.docker).toContain("pifleet-piagent-eng-1:/home/pi/.pi/agent");
    expect(r.docker.some((a) => a.includes(join("/.pi", "agent")) && a.startsWith("/"))).toBe(false);
  });

  /**
   * ISC-231. The mount and the harvest read are computed in different
   * subsystems, and a divergence between them does not throw — harvest would
   * find an empty directory and report a task that produced artifacts as
   * having produced none. So the agreement is asserted directly, against the
   * host path harvest actually hands to the outbox reader, rather than trusting
   * that both sides happen to still call the same helper.
   */
  test("the /outbox mount is the same directory harvest reads from", async () => {
    const { runsDir, loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const runDir = join(runsDir, "dry");

    const mounted = r.docker
      .find((a) => a.endsWith(":/outbox"))
      ?.slice(0, -":/outbox".length);
    expect(mounted).toBe(workerOutboxDir(runDir, "eng-1"));

    // And that shared path is the one the harvest side resolves for the same
    // worker, through the RunPaths struct it works from.
    const run = runPaths("dry", runsDir);
    expect(mounted).toBe(workerOutboxDir(run.root, "eng-1"));
  });

  test("kubeconfig mounts read-only only for cloud_access workers with cloud.kubeconfig set", async () => {
    const { runsDir, loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const eng = await renderWorker(loaded, "eng-1");
    // Against `WorkerPaths.kubeconfig`, not a string rebuilt here. The
    // credential mount is the one run-dir path this file used to spell out
    // literally, which made it the one path that could drift out of
    // `run/paths.ts` with this test still green (ISC-188).
    const kubeconfig = workerPaths(runPaths("dry", runsDir), "eng-1").kubeconfig;
    expect(eng.docker).toContain(`${kubeconfig}:/home/pi/.kube/config:ro`);
    const rev = await renderWorker(loaded, "rev-1"); // no cloud_access
    expect(rev.docker.some((a) => a.includes("/.kube/"))).toBe(false);
  });

  /**
   * ISC-44 — the host `~/.config/gcloud` directory (the FULL multi-account
   * gcloud auth store, `credentials.db` and all — SRD §5.8) must never appear
   * as a bind-mount source, for any worker, in either `adc_mode`.
   *
   * `renderWorker` is the exact function `up` calls to build the argv it
   * launches (ISC-188), so this is a statement about production code, not
   * about a hand-rolled re-implementation of the mount table. Checked against
   * `hostGcloudConfigDir()` — `adc.ts`'s own definition — rather than a second
   * `join(homedir(), ".config", "gcloud")` here, so the two cannot drift.
   *
   * Sources come from `allBindMountSources`, NOT from `runStateHostPaths`. The
   * latter drops every mount whose destination starts with `/workspace`, which
   * is correct for the run-state criteria it was written for and exactly wrong
   * here: `/workspace` is the mount whose source is `run.repo`, the one host
   * path in the whole table an operator controls, and therefore the only one
   * that can be pointed at `$HOME`. Routing ISC-44 through that helper made
   * this assertion blind to the single mount it most needed to see.
   *
   * Mutation check: temporarily adding
   * `argv.push("-v", `${hostGcloudConfigDir()}:/home/pi/.config/gcloud`)` to
   * `buildDockerArgv` (§5.6's mount table) turns this red — see the ISA
   * close-out for the confirmed run.
   */
  test("no rendered docker argv ever mounts the host gcloud config directory (ISC-44)", async () => {
    const { loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, adc_mode: "file", kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const store = hostGcloudConfigDir();
    for (const id of ["eng-1", "rev-1"]) {
      // eng-1: cloud_access true, adc_mode file (the mode most likely to grow
      // a credential mount). rev-1: cloud_access false — the other shape ISC-44
      // must hold for, since a role that gets no plan at all must still never
      // acquire this particular mount by accident.
      const r = await renderWorker(loaded, id);
      for (const a of r.docker) {
        expect(a).not.toContain(store);
      }
      // Explicitly on the `-v` SOURCE half of every bind mount, matching the
      // ISC's literal wording ("mount list", i.e. `docker inspect .Mounts`) —
      // not merely "the string never appears anywhere in argv", which a
      // future `--env` reference naming the path in prose would also satisfy
      // without actually mounting anything.
      const sources = allBindMountSources(r.docker);
      expect(sources).not.toContain(store);
      // BOTH directions. The trailing separator is what keeps
      // `~/.config/gcloud-backup` — a different directory this criterion says
      // nothing about — from turning this red for no reason; a false red is
      // how an assertion gets weakened later. `classifyHostGcloudExposure` is
      // the production predicate, so the test and the launcher agree by
      // construction rather than by two people writing the same `startsWith`.
      for (const s of sources) expect(classifyHostGcloudExposure(s)).toBeNull();
    }
  });

  /**
   * The ancestor direction, stated as its own case because the assertion above
   * would have passed without it for the entire life of this criterion.
   *
   * `run.repo: ~` is a legal fleet.yaml. It mounts the operator's home
   * directory at `/workspace`, which contains `~/.config/gcloud` entire — every
   * account, `credentials.db`, `legacy_credentials/` — and it satisfies "the
   * source is not, and is not under, `~/.config/gcloud`" perfectly, because it
   * is the other way round. So the mount the criterion exists to prevent was
   * reachable through supported config while every ISC-44 assertion stayed
   * green.
   *
   * Driven through `renderWorker` rather than by calling the predicate
   * directly: the claim is that PRODUCTION refuses this, and the refusal lives
   * in `buildDockerArgv`. A test of the predicate alone would still pass if
   * nobody called it — which is precisely the state the constants were in.
   */
  test("a run.repo that CONTAINS the host gcloud store is refused, not rendered (ISC-44)", async () => {
    for (const repo of ["~", "~/.config"]) {
      const { loaded } = await fixture((doc) => {
        (doc["run"] as Record<string, unknown>)["repo"] = repo;
      });
      // `rev-1` is `shared-ro`, so the repo is mounted verbatim rather than as
      // a per-worker worktree under it — the tightest form of the exposure.
      const err = await renderWorker(loaded, "rev-1").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).not.toBeNull();
      expect(err?.name).toBe("HostGcloudMountError");
      expect(err?.message).toContain("CONTAINS the host gcloud auth store");
    }
  });

  /**
   * ISC-127 — the RUN DIRECTORY is not mounted in any container.
   *
   * Read literally, and the literal reading is the only workable one. Several
   * mounts in §5.5's table are paths INSIDE the run dir on purpose —
   * `<run>/outbox/<id>`, `<run>/sessions`, `<run>/skills/<role>`,
   * `<run>/workers/<id>/cloud-allow`, the briefing — so "no mount is under the
   * run dir" would be a criterion production must violate to function. What
   * must never be mounted is the run dir ITSELF, because the run root also
   * holds everything §5.5 deliberately left out of that table:
   * `control-auth.json` (the 0600 control-socket secret whose whole threat
   * model is that a worker cannot read it), `registry.json`, `ledger/`,
   * `inbox/`, `run.json`, and every OTHER worker's state and events.
   *
   * The assertion is therefore stated as reachability of a named file rather
   * than as a string comparison on a directory: `control-auth.json` must not
   * be inside any mounted subtree. That phrasing survives a future mount being
   * added to the table and cannot be satisfied by a mount source that merely
   * spells the run dir differently.
   *
   * All three `isolation` modes, because `/workspace` is the only mount whose
   * source an operator controls and each mode derives it differently.
   *
   * Mutation check: adding `argv.push("-v", `${opts.run.root}:/rundir`)` to
   * `buildDockerArgv` turns this red — see the ISA close-out for the run.
   */
  test("no rendered docker argv ever mounts the run directory (ISC-127)", async () => {
    for (const isolation of ["worktree", "shared-ro", "none"] as const) {
      const { runsDir, loaded } = await fixture((doc) => {
        doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
        const roles = doc["roles"] as Record<string, Record<string, unknown>>;
        roles["eng"]!["cloud_access"] = true;
        roles["eng"]!["isolation"] = isolation;
      });
      const run = runPaths("dry", runsDir);
      const r = await renderWorker(loaded, "eng-1");
      const sources = allBindMountSources(r.docker);

      // Not vacuous: this worker really does get run-dir CHILDREN mounted, so
      // a renderer that emitted no mounts at all could not pass this block.
      expect(sources).toContain(workerOutboxDir(run.root, "eng-1"));
      expect(sources).toContain(run.sessionsDir);

      // The criterion itself, both relations. `classifyRunDirExposure` is
      // production's own predicate, so this and the launcher's guard cannot
      // disagree about what counts.
      for (const s of sources) {
        expect(`${s} -> ${classifyRunDirExposure(s, run.root) ?? "clean"}`).toBe(`${s} -> clean`);
      }

      // What the two relations exist to protect, named directly: the control
      // secret must not sit inside any mounted subtree.
      for (const s of sources) {
        expect(run.controlAuthJson.startsWith(`${s}/`)).toBe(false);
      }
    }
  });

  /**
   * The ancestor direction, and the reason ISC-127 needed a runtime guard
   * rather than an assertion.
   *
   * `run.repo` is operator-settable and the runs root moves independently via
   * `PIFLEET_RUNS_DIR`. An operator who keeps runs inside the checkout —
   * `run.repo: ~/proj` with `PIFLEET_RUNS_DIR=~/proj/runs`, an ordinary thing
   * to want — mounts the live run directory at `/workspace`, control secret
   * and all, and NOTHING in `render.ts`'s mount table looks wrong: every
   * literal in it is still a run-dir child. Measured on this codebase before
   * the guard existed, via `renderWorker` on exactly this config: the
   * `/workspace` source came back an ancestor of `<run>/control-auth.json`.
   *
   * Unlike ISC-44's equivalent this is NOT caught incidentally by the gcloud
   * guard: a project checkout under `/tmp` or `~/proj` contains no
   * `~/.config/gcloud`, so `assertNoHostGcloudMount` passes it happily.
   *
   * Driven through `renderWorker`, not by calling the predicate: the claim is
   * that PRODUCTION refuses this. A test of the predicate alone would pass
   * with nobody calling it, which is the state ISC-44 records its constants
   * having been in.
   */
  test("a run.repo that CONTAINS the run directory is refused, not rendered (ISC-127)", async () => {
    const { dir, loaded } = await fixture((doc) => {
      (doc["roles"] as Record<string, Record<string, unknown>>)["rev"]!["isolation"] = "shared-ro";
    });
    // Point the runs root INSIDE the checkout the fixture already renders from.
    const inside = join(dir, "runs");
    process.env["PIFLEET_RUNS_DIR"] = inside;
    try {
      const err = await renderWorker(loaded, "rev-1").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).not.toBeNull();
      expect(err?.name).toBe("RunDirMountError");
      expect(err?.message).toContain("CONTAINS the run directory");
      // The refusal says WHY, so an operator can move the runs root rather
      // than guess which of two settable paths to change.
      expect(err?.message).toContain("control-auth.json");
    } finally {
      // `fixture()` owns this variable; the next call resets it, but an
      // in-file reader should not have to know that.
      delete process.env["PIFLEET_RUNS_DIR"];
    }
  });

  /**
   * ISC-45's cheap, always-runs counterpart.
   *
   * The live evidence for "a `cloud_access: false` role has no Google
   * credential" is in `test/integration/adc.test.ts`, which needs a Docker
   * daemon and a built image and therefore runs in exactly one CI job. This
   * closes the same hole at the altitude ISC-44 is already covered at: the
   * argv and the env-file `up` would actually write, checked with no daemon
   * anywhere, so the mistake is caught at the point it is typed.
   *
   * The env FILE and not just the argv, because §5.6 delivers a worker's
   * environment through `--env-file` — the integration test's `-e` flags are a
   * test-rig convenience and prove nothing about the real delivery path. A
   * credential leaking into that file is the failure this asserts against.
   */
  test("a cloud_access: false worker's argv and env-file name no credential vector (ISC-45)", async () => {
    const { loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, adc_mode: "token", kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    // rev-1 has no `cloud_access`, so `planCredential` returns `none` for it.
    const r = await renderWorker(loaded, "rev-1");
    const envFile = valueOf(r.docker, "--env-file");
    expect(envFile).toBeDefined();
    await mkdir(join(envFile!, ".."), { recursive: true });
    await renderAllWorkers(loaded);
    const envText = await readFile(envFile!, "utf8").catch(() => "");

    for (const v of CREDENTIAL_ENV_VARS) {
      for (const a of r.docker) expect(a).not.toContain(v);
      for (const line of envText.split("\n")) expect(line).not.toContain(v);
    }

    // The contrast, so the absence above is a property of the ROLE and not of
    // a renderer that never emits these vars for anyone. `eng-1` is the same
    // fixture with `cloud_access: true` — and today it too carries no
    // credential var, because the mint/inject wiring is not in `up` yet
    // (ISC-248). That is the honest state, so it is asserted as such rather
    // than dressed up: what differs between the two workers right now is the
    // kubeconfig mount, which IS a credential-bearing mount (see below).
    const eng = await renderWorker(loaded, "eng-1");
    expect(eng.docker.some((a) => a.includes("/home/pi/.kube/config"))).toBe(true);
    expect(r.docker.some((a) => a.includes("/home/pi/.kube/config"))).toBe(false);
  });

  /**
   * ISC-255 — every rendered worker gets the writable `$CLOUDSDK_CONFIG`
   * tmpfs, for EVERY role.
   *
   * This is the link in the chain the integration test cannot supply.
   * `adc.test.ts` proves the tmpfs makes real gcloud work and that its absence
   * makes gcloud crash, but it builds its container from
   * `gcloudConfigTmpfsArgv()` directly — so deleting the `argv.push` from
   * `render.ts` would leave every one of those probes green while shipping the
   * broken shape to operators. The claim "production launches this" has to be
   * asserted against production, and this is where.
   *
   * Not gated on `cloud_access`: gcloud is on every worker's PATH whatever its
   * credential plan, so a `cloud_access: false` role that runs `gcloud version`
   * must get verbgate's refusal or a clean answer — not a Python traceback
   * about a read-only filesystem.
   */
  test("every worker's argv carries the writable gcloud config tmpfs (ISC-255)", async () => {
    const { loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, adc_mode: "token", kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const [expectedFlag, expectedSpec] = gcloudConfigTmpfsArgv();
    expect(expectedFlag).toBe("--tmpfs");
    for (const id of ["eng-1", "rev-1"]) {
      const r = await renderWorker(loaded, id);
      expect(valuesOf(r.docker, "--tmpfs")).toContain(expectedSpec!);

      // The uid on the tmpfs must equal the uid the container runs as, or the
      // mount is root-owned and gcloud degrades to warning on every call while
      // still exiting 0 — the near-miss that looks like it works. Both come
      // from `WORKER_UID` in production; this asserts they actually agree in
      // the emitted argv rather than trusting that they do.
      expect(valueOf(r.docker, "--user")).toBe(`${WORKER_UID}:${WORKER_UID}`);
      expect(expectedSpec).toContain(`uid=${WORKER_UID},gid=${WORKER_UID}`);

      // A tmpfs and NOT a bind mount: a bind mount would add a `.Mounts` entry
      // and perturb ISC-44's mount-table claim, which is asserted separately
      // and must not be quietly broken by the fix for a different criterion.
      for (const s of allBindMountSources(r.docker)) {
        expect(s).not.toBe(CONTAINER_GCLOUD_CONFIG_DIR);
      }
    }
  });

  test("pi argv equals the docker argv tail after the image", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const imageIdx = r.docker.indexOf(r.image);
    expect(imageIdx).toBeGreaterThan(0);
    expect(r.docker.slice(imageIdx + 1)).toEqual(r.pi.slice(1));
  });
});

/**
 * ISC-188 — the run directory is computed once, in `run/paths.ts`, not twice.
 *
 * `render` derived it from `config.run.root`; `up` derives it from
 * `runsRoot()`, i.e. `PIFLEET_RUNS_DIR`. Nothing reconciled the two, so the
 * command whose only job is to say what `up` will run described an
 * `--env-file`, an `/outbox`, a `/skills` mount and a briefing file under a
 * directory the real launch would never touch. A wrong preview throws nothing:
 * it is compared to reality by a human, and only if they look.
 *
 * These assertions vary `PIFLEET_RUNS_DIR` and require every rendered path to
 * follow it. The old fixture set `run.root: ./runs` AND left the env var unset,
 * so the two sources coincidentally named the same directory and the whole file
 * passed identically against either implementation — the coverage gap this
 * repo's mutation convention exists to catch. The fixture now points them at
 * different directories on purpose.
 */
describe("the run directory is computed once (ISC-188)", () => {
  test("every rendered path is under PIFLEET_RUNS_DIR, and none under config run.root", async () => {
    const { dir, runsDir, loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const r = await renderWorker(loaded, "eng-1");

    // The decoy is a real, resolvable directory the renderer simply must not
    // use — otherwise "absent" could mean "the path never existed".
    const decoy = join(dir, "config-runs");
    expect(loaded.config.run.root).toBe(DECOY_CONFIG_RUN_ROOT);
    expect(decoy).not.toBe(runsDir);

    expect(r.runDir).toBe(join(runsDir, "dry"));
    for (const a of [...r.docker, ...r.pi]) expect(a).not.toContain(decoy);
    expect(r.systemAppend!.hostPath.startsWith(runsDir)).toBe(true);
  });

  /**
   * Every run-dir path the criterion names, each against the helper the OTHER
   * side of its contract uses — not against a string rebuilt here, which would
   * only assert that two `join()` calls in this file agree.
   *
   * Cloud access is on so the kubeconfig is among them. It is the path that
   * makes the point: while it was asserted as a literal `join(...)` it was the
   * one member of this set that could drift out of `run/paths.ts` with this
   * block still passing, which is the same "green test over a divergence"
   * shape the criterion exists to close.
   */
  test("outbox, skills, sessions, env, briefing, policy and kubeconfig come from run/paths.ts", async () => {
    const { runsDir, loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const r = await renderWorker(loaded, "eng-1");

    const run = runPaths("dry", runsDir);
    const worker = workerPaths(run, "eng-1");
    expect(r.docker).toContain(`${workerOutboxDir(run.root, "eng-1")}:/outbox`);
    expect(r.docker).toContain(`${roleSkillsDir(run.root, "eng")}:/skills:ro`);
    expect(r.docker).toContain(`${run.sessionsDir}:/sessions`);
    expect(r.docker[r.docker.indexOf("--env-file") + 1]).toBe(worker.envFile);
    expect(r.docker).toContain(`${worker.systemAppendMd}:${BRIEFING_MOUNT}:ro`);
    expect(r.docker).toContain(`${worker.cloudAllow}:/policy/cloud-allow:ro`);
    expect(r.docker).toContain(`${worker.kubeconfig}:/home/pi/.kube/config:ro`);
    expect(r.systemAppend!.hostPath).toBe(worker.systemAppendMd);
  });

  /**
   * The strongest form: the run dir `render` reports IS the one `up` computes,
   * asserted through the same call `up` makes rather than through a literal.
   * A renderer that hardcoded `~/.pifleet/runs` would satisfy "honours the env
   * var" on a machine where the two happened to match; this cannot.
   */
  test("render's run dir is the one up would compute, for any runs root", async () => {
    const { runsDir, loaded } = await fixture();
    expect(runsRoot()).toBe(runsDir); // the fixture's env var is in force

    const r = await renderWorker(loaded, "eng-1", { runId: "run-77" });
    expect(r.runDir).toBe(runPaths("run-77", runsRoot()).root);
  });

  /**
   * Moving the runs root moves EVERY run-state path, with none left behind.
   *
   * Asserting only that the two argvs differ by the prefix is not enough: a
   * path that kept its own derivation does not MOVE, so it stays byte-identical
   * across the two renders and a prefix-swap comparison passes over it. That is
   * the exact shape of the bug — one path out of eight computed elsewhere —
   * and it was measured: with the `--env-file` alone reverted, the prefix-swap
   * form of this test stayed green.
   *
   * So the host paths are extracted and each is required to be under the run
   * dir, which is a statement about where every path IS rather than about how
   * the two renders relate.
   */
  test("changing PIFLEET_RUNS_DIR moves every run-state host path", async () => {
    const { runsDir, loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const before = await renderWorker(loaded, "eng-1");

    const moved = await mkdtemp(join(tmpdir(), "pifleet-render-moved-"));
    cleanups.push(moved);
    process.env["PIFLEET_RUNS_DIR"] = moved;
    const after = await renderWorker(loaded, "eng-1");
    process.env["PIFLEET_RUNS_DIR"] = runsDir;

    // Every run-state host path, under each root, is under THAT root's run dir.
    for (const [rendered, root] of [
      [before, runsDir],
      [after, moved],
    ] as const) {
      const hostPaths = runStateHostPaths(rendered.docker);
      // Or the loop below is vacuous: six mounts plus the env file.
      expect(hostPaths.length).toBe(7);
      for (const p of hostPaths) expect(p.startsWith(join(root, "dry"))).toBe(true);
    }

    expect(after.docker).not.toEqual(before.docker);
    expect(after.docker.map((a) => a.replaceAll(moved, runsDir))).toEqual(before.docker);
    expect(after.docker.some((a) => a.includes(runsDir))).toBe(false);
  });

  /**
   * Computing the runs root once is only half the guarantee: the value it
   * computes must also be one `docker run -v` will accept.
   *
   * `PIFLEET_RUNS_DIR` is operator input and was returned verbatim, so a
   * relative or `~`-prefixed value reached the mount table unresolved. Docker
   * does not reject that — a `-v` source with no leading `/` is a NAMED
   * VOLUME, so the worker gets a fresh empty volume where the run directory
   * should be, `harvest` reads an empty `/outbox`, and a task that produced
   * artifacts is reported as having produced none. `runStateHostPaths` above
   * encodes the same rule, dropping any host path that does not start with
   * "/" as a named volume, which is why the count assertion below is the
   * whole test.
   *
   * `~` is worse still: nothing but a shell expands it, so it works when
   * typed at a prompt and fails when set from a launcher, a config file, or
   * the detached daemon's env — the three ways this variable is actually set.
   */
  describe("the runs root is canonicalized to an absolute path", () => {
    test("a ~-prefixed value expands, as every other path in the config does", () => {
      expect(runsRoot({ PIFLEET_RUNS_DIR: "~/fleet-runs" })).toBe(join(homedir(), "fleet-runs"));
      expect(runsRoot({ PIFLEET_RUNS_DIR: "~" })).toBe(homedir());
    });

    test("a relative value resolves rather than reaching docker as a named volume", () => {
      const got = runsRoot({ PIFLEET_RUNS_DIR: "relative/runs" });
      expect(isAbsolute(got)).toBe(true);
      expect(got).toBe(resolve("relative/runs"));
    });

    test("an unset or empty value falls back to the documented default", () => {
      const fallback = join(homedir(), ".pifleet", "runs");
      expect(runsRoot({})).toBe(fallback);
      // An exported-but-cleared variable arrives as "", which `??` passes
      // through: `join("", runId)` is then a RELATIVE path, i.e. the
      // named-volume case again, and with no clue in it that a var was set.
      expect(runsRoot({ PIFLEET_RUNS_DIR: "" })).toBe(fallback);
    });

    test("an already-absolute value is normalized, not rewritten", () => {
      expect(runsRoot({ PIFLEET_RUNS_DIR: "/srv/pifleet/runs" })).toBe("/srv/pifleet/runs");
      expect(runsRoot({ PIFLEET_RUNS_DIR: "/srv/pifleet/./runs/" })).toBe("/srv/pifleet/runs");
    });

    /**
     * The end-to-end form. The cases above pin the helper; this one pins what
     * reaches `docker run`, which is where the failure was reproduced.
     */
    test("every rendered host path stays absolute under a relative runs root", async () => {
      const { loaded } = await fixture((doc) => {
        doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
        (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
      });
      const saved = process.env["PIFLEET_RUNS_DIR"];
      process.env["PIFLEET_RUNS_DIR"] = "relative-runs";
      try {
        const r = await renderWorker(loaded, "eng-1");
        expect(isAbsolute(r.runDir)).toBe(true);
        const hostPaths = runStateHostPaths(r.docker);
        // Six mounts plus the env file. Unresolved, they are not absolute and
        // `runStateHostPaths` drops them as named volumes — so this count is
        // the assertion, and it read 0 before the root was canonicalized.
        expect(hostPaths.length).toBe(7);
        for (const p of hostPaths) expect(isAbsolute(p)).toBe(true);
      } finally {
        if (saved === undefined) delete process.env["PIFLEET_RUNS_DIR"];
        else process.env["PIFLEET_RUNS_DIR"] = saved;
      }
    });
  });
});

describe("image tag", () => {
  test("tag is <prefix>:<pi-version>-<toolchain>-<config-hash>", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const hash = configHash(imageInputs(loaded.config, "node"));
    expect(r.image).toBe(`pifleet/pi-worker:0.79.6-node-${hash}`);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the hash ignores non-image config but tracks apt_packages", async () => {
    const { loaded: a } = await fixture();
    const { loaded: b } = await fixture((doc) => {
      (doc["run"] as Record<string, unknown>)["max_concurrent"] = 5; // not image-shaping
    });
    const { loaded: c } = await fixture((doc) => {
      (doc["docker"] as Record<string, unknown>)["apt_packages"] = ["imagemagick"];
    });
    expect(configHash(imageInputs(a.config, "base"))).toBe(configHash(imageInputs(b.config, "base")));
    expect(configHash(imageInputs(a.config, "base"))).not.toBe(configHash(imageInputs(c.config, "base")));
  });

  /**
   * ISC-160 — a stale image must not be silently reused after the build
   * context changed.
   *
   * The hash used to cover pi_version, toolchain and apt_packages and nothing
   * else. Those are the BUILD ARGS, not the recipe: every other line of the
   * Dockerfile — the base image, the tini and gcloud installs, the uid 10001
   * user, the entrypoint, the verbgate COPYs — could be rewritten wholesale
   * and the tag would not move. `up` refuses an image that is ABSENT (§5.7),
   * so it would find the old one present and run the fleet on it, and nothing
   * anywhere reports a tag that merely matched. Silent by construction.
   *
   * The digests below are asserted against the files on disk first, so the
   * inequalities that follow are statements about the build context and not
   * about arithmetic on invented strings.
   */
  test("editing the Dockerfile busts the tag even when nothing else changed (ISC-160)", async () => {
    const { loaded } = await fixture();
    const base = imageInputs(loaded.config, "base");

    // Real content, not a stub: an `assets` record wired to "" would satisfy
    // the inequality below while hashing nothing the image is built from.
    expect(base.assets.Dockerfile).toBe(await digestOnDisk("Dockerfile"));

    const edited: ImageInputs = {
      ...base,
      assets: { ...base.assets, Dockerfile: `${base.assets.Dockerfile}-edited` },
    };
    expect(edited.piVersion).toBe(base.piVersion);
    expect(edited.toolchain).toBe(base.toolchain);
    expect(edited.aptPackages).toEqual(base.aptPackages);

    expect(configHash(edited)).not.toBe(configHash(base));
    // …and the hash stays a pure function of its inputs: an UNCHANGED
    // Dockerfile must keep sharing a tag, or every build is a cache miss.
    expect(configHash({ ...base })).toBe(configHash(base));
  });

  /**
   * ISC-160, the other half — the Dockerfile is not the whole recipe.
   *
   * The Dockerfile `COPY`s two files it does not contain, and hashing only its
   * own text left both outside the tag:
   *
   *  - `docker/verbgate` IS the cloud-mutation gate (ISC-104/105/106/107). An
   *    image built before a gate fix carries the OLD gate, and reusing it
   *    silently is the single highest-consequence staleness this system has.
   *  - `docker/entrypoint.sh` renders `models.json`, so a stale one points the
   *    worker at the wrong model set.
   *
   * Each assertion pins the recorded digest to the bytes on disk first, so
   * "the tag moves" cannot be satisfied by a field nobody reads.
   */
  test.each(["verbgate", "entrypoint.sh"] as const)(
    "editing docker/%s busts the tag even though the Dockerfile is untouched (ISC-160)",
    async (asset) => {
      const { loaded } = await fixture();
      const base = imageInputs(loaded.config, "base");

      expect(base.assets[asset]).toBe(await digestOnDisk(asset));
      // The Dockerfile itself is held fixed across the comparison, so a pass
      // cannot come from the half of the hash that already worked.
      const edited: ImageInputs = {
        ...base,
        assets: { ...base.assets, [asset]: `${base.assets[asset]}-edited` },
      };
      expect(edited.assets.Dockerfile).toBe(base.assets.Dockerfile);
      expect(configHash(edited)).not.toBe(configHash(base));
    },
  );

  /**
   * The enumeration cannot silently fall behind the Dockerfile.
   *
   * `BUILD_CONTEXT_ASSETS` is only as good as its completeness: a new
   * `COPY docker/<x>` added without a matching entry reintroduces exactly the
   * gap above, and nothing else in the build would complain. Reading the
   * COPY sources out of the real Dockerfile makes the enumeration answerable
   * to it rather than to whoever last remembered.
   */
  test("every file the Dockerfile COPYs out of docker/ is in BUILD_CONTEXT_ASSETS", async () => {
    const text = await readFile(join(REPO_ROOT, "docker", "Dockerfile"), "utf8");
    const copied = new Set(
      [...text.matchAll(/^\s*COPY\s+.*?\bdocker\/(\S+)/gm)].map((m) => m[1] as string),
    );
    // The regex must actually be finding things, or this test passes vacuously.
    expect(copied.size).toBeGreaterThan(0);
    for (const src of copied) {
      expect(BUILD_CONTEXT_ASSETS as readonly string[]).toContain(src);
    }
  });

  /**
   * ISC-216 applied to the build context: an unreadable `docker/Dockerfile` is
   * an operator-fixable broken checkout, NOT a pifleet bug.
   *
   * It threw a bare `Error`, which `exitCodeForError` classifies as
   * `EXIT.INTERNAL` — "internal error, file it, do not retry". That is the
   * misclassification `EXIT.INTERNAL` was introduced to prevent, aimed the
   * wrong way: it sends an operator whose checkout is missing a file off to
   * open a bug report instead of restoring the file.
   */
  test("an unreadable build-context file throws a DIAGNOSED usage error, not an internal one", () => {
    let caught: unknown;
    try {
      assetDigestAt(join(REPO_ROOT, "docker", "no-such-build-context-file"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BuildContextError);
    expect((caught as Error).message).toContain("so no image tag can be computed");
    // Diagnosed under the structural protocol…
    expect(isExitCoded(caught)).toBe(true);
    expect((caught as BuildContextError).exitCode).toBe(EXIT.USAGE);
    // …and the entry point agrees, which is the half that actually reaches a
    // caller. Asserting only the field would pass with the CLI still exiting 8.
    expect(exitCodeForError(caught)).toBe(EXIT.USAGE);
    expect(exitCodeForError(caught)).not.toBe(EXIT.INTERNAL);
  });

  /**
   * …and `doctor` survives it. §11's whole premise is that a broken machine is
   * still diagnosable, so the unreadable checkout has to arrive as a ROW in the
   * report. Called bare, `imageTag`'s throw escaped the action and destroyed
   * every probe already collected — the report was suppressed by the very
   * condition it existed to describe.
   */
  test("doctor reports an unreadable build context as a diagnosis instead of aborting", async () => {
    const { loaded } = await fixture();
    const execNever: Exec = async () => {
      throw new Error("docker must not be consulted for a tag that cannot be computed");
    };
    const status = await imageStatus(loaded.config, "base", execNever, () => {
      throw new BuildContextError("cannot read /gone/Dockerfile, so no image tag can be computed");
    });
    expect(status.image).toBeNull();
    expect(status.diagnosis).not.toBeNull();
    expect(status.diagnosis?.name).toBe("image-tag-uncomputable");
    // Actionable: which toolchain, and the unreadable path.
    expect(status.diagnosis?.message).toContain("base");
    expect(status.diagnosis?.message).toContain("/gone/Dockerfile");

    // The happy path still reports presence, or "never aborts" would be
    // satisfiable by a helper that never reports an image at all.
    const ok = await imageStatus(loaded.config, "base", async () => ({
      code: 0,
      stdout: "sha256:abc",
      stderr: "",
      timedOut: false,
    }));
    expect(ok.diagnosis).toBeNull();
    expect(ok.image?.present).toBe(true);
  });
});

describe("worker count follows config (ISC-61)", () => {
  test("rendered container set tracks the workers: list and nothing else", async () => {
    const { loaded: two } = await fixture();
    const { loaded: three } = await fixture((doc) => {
      (doc["workers"] as unknown[]).push({ id: "rev-2", role: "rev" });
    });
    expect(await renderAllWorkers(two)).toHaveLength(2);
    const rendered = await renderAllWorkers(three);
    expect(rendered).toHaveLength(3);
    expect(rendered.map((r) => valueOf(r.docker, "--name"))).toEqual([
      "pifleet-dry-eng-1",
      "pifleet-dry-rev-1",
      "pifleet-dry-rev-2",
    ]);
  });
});

describe("render CLI (ISC-60)", () => {
  /**
   * `PIFLEET_RUNS_DIR` is passed EXPLICITLY, as every integration test in this
   * repo passes it: `Bun.spawn`'s default env is captured from the real environ
   * and does not reflect a `process.env` assignment made after the process
   * started, so the child would otherwise render against the developer's own
   * `~/.pifleet/runs` while the in-process comparison used the fixture's.
   *
   * Which makes this the end-to-end half of ISC-188: the subprocess is the real
   * `pifleet render`, and its argv must equal the library's for the SAME runs
   * root — a CLI that read the runs root differently from the module would
   * differ here even though both halves individually looked right.
   */
  test("render --worker --json emits the argv without spawning docker", async () => {
    const { loaded, dir, runsDir } = await fixture();
    const proc = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "src", "cli", "index.ts"),
        "render",
        "--worker",
        "eng-1",
        "--json",
        "--config",
        join(dir, "fleet.yaml"),
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PIFLEET_RUNS_DIR: runsDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { docker: string[]; pi: string[]; worker: string };
    const lib = await renderWorker(loaded, "eng-1");
    expect(parsed.worker).toBe("eng-1");
    expect(parsed.docker).toEqual(lib.docker);
    expect(parsed.pi).toEqual(lib.pi);
    // Both halves used the fixture's root, not a machine-default that happened
    // to agree — otherwise the equality above is satisfied by two identical
    // wrong answers.
    expect(parsed.docker.some((a) => a.includes(runsDir))).toBe(true);
  });

  test("an unknown worker is a usage error", async () => {
    const { loaded } = await fixture();
    await expect(renderWorker(loaded, "ghost-9")).rejects.toThrow(ConfigError);
  });
});
