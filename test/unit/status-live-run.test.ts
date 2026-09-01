/**
 * `status` follows the newest LIVE run, not the newest run DIRECTORY.
 *
 * ## The measurement
 *
 * `latestRunId` answers "which run directory sorts last", and for `report` and
 * `harvest` that is right — they grade a finished run and a dead one is their
 * subject. `status` answers "what is my fleet doing", and there the newest
 * directory is the wrong run whenever the newest run is over and an older one
 * is still up.
 *
 * Seen twice on the operations console 2026-08-30. First the pane showed
 * `run 2026-08-24T17-18-05Z-7f40 / eng-1: dead supervisor=gone`, six days old.
 * Then, with a healthy fleet up under an earlier id, a `down` of a NEWER run
 * left the pane reporting `dead / supervisor=gone` while the live fleet was
 * invisible. A standing pane whose job is to say whether the fleet is up,
 * saying "gone" while it is up, is worse than no pane.
 *
 * Liveness here is REAL: the live run's state names `process.pid`, which is
 * alive by definition inside a running test, and the dead run names a pid that
 * cannot be. A fabricated `alive` flag would test the fixture.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latestRunId, runPaths, workerPaths } from "../../src/run/paths.ts";
import { latestLiveRunId } from "../../src/run/registry.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { stripComments } from "../support/source-structure.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/**
 * A run directory complete enough for the selector: `run.json` (which is what
 * `runIdsAscending` filters on) and one worker's `state.json`.
 *
 * The pid is the parameter. `process.pid` is alive; `2 ** 30` is a pid no
 * system has allocated, so `processStartTime` returns null for it.
 */
async function makeRun(root: string, runId: string, pid: number): Promise<void> {
  const run = runPaths(runId, root);
  await mkdir(workerPaths(run, "w1").dir, { recursive: true });
  await writeFile(join(root, runId, "run.json"), JSON.stringify({ run_id: runId }));
  // Written through the SHIPPED constructor and writer, never a hand-rolled
  // object: `WorkerStateSchema` carries a `schema:` discriminant and a
  // `proc_started` field, and a fixture that spells the document itself drifts
  // from the reader the moment either changes. The first version of this file
  // did exactly that and every case failed on the discriminant.
  await writeWorkerState(
    workerPaths(run, "w1"),
    initialWorkerState({
      worker: "w1",
      runId,
      pid,
      pgid: pid,
      startedAt: "2026-08-30T00:00:00.000Z",
    }),
  );
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "pifleet-status-"));
  roots.push(r);
  return r;
}

/**
 * A pid that is genuinely dead rather than merely improbable.
 *
 * The first version used `2 ** 30`, and `processStartTime` refused it —
 * `ps: process id too large` — with an `IdentityReadError` whose own message
 * says the read failing is NOT the process being gone. That refusal is correct
 * and is why the constant is earned instead of invented: a child that has run
 * and exited leaves a pid the OS accepts and no longer resolves.
 */
const DEAD_PID = await (async () => {
  const p = Bun.spawn(["true"]);
  const pid = p.pid;
  await p.exited;
  return pid;
})();

describe("status picks the run that is actually running", () => {
  test("an older LIVE run beats a newer dead one", async () => {
    // The exact shape measured: `down` a newer run and the pane must not start
    // reporting the corpse.
    const r = await root();
    await makeRun(r, "2026-08-31T05-31-17Z-8058", process.pid);
    await makeRun(r, "2026-08-31T05-33-03Z-3387", DEAD_PID);

    expect(await latestLiveRunId(r)).toBe("2026-08-31T05-31-17Z-8058");
    // …and the control that makes the assertion mean something: the OLD
    // selector really does prefer the dead one, so this is a behaviour change
    // rather than a restatement of what already happened.
    expect(await latestRunId(r)).toBe("2026-08-31T05-33-03Z-3387");
  });

  test("the newest run wins when it is the live one — no gratuitous rewind", async () => {
    const r = await root();
    await makeRun(r, "2026-08-31T05-31-17Z-8058", DEAD_PID);
    await makeRun(r, "2026-08-31T05-33-03Z-3387", process.pid);
    expect(await latestLiveRunId(r)).toBe("2026-08-31T05-33-03Z-3387");
  });

  test("with TWO live runs the NEWEST wins — the scan really is newest-first", async () => {
    /*
     * THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
     *
     * Reversing the loop to scan oldest-first left the two cases above green,
     * and reading them shows why: in one the live run IS the older, in the
     * other the dead run is checked and skipped before the live one is reached.
     * Neither could tell the directions apart, so "newest-first" was asserted
     * by the comment and by nothing else.
     *
     * Two LIVE runs is the only shape that distinguishes them.
     */
    const r = await root();
    await makeRun(r, "2026-08-31T05-31-17Z-8058", process.pid);
    await makeRun(r, "2026-08-31T05-33-03Z-3387", process.pid);
    expect(await latestLiveRunId(r)).toBe("2026-08-31T05-33-03Z-3387");
  });

  test("no live run at all yields null, so the caller can fall back", async () => {
    // The fallback is not a detail. With nothing running, `status` must still
    // print the last run rather than refuse — a post-mortem `status` after
    // everything has settled behaves exactly as it always did. This narrows
    // WHICH run is chosen when several exist; it never makes `status` refuse.
    const r = await root();
    await makeRun(r, "2026-08-31T05-31-17Z-8058", DEAD_PID);
    await makeRun(r, "2026-08-31T05-33-03Z-3387", DEAD_PID);
    expect(await latestLiveRunId(r)).toBeNull();
    expect(await latestRunId(r)).toBe("2026-08-31T05-33-03Z-3387");
  });

  test("an empty root is null rather than a throw", async () => {
    expect(await latestLiveRunId(await root())).toBeNull();
  });
});

/**
 * The WIRING, asserted structurally — because the selector being correct says
 * nothing about `status` using it.
 *
 * THIS BLOCK ALSO EXISTS BECAUSE A MUTATION SURVIVED. Deleting
 * `latestLiveRunId(root) ??` from the action left every test above green: they
 * all call the selector directly, so the one line that makes it reach an
 * operator was covered by nothing. That is the decorative-probe shape — the
 * failure is never in the assertion, it is in what reaches the assertion — and
 * the repair is a probe over the call site rather than a stronger claim about
 * the function.
 */
describe("the status action actually consults the live-run selector", () => {
  const SRC = stripComments(
    readFileSync(new URL("../../src/cli/commands/status.ts", import.meta.url).pathname, "utf8"),
  );

  test("the run is resolved live-first, with latestRunId as the FALLBACK", () => {
    // Order matters and is asserted as order: `latestRunId ?? latestLiveRunId`
    // would type-check, read plausibly, and restore the exact defect — the
    // newest directory would win again and the live run would never be reached.
    //
    // The chain moved into a `resolveRunIds` helper when `--all` landed, so the
    // pattern no longer starts at `opts.run`. What it still pins is the part
    // that carries the defect: the two selectors, in this order, in one
    // expression.
    const resolution = /\(await latestLiveRunId\(root\)\)\s*\?\?\s*\(await latestRunId\(root\)\)/;
    expect(SRC).toMatch(resolution);
  });

  test("`--run <id>` still wins over both — an explicit id is never second-guessed", () => {
    // The clause that keeps this a NARROWING and not a hijack: an operator who
    // named a run gets that run, alive or dead, which is what makes a
    // post-mortem `status --run <finished>` still work.
    //
    // Asserted as an EARLY RETURN now rather than as the head of a `??` chain.
    // The two spellings mean the same thing, and this is the one in the source;
    // what must not happen is `--run` being consulted after either selector.
    expect(SRC).toMatch(/if \(opts\.run !== undefined\) return \[opts\.run\];/);
    // And it is reached BEFORE either selector runs.
    expect(SRC.indexOf("opts.run !== undefined")).toBeLessThan(SRC.indexOf("liveRunIds(root)"));
    expect(SRC.indexOf("opts.run !== undefined")).toBeLessThan(SRC.indexOf("latestLiveRunId(root)"));
  });

  test("`--all` prefers live runs but never returns an empty report", () => {
    // The fallback is what keeps `--all` usable on a fleet that is entirely
    // down: with no live run it drops through to the same single-run resolution
    // a bare `status` uses, rather than printing nothing and exiting clean —
    // which would read as "no problems" instead of "nothing is running".
    expect(SRC).toMatch(/if \(live\.length > 0\) return live;/);
  });
});
