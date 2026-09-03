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
pifleet up --workers eng-1,rev-1 --backend headless   # build the run dir, start supervisors
pifleet dispatch --worker eng-1 --task task.json      # send a typed envelope
pifleet wait --all --timeout 20m --json               # block until every task settles
pifleet artifacts --all --json                        # adjudicated results
pifleet down --run <id>                               # quiesce, then stop
```

Supervisors are detached — their own session and process group — so they outlive the CLI that
started them. `up` is not "fire and forget": it returns only once every worker has reached
`idle`, and exits nonzero naming the laggards if they do not.

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

**Sixteen criteria are unattempted `[ ]`, and they are the only unmet ones.** The block
ISC-468..ISC-493 was filed 2026-09-02 as the done-condition for a read-only fleet-monitor
TUI (`Docs/SRD-FLEET-MONITOR.md` v0.2), **before any of it was built** — deliberately, so the
criteria are the specification rather than a description of what was written. The data plane
and the activity ladder have since landed and eight are graded `[x]`.

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
Sixteen criteria are unattempted `[ ]` — what remains of the fleet-monitor
block (see above). Every other criterion has been attempted. Eleven are graded `[~]`
(see `ISA.md`), which in this repo means the behaviour is built and re-checked but the *evidence*
falls short of the standard: ISC-331 has one unexercised surface (a live round trip); ISC-344,
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

Two are retired `[-]` — ISC-307 and ISC-360 — a marker introduced by ISC-368 on 2026-08-30 for a
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
