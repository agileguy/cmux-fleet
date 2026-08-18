/**
 * Regressions for defects found in the PR #1 review.
 *
 * Each test here failed before its fix. They live together because what they
 * have in common is the failure MODE, not the subsystem: every one of them was
 * a mechanism that reported success while doing nothing — a guard that skipped
 * itself, a fence recorded one microtask late, a wait that returned 0 for a run
 * that never existed. That shape is the thing to defend against.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, isExitCoded } from "../../src/contracts.ts";
import { CliError } from "../../src/cli/index.ts";
import { requestedEpochFrom } from "../../src/cli/commands/dispatch.ts";
import { parseConfig } from "../../src/config/load.ts";
import { EpochManager, MalformedEpochError } from "../../src/rpc/epoch.ts";
import { RpcClient } from "../../src/rpc/client.ts";

/**
 * Derived from the shipped example rather than hand-rolled, so these tests
 * exercise the same required-field surface a real config has and cannot pass
 * or fail for reasons unrelated to the guard under test.
 */
const BASE_YAML = await Bun.file("fleet.example.yaml").text();

/** Insert a role ahead of `reviewer:` and point a worker at it. */
const configWith = (roleBody: string, workerBody = "") =>
  BASE_YAML.replace("  reviewer:\n", `${roleBody}  reviewer:\n`).replace(
    /workers:\n/,
    `workers:\n  - id: w-probe\n    role: probe\n${workerBody}`,
  );

describe("ISC-59 — read_only is enforced against the EFFECTIVE tool set", () => {
  /**
   * Omitting `tools` is not "no tools". pifleet then passes no `--tools` flag
   * and Pi grants every builtin, `bash` among them. The original guard read
   * `tools?.includes("bash")`, so the omission — the most common way to write
   * the role — skipped the check entirely and a read-only role silently got a
   * shell.
   */
  test("a read_only role with NO tools key is rejected", async () => {
    const yaml = configWith("  probe:\n    read_only: true\n");
    await expect(parseConfig(yaml, "t.yaml")).rejects.toThrow(/read_only/);
  });

  test("the message says why omitting tools is the problem", async () => {
    const yaml = configWith("  probe:\n    read_only: true\n");
    await expect(parseConfig(yaml, "t.yaml")).rejects.toThrow(/no explicit tools/);
  });

  test("a read_only role with an explicit safe tool list is accepted", async () => {
    const yaml = configWith("  probe:\n    read_only: true\n    tools: [read, grep, find, ls]\n");
    await expect(parseConfig(yaml, "t.yaml")).resolves.toBeDefined();
  });

  test("a read_only role that explicitly lists bash is still rejected", async () => {
    const yaml = configWith("  probe:\n    read_only: true\n    tools: [read, bash]\n");
    await expect(parseConfig(yaml, "t.yaml")).rejects.toThrow(/bash/);
  });

  test("a worker resolving to read_only with bash is rejected by worker id", async () => {
    const yaml = configWith(
      "  probe:\n    tools: [read, grep, find, ls]\n",
      "    read_only: true\n    tools: [read, bash]\n",
    );
    await expect(parseConfig(yaml, "t.yaml")).rejects.toThrow(/w-probe/);
  });

  /**
   * The worker-level shape of the same omission: read_only declared where no
   * tools list exists at any level, so the effective set is every builtin.
   */
  test("a worker declaring read_only with no tools anywhere is rejected", async () => {
    const yaml = configWith("  probe:\n    model: local-default\n", "    read_only: true\n");
    await expect(parseConfig(yaml, "t.yaml")).rejects.toThrow(/no explicit tools/);
  });
});

describe("CliError satisfies the structural exit-code protocol", () => {
  /**
   * The entry point has one catch that routes diagnosed failures by the
   * `exitCode` field. CliError named its field `code`, so it failed that
   * check and survived only via an `instanceof` branch ahead of it — leaving
   * the structural path dead code and one module-identity split away from
   * demoting every CLI error to exit 1 plus a stack trace.
   */
  test("isExitCoded accepts a CliError", () => {
    expect(isExitCoded(new CliError("x", EXIT.TIMEOUT))).toBe(true);
  });

  test("the ladder code survives the protocol round-trip", () => {
    const e = new CliError("x", EXIT.BACKEND_UNAVAILABLE);
    expect(isExitCoded(e) && e.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  });
});

describe("epoch fence — the ack is recorded before the next line in the chunk", () => {
  /**
   * THE HANG. Pi may emit the prompt ack and `agent_start` in a single write.
   * `feed()` handles the lines of a chunk synchronously, but resolving a
   * promise only schedules a microtask — so a fence recorded after
   * `await send(...)` is recorded after `agent_start` has already been
   * attributed. With `ack_seq` still null that event is filed as a prior
   * epoch's, the window never opens, and every later event including
   * `agent_end` is discarded. The task never settles and the worker, which
   * refuses to allocate while an epoch is live, is stranded with it.
   */
  const coalesced = (onAck: "hook" | "await") => {
    const em = new EpochManager();
    em.allocate("T-1", "A-1", null);
    const events: Array<{ type: string; attribution: string }> = [];

    const client = new RpcClient(
      { write: () => {} },
      {
        idPrefix: "w",
        onEvent: (msg, seq) => {
          const type = (msg as { type: string }).type;
          if (type === "agent_start") {
            events.push({ type, attribution: em.bindStart(seq) ? "live" : "prior" });
          } else {
            events.push({ type, attribution: em.attribute(seq) });
          }
        },
      },
    );

    const p = client.send(
      "prompt",
      {},
      onAck === "hook" ? { onAck: (seq) => em.noteAck(seq) } : {},
    );
    // One chunk: ack, then the first event. This is the shape that hangs.
    client.feedText(
      '{"type":"response","command":"prompt","success":true,"id":"w-1"}\n' +
        '{"type":"agent_start"}\n' +
        '{"type":"agent_end","willRetry":false}\n',
    );
    return { em, events, p };
  };

  test("the synchronous hook opens the window on a coalesced chunk", async () => {
    const { events, p } = coalesced("hook");
    await p;
    expect(events).toEqual([
      { type: "agent_start", attribution: "live" },
      { type: "agent_end", attribution: "live" },
    ]);
  });

  /**
   * The control. Without the hook the same bytes strand the epoch — this is
   * the bug reproduced, and it is what makes the test above meaningful rather
   * than a tautology.
   */
  test("without the hook the same chunk strands the epoch (control)", async () => {
    const { events, p } = coalesced("await");
    await p;
    expect(events.every((e) => e.attribution === "prior")).toBe(true);
  });

  test("noteAck is first-write-wins, so a later call cannot move the fence", () => {
    const em = new EpochManager();
    em.allocate("T-2", "A-2", null);
    em.noteAck(3);
    em.noteAck(99); // a stale awaited fallback must not orphan seqs 4..99
    expect(em.attribute(4)).toBe("live");
  });

  test("a fresh epoch re-arms the fence", () => {
    const em = new EpochManager();
    em.allocate("T-3", "A-3", null);
    em.noteAck(3);
    em.settle("success", new Date(0).toISOString());
    em.allocate("T-4", "A-4", null);
    // Fence cleared: nothing is live-attributable until the new ack lands.
    expect(em.attribute(4)).toBe("prior");
    em.noteAck(10);
    expect(em.attribute(11)).toBe("live");
  });
});

describe("dispatch — the mandatory epoch placeholder", () => {
  /**
   * `epoch` is required by TaskEnvelopeSchema and 0 is documented as the
   * placeholder the supervisor replaces. Allocated epochs start at 1, so 0 can
   * never be a genuine re-dispatch request — but dispatch treated any number as
   * one, so every hand-written envelope was rejected `stale_epoch` for
   * supplying the one value the schema forces its author to supply.
   *
   * Found by dispatching a real task to a real Pi worker, not by a test.
   */
  test("epoch 0 allocates rather than requesting", () => {
    const em = new EpochManager();
    expect(em.allocate("T-1", "A-1", requestedEpochFrom(0))).toMatchObject({ ok: true, epoch: 1 });
  });

  test("a positive epoch is still honoured as an explicit request", () => {
    const em = new EpochManager();
    expect(em.allocate("T-1", "A-1", requestedEpochFrom(1))).toMatchObject({ ok: true, epoch: 1 });
  });

  test("a genuinely stale epoch is still rejected", () => {
    const em = new EpochManager();
    em.allocate("T-1", "A-1", null);
    em.settle("success", new Date(0).toISOString());
    expect(em.allocate("T-2", "A-2", requestedEpochFrom(1))).toMatchObject({ ok: false });
  });

  /**
   * The predicate itself, at its boundaries. The three tests above route
   * through `EpochManager`, which can mask a predicate change behind
   * allocation behaviour; these cannot.
   */
  test("only a positive number is a request — everything else allocates", () => {
    expect(requestedEpochFrom(0)).toBeNull();
    expect(requestedEpochFrom(undefined)).toBeNull();
    expect(requestedEpochFrom("1")).toBeNull();
    expect(requestedEpochFrom(null)).toBeNull();
    expect(requestedEpochFrom(1)).toBe(1);
    expect(requestedEpochFrom(7)).toBe(7);
  });

  /**
   * ISC-217. `-1` used to fall through the `raw > 0` predicate to `null`, which
   * means "allocate" — so a task file with a mistyped `epoch` was not refused,
   * it was RUN, and a re-dispatch meant to replay executed the task a second
   * time. `1.5` passed the predicate instead and came back `stale_epoch`, which
   * reads as a fence that moved on rather than as an unreadable request. Both
   * are named at the boundary now; only the TYPE check still falls through to
   * "allocate", because a missing `epoch` is not a malformed one.
   */
  test("a negative or fractional epoch is a named error, not an allocation", () => {
    expect(() => requestedEpochFrom(-1)).toThrow(MalformedEpochError);
    expect(() => requestedEpochFrom(1.5)).toThrow(MalformedEpochError);
    expect(() => requestedEpochFrom(Number.NaN)).toThrow(MalformedEpochError);
  });
});
