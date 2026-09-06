/**
 * `pifleet relay --console <name>` — SRD-TRIAGE-CONSOLE §13 task 2.2.
 *
 * **What this file has to prove, and why the obvious tests would not prove it.**
 *
 * A `--console` flag is trivially addable and trivially inert. The failure mode
 * this suite exists to catch is a flag that parses, defaults to `review`, and
 * changes nothing an operator could observe — which is the console-shaped
 * version of §6.4's own complaint that *"a collator that dispatched three
 * reviews is indistinguishable from one that dispatched none"*. Two kinds of
 * test are worthless against it:
 *
 * - **Comparing the two constants.** `TRIAGE_CONSOLE_ROSTER !== REVIEW_CONSOLE_ROSTER`
 *   was true before this task started. Round 3 landed both values and nothing
 *   selected them; a suite that asserts they differ would have been green on the
 *   commit that this task exists because of.
 * - **Asserting the option is registered.** Commander accepting `--console` says
 *   nothing about whether the value reaches a roster, an aspect table, the run
 *   lookup, or the watch.
 *
 * So every selection case here is driven through a REAL path — commander parsing
 * argv into the registered action, `readDispatchRequest` parsing a file a
 * container really wrote, `relayPass` walking a real run tree, and
 * `consoleRunResolution` doing the real worker→run scan — and each asserts that
 * the SAME input produces a DIFFERENT answer under the two consoles.
 *
 * ## The four seams `--console` has to reach, all of them here
 *
 * A console is a roster plus an aspect table (D5), and the value is consumed at
 * four places that fail independently:
 *
 * | Seam | Wrong-console symptom | Case |
 * |---|---|---|
 * | `resolveCollatorRun(spec.roster)` | polls a run that cannot hold a request | §2 |
 * | `relayPass({roster})` | reads the wrong workers' outboxes | §4 |
 * | `consoleRunResolution(_, _, aspects)` | resolves runs for seats it does not have | §5 |
 * | `ConsoleWatch`'s collator | reaps itself when the OTHER console comes down | §6 |
 *
 * Threading three of the four and missing one produces a console that half
 * works, and the halves fail at different times — which is why they are pinned
 * one per seam rather than as one end-to-end case.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../../src/cli/index.ts";
import { EXIT } from "../../src/contracts.ts";
import {
  CONSOLES,
  DEFAULT_CONSOLE,
  register,
  relayPass,
  resolveConsole,
  type RelayFanOut,
  type RelayFanOutInput,
  type RelayFanOutResult,
} from "../../src/cli/commands/relay.ts";
import {
  consoleFanOut,
  consoleRunResolution,
  type ConsoleRunSources,
} from "../../src/run/relay.ts";
import {
  COLLATION_ASPECT,
  REVIEW_CONSOLE_ASPECTS,
  TRIAGE_CONSOLE_ASPECTS,
} from "../../src/run/task-ids.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  parseDispatchRequest,
  readDispatchRequest,
} from "../../src/run/dispatch-request.ts";
import {
  inboxTaskPath,
  runPaths,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "../../src/run/paths.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-console-"));
  cleanups.push(dir);
  return dir;
}

/**
 * A runs root holding ONE run that has materialised exactly `workers`.
 *
 * `run.json` is what `runIdsAscending` stats to decide a directory is a run, so
 * a fixture without it produces an empty candidate list and every case below
 * would pass for the wrong reason — the console refusing because it found no
 * runs at all rather than because it found no run holding ITS collator.
 */
async function runsRootWith(
  workers: readonly string[],
  runId = "r-console",
): Promise<{ root: string; run: RunPaths }> {
  const root = await scratch();
  const run = runPaths(runId, root);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ run_id: runId }));
  for (const w of workers) await mkdir(workerPaths(run, w).dir, { recursive: true });
  return { root, run };
}

/** An inbox record, exactly as `dispatch` writes one: the HOST's claim about who owns a task. */
async function plantInbox(run: RunPaths, taskId: string, worker: string): Promise<void> {
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(inboxTaskPath(run, taskId), JSON.stringify({ task_id: taskId, worker }));
}

/**
 * A request in a worker's outbox, where a container would write it.
 *
 * **The share follows the SENDER's console, because SRD-TRIAGE-CONSOLE §7.3
 * makes `services` required on triage and refused on review.** A fixture
 * carrying it unconditionally is refused `services_not_permitted` on the review
 * arm and one omitting it is refused `services_missing` on the triage arm, so a
 * single shape cannot serve both — and a fixture the real parser refuses proves
 * nothing about the roster selection these tests exist to grade.
 */
async function plantRequest(
  run: RunPaths,
  sender: string,
  taskId: string,
  targets: readonly string[],
): Promise<void> {
  const needsShare = CONSOLES.some(
    (spec) => spec.roster.collators.includes(sender) && spec.roster.services === "required",
  );
  const dir = join(workerOutboxDir(run.root, sender), taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "dispatch-request.json"),
    JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: taskId,
      requests: targets.map((worker, i) => ({
        worker,
        title: `sweep ${worker}`,
        brief: `observe the services assigned to ${worker}`,
        ...(needsShare ? { services: [`svc-${i + 1}`] } : {}),
      })),
    }),
  );
}

/** Counts its calls, because "did the fan-out happen at all" is half of every case here. */
function spyFanOut(): RelayFanOut & { calls: number } {
  const fn = Object.assign(
    async (): Promise<RelayFanOutResult> => {
      fn.calls += 1;
      return { kind: "dispatched", children: ["T-sweep-7-slice1"] };
    },
    { calls: 0 },
  );
  return fn;
}

/**
 * Run the registered `relay` command over an argv, returning whatever it threw.
 *
 * A fresh `Command` per call — commander accumulates option state on the command
 * object, and a shared program would let one case's `--console` leak into the
 * next case's "no `--console`" assertion, which is precisely the assertion §3
 * depends on. `exitOverride` keeps commander from calling `process.exit` and
 * taking the runner with it.
 */
async function runRelay(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register(program);
  try {
    await program.parseAsync(["relay", ...args], { from: "user" });
  } catch (err) {
    return err;
  }
  return null;
}

/** `runRelay`, asserting it refused, and handing back the `CliError` for inspection. */
async function relayRefusal(args: string[]): Promise<CliError> {
  const err = await runRelay(args);
  expect(err, `relay ${args.join(" ")} was expected to refuse, but returned`).toBeInstanceOf(
    CliError,
  );
  return err as CliError;
}

/** Collect stdout for the cases where SUCCEEDING quietly is the thing to prove. */
function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const stream = process.stdout as unknown as { write: (c: unknown) => boolean };
  stream.write = (c: unknown): boolean => {
    chunks.push(String(c));
    return true;
  };
  return {
    chunks,
    restore: () => {
      stream.write = original as unknown as (c: unknown) => boolean;
    },
  };
}

const SAVED_RUNS_DIR = process.env["PIFLEET_RUNS_DIR"];
beforeEach(() => {
  delete process.env["PIFLEET_RUNS_DIR"];
});
afterEach(() => {
  if (SAVED_RUNS_DIR === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = SAVED_RUNS_DIR;
});

// ---------------------------------------------------------------------------
// 1. An unknown console is refused BY NAME, never defaulted.
// ---------------------------------------------------------------------------

describe("an unrecognised --console is refused", () => {
  /**
   * THE HEADLINE REFUSAL, and the defect it forecloses is silent.
   *
   * `CONSOLES.find(...) ?? CONSOLES[0]` is the spelling that reads as harmless
   * and is not: an operator who types `--console triage-console` gets a process
   * that starts cleanly, logs like a healthy actor, and runs the triage cadence
   * against the REVIEW roster — polling `col-1`, refusing every observer, and
   * dispatching nothing, 288 times a day, with no observable separating it from
   * a working triage console.
   */
  test("the typo is quoted back and the legal names are listed", async () => {
    process.env["PIFLEET_RUNS_DIR"] = (await runsRootWith(["col-1", "tri-1"])).root;
    const err = await relayRefusal(["--console", "triage-console", "--once"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("triage-console");
    for (const c of CONSOLES) expect(err.message).toContain(c.name);
  });

  /**
   * The empty string is the one a shell hands over by accident (`--console
   * "$CONSOLE"` with `CONSOLE` unset), and `?? DEFAULT` would not catch it
   * either: `""` is not nullish, so a nullish-coalescing fallback passes it
   * straight through to a `find` that returns `undefined`.
   */
  test("an empty --console is refused rather than treated as absent", async () => {
    process.env["PIFLEET_RUNS_DIR"] = (await runsRootWith(["col-1"])).root;
    const err = await relayRefusal(["--console", "", "--once"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  /**
   * ORDER, which is a real property rather than tidiness.
   *
   * The console is resolved before the run lookup, so a bad name never produces
   * a run-shaped complaint first. Asserted by its ABSENCE: a refusal that named
   * `col-1` would mean the actor scanned the runs root for a roster the operator
   * never asked for and reported the wrong sentence in front of the right one.
   */
  test("it refuses on the console before it looks for a run", async () => {
    // A runs root with nothing in it at all: `resolveCollatorRun` would throw
    // here, so reaching the console refusal proves nothing looked yet.
    process.env["PIFLEET_RUNS_DIR"] = await scratch();
    const err = await relayRefusal(["--console", "nope", "--once"]);
    expect(err.message).toContain("nope");
    expect(err.message).not.toContain("col-1");
  });
});

// ---------------------------------------------------------------------------
// 2. SEAM ONE — the run lookup. The same runs root, two consoles, opposite answers.
// ---------------------------------------------------------------------------

describe("--console selects which run the actor polls", () => {
  /**
   * **THE CASE THIS FILE EXISTS FOR.** One fixture, two flag values, opposite
   * outcomes, all of it through commander into the registered action.
   *
   * A runs root holding only `tri-1` is a triage console with no review console
   * on the host. `--console triage` must find it; `--console review` must refuse
   * and say which collator it looked for. A `--console` that reached the flag
   * parser and no further passes neither half.
   */
  test("a runs root holding only tri-1 serves triage and refuses review", async () => {
    const { root } = await runsRootWith(["tri-1"]);
    process.env["PIFLEET_RUNS_DIR"] = root;

    const out = captureStdout();
    let triage: unknown;
    try {
      triage = await runRelay(["--console", "triage", "--once"]);
    } finally {
      out.restore();
    }
    expect(triage).toBeNull();
    expect(out.chunks.join("")).toContain("no dispatch requests");

    const err = await relayRefusal(["--console", "review", "--once"]);
    expect(err.message).toContain("col-1");
    expect(err.message).not.toContain("tri-1");
  });

  /**
   * The mirror, because a one-way test is satisfied by a flag that always
   * selects triage — which is the same defect as always selecting review, and a
   * suite that only ever pointed the other way would not see it.
   */
  test("a runs root holding only col-1 serves review and refuses triage", async () => {
    const { root } = await runsRootWith(["col-1"]);
    process.env["PIFLEET_RUNS_DIR"] = root;

    const out = captureStdout();
    let review: unknown;
    try {
      review = await runRelay(["--console", "review", "--once"]);
    } finally {
      out.restore();
    }
    expect(review).toBeNull();

    const err = await relayRefusal(["--console", "triage", "--once"]);
    expect(err.message).toContain("tri-1");
    expect(err.message).not.toContain("col-1");
  });
});

// ---------------------------------------------------------------------------
// 3. The default, asserted as a DEFAULT rather than as the only behaviour.
// ---------------------------------------------------------------------------

describe("the default console", () => {
  test("no --console is the review console", () => {
    expect(resolveConsole(undefined).name).toBe(DEFAULT_CONSOLE);
    expect(DEFAULT_CONSOLE).toBe("review");
  });

  /**
   * Proven through the command rather than through `resolveConsole`, because the
   * failure worth catching is an action that resolves the spec and then reads a
   * hard-coded `REVIEW_CONSOLE_ROSTER` anyway — which `resolveConsole` alone
   * cannot see.
   */
  test("a bare pass looks for the review collator, not whatever run exists", async () => {
    process.env["PIFLEET_RUNS_DIR"] = (await runsRootWith(["tri-1"])).root;
    const err = await relayRefusal(["--once"]);
    expect(err.message).toContain("col-1");
  });
});

// ---------------------------------------------------------------------------
// 4. SEAM TWO — the roster. One file on disk, `ok` under one console, refused
//    under the other, through the real reader.
// ---------------------------------------------------------------------------

describe("the selected roster decides whether a request is acceptable", () => {
  /**
   * **ONE FILE, TWO ROSTERS, TWO VERDICTS — and the rosters come from
   * `resolveConsole`, which is the CLI's own selector, not from the constants.**
   *
   * This is the assertion that a comparison of two constants cannot make: the
   * bytes on disk are identical, the reader is the production one, and the only
   * thing that varies is what `--console` resolved to.
   */
  test("tri-1's sweep request is ok under triage and refused under review", async () => {
    const { run } = await runsRootWith(["tri-1"]);
    const taskId = "T-sweep-7";
    await plantRequest(run, "tri-1", taskId, ["obs-t1", "obs-t2", "obs-t3"]);

    const asTriage = await readDispatchRequest({
      runRoot: run.root,
      sender: "tri-1",
      taskId,
      roster: resolveConsole("triage").roster,
    });
    expect(asTriage.kind).toBe("ok");

    const asReview = await readDispatchRequest({
      runRoot: run.root,
      sender: "tri-1",
      taskId,
      roster: resolveConsole("review").roster,
    });
    expect(asReview.kind).toBe("refused");
    if (asReview.kind !== "refused") throw new Error("unreachable");
    expect(asReview.code).toBe("sender_not_collator");
    // The refusal names the SELECTED console's collators, so the sentence an
    // operator reads is about the console they asked for.
    expect(asReview.reason).toContain("col-1");
  });

  /** And the same statement pointing the other way, for the review console's own request. */
  test("col-1's review request is ok under review and refused under triage", async () => {
    const { run } = await runsRootWith(["col-1"]);
    const taskId = "T-review-4";
    await plantRequest(run, "col-1", taskId, ["rev-arch-1"]);

    expect(
      (
        await readDispatchRequest({
          runRoot: run.root,
          sender: "col-1",
          taskId,
          roster: resolveConsole("review").roster,
        })
      ).kind,
    ).toBe("ok");

    const asTriage = await readDispatchRequest({
      runRoot: run.root,
      sender: "col-1",
      taskId,
      roster: resolveConsole("triage").roster,
    });
    expect(asTriage.kind).toBe("refused");
    if (asTriage.kind !== "refused") throw new Error("unreachable");
    expect(asTriage.reason).toContain("tri-1");
  });

  /**
   * THE PASS, not just the reader — the seam where the roster decides which
   * outboxes are opened at all.
   *
   * One run tree carrying two tasks: a legal sweep request from `tri-1`, and an
   * illegal one from `obs-t1`. Under triage, the first is dispatched and the
   * second is REFUSED; under review, the tree is invisible and the fan-out is
   * never called. The `calls` counter is the assertion that matters — an
   * implementation that dispatched and then reported the right kind would
   * satisfy a kind check alone.
   *
   * ## This is also the case that pins the comment at `relayPass`'s `onConsole`
   *
   * That comment used to say `sender_not_collator` was unreachable from this
   * pass. It is unreachable on the REVIEW console for a structural reason — D4
   * makes it four runs and the pass reads the collator's — and it is LIVE on the
   * triage console, because D3 puts all four seats in one `rpc` run, so the
   * observers share the collator's inbox. The widening the comment defended is
   * what makes that refusal free, and this asserts the payoff rather than the
   * prose.
   */
  test("under triage the pass dispatches tri-1 and refuses obs-t1; under review it sees neither", async () => {
    const { run } = await runsRootWith(["tri-1", "obs-t1"]);
    await plantInbox(run, "T-sweep-7", "tri-1");
    await plantRequest(run, "tri-1", "T-sweep-7", ["obs-t1", "obs-t2", "obs-t3"]);
    await plantInbox(run, "T-sweep-7-slice1", "obs-t1");
    await plantRequest(run, "obs-t1", "T-sweep-7-slice1", ["obs-t2"]);

    const triageFanOut = spyFanOut();
    const triage = await relayPass({
      run,
      fanOut: triageFanOut,
      roster: resolveConsole("triage").roster,
    });
    expect(triageFanOut.calls).toBe(1);

    const dispatched = triage.outcomes.find((o) => o.worker === "tri-1");
    expect(dispatched?.kind).toBe("dispatched");

    const refused = triage.outcomes.find((o) => o.worker === "obs-t1");
    expect(refused?.kind).toBe("refused");
    // The refusal is about the TRIAGE console: it names tri-1 as the collator.
    expect(refused?.reason).toContain("tri-1");

    const reviewFanOut = spyFanOut();
    const review = await relayPass({
      run,
      fanOut: reviewFanOut,
      roster: resolveConsole("review").roster,
    });
    expect(reviewFanOut.calls).toBe(0);
    expect(review.outcomes).toEqual([]);
    // The denominator is identical, so "saw nothing" is a decision about the
    // roster rather than a tree the second pass failed to read.
    expect(review.tasks_seen).toBe(triage.tasks_seen);
  });
});

// ---------------------------------------------------------------------------
// 5. SEAM THREE — the worker→run scan. THE scoping problem task 2.2 names.
// ---------------------------------------------------------------------------

describe("the selected aspect table decides which runs are looked for", () => {
  /** Records every worker the resolution probes for liveness. */
  function probingSources(probed: string[]): ConsoleRunSources {
    return {
      runsRoot: () => "/nonexistent-runs-root",
      listRunIds: async () => [],
      runPathsFor: (runId, root) => runPaths(runId, root),
      isLiveWorker: async (_run, worker) => {
        probed.push(worker);
        return false;
      },
      pinnedRuns: () => undefined,
    };
  }

  /**
   * A real accepted request for `console`'s own collator, built by the real
   * parser.
   *
   * The roster is the one being exercised rather than a fixed one: a request
   * from `col-1` is refused under the triage roster, so a shared fixture would
   * fail to build for the review arm — and a cast past the parser would produce
   * a shape nothing in production emits.
   *
   * The `services` share follows the same rule, and for the same reason:
   * SRD-TRIAGE-CONSOLE §7.3 requires it on triage and refuses it on review, so
   * the fixture reads the roster rather than picking one shape and casting.
   */
  function inputFor(consoleName: string, targets: readonly string[]): RelayFanOutInput {
    const spec = resolveConsole(consoleName);
    const sender = spec.roster.collators[0]!;
    const taskId = "T-sweep-7";
    const read = parseDispatchRequest(
      JSON.stringify({
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: taskId,
        requests: targets.map((worker, i) => ({
          worker,
          title: "t",
          brief: "b",
          ...(spec.roster.services === "required" ? { services: [`svc-${i + 1}`] } : {}),
        })),
      }),
      { sender, taskId, roster: spec.roster },
    );
    if (read.kind !== "ok") throw new Error(`fixture request was ${read.kind}`);
    return {
      run: runPaths("r-console", "/nonexistent-runs-root"),
      sender,
      taskId,
      request: read.request,
    };
  }

  /**
   * **THE SCOPING FIX, ASSERTED AS A SET.**
   *
   * Hard-coded to `REVIEW_CONSOLE_ASPECTS`, this scan answered "which run holds
   * this seat" for three reviewers and for nobody else — so a triage actor
   * pointed at it would have resolved a map of three workers it does not have
   * and none of the three it does, and every sweep would have failed to dispatch
   * for a reason that reads as a console still coming up.
   */
  test("the triage table probes the observers and never the reviewers", async () => {
    const probed: string[] = [];
    await consoleRunResolution(
      inputFor("triage", ["obs-t1"]),
      probingSources(probed),
      TRIAGE_CONSOLE_ASPECTS,
    );
    for (const seat of TRIAGE_CONSOLE_ASPECTS) expect(probed).toContain(seat.worker);
    for (const seat of REVIEW_CONSOLE_ASPECTS) expect(probed).not.toContain(seat.worker);
  });

  /**
   * The default arm, which is the shipped console's and must not have moved.
   * This is the regression half: the review console's live fan-out resolves its
   * map through this same function with the argument omitted.
   */
  test("omitting the table probes the reviewers, exactly as before", async () => {
    const probed: string[] = [];
    await consoleRunResolution(inputFor("review", ["rev-arch-1"]), probingSources(probed));
    for (const seat of REVIEW_CONSOLE_ASPECTS) expect(probed).toContain(seat.worker);
    for (const seat of TRIAGE_CONSOLE_ASPECTS) expect(probed).not.toContain(seat.worker);
  });

  /**
   * The COLLATOR is never probed, on either console: it is resolved from the run
   * the request was found in. Pinned because the aspect table is now a
   * parameter, and a table that accidentally included its own collator would
   * make the scan look for the one worker whose run is already known.
   */
  test("the sender is resolved from its own run rather than scanned for", async () => {
    const probed: string[] = [];
    await consoleRunResolution(
      inputFor("triage", ["obs-t1"]),
      probingSources(probed),
      TRIAGE_CONSOLE_ASPECTS,
    );
    expect(probed).not.toContain("tri-1");
  });
});

// ---------------------------------------------------------------------------
// 6. SEAM FOUR, and the registry's internal agreement.
// ---------------------------------------------------------------------------

describe("the console registry", () => {
  test("it holds review and triage, and the names are unique", () => {
    expect(CONSOLES.map((c) => c.name)).toEqual(["review", "triage"]);
    expect(new Set(CONSOLES.map((c) => c.name)).size).toBe(CONSOLES.length);
  });

  /**
   * **THE PAIRING PIN — the price of spelling `aspects` and `fanOut` separately.**
   *
   * `fanOut` is `consoleFanOutFor(aspects)` by intent, and nothing in the type
   * enforces it, so a spec whose two halves disagree is constructible: it would
   * resolve runs for one set of seats and dispatch to another. Asserted the way
   * `REVIEW_CONSOLE_ROSTER` is asserted against `DEFAULT_REVIEW_WORKERS` — spell
   * both, pin the union, and let the failure be red rather than a console that
   * comes up and reviews nothing.
   */
  test("every console's aspect workers are exactly its roster's reviewers", () => {
    for (const spec of CONSOLES) {
      const seated = [...spec.aspects.map((s) => s.worker)].sort();
      expect([...spec.roster.reviewers].sort(), `console ${spec.name}`).toEqual(seated);
    }
  });

  test("no console seats its own collator, on either half", () => {
    for (const spec of CONSOLES) {
      for (const collator of spec.roster.collators) {
        expect(spec.aspects.some((s) => s.worker === collator), `console ${spec.name}`).toBe(false);
        expect(spec.roster.reviewers.includes(collator), `console ${spec.name}`).toBe(false);
      }
    }
  });

  /**
   * `resolveAspects` throws `RelayAspectError` on a seat named `collate`, and it
   * throws at the CALL — so a console registered with one would take the actor
   * down on its first fan-out rather than at startup. Checked here, over the
   * registry, so adding a third console cannot reintroduce it.
   */
  test("no registered console names an aspect `collate`", () => {
    for (const spec of CONSOLES) {
      expect(spec.aspects.some((s) => s.aspect === COLLATION_ASPECT), `console ${spec.name}`).toBe(
        false,
      );
    }
  });

  /**
   * The review console's fan-out is the MODULE-LEVEL BINDING, not an equivalent
   * one built here.
   *
   * `collator-relay-adapter.test.ts` pins the CLI's dependence on the exact
   * symbol `consoleFanOut`; if the shipped console silently stopped using it,
   * that pin would keep passing on the import text while testing a binding
   * nothing runs. Identity is the assertion, because equivalence is exactly what
   * would hide it.
   */
  test("the review console's fan-out is the pinned `consoleFanOut` binding", () => {
    expect(resolveConsole("review").fanOut).toBe(consoleFanOut);
  });

  /** The triage console has its OWN binding — sharing one would be the inert flag. */
  test("the triage console's fan-out is a different binding", () => {
    expect(resolveConsole("triage").fanOut).not.toBe(consoleFanOut);
  });
});
