/**
 * The native-tool-call probe (ISC-53, SRD §5.9 F39).
 *
 * Everything here runs with an INJECTED fetch and no network. That is not a
 * convenience: the failure this gate exists to catch — a model that answers a
 * `tools`-bearing request with prose — cannot be reproduced on demand against
 * a real server, because it is a property of a specific model's chat template.
 * §5.9 records it measured on `Qwen3-8B-4bit`; that model is not loaded on this
 * host, so the negative case is proven here against the exact wire shape such a
 * model returns, and the POSITIVE case is proven live in
 * `test/integration/model-probe.test.ts` against a real oMLX model.
 *
 * The two halves are both required. A gate proven only on its refusal path
 * could be a gate that refuses everything.
 */

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXIT } from "../../src/contracts.ts";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import {
  ModelNotServedError,
  NativeToolCallRefusedError,
  ToolCallProbeUnavailableError,
  assertModelsSupportToolCalls,
  chatProbeModel,
  isEmbeddingModelId,
  probeNativeToolCalls,
  type FetchLike,
} from "../../src/security/model-probe.ts";

// ---------------------------------------------------------------------------
// Wire shapes, verified live against oMLX on 2026-08-18 before being frozen
// here. The positive one is a VERBATIM capture of what
// `gemma-4-26b-a4b-it-4bit` returned; the prose one is the shape §5.9 records
// `Qwen3-8B-4bit` returning through the same server.
// ---------------------------------------------------------------------------

const TOOL_CALL_BODY = {
  id: "chatcmpl-37156186",
  object: "chat.completion",
  model: "gemma-4-26b-a4b-it-4bit",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_ac3f695c", type: "function", function: { name: "pifleet_probe", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

const PROSE_BODY = {
  id: "chatcmpl-prose",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "I will now call the pifleet_probe tool to report readiness.",
        tool_calls: null,
      },
      finish_reason: "stop",
    },
  ],
};

/** A fetch double that always answers with one canned JSON body. */
function jsonFetch(body: unknown, status = 200): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
  return { fetch, calls };
}

const BASE = "http://localhost:8000/v1";

describe("probeNativeToolCalls reads the wire shape correctly", () => {
  test("a real tool_calls response passes", async () => {
    const { fetch } = jsonFetch(TOOL_CALL_BODY);
    const r = await probeNativeToolCalls(BASE, "k", "gemma-4-26b-a4b-it-4bit", fetch);
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.model).toBe("gemma-4-26b-a4b-it-4bit");
  });

  /** The criterion's failure: the server answered, the model wrote text. */
  test("a prose response fails as `prose`, naming the finish_reason", async () => {
    const { fetch } = jsonFetch(PROSE_BODY);
    const r = await probeNativeToolCalls(BASE, "k", "Qwen3-8B-4bit", fetch);
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("prose");
    expect(r.detail).toContain("prose");
    expect(r.detail).toContain("finish_reason=stop");
    expect(r.detail).toContain("Qwen3-8B-4bit");
  });

  /**
   * BOTH halves are required for a PASS, and this is the case that proves it: a
   * server claiming `finish_reason: tool_calls` over an EMPTY array has not
   * produced a call the worker can act on. Checking the finish reason alone
   * would let it through.
   *
   * It used to be classified `prose` — exit 2 — and that was wrong for the same
   * reason M1 was wrong. A server announcing a finish reason it did not honour
   * is contradicting ITSELF; nothing there is evidence about the model's chat
   * template, so the operator has no `model:` line to fix and must not be sent
   * to look for one. The gate is exactly as strict as before (`ok` is still
   * false); only the blame moved off the model.
   */
  test("finish_reason=tool_calls with an empty array still fails, but not as prose", async () => {
    const { fetch } = jsonFetch({
      choices: [{ message: { tool_calls: [] }, finish_reason: "tool_calls" }],
    });
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    // The load-bearing half: it must NOT pass.
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("inconclusive");
    expect(r.failure).not.toBe("prose");
  });

  /** The converse half: calls present under a non-tool finish reason. */
  test("tool_calls present under finish_reason=length is not a pass", async () => {
    const { fetch } = jsonFetch({
      choices: [
        { message: { tool_calls: [{ id: "x", type: "function" }] }, finish_reason: "length" },
      ],
    });
    expect((await probeNativeToolCalls(BASE, "k", "m", fetch)).ok).toBe(false);
  });

  /**
   * THE case this classification exists for, and the one the suite was missing:
   * the mirror image of the test above.
   *
   * A reasoning model emits a `<think>` preamble before it acts. If that
   * preamble outruns the probe's token budget the server answers
   * `finish_reason: "length"` with no tool_calls — and `prose` used to be the
   * FALL-THROUGH bucket, so that answer was reported as "this model does not
   * emit native tool calls", exit 2, naming a model that had done nothing
   * wrong. This host serves Qwen3.5-* reasoning models, and §5.9's original
   * `Qwen3-8B-4bit` "prose" observation is itself consistent with truncation.
   *
   * Truncation is not evidence about the chat template, so it is not the
   * operator's `model:` line, so it is not exit 2.
   */
  test("finish_reason=length with NO tool_calls is inconclusive, never prose", async () => {
    const { fetch } = jsonFetch({
      choices: [
        {
          message: { role: "assistant", content: "<think>Let me consider" },
          finish_reason: "length",
        },
      ],
    });
    const r = await probeNativeToolCalls(BASE, "k", "Qwen3.5-35B-A3B-4bit", fetch);
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("inconclusive");
    expect(r.failure).not.toBe("prose");
    // And it says WHY, so nobody is sent to change a model that is fine.
    expect(r.detail).toContain("TRUNCATED");
    expect(r.detail).toContain("not evidence");
  });

  /**
   * `prose` is now POSITIVE — `stop` and nothing else. Every other finish
   * reason is a question the probe failed to answer, not an answer.
   */
  test("content_filter, an unknown reason and an absent one are all inconclusive", async () => {
    for (const body of [
      { choices: [{ message: {}, finish_reason: "content_filter" }] },
      { choices: [{ message: {}, finish_reason: "some_future_reason" }] },
      { choices: [{ message: {} }] },
    ]) {
      const { fetch } = jsonFetch(body);
      expect((await probeNativeToolCalls(BASE, "k", "m", fetch)).failure).toBe("inconclusive");
    }
  });

  /**
   * The budget the truncation case turns on. 200 tokens sits inside a reasoning
   * preamble; 2048 clears one. Asserted on the WIRE rather than on the
   * constant, because it is the request the server actually sees that decides
   * whether a model gets cut off mid-thought.
   */
  test("the probe asks for enough tokens to clear a reasoning preamble", async () => {
    let body: Record<string, unknown> = {};
    const fetch = (async (_i: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(TOOL_CALL_BODY), { status: 200 });
    }) as FetchLike;
    await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(body["max_tokens"]).toBeGreaterThanOrEqual(2048);
  });

  test("a network throw fails as `unreachable`, not as prose", async () => {
    const fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    }) as FetchLike;
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(r.ok).toBe(false);
    // The distinction the exit-code split depends on.
    expect(r.failure).toBe("unreachable");
    expect(r.detail).toContain("ECONNREFUSED");
  });

  /**
   * A timeout is not "down" (S1).
   *
   * `AbortSignal.timeout` rejects with a `TimeoutError`, and §5.9 records cold
   * model loads on this host running past 60s — so the old catch-all told the
   * operator to "Start oMLX" about a server that was up and loading their
   * weights. The connection succeeded; only the answer was late.
   *
   * `TimeoutError` is the name the REAL `AbortSignal.timeout` produces under
   * Bun, checked against a live server that never answers rather than taken
   * from the spec.
   */
  test("a timeout is its own class and reads as a cold load, not as 'down'", async () => {
    const fetch = (async () => {
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }) as FetchLike;
    const r = await probeNativeToolCalls(BASE, "k", "big-cold-model", fetch, 60_000);
    expect(r.failure).toBe("timeout");
    expect(r.failure).not.toBe("unreachable");
    // The operator must be told to WAIT, not to restart a healthy server.
    expect(r.detail).toContain("COLD-LOADING");
    expect(r.detail).not.toContain("unreachable");
  });

  test("a non-2xx fails as `unreachable` and reports the status", async () => {
    const { fetch } = jsonFetch({ error: "nope" }, 500);
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(r.failure).toBe("unreachable");
    expect(r.detail).toContain("500");
  });

  /**
   * The body of a non-2xx reaches the operator (S2). A bare status code cannot
   * distinguish "the server is down" from "the server is fine and is telling
   * you exactly what is wrong", and the detail is all the operator sees.
   */
  test("a non-2xx body reaches the operator rather than being discarded", async () => {
    const { fetch } = jsonFetch({ error: { message: "tools are not supported here" } }, 400);
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(r.detail).toContain("tools are not supported here");
  });

  /**
   * A 404 that talks about models is the server saying it does not serve this
   * one — the `model:` line, and therefore a usage error. The old code called
   * it `unreachable` and sent the operator to restart a healthy server.
   */
  test("a model-not-found 404 is classified as the config problem it is", async () => {
    const { fetch } = jsonFetch({ error: { message: "Model 'ghost-model' not found" } }, 404);
    const r = await probeNativeToolCalls(BASE, "k", "ghost-model", fetch);
    expect(r.failure).toBe("model-not-found");
    expect(r.detail).toContain("does not serve it");
  });

  /**
   * …and the narrowing that stops that becoming a NEW misdiagnosis. A 404 with
   * no mention of a model is far more likely a wrong path — a `base_url`
   * missing its `/v1`, or a proxy answering for a route it does not have — and
   * blaming the model for that merely relocates the defect.
   */
  test("a bare 404 is NOT blamed on the model", async () => {
    const fetch = (async () => new Response("Not Found", { status: 404 })) as FetchLike;
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(r.failure).toBe("unreachable");
    expect(r.failure).not.toBe("model-not-found");
  });

  test("a missing API key is called out in the failure detail", async () => {
    const { fetch } = jsonFetch({ error: "auth" }, 401);
    const r = await probeNativeToolCalls(BASE, "", "m", fetch);
    expect(r.detail).toContain("no API key");
  });

  /**
   * A 2xx this code cannot read is the SERVER misbehaving, not the model
   * answering in prose. Folding it into `prose` would exit 2 and send the
   * operator to edit a `model:` line that is fine.
   */
  test("a 200 with no choices[] fails as `malformed`, not `prose`", async () => {
    const { fetch } = jsonFetch({ object: "chat.completion" });
    expect((await probeNativeToolCalls(BASE, "k", "m", fetch)).failure).toBe("malformed");
  });

  test("a 200 with an unreadable body fails as `malformed` and never throws", async () => {
    const fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as FetchLike;
    const r = await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(r.failure).toBe("malformed");
  });

  /**
   * `llm.base_url` is used VERBATIM (ISC-260) — the exact inverse of what this
   * block used to assert, and that inversion IS the criterion.
   *
   * Five tests here pinned `hostFacingBaseUrl`, a helper whose whole job was
   * rewriting the worker-facing `host.docker.internal` to `localhost` so the
   * probe could be issued from the HOST. It is deleted. The probe now runs
   * from a container on `docker.network` (`security/probe-transport.ts`),
   * which is where the workers run — so the URL a worker dials is the URL the
   * probe must dial, and ANY transformation of it would reintroduce precisely
   * the host-vs-worker asymmetry the criterion exists to remove.
   *
   * Pinned on the container-facing spelling specifically, because that is the
   * only one the old code altered. The same assertion written against
   * `127.0.0.1` would pass with the rewrite fully restored and prove nothing.
   */
  test("the base URL reaches the transport verbatim, with no rewriting", async () => {
    const { fetch, calls } = jsonFetch(TOOL_CALL_BODY);
    await probeNativeToolCalls("http://host.docker.internal:8000/v1", "k", "m", fetch);
    expect(calls[0]).toBe("http://host.docker.internal:8000/v1/chat/completions");
    expect(calls[0]).not.toContain("localhost");
  });

  /**
   * The deadline reaches the transport as a NUMBER, not only as a signal.
   *
   * A containerized transport cannot be handed the caller's `AbortSignal` —
   * see `ProbeRequestInit` — so it reads `init.timeoutMs` and REFUSES without
   * one. Nothing else in this suite would notice that field going missing,
   * because every double here honours the signal instead; the failure would
   * surface only in production, as a gate that cannot run at all.
   */
  test("the request carries the deadline as a number, not only as a signal", async () => {
    let seen: number | undefined;
    const fetch = (async (_url, init) => {
      seen = init?.timeoutMs;
      return new Response(JSON.stringify(TOOL_CALL_BODY), { status: 200 });
    }) as FetchLike;
    await probeNativeToolCalls(BASE, "k", "m", fetch, 12_345);
    expect(seen).toBe(12_345);
  });

  /**
   * `tool_choice` must stay UNSET. Forcing `required` would make a compliant
   * server manufacture a call from a model that cannot produce one, which is
   * the exact incompatibility the probe exists to detect.
   */
  test("the request offers a tool and does NOT force tool_choice", async () => {
    let body: Record<string, unknown> = {};
    const fetch = (async (_i: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(TOOL_CALL_BODY), { status: 200 });
    }) as FetchLike;
    await probeNativeToolCalls(BASE, "k", "m", fetch);
    expect(Array.isArray(body["tools"])).toBe(true);
    expect(body["tool_choice"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The assertion `up` actually calls
// ---------------------------------------------------------------------------

/** A LoadedConfig from an in-memory document; no temp files, no network. */
async function load(overrides: {
  workers?: { id: string; role: string }[];
  roles?: Record<string, unknown>;
  llm?: Record<string, unknown>;
}): Promise<LoadedConfig> {
  const doc = {
    version: 2,
    name: "probe-test",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel", ...(overrides.llm ?? {}) },
    roles: overrides.roles ?? { eng: {} },
    workers: overrides.workers ?? [{ id: "w1", role: "eng" }],
  };
  return parseConfig(stringify(doc), join(tmpdir(), "probe-test", "fleet.yaml"));
}

describe("assertModelsSupportToolCalls gates the launch path (ISC-53)", () => {
  test("a passing model does not throw", async () => {
    const loaded = await load({});
    const { fetch } = jsonFetch(TOOL_CALL_BODY);
    await assertModelsSupportToolCalls(loaded, ["w1"], fetch);
  });

  test("a prose model throws NativeToolCallRefusedError with exit 2", async () => {
    const loaded = await load({});
    const { fetch } = jsonFetch(PROSE_BODY);
    let caught: unknown;
    try {
      await assertModelsSupportToolCalls(loaded, ["w1"], fetch);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NativeToolCallRefusedError);
    // ISC-53 names the code, so it is asserted rather than assumed.
    expect((caught as NativeToolCallRefusedError).exitCode).toBe(EXIT.USAGE);
    // Actionable: which worker, which model, and the escape hatch.
    expect((caught as Error).message).toContain("w1");
    expect((caught as Error).message).toContain("DefaultModel");
    expect((caught as Error).message).toContain("require_native_tool_calls");
  });

  /**
   * The exit-code split. oMLX being down says NOTHING about the model, so
   * reporting it as a usage error would send the operator to edit a correct
   * `model:` line instead of starting their inference server.
   */
  test("an unreachable oMLX throws with exit 3, NOT exit 2", async () => {
    const loaded = await load({});
    const fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as FetchLike;
    let caught: unknown;
    try {
      await assertModelsSupportToolCalls(loaded, ["w1"], fetch);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolCallProbeUnavailableError);
    expect((caught as ToolCallProbeUnavailableError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(caught).not.toBeInstanceOf(NativeToolCallRefusedError);
  });

  /**
   * M1 at the gate, which is where it does the damage: a truncated answer must
   * NOT reach the exit-2 path.
   *
   * Before the fix this threw `NativeToolCallRefusedError` and told the
   * operator their model "does not emit native tool calls" — about a model that
   * had been cut off mid-`<think>` by the probe's own 200-token budget. The
   * assertion is on the exit code AND on the class, because the two are what
   * `up` and the operator respectively act on.
   */
  test("a TRUNCATED answer exits 3, not 2 — nothing was learned about the model", async () => {
    const loaded = await load({});
    const { fetch } = jsonFetch({
      choices: [{ message: { content: "<think>" }, finish_reason: "length" }],
    });
    const err = await assertModelsSupportToolCalls(loaded, ["w1"], fetch).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number },
    );
    expect(err).not.toBeNull();
    expect(err).toBeInstanceOf(ToolCallProbeUnavailableError);
    expect(err).not.toBeInstanceOf(NativeToolCallRefusedError);
    expect(err!.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    // It must not tell the operator to go and change a model that is fine.
    expect(err!.message).not.toContain("Point the role at a model");
    expect(err!.message).toContain("did not settle");
  });

  /**
   * S2 at the gate. A model the server does not serve is exit 2 — the operator
   * has a `model:` line to fix — but it is a DIFFERENT edit from "this model
   * cannot do tools", so it is a different error and a different sentence.
   */
  test("a model the server does not serve exits 2, naming the config line", async () => {
    const loaded = await load({});
    const { fetch } = jsonFetch({ error: { message: "Model 'DefaultModel' not found" } }, 404);
    const err = await assertModelsSupportToolCalls(loaded, ["w1"], fetch).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number },
    );
    expect(err).toBeInstanceOf(ModelNotServedError);
    expect(err!.exitCode).toBe(EXIT.USAGE);
    expect(err!.message).toContain("does not serve");
    expect(err!.message).toContain("w1");
    // Not the prose diagnosis: the model may well support tools perfectly.
    expect(err!.message).not.toContain("prose");
  });

  /**
   * S1 at the gate. Still exit 3 — nothing downstream changes — but the
   * REMEDY has to differ, because "Start oMLX" is a wasted trip when oMLX is
   * up and loading the weights that were asked for.
   */
  test("a timeout exits 3 and advises waiting, not restarting", async () => {
    const loaded = await load({});
    const fetch = (async () => {
      const e = new Error("The operation timed out.");
      e.name = "TimeoutError";
      throw e;
    }) as FetchLike;
    const err = await assertModelsSupportToolCalls(loaded, ["w1"], fetch).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number },
    );
    expect(err).toBeInstanceOf(ToolCallProbeUnavailableError);
    expect(err!.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(err!.message).toContain("wait for the load to finish");
    expect(err!.message).not.toContain("Start oMLX");
  });

  /** §5.9: "`require_native_tool_calls: false` disables both". */
  test("require_native_tool_calls: false skips the probe entirely", async () => {
    const loaded = await load({ llm: { require_native_tool_calls: false } });
    const { fetch, calls } = jsonFetch(PROSE_BODY);
    // A prose-answering model must NOT refuse when the gate is off…
    await assertModelsSupportToolCalls(loaded, ["w1"], fetch);
    // …and the network must not have been touched at all.
    expect(calls).toEqual([]);
  });

  /**
   * Six workers on one model is the NORMAL fleet shape (§5.9 F40: six clients,
   * one inference server). Probing per-worker would cost six real generations
   * on the GPU the run is about to compete for.
   *
   * Asserting the CALL COUNT rather than merely "it passed" is the point —
   * without the dedup this test goes red at 3, which is how the claim is
   * falsifiable.
   */
  test("workers sharing a model are probed ONCE, not once each", async () => {
    const loaded = await load({
      workers: [
        { id: "w1", role: "eng" },
        { id: "w2", role: "eng" },
        { id: "w3", role: "eng" },
      ],
    });
    const { fetch, calls } = jsonFetch(TOOL_CALL_BODY);
    await assertModelsSupportToolCalls(loaded, ["w1", "w2", "w3"], fetch);
    expect(calls.length).toBe(1);
  });

  test("distinct models are each probed", async () => {
    const loaded = await load({
      roles: { a: { model: "Model-A" }, b: { model: "Model-B" } },
      workers: [
        { id: "w1", role: "a" },
        { id: "w2", role: "b" },
      ],
    });
    const { fetch, calls } = jsonFetch(TOOL_CALL_BODY);
    await assertModelsSupportToolCalls(loaded, ["w1", "w2"], fetch);
    expect(calls.length).toBe(2);
  });

  /** A refusal names every worker on the offending model, not just the first. */
  test("a refusal names all the workers sharing the bad model", async () => {
    const loaded = await load({
      workers: [
        { id: "w1", role: "eng" },
        { id: "w2", role: "eng" },
      ],
    });
    const { fetch } = jsonFetch(PROSE_BODY);
    /**
     * `.then(onOk, onErr)` rather than `.catch`, so the resolve path is a
     * distinguishable `null` instead of the `void` a bare `.catch` leaves
     * unioned in. The original spelling did not typecheck (`Property 'message'
     * does not exist on type 'void | Error'`) and — worse — would have read
     * `undefined.message` and thrown a TypeError had the gate ever failed to
     * refuse, reporting the wrong defect for the right failure.
     */
    const err = await assertModelsSupportToolCalls(loaded, ["w1", "w2"], fetch).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("w1");
    expect(err!.message).toContain("w2");
  });

  /**
   * Same membership skip as the ISC-52 gate: a `--workers` id the config does
   * not define is a Phase 1 `PIFLEET_PI_COMMAND` double with no model to probe.
   */
  test("an id absent from workers: is skipped, not refused", async () => {
    const loaded = await load({});
    const { fetch, calls } = jsonFetch(PROSE_BODY);
    await assertModelsSupportToolCalls(loaded, ["ghost-1"], fetch);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// doctor's chat-model selection (ISC-55)
// ---------------------------------------------------------------------------

describe("chatProbeModel keeps doctor's latency probe off embedding models", () => {
  test("an embedding id is recognised by name", () => {
    expect(isEmbeddingModelId("Qwen3-Embedding-4B-4bit-DWQ")).toBe(true);
    expect(isEmbeddingModelId("text-embedding-3-small")).toBe(true);
    expect(isEmbeddingModelId("gemma-4-26b-a4b-it-4bit")).toBe(false);
    expect(isEmbeddingModelId("Qwen3.5-35B-A3B-4bit")).toBe(false);
  });

  /**
   * The live defect, frozen: this is the exact model list this host served on
   * 2026-08-18, embedding model FIRST. `models[0]` picked it and the completion
   * probe got HTTP 500, so ISC-55's number was never reported.
   */
  test("the first NON-embedding model is chosen when no config names one", () => {
    const served = ["Qwen3-Embedding-4B-4bit-DWQ", "Qwen3.5-35B-A3B-4bit", "gemma-4-26b-a4b-it-4bit"];
    expect(chatProbeModel(null, served)).toBe("Qwen3.5-35B-A3B-4bit");
  });

  /**
   * A configured model always wins. Second-guessing the operator would report
   * a latency for a model no worker in the fleet actually runs.
   */
  test("a configured model is used verbatim, even if it looks like an embedding model", () => {
    expect(chatProbeModel("my-embedding-thing", ["chat-a"])).toBe("my-embedding-thing");
  });

  test("an all-embedding server still gets probed rather than silently skipped", () => {
    expect(chatProbeModel(null, ["a-embedding", "b-embed"])).toBe("a-embedding");
  });

  test("no models served yields no probe model", () => {
    expect(chatProbeModel(null, [])).toBeNull();
  });
});
