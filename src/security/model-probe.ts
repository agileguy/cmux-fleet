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
 * Which class of failure a probe hit. The exit code hangs off this, and the
 * three are NOT interchangeable:
 *
 * - `prose` is the criterion's failure — the server answered, the model was
 *   handed tools, and it wrote text anyway. That is an operator choosing a
 *   model the fleet cannot drive: **exit 2**, a usage error.
 * - `unreachable` is oMLX not answering (down, wrong port, bad key, timeout).
 *   Nothing has been learned about the MODEL, so reporting it as a usage error
 *   would send the operator to edit a `model:` line that is probably correct.
 *   **Exit 3**, the same class `ensureEgressNetwork` failures already use.
 * - `malformed` is a 2xx whose body this code cannot read. That is the SERVER
 *   misbehaving, not the model answering in prose, and folding it into `prose`
 *   would blame a model choice for a protocol bug. **Exit 3.**
 */
export type ProbeFailure = "prose" | "unreachable" | "malformed";

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
 * Rewrite a container-facing oMLX URL to one the HOST can reach.
 *
 * `llm.base_url` defaults to `http://host.docker.internal:8000/v1` because it
 * is written for the WORKERS, which reach oMLX from inside a container. `up`
 * and `doctor` run on the host, where that name does not resolve at all
 * (measured: `curl` returns 000). Without this, the mandatory ISC-53 probe
 * would fail as `unreachable` on every correctly-written fleet.yaml and exit 3
 * — a gate that refuses every run there is.
 *
 * Shared with `doctor` rather than duplicated: the rule is one rule, and two
 * copies of it drift.
 */
export function hostFacingBaseUrl(baseUrl: string): string {
  return baseUrl.replace("host.docker.internal", "localhost");
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
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      model,
      ok: false,
      failure: "unreachable",
      detail: `oMLX unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      model,
      ok: false,
      failure: "unreachable",
      detail:
        `oMLX answered HTTP ${res.status} for the native-tool-call probe of "${model}"` +
        (apiKey ? "" : " (no API key in the environment)"),
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

  return {
    model,
    ok: false,
    failure: "prose",
    detail:
      `model "${model}" answered with prose instead of tool_calls ` +
      `(finish_reason=${finish}, tool_calls=${hasCalls ? String(calls.length) : "none"})`,
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
 * oMLX could not be probed at all.
 *
 * Deliberately NOT a `ConfigError`. Nothing was learned about the model, so
 * this is an environment-readiness failure and wears `EXIT.BACKEND_UNAVAILABLE`
 * — the same code `up` already gives a missing egress network or an unreadable
 * repository. It satisfies the structural `ExitCoded` protocol from
 * contracts.ts, so `cli/index.ts` routes it without a bespoke catch clause.
 */
export class ToolCallProbeUnavailableError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly model: string,
    readonly detail: string,
  ) {
    super(
      `refusing to start: the mandatory native-tool-call probe (SRD §5.9) could not reach ` +
        `oMLX for model "${model}" — ${detail}. Start oMLX, or check llm.base_url and the ` +
        `API key named by llm.api_key_env`,
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
    if (result.failure === "prose") {
      throw new NativeToolCallRefusedError(owners, model, result.detail);
    }
    throw new ToolCallProbeUnavailableError(model, result.detail);
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
