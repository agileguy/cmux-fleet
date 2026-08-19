/**
 * The LIVE half of the oMLX probes (ISC-53 positive, ISC-54, ISC-55).
 *
 * Everything else about these criteria is proven against stubs — deliberately,
 * because the interesting failures (a model answering a `tools` request in
 * prose; a server that is down) cannot be summoned on demand from whatever a
 * given host happens to serve. But a suite made entirely of stubs proves only
 * that this code agrees with this code's idea of oMLX. These tests close that
 * loop against a real server:
 *
 *  - ISC-53's POSITIVE case. `test/unit/model-probe.test.ts` proves the refusal
 *    against a frozen prose body, and `test/integration/up-wiring.test.ts`
 *    proves `up` refuses. Neither shows that a real model on a real oMLX
 *    actually satisfies the gate — and a gate nothing can pass is a gate that
 *    stops every run, which is a worse outage than the one it prevents.
 *  - ISC-54, "`doctor` reports the oMLX model list".
 *  - ISC-55, "`doctor` reports a MEASURED single-request latency". A stub would
 *    report a measurement of the stub. The number has to come from a real
 *    generation, because its whole purpose (§5.9 F40) is sizing
 *    `max_concurrent` against real throughput.
 *
 * ## Gating
 *
 * Opt-in via `PIFLEET_OMLX=1`, the same shape as the `PIFLEET_DOCKER=1` suites.
 * CI has no Apple-silicon inference server and never will, so the default has
 * to be skip.
 *
 * But once opted in, a missing `OMLX_API_KEY` or `PIFLEET_OMLX_MODEL` FAILS
 * rather than skips. A skip silently reachable from a half-configured
 * environment is how a criterion reports green having never executed — the
 * exact disease the container job's probe-count guard exists to catch. Asking
 * for these tests and not getting them must be loud.
 *
 * Run locally as:
 *   PIFLEET_OMLX=1 OMLX_API_KEY=… PIFLEET_OMLX_MODEL=gemma-4-26b-a4b-it-4bit \
 *     bun test test/integration/model-probe.test.ts
 *
 * ## Why every `doctor` here is given a config
 *
 * Measured on this host, and the reason this file is shaped the way it is: a
 * config-less `doctor` falls back to the first served non-embedding model,
 * which here is `Qwen3.5-35B-A3B-4bit`. Probing it forces a COLD LOAD of a 35B
 * model into a server started with `--max-model-memory 24GB`. Observed
 * consequences: the completion blew through `doctor`'s 60s timeout and came
 * back `null`, and the server SIGABRT'd and came back under a new pid — i.e.
 * the ISC-55 measurement destroyed the very thing it measures and evicted
 * whatever model the fleet had warm. See `probeModel` for the full mechanism.
 *
 * So these tests name a model, exactly as a real fleet's `fleet.yaml` does.
 * That is not the test avoiding the hard case — it is the test measuring the
 * path fleets actually take, where `llm.model` is set and `chatProbeModel`
 * returns it verbatim. The config-less fallback is a `doctor`-with-no-config
 * convenience; its SELECTION rule is asserted below against this server's real
 * model list, which costs nothing, and the cost of exercising its generation is
 * out of proportion to what it would prove. That limitation is recorded in the
 * ISA close-out rather than hidden here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatProbeModel,
  isEmbeddingModelId,
  probeNativeToolCalls,
} from "../../src/security/model-probe.ts";

const LIVE = process.env["PIFLEET_OMLX"] === "1";
if (!LIVE) {
  console.log(
    "SKIP test/integration/model-probe.test.ts: set PIFLEET_OMLX=1 (with OMLX_API_KEY and a " +
      "local oMLX on llm.base_url) to run the live model probes",
  );
}

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

/**
 * Where THE HOST reaches oMLX, stated outright rather than derived.
 *
 * This used to be described as `llm.base_url`'s default "once
 * `hostFacingBaseUrl` has rewritten the container-facing hostname". That
 * helper is deleted (ISC-260) and nothing rewrites anything any more, so this
 * is simply a host-reachable URL that this file dials directly.
 *
 * The host vantage is the RIGHT one for what this file measures, and the
 * distinction is worth being explicit about now that the two have come apart.
 * These probes ask a question about a MODEL — does a real chat model on real
 * hardware emit a native tool call — and the answer is a property of the
 * model's chat template, not of the network path used to ask. WHERE the
 * production gate asks from is a separate claim; it is what ISC-260 is about,
 * and it is proven separately in `test/integration/probe-in-network.test.ts`
 * against a real Docker network.
 */
const BASE_URL = process.env["PIFLEET_OMLX_BASE_URL"] ?? "http://localhost:8000/v1";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * Read the key, or fail with the reason. Not `?? ""` — an empty key produces a
 * 401 that this module classifies `unreachable`, and the test would then report
 * "oMLX is down" about a server that is running perfectly well.
 */
function apiKey(): string {
  const key = process.env["OMLX_API_KEY"] ?? "";
  if (key === "") {
    throw new Error(
      "PIFLEET_OMLX=1 was set but OMLX_API_KEY is empty — these tests would report a live " +
        "server as unreachable. Export the key or unset PIFLEET_OMLX.",
    );
  }
  return key;
}

/** The models this server is serving right now. */
async function servedModels(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${BASE_URL}/models → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
}

/**
 * The model these tests generate against. NAMED EXPLICITLY, never inferred.
 *
 * This function used to fall back to `chatProbeModel(null, served)` — the same
 * rule config-less `doctor` uses — so the suite could run unattended. That
 * fallback aborted this host's inference server twice on 2026-08-19, and the
 * mechanism is worth writing down because it is not obvious:
 *
 *   `chatProbeModel` picks the first served NON-embedding model, which here is
 *   `Qwen3.5-35B-A3B-4bit`. oMLX runs with `--max-model-memory 24GB` and logged
 *   `Loading Qwen3.5-35B-A3B-4bit without KV headroom (need 24.93GB, available
 *   24.00GB)` — it loaded the weights with nothing left for the KV cache.
 *   Generating into that produced a Metal command-buffer error inside a
 *   completion handler (`mlx::core::gpu::check_error`), which is an uncaught
 *   C++ exception on a thread with no handler: `std::terminate`, SIGABRT,
 *   server gone. Three crashes that day, each immediately preceded by that same
 *   log line.
 *
 * A TEST SUITE MUST NOT PICK ITS OWN GPU WORKLOAD. The set of models a server
 * lists is not the set it can safely load, oMLX exposes no memory metadata that
 * would tell them apart, and the failure is not a failed request — it is the
 * server dying and taking every other tenant's warm model with it. So the model
 * is an explicit act by whoever runs the suite, and an unset variable fails
 * loudly rather than guessing.
 *
 * Note what this does NOT cost. ISC-53's actual criterion — the REFUSAL of a
 * prose-answering model — needs no live model at all; it is proven
 * deterministically against stubs in `test/unit/model-probe.test.ts` and
 * `test/integration/up-wiring.test.ts`. The only thing that genuinely needs a
 * live generation is the positive control, and a small warm model serves that
 * exactly as well as a large cold one.
 */
async function probeModel(served: string[]): Promise<string> {
  const named = process.env["PIFLEET_OMLX_MODEL"] ?? "";
  if (named === "") {
    throw new Error(
      "PIFLEET_OMLX=1 requires PIFLEET_OMLX_MODEL naming the model to generate against. It is " +
        "deliberately not inferred: auto-selecting the first served chat model cold-loaded a " +
        "35B model into a 24GB cap and SIGABRT'd this host's oMLX (see the comment on " +
        `probeModel). Served here: ${served.join(", ")}`,
    );
  }
  if (!served.includes(named)) {
    throw new Error(`PIFLEET_OMLX_MODEL="${named}" is not served; available: ${served.join(", ")}`);
  }
  return named;
}

/** A minimal valid fleet.yaml whose only job is to name `llm.model`. */
async function configNaming(model: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-omlx-live-"));
  bases.push(base);
  const path = join(base, "fleet.yaml");
  await writeFile(
    path,
    [
      "version: 2",
      "name: omlx-live",
      "docker:",
      '  pi_version: "0.79.6"',
      "run:",
      `  repo: ${base}`,
      "  budget:",
      "    tokens_ceiling: 1000000",
      "llm:",
      `  model: ${model}`,
      `  base_url: ${BASE_URL}`,
      "roles:",
      "  engineer: {}",
      "workers:",
      "  - {id: eng-1, role: engineer}",
      "",
    ].join("\n"),
  );
  return path;
}

/**
 * `doctor --json`, as a real subprocess.
 *
 * Both criteria are statements about what `doctor` REPORTS, so calling
 * `probeOmlx` directly would prove the probe works and leave the reporting —
 * the part an operator consumes — untested.
 *
 * The exit code is deliberately NOT asserted. `doctor` exits nonzero when any
 * diagnosis is present, and a developer machine legitimately carries unrelated
 * ones (no cmux, a stopped daemon, a missing image). Those say nothing about
 * oMLX, and the JSON is printed before the failing exit is thrown, so stdout is
 * authoritative either way. Requiring a clean bill of health for the whole host
 * would make Group E fail for reasons outside Group E.
 */
async function doctorOmlx(configPath: string): Promise<{
  ok: boolean;
  base_url: string;
  models: string[];
  list_latency_ms: number | null;
  completion_latency_ms: number | null;
  probe_model: string | null;
  detail: string;
}> {
  const p = Bun.spawn([process.execPath, CLI, "doctor", "--json", "-c", configPath], {
    env: { ...process.env, OMLX_API_KEY: apiKey() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`doctor --json emitted no JSON object:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  return parsed["omlx"] as Awaited<ReturnType<typeof doctorOmlx>>;
}

const it = test.skipIf(!LIVE);

describe("the native-tool-call probe against a real oMLX model (ISC-53, positive)", () => {
  /**
   * The gate must be PASSABLE. Every other ISC-53 test asserts a refusal, and a
   * suite of refusals is equally satisfied by a gate wired to `return false` —
   * which would refuse every fleet on every host, permanently.
   */
  it(
    "a served chat model answers the tools-bearing probe with a native call",
    async () => {
      const served = await servedModels();
      expect(served.length).toBeGreaterThan(0);
      const model = await probeModel(served);
      // The selection must not have handed us an embedding model to chat with.
      expect(isEmbeddingModelId(model)).toBe(false);

      // `fetch` passed EXPLICITLY: `probeNativeToolCalls` no longer defaults
      // it, so that a host-side probe can never be one omitted argument away
      // in production (ISC-260). Here the host vantage is the intended one —
      // see BASE_URL.
      const result = await probeNativeToolCalls(BASE_URL, apiKey(), model, fetch);

      // Reported before asserting: when a model IS incompatible this line is
      // the evidence, and a bare `expect(...).toBe(true)` would discard it.
      console.log(`  ISC-53 live: ${model} → ok=${result.ok} (${result.detail})`);

      expect(result.failure).not.toBe("unreachable");
      expect(result.failure).not.toBe("malformed");
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("native tool_call");
    },
    180_000,
  );
});

describe("doctor reports the live oMLX surface (ISC-54, ISC-55)", () => {
  it(
    "the model list doctor prints is the list the server is serving (ISC-54)",
    async () => {
      const served = await servedModels();
      const omlx = await doctorOmlx(await configNaming(await probeModel(served)));
      console.log(`  ISC-54 live: doctor reported ${omlx.models.length} models — ${omlx.models.join(", ")}`);

      expect(omlx.ok).toBe(true);
      expect(omlx.models.length).toBeGreaterThan(0);
      /**
       * Set-equal to what the server independently reported, not merely
       * "non-empty". A hardcoded list, a stale cache, or a report of the
       * CONFIGURED model rather than the served ones would all satisfy
       * non-emptiness, and none of them is "reports the oMLX model list".
       */
      expect([...omlx.models].sort()).toEqual([...served].sort());
      /**
       * There used to be a `toBeGreaterThanOrEqual(1)` here, claiming to show
       * the list was not an echo of the config. It showed nothing: it is
       * strictly weaker than the `toBeGreaterThan(0)` three lines up, and the
       * set-equality above already carries the entire claim — a list equal to
       * what an independent `GET /v1/models` returned cannot be a reflection of
       * `llm.model`, a hardcoded array, or a stale cache. An assertion that
       * cannot fail when its stated claim is false is worse than no assertion,
       * because it reads like coverage.
       *
       * The stub-backed sibling in `doctor-omlx.test.ts` makes the same point
       * deterministically, by serving ids no fleet.yaml in that file names.
       */
    },
    180_000,
  );

  it(
    "the completion latency doctor prints is a real measured number (ISC-55)",
    async () => {
      const served = await servedModels();
      const model = await probeModel(served);
      const omlx = await doctorOmlx(await configNaming(model));
      console.log(
        `  ISC-55 live: /models ${omlx.list_latency_ms}ms, 1-token completion ` +
          `${omlx.completion_latency_ms}ms against ${omlx.probe_model}`,
      );

      // The number the criterion names.
      expect(omlx.completion_latency_ms).not.toBeNull();
      expect(Number.isFinite(omlx.completion_latency_ms)).toBe(true);
      expect(omlx.completion_latency_ms!).toBeGreaterThan(0);

      // MEASURED, not stamped in: a real round trip to a real generation cannot
      // be instantaneous, and a plausible ceiling catches a value that is
      // secretly a timeout or a millisecond clock read twice.
      expect(omlx.completion_latency_ms!).toBeLessThan(120_000);

      // …and it was measured against the model the config named, which is what
      // makes the number relevant to sizing THIS fleet's `max_concurrent`.
      expect(omlx.probe_model).toBe(model);
      expect(omlx.models).toContain(model);

      // The list probe is a separate measurement and must also be real.
      expect(omlx.list_latency_ms).not.toBeNull();
      expect(omlx.list_latency_ms!).toBeGreaterThanOrEqual(0);
    },
    180_000,
  );

  /**
   * The ISC-55 selection rule, against whatever this server really serves.
   *
   * The defect: `doctor` with no config used to take `models[0]`, and on a host
   * whose list begins with an embedding model that completion returns HTTP 500
   * — so `completion_latency_ms` came back `null` and ISC-55 went unreported on
   * precisely the invocation someone runs when they have no config yet.
   *
   * The assertion is deliberately about the RULE, not about any server's
   * ordering. An earlier version of this test asserted `served[0]` IS an
   * embedding model, which encoded one machine's `GET /v1/models` order as a
   * fact about the world; it passed against the local server and failed against
   * the remote one, where `GLM-4.5-Air-MLX-4bit` sorts first. A test that only
   * holds on the author's laptop is not evidence for a criterion.
   *
   * Only the SELECTION is exercised, never a generation against the model it
   * rejected: see the file header and `probeModel` for why forcing that load is
   * a cure worse than the disease.
   */
  it("the no-config fallback never picks an embedding model to chat with", async () => {
    const served = await servedModels();
    const chosen = chatProbeModel(null, served);
    expect(chosen).not.toBeNull();
    expect(served).toContain(chosen!);
    // The rule itself, which holds regardless of what this server serves.
    expect(isEmbeddingModelId(chosen!)).toBe(false);

    const embeddings = served.filter((id) => isEmbeddingModelId(id));
    if (embeddings.length === 0) {
      console.log("  (no embedding model served here; only the rule could be checked)");
      return;
    }
    console.log(`  ISC-55 selection: skipped ${embeddings.length} embedding model(s), chose ${chosen}`);
    // Every embedding model on this server was passed over…
    for (const e of embeddings) expect(chosen).not.toBe(e);
    // …and where the list actually BEGINS with one, the naive `models[0]` this
    // replaced would have picked it. That is the live form of the defect, and
    // it is asserted only when the server's order makes it reachable.
    if (isEmbeddingModelId(served[0]!)) expect(chosen).not.toBe(served[0]!);
  }, 60_000);
});
