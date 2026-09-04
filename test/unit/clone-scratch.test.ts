/**
 * The writable clone scratch, and the read-only working directory it clones
 * from.
 *
 * Both halves come from one measured failure. Asked to run the tests of a
 * project at `~/repos/rally-cli`, `tst-1` reported `blocked`:
 *
 *   git clone https://github.com/…/rally-cli.git ~/repos/rally-cli
 *   fatal: could not create leading directories of
 *   '/home/pi/repos/rally-cli': Read-only file system
 *
 * Two separate defects in one line. The container had nowhere writable to
 * clone INTO — `--read-only` covers all of `/home/pi` and `/tmp` is `noexec`.
 * And it was reaching for a REMOTE, which this fleet's `egress.allow`
 * allowlist does not carry and which would in any case have fetched the
 * pushed state rather than the working directory the operator is sitting in.
 *
 * So: `~/repos` is a writable, executable tmpfs, and the operator's working
 * directory is bind-mounted read-only at `/repos-src/<name>` to be cloned
 * from. The separation of those two paths is the design — one is the real
 * repository and must never be written, the other is the worker's own copy and
 * is meant to be dirtied.
 */
import { describe, expect, test } from "bun:test";

import {
  WORKER_CLONE_SRC_ROOT,
  WORKER_SCRATCH_DIR,
  cloneSourceMount,
  resolveCloneSource,
} from "../../src/container/mounts.ts";

const loaded = (repo: string) => ({ config: { run: { repo } }, dir: "/cfg" });

describe("where a clone may be written", () => {
  test("the scratch is ~/repos, where the agent already reached", () => {
    expect(WORKER_SCRATCH_DIR).toBe("/home/pi/repos");
  });

  test("it is NOT under /workspace, which harvest reads as the worker's own work", () => {
    // A clone inside the worktree would appear in the run's branch and diff,
    // making "cloned a dependency" indistinguishable from "vendored someone
    // else's repository into my commit".
    expect(WORKER_SCRATCH_DIR.startsWith("/workspace")).toBe(false);
  });
});

describe("where a clone is read from", () => {
  test("a host path is exposed under its BASENAME only", () => {
    // The operator's directory layout — and their username — stay out of a
    // container an agent can read.
    expect(cloneSourceMount("/Users/someone/repos/rally-cli")).toBe(
      `${WORKER_CLONE_SRC_ROOT}/rally-cli`,
    );
  });

  test("a trailing slash does not produce an empty name", () => {
    expect(cloneSourceMount("/Users/someone/repos/rally-cli/")).toBe(
      `${WORKER_CLONE_SRC_ROOT}/rally-cli`,
    );
  });

  test("a path with no usable name is refused rather than mounted at the root", () => {
    // `/repos-src/` would shadow the whole exposure root.
    expect(() => cloneSourceMount("/")).toThrow(/no usable directory name/);
  });

  test("the source root is distinct from the scratch", () => {
    // One is read-only and real; the other is writable and disposable. A
    // single path for both would make reading and building one permission.
    expect(WORKER_CLONE_SRC_ROOT).not.toBe(WORKER_SCRATCH_DIR);
    expect(WORKER_SCRATCH_DIR.startsWith(`${WORKER_CLONE_SRC_ROOT}/`)).toBe(false);
  });
});

describe("which working directory becomes a clone source", () => {
  test("a git working directory other than run.repo is exposed", async () => {
    // This repo is a git checkout, and it is not the configured run.repo here.
    const here = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
    expect(await resolveCloneSource(loaded("/somewhere/else"), here)).toBe(here);
  });

  test("run.repo itself is NOT exposed — it is already the /workspace worktree", async () => {
    const here = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
    // Mounting it again under another name would give one repository two
    // identities in the container: one harvested, one not.
    expect(await resolveCloneSource(loaded(here), here)).toBeNull();
  });

  test("a subdirectory of run.repo is not exposed either", async () => {
    const here = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
    expect(await resolveCloneSource(loaded(here), `${here}/src`)).toBeNull();
  });

  test("a directory that is not a git checkout is not exposed", async () => {
    // Otherwise an operator standing anywhere would hand an agent whatever
    // files happened to be there, with nobody having decided to.
    expect(await resolveCloneSource(loaded("/somewhere/else"), "/usr")).toBeNull();
  });
});
