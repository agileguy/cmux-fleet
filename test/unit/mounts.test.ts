/**
 * container/mounts.ts — the daemon-visible scratch rule.
 *
 * These run without a daemon: the exec seam is substituted so the *decision*
 * logic is testable everywhere, while the real sharing behaviour stays covered
 * by the Docker-gated probes in test/integration/image.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonScratchRoot,
  makeDaemonScratch,
  makeWorkerAccessible,
  makeWorkerReadable,
  probeMountVisibility,
  probeWriteThrough,
  WORKER_UID,
} from "../../src/container/mounts.ts";
import type { Exec, ExecResult } from "../../src/container/run.ts";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr, timedOut: false });

describe("daemonScratchRoot", () => {
  /**
   * The whole point of the module. os.tmpdir() on macOS is /var/folders/...,
   * which no VM-backed daemon shares — mounting it yields an empty directory
   * and no error at all.
   */
  test("is never inside os.tmpdir()", () => {
    expect(daemonScratchRoot({})).not.toStartWith(tmpdir());
  });

  test("defaults under $HOME, which both Colima and Docker Desktop share", () => {
    expect(daemonScratchRoot({})).toStartWith(homedir());
  });

  test("PIFLEET_SCRATCH_DIR overrides it", () => {
    expect(daemonScratchRoot({ PIFLEET_SCRATCH_DIR: "/mnt/shared" })).toBe("/mnt/shared");
  });
});

describe("makeDaemonScratch", () => {
  test("creates a real directory under the root, including missing parents", async () => {
    const base = await mkdtemp(join(tmpdir(), "scratch-root-"));
    const root = join(base, "does", "not", "exist", "yet");
    try {
      const dir = await makeDaemonScratch("probe", { PIFLEET_SCRATCH_DIR: root });
      expect(dir).toStartWith(join(root, "probe-"));
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("probeMountVisibility", () => {
  const dir = () => mkdtemp(join(tmpdir(), "visprobe-"));

  test("visible only when the host sentinel is read back", async () => {
    const d = await dir();
    try {
      const exec: Exec = async () => ok("pifleet-mount-ok\n");
      expect((await probeMountVisibility(d, "img", exec)).visible).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  /**
   * The failure this module exists for: `docker run` succeeds, the mount is
   * present, and the directory is simply empty. Exit 0 must NOT be read as
   * visible — only the sentinel counts.
   */
  test("a successful run with empty output is NOT visible", async () => {
    const d = await dir();
    try {
      const exec: Exec = async () => ok("");
      const r = await probeMountVisibility(d, "img", exec);
      expect(r.visible).toBe(false);
      expect(r.detail).toContain("only directories shared into the");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("removes its sentinel even when the probe fails", async () => {
    const d = await dir();
    try {
      const exec: Exec = async () => fail("boom");
      await probeMountVisibility(d, "img", exec);
      await expect(stat(join(d, ".pifleet-mount-probe"))).rejects.toThrow();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("an unwritable host directory is reported, not thrown", async () => {
    const r = await probeMountVisibility("/nonexistent/nowhere", "img", async () => ok(""));
    expect(r.visible).toBe(false);
    expect(r.detail).toContain("cannot write");
  });
});

describe("probeWriteThrough", () => {
  const withRoot = async (fn: (root: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "wt-root-"));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test("requires both directions: host→container and container→host", async () => {
    await withRoot(async (root) => {
      // Container reads the host file but writes nothing back.
      const exec: Exec = async () => ok("host-wrote-this\n");
      const r = await probeWriteThrough("img", exec, { PIFLEET_SCRATCH_DIR: root });
      expect(r.visible).toBe(false);
      expect(r.detail).toContain("not visible on the host");
    });
  });

  test("passes when the container actually writes back", async () => {
    await withRoot(async (root) => {
      const { writeFile } = await import("node:fs/promises");
      const exec: Exec = async (argv) => {
        // Stand in for the container: find the -v source and write into it.
        const v = argv[argv.indexOf("-v") + 1] ?? "";
        const host = v.split(":")[0] ?? "";
        await writeFile(join(host, "from-container"), "container-wrote-this\n");
        return ok("host-wrote-this\n");
      };
      const r = await probeWriteThrough("img", exec, { PIFLEET_SCRATCH_DIR: root });
      expect(r.visible).toBe(true);
      expect(r.detail).toBe("both directions visible");
    });
  });

  test("a nonzero exit carries the sharing hint, not just the exit code", async () => {
    await withRoot(async (root) => {
      const exec: Exec = async () => fail("cat: /workspace/from-host: No such file or directory");
      const r = await probeWriteThrough("img", exec, { PIFLEET_SCRATCH_DIR: root });
      expect(r.visible).toBe(false);
      expect(r.detail).toContain("No such file");
      expect(r.detail).toContain("PIFLEET_SCRATCH_DIR");
    });
  });

  test("leaves no scratch directory behind", async () => {
    await withRoot(async (root) => {
      const { readdir } = await import("node:fs/promises");
      await probeWriteThrough("img", async () => ok(""), { PIFLEET_SCRATCH_DIR: root });
      expect(await readdir(root)).toEqual([]);
    });
  });
});

/**
 * The ownership half of the mount rule.
 *
 * A Linux bind mount passes host ownership straight through, so a directory the
 * host created at `mkdtemp`'s 0700 is unusable to the container's uid 10001 —
 * it cannot even traverse it. The macOS VM squashes ownership instead, so the
 * symptom is invisible on this machine and appears only on a Linux host, where
 * seven container probes failed at once: `/workspace` unwritable, `/skills`
 * unreadable, and the verbgate ledger never created (ENOENT on the append).
 *
 * The mode is therefore the thing to assert. These tests cannot observe the
 * Linux failure, but they pin the invariant whose absence causes it, and they
 * fail on any platform if the chmod is dropped.
 */
describe("worker-uid accessibility", () => {
  const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

  const withRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "perm-root-"));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test("a scratch directory is writable by another uid, not mkdtemp's 0700", async () => {
    await withRoot(async (root) => {
      const dir = await makeDaemonScratch("perm", { PIFLEET_SCRATCH_DIR: root });
      expect(await mode(dir)).toBe(0o777);
    });
  });

  test("the scratch ROOT is at least traversable, or nothing beneath it is reachable", async () => {
    await withRoot(async (root) => {
      await makeDaemonScratch("perm", { PIFLEET_SCRATCH_DIR: root });
      // A 0700 root makes every 0777 child unreachable — the child's own mode
      // is not sufficient, because traversal is checked at every component.
      expect((await mode(root)) & 0o055).toBe(0o055);
    });
  });

  test("a read-only mount gets traverse+read but not write", async () => {
    await withRoot(async (root) => {
      const dir = await makeDaemonScratch("ro", { PIFLEET_SCRATCH_DIR: root });
      await makeWorkerAccessible(dir, false);
      expect(await mode(dir)).toBe(0o755);
      expect((await mode(dir)) & 0o002).toBe(0); // world-writable would be wrong here
    });
  });

  /**
   * The FILE half of the same rule. Three of the mount table's sources are
   * single files — the briefing, the verbgate policy, the kubeconfig — and a
   * host writing them under a tightened umask leaves 0600, which uid 10001
   * cannot read at all. No execute bit: every one of them is content a worker
   * reads, none is a program.
   */
  test("a read-only mounted FILE gets read but neither write-for-others nor execute", async () => {
    await withRoot(async (root) => {
      const file = join(root, "system-append.md");
      await writeFile(file, "");
      await chmod(file, 0o600);
      await makeWorkerReadable(file, true);
      expect(await mode(file)).toBe(0o644);
      expect((await mode(file)) & 0o111).toBe(0);
    });
  });

  /**
   * The policy-file case, which is not merely stricter — it is load-bearing.
   *
   * `docker/verbgate` refuses EVERY verb (exit 78) when `[ -w ]` succeeds on
   * its allow file, and the macOS VM squashes ownership to the container uid,
   * so 0644 reads as owner-writable from inside and only the `:ro` mount flag
   * keeps that check from firing. At 0444 the mode says it too.
   */
  test("a policy file is readable by everyone and writable by no one", async () => {
    await withRoot(async (root) => {
      const file = join(root, "cloud-allow");
      await writeFile(file, "");
      await makeWorkerReadable(file, false);
      expect(await mode(file)).toBe(0o444);
      expect((await mode(file)) & 0o222).toBe(0);
    });
  });

  test("the uid constant matches the Dockerfile's USER", async () => {
    // If these drift, the permissions above are opened for the wrong account
    // and every mount silently reverts to the broken state.
    const dockerfile = await Bun.file("docker/Dockerfile").text();
    expect(dockerfile).toContain(`USER ${WORKER_UID}:${WORKER_UID}`);
  });
});
