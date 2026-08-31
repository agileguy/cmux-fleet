/**
 * The Phase 4 `pane_mode: tui` guards in `pifleet up` (TUI spec items 12 and 4).
 *
 * ## The risk these probe is the rpc path, not the tui one
 *
 * A tui worker has no behaviour to regress — the mode did not exist. What CAN
 * break is a guard that fires on everything: a warning every fleet prints, a
 * refusal every headless run trips over. So every describe block below carries
 * an rpc arm that must come back empty/silent, and those arms are the ones
 * worth keeping if the rest were ever cut.
 *
 * Everything here is pure and runs against temp-dir YAML — no Docker daemon, no
 * run directory, no fleet.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type LoadedConfig } from "../../src/config/load.ts";
import {
  runIsUnattended,
  tuiWorkerIds,
  unattendedTuiWarning,
} from "../../src/cli/commands/up.ts";

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Smallest valid document; each test overrides the pieces it is about. */
function baseDoc(): Record<string, unknown> {
  return {
    version: 2,
    name: "test-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel" },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
  };
}

async function load(doc: unknown): Promise<LoadedConfig> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-tui-guards-"));
  cleanups.push(dir);
  const path = join(dir, "fleet.yaml");
  await writeFile(path, stringify(doc));
  return loadConfig(path);
}

describe("tuiWorkerIds resolves the mode through the merge, never off config.workers", () => {
  /**
   * THE CONTROL, and the most valuable assertion in this file. Every fleet in
   * this repository's example config and every fleet anyone has run to date is
   * this shape; if `tuiWorkerIds` ever answers non-empty here, the warning
   * below fires on every run and the refusal in `up` blocks every headless one.
   */
  test("a fleet with no tui worker anywhere resolves to no tui workers", async () => {
    const loaded = await load(baseDoc());
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual([]);
  });

  test("a role-level pane_mode: tui is found", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual(["w1"]);
  });

  /**
   * The merge is HONOURED rather than re-derived, and this is the arm that
   * catches a re-derivation: neither `defaults` nor the worker entry states the
   * final answer on its own. A walk of `config.workers` reading `w.pane_mode`
   * would answer `[]` for the first case (the field is on `defaults`) and
   * `["w1"]` for the second (it reads `defaults` and misses the override) —
   * wrong in BOTH directions, which is why both directions are asserted.
   */
  test("pane_mode from defaults reaches a worker that states nothing", async () => {
    const doc = baseDoc();
    doc["defaults"] = { pane_mode: "tui" };
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual(["w1"]);
  });

  test("a worker override back to rpc wins over a tui default", async () => {
    const doc = baseDoc();
    doc["defaults"] = { pane_mode: "tui" };
    doc["workers"] = [{ id: "w1", role: "eng", pane_mode: "rpc" }];
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual([]);
  });

  test("only the named launch set is resolved, and an undefined id is skipped", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" }, plain: {} };
    doc["workers"] = [
      { id: "w1", role: "eng" },
      { id: "w2", role: "plain" },
    ];
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w2"])).toEqual([]);
    expect(tuiWorkerIds(loaded, ["w1", "w2"])).toEqual(["w1"]);
    // The `PIFLEET_PI_COMMAND` double: an id that exists only on the command
    // line has no role and so no pane_mode. Skipped, never thrown on.
    expect(tuiWorkerIds(loaded, ["nowhere"])).toEqual([]);
  });
});

describe("runIsUnattended", () => {
  const ttys = (stdin: boolean, stdout: boolean, stderr: boolean) => ({
    stdinIsTty: stdin,
    stdoutIsTty: stdout,
    stderrIsTty: stderr,
  });

  test("any one terminal on any one stream is evidence of a person", () => {
    // Three separate arms, because a reader redirecting two streams
    // (`pifleet up > out.txt 2> err.txt`) is a person, and an implementation
    // that only consulted stdout would call them CI.
    expect(runIsUnattended({ json: false, ...ttys(true, false, false) })).toBe(false);
    expect(runIsUnattended({ json: false, ...ttys(false, true, false) })).toBe(false);
    expect(runIsUnattended({ json: false, ...ttys(false, false, true) })).toBe(false);
  });

  test("three pipes and no --json is unattended", () => {
    expect(runIsUnattended({ json: false, ...ttys(false, false, false) })).toBe(true);
  });

  /**
   * `--json` alone, from a full terminal, is deliberately unattended: it names
   * a machine consumer. This is the OVERWARNING the function's docblock chooses
   * on purpose, pinned so that nobody "fixes" it into a silent miss.
   */
  test("--json is unattended even with every stream on a terminal", () => {
    expect(runIsUnattended({ json: true, ...ttys(true, true, true) })).toBe(true);
  });
});

describe("unattendedTuiWarning says what is given up", () => {
  /**
   * THE CONTROL. An rpc fleet in CI — three pipes, `--json`, the loudest
   * possible unattended signal — must still print nothing.
   */
  test("an unattended run with no tui worker is silent", () => {
    expect(unattendedTuiWarning({ tuiWorkers: [], unattended: true })).toBeNull();
  });

  test("a tui worker in an attended run is silent", () => {
    expect(unattendedTuiWarning({ tuiWorkers: ["w1"], unattended: false })).toBeNull();
  });

  test("a tui worker in an unattended run names the workers and each voided guarantee", () => {
    const text = unattendedTuiWarning({ tuiWorkers: ["w1", "w2"], unattended: true });
    expect(text).not.toBeNull();
    const w = text!;
    expect(w).toStartWith("warning: ");
    expect(w).toEndWith("\n");
    // The workers, by name and by count.
    expect(w).toContain("2 worker(s)");
    expect(w).toContain("w1, w2");

    /**
     * The COSTS, one assertion each. "Say what is being given up, not just
     * that something is" is the requirement, and a warning that only said
     * "unattended tui run" would pass every assertion above this block. Each
     * fragment names a behaviour this build actually has, so a future change
     * that removes one of them leaves a warning that lies.
     */
    expect(w).toContain("pane_mode_tui_is_not_auto_schedulable");
    expect(w).toContain("epoch null");
    expect(w).toContain("ui_request_timeout");
    expect(w).toContain("docker kill --signal=INT");
    expect(w).toContain("transcript-derived");
    expect(w).toContain("closing it stops the worker");
    // …and the action, which is what makes it a warning rather than a lament.
    expect(w).toContain("pifleet attach --worker w1");
  });
});
