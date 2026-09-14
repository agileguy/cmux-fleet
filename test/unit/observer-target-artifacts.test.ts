/**
 * The observer target contracts, tested at the module and not through the
 * harvest (SRD-OBSERVER-ROLES §5.6, §6.7, tasks 2.1 and 2.2).
 *
 * ## Why this file exists when `harvest-reconcile.test.ts` is green
 *
 * The reconcile suites drive these parsers from outside, and the outside hides
 * two things.
 *
 * First, they probe what a document may NOT contain. Nothing there accepts each
 * member of a closed enum by name, or refuses a document for losing a required
 * field the rest of the fixture does not depend on. Measured at e8655f7:
 * dropping `indeterminate` from the assessment enum left those suites green.
 * So did making `name`, `assessment` or `worker` optional, or VM `services`.
 *
 * Second, `reconcile.ts` redacts every finding again on its way out. A
 * redaction missing from the inner layer is invisible behind that outer one.
 * The tests here call the parsers directly, with no second layer to hide
 * behind.
 *
 * ## The needle is synthetic
 *
 * No real credential appears here. The message checks look for the needle and
 * for its first 12 characters, because a partial redaction leaves a fragment,
 * and a fragment is still the start of the secret.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  ObserverAssessmentSchema,
  ObserverCoverageResultSchema,
  parseObserverDockerOpsArtifact,
  parseObserverVmOpsArtifact,
  redactSecrets,
} from "../../src/harvest/observer-target-artifacts.ts";
import { COVERAGE_RESULTS, OBSERVER_ASSESSMENTS } from "../../src/run/triage-verdict.ts";
import { maskComments } from "../support/mask-comments.ts";

const NEEDLE = "zz-synthetic-needle-0f9e8d7c6b5a";
const NEEDLE_PREFIX = NEEDLE.slice(0, 12);

/** §5.6's document, well formed, so each probe perturbs exactly one thing. */
function dockerDoc(): Record<string, unknown> {
  return {
    schema: "pifleet.observer-docker-ops/v1",
    worker: "obs-d1",
    sweep_id: null,
    window_opened_at: null,
    services: [
      {
        name: "web-1",
        namespace: "docker-host-a",
        assessment: "healthy",
        coverage: [
          { channel: "state", result: "answered" },
          { channel: "health", result: "answered" },
          { channel: "logs", result: "answered" },
          { channel: "stats", result: "not_attempted" },
          { channel: "events", result: "forbidden" },
        ],
        selector: "name=web-1",
        window: "300s",
        evidence_ref: ["observe-docker docker-host-a inspect web-1: State.Status=running"],
        container_id: "4f1c2b9d8e7a",
        image: "nginx:1.27",
        restart_count: 0,
      },
    ],
  };
}

/** §6.7's document, well formed. */
function vmDoc(): Record<string, unknown> {
  return {
    schema: "pifleet.observer-vm-ops/v1",
    worker: "obs-v1",
    sweep_id: null,
    window_opened_at: null,
    services: [
      {
        name: "vm-1",
        namespace: "vm-fleet-a",
        assessment: "degraded",
        coverage: [
          { channel: "reachability", result: "answered" },
          { channel: "system", result: "answered" },
          { channel: "units", result: "answered" },
          { channel: "logs", result: "answered" },
          { channel: "resources", result: "unreachable" },
          { channel: "cloud", result: "not_attempted" },
        ],
        selector: "host=vm-1.example.com",
        window: "300s",
        evidence_ref: ["observe-vm vm-fleet-a vm-1 systemctl --failed: 1 unit"],
        uptime_s: 86_400.5,
        system_state: "degraded",
        failed_units: ["nginx.service"],
      },
    ],
  };
}

function firstRow(d: Record<string, unknown>): Record<string, unknown> {
  return (d["services"] as Array<Record<string, unknown>>)[0]!;
}

type Parse = (raw: unknown, secrets?: readonly string[]) => unknown;

const TARGETS: ReadonlyArray<{ kind: string; doc: () => Record<string, unknown>; parse: Parse }> = [
  { kind: "observer-docker-ops", doc: dockerDoc, parse: parseObserverDockerOpsArtifact },
  { kind: "observer-vm-ops", doc: vmDoc, parse: parseObserverVmOpsArtifact },
];

/** The error `fn` throws. Fails the test if it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, and the call returned");
}

/** Every issue path of a ZodError, dotted, so a refusal can be tied to its field. */
function issuePaths(e: unknown): string[] {
  expect(e).toBeInstanceOf(ZodError);
  return (e as ZodError).issues.map((i) => i.path.map(String).join("."));
}

describe("the contract, member by member and field by field (SRD 2.1, 2.2)", () => {
  for (const t of TARGETS) {
    describe(t.kind, () => {
      // The control. Every probe below perturbs this document, so a probe that
      // refuses must be refusing the perturbation and not the fixture.
      test("a clean document parses under the default secrets", () => {
        expect(() => t.parse(t.doc())).not.toThrow();
      });

      // Spelled here, not read from the schema: a test that iterates the enum
      // it is checking accepts whatever the enum happens to hold.
      for (const member of ["healthy", "degraded", "unhealthy", "indeterminate"]) {
        test(`assessment "${member}" is accepted`, () => {
          const d = t.doc();
          firstRow(d)["assessment"] = member;
          const parsed = t.parse(d) as { services: Array<{ assessment: string }> };
          expect(parsed.services[0]!.assessment).toBe(member);
        });
      }

      for (const member of ["answered", "unreachable", "forbidden", "not_attempted"]) {
        test(`coverage result "${member}" is accepted`, () => {
          const d = t.doc();
          const coverage = firstRow(d)["coverage"] as Array<Record<string, unknown>>;
          coverage[0]!["result"] = member;
          const parsed = t.parse(d) as { services: Array<{ coverage: Array<{ result: string }> }> };
          expect(parsed.services[0]!.coverage[0]!.result).toBe(member);
        });
      }

      // Without this, the four acceptances above would pass for an open string.
      test('assessment "failed" is refused, so the enum is closed', () => {
        const d = t.doc();
        firstRow(d)["assessment"] = "failed";
        expect(issuePaths(thrown(() => t.parse(d)))).toContain("services.0.assessment");
      });

      const required: ReadonlyArray<[string, (d: Record<string, unknown>) => void, string]> = [
        ["a row with no name", (d) => delete firstRow(d)["name"], "services.0.name"],
        ["a row with no assessment", (d) => delete firstRow(d)["assessment"], "services.0.assessment"],
        ["a document with no worker", (d) => delete d["worker"], "worker"],
        ["a document with no services", (d) => delete d["services"], "services"],
      ];
      for (const [label, perturb, path] of required) {
        test(`${label} is refused, naming ${path}`, () => {
          const d = t.doc();
          perturb(d);
          expect(issuePaths(thrown(() => t.parse(d)))).toContain(path);
        });
      }
    });
  }

  // The module spells these enums rather than importing the triage console's,
  // because the SRD rules out that dependency. A test is allowed to import
  // both, and this is where the two spellings are held to one set.
  test("the assessment enum holds the triage console's members, by name", () => {
    expect([...ObserverAssessmentSchema.options].sort()).toEqual([...OBSERVER_ASSESSMENTS].sort());
  });

  test("the coverage result enum holds the triage console's members, by name", () => {
    expect([...ObserverCoverageResultSchema.options].sort()).toEqual([...COVERAGE_RESULTS].sort());
  });
});

describe("the inner redaction layer, with no caller redacting after it", () => {
  // Only the needle-as-key case below can actually catch a removed inner
  // redaction. `findCredentialLeaks`'s reported paths are built from field
  // NAMES, so the value and unknown-field cases never put the needle into
  // the message in the first place — their `not.toContain(NEEDLE)`
  // assertion holds even with `redactSecrets` deleted from the leak-message
  // path. A needle used as a KEY is the one case where the path itself is
  // built from the needle, so it is the one case this block is actually
  // testing the redaction against.
  const cases: ReadonlyArray<[string, (d: Record<string, unknown>) => void, string[]]> = [
    [
      "a needle in a value",
      (d) => (firstRow(d)["selector"] = `name=${NEEDLE}`),
      ["services[0].selector"],
    ],
    [
      "a needle in a field the schema does not know",
      (d) => (d["operator_note"] = `copied from the host: ${NEEDLE}`),
      ["operator_note"],
    ],
    [
      // Nested, so the second hit's PARENT path is spelled with the needle.
      // A key-only document at the root names `<root>` and would pass even
      // with the redaction deleted.
      "a needle used as a key",
      (d) => (firstRow(d)[NEEDLE] = { [NEEDLE]: "x" }),
      ["a key under services[0]", "a key under services[0].<redacted>"],
    ],
  ];

  for (const t of TARGETS) {
    describe(t.kind, () => {
      for (const [label, perturb, paths] of cases) {
        test(`${label} is refused, and the message names the path and not the needle`, () => {
          const d = t.doc();
          perturb(d);
          // The control: without the needle in `secrets` the same document
          // parses, so the refusal below is the sweep and not the schema.
          expect(() => t.parse(d)).not.toThrow();

          const e = thrown(() => t.parse(d, [NEEDLE]));
          expect(e).toBeInstanceOf(Error);
          const message = (e as Error).message;
          expect(message).toContain(`${t.kind} artifact contains a credential at: `);
          for (const p of paths) expect(message).toContain(p);
          expect(message).not.toContain(NEEDLE);
          expect(message).not.toContain(NEEDLE_PREFIX);
        });
      }
    });
  }
});

describe("redactSecrets", () => {
  test("every separate occurrence is replaced", () => {
    expect(redactSecrets(`a ${NEEDLE} b ${NEEDLE}`, [NEEDLE])).toBe("a <redacted> b <redacted>");
  });

  test("two matches that only touch, with no gap and no overlap, stay two markers", () => {
    // "WXYZ" ends exactly where "1234" begins: adjacent, not overlapping.
    // Merging touching spans would collapse this to one marker.
    expect(redactSecrets("WXYZ1234", ["WXYZ", "1234"])).toBe("<redacted><redacted>");
  });

  test("a blank needle is skipped rather than matching everywhere", () => {
    expect(redactSecrets("nothing to hide", ["", "   "])).toBe("nothing to hide");
  });

  test("a secret that contains a shorter secret is hidden whole, in either order", () => {
    const short = "inner-0a1b2c3d";
    const long = `outer-${short}-outer`;
    expect(redactSecrets(`x ${long} y`, [short, long])).toBe("x <redacted> y");
    expect(redactSecrets(`x ${long} y`, [long, short])).toBe("x <redacted> y");
  });

  test("two needles that overlap leave no fragment of either, in either order", () => {
    const a = "0123456789ab";
    const b = "89abcdefghij";
    const text = "<<0123456789abcdefghij>>";
    expect(redactSecrets(text, [a, b])).toBe("<<<redacted>>>");
    expect(redactSecrets(text, [b, a])).toBe("<<<redacted>>>");
  });

  test("a needle that overlaps its own next occurrence leaves no fragment", () => {
    expect(redactSecrets("[abcabcabc]", ["abcabc"])).toBe("[<redacted>]");
  });
});

describe("the module's imports", () => {
  // Comments are masked first: a docblock that discusses "node:fs" or
  // `Bun.write` in prose must not itself trip the checks below. (Masking
  // blanks comment text only — it has no bearing on real code, which is
  // never inside a comment to begin with.)
  const code = maskComments(
    readFileSync(join(import.meta.dir, "../../src/harvest/observer-target-artifacts.ts"), "utf8"),
  );

  // Every static import/re-export (`from "x"`), bare `import "x"`, dynamic
  // `import(...)`, and `require(...)` specifier — in any of the three quote
  // styles, backtick template literals included.
  const specifiers = [
    ...code.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]*)["'`]/g),
  ].map((m) => m[1]!);

  // Held to exactly these two, so a `triage-*` specifier — of any form
  // above — already fails this assertion. There is no separate "reaches
  // the triage console" test: one that filtered this same specifier list
  // could only go red when this one already had, which is not an
  // independent check, and the extra test's name oversold it as one.
  test("are exactly zod and the contracts module", () => {
    expect([...new Set(specifiers)].sort()).toEqual(["../contracts.ts", "zod"]);
  });

  test("name no filesystem or process API", () => {
    expect(code).not.toContain("node:fs");
    expect(code).not.toMatch(/\bopen\s*\(/);
    expect(code).not.toMatch(/\bBun\.(?:file|write|spawnSync|spawn)\b/);
    expect(code).not.toMatch(/\bBun\.\$/);
  });
});
