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
import { loadConfig } from "../../src/config/load.ts";
import { cliBudget } from "../support/budget.ts";
import {
  chatProbeModel,
  DOCKER_HOST_LOOPBACK,
  hostReachableBaseUrl,
  isEmbeddingModelId,
  probeNativeToolCalls,
} from "../../src/security/model-probe.ts";

/**
 * The loopback address the ISC-291 stubs bind, imported rather than spelled.
 *
 * The constant is the product's own answer to "where is the Docker host, asked
 * from the Docker host". A test that re-typed the literal could agree with
 * itself while disagreeing with the code it is grading.
 */
const DIAL_LOOPBACK = DOCKER_HOST_LOOPBACK;

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
      /*
       * Ceiling audit (ISC-274). `cliBudget(1) = 11_400 ms` is the derived
       * budget for this test's one CLI spawn, and it does NOT govern here:
       * the spawn is the cheap half. `doctor` blocks on a LIVE completion from
       * the oMLX server, and a cold model load there is measured in minutes on
       * a first request — a cost paid by the model server, not by process
       * startup, so the number `cliBudget` derives is unrelated to what bounds
       * this test. 180_000 is the value all four probes in this file converged
       * on; it is recorded as an inheritance from them, not as a measurement.
       */
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
      /*
       * Ceiling audit (ISC-274). `cliBudget(1) = 11_400 ms` is the derived
       * budget for this test's one CLI spawn, and it does NOT govern here:
       * the spawn is the cheap half. `doctor` blocks on a LIVE completion from
       * the oMLX server, and a cold model load there is measured in minutes on
       * a first request — a cost paid by the model server, not by process
       * startup, so the number `cliBudget` derives is unrelated to what bounds
       * this test. 180_000 is the value all four probes in this file converged
       * on; it is recorded as an inheritance from them, not as a measurement.
       */
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

// ---------------------------------------------------------------------------
// ISC-291 — where the HOST reaches the model server
// ---------------------------------------------------------------------------

/**
 * DELIBERATELY UNGATED. These use `test`, not the `it = test.skipIf(!LIVE)`
 * above, and the distinction is the whole point of the section.
 *
 * Everything before this line needs a real inference server and skips without
 * one. ISC-291 is not a claim about a model — it is a claim about WHICH
 * ADDRESS a host-vantage probe dials, and that is settled by any HTTP server
 * that answers. So these stand one up themselves and run everywhere, which is
 * what lets the criterion close on reproducible evidence rather than on the
 * maintainer's machine. Do not move them under `it`.
 *
 * ## Why an EPHEMERAL port is load-bearing, not incidental
 *
 * `port: 0` makes the OS choose, so the number is different on every run and
 * cannot exist anywhere in the source. A probe that reached a stub on a FIXED
 * port would be equally consistent with a hardcoded dial target — it would
 * pass just as well if the code ignored the config entirely. Only a port that
 * did not exist until this process started proves the target was READ FROM
 * CONFIG. That is strictly stronger evidence than hitting a real server on a
 * known port, which is why this is the closing evidence and not a placeholder
 * for it.
 *
 * ## What is NOT claimed
 *
 * That a real inference server answers. Nothing here dials one, and no test in
 * this section touches the Docker host's own instance — every dial goes to a
 * stub this file created moments earlier on a port the OS just handed out. The
 * live half belongs to ISC-258/262.
 */

/**
 * The ceiling for a test that DIALS the stub below (ISC-266's class, inverted).
 *
 * `probeNativeToolCalls` is handed a 10_000 ms deadline by these tests, and
 * those tests carried bun's default 5000 ms per-test budget — so the probe's
 * own timeout could never fire. A hung stub died as a BUN TIMEOUT: the wrong
 * layer, five seconds early, reporting "test timed out" about a probe that has
 * a precise, well-worded answer for exactly that situation ("did not answer
 * within 10000ms … oMLX may be COLD-LOADING"). That is the inverse of ISC-266
 * — not a budget too small for the work, but a budget too small for the
 * DEADLINE the work is under — and it is the same defect: a number with no
 * relationship to what the test does.
 *
 * DERIVED, not chosen. The probe deadline is the floor and it must be allowed
 * to expire, so 10_000 is spent before this test's own work begins. The work
 * itself is one `Bun.serve`, one `loadConfig` off a freshly-written file and
 * one loopback round trip — measured at 39, 41 and 45 ms across three runs, so
 * ~45 ms, and `budget.ts`'s own CONTENTION (3) x SAFETY (2) puts that at 270 ms
 * on a contended box.
 *
 * 10_000 + 270 = 10_270, rounded up to 20_000. The rounding is deliberate
 * headroom on the FLOOR rather than on the work: a probe deadline that fires
 * at 10 s needs its rejection handled and asserted afterwards, and a ceiling
 * sitting 270 ms above the floor would turn any delay in that handling back
 * into a bun timeout — reintroducing the defect at a different scale. It stays
 * BOUNDED: a genuinely hung stub still fails, at 20 s.
 *
 * Not `cliBudget(n)`: nothing here spawns a subprocess, and borrowing that
 * helper's per-spawn constant would encode a lie as arithmetic — the same
 * argument `containerBudget` makes for not borrowing it either.
 */
const STUB_PROBE_BUDGET_MS = 20_000;

/** An oMLX-shaped stub that answers the tools-bearing probe with a NATIVE call. */
function stubToolCallServer(): {
  port: number;
  urls: string[];
  stop: () => Promise<void>;
} {
  const urls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: DIAL_LOOPBACK,
    fetch(req) {
      urls.push(req.url);
      return Response.json({
        id: "chatcmpl-isc291-stub",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: { name: "pifleet_probe", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    },
  });
  // `Bun.serve().port` is `number | undefined` in the types — undefined only for
  // a unix-socket server, which this is not. Asserted rather than cast, so a
  // stub that somehow bound no port fails here instead of producing a dial
  // target reading `…:undefined/v1` that every assertion below would misreport.
  const port = server.port;
  if (port === undefined) throw new Error("the ISC-291 stub bound no TCP port");
  return {
    port,
    urls,
    /**
     * `await`ed, because `serve.d.ts` declares `stop()` as `Promise<void>` and
     * a discarded promise here is a listener that may still hold its port when
     * the next test binds one. These stubs bind port 0 so a collision is
     * unlikely rather than impossible — and "unlikely" is what an intermittent
     * failure is made of. Closing before returning costs nothing.
     */
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * A fleet.yaml naming `base_url`, and `relay_upstream` only when asked for.
 *
 * Written to disk and pushed through the REAL `loadConfig` rather than
 * hand-building a config object, because half of what ISC-291 rests on is the
 * SCHEMA's documented default — `relay_upstream: null` meaning
 * `host.docker.internal:<port from base_url>`. A hand-built object would let
 * this file assert that default against its own restatement of it, which is
 * the circularity ISC-253 is the standing example of.
 */
async function configWith(baseUrl: string, relayUpstream?: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-isc291-"));
  bases.push(base);
  const path = join(base, "fleet.yaml");
  await writeFile(
    path,
    [
      "version: 2",
      "name: isc291",
      "docker:",
      '  pi_version: "0.79.6"',
      "run:",
      `  repo: ${base}`,
      "  budget:",
      "    tokens_ceiling: 1000000",
      "llm:",
      "  model: stub-model",
      // QUOTED. An unquoted scalar ends at an unescaped `#`, so a base_url
      // carrying a fragment would have been silently truncated by the YAML
      // parser and the fragment cases below would have graded a URL that never
      // had one.
      `  base_url: "${baseUrl}"`,
      ...(relayUpstream === undefined ? [] : [`  relay_upstream: "${relayUpstream}"`]),
      "roles:",
      "  engineer: {}",
      "workers:",
      "  - {id: eng-1, role: engineer}",
      "",
    ].join("\n"),
  );
  return path;
}

describe("the host-side probe dials a host-reachable endpoint (ISC-291)", () => {
  test("an explicit relay_upstream IS the host's dial target, and the probe reaches it", async () => {
    const stub = stubToolCallServer();
    try {
      /**
       * The worker-facing URL names the bridge alias on a port NOTHING is
       * listening on, exactly as a real `fleet.yaml` does. If the derivation
       * returned `base_url` — or ignored `relay_upstream` — the probe would
       * dial a name this host cannot resolve and the assertions below would
       * fail on an unreachable endpoint rather than pass on a stub.
       */
      const loaded = await loadConfig(
        await configWith("http://host.docker.internal:8000/v1", `${DIAL_LOOPBACK}:${stub.port}`),
      );

      const target = hostReachableBaseUrl(loaded.config);
      expect(target).toBe(`http://${DIAL_LOOPBACK}:${stub.port}/v1`);

      const result = await probeNativeToolCalls(target, "", "stub-model", fetch, 10_000);
      expect(result.ok).toBe(true);
      expect(result.failure).toBeNull();

      // The stub actually SAW it. Without this, a probe that somehow reported
      // ok having sent nothing would pass every assertion above.
      expect(stub.urls).toEqual([`http://${DIAL_LOOPBACK}:${stub.port}/v1/chat/completions`]);

      /**
       * THE FIELDS ARE NOT COLLAPSED (ISC-253). Deriving a host target must
       * not disturb what a worker dials; `base_url` is still the bridge alias,
       * byte for byte, and the two values are still different strings.
       */
      expect(loaded.config.llm.base_url).toBe("http://host.docker.internal:8000/v1");
      expect(loaded.config.llm.relay_upstream).toBe(`${DIAL_LOOPBACK}:${stub.port}`);
      expect(target).not.toBe(loaded.config.llm.base_url);
    } finally {
      await stub.stop();
    }
  }, STUB_PROBE_BUDGET_MS);

  test("with relay_upstream null the host dials the Docker host's loopback, not the bridge alias", async () => {
    const stub = stubToolCallServer();
    try {
      /**
       * The SHIPPED DEFAULT's shape: `relay_upstream` is omitted entirely, so
       * the schema's own `null` default applies and the derivation has to fall
       * back to "`host.docker.internal:<port from base_url>`, evaluated from
       * the Docker host". Only the PORT differs from the shipped literal, and
       * only because this test binds its own server rather than dialing the
       * machine's real inference port — which it must never do. The host
       * component under test is the shipped one, unchanged.
       */
      const loaded = await loadConfig(
        await configWith(`http://host.docker.internal:${stub.port}/v1`),
      );
      expect(loaded.config.llm.relay_upstream).toBeNull();

      const target = hostReachableBaseUrl(loaded.config);

      // The alias is GONE from the dial target — the defect, stated directly.
      expect(target).not.toContain("host.docker.internal");
      // And the port travelled with it, which is what makes this a derivation
      // from config rather than a constant.
      expect(target).toBe(`http://${DIAL_LOOPBACK}:${stub.port}/v1`);

      const result = await probeNativeToolCalls(target, "", "stub-model", fetch, 10_000);
      expect(result.ok).toBe(true);
      expect(stub.urls).toEqual([`http://${DIAL_LOOPBACK}:${stub.port}/v1/chat/completions`]);

      // Still not collapsed: the worker's URL keeps naming the bridge alias.
      expect(loaded.config.llm.base_url).toContain("host.docker.internal");
    } finally {
      await stub.stop();
    }
  }, STUB_PROBE_BUDGET_MS);

  /**
   * The guard that stops this becoming `hostFacingBaseUrl` again.
   *
   * The deleted helper rewrote ANY host to localhost, so a fleet pointed at a
   * LAN server had its health silently measured on the wrong box. That is not
   * hypothetical here: SRD §5.9 records the Docker host's own instance serving
   * NONE of `fleet.example.yaml`'s allowlisted models while the LAN peer serves
   * all three, so a loopback rewrite would grade a server the fleet never uses.
   *
   * The address below is a STRING under assertion and is never dialed.
   */
  test("a configured address that is not the bridge alias is returned untouched", async () => {
    const lan = "http://192.168.86.49:8000/v1";
    const loaded = await loadConfig(await configWith(lan));
    expect(hostReachableBaseUrl(loaded.config)).toBe(lan);
  });

  /**
   * The shipped default, asserted as a STRING and deliberately not dialed.
   *
   * This is the case ISC-291 was filed over — a default `fleet.yaml` on a
   * machine whose model server is on the Docker host — and it is the one case
   * this suite must not execute, because dialing it would send a request to
   * the real local inference port. Computing the target proves the derivation;
   * sending nothing keeps the prohibition. The port here is the schema's, not
   * a chosen one.
   */
  test("the shipped default derives to the Docker host's loopback at base_url's port", async () => {
    const loaded = await loadConfig(await configWith("http://host.docker.internal:8000/v1"));
    expect(hostReachableBaseUrl(loaded.config)).toBe(`http://${DIAL_LOOPBACK}:8000/v1`);
  });
});

/**
 * What the derivation must CARRY, not merely what it must change (ISC-291).
 *
 * The four tests above all use credential-free, query-free, fragment-free URLs
 * — exactly the shape that cannot tell a correct recomposition from a lossy
 * one. `compose` rebuilds the URL from parts rather than assigning
 * `url.hostname` (that setter fails silently on a bare IPv6 literal), and
 * rebuilding from parts means every part you forget to name is a part that
 * vanishes. Two were forgotten: userinfo and the fragment.
 *
 * The userinfo case is the one that costs something. `http://key@omlx:8000/v1`
 * derived to `http://127.0.0.1:8000/v1`, silently unauthenticated, so a probe
 * against a server requiring Basic auth reported its 401 as the endpoint's
 * health — a confident wrong answer of exactly the kind `hostReachableBaseUrl`
 * exists to remove.
 *
 * These are STRING assertions. Nothing here is dialed, so no fixture has to
 * stand up a server that demands a credential to prove the credential survived.
 */
describe("the host dial target carries every part of base_url (ISC-291)", () => {
  test("userinfo survives the substitution", async () => {
    const loaded = await loadConfig(
      await configWith("http://probe-key@host.docker.internal:8000/v1"),
    );
    // The credential is still there, attached to the NEW authority.
    expect(hostReachableBaseUrl(loaded.config)).toBe(`http://probe-key@${DIAL_LOOPBACK}:8000/v1`);
  });

  test("a user:password pair survives, and an empty password is not invented", async () => {
    const withPass = await loadConfig(
      await configWith("http://user:s3cret@host.docker.internal:8000/v1"),
    );
    expect(hostReachableBaseUrl(withPass.config)).toBe(
      `http://user:s3cret@${DIAL_LOOPBACK}:8000/v1`,
    );
    // `user@` and `user:@` are different authorities; echoing a colon the input
    // did not carry would be its own quiet rewrite.
    const noPass = await loadConfig(await configWith("http://user@host.docker.internal:8000/v1"));
    expect(hostReachableBaseUrl(noPass.config)).toBe(`http://user@${DIAL_LOOPBACK}:8000/v1`);
  });

  test("a fragment survives", async () => {
    const loaded = await loadConfig(await configWith("http://host.docker.internal:8000/v1#tenant-a"));
    expect(hostReachableBaseUrl(loaded.config)).toBe(`http://${DIAL_LOOPBACK}:8000/v1#tenant-a`);
  });

  test("a query survives, and does not smuggle a slash into a path that had none", async () => {
    // A path AND a query: the ordinary case, and the one the old heuristic got
    // right by luck.
    const withPath = await loadConfig(
      await configWith("http://host.docker.internal:8000/v1?tenant=a"),
    );
    expect(hostReachableBaseUrl(withPath.config)).toBe(`http://${DIAL_LOOPBACK}:8000/v1?tenant=a`);

    /**
     * THE BUG. `URL` normalizes an absent path to `/`, and the old check read
     * the last byte of the whole composed string against the last byte of the
     * whole original — so with a query present it inspected the QUERY. Neither
     * string ended in `/`, nothing was stripped, and a slash appeared in a
     * base URL that never had one. Every caller builds `${baseUrl}/models` by
     * concatenation, so that slash becomes a `//models` request.
     */
    const noPath = await loadConfig(await configWith("http://host.docker.internal:8000?tenant=a"));
    const derived = hostReachableBaseUrl(noPath.config);
    expect(derived).toBe(`http://${DIAL_LOOPBACK}:8000?tenant=a`);
    expect(`${derived}/models`).not.toContain("//models");
  });

  test("an explicit trailing slash is kept, because the operator wrote it", async () => {
    // The other direction, and what stops the fix becoming "strip every
    // trailing slash": `/v1/` and `/v1` are different paths on some servers,
    // and this function's contract is to change the authority and NOTHING else.
    const loaded = await loadConfig(await configWith("http://host.docker.internal:8000/v1/"));
    expect(hostReachableBaseUrl(loaded.config)).toBe(`http://${DIAL_LOOPBACK}:8000/v1/`);
  });

  test("every part survives at once, through an explicit relay_upstream", async () => {
    /**
     * The combined shape, through the OTHER derivation branch — `relay_upstream`
     * set — so neither path can pass by handling one part each.
     */
    const loaded = await loadConfig(
      await configWith("http://key:pw@host.docker.internal:8000/v1?tenant=a#frag", "10.1.2.3:9000"),
    );
    expect(hostReachableBaseUrl(loaded.config)).toBe("http://key:pw@10.1.2.3:9000/v1?tenant=a#frag");
  });
});

/**
 * `llm.base_url` is DIALED, so its scheme is a security decision.
 *
 * `z.string().url()` is a well-formedness check and accepts every scheme the
 * WHATWG parser knows — `file:`, `ftp:`, `gopher:`, `data:`. `doctor` fetches
 * this value from the host with the operator's API key attached, and
 * `hostReachableBaseUrl` derives a dial target from it, so a non-HTTP scheme
 * here is not a stored string; it is a request this process would issue.
 *
 * Refused at the SCHEMA, which is why this asserts on `loadConfig` rather than
 * on a probe: a `config validate` failure names the field and the file, while a
 * refusal inside a probe arrives after `up` has built a bridge and teaches
 * nothing about why.
 */
describe("base_url must be http or https", () => {
  /**
   * REJECTION IS THE FIRST ASSERTION, and it is separate on purpose. Reading
   * the message off a resolved config stringifies to `[object Object]` and the
   * failure then reads as a wording problem rather than as "the schema accepted
   * `file:`" — measured, while mutating this guard.
   */
  const refusal = async (url: string): Promise<string> => {
    const outcome = await loadConfig(await configWith(url)).then(
      () => null,
      (e: unknown) => e,
    );
    if (outcome === null) throw new Error(`loadConfig ACCEPTED a ${url} base_url`);
    return String(outcome);
  };

  test("file: is refused, and the message says why the scheme matters", async () => {
    const message = await refusal("file:///etc/passwd");
    expect(message).toContain("base_url");
    expect(message).toContain("http: or https:");
  });

  test("ftp: and gopher: are refused too — the allowlist is not a file: blocklist", async () => {
    for (const url of ["ftp://example.test/v1", "gopher://example.test/v1"]) {
      expect(await refusal(url)).toContain("http: or https:");
    }
  });

  test("https: is accepted, so the allowlist is not just 'http'", async () => {
    const loaded = await loadConfig(await configWith("https://models.example.test:8443/v1"));
    expect(loaded.config.llm.base_url).toBe("https://models.example.test:8443/v1");
    // Not the bridge alias, so it is returned untouched — and still https.
    expect(hostReachableBaseUrl(loaded.config)).toBe("https://models.example.test:8443/v1");
  });
});

/**
 * A credentialed probe must not follow a redirect (G5).
 *
 * `doctor` attaches `Authorization: Bearer <the operator's model API key>` to
 * both of its probes, and `fetch` defaults to `redirect: "follow"`. Under that
 * default a 302 from the configured endpoint sends the request onward to
 * whatever host `Location:` names, and the redirect target's answer is then
 * reported as the health of the fleet's model server.
 *
 * ## What this does and does NOT claim about the key
 *
 * It does NOT claim the API key reaches the redirect target on this runtime.
 * Probed directly on bun 1.3.11: a same-origin redirect carries
 * `Authorization` through, a CROSS-origin one arrives with
 * `authorization: null`. The runtime strips it on exactly the hop that would
 * leak it, so this fixture's sink would see `null` even with the fix reverted —
 * which is why the assertion below is that the sink was NEVER CALLED, not that
 * it saw no header. A test asserting the weaker thing would pass against the
 * defect.
 *
 * What it does claim is the defect that survives that stripping: `doctor`
 * DIALED a host nobody configured and would have reported its answer — model
 * list, allowlist verdicts, latency — as the configured endpoint's health. The
 * credential half of the argument rests on a fetch-specification behaviour this
 * repo neither owns nor asserts, and not following the redirect removes that
 * dependency rather than trusting it. See `NO_REDIRECT` in `doctor.ts`.
 *
 * ## Why this became reachable only recently
 *
 * `doctor` used to dial `host.docker.internal`, a bridge alias that resolves
 * nowhere on the host, so the request failed by construction and there was no
 * response to redirect. ISC-291 made the target a real, operator-supplied
 * address reached from the host, which is the point of that change and also
 * what put a credentialed request on the wire for the first time.
 *
 * ## What the fixture is
 *
 * TWO stubs. The redirector answers every request `302` with `Location:` on the
 * sink; the sink records what reaches it. `relay_upstream` points the host dial
 * target at the redirector, so `doctor` follows exactly the path a real config
 * would. The load-bearing claim is a NEGATIVE, which is why the sink counts
 * requests rather than the test merely asserting on `doctor`'s output.
 *
 * Neither stub is oMLX and neither is on the local inference port: both bind
 * port 0 on loopback, exactly like the ISC-291 stubs above.
 */
describe("doctor never forwards the API key to a redirect target (G5)", () => {
  test(
    "a 302 is reported, not followed, and the sink sees nothing",
    async () => {
      const sinkAuth: Array<string | null> = [];
      const sink = Bun.serve({
        port: 0,
        hostname: DIAL_LOOPBACK,
        fetch(req) {
          sinkAuth.push(req.headers.get("authorization"));
          return Response.json({ data: [{ id: "attacker-model" }] });
        },
      });
      const sinkPort = sink.port;
      if (sinkPort === undefined) throw new Error("the redirect sink bound no TCP port");

      const redirects: string[] = [];
      const redirector = Bun.serve({
        port: 0,
        hostname: DIAL_LOOPBACK,
        fetch(req) {
          redirects.push(req.url);
          return new Response(null, {
            status: 302,
            headers: { Location: `http://${DIAL_LOOPBACK}:${sinkPort}/v1/models` },
          });
        },
      });
      const redirectPort = redirector.port;
      if (redirectPort === undefined) throw new Error("the redirector bound no TCP port");

      try {
        const configPath = await configWith(
          "http://host.docker.internal:8000/v1",
          `${DIAL_LOOPBACK}:${redirectPort}`,
        );
        const p = Bun.spawn([process.execPath, CLI, "doctor", "--json", "-c", configPath], {
          // A DISTINCTIVE key: if a future runtime DOES carry the header across
          // origins, the sink records something unmistakable rather than a
          // plausible-looking blank.
          env: { ...process.env, OMLX_API_KEY: "pifleet-redirect-canary-key" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        const start = stdout.indexOf("{");
        if (start < 0) throw new Error(`doctor --json emitted no JSON object:\n${stdout}`);
        const omlx = (JSON.parse(stdout.slice(start)) as Record<string, unknown>)["omlx"] as {
          ok: boolean;
          base_url: string;
          detail: string;
        };

        // The probe really ran, against the redirector — without this, a
        // `doctor` that failed to resolve anything would satisfy the negative
        // below for the wrong reason.
        expect(redirects.length).toBeGreaterThan(0);
        expect(omlx.base_url).toBe(`http://${DIAL_LOOPBACK}:${redirectPort}/v1`);

        // THE CLAIM: nothing reached the redirect target AT ALL. Asserted as an
        // empty CALL LIST rather than as an absent header, because bun strips
        // `Authorization` cross-origin anyway (measured; see this block's
        // docstring) — so a header-only assertion would pass against the very
        // defect under test.
        expect(sinkAuth).toEqual([]);

        // And the redirect is REPORTED rather than swallowed — `manual` and not
        // `error` precisely so an operator can see what their server did.
        expect(omlx.ok).toBe(false);
        expect(omlx.detail).toContain("302");
      } finally {
        await Promise.all([redirector.stop(true), sink.stop(true)]);
      }
    },
    /**
     * One CLI spawn, so this one IS `cliBudget`'s shape — `doctor` transpiles
     * and runs the entrypoint exactly like the commands `budget.ts` measured.
     * No live model is dialed: the redirector answers instantly and the
     * completion probe never runs, because a non-`ok` model list returns first.
     */
    cliBudget(1),
  );
});
