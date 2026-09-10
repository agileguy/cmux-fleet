/**
 * The five producers a sweep needs — SRD-TRIAGE-CONSOLE §7.2, §7.4, §7.5, §12.6;
 * §13 task 6.1a.
 *
 * ## Why this module exists, and why it is not four lines in the command
 *
 * `SweepDriver` has nine members. Task 6.2 wired four of them from the run tree
 * and found that the other four had **no producer anywhere in `src/`** and were
 * assigned to no task in §13 — so `pifleet triage --once` refused by name rather
 * than sweeping nothing and reporting success. This module is those producers.
 *
 * §13 refused to let the envelope be written inline in the command and gave the
 * reason as the acceptance criterion: it *"carries its own §7.2/§12.6 security
 * contract — no credential, no host path, no raw command, and above all not 'the
 * contents of a previous worker's report as instruction' — which is a decision
 * §12's mirror anti-criterion forbids living in an untested CLI layer one level
 * down."*
 *
 * ## THE ANTI-CRITERION IS STRUCTURAL FIRST AND AUDITED SECOND
 *
 * §7.2 forbids four classes and §13 ranks one of them above the others, because
 * a cadence invites violating it: *"the obvious way to give a sweep continuity is
 * to paste the last sweep's prose into it."* Two mechanisms, in this order.
 *
 * **1. The projection, which makes the violation unrepresentable.**
 * {@link renderSweepEnvelope} takes the previous sweep's `triage.json` as a WHOLE
 * DOCUMENT and projects it itself — a caller cannot hand it prose because there
 * is no parameter that accepts any. {@link projectPreviousState} keeps exactly
 * two things per row: a service name **the host itself declared**, and an
 * `assessment` token from a closed four-member enum. The selector, the window
 * spelling, the evidence ledger, the coverage channel names and the
 * `unaccounted[]` list are worker-authored strings and none of them has anywhere
 * to sit.
 *
 * **2. The audit, which is the tripwire for the day somebody adds a field.**
 * {@link envelopeIssues} re-reads the rendered text against the very document it
 * was projected from and refuses any of its prose that survived, and
 * {@link renderSweepEnvelope} runs that audit on its own output and throws. A
 * structural guarantee that nothing checks is a guarantee that lasts until the
 * next edit; this is what makes that edit red.
 *
 * The other three classes are checked in the same pass and by the same shape — a
 * closed, exported set of names ({@link FORBIDDEN_ENVELOPE_CLASSES}), so a fifth
 * class or a quietly deleted fourth is an edit somebody makes on purpose. That is
 * `test/unit/monitor-readonly.test.ts:363-369`'s rule, which §12 asks this
 * console to inherit rather than rediscover.
 *
 * ## A NOTE ON WHAT THE `credential` REFUSAL PRINTS
 *
 * Nothing. `notifyEndpointIssue` (`triage-config.ts:223`) records the property
 * and it applies with more force here: this message reaches §7.7's append-only
 * log, *"which appends forever and is never truncated"*, and `--status` prints
 * from the same family of surfaces. A refusal that quoted the secret back would
 * publish the thing it refused.
 *
 * ## THE DISPATCH IS A PORT, AND THAT IS FORCED RATHER THAN CHOSEN
 *
 * §12 permits this console exactly ONE mutating exception — its dispatch path,
 * `run/dispatch-request.ts` — and the 2026-09-06 RULING says *"a second entry
 * would be the tell that this ruling was quietly reversed"*. The production
 * dispatch is `sendTaskEnvelope`, which lives in `cli/commands/dispatch.ts` and
 * requires a `LedgerWriter`; both are banned from this subtree by name in
 * `test/unit/triage-readonly.test.ts`. So {@link SweepDispatch} is an injected
 * effect, this module's own import closure reaches no mutating verb and no ledger
 * writer, and the question of who constructs the production effect is recorded
 * against §13 rather than answered by widening the allowlist.
 *
 * **{@link SweepDispatch} returns when the task has SETTLED, not when it was
 * accepted, and that is a contract this module depends on rather than a
 * preference.** §6.3 numbers dispatch and read as separate steps (2-3 and 8-9)
 * but gives `SweepDriver` no member between them, so `collate` must be able to
 * read the document the task it just dispatched wrote. Putting the wait behind
 * the port keeps it out of every fixture and keeps this module free of a clock —
 * `triage-pass.ts`'s own posture: *"It does not sleep, retry, or schedule."*
 */

import { readDispatchRequest, TRIAGE_CONSOLE_ROSTER } from "./dispatch-request.ts";
import { taskRecordPath, workerOutboxDir, workerPaths, type RunPaths } from "./paths.ts";
import { replyMountPath } from "./replies.ts";
/**
 * TYPE ONLY, and the distinction is what keeps §12's read-only block intact.
 *
 * `test/unit/triage-readonly.test.ts` bans control-plane MODULES by import and
 * mutating VERBS by name; a type erased at compile time is neither, and this
 * module already imports `replies.ts` — which exports `writeReply` — on exactly
 * that reading. What the import buys is one spelling of the three attribution
 * fields a declaration entry carries, shared with `replies-policy.ts`, which
 * owns them. Re-typing `{task_id, worker, aspect}` here would be the second
 * answer this console keeps having to refuse.
 */
import type { DeclaredReply } from "./replies-policy.ts";
import {
  type AspectSeat,
  childTaskId,
  collationTaskId,
  TRIAGE_CONSOLE_ASPECTS,
} from "./task-ids.ts";
import { TRIAGE_COLLATOR } from "./triage-actor.ts";
import {
  parseTriageDocument,
  type TriageDocumentContext,
  type TriageDocumentRead,
} from "./triage-document.ts";
import type { PartitionAssignment } from "./triage-partition.ts";
import type { SweepCollation, SweepJoin, SweepOpen } from "./triage-pass.ts";
import { TRIAGE_CHECKS, type TriageService } from "./triage-targets.ts";
import {
  COVERAGE_RESULTS,
  OBSERVER_ASSESSMENTS,
  type ObserverArtifact,
  type ObserverAssessment,
  type TriageDocument,
} from "./triage-verdict.ts";

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Names on disk
// ---------------------------------------------------------------------------

/**
 * `<outbox>/<task-id>/files/` — the directory every artifact pair lands in.
 *
 * **A deliberate second spelling of `harvest/outbox.ts`'s `OUTBOX_FILES_DIR`,
 * and the duplication is recorded rather than hidden.** §12's read-only block
 * scopes its bans to this console's own subtree, and importing `harvest/` from a
 * console module — to reach a four-character string — would put a harvester in
 * the import closure of a module whose whole claim is that it cannot act on the
 * fleet. The copy is pinned to the original by an assertion in
 * `test/unit/triage-envelope.test.ts`, which is not in the subtree and may import
 * both, so the two cannot drift while that test is green.
 */
export const SWEEP_FILES_DIR = "files";

/** `skills/observer-ops/SKILL.md:26-33`'s pair, the half a host validates. */
export const OBSERVER_ARTIFACT_FILE = "observer-ops.json";

/** §7.5's document, written by `tri-1` on turn two beside a `triage.md`. */
export const TRIAGE_DOCUMENT_FILE = "triage.json";

/** Where one observer's reply artifact sits on the host. */
export function observerArtifactPath(run: RunPaths, worker: string, taskId: string): string {
  return join(workerOutboxDir(run.root, worker), taskId, SWEEP_FILES_DIR, OBSERVER_ARTIFACT_FILE);
}

/** Where the collator's §7.5 document sits on the host. */
export function triageDocumentPath(run: RunPaths, collateTaskId: string): string {
  return join(
    workerOutboxDir(run.root, TRIAGE_COLLATOR),
    collateTaskId,
    SWEEP_FILES_DIR,
    TRIAGE_DOCUMENT_FILE,
  );
}

/**
 * Rewrite the outbox path in a slice brief to the id the slice is DISPATCHED
 * under, whatever id the collator wrote there.
 *
 * **Both prompts already forbid the mistake this repairs, and both were
 * disobeyed on the same sweep.** `roles/triage.md:212` tells `tri-1` to name
 * *"its own task id, not yours"*; `roles/observer.md:139` tells the observer to
 * write *"in the directory named by the id you were dispatched under"*. Measured
 * 2026-09-07 on `T-sweep-1`: `tri-1` wrote `/outbox/T-sweep-1/files/` — its OWN
 * id, the one word its instruction excludes — and `obs-t1` believed the brief
 * over its own envelope and wrote there. `T-sweep-1-slice1/files/` stayed empty.
 *
 * **The failure is silent in the direction that matters.** `observerArtifactPath`
 * reads `<seat>/outbox/<worker>/<child-task-id>/files/`, so a report at the
 * parent's id is indistinguishable from a seat that wrote nothing: three services
 * came back unobserved, `consecutive_indeterminate` climbed 52 -> 55 across three
 * sweeps, and `last_artifact_ref` stayed `null` — while the observer was
 * producing correct, correctly-shaped artifacts the whole time. The console
 * reported `coverage` on a cluster that had answered, which is the exact defect
 * `seatRun`'s note above was added for, one layer further out.
 *
 * **A third prompt line was the obvious fix and is the wrong one.** Two emphatic
 * instructions did not hold; the host, at the one line that already computes the
 * correct id, is where this stops being a matter of a model remembering. The
 * pattern is `renderCollationEnvelope`'s: the host writes the reporting path it
 * will later read, rather than asking for it back.
 *
 * **Why they did not hold is sharper than "a model forgot", and it took reading
 * the artifact to see it (ISC-1120).** `T-sweep-13`'s live request:
 * *"Write both `observer-ops.json` and `observer-ops.md` into
 * `/outbox/T-sweep-13/files/` using the observer's own task id."* The collator
 * reproduced `roles/triage.md:212`'s own phrase — *"its own task id, not yours"* —
 * and then filled the path with the only id it holds. **It obeyed the sentence and
 * could not obey the value.** `T-sweep-13-slice1` is `childTaskId(sweepId,
 * aspect)` over `TRIAGE_CONSOLE_ASPECTS`, a host constant the collator has never
 * been shown; at the moment it composes the fan-out it possesses exactly one task
 * id, and it is the one the instruction forbids. No count of emphatic lines closes
 * a gap that is missing DATA rather than missing attention — which is why the two
 * that were tried read, in hindsight, like the same line twice.
 *
 * `renderSweepEnvelope` now carries a `## The seats` block naming each seat's
 * dispatch id and reporting path, so the instruction and the datum arrive
 * together. This function stays: it is the last place that can act, and a
 * substitution it reports is now a real fault rather than a foregone one.
 *
 * Rewrites rather than refuses, deliberately, and it is the one judgement here
 * worth revisiting: refusing would match this file's preference for a loud stop
 * over a quiet repair, but it would also stop every sweep until a model changes
 * its mind, and the console's job is to watch the environment rather than to
 * hold it hostage to its own collator. The substitution is reported by the caller
 * so it is repaired AND visible, never silently.
 *
 * **THE ONE REPAIR THAT SURVIVED ISC-1136, and the reason is a distinction worth
 * keeping.** Its three siblings compensated for an ABSENCE — a sentence the
 * collator failed to write — and {@link composeObserverBrief} now writes those
 * itself, so there is nothing left for them to check. This one corrects a
 * WRONGNESS. Authoring the correct outbox path does not delete an incorrect one
 * already sitting in the collator's prose, and an observer handed both has to
 * choose between them; `T-sweep-1` is the record of which it chooses. So this
 * still runs, on the collator's contribution, before that contribution is carried.
 *
 * Returns the brief unchanged when it names no outbox path, or already names the
 * right one.
 */
export function normalizeSliceReportingPath(
  brief: string,
  childTaskId: string,
): { readonly brief: string; readonly rewrote: readonly string[] } {
  const wrong: string[] = [];
  const rewritten = brief.replace(
    /\/outbox\/([A-Za-z0-9._-]+)\/files\//g,
    (whole, named: string) => {
      if (named === childTaskId) return whole;
      wrong.push(named);
      return `/outbox/${childTaskId}/files/`;
    },
  );
  return { brief: rewritten, rewrote: wrong };
}

/**
 * §7.4's freshness-echo INSTRUCTION, in the words that were argued for it.
 *
 * **This was `ensureFreshnessEcho`, a conditional repair, and it is now an
 * unconditional author (ISC-1136).** Nothing about the sentence changed; what
 * changed is that the host no longer asks whether the collator remembered it.
 * The old shape read the brief, found the two spellings absent, appended them and
 * warned — a check whose "already present" arm was reached on no measured sweep.
 * A guard that only passes when its claim is trivially true is worse than none,
 * because a green run asserts the sentence was read.
 *
 * **This states a demand, never an answer, and the distinction is the whole
 * design.** `sweepIdEcho`'s comparand is the host's own minted id precisely so a
 * value the artifact supplied cannot be compared to itself — the same argument
 * `windowEcho` makes about `dispatched_at`. So the host must never write
 * `sweep_id` INTO an artifact; doing so would leave the check passing forever and
 * §6.6 layer 3 guarding nothing. What the host may do is make sure the observer
 * was told, which is the fault `sweepIdEcho` names when it returns `absent`
 * rather than `stale`: *"a contract violation by a worker that may never have
 * been told, which is a different thing to go and fix."*
 *
 * It had never been told. Measured 2026-09-08, against the role file as it read
 * THEN — the bullet ISC-1136 has since removed, because this function now authors
 * the demand instead of checking for it. `roles/triage.md` instructed the
 * collator to carry "the sweep id, verbatim, with the instruction to echo it in
 * `observer-ops.json`", and across five sweeps the collator carried the VALUE
 * ("Sweep T-sweep-1. Observation window opens ...") and dropped the INSTRUCTION
 * every time. Five artifacts with correct workloads and real findings — including a
 * Grafana rule-evaluator fault — were discarded whole, `consecutive_indeterminate`
 * reached 60, and the console reported `coverage` on an environment that had
 * answered. Nothing in the observer's output looked wrong, because nothing in it
 * was.
 *
 * **"Dropped the INSTRUCTION" was wrong, and the correction is the whole of
 * ISC-1119.** Re-measured 2026-09-09 against the artifact rather than against this
 * warning's own wording — `T-sweep-13`'s request, live on the console:
 * *"Echo sweep id T-sweep-13 and window 2026-09-09T12:12:44.316Z in
 * `observer-ops.json`."* The instruction is THERE, and it is a faithful rendering
 * of what that bullet asked for. What is absent is the two SPELLINGS.
 * The check below greps for `sweep_id` and `window_opened_at`; the collator wrote
 * English, because English is what it was given — neither the role file nor
 * `renderSweepEnvelope` had ever named a field. So this function's `appended`
 * warning has been telling the operator that a compliant worker was
 * non-compliant, 22 times in the log it writes to.
 *
 * **The upstream fix was made and it did not hold, which is the evidence for
 * authoring rather than checking.** `renderSweepEnvelope` names both fields in the
 * collator's own brief — the only document the collator composes from — and the
 * repair still fired on every sweep after it. The remaining sentence, *"this
 * should now fire on a genuine regression and not once per sweep"*, was a
 * prediction, and it was falsified before it was a week old.
 *
 * Both values are already present in the brief as prose, so this adds no
 * information the observer did not have; it adds the sentence that says what to do
 * with them. The observer still has to copy them, and a replayed artifact still
 * fails the comparison.
 */
export function freshnessEchoDemand(sweepId: string, window: string | null): string {
  const windowClause =
    window === null
      ? "`window_opened_at` exactly as this brief states the observation window opening"
      : `\`window_opened_at\` exactly "${window}"`;
  return (
    `Echo \`sweep_id\` exactly "${sweepId}" and ${windowClause} as top-level fields of ` +
    `\`observer-ops.json\`, copied from this brief and from nowhere else. An artifact ` +
    `missing either is discarded whole and every service in it is recorded as unobserved.`
  );
}

/**
 * The observation-window instant, READ OUT OF THE COLLATOR'S JUDGEMENT rather
 * than passed in, and that is not a convenience.
 *
 * `dispatchObserver` does not hold `dispatched_at` — `openSweep` does, and the two
 * are separate members of `SweepProducers` with no value passed between them. The
 * host minting a second instant here would put a value in front of the observer
 * that `windowEcho` never compared against: a third spelling of the same quantity,
 * which §7.4 spends a whole field's justification avoiding.
 *
 * **So this is the one thing in the invariant block the host genuinely cannot
 * author, and it is why `renderSweepEnvelope` still demands the collator copy the
 * instant into every brief it writes.** If the collator dropped it, `null` says so
 * instead of inventing one, and {@link freshnessEchoDemand} degrades to naming the
 * brief rather than a value.
 */
export function readWindowInstant(brief: string): string | null {
  return /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(brief)?.[1] ?? null;
}

/**
 * The coverage-result domain, in the words that were argued for it (ISC-1131).
 *
 * **This was `ensureCoverageVocabulary`, a conditional repair, and it is now an
 * unconditional author (ISC-1136).** It is the repair whose record made the case:
 * the collator dropped this domain from the child brief on sweeps 22, 26, 27, 28
 * AND 29 while its own brief named `answered` seven times. A predicate that never
 * once took its other branch is not a guard, it is a sentence the host was going
 * to write anyway with a condition in front of it.
 *
 * ## The measurement
 *
 * `T-sweep-22`, 2026-09-09, run by hand. The collator's collation was refused
 * whole and all three services were recorded unobserved, on six copies of one
 * error:
 *
 *     services.N.coverage.M.result: Invalid option:
 *       expected one of "answered"|"unreachable"|"forbidden"|"not_attempted"
 *
 * The observer had written `"result": "healthy"` — a member of
 * `OBSERVER_ASSESSMENTS`, in a field whose domain is `COVERAGE_RESULTS`. It did
 * the work correctly otherwise: both channels checked on all three services, a
 * real selector, a real window, real evidence refs. It got one vocabulary wrong
 * and lost the entire sweep.
 *
 * ## Why it reached for the wrong one, which is the part that generalises
 *
 * The brief it was handed named `assessment` and its four values, and named
 * `coverage[].result` with NO values at all. A model holding one enum and a
 * field that needs one it was never given will reuse the enum it has. The
 * observer was not being careless; it was completing the only pattern in front
 * of it.
 *
 * ## Why the fix is here and not in the envelope or the skill
 *
 * Both of those were already correct. `renderSweepEnvelope` names `answered`
 * seven times in the collator's own 5,472-character brief, and
 * `skills/observer-ops/SKILL.md` carries the full row shape (ISC-1125). The
 * collator READ the vocabulary and did not COPY it into the child brief it
 * composed — which is [[ISC-1119]]'s shape exactly, one level down.
 *
 * **And it is intermittent, which is what settles the argument.** Sweeps 19 and
 * 21 produced `answered` correctly from this same code and this same envelope;
 * sweep 22 did not. So there is no upstream wording left to sharpen: the
 * instruction is present, it is read, and it is obeyed on some passes and not
 * others. [[ISC-1121]] is the recorded precedent for what happens next if this
 * were answered with more prose — a bound that reached the brief, was ignored,
 * and taught that a prompt cannot make a model deterministic. The host is the
 * last place that can act, and unlike a sentence it cannot forget.
 *
 * ## The vocabulary is IMPORTED, not restated
 *
 * From `COVERAGE_RESULTS`, the same constant `evidenceGaps` grades against and
 * the schema validates with. A repair that spelled its own copy would be a third
 * spelling of the enum whose second spelling is the bug — and the ISA's own
 * ISC-869 records the rule: *"an assertion that two copies agree is a third
 * copy."* Add a fifth member to `COVERAGE_RESULTS` and this sentence grows it
 * with no edit here.
 *
 * ## ALL FOUR, not just one
 *
 * A brief carrying `answered` alone is the condition that produced this defect,
 * not a brief that has escaped it: a partial enum is precisely what invites a
 * model to invent the rest of it. The old repair fired unless the observer could
 * see the closed set; authoring it states the closed set unconditionally, which
 * is the same property with nothing left to get wrong.
 */
export const COVERAGE_VOCABULARY_DEMAND: string = ((): string => {
  const values = COVERAGE_RESULTS.map((r) => `"${r}"`).join(", ");
  return (
    `Every \`result\` inside \`coverage\` must be exactly one of ${values} — that field records ` +
    `whether the CHANNEL ANSWERED YOU, not whether the service is well. It never carries an ` +
    `assessment word: "healthy" is not a coverage result, and an artifact using one is refused ` +
    `whole and every service in it is recorded unobserved.`
  );
})();

/**
 * How long one cluster call may take before the observer stops waiting for it
 * (ISC-1134).
 *
 * **Derived from the deadline it protects, not chosen.** The child deadline is
 * 480 s (`childDeadlineS`: a 780 s settle bound less the 300 s margin). A sweep
 * of three services across two channels is on the order of ten cluster calls,
 * so a bound of 30 s costs a fully unreachable environment about five minutes of
 * its eight and still leaves the seat time to write the artifact saying so.
 * Raising it much past 45 s reinstates the failure — the calls alone consume the
 * deadline; dropping it much below 20 s starts refusing a slow-but-working API.
 */
export const CLUSTER_CALL_TIMEOUT_S = 30;

/**
 * The call bound, and the one demand that turns a correct answer into a timely
 * one (ISC-1134).
 *
 * **This was `ensureBoundedCalls`, the fourth conditional repair, and its own
 * docblock is what argued this file into ISC-1136.** It named the alternative —
 * *"the host composing the invariant half of every child brief and letting the
 * collator contribute only the per-sweep judgement"* — and declined it as *"a
 * change to §6.3's division of labour rather than a fix"*. That was the right call
 * for a latency patch and the wrong place to leave it. The change is taken now, on
 * its own, and this text is what survives of the repair.
 *
 * ## What went wrong, and what did NOT
 *
 * 2026-09-09, `utun9` carrying zero routes: every `kubectl` the observer issued
 * spent about three minutes retrying an unreachable API server before failing on
 * a client-side rate limiter, and two consecutive sweeps hit the 480 s deadline
 * with no artifact at all.
 *
 * **The console was not wrong about the environment for one second of that.**
 * Every service record read `firing`, `reason: coverage` — *"I could not tell"* —
 * and `_console/sweep_produced_nothing` fired. Nothing was reported healthy.
 * That is SRD-TRIAGE-CONSOLE's central distinction holding under exactly the
 * condition it was written for, and it is why this is a LATENCY fix and not a
 * correctness one: the console reached the right answer, it just paid eight
 * minutes a sweep to get there and produced no artifact an operator could read.
 *
 * `COVERAGE_RESULTS` has carried `unreachable` since the beginning. What was
 * missing is any instruction on how to REACH it: an unbounded call does not fail,
 * it hangs, and a channel that hangs is never reported as anything.
 *
 * ## The spelling is load-bearing, and the obvious one is refused
 *
 * `kubectl --request-timeout=30s get ns` is rejected by the container's verbgate
 * as `kubectl (flags-before-verb) not authorized`; `kubectl get ns
 * --request-timeout=30s` runs. Both were tried against the live worker before
 * this text was written, because an instruction the sandbox refuses is worse
 * than no instruction — it spends the model's turn on a call that cannot run.
 * The brief therefore shows the legal form as a literal example.
 *
 * ## Why the HOST states it rather than the envelope asking the collator to
 *
 * `renderSweepEnvelope` is the collator's brief, and the collator used to compose
 * the observer's brief from it. Measured on sweeps 26, 27, 28 and 29: it dropped
 * the coverage vocabulary from that child brief **every time**, though its own
 * brief named it seven times. Anything that must reach the observer cannot be
 * routed through a composer with that record — which is the sentence that stopped
 * being an argument for a fourth patch and became an argument for the composition
 * change instead.
 *
 * ## The spelling is the reason this is a constant and not a sentence anyone
 * ## retypes
 *
 * `--request-timeout` appears twice below and `CLUSTER_CALL_TIMEOUT_S` supplies
 * the value both times, so raising the bound cannot leave the worked example
 * quoting the old one.
 */
export const BOUNDED_CALLS_DEMAND: string =
  `Bound every cluster call: pass \`--request-timeout=${CLUSTER_CALL_TIMEOUT_S}s\` AFTER the ` +
  `verb, as in \`kubectl get pods -n <ns> --request-timeout=${CLUSTER_CALL_TIMEOUT_S}s\` — before ` +
  `the verb it is refused and nothing runs. A call that times out is not a failure to report ` +
  `later: it is this channel's answer NOW, and its \`result\` is "unreachable". Do not retry it ` +
  `and do not wait longer. An environment you cannot reach must produce an artifact saying so ` +
  `inside your deadline; an artifact that never arrives tells the operator nothing at all.`;

/**
 * The heading that marks where the collator stops speaking and the host starts.
 *
 * The four repairs used to append their sentences onto the end of whatever
 * paragraph the collator had written, so an observer read one undifferentiated
 * wall in which the host's non-negotiable field spellings and the collator's
 * per-sweep guesses had exactly the same standing. They do not have the same
 * standing, and now the document says which is which.
 */
export const OBSERVER_CONTRACT_HEADING =
  "## What your artifact must carry, whatever the brief above says";

/**
 * The observer's brief: the host's invariant contract, plus the collator's
 * per-sweep judgement, and nothing else (ISC-1136).
 *
 * ## The division, which is the whole of this function
 *
 * §6.3 gave the collator the composition of every child brief, and four separate
 * measurements said it cannot do that job: [[ISC-1120]] the reporting path,
 * [[ISC-1119]] the freshness fields, [[ISC-1131]] the coverage vocabulary,
 * [[ISC-1134]] the call bound. Each was answered with a host repair that read the
 * collator's text, found the sentence missing and appended it — and each of those
 * repairs fired on every sweep it ever ran on. Four patches on one document is one
 * fact stated four times, and the fact is that the collator is unreliable at
 * composing a brief ([[ISC-1135]]).
 *
 * So the host AUTHORS what does not change between sweeps and the collator
 * contributes only what does: which services this slice holds, what to look at,
 * what the last sweep said. That is the judgement §6.3 actually wants from it.
 *
 * ## Three of the four stopped being repairs; the fourth could not
 *
 * {@link freshnessEchoDemand}, {@link COVERAGE_VOCABULARY_DEMAND} and
 * {@link BOUNDED_CALLS_DEMAND} each compensated for an ABSENCE, and an absence is
 * exactly what authoring removes — the host writes the sentence instead of asking
 * whether somebody else did.
 *
 * {@link normalizeSliceReportingPath} is different in kind and STAYS A REPAIR.
 * It corrects a WRONGNESS: the collator asserts an outbox path that is actively
 * wrong, and authoring the right path does not delete a wrong one already sitting
 * in the collator's prose. An observer handed both would have to choose, and
 * `T-sweep-1` is the record of which one it chooses. So the judgement is
 * normalised before it is carried, and the substitution is still reported.
 *
 * ## Judgement FIRST, contract SECOND
 *
 * Kept from the old call site's own argument for applying `ensureBoundedCalls`
 * last: *"the observer reads a brief top-down and the per-sweep judgement should
 * not be buried under two paragraphs of host boilerplate."* The contract is what
 * the observer checks its output against at the end; the judgement is what it acts
 * on at the start. Ordering them the other way would put four paragraphs of
 * invariant text in front of the one paragraph that differs between sweeps.
 */
export function composeObserverBrief(input: {
  /** The collator's per-sweep contribution — its `brief` from the fan-out request. */
  readonly judgement: string;
  readonly sweepId: string;
  /** The id the slice is DISPATCHED under, which is the only id the host reads back. */
  readonly childTaskId: string;
}): {
  readonly brief: string;
  /** Outbox ids the collator named that were not the child's. Empty is the good case. */
  readonly rewrote: readonly string[];
  /** The window instant found in the judgement, or `null` if it named none. */
  readonly window: string | null;
} {
  const reporting = normalizeSliceReportingPath(input.judgement, input.childTaskId);
  const window = readWindowInstant(reporting.brief);
  const brief = [
    reporting.brief.trimEnd(),
    "",
    OBSERVER_CONTRACT_HEADING,
    "",
    "These three paragraphs are written by the host on every dispatch, not by the collator",
    "whose brief you just read. Where they and anything above disagree about a field name, a",
    "value it may take, or a bound on a call, these win.",
    "",
    freshnessEchoDemand(input.sweepId, window),
    "",
    COVERAGE_VOCABULARY_DEMAND,
    "",
    BOUNDED_CALLS_DEMAND,
  ].join("\n");
  return { brief, rewrote: reporting.rewrote, window };
}

// ---------------------------------------------------------------------------
// §7.2 — the verdict rule, which travels because the skill does not carry it
// ---------------------------------------------------------------------------

/**
 * SRD-OBSERVER-001 §9.2's rule, verbatim, because Finding F measured that the
 * observers' own skill does not yet state it.
 *
 * `skills/observer-ops/SKILL.md:104-112`: *"Still unwritten: … the verdict rule
 * (`indeterminate` vs `healthy` vs `failed`)"*, with the interim instruction
 * *"apply the one your briefing states and do not invent a finer one"*. So this
 * console's briefs carry it, and §7.2 makes it a row of the envelope rather than
 * a note.
 *
 * **A constant rather than prose composed per sweep, and that is the product.**
 * `roles/triage.md:166-171`: *"a rule a model rewrites is a rule that drifts
 * between sweeps, and consecutive sweeps being comparable is the whole
 * product."*
 */
export const TRIAGE_VERDICT_RULE =
  "An assessment of healthy requires positive evidence, from a channel that can see the effect, " +
  "that the thing is working. Absence of a negative signal from a degraded channel set is " +
  "indeterminate — never healthy.";

// ---------------------------------------------------------------------------
// §7.2/§12.6 — the four classes
// ---------------------------------------------------------------------------

/**
 * What an envelope may never carry, adopted verbatim from SRD-OBSERVER-001 §7.4
 * through §7.2.
 *
 * **Four names, closed and exported, asserted by full value rather than by
 * count** — `monitor-readonly.test.ts:363-369`'s rule, which §12 asks this
 * console to inherit: naming the permitted set is what makes a fifth member fail.
 *
 * The order is §7.2's own sentence, and `worker_prose` is last in the list and
 * first in importance: §13 calls it *"the anti-criterion that outranks them"*.
 */
export const FORBIDDEN_ENVELOPE_CLASSES = [
  /** A credential or any part of one. */
  "credential",
  /** An absolute HOST path. A container mount point is not one — see {@link CONTAINER_MOUNTS}. */
  "host_path",
  /** A raw command to run. */
  "command",
  /** The contents of a previous worker's report, as instruction. */
  "worker_prose",
] as const;
export type ForbiddenEnvelopeClass = (typeof FORBIDDEN_ENVELOPE_CLASSES)[number];

/**
 * One violation, at one place, in a form a log can carry.
 *
 * `evidence` is a DESCRIPTION rather than the offending text for the
 * `credential` class and the offending text for the other three, which is the
 * asymmetry `notifyEndpointIssue` records: the other three are safe to quote and
 * are far easier to fix when they are.
 */
export interface EnvelopeIssue {
  readonly forbidden: ForbiddenEnvelopeClass;
  /** What was found, safe to print. Never a secret. */
  readonly evidence: string;
  readonly reason: string;
}

/**
 * The mount points a brief MAY name, because they are names inside a container
 * rather than reachable names on the operator's machine.
 *
 * **Without this the check would refuse the one instruction the fan-out cannot
 * work without.** `roles/triage.md:111` has the collator write
 * `/outbox/<task-id>/dispatch-request.json` and `:175` has each observer write
 * into `/outbox/<task-id>/files/`; `:234` has turn two read
 * `/replies/<child-task-id>.json`. A checker that banned every absolute string
 * would make a correct brief unwritable, which is how a security check gets
 * turned off rather than fixed.
 */
const CONTAINER_MOUNTS: ReadonlySet<string> = new Set([
  "outbox",
  "replies",
  "skills",
  "workspace",
]);

/**
 * Shapes that are a credential or a labelled place one goes.
 *
 * Two families and they catch different mistakes: a token with a recognisable
 * issuer prefix pasted bare, and any long opaque value introduced by a word that
 * means *"secret"*. Neither is exhaustive and neither is meant to be — the
 * structural defence is that the host composes this text out of typed fields, and
 * this is the tripwire for a hand-edited constant.
 */
const CREDENTIAL_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bghp_[A-Za-z0-9]{20,}/, what: "a GitHub token prefix" },
  { re: /\bgho_[A-Za-z0-9]{20,}/, what: "a GitHub token prefix" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: "a GitHub fine-grained token prefix" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token prefix" },
  { re: /\bsk-[A-Za-z0-9]{20,}/, what: "an OpenAI-style key prefix" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "a JWT" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a PEM private key header" },
  {
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]?\s*\S{8,}/i,
    what: "a secret-labelled value",
  },
];

/**
 * Command leaders, plus shell substitution and a shell code fence.
 *
 * §7.2 bans *"a raw command to execute"*, and the reason is §6.10's: the observer
 * has a verb gate and the brief must not be the thing that decides what it runs.
 * A closed leader list rather than a general "looks like shell" heuristic, on the
 * same rule the rest of this file follows — a named set fails loudly when it is
 * incomplete, and a heuristic fails quietly when it is wrong.
 */
const COMMAND_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /```(?:bash|sh|zsh|shell|console)\b/, what: "a shell code fence" },
  { re: /\$\(/, what: "a shell command substitution" },
  {
    re: /(^|[\s`'"([])(kubectl|gcloud|docker|helm|curl|wget|psql|bash|sh|rm|chmod|ssh)\s+-{0,2}[A-Za-z]/,
    what: "a command leader",
  },
];

/**
 * A path-shaped run of characters, anchored so ordinary prose does not match.
 *
 * Preceded by a boundary rather than matched anywhere, so `and/or` and
 * `services[0]` are not paths; and required to have a second segment, so a bare
 * `/` is not one either.
 */
const ABSOLUTE_PATH_RE = /(?:^|[\s`'"(<])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._<>{}-]*)+)/g;

/**
 * The floor under which a previous document's string is not evidence of
 * anything.
 *
 * **A short string cannot be told apart from the host's own vocabulary**, and the
 * document's fields are full of it: a `coverage[].channel` of `rollout` is also a
 * member of {@link TRIAGE_CHECKS}, which every brief names by design. The class
 * being defended is *"the CONTENTS of a previous worker's report"* — a finding, a
 * recommendation, a selector, a ledger reference — and none of those is seven
 * characters. Members of the host's closed vocabularies are skipped regardless of
 * length, so the floor is a second line rather than the only one.
 */
export const MIN_PROSE_LENGTH = 8;

/** Every token the HOST owns, which a document echoing one has not authored. */
const HOST_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...TRIAGE_CHECKS,
  ...OBSERVER_ASSESSMENTS,
  ...COVERAGE_RESULTS,
]);

/**
 * Every worker-authored string the previous document carries, as a set.
 *
 * Service names are deliberately ABSENT: {@link projectPreviousState} filters
 * them against the host's own declared list, which is a stronger check than a
 * substring search and is the one that belongs to them. `unaccounted[]` IS here,
 * because it is the worker's own claim about names and nothing filters it.
 */
function workerAuthoredStrings(
  document: TriageDocument,
  declared: readonly string[] = [],
  declaredNamespaces: readonly string[] = [],
): readonly string[] {
  /*
   * A name the HOST declared is not prose the worker wrote, wherever it appears.
   *
   * `unaccounted[]` is a list of SERVICE NAMES, and the host puts every declared
   * service name into every brief — so treating that list as worker prose makes a
   * correct report ("I could not account for these three") indistinguishable from
   * a contamination, and refuses the next sweep because it names its own targets.
   *
   * Measured 2026-09-07: a collation carrying
   * `unaccounted: [alert-notifier, prometheus, grafana]` refused every subsequent
   * sweep with `worker_prose`, quoting a service name out of the operator's own
   * targets file. The guard was working exactly as written; what was wrong is that
   * the host's vocabulary did not include the host's own service names.
   *
   * The check that DOES belong to these names is `projectPreviousState`'s filter
   * against `declared`, which this docblock already claimed for `row.service`.
   * An unaccounted name the host never declared is still a worker claim and is
   * still kept — that is the arm this exemption must not widen.
   *
   * ## The same defect through `selector`, measured 2026-09-09
   *
   * `cni-dev`: `T-sweep-26`'s collation wrote `"selector": "alert-notifier"` —
   * the bare service name where a label expression belongs — and sweeps 27, 28
   * and 29 were refused `worker_prose` quoting that name out of the operator's
   * own targets file. Three passes, 45 minutes, no observation; it ended when an
   * operator restarted the collator, which cleared it by ACCIDENT rather than by
   * fix, because a new run tree has no previous document to audit against.
   *
   * So `selector` gets the exemption too, and it is wider by exactly one thing:
   * the host writes every declared NAMESPACE into every brief as well, and a
   * selector degrading to a namespace trips identically. `unaccounted[]` does NOT
   * get the namespaces — it is a list of service names, and a namespace appearing
   * in it is the worker's own claim.
   *
   * **Membership, never containment.** `app=authorization` is a string the
   * collator composed and stays caught; only a value that IS a declared token is
   * a value the host handed it.
   */
  const hostNames = new Set(declared);
  const hostTokens = new Set([...declared, ...declaredNamespaces]);
  const out: string[] = [];
  const keep = (value: string | null): void => {
    if (value === null) return;
    if (value.length < MIN_PROSE_LENGTH) return;
    if (HOST_VOCABULARY.has(value)) return;
    out.push(value);
  };
  for (const row of document.services) {
    if (row.selector === null || !hostTokens.has(row.selector)) keep(row.selector);
    keep(row.window);
    // §13 task 5.8's carrier, added 2026-09-07. `note` is the one field on this
    // document whose PURPOSE is to be a sentence, so it is never a member of the
    // host's vocabulary and never short by accident — `MIN_PROSE_LENGTH`'s floor
    // matters least for it and the ban matters most.
    //
    // Nothing can leak through it today: `projectPreviousState` emits only
    // `{service, assessment}`, so no note crosses into the next brief. This list
    // is the SECOND mechanism — the re-audit that exists to catch a widened
    // projection — and a re-audit blind to a carrier is worse than no re-audit,
    // because it looks like coverage.
    keep(row.note ?? null);
    for (const ref of row.evidence_ref) keep(ref);
    for (const entry of row.coverage) keep(entry.channel);
  }
  for (const name of document.unaccounted) {
    if (hostNames.has(name)) continue;
    keep(name);
  }
  return out;
}

/**
 * Audit one piece of envelope text against all four classes.
 *
 * `previous` is the document the text was PROJECTED FROM, and passing it is what
 * makes the fourth class checkable at all: without it the function can only
 * assert that some prose is absent, which is not a claim about anything. Pass
 * `null` for text that had no previous sweep behind it.
 *
 * Every class is evaluated — the result is a list rather than a first-match —
 * because a hand-edited constant is usually wrong in one way and a pasted report
 * is usually wrong in several, and an operator fixing the first of four is an
 * operator who runs this three more times.
 */
export function envelopeIssues(
  text: string,
  previous: TriageDocument | null,
  declared: readonly string[] = [],
  declaredNamespaces: readonly string[] = [],
): readonly EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];

  for (const { re, what } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      issues.push({
        forbidden: "credential",
        evidence: what,
        reason:
          `the envelope carries ${what}, and §7.2 refuses a credential or any part of one. ` +
          `The value is deliberately not quoted back — this refusal reaches §7.7's log, which ` +
          `appends forever and is never truncated. A secret reaches a worker through the ` +
          `container's own environment, never through a brief.`,
      });
      break;
    }
  }

  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const path = match[1]!;
    const first = path.split("/")[1] ?? "";
    if (CONTAINER_MOUNTS.has(first)) continue;
    issues.push({
      forbidden: "host_path",
      evidence: path,
      reason:
        `${path} is an absolute path that is not one of this fleet's container mounts ` +
        `(${[...CONTAINER_MOUNTS].sort().join(", ")}), so it is a HOST path. §7.2 refuses one: a ` +
        `worker cannot reach it, and naming it tells a model the shape of a filesystem it has no ` +
        `business knowing.`,
    });
    break;
  }

  for (const { re, what } of COMMAND_PATTERNS) {
    if (re.test(text)) {
      issues.push({
        forbidden: "command",
        evidence: what,
        reason:
          `the envelope carries ${what}, and §7.2 refuses a raw command. What a worker may run ` +
          `is decided by its verb gate and its role (§6.10), never by the brief — a brief that ` +
          `carries a command is a brief that has started deciding.`,
      });
      break;
    }
  }

  if (previous !== null) {
    for (const prose of workerAuthoredStrings(previous, declared, declaredNamespaces)) {
      if (!text.includes(prose)) continue;
      issues.push({
        forbidden: "worker_prose",
        evidence: prose,
        reason:
          `the envelope carries a string the PREVIOUS sweep's worker wrote. §7.2: what crosses ` +
          `between passes is structured state, "never a previous worker's recommendations ` +
          `rendered as a brief". A brief that carries the last sweep's prose makes two sweeps ` +
          `incomparable, which is the one property this console exists to have.`,
      });
      break;
    }
  }

  return issues;
}

/**
 * One line naming every class an envelope violated, WITH the evidence, and the
 * evidence goes before the prose.
 *
 * **Measured 2026-09-09, and the cost was diagnosis rather than downtime.** The
 * `worker_prose` refusal that stopped three `cni-dev` sweeps logged its class and
 * its reason and dropped `evidence` — so §7.7's log said a string from the last
 * sweep had crossed, and never which string. The operator could see the console
 * had stopped and could not see why; the answer took importing this module and
 * running the guard by hand against the run tree.
 *
 * **The evidence leads because §7.7's line is truncated to
 * `ACTOR_LOG_REASON_MAX_BYTES` and every one of these reasons is a paragraph.**
 * Put the token after the prose and the one field an operator needs is the first
 * thing a cap removes.
 *
 * `credential` is the exception and it stays one: that class deliberately does
 * not quote the value back, and its `evidence` is already a description rather
 * than the secret — so it is printed like any other and nothing new reaches the
 * log.
 */
export function describeIssues(issues: readonly EnvelopeIssue[]): string {
  return issues.map((i) => `${i.forbidden} [${i.evidence}]: ${i.reason}`).join(" | ");
}

/** A refusal to emit an envelope, carrying every class it violated. */
export class SweepEnvelopeError extends Error {
  readonly issues: readonly EnvelopeIssue[];
  constructor(message: string, issues: readonly EnvelopeIssue[] = []) {
    super(message);
    this.name = "SweepEnvelopeError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// §7.2 — the projection, and the renderer
// ---------------------------------------------------------------------------

/**
 * One service's carried state — TWO FIELDS, and the shortness is the point.
 *
 * §7.2 carries *"the previous sweep's per-service state, as **structured state
 * only**"*. Both members are host-checkable: the name against the targets file,
 * the assessment against a closed enum. There is deliberately no `note`, no
 * `summary` and no `evidence` member, because a field that admits free text is
 * where the next person will put the last sweep's paragraph.
 */
export interface PreviousServiceState {
  readonly service: string;
  readonly assessment: ObserverAssessment;
}

const ASSESSMENTS: ReadonlySet<string> = new Set<string>(OBSERVER_ASSESSMENTS);

/**
 * Project the previous sweep's `triage.json` down to what may cross.
 *
 * **Filtered against `declared` rather than deduplicated or sanitised**, because
 * a service name is worker-authored too: `triage.json`'s rows are whatever `tri-1`
 * wrote, and a row naming a service the targets file never declared would put an
 * attacker-chosen token into the next brief under the host's own voice. The host
 * knows the legal names; nothing else has to be trusted.
 *
 * Order follows `declared` rather than the document, so two sweeps whose worker
 * happened to order its rows differently produce the same brief — the
 * comparability §6.6 is about, applied to the one input a worker controls.
 */
export function projectPreviousState(
  document: TriageDocument | null,
  declared: readonly string[],
): readonly PreviousServiceState[] {
  if (document === null) return [];
  const byName = new Map<string, ObserverAssessment>();
  for (const row of document.services) {
    if (!ASSESSMENTS.has(row.assessment)) continue;
    if (byName.has(row.service)) continue;
    byName.set(row.service, row.assessment);
  }
  const out: PreviousServiceState[] = [];
  for (const name of declared) {
    const assessment = byName.get(name);
    if (assessment !== undefined) out.push({ service: name, assessment });
  }
  return out;
}

/** What §7.2's renderer is handed. Every member is host-owned or host-checkable. */
export interface SweepEnvelopeInput {
  readonly sweepId: string;
  /** ISO-8601 UTC. The lower bound of this sweep's observation window. */
  readonly windowOpenedAt: string;
  readonly environment: string;
  /** The environment's services, in FILE order, with their own bounds. */
  readonly services: readonly TriageService[];
  /** §7.1's `default_window`, resolved to seconds. */
  readonly defaultWindowS: number;
  /**
   * The previous sweep's document, handed over WHOLE so this function can
   * project it and then prove nothing else crossed. Never rendered.
   */
  readonly previousDocument: TriageDocument | null;
  /** Defaults to {@link TRIAGE_VERDICT_RULE}. Audited like everything else. */
  readonly verdictRule?: string;
  /**
   * The seats this sweep will fan out to, and the ONE input added because the
   * collator cannot derive it — see the `## The seats` block in the rendered
   * brief. Defaults to {@link TRIAGE_CONSOLE_ASPECTS}; a parameter only so a test
   * can render a two-seat console without editing a host constant.
   */
  readonly seats?: readonly AspectSeat[];
}

/** A `dispatchrequest`-shaped pair. `roles/collator.md:81-91`'s two prose fields. */
export interface SweepEnvelope {
  readonly title: string;
  readonly brief: string;
}

/**
 * §7.2's `window_opened_at`, derived — **the LOWER bound of the observation
 * window, and NOT the instant the host dispatched at.**
 *
 * ## The two sentences that describe this field do not obviously agree, and the
 * ## table settles it
 *
 * §7.2:1818 calls it *"the lower bound of this sweep's observation window"*.
 * §7.4:1935 calls it *"the moment the observer's queries start looking back
 * from"*, which reads naturally as the opposite end — you look back FROM now.
 * §7.4's own refusal table decides it: a value *"earlier than `dispatched_at −
 * default_window − reserve_s`"* is refused because *"the observer looked further
 * back than configured"*, and that reason is only a sentence about the LOWER
 * bound. An echo carrying the dispatch instant would be in range on every sweep
 * no matter how far back the observer actually queried, which would make §7.4's
 * whole check — *"queried six hours against a five-minute configuration"* —
 * unable to catch the one thing it exists for.
 *
 * **The environment's `default_window` and not a per-service override**, because
 * one artifact carries one echo and §7.1 refuses an override wider than the
 * default (resolved 2026-09-06). The widest legal window is therefore the
 * default, so a bound computed from it admits every service's own window and
 * admits nothing else.
 *
 * Throws on an unparseable instant rather than returning one, on this console's
 * split: a document a container wrote gets a value, and a HOST argument that is
 * wrong for the life of the run gets a throw. `dispatchedAt` is the actor's own.
 */
export function windowOpenedAt(dispatchedAt: string, defaultWindowS: number): string {
  const at = Date.parse(dispatchedAt);
  if (!Number.isFinite(at)) {
    throw new SweepEnvelopeError(
      `the sweep's dispatch instant ${JSON.stringify(dispatchedAt)} is not an ISO-8601 instant, ` +
        `so §7.2's window_opened_at cannot be derived from it. This value is minted host-side, ` +
        `so it is a host fault rather than something a worker wrote.`,
    );
  }
  return new Date(at - defaultWindowS * 1000).toISOString();
}

/** One service's line, with its OWN window rather than the environment's. */
function serviceBlock(service: TriageService, defaultWindowS: number): string {
  const windowS = service.window ?? defaultWindowS;
  /*
   * **An undeclared workload is an instruction, not a blank.**
   *
   * `workload` is optional (§6.2 rule 2 declares the NAMESPACE; the workload may
   * be left to the observer), and what goes here is the only thing the observer
   * will ever see about it. The previous text said "resolved by selector", which
   * named a mechanism this schema does not have — there is no `selector` field —
   * so an observer reading it was told something else would do the resolving and
   * nothing did.
   *
   * It says instead what the observer must DO, because the alternative failure is
   * the expensive one: a service whose workload nobody identified comes back
   * `indeterminate`, three sweeps of that is a coverage incident, and the operator
   * is sent to a cluster over a field that was simply left empty on purpose.
   *
   * **THE SEARCH IS BOUNDED, and it is bounded because an unbounded one was
   * measured (ISC-1121).** "Identify it yourself" is an open-ended sub-goal, and
   * this is the only field in the envelope that sets one. On `T-sweep-15-slice1`
   * (2026-09-09) `obs-t1` ran `kubectl get pods -n aodapnc-alerts-notifier-dev |
   * grep alert-processor` **113 times in seven minutes** — and the command
   * SUCCEEDED every time, returning two `alert-processor` pods `1/1 Running`. It
   * was not retrying a failure; it had the answer on the first call and could not
   * stop asking. The epoch ended `timed_out / deadline_exceeded_no_terminal_event`
   * with no artifact, and the service went unobserved.
   *
   * So the bound is on the SEARCH rather than on the answer: three commands, and
   * an explicit "if you have the answer, you are done looking", because the
   * observed failure was re-asking a question already answered rather than asking
   * too many different ones. The deadline caught it — ISC-1118's 480 s did
   * exactly its job — but a deadline is a floor for the whole pass, not a bound on
   * one field, and paying 480 s to end a loop that produced nothing costs the
   * sweep every other service in the slice.
   *
   * **Why it had never fired before:** the collator had been SUMMARISING this
   * field ("workload NOT DECLARED") rather than copying it, which
   * `roles/triage.md:196` forbids and which happened to withhold the open-ended
   * instruction. Sweeps 13 and 14 carried the summary; sweep 15 — the first on the
   * envelope that demands literal copying (ISC-1119/1120) — carried it verbatim,
   * and the hazard arrived with the compliance. A prompt that starts being obeyed
   * is a prompt whose contents start mattering.
   */
  const workload =
    service.workload ??
    "NOT DECLARED — identify the workload behind this service yourself, from the " +
      "namespace and the service name, and NAME what you identified in your report. " +
      "If you cannot identify exactly one, say so and report indeterminate rather " +
      "than guessing. Identify it in AT MOST THREE commands, and never re-run a " +
      "command that already returned output — if you have the answer, you are done " +
      "looking; if three did not settle it, that IS the indeterminate case.";
  return [
    `- service: ${service.name}`,
    `  namespace: ${service.namespace}`,
    `  workload: ${workload}`,
    `  checks: ${service.checks.join(", ")}`,
    `  window: ${windowS}s`,
  ].join("\n");
}

/**
 * §7.2's envelope, rendered into prose because `inputs[]` reaches no prompt.
 *
 * SRD-OBSERVER-001 §7.1, quoted by §7.2: everything the worker needs is in the
 * `brief` or it does not exist for the worker. `roles/triage.md:59-63` reads the
 * same list back from the other side — the environment, the service list with
 * each service's bounds, the sweep id, the window instant, the verdict rule, and
 * the previous sweep's per-service state as structured fields.
 *
 * **Throws rather than returning a bad envelope**, and the throw is on this
 * function's OWN output. That is the difference between a contract and a
 * comment: a later edit that adds a field carrying prose reddens here, in this
 * module's own test, rather than in whatever consumes the brief three layers
 * away — or, far more likely, nowhere.
 */
export function renderSweepEnvelope(input: SweepEnvelopeInput): SweepEnvelope {
  const declared = input.services.map((s) => s.name);
  const carried = projectPreviousState(input.previousDocument, declared);
  const rule = input.verdictRule ?? TRIAGE_VERDICT_RULE;
  const seats = input.seats ?? TRIAGE_CONSOLE_ASPECTS;

  const title = `${input.environment}: health sweep ${input.sweepId}`;

  const previousLines =
    carried.length === 0
      ? [
          "There is no previous state for this environment. Treat every service as unseen; do",
          "not infer one from anything above this line in your context.",
        ]
      : [
          "One line per service, and these two fields are the WHOLE of what crossed from the",
          "last sweep. No finding, no recommendation and no sentence from the last report is",
          "here, deliberately — it is context for what to look at, never a finding to confirm.",
          "",
          ...carried.map((p) => `- ${p.service}: ${p.assessment}`),
        ];

  const brief = [
    `You are running health sweep ${input.sweepId} of the ${input.environment} environment.`,
    "",
    "## This sweep",
    "",
    `- sweep id: ${input.sweepId}`,
    `- environment: ${input.environment}`,
    `- observation window opens at: ${input.windowOpenedAt}`,
    "",
    `Copy the sweep id and the window instant from this brief into every artifact this sweep`,
    `produces, and into every brief you write. Copy them from here and from nowhere else — not`,
    `from your transcript and not from a previous artifact. The host compares what it minted`,
    `against what comes back, and an artifact echoing the previous sweep's id is discarded.`,
    "",
    `**The two field names are \`sweep_id\` and \`window_opened_at\`, spelled exactly that way.**`,
    `Your own \`${TRIAGE_DOCUMENT_FILE}\` carries \`sweep_id\`, copied from the row above.`,
    "",
    `**You do not have to tell your observers to echo those two fields, and you should not spend`,
    `your brief trying.** The host appends the observer's reporting contract to every brief you`,
    `send — those two spellings, the closed domain \`coverage[].result\` draws from, and the bound`,
    `every cluster call must carry. It is appended after your words, under its own heading, on`,
    `every dispatch and whatever you wrote.`,
    "",
    `The window INSTANT is the one part of that contract the host cannot supply: it holds the`,
    `sweep id and the seat ids, and it reads the instant back out of the brief you wrote. So the`,
    `copy demanded above is not optional — a brief that drops the instant produces an observer`,
    `told to echo a window nobody named.`,
    "",
    "## What every row must carry, or its `healthy` is not believed",
    "",
    `Every brief you write must tell its observer that each row of \`observer-ops.json\` carries`,
    `\`coverage\` (a list of \`{channel, result}\`), \`selector\` (the one it actually matched on),`,
    `\`window\`, and \`evidence_ref\` (a list naming what it read). Name all four, spelled exactly`,
    `that way. You do not need to state the domain \`result\` draws from; the host appends it.`,
    "",
    `These are GATES, not decoration. The host downgrades a \`healthy\` whose \`coverage\` is`,
    `empty — or whose every channel is \`not_attempted\` — or which names no selector, no window,`,
    `or no evidence, to \`indeterminate\`. Three of those on one service opens an incident and`,
    `sends a person to a cluster. An observer that was never asked for these fields writes a`,
    `report that cannot be believed, however carefully it looked.`,
    "",
    "## The seats, and the task id each one's slice is dispatched under",
    "",
    `You do not choose these ids and you cannot derive them — they are minted here, and this is`,
    `the only place you will see them. When you write a request for a worker below, name that`,
    `worker's outbox path in its brief, exactly as spelled here:`,
    "",
    ...seats.map(
      (s) => `- ${s.worker}: task id \`${childTaskId(input.sweepId, s.aspect)}\`, ` +
        `reporting path \`/outbox/${childTaskId(input.sweepId, s.aspect)}/files/\``,
    ),
    "",
    `Never your own task id. An artifact written under \`${input.sweepId}\` is read by nothing:`,
    `the host looks only under the id the slice was dispatched with, so a report filed at your`,
    `id is indistinguishable from a seat that reported nothing at all.`,
    "",
    "## The services, and the bounds each one was given",
    "",
    `Every service below appears in exactly one of your requests. The checks and the window are`,
    `this service's own: copy them, do not widen them, and do not tidy them.`,
    "",
    ...input.services.map((s) => serviceBlock(s, input.defaultWindowS)),
    "",
    "## The verdict rule, verbatim",
    "",
    rule,
    "",
    `Apply that rule and do not invent a finer one. Carry it into every brief you write, word`,
    `for word — a rule rewritten between sweeps makes two sweeps incomparable, and consecutive`,
    `sweeps being comparable is the whole product.`,
    "",
    "## The previous sweep's per-service state",
    "",
    ...previousLines,
    "",
    "## What your briefs must never carry",
    "",
    `A credential or any part of one; an absolute host path; a raw command; and the contents of`,
    `a previous sweep's report as instruction. What crosses between sweeps is the structured`,
    `state above — fields, not paragraphs.`,
  ].join("\n");

  /*
   * The declared names are passed to the audit so a previous document that merely
   * ECHOED them — `unaccounted[]` is exactly that — is not mistaken for prose
   * crossing between sweeps. The host wrote these names into this very brief.
   */
  const declaredNames = input.services.map((s) => s.name);
  /*
   * The namespaces travel with the names because the host writes both into every
   * brief, and a `selector` that degraded to either is a token the host handed
   * over rather than prose the worker wrote — see `workerAuthoredStrings`, and
   * the three sweeps 2026-09-09 spent refusing on `alert-notifier`.
   */
  const declaredNamespaces = input.services.map((s) => s.namespace);
  const issues = [
    ...envelopeIssues(title, input.previousDocument, declaredNames, declaredNamespaces),
    ...envelopeIssues(brief, input.previousDocument, declaredNames, declaredNamespaces),
  ];
  if (issues.length > 0) {
    throw new SweepEnvelopeError(
      `the rendered sweep envelope for ${input.sweepId} violates §7.2: ${describeIssues(issues)}`,
      issues,
    );
  }
  return { title, brief };
}

/**
 * Turn two's brief — §6.3 step 8, `roles/triage.md:231-236`.
 *
 * **It names the reply files and says not to look for others**, which is the
 * instruction that makes an observer that produced nothing legible: *"that
 * directory holds exactly what the brief lists, and an observer whose file is not
 * named produced none."* Audited by the same function for the same four classes;
 * a collation brief is an envelope.
 */
export function renderCollationEnvelope(input: {
  readonly sweepId: string;
  readonly environment: string;
  readonly childTaskIds: readonly string[];
}): SweepEnvelope {
  const title = `${input.environment}: reconcile ${input.sweepId}`;
  const brief = [
    `Reconcile the observer reports for sweep ${input.sweepId} of ${input.environment}.`,
    "",
    "## The reports, and they are the only ones",
    "",
    ...input.childTaskIds.map((id) => `- ${replyMountPath(id)}`),
    "",
    `Read those files and no others. A slice whose file is not listed produced no report, and`,
    `saying so is the correct outcome for it — name it in \`unaccounted\` rather than inferring`,
    `a verdict for the services it held.`,
    "",
    "## What to write",
    "",
    `Write \`${TRIAGE_DOCUMENT_FILE}\` and \`triage.md\` into the \`${SWEEP_FILES_DIR}\` directory of your own`,
    `outbox task, and declare both in the envelope's \`artifacts\` array. One row per service,`,
    `never one verdict over a batch. Echo the sweep id ${input.sweepId} in the document.`,
    "",
    `Carry each observer's own \`assessment\` word through unchanged. Do not upgrade a row whose`,
    `coverage is empty, and do not decide whether anything should be notified — that decision`,
    `belongs to the host, which can see across sweeps and you cannot.`,
    "",
    `Every row of \`${TRIAGE_DOCUMENT_FILE}\` carries \`service\`, \`assessment\`, \`coverage\`,`,
    `\`selector\`, \`window\` and \`evidence_ref\`, copied from the observer's row and NOT`,
    `reconstructed. Copy \`coverage\` as the list of \`{channel, result}\` objects it already is.`,
    `A row you write without them is a row the host cannot believe: it downgrades an`,
    `unevidenced \`healthy\` to \`indeterminate\`, and three of those opens an incident. If an`,
    `observer gave you no evidence for a service, carry the empty value through rather than`,
    `inventing one — that is a true report about a report, and it is what \`unaccounted\` and the`,
    `downgrade are both for.`,
  ].join("\n");

  const issues = envelopeIssues(`${title}\n${brief}`, null);
  if (issues.length > 0) {
    throw new SweepEnvelopeError(
      `the rendered collation envelope for ${input.sweepId} violates §7.2: ` +
        describeIssues(issues),
      issues,
    );
  }
  return { title, brief };
}

// ---------------------------------------------------------------------------
// §7.4 — `observer-ops.json` → `ObserverArtifact`, and §9.3's `blocked`
// ---------------------------------------------------------------------------

/** SRD-OBSERVER-001 §9.3's domain for `status`. Closed, and asserted by name. */
export const OBSERVER_STATUSES = ["success", "partial", "blocked", "failed"] as const;
export type ObserverStatus = (typeof OBSERVER_STATUSES)[number];

/** One observer's artifact plus the field §6.7's table reads separately. */
export interface ObserverReply {
  readonly artifact: ObserverArtifact;
  /**
   * §9.1's *"did the observation succeed"*. `null` when the artifact named no
   * value in §9.3's domain — recorded as unknown rather than coerced, because
   * `blocked` is the only value that becomes an issue and guessing at it in
   * either direction is wrong.
   */
  readonly status: ObserverStatus | null;
}

export type ObserverArtifactRead =
  | { readonly kind: "ok"; readonly reply: ObserverReply }
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

const STATUSES: ReadonlySet<string> = new Set<string>(OBSERVER_STATUSES);

/** A field that must be a non-empty string to be an echo, and is `null` otherwise. */
function echo(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read one `observer-ops.json` into the two values the host's own gates spend.
 *
 * ## AN OMITTED ECHO IS `null`, AND IS NOT A REFUSAL
 *
 * This is the whole reason the reader is this lenient. §7.4 makes `sweep_id` and
 * `window_opened_at` REQUIRED and gives each a host-side gate — `sweepIdEcho`
 * answers `stale_replay`, `windowEcho` answers `stale_window` — and
 * `ObserverArtifact` models both as `string | null` precisely so *"an artifact
 * that omitted it is a contract violation the host must be able to RECORD"*. A
 * reader that refused the file instead would delete the fault before the gate
 * built to record it ever saw it, and the two failures would arrive at
 * `assessTriageSweep` wearing one costume.
 *
 * What IS refused is a file that is not a JSON object at all: that is not an
 * artifact with a missing field, it is a turn that produced something other than
 * the document it was asked for, and `parseTriageDocument`'s own three-way split
 * is followed here for the same reason it exists there.
 *
 * `worker` comes from the CONTEXT — the outbox directory the file sat in — never
 * from the document, on `TriageDocumentContext.worker`'s rule: *"a document that
 * could name its own author could attribute a sweep to a seat that never ran
 * one."*
 */
export function parseObserverArtifact(
  text: string,
  ctx: { readonly worker: string; readonly path: string },
): ObserverArtifactRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { kind: "refused", path: ctx.path, reason: `${ctx.path} is not JSON: ${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "refused",
      path: ctx.path,
      reason:
        `${ctx.path} is not a JSON object, so it carries no §7.4 fields at all. An artifact ` +
        `missing an echo is a contract violation the host records; a file that is not an ` +
        `object is a turn that produced something else.`,
    };
  }
  const record = raw as Record<string, unknown>;
  const status = record["status"];
  return {
    kind: "ok",
    reply: {
      artifact: {
        worker: ctx.worker,
        sweep_id: echo(record, "sweep_id"),
        window_opened_at: echo(record, "window_opened_at"),
      },
      status: typeof status === "string" && STATUSES.has(status) ? (status as ObserverStatus) : null,
    },
  };
}

/** How this module reads bytes. Injected so a fixture needs no temp directory. */
export type SweepFileRead = (path: string) => Promise<string | null>;

const DEFAULT_READ: SweepFileRead = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
};

/** {@link parseObserverArtifact} over a path, with the absence arm a path has. */
export async function readObserverArtifactAt(
  path: string,
  ctx: { readonly worker: string; readonly path: string },
  read: SweepFileRead = DEFAULT_READ,
): Promise<ObserverArtifactRead> {
  const text = await read(path);
  if (text === null) return { kind: "absent", path };
  return parseObserverArtifact(text, ctx);
}

/**
 * SRD-OBSERVER-001 §9.3's extractor — the seats whose observation was prevented
 * by something outside the worker.
 *
 * **`failed` is deliberately not here.** §9.3: *"A tunnel-down control plane is
 * `blocked`, not `failed`. Nothing the worker did caused it and no retry inside
 * the container fixes it."* §6.8a gives `blocked` a console-health `kind` of its
 * own for exactly that reason, and folding `failed` in would send an operator to
 * debug a task when the answer is a network.
 */
export function blockedObservers(
  replies: readonly { readonly artifact: ObserverArtifact; readonly status: ObserverStatus | null }[],
): readonly string[] {
  return replies.filter((r) => r.status === "blocked").map((r) => r.artifact.worker);
}

// ---------------------------------------------------------------------------
// §7.5 — the path-reading wrapper `parseTriageDocument` deliberately lacks
// ---------------------------------------------------------------------------

/**
 * {@link TriageDocumentRead} plus the one arm §7.5 refused to give it.
 *
 * `parseTriageDocument` takes TEXT and has *"no `missing` arm"*, on the recorded
 * ground that *"an absent `triage.json` is not this module's to interpret: §6.5
 * counts coverage from the run tree, so a sweep that produced no document is a
 * zero-row sweep the ACTOR names, not a parse result."* The actor still has to
 * tell an absent file from a malformed one, so the distinction is drawn HERE, by
 * the only function that can see it, and the parser keeps its two-arm shape.
 */
export type TriageDocumentFileRead =
  | TriageDocumentRead
  | { readonly kind: "absent"; readonly path: string };

export async function readTriageDocumentAt(
  path: string,
  ctx: TriageDocumentContext,
  read: SweepFileRead = DEFAULT_READ,
): Promise<TriageDocumentFileRead> {
  const text = await read(path);
  if (text === null) return { kind: "absent", path };
  return parseTriageDocument(text, ctx);
}

// ---------------------------------------------------------------------------
// The four `SweepDriver` members
// ---------------------------------------------------------------------------

/** What the injected dispatch can say. §6.10 exit 5 is a value, never a throw. */
export type SweepDispatchOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "budget_exhausted"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The one effect this module does not own — see the header.
 *
 * **Returns when the task has SETTLED**, not when it was accepted, because
 * `collate` reads the document the task it dispatched writes and §6.3 gives
 * `SweepDriver` no member between the two steps.
 */
export type SweepDispatch = (args: {
  readonly taskId: string;
  readonly worker: string;
  readonly title: string;
  readonly brief: string;
}) => Promise<SweepDispatchOutcome>;

export interface SweepProducerDeps {
  readonly run: RunPaths;
  readonly environment: string;
  readonly services: readonly TriageService[];
  readonly defaultWindowS: number;
  /** The previous sweep's document, fetched lazily. Projected, never rendered. */
  readonly previousDocument: () => Promise<TriageDocument | null>;
  readonly dispatch: SweepDispatch;
  /**
   * Where a given SEAT's run tree lives. Defaults to {@link run}.
   *
   * **`run` is the COLLATOR's, and only the collator's.** D4: a console is four
   * runs, not one — so `<run>/outbox/obs-t1/` does not exist and never did. The
   * join read observer artifacts out of the collator's tree, which is a directory
   * that cannot contain them, so the harvest found nothing no matter what the
   * observers wrote. Every service came back unobserved and escalated to
   * coverage, and the console pointed at a cluster that had answered.
   *
   * This is the SECOND place that mistake was made — `dispatchObserver` posted to
   * the collator's run too, and failed loudly with `SocketRequestError`. The join
   * had no such luck: reading a path that does not exist is indistinguishable
   * from a worker that wrote nothing, so it failed silently for as long as it
   * existed.
   */
  readonly seatRun?: (worker: string) => Promise<RunPaths>;
  /**
   * Put a child's artifact where the COLLATOR can read it — §6.3 step 7, and it
   * was missing entirely.
   *
   * `renderCollationEnvelope` names `/replies/<child>.json` for every seat, and
   * nothing wrote those files. Each worker has its OWN `/outbox`: the observer
   * writes into its run, the collator reads its own, and the two never meet. So
   * the collator was handed a brief listing paths that had never existed, and
   * said so — *"there is no directory for T-sweep-1-slice1 … the /replies
   * directory is empty"* — after the observer had done the work correctly and
   * written both artifacts.
   *
   * The review console has always done this (`relay.ts` publishes each child's
   * reply before dispatching its collation); this console named the mechanism and
   * skipped it. A PORT rather than a direct write, because publishing into
   * another worker's `:ro` mount is a privileged effect and §12 keeps those at the
   * composition root — the same reason `dispatch` is injected.
   *
   * ## Why it takes the WHOLE SET and the collation's id
   *
   * SRD-WORKER-DISPATCH-EXTENSION §7.4: publishing a reply and DECLARING it at
   * `/policy/replies` are ONE act, because `get_replies` cannot `readdir` —
   * `<run>/replies/<worker>/` accumulates across sweeps, so sweep 5's collator
   * listing it would see sweeps 1 through 5 and collate a mixture of five
   * questions, each of which reads like a good answer (Finding E).
   *
   * A per-child port could not express that. The declaration is one document
   * naming one task's whole set, so a port called once per seat would have to
   * either rewrite the file five times with a growing set — a set that is wrong
   * at every intermediate step — or leave the declaration to a second port the
   * join has to remember, which is failure mode 9.6 with a seam through it. So
   * the port is called ONCE per join, carrying the set and the id of the task
   * that will read it, and the composition root behind it (`cli/index.ts`'s
   * `publishRepliesFor` → `relay.ts`'s `productionRelayEffects.publishReplies`)
   * does both halves from that one value.
   *
   * `taskId` is the COLLATION's — `collationTaskId(sweepId)` — because the
   * tool's staleness check compares the declaration against the collator's own
   * `/policy/task`, and the task that reads this set is the collation.
   *
   * The element type is `DeclaredReply` plus the payload rather than a name
   * imported from `relay.ts`, which §12 bans this subtree from importing. The
   * bridge is structural, at the composition root, and
   * `test/unit/triage-envelope.test.ts` pins the two shapes against each other
   * so they cannot drift — the same treatment {@link SWEEP_FILES_DIR} gets for
   * the same reason.
   *
   * Optional so a caller that builds its own fixture need not supply one; the
   * production wiring is not optional and lives in `buildTriageSweepDriver`.
   */
  readonly publishReplies?: (
    taskId: string,
    replies: readonly (DeclaredReply & { readonly reply: unknown })[],
  ) => Promise<void>;
  readonly read?: SweepFileRead;
}

/** The four members `SweepDriver` had no producer for. */
export interface SweepProducers {
  readonly openSweep: (sweepId: string, dispatchedAt: string) => Promise<SweepOpen>;
  readonly dispatchObserver: (sweepId: string, assignment: PartitionAssignment) => Promise<void>;
  readonly join: (sweepId: string) => Promise<SweepJoin>;
  readonly collate: (sweepId: string) => Promise<SweepCollation>;
}

/**
 * Assemble the four, over one injected dispatch.
 *
 * A factory rather than four exported functions each taking the same six
 * arguments: the deps are one set, and four call sites that each rebuild them is
 * four chances for two of them to disagree about which run they are serving —
 * the failure §6.4 refuses two processes for, at a smaller scale.
 */
export function sweepProducers(deps: SweepProducerDeps): SweepProducers {
  const read = deps.read ?? DEFAULT_READ;
  /** The collator's run, for callers that have no per-seat map. */
  const seatRun = deps.seatRun ?? (async (): Promise<RunPaths> => deps.run);

  const openSweep = async (sweepId: string, dispatchedAt: string): Promise<SweepOpen> => {
    const envelope = renderSweepEnvelope({
      sweepId,
      windowOpenedAt: windowOpenedAt(dispatchedAt, deps.defaultWindowS),
      environment: deps.environment,
      services: deps.services,
      defaultWindowS: deps.defaultWindowS,
      previousDocument: await deps.previousDocument(),
    });
    const outcome = await deps.dispatch({
      taskId: sweepId,
      worker: TRIAGE_COLLATOR,
      title: envelope.title,
      brief: envelope.brief,
    });
    if (outcome.kind === "budget_exhausted") {
      return { kind: "budget_exhausted", reason: outcome.reason };
    }
    if (outcome.kind === "refused") {
      throw new SweepEnvelopeError(
        `the request plane refused sweep ${sweepId}: ${outcome.reason}. This is a HOST fault — ` +
          `the envelope was composed here and the roster is a constant — so it is a thrown pass ` +
          `rather than a §6.10 exit, which is a configured limit doing its job.`,
      );
    }
    return { kind: "opened" };
  };

  /**
   * §6.3 step 5. The brief is the COLLATOR's, read back out of the fan-out
   * request it wrote, which is the one place §7.3 sanctions a worker's string
   * becoming a dispatch — the same path the review console's fan-out takes.
   *
   * A slice with no request is a HOST invariant violation rather than a worker
   * fault: `dispatchPartition` only reaches here after `checkTriagePartition`
   * accepted a partition projected from that very file, so the file was there a
   * moment ago. It throws, and the loop's catch reports a fault.
   */
  const dispatchObserver = async (
    sweepId: string,
    assignment: PartitionAssignment,
  ): Promise<void> => {
    const seat = TRIAGE_CONSOLE_ASPECTS.find((s) => s.worker === assignment.worker);
    if (seat === undefined) {
      throw new SweepEnvelopeError(
        `${assignment.worker} is not a seat of the triage console (${TRIAGE_CONSOLE_ASPECTS.map(
          (s) => s.worker,
        ).join(", ")}), so no child task id can be derived for it.`,
      );
    }
    const request = await readDispatchRequest({
      runRoot: deps.run.root,
      sender: TRIAGE_COLLATOR,
      taskId: sweepId,
      roster: TRIAGE_CONSOLE_ROSTER,
    });
    const item =
      request.kind === "ok"
        ? request.request.requests.find((r) => r.worker === assignment.worker)
        : undefined;
    if (item === undefined) {
      throw new SweepEnvelopeError(
        `the fan-out request for ${sweepId} holds no entry for ${assignment.worker}, but the ` +
          `partition this dispatch came from was projected from it. The file changed under the ` +
          `sweep, and dispatching a brief this host did not read is the one thing worse than ` +
          `refusing.`,
      );
    }
    const childId = childTaskId(sweepId, seat.aspect);
    /*
     * §6.3 step 5, as ISC-1136 divides it: `item.brief` is the collator's
     * per-sweep JUDGEMENT and nothing more, and the host composes the invariant
     * half around it. This replaced four sequential repairs on one document —
     * see `composeObserverBrief` for why three of them became authored text and
     * why the reporting-path one could not.
     */
    const composed = composeObserverBrief({
      judgement: item.brief,
      sweepId,
      childTaskId: childId,
    });
    /*
     * The ONE warning left, and it survives because its repair does. The other
     * three announced that the collator had omitted a sentence the host was
     * about to write regardless, on every sweep — an operator line that carried
     * no decision. A wrong outbox id still does: it means the collator asserted
     * a path, and something the host cannot see told it that path.
     */
    if (composed.rewrote.length > 0) {
      console.warn(
        `triage: ${assignment.worker}'s brief for ${sweepId} named outbox ` +
          `${composed.rewrote.map((id) => `/outbox/${id}/files/`).join(", ")}; rewritten to ` +
          `/outbox/${childId}/files/, the id it is dispatched under and the only one ` +
          `observerArtifactPath reads. The sweep envelope names this exact path in its ` +
          `"## The seats" block, so the collator had it and did not copy it ` +
          `(roles/triage.md:212). Before ISC-1120 the id was never handed over at all, and ` +
          `this line blamed the collator for not knowing it.`,
      );
    }
    /*
     * §7.4's instant is the one field of the contract the host cannot mint — see
     * `readWindowInstant`. A judgement that named none produces a weaker demand,
     * so it is worth an operator's attention rather than silent degradation.
     */
    if (composed.window === null) {
      console.warn(
        `triage: ${assignment.worker}'s brief for ${sweepId} names no observation-window ` +
          `instant, so the host cannot quote one in the freshness demand — it holds the sweep ` +
          `id and the seat ids, and reads the instant back out of the collator's own text ` +
          `(readWindowInstant). renderSweepEnvelope states the instant and requires it copied ` +
          `into every brief; windowEcho will compare whatever the observer writes against a ` +
          `value this dispatch could not name.`,
      );
    }
    const outcome = await deps.dispatch({
      taskId: childId,
      worker: assignment.worker,
      title: item.title,
      brief: composed.brief,
    });
    if (outcome.kind !== "accepted") {
      throw new SweepEnvelopeError(
        `dispatching ${assignment.worker}'s slice of ${sweepId} was ${outcome.kind}: ${outcome.reason}`,
      );
    }
  };

  /**
   * §6.3 steps 6-7. Reads the run tree, never the worker's account of it.
   *
   * A seat with no readable artifact is ABSENT from `artifacts[]` rather than
   * present with nulls — `ObserverArtifact`'s own docblock: *"there is no
   * `present: boolean`, because an absent artifact is an absent element and a
   * boolean would let a caller record an artifact that is not there."* A file
   * that exists and is not an object is treated the same way and for the same
   * reason: §6.7 counts what came back, and something that is not a reply did not
   * come back.
   */
  const joinSweep = async (sweepId: string): Promise<SweepJoin> => {
    const replies: ObserverReply[] = [];
    const claimedSuccess: string[] = [];
    /**
     * What the collator will be handed — accumulated across the seat loop and
     * published in ONE act after it (§7.4).
     *
     * Held rather than published per seat because the DECLARATION is one
     * document about one task's whole set: a port called inside the loop would
     * declare a set that is wrong at every step but the last, and a collator
     * that read `/policy/replies` mid-join would see a truthful-looking subset.
     */
    const publishable: (DeclaredReply & { reply: unknown })[] = [];
    for (const seat of TRIAGE_CONSOLE_ASPECTS) {
      const taskId = childTaskId(sweepId, seat.aspect);
      const seatTree = await seatRun(seat.worker);
      const path = observerArtifactPath(seatTree, seat.worker, taskId);
      const found = await readObserverArtifactAt(path, { worker: seat.worker, path }, read);
      if (found.kind === "ok") {
        replies.push(found.reply);
        /*
         * §6.3 step 7: hand it to the collator. The collation brief will name
         * `/replies/<taskId>.json`, so this is what makes that path exist.
         *
         * **The WHOLE artifact, never `reply.artifact`.** {@link ObserverArtifact}
         * is deliberately narrow — §7.4's freshness echo and nothing else, three
         * fields the host gates on. Publishing that is publishing the envelope and
         * dropping the report: measured 2026-09-07, the collator received a
         * 73-byte file reading `{worker, sweep_id: null, window_opened_at: null}`,
         * found no services in it, and correctly recorded all three as
         * `unaccounted` — a right answer to the wrong document.
         *
         * So the file is re-read and forwarded verbatim. A second read of a small
         * local file is the cheap half of this; the expensive half was a collation
         * that looked like a worker failure and was a host one.
         */
        const rawArtifact = await read(path);
        if (rawArtifact !== null) {
          /*
           * The PARSE is what this guard is about, and it is now only that.
           * Unparseable here is impossible in practice — `readObserverArtifactAt`
           * just parsed it — but a throw inside the loop would cost the whole
           * sweep, and the artifact is already counted.
           *
           * **The publish itself used to be inside this `try` and is now
           * outside it, deliberately.** A swallowed publish is a collation brief
           * naming `/replies/<child>.json` files that do not exist AND a stale
           * `/policy/replies` — failure mode 9.6 exactly, with no symptom on
           * this side. That is the one failure worth losing a sweep over, and
           * the review console already answers it the same way: `fanOut` does
           * not catch `publishReplies`, the pass journals nothing, and the next
           * sweep re-reads the same artifacts and publishes them again.
           */
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawArtifact);
          } catch {
            continue;
          }
          publishable.push({
            task_id: taskId,
            worker: seat.worker,
            aspect: seat.aspect,
            reply: parsed,
          });
        }
        continue;
      }
      /*
       * NOTHING CAME BACK. Ask what the worker CLAIMED, because the two answers
       * point an operator at different places — see {@link SweepJoin.claimedSuccess}.
       * Read through the same injected `read` the artifacts use, so this stays a
       * pure file read and the module keeps its one I/O seam.
       */
      const record = await read(taskRecordPath(workerPaths(seatTree, seat.worker), taskId));
      if (record === null) continue;
      let verdict: unknown;
      try {
        verdict = (JSON.parse(record) as { verdict?: unknown }).verdict;
      } catch {
        // A task record that will not parse is its own fault and not this one's.
        continue;
      }
      if (verdict !== "success") continue;
      claimedSuccess.push(seat.worker);
      /*
       * SRD-WORKER-DISPATCH-EXTENSION §13 task 3.4. The sentence used to stop at
       * *"look at the transcript"*, which is a whole transcript and an
       * operator's afternoon. §6.3's layer 4 puts two typed entries in the
       * session JSONL that answer the next question directly — §7.1's entry
       * means the tool RAN and its bytes did not land, §7.2's means it was never
       * called — and those are different faults with different fixes, which is
       * the distinction `triage-pass.ts` already draws between `coverage` and
       * `claimedSuccess`.
       *
       * **NAMED, NEVER READ.** §6.5 property 3 permits both entries in an actor
       * log, in `pifleet monitor` and in exactly this message, and forbids them
       * in a verdict, a coverage count, an incident transition or a
       * notification. Nothing on this line is read back: `claimedSuccess` still
       * holds worker ids and `artifacts[]` is still the files this host could
       * open. **The closing clause tells the OPERATOR that too**, because the
       * drift §6.5 is built against — reading the entry instead of re-reading
       * the outbox, which is cheaper and therefore attractive — would make that
       * sentence false in the one place somebody would notice it.
       *
       * Two smaller choices, each of which could be made the other way:
       *
       *  - **`seatTree`, not `deps.run`.** A seat can live in another run
       *    (`seatRun`), and the collator's sessions directory would send an
       *    operator to a tree the worker never wrote in.
       *  - **`no_submit` is stated as NOTHING-DELIVERED, not as never-called.**
       *    CORRECTED 2026-09-08 by the engineer building task 3.3, against this
       *    message: the extension writes that entry whenever the epoch was not
       *    DELIVERED, which also covers a `submit_report` that was called and
       *    REFUSED — a bad filename, an artifact path escaping the outbox. The
       *    original wording sent an operator looking for a model that ignored
       *    its instructions, when the transcript may show one that tried twice
       *    and was turned down. The distinction is the whole reason the entry
       *    exists, so overstating it here would have cost more than saying
       *    nothing.
       *  - **BOTH entries can appear for one epoch, and that is the good case.**
       *    AMENDED 2026-09-08 by the engineer building Phase 4, against this
       *    message a second time. Layer 3's nag makes a worker that produced
       *    nothing produce something: the epoch leaves a `no_submit`
       *    (`nagged: true`) and then a `submit`. Presented as mutually
       *    exclusive, that pair reads as a contradiction and an operator has no
       *    reading for it — so the order is stated instead. **Twice now the
       *    correction has been that this sentence claimed more than the
       *    extension does**, which is what naming another module's artifact
       *    costs: the wording is not checkable from here.
       *  - **The directory is named and the FILENAME is not.** Pi's
       *    `_<worker>.jsonl` convention is `sessionFileSuffix` over in
       *    `supervisor/tui.ts`, a subtree this module may not import
       *    (`test/unit/triage-readonly.test.ts`). A second spelling of a
       *    convention is how a recogniser and its minter drift apart, so the
       *    message points at the directory it already holds and lets the
       *    operator glob.
       */
      console.error(
        `triage: ${seat.worker} settled ${taskId} SUCCESS and wrote no artifact. The sweep will ` +
          `report this service unobserved, which is correct but reads as "the environment did ` +
          `not answer" — the truth is that the worker said it was done and produced nothing. ` +
          `Look at the worker's transcript, not the cluster: its session JSONL is in ` +
          `${seatTree.sessionsDir}. A pifleet.submit/v1 entry there means the worker DID call ` +
          `submit_report and the write did not land; pifleet.no_submit/v1 means nothing was ` +
          `delivered for that epoch — the tool was never called, or it was called and REFUSED. ` +
          `Read an epoch's entries IN ORDER: a submit after a no_submit means the nag worked and ` +
          `the report landed late, so both appearing is a success, not a contradiction. ` +
          `Neither entry is read by this sweep — the coverage number is still ` +
          `this host's own count of the files it could open.`,
      );
    }
    /*
     * §6.3 step 7, and SRD-WORKER-DISPATCH-EXTENSION §7.4's one act.
     *
     * **UNCONDITIONAL, including when `publishable` is empty**, and that is the
     * whole reason the declaration exists as a file rather than as a directory
     * listing. An empty array says *"nothing was declared for this collation"*;
     * a `/replies` directory that happens to hold nothing NEW says nothing at
     * all, because it still holds every previous sweep's files. Skipping the
     * call on an empty join would leave the previous sweep's declaration
     * standing — which `get_replies` refuses as stale only because it carries
     * the previous collation's `task_id`, and "refused as stale" is a worse
     * answer than "declared empty" for a sweep that honestly observed nothing.
     *
     * BEFORE the return and AFTER the loop: every seat has been read, so the set
     * is final, and `collate` has not run yet, so every path the collation brief
     * is about to name exists before it is named (D6).
     */
    await deps.publishReplies?.(collationTaskId(sweepId), publishable);

    return {
      artifacts: replies.map((r) => r.artifact),
      blocked: blockedObservers(replies),
      claimedSuccess,
    };
  };

  /**
   * §6.3 steps 8-9.
   *
   * `evidenceRef` is filled on EVERY path, including the one where no document
   * came back, because `SweepCollation.evidenceRef` is non-nullable for the
   * stated reason: *"a sweep that collated nothing still has a task an operator
   * can go and read"*, and a clear that names nothing is a clear derived from an
   * absence.
   */
  const collate = async (sweepId: string): Promise<SweepCollation> => {
    const collateTaskId = collationTaskId(sweepId);
    const envelope = renderCollationEnvelope({
      sweepId,
      environment: deps.environment,
      childTaskIds: TRIAGE_CONSOLE_ASPECTS.map((s) => childTaskId(sweepId, s.aspect)),
    });
    const outcome = await deps.dispatch({
      taskId: collateTaskId,
      worker: TRIAGE_COLLATOR,
      title: envelope.title,
      brief: envelope.brief,
    });
    const evidenceRef = `${TRIAGE_COLLATOR}:${collateTaskId}/${SWEEP_FILES_DIR}/${TRIAGE_DOCUMENT_FILE}`;
    if (outcome.kind !== "accepted") return { document: null, evidenceRef };

    const path = triageDocumentPath(deps.run, collateTaskId);
    const found = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path }, read);
    if (found.kind !== "ok") {
      /*
       * **The reason was being computed and thrown away, and that is the whole
       * defect.** `parseTriageDocument` returns a refusal that names the field and
       * the offending value; collapsing it to `null` here left the sweep recording
       * `coverage` on every service with nothing anywhere saying why.
       *
       * Measured 2026-09-08: five consecutive sweeps were lost to
       * `services.2.assessment: Invalid option: expected one of
       * "healthy"|"degraded"|"unhealthy"|"indeterminate"` - one row graded `failed`,
       * a task-status word that is not an assessment token. The document is parsed
       * whole, so that single word refused the document entire and took two healthy
       * services and a real Grafana fault down with it. The operator saw
       * `consecutive_indeterminate` climb and had no way to reach that sentence.
       *
       * A refused collation is a WORKER contract violation, not a host fault, so it
       * warns rather than throws - the sweep still completes and still reports the
       * services as unobserved, which remains the correct outcome. What changes is
       * that the reason is now sayable.
       */
      if (found.kind === "refused") {
        const detail =
          found.issues.length > 0
            ? found.issues.map((i) => `${i.path}: ${i.message}`).join("; ")
            : found.reason;
        console.warn(
          `triage: ${TRIAGE_COLLATOR}'s collation for ${sweepId} was REFUSED (${found.code}) ` +
            `and every service in it will be recorded unobserved - ${detail}`,
        );
      } else {
        /*
         * ABSENT is the other silence and a DIFFERENT fault to go and fix: the
         * collator never wrote the document at all, rather than writing one this
         * contract rejects. Naming them apart is the same distinction
         * `sweepIdEcho` draws between `stale` and `absent`.
         */
        console.warn(
          `triage: ${TRIAGE_COLLATOR} wrote no collation for ${sweepId} at ${found.path}; ` +
            `every service in it will be recorded unobserved.`,
        );
      }
      return { document: null, evidenceRef };
    }
    return { document: found.document, evidenceRef };
  };

  return { openSweep, dispatchObserver, join: joinSweep, collate };
}
