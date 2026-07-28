/**
 * backends/tmux/fallback.ts — ISC-131's fallback half.
 *
 * Two invariants carry this file: the fallback is VISIBLE (ledger and stderr
 * both, ledger first), and the no-way-forward paths are diagnosed exits, not
 * stack traces. A silent fallback is the worst output the resolver could
 * produce — an operator watching cmux panes that do not exist — so the
 * visibility assertions here are the ones that must never be weakened.
 */

import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/contracts.ts";
import type { Capability, FleetBackend } from "../../src/backends/types.ts";
import {
  resolveBackendWithFallback,
  type FallbackLedger,
} from "../../src/backends/tmux/fallback.ts";

/** A FleetBackend that is only a probe — resolution never calls anything else. */
function backendStub(kind: "cmux" | "tmux" | "headless", caps: Capability[] | Error): FleetBackend {
  return {
    kind,
    probe: async () => {
      if (caps instanceof Error) throw caps;
      return caps;
    },
    ensureWorkspace: async () => ({ backend: kind, id: null }),
    createPane: async () => ({ backend: kind, id: null }),
    attachViewer: async () => {},
    focus: async () => {},
    destroy: async () => {},
  };
}

const healthy: Capability[] = [{ name: "x", ok: true, required: true }];
const broken: Capability[] = [
  { name: "cmux-socket", ok: false, required: true, detail: "connection refused" },
];

function recordingLedger() {
  const events: Array<{ event: string; detail: Record<string, unknown> | undefined }> = [];
  const order: string[] = [];
  const ledger: FallbackLedger = {
    append: async (event, fields) => {
      events.push({ event, detail: fields.detail });
      order.push("ledger");
    },
  };
  const stderrLines: string[] = [];
  const writeStderr = (line: string) => {
    stderrLines.push(line);
    order.push("stderr");
  };
  return { ledger, writeStderr, events, stderrLines, order };
}

describe("healthy primary", () => {
  test("is returned as-is with no fallback noise anywhere", async () => {
    const r = recordingLedger();
    const primary = backendStub("cmux", healthy);
    const res = await resolveBackendWithFallback({
      primary,
      fallback: backendStub("tmux", healthy),
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    });
    expect(res.backend).toBe(primary);
    expect(res.fellBack).toBe(false);
    // No event and no warning: a fallback announcement for a fallback that
    // did not happen would train operators to ignore the real one.
    expect(r.events).toHaveLength(0);
    expect(r.stderrLines).toHaveLength(0);
  });
});

describe("unavailable primary with a fallback (ISC-131)", () => {
  test("lands on the fallback and says so in the ledger AND on stderr", async () => {
    const r = recordingLedger();
    const fallback = backendStub("tmux", healthy);
    const res = await resolveBackendWithFallback({
      primary: backendStub("cmux", broken),
      fallback,
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    });
    expect(res.backend).toBe(fallback);
    expect(res.fellBack).toBe(true);
    expect(res.primaryFailures).toEqual(broken);

    expect(r.events).toEqual([
      {
        event: "backend_fallback",
        detail: {
          from: "cmux",
          to: "tmux",
          reasons: [{ name: "cmux-socket", detail: "connection refused" }],
        },
      },
    ]);
    expect(r.stderrLines).toHaveLength(1);
    expect(r.stderrLines[0]).toContain("cmux");
    expect(r.stderrLines[0]).toContain("tmux");
    expect(r.stderrLines[0]).toContain("connection refused");
    // Ledger before stderr: the durable record is the one that must survive
    // a crash between the two writes.
    expect(r.order).toEqual(["ledger", "stderr"]);
  });

  test("a probe that throws counts as unavailable, not as a crash", async () => {
    const r = recordingLedger();
    const fallback = backendStub("tmux", healthy);
    const res = await resolveBackendWithFallback({
      primary: backendStub("cmux", new Error("socket vanished mid-probe")),
      fallback,
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    });
    expect(res.backend).toBe(fallback);
    expect(r.stderrLines[0]).toContain("socket vanished mid-probe");
  });
});

describe("no way forward is exit 3 with a named diagnosis", () => {
  test("unavailable primary, no fallback given", async () => {
    const r = recordingLedger();
    const err = await resolveBackendWithFallback({
      primary: backendStub("cmux", broken),
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    }).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number },
    );
    expect(err).not.toBeNull();
    expect(err?.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(err?.message).toContain("cmux");
    expect(err?.message).toContain("connection refused");
    // Nothing fell back, so nothing may claim it did.
    expect(r.events).toHaveLength(0);
  });

  test("both backends down names BOTH diagnoses", async () => {
    const r = recordingLedger();
    const err = await resolveBackendWithFallback({
      primary: backendStub("cmux", broken),
      fallback: backendStub("tmux", [
        { name: "tmux", ok: false, required: true, detail: "not installed" },
      ]),
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    }).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number },
    );
    expect(err?.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(err?.message).toContain("connection refused");
    expect(err?.message).toContain("not installed");
  });

  test("a non-required failed capability does not trip the fallback", async () => {
    const r = recordingLedger();
    const primary = backendStub("cmux", [
      { name: "read-screen", ok: false, required: false, detail: "absent" },
      { name: "socket", ok: true, required: true },
    ]);
    const res = await resolveBackendWithFallback({
      primary,
      fallback: backendStub("tmux", healthy),
      ledger: r.ledger,
      writeStderr: r.writeStderr,
    });
    // ISC-132's spirit: optional capabilities are recorded, never required —
    // falling back over one would punish a backend for honesty.
    expect(res.backend).toBe(primary);
    expect(res.fellBack).toBe(false);
  });
});
