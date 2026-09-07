/**
 * The triage console cannot command the fleet, and the proof is STRUCTURAL —
 * §6.10, D7a, and §12's *"Read-only, as a layering guard rather than a promise"*.
 *
 * ## Why an import walk and not "assert it did not dispatch during this run"
 *
 * `test/unit/monitor-readonly.test.ts`'s argument, which applies here with more
 * force. A behavioural test passes for a console that commands on a code path the
 * test did not reach, and **this console runs unattended, 288 times a day, for as
 * long as a token ceiling lasts** (§6.10). Its error branches are the ones nobody
 * watches. An import walk cannot be satisfied by luck: if nothing the console's own
 * modules name can open a control socket, write the fleet ledger, or call a
 * mutating verb, then no sweep can make it happen.
 *
 * ## THE TWO LESSONS INHERITED FROM `monitor-readonly.test.ts` RATHER THAN
 * ## REDISCOVERED, because §12 says to inherit them
 *
 * **1. The ban is scoped to the console's own subtree, never to the closure.**
 * That file's first draft banned spawning across the whole transitive closure and
 * found nine offenders, every one reached through `run/state.ts → run/worktree.ts`
 * — shared readers that happen to contain a spawn on a path the monitor never
 * calls. Here the same mistake is not nine offenders but a hundred and forty-five:
 * **the console's one legitimate outward edge, its dispatch path
 * (`run/dispatch-request.ts`), has a transitive closure of 145 modules that
 * contains `rpc/client.ts`, `run/ledger.ts`, all of `harvest/` and every
 * `cli/commands/*.ts` in the fleet.** Measured, not assumed — `closure` below is
 * asserted to be that large, so a reader can see why the scoping is forced rather
 * than chosen. A closure-wide ban would therefore either fail against a correct
 * design or need an exemption list longer than the thing it guards, and an
 * exemption list that long asserts nothing.
 *
 * **2. The one permitted exception is NAMED, not counted.** That file's
 * `:363-369` asserts `["monitor/read/docker.ts"]` exactly, so a second spawning
 * module names itself instead of moving a number. {@link DISPATCH_PATH} is this
 * file's equivalent and it has ONE member.
 *
 * ## The ruling this file is the tripwire for
 *
 * §12 uses *"ledger"* in two senses — the console-and-actor block asks the
 * abandonment to *"ledger the reason"*, and the read-only block bans a *"ledger
 * writer"*. **Ruled 2026-09-06: the abandonment reason goes to §7.7's own
 * append-only log (§9.15 surface 2) and NOT to the fleet ledger**, because
 * `cli/commands/relay.ts`'s `ledger.append("relay_console_gone", …)` is the review
 * console's answer and is exactly the reachability this block forbids. So
 * {@link DISPATCH_PATH} stays at ONE entry, and **a second entry is the tell that
 * the ruling was quietly reversed** — a `triage-actor.ts` that wrote the fleet
 * ledger would have to import `run/ledger.ts`, which `the console's modules import
 * no control-plane module` fails on and which no amount of renaming hides.
 *
 * ## What is NOT banned here, and why tightening it would be wrong
 *
 * **Write primitives.** The monitor is a viewer and may write nothing; this
 * console is not. It writes incident records (§7.6), its own actor record, lock
 * and append-only log (§7.7), and the collated document (§7.5). `writeJsonAtomic`
 * and `writeTextAtomic` are therefore correct in this subtree and are deliberately
 * absent from every list below. §12's sentence is precise about which three things
 * are forbidden — *"no mutating verb, control-socket client or ledger writer"* —
 * and widening it to "no write" would fail against the design the SRD asks for.
 *
 * **`abort` as a substring.** `monitor-readonly.test.ts:489-502` bans it in the
 * monitor's command, and copying that here would be a false positive rather than a
 * guard: the only `abort` in this subtree is `AbortSignal` — `triage-notify.ts`'s
 * delivery timeout and `triage-actor.ts`'s cancellation check — which is a
 * standard-library cancellation primitive and not the fleet's `abort` verb. The
 * verbs below are banned by MODULE and by the exported names a caller would need,
 * which have no such collision.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = new URL("../../src/", import.meta.url).pathname;

/**
 * The console's entry points. Everything reachable from these is in the closure,
 * and everything under {@link isConsoleModule} is in the guarded subtree.
 *
 * **`cli/commands/triage.ts` is a ROOT even though `monitor-readonly.test.ts`
 * refuses to make its own command one.** That file's reason (`:436-449`) is that a
 * `cli/commands/` file placed in its own closure fails the *"no dispatching CLI
 * command is reachable"* assertion by construction — a real problem for a guard
 * whose bans are closure-wide. This file's bans are subtree-scoped, so the
 * construction does not arise, and the command gets the per-file source checks
 * every other console module gets. **Omitting it would leave a hole in exactly the
 * layer §3.3 says the coverage gate keeps catching**: the wiring file, which is
 * where a `--dispatch` or a `--steer` flag would be one line away.
 */
const ROOTS = [
  "run/triage-pass.ts",
  "run/triage-actor.ts",
  "run/triage-verdict.ts",
  "run/triage-incident.ts",
  "run/triage-notify.ts",
  "run/triage-document.ts",
  "run/triage-partition.ts",
  "cli/commands/triage.ts",
];

/**
 * **THE ONE PERMITTED EXCEPTION: the console's dispatch path.**
 *
 * §12: *"The triage actor's permitted exception is its dispatch path, and naming
 * it is what makes a second one fail."* `run/dispatch-request.ts` is the request
 * plane §6.5 fans a sweep out through — the console cannot do its job without it,
 * and it is the only module outside this subtree that a console module may hold
 * despite carrying the control plane in its own closure.
 *
 * **Named as one module rather than loosened into a predicate**, on
 * `monitor-readonly.test.ts:93-113`'s rule: a test that skipped "anything that
 * looks like a dispatcher" would exempt the next one too. This list is the set of
 * control-plane modules the console may reach, it has one member, and adding a
 * second is an edit somebody has to justify here — which is precisely what the
 * ledger ruling above says must never happen quietly.
 */
const DISPATCH_PATH = ["run/dispatch-request.ts"];

/**
 * The console's own subtree — the code this criterion is about.
 *
 * A prefix rather than a directory, because the console is a family of modules
 * inside `src/run/` plus its one command. `triage-config.ts` and
 * `triage-targets.ts` are in the subtree without being in {@link ROOTS}: they are
 * reached from the roots, and the subtree is deliberately WIDER than the root set
 * so a console module cannot be guarded and unguarded at the same time.
 */
const isConsoleModule = (rel: string): boolean =>
  rel.startsWith("run/triage-") || rel === "cli/commands/triage.ts";

/**
 * Every module reachable from `entry` by static relative import, as repo-relative
 * paths under `src/`. `monitor-readonly.test.ts:125-144`'s walk, unchanged —
 * relative specifiers only, because a bare specifier is a package and a package
 * reaches this repository's control plane only through code in this repository.
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
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      queue.push(relative(SRC, resolve(dirname(abs), m[1]!)));
    }
  }
  return seen;
}

/** Comment-stripping local to this file, so a docblock naming a verb does not fail it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The direct outward import edges of one module, as repo-relative paths. */
function directImports(rel: string): string[] {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) return [];
  return [
    ...new Set(
      [...readFileSync(abs, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((m) =>
        relative(SRC, resolve(dirname(abs), m[1]!)),
      ),
    ),
  ];
}

const CLOSURE = (() => {
  const all = new Set<string>();
  for (const r of ROOTS) for (const m of transitiveImports(r)) all.add(m);
  return all;
})();

/** The guarded set: every console module the walk actually found. */
const SUBTREE = [...CLOSURE].filter(isConsoleModule).sort();

const sourceOf = (rel: string): string => stripComments(readFileSync(join(SRC, rel), "utf8"));

describe("D7a: the triage console's own modules cannot command the fleet", () => {
  /**
   * **THE MISSING-ROOT CHECK, and it fails LOUDLY rather than skipping.**
   *
   * {@link transitiveImports} steps over a path that does not exist, which is
   * right for a walk and catastrophic for a guard: a root that was renamed, moved
   * or not yet written would silently contribute nothing, every ban below would
   * pass over it by omission, and the file would go green while guarding less than
   * it claims. **A closure guard that silently ignores an absent root is the exact
   * failure mode this file exists against**, so the roots are asserted to exist
   * before anything is concluded from walking them.
   *
   * `cli/commands/triage.ts` is the live case: it is written by a different task
   * in the same round as this file, and if it is absent this test names it.
   */
  test("every root exists — an absent root is a hole, not a skip", () => {
    const missing = ROOTS.filter((rel) => !existsSync(join(SRC, rel)));
    expect(missing, `ROOTS names files that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * TESTING THE TESTER, on `monitor-readonly.test.ts:159-165`'s pattern. A walk
   * that resolved nothing would pass every assertion below by vacuity, which is
   * the failure mode a new mechanism has.
   *
   * The three named modules are reached by different route lengths on purpose:
   * `run/triage-config.ts` is one hop from a root and is NOT itself a root,
   * `run/dispatch-request.ts` is one hop from `triage-partition.ts`, and
   * `rpc/client.ts` is several hops beyond that — so a walk that had quietly
   * stopped recursing would still show the first and lose the third.
   */
  test("walks its own fixture — the closure is real, not empty", () => {
    expect(CLOSURE.size).toBeGreaterThan(20);
    expect(CLOSURE.has("run/triage-config.ts")).toBe(true);
    expect(CLOSURE.has("run/dispatch-request.ts")).toBe(true);
    expect(CLOSURE.has("rpc/client.ts")).toBe(true);
    // And the subtree is the whole console, not a fragment of it.
    expect(SUBTREE).toEqual([
      "cli/commands/triage.ts",
      "run/triage-actor.ts",
      "run/triage-config.ts",
      "run/triage-document.ts",
      "run/triage-envelope.ts",
      "run/triage-incident.ts",
      "run/triage-notify.ts",
      "run/triage-partition.ts",
      "run/triage-pass.ts",
      "run/triage-targets.ts",
      "run/triage-verdict.ts",
    ]);
  });

  /**
   * **THE MEASUREMENT THAT FORCES THE SCOPING**, stated as an assertion so a
   * future reader cannot mistake the subtree scope for laziness.
   *
   * `monitor-readonly.test.ts:333-361` records that its first draft asserted one
   * spawning module across the closure and found nine. The same draft here would
   * find far more, and for a reason that is not a defect: the console's dispatch
   * path IS the fleet's request plane, and the request plane reaches everything.
   * If this number ever collapses, the closure-wide ban becomes possible and this
   * file should be tightened — which is why the fact is pinned rather than
   * described.
   */
  test("the closure is contaminated by the dispatch path, which is why bans are subtree-scoped", () => {
    const viaDispatch = transitiveImports(DISPATCH_PATH[0]!);
    expect(viaDispatch.size).toBeGreaterThan(100);
    for (const capability of ["rpc/client.ts", "run/ledger.ts", "cli/commands/abort.ts"]) {
      expect(viaDispatch.has(capability), `${capability} is NOT reached via the dispatch path`).toBe(
        true,
      );
    }
    // So a closure-wide ban would have to exempt more than it guards.
    const closureOffenders = [...CLOSURE]
      .filter((m) => !isConsoleModule(m) && existsSync(join(SRC, m)))
      .filter((m) => sourceOf(m).includes("Bun.spawn"));
    expect(closureOffenders.length).toBeGreaterThan(5);
  });

  /**
   * **THE CONTROL PLANE, by module, on the console's own DIRECT import edges.**
   *
   * Direct edges rather than the closure, for the reason measured above; and by
   * MODULE rather than by symbol, because a module is what a capability arrives
   * in and an import is the one thing a reader can check without running anything.
   *
   * `run/ledger.ts` is the entry this file exists for. The 2026-09-06 ruling says
   * the actor's abandonment reason goes to §7.7's own append-only log and not to
   * the fleet ledger; an implementation that reversed that would import
   * `run/ledger.ts` from `triage-actor.ts` and fail HERE, naming the file.
   */
  test("the console's modules import no control-plane module", () => {
    const FORBIDDEN = [
      "rpc/client.ts",
      "run/ledger.ts",
      "run/relay.ts",
      "run/worktree.ts",
      "container/run.ts",
      "container/interrupt.ts",
      "harvest/index.ts",
      "harvest/adjudicate.ts",
      "cli/commands/abort.ts",
      "cli/commands/steer.ts",
      "cli/commands/unstage.ts",
      "cli/commands/dispatch.ts",
      "cli/commands/up.ts",
      "cli/commands/down.ts",
    ];
    const offenders: string[] = [];
    for (const rel of SUBTREE) {
      for (const spec of directImports(rel)) {
        if (FORBIDDEN.includes(spec)) offenders.push(`${rel} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **THE MUTATING VERBS AND THE CONTROL SOCKET, by NAME, on the subtree's own
   * source.** The import check above cannot see a verb reached through a module
   * the console legitimately holds — `cli/commands/triage.ts` imports
   * `run/state.ts` for its readers, and `run/state.ts` also exports
   * `writeWorkerState` — which is `monitor-readonly.test.ts:236-266`'s recorded
   * situation exactly. So the names a caller would have to write are banned
   * directly.
   *
   * **`writeJsonAtomic` and `writeTextAtomic` are deliberately NOT here.** This
   * console writes its own records by design (§7.5-§7.7); see the header.
   */
  test("the console's modules name no mutating verb, socket or ledger writer", () => {
    const FORBIDDEN = [
      // The ledger writer — the ruling's tripwire, in all three spellings.
      "LedgerWriter",
      "appendLedger",
      "ledger.append",
      // The control socket.
      "RpcClient",
      // Fleet state a console has no business writing.
      "writeWorkerState",
      "writePresentation",
      "writeFence",
      "recordInjection",
      // Verdict and harvest — the console reads what an observer produced.
      "harvestTask(",
      "adjudicate(",
      "collectRunReport(",
      // Subprocesses. The console has no shell (§6.1) and needs none here.
      "Bun.spawn",
      "spawnSync",
      "execSync",
      "execFileSync",
      "child_process",
    ];
    const offenders: string[] = [];
    for (const rel of SUBTREE) {
      const source = sourceOf(rel);
      for (const verb of FORBIDDEN) if (source.includes(verb)) offenders.push(`${rel}: ${verb}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **THE EXCEPTION IS TWO-SIDED, so it cannot become a hole** —
   * `monitor-readonly.test.ts:644-667`'s rule. A one-element allowlist nobody
   * checks is an allowlist that stays after the thing it excused is gone, and the
   * next person to need an exemption reaches for the same entry.
   *
   * So: the dispatch path is really reached (or the exception is dead and should
   * be retired), and the modules that reach the fleet's control socket are EXACTLY
   * the modules that reach the dispatch path — no second road. That equality is
   * the whole structural claim of this file: **`rpc/client.ts` is reachable from
   * this console through its dispatch path and through nothing else**, so the
   * console's other six modules could not open a control socket if they tried.
   */
  test("the dispatch exception is live, and is the only road to the control plane", () => {
    const reachesDispatch = SUBTREE.filter((rel) =>
      DISPATCH_PATH.some((d) => transitiveImports(rel).has(d)),
    );
    const reachesSocket = SUBTREE.filter((rel) => transitiveImports(rel).has("rpc/client.ts"));

    // The exception is LIVE: something really does need it.
    expect(reachesDispatch.length).toBeGreaterThan(0);
    // And it is the ONLY road. A second route would show up as a module here
    // that is not there.
    expect(reachesSocket).toEqual(reachesDispatch);

    // PREMISE: the split is real rather than "everything reaches everything" —
    // a subtree in which every module reached the socket would satisfy the
    // equality above and assert nothing.
    const clean = SUBTREE.filter((rel) => !reachesSocket.includes(rel));
    expect(clean.length).toBeGreaterThan(0);
    expect(clean).toContain("run/triage-actor.ts");
    expect(clean).toContain("run/triage-incident.ts");
    expect(clean).toContain("run/triage-notify.ts");
  });

  /**
   * The allowlist's SIZE, asserted separately from its contents so the ruling has
   * a probe of its own.
   *
   * §12: *"task 6.6's permitted-exception list stays at ONE entry (the dispatch
   * path), and a second entry would be the tell that this ruling was quietly
   * reversed."* This is that tell, made executable. It is not redundant with the
   * checks above: someone reversing the ledger ruling would fix the import ban by
   * adding `run/ledger.ts` to `DISPATCH_PATH`, and this is the assertion that
   * refuses to let that be a one-line edit nobody reviews.
   */
  test("the permitted-exception list has exactly ONE entry — the 2026-09-06 ruling", () => {
    expect(DISPATCH_PATH).toEqual(["run/dispatch-request.ts"]);
  });

  /**
   * The actor's abandonment surface, positively. The ruling has a negative half
   * (no fleet ledger, asserted above) and a positive one: the reason goes to
   * §7.7's own append-only log, which is §9.15 surface 2 — *"the only surface that
   * is guaranteed to work"*. Asserted so the negative cannot be satisfied by an
   * actor that records the reason NOWHERE.
   */
  test("the actor still has an append-only log to put the reason in", () => {
    const actor = sourceOf("run/triage-actor.ts");
    expect(actor).toContain("appendFile");
  });
});
