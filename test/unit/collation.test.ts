/**
 * The COLLATION ENVELOPE — SRD-REVIEW-CONSOLE §6.8 and D8, asserted.
 *
 * ## What this suite is grading, and what it deliberately is not
 *
 * §6.8 names three things a collation must carry, and every one of them is a
 * property of a DOCUMENT rather than of a filesystem: a finding count, a
 * `file:line` per finding, and the set of reviewers that raised each. So the
 * whole of this file runs against strings. Nothing here reads a repository,
 * resolves a path against a real `/workspace`, or knows whether the line it was
 * handed exists — that half belongs to the grader, and the split is recorded in
 * `collation.ts`'s header rather than left for a reader to infer from the
 * absence of a `mkdtemp`.
 *
 * ## The trap this suite was written against
 *
 * Five times on this branch a probe about a NARROWING was satisfied by a fixture
 * that made both sides of the narrowing agree. Every cross-field rule below is
 * therefore asserted twice: once with the asymmetric document that separates the
 * rule from its neighbour, and once with the document that would pass under
 * either. The pairs are marked ASYMMETRIC where the distinction is the point,
 * because a reader deleting one of them needs to know which half was load-
 * bearing.
 *
 * The sharpest of them is `raised_by`. A collation whose three lenses all
 * reported, with every finding attributed to all three, satisfies "attribution
 * is a subset of the lenses" and "attribution is a subset of the lenses that
 * REPORTED" identically — and the second is the rule that stops a two-lens
 * review reporting `3/3`.
 */
import { describe, expect, test } from "bun:test";

import {
  COLLATION_ARTIFACT_NAME,
  COLLATION_SCHEMA,
  CollationSchema,
  MAX_COLLATION_BYTES,
  collationArtifactPath,
  collationCeiling,
  lensCoverage,
  readCollation,
  reportedReviewers,
} from "../../src/run/collation.ts";

// ---------------------------------------------------------------------------
// Fixtures. Built by function so no test can mutate another's document.
// ---------------------------------------------------------------------------

/** An escape rather than a literal: a NUL in source is invisible in a diff. */
const NUL = String.fromCharCode(0);

const ARCH = { aspect: "arch", worker: "rev-arch-1", reported: true };
const CTX = { aspect: "context", worker: "rev-ctx-1", reported: true };
const LANG = { aspect: "lang", worker: "rev-lang-1", reported: true };

/**
 * Three lenses, all of which reported. The symmetric case.
 *
 * `finding_count` is filled from `findings` unless a caller overrides BOTH, so
 * no fixture accidentally exercises the declared-vs-counted disagreement while
 * claiming to be testing something else.
 */
function threeReported(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const findings = (overrides["findings"] ?? [
    {
      statement: "`allocate()` reads and writes the epoch without holding the latch.",
      file: "src/rpc/epoch.ts",
      line: 183,
      raised_by: ["rev-arch-1", "rev-lang-1"],
    },
  ]) as unknown[];
  return {
    schema: COLLATION_SCHEMA,
    task_id: "T-collate",
    parent_task_id: "T",
    lenses: [ARCH, CTX, LANG],
    finding_count: findings.length,
    findings,
    ...overrides,
  };
}

/**
 * ASYMMETRIC. Two lenses reported and one did not, so "a lens" and "a lens that
 * reported" are different sets and every rule phrased over the second can be
 * separated from the same rule phrased over the first.
 */
function twoReported(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const findings = (overrides["findings"] ?? [
    {
      statement: "The base ref is compared as a symbolic name.",
      file: "src/harvest/git.ts",
      line: 44,
      raised_by: ["rev-arch-1"],
    },
  ]) as unknown[];
  return {
    schema: COLLATION_SCHEMA,
    task_id: "T-collate",
    parent_task_id: "T",
    lenses: [ARCH, CTX, { ...LANG, reported: false, note: "the lens timed out" }],
    finding_count: findings.length,
    findings,
    ...overrides,
  };
}

function parseOk(doc: unknown) {
  const r = CollationSchema.safeParse(doc);
  expect(r.error?.message ?? "accepted").toBe("accepted");
  return r.data!;
}

/** The refusal's MESSAGE, so a probe can pin the rule rather than "it failed". */
function why(doc: unknown): string {
  const r = CollationSchema.safeParse(doc);
  expect(r.success, "the document was ACCEPTED and the probe expected a refusal").toBe(false);
  return r.error!.message;
}

// ---------------------------------------------------------------------------

describe("the document's identity", () => {
  test("a well-formed collation parses", () => {
    const c = parseOk(threeReported());
    expect(c.schema).toBe(COLLATION_SCHEMA);
    expect(c.findings).toHaveLength(1);
  });

  test("the tag is checked by name, not inferred from the shape", () => {
    expect(why(threeReported({ schema: "pifleet.result/v1" }))).toContain(COLLATION_SCHEMA);
  });

  /**
   * `.strict()`, and the probe is here rather than assumed because the fields
   * this document does not have are the ones a future edit adds silently: an
   * accepted-and-ignored `severity` reads to its author as an honoured one.
   */
  test("an unrecognised key is refused rather than ignored", () => {
    expect(why(threeReported({ severity: "high" }))).not.toBe("");
    expect(CollationSchema.safeParse(threeReported({ severity: "high" })).success).toBe(false);
  });
});

/**
 * D8's line, spelled in the parser.
 *
 * §6.8 is explicit that this instrument "is not acceptance and should not be
 * spelled as acceptance", because acceptance's guarantee is independence from
 * the worker and a structural check on worker-authored JSON has none. The
 * strongest available form of "do not spell it as acceptance" is that the word
 * is REFUSED, with the refusal saying why — which is what §10's anti-criterion
 * asks for and what `DispatchRequestItemSchema` already does at the other end of
 * the same exchange.
 */
describe("the collation is not acceptance and cannot be spelled as it (D8)", () => {
  test("an `acceptance` key is refused, and the refusal says why", () => {
    const m = why(threeReported({ acceptance: [{ criterion: "three lenses read it", met: true }] }));
    expect(m).toContain("acceptance");
    expect(m).toContain("D8");
  });

  /**
   * The REASON is pinned, not the refusal, and the battery is why here too.
   *
   * `.strict()` refuses any unknown key with "unrecognized key: verified", which
   * contains the word — so a probe looking for the word alone stayed green with
   * the named refusal deleted. The whole value of `notHere` over `.strict()` is
   * that the refusal SAYS WHY, and the only way to assert that is to assert the
   * why.
   */
  test("a `verified` key is refused BY NAME, with the reason", () => {
    const m = why(threeReported({ verified: true }));
    expect(m).toContain("verified");
    expect(m).toContain("D8");
    expect(m).toContain("SHAPE");
  });

  /**
   * A second status inside the artifact would be a second claim about the same
   * task, and nothing downstream reads it — so the two disagree silently. The
   * status lives in `pifleet.result/v1` and the refusal names it.
   */
  test("a `status` key is refused and points at the result envelope", () => {
    expect(why(threeReported({ status: "success" }))).toContain("pifleet.result/v1");
  });

  test("no field, type or export in the module is named after acceptance", async () => {
    const src = await Bun.file(
      new URL("../../src/run/collation.ts", import.meta.url).pathname,
    ).text();
    const declared = [...src.matchAll(/^export (?:const|function|type|interface|class) (\w+)/gm)].map(
      (m) => m[1]!,
    );
    expect(declared.length, "the export extractor found nothing — the probe has rotted")
      .toBeGreaterThanOrEqual(8);
    const borrowed = declared.filter((n) => /accept|certif|verif|attest|proof|proven/i.test(n));
    expect(
      borrowed,
      `these exports borrow acceptance's vocabulary for a check that does not have its ` +
        `independence: ${borrowed.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * The location's TYPE is refusable here; its RESOLUTION is not.
 *
 * The division is `collation.ts`'s and it is asserted from both sides, because
 * either half alone reads as an oversight. A document without a `file`, or with
 * a string where the line belongs, does not have the field §6.8 requires and is
 * refused. A document whose `file` is present and points nowhere is fifteen good
 * findings and one bad row, and `findingLocationProblem` in the census grades it
 * per finding against the run's real workdir — refusing the document for it here
 * would discard the other fourteen using a weaker test than the one that already
 * exists.
 */
describe("a finding's location is TYPED here and RESOLVED by the census (§6.8)", () => {
  function finding(over: Record<string, unknown>): Record<string, unknown> {
    return threeReported({
      findings: [
        {
          statement: "s",
          file: "src/a.ts",
          line: 1,
          raised_by: ["rev-arch-1"],
          ...over,
        },
      ],
    });
  }

  test("a repo-relative path is accepted", () => {
    expect(parseOk(finding({ file: "src/run/relay.ts" })).findings[0]!.file).toBe(
      "src/run/relay.ts",
    );
  });

  /**
   * A model that copies a reviewer's `/workspace/...` quote must not cost the
   * whole document. The census resolves both spellings against the real workdir.
   */
  test("a workdir-absolute path is accepted, for the census to resolve", () => {
    expect(parseOk(finding({ file: "/workspace/src/a.ts" })).findings[0]!.file).toBe(
      "/workspace/src/a.ts",
    );
  });

  /**
   * ASYMMETRIC, and the pair that pins the division rather than describing it.
   *
   * A traversal is a LOCATABILITY defect: the census refuses it with `relative()`
   * against the real workdir, which is an actual containment test, and it costs
   * that one finding. A control character is a RENDERING hazard: there is no
   * workdir against which a CR becomes safe to print, so it is refused here and
   * costs the document. A reader who swapped either half would redden this file.
   */
  test("ASYMMETRIC: a traversal is ACCEPTED here — containment is the census's test", () => {
    expect(parseOk(finding({ file: "../../etc/passwd" })).findings[0]!.file).toBe(
      "../../etc/passwd",
    );
  });

  test("ASYMMETRIC: a control character is REFUSED here — no workdir makes it printable", () => {
    expect(why(finding({ file: `src/a${NUL}.ts` }))).toContain("control character");
  });

  test("a carriage return is refused as well as a NUL", () => {
    expect(why(finding({ file: "a\rb.ts" }))).toContain("control character");
  });

  /** Printing the path is the injection the rule refuses, so it must not print it. */
  test("the refusal does not echo the path it is refusing", () => {
    expect(why(finding({ file: "distinctivename\rx.ts" }))).not.toContain("distinctivename");
  });

  test("an over-long path is refused", () => {
    expect(why(finding({ file: `${"a/".repeat(600)}x.ts` }))).not.toBe("");
  });

  test("a finding with no `file` key at all is refused (§10)", () => {
    expect(
      why(
        threeReported({
          findings: [{ statement: "the design is wrong", line: 1, raised_by: ["rev-arch-1"] }],
        }),
      ),
    ).not.toBe("");
  });

  test("a finding with no `line` key at all is refused", () => {
    expect(
      why(
        threeReported({
          findings: [{ statement: "s", file: "src/a.ts", raised_by: ["rev-arch-1"] }],
        }),
      ),
    ).not.toBe("");
  });

  test("a line delivered as a string is refused rather than coerced", () => {
    expect(why(finding({ line: "12" }))).not.toBe("");
  });

  test("a fractional line is refused — it is not a line number at all", () => {
    expect(why(finding({ line: 12.5 }))).not.toBe("");
  });

  /** Zero is a TYPE-legal line and an unusable one. The census says so, not this. */
  test("ASYMMETRIC: line 0 is accepted here and is the census's defect to report", () => {
    expect(parseOk(finding({ line: 0 })).findings[0]!.line).toBe(0);
  });

  test("a finding with no statement is refused", () => {
    expect(why(finding({ statement: "" }))).not.toBe("");
  });
});

/**
 * §6.8 rule 1's authored half, kept beside the derived one.
 *
 * The two numbers are allowed to disagree and the disagreement is a DATUM: the
 * census records `declared` against `counted`, so a truncated report says so out
 * loud. Refusing the disagreement here would delete the evidence the census was
 * built to record, which is why the probe below asserts acceptance.
 */
describe("the finding count is authored and derived, and the pair may disagree", () => {
  test("the document carries the collator's own count", () => {
    expect(parseOk(threeReported()).finding_count).toBe(1);
  });

  test("it is required — an omitted count is one omitted on the run it would disagree", () => {
    const doc = threeReported();
    delete doc["finding_count"];
    expect(why(doc)).not.toBe("");
  });

  test("ASYMMETRIC: a count disagreeing with the list is ACCEPTED, for the census to read", () => {
    const c = parseOk(threeReported({ finding_count: 4 }));
    expect(c.finding_count).toBe(4);
    expect(c.findings).toHaveLength(1);
  });

  test("a negative count is refused", () => {
    expect(why(threeReported({ finding_count: -1 }))).not.toBe("");
  });

  test("a fractional count is refused", () => {
    expect(why(threeReported({ finding_count: 1.5 }))).not.toBe("");
  });

  test("a count far above the list's own ceiling is refused as noise", () => {
    expect(why(threeReported({ finding_count: 100000 }))).not.toBe("");
  });

  /**
   * The authoritative half, pinned. A collator that claims four findings over an
   * empty list must not escape §6.8's third bullet by arithmetic.
   */
  test("the ceiling counts the LIST, not the claim", () => {
    const declaredButEmpty = readCollation(
      JSON.stringify(threeReported({ findings: [], finding_count: 4 })),
    );
    expect(collationCeiling("T-collate", "success", declaredButEmpty).status).toBe("partial");
  });
});

describe("attribution makes 3/3 and 1/3 visible, and cannot manufacture either (§6.8)", () => {
  test("a finding names the lenses that raised it", () => {
    expect(parseOk(threeReported()).findings[0]!.raised_by).toEqual(["rev-arch-1", "rev-lang-1"]);
  });

  test("an unattributed finding is refused", () => {
    expect(
      why(
        threeReported({
          findings: [{ statement: "s", file: "src/a.ts", line: 1, raised_by: [] }],
        }),
      ),
    ).not.toBe("");
  });

  /**
   * A repeated attribution turns 1/3 into 2/3 in any reader that counts the
   * array — which is exactly what §6.8 asks the record to make visible. Same
   * fabrication `resolveAspects` refuses for duplicate seats, one document
   * later.
   */
  test("a duplicated attribution is refused", () => {
    const m = why(
      threeReported({
        findings: [
          { statement: "s", file: "src/a.ts", line: 1, raised_by: ["rev-arch-1", "rev-arch-1"] },
        ],
      }),
    );
    expect(m).toContain("rev-arch-1");
  });

  /**
   * The MESSAGE is pinned, not just the refusal, and the battery is why.
   *
   * `rev-sec-1` is not a lens AND did not report, so both arms of the
   * attribution check refuse it. An assertion that only looked for the worker id
   * stayed green with the not-a-lens arm deleted entirely — the reported-lens
   * arm caught the same document with a different reason, and the probe could
   * not tell which rule had fired. Two rules, two sentences, and the sentence is
   * how they are told apart.
   */
  test("attribution to a worker that is not a lens of this console is refused", () => {
    const m = why(
      threeReported({
        findings: [{ statement: "s", file: "src/a.ts", line: 1, raised_by: ["rev-sec-1"] }],
      }),
    );
    expect(m).toContain("rev-sec-1");
    expect(m).toContain("is not a lens of this console");
  });

  /**
   * ASYMMETRIC, and the sharpest probe in the file. Under `threeReported` this
   * document is indistinguishable from the one above: `rev-lang-1` IS a lens, so
   * a rule phrased "attribution must name a lens" accepts it. Only the rule
   * phrased "attribution must name a lens that REPORTED" refuses, and that is
   * the rule that stops a two-lens review recording `3/3`.
   */
  test("ASYMMETRIC: attribution to a lens that did not report is refused", () => {
    const m = why(
      twoReported({
        findings: [
          {
            statement: "s",
            file: "src/a.ts",
            line: 1,
            raised_by: ["rev-arch-1", "rev-lang-1"],
          },
        ],
      }),
    );
    expect(m).toContain("rev-lang-1");
  });

  test("CONTROL: the same document with the missing lens dropped is accepted", () => {
    expect(
      parseOk(
        twoReported({
          findings: [
            { statement: "s", file: "src/a.ts", line: 1, raised_by: ["rev-arch-1", "rev-ctx-1"] },
          ],
        }),
      ).findings[0]!.raised_by,
    ).toEqual(["rev-arch-1", "rev-ctx-1"]);
  });
});

/**
 * "The collator does not vote, it reports who said what" (§9 Q7).
 *
 * Without a way to say two lenses DISAGREED, a contradiction can only be
 * recorded as a finding both of them raised — which reads as corroboration and
 * is its opposite. The field exists so the schema does not force that lie.
 */
describe("a contradiction is recorded as a contradiction, not as agreement", () => {
  test("a finding may name the lenses that disputed it", () => {
    const c = parseOk(
      threeReported({
        findings: [
          {
            statement: "The retry is safe because the write is idempotent.",
            file: "src/run/relay.ts",
            line: 800,
            raised_by: ["rev-arch-1"],
            disputed_by: ["rev-lang-1"],
          },
        ],
      }),
    );
    expect(c.findings[0]!.disputed_by).toEqual(["rev-lang-1"]);
  });

  test("`disputed_by` defaults to empty, so an ordinary finding needs no ceremony", () => {
    expect(parseOk(threeReported()).findings[0]!.disputed_by).toEqual([]);
  });

  /**
   * A lens on both sides of one finding is not a contradiction, it is a reader
   * counted twice — once as agreeing and once as dissenting.
   */
  test("a lens that both raised and disputed the same finding is refused", () => {
    const m = why(
      threeReported({
        findings: [
          {
            statement: "s",
            file: "src/a.ts",
            line: 1,
            raised_by: ["rev-arch-1"],
            disputed_by: ["rev-arch-1"],
          },
        ],
      }),
    );
    expect(m).toContain("rev-arch-1");
  });

  test("ASYMMETRIC: a dispute by a lens that did not report is refused", () => {
    const m = why(
      twoReported({
        findings: [
          {
            statement: "s",
            file: "src/a.ts",
            line: 1,
            raised_by: ["rev-arch-1"],
            disputed_by: ["rev-lang-1"],
          },
        ],
      }),
    );
    expect(m).toContain("rev-lang-1");
  });
});

describe("the lens table is the denominator, so it has to be sound", () => {
  /**
   * Pinned to the `min(1)` refusal's own sentence. An empty lens table trips the
   * no-lens-reported rule as well — zero reporting lenses is a consequence of
   * zero lenses — so a probe that only asked "was it refused?" stayed green with
   * `min(1)` deleted. Found by mutating.
   */
  test("a collation with no lenses is refused — there is no denominator", () => {
    expect(why(threeReported({ lenses: [] }))).toContain("no denominator");
  });

  test("two lenses on one worker are refused — the denominator would double", () => {
    const m = why(threeReported({ lenses: [ARCH, { ...CTX, worker: "rev-arch-1" }, LANG] }));
    expect(m).toContain("rev-arch-1");
  });

  test("two lenses on one aspect are refused", () => {
    const m = why(threeReported({ lenses: [ARCH, { ...CTX, aspect: "arch" }, LANG] }));
    expect(m).toContain("arch");
  });

  /**
   * §6.6's table: zero children succeeding dispatches NO collation. A document
   * claiming every lens is missing therefore describes a collation task that
   * cannot exist, and accepting it would let a collator manufacture a review out
   * of a fan-out that produced nothing.
   */
  test("a collation in which no lens reported is refused", () => {
    const m = why(
      threeReported({
        lenses: [ARCH, CTX, LANG].map((l) => ({ ...l, reported: false })),
        findings: [],
      }),
    );
    expect(m).not.toBe("");
  });

  test("a missing lens may carry a note saying why", () => {
    expect(parseOk(twoReported()).lenses[2]!.note).toBe("the lens timed out");
  });
});

describe("the two halves of one request stay linked (D5)", () => {
  test("the collation's task id is derived from the parent's", () => {
    expect(parseOk(threeReported()).parent_task_id).toBe("T");
  });

  test("a task id that is not the parent's collation id is refused", () => {
    const r = readCollation(JSON.stringify(threeReported({ task_id: "T-arch" })));
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.code).toBe("task_id_mismatch");
      expect(r.reason).toContain("T-collate");
    }
  });

  test("an id that cannot be a path segment is refused", () => {
    expect(why(threeReported({ parent_task_id: "../../control-auth" }))).not.toBe("");
  });
});

describe("readCollation answers with a value rather than throwing", () => {
  test("an absent artifact is `missing`, which is not a refusal", () => {
    expect(readCollation(null).kind).toBe("missing");
  });

  test("bytes that are not JSON are refused as `not_json`", () => {
    const r = readCollation("{not json");
    expect(r.kind === "refused" && r.code).toBe("not_json");
  });

  test("a JSON scalar is refused as `schema`, not as `not_json`", () => {
    const r = readCollation("42");
    expect(r.kind === "refused" && r.code).toBe("schema");
  });

  test("an oversize document is refused before it is parsed", () => {
    const r = readCollation(`"${"x".repeat(MAX_COLLATION_BYTES)}"`);
    expect(r.kind === "refused" && r.code).toBe("too_large");
  });

  test("a well-formed document round-trips", () => {
    const r = readCollation(JSON.stringify(threeReported()));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.collation.findings).toHaveLength(1);
  });

  test("a schema violation is refused as `schema` and the reason survives", () => {
    const r = readCollation(JSON.stringify(threeReported({ lenses: [] })));
    expect(r.kind === "refused" && r.code).toBe("schema");
    if (r.kind === "refused") expect(r.reason.length).toBeGreaterThan(10);
  });
});

describe("coverage is a datum beside the verdict, not folded into it (§9 Q6)", () => {
  test("three of three", () => {
    expect(lensCoverage(parseOk(threeReported()))).toEqual({
      total: 3,
      reported: 3,
      missing: [],
    });
  });

  /** ASYMMETRIC: `total` and `reported` differ, so neither can stand in for the other. */
  test("two of three names the lens that is missing", () => {
    expect(lensCoverage(parseOk(twoReported()))).toEqual({
      total: 3,
      reported: 2,
      missing: ["lang"],
    });
  });

  /**
   * The roster the census checks `raised_by` against, derived rather than
   * carried as a second field. `collation-census.ts`'s reconciliation note names
   * three fields it cannot do without; a flat `reviewers[]` beside the lens
   * table would be a fourth and would spell one set twice.
   */
  test("the reviewer roster is the lenses that REPORTED", () => {
    expect(reportedReviewers(parseOk(threeReported()))).toEqual([
      "rev-arch-1",
      "rev-ctx-1",
      "rev-lang-1",
    ]);
  });

  test("ASYMMETRIC: a lens that did not report is not in the roster", () => {
    expect(reportedReviewers(parseOk(twoReported()))).toEqual(["rev-arch-1", "rev-ctx-1"]);
  });

  /**
   * The property that makes the lens table worth more than the flat roster it
   * replaces: `2` out of two readers and `2` out of three are different facts,
   * and only the coverage carries the difference.
   */
  test("the roster alone cannot express the denominator; coverage can", () => {
    const two = parseOk(twoReported());
    expect(reportedReviewers(two)).toHaveLength(2);
    expect(lensCoverage(two).total).toBe(3);
  });
});

/**
 * §6.8's third bullet, and the only rule in this module that changes a verdict.
 *
 * It is a CEILING and never a supply: the claim is the antecedent, so a claim of
 * anything other than `success` comes back unchanged and the instrument can
 * never lift a record. §7.3 — self-report may downgrade, never upgrade — read
 * from the other side.
 */
describe("zero findings with a claim of success is partial (§6.8)", () => {
  const ok = readCollation(JSON.stringify(threeReported()));
  const empty = readCollation(JSON.stringify(threeReported({ findings: [] })));
  /** The collation half of a review — the only task this instrument judges. */
  const C = "T-collate";

  test("a collation with findings leaves a success claim alone", () => {
    expect(collationCeiling(C, "success", ok)).toEqual({ status: "success", reason: null });
  });

  test('"I found nothing" from three readers is not success', () => {
    const c = collationCeiling(C, "success", empty);
    expect(c.status).toBe("partial");
    expect(c.reason).toContain("zero findings");
  });

  test("a missing collation does not let a success claim stand either", () => {
    expect(collationCeiling(C, "success", readCollation(null)).status).toBe("partial");
  });

  test("a collation that does not parse does not let a success claim stand", () => {
    expect(collationCeiling(C, "success", readCollation("{nope")).status).toBe("partial");
  });

  /**
   * ASYMMETRIC against every case above. If the claim were not part of the
   * antecedent, this cell would come back `partial` — a value the instrument
   * SUPPLIED rather than capped — and a review whose worker honestly reported
   * `failed` would be recorded as better than it was.
   */
  test("ASYMMETRIC: a claim of failed with zero findings stays failed", () => {
    expect(collationCeiling(C, "failed", empty)).toEqual({ status: "failed", reason: null });
  });

  test("ASYMMETRIC: a claim of partial with zero findings stays partial", () => {
    expect(collationCeiling(C, "partial", empty)).toEqual({ status: "partial", reason: null });
  });

  test("ASYMMETRIC: a claim of blocked with a missing collation stays blocked", () => {
    expect(collationCeiling(C, "blocked", readCollation(null)).status).toBe("blocked");
  });

  test("an unknown claim is left alone — a missing envelope must not clamp (ISC-94)", () => {
    expect(collationCeiling(C, "unknown", empty)).toEqual({ status: "unknown", reason: null });
  });

  /**
   * ASYMMETRIC on the TASK rather than on the claim, and this is the pair that
   * a fixture using only `T-collate` would hide entirely.
   *
   * §6.6 makes a review two tasks. `T` is the fan-out: it issues the request and
   * settles `success` having done exactly its job, and it has no collation
   * artifact because writing one is not its job. Every other task in the fleet
   * is in the same position. Without the task-id guard the `missing` arm would
   * cap all of them, and the caller asking would have no way to know it had
   * asked the wrong question.
   */
  test("ASYMMETRIC: the FAN-OUT task's success claim is untouched", () => {
    expect(collationCeiling("T", "success", readCollation(null))).toEqual({
      status: "success",
      reason: null,
    });
  });

  test("ASYMMETRIC: an unrelated task's success claim is untouched", () => {
    expect(collationCeiling("T-arch", "success", readCollation(null)).status).toBe("success");
    expect(collationCeiling("build-42", "success", readCollation(null)).status).toBe("success");
  });

  test("CONTROL: the same missing read DOES cap the collation task", () => {
    expect(collationCeiling(C, "success", readCollation(null)).status).toBe("partial");
  });

  test("the ceiling never returns a status above the claim", () => {
    for (const claimed of ["success", "partial", "blocked", "failed", "unknown"] as const) {
      for (const read of [ok, empty, readCollation(null), readCollation("{")]) {
        for (const id of [C, "T", "anything-collate"]) {
          const out = collationCeiling(id, claimed, read).status;
          expect([claimed, "partial"]).toContain(out);
        }
      }
    }
  });
});

describe("the artifact's name is spelled once", () => {
  test("the path is built from the constant", () => {
    expect(collationArtifactPath("T-collate")).toBe(
      `/outbox/T-collate/files/${COLLATION_ARTIFACT_NAME}`,
    );
  });

  test("an id that cannot be a path segment throws rather than joining", () => {
    expect(() => collationArtifactPath("../../etc")).toThrow();
  });
});
