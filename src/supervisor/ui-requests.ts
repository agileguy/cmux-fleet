/**
 * `extension_ui_request` classification and the one frame that answers it
 * (SRD §4.2 vocabulary, §12.3 guard 2 — ISC-111, ISC-112, ISC-113).
 *
 * A Pi extension that asks a question gets no human on this end. The fleet is
 * headless by construction, so every dialog it opens is a turn that stops
 * until the supervisor says something. This module owns WHAT the supervisor
 * says and, more importantly, TO WHICH METHODS — the two-class split is the
 * whole guard, and an implementation that answers all nine is as wrong as one
 * that answers none.
 *
 * ---------------------------------------------------------------------------
 * THE WIRE FRAME, TAKEN FROM THE INSTALLED BUILD AND NOT FROM THIS REPO'S DOCS
 * ---------------------------------------------------------------------------
 *
 * SRD §4 pins the tie-break: "where a docs page and the installed build
 * disagree, the build wins". The SRD's own §4.2 table names the RESPONSE
 * SHAPES (`{value}` | `{confirmed}` | `{cancelled:true}`) but never the frame
 * that carries them, so the frame below was extracted from the pinned worker
 * image `pifleet/pi-worker:0.79.6-node-ab027c19a55e` rather than invented:
 *
 *   /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/
 *     dist/modes/rpc/rpc-types.d.ts        (lines 405-418, `RpcExtensionUIResponse`)
 *     dist/modes/rpc/rpc-mode.js           (lines 573-585, the stdin dispatch)
 *     docs/rpc.md                          (lines 1153-1176, "Extension UI Responses (stdin)")
 *
 * `rpc-types.d.ts` declares the type as a three-arm union, every arm carrying
 * `type` and `id`:
 *
 *   export type RpcExtensionUIResponse =
 *     | { type: "extension_ui_response"; id: string; value: string }
 *     | { type: "extension_ui_response"; id: string; confirmed: boolean }
 *     | { type: "extension_ui_response"; id: string; cancelled: true };
 *
 * So the denial frame is exactly, as one LF-terminated JSONL line on the
 * child's stdin:
 *
 *   {"type":"extension_ui_response","id":"<the request's id>","cancelled":true}
 *
 * Three details from `rpc-mode.js` that the docs do not make obvious and that
 * this module's shape depends on:
 *
 * 1. **The correlation key is `id`, not `request_id`.** The dispatcher does
 *    `pendingExtensionRequests.get(response.id)`. A frame spelling it
 *    `request_id` parses, matches nothing, and is dropped in silence — the
 *    dialog stays blocked and nothing anywhere reports a problem. That is the
 *    exact failure ISC-112 describes, arrived at by a plausible guess, which
 *    is why the frame was read off the build instead of reasoned out.
 *
 * 2. **It is a bare top-level record, not a command.** The stdin handler tests
 *    `parsed.type === "extension_ui_response"` BEFORE `handleCommand`, and
 *    returns. There is no `{command, params}` envelope, no generated request
 *    id of ours, and — critically — Pi sends nothing back. It must therefore
 *    NOT go through `RpcClient.send()`, which stamps its own `id`, registers a
 *    pending entry and rejects on a response that will never come. See
 *    `RpcClient.sendUncorrelated()`.
 *
 * 3. **An unmatched `id` is discarded silently** (`if (pending) {...}`, no
 *    else). At the Pi end a spurious answer therefore costs nothing. That fact
 *    is what decides the unknown-method policy below.
 *
 * ---------------------------------------------------------------------------
 * WHY `editor` IS A DIFFERENT ROW IN THE TABLE AND NOT JUST A FOURTH DIALOG
 * ---------------------------------------------------------------------------
 *
 * The same `rpc-mode.js` shows the two dialog implementations are not the same
 * mechanism. `select`, `confirm` and `input` are built by `createDialogPromise`,
 * which wires up `opts.signal` and `if (opts?.timeout) setTimeout(...)` — given
 * a timeout, they resolve themselves to the extension's own default value.
 * `editor` is a bare `new Promise` that registers a resolver and emits: no
 * timeout parameter exists on the method at all, no abort signal, no cleanup
 * path. It resolves if and only if a matching `extension_ui_response` arrives.
 *
 * That asymmetry is the entire reason ISC-112 is a criterion separate from
 * ISC-111, so it is a separate value in `DIALOG_METHODS` rather than a comment:
 * a supervisor that answers `editor` is the ONLY unblocker that exists, and
 * when its answer fails to land nothing downstream rescues the turn — it burns
 * the whole `per_task_timeout` and dies by the kill ladder with a reason
 * (`deadline_exceeded_no_terminal_event`) that names the symptom and not the
 * cause. The supervisor treats a missed `editor` answer as a reportable
 * incident for exactly that reason; a missed `select` answer may still be
 * rescued by the agent's own timer, if the extension set one.
 *
 * Note the "if": self-resolution is CONDITIONAL on the extension passing
 * `opts.timeout`, which is optional. `SELF_RESOLVING` therefore means "may
 * self-resolve", never "will" — it lowers the severity of a missed answer, it
 * does not make one safe.
 */

/**
 * What, other than the supervisor, can unblock a given dialog method.
 *
 * Deliberately a value and not a boolean flag on the method name: this is the
 * field the supervisor branches on when an answer does NOT land, and the two
 * cases get different severities.
 */
export type DialogUnblocker =
  /**
   * The agent auto-resolves with its own default IF the extension supplied
   * `opts.timeout` — optional, so this is a possibility and not a guarantee.
   */
  | "agent_timeout_if_set"
  /**
   * Nothing else exists. `editor` carries no timeout and no signal; an
   * unanswered one blocks its turn until the task deadline kills the worker.
   */
  | "supervisor_only";

/**
 * The four DIALOG methods — SRD §4.2's first class — each with what else could
 * possibly unblock it. Every one of these blocks the agent until answered.
 */
export const DIALOG_METHODS: ReadonlyMap<string, DialogUnblocker> = new Map([
  ["select", "agent_timeout_if_set"],
  ["confirm", "agent_timeout_if_set"],
  ["input", "agent_timeout_if_set"],
  ["editor", "supervisor_only"],
]);

/**
 * The five FIRE-AND-FORGET methods — SRD §4.2's second class. Nothing is
 * waiting on any of them; the agent emits and moves on without registering a
 * resolver, so a reply is not merely unnecessary, it is addressed to nobody.
 *
 * This set is CLOSED on purpose, and it is the only closed set here. It is the
 * exhaustive list from both the SRD table and the installed build, and it is
 * the sole reason any request goes unanswered — see the unknown-method policy
 * in `classifyUiRequest`. ISC-113 asserts the silence of exactly these five
 * from the far end of the wire, so adding a method here removes it from the
 * answered set, and removing one from here starts answering it.
 */
export const FIRE_AND_FORGET_METHODS: ReadonlySet<string> = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

/**
 * The denial frame, exactly as `RpcExtensionUIResponse`'s third arm declares it.
 *
 * A `type` alias and not an `interface` on purpose: only aliases get an
 * implicit index signature, and this value is handed to
 * `RpcClient.sendUncorrelated(frame: Record<string, unknown>)`. An interface
 * cannot satisfy that without either widening the parameter to `object` —
 * losing the guarantee that what reaches the wire is a JSON record — or
 * declaring an index signature here, which would let any key at all onto a
 * frame whose whole value is being exactly these three fields.
 */
export type ExtensionUiCancelResponse = {
  type: "extension_ui_response";
  id: string;
  cancelled: true;
};

/**
 * The one thing the supervisor ever says to a dialog.
 *
 * There is no "deny" verb in the protocol (SRD §4.2): denial IS
 * `{cancelled:true}`, and what an extension makes of it is extension-defined,
 * which is why §12.3 pairs this guard with the mandatory `--no-extensions` of
 * §12.2 rather than resting on it alone.
 *
 * Worth stating because it is the reason answering IMMEDIATELY is safe rather
 * than merely fast: per `rpc-mode.js`, `cancelled:true` resolves select/input/
 * editor to `undefined` and confirm to `false` — byte-for-byte the same
 * `defaultValue` those methods resolve to when their OWN timeout expires. So
 * a prompt cancellation and a waited-out one are indistinguishable to the
 * extension. Waiting the full `ui_request_timeout` before sending would buy
 * the extension nothing and spend the entire ISC-111 budget on nothing.
 */
export function cancelledResponse(id: string): ExtensionUiCancelResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}

/** What the supervisor should do about one `extension_ui_request`. */
export type UiRequestPlan =
  | {
      action: "answer";
      /** The request's own `id`, echoed verbatim — the correlation key. */
      id: string;
      method: string;
      /**
       * Present for a recognised dialog method; `null` when the method is not
       * in either table (see the unknown-method policy) and we are answering
       * defensively without knowing what we are answering.
       */
      unblocker: DialogUnblocker | null;
      /** True when `method` matched neither class and this is the fail-safe arm. */
      unrecognised: boolean;
    }
  | { action: "ignore"; method: string }
  | {
      action: "unanswerable";
      method: string | null;
      /** Always the same today; named so the log line says why, not just that. */
      reason: "no_request_id";
    };

/**
 * Sort one `extension_ui_request` into the two classes of SRD §4.2.
 *
 * ---------------------------------------------------------------------------
 * THE UNKNOWN-METHOD POLICY, AND WHY IT LEANS THE WAY IT DOES
 * ---------------------------------------------------------------------------
 *
 * A method in neither table is a real case, not a hypothetical: Pi is pinned
 * per run but the pin moves, and §4.2's nine methods are the vocabulary of
 * 0.79.6 and not a promise about 0.80. The choice is genuinely two-sided and
 * both arms have a cost, so it is made explicitly here rather than falling out
 * of a `switch` default:
 *
 *   - REFUSE to answer an unknown method, and a dialog method added in a later
 *     Pi hangs its turn until the task deadline kills the worker. That is
 *     ISC-112's failure exactly, reintroduced by a version bump, and it is
 *     silent — nothing distinguishes it from a slow model.
 *
 *   - ANSWER an unknown method, and a fire-and-forget method added in a later
 *     Pi receives a reply. Per `rpc-mode.js` the reply is looked up in
 *     `pendingExtensionRequests`, matches nothing (fire-and-forget methods
 *     register no resolver) and is dropped without error. The agent's state is
 *     unchanged. The cost is a spurious line on the wire.
 *
 * The costs are not comparable — one loses a task and a whole deadline's worth
 * of tokens, the other loses a line — so this ANSWERS unknown methods, and the
 * five fire-and-forget names above are the only exemption. Liveness is the
 * failure the guard exists to prevent; a redundant frame is not a failure at
 * all.
 *
 * The plan is still marked `unrecognised` so the supervisor can log it as a
 * distinct fact. A run answering methods nobody has heard of is a signal that
 * the pinned image moved out from under §4.2's table, and that should be
 * visible in `events.jsonl` rather than blended into the normal path.
 *
 * A MALFORMED EVENT is handled by the same rule with one hard limit. A missing
 * or non-string `method` is treated as unknown and answered, because a dialog
 * whose method we failed to read still blocks a turn. But a missing or
 * non-string `id` is not a policy question: `id` is the correlation key and a
 * frame without one addresses nobody, so there is no answer to send. That case
 * is reported (`unanswerable`) and never silently swallowed — if a real dialog
 * ever arrives without an id, the run is going to hang and the log must be
 * able to say why.
 */
export function classifyUiRequest(event: { readonly [k: string]: unknown }): UiRequestPlan {
  const rawMethod = event["method"];
  const method = typeof rawMethod === "string" && rawMethod !== "" ? rawMethod : null;

  // Class check FIRST, before the id check: an id-less fire-and-forget request
  // is not a problem worth reporting — nothing was waiting on it — and
  // reporting it as `unanswerable` would put a scary line in the log for the
  // most benign shape on the wire.
  if (method !== null && FIRE_AND_FORGET_METHODS.has(method)) {
    return { action: "ignore", method };
  }

  const rawId = event["id"];
  if (typeof rawId !== "string" || rawId === "") {
    return { action: "unanswerable", method, reason: "no_request_id" };
  }

  if (method === null) {
    return { action: "answer", id: rawId, method: "<absent>", unblocker: null, unrecognised: true };
  }

  const unblocker = DIALOG_METHODS.get(method);
  if (unblocker !== undefined) {
    return { action: "answer", id: rawId, method, unblocker, unrecognised: false };
  }

  return { action: "answer", id: rawId, method, unblocker: null, unrecognised: true };
}
