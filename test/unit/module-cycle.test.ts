/**
 * Every safety module must load as the FIRST module of a fresh process.
 *
 * ## The failure this exists to catch, measured rather than imagined
 *
 * `safety/kill.ts` sat on the cycle its own header has described since the
 * reaper landed:
 *
 *     kill.ts -> run/registry.ts -> ... -> safety/reaper.ts -> kill.ts
 *
 * Whichever module imported `kill.ts` first got
 * `ReferenceError: Cannot access 'realProcessOps' before initialization` from
 * `reaper.ts`, because `realReaperOps` spreads a `const` in a module still
 * mid-evaluation. On 2026-08-27, `bun test test/unit/kill.test.ts` — the
 * obvious command for anyone working on the kill ladder — was 0 pass / 1 error
 * / exit 1. Its thirty probes ran ONLY in a full-suite run, where some earlier
 * file happened to import the modules in a working order.
 *
 * ## Why this is a subprocess and not an import at the top of this file
 *
 * An in-process import proves nothing after the first test file has run: the
 * module graph is already warm, so the broken order is unreachable and the
 * assertion passes for every arrangement of the code. The property is about
 * being FIRST, so each case has to get a process of its own.
 *
 * The cost is one `bun` spawn per module, which is why the list is the safety
 * surface rather than all of `src/`.
 */

import { describe, expect, test } from "bun:test";
import { cliBudget } from "../support/budget.ts";

/**
 * The modules a cycle would strand. `kill.ts` is the one that WAS broken;
 * the others are its neighbours on the same graph, listed so that a future
 * extraction that moves the problem rather than removing it is still caught.
 */
const SAFETY_MODULES = [
  "src/safety/kill.ts",
  "src/safety/reaper.ts",
  "src/safety/procstart.ts",
  "src/safety/procgroup.ts",
  "src/safety/stall.ts",
  "src/run/registry.ts",
] as const;

describe("no safety module is stranded by an initialisation cycle", () => {
  for (const mod of SAFETY_MODULES) {
    test(
      `${mod} loads first in a fresh process`,
      async () => {
        const proc = Bun.spawn(["bun", "-e", `await import("./${mod}")`], {
          cwd: new URL("../..", import.meta.url).pathname,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        /*
         * The message is asserted as well as the exit code. A cycle is not the
         * only way to exit nonzero, and "it failed" would keep passing for a
         * syntax error long after the property under test had been lost.
         */
        expect(err).not.toContain("before initialization");
        expect(code, `importing ${mod} first failed:\n${out}\n${err}`).toBe(0);
      },
      cliBudget(1),
    );
  }
});
