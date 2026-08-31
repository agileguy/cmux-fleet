/**
 * `pifleet dispatch` at a `pane_mode: tui` worker, through the real CLI and a
 * real backend — the probe ISC-380 named as its own closing condition.
 *
 * ## What was missing, and why the existing tests could not supply it
 *
 * ISC-380 was filed `[~]` with three seams each proved and the JOINS between
 * them unproved: `dispatch-pane-route.test.ts` asserts the ROUTE (pane, not
 * socket), `tui-guards.test.ts` asserts the PLAN (one send per line, the right
 * keys between them), and `cmux-client.test.ts` asserts the ARGV each builder
 * returns. Nothing asserted that `sendViaPane` calls those builders, and
 * nothing asserted the two fields an operator actually reads: `via: "pane"`
 * and `epoch: null`.
 *
 * The live run is what made that gap concrete rather than theoretical. Both
 * defects it found (ISC-387) lived in exactly this join: the plan was correct
 * and the argv builder was correct, and the prompt still arrived wrong.
 *
 * ## Why a fake `tmux` on PATH, and not a fake backend
 *
 * `loadBackend` validates its kind against a literal allowlist before building
 * an import specifier, because an unchecked value there is a load-anything
 * primitive (ISC-137). Adding a `fake` kind to reach it from a test would
 * widen a security boundary for a test's convenience, so this does the
 * opposite: it uses the REAL tmux backend and replaces the BINARY. Everything
 * between `dispatch` and `execve` is production code — the route, the render,
 * the plan, the backend, the argv builders — and the recorder captures what a
 * terminal would actually have been handed.
 *
 * The recorder writes one line per invocation with a single `printf`, and
 * writes it to a `.part` file renamed into place, for the reason
 * `container-launch.test.ts` records: a reader that can see a prefix of a file
 * is a test that fails for a reason that has nothing to do with its subject.
 */

import { spawnCli } from "../support/spawn-cli.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLaunchSchema } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-08-31T00-00-00Z-disp";
const SURFACE = "%9";
const TASK_ID = "t-join";

/**
 * ASCII record separator, the byte the recorder puts between arguments.
 *
 * Spelled as an escape rather than pasted, because a literal control character
 * in a source file is invisible to a reviewer and does not survive every tool
 * that touches the file — it silently became an empty string once already
 * while this test was being written, which made `split` produce one character
 * per element and the failure looked like a product defect.
 */
const RS = "\x1e";

interface Rig {
  root: string;
  binDir: string;
  recording: string;
  taskPath: string;
  ledgerDir: string;
  inboxPath: string;
}

/**
 * A fake `tmux` that records every invocation and exits 0.
 *
 * Exit 0 for EVERY subcommand is deliberate: the backend's own reachability
 * checks (`-V`, `has-session`) must be satisfiable, and a recorder that failed
 * one of them would test the error path rather than the dispatch path.
 */
async function plantTmux(dir: string): Promise<{ binDir: string; recording: string }> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const recording = join(dir, "tmux-argv.txt");
  const bin = join(binDir, "tmux");
  await writeFile(
    bin,
    `#!/bin/sh\n` +
      // One line per invocation, arguments separated by a byte that cannot
      // appear in a tmux argument the fleet sends (the text guard refuses
      // control characters), so the reader can split without ambiguity.
      //
      // A single `printf` appending to an O_APPEND fd, and no `.part` rename:
      // the first version renamed a temp file into place per invocation, which
      // meant the recording only ever held the LAST call. Every earlier
      // send-keys was silently discarded and the test still saw a plausible
      // tail, which is the failure shape a recorder must not have. There is no
      // partial-read hazard to design around here, because nothing reads the
      // file until the CLI has exited.
      `printf '%s\\n' "$(printf '%s\\036' "$@")" >> ${recording}\n` +
      // `-V` is the version probe; anything else just succeeds silently.
      `case "$1" in -V) echo "tmux 3.6a" ;; esac\n` +
      `exit 0\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return { binDir, recording };
}

async function makeRun(mode: "rpc" | "tui"): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-disp-"));
  bases.push(base);
  const root = join(base, "runs");
  const run = runPaths(RUN_ID, root);
  await mkdir(run.workersDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: RUN_ID }), "utf8");

  const wp = workerPaths(run, "eng-1");
  await mkdir(wp.dir, { recursive: true });
  await writeFile(
    wp.presentationJson,
    JSON.stringify({
      schema: "pifleet.presentation/v1",
      worker: "eng-1",
      backend: "tmux",
      workspace_ref: "pifleet-disp",
      surface_ref: SURFACE,
      window_ref: null,
    }),
    "utf8",
  );

  const argv =
    mode === "rpc"
      ? ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc"]
      : ["docker", "run", "-i", "-t", "--rm", "img", "pi"];
  await writeFile(
    wp.launchJson,
    JSON.stringify(
      WorkerLaunchSchema.parse({
        kind: "container",
        argv,
        container: `pifleet-${RUN_ID}-eng-1`,
        image: "img",
        pane_mode: mode,
      }),
    ),
    "utf8",
  );

  const taskPath = join(base, "task.json");
  await writeFile(
    taskPath,
    JSON.stringify({
      task_id: TASK_ID,
      title: "Say hello to the pane",
      acceptance: ["it said hello"],
    }),
    "utf8",
  );

  const { binDir, recording } = await plantTmux(base);
  return {
    root,
    binDir,
    recording,
    taskPath,
    // The ledger is SHARDED per writer, so the test reads the directory rather
    // than a file: `cli-dispatch-<pid>.jsonl` is not a name a test can predict.
    ledgerDir: run.ledgerDir,
    inboxPath: join(run.inboxDir, `${TASK_ID}.json`),
  };
}

function dispatch(rig: Rig): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(["dispatch", "--run", RUN_ID, "--worker", "eng-1", "--task", rig.taskPath, "--json"], {
    env: {
      PATH: `${rig.binDir}:${process.env["PATH"] ?? ""}`,
      PIFLEET_RUNS_DIR: rig.root,
    },
    inheritEnv: false,
  });
}

/** Every recorded invocation, arguments split back out. */
async function invocations(recording: string): Promise<string[][]> {
  const text = await readFile(recording, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split(RS).filter((a) => a.length > 0));
}

describe("dispatch at a pane_mode: tui worker reaches a real backend (ISC-380's join)", () => {
  /**
   * The criterion in one test: the prompt the renderer produced is the text a
   * terminal was handed, in order, and the outcome says it allocated nothing.
   *
   * Fails if: `sendViaPane` stops calling the argv builders; the backend's
   * `sendText` loses `-l` (tmux would then interpret words like "Enter" as key
   * names — the ISC-387 failure mode, one layer down); a key stops being
   * translated; the plan's order changes; or the outcome starts reporting an
   * epoch it did not allocate.
   */
  test(
    "the typed bytes reconstruct the prompt, and the outcome reports via=pane epoch=null",
    async () => {
      const rig = await makeRun("tui");
      const res = await dispatch(rig);
      expect(res.code, `dispatch failed: ${res.stderr}`).toBe(0);

      const out = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
      expect(out["accepted"]).toBe(true);
      expect(out["via"]).toBe("pane");
      // NOT 0. `null` is this route saying no fence exists; a 0 would read as
      // one, and every re-dispatch guard downstream keys off that difference.
      expect(out["epoch"]).toBeNull();

      const calls = await invocations(rig.recording);
      const sends = calls.filter((c) => c[0] === "send-keys");
      expect(sends.length, "no send-keys reached the backend at all").toBeGreaterThan(0);

      // Text steps carry `-l --`; key steps carry a tmux key NAME and no `-l`.
      const typed: string[] = [];
      const keys: string[] = [];
      for (const c of sends) {
        expect(c).toContain(SURFACE);
        if (c.includes("-l")) typed.push(c[c.length - 1]!);
        else keys.push(c[c.length - 1]!);
      }

      // The submit key is last, and the separators are the translated name —
      // NOT the fleet's own spelling, which tmux would have typed as text.
      expect(keys[keys.length - 1]).toBe("Enter");
      expect(keys.slice(0, -1).every((k) => k === "S-Enter")).toBe(true);
      expect(keys).not.toContain("shift+enter");

      // And the lines that arrived are the prompt the renderer produced: the
      // task id and the outbox path are what let the worker bind its result,
      // and a route that dropped them would still "send something".
      const joined = typed.join("\n");
      expect(joined).toContain(TASK_ID);
      expect(joined).toContain(`/outbox/${TASK_ID}`);
      expect(joined).toContain("Say hello to the pane");
    },
    cliBudget(1),
  );

  /**
   * The ledger's own account of the same dispatch.
   *
   * `epoch` is OMITTED rather than set to 0, and that is the assertion: a
   * reader that sees the field expects a fence. `toBeUndefined` on a key that
   * was never written is weak on its own, so the sibling fields are checked
   * too — an event missing everything would otherwise pass this.
   */
  test(
    "the ledger records via=pane and omits epoch entirely",
    async () => {
      const rig = await makeRun("tui");
      expect((await dispatch(rig)).code).toBe(0);

      const lines: Array<Record<string, unknown>> = [];
      for (const name of await readdir(rig.ledgerDir)) {
        const text = await readFile(join(rig.ledgerDir, name), "utf8");
        for (const l of text.split("\n")) {
          if (l.trim().length > 0) lines.push(JSON.parse(l) as Record<string, unknown>);
        }
      }
      const dispatched = lines.filter((e) => e["event"] === "dispatched");
      expect(dispatched.length).toBe(1);

      const detail = dispatched[0]!["detail"] as Record<string, unknown>;
      expect(detail["via"]).toBe("pane");
      expect(detail["backend"]).toBe("tmux");
      expect(detail["surface"]).toBe(SURFACE);
      expect(dispatched[0]!["epoch"]).toBeUndefined();
      expect(detail["epoch"]).toBeUndefined();

      // The durable inbox record still lands — the pane route is a different
      // plane, not a different contract.
      const inbox = JSON.parse(await readFile(rig.inboxPath, "utf8")) as Record<string, unknown>;
      expect(inbox["task_id"]).toBe(TASK_ID);
    },
    cliBudget(1),
  );

  /**
   * THE LOAD-BEARING CONTROL, and it is the rpc arm for the same reason
   * ISC-380's unit pair is: a router mutated to "always pane" would satisfy
   * every assertion above.
   *
   * One variable differs from the tui rig — `pane_mode` and the argv marks that
   * must agree with it — and the observable flips completely: an rpc worker's
   * dispatch goes to a control socket that is not there and fails, having
   * touched no backend at all.
   */
  test(
    "an rpc worker in the same rig never reaches the backend",
    async () => {
      const rig = await makeRun("rpc");
      const res = await dispatch(rig);
      expect(res.code, "an rpc dispatch with no supervisor should not succeed").not.toBe(0);
      expect(await invocations(rig.recording)).toEqual([]);
    },
    cliBudget(1),
  );
});
