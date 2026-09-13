/**
 * The five producers a sweep needs — SRD-TRIAGE-CONSOLE §13 task 6.1a, §7.2,
 * §7.4, §7.5, §12.6.
 *
 * ## The acceptance criterion this file exists for, and its ranking
 *
 * §13 task 6.1a: *"§12.6's envelope fixtures pass — a rendered envelope carries
 * none of the four forbidden classes, asserted by NAME; and the anti-criterion
 * that outranks them, that a previous sweep's report cannot reach the next
 * sweep's brief as prose, on a fixture where the previous report contains a
 * marker string."*
 *
 * Those are two different kinds of assertion and the file keeps them apart.
 *
 * **The four classes are asserted BY NAME**, on `monitor-readonly.test.ts`'s rule
 * that naming the permitted set is what makes a fifth member fail — so
 * {@link FORBIDDEN_ENVELOPE_CLASSES} is pinned by full value, and each class has
 * a fixture that REACHES it. A checker that returned `[]` for every input would
 * satisfy "the rendered envelope is clean" and nothing else in this file, which
 * is why the reachability fixtures are not optional decoration: they are the
 * premise that makes the clean assertion mean something.
 *
 * **The anti-criterion is structural first and asserted second.**
 * {@link renderSweepEnvelope} takes the previous sweep's `triage.json` as a
 * WHOLE DOCUMENT and projects it itself, so a caller cannot hand it prose and a
 * renderer that pasted the document would fail its own audit. The marker fixture
 * then proves the projection is really lossy in the direction that matters, and
 * a positive control proves it is not lossy in every direction — a renderer that
 * carried nothing at all would pass "the marker did not cross" and be useless.
 *
 * ## No test here reaches a network, a container, or the operator's `~/.pifleet`
 *
 * The envelope tests are pure. The reader tests use `mkdtemp` with `HOME` and
 * `PIFLEET_RUNS_DIR` both redirected, on `triage-command.test.ts`'s reasoning:
 * the incident root is `dirname(runsRoot(env))/triage` and `runsRoot` falls back
 * to `$HOME/.pifleet/runs`, so a fixture that redirected only one of the two
 * writes into the operator's own tree. The dispatch is injected everywhere —
 * §13's hard rule and §12's closing anti-criterion.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OUTBOX_FILES_DIR } from "../../src/harvest/outbox.ts";
import { COVERAGE_RESULTS, OBSERVER_ASSESSMENTS } from "../../src/run/triage-verdict.ts";
import {
  runPaths,
  taskRecordPath,
  workerOutboxDir,
  workerPaths,
  workerRepliesDir,
  type RunPaths,
} from "../../src/run/paths.ts";
import { createRepliesDir } from "../../src/run/replies.ts";
import { writeRepliesPolicy } from "../../src/run/replies-policy.ts";
import {
  TRIAGE_CONSOLE_ASPECTS,
  childTaskId,
  collationTaskId,
  sweepTaskId,
} from "../../src/run/task-ids.ts";
import { DISPATCH_REQUEST_FILE } from "../../src/run/dispatch-request.ts";
import { TRIAGE_COLLATOR } from "../../src/run/triage-actor.ts";
import type { TriageDocument } from "../../src/run/triage-verdict.ts";
import type { TriageService } from "../../src/run/triage-targets.ts";
import {
  FORBIDDEN_ENVELOPE_CLASSES,
  OBSERVER_ARTIFACT_FILE,
  OBSERVER_STATUSES,
  SWEEP_FILES_DIR,
  SweepEnvelopeError,
  TRIAGE_DOCUMENT_FILE,
  TRIAGE_VERDICT_RULE,
  blockedObservers,
  describeIssues,
  envelopeIssues,
  MIN_PROSE_LENGTH,
  observerArtifactPath,
  parseObserverArtifact,
  projectPreviousState,
  readObserverArtifactAt,
  readTriageDocumentAt,
  renderSweepEnvelope,
  sweepProducers,
  triageDocumentPath,
  windowOpenedAt,
  type ForbiddenEnvelopeClass,
  type SweepDispatchOutcome,
  type SweepEnvelopeInput,
  type SweepProducerDeps,
  normalizeSliceReportingPath,
  CLUSTER_CALL_TIMEOUT_S,
  BOUNDED_CALLS_DEMAND,
  COVERAGE_VOCABULARY_DEMAND,
  OBSERVER_CONTRACT_HEADING,
  composeObserverBrief,
  freshnessEchoDemand,
  readWindowInstant,
} from "../../src/run/triage-envelope.ts";
import {
  consoleTransport,
  productionRelayEffects,
  type PublishedReply,
} from "../../src/run/relay.ts";

/**
 * The publish-and-declare port, named once so the fixtures below cannot each
 * spell it slightly differently.
 *
 * Read off `SweepProducerDeps` rather than restated, because a hand-written
 * copy is a second answer to a question the module already answers — and a
 * fixture whose port shape drifted from the real one would keep passing while
 * production stopped compiling.
 */
type PublishRepliesPort = NonNullable<SweepProducerDeps["publishReplies"]>;

// ---------------------------------------------------------------------------
// Isolation — both variables, every time
// ---------------------------------------------------------------------------

const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
const HOME_BEFORE = process.env["HOME"];
const bases: string[] = [];

afterAll(async () => {
  for (const base of bases) await rm(base, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
  if (HOME_BEFORE === undefined) delete process.env["HOME"];
  else process.env["HOME"] = HOME_BEFORE;
});

let base = "";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pifleet-triage-env-"));
  bases.push(base);
  process.env["HOME"] = base;
  process.env["PIFLEET_RUNS_DIR"] = join(base, ".pifleet", "runs");
});

async function seedRun(runId: string): Promise<RunPaths> {
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.root, { recursive: true });
  return run;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A realistic environment: three services, two namespaces, differing check sets
 * and one window override.
 *
 * The override is present because §7.2 asks the brief to carry *"the per-service
 * `checks[]` and window"* so that *"a brief cannot widen a check the targets file
 * bounded"*, and a fixture in which every service had the same window could not
 * tell a renderer that copies each service's window from one that prints the
 * environment default three times.
 */
const SERVICES: readonly TriageService[] = [
  {
    name: "routing",
    namespace: "aodapn-routing",
    workload: "routing-api",
    checks: ["rollout", "logs"],
    window: null,
  },
  {
    name: "authorization",
    namespace: "aodapn-authz",
    workload: null,
    checks: ["rollout", "logs", "sink", "endpoint"],
    window: 120,
  },
  {
    name: "telemetry",
    namespace: "aodapn-routing",
    workload: "telemetry-writer",
    checks: ["sink"],
    window: null,
  },
];

/** The marker the anti-criterion is about, and it must never appear in a brief. */
const MARKER = "ZZMARKERZZ-previous-report-prose";

/**
 * The previous sweep's `triage.json`, with the marker in **every** worker-authored
 * string a renderer could plausibly reach for.
 *
 * SIX carriers, not one: the selector, the window spelling, an evidence-ledger
 * entry, a coverage channel name, an `unaccounted[]` entry, and — since §13 task
 * 5.8 grew §7.5 a prose field on 2026-09-07 — the row's `note`. A fixture with
 * the marker in a single field would be satisfied by a renderer that dropped that
 * one field and copied the other five, which is the shape a partial fix takes.
 *
 * `note` is the carrier that most deserves to be here, because it is the only
 * field on this document whose PURPOSE is to be a sentence: every other carrier
 * is a token that happens to be worker-authored.
 */
const PREVIOUS: TriageDocument = {
  worker: TRIAGE_COLLATOR,
  sweep_id: "T-sweep-40",
  services: [
    {
      service: "routing",
      assessment: "unhealthy",
      coverage: [{ channel: `logs ${MARKER}`, result: "answered" }],
      selector: `app=routing ${MARKER}`,
      window: `5m ${MARKER}`,
      evidence_ref: [`obs-t1:observer-ops.json#services[0] ${MARKER}`],
      note: `the routing pods are crashlooping ${MARKER}`,
      observer: "obs-t1",
    },
    {
      service: "authorization",
      assessment: "healthy",
      coverage: [{ channel: "rollout", result: "answered" }],
      selector: "app=authz",
      window: "5m",
      evidence_ref: ["obs-t2:observer-ops.json#services[0]"],
      observer: "obs-t2",
    },
    {
      // A service the host never declared. Its NAME is worker-authored too.
      service: `phantom-${MARKER}`,
      assessment: "unhealthy",
      coverage: [],
      selector: null,
      window: null,
      evidence_ref: [],
      observer: "obs-t3",
    },
  ],
  unaccounted: [`telemetry-${MARKER}`],
};

/**
 * **A DECLARED SERVICE NAME IN `unaccounted[]` IS NOT WORKER PROSE.**
 *
 * `unaccounted[]` is a list of SERVICE NAMES and the host writes every declared
 * name into every brief, so auditing that list as worker prose makes a correct
 * report — *"I could not account for these"* — indistinguishable from a previous
 * sweep's prose crossing into the next brief.
 *
 * Measured 2026-09-07 on the live console: a collation carrying
 * `unaccounted: [alert-notifier, prometheus, grafana]` refused EVERY subsequent
 * sweep with `worker_prose`, quoting a service name out of the operator's own
 * targets file. The guard was working exactly as written; what was missing is
 * that the host's vocabulary did not contain the host's own service names. A
 * console that cannot sweep because a worker named its targets is worse than one
 * with no guard, because the refusal reads as a security finding.
 *
 * The second half is the arm this must not widen: an unaccounted name the host
 * never declared is still the worker's own claim and must still be caught. That
 * is the whole difference between "the worker echoed my list" and "the worker
 * invented a name", and only the first is safe.
 */
describe("the prose audit exempts names the HOST declared, and only those", () => {
  const declared = SERVICES.map((s) => s.name);

  test("a declared name in unaccounted[] does not trip the audit", () => {
    const doc = {
      ...PREVIOUS,
      services: [],
      unaccounted: [...declared],
    } as TriageDocument;
    // The brief legitimately names every declared service — the host put them there.
    const text = `services: ${declared.join(", ")}`;
    expect(envelopeIssues(text, doc, declared)).toEqual([]);
  });

  test("an UNDECLARED name in unaccounted[] is still caught", () => {
    const invented = `telemetry-${MARKER}`;
    const doc = {
      ...PREVIOUS,
      services: [],
      unaccounted: [invented],
    } as TriageDocument;
    const issues = envelopeIssues(`a brief mentioning ${invented}`, doc, declared);
    expect(issues.map((i) => i.forbidden)).toEqual(["worker_prose"]);
    expect(issues[0]!.evidence).toBe(invented);
  });

  test("without the declared list the old false positive still reproduces", () => {
    // The DEFAULT is an empty declared list, which is the behaviour every other
    // caller had before this change — and it is what made the live console refuse.
    const doc = {
      ...PREVIOUS,
      services: [],
      unaccounted: [...declared],
    } as TriageDocument;
    const issues = envelopeIssues(`services: ${declared.join(", ")}`, doc);
    expect(issues.map((i) => i.forbidden)).toEqual(["worker_prose"]);
  });

  /**
   * **THE SAME DEFECT, ONE FIELD OVER — and this one was measured on the live
   * console after the `unaccounted` arm was fixed.**
   *
   * 2026-09-09, `cni-dev`: `T-sweep-26`'s collation wrote the bare service name
   * into `selector` — `"selector": "alert-notifier"` rather than a label
   * expression — and sweeps 27, 28 and 29 were then refused `worker_prose`,
   * quoting `alert-notifier` out of the operator's own targets file. Three passes
   * and 45 minutes with no observation, ended only by an operator restarting the
   * collator, which cleared it by accident: a new run tree has no previous
   * document, so the check was skipped rather than satisfied.
   *
   * `selector` is a field a collator fills from what the observer reported, and
   * "the thing I selected on" degrading to the service's own name is an ordinary
   * imprecision rather than a contamination. The host writes that name into every
   * brief, so auditing it as the previous worker's prose refuses the next sweep
   * for naming its own targets — the identical failure the block above records,
   * arriving through the one carrier that looks structural.
   */
  const declaredNamespaces = SERVICES.map((s) => s.namespace);

  test("a declared service NAME used as a selector does not trip the audit", () => {
    // "authorization" is the declared name long enough to clear MIN_PROSE_LENGTH;
    // "routing" is seven characters and would pass for the wrong reason.
    const name = "authorization";
    expect(declared).toContain(name);
    expect(name.length).toBeGreaterThanOrEqual(MIN_PROSE_LENGTH);

    const doc = {
      ...PREVIOUS,
      services: [{ ...PREVIOUS.services[1]!, selector: name }],
      unaccounted: [],
    } as TriageDocument;
    // The brief legitimately names the service — the host put it there.
    const text = `Check \`${name}\` in namespace \`aodapn-authz\`.`;
    expect(envelopeIssues(text, doc, declared, declaredNamespaces)).toEqual([]);
  });

  /**
   * The same exemption on `coverage[].channel`, measured 2026-09-10 as
   * `T-sweep-79`'s lost render.
   *
   * The previous sweep's collation carried `channel: "monitoring"` — a declared
   * NAMESPACE where a channel name belongs — and the brief was refused
   * `worker_prose [monitoring]`, because the host puts every declared namespace
   * in every brief. The audit was matching the host's own vocabulary against
   * itself. This is [[ISC-1142]]'s shape on the field [[ISC-1142]] did not
   * widen, which its own entry warned about.
   */
  test("a declared NAMESPACE used as a coverage channel does not trip the audit", () => {
    const ns = "aodapn-authz";
    expect(declaredNamespaces).toContain(ns);
    expect(ns.length).toBeGreaterThanOrEqual(MIN_PROSE_LENGTH);

    const doc = {
      ...PREVIOUS,
      services: [
        {
          ...PREVIOUS.services[1]!,
          selector: null,
          note: null,
          evidence_ref: [],
          coverage: [{ channel: ns, result: "answered" }],
        },
      ],
      unaccounted: [],
    } as unknown as TriageDocument;
    const text = `Check the services in namespace \`${ns}\`.`;
    expect(envelopeIssues(text, doc, declared, declaredNamespaces)).toEqual([]);
  });

  test("a declared service NAME used as a coverage channel does not trip it either", () => {
    const name = "authorization";
    expect(declared).toContain(name);
    const doc = {
      ...PREVIOUS,
      services: [
        {
          ...PREVIOUS.services[1]!,
          selector: null,
          note: null,
          evidence_ref: [],
          coverage: [{ channel: name, result: "answered" }],
        },
      ],
      unaccounted: [],
    } as unknown as TriageDocument;
    expect(envelopeIssues(`Check \`${name}\`.`, doc, declared, declaredNamespaces)).toEqual([]);
  });

  /**
   * The anti-criterion, and it is what stops the exemption from being a hole.
   * MEMBERSHIP, never containment — a channel the collator COMPOSED out of a
   * declared token is still the collator's own string.
   */
  test("a channel that merely CONTAINS a declared token is still caught", () => {
    const doc = {
      ...PREVIOUS,
      services: [
        {
          ...PREVIOUS.services[1]!,
          selector: null,
          note: null,
          evidence_ref: [],
          coverage: [{ channel: "app=aodapn-authz", result: "answered" }],
        },
      ],
      unaccounted: [],
    } as unknown as TriageDocument;
    const issues = envelopeIssues("Check app=aodapn-authz.", doc, declared, declaredNamespaces);
    expect(issues.map((i) => i.forbidden)).toContain("worker_prose");
  });

  test("a declared NAMESPACE used as a selector does not trip it either", () => {
    const ns = "aodapn-authz";
    expect(declaredNamespaces).toContain(ns);

    const doc = {
      ...PREVIOUS,
      services: [{ ...PREVIOUS.services[1]!, selector: ns }],
      unaccounted: [],
    } as TriageDocument;
    const text = `Check \`authorization\` in namespace \`${ns}\`.`;
    expect(envelopeIssues(text, doc, declared, declaredNamespaces)).toEqual([]);
  });

  /**
   * The arm this must not widen, and it is the whole reason the exemption is a
   * membership test rather than a substring one. A selector the host never
   * declared is the worker's own string and stays caught — including one that
   * merely CONTAINS a declared name, because `app=authorization` is a claim the
   * collator composed rather than a token it echoed.
   */
  /**
   * **THE WIRING, and the three unit cases above are worth little without it.**
   *
   * Every assertion in this block calls `envelopeIssues` and hands it the two
   * declared lists by hand. The live console does not: `renderSweepEnvelope`
   * builds them off `input.services`, and the defect that cost sweeps 27 to 29
   * was reachable only through that path. A fix proven at the function and never
   * passed the namespaces at the call site would leave this repo with four green
   * tests and a console that still refuses — the failure mode this ISA has
   * measured more than once.
   *
   * So this case goes through the renderer, with a previous document shaped like
   * the one `tri-1` actually wrote, and asserts the sweep is produced at all.
   */
  test("the RENDERER survives a previous selector that degraded to a declared name", () => {
    const previous = {
      ...PREVIOUS,
      services: [
        { ...PREVIOUS.services[1]!, service: "authorization", selector: "authorization" },
      ],
      unaccounted: [],
    } as TriageDocument;
    // The premise: this is the exact shape T-sweep-26 wrote, and the renderer
    // names that service because the host declared it.
    expect(SERVICES.map((x) => x.name)).toContain("authorization");

    const envelope = renderSweepEnvelope(envelopeInput({ previousDocument: previous }));
    expect(envelope.brief).toContain("authorization");
  });

  /**
   * And the namespace half of the same wiring, because `declaredNamespaces` is a
   * second list built at the same call site and a fix can pass one and forget it.
   */
  test("the RENDERER survives a previous selector that degraded to a declared namespace", () => {
    const previous = {
      ...PREVIOUS,
      services: [{ ...PREVIOUS.services[1]!, selector: "aodapn-authz" }],
      unaccounted: [],
    } as TriageDocument;
    expect(SERVICES.map((x) => x.namespace)).toContain("aodapn-authz");

    const envelope = renderSweepEnvelope(envelopeInput({ previousDocument: previous }));
    expect(envelope.brief).toContain("aodapn-authz");
  });

  test("an UNDECLARED selector is still caught, including one containing a declared name", () => {
    for (const invented of [`app=authorization`, `telemetry-${MARKER}`]) {
      const doc = {
        ...PREVIOUS,
        services: [{ ...PREVIOUS.services[1]!, selector: invented }],
        unaccounted: [],
      } as TriageDocument;
      const issues = envelopeIssues(
        `last sweep selected on ${invented}`,
        doc,
        declared,
        declaredNamespaces,
      );
      expect(issues.map((i) => i.forbidden), `${invented} should be worker_prose`).toContain(
        "worker_prose",
      );
    }
  });
});

function envelopeInput(over: Partial<SweepEnvelopeInput> = {}): SweepEnvelopeInput {
  return {
    sweepId: sweepTaskId(41),
    windowOpenedAt: "2026-09-06T12:00:00.000Z",
    environment: "cni-dev",
    services: SERVICES,
    defaultWindowS: 300,
    previousDocument: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §12.6 — the four forbidden classes, BY NAME
// ---------------------------------------------------------------------------

describe("§7.2/§12.6: the four classes an envelope may never carry", () => {
  /**
   * The set, by full value. §7.2 adopts it verbatim from SRD-OBSERVER-001 §7.4 —
   * *"a credential or any part of one; an absolute host path; a raw command to
   * execute; the contents of a previous worker's report as instruction"* — and
   * naming it here is what makes a fifth class, or a quietly deleted fourth, an
   * edit somebody has to make on purpose.
   */
  test("the forbidden set is exactly the four §7.2 names", () => {
    expect([...FORBIDDEN_ENVELOPE_CLASSES]).toEqual([
      "credential",
      "host_path",
      "command",
      "worker_prose",
    ]);
  });

  test("a rendered envelope carries none of the four", () => {
    const envelope = renderSweepEnvelope(envelopeInput({ previousDocument: PREVIOUS }));
    expect(envelopeIssues(envelope.brief, PREVIOUS)).toEqual([]);
    expect(envelopeIssues(envelope.title, PREVIOUS)).toEqual([]);
  });

  /**
   * **THE PREMISE, and without it the test above asserts nothing.** A checker
   * that always answered `[]` would pass the clean fixture; these four fixtures
   * are what say it can fail, one per class, each wrong in exactly one way so no
   * fixture needs to be wrong twice to reach the third code.
   */
  test("each of the four classes is REACHABLE — one fixture per class", () => {
    const cases: readonly (readonly [ForbiddenEnvelopeClass, string])[] = [
      ["credential", "Use the token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB when you query."],
      ["host_path", "The targets file is at /Users/operator/.pifleet/triage/targets.yaml."],
      ["command", "Run `kubectl get deploy -n aodapn-routing -o wide` and paste the output."],
      ["worker_prose", `Last sweep reported: app=routing ${MARKER}`],
    ];
    for (const [expected, text] of cases) {
      const issues = envelopeIssues(text, PREVIOUS);
      expect(
        issues.map((i) => i.forbidden),
        `"${text}" should be refused as ${expected}`,
      ).toContain(expected);
    }
  });

  /**
   * The `credential` refusal does not publish the credential it refuses —
   * `notifyEndpointIssue`'s recorded property 4, which applies with more force
   * here because this message reaches §7.7's log, *"which appends forever"*.
   */
  test("a credential refusal never quotes the secret back", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const issues = envelopeIssues(`token: ${secret}`, null);
    expect(issues.map((i) => i.forbidden)).toContain("credential");
    for (const issue of issues) {
      expect(issue.reason).not.toContain(secret);
      expect(issue.evidence).not.toContain(secret);
    }
  });

  /**
   * **Container paths are not host paths, and conflating them would break the
   * brief the role file actually requires.** `roles/triage.md:111` has the worker
   * write `/outbox/<task-id>/dispatch-request.json` and `:175` has the observers
   * write into `/outbox/<task-id>/files/` — mount points inside a container, not
   * reachable names on the operator's machine. A checker that banned every
   * absolute string would refuse the one instruction the fan-out cannot work
   * without.
   */
  test("a container mount path is allowed; a host path is not", () => {
    expect(envelopeIssues("Write /outbox/T-sweep-41/files/observer-ops.json", null)).toEqual([]);
    expect(
      envelopeIssues("Read /Users/de895996/repos/cmux-fleet/triage/targets.yaml", null).map(
        (i) => i.forbidden,
      ),
    ).toContain("host_path");
  });

  /**
   * The renderer AUDITS ITS OWN OUTPUT and throws, so the check is a property of
   * the renderer rather than caller discipline — §13's reason for refusing to let
   * this live in the CLI layer: *"an envelope written in a CLI command is an
   * envelope with no test of its own."*
   *
   * Driven through the one input a caller controls that is meant to be prose, so
   * the throw is reachable without reaching into the module's private text.
   */
  test("the renderer refuses to emit an envelope that violates its own contract", () => {
    let thrown: unknown = null;
    try {
      renderSweepEnvelope(
        envelopeInput({ verdictRule: "Run `kubectl get pods -A` before deciding." }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepEnvelopeError);
    expect((thrown as SweepEnvelopeError).issues.map((i) => i.forbidden)).toContain("command");
  });

  /**
   * **The refusal MESSAGE carries the evidence, because §7.7's log carries the
   * message and nothing else.**
   *
   * `issues[]` is on the error and an operator cannot see it: the actor logs
   * `why(err)`, which is `err.message`. Measured 2026-09-09 — a `worker_prose`
   * refusal stopped three `cni-dev` sweeps and the log said a string from the
   * last sweep had crossed without saying WHICH, so the console's own record of
   * why it stopped could not answer the only question worth asking. Finding it
   * meant importing the module and running the guard by hand.
   */
  test("the refusal message names the evidence, not just the class", () => {
    const carrier = PREVIOUS.services[0]!.selector!;
    let thrown: unknown = null;
    try {
      renderSweepEnvelope(
        envelopeInput({
          previousDocument: PREVIOUS,
          verdictRule: `Last sweep selected on ${carrier}.`,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepEnvelopeError);
    const message = (thrown as SweepEnvelopeError).message;
    expect((thrown as SweepEnvelopeError).issues.map((i) => i.forbidden)).toContain("worker_prose");
    expect(message).toContain(carrier);
  });

  /**
   * And the ORDER, which is the half a reader would call cosmetic. §7.7 truncates
   * this line to `ACTOR_LOG_REASON_MAX_BYTES` and every one of these reasons is a
   * paragraph, so evidence printed after the prose is evidence a cap removes
   * first — the field would be present in the string and absent from the log.
   */
  test("the evidence precedes the reason, so truncation cannot take it", () => {
    const issues = [
      { forbidden: "worker_prose", evidence: "app=whatever", reason: "a long paragraph" },
    ] as const;
    const line = describeIssues([...issues]);
    expect(line.indexOf("app=whatever")).toBeLessThan(line.indexOf("a long paragraph"));
  });
});

// ---------------------------------------------------------------------------
// The anti-criterion that OUTRANKS them
// ---------------------------------------------------------------------------

describe("§7.2: a previous sweep's report cannot reach the next sweep's brief as prose", () => {
  /**
   * The marker fixture. §7.2: *"What crosses between passes is structured
   * state… never a previous worker's recommendations rendered as a brief"*, and
   * §13 ranks this above the four classes because *"the obvious way to give a
   * sweep continuity is to paste the last sweep's prose into it"*.
   */
  /**
   * The RE-AUDIT knows about `note`, isolated from the projection that feeds it.
   *
   * §13 task 5.8 grew §7.5 a prose field on 2026-09-07, and ISC-841's guarantee
   * has two mechanisms in order: the projection emits only `{service,
   * assessment}` so nothing can cross, and then the renderer **re-audits its own
   * output** against the document it projected from. The second is the backstop
   * for a future edit that widens the first.
   *
   * **This test exists because the obvious mutation cannot see the difference.**
   * Widening `projectPreviousState` to carry a note is caught by the marker
   * assertion below whether or not `workerAuthoredStrings` knows the field — the
   * brief simply contains the marker, and the test fails either way. So the
   * carrier list is asserted HERE, through `envelopeIssues` directly, where a
   * missing entry is the only thing that can change the answer.
   *
   * A re-audit blind to a carrier is worse than no re-audit, because it looks
   * like coverage.
   */
  test("the re-audit counts a row's note as worker-authored prose", () => {
    const note = PREVIOUS.services[0]?.note ?? null;
    // The premise: the fixture's first row really does carry a note, and it is
    // the marker-bearing one. Without this the assertion below is vacuous.
    expect(typeof note).toBe("string");
    expect(note).toContain(MARKER);

    const issues = envelopeIssues(`a brief that quotes it: ${note}`, PREVIOUS);
    expect(issues.map((i) => i.forbidden)).toContain("worker_prose");

    // And the anti-half: the same text with the note absent from the document is
    // clean, so the issue is attributable to the carrier rather than to the
    // prose happening to look like something else.
    const withoutNote: TriageDocument = {
      ...PREVIOUS,
      services: PREVIOUS.services.map((r) => ({ ...r, note: null })),
    };
    expect(
      envelopeIssues(`a brief that quotes it: ${note}`, withoutNote).map((i) => i.forbidden),
    ).not.toContain("worker_prose");
  });

  test("no marker from the previous report appears anywhere in the envelope", () => {
    const envelope = renderSweepEnvelope(envelopeInput({ previousDocument: PREVIOUS }));
    expect(envelope.brief).not.toContain(MARKER);
    expect(envelope.title).not.toContain(MARKER);
    // And the audit agrees with the eye, so a later rewrite of the brief cannot
    // reintroduce the prose while this test still passes on a stale expectation.
    expect(envelopeIssues(envelope.brief, PREVIOUS).map((i) => i.forbidden)).not.toContain(
      "worker_prose",
    );
  });

  /**
   * **THE POSITIVE CONTROL, and the test above is worthless without it.** A
   * renderer that carried no previous state at all — or no brief at all — passes
   * "the marker did not cross". So the structured half is asserted to be
   * present: the service name the host itself declared, and the assessment token
   * out of a closed four-member enum.
   */
  test("the STRUCTURED state does cross — the projection is lossy in one direction only", () => {
    const envelope = renderSweepEnvelope(envelopeInput({ previousDocument: PREVIOUS }));
    expect(envelope.brief).toContain("routing");
    expect(envelope.brief).toContain("unhealthy");
    expect(envelope.brief).toContain("authorization");
    expect(envelope.brief).toContain("healthy");
  });

  /**
   * The projection itself, tested apart from the prose it feeds, because the two
   * failures are different: a renderer can drop the whole previous block (caught
   * above) or carry a service the host never declared (caught here).
   *
   * **An undeclared service name is worker-authored data**, and letting one
   * through would put an attacker-chosen token into the brief under the host's
   * own voice — which is the `worker_prose` class arriving through the one field
   * that looks structural.
   */
  test("projectPreviousState keeps only declared services and enum assessments", () => {
    const declared = SERVICES.map((s) => s.name);
    const projected = projectPreviousState(PREVIOUS, declared);
    expect(projected).toEqual([
      { service: "routing", assessment: "unhealthy" },
      { service: "authorization", assessment: "healthy" },
    ]);
    // The undeclared row is gone by NAME, not by position.
    expect(projected.map((p) => p.service)).not.toContain(`phantom-${MARKER}`);
  });

  test("projectPreviousState of no document is an empty list, not a throw", () => {
    expect(projectPreviousState(null, ["routing"])).toEqual([]);
  });

  /**
   * **The `worker_prose` detector is driven against a document whose strings it
   * must find**, so the clean assertion above is not passing because the detector
   * looks at nothing. Each of the five carriers is checked separately.
   */
  test("the worker_prose detector finds each carrier of the previous document", () => {
    const carriers = [
      `app=routing ${MARKER}`,
      `5m ${MARKER}`,
      `obs-t1:observer-ops.json#services[0] ${MARKER}`,
      `logs ${MARKER}`,
      `telemetry-${MARKER}`,
    ];
    for (const carrier of carriers) {
      const issues = envelopeIssues(`context from last sweep: ${carrier}`, PREVIOUS);
      expect(issues.map((i) => i.forbidden), `${carrier} should be worker_prose`).toContain(
        "worker_prose",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// What §7.2 says the envelope MUST carry
// ---------------------------------------------------------------------------

describe("§7.2: the envelope carries its six rows", () => {
  test("the sweep id, the window instant, the environment and every service", () => {
    const envelope = renderSweepEnvelope(envelopeInput());
    expect(envelope.brief).toContain(sweepTaskId(41));
    expect(envelope.brief).toContain("2026-09-06T12:00:00.000Z");
    expect(envelope.brief).toContain("cni-dev");
    for (const service of SERVICES) {
      expect(envelope.brief).toContain(service.name);
      expect(envelope.brief).toContain(service.namespace);
    }
    expect(envelope.brief).toContain("telemetry-writer");
    expect(envelope.title).toContain(sweepTaskId(41));
  });

  /**
   * **Per-service `checks[]` and window, so *"a brief cannot widen a check the
   * targets file bounded"*.** The override is asserted by value against the
   * default, which is what separates a renderer that copies each service's window
   * from one that prints the environment's default three times.
   */
  test("each service's own checks and window travel, and an override is not the default", () => {
    const envelope = renderSweepEnvelope(envelopeInput());
    expect(envelope.brief).toContain("rollout, logs, sink, endpoint");
    expect(envelope.brief).toContain("sink");
    // `authorization` overrides to 120s; the other two take the 300s default.
    expect(envelope.brief).toContain("120s");
    expect(envelope.brief).toContain("300s");
    // And a check NOT in any service's list never appears as one it may run.
    expect(envelope.brief).not.toContain("exec");
  });

  /**
   * The verdict rule travels VERBATIM — Finding F, *"apply the one your briefing
   * states and do not invent a finer one"*, and §7.2's own row. Asserted against
   * the exported constant rather than a copy of its sentence, so a reworded rule
   * cannot leave the brief carrying the old one.
   */
  test("the verdict rule travels verbatim and is the exported constant", () => {
    const envelope = renderSweepEnvelope(envelopeInput());
    expect(envelope.brief).toContain(TRIAGE_VERDICT_RULE);
    expect(TRIAGE_VERDICT_RULE).toContain("indeterminate");
    expect(TRIAGE_VERDICT_RULE).toContain("never");
  });

  /** A caller may substitute the rule; §7.2 says the envelope carries it, not that it owns it. */
  test("a supplied verdict rule replaces the default rather than joining it", () => {
    const rule = "A channel that did not answer is indeterminate. Apply this rule only.";
    const envelope = renderSweepEnvelope(envelopeInput({ verdictRule: rule }));
    expect(envelope.brief).toContain(rule);
    expect(envelope.brief).not.toContain(TRIAGE_VERDICT_RULE);
  });
});

// ---------------------------------------------------------------------------
// §7.4 — the `observer-ops.json` reader and §9.3's `blocked` extractor
// ---------------------------------------------------------------------------

describe("§7.4: observer-ops.json → ObserverArtifact", () => {
  test("the four SRD-OBSERVER-001 §9.3 statuses, by name", () => {
    expect([...OBSERVER_STATUSES]).toEqual(["success", "partial", "blocked", "failed"]);
  });

  test("both echoes are read, and the worker comes from the CONTEXT", () => {
    const read = parseObserverArtifact(
      JSON.stringify({
        sweep_id: "T-sweep-41",
        window_opened_at: "2026-09-06T12:00:00.000Z",
        status: "success",
        services: [{ service: "routing", assessment: "healthy" }],
      }),
      { worker: "obs-t1", path: "/x/observer-ops.json" },
    );
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.reply.artifact).toEqual({
      worker: "obs-t1",
      sweep_id: "T-sweep-41",
      window_opened_at: "2026-09-06T12:00:00.000Z",
    });
    expect(read.reply.status).toBe("success");
  });

  /**
   * **An omitted echo is `null` and NOT a refusal**, which is the whole point of
   * `ObserverArtifact` modelling both as `string | null`: §7.4 spends the absence
   * as `stale_replay`/`stale_window` at the HOST's own gate, and a reader that
   * threw here would delete the fault before the gate that exists to record it
   * ever saw it.
   */
  test("an artifact that omitted either echo is present with nulls, not refused", () => {
    const read = parseObserverArtifact(JSON.stringify({ status: "partial" }), {
      worker: "obs-t2",
      path: "/x/observer-ops.json",
    });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.reply.artifact.sweep_id).toBeNull();
    expect(read.reply.artifact.window_opened_at).toBeNull();
    expect(read.reply.status).toBe("partial");
  });

  /** A `status` outside §9.3's four is `null` — recorded as unknown, never coerced. */
  test("an unrecognised status is null rather than a fifth member", () => {
    const read = parseObserverArtifact(JSON.stringify({ status: "ok" }), {
      worker: "obs-t3",
      path: "/x/observer-ops.json",
    });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.reply.status).toBeNull();
  });

  test("bytes that are not JSON, and a JSON scalar, are refused and named", () => {
    for (const text of ["not json at all", "[]", "42", "null"]) {
      const read = parseObserverArtifact(text, { worker: "obs-t1", path: "/x/o.json" });
      expect(read.kind, `${text} should be refused`).toBe("refused");
      if (read.kind !== "refused") continue;
      expect(read.reason).toContain("/x/o.json");
    }
  });

  /**
   * SRD-OBSERVER-001 §9.3's extractor. `blocked` is the only status that becomes
   * a console-health issue (§6.7's table), and `failed` deliberately does not —
   * *"a tunnel-down control plane is `blocked`, not `failed`"*, and the operator
   * response differs.
   */
  test("blockedObservers names the blocked seats and nothing else", () => {
    const replies = [
      { artifact: { worker: "obs-t1", sweep_id: "s", window_opened_at: "w" }, status: "blocked" },
      { artifact: { worker: "obs-t2", sweep_id: "s", window_opened_at: "w" }, status: "failed" },
      { artifact: { worker: "obs-t3", sweep_id: "s", window_opened_at: "w" }, status: "success" },
      { artifact: { worker: "obs-t4", sweep_id: "s", window_opened_at: "w" }, status: null },
    ] as const;
    expect(blockedObservers(replies)).toEqual(["obs-t1"]);
  });

  test("the artifact path is the worker's outbox, the task, and files/", async () => {
    const run = await seedRun("2026-09-06T00-00-01Z-0001");
    const child = childTaskId(sweepTaskId(41), "slice1");
    expect(observerArtifactPath(run, "obs-t1", child)).toBe(
      join(workerOutboxDir(run.root, "obs-t1"), child, SWEEP_FILES_DIR, OBSERVER_ARTIFACT_FILE),
    );
    // The one duplicated constant, pinned to the module that owns it. The
    // source copy exists so the console's guarded subtree does not import
    // `harvest/`; this assertion is what stops the copy drifting.
    expect(SWEEP_FILES_DIR).toBe(OUTBOX_FILES_DIR);
    expect(OBSERVER_ARTIFACT_FILE).toBe("observer-ops.json");
  });

  test("an absent artifact file is `absent`, never an empty artifact", async () => {
    const read = await readObserverArtifactAt(join(base, "nope", "observer-ops.json"), {
      worker: "obs-t1",
      path: join(base, "nope", "observer-ops.json"),
    });
    expect(read.kind).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// §7.5 — the path-reading wrapper `parseTriageDocument` deliberately lacks
// ---------------------------------------------------------------------------

describe("§7.5: reading a triage.json off a path", () => {
  /**
   * **The wrapper exists because `parseTriageDocument` takes TEXT, deliberately**
   * — §13 task 6.1a's own words — and because `TriageDocumentRead` has *"no
   * `missing` arm"*: §7.5 records that *"an absent `triage.json` is not this
   * module's to interpret"*. So the absence arm is supplied HERE, by the reader
   * that is the only thing that can tell an absent file from a bad one, and the
   * parser keeps its two-arm shape.
   */
  test("an absent document is `absent`, and the parser's two arms are untouched", async () => {
    const path = join(base, "missing", "triage.json");
    const read = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path });
    expect(read.kind).toBe("absent");
  });

  test("a present document parses through the real schema", async () => {
    const dir = join(base, "collate", SWEEP_FILES_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, TRIAGE_DOCUMENT_FILE);
    await writeFile(
      path,
      JSON.stringify({
        schema: "pifleet.triage/v1",
        sweep_id: "T-sweep-41",
        services: [
          {
            service: "routing",
            assessment: "healthy",
            coverage: [{ channel: "rollout", result: "answered" }],
            selector: "app=routing",
            window: "5m",
            evidence_ref: ["obs-t1:observer-ops.json#services[0]"],
            observer: "obs-t1",
          },
        ],
        unaccounted: [],
      }),
      "utf8",
    );
    const read = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.document.worker).toBe(TRIAGE_COLLATOR);
    expect(read.document.sweep_id).toBe("T-sweep-41");
    expect(read.document.services[0]?.service).toBe("routing");
  });

  test("a malformed document is REFUSED rather than absent — the two are different facts", async () => {
    const path = join(base, "bad-triage.json");
    await writeFile(path, "{not json", "utf8");
    const read = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path });
    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("not_json");
  });

  test("the document path is the collator's outbox, the collation task, and files/", async () => {
    const run = await seedRun("2026-09-06T00-00-02Z-0002");
    const collate = collationTaskId(sweepTaskId(41));
    expect(triageDocumentPath(run, collate)).toBe(
      join(workerOutboxDir(run.root, TRIAGE_COLLATOR), collate, SWEEP_FILES_DIR, TRIAGE_DOCUMENT_FILE),
    );
  });
});

// ---------------------------------------------------------------------------
// The producers, over an INJECTED dispatch
// ---------------------------------------------------------------------------

interface Sent {
  readonly taskId: string;
  readonly worker: string;
  readonly title: string;
  readonly brief: string;
}

function producerFixture(
  run: RunPaths,
  outcome:
    | SweepDispatchOutcome
    | { publishReplies: PublishRepliesPort } = {
    kind: "accepted",
  },
): { sent: Sent[]; producers: ReturnType<typeof sweepProducers> } {
  const sent: Sent[] = [];
  const publishReplies = "publishReplies" in outcome ? outcome.publishReplies : undefined;
  const dispatchOutcome: SweepDispatchOutcome =
    "publishReplies" in outcome ? { kind: "accepted" } : outcome;
  const producers = sweepProducers({
    run,
    environment: "cni-dev",
    services: SERVICES,
    defaultWindowS: 300,
    previousDocument: async () => null,
    dispatch: async (args) => {
      sent.push(args);
      return dispatchOutcome;
    },
    ...(publishReplies === undefined ? {} : { publishReplies }),
  });
  return { sent, producers };
}

describe("§6.3 steps 2-3, 5, 6-9: the producers", () => {
  test("openSweep dispatches ONE envelope to the collator and reports `opened`", async () => {
    const run = await seedRun("2026-09-06T00-00-03Z-0003");
    const { sent, producers } = producerFixture(run);
    const open = await producers.openSweep(sweepTaskId(41), "2026-09-06T12:05:00.000Z");
    expect(open).toEqual({ kind: "opened" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.worker).toBe(TRIAGE_COLLATOR);
    expect(sent[0]!.taskId).toBe(sweepTaskId(41));
    expect(sent[0]!.brief).toContain(sweepTaskId(41));
    expect(sent[0]!.brief).toContain(TRIAGE_VERDICT_RULE);
    // The brief the actor sends is the one the renderer audited.
    expect(envelopeIssues(sent[0]!.brief, null)).toEqual([]);
  });

  /**
   * §6.10 exit 5 travels as a VALUE. `SweepOpen`'s docblock: *"A refused
   * admission is not a thrown pass … a throw here would be caught by the loop and
   * logged as a fault, which is the same information with none of the
   * deduplication."*
   */
  test("a budget refusal is a value, not a throw", async () => {
    const run = await seedRun("2026-09-06T00-00-04Z-0004");
    const { producers } = producerFixture(run, {
      kind: "budget_exhausted",
      reason: "run ceiling reached",
    });
    const open = await producers.openSweep(sweepTaskId(41), "2026-09-06T12:05:00.000Z");
    expect(open.kind).toBe("budget_exhausted");
    if (open.kind !== "budget_exhausted") return;
    expect(open.reason).toContain("run ceiling reached");
  });

  /**
   * **The instant the envelope names is the window's LOWER bound, derived from
   * the dispatch instant — and asserting it is what keeps §7.4's freshness check
   * from being vacuous.**
   *
   * §7.2 calls the field *"the lower bound of this sweep's observation window"*;
   * §7.4's opening sentence calls it *"the moment the observer's queries start
   * looking back from"*, which reads as the other end. §7.4's own table settles
   * it — a value *"earlier than `dispatched_at − default_window − reserve_s`"* is
   * refused because *"the observer looked further back than configured"*, and
   * that is only a sentence about the lower bound.
   *
   * So the assertion is two-sided, and the negative half is the one that matters:
   * an envelope echoing the DISPATCH instant would be in range on every sweep no
   * matter how far back the observer really queried, and §7.4's *"queried six
   * hours against a five-minute configuration"* check would pass forever while
   * catching nothing.
   */
  test("openSweep names the window's lower bound, not the dispatch instant", async () => {
    const run = await seedRun("2026-09-06T00-00-05Z-0005");
    const { sent, producers } = producerFixture(run);
    await producers.openSweep(sweepTaskId(41), "2026-09-06T12:05:00.000Z");
    // 12:05:00 minus the 300s default window.
    expect(sent[0]!.brief).toContain("2026-09-06T12:00:00.000Z");
    expect(sent[0]!.brief).not.toContain("2026-09-06T12:05:00.000Z");
  });

  /** The derivation on its own, so the arithmetic has a probe apart from the prose. */
  test("windowOpenedAt subtracts the environment's configured window", () => {
    expect(windowOpenedAt("2026-09-06T12:05:00.000Z", 300)).toBe("2026-09-06T12:00:00.000Z");
    expect(windowOpenedAt("2026-09-06T12:05:00.000Z", 0)).toBe("2026-09-06T12:05:00.000Z");
  });

  /**
   * A host argument that is wrong for the life of the run THROWS — this module's
   * split, and `dispatchedAt` is minted host-side. A worker-written value would
   * get a refusal instead.
   */
  test("an unparseable dispatch instant is a throw, not a silent epoch", () => {
    expect(() => windowOpenedAt("not an instant", 300)).toThrow(SweepEnvelopeError);
  });

  test("join reads every present artifact and names the blocked seats", async () => {
    const run = await seedRun("2026-09-06T00-00-06Z-0006");
    const sweepId = sweepTaskId(41);
    const write = async (worker: string, aspect: string, body: unknown): Promise<void> => {
      const child = childTaskId(sweepId, aspect);
      const dir = join(workerOutboxDir(run.root, worker), child, SWEEP_FILES_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, OBSERVER_ARTIFACT_FILE), JSON.stringify(body), "utf8");
    };
    await write("obs-t1", "slice1", {
      sweep_id: sweepId,
      window_opened_at: "2026-09-06T12:00:00.000Z",
      status: "blocked",
    });

    /*
     * COVERAGE DROPPED 2026-09-07 with the move to one observer. This used to run
     * three seats at once — one success, one blocked, one that wrote nothing —
     * which is what proved that `artifacts[]` and `blocked[]` are computed
     * independently and that an absent seat is absent rather than present-with-
     * nulls. With a single seat those three states can only be exercised one at a
     * time, and the "absent" arm is covered by the empty-join test below.
     */
    const { producers } = producerFixture(run);
    const joined = await producers.join(sweepId);
    expect(joined.artifacts.map((a) => a.worker)).toEqual(["obs-t1"]);
    expect(joined.artifacts[0]!.window_opened_at).toBe("2026-09-06T12:00:00.000Z");
    expect(joined.blocked).toEqual(["obs-t1"]);
  });

  /**
   * **THE SILENT FALSE SUCCESS, and it is the failure this console met first.**
   *
   * Measured 2026-09-07 on the live console: the observer started, ran one `ls`,
   * narrated what it was about to do, and its turn ended eleven seconds later
   * with an empty outbox — whereupon the supervisor read the quiet transcript as
   * `quiesced` and settled the task `success`. Forty-five passes ran that way and
   * produced not one artifact.
   *
   * The COUNT was never wrong: §6.5 harvests what the host can read, so those
   * services came back unobserved and escalated to coverage exactly as designed.
   * What was missing is the diagnosis. "Coverage" reads as *the environment did
   * not answer*; the truth was *the worker said it was done and wrote nothing*,
   * and only one of those is a reason to go and look at a cluster.
   *
   * The negative half is the load-bearing one: a seat that wrote nothing and
   * whose task did NOT settle `success` must stay out of this list, because a
   * worker that failed, was blocked, or never ran has not claimed anything. The
   * list is for the contradiction alone.
   */
  test("a seat that settled success and wrote nothing is named, and only that seat", async () => {
    const run = await seedRun("2026-09-06T00-00-14Z-0014");
    const sweepId = sweepTaskId(41);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    const child = childTaskId(sweepId, seat.aspect);
    const recordPath = taskRecordPath(workerPaths(run, seat.worker), child);
    await mkdir(dirname(recordPath), { recursive: true });

    const settleAs = async (verdict: string): Promise<void> => {
      await writeFile(
        recordPath,
        JSON.stringify({
          schema: "pifleet.taskrecord/v1",
          task_id: child,
          attempt_id: "file:deadbeefdeadbeef",
          worker: seat.worker,
          run_id: run.runId,
          epoch: 1,
          verdict,
          reason: "transcript_quiesced",
          settled_at: "2026-09-06T12:00:00.000Z",
          tree_hash: null,
        }),
        "utf8",
      );
    };

    const { producers } = producerFixture(run);

    // POSITIVE: settled success, no artifact anywhere -> named.
    await settleAs("success");
    const claimed = await producers.join(sweepId);
    expect(claimed.artifacts).toEqual([]);
    expect(claimed.claimedSuccess).toEqual([seat.worker]);
    // It is NOT `blocked` — that arm is for a seat that reported it could not see.
    expect(claimed.blocked).toEqual([]);

    // NEGATIVE: same missing artifact, a verdict that claims nothing -> silent.
    await settleAs("failed");
    const failed = await producers.join(sweepId);
    expect(failed.artifacts).toEqual([]);
    expect(failed.claimedSuccess).toEqual([]);
  });

  /**
   * **THE COLLATOR MUST BE HANDED THE REPLIES, and it never was.**
   *
   * `renderCollationEnvelope` names `/replies/<child>.json` for every seat, and
   * for as long as this console existed nothing wrote those files. Each worker
   * has its OWN `/outbox`: the observer writes into its run and the collator
   * reads its own, so the two never meet.
   *
   * Measured 2026-09-07 on the live console, and the collator said it in as many
   * words — *"I found the task-level directories for T-sweep-1 and
   * T-sweep-1-collate, but there is no directory for T-sweep-1-slice1 … the
   * /replies directory is empty"* — after the observer had done the work
   * correctly and written both artifacts. A perfect sweep collated to nothing.
   *
   * The review console has always published each child's reply before dispatching
   * its collation; this console named the mechanism in the brief and skipped the
   * act. The negative half matters as much: a seat whose artifact was NOT read
   * must not be published, or the collator is handed an empty file and told it is
   * a report.
   */
  test("every artifact the join reads is published to the collator, and only those", async () => {
    const run = await seedRun("2026-09-06T00-00-15Z-0015");
    const sweepId = sweepTaskId(41);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    const child = childTaskId(sweepId, seat.aspect);
    const dir = join(workerOutboxDir(run.root, seat.worker), child, SWEEP_FILES_DIR);
    await mkdir(dir, { recursive: true });
    /*
     * The fixture carries a FINDING, and that is the point of it. The first
     * version of this test asserted only `reply.worker`, which the narrow
     * `ObserverArtifact` also satisfies — so it passed while the collator was
     * being handed a 73-byte envelope with the report stripped out. The payload
     * must be the artifact the observer wrote, whole.
     */
    await writeFile(
      join(dir, OBSERVER_ARTIFACT_FILE),
      JSON.stringify({
        sweep_id: sweepId,
        window_opened_at: "2026-09-06T12:00:00.000Z",
        status: "success",
        services: [{ service: "alert-notifier", assessment: "healthy" }],
      }),
      "utf8",
    );

    const published: Array<{ child: string; reply: unknown }> = [];
    const declaredUnder: string[] = [];
    const { producers } = producerFixture(run, {
      publishReplies: async (taskId, replies) => {
        declaredUnder.push(taskId);
        for (const r of replies) published.push({ child: r.task_id, reply: r.reply });
      },
    });

    const joined = await producers.join(sweepId);
    expect(joined.artifacts.map((a) => a.worker)).toEqual([seat.worker]);
    // BY NAME: the child task id the collation brief will name, not just "one call".
    expect(published.map((p) => p.child)).toEqual([child]);
    /*
     * AND THE DECLARING TASK IS THE COLLATION'S, by value. §7.4: `get_replies`
     * refuses a declaration whose `task_id` does not match the collator's own
     * `/policy/task`, and the task that reads this set is the collation — so a
     * publisher that declared under the SWEEP id would produce a set that is
     * fresh, correct, and refused as stale on every honest path.
     */
    expect(declaredUnder).toEqual([collationTaskId(sweepId)]);
    /*
     * THE REPORT SURVIVES, asserted by value. `worker` alone is satisfied by the
     * narrow freshness echo, which is exactly the bug this replaces: the collator
     * got `{worker, sweep_id: null, window_opened_at: null}` and correctly found
     * no services in it.
     */
    const reply = published[0]!.reply as { services?: unknown; status?: string };
    expect(reply.services).toEqual([{ service: "alert-notifier", assessment: "healthy" }]);
    expect(reply.status).toBe("success");
  });

  test("a seat with no artifact publishes NOTHING — and declares the EMPTY SET", async () => {
    const run = await seedRun("2026-09-06T00-00-16Z-0016");
    const calls: Array<{ taskId: string; children: string[] }> = [];
    const { producers } = producerFixture(run, {
      publishReplies: async (taskId, replies) => {
        calls.push({ taskId, children: replies.map((r) => r.task_id) });
      },
    });
    const joined = await producers.join(sweepTaskId(41));
    expect(joined.artifacts).toEqual([]);
    /*
     * An empty file in /replies is worse than a missing one: the collator would
     * read it as a report rather than as an absence. So NO child is published.
     *
     * **But the declaration IS written, holding `[]`** — §7.4: *"an EMPTY array
     * is a value, not an absence"*. Skipping the call would leave the previous
     * sweep's declaration in place, and `get_replies` would answer a question
     * about sweep 41 with sweep 40's set until the staleness check happened to
     * catch it. One call, zero children, is the honest answer.
     */
    expect(calls).toEqual([{ taskId: collationTaskId(sweepTaskId(41)), children: [] }]);
  });

  test("join of a sweep nobody answered is empty on both members, not a throw", async () => {
    const run = await seedRun("2026-09-06T00-00-07Z-0007");
    const { producers } = producerFixture(run);
    expect(await producers.join(sweepTaskId(41))).toEqual({ artifacts: [], blocked: [], claimedSuccess: [] });
  });

  test("collate dispatches the collation task and reads the document back", async () => {
    const run = await seedRun("2026-09-06T00-00-08Z-0008");
    const sweepId = sweepTaskId(41);
    const collate = collationTaskId(sweepId);
    const dir = join(workerOutboxDir(run.root, TRIAGE_COLLATOR), collate, SWEEP_FILES_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, TRIAGE_DOCUMENT_FILE),
      JSON.stringify({ schema: "pifleet.triage/v1", sweep_id: sweepId, services: [] }),
      "utf8",
    );
    const { sent, producers } = producerFixture(run);
    const out = await producers.collate(sweepId);
    expect(sent.map((s) => s.taskId)).toEqual([collate]);
    expect(sent[0]!.worker).toBe(TRIAGE_COLLATOR);
    expect(out.document?.sweep_id).toBe(sweepId);
    // §6.3 step 9's citation is a pointer into the run tree, and it is required
    // even when the document is unreadable.
    expect(out.evidenceRef).toContain(collate);
  });

  /**
   * **A collation that produced nothing is `document: null` WITH an
   * `evidenceRef`.** `SweepCollation.evidenceRef`'s docblock: *"a sweep that
   * collated nothing still has a task an operator can go and read, and
   * `ConsoleHealthFacts.evidenceRef` is non-nullable for the reason a clear that
   * names nothing is a clear derived from an absence."*
   */
  test("a collation with no readable document still cites the task", async () => {
    const run = await seedRun("2026-09-06T00-00-09Z-0009");
    const { producers } = producerFixture(run);
    const out = await producers.collate(sweepTaskId(41));
    expect(out.document).toBeNull();
    expect(out.evidenceRef).toContain(collationTaskId(sweepTaskId(41)));
  });

  /**
   * The collation brief names the reply files — `roles/triage.md:233-236`: *"The
   * brief names them; do not go looking for others."* And it is still an envelope,
   * so it is still audited.
   */
  test("the collation brief names each reply path and passes the same audit", async () => {
    const run = await seedRun("2026-09-06T00-00-12Z-0012");
    const { sent, producers } = producerFixture(run);
    await producers.collate(sweepTaskId(41));
    const brief = sent[0]!.brief;
    // Derived from the roster rather than a fixed list, so the assertion follows
    // the console rather than needing an edit each time its seats change.
    for (const seat of TRIAGE_CONSOLE_ASPECTS) {
      expect(brief).toContain(childTaskId(sweepTaskId(41), seat.aspect));
    }
    expect(envelopeIssues(brief, null)).toEqual([]);
  });

  /**
   * `T-sweep-120`, 2026-09-13 — the sweep that wedged the console.
   *
   * `obs-t1`'s report EXISTED and was read. It carried no `services` array at
   * all: its rows sat under `coverage` as `{service, workload, checks[]}`, with
   * `assessment`, `selector`, `window` and `evidence_ref` absent. The brief
   * ordered the collator to copy those fields *"from the observer's row and NOT
   * reconstructed"*, and named `unaccounted` for exactly one case — a file that
   * was MISSING. So `tri-1` held an instruction it could not obey, about a file
   * that was there, with no sanctioned way to say so. It spent its entire
   * deadline running `rg` across the container filesystem hunting for values
   * that exist in no file, wrote no collation, and was still wedged on that
   * abandoned turn when the next sweep was staged 25 minutes later.
   *
   * **The gap was never the row shape.** `skills/observer-ops/SKILL.md` has
   * pinned that since [[ISC-1125]], and sweep 119 produced it perfectly from
   * this same code. The gap is that a file which EXISTS but cannot be read as
   * rows had no named outcome — and that nothing told the collator to stop
   * looking, which is the half that turns a lost report into a lost console.
   *
   * Deleting either half of that paragraph reddens this.
   */
  test("a listed-but-unusable report has a named outcome, and searching for it is forbidden", async () => {
    const run = await seedRun("2026-09-13T00-00-41Z-0041");
    const { sent, producers } = producerFixture(run);
    await producers.collate(sweepTaskId(41));
    const brief = sent[0]!.brief;

    // The case that had no name: listed, present, and unusable.
    expect(
      brief,
      "the brief still names only the MISSING-file case, which is the gap T-sweep-120 fell into",
    ).toContain("no `services` array");
    expect(brief).toContain("`unaccounted`");

    // The half that ends the deadlock rather than merely naming the case.
    expect(
      brief,
      "the collator is never told to stop looking — T-sweep-120 spent its whole deadline " +
        "searching the filesystem for values that exist in no file",
    ).toContain("Do not go looking for the missing values");

    // Still an envelope, so still audited for the same four classes.
    expect(envelopeIssues(brief, null)).toEqual([]);
  });

  /**
   * **The previous document reaches `openSweep` through the same projection**, so
   * the anti-criterion holds on the PRODUCTION path and not only on the renderer
   * a test calls directly. A producer that fetched the document and passed it
   * whole would fail here and nowhere else.
   */
  test("the marker cannot cross into a dispatched brief either", async () => {
    const run = await seedRun("2026-09-06T00-00-13Z-0013");
    const sent: Sent[] = [];
    const producers = sweepProducers({
      run,
      environment: "cni-dev",
      services: SERVICES,
      defaultWindowS: 300,
      previousDocument: async () => PREVIOUS,
      dispatch: async (args) => {
        sent.push(args);
        return { kind: "accepted" };
      },
    });
    await producers.openSweep(sweepTaskId(42), "2026-09-06T12:10:00.000Z");
    expect(sent[0]!.brief).not.toContain(MARKER);
    expect(sent[0]!.brief).toContain("unhealthy");
  });

  /**
   * `dispatchObserver` sends the WORKER's own brief, out of the fan-out request
   * the collator wrote — §6.3 step 5. It is `tri-1`'s judgement being carried,
   * which is the one place §7.3 sanctions a worker string becoming a dispatch,
   * and it is still audited for the four classes before it goes.
   */
  test("dispatchObserver refuses a slice with no request rather than sending an empty brief", async () => {
    const run = await seedRun("2026-09-06T00-00-14Z-0014");
    const { sent, producers } = producerFixture(run);
    let thrown: unknown = null;
    try {
      await producers.dispatchObserver(sweepTaskId(41), {
        worker: "obs-t1",
        services: ["routing"],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepEnvelopeError);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SRD-WORKER-DISPATCH-EXTENSION §13 task 3.4 — the diagnosis names where to look
// ---------------------------------------------------------------------------

/**
 * **THE MESSAGE MAY NAME THE SESSION ENTRY; NOTHING MAY BRANCH ON IT.**
 *
 * §6.3's layer 4 gives the host two typed session entries — §7.1's on delivery,
 * §7.2's at `agent_end` with nothing delivered — and task 3.4's whole content is
 * putting their names in front of the operator who is already reading this line.
 * §6.5 property 3 states the fence in one sentence: they *"may appear in an actor
 * log, in `pifleet monitor`, and in `claimedSuccess`'s message. They may not
 * appear in a verdict, a coverage count, an incident transition or a
 * notification."*
 *
 * **So the acceptance has two halves and only the second is hard.** A test that
 * asserts the new words are in the string passes trivially and proves nothing —
 * it is green for an implementation that also started counting the entry. The
 * three tests below are ordered weakest-first for that reason, and the value is
 * in the last two:
 *
 *  1. the words are there (the deliverable);
 *  2. **the join's answer is BY VALUE what the run tree says** — the
 *     count/verdict/transition half, and, because `toEqual` compares the object
 *     whole, also the assertion that catches an entry name smuggled into a member;
 *  3. **a source tripwire**, because 2 is behavioural and §6.5's drift is
 *     *"reading it is cheaper than re-reading the outbox"* — a read wired into a
 *     branch this fixture does not reach would leave 2 green. Failure mode 9.8
 *     is named in the SRD as *"the one failure with no runtime symptom"*, which
 *     is precisely the thing a behavioural probe cannot see.
 *
 * The negative arm of 2 is not decoration either: the whole list exists for the
 * CONTRADICTION — settled `success`, wrote nothing — so a seat that settled
 * `failed` must produce no line at all. A message that fired on every silent seat
 * would be a message an operator learns to skip.
 */
describe("§13 task 3.4: claimedSuccess names §7.1/§7.2's entries and decides nothing", () => {
  /** The two entry names, spelled here as the SRD spells them rather than imported: nothing exports them, deliberately. */
  const SUBMIT_ENTRY = "pifleet.submit/v1";
  const NO_SUBMIT_ENTRY = "pifleet.no_submit/v1";

  /** Settles the one seat's child task with `verdict`, writing no artifact. */
  async function settleWithNoArtifact(run: RunPaths, sweepId: string, verdict: string): Promise<void> {
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    const recordPath = taskRecordPath(workerPaths(run, seat.worker), childTaskId(sweepId, seat.aspect));
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({
        schema: "pifleet.taskrecord/v1",
        task_id: childTaskId(sweepId, seat.aspect),
        attempt_id: "file:deadbeefdeadbeef",
        worker: seat.worker,
        run_id: run.runId,
        epoch: 1,
        verdict,
        reason: "transcript_quiesced",
        settled_at: "2026-09-06T12:00:00.000Z",
        tree_hash: null,
      }),
      "utf8",
    );
  }

  /**
   * **TWO RUN TREES, and the asymmetry is what makes the fixture worth writing.**
   *
   * `producerFixture` injects no `seatRun`, so the collator's tree and the seat's
   * tree are the same object there — and under that fixture `seatTree.sessionsDir`
   * and `deps.run.sessionsDir` are the same string, so a message that named the
   * WRONG one would be green. That is [[feedback_degenerate_fixtures_hide_narrowing]]
   * exactly, and this console has already paid for it once: `SweepProducerDeps.seatRun`
   * exists because the join read observer artifacts out of the collator's tree,
   * a directory that cannot contain them, and failed silently for as long as it
   * existed.
   *
   * Captures stderr on `triage-command.test.ts`'s pattern, so the NEGATIVE case
   * (no line at all) is assertable rather than merely unseen.
   */
  async function joinWithLog(
    collatorRun: RunPaths,
    seatTree: RunPaths,
    sweepId: string,
  ): Promise<{
    joined: Awaited<ReturnType<ReturnType<typeof sweepProducers>["join"]>>;
    logged: string[];
    published: string[];
  }> {
    const logged: string[] = [];
    const published: string[] = [];
    const before = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const producers = sweepProducers({
        run: collatorRun,
        environment: "cni-dev",
        services: SERVICES,
        defaultWindowS: 300,
        previousDocument: async () => null,
        dispatch: async () => ({ kind: "accepted" }),
        seatRun: async () => seatTree,
        publishReplies: async (_taskId, replies) => {
          for (const r of replies) published.push(r.task_id);
        },
      });
      return { joined: await producers.join(sweepId), logged, published };
    } finally {
      console.error = before;
    }
  }

  test("the line names both entries and the SEAT's sessions directory, not the collator's", async () => {
    const collatorRun = await seedRun("2026-09-06T00-00-17Z-0017");
    const seatTree = await seedRun("2026-09-06T00-00-17Z-0117");
    const sweepId = sweepTaskId(41);
    await settleWithNoArtifact(seatTree, sweepId, "success");

    const { logged } = await joinWithLog(collatorRun, seatTree, sweepId);
    expect(logged).toHaveLength(1);
    const line = logged[0]!;
    expect(line).toContain(SUBMIT_ENTRY);
    expect(line).toContain(NO_SUBMIT_ENTRY);
    /*
     * BY VALUE against `RunPaths`, and BOTH directions. A console is four runs,
     * not one: a message naming the collator's tree would send an operator to a
     * directory the worker never wrote in, and a wrong pointer is worse than no
     * pointer because it looks like an answer.
     */
    expect(line).toContain(seatTree.sessionsDir);
    expect(line).not.toContain(collatorRun.sessionsDir);
    // The half it replaces is still there: the transcript, not the cluster.
    expect(line).toContain("not the cluster");
  });

  /**
   * **THE CONSTRAINT, AND IT IS THE TASK.** Task 3.4's acceptance: *"the message
   * text changes; no verdict, count or transition changes."*
   *
   * Asserted by pinning the WHOLE return value rather than one member, because
   * the drift §6.5 predicts does not announce itself as a new field — it arrives
   * as a claimed-success seat quietly counted among `artifacts[]`, which is the
   * mutation §12 names (*"wiring it into `completeSweep`'s artifact count"*).
   * `completeSweep` reads `artifacts.length` and `blocked.length`, so this object
   * IS the count for everything downstream of the join.
   */
  test("naming the entries moved no count: the join is the run tree's own answer, by value", async () => {
    const collatorRun = await seedRun("2026-09-06T00-00-18Z-0018");
    const seatTree = await seedRun("2026-09-06T00-00-18Z-0118");
    const sweepId = sweepTaskId(41);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    await settleWithNoArtifact(seatTree, sweepId, "success");

    const { joined, published } = await joinWithLog(collatorRun, seatTree, sweepId);
    expect(joined).toEqual({ artifacts: [], blocked: [], claimedSuccess: [seat.worker] });
    // A claim is not a reply: nothing reached the collator's /replies either.
    expect(published).toEqual([]);
    /*
     * NO `JSON.stringify(joined)` SEARCH FOR THE ENTRY NAMES, and the omission is
     * deliberate. `toEqual` compares the object whole and fails on an extra key,
     * so a name smuggled into any member — a reason appended to `claimedSuccess`,
     * a synthetic artifact, a new field — already reddens the line above.
     * MEASURED: the mutation that appends `(see pifleet.submit/v1)` to the pushed
     * worker id fails this test at that assertion. A substring search underneath
     * it would be `ISC-1075`'s *"second, weaker assertion about the same"* object.
     */

    // NEGATIVE: a verdict that claims nothing is silent, and still counts zero.
    await settleWithNoArtifact(seatTree, sweepId, "failed");
    const failed = await joinWithLog(collatorRun, seatTree, sweepId);
    expect(failed.joined).toEqual({ artifacts: [], blocked: [], claimedSuccess: [] });
    expect(failed.logged).toEqual([]);
  });

  /**
   * **THE TRIPWIRE FOR THE FAILURE WITH NO RUNTIME SYMPTOM.**
   *
   * `test/unit/config.test.ts`'s ISC-1063 idiom — a reference COUNT, deliberately
   * brittle. §6.5: *"once `pifleet.submit/v1` exists in the session, somebody will
   * notice that reading it is cheaper than re-reading the outbox"*, and that read
   * lands in this module first, because this module is where the absence is
   * already noticed.
   *
   * Each name may be spelled ONCE in `triage-envelope.ts`, in the sentence the
   * operator reads. A second spelling — a constant to compare against, an
   * `includes()`, a filter — is an edit somebody makes on purpose, and this test
   * is the line they have to change to make it. Comments in that module cite the
   * entries as *"§7.1's"* and *"§7.2's"* for the same reason: the count means
   * something only while a mention costs one.
   *
   * `sessionsDir` is counted for the same reason and is the stronger half: a
   * module that starts BRANCHING on an entry must first reach the directory, and
   * there is exactly one expression here that names it.
   */
  test("neither entry name is spelled twice in the module, and the sessions directory is reached once", () => {
    const source = readFileSync(new URL("../../src/run/triage-envelope.ts", import.meta.url).pathname, "utf8");
    const occurrences = (needle: string): number => source.split(needle).length - 1;
    expect(occurrences(SUBMIT_ENTRY)).toBe(1);
    expect(occurrences(NO_SUBMIT_ENTRY)).toBe(1);
    expect(occurrences("sessionsDir")).toBe(1);
  });
});

/**
 * The slice brief's reporting path — the defect measured on `T-sweep-1`,
 * 2026-09-07.
 *
 * `roles/triage.md` forbade exactly this ("its own task id, not yours") — the
 * wording measured at the time, since reworded away; the file now records the
 * supersession rather than the instruction — and
 * the collator did it anyway; `observerArtifactPath` reads only the child id, so
 * the report landed where nothing looks and three services graded `coverage`
 * while the observer was writing correct artifacts. The host is the last holder
 * of the right id, so the repair belongs here rather than in a third prompt line.
 */
describe("normalizeSliceReportingPath", () => {
  test("rewrites the collator's own id to the id the slice is dispatched under", () => {
    const brief =
      "Write the artifact pair `observer-ops.json` and `observer-ops.md` into " +
      "`/outbox/T-sweep-1/files/` — its own task id, not yours.";
    const result = normalizeSliceReportingPath(brief, "T-sweep-1-slice1");
    expect(result.rewrote).toEqual(["T-sweep-1"]);
    expect(result.brief).toContain("/outbox/T-sweep-1-slice1/files/");
    expect(result.brief).not.toContain("/outbox/T-sweep-1/files/");
  });

  test("a brief already naming the child id is returned unchanged and reports nothing", () => {
    const brief = "write into /outbox/T-sweep-1-slice1/files/ and nowhere else";
    const result = normalizeSliceReportingPath(brief, "T-sweep-1-slice1");
    expect(result.rewrote).toEqual([]);
    expect(result.brief).toBe(brief);
  });

  test("a brief naming no outbox path is untouched", () => {
    const brief = "check grafana in aodapnc-grafana-dev";
    const result = normalizeSliceReportingPath(brief, "T-sweep-1-slice1");
    expect(result.rewrote).toEqual([]);
    expect(result.brief).toBe(brief);
  });

  /**
   * Every wrong id is REPORTED, not just the first — a brief that names two is a
   * collator that has lost the thread twice, and a log naming one of them sends
   * the reader looking for a single typo.
   */
  test("reports every wrong id it rewrites", () => {
    const result = normalizeSliceReportingPath(
      "pair into /outbox/T-9/files/ then also /outbox/T-9-slice2/files/",
      "T-9-slice1",
    );
    expect(result.rewrote).toEqual(["T-9", "T-9-slice2"]);
    expect(result.brief).toBe(
      "pair into /outbox/T-9-slice1/files/ then also /outbox/T-9-slice1/files/",
    );
  });
});

/**
 * §7.4's freshness echo, and the fault `sweepIdEcho` calls `absent` — an artifact
 * from a worker that was never told. Measured 2026-09-08: five sweeps produced
 * correct artifacts and every one was discarded for want of two strings, because
 * the collator carried the VALUES into the brief and dropped the INSTRUCTION.
 */
describe("freshnessEchoDemand (ISC-1119, authored under ISC-1136)", () => {
  const WINDOW = "2026-09-08T01:21:10.427Z";
  const REAL_BRIEF =
    `Sweep T-sweep-1. Observation window opens ${WINDOW}. Check \`grafana\` in namespace ` +
    "`aodapnc-grafana-dev`. Both files, every time.";

  test("names both fields in their exact spellings, quoting the sweep id and the window", () => {
    const demand = freshnessEchoDemand("T-sweep-1", WINDOW);
    expect(demand).toContain('`sweep_id` exactly "T-sweep-1"');
    expect(demand).toContain(`\`window_opened_at\` exactly "${WINDOW}"`);
  });

  /**
   * The host must not mint a second spelling of the instant. If the collator
   * dropped it, the demand names the brief rather than a value — see
   * `readWindowInstant` for why the host cannot supply one.
   */
  test("a null window produces no invented value", () => {
    const demand = freshnessEchoDemand("T-sweep-9", null);
    expect(demand).toContain('`sweep_id` exactly "T-sweep-9"');
    expect(demand).not.toMatch(/window_opened_at` exactly "/);
    expect(demand).toContain("as this brief states the observation window opening");
  });

  /**
   * **THE CONSEQUENCE CLAUSE, and it is the half that does the work.** A demand
   * naming two fields and not what happens without them is a formatting note; the
   * measured failure was five correct artifacts discarded whole.
   */
  test("it says what an artifact missing either one costs", () => {
    const demand = freshnessEchoDemand("T-sweep-1", WINDOW);
    expect(demand).toContain("discarded whole");
    expect(demand).toContain("recorded as unobserved");
    expect(demand).toContain("copied from this brief and from nowhere else");
  });

  test("readWindowInstant finds the instant in the collator's own prose", () => {
    expect(readWindowInstant(REAL_BRIEF)).toBe(WINDOW);
    expect(readWindowInstant("Sweep T-sweep-9. Check grafana.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §12's publish/declare SET-EQUALITY criterion — SRD-WORKER-DISPATCH-EXTENSION
// task 5.3.
// ---------------------------------------------------------------------------

/**
 * **WHAT THE HOST PUBLISHED AND WHAT THE TOOL WILL RETURN ARE THE SAME SET.**
 *
 * §12: *"Anti: what the host published and what the tool returns are the same
 * set. Probe: drive `publishReply` and the declaration through one composition
 * root over a fixture sweep; assert set equality."*
 *
 * ## Why this drives the REAL effect and not a fixture
 *
 * A test that asserted *"`writeReply` was called and `writeRepliesPolicy` was
 * called"* would be a test that the composition root calls two functions, which
 * is the thing §7.4 says is not enough: two calls can be kept in step by a
 * reader right up until the day one of them is edited. The criterion is about
 * two ARTEFACTS, so both are read back off disk — `<run>/replies/<collator>/`
 * and `<worker-dir>/replies-policy` — and compared as sets. Nothing here
 * inspects a call count.
 *
 * The path under test is the whole production wiring minus the CLI's `import`:
 * `sweepProducers` → `SweepProducerDeps.publishReplies` →
 * `consoleTransport.publishReplies` → `productionRelayEffects.publishReplies`.
 * That is the same chain `cli/index.ts`'s `publishRepliesFor` builds, and it is
 * the chain the review console's `fanOut` also lands on — which is what makes
 * "one composition root" a fact about the code rather than a claim about two.
 *
 * ## And why a SECOND sweep is part of the criterion rather than a bonus
 *
 * `/replies` is one directory per worker per RUN and the triage console is one
 * long-lived run, so it ACCUMULATES (Finding E). After two sweeps the directory
 * and the declaration MUST have stopped agreeing — that divergence is the whole
 * reason `get_replies` cannot be a `readdir` — while the declaration must equal
 * exactly what the second sweep published. A one-sweep test cannot tell a
 * correct declaration from a `readdir` in disguise, because on sweep one they
 * are the same answer.
 */
describe("§7.4: the published set and the declared set are one set", () => {
  /** `materialize.ts`'s two establishing steps, which run before `docker run`. */
  async function establishCollator(
    run: RunPaths,
  ): Promise<{ repliesDir: string; policyFile: string }> {
    const paths = workerPaths(run, TRIAGE_COLLATOR);
    await mkdir(paths.dir, { recursive: true });
    const repliesDir = workerRepliesDir(run.root, TRIAGE_COLLATOR);
    await createRepliesDir(repliesDir);
    // ISC-1091: a regular FILE holding the empty declaration, never an absence.
    await writeRepliesPolicy(paths.repliesPolicy, null, []);
    return { repliesDir, policyFile: paths.repliesPolicy };
  }

  /** One observer artifact, as a seat would have left it. */
  async function seedArtifact(
    run: RunPaths,
    sweepId: string,
    seat: { worker: string; aspect: string },
  ): Promise<string> {
    const child = childTaskId(sweepId, seat.aspect);
    const dir = join(workerOutboxDir(run.root, seat.worker), child, SWEEP_FILES_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, OBSERVER_ARTIFACT_FILE),
      JSON.stringify({
        sweep_id: sweepId,
        window_opened_at: "2026-09-06T12:00:00.000Z",
        status: "success",
        services: [{ service: "alert-notifier", assessment: "healthy" }],
      }),
      "utf8",
    );
    return child;
  }

  /** The set on disk, as child task ids — `replies.ts`'s `.json` suffix removed. */
  async function publishedSet(repliesDir: string): Promise<string[]> {
    return (await readdir(repliesDir)).map((f) => f.replace(/\.json$/, "")).sort();
  }

  /** The set the tool will read, as child task ids. */
  async function declaredSet(policyFile: string): Promise<string[]> {
    const doc = JSON.parse(await readFile(policyFile, "utf8")) as {
      replies: { task_id: string }[];
    };
    return doc.replies.map((r) => r.task_id).sort();
  }

  /** The producers, wired to the PRODUCTION publish-and-declare act. */
  function realProducers(run: RunPaths): ReturnType<typeof sweepProducers> {
    return sweepProducers({
      run,
      environment: "cni-dev",
      services: SERVICES,
      defaultWindowS: 300,
      previousDocument: async () => null,
      dispatch: async () => ({ kind: "accepted" }),
      publishReplies: async (taskId, replies) => {
        await consoleTransport(TRIAGE_COLLATOR, productionRelayEffects, {
          deadlineMs: 0,
        }).publishReplies(run, taskId, replies);
      },
    });
  }

  test("one sweep: the directory and the declaration hold the same set", async () => {
    const run = await seedRun("2026-09-06T00-00-31Z-0031");
    const { repliesDir, policyFile } = await establishCollator(run);
    const sweepId = sweepTaskId(41);
    const child = await seedArtifact(run, sweepId, TRIAGE_CONSOLE_ASPECTS[0]!);

    await realProducers(run).join(sweepId);

    const published = await publishedSet(repliesDir);
    const declared = await declaredSet(policyFile);
    // THE CRITERION: two artefacts, read back, one set.
    expect(declared).toEqual(published);
    // PREMISE — a vacuous pair of empty sets would satisfy the line above.
    expect(published).toEqual([child]);
  });

  /**
   * THE DECLARATION IS ABOUT THE COLLATION, and asserted by value.
   *
   * Failure mode 9.6's mitigation has two halves: publish and declare in one
   * act, AND *"the file carries its own `task_id` and the tool refuses a
   * mismatch against `/policy/task`"*. A declaration under the SWEEP id would be
   * a perfectly fresh set that `get_replies` refuses on every honest path, which
   * is the most expensive way a freshness check can be wrong.
   */
  test("the declaration names the COLLATION task", async () => {
    const run = await seedRun("2026-09-06T00-00-32Z-0032");
    const { policyFile } = await establishCollator(run);
    const sweepId = sweepTaskId(41);
    await seedArtifact(run, sweepId, TRIAGE_CONSOLE_ASPECTS[0]!);

    await realProducers(run).join(sweepId);

    const doc = JSON.parse(await readFile(policyFile, "utf8")) as { task_id: string };
    expect(doc.task_id).toBe(collationTaskId(sweepId));
  });

  test("two sweeps: the directory accumulates and the declaration does NOT", async () => {
    const run = await seedRun("2026-09-06T00-00-33Z-0033");
    const { repliesDir, policyFile } = await establishCollator(run);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;

    const first = sweepTaskId(41);
    const firstChild = await seedArtifact(run, first, seat);
    await realProducers(run).join(first);

    const second = sweepTaskId(42);
    const secondChild = await seedArtifact(run, second, seat);
    await realProducers(run).join(second);

    /*
     * FINDING E, made executable. The directory now holds BOTH sweeps, so a
     * `get_replies` that listed it would hand sweep 42's collator sweep 41's
     * question as well — and sweep 41's answer reads like a perfectly good one.
     */
    expect(await publishedSet(repliesDir)).toEqual([firstChild, secondChild].sort());
    // The declaration is THIS sweep's set and only this sweep's.
    expect(await declaredSet(policyFile)).toEqual([secondChild]);
  });

  /**
   * THE EMPTY SET IS DECLARED, not skipped — §7.4's *"an EMPTY array is a value,
   * not an absence"*, asserted on the artefact rather than on a call.
   *
   * Sequenced after a sweep that published something, because that is the state
   * where skipping the call is invisible: the previous declaration is left
   * standing and every observable on the host says the join worked.
   */
  test("a sweep that observed nothing declares the empty set over the previous one", async () => {
    const run = await seedRun("2026-09-06T00-00-34Z-0034");
    const { repliesDir, policyFile } = await establishCollator(run);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;

    const first = sweepTaskId(41);
    const firstChild = await seedArtifact(run, first, seat);
    await realProducers(run).join(first);
    expect(await declaredSet(policyFile)).toEqual([firstChild]);

    // Sweep 42: nobody wrote an artifact.
    await realProducers(run).join(sweepTaskId(42));

    expect(await declaredSet(policyFile)).toEqual([]);
    // And the previous sweep's FILE is still there — declaring is not deleting.
    expect(await publishedSet(repliesDir)).toEqual([firstChild]);
  });

  /**
   * THE TWO PORT SHAPES CANNOT DRIFT.
   *
   * `SweepProducerDeps.publishReplies` spells its element type inline because
   * §12's read-only block bans this console's modules from importing
   * `run/relay.ts`, where {@link PublishedReply} lives. The bridge between them
   * is structural and is made at `cli/index.ts`, a file no unit test drives —
   * so the compatibility is pinned HERE, in a file that may import both, which
   * is the treatment {@link SWEEP_FILES_DIR} already gets for the same reason.
   *
   * Assignability in BOTH directions, because one direction only proves the
   * relay's type is a subtype: a `PublishedReply` that grew a required field
   * would still satisfy the triage port and would silently make the bridge
   * impossible to write.
   *
   * **ITS PROBE IS `bun run typecheck`, NOT `bun test`, and the difference was
   * measured rather than assumed.** Adding a required `lens: string` to
   * `PublishedReply` leaves this file reporting **62 pass / 0 fail** — Bun
   * strips types before it runs anything — while `tsc --noEmit` reddens in eight
   * places, `src/cli/index.ts:415` (the real bridge) and this file's own
   * `realProducers` wiring among them. The `expect` below is there so the case
   * appears in a run at all; the assertion is the two annotated assignments
   * above it.
   */
  test("the triage port and relay's PublishedReply are the same shape, both ways", () => {
    const fromRelay: PublishedReply = {
      task_id: "T-sweep-41-slice1",
      worker: "obs-t1",
      aspect: "slice1",
      reply: { status: "success" },
    };
    type PortEntry = Parameters<PublishRepliesPort>[1][number];
    const asPort: PortEntry = fromRelay;
    const backAgain: PublishedReply = asPort;
    expect(backAgain).toEqual(fromRelay);
  });
});

// ---------------------------------------------------------------------------
// ISC-1119 / ISC-1120 — the envelope carries what the role file demands back
// ---------------------------------------------------------------------------

/**
 * **The collator can only compose from its envelope, so an envelope that omits a
 * value is an envelope that forbids compliance.**
 *
 * Both host repairs of the time — the freshness echo and
 * `normalizeSliceReportingPath` — fired on every sweep this console has ever run
 * (22 and 30 times in `~/.pifleet/triage-relay.log`), and both logged the
 * collator as the faulting party. Measured against `T-sweep-13`'s live request
 * rather than against those log lines, the collator was obeying both sentences
 * exactly: *"Echo sweep id T-sweep-13 and window … in `observer-ops.json`"* and
 * *"into `/outbox/T-sweep-13/files/` using the observer's own task id"*. What it
 * lacked was the two SPELLINGS the host greps for, and a slice id that is
 * `childTaskId` over a host constant it has never been shown.
 *
 * These tests pin the envelope as SUFFICIENT — the property that was missing.
 *
 * **ISC-1136 narrowed what "sufficient" has to mean, and did not retire it.** The
 * host now AUTHORS the observer's reporting contract, so the envelope no longer
 * has to make the collator capable of relaying it. Two things still travel only
 * through this document and are still asserted below: the seat ids, which
 * `composeObserverBrief` can repair but cannot invent, and the window instant,
 * which it reads back out of the collator's own text and cannot mint.
 */
describe("the sweep envelope carries what the collator is asked to emit", () => {
  test("it names both freshness field names in their exact spellings (ISC-1119)", () => {
    const { brief } = renderSweepEnvelope(envelopeInput());
    expect(brief).toContain("`sweep_id`");
    expect(brief).toContain("`window_opened_at`");
  });

  test("it names each seat's dispatch id and reporting path (ISC-1120)", () => {
    const sweepId = sweepTaskId(41);
    const { brief } = renderSweepEnvelope(envelopeInput({ sweepId }));
    for (const seat of TRIAGE_CONSOLE_ASPECTS) {
      const child = childTaskId(sweepId, seat.aspect);
      expect(brief).toContain(seat.worker);
      expect(brief).toContain(child);
      expect(brief).toContain(`/outbox/${child}/files/`);
    }
  });

  /**
   * The id the collator holds is the one that is always wrong, so the envelope
   * has to say so in the same breath as it hands over the right one — otherwise
   * the nearest value in context wins, which is exactly what `T-sweep-13` did.
   */
  test("it says the collator's own id is not the reporting id", () => {
    const sweepId = sweepTaskId(41);
    const { brief } = renderSweepEnvelope(envelopeInput({ sweepId }));
    expect(brief).toContain("Never your own task id");
    expect(brief).toContain(sweepId);
  });

  /**
   * **The acceptance, and the only test here that could not have been written
   * before the fix.** A brief copied from the envelope must need NO repair — which
   * after ISC-1136 means exactly one repair, `normalizeSliceReportingPath`, because
   * the other three stopped being conditional and became authored text.
   *
   * The judgement must also survive into the composed brief unaltered. A composer
   * that rewrote the collator's words would satisfy every contract assertion in
   * this file while discarding the sweep's actual content.
   */
  test("a brief copied from the envelope is carried verbatim, repairing nothing", () => {
    const sweepId = sweepTaskId(41);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    const child = childTaskId(sweepId, seat.aspect);
    const window = "2026-09-06T12:00:00.000Z";
    const judgement =
      `Sweep ${sweepId}. Observation window opens ${window}. Check \`grafana\`. ` +
      `Write both files into /outbox/${child}/files/.`;

    const composed = composeObserverBrief({ judgement, sweepId, childTaskId: child });
    expect(composed.rewrote).toEqual([]);
    expect(composed.window).toBe(window);
    expect(composed.brief.startsWith(judgement)).toBe(true);
  });

  /**
   * The seats are a parameter so this can render a console that does not exist,
   * proving the block is derived from the roster rather than from `slice1` being
   * hard-coded somewhere in the prose.
   */
  test("the seat block follows the roster it is given, not a constant", () => {
    const sweepId = sweepTaskId(41);
    const { brief } = renderSweepEnvelope(
      envelopeInput({
        sweepId,
        seats: [
          { worker: "obs-t1", aspect: "slice1" },
          { worker: "obs-t2", aspect: "slice2" },
        ],
      }),
    );
    expect(brief).toContain(`/outbox/${sweepId}-slice2/files/`);
    expect(brief).toContain("obs-t2");
  });
});

/**
 * ISC-1131 — the third repair, and the sweep that earned it.
 *
 * `T-sweep-22`, 2026-09-09: the observer wrote `"result": "healthy"` into every
 * `coverage` entry, the collation was refused whole on six copies of one schema
 * error, and all three services were recorded unobserved. The brief it had named
 * `assessment` and its four values and named `coverage[].result` with none, so a
 * model holding one enum completed the only pattern in front of it.
 *
 * The intermittency is what makes this the host's problem: sweeps 19 and 21
 * produced `answered` from this same code and the same envelope. There is no
 * wording left to sharpen — see `ensureCoverageVocabulary`.
 */
describe("COVERAGE_VOCABULARY_DEMAND (ISC-1131, authored under ISC-1136)", () => {
  test("names every member of the closed domain", () => {
    for (const v of COVERAGE_RESULTS) expect(COVERAGE_VOCABULARY_DEMAND).toContain(`"${v}"`);
  });

  test("says what the field means, because the wrong answer was a plausible one", () => {
    // `healthy` is not a typo — it is the neighbouring enum. A demand that only
    // listed values would leave the same confusion one step further on.
    expect(COVERAGE_VOCABULARY_DEMAND).toContain("whether the CHANNEL ANSWERED YOU");
    expect(COVERAGE_VOCABULARY_DEMAND).toContain('"healthy" is not a coverage result');
  });

  /**
   * The vocabulary is IMPORTED, not restated — so this test is what makes that
   * claim falsifiable rather than a comment. Add a fifth member to
   * `COVERAGE_RESULTS` and the demand must grow it with no edit here; a
   * hand-written copy of the list would fail.
   */
  test("every member of COVERAGE_RESULTS reaches the demand, by construction", () => {
    for (const v of COVERAGE_RESULTS) expect(COVERAGE_VOCABULARY_DEMAND).toContain(`"${v}"`);
    // And nothing from the neighbouring enum leaks in, which is the confusion
    // this whole demand exists to end.
    for (const a of OBSERVER_ASSESSMENTS) {
      if ((COVERAGE_RESULTS as readonly string[]).includes(a)) continue;
      expect(COVERAGE_VOCABULARY_DEMAND).not.toContain(`"${a}" is a coverage result`);
    }
  });

  /**
   * **THE ENUM IS NOT SPELLED TWICE IN THIS MODULE, and after ISC-1136 that is a
   * property of the whole file rather than of one repair.**
   *
   * `renderSweepEnvelope` used to carry its own hand-typed
   * `answered/unreachable/forbidden/not_attempted` in the collator's brief — the
   * second copy of an enum whose second copy in an ARTIFACT was the bug
   * (`ISC-869`: *"an assertion that two copies agree is a third copy"*). The host
   * now appends the domain to every dispatched brief, so the envelope states it
   * nowhere and the module has exactly one spelling: the import.
   *
   * This asserts the absence rather than restating the members, because a test
   * that re-typed them would be the third copy it is checking for.
   *
   * **`not_attempted` survives on purpose and the assertion is exact rather than
   * empty.** The envelope still tells the collator that a `healthy` whose every
   * channel is `not_attempted` is downgraded — that is a GATE the collator must
   * understand to avoid upgrading such a row, and naming one member inside a rule
   * about that member is not a restatement of the domain. Pinning the set to
   * exactly that one member is what makes a re-added vocabulary red; a
   * `toEqual([])` would have had to launder the gate away to pass.
   */
  test("the collator's own envelope no longer restates the domain", () => {
    const { brief } = renderSweepEnvelope(envelopeInput());
    const spelled = COVERAGE_RESULTS.filter((r) => brief.includes(r));
    expect(
      spelled,
      "renderSweepEnvelope names COVERAGE_RESULTS members beyond the one its downgrade gate " +
        "is about; the host appends the domain to every dispatched brief now, so a vocabulary " +
        "here is a second spelling of the enum the observer is graded against",
    ).toEqual(["not_attempted"]);
  });
});

/**
 * The composer at its REAL call site (ISC-1131, ISC-1134, recomposed by ISC-1136).
 *
 * ## Why this test exists, and what was missing before it
 *
 * The four repairs this replaced each had a thorough block of unit tests, and
 * every one of them called the function directly. **Not one of them proved that
 * `dispatchObserver` called it.** Checked while adding the third: the only test
 * that drove `dispatchObserver` was the refusal path, which dispatches nothing —
 * so all three call sites were uncovered, and deleting any one line from the
 * dispatch path left this whole file green.
 *
 * That is the failure `ISC-1104` names, and it is the reason a change to the
 * DIVISION OF LABOUR — which is what ISC-1136 is — must be probed here rather than
 * at `composeObserverBrief`'s own signature. A composer with five green tests and
 * no caller is this repo's recorded failure mode, not a hypothetical one. The
 * probe is the brief the port ACTUALLY RECEIVES: it cannot pass unless the
 * composer ran on the real path.
 *
 * ## The fixture is deliberately broken in all four ways at once
 *
 * A collator judgement that names the wrong outbox id, omits the freshness
 * fields, omits the coverage domain AND bounds nothing — not a contrived
 * combination but the union of four separately measured sweeps, and the exact
 * shape the collator produced on sweeps 26 through 29. After ISC-1136 three of
 * those four are no longer even possible to get wrong: the host writes them. The
 * fixture keeps them because the assertion is about what the OBSERVER receives,
 * and that is unchanged by whose job it became.
 */
describe("dispatchObserver dispatches the COMPOSED brief (ISC-1131, ISC-1134, ISC-1136)", () => {
  test("the brief the dispatch port receives is the composed one, not the one the collator wrote", async () => {
    const run = await seedRun("2026-09-09T00-00-31Z-1131");
    const sweepId = sweepTaskId(22);
    const seat = TRIAGE_CONSOLE_ASPECTS[0]!;
    const childId = `${sweepId}-${seat.aspect}`;

    // The collator's fan-out request, broken in all three ways.
    const dir = join(workerOutboxDir(run.root, TRIAGE_COLLATOR), sweepId);
    await mkdir(dir, { recursive: true });
    const collatorBrief =
      `Sweep ${sweepId}. Observation window opens 2026-09-09T14:34:38.315Z. Check ` +
      "`grafana` in namespace `aodapnc-grafana-dev` (checks: [rollout, logs], window: 300s). " +
      `Report an assessment of healthy, degraded, unhealthy or indeterminate. Write both files ` +
      `into /outbox/${sweepId}/files/.`;
    await writeFile(
      join(dir, DISPATCH_REQUEST_FILE),
      JSON.stringify({
        schema: "pifleet.dispatchrequest/v1",
        parent_task_id: sweepId,
        requests: [
          {
            worker: seat.worker,
            title: "Health sweep",
            brief: collatorBrief,
            // §7.3 requires it: the host validates the partition against the
            // targets file before dispatching, and this is the only
            // machine-readable statement of what a request covers.
            services: ["grafana"],
          },
        ],
      }),
      "utf8",
    );

    const { sent, producers } = producerFixture(run);
    await producers.dispatchObserver(sweepId, {
      worker: seat.worker,
      services: ["grafana"],
    });

    expect(sent, "dispatchObserver sent nothing").toHaveLength(1);
    const brief = sent[0]!.brief;

    // Repaired — the reporting path is the child's, not the sweep's. This is the
    // one contribution of the collator's that is WRONG rather than absent, and
    // the only one `composeObserverBrief` still corrects rather than authors.
    expect(
      brief,
      "normalizeSliceReportingPath did not run on the dispatch path (ISC-1120)",
    ).toContain(`/outbox/${childId}/files/`);
    expect(brief).not.toContain(`/outbox/${sweepId}/files/`);

    // Authored — the freshness fields, by their exact spellings.
    expect(brief, "the freshness demand did not reach the observer (ISC-1119)").toContain(
      "sweep_id",
    );
    expect(brief).toContain("window_opened_at");

    // Authored — the coverage domain, every member of it.
    for (const v of COVERAGE_RESULTS) {
      expect(
        brief,
        `the coverage domain did not reach the dispatch path — "${v}" never reached ` +
          `the observer, which is how T-sweep-22 lost all three services (ISC-1131)`,
      ).toContain(`"${v}"`);
    }

    // Authored — the cluster calls are bounded, in the spelling verbgate accepts.
    expect(
      brief,
      "the call bound did not reach the dispatch path — an unreachable cluster " +
        "costs the whole 480s deadline and produces no artifact (ISC-1134)",
    ).toContain(`--request-timeout=${CLUSTER_CALL_TIMEOUT_S}s`);

    // And the collator's own words survive: a composer that REPLACED the brief
    // would satisfy every assertion above while discarding the sweep's content.
    expect(brief).toContain("aodapnc-grafana-dev");
    expect(brief.startsWith(`Sweep ${sweepId}.`)).toBe(true);

    /*
     * **THE WIRING ASSERTION, and it is deliberately an equality.**
     *
     * Every assertion above is satisfied by ANY code path that produces those
     * strings — including four inline repairs at the call site, which is what was
     * there before. This one is not: it says the port received exactly what
     * `composeObserverBrief` returns for this judgement, so the composer is the
     * thing on the dispatch path rather than a well-tested module beside it. Swap
     * `composed.brief` for `item.brief` at the call site, or reinstate the
     * repairs inline, and this reddens.
     */
    expect(
      brief,
      "the dispatch port did not receive composeObserverBrief's output — the composer is " +
        "not on the dispatch path (ISC-1104's shape: five green tests, no caller)",
    ).toBe(
      composeObserverBrief({ judgement: collatorBrief, sweepId, childTaskId: childId }).brief,
    );

    // The seam between the collator's words and the host's is marked, so an
    // observer can tell which half it may not argue with.
    expect(brief).toContain(OBSERVER_CONTRACT_HEADING);
    expect(brief.indexOf(OBSERVER_CONTRACT_HEADING)).toBeGreaterThan(
      brief.indexOf("aodapnc-grafana-dev"),
    );
  });
});

/**
 * `composeObserverBrief` on its own — the division ISC-1136 makes.
 *
 * These call the composer directly and therefore cannot prove it is WIRED; the
 * describe above is what does that. What they pin is the division itself, which
 * the wiring test cannot state: which half of the brief the host owns, which half
 * the collator owns, and what happens to each when the other is missing.
 */
describe("composeObserverBrief: the host authors, the collator judges (ISC-1136)", () => {
  const SWEEP = "T-sweep-31";
  const CHILD = "T-sweep-31-slice1";
  const WINDOW = "2026-09-09T14:34:38.315Z";

  /**
   * **THE POINT OF THE WHOLE CHANGE.** The collator contributes a judgement and
   * nothing else — no field spellings, no domain, no bound — and the observer
   * still receives the complete contract. Before ISC-1136 this input produced a
   * brief with three sentences missing and three warnings in the log.
   */
  test("a judgement carrying NONE of the contract still produces the whole contract", () => {
    const { brief } = composeObserverBrief({
      judgement: `Sweep ${SWEEP}. Window opens ${WINDOW}. Look at grafana.`,
      sweepId: SWEEP,
      childTaskId: CHILD,
    });
    expect(brief).toContain(freshnessEchoDemand(SWEEP, WINDOW));
    expect(brief).toContain(COVERAGE_VOCABULARY_DEMAND);
    expect(brief).toContain(BOUNDED_CALLS_DEMAND);
  });

  /**
   * **THE ASYMMETRIC CASE, and it is what separates authoring from repairing.**
   *
   * A judgement that ALREADY names part of the contract used to make the repairs
   * stand down — `ensureCoverageVocabulary` returned early on a brief containing
   * all four members, `ensureBoundedCalls` on any `--request-timeout`. An author
   * has no such branch: the host's sentence is present whatever the collator
   * wrote, so a collator that half-remembered the domain can no longer suppress
   * the closed statement of it.
   */
  test("a judgement that already states part of the contract does NOT suppress the host's", () => {
    const { brief } = composeObserverBrief({
      judgement:
        `Sweep ${SWEEP}. Window opens ${WINDOW}. Use answered when a channel replies, and ` +
        `pass --request-timeout=5s on everything.`,
      sweepId: SWEEP,
      childTaskId: CHILD,
    });
    expect(brief).toContain(COVERAGE_VOCABULARY_DEMAND);
    expect(brief).toContain(BOUNDED_CALLS_DEMAND);
    // The collator's weaker bound survives above the host's — it is judgement,
    // and the heading says which of the two the observer must obey.
    expect(brief).toContain("--request-timeout=5s");
    expect(brief.indexOf("--request-timeout=5s")).toBeLessThan(
      brief.indexOf(OBSERVER_CONTRACT_HEADING),
    );
  });

  /** Judgement first, contract second — the old call site's own argument, kept. */
  test("the collator's judgement leads and the host's block follows it", () => {
    const judgement = `Sweep ${SWEEP}. Window opens ${WINDOW}. Look at grafana.`;
    const { brief } = composeObserverBrief({ judgement, sweepId: SWEEP, childTaskId: CHILD });
    expect(brief.startsWith(judgement)).toBe(true);
    expect(brief.indexOf(OBSERVER_CONTRACT_HEADING)).toBeGreaterThan(0);
  });

  /**
   * The WRONGNESS repair, which authoring cannot replace: writing the correct
   * path does not delete an incorrect one already in the collator's prose, and an
   * observer handed both has to choose. `T-sweep-1` is the record of which.
   */
  test("a wrong outbox id is rewritten and reported, not merely out-written", () => {
    const r = composeObserverBrief({
      judgement: `Sweep ${SWEEP}. Write both files into /outbox/${SWEEP}/files/.`,
      sweepId: SWEEP,
      childTaskId: CHILD,
    });
    expect(r.rewrote).toEqual([SWEEP]);
    expect(r.brief).toContain(`/outbox/${CHILD}/files/`);
    expect(r.brief).not.toContain(`/outbox/${SWEEP}/files/`);
  });

  /**
   * The window instant is the ONE part of the contract the host cannot mint —
   * `dispatchObserver` does not hold `dispatched_at`. A judgement that drops it
   * degrades the demand rather than inventing a second spelling of the quantity
   * §7.4's freshness check compares against.
   */
  test("a judgement naming no instant degrades the demand instead of inventing one", () => {
    const r = composeObserverBrief({
      judgement: `Sweep ${SWEEP}. Look at grafana.`,
      sweepId: SWEEP,
      childTaskId: CHILD,
    });
    expect(r.window).toBeNull();
    expect(r.brief).toContain('`sweep_id` exactly "T-sweep-31"');
    expect(r.brief).not.toMatch(/window_opened_at` exactly "/);
  });
});

/**
 * ISC-1134 — bounding the observer's cluster calls.
 *
 * Measured 2026-09-09 with `utun9` carrying zero routes: each `kubectl` spent
 * ~3 minutes retrying an unreachable API server before failing on a client-side
 * rate limiter, and two consecutive sweeps hit the 480 s child deadline with no
 * artifact. `unreachable` has always been in `COVERAGE_RESULTS`; nothing told the
 * observer how to REACH it, because an unbounded call does not fail, it hangs.
 */
describe("BOUNDED_CALLS_DEMAND (ISC-1134, authored under ISC-1136)", () => {
  test("states the bound, at the constant's value", () => {
    expect(BOUNDED_CALLS_DEMAND).toContain(`--request-timeout=${CLUSTER_CALL_TIMEOUT_S}s`);
  });

  /**
   * THE SPELLING TEST, and it is the reason this repair is not one line.
   *
   * `kubectl --request-timeout=30s get ns` is refused by the container's
   * verbgate as `kubectl (flags-before-verb) not authorized`; the same flag
   * AFTER the verb runs. Both were tried against the live worker. An instruction
   * the sandbox refuses is worse than none — it spends the model's turn on a
   * call that cannot run — so the brief must show the legal form and say which
   * it is.
   */
  test("shows the flag AFTER the verb, which is the only form verbgate accepts", () => {
    // The worked example must be legal…
    expect(BOUNDED_CALLS_DEMAND).toContain(
      `kubectl get pods -n <ns> --request-timeout=${CLUSTER_CALL_TIMEOUT_S}s`,
    );
    // …and must never demonstrate the refused form.
    expect(BOUNDED_CALLS_DEMAND).not.toContain(`kubectl --request-timeout=${CLUSTER_CALL_TIMEOUT_S}s`);
    expect(BOUNDED_CALLS_DEMAND).toContain("AFTER the verb");
  });

  test("ties a timed-out call to the coverage result it must produce", () => {
    // A bound that does not say what to REPORT leaves the observer with a failed
    // command and no vocabulary for it — which is the ISC-1131 shape again.
    expect(BOUNDED_CALLS_DEMAND).toContain('"unreachable"');
    expect(BOUNDED_CALLS_DEMAND).toContain("Do not retry it");
  });

  /**
   * The bound is derived from the deadline it protects. Ten-ish calls at the
   * timeout must leave the seat room to write the artifact inside the child
   * deadline — a bound that consumes the deadline reinstates the exact failure.
   *
   * **600 s as of 2026-09-13, raised from 480 by a measured failure.** On
   * T-sweep-116 — the last sweep of the two-pair arrangement — an observer
   * holding four services spent its entire 480 s deadline mid-`kubectl logs` and
   * wrote no artifact, so every service it held came back `unobserved`. The
   * deadline is not set directly: it falls out of `cadence_s - reserve_s - 300`,
   * so `triage/console.yaml`'s cadence moving to 1020 is what moved this. The
   * 300 is `RELAY_CHILD_DEADLINE_MARGIN_MS`, shared with the review console and
   * pinned there — which is why the cadence, and not the margin, is the knob.
   */
  test("the timeout leaves an unreachable sweep time to report", () => {
    const CHILD_DEADLINE_S = 600;
    const CALLS_PER_SWEEP = 10;
    expect(CLUSTER_CALL_TIMEOUT_S * CALLS_PER_SWEEP).toBeLessThan(CHILD_DEADLINE_S);
    // And not so tight it refuses a slow-but-working API.
    expect(CLUSTER_CALL_TIMEOUT_S).toBeGreaterThanOrEqual(20);
  });
});
