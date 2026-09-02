/**
 * The attempt id a task file gets when it does not name one (ISC-458, §9 Q9).
 *
 * ## The defect this was written against, found by reading the code the
 * ## decision record claimed to describe
 *
 * `ISA.md`'s Group Z decisions state Q9 as ANSWERED — "derived from the task
 * file's CONTENT" — and the reason given is that a random id "would give the
 * staged route no dedup at all … which is the shape of a feature that looks
 * delivered."
 *
 * The staged route disagreed with that sentence. It ignored the caller's
 * attempt id and sent `String(envelope.attempt)` — and `attempt` DEFAULTS to
 * `1`, so every fresh staged dispatch used the key `(task_id, "1")`. **That is
 * worse than no dedup**: two DIFFERENT briefs sharing a `task_id` collided, and
 * the second one replayed the first — same epoch, drop file deliberately not
 * rewritten on a replay, `replayed: true` reported as success. The operator
 * edits the brief, stages it, is told it worked, and the worker still holds the
 * old one.
 *
 * A missing dedup runs work twice and the transcript shows it; a too-coarse
 * dedup silently substitutes one brief for another and every surface reports
 * success.
 *
 * ## The RPC route keeps `randomUUID()`, and the first fix here was too wide
 *
 * This derivation was briefly the fallback on every route, argued from the
 * claim that a random id let a re-dispatch RUN THE TASK TWICE. **That claim was
 * false.** `allocate` refuses a settled task `already_completed` and a live one
 * `busy`, both keyed on `task_id` alone, so a random attempt id never caused a
 * second run. What it actually costs there is narrower: a caller that loses an
 * ack mid-flight re-sends and gets `busy` instead of its original answer.
 *
 * The widening had a concrete cost and an existing criterion caught it. With a
 * content id, re-dispatching a completed task becomes the SAME attempt, so
 * `allocate` replays it — and `test/e2e/lifecycle.test.ts` pins ISC-85's
 * Phase-1 exit shape as `accepted: false` / `already_completed`. Both are the
 * no-op ISC-85 asks for; only the wire shape differs. Redefining a graded
 * Phase-1 criterion is not this block's to do, and §9 Q9 asks about a staged
 * dispatch and nothing else.
 *
 * ## What these probes are, and the one that is not decorative
 *
 * The identity properties below (deterministic, edit-sensitive, not random)
 * are cheap and would each pass against several wrong implementations. The
 * test that carries the criterion is the last one: two different files with the
 * SAME task id, run against a real `EpochManager`, must allocate two epochs —
 * because that is the operator motion the defect broke, expressed against the
 * component that actually decides it.
 */

import { describe, expect, test } from "bun:test";
import { attemptIdFor } from "../../src/cli/commands/dispatch.ts";
import { EpochManager } from "../../src/rpc/epoch.ts";

const SOURCE = new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname;

const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const taskFile = (brief: string): string =>
  // As the route derives it: the PARSED file re-serialized, so a reformat is
  // not a new task while an edited brief is.
  JSON.stringify({ task_id: "t-1", title: "a task", brief });

describe("an unnamed attempt id is derived from the file, not minted", () => {
  test("the same bytes give the same id, twice", () => {
    const raw = taskFile("do the thing");
    expect(attemptIdFor(raw)).toBe(attemptIdFor(raw));
  });

  /**
   * THE ANTI-CRITERION, stated as a property rather than as an absence of
   * `randomUUID`. Two calls in the same process returning the same value is
   * something no random source does, and it holds however the derivation is
   * later reimplemented.
   */
  test("it is not random — a second call is not a second id", () => {
    const ids = new Set(Array.from({ length: 8 }, () => attemptIdFor(taskFile("x"))));
    expect(ids.size).toBe(1);
  });

  test("an edited file is a different attempt", () => {
    expect(attemptIdFor(taskFile("do the thing"))).not.toBe(
      attemptIdFor(taskFile("do the OTHER thing")),
    );
  });

  /**
   * Sensitive to a one-character edit, which is the case a coarser derivation
   * would miss. A brief whose only change is a negation is a different task and
   * must not replay the old epoch.
   */
  test("one character of CONTENT is enough", () => {
    expect(attemptIdFor(taskFile("do it"))).not.toBe(attemptIdFor(taskFile("do It")));
  });

  test("it is legible in a ledger row and cannot be confused with --auto's", () => {
    const id = attemptIdFor(taskFile("x"));
    expect(id).toStartWith("file:");
    expect(id).not.toStartWith("auto:");
    expect(id.length).toBeLessThan(32);
  });
});

describe("the routes take the caller's attempt id rather than re-deriving one", () => {
  /**
   * The rpc route KEEPS `randomUUID()`, and that is the corrected scope rather
   * than an oversight. A fresh attempt is what reaches `already_completed` on a
   * settled task, which is ISC-85's pinned Phase-1 shape in
   * `test/e2e/lifecycle.test.ts`. Widening the derivation to that route turned
   * a refusal into a replay — the same no-op, a different wire shape, and not
   * this document's criterion to redefine.
   */
  test("the rpc route still mints a fresh attempt id", async () => {
    const text = code(await Bun.file(SOURCE).text());
    expect(text).toContain("randomUUID()");
  });

  /**
   * …and the STAGED route does not reach it. The fork must take the derived id,
   * or a re-stage of an unchanged file is refused `busy` instead of replaying.
   */
  test("the staged fork is handed the derived id, not the minted one", async () => {
    const text = code(await Bun.file(SOURCE).text());
    expect(text).toContain("attemptId: args.stagedAttemptId");
    expect(text).toContain("attemptIdFor(JSON.stringify(args.partial))");
  });

  /**
   * The specific re-derivation that caused the collision. `envelope.attempt` is
   * a small integer that defaults to 1; using it as an attempt id makes every
   * first dispatch of every task share a key.
   */
  test("the staged route does not rebuild an id out of envelope.attempt", async () => {
    const text = await Bun.file(SOURCE).text();
    const from = text.indexOf("async function stageForAdoptedTerminal");
    expect(from).toBeGreaterThan(-1);
    const body = code(text.slice(from));
    expect(body).not.toContain("String(envelope.attempt)");
    expect(body).toContain("attempt_id: attemptId");
  });
});

describe("the dedup this buys, against the allocator that decides it", () => {
  /**
   * THE CRITERION. Same task id, two different files — the operator edited the
   * brief and staged again. Under the defect these shared the key `(t-1, "1")`
   * and the second call replayed epoch 1 while the drop file kept the FIRST
   * brief. Here the second call must be a real decision about a real second
   * attempt.
   *
   * It comes back `busy` rather than with a fresh epoch, and that is the
   * correct answer and worth asserting precisely: the first attempt is still
   * live, so the worker is held. **`busy` is the operator being told the truth;
   * `replayed` was the operator being told a lie.** The distinction the
   * criterion is about is not which of the two answers arrives, it is that the
   * allocator gets to make the choice at all — under the defect it was never
   * asked, because the key matched.
   */
  test("a different brief under the same task id is not mistaken for a replay", () => {
    const em = new EpochManager();
    const first = attemptIdFor(taskFile("do the thing"));
    const second = attemptIdFor(taskFile("do the OTHER thing"));
    expect(first).not.toBe(second);

    const a = em.allocate("t-1", first, null);
    expect(a.ok).toBe(true);

    const b = em.allocate("t-1", second, null);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("busy");
  });

  /**
   * THE CONTROL, and without it the test above proves only that two strings
   * differ. The UNEDITED file must still replay — that is the property the
   * derivation exists to provide, and the one a "just use a fresh id every
   * time" fix would destroy while keeping the test above green.
   */
  test("the same file staged twice replays the original epoch", () => {
    const em = new EpochManager();
    const id = attemptIdFor(taskFile("do the thing"));

    const a = em.allocate("t-1", id, null);
    expect(a.ok).toBe(true);
    const b = em.allocate("t-1", id, null);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.replayed).toBe(true);
      expect(b.epoch).toBe(a.epoch);
    }
  });
});
