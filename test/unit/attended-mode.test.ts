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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttendedRecordSchema, EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import {
  AttendedModeError,
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
