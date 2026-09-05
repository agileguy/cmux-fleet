# Intervene

Correcting or stopping a worker mid-flight.

## Choose the right verb — they are not interchangeable

| Want | Command | Effect |
|------|---------|--------|
| Add a correction, keep the turn | `steer` | injects a mid-turn message; the worker keeps working |
| Release a staged, untriggered epoch | `unstage` | returns the worker to `idle`; **not** an abort |
| Cancel the current epoch | `abort` | on an attended (`tui`) worker this sends SIGINT and **stops the worker** |
| Stop the whole run | `down --run <id>` | ends the supervisor and its worker |
| Drop the task **and** the session | `./scripts/<console> --restart <id>` | stops the run and respawns that one pane; the other panes keep working |

**`abort` on a `tui` worker is not a soft cancel.** If the user wants the task
dropped but the worker kept, `unstage` is the verb when the epoch was never
triggered. Confirm with the user before `abort` on an attended worker.

**A bare `--restart` kills the running task too.** It stops the run holding the
worker without waiting — it is the deliberate way to end a task that has gone
wrong *and* clear the session that led it there, but it is destructive and
needs the user's word. The waiting, non-destructive form is
`--restart <id> --task <file>`, which refuses rather than interrupt.

## Steering

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts steer \
  --worker <id> --run <run-id> -m "<the user's correction, verbatim>"
```

The cardinal rule applies here too: relay the correction as written. Do not
rephrase it into instructions you think are clearer.

## Handing over the terminal

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts tui --worker <id> --run <run-id>
cd ~/repos/cmux-fleet && bun run src/cli/index.ts attach --worker <id> --run <run-id>
```

`tui` gives a person the pane (return it with `--leave`); `attach` just focuses
it. A worker a person owns has no RPC surface, which is why dispatches to it
come back `via: "staged"`.

`attach` refuses for a worker started with `up --attach-here`: that records the
surface but not the pane around it, so there is no pane to focus — its pane is
the one it was started in. The refusal says so; it is not a fault.
