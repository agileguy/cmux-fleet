/**
 * Mount-source materialization (SRD §5.5) — the host half of the mount table.
 *
 * Every assertion here is about a SHAPE on disk rather than about a return
 * value, because the failure this module prevents is invisible to a return
 * value. Docker creates a missing `-v` source instead of refusing: a missing
 * directory becomes an empty one, and a missing FILE becomes an empty
 * DIRECTORY. So `cloud-allow` being a regular file, and not merely existing,
 * is the load-bearing fact — a directory there passes verbgate's `[ -r ]`,
 * yields no lines, and degrades the run to deny-all with nothing to read.
 *
 * The mode assertions matter for the reason `mounts.test.ts` states: a Linux
 * bind mount passes host ownership straight through to uid 10001, while the
 * macOS VM squashes it. Neither symptom is observable on this machine, so the
 * invariant is what gets pinned.
 *
 * No Docker daemon, no CLI process, no network — a real temp filesystem and
 * nothing else.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { ConfigError, parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import { BRIEFING_MOUNT, renderWorker } from "../../src/config/render.ts";
import { EXIT } from "../../src/contracts.ts";
import {
  MaterializeError,
  copySkillTree,
  materializeRoleSkills,
  materializeWorkerInputs,
} from "../../src/run/materialize.ts";
import {
  roleSkillsDir,
  runPaths,
  skillsSourceRoot,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "../../src/run/paths.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The one bundle that actually exists; the byte-identity assertion uses it. */
const REAL_SKILL = join(REPO_ROOT, "skills", "pifleet-worker", "SKILL.md");

const cleanups: string[] = [];
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
const SKILLS_DIR_BEFORE = process.env["PIFLEET_SKILLS_DIR"];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ["PIFLEET_RUNS_DIR", RUNS_DIR_BEFORE],
    ["PIFLEET_SKILLS_DIR", SKILLS_DIR_BEFORE],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

interface Fix {
  /** Config directory; relative paths in the document resolve against it. */
  dir: string;
  run: RunPaths;
  loaded: LoadedConfig;
}

/**
 * A self-contained fixture: config, briefing fragments and runs root inside one
 * temp dir, so every materialized path is fixture-relative.
 *
 * `PIFLEET_RUNS_DIR` is set rather than a root being passed in, because that is
 * the seam `runsRoot()` reads and `renderWorker` resolves its own run dir
 * through — the two have to agree or `materializeWorkerInputs` refuses, which
 * is exactly the invariant it exists to hold.
 *
 * `PIFLEET_SKILLS_DIR` is CLEARED unless a test asks for a fixture source root,
 * so a test that plants a hostile bundle cannot leak it into the next one.
 */
async function fixture(
  opts: { mutate?: (doc: Record<string, unknown>) => void; skillsRoot?: string } = {},
): Promise<Fix> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-materialize-"));
  cleanups.push(dir);
  const runsDir = join(dir, "runs");
  process.env["PIFLEET_RUNS_DIR"] = runsDir;
  if (opts.skillsRoot === undefined) delete process.env["PIFLEET_SKILLS_DIR"];
  else process.env["PIFLEET_SKILLS_DIR"] = opts.skillsRoot;

  await mkdir(join(dir, "roles"), { recursive: true });
  await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");

  const doc: Record<string, unknown> = {
    version: 2,
    name: "materialize-fixture",
    docker: { pi_version: "0.79.6" },
    run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "FixtureModel" },
    roles: {
      eng: { append_system_prompt_file: "./roles/eng.md" },
      // No fragment at any level, so `render` emits no briefing mount and
      // nothing here may write a briefing file.
      quiet: {},
    },
    workers: [
      { id: "eng-1", role: "eng" },
      { id: "quiet-1", role: "quiet" },
    ],
  };
  opts.mutate?.(doc);
  const path = join(dir, "fleet.yaml");
  await writeFile(path, stringify(doc));
  const loaded = await parseConfig(await Bun.file(path).text(), path);

  const run = runPaths("mat-run", runsDir);
  await mkdir(run.root, { recursive: true });
  return { dir, run, loaded };
}

/** A fixture skill source root, so a hostile bundle never touches `skills/`. */
async function skillSourceRoot(extra: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-skillsrc-"));
  cleanups.push(root);
  // `pifleet-worker` is re-injected into every worker's list post-merge
  // (ISC-64), so any source root has to carry it.
  await mkdir(join(root, "pifleet-worker", "nested"), { recursive: true });
  await writeFile(join(root, "pifleet-worker", "SKILL.md"), "fixture bundle\n");
  await writeFile(join(root, "pifleet-worker", "nested", "extra.md"), "nested fragment\n");
  for (const name of extra) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `${name} bundle\n`);
  }
  return root;
}

/** `cloud.kubeconfig` set, `eng` granted cloud access, `quiet` deliberately not. */
function withKubeconfigFixture(doc: Record<string, unknown>): void {
  doc["cloud"] = { kubeconfig: "./filtered-kubeconfig" };
  (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
}

describe("the outbox", () => {
  test("is a directory the worker uid can write", async () => {
    const f = await fixture();
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);
    expect(m!.outboxDir).toBe(workerOutboxDir(f.run.root, "eng-1"));
    expect((await stat(m!.outboxDir)).isDirectory()).toBe(true);
    expect(await mode(m!.outboxDir)).toBe(0o777);
    // Traversal is checked at every component, so a 0700 parent would make the
    // 0777 leaf unreachable no matter what the leaf's own mode says.
    expect((await mode(dirname(m!.outboxDir))) & 0o055).toBe(0o055);
  });
});

describe("the role skill bundle", () => {
  test("is a byte-identical copy of the real bundle, readable and traversable", async () => {
    const f = await fixture();
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);
    // Keyed by ROLE, matching the `-v` render emits.
    expect(m!.skillsDir).toBe(roleSkillsDir(f.run.root, "eng"));

    const copied = join(m!.skillsDir, "pifleet-worker", "SKILL.md");
    expect(await readFile(copied)).toEqual(await readFile(REAL_SKILL));
    expect(await mode(join(m!.skillsDir, "pifleet-worker"))).toBe(0o755);
    expect(await mode(copied)).toBe(0o644);
    expect(await mode(m!.skillsDir)).toBe(0o755);
  });

  test("two workers of one role share ONE bundle, and it is copied once", async () => {
    const f = await fixture({
      mutate: (doc) => {
        (doc["workers"] as Array<Record<string, string>>).push({ id: "eng-2", role: "eng" });
      },
    });
    // Materialize up front so there is a BEFORE to compare against: a second
    // copy rewrites SKILL.md and moves its mtime, a skipped one cannot.
    const dir = await materializeRoleSkills(
      f.run.root,
      "eng",
      ["pifleet-worker"],
      skillsSourceRoot(),
    );
    const skillFile = join(dir, "pifleet-worker", "SKILL.md");
    const before = (await stat(skillFile)).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));

    const out = await materializeWorkerInputs(f.loaded, f.run, ["eng-1", "eng-2"]);
    expect(out.map((m) => m.skillsDir)).toEqual([dir, dir]);
    expect((await stat(skillFile)).mtimeMs).toBe(before);
    // One bundle per ROLE, not one per worker.
    expect(await readdir(dirname(dir))).toEqual(["eng"]);
  });

  test("a symlink in the source tree is refused, never followed", async () => {
    const src = await skillSourceRoot();
    // The exact hazard §5.4 names: a link that resolves OUTSIDE the bundle into
    // content the worker would then read as instruction.
    await symlink("/etc/passwd", join(src, "pifleet-worker", "leaked.md"));
    const f = await fixture({ skillsRoot: src });

    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(EXIT.USAGE);
    expect((err as Error).message).toContain(join(src, "pifleet-worker", "leaked.md"));
    /**
     * Named as a SYMLINK, not merely refused.
     *
     * Mutation testing earned this line. Disabling the `isSymbolicLink()`
     * branch left this test green, because an `lstat`ed symlink is neither a
     * directory nor a regular file and fell through to the non-regular-entry
     * refusal — the same class, a different diagnosis, and a test that could
     * not tell them apart was pinning the fallback rather than the guard.
     */
    expect((err as Error).message).toContain("symlink");
    // And nothing was laundered through: `SKILL.md` sorts first and copies, the
    // link is refused, and no `leaked.md` exists on the destination side. This
    // is the assertion that survives an `lstat` → `stat` mutation, which would
    // otherwise copy /etc/passwd in under a name the worker reads as a skill.
    const dst = join(roleSkillsDir(f.run.root, "eng"), "pifleet-worker");
    expect(await Bun.file(join(dst, "SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(dst, "leaked.md")).exists()).toBe(false);
  });

  test("a symlinked bundle ROOT is refused too, not just a link inside one", async () => {
    const src = await skillSourceRoot();
    await symlink(join(src, "pifleet-worker"), join(src, "aliased"));
    const dst = await mkdtemp(join(tmpdir(), "pifleet-skilldst-"));
    cleanups.push(dst);
    const err = await copySkillTree(join(src, "aliased"), join(dst, "aliased")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("symlink");
  });

  test("a configured skill with no source bundle names the worker, role, skill and path", async () => {
    const src = await skillSourceRoot();
    const f = await fixture({
      skillsRoot: src,
      mutate: (doc) => {
        (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["skills"] = [
          "pifleet-worker",
          "sre",
        ];
      },
    });

    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    // Everything the operator needs to fix it without guessing — a bundle that
    // silently shrinks by one skill reads at run time as an agent that ignored
    // its instructions.
    const msg = (err as Error).message;
    expect(msg).toContain('worker "eng-1"');
    expect(msg).toContain('role "eng"');
    expect(msg).toContain('skill "sre"');
    expect(msg).toContain(join(src, "sre"));
  });
});

/**
 * The bundle is per-ROLE; `skills:` is per-WORKER overridable.
 *
 * `config/load.ts`'s `pick` gives a worker's own `skills:` priority over its
 * role's, `render.ts:114` emits `--skill` from the resolved WORKER, and
 * `render.ts:183` mounts one directory per ROLE. A cache keyed on the role and
 * filled from whichever worker arrived first therefore produced a bundle whose
 * contents depended on argument ORDER, and let a nonexistent bundle named only
 * by a later worker of an already-cached role skip the refusal entirely.
 */
describe("a role's bundle is the union across its workers, not the first one seen", () => {
  /** eng-1 keeps the role's list; eng-2 overrides with a name of its own. */
  const twoWorkersOneRole = (doc: Record<string, unknown>): void => {
    (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["skills"] = [
      "pifleet-worker",
      "alpha",
    ];
    (doc["workers"] as Array<Record<string, unknown>>).push({
      id: "eng-2",
      role: "eng",
      skills: ["pifleet-worker", "beta"],
    });
  };

  test("the bundle holds every skill any worker of the role named", async () => {
    const src = await skillSourceRoot(["alpha", "beta"]);
    const f = await fixture({ skillsRoot: src, mutate: twoWorkersOneRole });

    const out = await materializeWorkerInputs(f.loaded, f.run, ["eng-1", "eng-2"]);
    const bundle = out[0]!.skillsDir;
    expect(out[1]!.skillsDir).toBe(bundle);
    expect((await readdir(bundle)).sort()).toEqual(["alpha", "beta", "pifleet-worker"]);
    // Each worker still reports only its OWN list — the `--skill` flags render
    // emits — which is the half that used to disagree with the mount.
    expect(out[0]!.skillNames).toEqual(["pifleet-worker", "alpha"]);
    expect(out[1]!.skillNames).toEqual(["pifleet-worker", "beta"]);
  });

  test("the bytes on disk do not depend on the order --workers named ids", async () => {
    const contents = async (order: string[]): Promise<string[]> => {
      const src = await skillSourceRoot(["alpha", "beta"]);
      const f = await fixture({ skillsRoot: src, mutate: twoWorkersOneRole });
      const out = await materializeWorkerInputs(f.loaded, f.run, order);
      // Sorted because `readdir` returns filesystem order, which is not the
      // property under test — the CONTENTS are.
      return (await readdir(out[0]!.skillsDir)).sort();
    };
    expect(await contents(["eng-1", "eng-2"])).toEqual(await contents(["eng-2", "eng-1"]));
  });

  test("a missing bundle named only by the LAST worker still refuses", async () => {
    // `beta` has no source. Processed second, behind a cache hit on `eng`, the
    // refusal never fired — the headline control silently skipped.
    const src = await skillSourceRoot(["alpha"]);
    const f = await fixture({ skillsRoot: src, mutate: twoWorkersOneRole });

    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1", "eng-2"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain('worker "eng-2"');
    expect(msg).toContain('skill "beta"');
    expect(msg).toContain(join(src, "beta"));
    // Refused BEFORE anything was written, so no half-built bundle is left.
    expect(await Bun.file(roleSkillsDir(f.run.root, "eng")).exists()).toBe(false);
  });
});

/**
 * A skill name is a MOUNT PATH SEGMENT, exactly as a role name is.
 *
 * Role names got this guard already (`schema.ts`, tested against
 * `"../../../../../../etc"`); skill names did not, and `materialize.ts` is the
 * first code to join one into a host path and then `mkdir`, `chmod` and
 * `writeFile` through it.
 */
describe("a skill name cannot escape the directories it is joined into", () => {
  test("a traversing name is refused at load, where it enters the system", async () => {
    const err = await fixture({
      mutate: (doc) => {
        (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["skills"] = [
          "pifleet-worker",
          "../../../../victim",
        ];
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("path segment");
  });

  test("a per-WORKER override is checked too, not only the role's list", async () => {
    // The merge takes the list from whichever level speaks last, so a guard on
    // `roles:` alone is walked around by an override.
    const err = await fixture({
      mutate: (doc) => {
        (doc["workers"] as Array<Record<string, unknown>>)[0]!["skills"] = ["../../escape"];
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("path segment");
  });

  test("materializeRoleSkills refuses one directly, and mutates nothing", async () => {
    // Belt to the schema's braces: this function is exported, and a caller that
    // reaches it without schema validation must still be safe.
    const f = await fixture();
    const victim = join(f.dir, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "key"), "private\n");
    await chmod(join(victim, "key"), 0o600);

    const err = await materializeRoleSkills(
      f.run.root,
      "eng",
      ["../../../../../../../../.." + victim],
      join(f.dir, "skills-src"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    // The host file outside the run root is untouched, mode included — the
    // reproduction was a 0600 key chmod'd to 0644.
    expect(await mode(join(victim, "key"))).toBe(0o600);
  });
});

describe("the verbgate policy file", () => {
  test("is a zero-byte REGULAR FILE, which is the whole point", async () => {
    const f = await fixture();
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);
    expect(m!.cloudAllow).toBe(workerPaths(f.run, "eng-1").cloudAllow);

    const st = await stat(m!.cloudAllow);
    // A DIRECTORY here is the silent-degradation case: it is what Docker
    // creates when the host file is absent, verbgate's `[ -r ]` passes on it,
    // the read loop yields nothing, and the run deny-alls with no diagnosis.
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    // Empty is CORRECT — authorization is task-scoped (§5.10), so `up` has
    // nothing true to write and deny-all is the right run-time default.
    expect(st.size).toBe(0);
    /**
     * 0444, not 0644. verbgate refuses EVERY verb (exit 78) when `[ -w ]`
     * succeeds on its allow file, and the macOS VM squashes ownership to the
     * container uid — so at 0644 the policy reads as owner-writable from
     * inside the container and only the `:ro` mount flag separates that from a
     * fleet-wide refusal. The mode should say what the `:ro` flag says.
     */
    expect(await mode(m!.cloudAllow)).toBe(0o444);
    expect((await mode(m!.cloudAllow)) & 0o222).toBe(0);
  });
});

describe("the briefing", () => {
  test("holds exactly the bytes render put behind the mount", async () => {
    const f = await fixture();
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);
    const r = await renderWorker(f.loaded, "eng-1", { runId: f.run.runId });

    expect(r.systemAppend).not.toBeNull();
    // The SAME string the `-v` names, not a matching one (ISC-188's doctrine
    // applied to existence rather than to spelling).
    expect(m!.systemAppendMd).toBe(r.systemAppend!.hostPath);
    expect(await Bun.file(r.systemAppend!.hostPath).text()).toBe(r.systemAppend!.content);
    expect(await mode(r.systemAppend!.hostPath)).toBe(0o644);
  });

  test("is ABSENT for a worker render emits no briefing mount for", async () => {
    const f = await fixture();
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["quiet-1"]);
    expect(m!.systemAppendMd).toBeNull();
    expect(await Bun.file(workerPaths(f.run, "quiet-1").systemAppendMd).exists()).toBe(false);

    // The two halves are the same predicate, so they cannot disagree.
    const r = await renderWorker(f.loaded, "quiet-1", { runId: f.run.runId });
    expect(r.docker.some((a) => a.includes(BRIEFING_MOUNT))).toBe(false);
  });
});

describe("the kubeconfig", () => {
  const KUBE = "apiVersion: v1\nkind: Config\nclusters: []\n";
  const withKubeconfig = withKubeconfigFixture;

  test("is copied verbatim, and only for a worker with cloud access", async () => {
    const f = await fixture({ mutate: withKubeconfig });
    await writeFile(join(f.dir, "filtered-kubeconfig"), KUBE);

    const out = await materializeWorkerInputs(f.loaded, f.run, ["eng-1", "quiet-1"]);
    const eng = out.find((m) => m.workerId === "eng-1")!;
    const quiet = out.find((m) => m.workerId === "quiet-1")!;

    expect(eng.kubeconfig).toBe(workerPaths(f.run, "eng-1").kubeconfig);
    expect(eng.kubeconfigSource).toBe(join(f.dir, "filtered-kubeconfig"));
    expect(await Bun.file(eng.kubeconfig!).text()).toBe(KUBE);
    expect(await mode(eng.kubeconfig!)).toBe(0o644);

    // `cloud_access: false` is the same predicate render gates the `-v` on, so
    // no file and no mount — not a file nothing mounts.
    expect(quiet.kubeconfig).toBeNull();
    expect(await Bun.file(workerPaths(f.run, "quiet-1").kubeconfig).exists()).toBe(false);
  });

  test("is not written at all when config names none, cloud access or not", async () => {
    const f = await fixture({
      mutate: (doc) => {
        (doc["roles"] as Record<string, Record<string, unknown>>)["eng"]!["cloud_access"] = true;
      },
    });
    const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);
    expect(m!.kubeconfig).toBeNull();
    expect(await Bun.file(workerPaths(f.run, "eng-1").kubeconfig).exists()).toBe(false);
  });

  test("a source that cannot be read is a config refusal, not a crash", async () => {
    const f = await fixture({ mutate: withKubeconfig });
    // Deliberately never written.
    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(EXIT.USAGE);
    expect((err as Error).message).toContain(join(f.dir, "filtered-kubeconfig"));
  });
});

/**
 * Traversal is checked at EVERY path component, so the mode of a mounted file
 * is only half the answer.
 *
 * `cloud-allow`, `system-append.md` and the kubeconfig all live under
 * `<run>/workers/<id>/`. Under `umask 077` — or Linux's common 027 — the run
 * root, `workers/` and `workers/<id>/` are all created 0700, and three
 * carefully-chmod'd 0644 files underneath become unreachable to uid 10001 with
 * nothing erroring anywhere. The rest of this suite cannot see it because it
 * inherits the ambient 022, so this test sets the umask itself.
 */
describe("under a tightened umask", () => {
  test("every directory on the way to a mounted file is still traversable", async () => {
    const previous = process.umask(0o077);
    try {
      const f = await fixture({ mutate: withKubeconfigFixture });
      await writeFile(join(f.dir, "filtered-kubeconfig"), "apiVersion: v1\n");
      const [m] = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]);

      // Every component from the run root down to each mounted file. `0o055`
      // is read+execute for group and other — what a traverse actually needs.
      const chain = [
        f.run.root,
        f.run.workersDir,
        workerPaths(f.run, "eng-1").dir,
        dirname(m!.outboxDir),
        dirname(m!.skillsDir),
        m!.skillsDir,
      ];
      for (const dir of chain) {
        expect({ dir, bits: (await mode(dir)) & 0o055 }).toEqual({ dir, bits: 0o055 });
      }
      // …and the files themselves are world-readable, which is worth nothing
      // without the chain above and is the half the old test checked alone.
      for (const file of [m!.cloudAllow, m!.systemAppendMd!, m!.kubeconfig!]) {
        expect({ file, bits: (await mode(file)) & 0o044 }).toEqual({ file, bits: 0o044 });
      }
    } finally {
      process.umask(previous);
    }
  });
});

/**
 * The destination side dereferenced links where the source side refused them.
 *
 * `mkdir` and `chmod` both FOLLOW a symlink, so a link planted at a
 * destination path had pifleet reopen the permissions of whatever it pointed
 * at — against `makeWorkerAccessible`'s own contract that it is only ever
 * aimed at directories pifleet created under the run root.
 */
describe("a symlinked DESTINATION is refused, not written through", () => {
  test("a linked bundle destination is refused and its target is untouched", async () => {
    const f = await fixture();
    const victim = join(f.dir, "victim");
    await mkdir(victim, { recursive: true });
    await chmod(victim, 0o700);

    // Plant a link where the role's bundle directory would go.
    const dst = roleSkillsDir(f.run.root, "eng");
    await mkdir(dirname(dst), { recursive: true });
    await symlink(victim, dst);

    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaterializeError);
    expect((err as MaterializeError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    // The chmod never reached through the link.
    expect(await mode(victim)).toBe(0o700);
  });
});

describe("membership and failure class", () => {
  /**
   * The same skip `assertModelsAllowed` makes, for the same reason: Phase 1
   * `--workers` legitimately names ids that exist only as a
   * `PIFLEET_PI_COMMAND` double, and those have no configured mounts.
   */
  test("an id absent from workers: is skipped, not refused", async () => {
    const f = await fixture();
    expect(await materializeWorkerInputs(f.loaded, f.run, ["ghost-1"])).toEqual([]);
  });

  /**
   * Each worker is reported as it COMPLETES.
   *
   * Materialization writes real directories and files, so a failure on the
   * second worker leaves the first one's on disk. A caller that only records
   * the returned array learns nothing about either — no ledger line, no trace
   * of what exists — which is the forensic gap on the one path this module is
   * built to make loud.
   */
  test("the sink fires per worker, so a mid-batch failure still records the finished ones", async () => {
    const f = await fixture({
      mutate: (doc) => {
        // Only `quiet` takes cloud access, and the kubeconfig it names is
        // never written — so `eng-1` succeeds and `quiet-1` refuses.
        doc["cloud"] = { kubeconfig: "./missing-kubeconfig" };
        (doc["roles"] as Record<string, Record<string, unknown>>)["quiet"]!["cloud_access"] = true;
      },
    });

    const seen: string[] = [];
    const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1", "quiet-1"], async (m) => {
      seen.push(m.workerId);
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    // Reported BEFORE the failure, not in a batch that never returns.
    expect(seen).toEqual(["eng-1"]);
    // …and its inputs really are on disk, which is why the record matters.
    expect(await Bun.file(workerPaths(f.run, "eng-1").cloudAllow).exists()).toBe(true);
  });

  /**
   * An environment that will not let a control be established is exit 3, the
   * same class as the egress guard and the hazard scan — not exit 2, which
   * would send the operator to edit a config that is already correct.
   */
  test("an unreadable skill source root is exit 3, not a missing-bundle refusal", async () => {
    // `catch { return null }` reported EACCES as "no bundle exists" — a config
    // diagnosis for an environment fault, sending the operator to edit a
    // config that was already right.
    const src = await skillSourceRoot();
    const f = await fixture({ skillsRoot: src });
    await chmod(src, 0o000);
    try {
      const err = await materializeWorkerInputs(f.loaded, f.run, ["eng-1"]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    } finally {
      await chmod(src, 0o755);
    }
  });

  test("a run root that cannot be written is exit 3, not a config error", async () => {
    const f = await fixture();
    const wedged = runPaths("wedged", join(f.dir, "runs"));
    // A regular FILE where the worker directory has to go: every mkdir under
    // it fails with ENOTDIR, which is an environment fault, not a typo.
    await mkdir(dirname(wedged.workersDir), { recursive: true });
    await writeFile(wedged.workersDir, "not a directory\n");

    const err = await materializeWorkerInputs(f.loaded, wedged, ["eng-1"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MaterializeError);
    expect((err as MaterializeError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  });
});
