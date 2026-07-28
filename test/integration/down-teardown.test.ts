/**
 * `pifleet down` destroys the workspace it opened (ISC-129).
 *
 * It did not. A real `up --backend tmux` followed by `down` printed
 * `"clean": true` while the tmux session and both panes were still alive, so
 * every run leaked a session that nothing but `tmux kill-server` would ever
 * reclaim — and the JSON said the opposite. `FleetBackend.destroy` existed,
 * had its own passing tests, and had no production caller anywhere: the third
 * fully-tested-but-unreachable subsystem found in this project. `--keep-panes`
 * was the tell. It was a documented flag that nothing read — not even present
 * in the action's parameter type — because the teardown it modifies was never
 * wired up.
 *
 * These drive the real CLI against a real detached tmux server on a private
 * `-L` socket. The run directory is built by hand so a failure here is
 * `down`'s and not a regression in `up`, and both directions are asserted:
 * a session that must disappear, and one that must survive.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaths, workerPaths } from "../../src/run/paths.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");
const SOCKET = `pifleet-down-${process.pid.toString(36)}`;

const bases: string[] = [];
afterAll(async () => {
  await Bun.spawn(["tmux", "-L", SOCKET, "kill-server"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

async function tmux(args: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return { out: out.trim(), code: await p.exited };
}

/**
 * A run whose single worker points at a live tmux session. No worker state is
 * written, so `down` reports it `already_gone` and proceeds — which is the
 * point: the teardown must not depend on there being a process left to stop.
 */
async function makeRun(session: string): Promise<{ root: string; runId: string }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-down-"));
  bases.push(base);
  const root = join(base, "runs");
  const runId = `2026-07-28T00-00-00Z-${session.slice(-4)}`;
  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");
  const wp = workerPaths(run, "eng-1");
  await mkdir(wp.dir, { recursive: true });
  await writeFile(
    wp.presentationJson,
    JSON.stringify({
      schema: "pifleet.presentation/v1",
      worker: "eng-1",
      backend: "tmux",
      workspace_ref: session,
      surface_ref: null,
      window_ref: null,
    }),
    "utf8",
  );
  return { root, runId };
}

async function down(
  rig: { root: string; runId: string },
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", rig.runId, "--json", ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      PIFLEET_RUNS_DIR: rig.root,
      PIFLEET_TMUX_SOCKET: SOCKET,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

describe("down destroys the workspace the run opened", () => {
  test("the tmux session is gone afterwards, not merely reported clean", async () => {
    const session = "pifleet-teardown-a1";
    await tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
    // Prove the fixture is real before asserting it disappears — a session
    // that never existed would make this pass for no reason.
    expect((await tmux(["has-session", "-t", `=${session}`])).code).toBe(0);

    const rig = await makeRun(session);
    const r = await down(rig);
    expect(r.code, `down stderr: ${r.stderr.slice(0, 400)}`).toBe(0);
    // The old behaviour: this claim was true of the processes and false of
    // the view, and only the JSON was ever checked.
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ clean: true });
    expect((await tmux(["has-session", "-t", `=${session}`])).code).not.toBe(0);
  });

  test("--keep-panes leaves the session up for post-mortem reading", async () => {
    const session = "pifleet-teardown-b2";
    await tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
    const rig = await makeRun(session);
    const r = await down(rig, ["--keep-panes"]);
    expect(r.code, `down stderr: ${r.stderr.slice(0, 400)}`).toBe(0);
    // The flag was inert. Without this assertion the teardown fix could have
    // shipped destroying panes unconditionally and nothing would have said so.
    expect((await tmux(["has-session", "-t", `=${session}`])).code).toBe(0);
    await tmux(["kill-session", "-t", `=${session}`]);
  });

  /**
   * A workspace that has already vanished is the normal case after a crash,
   * and `down`'s job is still to report the processes honestly. If a failed
   * teardown could change the exit code, a dead pane would masquerade as a
   * surviving supervisor — presentation is not the control plane (SRD §7.6).
   */
  test("a workspace that no longer exists does not fail the run", async () => {
    const rig = await makeRun("pifleet-never-existed-c3");
    const r = await down(rig);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ clean: true });
  });

  test("a headless worker needs no teardown and reports clean", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-down-hl-"));
    bases.push(base);
    const root = join(base, "runs");
    const runId = "2026-07-28T00-00-00Z-hl01";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");
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
    const r = await down({ root, runId });
    expect(r.code).toBe(0);
  });
});
