/**
 * The monitor cannot write, and the proof is structural rather than behavioural
 * (ISC-468, ISC-470, ISC-473 — SRD-FLEET-MONITOR D3, D15).
 *
 * ## Why an import walk and not "assert it did not write during this run"
 *
 * A behavioural test passes for a monitor that writes on a code path the test
 * did not reach, and a viewer has many such paths: an error branch, a cache
 * that only materialises under memory pressure, a debug dump behind an
 * environment variable. **An import walk cannot be satisfied by luck.** If
 * nothing in the transitive closure can open a control socket or write the run
 * tree, then no input can make the monitor do it.
 *
 * ## A correction to the criterion's own wording, recorded rather than quietly
 * ## worked around
 *
 * ISC-468's probe says to walk the imports "as `logs.ts`'s suite already does".
 * **It does not.** `test/unit/logs-render.test.ts` asserts rendering, and a
 * search of `test/` for any transitive import assertion finds none — the
 * closest things are single-module string checks. So the precedent this
 * criterion leans on did not exist and the walk below is the first of its kind
 * in this repository. That matters for a reader deciding whether to trust the
 * mechanism: it is new code, not a reuse of something already load-bearing, and
 * `walks its own fixture` below exists to test the tester for that reason.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { readRuns } from "../../src/monitor/read/runs.ts";

const SRC = new URL("../../src/", import.meta.url).pathname;

/** The monitor's entry points. Everything reachable from these is in scope. */
const ROOTS = [
  "monitor/model.ts",
  "monitor/activity.ts",
  "monitor/read/runs.ts",
  "monitor/read/worker.ts",
  "monitor/read/events.ts",
  "monitor/read/docker.ts",
  /*
   * The join, the seam and the view. Added after the render engineer noted the
   * hole: `ROOTS` named six modules and neither `render.ts` nor `fleet.tsx` was
   * among them, so the closure had a gap exactly where the newest code was.
   * `compose.ts` is the more important of the three — it is the only file that
   * holds a reader and the activity ladder at once, which makes it the natural
   * place for someone to reach for a control call.
   */
  "monitor/compose.ts",
  "monitor/render.ts",
  "monitor/views/fleet.tsx",
];

/**
 * Every module reachable from `entry` by static relative import, as repo-
 * relative paths under `src/`.
 *
 * Relative specifiers only: a bare specifier is a package, and a package cannot
 * reach this repository's run tree except through code in this repository,
 * which the walk already covers. `node:` builtins are handled separately by the
 * write-primitive check below, because `node:fs` is exactly the import a writer
 * would need and excluding it from the walk would be excluding the suspect.
 */
function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(SRC, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    // `from "…"` covers static imports and re-exports; `import("…")` covers the
    // dynamic form `paths.ts` itself uses for `node:fs/promises`.
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const spec = m[1]!;
      const next = relative(SRC, resolve(dirname(abs), spec));
      queue.push(next);
    }
  }
  return seen;
}

const CLOSURE = (() => {
  const all = new Set<string>();
  for (const r of ROOTS) for (const m of transitiveImports(r)) all.add(m);
  return all;
})();

describe("ISC-468: nothing the monitor imports can write or command", () => {
  /**
   * TESTING THE TESTER. A walk that silently resolved nothing would pass every
   * assertion below by vacuity, and that is the failure mode a new mechanism
   * has. The monitor's own readers import `run/paths.ts` and `run/state.ts`, so
   * a working walk must reach them from a root that names neither directly.
   */
  test("walks its own fixture — the closure is real, not empty", () => {
    expect(CLOSURE.size).toBeGreaterThan(5);
    expect(CLOSURE.has("run/paths.ts")).toBe(true);
    expect(CLOSURE.has("run/state.ts")).toBe(true);
    // Reached only via `read/runs.ts` -> `run/registry.ts`, i.e. two hops.
    expect(CLOSURE.has("run/registry.ts")).toBe(true);
  });

  /**
   * The control plane. `rpc/client.ts` is how a caller commands a worker, and a
   * viewer that can reach it is one refactor from being a control surface —
   * which is D15's whole content.
   */
  test("no control-socket client is reachable", () => {
    expect([...CLOSURE].filter((m) => m.startsWith("rpc/client"))).toEqual([]);
  });

  /**
   * The ledger is APPEND-ONLY STATE about gated verbs. A monitor that can write
   * it can forge an audit row, which is worse than a monitor that crashes.
   */
  test("the ledger writer is not reachable", () => {
    expect([...CLOSURE].filter((m) => m === "run/ledger.ts")).toEqual([]);
  });

  /**
   * Any dispatching command. The monitor renders what a run did; it must not be
   * able to start one.
   */
  test("no dispatching CLI command is reachable", () => {
    const commands = [...CLOSURE].filter((m) => m.startsWith("cli/commands/"));
    expect(commands).toEqual([]);
  });

  /**
   * THE WRITE PRIMITIVES, checked on the monitor's OWN modules rather than on
   * the closure.
   *
   * The closure legitimately contains writers: `run/state.ts` exports
   * `writeWorkerState` and the monitor imports that module for `readWorkerState`.
   * Asserting the closure holds no writer at all would therefore fail against a
   * correct design, and loosening it to pass would assert nothing. **What is
   * actually required is that the monitor's own code never CALLS one**, which is
   * a property of six files rather than of forty.
   */
  test("the monitor's own modules call no write primitive", () => {
    const forbidden = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "mkdir",
      "rm(",
      "unlink",
      "writeJsonAtomic",
      "writeWorkerState",
      "writeAttended",
      "recordInjection",
    ];
    const offenders: string[] = [];
    for (const rel of ROOTS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const f of forbidden) if (source.includes(f)) offenders.push(`${rel}: ${f}`);
    }
    expect(offenders).toEqual([]);
  });
});

/** Comment-stripping local to this file so a doc comment naming a writer does not fail it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("ISC-470: a read-only runs root renders rather than throwing", () => {
  /**
   * The complement to ISC-468, and it catches a different failure. The import
   * walk proves the monitor cannot write through a KNOWN writer; this proves it
   * does not write through an unknown one — a cache file, a lock, an index it
   * builds "just once". **A monitor that needs write access to a directory it
   * only reads has a bug that surfaces on someone else's permissions rather
   * than on the author's**, which is the class of defect that reaches an
   * operator and never a test.
   */
  test("renders a fleet from a runs root with every write bit removed", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-ro-"));
    try {
      const root = join(base, "runs");
      const runId = "2026-09-02T00-00-00Z-ro01";
      await mkdir(join(root, runId, "workers", "w-1"), { recursive: true });
      await writeFile(join(root, runId, "run.json"), JSON.stringify({ run_id: runId }));

      // Strip write permission from the tree, deepest first — a parent made
      // read-only first would block the chmod of its own children.
      await chmod(join(root, runId, "workers", "w-1"), 0o555);
      await chmod(join(root, runId, "workers"), 0o555);
      await chmod(join(root, runId), 0o555);
      await chmod(root, 0o555);

      // THE CRITERION: a region, not a throw. Whether it is `ok` or `failed`
      // depends on what the readers can see; what must not happen is an
      // exception escaping, which is what a stray write would produce as
      // EACCES.
      const region = await readRuns({ root });
      expect(["ok", "failed", "never"]).toContain(region.status);
    } finally {
      // Restore write bits before cleanup or `rm` cannot remove the tree.
      for (const p of [base, join(base, "runs")]) {
        try {
          await chmod(p, 0o755);
        } catch {
          /* already gone */
        }
      }
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("ISC-468: the CLI command is a two-import surface", () => {
  /**
   * `src/cli/commands/monitor.ts` cannot be a ROOT of the walk above, and the
   * reason is worth stating because it looks like an omission. The walk asserts
   * that nothing under `cli/commands/` is REACHABLE from the monitor; making a
   * `cli/commands/` file a root would put it in its own closure and fail that
   * assertion by construction.
   *
   * So the command gets the guard it actually needs instead. It is the one file
   * that bridges the CLI and the monitor, which makes it the single place where
   * a viewer could be turned into a control surface by adding one import — a
   * `--steer` flag here would be a one-line change. What holds is that it
   * imports exactly two things from the monitor and nothing else from it.
   */
  const CMD = stripComments(
    readFileSync(new URL("../../src/cli/commands/monitor.ts", import.meta.url).pathname, "utf8"),
  );

  test("it imports only composeFleet and renderFleet from the monitor", () => {
    const monitorImports = [...CMD.matchAll(/from\s+["']([^"']*monitor[^"']*)["']/g)].map((m) => m[1]!);
    expect(monitorImports.sort()).toEqual([
      "../../monitor/compose.ts",
      "../../monitor/render.ts",
    ]);
  });

  test("it reaches no control verb, socket or ledger", () => {
    for (const forbidden of [
      "rpc/client",
      "run/ledger",
      "dispatch",
      "steer",
      "abort",
      "unstage",
      "harvest",
      "writeWorkerState",
    ]) {
      expect(CMD, `monitor command reaches ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("ISC-473: no verdict is produced outside view 4", () => {
  /**
   * D10: the monitor reads what the harvest computed and never computes it
   * again. Two adjudicators that disagree is the shape ISC-231 and ISC-345
   * already record, and a viewer is the worst place for it because its answer
   * is the one a human reads.
   *
   * The import half is asserted here. The call-graph half — that neither the
   * fast nor the medium clock reaches these — belongs with the scheduler and is
   * asserted in `monitor-clocks.test.ts`.
   */
  /**
   * **THIS ASSERTION WAS NARROWED, AND THE REASON IS A CONFLICT BETWEEN TWO
   * CRITERIA IN THE SAME BLOCK — recorded here rather than resolved silently.**
   *
   * ISC-473's probe says "import-list assertion". Written against the
   * TRANSITIVE closure it cannot pass, and not because of anything the monitor
   * does:
   *
   *     monitor/read/runs.ts -> run/registry.ts -> run/state.ts
   *                          -> run/worktree.ts -> harvest/git.ts
   *
   * `run/state.ts` is the module **ISC-472 requires** the monitor to use — a
   * local `JSON.parse` instead is exactly what that criterion forbids, because
   * it discards `readValidated` and the `StateReadError` path. So the two
   * criteria as literally worded cannot both hold: satisfying ISC-473's closure
   * reading means violating ISC-472.
   *
   * The narrowing keeps the force and drops the impossibility. What ISC-473 is
   * actually about is D10 — **the monitor reads what the harvest computed and
   * never computes it again** — and a module being reachable four hops away
   * through a shared reader says nothing about that. What does say something is
   * whether the monitor's own code imports or calls an adjudicator, which is a
   * property of six files and is what is asserted below.
   *
   * The call-graph half — that neither the fast nor the medium clock reaches
   * these — belongs with the scheduler and is asserted in
   * `monitor-clocks.test.ts`.
   */
  test("the monitor's own modules import nothing from harvest and no adjudicator", () => {
    const offenders: string[] = [];
    for (const rel of ROOTS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.includes("harvest/") || spec.includes("adjudicate")) {
          offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no monitor module calls an adjudicator or a harvester", () => {
    const offenders: string[] = [];
    for (const rel of ROOTS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const call of ["adjudicate(", "harvestTask(", "collectRunReport("]) {
        if (source.includes(call)) offenders.push(`${rel}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
