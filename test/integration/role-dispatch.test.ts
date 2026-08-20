/**
 * A task's `role` reaches the worker (SRD §14.2).
 *
 * The scheduler and the role subsystem were built in parallel, and each was
 * complete: `TaskSpec.role` was validated, carried through the DAG, and
 * written into the schedule snapshot, while `src/roles/` resolved every role
 * to a briefing and composed it with a brief. Nothing called across. The role
 * type-checked end to end and reached no container, so `report` would show a
 * task running as `verifier` while the worker ran a generic one.
 *
 * That is precisely the failure §14.2 is designed around: the investigator
 * finds it, the sre remediates, and the verifier CONFIRMS — a verifier that
 * never learned it was a verifier is an independent check in name only, and
 * the run still looks correct from the outside.
 *
 * So this asserts on the ENVELOPE THAT LANDS IN THE INBOX — the actual text a
 * worker receives. Asserting that `composeBrief` works, or that the snapshot
 * records a role, is exactly what passed while the wiring was missing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, TaskEnvelopeSchema } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import { BRIEFINGS } from "../../src/roles/index.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIO = join(ROOT_URL, "test/fixtures/scenarios/happy.json");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

const TASK_BRIEF = "Confirm the node rejoined the cluster and stayed Ready for five minutes.";

describe("a role composes into the brief the worker receives", () => {
  test("the dispatched envelope carries the verifier briefing and the task's own brief", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-role-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "runs");
    const env = {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${SCENARIO}`,
    };
    const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const p = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code: await p.exited, stdout, stderr };
    };

    const up = await cli(["up", "--workers", "w1", "--backend", "headless", "--json"]);
    expect(up.code, `up stderr: ${up.stderr.slice(0, 500)}`).toBe(EXIT.SUCCESS);
    const runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
    cleanups.push(async () => {
      await cli(["down", "--run", runId, "--json"]);
    });

    const listPath = join(base, "roles.json");
    await writeFile(
      listPath,
      JSON.stringify({
        schema: "pifleet.tasklist/v1",
        tasks: [{ id: "verify-1", title: "Verify the fix", brief: TASK_BRIEF, role: "verifier" }],
      }),
      "utf8",
    );

    const auto = await cli(["dispatch", "--auto", "--tasks", listPath, "--run", runId, "--json"]);
    expect(auto.code, `dispatch stderr: ${auto.stderr.slice(0, 500)}`).toBe(EXIT.SUCCESS);

    const run = runPaths(runId, root);
    const inbox = (await readdir(run.inboxDir)).filter((f) => f.endsWith(".json"));
    expect(inbox).toHaveLength(1);
    const envelope = TaskEnvelopeSchema.parse(
      JSON.parse(await Bun.file(join(run.inboxDir, inbox[0]!)).text()),
    );

    // The briefing reached the worker...
    expect(envelope.brief).toContain(BRIEFINGS.verifier);
    // ...and did not replace what the author actually asked for.
    expect(envelope.brief).toContain(TASK_BRIEF);
    // Frame first: a verifier has to know it is a verifier before it reads
    // what to verify.
    expect(envelope.brief.indexOf(BRIEFINGS.verifier)).toBeLessThan(
      envelope.brief.indexOf(TASK_BRIEF),
    );
    // Independence is the whole point — the verifier briefing must not be the
    // sre's, which would make the check a self-assessment.
    expect(envelope.brief).not.toContain(BRIEFINGS.sre);
  }, cliBudget(4));

  test("a task with no role is dispatched with exactly the brief its author wrote", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-norole-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "runs");
    const env = {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${SCENARIO}`,
    };
    const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const p = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code: await p.exited, stdout, stderr };
    };

    const up = await cli(["up", "--workers", "w1", "--backend", "headless", "--json"]);
    expect(up.code).toBe(EXIT.SUCCESS);
    const runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
    cleanups.push(async () => {
      await cli(["down", "--run", runId, "--json"]);
    });

    const listPath = join(base, "norole.json");
    await writeFile(
      listPath,
      JSON.stringify({
        schema: "pifleet.tasklist/v1",
        tasks: [{ id: "plain-1", title: "Plain", brief: TASK_BRIEF }],
      }),
      "utf8",
    );
    const auto = await cli(["dispatch", "--auto", "--tasks", listPath, "--run", runId, "--json"]);
    expect(auto.code, `dispatch stderr: ${auto.stderr.slice(0, 500)}`).toBe(EXIT.SUCCESS);

    const run = runPaths(runId, root);
    const inbox = (await readdir(run.inboxDir)).filter((f) => f.endsWith(".json"));
    const envelope = TaskEnvelopeSchema.parse(
      JSON.parse(await Bun.file(join(run.inboxDir, inbox[0]!)).text()),
    );
    // The positive control for the test above: composition must be opt-in, or
    // every role-less task silently grows a frame its author never wrote.
    expect(envelope.brief).toBe(TASK_BRIEF);
  }, cliBudget(4));
});
