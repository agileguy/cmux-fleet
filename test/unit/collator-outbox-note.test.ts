/**
 * THE CONSOLE SAYS WHETHER A SILENT LENS' OUTBOX IS EMPTY — SRD-REVIEW-CONSOLE
 * §6.6.
 *
 * ## The measured defect
 *
 * `rev-lang-1` produced a complete 12,759-byte review, wrote it to
 * `/outbox/R-rally-async-6-lang/artifact.json` — the TASK ROOT, under a name it
 * invented — and wrote no `result.json` and no `files/`. The collation brief
 * said:
 *
 *     MISSING ASPECT: lang (rev-lang-1) — it settled `unknown` and no report
 *     reached the collator.
 *
 * **Every word of that is true and it is the whole finding.** The harvest's two
 * readers look at `result.json` and at `files/`; a file at the task root under
 * any other name is invisible to both, so the console had no way to distinguish
 * a reviewer that produced NOTHING from one whose 12,759 bytes were sitting one
 * directory from a reader. What is added here is the missing fact, and only the
 * fact: **is that outbox empty, or does it hold things nothing here reads.**
 *
 * ## THE ASYMMETRIC PAIR IS THE FIRST TEST, and it is one test
 *
 * A probe whose two fixtures are both empty, or both populated, passes against
 * an implementation that always says "empty" and against one that always says
 * "not empty" alike — this branch has shipped nine of those. The pair below runs
 * ONE fan-out in which two lenses fail identically in every respect except the
 * listing their harvests carry, and asserts on the difference between their two
 * notes. A fixture drift that collapses the two states cannot pass it by half.
 *
 * ## WHAT THE WORDING MAY NOT DO, which is most of what is asserted here
 *
 * The listing is names and sizes. It is taken by `readdir` plus `lstat` and the
 * bytes are NEVER read, because this sentence lands in a model's prompt and the
 * outbox is worker-authored. So:
 *
 *   - The note may not claim a file IS the review. It cannot know that.
 *   - *"produced no report"* must stay available for the genuinely empty case —
 *     that distinction is the entire value being added, and a new clause that
 *     swallowed it would be the same defect wearing the opposite sign.
 *   - The `unreadable` and `present` arms are NOT touched. The taxonomy is not
 *     being re-decided; a fact is being added to the two arms where no envelope
 *     exists.
 */

import { describe, expect, test } from "bun:test";

import {
  DISPATCH_REQUEST_SCHEMA,
  parseDispatchRequest,
  type DispatchRequest,
} from "../../src/run/dispatch-request.ts";
import {
  MAX_NAMED_UNRECOGNISED_ENTRIES,
  type TaskOutboxListing,
} from "../../src/harvest/task-outbox.ts";
import type { RunPaths } from "../../src/run/paths.ts";
import {
  consoleTransport,
  relayFanOut,
  type RelayChild,
  type RelayDispatch,
  type RelayEffects,
  type RelayEnvelopeState,
  type RelayHarvest,
  type RelayOutboxListing,
  type RelayOutcome,
  type RelayTaskRef,
  type RelayTransport,
} from "../../src/run/relay.ts";

const PARENT = "T";
const COL = "col-1";
const ARCH = "rev-arch-1";
const CTX = "rev-ctx-1";
const LANG = "rev-lang-1";

type Run = string;

const RUNS = new Map<string, Run>([
  [COL, "run/col"],
  [ARCH, "run/arch"],
  [CTX, "run/ctx"],
  [LANG, "run/lang"],
]);

/**
 * The one unrecognised file the live defect actually produced.
 *
 * Typed as the HARVESTER'S shape, deliberately, so every fixture in this file
 * is a value the harvester could really have produced rather than one hand-built
 * to relay's wider spelling.
 */
const REVIEW_AT_TASK_ROOT: TaskOutboxListing = {
  kind: "unrecognised",
  named: [{ name: "artifact.json", kind: "file", bytes: 12_759 }],
  total: 1,
};

/**
 * EVERY ARM OF `TaskOutboxListing` SATISFIES `RelayOutboxListing`, checked by
 * the compiler.
 *
 * The two are spelled independently — `relay.ts` is reached through a dynamic
 * import and must not carry `src/harvest/` in its type graph, which is the rule
 * `RelayUnreadableEnvelope` follows for the same reason. That independence is
 * exactly how two vocabularies for one fact come to drift, so the relationship
 * is ASSERTED rather than assumed, and asserted in the direction it is actually
 * used: harvester to relay.
 *
 * All three arms, because the `unrecognised` one is the only one with a nested
 * shape and is therefore the only one that can drift silently — a check that
 * used `empty` alone would compile forever while `named` changed underneath it.
 */
const _structural: readonly RelayOutboxListing[] = [
  REVIEW_AT_TASK_ROOT,
  { kind: "empty" } satisfies TaskOutboxListing,
  { kind: "unlistable" } satisfies TaskOutboxListing,
];
void _structural;

function okRequest(workers: readonly string[]): DispatchRequest {
  const body = JSON.stringify({
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: PARENT,
    requests: workers.map((w) => ({
      worker: w,
      title: `review ${w}`,
      brief: `read the diff as ${w}`,
    })),
  });
  const read = parseDispatchRequest(body, { sender: COL, taskId: PARENT });
  if (read.kind !== "ok") throw new Error("fixture is not a valid request");
  return read.request;
}

interface Opts {
  /** Verdict per WORKER; anything unnamed settles `success`. */
  readonly verdicts?: Readonly<Record<string, RelayHarvest["verdict"]>>;
  readonly envelopes?: Readonly<Record<string, RelayEnvelopeState>>;
  readonly outboxes?: Readonly<Record<string, RelayOutboxListing>>;
}

/**
 * Keyed by WORKER rather than by derived child task id, so a fixture cannot
 * silently attach its listing to a task that does not exist — a mis-keyed map
 * degrades to "no listing", which is a state the production code also has, and
 * a probe that passed by accidentally exercising it would prove nothing.
 */
class Fake implements RelayTransport<Run> {
  constructor(private readonly opts: Opts = {}) {}

  async dispatch(_run: Run, _d: RelayDispatch): Promise<void> {}
  async awaitSettled(_run: Run, _t: RelayTaskRef): Promise<void> {}

  async harvest(_run: Run, t: RelayTaskRef): Promise<RelayHarvest> {
    return {
      verdict: this.opts.verdicts?.[t.worker] ?? "success",
      reply: { task: t.taskId },
      envelope: this.opts.envelopes?.[t.worker],
      outbox: this.opts.outboxes?.[t.worker],
    };
  }

  async publishReplies(): Promise<void> {}
}

function collated(o: RelayOutcome): Extract<RelayOutcome, { kind: "collated" }> {
  if (o.kind !== "collated") throw new Error(`expected a collation, got ${o.kind}`);
  return o;
}

async function fanOut(opts: Opts, workers = [ARCH, CTX, LANG]) {
  return collated(
    await relayFanOut({
      request: okRequest(workers),
      sender: COL,
      runs: RUNS,
      transport: new Fake(opts),
    }),
  );
}

function child(out: Awaited<ReturnType<typeof fanOut>>, aspect: string): RelayChild {
  const c = out.children.find((x) => x.aspect === aspect);
  if (c === undefined) throw new Error(`no child for aspect ${aspect}`);
  return c;
}

describe("a missing lens' note says whether its outbox was empty", () => {
  /**
   * THE PAIR. `context` and `lang` fail identically — same verdict, same
   * absence of any envelope — and differ ONLY in what their outbox listing
   * says. Both halves in one test, because the value being added IS the
   * difference between them.
   */
  test("an empty outbox and one holding an unrecognised file do not produce the same note", async () => {
    const out = await fanOut({
      verdicts: { [CTX]: "unknown", [LANG]: "unknown" },
      outboxes: { [CTX]: { kind: "empty" }, [LANG]: REVIEW_AT_TASK_ROOT },
    });

    const ctx = child(out, "context").note;
    const lang = child(out, "lang").note;

    expect(ctx).not.toBe(lang);
    // The populated one NAMES the file and its size; the empty one cannot.
    expect(lang).toContain("artifact.json");
    expect(lang).toContain("12759");
    expect(ctx).not.toContain("artifact.json");
    expect(ctx).not.toContain("12759");
  });

  /**
   * THE HONEST EDGE. An outbox holding `notes.txt` and one holding a complete
   * review are IDENTICAL from names and sizes, so the note may not assert that
   * a review was found — it may only say what was there and that nothing opened
   * it.
   *
   * ## Why this asserts the DISCLAIMER and not merely the absence of a phrase
   *
   * The first draft of this test forbade the substring `is the review`, and the
   * first draft of the note contained *"whether any of it is the review is
   * unknown"* — a hedge, matched by a probe hunting for a claim. That is the
   * defect this branch keeps finding in its own probes, arriving in prose: a
   * pattern that matches the thing it is checking for the absence of. So the
   * load-bearing assertion is the POSITIVE one — the note must carry the
   * disclaimer — and the negative is narrowed to phrasings that can only be
   * assertions, never hedges.
   */
  test("the note disclaims knowledge of the contents rather than claiming a review", async () => {
    const note = child(
      await fanOut({ verdicts: { [LANG]: "unknown" }, outboxes: { [LANG]: REVIEW_AT_TASK_ROOT } }),
      "lang",
    ).note;
    // Positive: it says outright that nothing opened these bytes.
    expect(note).toContain("nothing here opened them");
    expect(note).toContain("a person has to look");
    // Negative: no form of words that would ASSERT what is in them.
    expect(note).not.toMatch(
      /\b(?:holds|contains|found) the (?:review|report)\b|\bthe (?:review|report) is (?:in|at)\b/i,
    );
  });

  /**
   * The strong true claim survives. `absent` is the state where somebody looked
   * for an envelope and there was none, and *"produced no report"* is a FACT
   * there — weakening it would be the opposite over-correction, leaving a
   * console that can no longer say the true strong thing where it is true.
   */
  test("an absent envelope over an empty outbox still says the reviewer produced no report", async () => {
    const note = child(
      await fanOut({
        verdicts: { [LANG]: "unknown" },
        envelopes: { [LANG]: { kind: "absent" } },
        outboxes: { [LANG]: { kind: "empty" } },
      }),
      "lang",
    ).note;
    expect(note).toContain("produced no report");
  });

  /**
   * AND IT DOES NOT SURVIVE A POPULATED OUTBOX UNQUALIFIED. The bare claim is
   * what the live defect said; here the outbox listing contradicts the reading
   * a person would take from it, and the note has to carry that.
   */
  test("an absent envelope over a populated outbox carries the contradiction", async () => {
    const note = child(
      await fanOut({
        verdicts: { [LANG]: "unknown" },
        envelopes: { [LANG]: { kind: "absent" } },
        outboxes: { [LANG]: REVIEW_AT_TASK_ROOT },
      }),
      "lang",
    ).note;
    expect(note).toContain("NOT EMPTY");
    expect(note).toContain("artifact.json");
  });

  /**
   * THE SECOND ASYMMETRIC PAIR, and the one that keeps the empty arm honest.
   *
   * *"Checked, and bare"* and *"never checked"* are DIFFERENT FACTS, and the
   * first is the only one that supports trusting *"produced no report"*. An
   * implementation that said nothing for `empty` would still pass the first
   * pair in this file — `empty` and `unrecognised` would still differ — while
   * leaving an operator unable to tell a verified-bare outbox from one nothing
   * ever listed. That is the ambiguity this whole change exists to remove, so
   * it gets its own pair rather than riding on another test's fixture.
   */
  test("an outbox checked and found bare does not read the same as one never checked", async () => {
    const out = await fanOut({
      verdicts: { [CTX]: "unknown", [LANG]: "unknown" },
      // `context` was listed and was bare. `lang` was never listed at all.
      outboxes: { [CTX]: { kind: "empty" } },
    });

    const checked = child(out, "context").note;
    const never = child(out, "lang").note;

    expect(checked).not.toBe(never);
    expect(checked).toContain("WAS checked");
    expect(never).not.toContain("WAS checked");
  });

  /**
   * NOBODY LOOKED IS NOT AN EMPTY OUTBOX. `unlistable` and a wholly absent
   * listing must both leave the sentence exactly as it was, because neither is
   * evidence about the reviewer — the same restraint that keeps `null` out of
   * the `absent` arm.
   */
  test("an unlistable outbox and no listing at all both leave the note unchanged", async () => {
    const out = await fanOut({
      verdicts: { [CTX]: "unknown", [LANG]: "unknown" },
      outboxes: { [LANG]: { kind: "unlistable" } },
    });
    const bare = "it settled `unknown` and no report reached the collator";
    expect(child(out, "lang").note).toBe(bare);
    expect(child(out, "context").note).toBe(bare);
  });

  /**
   * A seat that was never dispatched has no outbox to list and no note about
   * one. Its note is about DISPATCH and must stay about dispatch.
   */
  test("a seat the request never named gains no outbox clause", async () => {
    const out = await fanOut({ verdicts: { [ARCH]: "unknown" } }, [ARCH, CTX]);
    const lang = child(out, "lang");
    expect(lang.outbox).toBeNull();
    expect(lang.note).toBe("the request never named this reviewer, so the lens was not applied");
  });

  /**
   * THE TAXONOMY IS NOT BEING RE-DECIDED. Where an envelope was found, the
   * outbox listing adds nothing an operator needs — the finding already names
   * the file to open — and a second inventory beside it would be noise that
   * dilutes the one actionable path.
   */
  test("the unreadable and present arms are untouched by a populated outbox", async () => {
    const out = await fanOut({
      verdicts: { [CTX]: "unknown", [LANG]: "failed" },
      envelopes: {
        [CTX]: {
          kind: "unreadable",
          path: "/o/T/result.json",
          bytes: 3906,
          code: "not_json",
          detail: "bad escape",
        },
        [LANG]: { kind: "present" },
      },
      outboxes: { [CTX]: REVIEW_AT_TASK_ROOT, [LANG]: REVIEW_AT_TASK_ROOT },
    });
    for (const aspect of ["context", "lang"]) {
      expect(child(out, aspect).note).not.toContain("artifact.json");
    }
    // The unreadable arm still makes its own strong, specific claim.
    expect(child(out, "context").note).toContain("WAS WRITTEN AND COULD NOT BE READ");
  });

  /**
   * BOUNDED, AND IT SAYS SO. A worker can write hundreds of files into its task
   * root; a note that named them all would be its own denial of the brief, and
   * one that named eight silently would leave the collator believing the list
   * is complete.
   */
  test("a large listing is capped and the note declares the truncation", async () => {
    const total = MAX_NAMED_UNRECOGNISED_ENTRIES + 32;
    const note = child(
      await fanOut({
        verdicts: { [LANG]: "unknown" },
        outboxes: {
          [LANG]: {
            kind: "unrecognised",
            named: Array.from({ length: MAX_NAMED_UNRECOGNISED_ENTRIES }, (_, i) => ({
              name: `f${i}.txt`,
              kind: "file" as const,
              bytes: 10,
            })),
            total,
          },
        },
      }),
      "lang",
    ).note;
    expect(note).toContain(`${total}`);
    expect(note).toContain("32 more not named");
  });

  /**
   * The count is the diagnosis: one stray file is a mistake, forty is something
   * else. A note built only from `named.length` would report both as eight.
   */
  test("the note reports the true total, not the length of the named list", async () => {
    const note = child(
      await fanOut({
        verdicts: { [LANG]: "unknown" },
        outboxes: {
          [LANG]: {
            kind: "unrecognised",
            named: [{ name: "a.txt", kind: "file", bytes: 1 }],
            total: 40,
          },
        },
      }),
      "lang",
    ).note;
    expect(note).toContain("40 entries");
  });

  /**
   * Sizes and kinds are rendered, and the three non-file kinds carry NO size —
   * a number beside a symlink would be read as a measurement of its target,
   * which was never taken.
   */
  test("directories and symlinks are named without a size", async () => {
    const note = child(
      await fanOut({
        verdicts: { [LANG]: "unknown" },
        outboxes: {
          [LANG]: {
            kind: "unrecognised",
            named: [
              { name: "scratch", kind: "directory", bytes: null },
              { name: "link", kind: "symlink", bytes: null },
            ],
            total: 2,
          },
        },
      }),
      "lang",
    ).note;
    expect(note).toContain("scratch/ (directory, not descended)");
    expect(note).toContain("link (symlink, not followed)");
    expect(note).not.toContain("null");
  });

  /** The brief is where the collator actually reads this. */
  test("the collation brief carries the finding on the lens' own MISSING ASPECT line", async () => {
    const out = await fanOut({
      verdicts: { [LANG]: "unknown" },
      outboxes: { [LANG]: REVIEW_AT_TASK_ROOT },
    });
    const line = out.collation.brief
      .split("\n")
      .find((l) => l.startsWith("MISSING ASPECT: lang"));
    expect(line).toBeDefined();
    expect(line).toContain("artifact.json (12759 bytes)");
  });

  /** The lens carries the listing as a VALUE, so nothing downstream must parse English. */
  test("the listing is carried onto the child, not only into its prose", async () => {
    const out = await fanOut({
      verdicts: { [LANG]: "unknown" },
      outboxes: { [LANG]: REVIEW_AT_TASK_ROOT },
    });
    expect(child(out, "lang").outbox).toEqual(REVIEW_AT_TASK_ROOT);
  });
});

/**
 * THE ADAPTER POINT — the one expression where the harvester's listing becomes
 * the relay's.
 *
 * The core above is driven by a hand-built transport, so every assertion in it
 * is green against a production adapter that drops the field on the floor. That
 * is the shape this repo keeps finding in itself: a mechanism that is present,
 * tested and invoked, over an input nothing supplies. These two probes are the
 * whole of what the adapter can get wrong, and they are opposites — one for
 * dropping the fact, one for inventing it.
 */
describe("consoleTransport carries the harvester's outbox listing", () => {
  const RUN = { root: "/runs/r1" } as unknown as RunPaths;

  /** The harvest bundle a `RelayEffects` hands back, with `taskOutbox` under control. */
  function effectsReturning(taskOutbox: TaskOutboxListing | undefined): RelayEffects {
    return {
      async sendTask() {
        return { accepted: true, via: "staged", reason: null, error: null, epoch: 1 };
      },
      async deliveryPlane() {
        return "staged";
      },
      async listTaskOutbox() {
        // This file's subject is the listing that rides on a SUCCESSFUL
        // harvest; the failed-harvest listing is a different seam and asserting
        // nothing about it here keeps the two probes from sharing a fixture.
        return { kind: "unlistable" as const };
      },
      async readTaskRecord() {
        return null;
      },
      async harvestTask() {
        return {
          harvest: { verdict: "unknown" as const, derived: { artifacts: [] } },
          unreadableEnvelope: null,
          ...(taskOutbox === undefined ? {} : { taskOutbox }),
        };
      },
      async readArtifact() {
        return { text: "", unreadable: null };
      },
      async publishReplies() {},
      now: () => 0,
      async sleep() {},
    };
  }

  test("a listing the harvester made reaches the relay unchanged", async () => {
    const t = consoleTransport(COL, effectsReturning(REVIEW_AT_TASK_ROOT));
    const got = await t.harvest(RUN, { worker: LANG, taskId: "T-lang" });
    expect(got.outbox).toEqual(REVIEW_AT_TASK_ROOT);
  });

  /**
   * SILENCE IS NOT AN EMPTY OUTBOX, at this seam either. A bundle with no
   * listing means nobody looked, and turning that into `empty` would assert
   * that a reviewer left nothing behind on the strength of a `readdir` that
   * never ran — the original defect, one seam further down, in the direction
   * that reads as helpful.
   */
  test("a bundle carrying no listing yields no listing, never an empty one", async () => {
    const t = consoleTransport(COL, effectsReturning(undefined));
    const got = await t.harvest(RUN, { worker: LANG, taskId: "T-lang" });
    expect(got.outbox).toBeUndefined();
  });
});
