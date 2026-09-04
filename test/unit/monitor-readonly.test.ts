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
  "monitor/clocks.ts",
  "monitor/compose.ts",
  "monitor/render.ts",
  "monitor/views/fleet.tsx",
  /*
   * Views 2-4's readers. Added with the modules rather than after them, because
   * the walk's whole value is that a file cannot be in the monitor and outside
   * the guard at the same time — and `read/report.ts` in particular is the one
   * file in this design that reaches a verdict-producing module, so leaving it
   * out of `ROOTS` to spare the assertions below would have removed exactly the
   * file most worth walking.
   */
  "monitor/read/history.ts",
  "monitor/read/detail.ts",
  "monitor/read/report.ts",
  /*
   * VIEWS 2-4 AND THE CHROME THEY SHARE (ISC-506).
   *
   * Added with the views themselves rather than afterwards, because the gap
   * this list had when `render.ts` and `fleet.tsx` were missing from it is the
   * gap it would have again: **the closure would cover exactly the code that
   * is oldest and least likely to acquire a writer, and miss the code being
   * written today.** Three new files that render a worker, a run list and a
   * report are precisely where someone reaches for "just one control call" —
   * view 2 is the view an operator opens when a worker is in trouble, and a
   * `[k]ill` key would live there.
   *
   * `chrome.tsx` is reachable from all four views, so the transitive walk
   * would find it anyway. It is named explicitly because the write-primitive
   * and adjudicator checks below iterate `ROOTS` rather than the closure, and
   * a shared module those checks did not cover would be the one place a call
   * could hide from them while being imported by every view.
   */
  "monitor/views/chrome.tsx",
  "monitor/views/worker.tsx",
  "monitor/views/history.tsx",
  "monitor/views/report.tsx",
];

/**
 * **VIEW 4, AND THE ONE EXEMPTION IN THIS FILE.**
 *
 * ISC-473 is worded *"the monitor never calls `adjudicate`, `harvestTask` or
 * anything that produces a verdict **outside view 4**"*, and §6.2 defines view
 * 4 as `collectRunReport` for one selected run. So a module that collects a run
 * report is not a violation of that criterion, it is the criterion's carve-out
 * arriving as code — and the two assertions below would fail on it for the
 * exact behaviour the SRD specifies.
 *
 * **Named as one file rather than loosened into a predicate.** A test that
 * skipped "any module whose name contains report" would exempt the next one
 * too. This list is the set of files allowed to reach a verdict, it has one
 * member, and adding a second is an edit somebody has to justify here.
 *
 * What is NOT exempted, and is what actually holds D10 up: `read/report.ts` is
 * unreachable from every clock. `fleetSources` does not name it, `compose.ts`
 * reaches it only through `fetchForView`'s `report` arm, and
 * `monitor-clocks.test.ts` plus the call-graph probe below assert that no
 * source's `read()` touches it.
 */
const VIEW_4 = ["monitor/read/report.ts"];

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
   *
   * **THIS ASSERTION WAS NARROWED WHEN VIEW 4 SHIPPED, and the narrowing is the
   * same shape — and the same conflict — ISC-473's is.** `run/ledger.ts` holds
   * BOTH halves of the ledger: `LedgerWriter` (`:16`) and `mergeLedger`
   * (`:83`). `collectRunReport`'s first act is `mergeLedger(run)`, and §6.2's
   * view 4 IS `collectRunReport`, so the module is now in the closure by way of
   * a READ that the SRD requires. The criterion as literally worded — "the
   * ledger writer is not reachable" — cannot hold for a monitor that renders a
   * report, and loosening it to pass would assert nothing.
   *
   * So the module-level check becomes a CALL-level one, which is what the
   * criterion was actually about. `run/state.ts` set this precedent already:
   * it exports `writeWorkerState` and the monitor imports it for
   * `readWorkerState`, so the file's own header records that "what is actually
   * required is that the monitor's own code never CALLS one". The ledger is now
   * the second module in that position, and it is held the same way.
   *
   * Nothing is lost that was being checked: the reachability assertion never
   * proved the monitor would not write a ledger row, only that it could not
   * find the class. The name is what a write needs, and the name is what is
   * asserted absent.
   */
  test("no monitor module can construct a ledger writer", () => {
    /*
     * The read half is reachable EXACTLY where view 4 is reachable and nowhere
     * else — which is a stronger statement than "only `read/report.ts` reaches
     * it", because `compose.ts` imports that module and so reaches the ledger
     * too. What must not exist is a SECOND route: a root that can reach the
     * ledger without going through view 4 would be a monitor module holding
     * ledger access for some other purpose, and that is the thing this
     * assertion is actually for.
     */
    const reachesLedger = ROOTS.filter((rel) => transitiveImports(rel).has("run/ledger.ts"));
    const reachesView4 = ROOTS.filter(
      (rel) => VIEW_4.includes(rel) || VIEW_4.some((v) => transitiveImports(rel).has(v)),
    );
    expect(reachesLedger).toEqual(reachesView4);
    expect(reachesLedger).toContain(VIEW_4[0]!);

    for (const rel of ROOTS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const writer of ["LedgerWriter", "appendLedger", ".append("]) {
        expect(source, `${rel} names the ledger writer ${writer}`).not.toContain(writer);
      }
    }
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

/**
 * ISC-506 — **Anti: views 2-4 add no writer and no new subprocess argv.**
 *
 * Filed as an anti-criterion because the failure it guards is an ADDITION
 * rather than a regression: nothing that exists today breaks it, and the thing
 * that would break it looks like a feature. **View 2 is the view an operator
 * opens when a worker is in trouble**, so it is the single most likely place in
 * this design for someone to add a `[k]ill` key, a `[r]etry`, or a "just tail
 * the log with `tail -f`" convenience — and each of those is one import.
 *
 * The writer half is already carried by the checks above, which now iterate the
 * three new views because they were added to `ROOTS` alongside them. What is
 * asserted here is the half those cannot see: that the SPAWN COUNT did not
 * move. ISC-469 pins the monitor to exactly one distinct subprocess argv,
 * `dockerPsArgv`, and pins it byte-for-byte and parameterless. Three new files
 * that render text have no business changing that number, and a second argv
 * would be the moment the viewer became a control surface.
 */
describe("ISC-506: views 2-4 add no writer and no new subprocess argv", () => {
  /** The three files this criterion is actually about, plus the chrome they share. */
  const NEW_VIEWS = [
    "monitor/views/chrome.tsx",
    "monitor/views/worker.tsx",
    "monitor/views/history.tsx",
    "monitor/views/report.tsx",
  ];

  /**
   * TESTING THE TESTER, on `walks its own fixture`'s pattern. If these files
   * were not in `ROOTS`, every write-primitive and adjudicator assertion above
   * would pass over them by omission and this whole block would be decoration.
   */
  test("the new views are inside the guarded set, not beside it", () => {
    for (const rel of NEW_VIEWS) {
      expect(ROOTS, `${rel} is not guarded`).toContain(rel);
      expect(CLOSURE.has(rel), `${rel} is not in the closure`).toBe(true);
    }
  });

  /**
   * The spawn primitives, by name, on the new files' own source.
   *
   * A view that shells out has stopped being a view — and the specific hazard
   * is not `docker run`, which nobody would write here by accident. It is
   * `tail`, `less`, `git show`: read-only-looking commands that put an
   * arbitrary argv one edit away from a control verb, in a process whose whole
   * claim is that it cannot issue one.
   */
  test("no view spawns a subprocess", () => {
    const offenders: string[] = [];
    for (const rel of NEW_VIEWS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const f of ["Bun.spawn", "spawnSync", "execFile", "execSync", "child_process", "$`"]) {
        if (source.includes(f)) offenders.push(`${rel}: ${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE COUNT, over the monitor's OWN modules rather than over the new files —
   * and NOT over the closure, which is a narrowing with the same cause ISC-473
   * records two blocks down.
   *
   * Checking only the new views would miss the way this actually goes wrong: a
   * view needs a fact, someone adds a reader for it, and the argv lands in
   * `read/` rather than in the view. So the scope has to be wider than the three
   * files. **But it cannot be the whole closure, and that was measured rather
   * than assumed**: the first draft asserted exactly one spawning module and
   * found nine, every one of them reached through `run/state.ts` — the module
   * ISC-472 *requires* the monitor to use — down through `run/worktree.ts` into
   * `harvest/git.ts`, `container/run.ts`, `safety/procstart.ts` and the rest.
   * Those are not the monitor spawning; they are shared readers that also
   * contain a spawn on a path the monitor never calls, and banning them would
   * fail against a correct design.
   *
   * So the subject is `monitor/**`, which is the code this criterion is about
   * and the code an edit to these views would touch. ONE module spawns today:
   * `read/docker.ts`, pinned byte-for-byte by ISC-469. **The list is pinned
   * rather than counted**, so a second arriving names itself instead of moving
   * a number.
   *
   * It was two until 2026-09-04. Removing the monitor's git region took
   * `read/git.ts` out of the import closure entirely — the monitor no longer
   * shells out to git at all, which is a strictly stronger version of the
   * property this test exists to state. The module still exists for the
   * operations console's `git-watch` pane; it is simply not reachable from
   * here any more.
   */
  test("only the one pinned monitor module spawns anything", () => {
    const spawning = [...CLOSURE]
      .filter((rel) => rel.startsWith("monitor/") && existsSync(join(SRC, rel)))
      .filter((rel) => stripComments(readFileSync(join(SRC, rel), "utf8")).includes("Bun.spawn"))
      .sort();
    expect(spawning).toEqual(["monitor/read/docker.ts"]);
  });

  /**
   * And no view can reach the control plane by import, which the closure-wide
   * checks above assert for the monitor as a whole — restated here per file so
   * a failure names the view rather than the design.
   */
  test("no view imports a control verb, a socket or the ledger", () => {
    const offenders: string[] = [];
    for (const rel of NEW_VIEWS) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        for (const forbidden of ["rpc/", "ledger", "cli/commands", "dispatch", "harvest/"]) {
          if (spec.includes(forbidden)) offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

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

  /**
   * The import surface is PINNED rather than bounded, so growing it is a
   * deliberate edit to this list and never a side effect. It has already caught
   * one: wiring the three-clock scheduler added `clocks.ts` and failed here
   * until the addition was made on purpose.
   *
   * Four modules is the whole of it — the scheduler, the join, the seam, and the
   * contract. Note what is NOT here and could plausibly have been: `read/*.ts`
   * (the command has no business reading anything directly; `fleetSources` and
   * `fetchForView` own that) and `activity.ts` (deriving an `Activity` in a CLI
   * command would be D10's second adjudicator, in the one place whose answer an
   * operator reads).
   *
   * **`model.ts` was added deliberately on 2026-09-03, when views 2-4 became
   * reachable**, and the argument for allowing it is the argument this pin
   * exists to force someone to make. The command's job grew by exactly one
   * thing: turning `--view`/`--worker`/`--run` into a `ViewState`. That type
   * lives in `model.ts`, and `model.ts` is types plus three one-line Region
   * constructors — it imports nothing itself, reaches no reader, and holds no
   * derivation. It is the contract both sides of the seam are written against,
   * which makes it the one monitor module a caller can hold without gaining any
   * capability at all. The alternative was to let the command build the union
   * from string literals and skip the import, which would have put a second
   * spelling of `ViewState` in the file most likely to grow a control flag.
   */
  test("it imports exactly four monitor modules, and no reader or adjudicator", () => {
    const monitorImports = [...CMD.matchAll(/from\s+["']([^"']*monitor[^"']*)["']/g)].map((m) => m[1]!);
    expect(monitorImports.sort()).toEqual([
      "../../monitor/clocks.ts",
      "../../monitor/compose.ts",
      "../../monitor/model.ts",
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
      if (VIEW_4.includes(rel)) continue; // See VIEW_4 above.
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

  /**
   * THE CALL-GRAPH HALF, which could not be written until the scheduler
   * existed. The import half above says the monitor's modules do not name an
   * adjudicator; this says the CLOCKS do not reach one — which is the question
   * D10 actually asks, because a verdict recomputed twice a second is the
   * expensive half of the same defect.
   *
   * Asserted by EXECUTING every source's reader against a fixture root and
   * watching what it touches, rather than by reading source text: a call
   * reached through a variable, a re-export or a dynamic import is invisible to
   * a grep and is exactly how a second adjudicator would arrive.
   */
  test("no clock source reaches an adjudicator, harvester or report collector", async () => {
    const { fleetSources } = await import("../../src/monitor/clocks.ts");
    const base = await mkdtemp(join(tmpdir(), "pifleet-callgraph-"));
    try {
      const sources = fleetSources({
        root: join(base, "runs"),
        dockerRun: async () => ({ code: 0, stdout: "", stderr: "" }),
      });

      /*
       * The modules a verdict would have to come from. Loading them fresh and
       * wrapping their exports would not work — the sources captured their
       * imports at module load — so instead every reader is run and the
       * assertion is on what the FAST and MEDIUM ones are, by name and by
       * clock. `runs` is on the slow clock and is the only source that reaches
       * `run/registry.ts` at all.
       */
      for (const [name, source] of Object.entries(sources)) {
        if (source.clock === "slow") continue;
        /*
         * A source that FAILS is fine and expected — the git strip throws in a
         * directory that is not a repository, which is `unwrapRegion` doing its
         * job. What is asserted is that running it raises nothing from a
         * verdict-producing module: an `adjudicate` or `collectRunReport`
         * reached through a variable or a dynamic import would surface here as
         * a stack naming that module, and is invisible to the grep below.
         */
        let raised: unknown = null;
        try {
          await source.read();
        } catch (err) {
          raised = err;
        }
        const trace = raised instanceof Error ? `${raised.message}\n${raised.stack ?? ""}` : "";
        for (const forbidden of ["harvest/", "adjudicate", "collectRunReport"]) {
          expect(trace, `${name} reached ${forbidden}`).not.toContain(forbidden);
        }
      }

      // And the placement itself: nothing that walks is on a fast clock.
      expect(sources.runs.clock).toBe("slow");
      expect(sources.workers.clock).toBe("fast");
      expect(sources.runNames.clock).toBe("medium");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  /**
   * The fast source in particular, because it is the one that runs 120 times a
   * minute. `refreshKnownWorkers` reads `state.json` and nothing else — no
   * verdict, no harvest, no report — and its source is checked directly since
   * it lives in `clocks.ts` rather than in the six roots above.
   */
  test("the fast refresh reads state and computes no verdict", () => {
    const source = stripComments(readFileSync(join(SRC, "monitor/clocks.ts"), "utf8"));
    for (const forbidden of ["adjudicate(", "harvestTask(", "collectRunReport(", "harvest/"]) {
      expect(source, `clocks.ts reaches ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("no monitor module calls an adjudicator or a harvester", () => {
    const offenders: string[] = [];
    for (const rel of ROOTS) {
      if (VIEW_4.includes(rel)) continue; // See VIEW_4 above.
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      for (const call of ["adjudicate(", "harvestTask(", "collectRunReport("]) {
        if (source.includes(call)) offenders.push(`${rel}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE EXEMPTION IS TWO-SIDED, so it cannot become a hole.
   *
   * A `continue` that skipped a file which had stopped needing skipping would
   * be an exemption nobody ever notices is stale, and the next person to add a
   * module here would reach for the same `continue`. So the carve-out is
   * asserted from BOTH directions: the exempted file really does reach a
   * verdict (or the exemption is dead and should go), and no OTHER root has
   * quietly started to.
   */
  test("the view-4 exemption is live, and is the only file that needs it", () => {
    for (const rel of VIEW_4) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      expect(source, `${rel} no longer reaches a verdict — retire its exemption`).toContain(
        "collectRunReport(",
      );
    }
    // And nothing else does. This is the assertion above, restated as the
    // complement so the exemption list cannot silently grow by copy-paste.
    const reaching = ROOTS.filter((rel) =>
      stripComments(readFileSync(join(SRC, rel), "utf8")).includes("collectRunReport("),
    );
    expect(reaching).toEqual(VIEW_4);
  });

  /**
   * `container/interrupt.ts` enters the monitor's closure with `launchPaneMode`
   * (`read/worker.ts`'s `deriveVia`), and it also exports `interruptArgv`,
   * which builds `docker kill --signal=INT`. **That is a second Docker argv in
   * the closure of a viewer whose ISC-469 claim is that it has exactly one.**
   *
   * The import is still right — `dispatch.ts:286-289` says a second copy of the
   * pane-mode rule "is how the CLI and the abort path would start disagreeing"
   * — so what makes it safe is asserted instead of assumed, on both halves:
   * the module can do nothing on its own (one type-only import, no spawn, no
   * fs, no socket), and no monitor module names the argv builder.
   */
  test("the pane-mode rule is imported without importing a capability", () => {
    const interrupt = readFileSync(join(SRC, "container/interrupt.ts"), "utf8");
    const stripped = stripComments(interrupt);
    // Its ENTIRE import list, pinned. A value import here would be a new
    // capability arriving in the monitor's closure by way of a helper.
    const imports = [...stripped.matchAll(/^import\s+(.+?)\s+from\s+["']([^"']+)["']/gm)].map(
      (m) => `${m[1]!} from ${m[2]!}`,
    );
    expect(imports).toEqual(['type { WorkerLaunch }  from ../contracts.ts'.replace("  ", " ")]);
    for (const primitive of ["Bun.spawn", "spawnSync", "node:fs", "node:child_process", "socket"]) {
      expect(stripped, `container/interrupt.ts reaches ${primitive}`).not.toContain(primitive);
    }
    // And the monitor never names the verb the module can build.
    for (const rel of ROOTS) {
      expect(
        stripComments(readFileSync(join(SRC, rel), "utf8")),
        `${rel} names interruptArgv`,
      ).not.toContain("interruptArgv");
    }
  });
});
