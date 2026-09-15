# DispatchTask

Send one instruction to one worker.

## Before anything else

Re-read the **CARDINAL RULE** in `SKILL.md`. The user's instruction is the
brief, verbatim. You are not allowed to answer the question yourself on the way
to asking someone else.

## Steps

**1. Write the task envelope.** Four fields; nothing else is required. This
comes first because the preferred dispatch path takes the envelope and resolves
the run id itself.

```json
{
  "task_id": "T-<short-slug>",
  "title": "<a few words, yours, for the status table>",
  "brief": "<THE USER'S INSTRUCTION, VERBATIM>",
  "deadline_s": 900
}
```

- `task_id` must be unique within the run. A slug of the request is fine.
- `title` is the only field you author. Keep it to a label — the brief carries
  the meaning.
- `brief` is the user's words. Do not correct grammar, expand acronyms, add
  context, or append "please also check X".
- `deadline_s` — 900 for a query, longer for build/refactor work.

Write it to the scratchpad, not into the repo.

**2. Dispatch into a freshly recreated worker.** This is the default path.

```bash
cd <the project the task is about> && \
  ~/repos/cmux-fleet/scripts/development --restart <id> --task <envelope.json>
```

It waits for the worker to finish whatever it is holding, recreates that one
pane, and dispatches into the run it comes back in. It **refuses having stopped
nothing** if the worker does not settle, so a refusal is safe and its message
names what is holding it. `scripts/operations` takes the same two flags for
`obs-1` and `tick-1`.

The working directory matters: **it becomes the repository the worker works
on**, as a worktree at `/workspace`. Run it from the repository the task is
about; run it from `~/repos/cmux-fleet` and the worker gets cmux-fleet. See
**Choosing a worker's platform** in `SKILL.md`.

*Dispatching into a worker's existing session instead* — only when the user
asks for it, or when the worker has never been dispatched to since it came up
(for `obs-d1` and `obs-v1` that condition is not something to check: this is
the only path there is for either seat, dispatched-before or not — see
"Reaching a seat that no console plans" below):

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json   # run id
cd ~/repos/cmux-fleet && bun run src/cli/index.ts dispatch \
  --worker <id> --run <run-id> --task <path> --json
```

Each console worker sits in its own run: find the object whose `workers[].id`
matches and take that object's `run_id`. `accepted: true` is the goal. `via`
may be `rpc` or `staged`; both are success (see Gotchas in `SKILL.md`).

**Be suspicious of an answer that arrives implausibly fast on a reused
session** — a `tui` worker keeps its history, and this fleet has replayed the
previous task's answer as though it were new work. That is what step 2 exists
to prevent.

**3. Confirm it started, and that it is working on the right thing.**
Poll once after ~30s:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --run <run-id> --json
```

`phase: busy` with a growing `transcript_activity.entries` means it is working.
`phase: idle` with a `staged_task_id` set means it was staged and has not been
triggered — say so rather than waiting silently.

`busy` is not the same as *correct*. If the task names a repository, read the
opening transcript entries and check `/workspace` is the one it meant:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts transcript --worker <id> --run <run-id>
```

A worker reading a `package.json` when it was asked about a python project is
on the wrong repository — which means the console was launched from the wrong
directory, not that the worker misread the brief. Catch it in the first minute
rather than at the deadline: it does not announce itself, and the fleet stays
green throughout.

**4. Wait.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts wait \
  --task <task-id> --run <run-id> --timeout 20m --json
```

Run this in the background for anything non-trivial so the turn is not blocked.

**5. Collect and RELAY.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts \
  --task <task-id> --run <run-id> --json
```

Present the worker's answer as the worker's answer. If the verdict is `failed`,
report the verdict and the reason — do not go and do the task yourself to cover
the gap unless the user asks.

**Read the verdict's reason before believing it.** Harvest grades a success
claim against the git facts in `/workspace`, so a task done properly in a clone
under `~/repos` produces an empty diff and is failed under ISC-93 — a genuine
result reported as a fabrication. `wait` is the less reliable of the two: it has
reported `success` on tasks that never started. When they disagree, check the
transcript.

## Docker and VM inquiries (`obs-d1`, `obs-v1`)

A brief for `obs-d1` (`observer-docker`) or `obs-v1` (`observer-vm`) still fits the
same four-field envelope from step 1. `inputs[]` reaches no prompt
(`Docs/SRD-OBSERVER-ROLES.md` §5.3, §6.3), so everything the worker acts on — the
target, what to check on it, and how far back to look — travels as prose inside
`brief`, exactly as it does for any other worker. **The CARDINAL RULE governs this
brief the same as any other:** it is the user's words verbatim, and writing the
envelope is CONFIGURING the dispatch, not only sending it (`SKILL.md`'s "This
applies to CONFIGURING a console, not only to dispatching one"). Resolving a
target token, a container name, a systemd unit or a `checks` list on the user's
behalf before you write the brief is the same violation as resolving a namespace
before briefing an observer — do not do it, even to make the brief look complete.

What belongs in a Docker inquiry brief, in prose (`Docs/SRD-OBSERVER-ROLES.md` §5.3):

- the **target** — a token from the operator's enrolled inventory
- the **containers** to look at, or a **selector** (`label=<key>=<value>` or
  `name=<pattern>`) in their place
- the **checks** to run — some of `state`, `health`, `logs`, `stats`, `events`
- the **window** to look back over, e.g. `300s`

What belongs in a VM inquiry brief (`Docs/SRD-OBSERVER-ROLES.md` §6.3):

- the **target**
- the **units** to look at — zero or more systemd unit names
- the **checks** to run — some of `reachability`, `system`, `units`, `logs`,
  `resources`, `cloud`
- the **window**

`cloud` is listed for completeness, not because `obs-v1` can act on it:
`roles/observer-vm.md` gives this role `cloud_access: false`, so `cloud` is
always recorded `not_attempted` by this role regardless of what the brief
asks — not a channel its worker will ever actually call.

**None of these is yours to supply.** If the user's instruction leaves one out,
leave it out of the brief too — `obs-d1` and `obs-v1` hold the defaults (a lone
enrolled target, `state, health, logs` or `reachability, system, units, logs`,
`300s`) and name, in the artifact, which default they applied. That is the
worker's job, and it is the whole reason the role exists: filling a field in "to
be helpful" hides that the worker never got to say so, and a target or container
you guessed at becomes a wrong name the worker will trust.

### Reaching a seat that no console plans

`obs-d1` and `obs-v1` are `pane_mode: rpc` and in no console (`SKILL.md`'s fleet
table). Step 2's default — `./scripts/<console> --restart <id> --task <file>` —
does not reach either: `--restart` is a verb `scripts/operations`,
`scripts/development`, `scripts/review` and `scripts/triage` each implement for
their own panes, and none of the four plans a pane for these two seats. Use step
2's other path instead:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json   # run id, if it is already up
cd ~/repos/cmux-fleet && bun run src/cli/index.ts dispatch \
  --worker <obs-d1|obs-v1> --run <run-id> --task <path> --json
```

This is not the "only when…" alternative step 2 describes for a console
worker — for `obs-d1` and `obs-v1` it is unconditional. Neither seat has a
`--restart` path to prefer over it, whether or not the seat has been
dispatched to before.

If `status --all --json` shows no run holding the seat yet, bring it up first.
`up --workers <ids>` takes a comma-separated subset of `workers:`
(`src/cli/commands/up.ts`):

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts up --workers obs-d1
```

Both roles carry `isolation: none` (`Docs/SRD-OBSERVER-ROLES.md` §5.5, §6.6), and
a `none` role gets no `/workspace` at all (`skills/pifleet-worker/SKILL.md`). `up`
still takes the run's repository from the launch directory
(`src/cli/commands/up.ts`), but neither seat has a checkout to put it in, so where
you run `up --workers` from does not change what these two can see.

**From source, not a guess:** a bare `up --workers <id>` against a seat that
already has a run neither recreates it fresh nor collides with it. `up` calls
`newRunId()` unconditionally on every invocation, and each worker's container
is named from that run id (`src/config/render.ts`) — so the seat gets a
second container holding the same delivered key, while the earlier run is
left running under the same worker id. The console scripts' idle-wait-then-
teardown behaviour (`SKILL.md`'s "A worker that has run before is not a clean
worker") is implemented in each console script, not in `up` itself, and
`obs-d1`/`obs-v1` have no console to give them the equivalent. Check
`status --all --json` for an existing run against the seat first, and tear it
down (`down --run <run-id>`) before bringing it up again — see
`Workflows/EnrolTarget.md` step 6 for the full reasoning.

## Dispatching to several workers

`pifleet dispatch --auto --tasks <list>` spreads a task list across idle
workers. Use it when the user asks for parallel work, not to split a single
instruction into pieces you invented.
