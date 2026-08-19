/**
 * `doctor` REPORTS the oMLX surface — the stub-backed half of ISC-54/55.
 *
 * ## Why this file exists
 *
 * ISC-54 ("`doctor` reports the oMLX model list") and ISC-55 ("`doctor` reports
 * a measured single-request latency") were closed on the evidence of
 * `test/integration/model-probe.test.ts`, which is `test.skipIf(!LIVE)` and
 * needs a real Apple-silicon inference server. That self-skip is CORRECT — CI
 * has no oMLX and never will — but it left both criteria with no
 * machine-checkable evidence at all: the only proof either had was a one-off
 * local run transcribed into a PR body, reproducible by nobody and re-checked
 * by nothing.
 *
 * Both criteria are statements about what `doctor` REPORTS, and reporting is
 * exactly the half a stub can prove. So the split is:
 *
 *  - HERE, in CI, on every push: the plumbing. `GET /v1/models` reaches
 *    `omlx.models`; the completion round trip reaches
 *    `omlx.completion_latency_ms`; the configured model is the one probed; a
 *    failed completion does not take the model list down with it.
 *  - THERE, in the live suite, on a machine with a real server: that the
 *    number describes a real generation on real hardware. A stub would report
 *    a measurement of the stub, and §5.9 F40 wants this number to size
 *    `max_concurrent` against real throughput.
 *
 * Neither half is sufficient. A stub-only suite proves this code agrees with
 * this code's idea of oMLX; a live-only suite proves nothing on any machine
 * but one. The ISA close-out for ISC-54/55 records which half is which rather
 * than implying both are covered.
 *
 * ## Why a subprocess and a real socket
 *
 * `probeOmlx` in `cli/commands/doctor.ts` calls the global `fetch` and takes no
 * injectable double, and the criteria are about `doctor --json`'s OUTPUT — so
 * calling the probe directly would test the probe and leave the reporting, the
 * part an operator consumes, untested. A real loopback server on an
 * OS-assigned port costs milliseconds and exercises the whole path.
 *
 * The exit code is deliberately NOT asserted, for the same reason the live
 * suite does not: `doctor` exits nonzero when ANY diagnosis is present, and a
 * developer machine legitimately carries unrelated ones (no cmux, a stopped
 * daemon, a missing image). Those say nothing about oMLX, the JSON is printed
 * before the failing exit is thrown, and requiring a clean bill of health for
 * the whole host would make ISC-54/55 fail for reasons outside ISC-54/55.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * The models this stub serves.
 *
 * Deliberately NOT the model the config names, except for one. `doctor`
 * reporting an echo of `llm.model`, a hardcoded list, or a stale cache would
 * all satisfy "non-empty" — so the list is asserted set-equal to this, and two
 * of the three ids are strings no fleet.yaml in this file ever writes. That is
 * the same discrimination the live suite gets from a real server's 32 models,
 * made deterministic.
 */
const SERVED = ["stub-chat-model", "stub-embedding-model", "stub-other-model"];

/** The model the config names, and therefore the one `chatProbeModel` must pick. */
const CONFIGURED = "stub-chat-model";

/**
 * How long the stub takes to answer a completion.
 *
 * The point of ISC-55 is that the number is MEASURED, and a stub that answers
 * instantly cannot distinguish a real measurement from a constant — worse, a
 * loopback round trip can round to 0ms, which would make `> 0` flaky rather
 * than meaningful. A deliberate floor makes the assertion both deterministic
 * and about the right property: the reported value has to track elapsed time.
 */
const COMPLETION_DELAY_MS = 40;

interface StubOmlx {
  baseUrl: string;
  /** Paths received, in order. */
  requests: string[];
  /**
   * How long the completion handler ACTUALLY held the response, measured on
   * the same monotonic clock rather than assumed from the requested delay.
   *
   * The floor assertion below compares the reported latency against THIS, not
   * against `COMPLETION_DELAY_MS`. See `delayAtLeast` for why the difference
   * is load-bearing: a sleep is a request, not a guarantee, and a test that
   * treats a requested delay as a measured one fails for reasons that have
   * nothing to do with the property it is defending (ISC-267).
   */
  observedDelayMs: number | null;
  stop: () => Promise<void>;
}

/**
 * Hold for at least `ms`, verified against the clock rather than requested.
 *
 * `Bun.sleep(n)` is a REQUEST to be woken no earlier than `n`, and treating it
 * as a hard floor is what made `doctor-omlx.test.ts` fail 374-pass/1-fail in
 * CI with `Expected: >= 40, Received: 39` (ISC-267). Measured 400 trials on
 * macOS/bun 1.3.11: `Bun.sleep(40)` never resumed early (min 40.032ms) — so
 * the defect does not reproduce on the maintainer's machine at all, and only
 * appears on the Linux runner. That asymmetry is exactly why the fix is to
 * stop depending on the timer's precision rather than to tune a margin.
 *
 * This loop re-sleeps the remainder until the monotonic clock agrees the
 * deadline has passed, so it cannot return early no matter what the timer
 * does. Measured over the same 400 trials: min 40.001ms, zero early returns.
 * It still yields to the event loop each iteration, which matters because
 * this runs inside the server's own request handler.
 */
async function delayAtLeast(ms: number): Promise<number> {
  const t0 = performance.now();
  const deadline = t0 + ms;
  while (performance.now() < deadline) {
    await Bun.sleep(Math.max(1, deadline - performance.now()));
  }
  return performance.now() - t0;
}

/**
 * An oMLX-shaped server: a model list, and a completion endpoint whose
 * behaviour the caller chooses.
 *
 * Port 0 — the OS picks a free one. A hardcoded port collides with a
 * developer's own oMLX, or with a second checkout, and the resulting failure
 * looks like a bug in `doctor` rather than in the harness.
 */
function stubOmlx(opts: { completionStatus?: number; completionDelayMs?: number } = {}): StubOmlx {
  const requests: string[] = [];
  let observedDelayMs: number | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: SERVED.map((id) => ({ id, object: "model" })) });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const status = opts.completionStatus ?? 200;
        if (status !== 200) {
          return Response.json({ error: { message: "stub refuses" } }, { status });
        }
        observedDelayMs = await delayAtLeast(opts.completionDelayMs ?? COMPLETION_DELAY_MS);
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      }
      return Response.json({ error: "unexpected path" }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    get observedDelayMs() {
      return observedDelayMs;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** A minimal valid fleet.yaml whose job is to name `llm.model` and `llm.base_url`. */
async function configNaming(baseUrl: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-doctor-omlx-"));
  bases.push(base);
  const path = join(base, "fleet.yaml");
  await writeFile(
    path,
    [
      "version: 2",
      "name: doctor-omlx-stub",
      "docker:",
      '  pi_version: "0.79.6"',
      "run:",
      `  repo: ${base}`,
      "  budget:",
      "    tokens_ceiling: 1000000",
      "llm:",
      `  model: ${CONFIGURED}`,
      `  base_url: ${baseUrl}`,
      "roles:",
      "  engineer: {}",
      "workers:",
      "  - {id: eng-1, role: engineer}",
      "",
    ].join("\n"),
  );
  return path;
}

interface OmlxJson {
  ok: boolean;
  base_url: string;
  models: string[];
  list_latency_ms: number | null;
  completion_latency_ms: number | null;
  probe_model: string | null;
  detail: string;
}

async function doctorOmlx(configPath: string): Promise<OmlxJson> {
  const p = Bun.spawn([process.execPath, CLI, "doctor", "--json", "-c", configPath], {
    env: {
      ...process.env,
      /**
       * A literal placeholder, never the developer's real key.
       *
       * The stub does not check authorization, so the VALUE is irrelevant to
       * what is asserted — but leaving the ambient `OMLX_API_KEY` in place
       * would make a real credential travel to a test server, and would make
       * the run behave differently depending on whether the developer had
       * exported one. Pinned so the test means the same thing everywhere.
       */
      OMLX_API_KEY: "stub-key-not-a-real-credential",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`doctor --json emitted no JSON object:\n${stdout}`);
  return (JSON.parse(stdout.slice(start)) as Record<string, unknown>)["omlx"] as OmlxJson;
}

describe("doctor reports the oMLX model list (ISC-54, stub-backed)", () => {
  test(
    "the list doctor prints is the one the server served, not an echo of the config",
    async () => {
      const stub = stubOmlx();
      try {
        const omlx = await doctorOmlx(await configNaming(stub.baseUrl));

        expect(omlx.ok).toBe(true);
        // Set-equal, not merely non-empty: a hardcoded list, a stale cache or a
        // report of the CONFIGURED model would each satisfy non-emptiness, and
        // none of them is "reports the oMLX model list".
        expect([...omlx.models].sort()).toEqual([...SERVED].sort());
        // …and specifically it carries ids the config never names, which is
        // what makes it the SERVER's list rather than a reflection of input.
        expect(omlx.models).toContain("stub-embedding-model");
        expect(omlx.models).toContain("stub-other-model");
        expect(omlx.models.filter((m) => m !== CONFIGURED).length).toBe(2);

        // The list really was fetched, from the endpoint the config named.
        expect(stub.requests).toContain("/v1/models");
        expect(omlx.base_url).toBe(stub.baseUrl);
      } finally {
        await stub.stop();
      }
    },
    30_000,
  );
});

describe("doctor reports a measured completion latency (ISC-55, stub-backed)", () => {
  test(
    "the number tracks elapsed time and names the model it was measured against",
    async () => {
      const stub = stubOmlx();
      try {
        const omlx = await doctorOmlx(await configNaming(stub.baseUrl));

        // The number the criterion names.
        expect(omlx.completion_latency_ms).not.toBeNull();
        expect(Number.isFinite(omlx.completion_latency_ms)).toBe(true);
        /**
         * MEASURED, not stamped in. The stub holds the response, so a value
         * below that floor means the reported figure is not the round trip — a
         * constant, a clock read twice, or a number invented somewhere else
         * would all fail here.
         *
         * The floor is the delay the stub OBSERVED ITSELF TAKING, not the one
         * it was asked for, and that distinction is the whole of ISC-267. The
         * assertion used to read `>= COMPLETION_DELAY_MS`, which treats
         * `Bun.sleep(40)` as a guarantee; it is a request. That failed in CI —
         * `Expected: >= 40, Received: 39`, 374 pass / 1 fail — for a reason
         * with nothing to do with the property being defended.
         *
         * This form CANNOT be flaky, because the client's interval strictly
         * contains the server's: the client starts its clock before the
         * request and stops it after reading the body, so its elapsed time is
         * always greater than the handler's own hold. `Math.round` is monotonic
         * non-decreasing, so `round(client) >= round(server)` follows.
         *
         * And it is no weaker. A stamped-in constant, a clock read twice, or a
         * zero still fails against a ~40ms floor. The floor is additionally
         * asserted to be substantial below, so the fixture cannot quietly
         * degrade into asserting `>= 0`, which is the way a fix like this
         * could otherwise swallow the mechanism it is protecting.
         */
        const observed = stub.observedDelayMs;
        expect(observed).not.toBeNull();
        expect(observed!).toBeGreaterThanOrEqual(COMPLETION_DELAY_MS);
        expect(omlx.completion_latency_ms!).toBeGreaterThanOrEqual(Math.round(observed!));
        // A plausible ceiling: still a measurement, not a timeout.
        expect(omlx.completion_latency_ms!).toBeLessThan(30_000);

        /**
         * AND IT TRACKS, which the floor above does NOT establish on its own.
         *
         * Found while fixing ISC-267, by mutation rather than by reading:
         * replacing the measurement with `report.completionLatencyMs = 42` —
         * a stamped-in constant, exactly what this test's comment claimed to
         * catch — left the suite GREEN, because 42 clears a 40ms floor. The
         * old assertion could only catch a constant SMALLER than the delay.
         * A floor is a statement about magnitude; "tracks elapsed time", which
         * is what this test is named for, is a statement about VARIATION, and
         * nothing here was making it.
         *
         * So the probe is run a second time against a stub that holds roughly
         * four times as long, and the reported figure has to move with it. Any
         * constant now fails whatever its value, because no single number can
         * satisfy both floors at once.
         *
         * The margin is deliberately loose — half the added delay — because
         * the property under test is that the number MOVES, not that it moves
         * precisely. A tight margin here would re-introduce exactly the
         * timing-sensitivity ISC-267 is about.
         */
        const slowDelayMs = COMPLETION_DELAY_MS * 4;
        const slowStub = stubOmlx({ completionDelayMs: slowDelayMs });
        try {
          const slow = await doctorOmlx(await configNaming(slowStub.baseUrl));
          expect(slow.completion_latency_ms).not.toBeNull();
          expect(slowStub.observedDelayMs).not.toBeNull();
          expect(slow.completion_latency_ms!).toBeGreaterThanOrEqual(
            Math.round(slowStub.observedDelayMs!),
          );
          const added = slow.completion_latency_ms! - omlx.completion_latency_ms!;
          expect(added).toBeGreaterThanOrEqual((slowDelayMs - COMPLETION_DELAY_MS) / 2);
        } finally {
          await slowStub.stop();
        }

        // Measured against the model the CONFIG named — which is what makes the
        // number relevant to sizing this fleet's `max_concurrent` (§5.9 F40).
        expect(omlx.probe_model).toBe(CONFIGURED);
        expect(stub.requests).toContain("/v1/chat/completions");

        // The list probe is a separate measurement and must also be real.
        expect(omlx.list_latency_ms).not.toBeNull();
        expect(omlx.list_latency_ms!).toBeGreaterThanOrEqual(0);
        /**
         * And it is genuinely separate: the list is not delayed, so reporting
         * one figure for both — or reusing the completion's timer — shows up
         * as the list latency having swallowed the completion's floor.
         */
        expect(omlx.list_latency_ms!).toBeLessThan(COMPLETION_DELAY_MS);
      } finally {
        await stub.stop();
      }
    },
    // ISC-266 audit: stands. Two `doctorOmlx` spawns derive cliBudget(2) =
    // 22_800 ms; measured idle is 1964-2039 ms. Not reduced.
    30_000,
  );

  /**
   * The ISC-55 defect shape, held open.
   *
   * The original bug was a completion probe that returned HTTP 500 (an
   * embedding model picked off `models[0]`), leaving `completion_latency_ms`
   * null. The fix was model SELECTION — but the reporting has to degrade
   * honestly either way: a failed completion must not be reported as a
   * latency, and must not take the model list down with it.
   */
  test(
    "a failing completion nulls the latency and says why, without losing the model list",
    async () => {
      const stub = stubOmlx({ completionStatus: 500 });
      try {
        const omlx = await doctorOmlx(await configNaming(stub.baseUrl));

        // No number is better than a wrong number.
        expect(omlx.completion_latency_ms).toBeNull();
        expect(omlx.detail).toContain("500");
        // The list is an independent measurement and survives.
        expect([...omlx.models].sort()).toEqual([...SERVED].sort());
        expect(omlx.list_latency_ms).not.toBeNull();
      } finally {
        await stub.stop();
      }
    },
    30_000,
  );
});
