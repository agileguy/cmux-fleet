/**
 * `pifleet tui` against a live fleet (SRD §3.5, §16 Phase 6).
 *
 * A real `up` on the tmux backend, real detached supervisors over the fake-pi
 * double, a real private tmux server — the same rig `pane-viewer.test.ts`
 * uses, because the property under test is what an OPERATOR's pane actually
 * runs, and `#{pane_start_command}` is the only witness of that.
 *
 * The tests are ordered: they walk one attended session end to end (refuse a
 * premature leave → enter → report while attended → leave → report after),
 * because the subsystem's contract is a lifecycle, not a set of independent
 * verbs. `eng-2` is never entered, so it doubles as the control that `tui`
 * touches only the worker it was aimed at.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttendedRecordSchema, EXIT, RunReportSchema } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { workerContainerName } from "../../src/attended/mode.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT, "src/cli/index.ts");
const FAKE_PI = join(ROOT, "test/fixtures/fake-pi.ts");
const SCENARIO = join(ROOT, "test/fixtures/scenarios/happy.json");

interface Rig {
  base: string;
  root: string;
  tmuxTmp: string;
  env: Record<string, string>;
}

let rig: Rig;
let runId: string;

/** tmux against the rig's PRIVATE server, so a developer's own session is untouched. */
async function tmux(args: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(["tmux", ...args], {
    env: { ...process.env, TMUX_TMPDIR: rig.tmuxTmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  return { out: out.trim(), code: await p.exited };
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...rig.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

/** `#{pane_start_command}` of the pane titled with `worker`. */
async function paneCommand(worker: string): Promise<string> {
  const r = await tmux([
    "list-panes",
    "-t",
    `=pifleet-${runId}`,
    "-F",
    "#{pane_title}\t#{pane_start_command}",
  ]);
  expect(r.code).toBe(0);
  const line = r.out.split("\n").find((l) => l.startsWith(`${worker}\t`));
  expect(line, `no pane titled ${worker}`).toBeDefined();
  return line!.slice(worker.length + 1);
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-"));
  const root = join(base, "runs");
  const tmuxTmp = join(base, "tmux");
  await mkdir(root, { recursive: true });
  await mkdir(tmuxTmp, { recursive: true });
  rig = {
    base,
    root,
    tmuxTmp,
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${SCENARIO}`,
      TMUX_TMPDIR: tmuxTmp,
    },
  };
  const up = await cli(["up", "--workers", "eng-1,eng-2", "--backend", "tmux", "--json"]);
  expect(up.code, `up stderr: ${up.stderr.slice(0, 600)}`).toBe(0);
  runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
});

afterAll(async () => {
  await cli(["down", "--run", runId, "--json"]).catch(() => {});
  await tmux(["kill-server"]).catch(() => {});
  await rm(rig.base, { recursive: true, force: true }).catch(() => {});
});

describe("one attended session, end to end", () => {
  test("--leave before any enter refuses and fabricates nothing", async () => {
    const r = await cli(["tui", "--worker", "eng-1", "--run", runId, "--leave"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/does not have a pane handed to a person/);
    const file = workerPaths(runPaths(runId, rig.root), "eng-1").attendedJson;
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("tui hands the pane an in-container shell and records the run as attended", async () => {
    const before = await paneCommand("eng-1");
    expect(before).toContain("logs"); // the viewer `up` started

    const r = await cli(["tui", "--worker", "eng-1", "--run", runId, "--json"]);
    expect(r.code, `tui stderr: ${r.stderr.slice(0, 600)}`).toBe(0);
    const record = AttendedRecordSchema.parse(JSON.parse(r.stdout.trim()) as unknown);
    expect(record.worker).toBe("eng-1");
    expect(record.mode).toBe("tui");
    expect(record.voided.length).toBeGreaterThan(0);

    // The pane now starts an interactive shell inside THIS worker's
    // container — not the viewer, not a host shell.
    const after = await paneCommand("eng-1");
    expect(after).toContain("docker exec");
    expect(after).toContain(workerContainerName(runId, "eng-1"));
    expect(after).not.toContain("logs");

    // Aim matters: the worker nobody entered still runs its viewer.
    expect(await paneCommand("eng-2")).toContain("logs");

    // The durable record, on disk where `report` will look for it.
    const file = workerPaths(runPaths(runId, rig.root), "eng-1").attendedJson;
    const disk = AttendedRecordSchema.parse(JSON.parse(await Bun.file(file).text()) as unknown);
    expect(disk.worker).toBe("eng-1");
    expect(disk.left_at).toBeNull();
  });

  /**
   * The person about to type is the one who needs the voided table, at the
   * moment of entry — not after the fact in a report they may never run.
   */
  test("entry prints the voided guarantees to the operator", async () => {
    const r = await cli(["tui", "--worker", "eng-1", "--run", runId]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/guarantee\(s\) are void/);
    expect(r.stdout).toContain("ISC-87");
    // ISC-106, not ISC-136: entering tui adds no readScreen call, but it does
    // put a human's cloud verbs through the verbgate wearing the agent's row.
    expect(r.stdout).toContain("ISC-106");
  });

  test("report names the attended worker while a person is driving", async () => {
    const md = await cli(["report", "--run", runId]);
    expect(md.code, `report stderr: ${md.stderr.slice(0, 600)}`).toBe(0);
    expect(md.stdout).toMatch(/ATTENDED — a person drove worker eng-1/);
    expect(md.stdout).toContain("ISC-87");
    expect(md.stdout).toMatch(/not handed back/);

    const js = await cli(["report", "--run", runId, "--json"]);
    expect(js.code).toBe(0);
    const doc = JSON.parse(js.stdout.trim()) as { attended?: unknown[] };
    // The wire contract still validates — attended rides alongside it, the
    // same convention as collection_notes — and it names the worker.
    RunReportSchema.parse(doc);
    expect(doc.attended).toHaveLength(1);
    expect(AttendedRecordSchema.parse(doc.attended![0]).worker).toBe("eng-1");
  });

  test("--leave restores the viewer and the record SURVIVES", async () => {
    const r = await cli(["tui", "--worker", "eng-1", "--run", runId, "--leave", "--json"]);
    expect(r.code, `leave stderr: ${r.stderr.slice(0, 600)}`).toBe(0);

    // The pane runs the exact viewer `up` launches: explicit runs dir and
    // run id, `--render`, read-only. This is also the drift guard for the
    // viewer argv duplicated between `up.ts` and `attended/mode.ts`.
    const after = await paneCommand("eng-1");
    expect(after).toContain("logs");
    expect(after).toContain("--render");
    expect(after).toContain(`PIFLEET_RUNS_DIR=${rig.root}`);
    expect(after).toContain(runId);
    expect(after).not.toContain("docker exec");

    // THE point: leaving marks, it does not erase. A delete-on-leave bug
    // would pass every earlier test in this file.
    const file = workerPaths(runPaths(runId, rig.root), "eng-1").attendedJson;
    expect(await Bun.file(file).exists()).toBe(true);
    const disk = AttendedRecordSchema.parse(JSON.parse(await Bun.file(file).text()) as unknown);
    expect(disk.mode).toBe("viewer");
    expect(disk.left_at).not.toBeNull();
  });

  test("report still marks the run attended after the person left", async () => {
    const md = await cli(["report", "--run", runId]);
    expect(md.code).toBe(0);
    // The run was touched; that fact must outlive the session that touched it.
    expect(md.stdout).toMatch(/ATTENDED — a person drove worker eng-1/);
    expect(md.stdout).toMatch(/until/);
  });
});

describe("workers with no pane", () => {
  /**
   * Refusing beats pretending, in BOTH directions: focusing nothing would lie
   * about the pane, and writing an attended record for a pane that cannot
   * exist would lie about the run.
   */
  test("a headless worker refuses with a named reason and writes no record", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-tui-headless-"));
    try {
      const root = join(base, "runs");
      const hRunId = "2026-07-28T00-00-00Z-tui1";
      const run = runPaths(hRunId, root);
      await mkdir(run.workersDir, { recursive: true });
      await writeFile(
        run.runJson,
        JSON.stringify({ schema: "pifleet.run/v1", run_id: hRunId }),
        "utf8",
      );
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.dir, { recursive: true });
      await writeFile(
        wp.presentationJson,
        JSON.stringify({
          schema: "pifleet.presentation/v1",
          worker: "eng-1",
          backend: "headless",
          workspace_ref: null,
          surface_ref: null,
          window_ref: null,
        }),
        "utf8",
      );

      const p = Bun.spawn([process.execPath, CLI, "tui", "--worker", "eng-1", "--run", hRunId], {
        env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(stderr).toMatch(/no pane to hand over/);
      expect(await Bun.file(wp.attendedJson).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });
});
