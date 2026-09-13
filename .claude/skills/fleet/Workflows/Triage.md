# Triage

The fourth console, and the only one that runs without being asked. It sweeps an
environment on a clock and tells the operator when something is wrong — or, just
as often, when it **cannot tell**, which is the distinction the whole design turns
on.

Design: `Docs/SRD-TRIAGE-CONSOLE.md`. What is actually proved about it: `ISA.md`.

---

## CARDINAL RULE — THIS CONSOLE REPORTS; IT DOES NOT ACT

Nothing here fixes anything. The triage console has **no mutating verb, no
control-socket client and no ledger writer** reachable from any module it owns —
that is enforced by a test that walks its transitive import closure, with exactly
one permitted exception, and the two privileged effects it genuinely needs
(dispatching a sweep, recycling a seat) are built at the composition root and
handed in as plain functions.

So when a sweep says `mia` is unhealthy: **that is the end of this console's
job.** Fixing it is `obs-1`, `sre-1`, or a human. Do not go looking for a
`pifleet triage --restart-the-service` — it does not exist and its absence is a
design property with a test behind it.

---

## Starting it

```bash
cd ~/repos/cmux-fleet && ./scripts/triage            # four panes, then the actor
cd ~/repos/cmux-fleet && ./scripts/triage --no-actor # panes only, actor by hand
cd ~/repos/cmux-fleet && ./scripts/triage --actor-stop
```

**Four seats: ONE COLLATOR OVER THREE OBSERVERS** as of 2026-09-13. `tri-1`
composes the sweep request and collates the replies; `obs-t1`, `obs-t2` and
`obs-t3` each sweep a share of the environment. The collator's envelope carries
the WHOLE declared service list and names all three seats.

**The partition is the COLLATOR's to make, and that is what `roles/triage.md` now
tells it**: one entry per observer inside one `requests[]` file, the union
covering every declared service exactly once. This is §6.5's ⌈N/3⌉ — *"the
partition is the triage worker's to make"*. The host checks the union and refuses
`partition_incomplete` or `partition_duplicate`; it does NOT choose the shares and
does not refuse a lopsided one.

**The role prompt asks for an EVEN split for a measured reason.** The three
observers run concurrently against one shared deadline, so a sweep costs the
largest share rather than the sum. On T-sweep-116 — the last sweep of the two-pair
arrangement — an observer handed four services spent its entire 480s deadline and
wrote no artifact, so all four came back `unobserved`. The deadline is now 600s
(`triage/console.yaml`), and three seats make nine services three each.

**READ THIS BEFORE REPEATING THE COUNT, because this line has been wrong in BOTH
directions.** It said *"Four seats … `obs-t1`/`obs-t2`/`obs-t3` … one share
each"* until 2026-09-11, when `obs-t2` and `obs-t3` existed in no config and no
roster — a sentence that rotted upward while the code shrank under it. It is four
again now, by a real edit rather than by drift: `TRIAGE_CONSOLE_ROSTER`
(`src/run/dispatch-request.ts`), `DEFAULT_TRIAGE_WORKERS`
(`src/backends/cmux/operations-plan.ts`), `TRIAGE_CONSOLE_ASPECTS`
(`src/run/task-ids.ts`), and the `workers:` blocks of both `fleet.yaml` and
`fleet.example.yaml`. The standing warning is unchanged and applies to this
sentence too: **verify the count against one of those before repeating it.**

Both seats run a **local** `gemma-4-26b-a4b-it-bf16`. The model has moved twice —
`gpt-oss-20b-MXFP4-Q8` under the 2026-09-03 decision, then a hosted trial on
`obs-t1` that was taken and withdrawn on the same day — but D1 has not moved: it
is about whether an observer's context may leave the machine, not about speed.
`fleet.yaml` is gitignored, so **read the model out of it rather than out of
here.**

**On a fresh create the actor is deliberately not started**, the same as review:
the `up`s have not finished when the script returns, so there is no run to point
an actor at. Run `./scripts/triage` again once the panes are up. It is
idempotent.

---

## Driving the actor

```bash
pifleet triage --once             # one sweep, now
pifleet triage --poll             # the loop, at triage/console.yaml's cadence
pifleet triage --status [--json]  # the actor record and the incident record set
```

| Need | Command |
|------|---------|
| Is anything wrong right now | `pifleet triage --status --json` |
| Sweep immediately, don't wait for the clock | `pifleet triage --once` |
| Run it unattended | `pifleet triage --poll` (or let `scripts/triage` start it) |
| Stop it | `./scripts/triage --actor-stop` |

**`--once`'s exit code means something** and `--poll`'s catch-and-continue is
deliberately not extended to it: a single pass is somebody's command, so a throw
propagates. The loop catches and continues, because an actor that dies on one bad
sweep is an actor that stops watching.

---

## Reading what it says

**`--status` has three fields and no aggregate**, on purpose: *"quiet"* and
*"could not speak"* must never collapse into one row. Sweeps completed is `null`
rather than `0` when no actor record exists — a console that never started and one
that started and has not finished a sweep are different conditions.

Incident records live under `~/.pifleet/triage/<environment>/<service>.json`;
console-health incidents — the console complaining about itself — are at
`<scope>/_console/<kind>.json`. There are seven console-health kinds: an observer
`blocked`, a sweep that produced nothing, skips reaching the threshold, inference
saturated, inference unreachable, the run's budget exhausted, and the reporter's
own delivery failing.

---

## What it will NOT do, and why each matters

**It will not call a service healthy because nobody reported on it.** An observer
that produced no artifact is a coverage gap; three consecutive blind sweeps open
an incident whose reason is `coverage`, not `unhealthy`. A console that reported
silence as health would be worse than no console.

**It will not notify twice about one incident.** A service down all day produces
one `opened` plus its reminders at the re-notify floor — not 96 messages. A
service flapping produces one message about the flapping.

**It will not report a recovery it did not observe.** `unhealthy → indeterminate`
is not a recovery; a clear requires a positively observed healthy row *with
evidence*. This is the single most damaging message the console could send, and
it is the one it is most carefully stopped from sending.

**It will not blame your cluster for its own outage.** If the inference endpoint
is saturated or unreachable, the sweep says *that*, names the provider and model,
and suppresses the coverage escalation — rather than reporting three services
down because nobody could answer.

---

## Gotchas

- **`--cadence` reaches the actor as `--poll <seconds>`, and only when you type
  it.** A bare run passes no `--poll` at all, so `triage/console.yaml`'s
  `cadence_s` stays the source. Combined with `--actor-stop` or `--no-actor` it
  is refused — there is no actor for it to reach, and dropping an override
  silently is worse than declining it. `./scripts/triage --dry-run --cadence 5m`
  prints the actor's argv without starting anything.
- **A second `pifleet triage --poll` against a held lock refuses by name and exits
  nonzero**, dispatching nothing. That is not an error to route around: an actor
  is already serving this console. A lock left by a **dead** pid is taken over
  automatically, so the remedy after a crash is to run it again — not to delete a
  file.
- **The console does NOT currently recycle itself** — `triage/console.yaml` sets
  `recycle_after_sweeps: 0`, and `0` disables it. The mechanism is real, and this
  is what it does when enabled: every N sweeps it takes both seats down and back
  up, to stop a day's transcript accumulating into one session, between sweeps and
  never during one, and a recycle interrupted half way is *finished* by the next
  boundary rather than restarted. It is off because the recycle is a **headless**
  `up`, which creates no pane and so cannot bring a `tui` seat back — measured
  2026-09-07, the console died at 15:57 that way. **`tui` seats and self-recycle
  are mutually exclusive: if `recycle_after_sweeps` goes back above `0`, the seats
  go back to `rpc` in the same edit.** Until then the job it did is done by hand
  with `./scripts/triage --recreate`, and the cost of not doing it is real — the
  collator keeps its session between dispatches, so a model holding several
  previous sweeps answers from what it already has.
- **A recycle moves the collator into a new run, and that is not the console
  going away.** The abandonment watch follows a run *this actor minted*; a `tri-1`
  that appears in a run somebody else minted still means the console it was
  started for is gone.
- **`pifleet triage --status` works with no run at all.** It is the one surface
  that must answer when the sweep half cannot.

---

## Standing one up, from the first live run (2026-09-07)

**`./scripts/triage` twice is not a workaround, it is the procedure.** The first
call builds both panes and deliberately starts no actor; the two `up`s are still
running when it returns. The second call starts the actor. If the first says
*"workspace … is already in place — selected it, changed nothing"* while
`status --all` shows no `tri-1`, the workspace is a stale shell from an earlier
session and `--recreate` is what rebuilds its panes.

**Set BOTH placeholders in `triage/targets.yaml` before the first sweep, and set
them in the right place.** The file says which two — `kube_context` and
`namespace` — and §0.3 keeps them out of it, because it is tracked.

- `kube_context` is a LOGICAL token. If your filtered kubeconfig still carries
  GKE's generated `gke_<project>_<region>_<cluster>`, **rename it there** —
  `kubectl --kubeconfig <copy> config rename-context <generated> <env>` — rather
  than pasting the generated name into the targets file, which would commit a
  cloud project id. The console refuses to start until the two agree, and that
  refusal is the design working (§6.10, D11).
- The services are the OPERATOR's to name. Do not go and enumerate namespaces or
  workloads to fill them in — see the cardinal rule in `SKILL.md`; that is the
  observers' discernment and handing it to them pre-decided is how a host's typo
  becomes a coverage incident.

**The actor's lock outlives a console you replaced.** `--actor-stop` stops an
actor only *once it has written `triage-relay.json`*, which it does at the end of
its FIRST completed sweep and not before — so an actor whose every pass failed
cannot be stopped that way and will refuse the next one with *"another triage
actor holds …/triage-relay.lock"*. The lock file names its pid; a lock held by a
DEAD pid is taken over automatically, so the remedy after a crash is to run the
script again rather than delete a file.

**`fleet.yaml` is gitignored.** Changing the triage seats' `pane_mode` or model
is a local edit that no commit will carry to another machine — say so rather than
reporting it as a change that landed.
