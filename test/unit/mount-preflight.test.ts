/**
 * The launch-path guard over BIND-MOUNT SOURCES (ISC-292).
 *
 * ## The hazard, restated because the tests below are shaped by it
 *
 * On a VM-backed container runtime — Docker Desktop, colima, Rancher — only a
 * declared set of host directories is shared into the VM. A `-v <src>:<dst>`
 * whose `<src>` lies outside that set DOES NOT FAIL. The VM has no such path,
 * so the runtime CREATES an empty directory there and mounts that. The
 * container sees an empty directory where the host has content, and `docker
 * run` exits 0. Reproduced on this machine (colima 0.9, virtiofs, arm64):
 *
 *     -v /private/tmp/x/probe.mjs:/probe.mjs  ->  Cannot find module '/probe.mjs'
 *     -v /private/tmp/x:/probe:ro             ->  /probe/probe.mjs is a DIRECTORY
 *     -v $HOME/y:/probe:ro                    ->  /probe/probe.mjs is a 29-byte file
 *
 * with `docker run` exiting **0** in all three. That silent 0 is the defect.
 *
 * ## Why these tests substitute the exec seam
 *
 * The same reason `mounts.test.ts` gives for `probeMountVisibility`: the set of
 * shared paths is a property of the RUNTIME, and the DECISION logic must be
 * testable on every platform. What is asserted here is that a disagreement
 * between the host's own measurement and the container's is REFUSED, and that
 * an agreement is not — over the finished argv, which is the only altitude at
 * which the mount table's operator-settable paths are knowable.
 *
 * ## What these tests DO NOT prove, stated so nobody reads it as proved
 *
 * They do not witness an actually-unshared path. That needs a VM-backed
 * runtime; on a native Linux daemon every path is shared and the negative
 * direction cannot be produced at all. The agreement check against a real
 * daemon lives in `test/integration/doctor-preflight.test.ts`, and on a Linux
 * CI runner even that can only ever exercise the positive direction. See the
 * ISC-292 entry in ISA.md for the platform limitation in full.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOUNT_PROBE_SENTINEL,
  MountNotVisibleError,
  assertBindMountsVisible,
  probeBindMountSources,
} from "../../src/container/mount-preflight.ts";
import { isExitCoded, EXIT } from "../../src/contracts.ts";
import type { Exec, ExecResult } from "../../src/container/run.ts";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** A scratch root that is REMOVED afterwards, whatever the body does. */
async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "isc292-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A recorder that answers as a runtime which shares EVERYTHING.
 *
 * It reads the probe script out of the argv it was handed and replies with the
 * witness the host asked about, so a "visible" verdict here means the code
 * agreed with a truthful container rather than that it defaulted to true.
 */
function sharingRuntime(calls: string[][]): Exec {
  return async (argv) => {
    calls.push([...argv]);
    const script = argv[argv.length - 1] ?? "";
    const out: string[] = [];
    // Each probe line is `probe <i> '<container path>'`.
    for (const m of script.matchAll(/^probe (\d+) '([^']*)'$/gm)) {
      const idx = m[1]!;
      const p = m[2]!;
      // Translate the container path back to the host path this mount came
      // from, so the answer is measured rather than invented.
      const mountIdx = argv.indexOf("-v", 0);
      void mountIdx;
      const spec = argv.find((a, i) => argv[i - 1] === "-v" && a.includes(`:/probe/${idx}:`));
      const src = spec?.split(":")[0] ?? "";
      const rel = p.slice(`/probe/${idx}`.length);
      const hostPath = rel === "" ? src : join(src, rel);
      const f = Bun.file(hostPath);
      out.push((await f.exists()) ? `${idx} f ${f.size}` : `${idx} x 0`);
    }
    return ok(out.join("\n") + "\n");
  };
}

/** A runtime that reports every witness as an empty DIRECTORY — the real hazard. */
const emptyDirRuntime: Exec = async (argv) => {
  const script = argv[argv.length - 1] ?? "";
  const out: string[] = [];
  for (const m of script.matchAll(/^probe (\d+) '/gm)) out.push(`${m[1]!} d 0`);
  return ok(out.join("\n") + "\n");
};

describe("a bind-mount source the runtime cannot see is refused, not launched (ISC-292)", () => {
  /**
   * THE CRITERION. A source whose container witness disagrees with the host's
   * is refused before anything launches.
   */
  test("a source that comes up empty inside the container refuses the launch", async () => {
    await withRoot(async (root) => {
      const src = join(root, "workspace");
      await mkdir(src);
      await writeFile(join(src, "code.ts"), "export const x = 1;\n");
      const argv = ["docker", "run", "--rm", "-v", `${src}:/workspace`, "img"];

      await expect(assertBindMountsVisible([argv], "img", emptyDirRuntime)).rejects.toThrow(
        MountNotVisibleError,
      );
    });
  });

  /**
   * The message has to say what actually happens, because the entire hazard is
   * that the operator sees no error at all — and it must name the PATH, which
   * is the thing they have to move.
   */
  test("the refusal names the path and what a mount of it would really do", async () => {
    await withRoot(async (root) => {
      const src = join(root, "workspace");
      await mkdir(src);
      await writeFile(join(src, "code.ts"), "export const x = 1;\n");
      const argv = ["docker", "run", "-v", `${src}:/workspace`, "img"];

      const err = await assertBindMountsVisible([argv], "img", emptyDirRuntime).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MountNotVisibleError);
      const message = (err as Error).message;
      expect(message).toContain(src);
      expect(message).toContain("EMPTY directory");
      expect(message).toContain("refusing to launch");
      expect(message).toContain("ISC-292");
    });
  });

  /**
   * A DIAGNOSED failure, not a stack trace.
   *
   * `EXIT.BACKEND_UNAVAILABLE` rather than `USAGE` on purpose: `doctor`
   * classifies exactly this condition as `misconfigured` and exits 3, and the
   * two commands must agree over the only channel a machine caller has.
   */
  test("the refusal is exit-coded 3, agreeing with doctor's own verdict", async () => {
    await withRoot(async (root) => {
      const src = join(root, "outbox");
      await mkdir(src);
      const argv = ["docker", "run", "-v", `${src}:/outbox`, "img"];
      const err = await assertBindMountsVisible([argv], "img", emptyDirRuntime).catch(
        (e: unknown) => e,
      );
      expect(isExitCoded(err)).toBe(true);
      expect((err as { exitCode: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    });
  });

  /** The complement, without which the test above passes on a check that always throws. */
  test("a source the container really can read launches", async () => {
    await withRoot(async (root) => {
      const src = join(root, "workspace");
      await mkdir(src);
      await writeFile(join(src, "code.ts"), "export const x = 1;\n");
      const argv = ["docker", "run", "-v", `${src}:/workspace`, "img"];
      const calls: string[][] = [];
      await assertBindMountsVisible([argv], "img", sharingRuntime(calls));
      expect(calls.length).toBe(1);
    });
  });
});

describe("what the probe uses as its witness (ISC-292)", () => {
  /**
   * THE STALE-DIRECTORY CASE, which is why an entry COUNT is not the witness.
   *
   * Measured, not theorised. After `-v <unshared>/probe.mjs:/probe.mjs` the VM
   * holds an empty DIRECTORY named `probe.mjs` inside its own copy of the
   * unshared path — so a later directory mount of that same path reports ONE
   * entry, with the right name, and a count-based check reads it as shared.
   * The witness is therefore a REGULAR FILE OF A KNOWN SIZE: the runtime
   * creates directories for missing mount sources and never files, so "a
   * regular file of exactly N bytes" is a discriminator the stale case cannot
   * satisfy.
   */
  test("a stale empty directory bearing the witness's own name is still refused", async () => {
    await withRoot(async (root) => {
      const src = join(root, "workspace");
      await mkdir(src);
      await writeFile(join(src, "code.ts"), "export const x = 1;\n");
      // The container answers with the right NAME and the wrong KIND.
      const staleRuntime: Exec = async (argv) => {
        const script = argv[argv.length - 1] ?? "";
        const out: string[] = [];
        for (const m of script.matchAll(/^probe (\d+) '/gm)) out.push(`${m[1]!} d 0`);
        return ok(out.join("\n") + "\n");
      };
      const argv = ["docker", "run", "-v", `${src}:/workspace`, "img"];
      await expect(assertBindMountsVisible([argv], "img", staleRuntime)).rejects.toThrow(
        MountNotVisibleError,
      );
    });
  });

  /** A wrong SIZE is a disagreement too, even when the kind matches. */
  test("a witness file of the wrong size is refused", async () => {
    await withRoot(async (root) => {
      const src = join(root, "skills");
      await mkdir(src);
      await writeFile(join(src, "SKILL.md"), "a".repeat(64));
      const wrongSize: Exec = async (argv) => {
        const script = argv[argv.length - 1] ?? "";
        const out: string[] = [];
        for (const m of script.matchAll(/^probe (\d+) '/gm)) out.push(`${m[1]!} f 63`);
        return ok(out.join("\n") + "\n");
      };
      const argv = ["docker", "run", "-v", `${src}:/skills:ro`, "img"];
      await expect(assertBindMountsVisible([argv], "img", wrongSize)).rejects.toThrow(
        MountNotVisibleError,
      );
    });
  });

  /**
   * A directory with content is probed WITHOUT writing to it.
   *
   * This is what lets the guard run over `run.repo` — the operator's own
   * checkout — and over `~/.config/gcloud`. A probe that dropped a sentinel
   * into a git tree on every `up` would be a worse neighbour than the bug.
   */
  test("a directory that already has a file is probed without writing anything", async () => {
    await withRoot(async (root) => {
      const src = join(root, "repo");
      await mkdir(src);
      await writeFile(join(src, "README.md"), "# repo\n");
      const before = await readdir(src);
      const argv = ["docker", "run", "-v", `${src}:/workspace`, "img"];
      await assertBindMountsVisible([argv], "img", sharingRuntime([]));
      expect(await readdir(src)).toEqual(before);
    });
  });

  /**
   * The EMPTY directory is the outbox, and it is the case with no witness to
   * borrow — so one is written, and it must not survive the probe.
   *
   * An empty source is not a case that can be skipped: `/outbox` is created
   * empty by `materialize` and mounted READ-WRITE, so an unshared one takes
   * every artifact the worker produces and the host collects nothing. That is
   * the "wrote its outbox nowhere the host would read" half of the incident.
   */
  test("an empty directory gets a sentinel, and the sentinel is removed", async () => {
    await withRoot(async (root) => {
      const src = join(root, "outbox");
      await mkdir(src);
      const seen: string[][] = [];
      const exec: Exec = async (argv) => {
        seen.push([...argv]);
        // The sentinel must EXIST on the host at the moment the probe runs.
        expect(await Bun.file(join(src, MOUNT_PROBE_SENTINEL)).exists()).toBe(true);
        return sharingRuntime([])(argv);
      };
      await assertBindMountsVisible([["docker", "run", "-v", `${src}:/outbox`, "img"]], "img", exec);
      expect(seen.length).toBe(1);
      expect(await readdir(src)).toEqual([]);
    });
  });

  test("the sentinel is removed even when the probe fails", async () => {
    await withRoot(async (root) => {
      const src = join(root, "outbox");
      await mkdir(src);
      const boom: Exec = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
      await assertBindMountsVisible(
        [["docker", "run", "-v", `${src}:/outbox`, "img"]],
        "img",
        boom,
      ).catch(() => {});
      expect(await readdir(src)).toEqual([]);
    });
  });
});

describe("which sources the probe is pointed at (ISC-292)", () => {
  /**
   * ONE container for the whole fleet.
   *
   * Six mounts per worker across six workers is thirty-six container starts if
   * each is probed alone, on a command an operator runs interactively. Sharing
   * is a property of the daemon and not of the call, so one measurement answers
   * for all of them.
   */
  test("every source across every worker is probed in a single container", async () => {
    await withRoot(async (root) => {
      const a = join(root, "a");
      const b = join(root, "b");
      await mkdir(a);
      await mkdir(b);
      await writeFile(join(a, "f"), "aa");
      await writeFile(join(b, "f"), "bb");
      const calls: string[][] = [];
      await assertBindMountsVisible(
        [
          ["docker", "run", "-v", `${a}:/workspace`, "img"],
          ["docker", "run", "-v", `${b}:/outbox`, "img"],
        ],
        "img",
        sharingRuntime(calls),
      );
      expect(calls.length).toBe(1);
      const argv = calls[0]!;
      expect(argv.filter((x) => x === "-v").length).toBe(2);
    });
  });

  /** The same path in two workers' argvs is one path, and is measured once. */
  test("a source shared by two workers is probed once", async () => {
    await withRoot(async (root) => {
      const src = join(root, "sessions");
      await mkdir(src);
      await writeFile(join(src, "f"), "x");
      const calls: string[][] = [];
      await assertBindMountsVisible(
        [
          ["docker", "run", "-v", `${src}:/sessions`, "img"],
          ["docker", "run", "-v", `${src}:/sessions`, "img"],
        ],
        "img",
        sharingRuntime(calls),
      );
      expect(calls[0]!.filter((x) => x === "-v").length).toBe(1);
    });
  });

  /**
   * A NAMED VOLUME names nothing on the host, so there is no host content a
   * mount of it could hide. `pifleet-piagent-<id>` is one, and mounting it into
   * the probe would be meaningless.
   */
  test("a named volume is not probed", async () => {
    const calls: string[][] = [];
    await assertBindMountsVisible(
      [["docker", "run", "-v", "pifleet-piagent-eng-1:/home/pi/.pi/agent", "img"]],
      "img",
      sharingRuntime(calls),
    );
    expect(calls.length).toBe(0);
  });

  /**
   * A source that does not exist on the host is NOT mounted into the probe.
   *
   * Not fastidiousness: `docker run -v <missing>:<dst>` CREATES the source on
   * the host, so probing one would make the diagnostic the thing that
   * materialized the directory it was asked about. A missing source is
   * ISC-188's criterion, and it is loud there.
   */
  test("a source absent from the host is not mounted into the probe", async () => {
    await withRoot(async (root) => {
      const calls: string[][] = [];
      await assertBindMountsVisible(
        [["docker", "run", "-v", `${join(root, "never-created")}:/workspace`, "img"]],
        "img",
        sharingRuntime(calls),
      );
      expect(calls.length).toBe(0);
      expect(await readdir(root)).toEqual([]);
    });
  });

  /** A FILE source is the case the incident actually surfaced through. */
  test("a file source is probed as a file, not as its parent", async () => {
    await withRoot(async (root) => {
      const file = join(root, "system-append.md");
      await writeFile(file, "you are a worker\n");
      const calls: string[][] = [];
      await assertBindMountsVisible(
        [["docker", "run", "-v", `${file}:/briefing/system-append.md:ro`, "img"]],
        "img",
        sharingRuntime(calls),
      );
      const argv = calls[0]!;
      const spec = argv[argv.indexOf("-v") + 1]!;
      expect(spec).toBe(`${file}:/probe/0:ro`);
    });
  });

  /**
   * The briefing case END TO END: a host file that the container reports as a
   * directory is exactly the `EISDIR` the false diagnosis came from.
   */
  test("a host FILE the container reports as a directory is refused", async () => {
    await withRoot(async (root) => {
      const file = join(root, "system-append.md");
      await writeFile(file, "you are a worker\n");
      await expect(
        assertBindMountsVisible(
          [["docker", "run", "-v", `${file}:/briefing/system-append.md:ro`, "img"]],
          "img",
          emptyDirRuntime,
        ),
      ).rejects.toThrow(MountNotVisibleError);
    });
  });
});

describe("the probe container itself (ISC-292)", () => {
  test("is read-only, network-less, and disposable", async () => {
    await withRoot(async (root) => {
      const src = join(root, "a");
      await mkdir(src);
      await writeFile(join(src, "f"), "x");
      const calls: string[][] = [];
      await assertBindMountsVisible(
        [["docker", "run", "-v", `${src}:/workspace`, "img"]],
        "the-image:tag",
        sharingRuntime(calls),
      );
      const argv = calls[0]!;
      expect(argv[0]).toBe("docker");
      expect(argv).toContain("--rm");
      expect(argv).toContain("--read-only");
      expect(argv).toContain("--network");
      expect(argv[argv.indexOf("--network") + 1]).toBe("none");
      expect(argv).toContain("the-image:tag");
      // Every mount into the probe is read-only: it measures, it does not use.
      for (const [i, a] of argv.entries()) {
        if (argv[i - 1] === "-v") expect(a).toEndWith(":ro");
        void a;
      }
    });
  });

  /**
   * A probe that cannot run must not read as "everything is fine".
   *
   * The whole class of bug this criterion is about is a check that passes
   * without measuring, so an unusable probe is reported as a refusal rather
   * than shrugged off.
   */
  test("a probe container that fails to run is a refusal, not a pass", async () => {
    await withRoot(async (root) => {
      const src = join(root, "a");
      await mkdir(src);
      await writeFile(join(src, "f"), "x");
      const dead: Exec = async () => ({
        code: 125,
        stdout: "",
        stderr: "docker: no such image",
        timedOut: false,
      });
      await expect(
        assertBindMountsVisible([["docker", "run", "-v", `${src}:/workspace`, "img"]], "img", dead),
      ).rejects.toThrow(MountNotVisibleError);
    });
  });

  /** A source the probe was never told about must not silently read as visible. */
  test("a source the container answered nothing about is refused", async () => {
    await withRoot(async (root) => {
      const src = join(root, "a");
      await mkdir(src);
      await writeFile(join(src, "f"), "x");
      const silent: Exec = async () => ok("");
      await expect(
        assertBindMountsVisible(
          [["docker", "run", "-v", `${src}:/workspace`, "img"]],
          "img",
          silent,
        ),
      ).rejects.toThrow(MountNotVisibleError);
    });
  });
});

describe("probeBindMountSources reports rather than throws (ISC-292)", () => {
  /** The reporting half of "refused OR reported" — what `doctor` would consume. */
  test("returns a verdict per probed source", async () => {
    await withRoot(async (root) => {
      const good = join(root, "good");
      await mkdir(good);
      await writeFile(join(good, "f"), "x");
      const verdicts = await probeBindMountSources([good], "img", sharingRuntime([]));
      expect(verdicts.length).toBe(1);
      expect(verdicts[0]!.source).toBe(good);
      expect(verdicts[0]!.visible).toBe(true);
      expect(verdicts[0]!.detail).toContain("visible");
    });
  });

  test("no sources means no container is started at all", async () => {
    const calls: string[][] = [];
    const verdicts = await probeBindMountSources([], "img", sharingRuntime(calls));
    expect(verdicts).toEqual([]);
    expect(calls.length).toBe(0);
  });

  /**
   * `$HOME` is the path every supported runtime shares by default, and the
   * defaults live under it. A guard that refused the DEFAULT configuration
   * would be worse than no guard, so this pins that the default shape reads
   * clean against a truthful runtime.
   */
  test("the default-shaped roots under $HOME are not refused", async () => {
    const dir = await mkdtemp(join(homedir(), ".pifleet-isc292-"));
    try {
      await writeFile(join(dir, "f"), "x");
      const verdicts = await probeBindMountSources([dir], "img", sharingRuntime([]));
      expect(verdicts[0]!.visible).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
