# Triage

The fourth console, and the only one with no keyboard. It sweeps an environment
on a clock and tells the operator when something is wrong — or, just as often,
when it **cannot tell**, which is the distinction the whole design turns on.

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

Four seats: `tri-1` collates, `obs-t1`/`obs-t2`/`obs-t3` observe one share of the
environment's services each. All four run a **local** `gpt-oss-20b-MXFP4-Q8` — an
owner decision, recorded as D1, and it is about whether an observer's context may
leave the machine rather than about speed.

**On a fresh create the actor is deliberately not started**, the same as review:
the four `up`s have not finished when the script returns, so there is no run to
point an actor at. Run `./scripts/triage` again once the panes are up. It is
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
one `opened` plus its reminders at the re-notify floor — not 288 messages. A
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
- **The console recycles itself.** Every `recycle_after_sweeps` sweeps it takes all
  four seats down and back up, to stop a day's transcript accumulating into one
  session. It does this between sweeps, never during one, and a recycle
  interrupted half way is *finished* by the next boundary rather than restarted.
- **A recycle moves the collator into a new run, and that is not the console
  going away.** The abandonment watch follows a run *this actor minted*; a `tri-1`
  that appears in a run somebody else minted still means the console it was
  started for is gone.
- **`pifleet triage --status` works with no run at all.** It is the one surface
  that must answer when the sweep half cannot.
