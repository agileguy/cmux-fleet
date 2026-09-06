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
asks for it, or when the worker has never been dispatched to since it came up:

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

## Dispatching to several workers

`pifleet dispatch --auto --tasks <list>` spreads a task list across idle
workers. Use it when the user asks for parallel work, not to split a single
instruction into pieces you invented.
