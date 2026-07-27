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
bun run pifleet doctor
```

Requires Bun >= 1.3, Docker, Pi 0.79.6, and a local oMLX server. cmux 0.64.20 is optional —
the `headless` backend runs the entire suite without it.

## Status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Interface verification | done (see SRD §4) |
| 1 | Container + headless core | in progress |
| 2 | Artifacts + safety | pending |
| 3 | Security + cloud identity | pending |
| 4 | Panes | pending |
| 5 | Orchestration | pending |
| 6 | Attended mode | pending |

## Tests

```bash
bun test test/unit          # no Docker required
bun test test/integration   # real subprocesses, filesystem, git
bun test test/e2e           # full runs against the pifleet-fake-pi double
```
