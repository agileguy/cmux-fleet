/**
 * Pure logic of the control verbs, pinned without a filesystem or a socket.
 *
 * The integration suites prove ISC-80/81 against a real supervisor; these
 * tests pin the decisions that pick between exit codes and between writing
 * and not writing — the branches where a one-line regression flips a 2 into
 * a 6 or brands an unattended run attended. Each case names the wrong
 * behaviour it fails under, per the rule that a test which would still pass
 * with the feature deleted asserts nothing.
 */

import { describe, expect, test } from "bun:test";
import { AttendedRecordSchema, EXIT, WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { CliError } from "../../src/cli/index.ts";
import { classifyWorker } from "../../src/cli/worker-preflight.ts";
import { nextAttendedRecord, resolveMessage } from "../../src/cli/commands/steer.ts";
import { execArgv } from "../../src/cli/commands/exec.ts";

function state(overrides: Partial<WorkerState> = {}): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker: "eng-1",
    run_id: "run-x",
    pid: 4242,
    pgid: 4242,
    started_at: new Date().toISOString(),
    phase: "idle",
    epoch: 1,
    ...overrides,
  });
}

describe("resolveMessage — one message from two spellings", () => {
  test("the --message flag alone is accepted", () => {
    expect(resolveMessage(undefined, "focus on the edge case")).toBe("focus on the edge case");
  });

  test("the positional alone is accepted (the SRD §10 spelling)", () => {
    expect(resolveMessage("focus on the edge case", undefined)).toBe("focus on the edge case");
  });

  test("both given and identical is accepted", () => {
    expect(resolveMessage("same", "same")).toBe("same");
  });

  test("both given and DIFFERENT is refused — neither may be silently dropped", () => {
    // Were either preferred, the other is a message the operator typed and
    // believes was delivered.
    expect(() => resolveMessage("one", "two")).toThrow(CliError);
    try {
      resolveMessage("one", "two");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  test.each([[undefined], [""], ["   "]])("missing or blank message (%p) is USAGE", (bad) => {
    expect(() => resolveMessage(bad as string | undefined, undefined)).toThrow(CliError);
    try {
      resolveMessage(bad as string | undefined, undefined);
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
});

describe("classifyWorker — the 2-vs-6 boundary", () => {
  test("no state file at all is unknown (exit USAGE, not WORKER_DIED)", () => {
    // A typo'd --worker must not read as a dead fleet member.
    expect(classifyWorker(null, null)).toBe("unknown");
  });

  test("recorded phase dead is dead even when a process answers to the pid", () => {
    // The pid may have been reused since the child exit was recorded; the
    // state file's word outranks a number the OS recycles.
    expect(classifyWorker(state({ phase: "dead" }), "somestart")).toBe("dead");
  });

  test("a vanished pid is dead even when the state file still says busy", () => {
    // A SIGKILL'd supervisor writes nothing on the way down — its last state
    // says busy forever, and only the OS knows better.
    expect(classifyWorker(state({ phase: "busy" }), null)).toBe("dead");
  });

  test("state present and process present is alive", () => {
    expect(classifyWorker(state({ phase: "busy" }), "somestart")).toBe("alive");
  });
});

describe("nextAttendedRecord — write-once, never reset, never stolen", () => {
  const NOW = "2026-07-27T12:00:00.000Z";

  test("no record: creates a viewer record marking a point intervention", () => {
    const rec = nextAttendedRecord(null, "eng-1", NOW);
    expect(rec).not.toBeNull();
    expect(rec?.mode).toBe("viewer");
    expect(rec?.worker).toBe("eng-1");
    expect(rec?.entered_at).toBe(NOW);
    // A steer is a point event, not a possession of the pane: left_at is
    // set, so the record never reads as "operator still driving".
    expect(rec?.left_at).toBe(NOW);
    // rpc-mode steering voids nothing in the SRD §3.5 table.
    expect(rec?.voided).toEqual([]);
    // And it round-trips the seam schema, or `report` cannot read it.
    expect(AttendedRecordSchema.parse(rec)).toEqual(rec!);
  });

  test("an existing viewer record advances left_at and preserves everything else", () => {
    const existing = AttendedRecordSchema.parse({
      schema: "pifleet.attended/v1",
      worker: "eng-1",
      mode: "viewer",
      entered_at: "2026-07-27T09:00:00.000Z",
      left_at: "2026-07-27T09:00:00.000Z",
      voided: [{ isc: "ISC-87", because: "left by an earlier writer" }],
    });
    const rec = nextAttendedRecord(existing, "eng-1", NOW);
    expect(rec?.entered_at).toBe("2026-07-27T09:00:00.000Z"); // first touch survives
    expect(rec?.left_at).toBe(NOW);
    expect(rec?.voided).toEqual(existing.voided); // another writer's rows survive
  });

  test("a live tui record is left ENTIRELY alone", () => {
    // left_at:null means an operator is driving the pane right now. A steer
    // that "updated" it would record the pane as handed back when it wasn't.
    const tui = AttendedRecordSchema.parse({
      schema: "pifleet.attended/v1",
      worker: "eng-1",
      mode: "tui",
      entered_at: "2026-07-27T09:00:00.000Z",
      left_at: null,
      voided: [],
    });
    expect(nextAttendedRecord(tui, "eng-1", NOW)).toBeNull();
  });
});

describe("execArgv — the container/host branch", () => {
  test("a recorded container gets docker exec against its name", () => {
    const { argv, ran_in } = execArgv({ name: "pifleet-run-eng-1" }, ["ls", "-la"]);
    expect(argv).toEqual(["docker", "exec", "pifleet-run-eng-1", "ls", "-la"]);
    expect(ran_in).toBe("container");
  });

  test("no container runs the command verbatim on the host, and SAYS so", () => {
    // The label is the safety feature: without it the operator believes
    // they are inside the container's mount table and egress policy.
    const { argv, ran_in } = execArgv(null, ["sh", "-c", "echo hi"]);
    expect(argv).toEqual(["sh", "-c", "echo hi"]);
    expect(ran_in).toBe("host");
  });

  test("the input command array is not aliased into the result", () => {
    const cmd = ["echo", "x"];
    const { argv } = execArgv(null, cmd);
    argv.push("mutated");
    expect(cmd).toEqual(["echo", "x"]);
  });
});
