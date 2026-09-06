/**
 * `triage.json`'s schema — SRD-TRIAGE-CONSOLE §7.5; §13 task 5.5a.
 *
 * ## What this file is grading, and the one trap it is arranged against
 *
 * §13 task 5.5a: *"a document with a row missing `assessment`, one with an unknown
 * assessment value, and one that is not an object each refuse by name rather than
 * reaching `assessTriageSweep`"*.
 *
 * **A refusal test is the easiest place on this branch to write a degenerate
 * fixture**, and the shape it takes here is a document that is bad in several
 * ways at once: drop `assessment` from a row that also has no `schema` tag and a
 * traversal in its service name, and all three refusals "fire" while none of them
 * is the reason. The repair is the one MEMORY records — **assert the premise, one
 * step earlier, in an assertion rather than in a comment.** So every bad fixture
 * below is built by taking {@link goodDocument} and changing EXACTLY ONE thing,
 * and {@link refusalFor} re-asserts that the unmutated document parses `ok`
 * before it grades the mutant. A comment claiming the base is clean cannot go
 * red; that assertion can.
 *
 * **And the twin failure a refusal suite invites: a parser that refuses
 * EVERYTHING passes every criterion above.** `describe("a document the host can
 * act on")` is the positive control, and it drives the parsed value all the way
 * into `assessTriageSweep` — because "does not reach `assessTriageSweep`" is only
 * a claim worth making if the good document does.
 *
 * ## Nothing here reads a clock, a cluster or `~/.pifleet`
 *
 * Phase 5 *"touches no container and no network"*. Every fixture is a string
 * literal built in this file. The one file read is `roles/triage.md` out of the
 * working tree, which is `triage-role.test.ts`'s posture and ISC-600's reason:
 * `roles/` is read by a container and never by `tsc`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TRIAGE_DOCUMENT_FAULTS,
  TRIAGE_DOCUMENT_HISTORY,
  TRIAGE_DOCUMENT_SCHEMA,
  parseTriageDocument,
  type TriageDocumentContext,
  type TriageDocumentRead,
} from "../../src/run/triage-document.ts";
import {
  COVERAGE_RESULTS,
  OBSERVER_ASSESSMENTS,
  assessTriageSweep,
  evidenceGaps,
  type SweepCoverage,
} from "../../src/run/triage-verdict.ts";
import { MAX_SERVICES_PER_ENVIRONMENT } from "../../src/run/triage-targets.ts";

/** The host's own knowledge of the file: the seat, from the outbox path it sat in. */
const CTX: TriageDocumentContext = {
  worker: "tri-1",
  path: "/run/outbox/tri-1/T-sweep-41-collate/files/triage.json",
};

type Json = Record<string, unknown>;

/** One well-formed row. Every bad fixture below is this with ONE field changed. */
function goodRow(over: Json = {}): Json {
  return {
    service: "authorization",
    assessment: "unhealthy",
    coverage: [
      { channel: "rollout", result: "answered" },
      { channel: "logs", result: "answered" },
    ],
    selector: "app=authorization",
    window: "5m",
    evidence_ref: ["obs-t2:observer-ops.json#services[0]"],
    observer: "obs-t2",
    ...over,
  };
}

/** One well-formed document. */
function goodDocument(over: Json = {}): Json {
  return {
    schema: TRIAGE_DOCUMENT_SCHEMA,
    sweep_id: "T-sweep-41",
    services: [goodRow()],
    unaccounted: [],
    ...over,
  };
}

const read = (doc: unknown): TriageDocumentRead =>
  parseTriageDocument(JSON.stringify(doc), CTX);

/** A row with one key REMOVED, which is a different fault from one set wrong. */
function rowWithout(key: string): Json {
  const row = goodRow();
  delete row[key];
  return row;
}

/**
 * Grade one mutant, having first proved the thing it was mutated FROM is clean.
 *
 * This is the premise assertion. Without it a bad fixture can refuse for a reason
 * the test never names — and every assertion below would still be green, because
 * "it refused" is true either way.
 */
function refusalFor(mutant: Json): Extract<TriageDocumentRead, { kind: "refused" }> {
  const base = read(goodDocument());
  expect(base.kind).toBe("ok");

  const got = read(mutant);
  if (got.kind !== "refused") throw new Error(`expected a refusal, got ${got.kind}`);
  return got;
}

describe("§13 task 5.5a's three acceptance cases, each refused by NAME", () => {
  /**
   * Case one. The row simply has no `assessment`, and nothing else about the
   * document is wrong — which is what makes the path in the refusal mean
   * something.
   */
  test("a row missing assessment refuses at services.0.assessment as missing", () => {
    const refused = refusalFor(goodDocument({ services: [rowWithout("assessment")] }));

    expect(refused.code).toBe("schema");
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0]!.path).toBe("services.0.assessment");
    expect(refused.issues[0]!.fault).toBe("missing");
    // The operator is sent to a FILE, not to a sweep.
    expect(refused.reason).toContain(CTX.path);
    /*
     * And NOT told to check the spelling of a field that is not there. Zod's own
     * sentence for a missing enum key is "Invalid option: expected one of …",
     * which is the misdiagnosis this module rewrites; asserting its absence is
     * what stops the rewrite being dropped as cosmetic.
     */
    expect(refused.issues[0]!.message).not.toContain("Invalid option");
  });

  /**
   * Case two, and it lands on the SAME PATH as case one AND — measured — on the
   * same zod issue code and the same zod message. Zod 4.1 answers a missing
   * `z.enum` key and an unknown `z.enum` value identically, so nothing the
   * validator produces on its own separates 5.5a's first two cases.
   * {@link TriageDocumentFault} is the separation, and this is the test that
   * holds it.
   */
  test("an unknown assessment value refuses at the same path as invalid", () => {
    const refused = refusalFor(
      goodDocument({ services: [goodRow({ assessment: "mostly-fine" })] }),
    );

    expect(refused.code).toBe("schema");
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0]!.path).toBe("services.0.assessment");
    expect(refused.issues[0]!.fault).toBe("invalid");
  });

  /**
   * The two above are DISTINGUISHABLE, asserted directly rather than left to be
   * inferred from two separate tests passing.
   *
   * **This assertion is the one that would have caught the defect this module
   * shipped with for an hour**, and it is worth stating why it is not redundant
   * with the two tests above: those two pin the fault each fixture produces, and
   * both would still pass if a future edit made `missing` and `invalid` the same
   * token. This one fails on that edit, and it is the only one that does.
   */
  test("absent and not-a-member are two different faults, not one", () => {
    const absent = refusalFor(goodDocument({ services: [rowWithout("assessment")] }));
    const wrong = refusalFor(goodDocument({ services: [goodRow({ assessment: "mostly-fine" })] }));

    // The PREMISE: the two are on one path, so the fault is doing all the work.
    // If they ever land on different paths this test stops meaning what it says.
    expect(absent.issues[0]!.path).toBe(wrong.issues[0]!.path);
    expect(absent.issues[0]!.fault).not.toBe(wrong.issues[0]!.fault);
  });

  /**
   * `null` is not absence, and JSON is why this distinction is decidable at all.
   * A key written as `null` is a key the worker WROTE, wrongly — a different thing
   * to go and fix from a key it never wrote, and the only reason `classifyFault`
   * can tell them apart is that `JSON.parse` cannot produce `undefined`.
   */
  test("assessment: null is invalid, not missing", () => {
    const refused = refusalFor(goodDocument({ services: [goodRow({ assessment: null })] }));
    expect(refused.issues[0]!.path).toBe("services.0.assessment");
    expect(refused.issues[0]!.fault).toBe("invalid");
  });

  /** The fault vocabulary is closed, asserted by name and not by count. */
  test("the fault set is exactly the three §7.5 refusals need", () => {
    expect([...TRIAGE_DOCUMENT_FAULTS]).toEqual(["missing", "invalid", "unrecognized"]);
  });

  /**
   * Case three. Four shapes, because a turn that goes wrong produces all four and
   * `typeof null === "object"` while an array is an object — so a check spelled
   * as `typeof raw !== "object"` alone lets two of these through to zod and a
   * check spelled `!raw` lets `[]` through.
   */
  test.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"everything is fine"'],
    ["a number", "42"],
  ])("a document that is %s refuses as not_an_object", (_label, text) => {
    expect(read(goodDocument()).kind).toBe("ok");

    const got = parseTriageDocument(text, CTX);
    if (got.kind !== "refused") throw new Error(`expected a refusal, got ${got.kind}`);
    expect(got.code).toBe("not_an_object");
    expect(got.code).not.toBe("schema");
  });

  /** Bytes that are not JSON at all are their own code, and never the object one. */
  test("bytes that are not JSON refuse as not_json", () => {
    const got = parseTriageDocument("{ services: [", CTX);
    if (got.kind !== "refused") throw new Error(`expected a refusal, got ${got.kind}`);
    expect(got.code).toBe("not_json");
  });

  /**
   * **"rather than reaching `assessTriageSweep`"**, made executable rather than
   * left to the type union.
   *
   * The refused arm carries no `document`, so the guarantee is structural — but a
   * structural guarantee is only worth asserting alongside its positive twin,
   * because a parser that refused every document would satisfy it perfectly.
   */
  test("no refused document reaches the verdict, and a good one does", () => {
    const bad = [
      goodDocument({ services: [rowWithout("assessment")] }),
      goodDocument({ services: [goodRow({ assessment: "mostly-fine" })] }),
    ];
    let assessed = 0;
    for (const doc of [...bad, goodDocument()]) {
      const got = read(doc);
      if (got.kind !== "ok") continue;
      assessed += 1;
      expect(assessTriageSweep("T-sweep-41", COVERAGE, got.document).services).toHaveLength(1);
    }
    // Exactly the good one got through. `0` would pass a "nothing bad reached it"
    // reading and is the failure this count exists to separate.
    expect(assessed).toBe(1);
  });
});

/** One environment, one service, one observer that replied — the ordinary sweep. */
const COVERAGE: SweepCoverage = {
  declared: ["authorization"],
  assignments: [{ worker: "obs-t2", services: ["authorization"] }],
  artifacts: [{ worker: "obs-t2", sweep_id: "T-sweep-41" }],
};

describe("a document the host can act on — the positive control", () => {
  test("the good document parses and its fields survive intact", () => {
    const got = read(goodDocument());
    if (got.kind !== "ok") throw new Error(got.reason);

    expect(got.document.sweep_id).toBe("T-sweep-41");
    expect(got.document.services).toHaveLength(1);
    expect(got.document.services[0]!.assessment).toBe("unhealthy");
    expect(got.document.services[0]!.coverage).toEqual([
      { channel: "rollout", result: "answered" },
      { channel: "logs", result: "answered" },
    ]);
    expect(got.document.services[0]!.evidence_ref).toEqual([
      "obs-t2:observer-ops.json#services[0]",
    ]);
  });

  /**
   * The parsed value is what `assessTriageSweep` takes, driven end to end. This is
   * the join §7.5's GAP note says has no validator in it, and the reason this
   * module exists at all.
   */
  test("it reaches assessTriageSweep and produces the observed verdict", () => {
    const got = read(goodDocument());
    if (got.kind !== "ok") throw new Error(got.reason);

    const assessment = assessTriageSweep("T-sweep-41", COVERAGE, got.document);
    expect(assessment.services[0]!.service).toBe("authorization");
    expect(assessment.services[0]!.assessment).toBe("unhealthy");
    expect(assessment.services[0]!.reason).toBe("observed");
  });
});

describe("the document may not say who wrote it", () => {
  /**
   * `dispatch-request.ts`'s rule, carried to the second worker-written document:
   * the host knows the seat from the outbox directory, and a document that could
   * name its own author could attribute a sweep to a seat that never ran one.
   */
  test("worker comes from the context and is refused in the document", () => {
    const got = read(goodDocument());
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(got.document.worker).toBe("tri-1");

    const refused = refusalFor(goodDocument({ worker: "obs-t2" }));
    expect(refused.code).toBe("schema");
    expect(refused.issues[0]!.path).toBe("worker");
    // Named rather than left to `.strict()`'s "unrecognized key" — the field
    // EXISTS on the value this parse produces, so a generic refusal would send
    // an operator looking for a typo.
    expect(refused.reason).toContain("outbox directory");
  });

  /** And the context is the only source, even when a document offers another. */
  test("a document naming a different seat cannot relabel the parse", () => {
    const other: TriageDocumentContext = { ...CTX, worker: "tri-2" };
    const got = parseTriageDocument(JSON.stringify(goodDocument()), other);
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(got.document.worker).toBe("tri-2");
  });
});

describe("the closed sets are DERIVED, so the schema and the contract cannot drift", () => {
  /**
   * Every member by name, on §12's rule for closed sets in this repository —
   * *"assert the enum's members by name … not by count"*. A `z.enum` built from
   * `OBSERVER_ASSESSMENTS` accepts exactly these and a fifth member added to the
   * constant is accepted here in the same commit or not at all.
   */
  test.each([...OBSERVER_ASSESSMENTS])("assessment %s is accepted", (assessment) => {
    const got = read(goodDocument({ services: [goodRow({ assessment })] }));
    expect(got.kind).toBe("ok");
  });

  test.each([...COVERAGE_RESULTS])("coverage result %s is accepted", (result) => {
    const got = read(
      goodDocument({ services: [goodRow({ coverage: [{ channel: "rollout", result }] })] }),
    );
    expect(got.kind).toBe("ok");
  });

  /** The other direction: the sets are CLOSED, not merely populated. */
  test("a coverage result outside COVERAGE_RESULTS refuses by path", () => {
    const refused = refusalFor(
      goodDocument({ services: [goodRow({ coverage: [{ channel: "rollout", result: "maybe" }] })] }),
    );
    expect(refused.issues[0]!.path).toBe("services.0.coverage.0.result");
    expect(refused.issues[0]!.fault).toBe("invalid");
  });

  /**
   * The tag is checked by name, so a document written against a future contract
   * is refused rather than read as this one.
   */
  test("a wrong or missing schema tag refuses at schema", () => {
    for (const doc of [goodDocument({ schema: "pifleet.triage/v2" }), stripKey("schema")]) {
      const refused = refusalFor(doc);
      expect(refused.issues.some((i) => i.path === "schema")).toBe(true);
    }
  });
});

/** The good document with one top-level key removed. */
function stripKey(key: string): Json {
  const doc = goodDocument();
  delete doc[key];
  return doc;
}

describe("three places this schema is deliberately LOOSER, and each is a gate downstream", () => {
  /**
   * §6.7 rule 2's first condition. A `.min(1)` on `coverage[]` would refuse the
   * document the gate exists to downgrade — *"a gate whose inputs cannot express
   * the failure is a gate that cannot fail"*.
   *
   * The assertion runs the parsed row through `evidenceGaps` rather than stopping
   * at "it parsed", because "the schema accepts it" is only half the claim.
   */
  test("an empty coverage[] parses AND still fails the evidence gate", () => {
    const got = read(goodDocument({ services: [goodRow({ coverage: [] })] }));
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(evidenceGaps(got.document.services[0]!)).toContain("coverage");
  });

  /** §6.7 rule 2's fourth condition, the same way. */
  test("an empty evidence_ref[] parses AND still fails the evidence gate", () => {
    const got = read(goodDocument({ services: [goodRow({ evidence_ref: [] })] }));
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(evidenceGaps(got.document.services[0]!)).toContain("ledger");
  });

  /**
   * ABSENT resolves to `null`, and `null` is what §6.7 rule 2's second and third
   * conditions read. Requiring the keys would make two of five conditions
   * unreachable from a real document.
   */
  test("absent selector and window parse as null and still fail the gate", () => {
    const row = goodRow();
    delete row.selector;
    delete row.window;
    const got = read(goodDocument({ services: [row] }));
    if (got.kind !== "ok") throw new Error(got.reason);

    expect(got.document.services[0]!.selector).toBeNull();
    expect(got.document.services[0]!.window).toBeNull();
    expect(evidenceGaps(got.document.services[0]!)).toEqual(["selector", "window"]);
  });

  /**
   * §6.6 layer 3's `absent` state, which `sweepIdEcho` names outright. A required
   * `sweep_id` would turn the freshness check into a formality — the document
   * could never omit the field the check was written to catch it omitting.
   */
  test("an absent sweep_id parses as null and the sweep is stale_replay", () => {
    const got = read(stripKey("sweep_id"));
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(got.document.sweep_id).toBeNull();

    const assessment = assessTriageSweep("T-sweep-41", COVERAGE, got.document);
    expect(assessment.stale_replay).toContain("tri-1");
  });

  /**
   * **Two rows for one service PASS the schema on purpose.**
   * `assessTriageSweep` refuses that per SERVICE (`triage-verdict.ts:574-592`)
   * after two mutation rounds settled it, and a `.superRefine` dedup here would
   * refuse the whole document instead and make that decision unreachable. This
   * test is what stops a future edit tightening the schema into deleting it.
   */
  test("a duplicate service row parses, and the VERDICT refuses it per service", () => {
    const got = read(
      goodDocument({ services: [goodRow(), goodRow({ assessment: "healthy" })] }),
    );
    if (got.kind !== "ok") throw new Error(got.reason);
    expect(got.document.services).toHaveLength(2);

    const assessment = assessTriageSweep("T-sweep-41", COVERAGE, got.document);
    expect(assessment.services[0]!.reason).toBe("duplicate_rows");
  });
});

describe("what is refused whole", () => {
  /**
   * A service name is compared against `triage/targets.yaml` and travels into a
   * per-service record path. Held to the same `SESSION_ID_RE` the targets file
   * uses, so a legal document can never name a service a legal targets file
   * could not.
   */
  test.each([["../../etc/passwd"], ["a/b"], [".hidden"], [""]])(
    "a service name %p is refused",
    (service) => {
      const refused = refusalFor(goodDocument({ services: [goodRow({ service })] }));
      expect(refused.issues[0]!.path).toBe("services.0.service");
    },
  );

  /**
   * `.strict()`, and the refusal names the KEY rather than the object holding it
   * — `parseTriageConsoleConfig`'s treatment, because a refusal reading
   * `(document)` sends an operator to the wrong line.
   */
  test("an unrecognized key is refused and named", () => {
    const refused = refusalFor(goodDocument({ acceptance: "verified" }));
    expect(refused.issues[0]!.path).toBe("acceptance");
    expect(refused.issues[0]!.fault).toBe("unrecognized");
  });

  test("an unrecognized key INSIDE a row is refused and named", () => {
    const refused = refusalFor(goodDocument({ services: [goodRow({ verdict: "fine" })] }));
    expect(refused.issues[0]!.path).toBe("services.0.verdict");
  });

  /**
   * The arrays are BOUNDED, and the bound is not zero.
   *
   * A refusal-only assertion passes a schema with `.max(0)`, which refuses every
   * real document — so the premise is asserted one step earlier: a list AT the cap
   * parses. `services` and `unaccounted` are separate arrays and get separate
   * fixtures, because one bound holding says nothing about the other.
   *
   * The cap is `MAX_SERVICES_PER_ENVIRONMENT`, imported rather than re-spelled:
   * §7.1 already fixes how many services one environment may declare, and a sweep
   * covers one environment.
   */
  test("services[] and unaccounted[] are bounded, and the bounds admit a full list", () => {
    const names = Array.from({ length: MAX_SERVICES_PER_ENVIRONMENT }, (_, i) => `svc-${i}`);

    const atCap = goodDocument({
      services: names.map((service) => goodRow({ service })),
      unaccounted: names,
    });
    const ok = read(atCap);
    if (ok.kind !== "ok") throw new Error(ok.reason);
    expect(ok.document.services).toHaveLength(MAX_SERVICES_PER_ENVIRONMENT);
    expect(ok.document.unaccounted).toHaveLength(MAX_SERVICES_PER_ENVIRONMENT);

    expect(
      refusalFor({ ...atCap, services: [...names, "svc-extra"].map((s) => goodRow({ service: s })) })
        .issues[0]!.path,
    ).toBe("services");
    expect(
      refusalFor({ ...atCap, unaccounted: [...names, "svc-extra"] }).issues[0]!.path,
    ).toBe("unaccounted");
  });

  /** The same pair for the two arrays that live inside a row. */
  test("coverage[] and evidence_ref[] are bounded, and the bounds admit a full list", () => {
    const channels = Array.from({ length: MAX_SERVICES_PER_ENVIRONMENT }, (_, i) => ({
      channel: `ch-${i}`,
      result: "answered" as const,
    }));
    const refs = Array.from({ length: MAX_SERVICES_PER_ENVIRONMENT }, (_, i) => `obs:${i}`);

    expect(read(goodDocument({ services: [goodRow({ coverage: channels, evidence_ref: refs })] })).kind).toBe(
      "ok",
    );
    expect(
      refusalFor(goodDocument({ services: [goodRow({ coverage: [...channels, channels[0]!] })] }))
        .issues[0]!.path,
    ).toBe("services.0.coverage");
    expect(
      refusalFor(goodDocument({ services: [goodRow({ evidence_ref: [...refs, "x"] })] })).issues[0]!
        .path,
    ).toBe("services.0.evidence_ref");
  });
});

// ---------------------------------------------------------------------------
// The divergence this schema found, driven against the file that carries it
// ---------------------------------------------------------------------------

const ROLE = readFileSync(join(import.meta.dir, "..", "..", "roles", "triage.md"), "utf8");

/** Every fenced JSON block, in document order — `triage-role.test.ts`'s helper. */
function jsonBlocks(): string[] {
  return [...ROLE.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * **THIS BLOCK IS A TRIPWIRE AND IS EXPECTED TO GO RED WHEN THE BUG IS FIXED.**
 *
 * `roles/triage.md:288-317`'s worked example — the document this fleet's prompt
 * tells `tri-1` to write — does not satisfy §7.5's host contract. Three fields
 * disagree, and the file is not this task's to edit (§13 task 5.5a touches
 * `src/run/triage-document.ts` and this test).
 *
 * So the divergence is pinned rather than described: the assertions below name
 * the three fields, and the day `roles/triage.md` is corrected they fail and
 * force their own replacement with the positive probe `triage-role.test.ts`
 * already spells for the fan-out example — *"an example that does not validate is
 * worse than no example, because a model copies its shape confidently"*.
 *
 * **The replacement is one line**, and it is written here so that whoever trips
 * this wire does not have to derive it:
 *
 * ```ts
 * expect(parseTriageDocument(exampleBlock(), CTX).kind).toBe("ok");
 * ```
 */
describe("roles/triage.md's example against the schema it is supposed to satisfy", () => {
  test("there is exactly one triage.json example to grade", () => {
    expect(jsonBlocks().filter((b) => b.includes(TRIAGE_DOCUMENT_SCHEMA))).toHaveLength(1);
  });

  test("it satisfies §7.5, parsed through the real schema", () => {
    const body = jsonBlocks().find((b) => b.includes(TRIAGE_DOCUMENT_SCHEMA))!;
    const got = parseTriageDocument(body, CTX);
    if (got.kind !== "ok") {
      // The union here is `ok | refused`, so this branch is the refusal.
      throw new Error(
        `roles/triage.md's example is refused ${got.code}: ` +
          got.issues.map((i) => `${i.path} ${i.fault}`).join("; "),
      );
    }
    expect(got.document.services.length).toBeGreaterThan(1);
  });

  /**
   * ANTI, and it is what stops "it parses" from becoming the whole claim.
   *
   * A later schema that relaxed `coverage[]` back to strings would keep the test
   * above green while re-opening the exact defect the correction closed — a
   * string entry has no `result`, so `undefined !== "not_attempted"` is true and
   * every channel NAME counts as an attempted channel. So the three shapes that
   * were wrong are asserted BY SHAPE on the parsed value, not merely parsed.
   */
  test("the three shapes that were wrong are asserted on the parsed value", () => {
    const body = jsonBlocks().find((b) => b.includes(TRIAGE_DOCUMENT_SCHEMA))!;
    const got = parseTriageDocument(body, CTX);
    if (got.kind !== "ok") throw new Error("premise failed: the example no longer parses");
    const row = got.document.services[0]!;

    // coverage[] carries OBJECTS with a result in the closed set, never names.
    expect(row.coverage.length).toBeGreaterThan(0);
    for (const entry of row.coverage) {
      expect(typeof entry).toBe("object");
      expect(COVERAGE_RESULTS).toContain(entry.result);
    }
    /*
     * The premise for the gate below: the example must carry at least one
     * `not_attempted` AND at least one attempt, or it teaches only half the enum
     * and the fifth gate condition is unexercised by the document a model copies.
     */
    expect(row.coverage.some((e) => e.result === "not_attempted")).toBe(true);
    expect(row.coverage.some((e) => e.result !== "not_attempted")).toBe(true);

    // evidence_ref is a LEDGER, even at length one.
    expect(Array.isArray(row.evidence_ref)).toBe(true);
    expect(row.evidence_ref.length).toBeGreaterThan(0);

    // unaccounted[] is service NAMES.
    expect(got.document.unaccounted.length).toBeGreaterThan(0);
    for (const name of got.document.unaccounted) expect(typeof name).toBe("string");
  });

  /**
   * The finding lives in the module as an exported constant so a reader of the
   * code meets it, and is driven here so it is a test rather than a comment —
   * `ADVANCE_READS_NO_SUBJECT_FIELD`'s pattern.
   */
  test("the failure mode is recorded where a reader of the module will find it", () => {
    expect(TRIAGE_DOCUMENT_HISTORY).toContain("roles/triage.md");
    expect(TRIAGE_DOCUMENT_HISTORY).toContain("FAILED OPEN");
  });

  /**
   * **The silent half, and it is the reason this schema is worth more than its
   * acceptance criteria say.** The example's `coverage[]` is an array of channel
   * NAMES; `attempted` reads `entry.result`, gets `undefined`, and
   * `undefined !== "not_attempted"` is true — so before this module existed, a row
   * with no coverage data at all satisfied §6.7 rule 2's first condition.
   *
   * Asserted against `evidenceGaps` directly, with the cast the absent validator
   * was implicitly making, so the claim is measured rather than argued.
   */
  test("the un-validated shape defeats the evidence gate, which is why the gate needs this", () => {
    const asItArrives = {
      service: "mia",
      assessment: "healthy" as const,
      coverage: ["rollout", "logs", "sink"],
      selector: "app=mia",
      window: "5m",
      evidence_ref: ["obs-t1:observer-ops.json#services[0]"],
      observer: "obs-t1",
    };
    // The cast IS the hole: this is exactly what reached `assessTriageSweep`
    // before §7.5 had a schema.
    const gaps = evidenceGaps(asItArrives as unknown as Parameters<typeof evidenceGaps>[0]);
    expect(gaps).not.toContain("coverage");

    // And the schema refuses it, which is the whole of the repair.
    expect(read(goodDocument({ services: [asItArrives] })).kind).toBe("refused");
  });
});
