# cmux-fleet

`pifleet` — orchestrate a fleet of containerized [Pi](https://pi.dev) coding agents, optionally
surfaced as [cmux](https://cmux.com) panes, and harvest their work as structured artifacts.

The design lives in [`Docs/SRD.md`](Docs/SRD.md). The done-condition lives in [`ISA.md`](ISA.md).

## Why

A pane is a *view*, not a channel. Every control-plane fact comes from the Pi RPC stream, the
session transcript, or the worker's outbox — never from scraped pane text. Closing a pane, or
never opening one, changes nothing about a run.

**With one deliberate exception, which is the whole of `pane_mode: tui`.** That mode hands a
worker's pane the container's own terminal, so for those workers the pane *is* the channel: there
is no RPC stream, dispatch is keystrokes, completion is read out of the transcript, and closing the
pane is believed to stop the worker. It is a degraded mode for attended debugging, not the
supported path — and it is degraded in writing: `pifleet report` names the ten guarantees it gives
up, per run, with a sentence an operator can act on for each.

## Install

```bash
bun install
bun run src/cli/index.ts doctor
```

Requires Bun >= 1.3, Docker, Pi 0.79.6, and a local oMLX server. cmux 0.64.20 is optional —
the `headless` backend runs the entire suite without it.

`doctor` is the first thing to run and the first thing to trust. It probes each backend, the
cmux socket mode, the pinned Pi and cmux versions, whether a worker image exists, and — the
one people skip — whether the runs directory is actually **visible inside a container**. That
last check exists because a bind mount can fail in two silent ways: on macOS the daemon runs
in a VM that shares only a declared set of directories and mounts anything else as an *empty*
directory with exit 0, and on Linux a bind mount passes host ownership straight through, so a
directory the host created at 0755 is unwritable to the worker's uid 10001. Both look exactly
like "the agent did nothing".

```bash
bun run src/cli/index.ts doctor --json     # every command supports --json
```

Exit codes are a strict severity ladder, highest wins, so one `wait --all` can report a
timeout and a dead worker without ambiguity: `8` internal error, a pifleet bug — file it,
don't retry · `2` usage/config · `3` backend unavailable · `5` budget ceiling · `6` worker
died · `4` timeout · `7` partial · `0` success.

## A run, end to end

```bash
pifleet up --workers eng-1,tst-2 --backend headless   # build the run dir, start supervisors
pifleet dispatch --worker eng-1 --task task.json      # send a typed envelope
pifleet wait --all --timeout 20m --json               # block until every task settles
pifleet artifacts --all --json                        # adjudicated results
pifleet down --run <id>                               # quiesce, then stop
```

Supervisors are detached — their own session and process group — so they outlive the CLI that
started them. `up` is not "fire and forget": it returns only once every worker has reached
`idle`, and exits nonzero naming the laggards if they do not.

## The consoles

A **console** is a named group of seats stood up together by one script. There are four. Two of them
also have an **actor** — a host-side process that drives the seats rather than an operator typing at
them — and those two are `review` and `triage`; `CONSOLE_NAMES` is the closed list of consoles that
keep an actor's record, log and lock. The fourth console is the one that runs when nobody is
watching at all.

| Console | Script | Seats | What it is for |
|---|---|---|---|
| `operations` | `scripts/operations` | `obs-1`, `tick-1` | attended: cluster questions, ticketing. Its two watcher panes were replaced by `pifleet monitor` |
| `development` | `scripts/development` | `eng-1`, `eng-2`, `tst-1`, `tst-2` | attended: building and testing |
| `review` | `scripts/review` | `col-1`, `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` | a fan-out review, three vendors, one collation |
| `triage` | `scripts/triage` | `tri-1`, `obs-t1`, `obs-t2`, `obs-t3` | **unattended**: sweeps an environment on a clock and notifies |

The first three are things an operator opens. **`triage` is the one with no keyboard**: a host-side
actor is both its clock and its fan-out performer, and `pifleet triage` is how you drive it.

```bash
pifleet triage --once            # one sweep, now — the exit code means something
pifleet triage --poll            # the loop, at triage/console.yaml's cadence
pifleet triage --status [--json] # what the actor and the incident records say
```

Three properties are worth knowing before running it unattended, because each is a thing it
deliberately does **not** do. It **never says a service is healthy on the strength of silence** — an
observer that produced nothing is a coverage gap, not an all-clear, and the console will tell you it
cannot see rather than that everything is fine. It **notifies once**, not once per sweep: a service
firing for a day produces one message and its reminders, and a service flapping produces one
message about the flapping. And it **cannot command the fleet** — every module the console owns is
held read-only by a test that walks its import closure, with exactly one permitted exception, and
the two privileged effects it genuinely needs (dispatching a sweep, recycling a seat) are built at
the composition root and injected as plain functions rather than reachable from inside it.

`SRD-TRIAGE-CONSOLE.md` is the design and `ISA.md` is what is actually proved about it.

## Status

All six phases are done, and `pane_mode: tui` with them. 2909 tests pass, 124 skip, 0 fail across
193 files — `test/unit` 2302, `test/integration` 590 (+124 skipped behind Docker/oMLX gates),
`test/e2e` 17. **Measured on a developer host on 2026-08-31, not read off a CI run**, because the
figure this replaces said "`test` job, CI on `main`" and this branch is not `main`; the honest
provenance is the one that was available. CI runs the same three suites plus a Docker `container`
job, an `omlx-live` job and a `load` job, none of which are counted above.

| Phase | Deliverable | State |
|---|---|---|
| 0 | Interface verification | done (see SRD §4) |
| 1 | Container + headless core | done — `up → dispatch → wait → down` green on `headless` and against real Pi 0.79.6 |
| 2 | Artifacts + safety | done — outbox contract, harvester, adjudicator, worktree isolation, budget ceilings, kill ladder |
| 3 | Security + cloud identity | done — egress allowlist, network lifecycle, repo hazard scan, cloud identity, control-socket auth |
| 4 | Panes | done — cmux/tmux backends, `attach`, live pane viewer |
| 5 | Orchestration | done — `dispatch --auto` DAG scheduling, `pifleet report`, `pifleet logs` |
| 6 | Attended mode | done — `steer` / `abort` / `exec`, `tui` pane hand-off, voided-requirements table |
| — | `pane_mode: tui` | done 2026-08-31 — the pane runs `docker attach` on Pi's own pty; no RPC control plane, keystroke dispatch, transcript-derived completion, `docker kill --signal=INT` for `abort`, and guards in `up` and `depends_on`. There is no `--mode tui`: Pi's TUI is its default mode plus a real terminal. |

**There are zero `[ ]` criteria.** ISC-1111 held the last slot and closed on 2026-09-10, by operator decision plus a run that had already happened. Its probe asked for three consecutive sweeps delivering a `triage.json` through `submit_report` **and** for the `triage` role's grant to be narrowed; the grant clause was struck, because it gated a LIVE-RUN acceptance on a config property provable offline and a 23-sweep clean run counted for nothing against a line in `fleet.yaml`. What closed it: 35 collate epochs on one run, **32** settling `success` with reason `transcript_terminating_report` and the artifact on disk, longest consecutive qualifying run **23** against a bar of three. The two failures are `ISC-1126`'s tool-loop detector firing on a live collator, which is the guard working. The entry's original narrative is kept whole though every sentence of it is stale — it was filed on a real blocker that cleared while nobody re-checked, the `ISC-115` shape recorded here a second time. `ISC-1126` held the second slot for one day: it was filed 2026-09-09 against a fix of my own and closed the same day. A `tui` seat that loses the ability to terminate emits events continuously, so `event_stall_kill` — which fires on the ABSENCE of events — is blind to it, and the seat looks maximally healthy while accomplishing nothing. Two sweeps ran a single `kubectl` command **113** and **103** times, every call succeeding, and both burned the 480 s deadline with no artifact. The prompt-level bound shipped for it (`ISC-1121`) reached the brief and was ignored: one sweep carrying it settled in 22 calls and the next looped 103 times, so the green one was luck — **a prompt cannot bound a model that has stopped being able to stop.** `ProseTurnDetector` was the right shape and the wrong plane, being fed from `RpcEvent`s that no `pane_mode: tui` seat emits, so the fix is `src/supervisor/tool-loop.ts` reading the transcript instead. **The placement is the fix and the fold is the easy half:** a looping seat is mid-tool-call on every poll, so `classifyTuiTurn` answers `in_flight` for ever and everything below the settle chain's `if (reading.phase !== "ended") return` is unreachable for this failure by construction — which is why no guard the fleet already owned could see it. That claim is mutation-proven rather than argued: moving the check one block lower leaves **all 17 unit tests green** and reddens only the integration probe that drives a real supervisor. The bound is read off the fleet's own transcripts rather than chosen — worst streak from a delivering sweep **11**, mildest measured loop **108**, threshold **20** — and both edges are asserted, so moving it in either direction goes red. See `ISC-1127`..`ISC-1130`.  `ISC-1123` held the second slot for under an hour on 2026-09-09 and closed as `ISC-1124` — it hypothesised a systemic "moving ceiling" on the shared oMLX, and the cause was one line of YAML: CI's `omlx-live` warmup issued a completion with `GLM-4.5-Air-MLX-4bit` hardcoded in its request body, ~58 GB, while its probes ran gemma. A live seat took the resulting `507` twenty-one seconds after the push that started the job. The residue indicts the earlier `ISC-1116` close: pinning `PIFLEET_OMLX_MODEL` bounds what the PROBES read and not what the JOB can load, because **anything that can issue a completion can load weights**. The count had been zero since 2026-09-08 and re-opened the same day, with task 7.3's config half landed and its live half not: §13 asks for **three consecutive triage sweeps** on the narrowed grant, *"because this console runs unattended and one is not evidence"*, and no sweep has run against it at all — which is why it is `[ ]` and not `[~]`. It is now **unmeetable as written** rather than merely unrun (`ISC-1113`): the narrowed grant cannot dispatch a sweep, because the role's product is a `dispatch-request.json` and `submit_report` has no route for a second file. Three sweeps on that grant produced three that fanned out to nobody, two of them reporting `success`. The acceptance needs a `dispatch_request` extension tool before it needs three passes. `ISC-1087` — *"layer 3 has never run against a live model"* — closed by the event it named: the nag landed on `col-1` at 19:10:40 and was **wrong twice**, which is why a unit-level phase could not have closed it, and both defects became `ISC-1105` and `ISC-1107`. `ISC-1073` closed by writing the check three SRD passages said existed: nothing had ever compared the three extensions' structural `interface ExtensionAPI` declarations against the `types.d.ts` baked into the image, so a `0.79.x` rename of `registerTool` would have left the whole suite green with `dispatch-trigger` silently never firing. It now reads the real type out of the tag and checks members and subscribed event names, and is wired into the gated container job with `TOTAL_EXPECTED` re-derived by hand. `ISC-1057` closed on 2026-09-08 with the decision it had been waiting for, and the cause was sharper than the criterion stated: **`pifleet triage` has no `--workers` at all**, so its record is written from a constant and the script compared that against an operator flag. The comparison had no reachable yes under any override, and `./scripts/triage --workers …` stopped a healthy actor and started an identical one every time. A restart cannot change a constant, so refusing to adopt bought no convergence — the arm is now containment rather than equality. `ISC-1087` stays open only as a heading: its content was found and fixed the moment layer 3 met a live model, as `ISC-1105` and `ISC-1107`. `ISC-1106` held the fourth slot for part of one day and closed the same day it was filed: `scripts/operations --restart` took a pane TITLE and handed it to the run lookup as a WORKER ID, so nothing was stopped and the old container was orphaned beside its replacement — 12 workers became 14, twice, an hour apart. That console had no safe restart path at all, because the id was refused and the title orphaned; both spellings now resolve to the same pane and the plan carries the worker. `ISC-1087` stays open only as a heading: its content was found and fixed the moment layer 3 met a live model, as `ISC-1105` and `ISC-1107`. `ISC-1106` is the newest and was reproduced twice, deterministically: `scripts/operations --restart` takes a pane TITLE and hands it to `resolveThenRestart` as a WORKER ID, so no run is found, nothing is stopped, and the old container is orphaned beside the new one — two live runs for one worker id, twice, an hour apart. That console has no safe restart path at all, because `--restart obs-1` is refused and `--restart observer` orphans. `ISC-1087` stays open only as a heading: its content was found and fixed the moment layer 3 met a live model, as `ISC-1105` and `ISC-1107`. `ISC-1104` held the fourth slot and was regraded `[~]` on 2026-09-08 by the run it was waiting for: twelve seats were restarted onto the rebuilt images, and **Phase A ran for the first time** — three of five seats reached for `submit_report` with both routes open, which answers Q2. It is `[~]` rather than `[x]` because the run found `ISC-1105`, and neither half of task 6.3's acceptance held: every seat that delivered through the tool settled `timed_out`, because `terminate: true` leaves the transcript's last assistant message on `stopReason: "toolUse"` for ever and the `tui` completion path reads that as still-working. Two of three reviews were discarded in silence as a result — `relay.ts` publishes a reply only for a lens that succeeded. **SRD §11 Q3 had measured `terminate: true` against all four models and found it clean, on the `rpc` path**, which is not the plane any console seat runs on; that gap read as coverage for four phases and would have blocked Phase 7 outright. ISC-1101 held a slot for under an hour: `npm` became unreachable partway through 2026-09-08 — `registry.npmjs.org` timing out from the host and answering `127.0.0.3` inside a container — so the toolchain images could not be rebuilt, and it lifted as abruptly as it arrived. `ISC-1104` outlived it by hours: the images were rebuilt, twelve seats restarted onto them, and **Phase A ran** — `pifleet.submit/v1` observed in three live sessions. What it found is `ISC-1105`, and the honest boundary of the whole worker-dispatch SRD moved rather than closing: a report delivered through the tool settled `timed_out` on every seat that used it. `ISC-1087` is the same shape one layer up and is still open — the nag has still never met a live model. **Everything that SRD has shipped is host-side or unit-level and passes forever whether or not a model ever calls the tool.** The last three are one story and it is worth reading as one: `ISC-1101` is an environment condition (npm became unreachable partway through 2026-09-08, so the toolchain images cannot be rebuilt here), `ISC-1104` was its consequence (Phase A could not run while `up` refuses a stale tag by design; both lifted on 2026-09-08), and `ISC-1087` is the same shape one layer up (the nag has never met a live model). **Everything the worker-dispatch SRD has shipped is host-side or unit-level and passes forever whether or not a model ever calls the tool.** ISC-1101 is not a code defect and is filed so a stale-tag refusal is not read as one: the three toolchain images cannot be rebuilt on this host, because `npm` became unreachable partway through the session — `registry.npmjs.org` times out from the host and resolves to `127.0.0.3` from inside a container, which is the corporate proxy's blackhole answer rather than a Docker fault. The source is committed and correct; `up` refuses a stale tag by design, so the failure mode is a refusal to start rather than a silently wrong worker. ISC-1091 and ISC-1092 were both filed and closed on 2026-09-08, hours apart, by the rounds they would otherwise have blocked — the first because nothing established `/policy/replies` before `docker run` and Docker creates a missing bind-mount source as a DIRECTORY, the second because that file was not in `docker/verbgate`'s integrity loop, which is what makes a dropped `:ro` cost the whole worker rather than one forged file. Both were found by engineers against files no task in their phase named. ISC-1091 held a slot for part of one day: it was filed 2026-09-08 by the engineer landing Phase 5's first round, against a file no task in that phase names, and closed the same day by the round it would have blocked. Nothing established `/policy/replies` on the host before `docker run`, and Docker creates a missing bind-mount source as a DIRECTORY — confirmed by running it, not argued — so every worker would have come up unable to read or write its declared reply set. ISC-1092 is its integrity twin and is still open: the file is not in `docker/verbgate`'s loop, which is what makes a dropped `:ro` cost the whole worker rather than one forged file. The last two were filed 2026-09-08 by the engineer landing Phase 5's first round, against files no task in that phase names, and ISC-1091 is a **blocker**: nothing establishes `/policy/replies` on the host before `docker run`, and Docker creates a missing bind-mount source as a DIRECTORY — confirmed by running it, not argued — so every worker would come up unable to read or write its declared reply set. ISC-1092 is its integrity twin: the file is not in `docker/verbgate`'s loop, which is what makes a dropped `:ro` cost the whole worker rather than one forged file. Both have owners in the next round.  ISC-1087 was filed 2026-09-08 by the engineer that built Phase 4, against its own work, and it is the honest boundary of what that phase proved: **layer 3's nag has never run against a live model.** Q1 measured a SCRATCH extension, not this code path, so nobody has dispatched a real task to a seat carrying `report-tools.ts` and watched the nag land inside the 0.18-1.05s runway Q1 measured between a model acting and the supervisor settling. Every other Phase 4 criterion is unit-level against a recording `pi` and passes forever either way, which is exactly why this is filed separately rather than folded into one of them. ISC-1073 was filed 2026-09-08 while correcting the SRD that Phase 2 was built from, and it indicts code that has been running in workers for weeks rather than anything new: all three `docker/pi-extensions/` files declare their Pi surface STRUCTURALLY, because the package is in the image and not in this repository, and three passages of that SRD asserted an integration test reads the image's `.d.ts` back to catch drift. No such test exists — the only `@earendil-works` string in `test/` asserts a `.js` PATH appears in a shim, which is a file name and not a type — so a `0.79.x` rename of `registerTool` is caught by nothing. It is `[ ]` and not `[~]` because nothing partial exists, and it stays open rather than being struck because the type does ship in the image and the check is buildable. ISC-891 held the previous slot and closed when §6.10's budget producer was wired at the composition root. ISC-1057 is a defect the engineer found while landing the last build task and reported rather than fixed: `scripts/triage` decides whether an actor already serves this console by comparing against a record the ACTOR writes, and the two disagree under `--workers` — so that invocation restarts a healthy actor every time, quietly, on a console nobody watches. The cost is latency rather than correctness, and narrowing the comparison is a decision about §6.4's adoption rule rather than a fix. ISC-891 held the last slot and closed on 2026-09-07 when §6.10's budget producer was wired at the composition root — the fifth link in a chain whose other four had shipped rounds apart, and whose `actor_unbudgeted` tell was deleted the same day because a tell that outlives its wire is a guard staying quietly green. ISC-1037, the last criterion filed open, was a document defect rather than a code one: §6.10's ceiling was written against a one-run reading §6.1 had already corrected to four, and a correction that enumerates some of its consequences and stops is how a factor of four survives a round. ISC-868 closed the day after it opened, and closed with the read it was filed open for rather than by relaxing the signal it refused. ISC-932 held the other slot for one round and closed — and it closed by going RED first, which was the design: it had been pinned to its blocker's absence, so landing the unblocker had to break it. The one that remains is a residue named by the task that found it rather than a defect discovered later, and the cause it shared with ISC-932 is worth stating: **the read-only guard means a privileged effect cannot be built inside the console at all.** ISC-932 is the recycle's `down`/`up`, and it is ISC-891's neighbour by accident and task 6.1b's finding by repetition — the answer each time is to build the effect at the composition root and inject it, which is why the guard's permitted-exception list is still one entry after four rounds of pressure on it. ISC-824 held that slot for one round and closed — §6.8a's seventh console-health kind now reaches an operator. Both of the current two are residues named by the task that found them rather than defects discovered later. **ISC-868**: a sweep abandoned between its join and its collation cannot be told apart, through the port that exists, from one that finished — and resuming on the weaker signal would open a firing incident on a single sweep's evidence, which is worse than the one wasted cadence it would save. **ISC-891** is the sharper of the two and was filed by the engineer that built the code it indicts: §6.10 promises a `budget_exhausted` notification, and nothing writes `budget.json` for a console run — so the mapping is correct and permanently inert, and it is filed separately rather than folded into the mapping's own criterion precisely because that criterion passes forever either way. ISC-869 held the other slot for one round and closed: one table had lived in two files with nothing pinning them equal — the third instance of that shape on this branch — and the fix was to consolidate rather than to assert two copies agree, because an assertion that two copies agree is a third copy. Before that the count was zero, and the run that took it there is worth keeping: The last one, ISC-572, was filed 2026-09-06 while
verifying a different fix and closed the same day: `scripts/review --restart <id> --task
<file>` stopped the review relay BEFORE the settle wait whose whole value is refusing
having torn nothing down, so on that one console the refusal's promise was false. The
stop is a `quiesce` dep on `recreateThenDispatch` now, firing after the wait and before
the teardown, and the source-order test that used to assert the WRONG order was replaced
rather than routed around. The SRD-FLEET-PM-001 block's own last two, ISC-547 and ISC-555, closed on
2026-09-06: both are Anti guards against a false green, and both are now decisions in
`src/run/pm-guards.ts` that `pifleet pm-guard` makes reachable from the workflow's own
shell lines. Its remaining eight moved to `[~]` on 2026-09-05 when the phase 6 dogfood
run exercised them live, and **not one of them reached `[x]`**: every observation needed
a terminal, a model and four containers, which is precisely what CI cannot re-check. The block
ISC-468..ISC-493 was filed 2026-09-02 as
the done-condition for a read-only fleet-monitor TUI (`Docs/SRD-FLEET-MONITOR.md` v0.2),
**before any of it was built** — deliberately, so the criteria are the specification rather
than a description of what was written. It is now closed: `pifleet monitor` reads the run
tree, `docker ps` and git on three clocks, renders through a `(model) => string[]` seam, and
has replaced the operations console's two watcher panes.

**Three of the criteria corrected themselves on contact with the code, and the corrections
are recorded in place rather than smoothed over.** ISC-468 leaned on a precedent that did not
exist (no transitive import walk was in `test/` before it). ISC-473 as literally worded
conflicts with ISC-472 in the same block and cannot pass — satisfying its closure reading
means abandoning the shared reader the other criterion requires — so it is narrowed to what
D10 is actually about. ISC-485 assumed Q3 would set the floor by measuring real panes; it is
closed by DERIVATION instead, because a measured floor describes the terminal that was open
that day and a derived one describes the design.

**Two of the closed ones are fixes to shipped behaviour, not new surface, and they hold
whether or not the monitor ever ships.** ISC-492: a `tui` supervisor's transcript poll
returned before writing `transcript_activity` when no session file existed, so four of six
live attended workers carried `null` for nine hours and were indistinguishable from `rpc`
workers on every surface reading only `state.json`. ISC-494 — filed out of the reserve, from
a defect the monitor's own readers surfaced: one unparseable `state.json` anywhere under the
runs root threw out of `liveRunIds` and `latestLiveRunId`, breaking `pifleet status` and
`pifleet wait` entirely, non-deterministically, on `readdir` order.

ISC-495..ISC-498 remain in reserve for what Q3, Q9 and Q10 add once settled.

**Before that block, there were zero.** The block ISC-431..ISC-467, filed 2026-09-02 as the
done-condition for dispatch to an adopted-terminal `tui` worker
(`Docs/SRD-TUI-DISPATCH.md`), is graded: thirty-five `[x]` and two `[~]`. Twenty-five were
that document's own §10 list verbatim; ISC-456..ISC-458 are the three it reserved and could
not phrase until its four open decisions were taken and its three blocking questions
answered; ISC-459 was filed out of the reserve at grading time, because the block had a
criterion for `wait` and one for `report` and none for `status`; **ISC-460..ISC-467 are the
auto-trigger**, filed after §9 Q4 was probed and came back the opposite of what the SRD
predicted. The reserve is now empty.

**The two `[~]` are named rather than rounded up.** ISC-432 — a gated verb run by a
backend-managed `tui` worker is ledgered under its dispatched task — has every link pinned
and the join unmeasured: closing it needs a container with a pseudo-TTY, which ISC-455
forbids for this block. ISC-444 — the `tui` transcript poll settles a turn when an epoch is
live — proves the CONDITION the poll gates on and not the path through it; Defect B is
closed as D12 says, as a consequence, and its closure is inferred from the gate rather than
observed at the settle.

**The staged route, in one sentence:** a dispatch to a worker whose terminal a person
adopted with `up --attach-here` no longer refuses. It allocates a real epoch through a new
supervisor `stage` verb, writes the inbox record and `/policy/task`, drops the rendered
brief at `/policy/dispatch` — a read-only sibling mount the verbgate holds to the same
integrity bar — and then types **one** line: `# pifleet: a task was staged for you — read
/policy/dispatch and do what it says`. The brief never goes near a terminal; the leading `#`
is a comment in `bash`/`sh` and a parse error in interactive `zsh`, an execution in neither.
A terminal that announces no surface id is a reported outcome, not an error: the task is
already staged and durable, so the route hands the operator the line and says why it could
not type it. `pifleet unstage --task <id>` releases a staged epoch without settling it —
deliberately not `abort`, which on this mode issues `docker kill --signal=INT` and stops the
worker.

**Then the keystroke went too.** §9 Q4 asked whether a container-side trigger could start a
Pi turn without writing to the surface, expected "no — a TTY has one owner", and was probed
on 2026-09-02 rather than assumed. **The answer is yes.** Pi enumerates its own input
sources as `"interactive" | "rpc" | "extension"`, and its extension API carries
`sendUserMessage()`, documented "Always triggers a turn". pifleet now bakes one extension
into the worker image at `/opt/pifleet/dispatch-trigger.ts`, root-owned 0444, loaded with an
explicit `--extension` path — `--no-extensions` stays on the argv beside it, because that
flag disables *discovery* only, so repo-supplied `.pi/extensions/*.ts` is still denied. The
extension polls `/policy/dispatch` and calls `sendUserMessage` when a new `(task_id, epoch)`
appears. **The prediction was wrong for an instructive reason: §162 governs who may write to
the terminal, and this path never touches the terminal** — so §4.3's hazard is not mitigated,
it is absent. The brief does not enter the composer, is not concatenated onto a half-typed
line, and is not submitted by a key. `auto_trigger: false` restores the keypress for a seat
that wants a human in the loop.

Two things about it are worth the reader's attention because both were found by measurement
rather than review. It **polls rather than using `fs.watch`**: Docker Desktop does not
propagate host-side inotify into a container, so an event-driven build would pass every test
written inside the container and never fire in production — a worker that waits forever,
silently. And it requires **two identical consecutive reads** before firing: the in-place
truncate that `/policy/dispatch` must use (a bind mount pins the inode) is not atomic, and a
prefix ending at the separator is a complete valid header with an empty prompt. The first
version of that guard claimed the JSON parse was enough; its own test refuted it on the
first run.

Before that block, there were also zero. The block ISC-401..ISC-430, filed 2026-09-01 as the
done-condition for per-worker inference providers
(`Docs/SRD-INFERENCE-PROVIDERS.md`), is closed in full — all thirty, including the two
filed out of its own phases' work: ISC-401 and ISC-406 closed with the two latent
defects they name, Phase 2 closed ISC-402, ISC-403, ISC-404, ISC-405 and ISC-420 when the
`llm.providers` map landed and `resolveWorker` began reading it, Phase 3 closed ISC-407,
ISC-408 and ISC-422 by moving the provider credential out of the environment entirely — it is
written to a `0444` file in the worker's secret store and reaches the container as a PATH under a
fleet-owned variable, with the entrypoint's environment read removed rather than demoted to a
fallback, and Phase 4 closed ISC-409..ISC-413 plus ISC-418 and ISC-425 by giving each provider IN USE
its own egress bridge, its own relay carrying exactly one target, and its own credential in both
the worker and the tool-call gate. **That last distinction is the phase's real content.** A file-then-environment fallback
would have looked like robustness and quietly restored the defect ISC-406 had just closed: on the
first day the pointer failed to arrive, a worker also holding `OMLX_API_KEY` through `secrets:`
would have authenticated to its configured provider with the LOCAL credential — a wrong-credential
401 strictly harder to diagnose than the empty key it replaced. ISC-424, filed during Phase 1's
review, was graded `[~]` for half a day and closed the same way. Phase 5 closed ISC-426..ISC-428 by
resolving a hosted provider's `relay_upstream` hostname once, at `up`, so the relay dials an address
while the egress policy still judges the NAME; Phase 6 closed ISC-414..ISC-417 by making a worker
whose context leaves the machine loud rather than refused — `up` prints a disclosure banner and the
launch record carries the same set, with a mismatch in EITHER direction failing; and Phase 7 closed
ISC-419 and ISC-423, giving the tool-call probe a per-provider deadline and proving the headless
acceptance suite still passes with every credential-shaped variable stripped from its environment;
and Phase 8 closed ISC-421, ISC-429 and ISC-430 — a hosted provider's Class 1 key now joins the
harvest sweep's needle set without `secret_names` claiming it was ever granted, the `up-wiring`
shim reaches a successful container-path run rather than always refusing, and `up`'s spend gate
states the dependency it actually has instead of one it merely appeared to.
**One `[ ]` criterion is open: ISC-824.** The `[ ]` count had been zero since ISC-572 closed on 2026-09-06, and ISC-824 opened later the same day rather than being closed on arrival. It is the residue of a design change ruled in *after* the task that would have carried it had already shipped: §6.8a's console-health `kind` set grew a seventh member, `inference_unreachable`, and nothing computes it — the enum, its observation and its anti-twin all landed and are green, and an `endpoint_down` sweep still composes nothing in production. It is filed `[ ]` rather than `[~]` on purpose: `[~]` means the behaviour is built and the evidence is thin, and here the behaviour is not built. Task 5.4e carries it.
Twenty-six are graded `[~]`
(see `ISA.md`), which in this repo means the behaviour is built and re-checked but the *evidence*
falls short of the standard — with one departure worth stating plainly, because it is the only
criterion so far to have made the round trip:
**ISC-562 moved backwards and then forwards again.** It was closed `[x]` on 2026-09-05, regraded `[~]` on 2026-09-06 when phase 7's review took its own "what is NOT graded" paragraph at its word — the ungraded half was justified with "the window cannot be deterministically entered from a test", which is a statement about a module-level import rather than about the window — and closed again the same day once the spawner was injected and a test drove a real second fetch into that window. The regrade was the useful half: it is what turned a paragraph explaining why the race could not be tested into a tripwire that said what would close it. **ISC-517 is `[~]` because it is FALSIFIED, not because its evidence is thin.** The review
console lost a complete, valid lens report on two consecutive runs, and the criterion is filed
open so the document carries the failure its own subject exists to prevent. It was root-caused
the same day — a reviewer spelled its artifact path relatively, one bad pointer refuses the whole
envelope, and a verdict, a summary and fourteen findings were discarded — and that route is now
closed and re-checked. The criterion stays `[~]` because its sentence is universal and a second
route is still open: a harvest that is rejected names its reason but still loses the lens rather
than recovering it. A later run collated three of three lenses; every seat in it happened to
spell its path absolutely, so that run exercises the loop working and not the fix. The rest: ISC-498 is the fleet monitor's one, where the repaint RATE is
measured (1.44/sec on the scheduler path) but whether a repaint visibly FLASHES is perceptual and
needs a person at the pane; ISC-331 has one unexercised surface (a live round trip); ISC-344,
ISC-349 and ISC-350 ship guidance to workers, where a grep proving an instruction was shipped
cannot observe a worker obeying it; ISC-432 and ISC-444 are the staged-dispatch block's two, both
described above; and the four still open from 2026-08-31 for `pane_mode: tui` —
ISC-377, ISC-378, ISC-379 and ISC-387 — are partial for one shared reason, that the mode's
subject is a pseudo-TTY and the suites cannot open one. ISC-380 was the fifth and **closed the same
day**: its stated closing condition was the only one of the five that did not need a terminal, and
`test/integration/tui-dispatch-pane.test.ts` now drives `dispatch` at a tui worker through the REAL
tmux backend with a fake `tmux` binary on `PATH` — proving that the typed bytes reconstruct the
rendered prompt, that the keys arrive in tmux's spelling, and that the CLI and the ledger both
report `via: pane` with no epoch. **No test in this repo attaches a real pane to a
real container.** The attach argv, the `ctrl-]` detach key and the `docker kill --signal=INT` stop
were each measured live against pi 0.79.6 on one machine on 2026-08-31; nothing re-runs those
measurements, and what CI re-checks is the argv the code builds, not the terminal it produces.
**ISC-387 is what that gap costs, and it was filed after the mode had already been declared
built.** Running a tui worker at a real pane found two defects in a path that had been designed,
reviewed, probed and merged green: tmux exits 0 for an unknown key name and *types it*, so
`shift+enter` appeared in the pane as nine characters while every assertion on pifleet's own argv
stayed correct; and cmux's dispatch was refused by pifleet's *own* identifier guard, whose grammar
has no `+`, at step 2 of a 29-step plan with two lines of the prompt already typed. Each backend
now translates one fleet-wide key vocabulary or refuses — but the vocabulary itself is still a
measurement nothing re-runs, which is why the criterion is `[~]`.
**ISC-259 is the ninth, and it got there differently from the other eight.** It was closed `[x]` by
owner decision on 2026-08-28 and re-graded on 2026-09-01 — not because anything contradicted it, but
because a mechanism its closing evidence *cited* was deleted underneath it. That evidence names three
mechanisms as the reason a hosted provider cannot appear by accident; ISC-369 removed the first, the
pin on `llm.base_url`'s host, for an unrelated and good reason, and never mentioned ISC-259 because it
had no reason to. Measured by driving this repo's own `parseConfig`, `omlxRelayTarget` and
`assertTargetsAllowed`: a fleet can now be pointed at a third-party provider and it validates. The
second half of the sentence — the two-place authorization — survives intact, which is why `[~]` and not
`[ ]`; nothing re-checks the word *never*, which is why not `[x]`.
ISC-372 was filed `[~]` the same day and closed hours later, when `up` gained the check against the
*effective* backend that the entry had named as its own closing condition.

**Two criteria left this list on 2026-09-01 by being closed rather than re-graded, and both are
worth a sentence because of HOW.** ISC-405 and ISC-424 were each `[~]` with their probe pinned to a
BLOCKER's absence — the rule this repo uses so that removing a blocker turns the guard red instead of
letting a criterion drift green. Both guards fired, on the commit that unblocked them, and both were
replaced with the positive assertion rather than deleted. ISC-405's fired twice: once when
`llm.providers` appeared in the schema, and again when `resolveWorker` started passing the tag-style
predicate. That is the pattern paying for itself — nobody had to remember either criterion.

Five are retired `[-]` — ISC-307 and ISC-360 — a marker introduced by ISC-368 on 2026-08-30 for a
criterion whose *premise* was superseded rather than left unproved. ISC-307 is about a secret's
value reaching an env file, and secrets are delivered as read-only files now (ISC-337); ISC-360 is
about an SRD erratum recording task-scoped cloud authorization as designed-but-not-built, and the
owner withdrew the mechanism (ISC-366). Retired criteria are excluded from `progress:` on both
sides — `407/420` counts the live set, and the frontmatter's `retired: 2` says where the rest
went. Retiring is not closing, is not deleting (both entries keep their text and their live
guards), and is refused for a criterion that is merely hard: `test/unit/isa-retired.test.ts`
rejects any retirement that does not name a closed criterion that names it back.

**ISC-340 was AMENDED rather than closed, re-graded or retired, and it is the only entry in that
state.** Phase 3 made half its text false by design: `/secrets` used to mean "what the operator
granted", so "a worker that asked for no secret gets no mount at all" was right, and the fleet now
delivers the provider key into that same store while no worker requests it. The gate was deleted
from BOTH sides rather than widened on one, and the guard that encoded the old meaning was
**replaced with the positive assertion rather than removed** — the same rule the two closed
tripwires above follow. The entry keeps `[x]` because its first clause, the one its mutation record
actually pins, is untouched and still probed. Amending is not retiring: the criterion still has
live guards and still counts.

`test/unit/docs-currency.test.ts` pins both counts against `ISA.md`, so neither can drift the way
the sentence it replaced did.

## Tests

```bash
bun test test/unit          # no Docker required
bun test test/integration   # real subprocesses, filesystem, git
bun test test/e2e           # full runs against the pifleet-fake-pi double
```
