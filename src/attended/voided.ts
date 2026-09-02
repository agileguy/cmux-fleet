/**
 * The voided-requirements table (SRD §3.5, §16 Phase 6).
 *
 * Attended mode's honest failure is silent: the run still produces a result
 * envelope, a verdict and a diff, and none of them mean quite what they mean
 * unattended. This table is the difference, written down — the exact ISA
 * criteria that stop holding once a person types into a worker's pane, each
 * with one sentence an operator can act on.
 *
 * Two properties are load-bearing:
 *
 * 1. **Every `isc` here must name a criterion that exists in `ISA.md`.**
 *    A table naming a renumbered or deleted criterion is worse than no table,
 *    because it looks authoritative while pointing at nothing. The cross-check
 *    lives in `definedIscIds`/`unknownIscs` below and is enforced by
 *    `test/unit/voided.test.ts` against the real ISA file.
 *
 * 2. **The table is derived from reading the criteria, not from the SRD's
 *    §3.5 prose.** The SRD's tui design reparents Pi's stdin to the pane; an
 *    **`rpc` worker** does not — the supervisor keeps the RPC stream, so RPC
 *    `abort`, stats polling and dialog answering all still work. What a person
 *    in the pane gets is hands inside the worker's container and worktree, and
 *    the guarantees that die are the ones about ATTRIBUTION and QUIESCENCE:
 *    everything that treats the diff as the agent's work, the settle as the
 *    end of writes, and the pane as a surface that carries no input.
 *
 * ## The `rpc` qualifier in (2) was ADDED, not always there (TUI spec item 14)
 *
 * It used to read "this implementation does not", with no worker named, and as
 * a flat statement about the implementation it is now FALSE. It was written
 * when every worker in this repo was an rpc worker, so the qualifier cost
 * nothing and was left off — the same way `attended/mode.ts`'s `interactiveArgv`
 * carried a flat "NOT `docker attach`" until Phase 3 had to scope it.
 *
 * `pane_mode: tui` is the counterexample the sentence did not anticipate. Such
 * a worker runs Pi with `--mode rpc` OMITTED on a real pty, and the supervisor
 * holds none of its three streams (`supervisor/index.ts` launches it detached
 * and tracks it by container name). So for that worker the SRD's design is
 * exactly what shipped: `abort` is not RPC, stats cannot be polled, and nothing
 * answers a dialog. `PANE_MODE_TUI_VOIDED` below is that second, disjoint
 * cause of voiding, and `voidedFor` is how a caller gets the right one.
 *
 * **THE TWO TABLES ARE KEYED ON DIFFERENT THINGS, which is why merging them
 * into one would be wrong.** `TUI_VOIDED` is keyed on an ACT — a person typed —
 * and is stamped when `pifleet tui` records that act. `PANE_MODE_TUI_VOIDED` is
 * keyed on the MODE, and every row in it is true from the moment `up` creates
 * the container, whether or not anybody has touched it. A tui worker gets both,
 * because its pane is a person's by construction.
 */

import { VoidedRequirementSchema, type VoidedRequirement } from "../contracts.ts";

/**
 * What stops holding in `tui` mode. Order follows ISC number so a reader can
 * diff this against the ISA top to bottom.
 *
 * Parsed through the schema at module load so a malformed entry — a typo'd id
 * that the ISA cross-check would wave through because the regex never matched
 * it as an id at all — fails the first import, not the first report.
 */
export const TUI_VOIDED: readonly VoidedRequirement[] = [
  {
    isc: "ISC-84",
    because:
      "Human edits carry no epoch marker, so changes made during epoch N surface in whichever diff is cut next; per-epoch attribution is unreliable for the rest of the run.",
  },
  {
    isc: "ISC-87",
    because:
      "Settle now proves only that the agent went quiet; a person can keep changing the worktree after the task reports complete, so treat the verdict as a snapshot, not a close.",
  },
  {
    isc: "ISC-92",
    because:
      "Claim-versus-diff flagging assumes one author; a person reverting or finishing the worker's files makes the flag fire on honest claims and stay silent on false ones.",
  },
  {
    isc: "ISC-93",
    because:
      "A person's edits can supply the non-empty diff that lets a do-nothing worker's success claim stand; corroborate the verdict against the transcript by hand.",
  },
  {
    isc: "ISC-94",
    because:
      "Verdict reconstruction adopts whatever evidence the tree shows, so a clean diff and green acceptance may certify work the person did, not the worker.",
  },
  {
    isc: "ISC-106",
    because:
      "The pane's shell inherits the image PATH, so a person's gcloud/kubectl/helm/gsutil/bq calls pass through the same verbgate and land in the ledger in the agent's row shape with no author and no task id; the mutating-verb audit trail no longer distinguishes who acted.",
  },
  {
    isc: "ISC-107",
    because:
      "Every cloud invocation is still recorded, but the ledger stops being a record of what the AGENT did — read it as what someone did from this worker.",
  },
  {
    isc: "ISC-141",
    because:
      "Stream-offset fencing orders RPC records only; a person's writes have no stream position at all, so the fence cannot place their work before or after any epoch.",
  },
].map((v) => VoidedRequirementSchema.parse(v));

/**
 * What `pane_mode: tui` gives up, for the LIFE OF THE RUN (SRD §3.5, TUI spec
 * item 14).
 *
 * Every row is true from the moment `up` creates the container. Nobody has to
 * type anything: the mode omits `--mode rpc`, the supervisor holds none of the
 * worker's three streams, and the whole control plane the criteria below are
 * written about does not exist for this worker.
 *
 * **THE REASONS ARE THE ONES THE BUILD MEASURED, NOT THE ONES §3.5 GUESSED**,
 * and in three places those differ. §3.5 feared `docker kill --signal=INT`
 * would be a no-op; measured, it stops the worker cleanly (ISC-81 below).
 * §3.5 says only "completion is transcript-derived, coarser"; the operator-
 * facing consequence is that a re-dispatch RUNS THE TASK TWICE (ISC-85). And
 * §3.5 does not mention ISC-95 at all, though voiding `get_state` is what
 * forces the session file to be found by search rather than recorded.
 *
 * Ordered by criterion number, like the table above, so a reader can diff the
 * printed list against the ISA top to bottom.
 */
export const PANE_MODE_TUI_VOIDED: readonly VoidedRequirement[] = [
  {
    isc: "ISC-74",
    because:
      "SRD F15 — closing a pane does not stop the worker — is false here: the pane IS the worker's terminal, and closing it ends the docker attach that holds it. ASSERTED, NOT MEASURED, and it is the only unmeasured row in this table: --sig-proxy is left at docker's default and no probe has ever closed a tui pane and then looked at the container, so confirm with `docker ps` before reading a settled verdict as a finished run. ISC-74's own sentence survives (no backend touches a SUPERVISOR's lifecycle, and none does here); what is void is the guarantee its original wording carried, which said `in rpc mode` even then.",
  },
  {
    isc: "ISC-81",
    because:
      "`pifleet abort` on this worker issues `docker kill --signal=INT`, which STOPS it rather than returning it to idle — measured: tini forwards to the entrypoint shell, whose `trap forward TERM INT HUP` converts it to TERM and Pi exits cleanly. Pi's turn-interrupt is the ESCAPE keystroke in the pane, which no pifleet command can send, so there is no way to end a turn and keep the worker; abort's JSON says `via` so the two claims are never confused.",
  },
  {
    isc: "ISC-84",
    because:
      "No epoch is allocated at all — the supervisor is the sole allocator and it allocates inside the RPC dispatch handler this worker does not have — so §7.5's interleaving cannot be decided rather than being decided wrongly, and every diff in the run belongs to one undifferentiated placeholder epoch 0.",
  },
  {
    isc: "ISC-85",
    because:
      "Re-dispatching the same task file types the prompt into the pane a second time and RUNS THE TASK TWICE, and the harvest accepts whichever result.json lands last. Check the transcript before re-dispatching, because nothing else will. The reason is that nothing ALLOCATES on this route: dedup keys on (task_id, attempt_id) and answers with a REPLAY of the stored epoch, and with no allocator there is no stored epoch to replay. `already_completed` is a different answer for a different case — a second attempt against a task that has settled — and it is equally unreachable here.",
  },
  {
    isc: "ISC-86",
    because:
      "There is no ack to fail late, because there is no ack at all: `accepted: true` here means cmux exited 0, i.e. bytes reached a pty. It does not prove Pi read them, that a turn started, or that the program on that terminal is still Pi. `prompt_rejected` cannot happen either, so its absence is not evidence that nothing refused.",
  },
  {
    isc: "ISC-87",
    because:
      "Completion is read out of the session transcript — a terminal-looking assistant entry followed by a quiet window — with no agent_end and no correlated get_state to double-check it against. It is coarser by construction: a turn that resumes after the quiet window has already been settled, so treat a tui worker's settle as a strong hint rather than as the proof the rpc path gives.",
  },
  {
    isc: "ISC-95",
    because:
      "`session_path` cannot be recorded verbatim, because get_state is an RPC method this worker has no channel for, so discoverSessionPath SUFFIX-MATCHES `_<worker-id>.jsonl` in the run's own flat session directory instead. Bounded rather than ignored — unique worker id, non-recursive read, and when several match the newest by mtime is returned WITH THE COUNT so the ambiguity is logged — but still weaker than a path Pi stated itself: a Pi that changes §4.2's naming yields nothing here while the rpc path keeps working.",
  },
  {
    isc: "ISC-111",
    because:
      "Nothing answers a dialog extension_ui_request, so one BLOCKS the worker until a person answers it in the pane. That is acceptable only because this mode is attended by construction — leave a tui worker unwatched and a dialog stalls it silently for the rest of the run, with the pane showing the answer nobody gave.",
  },
  {
    isc: "ISC-115",
    because:
      "get_session_stats can never be wired for this worker — there is no control plane to send it on — so harvest/usage.ts's element-wise max is permanently one-armed and the transcript is the only cost source there will ever be. A transcript rewritten or branch-pruned on session switch therefore under-counts with nothing to correct it, and an under-count feeding tokens_ceiling means the ceiling never trips. The polling is unwired for rpc workers too (SRD §13, F12), so this is a structural bound rather than a regression against them.",
  },
  {
    isc: "ISC-141",
    because:
      "There is no RPC stream, so there are no offsets and no fence post: the input the attribution rule reads does not exist for this worker. That subsumes the weaker attended-mode reason above — it is not that a person's writes sit outside the fence, it is that there is no fence.",
  },
].map((v) => VoidedRequirementSchema.parse(v));

/**
 * How a task REACHED this worker — the third key, added by SRD-TUI-DISPATCH D7.
 *
 * `typed` is a person at the keyboard, or the backend-managed pane route
 * typing a rendered prompt with no epoch behind it. `staged` is a dispatch that
 * allocated a real epoch, wrote the inbox record and the drop file, and typed
 * only a trigger.
 */
export type TuiDispatchRoute = "typed" | "staged";

/**
 * What a STAGED dispatch gives back, expressed as a DELTA over
 * `PANE_MODE_TUI_VOIDED` rather than as a second full table (SRD §7.2, D7).
 *
 * ## The cost this file now carries, quoted from the document that chose it
 *
 * §7.2: *"the table must be re-derived per route rather than per mode, which is
 * itself a cost: today one list describes every `tui` worker, and after this
 * there are two shapes of `tui` worker with different guarantees."* And its
 * summary of the whole trade: **"this design converts a mode that voids ten
 * guarantees into a route that voids seven and a half, and adds a second table
 * to keep straight."**
 *
 * That is a real regression in the legibility this file mostly exists for, and
 * it is taken rather than avoided because the alternative is worse: one table
 * for both routes would have to state ISC-84 as either "no epoch is allocated"
 * (false for a staged dispatch) or "an epoch is allocated" (false for the
 * hand-typed turn, which is most of what happens at this seat). A row that is
 * false half the time is not a weaker warning, it is a warning an operator
 * learns to disbelieve.
 *
 * ## A DELTA, and the choice is load-bearing
 *
 * Only the rows §7.2 names appear here. Every other row — ISC-74, ISC-81,
 * ISC-95, ISC-111, ISC-115, ISC-141 — is inherited verbatim from the mode
 * table, so it is byte-identical across routes BY CONSTRUCTION rather than by
 * anybody remembering to copy it. Two full tables would let an edit to one
 * silently change a claim on one route only, and that drift is exactly the
 * failure the "every isc must name a real criterion" cross-check below was
 * written for, one level up.
 */
export const STAGED_ROUTE_TUI_VOIDED: readonly VoidedRequirement[] = [
  {
    isc: "ISC-84",
    because:
      "NOT VOID on this route, and the row is kept rather than dropped so the difference is visible: a staged dispatch allocates a REAL epoch >= 1 through the supervisor's stage verb, and the same number appears in the inbox record, the drop file and the ledger row. What remains void is everything this worker does OUTSIDE a staged task — a person typing their own prompt at this terminal still runs under whatever /policy/task last said, and §7.5's interleaving is still undecidable for those turns. The epoch tells you which staged task a diff belongs to; it does not tell you the diff came from that task.",
  },
  {
    isc: "ISC-85",
    because:
      "CLOSED for a re-stage of the same attempt: dedup keys on (task_id, attempt_id), the attempt id is derived from the task file's content, and a second stage of an unchanged file REPLAYS the stored epoch and rewrites nothing. Editing the brief changes the id and allocates fresh, so the two cases cannot be confused. STILL OPEN, and nothing can close it, for a person who types the same brief into this terminal twice — that is not a dispatch and no allocator sees it. Check the transcript before re-typing; the file route now checks itself.",
  },
  {
    isc: "ISC-86",
    because:
      "Unchanged in force and WEAKER in what it can prove: `accepted: true` on this route means a FILE WAS WRITTEN, not that bytes reached a pty. It does not prove Pi read the drop, that the trigger was typed, or that a turn started — the trigger's own send is reported separately and can fail while the task stays staged and durable. A staged task that nobody triggered looks identical to one that was, from the accept alone; `wait` and `report` are where that difference is visible, not here.",
  },
  {
    isc: "ISC-87",
    because:
      "Unchanged in kind and REACHABLE FOR THE FIRST TIME. Completion is still read out of the transcript — a terminal-looking assistant entry followed by a quiet window, coarser by construction than the rpc path's agent_end. The change worth stating is that until the stage verb existed this settle path had never once EXECUTED: the only caller of the epoch allocator sat below a refusal this route never passed, so em.live was always null and there was nothing to classify against. Treat a settle here as a strong hint, and treat it as a NEW hint: this row described a mechanism that had never run.",
  },
].map((v) => VoidedRequirementSchema.parse(v));

/**
 * How the worker was LAUNCHED, as `container/interrupt.ts`'s `launchPaneMode`
 * reports it. Not `PaneMode` from `contracts.ts` — that is `viewer | tui` and
 * describes what a PANE is showing right now, which is a different question
 * with an unhappily similar spelling.
 */
export type LaunchPaneMode = "rpc" | "tui";

/**
 * The table to stamp into a worker's attended record, and therefore the list
 * `report` prints for it.
 *
 * A tui worker gets BOTH tables. Its pane is a person's `docker attach` from
 * the moment `up` creates it, so every attended-mode row applies to it as much
 * as to a worker someone entered by hand — and the mode's own rows apply on
 * top. Returning only `PANE_MODE_TUI_VOIDED` would silently drop the
 * mutating-verb audit-trail warning (ISC-106/107) and the diff-attribution
 * warnings (ISC-92/93/94) from the one class of run where a person's hands are
 * in the container by default, which is the worse of the two possible errors.
 *
 * **THE OVERLAP RESOLVES TOWARDS THE MODE, deliberately.** ISC-84, ISC-87 and
 * ISC-141 are in both tables for different reasons, and the mode's reason is
 * the stronger one in each case: attended mode says a person's writes carry no
 * stream position, the mode says there is no stream. Showing the weaker
 * sentence on a tui worker would tell an operator a fence exists that their
 * work merely sits outside of. `test/unit/voided.test.ts` asserts the winner
 * per id rather than trusting the order of the spread below.
 *
 * `Object.freeze` because the array is handed to callers that put it straight
 * into a durable record; a table any caller can push onto is not a table.
 * `unknown` is deliberately NOT a case here — `cli/commands/tui.ts` refuses a
 * worker whose launch record and argv disagree before it ever gets this far,
 * and inventing a third answer would hide that refusal behind a default.
 */
export function voidedFor(mode: LaunchPaneMode): readonly VoidedRequirement[] {
  if (mode === "rpc") return TUI_VOIDED;
  const byIsc = new Map<string, VoidedRequirement>();
  for (const v of TUI_VOIDED) byIsc.set(v.isc, v);
  // Second, so the mode's sentence replaces the attended one on a collision.
  for (const v of PANE_MODE_TUI_VOIDED) byIsc.set(v.isc, v);
  return Object.freeze(
    [...byIsc.values()].sort(
      (a, b) => Number(a.isc.slice("ISC-".length)) - Number(b.isc.slice("ISC-".length)),
    ),
  );
}

/**
 * The table `report` prints for one worker, given how its tasks actually
 * arrived (SRD §7.2, ISC-452).
 *
 * ## Why this is not what gets STAMPED, and `voidedFor` still is
 *
 * `attended.json` is written when a person enters the worker — before any
 * dispatch. At that moment nothing has been staged and the mode table is the
 * true one, so `voidedFor(mode)` remains what is recorded and this function
 * changes nothing about it. What this adds is a RE-DERIVATION at report time,
 * for the one run where the stamp is knowably stale: a run in which something
 * was staged after the stamp was taken.
 *
 * The alternative — rewriting `attended.json` on every stage — was rejected.
 * The stamp is a record of what was told to the operator when they took the
 * pane, and a record that mutates under later events is not a record.
 *
 * `typed` returns `voidedFor(mode)` VERBATIM, which is what makes a run with no
 * staged dispatch byte-identical to what it printed before this existed. A
 * change that alters an unstaged run's output is a regression, and the test for
 * this asserts equality against the mode table rather than against a copy of
 * its text.
 */
export function voidedForDispatchRoute(
  mode: LaunchPaneMode,
  route: TuiDispatchRoute,
): readonly VoidedRequirement[] {
  const base = voidedFor(mode);
  // The delta describes the tui mode's own rows. An rpc worker has no staged
  // route to be on — `dispatch` sends it down the control socket — so there is
  // nothing here to apply, and applying it anyway would attach the mode's
  // sentences to a worker that is not in the mode.
  if (route === "typed" || mode === "rpc") return base;

  const byIsc = new Map<string, VoidedRequirement>();
  for (const v of base) byIsc.set(v.isc, v);
  for (const v of STAGED_ROUTE_TUI_VOIDED) byIsc.set(v.isc, v);
  return Object.freeze(
    [...byIsc.values()].sort(
      (a, b) => Number(a.isc.slice("ISC-".length)) - Number(b.isc.slice("ISC-".length)),
    ),
  );
}

/**
 * The set of criterion ids the ISA actually DEFINES.
 *
 * Matches only the checkbox definition shape (`- [ ] ISC-87: …` /
 * `- [x] ISC-248a: …`), never a bare mention in prose — the ISA discusses
 * criteria by id all over its Decisions and Verification sections, and a
 * mention is not a definition. A voided entry pointing at an id that is only
 * ever mentioned would be exactly the rot this check exists to catch.
 *
 * ALL FOUR markers count as definitions, `[~]` and `[-]` included. The class
 * was `[ x]` and a grading audit walked straight into it: marking ISC-141
 * partial — a grade this ISA has used since ISC-47/48 — made the extractor
 * stop seeing a criterion that is defined three lines above the ones it does
 * see, and the cross-check reported the operator-facing table as pointing at a
 * nonexistent id. That is a FALSE POSITIVE of exactly the failure this
 * function exists to detect, which is the worst kind: it teaches a reader to
 * discount the check. A criterion's grade says how well it is EVIDENCED and
 * has nothing to do with whether the ISA defines it.
 *
 * `[-]` — RETIRED, added 2026-08-30 by ISC-368 — is the same trap a second
 * time and is admitted here BEFORE it can spring rather than after. A retired
 * criterion is excluded from `progress:`; it is NOT removed from the file, and
 * the operator-facing voided table may legitimately reference one. Had this
 * class been left as `[ x~]`, retiring a criterion the table names would have
 * reported that table as pointing at a nonexistent id — the identical false
 * positive the paragraph above records, for the identical reason. `-` is last
 * in the class so it is a literal rather than a range.
 */
export function definedIscIds(isaText: string): Set<string> {
  const ids = new Set<string>();
  const re = /^- \[[ x~-]\] (ISC-\d+[a-z]?):/gm;
  for (const m of isaText.matchAll(re)) ids.add(m[1]!);
  return ids;
}

/**
 * Every `isc` in `table` that `defined` does not contain, in table order.
 * Empty array means the table is safe to show an operator.
 */
export function unknownIscs(
  table: readonly VoidedRequirement[],
  defined: ReadonlySet<string>,
): string[] {
  return table.map((v) => v.isc).filter((id) => !defined.has(id));
}
