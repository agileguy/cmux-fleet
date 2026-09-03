# System Requirements Document — a read-only fleet monitor TUI

**SRD-FLEET-MONITOR-001 v0.2 — OWNER-REVIEWED, ACCEPTED FOR IMPLEMENTATION**

**What changed in v0.2.** Four decisions were put to the owner on 2026-09-02 and all four were
answered; the answers are folded in below rather than appended, and every place this document
argued the other way is marked as superseded rather than rewritten into agreement.

| Question | Answer | Where it landed |
|---|---|---|
| **Toolkit** (D2) | **Ink**, against this document's own recommendation of hand-rolled ANSI | §6.6, §6.6.1 (two new measurements), D2 rewritten, **Q10 opened** |
| **Scope** | **Full SRD — all four views**, no first slice | §5.1 |
| **Git strip default** (Q8, D12) | **Status first, commits behind `[c]`** — the reverse of D12's original | §6.8, §7.2, D12, Q8 closed |
| **How to settle Q1** | **A throwaway worker in a scratch run**, not the live console panes | §9 Q1 |
| **Clock units** (raised during implementation) | **`Region.readAt` and `FleetModel.now` are MONOTONIC; transcript ages stay WALL CLOCK** | `monitor/model.ts` two-clocks note, `test/unit/monitor-clock-units.test.ts` |

**The clock-units decision, and why it needed one.** The three-clock scheduler surfaced that
`readAt` was specified as epoch millis while every consumer *subtracts* it — and `util/clock.ts`
is unambiguous (ISC-155) that subtracting two wall-clock readings is a bug, because an NTP step
or a laptop suspend is exactly what a standing monitor sits through. But the fix could not be
applied uniformly: `transcriptAgeMs` and the activity ladder compare against ISO stamps written
by the **supervisor**, a different process with no monotonic origin in common, so those must
remain wall clock — the same exemption `status.ts`'s `ago` already claims.

The owner's answer was the mixed model: each comparison uses the clock that shares an origin with
its other operand. The hazard this creates is that both clocks are `number`, so a swap is not a
type error — it is a *reassuring* one. Monotonic minus epoch is about -1.76e12, which clamps to
zero, so every worker renders `wrote 0s ago`, every region renders `as of 0s`, and every attended
worker that has ever spoken renders `active`. All three are the most comforting frame the monitor
can draw and all three are false. `test/unit/monitor-clock-units.test.ts` pins magnitude rather
than monotonicity — "it goes forward" is true of both clocks — and five mutations covering every
site that could make the swap are all caught by it.

**One of those answers refuted a claim this document made confidently.** §6.6.1 records it: the
recommendation for hand-rolled ANSI rested on "a component tree is not unit-testable the way a
string-returning renderer is", and a fifteen-line probe showed `lastFrame()` returns a plain string
that pins byte-for-byte exactly like a line array. The recommendation is preserved in D2 with its
reasoning intact, marked superseded, because a reader deciding whether to revisit the toolkit needs
to see what the argument was and precisely which part of it failed.
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001), `Docs/SRD-TUI-DISPATCH.md` and
`Docs/SRD-INFERENCE-PROVIDERS.md`. It proposes **no amendment to `Docs/SRD.md`** — a viewer that
writes nothing needs no relaxation of anything — but it does propose **replacing panes 3 and 4 of
the operations console**, which `src/backends/cmux/operations-plan.ts` owns and
`test/unit/operations-plan.test.ts` pins. Until that replacement is adopted, the two watchers stand
and this document is a proposal.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operations console's bottom row is two shell loops. One re-runs `pifleet status --all` every
five seconds; the other re-runs `git status --short --branch` and `git log --oneline -10` on the
directory you started from. Both work, both are honest, and **both answer a question the operator
did not ask.** Measured on this host at 15:03 UTC on 2026-09-02, `status --all` returned six live
runs of one worker each and printed the same six words about every one of them —
`idle task=- supervisor=up` — because `phase` describes an *epoch* and an attended worker allocates
none (`src/contracts.ts:343-380`). Four of those six carried no activity signal at all. Meanwhile
the run directories underneath held 114 runs, 2,581 files, 54.5 MB of event logs, an attended record
per worker naming ten voided guarantees, a verdict lattice, an audit trail of every gated cloud verb,
and a per-worker container that `docker ps` reports as `Up 9 hours`. **The data is there. The pane
is not reading it.** This document specifies a single read-only TUI that reads it, in one pane,
answering the three questions an operator actually has — *is anything stuck?*, *what did this run
cost?*, *which worker died and why?* — for live runs and for finished ones, and it argues that the
"WOW" the commission asks for is not decoration but the direct consequence of showing what already
exists instead of a six-word summary of it.

### 0.2 The decision that matters — the incumbent is a floor, not a baseline

The two panes being replaced are not placeholders. Each carries a measured lesson in its own
comments, and a replacement that loses one is a regression however good the rest is:

- **`watch(1)` is not installed on this host** (`operations-plan.ts:47-50`). Both loops are shell
  `while` loops for that reason and "must stay one".
- **`pifleet status --watch` APPENDS** (`operations-plan.ts:632-643`), so a standing pane became "a
  transcript of how long a dead worker had been dead". Measured on the live console 2026-08-30.
- **`git log` without `--no-pager` starts `less` and hangs at `(END)`** (`operations-plan.ts:697-703`)
  — "the exact failure a screenshot cannot distinguish from success".
- **Repainting every tick is a visible flash** on panes whose content is usually identical, and the
  flash "reads as activity when there is none" (`operations-plan.ts:655-671`). Hence
  `redrawOnChange`, which repaints only on a diff.
- **`|| true`**, because "the pane dies on the first refresh after a `down`, which is exactly when an
  operator looks at it" (`operations-plan.ts:668-670`).
- **`git -C <watchDir>`, never `cd`**, and `watchDir` is `process.cwd()` at
  `scripts/operations:66` — the console watches *the repository you were standing in*, which is not
  necessarily this one.

**So there are two honest dispositions, and §4 works through both:**

1. **Enrich the panes.** Keep two shell loops; make `pifleet status` print more, and add a third
   loop. Cheap, and it inherits every lesson above for free.
2. **Replace them with one program.** A single long-lived read-only process that reads the run
   tree directly, keeps its own model of the fleet across ticks, and repaints regions rather than
   screens.

**This document recommends (2), and §6 specifies it.** (1) is not merely less impressive; §4.3
argues it cannot solve the problem the commission actually names, because the thing an operator
wants to see — *change over time* — is precisely what a stateless re-run of a command cannot show.

### 0.3 The disclosure boundary

This document names no employer, no cloud project, no cluster, no ticket system and no ticket
identifier. Worker ids (`obs-1`, `tick-1`, `eng-1`, `eng-2`, `tst-1`, `rev-1`) are the ones
`fleet.example.yaml` and `src/backends/cmux/operations-plan.ts:97` publish. Measurements taken from
the operator's own `~/.pifleet/runs` on 2026-09-02 are reported as counts, byte totals and run ids;
run ids are timestamps plus a random suffix and carry nothing. Container image tags are named
because they are this repository's own build output. This follows §0.3 of
`Docs/SRD-INFERENCE-PROVIDERS.md`.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Measured** | probes run on the operator's host 2026-09-02: `pifleet status --all --json` timed and parsed, `docker ps`, `find`/`ls` over `~/.pifleet/runs`, event-log type histograms, two live run directories read file by file | §1.2, §2 wherever a number appears, §3.1, §3.4 |
| **Read** | code in this repository, opened on 2026-09-02, with file and line cited at every claim | §2 in its entirety, §4.1, §4.2 |
| **Recorded** | `Docs/SRD.md` §0.2/§3.5, `Docs/SRD-TUI-DISPATCH.md`, `src/attended/voided.ts`, `src/backends/cmux/operations-plan.ts`'s own comments | §0.2, §1.1, §4 |
| **Inferred** | reasoning from the above | §5-§8. **These are design proposals, not observations, and they are where the owner's review is most valuable.** |

**A CITATION WARNING THAT IS PART OF THE EVIDENCE, not a footnote.** Every line number below is
against the **main checkout** of this repository as it stood on 2026-09-02, which
is the tree this document is written to describe. This file was authored from an agent worktree that
is **behind** that tree — it sits at `a5e322d` (the per-worker-inference-providers PR), where
`Docs/SRD-TUI-DISPATCH.md` does not yet exist, the staged-dispatch route is unbuilt, and `ISA.md`'s
highest criterion is `ISC-430` rather than `ISC-467`. Eight of the fifteen files cited here differ
between the two trees: `src/run/paths.ts`, `src/contracts.ts`, `src/report/collect.ts`,
`src/report/render.ts`, `src/supervisor/index.ts`, `src/cli/commands/status.ts`,
`src/cli/commands/wait.ts` and `src/attended/voided.ts`. `src/backends/cmux/operations-plan.ts`,
`src/harvest/layout.ts`, `src/run/ledger.ts`, `src/cli/commands/logs.ts` and `package.json` are
byte-identical in both. **A reader checking these citations against an older tree will find them
shifted, and the correct response is to re-verify against the tip rather than to assume the document
is wrong.**

**Nothing about a 500-run fleet was measured.** §3.4 extrapolates from 114 runs and says so at the
point of extrapolation; §9 Q5 states the probe.

### 0.5 Two corrections to the premises this document was commissioned against

**First.** The commission calls the supervisor event log *"the richest historic signal in the
system"*. That is true for an **`rpc`** worker and false for a **`tui`** one, and the gap is three
orders of magnitude. Measured:

| Worker | Log | Lines | `type: "event"` records |
|---|---|---|---|
| `tick-1`, run `2026-08-30T23-41-07Z-1b0a` (rpc) | 24,669,983 bytes | 8,336 | 8,331 |
| `obs-1`, run `2026-09-02T14-43-01Z-e533` (tui, live) | 2,150 bytes | 17 | **0** |

The rich half is `logEvent({ type: "event", seq, event })` at `src/supervisor/index.ts:1554`, which
wraps every Pi RPC event verbatim — ~3 KB per line. A `tui` worker has no RPC stream, so that line
never runs for it, and its whole log is 12 `credential_injected` records plus five lifecycle rows.
**Both operations-console workers are `tui`.** A monitor built on the assumption that the event log
is where the interesting history lives would be rich about workers the console does not show and
empty about the two it does. §2.4 is written around that asymmetry.

**Second, and smaller.** The commission asks for "the ledger (`via:` values, dispatch rows)" as
though `via` were a ledger field. It is a key inside `detail` — `LedgerRecordSchema`
(`src/contracts.ts:938-948`) has `seq`, `ts`, `actor`, `run_id`, `event` and three optionals, and
`detail` is `z.record(z.string(), z.unknown())`. `report` already relies on that spelling:
`collectRunReport` finds staged workers by `(r.detail as {via?: unknown})?.via === "staged"`
(`src/report/collect.ts:276-283`). The distinction matters because it means **`via` is not
schema-validated** — a writer that spelled it differently would produce a ledger that parses
cleanly and a report that silently found no staged workers.

### 0.6 What reading the code and measuring the host found

Five findings, all live today, none of which needs this feature to exist in order to be true. They
are stated up front because each changes what a section downstream may assume.

| # | Finding | Live today? | § |
|---|---|---|---|
| **A** | **Four of six live workers have no activity signal at all.** `transcript_activity` is `null` for `eng-1`, `eng-2`, `tst-1`, `rev-1` — all four `mode: "tui"`, `adopted_terminal: true`, attended since 14:43Z with `left_at: null`. Their run's `sessions/` directory is **empty**, so the transcript poll returns before ever writing the field (the poll reaches `discoverSessionPath` and returns on `found.path === null`, `src/supervisor/index.ts:1973-2020`). `transcriptNote` renders `null` as *nothing* (`src/cli/commands/status.ts:76`), so the pane prints `eng-1: idle task=- supervisor=up` and stops. **A worker that has never spoken is indistinguishable from an `rpc` worker, and both are indistinguishable from a worker that is wedged.** | Yes — measured | §3.1 |
| **B** | **`status --all` costs a full runs-root walk on every tick, and the cost scales with runs on disk rather than with live runs.** `liveRunIds` (`src/run/registry.ts:1036-1063`) iterates every run holding a `run.json` — 80 of 114 today — reading `registry.json` and every `state.json`, and spawning `ps -o lstart= -p <pid>` (`src/safety/procstart.ts:122-131`) per worker until one is alive. Measured: **403 ms wall** for one `status --all --json`, repeated every 5 s by `operations-plan.ts:334`. | Yes — measured | §2.1, §3.4 |
| **C** | **34 of 114 directories under the runs root hold no `run.json`.** `runIdsAscending` (`src/run/paths.ts:937-957`) skips them by design — its comment names the failure it prevents — so a monitor that lists the runs root with a bare `readdir` shows 42% more "runs" than exist. | Yes — measured | §2.1 |
| **D** | **`docker` is not a data source anywhere in `src/`.** `grep` finds `docker image inspect` (`src/container/image.ts`, `src/cli/commands/doctor.ts`), `docker rm -f` (`down.ts:1507`, `safety/reaper.ts:148`), `docker exec` (`attended/mode.ts:155`, `exec.ts:45`), `docker kill` (`container/interrupt.ts:134`) and a `network inspect`. **There is no `docker ps` and no `docker inspect <container>` for a worker container anywhere in the tree.** So every claim this fleet makes about whether a worker is running is made from `state.json` plus `ps`, never from Docker. Measured against reality today the two agree — six containers named exactly `pifleet-<runId>-<workerId>` (`src/run/paths.ts:484`), all `Up 9 hours` — but nothing checks that they do. | Yes | §2.6, D7 |
| **E** | **`scripts/operations:10` documents a pane that does not exist.** It says the console holds *"a live `pifleet status --watch`"*. It holds a `redrawOnChange` loop, and `operations-plan.ts:632-653` is the argument for why `--watch` would be wrong. A stale sentence in the launcher's own header. | Yes | §1.1 |

**And one finding that reframes the whole document.** Every number the commission asks for —
what a run cost, which worker died, what is stuck — is already computed by something in this tree.
`collectRunReport` (`src/report/collect.ts:147-289`) merges the ledger, reads every inbox envelope,
harvests every task, cross-checks the ledger against the inbox, pre-checks every merge, collects the
escape-watch surface and the attended records, and degrades rather than throwing. `renderRunReport`
(`src/report/render.ts:27-140`) already knows the *order* those facts must be read in — attended
first, security second, totals third — and argues for it. **This document is therefore not asking
for a new analysis layer. It is asking for a surface that runs the existing one on a clock and
paints the difference.**

---

## 1. Problem statement

### 1.1 The two incumbent panes, exactly

Both are generated by `src/backends/cmux/operations-plan.ts`, which is **byte-identical** in the
worktree and the main checkout. Both share one loop generator, `redrawOnChange`
(`operations-plan.ts:672-678`):

```sh
prev=''; while :; do out="$(BODY 2>&1)" || true;
  if [ "$out" != "$prev" ]; then clear; printf '%s\n' "$out"; prev="$out"; fi;
  sleep N; done
```

**Pane 3, `fleet-status`** (`operations-plan.ts:441-448`, built at `:334`, generator
`statusWatchCommand` at `:680-686`):

```sh
BODY = bun run <repo>/src/cli/index.ts status --all
```

**Pane 4, `git-watch`** (`operations-plan.ts:449-465`, generator `gitWatchCommand` at `:696-714`):

```sh
g = git --no-pager -c color.ui=always -C <watchDir>
BODY = $g status --short --branch; echo; $g log --oneline -10
```

`N` is `DEFAULT_GIT_POLL_SECONDS = 5` (`operations-plan.ts:115`), resolved at `:319`, validated at
`:329-331`, and settable with `scripts/operations:42`'s `--poll`. Despite the flag's help text
saying "git pane", **it drives both** — `operations-plan.ts:334` passes the same `poll`.

Two properties follow that any replacement must keep, and they are easy to lose:

- **The git pane watches the invocation directory, not this repository.** `scripts/operations:66`
  sets `watchDir = process.cwd()`, and `operations-plan.ts:451-454` explains the `-C` rather than a
  `cd`. An operator who opens the console from another repo is watching that one.
- **`--poll` is one knob for both.** Pinned by `test/unit/operations-plan.test.ts:336-341`.

The `development` console has **no watcher panes at all** (`scripts/development:22-25`): four agent
panes, nothing polling. Whatever replaces the operations watchers is therefore also the first thing
that could give the development console a status surface, and §5.2 declines to make that a goal.

### 1.2 The measured cost — the console as it stands, 2026-09-02

`pifleet status --all --json`, timed and parsed on the operator's host:

```
live runs reported: 6
 2026-09-02T14-43-01Z-e533  obs-1  phase idle  alive  hb_age 9.5s  transcript {entries:50, last_growth 15:03:21Z}
 2026-09-02T14-43-02Z-fd2f  tick-1 phase idle  alive  hb_age 9.4s  transcript {entries:28, last_growth 14:51:54Z}
 2026-09-02T14-43-27Z-1c61  eng-2  phase idle  alive  hb_age 9.6s  transcript null
 2026-09-02T14-43-27Z-3906  eng-1  phase idle  alive  hb_age 9.6s  transcript null
 2026-09-02T14-43-27Z-a8a0  tst-1  phase idle  alive  hb_age 9.4s  transcript null
 2026-09-02T14-43-28Z-bf9d  rev-1  phase idle  alive  hb_age 9.5s  transcript null
```

The text pane renders that as six lines, four of which are byte-identical apart from the worker id.
What the same moment held, and the pane did not show:

| Fact | Where it already is | Why the pane is silent about it |
|---|---|---|
| All six workers are attended `tui`, entered 14:43Z, **never handed back** (`left_at: null`) | `<run>/workers/<id>/attended.json`, `AttendedRecordSchema` (`contracts.ts:1851`) | `status` does not read it. `report` does (`collect.ts:355`) and prints it FIRST (`render.ts:145`), because "every number below this line means something weaker once a person typed into a pane" (`render.ts:37-43`) |
| Each carries ten voided guarantees | `attended.json`'s `voided[]`, from `PANE_MODE_TUI_VOIDED` (`voided.ts:124-176`) | same |
| Six containers `Up 9 hours` on two images | `docker ps` | nothing in `src/` runs it (Finding D) |
| `obs-1`'s transcript last grew at 15:03:21Z; `tick-1`'s at 14:51:54Z — **11 minutes apart** | `transcript_activity.last_growth_at` (`contracts.ts:381-390`) | it IS printed, as `transcript 11m ago` (`status.ts:72-80`) — but as a suffix on one line, with nothing to compare it against |
| `eng-1`'s run has an **empty** `sessions/` directory | the filesystem | Finding A: renders as nothing at all |
| 114 run directories, 80 real, 66 MB, 83 event logs totalling 54.5 MB | the runs root | `--all` shows only live runs, by design (`status.ts:99-111`) |
| 13 task envelopes and 11 task records exist across the whole history | `<run>/inbox/`, `<run>/workers/<id>/tasks/` | not a `status` concern |

**The asymmetry in that last row is the shape of the whole problem.** Eighty-three workers have been
stood up on this host, and eleven tasks have ever settled. The console's workers are driven by hand
and produce no inbox record at all, so **every pifleet surface that keys on the dispatched set is
structurally empty for them** — `wait` breaks immediately (`wait.ts:115-118`: "Nothing was ever
dispatched; nothing to wait for"), `dispatchedTaskIds` returns `[]` (`harvest/layout.ts:110-121`),
and `unexplainedOutboxDirs` therefore returns `[]` too, on the empty-dispatch guard it documents at
`layout.ts:149-158`. That is exactly the shape `harvest/layout.ts:19-24` names — *"a mechanism that
is present, tested and invoked, running over an empty input, publishing a clean result"* — and the
monitor's job is to be the surface that says so out loud.

### 1.3 What the operator is actually trying to find out

The commission is explicit that the layout must follow the questions rather than the data
structures. There are four, and each has a different residency:

| Question | Answered from | Live or historic |
|---|---|---|
| **Is anything stuck?** | `transcript_activity` age, `heartbeat_at` age, `phase`, container uptime, event-log tail growth | **live only** — a finished run cannot be stuck |
| **What is this run doing right now?** | `phase`, `task_id`, `staged_task_id`, the last N event rows, `fence.json`'s `live` | **live only** |
| **What did this run cost / produce?** | `RunReport` totals, `usage` in `state.json`, `budget.json`, the harvest's verdicts, merge pre-check | **historic, and richer than live** |
| **Which worker died, and why?** | `state.exit {code, signal}`, `phase: "dead"`, the last events before the gap, `worker_exit` in the ledger, the audit trail | **both, and they read differently** |

The last row is the one that decides the design. A **live** answer to "why did it die" is a guess in
progress; a **historic** one is a settled record with a verdict attached. §6.2 gives them different
renderings on purpose.

### 1.4 Success in one sentence

An operator glances at one pane in the operations console and can tell, without pressing a key,
which workers are moving and which have gone quiet and for how long; can press one key to see a
finished run's tasks, verdicts, spend and merge state; and never has to wonder whether what they are
looking at is current, because every region says how old it is.

---

## 2. The data sources, read from the code and measured on disk

> Every claim carries a file and a line, against the **main checkout** — see §0.4's citation
> warning. Byte counts and file counts are from `~/.pifleet/runs` on 2026-09-02.

### 2.1 The runs root — enumeration, and what it costs

`runsRoot()` is `~/.pifleet/runs` unless `PIFLEET_RUNS_DIR` overrides it
(`src/run/paths.ts:54-56`), canonicalised there rather than at the call sites for the reason its
docblock gives.

`runIdsAscending` (`paths.ts:937-957`) lists the root, **stats `run.json` in every entry**, and
sorts lexically — the id format is a UTC timestamp so lexical order is chronological
(`paths.ts:98-108`). Today that is 114 entries in and 80 out. The 34 that are dropped are the
finding `paths.ts:906-909` records: *"a stray name that sorts after every timestamp would otherwise
become 'the latest run'"*.

`liveRunIds` (`registry.ts:1036-1063`) then walks **all 80**, reading `registry.json` and every
`state.json`, and calling `identityAlive` (`registry.ts:84`) or `processStartTime`
(`safety/procstart.ts:122-131`) — each of which spawns `ps` — until one worker answers alive.

**Measured: 403 ms wall for one `pifleet status --all --json`.** Cost is O(runs on disk), not
O(live runs). At 5 s that is 8% of a core, permanently, to print six unchanging lines.

| | Live | Historic | Refresh cost |
|---|---|---|---|
| runs-root listing | ✔ | ✔ | one `readdir` + one `stat` per entry — **7 ms for 114** |
| `liveRunIds` | ✔ | — | **403 ms at 80 runs**, and one `ps` spawn per worker |

### 2.2 Per-run files

`runPaths` (`paths.ts:193-212`) is the single definition. Everything below is under `<run>/`:

| Path | Field | Content | Live / historic | Refresh cost |
|---|---|---|---|---|
| `run.json` | `runJson` | budget policy, harness patterns, heartbeat interval, worktrees, `branch_prefix` — read by five separate validated readers in `src/run/state.ts:87-619` | **immutable after `up`** | one small read, cacheable for the life of the run |
| `registry.json` | `registryJson:199` | daemon's view of live supervisors, `{pid, started}` per worker | live | one small read |
| `ledger/<writer>.jsonl` | `ledgerDir:204` | append-only, sharded per writer (`run/ledger.ts:1-10`); 413 shards / 292 KB across all runs | **both** | append-only ⇒ tailable; `mergeLedger` (`ledger.ts:83-118`) re-reads whole shards |
| `audit/<worker>.jsonl` | `auditDir:205` | host-collected verbgate rows — every gated cloud verb, with `task_id` provenance | **both** | append-only |
| `inbox/<task-id>.json` | `inboxDir:206` | the full `TaskEnvelope` (`contracts.ts:146-172`); **13 exist across all 114 runs** | historic-shaped, written at dispatch | `readdir` + one read each |
| `sessions/*.jsonl` | `sessionsDir:207` | Pi transcripts; 23 files, 3.1 MB, largest 350 KB | live (grows) and historic | see §2.4 |
| `workers/<id>/` | `workersDir:208` | §2.3 | | |
| `outbox/<worker>/` | — | worker-authored; `<task-id>/result.json` (`harvest/outbox.ts:376`) and `<task-id>/files/` (`:544`) | historic | see §2.5 |
| `schedule.json` | `scheduleJson:209` | `ScheduledTask[]` — **absent for a manually dispatched run, and that is normal** (`paths.ts:158-159`) | historic | one read |
| `budget.json` | `budgetJson:210` | `BudgetState`; also absent for a manual run (`state.ts:449-453`) | both | one read |
| `worktrees/<worker>/` | — | the per-worker clone | both | git is expensive; see D12 |

### 2.3 Per-worker files

`workerPaths` (`paths.ts:369-393`), under `<run>/workers/<id>/`. Measured on two live workers today:
`obs-1` has thirteen entries, `eng-1` twelve (no `kubeconfig`, no `credentials.jsonl`). **Neither has
`fence.json` and neither has `dispatch-policy`** — nothing has been staged or dispatched to either.

| Path | Field | Content | Live / historic | Cost |
|---|---|---|---|---|
| `state.json` | `:374` | `WorkerStateSchema` (`contracts.ts:225-457`): `phase`, `epoch`, `task_id`, `staged_task_id` (`:335`), `session_path`, `session_present`, `transcript_activity` (`:381`), `heartbeat_at`, `turns`, `tool_calls`, `tool_errors`, `usage`, `compactions`, `credential`, `retries`, `exit`, `container` (`:291`) | **both** — rewritten every 250 ms while live (`supervisor/index.ts:94`), frozen afterwards | one atomic read; `readValidated` (`state.ts:806-855`) already has a torn-read retry |
| `fence.json` | `:375` | `FenceFileSchema` (`state.ts:689-707`): `live`, `completed[]`, `attempts{}`, `ack_seq`, `last_seq` | both | one read; **absent is normal** |
| `presentation.json` | `:376` | backend, refs, `adopted_terminal` (`contracts.ts:856`) | immutable after `up` | one read, cache it |
| `events.jsonl` | `:377` | §2.4 | both | §2.4 |
| `supervisor.log` | `:378` | free text | both | tail only |
| `tasks/<task-id>.json` | `:380` | `TaskRecordSchema` (`state.ts:733-764`): terminal verdict, reason, epoch, `tree_hash`. **11 exist across all runs** | **historic by definition** — written at settle | `readdir` + read |
| `attended.json` | `:381` | `AttendedRecordSchema` (`contracts.ts:1851`): `mode`, `entered_at`, `left_at`, `voided[]` | **written once, never removed** (`collect.ts:266-268`) | one read |
| `credentials.jsonl` | `:382` | `CredentialInjection` per injection — the sequence, deliberately (`paths.ts:241-254`); **no token field by construction** | both | append-only |
| `launch.json` | `:390` | the exact `docker run` argv, container name and image | immutable | one read |
| `task-policy` / `dispatch-policy` | `:386`, `:387` | two-line provenance, and the staged brief (`run/dispatch-policy.ts:76`) | live | tiny |

### 2.4 The event log — richest, most expensive, and asymmetric

`logEvent` (`supervisor/index.ts:296-317`) is the single funnel. It stamps `ts` at emission rather
than at flush, and the comment at `:298-309` says why: under load "every timestamp in it drifted
later by however backed up the chain was". Every line passes a secret redactor armed before the
first append (`:290`, `:336`).

**Forty-one distinct event types** are written by the supervisor, plus the wrapper
`{type: "event", seq, event}` at `:1554` that carries a Pi RPC event verbatim. The useful ones for a
monitor: `epoch_started`, `settled`, `settle_failed`, `deadline_exceeded`, `deadline_escalated`,
`no_tool_calls_detected` / `_escalated`, `no_work_done_detected`, `tui_container_started` (`:1716`),
`tui_launch_failed`, `tui_turn_baseline` (`:2110`), `tui_turn_ended` (`:2268`),
`tui_transcript_poll_failed`, `credential_refresh_failed`, `protocol_error`, `stray_response`,
`stderr_line` (`:1739`), `ui_request_*`.

**The asymmetry (§0.5).** For an `rpc` worker the log is 3 KB/line and megabytes long; for a `tui`
worker it is a few kilobytes for the whole run. So:

| | Live | Historic | Refresh cost |
|---|---|---|---|
| `events.jsonl`, tail | ✔ | ✔ | append-only ⇒ `TailReader` (`src/util/jsonl.ts`, used by `logs.ts:36`) reads only the delta |
| `events.jsonl`, whole | — | ✔ | **24.7 MB / 8,336 lines** worst case measured; a full parse is not a per-tick operation |

`logs.ts` already solved the rendering half and it is the precedent to reuse, not re-derive:
`RENDER_CLIP = 400` (`logs.ts:39`), the C0/C1 control-character class (`:46`) and `sanitize` (`:48`)
which **replaces rather than strips**, "a visible U+FFFD tells the operator content was withheld,
where silent removal would present doctored text as verbatim".

### 2.5 The outbox, the harvest, and the report

The monitor must not re-derive any of this. `harvestTask` reads `<outbox>/<task>/result.json`
(`outbox.ts:376`) through `lstat`-first refusals and a byte cap, scans `<task>/files/` (`:544`)
through validated descriptors, adjudicates the worker's claim against the derived facts via the
lattice `failed < blocked < partial < success` (`contracts.ts:78`, `adjudicate` at `:126`), and
publishes `HarvestSchema` (`:1003`) with `derived`, `claimed`, `discrepancies` and `facts_hash`.

`collectRunReport` (`collect.ts:147-289`) assembles the whole `RunReport` (`contracts.ts:1765`) —
schedule, merge pre-check, escape-watch, totals — and **degrades rather than throwing**
(`collect.ts:13-16`): "`report` is what an operator runs when things went WRONG". Its
`CollectedReport` carries three things the wire schema deliberately does not: `notes`, `attended`,
and `attendedUnverified` (`:68-115`) — the last being "the non-empty signal" that a run the ledger
says was touched has lost its record.

`renderRunReport` (`render.ts:27-140`) already fixes the reading order, and its reasons transfer to
a TUI unchanged: attended first (`:37-43`), security second (`:59-66`), totals third; a clean
pre-check must read "would merge cleanly … as of this check — **NOT merged**" (`:194-199`); a clean
escape-watch names the number of containers actually armed rather than saying "no attempts"
(`:118-132`).

| | Live | Historic | Refresh cost |
|---|---|---|---|
| `collectRunReport` | usable, but every number is provisional | **the right answer** | git `merge-tree` per (worker, branch) + a full harvest per task — **seconds, not milliseconds** |

### 2.6 Docker — the one source with no in-repo precedent

Finding D: nothing in `src/` runs `docker ps` or inspects a worker container. Everything the fleet
believes about liveness comes from `state.json` + `ps`.

Measured today, `docker ps` returned nine containers in well under a second: six workers named
`pifleet-<runId>-<workerId>` exactly as `workerContainerName` (`paths.ts:484`) constructs them, all
`Up 9 hours`, on `pifleet/pi-worker:0.79.6-base-…` and `…-node-…`; plus three
`pifleet-egress-relay-*` containers on `node:24-bookworm-slim`, one of them up 27 hours — i.e.
**outliving the runs it was created for**.

What each Docker call is worth, and what it costs:

| Call | Answers | Live/historic | Cost |
|---|---|---|---|
| `docker ps --format …` | does the container exist, and how long has it been up — **one call for the whole fleet** | live only | one process, one round trip to the daemon |
| `docker inspect <name>` | exit code, OOM kill, restart count, health | **live and briefly historic** (until `down`/reaper removes it — `down.ts:1507`, `reaper.ts:148`) | one process **per container** |
| `docker stats` | CPU/memory | live only | **`docker stats --no-stream` samples over a window per container by design; the streaming form never returns.** This is not a cheap call and §9 Q2 holds the measurement |

The name is the join key and it is derived, never spelled: `workerContainerName`'s docblock
(`paths.ts:469-483`) records that three of four call sites once used their own template literal and
that a rename would have produced "a `down` that cleans up a container nobody launched". A monitor
becomes the fifth caller and must use the function.

### 2.7 The source table

| Source | Live | Historic | Per-tick cost | Notes |
|---|---|---|---|---|
| runs-root listing | ✔ | ✔ | 7 ms / 114 entries | `run.json` filter is mandatory (Finding C) |
| `liveRunIds` | ✔ | — | **403 ms / 80 runs** | O(runs on disk); spawns `ps` |
| `state.json` | ✔ | ✔ | one read per worker | rewritten every 250 ms while live |
| `presentation.json`, `launch.json`, `run.json` | — | ✔ | one read, **cache forever** | immutable after `up` |
| `attended.json` | ✔ | ✔ | one read | written once, never removed |
| `fence.json` | ✔ | ✔ | one read | absent is normal |
| `tasks/*.json` | — | ✔ | `readdir` + read | terminal records only |
| `inbox/*.json` | — | ✔ | `readdir` + read | 13 in total on this host |
| `events.jsonl` | ✔ tail | ✔ whole | delta only / **up to 24.7 MB** | asymmetric by pane mode |
| `ledger/*.jsonl` | ✔ tail | ✔ merge | delta / whole-shard | `via` lives in unvalidated `detail` |
| `audit/*.jsonl` | ✔ tail | ✔ | delta | absence is normal (`paths.ts:568-572`) |
| `sessions/*.jsonl` | ✔ size/mtime | ✔ content | **stat only** for the monitor | the supervisor already parses these |
| outbox / harvest | — | ✔ | seconds | never re-derive; read what harvest published |
| `collectRunReport` | provisional | ✔ | seconds | git per branch |
| `docker ps` | ✔ | — | one process, fleet-wide | no in-repo precedent |
| `docker inspect` | ✔ | briefly | one process per container | |
| `docker stats` | ✔ | — | **unmeasured, believed expensive** | §9 Q2 |
| git in `watchDir` | ✔ | ✔ | two processes | the incumbent's own content |

---

### 2.9 Two throwing readers, found while probing Q5, that the monitor must catch per worker

Both were discovered by building the 500-run fixture and are **behaviour of existing code, not of
this design**. Neither is a defect — both are deliberate, and `src/safety/procstart.ts:248-262`
argues its case at length — but a monitor that assumes "returns null on absence" will die on a whole
frame where it should have degraded one row (ISC-475).

- **`readWorkerState` THROWS `StateReadError`, it does not return `null`, when `state.json` exists
  but fails schema validation** (`state.ts:806-855` via `readValidated`). `null` is reserved for
  *absent*. A synthetic state file missing required fields terminated the probe outright.
- **`processStartTime` THROWS `IdentityReadError` when `ps` writes to stderr** — a pid above the
  platform maximum produces `ps: process id too large`, which is a *failed read* rather than an
  absent process. `procstart.ts`'s own comment is explicit that absence requires a NORMAL exit,
  because "the conditions that break one `ps` are exactly the conditions that break the other" and
  concluding `gone` under that pressure is the outcome the guard exists to prevent.

**The consequence for this design is a requirement, not a note:** every per-worker read sits inside
its own try/catch and produces a `failed` region for that worker alone. This is what ISC-475 asserts
and it is now known to be reachable rather than hypothetical.

---

## 3. What is knowable, and what is not

### 3.1 Stuck versus busy — the prior art, and exactly where it runs out

This system has already been wrong about this once and wrote the lesson down.
`WorkerStateSchema.transcript_activity`'s docblock (`contracts.ts:343-380`) records it verbatim:

> "Observed on the operations console 2026-09-01 — the status pane said
> `tick-1: idle task=- supervisor=up` while that pane was visibly mid-turn, writing files, its
> transcript 300 KB and growing. Both fields were telling the truth: the worker held no pifleet
> task."

The repair was deliberately **not** a wider `phase`, and the reason is load-bearing for this design
too: "`phase` is read by `wait`, `report` and the ledger to decide whether an epoch finished.
Widening it so a typed-into pane reads `busy` would make every one of those consumers see a task
that does not exist."

`transcriptNote` (`status.ts:48-80`) then names **three** outcomes that must never collapse:

- `null` — **not measured** (an `rpc` worker, or a `tui` worker before its first poll);
- `"transcript no writes yet"` — measured, and the file has not grown since watching began;
- `"transcript 3s ago"` — measured, and moving.

**And a fourth exists that the code does not name, which is Finding A.** The transcript poll
(`supervisor/index.ts:1973-2290`) reaches `discoverSessionPath` and **returns** when no session file
is found, so `transcript_activity` is never written at all. Four of the six live workers today are in
exactly that state: `mode: "tui"`, `adopted_terminal: true`, attended for nine hours, `sessions/`
empty. They render as `null`, which `transcriptNote` renders as silence, which is the same silence
an `rpc` worker gets.

So the honest ladder a monitor can build, in descending strength:

| Signal | Proves | Fails when |
|---|---|---|
| `phase` + `task_id` + `fence.live` | an epoch is running | **always null for an attended worker** — `dispatch` allocates no epoch on that route (`voided.ts:136-140`, ISC-84) |
| `transcript_activity.last_growth_at` age | **the agent wrote something** | says nothing about a person typing (§3.2); absent entirely before the first assistant message (Finding A) |
| `sessions/*.jsonl` size + mtime, stat'd directly | the same fact, one layer lower, and **available before `transcript_activity` is** | the monitor would be computing a fact the supervisor owns — D9 |
| `events.jsonl` byte offset growth | *something* happened in the supervisor | for a `tui` worker that is `credential_injected` every 45 min and nothing else (§0.5) |
| `heartbeat_at` age | **the supervisor** is alive | says nothing about the worker |
| `docker ps` uptime | the container has not exited | a wedged Pi has a perfectly healthy container |

**No row of that table detects a stuck worker.** Each detects an absence, and the honest rendering
is an *age with its source named*, not a verdict. §6.2 and D9 turn on this.

### 3.2 Not knowable: whether a person is typing

`Docs/SRD-TUI-DISPATCH.md` §3.4 settles this and the argument is unchanged here: nothing in this
repository observes the pty, `transcript_activity` "detects the agent writing, not the person
typing", and "a person who has typed half a line has produced no transcript entry at all". A monitor
that rendered "idle 9h" beside a pane someone is actively working in would be wrong in the most
embarrassing possible direction, so the field must be labelled as what it measures.

### 3.3 Knowable and currently discarded: the container's own view

Finding D. `state.json` carries `container: {name, id, image}` (`contracts.ts:291-294`), captured at
construction rather than assigned later precisely so "a supervisor killed between its first flush and
a later assignment would leave a running container that nothing on disk names"
(`state.ts:641-648`). So the join key is durable **and the join has never been performed**. What it
would buy, concretely: today three `pifleet-egress-relay-*` containers are up, one for 27 hours,
and no pifleet surface mentions them.

### 3.4 Scale — 1 run versus 500 runs

Measured on this host, 2026-09-02: **114 run directories, 80 with `run.json`, 66 MB, 2,581 files,
83 `state.json`, 83 `events.jsonl` totalling 54.5 MB (largest 24.7 MB), 23 session transcripts
(3.1 MB), 413 ledger shards (292 KB), 13 inbox envelopes, 11 task records, 79 outbox directories.**

Two costs scale differently, and confusing them is how this gets designed wrong:

- **O(runs on disk).** `runIdsAscending` (114 stats, 7 ms) and `liveRunIds` (80 runs × reads +
  `ps` spawns, **403 ms**). At 500 runs the first is ~30 ms and the second is, by naive linear
  extension, ~2.5 s — **which would exceed the incumbent's own 5 s poll interval.** That
  extrapolation is not a finding; §9 Q5 states the probe.
- **O(live runs).** Six today. Reading six `state.json`, six `presentation.json` and six
  `attended.json` is well under a millisecond of real work.

**The consequence for the design is a specific one**: the expensive thing is *deciding which runs are
live*, and it is expensive for a reason the monitor can avoid — a long-lived process can keep the
answer and re-check it on a slow clock, where a stateless re-run of a command cannot. That is the
strongest single argument for D1.

A second consequence: **nothing prunes.** `down --prune` exists, and 34 of 114 directories are
already residue without a `run.json`. A monitor that shows a history list must decide what "the
history" is — §6.2 and D8.

### 3.5 Terminal constraints

The pane is one quadrant of a cmux workspace whose top row takes two thirds of the height
(`OPERATIONS_TOP_FRACTION = 2/3`, `operations-plan.ts:112`), so the monitor gets roughly the bottom
sixth of the window if it takes one of the two bottom cells, or the bottom third if it takes both
(D1). On a typical 1440p terminal at a normal font that is on the order of **80×10 for one cell,
160×10 across the row** — but this document has not measured the operator's actual geometry and §9
Q3 holds the probe rather than asserting a number.

Three constraints are certain rather than measured, and each is a design input:

- **The command is shell-injected into the pane, not exec'd** (`operations-plan.ts:51-54`), so every
  interpolated value goes through `shellQuote` and the monitor's invocation is a shell word list.
- **`pifleet` is not on `PATH`** (`operations-plan.ts:43-46`) — `package.json` is `private: true` and
  its `bin` is never linked, so the invocation is `bun run <abs path>/src/cli/index.ts`.
- **`clear` + full repaint reads as activity when there is none** (`operations-plan.ts:655-663`).
  Whatever the monitor does, it must not flash on an unchanged fleet.

### 3.6 What "WOW" has to mean, so it can be graded

The commission calls this an experiential requirement rather than decoration, so it needs a
falsifiable form. This document proposes three, all of which are checkable:

1. **The first screen answers §1.3's first two questions with no keystroke**, for every live run,
   including runs the operator forgot were live. Today six identical lines answer neither.
2. **Nothing on screen is stale without saying so.** §6.4.
3. **The density is at least an order of magnitude above the incumbent's.** The incumbent's status
   pane emits six lines carrying, between them, six worker ids and two distinct facts. The same
   vertical space can carry per-worker activity age, container uptime, attended state, spend, and a
   sparkline of transcript growth. If it cannot, the design has failed on its own terms and D16 is
   where to say so.

---

## 4. The principle this bumps into

### 4.1 A pane is a view, not a channel — and this *is* a pane

`Docs/SRD.md` §0.2 Decision 1 is the founding rule, and `README.md`'s second paragraph repeats it:
*"A pane is a view, not a channel… with one deliberate exception, which is the whole of
`pane_mode: tui`."* A read-only monitor does not approach that exception. It writes no byte to any
terminal but its own stdout, opens no control socket, and never reads pane text. §5.2 makes each of
those a non-goal by name rather than by omission.

### 4.2 Read-only has to be structural, not intentional — and there is a precedent

`src/cli/commands/logs.ts:1-13` is the model, and it should be copied rather than paraphrased:

> "READ-ONLY, structurally. This process runs inside a pane, and a pane is a view, never a channel
> (SRD §3.3)… It must not open the control socket, must not write anywhere under the run directory,
> and must not import anything that could — a viewer able to steer a worker turns the one surface
> that is NOT the control plane into the control plane. **The integration suite walks this file's
> source and its import list to keep that true** (same pattern as ISC-136), which is why the imports
> below stay minimal and static."

That last sentence is the whole control. An intention documented in a header decays; an import-list
walk fails a build. **The monitor must be held to the same standard, and this is the cheapest place
in the document to say so** — because the temptation to add "just an abort key" will arrive, and D15
is where it is refused in advance.

There is one honest complication D7 has to answer: `docker ps` is a *subprocess*, which `logs.ts`
never spawns. A guard that says "imports nothing that could write" does not cover a process spawn,
and `docker` is a binary that can trivially write. §8 D7 states the narrower guard that replaces it.

### 4.3 The argument that decides the refresh strategy: a viewer that lies is worse than one that admits

Suppose one clock. Pick 5 s, matching the incumbent. Then `liveRunIds` runs at 5 s, costs 403 ms
today and grows with runs on disk (§3.4), and every field on screen is up to 5 s old with nothing
saying which.

Now consider what the fields actually are. `heartbeat_at` moves every 250 ms
(`supervisor/index.ts:94`). `transcript_activity` moves at most every 500 ms
(`supervisor/tui.ts:237`). `presentation.json` never moves after `up`. `run.json` never moves.
`docker ps` moves when a container starts or stops, which on this host is roughly never — the six
current containers have been up nine hours. **One clock is wrong for all four**, and it is wrong in
the expensive direction for the immutable ones and the *slow* direction for the fast ones.

Three things make the single clock worse than it looks, and none is aesthetic:

1. **The cheap-and-fast fields are the ones that answer §1.3's first question.** Transcript age is
   the only stuck-detector there is (§3.1), and it is one `stat`. Pinning it to the same tick as an
   80-run walk means the answer to "is anything stuck" is delayed by the answer to "which runs
   exist", which changes hourly.
2. **A failed refresh is invisible under one clock.** If the walk throws — an unreadable
   `state.json`, `StateReadError` at `state.ts:786-804` — the naive loop shows the previous frame,
   unchanged, indistinguishable from a fleet that did not move. That is precisely the
   `harvest/layout.ts:19-24` shape again: a mechanism running over a failed input and publishing a
   clean result.
3. **The incumbent's own defence does not survive.** `redrawOnChange` compares text and repaints on
   difference, which works because the body is a pure function of the fleet. A monitor holding
   internal state has no such text to diff, so it must decide per region.

**So the design is three clocks and a stated age per region, and §6.3 specifies them.** The
alternative — one clock, tuned to the fastest field — was costed and rejected in D4: an 80-run
`liveRunIds` at 250 ms would consume a core and a half.

---

## 5. Scope and non-goals

### 5.1 In scope

- A single read-only TUI, invoked as a `pifleet` subcommand, that replaces the `fleet-status` and
  `git-watch` panes of the operations console (§6.1, D1, D12).
- A live view over every run the runs root holds a live worker for, and over its workers (§6.2).
- A historic view over a selected finished run: tasks, verdicts, spend, attended record, merge
  pre-check (§6.2, D10).
- The three-clock refresh ladder and per-region staleness (§6.3, §6.4, D4, D5).
- The `docker ps` join, on the slow clock only (§6.7, D7).
- The git strip that preserves what `git-watch` showed (§6.8, D12).
- Degradation under width and height, stated as behaviour rather than discovered (§6.5, D14).

**SCOPE CONFIRMED 2026-09-02 by the owner: all four views, no first slice.** The alternative put to
the owner was to ship views 1 and 2 — the live fleet row and the per-worker detail — and defer the
historic browser and the run-report view to a second branch. **That was declined, and the
consequence is recorded here rather than discovered at grading time:** the branch must carry view 4,
which calls `collectRunReport` (`collect.ts:147-289`) and runs `git merge-tree` per (worker, branch)
plus `harvestTask` per task. §2.5 calls that path "seconds, not milliseconds" **without having
measured it**, and Q7 is the probe. So the widest-scope answer also takes on the one open question
whose cost is entirely unbounded today. §6.3's slow clock and Q7's pre-warm answer are therefore
load-bearing for this scope in a way they would not have been for the two-view slice.

### 5.2 Non-goals

- **Dispatch, steer, abort, stage, unstage, down, harvest — any command that changes anything.**
  "Just a viewer to begin with." D15, and §6.2 says what the viewer must nonetheless *show* so that
  adding those later needs no redesign.
- **Opening the control socket, for any purpose, ever.** `logs.ts:1-13`, §4.2, D3.
- **Reading pane text or a pty.** `Docs/SRD.md` §0.2 Decision 1.
- **Re-deriving a verdict.** D10. The harvest owns adjudication (`contracts.ts:126`) and a second
  adjudicator is the two-spellings-of-one-fact hazard `harvest/layout.ts:89-108` records as ISC-345.
- **A `--json` mode.** D13 — `status --json`, `report --json` and `artifacts --json` are the machine
  surfaces and they already exist.
- **Giving the `development` console a status pane.** It deliberately has none
  (`scripts/development:22-25`). Nothing here should change that without the owner deciding to.
- **Pruning, archiving or deleting anything under the runs root.** Read-only means read-only, and
  `down --prune` owns reaping.
- **`docker stats`.** D7 and §9 Q2.

### 5.3 Deliberately deferred

- **A key that dispatches, aborts or steers.** Deferred rather than refused because the layout
  §6.2 specifies already reserves the selection model an action would need — a selected worker, a
  selected task. What is deferred is the *permission*, not the *shape*, and the shape is the
  expensive half.
- **Following a live transcript.** `pifleet transcript` and `logs --follow` exist and pane 1 already
  runs `logs --follow --render` (`operations-plan.ts:301`). Duplicating that inside the monitor is a
  second renderer of one fact.
- **Cross-run aggregate history** ("what has this fleet cost this week"). It needs a decision about
  what the runs root *is* — an archive or a scratch directory — and §3.4 shows nobody has made it.
- **Any use of `collectRunReport` on the fast clock.** Seconds-scale; §6.3 puts it behind an explicit
  key, and §9 Q7 asks what it actually costs on the largest run on disk.

---

## 6. The design

### 6.1 One pane, one process, one model of the fleet

The two bottom cells merge into one pane running one program. It replaces `operationsPanes`' entries
3 and 4 (`operations-plan.ts:441-465`) with a single entry whose `split` is `"down"` and whose
`command` is `envPreamble()` plus `pifleetCommand(repoRoot, ["monitor", "--watch-dir", watchDir])`.

**Why one process rather than two panes each running a TUI.** The expensive fact is *which runs are
live* (§3.4), and it is expensive once. Two processes would each pay 403 ms every tick to learn the
same thing, and they would learn it at different moments — so the two halves of the bottom row would
disagree about the fleet, which is the one thing `operations-plan.ts:645-649` already went out of
its way to prevent when it made both loops share a poll interval "so a `down` shows up in both at
the same moment rather than in whichever polls first".

**Why a `pifleet` subcommand rather than a script.** `scripts/operations` is I/O only; the decisions
live in `src/` where the unit suite can reach them (`operations-plan.ts:32-39`). A monitor
implemented as a script would be the one pane whose behaviour nothing pins.

**The cost, stated plainly: the bottom row stops being two independent things.** Today, a git loop
that wedges leaves the status loop running and vice versa; each is one process with `|| true`. One
program is one failure domain, and the mitigation is weaker than the property it replaces: the
monitor must catch per-region and render the region as failed (§6.4) rather than exiting. **A
monitor that crashes takes the whole bottom row with it**, and the pane's command must therefore
still end in a shell rung, exactly as pane 1's ladder does (`operations-plan.ts:302`).

### 6.2 The four views, ordered by §1.3's questions

**View 1 — FLEET (the default, and the only one that needs no keystroke).** One row per live worker
across all live runs, because the console is one run per attached pane (`status.ts:99-111`). Each
row carries, in this order:

`<worker> <run-suffix> │ <activity> │ <phase/epoch> │ <container> │ <attended> │ <spend>`

- **activity** is the §3.1 ladder, rendered as an age with its source named, never as a verdict:
  `wrote 4s ago` / `wrote 11m ago` / `no writes yet` / `no transcript` (Finding A's fourth state,
  which today renders as nothing) / `not measured (rpc)`. **`transcriptNote` (`status.ts:72-80`)
  already distinguishes three of the five and must be reused rather than re-derived**, extended by
  the two it does not name.
- **phase/epoch** is `phase` plus `task_id` plus `staged_task_id` (`status.ts:213-216` already
  prints the staged id with the word `staged`, for the reason its comment gives at `:190-212`).
- **container** is `Up 9h` from the `docker ps` join, or **`no container`** — which is a finding, not
  a blank, because a live supervisor whose container is gone is the most actionable single fact this
  monitor can produce and nothing in the fleet reports it today (§3.3).
- **attended** is `ATTENDED 9h` when `attended.json` has `left_at: null`, capitalised for the reason
  `render.ts:96-100` capitalises it: "a skimming reader must not be able to miss it".
- **spend** is `state.usage.input_tokens/output_tokens` and `turns`, against `budget.json`'s ceiling
  when there is one.

**View 2 — WORKER (one keystroke from a selected row).** The last N event rows, rendered through
`logs.ts`'s existing `sanitize`/`clip` rules (`logs.ts:39-56`), plus `state.json`'s counters,
`credential.degraded`, `exit {code, signal}`, and the worker's audit-trail tail. This is the "which
worker died and why" view for a **live** run, and it is explicitly a view of evidence in progress.

**View 3 — RUN HISTORY.** The runs root, newest first, from `runIdsAscending` (`paths.ts:937`) —
which is the **only** correct enumeration (Finding C). Each row: run id, age, worker count, live/
finished, task count from `inbox/`, settled count from `tasks/`. Today that list is 80 rows of which
6 are live and 11 tasks exist in total, so the honest default is D8's: **live runs are the view,
history is a mode you enter.**

**View 4 — RUN REPORT (explicit, expensive, and worth it).** `collectRunReport` for one selected
run, rendered in `renderRunReport`'s own order and with its own wording rules preserved: attended
first, escape-watch second, totals third, `"would merge cleanly … as of this check — NOT merged"`
verbatim (`render.ts:194-199`), `notes` and `attendedUnverified` inline rather than footnoted
(`render.ts:44-57`). **This is the "what did this run cost" answer and it is historic by nature.**

**What the viewer must be able to see so that adding actions later needs no redesign** — the
commission's third point, answered concretely. Three things, all of which are in views 1-4 already
and none of which is obvious:

1. **A stable selection.** A `(run, worker)` pair, and inside view 4 a `(run, task)` pair. Every
   later action is addressed to one of those two. A design whose rows are recomputed and re-sorted
   on every tick has no selection to attach an action to.
2. **The refusal surface.** A worker's `presentation.adopted_terminal` and `pane_mode` decide
   whether `dispatch` would refuse it, stage it, or type into it (`dispatch.ts:224`'s
   `via: "rpc" | "pane" | "staged"`). Showing that *now*, as a property of the row, means a later
   action button has somewhere to be greyed out and a reason to give.
3. **The fence.** `fence.json`'s `live` and `attempts` decide whether an action would be refused
   `busy` or replayed. A viewer that reads it is a viewer an action can be added to; one that does
   not would have to learn the whole epoch model on the day someone adds a key.

### 6.3 Three clocks

| Clock | Period | Reads | Why |
|---|---|---|---|
| **Fast** | 500 ms | `state.json` and `fence.json` for the **already-known** live workers; `stat` on their session files | matches the supervisor's own transcript poll (`tui.ts:237`); everything here is a handful of small reads |
| **Medium** | 5 s | `attended.json`, ledger tail, event-log tail (delta only), `registry.json` | matches the incumbent's interval, so nothing gets slower than it is today |
| **Slow** | 30 s | `runIdsAscending` + `liveRunIds` (the 403 ms walk), `docker ps`, git in `watchDir` | O(runs on disk); a run appearing or ending is a 30 s-scale event, and at 500 runs (§3.4) this is the only clock that can absorb it |

**The one thing that breaks this, and how it is handled.** A run started *between* slow ticks is
invisible for up to 30 s. That is worse than the incumbent, which would find it within 5 s.
`up` writes `run.json` into a directory it creates under a root the monitor already knows, so the
mitigation is a cheap `readdir` of the runs root on the **medium** clock — 7 ms measured for 114
entries — comparing only the *name set*, and promoting a slow tick when it changes. That keeps the
expensive walk on the slow clock while making appearance a 5 s event. It does not make
*disappearance* a 5 s event, and §9 Q6 holds whether that matters.

`collectRunReport` is on **no clock**. It runs when the operator asks for view 4, and view 4 shows a
spinner and then a timestamp, because it is a seconds-scale operation (§2.5).

### 6.4 Staleness is displayed, never hidden

Every region carries an age, and a region whose last refresh **failed** says so in place of its
content rather than showing the previous value. This is §4.3's argument made concrete, and it is the
one place where this design is deliberately noisier than the incumbent.

Three renderings, which must not collapse:

- `as of 2s` — refreshed, current.
- `as of 47s — refresh failed: unreadable state file …` — the last value is on screen and is known
  to be old. `StateReadError` (`state.ts:786-804`) already carries a diagnosable message and the
  bytes; it must be shown, not swallowed.
- `no data` — never refreshed successfully at all. Distinct from "refreshed and empty", for exactly
  the reason `transcriptNote` keeps `null` and `"no writes yet"` apart.

**The cost: screen real estate.** An age per region on an 80-column pane is expensive, and §6.5's
degradation ladder drops the ages **last**, not first — because a compressed monitor that has
stopped saying how old it is has become the thing §4.3 argues against.

### 6.5 Degradation, stated as behaviour

In descending width, the FLEET row drops in this order: spend → container uptime → run-id suffix →
phase/epoch. **Activity age and the staleness marker are never dropped**, because between them they
are the entire answer to §1.3's first question.

In descending height: the git strip collapses to one line, then the history hint disappears, then
rows scroll rather than fitting.

Below a floor, the monitor **refuses with a sentence naming the required size** rather than
rendering something misleading. A refusal an operator can act on beats a layout that silently
truncates the row that mattered — the same choice `RunDirMountError` (`paths.ts:755-791`) makes when
it names the offending path and the remedy. §9 Q3 is the probe that sets the floor; this document
does not invent a number.

### 6.6 The toolkit

`package.json` carries **three** runtime dependencies — `commander ^14.0.2`, `zod ^4.1.13`,
`yaml ^2.8.1` (`package.json:21-25`) — and two dev ones. All three are data-shaped: an argument
parser, a validator, a serialiser. There is no rendering dependency of any kind in this repository.

Options surveyed:

| Option | What it buys | What it costs |
|---|---|---|
| **Hand-rolled ANSI over Bun's own stdout** | zero dependencies; total control of the repaint; `logs.ts`'s existing sanitiser applies unchanged; testable as a pure `(model) => string[]` function with no terminal | cursor addressing, a resize handler, and a diff-based repainter are all code someone must write and maintain — perhaps 300-500 lines |
| **Ink** (React for terminals) | a real layout engine, flexbox, mature; **and `lastFrame()` returns a plain string, so the byte-exact line-array assertion this repository uses everywhere survives unchanged** (measured, §6.6.1) | pulls React and a reconciler into a repo whose entire dependency set is three data libraries; **rewrites the full frame including unchanged rows on every update** (measured, §6.6.1); and the npm registry is unreachable from the operator's host under the corporate middlebox, making the install a deliberate off-network act rather than a `bun add` |
| **blessed / neo-blessed** | widgets, a screen diffing engine | unmaintained; large; the widget model wants to own the event loop, which fights a three-clock design |
| **A Bun-native TUI kit adopted unassessed** | Bun-first ergonomics | unassessed *here*, and this repository's dependency posture makes an unassessed dependency the expensive option rather than the cheap one |

**DECIDED 2026-09-02 by the owner: Ink.** This document recommended hand-rolled ANSI and the owner
chose otherwise, so the recommendation is recorded here as superseded rather than quietly edited
away — the reasoning that produced it is still the reasoning a future reader needs in order to
judge whether the choice should be revisited.

**The recommendation rested on a claim that is false, and the probe below is the refutation.** The
argument was: this repository verifies behaviour by calling pure functions with no environment
(`operations-plan.ts:32-39` — "Every function here is PURE… the flag IS the behaviour, so the flags
have to be pinnable byte-for-byte by a unit test with no cmux running"), *"a renderer that returns
lines is pinnable by exactly that kind of test; a component tree is not."* The last four words are
wrong, and that was the load-bearing half of the recommendation.

### 6.6.1 The two measurements that settled the toolkit

Both were run on the operator's host on 2026-09-02, against `ink@7.1.1` / `react@19.2.8` on
`bun 1.3.11`.

**Measurement 1 — byte-exact pinning SURVIVES. The rejection ground is refuted.**
`ink-testing-library`'s `lastFrame()` returns a plain `string`, not a tree, so the assertion form
this repository already uses works verbatim:

```ts
expect((lastFrame() ?? "").split("\n")).toEqual([
  "run 2026-09-02T14-43-27Z-3906",
  "eng-1   idle",
]);                                                    // passes
```

There is therefore **no testability cost** to Ink, and §6.4's requirement that the renderer be a
pure function of the model is unaffected: the component tree is the pure function, and the frame is
its return value. A `(model) => string[]` seam is still specified — `renderFleet(model)` returns
`lastFrame().split("\n")` — so every assertion in this design is written against lines, and Ink is
an implementation detail behind that seam rather than a shape the tests have to know about.

**Measurement 2 — the full-frame repaint is REAL, and it is the cost this decision accepts.** An
Ink app whose fourth row changed on a 30 ms timer wrote all four rows on every update; the three
static rows appeared in every captured write. So the "repaint everything" objection stands as
stated.

**What that costs is nonetheless smaller than `operations-plan.ts:655-663` measured, and the
difference is mechanical rather than a matter of degree.** The incumbent's flash came from
`clear; <command>; sleep` — the screen goes blank, a subprocess runs for tens of milliseconds, and
output arrives after it. There is a real window in which the pane is empty. Ink has no subprocess
and no blank window: it emits one atomic `write()` that overwrites the frame in place. Whether that
still flashes visibly inside a cmux pane is **not established by either measurement**, and it is
filed as **Q10** rather than assumed either way — the incumbent's own history is the precedent for
measuring this instead of reasoning about it.

**The dependency cost is accepted openly.** `package.json` goes from three runtime dependencies to
five, and the two added are not data-shaped — `react` and `ink` bring a reconciler and a layout
engine. Two facts bound the blast radius, both checked rather than assumed:

- **The worker image never sees them.** `docker/Dockerfile` installs `bun` and Pi globally via
  `npm install -g` and never runs `bun install` against this `package.json`. The monitor is a host
  process in a cmux pane, so nothing about the container plane changes.
- **CI installs them normally.** Every workflow job runs `bun install --frozen-lockfile` on GitHub
  Actions, which has no corporate middlebox in front of the registry.

**The install itself is the one operational cost with no workaround.** `registry.npmjs.org` accepts
the TCP connection from the operator's host and then resets the TLS client hello — an SNI-based
policy block by the endpoint security extension, not a routing failure. `bun add ink react` fails
with `ConnectionClosed`, and an offline install from the bun cache fails too because Ink's
transitive tree (`react-reconciler`, `cli-truncate`, `terminal-size`, `patch-console` and four more)
is not cached. The dependencies were therefore added in a deliberate off-network act and are pinned
in `bun.lock`; **every install after that resolves from the lockfile and the local cache, so this is
a one-time cost and not a standing requirement.** It is recorded because a future contributor on the
same network who deletes `node_modules` will hit it and should not have to rediscover the cause.

### 6.7 The Docker plane

One `docker ps --format '{{.Names}}\t{{.Status}}'` per **slow** tick, parsed by exact name match
against `workerContainerName(runId, workerId)` (`paths.ts:484`), which the monitor **calls** rather
than spells (§2.6).

Three refusals come with it:

- **No `docker inspect` per container on any clock.** One process per container per tick, for six
  containers, to learn something the `ps` line mostly already carries.
- **No `docker stats`, in either form.** §9 Q2 says why the cost is unknown, and an unknown cost on
  a standing pane is the wrong kind of unknown.
- **A failed `docker ps` is a region-level failure, not a crash.** The Docker daemon not running is
  an ordinary state on a laptop, and the column renders `docker unavailable` — which is itself
  information, since it means every container in the fleet is gone.

**The cost: one subprocess spawn every 30 s from a process whose whole security argument is that it
does nothing.** D7 is where that is argued, and §4.2 is why it needs arguing.

### 6.8 What replaces the git pane

Everything `git-watch` showed, in a strip rather than a pane, and the replacement must not lose:

- the **branch line** (`git status --short --branch` — the `--branch` flag is the point);
- the **short status** — dirty paths, which is what makes the pane worth glancing at;
- the **last 10 commits, one line each**;
- the **directory it is watching** — `watchDir`, not the repo root (`scripts/operations:66`);
- **`--no-pager`**, without which the whole thing hangs at `(END)` (`operations-plan.ts:697-703`);
- refresh no slower than the incumbent's 5 s for the *status* half.

**The compression, REVISED 2026-09-02 by the owner (Q8): status first, commits behind a keystroke.**
The strip's default shows the branch line and the **full short status** — every dirty path, not a
truncated list — and the commit list collapses to nothing but a `[c] commits` affordance that
expands it to full height.

```
┌ git ─────────────────────────────┐
│ ## main...origin/main [ahead 1]  │
│  M src/config/render.ts          │
│  M src/run/dispatch-policy.ts    │
│ ?? Docs/SRD-FLEET-MONITOR.md     │
│                                  │
│ [c] commits                      │
└──────────────────────────────────┘
```

**This reverses what this document originally proposed, and the reasoning is the owner's own answer
to Q8: dirty paths change and a commit list on an idle branch does not.** A strip that is read at a
glance should spend its rows on the half that moves. The commit list is not *lost* — D12's "kept in
full and compressed by default" still holds — but it is now the half behind the keystroke.

**The loss this incurs is smaller than the one it replaces, and it should still be named.** Ten
commits at a glance becomes zero at a glance. The reader who wants branch context now pays a
keypress for it, where previously the reader who wanted the full dirty list did. **Which of those
two readers is the common one is the whole content of Q8, and it was settled by asking the operator
rather than by reasoning** — this document had reasoned its way to the opposite answer.

---

## 7. What this costs

### 7.1 Unchanged

`Docs/SRD.md` §0.2 Decision 1. The `tui` exception, neither widened nor narrowed. Every voided-table
row (`voided.ts:61-176`). `pifleet status` and its `--watch`, `--all` and `--json` flags. `logs`,
`report`, `artifacts`, `wait`. `scripts/operations`' `--poll` flag and its default. Pane 1 and pane 2
of the operations console. The `development` console.

### 7.2 What the replacement loses, in both directions

| Property the incumbent has | After |
|---|---|
| Two independent failure domains in the bottom row | **One.** §6.1 — mitigated by per-region catching and a shell rung, both weaker than process isolation |
| `redrawOnChange`'s exact no-flash guarantee, which is a property of comparing two strings | **A per-region diff**, which is a property of code rather than of shell. It can regress in a way the shell version could not |
| Ten commits visible at a glance | **None by default**, behind `[c]`. The full short status takes the rows instead. D12, revised by Q8 |
| The whole git pane's output is a pure function of the repo, so it cannot be stale in a hidden way | **A long-lived model**, which can be stale — hence §6.4 exists at all |
| `pifleet status --all`'s exact text, which scripts may be reading off a pane | Nothing changes for scripts (`status --json` is untouched), but a human who has memorised the six-word line has to re-learn |
| Zero subprocess spawns other than the two commands | **One `docker ps` per 30 s**, plus git. D7 |

### 7.3 What a monitor cannot see, and must not imply it can

- **Whether a person is typing** (§3.2). The strongest available signal detects the *agent*.
- **Whether a `tui` worker's turn is progressing.** No epoch is allocated (`voided.ts:136-140`), so
  `phase` is permanently `idle` and true.
- **Whether the agent is stuck or thinking.** A 40-minute gap in transcript growth is a fact; what
  it means is not one.
- **What a person did in an attended pane.** `voided.ts:88-93` (ISC-106/107) records that their
  `gcloud`/`kubectl` calls "land in the ledger in the agent's row shape with no author and no task
  id". The monitor can show the audit rows; it cannot attribute them.
- **Anything about a container that has been removed.** `down` and the reaper `docker rm -f`
  (`down.ts:1507`, `reaper.ts:148`), and the container's exit detail goes with it. The durable
  record is `state.exit` (`contracts.ts:405-407`), which distinguishes SIGKILL from a clean exit
  because "Pi exits 0 in every case".

---

## 8. Decisions

Each entry states what was chosen, what was rejected, and what it costs. **Five are put to the owner
as genuinely open: D2, D6, D7, D13 and D16.**

| # | Decision | Specified in |
|---|---|---|
| **D1** | One pane, one process, one model of the fleet — replacing both watchers | §6.1 |
| **D2** | **DECIDED 2026-09-02 (owner) — Ink**, behind a `(model) => string[]` seam. Supersedes this document's own recommendation of hand-rolled ANSI, whose stated ground (component trees are not byte-pinnable) was measured false | §6.6, §6.6.1 |
| **D3** | Read-only is enforced structurally, by the `logs.ts` import-walk precedent | §4.2 |
| **D4** | Three clocks — 500 ms / 5 s / 30 s — not one refresh interval | §6.3 |
| **D5** | Every region states its age; a failed refresh replaces content with the reason | §6.4 |
| **D6** | **OPEN** — the monitor reads the run tree itself and does not shell out to `pifleet status` | below |
| **D7** | **OPEN** — `docker ps` on the slow clock only; `docker inspect` and `docker stats` refused | §6.7 |
| **D8** | Live runs are the default view; history is a mode you enter | below |
| **D9** | Activity is five named states, never collapsed into "busy" or "idle" | §3.1, §6.2 |
| **D10** | The monitor never adjudicates; it reads what the harvest computed | §2.5, §5.2 |
| **D11** | The event log is tailed from the end and never parsed whole on a clock | §2.4 |
| **D12** | **REVISED 2026-09-02 (owner, Q8) — status first; commits behind `[c]`.** The git content is still kept in full and compressed by default; which half is compressed is reversed | §6.8 |
| **D13** | **OPEN** — no `--json` mode | §5.2 |
| **D14** | Below a floor, the monitor refuses with a sentence rather than truncating | §6.5 |
| **D15** | No control socket, no pane text, no action of any kind | §5.2 |
| **D16** | **OPEN** — "WOW" is graded against three falsifiable properties | §3.6 |

### The five that need no argument

**D1 — one pane, one process.**
**Chosen: one program across the merged bottom row. Rejected: two TUIs; rejected: one TUI beside the
surviving git loop.**
The expensive fact is which runs are live, it is expensive once (§3.4), and two processes would pay
for it twice and disagree about the answer — the exact disagreement `operations-plan.ts:645-649`
already shares a poll interval to prevent. **The cost: the bottom row becomes one failure domain.**
§7.2.

**D3 — structural read-only.**
**Chosen: the `logs.ts` guard, copied including its enforcement. Rejected: a header comment stating
the intention.**
`logs.ts:1-13` states the rule and names the guard that keeps it: an integration suite that walks the
source and its import list. Copying the rule without copying the guard is how the rule decays.
**The cost: the import list stays deliberately minimal and static, which will at some point be
inconvenient** — and being inconvenient at that moment is the whole value.

**D9 — five named activity states.**
**Chosen: five states, none collapsing. Rejected: a two-state busy/idle; rejected: a single "last
seen" age with no source.**
`transcriptNote` (`status.ts:48-80`) already argues that three of them must never collapse, and
Finding A adds a fourth the code does not name. The fifth is `docker`'s "no container", which nothing
reports today. **The cost: five states is more than a column wants, and §6.5's degradation ladder has
to protect it.**

**D11 — tail, never parse whole.**
**Chosen: `TailReader` from the end. Rejected: reading the log per tick to compute counts.**
24.7 MB in one file, measured. `TailReader` already exists and `logs.ts:287` already wraps it in a
`pollSafe` that survives an oversized line. **The cost: the monitor cannot answer questions about the
*beginning* of a long run without an explicit, slow action** — which is correct, because that is a
historic question and view 4 is where it belongs.

**D14 — refuse below a floor.**
**Chosen: a refusal naming the required size. Rejected: reflowing into an unreadable frame.**
The same choice `RunDirMountError` makes: name the problem and the remedy rather than proceed into
something misleading. **The cost: an operator with a short pane gets nothing instead of something**,
and if the floor is set too high that is a regression against a status pane that at least printed six
lines. §9 Q3 sets it by measurement, not by guess.

### D2 — Ink, behind a `(model) => string[]` seam

**DECIDED 2026-09-02 by the owner: Ink. Rejected: hand-rolled ANSI (this document's own
recommendation); rejected: blessed; rejected: a Bun-native TUI kit adopted unassessed.**

**The recommendation this supersedes, stated fairly before it is set aside.** The argument was never
"fewer dependencies is better". It was that this repository's entire verification posture is pure
functions pinned byte-for-byte by tests that need no environment (`operations-plan.ts:32-39`), and
that a renderer returning `string[]` fits that posture while *"a component tree does not"*. A second
argument ran alongside it: §6.5's degradation ladder is a stated requirement whose ordering must be
asserted, and "spend drops before activity age at 72 columns" is trivial against a line array and
awkward against a reconciler.

**The first argument was measured and is false** (§6.6.1). `lastFrame()` returns a string, so the
ladder assertion is written against `frame.split("\n")` exactly as it would have been against a
hand-rolled renderer. The second argument dissolves with the first — both rested on the same
mistaken premise about what an Ink test can assert. Recording this plainly matters more than
recording the outcome: **the document was wrong about the thing it was most confident about, and a
reader weighing a future toolkit change should know the recommendation fell to a fifteen-line probe
rather than to a preference.**

**What the decision costs, none of it hypothetical.** Two runtime dependencies that are not
data-shaped, a full-frame repaint on every update (measured, and unlike the incumbent's `clear`
there is no blank window — whether it flashes in a real pane is **Q10**), and a one-time
off-network install because the corporate middlebox resets the registry's TLS handshake. §6.6.1
carries the measurements and the blast-radius checks: the worker image never installs these, and CI
installs them normally.

**The seam that makes this reversible, and it is the reason the decision is cheap to unwind.**
Every view exposes `render<View>(model): string[]`, and every test asserts against that array. Ink
lives behind it. Swapping to a hand-rolled renderer later means reimplementing those functions and
changing no test — so the 300-500 lines this decision avoids today remain avoidable-or-payable
later, at the cost of writing them then rather than now.

**One thing that is not an argument for either side, recorded so it is not mistaken for one:**
`logs.ts`'s sanitiser (`:39-56`) applies unchanged under any toolkit, because it operates on strings
before they reach a renderer.

### D6 — read the run tree, do not shell out to `pifleet status`

**OPEN. Recommended: read directly. Rejected: `bun run src/cli/index.ts status --all --json` on a
loop, parsed.**

The rejected option is genuinely attractive: it is what the incumbent does, it reuses a maintained
JSON contract, and it inherits `status`'s own degradations for free. Three arguments against, in
descending force:

1. **It costs 403 ms and a process spawn per tick, measured, and the cost is O(runs on disk).**
   §3.4. A long-lived process can keep the live set and re-check it on the slow clock; a subprocess
   cannot keep anything.
2. **`status --json` does not carry what views 1 and 2 need.** It carries `phase`, `task_id`,
   `epoch`, `completed_epochs`, `pid`, `pgid`, `session_path`, `session_present`, `heartbeat_at`,
   `transcript_activity` and `staged_task_id` (`status.ts:148-176`) — and **not** the attended
   record, the fence, the usage counters, the credential health, the exit detail or the container
   name. Widening `status --json` to carry them would change a JSON contract that "every existing
   caller parses" (`status.ts:193-196`), for the benefit of one new caller.
3. **A monitor that parses another command's output has two failure modes for every one fact** —
   the fact being wrong, and the parse being wrong — and the second is silent.

**What choosing this costs:** the monitor becomes a **second reader** of `state.json`,
`presentation.json` and `attended.json`, and `run/paths.ts`'s opening rule
(`paths.ts:1-18`: "a path computed in two places will eventually be computed differently in two
places") is precisely the hazard. **The mitigation is mandatory rather than advisory: every path the
monitor touches comes from `runPaths`/`workerPaths`, and every document it reads goes through the
existing `readWorkerState`/`readPresentation`/`readAttended`/`readFence` readers in
`src/run/state.ts` and `src/attended/mode.ts`.** It must not open a file by joining a string, and it
must not `JSON.parse` a control-plane document itself. If that constraint cannot be met, D6 should
be reversed.

### D7 — `docker ps` on the slow clock; `inspect` and `stats` refused

**OPEN. Recommended: yes, and it is the decision most likely to be wrong.**

`docker ps` answers a question nothing in this fleet answers today (§3.3, Finding D), and the most
actionable single row the monitor can produce — *a live supervisor whose container is gone* — needs
it. One call, fleet-wide, every 30 s.

**Against it, and the argument deserves to be taken seriously:** §4.2's read-only guard is an
import-list walk, and a subprocess spawn walks straight past it. `docker` is a binary with the
authority to delete every container on the host, and a viewer that can spawn it is a viewer one
`argv` edit away from being something else. The narrower guard that replaces the import walk:
**the monitor constructs Docker argv in exactly one function, that function returns a frozen
`["docker","ps","--format",…]` and takes no caller input, and a test asserts the whole argv
byte-for-byte.** That is the same shape `container/interrupt.ts:134` and `security/relay.ts:1978`
already use, and the same shape §6.7's name-join uses: *containment by construction rather than by
validation*, which is the argument `paths.ts:376-395` makes at length about export paths.

**The cost: a viewer that spawns a process is no longer trivially read-only, and the guard protecting
that is now a test rather than an import graph.** If the owner is not comfortable with that trade,
the Docker column goes and §6.2's `no container` row goes with it — which loses the single most
actionable fact in the design.

### D8 — live is the view; history is a mode

**Chosen: the default view is live runs only. Rejected: one scrolling list of all runs, newest
first; rejected: a configurable window ("last 20 runs").**

Measured: 80 real runs, 6 live, 11 tasks ever settled (§3.4). A default list of 80 rows of which 74
are finished puts the six that matter above the fold only by accident of sort order, and the
incumbent's `--all` already made the correct choice for the correct reason (`status.ts:99-111`).

**Rejected the configurable window specifically** because a number in a config is a decision nobody
makes: it defaults to something, the default is wrong for someone, and the pane silently omits a run.
A mode has a name and the operator knows which one they are in.

**The cost: a run that ended thirty seconds ago vanishes from the default view**, and "what just
happened to the run I was watching" becomes a keystroke rather than a glance. The mitigation is
weak — a `recently finished` band at the bottom of view 1 — and it is a mitigation, not a fix.

### D10 — never adjudicate

**Chosen: read the harvest's verdict. Rejected: compute a fast approximation for live tasks.**

The approximation is tempting because view 1 wants a colour per task and `harvestTask` is
seconds-scale. It is refused for the reason `harvest/layout.ts:89-108` states as ISC-345's finding:
"two readers of one fact, written independently, is how a value-reader goes blind while its sibling
keeps working". A monitor showing green where `artifacts` says `partial` is worse than a monitor
showing nothing, because it is *believed*.

**The cost: a live task has no verdict on screen until something settles it**, and the honest
rendering of that is `running` plus an age — which is exactly what §1.3 says a live answer is.

### D12 — keep the git content, compress it

**Chosen: preserve all four elements (branch, short status, ten commits, watched directory) and
compress by default with a key to expand. Rejected: dropping the commit list; rejected: keeping the
git pane separate.**

Dropping is refused on the commission's own terms — "a replacement that drops something the
incumbent showed is a regression however good the rest is". Keeping it separate is refused by D1.

**The cost: three commits instead of ten, by default, in the same glance.** That is a real loss and
the keystroke is a real mitigation only for someone who knows the key exists. §9 Q8 asks whether the
strip should default to the status half only and expand to commits, which is the opposite trade and
may be the better one.

### D13 — no `--json`

**OPEN. Recommended: no. Rejected recommendation: publish the monitor's model as a fourth JSON
surface.**

`status --json` (`status.ts:192-198`), `report --json` and `artifacts --json` are the machine
surfaces, and they are contracts with existing callers. A fourth JSON shape describing the same run
is a fourth thing to keep in agreement, and the monitor's model is a *presentation* model — it holds
ages, selections and staleness, none of which is a fact about the run.

**Rejected the obvious counter — "a monitor's model is the most complete view, so publish it":** the
completeness is the problem. Publishing it makes every field in §6.2 a contract, including the five
activity states, which §3.1 shows are the most likely thing in this design to need revision.

**The cost: someone will want it, and the answer is "compose the three existing JSON surfaces",
which is more work for them than a flag would have been.**

### D16 — WOW is graded

**OPEN. Recommended: adopt §3.6's three properties as criteria. Rejected: leaving it unstated and
judging the result by eye.**

The commission says WOW is a requirement and not decoration, and a requirement that cannot fail is
not one. §3.6 proposes three falsifiable properties: no-keystroke answers to the first two questions,
nothing stale without saying so, and an order-of-magnitude density increase over the incumbent.

The rejected alternative is how the incumbent's status pane came to exist — it satisfied "show the
fleet status" completely, and answered no question anyone had.

**The cost, and it is real: the third property is a number and the number is arguable.** "An order
of magnitude" is a rhetorical figure, not a measurement, and if the owner wants it graded it needs
to become something like "at least eight distinct facts per worker row against the incumbent's two".
That is a worse sentence and a better criterion, and §9 Q9 is where the choice sits.

---

## 9. Open questions

**Q1 and Q3 block the design as specified; the rest do not.** Q1 decides whether the monitor's
central column can exist at all for the workers the console actually shows, and Q3 decides whether
the pane it must live in is big enough. Q5 does not block the shape but decides whether the design
survives the operator's own disk in six months. **Q8 is closed** (answered by the owner 2026-09-02);
**Q10 is new**, opened by the toolkit decision in D2 and inheriting the one risk that decision
knowingly took on.

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | **PARTLY ANSWERED 2026-09-02, before implementation, by reading the run tree rather than `state.json`.** The question splits in two and the halves have different answers. **(a) Can a `tui` worker that has never spoken be distinguished from an `rpc` worker? YES — measured.** Three fields carry it and none is in `state.json`: `presentation.adopted_terminal` is `true` for an attended worker and absent-or-`false` otherwise, `attended.json` exists with `mode: "tui"`, and `state.json`'s own `session_present` is `false`. Across the operator's runs root, 6 live attended workers and 21 non-adopted workers separate cleanly on these. **This is D6 earning its cost**: `pifleet status` cannot make the distinction because it never reads `presentation.json` or `attended.json`, and a monitor that reads the tree directly can. **The fifth activity state is therefore renderable from data that already exists, and no new field is required.** **(b) Can a worker that has never spoken be distinguished from one that is wedged? NO, and this is expected to remain no** — the honest rendering is `no transcript` meaning "has never spoken", never "is stuck". **One edge case the fixtures must carry:** a worker was found with `attended.json` present and `mode: "tui"` but `adopted_terminal` absent, so neither field alone is a sufficient discriminator and the reader must consider both. **What remains open is only the timing half:** Finding A: four of six live workers have an empty `sessions/` directory and `transcript_activity: null` after nine hours. `discoverSessionPath` (`supervisor/tui.ts:176`) suffix-matches `_<worker-id>.jsonl`, and the poll returns before writing the field when nothing matches. The expectation is that the honest answer is **no** — the worker has genuinely never spoken, and the correct rendering is a fifth state (`no transcript`) rather than a guess. **The expectation is not a finding.** | **DECIDED 2026-09-02 by the owner: a throwaway worker in a scratch run, NOT the live console panes.** Stand up a short-lived `pane_mode: tui` worker in its own run under a scratch `PIFLEET_RUNS_DIR`, snapshot `sessions/` and `state.json` before it has spoken, make it speak once, and watch whether `sessions/` gains a file and `transcript_activity` becomes non-null within one `TUI_POLL_MS`. Then check whether anything on disk distinguished the "before" state from an `rpc` worker's. **The rejected probe — typing into one of `eng-1`/`eng-2`/`tst-1`/`rev-1` — is more faithful and was refused on cost: it spends real inference on the operator's running fleet and writes a message into a live worker's transcript that the operator did not author.** The scratch run answers the same question about the same code path. | **§6.2's activity column and D9's fifth state.** If something does distinguish them, D9 gains a sixth state and the column is stronger. If nothing does, §6.2 must render `no transcript` and say plainly that it means "has never spoken", not "is stuck". |
| **Q2** | **ANSWERED 2026-09-02: the belief was RIGHT. `docker stats --no-stream` costs 2042 ms mean against 9 containers; `docker ps` costs 37 ms. 55×.** D7's refusal stands unnarrowed, and a CPU/memory column is not possible on any clock this design has. **A false result was produced first and is recorded because the mistake is instructive:** an initial timing loop reported 46 ms — *faster* than `docker ps` — because it timed a `docker stats` invocation that was failing immediately with stderr discarded. The corrected probe used an argv list with no shell and checked the exit. **A probe that measures a failing command reports the answer you hoped for**, which is the same failure shape as `less` at `(END)` looking like a working pane. ~~Original question:~~ **What does `docker stats --no-stream` actually cost against six containers?** §6.7 refuses it on a believed cost. The belief is that the non-streaming form still samples over a window per container and therefore takes on the order of a second regardless of container count. | Time `docker stats --no-stream` against the six live workers, ten times, and compare against `docker ps`. | **Only whether a CPU/memory column is possible at all.** Nothing else in the design depends on it. If it is cheap, it belongs on the slow clock and D7's refusal narrows to the streaming form. |
| **Q3** | **What is the actual pane geometry, and what becomes unreadable first?** §3.5 reasons from `OPERATIONS_TOP_FRACTION = 2/3` to "roughly 80×10", and that is arithmetic on an unmeasured window size. | Open the operations console, run `stty size` in the bottom-left pane, then again after merging the bottom row into one pane, and shrink the terminal until the fleet row loses its activity column. | **§6.5's degradation order and D14's floor.** Both are currently stated as orderings with no numbers, which is exactly the shape that gets discovered at grading time. |
| **Q4** | **STILL OPEN, and NO LONGER BLOCKING as of 2026-09-03 (ISC-497).** One probe was attempted and was INCONCLUSIVE rather than negative: a program started through cmux `--command` injection in a throwaway window recorded zero signals, but `stty` showed its pty never actually changed size, so zero measured nothing. **The design stopped needing the answer instead.** The monitor now re-reads `process.stdout.columns` on every paint, so the frame follows the pane whichever way Q4 lands; the `resize` listener is kept as an optimisation that removes the up-to-one-interval lag, not as the mechanism. This row called polling "a different and worse design", and that holds only when polling is ADDED to a loop that lacks one — this loop already repaints on an interval. A design that needed Q4's answer would carry a dependency on a terminal's behaviour, which is exactly what ISC-491 avoids. ~~Original question:~~ **Does a program started by cmux's shell injection receive `SIGWINCH`?** `--command` text is typed into the pane's shell (`operations-plan.ts:51-54`), so the monitor is a foreground job of that shell rather than a process cmux spawned directly. The expectation is yes — that is ordinary job control — but this repository has been wrong before about what a pane delivers, and §1.1's `less`-at-`(END)` finding is the precedent for measuring rather than assuming. | Start the monitor in an operations pane, resize the cmux window, and see whether it repaints at the new size. | **D2's resize handling.** If no signal arrives, the renderer must poll `process.stdout.columns`, which is a different and worse design. |
| **Q5** | **ANSWERED 2026-09-02, and the extrapolation was close but its stated reason was only half right.** Measured: **80 real runs → `liveRunIds` 331 ms; 500 synthetic runs → 1777 ms** (the document predicted ~2.5 s). Cost is linear at ~3.6-4.1 ms per run. **The dominant term is the per-worker `ps` spawn inside `processStartTime`, NOT directory enumeration:** `runIdsAscending` is 3 ms at 80 runs and **9 ms at 500**, i.e. 0.5% of the total. **This makes §6.3's sketched mitigation correct and cheap rather than speculative** — appearance detection can run a name-set `readdir` on the medium clock for 9 ms while liveness stays on the slow clock, because the two costs are three orders of magnitude apart. At 1777 ms a 30 s slow clock is a 6% duty cycle, so D4's period survives 500 runs; it would not survive putting this walk anywhere faster. ~~Original question:~~ **How does the slow clock scale to 500 runs?** Measured: 403 ms at 80 runs holding `run.json`. The naive extension is ~2.5 s, which would exceed the incumbent's whole poll interval. The extrapolation assumes the cost is linear in runs and dominated by `ps` spawns; neither is established. | Synthesise 500 run directories (empty `run.json` plus a `workers/<id>/state.json` naming a dead pid) under a scratch `PIFLEET_RUNS_DIR` and time `liveRunIds` and `runIdsAscending` separately. | **D4's slow-clock period, and possibly D6.** If the walk is 2.5 s, 30 s is too fast and the monitor needs a live-set cache invalidated by the medium clock's name-set comparison — which §6.3 already sketches but does not require. |
| **Q6** | **ANSWERED 2026-09-03: NO, and the premise was half wrong.** The two facts land on different clocks. `phase: "dead"` reaches the frame in **500 ms** — the `workers` fast source re-reads `state.json` for every known worker twice a second — while the run leaves the list in **30 s** on `liveRunIds`. So a `down`-ed run does not claim to be alive for half a minute: it says `phase dead` almost at once and its ROW lingers, which §6.4 already permits. **The mitigation this row proposes is therefore unnecessary rather than deferred** — putting `phase: "dead"` on the fast clock for known-live workers is exactly what the fast source already does. Measured deterministically on a fixture rather than by the stated probe: that probe destroys a live console worker to measure a property of the scheduler, and the scheduler is measurable without destroying anything. ISC-496 carries it. ~~Original question:~~ **Does a run *disappearing* need to be faster than 30 s?** §6.3 makes appearance a 5 s event through a cheap name-set `readdir` and leaves disappearance on the slow clock, so a `down`-ed run can show as live for up to half a minute. | Run `pifleet down` on one console run and time how long the pane keeps claiming it is alive; ask whether that is worse than the incumbent's 5 s. | **§6.3's mitigation only.** The fix if it matters is cheap — `state.json`'s `phase: "dead"` is on the fast clock for known-live workers — but it should be a decision rather than an accident. |
| **Q7** | **ANSWERED 2026-09-02 for the runs that exist, and §2.5's characterisation was WRONG in the safe direction. Measured: 117 ms on the largest event log (23.5 MB, 1 task) and 139 ms on the busiest run (13.7 MB, 3 tasks, 1 merge entry) — both INCLUDING ~70 ms of `bun` process startup, so `collectRunReport` itself is well under 100 ms.** §2.5 called this path "seconds, not milliseconds" without measuring it; it is milliseconds. **The merge path really executed** — the busiest run's report carries a non-empty `merge` array — so `git merge-tree` is not being skipped. **THE CAVEAT IS THE HONEST HALF AND MUST NOT BE DROPPED: no run on this disk has more than 3 tasks or 1 merge entry**, and §2.5's concern was per-(worker, branch) and per-task fan-out. So this measurement bounds the cost for runs of the shape that actually occur here and establishes **nothing** about a run with 20 tasks across 6 workers with real branches. **View 4 needs no progress indicator at observed scale; whether it needs one at fan-out is untested and stays open.** ~~Original question:~~ **What does view 4 cost on the largest run on disk?** `collectRunReport` runs `git merge-tree` per (worker, branch) and `harvestTask` per task, and §2.5 calls it "seconds, not milliseconds" without measuring it. | Time `pifleet report --run 2026-08-30T23-41-07Z-1b0a --json` — the run holding the 24.7 MB event log — and again on the largest multi-worker run. | **Whether view 4 needs a progress indicator or merely a spinner**, and whether it can be pre-warmed on the slow clock for the selected run. Not the shape of the view. |
| **Q8** | ~~Should the git strip default to status-only and expand to commits, rather than the reverse?~~ **ANSWERED 2026-09-02: YES — status first, commits behind `[c]`.** | Asked the operator, which is what this row said to do. The answer was the reverse of D12's original default, with the operator's stated reason matching the one this row conjectured: dirty paths change and a commit list on an idle branch does not. | **Closed.** D12 revised, §6.8 rewritten, §7.2's loss row updated. Both halves are still preserved; which one costs a keypress is reversed. |
| **Q9** | **ANSWERED 2026-09-03, and the answer is NO — the figure does not survive measurement.** Measured on the operator's own six-worker fleet with all four views built: `status --all` renders 12 lines and view 1 renders 20; per worker the incumbent asserts 5 field kinds and view 1 asserts 7. **1.4x per worker, 2.8x across views 1+2 — not 10x, and not within a factor of five of it on any reading of "density".** §3.6 said in advance where this goes: "if it cannot, the design has failed on its own terms and D16 is where to say so." What the measurement found instead cannot be expressed as a ratio at all: three fact classes have a denominator of ZERO in the incumbent — container presence, per-region staleness, and the dispatch route with the fence — and the fourth gain is discriminating power inside one field, where `status` prints `idle` for every attended worker and did so on all six real rows. A note on the coverage argument, which looked stronger than it is: the DEFAULT `pifleet status` shows one run to the monitor's six, but `--all` (`status.ts:93`) renders every live run, so the ratio above is measured against `--all` rather than against the default. ISC-495 carries it, and the test states the ratio as an inequality against 10 so it fails if the claim is ever made true. ~~Original question:~~ **What is the falsifiable form of "an order of magnitude denser"?** §3.6's third property and D16's cost paragraph both name this as unresolved. | Count the distinct facts per worker row in the incumbent (two: the worker id, and `idle task=- supervisor=up`) and in a rendered mock of §6.2's row, and let the owner set the floor. | **D16, and the acceptance criterion §10 proposes for it.** A criterion whose threshold is a rhetorical figure will be graded `[~]` forever. |
| **Q10** | **Does Ink's full-frame repaint flash visibly inside a cmux pane?** Measured (§6.6.1): Ink rewrites every row on every update, including unchanged ones. Measured separately: the incumbent's flash came from `clear` + subprocess, which leaves a blank window Ink does not have. **Whether one atomic overwrite still flashes is established by neither measurement**, and D2 accepted the repaint without settling it. | Run the monitor in a real operations pane at the 500 ms clock with a changing activity column, and watch. If it flashes, compare against an Ink build whose static regions are memoised so unchanged rows are not re-rendered. | **Nothing structural — the seam in D2 makes the renderer swappable — but it decides whether §6.4's fast clock can run at 500 ms or must slow down.** This is the one risk D2 knowingly took on, and it is filed rather than assumed because `operations-plan.ts:655-671` is precedent for this repository being wrong about exactly this. |

---

## 10. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria,
each phrased so the probe is obvious, because a criterion whose verification is unclear is one that
will be graded `[~]` forever.

**`ISC-467` is the highest id in use as of 2026-09-02 — verified by
`grep -o "ISC-[0-9]\{1,4\}" ISA.md | sort -u -t- -k2 -n | tail`, run against the main checkout — so
this block starts at `ISC-468`.** (Run against an older tree the same command answers `ISC-430`;
§0.4 explains why, and the tip is the authority.) Twenty-six criteria are proposed below, which puts
the block at **ISC-468..ISC-493**, with **ISC-494..ISC-498 held in reserve** for what Q1, Q3, Q5 and
Q9 will add once settled: the fifth activity state's exact meaning, the geometry floor, the
slow-clock period at scale, and the density threshold each need a criterion and none can be phrased
yet. This document deliberately allocates none of them — `ISA.md` owns that numbering, and two
criteria sharing a number is a worse outcome than a list that needs ids assigned on adoption.

**Two existing criteria are touched by the findings above, independently of whether this design is
built. Take these first.**

| ISC | What it says | What this work does to it |
|---|---|---|
| The `transcript_activity` criterion (the 2026-09-01 fix recorded at `contracts.ts:306-380` and `supervisor/index.ts:1982-2020`) | The field distinguishes a worker mid-turn from one at a prompt, and its placement above the epoch guard is "the whole fix". | **Not falsified, and incomplete in a way its own closing evidence could not see.** Finding A: the poll returns *before* the field is written when no session file exists, so four live attended workers have carried `null` for nine hours and render identically to `rpc` workers. **The criterion should gain an assertion that a `tui` worker with no session file is distinguishable from an `rpc` worker, whether or not this design is adopted.** |
| The operations-console pane criteria that `test/unit/operations-plan.test.ts` pins — no `watch(1)` (`:367-373`), no `--watch` (`:326`), one `--poll` for both panes (`:336-341`) | The two watchers' shape, asserted byte-for-byte. | **Two of the three assertions lose their subject** when panes 3 and 4 merge. The `watch(1)` prohibition must survive the merge — it is a host fact, not a pane fact — and the `--poll` assertion must be restated against whatever knob the monitor takes. Retiring them silently would drop a measured host constraint. |

**Criteria that must be re-read before any of them is claimed to still hold:** the ISCs behind
`PANE_MODE_TUI_VOIDED` (**ISC-74, ISC-81, ISC-84, ISC-85, ISC-86, ISC-87, ISC-95, ISC-111, ISC-115,
ISC-141** — `voided.ts:124-176`; the monitor is the first surface that would *display* this table
live, and displaying it is a stronger claim than storing it), **ISC-137** (no cmux import outside
`src/backends/cmux/` — the monitor must stay clear of it entirely), **ISC-127** (the run-dir mount
guard — a viewer is not a container, but it reads the same tree and should not learn a second way to
resolve it), **ISC-231 and ISC-345** (two readers of one fact — D6's mitigation is written directly
against these), **ISC-216** (a code that conflates two states — D9's activity ladder is the same
shape at the display layer), and **ISC-125** (the escape-watch surface, which view 4 must render
with `render.ts:118-132`'s exact "armed in N containers" wording rather than "no attempts").

Proposed new criteria, by area:

**Read-only, structurally (D3, D7, D15)**
- The monitor's module imports nothing that can write to the run directory or open a control socket.
  *Probe: walk the source and its transitive import list, as `logs.ts`'s suite already does; a new
  import of `rpc/client.ts`, `run/ledger.ts` or anything under `src/cli/commands/` that dispatches
  fails.*
- **Anti: the monitor spawns exactly one distinct subprocess argv, and it is frozen.** *Probe: assert
  the Docker argv byte-for-byte against a literal, and assert the constructing function takes no
  parameters. A caller-influenced argv fails. This is D7's guard and it is the criterion that would
  catch a future edit turning the viewer into a control surface.*
- The monitor writes to no path under the runs root. *Probe: run it against a runs root made
  read-only, and assert it renders rather than throwing.*

**The data plane (D6, D10, D11)**
- Every run-directory path the monitor opens comes from `runPaths` or `workerPaths`. *Probe: grep the
  module for `join(` against a run root, and for string literals naming known filenames
  (`state.json`, `events.jsonl`, `attended.json`); any hit fails. This is `paths.ts:1-18`'s rule
  asserted rather than trusted.*
- Every control-plane document is parsed by the existing reader in `src/run/state.ts` or
  `src/attended/mode.ts`, not by a local `JSON.parse`. *Probe: assert no `JSON.parse` in the module
  for these files; a second parser fails.*
- The monitor never calls `adjudicate`, `harvestTask` or anything that produces a verdict outside
  view 4. *Probe: import-list assertion plus a call-graph check on the fast and medium clocks.*
- An `events.jsonl` of 24 MB is rendered without being read whole. *Probe: point the monitor at the
  measured 24.7 MB log, assert the bytes read are bounded by the tail window, and assert the first
  frame paints inside the fast clock's period.*
- An unreadable `state.json` degrades one row and no other. *Probe: truncate one worker's state file
  mid-token and assert the other five rows still render and the sixth names the error — the
  `readValidated`/`StateReadError` path (`state.ts:806-855`).*

**The clocks and staleness (D4, D5)**
- The three clocks fire at their own periods and the expensive walk fires on none but the slow one.
  *Probe: instrument the readers with a counter and assert the ratio over 60 s; a `liveRunIds` call
  on the fast clock fails.*
- Every region carries an age, and the age is derived from when the read succeeded, not from when
  the frame painted. *Probe: freeze one source, let three frames paint, assert the frozen region's
  age increases while the others do not.*
- **A region whose refresh threw shows the reason in place of its content.** *Probe: make one reader
  throw and assert the rendered line contains the error, not the previous value silently. This is
  §4.3's argument asserted, and it is the criterion that would catch a monitor that lies.*
- A source that has never succeeded renders `no data`, distinctly from one that refreshed and found
  nothing. *Probe: two fixtures, two different strings; one string for both fails.*

**Activity and the fleet row (D9, D16)**
- The activity column renders five distinct states and no two fixtures collapse.
  *Probe: `rpc` worker; `tui` worker with no session file; `tui` worker with a session file and no
  growth; `tui` worker growing now; worker whose container is absent. Five renderings, asserted by
  string.*
- **A `tui` worker with an empty `sessions/` directory does not render the same as an `rpc` worker.**
  *Probe: the two fixtures side by side. **This is Finding A and it should be written first and
  failed first**, and it only passes once Q1 is settled, so the criterion and the question must be
  filed together.*
- A live supervisor whose container is absent from `docker ps` produces a named finding on its row.
  *Probe: a fixture whose `docker ps` double omits one name; assert the row says so rather than
  blanking the column.*
- The first frame answers §1.3's first two questions with no input. *Probe: render one frame from a
  fixture fleet and assert the output contains an activity age and a phase for every live worker.
  This is D16 and it is the closest thing to a WOW criterion that can be written today.*

**Layout and degradation (D14, D12)**
- The degradation order is exactly spend → container → run-suffix → phase, and the activity age and
  staleness marker are never dropped. *Probe: render the same model at descending widths and assert
  what is present at each; a width at which the activity column disappears fails.*
- Below the floor the monitor refuses with a sentence naming the required size. *Probe: render at
  one column below the floor and assert the refusal text, not a truncated frame.*
- The git strip preserves the branch line, the short status, the commit list, `--no-pager`
  behaviour, and the watched directory. *Probe: assert all five against a fixture repository;
  a missing `--branch` or a `cd` instead of `-C` fails.*
- **Anti: `watch(1)` is not invoked and neither is a pager.** *Probe: assert the monitor spawns
  neither, which keeps `operations-plan.ts:47-50`'s measured host constraint alive after the panes
  it was written for have gone.*

**The console integration (D1)**
- `operationsPanes` returns three panes, the third being the monitor, and its command is built with
  `pifleetCommand` from an absolute path. *Probe: the existing byte-for-byte plan test, extended;
  a bare `pifleet` fails on `operations-plan.ts:43-46`'s host fact.*
- The monitor's pane command still ends in a shell rung. *Probe: assert the trailing
  `; exec $SHELL -i`; a pane that closes on a crash fails, on `operations-plan.ts:408-412`'s
  measured reasoning.*
- `--poll`'s meaning after the merge is stated and asserted. *Probe: assert what the flag now sets;
  a flag that silently stops affecting anything is the dead-field shape `paths.ts:528-541` and
  `contracts.ts:86-118` both record.*
- **Anti: no criterion in this block requires a real terminal.** *Probe: the whole block passes with
  the renderer called as a pure function and the readers pointed at fixture directories. If it
  cannot be written to that standard, say so at filing time rather than discovering it at grading
  time — `Docs/SRD-TUI-DISPATCH.md` §10 records ISC-377/378/379/387 sitting at `[~]` for exactly
  this reason.*

---

## 11. References

- `Docs/SRD.md` §0.2 (Decision 1 — the pane is a view), §3.3 (three processes, three lifetimes),
  §3.5 and its four errata (pane modes and what `tui` voids), §7.6 (presentation beside state),
  §7.7 (ledger and registry), §10 (the CLI surface and the exit ladder), §14.2 (the report).
- `Docs/SRD-TUI-DISPATCH.md` — §3.4 (nothing observes the pty), §6.5 (what the fleet says about a
  staged task), §7.2 (the voided table becoming route-dependent), and its §10's precedent for a
  criteria block that needs no pty.
- `Docs/SRD-INFERENCE-PROVIDERS.md` — the format sibling; §0.3's disclosure precedent and §0.4's
  provenance table.
- `src/backends/cmux/operations-plan.ts` — `redrawOnChange`, `statusWatchCommand`, `gitWatchCommand`,
  `operationsPanes`, `DEFAULT_GIT_POLL_SECONDS`, and the three measured host facts in its header.
- `scripts/operations` — `watchDir = process.cwd()`, the `--poll` flag, and the stale `--watch`
  sentence at `:10`.
- `src/cli/commands/status.ts` — `ago`, `transcriptNote`, the `--all` reasoning, the `--watch` loop.
- `src/cli/commands/wait.ts` — the file-driven poll and the empty-inbox break.
- `src/cli/commands/logs.ts` — the structural read-only header, `sanitize`, `clip`, `TailReader`.
- `src/run/paths.ts` — `runPaths`, `workerPaths`, `runIdsAscending`, `workerContainerName`,
  `workerOutboxDir`, and the one-source-of-truth rule its header opens with.
- `src/run/state.ts` — `readWorkerState`, `readPresentation`, `readFence`, `readTaskRecord`,
  `readBudgetState`, `readValidated`'s torn-read retry, `StateReadError`.
- `src/run/registry.ts` — `liveRunIds`, `latestLiveRunId`, `identityAlive`, `readRegistry`.
- `src/run/ledger.ts` — `LedgerWriter.append`, `mergeLedger`, and the per-record tolerance.
- `src/contracts.ts` — `WorkerStateSchema` and `transcript_activity`'s docblock, `PhaseSchema`,
  `VerdictSchema` and the lattice, `PresentationSchema`, `LedgerRecordSchema`, `HarvestSchema`,
  `TaskSchedStateSchema`, `RunReportSchema`, `AttendedRecordSchema`, `EXIT` and `EXIT_SEVERITY`.
- `src/supervisor/index.ts` — `logEvent`, the event vocabulary, `HEARTBEAT_MS`, the `tui` transcript
  poll and the `transcript_activity` write above the epoch guard.
- `src/supervisor/tui.ts` — `discoverSessionPath`, `classifyTuiTurn`, `TUI_POLL_MS`, `TUI_QUIET_MS`.
- `src/report/collect.ts` — `collectRunReport`, `CollectedReport`, `collectAttended`,
  `collectEscapeWatch`, `stagedWorkers`.
- `src/report/render.ts` — the reading order and the two load-bearing wording rules.
- `src/harvest/layout.ts` — `dispatchedTaskIds`, `unexplainedOutboxDirs`, and the empty-input
  failure shape its header names.
- `src/harvest/outbox.ts` — `readResultEnvelope` and the `files/` scan.
- `src/attended/voided.ts` — `TUI_VOIDED`, `PANE_MODE_TUI_VOIDED`.
- `src/safety/procstart.ts` — the `ps -o lstart=` spawn behind every liveness check.
- `src/cli/commands/dispatch.ts` — `via: "rpc" | "pane" | "staged"`.
- `src/run/dispatch-policy.ts` — `DISPATCH_POLICY_MOUNT`, and the staged brief's on-disk shape.
- `package.json` — three runtime dependencies, none of them a renderer.
- `ISA.md` — the ISC block this document proposes, and the criteria §10 lists as needing re-reading.
