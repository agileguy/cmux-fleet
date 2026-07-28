/**
 * Panes show live worker activity, not an idle shell (ISC-129).
 *
 * The criterion asks for "one workspace and N panes, each showing its worker
 * id and live activity", and only the id half was ever true. `up` created the
 * panes and left them running a login shell in the run directory:
 * `pane_current_command` read `bash`. `attachViewer` — the method
 * `respawn-pane` is in the required-command list to serve, which `doctor`
 * states outright — had no production caller at all, the same
 * tested-but-unreachable shape as `destroy` and the two dead subsystems found
 * in earlier phases. Every test in the suite passed throughout.
 *
 * So the assertions here are about what an operator would SEE. A pane running
 * the right process is not enough: the last test appends to the event stream
 * and requires the text to appear on screen, because a viewer pointed at a
 * file that never changes is indistinguishable from an empty pane. That is
 * not hypothetical — `supervisor.log`, the obvious first target, measured 0
 * bytes across an entire run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "pifleet-viewer-"));
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

describe("every worker gets a pane that shows what it is doing", () => {
  test("one pane per worker, each titled with its worker id", async () => {
    const r = await tmux(["list-panes", "-t", `=pifleet-${runId}`, "-F", "#{pane_title}"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").sort()).toEqual(["eng-1", "eng-2"]);
  });

  /**
   * The defect in one assertion. `bash` here means the pane was created and
   * then left alone — present in the layout, useless to the operator.
   */
  test("a pane runs a viewer, not an idle login shell", async () => {
    const r = await tmux([
      "list-panes",
      "-t",
      `=pifleet-${runId}`,
      "-F",
      "#{pane_current_command}",
    ]);
    const commands = r.out.split("\n");
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      expect(["bash", "sh", "zsh", "fish"]).not.toContain(c);
    }
  });

  /**
   * Liveness, which is the half a process check cannot prove. `tail -F` on a
   * file nobody writes to renders exactly like a blank pane.
   */
  test("new event-stream output appears on screen", async () => {
    const marker = `pifleet-viewer-marker-${process.pid.toString(36)}`;
    const events = join(rig.root, runId, "workers", "eng-1", "events.jsonl");
    await appendFile(events, `{"ts":"2026-07-28T00:00:00Z","type":"stderr_line","line":"${marker}"}\n`);

    const panes = await tmux(["list-panes", "-t", `=pifleet-${runId}`, "-F", "#{pane_title} #{pane_id}"]);
    const line = panes.out.split("\n").find((l) => l.startsWith("eng-1 "));
    expect(line).toBeDefined();
    const paneId = line!.split(" ")[1]!;

    // tail polls, so allow it a moment rather than asserting on the instant.
    let screen = "";
    for (let i = 0; i < 40 && !screen.includes(marker); i++) {
      await new Promise((r) => setTimeout(r, 100));
      screen = (await tmux(["capture-pane", "-p", "-t", paneId])).out;
    }
    expect(screen).toContain(marker);
  });

  /**
   * The viewer must not be able to steer the worker. A pane is a view, never
   * a channel (SRD §3.3) — if the pane's process could write to the control
   * socket, a rendered surface would become correctness-bearing.
   */
  test("the viewer is read-only: it follows files and holds no control socket", async () => {
    const r = await tmux([
      "list-panes",
      "-t",
      `=pifleet-${runId}`,
      "-F",
      "#{pane_start_command}",
    ]);
    for (const cmd of r.out.split("\n")) {
      expect(cmd).toContain("tail");
      // A viewer that took the control socket, or any pifleet subcommand that
      // could write, would make the pane a channel.
      expect(cmd).not.toContain(".sock");
    }
  });
});
