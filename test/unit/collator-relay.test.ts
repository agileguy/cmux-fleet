/**
 * The fan-out, the join, and the collation decision — `src/run/relay.ts`.
 * SRD-REVIEW-CONSOLE §6.6, §6.7, §6.9, D4, D5, D6, D7, D11.
 *
 * **Named `collator-relay` rather than `relay` because `relay.test.ts` is taken,
 * and by something unrelated.** `src/security/relay.ts` is the EGRESS relay —
 * the docker network proxy of SRD §5.6 — and it owns `relay.test.ts` plus
 * `relay-hosted-resolution`, `relay-mount-preflight` and
 * `relay-provider-bridges`. Two subsystems legitimately called "relay" now
 * exist, in different directories, and the one thing that must not happen is a
 * later reader assuming this file covers that module or a later author adding
 * cases for that module here. The prefix is the disambiguation.
 *
 * `dispatch-request.test.ts` covers whether a request may be ACTED ON. This file
 * covers what acting on it does, and the two hazards it is written against are
 * not the ones a reader expects, because neither of them produces a failure
 * anybody sees.
 *
 * - **The fan-out goes sequential and the console keeps working.** Three
 *   reviewers dispatched one after another still produce three reports, still
 *   produce a collation, still produce a document an operator reads. What is
 *   gone is the only thing the console measures: §1.3's consensus bands are
 *   arithmetic over INDEPENDENT readers, and `3/3` over a chain where each
 *   reader saw the previous reader's findings is one reader with three
 *   transcripts. §6.6 calls this an anti-criterion rather than a preference
 *   because a sequential fan-out "would look like a smarter design while
 *   destroying the only instrument the console has" — a maintainer who wires the
 *   awaits in the obvious order has made the console lie, and every test that
 *   counts dispatches stays green.
 *
 *   **Two tests are needed and neither covers the other.** Sequencing and
 *   contamination are independent defects. A sequential fan-out that still
 *   builds every brief up front passes the independence assertion; a concurrent
 *   fan-out that pasted a reply into a brief passes the overlap assertion. Only
 *   the pair covers the anti-criterion, and the mutation table in the handover
 *   records that each mutation reddens exactly one of them — which is the
 *   evidence that neither is redundant.
 *
 * - **A partial review reports as a whole one.** §6.6: "a collator that does not
 *   know it is missing a lens will write a confident three-lens conclusion from
 *   two — and `report` has no way to detect that." So no assertion here is "a
 *   brief exists" or "a collation was dispatched"; each is that the brief NAMES
 *   the aspect that is missing, in a form provably absent for the aspects that
 *   are not. A brief that listed all three lenses unconditionally would satisfy
 *   the first phrasing and none of these.
 *
 * Two smaller ones, each with a plausible wrong implementation:
 *
 * - **`timed_out` gets fed to the lattice.** `contracts.ts:71-79` is
 *   `failed < blocked < partial < success`, and `rank()` answers `-1` for a
 *   supervisor verdict, so a `min` over `timed_out` is not a smaller number — it
 *   is arithmetic over a value the lattice does not contain. The join must
 *   partition on `success` alone and carry the supervisor's verdict through
 *   verbatim rather than folding it to `failed`, because the fold is what makes
 *   the record say a reviewer produced a failing review when what happened is
 *   that it never reported.
 *
 * - **The request reaches aspect assignment.** D11 puts the aspect→worker map in
 *   config, and the schema already refuses a request that NAMES a model or a
 *   lens. What is left is the quieter route: a request influencing the map by
 *   ORDER or by COUNT. Both are tested, because both read as harmless.
 */
import { describe, expect, test } from "bun:test";

import { rank } from "../../src/contracts.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  MAX_DISPATCH_ID_CHARS,
  parseDispatchRequest,
  type DispatchRequest,
} from "../../src/run/dispatch-request.ts";
import { replyMountPath } from "../../src/run/replies.ts";
import {
  COLLATION_ASPECT,
  MAX_RELAY_TASK_ID_CHARS,
  REVIEW_CONSOLE_ASPECTS,
  RelayAspectError,
  childTaskId,
  collationTaskId,
  isCollationTaskId,
  relayFanOut,
  type AspectSeat,
  type RelayDispatch,
  type RelayEnvelopeState,
  type RelayHarvest,
  type RelayOutcome,
  type RelayTaskRef,
  type RelayTransport,
} from "../../src/run/relay.ts";

const PARENT = "T";
const COL = "col-1";
const ARCH = "rev-arch-1";
const CTX = "rev-ctx-1";
const LANG = "rev-lang-1";

/**
 * A run handle relay is not allowed to understand.
 *
 * The production handle is `RunPaths` and there are FOUR of them (D4 — every
 * `pane_mode: tui` pane runs its own `pifleet up --attach-here`, so the console
 * is four runs and the actor holds a worker→run map, not a run). Relay is
 * generic over the handle precisely so this test can prove it never reads one:
 * a bare `string` satisfies the type, so an implementation that reached into a
 * run for a secret, a socket path or a task record would stop COMPILING here
 * rather than work in production and be untestable.
 */
type Run = string;

const RUNS = new Map<string, Run>([
  [COL, "run/col"],
  [ARCH, "run/arch"],
  [CTX, "run/ctx"],
  [LANG, "run/lang"],
]);

/**
 * A request that has actually been through the validator.
 *
 * Hand-building a `DispatchRequest` literal was the alternative and it is the
 * one that rots: relay's input is BY DEFINITION a request `readDispatchRequest`
 * answered `ok` for, so a fixture that never met the schema tests relay against
 * an input relay cannot receive. It also means a schema change that invalidates
 * these shapes fails HERE, rather than silently widening what relay is believed
 * to accept.
 */
function okRequest(
  entries: ReadonlyArray<{ worker: string; title?: string; brief?: string }>,
  parent = PARENT,
): DispatchRequest {
  const body = JSON.stringify({
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: parent,
    requests: entries.map((e) => ({
      worker: e.worker,
      title: e.title ?? `review ${e.worker}`,
      brief: e.brief ?? `read the diff as ${e.worker}`,
    })),
  });
  const read = parseDispatchRequest(body, { sender: COL, taskId: parent });
  if (read.kind !== "ok") {
    throw new Error(
      `fixture is not a valid request: ${read.kind === "refused" ? read.reason : read.kind}`,
    );
  }
  return read.request;
}

const ALL_THREE = () => okRequest([{ worker: ARCH }, { worker: CTX }, { worker: LANG }]);

/**
 * A gate that resolves only once `n` callers are inside it AT THE SAME TIME.
 *
 * **It never rejects, and that is deliberate.** A rejecting barrier would
 * surface a sequential fan-out as a transport error, and a transport error is a
 * state relay is allowed to have opinions about — the test would then be
 * asserting on relay's error handling rather than on its ORDERING, and would go
 * green again the moment someone made dispatch failures tolerable (which is
 * exactly what `a child whose dispatch never landed` below requires). Timing
 * out and recording the fact keeps the fan-out running to completion and leaves
 * the evidence as a value read afterwards, so the assertion that fails is the
 * one about concurrency.
 */
function barrier(n: number, ms: number) {
  let arrived = 0;
  const waiting: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  const gate = {
    timedOut: false,
    arrivals: 0,
    async arrive(): Promise<void> {
      arrived += 1;
      gate.arrivals = arrived;
      if (arrived >= n) {
        for (const w of waiting) {
          clearTimeout(w.timer);
          w.resolve();
        }
        waiting.length = 0;
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          gate.timedOut = true;
          resolve();
        }, ms);
        waiting.push({ resolve, timer });
      });
    },
  };
  return gate;
}

interface FakeOptions {
  /** Verdict per child task id; anything unnamed settles `success`. */
  readonly verdicts?: Readonly<Record<string, RelayHarvest["verdict"]>>;
  /**
   * What the harvest found of each child's RESULT ENVELOPE.
   *
   * Unnamed children report nothing at all — `undefined` — which is the shape a
   * transport that does not inspect envelopes has, and is deliberately NOT the
   * same fixture as one that looked and found none. See
   * `envelopeStates` below for why that third state has to exist here.
   */
  readonly envelopes?: Readonly<Record<string, RelayEnvelopeState>>;
  /** Child task ids whose dispatch call rejects. */
  readonly dispatchFails?: readonly string[];
  /** Hold every dispatch until this many are inside it at once. */
  readonly gate?: ReturnType<typeof barrier>;
}

/**
 * The transport, recorded rather than performed.
 *
 * The four methods are the four host operations the actor performs, and each is
 * injected rather than imported for a reason that is specific to it:
 * `controlCall` needs a `RunPaths` and a run secret; **no `waitForTerminal`
 * helper exists in this repository at all** (`pifleet wait` and the scheduler
 * each poll the task record inline, and neither is reusable), so `awaitSettled`
 * is a seam whose production implementation has to be written by the process
 * that owns the poll interval; `harvestTask` runs acceptance commands in a
 * container; and `publishReply` writes a `0444` file into a `:ro` mount. Every
 * one of those is a socket, a container or a filesystem, and none of them can
 * appear in a unit test.
 *
 * `briefs` holds the EXACT bytes each child was dispatched with, because the
 * independence property is about bytes: a brief that merely summarised another
 * reviewer's finding would defeat a `toContain` assertion, so the marker each
 * harvest returns is an opaque token that cannot be paraphrased into existence.
 */
class FakeTransport implements RelayTransport<Run> {
  readonly log: string[] = [];
  readonly briefs = new Map<string, string>();
  readonly dispatched: RelayDispatch[] = [];
  readonly runsSeen = new Map<string, Run>();
  readonly replies = new Map<string, unknown>();

  constructor(private readonly opts: FakeOptions = {}) {}

  /** The distinctive finding child `taskId` reports; nothing else may contain it. */
  static marker(taskId: string): string {
    return `FINDING-${taskId.toUpperCase()}-4f21b9`;
  }

  async dispatch(run: Run, d: RelayDispatch): Promise<void> {
    this.log.push(`dispatch:enter:${d.taskId}`);
    this.briefs.set(d.taskId, d.brief);
    this.dispatched.push(d);
    this.runsSeen.set(d.taskId, run);
    // The gate holds the three CHILD dispatches only. The collation is issued
    // after the join by construction, so letting it through a released barrier
    // would count a fourth arrival and make the assertion below say something
    // other than what it means.
    if (this.opts.gate && !isCollationTaskId(d.taskId)) await this.opts.gate.arrive();
    if (this.opts.dispatchFails?.includes(d.taskId)) {
      this.log.push(`dispatch:fail:${d.taskId}`);
      // The real one rejects here too: `controlCall` throws `SocketRequestError`
      // on an unreachable socket, and answers `{accepted:false, reason:
      // "pane_mode_tui_has_no_rpc_dispatch"}` for a `tui` worker — which D13
      // makes reachable, since the implementation §0.7 records makes all four
      // panes `tui`. The adapter turns both into a rejection.
      throw new Error(`dispatch refused for ${d.taskId}`);
    }
    this.log.push(`dispatch:exit:${d.taskId}`);
  }

  async awaitSettled(_run: Run, t: RelayTaskRef): Promise<void> {
    this.log.push(`settled:${t.taskId}`);
  }

  async harvest(_run: Run, t: RelayTaskRef): Promise<RelayHarvest> {
    this.log.push(`harvest:${t.taskId}`);
    return {
      verdict: this.opts.verdicts?.[t.taskId] ?? "success",
      reply: { task: t.taskId, finding: FakeTransport.marker(t.taskId) },
      envelope: this.opts.envelopes?.[t.taskId],
    };
  }

  async publishReply(_run: Run, child: string, reply: unknown): Promise<void> {
    this.log.push(`reply:${child}`);
    this.replies.set(child, reply);
  }

  /** Every brief that has ever left the host: the children's and the collation's. */
  allBriefs(): string[] {
    return this.dispatched.map((d) => d.brief);
  }

  first(prefix: string): number {
    return this.log.findIndex((e) => e.startsWith(prefix));
  }

  last(prefix: string): number {
    return this.log.reduce((acc, e, i) => (e.startsWith(prefix) ? i : acc), -1);
  }
}

function run(request: DispatchRequest, t: FakeTransport, aspects?: readonly AspectSeat[]) {
  return relayFanOut({ request, sender: COL, runs: RUNS, transport: t, aspects });
}

function collated(o: RelayOutcome): Extract<RelayOutcome, { kind: "collated" }> {
  if (o.kind !== "collated") {
    throw new Error(`expected a collation, got ${o.kind}: ${"reason" in o ? o.reason : ""}`);
  }
  return o;
}

describe("derived ids (T3, §6.6)", () => {
  test("children and the collation are derived from the parent, not minted", () => {
    expect(childTaskId(PARENT, "arch")).toBe("T-arch");
    expect(childTaskId(PARENT, "context")).toBe("T-context");
    expect(childTaskId(PARENT, "lang")).toBe("T-lang");
    expect(collationTaskId(PARENT)).toBe("T-collate");
  });

  test("derivation is a pure function of its inputs, so `report` can print the chain", () => {
    // The whole of D5's mitigation is that the relationship between the two
    // halves of one request stays READABLE. A minted id makes that a lookup
    // against a record that has to exist; a derived one makes it arithmetic any
    // reader can redo from the parent id alone.
    expect(childTaskId(PARENT, "arch")).toBe(childTaskId(PARENT, "arch"));
    expect(collationTaskId("other")).toBe("other-collate");
  });

  test("a derivation that would not be a legal id is refused, not truncated", () => {
    const long = "a".repeat(60);
    expect(() => childTaskId(long, "context")).toThrow(RelayAspectError);
    expect(() => collationTaskId(long)).toThrow(RelayAspectError);
    // ...and the ids that DO fit are unaffected, so this is a bound rather than
    // a blanket refusal that would pass the assertion above for free.
    expect(collationTaskId("a".repeat(50))).toBe(`${"a".repeat(50)}-collate`);
  });

  test("the id bound is pinned to the one dispatch-request holds a request to", () => {
    // `relay.ts` spells 64 locally because `dispatch-request.ts` has to consult
    // `isCollationTaskId` for T5's depth bound, and a runtime import in the
    // other direction would make the two modules a cycle whose correctness
    // depended on which one Bun evaluated first. This assertion is what turns
    // the resulting drift into a red test instead of a silent divergence: a
    // parent the request accepts but relay cannot derive from would be a
    // fan-out refused for a reason no operator could act on.
    expect(MAX_RELAY_TASK_ID_CHARS).toBe(MAX_DISPATCH_ID_CHARS);
  });

  test("a parent that is not spellable never becomes a path segment", () => {
    // The derived id reaches `replyFileName` and `dispatchRequestPath`, both of
    // which build host paths inside a run directory that also holds
    // `control-auth.json`. A traversal that survives derivation is a traversal
    // in a `join`.
    expect(() => childTaskId("../../etc", "arch")).toThrow(RelayAspectError);
    expect(() => collationTaskId("../../etc")).toThrow(RelayAspectError);
  });

  test("isCollationTaskId recognises exactly what collationTaskId produces", () => {
    expect(isCollationTaskId(collationTaskId(PARENT))).toBe(true);
    expect(isCollationTaskId(PARENT)).toBe(false);
    expect(isCollationTaskId(childTaskId(PARENT, "arch"))).toBe(false);
    // The suffix is a whole trailing SEGMENT, not a substring. A predicate
    // written as `includes("collate")` would answer true for all three of these
    // and refuse first-round fan-outs from tasks that merely mention the word.
    expect(isCollationTaskId("collate")).toBe(false);
    expect(isCollationTaskId("T-collated")).toBe(false);
    expect(isCollationTaskId("T-collate-2")).toBe(false);
  });
});

describe("the aspect table (T4, D11, §6.9)", () => {
  test("the shipped table pins one aspect per reviewer seat", () => {
    expect(REVIEW_CONSOLE_ASPECTS.map((s) => s.worker)).toEqual([ARCH, CTX, LANG]);
    expect(REVIEW_CONSOLE_ASPECTS.map((s) => s.aspect)).toEqual(["arch", "context", "lang"]);
    expect(COLLATION_ASPECT).toBe("collate");
  });

  test("no aspect may collide with the collation suffix", () => {
    // A seat named `collate` derives a child id `isCollationTaskId` answers
    // `true` for, which would make T5's depth bound refuse a legitimate
    // FIRST-round fan-out from that child. The table is checked so the collision
    // is unconstructible rather than merely absent today.
    expect(REVIEW_CONSOLE_ASPECTS.some((s) => s.aspect === COLLATION_ASPECT)).toBe(false);
    expect(() =>
      run(ALL_THREE(), new FakeTransport(), [{ worker: ARCH, aspect: COLLATION_ASPECT }]),
    ).toThrow(RelayAspectError);
  });

  test("a malformed table THROWS rather than refusing, like the roster does", () => {
    // `dispatch-request.ts`'s `ConsoleRosterError` argument transfers without
    // amendment: a table is a HOST argument, identical on every tick for the
    // life of the run, so it is either wrong from the first poll or never.
    // Answering with a refusal would put an author's mistake into the same
    // channel a worker's mistake arrives on and let the poll loop run around it
    // forever, dispatching nothing.
    expect(() => run(ALL_THREE(), new FakeTransport(), [])).toThrow(RelayAspectError);
    expect(() =>
      run(ALL_THREE(), new FakeTransport(), [
        { worker: ARCH, aspect: "arch" },
        { worker: ARCH, aspect: "context" },
      ]),
    ).toThrow(RelayAspectError);
    expect(() =>
      run(ALL_THREE(), new FakeTransport(), [
        { worker: ARCH, aspect: "arch" },
        { worker: CTX, aspect: "arch" },
      ]),
    ).toThrow(RelayAspectError);
    expect(() =>
      run(ALL_THREE(), new FakeTransport(), [{ worker: ARCH, aspect: "not a segment" }]),
    ).toThrow(RelayAspectError);
  });

  test("the request cannot choose which worker gets which aspect", async () => {
    const t = new FakeTransport();
    await run(ALL_THREE(), t);
    // Each worker got the aspect the TABLE gives it, and the derived id is the
    // proof, because the id is a function of the aspect.
    const byWorker = new Map(t.dispatched.map((d) => [d.worker, d.taskId]));
    expect(byWorker.get(ARCH)).toBe("T-arch");
    expect(byWorker.get(CTX)).toBe("T-context");
    expect(byWorker.get(LANG)).toBe("T-lang");
  });

  test("reordering the request changes nothing about the assignment or the record", async () => {
    // The quiet route into D11. The schema refuses a request that NAMES a lens;
    // it cannot refuse one that implies an ORDER. An implementation that walked
    // `request.requests` to build the seats would let the collator decide which
    // lens is reported first — and, one refactor later, which lens exists.
    const forward = new FakeTransport();
    const reversed = new FakeTransport();
    await run(okRequest([{ worker: ARCH }, { worker: CTX }, { worker: LANG }]), forward);
    const out = await run(okRequest([{ worker: LANG }, { worker: CTX }, { worker: ARCH }]), reversed);

    expect(reversed.dispatched.map((d) => d.taskId)).toEqual(
      forward.dispatched.map((d) => d.taskId),
    );
    expect(collated(out).children.map((c) => c.aspect)).toEqual(["arch", "context", "lang"]);
  });

  test("naming fewer reviewers does not shrink the console's lens count", async () => {
    // The other quiet route, and the one with teeth. A collator that names ONE
    // reviewer and gets a green report has one lens. An implementation that
    // computed "all succeeded" over the REQUEST would claim `success` for it,
    // and §6.6's whole worry — a confident three-lens conclusion drawn from
    // fewer — arrives without a single field being lied about.
    const t = new FakeTransport();
    const out = collated(await run(okRequest([{ worker: ARCH }]), t));

    expect(out.claim).toBe("partial");
    expect(out.missing.map((s) => s.aspect).sort()).toEqual(["context", "lang"]);
    expect(out.collation.brief).toContain("MISSING ASPECT: context");
    expect(out.collation.brief).toContain("MISSING ASPECT: lang");
    expect(t.dispatched.filter((d) => d.taskId !== "T-collate")).toHaveLength(1);
  });
});

describe("concurrency is an anti-criterion (T1, §6.6, §1.3)", () => {
  test("the three dispatches overlap in time", async () => {
    // The decisive assertion. `gate` resolves only when all three callers are
    // INSIDE dispatch simultaneously; a sequential fan-out cannot put a second
    // caller in while the first is waiting, so the gate times out and every
    // enter/exit pair interleaves.
    const gate = barrier(3, 250);
    const t = new FakeTransport({ gate });
    await run(ALL_THREE(), t);

    expect(gate.timedOut).toBe(false);
    expect(gate.arrivals).toBe(3);

    // ...and the same property read off the log, so a failure reports WHICH
    // ordering was produced rather than only that a flag was set.
    const ids = ["T-arch", "T-context", "T-lang"];
    const enters = ids.map((id) => t.first(`dispatch:enter:${id}`));
    const exits = ids.map((id) => t.first(`dispatch:exit:${id}`));
    expect(Math.min(...enters)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...enters)).toBeLessThan(Math.min(...exits));
  });

  test("every dispatch is issued before any child settles", async () => {
    // §10's probe, verbatim: "assert all three dispatches are issued before any
    // child settles". A join that awaited each child before issuing the next is
    // the sequential fan-out wearing a different shape.
    const t = new FakeTransport();
    await run(ALL_THREE(), t);
    // The three CHILD dispatches. `T-collate` is deliberately excluded: it is
    // issued after the join by design, so a prefix wide enough to catch it would
    // make this assertion unsatisfiable and its failure uninformative.
    const exits = ["T-arch", "T-context", "T-lang"].map((id) => t.first(`dispatch:exit:${id}`));
    expect(Math.min(...exits)).toBeGreaterThanOrEqual(0);
    expect(t.first("settled:")).toBeGreaterThan(0);
    expect(Math.max(...exits)).toBeLessThan(t.first("settled:"));
  });

  test("no child's brief contains another child's findings", async () => {
    // Byte-independence. The fixture is asymmetric on purpose: each child's
    // harvest carries a token that exists nowhere else in the run, so a brief
    // containing one can only have been built AFTER that child was harvested —
    // which is the sequential-with-contamination design §1.3 is written against.
    const t = new FakeTransport();
    const out = collated(await run(ALL_THREE(), t));

    const markers = ["T-arch", "T-context", "T-lang"].map((id) => FakeTransport.marker(id));
    for (const brief of t.allBriefs()) {
      for (const m of markers) expect(brief).not.toContain(m);
    }
    // The collation brief is held to the same rule, which is D6: it carries
    // three PATHS, and a reply is read by the collator from the `:ro` mount
    // rather than quoted into its prompt by the host.
    for (const m of markers) expect(out.collation.brief).not.toContain(m);
    // The markers are real and reachable. Without this the loop above could be
    // green because nothing in the run ever produced one — which is the shape of
    // degenerate fixture that survives every mutation.
    for (const id of ["T-arch", "T-context", "T-lang"]) {
      expect(JSON.stringify(t.replies.get(id))).toContain(FakeTransport.marker(id));
    }
  });

  test("the brief a child receives is exactly the one the request wrote", async () => {
    // The other half of independence: the bytes are not just uncontaminated,
    // they are unaltered. `dispatch-request.ts` deliberately does not sanitize
    // `title`/`brief` because `/policy/dispatch`'s contract is byte-identity
    // with the RPC route, and a relay that decorated the brief would break that
    // silently, in the direction of a reviewer briefed on a document subtly
    // unlike the one the collator wrote.
    const t = new FakeTransport();
    await run(okRequest([{ worker: ARCH, brief: "look at module boundaries" }]), t);
    expect(t.briefs.get("T-arch")).toBe("look at module boundaries");
  });
});

describe("the join and the lattice (T2, §6.6)", () => {
  test("three succeeded: a collation is dispatched claiming success", async () => {
    const t = new FakeTransport();
    const out = collated(await run(ALL_THREE(), t));

    expect(out.claim).toBe("success");
    expect(out.missing).toEqual([]);
    expect(out.collation.worker).toBe(COL);
    expect(out.collation.taskId).toBe("T-collate");
    expect(t.dispatched.map((d) => d.taskId)).toContain("T-collate");
  });

  test("the collation brief names one reply path per surviving child (D6)", async () => {
    const t = new FakeTransport();
    const out = collated(await run(ALL_THREE(), t));
    for (const id of ["T-arch", "T-context", "T-lang"]) {
      expect(out.collation.brief).toContain(replyMountPath(id));
      expect(t.replies.has(id)).toBe(true);
    }
  });

  test("every reply is published before the brief that names it is dispatched", async () => {
    // D6's cost, paid where the join is rather than in a caller's memory of it:
    // the brief carries three paths, so a path naming a file not yet on disk is
    // a collator reading `ENOENT` and reporting a missing lens that was never
    // missing. Ordering that a caller has to get right is ordering that will be
    // got wrong once.
    const t = new FakeTransport();
    await run(ALL_THREE(), t);
    expect(t.last("reply:")).toBeGreaterThanOrEqual(0);
    expect(t.last("reply:")).toBeLessThan(t.first("dispatch:enter:T-collate"));
  });

  test("two succeeded: collation dispatched, claim partial, missing aspect NAMED", async () => {
    const t = new FakeTransport({ verdicts: { "T-context": "failed" } });
    const out = collated(await run(ALL_THREE(), t));

    expect(out.claim).toBe("partial");
    expect(out.missing.map((s) => s.aspect)).toEqual(["context"]);

    // The load-bearing half. "A brief exists" is satisfied by a brief that says
    // nothing, and §6.6 is explicit about the result: a confident three-lens
    // conclusion drawn from two, which `report` has no way to detect. So the
    // assertion is that the brief names the aspect AS MISSING...
    expect(out.collation.brief).toContain("MISSING ASPECT: context");
    // ...and that the same sentence is ABSENT for the aspects that are not,
    // which is what stops a brief listing all three unconditionally from
    // passing the assertion above.
    expect(out.collation.brief).not.toContain("MISSING ASPECT: arch");
    expect(out.collation.brief).not.toContain("MISSING ASPECT: lang");
    // A reply for a lens that produced no review is not published, because a
    // file at a reply path IS a lens as far as the collator can tell.
    expect(t.replies.has("T-context")).toBe(false);
    expect(out.collation.brief).not.toContain(replyMountPath("T-context"));
  });

  test("the claimed status is carried where the collator will read it", async () => {
    const t = new FakeTransport({ verdicts: { "T-lang": "blocked" } });
    const out = collated(await run(ALL_THREE(), t));
    // `partial` can never be lifted back to `success` by anything downstream
    // (`adjudicate.ts:14`, the combination is `min`), so the honest claim in the
    // brief is the whole mechanism — there is no second chance to correct it.
    expect(out.collation.brief).toContain('status: "partial"');
    expect(out.collation.brief).not.toContain('status: "success"');
  });

  test("zero succeeded: nothing is collated and the actor records why", async () => {
    const t = new FakeTransport({
      verdicts: { "T-arch": "failed", "T-context": "failed", "T-lang": "failed" },
    });
    const out = await run(ALL_THREE(), t);

    expect(out.kind).toBe("not_collated");
    if (out.kind !== "not_collated") throw new Error("unreachable");
    expect(out.reason).toContain("no child succeeded");
    // The reason names the lenses, so the record is actionable rather than a
    // count. §10: "assert the actor records the reason".
    expect(out.reason).toContain("arch");
    expect(out.children.every((c) => !c.succeeded)).toBe(true);
    // No collation task exists — the other half of §10's probe.
    expect(t.dispatched.map((d) => d.taskId)).not.toContain("T-collate");
    // ...and no reply plane was written either. Publishing replies for a
    // collation that is never dispatched would leave three `0444` files in a
    // `:ro` mount that the NEXT parent's brief does not name and nothing reaps.
    expect(t.replies.size).toBe(0);
  });

  test("a supervisor verdict is not-succeeded and is never fed to the lattice", async () => {
    // `timed_out` and `aborted` are settled by the supervisor and describe the
    // WORKER, not the task. `rank()` answers -1 for both because they are not
    // lattice members, so a `min` over them is not a smaller number — it is
    // arithmetic over a value the lattice does not contain.
    expect(rank("timed_out")).toBe(-1);
    expect(rank("aborted")).toBe(-1);

    const t = new FakeTransport({ verdicts: { "T-arch": "timed_out", "T-context": "aborted" } });
    const out = collated(await run(ALL_THREE(), t));

    expect(out.claim).toBe("partial");
    expect(out.missing.map((s) => s.aspect).sort()).toEqual(["arch", "context"]);
    // Carried through verbatim. Folding a supervisor verdict to `failed` on the
    // way in is the shape of the bug, and it is invisible: it makes the value a
    // lattice member, and the record then says a reviewer produced a FAILING
    // review when what happened is that it never reported at all.
    expect(out.children.find((c) => c.aspect === "arch")?.verdict).toBe("timed_out");
    expect(out.children.find((c) => c.aspect === "context")?.verdict).toBe("aborted");
  });

  test("a child whose dispatch never landed is a missing lens, not a crash", async () => {
    const t = new FakeTransport({ dispatchFails: ["T-lang"] });
    const out = collated(await run(ALL_THREE(), t));

    expect(out.claim).toBe("partial");
    expect(out.missing.map((s) => s.aspect)).toEqual(["lang"]);
    expect(out.collation.brief).toContain("MISSING ASPECT: lang");
    // The other two were still ISSUED — one pass, not an abort on first error.
    // `Promise.all` would have rejected the whole fan-out here and produced no
    // collation from two perfectly good reviews.
    expect(t.first("dispatch:enter:T-arch")).toBeGreaterThanOrEqual(0);
    expect(t.first("dispatch:enter:T-context")).toBeGreaterThanOrEqual(0);
    // ...and a task that was never dispatched is never waited on, because
    // `awaitSettled` on it would poll for a task record that cannot appear.
    expect(t.first("settled:T-lang")).toBe(-1);
    expect(t.first("harvest:T-lang")).toBe(-1);
  });
});

/**
 * A LENS THAT COULD NOT BE READ IS NOT A LENS THAT PRODUCED NOTHING.
 *
 * ## The run this is written from
 *
 * `rev-lang-1` wrote a genuine 3906-byte review into its result envelope. Its
 * seat is regex correctness, so the review quoted a regex into a JSON string —
 * `[\w\\-_]+`. `\w` is not a valid JSON escape, so the envelope does not parse.
 * The console then said, in three places, that the reviewer *"settled `unknown`
 * and produced no report"*, and the collation recorded
 * `{"reported": false, "note": "the lens settled 'unknown' and produced no report"}`.
 *
 * Every word of that is about the REVIEWER and the failure was in the
 * TRANSPORT. An operator reading `partial` learns that a lens found nothing,
 * when what is true is that a review exists on disk and nothing here could open
 * it — a different instruction entirely, because the second one can be read by a
 * person and is worth re-running.
 *
 * **The seat that quotes code is the seat most likely to put a regex in a JSON
 * string**, so this is structural rather than unlucky, and it will recur.
 *
 * ## WHAT THESE PROBES CAN SEE
 *
 * - That the brief's wording for an ABSENT envelope and an UNREADABLE one
 *   DIFFER, and differ in the direction that matters: only the unreadable one
 *   claims a file exists, and only the absent one claims nothing was produced.
 * - That the unreadable line carries the three things a person needs to act —
 *   a path, a size and a nameable parse error — rather than prose about them.
 * - That the discriminator is the ENVELOPE and not the verdict. Both fixtures
 *   below settle `unknown`, so an implementation that branched on the verdict
 *   scores zero here rather than passing by coincidence.
 * - That the unreadable instruction block is ABSENT when no envelope was
 *   unreadable, so a warning printed on every brief cannot pass for a warning
 *   printed on the right one.
 *
 * ## WHAT THESE PROBES CANNOT SEE
 *
 * - **Whether the harvester's absent/unreadable classification is CORRECT.**
 *   That lives behind `RelayHarvest.envelope` and is the other engineer's; here
 *   it is a fixture value. A harvester that reported every absent envelope as
 *   unreadable would make every assertion below pass and the console lie again.
 * - **Whether the collator obeys the brief.** These read the bytes dispatched,
 *   not what a model does with them. `collator-role.test.ts` grades the
 *   document that tells it, and nothing grades the model.
 * - **The real `\w` failure end to end.** No JSON is parsed here; the parse
 *   error is a string in a fixture. The coincidence this is written against is
 *   the FIXTURE kind, not the parser kind.
 */
describe("an unreadable envelope is a transport failure, not a silent reviewer", () => {
  const LANG_ENVELOPE = "/outbox/T-lang/result.json";
  const PARSE_DETAIL = "Invalid escape character w in JSON at position 1487";

  /**
   * The asymmetric fixture, and the whole point of this block.
   *
   * Two lenses go missing with the SAME verdict and DIFFERENT envelope states.
   * The recurring defect on this branch is a fixture in which the two states
   * being distinguished coincide — and every cheaper fixture here does exactly
   * that. Giving the absent lens `failed` and the unreadable one `unknown`
   * would let an implementation that read only the verdict pass. Giving both
   * the same envelope state would let one that read neither pass. Only this
   * pairing makes the envelope the sole thing that differs.
   */
  const twoMissing = () =>
    new FakeTransport({
      verdicts: { "T-context": "unknown", "T-lang": "unknown" },
      envelopes: {
        "T-context": { kind: "absent" },
        "T-lang": {
          kind: "unreadable",
          path: LANG_ENVELOPE,
          bytes: 3906,
          code: "not_json",
          detail: PARSE_DETAIL,
        },
      },
    });

  function briefOf(o: RelayOutcome): string {
    return collated(o).collation.brief;
  }

  test("the unreadable lens is named with its file, its size and the parse error", async () => {
    const brief = briefOf(await run(ALL_THREE(), twoMissing()));

    // Still a MISSING ASPECT line: from the collator's side the lens IS
    // missing, and §6.6's rule is that every missing aspect is named. A second
    // prefix would let a collator scanning for this one skip a real absence.
    expect(brief).toContain("MISSING ASPECT: lang");
    // The three facts a person can act on. Each is asserted separately so a
    // regression that drops one is not masked by the other two.
    expect(brief).toContain(LANG_ENVELOPE);
    expect(brief).toContain("3906");
    expect(brief).toContain(PARSE_DETAIL);
  });

  test("the unreadable lens is NOT described as having produced nothing", async () => {
    const brief = briefOf(await run(ALL_THREE(), twoMissing()));
    const langLine = brief.split("\n").find((l) => l.startsWith("MISSING ASPECT: lang"));

    expect(langLine).toBeDefined();
    // The exact sentence the live console shipped, and the reason this file
    // exists. A `toContain` over the whole brief would be satisfied by the
    // ABSENT lens' own line, so this is scoped to the one line under test.
    expect(langLine).not.toContain("produced no report");
  });

  test("the summary counts reports the collator CAN READ, not reports produced", async () => {
    const brief = briefOf(await run(ALL_THREE(), twoMissing()));

    // *"N produced a report; M did not"* asserts of the M that they produced
    // nothing — the same false claim as the per-lens note, in the one sentence
    // a reader skims. Qualifying the survivors' clause makes the missing clause
    // true by subtraction without the summary having to know which kind of
    // missing each one is.
    expect(brief).toContain("1 produced a report you can read; 2 did not");
  });

  test("a readable envelope that did not succeed is not a lens that produced nothing", async () => {
    /**
     * The arm production cannot reach YET, and the reason it is probed anyway.
     *
     * `fanOut` publishes a reply only for a lens that SUCCEEDED, so a lens with
     * a perfectly readable envelope and a `failed` verdict has a report that
     * exists and did not travel. *"Produced no report"* is false there too —
     * the same defect in its second-most-likely form. The production adapter
     * cannot emit `present` today (see `RelayHarvestView.unreadableEnvelope`),
     * so this probe grades the core's vocabulary rather than a live path, and
     * is what stops that vocabulary rotting before the seam widens.
     */
    const t = new FakeTransport({
      verdicts: { "T-lang": "failed" },
      envelopes: { "T-lang": { kind: "present" } },
    });
    const lang = collated(await run(ALL_THREE(), t)).children.find((c) => c.aspect === "lang");

    expect(lang?.note).not.toContain("produced no report");
    expect(lang?.note).toContain("no report reached the collator");
  });

  test("the absent lens does NOT borrow the unreadable wording", async () => {
    const brief = briefOf(await run(ALL_THREE(), twoMissing()));
    const ctxLine = brief.split("\n").find((l) => l.startsWith("MISSING ASPECT: context"));

    expect(ctxLine).toBeDefined();
    // THE ASYMMETRY. An implementation that emits the unreadable sentence for
    // every missing lens passes every assertion in the test above and fails
    // here — which is the only reason that test is worth running.
    expect(ctxLine).not.toContain(LANG_ENVELOPE);
    expect(ctxLine).not.toContain("3906");
    expect(ctxLine).not.toContain(PARSE_DETAIL);
    // ...and it still says the strong true thing, because for a lens the
    // harvest looked for and did not find, "produced no report" is a FACT and
    // weakening it everywhere would be the opposite over-correction.
    expect(ctxLine).toContain("produced no report");
  });

  test("the two lines differ, and the verdict cannot be what told them apart", async () => {
    const out = collated(await run(ALL_THREE(), twoMissing()));
    const lang = out.children.find((c) => c.aspect === "lang");
    const ctx = out.children.find((c) => c.aspect === "context");

    // Same verdict, different note. If these verdicts ever diverge in this
    // fixture the whole block stops proving anything, so it is asserted rather
    // than assumed.
    expect(lang?.verdict).toBe("unknown");
    expect(ctx?.verdict).toBe("unknown");
    expect(lang?.note).not.toBe(ctx?.note);
    // The state is carried on the child rather than only rendered into prose,
    // so the brief is not the only reader that can tell them apart.
    expect(lang?.envelope).toEqual({
      kind: "unreadable",
      path: LANG_ENVELOPE,
      bytes: 3906,
      code: "not_json",
      detail: PARSE_DETAIL,
    });
    expect(ctx?.envelope).toEqual({ kind: "absent" });
  });

  test("the collator is told an unreadable lens is worth re-running, once", async () => {
    const brief = briefOf(await run(ALL_THREE(), twoMissing()));

    expect(brief).toContain("UNREADABLE ENVELOPE");
    // Named once per unreadable lens and not once per missing lens: the ABSENT
    // one must not appear in the block that says a file can be opened by hand.
    expect(brief.match(/UNREADABLE ENVELOPE/g)).toHaveLength(1);
    /**
     * The three clauses the block exists for, pinned as PHRASES rather than as
     * a sentence.
     *
     * A block that is present and says nothing useful passes the two assertions
     * above, and a battery proved it: truncating the instruction to its first
     * clause left every positive green. These are the semantics — the lens was
     * applied, the row still says `false`, a person should go and read it — and
     * they are matched short so the prose around them stays free to be rewritten.
     */
    expect(brief).toContain("it was applied");
    expect(brief).toContain('"reported": false');
    expect(brief).toContain("re-run the lens");
  });

  test("no unreadable envelope means no unreadable block at all", async () => {
    // The guard the truncation section already needed: an unconditional block
    // emits no per-lens lines when nothing was unreadable, so every assertion
    // above still passes while every brief warns about a hazard it does not
    // have. A warning on every brief is one a reader learns to skip.
    const t = new FakeTransport({
      verdicts: { "T-lang": "failed" },
      envelopes: { "T-lang": { kind: "absent" } },
    });
    const brief = briefOf(await run(ALL_THREE(), t));

    expect(brief).toContain("MISSING ASPECT: lang");
    expect(brief).not.toContain("UNREADABLE ENVELOPE");
  });

  test("a transport that says nothing about envelopes claims nothing about them", async () => {
    /**
     * The THIRD state, and it is not the same as `absent`.
     *
     * `RelayHarvest.envelope` is optional because the core must not require a
     * transport to inspect envelopes — the same argument `inlined` already
     * won. What must not follow is that silence gets read as evidence: a
     * transport that never looked cannot support "produced no report", which
     * is precisely the claim the live console made from exactly this state.
     */
    const t = new FakeTransport({ verdicts: { "T-lang": "unknown" } });
    const out = collated(await run(ALL_THREE(), t));
    const lang = out.children.find((c) => c.aspect === "lang");

    expect(lang?.envelope).toBeNull();
    expect(lang?.note).not.toContain("produced no report");
    // It still says something useful about what the COLLATOR has, which is the
    // one thing that is true from here regardless of what the reviewer did.
    expect(lang?.note).toContain("no report reached");
  });

  test("a lens that was never dispatched keeps its own reason", async () => {
    // Guards the over-correction: a seat the request never named, and a
    // dispatch that was refused, are not envelope facts and must not be
    // re-described as ones. Their notes predate this change and stay.
    const t = new FakeTransport({ dispatchFails: ["T-lang"] });
    const out = collated(await run(okRequest([{ worker: ARCH }, { worker: LANG }]), t));

    expect(out.children.find((c) => c.aspect === "context")?.envelope).toBeNull();
    expect(out.children.find((c) => c.aspect === "context")?.note).toContain(
      "never named this reviewer",
    );
    expect(out.children.find((c) => c.aspect === "lang")?.envelope).toBeNull();
    expect(briefOf(out)).not.toContain("UNREADABLE ENVELOPE");
  });
});

describe("routing across four runs (D4)", () => {
  test("each child is dispatched into ITS OWN run, not the collator's", async () => {
    // Every `pane_mode: tui` pane runs its own `pifleet up --attach-here`, so
    // the console is four runs. An actor holding ONE run would dispatch every
    // child into the collator's run, where those worker ids do not exist — and
    // the failure would be three identical "unknown worker" errors naming
    // everything except the map that is wrong.
    const t = new FakeTransport();
    await run(ALL_THREE(), t);
    expect(t.runsSeen.get("T-arch")).toBe("run/arch");
    expect(t.runsSeen.get("T-context")).toBe("run/ctx");
    expect(t.runsSeen.get("T-lang")).toBe("run/lang");
    // The collation goes back to the collator's own run.
    expect(t.runsSeen.get("T-collate")).toBe("run/col");
  });

  test("a worker with no run refuses the whole fan-out before anything is dispatched", async () => {
    const short = new Map(RUNS);
    short.delete(CTX);
    const t = new FakeTransport();
    const out = await relayFanOut({
      request: ALL_THREE(),
      sender: COL,
      runs: short,
      transport: t,
    });

    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") throw new Error("unreachable");
    expect(out.code).toBe("run_unresolved");
    expect(out.reason).toContain(CTX);
    // Nothing was dispatched. A fan-out that issued two of three and then
    // discovered the third is a HALF fan-out, and §6.6's "in one pass" is not a
    // property of a pass abandoned partway — the two that landed would run,
    // settle, and be harvested by nobody.
    expect(t.dispatched).toHaveLength(0);
  });

  test("the collator's own run must resolve, because the replies land in it", async () => {
    const short = new Map(RUNS);
    short.delete(COL);
    const t = new FakeTransport();
    const out = await relayFanOut({ request: ALL_THREE(), sender: COL, runs: short, transport: t });

    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") throw new Error("unreachable");
    expect(out.code).toBe("run_unresolved");
    expect(out.reason).toContain(COL);
    expect(t.dispatched).toHaveLength(0);
  });

  test("a parent whose derived ids will not fit is refused, not truncated", async () => {
    // The same bound `childTaskId` throws on, reached through the polling path
    // where a THROW would take the actor down over one operator's long task
    // name. `dispatch-request.ts` draws this line the same way: a document
    // problem is a value, a host-argument problem is an exception.
    const t = new FakeTransport();
    const out = await relayFanOut({
      request: okRequest([{ worker: ARCH }], "p".repeat(60)),
      sender: COL,
      runs: RUNS,
      transport: t,
    });

    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") throw new Error("unreachable");
    expect(out.code).toBe("underivable_id");
    expect(t.dispatched).toHaveLength(0);
  });
});

describe("idempotency is not relay's (the seam)", () => {
  test("relay fans out every time it is called, and holds no memory of having done so", async () => {
    // `readDispatchRequest` is idempotent-unfriendly BY DESIGN: an accepted file
    // stays `ok` on every poll tick, and it lives in a directory the WORKER
    // owns, so neither deleting the file nor remembering the task id survives a
    // hostile or confused collator. The decision NOT to fan out therefore
    // belongs to the caller, BEFORE `relayFanOut` is entered, and
    // `relay-journal.ts` is its single writer.
    //
    // This test pins the CONTRACT rather than a behaviour: relay holds no
    // memory, so a second call repeats the first exactly. An implementation that
    // grew a private `seen` set would turn this red — and would be a second
    // writer of a fact the journal owns, which is how two components come to
    // disagree about whether a fan-out happened.
    const first = new FakeTransport();
    const second = new FakeTransport();
    const a = collated(await run(ALL_THREE(), first));
    const b = collated(await run(ALL_THREE(), second));

    expect(second.dispatched.map((d) => d.taskId)).toEqual(first.dispatched.map((d) => d.taskId));
    expect(b.collation.brief).toBe(a.collation.brief);
    expect(b.claim).toBe(a.claim);
  });
});
