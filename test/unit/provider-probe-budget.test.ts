/**
 * The tool-call probe's DEADLINE is per provider — ISC-419 (SRD §D16).
 *
 * ## The defect this was written against, measured rather than imagined
 *
 * `PROBE_TIMEOUT_MS = 60_000` was sized against oMLX **cold loads on the
 * operator's own hardware** and its docblock says so. Under a providers map the
 * same constant silently became the budget for a third party's largest models
 * over the public internet, and §3.1 measured that as live rather than
 * theoretical: seventeen of nineteen catalogue models answered in **≤ 4,374
 * ms**, most under 1,500 ms — then `mistral-large-3:675b` at **42,114 ms** and
 * `nemotron-3-ultra` at **56,947 ms**, the latter inside the fleet's own
 * ceiling by three seconds. A tenfold gap with nothing in between, and both
 * members of the slow group are the largest-parameter models in the catalogue,
 * so this is a property of the top of the catalogue rather than one unlucky
 * model.
 *
 * Every one of those figures is a FLOOR: taken host-side, no relay in the path,
 * no queueing. Inside a container, through the relay, on a tier permitting one
 * concurrent request (D14), both only go up — and `up` then exits non-zero with
 * a `timeout` verdict, which is a refused fleet.
 *
 * ## Why the fixture's two budgets differ from each other AND from 60000
 *
 * This is the vacuity trap for this criterion and it is worth stating, because
 * a fixture can satisfy the criterion's words and prove nothing at all.
 *
 * A fixture whose two providers carry EQUAL budgets cannot distinguish
 * per-provider resolution from a shared constant — both readings produce the
 * same two numbers. A fixture whose configured value happens to EQUAL the
 * 60_000 default cannot distinguish "resolved from the block" from "fell
 * through to the default". So the two budgets here are 9_000 and 240_000:
 * different from each other, and both different from 60_000. The third case
 * below then leaves one provider's field UNSET on purpose, so that "unset means
 * the default applies" is pinned by a fleet where 60_000 and 240_000 appear on
 * the same `up` — which no shared constant can produce.
 *
 * ## What is observed, and why it is `init.timeoutMs` rather than the signal
 *
 * `probeNativeToolCalls` puts BOTH forms of the deadline on the request — an
 * `AbortSignal.timeout(n)` and the raw number — because a containerized
 * transport cannot be handed a host-process object and reads the number
 * instead (`ProbeRequestInit`). An `AbortSignal` does not expose the interval
 * it was built from, so the number is the only one of the two a test can read,
 * and it is also the one that actually ends the request on the path `up` takes:
 * `containerFetch` spends it twice, once as the in-container signal and once as
 * `exec`'s own budget plus overhead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigValidationError, parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import { assertModelsSupportToolCalls } from "../../src/security/model-probe.ts";
import type { FetchLike, ProbeRequestInit } from "../../src/security/model-probe.ts";

/**
 * The one model id BOTH providers serve.
 *
 * Carried over from `provider-credentials.test.ts` deliberately: the gate
 * de-duplicates by the `(provider, model)` PAIR (ISC-418), and a fixture with
 * two different model ids would probe twice for a reason that has nothing to do
 * with this criterion. One id makes the two probes attributable to the
 * per-provider keying and to nothing else.
 */
const MODEL = "gpt-oss";

const LOCAL_URL = "http://omlx.pifleet.internal:8000/v1";
const CLOUD_URL = "https://ollama.com/v1";

/**
 * The three numbers, and the relationships between them are the assertion.
 *
 * `DEFAULT_BUDGET_MS` is `PROBE_TIMEOUT_MS`'s value RESTATED here rather than
 * imported, and that is the point rather than an oversight: the constant is
 * deliberately not exported (§D16 keeps ONE home for it, as
 * `probeNativeToolCalls`'s default parameter), so importing it would make this
 * suite agree with the implementation by construction. Written out, a change to
 * `model-probe.ts`'s default reddens the third case below and someone has to
 * decide whether that was intended.
 */
const LOCAL_BUDGET_MS = 9_000;
const CLOUD_BUDGET_MS = 240_000;
const DEFAULT_BUDGET_MS = 60_000;

/**
 * The anti-vacuity guard, run as a test rather than left as a comment.
 *
 * Every assertion in this file rests on these three being pairwise distinct. A
 * later edit that "tidies" the fixture to one shared number would leave every
 * case below GREEN against a fleet-wide constant, which is the exact failure
 * this suite exists to detect. Pinning the premise costs one test.
 */
describe("ISC-419 fixture premise: the three budgets are pairwise distinct", () => {
  test("neither configured budget equals the other, nor the default", () => {
    expect(LOCAL_BUDGET_MS).not.toBe(CLOUD_BUDGET_MS);
    expect(LOCAL_BUDGET_MS).not.toBe(DEFAULT_BUDGET_MS);
    expect(CLOUD_BUDGET_MS).not.toBe(DEFAULT_BUDGET_MS);
  });
});

interface ProviderOverrides {
  localBudgetMs?: number | undefined;
  cloudBudgetMs?: number | undefined;
}

/**
 * `undefined` for a budget means the KEY IS ABSENT from the document, not
 * present-and-null — `JSON`-shaped values are dropped by `yaml.stringify`, and
 * an absent key is precisely what "unset, so the default applies" has to mean.
 */
function doc(over: ProviderOverrides = {}): Record<string, unknown> {
  const local: Record<string, unknown> = {
    hosted: false,
    base_url: LOCAL_URL,
    api_key_env: "LOCAL_OMLX_KEY",
  };
  const cloud: Record<string, unknown> = {
    hosted: true,
    base_url: CLOUD_URL,
    api_key_env: "OLLAMA_CLOUD_KEY",
  };
  if (over.localBudgetMs !== undefined) local["probe_timeout_ms"] = over.localBudgetMs;
  if (over.cloudBudgetMs !== undefined) cloud["probe_timeout_ms"] = over.cloudBudgetMs;
  return {
    version: 2,
    name: "provider-probe-budget",
    docker: { pi_version: "0.79.6", network: "pifleet-budget" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: {
      model: MODEL,
      provider: "omlx",
      providers: { omlx: local, "ollama-cloud": cloud },
    },
    roles: { plain: {} },
    workers: [
      { id: "w-local", role: "plain" },
      { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}` },
    ],
    egress: { allow: [] },
  };
}

const load = (d: Record<string, unknown>): Promise<LoadedConfig> =>
  parseConfig(stringify(d), join(tmpdir(), "provider-probe-budget", "fleet.yaml"));

/** A well-formed native tool call, so every probe below SUCCEEDS and the only
 * thing under test is the deadline the request carried. */
const TOOL_CALL_BODY = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "pifleet_probe", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

interface Dial {
  provider: string;
  timeoutMs: number | undefined;
}

/**
 * A transport factory that records, per provider, the deadline the request
 * carried.
 *
 * The provider comes from the FACTORY argument rather than from the URL. Under
 * D7 each provider's probe rides its own bridge and the factory argument is the
 * only place that identity reaches the transport, so recording it there is what
 * lets a case below say "THIS provider's budget" rather than "some budget was
 * seen twice".
 */
function recordingFactory(): { fetchFor: (p: string) => FetchLike; dials: Dial[] } {
  const dials: Dial[] = [];
  const fetchFor = (provider: string): FetchLike => {
    return (async (_input: string | URL | Request, init?: ProbeRequestInit) => {
      dials.push({ provider, timeoutMs: init?.timeoutMs });
      return new Response(JSON.stringify(TOOL_CALL_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as FetchLike;
  };
  return { fetchFor, dials };
}

const HOST_ENV: Record<string, string> = {
  LOCAL_OMLX_KEY: "sentinel-local-9f2a",
  OLLAMA_CLOUD_KEY: "sentinel-cloud-4b71",
};

/** The budget each provider's probe actually carried, for one document. */
async function budgets(d: Record<string, unknown>): Promise<Map<string, number | undefined>> {
  const loaded = await load(d);
  const { fetchFor, dials } = recordingFactory();
  await assertModelsSupportToolCalls(loaded, ["w-local", "w-cloud"], fetchFor);
  // Two probes, one per provider — pinned here so a dedup regression that
  // collapsed them could not leave the map below looking correct.
  expect(dials).toHaveLength(2);
  return new Map(dials.map((dial) => [dial.provider, dial.timeoutMs]));
}

describe("ISC-419: the probe deadline resolves per provider", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(HOST_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /**
   * THE CRITERION'S OWN PROBE — "set two different budgets and assert each
   * provider's probe uses its own; a shared constant fails."
   *
   * Both halves are required and neither implies the other. The equalities say
   * each request carried the number its own block names; the final inequality
   * says the two requests DIFFERED, which is the half a shared constant cannot
   * satisfy however the constant is chosen.
   */
  test("each provider's probe carries the budget its own block names", async () => {
    const seen = await budgets(doc({ localBudgetMs: LOCAL_BUDGET_MS, cloudBudgetMs: CLOUD_BUDGET_MS }));

    expect(seen.get("omlx")).toBe(LOCAL_BUDGET_MS);
    expect(seen.get("ollama-cloud")).toBe(CLOUD_BUDGET_MS);
    expect(seen.get("omlx")).not.toBe(seen.get("ollama-cloud"));
  });

  /**
   * THE ANTI. `60_000` is a real number in this process — it is
   * `probeNativeToolCalls`'s default parameter — and a fleet-wide read is
   * exactly how it would reach a request whose block names something else.
   * Asserting its ABSENCE from both dials is what makes this case fail against
   * the pre-fix code rather than merely pass against this one.
   */
  test("the fleet-wide default reaches neither probe when both blocks name a budget", async () => {
    const seen = await budgets(doc({ localBudgetMs: LOCAL_BUDGET_MS, cloudBudgetMs: CLOUD_BUDGET_MS }));

    for (const budget of seen.values()) expect(budget).not.toBe(DEFAULT_BUDGET_MS);
  });

  /**
   * UNSET MEANS THE DEFAULT APPLIES, and this case is the one that pins the
   * §D16 seam rather than merely the criterion.
   *
   * The resolver returns `number | undefined` and the 60_000 stays in exactly
   * one place — `probeNativeToolCalls`'s default parameter. Restating it in the
   * schema as `.default(60_000)` would produce identical behaviour here and a
   * second home for the number that drifts from the first, so what is asserted
   * is the OBSERVABLE consequence: on ONE `up`, one provider gets the default
   * and the other gets its own value. A shared constant produces 60_000 twice;
   * a schema default produces the same pair as this but is refused on other
   * grounds (see §D16 and the docblock in `schema.ts`).
   */
  test("a provider with no budget gets the default while its sibling keeps its own", async () => {
    const seen = await budgets(doc({ cloudBudgetMs: CLOUD_BUDGET_MS }));

    expect(seen.get("omlx")).toBe(DEFAULT_BUDGET_MS);
    expect(seen.get("ollama-cloud")).toBe(CLOUD_BUDGET_MS);
  });

  /**
   * The flat/no-map fleet is UNCHANGED, which is D16's own justification for
   * making this provider-block-only: 60 s was sized against oMLX cold loads on
   * the operator's own hardware, so it is CORRECT there. The problem exists
   * only for a hosted provider, and a hosted provider by definition has a
   * providers map.
   *
   * This is the bound on the change rather than a restatement of it. A resolver
   * that reached for some flat spelling, or that threw on the no-map case,
   * would break every pre-D7 `fleet.yaml` — and nothing else in this file would
   * notice.
   */
  test("a fleet with no providers map still probes on the default", async () => {
    const flat = {
      version: 2,
      name: "provider-probe-budget-flat",
      docker: { pi_version: "0.79.6", network: "pifleet-budget-flat" },
      run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
      llm: { model: MODEL },
      roles: { plain: {} },
      workers: [{ id: "w-only", role: "plain" }],
      egress: { allow: [] },
    };
    const loaded = await load(flat);
    const { fetchFor, dials } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-only"], fetchFor);

    expect(dials).toHaveLength(1);
    expect(dials[0]!.timeoutMs).toBe(DEFAULT_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// The field's own shape
// ---------------------------------------------------------------------------

/**
 * The bound is not decoration. `z.number().int().positive()` alone admits both
 * ends of the range that make `up` useless in opposite directions, and both
 * ends are reachable by an operator acting reasonably:
 *
 *   - `probe_timeout_ms: 1` is not a tight budget, it is an OFF SWITCH that
 *     exits non-zero — the mandatory §5.9 gate refuses every model on that
 *     provider with a `timeout` verdict.
 *   - `probe_timeout_ms: 3600000` makes `up` look hung. The gate is sequential
 *     and mandatory, so the wait is `pairs × budget`, and the operator has no
 *     signal distinguishing it from a wedged fleet.
 *
 * Both refusals must be FIELD-LEVEL `config validate` errors naming the field,
 * on `EgressRuleSchema.port`'s precedent, rather than a throw from inside `up`.
 */
describe("ISC-419: the budget is bounded, at both ends", () => {
  const parse = (budget: number): Promise<LoadedConfig> => load(doc({ cloudBudgetMs: budget }));

  test("a sub-second budget is refused, naming the field", async () => {
    const err = await parse(999).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((err as ConfigValidationError).issues)).toContain("probe_timeout_ms");
  });

  test("a budget past the ceiling is refused, naming the field", async () => {
    const err = await parse(3_600_000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((err as ConfigValidationError).issues)).toContain("probe_timeout_ms");
  });

  /**
   * The BOUNDARIES themselves are accepted. Without this the two refusals above
   * are equally satisfied by a field that refuses everything, and a bound
   * nobody can sit on is a bound written one off.
   */
  test("both boundary values are accepted", async () => {
    await expect(parse(1_000)).resolves.toBeDefined();
    await expect(parse(300_000)).resolves.toBeDefined();
  });

  /**
   * A non-integer is refused. Milliseconds are the unit and a fractional
   * millisecond is a value the operator meant differently — `int()` here is the
   * same call `pids_limit` and `max_concurrent` already make.
   */
  test("a fractional budget is refused", async () => {
    const err = await parse(9_000.5).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
  });

  /**
   * THERE IS NO FLAT SPELLING, and this is the case that keeps §6.1 intact.
   *
   * `probe_timeout_ms` joins `hosted` and `tag_style` as a provider-block-only
   * field, so `PER_PROVIDER_FLAT_KEYS` stays at exactly four entries and the
   * both-spellings refusal is untouched. Asserted behaviourally rather than by
   * reading that array — the array is module-private, and what actually matters
   * to an operator is that `llm.probe_timeout_ms` is refused rather than
   * silently ignored, which is what `.strict()` on `LlmObject` delivers.
   */
  test("a flat llm.probe_timeout_ms is refused as an unrecognized key", async () => {
    const d = doc({ cloudBudgetMs: CLOUD_BUDGET_MS });
    (d["llm"] as Record<string, unknown>)["probe_timeout_ms"] = 30_000;
    const err = await load(d).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    // The both-spellings message (§6.1) must NOT be what fired: that message
    // would mean the key had acquired a flat spelling and a merge rule with it.
    expect(JSON.stringify((err as ConfigValidationError).issues)).not.toContain(
      "two spellings of one value",
    );
  });
});
