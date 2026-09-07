/**
 * The pass — SRD-TRIAGE-CONSOLE §6.3, §6.4, §6.5, §6.7, §6.8a; §13 task 6.1.
 *
 * ## Every test calls the pass directly and NO test starts the loop
 *
 * §13 task 6.1's acceptance, and §12's first clock criterion states it as the
 * coverage gate's own requirement: *"One pass is exported and a test drives it
 * with no timer."* `runTriageActor` is not imported by this file at all — the
 * absence is asserted rather than left to a reader's grep, because an import
 * added later would be invisible in a diff of assertions.
 *
 * ## Nothing here reaches a container, a clock or the network
 *
 * Three fences, and each is a REQUIRED dep rather than a defaulted one, so a
 * fixture that forgot it does not compile:
 *
 *  - `probe` — `saturationVerdict`'s own fence, taken again here. Every negative
 *    fixture hands it a probe that THROWS if called, which fails at the call site
 *    rather than at an assertion (ISC-730's method).
 *  - `transport` — the notifier's. `https://ntfy.agileguy.ca/Alerts` is the
 *    operator's live endpoint and it is the shipped default, so a pass that
 *    defaulted its transport would POST to it from CI.
 *  - `records` — the incident store. `saveIncidentRecord`'s default writes under
 *    `~/.pifleet/triage/`, which is keyed off `$HOME`.
 *
 * ## The fixture's four identity tokens are pairwise non-substring
 *
 * ISC-681's method: `cni-dev`, `mia`, `omlx`, `gpt-oss-20b-MXFP4-Q8`. A fixture
 * where the environment and the service share a substring cannot tell a composer
 * that named the wrong one, and §6.7 rule 3 is entirely about which of those two
 * a message names.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FRESH_SATURATION_MEMO,
  TRIAGE_PASS_OUTCOMES,
  freshSaturationMemo,
  triagePass,
  type IncidentStore,
  type SaturationMemo,
  type SweepCollation,
  type SweepDriver,
  type SweepJoin,
  type SweepOpen,
  type TriagePassDeps,
  type TriagePassOutcome,
} from "../../src/run/triage-pass.ts";
import {
  COVERAGE_THRESHOLD,
  freshIncidentRecord,
  subjectKey,
  type IncidentRecord,
  type IncidentSubject,
} from "../../src/run/triage-incident.ts";
import { defaultTriageConsoleConfig } from "../../src/run/triage-config.ts";
import { freshDeliveryState, type NotifyOutcome, type NotifyRequest } from "../../src/run/triage-notify.ts";
import { SATURATION_MIN_MISSING, type ObserverArtifact, type TriageDocument, type TriageRow } from "../../src/run/triage-verdict.ts";
import type { PartitionAssignment } from "../../src/run/triage-partition.ts";
import type { TriageActorCursor } from "../../src/run/triage-actor.ts";
import type { ToolCallProbeResult } from "../../src/security/model-probe.ts";

// ── The fixture world ───────────────────────────────────────────────────────

const ENVIRONMENT = "cni-dev";
const SERVICES = ["mia", "authorization", "authentication"] as const;
const SEATS = ["obs-t1", "obs-t2", "obs-t3"] as const;
const PROVIDER = "omlx";
const MODEL = "gpt-oss-20b-MXFP4-Q8";

/** A round instant, so a fixture reads as a timeline rather than as arithmetic. */
const T0 = 1_800_000_000_000;
const CADENCE_MS = 300_000;
const DEFAULT_WINDOW_S = 300;

/**
 * The fixture's clock, shared between {@link deps} and {@link artifact}.
 *
 * An observer's `window_opened_at` must sit inside
 * `[dispatched_at − (default_window + reserve), dispatched_at]`, and
 * `dispatched_at` is minted from the pass's own `now`. A fixture that pinned the
 * echo to a constant while the clock advanced would put every sweep after the
 * first out of range — which is the shape the first run of this file actually
 * had, and it is worth keeping the reason visible: a `stale_window` verdict
 * looks exactly like the coverage gap it is not.
 */
const clock = { at: T0 };

function partition(): PartitionAssignment[] {
  return [
    { worker: SEATS[0], services: [SERVICES[0]] },
    { worker: SEATS[1], services: [SERVICES[1]] },
    { worker: SEATS[2], services: [SERVICES[2]] },
  ];
}

function artifact(worker: string, sweepId: string): ObserverArtifact {
  return {
    worker,
    sweep_id: sweepId,
    window_opened_at: new Date(clock.at - DEFAULT_WINDOW_S * 1_000).toISOString(),
  };
}

function healthyRow(service: string): TriageRow {
  return {
    service,
    assessment: "healthy",
    coverage: [{ channel: "rollout", result: "answered" }],
    selector: `app=${service}`,
    window: "5m",
    evidence_ref: [`kubectl -n ${service} get deploy`],
    observer: null,
  };
}

function row(service: string, assessment: TriageRow["assessment"]): TriageRow {
  return { ...healthyRow(service), assessment };
}

function document(sweepId: string, rows: readonly TriageRow[]): TriageDocument {
  return { worker: "tri-1", sweep_id: sweepId, services: [...rows], unaccounted: [] };
}

/** A probe that fails at the CALL SITE — ISC-730's harder-than-a-count assertion. */
const probeThatMustNotRun = async (): Promise<ToolCallProbeResult> => {
  throw new Error("the confirming probe ran on a sweep that is not a saturation candidate");
};

function timeoutProbe(): ToolCallProbeResult {
  return { ok: false, failure: "timeout", detail: "no answer in 20000ms" } as ToolCallProbeResult;
}

/** A transport that fails at the CALL SITE, for every fixture that must not deliver. */
const transportThatMustNotRun = async (): Promise<NotifyOutcome> => {
  throw new Error("the notify transport was reached on a sweep with nothing to announce");
};

interface Delivered {
  readonly transport: (req: NotifyRequest) => Promise<NotifyOutcome>;
  readonly requests: NotifyRequest[];
}

function accepting(at: number = T0): Delivered {
  const requests: NotifyRequest[] = [];
  return {
    requests,
    transport: async (req) => {
      requests.push(req);
      return { status: "delivered", at, httpStatus: 200, reason: null };
    },
  };
}

/** A record store over a `Map`, so a fixture can seed a `firing` record. */
function store(seed: readonly IncidentRecord[] = []): IncidentStore & {
  readonly written: IncidentRecord[];
  readonly held: Map<string, IncidentRecord>;
} {
  const held = new Map<string, IncidentRecord>(seed.map((r) => [subjectKey(r.subject), r]));
  const written: IncidentRecord[] = [];
  return {
    held,
    written,
    load: async (subject) => {
      const found = held.get(subjectKey(subject));
      return { kind: "ok", record: found ?? freshIncidentRecord(subject) };
    },
    save: async (record) => {
      held.set(subjectKey(record.subject), record);
      written.push(record);
    },
  };
}

function serviceSubject(service: string): IncidentSubject {
  return { kind: "service", environment: ENVIRONMENT, service };
}

interface DriverOptions {
  readonly inFlight?: SweepDriver["inFlight"];
  readonly open?: SweepOpen;
  readonly assignments?: readonly PartitionAssignment[];
  readonly artifacts?: (sweepId: string) => readonly ObserverArtifact[];
  readonly blocked?: readonly string[];
  readonly rows?: (sweepId: string) => readonly TriageRow[];
  readonly collation?: (sweepId: string) => SweepCollation;
  readonly highest?: number;
}

interface Spy {
  readonly driver: SweepDriver;
  readonly opened: string[];
  readonly dispatched: Array<{ sweepId: string; worker: string }>;
  readonly collated: string[];
}

function driver(opts: DriverOptions = {}): Spy {
  const opened: string[] = [];
  const dispatched: Array<{ sweepId: string; worker: string }> = [];
  const collated: string[] = [];
  const assignments = opts.assignments ?? partition();
  return {
    opened,
    dispatched,
    collated,
    driver: {
      inFlight: opts.inFlight ?? (async () => null),
      highestSweepNumber: async () => opts.highest ?? 0,
      runs: async () => ({ "tri-1": "RUN-A", "obs-t1": "RUN-A", "obs-t2": "RUN-A", "obs-t3": "RUN-A" }),
      openSweep: async (sweepId) => {
        opened.push(sweepId);
        return opts.open ?? { kind: "opened" };
      },
      readPartition: async () => assignments,
      dispatchObserver: async (sweepId, assignment) => {
        dispatched.push({ sweepId, worker: assignment.worker });
      },
      join: async (sweepId): Promise<SweepJoin> => ({
        artifacts: opts.artifacts?.(sweepId) ?? SEATS.map((s) => artifact(s, sweepId)),
        blocked: opts.blocked ?? [],
      }),
      collate: async (sweepId): Promise<SweepCollation> => {
        collated.push(sweepId);
        if (opts.collation !== undefined) return opts.collation(sweepId);
        const rows = opts.rows?.(sweepId) ?? SERVICES.map((s) => healthyRow(s));
        return { document: document(sweepId, rows), evidenceRef: `${sweepId}/triage.json` };
      },
    },
  };
}

function freshCursor(): TriageActorCursor {
  return { runs: {}, sweep_cursor: 0, consecutive_skips: 0 };
}

interface DepsOptions {
  readonly driver?: SweepDriver;
  readonly records?: IncidentStore;
  readonly cursor?: TriageActorCursor;
  readonly delivery?: TriagePassDeps["delivery"];
  readonly memo?: SaturationMemo;
  readonly probe?: TriagePassDeps["probe"];
  readonly transport?: TriagePassDeps["transport"];
  readonly now?: number;
  readonly notify?: TriagePassDeps["notify"];
}

function deps(opts: DepsOptions = {}): TriagePassDeps {
  const config = defaultTriageConsoleConfig();
  clock.at = opts.now ?? T0;
  return {
    environment: ENVIRONMENT,
    declared: [...SERVICES],
    windowPolicy: { default_window_s: DEFAULT_WINDOW_S, reserve_s: config.reserve_s },
    config,
    notify: opts.notify === undefined ? config.notify : opts.notify,
    endpoint: { provider: PROVIDER, model: MODEL },
    probe: opts.probe ?? probeThatMustNotRun,
    transport: opts.transport ?? transportThatMustNotRun,
    cursor: opts.cursor ?? freshCursor(),
    delivery: opts.delivery ?? freshDeliveryState(),
    saturationMemo: opts.memo ?? freshSaturationMemo(),
    sweep: opts.driver ?? driver().driver,
    records: opts.records ?? store(),
    now: () => clock.at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the pass is a function, and no test starts the loop", () => {
  /**
   * §13 task 6.1's acceptance, asserted over this file's own IMPORT statements
   * rather than over its whole text.
   *
   * Matching the whole file is what the first version did, and it reddened on
   * this file's own docblock — which names `runTriageActor` in order to say that
   * it is not imported. A probe that a truthful comment can fail is a probe that
   * gets deleted, so the assertion is narrowed to the lines that can actually
   * start a loop.
   */
  test("no import in this file can start the actor's loop or a timer", () => {
    const source = readFileSync(join(import.meta.dir, "triage-pass.test.ts"), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*(import|} from|\s+[A-Za-z_$].*,)\s/.test(line) || line.startsWith("import"));
    const joined = imports.join("\n");
    expect(joined).toContain("triage-pass.ts");
    expect(joined).not.toContain("runTriageActor");
    /*
     * The two needles are ASSEMBLED at runtime rather than written out, because
     * a self-scanning assertion that spells its own needle is an occurrence of
     * that needle — the probe reddens on its own text and gets "fixed" by
     * deletion. This bit me twice writing this file: once in the assertion and
     * once in the comment explaining the assertion, which is why neither this
     * sentence nor the line below contains either timer's name followed by a
     * parenthesis.
     */
    for (const timer of ["setTime" + "out(", "setInter" + "val("]) {
      expect(source).not.toContain(timer);
    }
  });

  test("one call, injected deps, an outcome and no timer", async () => {
    const spy = driver();
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("swept");
    expect(TRIAGE_PASS_OUTCOMES).toContain(out.kind);
    expect(out.sweepId).toBe("T-sweep-1");
    expect(spy.opened).toEqual(["T-sweep-1"]);
  });

  test("the outcome kinds are a closed set, asserted by NAME", () => {
    expect([...TRIAGE_PASS_OUTCOMES]).toEqual([
      "swept",
      "skipped",
      "budget_exhausted",
      "partition_refused",
    ]);
  });
});

describe("the fan-out — every Phase 5 module has a production caller", () => {
  test("a clean sweep opens, partitions, dispatches three, joins and collates", async () => {
    const spy = driver();
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(spy.opened).toEqual(["T-sweep-1"]);
    expect(spy.dispatched).toEqual([
      { sweepId: "T-sweep-1", worker: "obs-t1" },
      { sweepId: "T-sweep-1", worker: "obs-t2" },
      { sweepId: "T-sweep-1", worker: "obs-t3" },
    ]);
    expect(spy.collated).toEqual(["T-sweep-1"]);
    expect(out.assessment?.census.counted).toBe(3);
    expect(out.assessment?.services.map((s) => s.assessment)).toEqual([
      "healthy",
      "healthy",
      "healthy",
    ]);
  });

  test("a partition missing a service is refused WHOLE and nothing is dispatched", async () => {
    const spy = driver({ assignments: [{ worker: "obs-t1", services: ["mia"] }] });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("partition_refused");
    expect(out.partition?.code).toBe("partition_incomplete");
    expect(out.partition?.missing).toEqual(["authorization", "authentication"]);
    expect(spy.dispatched).toEqual([]);
    expect(spy.collated).toEqual([]);
  });

  test("a service claimed twice is refused, and still nothing is dispatched", async () => {
    const spy = driver({
      assignments: [
        { worker: "obs-t1", services: ["mia", "authorization"] },
        { worker: "obs-t2", services: ["authorization"] },
        { worker: "obs-t3", services: ["authentication"] },
      ],
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("partition_refused");
    expect(out.partition?.code).toBe("partition_duplicate");
    expect(spy.dispatched).toEqual([]);
  });

  test("§6.5's zero-row: no artifact means NO collation is dispatched", async () => {
    const spy = driver({ artifacts: () => [] });
    const out = await triagePass(
      deps({ driver: spy.driver, probe: async () => timeoutProbe() }),
    );
    expect(spy.dispatched).toHaveLength(3);
    expect(spy.collated).toEqual([]);
    expect(out.assessment?.census.observers_reported).toBe(0);
  });

  /**
   * §6.5's zero-row reaching §6.8a's identity, which is the whole point of
   * raising it: *"a sweep that observed nothing is not a clean sweep, and §6.7
   * must never read the absence of findings as an all-clear."*
   *
   * The probe answers `unreachable` rather than `timeout` so `saturated` is
   * `null` and `inference_saturated` gets no observation at all — which isolates
   * the kind under test. A `timeout` fixture would raise two console-health
   * issues and the assertion could not say which one it was reading.
   */
  test("a sweep that collated nothing raises sweep_produced_nothing for the environment", async () => {
    const records = store();
    const wire = accepting();
    const spy = driver({ artifacts: () => [] });
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const emitted: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({
          driver: spy.driver,
          records,
          cursor,
          delivery,
          memo,
          transport: wire.transport,
          now: T0 + i * CADENCE_MS,
          probe: async () =>
            ({ ok: false, failure: "unreachable", detail: "connection refused" }) as ToolCallProbeResult,
        }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      for (const n of out.notifications) emitted.push(`${n.kind}:${subjectKey(n.subject)}`);
    }
    expect(emitted).toEqual(["opened:console_health:cni-dev/sweep_produced_nothing"]);
    expect(records.held.get("console_health:_console/inference_saturated")).toBeUndefined();
  });

  test("coverage is counted from the RUN TREE, never from triage.json's claim", async () => {
    // The document claims all three; the run tree holds two reply artifacts.
    const spy = driver({
      artifacts: (id) => [artifact("obs-t1", id), artifact("obs-t2", id)],
      rows: () => SERVICES.map((s) => healthyRow(s)),
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.assessment?.census.declared).toBe(3);
    expect(out.assessment?.census.counted).toBe(2);
    const third = out.assessment?.services.find((s) => s.service === "authentication");
    expect(third?.assessment).toBe("indeterminate");
    expect(third?.reason).toBe("no_artifact");
  });

  test("an artifact echoing the PREVIOUS sweep's id is stale_replay", async () => {
    const spy = driver({
      artifacts: (id) => [artifact("obs-t1", "T-sweep-0"), artifact("obs-t2", id), artifact("obs-t3", id)],
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.assessment?.stale_replay).toEqual(["obs-t1"]);
    expect(out.assessment?.services.find((s) => s.service === "mia")?.assessment).toBe(
      "indeterminate",
    );
  });
});

describe("tick or skip — §6.4, and a queue is never built", () => {
  test("a sweep in flight is SKIPPED: nothing is opened and nothing is dispatched", async () => {
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate" }),
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("skipped");
    expect(out.waitingOn).toBe("T-sweep-7-collate");
    expect(out.sweepId).toBe("T-sweep-7");
    expect(spy.opened).toEqual([]);
    expect(spy.dispatched).toEqual([]);
    expect(spy.collated).toEqual([]);
  });

  test("a skip advances the skip counter and NOT the sweep cursor", async () => {
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate" }),
    });
    const out = await triagePass(
      deps({ driver: spy.driver, cursor: { runs: {}, sweep_cursor: 7, consecutive_skips: 1 } }),
    );
    expect(out.cursor.sweep_cursor).toBe(7);
    expect(out.cursor.consecutive_skips).toBe(2);
  });

  test("a sweep that runs RESETS the skip counter", async () => {
    const out = await triagePass(
      deps({ cursor: { runs: {}, sweep_cursor: 4, consecutive_skips: 2 } }),
    );
    expect(out.cursor.consecutive_skips).toBe(0);
    expect(out.cursor.sweep_cursor).toBe(5);
    expect(out.sweepId).toBe("T-sweep-5");
  });

  test("ANTI: a restarted actor with an EMPTY record never reuses a dispatched id", async () => {
    // The run tree holds `T-sweep-12`; the record was lost. §6.6 layer 2.
    const spy = driver({ highest: 12 });
    const out = await triagePass(deps({ driver: spy.driver, cursor: freshCursor() }));
    expect(out.sweepId).toBe("T-sweep-13");
    expect(spy.opened).toEqual(["T-sweep-13"]);
    expect(out.cursor.sweep_cursor).toBe(13);
  });

  test("ANTI: skips 4, 5 and 6 send nothing — exactly one notification, at the third", async () => {
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate" }),
    });
    const wire = accepting();
    const records = store();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const perPass: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const out: TriagePassOutcome = await triagePass(
        deps({
          driver: spy.driver,
          records,
          cursor,
          delivery,
          memo,
          transport: wire.transport,
          now: T0 + i * CADENCE_MS,
        }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      perPass.push(out.notifications.length);
    }
    expect(cursor.consecutive_skips).toBe(6);
    expect(perPass).toEqual([0, 0, 1, 0, 0, 0]);
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.headers.Title).toContain("sweeps_skipped");
  });

  test("a skip says NOTHING about any environment, so a firing observer_blocked survives it", async () => {
    const firing: IncidentRecord = {
      ...freshIncidentRecord({ kind: "console_health", scope: ENVIRONMENT, health: "observer_blocked" }),
      state: "firing",
      reason: "observer_blocked",
      since: T0 - CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 2,
    };
    const records = store([firing]);
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate" }),
    });
    const out = await triagePass(deps({ driver: spy.driver, records }));
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
    expect(records.held.get("console_health:cni-dev/observer_blocked")?.state).toBe("firing");
  });
});

describe("the incident machine, driven by the pass", () => {
  test("a first unhealthy notifies NOTHING and leaves the record provisional", async () => {
    const records = store();
    const spy = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    const out = await triagePass(deps({ driver: spy.driver, records }));
    expect(out.notifications).toEqual([]);
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("provisional");
  });

  test("a second consecutive unhealthy notifies EXACTLY once, as `opened`", async () => {
    const records = store();
    const wire = accepting();
    const spy = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const emitted: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: spy.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      for (const n of out.notifications) emitted.push(`${n.kind}:${subjectKey(n.subject)}`);
    }
    expect(emitted).toEqual(["opened:service:cni-dev/mia"]);
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("firing");
    expect(wire.requests).toHaveLength(1);
  });

  test("ANTI: a service firing across 288 sweeps produces ONE opened plus the renotify floor", async () => {
    const records = store();
    const wire = accepting();
    const spy = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const instants: number[] = [];
    for (let i = 0; i < 288; i += 1) {
      const at = T0 + i * CADENCE_MS;
      const out = await triagePass(
        deps({ driver: spy.driver, records, cursor, delivery, memo, transport: wire.transport, now: at }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      for (const n of out.notifications) {
        if (subjectKey(n.subject) === "service:cni-dev/mia") instants.push(n.at);
      }
    }
    // The open lands on the second sweep (confirmation), then one reminder per
    // `renotify_after` (6h) across the 24h of 288 five-minute sweeps.
    const opened = T0 + CADENCE_MS;
    expect(instants).toEqual([opened, opened + 21_600_000, opened + 43_200_000, opened + 64_800_000]);
  });

  /**
   * §12's D13 block — *"the 288-a-day hole §6.8a was written to close, and
   * asserting it on the service path only would leave it open"*.
   *
   * The instants are asserted BY VALUE rather than the count, because a bare
   * count inherits the inclusivity ambiguity §6.8a was corrected for: whether
   * `[t0, t0+24h]` is four reminders or three depends on whether the window is
   * closed, and a criterion whose literal number depends on an unstated
   * convention makes a correct implementation red.
   */
  test("ANTI: an observer blocked on 288 consecutive sweeps produces ONE opened plus its reminders", async () => {
    const records = store();
    const wire = accepting();
    const spy = driver({ blocked: ["obs-t1"] });
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const instants: number[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 288; i += 1) {
      const out = await triagePass(
        deps({
          driver: spy.driver,
          records,
          cursor,
          delivery,
          memo,
          transport: wire.transport,
          now: T0 + i * CADENCE_MS,
        }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      for (const n of out.notifications) {
        if (subjectKey(n.subject) === "console_health:cni-dev/observer_blocked") {
          instants.push(n.at);
          kinds.push(n.kind);
        }
      }
    }
    const opened = T0 + CADENCE_MS;
    expect(instants).toEqual([opened, opened + 21_600_000, opened + 43_200_000, opened + 64_800_000]);
    expect(kinds).toEqual(["opened", "reminder", "reminder", "reminder"]);
  });

  test("ANTI: unhealthy → indeterminate is NOT a recovery", async () => {
    const records = store();
    const wire = accepting();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("firing");

    // One observer of three goes silent: `mia` is indeterminate, not healthy.
    const blind = driver({
      artifacts: (id) => [artifact("obs-t2", id), artifact("obs-t3", id)],
      rows: () => [healthyRow("authorization"), healthyRow("authentication")],
    });
    const out = await triagePass(
      deps({ driver: blind.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + 2 * CADENCE_MS }),
    );
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("firing");
  });

  test("a recovery requires an OBSERVED healthy with evidence, and names duration and sweeps", async () => {
    const records = store();
    const wire = accepting();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    const well = driver();
    const out = await triagePass(
      deps({ driver: well.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + 2 * CADENCE_MS }),
    );
    const recovery = out.notifications.filter((n) => n.kind === "recovered");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.firingForMs).toBe(CADENCE_MS);
    expect(recovery[0]?.sweepCount).toBe(2);
    /*
     * The ROW's own citation, not the collation document's. §6.8 asks for *"the
     * evidence that closed it"* — singular — and a sweep-level ref would send an
     * operator to `triage.json` to find the observation themselves. The pass
     * still supplies the sweep ref as `SweepObservationContext.evidenceRef`,
     * where it is the fallback for an ISSUE and never for a clear.
     */
    expect(recovery[0]?.evidenceRef).toBe("kubectl -n mia get deploy");
  });

  test("a `healthy` with an empty coverage[] is downgraded and does NOT clear a firing incident", async () => {
    const records = store();
    const wire = accepting();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    const unevidenced = driver({
      rows: () => [
        { ...healthyRow("mia"), coverage: [], evidence_ref: [] },
        healthyRow("authorization"),
        healthyRow("authentication"),
      ],
    });
    const out = await triagePass(
      deps({ driver: unevidenced.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + 2 * CADENCE_MS }),
    );
    expect(out.assessment?.services.find((s) => s.service === "mia")?.reason).toBe(
      "unevidenced_healthy",
    );
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("firing");
  });

  test(`${COVERAGE_THRESHOLD} consecutive blind sweeps escalate as COVERAGE, not as a service issue`, async () => {
    const records = store();
    const wire = accepting();
    // One observer silent: below SATURATION_MIN_MISSING, so no saturation.
    const blind = driver({
      artifacts: (id) => [artifact("obs-t2", id), artifact("obs-t3", id)],
      rows: () => [healthyRow("authorization"), healthyRow("authentication")],
    });
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const emitted: Array<{ kind: string; reason: string }> = [];
    for (let i = 0; i < COVERAGE_THRESHOLD; i += 1) {
      const out = await triagePass(
        deps({ driver: blind.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      for (const n of out.notifications) {
        if (subjectKey(n.subject) === "service:cni-dev/mia") emitted.push({ kind: n.kind, reason: n.reason });
      }
    }
    expect(emitted).toEqual([{ kind: "opened", reason: "coverage" }]);
  });
});

describe("saturation — the probe is deduplicated ACROSS sweeps, not only within one", () => {
  function saturatedDriver(): Spy {
    return driver({
      artifacts: (id) => [artifact("obs-t3", id)],
      rows: () => [healthyRow("authentication")],
    });
  }

  test("two observers missing is SATURATED, and the coverage counter does not advance", async () => {
    const records = store();
    let probes = 0;
    const spy = saturatedDriver();
    const out = await triagePass(
      deps({
        driver: spy.driver,
        records,
        transport: accepting().transport,
        probe: async () => {
          probes += 1;
          return timeoutProbe();
        },
      }),
    );
    expect(out.saturation?.verdict).toBe("saturated");
    expect(out.saturation?.suppressed).toBe(true);
    expect(out.saturation?.correlated).toEqual(["obs-t1", "obs-t2"]);
    expect(probes).toBe(1);
    for (const service of SERVICES) {
      expect(records.held.get(`service:cni-dev/${service}`)?.consecutive_indeterminate ?? 0).toBe(0);
    }
    expect(out.notifications.filter((n) => n.reason === "coverage")).toEqual([]);
    /*
     * `advanceIncident` answers a `suppressed` observation with the caller's OWN
     * object, and the pass writes only when that identity changes. So a saturated
     * sweep does not merely leave the counters alone — it does not touch a
     * service record at all, which is the assertion that separates "the machine
     * moved nothing" from "the machine moved something back".
     */
    expect(records.written.filter((r) => r.subject.kind === "service")).toEqual([]);
  });

  test("ANTI: twelve consecutive saturated sweeps probe ONCE, not twelve times", async () => {
    const records = store();
    const wire = accepting();
    const spy = saturatedDriver();
    let probes = 0;
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    for (let i = 0; i < 12; i += 1) {
      const out = await triagePass(
        deps({
          driver: spy.driver,
          records,
          cursor,
          delivery,
          memo,
          transport: wire.transport,
          now: T0 + i * CADENCE_MS,
          probe: async () => {
            probes += 1;
            return timeoutProbe();
          },
        }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      expect(out.saturation?.verdict).toBe("saturated");
    }
    expect(probes).toBe(1);
  });

  test("the candidate ENDS on a sweep that is not correlated, and the next one probes again", async () => {
    const records = store();
    const wire = accepting();
    let probes = 0;
    const probe = async (): Promise<ToolCallProbeResult> => {
      probes += 1;
      return timeoutProbe();
    };
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const run = async (spy: Spy, at: number): Promise<TriagePassOutcome> => {
      const out = await triagePass(
        deps({ driver: spy.driver, records, cursor, delivery, memo, transport: wire.transport, now: at, probe }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      return out;
    };
    await run(saturatedDriver(), T0);
    expect(probes).toBe(1);
    const clean = await run(driver(), T0 + CADENCE_MS);
    expect(clean.saturation?.verdict).toBe("clear");
    expect(clean.saturationMemo.result).toBeNull();
    expect(probes).toBe(1);
    await run(saturatedDriver(), T0 + 2 * CADENCE_MS);
    expect(probes).toBe(2);
  });

  test(`ANTI: one observer missing is NOT saturation, and the probe is never called`, async () => {
    const records = store();
    const spy = driver({
      artifacts: (id) => [artifact("obs-t2", id), artifact("obs-t3", id)],
      rows: () => [healthyRow("authorization"), healthyRow("authentication")],
    });
    const out = await triagePass(
      deps({ driver: spy.driver, records, transport: accepting().transport, probe: probeThatMustNotRun }),
    );
    expect(SATURATION_MIN_MISSING).toBe(2);
    expect(out.saturation?.verdict).toBe("uncorrelated");
    expect(records.held.get("service:cni-dev/mia")?.consecutive_indeterminate).toBe(1);
  });

  test("a clean sweep never probes at all", async () => {
    const out = await triagePass(deps({ probe: probeThatMustNotRun }));
    expect(out.saturation?.verdict).toBe("clear");
    expect(out.saturation?.saturated).toBe(false);
  });

  test("the saturation announcement names the PROVIDER and MODEL, never the environment", async () => {
    const records = store();
    const wire = accepting();
    const spy = saturatedDriver();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({
          driver: spy.driver,
          records,
          cursor,
          delivery,
          memo,
          transport: wire.transport,
          now: T0 + i * CADENCE_MS,
          probe: async () => timeoutProbe(),
        }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    const title = wire.requests.at(-1)?.headers.Title ?? "";
    expect(title).toContain(`${PROVIDER}/${MODEL}`);
    expect(title).not.toContain(ENVIRONMENT);
    expect(wire.requests).toHaveLength(1);
  });
});

describe("§9.15 — the record is written BEFORE the transport is called", () => {
  test("ISC-706 on the pass: the record is already `clear` at delivery time", async () => {
    const records = store();
    const wire = accepting();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    const seen: string[] = [];
    const capturing = async (): Promise<NotifyOutcome> => {
      seen.push(records.held.get("service:cni-dev/mia")?.state ?? "absent");
      return { status: "delivered", at: T0, httpStatus: 200, reason: null };
    };
    await triagePass(
      deps({ records, cursor, delivery, memo, transport: capturing, now: T0 + 2 * CADENCE_MS }),
    );
    expect(seen).toEqual(["clear"]);
  });

  test("ANTI: a delivery failure never advances or clears an incident — the loss lands in undelivered[]", async () => {
    const records = store();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const wire = accepting();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, transport: wire.transport, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
    }
    const failing = async (): Promise<NotifyOutcome> => ({
      status: "retryable",
      at: T0,
      httpStatus: 503,
      reason: "service unavailable",
    });
    const out = await triagePass(
      deps({ records, cursor, delivery, memo, transport: failing, now: T0 + 2 * CADENCE_MS }),
    );
    const record = records.held.get("service:cni-dev/mia");
    expect(record?.state).toBe("clear");
    expect(record?.undelivered).toHaveLength(1);
    expect(out.report.lost).toHaveLength(1);
    expect(record?.undelivered[0]).toBe(out.report.lost[0]!);
  });

  test("a console with `notify: null` still sweeps and still records transitions", async () => {
    const records = store();
    const wire = accepting();
    let cursor = freshCursor();
    let delivery = freshDeliveryState();
    let memo = freshSaturationMemo();
    const sick = driver({ rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")] });
    for (let i = 0; i < 2; i += 1) {
      const out = await triagePass(
        deps({ driver: sick.driver, records, cursor, delivery, memo, notify: null, transport: transportThatMustNotRun, now: T0 + i * CADENCE_MS }),
      );
      cursor = out.cursor;
      delivery = out.delivery;
      memo = out.saturationMemo;
      expect(out.report.status.channel).toBe("disabled");
    }
    expect(records.held.get("service:cni-dev/mia")?.state).toBe("firing");
    expect(wire.requests).toEqual([]);
  });
});

describe("the record store is a port, and a refused record is never acted on", () => {
  test("a refused read is reported and the subject is skipped", async () => {
    const records = store();
    const refusing: IncidentStore = {
      load: async (subject) =>
        subject.kind === "service" && subject.service === "mia"
          ? { kind: "refused", code: "schema", reason: "hand-edited", issues: [] }
          : records.load(subject),
      save: records.save,
    };
    const out = await triagePass(deps({ records: refusing }));
    expect(out.refused.map((r) => subjectKey(r.subject))).toEqual(["service:cni-dev/mia"]);
    expect(records.written.map((r) => subjectKey(r.subject))).not.toContain("service:cni-dev/mia");
  });
});

describe("budget exhaustion — §6.10's exit 5", () => {
  test("a refused admission dispatches nothing, consumes the id, and raises budget_exhausted", async () => {
    const spy = driver({ open: { kind: "budget_exhausted", reason: "run ceiling reached" } });
    const records = store();
    const out = await triagePass(deps({ driver: spy.driver, records }));
    expect(out.kind).toBe("budget_exhausted");
    expect(spy.dispatched).toEqual([]);
    expect(spy.collated).toEqual([]);
    expect(out.cursor.sweep_cursor).toBe(1);
    expect(records.held.get("console_health:_console/budget_exhausted")?.state).toBe("provisional");
  });

  /**
   * §6.8a rule 3, on the path most likely to break it: *"an actor that stopped
   * counting is not an actor that recovered"*.
   *
   * A pass that could not open a sweep did not sweep, so `sweeps_skipped` must
   * not clear. The counter is carried rather than reset, and the record is
   * asserted rather than only the cursor — the cursor is the hint and the record
   * is what an operator is told from.
   */
  test("a budget refusal carries the skip counter rather than clearing it", async () => {
    const skipped: IncidentRecord = {
      ...freshIncidentRecord({ kind: "console_health", scope: "_console", health: "sweeps_skipped" }),
      state: "firing",
      reason: "sweeps_skipped",
      since: T0 - 2 * CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 2,
    };
    const records = store([skipped]);
    const spy = driver({ open: { kind: "budget_exhausted", reason: "run ceiling reached" } });
    const out = await triagePass(
      deps({
        driver: spy.driver,
        records,
        cursor: { runs: {}, sweep_cursor: 3, consecutive_skips: 4 },
        transport: accepting().transport,
      }),
    );
    expect(out.cursor.consecutive_skips).toBe(4);
    expect(records.held.get("console_health:_console/sweeps_skipped")?.state).toBe("firing");
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
  });
});

describe("§9.15 surface 4 — a loss is attributed to the record it came from", () => {
  /**
   * **The ordering and the attribution are one property, and this is the fixture
   * that separates them.**
   *
   * `orderForDelivery` hoists the reporter's OWN recovery ahead of the sweep's
   * message (§9.15 surface 4), so the order the pass composed announcements in is
   * NOT the order they were attempted in. A pass that folded losses back by
   * composition position rather than by delivery position would put the service's
   * lost title on the reporter's record and the reporter's on the service's — and
   * every single-announcement fixture in this file passes either way.
   *
   * The reporter's recovery is reached by seeding: the RECORD is `firing` and the
   * pass-start delivery state is clean, which is exactly the state §9.15
   * describes — *"the reporter was unable to deliver … and then the channel
   * answered"*.
   */
  test("a reorder does not misfile the loss: each record holds ITS OWN title", async () => {
    const reporter: IncidentRecord = {
      ...freshIncidentRecord({ kind: "console_health", scope: "_console", health: "reporter_undelivered" }),
      state: "firing",
      reason: "reporter_undelivered",
      since: T0 - 3 * CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 3,
    };
    const sick: IncidentRecord = {
      ...freshIncidentRecord(serviceSubject("mia")),
      state: "provisional",
      reason: "unhealthy",
      since: T0 - CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 1,
    };
    const records = store([reporter, sick]);
    const spy = driver({
      rows: () => [row("mia", "unhealthy"), healthyRow("authorization"), healthyRow("authentication")],
    });
    const failing = async (): Promise<NotifyOutcome> => ({
      status: "retryable",
      at: T0,
      httpStatus: 503,
      reason: "service unavailable",
    });
    const out = await triagePass(deps({ driver: spy.driver, records, transport: failing }));

    // The premise: two announcements, and the reporter's recovery is not the one
    // the pass composed first. A fixture with one announcement proves nothing.
    expect(out.notifications).toHaveLength(2);
    expect(out.notifications[0]?.subject.kind).toBe("service");
    expect(out.report.lost).toHaveLength(2);

    const service = records.held.get("service:cni-dev/mia");
    const channel = records.held.get("console_health:_console/reporter_undelivered");
    expect(service?.undelivered).toHaveLength(1);
    expect(channel?.undelivered).toHaveLength(1);
    expect(service?.undelivered[0]).toContain("mia");
    expect(channel?.undelivered[0]).toContain("reporter_undelivered");
    expect(service?.undelivered[0]).not.toContain("reporter_undelivered");
  });
});

describe("the memo is a value in and a value out", () => {
  test("FRESH_SATURATION_MEMO and the factory agree, and the factory does not alias", () => {
    expect(freshSaturationMemo()).toEqual(FRESH_SATURATION_MEMO);
    expect(freshSaturationMemo()).not.toBe(freshSaturationMemo());
  });
});
