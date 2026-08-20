/**
 * `doctor`'s allowlist-vs-served set difference (ISC-256).
 *
 * ## The gap this closes
 *
 * `llm.models_allowlist` is the fleet's statement about which models it has
 * probed for native tool calls (SRD §5.9). Two things check it today and
 * NEITHER can see an entry that exists nowhere:
 *
 *   - ISC-52 (`assertModelAllowed`) compares a worker's RESOLVED model against
 *     the allowlist. That is config against config: an allowlist naming three
 *     models no server has ever served passes it happily, because nothing in
 *     the comparison ever talks to a server.
 *   - ISC-53 (`assertModelsSupportToolCalls`) probes only the models workers
 *     actually resolve to — deliberately, and its own docstring says so.
 *
 * So an allowlist entry the endpoint does not serve is invisible until someone
 * points a role at it and `up` dies at exit 3. This is not hypothetical:
 * measured on 2026-08-19, `fleet.example.yaml` names three models and the oMLX
 * on this host serves NONE of them.
 *
 * ## Why a unit test carries this
 *
 * The comparison is a pure set difference over data `doctor` already fetches
 * for ISC-54, so it can be checked with no server at all — which is the point.
 * `test/integration/doctor-omlx.test.ts` proves the wiring end to end through
 * the real CLI against a stub socket; this file pins the SEMANTICS of the
 * comparison itself, where the interesting mistakes live.
 */

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { allowlistVerdicts } from "../../src/cli/commands/doctor.ts";
import { assertModelAllowed, parseConfig, resolveWorker } from "../../src/config/load.ts";

/** The three ids the oMLX on this host actually served when ISC-256 was written. */
const LIVE_SERVED = [
  "Qwen3-Embedding-4B-4bit-DWQ",
  "Qwen3.5-35B-A3B-4bit",
  "gemma-4-26b-a4b-it-4bit",
];

/** The three `fleet.example.yaml` names. Not one of them is served above. */
const EXAMPLE_ALLOWLIST = [
  "Qwen3-Coder-30B-A3B-Instruct-4bit",
  "Qwen3.5-35B-A3B-8bit",
  "GLM-4.5-Air-MLX-4bit",
];

describe("every allowlist entry gets a verdict (ISC-256)", () => {
  /**
   * The criterion says "for EVERY model in `models_allowlist`". A report that
   * only listed the failures would satisfy "flags any that it does not" while
   * leaving an operator unable to tell a checked-and-fine entry from one the
   * check never reached.
   */
  test("one verdict per entry, in the order the config wrote them", () => {
    const v = allowlistVerdicts(EXAMPLE_ALLOWLIST, LIVE_SERVED, "omlx");
    expect(v).toHaveLength(EXAMPLE_ALLOWLIST.length);
    expect(v.map((x) => x.entry)).toEqual(EXAMPLE_ALLOWLIST);
  });

  test("a duplicated entry is not silently collapsed", () => {
    const v = allowlistVerdicts(["a", "a"], ["a"], "omlx");
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.served)).toBe(true);
  });

  test("an empty allowlist constrains nothing and yields nothing", () => {
    expect(allowlistVerdicts([], LIVE_SERVED, "omlx")).toEqual([]);
  });
});

describe("served and not-served are actually distinguished (ISC-256)", () => {
  test("the live finding: none of fleet.example.yaml's three are served here", () => {
    const v = allowlistVerdicts(EXAMPLE_ALLOWLIST, LIVE_SERVED, "omlx");
    expect(v.filter((x) => x.served)).toEqual([]);
    expect(v.map((x) => x.entry)).toEqual(EXAMPLE_ALLOWLIST);
  });

  /**
   * THE discriminator. A function that answered "not served" unconditionally
   * would pass the test above, so a served entry must come back true in the
   * same call that a missing one comes back false.
   */
  test("a served entry and a missing one, in one call", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-4bit", "GLM-4.5-Air-MLX-4bit"], LIVE_SERVED, "omlx");
    expect(v[0]!.served).toBe(true);
    expect(v[1]!.served).toBe(false);
  });

  /**
   * `Qwen3.5-35B-A3B-8bit` vs the served `Qwen3.5-35B-A3B-4bit` — one
   * character apart, and the exact near-miss sitting in `fleet.example.yaml`
   * today. Any prefix, substring or fuzzy comparison calls this served and
   * hides the whole defect ISC-256 exists to surface.
   */
  test("a near-miss quantisation suffix is NOT a match", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-8bit"], ["Qwen3.5-35B-A3B-4bit"], "omlx");
    expect(v[0]!.served).toBe(false);
  });

  test("neither is a shared prefix a match, in either direction", () => {
    expect(allowlistVerdicts(["Qwen3"], ["Qwen3-Coder-30B"], "omlx")[0]!.served).toBe(false);
    expect(allowlistVerdicts(["Qwen3-Coder-30B"], ["Qwen3"], "omlx")[0]!.served).toBe(false);
  });

  /**
   * The check is ONE-directional. The allowlist is a permit list, not a
   * manifest of the server's inventory, so a server offering models the
   * allowlist does not name is entirely normal and must not be flagged —
   * a symmetric difference here would fire on every healthy fleet.
   */
  test("models the server serves beyond the allowlist are not a finding", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-4bit"], LIVE_SERVED, "omlx");
    expect(v).toHaveLength(1);
    expect(v[0]!.served).toBe(true);
  });
});

describe("the comparison uses ISC-52's decomposition, not a raw string compare", () => {
  /**
   * `assertModelAllowed` compares both sides AFTER §6.1 decomposition, because
   * `provider/` and `:thinking` are flags rather than part of a model's
   * identity. This check has to agree with it: an allowlist entry written
   * `omlx/Qwen3.5-35B-A3B-4bit` is accepted by ISC-52 against a worker on
   * `Qwen3.5-35B-A3B-4bit`, so reporting it here as "not served" would have
   * `doctor` contradicting `up` about the same line of the same file.
   */
  test("a provider prefix is stripped before comparison", () => {
    const v = allowlistVerdicts(["omlx/Qwen3.5-35B-A3B-4bit"], LIVE_SERVED, "omlx");
    expect(v[0]!.served).toBe(true);
    expect(v[0]!.model).toBe("Qwen3.5-35B-A3B-4bit");
  });

  test("a thinking suffix is stripped before comparison", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-4bit:high"], LIVE_SERVED, "omlx");
    expect(v[0]!.served).toBe(true);
  });

  test("both at once", () => {
    const v = allowlistVerdicts(["omlx/Qwen3.5-35B-A3B-4bit:low"], LIVE_SERVED, "omlx");
    expect(v[0]!.served).toBe(true);
  });

  /**
   * A colon that is NOT a thinking level stays part of the id, exactly as
   * `decomposeModel` treats it — a typo must surface as "unknown model", not
   * be silently swallowed into a match.
   */
  test("a colon that is not a thinking level is kept in the id", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-4bit:nonsense"], LIVE_SERVED, "omlx");
    expect(v[0]!.served).toBe(false);
    expect(v[0]!.model).toBe("Qwen3.5-35B-A3B-4bit:nonsense");
  });

  /**
   * The verdict reports the entry AS WRITTEN alongside the decomposed id, so
   * the operator can find the offending line in their own yaml. Reporting only
   * the decomposed form would send someone looking for a string their config
   * does not contain.
   */
  test("the verdict keeps the entry as written, not only the decomposed id", () => {
    const v = allowlistVerdicts(["omlx/GLM-4.5-Air-MLX-4bit:high"], LIVE_SERVED, "omlx");
    expect(v[0]!.entry).toBe("omlx/GLM-4.5-Air-MLX-4bit:high");
    expect(v[0]!.model).toBe("GLM-4.5-Air-MLX-4bit");
    expect(v[0]!.served).toBe(false);
  });

  /**
   * BOTH sides, which for one commit was only one.
   *
   * Every test above this decorates the ALLOWLIST entry and leaves the served
   * ids bare, so all of them passed against a `new Set(served)` built from raw
   * server strings — the describe block asserted a property twice as broad as
   * anything it checked. The half it did not check is the half that MATTERS,
   * because the decoration lives on the side the SERVER controls and a real
   * server id normally carries it: `mlx-community/…` is the standard
   * MLX/HuggingFace repo-id form, and it is what the oMLX this repo develops
   * against lists. With it unhandled, `doctor` raised
   * `allowlist-model-not-served` and exited 3 over an allowlist `up` accepts.
   */
  test("a provider prefix on the SERVED id is stripped before comparison", () => {
    const v = allowlistVerdicts(
      ["Qwen3.5-35B-A3B-4bit"],
      ["mlx-community/Qwen3.5-35B-A3B-4bit"],
      "omlx",
    );
    expect(v[0]!.served).toBe(true);
  });

  test("a thinking suffix on the SERVED id is stripped before comparison", () => {
    const v = allowlistVerdicts(["Qwen3.5-35B-A3B-4bit"], ["Qwen3.5-35B-A3B-4bit:high"], "omlx");
    expect(v[0]!.served).toBe(true);
  });

  test("both at once, on the SERVED id", () => {
    const v = allowlistVerdicts(
      ["Qwen3.5-35B-A3B-4bit"],
      ["mlx-community/Qwen3.5-35B-A3B-4bit:low"],
      "omlx",
    );
    expect(v[0]!.served).toBe(true);
  });

  test("decorated on both sides at once, with different providers", () => {
    // The `provider/` prefix is a FLAG, not identity, so the config saying
    // `omlx` and the server saying `mlx-community` about one model is a match
    // — exactly as `assertModelAllowed` treats it.
    const v = allowlistVerdicts(
      ["omlx/Qwen3.5-35B-A3B-4bit:high"],
      ["mlx-community/Qwen3.5-35B-A3B-4bit"],
      "omlx",
    );
    expect(v[0]!.served).toBe(true);
  });

  /**
   * The negative control for the four above. Stripping the served side must
   * not become "strip until something matches": a near miss stays a miss even
   * when the served id is decorated, and a colon that is not a thinking level
   * stays part of the served id just as it stays part of an entry.
   */
  test("decorating the served id does not manufacture a match", () => {
    expect(
      allowlistVerdicts(["Qwen3.5-35B-A3B-8bit"], ["mlx-community/Qwen3.5-35B-A3B-4bit"], "omlx")[0]!
        .served,
    ).toBe(false);
    expect(
      allowlistVerdicts(["Qwen3.5-35B-A3B-4bit"], ["Qwen3.5-35B-A3B-4bit:nonsense"], "omlx")[0]!
        .served,
    ).toBe(false);
    // A prefix on the served side is not a licence to prefix-match either.
    expect(
      allowlistVerdicts(["Qwen3"], ["mlx-community/Qwen3-Coder-30B"], "omlx")[0]!.served,
    ).toBe(false);
  });

  /**
   * `fallbackProvider` is INERT on the served side, pinned rather than read off
   * `decomposeModel`.
   *
   * It is the CONFIG's provider, and a server-supplied id has no configured
   * provider at all — so the argument must not be allowed to influence the
   * verdict. Today it cannot: `decomposeModel` derives `model` from `raw`
   * alone and the value only ever reaches `spec.provider`, which this
   * comparison discards. The day someone makes the comparison provider-AWARE,
   * this test goes red instead of the repo-id form silently going unserved
   * again — which is precisely the case that would break, since the config
   * says `omlx` and the server says `mlx-community` about the same model.
   */
  test("the fallback provider cannot change a served-side verdict", () => {
    const served = ["mlx-community/Qwen3.5-35B-A3B-4bit", "Qwen3-Embedding-4B-4bit-DWQ"];
    const entries = ["Qwen3.5-35B-A3B-4bit", "Qwen3-Embedding-4B-4bit-DWQ", "GLM-4.5-Air-MLX-4bit"];
    const asOmlx = allowlistVerdicts(entries, served, "omlx");
    for (const provider of ["mlx-community", "vertex", "anything-at-all"]) {
      expect(allowlistVerdicts(entries, served, provider)).toEqual(asOmlx);
    }
    expect(asOmlx.map((v) => v.served)).toEqual([true, true, false]);
  });
});

/**
 * The property the decomposition exists FOR, checked against the real gate
 * rather than restated.
 *
 * Everything above pins `allowlistVerdicts` against strings this file chose.
 * That is necessary and not sufficient: the whole reason both sides are
 * decomposed is that `doctor` must not contradict `up` about one line of one
 * file, and nothing was comparing the two commands. It went wrong exactly
 * there — the served side went into the set raw while `assertModelAllowed`
 * decomposed, so `doctor` exited 3 on a fleet `up` starts.
 *
 * So this drives BOTH: `assertModelAllowed` on a worker resolved from a real
 * parsed config, and `allowlistVerdicts` on a server that lists that same
 * model, and asserts they agree. A test that agrees by construction would be
 * worthless, so the pairs below are deliberately decorated asymmetrically —
 * repo-id form on one side, bare on the other — and two of them must come back
 * REFUSED, or "they always agree" would be satisfiable by always saying no.
 */
describe("doctor's verdict agrees with up's gate on the same config (ISC-256 ↔ ISC-52)", () => {
  /** Does `up` start a worker on `workerModel` under `allowlist`? */
  async function upAccepts(allowlist: readonly string[], workerModel: string): Promise<boolean> {
    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "allowlist-agreement",
        docker: { pi_version: "0.79.6" },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "DefaultModel", models_allowlist: [...allowlist] },
        roles: { eng: { model: workerModel } },
        workers: [{ id: "w1", role: "eng" }],
      }),
      "/nonexistent/fleet.yaml",
    );
    try {
      assertModelAllowed(loaded, resolveWorker(loaded, "w1"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The model id in each row is written the SAME way in `roles.eng.model` and
   * in the served list, so the two commands are being asked the same question
   * about the same string. `expected` is what both must answer.
   */
  const ROWS: { id: string; expected: boolean; why: string }[] = [
    {
      id: "mlx-community/Qwen3.5-35B-A3B-4bit",
      expected: true,
      why: "the standard MLX/HuggingFace repo-id form — THE case that was broken",
    },
    { id: "Qwen3.5-35B-A3B-4bit:high", expected: true, why: "a thinking suffix is a flag" },
    { id: "Qwen3.5-35B-A3B-4bit", expected: true, why: "undecorated, the easy case" },
    {
      id: "Qwen3.5-35B-A3B-8bit",
      expected: false,
      why: "one character off the allowlisted model — both must still say no",
    },
    {
      id: "mlx-community/GLM-4.5-Air-MLX-4bit",
      expected: false,
      why: "a repo-id form of a model nobody allowlisted",
    },
  ];

  const ALLOWLIST = ["Qwen3.5-35B-A3B-4bit"];

  for (const { id, expected, why } of ROWS) {
    test(`${id} — ${why}`, async () => {
      const up = await upAccepts(ALLOWLIST, id);
      const doctorSaysServed = allowlistVerdicts(ALLOWLIST, [id], "omlx")[0]!.served;
      expect(
        doctorSaysServed,
        `doctor says served=${doctorSaysServed} while up ${up ? "ACCEPTS" : "REFUSES"} the same model`,
      ).toBe(up);
      expect(up).toBe(expected);
    });
  }
});
