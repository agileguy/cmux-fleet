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
  resumedCursor,
  triagePass,
  unreachableFrom,
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
  type ConsoleHealthKind,
  type IncidentRecord,
  type IncidentSubject,
} from "../../src/run/triage-incident.ts";
import { defaultTriageConsoleConfig } from "../../src/run/triage-config.ts";
import { stripComments } from "../support/source-structure.ts";
import { freshDeliveryState, type NotifyOutcome, type NotifyRequest } from "../../src/run/triage-notify.ts";
import {
  SATURATION_MIN_MISSING,
  SATURATION_VERDICTS,
  type DeclaredEnvironment,
  type ObserverArtifact,
  type SaturationOutcome,
  type SaturationVerdict,
  type TriageDocument,
  type TriageRow,
} from "../../src/run/triage-verdict.ts";
import type { PartitionAssignment } from "../../src/run/triage-partition.ts";
import type { TriageActorCursor } from "../../src/run/triage-actor.ts";
import { sweepTaskId } from "../../src/run/task-ids.ts";
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

/**
 * The instant an in-flight fixture's sweep was dispatched — ISC-1168.
 *
 * The pass's OWN clock, so every fixture below is a sweep of age zero: plainly
 * inside `sweepExpiryS`, and therefore still the skip each of these tests was
 * written to assert. Dating them `null` would have compiled equally well and
 * would have been worse — it would have converted the whole file into the
 * "cannot be dated" case and quietly stopped exercising the dated path at all.
 *
 * A test that WANTS the expiry moves the clock forward with `deps({ now })`
 * rather than back-dating the sweep, so the sweep stays fixed and the thing
 * under test is the elapsed time.
 */
const DISPATCHED_NOW = new Date(T0).toISOString();

function partition(): PartitionAssignment[] {
  return [
    { worker: SEATS[0], services: [SERVICES[0]] },
    { worker: SEATS[1], services: [SERVICES[1]] },
    { worker: SEATS[2], services: [SERVICES[2]] },
  ];
}

function artifact(worker: string, sweepId: string): ObserverArtifact {
  return artifactAt(worker, sweepId, clock.at);
}

/**
 * An artifact whose window echo is pinned to a stated dispatch instant rather
 * than to the fixture clock.
 *
 * §13 task 6.4a needs the two to DIFFER: a resumed sweep is assessed an outage
 * later than it was dispatched, and an artifact echoing the resuming pass's own
 * clock could not tell a carried `dispatched_at` from a re-minted one.
 */
function artifactAt(worker: string, sweepId: string, dispatchedAtMs: number): ObserverArtifact {
  return {
    worker,
    sweep_id: sweepId,
    window_opened_at: new Date(dispatchedAtMs - DEFAULT_WINDOW_S * 1_000).toISOString(),
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
  /** §13 task 6.4a's run-tree read — a sweep abandoned before its collation. */
  readonly resumable?: SweepDriver["resumableSweep"];
  readonly open?: SweepOpen;
  readonly assignments?: readonly PartitionAssignment[];
  readonly artifacts?: (sweepId: string) => readonly ObserverArtifact[];
  readonly blocked?: readonly string[];
  readonly claimedSuccess?: readonly string[];
  readonly rows?: (sweepId: string) => readonly TriageRow[];
  readonly collation?: (sweepId: string) => SweepCollation;
  readonly highest?: number;
}

interface Spy {
  readonly driver: SweepDriver;
  readonly opened: string[];
  readonly dispatched: Array<{ sweepId: string; worker: string }>;
  readonly collated: string[];
  /** Which sweep ids were JOINED, in order — task 6.4a asks the OLD one first. */
  readonly joined: string[];
  /** The `dispatched_at` each assessment was built against, in order. */
  readonly partitioned: string[];
}

function driver(opts: DriverOptions = {}): Spy {
  const opened: string[] = [];
  const dispatched: Array<{ sweepId: string; worker: string }> = [];
  const collated: string[] = [];
  const joined: string[] = [];
  const partitioned: string[] = [];
  const assignments = opts.assignments ?? partition();
  return {
    opened,
    dispatched,
    collated,
    joined,
    partitioned,
    driver: {
      inFlight: opts.inFlight ?? (async () => null),
      resumableSweep: opts.resumable ?? (async () => null),
      highestSweepNumber: async () => opts.highest ?? 0,
      runs: async () => ({ "tri-1": "RUN-A", "obs-t1": "RUN-A", "obs-t2": "RUN-A", "obs-t3": "RUN-A" }),
      openSweep: async (sweepId) => {
        opened.push(sweepId);
        return opts.open ?? { kind: "opened" };
      },
      readPartition: async (sweepId) => {
        partitioned.push(sweepId);
        return assignments;
      },
      dispatchObserver: async (sweepId, assignment) => {
        dispatched.push({ sweepId, worker: assignment.worker });
      },
      join: async (sweepId): Promise<SweepJoin> => {
        joined.push(sweepId);
        return {
          artifacts: opts.artifacts?.(sweepId) ?? SEATS.map((s) => artifact(s, sweepId)),
          blocked: opts.blocked ?? [],
          claimedSuccess: opts.claimedSuccess ?? [],
        };
      },
      collate: async (sweepId): Promise<SweepCollation> => {
        collated.push(sweepId);
        if (opts.collation !== undefined) return opts.collation(sweepId);
        const rows = opts.rows?.(sweepId) ?? SERVICES.map((s) => healthyRow(s));
        return {
          document: document(sweepId, rows),
          evidenceRef: `${sweepId}/triage.json`,
          // The default fake is a CLEAN sweep, so no collator replayed. A test
          // that wants the stale arm supplies its own `collation`.
          staleCollators: [],
        };
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
  /** Defaults to {@link ENVIRONMENT}. Only task 3.3's own tests override it. */
  readonly environment?: string;
  /** Defaults to the one k8s environment and its services the rest of this fixture world sweeps. */
  readonly declared?: readonly DeclaredEnvironment[];
}

/** {@link deps}'s default {@link TriagePassDeps.declared} — the one k8s environment. */
const K8S_DECLARED: readonly DeclaredEnvironment[] = [
  { name: ENVIRONMENT, kind: "k8s", services: [...SERVICES] },
];

function deps(opts: DepsOptions = {}): TriagePassDeps {
  const config = defaultTriageConsoleConfig();
  clock.at = opts.now ?? T0;
  return {
    environment: opts.environment ?? ENVIRONMENT,
    declared: opts.declared ?? K8S_DECLARED,
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
   * The probe answers `unreachable` rather than `timeout`, so `saturated` stays
   * `null` and `inference_saturated` gets no observation at all — which is still
   * the assertion on the last line and is what keeps the two halves of §6.7 rule
   * 3 from collapsing into one.
   *
   * **The isolation argument this docblock used to make expired with §13 task
   * 5.4e (ISC-824), and the expectation below is the evidence that it landed.**
   * When it was written, an `unreachable` verdict composed NOTHING — the pass did
   * not compute `ConsoleHealthFacts.unreachable` — so one probe class was silent
   * and could be used to isolate a third kind. It is no longer silent: a zero-row
   * sweep against a dead endpoint now says both *"this sweep produced nothing"*,
   * scoped to the environment, and *"the inference endpoint is unreachable"*,
   * scoped to the console. That is §13 task 5.4d's own recorded mitigation — *"when
   * the endpoint is really down, NO observer produces an artifact, so §6.5's
   * zero-row raises `sweep_produced_nothing` and the console does speak"* — with
   * both sentences arriving instead of one.
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
    expect(emitted).toEqual([
      "opened:console_health:cni-dev/sweep_produced_nothing",
      "opened:console_health:_console/inference_unreachable",
    ]);
    // The two halves do not collapse: a probe that could not CONNECT says nothing
    // about whether the endpoint is slow, so the saturation record is never
    // written at all.
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
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate", dispatchedAt: DISPATCHED_NOW }),
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("skipped");
    expect(out.waitingOn).toBe("T-sweep-7-collate");
    expect(out.sweepId).toBe("T-sweep-7");
    expect(spy.opened).toEqual([]);
    expect(spy.dispatched).toEqual([]);
    expect(spy.collated).toEqual([]);
  });

  /**
   * ISC-1168 — **the bound, and the three fixtures are one fact apart.**
   *
   * The sweep is identical in all three: same id, same `waitingOn`, same
   * dispatch instant. Only the pass's clock moves. That is deliberate — a
   * fixture set that also varied the sweep could pass while the code branched
   * on the wrong one of the two, and the defect being fixed is precisely a
   * predicate that reads everything about a sweep EXCEPT how long it has owed.
   *
   * 900 s is `max(max_consecutive_skips × cadence_s, 2 × sweep_deadline_s)` at
   * the schema defaults — `max(3 × 300, 2 × 240)`.
   */
  test("a sweep past the expiry is NOT skipped: the console sweeps again", async () => {
    const spy = driver({
      inFlight: async () => ({
        sweepId: "T-sweep-7",
        waitingOn: "T-sweep-7-collate",
        dispatchedAt: DISPATCHED_NOW,
      }),
    });
    const out = await triagePass(deps({ driver: spy.driver, now: T0 + 901_000 }));
    // The whole point: it swept rather than skipping, so the console recovered
    // without an operator. Eleven consecutive skips on `T-sweep-127` is the
    // measurement this replaces.
    expect(out.kind).toBe("swept");
    expect(spy.opened).toEqual(["T-sweep-1"]);
    expect(out.expired).toEqual({
      sweepId: "T-sweep-7",
      waitingOn: "T-sweep-7-collate",
      ageS: 901,
    });
  });

  test("one second before the expiry it is still a skip, and nothing is dispatched", async () => {
    const spy = driver({
      inFlight: async () => ({
        sweepId: "T-sweep-7",
        waitingOn: "T-sweep-7-collate",
        dispatchedAt: DISPATCHED_NOW,
      }),
    });
    const out = await triagePass(deps({ driver: spy.driver, now: T0 + 899_000 }));
    expect(out.kind).toBe("skipped");
    expect(out.expired).toBeNull();
    expect(spy.opened).toEqual([]);
    expect(spy.dispatched).toEqual([]);
  });

  /**
   * **A sweep that cannot be DATED is never expired**, however long the clock
   * runs — the same refusal `resumableSweep` makes, and for the same reason.
   *
   * A year is used rather than a few minutes so the assertion cannot be read as
   * "not expired yet". There is no elapsed time that expires an undated sweep;
   * the bound is not a slower version of this answer, it is a different one.
   */
  test("a sweep whose envelope carries no dispatch instant is never expired", async () => {
    const spy = driver({
      inFlight: async () => ({
        sweepId: "T-sweep-7",
        waitingOn: "T-sweep-7-collate",
        dispatchedAt: null,
      }),
    });
    const out = await triagePass(deps({ driver: spy.driver, now: T0 + 365 * 24 * 3_600_000 }));
    expect(out.kind).toBe("skipped");
    expect(out.expired).toBeNull();
    expect(spy.opened).toEqual([]);
  });

  test("a skip advances the skip counter and NOT the sweep cursor", async () => {
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate", dispatchedAt: DISPATCHED_NOW }),
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

  /**
   * **This fixture is UNDATED, and after ISC-1168 it has to be.**
   *
   * The loop below advances the clock a cadence per pass, so a DATED sweep now
   * crosses `sweepExpiryS` at the fourth pass and sweeps instead of skipping —
   * which is the bound working, and is asserted three tests up. Six consecutive
   * skips remain reachable in production for exactly one reason: a sweep whose
   * envelope cannot be dated is never expired, however long it owes.
   *
   * So the dedup rule still has a real case to be tested against, and it is
   * this one. The alternative — loosening the assertion to whatever the bound
   * now produces — would have deleted [[ISC-673]]'s "288 into 1" coverage to
   * make a red test green, which is the shape this file exists to refuse.
   */
  test("ANTI: skips 4, 5 and 6 send nothing — exactly one notification, at the third", async () => {
    const spy = driver({
      inFlight: async () => ({
        sweepId: "T-sweep-7",
        waitingOn: "T-sweep-7-collate",
        dispatchedAt: null,
      }),
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

  /**
   * §13 task 6.4 — resume-from-run-tree, and §6.4's *"the run tree is
   * authoritative and the record is a cursor"*.
   *
   * The three fixtures below are ASYMMETRIC on purpose: the record says `0`, the
   * run tree says `12`, and a fresh sweep would be `13`. Three distinct numbers,
   * so *"continued"*, *"restarted"* and *"reset"* are each distinguishable from the
   * other two — a fixture in which the old sweep and the new one carried the same
   * id could not tell any of them apart.
   */
  test("premise: the record, the run tree and a fresh sweep are THREE different numbers", async () => {
    // The premise asserted a step earlier: with nothing in flight, this exact
    // driver mints and opens `T-sweep-13` — so the resume below is a change of
    // behaviour on one fact and not a fixture that could never have dispatched.
    const spy = driver({ highest: 12 });
    const out = await triagePass(deps({ driver: spy.driver, cursor: freshCursor() }));
    expect(freshCursor().sweep_cursor).toBe(0);
    expect(out.sweepId).toBe(sweepTaskId(13));
    expect(spy.opened).toEqual([sweepTaskId(13)]);
    expect(new Set([0, 12, 13]).size).toBe(3);
  });

  test("ANTI: a restarted actor with an EMPTY record RESUMES the in-flight sweep and dispatches nothing", async () => {
    const spy = driver({
      highest: 12,
      inFlight: async () => ({ sweepId: sweepTaskId(12), waitingOn: "T-sweep-12-collate", dispatchedAt: DISPATCHED_NOW }),
    });
    const out = await triagePass(deps({ driver: spy.driver, cursor: freshCursor() }));
    // Nothing is opened, nothing is dispatched, nothing is collated: §12's
    // *"the failure it prevents is two concurrent sweeps against one control
    // plane"*, and it is a property of the code rather than of the assertion.
    expect(spy.opened).toEqual([]);
    expect(spy.dispatched).toEqual([]);
    expect(spy.collated).toEqual([]);
    // The sweep the actor is now on is the run tree's, not a new one.
    expect(out.sweepId).toBe(sweepTaskId(12));
    expect(out.waitingOn).toBe("T-sweep-12-collate");
    // And the RECORD adopts it — the half that was missing. A cursor left at `0`
    // is a record that disagrees with the run tree about which sweep this console
    // is on, and §7.7's record is what `--status` reads.
    expect(out.cursor.sweep_cursor).toBe(12);
  });

  /**
   * The consequence, and the reason the line above is a correctness fix rather
   * than cosmetics.
   *
   * `highestSweepNumber` answers `0` on an unreadable inbox by design — an absent
   * inbox is the ordinary state of a console that has never swept. So the pass
   * after the resume is driven with the run tree reading `0`: with the adopted
   * cursor it mints `T-sweep-13`, and without it it would mint `T-sweep-1`, an id
   * the epoch fence has already seen. **ISC-743's stated symptom class exactly**,
   * and the fixture separates the two by ELEVEN, not by one.
   */
  test("after a resume the next sweep is minted from the RECORD even when the run tree reads 0", async () => {
    const skipping = driver({
      highest: 12,
      inFlight: async () => ({ sweepId: sweepTaskId(12), waitingOn: "T-sweep-12-collate", dispatchedAt: DISPATCHED_NOW }),
    });
    const first = await triagePass(deps({ driver: skipping.driver, cursor: freshCursor() }));
    expect(first.kind).toBe("skipped");
    expect(first.cursor.sweep_cursor).toBe(12);

    const blind = driver({ highest: 0 });
    const second = await triagePass(
      deps({ driver: blind.driver, cursor: first.cursor, now: T0 + CADENCE_MS }),
    );
    expect(second.sweepId).toBe(sweepTaskId(13));
    expect(blind.opened).toEqual([sweepTaskId(13)]);
    expect(second.sweepId).not.toBe(sweepTaskId(1));
  });

  /**
   * The pass mints sweep ids through ONE module, and this is the probe.
   *
   * `relay.ts:116-135` names this file in advance — *"the next consumer of these
   * names is the triage actor's pass"* — and states the rule: *"names added to
   * `task-ids.ts` after the extraction are imported FROM `task-ids.ts`."* The pass
   * held a second spelling anyway, which the ACTOR mints from and `inFlightSweep`
   * reads back, agreeing by coincidence with nothing pinning them equal. This
   * asserts the import edge exists and that no local spelling of the prefix
   * survives beside it.
   *
   * **The scan is over COMMENT-STRIPPED code, and the first version of this test
   * proved why.** `triage-pass.ts`'s prose names the id grammar five times, all
   * of them truthfully, so a raw substring scan reddened on documentation — the
   * exact failure `triage-verdict.ts` records for its own fence: *"Comments are
   * stripped rather than matched around because a docblock that QUOTES the
   * pattern reddens the probe."* `stripComments` is the suite's own helper rather
   * than a second one written here. The needle is still ASSEMBLED at runtime,
   * because this file is scanned by no probe today and might be tomorrow.
   */
  test("the pass mints sweep ids through task-ids.ts and holds no second spelling", () => {
    const raw = readFileSync(join(import.meta.dir, "../../src/run/triage-pass.ts"), "utf8");
    const code = stripComments(raw);
    expect(code).toContain('from "./task-ids.ts"');
    expect(code).toContain("sweepTaskId");
    const spelling = "T-" + "sweep-";
    // The prose DOES name the grammar, repeatedly and correctly — which is why
    // the scan is over the stripped code and the raw text is asserted to differ.
    expect(raw.includes(spelling)).toBe(true);
    expect(code.includes(spelling)).toBe(false);
    // And the canonical minter is the one that refuses a counter it cannot spell.
    expect(() => sweepTaskId(0)).toThrow();
    expect(sweepTaskId(13)).toBe(spelling + "13");
  });

  /** The cursor is MONOTONE: a run tree that reads low never moves it back. */
  test("resumedCursor never moves the cursor backwards onto a dispatched id", () => {
    expect(resumedCursor(12, 0)).toBe(12);
    expect(resumedCursor(0, 12)).toBe(12);
    expect(resumedCursor(12, 12)).toBe(12);
    expect(resumedCursor(11, 12)).toBe(12);
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
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate", dispatchedAt: DISPATCHED_NOW }),
    });
    const out = await triagePass(deps({ driver: spy.driver, records }));
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
    expect(records.held.get("console_health:cni-dev/observer_blocked")?.state).toBe("firing");
  });
});

/**
 * §13 task 6.4a — ISC-868, and the discrimination that makes it safe.
 *
 * ## Why "the record is behind the run tree" was refused as the signal
 *
 * ISC-868 was filed OPEN rather than built blind, and the reason is the anti-twin
 * below. `inFlight` reports a sweep exactly while a WORKER task is outstanding,
 * and the genuinely abandoned states read `null` through that port — §6.4's
 * corrected predicate collapses *"parent settled, no collation"* into `null` so
 * that §6.5's zero-row cannot wedge the actor (ISC-805). Resuming on the cursor
 * lag alone would therefore re-drive the incident machine over a document it had
 * already consumed: two `unhealthy` observations from ONE sweep, which opens a
 * firing incident on a single sweep's evidence and is what ISC-712 forbids.
 *
 * The read that separates them is `resumableSweep`, and the fact that separates
 * the two sweeps it returns is **whether any observer produced an artifact**.
 * That is not a heuristic. The pass dispatches a collation if and only if the
 * join found artifacts, so *artifacts present AND no `-collate` task* is a proof
 * that this sweep never reached step 8 — and a sweep that never reached step 8
 * produced no document for the machine to have consumed.
 */
describe("§13 task 6.4a: an abandoned sweep is carried to collation, and the zero-row is not", () => {
  const DISPATCHED_AT = new Date(T0).toISOString();
  /** An hour after the sweep was dispatched — the actor was down in between. */
  const AN_OUTAGE_LATER = T0 + 3_600_000;

  function abandoned(withArtifacts: boolean): Spy {
    return driver({
      highest: 7,
      resumable: async () => ({ sweepId: "T-sweep-7", dispatchedAt: DISPATCHED_AT }),
      artifacts: (sweepId) =>
        withArtifacts && sweepId === "T-sweep-7"
          ? SEATS.map((s) => artifactAt(s, sweepId, T0))
          : [],
    });
  }

  /**
   * **THE PREMISE, asserted a step earlier**, because the fixture is worthless
   * without it: if the sweep to be resumed and the sweep a fresh tick would mint
   * had the same id, *"collated the old one"* and *"minted a new one"* would be
   * the same observation and every assertion below would pass on either
   * behaviour.
   */
  test("the resumed id and the id a fresh tick would mint are DIFFERENT ids", async () => {
    const spy = abandoned(true);
    const resumable = await spy.driver.resumableSweep();
    expect(resumable?.sweepId).toBe("T-sweep-7");
    expect(sweepTaskId((await spy.driver.highestSweepNumber()) + 1)).toBe("T-sweep-8");
    expect(resumable?.sweepId).not.toBe("T-sweep-8");
  });

  test("a settled parent with artifacts and no collate task IS collated, not superseded", async () => {
    const spy = abandoned(true);
    const delivered = accepting(AN_OUTAGE_LATER);
    const out = await triagePass(
      deps({
        driver: spy.driver,
        now: AN_OUTAGE_LATER,
        transport: delivered.transport,
        /*
         * A NON-ZERO skip count, because §6.8a's *"cleared by a sweep that
         * ran"* is unobservable from a fresh cursor: `0` before and `0` after
         * would pass an implementation that carried the count instead of
         * resetting it. The outage that abandoned the sweep is also what ran
         * the count up, so this is the realistic cursor as well as the
         * discriminating one.
         */
        cursor: { runs: {}, sweep_cursor: 0, consecutive_skips: 3 },
      }),
    );

    // The old sweep reached step 8. Nothing minted the eighth id, and no
    // observer was dispatched a second time over work it had already done.
    expect(spy.collated).toEqual(["T-sweep-7"]);
    expect(spy.opened).toEqual([]);
    expect(spy.dispatched).toEqual([]);
    // The partition read is the OLD sweep's too: coverage for the resumed sweep
    // must come from the request its own observers were dispatched from.
    expect(spy.partitioned).toEqual(["T-sweep-7"]);
    expect(spy.joined).toEqual(["T-sweep-7"]);
    expect(out.kind).toBe("swept");
    expect(out.sweepId).toBe("T-sweep-7");
    expect(out.dispatched).toEqual([]);
    // §6.6 layer 2: the cursor lands on the sweep that was carried, so the next
    // tick mints the eighth rather than re-deriving the seventh.
    expect(out.cursor.sweep_cursor).toBe(7);
    // A sweep that RAN — resumed or minted — resets §6.4's counter.
    expect(out.cursor.consecutive_skips).toBe(0);
  });

  /**
   * The carried `dispatched_at` is the SWEEP's, never the resuming pass's clock,
   * and this fixture is an hour apart so the two cannot be confused. §7.4's echo
   * refuses an artifact opened earlier than
   * `dispatched_at − default_window − reserve_s`; against `now` every observer
   * here would be refused as `stale_window`, and three innocent observers would
   * be named for an outage the console itself had.
   */
  test("the resumed sweep is assessed against its OWN dispatch time, not the resuming clock", async () => {
    const spy = abandoned(true);
    const delivered = accepting(AN_OUTAGE_LATER);
    const out = await triagePass(
      deps({ driver: spy.driver, now: AN_OUTAGE_LATER, transport: delivered.transport }),
    );
    expect(out.assessment?.stale_window).toEqual([]);
    expect(out.assessment?.census.counted).toBe(3);
    expect(out.assessment?.services.map((s) => s.assessment)).toEqual([
      "healthy",
      "healthy",
      "healthy",
    ]);
  });

  /**
   * **THE ANTI-TWIN, and it outranks the criterion above.** §6.5's zero-row is
   * the same run-tree shape — parent settled, no `-collate` task — with NO
   * artifacts, because no child succeeded and so no collation was ever
   * dispatched. It has already been through the incident machine. Collating it
   * would spend a worker turn on a document with no rows; resuming it would do
   * that on every tick, forever, and the console would never sweep again.
   */
  test("§6.5's zero-row — the same shape with NO artifacts — mints the next id instead", async () => {
    const spy = abandoned(false);
    const delivered = accepting();
    const out = await triagePass(
      // Both sweeps observe nothing, so §6.7 rule 3's correlation gate opens and
      // the probe is reached. It answers `timeout` rather than being forbidden.
      deps({ driver: spy.driver, transport: delivered.transport, probe: async () => timeoutProbe() }),
    );
    // Asked the abandoned sweep first, found nothing to carry, swept the next.
    expect(spy.joined).toEqual(["T-sweep-7", "T-sweep-8"]);
    expect(spy.opened).toEqual(["T-sweep-8"]);
    // §6.5: with no child succeeding, no collation is dispatched — for EITHER.
    expect(spy.collated).toEqual([]);
    expect(out.sweepId).toBe("T-sweep-8");
    expect(out.cursor.sweep_cursor).toBe(8);
  });

  /**
   * *"…rather than collate forever."* One pass minting the next id is not enough
   * to show the machine is unwedged: a zero-row that re-presents itself on the
   * following tick must advance again. Two consecutive passes, each finding the
   * previous sweep abandoned-and-empty, must mint two DIFFERENT ids.
   */
  test("a zero-row on the next tick advances again — the console is not wedged", async () => {
    const first = abandoned(false);
    const one = await triagePass(
      deps({
        driver: first.driver,
        transport: accepting().transport,
        probe: async () => timeoutProbe(),
      }),
    );

    const second = driver({
      highest: 8,
      resumable: async () => ({ sweepId: "T-sweep-8", dispatchedAt: DISPATCHED_AT }),
      artifacts: () => [],
    });
    const two = await triagePass(
      deps({
        driver: second.driver,
        cursor: one.cursor,
        now: T0 + CADENCE_MS,
        transport: accepting(T0 + CADENCE_MS).transport,
        probe: async () => timeoutProbe(),
        memo: one.saturationMemo,
      }),
    );
    expect(second.opened).toEqual(["T-sweep-9"]);
    expect(one.sweepId).toBe("T-sweep-8");
    expect(two.sweepId).toBe("T-sweep-9");
  });

  /**
   * §6.4's SKIP still outranks the resume, and the port that would answer
   * otherwise is never even asked. A live sweep is a worker's outstanding turn;
   * carrying it to collation would be the host taking a step it does not own,
   * and racing `tri-1` to write the same document.
   */
  test("a live in-flight sweep still skips, and the resumable read is never consulted", async () => {
    const spy = driver({
      highest: 7,
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate", dispatchedAt: DISPATCHED_NOW }),
      resumable: async () => {
        throw new Error("resumableSweep was consulted on a sweep a worker still owes");
      },
    });
    const out = await triagePass(deps({ driver: spy.driver }));
    expect(out.kind).toBe("skipped");
    expect(out.waitingOn).toBe("T-sweep-7-collate");
    expect(spy.collated).toEqual([]);
    expect(spy.opened).toEqual([]);
  });

  /**
   * The ordinary tick is unchanged: with nothing abandoned the pass mints,
   * opens, dispatches and collates the new id, and asks the old one for nothing.
   */
  test("with no abandoned sweep the pass mints and dispatches as before", async () => {
    const spy = driver({ highest: 7 });
    const out = await triagePass(deps({ driver: spy.driver, transport: accepting().transport }));
    expect(spy.opened).toEqual(["T-sweep-8"]);
    expect(spy.joined).toEqual(["T-sweep-8"]);
    expect(spy.collated).toEqual(["T-sweep-8"]);
    expect(out.sweepId).toBe("T-sweep-8");
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

/**
 * §13 task 5.4e / ISC-824 — the seventh kind, reached through the PASS.
 *
 * ISC-820..823 are all satisfiable by hand-built `ConsoleHealthFacts`, which is
 * why the enum member could ship with nothing computing it. Every fixture here
 * drives `triagePass` end to end, so the `SaturationOutcome` under test is the one
 * real `saturationVerdict` produced from a real fixture run tree — an assertion a
 * hand-built fact cannot make.
 */
describe("the seventh kind — §6.8a's (saturated, unreachable) pair, computed in production", () => {
  /** `probeNativeToolCalls`' `unreachable` class — the endpoint is DOWN, not slow. */
  function unreachableProbe(): ToolCallProbeResult {
    return { ok: false, failure: "unreachable", detail: "connect ECONNREFUSED" } as ToolCallProbeResult;
  }

  /** Neither failure class: the correlation is real and the probe settled nothing. */
  function inconclusiveProbe(): ToolCallProbeResult {
    return { ok: false, failure: "prose", detail: "answered in prose" } as ToolCallProbeResult;
  }

  /** Two of three observers missing — `SATURATION_MIN_MISSING`, so the probe runs. */
  function correlatedDriver(): Spy {
    return driver({
      artifacts: (id) => [artifact("obs-t3", id)],
      rows: () => [healthyRow("authentication")],
    });
  }

  /** One of three missing — correlated, but below the gate. */
  function uncorrelatedDriver(): Spy {
    return driver({
      artifacts: (id) => [artifact("obs-t2", id), artifact("obs-t3", id)],
      rows: () => [healthyRow("authorization"), healthyRow("authentication")],
    });
  }

  const CONSOLE_SCOPE = "_console";
  const SATURATED_KEY = `console_health:${CONSOLE_SCOPE}/inference_saturated`;
  const UNREACHABLE_KEY = `console_health:${CONSOLE_SCOPE}/inference_unreachable`;

  /**
   * One pass, and what it left on the two console-health records.
   *
   * A record's `reason` is the field that says which kind was RAISED; a record the
   * pass never advanced is absent from the store entirely, because `store()` only
   * holds what `save` was called with. So `undefined` here means *"this sweep said
   * nothing about that kind"* and is the silence the anti-twin is about.
   */
  async function pairFrom(spy: Spy, probe: () => Promise<ToolCallProbeResult>) {
    const records = store();
    const out = await triagePass(
      deps({ driver: spy.driver, records, transport: accepting().transport, probe }),
    );
    return {
      verdict: out.saturation?.verdict,
      saturated: records.held.get(SATURATED_KEY)?.reason,
      unreachable: records.held.get(UNREACHABLE_KEY)?.reason,
      records,
    };
  }

  /**
   * PREMISE, on the degenerate-fixture rule: the two fixtures this task is about
   * must produce DIFFERENT verdicts through the real verdict function. A pair of
   * fixtures that both landed on `saturated` would pass every assertion below
   * against a pass that read one field for both kinds.
   */
  test("premise: the timeout fixture and the unreachable fixture reach DIFFERENT verdicts", async () => {
    const down = await pairFrom(correlatedDriver(), async () => unreachableProbe());
    const slow = await pairFrom(correlatedDriver(), async () => timeoutProbe());
    expect(down.verdict).toBe("endpoint_down");
    expect(slow.verdict).toBe("saturated");
    expect(down.verdict).not.toBe(slow.verdict);
  });

  test("an `endpoint_down` sweep produces unreachable: true with saturated: null", async () => {
    const said = await pairFrom(correlatedDriver(), async () => unreachableProbe());
    expect(said.unreachable).toBe("inference_unreachable");
    // `saturated: null` composes NOTHING, so the record is never written at all.
    expect(said.saturated).toBeUndefined();
    expect(said.records.written.map((r) => subjectKey(r.subject))).toContain(UNREACHABLE_KEY);
    expect(said.records.written.map((r) => subjectKey(r.subject))).not.toContain(SATURATED_KEY);
  });

  test("ANTI-TWIN: a `timeout` sweep produces saturated: true and says NOTHING about reachable", async () => {
    const said = await pairFrom(correlatedDriver(), async () => timeoutProbe());
    expect(said.saturated).toBe("inference_saturated");
    expect(said.unreachable).toBeUndefined();
    expect(said.records.written.map((r) => subjectKey(r.subject))).not.toContain(UNREACHABLE_KEY);
  });

  /**
   * §6.8a's clearing rule, and the half a naive `!== "endpoint_down"` gets wrong.
   *
   * A `saturated` verdict must leave `unreachable` at `null` rather than at
   * `false`. The two are indistinguishable on a fresh record — neither writes
   * anything — so the discrimination needs a record that is already `firing`: a
   * `false` would CLEAR it, and that is ISC-675's absence-as-evidence mistake with
   * a different fault as the disguise.
   */
  test("a `timeout` does NOT clear a firing `inference_unreachable` — null is not false", async () => {
    const firing: IncidentRecord = {
      ...freshIncidentRecord({
        kind: "console_health",
        scope: CONSOLE_SCOPE,
        health: "inference_unreachable",
      }),
      state: "firing",
      reason: "inference_unreachable",
      since: T0 - CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 2,
    };
    const records = store([firing]);
    const out = await triagePass(
      deps({
        driver: correlatedDriver().driver,
        records,
        transport: accepting().transport,
        probe: async () => timeoutProbe(),
      }),
    );
    expect(records.held.get(UNREACHABLE_KEY)?.state).toBe("firing");
    expect(out.notifications.map((n) => n.kind)).not.toContain("recovered");
  });

  /** And the mirror: a CLEAN sweep is the one fact that does clear it. */
  test("a clean sweep clears a firing `inference_unreachable`, so the silence above is a rule", async () => {
    const firing: IncidentRecord = {
      ...freshIncidentRecord({
        kind: "console_health",
        scope: CONSOLE_SCOPE,
        health: "inference_unreachable",
      }),
      state: "firing",
      reason: "inference_unreachable",
      since: T0 - CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 2,
    };
    const records = store([firing]);
    await triagePass(
      deps({ records, transport: accepting().transport, probe: probeThatMustNotRun }),
    );
    expect(records.held.get(UNREACHABLE_KEY)?.state).toBe("clear");
  });

  /** A `firing` record on one console-health kind, so a CLEAR has something to move. */
  function firingOn(health: ConsoleHealthKind): IncidentRecord {
    return {
      ...freshIncidentRecord({ kind: "console_health", scope: CONSOLE_SCOPE, health }),
      state: "firing",
      reason: health,
      since: T0 - CADENCE_MS,
      last_seen: T0 - CADENCE_MS,
      sweep_count: 2,
    };
  }

  /**
   * One verdict's pair, read as THREE values rather than two.
   *
   * **A one-fixture read cannot tell `false` from `null` and that is the
   * degenerate-fixture trap this whole task sits in.** On a fresh record, a
   * `false` and a `null` are identical — neither writes anything — so a mapping
   * that returned `false` everywhere it should return `null` would pass a raise-only
   * probe on every verdict. The discrimination needs the record to be `firing`
   * first: only a `false` moves it to `clear`, a `null` leaves it alone, and a
   * `true` leaves it firing too but has already been separated by the raise probe.
   *
   * So each verdict is driven twice against the same driver and probe — once from
   * an empty store to ask *"did it RAISE"* and once from a firing store to ask
   * *"did it CLEAR"* — and the two answers compose the tri-state.
   */
  async function threeValued(
    spy: Spy,
    probe: () => Promise<ToolCallProbeResult>,
  ): Promise<{ verdict: SaturationVerdict | undefined; saturated: boolean | null; unreachable: boolean | null }> {
    const fresh = store();
    const out = await triagePass(
      deps({ driver: spy.driver, records: fresh, transport: accepting().transport, probe }),
    );
    const seeded = store([firingOn("inference_saturated"), firingOn("inference_unreachable")]);
    await triagePass(
      deps({ driver: spy.driver, records: seeded, transport: accepting().transport, probe }),
    );
    const read = (key: string, health: ConsoleHealthKind): boolean | null => {
      if (fresh.held.get(key)?.reason === health) return true;
      if (seeded.held.get(key)?.state === "clear") return false;
      return null;
    };
    return {
      verdict: out.saturation?.verdict,
      saturated: read(SATURATED_KEY, "inference_saturated"),
      unreachable: read(UNREACHABLE_KEY, "inference_unreachable"),
    };
  }

  /**
   * The whole vocabulary, mapped through the PASS — §6.8a's table by value.
   *
   * This is the assertion that makes the pair a table rather than two `if`s: every
   * member of `SATURATION_VERDICTS` is reached through a real fixture, and the
   * expected column is written as `boolean | null` so `clear`'s `false` and
   * `unconfirmed`'s `null` are different assertions rather than the same one.
   */
  test("every SATURATION_VERDICTS member maps to its documented (saturated, unreachable) pair", async () => {
    const cases: ReadonlyArray<{
      verdict: SaturationVerdict;
      spy: () => Spy;
      probe: () => Promise<ToolCallProbeResult>;
      pair: { saturated: boolean | null; unreachable: boolean | null };
    }> = [
      { verdict: "clear", spy: () => driver(), probe: probeThatMustNotRun, pair: { saturated: false, unreachable: false } },
      { verdict: "uncorrelated", spy: uncorrelatedDriver, probe: probeThatMustNotRun, pair: { saturated: null, unreachable: null } },
      { verdict: "saturated", spy: correlatedDriver, probe: async () => timeoutProbe(), pair: { saturated: true, unreachable: null } },
      { verdict: "endpoint_down", spy: correlatedDriver, probe: async () => unreachableProbe(), pair: { saturated: null, unreachable: true } },
      { verdict: "unconfirmed", spy: correlatedDriver, probe: async () => inconclusiveProbe(), pair: { saturated: null, unreachable: null } },
    ];
    // The table covers the real vocabulary, entire — not a subset of it.
    expect(cases.map((c) => c.verdict).sort()).toEqual([...SATURATION_VERDICTS].sort());
    /*
     * PREMISE, a step earlier: the two columns must DISAGREE somewhere, or a pass
     * that fed `saturated` to both kinds would satisfy every row below.
     */
    const rows = cases.map((c) => c.pair);
    expect(rows.some((p) => p.saturated !== p.unreachable)).toBe(true);
    for (const c of cases) {
      expect(await threeValued(c.spy(), c.probe)).toEqual({ verdict: c.verdict, ...c.pair });
    }
  });

  /**
   * The pure mapping, asserted separately from the pass so the column has a probe
   * of its own. `clear` is the ONLY `false`.
   *
   * **These five rows are an EXPECTATION and no longer a second implementation.**
   * §13 task 6.4b moved the mapping into `SATURATION_PAIR` (`triage-verdict.ts`),
   * which `unreachableFrom` now reads, so this list grounds that table from
   * outside rather than racing it — a changed cell reddens here, which is the
   * signal ISC-869's consolidation was commissioned to buy. Re-typing it against
   * `SATURATION_PAIR` would delete the grounding and assert the table equals
   * itself.
   *
   * **The exhaustiveness guard MOVED with the mapping.** This test's earlier
   * docblock claimed the `never` binding after a `switch` in this file; that
   * switch is gone, and a sixth member of `SATURATION_VERDICTS` is now a
   * `tsc --noEmit` error on the `Record<SaturationVerdict, …>` literal that holds
   * the table. One error at the one place the answer is written, rather than one
   * per reader.
   */
  test("unreachableFrom: only `clear` is false, only `endpoint_down` is true, null otherwise", () => {
    const outcome = (verdict: SaturationVerdict): SaturationOutcome => ({
      verdict,
      saturated: null,
      suppressed: false,
      subject: `${PROVIDER}/${MODEL}`,
      correlated: [],
      probe: null,
    });
    expect(unreachableFrom(null)).toBeNull();
    expect(SATURATION_VERDICTS.map((v) => [v, unreachableFrom(outcome(v))])).toEqual([
      ["clear", false],
      ["uncorrelated", null],
      ["saturated", null],
      ["endpoint_down", true],
      ["unconfirmed", null],
    ]);
  });

  /** A pass that never swept could not tell, so both halves stay silent. */
  test("a SKIPPED pass says nothing about either half of the pair", async () => {
    const records = store();
    const spy = driver({
      inFlight: async () => ({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7-collate", dispatchedAt: DISPATCHED_NOW }),
    });
    const out = await triagePass(deps({ driver: spy.driver, records }));
    expect(out.kind).toBe("skipped");
    expect(records.held.get(UNREACHABLE_KEY)).toBeUndefined();
    expect(records.held.get(SATURATED_KEY)).toBeUndefined();
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

/**
 * Task 3.3's settle half (SRD-TRIAGE-MIXED-OBSERVERS §6.1) — `settle()` emits one
 * `ConsoleEnvironmentFacts` entry per `deps.environments` element, and each
 * entry's `observerBlocked` is computed ONLY from that entry's own kind, through
 * `workersOfKind` (`./triage-seat-kinds.ts`) over the sweep's one flat
 * `join.blocked` list.
 *
 * ## Where the settled fact is observable
 *
 * `TriagePassOutcome` carries no `environments` field of its own — the facts
 * feed `consoleHealthObservations` and from there `advanceIncident`, exactly
 * like every other console-health fact this file already asserts (see "a skip
 * says NOTHING about any environment" above). A FRESH incident record's
 * `state` is `"clear"`; a first `issue` observation (an environment whose
 * `observerBlocked` came back `true`) moves it to `"provisional"` on this one
 * sweep, and a first `observed_clear` observation (`observerBlocked: false`)
 * leaves it `"clear"`. That is enough to tell the two apart in a single pass,
 * with no need to drive a second sweep for `"firing"`.
 */
describe("task 3.3's settle half — one environment fact per swept kind", () => {
  /**
   * Two kinds present at once: the fixture's existing k8s seats, plus a
   * docker one. `docker-host` declares no services of its own here — these
   * tests exercise `observerBlocked`'s per-kind scoping via `blocked`, never
   * a docker dispatch, and an empty `services` is legal (§6.5's `N = 0` row).
   */
  const MIXED_DECLARED: readonly DeclaredEnvironment[] = [
    { name: "do-cluster", kind: "k8s", services: [...SERVICES] },
    { name: "docker-host", kind: "docker", services: [] },
  ];

  test("a blocked docker seat opens observer_blocked on docker only, never on k8s", async () => {
    const records = store();
    const spy = driver({ blocked: ["obs-td1"] });
    await triagePass(
      deps({ driver: spy.driver, records, environment: "do-cluster", declared: MIXED_DECLARED }),
    );
    // do-cluster (k8s): obs-td1 is not a k8s seat, so workersOfKind("k8s", ...) is
    // empty and the record stays clear.
    expect(records.held.get("console_health:do-cluster/observer_blocked")?.state).toBe("clear");
    // docker-host: obs-td1 IS a docker seat, so this one moves.
    expect(records.held.get("console_health:docker-host/observer_blocked")?.state).toBe("provisional");
  });

  test("the twin: a blocked k8s seat flips the assignment the OTHER way", async () => {
    const records = store();
    const spy = driver({ blocked: ["obs-t2"] });
    await triagePass(
      deps({ driver: spy.driver, records, environment: "do-cluster", declared: MIXED_DECLARED }),
    );
    expect(records.held.get("console_health:do-cluster/observer_blocked")?.state).toBe("provisional");
    expect(records.held.get("console_health:docker-host/observer_blocked")?.state).toBe("clear");
  });

  test("a blocked worker the seat-kind lookup does not name opens observer_blocked on NEITHER environment", async () => {
    const records = store();
    // obs-d1 is a docker-ROLE worker, but not a triage seat at all — TRIAGE_SEAT_KINDS
    // has no entry for it, so seatKind("obs-d1") is null and workersOfKind excludes
    // it from every kind, k8s and docker alike.
    const spy = driver({ blocked: ["obs-d1"] });
    await triagePass(
      deps({ driver: spy.driver, records, environment: "do-cluster", declared: MIXED_DECLARED }),
    );
    expect(records.held.get("console_health:do-cluster/observer_blocked")?.state).toBe("clear");
    expect(records.held.get("console_health:docker-host/observer_blocked")?.state).toBe("clear");
  });

  test("one entry per deps.declared element, in deps.declared order", async () => {
    const records = store();
    // Deliberately neither alphabetical nor deps.environment-first, so an
    // implementation that assumes an order (or sorts) is caught rather than
    // coincidentally agreeing with it. Only the vm seat is blocked, so the
    // pairing is checked alongside the order rather than assumed from it.
    const ordered: readonly DeclaredEnvironment[] = [
      { name: "vm-host", kind: "vm", services: [] },
      { name: "do-cluster", kind: "k8s", services: [...SERVICES] },
      { name: "docker-host", kind: "docker", services: [] },
    ];
    const spy = driver({ blocked: ["obs-tv1"] });
    const out = await triagePass(
      deps({ driver: spy.driver, records, environment: "do-cluster", declared: ordered }),
    );

    const scopes = out.written.flatMap((r) =>
      r.subject.kind === "console_health" && r.subject.health === "observer_blocked" ? [r.subject.scope] : [],
    );
    expect(scopes).toEqual(["vm-host", "do-cluster", "docker-host"]);

    expect(records.held.get("console_health:vm-host/observer_blocked")?.state).toBe("provisional");
    expect(records.held.get("console_health:do-cluster/observer_blocked")?.state).toBe("clear");
    expect(records.held.get("console_health:docker-host/observer_blocked")?.state).toBe("clear");
  });

  /**
   * Each refusal is a HOST wiring fault, checked once before anything reaches
   * the driver — every case below asserts `spy.opened`/`spy.dispatched` stay
   * empty alongside the throw, so a refusal that fired AFTER a dispatch would
   * fail here too.
   */
  describe("triagePass refuses a miswired deps.declared before anything is dispatched", () => {
    test("an empty declared list", async () => {
      const spy = driver();
      await expect(triagePass(deps({ driver: spy.driver, declared: [] }))).rejects.toThrow(
        /deps\.declared is empty/,
      );
      expect(spy.opened).toHaveLength(0);
      expect(spy.dispatched).toHaveLength(0);
    });

    test("declared that omits an entry named deps.environment", async () => {
      const spy = driver();
      await expect(
        triagePass(
          deps({ driver: spy.driver, declared: [{ name: "not-cni-dev", kind: "k8s", services: [...SERVICES] }] }),
        ),
      ).rejects.toThrow(/does not contain an entry named "cni-dev"/);
      expect(spy.opened).toHaveLength(0);
      expect(spy.dispatched).toHaveLength(0);
    });

    test("two entries that share a name", async () => {
      const spy = driver();
      await expect(
        triagePass(
          deps({
            driver: spy.driver,
            declared: [
              { name: ENVIRONMENT, kind: "k8s", services: [...SERVICES] },
              { name: ENVIRONMENT, kind: "docker", services: [] },
            ],
          }),
        ),
      ).rejects.toThrow(/names "cni-dev" more than once/);
      expect(spy.opened).toHaveLength(0);
      expect(spy.dispatched).toHaveLength(0);
    });

    test("two entries that share a kind", async () => {
      const spy = driver();
      await expect(
        triagePass(
          deps({
            driver: spy.driver,
            declared: [
              { name: ENVIRONMENT, kind: "k8s", services: [...SERVICES] },
              { name: "second-k8s", kind: "k8s", services: [] },
            ],
          }),
        ),
      ).rejects.toThrow(/kind "k8s" more than once/);
      expect(spy.opened).toHaveLength(0);
      expect(spy.dispatched).toHaveLength(0);
    });
  });
});

/**
 * Task 4.2 — `dispatchPartition` (`triagePass`'s call inside it) receives
 * `deps.declared` mapped to `{kind, services}`, one group per entry, rather
 * than a single hardcoded k8s group built from a flat `deps.declared`. §5's
 * own example: `do-cluster` and `docker-host` both declare a `grafana`, and
 * D21 keys the merged assessment on `(environment, service)` precisely so the
 * two do not collide.
 */
describe("task 4.2 — dispatchPartition covers every declared kind, not a hardcoded k8s group", () => {
  /** do-cluster (k8s) and docker-host (docker), each declaring one `grafana` — SRD-TRIAGE-MIXED-OBSERVERS §5. */
  const GRAFANA_DECLARED: readonly DeclaredEnvironment[] = [
    { name: "do-cluster", kind: "k8s", services: ["grafana"] },
    { name: "docker-host", kind: "docker", services: ["grafana"] },
  ];

  /** A fresh, gap-free `grafana` row naming its own environment (task 4.1b's `TriageRow.environment`). */
  function grafanaRow(environment: string): TriageRow {
    return { ...healthyRow("grafana"), environment };
  }

  test("a k8s seat's grafana and a docker seat's grafana are BOTH dispatched, and both rows come back observed", async () => {
    const spy = driver({
      assignments: [
        { worker: "obs-t1", services: ["grafana"] },
        { worker: "obs-td1", services: ["grafana"] },
      ],
      artifacts: (sweepId) => [artifact("obs-t1", sweepId), artifact("obs-td1", sweepId)],
      rows: () => [grafanaRow("do-cluster"), grafanaRow("docker-host")],
    });
    const out = await triagePass(
      deps({ driver: spy.driver, environment: "do-cluster", declared: GRAFANA_DECLARED }),
    );

    expect(out.kind).toBe("swept");
    expect([...spy.dispatched].sort((a, b) => a.worker.localeCompare(b.worker))).toEqual([
      { sweepId: "T-sweep-1", worker: "obs-t1" },
      { sweepId: "T-sweep-1", worker: "obs-td1" },
    ]);
    expect(out.assessment?.services.map((s) => [s.environment, s.service, s.reason])).toEqual([
      ["do-cluster", "grafana", "observed"],
      ["docker-host", "grafana", "observed"],
    ]);
  });

  /**
   * `docker-host`'s `grafana` is never claimed by a docker seat — only a k8s
   * one claims a `grafana`, and per-kind scoping (task 4.1) means that claim
   * counts toward `do-cluster`'s declared set and NOT `docker-host`'s. The
   * docker bucket is therefore still missing its one service and the whole
   * sweep is refused before anything is dispatched.
   */
  test("docker-host's grafana claimed only by a k8s seat is refused before anything is dispatched", async () => {
    const spy = driver({ assignments: [{ worker: "obs-t1", services: ["grafana"] }] });
    const out = await triagePass(
      deps({ driver: spy.driver, environment: "do-cluster", declared: GRAFANA_DECLARED }),
    );

    expect(out.kind).toBe("partition_refused");
    expect(out.partition?.code).toBe("partition_incomplete");
    expect(out.partition?.missing).toEqual(["grafana"]);
    expect(spy.dispatched).toHaveLength(0);
    expect(spy.collated).toHaveLength(0);
  });
});
