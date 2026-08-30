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

All six phases are done. 2510 tests pass, 123 skip, 0 fail across 166 files (`test` job, CI on `main`).

| Phase | Deliverable | State |
|---|---|---|
| 0 | Interface verification | done (see SRD §4) |
| 1 | Container + headless core | done — `up → dispatch → wait → down` green on `headless` and against real Pi 0.79.6 |
| 2 | Artifacts + safety | done — outbox contract, harvester, adjudicator, worktree isolation, budget ceilings, kill ladder |
| 3 | Security + cloud identity | done — egress allowlist, network lifecycle, repo hazard scan, cloud identity, control-socket auth |
| 4 | Panes | done — cmux/tmux backends, `attach`, live pane viewer |
| 5 | Orchestration | done — `dispatch --auto` DAG scheduling, `pifleet report`, `pifleet logs` |
| 6 | Attended mode | done — `steer` / `abort` / `exec`, `tui` pane hand-off, voided-requirements table |

No ISA done-condition criterion is unattempted — there are zero `[ ]`. Six are graded `[~]`
(see `ISA.md`), which in this repo means the behaviour is built and re-checked but the *evidence*
falls short of the standard: ISC-307 and ISC-331 each have one unexercised surface (a stderr line,
a live round trip); ISC-344, ISC-349 and ISC-350 ship guidance to workers, and a grep proving an
instruction was shipped cannot observe a worker obeying it; ISC-360 holds documentation that is
now accurate about an unbuilt feature, where the guard re-checks the code half and not the prose.
The two that left this list on 2026-08-30 — ISC-306 and ISC-339 — were scope decisions rather than
defects, and closed when the owner made the decision each entry named as its closing condition.
`test/unit/docs-currency.test.ts` pins this count against `ISA.md`, so it cannot drift the way the
sentence it replaced did.

## Tests

```bash
bun test test/unit          # no Docker required
bun test test/integration   # real subprocesses, filesystem, git
bun test test/e2e           # full runs against the pifleet-fake-pi double
```
