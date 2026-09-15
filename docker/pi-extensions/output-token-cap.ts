/**
 * A per-request output-token cap, applied to the request Pi is about to send.
 *
 * ## The failure this exists for, measured live on 2026-09-15
 *
 * Worker seats run the Pi coding agent against an OpenAI-compatible endpoint.
 * During triage sweeps, seats went silent mid-turn for 16 minutes until the
 * task deadline killed them. The endpoint's own metrics showed an average
 * `max_tokens` of about 213k per request — seats send no output cap at all, so
 * the server lets a runaway generation run for most of the context window.
 * Pi's 5-minute idle timeout does not catch this, because tokens keep
 * flowing the entire time; idle is not what is happening.
 *
 * Completed turns from the same seats, measured over 363 assistant messages:
 * output tokens p50 99, p90 800, p99 3118, max 7395. Only 3 turns ended
 * `stop`; the rest ended `toolUse`. None ended on `length`. A cap sized off
 * that distribution — not off the context window — turns the runaway case
 * into an ordinary `length` finish instead of a silent multi-minute stall,
 * at a budget no turn observed so far has come close to needing.
 *
 * ## Why an extension, and why THIS hook
 *
 * A `maxTokens` in `models.json` does not reach an OpenAI-compatible request.
 * Measured against Pi 0.79.6's shipped `dist/`:
 *
 *   - `pi-ai/dist/providers/simple-options.js`'s `buildBaseOptions` passes
 *     `maxTokens: options?.maxTokens` straight through.
 *   - `openai-completions.js:407` sets `params.max_tokens` (or
 *     `max_completion_tokens`, per the model's `compat.maxTokensField`) only
 *     `if (options?.maxTokens)`.
 *   - `pi-agent-core/dist/agent.js:24` defaults `maxTokens: 0`, and only the
 *     anthropic and bedrock providers read `model.maxTokens` out of
 *     `models.json` to fill it in. The OpenAI-compatible path this fleet's
 *     providers use never does, so `config/schema.ts`'s `max_output_tokens`
 *     field has nowhere to land as a launch flag or a `models.json` key.
 *
 * The hook that does work is `openai-completions.js:82`: `const nextParams =
 * await options?.onPayload?.(params, model)`, on the FINAL request params —
 * after Pi has already decided whether to set its own cap (compaction passes
 * one, e.g. 2048; an ordinary turn does not). `pi-coding-agent/dist/core/sdk.js:200`
 * wires `onPayload` to `runner.emitBeforeProviderRequest(payload)`, which
 * `extensions/runner.js:714` turns into `pi.on("before_provider_request",
 * handler)`: a non-`undefined` return REPLACES the payload, and a thrown
 * error is caught and reported as an extension error rather than crashing the
 * turn. `types.d.ts:480/738` types both the payload and the result `unknown`
 * — Pi makes no promise about the shape, which is why every check below is a
 * guard rather than a cast.
 *
 * ## What this does, precisely
 *
 * Reads `PIFLEET_PI_MAX_OUTPUT_TOKENS` once, at extension load. When it holds
 * a positive integer AND the payload is a plain object AND that object
 * carries neither `max_tokens` nor `max_completion_tokens`, returns the
 * payload with `max_tokens` set to the cap. Every other case — the variable
 * empty or invalid, the payload not an object, a cap already present (e.g.
 * compaction's) — returns `undefined`, Pi's "no opinion", leaving the request
 * exactly as it arrived. Always `max_tokens` on the way OUT, regardless of
 * which field a prior write used: this hook runs once, after Pi has already
 * chosen `compat.maxTokensField` for anything it sets itself, and the
 * "already has a cap" guard is what stops this file from ever needing to make
 * that choice.
 *
 * Never throws. `applyOutputTokenCap` cannot: it only reads plain properties
 * off a value it has already confirmed is a non-null, non-array object, and
 * every branch returns rather than accesses anything further.
 */

/** The slice of `ExtensionAPI` this file uses, declared STRUCTURALLY rather
 * than imported — the reason is the one `dispatch-trigger.ts` gives at
 * length: `@earendil-works/pi-coding-agent` lives in the worker image and not
 * in this repo, so a real import would make this file uncheckable here. The
 * declaration is a SUBSET, so it can only fail to mention a member this file
 * never calls, never claim one Pi does not have.
 * `test/integration/extension-declarations-image.test.ts` pins both the
 * member and the event name against the real `.d.ts` when the image is
 * present.
 */
interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  /** Unknown in Pi's own types — the final, provider-shaped request body. */
  payload: unknown;
}

interface ExtensionAPI {
  on(
    event: "before_provider_request",
    handler: (event: BeforeProviderRequestEvent) => unknown,
  ): void;
}

/** Mirrors `PIFLEET_PI_MAX_OUTPUT_TOKENS` in `src/run/worker-env.ts`. */
export const MAX_OUTPUT_TOKENS_ENV = "PIFLEET_PI_MAX_OUTPUT_TOKENS";

/**
 * Parse the env value into a cap, or `null` for "no cap" — the same null
 * `config/load.ts`'s `providerMaxOutputTokens` uses for "unmeasured".
 *
 * Strict on purpose: `worker-env.ts` only ever writes `""` or the decimal form
 * of a `z.number().int().positive()`, so anything else reaching this function
 * is not a value this fleet produced, and the safe reading of an unrecognised
 * value is the same as an absent one — no cap, not a guessed one.
 */
export function parseCap(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Apply `cap` to `payload`, or return `undefined` to leave it untouched.
 *
 * `undefined` is Pi's "no opinion" for a `before_provider_request` handler —
 * see the header — and it is what every one of these gets: no cap configured,
 * a payload that is not a plain request object, or a payload that already
 * carries an output-token field of its own (compaction's `max_tokens: 2048`,
 * chiefly). That last guard is the one this file exists to get right: a
 * fixed fleet-wide number stepping on a deliberately smaller request-specific
 * one would silently change compaction's own budget, which is a second bug
 * wearing this one's fix.
 */
export function applyOutputTokenCap(
  payload: unknown,
  cap: number | null,
): Record<string, unknown> | undefined {
  if (cap === null) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const params = payload as Record<string, unknown>;
  if ("max_tokens" in params || "max_completion_tokens" in params) return undefined;
  return { ...params, max_tokens: cap };
}

export default function (pi: ExtensionAPI): void {
  // Read once. The value is fixed for the life of a worker — `worker-env.ts`
  // writes it into the container's `--env-file` before the process starts —
  // so re-reading `process.env` on every request would cost a lookup to learn
  // nothing new.
  const cap = parseCap(process.env[MAX_OUTPUT_TOKENS_ENV]);
  pi.on("before_provider_request", (event) => applyOutputTokenCap(event.payload, cap));
}
