/**
 * `pifleet tui` against a `pane_mode: tui` worker, through the real CLI
 * (TUI spec item 11).
 *
 * The unit suite proves the pieces; this proves the COMMAND, because the whole
 * decision lives in its action handler and a test on the exported helpers would
 * pass whether or not they were wired in.
 *
 * The rig differs between arms in ONE variable — the `pane_mode` on
 * `launch.json`, with the argv marks that must agree with it — and the two arms
 * diverge on every observable: the tui worker's entry succeeds without ever
 * reaching the backend, and the rpc worker's entry reaches a tmux that is not
 * there and fails. That divergence is the evidence that the route is read from
 * the record rather than assumed.
 */

import { spawnCli } from "../support/spawn-cli.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, WorkerLaunchSchema } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-08-31T00-00-00Z-tuic";

interface Rig {
  root: string;
  attendedPath: string;
}

/**
 * One worker, presentation naming a tmux surface that does not exist, and a
 * launch record in the requested shape.
 *
 * The surface is deliberately unreachable: a `pane_mode: tui` entry must not
 * touch it, so an arm that succeeds is an arm that did not respawn.
 */
async function makeRun(mode: "rpc" | "tui"): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-cmd-"));
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
      workspace_ref: "pifleet-nosuch",
      surface_ref: "%99",
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
  return { root, attendedPath: wp.attendedJson };
}

function tui(rig: Rig, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(["tui", ...args], {
    env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: rig.root },
    inheritEnv: false,
  });
}

describe("pifleet tui on a pane_mode: tui worker", () => {
  /**
   * Entry succeeds and records, without reaching the backend at all — the
   * surface in the rig does not exist, so an arm that respawned would fail.
   */
  test("records the run as attended and does not touch the pane", async () => {
    const rig = await makeRun("tui");
    const r = await tui(rig, ["--worker", "eng-1", "--run", RUN_ID]);
    expect(r.code).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/pane_mode: tui/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/pane was NOT changed/);

    // The invariant: the record is on disk even though nothing was respawned.
    const record = JSON.parse(await readFile(rig.attendedPath, "utf8")) as {
      mode: string;
      left_at: string | null;
      voided: unknown[];
    };
    expect(record.mode).toBe("tui");
    expect(record.left_at).toBeNull();
    expect(record.voided.length).toBeGreaterThan(0);
  }, cliBudget(1));

  /**
   * The record carries the MODE's voided table, not just the attended one
   * (TUI spec item 14).
   *
   * `report` prints `record.voided` verbatim, so this file is the only place
   * where "the report says which guarantees the mode gave up" is a fact about
   * the shipped command rather than about an exported constant. A unit test on
   * `voidedFor` proves the table; only this proves it was reached.
   *
   * Asserted by CONTENT and not by length. A count would pass against a build
   * that stamped ten copies of the same row, and the ids below are chosen as
   * the ones an operator acts on differently: ISC-85 is "a re-dispatch runs the
   * task twice", ISC-95 is "the session file was found by search", ISC-106 is
   * the attended-mode audit-trail row that must NOT be dropped by the merge.
   */
  test("the record carries the mode's voided rows, not only the attended ones", async () => {
    const rig = await makeRun("tui");
    expect((await tui(rig, ["--worker", "eng-1", "--run", RUN_ID])).code).toBe(0);
    const record = JSON.parse(await readFile(rig.attendedPath, "utf8")) as {
      voided: { isc: string; because: string }[];
    };
    const ids = record.voided.map((v) => v.isc);

    // Mode rows: true from the moment `up` created the container.
    expect(ids).toContain("ISC-85");
    expect(ids).toContain("ISC-95");
    // Attended rows survive the merge — a tui pane is a person's by
    // construction, so dropping these would UNDER-report the run.
    expect(ids).toContain("ISC-106");
    // No criterion twice, or an operator reads the same warning under two
    // contradictory sentences.
    expect(new Set(ids).size).toBe(ids.length);

    // The sentence, not just the id: the mode's reason is the one shown for a
    // criterion both tables name (ISC-87 is completion detection).
    const completion = record.voided.find((v) => v.isc === "ISC-87")!.because;
    expect(completion).toMatch(/transcript/i);
  }, cliBudget(1));

  /**
   * The CONTROL arm. Same rig, same unreachable surface, `pane_mode: rpc` — and
   * it fails, because an rpc worker's entry DOES respawn the pane. Without this
   * arm the test above would also pass for a build that had simply stopped
   * respawning anything.
   */
  test("an rpc worker still respawns its pane, and so fails on an absent one", async () => {
    const rig = await makeRun("rpc");
    const r = await tui(rig, ["--worker", "eng-1", "--run", RUN_ID]);
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/pane was NOT changed/);

    /**
     * …and its record carries the ATTENDED table only (TUI spec item 14).
     *
     * The control arm for the voided-table assertion above, and the reason it
     * is here rather than in its own test: this rig already differs from the
     * tui rig in exactly one variable. Without it, a `voidedFor` that ignored
     * its argument and always merged would satisfy every positive assertion in
     * this file while telling an operator that an ordinary rpc worker had lost
     * its epochs, its ack and its abort.
     *
     * The record exists despite the failure BY DESIGN: `enterTui` writes before
     * it respawns, so a failed respawn overclaims attendance rather than losing
     * it. That ordering is `attended/mode.ts`'s, and reading the file here is
     * what makes it observable from outside.
     */
    const record = JSON.parse(await readFile(rig.attendedPath, "utf8")) as {
      voided: { isc: string }[];
    };
    const ids = record.voided.map((v) => v.isc);
    expect(ids).toContain("ISC-106"); // attended rows: present, as always
    expect(ids).not.toContain("ISC-85"); // mode rows: absent, because rpc has epochs
    expect(ids).not.toContain("ISC-95"); // …and records its session path verbatim
  }, cliBudget(1));

  /**
   * `--leave` is refused, and the refusal says what an operator should do
   * instead. Handing the pane back would detach the only terminal the container
   * has; stamping `left_at` would assert a person stopped driving a pane they
   * are still attached to.
   */
  test("--leave is refused with a reason, and writes no left_at", async () => {
    const rig = await makeRun("tui");
    // Enter first, so the refusal cannot be passing merely because there is no
    // record to leave — that is `leaveTui`'s own guard, a different one.
    expect((await tui(rig, ["--worker", "eng-1", "--run", RUN_ID])).code).toBe(0);

    const r = await tui(rig, ["--worker", "eng-1", "--run", RUN_ID, "--leave"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(`${r.stdout}${r.stderr}`).toMatch(/nothing to hand back/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/pifleet abort --worker eng-1/);

    const record = JSON.parse(await readFile(rig.attendedPath, "utf8")) as {
      left_at: string | null;
    };
    expect(record.left_at).toBeNull();
  }, cliBudget(2));

  /**
   * A launch record whose field and argv marks disagree names a worker that
   * cannot work. Refusing puts the disagreement in the operator's message
   * rather than picking a pane behaviour at random.
   */
  test("a record whose pane mode and argv disagree is refused", async () => {
    const rig = await makeRun("tui");
    const run = runPaths(RUN_ID, rig.root);
    const wp = workerPaths(run, "eng-1");
    await writeFile(
      wp.launchJson,
      JSON.stringify(
        WorkerLaunchSchema.parse({
          kind: "container",
          // Says tui; rendered with no `-t`, so there is no pseudo-TTY.
          argv: ["docker", "run", "-i", "--rm", "img", "pi"],
          container: "c",
          image: "img",
          pane_mode: "tui",
        }),
      ),
      "utf8",
    );
    const r = await tui(rig, ["--worker", "eng-1", "--run", RUN_ID]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(`${r.stdout}${r.stderr}`).toMatch(/refusing to guess/);
  }, cliBudget(1));
});
