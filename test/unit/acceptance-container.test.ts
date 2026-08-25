/**
 * The acceptance exam's container argv (ISC-233).
 *
 * These assertions are about a VALUE — the finished argv — rather than about
 * source text, which is the distinction `test/support/env-sweep.ts` makes at
 * length: a source sweep is the weakest instrument available and is used only
 * where no value can be inspected. Here one can, so it is.
 *
 * What this file cannot show is that the argv is REACHED. That is
 * `acceptance-wiring.test.ts`'s job, and it is a separate file on purpose: a
 * correct builder beside a path nothing exercises is the defect this ISA has
 * recorded eight times, and `AcceptanceContext.image` sat at the literal `null`
 * for a year while four test files stayed green over it.
 */

import { describe, expect, test } from "bun:test";

import {
  ACCEPTANCE_WORKDIR,
  acceptanceContainerArgv,
  acceptanceContainerEnv,
  networkFromLaunchArgv,
} from "../../src/harvest/acceptance-container.ts";
import { WORKER_UID } from "../../src/container/mounts.ts";

const BASE = {
  image: "pifleet/pi-worker:verify",
  cloneDir: "/Users/x/.pifleet/scratch/accept-1/clone",
  argv: ["bun", "test"] as const,
  env: { CI: "1" },
};

/** Index of the image in a finished argv — everything after it is the command. */
function imageIndex(argv: readonly string[], image: string): number {
  // The image is the LAST occurrence: a tag could in principle also appear as
  // an option value, and the command line's structure is `... <image> <cmd>`.
  return argv.lastIndexOf(image);
}

describe("the exam's container argv (ISC-233)", () => {
  test("mounts the fresh clone at the workdir the image bakes safe.directory for", () => {
    const argv = acceptanceContainerArgv(BASE);
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    expect(argv).toContain("-v");
    expect(argv.some((a) => a === `${BASE.cloneDir}:${ACCEPTANCE_WORKDIR}`)).toBe(true);
    expect(argv[argv.indexOf("-w") + 1]).toBe(ACCEPTANCE_WORKDIR);
    // Not a free choice: `docker/Dockerfile` bakes
    // `git config --system --add safe.directory /workspace`, and that baked
    // entry is what lets uid 10001 run git in a mount the host uid owns.
    expect(ACCEPTANCE_WORKDIR).toBe("/workspace");
  });

  test("the clone is the ONLY mount", () => {
    const argv = acceptanceContainerArgv(BASE);
    const mounts = argv.filter((a, i) => argv[i - 1] === "-v" || argv[i - 1] === "--volume");
    expect(mounts).toEqual([`${BASE.cloneDir}:${ACCEPTANCE_WORKDIR}`]);
  });

  test("runs under the worker's posture, not a weaker one (§5.6)", () => {
    const argv = acceptanceContainerArgv(BASE);
    expect(argv[argv.indexOf("--user") + 1]).toBe(`${WORKER_UID}:${WORKER_UID}`);
    expect(argv[argv.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(argv).toContain("--read-only");
    expect(argv[argv.indexOf("--tmpfs") + 1]).toContain("noexec");
  });

  test("overrides the entrypoint so the command runs instead of a Pi session", () => {
    const argv = acceptanceContainerArgv({ ...BASE, argv: ["bun", "test", "--bail"] });
    // The image's entrypoint is `tini -- pifleet-entrypoint`, which renders
    // Pi's model config and exec's the agent. Left in place it would start an
    // agent, not a test suite, and the exam would grade nothing.
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("bun");
    const at = imageIndex(argv, BASE.image);
    expect(argv.slice(at + 1)).toEqual(["test", "--bail"]);
  });

  test("a single-word command leaves no trailing arguments", () => {
    const argv = acceptanceContainerArgv({ ...BASE, argv: ["make"] });
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("make");
    expect(argv.slice(imageIndex(argv, BASE.image) + 1)).toEqual([]);
  });

  /**
   * ISC-31 and ISC-149 forbid the same flag shape from two directions: the
   * bare `-e NAME` copies a value out of the HOST environment, which is a
   * cloud-key pass-through to one criterion and an inherited environment to
   * the other. Asserted on the value, which is the strong instrument — the
   * source sweep in `env-sweep.ts` exists only for producers that build argv
   * from inline literals.
   */
  test("every -e supplies a value; none inherits one", () => {
    const argv = acceptanceContainerArgv({ ...BASE, env: { CI: "1", HOME: "/tmp" } });
    const passed = argv.filter((a, i) => argv[i - 1] === "-e" || argv[i - 1] === "--env");
    expect(passed.length).toBeGreaterThan(0);
    for (const e of passed) expect(e).toContain("=");
    expect(passed).toContain("CI=1");
    expect(passed).toContain("HOME=/tmp");
  });

  test("the network is passed through when the run recorded one", () => {
    const argv = acceptanceContainerArgv({ ...BASE, network: "pifleet-egress" });
    expect(argv[argv.indexOf("--network") + 1]).toBe("pifleet-egress");
  });

  test("no --network at all when the run recorded none", () => {
    expect(acceptanceContainerArgv({ ...BASE, network: null })).not.toContain("--network");
    expect(acceptanceContainerArgv(BASE)).not.toContain("--network");
  });

  test("refuses an empty command or an empty image rather than building nonsense", () => {
    expect(() => acceptanceContainerArgv({ ...BASE, argv: [] })).toThrow(/empty command/);
    expect(() => acceptanceContainerArgv({ ...BASE, image: "" })).toThrow(/empty image/);
  });
});

describe("the container-side environment", () => {
  /**
   * The three differences from `buildEnv` that are load-bearing. Each is
   * asserted rather than described, because the module's own docstring is
   * exactly the kind of prose that stays true-looking after the code moves.
   */
  test("does not inject the host PATH over the image's", () => {
    expect(acceptanceContainerEnv()["PATH"]).toBeUndefined();
  });

  test("HOME points at the writable tmpfs, not the read-only baked home", () => {
    // The image bakes HOME=/home/pi, which sits on the `--read-only` root; a
    // suite writing a cache there gets EROFS. /tmp is the tmpfs mounted by
    // the argv above and is the only writable path that is not the graded tree.
    expect(acceptanceContainerEnv()["HOME"]).toBe("/tmp");
  });

  /**
   * The one that would be silently catastrophic, and the reason it is pinned.
   *
   * The HOST path sets `GIT_CONFIG_SYSTEM=/dev/null`, correctly: on a laptop
   * `/etc/gitconfig` is operator state. In the image it is a build-time
   * artifact holding exactly one line — `safe.directory /workspace` — so
   * copying the host's stance here would REINSTATE the CVE-2022-24765
   * ownership refusal for every acceptance command that shells out to git,
   * and would do it only on Linux, because macOS squashes mount ownership and
   * hides the whole class.
   */
  test("does NOT blank GIT_CONFIG_SYSTEM, which carries the image's safe.directory", () => {
    expect(acceptanceContainerEnv()["GIT_CONFIG_SYSTEM"]).toBeUndefined();
    // The global one IS blanked, and that stays true: HOME is a tmpfs, so
    // there is nothing there to read and saying so costs nothing.
    expect(acceptanceContainerEnv()["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
  });
});

describe("reading the network back out of a launch record", () => {
  test("finds --network in a recorded argv", () => {
    expect(networkFromLaunchArgv(["docker", "run", "--network", "pifleet-egress", "img"])).toBe(
      "pifleet-egress",
    );
  });

  test("accepts the --net spelling docker also honours", () => {
    expect(networkFromLaunchArgv(["docker", "run", "--net", "none", "img"])).toBe("none");
  });

  test("null when the argv names no network", () => {
    expect(networkFromLaunchArgv(["docker", "run", "--rm", "img"])).toBeNull();
  });

  test("null rather than undefined-past-the-end when --network is last", () => {
    expect(networkFromLaunchArgv(["docker", "run", "--network"])).toBeNull();
  });

  /**
   * Against the REAL renderer's output, not a hand-written argv.
   *
   * The hand-written cases above prove the parser reads what it is shown; only
   * this one proves it reads what production writes. If `render.ts` ever spells
   * the flag differently — or stops emitting one — those four keep passing and
   * this goes red, which is the whole reason it is here.
   */
  test("reads the network off an argv the production renderer produced", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { stringify } = await import("yaml");
    const { renderWorker } = await import("../../src/config/render.ts");
    const { loadConfig } = await import("../../src/config/load.ts");

    const dir = await mkdtemp(join(tmpdir(), "pifleet-acc-net-"));
    const runsDir = await mkdtemp(join(tmpdir(), "pifleet-acc-net-runs-"));
    const priorRuns = process.env["PIFLEET_RUNS_DIR"];
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    try {
      await mkdir(join(dir, "roles"), { recursive: true });
      await writeFile(join(dir, "roles", "eng.md"), "Engineer.\n");
      await writeFile(
        join(dir, "fleet.yaml"),
        stringify({
          version: 2,
          name: "acc-net",
          docker: { pi_version: "0.79.6", network: "pifleet-egress" },
          run: { root: "./decoy", repo: ".", budget: { tokens_ceiling: 1_000_000 } },
          llm: { model: "M", api_key_env: "PIFLEET_TEST_KEY" },
          roles: { eng: { model: "M", append_system_prompt_file: "./roles/eng.md" } },
          workers: [{ id: "eng-1", role: "eng" }],
        }),
      );
      const loaded = await loadConfig(join(dir, "fleet.yaml"));
      const r = await renderWorker(loaded, "eng-1");
      expect(networkFromLaunchArgv(r.docker)).toBe("pifleet-egress");
      expect(networkFromLaunchArgv(r.docker)).toBe(loaded.config.docker.network);
    } finally {
      if (priorRuns === undefined) delete process.env["PIFLEET_RUNS_DIR"];
      else process.env["PIFLEET_RUNS_DIR"] = priorRuns;
      await rm(dir, { recursive: true, force: true });
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
