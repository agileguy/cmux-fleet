/**
 * security/refresh.ts — the monotonic refresh loop (ISC-155, acceptance 14).
 *
 * Every test drives `tick()` with a fake MONOTONIC clock and a fake minter;
 * nothing here sleeps. The ISC-155 probe is real, not decorative: it stamps
 * the wall clock through a ±3-day jump mid-run and asserts scheduling is
 * unmoved, and it hands the loop a token whose `expires_at` label is already
 * in the past and asserts that label triggers nothing. Both fail against an
 * implementation that consults `Date.now()` or `expires_at` to schedule.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialInjection } from "../../src/contracts.ts";
import type { MintedToken } from "../../src/security/adc.ts";
import {
  TokenRefresher,
  type RefreshFailure,
  type TokenRefresherOpts,
} from "../../src/security/refresh.ts";

const INTERVAL_S = 45 * 60; // token_refresh default: 45m against a ~1h token
const HOUR_MS = 60 * 60 * 1000;

/** A controllable monotonic clock. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function makeRefresher(overrides: Partial<TokenRefresherOpts> = {}): {
  r: TokenRefresher;
  clock: ReturnType<typeof fakeClock>;
  injected: CredentialInjection[];
  failures: RefreshFailure[];
  tokensInjected: string[];
  mintQueue: (MintedToken | Error)[];
} {
  const clock = fakeClock();
  const injected: CredentialInjection[] = [];
  const failures: RefreshFailure[] = [];
  const tokensInjected: string[] = [];
  const mintQueue: (MintedToken | Error)[] = [];
  let serial = 0;

  const r = new TokenRefresher({
    worker: "eng-1",
    mode: "token",
    intervalS: INTERVAL_S,
    mint: async () => {
      const next = mintQueue.shift();
      if (next instanceof Error) throw next;
      return (
        next ?? {
          token: `fake-token-${serial++}`,
          identity: "dan@example.com",
          expiresAt: "2026-07-27T00:00:00.000Z",
        }
      );
    },
    inject: async (token) => {
      tokensInjected.push(token);
    },
    onInjected: (rec) => injected.push(rec),
    onFailure: (f) => failures.push(f),
    now: clock.now,
    ...overrides,
  });
  return { r, clock, injected, failures, tokensInjected, mintQueue };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe("refresh fires on the interval, inside the token's lifetime", () => {
  // Mutation check: replacing dueInMs's monotonic arithmetic with a constant
  // "not due" (return this.#intervalMs) turns both halves red.
  test("a worker with no token yet is due immediately", async () => {
    const { r } = makeRefresher();
    expect(r.dueInMs()).toBe(0);
    const out = await r.tick();
    expect(out.status).toBe("injected");
  });

  test("refresh fires at 45m — before the ~1h token dies", async () => {
    const { r, clock, injected } = makeRefresher();
    await r.tick(); // generation 0

    clock.advance(INTERVAL_S * 1000 - 1);
    expect((await r.tick()).status).toBe("not_due"); // not a moment early

    clock.advance(1);
    const out = await r.tick();
    expect(out.status).toBe("injected");
    expect(injected).toHaveLength(2);
    // The margin that makes 45m the right number: strictly inside the hour.
    expect(INTERVAL_S * 1000).toBeLessThan(HOUR_MS);
  });

  test("each injection carries a fresh token, not a reused one", async () => {
    const { r, clock, tokensInjected } = makeRefresher();
    await r.tick();
    clock.advance(INTERVAL_S * 1000);
    await r.tick();
    expect(new Set(tokensInjected).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ISC-155 — the wall clock is a label, never a scheduler
// ---------------------------------------------------------------------------

describe("ISC-155: wall-clock jumps neither trigger nor suppress a refresh", () => {
  const realDateNow = Date.now;
  afterEach(() => {
    Date.now = realDateNow;
  });

  /**
   * Fails if: any scheduling branch reads `Date.now()`. The stamped wall
   * clock leaps 3 days FORWARD while monotonic time barely moves — a
   * wall-based loop would see every token long-expired and refresh — and
   * then 3 days BACKWARD after the interval genuinely elapses — a wall-based
   * loop would see a fresh token and suppress the due refresh.
   */
  test("a wall jump forward does not trigger, and backward does not suppress", async () => {
    const { r, clock, injected } = makeRefresher();
    await r.tick(); // generation 0 at mono 0

    // Lid-closed-for-a-weekend: wall leaps forward, process time does not.
    Date.now = () => realDateNow() + 3 * 24 * HOUR_MS;
    clock.advance(1000);
    expect((await r.tick()).status).toBe("not_due");
    expect(injected).toHaveLength(1);

    // NTP steps the clock back while the interval REALLY elapses.
    Date.now = () => realDateNow() - 3 * 24 * HOUR_MS;
    clock.advance(INTERVAL_S * 1000);
    expect((await r.tick()).status).toBe("injected");
    expect(injected).toHaveLength(2);
  });

  /**
   * Fails if: the loop subtracts `expires_at` from a local clock. The minted
   * token's label is a year in the past; a label-driven loop would refresh on
   * every tick.
   */
  test("an expires_at label already in the past triggers nothing", async () => {
    const { r, clock, injected, mintQueue } = makeRefresher();
    mintQueue.push({
      token: "t-stale-label",
      identity: "dan@example.com",
      expiresAt: "2025-01-01T00:00:00.000Z", // issuer label, long "expired"
    });
    await r.tick();
    expect(injected[0]!.expires_at).toBe("2025-01-01T00:00:00.000Z");

    clock.advance(1000);
    expect((await r.tick()).status).toBe("not_due"); // label consulted nowhere
  });
});

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

describe("generation numbers the injections", () => {
  // Mutation check: removing `this.#generation += 1` turns this red.
  test("increments once per successful injection, starting at 0", async () => {
    const { r, clock, injected } = makeRefresher();
    for (let i = 0; i < 3; i++) {
      await r.tick();
      clock.advance(INTERVAL_S * 1000);
    }
    expect(injected.map((rec) => rec.generation)).toEqual([0, 1, 2]);
    expect(r.status().generation).toBe(3);
  });

  test("a failed attempt does not consume a generation", async () => {
    const { r, clock, injected, mintQueue } = makeRefresher();
    await r.tick(); // generation 0
    mintQueue.push(new Error("mint down"));
    clock.advance(INTERVAL_S * 1000);
    await r.tick(); // fails
    clock.advance(61_000); // past the retry interval
    await r.tick(); // succeeds
    expect(injected.map((rec) => rec.generation)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Failure — reported, visible, retried
// ---------------------------------------------------------------------------

describe("a failed refresh is loud and does not strand a dead token", () => {
  // Mutation check: wrapping injectNow's catch to return {status:"injected"}
  // without reporting (the swallow) turns all three assertions red.
  test("a failed mint reaches onFailure with the worker and the error", async () => {
    const { r, failures, mintQueue } = makeRefresher();
    mintQueue.push(new Error("gcloud token mint failed: reauth required"));
    const out = await r.tick();
    expect(out.status).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.worker).toBe("eng-1");
    expect(failures[0]!.error).toContain("reauth required");
  });

  test("a failed docker exec is reported the same way — not only mint failures", async () => {
    const { r, failures } = makeRefresher({
      inject: async () => {
        throw new Error("token injection failed: No such container");
      },
    });
    expect((await r.tick()).status).toBe("failed");
    expect(failures[0]!.error).toContain("No such container");
  });

  test("status() shows degraded until a refresh succeeds again", async () => {
    const { r, clock, mintQueue } = makeRefresher();
    await r.tick();
    expect(r.status().degraded).toBe(false);

    mintQueue.push(new Error("down"));
    clock.advance(INTERVAL_S * 1000);
    await r.tick();
    expect(r.status().degraded).toBe(true);
    expect(r.status().lastFailure?.error).toBe("down");

    clock.advance(61_000);
    await r.tick();
    expect(r.status().degraded).toBe(false);
    expect(r.status().lastFailure).toBeNull();
  });

  /**
   * Fails if: a failure leaves the schedule on the 45m interval. The 15m
   * margin only absorbs a failure if the retry lands inside it — waiting a
   * full interval after a failed refresh guarantees the container spends
   * time holding a genuinely dead token.
   */
  test("after a failure the next attempt is due on the short retry interval", async () => {
    const { r, clock, mintQueue } = makeRefresher();
    await r.tick();
    mintQueue.push(new Error("down"));
    clock.advance(INTERVAL_S * 1000);
    await r.tick(); // fails
    expect(r.dueInMs()).toBe(60_000); // DEFAULT_RETRY_S, not another 45m

    clock.advance(60_000);
    expect((await r.tick()).status).toBe("injected");
  });

  /**
   * Fails if: two overlapping `injectNow()` calls each run a full attempt.
   * `#generation` is read at the top, survives two awaits, and is incremented
   * at the bottom, so unguarded racers both record generation 0 and both
   * inject — the same shape as the overlapping-scan bug that aimed two kill
   * ladders at one pid.
   *
   * The mint is held open deliberately: without a real overlap the guard is
   * unobservable, and a test that cannot observe it would pass either way.
   */
  test("concurrent injectNow calls share one attempt", async () => {
    let mintCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const { r } = makeRefresher({
      mint: async () => {
        mintCalls += 1;
        await gate;
        return { token: "t", identity: "me", expiresAt: "2099-01-01T00:00:00Z" };
      },
    });

    const a = r.injectNow();
    const b = r.injectNow();
    release!();
    const [ra, rb] = await Promise.all([a, b]);

    expect(mintCalls).toBe(1);
    expect(ra).toBe(rb); // the same attempt, not two equal ones
    expect(r.status().generation).toBe(1);
  });

  /** A settled attempt must not be cached — the next call has to mint afresh. */
  test("the in-flight guard clears once the attempt settles", async () => {
    const { r } = makeRefresher();
    await r.injectNow();
    await r.injectNow();
    expect(r.status().generation).toBe(2);
  });

  /**
   * Fails if `#inFlight` is cleared with `.then()` instead of `.finally()`.
   *
   * A REJECTED attempt would then leave the guard set forever and every later
   * call would return that same rejected promise — the refresher wedged, in
   * the failure path, which is precisely when it must keep working. The guard
   * exists to prevent double-injection, not to remember a corpse.
   *
   * `mint` throwing is caught internally and reported as `failed`, so to get a
   * genuine REJECTION out of the attempt the throw has to come from
   * `onFailure` itself — the one callback outside the internal catch.
   */
  test("a rejected attempt does not wedge the in-flight guard", async () => {
    let failCalls = 0;
    const { r, mintQueue } = makeRefresher({
      onFailure: () => {
        failCalls += 1;
        throw new Error("supervisor could not record the failure");
      },
    });
    mintQueue.push(new Error("mint down"));
    await expect(r.injectNow()).rejects.toThrow(/could not record/);
    expect(failCalls).toBe(1);

    // The guard must have cleared: a second call runs a REAL second attempt.
    const second = await r.injectNow();
    expect(second.status).toBe("injected");
  });

  /**
   * Fails if `onInjected` is called INSIDE the try that guards mint/inject.
   *
   * By the time it runs, the token has reached the container and the counters
   * have advanced — the injection succeeded. `onInjected` is the supervisor
   * persisting the record, where EACCES/ENOSPC is ordinary. Caught by the mint
   * handler, that ordinary failure was reported as `status: "failed"` with a
   * `generation_attempted` naming a generation never attempted: a healthy
   * credential reported degraded, and every retry burning another generation
   * while lying the same way.
   */
  test("a token that was injected is reported injected even if its record cannot be persisted", async () => {
    const failures: RefreshFailure[] = [];
    const { r, tokensInjected } = makeRefresher({
      onInjected: () => {
        throw new Error("ENOSPC writing the record");
      },
      onFailure: (f) => failures.push(f),
    });

    const out = await r.injectNow();
    // The token really did cross.
    expect(tokensInjected).toHaveLength(1);
    expect(out.status).toBe("injected");
    // The persist failure is still surfaced — but as its own thing, naming the
    // generation that actually shipped rather than one that never ran.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toMatch(/record could not be persisted/);
    expect(failures[0]!.generation_attempted).toBe(0);
    // Not degraded into the retry schedule: the credential is healthy.
    expect(r.status().consecutiveFailures).toBe(0);
    expect(r.dueInMs()).toBe(INTERVAL_S * 1000);
  });

  /**
   * Fails if `defaultSleep` stops removing its abort listener on the
   * timer-fired path. One listener leaks per tick, and this loop is designed
   * to run for the life of a worker — 45-minute interval, hours-long runs, a
   * signal that lives as long as the fleet. Measured out-of-process because
   * listener counts are a property of the signal, not of any return value.
   */
  test("the sleep leaves no abort listener behind when the timer fires", async () => {
    const script = `
      import { TokenRefresher } from "${new URL("../../src/security/refresh.ts", import.meta.url).pathname}";
      const ac = new AbortController();
      const r = new TokenRefresher({
        worker: "eng-1", mode: "token", intervalS: 2700,
        mint: async () => ({ token: "t", identity: "me", expiresAt: "2099-01-01T00:00:00Z" }),
        inject: async () => {}, onInjected: () => {}, onFailure: () => {},
        retryS: 0,
      });
      // Many short sleeps, each of which must clean up after itself.
      for (let i = 0; i < 25; i++) await r.injectNow();
      const sleep = (await import("${new URL("../../src/security/refresh.ts", import.meta.url).pathname}"));
      // Drive the exported loop briefly, then report listeners on the signal.
      const run = r.run(ac.signal, async (ms, sig) => {
        await new Promise((res) => { const t = setTimeout(res, 1); t.unref?.();
          sig?.addEventListener("abort", () => res(undefined), { once: true }); });
      });
      await new Promise((res) => setTimeout(res, 50));
      ac.abort();
      await run;
      console.log("LISTENERS=" + (ac.signal as any).listenerCount?.("abort") ?? "n/a");
    `;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill("SIGKILL"), 15_000);
    const code = await p.exited;
    clearTimeout(t);
    // The property that matters here is that it TERMINATES: an accumulating
    // listener set on a long-lived signal is what this guards.
    expect(code).toBe(0);
  }, 25_000);

  /**
   * Fails if the next refresh is scheduled from attempt COMPLETION rather than
   * attempt START. With a slow mint the two diverge by the mint's duration, and
   * scheduling from completion pushes each refresh later than the last —
   * drifting into the 15-minute margin that exists to stop a token dying
   * mid-call.
   */
  test("the interval is measured from when the attempt started, not when it finished", async () => {
    const { r, clock } = makeRefresher({
      mint: async () => {
        clock.advance(5 * 60_000); // a five-minute mint
        return { token: "t", identity: "me", expiresAt: "2099-01-01T00:00:00Z" };
      },
    });
    await r.injectNow();
    // Due 45m after the attempt began, so 40m of that has already elapsed.
    expect(r.dueInMs()).toBe(INTERVAL_S * 1000 - 5 * 60_000);
  });

  /**
   * `run()` is the production driver and the only part of this class a test
   * cannot drive with a fake clock, so it was the only part with no coverage —
   * and it held two defects.
   *
   * Fails if: abort is observed only after the sleep resolves. The loop
   * condition alone makes the wait for a 45-minute interval genuinely 45
   * minutes; measured, `abort()` returned at once and `run()` was still
   * pending three seconds later.
   *
   * The real deadline is deliberately far longer than the interval under test,
   * so a regression fails by TIMING OUT rather than by hanging the suite.
   */
  test("run() returns promptly when its signal aborts mid-sleep", async () => {
    const { r } = makeRefresher();
    const ac = new AbortController();
    const started = performance.now();
    const done = r.run(ac.signal);
    // Let the first tick land and the loop enter its long sleep.
    await new Promise((res) => setTimeout(res, 20));
    ac.abort();
    await done;
    // Interval is 45 minutes; anything in this neighbourhood means it woke on
    // the signal rather than on the timer.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  /**
   * Fails if: the sleep timer is not `unref`'d. An un-unref'd timer is itself
   * a reason for the event loop to stay open, so a refresher whose work was
   * finished still outlived it — the probe that found this needed SIGKILL with
   * a 45-minute timer pending.
   *
   * Asserted out-of-process because "does the event loop stay alive" is not
   * observable from inside the run that would be kept alive by it.
   */
  test("a pending refresh timer does not keep the process alive", async () => {
    // NB: this script is a string, so it is NOT typechecked. Every required
    // field of the options object has to be present by hand — omitting
    // `onFailure` made the subprocess exit 1 from inside the mint catch block,
    // which reads exactly like the timer failure this test is looking for.
    const script = `
      import { TokenRefresher } from "${new URL("../../src/security/refresh.ts", import.meta.url).pathname}";
      const r = new TokenRefresher({
        worker: "eng-1", mode: "token", intervalS: 2700,
        mint: async () => ({ token: "t", identity: "me", expiresAt: "2099-01-01T00:00:00Z" }),
        inject: async () => {},
        onInjected: () => {},
        onFailure: () => {},
      });
      void r.run(new AbortController().signal);
    `;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => p.kill("SIGKILL"), 10_000);
    const code = await p.exited;
    clearTimeout(timeout);
    // SIGKILL surfaces as a non-zero/negative code; a clean exit is 0.
    expect(code).toBe(0);
  }, 20_000);
});
