# The wedged seat — mutation table

What `test/unit/status-wedged-seat.test.ts` actually catches, and what it did
not until the battery said so. Produced by
`test/mutation/wedged-seat.battery.ts`, which must be pointed at a throwaway
`git worktree` — it rewrites source in place, and the live fleet on this host
spawns containers by reading the live working tree.

```sh
git worktree add --detach /tmp/wt HEAD
ln -s "$PWD/node_modules" /tmp/wt/node_modules
cp src/cli/commands/status.ts /tmp/wt/src/cli/commands/
cp test/unit/status-wedged-seat.test.ts /tmp/wt/test/unit/
bun run test/mutation/wedged-seat.battery.ts /tmp/wt
```

The battery snapshots the worktree's own file at start-up, restores before and
after every mutation, verifies the checksum each time, and refuses a path ending
in `/cmux-fleet`.

## The defect

Aborting a task can leave a worker whose `state.json` says `phase: "busy"`,
whose `heartbeat_at` is rewritten every 250 ms, and whose container is gone from
the runtime entirely. Every field on the status line was individually true and
the seat read as working. `classifyWorkerSilence` subtracts
`transcript_activity.last_growth_at` from `heartbeat_at` — two stamps written by
the same supervisor from the same clock — and reports the span against the
run's own `event_stall_warn` / `event_stall_kill` window.

## Why this file is committed

Every claim below is re-runnable. A battery that reddens on everything reports
itself as a triumph unless the greens are written down beside the reds, and a
probe that stayed green under a mutation that should have killed it is the only
finding that matters. This round had two of those, and they are recorded rather
than quietly repaired.

## Per-mutation negative-control tracking

This battery reports one column the others do not: whether the control block —
`negative control: the pre-existing transcript column is untouched`, which
exercises only `transcriptNote` — survived each mutation. A mutation that
reddens the whole file proves the suite notices damage, not that the probe under
test is aimed at the defect. The control **held on all 17 mutations**.

## Reds — the mutation changes behaviour and a test catches it

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
| W1 | `const wedge = silenceNote(w.silence)` → `const wedge = null` | The alarm computed and thrown away. **Survived the first round — see below.** |
| W2 | Threshold hard-coded instead of read from the run | A second opinion about how long is too long, disagreeing with the operator's own config. |
| W3 | `--json` key renamed to `silence_omitted` | Machine readers left to parse the human line. **Survived the first round — see below.** |

## Greens — behaviour-preserving, and they stayed green

| # | Mutation | Why it must not redden |
|---|---|---|
| N1 | Rename the `grew` local to `grownAt` | Proves the battery is aimed at behaviour rather than at text. |
| N2 | Reword the alarm's parenthetical, keeping WEDGED, the span and "container" | Proves the alarm probe asserts the facts on the line, not one exact string. |

## The two survivors, and what they cost

Round one reported **W1 and W3 as green when they were expected red**. Both were
source greps satisfied by text that was not the code path:

- `expect(SRC).toMatch(/silenceNote\(/)` also matches this module's own
  `export function silenceNote(`, so deleting the CALL left it green.
- `expect(SRC).toMatch(/silence:/)` also matches the `silence: SilenceReading;`
  in the local array's type annotation, so renaming the JSON key left it green.

No tightening of a regex retires the class — a probe that reads SOURCE can
always be satisfied by text that is not the code path. Both were replaced with
end-to-end probes that spawn `pifleet status` against a synthetic run directory
under `PIFLEET_RUNS_DIR` and read the OUTPUT: the printed line, and the parsed
`--json` document. Round two: **17/17 as expected, 0 survivors.**

The weak grep is kept alongside, labelled as weak and explicitly paired with the
behavioural probes, because it still pins the `wedge === null ? "" :` guard
whose absence would print a literal `null` on every healthy worker.

## Not covered, and stated rather than implied

- **`rpc` workers.** `transcript_activity` is written only by the `tui`
  transcript poll, so an `rpc` worker reads `unknown/no_activity_record` and
  this rule says nothing about it. That is correct for the defect at hand — on
  the `rpc` path `child` IS the worker, so a container that dies takes the child
  with it and `onChildExit` writes `phase: "dead"` — but it means the rule
  covers one of the two routes by construction.
- **The rule detects; it does not confirm.** WEDGED is an inference from two
  timestamps, not a probe of the container. `supervisor/index.ts:1134-1141`
  names the probe that would confirm it and records that it is not built.
