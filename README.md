# cmux-fleet

`pifleet` — orchestrate a fleet of containerized [Pi](https://pi.dev) coding agents, optionally
surfaced as [cmux](https://cmux.com) panes, and harvest their work as structured artifacts.

The design lives in [`Docs/SRD.md`](Docs/SRD.md). The done-condition lives in [`ISA.md`](ISA.md).

## Why

A pane is a *view*, not a channel. Every control-plane fact comes from the Pi RPC stream, the
session transcript, or the worker's outbox — never from scraped pane text. Closing a pane, or
never opening one, changes nothing about a run.

**With one deliberate exception, which is the whole of `pane_mode: tui`.** That mode hands a
worker's pane the container's own terminal, so for those workers the pane *is* the channel: there
is no RPC stream, dispatch is keystrokes, completion is read out of the transcript, and closing the
pane is believed to stop the worker. It is a degraded mode for attended debugging, not the
supported path — and it is degraded in writing: `pifleet report` names the ten guarantees it gives
up, per run, with a sentence an operator can act on for each.

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

All six phases are done, and `pane_mode: tui` with them. 2909 tests pass, 124 skip, 0 fail across
193 files — `test/unit` 2302, `test/integration` 590 (+124 skipped behind Docker/oMLX gates),
`test/e2e` 17. **Measured on a developer host on 2026-08-31, not read off a CI run**, because the
figure this replaces said "`test` job, CI on `main`" and this branch is not `main`; the honest
provenance is the one that was available. CI runs the same three suites plus a Docker `container`
job, an `omlx-live` job and a `load` job, none of which are counted above.

| Phase | Deliverable | State |
|---|---|---|
| 0 | Interface verification | done (see SRD §4) |
| 1 | Container + headless core | done — `up → dispatch → wait → down` green on `headless` and against real Pi 0.79.6 |
| 2 | Artifacts + safety | done — outbox contract, harvester, adjudicator, worktree isolation, budget ceilings, kill ladder |
| 3 | Security + cloud identity | done — egress allowlist, network lifecycle, repo hazard scan, cloud identity, control-socket auth |
| 4 | Panes | done — cmux/tmux backends, `attach`, live pane viewer |
| 5 | Orchestration | done — `dispatch --auto` DAG scheduling, `pifleet report`, `pifleet logs` |
| 6 | Attended mode | done — `steer` / `abort` / `exec`, `tui` pane hand-off, voided-requirements table |
| — | `pane_mode: tui` | done 2026-08-31 — the pane runs `docker attach` on Pi's own pty; no RPC control plane, keystroke dispatch, transcript-derived completion, `docker kill --signal=INT` for `abort`, and guards in `up` and `depends_on`. There is no `--mode tui`: Pi's TUI is its default mode plus a real terminal. |

Twenty-two criteria are unattempted `[ ]` — ISC-401..ISC-423, filed 2026-09-01 as the
done-condition for per-worker inference providers (`Docs/SRD-INFERENCE-PROVIDERS.md`) and not yet
built. Every criterion filed before that block has been attempted. Ten are graded `[~]`
(see `ISA.md`), which in this repo means the behaviour is built and re-checked but the *evidence*
falls short of the standard: ISC-331 has one unexercised surface (a live round trip); ISC-344,
ISC-349 and ISC-350 ship guidance to workers, where a grep proving an instruction was shipped
cannot observe a worker obeying it; and the four still open from 2026-08-31 for `pane_mode: tui` —
ISC-377, ISC-378, ISC-379 and ISC-387 — are partial for one shared reason, that the mode's
subject is a pseudo-TTY and the suites cannot open one. ISC-380 was the fifth and **closed the same
day**: its stated closing condition was the only one of the five that did not need a terminal, and
`test/integration/tui-dispatch-pane.test.ts` now drives `dispatch` at a tui worker through the REAL
tmux backend with a fake `tmux` binary on `PATH` — proving that the typed bytes reconstruct the
rendered prompt, that the keys arrive in tmux's spelling, and that the CLI and the ledger both
report `via: pane` with no epoch. **No test in this repo attaches a real pane to a
real container.** The attach argv, the `ctrl-]` detach key and the `docker kill --signal=INT` stop
were each measured live against pi 0.79.6 on one machine on 2026-08-31; nothing re-runs those
measurements, and what CI re-checks is the argv the code builds, not the terminal it produces.
**ISC-387 is what that gap costs, and it was filed after the mode had already been declared
built.** Running a tui worker at a real pane found two defects in a path that had been designed,
reviewed, probed and merged green: tmux exits 0 for an unknown key name and *types it*, so
`shift+enter` appeared in the pane as nine characters while every assertion on pifleet's own argv
stayed correct; and cmux's dispatch was refused by pifleet's *own* identifier guard, whose grammar
has no `+`, at step 2 of a 29-step plan with two lines of the prompt already typed. Each backend
now translates one fleet-wide key vocabulary or refuses — but the vocabulary itself is still a
measurement nothing re-runs, which is why the criterion is `[~]`.
**ISC-259 is the ninth, and it got there differently from the other eight.** It was closed `[x]` by
owner decision on 2026-08-28 and re-graded on 2026-09-01 — not because anything contradicted it, but
because a mechanism its closing evidence *cited* was deleted underneath it. That evidence names three
mechanisms as the reason a hosted provider cannot appear by accident; ISC-369 removed the first, the
pin on `llm.base_url`'s host, for an unrelated and good reason, and never mentioned ISC-259 because it
had no reason to. Measured by driving this repo's own `parseConfig`, `omlxRelayTarget` and
`assertTargetsAllowed`: a fleet can now be pointed at a third-party provider and it validates. The
second half of the sentence — the two-place authorization — survives intact, which is why `[~]` and not
`[ ]`; nothing re-checks the word *never*, which is why not `[x]`.
ISC-372 was filed `[~]` the same day and closed hours later, when `up` gained the check against the
*effective* backend that the entry had named as its own closing condition. The two that left this
list on 2026-08-30 — ISC-306 and ISC-339 — were scope decisions rather than defects, and closed
when the owner made the decision each entry named as its closing condition.

Two are retired `[-]` — ISC-307 and ISC-360 — a marker introduced by ISC-368 on 2026-08-30 for a
criterion whose *premise* was superseded rather than left unproved. ISC-307 is about a secret's
value reaching an env file, and secrets are delivered as read-only files now (ISC-337); ISC-360 is
about an SRD erratum recording task-scoped cloud authorization as designed-but-not-built, and the
owner withdrew the mechanism (ISC-366). Retired criteria are excluded from `progress:` on both
sides — `382/414` counts the live set, and the frontmatter's `retired: 2` says where the rest
went. Retiring is not closing, is not deleting (both entries keep their text and their live
guards), and is refused for a criterion that is merely hard: `test/unit/isa-retired.test.ts`
rejects any retirement that does not name a closed criterion that names it back.

`test/unit/docs-currency.test.ts` pins both counts against `ISA.md`, so neither can drift the way
the sentence it replaced did.

## Tests

```bash
bun test test/unit          # no Docker required
bun test test/integration   # real subprocesses, filesystem, git
bun test test/e2e           # full runs against the pifleet-fake-pi double
```
