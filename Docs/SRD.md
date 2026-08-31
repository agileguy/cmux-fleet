# System Requirements Document — `pifleet`

**Claude-orchestrated fleets of containerized Pi coding agents in cmux panes**

| | |
|---|---|
| **Document ID** | SRD-PIFLEET-001 |
| **Version** | v2.3 (draft) |
| **Date** | 2026-07-26 |
| **Author** | Architect |
| **Status** | DRAFT v2.3 — Phase 0 executed live against cmux 0.64.20 and pi 0.79.6; three independent reviews folded in; workers are containers with a cloud/ops toolchain, inherited Google identity, and a local oMLX-served LLM |
| **Supersedes** | v1.1 (2026-07-26). See §18 for what changed and why. |
| **ISA** | `~/.claude/PAI/MEMORY/WORK/20260726_pifleet-cmux-srd/ISA.md` |
| **Target repo** | `~/repos/pifleet` (new), installed as `pifleet` on `PATH` |

---

## 0. Preamble

### 0.1 The one-paragraph thesis

Claude can already fan out to Anthropic-family subagents inside its own process. What it cannot do is hand work to a **fleet of independent coding agents that run on other models, hold their own context windows, live in their own containers, and that Dan can watch and grab hold of mid-flight.** Pi (pi.dev, v0.79.6, installed) is that agent: a documented JSONL RPC protocol, per-session transcripts on disk, and model/skills/tools selectable per invocation. cmux (0.64.20, installed) is a native macOS terminal built for watching many agents at once, with a password-authenticated Unix socket API. Docker gives each agent a real boundary instead of a promised one. `pifleet` is the layer between them.

### 0.2 The two decisions that matter

**Decision 1 — the pane is a view, not a channel.**

The obvious implementation is: launch `pi` in each pane, type prompts in with `cmux send`, and read results back with `cmux read-screen`. This SRD rejects that. Scrollback is finite and lossy, screen text is a *rendering* of a stream Pi already emits structurally, and a design that depends on a terminal's display for correctness cannot be tested headlessly or ported off cmux.

> Control and data flow through Pi's RPC stream, its session transcript, and a container-written outbox. cmux surfaces are how a human *watches*. Nothing correctness-bearing is ever read off a screen.

Phase 0 vindicated this the hard way: `read-screen` turned out to ship in production after all (§4.1) — and it changed nothing, because the design never depended on the answer.

**Decision 2 — a worker is a container, not a process.**

Every Pi worker runs inside its own Docker container built from a `pifleet` image. This is not packaging convenience; it is the only way three otherwise-unfixable security findings become fixable (§12):

- Pi's `bash` tool spawns a shell with the full host environment and `cwd` as a *starting directory only*. On the host, "tool scope is the security boundary" is false for any role granted `bash` — `cd /` defeats it.
- Nothing on the host keeps a worker inside its worktree except an instruction to the worker, i.e. the same actor whose self-report §7.2 explicitly refuses to trust.
- Pi discovers and **executes** `<cwd>/.pi/extensions/*.ts` from the repo it is working on. On the host, cloning a hostile repo is remote code execution with the provider key in scope.

A container turns each of these from a promise into a mount table, a user id, and a network policy.

### 0.3 Reading guide

§1–2 scope. §3 architecture. §4 the two external APIs as *verified*, not as documented. §5 the worker container. §6 configuration. §7–9 protocols, artifacts, isolation. §10 CLI. §11 backends. §12 security. §13 failure taxonomy. §14 how Claude drives it. §15 the test double. §16 build plan. §17 acceptance. §18 revision ledger. §19 open questions. §20 references.

---

## 1. Problem statement

### 1.1 What is missing

| Need | Today |
|---|---|
| Run N coding agents concurrently on different models | Manual: open terminals, launch `pi` by hand |
| Assign a role — skills, tools, model, repo — per agent | Manual flags, retyped, undocumented |
| Hand a task to agent *k* from an orchestrator | No path — Pi's TUI expects a human |
| Know that agent *k* finished, stalled, or died | Look at the pane and judge |
| Collect what agent *k* produced | Read the pane, copy-paste, hope nothing scrolled off |
| Contain what agent *k* can touch | Nothing. Full host access, full env, full filesystem |
| Do any of it headless, in CI | Impossible |

### 1.2 Why panes at all

Because the alternative — silent background processes — is the failure mode already recorded in this codebase: agents that "completed" with empty worktrees, work that leaked into the wrong checkout, and stalls invisible until the budget was gone. A visible pane per worker converts silent failures into obvious ones and gives Dan a keyboard he can grab. That is a real requirement, and a **presentation** one.

### 1.3 Success in one sentence

Dan says *"have the fleet do X"*; six panes appear, each visibly a different specialist in its own container; Claude dispatches, tracks, and returns a merged, cited result — and Dan never had to read a pane to know what happened, but could have watched every one.

---

## 2. Out of scope

- **Planning and decomposition.** What the tasks *are* stays with the Algorithm / ProjectManager. `pifleet` is an execution backend.
- **Code-review adjudication policy.** A reviewer worker is configurable; whose verdict wins is the orchestrator's problem.
- **Autonomous merge to a protected branch.** The fleet produces branches and diffs; a human or the orchestrator merges.
- **Multi-machine / cloud fleets.** Single Docker host, v1. (Pi's OpenShell pattern is the natural v2 door — §19 Q7.)
- **Non-macOS cmux.** cmux is macOS-only; the `tmux` and `headless` backends exist so `pifleet` is not.
- **Replacing PAI's Agent/Teams primitives.** In-process, in-family delegation stays where it is.
- **Patching, vendoring, or forking Pi or cmux.** Published interfaces only.
- **Billing/quota management** beyond hard local ceilings.
- **Kubernetes, compose-based multi-service topologies, or image publishing to a registry.** The image is built and used locally.

---

## 3. Architecture

### 3.1 The two planes

| Plane | Carries | Medium | Fails how |
|---|---|---|---|
| **Control / data** | dispatch, agent events, results, cost | Pi RPC JSONL over the container's stdio + session transcript + outbox envelopes | Loudly — a broken pipe or missing file is detectable |
| **Presentation** | what a human sees | cmux surfaces, sidebar pills, notifications | Cosmetically — a lost pane never corrupts a result |

Every requirement below is assigned to exactly one plane, and **no requirement crosses**. The one apparent exception, `tui` pane mode, is quarantined in §3.5 with an explicit list of what it voids.

### 3.2 Runtime topology

```
┌───────────────────────────────────────────────────────────────────────┐
│ Claude (primary orchestrator)                                         │
│   Bash: pifleet up|dispatch|status|wait|artifacts --json              │
└───────────────┬───────────────────────────────────────────────────────┘
                │ CLI, JSON on stdout, POSIX exit codes
┌───────────────▼───────────────────────────────────────────────────────┐
│ pifleet (Bun/TypeScript)         ┌─────────────────────────────────┐  │
│  Config · Backend · Dispatcher   │ pifleet daemon (registry)       │  │
│  Harvester · Adjudicator         │  sole writer of registry.json   │  │
│                                  │  budget reservation · reaper    │  │
└──────┬──────────────────┬────────┴───────────────┬──────────────────┘
       │ presentation     │ control (unix socket)  │ data (files)
┌──────▼──────────────────┼────────────────────────┼──────────────────┐
│ Backend: cmux | tmux | headless                  │                  │
│   pane runs ONLY a viewer:                       │                  │
│   `pifleet logs --worker w1 --follow --render`   │                  │
└──────────────────────────┬───────────────────────┼──────────────────┘
                           │ attaches to           │
┌──────────────────────────▼───────────────────────┼──────────────────┐
│ pifleet-worker (supervisor) — DETACHED, session leader, on HOST     │
│   • owns `docker run -i` child over pipes                           │
│   • speaks Pi RPC JSONL through it                                  │
│   • answers extension_ui_request dialogs                            │
│   • records sessionFile from get_state; never computes it           │
│   • mirrors events → events.jsonl; maintains state.json             │
│        ┌────────────────────────────────────────────────┐           │
│        │ Docker container  pifleet/pi-worker:<tag>       │          │
│        │   user 10001:10001, no-new-privileges, ro root  │          │
│        │   pi --mode rpc --session-id … --skill …        │          │
│        │   /workspace  ← worktree        (rw)            │          │
│        │   /outbox     ← run-dir/outbox  (rw)            │          │
│        │   /sessions   ← run-dir/sessions(rw)            │          │
│        │   /skills     ← skill bundle    (ro)            │          │
│        └────────────────────────────────────────────────┘           │
│         ×N containers                                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ writes
        ┌──────────────────▼──────────────────────────────────────┐
        │ Durable state (the artifact surface)                    │
        │  <run-dir>/sessions/<ts>_<session-id>.jsonl             │
        │  <run-dir>/worktrees/<worker>/  (independent clone — §9.2 erratum) │
        │  <run-dir>/workers/<id>/state.json                      │
        │  <run-dir>/workers/<id>/events.jsonl                    │
        │  <run-dir>/outbox/<task-id>/result.json                 │
        │  <run-dir>/ledger/<writer>.jsonl                        │
        └─────────────────────────────────────────────────────────┘
```

### 3.3 Three processes, three lifetimes

| Process | Runs where | Lifetime | Owns |
|---|---|---|---|
| `pifleet` CLI | host, foreground | one command | nothing durable |
| `pifleet-worker` supervisor | host, **detached session leader** | the run | one container, one RPC stream, one `state.json` |
| `pifleet daemon` registry | host, detached, one per run | the run | `registry.json`, budget reservations, orphan reaping |

**The supervisor is detached from the pane** (own session via `Bun.spawn({detached:true})` + `unref()`, verified to become its own process-group leader). The pane runs *only* a viewer. Rationale: tying a control-plane process's lifetime to a presentation-plane object means closing a pane — a cosmetic act — orphans a container that still holds a worktree and still spends money.

**Why not one central daemon owning all children:** multiplexing N RPC streams through one event loop gives head-of-line blocking between unrelated workers, and one crash takes the fleet. The registry is deliberately thin: it holds no stream and owns no container.

**Why a supervisor at all, rather than the pane talking to the container:** a TTY has one owner. Pi's RPC mode needs stdin/stdout as pipes; a TUI needs them as a terminal. The supervisor takes the pipes and renders a human-readable log that the viewer tails.

### 3.4 The supervisor ↔ container contract

The supervisor runs `docker run -i --name pifleet-<run>-<worker> …` and speaks JSONL over its stdin/stdout. Three container-specific rules:

1. **stdin stays open for the container's whole life.** Pi's RPC mode registers `process.stdin.on("end") → shutdown() → process.exit(0)`; closing stdin destroys in-flight responses. Graceful stop is `abort` → await `agent_end{willRetry:false}` → *then* close stdin (§13 F3).
2. **stderr is drained.** Pi writes warnings to stderr (e.g. unresolved model ids). An unread pipe fills at ~64KB and the container blocks on `write(2)`, presenting as a wedged agent with a green heartbeat. stderr is piped and mirrored into `events.jsonl` as `{"type":"stderr_line"}`.
3. **Death is detected by liveness, never exit code.** Pi exits 0 on clean shutdown, on broken pipe, and on stdin EOF alike. Use `docker inspect` state + RPC event staleness.

### 3.5 Pane modes — and what `tui` voids

> **BUILT 2026-08-31** (ISA Group W, ISC-370..ISC-386). This section was designed and, until
> Phase 1, read by nothing: `config/load.ts` set `paneMode` and no consumer existed, so a
> `fleet.yaml` saying `pane_mode: tui` validated, rendered an argv identical to `rpc`'s, and
> launched an ordinary RPC worker. **Two of this section's own claims did not survive being
> built, and both corrections are carried below rather than filed as errata**, because a reader
> arrives at this table to decide something.

**ERRATUM 1 — there is no `--mode tui`.** The row below used to read "`docker attach` to a
TUI-mode container", which describes a flag that does not exist. Measured against the shipped
worker image (`pifleet/pi-worker:0.79.6-base`), `pi --help` offers exactly `text (default), json,
or rpc`. **Pi's TUI is its DEFAULT mode plus a real terminal.** A `tui` worker is therefore the
same argv as an `rpc` worker with `--mode rpc` *omitted* and the container given a TTY (`-i -t`) —
Pi needs no new flag and no `--mode` value. §162's constraint is what everything else follows
from: *a TTY has one owner*.

| Mode | Pane runs | Dispatch | Harvest | Use |
|---|---|---|---|---|
| `rpc` *(default)* | viewer tailing `events.jsonl` | control socket → RPC `prompt` | outbox + transcript + git | automation |
| `tui` *(attended)* | `docker attach --detach-keys=ctrl-]` to a container running Pi's **default** mode on a real pty | `cmux send` per line, `send-key shift+enter` between them, `send-key enter` to submit — see erratum 3 | outbox + transcript + git — **identical** | pair-working, demos |

The harvest path is identical in both modes because `--session-id` is chosen before launch. `tui`
is therefore cheap — but **not free**, and v1.1 was wrong to say it cost "a weaker dispatch path
and nothing else." In `tui` mode the supervisor owns **none of the worker's three streams**, so
the following are void. Each row now carries the reason the build MEASURED, which in three places
is not the reason this table first gave:

| Voided in `tui` | Consequence, as built |
|---|---|
| RPC `abort` | `docker kill --signal=INT` — and it is a **stop, not a turn-interrupt**. See erratum 2. Pi's turn-interrupt is the ESCAPE keystroke, which travels through the pane as a byte and which no `pifleet` command can send. |
| `get_session_stats` polling | cost summed from the transcript's `usage`. Structural rather than merely unwired: there is no control plane to poll, so `harvest/usage.ts`'s max-merge is permanently one-armed for these workers. (F12 records that nothing polls it for `rpc` workers either.) |
| `extension_ui_request` answering | a dialog blocks until a person answers it — acceptable only because the mode is attended by construction. Leave a `tui` worker unwatched and a dialog stalls it for the rest of the run. |
| `queue_update` consumption, epoch fencing (§7.5) | **no epoch is allocated at all.** "Transcript-derived, coarser" understated it: with no epoch there is no `already_completed`, so a re-dispatch of the same task file types the prompt a second time and **runs the task twice**, and the harvest accepts whichever `result.json` lands last. |
| No ack on dispatch | `accepted: true` means `cmux` exited 0 — bytes reached a pty. It does not prove Pi read them, that a turn started, or that the program on that terminal is still Pi. `prompt_rejected` cannot happen, so its absence is not evidence that nothing refused. |
| ISC-95, "never glob for a session file" | `get_state` is an RPC method a `tui` worker has no channel for, so the transcript is found by **suffix match** on `_<session-id>.jsonl` — non-recursive, bounded by a worker id unique within the run, newest-of-several returned *with the count*. Weaker than a path Pi stated itself. |
| F15 and the "closing a pane doesn't stop the worker" criterion | **false** in tui mode — the pane owns the attach. **ASSERTED, NOT MEASURED:** `--sig-proxy` is left at docker's default and no probe has closed a tui pane and then inspected the container. |

**ERRATUM 2 — the interrupt path works, for a reason this section did not have.** The design above
was challenged on the grounds that `docker kill` signals **PID 1 only** and the Dockerfile starts
tini **without `-g`**, which would make `docker kill --signal=INT` a no-op. Both of those facts are
correct, and the conclusion does not follow: **tini forwards the signal to the entrypoint shell,
whose existing `trap forward TERM INT HUP` converts it to `kill -TERM` on the worker, and Pi exits
cleanly.** The effect reaches the worker; only the signal does not. The trap is therefore
**load-bearing rather than an obstacle** — dropping `INT` from it would create the no-op that was
feared. Measured 2026-08-31, one fresh container in the production tui shape per row: no signal →
`Running=true`; `--signal=INT` at PID 1 → `Running=false ExitCode=0`; `--signal=TERM` → same;
`kill -INT` at Pi directly → `ExitCode=130`, and a second INT 150 ms later changes nothing because
there is nothing left to send it to. A person's **Ctrl-C in an attached pane does not kill the
worker** either: Pi's TUI holds the pty in raw mode (`-isig`, measured against a `cat` control arm
that shows `isig`), so the tty driver generates no SIGINT for the trap to catch.

**ERRATUM 3 — "`send-key enter`" is not a portable instruction, and both backends proved it in a
live run rather than in the suite.** A prompt is more than one line, so the dispatch cell above
needed a *separator* key as well as a submit key, and the two backends spell keys in **disjoint
vocabularies**: measured 2026-08-31 against a real cmux surface, `send-key shift+enter` → `rc=0`
and `send-key S-Enter` → `rc=1 invalid_params: Unknown key`; measured against a real tmux pane,
`send-keys S-Enter` sends the key and **`send-keys shift+enter` exits 0 and types the nine
characters into the pane.** The fleet therefore carries ONE key vocabulary (`src/util/pane-text.ts`:
`enter`, `shift+enter`, `escape`, `tab`) and every backend translates it or **refuses** — a
pass-through fallback is what produced `t-live-1shift+entershift+enter…` in a real pane. **Both
defects were invisible to a green suite**, and differently: tmux's was a backend that exits 0 while
doing the wrong thing, so no assertion on our own argv could see it; cmux's was our *own*
`assertCmuxValue` grammar, which has no `+` and so refused the key at **step 2 of 29** with two
lines of the operator's prompt already typed and unwithdrawable. That grammar was NOT widened — it
guards surface ids, workspace refs and status keys, and flag injection is not a key-specific
hazard — so keys pass a closed allow-list of their own instead.

Therefore: `tui` workers may not be the target of a `depends_on` edge, and `pifleet up` warns when
a `tui` worker is configured in an unattended run. **Both guards are built**, and `up` additionally
refuses a `tui` worker on the *effective* `headless` backend — `config validate` can only see a
document that names `headless`, and `--backend headless` typed at `up` is a different surface.

---

## 4. External interfaces — as verified

> **Every claim in this section was executed against the installed binaries on 2026-07-26**, not read off a docs page. v1.1 was written from documentation and was wrong in eleven places; §18 lists them. Where a docs page and the installed build disagree, **the build wins and the version is pinned.**

### 4.1 cmux 0.64.20 — presentation plane only

Socket: **`~/.local/state/cmux/cmux.sock`** (plus `cmux.sock.lock`, `last-socket-path`). Override with `CMUX_SOCKET_PATH`; `CMUX_SOCKET` is a deprecated alias that hard-fails if both are set and differ.

**Access control is a config key, not an environment variable.** `~/.config/cmux/cmux.json`:

```jsonc
{
  "automation": {
    "socketControlMode": "password",   // off|cmuxOnly|automation|password|allowAll|openAccess|fullOpenAccess|notifications|full
    "socketPassword": "<secret>"       // default mode is cmuxOnly
  }
}
```

Verified behaviour:

- Default `cmuxOnly` refuses any non-descendant caller: `ERROR: Access denied - only processes started inside cmux can connect`.
- Setting `password` mode **hot-reloads with no app restart**; `cmux ping` → `PONG` from an arbitrary shell with `--password` or `CMUX_SOCKET_PASSWORD`.
- `password` mode is **additive**: inside a pane, `env -u CMUX_SOCKET_PASSWORD cmux ping` still returns `PONG`. Ancestry access is retained; only external callers need the credential. **A supervisor started inside a pane needs no secret.**
- `CMUX_SOCKET_PASSWORD` is *protected from override* by workspace env — which is **not** the same as being *provided*. It is **not** injected into panes. Only `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` are, as **UUIDs, not refs**.

**Requirement:** `pifleet` uses `password` mode and reads the credential from the environment. It never writes `allowAll`, and `doctor` fails with a named diagnosis if the mode is `allowAll` (over-permissive) or `cmuxOnly` while running outside a pane.

**Bind to the CLI, not to socket method names.** `cmux capabilities --json` reports `access_mode` and **255 methods**. Of the 18 method names v1.1 claimed, 14 exist; `set_status`, `set_progress`, `log`, and `sidebar_state` **do not exist as socket methods** — but the corresponding *CLI commands* work. cmux commits to CLI stability ("legacy forms keep working indefinitely"); it does not make that promise for v1/v2 method names. Therefore the `cmux` backend shells out to the CLI and uses `cmux rpc <method> [json]` only as an escape hatch.

| CLI (canonical) | Used for | Status |
|---|---|---|
| `cmux ping` | liveness | **required** |
| `cmux capabilities --json` | access mode + method probe | **required** |
| `cmux identify --json` | own surface/workspace, socket path | **required** |
| `cmux workspace create --name --cwd --command --env --env-file --layout --focus <bool> --json` | **create a pane and start a process in it** | **required** |
| `cmux workspace list --json` | find/attach; `custom_title` round-trips `--name` | **required** |
| `cmux workspace close --workspace <ref>` | teardown | required |
| `cmux new-split <dir>` / `cmux new-pane` / `cmux new-surface` | additional panes | required |
| `cmux list-panes --json` | worker → surface map (`list-panels` is the legacy alias) | required |
| `cmux focus-pane --pane <ref>` / `focus-panel` | `pifleet attach` | required |
| `cmux respawn-pane --workspace <id> --surface <id> --command <text>` | **starts the viewer in a split pane** — without it, panes are empty shells | **required** |
| `cmux rename-tab --workspace <id> --surface <id> --title <text>` | labels a pane with its worker id; best-effort, a failure costs a label | optional |
| `cmux send [--surface]` / `send-key [--surface]` | **`tui` mode only.** `send-key` takes cmux's own spelling — `shift+enter` accepted, `S-Enter` rejected `invalid_params: Unknown key` (measured 2026-08-31); see §3.5 erratum 3 | optional |
| `cmux set-status <k> <v> [--icon --color --priority]`, `clear-status`, `list-status` | per-worker sidebar pill, keyed by worker id | optional |
| `cmux set-progress <0..1> [--label]`, `clear-progress` | run progress (**singular per workspace**) | optional |
| `cmux notify --title --body` | run finished / worker failed | optional |
| `cmux events [--after <seq>] [--cursor-file] [--name] [--category] [--reconnect] [--limit] [--no-ack]` | reconnectable NDJSON event stream with cursor/ack | optional |
| `cmux top --processes`, `cmux surface-health` | per-pane process list — orphan detection | optional |
| `cmux read-screen [--scrollback] [--lines n]` / `capture-pane` | **diagnostics only** | optional — **never correctness-bearing** |

**Verified spawn semantics.** `cmux workspace create --cwd <path> --command <text>` returns `{workspace_ref, surface_ref, window_ref}` and runs the command in the new pane; a background (`--focus false`) workspace accepted input and `read-screen` immediately — the dead-PTY behaviour of upstream #1472 does **not** reproduce on 0.64.20. **Caveat:** `--command` is **shell-injected, not exec'd** — the text is typed into the pane's interactive shell (it echoes) and the shell survives the command. Quoting matters; argv is not clean. `pifleet` therefore writes the viewer launch line to a run-local 0700 script and passes `--command "bash <path>"`, never interpolating config strings into a typed command line.

**`--env KEY=VALUE` and `--env-file` are supported per workspace** — but see §12.4: pifleet does not use them for secrets.

**Flag surface is not uniform:** `workspace create` takes `--focus <true|false>` and *rejects* `--no-focus`, while `open` and `ssh` accept `--no-focus`. Legacy names (`new-workspace`, `list-workspaces`, `list-panels`) emit a deprecation notice unless `CMUX_QUIET=1`.

**Minimum pinned version: cmux 0.64.20.** `doctor` records `cmux --version` plus the `capabilities` payload and **exits 3** if any `required` row is missing.

> **Erratum (2026-08-30, documentation audit) — the table above is the CLI as PROBED in Phase 0; it
> is not the CLI as CALLED. Eight rows disagree with `src/backends/cmux/`, in both directions, and
> the `required` column disagrees with the list `doctor` actually enforces.**
>
> This section's own thesis is that it was written from a running binary rather than from
> documentation, and that remains its value. What went stale is the second half of the contract:
> which of those commands pifleet ends up invoking, and with which argv. `src/backends/cmux/client.ts`
> is the single argv builder and `src/backends/cmux/capabilities.ts:37-46` is the single
> `required` list, so both halves are checkable.
>
> **What `doctor` actually requires** (`REQUIRED_COMMANDS`, `capabilities.ts:37-46`): `ping`,
> `capabilities`, `identify`, `workspace`, `new-split`, `list-panes`, `focus-pane`, `respawn-pane`.
> Eight names, checked as substrings of `cmux --help` output (`capabilities.ts:113`).
>
> | Row above | What the code does |
> |---|---|
> | `workspace close --workspace <ref>` | positional: `["workspace","close",workspaceId]` (`client.ts:89-90`), whose comment records the live probe — `// Positional, not --workspace` |
> | `new-split` / `new-pane` / `new-surface`, all **required** | only `new-split` exists anywhere. `grep -rnF 'new-pane' src/ test/` and the same for `new-surface` return nothing; `newSplitArgv` is `client.ts:102-106` |
> | *(no row)* | **`respawn-pane` is `required`** (`capabilities.ts:43`) and is how a viewer starts in a split pane — without it, panes are empty shells and ISC-129 is unmeetable. Invoked at `index.ts:290` |
> | *(no row)* | `rename-tab --workspace --surface --title` (`client.ts:113-127`), invoked at `index.ts:222` |
> | `identify --json` → "own surface/workspace, socket path" | required as a PRESENCE check only. There is no `identifyArgv` and no call site; nothing in this repo parses its output |
> | `read-screen [--scrollback] [--lines n]` | `["read-screen","--surface",surfaceId]` plus optional `--lines` (`client.ts:215-219`). `--surface` is mandatory and unnamed above; `--scrollback` is never passed |
> | `set-status` / `set-progress` / `notify` | all three always append `--workspace <id>` (`client.ts:160`, `:200`, `:212`), which no signature above shows |
> | `cmux rpc <method> [json]` "escape hatch" (¶ above the table) | not implemented. `grep -rnF 'cmux rpc' src/ test/` returns nothing, and there is no `rpcArgv` |
>
> **Every JSON-returning invocation carries `--id-format uuids`, and that changes the response
> keys.** `client.ts:55` is `const JSON_IDS = ["--json", "--id-format", "uuids"]`, appended to
> `workspace list`, `workspace create`, `list-panes` and `new-split`, because UUIDs are the only
> identifier cmux resolves globally — refs are window-scoped and renumber. `parse.ts:10-13` records
> the consequence: under that flag `workspace_ref` comes back as `workspace_id` and `surface_ref` as
> `surface_id`. The "returns `{workspace_ref, surface_ref, window_ref}`" in **Verified spawn
> semantics** is the `--id-format`-omitted spelling, which is not the shape this backend requests.
>
> **The viewer is not launched by `workspace create --command`.** `workspaceCreateArgv`
> (`client.ts:79-84`) emits no `--command` at all. The 0700-script half of that paragraph is right
> and is the load-bearing half — `index.ts:280-288` writes `viewer-<surface>.sh` at mode 0700 with
> an `exec` line built by `shellQuote` — but it is then run by
> `respawnPaneArgv(workspaceId, surfaceId, \`sh <script>\`)` (`index.ts:290`), with **`sh`**, and the
> script's own shebang is `#!/bin/sh`. Both the command and the interpreter in the SRD's sentence
> are wrong; its reasoning about shell injection is why the script exists and still holds.
>
> **The pin says 0.64.20; two argv builders are written against 0.64.22.** `client.ts:121` and
> `:134`, and `parse.ts:36`, record that `respawn-pane` and `rename-tab` resolve a surface
> WORKSPACE-SCOPED from 0.64.22 on, and that "a bare `--surface <uuid>` — the shape this backend
> shipped, matching the SRD's 0.64.20 baseline — fails". The effective floor for the two commands
> the viewer depends on is therefore higher than the number this section pins.
>
> **`doctor` does not record the `capabilities` payload.** It records `cmux --version`
> (`doctor.ts:458`) and emits `socket_mode`, `missing_commands` and `optional_capabilities`
> (`doctor.ts:1382-1388`). Note that `socket_mode` there is read from `~/.config/cmux/cmux.json`
> (`doctor.ts:517-521`, defaulting to `cmuxOnly` on any read failure) — a DIFFERENT source from the
> backend's `access_mode`, which is parsed out of `capabilities --json` at `parse.ts:198-205`. The
> exit-3-on-missing-required half is correct (`doctor.ts:390-391` → `EXIT.BACKEND_UNAVAILABLE`).
>
> **What this erratum does NOT claim.** Nothing here re-probes cmux. Every statement above is about
> what THIS repository does; the Phase 0 findings about cmux's own behaviour — the 255 methods, the
> `allowAll`/`cmuxOnly` semantics, `--focus <bool>` rejecting `--no-focus`, the #1472 refutation, the
> deprecation notices — were not re-verified and are left standing.

### 4.2 Pi 0.79.6 — control and data plane

> **Ground truth is the installed package**, `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/` — which ships its own `docs/rpc.md` (1408 lines). `~/repos/pi` is **v0.62.0**, seventeen minors stale, and must not be used as a reference: half the flags below do not exist in it.

**Worker-shaping flags** — these *are* the role definition:

| Flag | Role knob | Notes |
|---|---|---|
| `--provider`, `--model <p/id[:thinking]>` | which brain | `:thinking` suffix is parsed out of the model string |
| `--thinking off\|minimal\|low\|medium\|high\|xhigh` | how hard | |
| `--skill <path>` (**repeatable, additive**) | which skills | additive even under `--no-skills` |
| `--no-skills`, `--no-extensions`, `--no-context-files` | deny discovery | **mandatory defaults** — see §12.2 |
| `--tools <list>` / `--exclude-tools <list>` / `--no-builtin-tools` | tool scope | **no validation** — an unknown name silently matches nothing |
| `--append-system-prompt <text\|file>` | role briefing | **NOT repeatable — last wins.** No `@` sigil (§18) |
| `--session-id <id>` | addressable session | `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`; conflicts with `--session`/`--continue`/`--resume`/`--no-session` |
| `--session-dir <dir>` | per-run transcript storage | **flattens** the layout — no `--<cwd>--/` segment |
| `--name`, `--approve`/`--no-approve`, `--offline` | display, trust, network | |
| `--mode rpc\|json\|text`, `-p/--print` | transport | |

Built-in tools are exactly `read, bash, edit, write, grep, find, ls`. **There is no `web_fetch` built-in**, and `ask_question` is extension-provided — so `--exclude-tools ask_question` silently matches nothing when extensions are off (§12.3).

**RPC commands used** (JSONL on stdin, LF-delimited, optional `id` for correlation):

`prompt` (with `streamingBehavior: "steer"|"followUp"`), `steer`, `follow_up`, `abort`, `abort_bash`, `abort_retry`, `get_state`, `get_session_stats`, `get_last_assistant_text`, `get_messages`, `get_available_models`, `set_model`, `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_auto_retry`, `set_auto_compaction`, `compact`, `new_session`, `switch_session`, `fork`, `export_html`, `set_session_name`, `bash`, `clone`.

Responses are `{id?, type:"response", command, success, data?, error?}` — **`data` carries the payload** (`get_session_stats` → `SessionStats`, `get_state` → `RpcSessionState`).

**Events consumed:**

`agent_start`, `agent_end` (**carries `willRetry: boolean`**), `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`_update`/`_end`, `queue_update`, `compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, `summarization_retry_scheduled`/`_attempt_start`/`_finished`, `extension_error`, `extension_ui_request`.

> **Three "events" specified in v1.1 do not exist and have been removed: `agent_settled`, `bash_execution_update`, and the `get_entries {since}` command.** Verified: zero occurrences in the installed package and in its shipped `docs/rpc.md`. **`agent_settled` was v1.1's normative completion primitive** — a fleet built on it would never report a single task complete. See §7.4 for the replacement and §18 for the post-mortem.

**Session transcripts.** With `--session-dir D --session-id S`, the file is `D/<ISO-timestamp>_S.jsonl` — **flat**, no cwd-mangled subdirectory. Two facts break the naive path computation:

1. The timestamp prefix is generated at creation and is **not knowable in advance** (two launches with the same `--session-id` produced different prefixes).
2. The file is **created lazily**, on the first assistant message — not at launch.

**Requirement:** the supervisor issues `get_state` immediately after the container is up and records the returned `sessionFile` **verbatim** into `state.json`. It never computes or globs the path. Absent→present transition is recorded so "never started" is distinguishable from "wrong path."

Entry types: `SessionHeader` (v3) then a tree via `id`/`parentId` — `SessionMessageEntry` (wrapping `UserMessage` | `AssistantMessage` with provider/model/usage/stopReason | `ToolResultMessage` | `BashExecutionMessage` | `CustomMessage`), `ModelChangeEntry`, `ThinkingLevelChangeEntry`, `CompactionEntry` (self-contained `retainedTail`), `BranchSummaryEntry`, `LabelEntry`, `CustomEntry` (excluded from context), `CustomMessageEntry` (**included** in context), `SessionInfoEntry`.

**Skills discovery:** `~/.pi/agent/skills/`, `~/.agents/skills/`, `<cwd>/.pi/skills/`, `<cwd>/.agents/skills/` up to git root, package `skills/` dirs, the settings `skills` array, and repeatable `--skill`. `SKILL.md` frontmatter: `name`, `description` required; `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` optional. **In the container, all discovery roots are disabled and skills are mounted read-only at `/skills`** (§5.4).

**`extension_ui_request` — the complete vocabulary** (nine methods, two classes):

| Class | Methods | Response |
|---|---|---|
| **Dialog** (blocks until answered) | `select`, `confirm`, `input`, `editor` | `{value}` \| `{confirmed}` \| `{cancelled:true}` |
| **Fire-and-forget** (no reply expected) | `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | none — responding is meaningless |

`select`/`confirm`/`input` carry an optional `timeout` and self-resolve; **`editor` has no timeout and hangs forever unanswered** — it is the one method where the supervisor's timer is load-bearing. **There is no "deny" verb**: denial is `{cancelled:true}`, and how an extension interprets that is extension-defined (§12.3).

> **Erratum (2026-08-30, documentation audit) — three corrections. Two are headings that mean
> something other than what a reader takes them to mean, and one is a field name the installed
> format spells differently.**
>
> **"RPC commands used" is the vocabulary Pi EXPOSES, not the set pifleet sends.** Twenty-five
> commands are listed; `grep -rnE '\.send\(\s*"' src/` returns **five**: `prompt`
> (`src/supervisor/index.ts:1673`), `steer` (`:1718`), `abort` (`:1336`, `:1549`, `:1872`, `:1916`),
> `get_state` (`:1041-1042`, `:1525`) and `export_html` (`:1844`). `get_session_stats` is *parsed*
> (`src/harvest/usage.ts:81`) but never sent, and `src/harvest/usage.ts:11` says so outright — "the
> only executable `get_session_stats` in the repository is the RESPONDER". The remaining nineteen
> appear in `src/` only inside comments. This matters because the heading is the reason the test
> double implements what it implements: `test/fixtures/fake-pi.ts` answers seven commands, and a
> reader sizing the double against the list above would conclude eighteen are missing.
>
> **`extension_error` is listed under "Events consumed" and is consumed by nothing.**
> `grep -rn 'extension_error' src/ test/` returns no hits at all. It is not in `ACTIVITY_EVENTS`
> (`src/rpc/completion.ts:33-51`) and has no case in the supervisor's event dispatch
> (`src/supervisor/index.ts:1394-1444`), so an extension error arriving on the stream is neither
> counted as activity nor logged as a distinct kind. Every other name in that list is a real
> constant in `src/rpc/completion.ts` or `src/supervisor/index.ts`.
>
> **`CompactionEntry` does not carry `retainedTail` on the installed build.** The shape the
> harvester dereferences is `{type:"compaction", summary, firstKeptEntryId, tokensBefore?}`
> (`src/harvest/transcript.ts:78-83`, guarded at `:115-119`), and `transcript.ts:20-24` records the
> discrepancy at the source: "the SRD calls the compaction field `retainedTail`; the installed
> format spells the same concept `summary` + `firstKeptEntryId`". `grep -rnF 'retainedTail' src/`
> returns only those two comment lines. The *concept* — a compaction entry is self-contained, so
> replay never needs the entries above it — is unchanged and is what the code implements.
>
> **What this erratum does NOT claim.** The rest of §4.2's entry-type vocabulary
> (`SessionMessageEntry`, `UserMessage`, `ModelChangeEntry`, `BranchSummaryEntry`, `SessionInfoEntry`
> and the others) is neither confirmed nor refuted here: the harvester deliberately models only the
> three wire discriminators it dereferences — `session`, `message`, `compaction`
> (`src/harvest/transcript.ts:36-42` explains why — an unknown entry type must be skipped, not
> parsed) — so those names are simply not exercised by this repository. Likewise the Pi flags §4.2
> documents but pifleet never renders (`--offline`, `-p/--print`, `--approve`, `--no-builtin-tools`,
> `--name`), and the skills-discovery roots, which the container disables wholesale
> (`src/config/render.ts:124`). Absence of exercise is not evidence of error, and none is asserted.

---

## 5. The Pi worker container

### 5.1 Why the image is part of this SRD

A worker is not "pi with some flags"; it is a reproducible environment with a declared toolchain, a declared skill set, a fixed uid, and a mount table. Two workers on the same role must be byte-identical environments or the fleet's results are not comparable. The image is therefore a first-class deliverable, versioned with `pifleet` and pinned per run.

### 5.2 Base image

`docker/Dockerfile` — a hardened elaboration of the pattern in Pi's own shipped `docs/containerization.md` ("Plain Docker": whole `pi` process in a local container, host cwd mounted at `/workspace`).

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_TAG=24-bookworm-slim
FROM node:${NODE_TAG} AS base

ARG PI_VERSION=0.79.6
ARG TOOLCHAIN=base          # base | node | python | go | full
ARG TARGETARCH              # arm64 on this machine (Colima/aarch64)

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep jq curl less tini gnupg \
 && rm -rf /var/lib/apt/lists/*

# --- cloud CLI baseline: present in EVERY worker image ---
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin kubectl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
      | HELM_INSTALL_DIR=/usr/local/bin bash

# --- verb gate: real binaries move aside, wrappers take their names (§5.10) ---
RUN for b in gcloud kubectl helm; do \
      mv "$(command -v $b)" "/usr/local/libexec/${b}.real"; \
    done
COPY --chmod=0755 docker/verbgate /usr/local/bin/gcloud
COPY --chmod=0755 docker/verbgate /usr/local/bin/kubectl
COPY --chmod=0755 docker/verbgate /usr/local/bin/helm

# --- optional toolchain layers, selected by build arg ---
FROM base AS toolchain-base
FROM base AS toolchain-node
RUN npm install -g --ignore-scripts bun@1.3.12
FROM base AS toolchain-python
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | sh
FROM base AS toolchain-go
RUN apt-get update && apt-get install -y --no-install-recommends golang-go \
 && rm -rf /var/lib/apt/lists/*
FROM toolchain-${TOOLCHAIN} AS final

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

# non-root, fixed uid so bind-mount ownership is deterministic
RUN groupadd -g 10001 pi && useradd -u 10001 -g 10001 -m -s /bin/bash pi

RUN mkdir -p /workspace /outbox /sessions /skills /creds \
             /home/pi/.pi/agent /home/pi/.config/gcloud /home/pi/.kube \
 && chown -R 10001:10001 /workspace /outbox /sessions /home/pi

USER 10001:10001
WORKDIR /workspace
ENV PI_OFFLINE=0 \
    HOME=/home/pi \
    PIFLEET_CONTAINER=1 \
    CLOUDSDK_CONFIG=/home/pi/.config/gcloud \
    CLOUDSDK_CORE_DISABLE_PROMPTS=1 \
    USE_GKE_GCLOUD_AUTH_PLUGIN=True
ENTRYPOINT ["/usr/bin/tini","--","pi"]
```

Notes:
- `tini` as PID 1 so signals reach `pi` and zombies are reaped — without it `docker kill --signal=INT` does not interrupt cleanly.
- Fixed uid `10001` matters on Colima/virtiofs: bind-mounted worktrees must be writable by the container user and by Dan on the host. `pifleet doctor` verifies write-through in both directions.
- `--ignore-scripts` on both npm installs (Pi's own doc uses it) — install-time scripts are an unnecessary supply-chain surface.
- `CLOUDSDK_CONFIG` points at a **container-local writable** gcloud config so the CLI can write its token cache without any host config being mounted (§5.8).
- Pinning `PI_VERSION` is mandatory: §4.2's entire protocol contract is version-specific, and this document is already one casualty of assuming otherwise.

### 5.3 Configurable toolchain

**Every** worker image carries the cloud/ops baseline — `gcloud`, `kubectl`, the GKE auth plugin, `helm`, `curl`, `jq`, `git`, `ripgrep` — because SRE-shaped tasks are a primary use case and a role that discovers mid-task that `kubectl` is missing is a wasted run.

`TOOLCHAIN` layers *language* runtimes on top. A reviewer needs none; a tester on a Bun repo needs `node`.

| Value | Adds to the cloud baseline | For |
|---|---|---|
| `base` | — | reviewers, researchers, SRE/ops, doc work |
| `node` | bun 1.3.12 | this codebase's default |
| `python` | python3, uv | data/ML work |
| `go` | golang | go repos |
| `full` | node + python + go | mixed monorepos |

Extra OS packages per image are declared in config (`image.apt_packages`) and appended as a final layer, so a role can add `imagemagick` without a new Dockerfile.

**Sizing note.** The cloud baseline is not small (`google-cloud-cli` alone is several hundred MB). Images are built once per `(pi_version, toolchain, config-hash)` and shared by every worker on that role, so the cost is one build, not one per container. `image gc` prunes old tags.

### 5.4 Configurable skills — the mount, not the image

**Skills are mounted, never baked.** Baking them would mean rebuilding an image to edit a prompt.

At `up`, `pifleet` materializes a per-role skill bundle at `<run-dir>/skills/<role>/` — a directory of symlink-free **copies** of each configured skill — and bind-mounts it read-only at `/skills`. The container then runs:

```
pi --mode rpc --no-skills --no-extensions --no-context-files \
   --skill /skills/pifleet-worker \
   --skill /skills/tdd \
   ...
```

Three consequences, all deliberate:

1. `--no-skills` / `--no-extensions` / `--no-context-files` disable *discovery* — including `<cwd>/.pi/extensions/*.ts` from the repo under test, which Pi otherwise **executes in-process** (§12.2). `--skill` remains additive, so nothing is lost.
2. The bundle is copied, not symlinked, because a symlink into `~/repos/skills/Skills` would resolve outside the mount.
3. `pifleet-worker` (the result contract, §14.4) is injected by the renderer **after** config merge and cannot be removed by a role — a role that overrides `skills:` does not silently lose the contract.

### 5.5 Mount table

Emitted by `buildDockerArgv` (`src/config/render.ts`). The **Condition** column matters as much as
the rest of the row: three of these mounts are conditional, and a reader who assumes every row is
always present will look for a `/secrets` that a worker granted nothing never receives.

| Host | Container | Mode | Condition | Why |
|---|---|---|---|---|
| `<run-dir>/worktrees/<worker>` | `/workspace` | rw | `workspace: worktree` *(default)* | the only writable code path. Widened `a+rwX` recursively at creation and named in `safe.directory` — see the §9.2 amendment |
| `<repo>` | `/workspace` | **ro** | `workspace: shared-ro` | the operator's own checkout, read-only — §9.1 |
| *(no mount)* | — | — | `workspace: none` | the role works against live systems, not the repo — §9.1 |
| `<run-dir>/outbox/<worker>` | `/outbox` | rw | always | result envelopes + file artifacts |
| `<run-dir>/sessions` | `/sessions` | rw | always | transcripts, harvested from the host |
| `<run-dir>/skills/<role>` | `/skills` | **ro** | always | role skill bundle |
| `<run-dir>/workers/<worker>/cloud-allow` | `/policy/cloud-allow` | **ro** | always | the verbgate's policy (§5.10). **Read-only and separate from `/outbox` on purpose** — it used to be read out of `/outbox`, which the worker owns, so the subject of the policy could rewrite the policy and the task-scoped cloud grant was a suggestion rather than a control |
| `<run-dir>/workers/<worker>/task-policy` | `/policy/task` | **ro** | always | the task id and epoch the verbgate stamps on every ledger row (§5.10). Rewritten IN PLACE by the supervisor at each dispatch and cleared at settle — never tmp+rename, because a bind mount pins the inode. Not environment: a container outlives any one epoch, and a worker can rewrite its own environment — ISC-362 |
| `<run-dir>/workers/<worker>/secrets` | `/secrets` | **ro** | only when the worker was granted ≥1 `secrets:` name | granted credentials, one file per name at 0444, reached through `<NAME>_FILE` — §12.4 |
| *(named volume)* `pifleet-piagent-<worker>` | `/home/pi/.pi/agent` | rw | always | container-local Pi state — **never the host `~/.pi/agent`**, which holds Dan's auth and sessions |
| `<run-dir>/workers/<worker>/system-append.md` | `/briefing/system-append.md` | **ro** | only when a briefing fragment exists | the single concatenated `--append-system-prompt` file — §6.3 |
| `<run-dir>/workers/<worker>/kubeconfig` | `/home/pi/.kube/config` | **ro** | only when `cloud.kubeconfig` is set **and** the worker has `cloud_access` | a filtered copy, never the host `~/.kube/config` wholesale |

Nothing outside this table is mounted. Notably **not** mounted: the main checkout (except under
`shared-ro`, read-only, by explicit configuration), `~/.ssh`, `~/.gitconfig`, `~/.env`, the host
`~/.config/gcloud`, or the Docker socket.

> **Erratum (2026-08-30, documentation audit) — this table listed six mounts and closed with the
> sentence "Nothing else is mounted", and both halves were false.**
>
> Three mounts the renderer emits were missing: `/policy/cloud-allow` (**unconditional**),
> `/secrets` (ISC-337..342, shipped 2026-08-29) and `/briefing/system-append.md`. Two of the three
> are the security-relevant ones — the verbgate's policy and the credential store — so the
> sentence that was wrong was also the sentence a reader would rely on when reasoning about what a
> worker can reach. The `shared-ro` and `none` workspace modes were absent too: the table asserted
> `/workspace` was `rw`, full stop, while §9.1 has always documented three modes.
>
> **The closing sentence is now scoped to the table rather than to the author's memory of it**, and
> `test/unit/docs-currency.test.ts` derives the mount list from `render.ts` and fails when the two
> disagree. That test is the actual fix; this erratum only records why it exists. The table drifted
> silently for the same reason every other finding in that audit did — nothing executed it.

### 5.6 Runtime flags

```bash
docker run -i --rm \
  --name pifleet-<run-id>-<worker> \
  --user 10001:10001 \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --pids-limit 512 --memory 4g --cpus 2 \
  --network pifleet-egress \
  --env-file <run-dir>/workers/<worker>/env \
  -v <worktree>:/workspace \
  -v <run-dir>/outbox/<worker>:/outbox \
  -v <run-dir>/sessions:/sessions \
  -v <run-dir>/skills/<role>:/skills:ro \
  -v pifleet-piagent-<worker>:/home/pi/.pi/agent \
  pifleet/pi-worker:<tag> \
  --mode rpc --session-id <run-id>--<worker> --session-dir /sessions …
```

`--read-only` with a `noexec` `/tmp` blocks the "download a binary and run it" path while leaving `/workspace` and `/outbox` writable. `--network pifleet-egress` is a user-defined bridge that the model-provider proxy sits on (§12.4).

### 5.7 Image lifecycle

| Command | Behaviour |
|---|---|
| `pifleet image build [--toolchain t] [--pi-version v] [--tag t]` | builds and tags `pifleet/pi-worker:<pi-version>-<toolchain>-<config-hash>` |
| `pifleet image list --json` | local images with their build args |
| `pifleet image verify --tag t` | runs `pi --version` in the image and asserts it matches the pinned version; asserts uid 10001, read-only root, and `/workspace` write-through |
| `pifleet image gc [--keep n]` | prunes old tags |

`pifleet up` **refuses to start** if a configured role's image is absent or fails `verify` — no implicit builds, so a run never silently uses a stale image.

### 5.8 Google credentials — inherited from the launching Claude instance

Workers inherit Dan's Google identity via **Application Default Credentials**, so `gcloud`, `kubectl`, and Vertex-backed models work inside a container without a separate service account. **One mode.**

| Mode | Mechanism | TTL | Default |
|---|---|---|---|
| **`token`** | supervisor runs `gcloud auth application-default print-access-token` on the **host** and injects it as `CLOUDSDK_AUTH_ACCESS_TOKEN` + `GOOGLE_OAUTH_ACCESS_TOKEN`, refreshing every 45 min | **~1 h** (measured: `expires_in: 3599`) | ✅ |

**Why `token` is the only mode.** The local ADC file is `type: authorized_user` and contains a **`refresh_token`** — a non-expiring credential for Dan's whole Google account. Any worker with `bash` can `cat` a mounted file and exfiltrate it, and a leaked refresh token outlives the run, the container, and the fleet. A one-hour access token is a bounded blast radius.

> **AMENDED 2026-08-25 (ISC-268): `file` mode is REMOVED, not deferred.**
>
> This section previously described a second mode — bind-mount
> `~/.config/gcloud/application_default_credentials.json` read-only at
> `/creds/adc.json` with `GOOGLE_APPLICATION_CREDENTIALS` pointing at it,
> indefinite TTL, opt-in — justified on the grounds that "some flows (long
> `gcloud` operations, certain client libraries) want a credential file".
>
> **It was never implemented.** `buildDockerArgv` emitted no `/creds` mount, and
> `ADC_FILE_PATH`, `fileModeMaterials` and `fileModeStartupEnv` had no caller
> anywhere in `src/`. The config schema accepted `adc_mode: file`, `up` did not
> refuse it, and no credential was mounted — a mode that neither works nor
> fails, whose failure reaches the operator as an unexplained permission error
> inside the container instead of at launch.
>
> Wiring it was the alternative and was rejected on what it would have mounted:
> exactly the `refresh_token` this section's own paragraph above exists to keep
> out of a container, and §12.4's F37. It would also have been the FIRST
> credential path actually built — ISC-248 records that no credential runtime
> exists yet — and its production behaviour cannot be exercised on the
> operator's machine, so it would have shipped unverified. The justification
> was speculative: no flow in this system had asked for it.
>
> Removed with it: `classifyHostGcloudExposure`'s `allowAdcFile` carve-out, the
> single documented exception permitting one artifact out of the host gcloud
> store to be mounted. That exception was the most delicate branch in the
> guard, it defended a path nothing took, and it would have become load-bearing
> on its first real run having never executed against production argv. The
> launcher's rule and the classifier's rule are now the same rule.
>
> `adc_mode` survives as a one-value enum so an operator carrying
> `adc_mode: file` gets a refusal that names the field. If a credential-file
> flow is ever genuinely needed, the shape to build is one that does NOT carry
> an account-wide refresh token — an impersonated or external-account
> credential — which is a §5.8 design question, not a re-enable.

**Never mounted:** the host `~/.config/gcloud` directory. It holds `credentials.db`, `legacy_credentials/`, and `access_tokens.db` — the full gcloud auth store for *every* account Dan has logged in, which is strictly more powerful than ADC itself. Only the single ADC artifact crosses the boundary, and `CLOUDSDK_CONFIG` gives the container its own writable config dir (§5.2).

**Scoping.** `cloud.quota_project` sets `CLOUDSDK_CORE_PROJECT` and the ADC quota project (locally: `gen-lang-client-0675968762`). Where a scoped service account exists, `cloud.impersonate_service_account` is strongly preferred — the supervisor mints an impersonated token instead of a user token, and the worker inherits only that SA's roles rather than Dan's full authority.

**This is a real privilege grant, stated plainly:** a worker with `bash` and `cloud_access: true` can do anything Dan's Google identity can do, for the lifetime of its token. It is off per role by default (`cloud_access: false`), and `pifleet up` prints the granted identity, project, and mode so the grant is never silent.

### 5.9 The LLM is a private oMLX instance

**Every worker's model is served by a private oMLX instance the operator runs.** No hosted provider is involved, in any role, ever. **That prohibition is unchanged and is not what any amendment to this section has relaxed** — it is the constraint that deletes `usd_ceiling`, deletes the provider key, and collapses §12.4's Class 1 to a single env var.

> **Amendment (2026-08-25) — the constraint is PRIVACY, not LOCATION, and this section is retitled to say so.**
>
> Two successive amendments had each moved a boundary and left the title chasing the code. The section began as "the LLM is local — oMLX on the Docker host", became "self-hosted — the Docker host or a trusted LAN peer" when a LAN server was permitted, and would have needed a third clause the moment an operator fronted their own server with a tunnel. Enumerating permitted *places* was the wrong axis: each new place read as a relaxation of the rule when none of them touched the rule at all.
>
> **The requirement is that the instance is the operator's own.** Private means: the operator runs the process, holds its key, and decides who may reach it. It says nothing about which interface it binds or how many hops away it sits. Stated this way the prohibition that actually matters — **no hosted provider, in any role, ever** — is the whole of the constraint, and it is not weakened by any of the deployments below because none of them introduces a third party who serves the model.
>
> **Three deployment shapes are permitted, and they are NOT equivalent in exposure.** The section title stops varying; the security posture varies instead, per shape, and is stated rather than implied:
>
> | Shape | Where the key travels | Who can open a socket to the endpoint |
> |---|---|---|
> | **Docker host** (default) | nowhere — loopback only | processes on that host |
> | **Trusted LAN peer** | one unencrypted L2 hop | every device on the operator's LAN |
> | **Private tunnel** to the operator's own server | the public internet, TLS to the tunnel edge | anyone who learns the hostname |
>
> Exposure grows down that table and the credential argument must be re-taken at each step, which §12.4 does. **Choosing a shape is an operator decision with a security consequence; it is not a config detail**, and the default remains the Docker host precisely because it is the only row whose key never leaves the machine.
>
> **What this amendment does NOT change, stated because a reader could reasonably assume otherwise:**
>
> - **The relay's dial target is untouched.** Under the tunnel shape the tunnel terminates at a listener on the Docker host, so the relay still dials `host.docker.internal` and `§12.8`'s reachable set gains nothing. A tunnel is a property of how the operator's oMLX is *fronted*, upstream of everything this fleet contains.
> - **`relay_upstream` must still be an IP literal or the Docker-host alias — never a hostname.** That rule was derived from a measured resolver failure, not from a locality assumption, so "private instance" does not license a hostname there. See the `relay_upstream` paragraph below, which stands unamended.
> - **`llm.base_url` still names the listen-side alias.** Nothing about privacy changes it. (That alias is `omlx.pifleet.internal` as of ISC-264; it was `host.docker.internal` when this amendment was written.)

What *did* change (2026-08-19, ISC-259) is the word **local**. This section previously read "oMLX running on the same machine as Docker" and stated same-machine locality as a hard constraint. The Docker host is now the **default**, not the requirement; a **trusted LAN** oMLX is permitted. Two measurements forced the amendment, neither of them a preference:

- The oMLX on this Docker host serves **none** of `fleet.example.yaml`'s allowlisted models, so `up` exits 2 against it on the mandatory allowlist check. The machine that does serve them is a different one.
- Keeping the pin would mean either loading every allowlisted model onto every Docker host, or narrowing each fleet's allowlist to whatever its own host happens to hold.

**Verified topology.** Rows are dated: `2026-07-26` is the original measurement, `2026-08-19` was re-measured for this amendment.

| Fact | Evidence |
|---|---|
| The **Docker host's** oMLX listens on `127.0.0.1:8000` — **loopback only** | `lsof -nP -iTCP:8000 -sTCP:LISTEN` → `Python … TCP 127.0.0.1:8000 (LISTEN)` (2026-08-19). Load-bearing for §12.4: this is what makes "no value off this host" true, and it is exactly what stops being true for a LAN server |
| It serves 3 models, **none of them allowlisted** | `GET /v1/models` → `Qwen3-Embedding-4B-4bit-DWQ`, `Qwen3.5-35B-A3B-4bit`, `gemma-4-26b-a4b-it-4bit`. Note `-4bit`, not the allowlisted `Qwen3.5-35B-A3B-8bit` (2026-08-19) |
| The **LAN** oMLX at `192.168.86.49:8000` serves 32 models, **including all three** allowlisted | `GET /v1/models` → HTTP 200; `Qwen3-Coder-30B-A3B-Instruct-4bit`, `Qwen3.5-35B-A3B-8bit`, `GLM-4.5-Air-MLX-4bit` all present (2026-08-19) |
| It is one L2 hop away, not routed | this host is `192.168.86.58/24` on `en0`; `route -n get 192.168.86.49` → `interface: en0`, no gateway. The `10.x` addresses on this machine are Parallels bridges and a VPN tunnel, not the LAN (2026-08-19) |
| A container reaches the Docker host | `docker run --add-host=host.docker.internal:host-gateway` → resolves to `192.168.5.2`; `GET /v1/models` through it returned the server's own auth error, proving the path end-to-end (2026-07-26) |
| It requires a key | `{"error":{"message":"API key required","type":"authentication_error"}}` — a **local server credential** (`OMLX_API_KEY` in `~/.env`), not a billing credential (2026-07-26) |
| **It passes the OpenAI `tools` param through correctly** | `Qwen3-Coder-30B-A3B` and `Qwen3.5-35B-A3B` both returned `finish_reason: tool_calls` with well-formed calls and valid JSON arguments (2026-07-26) |

**How a LAN oMLX is configured — two fields, deliberately.**

`llm.base_url` describes **what a worker dials**, and its host must be `omlx.pifleet.internal`: that is the relay's listen-side alias on the internal bridge, so a `base_url` naming anything else is a listener no worker can resolve. `llm.relay_upstream` describes **what the relay dials** — `host:port`, explicit port required, defaulting to `host.docker.internal:<port from base_url>` so an untouched `fleet.yaml` behaves exactly as it did before.

Two keys rather than one overloaded key, because `base_url` already serves two masters — the worker's URL *and* the egress policy's LLM rule. Judging the relay's dial target against a policy derived from that same field is a check that can only agree with itself, and that circularity is why ISC-253 stayed open across two PRs. See `src/security/relay.ts:relayGatePolicy`.

**A LAN upstream additionally requires an explicit `egress.allow` entry**, and this is not ceremony. The relay is the one sanctioned hole in a deny-all bridge carrying untrusted model output. Pointing its dial side off-host without an operator-authored allow rule would make an arbitrary `host:port` on the operator's LAN reachable from that bridge by editing a single YAML string. The allow entry *is* the security decision, and it is deliberately not derivable from the endpoint change.

**`relay_upstream` must be an IP literal (or the Docker-host alias) — never a LAN hostname.** Measured: the relay resolves through Docker's embedded DNS, which forwards to the host resolver, and this machine's resolver does **not** answer mDNS/`.local` names (`macbook.local` needed `dns-sd`). A hostname there produces a relay that starts cleanly, reports ready, and then fails every connection with a resolution error no operator-facing surface shows. `config validate` refuses it, so the failure becomes a sentence instead. Consequently `--add-host host.docker.internal:host-gateway` is emitted **only** when the relay actually dials the Docker host; for a LAN IP there is nothing to resolve and the flag is omitted rather than left in the argv implying a route that is not used.

**RESOLVED 2026-08-25 (ISC-264): the listen-side alias is `omlx.pifleet.internal`.**

It was `host.docker.internal`, and that name stopped being true once the dial side could be a LAN peer — to a worker the alias means "wherever this fleet's oMLX is", not "the Docker host". The rename was deferred twice on two checkable arguments, one of which still holds and is why this was a naming debt rather than a live bug:

1. **Still true, and it is the reason nothing broke while the overload stood.** The name had no prior meaning on an `--internal` bridge to shadow. Measured: a container on such a bridge cannot resolve `host.docker.internal` at all — Docker does not inject it there — so it resolved only because the relay attached it as an alias.
2. **Expired.** When the deferral was taken, `model-probe.ts:hostFacingBaseUrl` rewrote exactly this literal to `localhost` for host-side probing, so a second accepted spelling would have skipped the rewrite and misprobed. **ISC-260 deleted that helper**: the `up` probe now runs inside the egress network and dials `llm.base_url` verbatim, exactly as a worker does.

> **What the rename FOUND, which is the part worth reading.**
>
> `relayGatePolicy`'s rule 1 authorizes the one destination the relay may reach without an operator-written `egress.allow` entry: **the Docker host at the listen port**. It was built from `RELAY_LISTEN_ALIAS` — the name workers dial on the internal bridge, a different thing — and the dial-side constant is `RELAY_DEFAULT_DIAL_HOST`. The two held the **same string**, so a rule about one side written from the other side's constant was undetectable by any test.
>
> Changing the value surfaced it immediately and fatally: the default target `host.docker.internal:8000` no longer matched the default rule `omlx.pifleet.internal:8000`, and every fleet would have refused at launch with no config having changed. Rule 1 now names `RELAY_DEFAULT_DIAL_HOST`. Two constants that mean different things must not be interchangeable by coincidence.
>
> The same coincidence had a second consequence, recorded because PR #18 documented the symptom without finding the cause: `policyFromConfig`'s apparent **self-agreement** — the "DOCUMENTED VACUITY" that motivated building a separate relay gate — was itself an artifact of the shared literal. Its `llm` rule derives from `base_url` (the listen side) and the target is built from the dial side; with the names separated, the same call now refuses. The separate gate was still the right fix, because it is independent of config *by design* rather than by coincidence.

**Transition.** `relayConnectArgv` attaches **both** aliases and `llm.base_url` accepts either spelling, warning on the old one. A worker's `models.json` is rendered from `base_url`, so an existing `fleet.yaml` needs the old name to *resolve*, not merely to validate. `RELAY_DEFAULT_DIAL_HOST` is unchanged and remains `host.docker.internal` — it genuinely is the Docker host.

Anything needing the *actual* Docker host from inside the bridge must use the gateway address (§12.8), never the listen alias. `doctor` retains a **host** vantage (output labelled `omlx (from host)` / `"vantage": "host"`) and recognises both spellings for its diagnosis.

**The native-tool-call probe is mandatory (F39).** Whether native tool calls come back is a property of the **model's chat template**, not of oMLX: this codebase has a recorded live measurement of `Qwen3-8B-4bit` emitting reasoning *prose* instead of `tool_calls` through this same server. A Pi worker pointed at such a model looks perfectly healthy — it streams tokens, ends turns, settles — and accomplishes **nothing**, because its intended actions never become tool calls. That is the "correct-fix-as-prose" failure documented in `~/mlx-lab/docs/agentic-sre-srd.md`, and at fleet scale it would burn a whole run before anyone noticed.

Two guards, because a startup probe alone can be passed by a model that then drifts:

1. **Startup probe.** `up` and `doctor` send a one-shot `tools`-bearing request to **every model in `models_allowlist`** and **exit 2** on any model that answers with prose. Catches the whole class in seconds, before a worker starts.
2. **Runtime detector.** The supervisor counts tool calls per epoch. A worker that completes `prose_turns_before_fail` turns (default **3**) with **zero** tool calls is classified `failed` with reason `no_tool_calls` — it does not get to settle "successfully". This catches a model that passes the probe and then degrades under a long context, and it converts the silent failure into a loud one at ~3 turns instead of ~1 hour.

`require_native_tool_calls: false` disables both, and is only appropriate for a role that genuinely needs no tools.

**What the constraint deletes:**

- **The host auth proxy is not built.** There is no cloud provider key to keep out of a container, so §12.4's Class 1 collapses to a single env var. The oMLX key guards a self-hosted inference server with no billing authority, and injecting it directly is proportionate. **The "costs nothing beyond this machine" half of that argument is weaker for a LAN oMLX and is restated honestly in §12.4** — it is not silently carried over.
- **`usd_ceiling` is meaningless and is removed.** A local model has no price table, so `get_session_stats.cost` is `0` forever. **`tokens_ceiling` is the only real ceiling** and is mandatory. This also dissolves F27 — an unpriced model is now the expected case, not an error to catch.
- **Containers need no internet for inference.** The egress bridge allows the relay's upstream (`host.docker.internal:8000` by default) plus the Google endpoints that `cloud_access` roles require, and **denies everything else by default** — a far tighter posture than a hosted-provider design permits. A LAN oMLX does not change what a *worker* reaches: workers still dial only the alias, and it is the relay — not the worker — whose reachable set gains the LAN endpoint (§12.8).

**What the constraint adds — shared inference (F40).** Six workers are no longer six independent API clients; they are **six clients queuing on one Apple-silicon inference server.** Fleet parallelism is bounded by oMLX throughput, not by an API rate limit:

- `run.max_concurrent` is tuned to measured oMLX concurrency, not to pane count. **Default drops from 4 to 2.**
- A slow generation is now everyone's problem — it adds latency to every other worker's next turn.
- `event_stall_warn` must absorb queueing delay, or healthy-but-queued workers get killed as wedged (F20 false positive).
- `doctor` reports the oMLX model list and measures single-request latency so `max_concurrent` is set from evidence rather than guessed.
- This machine has a recorded incident where concurrent heavy GPU load turned a process OOM into a **kernel watchdog panic**. `pifleet up` refuses to start while an MLX training run is active; `--i-know` overrides.

### 5.10 Mutating cloud verbs are gated

§12.4 grants a `cloud_access` worker Dan's Google identity for up to an hour. A worker with `bash` could then run `kubectl delete`, `helm uninstall`, or `gcloud compute instances delete` against live infrastructure — and unlike a bad code edit, that is not recoverable from a git branch. **Read verbs flow freely; mutating verbs require per-task authorization.**

**Mechanism.** The real binaries are moved to `/usr/local/libexec/<name>.real` at image build; a single `verbgate` shim takes their names on `PATH`. The shim classifies `argv` and either execs the real binary or refuses with exit 77 and a ledger entry.

```
gcloud|kubectl|helm  <verb> …
   │
   ├── read verb   →  exec /usr/local/libexec/<name>.real   (always)
   │      kubectl: get describe logs top explain api-resources version diff
   │      gcloud:  list describe get-* print-* version info
   │      helm:    list get status history version template lint
   │
   └── mutating verb →  is it in the task envelope's cloud_allow[]?
          yes → exec real binary, log {task_id, epoch, argv} to the ledger
          no  → exit 77, stderr: "verbgate: 'kubectl delete' not authorized
                 for task T-004; add it to cloud_allow[] to permit"
```

**Task-scoped, not run-scoped.** Authorization lives in the dispatch envelope (§7.1), so permission is granted for one task and expires with it:

```json
"cloud_allow": ["kubectl rollout restart", "kubectl scale"]
```

Matching is on the **normalized verb prefix** (`kubectl rollout restart`), not a regex over the whole command line — a substring match would be trivially defeated by flag reordering. `cloud_allow: ["*"]` exists for a task Dan explicitly wants unrestricted, and `up` prints every worker whose tasks carry it.

**What this does and does not buy.** It stops the *casual* destructive action — the confused agent, the over-eager cleanup, the injected instruction that says "delete the failing deployment." It does **not** stop a determined one: the worker has `bash`, so `/usr/local/libexec/kubectl.real` is directly reachable, and a token in the environment can be used with `curl` against the API directly. Closing that requires the credential to be scoped rather than the command line filtered — which is why `impersonate_service_account` remains the stronger control and the wrapper is defence-in-depth on top of it, not a substitute for it.

The gate is enforced for **every** `cloud_access` role. Roles without cloud access have no credential, so the shim is irrelevant to them.

> **Erratum (2026-08-30, documentation audit) — "task-scoped" is the design, not the build. The
> policy file the shim reads is written EMPTY at `up` and is never rewritten, so in production the
> gate is deny-all for mutating verbs and the `cloud_allow[]` an operator writes into a dispatch
> envelope reaches no container.**
>
> Everything above about the SHIM is accurate and was verified against `docker/verbgate`: read verbs
> exec unconditionally, mutating verbs need a normalized verb-prefix match, refusal is exit 77,
> `*` is honoured (`docker/verbgate:240`), the policy path and ledger path are constants the subject
> cannot redirect, and a policy file writable by the current uid refuses everything with exit 78.
> What is missing is the SUPPLY side.
>
> **The measurement.** `src/config/render.ts:272` mounts
> `` `${opts.worker.cloudAllow}:/policy/cloud-allow:ro` `` — per WORKER, fixed at container start.
> `src/run/paths.ts:365` puts that file at `<run>/workers/<id>/cloud-allow`.
> `src/run/materialize.ts:806` is `await writeFile(paths.cloudAllow, "")` and is the ONLY writer:
> `grep -rn 'cloudAllow' src/` returns ten lines, of which one writes (that one), one mounts, one
> records the path into a launch record, and the rest are the path definition and its permission
> handling. `dispatch` never touches it — `src/cli/commands/dispatch.ts:953` puts `cloud_allow` into
> the ENVELOPE, which is delivered over the control socket to the supervisor and rendered into a Pi
> `prompt` (§7.1); no leg of that path writes the mounted policy.
>
> **The code says so itself, which is why this is a documentation gap rather than a discovery.**
> `src/run/materialize.ts:783` opens "WHOEVER WIRES DISPATCH-TIME REWRITING:" and then specifies the
> exact procedure that writer must follow — chmod 0644, write IN PLACE, chmod back to 0444, never
> tmp+rename, because a bind mount pins the inode. That note is a correct and useful spec for work
> that has not been done, and this SRD read as though it had been.
>
> **A second, smaller consequence — FIXED 2026-08-30 by ISC-362; kept here because the reasoning
> that followed it was half wrong.** `docker/verbgate` read `PIFLEET_TASK_ID` and `PIFLEET_EPOCH`
> for the ledger row's provenance fields, and `grep -rnF 'PIFLEET_TASK_ID' src/` returned nothing —
> both were set only by `test/integration/verbgate.test.ts` and `test/integration/image.test.ts`,
> never by production. So the `{task_id, epoch, argv}` the diagram promises was `{"<none>", 0, argv}`
> for every row a real run produced.
>
> The diagnosis was right that neither could be an env var of the CONTAINER, since the container is
> started once at `up` while the task changes per dispatch. It was **wrong** to conclude that
> binding them "needs the same dispatch-time write the policy does", where *the policy* means
> `/policy/cloud-allow` and its unbuilt rewriter. Provenance needs a dispatch-time write, but not
> THAT one: it is a separate file carrying no authorization semantics, so it could be — and was —
> built on its own. Reading the two as one piece of work is what kept a repair that took an
> afternoon waiting on one that is still an open decision.
>
> Provenance is now `/policy/task` (§5.5), a run-tree file bind-mounted **read-only**, rewritten in
> place by the supervisor at each dispatch and cleared at settle. Read-only matters as much as the
> value: environment is worker-controlled, so the old carrier let a worker forge the one field an
> investigator would trust. The write follows the recipe `materialize.ts` states for the policy
> rewriter — chmod 0644, truncate in place, chmod back to 0444, never tmp+rename, because a bind
> mount pins the inode. `PIFLEET_TASK_ID` remains set nowhere, and that absence is now a regression
> guard rather than the defect.
>
> **The disposition — DESCOPED 2026-08-30 by owner decision (ISC-366), superseding the "recorded,
> not fixed" holding this paragraph used to carry.** The rewriter will not be built. Task-scoped
> cloud authorization is withdrawn from the design rather than left pending, and the sections above
> are kept as the record of what was designed and why it is not here.
>
> **What that means concretely.** The mounted policy is written empty at `up` and never rewritten,
> so the verbgate refuses EVERY mutating cloud verb with exit 77, for every worker, for the life of
> every run. That is not a degraded mode; it is the shipped behaviour. Read verbs are unaffected.
>
> **`cloud_allow[]` is now REFUSED at parse time, not ignored** (`src/contracts.ts`, both
> `TaskEnvelopeSchema` and `TaskSpecSchema`). A field that is accepted and does nothing is worse
> than a field that is gone: the operator sets `cloud_allow: ["kubectl scale"]`, the brief tells
> the worker it may scale, the worker tries, and the gate refuses — one epoch spent discovering
> that a grant the document offered does not exist. The key remains in the schema at length zero
> because the envelope is a wire format the supervisor also parses, and removing a key is a
> compatibility break for a change whose whole point is that nothing depends on it.
>
> **The control that does exist is the credential's SCOPE.** `impersonate_service_account` was
> always described here as the stronger of the two, with the verb gate as defence-in-depth on top
> rather than a substitute; descoping the weaker half leaves that argument intact. A worker holding
> a credential scoped to what its role may touch is bounded by the cloud provider's own
> authorization, which no amount of shell in the container can widen — where the verb gate is a
> filter on a command line that `bash` can route around.
>
> **Why descope rather than build.** Nothing depends on the mechanism; it fails closed, so there is
> no exposure to close; the audit trail half of §5.10 was repaired independently by ISC-362; and a
> half-built authorization system that reads as complete is precisely the failure this document
> spent 2026-08-30 removing.

---

## 6. Configuration

### 6.1 Format and resolution

YAML, resolved in precedence order: `--config <path>` → `./fleet.yaml` → `~/.config/pifleet/fleet.yaml`. Validated against a published JSON Schema; `pifleet config validate --json` is the probe.

Merged `defaults` ← `roles` ← per-worker overrides, **shallow**, with three explicitly stated exceptions (v1.1 left these implicit and its own worked example could not be produced from its stated rule):

1. **Arrays replace, they do not concatenate** — except `skills`, where `pifleet-worker` is re-injected post-merge and cannot be removed.
2. **A `:thinking` suffix inside a `model` string outranks a `thinking:` key at any level**, and is decomposed into `--model` + `--thinking`. A `provider/` prefix is decomposed into `--provider`.
3. **Relative paths resolve against the config file's directory**, not the cwd and not `run.repo`.

### 6.2 Worked example

```yaml
version: 2
name: paisley-feature-fleet

backend:
  kind: cmux                 # cmux | tmux | headless
  workspace: pifleet         # matched on custom_title; recorded by id in registry.json
  split: alternate           # alternate | columns | rows  (pifleet-side split sequence)
  focus_on_dispatch: false

docker:
  image_prefix: pifleet/pi-worker
  pi_version: "0.79.6"       # pinned; must match §4.2's protocol contract
  network: pifleet-egress
  memory: 4g
  cpus: 2
  pids_limit: 512
  read_only_root: true

run:
  root: ~/.pifleet/runs
  repo: ~/repos/paisley
  isolation: worktree        # worktree | shared-ro | none
  branch_prefix: fleet
  max_concurrent: 2          # bounded by oMLX throughput, not pane count (§5.9)
  prose_turns_before_fail: 3 # zero-tool-call turns before `failed:no_tool_calls`;
                             # 0 = off, as does require_native_tool_calls: false (§5.9)
  budget:
    tokens_ceiling: 6000000  # THE ceiling — local models have no price table
    per_task_reserve_tokens: 400000
    per_task_timeout: 25m
    run_timeout: 2h
  timers:
    ui_request_timeout: 5s
    event_stall_warn: 3m
    event_stall_kill: 25m
    heartbeat_interval: 5s

llm:                         # ALWAYS self-hosted oMLX, never a provider — §5.9
  provider: omlx
  base_url: http://host.docker.internal:8000/v1   # what a WORKER dials (relay alias)
  # relay_upstream: 192.168.86.49:8000            # what the RELAY dials; unset =
                             # host.docker.internal:<port from base_url>. Anything
                             # else ALSO needs a matching egress.allow entry (§5.9)
  api_key_env: OMLX_API_KEY  # self-hosted server credential, injected by the supervisor
  model: Qwen3-Coder-30B-A3B-Instruct-4bit
  thinking: medium
  models_allowlist:          # checked against GET /v1/models at `up`
    - Qwen3-Coder-30B-A3B-Instruct-4bit
    - Qwen3.5-35B-A3B-8bit
    - GLM-4.5-Air-MLX-4bit
  require_native_tool_calls: true   # `up` probes each model — see §5.9

cloud:
  adc: true                  # inherit the launching Claude instance's Google identity
  adc_mode: token            # the only mode: a ~1h access token (§5.8)
  quota_project: gen-lang-client-0675968762
  impersonate_service_account: null    # strongly preferred where one exists
  kubeconfig: null           # path to a FILTERED kubeconfig; never the host default
  token_refresh: 45m

secrets:
  # The grant CEILING. A role draws against it with its own `secrets: [NAME]`;
  # a name is delivered only when it is in BOTH. Delivery is a 0444 FILE under
  # /secrets plus a `<NAME>_FILE` pointer — never the value in the environment.
  # The key name is historical; see the §12.4 erratum. NEVER provider keys.
  # An entry may be written long — `- {name: X, credential: false}` — for a
  # granted variable that is not a secret, which is delivered but not swept.
  env_allowlist: []

egress:
  # The deny-all bridge's allowlist. The relay may reach the Docker host at the
  # listen port without an entry here; anything else — including a LAN oMLX named
  # by `llm.relay_upstream` — needs an explicit rule (§5.9, §12.8).
  allow: []

# harness:                   # omitted entirely = the 91 built-in defaults (§6.5, §8.2a).
#   patterns: ["ci/**"]      # `patterns: []` is a validation error, not "match nothing".
#   replace: false           # false EXTENDS the defaults; true REPLACES them.

defaults:
  pane_mode: rpc
  toolchain: base
  cloud_access: false        # ADC is NOT granted unless a role opts in
  skills: [pifleet-worker]
  exclude_tools: []
  no_context_files: true     # repo AGENTS.md/CLAUDE.md is untrusted input

roles:
  # ---- SRE / cloud-ops: the primary role set ----
  sre:                                    # diagnoses AND remediates
    model: Qwen3-Coder-30B-A3B-Instruct-4bit
    toolchain: base                       # gcloud/kubectl/helm are in every image
    tools: [read, write, edit, bash, grep, find, ls]
    skills: [pifleet-worker, sre]
    cloud_access: true                    # ADC grant — §5.8; verbs gated by §5.10
    isolation: worktree                   # manifest/IaC edits land on a branch
    append_system_prompt_file: ./roles/sre.md
  investigator:                           # read-only diagnosis; never mutates
    model: Qwen3.5-35B-A3B-8bit
    thinking: high
    toolchain: base
    tools: [read, bash, grep, find, ls]   # bash for kubectl/gcloud READ verbs
    skills: [pifleet-worker, sre]
    cloud_access: true
    isolation: none
    append_system_prompt_file: ./roles/investigator.md
  verifier:                               # confirms a remediation actually worked
    model: Qwen3-Coder-30B-A3B-Instruct-4bit
    toolchain: base
    tools: [read, bash, grep, find, ls]
    skills: [pifleet-worker, sre]
    cloud_access: true
    isolation: none
    append_system_prompt_file: ./roles/verifier.md

  # ---- code roles: available, secondary ----
  engineer:
    model: Qwen3-Coder-30B-A3B-Instruct-4bit
    toolchain: node
    tools: [read, write, edit, bash, grep, find, ls]
    skills: [pifleet-worker, tdd, diagnose]
    append_system_prompt_file: ./roles/engineer.md
  reviewer:
    model: Qwen3.5-35B-A3B-8bit
    thinking: high
    toolchain: base
    tools: [read, grep, find, ls]        # NO bash — see §12.1
    skills: [pifleet-worker]
    append_system_prompt_file: ./roles/reviewer.md
    isolation: shared-ro
  tester:
    model: Qwen3-Coder-30B-A3B-Instruct-4bit
    toolchain: node
    tools: [read, bash, grep, find, ls]
    skills: [pifleet-worker]
    append_system_prompt_file: ./roles/tester.md

  ticketing:
    model: Qwen3-Coder-30B-A3B-Instruct-4bit
    toolchain: base
    workspace: none          # works against a live ticket API, not the repo
    tools: [read, bash, grep, find, ls]
    skills: [pifleet-worker, ticket-ops]
    secrets: [TICKET_API_TOKEN, TICKET_BASE_URL]   # drawn against the ceiling above
    append_system_prompt_file: ./roles/ticketing.md

workers:
  # 6 panes, 2 generating at a time (§9.3) — panes stay warm and visible,
  # admission control does the queuing against the single oMLX server.
  - {id: sre-1,  role: sre}
  - {id: sre-2,  role: sre}
  - {id: inv-1,  role: investigator}
  - {id: ver-1,  role: verifier}
  - {id: eng-1,  role: engineer}
  - {id: rev-1,  role: reviewer}
```

**On the configurable LLM.** `llm:` sets the fleet default and any role overrides `model` or `thinking`. There is exactly one auth path, because there is exactly one provider: a self-hosted oMLX server, which every worker reaches at `host.docker.internal:8000` with `OMLX_API_KEY` injected by the supervisor (§5.9). That address is the relay's listen-side alias and is what workers dial regardless of where the server actually runs; `llm.relay_upstream` decides the latter, and moving it off the Docker host also requires an explicit `egress.allow` entry. `models_allowlist` is checked at `up` against `GET /v1/models` **and** against a native-tool-call probe, so a model that would silently answer in prose fails the run before a worker starts rather than after it has burned an hour.

Two things changed from v1.1's example and both were review findings: the reviewer no longer has `bash` (a role labelled read-only that could `cd /` and `git push`), and the researcher no longer requests `web_fetch`, which is not a Pi tool and silently granted nothing.

### 6.3 Config → container invocation

`pifleet render --worker eng-1 [--json]` prints the exact `docker run` argv and the exact `pi` argv without executing. The render criterion compares **normalized argv arrays with paths canonicalized**, not a byte string, so the gate does not encode one machine's home directory.

`--append-system-prompt` is **not repeatable**: the renderer concatenates all briefing fragments (defaults + role + worker) into a single file at `<run-dir>/workers/<id>/system-append.md`, mounts it, and passes that one path. No `@` sigil — the flag takes a bare path or literal text, and an `@`-prefixed string is silently appended as *literal text*, which is how a role briefing becomes a 40-character path string with no error.

### 6.4 Worker kinds

| kind | Container | Lifetime | When |
|---|---|---|---|
| `persistent` *(default)* | one long-lived `docker run -i`, RPC mode | whole run, many tasks | most work |
| `oneshot` | one container per task, `pi -p --mode json` | one task | cheap stateless fan-out |

---

### 6.5 `harness:` — which paths count as the test harness

Governs the §8.2a cap. Optional; omitting the whole key is the supported way to say "no opinion".

```yaml
harness:
  patterns: ["ci/**", "scripts/verify.sh"]   # repo-relative globs
  replace: false                             # default: EXTEND the 91 built-in globs
```

| Key | Default | Meaning |
|---|---|---|
| `patterns` | *(unset — the 91 built-in globs)* | repo-relative globs that count as the test harness |
| `replace` | `false` | `false` EXTENDS the built-in defaults; `true` REPLACES them outright |

Three rules, each of which exists because the obvious alternative was a silent-disable path:

1. **`patterns: []` is a validation error, not "match nothing".** An empty list reads like "no
   opinion" and would switch the ISC-150 cap off entirely — `touched` could never be non-empty. To
   mean "no opinion", omit the key. The error message says so rather than reporting a formatting
   nit, because the obvious way to satisfy a formatting nit is to put *something* in the list, and
   any list that matches nothing narrows the surface exactly as an empty one does.

2. **`replace: false` is the default, and it changed on 2026-08-25 (ISC-243).** Replacement used to
   be the only behaviour, which made the realistic first edit — `patterns: ["ci/**"]`, to add one CI
   file someone cared about — silently swap out all 91 defaults and disable the cap for every diff
   that did not touch `ci/`. The over-cap that replacement answers is a **loud** failure (a run
   capped to `unknown`); the under-cap it caused is a **silent** one (a red suite certified
   `success`). Extending makes the common edit safe and leaves the rare one available by name.

3. **A narrowed surface is a weakened cap, and that is a legitimate but deliberate operator
   decision.** A repo whose suites do not live under `test/` needs `replace: true`. When a
   configured surface matches nothing that the defaults *would* have matched, the harvester records
   the difference as `defaults_missed` on the artifact rather than staying quiet about it.

> **Added 2026-08-30 (documentation audit).** `harness` is a top-level key of a `.strict()` schema —
> so it has always been spellable, and always been the only lever over the §8.2a cap — and it
> appeared in no version of THIS document. `fleet.example.yaml` had carried a thorough commented
> block for it all along, which is how the audit's first pass came to report the example as silent
> too: that half of the finding was asserted rather than grepped, and it was wrong.
>
> **Checking it properly turned up the worse defect.** That block still described `patterns` as
> REPLACING the defaults — true when it was written, false since 2026-08-25 (ISC-243) — and never
> mentioned `replace` at all. So the one document that did cover this key was telling operators the
> opposite of the shipped default, in the direction that silently weakens the cap. The block is
> rewritten here, and the same stale reasoning has been corrected in the two user-facing error
> messages that carried it (`src/config/schema.ts`, `src/harvest/acceptance.ts`).

---

## 7. Protocols

### 7.1 Task dispatch envelope

`<run-dir>/inbox/<task-id>.json`, delivered over the worker's control socket, rendered into the Pi `prompt` message.

```json
{
  "schema": "pifleet.task/v1",
  "task_id": "T-004",
  "run_id": "2026-07-26T14-02-11Z-8f3a",
  "epoch": 1,
  "attempt": 1,
  "worker": "eng-1",
  "dispatched_at": "2026-07-26T14:02:19Z",
  "title": "Add --json to kasa-cli status",
  "brief": "Full markdown instructions…",
  "repo": "/Users/dan/repos/kasa-cli",
  "host_workdir": "/Users/dan/repos/kasa-cli/.worktrees/eng-1",
  "container_workdir": "/workspace",
  "branch": "fleet/2026-07-26T14-02-11Z-8f3a/eng-1",
  "base_ref": "9f1c2ab3e4d5f60718293a4b5c6d7e8f90a1b2c3",
  "inputs": [{"path": "/workspace/src/status.ts", "why": "primary edit target"}],
  "acceptance": ["bun test passes", "kasa status --json | jq -e .devices exits 0"],
  "constraints": ["Stay inside /workspace", "No AI attribution in commit messages"],
  "outbox": "/outbox/T-004",
  "cloud_allow": [],
  "deadline_s": 1500,
  "depends_on": []
}
```

**`epoch` is mandatory** (v1.1 required workers to stamp an epoch the task envelope never supplied — every envelope would have been rejected as stale). **`base_ref` is a resolved 40-char SHA**, because §8.2 grades against `git diff <base>...HEAD` and a symbolic ref moves. **`dispatched_at`** makes `deadline_s` computable after an orchestrator restart.

**Paths are container paths.** The worker only ever sees `/workspace`, so the v1.1 wrong-checkout hazard disappears by construction rather than by heuristic. `inputs[]` is the **only** path channel: the brief is *rendered from* that structure, and `pifleet` rejects any brief containing an absolute host path. Scanning free-form prose for paths — v1.1's approach — both false-positives on code samples and fails open on paths it doesn't recognize.

> **Erratum (2026-08-30, documentation audit) — the second and third sentences describe a control
> that does not exist. `inputs[]` reaches no prompt, and no brief is ever scanned or refused.**
>
> **What the worker is actually sent.** `renderPrompt` (`src/supervisor/index.ts:1937-1943`) takes
> `{title, brief, acceptance}` and returns `` `# ${title}\n\n${brief}` `` plus an `## Acceptance`
> list. `inputs` is not a parameter of it. `grep -rnE '\.inputs|inputs:' src/ --include='*.ts'`
> returns four envelope-side lines — the schema at `src/contracts.ts:128` and `:1154`, and the two
> writers at `src/cli/commands/dispatch.ts:264` and `:950` — and no reader anywhere. So `inputs[]`
> is carried in the envelope, persisted to `<run-dir>/inbox/<task-id>.json`, and never delivered to
> the agent. **It is not a path channel at all; it is a record.**
>
> **No brief is refused.** `brief` is length-bounded and nothing else: `src/contracts.ts:121` is
> `brief: text,` where `text = z.string().max(MAX_TEXT)`. There is no host-path predicate in `src/`
> under any spelling.
>
> **The rule survives as an instruction to the worker, which is a weaker thing and is named as such.**
> `skills/pifleet-worker/SKILL.md` tells a worker that an absolute host path in a brief is a bug to
> report rather than to act on. That is a document mounted into the container, so it is exactly the
> shape ISC-344/349/350 are graded `[~]` for: shipping an instruction is not the same as anything
> re-checking that it was followed, and here nothing on the pifleet side even attempts the check the
> sentence above claims.
>
> **The paragraph's reasoning is still right, and that is why this is an erratum and not a deletion.**
> Scanning free-form prose for paths does false-positive on code samples and does fail open. The
> conclusion drawn from it — put paths in a structured field and refuse them in prose — was never
> built on either side: the structured field has no consumer, and the refusal has no implementation.
> Closing this needs one of the two, and the cheap one is the reader: `renderPrompt` gaining an
> `## Inputs` section would make `inputs[]` the channel this section says it is.

### 7.2 Result envelope — advisory, not authoritative

Written by the worker to `/outbox/<task-id>/result.json`, atomically (tmp + `fsync` + `rename` + **directory fsync**), under instruction from the `pifleet-worker` skill.

> **Correction (2026-08-30, documentation audit) — the shipped instruction is tmp + `fsync` +
> `rename`, without the directory fsync.** `skills/pifleet-worker/SKILL.md` says "write a temp file,
> `fsync` it, rename it into place". The writer here is the WORKER, not pifleet, so that document is
> the entire mechanism and the parenthesis above overstates it by one step. pifleet's own durable
> writes do fsync the containing directory (`src/util/jsonl.ts:594`, `fsyncDirBestEffort`), which is
> where the four-step form in this sentence came from — but nothing pifleet writes is this file.
> Left as an instruction gap rather than closed: a directory fsync is awkward to ask an agent for in
> shell, and the failure it guards against (rename durable, directory entry not, across a host crash
> mid-harvest) is not one this system has met.

> **Primacy rule.** The envelope is authored by the actor being graded. It is **advisory metadata that may downgrade a verdict but never upgrade one.** Authority belongs to derived facts: the worktree diff, the commits, the exit codes of acceptance commands the harvester re-runs itself, and the transcript's terminal state.
>
> `"status":"success"` with an empty diff and no commits is reported **failed**.

```json
{
  "schema": "pifleet.result/v1",
  "task_id": "T-004", "epoch": 1, "worker": "eng-1",
  "status": "success",
  "summary": "Added --json flag; status now emits a devices array.",
  "files_changed": [{"path": "src/status.ts", "change": "modified", "lines_added": 34, "lines_removed": 6}],
  "commits": ["a1b2c3d4e5f6789012345678901234567890abcd"],
  "branch": "fleet/<run-id>/eng-1",
  "commands_run": [{"cmd": "bun test", "exit_code": 0, "excerpt": "27 pass, 0 fail"}],
  "acceptance": [{"criterion": "bun test passes", "met": true, "evidence": "27 pass, 0 fail"}],
  "artifacts": [{"kind": "file", "path": "/outbox/T-004/files/status-json.md"}],
  "blockers": [], "notes": ""
}
```

**Normalization:** `files_changed[].path` is **repo-relative** and is compared against `git diff --name-status` output after both sides are normalized. `commits[]` are **full 40-char SHAs**. v1.1 mixed absolute and relative paths across §7.1/§7.2/§8.2, which would have tripped the envelope-vs-diff hard failure on every single run.

**The envelope is untrusted input, not just unreliable testimony** (§12.5): every path is canonicalized and must resolve under that worker's outbox or worktree; symlinks and non-regular files are refused; every string and array is length-bounded; parsing happens before any dereference.

### 7.3 Status vs verdict — two vocabularies, not one

v1.1 published a four-value enum and then produced `unknown`, `aborted`, `timed_out`, `stalled`, and `dead` elsewhere in the same document, so its own schema-validation criterion could not pass on the failure paths it most carefully designed.

| Field | Author | Domain |
|---|---|---|
| `status` | the worker | `success` \| `partial` \| `blocked` \| `failed` |
| `verdict` | the harvester | `success` \| `partial` \| `blocked` \| `failed` \| `aborted` \| `timed_out` \| `unknown` |
| `phase` | the supervisor | `starting` \| `idle` \| `busy` \| `settling` \| `stalled` \| `dead` |

Adjudication lattice: `failed < blocked < partial < success`. `verdict = min(derived, claimed)` where **`unknown` is identity, not bottom** — a task with a clean diff and green acceptance commands is not downgraded merely because the worker forgot to write an envelope. `aborted` and `timed_out` are terminal and set by the supervisor, not derived.

### 7.4 Completion — `agent_end{willRetry:false}`, quiesced

**`agent_settled` does not exist in Pi 0.79.6.** v1.1's normative rule — *"completion is detected on `agent_settled`, never on `agent_end`"* — named an event that never arrives, and a fleet built on it would have hung on `wait` forever, on every task.

The *reasoning* behind that rule was right: `agent_end` genuinely does fire before an automatic retry. The discriminator is a field on the event itself. **A task is complete for its epoch when all four hold:**

1. `agent_end` received with **`willRetry === false`**;
2. no retry pending — `auto_retry_start` not outstanding, and no `summarization_retry_scheduled` un-finished;
3. `queue_update` shows `steering[]` and `followUp[]` both empty;
4. a **correlated** `get_state` response reports `isStreaming: false` and `pendingMessageCount: 0`.

Condition 4 is what makes it sound (§7.5).

### 7.5 Epoch fencing

Every dispatch gets a monotonic epoch, recorded in `state.json` **before** the `prompt` is written. But **Pi events carry no `id`** — only responses do — so terminal events cannot be attributed to an epoch by inspection. That admits a real interleaving:

1. Epoch N dispatched, long turn.
2. Deadline fires; supervisor issues `abort` (asynchronous).
3. Before the abort lands, the turn completes naturally → `agent_end{willRetry:false}`.
4. Supervisor, believing N aborted, advances to N+1 and dispatches T-005.
5. The step-3 event arrives *after* N+1 was recorded.
6. **T-005 reports complete having never run** — with T-004's real diff and real commits attached, so §8.2's derived-facts adjudication *confirms* the false success.

**Rule: never advance the epoch until the previous epoch is quiesced by a correlated `get_state`** showing `isStreaming:false` and `pendingMessageCount:0`. Terminal events arriving outside an open epoch window are logged and discarded. The supervisor — not the CLI — is the **sole epoch allocator**; `dispatch` carries `(task_id, requested_epoch|null)` and the supervisor returns the assignment or rejects with `already_completed`, which is what makes idempotent re-dispatch (§12.7) testable without filesystem races.

A second hazard: `prompt` **acks immediately and is not awaited**, and a failure can emit a *second* response with the same `id` later. `dispatch --json {accepted:true}` therefore means *accepted*, not *started*; epoch start binds to the first `agent_start` after dispatch, and a late `success:false` on a live epoch fails that epoch.

> **Erratum (2026-08-30, documentation audit) — the interleaving above is real and is the reason the
> mechanism exists, but three of this section's normative sentences describe a design that was
> superseded during implementation. The code carries the correction; this document did not.**
>
> **Attribution is by STREAM OFFSET, not by an "open window".** The header of `src/rpc/epoch.ts:2-16`
> is explicit — "Epoch fencing (SRD §7.5), corrected to fence on STREAM OFFSET" — and states the rule
> as `an event belongs to epoch N ⟺ seq(event) > seq(N's prompt ack)`. `attribute(seq)` at
> `src/rpc/epoch.ts:236-241` returns `"live"` or `"prior"`. The premise this section reasons from is
> still true (Pi events carry no `id`), but the conclusion drawn from it — that terminal events
> "cannot be attributed to an epoch by inspection" — is false of a supervisor that reads its own
> stream monotonically, which is what the fix was. `ack_seq` is the field that carries it and appears
> nowhere in §7.
>
> **Prior-epoch terminal events are recorded, not discarded.** `src/supervisor/index.ts:1443` says so
> in place — "the live epoch's completion, never blindly discarded (SRD §7.5 fix)" — and `:1445-1449`
> emits an `epoch_attribution` event with `attributed:"prior"` AND appends a `prior_epoch_event`
> record to the run ledger. That matters beyond word choice: ISC-147's completion property is read
> back out of those `epoch_attribution` records rather than recomputed, so "discarded" describes the
> absence of the very evidence the suite grades on.
>
> **`dispatch` carries a third field, and a replay is not `already_completed`.** The wire carries
> `attempt_id` (`src/supervisor/index.ts:1595`, written at `src/cli/commands/dispatch.ts:281`), and
> the manager dedups on `(task_id, attempt_id)`: a repeat of the SAME attempt replays the stored
> allocation and answers `accepted:true, replayed:true`. `src/rpc/epoch.ts:36-39` gives the reason —
> answering `already_completed` "would leave the caller unable to distinguish 'someone else did it'
> from 'I did it and lost the ack'", which is precisely the retry an orchestrator makes after a
> dropped reply. `already_completed` is reserved for a DIFFERENT attempt against a settled task, and
> it is one of three rejection reasons, not one: `src/rpc/epoch.ts:96-98` has `already_completed`,
> `busy` and `stale_epoch`. ISC-145 is the criterion that pins both halves.
>
> Unchanged and re-verified: the epoch is recorded before the prompt is written
> (`src/supervisor/index.ts:1613-1619`), the supervisor is the sole allocator (`:1598`), no epoch
> advances while one is live (`src/rpc/epoch.ts:183-185`, `reason:"busy"`), and the whole of the
> paragraph below about `prompt` acking without being awaited (`src/supervisor/index.ts:1455-1466`
> fails the live epoch on a late `success:false`).

### 7.6 Worker state file

`<run-dir>/workers/<id>/state.json`, written atomically (tmp + `fsync` + `rename` + **directory fsync** — the rename is atomic on APFS but the directory entry's durability is not guaranteed without it):

```json
{
  "schema": "pifleet.state/v1",
  "worker": "eng-1", "run_id": "…",
  "pid": 47213, "pgid": 47213, "started_at": "2026-07-26T14:02:11Z",
  "proc_started": "Sat Jul 26 14:02:11 2026",
  "container": {"name": "pifleet-…-eng-1", "id": "3f9a…", "image": "pifleet/pi-worker:0.79.6-node-a1b2"},
  "phase": "busy",
  "epoch": 1, "completed_epochs": [], "task_id": "T-004",
  "session_path": "/Users/dan/.pifleet/runs/<run-id>/sessions/2026-07-26T14-02-19-530Z_<run-id>--eng-1.jsonl",
  "session_present": true,
  "last_event": "tool_execution_end", "last_event_at": "2026-07-26T14:09:03Z",
  "heartbeat_at": "2026-07-26T14:09:07Z",
  "turns": 12, "tool_calls": 41, "tool_errors": 2,
  "ui_requests": {"answered": 0, "denied": 1},
  "usage": {"input_tokens": 812345, "output_tokens": 41207, "usd": 1.87, "priced": true},
  "compactions": 1, "retries": 0,
  "credential": {"injections": 3, "generation": 3, "degraded": false, "last_failure": null,
                 "last_injected_at": "2026-07-26T14:47:11Z"},
  "exit": {"code": null, "signal": null}
}
```

`session_path` is **recorded from `get_state`**, never computed. `pgid` is recorded so the kill ladder can signal the process group. `exit` distinguishes SIGKILL from a clean exit — necessary because Pi exits 0 in every case. Presentation identifiers (`surface_id`, `workspace_id`) live in a sibling `presentation.json` so a lost cmux cannot invalidate control state.

> **Added and corrected (2026-08-30, documentation audit) — the block above is a true SUBSET of
> `WorkerStateSchema`, and the two omissions are both load-bearing. The sibling file's field names
> are also not the ones named here.**
>
> **`proc_started` (`src/contracts.ts:255`)** — the launch-time process identity, `ps`-comparable
> and deliberately distinct from `started_at` (which this block does carry). It is what the kill
> ladder and the reaper compare against so a recycled pid cannot be signalled as though it were the
> supervisor; `started_at` is a wall-clock record and cannot serve that purpose.
>
> **`credential` (`src/contracts.ts:309-322`)** — `{injections, generation, degraded, last_failure,
> last_injected_at}`, nullable. This is the ADC refresh loop's durable state (§5.8) and the surface
> `status` reads to say a worker's Google credential has gone stale. A state file documented without
> it reads as though credential health were not control-plane state.
>
> **The sibling file's fields are `worker`, `backend`, `workspace_ref`, `surface_ref`, `window_ref`**
> (`src/contracts.ts:462-466`) — five, not two, and `_ref` rather than `_id`. `surface_id` and
> `workspace_id` are cmux's OWN wire spellings under `--id-format uuids`, which `src/backends/cmux/parse.ts:11`
> normalizes away precisely so the control plane holds one vocabulary; naming them here reintroduced
> the spelling the parser exists to remove. `backend` is the field that makes the file useful after a
> restart, since it says which presentation the refs belong to.
>
> **`fence.json` is missing from §7 entirely, and it is the durable half of §7.5.** `state.json`
> holds the epoch, but the fence — `last_accepted_epoch`, `ack_seq`, `last_seq`, `live`, `completed`,
> `attempts` (`src/rpc/epoch.ts:100-119`) — is persisted as a sibling at
> `<run-dir>/workers/<id>/fence.json` (`src/run/paths.ts:355`, schema `pifleet.fence/v1` at
> `src/run/state.ts:690`), written BEFORE the prompt alongside the state flush
> (`src/supervisor/index.ts:1615-1619`), and its write failure is fail-stop: a supervisor that cannot
> persist its high-water mark must stop allocating epochs (`src/supervisor/index.ts:612-613`). §7.5's
> "recorded in `state.json` before the `prompt` is written" is true and incomplete — it names the
> advisory copy and omits the authoritative one.

### 7.7 Ledger and registry

`<run-dir>/ledger/<writer-id>.jsonl` — **sharded per writer**, merged at report time. N detached supervisors plus the CLI appending to one file cannot rely on `O_APPEND` atomicity for large records across filesystems. Records are `{seq, ts, actor, run_id, event, …}` with a capped line length.

`registry.json` has a **single writer** — the `pifleet daemon`. Every mutation (budget reservation, worker registration) is an RPC to it. Reservations release at settle and reconcile actual cost into the ledger.

> **Erratum (2026-08-30, documentation audit) — the single-writer claim is true of the REGISTRY and
> false of the BUDGET, which is a different file with a different writer.**
>
> The daemon's complete verb set is `ping | register_worker | deregister_worker | get_registry |
> shutdown` (`src/run/registry.ts:770-797`). There is no budget verb, so a budget reservation is not
> an RPC to anything. Budget state lives in `<run-dir>/budget.json` (`src/run/paths.ts:210`,
> "written by the scheduler" at `:162`) and is persisted by the DISPATCH process:
> `src/cli/commands/dispatch.ts:818` is `onChange: (snapshot) => writeJsonAtomic(run.budgetJson, snapshot)`.
>
> **Reservations do release at settle, and the reconciliation lands in `budget.json`, not the
> ledger.** `src/safety/budget.ts:369-370` books the actual spend into `tokens_spent`/`usd_spent`
> and `src/orchestrate/scheduler.ts:527` persists it; `grep -n 'ledger' src/orchestrate/scheduler.ts`
> returns nothing at all — the scheduler never touches the ledger. This is why `pifleet artifacts`
> and `pifleet report` read cost from `budget.json` rather than by replaying ledger records, and a
> reader following this sentence would look for accounting events that were never written.
>
> Everything else in this subsection was re-verified and holds: the ledger's per-writer shards
> (`src/run/paths.ts:548-550`, one `LedgerWriter` per actor at `src/run/ledger.ts:22-26`), the
> `(ts, actor, seq)` merge at report time (`src/run/ledger.ts:113-117`), the record shape
> `{seq, ts, actor, run_id, event, …}` (`src/contracts.ts:474-484`), the capped line length
> (`src/util/jsonl.ts:26`, `:652-654`), and `registry.json`'s single daemon writer — the only two
> writes of that path are inside `startRegistryDaemon` (`src/run/registry.ts:755`, `:841`).

---

## 8. Artifact harvesting

### 8.1 Artifact classes

| # | Class | Source |
|---|---|---|
| A1 | Result envelope | `<outbox>/<task-id>/result.json` |
| A2 | Code diff + commits | `git -C <worktree> diff <base_ref>...HEAD`, `git log` |
| A3 | Files outside git | `<outbox>/<task-id>/files/**` |
| A4 | Full transcript | session JSONL at the path recorded from `get_state` |
| A5 | Human-readable transcript | RPC `export_html` |
| A6 | Cost & usage | `get_session_stats` (`data.cost`, `data.tokens`) + `AssistantMessage.usage` in A4 |
| A7 | Event stream | `<run-dir>/workers/<id>/events.jsonl`, incl. `stderr_line` |
| A8 | *(diagnostics only)* Pane text | `cmux read-screen` — **never a result source** |

### 8.2 Three ranked paths, none of which reads a screen

1. **Repository (authoritative)** — branch, diff, commits, and the exit codes of acceptance commands **the harvester re-runs itself** in a fresh container from the same image.
2. **Transcript (authoritative for attempts)** — survives a worker that died before writing an envelope. `pifleet harvest --reconstruct <worker>` walks entries leaf-to-root honouring `CompactionEntry.retainedTail`.
3. **Envelope (advisory)** — intent, blockers, notes. May downgrade; never upgrades.

Disagreement between A1's `files_changed` and A2's diff is a hard failure class (F5), not a warning.

> **IMPLEMENTED 2026-08-25 (ISC-233, ISC-277). Path 1's container half was prose for a year; here is what it now is.**
>
> Acceptance ran in a fresh CLONE **on the host**. No container was involved at any point, and
> `AcceptanceContext.image` — the audit field whose entire purpose is recording which image graded the
> code — was the literal `null` with no other writer in the repository.
>
> **What runs now.** One `docker run` per acceptance command, from the image that worker actually used:
> the fresh clone bind-mounted at `/workspace` as the **only** mount, `-w /workspace`, `--entrypoint`
> overriding the image's `tini -- pifleet-entrypoint` (left in place it starts a Pi session, not a test
> suite), under the worker's own §5.6 posture — `--user 10001`, `--cap-drop ALL`, `no-new-privileges`,
> `--read-only`, `noexec` `/tmp`. The exam does not run under a weaker posture than the work it grades.
>
> **The tag and the network come from the run's own `launch.json`**, not from config and not recomputed.
> A grader that re-derived the tag could certify an image the run never used; `docker.network` defaults
> to the relay-confined `pifleet-egress`, so a `bridge`-defaulted exam would hand acceptance commands
> more egress than the code under examination ever had. `launch.json` absent means `PIFLEET_PI_COMMAND`
> — no container ever started — and the host path is then the only honest option.
>
> **`/workspace` is fixed, not conventional.** `docker/Dockerfile` bakes
> `git config --system --add safe.directory /workspace` at build time. Without it a container running as
> 10001 over a bind mount gets `fatal: detected dubious ownership` from every git subcommand. Measured
> both ways against the real image: `git status --porcelain` exits 0 clean, and the same run plus
> `-e GIT_CONFIG_SYSTEM=/dev/null` — the host path's environment applied unchanged — fails.
>
> **The mount is proved before anything is graded (ISC-277), and this ordering is the whole point.**
> On macOS the daemon runs in a VM sharing a declared set of host directories, and `-v` against a path
> outside that set does **not** fail: it mounts an empty directory. A containerized exam over an
> unshared root finds no tests to fail, exits 0, and records `passed` — a green exam against nothing,
> with every symptom pointing at the worker. That is strictly worse than the host-side clone it
> replaces. So the scratch root moved off `os.tmpdir()` onto `makeDaemonScratch`, and a host-written
> sentinel is read back from inside a container before the first command runs. A negative answer yields
> `not_run` for every command, which adjudicates to `unknown`.
>
> **Two operational defects were found by the new probes rather than by review**, and both are fixed:
> `--rm` is a client-side action, so a timed-out exam left its container running with nothing to reap
> it (containers are now named and removed); and nothing ever removed the acceptance scratch root,
> which was survivable under `os.tmpdir()` and becomes a permanent leak of one full clone per run under
> `$HOME`.

### 8.2a The test-harness cap — a worker cannot grade itself

**A diff that touches the test harness caps the verdict at `unknown`.** Path 1 above is
authoritative because the harvester re-runs acceptance itself, in a fresh container, from the image
the worker used. That authority rests on one assumption: the *meaning* of the acceptance command is
fixed by the repository, not by the worker. A worker whose diff edits `test/**` breaks it. Even a
fresh clone at that worker's head runs harness code the worker wrote, so a green suite proves the
worker can make its own exam pass — which is not the claim anyone wanted.

`harvest/adjudicate.ts` applies the cap **last**, after the derived verdict has already been combined
with the worker's claim:

- Anything ranked above `blocked` collapses to `unknown` — *refuse to grade*, not *fail*.
- Negative evidence (`failed`, `blocked`) **survives** the cap. A worker's own harness indicting the
  worker only ever downgrades, so there is no reason to discard it.
- The reason is published on the artifact, naming the files that tripped it.

**Which paths count as harness is `harness.patterns` (§6.5).** The default surface is 91 built-in
globs — `test/**`, `**/*.test.*`, `Makefile`, CI workflow files, lockfiles, and the rest of the set
an acceptance command's meaning resolves through.

> **Added 2026-08-30 (documentation audit).** This cap has shipped since ISC-150 and shaped every
> verdict the harvester has ever issued, and no version of this document mentioned it. An operator
> reading §8 would have concluded that a green re-run of acceptance yields `success`, full stop. The
> config key that controls the surface (§6.5) was undocumented on the same day and for the same
> reason.

### 8.3 Reading a live JSONL stream correctly

This applies to both the session transcript and the RPC stdout stream, and Pi mandates it of its own clients:

- **Split on `\n` only.** Strip an optional trailing `\r`. **Never use `readline`** (Node's or Bun's) — it also splits on `U+2028`/`U+2029`, which are legal inside JSON strings and appear routinely in minified JS and scraped text. A tool result containing `U+2028` becomes two invalid fragments and a silently dropped record.
- **Never decode a byte slab in isolation.** A 4-byte codepoint split across the watermark yields `U+FFFD` on both sides — and the rejoined string **still parses as valid JSON**, because `U+FFFD` is legal in a JSON string. There is no parse error to catch; the transcript just quietly acquires mojibake. Carry a `StringDecoder("utf8")` across polls, or hold the watermark at the last `\n` byte offset and decode only whole lines.
- **Do not assume append-only.** Pi rewrites the session file wholesale on load-time migration, on the empty/corrupt path, and on session switch; `new_session`, `switch_session`, `fork`, and auto-compaction (**on by default**) can all change `sessionFile`. Track `(dev, ino, size, offset)`; on shrink or inode change, reset to 0 and re-read; re-query `get_state` for the path after any of those commands.
- **Cap line length** and emit an explicit truncation marker — a single tool result containing a large file read can be megabytes on one line, and an accumulate-until-`\n` buffer across N workers is an OOM vector.

### 8.4 Harvest API

```bash
pifleet artifacts --task T-004 --json          # A1 + A2 + A6, adjudicated
pifleet artifacts --task T-004 --include diff
pifleet artifacts --all --json                 # the single end-of-fanout call
pifleet transcript --worker eng-1 [--html f]
pifleet harvest --reconstruct --worker eng-1
pifleet report --run <run-id> --md
```

`artifacts` is a **pure read**: it exits 0 whenever it emitted valid JSON, carrying per-task `harvest_status: complete|partial|unavailable`. Nonzero is reserved for I/O and usage errors. A machine consumer must never have to distinguish "no artifacts" from "tool broke" by exit code.

---

## 9. Isolation, concurrency, merge

### 9.1 Two nested boundaries

| Boundary | Enforces | Against |
|---|---|---|
| **Container** | filesystem, network, privileges, resources | the agent doing anything outside its mounts |
| **Git worktree** | which code the agent can change | agents colliding with each other |

`isolation` values, all now defined (v1.1 used three and defined one):

| Value | Worktree | Container mounts |
|---|---|---|
| `worktree` *(default)* | own worktree + branch [†see erratum] | `/workspace` rw |
| `shared-ro` | none of its own | other workers' worktrees mounted **read-only** under `/review/<worker>/` |
| `none` | none | no repo mount; `/workspace` is an empty tmpfs |

`shared-ro` is the one place the isolation guarantee is deliberately pierced, and it is pierced read-only.

### 9.2 Worktree preflight

Before creating any worktree: `git worktree prune`; refuse a branch already checked out elsewhere; **serialize `worktree add` per repo** to avoid `.git/index.lock` contention across concurrent workers; fail fast with a named error when submodules or LFS are present (shared object/cache paths across worktrees are a known hazard).

> **Erratum (2026-08-18, implementation Slice 2) — `git worktree add` was never built; every worker checkout is a `git clone --no-hardlinks` instead.**
>
> The paragraph above is kept verbatim as the historical record of what this SRD originally specified; it is not what `run/worktree.ts` implements, and should not be re-derived from by a future reader. Two designs were built and run against a real container before the design in this codebase was chosen, and both were disqualified by evidence rather than by preference:
>
> 1. **`git worktree add`, mounting only the linked worktree directory.** Fails outright. A linked worktree's `.git` is a FILE holding a `gitdir:` pointer into the parent's `.git/worktrees/<name>`, a path outside anything the container's mount table can name — so git inside the container answers `fatal: not a git repository` and the worker cannot commit at all.
> 2. **`git worktree add`, additionally mounting the parent's real gitdir so the pointer resolves.** Works, and is a confirmed **container-to-host remote code execution.** A container with write access to the mounted gitdir can rewrite the host repository's own `refs/heads/main` and plant an executable `.git/hooks/post-checkout` that runs as the OPERATOR'S host user on their very next `git checkout` outside the container — the container boundary is this SRD's primary isolation control (§5, §12), and a mount that hands the confined party write access to the confining party's hook directory dissolves it. This is not a theoretical finding; it was reproduced in the security spike that investigated this feature. **Never build this.**
>
> The design actually shipped is **design 3: `git clone --no-hardlinks --single-branch --branch <parent's checked-out branch>` per worker**, with `origin` stripped immediately after and the clone's `.git/logs` deleted wholesale (so the host's absolute repository path never survives ANYWHERE under `.git` — `.git/config` alone was the weaker claim an earlier draft of this erratum made; `git clone` also writes the source path into `.git/logs/HEAD`'s reflog, which `remote remove origin` does not touch, and which a worker container could otherwise read straight out of the mount), and the parent's own git configured with a `worker-<id>` remote pointing AT the clone (`git -C <repo> fetch worker-<id>` is how an operator reads a worker's commits without leaving their own checkout — see `pifleet worktrees`, §10, which replaces `git worktree list` for the same reason this note exists). The clone is self-contained: `.git` is a real directory INSIDE the mount, nothing the container touches resolves outside `/workspace`, and the parent repository is unaffected by anything a worker does to its copy.
>
> **`--single-branch` bounds the REFS a clone tracks, not the objects it holds.** Measured directly: a blob reachable only from a second branch the operator never checked out is still present in a `--single-branch` clone of a local repository, because a local-path `git clone` copies the whole object store regardless of `--single-branch` — that flag constrains which remote-tracking refs and fetch config the clone ends up with, not what `git clone` transfers to get there. So the per-worker cost this design pays is `sizeof(.git) × N` on disk and N sequential full copies at `up` time (clones are not parallelized — see `run/worktree.ts`'s per-worker loop), not the fraction `--single-branch`'s name suggests; and a worker's container can read every out-of-scope branch's content through its own `/workspace` mount regardless of which branch it was handed. Neither is new relative to `git worktree add` (a linked worktree shares the same object store, at zero marginal disk cost, which this design does not), and the SRD's original text did not anticipate paying it — recorded here rather than silently accepted.
>
> **`--no-hardlinks` is load-bearing, not hygiene, and its absence is the second finding this spike produced.** `git clone` from a local source path defaults to `--local`, which HARDLINKS the source repository's object files into the clone rather than copying them — one inode, two names. The 0444 mode git sets on a pack file does not stop the owning uid from `chmod +w` first, so a worker container writing through what it believes is its own private copy corrupts the PARENT'S object store. This is exactly how the spike investigating this feature destroyed this repository's own pack file during development, before the feature existed to protect against it (recovered via `git fetch origin --refetch`, verified clean, no data lost). `test/integration/worktree.test.ts` pins both the `nlink=1` property and disjoint-inode identity between every clone object and the parent's, because nothing else in the suite notices the flag going missing — the clone still works, the branch is still right, the worker still commits, and the only symptom is that a worker container can now silently corrupt the operator's real repository.
>
> §9.1's `worktree` row is retitled but not otherwise changed by this pivot: a worker still gets its own writable checkout on its own branch, mounted rw at `/workspace`; only the mechanism underneath the word "worktree" changed. `isolation: worktree` stays the config vocabulary for the same reason `run/worktree.ts` keeps its filename — it is what an operator writes in `fleet.yaml`, and renaming the vocabulary to chase the mechanism would just move the drift into `fleet.yaml` instead of fixing it.

### 9.3 Admission control and merge

**Panes and concurrency are deliberately decoupled: 6 panes, 2 generating.** All six workers are up, warm, and visible for the whole run; `run.max_concurrent: 2` means only two hold the oMLX server at any moment and the rest queue in admission control. This buys full fleet visibility without oversubscribing a single local inference server (§5.9 F40) — you watch six specialists, two of them are thinking, and no worker pays container-start latency when its turn arrives.

`run.max_concurrent` caps in-flight tasks, decoupled from pane count. `depends_on` is **topologically sorted at dispatch**; a cycle is exit 2; a dependency that ends `failed`/`blocked` propagates `skipped:dependency_failed` rather than holding forever.

`pifleet` never merges. Per run it produces N branches, N diffs, N adjudicated verdicts, and a `git merge-tree` conflict pre-check in `report`. Workers whose self-report disagrees with their diff are surfaced at the top.

> **Erratum (2026-08-18, Slice 2 review round) — the conflict pre-check above is real for one worker against its own base, and NOT YET real sibling-to-sibling.** Under the clone design (§9.2 erratum) each worker's branch lives only in its own independent clone; two siblings share no object store, so `git merge-tree` cannot run between them without first fetching one's objects into a place the other can see. Every worker already gets a `worker-<id>` remote registered in the PARENT (§9.2) for exactly this kind of cross-worker access, but `report` does not yet use it to fetch siblings before checking them against each other — filed as a follow-up, not fixed here. `report` now says so explicitly per pair (`"pairwise check ... not performed: different repositories"`) rather than the wire contract's `conflicts_with: []` silently reading as "checked, none found" when it was never checked at all.

`down` is **two-phase**: quiesce (abort → await `dead` → kill ladder on timeout) *then* prune. Since supervisors outlive the CLI by design, pruning a checkout whose container is still writing would corrupt it; `down` refuses to prune any checkout whose supervisor is CONFIRMED STILL ALIVE, and never force-removes a dirty checkout without `--force`.

> **Erratum (2026-08-18, Slice 2 review round) — "confirmed dead" is narrower than the original sentence implies.** A worker id with NO supervisor state at all — never launched, e.g. because a prior `up` created the clone and then crashed before reaching this worker's launch — is not "not confirmed dead"; nothing was ever alive to write to it, so the corruption hazard this refusal exists to prevent does not apply, and such a checkout is prunable (subject to the same dirty check as any other) rather than permanently stuck. Only a supervisor CONFIRMED TO HAVE SURVIVED the kill ladder blocks its own prune.

---

## 10. CLI surface

Commander.js under Bun. **Every command supports `--json`.**

| Command | Purpose |
|---|---|
| `pifleet doctor [--json]` | probe docker/cmux/tmux/pi/git; report backends, cmux socket mode, versions, image status, mount write-through |
| `pifleet image build\|list\|verify\|gc` | §5.7 |
| `pifleet config validate` | schema-validate |
| `pifleet render --worker <id>` | exact `docker run` + `pi` argv, dry |
| `pifleet up [--config p] [--workers a,b] [--backend k] [--backend-fallback k]` | build run-dir, worktrees, skill bundles, containers, panes |
| `pifleet daemon [--run r]` | registry/reaper (started by `up`; separately runnable) |
| `pifleet status [--run r] [--watch]` | fleet snapshot |
| `pifleet worktrees [--run r]` | list every worker's per-worker checkout — branch, path, clean/dirty; the operator-visibility surface `git worktree list` no longer answers now that each worker is an independent clone rather than a linked worktree (§9.2 erratum) |
| `pifleet dispatch --worker <id> --task <file\|->` / `--auto --tasks <f>` | send task envelopes |
| `pifleet steer --worker <id> "msg"` | mid-turn correction |
| `pifleet abort --worker <id>` | cancel current epoch |
| `pifleet wait [--run r] [--task T\|--all] [--timeout d]` | block until settle/deadline |
| `pifleet artifacts [--task T\|--all] [--include diff]` | §8.4 |
| `pifleet transcript --worker <id> [--html f]` | A4/A5 |
| `pifleet harvest --reconstruct --worker <id>` | rebuild from transcript |
| `pifleet report --run <id> [--md]` | merged report + conflict pre-check |
| `pifleet attach --worker <id>` | focus that pane |
| `pifleet tui --worker <id> [--leave]` | hand that worker's pane to a person; `--leave` returns it to the read-only viewer. Refused on `headless`, which has no pane. §3.5 lists what attended mode voids |
| `pifleet logs --worker <id> [--follow] [--render]` | tail `events.jsonl`; `--render` is the pane viewer |
| `pifleet exec --worker <id> -- <cmd>` | run a command in that worker's container (debugging) |
| `pifleet shell --worker <id>` | open an interactive shell in that worker's container, on any backend |
| `pifleet down [--run r] [--keep-panes] [--prune]` | quiesce, stop containers, optional worktree prune |

**Exit codes** — a strict severity ladder, highest wins, because one `wait --all` can legitimately have a timeout *and* a budget trip *and* a failed task:

`8` internal error > `2` usage/config > `3` backend unavailable > `5` budget ceiling > `6` worker died > `4` timeout > `7` partial (some `failed`/`blocked`/`aborted`) > `0` success.

> **Erratum (2026-08-30, documentation audit) — `8` was missing from this ladder, and it sits at the
> TOP of it.**
>
> `EXIT.INTERNAL` (`src/contracts.ts`) means a failure pifleet could not diagnose — a bug in pifleet
> itself — and it is deliberately outside the rest of the ladder: every other code describes
> something that happened to the RUN, and this one describes the tool breaking. If pifleet itself
> broke, nothing it reports about the run is trustworthy enough to outrank that, which is why it
> ranks first in `EXIT_SEVERITY` rather than last.
>
> It exists because the entry point used to report a crash as `2` (usage), making a pifleet bug
> indistinguishable from a typo'd flag over the only channel a machine caller has — so an
> orchestrator would answer a crash by rewriting its arguments and retrying, forever (ISC-216). The
> code has shipped since that fix; this ladder was never updated, and the source's own docblock
> said so ("Not in the SRD §10 ladder") without anything acting on it. `README.md` had it right.

`--json` always carries per-task terminal state, so no caller must infer from the integer alone.

---

## 11. Backend abstraction

```ts
interface SupervisorLauncher {                    // backend-independent
  launchDetached(spec: WorkerSpec): Promise<{pid: number; pgid: number}>;
}

interface FleetBackend {                          // presentation only
  readonly kind: "cmux" | "tmux" | "headless";
  probe(): Promise<Capability[]>;
  ensureWorkspace(name: string): Promise<WorkspaceRef>;
  createPane(w: WorkspaceRef, spec: PaneSpec): Promise<PaneRef>;
  attachViewer(p: PaneRef, argv: string[]): Promise<void>;
  focus(p: PaneRef): Promise<void>;
  sendText?(p: PaneRef, text: string): Promise<void>;   // tui only
  sendKey?(p: PaneRef, key: string): Promise<void>;     // tui only
  setStatus?(k: string, v: string, o?: StatusOpts): Promise<void>;
  setProgress?(v: number, label?: string): Promise<void>;
  notify?(n: Notification): Promise<void>;
  readScreen?(p: PaneRef): Promise<string>;             // diagnostics only
  destroy(w: WorkspaceRef, opts: {keepPanes: boolean}): Promise<void>;
}
```

v1.1 put `spawn(pane, argv, env)` in the backend — spawning *into* a pane, which by construction makes the process a pane child and contradicts §3.3. Supervisor lifecycle is now a separate, backend-independent concern that detaches identically on all three backends, including `headless`.

| Backend | Panes | Observability | Use |
|---|---|---|---|
| `cmux` | `workspace create` + splits | sidebar pills, progress, notifications, browser | daily driver |
| `tmux` | `new-session` / `split-window` | `capture-pane` | cmux absent; SSH |
| `headless` | none — viewers not started | `events.jsonl`, `status --json` | CI, unattended, **the acceptance suite** |

**Capability probe** at `doctor` and `up`: `docker info`; `cmux ping`; `cmux capabilities --json` (access mode + required methods); `cmux --version` and `pi --version` recorded and pinned; `read-screen` presence recorded, never required; image `verify`. Any missing `required` capability → exit 3 with a named diagnosis, or fall back per `--backend-fallback`.

The acceptance suite runs entirely on `headless`. If correctness can only be demonstrated with a GUI running, it isn't demonstrated.

> **Erratum (2026-08-30, documentation audit) — two corrections. The interface block and the
> backend table were re-verified member for member against `src/backends/` and are otherwise
> accurate.**
>
> **`launchDetached` returns `LaunchRecord`, which has a third field.** `src/backends/types.ts:92-97`
> is `{pid, pgid, started}` and `:101` declares `Promise<LaunchRecord>`. `started` is not
> bookkeeping — `types.ts:86-88` says the trio are "SENTINELS, not absences. `pgid <= 0` and
> `started === ""` mean the capture FAILED, and every reader refuses them", and it is the
> process-start-time half of the identity the kill ladder and the reaper compare against (§13.1). A
> signature without it reads as though a pid and a pgid were sufficient to signal safely, which is
> exactly the assumption ISC-77/78 exist to refuse.
>
> **The daemon probe is `docker version`, not `docker info`.** `src/cli/commands/doctor.ts:331-337`
> runs `["docker","version","--format","{{.Server.Version}}"]`, falling back to `["docker","--version"]`
> at `:338` — chosen because it yields the SERVER version, which is what the floor at `:131-135` is
> compared against. `docker info` survives in `dockerAvailable` (`src/container/run.ts:191`), whose
> only caller is `src/cli/commands/image.ts:75`. The daemon-reachability guarantee this row is for
> is met either way; the command named is not the command run.

---

## 12. Security

The container (§5) is what makes this section enforceable rather than aspirational. Each subsection names what the boundary actually is.

### 12.1 Tool scope is not a boundary — the container is

Pi's `bash` tool spawns a shell with `cwd` as a *starting directory only* and the full process environment. Nothing in Pi prevents `cd /`, redirection, `rm -rf`, `git push`, or `curl | sh`.

**Therefore:** a role granted `bash` is fully privileged *inside its container*, and that is the only statement `pifleet` makes. Roles claimed read-only (`reviewer`, `researcher`) are given `[read, grep, find, ls]` and **not** `bash`. `config validate` **rejects** any role that combines `bash` with a `read_only: true` marker.

> **Correction (2026-08-30, documentation audit) — `researcher` was retired and this sentence kept
> naming it.** The read-only role in the shipped example is `reviewer` alone
> (`fleet.example.yaml:293`, `tools: [read, grep, find, ls]` with the comment `# NO bash — see §12.1`);
> §6.2 records the retirement at the end of its own worked example and this line was not updated.
> The rule is unchanged. `config validate`'s refusal was re-verified and is stronger than the
> sentence suggests: `src/config/schema.ts:768-807` rejects the combination at both the role and the
> worker level, and resolves an omitted `tools:` list to the full builtin set FIRST, so the common
> shape — `read_only: true` with no `tools:` at all — is caught rather than passing as "no bash
> named".

### 12.2 Repo content is untrusted input

Pi discovers `<cwd>/.pi/extensions`, `.pi/skills`, `.pi/prompts` from the repo it is working on, and **extensions are TypeScript executed in-process**. It also loads repo `AGENTS.md`/`CLAUDE.md` into the system prompt.

**Therefore, mandatory and non-overridable:** `--no-extensions`, `--no-skills`, `--no-context-files` (default `no_context_files: true`), with skills re-added by absolute path from the read-only `/skills` mount. Cloning a hostile repo must change nothing about the run — and if it did execute something, it executes as uid 10001 in a read-only-root container with no host mounts and no credentials (§12.4).

> **Correction (2026-08-30, documentation audit) — "no host mounts and no credentials" is shorthand
> that reads as a guarantee, and §5.5 is the guarantee.** A worker container has eight to ten host
> bind mounts (`src/config/render.ts:255-298`: `/workspace`, `/outbox`, `/sessions`, `/skills:ro`,
> `/policy/cloud-allow:ro`, the secret store at `/secrets:ro`, the briefing, and the kubeconfig),
> and a `cloud_access` role holds a ~1 h Google access token by design. What the sentence means and
> should say is that the operator's HOME is not mounted — no `~/.config/gcloud`, no `~/.pi/agent`,
> no run directory, no Docker socket — which is the property that actually bounds a hostile repo's
> blast radius, and which §5.5's Condition column and §12.4's Class 2 table both state precisely.
> The mandatory flags themselves were re-verified: `src/config/render.ts:124` pushes all three
> unconditionally, and `no_context_files` is accepted for §6.2 compatibility and then deliberately
> ignored (`src/config/schema.ts:136-141`) — stronger than "default true", since it cannot be turned
> off.

### 12.3 Hang guards, corrected

1. **Prompt-free configuration.** Explicit tool allowlist per role. Note that `--exclude-tools` performs **no validation** and `ask_question` is extension-provided — with `--no-extensions` mandatory, excluding it matches nothing. This guard is defence-in-depth only; guards 2–4 carry the weight.
2. **Supervisor auto-response, keyed by request class.** Answer only the four **dialog** methods (`select`, `confirm`, `input`, `editor`) with `{cancelled:true}` after `ui_request_timeout`; **log and ignore** the five fire-and-forget methods, which nothing is waiting on. `editor` carries no timeout of its own and is the one method where the supervisor's timer is the only unblocker. Because denial semantics are extension-defined — an extension may read `cancelled` as "proceed" — this guard is paired with `--no-extensions` (§12.2), which is what actually makes it sound.
3. **Two liveness signals.** Supervisor heartbeat proves the *supervisor*; `last_event_at` staleness proves the *agent*. `event_stall_warn` → `stalled`; `event_stall_kill` → `abort` → SIGTERM → SIGKILL to the **process group**, plus `docker kill`.
4. **Prose-blocking detection.** A worker can end its turn asking a question and settle looking done. At settle, if the derived verdict shows no diff, no commits, no envelope, and `get_last_assistant_text` returns an interrogative, classify `blocked` and surface the question.

> **Erratum (2026-08-30, documentation audit) — guard 4 does not exist, and guard 3's escalation
> chain names two things that are not on the stall path. Guards 1 and 2 are correct and were
> re-verified in full.**
>
> **Guard 4 is unbuilt, in both halves.** `grep -rnE 'interrogative|get_last_assistant_text' src/`
> returns nothing; the command is implemented only by the test double
> (`test/fixtures/fake-pi.ts:855`). `src/harvest/adjudicate.ts` never reads a last assistant
> message, and `"blocked"` there is only ever a lattice rank. A worker that ends its turn with a
> question and no output becomes `unknown` with `turn_completed_without_result_envelope`
> (`src/harvest/transcript.ts:492-493`), which is not wrong so much as silent about the reason.
> Note `src/supervisor/prose-detector.ts` is NOT this guard — its own header says it is "§5.9
> detector 2", consecutive zero-tool-call turns (F39), a different failure entirely.
>
> **Guard 3's kill half is advisory only.** `event_stall_kill` reaches `abortWedged`
> (`src/run/stall-io.ts:104-121`), which appends a `worker_stall_kill` ledger event and issues one
> `{cmd:"abort"}` control call. `src/run/stall-io.ts:90-92` states the choice: "Signalling is
> deliberately NOT done here." The `-pgid` SIGTERM→SIGKILL ladder is real but lives in `down`
> (`src/safety/kill.ts:556`, `:625`, `:640`) and in the reaper (§13.1), not on the stall path. And
> `docker kill` is never invoked anywhere in `src/` — teardown is `docker rm -f`
> (`src/cli/commands/down.ts:1507`, `src/safety/reaper.ts:148`).
>
> **What this leaves standing.** Guard 3's two-signal DETECTION is exactly as documented
> (`src/safety/stall.ts:48-52`, `src/run/stall-io.ts:71-82`, wired at
> `src/orchestrate/scheduler.ts:572-592`), including the `holdsSlot` narrowing that stops a worker
> queued behind `max_concurrent` being killed for the queue's silence. Guard 2 is exact to the
> method: four dialog methods, five fire-and-forget names logged and ignored, `{cancelled:true}`,
> `editor` marked `supervisor_only`, timer from `ui_request_timeout` (default `5s`) —
> `src/supervisor/ui-requests.ts:113-138`, `:173-175`, `src/supervisor/index.ts:1232`.

### 12.4 Credentials — two classes, two different answers

Pi's bash tool inherits the whole environment, so any worker with `bash` can `echo $ANY_KEY`. A credential that has left the boundary is not protected by a spend ceiling or a run timeout. But the fleet needs two very different credentials, and the honest answer differs for each.

**Class 1 — the LLM credential: local, low-stakes, injected directly.**

Because inference is always self-hosted oMLX (§5.9), there is **no cloud provider key in this system at all**. The only LLM credential is `OMLX_API_KEY`. It carries **no billing authority** — that part of the argument is unconditional and is what collapses Class 1 to a single env var. It is injected as an env var, and the auth proxy earlier drafts specified is **not built**. The egress bridge allows `host.docker.internal:8000` and denies all other outbound traffic except the Google endpoints `cloud_access` roles need.

> **Erratum (2026-08-19, ISC-259) — this paragraph used to say the key "guards a local inference server on Dan's own machine — it carries no billing authority and no value off this host." The second clause was load-bearing, it was true by measurement, and for a LAN oMLX it is false. Restated rather than left standing.**
>
> The old sentence was true *because of a measured binding*, not because of anything about the key: the Docker host's oMLX listens on `127.0.0.1:8000`, loopback only (`lsof -nP -iTCP:8000 -sTCP:LISTEN` → `TCP 127.0.0.1:8000 (LISTEN)`, 2026-08-19). A credential that can only be presented over loopback genuinely has no value anywhere else.
>
> **A LAN oMLX at `192.168.86.49:8000` is bound to a routable interface by definition** — that is what makes it reachable at all — so it is reachable by every device on `192.168.86.0/24`. And `llm.base_url` is plain `http://`, with no TLS anywhere in the path. Therefore, stated plainly and without hedging:
>
> - **The key crosses an unencrypted LAN hop on every single request.** Any device that can observe that segment can read it in cleartext from an `Authorization: Bearer` header.
> - **The key now has value on at least one other host.** "No value off this host" is retired; the accurate claim is *no value off this **LAN**, and no billing authority anywhere*.
>
> **Accepted as a residual, not mitigated, and the reasoning is recorded so it can be revisited rather than re-derived:**
>
> | Consideration | Assessment |
> |---|---|
> | What the key protects | free inference on a self-hosted server. No money, no cloud identity, no data at rest |
> | Who can already reach the endpoint | anyone on `192.168.86.0/24` can reach `192.168.86.49:8000` **directly**, with or without the key crossing the wire. Capturing it buys an attacker access to a port they can already open a socket to |
> | Blast radius of theft | inference cycles on a machine the attacker is already adjacent to |
> | What is *not* on this hop | the Google credential (Class 2), which is where the real blast radius lives. It never traverses the oMLX path |
> | Cost of the alternative | oMLX terminates no TLS itself, so requiring it means a reverse proxy plus a certificate the relay container must trust — real operational weight on a home LAN, for the exposure above |
>
> **This is the operator's accepted risk, on the explicit basis that `192.168.86.0/24` is a trusted home network.** It is documented here rather than mitigated, which is the honest disposition given §5.9's decision that a LAN server is sufficient.
>
> **The condition under which this must be revisited** — stated now so the trigger is not a judgement call later: if `OMLX_API_KEY` ever gates something with billing authority or data access, if the same key is reused for a credential that does, or if the LAN stops being one the operator controls (a guest network, an office, a shared flat), then TLS to the oMLX endpoint becomes **required**, not advisory. None of those hold today.
>
> Note the key is the same on the loopback and LAN servers. That does not widen the exposure: the loopback server cannot be reached off-host at all, so a key captured on the LAN buys nothing additional there.

> **Erratum (2026-08-25, §5.9's privacy amendment) — the LAN residual above does NOT carry over to a tunnelled private instance, and the reason is the one line of the table that stops being true.**
>
> §5.9 now permits an operator to front their own oMLX with a private tunnel. The exposure that creates is **not** the LAN case with more hops, and treating it as such would be the mistake this erratum exists to prevent.
>
> **What gets better.** The LAN residual's sharpest edge was cleartext: `llm.base_url` is plain `http://`, so the key crossed an unencrypted hop in an `Authorization: Bearer` header. A tunnelled endpoint is reached over TLS to the tunnel edge, so the passive-observer capture that the LAN table accepts is no longer the live concern.
>
> **What gets worse, and it is the load-bearing half.** The LAN argument rests on one row — *"anyone on `192.168.86.0/24` can reach the endpoint **directly**, with or without the key crossing the wire. Capturing it buys an attacker access to a port they can already open a socket to."* That row is what makes the residual small. **For a publicly-resolvable tunnel endpoint it is false.** The set of parties who can open a socket is no longer "devices adjacent to the operator" but "anyone who learns the hostname", and the key stops being incidental to an already-open port and becomes **the only gate in front of the operator's inference server**.
>
> | Consideration | LAN shape | Tunnelled shape |
> |---|---|---|
> | Transport | cleartext `http://` | TLS to the tunnel edge |
> | Who can reach the endpoint | devices on the operator's LAN | anyone who resolves the name |
> | What the key is | one credential among several ways in | **the sole access control** |
> | "Attacker is already adjacent" | true — bounds the blast radius | **false** — does not bound anything |
> | Blast radius of theft | inference cycles on an adjacent machine | inference cycles on the operator's machine, from anywhere |
>
> **Accepted as a residual on a narrower basis than the LAN case, and the narrowing is the point.** What the key protects is unchanged and is still the reason this is tolerable at all: free inference on a self-hosted server, with **no billing authority, no cloud identity, and no data at rest** — the Class 2 Google credential never traverses this path, which is where real blast radius would live. An attacker who steals it spends the operator's GPU.
>
> **The revisit trigger is therefore STRICTER here than for the LAN shape.** §5.9's LAN residual is revisited if the key ever gates billing or data, if it is reused, or if the LAN stops being trusted. For a tunnelled instance, add: **a shared or guessable key is no longer proportionate.** On the LAN the key was one lock among several on an already-reachable port; here it is the only one, so it must be high-entropy and unique to this endpoint, and the tunnel must not be the transport for any key that also opens something else. If the endpoint ever serves a model whose *output* is trusted for anything beyond code suggestions, or the operator cannot enumerate who knows the hostname, TLS-plus-a-key stops being sufficient and the endpoint needs an authenticating proxy in front of it.
>
> **Sequencing note, consistent with ISC-259's original filing.** Nothing in this erratum permits the *relay* to dial a tunnel: §5.9 is explicit that a tunnel terminates at a local listener and the relay still dials `host.docker.internal`, so the deny-all bridge gains no hole and §12.8's reachable set is unchanged. The credential exposure documented here is on the **operator's own host-side hop**, outside the containment boundary this section otherwise governs.

**Class 2 — Google Cloud identity: enters the container by design, bounded and opt-in.**

This is a deliberate exception, not an oversight. Dan's requirement is that workers inherit the launching Claude instance's ADC so `gcloud`, `kubectl`, `helm`, and Vertex-backed models work without provisioning a service account per fleet. That is incompatible with "no credential ever enters the container," so the boundary moves from *presence* to *blast radius*:

| Control | Effect |
|---|---|
| `adc_mode: token` (the only mode) | container holds a **~1 h access token**, not the non-expiring `refresh_token` — measured `expires_in: 3599` |
| `cloud_access: false` by default | only roles that explicitly opt in get any Google credential at all |
| host `~/.config/gcloud` never mounted | `credentials.db`, `legacy_credentials/`, and `access_tokens.db` — every account Dan has logged in — stay out of every container |
| `impersonate_service_account` | where an SA exists, the worker inherits *its* roles, not Dan's |
| `quota_project` | pins billing/quota attribution |
| egress allowlist | the bridge restricts where a token can be used |
| `up` prints the granted identity, project, and mode | the grant is never silent |

**Stated plainly:** a worker with `bash` and `cloud_access: true` can do anything Dan's Google identity can do, for up to an hour. Containment reduces exposure; it does not eliminate it. Roles that do not need cloud access must not be given it, and `config validate` warns when `cloud_access: true` is combined with a repo the run does not own.

**Both classes:** `env_allowlist` never includes provider keys; the Docker socket is never mounted (that is host root); `GIT_CONFIG_GLOBAL` points at a per-run scratch config with **no credential helper and no push remotes**, so a push cannot authenticate even if attempted.


> **Erratum (2026-08-30, documentation audit) — Class 3 was missing entirely, and this section's
> framing made the whole document read as though the environment were the only delivery channel.**
>
> **Class 3 — operator-granted secrets: delivered as FILES, never as values in the environment.**
> A worker draws against `secrets.env_allowlist` (the fleet CEILING) with its own role-level
> `secrets: [NAME]` (the REQUEST); a name is delivered only when it is in **both**, and a name in
> the request that the ceiling does not carry refuses the launch by name. Delivery is
> `src/run/worker-env.ts`: the value is written to `<run-dir>/workers/<worker>/secrets/<NAME>` at
> mode **0444**, that directory is bind-mounted read-only at `/secrets` (§5.5), and the worker's
> environment receives **`<NAME>_FILE=/secrets/<NAME>`** — the pointer, never the value.
>
> **So `echo $TICKET_API_TOKEN` inside a worker prints an empty line, and so does `env | grep
> TOKEN`.** That is the point: what this buys is the removal of the ACCIDENT surface — `env`,
> `set`, a stray expansion, a shell trace, a crash dump that serialises the environment. It does
> **not** remove the capability. A worker that wants its own credential can still
> `cat "$TICKET_API_TOKEN_FILE"` and put the value in its transcript deliberately, and ISC-341
> records that standing limit rather than pretending otherwise. This narrows the accident, not the
> agent.
>
> **The key is still spelled `env_allowlist`, and the name is now historical rather than
> descriptive.** It was accurate when the ceiling governed environment variables. Renaming it would
> break every existing `fleet.yaml` for a cosmetic gain, so the name stays and this sentence is the
> correction — the list is a *grant ceiling*, and what it gates is delivery by file.
>
> Shipped 2026-08-29 (ISC-337..342). `fleet.example.yaml` carried the full explanation from the day
> it landed; this document did not, which is the drift the 2026-08-30 audit was looking for.

> **Erratum (2026-08-31) — `credential: false`, because "the ceiling is the only delivery channel"
> had a cost this section did not name.**
>
> The paragraph above is right that `env_allowlist` is a *grant ceiling* rather than a list of
> secrets. What follows from that, and was not written down, is that a variable which is **not** a
> secret still has to be listed there to reach a worker at all — there is no plain non-secret `env:`
> selector. `TICKET_BASE_URL` is the standing case.
>
> **That was not free, and the bill arrived at the harvester.** `harvest/needles.ts` sweeps every
> granted VALUE through `findCredentialLeaks` (§12.6, ISC-333), and a ticket worker's artifacts
> legitimately contain the endpoint they were pointed at. So every `ticket-ops.json` was refused as
> carrying a credential, every refusal became a discrepancy, and every verdict clamped. **ISC-333
> was filed because the sweep could not fire; this is the same defect with one sign flipped** —
> a finding on every honest run carries as little information as a finding on none, and it
> additionally teaches an operator to disbelieve the detector on the day it catches the real thing.
>
> An entry may therefore be written long:
>
> ```yaml
> secrets:
>   env_allowlist:
>     - TICKET_API_TOKEN                 # a bare string means credential: true
>     - name: TICKET_BASE_URL
>       credential: false                # delivered, NOT swept
> ```
>
> `credential: false` says one thing and only one: **do not use this value as a needle.** Delivery
> is untouched — still granted, still a 0444 file, still a `<NAME>_FILE` pointer, still subject to
> every reserved-name and ceiling check. It buys no privilege; it forfeits a check. **The default is
> `true` and a bare string means `true`**, so a mistake falls toward sweeping.
>
> **The declaration is written into `launch.json` (`non_credential_secrets`), not read from config
> at harvest time**, for the reason `harvest/needles.ts` already gives about grants: a harvester is
> handed a run directory, not a workspace, and a run outlives the document that produced it.
> Reading it from whatever `fleet.yaml` is in front of the harvester would sweep an old run against
> a newer answer. It is intersected with that worker's actual grant, so a record naming something
> the worker never held narrows nothing, and the field defaults to `[]` so every pre-existing
> record keeps its sweep exactly as wide as it was.
>
> Shipped 2026-08-31 (ISC-388).

### 12.5 The result envelope is untrusted input

The harvester parses `result.json` and dereferences `artifacts[].path` and `files_changed[].path`. Without constraints, `{"kind":"file","path":"/Users/dan/.env"}` is an exfiltration primitive — read by the harvester, written into `report.md`, and from there into the orchestrator's context. The symlink variant needs no envelope at all: `<outbox>/files/x → /etc/passwd`.

**Requirements:** schema-validate with `maxLength`/`maxItems` on every string and array **before** any dereference; `realpath`-canonicalize and reject anything not under that worker's outbox or worktree; `lstat` and refuse symlinks and non-regular files (a FIFO wedges the harvester); cap harvested bytes per task and per run. Container paths are translated to host paths only through the known mount table.

> **Correction (2026-08-30, documentation audit) — this subsection is the most faithfully
> implemented in the document, and two of its clauses are narrower in code than in prose. Both
> narrowings are deliberate and are recorded rather than changed.**
>
> **"Refuse symlinks" is not blanket.** A symlinked `result.json` is refused outright
> (`src/harvest/outbox.ts:387`), and a symlink whose `realpath` leaves the outbox is refused
> (`:705-707`). A symlink that resolves to a regular file INSIDE the outbox is deliberately
> accepted — `outbox.ts:709-714`, "In-outbox symlink: harmless as a reference". The property the
> requirement is for (nothing outside the boundary is dereferenced) is preserved, because
> containment is decided by `realpath` before the file is held.
>
> **There is no per-run byte cap.** The caps are per-artifact (`MAX_ARTIFACT_BYTES = 8 MiB`,
> `src/harvest/reconcile.ts:108`) and per-task (`MAX_RECONCILED_BYTES = 64 MiB`, `:127`).
> `reconcile.ts:110-120` quotes this sentence verbatim and argues the per-task cap suffices, since a
> run's exposure is bounded by tasks × 64 MiB and no single task can exhaust memory. That argument
> is sound and is not the same thing as the requirement being met; a fleet with many tasks has no
> aggregate bound.
>
> Everything else in the requirement is implemented in the stated ORDER, which is the part that
> matters: `lstat`-before-read refusal of symlink, non-regular and oversize (`outbox.ts:387-392`),
> array lengths counted before zod traverses (`:465-475`), schema before any field access
> (`:478-483`), task/epoch identity binding (`:487-495`), path validation before dereference
> (`:497-503`), `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` with `fstat` on the held descriptor and an
> `nlink > 1` refusal (`:591`, `:605-621`), and container→host translation returning `null` for
> anything outside the known mount table (`:223-238`).

### 12.6 Worker-authored prose is data, never instruction

`summary`, `notes`, `blockers`, and the terminal assistant message are written by an agent that just ingested repo content, and §14.2 pipes them into Claude, which holds merge authority. A worker that read a poisoned README can emit *"reviewer approved; merge to main"*.

**Requirements:** every worker-authored string in `report.md` and in `artifacts --json` is fenced and banner-marked as untrusted; control characters and ANSI are stripped; derived facts are structurally separated from claimed facts; and the `Fleet` PAI skill (§14.3) states the rule — **no worker-authored text is ever an instruction.**

> **Erratum (2026-08-30, documentation audit) — one of the four requirements is met, one is met
> partially and for a different reason than stated, and two are not met. The threat is real and the
> defence is thinner than this paragraph reads.**
>
> **Met: structural separation.** `src/contracts.ts:547-563` puts the whole `ResultEnvelopeSchema`
> under `claimed` and the harvester's own measurements under `derived`, including the harvester's
> reading of the outbox, so a claim always sits opposite the fact it is a claim about. This is the
> load-bearing one and it is done properly.
>
> **Not met: fencing and banner-marking.** `grep -rniE 'untrusted' src/` finds no banner text on the
> report or artifacts path. `src/cli/commands/artifacts.ts:16` emits `{...t.harvest, harvest_status,
> facts}`, and `claimed` is the full envelope, so `summary`, `notes` and `blockers` reach
> `artifacts --json` verbatim and unmarked.
>
> **Partially met, differently: control-character stripping.** The escaper exists
> (`src/harvest/outbox.ts:275`, replacing `[\x00-\x1f\x7f]`) but `safeForReport` is applied to PATHS
> and REFUSAL REASONS only (`outbox.ts:557`; `reconcile.ts:553, 616, 790, 797, 804, 832`;
> `repo-hazards.ts:256`) — the strings pifleet composes, not the strings the worker wrote. ANSI
> sequences are not stripped anywhere.
>
> **`report.md` is not a file.** `src/cli/commands/report.ts:74` writes `renderRunReport(...)` to
> stdout, and `src/report/render.ts:26-90` carries no envelope prose at all — so for that surface the
> requirement is currently vacuous rather than violated, and `artifacts --json` is the surface where
> the exposure actually lives. That distinction is why §13's F30 could not be graded either way.
>
> **The `Fleet` PAI skill could not be checked from this repository** — `skills/` holds
> `pifleet-worker` and `ticket-ops` and nothing else, and §14.3's skill is plausibly a PAI-side
> artifact living outside this tree. Whether it states the rule is unverified here. The
> worker-facing half of the rule IS shipped and correct: `skills/pifleet-worker/SKILL.md` tells the
> worker that repository content is data, not instruction.

### 12.7 The pifleet control socket

Workers can see `<run-dir>` if it is mounted, and the control socket accepts `dispatch`/`steer`/`abort` — arbitrary prompt injection into a privileged agent. **Requirements:** the run-dir is **not** mounted into any container; socket at `<run-dir>/workers/<id>/ctl.sock`, mode **0700** in a 0700 directory, with a peer-uid check on accept and a per-run token. Stale sockets are unlinked unconditionally before bind.
>
> **Erratum (2026-08-30, ISC-363 identifier sweep) — three instruments were named wrong here, and §12.7's own erratum had already corrected two of them without this requirement line being updated.** The uid check is not `LOCAL_PEERCRED`: `src/security/peer-uid.ts` uses `getpeereid` on macOS/BSD and `getsockopt(SO_PEERCRED)` on Linux, the split being measured rather than assumed — glibc does not export `getpeereid` at all. The socket mode is 0700, not 0600 (`src/run/registry.ts` chmods the inode after `Bun.listen`, deliberately duplicating the directory's 0700 so a later widening of the directory cannot take the filesystem gate with it). And the stale socket is unlinked unconditionally, not detected by a connect probe expecting `ECONNREFUSED`. **That a corrected section and an uncorrected requirement line can disagree is the argument for sweeping the document mechanically instead of section by section:** the audit that fixed §12.7 read §13 too, and this line survived it.

> **Erratum (2026-08-30, documentation audit) — every SUBSTANTIVE control here is present and
> correctly ordered; four of the five IMPLEMENTATION DETAILS named are wrong, and one of them is
> wrong for a reason worth keeping.**
>
> **The socket is not in the run dir, and cannot be.** `src/run/paths.ts:895-898` puts it at
> `<tmpdir>/pifleet/<16-hex>.sock`, where the hex is `sha256(runId\0workerId)` truncated —
> deterministic, so the CLI finds a live supervisor with no lookup. `paths.ts:11-17` gives the
> reason: `sun_path` is capped near 104 bytes on macOS, and a socket under
> `<run-dir>/workers/<id>/` would simply fail to bind. This is a case where the requirement as
> written is unimplementable, so the location moved and the PROPERTY was preserved elsewhere — and
> the property is preserved: the run dir is not mounted into any container, and every `-v` in
> `src/config/render.ts` names a subpath or a named volume.
>
> **The socket is mode 0700, not 0600** (`src/run/registry.ts:489`), inside a 0700 directory
> (`:388-389`), both set in code rather than inherited from umask.
>
> **The uid check is `getpeereid` / `SO_PEERCRED`, not `LOCAL_PEERCRED`** (`src/security/peer-uid.ts:243`,
> `:119`). It runs where the requirement needs it to — in the `open` handler, before a byte is read
> (`src/run/registry.ts:421`, `:445-447`), with in-flight bytes from a refused peer dropped.
>
> **Stale sockets are unlinked unconditionally before `bind`, not probed.** `src/run/registry.ts:390-394`,
> with `:341-342` explaining that a stale file from a crashed predecessor would otherwise fail
> `EADDRINUSE`. There is no connect probe and no `ECONNREFUSED` path in `src/`.
>
> **The per-run token is real and is stronger than the one clause given to it:** a CSPRNG token in a
> single 0600 exclusively-created file, never logged (`src/security/control-auth.ts:24-33`, `:211`),
> enforced at the FRAMING layer before any handler sees a verb (`src/run/registry.ts:344-349`),
> compared in constant time (`control-auth.ts:259-266`), and stripped from the message before
> dispatch (`registry.ts:466`).

### 12.8 Containment verification

Post-run, `pifleet` asserts: no ref outside `fleet/<run-id>/*` moved; `git -C <main-repo> status --porcelain` and a content hash of the main checkout are unchanged; no container remains running. Ref-only checking (v1.1) cannot see working-tree writes into the main checkout — which is precisely the failure that already cost this codebase a phase of work.

> **Erratum (2026-08-18, implementation Slice 2) — both assertions above are now false as literally stated, and deliberately so; each is narrowed to what actually survives the §9.2 clone pivot.**
>
> `no ref outside fleet/<run-id>/* moved` assumed `branch_prefix` was dead (it was — see the §9.2 erratum, and ISA.md's Slice 2 close-out for the fix). With `branch_prefix` real, the namespace a run's branches live under is `<branch_prefix>/<run-id>/*`, operator-configurable, not the literal string `fleet/`. Read as "no ref outside THIS RUN's own configured namespace moved" and the assertion still holds — verified by `test/integration/worktree.test.ts`'s own operator-visibility tests, which fetch a worker's commits into the parent under `worker-<id>/<branch>` and assert nothing on the parent's OWN branch moves.
>
> **AMENDED 2026-08-25 (ISC-298). The assertion is now true outright, and this erratum records why it needed amending twice.**
>
> The text this replaces argued that `git -C <main-repo> status --porcelain … unchanged` was *false by construction* under the clone design, because `up` created `<repo>/.worktrees/` inside the operator's working tree, and that the letter of the assertion was restored by excluding that directory through `.git/info/exclude`. That was a sound argument about a design that no longer exists. Worker checkouts now live at `<run-dir>/worktrees/<worker>`, outside the operator's repository entirely, so nothing is created inside their working tree and nothing needs excluding: `status --porcelain --untracked-files=all` reads empty because there is nothing there, not because something is hidden. `excludeWorktreesDir` is deleted, and its two tests are replaced by that stronger assertion (`test/integration/worktree.test.ts`).
>
> **The reason for the move was not tidiness, and it is worth stating because the old placement had a defence that read well and was wrong.** The previous text of `workerWorktree` justified living beside the operator's checkout on the grounds that *"git objects must be on the same filesystem the container bind-mounts"*. That is a true statement about a hardlinking clone and false about this one — §9.2's design 3 is `git clone --no-hardlinks`, which copies every object to a fresh inode. The stated constraint had never applied.
>
> What forced the move is that a Linux bind mount passes host ownership through untouched, while macOS squashes it to the container user. The worker image runs as uid `10001` (§5.6), so a checkout created by the operator's uid was readable and not writable from inside the container on any Linux Docker host — invisible on the operator's own machine for the entire life of the project, and reproduced deterministically the first time the full chain ran on `ubuntu-latest`. Fixing it requires widening the mounted tree, and widening it in place would have meant `chmod`-ing directories inside the operator's repository — precisely the mutation this section exists to forbid. Under the run dir the same widening lands on a directory pifleet created and owns.
>
> **Two blockers, and the second only becomes visible once the first is fixed.** Permissions are one; git is the other, and it refuses on OWNERSHIP while ignoring mode entirely (CVE-2022-24765), so a fully world-writable checkout still answers `fatal: detected dubious ownership` for `status`, `add`, `commit` and `diff`. A worker in that state can write its files and cannot commit them — a worse outcome than the total failure it replaces, because the agent's work looks done and lands nowhere. Both halves ship together: `prepareWorktreePermissions` widens the finished clone recursively (`a+rwX`, capital `X`, so source files do not gain an execute bit and the worker's first `git status` does not report a tree nobody edited), and `buildWorkerEnv` sets `safe.directory` to the container path `/workspace` — through `--env-file` rather than `-e`, because §12.4's zero-`-e` invariant is a guard worth keeping and the alternative path already existed.
>
> **Residual, stated rather than implied:** `<run-dir>/worktrees/<worker>` is world-writable, so on a multi-user host any local user can write into a worker's checkout. That is the accepted cost of a baked container uid. The alternative measured against it — running the container as the invoking uid — needs no widening at all but contradicts §5.6's fixed `10001` and leaves the image's baked `$HOME` unwritable. The widening stops at the worktree: `control-auth.json`, `ledger/` and `audit/` are its siblings under the run dir and are neither mounted nor widened.
>
> One more correction, found while checking the two above: this section's OPENING sentence — "Post-run, `pifleet` asserts…" — describes a runtime CHECK that does not exist anywhere in `src/`, and did not before this slice either. Nothing in this codebase automatically verifies any of these three properties post-run; they are true (or, above, narrowed-and-true) as static properties of what the code DOES, checked here by hand and pinned by the tests this erratum cites, not by an assertion `pifleet` itself runs and could fail loudly on. That gap is not new to this PR and is not closed by it — recorded so a future reader does not go looking for a `containment_verify` step that was never built.

> **Erratum (2026-08-19, egress relay review) — KNOWN RESIDUAL: an `--internal` bridge does not deny the bridge gateway, and the fleet's containment claim is narrowed accordingly.**
>
> This was found by measurement, and it falsified the stronger claim the egress work had been making. A container attached to nothing but the deny-all `pifleet-egress` bridge — no `--add-host`, no second network, no capabilities, and with no relay running at all — pulled a full SSH banner off the bridge gateway:
>
> ```
> $ docker run --rm --network pifleet-egress alpine
> # ip route
> 172.18.0.0/16 dev eth0 scope link  src 172.18.0.2      <- the ONLY route; no default
> # nc 172.18.0.1 22
> SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.13
> # nc 1.1.1.1 443 / 192.168.86.49 8000 / 192.168.5.2 22 / 169.254.169.254 80
> (every one refused)
> ```
>
> The mechanism, confirmed against the live rule set rather than inferred from documentation: Docker implements internal-network isolation in the **FORWARD** chain —
>
> ```
> -A DOCKER-ISOLATION-STAGE-1 ! -d 172.18.0.0/16 -i br-<id> -j DROP
> ```
>
> — but the bridge gateway is **on-link and inside that subnet**, so traffic addressed to it is delivered locally through INPUT (policy `ACCEPT`) and never meets those rules. `--internal` genuinely removes the default route, which is why every off-subnet destination above is unreachable; it does not and cannot filter the gateway itself.
>
> **The honest reachable set from a worker is therefore:** `{relay listen ports} ∪ {every port on the bridge gateway} ∪ {every port on every sibling container on the bridge}`. It is **not a fixed set** — anything the Docker host or a sibling worker binds later joins it with no code change — and on native-Linux Docker (where CI runs) the host's listener set is materially larger than Colima's.
>
> **Accepted as a residual, not fixed.** Closing it requires either host-side `iptables` DROP rules for gateway-destined traffic from the bridge (outside Docker's model, and outside what this tool should be installing on an operator's machine), or a dedicated Docker host whose gateway serves nothing. Neither is in scope here.
>
> **What changed instead:** ISC-51 and ISC-57 are re-worded to what Docker actually guarantees — *no route off the bridge subnet* — rather than "no route to the public internet" / "any host other than". ISC-50/51 are downgraded from `[x]` to `[~]`, because the evidence that closed them was sampled (`1.1.1.1`, `example.com`) and sampling is what missed this. `test/integration/relay.test.ts` now **enumerates** instead: exactly one on-link route and no default route, asserted structurally; and the gateway residual asserted as a POSITIVE, so that hardening it later shows up as a failing test rather than as silent drift. ISC-261 tracks re-taking this evidence against an enumerated reachable set if oMLX moves off-host.
>
> One consequence worth stating for §12.4's benefit: because the Docker host is reachable from the bridge anyway, the egress relay does not *widen* the worker's reach to the host — it only makes one port on it resolvable by name. The relay's containment value is real but narrower than "the only path off the bridge".

> **Erratum (2026-08-19, ISC-259) — the reachable set gains one LAN endpoint, and this is the first time the relay genuinely WIDENS a worker's reach.**
>
> The paragraph immediately above is why this erratum matters. While the relay only ever dialled the Docker host, it added no reachability the bridge did not already have — the gateway was reachable regardless, so the relay merely made one port resolvable *by name*. §5.9 now permits `llm.relay_upstream` to name a trusted LAN oMLX, and a LAN peer is **not** reachable from the bridge by any other path: the measurements above record `nc 192.168.86.49 8000` being **refused** from a container on the bare `--internal` bridge. So the relay now creates reachability rather than renaming it.
>
> **The reachable set from a worker becomes:**
>
> ```
> {relay listen ports} ∪ {every port on the bridge gateway}
>                      ∪ {every port on every sibling container on the bridge}
>                      ∪ {one LAN host:port}          <- NEW, and bounded
> ```
>
> **The new term is the tightest one in the union, and deliberately so.** The first three are open-ended — anything the host or a sibling binds later joins them with no code change. The fourth is **exactly one `host:port`**, and it is the only term in this set that requires the operator to have written an authorizing rule:
>
> - it is a single explicit `host:port` from `llm.relay_upstream`, not a host, not a subnet, and not a port range;
> - it must be an **IP literal** (`config validate` refuses a hostname — §5.9 records the resolver measurement behind that);
> - it must **also** match an explicit `egress.allow` entry, judged by `decide()` against a policy containing no host derived from the endpoint being judged (`relay.ts:relayGatePolicy`). Without that entry `up` refuses with `rule: default-deny` before contacting Docker at all;
> - it changes only what the **relay** dials. Workers still resolve one alias on the internal bridge and cannot address the LAN peer directly.
>
> **What is genuinely worse than before, stated plainly:** a bridge running untrusted model output now has a TCP path to a machine that is not the operator's Docker host. The containment argument is no longer "the worst case is a port on a machine the operator fully controls". It is "the worst case is one operator-nominated port on one operator-nominated LAN machine, authorized twice in two different config blocks". That is a real widening and it is the price of §5.9's amendment; it is recorded here rather than absorbed silently.
>
> **This closes ISC-253's blocking condition.** ISC-253 required a non-vacuous `decide()` gate to land *before* the host pin was relaxed, because the pin was the only thing bounding the relay's blast radius. Both are in this change, in that order: the dial side was decoupled from `llm.base_url` and gated against operator-written allow rules first, and only then was the pin relaxed. `test/unit/relay.test.ts` proves the gate by mutation — the LAN upstream is accepted with the allow entry and refused with `rule: default-deny` without it, from an otherwise byte-identical config.
>
> **Not re-measured here:** ISC-261's enumerated-reachable-set evidence still describes the pre-amendment topology. Re-taking it against a live LAN upstream is that criterion's work, not this one's.

> **Erratum (2026-08-19, ISC-261) — the GATEWAY term in both errata above is wider than the machine actually is, and the enumeration that found it.**
>
> The two set definitions above both read `{every port on the bridge gateway}`. That overstates the exposure. The gateway term is **every HOST-NAMESPACE listener**, which is a strictly smaller set: a **published container port is not reachable from the `--internal` bridge at all**.
>
> This was found by replacing the sampled evidence with a complete enumeration, which is what ISC-261 asked for. Both errata above reason from the FORWARD-chain rule correctly but stop one hop early. `docker run -p` is implemented as DNAT in **nat/PREROUTING**, and the isolation DROP lives in **FORWARD**, which is evaluated *after* that rewrite. By the time the packet reaches the DROP its destination is the target container's address — outside the internal bridge's subnet — so it matches `! -d <subnet>` and dies. A host-namespace listener is never forwarded at all: it is delivered locally through INPUT (policy `ACCEPT`), which is why it *is* reachable.
>
> Measured 2026-08-19 by `test/integration/relay.test.ts`, scanning all 65535 ports rather than a candidate list, with two beacons planted by the test itself — one in the host namespace (`--network host`), one published (`-p`):
>
> ```
> kernel socket table (--network host, /proc/net/tcp) : 22, 53, 39375, 40375
> ordinary bridge, full-range scan of its gateway     : 22,     39375, 40375
> deny-all bridge, full-range scan of its gateway     : 22,            40375
>                                                                ^^^^^ published: NOT reachable
> ```
>
> Three sources, two **strict** narrowings, so neither relation is a tautology. Port 53 is a real listening socket no bridge reaches (the resolver binds loopback); port 39375 is a live published port reachable from an ordinary bridge and not from the deny-all one. The expected set is deliberately **not** derived from a second probe of the same shape — that is the circularity ISC-253's `decide()` gate had — but from the kernel's own socket table, read without sending a packet.
>
> **The sibling term is correct as written, and was checked rather than assumed.** A sibling is in-subnet, so it is reached directly and never meets the DNAT path that defeats a published port. Measured: a stray container planted on the bridge and scanned across the full range from an ordinary worker answered on exactly the one port it served.
>
> **The corrected set, superseding both statements above:**
>
> ```
> {relay listen ports} ∪ {every HOST-NAMESPACE listener on the Docker host}
>                      ∪ {every port on every sibling container on the bridge}
>                      ∪ {one LAN host:port}          <- ISC-259, bounded
> ```
>
> Still not a fixed set: anything the host binds **in its own namespace**, or a sibling binds at all, joins it with no code change. The narrowing is real but modest — it removes published container ports from the residual, and nothing else.
>
> **What this does NOT claim.** The enumeration is now taken against the post-ISC-259 code (all eight relay probes pass against it), but it does not exercise a live LAN upstream: the `{one LAN host:port}` term is asserted by `test/unit/relay.test.ts`'s mutation of the `decide()` gate, not by a packet sent to a LAN peer through a running relay. #20's "not re-measured here" note is therefore only partly discharged — the first three terms are enumerated, the fourth is not. Separately, the probes have NOW been observed on a native-Linux GitHub runner and pass there: `total=79 expected=79`, 73 pass / 6 skip / 0 fail, all six pinned skips matched by name. **That run also falsifies a claim made in the erratum above.** It states that "on native-Linux Docker (where CI runs) the host's listener set is materially larger than Colima's". Measured on the runner, the shape is identical to Colima's — `22, 53` plus the two beacons this test plants, with the published one again unreachable from the deny-all bridge:
>
> ```
> kernel socket table                             : 22, 53, 39440, 40440
> ordinary bridge (172.19.0.1), full-range scan   : 22,     39440, 40440
> deny-all bridge (172.18.0.1), full-range scan   : 22,            40440
> ```
>
> So the residual is not materially worse on a runner than on the maintainer's machine; that sentence was reasoning, not measurement, and is corrected here. The enumeration is roughly 2.2x slower there — 154.9s and 153.8s for the two probes against ~70s locally — comfortably inside the 600s per-test budget those timeouts were sized for.

> **Erratum (2026-08-30, documentation audit) — GOOD NEWS THAT WENT UNRECORDED: the gateway residual
> was CLOSED in code, and every "accepted as a residual, not fixed" above has been stale since.
> Three reachable-set unions in this section are consequently wrong in the direction of overstating
> the exposure.**
>
> The 2026-08-19 erratum said closing it "requires either host-side `iptables` DROP rules for
> gateway-destined traffic from the bridge (outside Docker's model, and outside what this tool
> should be installing on an operator's machine), or a dedicated Docker host whose gateway serves
> nothing. Neither is in scope here." The first option was subsequently built and IS in scope:
> `src/security/gateway-block.ts:108` emits `[op, "INPUT", "-i", bridge, "-d", gateway, "-j", "DROP"]`,
> applied in the host network namespace via `nsenter` from a privileged short-lived container
> (`gateway-block.ts:113-121`).
>
> **It is mandatory, not opt-in.** `src/security/network.ts:217` calls `ensureGatewayBlocked` from
> inside `ensureEgressNetwork`, on the adopt path as well as after create, and `gateway-block.ts:185-205`
> refuses to start when the rule cannot be installed or verified — so a fleet either has the block
> or does not run. The `-i`/`-d` pair is deliberately narrow: it drops traffic from THIS bridge to
> THIS gateway and nothing else, which is the security property and the blast-radius bound at once.
>
> **The measured result.** `test/integration/relay.test.ts:554` enumerates the gateway across all
> 65535 ports and asserts the reachable set is **empty**. Its own docstring says this "would be GOOD
> NEWS to be written into SRD §12.8 and ISC-51 … That is exactly what happened" — and it did not
> happen to this document until now, which is the drift this audit was looking for.
>
> **So the honest reachable set from a worker is:**
>
> ```
> {relay listen ports} ∪ {every port on every sibling container on the bridge}
>                      ∪ {one LAN host:port, only where the operator authorized one}
> ```
>
> The `{every port on the bridge gateway}` and `{every HOST-NAMESPACE listener on the Docker host}`
> terms are **gone**. The sibling-container term stands and is still open-ended: containers on the
> same bridge reach each other, and nothing in this section addresses that. The residual paragraphs
> above are kept verbatim as the record of what was measured and accepted before the fix, because
> the ISC-261 enumeration that widened the term from "gateway" to "host namespace" is the reasoning
> that made closing it worth doing.

### 12.9 No AI attribution

The `pifleet-worker` skill and the commit template forbid `Co-Authored-By`, "Generated with", and any mention of AI/LLM in commits, branches, or PR bodies. Enforced by a grep gate in CI.

> **Erratum (2026-08-30, documentation audit) — one sentence, three claims, and the enforcement it
> names is not the enforcement that exists.**
>
> **There is no commit template.** `grep -rn 'commit.template\|gitmessage'` across the repository
> returns exactly one line: this sentence.
>
> **There is no grep gate in CI.** The guard is a Bun unit test — `test/unit/anti-criteria.test.ts:54-70`
> — running four regexes (`/Co-?Authored-?By/i`, `/generated\s+(?:with|by)…/i`,
> `/(?:AI|LLM)-(?:generated|assisted|authored|written)/i`, `/written\s+by\s+(?:an?\s+)?(?:AI|LLM)/i`)
> over `src/**/*.ts`, executed by `bun test test/unit` in the `test` job. A test is a better
> instrument than a grep gate, so this is a correction of the name rather than a complaint.
>
> **Nothing inspects commits, branch names, or PR bodies — and the test says why.** Its docstring at
> `:100-107` records those clauses as VACUOUSLY true: pifleet emits no `git commit`, no `git push`
> and no `gh`, so there is no generated commit or PR body to inspect. `:106-146` pins that
> capability, so if pifleet ever gains one the vacuity is broken loudly rather than silently. What
> is NOT covered, and cannot be by this instrument, is a WORKER's commits — the skill instructs, and
> nothing checks. `skills/pifleet-worker/SKILL.md` now says so in place rather than listing the rule
> among things that "will not work".

---

## 13. Failure taxonomy

| # | Failure | Detection | Mitigation |
|---|---|---|---|
| F1 | Worker waits forever on a UI dialog | `extension_ui_request`, no settle | §12.3 four guards; `{cancelled:true}` on dialogs only |
| F2 | `agent_end` mistaken for completion | `willRetry === true` | settle on `willRetry:false` + quiesce (§7.4) |
| F3 | Pi exits 0 on crash, clean stop, and broken pipe alike | — | never use exit code; `docker inspect` + event staleness |
| F4 | stdin closed → in-flight work destroyed | — | stdin held open for container life; abort→await→close |
| F5 | Self-report disagrees with the diff | A1 vs A2 | hard failure class, top of report |
| F6 | Two workers edit the same file | worktree isolation; `git merge-tree` pre-check | conflicts surfaced, never auto-merged |
| F7 | Work lands in the wrong checkout | container has no other mount | impossible by construction |
| F8 | cmux socket refuses | `ping`/`capabilities` | named diagnosis; `tmux` fallback; exit 3 |
| F9 | `read-screen` absent or fails after display sleep | probe | irrelevant by design |
| F10 | cmux/Pi version drift | pinned versions in ledger | `doctor` exits 3 on delta |
| F11 | Context overflow / compaction thrash | `compaction_*` frequency | **NOT BUILT** — smaller briefs and the report flag are real; pre-emptive `compact` is not (`grep -rF '"compact"' src/` returns nothing) |
| F12 | Cost runaway | **NOT BUILT** — no 60s sampler exists; all nine `get_session_stats` references in `src/` are comments, and `src/harvest/usage.ts` records that the only executable one in the repository is the RESPONDER in the test double | reservation + ceiling halt (**the 80% soft-stop was never implemented and its config key was removed — ISC-280**) |
| F13 | Provider rate-limit / transient error | `auto_retry_*` | **NOT BUILT** — no backoff and no retry-count escalation to `blocked`; `grep -rniE backoff src/` returns nothing |
| F14 | Session file rewritten, not appended | inode/size change | `(dev,ino,size,offset)` tracking (§8.3) |
| F15 | Pane closed by Dan | surface missing | supervisor is detached — unaffected (**rpc mode only**). In `pane_mode: tui` the pane OWNS the `docker attach`, so closing it is believed to stop the worker — **asserted, never measured**: `--sig-proxy` sits at docker's default and no probe has closed a tui pane and inspected the container. `report` says so per-run (ISC-382). |
| F16 | Secrets rendered into a pane | — | no provider key exists in the container (§12.4) |
| F17 | Stale checkouts accumulate | `StaleWorktreeError` refuses to adopt one at `up` (§9.2 erratum — `git worktree prune` retired with `git worktree add`) | two-phase `down`; refuse dirty without `--force` |
| F18 | Orchestrator crashes mid-run | ledger + registry on disk | detached supervisors; replayable `wait`; idempotent dispatch |
| F19 | Worker ends turn asking a question | **NOT BUILT** — the interrogative test needs the assistant's last text and `get_last_assistant_text` exists only in the test double | `blocked`; question surfaced |
| F20 | `pi` wedged but alive | `last_event_at` stall | two-signal liveness |
| F21 | Torn read / multi-byte split | — | `StringDecoder` across polls; whole-line watermark (§8.3) |
| F22 | `result.json` half-written | schema/epoch check | atomic write + dir fsync |
| F23 | `.git/config` lock contention (concurrent operators registering a `worker-<id>` remote in the same parent — §9.2 erratum retired the `index.lock`/`worktree add` contention this row originally named); branch name git refuses; submodules/LFS | bounded retry-with-backoff on the config lock; `check-ref-format --branch` preflight; ref-scoped LFS/submodule scan | named fail-fast before any clone exists; no orphan left behind on a later failure |
| F24 | Budget overshoot between polls | ledger reconciliation | per-task reservation (**the soft-stop band was never implemented — ISC-280**) |
| F25 | Pane closed → orphaned worker | registry orphan scan | supervisors detached; reaper (§13.1) |
| F26 | **Stale epoch attributes one task's success to the next** | epoch not quiesced | correlated `get_state` fence (§7.5) |
| F27 | ~~Unpriced model → `usd_ceiling` never trips~~ | — | **Retired.** Local models are always unpriced; `tokens_ceiling` is the only ceiling (§5.9) |
| F28 | **Repo `.pi/extensions` executes in-process** | — | `--no-extensions` mandatory; container containment (§12.2) |
| F29 | **Envelope path dereference / symlink exfiltration** | canonicalization refusal | §12.5 |
| F30 | **Worker prose acted on as instruction** | — | untrusted-data fencing (§12.6) |
| F31 | **Wedged supervisor — nothing kills it** | `heartbeat_at` > 3× interval | reaper SIGTERMs the process group, guarded by recorded start-time |
| F32 | **`down --prune` races a live container** | supervisor not confirmed dead | two-phase quiesce-then-prune (§9.3) |
| F33 | **Container clock/uid mismatch breaks worktree write-through** | `image verify` write-through probe | fixed uid 10001; `doctor` checks both directions |
| F34 | **Registry lost-update race exceeds the ceiling** | — | single-writer daemon; all mutations by RPC |
| F35 | **`depends_on` cycle or failed dependency deadlocks `wait`** | topological sort | exit 2 on cycle is real; `skipped:dependency_failed` is **NOT BUILT** (`grep -rF dependency_failed src/` returns nothing) |
| F36 | **ADC token expires mid-task; `gcloud`/`kubectl` fail late with an auth error** | **NOT BUILT** — nothing inspects tool output for 401 or `invalid_grant` | the periodic refresh and re-injection are real; "re-mints once before failing the epoch" is **NOT BUILT** — `src/supervisor/index.ts`'s `onFailure` sets `degraded: true` and flushes state, degrading LOUDLY without killing the epoch |
| F37 | **Google credential exfiltrated by a worker with `bash`** | not detectable from inside | `adc_mode: token` bounds it to ~1 h; `cloud_access` off by default; SA impersonation; egress allowlist; host gcloud store never mounted (§5.8) |
| F39 | **Model emits prose instead of native `tool_calls`** — worker looks healthy, streams, settles, and does nothing | startup `tools` probe **+** runtime zero-tool-call counter | exit 2 at `up` on prose; at runtime, 3 turns with zero tool calls → `failed:no_tool_calls`; measured on `Qwen3-8B-4bit` (§5.9) |
| F40 | **N workers queue on one local inference server**; a slow generation stalls the whole fleet and trips stall-kills | oMLX latency measured at `doctor` | `max_concurrent` default 2, set from evidence; `event_stall_warn` sized to absorb queueing; refuse to start during MLX training |
| F38 | **A worker runs a destructive `gcloud`/`kubectl`/`helm` command against live infrastructure** | `verbgate` shim classifies argv; ledger records every cloud invocation | mutating verbs refused (exit 77) unless named in the task's `cloud_allow[]` (§5.10); `cloud_access` off by default; `impersonate_service_account` is the stronger control. **Residual:** `bash` can reach `<name>.real` or `curl` the API directly — the shim stops casual damage, not determined evasion |

### 13.1 The reaper

`heartbeat_at` older than 3× `heartbeat_interval` ⇒ SIGTERM the supervisor's **process group** ⇒ SIGKILL ⇒ `docker rm -f` the container. Every signal is guarded by the recorded process start-time, so a reused pid after a crash or reboot is never signalled.

> **Erratum (2026-08-30, documentation audit) — §13.1 is correct as written and was re-verified line
> by line. The table above is not: six of its cells name a mechanism that does not exist, and five
> more name the wrong instrument for a mechanism that does. They are separated below because the two
> classes need different responses — the first is unbuilt work, the second is a document to fix.**
>
> **§13.1 confirmed.** `STALE_HEARTBEAT_MULTIPLIER = 3` (`src/safety/reaper.ts:66`), staleness at
> `:113-115`, the SIGTERM→SIGKILL ladder at `src/safety/kill.ts:625,640`, `docker rm -f` at
> `src/safety/reaper.ts:148`, and the start-time guard at `src/safety/kill.ts:406-407` —
> `same = await sameIdentity(target, ops); if (!same) return "gone";`.
>
> **Class 1 — cells naming a mechanism that does not exist.**
>
> | Cell | Measurement |
> |---|---|
> | **F12** detection, "60s `get_session_stats`" | nothing sends that command. `grep -rn 'get_session_stats' src/supervisor/` returns nothing, and `src/cli/commands/harvest.ts:57-60` says so at the source: "`state.usage` is never written — nothing sends `get_session_stats`". Cost is read from the transcript instead (`src/cli/commands/dispatch.ts:520-527`). **The mitigation half — reservation plus ceiling halt — is real** (`src/safety/budget.ts:316`, `:376-382`), so F12 is defended; it is defended by a different sensor |
> | **F11** mitigation, "pre-emptive `compact`" | `grep -rnE '"compact"' src/` returns nothing. `compaction_end` increments a counter (`src/supervisor/index.ts:1369-1370`) and no threshold reads it. The "report flag" is not in `src/report/` either; the count reaches only the reconstruction payload (`src/cli/commands/harvest.ts:97`) |
> | **F19** mitigation, "interrogative → `blocked`; question surfaced" | not built, in either half. `grep -rniE 'interrogat' src/` finds only the word "interrogated" in two unrelated comments, and `grep -rn 'get_last_assistant_text' src/` returns nothing. The settle chain (`src/supervisor/index.ts:1082-1095`) has no `blocked` branch at all; such a turn becomes `unknown` with `turn_completed_without_result_envelope` (`src/harvest/transcript.ts:492-493`). §12.3's "guard 4" is the same claim and is equally unbuilt |
> | **F13** mitigation, "backoff; excess retries → `blocked`" | `auto_retry_start` increments `state.retries` (`src/supervisor/index.ts:1370-1371`) and nothing reads it as a threshold. No backoff timer exists; `#retriesOutstanding` (`src/rpc/completion.ts:55`) only gates the quiesce condition |
> | **F35** mitigation, "`skipped:dependency_failed`" | no such state and no such reason. `grep -rn 'dependency_failed' src/` returns nothing; the scheduler marks dependents `blocked` with a root-cause pointer (`src/orchestrate/graph.ts:228-229`), and the state enum (`src/contracts.ts:1174-1180`) has no `skipped`. **"exit 2 on cycle" is correct** (`src/orchestrate/tasklist.ts:88-93`) |
> | **F36** detection, "401/`invalid_grant` in tool output", and "re-mints once before failing the epoch" | `grep -rn 'invalid_grant' src/` returns nothing; no code inspects tool output for auth failures. The refresher retries on a fixed 60 s interval indefinitely (`src/security/refresh.ts:38`, `:104-107`) and never fails an epoch — `src/supervisor/index.ts:735-736`: "A failed refresh degrades the worker LOUDLY; it does not kill it." **The 45 m interval against a ~60 m TTL is correct** (`src/config/schema.ts:538`) |
>
> **Class 2 — right mechanism, wrong instrument named.**
>
> - **F10** — no version reaches the ledger (`src/run/ledger.ts:73-75` states outright that "nothing
>   stamps a version on a ledger record"), and `doctor` does not exit 3 on a Pi/cmux delta: its
>   version floors cover `docker`, `git` and `tmux` only (`src/cli/commands/doctor.ts:131-135`),
>   cmux is graded by capability rather than version, and `pi --version` is probed for display with
>   no floor (`doctor.ts:1135`, `required: false`). The pin-vs-actual comparison is real but lives in
>   `pifleet image verify` and `up` (`src/container/image.ts:350`, reached from
>   `src/cli/commands/image.ts:103` and `assertImagesReady` at `src/cli/commands/up.ts:609`).
> - **F33** — `doctor` does not check write-through in both directions. It probes one direction, that
>   a bind-mount SOURCE is visible inside a container at all (`doctor.ts:1210, 1248-1261`, via
>   `probeBindMountSources`), which is a different and narrower thing. The both-directions probe is
>   `probeWriteThrough` (`src/container/mounts.ts:231`), called only from `src/container/image.ts:402`
>   — `image verify` and `up`. The detection column is therefore right and the mitigation column
>   names the wrong command.
> - **F3** — `docker inspect` is never run against a worker container. Every `inspect` call site is
>   the relay container, the egress network, or an image; a worker is only ever `docker rm -f`'d
>   (`src/safety/reaper.ts:148`, `src/cli/commands/down.ts:1507`). **The row's doctrine holds** — the
>   exit code is never consulted, and `src/supervisor/index.ts:1002-1011` settles
>   `failed`/`worker_died` on any exit — and event staleness is real.
> - **F14** — the identity tuple is `(dev, ino, birthtime)` plus head and tail content hashes
>   (`src/util/jsonl.ts:374`, `:377-390`), not `(dev, ino, size, offset)`. Size is explicitly rejected
>   as a discriminator at `jsonl.ts:349-353` and inode identity alone at `:362-366`. Stronger than
>   the doc, and differently shaped.
> - **F24** — reconciliation is not against the ledger; see §7.7's erratum. Settlement books
>   `io.taskTokens` (`src/orchestrate/scheduler.ts:523-526`) computed from `state.json` plus the
>   transcript. The per-task reservation mitigation is correct.
> - **F21** — the class is `TextDecoder` with `{stream: true}` (`src/util/jsonl.ts:55`), not
>   `StringDecoder`. Same mechanism, different name; recorded because a reader grepping for the
>   documented name finds nothing.
> - **F23** — the config-lock retry is a FIXED 50 ms delay, twenty times
>   (`src/run/worktree.ts:453-460`), not backoff. Bounded, which is the property the row needs.
> - **F7** — "the container has no other mount" is false as written: `src/config/render.ts:255-298`
>   emits `/workspace`, `/outbox`, `/sessions`, `/skills:ro`, `/policy/cloud-allow:ro`, the secret
>   store, the agent volume, the briefing and `/home/pi/.kube/config:ro`. **The row's substantive
>   claim holds** — exactly one repo checkout is mounted, `:255` or `:258` and never both — and §5.5
>   is the table that carries the full list.
> - **F1** — "§12.3 four guards" over-counts. Guard 4 is F19 above and does not exist, and guard 3's
>   kill half is not on the stall path: `src/run/stall-io.ts:89-90` says "Signalling is deliberately
>   NOT done here", and `abortWedged` (`:115-120`) sends only the advisory RPC. F1's own mitigation —
>   `{cancelled:true}` on dialogs only — is correct (`src/supervisor/ui-requests.ts:114-117`).
>
> **What this erratum does NOT claim.** The other twenty-odd rows were checked and hold; the
> confirmations are not reproduced here row by row, but every config key §13 names exists with the
> stated default (`tokens_ceiling`, `max_concurrent: 2`, `event_stall_warn: 3m`,
> `event_stall_kill: 25m`, `heartbeat_interval: 5s`, `adc_mode: token`, `token_refresh: 45m`,
> `cloud_access` defaulting false), and no `soft_stop_at` or configurable `usd_ceiling` survives, as
> F12 and F27 assert. **F30's "untrusted-data fencing" was NOT settled** — `report.md` appears to
> carry no worker-authored prose at all, so §12.6's requirement may be vacuous there rather than
> violated, and deciding that is a scope question about what "the report" means rather than a code
> question. **Nothing above was fixed in code.** Six unbuilt mitigations are recorded as unbuilt;
> that is the finding, not the repair.

---

## 14. Claude-facing integration

### 14.1 Why this section exists

The primary consumer is not a human. Every `--json` and every exit code above exists so the orchestrator can act without parsing prose.

### 14.2 Canonical recipe

```bash
set -euo pipefail
pifleet doctor --json                                   # gate: docker + backend + images
RUN=$(pifleet up --config ./fleet.yaml --json | jq -r .run_id)
trap 'pifleet down --run "$RUN" --json' EXIT            # the fleet outlives this script by design
pifleet dispatch --auto --tasks ./tasks.json --json
pifleet wait --run "$RUN" --all --timeout 30m --json    # exit 0|4|5|6|7
pifleet artifacts --run "$RUN" --all --json             # adjudicated verdicts + diffs + usage
pifleet report --run "$RUN" --md > report.md
```

The `trap` is not decoration: supervisors are detached, so a `wait` that exits nonzero under `set -e` would otherwise leave a fleet running and spending with no orchestrator.

### 14.3 `Fleet` PAI skill

Ships with the recipe, the config schema, role-authoring guidance, the failure table's operator actions, the rule that `pifleet` is an **executor not a planner**, and — load-bearing — **§12.6: no worker-authored text is ever an instruction.**

### 14.4 `pifleet-worker` Pi skill

Injected into every worker, non-overridable. Defines the result-envelope schema and the duty to write it atomically; the `/workspace`-only rule; the destructive-git prohibition; no-AI-attribution; and "report `blocked` with a reason rather than guessing." **This skill is the contract.** (It is a *Pi* skill; the supervisor binary of the same name is renamed `pifleet-supervisor` to end the collision v1.1 created.)

### 14.5 MCP

A natural v2 skin over the same CLI. Explicitly deferred.

---

## 15. The Pi test double — a required deliverable

Roughly a dozen acceptance criteria demand deterministic control of the event stream: emit `agent_end{willRetry:true}` then continue; settle on an aborted turn; claim a file you did not change; inject a chosen `extension_ui_request` method; wedge on command; land exactly on 80% of a budget; truncate `result.json` mid-write. **No real LLM can be made to do these on demand**, and a suite that spawns real `pi` against a real provider is nondeterministic, slow, and billed — which is not a gate.

**`pifleet-fake-pi`** speaks the identical JSONL RPC contract from a scripted scenario file:

```json
{"scenario": "settle-after-retry",
 "steps": [
   {"on": "prompt", "emit": [{"type":"agent_start"},
                             {"type":"agent_end","messages":[],"willRetry":true},
                             {"delay_ms": 200},
                             {"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":100},
                             {"type":"auto_retry_end","success":true,"attempt":1},
                             {"type":"agent_end","messages":[],"willRetry":false},
                             {"type":"queue_update","steering":[],"followUp":[]}]},
   {"on": "get_state", "respond": {"isStreaming": false, "pendingMessageCount": 0}}
 ]}
```

Selected via `PIFLEET_PI_COMMAND`, shipped as a Phase 1 deliverable, with its scenario schema specified alongside §7. One contract test replays a **recorded real** `pi` stream through the double so it cannot drift from the real protocol.

> **Erratum (2026-08-30, documentation audit) — this sentence used to name `PIFLEET_PI_BIN`, and the
> recorded-stream contract test was never built.**
>
> **The selector.** Grepping the old spelling across `src/`, `test/` and `docker/` returns nothing.
> The name that selects the double is **`PIFLEET_PI_COMMAND`**: `src/cli/commands/up.ts:312` decides from it
> whether a run is a double run, `:481` refuses a no-config `up` when it is unset, `:1356` forwards
> it to each supervisor, and `src/supervisor/index.ts:30` already spells it correctly. This was
> worse than a typo. The variable is the only way to run the acceptance suite at all, so §17's own
> preamble — "runnable on `headless` against `pifleet-fake-pi`" — was reachable from this document
> only by guessing.
>
> The scenario schema above is otherwise accurate: `on`, `emit`, `respond` and `delay_ms` are the
> shapes `test/fixtures/fake-pi.ts:33-48` documents and parses. The double lives at
> `test/fixtures/fake-pi.ts`, with its session-partition rule split into
> `test/fixtures/scenario-steps.ts`.
>
> **The contract test does not exist.** There is no recorded `pi` stream anywhere in the tree:
> `test/fixtures/` holds `scenarios/` (24 hand-written scripts), `tasklists/`, `hostile-repo/` and
> four `.ts` helpers, and no capture of a real session. The sentence is kept above rather than
> deleted because it names a real gap — every fixture the suite replays is a script somebody WROTE,
> so the double's fidelity to Pi 0.79.6 rests on §4.2's Phase 0 reading and on nothing that
> re-checks itself. ISC-147 found the sharp end of the same problem from the other side:
> `test/fixtures/fake-pi.ts:487` decides `isStreaming` by reading `willRetry`, so for a long time
> every fixture was defended by the double rather than by the code under test.

---

## 16. Implementation plan

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 — Verify** ✅ | cmux + Pi surfaces executed live | **DONE 2026-07-26** — §4 rewritten from evidence; 11 v1.1 errors corrected (§18) |
| **1 — Container + headless core** | Dockerfile + `image build/verify`, config loader, renderer, detached supervisor, RPC client, epoch fencing, state/events/ledger, **`pifleet-fake-pi`** | `up → dispatch → wait → artifacts` green on `headless` with one containerized worker, entirely against the double |
| **2 — Artifacts + safety** | outbox contract, `pifleet-worker` skill, worktree isolation + preflight, harvester (A1/A2/A4/A6), adjudicator, envelope hardening, budget ceilings + reservation, kill ladder, reaper | result harvested three ways; seeded self-report disagreement detected; seeded envelope-path escape refused; ceiling halts a run |
| **3 — Security + cloud identity** | egress bridge (oMLX + Google only, deny-all default), **ADC token injection + refresh loop**, `--no-extensions` defaults, containment verification, control-socket auth | seeded hostile repo (`.pi/extensions` + `AGENTS.md`) changes nothing; no provider key and no `refresh_token` present in any container; a long-running container survives token expiry; seeded escape attempt detected |
| **4 — Panes** | `cmux` backend (password mode, viewer-only panes, sidebar pills), `tmux` backend | 6 panes, 6 containers, `doctor` clean; results identical to the Phase 1 headless run |
| **5 — Orchestration** | `dispatch --auto`, dependencies, `report` + merge pre-check, `Fleet` PAI skill, **SRE role briefings** (`sre`/`investigator`/`verifier`) | Claude runs §14.2 end-to-end on a real cluster-diagnosis task: investigator finds it, sre remediates on a branch, verifier confirms |
| **6 — Attended** | `tui` pane mode + its voided-requirements table, `steer`, live model switch | Dan takes over a pane mid-task; harvest still succeeds |

Phases 1–3 are load-bearing. Phase 3 precedes any real-repo run — v1.1 scheduled a live multi-repo run before the kill ladder and budget ceilings existed.

---

## 17. Acceptance criteria

Runnable on `headless` against `pifleet-fake-pi` except where marked.

**Container**
1. `image build --toolchain node` produces an image whose `pi --version` matches the pinned version.
2. `image verify` fails on an image whose Pi version differs from config.
3. A worker container runs as uid 10001 with a read-only root filesystem.
4. A file written to `/workspace` appears in the host worktree, and vice versa.
5. `/skills` is read-only inside the container; a write attempt fails.
6. The host `~/.pi/agent` is not mounted in any container.
7. `docker inspect` shows no cloud provider key in any container's environment (only `OMLX_API_KEY`).
8. `up` refuses to start when a role's image is missing.
9. `gcloud version`, `kubectl version --client`, `helm version`, `jq --version`, and `curl --version` all succeed inside every worker image regardless of `toolchain`.

**Google credentials**
10. With `cloud_access: true` and `adc_mode: token`, `gcloud auth print-access-token` succeeds inside the container.
11. In `token` mode, no `refresh_token` appears anywhere in the container: not in env, not on disk, not in `/creds`.
12. The host `~/.config/gcloud` directory is not mounted in any container (`docker inspect` mount list).
13. A role with `cloud_access: false` has no Google credential and `gcloud auth print-access-token` fails.
14. After `token_refresh` elapses, a `gcloud` call inside a long-running container still succeeds (token was re-injected).
15. With `impersonate_service_account` set, the token's identity is the SA, not Dan's account.
16. `up` prints the granted identity, project, and ADC mode for every `cloud_access` worker.
17. A container completes a model call against `host.docker.internal:8000` with no route to the public internet.
18. A model outside `models_allowlist` is refused at `up` with exit 2.
19. A model that answers a `tools`-bearing probe with prose is refused at `up` with exit 2.
20. `doctor` reports the oMLX model list and a measured single-request latency.
21. `up` refuses to start while an MLX training run is active, unless `--i-know` is passed.
22. Egress to any host other than the oMLX endpoint and the configured Google endpoints is denied from inside a container.

**Configuration**
23. `config validate` exits 2 with a field-level error on a malformed config.
24. `config validate` rejects a role combining `bash` with `read_only: true`.
25. `render --worker eng-1` emits the expected normalized argv without spawning anything.
26. Changing `workers:` length changes the container count, with no other edit.
27. Two roles produce different `--model` and different `--skill` sets.
28. A role that overrides `skills:` still receives `pifleet-worker`.
29. Multiple briefing fragments produce exactly **one** `--append-system-prompt` argument.
30. No rendered argv contains an `@`-prefixed path.

**Lifecycle**
31. `up` returns a `run_id`; every worker reaches `idle` within 60s.
32. `status --json` reflects `busy` within 2s of dispatch.
33. `down` leaves no running container and no supervisor for that run.
34. Closing a worker's pane does not stop the worker (**rpc mode**); the task still settles.
35. Killing the `pifleet` CLI mid-run leaves supervisors running; `status --run` re-attaches and `wait` still returns a verdict.
36. No supervisor has the CLI or a pane shell as its parent: `pgid == pid` and its session differs from the launcher's.

**Dispatch and completion**
37. A dispatched task appears in the transcript as a `UserMessage`.
38. `steer` injects a message that appears before the next assistant turn.
39. `abort` returns the worker to `idle` within 10s.
40. A scenario emitting `agent_end{willRetry:true}` then continuing is **not** reported complete.
41. A scenario settling on an aborted turn is reported `aborted`, not `success`.
42. The §7.5 interleaving scenario does not attribute epoch N's diff to epoch N+1.
43. Re-dispatching a completed `(worker, task_id, epoch)` is a no-op returning `already_completed`.
44. A `prompt` that acks then fails late fails its epoch rather than reporting accepted.

**Artifacts**
45. `artifacts --task T --json` validates against `pifleet.result/v1`, and `verdict` validates against the §7.3 domain.
46. The reported diff equals `git diff` on the worker's branch.
47. Killing a worker after edits but before `result.json` still yields a reconstructed verdict.
48. A worker claiming a file it did not change is flagged.
49. A worker whose envelope says `success` with an empty diff is reported **failed**.
50. A missing envelope does not downgrade a task with a clean diff and green acceptance commands.
51. `session_path` in `state.json` equals the path `get_state` reported; no globbing occurs.
52. A worker that dies before its first assistant message is distinguishable from one with a wrong path.
53. Harvesting a transcript mid-write succeeds and resumes on the next poll.
54. A transcript containing `U+2028` inside a JSON string parses correctly.
55. A 4-byte codepoint split across a poll boundary produces no `U+FFFD`.
56. A session file that shrinks or changes inode is re-read from 0.
57. `transcript --html` produces an openable file.

**Safety and security**
58. A `kubectl get` in a `cloud_access` worker succeeds; a `kubectl delete` not in `cloud_allow[]` exits 77 and is refused.
59. A mutating verb named in the task's `cloud_allow[]` executes and is recorded in the ledger with task id and argv.
60. Every cloud invocation, permitted or refused, appears in the run ledger.
61. A worker completing 3 turns with zero tool calls is classified `failed:no_tool_calls` rather than settling successfully.
62. With 6 workers up and `max_concurrent: 2`, at most 2 have an in-flight generation at any sampled moment.
63. A worker queued behind others is not killed as wedged before `event_stall_warn` elapses.
64. A dialog `extension_ui_request` is answered `{cancelled:true}` within 5s; an `editor` request does not hang the run.
65. Fire-and-forget UI methods receive no response and are logged.
66. Exceeding `tokens_ceiling` halts dispatch and exits 5, artifacts still harvested.
67. Exceeding `tokens_ceiling` halts a run whose reported cost is `0` throughout (local models are unpriced).
68. A task exceeding `deadline_s` is aborted, reported `timed_out`; exit 4.
69. A wedged agent (no events, live heartbeat) is killed at `event_stall_kill`.
70. A wedged **supervisor** is reaped by the daemon.
71. A repo carrying `.pi/extensions/hostile.ts` and a hostile `AGENTS.md` changes nothing about the run.
72. An envelope naming `/Users/dan/.env` is refused before dereference.
73. A symlink in `<outbox>/files` pointing outside the outbox is refused.
74. An oversized envelope field is rejected without OOM.
75. No ref outside `fleet/<run-id>/*` moves, and the main checkout's `status --porcelain` is unchanged.
76. A seeded escape attempt from inside a container is detected and reported.
77. The control socket refuses a connection from another uid; the run-dir is not mounted in any container.
78. No generated commit, branch, or PR body contains AI attribution.

**Backends**
79. The full suite passes on `headless` with cmux not running.
80. *(manual, cmux)* `up` creates one workspace and N panes, each showing its worker id and live activity.
81. *(manual, cmux)* `attach --worker eng-2` focuses that pane.
82. With the cmux socket unreachable, `up` exits 3 with a named diagnosis, or falls back to `tmux`.
83. `doctor` reports `read-screen` availability and the run succeeds identically either way.
84. `doctor` exits 3 when a `required` cmux CLI command is missing.

**Anti-criteria**
85. Disabling `read-screen` entirely changes no acceptance result.
86. No code path outside diagnostics calls `readScreen()`.
87. No file under `src/` imports a cmux symbol outside `backends/cmux/`.
88. No code path uses `readline` or `split(/\r?\n/)` on an RPC or session stream.
89. No acceptance test in the `headless` suite requires network egress or provider spend.

> **Erratum (2026-08-30, documentation audit) — four of the criteria above cannot be met as
> written, and one of them cannot fail. Each is corrected here rather than edited in place, so the
> list still reads as the design's original done-condition and the drift is legible.**
>
> **Criterion 11 names a mount that was never built.** "not in `/creds`" was written against
> `adc_mode: file`, which §5.8's 2026-08-25 amendment REMOVED — `buildDockerArgv` emitted no
> `/creds` mount and `ADC_FILE_PATH`/`fileModeMaterials`/`fileModeStartupEnv` had no caller. The
> criterion is therefore vacuously true of a directory nothing creates, which is the one thing an
> acceptance criterion must not be. **Read it as: no `refresh_token` appears in the container's
> environment, on any writable path, or in any mounted credential material.** The env and on-disk
> halves are still real and still the point.
>
> **Criterion 59 is WITHDRAWN as of 2026-08-30 (ISC-366), having been unmeetable before that.** The
> permitted half was never built and the owner descoped it rather than building it, so 59 no longer
> states an intention the system has — it is not a criterion this system is failing, it is a
> criterion this system withdrew. The paragraph below is kept as the record of what it asserted and
> how it was measured.
>
> **It was unmeetable because the task envelope's `cloud_allow[]` reaches no container.**
> `src/run/materialize.ts:806` writes `/policy/cloud-allow` as an EMPTY file, once per worker at
> `up`, and nothing rewrites it afterwards — `src/run/materialize.ts:783` carries a note addressed
> to "WHOEVER WIRES DISPATCH-TIME REWRITING", which was the honest statement that nobody had; that
> note now records the descope instead. See
> §5.10's erratum for the full consequence. **The permitted half of 59 is unreachable; the
> ledger half was half-true and is now whole** (corrected 2026-08-30). Rows ARE appended for every
> invocation, and as of ISC-362 they carry the real task id and epoch, read from the read-only
> `/policy/task` mount the supervisor rewrites at each dispatch. Until then `docker/verbgate` read
> `PIFLEET_TASK_ID`, which was set nowhere in production, so every production row recorded
> `"task":"<none>"` and `"epoch":0`. What was left unmeetable in 59 is the PERMITTED half only, and that
> half is now withdrawn rather than pending: no `cloud_allow[]` reaches a container, no mutating
> verb is ever authorized, and the envelope refuses a non-empty `cloud_allow[]` outright. Criteria 58 and 60 survive intact:
> an empty policy refuses every mutating verb with exit 77, which is 58 exactly, and the collector
> (`src/run/verbgate-collect.ts`) delivers 60 subject to ISC-172's stated truncation window.
>
> **Criterion 75 is the un-corrected twin of a sentence §12.8 fixed on 2026-08-18.** The branch
> namespace is `<branch_prefix>/<run-id>/*`, operator-configurable, not the literal `fleet/`:
> `src/run/paths.ts:543-544` is `` `${branchPrefix}/${runId}/${workerId}` `` and
> `test/integration/worktree.test.ts:528` asserts `experiment/run-abc/eng-1` for a fleet that sets
> one. §12.8's erratum corrected its own copy of this sentence and this one was left standing, which
> is exactly the failure mode a numbered acceptance list invites — the same claim in two places, one
> of them maintained. **Read it as: no ref outside THIS RUN's own configured namespace moves.** The
> second clause is unchanged and is now true outright (worker checkouts live under the run dir, not
> inside the operator's tree).
>
> **Criterion 37's `UserMessage` is Pi's type name, not a spelling this codebase uses.** Kept as
> written because §4.2:290 is where that vocabulary is defined; the wire encoding the harvester
> actually dereferences is `{type:"message", message:{role:"user"}}`
> (`src/harvest/transcript.ts:102-107`).
>
> **What this erratum does NOT claim.** The other 85 criteria were checked for the identifiers they
> name — every command, flag, exit code, config key, env var, path and enum member in §17 was
> grepped against `src/` and `docker/` — and the four above are the only ones that failed. That is a
> check on the NOUNS, not on the behaviours: nothing here re-ran the suite, and a criterion whose
> vocabulary is correct can still describe behaviour the code does not have.

---

## 18. Revision ledger — what v1.1 got wrong

Recorded because the *pattern* matters more than the individual corrections: **v1.1 was written from documentation websites; v2.0 is written from installed binaries.** Eleven of these were caught by three independent reviews; the cmux corrections came from executing the CLI in Phase 0. Several review findings were themselves refuted by that live evidence and are recorded here so they are not "re-fixed" later.

### Corrected — protocol fictions (would have been fatal)

| v1.1 claim | Reality | Where it came from |
|---|---|---|
| `agent_settled` is the completion primitive | **Does not exist** in 0.79.6 — zero occurrences in the package or its shipped `docs/rpc.md`. `wait` would have hung on every task, forever | pi.dev docs page |
| `bash_execution_update` event | Does not exist | same |
| `get_entries {since}` for incremental pull | Does not exist; `get_messages` is a full dump | same |
| Session path computable before launch | Lazily created on first assistant message; timestamp prefix unpredictable; **flat** under `--session-dir` | assumption |
| `--append-system-prompt` repeatable, `@path` syntax | **Last wins**; `@` is for message files only — an `@`-path is appended as literal text, silently | assumption |
| RPC response has no payload field | `data` carries it — budget polling had nowhere to read from | incomplete reading |

### Corrected — internal contradictions

- Status enum vs the five other outcome values the design produced → split into `status` / `verdict` / `phase` (§7.3).
- Result envelope required an `epoch` the task envelope never supplied → **every** envelope would have been rejected as stale (§7.1).
- Epoch scheme defeatable because no Pi event carries a correlation id → correlated `get_state` fence (§7.5).
- `FleetBackend.spawn` spawned into a pane, contradicting the detached-supervisor requirement it was meant to serve → `SupervisorLauncher` split out (§11).
- `tui` mode described as costing "nothing else" → voids ten requirements; now tabulated (§3.5).
- Absolute vs repo-relative paths mixed across envelope and diff → would have tripped F5 on every run (§7.2).
- Shallow merge silently dropped `pifleet-worker` → non-overridable injection (§6.1).

### Corrected — cmux facts (Phase 0, live)

Socket is `~/.local/state/cmux/cmux.sock` not `/tmp/cmux.sock`; access control is `automation.socketControlMode` in `cmux.json`, not a `CMUX_SOCKET_MODE` env var; **`password` mode exists and is the right answer**, not `allowAll`; `read-screen` **ships in production** (#152 closed); `list-panes` supersedes `list-panels`; `set_status`/`set_progress`/`log`/`sidebar_state` are **not** socket methods though the CLI commands work; `CMUX_SOCKET_PASSWORD` is protected-from-override but **not injected**.

### Review findings refuted by live evidence

Recorded so they are not re-litigated:

| Finding | Live result |
|---|---|
| "cmux has no pane-spawn primitive; `spawn()` is unimplementable" | **Refuted.** `workspace create --cwd --command --env --layout` exists and works; upstream #2538 has landed. Surviving nuance: `--command` is shell-injected, so pifleet passes `bash <script>` (§4.1) |
| "Programmatically created workspaces have dead PTYs (#1472)" | **Refuted on 0.64.20.** A background workspace accepted `send`, `send-key`, and `read-screen` immediately |
| "`workspace.create` accepts no name, so reuse-by-identity is impossible" | **Refuted.** `--name` round-trips into `workspace list` as `custom_title` |
| "Socket password auth is not functional for external callers" | **Refuted.** Verified working end-to-end; the app hot-reloads the config with no restart |
| "`layout: grid` is an invented capability" | **Partly refuted.** `--layout <json>` exists; the `grid|columns|rows` *vocabulary* was invented, so config now exposes a pifleet-side `split:` strategy (§6.2) |

---

## 19. Open questions

| # | Question | Owner | Blocks |
|---|---|---|---|
| Q1 | What is oMLX's real concurrent-request capacity on this machine — does it serve N workers in parallel or serialize them? Sets `max_concurrent` and the whole fleet's throughput ceiling. | Phase 1 | F40; fleet sizing |
| Q2 | Colima/virtiofs write-through performance for a 6-container fleet on one repo — is bind-mount latency acceptable, or is a copy-in/copy-out model needed? | Phase 1 | worktree mount design |
| Q3 | What is the real `--layout <json>` schema, and can it express a 6-pane grid in one call? | Phase 4 | cosmetic |
| Q4 | ~~Does `get_session_stats.cost` populate under subscription auth?~~ **Answered:** local models are unpriced, cost is always 0, `tokens_ceiling` is the only ceiling. | — | closed |
| Q5 | Should `oneshot` workers reuse a container or start one per task? | Phase 5 | container churn vs isolation |
| Q6 | Does `docker kill --signal=INT` through `tini` interrupt a Pi turn cleanly, or is RPC `abort` always required? | Phase 1 | `tui`-mode abort path |
| Q7 | Is OpenShell (Pi's documented policy-sandbox pattern) a better v2 substrate than plain Docker, given it can keep keys outside the sandbox natively? | post-v1 | §12.4 longevity |
| Q8 | ~~Should mutating cloud verbs be gated?~~ **Answered 2026-07-26: yes — `PATH` wrapper allowlist.** Specified in §5.10. Open sub-question: should `impersonate_service_account` with a viewer-role SA become mandatory for non-`sre` roles, which would close the evasion path the shim cannot? | Dan / Phase 3 | the residual half of F38 |
| Q9 | Pi reads oMLX provider config from `~/.pi/agent/models.json`, **not** env, and registers a provider only with a non-empty models list (recorded in the agentic-SRE work). Does the container entrypoint render that file from env, and does it survive the read-only root? | Phase 1 | every worker's ability to reach the model |

---

## 20. References

**Authoritative (installed, version-pinned):**
- `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` — Pi 0.79.6 RPC contract (1408 lines, ships with the package)
- `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/containerization.md` — the Plain Docker / Gondolin / OpenShell patterns §5 builds on
- `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/` — type declarations; `agent_end.willRetry`, `RpcSessionState`, `SessionStats`
- `cmux --help`, `cmux docs api`, `cmux capabilities --json` (0.64.20)
- `https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md` — cmux CLI stability contract
- `https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json` — `automation.socketControlMode` enum

**Secondary (may lead or lag the installed build — do not implement from these):**
- `https://pi.dev/docs/latest/{rpc,json,session-format,skills,usage}`
- `https://cmux.com/docs/api`

**⚠ Do not use as a reference:** `~/repos/pi` is **v0.62.0**, seventeen minors behind the installed 0.79.6. Half the flags in §4.2 do not exist in it.

**Local prior art:** `~/repos/paisley/Docs/bluesky-cli-srd.md` (SRD conventions) · `~/mlx-lab/docs/agentic-sre-srd.md` (Pi-as-harness evidence)
