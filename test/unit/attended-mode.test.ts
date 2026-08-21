/**
 * Enter/leave semantics of attended mode (SRD §3.5, Phase 6).
 *
 * Two properties carry the subsystem and each gets a test that fails if the
 * behaviour is removed rather than merely exercising the happy path:
 *
 * - **The record survives `--leave`.** A test that only checked existence
 *   after entering would pass with a delete-on-leave bug — the exact bug that
 *   would let an attended run present as unattended.
 *
 * - **The write/respawn ORDER is load-bearing in both directions.** Enter
 *   records before handing the pane over; leave takes the pane back before
 *   recording. Both are proven by making the respawn fail on cue and
 *   observing which side of the record survived.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readAttended as steerReadAttended } from "../../src/cli/commands/steer.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AttendedRecordSchema, EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { StateReadError } from "../../src/run/state.ts";
import {
  ATTENDED_SCHEMA,
  AttendedModeError,
  AttendedSchemaError,
  enterTui,
  interactiveArgv,
  leaveTui,
  readAttended,
  viewerArgv,
  workerContainerName,
} from "../../src/attended/mode.ts";
import { TUI_VOIDED } from "../../src/attended/voided.ts";
import type { PaneRef } from "../../src/backends/types.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-07-28T00-00-00Z-tui0";
const PANE: PaneRef = { backend: "tmux", id: "%7" };

async function makeRun(): Promise<{ run: RunPaths; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-attended-"));
  bases.push(base);
  const root = join(base, "runs");
  return { run: runPaths(RUN_ID, root), root };
}

/** Records every respawn so ordering and argv are observable. */
class FakeDriver {
  calls: Array<{ pane: PaneRef; argv: string[] }> = [];
  async attachViewer(pane: PaneRef, argv: string[]): Promise<void> {
    this.calls.push({ pane, argv });
  }
}

/** A pane that cannot be respawned — the ordering probe. */
class FailingDriver {
  async attachViewer(): Promise<void> {
    throw new Error("respawn refused (injected)");
  }
}

describe("entering tui", () => {
  test("writes a schema-valid record and hands the pane an in-container shell", async () => {
    const { run } = await makeRun();
    const driver = new FakeDriver();
    const record = await enterTui({ run, workerId: "eng-1", backend: driver, pane: PANE });

    // The on-disk shape, not just the return value: the report reads the
    // FILE, so the file is what the contract is about.
    const raw: unknown = JSON.parse(
      await Bun.file(workerPaths(run, "eng-1").attendedJson).text(),
    );
    const disk = AttendedRecordSchema.parse(raw);
    expect(disk).toEqual(record);
    expect(disk.worker).toBe("eng-1");
    expect(disk.mode).toBe("tui");
    expect(disk.left_at).toBeNull();
    expect(disk.voided).toEqual([...TUI_VOIDED]);

    // The pane got an interactive shell in THIS worker's container — same
    // boundary the agent lives in, not a host shell beside it.
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]!.pane).toEqual(PANE);
    expect(driver.calls[0]!.argv).toEqual(interactiveArgv(RUN_ID, "eng-1"));
    expect(driver.calls[0]!.argv.join(" ")).toContain(workerContainerName(RUN_ID, "eng-1"));
    expect(driver.calls[0]!.argv.slice(0, 2)).toEqual(["docker", "exec"]);
  });

  /**
   * Record first, pane second. If the respawn fails the record must already
   * be on disk: overclaiming attendance degrades trust in a run that may not
   * have deserved it, which is the SAFE direction — the reverse order would
   * hand a person the pane with no durable trace.
   */
  test("the record survives a failed handover", async () => {
    const { run } = await makeRun();
    await expect(
      enterTui({ run, workerId: "eng-1", backend: new FailingDriver(), pane: PANE }),
    ).rejects.toThrow(/respawn refused/);
    const record = await readAttended(run, "eng-1");
    expect(record).not.toBeNull();
    expect(record!.mode).toBe("tui");
  });
});

describe("leaving tui", () => {
  test("sets left_at, restores the viewer, and the record SURVIVES", async () => {
    const { run, root } = await makeRun();
    const driver = new FakeDriver();
    const entered = await enterTui({ run, workerId: "eng-1", backend: driver, pane: PANE });

    const left = await leaveTui({
      run,
      workerId: "eng-1",
      backend: driver,
      pane: PANE,
      runsRoot: root,
    });

    // THE assertion this subsystem exists for: the file is still there after
    // --leave. Existence-after-enter alone would pass with delete-on-leave.
    const disk = AttendedRecordSchema.parse(
      JSON.parse(await Bun.file(workerPaths(run, "eng-1").attendedJson).text()) as unknown,
    );
    expect(disk).toEqual(left);
    expect(disk.mode).toBe("viewer");
    expect(disk.left_at).not.toBeNull();
    // The first touch is when the run became attended; leave must not move it.
    expect(disk.entered_at).toBe(entered.entered_at);
    // The voided table is history, not state: a run a person drove stays a
    // run a person drove, so leaving must not empty the list.
    expect(disk.voided).toEqual([...TUI_VOIDED]);

    // The restored pane runs the same read-only viewer `up` starts panes
    // with, addressed explicitly so a stale server cannot tail the wrong run.
    const restore = driver.calls[1]!;
    expect(restore.argv).toEqual(viewerArgv(root, RUN_ID, "eng-1"));
    const joined = restore.argv.join(" ");
    expect(joined).toContain("logs");
    expect(joined).toContain("--render");
    expect(joined).toContain(`PIFLEET_RUNS_DIR=${root}`);
    expect(joined).toContain(RUN_ID);
  });

  /**
   * Pane first, record second. If the pane could NOT be returned, `left_at`
   * must still be null: recording the session as over while a person still
   * owns the pane is the precise lie the record exists to prevent.
   */
  test("does not record left_at when the pane could not be returned", async () => {
    const { run, root } = await makeRun();
    await enterTui({ run, workerId: "eng-1", backend: new FakeDriver(), pane: PANE });
    await expect(
      leaveTui({
        run,
        workerId: "eng-1",
        backend: new FailingDriver(),
        pane: PANE,
        runsRoot: root,
      }),
    ).rejects.toThrow(/respawn refused/);
    const record = await readAttended(run, "eng-1");
    expect(record!.mode).toBe("tui");
    expect(record!.left_at).toBeNull();
  });

  test("leaving a worker that was never entered is a usage error", async () => {
    const { run, root } = await makeRun();
    const attempt = leaveTui({
      run,
      workerId: "eng-1",
      backend: new FakeDriver(),
      pane: PANE,
      runsRoot: root,
    });
    await expect(attempt).rejects.toBeInstanceOf(AttendedModeError);
    await expect(attempt).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    // And nothing was written: a refusal must not fabricate attendance.
    expect(await readAttended(run, "eng-1")).toBeNull();
  });
});

describe("re-entering after a leave", () => {
  test("keeps the original entered_at and reopens the session", async () => {
    const { run, root } = await makeRun();
    const driver = new FakeDriver();
    const first = await enterTui({ run, workerId: "eng-1", backend: driver, pane: PANE });
    await leaveTui({ run, workerId: "eng-1", backend: driver, pane: PANE, runsRoot: root });
    const again = await enterTui({ run, workerId: "eng-1", backend: driver, pane: PANE });

    // "Was this run ever touched" became yes at the FIRST entry; a re-entry
    // rewriting it would shrink the window a forensic reader must distrust.
    expect(again.entered_at).toBe(first.entered_at);
    expect(again.mode).toBe("tui");
    expect(again.left_at).toBeNull();
  });
});

/**
 * The durable-format half (ISC-192).
 *
 * `readAttended` already wrapped both of its failures in `StateReadError`, so
 * unlike its neighbours it never leaked a bare `ZodError`. What it could not
 * do is tell "another build wrote this" from "this file is damaged" — one
 * sentence for two facts with different fixes.
 *
 * The stakes here are the highest of the three readers this phase touched.
 * `attended: []` is an AFFIRMATIVE claim that nobody drove this run by hand,
 * so a reader that answered an unreadable record with `null` would silently
 * upgrade the trustworthiness of work a person touched — the mutation
 * `report-collect.test.ts` already records as the dangerous one.
 *
 * NEGATIVE FIRST: `rejects.toThrow()` alone would pass against a raw library
 * error, so every case asserts what the refusal is NOT before what it is.
 */
describe("attended.json this build cannot read (ISC-192)", () => {
  async function planted(tag: string, body: string): Promise<RunPaths> {
    const base = await mkdtemp(join(tmpdir(), `pifleet-attfmt-${tag}-`));
    bases.push(base);
    const run = runPaths(RUN_ID, join(base, "runs"));
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });
    await writeFile(wp.attendedJson, body, "utf8");
    return run;
  }

  const NOTHING_THROWN = Symbol("nothing thrown");
  async function refusalFrom(read: () => Promise<unknown>): Promise<Error> {
    let returned: unknown = NOTHING_THROWN;
    try {
      returned = await read();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      return err as Error;
    }
    throw new Error(
      `expected a refusal, but readAttended RETURNED ${JSON.stringify(returned) ?? String(returned)} — ` +
        `answering an unreadable attended record with a value is how an attended run presents as autonomous`,
    );
  }

  function notBareLibraryError(err: Error, what: string): void {
    if (err instanceof z.ZodError || err.name === "ZodError") {
      throw new Error(`${what} leaked a bare ZodError — the wrapper is gone. message: ${err.message}`);
    }
    if (err instanceof SyntaxError || err.name === "SyntaxError") {
      throw new Error(`${what} leaked a bare SyntaxError — the wrapper is gone. message: ${err.message}`);
    }
    // The diagnosed-failure protocol is structural: without a numeric
    // `exitCode` the CLI renders a stack trace on exit 1, off the §10 ladder.
    expect((err as { exitCode?: unknown }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  }

  test("an unrecognised stamp is its OWN answer, and never null", async () => {
    const run = await planted(
      "v2",
      JSON.stringify({
        schema: "pifleet.attended/v2",
        worker: "eng-1",
        mode: "tui",
        entered_at: new Date().toISOString(),
      }),
    );
    const err = await refusalFrom(() => readAttended(run, "eng-1"));
    notBareLibraryError(err, "readAttended on a v2 stamp");
    expect(err).toBeInstanceOf(AttendedSchemaError);
    expect(err).not.toBeInstanceOf(StateReadError);
    // Found, expected, and the escape — the three things `down.ts`'s
    // `identity_legacy_format` message carries, for the same reason.
    expect(err.message).toContain("pifleet.attended/v2");
    expect(err.message).toContain(ATTENDED_SCHEMA);
    expect(err.message).toContain("the build that wrote it");
    // And it must say what happens MEANWHILE, because the alternative reading
    // ("ignore the file") is the one that loses the fact.
    expect(err.message).toContain("UNVERIFIED");
  });

  test("a truncated record is DAMAGE, a different answer with a different fix", async () => {
    const run = await planted("trunc", '{"schema":"pifleet.attended/v1","worker":');
    const err = await refusalFrom(() => readAttended(run, "eng-1"));
    notBareLibraryError(err, "readAttended on a truncated record");
    expect(err).toBeInstanceOf(StateReadError);
    expect(err).not.toBeInstanceOf(AttendedSchemaError);
  });

  test("the RIGHT stamp with a wrong shape is damage too, and names the field", async () => {
    // The stamp says this build owns the document, so a failing field is a
    // real complaint about a document we understand — not a version skew.
    const run = await planted(
      "badmode",
      JSON.stringify({ schema: ATTENDED_SCHEMA, worker: "eng-1", mode: "not-a-mode", entered_at: "x" }),
    );
    const err = await refusalFrom(() => readAttended(run, "eng-1"));
    notBareLibraryError(err, "readAttended on a bad mode field");
    expect(err).toBeInstanceOf(StateReadError);
    expect(err.message).toContain("mode");
    // A ZodError's own message would print a bare `[` here.
    expect(err.message).not.toStartWith("[");
  });

  test("leaveTui does not manufacture a hand-back over an unreadable record", async () => {
    // `leaveTui` reads first and branches on `existing.mode !== "tui"`. If the
    // read degraded to null it would raise a USAGE error ("nothing to leave"),
    // which is a sentence about the OPERATOR when the truth is a sentence
    // about the FILE — and the pane would be respawned on the way past.
    const run = await planted(
      "leave",
      JSON.stringify({ schema: "pifleet.attended/v0", worker: "eng-1", mode: "tui", entered_at: "x" }),
    );
    const driver = new FakeDriver();
    const err = await refusalFrom(() =>
      leaveTui({ run, workerId: "eng-1", backend: driver, pane: PANE, runsRoot: "unused" }),
    );
    expect(err).toBeInstanceOf(AttendedSchemaError);
    expect(err).not.toBeInstanceOf(AttendedModeError);
    // Nothing was respawned: the refusal happened before the pane moved.
    expect(driver.calls).toEqual([]);
  });

  test("the constant a refusal NAMES and the literal a parse COMPARES stay paired", async () => {
    const { run } = await makeRun();
    const rec = await enterTui({ run, workerId: "eng-1", backend: new FakeDriver(), pane: PANE });
    expect(rec.schema).toBe(ATTENDED_SCHEMA);
    expect(() => AttendedRecordSchema.parse({ ...rec, schema: "other" })).toThrow();
  });
});

/**
 * `steer.ts` holds a SECOND, private reader of the same file.
 *
 * `attended/mode.ts`'s `readAttended(run, worker)` is the one every test above
 * exercises. `steer.ts` has its own `readAttended(path)` — different module,
 * different signature, and until now it mapped a foreign stamp to `null`,
 * which its caller reads as "no record" and answers by WRITING one over the
 * top. Another build's record, destroyed by a verb the operator ran for an
 * unrelated reason.
 *
 * The guard that fixes it had zero coverage when it was written: an adversarial
 * pass disabled it and nothing went red. Neither suite saw it — the tests above
 * grade a different function, and `durable-reader-wrapping.test.ts` cannot see
 * this shape at all, because `safeParse`-then-return-null is not an unwrapped
 * `.parse` for its scanner to find.
 */
describe("steer's private attended reader refuses a foreign stamp too (ISC-192)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function plantedFile(doc: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-steer-attended-"));
    dirs.push(dir);
    const p = join(dir, "attended.json");
    await writeFile(p, JSON.stringify(doc), "utf8");
    return p;
  }

  test("a foreign stamp throws rather than reading as 'no record'", async () => {
    const path = await plantedFile({
      schema: "pifleet.attended/v2",
      worker: "eng-1",
      mode: "tui",
      entered_at: new Date().toISOString(),
    });
    const err = await steerReadAttended(path).then(
      () => new Error("NOTHING THROWN — the reader answered a foreign stamp with a value"),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AttendedSchemaError);
    expect((err as Error).message).toContain("pifleet.attended/v2");
  });

  test("`null` still means absent, and damage is still lenient", async () => {
    // The leniency is deliberate and documented: a scribbled file must not
    // disable a control verb. Only a FOREIGN STAMP is refused.
    const scribbled = await plantedFile("not-an-object");
    expect(await steerReadAttended(scribbled)).toBeNull();
    const missing = join(dirs[0]!, "nope.json");
    expect(await steerReadAttended(missing)).toBeNull();
  });

  test("a record this build wrote still reads back", async () => {
    const path = await plantedFile({
      schema: ATTENDED_SCHEMA,
      worker: "eng-1",
      mode: "viewer",
      entered_at: new Date().toISOString(),
      left_at: new Date().toISOString(),
      voided: [],
    });
    const record = await steerReadAttended(path);
    expect(record).not.toBeNull();
    expect(record!.worker).toBe("eng-1");
  });
});
