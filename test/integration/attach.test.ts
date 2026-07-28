/**
 * `pifleet attach --worker <id>` (ISC-130).
 *
 * `attach` was a stub that threw "not implemented" for three phases, and the
 * only thing naming it was a list of registered command names — which passes
 * whether the command works or refuses. So these drive the REAL CLI process
 * and assert on what an operator would see.
 *
 * The run directory is assembled by hand rather than by running `up`: the
 * property under test is "attach focuses the pane the run recorded", and the
 * recorded state is `presentation.json`. Building it directly means a failure
 * here is attach's, not a `up` regression wearing attach's name.
 *
 * A real detached tmux server on a private `-L` socket stands in for the
 * backend, because tmux is scriptable without a TTY and this repo has already
 * been bitten by tests sharing a socket path derived only from ids.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

interface Rig {
  root: string;
  runId: string;
}

/**
 * A run directory containing one worker whose presentation names `backend`.
 * `surfaceRef` is what `attach` will hand to that backend's `focus`.
 */
async function makeRun(backend: string, surfaceRef: string | null): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-attach-"));
  bases.push(base);
  const root = join(base, "runs");
  const runId = "2026-07-28T00-00-00Z-att0";
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
      backend,
      workspace_ref: "ws-1",
      surface_ref: surfaceRef,
      window_ref: null,
    }),
    "utf8",
  );
  return { root, runId };
}

async function attach(
  rig: Rig,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "attach", ...args], {
    env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: rig.root, ...env },
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

describe("attach focuses the pane the run recorded", () => {
  test("--worker is required", async () => {
    const rig = await makeRun("tmux", "%1");
    const r = await attach(rig, []);
    expect(r.code).toBe(EXIT.USAGE);
    expect(`${r.stdout}${r.stderr}`).toMatch(/--worker/);
  });

  test("a worker with no presentation record is a usage error, not a crash", async () => {
    const rig = await makeRun("tmux", "%1");
    const r = await attach(rig, ["--worker", "nope", "--run", rig.runId]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(`${r.stdout}${r.stderr}`).toMatch(/no presentation record/);
  });

  /**
   * `headless` has no panes, and that is a normal configuration — but silently
   * succeeding would tell the operator a pane was focused when none exists.
   * The distinction matters because headless is the DEFAULT backend.
   */
  test("a headless worker refuses with a named reason rather than pretending", async () => {
    const rig = await makeRun("headless", null);
    const r = await attach(rig, ["--worker", "eng-1", "--run", rig.runId]);
    expect(r.code).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(`${r.stdout}${r.stderr}`).toMatch(/no pane to focus/);
  });

  /**
   * The real path, against a real tmux server. The pane id in
   * `presentation.json` is the one tmux itself reported at creation, so a
   * successful focus proves attach read the record and addressed the backend
   * that record names — not that it guessed a backend from a flag.
   */
  test("focuses a real tmux pane recorded in presentation.json", async () => {
    const socket = `pifleet-attach-${process.pid.toString(36)}`;
    const sh = async (args: string[]): Promise<string> => {
      const p = Bun.spawn(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out.trim();
    };
    try {
      await sh(["new-session", "-d", "-s", "fleet", "-x", "80", "-y", "24"]);
      // Two panes so "focused the right one" is distinguishable from "there
      // was only one pane". A single-pane fixture would pass no matter which
      // pane attach addressed — the same shape as a fixture that lists the
      // expected answer first.
      await sh(["split-window", "-t", "fleet", "-d"]);
      const ids = (await sh(["list-panes", "-t", "fleet", "-F", "#{pane_id}"])).split("\n");
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const target = ids[1]!;

      const rig = await makeRun("tmux", target);
      // Make the OTHER pane active first, so a no-op attach cannot pass.
      await sh(["select-pane", "-t", ids[0]!]);
      expect(await sh(["display-message", "-p", "-t", "fleet", "#{pane_id}"])).toBe(ids[0]!);

      const r = await attach(rig, ["--worker", "eng-1", "--run", rig.runId, "--json"], {
        PIFLEET_TMUX_SOCKET: socket,
      });
      if (r.code !== 0) {
        // Surface the real reason rather than an opaque exit code.
        expect(`${r.stdout}${r.stderr}`).toBe("");
      }
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({
        worker: "eng-1",
        backend: "tmux",
        focused: true,
      });
      expect(await sh(["display-message", "-p", "-t", "fleet", "#{pane_id}"])).toBe(target);
    } finally {
      await Bun.spawn(["tmux", "-L", socket, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    }
  });
});
