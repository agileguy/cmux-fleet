# Consoles

The four standing cmux workspaces.

| Console | Script | Panes |
|---------|--------|-------|
| operations | `./scripts/operations` | `obs-1` agent, `pifleet monitor`, `tick-1` agent |
| development | `./scripts/development` | `eng-1`, `eng-2`, `tst-1`, `tst-2` — four equal agent panes |
| review | `./scripts/review` | `col-1`, `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` — **four** agent panes: the collator full width on top, its three reviewers along the bottom, **plus a host process** (a 2x2 until 2026-09-13, when it was changed to match `triage`) |
| triage | `./scripts/triage` | `tri-1`, `obs-t1`, `obs-t2`, `obs-t3` — **four** agent panes: the collator full width on top, its three observers along the bottom, **plus a host process** |

The development console's fourth seat is `tst-2` on `role: tester`; `rev-1` is
gone, and review is the `review` console's job now. The review console's four
seats are `shared-ro` — they read the operator's checkout at whatever ref it
stands on, and the three reviewers hold no `bash`.

**This row has been wrong in BOTH directions and has now returned to its FIRST
spelling, which is why it is worth a paragraph rather than a correction.** It read
`tri-1, obs-t1, obs-t2, obs-t3` — "four equal agent panes" — until 2026-09-11,
when `obs-t2` and `obs-t3` were in neither config and `roles/triage.md` had been
telling the collator *"this console has exactly one observer"* the whole time this
table said three. It was corrected to two. On 2026-09-12 the console grew a real
second pair, so it was four again, by an edit to five files rather than by prose
outliving code. On 2026-09-13 the second COLLATOR became a third OBSERVER.

**So the seat list is once more the one this table first claimed — and this time
the seats behind it exist.** That is the distinction to check rather than the
spelling: `obs-t3` is now in `TRIAGE_CONSOLE_ASPECTS`, `TRIAGE_CONSOLE_ROSTER`,
`DEFAULT_TRIAGE_WORKERS` and the `workers:` block of both config files. The 2026-09-11
correction was made because none of that was true.

The shape is `tri-1` over `obs-t1`, `obs-t2` and `obs-t3`: one collator is handed
the WHOLE environment, divides it between the three observers itself (§6.5's
⌈N/3⌉ — a judgement the host checks rather than performs), and collates all three
replies into ONE document. The two-pair arrangement it replaced wrote two
documents the host had to merge and echo-check for staleness. Before repeating any seat list
from this file, read `DEFAULT_TRIAGE_WORKERS` in
`src/backends/cmux/operations-plan.ts` or the `workers:` block of `fleet.yaml` — a
pane count is exactly the kind of fact a prose table keeps after the code has
moved on, in whichever direction the code went.

**"No keyboard" came off that row with them, because it depends on which config
you mean.** All four triage seats inherit `pane_mode: rpc` from their roles in the
tracked `fleet.example.yaml`, and `scripts/triage` reads the mode from the config
rather than hard-coding it. But the operator's `fleet.yaml` — tracked since
2026-09-12, not gitignored as this line used to say — overrides
BOTH seats to `pane_mode: tui` with themes, on a 2026-09-07 decision recorded in
the file — *"the operator watches these panes, and a console nobody can see is a
console nobody trusts"* — and tracked `triage/console.yaml` corroborates it in
passing (*"6 was the value while the seats were rpc"*). Say which file you mean
before telling anybody this console cannot be typed at.

The git/monitor panes watch **the directory the script was run from** — and so
does something more consequential: **that directory becomes the run's
repository**. Every worker gets a worktree of it at `/workspace`, overriding
`run.repo` in `fleet.yaml`. Run from `~/repos/cmux-fleet` and the workers work
on cmux-fleet; run from `~/repos/rally-cli` and they work on rally-cli.

Two cases fall back to the configured `run.repo`: the fleet's own repo (or a
subdirectory of it), and a directory that is not a git checkout — `up` builds
worktrees, so it needs one.

So: run from the repo root for a console that works on the fleet itself, and
from the project's root for a console that works on something else. **This is
the single most consequential thing about opening a console**, and it is silent
if you get it wrong — the run comes up healthy and the workers do good work on
the wrong codebase.

## Opening

```bash
cd ~/repos/cmux-fleet && ./scripts/operations
cd ~/repos/cmux-fleet && ./scripts/development
cd ~/repos/cmux-fleet && ./scripts/review
```

Running any of them twice is safe and is the intended way back to a console: an
existing workspace is **selected, not rebuilt**. `review` adds one condition —
a `review` workspace whose panes are not this console's is **refused rather
than adopted**.

## The review console has a fifth process

Four panes are four workers and **none of them is the actor**. A collator cannot
dispatch: all it can do *toward a fan-out* is write `dispatch-request.json` into
its outbox. (It is not otherwise mute — `col-1` holds `submit_report`, which is
what produces the collation row of the table below.) Something host-side has to
read that request and perform the three dispatches, and that something is
`pifleet relay`. Without it the console has four healthy workers and no way for
a collator's request to become three reviews.

`./scripts/review` starts one, last, after the panes. What the relay then does is
the whole review mechanism, and every file it writes is host-written — which is
why coverage is counted from these and never from the collation:

| Step | Where it lands |
|------|----------------|
| the collator asks for a fan-out | `<run>/outbox/col-1/<parent>/dispatch-request.json` |
| the relay dispatches the three lenses and journals it | `<run>/relay/col-1/<parent>.json` → `children[]` |
| each surviving reply is published back | `<run>/replies/col-1/<child>.json` (read-only to the collator) |
| the relay dispatches the collation | task `<parent>-collate`, whose `files/collation.json` and `files/review.md` are the product |

Its own bookkeeping is in `~/.pifleet/`: `review-relay.json` (the record — `pid`,
`started`, `run_id`, `pinned`, `workers`), `review-relay.log` (appended, never
truncated) and `review-relay.lock`.

```bash
cd <the project> && ~/repos/cmux-fleet/scripts/review              # start/adopt, and start the relay
cd ~/repos/cmux-fleet && ./scripts/review --no-relay               # panes only; you run `pifleet relay` yourself
cd ~/repos/cmux-fleet && ./scripts/review --relay-stop             # stop the actor, touch no pane
```

**On a fresh create the relay is deliberately NOT started, and that is not a
fault.** The four `pifleet up`s have not finished when the script returns, so no
run exists to point a relay at, and the script does not block — `up` runs the
tool-call gate over every allowlisted model, up to ~7.5 minutes worst case. The
remedy it prints is the one this file already calls the way back: **run
`./scripts/review` again once the panes are up.** It is idempotent — a live relay
serving this console is left alone, one serving a different run is replaced, and
two invocations racing cannot both spawn.

A record it cannot verify (`unreadable`, or a pid whose identity cannot be
confirmed) is **left exactly where it is and nothing is signalled**. The script
says so and starts nothing; find out what that pid is, then remove the file.

## The triage console has an actor too — the fifth process behind its four panes

Same shape as review, different reason. `tri-1` is a collator, and the thing a
collator cannot do is **dispatch**: all it can do toward a sweep is write
`dispatch-request.json` and let something host-side act on it. But where the
review console's actor waits for an operator to ask for a review, **this one is
also the clock** — it decides when a sweep happens, forever, without being asked.
That is the whole difference, and it is why this console is the only one whose
own modules are held read-only by a test that walks their import closure.

**That is a limit on dispatching, not on writing, and this paragraph said `tri-1`
could write `dispatch-request.json` *"and nothing else"* until 2026-09-11.** The
`triage` role grants `submit_report` beside `dispatch_request` (its `tools:` line
in `fleet.example.yaml`), and `roles/triage.md` spends a section telling `tri-1`
to pass `triage.json` and `triage.md` as two entries of ONE `submit_report` call
— which is how a sweep produces anything a person can read. Read a role's
`tools:` list before describing any seat's reach from this file.

The tick is `triage/console.yaml`'s `cadence_s`, and **it is 900 — a sweep every
fifteen minutes, 96 a day**. This paragraph said *"every five minutes"* until
2026-09-11; the cadence was widened because a 35B observer could not finish inside
a 300-second tick's derived deadline (`sweep_deadline_s` is `cadence_s - reserve_s`
and is not a field: 900 − 120 = 780). Read the number out of that file rather than
out of this one.

The actor is `pifleet triage`, not `pifleet relay`:

```bash
cd ~/repos/cmux-fleet && ./scripts/triage                 # panes, then the actor
cd ~/repos/cmux-fleet && ./scripts/triage --no-actor      # panes only; you run the actor by hand
cd ~/repos/cmux-fleet && ./scripts/triage --actor-stop    # stop the actor, touch no pane

pifleet triage --once             # one sweep, now. The exit code means something
pifleet triage --poll             # the loop, at triage/console.yaml's cadence
pifleet triage --status [--json]  # the actor record and the incident record set
```

Its bookkeeping sits beside review's, per console: `~/.pifleet/triage-relay.json`
(the record — `pid`, `started`, `runs`, `workers`, `cadence_s`, `sweep_cursor`,
`consecutive_skips`, `recycled_at`), `triage-relay.log` (appended, never
truncated) and `triage-relay.lock`. **The incident records are separate** and live
under `~/.pifleet/triage/<environment>/<service>.json`, with console-health
incidents at `<scope>/_console/<kind>.json`.

**Three things this console will not do, and each is deliberate.** It will not
call a service healthy because nobody reported on it — an observer that produced
nothing is a coverage gap and it says so. It will not notify twice about one
incident: a service down all day is one message plus its reminders. And it cannot
command the fleet — the two privileged things it genuinely needs, dispatching a
sweep and recycling a seat, are built at the composition root and handed in as
plain functions, so no module the console owns can reach them.

**`--cadence` reaches the actor as `--poll <seconds>`, and only when you type it.**
A bare run passes no `--poll` at all, so `triage/console.yaml`'s `cadence_s` stays
the source. Combined with `--actor-stop` or `--no-actor` it is refused — there is
no actor for it to reach, and dropping an override silently is worse than
declining it. `./scripts/triage --dry-run --cadence 5m` prints the actor's argv
without starting anything.

**A second `pifleet triage --poll` against a held lock refuses by name and exits
nonzero**, dispatching nothing. That is not an error to route around: it means an
actor is already serving this console. A lock left by a *dead* pid is taken over
automatically, so the remedy after a crash is to run it again, not to delete a
file.

## Restarting one worker

**This is almost always what is wanted**, and it is not a console rebuild:

```bash
cd <the project> && ~/repos/cmux-fleet/scripts/development --restart tst-1
cd <the project> && ~/repos/cmux-fleet/scripts/operations  --restart tick-1
cd <the project> && ~/repos/cmux-fleet/scripts/review      --restart rev-ctx-1
```

One pane is respawned; **the others are not touched**, and the script says so.
The pane keeps its working directory, so the worker returns with the same
mounts — same repository, same image — just without the previous session. The
order inside the script is stop-the-run-then-respawn-the-pane, never the other
way round: respawning first kills the pane's shell and orphans the container its
supervisor owns.

Add `--task <envelope.json>` to make it recreate-then-dispatch. That form
**waits for the worker to finish anything it is holding first** and refuses,
having stopped nothing, rather than recreating over live work. `DispatchTask`
covers it.

**On `review`, this is how a review round is started:**

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/review --restart col-1 --task <review-env.json>
```

That is the fresh-collator-then-dispatch form — wait for `col-1` to hold nothing,
stop its run, respawn its pane, dispatch the envelope into the run it comes back
in, then restart the relay. It matters more here than anywhere else that the
session is fresh: **a reviewer's or collator's previous task IS a review**, so a
stale answer is a plausible-looking review of the wrong change. The dispatch's
exit status is checked, so a refused envelope is reported rather than printed as
a success — measured once as *"recreated col-1 … and dispatched"* with exit 0
and nothing in the inbox.

**Restarting ANY review pane restarts the relay too, and that is required rather
than tidy.** The relay holds `--run` for the collator and a `PIFLEET_RELAY_RUNS`
pin for the other three, both fixed for the life of the process; a relay left
pointing at a run that no longer exists polls forever in silence, and a pinned
worker it cannot resolve refuses every fan-out. The script stops it before
touching a pane and starts it again after.

`operations` addresses its panes by **title** rather than worker id, because
its panes are not all agents. `development` and `review` use the worker id.

## Recreating the whole console

```bash
cd ~/repos/cmux-fleet && ./scripts/operations --recreate
cd ~/repos/cmux-fleet && ./scripts/development --recreate
cd ~/repos/cmux-fleet && ./scripts/review --recreate
```

`--recreate` **stops every run the old panes created** before building the new
ones. That is a teardown of live agents — as many as three bystanders for one
wedged worker on a four-pane console, `triage` included since it grew its second
pair. Use it when the *set*
of workers changes or the pane layout is wrong; use `--restart` for everything
else.

`development` and `review` are **four runs each**, because every pane is
attended and `--attach-here` hands over the terminal of the process that runs it.
`review --recreate` stops its relay first, before those runs go down, since the
relay's whole configuration is their run ids. `triage` is **four** runs on the same
rule, since 2026-09-12. Only runs holding that console's own workers are stopped — the other three
consoles survive a rebuild.

**Known defect:** it stops the runs *before* closing the workspace, and the
close can then fail on a pinned workspace with
`protected: Pinned workspaces can't be closed while pinned` — leaving the
console half-torn-down, agents already gone. Recover with
`cmux workspace-action --action unpin --workspace <id>` and retry.

**Check first, and say what you found:**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json
```

If any worker has a non-null `task_id`, tell the user which one and what it is
doing before rebuilding. If every worker is `idle`, note that and proceed —
"nothing was in flight" is the fact that makes the teardown uncontroversial.

## Preview without touching anything

```bash
cd ~/repos/cmux-fleet && ./scripts/operations --dry-run
cd ~/repos/cmux-fleet && ./scripts/review --dry-run
```

Prints the pane plan and exits — the workspace name, the cwd, and each pane's
title and command. Useful for confirming which pifleet commands a console will
run, for checking the monitor pane is present, and for diagnosing a bad
`--workers` list without needing the GUI at all.

## After recreating

Verify rather than assume:

- `status --all` — every expected worker back, `alive: true`, on a **new** run id
- old supervisor pids gone (`ps -p <pid>`)
- `session_present: false` on the fresh workers is correct, not a fault
- on `review`: `~/.pifleet/review-relay.json` names the **live** collator run. A
  record pointing at a dead run is a relay polling nothing, and the fix is to run
  `./scripts/review` again

## Choosing the platform

A console builds each worker from the image its role names in `fleet.yaml`
(`toolchain: base|node|python|go|full`). Changing it needs the image built
before `up` will use it, because the tag is a hash over the build context:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts image build --toolchain python
```

Skip that and `up` refuses a stale tag — which is the good outcome. The bad one
is forgetting a role that shares the changed stage: after a Dockerfile change,
**every toolchain in use needs rebuilding**, not just the one being edited. A
worker that never comes back from a restart is usually this.

Verify what a worker actually got, rather than what was configured:

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
docker exec -u 10001 <container> sh -lc 'python3 -V; bun --version; ls /workspace'
```

The toolchain table is in `SKILL.md`. The rule worth remembering: **every
language toolchain includes node**, so choosing `python` adds pytest without
taking `bun` away.
