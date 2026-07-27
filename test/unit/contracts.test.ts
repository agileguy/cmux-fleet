import { describe, expect, test } from "bun:test";
import {
  adjudicate,
  EXIT,
  MAX_TEXT,
  ResultEnvelopeSchema,
  SESSION_ID_RE,
  TaskEnvelopeSchema,
  WorkerStateSchema,
  worstExit,
} from "../../src/contracts.ts";

const validTask = {
  schema: "pifleet.task/v1",
  task_id: "T-004",
  run_id: "2026-07-26T14-02-11Z-8f3a",
  epoch: 1,
  attempt: 1,
  worker: "eng-1",
  dispatched_at: "2026-07-26T14:02:19Z",
  title: "Add --json to kasa-cli status",
  brief: "Full markdown instructions",
  repo: "/Users/dan/repos/kasa-cli",
  host_workdir: "/Users/dan/repos/kasa-cli/.worktrees/eng-1",
  container_workdir: "/workspace",
  branch: "fleet/run/eng-1",
  base_ref: "9f1c2ab3e4d5f60718293a4b5c6d7e8f90a1b2c3",
  outbox: "/outbox/T-004",
  deadline_s: 1500,
};

describe("TaskEnvelopeSchema", () => {
  test("accepts the SRD §7.1 worked example", () => {
    expect(TaskEnvelopeSchema.parse(validTask).epoch).toBe(1);
  });

  // The epoch omission that would have made every envelope stale.
  test("rejects an envelope with no epoch", () => {
    const { epoch, ...noEpoch } = validTask;
    expect(TaskEnvelopeSchema.safeParse(noEpoch).success).toBe(false);
  });

  test("rejects a symbolic base_ref", () => {
    expect(TaskEnvelopeSchema.safeParse({ ...validTask, base_ref: "main" }).success).toBe(false);
  });

  test("rejects a short SHA as base_ref", () => {
    expect(TaskEnvelopeSchema.safeParse({ ...validTask, base_ref: "9f1c2ab" }).success).toBe(false);
  });

  test("defaults the optional collections to empty arrays", () => {
    const p = TaskEnvelopeSchema.parse(validTask);
    expect(p.inputs).toEqual([]);
    expect(p.cloud_allow).toEqual([]);
    expect(p.depends_on).toEqual([]);
  });

  // ISC-122: oversized fields are rejected, not absorbed.
  test("rejects an oversized brief without attempting to hold it", () => {
    const huge = { ...validTask, brief: "x".repeat(MAX_TEXT + 1) };
    expect(TaskEnvelopeSchema.safeParse(huge).success).toBe(false);
  });

  test("rejects a worker id outside Pi's session-id grammar", () => {
    expect(TaskEnvelopeSchema.safeParse({ ...validTask, worker: "-bad" }).success).toBe(false);
    expect(SESSION_ID_RE.test("eng-1")).toBe(true);
    expect(SESSION_ID_RE.test("eng-")).toBe(false);
  });
});

describe("ResultEnvelopeSchema", () => {
  const valid = {
    schema: "pifleet.result/v1",
    task_id: "T-004",
    epoch: 1,
    worker: "eng-1",
    status: "success",
  };

  test("accepts a minimal envelope and fills defaults", () => {
    const p = ResultEnvelopeSchema.parse(valid);
    expect(p.files_changed).toEqual([]);
    expect(p.summary).toBe("");
  });

  test("rejects a status outside the worker's four-value vocabulary", () => {
    expect(ResultEnvelopeSchema.safeParse({ ...valid, status: "aborted" }).success).toBe(false);
    expect(ResultEnvelopeSchema.safeParse({ ...valid, status: "timed_out" }).success).toBe(false);
  });

  test("rejects a non-40-char commit sha", () => {
    expect(ResultEnvelopeSchema.safeParse({ ...valid, commits: ["a1b2c3d"] }).success).toBe(false);
  });
});

describe("adjudicate", () => {
  // Primacy rule: the envelope may downgrade a verdict, never upgrade one.
  test("a worker cannot upgrade a derived failure", () => {
    expect(adjudicate("failed", "success")).toBe("failed");
  });

  test("a worker can downgrade a derived success", () => {
    expect(adjudicate("success", "partial")).toBe("partial");
  });

  // ISC-94: a missing envelope must not downgrade an otherwise clean task.
  test("unknown is the identity element, not the bottom", () => {
    expect(adjudicate("success", undefined)).toBe("success");
    expect(adjudicate("success", "unknown")).toBe("success");
    expect(adjudicate("unknown", "success")).toBe("success");
  });

  test("supervisor-terminal verdicts win outright", () => {
    expect(adjudicate("aborted", "success")).toBe("aborted");
    expect(adjudicate("timed_out", "success")).toBe("timed_out");
  });

  test("lattice order is failed < blocked < partial < success", () => {
    expect(adjudicate("partial", "blocked")).toBe("blocked");
    expect(adjudicate("blocked", "failed")).toBe("failed");
    expect(adjudicate("success", "success")).toBe("success");
  });
});

describe("worstExit", () => {
  test("returns success for an empty set", () => {
    expect(worstExit([])).toBe(EXIT.SUCCESS);
  });

  // One `wait --all` can legitimately trip several at once.
  test("usage outranks every other code", () => {
    expect(worstExit([EXIT.PARTIAL, EXIT.TIMEOUT, EXIT.USAGE])).toBe(EXIT.USAGE);
  });

  test("budget outranks timeout and partial", () => {
    expect(worstExit([EXIT.PARTIAL, EXIT.TIMEOUT, EXIT.BUDGET])).toBe(EXIT.BUDGET);
  });

  test("worker death outranks timeout", () => {
    expect(worstExit([EXIT.TIMEOUT, EXIT.WORKER_DIED])).toBe(EXIT.WORKER_DIED);
  });

  test("partial outranks success", () => {
    expect(worstExit([EXIT.SUCCESS, EXIT.PARTIAL])).toBe(EXIT.PARTIAL);
  });
});

describe("WorkerStateSchema", () => {
  test("session_path defaults to null so 'never started' is representable", () => {
    const s = WorkerStateSchema.parse({
      schema: "pifleet.state/v1",
      worker: "eng-1",
      run_id: "r",
      pid: 1,
      pgid: 1,
      started_at: "2026-07-26T14:02:11Z",
      phase: "starting",
      epoch: 0,
    });
    expect(s.session_path).toBeNull();
    expect(s.session_present).toBe(false);
    expect(s.exit).toEqual({ code: null, signal: null });
  });
});
