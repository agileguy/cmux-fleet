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
