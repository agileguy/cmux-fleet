# `pane_mode: tui` — implementation spec

**Status:** designed in SRD §3.5, **parsed but never read**. `config/load.ts:341` sets
`paneMode` and nothing in `src/` consumes it. This document is the build plan.

## The single most important fact, measured

`pi --help` **in the shipped worker image** (`pifleet/pi-worker:0.79.6-base`):

```
--mode <mode>   Output mode: text (default), json, or rpc
--print, -p     Non-interactive mode: process prompt and exit
```

**There is no `--mode tui`.** Pi's TUI is `text` mode — its default — attached to a real
terminal. SRD §130 shows the current launch as `pi --mode rpc --session-id … --skill …`;
a TUI worker is the same argv with `--mode rpc` **omitted** and the container given a TTY.

SRD §162 states the constraint this all follows from: *"a TTY has one owner. Pi's RPC mode
needs stdin/stdout as pipes; a TUI needs them as a terminal."*

## Measured live 2026-08-31 — the approach is proven, not assumed

```
docker run -d -i -t --entrypoint sh <worker-image> -c 'tty; pi --no-session --no-tools'
  ->  /dev/pts/0
  ->  Config.Tty=true  Config.OpenStdin=true  State.Running=true
  ->  the full Pi TUI in `docker logs`: box-drawing frame, `pi v0.79.6`,
      the `/workspace` cwd line, and the keybind bar
      ("escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash")
```

Two consequences that shape the implementation:

1. **DETACHED is not optional.** `docker run -i -t` in the FOREGROUND fails with
   `the input device is not a TTY` whenever the caller's own stdin is not a terminal —
   which is true of `up`, of CI, and of every non-interactive shell. The container must be
   created with `-d`, and the pane reaches it with `docker attach`. This is also why the
   smoke test above uses `docker logs` rather than the run's own stdout.
2. Pi needs no new flag and no `--mode` value. Omitting `--mode rpc` is the whole of it.

## What SRD §3.5 already commits to

| | `rpc` (default) | `tui` (attended) |
|---|---|---|
| Pane runs | viewer tailing `events.jsonl` | `docker attach` to a TUI-mode container |
| Dispatch | control socket → RPC `prompt` | `cmux send` + `send-key enter` |
| Harvest | outbox + transcript + git | **identical** |

Harvest is identical because `--session-id` is chosen before launch. That is the property
that makes this affordable, and **no phase below may break it**.

### Voided in `tui` — these are requirements, not regressions

| Voided | Consequence to implement |
|---|---|
| RPC `abort` | interrupt via `docker kill --signal=INT`, not the pane |
| `get_session_stats` polling | cost summed from the transcript's `usage` instead |
| `extension_ui_request` answering | a dialog blocks until a person answers — acceptable only because attended |
| `queue_update`, epoch fencing (§7.5) | completion is transcript-derived, coarser |
| F15, "closing a pane doesn't stop the worker" | **false** in tui: the pane owns the attach |

Also required by §3.5: a `tui` worker **may not be the target of a `depends_on` edge**, and
`pifleet up` **warns** when a `tui` worker is configured in an unattended run.

---

## Phase 1 — Launch plane: a TTY container running Pi interactively

Make `pane_mode` binding.

1. `container/docker-argv.ts` (and `config/render.ts`): a `tui` worker's `docker run`
   carries `-i -t`; an `rpc` worker's argv is **unchanged, byte for byte**.
2. The pi argv for a `tui` worker **omits `--mode rpc`** and keeps `--session-id`,
   `--session-dir`, `--append-system-prompt`, tools and skills exactly as today — harvest
   depends on the session identity being unchanged.
3. `docker/entrypoint.sh` must not install the RPC stdin plumbing (`exec 3<&0` … ) for a
   TUI worker. Read that file's docblock first: it explains why the redirection exists.
4. Refuse combinations that cannot work, at config-validate time with a field-level error:
   `tui` + `oneshot` lifecycle, and `pane_mode: tui` on the `headless` backend (headless has
   no pane to attach to — see `cli/commands/tui.ts`).

   *(CORRECTED 2026-08-31. This item originally read "`tui` + a role with `pane_mode` unset
   on a headless backend", which describes a role that is not tui at all. Caught by the
   engineer implementing it, who built the rule as stated above rather than the garble.)*

   **The headless half is necessarily PARTIAL, and that bound is asserted rather than
   hidden.** `backend.kind` is optional and an absent block means UNSET (ISC-271); `up`
   resolves `--backend > backend.kind > DEFAULT_BACKEND`. Config-validate can only catch the
   document that SAYS headless — a `--backend headless` typed at `up` is a different
   surface. Closing it needs a check in `up` against the EFFECTIVE backend: **Phase 4.**

**Evidence:** argv pinned byte-for-byte in the unit suite, both modes, plus a mutation
proving the `rpc` argv did not move.

## Phase 2 — Supervisor: no RPC control plane

### 2.0 THE BLOCKER — read this before anything else in Phase 2

Phase 1 emits `-t` for a TUI worker, and **that argv cannot launch today.** Verified
2026-08-31 against the merged Phase 1 work:

```
pifleet render -w tick-1    ->  docker flags ['-i','--rm']       pi: --mode rpc
pifleet render -w tick-tui  ->  docker flags ['-i','-t','--rm']  pi: (none — interactive)
```

…which is exactly right. But `src/supervisor/index.ts:666` launches it as:

```js
const child = Bun.spawn({ cmd, stdin: "pipe", stdout: "pipe", stderr: "pipe", … });
```

A FOREGROUND `docker run -t` whose own stdin is a pipe fails with
`the input device is not a TTY` — measured directly. So the first thing Phase 2 must do is
give a TUI worker a launch path that does not run the container in the supervisor's
foreground with pipes:

- create the container **detached** (`-d`), which is what the smoke test above proves works
  and what the pane's `docker attach` requires anyway; and
- have the supervisor track the container by NAME rather than by holding its stdio, since
  for a TUI worker it holds none of the three streams.

This also means `onChildExit` cannot be the completion signal for a TUI worker — the
`docker run -d` process exits immediately, long before Pi does. That is the same fact as
item 6 (transcript-derived completion), arriving from the launch side.

**Do not "fix" this by removing `-t`.** Without a TTY Pi does not present a TUI at all, and
the whole mode is pointless.


5. The supervisor must not open the RPC client, send `prompt`, or set the ack fence for a
   `tui` worker. Read `src/supervisor/index.ts` around the dispatch path first.
6. Completion is **transcript-derived**: watch the session file rather than waiting for
   `agent_end`. Coarser is expected and correct.
7. Cost is summed from the transcript's `usage` records, not `get_session_stats`.
8. `pifleet abort --worker <id>` on a `tui` worker issues `docker kill --signal=INT`.

**Evidence:** each of the four is a separate probe; mutation-prove that an `rpc` worker
still takes the RPC path (the risk here is a refactor that quietly routes both modes
through the new one).

### 2.8 THE INTERRUPT PATH — SRD §3.5 cannot work as written

Measured 2026-08-31 by the engineer who built the entrypoint branch. §3.5 says a tui worker
is interrupted with `docker kill --signal=INT`. Two independent reasons that does not reach
the worker today, and they pull in OPPOSITE directions:

- `docker kill` signals **PID 1 only**, and the Dockerfile starts tini **without `-g`**
  (`ENTRYPOINT ["/usr/bin/tini","--", …]`), so the INT lands on the entrypoint shell and
  never on the worker.
- `docker/entrypoint.sh` already carries `trap forward TERM INT HUP`, which converts any INT
  into a **SIGTERM on the worker**. Measured in a `-t` container: the shell and its async
  child share pgrp 1, which is also the pty's foreground group — so a person's **Ctrl-C in
  an attached pane** is delivered to the worker AND triggers that trap. In rpc mode nothing
  ever types into the container, so this has never fired. In tui mode Ctrl-C would KILL the
  worker rather than interrupt the turn.

The choice is a product decision and both ends must move together:

| option | `docker kill --signal=INT` | a person's Ctrl-C in the pane |
|---|---|---|
| supervisor ignores INT | becomes a silent no-op | works — reaches Pi as an interrupt |
| supervisor forwards INT | works | double-delivers |

Pi's response to a double INT is **unmeasured**; measure it before choosing. Whoever takes
item 8 takes this with it — shipping the abort path without resolving it gives a pane whose
Ctrl-C kills the agent.

## Phase 3 — Presentation and dispatch

9. A `tui` worker's pane runs `docker attach <container>` — cmux and tmux backends.
   `src/attended/mode.ts` already exports `interactiveArgv`; `docker attach` is a
   *different* thing (it takes Pi's own TTY), so do not reuse it without reading its
   docblock, which explains why the RPC path must never be attached to.
10. `pifleet dispatch` targeting a `tui` worker sends the prompt with `cmux send` +
    `send-key enter` rather than the control socket.
11. `pifleet tui --worker <id>` stops refusing for these workers, and its attended record
    is written as it always was.

## Phase 4 — Guards, and saying what is void

12. `pifleet up` **warns** when a `tui` worker is configured in an unattended run.
13. `depends_on` targeting a `tui` worker is **refused** — `orchestrate/graph.ts`.
14. Wire `tui` workers into the voided-requirements table (`src/attended/voided.ts`) so
    `report` says which guarantees the mode gave up.
15. ISA criteria for everything above, `progress:`/`retired:` recounted **on the merged
    tree**, README and SRD §3.5 updated to say it is built.

---

## House rules — these are not optional

- **Every probe must be mutation-proved.** Back up by PATH, mutate, run, restore, and
  verify with `shasum -c` and `git diff --stat` on the mutated path. A probe that stays
  green when the defect it guards is reintroduced is worse than no probe.
- `[x]` in `ISA.md` only if something reproducible re-checks it. A decision is not
  evidence. Local-only or self-skipping evidence gets `[~]`.
- **No AI/Claude attribution anywhere** — commits, PRs, comments, docs. Zero exceptions.
- Match the surrounding comment density and idiom. This codebase explains *why*, with
  measurements, and states what it does **not** claim.
- Never weaken or delete an existing assertion to make a change pass. If one is genuinely
  wrong, say so explicitly and prove the new one in both directions.

## Corrections to EXISTING code comments, found while building

`docker/entrypoint.sh`'s pre-existing docblock says "`<&0` alone is not reliable here — the
default is applied to the asynchronous list before redirections are processed". Measured in
bash 5.2.37 in the real image: `child <&0 &` receives the piped line correctly, with both a
pipe and a pty on stdin. The block's stated MEASUREMENTS are both right (`cat &` reads
nothing; `exec 3<&0; cat <&3 &` reads the piped line) — it is the INFERENCE about `<&0`,
which was never measured, that does not hold. The RPC path was left untouched; this is
recorded so the next reader does not inherit the wrong reason for a right decision.

The third construct was measured at the same time and is why the RPC plumbing is the WRONG
contract for a TUI rather than merely an unnecessary one:

```
child &                    fd0=/dev/null      (the POSIX async-list rule)
exec 3<&0; child <&3 &     fd0=/dev/pts/0  fd3=PRESENT
child < /dev/tty &         fd0=/dev/tty    fd3=absent
```

`fd3=PRESENT` is the point: the fork happens before the parent's `exec 3<&-`, so an RPC-style
child carries a second, undeclared handle on the terminal.
