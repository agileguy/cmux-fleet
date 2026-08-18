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
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { runPaths, workerOutboxDir } from "../../src/run/paths.ts";

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
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

/**
 * A self-contained fixture: config + briefing fragments + local run root, all
 * inside one temp dir so every rendered path is fixture-relative.
 */
async function fixture(mutate?: (doc: Record<string, unknown>) => void): Promise<{
  dir: string;
  loaded: LoadedConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-render-"));
  cleanups.push(dir);
  await mkdir(join(dir, "roles"), { recursive: true });
  await writeFile(join(dir, "roles", "common.md"), "Common fleet briefing.\n");
  await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");
  await writeFile(join(dir, "roles", "rev.md"), "Reviewer role briefing.\n");

  const doc: Record<string, unknown> = {
    version: 2,
    name: "render-fixture",
    docker: { pi_version: "0.79.6" },
    run: { root: "./runs", repo: ".", budget: { tokens_ceiling: 1_000_000 } },
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
  return { dir, loaded: await loadConfig(join(dir, "fleet.yaml")) };
}

function countOf(argv: string[], flag: string): number {
  return argv.filter((a) => a === flag).length;
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
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
    const { dir, loaded } = await fixture();
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
    expect(r.systemAppend!.hostPath).toBe(join(dir, "runs", "dry", "workers", "eng-1", "system-append.md"));
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
    const { dir, loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const runDir = join(dir, "runs", "dry");
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
    const { dir, loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const runDir = join(dir, "runs", "dry");

    const mounted = r.docker
      .find((a) => a.endsWith(":/outbox"))
      ?.slice(0, -":/outbox".length);
    expect(mounted).toBe(workerOutboxDir(runDir, "eng-1"));

    // And that shared path is the one the harvest side resolves for the same
    // worker, through the RunPaths struct it works from.
    const run = runPaths("dry", join(dir, "runs"));
    expect(mounted).toBe(workerOutboxDir(run.root, "eng-1"));
  });

  test("kubeconfig mounts read-only only for cloud_access workers with cloud.kubeconfig set", async () => {
    const { dir, loaded } = await fixture((doc) => {
      doc["cloud"] = { adc: true, kubeconfig: "./kube/filtered.yaml" };
      (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
    });
    const eng = await renderWorker(loaded, "eng-1");
    expect(eng.docker).toContain(
      `${join(dir, "runs", "dry", "workers", "eng-1", "kubeconfig")}:/home/pi/.kube/config:ro`,
    );
    const rev = await renderWorker(loaded, "rev-1"); // no cloud_access
    expect(rev.docker.some((a) => a.includes("/.kube/"))).toBe(false);
  });

  test("pi argv equals the docker argv tail after the image", async () => {
    const { loaded } = await fixture();
    const r = await renderWorker(loaded, "eng-1");
    const imageIdx = r.docker.indexOf(r.image);
    expect(imageIdx).toBeGreaterThan(0);
    expect(r.docker.slice(imageIdx + 1)).toEqual(r.pi.slice(1));
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
  test("render --worker --json emits the argv without spawning docker", async () => {
    const { loaded, dir } = await fixture();
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
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { docker: string[]; pi: string[]; worker: string };
    const lib = await renderWorker(loaded, "eng-1");
    expect(parsed.worker).toBe("eng-1");
    expect(parsed.docker).toEqual(lib.docker);
    expect(parsed.pi).toEqual(lib.pi);
  });

  test("an unknown worker is a usage error", async () => {
    const { loaded } = await fixture();
    await expect(renderWorker(loaded, "ghost-9")).rejects.toThrow(ConfigError);
  });
});
