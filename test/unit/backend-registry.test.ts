/**
 * The backend registry (ISC-128, ISC-131, ISC-137).
 *
 * This file exists because the three backends were, briefly, 1,663 lines of
 * tested code that nothing could reach: `up` hard-refused anything but
 * `headless`, so `createCmuxBackend` and `createTmuxBackend` had zero
 * production callers while their own suites passed. That is the same shape as
 * the two dead subsystems found in earlier phases, and a green suite is
 * exactly what makes it look finished.
 *
 * So these tests assert REACHABILITY, not just correctness: every declared
 * kind loads, and the thing it returns is the backend of that kind.
 */

import { describe, expect, test } from "bun:test";
import { isBackendKind, loadBackend } from "../../src/backends/registry.ts";
import type { BackendKind } from "../../src/backends/types.ts";

describe("every declared backend kind is actually loadable", () => {
  test.each(["cmux", "tmux", "headless"] as const)(
    "%s loads and reports its own kind",
    async (kind) => {
      const backend = await loadBackend(kind);
      // `kind` round-tripping is the cheap proof that the registry's name
      // mangling found the right factory rather than any factory.
      expect(backend.kind).toBe(kind);
      // The seam's required surface — a backend missing one of these would
      // fail at `up` time, in a detached process, with a worse message.
      expect(typeof backend.probe).toBe("function");
      expect(typeof backend.ensureWorkspace).toBe("function");
      expect(typeof backend.createPane).toBe("function");
      expect(typeof backend.destroy).toBe("function");
    },
  );

  /**
   * Loading cmux must not be a precondition for anything else. ISC-128 wants
   * the acceptance suite green with cmux not running, and a registry that
   * eagerly imported every backend would drag cmux's module into every run.
   */
  test("loading headless does not require cmux to be present or working", async () => {
    const backend = await loadBackend("headless");
    expect(backend.kind).toBe("headless");
    await expect(backend.probe()).resolves.toBeDefined();
  });
});

/**
 * The options bag must reach the factory. The registry's first version took no
 * arguments, which quietly made every backend unconfigurable — the tmux
 * backend's `-L` private socket, the thing that keeps concurrent fleets off
 * each other's server, was unreachable through the only path `up` uses.
 *
 * Asserted through an observable difference rather than a spy: a tmux backend
 * built with an explicit socket name must put `-L <name>` on its argv, and one
 * built without must not.
 */
describe("loadBackend passes options through to the backend factory", () => {
  test("an explicit tmux socket name reaches the spawned argv", async () => {
    const seen: string[][] = [];
    const exec = async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      seen.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const backend = await loadBackend("tmux", { socketName: "pifleet-opts-probe", exec });
    await backend.probe().catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    const flat = seen.flat();
    expect(flat).toContain("-L");
    expect(flat).toContain("pifleet-opts-probe");
  });

  test("without a socket name the argv carries no -L", async () => {
    const seen: string[][] = [];
    const exec = async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      seen.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    // The env default would otherwise leak a socket in from the surrounding
    // shell and make this assertion depend on how the suite was invoked.
    const prev = process.env["PIFLEET_TMUX_SOCKET"];
    delete process.env["PIFLEET_TMUX_SOCKET"];
    try {
      const backend = await loadBackend("tmux", { exec });
      await backend.probe().catch(() => {});
      expect(seen.flat()).not.toContain("-L");
    } finally {
      if (prev !== undefined) process.env["PIFLEET_TMUX_SOCKET"] = prev;
    }
  });
});

describe("the kind guard is the allowlist that keeps operator input out of a module path", () => {
  test.each(["cmux", "tmux", "headless"])("accepts %j", (k) => {
    expect(isBackendKind(k)).toBe(true);
  });

  test.each(["", "CMUX", "screen", "../../etc/passwd", "cmux/../..", "headless "])(
    "rejects %j",
    (k) => {
      expect(isBackendKind(k)).toBe(false);
    },
  );

  /**
   * `--backend` is operator input and `loadBackend` interpolates the kind into
   * an import specifier. The CLI validates first, but this function builds the
   * path, so it re-checks rather than trusting a caller — a traversal reaching
   * `import()` is a load-anything primitive.
   */
  test("a traversal kind is refused rather than imported", async () => {
    await expect(loadBackend("../../etc/passwd" as BackendKind)).rejects.toThrow(/unknown backend/);
  });
});
