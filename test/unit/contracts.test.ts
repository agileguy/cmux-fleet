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
  ControlAuthSchema,
  CredentialInjectionSchema,
  EgressDecisionSchema,
  RepoHazardSchema,
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

/**
 * Phase 3 seam (SRD §5.8, §5.10, §12).
 *
 * Written before the phase's engineers are dispatched and read-only to them.
 * These tests exist so the seam's INVARIANTS are pinned before four
 * subsystems start depending on it — a shared type whose constraints are
 * discovered by the first engineer to violate them is not a seam.
 */
describe("Phase 3 seam — credentials, egress, hazards, control auth", () => {
  test("a control secret must be 256 bits of hex, not a shorter convenience", () => {
    const base = {
      schema: "pifleet.controlauth/v1" as const,
      run_id: "r-1",
      created_at: "2026-07-27T00:00:00Z",
    };
    expect(ControlAuthSchema.safeParse({ ...base, secret: "a".repeat(64) }).success).toBe(true);
    // Too short, wrong alphabet, and uppercase are all rejected: a socket
    // secret a caller can guess is a socket with no auth and a false sense of it.
    expect(ControlAuthSchema.safeParse({ ...base, secret: "a".repeat(32) }).success).toBe(false);
    expect(ControlAuthSchema.safeParse({ ...base, secret: "z".repeat(64) }).success).toBe(false);
    expect(ControlAuthSchema.safeParse({ ...base, secret: "A".repeat(64) }).success).toBe(false);
  });

  /**
   * `refresh_token_absent` is required with no default. A default of `true`
   * would let a subsystem that never checked report the safe answer, and the
   * whole point of §5.8's token mode is that the absence is VERIFIED.
   */
  test("refresh_token_absent has no default — it must be answered", () => {
    const injection = {
      schema: "pifleet.credential/v1" as const,
      worker: "eng-1",
      mode: "token" as const,
      identity: "dan@example.com",
      expires_at: "2026-07-27T01:00:00Z",
      injected_at: "2026-07-27T00:00:00Z",
      injected_mono: 1234,
    };
    expect(CredentialInjectionSchema.safeParse(injection).success).toBe(false);
    expect(
      CredentialInjectionSchema.safeParse({ ...injection, refresh_token_absent: true }).success,
    ).toBe(true);
  });

  test("generation defaults to 0 so the initial injection needs no ceremony", () => {
    const parsed = CredentialInjectionSchema.parse({
      schema: "pifleet.credential/v1",
      worker: "eng-1",
      mode: "token",
      identity: "sa@project.iam.gserviceaccount.com",
      expires_at: "2026-07-27T01:00:00Z",
      injected_at: "2026-07-27T00:00:00Z",
      injected_mono: 0,
      refresh_token_absent: true,
    });
    expect(parsed.generation).toBe(0);
  });

  /**
   * `detected` and `neutralized` are separate because "we saw it and left it"
   * and "we saw it and defused it" are different security postures. A single
   * `handled` boolean would let the first masquerade as the second.
   */
  test("a repo hazard records detection and neutralization independently", () => {
    const seen = RepoHazardSchema.parse({ path: "AGENTS.md", kind: "agents_md", neutralized: false });
    expect(seen.detected).toBe(true);
    expect(seen.neutralized).toBe(false);
    expect(RepoHazardSchema.safeParse({ path: ".pi/extensions/x", kind: "pi_extension" }).success).toBe(
      false,
    );
  });

  /**
   * `detected` is an invariant, not a default. The docstring read as one while
   * `z.boolean().default(true)` behaved as the other: a default only supplies
   * a value when the key is ABSENT, so `{detected: false}` parsed happily and
   * produced a hazard record claiming nothing was found — a shape that should
   * not exist, since a record is created BECAUSE something was found.
   *
   * Fails if the field goes back to a plain boolean. Without this the change
   * to `z.literal(true)` reverts with the suite green, which is how the
   * original weakening survived.
   */
  test("a hazard cannot claim it was never detected", () => {
    expect(
      RepoHazardSchema.safeParse({
        path: "AGENTS.md",
        kind: "agents_md",
        detected: false,
        neutralized: false,
      }).success,
    ).toBe(false);
    // Omitted is still fine — the default is what fills it in.
    expect(
      RepoHazardSchema.parse({ path: "AGENTS.md", kind: "agents_md", neutralized: true }).detected,
    ).toBe(true);
  });

  test("an egress decision names the rule that decided, including default-deny", () => {
    const denied = EgressDecisionSchema.parse({
      allowed: false,
      host: "evil.example",
      port: 443,
      rule: "default-deny",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("default-deny");
    // Port is required and positive: "allowed to host X" without a port is a
    // rule that cannot be checked against what actually happened.
    expect(
      EgressDecisionSchema.safeParse({ allowed: true, host: "oauth2.googleapis.com", port: 0 }).success,
    ).toBe(false);
  });
});
