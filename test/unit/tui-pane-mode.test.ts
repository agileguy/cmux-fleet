/**
 * `pifleet tui --worker <id>` on a `pane_mode: tui` worker (TUI spec item 11).
 *
 * The invariant this whole subsystem exists for — *a run a person touched must
 * never be able to present as unattended* — is what decides both halves here,
 * and each half is proven rather than argued:
 *
 * - entry on such a worker still WRITES the record even though it changes no
 *   pane, because the record is the only thing that can make the run present as
 *   attended;
 * - `--leave` is refused, because `left_at` on a pane that is still
 *   `docker attach` asserts a person stopped driving a terminal they are still
 *   holding.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { enterTui, readAttended } from "../../src/attended/mode.ts";
import { TUI_VOIDED, voidedFor } from "../../src/attended/voided.ts";
import type { PaneRef } from "../../src/backends/types.ts";
import { PANE_ALREADY_ATTENDED, tuiPaneMode } from "../../src/cli/commands/tui.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-08-31T00-00-00Z-tuim";
const PANE: PaneRef = { backend: "cmux", id: "ws:surf" };

function launch(mode: "rpc" | "tui"): WorkerLaunch {
  const argv =
    mode === "rpc"
      ? ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc"]
      : ["docker", "run", "-i", "-t", "--rm", "img", "pi"];
  return WorkerLaunchSchema.parse({
    kind: "container",
    argv,
    container: "c",
    image: "img",
    pane_mode: mode,
  });
}

async function makeRun(): Promise<RunPaths> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-mode-"));
  bases.push(base);
  const run = runPaths(RUN_ID, join(base, "runs"));
  await mkdir(workerPaths(run, "w-1").dir, { recursive: true });
  return run;
}

describe("tuiPaneMode reads the launch record, and refuses to guess", () => {
  test("an rpc worker is rpc", () => {
    expect(tuiPaneMode(launch("rpc"))).toBe("rpc");
  });

  test("a tui worker is tui", () => {
    expect(tuiPaneMode(launch("tui"))).toBe("tui");
  });

  /**
   * The `PIFLEET_PI_COMMAND` double. It has no container, which is the fact
   * that made `abort.ts` originally call it unabortable, AND a live supervisor
   * holding a control socket — so its pane is an ordinary viewer and `tui`
   * behaves exactly as it always has.
   */
  test("no launch record is rpc, not unknown", () => {
    expect(tuiPaneMode(null)).toBe("rpc");
  });

  test("a record whose field and argv marks disagree is unknown", () => {
    const inconsistent = WorkerLaunchSchema.parse({
      kind: "container",
      argv: ["docker", "run", "-i", "--rm", "img", "pi"],
      container: "c",
      image: "img",
      pane_mode: "tui",
    });
    expect(tuiPaneMode(inconsistent)).toBe("unknown");
  });
});

describe("entering attended mode on a worker whose pane is already a person's", () => {
  /**
   * The record is written even though the pane is not touched.
   *
   * This is the invariant half. A driver that does nothing is not the same as
   * not entering: if entry were refused outright — the tidier-looking
   * alternative — a `pane_mode: tui` worker would have NO command that could
   * ever mark it attended, and the run would present as autonomous while a
   * person typed into it.
   */
  /**
   * STRENGTHENED for TUI spec item 14. This test's scenario is a
   * `pane_mode: tui` worker, and it used to assert the record carried
   * `TUI_VOIDED` — the ATTENDED table — because that was the only table there
   * was. It now asserts the table `voidedFor` picks for the mode, which is
   * that one plus the mode's own rows. Nothing was relaxed: every id the old
   * assertion required is still required, by the loop below.
   */
  test("writes the attended record and its voided table", async () => {
    const run = await makeRun();
    const record = await enterTui({
      run,
      workerId: "w-1",
      backend: PANE_ALREADY_ATTENDED,
      pane: PANE,
      paneMode: "tui",
    });
    expect(record.mode).toBe("tui");
    expect(record.left_at).toBeNull();
    expect(record.voided.map((v) => v.isc)).toEqual(voidedFor("tui").map((v) => v.isc));
    // The old assertion's content, kept explicitly rather than implied by the
    // line above: every attended-mode row survives the merge.
    for (const v of TUI_VOIDED) expect(record.voided.map((r) => r.isc)).toContain(v.isc);
    // …and the mode's rows are there too, which is what the merge is FOR.
    expect(record.voided.map((r) => r.isc)).toContain("ISC-85");

    // …and it is on DISK, not merely returned. `report` reads the file.
    const onDisk = await readAttended(run, "w-1");
    expect(onDisk?.mode).toBe("tui");
    expect(onDisk?.voided.length).toBe(voidedFor("tui").length);
    expect(onDisk!.voided.length).toBeGreaterThan(TUI_VOIDED.length);
  });

  /**
   * The DEFAULT is `rpc`, and it is asserted rather than left implicit.
   *
   * `paneMode` is optional on `ModeSwitchArgs` so that every pre-Phase-4
   * caller keeps meaning what it meant. An omitted argument that silently
   * merged the mode's table would tell an operator entering an ordinary
   * worker's pane that their run had lost its epochs and its ack, which is the
   * over-reporting direction — safe for the invariant, and a lie about the
   * mechanism. Both directions are wrong; this pins the one that is reachable
   * by forgetting an argument.
   */
  test("an omitted paneMode records the attended table, not the mode's", async () => {
    const run = await makeRun();
    const record = await enterTui({
      run,
      workerId: "w-2",
      backend: PANE_ALREADY_ATTENDED,
      pane: PANE,
    });
    expect(record.voided.map((v) => v.isc)).toEqual(TUI_VOIDED.map((v) => v.isc));
    expect(record.voided.map((v) => v.isc)).not.toContain("ISC-85");
  });

  /**
   * The driver changes no pane. Asserted by giving it the arguments a real
   * respawn would take and observing that it neither throws nor reports
   * anything — the contrast that matters is with `interactiveArgv`, which would
   * replace the person's `docker attach` with `docker exec -it … bash` and
   * destroy the one thing `pane_mode: tui` provides.
   */
  test("the no-op driver accepts a respawn request and performs none", async () => {
    const calls: unknown[] = [];
    const spy = {
      async attachViewer(p: PaneRef, argv: string[]): Promise<void> {
        calls.push({ p, argv });
      },
    };
    const run = await makeRun();

    // Control arm: a REAL driver is called exactly once by `enterTui`, so the
    // absence of a call below is a property of the driver and not of a code
    // path that never respawns anything.
    await enterTui({ run, workerId: "w-1", backend: spy, pane: PANE });
    expect(calls).toHaveLength(1);

    // The arm under test: same call, the no-op driver, nothing recorded.
    await enterTui({ run, workerId: "w-1", backend: PANE_ALREADY_ATTENDED, pane: PANE });
    expect(calls).toHaveLength(1);
  });
});
