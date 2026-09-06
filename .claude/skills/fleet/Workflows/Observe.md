# Observe

Answering "what is the fleet doing" without touching it.

## Snapshot

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json
```

Per worker: `alive`, `phase` (`idle`/`busy`/`dead`), `task_id`,
`staged_task_id`, `pid`, `session_present`, and `transcript_activity`
(`{entries, last_growth_at}`).

**`transcript_activity` is how you tell working from wedged.** A `busy` worker
whose `entries` count is not growing and whose `last_growth_at` is minutes old
is stuck, whatever `phase` says. A `null` here on an attended worker used to be
a reporting defect (ISC-492) and is now a real signal.

## Live view

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts monitor --repo ~/repos/cmux-fleet
```

Read-only TUI: runs, workers, containers and git on three separate clocks. Four
views — fleet, events, worker detail, run report — selected with `--view` plus
the selection that view needs (`--worker`, `--run`). It writes nothing and
spawns only `docker ps`.

This is also the operations console's middle pane, so the user may already be
looking at it.

## What a worker actually said

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts transcript --worker <id> --run <run-id>
cd ~/repos/cmux-fleet && bun run src/cli/index.ts logs --worker <id> --run <run-id> --follow --render
```

Use the transcript when the artifacts are missing or the verdict is confusing —
`harvest` can rebuild a verdict from it when the envelope never landed.

## Results

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts --task <task-id> --run <run-id> --json
cd ~/repos/cmux-fleet && bun run src/cli/index.ts report --run <run-id>
```

`worktrees` lists each worker's own git checkout, branch, and whether it is
clean — the right first call before assuming a worker's changes are lost.
