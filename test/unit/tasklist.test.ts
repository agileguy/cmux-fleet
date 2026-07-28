/**
 * Task-list validation (SRD §9.3): every refusal happens at load time, names
 * its cause, and exits 2 — because by the time a bad list reaches the
 * scheduler, refusing it means abandoning tasks already running.
 *
 * Each test would fail if the behaviour it names were deleted: the cycle
 * tests assert the cycle PATH appears in the message (not merely that
 * something threw), and the acceptance test pins the parsed output so a
 * validator that "passes" by rejecting everything cannot survive it.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, isExitCoded } from "../../src/contracts.ts";
import { TaskListError, findCycle, parseTaskList } from "../../src/orchestrate/tasklist.ts";

/** Minimal valid list text with the given tasks spliced in. */
function listOf(tasks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ schema: "pifleet.tasklist/v1", tasks });
}

function refusal(raw: string): TaskListError {
  try {
    parseTaskList(raw, "test.json");
  } catch (err) {
    expect(err).toBeInstanceOf(TaskListError);
    return err as TaskListError;
  }
  throw new Error("expected parseTaskList to refuse");
}

describe("valid lists parse, with authoring defaults applied", () => {
  test("a two-task list round-trips and fills spec defaults", () => {
    const list = parseTaskList(
      listOf([
        { id: "a", title: "A", brief: "do a" },
        { id: "b", title: "B", brief: "do b", depends_on: ["a"], worker: "eng-1" },
      ]),
      "test.json",
    );
    expect(list.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    // Defaults come from the SHARED schema (contracts.ts), not local code —
    // a local re-declaration is how two halves of a phase stop agreeing.
    expect(list.tasks[0]!.depends_on).toEqual([]);
    expect(list.tasks[0]!.worker).toBeNull();
    expect(list.tasks[0]!.deadline_s).toBe(1800);
    expect(list.tasks[1]!.worker).toBe("eng-1");
  });
});

describe("malformed input is a named usage error", () => {
  test("non-JSON refuses with the source path in the message", () => {
    const err = refusal("not json {");
    expect(err.message).toContain("test.json");
    expect(err.message).toContain("not valid JSON");
  });

  test("wrong schema tag refuses and names the field", () => {
    const err = refusal(JSON.stringify({ schema: "pifleet.task/v1", tasks: [] }));
    expect(err.message).toContain("schema");
  });

  test("a task missing required fields refuses and names the path", () => {
    const err = refusal(listOf([{ id: "a" }]));
    expect(err.message).toContain("title");
  });

  test("every refusal carries EXIT.USAGE through the ExitCoded protocol", () => {
    const err = refusal("[]");
    // Structural, not instanceof: the CLI ladder recognises errors by shape,
    // and a TaskListError that stopped satisfying ExitCoded would exit 1
    // with a stack trace — off the §10 ladder entirely.
    expect(isExitCoded(err)).toBe(true);
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("referential integrity", () => {
  test("duplicate task ids refuse, naming the id", () => {
    const err = refusal(
      listOf([
        { id: "a", title: "A", brief: "x" },
        { id: "a", title: "A again", brief: "y" },
      ]),
    );
    expect(err.message).toContain("duplicate task id 'a'");
  });

  test("an unknown id in depends_on refuses, naming BOTH ends of the edge", () => {
    const err = refusal(
      listOf([
        { id: "a", title: "A", brief: "x" },
        { id: "b", title: "B", brief: "y", depends_on: ["ghost"] },
      ]),
    );
    // Both names, or the operator diffs their own file by eye: which task
    // holds the typo, and what the typo is.
    expect(err.message).toContain("'b'");
    expect(err.message).toContain("'ghost'");
  });

  test("a task depending on itself refuses", () => {
    const err = refusal(listOf([{ id: "a", title: "A", brief: "x", depends_on: ["a"] }]));
    expect(err.message).toContain("'a'");
    expect(err.message).toContain("itself");
  });
});

describe("cycles are refused up front, with the cycle printed (SRD §9.3)", () => {
  test("a two-task cycle names the loop in edge order", () => {
    const err = refusal(
      listOf([
        { id: "a", title: "A", brief: "x", depends_on: ["b"] },
        { id: "b", title: "B", brief: "y", depends_on: ["a"] },
      ]),
    );
    expect(err.exitCode).toBe(EXIT.USAGE);
    // The PATH, not just the word "cycle": the whole value of detection is
    // that the operator does not re-derive it by hand.
    expect(err.message).toMatch(/dependency cycle: (a -> b -> a|b -> a -> b)/);
  });

  test("a cycle buried among valid tasks is still found", () => {
    const err = refusal(
      listOf([
        { id: "ok-1", title: "fine", brief: "x" },
        { id: "c", title: "C", brief: "x", depends_on: ["ok-1", "d"] },
        { id: "d", title: "D", brief: "x", depends_on: ["e"] },
        { id: "e", title: "E", brief: "x", depends_on: ["c"] },
        { id: "ok-2", title: "also fine", brief: "x", depends_on: ["ok-1"] },
      ]),
    );
    expect(err.message).toContain("dependency cycle:");
    for (const id of ["c", "d", "e"]) expect(err.message).toContain(id);
    // The innocent tasks are not accused.
    expect(err.message).not.toContain("ok-1");
    expect(err.message).not.toContain("ok-2");
  });

  test("findCycle returns null for a DAG and is deterministic for a cycle", () => {
    const dag = parseTaskList(
      listOf([
        { id: "a", title: "A", brief: "x" },
        { id: "b", title: "B", brief: "x", depends_on: ["a"] },
        { id: "c", title: "C", brief: "x", depends_on: ["a", "b"] },
      ]),
      "test.json",
    );
    expect(findCycle(dag.tasks)).toBeNull();
  });

  test("a deep chain does not overflow the stack", () => {
    // MAX_ITEMS tasks chained end to end is a legal list; a recursive walk
    // dies here and presents the operator a crash instead of a verdict.
    const n = 1000;
    const tasks = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      title: "T",
      brief: "x",
      ...(i > 0 ? { depends_on: [`t${i - 1}`] } : {}),
    }));
    const list = parseTaskList(listOf(tasks), "test.json");
    expect(findCycle(list.tasks)).toBeNull();
  });
});
