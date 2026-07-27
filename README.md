# cmux-fleet

`pifleet` — orchestrate a fleet of containerized [Pi](https://pi.dev) coding agents, optionally
surfaced as [cmux](https://cmux.com) panes, and harvest their work as structured artifacts.

The design lives in [`Docs/SRD.md`](Docs/SRD.md). The done-condition lives in [`ISA.md`](ISA.md).

## Why

A pane is a *view*, not a channel. Every control-plane fact comes from the Pi RPC stream, the
session transcript, or the worker's outbox — never from scraped pane text. Closing a pane, or
never opening one, changes nothing about a run.

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
timeout and a dead worker without ambiguity: `2` usage/config · `3` backend unavailable ·
`5` budget ceiling · `6` worker died · `4` timeout · `7` partial · `0` success.

## A run, end to end

```bash
pifleet up --workers eng-1,rev-1 --backend headless   # build the run dir, start supervisors
pifleet dispatch --worker eng-1 --task task.json      # send a typed envelope
pifleet wait --all --timeout 20m --json               # block until every task settles
pifleet artifacts --all --json                        # adjudicated results  (Phase 2)
pifleet down --run <id>                               # quiesce, then stop
```

Supervisors are detached — their own session and process group — so they outlive the CLI that
started them. `up` is not "fire and forget": it returns only once every worker has reached
`idle`, and exits nonzero naming the laggards if they do not.

## Status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Interface verification | done (see SRD §4) |
| 1 | Container + headless core | done — `up → dispatch → wait → down` green on `headless` and against real Pi 0.79.6 |
| 2 | Artifacts + safety | next — outbox contract, harvester, adjudicator, worktree isolation, budget ceilings, kill ladder |
| 3 | Security + cloud identity | pending |
| 4 | Panes | pending |
| 5 | Orchestration | pending |
| 6 | Attended mode | pending |

Commands belonging to a later phase exist and refuse rather than pretending: `artifacts`
reports that it is a Phase 2 deliverable, `up --backend cmux` exits 3.

## Tests

```bash
bun test test/unit          # no Docker required
bun test test/integration   # real subprocesses, filesystem, git
bun test test/e2e           # full runs against the pifleet-fake-pi double
```
