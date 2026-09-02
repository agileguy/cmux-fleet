/**
 * The keystroke, removed — a staged task starts its own turn (SRD §9 Q4).
 *
 * ## What this is, and why it is allowed to exist at all
 *
 * §4.3 refused to TYPE a brief into an adopted terminal, and D2 upheld the
 * refusal: the surface has a second, human writer, so bytes aimed at a composer
 * can land in whatever that person had focused, and a `shift+enter` submits the
 * concatenation. §6 answered by staging the brief to `/policy/dispatch` and
 * handing the keystroke back to the operator.
 *
 * §9 Q4 asked whether the keystroke could be given back WITHOUT the hazard, and
 * predicted no — "a TTY has one owner". **The prediction was wrong, and it was
 * wrong for a reason worth keeping in front of the reader: `Docs/SRD.md` §162
 * governs who may WRITE TO THE TERMINAL, and this file never touches the
 * terminal.** Pi enumerates its own input sources as
 * `"interactive" | "rpc" | "extension"`, and `pi.sendUserMessage()` is
 * documented "Always triggers a turn." The brief does not enter the composer's
 * buffer, is not concatenated onto a half-typed line, and is not submitted by a
 * key. §4.3's hazard is not mitigated here — it is **not present**, because the
 * mechanism it describes is not the mechanism in use.
 *
 * ## Why this polls, which is the one thing about it that looks wrong
 *
 * The obvious implementation is `fs.watch` — inotify, event-driven, no timer.
 * It does not work, and it fails in the direction that costs the most:
 * **silently**. Measured 2026-09-02 against this image, a bind mount, and a
 * host-side write performed exactly as `dispatch-policy.ts` performs it:
 *
 *     fs.watch    on the mounted directory   -> ZERO events
 *     fs.watchFile on the mounted file       -> fired
 *     readFileSync poll                      -> fired
 *
 * Docker Desktop's file sharing does not propagate host-side inotify into the
 * container. An `fs.watch` build would pass every test written inside the
 * container, look correct in review, and never once trigger on a real stage —
 * a worker that waits forever for an event that is never delivered, which is
 * the precise "looks delivered, does nothing" failure this route was designed
 * to eliminate. So the loop is a stat poll, and the comment is here because the
 * next reader's first instinct will be to "fix" it.
 *
 * ## Why a torn read needs TWO guards, the second of which was not obvious
 *
 * The same measurement caught the second hazard. `dispatch-policy.ts` rewrites
 * the drop IN PLACE — chmod 0644, truncate, write, chmod 0444 — because a bind
 * mount pins the inode and a rename would swap the file the host sees while the
 * container kept reading the old one. In-place is therefore correct AND not
 * atomic: the probe observed the file as `"v1"` and, 300ms later, as
 * `"v1 STAGED FROM HOST"`. A reader can see a half-written file.
 *
 * The first guard is the JSON parse in `readStagedHeader`. This file originally
 * claimed that guard was sufficient — *"a firing rule that cannot act on a
 * fragment is stronger than one that waits"* — and `test/unit/auto-trigger.test.ts`
 * refuted it on the first run by feeding it **every prefix** of a real drop. The
 * claim is false, and it is false in the direction that matters: a prefix that
 * stops right after the separator line has a COMPLETE, VALID header and an
 * EMPTY prompt. It parses. It fires. The worker is then told to go and read a
 * brief that has not finished being written.
 *
 * So the second guard is a stability check: the file must read IDENTICALLY on
 * two consecutive ticks before anything fires. That covers a tear wherever it
 * lands, including the middle of the prompt, where no amount of header
 * validation can help — the header is intact in that case by definition. The
 * price is up to one extra `POLL_MS` of latency, which is the correct thing to
 * spend it on, and the lesson is worth more than the fix: **the guard that
 * looked principled covered the tears that were easy to imagine, and the test
 * that enumerated all of them found the one that was not.**
 *
 * ## Dedup is on (task_id, epoch), and both halves earn their place
 *
 * `task_id` alone re-fires when the same task is re-staged after a settle,
 * which is a legitimate second dispatch. `epoch` alone is not unique across
 * workers. Together they are exactly the identity `EpochManager.allocate`
 * issued, so this fires once per allocation — the same unit the ledger, the
 * outbox and `wait` all key on.
 */

import { readFileSync } from "node:fs";

/**
 * The slice of Pi's `ExtensionAPI` this file uses, declared STRUCTURALLY rather
 * than imported from `@earendil-works/pi-coding-agent`.
 *
 * The package is present inside the worker image and absent from this repo, so
 * a real import would make this file uncheckable here — and `tsconfig.json`
 * includes only `src/**` and `test/**`, so it was uncheckable anyway until this
 * declaration let a test under `test/` import it and drag it into the program.
 * **A file nothing typechecks and nothing tests is exactly the shape of the
 * silent `fs.watch` failure this extension was rewritten to avoid**, one level
 * up: correct-looking, unverified, and shipped into a container where the first
 * evidence of a mistake is a worker that never starts.
 *
 * The declaration is a SUBSET, so it cannot drift into claiming Pi has a method
 * it does not — it can only fail to mention ones this file never calls. If Pi's
 * signature changes, `test/integration/auto-trigger-image.test.ts` reads the
 * real `.d.ts` out of the image and fails.
 */
interface ExtensionAPI {
  on(event: "session_start", handler: (...args: unknown[]) => unknown): void;
  on(event: "session_shutdown", handler: (...args: unknown[]) => unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

/** Mirrors `DISPATCH_POLICY_MOUNT`. */
const DROP = "/policy/dispatch";
/** Mirrors `DISPATCH_POLICY_SEPARATOR`. */
const SEPARATOR = "--- pifleet dispatch prompt ---";
/** Mirrors `DISPATCH_POLICY_SCHEMA`. */
const SCHEMA = "pifleet.dispatch/v1";

/**
 * How often the drop is stat-read.
 *
 * 500ms is chosen against the operator's perception rather than against a
 * throughput budget: this is the delay between `pifleet dispatch` returning and
 * the pane starting to move, and half a second reads as "immediately" while two
 * seconds reads as "did that work?". The cost is one `readFileSync` of a file
 * that is at most `MAX_DISPATCH_POLICY_BYTES` and is in page cache, twice a
 * second, for the life of a worker that is otherwise idle.
 */
const POLL_MS = 500;

/**
 * What the worker is told, and why it is a POINTER rather than the brief.
 *
 * The brief is already on disk, complete, at a path the worker can read. Send
 * it inline and there are two copies of the task in two places with no rule
 * about which wins when they differ. More importantly, the typed route makes
 * the worker READ `/policy/dispatch`, so sending the brief here would give the
 * two routes different transcripts for the same dispatch and make
 * `skills/pifleet-worker/SKILL.md` describe a behaviour that only half the
 * workers exhibit.
 *
 * It is deliberately NOT `STAGED_TRIGGER_LINE`. That constant is shaped by a
 * constraint that does not apply here — it must be inert if it lands in a
 * SHELL, which is why it starts with `#` — and this text can never reach a
 * shell. Reusing it would import a `#` whose reason had evaporated, and would
 * make the two routes indistinguishable in the transcript at exactly the moment
 * §9 Q1 needs to tell them apart (see below).
 */
export const AUTO_TRIGGER_TEXT =
  "pifleet auto-trigger: a task was staged for you. Read /policy/dispatch and do what it says.";

interface StagedHeader {
  schema: string;
  staged: boolean;
  task_id?: string;
  epoch?: number;
}

/**
 * Parse the drop's header line, or return null.
 *
 * Null for every failure — absent file, torn read, unknown schema, idle arm —
 * because the caller's response to all four is identical: do nothing, look
 * again next tick. Distinguishing them would produce log lines about a file
 * being rewritten, which is the normal case.
 */
export function readStagedHeader(body: string): { taskId: string; epoch: number } | null {
  const nl = body.indexOf("\n");
  if (nl < 0) return null;
  // The separator must be line 2 or this is not a rendered drop. Checked
  // BEFORE the parse so a prompt whose first line happens to be JSON cannot be
  // mistaken for a header on a file whose header has not landed yet.
  const rest = body.slice(nl + 1);
  if (!rest.startsWith(`${SEPARATOR}\n`) && rest.trimEnd() !== SEPARATOR) return null;
  let header: StagedHeader;
  try {
    header = JSON.parse(body.slice(0, nl)) as StagedHeader;
  } catch {
    return null;
  }
  if (header.schema !== SCHEMA || header.staged !== true) return null;
  if (typeof header.task_id !== "string" || typeof header.epoch !== "number") return null;
  return { taskId: header.task_id, epoch: header.epoch };
}

export default function (pi: ExtensionAPI): void {
  let lastFired: string | null = null;
  let lastBody: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    let body: string;
    try {
      body = readFileSync(DROP, "utf8");
    } catch {
      // No mount, or the drop was chmod'd 0644 mid-rewrite and then read
      // before the write. Both are transient by construction. `lastBody` is
      // reset so an unreadable moment cannot be the first half of a "stable"
      // pair with the bytes that arrive after it.
      lastBody = null;
      return;
    }
    /*
     * THE STABILITY GATE. See the header: a prefix ending at the separator is a
     * VALID header with an empty prompt, so the parse below cannot be the only
     * guard. Two identical consecutive reads is what makes a tear inert
     * wherever it falls — including inside the prompt, where the header is
     * intact and no validation of it could help.
     */
    const previous = lastBody;
    lastBody = body;
    if (previous !== body) return;
    const staged = readStagedHeader(body);
    if (staged === null) return;
    const key = `${staged.taskId}@${staged.epoch}`;
    if (key === lastFired) return;
    /*
     * Set BEFORE the send, not after.
     *
     * `sendUserMessage` is synchronous in its return but not in its effect, and
     * this timer keeps running. Marking after would let a slow turn-start
     * overlap the next tick and dispatch the same allocation twice — which
     * `EpochManager` would not catch, because it is not consulted here: the
     * epoch was allocated at stage time and this side only observes it.
     */
    lastFired = key;
    /*
     * `followUp`, never `steer`.
     *
     * `steer` interrupts a running turn to redirect it. If the operator is
     * mid-task — or a previous staged task is still running — that discards
     * work nobody asked to discard, and does it invisibly. `followUp` queues
     * the message until the agent is idle, which is the behaviour a person
     * would expect from something that fires on its own.
     */
    pi.sendUserMessage(AUTO_TRIGGER_TEXT, { deliverAs: "followUp" });
  };

  /*
   * Armed on `session_start` rather than at load, so the poll cannot outlive
   * the session it belongs to, and torn down on `session_shutdown` so a
   * `/clear` or a session switch does not leave two timers reading the same
   * file and racing each other to `lastFired`.
   */
  pi.on("session_start", () => {
    if (timer !== null) return;
    timer = setInterval(tick, POLL_MS);
    // Do not hold the process open on account of a poll: a worker whose agent
    // has exited must be allowed to exit, and an unref'd timer is the only
    // thing standing between this file and a container that never stops.
    timer.unref?.();
  });
  pi.on("session_shutdown", () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  });
}
