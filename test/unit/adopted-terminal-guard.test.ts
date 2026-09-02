/**
 * D9 — "is this terminal still the worker's?" as a checkable fact.
 *
 * `up.ts` held the attach child's pid at the moment it spawned it and threw it
 * away, so a dispatch staged for an adopted-terminal worker had no way to know
 * whether anybody was still there to trigger it. A staged task nobody can
 * trigger is the `<none>` shape: a mechanism running over an input nobody is
 * reading, reporting success.
 *
 * The predicate is pure and the `ps` read belongs to the caller, which is what
 * lets every arm below run with no process to kill and no pty — ISC-455.
 */

import { describe, expect, test } from "bun:test";
import { PresentationSchema } from "../../src/contracts.ts";
import { terminalRefusal, terminalRefusalMessage } from "../../src/attended/adopt.ts";

const RECORDED = { pid: 4242, started: "utc1 Tue Sep  2 09:15:30 2026" };

describe("terminalRefusal separates the three ways a terminal stops being the worker's", () => {
  test("a live attach whose start time matches is not refused", () => {
    expect(terminalRefusal(RECORDED, RECORDED.started)).toBeNull();
  });

  test("no record at all is its own refusal, not silence", () => {
    // The capture can fail at `up` — a reaped child, an unreadable `ps` — and
    // an operator whose terminal is fine needs to be sent to the capture site
    // rather than told their terminal died.
    expect(terminalRefusal(null, "anything")).toEqual({ kind: "never_recorded" });
  });

  test("an exited attach is attach_gone and names the pid", () => {
    expect(terminalRefusal(RECORDED, null)).toEqual({ kind: "attach_gone", pid: 4242 });
  });

  /**
   * THE anti-criterion of this group. A bare-pid check passes here: the number
   * is alive, `kill -0` succeeds, and the process is a stranger. This is the
   * ISC-144 shape, and it is the only arm that distinguishes the pair
   * comparison from the cheap one.
   */
  test("a REUSED pid does not satisfy the guard", () => {
    const r = terminalRefusal(RECORDED, "utc1 Tue Sep  2 14:02:11 2026");
    expect(r).toEqual({
      kind: "pid_reused",
      pid: 4242,
      recorded: RECORDED.started,
      observed: "utc1 Tue Sep  2 14:02:11 2026",
    });
  });

  test("…and a bare-pid rule would have passed it, which is why the pair is stored", () => {
    // Stated as a test rather than as a comment so the claim is executable: the
    // liveness half agrees in both directions and only the start time differs.
    const alive = "utc1 Tue Sep  2 14:02:11 2026";
    expect(alive).not.toBeNull();
    expect(terminalRefusal(RECORDED, alive)).not.toBeNull();
  });
});

describe("every refusal ends in a remedy", () => {
  test.each([
    ["never_recorded", { kind: "never_recorded" } as const],
    ["attach_gone", { kind: "attach_gone", pid: 4242 } as const],
    [
      "pid_reused",
      { kind: "pid_reused", pid: 4242, recorded: "a", observed: "b" } as const,
    ],
  ])("%s tells the operator what to run", (_label, refusal) => {
    const msg = terminalRefusalMessage("obs-1", refusal);
    expect(msg).toContain("obs-1");
    // The remedy, not just the fact. A refusal that leaves the operator holding
    // an undeliverable task with no next step is the failure it replaces.
    expect(msg).toContain("up --attach-here");
    // A lost switch arm renders "undefined" and this is what notices.
    expect(msg).not.toContain("undefined");
  });

  test("pid_reused says the number was reissued rather than just 'gone'", () => {
    const msg = terminalRefusalMessage("obs-1", {
      kind: "pid_reused",
      pid: 7,
      recorded: "r",
      observed: "o",
    });
    expect(msg).toMatch(/is alive but is NOT the process that was attached/);
  });
});

describe("the presentation record carries the pair", () => {
  const base = {
    schema: "pifleet.presentation/v1",
    worker: "obs-1",
    backend: "headless",
    adopted_terminal: true,
  };

  test("attach_process round-trips through the schema", () => {
    const p = PresentationSchema.parse({ ...base, attach_process: RECORDED });
    expect(p.attach_process).toEqual(RECORDED);
  });

  /**
   * The compatibility arm, and it is load-bearing rather than routine: every
   * presentation file already on disk lacks this field, and it must parse as
   * "no terminal recorded" — which staging REFUSES on. The default being
   * `null` rather than a permissive shape is what keeps an old record from
   * satisfying a guard nothing measured for it.
   */
  test("a record written before the field existed reads as no terminal", () => {
    expect(PresentationSchema.parse(base).attach_process).toBeNull();
    expect(terminalRefusal(PresentationSchema.parse(base).attach_process, "x")).toEqual({
      kind: "never_recorded",
    });
  });

  test.each([
    ["pid 0", { pid: 0, started: "s" }],
    ["a negative pid", { pid: -1, started: "s" }],
    ["an empty start time", { pid: 1, started: "" }],
    ["a stray field", { pid: 1, started: "s", pgid: 1 }],
  ])("refuses %s rather than storing it", (_label, attach_process) => {
    expect(() => PresentationSchema.parse({ ...base, attach_process })).toThrow();
  });
});
