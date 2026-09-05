# The wedged seat and the unconsumed request — mutation table

What `test/unit/status-wedged-seat.test.ts` and
`test/unit/status-unconsumed-dispatch.test.ts` actually catch, and what they did
not until the battery said so. Produced by
`test/mutation/wedged-seat.battery.ts`, which must be pointed at a throwaway
`git worktree` — it rewrites source in place, and the live fleet on this host
spawns containers by reading the live working tree.

```sh
git worktree add --detach /tmp/wt HEAD
ln -s "$PWD/node_modules" /tmp/wt/node_modules
cp src/cli/commands/status.ts /tmp/wt/src/cli/commands/
cp test/unit/status-wedged-seat.test.ts /tmp/wt/test/unit/
cp test/unit/status-unconsumed-dispatch.test.ts /tmp/wt/test/unit/
bun run test/mutation/wedged-seat.battery.ts /tmp/wt
```

The battery snapshots the worktree's own file at start-up, restores before and
after every mutation, verifies the checksum each time, and refuses a path ending
in `/cmux-fleet`.

## The two defects, which share a file and a discipline

**The wedged seat.** Aborting a task can leave a worker whose `state.json` says
`phase: "busy"`, whose `heartbeat_at` is rewritten every 250 ms, and whose
container is gone from the runtime entirely. Every field on the status line was
individually true and the seat read as working. `classifyWorkerSilence` subtracts
`transcript_activity.last_growth_at` from `heartbeat_at` — two stamps written by
the same supervisor from the same clock — and reports the span against the run's
own `event_stall_warn` / `event_stall_kill` window.

**The unconsumed dispatch-request.** A review console's collator wrote a valid
`dispatch-request.json`, ended its turn and reported success. No relay actor was
running, so nothing consumed it and the review never happened — measured:
`.../outbox/col-1/R-rally-async-6/dispatch-request.json`, 3971 bytes, unconsumed
for minutes, and the fan-out fired instantly once a relay was started. Every
observable read healthy: the worker was `idle`, the result envelope was written,
the outbox was populated. `status` named the relay zero times, so the documented
way to ask what the fleet is doing could not report a console with no actor.
`classifyDispatchRequest` reports the HARM — a request with no entry at
`relayJournalPath(runRoot, sender, taskId)` — which is cause-agnostic (a dead
actor, an actor on the wrong run, a crashed actor and one that refuses all
produce it) and self-gating (only collators write requests).

## Why this file is committed

Every claim below is re-runnable. A battery that reddens on everything reports
itself as a triumph unless the greens are written down beside the reds, and a
probe that stayed green under a mutation that should have killed it is the only
finding that matters. Three rounds have now produced three such findings, and
they are recorded rather than quietly repaired.

## Per-mutation negative-control tracking

This battery reports one column the others do not: whether the control block —
`negative control: the pre-existing transcript column is untouched`, which
exercises only `transcriptNote`, and which NEITHER rule touches — survived each
mutation. A mutation that reddens the whole file proves the suite notices damage,
not that the probe under test is aimed at the defect. The control **held on all
38 mutations**.

## Reds — the wedged seat

| # | Mutation | Catches |
|---|---|---|
| B1 | Alarm fires at `warnMs` instead of `killMs` | A reviewer ten minutes into one model call becomes a false alarm — the honest edge, lost. |
| B2 | The warn band is deleted; everything under kill reads `working` | The three bands collapse to two and `quiet` stops existing. |
| B3 | Boundary made exclusive (`>` not `>=`) | The configured threshold itself never fires. |
| G1 | Busy gate widened to everything but `dead` | An idle worker with a cold transcript is alarmed about — silence alone becomes grounds for a page. |
| G2 | Dead-supervisor gate dropped | All 231 dead runs on this host would print WEDGED; the reaper's territory annexed. |
| U1 | `last_growth_at: null` treated as wedged | The claim `supervisor/index.ts:2007-2010` explicitly forbids: a worker nobody has typed at yet reported as stuck. |
| U2 | `transcript_activity: null` treated as measured-and-healthy | Every `rpc` worker silently certified fine by a mechanism that never measured it. |
| U3 | Two unknown reasons collapse onto one string | "I have no threshold" becomes indistinguishable from "this worker has no record". |
| U4 | Unparseable stamp reported as `quiet` | A corrupt state file rendered as a healthy worker. |
| C1 | Span measured against the reader's `Date.now()` | The portability property dies: the same state gives different answers at different instants, and the file gains a second clock reading. |
| C2 | The `Math.max(0, …)` clamp dropped | Sub-tick poll/heartbeat ordering renders as negative silence. |
| R1 | `silenceNote` also shouts for `quiet` | The slow reviewer becomes a false alarm at the rendering layer instead of the rule layer. |
| R2 | The missing-window case goes quiet | "No alarm because healthy" becomes indistinguishable from "no alarm because I cannot judge". |
| R3 | The alarm drops the span | A seat five minutes past the threshold reads like one dead an hour. |
| W1 | `const wedge = silenceNote(w.silence)` → `const wedge = null` | The alarm computed and thrown away. **Survived round one — see below.** |
| W2 | Threshold hard-coded instead of read from the run | A second opinion about how long is too long, disagreeing with the operator's own config. |
| W3 | `--json` key renamed to `silence_omitted` | Machine readers left to parse the human line. **Survived round one — see below.** |

## Reds — the unconsumed dispatch-request

D1 and D2 are **the asymmetric pair as mutations**, and running both is the whole
discipline. One makes every request read `consumed`; the other deletes the
`consumed` arm so a request that WAS acted on is alarmed about too. A fixture
whose two candidates both lacked a journal entry would survive D2 — it would show
the rule notices *something* without showing it notices the journal.

| # | Mutation | Catches |
|---|---|---|
| D1 | The journal is ignored; every request reads `consumed` | The alarm never fires: the defect is undetectable again, by the shortest possible edit. |
| D2 | The `consumed` arm is deleted | A request that was already fanned out is alarmed about — the direction a one-sided fixture cannot see. |
| D3 | The window is dropped (`>= 0`) | A request written a second ago is called stranded; the false alarm the threshold exists to prevent. |
| D4 | Boundary made exclusive (`>` not `>=`) | The borrowed threshold itself never fires. |
| D5 | `UNCONSUMED_AFTER_MS` set to a literal `10_000` | A second opinion about how long a fan-out may take. **Note what this does NOT redden: every end-to-end probe stays green**, because a 41-minute request is stranded under either number. Only the two unit assertions about the borrow catch it, which is exactly why they exist. |
| D6 | `journal_unreadable` collapses into `consumed` | A request the relay refuses on every pass — `classifyRequest` fails closed — reported as done. That would be a NEW lie introduced by this very column. |
| D7 | The message asserts one cause ("no relay actor is running") | The honest edge. A decline is deliberately never journalled, so a confident accusation is wrong every time an actor read the request and refused it. |
| D8 | `dispatchNote` also shouts for `waiting` | Every freshly written request becomes an alarm, at the rendering layer instead of the rule layer. |
| D9 | The named request is `stuck[0]` rather than the oldest | With several stranded requests the operator is pointed at the newest, not the one that has been failing longest. |
| D10 | The alarm drops the task id | The operator is told a review is stranded but not which one. |
| D11 | The inbox gate dropped (`if (false) continue`) | A worker can forge a permanent alarm by making one directory in the outbox it owns — an id the host never dispatched can never be journalled, so it would read `unconsumed` for ever and no command would clear it. **Survived at the line level — see below.** |
| D12 | `readJournalEntry` never called; every request reads unjournalled | The on-disk half of D1/D2: the consumed request is named, so the journal file is proved load-bearing end to end. |
| D13 | The request's age is taken as `nowMs` | Nothing is ever old enough to alarm; `stat` is called and its answer discarded. |
| D14 | `const stranded = dispatchNote(...)` → `const stranded = null` | The note computed and thrown away — W1's failure, re-run against the new column. |
| D15 | `--json` key renamed to `dispatch_requests_omitted` | W3's failure, re-run: machine readers left to parse the human line. |
| D16 | `readDispatchRequests` never called | The snapshot carries an empty list for every worker and nothing says so. |

## Greens — behaviour-preserving, and they stayed green

| # | Mutation | Why it must not redden |
|---|---|---|
| N1 | Rename the `grew` local to `grownAt` | Proves the battery is aimed at behaviour rather than at text. |
| N2 | Reword the alarm's parenthetical, keeping WEDGED, the span and "container" | Proves the alarm probe asserts the facts on the line, not one exact string. |
| N3 | Rename the `many` local to `plural` | Same, for the dispatch arm. |
| N4 | Reword the message's tail ("says which" → "tells the operator which") | Proves the two-cause probe asserts facts — both causes, and the command — rather than one exact sentence. |
| N5 | Delete the empty-inbox fast path (`dispatched.size === 0`) | Proves the gate D11 removes is the per-task `dispatched.has` test and not the early return. The two are NOT one guard written twice: the early return is speed, and deleting it changes no output. |

## Round one: two survivors, and what they cost

Round one reported **W1 and W3 as green when they were expected red**. Both were
source greps satisfied by text that was not the code path:

- `expect(SRC).toMatch(/silenceNote\(/)` also matches this module's own
  `export function silenceNote(`, so deleting the CALL left it green.
- `expect(SRC).toMatch(/silence:/)` also matches the `silence: SilenceReading;`
  in the local array's type annotation, so renaming the JSON key left it green.

No tightening of a regex retires the class — a probe that reads SOURCE can always
be satisfied by text that is not the code path. Both were replaced with
end-to-end probes that spawn `pifleet status` against a synthetic run directory
under `PIFLEET_RUNS_DIR` and read the OUTPUT: the printed line, and the parsed
`--json` document. Round two: **17/17 as expected, 0 survivors.**

The weak grep is kept alongside, labelled as weak and explicitly paired with the
behavioural probes, because it still pins the `wedge === null ? "" :` guard whose
absence would print a literal `null` on every healthy worker.

## Round three: one more survivor, of a different kind

Adding the dispatch arm produced **D11 green when it was expected red** — and the
cause is not a grep this time. It is a probe aimed at a fact the RENDERING
deliberately hides.

The first version read `expect(line).not.toContain("T-FORGED")` against the
status line. That assertion cannot fail: `dispatchNote` names only the OLDEST
unconsumed request, and the fixture's `T-ORPHANED` was planted first, so it stays
the oldest whether or not the forged task is counted. Dropping the inbox gate
entirely therefore changed nothing the line could show, and the mutation was
caught only by the `--json` block, which enumerates every request.

The probe was moved to `--json`, where the fact is observable, and a positive
half was added beside it (`expect(ids).toContain("T-ORPHANED")`) so it cannot
pass by the reader having looked at nothing at all. **The general lesson is the
same one W1 and W3 taught in a different disguise: a probe must be aimed at a
surface on which the fact it names can actually differ.** Round three:
**38/38 as expected, 0 survivors, control held on all 38.**

## Not covered, and stated rather than implied

- **`rpc` workers.** `transcript_activity` is written only by the `tui`
  transcript poll, so an `rpc` worker reads `unknown/no_activity_record` and the
  wedge rule says nothing about it. That is correct for the defect at hand — on
  the `rpc` path `child` IS the worker, so a container that dies takes the child
  with it and `onChildExit` writes `phase: "dead"` — but it means the rule covers
  one of the two routes by construction.
- **The wedge rule detects; it does not confirm.** WEDGED is an inference from
  two timestamps, not a probe of the container. `supervisor/index.ts:1134-1141`
  names the probe that would confirm it and records that it is not built.
- **A fan-out that is still running is not distinguished from one that never
  started**, and cannot be from inside the run: the journal is written only after
  the whole fan-out, and the fan-out's own early marker is the CHILD dispatches,
  which land in other runs under D4. The threshold is set past
  `RELAY_SETTLE_DEADLINE_MS` so an in-flight fan-out is silent, and the alarm's
  wording hedges rather than accuses. No mutation covers the residual window
  between that deadline and the journal write, because no probe can reach it
  without a live console.
- **A journalled request whose content has since been rewritten** reads
  `consumed` here, while the relay reports `rewritten` and refuses. Detecting it
  needs the request's digest, which means re-reading and re-validating a
  worker-owned path — the check-then-use split `dispatch-request.ts` exists to
  close. It is also not silent: the relay prints that refusal on every pass.
- **`a worker with no outbox at all says nothing`** has no mutation aimed at it.
  Self-gating falls out of `readdir` failing on an absent directory, and every
  edit that would break it breaks the command outright rather than the column.
