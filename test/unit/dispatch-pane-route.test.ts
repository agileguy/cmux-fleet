/**
 * How a prompt reaches a `tui` worker (SRD §3.5, TUI spec item 10).
 *
 * The risk this phase carries is NOT the pane route — that route has no
 * behaviour to regress. It is a refactor that quietly routes both modes through
 * the new one, so the load-bearing test here is the one that proves an `rpc`
 * worker's dispatch still goes to the control socket.
 *
 * That is asserted WITHOUT a live supervisor by looking at which failure each
 * route produces on an empty run directory: an `rpc` worker fails trying to
 * open a socket that is not there (`WorkerUnreachableError`), a `tui` worker
 * fails looking for a pane record that is not there. The two are unmistakable
 * for one another, and either mutation of the router — always-rpc or
 * always-pane — turns exactly one of them red.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { LedgerWriter } from "../../src/run/ledger.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { renderPrompt } from "../../src/supervisor/index.ts";
import {
  UntypeablePromptError,
  WorkerUnreachableError,
  paneKeystrokes,
  planDispatch,
  sendTaskEnvelope,
  type PaneKeystroke,
} from "../../src/cli/commands/dispatch.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-08-31T00-00-00Z-disp";

/**
 * A launch record in one of the two shapes `launchPaneMode` accepts, built
 * through the real schema so a field rename cannot leave this fixture behind.
 *
 * The argv marks matter as much as the field: `launchPaneMode` requires the
 * recorded mode and the two rendered marks (`--mode rpc`, `-t`) to agree, and a
 * fixture that set only the field would pass through the `unknown` arm.
 */
function launch(mode: "rpc" | "tui", overrides: Record<string, unknown> = {}): WorkerLaunch {
  const argv =
    mode === "rpc"
      ? ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc", "--session-id", "s"]
      : ["docker", "run", "-i", "-t", "--rm", "img", "pi", "--session-id", "s"];
  return WorkerLaunchSchema.parse({
    kind: "container",
    argv,
    container: `pifleet-${RUN_ID}-w`,
    image: "img",
    pane_mode: mode,
    ...overrides,
  });
}

async function makeRun(): Promise<{ run: RunPaths; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-dispatch-route-"));
  bases.push(base);
  const root = join(base, "runs");
  const run = runPaths(RUN_ID, root);
  await mkdir(run.workersDir, { recursive: true });
  await mkdir(run.inboxDir, { recursive: true });
  await mkdir(run.ledgerDir, { recursive: true });
  return { run, root };
}

describe("planDispatch decides the control plane from the launch record", () => {
  test("an rpc worker takes the control socket", () => {
    expect(planDispatch(launch("rpc"))).toEqual({ kind: "rpc" });
  });

  test("a tui worker takes the pane", () => {
    expect(planDispatch(launch("tui"))).toEqual({ kind: "pane" });
  });

  /**
   * The correction that cost two ISC-81 integration tests on the abort path.
   *
   * An absent launch record is the `PIFLEET_PI_COMMAND` double. It has no
   * container — the premise that made `abort.ts` call it unabortable — AND a
   * live supervisor holding a real control socket, which is the half that
   * decides this question. The unit test that pinned the old behaviour asserted
   * the refusal and so pinned the defect; this one asserts the route.
   */
  test("no launch record is rpc — the PIFLEET_PI_COMMAND double has a socket", () => {
    expect(planDispatch(null)).toEqual({ kind: "rpc" });
  });

  test("a record whose field and argv marks disagree is refused, not guessed", () => {
    // Says tui, rendered without `-t`: a worker that cannot work, because it
    // was launched into a container with no pseudo-TTY and therefore no Pi TUI.
    const inconsistent = WorkerLaunchSchema.parse({
      kind: "container",
      argv: ["docker", "run", "-i", "--rm", "img", "pi", "--session-id", "s"],
      container: "c",
      image: "img",
      pane_mode: "tui",
    });
    const plan = planDispatch(inconsistent);
    expect(plan.kind).toBe("unavailable");
    if (plan.kind === "unavailable") expect(plan.reason).toMatch(/refusing to guess/);
  });
});

describe("paneKeystrokes turns a prompt into keystrokes without losing any of it", () => {
  const texts = (plan: readonly PaneKeystroke[]): string[] =>
    plan.flatMap((s) => (s.kind === "text" ? [s.text] : []));
  const keys = (plan: readonly PaneKeystroke[]): string[] =>
    plan.flatMap((s) => (s.kind === "key" ? [s.key] : []));

  test("one send per line, shift+enter between them, a single enter at the end", () => {
    const plan = paneKeystrokes("w", "alpha\nbeta\ngamma");
    expect(texts(plan)).toEqual(["alpha", "beta", "gamma"]);
    expect(keys(plan)).toEqual(["shift+enter", "shift+enter", "enter"]);
    // Exactly one submit. Two would be two turns, which is a different thing
    // from one prompt and the failure the whole mechanism exists to avoid.
    expect(keys(plan).filter((k) => k === "enter")).toHaveLength(1);
    expect(plan[plan.length - 1]).toEqual({ kind: "key", key: "enter" });
  });

  test("a blank line contributes its newline and no send", () => {
    // `cmux send` answers `Error: send requires text` on empty input, and a
    // blank line in markdown is a paragraph break rather than something typed.
    const plan = paneKeystrokes("w", "alpha\n\nbeta");
    expect(texts(plan)).toEqual(["alpha", "beta"]);
    expect(keys(plan)).toEqual(["shift+enter", "shift+enter", "enter"]);
  });

  /**
   * THE anti-truncation assertion, on the real renderer's real output.
   *
   * Replaying the plan the way a pane does — text steps concatenated, a newline
   * wherever a `shift+enter` went — must reproduce the prompt character for
   * character. A route that dropped, reordered or merged a line would still
   * "work" in the two shape tests above; only this one notices.
   */
  test("replaying the plan reconstructs the rendered prompt exactly", () => {
    const prompt = renderPrompt({
      title: "Do the thing",
      brief: "A brief\n\nwith paragraphs and a `code` span.",
      acceptance: ["it works", "it is proven"],
      task_id: "t-1",
      outbox: "/outbox/t-1",
      worker: "w-1",
      epoch: 0,
    });
    const plan = paneKeystrokes("w", prompt);
    let replay = "";
    for (const step of plan) {
      if (step.kind === "text") replay += step.text;
      else if (step.key === "shift+enter") replay += "\n";
    }
    expect(replay).toBe(prompt);
    // …and the prompt really is multi-line, so the assertion above is not
    // passing vacuously on a one-line string.
    expect(prompt.split("\n").length).toBeGreaterThan(5);
    // A rendered prompt carries `- ` acceptance bullets. Those used to refuse:
    // `assertCmuxText`'s leading-dash rule was what made this route unusable.
    expect(texts(plan)).toContain("- it works");
  });

  /**
   * All-or-nothing. A prompt with an untypeable line on page three must not
   * leave two pages of it half-typed in a person's pane — an operator who then
   * presses Enter submits a truncated brief this command has no record of.
   *
   * A REAL newline is not in this table and cannot be: it IS the line
   * separator, so it never appears within a line to be refused. The
   * control-character rule bites on the others — a bell here, and a literal TAB
   * below, which a fenced code block in a brief carries routinely.
   */
  test.each([
    ["the two-character escape cmux turns into Enter", "fine\nprint('a\\nb')\nalso fine"],
    ["a literal tab, which cmux would send as the Tab key", "fine\n\tindented line\nfine"],
    ["a bell character","fine\nwith a  bell\nfine"],
    ["an over-long line", `fine\n${"x".repeat(1025)}\nfine`],
  ])("refuses %s, and returns no partial plan", (_label, prompt) => {
    expect(() => paneKeystrokes("w-1", prompt)).toThrow(UntypeablePromptError);
    // The refusal names the LINE, because "the prompt is untypeable" on a
    // 60-line brief is not something an operator can act on.
    expect(() => paneKeystrokes("w-1", prompt)).toThrow(/line 2 of the rendered prompt/);
    expect(() => paneKeystrokes("w-1", prompt)).toThrow(/Nothing was sent/);
  });
});

describe("sendTaskEnvelope routes by pane mode", () => {
  const partial = { title: "t", brief: "b", acceptance: [] as string[] };

  async function dispatchTo(mode: "rpc" | "tui" | "absent"): Promise<unknown> {
    const { run } = await makeRun();
    const worker = "w-1";
    const wp = workerPaths(run, worker);
    await mkdir(wp.dir, { recursive: true });
    if (mode !== "absent") await writeJsonAtomic(wp.launchJson, launch(mode));
    const ledger = new LedgerWriter(run, "test");
    return sendTaskEnvelope({
      run,
      worker,
      taskId: "t-1",
      partial,
      attemptId: "a-1",
      requestedEpoch: null,
      ledger,
    }).then(
      (ok) => ok,
      (err: unknown) => err,
    );
  }

  /**
   * THE regression probe for this phase. An `rpc` worker must still reach for
   * the control socket, and `WorkerUnreachableError` is the proof that it did:
   * only the socket path can raise it.
   */
  test("an rpc worker still goes to the control socket", async () => {
    expect(await dispatchTo("rpc")).toBeInstanceOf(WorkerUnreachableError);
  });

  test("a worker with no launch record still goes to the control socket", async () => {
    expect(await dispatchTo("absent")).toBeInstanceOf(WorkerUnreachableError);
  });

  /**
   * A `tui` worker must NOT reach the socket. It fails on the pane instead —
   * here for want of a presentation record, which is a message the socket path
   * can never produce.
   */
  test("a tui worker goes to the pane and never opens the socket", async () => {
    const err = await dispatchTo("tui");
    expect(err).not.toBeInstanceOf(WorkerUnreachableError);
    expect(String(err)).toMatch(/pane_mode: tui/);
    expect(String(err)).toMatch(/no presentation record/);
  });
});

/**
 * Defect A — the pane route ran its whole life with no provenance.
 *
 * `writeTaskPolicy` had three call sites when this was found. Two of them
 * write `(<none>, 0)`: `materialize.ts` when the worker directory is built, and
 * the supervisor when a task settles. The one real write is inside the RPC
 * `dispatch` handler, which this route deliberately never reaches — so every
 * gated cloud verb a pane-dispatched worker ran was ledgered against no task.
 * Confirmed 2026-09-02 by reading `/policy/task` out of a live adopted-terminal
 * container mid-task: `<none>\n0\n`.
 *
 * ## Why the probe drives a FAILING send
 *
 * The criterion is an ORDERING — the write lands before the first byte — and an
 * ordering cannot be proved by a test that only looks at the end state. Making
 * the send fail at step 1 splits the two: the file is read AFTER `sendViaPane`
 * has thrown, so it can only hold the task id if the write happened first. Move
 * the `writeTaskPolicy` call below the send loop and this goes red, which is
 * the mutation the criterion is actually about.
 *
 * `tmux` with a pane id no server has is what makes the send fail, and it fails
 * whether or not tmux is installed: absent, the spawn fails; present, the pane
 * does not exist. NO PTY, no Docker, no live backend — the property ISC-377,
 * ISC-378, ISC-379 and ISC-387 all lack and are `[~]` for.
 */
describe("the pane route writes task provenance before it types", () => {
  async function paneDispatchAgainstADeadSurface(): Promise<{
    wp: ReturnType<typeof workerPaths>;
    err: unknown;
  }> {
    const { run } = await makeRun();
    const worker = "w-1";
    const wp = workerPaths(run, worker);
    await mkdir(wp.dir, { recursive: true });
    await writeJsonAtomic(wp.launchJson, launch("tui"));
    await writeJsonAtomic(wp.presentationJson, {
      schema: "pifleet.presentation/v1",
      worker,
      backend: "tmux",
      workspace_ref: null,
      // Well-formed for `assertTmuxValue` and belonging to no server.
      surface_ref: "%999999",
      window_ref: null,
      adopted_terminal: false,
    });
    const ledger = new LedgerWriter(run, "test");
    const err = await sendTaskEnvelope({
      run,
      worker,
      taskId: "t-provenance",
      partial: { title: "t", brief: "b", acceptance: [] as string[] },
      attemptId: "a-1",
      requestedEpoch: null,
      ledger,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    return { wp, err };
  }

  test("the task id is on disk even though not one byte was typed", async () => {
    const { wp, err } = await paneDispatchAgainstADeadSurface();
    // The send really did fail — without this the assertion below could pass
    // on a route that typed the whole prompt successfully, which is a
    // different (and untested) claim.
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/pane dispatch failed at step 1/);

    const written = await Bun.file(wp.taskPolicy).text();
    expect(written).toBe("t-provenance\n0\n");
  });

  /**
   * The control. `<none>` is `verbgate`'s own spelling of "no task is live",
   * and it is what this file held on this route for the whole of ISC-380's
   * life — so a test asserting only "the file exists" would have passed then
   * too.
   */
  test("and it is not the <none> the file used to keep", async () => {
    const { wp } = await paneDispatchAgainstADeadSurface();
    expect(await Bun.file(wp.taskPolicy).text()).not.toContain("<none>");
  });

  /**
   * 0 verbatim, and asserted rather than incidental: the prompt, the inbox
   * record and this file must carry the SAME epoch or `harvest/outbox.ts`
   * refuses a correct result as stale. This route allocates nothing, so all
   * three are the schema placeholder — and the day one of them stops being 0,
   * this is where the disagreement shows up first.
   */
  test("the epoch line matches the placeholder the envelope carries", async () => {
    const { wp } = await paneDispatchAgainstADeadSurface();
    expect((await Bun.file(wp.taskPolicy).text()).split("\n")[1]).toBe("0");
  });
});
