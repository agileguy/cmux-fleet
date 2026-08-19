/**
 * Per-worker code isolation (SRD §9.1) — real git, real filesystem, no Docker,
 * no network.
 *
 * **Every repository in this file is SYNTHETIC**, built by `test/fixtures/
 * synthetic-repo.ts` with `git init` in a fresh temp directory. Nothing here
 * clones, worktree-adds, or otherwise reads objects from this project's own
 * repository, and that is a hard rule rather than a style preference: `git
 * clone` from a local path hardlinks object files by default, so a fixture
 * built that way shares inodes with the real repository and a test that writes
 * into the "throwaway" writes into the real object store. The spike that
 * produced this feature destroyed this repository's pack file exactly that
 * way. See the fixture module's header.
 *
 * The load-bearing test in this file is `--no-hardlinks`. It is load-bearing
 * because nothing else fails when the flag goes missing: the clone still
 * works, the worker still commits, every other test in the suite stays green,
 * and the only symptom is that a worker container can now corrupt the
 * operator's repository through a shared inode. Mutation-proved — dropping
 * the flag from `worktree.ts` makes `objects are independent copies` fail and
 * nothing else.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { runPaths, workerBranch, workerWorktree, type RunPaths } from "../../src/run/paths.ts";
import {
  MAX_ATTRIBUTE_BYTES,
  StaleWorktreeError,
  WorktreeError,
  WorktreePreflightError,
  assertBaseRefCloneable,
  createWorkerWorktrees,
  inspectBaseRef,
  inspectCloneDirt,
  pruneWorkerWorktree,
  workerRemoteName,
  type WorkerWorktree,
} from "../../src/run/worktree.ts";
import { git, gitOk, pathExists, seedGitRepo } from "../fixtures/synthetic-repo.ts";

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pifleet-worktree-"));
  cleanups.push(d);
  return d;
}

interface Rig {
  base: string;
  repo: string;
  run: RunPaths;
  loaded: LoadedConfig;
}

/** A config whose `run.repo` is a synthetic repository, with N `worktree` workers. */
async function makeRig(opts: {
  workers?: string[];
  branchPrefix?: string;
  isolation?: string;
  seed?: Parameters<typeof seedGitRepo>[1];
} = {}): Promise<Rig> {
  const base = await scratch();
  const repo = join(base, "repo");
  const workers = opts.workers ?? ["eng-1"];
  await seedGitRepo(repo, opts.seed);

  const yaml = [
    "version: 2",
    "name: worktree-test",
    'docker: {pi_version: "0.79.6", network: wt-net}',
    "run:",
    `  repo: ${repo}`,
    ...(opts.branchPrefix === undefined ? [] : [`  branch_prefix: ${opts.branchPrefix}`]),
    ...(opts.isolation === undefined ? [] : [`  isolation: ${opts.isolation}`]),
    "  budget: {tokens_ceiling: 1000000}",
    "llm: {model: wt-model}",
    "roles:",
    "  engineer: {}",
    "workers:",
    ...workers.map((w) => `  - {id: ${w}, role: engineer}`),
    "",
  ].join("\n");
  const configPath = join(base, "fleet.yaml");
  await writeFile(configPath, yaml, "utf8");
  const loaded = await parseConfig(yaml, configPath);
  return { base, repo, run: runPaths("run-abc", join(base, "runs")), loaded };
}

const create = (rig: Rig, workerIds: string[]): Promise<WorkerWorktree[]> =>
  createWorkerWorktrees({ loaded: rig.loaded, run: rig.run, repo: rig.repo, workerIds });

// ---------------------------------------------------------------------------

describe("clone placement and base ref", () => {
  test("lands at the computed path, on its own branch, at the parent's HEAD", async () => {
    const rig = await makeRig();
    const parentHead = await gitOk(rig.repo, "rev-parse", "HEAD");

    const [wt] = await create(rig, ["eng-1"]);
    expect(wt).toBeDefined();

    // The path is the one `run/paths.ts` computes and `render.ts` mounts —
    // asserted through the helper AND through the rendered `-v`, because a
    // bind mount whose source nothing created does not fail, it comes up
    // empty (ISC-188/231).
    expect(wt!.path).toBe(workerWorktree(rig.repo, "eng-1"));
    expect((await stat(wt!.path)).isDirectory()).toBe(true);

    // `.git` is a real DIRECTORY, not a `gitdir:` pointer file. This is the
    // single fact that makes design 3 work where `git worktree add` does not:
    // a linked worktree's `.git` names a path outside the mount, so git in the
    // container answers `fatal: not a git repository`.
    expect((await stat(join(wt!.path, ".git"))).isDirectory()).toBe(true);

    expect(await gitOk(wt!.path, "rev-parse", "HEAD")).toBe(parentHead);
    expect(wt!.baseSha).toBe(parentHead);
    expect(await gitOk(wt!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt!.branch);
    expect(wt!.branch).toBe(workerBranch("fleet", "run-abc", "eng-1"));
  });

  test("clones the parent's CHECKED-OUT branch, not merely its default", async () => {
    // A repo whose HEAD is on `feature`, with `main` sitting at an older
    // commit. Cloning without `--branch` would follow the default branch and
    // silently hand every worker the wrong base — the failure `resolveBaseRef`
    // refuses a detached HEAD to avoid, reached from the other direction.
    const rig = await makeRig({ seed: { branch: "main" } });
    await gitOk(rig.repo, "switch", "-q", "-c", "feature");
    await writeFile(join(rig.repo, "only-on-feature.txt"), "x\n");
    await gitOk(rig.repo, "add", "-A");
    await gitOk(rig.repo, "commit", "-q", "-m", "feature work");
    const featureHead = await gitOk(rig.repo, "rev-parse", "HEAD");

    const [wt] = await create(rig, ["eng-1"]);
    expect(wt!.baseSha).toBe(featureHead);
    expect(await pathExists(join(wt!.path, "only-on-feature.txt"))).toBe(true);
  });

  test("a detached parent HEAD is a named refusal, not a silently substituted base", async () => {
    const rig = await makeRig();
    await gitOk(rig.repo, "checkout", "-q", "--detach", "HEAD");
    await expect(create(rig, ["eng-1"])).rejects.toThrow(WorktreePreflightError);
    await expect(create(rig, ["eng-1"])).rejects.toThrow(/DETACHED HEAD/);
    // Nothing was created behind the refusal.
    expect(await pathExists(workerWorktree(rig.repo, "eng-1"))).toBe(false);
  });

  test("render mounts exactly the directory that was created", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    const rendered = await renderWorker(rig.loaded, "eng-1", { runId: rig.run.runId });
    expect(rendered.docker).toContain(`${wt!.path}:/workspace`);
  });
});

// ---------------------------------------------------------------------------

describe("--no-hardlinks", () => {
  /**
   * THE regression test for this slice.
   *
   * A hardlink is one inode with two names. `git clone` from a local path
   * defaults to `--local`, which hardlinks the source's object files into the
   * clone; the 0444 mode on a pack does not stop the owning uid from `chmod
   * +w`, so a worker container writing through its own copy corrupts the
   * PARENT'S object store. Nothing else in the suite notices the flag's
   * absence — the clone works, the branch is right, the worker commits — which
   * is precisely why this assertion has to be about inodes rather than about
   * behaviour.
   *
   * Both halves are asserted, because they can fail independently: `nlink`
   * catches a file that is hardlinked to ANYTHING, and the disjoint-inode
   * check catches it being hardlinked to THIS parent specifically.
   */
  test("objects are independent copies, sharing no inode with the parent", async () => {
    const rig = await makeRig({ seed: { files: { "a.txt": "one\n" }, commits: [{ "a.txt": "two\n" }] } });
    const [wt] = await create(rig, ["eng-1"]);

    const parentObjects = await objectFiles(join(rig.repo, ".git", "objects"));
    const cloneObjects = await objectFiles(join(wt!.path, ".git", "objects"));
    expect(parentObjects.length).toBeGreaterThan(0);
    expect(cloneObjects.length).toBeGreaterThan(0);

    for (const o of cloneObjects) {
      expect(`${o.rel} nlink=${o.nlink}`).toBe(`${o.rel} nlink=1`);
    }
    const parentInodes = new Set(parentObjects.map((o) => o.ino));
    for (const o of cloneObjects) {
      expect(`${o.rel} shares-parent-inode=${parentInodes.has(o.ino)}`).toBe(
        `${o.rel} shares-parent-inode=false`,
      );
    }
  });

  test("writing in the clone cannot reach the parent's object store", async () => {
    // The property the flag buys, stated as behaviour. With hardlinked
    // objects this is the corruption path: same inode, so truncating the
    // clone's copy truncates the parent's.
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    const before = await objectFiles(join(rig.repo, ".git", "objects"));

    await writeFile(join(wt!.path, "worker.txt"), "worker output\n");
    await gitOk(wt!.path, "add", "-A");
    await gitOk(wt!.path, "commit", "-q", "-m", "worker commit");

    const after = await objectFiles(join(rig.repo, ".git", "objects"));
    expect(after.map((o) => o.rel).sort()).toEqual(before.map((o) => o.rel).sort());
    // The parent's own integrity check, which is what a corrupted pack fails.
    expect((await git(rig.repo, "fsck", "--no-progress")).code).toBe(0);
  });
});

interface ObjectFile {
  rel: string;
  nlink: number;
  ino: number;
}

/** Every real object file under `.git/objects`, excluding the `info` bookkeeping. */
async function objectFiles(root: string): Promise<ObjectFile[]> {
  const out: ObjectFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const abs = join(dir, n);
      const st = await stat(abs);
      if (st.isDirectory()) {
        if (n === "info") continue;
        await walk(abs, rel === "" ? n : `${rel}/${n}`);
        continue;
      }
      out.push({ rel: rel === "" ? n : `${rel}/${n}`, nlink: st.nlink, ino: st.ino });
    }
  };
  await walk(root, "");
  return out;
}

// ---------------------------------------------------------------------------

describe("the clone is self-contained", () => {
  test("origin is stripped and the host repo path does not survive ANYWHERE under .git", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);

    expect((await gitOk(wt!.path, "remote")).trim()).toBe("");
    const config = await Bun.file(join(wt!.path, ".git", "config")).text();
    expect(config).not.toContain(rig.repo);

    /**
     * `.git/config` alone is the WEAKER property. `git clone` writes
     * "clone: from <absolute source path>" into `.git/logs/HEAD` and
     * `.git/logs/refs/heads/<base branch>` — both inside the mount, both
     * readable by the worker, and untouched by `remote remove origin`. An
     * earlier version of this test asserted only `.git/config` and passed
     * while that leak was live. Walk every file under `.git` instead.
     */
    const gitDir = join(wt!.path, ".git");
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const name of await readdir(dir)) {
        const abs = join(dir, name);
        const st = await stat(abs);
        if (st.isDirectory()) {
          await walk(abs);
          continue;
        }
        const content = await Bun.file(abs).text().catch(() => "");
        if (content.includes(rig.repo)) offenders.push(abs);
      }
    };
    await walk(gitDir);
    expect(offenders).toEqual([]);

    // The mechanism the property rests on: reflogs are gone entirely right
    // after creation (git recreates them fresh on the worker's first ref
    // update, per `core.logAllRefUpdates`, with no source path in them).
    expect(await pathExists(join(gitDir, "logs"))).toBe(false);

    // Still fully functional without it — the point of removing origin is
    // that nothing needed it, not that the clone is degraded.
    await writeFile(join(wt!.path, "x.txt"), "x\n");
    await gitOk(wt!.path, "add", "-A");
    expect((await git(wt!.path, "commit", "-q", "-m", "still works")).code).toBe(0);
  });

  test("a stale leftover directory is refused, never adopted", async () => {
    const rig = await makeRig();
    const path = workerWorktree(rig.repo, "eng-1");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "someone-elses-work.txt"), "do not delete me\n");

    await expect(create(rig, ["eng-1"])).rejects.toThrow(StaleWorktreeError);
    await expect(create(rig, ["eng-1"])).rejects.toThrow(/down --prune/);
    // Untouched: a refusal that had already clobbered the directory would be
    // strictly worse than a silent adoption.
    expect(await Bun.file(join(path, "someone-elses-work.txt")).text()).toContain("do not delete");
  });
});

// ---------------------------------------------------------------------------

describe("ref-scoped preflight (SRD §9.2, retargeted)", () => {
  test("submodules at the base ref are refused BEFORE anything is cloned", async () => {
    const rig = await makeRig();
    const inner = join(rig.base, "inner");
    await seedGitRepo(inner);
    // `protocol.file.allow` is needed only to BUILD the fixture; git refuses
    // file-transport submodules by default. The gate under test never clones
    // a submodule, which is the whole reason it refuses.
    await gitOk(rig.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor/inner");
    await gitOk(rig.repo, "add", "-A");
    await gitOk(rig.repo, "commit", "-q", "-m", "add submodule");

    const findings = await inspectBaseRef(rig.repo, "main");
    expect(findings.gitlinks).toEqual(["vendor/inner"]);
    expect(findings.gitmodules).toBe(true);

    await expect(create(rig, ["eng-1"])).rejects.toThrow(WorktreePreflightError);
    await expect(create(rig, ["eng-1"])).rejects.toThrow(/submodules at vendor\/inner/);
    expect(await pathExists(workerWorktree(rig.repo, "eng-1"))).toBe(false);
  });

  test("LFS-tracked content is refused, including from a NESTED .gitattributes", async () => {
    // Nested rather than root-level on purpose: git honours a `.gitattributes`
    // in every directory, and a preflight that reads only the root one would
    // pass this repository and hand every worker pointer stubs.
    const rig = await makeRig({
      seed: { files: { "a.txt": "one\n", "assets/.gitattributes": "*.psd filter=lfs -text\n" } },
    });
    const findings = await inspectBaseRef(rig.repo, "main");
    expect(findings.lfs).toHaveLength(1);
    expect(findings.lfs[0]).toContain("assets/.gitattributes");

    await expect(create(rig, ["eng-1"])).rejects.toThrow(/LFS-tracked content/);
    expect(await pathExists(workerWorktree(rig.repo, "eng-1"))).toBe(false);
  });

  test("an ordinary .gitattributes with no lfs filter is not refused", async () => {
    // The detector that flags everything is as useless as the one that flags
    // nothing: `text=auto` and `export-ignore` are in ordinary repositories.
    const rig = await makeRig({
      seed: { files: { "a.txt": "one\n", ".gitattributes": "* text=auto\n#*.bin filter=lfs\n" } },
    });
    const findings = await inspectBaseRef(rig.repo, "main");
    expect(findings.lfs).toEqual([]);
    expect((await create(rig, ["eng-1"])).length).toBe(1);
  });

  test("preflight refuses before the FIRST clone, not partway through the fleet", async () => {
    const rig = await makeRig({
      workers: ["eng-1", "eng-2", "eng-3"],
      seed: { files: { "a.txt": "one\n", ".gitattributes": "*.bin filter=lfs -text\n" } },
    });
    await expect(create(rig, ["eng-1", "eng-2", "eng-3"])).rejects.toThrow(WorktreePreflightError);
    // Not "eng-3 was refused" — NOTHING was created. A per-worker gate would
    // leave two clones and a remote apiece behind the refusal.
    expect(await pathExists(join(rig.repo, ".worktrees"))).toBe(false);
  });

  /**
   * `BaseRefFindings.unscanned`'s own doc comment says "Never silent". This
   * pins that literally: a `.gitattributes` too large to read must not let
   * an LFS declaration inside it pass unnoticed just because nothing ELSE
   * in the ref tripped a refusal.
   */
  test("an attribute file too large to scan REFUSES the clone, not silently accepts it", async () => {
    const bigButUnderCap = "#".repeat(1000) + "\n*.psd filter=lfs -text\n";
    const rig = await makeRig({
      seed: { files: { "a.txt": "one\n", ".gitattributes": bigButUnderCap } },
    });
    // Sanity: under the cap, the scan reads it and finds LFS the normal way.
    const readable = await inspectBaseRef(rig.repo, "main");
    expect(readable.unscanned).toEqual([]);
    expect(readable.lfs).toHaveLength(1);

    // Now push the same file over MAX_ATTRIBUTE_BYTES with a padding comment
    // line, keeping the LFS assignment on its own line so it would have been
    // detected had the scan been ABLE to read the file.
    const tooLarge = "#" + "x".repeat(MAX_ATTRIBUTE_BYTES) + "\n*.psd filter=lfs -text\n";
    await writeFile(join(rig.repo, ".gitattributes"), tooLarge);
    await gitOk(rig.repo, "add", "-A");
    await gitOk(rig.repo, "commit", "-q", "-m", "grow gitattributes past the cap");

    const findings = await inspectBaseRef(rig.repo, "main");
    expect(findings.lfs).toEqual([]); // never read, so never "found"
    expect(findings.unscanned).toHaveLength(1);
    expect(findings.unscanned[0]).toContain(".gitattributes");

    // The gate under test: `problems.length === 0` used to mean "accept",
    // even with `unscanned` non-empty. It must not, any more.
    expect(() => assertBaseRefCloneable(rig.repo, "main", findings)).toThrow(WorktreePreflightError);
    expect(() => assertBaseRefCloneable(rig.repo, "main", findings)).toThrow(/could not be fully scanned/);
    await expect(create(rig, ["eng-1"])).rejects.toThrow(WorktreePreflightError);
    expect(await pathExists(join(rig.repo, ".worktrees"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("branch_prefix is honoured end to end", () => {
  test("a non-default prefix names the branch git actually checks out", async () => {
    const rig = await makeRig({ branchPrefix: "experiment" });
    const [wt] = await create(rig, ["eng-1"]);
    expect(wt!.branch).toBe("experiment/run-abc/eng-1");
    expect(await gitOk(wt!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("experiment/run-abc/eng-1");
    // The literal it replaced, asserted as absent so a reverted `dispatch.ts`
    // cannot pass this by coincidence.
    expect(wt!.branch).not.toContain("fleet/");
  });

  test("workers not in worktree isolation get no checkout", async () => {
    for (const isolation of ["shared-ro", "none"]) {
      const rig = await makeRig({ isolation });
      expect(await create(rig, ["eng-1"])).toEqual([]);
      expect(await pathExists(join(rig.repo, ".worktrees"))).toBe(false);
    }
  });

  /**
   * `SESSION_ID_RE` (worker ids) permits both a literal `..` and a trailing
   * `.lock`, and `branch_prefix` has no grammar of its own at all — so
   * without this preflight, each of these produces a branch name git
   * refuses, and (before the atomicity fix in the next `describe`) an
   * ORPHAN clone directory nothing had recorded yet. Refused here, before
   * any clone exists at all — the property the second assertion in each
   * case pins.
   */
  test("a branch_prefix that produces an invalid git ref name is refused BEFORE any clone exists", async () => {
    const invalidPrefixes = ["a..b", "x.lock", "my prefix", "-leading-dash"];
    for (const branchPrefix of invalidPrefixes) {
      const rig = await makeRig({ branchPrefix });
      await expect(create(rig, ["eng-1"])).rejects.toThrow(WorktreePreflightError);
      await expect(create(rig, ["eng-1"])).rejects.toThrow(/refuses as a ref name/);
      expect(await pathExists(join(rig.repo, ".worktrees"))).toBe(false);
    }
  });

  test("with multiple workers, one bad branch_prefix refuses the whole batch before worker one clones", async () => {
    const rig = await makeRig({ workers: ["eng-1", "eng-2"], branchPrefix: "a..b" });
    await expect(create(rig, ["eng-1", "eng-2"])).rejects.toThrow(WorktreePreflightError);
    expect(await pathExists(join(rig.repo, ".worktrees"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a failure after the clone exists is rolled back, not left as an orphan", () => {
  /**
   * THE regression test for the atomicity fix. `git clone` succeeds — the
   * directory is real, on disk — and then `git switch -c <branch>` fails for
   * a reason the ref-grammar preflight cannot catch: the NAME is perfectly
   * valid, it is simply ALREADY the branch the clone just checked out
   * (`--branch` cloned it by that exact name). Before the fix, `onCreated`
   * — the only thing that records a checkout — never fires on this path, so
   * the directory and any registered remote are left behind, invisible to
   * `down --prune`, blocking every future `up` at this path with
   * `StaleWorktreeError`.
   */
  test("a clone that exists but never finished setup is removed, not orphaned", async () => {
    // The base branch IS the exact string `workerBranch` will compute for
    // this rig's fixed run id ("run-abc") and worker id ("eng-1") under the
    // default prefix ("fleet") — see `makeRig`/`create`.
    const rig = await makeRig({ seed: { branch: "fleet/run-abc/eng-1" } });

    await expect(create(rig, ["eng-1"])).rejects.toThrow(WorktreeError);
    await expect(create(rig, ["eng-1"])).rejects.toThrow(/switch -c/);

    // The clone directory does not survive the failure.
    expect(await pathExists(workerWorktree(rig.repo, "eng-1"))).toBe(false);
    // Nor does a dangling remote in the parent — the same rollback covers it.
    expect((await git(rig.repo, "remote", "get-url", workerRemoteName("eng-1"))).code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("operator visibility via a named remote", () => {
  test("the parent can fetch and log a worker's commits without leaving its checkout", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    expect(wt!.remoteName).toBe(workerRemoteName("eng-1"));
    expect(await gitOk(rig.repo, "remote", "get-url", wt!.remoteName)).toBe(wt!.path);

    await writeFile(join(wt!.path, "worker.txt"), "did the work\n");
    await gitOk(wt!.path, "add", "-A");
    await gitOk(wt!.path, "commit", "-q", "-m", "worker did the work");

    expect((await git(rig.repo, "fetch", "-q", wt!.remoteName)).code).toBe(0);
    const log = await gitOk(rig.repo, "log", "--oneline", `${wt!.remoteName}/${wt!.branch}`);
    expect(log).toContain("worker did the work");

    // The operator's own checkout is untouched by any of it — still on its
    // own branch, at its own commit, with no tracked file modified.
    expect(await gitOk(rig.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await gitOk(rig.repo, "rev-parse", "HEAD")).toBe(wt!.baseSha);
    expect(await gitOk(rig.repo, "status", "--porcelain", "--untracked-files=no")).toBe("");

    /**
     * `.worktrees/` does NOT show up in the operator's `git status` at all —
     * revised from an earlier version of this test, which asserted the
     * opposite and argued that excluding it would be a forbidden mutation of
     * the operator's repository.
     *
     * That argument had it backwards. Leaving `.worktrees/` untracked-but-
     * visible means an operator's completely ordinary `git add -A && git
     * commit` embeds every worker's clone as a GITLINK (git treats an
     * un-ignored nested `.git` directory as a candidate submodule, not as
     * content to walk into) — which then makes THIS MODULE'S OWN preflight
     * refuse every subsequent `up` with a "submodules present" diagnosis the
     * operator never authored and cannot reconcile with `git submodule
     * status` printing nothing. See the mutation test below. `.git/info/
     * exclude` is not `.gitignore`: it is untracked, uncommitted, local-only
     * bookkeeping read only by git itself — the same category of write
     * `registerWorkerRemote` already makes to `.git/config` a few lines
     * above this one, and no more a mutation of the operator's TRACKED
     * checkout than that is.
     */
    expect(await gitOk(rig.repo, "status", "--porcelain")).toBe("");
  });

  test("a stale same-named remote from a dead run is replaced, not fatal", async () => {
    const rig = await makeRig();
    // The shape a crashed run leaves behind: the remote survived, its
    // directory did not. `remote add` alone would fail on this forever.
    await gitOk(rig.repo, "remote", "add", workerRemoteName("eng-1"), join(rig.base, "gone"));
    const created: Array<{ replacedStaleRemote: boolean }> = [];
    const [wt] = await createWorkerWorktrees({
      loaded: rig.loaded,
      run: rig.run,
      repo: rig.repo,
      workerIds: ["eng-1"],
      onCreated: async (_w, note) => {
        created.push(note);
      },
    });
    expect(created[0]?.replacedStaleRemote).toBe(true);
    expect(await gitOk(rig.repo, "remote", "get-url", wt!.remoteName)).toBe(wt!.path);
  });

  /**
   * THE regression test for `.git/info/exclude`. Mutation-proved: commenting
   * out the `excludeWorktreesDir` call in `createWorkerWorktrees` makes this
   * fail at the FIRST assertion (a gitlink appears) rather than the second,
   * confirming the exclude entry — not some other control — is what prevents
   * it.
   */
  test("an operator's ordinary `git add -A && git commit` does not embed a worker's clone as a gitlink", async () => {
    const rig = await makeRig();
    await create(rig, ["eng-1"]);

    await gitOk(rig.repo, "add", "-A");
    // Nothing to commit if `.worktrees/` was truly excluded — proves the
    // exclude entry actually suppressed it, not merely that this test forgot
    // to look.
    expect(await gitOk(rig.repo, "status", "--porcelain")).toBe("");
    const committed = await git(rig.repo, "commit", "-q", "-m", "operator's own unrelated work");
    expect(committed.code).not.toBe(0); // nothing staged to commit

    // The property that actually matters: this module's OWN preflight, run
    // again against the parent's current HEAD, must not see a gitlink and
    // refuse every future `up` as though the operator had added a submodule.
    const findings = await inspectBaseRef(rig.repo, "main");
    expect(findings.gitlinks).toEqual([]);
    expect(() => assertBaseRefCloneable(rig.repo, "main", findings)).not.toThrow();
  });

  test("excludeWorktreesDir is idempotent across repeated `up`s and preserves an operator's existing entries", async () => {
    const rig = await makeRig();
    const excludePath = join(rig.repo, ".git", "info", "exclude");
    await mkdir(join(rig.repo, ".git", "info"), { recursive: true });
    await writeFile(excludePath, "*.local\n", "utf8");

    const [first] = await create(rig, ["eng-1"]);
    const once = await Bun.file(excludePath).text();
    expect(once).toContain("*.local");
    expect(once).toContain("/.worktrees/");

    await pruneWorkerWorktree({ repo: rig.repo, worktree: first!, force: true });
    await create(rig, ["eng-1"]);
    const twice = await Bun.file(excludePath).text();
    // Appended exactly once, not once per `up` — a second entry would still
    // be harmless to git, but would be evidence the idempotency check itself
    // is broken.
    expect(twice.split("/.worktrees/").length - 1).toBe(1);
    expect(twice).toContain("*.local");
  });
});

// ---------------------------------------------------------------------------

describe("pruning (SRD §9.3)", () => {
  test("a clean checkout is removed along with its remote", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);

    const outcome = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: false });
    expect(outcome.pruned).toBe(true);
    expect(await pathExists(wt!.path)).toBe(false);
    expect((await git(rig.repo, "remote", "get-url", wt!.remoteName)).code).not.toBe(0);
  });

  test("uncommitted work refuses without --force, and --force takes it", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    // Untracked counts as work: a worker that wrote a file and never added it
    // has still done something a delete would destroy.
    await writeFile(join(wt!.path, "scratch.txt"), "unsaved thinking\n");

    const dirt = await inspectCloneDirt(wt!);
    expect(dirt).toMatchObject({ dirty: true, statusLines: 1, commitsAhead: 0 });

    const refused = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: false });
    expect(refused.pruned).toBe(false);
    expect(refused.reason).toContain("--force");
    expect(await pathExists(join(wt!.path, "scratch.txt"))).toBe(true);
    // The remote survives the refusal too — a half-prune that dropped the
    // remote would leave the surviving work unreachable from the parent,
    // which is the opposite of what refusing is for.
    expect(await gitOk(rig.repo, "remote", "get-url", wt!.remoteName)).toBe(wt!.path);

    const forced = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: true });
    expect(forced.pruned).toBe(true);
    expect(await pathExists(wt!.path)).toBe(false);
  });

  test("COMMITTED work refuses too — there is no upstream that already has it", async () => {
    // The half a bare `status --porcelain` test would miss. `origin` was
    // stripped at creation and nothing was ever pushed, so a commit past
    // `baseSha` exists in exactly one place on the machine.
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    await writeFile(join(wt!.path, "done.txt"), "finished\n");
    await gitOk(wt!.path, "add", "-A");
    await gitOk(wt!.path, "commit", "-q", "-m", "real work");

    expect(await gitOk(wt!.path, "status", "--porcelain")).toBe("");
    const dirt = await inspectCloneDirt(wt!);
    expect(dirt).toMatchObject({ dirty: true, statusLines: 0, commitsAhead: 1 });

    const refused = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: false });
    expect(refused.pruned).toBe(false);
    expect(refused.reason).toContain("1 commit(s) past");
  });

  test("pruning is re-runnable: an already-gone checkout is success, not an error", async () => {
    const rig = await makeRig();
    const [wt] = await create(rig, ["eng-1"]);
    await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: false });
    const second = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt!, force: false });
    expect(second.pruned).toBe(true);
    expect(second.reason).toContain("already absent");
  });

  /**
   * `baseSha` that no longer resolves at all — not merely a rewritten but
   * still-reachable history — is the case `commitsAhead: Infinity` exists
   * for, distinct from "N commits ahead". `git rev-list --count` fails
   * outright only when the LEFT side of the range does not resolve as a
   * commit, which a merely-rewritten-but-still-present history does not
   * reproduce (verified: `git reset --hard` past the recorded sha, then a
   * fresh commit, still leaves `rev-list --count <old>..HEAD` succeeding —
   * the old sha is still a real, resolvable ancestor). A record naming a sha
   * this clone's object store never had at all is the honest way to pin it.
   */
  test("a baseSha that does not resolve at all is Infinity commits ahead, not zero", async () => {
    const rig = await makeRig();
    const [created] = await create(rig, ["eng-1"]);
    const wt: WorkerWorktree = { ...created!, baseSha: "0".repeat(40) };

    const dirt = await inspectCloneDirt(wt);
    expect(dirt.commitsAhead).toBe(Number.POSITIVE_INFINITY);
    expect(dirt.dirty).toBe(true);

    const refused = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt, force: false });
    expect(refused.pruned).toBe(false);
    expect(refused.reason).toContain("no longer in this history");
  });
});

// ---------------------------------------------------------------------------

describe("pruneWorkerWorktree refuses a recursive delete outside .worktrees/", () => {
  /**
   * THE regression test for the containment check. `run.json`'s recorded
   * `path` is host-side and not container-writable, but it IS
   * operator-editable, and this is the only recursive delete in the module
   * driven by a value read back from disk rather than computed from
   * `workerWorktree(repo, id)`. A hand-edited or truncated record must not
   * turn `--force` into an unbounded `rm -rf`.
   */
  test("a record naming a path outside <repo>/.worktrees/ is refused, not deleted", async () => {
    const rig = await makeRig();
    const [created] = await create(rig, ["eng-1"]);

    // A directory OUTSIDE .worktrees/ that must survive this call untouched.
    const outside = join(rig.base, "not-a-worktree");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "do-not-delete.txt"), "real data\n");

    const wt: WorkerWorktree = { ...created!, path: outside };
    const outcome = await pruneWorkerWorktree({ repo: rig.repo, worktree: wt, force: true });

    expect(outcome.pruned).toBe(false);
    expect(outcome.reason).toContain("outside");
    expect(await pathExists(join(outside, "do-not-delete.txt"))).toBe(true);
  });
});
