/**
 * The native-tool-call probe (SRD §5.9 F39; ISC-53).
 *
 * Whether a model answers with `tool_calls` or with PROSE is a property of that
 * model's chat template, not of oMLX: this project has a recorded live
 * measurement of `Qwen3-8B-4bit` emitting reasoning prose through the very same
 * server that `Qwen3-Coder-30B-A3B` returns well-formed calls from. A worker
 * pointed at such a model looks perfectly healthy — it streams tokens, ends
 * turns, settles — and accomplishes NOTHING, because its intended actions never
 * become tool calls. At fleet scale that burns a whole run before anyone
 * notices, which is why §5.9 makes this probe mandatory at `up` rather than
 * advisory.
 *
 * This module is the network half. It lives here rather than in
 * `config/load.ts` because that module is deliberately synchronous file-IO
 * only, and a config loader that reaches the network is a config loader that
 * cannot be unit-tested without one. `assertModelsSupportToolCalls` is
 * nonetheless shaped to sit directly beside `assertModelsAllowed` at `up`'s
 * call site: the ISC-52 gate and the ISC-53 gate are two statements about the
 * same worker list, and reading them as a pair is the point.
 */

import { EXIT } from "../contracts.ts";
import { ConfigError, resolveWorker, type LoadedConfig } from "../config/load.ts";

/**
 * The `fetch` surface this module actually uses, so a test can inject a double.
 *
 * Written as a bare call signature rather than `typeof fetch`, and the
 * difference is not cosmetic. `typeof fetch` under `@types/bun` carries the
 * static `preconnect` property, so every hand-written double — the entire
 * point of the type — is not assignable to it, and `as FetchLike` on a plain
 * arrow function becomes a TS2352 error rather than a cast. That failed
 * `tsc --noEmit` five times over in `test/unit/model-probe.test.ts` while
 * `bun test` stayed green, because Bun strips types without checking them: the
 * suite was certifying code the project's own typecheck gate rejected.
 *
 * The narrower type is also the more honest one. This module calls
 * `fetch(url, init)` and reads a `Response`; it never touches `preconnect`, so
 * demanding it of a double demanded something the contract does not use. The
 * real global `fetch` stays assignable, which is all the default argument
 * needs.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Which class of failure a probe hit. The exit code hangs off this, and none of
 * them are interchangeable.
 *
 * The partition that matters is **what the operator must go and change**, which
 * is why `prose` is identified POSITIVELY rather than being the fall-through:
 *
 * - `prose` — the server answered, the model was handed tools, it finished
 *   normally (`finish_reason: "stop"`) and wrote text anyway. That, and only
 *   that, is the criterion's failure: an operator chose a model the fleet
 *   cannot drive. **Exit 2**, a usage error.
 * - `model-not-found` — the server does not serve the model at all. Also the
 *   operator's `model:` line, so also **exit 2** — but a different edit, and
 *   the old code reported it as "oMLX is down" (S2).
 * - `unreachable` — oMLX not answering: down, wrong port, wrong host, refused.
 *   Nothing has been learned about the MODEL, so reporting it as a usage error
 *   would send the operator to edit a `model:` line that is probably correct.
 *   **Exit 3**, the same class `ensureEgressNetwork` failures already use.
 * - `timeout` — the request was still outstanding when the clock ran out. A
 *   COLD LOAD on this host routinely exceeds 60s (§5.9 records it), so "down"
 *   is the wrong story: the server is up and busy. Same **exit 3**, different
 *   remedy (S1).
 * - `malformed` — a 2xx whose body this code cannot read. The SERVER
 *   misbehaving, not the model answering in prose. **Exit 3.**
 * - `inconclusive` — a 2xx that answered, but not in a way that settles the
 *   question either way: truncated (`finish_reason: "length"`), filtered, or a
 *   finish reason this code does not know. **Exit 3**, and this class exists
 *   because its absence was a real misdiagnosis — see below.
 *
 * ## Why `inconclusive` had to exist (M1)
 *
 * `prose` used to be the fall-through: any 2xx with a non-empty `choices[]`
 * that was not exactly `finish_reason === "tool_calls"` with calls present got
 * reported as "this model answered with prose", exit 2, and the operator was
 * told to point the role at a model whose chat template supports tools.
 *
 * That swept in `finish_reason: "length"` with no tool_calls — which is what a
 * REASONING model produces when its `<think>` preamble runs past the probe's
 * own token budget, and the budget was 200. This host serves Qwen3.5-*
 * reasoning models. So a perfectly capable model could be refused, by name, for
 * a defect it does not have, because the probe cut it off mid-thought. §5.9's
 * original `Qwen3-8B-4bit` "prose" observation is itself consistent with
 * truncation rather than template incompatibility.
 *
 * Truncation says nothing about whether the model can emit a native call. So it
 * is not exit 2, because there is nothing about the `model:` line to fix, and
 * it is not silence either — the gate did not get its answer, so it refuses at
 * exit 3 and says which measurement failed.
 */
export type ProbeFailure =
  | "prose"
  | "model-not-found"
  | "unreachable"
  | "timeout"
  | "malformed"
  | "inconclusive";

export interface ToolCallProbeResult {
  model: string;
  ok: boolean;
  /** Human-readable, and the text that reaches the operator on a refusal. */
  detail: string;
  /** `null` exactly when `ok`. */
  failure: ProbeFailure | null;
}

/**
 * The tool the probe offers. Deliberately zero-argument: the question is
 * whether the model emits a native call at all, and any required parameter
 * would let a model fail the probe for getting the ARGUMENTS wrong — a
 * different defect, and one this gate is not entitled to refuse a run over.
 */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "pifleet_probe",
    description: "Report readiness. Call this immediately.",
    parameters: { type: "object", properties: {}, required: [] },
  },
} as const;

const PROBE_PROMPT =
  "Call the pifleet_probe tool now to report readiness. Use the tool; do not write prose.";

/**
 * `tool_choice` is left UNSET on purpose (i.e. the API default, `auto`).
 *
 * Forcing `tool_choice: "required"` would make a compliant server manufacture a
 * tool call from a model whose chat template cannot produce one — masking
 * precisely the incompatibility this probe exists to detect and converting the
 * gate into a rubber stamp. The directive prompt above carries the intent
 * instead, which is what was measured live against this server.
 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * The probe's token budget.
 *
 * 2048, not 200, and the number is load-bearing rather than generous. A
 * reasoning model emits a `<think>` preamble before it acts, and this host
 * serves Qwen3.5-* reasoning models; at 200 tokens the preamble alone hits the
 * cap, the server returns `finish_reason: "length"` with no tool_calls, and the
 * gate refuses a model that was about to call the tool correctly (see
 * `ProbeFailure`). The cost of the higher ceiling is bounded and mostly
 * theoretical: a model that emits the call promptly stops at the call, so only
 * the pathological case pays, and paying it once per DISTINCT model per `up` is
 * cheaper than a false refusal.
 */
const PROBE_MAX_TOKENS = 2048;

/** Read at most this much of a non-2xx body into the operator-facing detail. */
const ERROR_BODY_CHARS = 400;

/**
 * The container-facing hostname `llm.base_url` is written with.
 *
 * Named rather than inlined because the rewrite below and the reason for it are
 * two different facts, and only one of them is a string.
 */
const CONTAINER_HOSTNAME = "host.docker.internal";

/**
 * Rewrite a container-facing oMLX URL to one the HOST can reach.
 *
 * `llm.base_url` defaults to `http://host.docker.internal:8000/v1` because it
 * is written for the WORKERS, which reach oMLX from inside a container. `up`
 * and `doctor` run on the host, where that name does not resolve at all
 * (measured: `curl` returns 000). Without this, the mandatory ISC-53 probe
 * would fail as `unreachable` on every correctly-written fleet.yaml and exit 3
 * — a gate that refuses every run there is.
 *
 * Parsed, not substring-replaced. The original spelling was
 * `baseUrl.replace("host.docker.internal", "localhost")`, which corrupts any
 * URL that merely CONTAINS the name somewhere other than the host component —
 * `https://host.docker.internal.example.com/v1` (a real hostname that only
 * starts with it) and `http://proxy:8000/host.docker.internal/v1` (a path
 * segment) both get silently rewritten into an endpoint nobody configured, and
 * the resulting failure reads as "oMLX is down". `egress.ts:policyFromConfig`
 * already parses this same field with `new URL`; this is the same rule, applied
 * the same way, so the two cannot disagree about what the endpoint is.
 *
 * A URL this cannot parse is returned UNTOUCHED rather than thrown on: the
 * schema validates `llm.base_url` with `z.string().url()` already, and a probe
 * helper is the wrong place to re-litigate config validation — the caller's
 * fetch will fail loudly and be classified `unreachable`, which is true.
 *
 * Shared with `doctor` rather than duplicated: the rule is one rule, and two
 * copies of it drift.
 */
export function hostFacingBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (url.hostname !== CONTAINER_HOSTNAME) return baseUrl;
  url.hostname = "localhost";
  const rewritten = url.toString();
  // `URL.toString()` normalizes an empty path to `/`, which would turn
  // `…:8000` into `…:8000/` and then `…:8000//chat/completions` downstream.
  // Only the rewritten string is normalized at all — the untouched path above
  // returns the operator's own spelling, byte for byte.
  return baseUrl.endsWith("/") || !rewritten.endsWith("/") ? rewritten : rewritten.slice(0, -1);
}

/** Doctor's convention: no key in the environment means no header at all. */
function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Send one `tools`-bearing completion and report whether a native call came
 * back.
 *
 * NEVER throws. A probe is a measurement, and a measurement that escapes as an
 * exception cannot be reported — the caller's job is to decide what the result
 * MEANS, which is why every failure path returns a `ToolCallProbeResult`
 * carrying its own class. The response body is read defensively for the same
 * reason: this is untrusted input from a server that has been observed
 * returning 500s with a JSON error body.
 */
export async function probeNativeToolCalls(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ToolCallProbeResult> {
  const url = `${hostFacingBaseUrl(baseUrl)}/chat/completions`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        tools: [PROBE_TOOL],
        max_tokens: PROBE_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    /**
     * A timeout is NOT "unreachable", and conflating them is a misdiagnosis
     * this project has the incident report for (S1). `AbortSignal.timeout`
     * rejects with a `TimeoutError`, and §5.9 records cold model loads on this
     * host exceeding 60s — so the old message told the operator to "Start
     * oMLX" about a server that was up, running, and loading their weights.
     * The connection was made; the answer just had not arrived.
     */
    if (err instanceof Error && err.name === "TimeoutError") {
      return {
        model,
        ok: false,
        failure: "timeout",
        detail:
          `the native-tool-call probe of "${model}" did not answer within ${timeoutMs}ms at ` +
          `${url}. oMLX may be COLD-LOADING the model rather than down — a first load of a ` +
          `large model on this host has been measured past this budget (SRD §5.9)`,
      };
    }
    return {
      model,
      ok: false,
      failure: "unreachable",
      detail: `oMLX unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    /**
     * Read the body. A status code alone cannot tell "the server is down" from
     * "the server is fine and your model does not exist on it", and the old
     * code reported both as unreachable — sending an operator whose `model:`
     * line is the entire problem off to restart a healthy server (S2).
     *
     * Defensive, like everything else here: a body that will not read costs
     * nothing but the extra context.
     */
    let body = "";
    try {
      body = (await res.text()).trim().slice(0, ERROR_BODY_CHARS);
    } catch {
      // Unreadable error bodies are not worth a second failure class.
    }
    const suffix =
      (body === "" ? "" : ` — ${body}`) + (apiKey ? "" : " (no API key in the environment)");

    /**
     * A 404 whose body talks about models is the server saying it does not
     * serve this one: the operator's `model:` line, and a usage error.
     *
     * The body check is what keeps this narrow. A 404 with no mention of a
     * model is far more likely to be a WRONG PATH — a `base_url` missing its
     * `/v1`, or a reverse proxy answering for a route it does not have — and
     * blaming the model for that would just relocate the misdiagnosis this
     * finding is about.
     */
    if (res.status === 404 && /model/i.test(body)) {
      return {
        model,
        ok: false,
        failure: "model-not-found",
        detail: `oMLX answered HTTP 404 for "${model}": the server does not serve it${suffix}`,
      };
    }
    return {
      model,
      ok: false,
      failure: "unreachable",
      detail:
        `oMLX answered HTTP ${res.status} for the native-tool-call probe of "${model}"` + suffix,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      model,
      ok: false,
      failure: "malformed",
      detail: `oMLX returned HTTP 200 with an unreadable body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      model,
      ok: false,
      failure: "malformed",
      detail: `oMLX returned HTTP 200 with no choices[] for "${model}"`,
    };
  }
  const choice = choices[0] as { finish_reason?: unknown; message?: { tool_calls?: unknown } };
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "(absent)";
  const calls = choice?.message?.tool_calls;
  const hasCalls = Array.isArray(calls) && calls.length > 0;

  // BOTH halves are required. A `finish_reason` of `tool_calls` with an empty
  // array is a server claiming a call it did not make, and an array present
  // under any other finish reason is not a completed call — either alone would
  // let a model through that cannot actually be driven.
  if (finish === "tool_calls" && hasCalls) {
    return {
      model,
      ok: true,
      failure: null,
      detail: `answered with ${calls.length} native tool_call(s)`,
    };
  }

  const shape = `finish_reason=${finish}, tool_calls=${hasCalls ? String(calls.length) : "none"}`;

  /**
   * `prose` is now identified POSITIVELY, and that is the whole of the M1 fix.
   *
   * "The model ran to a natural stop and produced no call" is the only shape
   * that means what the criterion says it means. `finish_reason: "stop"` is the
   * server stating the generation COMPLETED — nothing was truncated, nothing
   * was filtered — so the absence of a tool call is the model's own answer.
   *
   * Everything else that reaches this line answered without settling the
   * question, and falls through to `inconclusive` below rather than being
   * blamed on the model.
   *
   * `tool_calls` present under `stop` is deliberately NOT here: it lands in
   * `inconclusive` too. A server that completed a turn and produced calls the
   * finish reason does not acknowledge is contradicting itself, which is a
   * statement about the SERVER, not evidence the model writes prose.
   */
  if (finish === "stop" && !hasCalls) {
    return {
      model,
      ok: false,
      failure: "prose",
      detail: `model "${model}" answered with prose instead of tool_calls (${shape})`,
    };
  }

  /**
   * Truncated, filtered, or a finish reason this code has never seen. The probe
   * ran and learned nothing, which is a different thing from learning that the
   * model cannot emit calls — see `ProbeFailure` for why that distinction is
   * worth its own class and its own exit code.
   */
  return {
    model,
    ok: false,
    failure: "inconclusive",
    detail:
      `the native-tool-call probe of "${model}" did not settle the question (${shape})` +
      (finish === "length"
        ? ` — the answer was TRUNCATED at the probe's ${PROBE_MAX_TOKENS}-token budget, which a ` +
          `reasoning model's preamble can exhaust before it acts. This is not evidence the ` +
          `model cannot emit tool calls`
        : ""),
  };
}

/**
 * A model that answered the probe in prose. A `ConfigError`, so it already
 * carries `EXIT.USAGE` — exit 2 — exactly as `ModelNotAllowedError` does for
 * the sibling ISC-52 gate.
 */
export class NativeToolCallRefusedError extends ConfigError {
  constructor(
    readonly workerIds: readonly string[],
    readonly model: string,
    readonly detail: string,
  ) {
    super(
      `worker${workerIds.length === 1 ? "" : "s"} ${workerIds.map((w) => `"${w}"`).join(", ")} ` +
        `resolve${workerIds.length === 1 ? "s" : ""} to model "${model}", which does not emit ` +
        `native tool calls — ${detail}. A worker on this model streams tokens, ends turns and ` +
        `does nothing (SRD §5.9 F39). Point it at a model whose chat template supports tools, ` +
        `or set llm.require_native_tool_calls: false if this role genuinely needs no tools`,
    );
    this.name = "NativeToolCallRefusedError";
  }
}

/**
 * The server does not serve the named model.
 *
 * A `ConfigError` — exit 2 — because this is the `model:` line and nothing
 * else. It used to be reported as `unreachable` (exit 3, "Start oMLX"), which
 * sent an operator to restart a server that was answering their requests
 * perfectly well in order to fix a typo in their config (S2).
 */
export class ModelNotServedError extends ConfigError {
  constructor(
    readonly workerIds: readonly string[],
    readonly model: string,
    readonly detail: string,
  ) {
    super(
      `worker${workerIds.length === 1 ? "" : "s"} ${workerIds.map((w) => `"${w}"`).join(", ")} ` +
        `resolve${workerIds.length === 1 ? "s" : ""} to model "${model}", which the configured ` +
        `oMLX endpoint does not serve — ${detail}. Check the \`model:\` line against the model ` +
        `list \`pifleet doctor\` reports, or load the model on the server`,
    );
    this.name = "ModelNotServedError";
  }
}

/**
 * What the operator should actually DO, per failure class.
 *
 * `prose` and `model-not-found` appear only for completeness of the mapping and
 * are never reached through this table: both are usage errors carrying their
 * own advice on the `ConfigError` subclasses above.
 */
const REMEDY: Record<ProbeFailure, string> = {
  prose: "Point the role at a model whose chat template supports tools",
  "model-not-found": "Check the `model:` line against the model list `pifleet doctor` reports",
  unreachable: "Start oMLX, or check llm.base_url and the API key named by llm.api_key_env",
  timeout:
    "If oMLX is loading this model for the first time, wait for the load to finish and retry — " +
    "a large cold model on this host has been measured past this budget. If it is already " +
    "warm, the server is wedged rather than slow",
  malformed:
    "That is the SERVER misbehaving rather than the model answering badly — check the oMLX logs",
  inconclusive:
    "Nothing here says the `model:` line is wrong, so changing it is the wrong first move. " +
    "Retry, and check the oMLX logs if it persists",
};

/**
 * The probe did not produce a verdict about the model.
 *
 * Deliberately NOT a `ConfigError`. Nothing was learned about the model, so
 * this is an environment-readiness failure and wears `EXIT.BACKEND_UNAVAILABLE`
 * — the same code `up` already gives a missing egress network or an unreadable
 * repository. It satisfies the structural `ExitCoded` protocol from
 * contracts.ts, so `cli/index.ts` routes it without a bespoke catch clause.
 *
 * The REMEDY is chosen from the failure class, because no single sentence is
 * true of all of them. "Start oMLX, or check llm.base_url" is right for a
 * refused connection, actively misleading for a cold load still in progress
 * (S1), and beside the point for a truncated answer (M1) — and an operator who
 * follows the wrong one of those spends exactly the time the diagnosis existed
 * to save. The exit code is identical in every case; only the sentence differs.
 */
export class ToolCallProbeUnavailableError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly model: string,
    readonly failure: ProbeFailure,
    readonly detail: string,
  ) {
    super(
      `refusing to start: the mandatory native-tool-call probe (SRD §5.9) did not settle ` +
        `whether model "${model}" emits native tool calls — ${detail}. ${REMEDY[failure]}`,
    );
    this.name = "ToolCallProbeUnavailableError";
  }
}

/**
 * Refuse every named worker whose model cannot emit native tool calls, before
 * any supervisor launches (ISC-53).
 *
 * Structurally the twin of `assertModelsAllowed` in `up.ts`, including its
 * membership skip: a `--workers` id the config does not define is a Phase 1
 * `PIFLEET_PI_COMMAND` double with no configured model to probe, and refusing
 * it would break the shape `up` is tested under.
 *
 * Models are DEDUPED before probing. Six workers on one model is the normal
 * fleet shape (§5.9 F40 — six clients, one inference server), and probing that
 * model six times would cost six real generations on the machine the run is
 * about to compete with for GPU.
 *
 * `require_native_tool_calls: false` disables the whole gate, per §5.9's
 * "disables both" — the startup probe here and the runtime zero-tool-call
 * counter in the supervisor.
 *
 * NOTE: §5.9's prose says the probe covers "every model in `models_allowlist`".
 * This probes every model the named workers actually RESOLVE to instead, which
 * is a strict improvement on the same intent: the allowlist may name models no
 * worker in this run uses, and burning a cold 35B model load to certify a model
 * nothing will touch delays every `up` for no safety gained. ISC-52 already
 * guarantees the resolved set is a SUBSET of the allowlist, so nothing
 * un-allowlisted can reach this gate.
 */
export async function assertModelsSupportToolCalls(
  loaded: LoadedConfig,
  workerIds: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!loaded.config.llm.require_native_tool_calls) return;

  const defined = new Set(loaded.config.workers.map((w) => w.id));
  /** model → the workers that resolved to it, so a refusal can name them all. */
  const byModel = new Map<string, string[]>();
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    const model = resolveWorker(loaded, workerId).model;
    const owners = byModel.get(model);
    if (owners === undefined) byModel.set(model, [workerId]);
    else owners.push(workerId);
  }

  const baseUrl = loaded.config.llm.base_url;
  const apiKey = process.env[loaded.config.llm.api_key_env] ?? "";

  for (const [model, owners] of byModel) {
    const result = await probeNativeToolCalls(baseUrl, apiKey, model, fetchImpl);
    if (result.ok) continue;
    /**
     * The exit-code split, and the ONLY place it is decided.
     *
     * Exit 2 is reserved for the two classes where the operator has something
     * in `fleet.yaml` to change — the model writes prose, or the server does
     * not serve it. Everything else exits 3, because nothing was learned about
     * the model and sending someone to edit a correct `model:` line is a
     * misdiagnosis, not a diagnosis. `inconclusive` is the class that used to
     * be missing entirely: a truncated answer took the `prose` path and got a
     * capable model refused by name (M1).
     */
    switch (result.failure) {
      case "prose":
        throw new NativeToolCallRefusedError(owners, model, result.detail);
      case "model-not-found":
        throw new ModelNotServedError(owners, model, result.detail);
      default:
        throw new ToolCallProbeUnavailableError(model, result.failure ?? "unreachable", result.detail);
    }
  }
}

// ---------------------------------------------------------------------------
// Chat-model selection for `doctor`'s latency probe (ISC-55)
// ---------------------------------------------------------------------------

/**
 * Whether a model id NAMES itself an embedding model.
 *
 * A heuristic on the id, and honestly only that: oMLX's `GET /v1/models` says
 * nothing about a model's modality, so the name is the only signal available
 * without sending a request that a non-chat model answers with a 500.
 *
 * It earns its place because the failure it prevents is live on this host
 * today, not hypothetical. `doctor` with no fleet.yaml falls back to the FIRST
 * served model, and this machine currently serves
 * `Qwen3-Embedding-4B-4bit-DWQ` first — measured: `POST /v1/chat/completions`
 * against it returns HTTP 500, so `completion_latency_ms` came back `null` and
 * ISC-55's "measured single-request latency" was silently unreported on the
 * default path.
 */
export function isEmbeddingModelId(id: string): boolean {
  return /embed/i.test(id);
}

/**
 * Pick the model `doctor` should time a completion against.
 *
 * A configured `llm.model` always wins — an operator naming a model has said
 * which one the fleet uses, and second-guessing it would report a latency for
 * a model no worker runs. The heuristic applies only to the no-config
 * fallback, where the alternative is an arbitrary pick.
 *
 * Falls back to the first served model when EVERY id looks like an embedding
 * model: a server with nothing else to offer should still be probed and should
 * still report the resulting failure, rather than quietly measuring nothing.
 */
export function chatProbeModel(configured: string | null, served: readonly string[]): string | null {
  if (configured !== null && configured !== "") return configured;
  return served.find((id) => !isEmbeddingModelId(id)) ?? served[0] ?? null;
}
