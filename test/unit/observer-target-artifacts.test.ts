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
type Target = { kind: string; doc: () => Record<string, unknown>; parse: Parse };

const TARGETS: ReadonlyArray<Target> = [
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
  // redaction. The sweep's reported paths are built from field NAMES, so the
  // value and unknown-field cases never put the needle into the message in the
  // first place — their `not.toContain(NEEDLE)` assertion holds even with
  // `redactSecrets` deleted from the leak-message path. A needle used as a KEY
  // is the one case where the path itself is built from the needle, so it is
  // the one case this block is actually testing the redaction against.
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

/**
 * THE RAW SWEEP'S REFUSAL AND COST ARE BOUNDED, WHATEVER THE DOCUMENT'S SHAPE
 * (FP2-3 task A).
 *
 * At 1b9628e the raw sweep built a dotted path for every string and every
 * container, recursed, and named every hit. Measured there, one fresh process
 * per shape, with the hostile shapes below:
 *   - the value chain, 562 KiB of JSON: +2,324 MiB RSS, 540 ms, and a refusal
 *     807,810,053 characters long;
 *   - the value leaf shape, 97 KiB: +185 MiB RSS and a 64,069,943-character
 *     refusal.
 *
 * Every assertion here is a count, a length or an exact spelling. The one time
 * bound is a generous backstop, never the thing that goes red first.
 *
 * The numbers are spelled, not imported: a test that reads the cap from the
 * module accepts whatever cap the module happens to hold.
 */
const NAMED_CAP = 5;
const PATH_CAP = 1024;
const CUT = "…[path truncated]";
const MESSAGE_BOUND = 8_192;
const BACKSTOP_MS = 10_000;
const DEPTH_CAP = 32_768;

/**
 * Parse `body` as the harvest does, sweep it under the needle, and read the
 * refusal back into the paths it names and the count of the rest.
 */
function refusal(t: Target, body: string): { named: string[]; more: number; ms: number } {
  const raw: unknown = JSON.parse(body);
  const t0 = performance.now();
  const e = thrown(() => t.parse(raw, [NEEDLE]));
  const ms = performance.now() - t0;
  expect(e).toBeInstanceOf(Error);
  const message = (e as Error).message;
  // Length first. A regressed sweep's message runs to hundreds of millions of
  // characters, and every later assertion would scan or print it.
  expect(message.length).toBeLessThan(MESSAGE_BOUND);
  const prefix = `${t.kind} artifact contains a credential at: `;
  expect(message.startsWith(prefix), message.slice(0, 200)).toBe(true);
  expect(message).not.toContain(NEEDLE);
  expect(message).not.toContain(NEEDLE_PREFIX);
  const m = /^([\s\S]*?)(?: \(and (\d+) more\))?$/.exec(message.slice(prefix.length))!;
  return { named: m[1]!.split(", "), more: m[2] === undefined ? 0 : Number(m[2]), ms };
}

/** `n` root fields, `f0` to `f<n-1>`, each holding the needle. */
function needleFields(n: number): string {
  return JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, NEEDLE])));
}

describe("the raw sweep names a bounded number of hits, each path capped", () => {
  for (const t of TARGETS) {
    describe(t.kind, () => {
      test(`${NAMED_CAP} hits are all named, with no count after them`, () => {
        const r = refusal(t, needleFields(NAMED_CAP));
        expect(r.named).toEqual(["f0", "f1", "f2", "f3", "f4"]);
        expect(r.more).toBe(0);
      });

      test(`hit ${NAMED_CAP + 1} is counted and not named`, () => {
        const r = refusal(t, needleFields(NAMED_CAP + 1));
        expect(r.named).toEqual(["f0", "f1", "f2", "f3", "f4"]);
        expect(r.more).toBe(1);
      });

      // The floor under the cap. `harvest-reconcile.test.ts` rebuilds a secret
      // out of a sweep path up to about 552 characters long, past its own cut at
      // 512; a cap below that would stop that test exercising the rebuild.
      test(`a path of exactly ${PATH_CAP} characters is named whole`, () => {
        const key = "k".repeat(PATH_CAP);
        expect(refusal(t, JSON.stringify({ [key]: NEEDLE })).named).toEqual([key]);
      });

      test(`a path of ${PATH_CAP + 1} characters is cut to ${PATH_CAP} and marked`, () => {
        const key = "k".repeat(PATH_CAP + 1);
        expect(refusal(t, JSON.stringify({ [key]: NEEDLE })).named).toEqual([
          `${"k".repeat(PATH_CAP)}${CUT}`,
        ]);
      });

      // Cut first, and the path below would keep the needle's first 24
      // characters: exact-match redaction cannot find a head. Redacted first,
      // the needle is already `<redacted>` when the cut lands.
      test("a path is redacted before it is cut, so the cut leaves no head of the secret", () => {
        const key = `${"k".repeat(1000)}${NEEDLE}${"k".repeat(100)}`;
        const r = refusal(t, JSON.stringify({ [key]: { x: NEEDLE } }));
        expect(r.named).toEqual([`${"k".repeat(1000)}<redacted>${"k".repeat(14)}${CUT}`, "a key under <root>"]);
      });
    });
  }
});

describe("the raw sweep walks deep documents without the call stack", () => {
  /** `depth` objects, each under `"a"`, with `bottom` as the innermost. */
  const objects = (depth: number, bottom: string): string =>
    `{"a":`.repeat(depth - 1) + bottom + "}".repeat(depth - 1);
  /** `depth` arrays, with `bottom` as the innermost. */
  const arrays = (depth: number, bottom: string): string => "[".repeat(depth - 1) + bottom + "]".repeat(depth - 1);

  for (const t of TARGETS) {
    describe(t.kind, () => {
      // 32,768 is past where the old recursion overflowed: measured at
      // 1b9628e in a bare script, about 13,900 nested arrays and 24,500 nested
      // objects.
      const swept: ReadonlyArray<[string, string, string]> = [
        ["objects, a needle value at the bottom", objects(DEPTH_CAP, `{"a":"${NEEDLE}"}`), `${"a.".repeat(512)}${CUT}`],
        ["arrays, a needle value at the bottom", arrays(DEPTH_CAP, `["${NEEDLE}"]`), `${"[0]".repeat(341)}[${CUT}`],
        [
          "objects, a needle key at the bottom",
          objects(DEPTH_CAP, `{"${NEEDLE}":0}`),
          `a key under ${"a.".repeat(506)}${CUT}`,
        ],
      ];
      for (const [label, body, path] of swept) {
        test(`${DEPTH_CAP} ${label}: swept to the bottom and named`, () => {
          const r = refusal(t, body);
          expect(r.named).toEqual([path]);
          expect(r.more).toBe(0);
        });
      }

      // A fixed depth, so the refusal no longer depends on how much stack the
      // caller has left. `reconcile.ts` reports a throw that is not the
      // credential refusal by its message, so the message must not claim one.
      for (const [label, body] of [
        ["objects", objects(DEPTH_CAP + 1, `{"a":"${NEEDLE}"}`)],
        ["arrays", arrays(DEPTH_CAP + 1, `["${NEEDLE}"]`)],
      ] as const) {
        test(`${DEPTH_CAP + 1} ${label}: refused with a RangeError that claims no credential`, () => {
          const raw: unknown = JSON.parse(body);
          const e = thrown(() => t.parse(raw, [NEEDLE]));
          expect(e).toBeInstanceOf(RangeError);
          const message = (e as Error).message;
          expect(message).toContain(`${t.kind} artifact is nested more than ${DEPTH_CAP} levels deep`);
          expect(message).not.toContain("credential");
          expect(message).not.toContain(NEEDLE_PREFIX);
        });
      }
    });
  }
});

describe("the raw sweep's cost on hostile shapes", () => {
  const K100 = "k".repeat(100);
  const K1000 = "k".repeat(1000);
  /** `n` copies of `seg`, dotted, as the sweep spells a run of object keys. */
  const dotted = (n: number, seg: string): string => Array.from({ length: n }, () => seg).join(".");
  const first5 = (f: (i: number) => string): string[] => [0, 1, 2, 3, 4].map(f);

  const shapes: ReadonlyArray<{ label: string; body: () => string; hits: number; named: string[] }> = [
    {
      // The paths total L·d²/2 characters: 800 million here.
      label: "a chain 4000 objects deep, a needle value at every level, 100-character keys",
      body: () => `{"v":"${NEEDLE}","${K100}":`.repeat(4000) + "0" + "}".repeat(4000),
      hits: 4000,
      named: first5((i) => (i === 0 ? "v" : `${dotted(i, K100)}.v`)),
    },
    {
      label: "a chain 4000 objects deep, a needle key at every level, 100-character keys",
      body: () => `{"${NEEDLE}":1,"${K100}":`.repeat(4000) + "0" + "}".repeat(4000),
      hits: 4000,
      named: first5((i) => `a key under ${i === 0 ? "<root>" : dotted(i, K100)}`),
    },
    {
      // Each path is 64,000 characters, so each named one is cut.
      label: "1000 needle values under a spine 64 objects deep, 1000-character keys",
      body: () => `{"${K1000}":`.repeat(64) + `[${Array.from({ length: 1000 }, () => `"${NEEDLE}"`).join(",")}]` + "}".repeat(64),
      hits: 1000,
      named: first5(() => `${K1000}.${"k".repeat(23)}${CUT}`),
    },
    {
      label: "1000 needle keys under a spine 64 objects deep, 1000-character keys",
      body: () =>
        `{"${K1000}":`.repeat(64) + `[${Array.from({ length: 1000 }, () => `{"${NEEDLE}":1}`).join(",")}]` + "}".repeat(64),
      hits: 1000,
      named: first5(() => `a key under ${K1000}.${"k".repeat(11)}${CUT}`),
    },
  ];

  for (const t of TARGETS) {
    describe(t.kind, () => {
      for (const s of shapes) {
        test(`${s.label}: a bounded refusal naming ${NAMED_CAP} hits and counting the rest`, () => {
          const r = refusal(t, s.body());
          expect(r.named).toEqual(s.named);
          expect(r.more).toBe(s.hits - NAMED_CAP);
          for (const p of r.named) expect(p.length).toBeLessThanOrEqual(PATH_CAP + CUT.length);
          expect(r.ms, "a backstop only").toBeLessThan(BACKSTOP_MS);
        }, 60_000);
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

/**
 * THE MODULE'S IMPORTS AND APIS, READ THROUGH THE TRANSPILER (FP2-3 task B).
 *
 * These checks used to read `test/support/mask-comments.ts` output, and that
 * masker guesses where a regex literal ends. A wrong guess blanks real code.
 * Measured at 1b9628e: appending `return /[/*]/.test(s);` inside a function,
 * then `import("node:fs")` and `Bun.write("x","y")`, left both checks green,
 * because the masker read the `/*` inside the character class as a comment
 * opener. The same insertion without the regex line turned both red.
 *
 * So the specifiers come from `Bun.Transpiler#scanImports`, which parses the
 * source, and the API checks read `transformSync` output, which is the code with
 * every comment dropped by that parser. The sample tests at the end feed each
 * refused form to the same two readers, after that same regex literal, so the
 * guard is shown catching what it says it catches.
 *
 * `Bun`, `process` and `require` are refused as whole words, which covers member
 * access, a computed name and destructuring in one check: this module has no
 * use for any of them. A word check reads string literals as well as code, so
 * it refuses a little more than it must. It is a guard against a mistake, and
 * not a sandbox: code written to assemble a global's name at runtime through
 * something not listed here would get past it.
 */
describe("the module's imports and APIs, read through the transpiler", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const MODULE = readFileSync(join(import.meta.dir, "../../src/harvest/observer-target-artifacts.ts"), "utf8");

  /** Every specifier the parser finds: static, bare, re-exported, dynamic, `require`. */
  const importSpecifiers = (src: string): string[] =>
    [...new Set(transpiler.scanImports(src).map((i) => i.path))].sort();

  const REFUSED: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
    ["Bun", /\bBun\b/],
    ["process", /\bprocess\b/],
    ["require", /\brequire\b/],
    ["fetch", /\bfetch\b/],
    ["Worker", /\bWorker\b/],
    ["globalThis", /\bglobalThis\b/],
    ["eval", /\beval\b/],
    ["Function", /\bFunction\b/],
    ["open(", /\bopen\s*\(/],
    ["import(", /\bimport\s*\(/],
    // Quoted, so a property named `node` is not read as a `node:` specifier.
    ["a quoted node: specifier", /["'`]node:/],
  ];

  /** The names of the refused APIs that `src`'s code, comments dropped, mentions. */
  const refusedApis = (src: string): string[] => {
    const code = transpiler.transformSync(src);
    return REFUSED.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  };

  test("its import specifiers, as the transpiler scans them, are exactly zod and the contracts module", () => {
    expect(importSpecifiers(MODULE)).toEqual(["../contracts.ts", "zod"]);
  });

  test("its code, with comments dropped by the transpiler, names none of the refused APIs", () => {
    expect(refusedApis(MODULE)).toEqual([]);
  });

  test("a comment naming refused APIs and modules is dropped, so prose is not refused", () => {
    const prose =
      '/** Bun.write("x", "y"), process.getBuiltinModule("fs"), require("node:fs"), fetch( */\n' +
      '// new Worker("x.ts"), import("node:fs"), globalThis, eval, Function, open(\n' +
      "export const ok = 1;\n";
    expect(refusedApis(prose)).toEqual([]);
    expect(importSpecifiers(prose)).toEqual([]);
  });

  /** The line that fooled the comment masker, ahead of every sample. */
  const REGEX_TRAP = "export function slashStar(s: string): boolean {\n  return /[/*]/.test(s);\n}\n";

  const API_SAMPLES: ReadonlyArray<readonly [form: string, code: string, refusedAs: string]> = [
    ["Bun.file", 'Bun.file("x");', "Bun"],
    ["Bun.write", 'Bun.write("x", "y");', "Bun"],
    ["Bun.spawn", 'Bun.spawn(["x"]);', "Bun"],
    ["Bun.spawnSync", 'Bun.spawnSync(["x"]);', "Bun"],
    ["Bun.mmap", 'Bun.mmap("x");', "Bun"],
    ["Bun.$", "Bun.$`x`;", "Bun"],
    ["a computed Bun[...]", 'Bun["write"]("x", "y");', "Bun"],
    ["destructuring from Bun", 'const { write } = Bun;\nwrite("x", "y");', "Bun"],
    ["process.getBuiltinModule", 'process.getBuiltinModule("fs");', "process"],
    ["fetch(", 'fetch("https://example.invalid/");', "fetch"],
    ["new Worker(", 'new Worker("x.ts");', "Worker"],
    ["require of an allowed module", 'require("zod");', "require"],
    ["globalThis with a computed name", 'globalThis["B" + "un"];', "globalThis"],
    ["open(", 'open("x");', "open("],
  ];
  for (const [form, code, refusedAs] of API_SAMPLES) {
    test(`${form} is refused as ${refusedAs}, after a regex literal holding "/*"`, () => {
      expect(refusedApis(`${REGEX_TRAP}${code}\n`)).toContain(refusedAs);
    });
  }

  const SPECIFIER_SAMPLES: ReadonlyArray<readonly [form: string, code: string]> = [
    ["a dynamic import", 'import("node:fs");'],
    ["a require call", 'require("node:fs");'],
    ["a re-export", 'export * from "node:fs";'],
    ["a bare import", 'import "node:fs";'],
  ];
  for (const [form, code] of SPECIFIER_SAMPLES) {
    test(`${form} of node:fs is scanned, after a regex literal holding "/*"`, () => {
      expect(importSpecifiers(`${REGEX_TRAP}${code}\n`)).toContain("node:fs");
    });
  }
});
