/**
 * The RUNTIME half of the F39 prose-instead-of-tool-calls guard (SRD §5.9
 * detector 2 — ISC-108).
 *
 * §5.9 specifies TWO detectors for one failure, and they catch it at different
 * moments for different reasons:
 *
 *   1. The STARTUP probe (`security/model-probe.ts`) sends one `tools`-bearing
 *      completion per distinct model and refuses at `up` with exit 2 if the
 *      answer is prose. It catches the whole class in seconds — but only for
 *      the model as it behaves on a two-hundred-token context.
 *   2. THIS. The supervisor counts tool calls per epoch, and a worker that
 *      completes `prose_turns_before_fail` turns (default 3) with zero tool
 *      calls is classified `failed` with reason `no_tool_calls` — "it does not
 *      get to settle 'successfully'".
 *
 * The second exists because the first can be PASSED AND THEN DRIFTED FROM. A
 * model's willingness to emit native `tool_calls` is a property of its chat
 * template interacting with the context it is given, not a fixed capability,
 * so a probe answered correctly at token 200 says nothing about token 80,000.
 * §5.9 records the live measurement this is built on: `Qwen3-8B-4bit` emitting
 * reasoning prose instead of `tool_calls` through this same oMLX server. A Pi
 * worker pointed at such a model looks perfectly healthy — it streams, it ends
 * turns, it settles — and accomplishes NOTHING, because its intended actions
 * never become tool calls.
 *
 * A second, sharper reproduction was taken on 2026-08-23 against
 * `Qwen3-Coder-30B-A3B-Instruct-4bit` — a model that PASSES the startup probe:
 * in 1 of 3 identical probes it leaked its tool call as raw
 * `<function=read>…</tool_call>` TEXT with `finish_reason=stop`. That is the
 * drift this detector is for, and it is intermittent rather than a property of
 * the model, which is exactly the shape a one-shot probe cannot see. When it
 * happens the turn genuinely has zero tool calls, and nothing else in the
 * fleet would have said so out loud.
 *
 * ## What is counted, and what resets it
 *
 * A run-length counter of CONSECUTIVE zero-tool-call turns, per epoch, reset
 * to zero by any tool call. Three alternatives were considered and rejected:
 *
 *  - **Cumulative per worker.** `state.tool_calls` already is that, and it is
 *    why the counter that existed before ISC-108 could not answer this: a
 *    worker whose first task called forty tools and whose second emits nothing
 *    but prose has a large, permanently non-zero total. The number has to be a
 *    statement about the epoch being judged.
 *  - **Total turns and total tool calls per epoch** (i.e. "N turns done and
 *    still zero tool calls, ever"). This is the literal reading of §5.9's
 *    sentence, and it is strictly weaker: it can never fire on a worker that
 *    made one tool call at turn 1 and then degraded for the next fifty, which
 *    is the LONG-CONTEXT drift the detector is named for.
 *  - **Non-consecutive count within the epoch.** Would fire on a worker doing
 *    productive work in a think-act-think-act rhythm, which is normal.
 *
 * The consecutive rule is what makes "three prose turns, then a tool call,
 * then three more prose turns" a different animal from "never called a tool":
 * the streak reaching the threshold is a claim that the agent has stopped
 * acting AND HAS NOT RESUMED. (Note the arithmetic: at the default of 3 the
 * first animal has already tripped at its third turn, before the tool call
 * arrives. That is intended — the detector is a bound on how long a worker may
 * go without acting, not a retrospective judgement of the whole epoch.)
 *
 * ## The turn that was cut short does not count
 *
 * A `turn_end` arriving after the supervisor asked the agent to stop — a
 * deadline abort, or an operator abort — has zero tool calls because WE ended
 * it, not because the model degraded. Counting it would let a task that timed
 * out mid-tool-call be reported as a model that never called a tool, sending
 * the operator to change the model when the real answer is a longer deadline.
 * The caller passes `interrupted`, and an interrupted turn neither increments
 * the streak nor clears it: it is not evidence either way.
 *
 * ## Zero means OFF
 *
 * `prose_turns_before_fail: 0` disables the detector. The alternative reading —
 * "fail before completing any turn" — describes no useful configuration and
 * would fire on every task including the ones that work. Zero is also the
 * value `llm.require_native_tool_calls: false` collapses to, which is what
 * gives §5.9's "disables both" a single spelling of off rather than two
 * independent switches an operator has to know to set together.
 *
 * ## Why this is a module and not four `let`s in the supervisor
 *
 * The per-epoch reset, the streak reset on a tool call, and the
 * interrupted-turn rule are three independent decisions that are cheap to get
 * wrong and impossible to test where they live: the supervisor's event handler
 * is reachable only through a spawned process and an RPC stream. Here they are
 * a state machine over strings. The seam is deliberately narrow — `observe`
 * takes an event TYPE, not an `RpcEvent`, so nothing in this file can come to
 * depend on the wire shape.
 */

/**
 * The settle reason ISC-108 names, exported so the supervisor and the tests
 * that grade it cannot drift to two spellings of it. The criterion is written
 * `failed:no_tool_calls`, and this is the second half.
 */
export const NO_TOOL_CALLS_REASON = "no_tool_calls";

/**
 * The settle reason ISC-299 names, exported for the same reason its sibling
 * above is: the supervisor writes it and the tests grade it, and two spellings
 * of one reason is a bug that only shows up as a test that cannot fail.
 *
 * It sits beside `NO_TOOL_CALLS_REASON` because the two are the same failure
 * seen from opposite sides. That one fires when the model never CALLED a tool;
 * this one fires when it called plenty and the tree is unchanged anyway. An
 * operator who sees `no_tool_calls` should change the model; one who sees
 * `no_work_done` should look at why the worker's writes were refused.
 */
export const NO_WORK_DONE_REASON = "no_work_done";

/** What the supervisor knows about the turn that this event belongs to. */
export interface TurnContext {
  /**
   * The supervisor has already asked this epoch to stop — `em.timedOut` or
   * `em.abortRequested`. A turn ending under that request is not evidence
   * about the model. See the header.
   */
  readonly interrupted: boolean;
}

/**
 * Consecutive zero-tool-call turns within one epoch (SRD §5.9 detector 2 —
 * ISC-108).
 *
 * One instance per supervisor, `reset()` at every epoch boundary — created
 * once because the threshold is a property of the RUN, and reset per epoch
 * because the count is a property of the TASK.
 */
export class ProseTurnDetector {
  /** Consecutive prose turns that trip the detector; 0 disables it. */
  readonly threshold: number;

  /** Tool calls observed since the last turn boundary. */
  #toolCallsThisTurn = 0;

  /** Consecutive completed turns that had none. */
  #streak = 0;

  /** Latched once per epoch: the streak reached the threshold. */
  #tripped = false;

  constructor(threshold: number) {
    // Defensive rather than decorative: the threshold arrives from `run.json`,
    // which is a file on disk that another process wrote, and a fractional or
    // negative bound would make `>=` either unreachable or always true. The
    // reader validates too; this is the second line of defence, in the object
    // that acts on the number.
    this.threshold =
      Number.isSafeInteger(threshold) && threshold >= 0 ? threshold : 0;
  }

  /** False when `prose_turns_before_fail` is 0 — the detector does nothing. */
  get enabled(): boolean {
    return this.threshold > 0;
  }

  /**
   * The epoch has completed `threshold` consecutive turns with no tool call.
   * Latched: it stays true until `reset()`, so a settle path that runs long
   * after the trip still reads the diagnosis.
   */
  get tripped(): boolean {
    return this.#tripped;
  }

  /** Consecutive completed prose turns. Exported for the `logEvent` record. */
  get streak(): number {
    return this.#streak;
  }

  /** Tool calls seen in the turn currently in flight. */
  get toolCallsThisTurn(): number {
    return this.#toolCallsThisTurn;
  }

  /**
   * Clear everything, including the latch.
   *
   * Called at the `agent_start` that opens an epoch's window and again in
   * `settle`, for the same reason `livePromptId` and `liveWorkdir` are cleared
   * there: a count carried across a settle would let one task's degradation
   * classify the next task, and the epoch is the unit this verdict is about.
   */
  reset(): void {
    this.#toolCallsThisTurn = 0;
    this.#streak = 0;
    this.#tripped = false;
  }

  /**
   * Observe one event ATTRIBUTED TO THE LIVE EPOCH.
   *
   * Returns `true` on the single transition that trips the detector, and false
   * every other time — including on later events once tripped. The caller uses
   * that edge to log, to record a ledger row, and to ask the agent to stop, so
   * it must fire exactly once or the escalation would be armed repeatedly.
   *
   * Live-attributed only, and that is not a detail. The supervisor's existing
   * `state.tool_calls++` runs BEFORE `em.attribute`, so a straggler
   * `tool_execution_end` from a settled epoch inflates it (harmless for a
   * metric, wrong for a verdict). Feeding this from the post-attribution
   * branch is what keeps a prior epoch's tool call from clearing THIS epoch's
   * prose streak — which would silently disarm the detector on exactly the
   * §7.5 interleaving the fence exists to handle.
   */
  observe(eventType: string, ctx: TurnContext): boolean {
    if (!this.enabled || this.#tripped) return false;

    if (eventType === "tool_execution_end") {
      this.#toolCallsThisTurn++;
      // The streak dies at the ACT, not at the end of the turn it happened in.
      // Waiting for `turn_end` would be equivalent here, but it would leave
      // `streak` reading stale for the whole rest of the turn, and `streak` is
      // what the trip record reports.
      this.#streak = 0;
      return false;
    }

    if (eventType !== "turn_end") return false;

    const hadToolCall = this.#toolCallsThisTurn > 0;
    this.#toolCallsThisTurn = 0;

    // Neither incremented nor cleared: an interrupted turn says nothing about
    // the model. See the header.
    if (ctx.interrupted) return false;

    if (hadToolCall) {
      this.#streak = 0;
      return false;
    }

    this.#streak++;
    if (this.#streak < this.threshold) return false;
    this.#tripped = true;
    return true;
  }
}
