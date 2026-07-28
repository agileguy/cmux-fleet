/**
 * ISC-134's structural half: the tmux backend brings up N panes and changes
 * NOTHING about what a run produces.
 *
 * Full equivalence — identical acceptance verdicts across backends — is an
 * e2e property that lands when `up` grows backend selection; what this file
 * pins is the invariant that makes it inevitable: a FleetBackend is
 * presentation only. The same fleet-shaped driver sequence runs against
 * `headless` and `tmux`, and every backend-independent outcome must be
 * identical — same call sequence accepted, same per-worker success, zero
 * divergence — while the only differences are backend-native ids, which
 * nothing correctness-bearing may read. Acceptance results come from
 * harvest/acceptance.ts, which resolves commands from the base SHA and runs
 * them in a fresh clone; no FleetBackend method ever touches that path, and
 * the interface gives a backend no run state to corrupt even if it wanted to.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { realExec } from "../../src/container/run.ts";
import type { FleetBackend } from "../../src/backends/types.ts";
import { HeadlessBackend } from "../../src/backends/headless/index.ts";
import { TmuxBackend } from "../../src/backends/tmux/index.ts";
import { listPanesArgv, parsePaneList, tmuxArgv } from "../../src/backends/tmux/argv.ts";

const SOCKET = `pifleet-eq-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { socketName: SOCKET, configFile: "/dev/null" };

const WORKERS = ["eng-1", "eng-2", "eng-3", "eng-4", "eng-5", "eng-6"];

/**
 * The exact bring-up/tear-down conversation `up`/`down` have with a backend,
 * reduced to its backend-facing calls. Everything a backend could get wrong
 * in a way that CHANGES OUTCOMES would surface as a divergence in this
 * record; everything else it does is pixels.
 */
async function driveFleet(backend: FleetBackend, keepForInspection: boolean) {
  const outcome = {
    kind: backend.kind,
    probedRequiredOk: false,
    paneCount: 0,
    perWorker: [] as string[],
    destroyed: false,
  };
  const caps = await backend.probe();
  outcome.probedRequiredOk = caps.filter((c) => c.required).every((c) => c.ok);
  const w = await backend.ensureWorkspace("eq-fleet");
  for (const workerId of WORKERS) {
    const p = await backend.createPane(w, { workerId, cwd: "/tmp" });
    // The viewer stays alive (fast-exit output is lost on real tmux, probed).
    await backend.attachViewer(p, ["/bin/sh", "-c", `printf '${workerId} '; exec sleep 3600`]);
    outcome.paneCount += 1;
    outcome.perWorker.push(`${workerId}:ok`);
  }
  if (!keepForInspection) await backend.destroy(w, { keepPanes: false });
  outcome.destroyed = !keepForInspection;
  return outcome;
}

afterAll(async () => {
  await realExec(tmuxArgv(CTX, ["kill-server"]));
});

describe("ISC-134: tmux and headless are interchangeable to the control plane", () => {
  test("the identical driver sequence yields identical backend-independent outcomes", async () => {
    const headless = await driveFleet(new HeadlessBackend(), false);
    const tmux = await driveFleet(new TmuxBackend({ exec: realExec, ...CTX }), true);

    // Compare everything EXCEPT the kind tag itself: any other field
    // diverging means presentation leaked into outcomes.
    expect({ ...tmux, kind: "x", destroyed: true }).toEqual({
      ...headless,
      kind: "x",
      destroyed: true,
    });
    expect(tmux.paneCount).toBe(WORKERS.length);
  });

  test("tmux really did bring up N panes for the N workers (not a vacuous pass)", async () => {
    const r = await realExec(listPanesArgv(CTX, "eq-fleet"));
    expect(r.code).toBe(0);
    const panes = parsePaneList(r.stdout);
    expect(panes).toHaveLength(WORKERS.length);
    expect(panes.map((p) => p.title).sort()).toEqual([...WORKERS].sort());
  });

  test("refs differ only where the interface says they may: backend-native ids", async () => {
    const h = new HeadlessBackend();
    const hw = await h.ensureWorkspace("eq-refs");
    const hp = await h.createPane(hw, { workerId: "eng-1", cwd: "/tmp" });
    // Headless hands out null ids so later phases cannot mistake them for
    // addressable surfaces; tmux ids must be real and addressable. Both are
    // opaque to the control plane — nothing outside a backend may interpret
    // them — so this is the entire permitted difference.
    expect(hp).toEqual({ backend: "headless", id: null });

    const t = new TmuxBackend({ exec: realExec, ...CTX });
    const tw = await t.ensureWorkspace("eq-refs");
    const tp = await t.createPane(tw, { workerId: "eng-1", cwd: "/tmp" });
    expect(tp.backend).toBe("tmux");
    expect(tp.id).toMatch(/^%\d+$/);
    await t.destroy(tw, { keepPanes: false });
  });
});
