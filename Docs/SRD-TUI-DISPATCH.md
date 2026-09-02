# System Requirements Document — dispatch to an adopted-terminal `tui` worker

**SRD-TUI-DISPATCH-001 v0.1 — DRAFT FOR OWNER REVIEW**
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001) and **proposes an amendment to its §3.5 and to the
`tui` voided table in `src/attended/voided.ts`**. Until that amendment is adopted, `Docs/SRD.md`
wins and this document is a proposal, not a specification. Where this document and `Docs/SRD.md`
disagree today, that disagreement is the subject of §4 rather than an oversight.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

`pifleet dispatch` refuses a `pane_mode: tui` worker whose pane is an **adopted terminal** — the
terminal that ran `up --attach-here`. The refusal's sentence is correct about the mechanism ("pifleet
has no surface id to type into") and it draws the wrong conclusion from it, because it assumes a
dispatch is a keystroke. A dispatch is two things: an **identity** (task id, epoch, outbox path,
brief) and a **trigger** (the byte that starts a turn). Only the trigger needs a terminal. The
identity already has a file plane — `/policy/task` is bind-mounted read-only into every worker,
including this one, and is rewritten in place by the supervisor at every RPC dispatch. This document
proposes that a dispatch to an adopted-terminal worker **stages** rather than types: it allocates a
real epoch, writes the inbox record, rewrites the provenance file, drops the rendered prompt where
the worker can read it, and tells the operator what to press. **The person keeps the keyboard;
pifleet gets the fence back.** No byte is written to the operator's terminal, so SRD Decision 1 — a
pane is a view, not a channel — is not weakened by one line, and the exception `pane_mode: tui`
already holds is not widened.

### 0.2 The decision that matters — this brushes against Decision 1, and the cheap fix would breach it

`README.md`'s second paragraph and `Docs/SRD.md` §0.2 state the founding rule: *"A pane is a view,
not a channel… **With one deliberate exception, which is the whole of `pane_mode: tui`.**"* That
exception was granted for a pane **pifleet creates and owns**: `up` splits it, `up` runs
`docker attach` in it, and `presentation.surface_ref` names it because the backend that made it can
address it.

Adoption inverts the ownership. The surface belongs to the operator's own session; pifleet did not
make it, does not control what program is running in it, and — the point §4.3 turns on — **cannot
observe whether it is still attached to the container at all**. `docker attach --detach-keys=ctrl-]`
means a keypress returns that terminal to a shell while `presentation.json` would still name it.

**So there are two honest dispositions, and §4 works through both:**

1. **Widen the exception.** Record a surface id for the adopted terminal — it is knowable, §3.1
   measures how — and type into it exactly as the backend-managed `tui` path already does.
2. **Split the dispatch.** Keep the pane a view. Deliver identity through the file plane that
   already exists, and leave the trigger with the person who is already sitting there.

**This document recommends (2), and §6 specifies it.** (1) is not merely less elegant; §4.3 argues it
is unsafe in a way that has nothing to do with taste, and the owner should reject it deliberately
rather than as a side effect of preferring the other.

### 0.3 The disclosure boundary

This document names no host, no operator machine, no ticket system or ticket identifier, no cloud
project, no credential and no employer. The 2026-09-02 console incident in §1.3 is described by role
— *the standing operations console*, *the observer worker*, *the ticketing worker* — using the worker
ids `fleet.example.yaml` already publishes. This follows §0.3 of `Docs/SRD-INFERENCE-PROVIDERS.md`.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Read** | code in this repository, opened and read on 2026-09-02, with file and line cited at every claim | §1.1, §2 in its entirety, §3.5 |
| **Recorded** | `Docs/SRD.md` §3.5 and its four errata, `src/attended/voided.ts`, `src/attended/adopt.ts`, `ISA.md` ISC-380/ISC-387/ISC-389, `fleet.example.yaml`'s annotations | §1.2, §3.1, §4.1, §4.2 |
| **Reported** | the operator's account of the 2026-09-02 operations-console session | §1.3 — labelled per item, and §2 says which of its four items the code independently explains and which it does not |
| **Inferred** | reasoning from the above | §4.3, §5, §6, §7, §8. **These are design proposals, not observations, and they are where the owner's review is most valuable.** |

**Nothing in this document was probed.** No fleet was stood up, no container was started, no pane was
opened, no binary was executed. Every §2 claim is a claim about **what the code says it does**, which
is weaker than the sibling SRDs' §2 and is labelled "read" rather than "measured" throughout for
exactly that reason. Where a claim would need a running system to settle, §9 holds it as an open
question rather than asserting it.

### 0.5 One correction to the premises this document was commissioned against

The commission states: *"Because there is no envelope, `PIFLEET_TASK_ID` is EMPTY in the container.
Every row in the audit ledger reads `task_id: "<none>"`."*

The observation is right and the causal chain is not. **`PIFLEET_TASK_ID` is set nowhere in `src/`,
for any worker, in any mode, deliberately** — and a standing test asserts that it stays that way.
`test/support/isa-claims.ts:1446-1456` runs `grep -rnF PIFLEET_TASK_ID src/` and requires **zero**
hits, described there as *"a REGRESSION GUARD"*. The variable was retired by ISC-362.
`src/run/task-policy.ts:11-25` gives the two reasons, and both are about `rpc` workers rather than
`tui` ones:

> "1. **It is fixed at launch and the value is not.** A worker container is long-lived and takes many
> epochs over its life… 2. **The worker controls it.** … A process that can `export PIFLEET_TASK_ID`
> can forge the provenance on its own audit rows."

Its replacement is `/policy/task` — a two-line file (line 1 task id, line 2 epoch), bind-mounted
`:ro` at mode `0444`, rewritten **in place** by the supervisor at each dispatch. So the empty
variable is not the defect and restoring it is not the fix; **the fix is that the file was never
written for this worker.** That correction makes the problem smaller than commissioned and the
remedy more available, because the carrier already exists, is already mounted, and is already
integrity-checked by `docker/verbgate:120-127`.

**A second correction, smaller.** The commission says `dispatch` "ALREADY WORKS" at a backend-managed
`tui` worker. It types, and it records — but §2.3 and §2.4 find two things it does not do, and one of
them means the ledger for that worker is misattributed for the life of the run. "Works" is doing more
work in that sentence than the code supports.

### 0.6 What reading the code found

Three defects, all latent, all reachable today, none of which needs this feature to exist in order to
be wrong. They are stated up front because each changes what a section downstream may assume.

| # | Defect | Reachable today? | § |
|---|---|---|---|
| **A** | `sendViaPane` never calls `writeTaskPolicy`, so a **backend-managed** `tui` worker — the path ISC-380 closed and the commission calls working — runs its whole life with `/policy/task` reading `<none>`/`0`. Every gated cloud verb it executes is ledgered against no task. This is ISC-360's finding, in a route written after ISC-360 closed it. | Yes — any `cmux`/`tmux` `tui` worker that runs a gated verb | §2.3 |
| **B** | The supervisor's `tui` transcript poll settles a turn only when `em.live !== null` (`src/supervisor/index.ts:2086-2091`). `em.allocate` has exactly **one** call site (`:2191`), inside the RPC dispatch handler, which refuses `tui` workers at `:2162` before reaching it. So `em.live` is null on every poll of every `tui` worker, and **`classifyTuiTurn` and the verdict chain beneath it cannot run in production at all.** The poll's only live effect is `transcript_activity`. | Yes — every `tui` worker, both routes | §2.4 |
| **C** | `skills/pifleet-worker/SKILL.md:44-48` tells a worker to read its task id off the `#` heading of its prompt. That binding holds only while `title` defaults to `taskId` (`src/cli/commands/dispatch.ts:643`). An operator who supplies a human-readable title silently removes the documented route; the fenced `## This task` block (`src/supervisor/index.ts:2767-2778`) is the actual carrier and the skill does not mention it. | Yes — any dispatch with an explicit `title` | §2.5 |

**And one finding that reframes the whole document.** The mechanism this feature needs is already
built, already mounted into the container it needs to reach, already read-only to the worker, and
already inode-stable under in-place rewrite. `src/config/render.ts:374` pushes
`-v <taskPolicy>:/policy/task:ro` **unconditionally**, for every worker including an adopted-terminal
one. What is missing is not a channel. What is missing is (a) anything that writes it on this route
and (b) any worker-facing document that mentions it — `grep -rn "/policy/task" skills/ roles/`
returns nothing. **This document is therefore not asking for a new plane. It is asking for the
existing one to be used on a route that skipped it.**

---

## 1. Problem statement

### 1.1 The refusal, exactly

`src/cli/commands/dispatch.ts:446-471`. `sendViaPane` reads the worker's presentation record and
refuses on `presentation.backend === "headless" || presentation.surface_ref === null`. The
`adopted_terminal` flag selects which of two sentences is thrown; both are `EXIT.BACKEND_UNAVAILABLE`:

```
worker <w> is pane_mode: tui with an ADOPTED terminal — its pane is the terminal that ran
up --attach-here, and pifleet has no surface id to type into. Type the prompt at that
terminal; there is no epoch and nothing to fence, so a dispatch here could not have been
deduplicated anyway.
```

Note that **both clauses of the first branch fire** for an adopted terminal, not just the second: an
adopted run is on the `headless` backend by construction (`adoptRefusal` returns `backend_owns_panes`
for anything else — `src/attended/adopt.ts:107-113`), so `presentation.backend` is `"headless"` and
the guard would refuse even if `surface_ref` were populated. §6.6 and D3 depend on that.

### 1.2 What already works, and why this is not it

A `pane_mode: tui` worker on a **backend-managed** surface (`cmux` or `tmux`) is dispatched by typing.
`sendViaPane` builds a keystroke plan with `paneKeystrokes` (`dispatch.ts:309-365`) — one `sendText`
per line, `shift+enter` between lines, `enter` to submit — and drives it through
`backend.sendText`/`backend.sendKey`. `test/integration/tui-dispatch-pane.test.ts` exercises it
against the real tmux backend with a fake `tmux` on `PATH`; `ISA.md` ISC-380 records it closed.

That path is not available here, and the reason is structural rather than incidental: **there is no
backend.** The run's backend is `headless`, whose driver creates no panes and has no `sendText`, and
the surface the operator is looking at was made by a program pifleet is not talking to.

### 1.3 The measured cost — the operations console, 2026-09-02

Reported by the operator, and mapped here against what the code independently explains. The standing
console (`scripts/operations`) brings up `obs-1` (observer) and `tick-1` (ticketing), both
`pane_mode: tui`, each through its own `up --attach-here`
(`src/backends/cmux/operations-plan.ts:96`, `:333`, `:357`).

| # | Reported | Explained by |
|---|---|---|
| 1 | `dispatch --worker tick-1 --task <file>` refused; work was typed in by hand, driving `cmux send`/`send-key` against surface ids read from `list-panes`' `selected_surface_id` | §1.1 verbatim. **And note what the workaround proves: the surface id was obtainable, and typing into it worked.** That is the whole of disposition (1), performed by hand. §4.3 is why it should not be automated. |
| 2 | `PIFLEET_TASK_ID` empty in the container; every ledger row reads `task_id: "<none>"` | **Half explained, and the half that is wrong matters.** The variable is empty in *every* container (§0.5). The `<none>` rows are explained exactly: `/policy/task` is written `(null, 0)` at materialize (`src/run/materialize.ts:879`) and rewritten only at RPC dispatch (`src/supervisor/index.ts:2216`), so an adopted-terminal worker reads `TASK_POLICY_NONE` (`src/run/task-policy.ts:53`) for its whole life. `docker/verbgate:49-62` renders that into every audit row. |
| 3 | `/outbox/<task-id>/files/` had no resolvable path; the worker tried to invent an id and gave up; `/outbox` held only the fleet-written `ledger/verbgate.jsonl` | Explained twice over. The worker's only documented route to the id is its prompt (`skills/pifleet-worker/SKILL.md:16`, `:28-31`, `:44-48`), and on this route pifleet sends no prompt. And nothing pre-creates `<outbox>/<task-id>` — `materialize.ts:781-784` creates only the worker-level directory — so it is not discoverable by listing. The `ledger/` directory is verbgate's own `mkdir -p`, which is why it was the only thing there. |
| 4 | No epoch, so nothing fences a re-dispatch; a repeated watch pass would run the same task twice — which is why `fleet.yaml` keeps the observer **role** at `pane_mode: rpc` and overrides only `obs-1` | Explained, and stated in three places already: `src/attended/voided.ts:141-145` (ISC-85), `Docs/SRD.md` §3.5's voided table, and `fleet.example.yaml:480-491`, which spells out the same reasoning for the same worker. |

**A fifth consequence the report does not name, and it is the one that makes this more than a
convenience.** The harvest's notion of "what was dispatched" is the inbox directory —
`dispatchedTaskIds` reads `<run>/inbox/*.json` (`src/harvest/layout.ts:112-123`) and it is the single
source shared with `harvestAll`. With no dispatch there is no inbox record, so the dispatched set is
empty, `unexplainedOutboxDirs` returns nothing (`layout.ts:198`), and **a worker that had written a
correctly-named artifact directory would still have been reported on by nobody.** The absence was not
just unharvested; it was unnoticeable. That is the failure shape `harvest/layout.ts:19-24` was written
against — *"a mechanism that is present, tested and invoked, running over an empty input, publishing
a clean result"* — arriving one layer further up than that module can see.

### 1.4 Success in one sentence

An operator at an adopted terminal can run `pifleet dispatch --worker obs-1 --task t.json`, press one
key, and afterwards `pifleet artifacts` returns that worker's output under the id the dispatch
named — with a re-run of the same task file refused rather than run twice.

---

## 2. The current state, read from the code

> Every claim below carries a file and a line. **Read on 2026-09-02, not executed.** §0.4 states what
> that is worth and what it is not.

### 2.1 Two routes, one refusal, and where the fork is

`planDispatch` decides the route from the worker's launch record; `sendTaskEnvelope` executes it
(`src/cli/commands/dispatch.ts:677`). The `pane` arm is `sendViaPane` (`:429`), which refuses at
`:446`. The `rpc` arm is `controlCall {cmd: "dispatch"}` (`:706-711`) into the supervisor, whose
handler refuses a `tui` worker at `src/supervisor/index.ts:2162-2168` with
`pane_mode_tui_has_no_rpc_dispatch` — deliberately **before** `em.allocate`, so nothing is burned
(`:2150-2155`).

So a `tui` worker is refused by the supervisor and served by the CLI, and an **adopted** `tui` worker
is refused by both. There is no third path.

### 2.2 What `--attach-here` records, and what it declines to record

`src/cli/commands/up.ts:2119-2143` writes the presentation record with `surface_ref: pane.id` — which
on the headless backend is `null` — and `adopted_terminal: attachHere && tuiWorkers.includes(workerId)`.
The comment at `:2136-2142` states the position this document is asking to revisit:

> "`surface_ref` stays null and is not an oversight: there is no id a later process could send bytes
> to. `dispatch` reads exactly that and refuses, which is correct for this mode — the person holding
> the terminal is the dispatcher."

`src/contracts.ts:809-816` says the same from the schema's side. §3.1 shows the first sentence is
false as a statement about knowability and true as a statement about **durable** knowability, and §4.3
argues the difference is the whole safety case.

The attach itself is `adoptedAttachArgv` (`src/attended/adopt.ts:56-62`) — a bare
`docker attach --detach-keys=ctrl-] <container>` — spawned at `up.ts:2568` with the parent awaiting
`child.exited`. **The child's pid is available at that call site and is recorded nowhere.** D9 turns
on that.

### 2.3 Defect A — the pane route never writes the provenance file

`writeTaskPolicy` has exactly three call sites in `src/`:

| Site | Value written |
|---|---|
| `src/run/materialize.ts:879` | `(null, 0)` — creates the inode the bind mount pins |
| `src/supervisor/index.ts:2216` | `(envelope.task_id, decision.epoch)` — per RPC dispatch |
| `src/supervisor/index.ts:1046` | `(null, 0)` — at settle |

`sendViaPane` is not among them. So on the **working** `tui` route — the one ISC-380 closed and the
commission describes as already working — the worker receives a correct rendered prompt carrying its
task id, writes its artifacts to the right directory, and every gated `gcloud`/`kubectl`/`helm`/`bq`
verb it runs is stamped `{"task_id":"<none>","epoch":0}` in `/outbox/ledger/verbgate.jsonl` and in the
host-collected copy at `<run>/audit/<worker>.jsonl` (`src/run/paths.ts:205`, `:589-592`).

That is ISC-360's finding exactly, in a route written after ISC-360 closed it, and it is invisible for
the reason ISC-360 was invisible: the ledger is present, well-formed, and wrong in one field.

`src/supervisor/index.ts:2207-2215` states why the ordering matters and it applies unchanged here:

> "Provenance BEFORE the prompt… the worker can invoke a gated verb the instant it is prompted, and a
> verb classified before this write would be ledgered against the PREVIOUS task."

On the pane route there is no "previous task" to be ledgered against — every task is `<none>` — which
is a different wrongness and not a smaller one: an investigator reading that ledger cannot separate
"a person typed this by hand" from "the agent did it under task T".

### 2.4 Defect B — the `tui` settle path cannot run

`src/supervisor/index.ts:1930-2091` is the `tui` transcript poll. Its structure:

1. poll the transcript reader, update `transcript_activity` (`:2013-2019`) — **above** the epoch
   guard, and the docblock at `:1982-1993` says that placement is deliberate and is the whole of the
   fix ISC-added on 2026-09-01;
2. `const live = em.live;` at `:2086`;
3. `if (live === null) { … return; }` at `:2087-2091`;
4. everything below — baseline capture, `classifyTuiTurn`, `TUI_QUIET_MS`, the verdict precedence
   chain at `:2100-2085ff` — runs only past that return.

`em.allocate` is called once in `src/` (`:2191`), inside the RPC dispatch handler, which refuses
`tui` workers 29 lines earlier. `sendViaPane` does not reach the supervisor at all. **Therefore
`em.live` is null on every poll of every `tui` worker and steps 3-4 never execute in production.**

Consequences that follow, none of which is stated anywhere as a limitation:

- No task record is ever written for a `tui` worker, so `pifleet wait` — *"entirely file-driven — task
  records written by supervisors"* (`src/cli/commands/wait.ts:36`) — can only time out. The `--auto`
  refusal docblock (`dispatch.ts:1060-1073`) says exactly this and treats it as a property of the
  scheduler; it is a property of the whole mode.
- `Docs/SRD.md` §3.5's row *"Completion is transcript-derived"* and `voided.ts:151-155` (ISC-87)
  describe a mechanism that is built, tested at the unit level, wired into a live poll, and
  unreachable. That is the same shape as `harvest/layout.ts`'s header describes and as ISC-333 and
  ISC-231 record.

**This is the defect that makes §6's epoch decision cheap rather than expensive.** The settle path is
not missing; it is waiting for an allocator.

### 2.5 The identity plane exists, and no worker-facing document mentions it

`/policy/task` is mounted for every worker at `src/config/render.ts:374`, unconditionally, with the
comment at `:370-373` stating the integrity rule. `src/run/task-policy.ts:91-116` rewrites it
chmod-0644 → truncate-in-place → chmod-0444, never rename, because *"a bind mount pins the INODE"*
(`:31-41`). `docker/verbgate:120-127` refuses to run if either policy file is writable by the worker.

`grep -rn "/policy/task" skills/ roles/` returns nothing. The mount was built for the **gate**, and
`src/supervisor/index.ts:2720-2722` says so:

> "ISC-362 fixed that for the verbgate's LEDGER by mounting a file the GATE reads, which is not a
> route to the agent."

So the agent's only route to its own task id is `renderPrompt`'s fenced block
(`src/supervisor/index.ts:2767-2778`) — and Defect C means the skill points at the `#` heading
instead, which is a weaker binding than the block it should point at.

### 2.6 The harvest keys on the inbox, and the inbox is not reachable from a container

`<run>/inbox/` is created at `src/cli/commands/up.ts:795` and read only by host code. It is
deliberately excluded from the container's mount table — `src/config/render.ts:452-459` names it and
`assertNoRunDirMount(argv, opts.run.root)` at `:460` enforces the exclusion on the finished argv.

That matters for §6 in two directions. It is why the inbox record is a **host** fact a staged dispatch
can write freely; and it is why the drop file §6.2 proposes has to be a **new mount** rather than a
pointer into the inbox.

### 2.7 What the operator's workaround actually demonstrated

The hand-driven `cmux send`/`send-key` against a `selected_surface_id` succeeded. That is the strongest
available evidence that disposition (1) is mechanically available — stronger than anything in this
document, because it ran. §4.3 is the argument that it should nonetheless not be built, and it is an
argument about the times it would **not** be run by a person watching the pane.

---

## 3. What is knowable about an adopted terminal

### 3.1 Knowable, and the repo already relies on it: the cmux surface id

`Docs/SRD.md:285`, from the Phase 0 interface verification that was executed against the installed
binaries:

> "`CMUX_SOCKET_PASSWORD` is *protected from override* by workspace env — which is **not** the same as
> being *provided*. It is **not** injected into panes. Only `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`
> are, as **UUIDs, not refs**."

And `src/cli/commands/doctor.ts:532` already reads them:

```ts
const insidePane = env["CMUX_WORKSPACE_ID"] !== undefined || env["CMUX_SURFACE_ID"] !== undefined;
```

So a `pifleet up --attach-here` running inside a cmux pane — which is precisely how the operations
console invokes it (`src/backends/cmux/operations-plan.ts:290-293`) — **can read its own surface id out
of its own environment.** It is not a guess and it is not a scrape. It is the same fact `doctor` uses
to decide whether the cmux socket is reachable.

Two qualifications, both material:

- The ids are **UUIDs, not refs**, and `src/backends/cmux/parse.ts:11` exists to normalize cmux's two
  spellings. A recorded id would need to enter the control plane through that parser, not around it.
- The id names **the operator's pane**, not a pane pifleet created. Nothing about holding it makes the
  pane pifleet's.

### 3.2 Inferred, not read: tmux

tmux sets `TMUX` and `TMUX_PANE` in the environment of processes it starts. **No code in this
repository reads either** — `grep -rn "TMUX_PANE" src/ test/` returns nothing — so this document has
no in-repo evidence for it and does not rely on it. It is recorded because a reader will ask, and
because §5.2 declines it explicitly rather than by omission.

### 3.3 Not knowable: a bare terminal

`up --attach-here` requires only that stdin and stdout are TTYs (`src/attended/adopt.ts:114-115`). A
run started from Terminal.app, iTerm, or an ssh session passes that check and yields no surface id at
all. The only handle is a tty device path, and **writing to a tty is output, not input** — bytes
written there paint the screen; they are not delivered to the foreground process's read. There is no
supported host-side way to inject them (`TIOCSTI` is privileged and is disabled by default on current
Linux kernels; this is general knowledge, not a repo fact, and nothing here depends on it).

So disposition (1) is not a design for adopted terminals. It is a design for adopted terminals **that
happen to be cmux panes**, with a silent second-class case for every other terminal an operator might
use. That asymmetry is D2's second argument.

### 3.4 Not knowable: whether a person is typing

Nothing in this repository observes the pty. The container is launched `docker run -d -i -t`
(`src/supervisor/tui.ts:44-58`) and the supervisor's child — the `docker run` CLI — exits seconds
later (`src/supervisor/index.ts:1099-1107`). The supervisor holds none of the worker's three streams;
`src/supervisor/tui.ts:1-30` opens by saying so.

The closest available signal is `transcript_activity`
(`src/contracts.ts:344-348`, written at `src/supervisor/index.ts:2013-2019`), which records the
session file's entry count and when it last grew. It detects **the agent writing**, not **the person
typing**, and the gap between those two is exactly the window a mid-keystroke collision lands in: a
person who has typed half a line has produced no transcript entry at all. A busy-refusal built on it
would be green precisely when it needed to be red.

### 3.5 Knowable, and currently discarded: whether the terminal is still the worker's

`up.ts:2568` spawns the attach and awaits its exit. The child's pid is in scope and is thrown away.

The repository already has the right primitive for this and uses it three times: `ProcessIdentity`
is `{pid, started}`, captured from the launcher's own record rather than re-read (`up.ts:2175-2185`,
and the docblock there explains why re-reading is the weaker capture — ISC-191, ISC-272). Recording
`{pid, started}` for the attach child makes "is this terminal still handed to the worker" a checkable
host fact, at the same strength as every other liveness claim the fleet makes.

**What it does not tell you** is whether the person detached and re-attached from somewhere else, or
whether a second `docker attach` is also live. Docker does not report attached clients through
`inspect`; this document found no host-side enumeration and did not look for one beyond the code.
§9 Q2 holds it.

---

## 4. The principle this bumps into

### 4.1 What `pane_mode: tui` was granted, and on what terms

`Docs/SRD.md` §3.5 grants the exception and then spends a table and four errata bounding it.
`src/attended/voided.ts:124-181` is that table in code: ten rows, each naming an ISC and the sentence
the mode gives up, *"true from the moment `up` creates the container. Nobody has to type anything."*

The grant's terms are worth restating because §6 has to stay inside them:

- the pane is pifleet's, created by a backend pifleet drives;
- the mode is **attended by construction** — `voided.ts:161-165` (ISC-111) says a dialog blocks until
  a person answers it, *"acceptable only because the mode is attended by construction"*;
- and the mode is degraded **in writing**, per run, per criterion.

### 4.2 Adoption inverts the ownership, and §3.5 says so

ERRATUM 4 (`Docs/SRD.md:243-252`) is the record:

> "**a pane exists, cmux made it, and pifleet is not the one that made it** … **It buys pifleet nothing
> it did not have** — `surface_ref` stays `null`, so `dispatch` still refuses the worker, and that
> refusal is correct rather than a gap: **the person holding the terminal is the dispatcher.**"

This document accepts every clause of that except the last. "The person is the dispatcher" conflates
two roles that the rest of the system keeps apart everywhere else: who **authors** the work, and who
**delivers** it. `pifleet steer` already occupies exactly that seam — a human's words entering a
worker through a route the fleet records — and it does not conclude from a person's authorship that
the fleet should stop recording. §6 asks for the same separation here.

### 4.3 The argument that decides it: detach is one keypress and pifleet cannot see it

Suppose disposition (1). `up --attach-here` records `CMUX_SURFACE_ID` and a new field naming cmux as
the surface's owner; `dispatch` types the plan into it.

The operator presses `ctrl-]`. `docker attach --detach-keys=ctrl-]` returns; `up` prints its detach
notice and exits (`up.ts:2578-2590`). **The pane is now a shell**, in the run directory, and
`presentation.json` still names the surface with `adopted_terminal: true`.

A dispatch now runs `paneKeystrokes` against that surface. The plan is one `sendText` per line of a
rendered markdown prompt, `shift+enter` between lines, `enter` at the end
(`dispatch.ts:309-326`). In a shell, `shift+enter` is not a composer newline; the lines are handed to
the shell and executed. A brief containing a fenced command block — which is what a brief for an
`sre` or `ticketing` role routinely contains — becomes a sequence of shell commands run as the
operator, on the host, outside every containment boundary §12 of `Docs/SRD.md` exists to build.

Three things make this worse than a normal race:

1. **It is not detectable after the fact from pifleet's side.** The ledger would record
   `dispatched via: pane, steps: 29` and nothing else. The commands ran on the host; no verbgate saw
   them; no audit row exists.
2. **`paneKeystrokes` is all-or-nothing about *typeability*, not about *destination*.**
   `dispatch.ts:281-291` argues the plan is built completely before any of it is executed so that a
   refusal is meaningful — and every one of those checks passes here. The bytes are perfectly
   typeable. They are going to the wrong reader.
3. **The failure is silent in the direction this repository keeps closing.** `cmux send` exits 0. So
   does the shell.

This is not a hazard that a `--force` flag or a warning banner answers, because the hazard is that
nobody is looking. And §3.5 of `Docs/SRD.md` already establishes that the mode's protections rest on
somebody looking — which is true while a person is attached and stops being true at the moment the
mechanism most needs it.

**Could it be guarded?** Partly, by §3.5's `(pid, started)` liveness check, which would catch the
common case of a clean detach. It would not catch a re-attach from a different terminal, a pane
respawned onto a different program, or a cmux workspace rebuilt under the same surface id. Each of
those is a guard whose evidence is weaker than the harm it is guarding.

### 4.4 The shape of the exception this document asks for instead

None. §6 asks for no widening of Decision 1 at all: **pifleet writes zero bytes to any terminal on
this route.** The exception `pane_mode: tui` already holds — the pane is the channel for a pane
pifleet owns — is left exactly as wide as it is. What changes is that the *other* half of a dispatch,
the half that was never a keystroke, stops being routed through the half that was.

---

## 5. Scope and non-goals

### 5.1 In scope

- `pifleet dispatch --worker <w>` at a `pane_mode: tui` worker whose `presentation.adopted_terminal`
  is `true` — staged rather than refused (§6.1).
- Delivery of task id, epoch and outbox path into that worker through the existing read-only policy
  plane plus one new sibling mount (§6.2).
- Epoch allocation for a staged dispatch, and the deduplication that follows (§6.3).
- What `wait`, `artifacts`, `report` and `status` say about a staged task before and after it is
  triggered (§6.5).
- Defect A (§2.3) and Defect C (§2.5) as prerequisites, in their own change (D11, D14).
- The `tui` voided table's rows for ISC-84, ISC-85 and ISC-87 (§7.2).

### 5.2 Non-goals

- **Typing into an adopted terminal, by any mechanism.** Includes the cmux-surface route (§3.1),
  a second `docker attach` fed from a pipe, and anything reached through a tty device. D2, D8.
- **tmux-hosted adopted terminals as a distinct case** (§3.2). Nothing here reads `TMUX_PANE` and
  nothing should start.
- **Reading pane text**, for any purpose, ever. `Docs/SRD.md` §0.2 Decision 1.
- **Making the `tui` mode equivalent to `rpc`.** `get_session_stats` (ISC-115),
  `extension_ui_request` answering (ISC-111), abort-as-turn-interrupt (ISC-81) and stream-offset
  attribution (ISC-141) stay voided and stay in the table.
- **More than one adopted terminal per run.** `adoptRefusal` permits exactly one
  (`src/attended/adopt.ts:104-106`) and that stays.
- **`dispatch --auto` scheduling adopted-terminal workers.** D13.

### 5.3 Deliberately deferred

- **Auto-triggering a staged task on the operator's behalf** — the one design that would close the
  loop without a human. It is deferred rather than refused because §4.3's argument is about *typing
  into a surface*, and there may be a container-side trigger that does not touch the surface at all.
  §9 Q4 states the probe.
- **A staged-task queue.** §6.1 permits exactly one pending staged task per worker; a second is
  refused. Queueing is a scheduler feature and this worker is not schedulable (D13).
- **Backporting the epoch to the backend-managed `tui` route.** D6 gives the adopted route an epoch
  through a new supervisor verb; the same verb would serve the `cmux`/`tmux` route and close ISC-84
  and ISC-85 for it too. That is a strictly larger change and §8 D6 records the trade rather than
  taking it.

---

## 6. The design — a staged dispatch

### 6.1 `dispatch` stages instead of refusing

`sendViaPane`'s adopted-terminal branch (`dispatch.ts:455-464`) is replaced by a third route,
`stageForAdoptedTerminal`, selected on `presentation.adopted_terminal === true`. It performs, in this
order — and the order is the correctness argument, borrowed verbatim from
`src/supervisor/index.ts:2207-2215`:

1. **Refuse if the terminal is gone.** §6.6.
2. **Allocate an epoch** through the supervisor (§6.3). A second stage while one is pending is refused
   `busy` by the allocator itself (`src/rpc/epoch.ts:183-185`) — this step needs no check of its own,
   and adding one would be a second spelling of a fact the allocator already owns.
3. **Persist the fence** before anything else is written, exactly as the RPC route does
   (`src/supervisor/index.ts:2208`). The write is fail-stop for the reason it already is there: a
   supervisor that cannot persist its high-water mark must stop allocating
   (`src/supervisor/index.ts:666-681`).
4. **Write `/policy/task`** with `(task_id, epoch)` — the provenance, before the worker can run a
   gated verb under it.
5. **Write the task drop** (§6.2) with the rendered prompt and the identity block.
6. **Write the inbox record** `<run>/inbox/<task-id>.json` with the **real** epoch, so
   `dispatchedTaskIds` sees it and the harvest's staleness check correlates.
7. **Append `dispatched`** to the ledger with `via: "staged"` and the epoch present.
8. **Print the trigger line** — one line naming what the operator should type.

Nothing in steps 1-8 touches a terminal, a backend, or a pty.

The order of 3, 4 and 5 is the RPC route's order and is load-bearing for its reason
(`src/supervisor/index.ts:2206-2215`): the fence must be durable before anything can act under the
epoch, and the provenance must be written before the worker can run a gated verb under it. On this
route the gap between the write and the act is a human's reaction time rather than a few
milliseconds, which makes the ordering easier to get right and much more expensive to get wrong.

### 6.2 The task drop — a second read-only mount, not an extension of `/policy/task`

`/policy/task` cannot carry the prompt. It is parsed by POSIX `sh` with `sed -n 1p` / `sed -n 2p`
(`docker/verbgate:57-60`), and `src/run/task-policy.ts:70-73` records that the two-line shape is
chosen *because* of that parser. A third line would be inert today and a hazard the first time
anything grows a loop.

So: a sibling, `/policy/dispatch`, mounted `:ro` at mode `0444` by the same rule and rewritten by the
same in-place recipe. Contents: the JSON envelope plus the `renderPrompt` output, so the worker reads
exactly the document the other two routes deliver.

Three properties this inherits for free, and they are why it is a sibling rather than a new mechanism:

- **Worker-unwritable.** `docker/verbgate:120-127` already iterates the policy files and exits 78 if
  either is writable; the loop gains one path.
- **Inode-stable.** The chmod → truncate-in-place → chmod recipe (`task-policy.ts:91-116`) is the one
  the bind mount requires.
- **Not the run directory.** `assertNoRunDirMount` (`config/render.ts:460`) stays satisfied because
  the file lives beside `taskPolicy` in the worker's own directory, which is already how
  `/policy/cloud-allow` and `/policy/task` are placed (`src/run/paths.ts:508-511`).

**The worker has to be told it exists.** `skills/pifleet-worker/SKILL.md` gains a row in its mount
table and a sentence in `## Before you stop`, and — Defect C — its `<task-id>` instruction is
repointed from the `#` heading to the fenced `## This task` block, with `/policy/dispatch` as the
second source. D14.

### 6.3 The epoch — recoverable, and what it can and cannot fence

**It is recoverable, and §2.4 is why it is cheap.** The allocator is `EpochManager` and it lives in
the supervisor, which is alive for a `tui` worker: it holds `em`, persists `fence.json`, flushes
state, and polls the transcript. What it lacks is an RPC client to Pi — and allocation does not need
one. The refusal at `src/supervisor/index.ts:2162` is spelled `if (client === null)` rather than
`if (tuiMode)`, and its docblock explains that the spelling is what narrows `client` for the `send`
below (`:2163-2167`). **The refusal is about delivery, not about allocation**, and it currently
conflates them because on that route they were the same act.

Design: a new control verb `stage`, handled beside `dispatch`, which allocates, persists the fence,
writes both policy files, and returns the epoch — and does **not** send a prompt, because there is
nothing to send it on. `dispatch`'s own refusal for `client === null` stays exactly as it is.

**What the epoch then fences, honestly — and the dedup key is not the one ISC-85 names:**

`src/attended/voided.ts:141-144` says *"there is no `(worker, task_id, epoch)` to recognise, so
`already_completed` can never be returned"*. That sentence names the wrong key. Dedup is on
`(task_id, attempt_id)` — `attemptKey` at `src/rpc/epoch.ts:298-300` — and the answer is a **replay of
the stored epoch**, not `already_completed`:

```
const prior = this.#s.attempts[key];
if (prior !== undefined) return { ok: true, epoch: prior, replayed: true };
```

`src/rpc/epoch.ts:35-39` explains why replay rather than refusal: *"Timeout → retry → the first
dispatch actually landed: returning `already_completed` would leave the caller unable to distinguish
'someone else did it' from 'I did it and lost the ack'."* `already_completed` is the arm for a
**different** attempt against a settled `task_id` (`:178-181`). **ISC-85's wording should be corrected
when its row is re-taken (§7.2), independently of this design.**

| Fenced | Because |
|---|---|
| Re-dispatch of the same `(task_id, attempt_id)` | `EpochManager.allocate` is the same allocator and `attempts` is durable in `fence.json` (`src/rpc/epoch.ts:118`), so the replay survives a supervisor restart. `--auto` already relies on this with a deterministic `attempt_id` (`dispatch.ts:1110-1113`), and a staged dispatch would need the same determinism to benefit. **This is item 4 of §1.3 closed — for a repeated dispatch of the same attempt, which is exactly the observer-watch shape `fleet.example.yaml:485-490` describes.** |
| A second attempt against a settled task | `already_completed` (`src/rpc/epoch.ts:178-181`). |
| The harvest's envelope correlation | `src/harvest/outbox.ts:493-495` refuses a result whose envelope epoch differs from the inbox record's. With a real epoch in both places, that check becomes non-vacuous for this route instead of **passing vacuously at 0 on both sides**, which is what it does today. |
| The settle path in §2.4 | `em.live !== null` becomes reachable, so `classifyTuiTurn` runs, a task record is written, and `pifleet wait` can settle rather than time out. **Defect B closes as a consequence rather than as a separate fix.** |

**A fifth thing it fences that this design did not ask for, and it is why §6.1 needs no second-stage
check of its own:** `allocate` refuses with `busy` while an epoch is live (`src/rpc/epoch.ts:183-185`),
because *"at most one unsettled epoch is what makes seq attribution unambiguous"*. A staged task
therefore blocks a second stage by mechanism. §8 D6 records what that costs.

**What it does not fence, and this stays in the voided table:**

- **Stream-offset attribution (ISC-141).** `voided.ts:176-180` is unchanged and its reason is
  unchanged: *"there is no RPC stream, so there are no offsets and no fence post."* An epoch that
  orders dispatches cannot order a person's keystrokes against them, because the keystrokes have no
  position.
- **The ack (ISC-86).** Weaker here than on the pane route, not stronger: `via: "pane"` at least
  proved bytes reached a pty. `via: "staged"` proves a file was written. Neither proves Pi read
  anything, and the staged route must say so in the same sentence the pane route does.

### 6.4 The trigger, and who presses it

The operator. `dispatch` prints one line — the shape of it is a UX decision, not a requirement — and
the person presses a key in the terminal they are already looking at.

**The alternative rejected: stage the task and tell the agent to poll for it.** A role prompt saying
"check `/policy/dispatch` at the start of every turn" only fires when a turn starts, and a turn starts
on a keystroke, so it buys nothing and adds a behaviour that will be silently disobeyed
(`src/supervisor/index.ts:2750-2765` records the live chain going `complete → partial` the last time
an imperative was added to a prompt for this class of reason).

**What the trigger is not:** it is not a second dispatch. The staged record is complete before the
operator touches anything, so a task typed and then never triggered is a **recorded, reportable**
state rather than an absence — which is the fifth consequence in §1.3 closed.

### 6.5 What the rest of the fleet says about a staged task

| Command | Behaviour |
|---|---|
| `status` | the worker's `phase` stays `idle` until the epoch goes live, which is correct and is exactly what `WorkerStateSchema.transcript_activity`'s docblock argues for; the staged task id is a new field beside it, not a widening of `phase` |
| `wait` | can settle for the first time on this route, because §6.3 makes a task record possible. Until the operator triggers, the task is `staged` and `wait` must distinguish that from `running` — a `wait` that blocks on a key nobody pressed is the hang this whole design exists to avoid, so a staged-and-untriggered task returns a named non-zero rather than consuming the timeout |
| `artifacts` / `harvest` | unchanged. The inbox record exists, so `dispatchedTaskIds` sees the id, `readResultEnvelope` looks in the right directory, and `unexplainedOutboxDirs` can name a misfiled one. **This is item 3 of §1.3 closed, and it closes on the existing machinery with no harvest change at all.** |
| `report` | gains a line for staged-but-untriggered tasks. The `tui` voided table it already prints (`src/report/render.ts:109-112`) gains and loses the rows §7.2 lists |
| `dispatch --auto` | unchanged: still refuses, D13 |

### 6.6 The refusals that stay, and the one that is added

- **Staging refuses when the adopted terminal is gone.** `up --attach-here` records the attach child's
  `{pid, started}` in the presentation record (§3.5); staging checks it with the same
  `processStartTime` comparison the registry and the lease already use (ISC-144). A dead attach means
  the worker has no reader, and a staged task nobody can trigger is worth refusing loudly rather than
  leaving to be discovered. The refusal names the fact and the remedy: `up --attach-here` to come back.
- **Staging refuses a second pending task.** §6.1 step 2.
- **`dispatch` still refuses a `tui` worker on `headless` with `adopted_terminal: false`.** That is the
  original sentence for the original case — a headless run with no pane at all — and it is untouched.
- **The supervisor still refuses `cmd: "dispatch"` for `client === null`.** §6.3.

---

## 7. What this costs

### 7.1 Unchanged

Decision 1. The mount table's exclusions. The verbgate's integrity check (widened by one path, not
weakened). `adoptRefusal`'s four preconditions. The one-tui-worker-per-run rule. Every criterion in
the `attended` (non-`tui`) voided table. `--auto`'s refusal.

### 7.2 The `tui` voided table changes, in both directions

`src/attended/voided.ts`'s `PANE_MODE_TUI_VOIDED` is printed to the operator at entry and carried in
`attended.json` for the life of the run. Under this design three rows change and **the table must be
re-derived per route rather than per mode**, which is itself a cost: today one list describes every
`tui` worker, and after this there are two shapes of `tui` worker with different guarantees.

| Row | Today | After |
|---|---|---|
| **ISC-84** (no epoch allocated) | *"No epoch is allocated at all… every diff in the run belongs to one undifferentiated placeholder epoch 0."* | **False for a staged dispatch.** True for a hand-typed turn, which is most of what happens at this seat. The row must say which. |
| **ISC-85** (runs twice) | *"With no epoch there is no `(worker, task_id, epoch)` to recognise, so `already_completed` can never be returned…"* | **Closed for a staged dispatch of the same attempt**, and **the row's stated key is wrong today** — dedup is `(task_id, attempt_id)` and the answer is a replay, not `already_completed` (§6.3). The correction is owed whether or not this design ships. Still open for a person who types the same brief twice, and nothing can close that. |
| **ISC-87** (transcript-derived completion) | *"coarser by construction"* | **Unchanged in kind and reachable for the first time** — §2.4 means it has never actually run. A row describing a mechanism that has not executed is a claim this document is making weaker before it makes it stronger. |
| **ISC-141** (no fence post) | *"there is no RPC stream, so there are no offsets and no fence post"* | Unchanged. §6.3. |
| **ISC-86** (no ack) | *"`accepted: true` means cmux exited 0"* | Unchanged in force, changed in wording: on the staged route it means a file was written, which is a weaker proof of delivery than bytes reaching a pty. |

**The honest summary of the trade: this design converts a mode that voids ten guarantees into a route
that voids seven and a half, and adds a second table to keep straight.**

### 7.3 What a person can still do that nothing records

Everything they could before. A person at the terminal can type an entirely different brief, ignore
the staged one, run gated verbs interactively — `voided.ts:90` already records that their
`gcloud`/`kubectl` calls *"land in the ledger in the agent's row shape with no author and no task
id"* — and stop mid-turn. Staging narrows none of that, and **the one new hazard it creates is a
semantic collision it cannot detect**: a person who types their own prompt while a staged task is
pending gets work done under a task id that names something else. §6.5's `report` line is the whole of
the mitigation, and a report is a weaker control than a refusal. This is the one place this document
accepts visibility in place of prevention, and it does so because the alternative — refusing to stage
while a person might be typing — is unbuildable for the reason §3.4 gives.

---

## 8. Recorded decisions

Each entry states what was chosen, what was rejected, and what it costs. **Four are put to the owner
as genuinely open: D2, D6, D9 and D12.** The rest follow from them or need no argument.

| # | Decision | Specified in |
|---|---|---|
| **D1** | Split the dispatch: identity through the file plane, trigger through the person | §0.1, §4.4, §6.1 |
| **D2** | **OPEN** — do not record a surface id for an adopted terminal, even though one is knowable | §3.1, §4.3 |
| **D3** | `presentation.backend` is not widened to name a surface's owner | §1.1, below |
| **D4** | The task drop is a new `:ro` sibling mount, not a third line in `/policy/task` | §6.2 |
| **D5** | The staged prompt is `renderPrompt`'s output, from the same renderer, unabbreviated | §6.2, below |
| **D6** | **OPEN** — allocate a real epoch for a staged dispatch, via a new supervisor `stage` verb | §6.3 |
| **D7** | Fencing claims exactly what it covers; ISC-141 and ISC-86 stay voided | §6.3, §7.2 |
| **D8** | pifleet writes zero bytes to any terminal on this route | §4.4, §5.2 |
| **D9** | **OPEN** — record the attach child's `{pid, started}` and refuse staging when it is dead | §3.5, §6.6 |
| **D10** | No refusal-while-a-person-is-typing; the collision is made visible instead | §3.4, §7.3 |
| **D11** | Defect A (`/policy/task` on the pane route) is a prerequisite, fixed in its own change | §2.3 |
| **D12** | **OPEN** — Defect B closes as a consequence of D6, and is not separately repaired | §2.4 |
| **D13** | `--auto` still refuses an adopted-terminal worker | §5.2, §6.5 |
| **D14** | `skills/pifleet-worker/SKILL.md` gains the drop file and is repointed off the `#` heading | §2.5, §6.2 |

### The four that need no argument

**D3 — `presentation.backend` is not widened.** Today it means "the run's active presentation
backend", and §1.1 shows the dispatch guard reads it as "who owns this surface". Those are the same
statement for every run except an adopted one. Splitting the field would be the right repair *if*
disposition (1) were taken; under D2 the second meaning is never needed, and adding a field with no
consumer is how `paneMode` sat unread for a phase (`Docs/SRD.md:150-155` records that).
**The cost: the conflation stays, and a future reader will find it again.** It should be noted in
`contracts.ts` where the field is defined, so the next person finds a sentence rather than a surprise.

**D5 — the same renderer, unabbreviated.** `dispatch.ts:481-488` already argues this for the pane
route: *"a task file must not behave differently depending on who sent it, and a prompt that dropped
the fenced identity block would leave the worker unable to bind `<task-id>` and `<outbox>` — it would
do the work and write it nowhere the harvest looks."* A staged drop is not a smaller thing than a
typed prompt and must not become one. **The cost: the drop file carries a full brief, so the size cap
`MAX_ENVELOPE_BYTES` reasoning in `harvest/outbox.ts:389-394` has a sibling to think about at the
other end.**

**D11 — Defect A is a prerequisite.** It is a one-line change, it is independently wrong today
(§2.3), and it needs no part of this feature to justify it. It is listed as a decision rather than as
cleanup for the sequencing reason `Docs/SRD-INFERENCE-PROVIDERS.md` D13 gives: **the staged route's
step 5 writes the same file, so shipping the feature without the fix would produce two writers of one
fact with one of them still missing.** Fix it first, in its own change, with its own test.

**D13 — `--auto` still refuses.** `dispatch.ts:1058-1082` refuses to schedule a pane-route worker
because the loop *"could not FINISH one"* — no task record ever appears. D6 removes that specific
obstacle. It does not remove the real one: the scheduler would be waiting on a human keypress, and a
DAG that blocks on a person is a DAG that reports nothing while it blocks. The docblock's rejected
alternative — reporting the worker `busy` from `workerHealth` — is rejected again for the reason it
gives: a task pinned to that worker would then hang invisibly instead of being refused visibly.
**The cost: the console's seat stays outside orchestration, which is what `fleet.example.yaml:480-491`
already assumes when it puts `obs-2` on `rpc` to take the dispatched passes.**

### D1 — split the dispatch

**Chosen: deliver identity through the file plane and leave the trigger with the operator. Rejected:
refusing, which is the status quo; rejected: typing, which is §4.3.**

The refusal's own sentence contains the argument against it: *"there is no epoch and nothing to fence,
so a dispatch here could not have been deduplicated anyway."* That is a conditional presented as a
fact. There is no epoch **because nothing allocates one on this route**, and §6.3 shows the allocator
is present, alive, and one call site away. A refusal that justifies itself with a consequence of
itself is the shape this repository's errata keep finding.

**The cost, stated plainly: a dispatch stops being one act.** `pifleet dispatch` at this worker
returns having done everything except the thing its name implies, and an operator who runs it and
walks away has a staged task that never runs. That is a real regression in the command's meaning, and
the mitigations are all weaker than the property they replace: an explicit `via: "staged"` in the JSON,
a printed trigger line, a `report` row, and — the only one with teeth — `wait` refusing to consume its
timeout on an untriggered task (§6.5).

### D2 — do not record a surface id, even though one is knowable

**OPEN. Recommended: no. Rejected recommendation: record `CMUX_SURFACE_ID` and type into it.**

Recording it is genuinely available. §3.1 shows the environment carries it, `doctor` already reads it,
and §2.7 shows an operator doing the whole thing by hand successfully. If the owner rules the other
way, the work is small — a field in `PresentationSchema`, a read at `up`, and a relaxation of the
guard at `dispatch.ts:446` — and it reuses the whole `paneKeystrokes` path that ISC-380 closed.

**Three arguments against, in descending order of force:**

1. **§4.3.** Detach is one keypress, pifleet cannot see it, and the failure mode is the run's own brief
   executed as shell commands on the host with no audit row. Every guard available for it is weaker
   than the harm.
2. **It is a cmux-only design wearing a general name.** §3.3: an adopted terminal in Terminal.app or
   over ssh yields nothing, so half the mode's users would get a refusal whose sentence says "no
   surface id" while the other half get typing — which is the same *"headless had been standing in for
   no pane exists"* conflation ERRATUM 4 was written about, one level down.
3. **It widens the one exception the founding principle carves out**, and widens it in the direction
   the principle is least able to absorb: a surface with a second, human writer.

**What choosing (2) costs:** the operator loses the thing they actually did by hand on 2026-09-02 —
work arriving in the pane without them typing it. §6 gives them the identity and the fence and hands
the keystroke back. If that trade is unacceptable, D2 is where to say so, and §9 Q4 is the path that
might get the keystroke back without the hazard.

### D4 — a sibling mount, not a third line

**Chosen: `/policy/dispatch`. Rejected: extending `/policy/task`; rejected: a directory the worker
lists.**

`/policy/task`'s two-line shape is load-bearing for a POSIX `sh` parser and is documented as such
(`task-policy.ts:70-73`). A directory would hand the worker a listing to enumerate and would
re-introduce the discoverability the outbox contract deliberately denies (`harvest/layout.ts:26-38`:
*"this module never descends, never opens, never stats a leaf"* — the same posture applies in the
other direction).

**The cost: a third policy file, and a third thing the verbgate's integrity loop must check.** The
loop is already a loop, so this is one array element — but it is one more surface whose read-only-ness
is now load-bearing, and `docker/verbgate:120-127`'s exit-78 is the only thing enforcing it.

### D6 — allocate a real epoch, through a new supervisor verb

**OPEN. Recommended: yes. Rejected: keep epoch `0` and document at-least-once delivery as an accepted
cost.**

The rejected option is what the pane route does today (`dispatch.ts:376-390`), and its reasoning is
sound *for that route*: the placeholder 0 is written consistently into the envelope, the prompt and
the inbox record, so `harvest/outbox.ts:493-495` correlates rather than clamping. Consistency is not
correctness, though — it is the absence of a second error — and the cost is `voided.ts:141-145`
(ISC-85), which the operations console pays for in the one role least able to afford it
(`fleet.example.yaml:485-490` says so in as many words about this exact worker).

**Why a new verb rather than relaxing the existing refusal:** the refusal is spelled
`if (client === null)` precisely so that deleting it fails to compile (`supervisor/index.ts:2163-2167`).
That is a good guard and it should keep working. A `stage` verb allocates, fences and writes without
ever reaching a `send`, so the two concerns stay separate at the type level rather than by comment.

**The cost, and it is the largest single cost in this document: an epoch that fences a dispatch but
not the turn it starts.** The turn starts when a person presses a key, which may be immediately, in
ten minutes, or never. Two consequences follow and neither is cosmetic:

1. **A live epoch blocks the worker.** `allocate` refuses `busy` while one is live
   (`src/rpc/epoch.ts:183-185`), and *"at most one unsettled epoch is what makes seq attribution
   unambiguous"* (`:22-33`). So a staged-and-never-triggered task takes the worker out of service
   until something settles it. §6.1 gets its one-at-a-time property from this for free, and pays for
   it here. **The mitigation has to be a way to cancel a staged task**, which this document has not
   designed and which is the first thing an implementer will need.
2. **The deadline would start at the wrong moment.** `deadline.restart()` and
   `deadlineMs = envelope.deadline_s * 1000` (`src/supervisor/index.ts:2220-2221`) run at dispatch. A
   staged epoch's deadline must start at the **trigger**, or a 20-minute task staged before lunch is
   `timed_out` before it begins. §9 Q1 holds the part this document cannot settle: how the supervisor
   learns the trigger happened, given that the only observable is the transcript growing.

**And one argument for extreme care that comes from the code rather than from taste.**
`src/supervisor/index.ts:2289-2295` records the 2026-08-30 live regression in which the prompt carried
`epoch: 0`, the worker echoed it into `result.json`, and the harvest clamped a correct answer to
`verdict=unknown`:

> "the repair for an unbindable placeholder is the VALUE, and a value that is delivered but WRONG is
> worse than one that is missing, because the worker has no way to doubt it. A missing epoch produced
> no envelope; a wrong one produces a refused envelope, which degrades the harvest where the absence
> did not."

Today a `tui` worker carries 0 on both sides of `harvest/outbox.ts:493-495` and the gate passes
vacuously. **D6 replaces a vacuous check with a real one, which means it also creates the first way
for this route to fail it.** The drop file, the inbox record and the rendered prompt must carry the
same epoch or a correct result will be refused — the exact failure that regression names.

### D7 — claim exactly what is fenced

**Chosen: ISC-84 and ISC-85 change per route; ISC-86, ISC-87 and ISC-141 do not.**

The temptation is to say the mode gained a fence and leave it there. It gained a fence over
**dispatches**, which is a file-plane fact, and it gained nothing over **turns**, which is a stream
fact and there is no stream. `voided.ts:176-180` says it exactly right already and should not be
edited: *"it is not that a person's writes sit outside the fence, it is that there is no fence."*

**The cost: the voided table becomes route-dependent, and a table whose rows depend on how a task
arrived is harder to read than one that depends on how a worker was launched.** §7.2. That is a real
regression in the table's legibility, and the table's legibility is most of what it is for.

### D9 — record the attach child, and refuse staging when it is dead

**OPEN. Recommended: yes.**

The pid is in scope at `up.ts:2568` and discarded. Recording `{pid, started}` — the same
`ProcessIdentity` shape the launcher, the lease and the registry already use — makes "this terminal is
still the worker's" a checkable fact at the same strength as every other liveness claim in the fleet.
`up.ts:2175-2185` records why the pair rather than the bare pid: *"the number outlives the process and
the kernel hands it out again."*

**Rejected: staging unconditionally and letting the operator discover an untriggerable task.** That is
the `<none>` shape again — a mechanism running over an input nobody is reading and reporting success.

**The cost: it is a partial guard and must not be described as more.** It catches a clean detach and a
crashed terminal. It does not catch a re-attach from elsewhere, a pane respawned onto a different
program, or a second concurrent attach. §9 Q2. **Under D2 this guard is a courtesy; under a
hypothetical reversal of D2 it would be the primary safety control, and it is not strong enough to be
one** — which is itself an argument for D2.

### D10 — no refusal-while-a-person-is-typing

**Chosen: staging does not try to detect a human mid-keystroke. Rejected: gating staging on
`transcript_activity`.**

**Not to be confused with the allocator's `busy`** (`src/rpc/epoch.ts:183-185`), which refuses a second
*dispatch* while an epoch is live and which §6.1 relies on. That one is a control-plane fact and it
works. This decision is about the *terminal*, where there is no fact to have.

§3.4: `transcript_activity` observes the agent writing, not the person typing, and the collision
window is exactly the interval in which a person has typed and the agent has not yet written. A gate
built on it would be open at the moment it needed to be shut, and would be shut — refusing a
legitimate stage — for the whole of a long generation, which is when an operator most wants to queue
the next thing.

**The cost: a semantic collision is possible and is only reported, never prevented.** §7.3.

### D12 — Defect B closes as a consequence, not as a repair

**OPEN. Recommended: yes, and the alternative deserves a hearing.**

Under D6 the settle path becomes reachable and `classifyTuiTurn` runs for the first time. The
alternative is to repair it independently — give the `tui` poll a way to settle without an epoch — and
that is not obviously wrong: it would give the backend-managed `tui` route a `wait` that works, which
it has never had.

**Recommended against for one reason: a settle with no epoch has nothing to write a task record
under**, and `wait` reads task records (`wait.ts:36`, `:103`). Repairing it separately means inventing
a second identity for a turn, which is the two-spellings-of-one-fact hazard `harvest/layout.ts:100-103`
records as ISC-345's finding.

**The cost of taking the recommendation: the backend-managed `tui` route keeps a dead settle path
until someone backports D6's verb to it (§5.3).** That is a known-dead mechanism left in the tree
deliberately, and it should be labelled in `supervisor/index.ts` where the guard is, in the style
`dispatch.ts:328-355` already uses for its declared-unreachable key loop — so nobody reads it as live.

---

## 9. Open questions

**Q8 blocks the design as specified; the rest do not.** A staged dispatch that cannot be cancelled
takes the worker out of service on the operator's first mistake, and §6 has no answer. Q1 and Q9 do
not block the shape but do decide whether D6 delivers what §1.4 promises. Where a section depends on a
question, it says so.

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | How does the supervisor learn a staged task was **triggered**? The only observable is the transcript growing, and `transcript_activity` already watches it (`supervisor/index.ts:2013-2019`) — but growth after a stage could be the staged task or the operator's own unrelated prompt. | Stage a task, do not trigger it, type something else, and see whether any available signal separates the two. If none does, D6's deadline must start on first growth after the stage and be documented as approximate. | **D6's deadline semantics.** Not the epoch itself — allocation and dedup are unaffected. |
| **Q2** | Can the host enumerate a container's attached clients? D9's guard is partial because this document found no mechanism and did not look beyond the code. | Attach twice, detach one, and see whether `docker inspect` or the API reports anything that distinguishes the states. | D9's strength, and nothing else. If the answer is yes, D9 becomes a real guard rather than a courtesy. |
| **Q3** | Does the `cmux` surface id read from `CMUX_SURFACE_ID` survive a workspace rebuild under the same title? `src/backends/cmux/operations.ts` selects an existing `operations` workspace rather than rebuilding it, so a stale id may or may not be re-issued. | Rebuild the workspace with `--recreate` and compare the ids. | Only a reversal of D2. Recorded because a reversal would rest on the id being stable, and nothing here establishes that it is. |
| **Q4** | Is there a **container-side** trigger that starts a Pi turn without writing to the surface? If one exists, §5.3's deferred auto-trigger becomes available and D2's cost largely disappears. | Read what Pi 0.79.6 does on receiving input other than through its pty; probe whether a `docker exec` can reach the composer at all. Expect no — a TTY has one owner (`Docs/SRD.md` §162) — but the expectation is not a finding. | §5.3, and the whole force of D2's cost paragraph. **This is the highest-value question in the table.** |
| **Q5** | Does `paneKeystrokes` behave as assumed against a **shell** rather than Pi's composer? §4.3's hazard argument assumes `shift+enter` in a shell submits a line. It may instead be inert, which would make the hazard smaller (partial line, no execution) though not absent. | Send the plan to a pane running a shell and read what happens. | The **severity** of §4.3, not its direction. D2 does not rest on the worst reading — a brief typed into a shell is a hazard at any severity — but the argument should not overstate what was not measured. |
| **Q6** | How large can a drop file be before it becomes the hazard `MAX_ENVELOPE_BYTES` guards at the other end? D5 says the drop carries a full brief. | Establish the cap the same way the outbox's was established, and refuse at stage time rather than at read time. | D4's implementation, not its shape. |
| **Q8** | **How is a staged task cancelled?** D6's first cost is that a live epoch takes the worker out of service until it settles, and `allocate` refuses `busy` meanwhile. Nothing in this document designs the release. `abort` is not it — on a `tui` worker it records intent and returns `ok: false` (`src/supervisor/index.ts:2568-2584`), and `pifleet abort` on this mode issues `docker kill --signal=INT`, which **stops the worker** rather than returning it to idle (`src/attended/voided.ts:97-99`). | Decide whether cancellation settles the epoch with a new verdict, or whether staging should not allocate until the trigger is observed — the second collapses D6 into Q1 and is worth costing before the first is built. | **D6's usability, and it is the largest unresolved item in this document.** A design that can stage but not un-stage is a worse seat than the one it replaces. |
| **Q9** | Which `attempt_id` does a staged dispatch carry? Dedup keys on it (§6.3), and `--auto` makes it deterministic (`dispatch.ts:1110-1113`) precisely so a re-run replays. A staged dispatch that mints a random one gets no dedup at all and item 4 of §1.3 stays open. | Decide the rule — derived from the task file's content, or from `(task_id, run_id)` — and probe that staging the same file twice replays rather than allocating. | **Item 4 of §1.3.** This is the difference between D6 delivering the fence and merely allocating a number. |
| **Q7** | Does the 2026-09-02 report's `audit/obs-1.jsonl` refer to the host-collected verbgate copy (`src/run/paths.ts:589-592`) or to something else? §1.3 assumes the former from the filename and the row shape and did not confirm it. | Read the file. | §1.3's row 2 only. The mechanism it names is confirmed independently from the code either way. |

---

## 10. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria, each
phrased so the probe is obvious, because a criterion whose verification is unclear is one that will be
graded `[~]` forever.

**`ISC-430` is the highest id in use as of 2026-09-02 — verified by
`grep -o "ISC-[0-9]\{1,4\}" ISA.md | sort -u -t- -k2 -n | tail` — so this block starts at `ISC-431`.**
Twenty-five criteria are proposed below, which puts the block at **ISC-431..ISC-455**, with
**ISC-456..ISC-460 held in reserve** for the ones Q1, Q8 and Q9 will add once they are settled: a
staged epoch's deadline, cancellation, and the `attempt_id` rule each need a criterion and none can be
phrased yet. This document deliberately allocates none of them — `ISA.md` owns that numbering, and two
criteria sharing a number is a worse outcome than a list that needs ids assigned on adoption.

**Two existing criteria are made stale by the findings above, independently of whether this design is
built. Take these first.**

| ISC | What it says | What this work does to it |
|---|---|---|
| **ISC-380** | The dispatch join through a real backend — typed bytes reconstruct the rendered prompt, keys arrive in the backend's spelling, CLI and ledger both report `via: pane` with no epoch. Graded `[x]`. | **Not falsified, and incomplete in a way its own closing evidence could not see.** Defect A (§2.3): the route it proved never writes `/policy/task`, so the worker it dispatches runs its whole life ledgered against no task. The criterion asserts what was typed; nothing asserted what the worker's provenance file said afterwards. **It should gain that assertion whether or not this design is adopted.** |
| **ISC-387** | The key vocabulary is a measurement nothing re-runs; graded `[~]` because *"the mode's subject is a pseudo-TTY and the suites cannot open one."* | Unchanged in force. Under D2/D8 the staged route needs **no** key vocabulary at all, which does not make ISC-387 stronger — the backend-managed route still needs it — but does mean the console's own seat stops depending on it. Worth recording, because the `[~]` currently reads as blocking the console and after this it would not. |

**Criteria that must be re-read before any of them is claimed to still hold:** **ISC-84, ISC-85,
ISC-87** (the epoch rows of the `tui` voided table — §7.2 changes all three, and ISC-87 was
unreachable), **ISC-86, ISC-141** (unchanged, and the wording of ISC-86 needs the staged route's
weaker proof), **ISC-360, ISC-362** (the provenance file and the environment carrier it replaced —
Defect A is ISC-360's finding recurring), **ISC-349** (the unbindable placeholder — Defect C is the
same finding at the instruction rather than at the value), **ISC-389** (adoption — this design changes
what adoption buys, which is the sentence that criterion closes on), **ISC-144, ISC-191, ISC-272**
(`(pid, started)` capture — D9 adds a fourth capture site and must use the launcher's record, not a
re-read), **ISC-137** (no cmux import outside `src/backends/cmux/` — D2 keeps the staged route clear of
it entirely, which is worth asserting rather than assuming), **ISC-94** (a missing envelope must not
clamp — the staged route creates a new way for one to be missing).

Proposed new criteria, by area:

**The prerequisites (D11, D14)**
- A pane-route dispatch writes `(task_id, epoch)` to `/policy/task` before the first byte is typed.
  *Probe: dispatch through the fake-backend path and read the file; a write that lands after the
  keystroke plan fails.* (Defect A.)
- A gated verb run by a backend-managed `tui` worker is ledgered under the task it was dispatched
  under. *Probe: the verbgate ledger row's `task_id` is the dispatched id, not `<none>`.*
- `skills/pifleet-worker/SKILL.md` names the fenced `## This task` block as the source of `<task-id>`,
  and a dispatch with an explicit `title` still leaves the id bindable. *Probe: render a prompt with
  `title` set to something other than the id and assert the id is still present in a block the skill
  points at.* (Defect C.)

**Staging (D1, D4, D5)**
- `dispatch` at an adopted-terminal worker exits 0 and writes an inbox record, `/policy/task` and the
  drop file. *Probe: all three, by content; a missing one fails.*
- The staged prompt is byte-identical to what the rpc route would render for the same envelope.
  *Probe: render both and compare; a route-specific abbreviation fails.*
- **Anti: staging types nothing.** *Probe: no backend method is called on the staged route — assert on
  a backend double that records every call, and assert the CLI never loads a pane backend at all.
  This is D8, and it is the criterion that would catch a future edit re-opening §4.3.*
- The drop file is mode `0444`, mounted `:ro`, and rewritten in place. *Probe: assert the inode is
  unchanged across two stages; a rename fails.*
- The verbgate refuses to run when the drop file is writable. *Probe: chmod it and assert exit 78.*

**The epoch (D6, D7, D12)**
- A staged dispatch allocates an epoch ≥ 1, and the same epoch appears in the inbox record, the drop
  file and the ledger row. *Probe: all four values equal; a 0 anywhere fails.*
- **Re-staging the same task file at the same worker replays the original epoch rather than running
  the task twice.** *Probe: stage, then stage the same file again, assert `replayed: true` and the
  same epoch, and assert the drop file was not rewritten. **This is item 4 of §1.3 and is the
  criterion the operations console most needs** — and it only passes if Q9's `attempt_id` rule is
  deterministic, so the criterion and the rule must be filed together.*
- A staged task holds the worker: a second stage of a **different** task is refused `busy`.
  *Probe: assert the refusal names the live epoch. This is the cost D6 records, asserted rather than
  discovered.*
- The supervisor's `stage` verb allocates and fences without sending a prompt. *Probe: mutation — make
  `stage` fall through to `send` and assert the compile or the test fails.*
- `cmd: "dispatch"` is still refused for `client === null`. *Probe: the existing refusal, unchanged.*
- The `tui` transcript poll settles a turn when an epoch is live. *Probe: the first test in this repo
  that reaches `classifyTuiTurn` through the supervisor rather than calling it directly — §2.4 says
  none does today.*
- `wait` returns a named non-zero for a staged-but-untriggered task rather than consuming its timeout.
  *Probe: stage, never trigger, assert the exit code and the reason inside a second.*

**The terminal guard (D9)**
- `up --attach-here` records the attach child's `{pid, started}` from the launcher's own record.
  *Probe: assert the pair is present and that no `ps` is shelled out to at that site — ISC-191's
  lesson.*
- Staging refuses when the recorded attach process is gone. *Probe: record a pair, kill it, stage,
  assert the refusal names the remedy.*
- **Anti: a reused pid does not satisfy the guard.** *Probe: same pid, different start time, assert
  the refusal — the ISC-144 shape.*

**The harvest joins up (the whole point)**
- A staged task whose worker writes `/outbox/<task-id>/result.json` is harvested and appears in
  `pifleet artifacts --json`. *Probe: end to end on the headless-with-adoption shape; **this is the
  criterion that closes item 3 of §1.3** and it should be written first and failed first.*
- A staged task whose worker writes to a **differently named** directory produces the
  `unexplainedOutboxDirs` finding. *Probe: the finding names the directory; today the dispatched set
  is empty and no finding is possible at all.*

**Reporting and refusals**
- `report` names a staged-but-untriggered task. *Probe: stage, report, assert the line.*
- The `tui` voided table distinguishes a staged dispatch from a hand-typed turn on ISC-84 and ISC-85.
  *Probe: assert both rows' text against the route; one table for both fails.*
- `--auto` still refuses an adopted-terminal worker with `pane_mode_tui_is_not_auto_schedulable`.
  *Probe: the existing rejection, unchanged.*
- A `tui` worker on `headless` with `adopted_terminal: false` still gets the original refusal.
  *Probe: the original sentence, unchanged — this is the case D1 does not touch.*
- **Anti: no criterion in this block requires a real pty.** *Probe: the whole block passes under the
  existing Docker gate with no terminal — which is the property ISC-377/378/379/387 lack and the
  reason they are `[~]`. If this block cannot be written to that standard, say so at filing time
  rather than discovering it at grading time.*

---

## 11. References

- `Docs/SRD.md` §0.2 (Decision 1 — the pane is a view), §3.3 (three processes, three lifetimes),
  §3.4 (the supervisor ↔ container contract), §3.5 and its four errata (pane modes and what `tui`
  voids), §4.1 (cmux as verified, including the injected pane environment), §5.5 (the outbox contract),
  §7.5 (epoch fencing), §7.6 (presentation beside state), §7.7 (ledger and registry).
- `Docs/SRD-INFERENCE-PROVIDERS.md` — the format sibling; §0.3's disclosure precedent and §0.4's
  provenance table.
- `src/cli/commands/dispatch.ts` — `paneKeystrokes`, `sendViaPane`, `planDispatch`, `sendTaskEnvelope`,
  and the `--auto` refusal.
- `src/cli/commands/up.ts` — `assertAttachHere`, `assertTuiBackendPossible`, the presentation write,
  the adopted attach and its discarded child pid.
- `src/attended/adopt.ts` — `adoptRefusal`, `adoptRefusalMessage`, `adoptedAttachArgv`.
- `src/attended/voided.ts` — `PANE_MODE_TUI_VOIDED`, `ATTENDED_VOIDED`, `voidedFor`.
- `src/attended/mode.ts` — `enterTui`, `leaveTui`, `attachArgv`, `DETACH_KEYS`.
- `src/supervisor/index.ts` — the RPC dispatch handler, the `tui` transcript poll, `renderPrompt`.
- `src/supervisor/tui.ts` — `detachedDockerArgv`, `discoverSessionPath`, `classifyTuiTurn`.
- `src/rpc/epoch.ts` — `EpochManager.allocate`, `attemptKey`, `attribute`, `noteAck`, the
  `FenceSnapshot` fields, and the header's correction of §7.5 to fence on stream offset.
- `src/rpc/completion.ts` — the double-correlated `get_state` probe the `tui` route does not have.
- `src/run/state.ts` — the `pifleet.fence/v1` schema, `readFence`, `writeFence`.
- `src/orchestrate/graph.ts` — `TuiDependencyError`.
- `src/orchestrate/scheduler.ts` — the per-supervisor limit of attempt dedup.
- `src/run/task-policy.ts` — `writeTaskPolicy`, `TASK_POLICY_MOUNT`, `TASK_POLICY_NONE`, and the
  in-place rewrite recipe.
- `src/config/render.ts` — the mount table and `assertNoRunDirMount`.
- `src/harvest/layout.ts` — `dispatchedTaskIds`, `unexplainedOutboxDirs`.
- `src/harvest/outbox.ts` — `readResultEnvelope` and the two identity checks.
- `src/util/pane-text.ts` — `assertPaneTypeableLine`, `PANE_KEYS`, `assertPaneKey`.
- `src/backends/cmux/operations-plan.ts` — the console's panes and `DEFAULT_OPERATIONS_WORKERS`.
- `docker/verbgate` — the provenance read and the policy-integrity loop.
- `skills/pifleet-worker/SKILL.md` — the outbox contract as the worker receives it.
- `fleet.example.yaml` — the annotated worker set; `obs-1` and `tick-1` and why the override sits on
  the worker rather than the role.
- `ISA.md` — ISC-84, ISC-85, ISC-86, ISC-87, ISC-141, ISC-349, ISC-360, ISC-362, ISC-380, ISC-387,
  ISC-389.
