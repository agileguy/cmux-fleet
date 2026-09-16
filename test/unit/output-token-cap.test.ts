/**
 * The output-token-cap extension, and the measured stall it closes.
 *
 * ## What was broken
 *
 * Worker seats run the Pi coding agent against an OpenAI-compatible endpoint
 * and sent no output-token cap on any request. Measured live on 2026-09-15,
 * the endpoint's own metrics showed an average `max_tokens` of about 213k per
 * request, and seats went silent mid-turn for 16 minutes until the task
 * deadline killed them — past Pi's own 5-minute idle timeout, which never
 * fired, because tokens kept flowing the whole time. Completed turns from the
 * same seats (363 assistant messages) ran output tokens p50 99, p90 800, p99
 * 3118, max 7395 — three orders of magnitude under what the server was
 * budgeting for.
 *
 * ## What these tests pin, and why each is here
 *
 * `parseCap` and `applyOutputTokenCap` are pure and are tested directly,
 * against the ASYMMETRY that matters: a cap must apply to an ordinary request
 * and must NOT apply to one that already carries its own — compaction's own
 * `max_tokens: 2048`, chiefly, which is exactly the field this fix could
 * silently overwrite if the "already has a cap" guard were ever dropped.
 * `applyOutputTokenCap`'s payload argument is `unknown` in Pi's own types
 * (`docker/pi-extensions/output-token-cap.ts`'s header cites the source
 * lines), so the non-object cases are tested as their own claim, not left to
 * be implied by the object cases passing.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import registerExtension, {
  applyOutputTokenCap,
  MAX_OUTPUT_TOKENS_ENV,
  parseCap,
} from "../../docker/pi-extensions/output-token-cap.ts";
import {
  ConfigValidationError,
  parseConfig,
  providerMaxOutputTokens,
  resolveWorker,
  type LoadedConfig,
} from "../../src/config/load.ts";

// ---------------------------------------------------------------------------
// parseCap — reading PIFLEET_PI_MAX_OUTPUT_TOKENS
// ---------------------------------------------------------------------------

describe("parseCap", () => {
  test("a clean positive integer parses", () => {
    expect(parseCap("4096")).toBe(4096);
  });

  test("surrounding whitespace is tolerated — worker-env.ts never emits it, a hand-edited env file might", () => {
    expect(parseCap("  8192  ")).toBe(8192);
  });

  /** `worker-env.ts` writes `""` for "unmeasured", and it must mean no cap. */
  test("empty is no cap", () => {
    expect(parseCap("")).toBeNull();
  });

  test("undefined (the variable absent entirely) is no cap", () => {
    expect(parseCap(undefined)).toBeNull();
  });

  /** Zero is not a positive integer — same bound `max_output_tokens` enforces. */
  test("zero is not a cap", () => {
    expect(parseCap("0")).toBeNull();
  });

  test("a negative value is not a cap", () => {
    expect(parseCap("-5")).toBeNull();
  });

  test("a fractional value is not a cap", () => {
    expect(parseCap("3.5")).toBeNull();
  });

  test("non-numeric text is not a cap", () => {
    expect(parseCap("nope")).toBeNull();
  });

  /** Guards `Number()`'s own coercions — "1e9" and "Infinity" both parse as numbers in JS. */
  test("exponent and Infinity spellings are refused by the digit-only pattern", () => {
    expect(parseCap("1e9")).toBeNull();
    expect(parseCap("Infinity")).toBeNull();
  });

  /** Past `Number.isSafeInteger`, refused rather than silently rounded. */
  test("a value too large to be a safe integer is not a cap", () => {
    expect(parseCap("99999999999999999999")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyOutputTokenCap — the payload transform
// ---------------------------------------------------------------------------

/** A real chat-completions params object, the shape `openai-completions.js` builds. */
function chatCompletionsPayload(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "gemma-4-26b-a4b-it",
    messages: [{ role: "user", content: "list the open tickets" }],
    stream: true,
    tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
    ...extra,
  };
}

describe("applyOutputTokenCap", () => {
  test("a cap is set on a request that carries neither field", () => {
    const payload = chatCompletionsPayload();
    const result = applyOutputTokenCap(payload, 4096);
    expect(result).toEqual({ ...payload, max_tokens: 4096 });
    // The original is untouched — a worker able to observe two turns of the
    // same object would otherwise see it mutate out from under it.
    expect(payload).not.toHaveProperty("max_tokens");
  });

  test("model, messages, stream and tools survive unchanged alongside the cap", () => {
    const payload = chatCompletionsPayload();
    const result = applyOutputTokenCap(payload, 2048);
    expect(result?.["model"]).toBe("gemma-4-26b-a4b-it");
    expect(result?.["messages"]).toEqual(payload["messages"]);
    expect(result?.["stream"]).toBe(true);
    expect(result?.["tools"]).toEqual(payload["tools"]);
  });

  /**
   * Compaction's own cap (2026-09-15 brief: "Compaction passes its own
   * `maxTokens` (e.g. 2048)"). This is the case the guard exists for: a
   * fleet-wide number must never step on a request-specific smaller one.
   */
  test("an existing max_tokens is preserved — the payload comes back untouched", () => {
    const payload = chatCompletionsPayload({ max_tokens: 2048 });
    expect(applyOutputTokenCap(payload, 65536)).toBeUndefined();
  });

  /** The other field name `compat.maxTokensField` can select (openai-completions.js:407). */
  test("an existing max_completion_tokens is preserved — the payload comes back untouched", () => {
    const payload = chatCompletionsPayload({ max_completion_tokens: 2048 });
    expect(applyOutputTokenCap(payload, 65536)).toBeUndefined();
  });

  test("no cap configured is a no-op regardless of the payload", () => {
    expect(applyOutputTokenCap(chatCompletionsPayload(), null)).toBeUndefined();
  });

  /**
   * `payload` is `unknown` at the call site (Pi's own types), so every one of
   * these is a real case this file must not throw on, not a hypothetical.
   */
  test.each([
    ["an array", ["not", "a", "request"]],
    ["a string", "not a request"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
  ] as const)("%s payload comes back untouched, cap or no cap", (_label, value) => {
    expect(applyOutputTokenCap(value, 4096)).toBeUndefined();
    expect(applyOutputTokenCap(value, null)).toBeUndefined();
  });

  test("none of the above throws", () => {
    const inputs: unknown[] = [chatCompletionsPayload(), [], "x", 1, true, null, undefined];
    for (const input of inputs) {
      expect(() => applyOutputTokenCap(input, 4096)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The default export — wiring the handler to before_provider_request
// ---------------------------------------------------------------------------

describe("the default export", () => {
  /** The one event this extension subscribes to (its own header explains why). */
  test("registers exactly one before_provider_request handler", () => {
    const calls: string[] = [];
    registerExtension({
      on: (event) => {
        calls.push(event);
      },
    });
    expect(calls).toEqual(["before_provider_request"]);
  });

  /**
   * End to end through the real env var name, not a stand-in string — if
   * `worker-env.ts` and this file ever disagree on the spelling, this is the
   * test that catches it, because it reads `MAX_OUTPUT_TOKENS_ENV` rather than
   * a literal.
   */
  test("the registered handler applies the cap read from the real env var", () => {
    const previous = process.env[MAX_OUTPUT_TOKENS_ENV];
    process.env[MAX_OUTPUT_TOKENS_ENV] = "512";
    try {
      let handler: ((event: { type: "before_provider_request"; payload: unknown }) => unknown) | null =
        null;
      registerExtension({
        on: (_event, h) => {
          handler = h;
        },
      });
      expect(handler).not.toBeNull();
      const payload = chatCompletionsPayload();
      const result = handler!({ type: "before_provider_request", payload });
      expect(result).toEqual({ ...payload, max_tokens: 512 });
    } finally {
      if (previous === undefined) delete process.env[MAX_OUTPUT_TOKENS_ENV];
      else process.env[MAX_OUTPUT_TOKENS_ENV] = previous;
    }
  });

  test("an empty env var produces a handler that never modifies a payload", () => {
    const previous = process.env[MAX_OUTPUT_TOKENS_ENV];
    process.env[MAX_OUTPUT_TOKENS_ENV] = "";
    try {
      let handler: ((event: { type: "before_provider_request"; payload: unknown }) => unknown) | null =
        null;
      registerExtension({
        on: (_event, h) => {
          handler = h;
        },
      });
      expect(handler!({ type: "before_provider_request", payload: chatCompletionsPayload() })).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[MAX_OUTPUT_TOKENS_ENV];
      else process.env[MAX_OUTPUT_TOKENS_ENV] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// The schema and the resolver
// ---------------------------------------------------------------------------

const load = (d: Record<string, unknown>): Promise<LoadedConfig> =>
  parseConfig(stringify(d), join(tmpdir(), "output-token-cap", "fleet.yaml"));

function doc(maxOutputTokens: Record<string, number> | undefined): Record<string, unknown> {
  const local: Record<string, unknown> = {
    hosted: false,
    base_url: "http://omlx.pifleet.internal:8000/v1",
    api_key_env: "OMLX_API_KEY",
  };
  if (maxOutputTokens !== undefined) local["max_output_tokens"] = maxOutputTokens;
  return {
    version: 2,
    name: "output-token-cap-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel", provider: "omlx", providers: { omlx: local } },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
  };
}

describe("the max_output_tokens field's own shape", () => {
  test("a positive integer is accepted", async () => {
    const loaded = await load(doc({ TestModel: 4096 }));
    expect(providerMaxOutputTokens(loaded.config, "omlx", "TestModel")).toBe(4096);
  });

  test("zero is refused, naming the field", async () => {
    const err = await load(doc({ TestModel: 0 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((err as ConfigValidationError).issues)).toContain("max_output_tokens");
  });

  test("a negative value is refused, naming the field", async () => {
    const err = await load(doc({ TestModel: -1 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((err as ConfigValidationError).issues)).toContain("max_output_tokens");
  });

  test("a fractional value is refused, naming the field", async () => {
    const err = await load(doc({ TestModel: 512.5 })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((err as ConfigValidationError).issues)).toContain("max_output_tokens");
  });
});

describe("providerMaxOutputTokens", () => {
  test("an unmeasured model on a declared provider resolves to null", async () => {
    const loaded = await load(doc({ TestModel: 4096 }));
    expect(providerMaxOutputTokens(loaded.config, "omlx", "Unmeasured")).toBeNull();
  });

  test("an undeclared provider resolves to null rather than throwing", async () => {
    const loaded = await load(doc({ TestModel: 4096 }));
    expect(providerMaxOutputTokens(loaded.config, "never-declared", "TestModel")).toBeNull();
  });

  /** §6.1's shorthand: no providers map means no per-model cap can be resolved. */
  test("a fleet with no providers map resolves to null", async () => {
    const loaded = await load({
      version: 2,
      name: "flat-fleet",
      docker: { pi_version: "0.79.6" },
      run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
      llm: { model: "TestModel" },
      roles: { eng: {} },
      workers: [{ id: "w1", role: "eng" }],
    });
    expect(providerMaxOutputTokens(loaded.config, "omlx", "TestModel")).toBeNull();
  });

  /** `resolveWorker` reaches the same answer through the field a worker actually carries. */
  test("resolves through a worker's own resolved provider and model", async () => {
    const loaded = await load(doc({ TestModel: 4096 }));
    const w = resolveWorker(loaded, "w1");
    expect(providerMaxOutputTokens(loaded.config, w.provider, w.model)).toBe(4096);
  });
});
