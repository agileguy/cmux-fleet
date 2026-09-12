# System Requirements Document — a Pi extension that holds dispatch state and makes report obligations into typed tools

**SRD-WORKER-DISPATCH-EXTENSION-001 v0.1 — DRAFT FOR OWNER REVIEW**

*Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001), `Docs/SRD-DEPLOY-OPS.md` (SRD-OBSERVER-001),
`Docs/SRD-REVIEW-CONSOLE.md` (SRD-REVIEW-CONSOLE-001), `Docs/SRD-FLEET-PROJECT-MANAGER.md`
(SRD-FLEET-PM-001) and `Docs/SRD-TRIAGE-CONSOLE.md` (SRD-TRIAGE-CONSOLE-001). It is the FIRST
document in this repository whose subject runs **inside a worker container** rather than on the
host, and §4.3 is that boundary stated rather than assumed. It **consumes** the host contracts
whole — `/outbox/<task-id>/files/`, `/replies/<child>.json`, `pifleet.result/v1`,
`observer-ops.json`, `/policy/task` — and proposes changing exactly one of them (§7.4). It
**proposes an amendment** to `Docs/SRD.md` §4.2's tool-scope row, because §0.2 measured that row's
premise running in a direction the row does not describe.*

---

## 0. Preamble

### 0.1 The one-paragraph thesis

Six defects surfaced when the triage console was first stood up live. Four were host-side
derivation errors and are fixed and committed on this branch (`efaf63a`, `8096fc4`, `e5d5751`,
`5dbdafe`). **The two that remain have one shape: the obligation is English prose in a brief, and a
model can end a turn without honouring it.** An observer settled `success` having written nothing,
forty-five times running, across three different models; a collator settled having made zero tool
calls against a `/replies` file that existed and was readable. Pi 0.79.6 has a first-class
extension API — `pi.registerTool()`, event interception, `pi.appendEntry()` — and this fleet
already ships two extensions baked into the worker image (`docker/Dockerfile:436`, `:446`), so the
mechanism is not speculative and neither is the staging path. **What this document found, and what
changes the design the commission imagined, is three measured facts.** `--tools` is an allowlist
over *every* tool and not only the built-ins, so a worker whose `tools:` list omits an extension
tool's name has that tool **deleted from the registry** — measured, §0.2 — which means the
`PI_BUILTIN_TOOLS` enum must grow or every custom tool in this fleet is silently invisible. There
is **no turn-end veto**: `agent_end` and `turn_end` handlers are typed `ExtensionHandler<E>` with
the result parameter defaulted to `undefined`, so no extension can refuse to end a turn, and the
crux the commission named cannot be built as named. And the supervisor never looks at an outbox
before settling — its only anti-false-success guards are the prose detector and a git tree-hash
comparison that is **structurally unreachable** for every `workspace: none` role, which is exactly
the set of roles whose whole deliverable is a written file. **So the design that falls out is: one
extension, baked, loaded by `--extension`; a `submit_report` tool that is a delivery mechanism and
never an authority; dispatch state read from `/policy/task` rather than recited in prose; and four
ordered layers against the silent settle, only ONE of which is a mechanism — removing `write` from
the roles that have no `bash` — the other three being incentive, pressure and evidence, named as
such.**

### 0.2 The decision that matters — a typed tool is invisible unless its name is in `--tools`, and this was measured

`src/config/render.ts:260` is one line:

```ts
  if (w.tools !== undefined) argv.push("--tools", w.tools.join(","));
```

and every role in `fleet.yaml` declares `tools:` (`:508`, `:534`, `:550`, `:593`, `:623`, `:687`,
`:718`, `:766`, `:831`). So every worker in this fleet is launched with an explicit `--tools`
allowlist. **`--tools` does not mean "which built-ins".** It means "which tools", and Pi enforces
it at registry construction rather than at activation.

`dist/core/agent-session.js:1830`, read inside the pinned worker image:

```js
const isAllowedTool = (name) => (!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
```

and `:1838` applies it to the extension tools themselves:

```js
].filter((tool) => isAllowedTool(tool.definition.name));
```

**Measured 2026-09-07** against `pifleet/pi-worker:0.79.6-base-b722edcf4699` — the image the live
triage console is running — with a throwaway extension registering one tool named `submit_report`
and one slash command that prints `pi.getAllTools()` and `pi.getActiveTools()`. The command handler
runs *before* the agent loop, so every row below cost zero model calls:

| `pi` flags | registry (`getAllTools`) | active (`getActiveTools`) |
|---|---|---|
| *(none)* | 7 built-ins **+ `submit_report`** | `read, bash, edit, write, submit_report` |
| `--tools read,bash` | `read, bash` | `read, bash` |
| `--tools read,bash,submit_report` | `read, bash, submit_report` | `read, bash, submit_report` |
| `--no-builtin-tools` | 7 built-ins + `submit_report` | **`submit_report` only** |
| `--no-builtin-tools --tools read,bash,submit_report` | `read, bash, submit_report` | `read, bash, submit_report` |
| `--exclude-tools write,edit` | `read, bash, grep, find, ls, submit_report` | `read, bash, submit_report` |
| `--tools read,bash,submit_report,does_not_exist` | `read, bash, submit_report` | `read, bash, submit_report` |

**Row 2 is the finding.** `--tools read,bash` does not merely leave `submit_report` inactive — it
removes it from the registry entirely. Ship this extension without touching config and **every
worker in this fleet gets nothing**, with no error, no warning and no log line. The two extensions
already in the image survive only because neither registers a tool: `dispatch-trigger.ts` uses
`session_start`/`session_shutdown`/`sendUserMessage` and `truncation-recovery.ts` uses
`tool_result`, and **events are not filtered by `--tools`**. This fleet has therefore never met the
hazard.

**Row 7 is the same hazard the enum already exists to prevent, measured directly for the first
time.** `src/config/schema.ts:60-64`:

> ```
> /**
>  * Built-in Pi tools, exactly. There is no `web_fetch` — v1.1's researcher role
>  * requested it and was silently granted nothing, because Pi's `--tools` does no
>  * validation (SRD §4.2). Making the tool list an enum moves that silence into a
>  * loud schema error.
>  */
> ```

`does_not_exist` vanished without a word. The docblock's claim is true, and it is now true of a
*second* class of name: a misspelled **extension** tool name is silently granted nothing in exactly
the way a misspelled built-in is. **Whatever mechanism declares `submit_report` to a worker must be
as closed as `PI_BUILTIN_TOOLS` is, or this design reintroduces the precise silence that enum was
written against.** D2 takes that decision; §6.6 specifies it.

**And row 6 is the arm this document considered and refuses.** `--exclude-tools` is a denylist,
it is already a schema field (`schema.ts:120`), it is already emitted (`render.ts:261-263`), and it
keeps extension tools without anyone having to enumerate them. It is refused because
`schema.ts:1582-1592` resolves an *omitted* `tools:` to the whole built-in set before the ISC-59
`read_only`/`bash` cross-check runs — verbatim, *"Omitting `tools` is NOT 'no tools' — pifleet then
passes no `--tools` flag and Pi grants every builtin, `bash` among them"* — and `exclude_tools` is
not subtracted there. A `collator`, `reviewer` or `triage` role converted from allowlist to
denylist would be silently granted `bash`, which `fleet.yaml:816-830` calls **"the load-bearing
omission"** for `triage` in particular: *"A shell is exactly what turns a request-WRITING worker
into a DISPATCHING one, and an agent may not dispatch."* Trading that for a shorter config line is
not a trade this document will make.

### 0.3 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Measured** | seven `docker run` probes against `pifleet/pi-worker:0.79.6-base-b722edcf4699`, 2026-09-07, recorded verbatim in §0.2 and §2.2. Zero model calls: every probe drives a slash-command handler, which the lifecycle checks before the agent loop | §0.2, §2.2, §6.6, §6.8 |
| **Read (image)** | `@earendil-works/pi-coding-agent@0.79.6` inside the worker container — `docs/extensions.md`, `dist/core/extensions/types.d.ts`, `dist/core/sdk.js`, `dist/core/agent-session.js`, `dist/main.js`, `examples/extensions/structured-output.ts`, `pi --help`. **Cited as image paths, not repo paths**, because they are not in this repository and are pinned by `docker.pi_version` | §2.1, §2.3, §6.2, §6.3 |
| **Read (repo)** | code and config on branch `triage-console`, opened 2026-09-07, file and line at every claim | §2, §4, §6-§9 |
| **Recorded** | the four fix commits' messages (`efaf63a`, `8096fc4`, `e5d5751`, `5dbdafe`), `SweepJoin.claimedSuccess`'s docblock, `Docs/SRD-TRIAGE-CONSOLE.md` §6.5/§12, `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5, `Docs/SRD.md` §4.2/§12.1/§12.6, `triage/console.yaml` | §1, §4, §6.5 |
| **Inferred** | reasoning from the above | §5-§13. **These are proposals, and they are where the owner's review is most valuable.** |

**No extension was written, installed, or loaded into a live worker.** The seven probes ran in
throwaway containers (`docker run --rm`) from the same image; nothing touched the running triage,
review, development or operations consoles, and no host state outside a scratch directory was
created. **No claim below rests on a model's behaviour**, because none was observed: every
statement about what a model *will* do under a narrowed tool set is marked as an expectation and
appears in §11.

### 0.4 Three corrections to the premises this document was commissioned against

**1. Auto-discovery is off in this fleet, by design, and `pi install` is unreachable.** The
commission names *"Auto-discovery from `~/.pi/agent/extensions/` (global) or `.pi/extensions/`
(project-local); `/reload` hot-reloads"* and *"`pi install <source>` supports `./local/path`"*.
Both are real Pi features and neither is available here. `src/config/render.ts:208` pushes
`--no-extensions --no-skills --no-context-files` for **every** worker in **both** pane modes, and
`pi --help` records what that flag means: *"Disable extension discovery (explicit -e paths still
work)"*. On top of that, `/home/pi/.pi/agent` is a per-worker **named Docker volume**
(`render.ts:600`, `pifleet-piagent-<worker-id>`), so an extension baked into the image at that path
would be shadowed by whatever a prior image left in the volume — a stale-extension failure with no
observable. And `.pi/extensions` is project-local, requiring both a project and its trust, while
`observer`, `triage`, `collator`, `reviewer` and `verifier` all run `isolation: none` and have no
`/workspace` at all. **The path this fleet actually uses is `--extension <absolute path>`, twice
already**, and D1 takes it.

**2. There is no event that can refuse a turn, so defect 5 cannot be fixed the way the commission
frames it.** The commission asks to *"Establish from the docs which event fires at turn end,
because refusing to settle a turn that never called `submit_report` is the crux of fixing defect
5."* The events exist; the refusal does not.
`dist/core/extensions/types.d.ts:804` declares the handler type:

```ts
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

and `:824` / `:826` declare the two candidates **with no second type argument**:

```ts
    on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
    on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
```

So `R` is `undefined` for both: whatever a handler returns is discarded. The events that *can*
intervene all declare a result type — `ToolCallEventResult` with `block` (`:739-743`),
`MessageEndEventResult` with `message` (`:756-759`), `SessionBeforeSwitchResult` with `cancel`
(`:765-767`), `BeforeAgentStartEventResult` with `message`/`systemPrompt` (`:760-764`) — and none
of them fires at the end of an agent loop. **§6.3 replaces the veto with four ordered layers and is
explicit that only the first is a mechanism.**

**3. `src/container/mounts.ts` is not the mount list.** The commission says *"Skills are staged per
role and mounted `/skills:ro` (see `src/container/mounts.ts`)"*. The staging is real and the
citation is not: `mounts.ts` holds `WORKER_UID = 10001` (`:63`), `WORKER_HOME` (`:66`),
`makeWorkerAccessible` (`:149`), `makeWorkerReadable` (`:178`) and the bind-mount failure-mode
docblock (`:1-41`). The mount table is `buildDockerArgv` in `src/config/render.ts:278-611`, headed
by `:446-447` — *"Mount table (SRD §5.5). Nothing else is mounted"* — and the per-role skill staging
is `materializeRoleSkills` (`src/run/materialize.ts:518`), whose docblock at `:493-517` explains
that the key is the role because the mount is (`render.ts:514`, `roleSkillsDir(run.root, w.role)`).
**§6.7 answers the staging question against the code rather than the citation.**

### 0.5 What reading the code and probing the image found

Eight findings. Three change what a section downstream may assume; the rest are reachable today
whether or not this extension is ever built.

| # | Finding | Reachable today? | § |
|---|---|---|---|
| **A** | **`--tools` deletes extension tools, and every worker in this fleet passes `--tools`.** Measured, §0.2 row 2. Nothing in `src/` emits `--no-builtin-tools` — grepped across `*.ts`/`*.sh`/`*.yaml`/`Dockerfile`, the only hits are prose at `Docs/SRD.md:391` and `:467`, the latter listing it among flags *"pifleet never renders"*. So the lever the commission most wanted is available and currently unused, and the lever that is in use would silence the whole design. | Yes | §0.2, §2.2, §6.6 |
| **B** | **No turn-end veto exists.** `ExtensionHandler<E, R = undefined>` (`types.d.ts:804`) with `agent_end`/`turn_end` declared without `R` (`:824`, `:826`). The one thing that comes close is `terminate: true` on a tool result — `docs/extensions.md` §Tool Definition and `examples/extensions/structured-output.ts` — which *hints that the follow-up LLM call be skipped* when **every** finalized result in the batch terminates. That makes calling `submit_report` the cheapest way to end a turn. It cannot make **not** calling it expensive. | Yes | §0.4, §2.3, §6.3 |
| **C** | **The supervisor never opens an outbox before settling, and its one substantive success-downgrade is unreachable for exactly the roles that matter.** `src/supervisor/index.ts:1261-1263` is the RPC quiesce chain's `else`: `verdict = "success"; reason = "quiesced";`. The TUI path is the same shape at `:2299-2325` with `transcript_quiesced`. The ISC-299 downgrade (`:1035-1053`) requires `treeHash !== null && settledBaseline !== null`, and a `workspace: none` role has no worktree — it logs `quiesce_sample_skipped` (`:1105-1110`) and yields `treeHash = null`. **Observer, triage, collator, reviewer, verifier and ticketing are therefore all outside it by construction**, and they are the six roles whose entire deliverable is a written file. The other guard, the prose detector (`prose-detector.ts:97`, `NO_TOOL_CALLS_REASON`), asks whether tools were called — and `roles/observer.md:42-46` records an observer that made **150 `kubectl` calls** and wrote nothing. | Yes | §2.5, §6.3 |
| **D** | **Dispatch state already exists as a host-written, worker-unwritable file, and its docblock is this design's argument in advance.** `/policy/task` (`src/run/task-policy.ts:47`) is two lines — task id, epoch — rewritten by the supervisor at every dispatch with the chmod-truncate-chmod recipe (`:73-79`, `:33-41`). Its header (`:11-28`) rejects `PIFLEET_TASK_ID` on two grounds that apply verbatim to a prompt-recited task id: *"It is fixed at launch and the value is not"* and *"The worker controls it… a process that can `export PIFLEET_TASK_ID` can forge the provenance on its own audit rows."* **A task id parsed out of the model's own prompt is worse than an env var on the second ground**, because the model is the thing being audited. §6.4 reads the file instead. Verified live: `/policy/task` in `…-4b57-tri-1` is 9 bytes, mode `0444`, owner `pi` — `<none>\n0\n`, an idle worker. | Yes | §2.4, §6.4 |
| **E** | **`/replies` accumulates across sweeps, so a tool that enumerates it is a freshness bug.** `workerRepliesDir(run.root, worker)` (`src/run/paths.ts:490-492`) is one directory per worker per **run**, and the triage console is one long-lived run publishing `<childTaskId>.json` per sweep (`triage-envelope.ts:1115-1124`). Sweep 5's collator would see sweeps 1-5. This is why `get_replies` cannot be `readdir` — and why `src/run/replies.ts:24-30`'s existing refusal of *"a `/replies` the collator enumerates"* is right for a second reason its author did not need: *"A listing hands the worker a directory to walk and re-introduces exactly the discoverability the outbox contract denies in the other direction."* | Yes | §2.4, §6.2, §7.4 |
| **F** | **The obligation prose is ~40-70% of every role file, and it is the half written in capitals.** `roles/triage.md` is 618 lines of which roughly 70% is mechanics — the `triage.json` field-rule block alone, opening at *"Field rules. **They are not all enforced the same way, and each says which**"*, is the largest single one. **(Corrected 2026-09-11: this read "573 lines" and `:325-457` until review recounted it. The file has been 618 lines since before `609fcbb`; `:325` is blank and `:457` is mid-sentence. Pinned on the opening phrase rather than re-numbered, because a number here has now rotted once and nothing in this repository re-checks one.)** `roles/reviewer.md` spent 62 of 168 lines (38%) on the envelope, across four consecutive sections — **that block is gone as of `b94c58b` (task 8.1), and the file is 113 lines**, which is this finding's proportions confirmed by removal rather than by estimate. `roles/observer.md` gives `:10-64` and `:138-147` to *where and when to write* against `:66-136` for *what to look at*. The sentence *"An envelope you never wrote does not fail your task; it removes you from the grading"* appears in file after file in paraphrase — grep `never wrote does not fail`, which today matches `roles/observer.md`, `roles/tester.md`, `roles/verifier.md` and `roles/ticketing.md`, plus the *"A missing envelope does not fail your task"* wording in `skills/pifleet-worker/SKILL.md`. It is a **five**-file count and was never the six this row first claimed: `roles/reviewer.md`'s copy was real and `b94c58b` deleted it as task 8.6's sentence, but `roles/collator.md` carried no paraphrase at the cited lines or anywhere else, in this branch or any commit before it — a citation with nothing behind it, of the kind §2.6 records. **Every one of the paragraphs that IS there exists because the mechanism it describes failed once.** | Yes | §2.6, §8 |
| **G** | **`SweepJoin.claimedSuccess` is a typed field no consumer reads.** Added this session (`efaf63a`), declared at `src/run/triage-pass.ts:254`, populated at `src/run/triage-envelope.ts:1142`, and its whole effect is a `console.error` at `:1143-1149`. `completeSweep` (`triage-pass.ts:942-1022`) reads `join.artifacts.length` and `join.blocked.length` and nothing else. An exhaustive grep finds it in two source files and three test files and nowhere in the incident machine, the verdict mapping or the notifier. **The commission calls it "a diagnosis, not a prevention" and that is exactly right — it is currently a diagnosis printed to a stream.** | Yes | §1.3, §12 |
| **H** | **`roles/observer.md` asserts a host-side clamp that does not exist for it.** `:140-141` and `skills/observer-ops/SKILL.md:28-32` both claim a run producing only the `.md` half *"clamps to `failed`"*. `grep -rn "observer" src/harvest/` returns zero. The clamp that exists is `ticket-ops`': `TICKET_OPS_ARTIFACT_NAME` (`src/harvest/reconcile.ts:175`), the orphaned-document scan (`:745-765`), the ceiling (`:202-204`). **This is a role prompt describing a mechanism that is not there** — the same class of defect the commission warns about in this document's own commission, found in the file this design is meant to shrink. Recorded here because it is a live bug independent of this SRD, and because it is the strongest single argument for §8: prose that asserts mechanics drifts from the mechanics. | Yes | §2.6, §8, §11 Q7 |

---

## 1. Problem statement

### 1.1 The two remaining defects, as measured

**Defect 5 — an observer settles `success` having written nothing.** From `efaf63a`'s message,
which is the primary record:

> Measured on the live console: the observer started, ran one `ls`, narrated what it was about to
> do, and its turn ended eleven seconds later with an empty outbox — whereupon the supervisor read
> the quiet transcript as `quiesced` and settled the task `success`. Forty-five passes ran that way
> and produced no artifact.

It is not one model's failure. `roles/observer.md:42-46` records a second shape — *"an observer made
**150 `kubectl` calls** against exactly the right namespaces, reading pods and services and
rollouts, and then its turn ended with an empty outbox"* — and the commission adds a third,
`Qwen3.5-35B` writing a real report once and settling `no_tool_calls` the next run. **Three models,
three different failure shapes, one outcome.** The remedy currently in the tree is a prose budget
(`roles/observer.md:48-58`: *"Around twenty tool calls in, stop investigating and write what you
have"*) and a shouted heading (`:10`: `## YOU MUST WRITE YOUR ARTIFACT`), and `:19-22` records that
a previous observer read the *absence of `edit`* as an absence of permission to write at all.

**Defect 6 — a collator settles without reading `/replies`.** The commission's record: the brief
correctly named the file, the file existed and was readable inside the container (verified with
`docker exec`), and the event log for that turn shows only `tui_turn_ended`/`settled` with zero tool
calls. It then wrote a document listing every service `unaccounted`. The same class is already
recorded from the review console at `roles/collator.md` — under *"MEASURED, on the run this step was
written for"* (**`:172-176`; this cited `:159-168` until 2026-09-11, the turn-two "new prompt"
passage, a different subject**) — from the opposite direction: a
collator that *"spent its last twelve tool calls listing `/replies`, searching `/replies`"* and
achieved nothing.

**And a third, from the review console, which is why §5 scopes this beyond triage.** A whole review
lens was lost when `rev-lang-1` wrote its envelope with an invalid `status`. The collation brief
recorded it verbatim: *"its report WAS WRITTEN AND COULD NOT BE READ: … result.json is 1599 bytes
and did not parse (schema: Invalid option: expected one of `"success"|"partial"|"blocked"|"failed"`
at status)"*. That string is `src/harvest/outbox.ts:704-713` rendering zod's first issue through
`describeUnreadableEnvelope` (`:225-233`). **1599 bytes of correct work, discarded at a four-member
enum.**

### 1.2 The common shape, and why it is not a prompt-engineering problem

All three are the same defect. **The obligation is prose, the honouring is optional, and the failure
is silent at the point it occurs.**

Consider what the fleet does about it today. `skills/pifleet-worker/SKILL.md`'s paragraph opening
*"Write it as ONE LINE"* is a paragraph whose entire content is *"write the JSON on one line"*, and it
exists because a collator *"dispatched a sweep correctly and then could not write its receipt"*.
`src/contracts.ts:203-216` makes
`RESULT_ENVELOPE_NAME` a constant *"rather than a literal at the one read site because a role
document that never spells it is a worker that never writes it"* — and records `rev-ctx-1`
resolving the word `notes` to a **path**, writing `/outbox/<task-id>/notes` and no envelope at all.
`roles/collator.md:109-114` instructs the collator to say the word *field* out loud when briefing
its children, for the same reason.

**Every one of those is a workaround for the absence of a schema at the call site.** A tool with
typed parameters cannot be handed a path where a string field was meant; cannot be written on
seventeen lines; cannot carry a fifth status; and cannot be *approximately* called. `roles/triage.md`
even annotates which of its own field rules are enforced and which are not — `:418-419` **"ENFORCED:
4000 bytes."** against `:420-422` *"one or two sentences is the shape, and that part is not enforced
by anything but this line."* A document that has to tell you which of its rules are real is a
document doing a schema's job badly.

### 1.3 What this does NOT fix, stated before the design so the design is not oversold

**Defects 1 through 4 were host-side derivation errors and this extension would have prevented none
of them.** They are worth restating precisely, because the temptation to claim them is exactly how
the wrong thing gets built:

1. `dispatchObserver` posted to the collator's run. **Host-side.** A worker-side tool has no opinion
   about which host run a socket lives in.
2. `joinSweep` read observer artifacts out of the collator's run tree (`efaf63a`). **Host-side, and
   silent** — *"a path that does not exist and a worker that wrote nothing are indistinguishable
   from the reading end"*. A `submit_report` that writes to the correct path *inside the container*
   does not help a host reading the wrong path *outside* it.
3. The collation brief named `/replies/<child>.json` and nothing wrote them (`8096fc4`).
   **Host-side.** Note carefully: the collator **diagnosed this correctly and said so** — *"there is
   no directory for T-sweep-1-slice1 … the /replies directory is empty."* A `get_replies` tool would
   have returned an empty list and the collator would have reported the same thing. It does not
   detect the defect; it does not hide it either.
4. Publishing `ObserverArtifact` instead of the report (`e5d5751`). **Host-side**, and the
   commission's own summary is exact: *"a right answer to the wrong document"*.

**One boundary is genuinely fuzzy and is claimed only in the weak form it deserves.** Defect 3's
class — *the host names a path in a brief and nothing creates it* — becomes **testable** under this
design, because the set of replies stops being a sentence in a rendered string and becomes a file
the host writes and a tool reads. A fixture can then assert that what `publishReply` published and
what `get_replies` returns are the same set, which is an assertion nobody can write today. **That is
a new test surface, not a prevention**, and §12 files it as such.

**And one thing this fixes only where `bash` is absent.** §6.8 works it through: a worker holding
`bash` can write any file it likes with `cat >`, so removing the `write` tool from an *observer*
narrows the surface without closing it. The structural arm is available for `triage`, `collator`,
`reviewer` and `verifier`, which hold no `bash` by deliberate decision (`fleet.yaml:682-686`,
`:713-717`, `:816-830`). **For the observer, this design is pressure and evidence, not prevention,
and §10 D4 records that as a cost rather than burying it.**

### 1.4 Success in one sentence

**A worker that ends a turn without delivering its report leaves a host-readable record saying so at
the moment it happens, and a worker that delivers a malformed one is told at the call site while it
still has turn left to fix it.**

---

## 2. The current state, read from the code

### 2.1 Extensions are already here, twice, and the shape is settled

`docker/Dockerfile:436` and `:446`:

```dockerfile
COPY --chmod=0444 docker/pi-extensions/dispatch-trigger.ts /opt/pifleet/dispatch-trigger.ts
COPY --chmod=0444 docker/pi-extensions/truncation-recovery.ts /opt/pifleet/truncation-recovery.ts
```

loaded at `src/config/render.ts:241` (conditional: `paneMode === "tui" && autoTrigger`) and `:256`
(unconditional), via `DISPATCH_TRIGGER_PATH` (`src/run/dispatch-policy.ts:111`) and
`TRUNCATION_RECOVERY_PATH` (`render.ts:73`). Both declare their Pi surface **structurally rather
than by import** — `dispatch-trigger.ts:98-102`, `truncation-recovery.ts:119-124` — because the
package is in the image and not in this repository. **That structural-declaration pattern is what
this design copies wholesale.**

**IT DOES NOT COME WITH A DRIFT CHECK, and three passages of this document said it did.**
CORRECTED 2026-09-08: there is no `test/integration/auto-trigger-image.test.ts` and there never was,
and no test anywhere in `test/` reads Pi's `.d.ts`. The only `@earendil-works` string in the whole
tree outside `docker/` is `image.test.ts:249`, which asserts a `.js` PATH appears in a shim — a file
name, not a type. So the two existing extensions declare a Pi surface that nothing checks against
Pi, and a 0.79.x bump renaming `registerTool` would be caught by neither of them.

The check is buildable, which is why the criterion survives the correction rather than being struck:
the type does ship in the image, at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
(verified 2026-09-08 in `0.79.6-base-72c16f4efb2f`). It is NEW work, not a method to be copied.

Both are also in `BUILD_CONTEXT_ASSETS` (`src/container/image.ts:102-134`), the seven-entry list
`configHash` walks (`:231-240`) to produce the twelve hex characters in
`pifleet/pi-worker:<pi>-<toolchain>-<hash>` (`:242-245`). `image.ts:200-202` records the known
fail-open: *"ISC-270 tracks the hash's own fail-open, where a new `COPY` source is added to the
Dockerfile without being added to `BUILD_CONTEXT_ASSETS`."* **A new extension file that is not added
to that array ships inside an image whose tag did not move**, which means `up` will reuse the old
image and the extension will simply not be there. §13 task 2.3 is that one line.

### 2.2 `--tools` is the whole tool scope, and this is what §0.2 measured

Restating the mechanism from the source rather than the probe, because the two agree and a design
should rest on both. `dist/main.js:330-341` maps the flags:

```js
    if (parsed.noTools)            { options.noTools = "all"; }
    else if (parsed.noBuiltinTools){ options.noTools = "builtin"; }
    if (parsed.tools)              { options.tools = [...parsed.tools]; }
    if (parsed.excludeTools)       { options.excludeTools = [...parsed.excludeTools]; }
```

`dist/core/sdk.js:131-135` resolves them:

```js
    const defaultActiveToolNames = ["read", "bash", "edit", "write"];
    const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
    const excludedToolNames = options.excludeTools;
    const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
    const initialActiveToolNames = (options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames).filter(…);
```

and `dist/core/agent-session.js:1828-1892` applies them. Three consequences the config layer must
respect:

1. **`--tools` is an allowlist over the registry, not over the built-ins.** `:1838`. Row 2 of §0.2.
2. **`--no-builtin-tools` leaves the registry intact and empties the *active* set**, then
   `:1888-1892` re-adds every extension tool because the session is constructed with
   `includeAllExtensionTools: true` (`:135-138`). Row 4: `submit_report` alone. This is the flag the
   commission identified and it does exactly what the commission hoped — **and it is redundant the
   moment `--tools` is also passed** (row 5 equals row 3), because `sdk.js:132`'s `??` gives `tools`
   precedence.
3. **`grep`, `find` and `ls` are registered but inactive by default** (`defaultActiveToolNames` is
   four names), which is why every role in `fleet.yaml` lists them explicitly. Not load-bearing here;
   recorded so §6.8's tool lists are not read as gratuitous.

The merge that produces `w.tools` is `pick` (`src/config/load.ts:624-636`), and it is **replace-wins,
not union** — verbatim: *"the most specific level that SAYS anything wins outright. Arrays therefore
replace."* Applied at `:759-760`. **So there is no level at which a tool name can be quietly
added**; whatever declares `submit_report` must appear in the list that wins.

### 2.3 There is no turn-end veto, and this is the design's largest constraint

§0.4 correction 2 has the types. What remains is what the alternatives actually buy.

**`terminate: true`** (`docs/extensions.md`, Tool Definition; `examples/extensions/structured-output.ts`)
is documented as: *"Return `terminate: true` from `execute()` to hint that the automatic follow-up
LLM call should be skipped after the current tool batch. This only takes effect when every finalized
tool result in that batch is terminating."* It is a hint, it is batch-conditional, and it makes
delivering **cheaper** than not delivering. It cannot make not-delivering fail.

**`pi.sendUserMessage(content, { deliverAs })`** (`types.d.ts:294-296`, `:867-869`) and
`pi.sendMessage(message, { deliverAs, triggerTurn })` (`:292-293`) can inject a message from inside
`agent_end`. `docs.extensions.md` describes `deliverAs: "followUp"` as *"Waits for agent to finish.
Delivered only when agent has no more tool calls."* **This is the only lever that can extend a turn
that was about to end**, and this fleet already uses it: `dispatch-trigger.ts` calls
`sendUserMessage` from `session_start`. It is a nag, not a veto, it must be bounded, and its
interaction with the supervisor's quiesce detection is **unmeasured** (§11 Q1).

**`pi.appendEntry(customType, data?)`** (`types.d.ts:871`, docs §pi.appendEntry) *"Persist extension
state (does NOT participate in LLM context)"*. Entries land in the session JSONL, and the session
directory is bind-mounted **read-write from the run tree** at `render.ts:513`
(`<run>/sessions:/sessions`, `src/run/paths.ts:207`). **So an extension can write a record the host
can read, without a new mount and without the model seeing it.** That is the evidence layer of §6.3,
and §6.5 is emphatic that evidence is not authority.

### 2.4 Dispatch state already exists, and its docblock argues this design

Finding D. `/policy/task` is a two-line file — `renderTaskPolicy` (`src/run/task-policy.ts:73-79`)
emits `<task-id>\n<epoch>\n`, sanitized against control characters, capped at 200 characters,
falling back to `<none>` — mounted `:ro` at `TASK_POLICY_MOUNT = "/policy/task"` (`:47`,
`render.ts:524`), rewritten by the supervisor at every dispatch with the inode-preserving recipe
(`:33-41`: *"chmod 0644 -> truncate in place -> chmod 0444, never rename"*).

**Its two reasons for existing are this design's two reasons for reading it.** `:15-28`:

> 1. **It is fixed at launch and the value is not.** A worker container is long-lived and takes many
>    epochs over its life… An env var written at materialize time would name the FIRST task forever…
> 2. **The worker controls it.** … A process that can `export PIFLEET_TASK_ID` can forge the
>    provenance on its own audit rows, which is precisely the field an investigator would trust.

An extension that scraped the task id out of `before_agent_start`'s `event.prompt` would fail both:
the prompt is per-dispatch so (1) is survived, but (2) is *worse*, because the prompt is the
document the model is answering and the model is the thing being audited. **§6.4 reads the file.**

What is *not* derivable from it is the reply set — Finding E. `/replies` is per-worker per-run
(`paths.ts:490-492`) and a standing console publishes into it every sweep, so `readdir` returns the
whole day. `src/run/replies.ts:24-30` already refuses enumeration on independent grounds, and
`:32-37` records the cost that refusal carries: *"the collation brief has to carry the three paths,
so a reply that arrives AFTER the brief is written is invisible."* **§7.4 proposes the one new host
contract in this document, and §10 D6 records why the alternatives are worse.**

### 2.5 Nothing between a quiet turn and a `success` verdict looks at whether anything was written

Finding C, from the code. `src/supervisor/index.ts:1252-1265`:

```ts
    } else {
      verdict = "success";
      reason = "quiesced";
    }
    await settle(verdict, reason);
```

There is no settle-reason enum — `settle` takes `reason: string` (`:881`) and `TaskRecordSchema`
stores `reason: z.string().default("")` (`src/run/state.ts:855`) beside a `verdict` that **is** an
enum (`src/contracts.ts:55-64`). The reader's own docblock (`:1217-1222`) records why the branch
above it exists: *"a worker that streamed reasoning prose for three turns and never called a tool
settled `success`, with a clean empty diff, and looked exactly like a task that had nothing to do."*
**That fix asks whether tools were called. Defect 5's observer called a hundred and fifty.**

`grep -n "outbox\|result.json\|artifact" src/supervisor/index.ts` returns no code hits — only
docblock prose and the prompt-composition block at `:3361-3395` that renders the outbox path *into*
the worker's brief. The supervisor writes the path and never reads it back.

**So the only code in this fleet that notices a false success is `SweepJoin.claimedSuccess`, it runs
minutes later on the host, it exists in the triage console only, and its effect is a `console.error`
(Finding G).** This design does not replace it. It gives it a second, earlier, per-worker source and
a reason to be read.

### 2.6 The prose that would shrink, and the drift already in it

Finding F has the proportions. Two specific pieces of evidence make the case better than the
percentages do.

**`roles/triage.md` contradicted itself about how many observers exist — FOUND HERE, CLOSED
2026-09-10 by `fe0735e` (task 8.3).** As found, the file presented a three-observer table
(`obs-t1`, `obs-t2`, `obs-t3`) with each row described as *"one slot in the partition"*, reasoned
about a three-wide fan-out, then shouted **"YOU HAVE EXACTLY ONE OBSERVER: `obs-t1`"** and said
*"those seats do not exist"*; and the turn-one `notes` example named all three
(*"Dispatched sweep T-sweep-41 to obs-t1 (mia), obs-t2 (authorization), obs-t3 (authentication)"*).
**`fe0735e` resolved it toward the roster rather than toward the prose** — `TRIAGE_CONSOLE_ROSTER.reviewers`
is `["obs-t1"]`, so the table, the fan-out reasoning, step 2's grouping paragraph and that worked
envelope were deleted outright, and the operative section absorbed the one piece of judgement the
table carried. Today the file's opening is protocol prose with no table, `## YOU HAVE EXACTLY ONE
OBSERVER` is the surviving heading, and the only mention of the other two ids left anywhere in it is
a *negative* one, in the table of requests the host refuses: *"those seats do not exist"*.

**This does not weaken the finding, and the closure is the wrong lesson to draw from it.** It was
closed by a person reading two ends of a file and editing one of them — the same manual reconciliation
that let it open, available only because someone went looking. The roster is host-side data — the
`ConsoleRoster` interface and the `TRIAGE_CONSOLE_ROSTER` literal whose `reviewers` is `["obs-t1"]`,
both in `src/run/dispatch-request.ts` — and the prose was a hand copy of it that drifted; a hand copy
that has been corrected once is still a hand copy. **A typed partition would make it
unrepresentable**, which is the claim §8 rests on and the reason this paragraph is kept rather than
deleted with the defect.

**And this paragraph itself repeated the defect it records.** Between `fe0735e` and 2026-09-11 the
text above stood in the present tense, describing a contradiction that no longer existed, with three
line numbers that by then pointed at unrelated prose — a hand copy of a file, drifting from the file,
inside the finding about hand copies of files drifting. Nothing went red, because nothing in this
repository checks a citation.

**`roles/observer.md` asserts a clamp that does not exist (Finding H).** `:140-141` and
`skills/observer-ops/SKILL.md:28-32` both claim an `.md`-only run *"clamps to `failed`"*.
`grep -rn "observer" src/harvest/` is empty; the clamp is `ticket-ops`' alone
(`src/harvest/reconcile.ts:175`, `:745-765`, `:202-204`). This is prose describing a mechanism, and
the mechanism moved. **It is filed as Q7 because it is a live defect regardless of this SRD**, and it
is the cleanest possible illustration of §8's thesis: the fix is not to correct the sentence, it is
to stop having the sentence be the mechanism.

---

## 3. What is knowable, and what is not

### 3.1 Knowable and free

- The extension API surface, exactly, from `dist/core/extensions/types.d.ts` in the pinned image.
- The tool-scope semantics, measured (§0.2) and read (`sdk.js`, `agent-session.js`).
- The staging path, because two extensions already take it (`Dockerfile:436`, `:446`).
- Every host contract this touches: `/outbox`, `/replies`, `/policy/task`, `/sessions`,
  `pifleet.result/v1`, `observer-ops.json`.
- That the read-only closure guard is unaffected — **verified, §4.3, not assumed.**

### 3.2 Knowable from CI, and what a new module must look like

Anything new under `src/` meets `scripts/coverage-modules.ts`'s gate the way
`Docs/SRD-TRIAGE-CONSOLE.md` §3.3 describes. **But most of this design's new code is not under
`src/`** — it is under `docker/pi-extensions/`, which is outside `tsconfig.json`'s `include`.

**CORRECTED 2026-09-08 by the engineer landing task 5.4, and the analogy this paragraph drew was the
wrong one.** It said the directory is outside the typechecker *"exactly as `scripts/` is"*, citing
ISC-572's closing note. **The two are not alike, and the difference is IMPORTABILITY.** `scripts/` is
outside `include` **and unimportable from `test/`**, so nothing pulls it into the program and a
forgotten `quiesce` really is caught by neither `bun run typecheck` nor the suite. `report-tools.ts`
is imported by `test/unit/report-tools.test.ts`, which IS in `include` — so `tsc` pulls it in
transitively and checks it.

**Measured rather than argued, twice and independently:** `tsc --listFiles` names
`docker/pi-extensions/report-tools.ts`, and injecting `const x: number = "s"` into it produces
`report-tools.ts(1984,7): error TS2322` from a plain `bun run typecheck`. **So a type-level tripwire
in the extension DOES redden**, which changes what a criterion there may be pinned to — and this
paragraph, repeated into six engineer briefs, said the opposite. What remains true is the narrower
claim §12 was really built on: **the file is not COMPILED into anything, `bun test` strips types, and
no host code imports it** — so a defect that is not type-level and not covered by a unit test reaches
the image unchecked, which is why the integration test at the image exists. **That is this design's sharpest verification hazard and §12
answers it directly**: the extension is tested the way `dispatch-trigger.ts` is — an integration test
that runs `pi` inside the real image and reads what came back — and the shared logic that *can* live
under `src/` (the schemas, the path derivation, the declared-reply contract) does, so that the
typechecker and the suite reach it.

### 3.3 Not knowable without a live run, and named as such

- **Whether a model under `--no-builtin-tools` actually calls `submit_report`** rather than
  narrating that it would like to. Expected, unmeasured, Q2.
- **Whether an `agent_end` re-prompt extends the turn or fights the supervisor.** Q1.
- **Whether `terminate: true` reaches the supervisor as a clean end.** Q3.
- **What a 20B model does with a rejected tool call.** The whole `rev-lang-1` argument assumes the
  model reads `isError: true` and corrects. Q4.

### 3.4 Not knowable at all

Whether the observer that made 150 `kubectl` calls would have called `submit_report` at call twenty
if it had existed. The counterfactual is not available, and §10 D4 does not claim it.

---

## 4. The principles this bumps into

### 4.1 `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5 and `Docs/SRD-TRIAGE-CONSOLE.md` §6.5 — the host counts

The standing rule is *"the number the loop branches on is the one the host counted, never the one the
worker claimed"*. It is not a slogan here; it is the thing that survived defect 5. `efaf63a` says so:
*"The count was never wrong — §6.5 harvests what the host can read, so those services escalated to
coverage correctly."* **Forty-five false successes did not corrupt a single verdict**, because
nothing downstream asked the worker.

**`submit_report` therefore may not become an answer.** §6.5 specifies the boundary and §12 gives it
an anti-criterion, because this is the exact place where a well-intentioned "the tool already knows
it succeeded, why re-read the file" refactor destroys the property.

### 4.2 `Docs/SRD.md` §12.6 — worker prose is data

Everything a `submit_report` call carries is worker-authored, including its `status`. The schema
constrains the *shape* and refuses at the call site; it confers no trust. Two specific consequences:

- The tool writes the file the host already reads. The host re-reads and re-validates
  (`ResultEnvelopeSchema.safeParse` at `src/harvest/outbox.ts:703`, and the observer artifact through
  `readObserverArtifactAt`). **Validating twice is the point**, not redundancy — the second validation
  is the one that runs on the host's side of the mount.
- The `appendEntry` record of §6.3 layer 4 is a *worker-side claim that a tool was called*. It may
  diagnose; it may not decide. `Docs/SRD-TRIAGE-CONSOLE.md` §7.2's re-audit already treats this class
  correctly, and `5dbdafe` is the recorded case of that guard being right in principle and too broad
  in practice — worth remembering before adding a new string channel from worker to host.

### 4.3 `Docs/SRD-TRIAGE-CONSOLE.md` §12's read-only closure guard — unaffected, and verified

`test/unit/triage-readonly.test.ts` walks the transitive import closure of eight roots
(`:89-98`) and permits exactly one exception, named as a value rather than a predicate (`:116`,
`const DISPATCH_PATH = ["run/dispatch-request.ts"];`) and pinned by a standalone size assertion
(`:389-391`).

**Verified rather than asserted, and here is the negative evidence.** `SRC` is fixed at `:73` to
`../../src/`, and every `existsSync`/`readFileSync` in the file joins against it (`:144-145`,
`:161-164`, `:180`, `:198`, `:256`). A grep for `roles|skills|docker|/outbox|replies` across the file
returns **one** line — `:33` — and it is a docblock citation of the *source module*
`src/monitor/read/docker.ts`, not the `docker/` build context. There are zero references to
`roles/`, `skills/`, `/outbox` or `/replies`, and every module in `ROOTS` and in the pinned
eleven-module `SUBTREE` (`:219-231`) is host-side code under `src/run/` or `src/cli/commands/`.

**So the extension runs in a place the guard does not look, and this is a genuine advantage worth
stating and one hazard worth stating alongside it.** The advantage: the extension may hold write
capability without widening the console's read-only closure by one edge, because it is not in the
closure — it is not even in the same process, the same language runtime, or the same machine
boundary. **The hazard: the guard's coverage is therefore zero here, and a reader who sees "the
read-only guard is green" must not read that as "the worker-side code was checked."** §12 asks for
a comment in the guard's own header saying so, because the next person to widen this will look there
first.

### 4.4 `src/config/schema.ts:60-64` — the silence must not come back

The enum exists because *"Pi's `--tools` does no validation"*. §0.2 row 7 measured that this is
still true in 0.79.6 and is true of extension tool names too. **Any mechanism that lets a role
request `submit_report` must refuse `submit_reprot` loudly**, and §6.6 is the whole of that
requirement.

### 4.5 `fleet.yaml:816-830` — an agent may not dispatch

The `triage` role's tool comment is the sharpest statement of the fleet's capability discipline:
*"NO `bash`, and here that is the load-bearing omission… A shell is exactly what turns a
request-WRITING worker into a DISPATCHING one."* **A custom tool is a capability grant.** Every tool
in §6.2 is specified with what it *refuses*, and §5.2 refuses outright the tools that would be
convenient and would move authority.

---

## 5. Scope and non-goals

### 5.1 In scope

- One extension, shipped in the worker image, loaded by `--extension`, serving **all** roles that
  produce a report — `observer`, `triage`, `collator`, `reviewer`, `engineer`, `tester`, `verifier`,
  `sre`, `ticketing` — with per-role gating by declared tool names (§6.1).
- Two tools: `submit_report` and `get_replies` (§6.2). A third, `get_task`, is argued and **refused**
  (§6.2.3).
- Four layers against the silent settle, ordered and honestly labelled (§6.3).
- A closed declaration mechanism for extension tool names (§6.6).
- One new host contract: the declared reply set (§7.4).
- Migration of `roles/*.md` from mechanics to judgement, with both routes live during rollout (§8).

### 5.2 Non-goals — refused rather than omitted

- **A tool that dispatches, steers, aborts or notifies.** `fleet.yaml:816-830`, §4.5. The whole point
  of the `triage` role's shape is that it *requests* and does not *act*.
- **A tool that reports the host's verdict back to the worker.** It would let a worker branch on its
  own grade.
- **A tool that reads `/policy/dispatch` or the ledger.** Both are integrity surfaces for the
  verbgate; a tool over them is a second reader with different sanitization.
- **Replacing the result envelope file with a tool return value.** §6.5, §4.1. The file is what the
  host counts, and it stays.
- **`--no-tools` (`-nt`) anywhere.** It disables extension tools too (`sdk.js:132`, `noTools === "all"`
  ⇒ `allowedToolNames = []`), so it would silence this design completely. Named because `-nt` and
  `-nbt` differ by one letter and one of them is fatal here.
- **Enumerating `/replies`.** Finding E, `src/run/replies.ts:24-30`.
- **An extension that reads or rewrites the system prompt.** `before_agent_start` can
  (`types.d.ts:760-764`), and a design that quietly edited briefs would make the rendered envelope —
  the thing `Docs/SRD-TRIAGE-CONSOLE.md` §7.2 audits for four forbidden classes — no longer the thing
  the model saw.

### 5.3 Deliberately deferred

- **Custom rendering** (`renderCall`/`renderResult`). Cosmetic; every seat is `tui` today
  (`triage/console.yaml`, the `recycle_after_sweeps: 0` block) so it would be visible, and it is still
  not worth a line of the first version.
- **A tool for the fan-out request.** `dispatch-request.json` is already schema-validated host-side
  with twelve refusal codes (`src/run/dispatch-request.ts`), so the marginal value is lower than for
  the envelope and the blast radius is higher. Revisit after §11 Q4.
- **Extending this to `ticket-ops`' artifact pair.** It is the one artifact contract that already has
  a host-side clamp (`src/harvest/reconcile.ts:175`, `:202-204`, `:745-765`), so it is the least
  broken and belongs last.

---

## 6. The design

### 6.1 One extension, gated by declaration

**One file, `docker/pi-extensions/report-tools.ts`, baked into the image, loaded unconditionally**
for every worker — the same shape as `truncation-recovery.ts` (`render.ts:256`). It registers both
tools always. **Whether a given worker can *see* them is decided entirely by `--tools`**, which is
already per-role config and which §0.2 measured as an exact filter.

That is the whole gating mechanism, and it is deliberately the one that already exists:

- `observer` declares `submit_report` and not `get_replies` — it has no `/replies` to read.
- `triage` and `collator` declare both.
- `reviewer`, `engineer`, `tester`, `verifier`, `sre` declare `submit_report` only.
- Any role that declares neither is launched with `--tools` naming neither, and both tools are
  removed from its registry (§0.2 row 2). **The failure mode of "loaded but not wanted" is therefore
  the null case rather than a special case.**

**Why one extension and not one per tool.** Two files means two entries in `BUILD_CONTEXT_ASSETS`,
two `--extension` flags, two structural type declarations to keep in step with the image, and two
places for the shared path-derivation logic to diverge. `truncation-recovery.ts` and
`dispatch-trigger.ts` are separate because they have unrelated triggers and unrelated lifetimes;
these two share dispatch state and a lifetime.

**Why not extend `truncation-recovery.ts`.** Its subject is a `tool_result` middleware and its
integration test asserts that shape. Merging a tool registry into it would make one failure mode
into two.

### 6.2 The tool surface

Every tool is specified with its schema, what it does, and — the part that matters — **what it
refuses**. Refusals throw, because `docs/extensions.md` §Tool Definition is explicit: *"To mark a
tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an
error from `execute`. Returning a value never sets the error flag."*

Parameters use `Type` from `typebox` and **`StringEnum` from `@earendil-works/pi-ai` for every
enum**, on the doc's own instruction: *"Use `StringEnum` … `Type.Union`/`Type.Literal` doesn't work
with Google's API."* This fleet runs oMLX and Ollama Cloud today, but a schema that is wrong for one
provider is a latent defect and the correct spelling costs nothing.

**AMENDED 2026-09-08, during Phase 2.1: the IMPORTS are not available and the SPELLING is what
matters.** Phase 0 measured that `typebox` resolves from `/opt/pifleet/` **inside the image**, and
that is true and is not enough: `typebox` and `@earendil-works/pi-ai` are **not in this repo's
`node_modules` at all**, so a top-level import of either makes the file unimportable from `test/`
and makes task 2.1's own acceptance — *"the whole file loads"* — unprovable on the host. The
paragraph above was written from the image's resolution and read as a requirement about the source
text.

The tools therefore declare `parameters` as a **JSON Schema literal**, which `@earendil-works/pi-ai`
handles as a first-class shape rather than tolerating: `dist/utils/validation.js:257` branches on
`!hasTypeBoxMetadata(parameters) && isJsonSchemaObject(parameters)` and runs an additional
JSON-Schema coercion pass for exactly that case. Probed in
`pifleet/pi-worker:0.79.6-base-b722edcf4699`: valid arguments pass, a bad enum value is refused with
*"must be equal to one of the allowed values"*, and a missing required field with *"must have
required properties status"*.

**The `StringEnum` instruction survives intact, because it was never about the import.**
`StringEnum(["success","partial"])` returns `{"type":"string","enum":[…]}` — byte-identical to the
literal. What the doc is really forbidding is the `anyOf`/`const` spelling that `Type.Union` of
`Type.Literal` produces, and that Google's API rejects. So the requirement is a property of the
emitted schema, and it is asserted as one: a test refuses `anyOf` and `const` anywhere in the
declared parameters.

#### 6.2.1 `submit_report`

```ts
parameters: Type.Object({
  status:   StringEnum(["success", "partial", "blocked", "failed"] as const),
  summary:  Type.String({ maxLength: 4000 }),
  notes:    Type.Optional(Type.String({ maxLength: 20000 })),
  blockers: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 64 })),
  artifacts: Type.Optional(Type.Array(Type.Object({
    kind: StringEnum(["file", "diff", "log", "note"] as const),
    path: Type.String({ maxLength: 4096 }),
  }), { maxItems: 64 })),
  acceptance: Type.Optional(Type.Array(Type.Object({
    criterion: Type.String({ maxLength: 4000 }),
    met:       Type.Boolean(),
    evidence:  Type.Optional(Type.String({ maxLength: 20000 })),
  }), { maxItems: 64 })),
  commands_run: Type.Optional(Type.Array(Type.Object({
    cmd:       Type.String({ maxLength: 4000 }),
    exit_code: Type.Integer(),
    excerpt:   Type.Optional(Type.String({ maxLength: 20000 })),
  }), { maxItems: 64 })),
  report: Type.Optional(Type.Array(Type.Object({
    filename: Type.String({ maxLength: 255 }),
    content:  Type.String(),
  }), { minItems: 1, maxItems: 4 })),
}),
```

**What it does.** Reads `/policy/task` for `task_id` and `epoch`; composes a `pifleet.result/v1`
envelope by adding `schema`, `task_id`, `epoch` and `worker` **from host-written state, never from
parameters**; writes `/outbox/<task-id>/result.json` atomically; and, when `report` is present,
writes `/outbox/<task-id>/files/<filename>` for **each of its entries** first and appends a matching
entry to `artifacts` for each, so the declare-what-you-wrote rule cannot be forgotten. **That rule has
since stopped being addressed to the model at all**, which is this paragraph's claim landing:
`roles/reviewer.md` carried the imperative *"And DECLARE the file in the envelope's `artifacts`
array"* when this was written, `b94c58b` deleted it as redundant against `composeEnvelope`, and what
stands in its place states the outcome — *"`submit_report` declares it for you, so the envelope claims
the review without you naming it anywhere"*.

**`report` is a LIST and the cap is FOUR, which is not `maxItems: 64` and must not become it.**
Three of this fleet's artifact contracts are two files, and a role that has lost `write` has no
other route to the second — §7.1's own example entry already claims
`["observer-ops.json", "observer-ops.md"]`, which the single-object shape could never have produced.
The other `maxItems` on this schema bound REFERENCES, which cost a line each; this one bounds
CONTENT, and every file it admits is bytes inside the same tool argument as all the others. §11 Q8
measured `gemma` delivering 3 219 of 8 192 bytes with `isError` false and the epoch `success`, and
nothing inside `execute` can detect having crossed that floor — so the only lever available here is
to keep the number of things in one call small. **Two entries naming one file are REFUSED**, not
overwritten: both writes would succeed, the second landing on the first, and the envelope would
claim the name twice, so an operator would read a report naming two artifacts, find one file, and
have no way to learn the other half was overwritten rather than never composed. Returns
`{ content: [{ type: "text", text: "Report delivered: <n> bytes at <path>." }], details: { path, bytes, status }, terminate: true }`
and calls `pi.appendEntry("pifleet.submit/v1", …)` with **§7.1's eight fields** — the five above
plus `schema`, `worker` and `artifact_files`.

**CORRECTED 2026-09-08, by the engineer building 3.2, who followed §7.1 rather than this line.**
This sentence listed five fields and §7.1's example carries eight; a reader who trusted the prose
over the example would have shipped an entry missing the worker id and the file list — the two
fields that make the entry useful to somebody who has four seats and a missing report. §7.1 is
authoritative for the shape, and this line is now a pointer to it rather than a second copy of it.
**`artifact_files` is the ENVELOPE's claim list, not the call's**, and the two differ by exactly the
file the tool wrote itself; it is carried verbatim rather than by basename, since `files/notes.md`
and `/workspace/notes.md` are both `notes.md` once the directory is gone and §6.2.1 admits both.

**Note four fields are absent from the schema and are the point.** `schema`, `task_id`, `epoch` and
`worker` are not parameters. `skills/pifleet-worker/SKILL.md`'s `epoch` bullet — *"it is delivered to
you — read it, never guess it"* — spends sixteen lines telling a model to copy that number off its
prompt, including a recorded reversal of earlier guidance, and `src/harvest/outbox.ts:721-724`
refuses envelopes whose `task_id` or `epoch` disagree with the location. **Sixteen lines of prose and
two host-side refusal codes exist to protect two numbers the extension can read out of a file the
worker cannot write.** It was thirteen lines when this was written; `f06615f` added three more to say
that on the `submit_report` route passing the number *"is a validation error rather than a value that
reaches the file"* — the prose growing to describe the tool that was supposed to retire it.

**What it refuses, each as a thrown error naming the fix:**

| Refusal | Message shape | Why |
|---|---|---|
| `status` not in the enum | typebox validation, before `execute` | The `rev-lang-1` defect (§1.1) at the call site instead of in a collation brief |
| `/policy/task` reads `<none>` | *"No task is live. `/policy/task` says `<none>`."* | `task-policy.ts:51`. Delivering into an idle worker's outbox is a fabrication |
| `report.filename` containing `/`, `..`, or a leading `@` | *"`filename` is a bare name inside `files/`, not a path."* | `src/harvest/outbox.ts:727-734`'s escape refusal, moved to the call site. The `@` normalization is `docs/extensions.md`'s own warning: *"Some models are idiots and include the @ prefix in tool path arguments"* |
| `artifacts[].path` resolving outside the task's outbox **OR the worktree** | *"artifact `<p>` escapes the task outbox and worktree."* | **CORRECTED 2026-09-08, during Phase 2.1, by the engineer building it.** The row said *"outside `/outbox/<task-id>/`"* and justified itself as *"same host refusal, same reasoning"* — and it was not the same refusal. `artifactPathProblem` (`src/harvest/outbox.ts:519-541`) accepts EITHER: `if (!inOutbox && !inWorktree)`. Built as written, the tool would refuse an `engineer` naming `/workspace/patch.diff` that the host accepts, which is §6.5 property 2 inverted — *"the tool's validation is a courtesy to the model; the host's is the one that decides"* only holds while the courtesy is the LOOSER of the two. A tool stricter than the host is a second, undocumented policy. |
| A second call in the same epoch | **Allowed, and it overwrites.** Not a refusal | `roles/observer.md:56-58`: *"Write it, then keep going… A first version on disk at call twenty and a second at call forty is strictly better than one perfect version that never lands."* The tool must not punish the behaviour the prose begs for |
| Total serialized envelope over `MAX_ITEMS`-equivalent caps | *"`<field>` has `<n>` entries; cap is `<m>`."* | `src/harvest/outbox.ts:680-698` hoists this pre-schema because 2,097,101 elements cost 2.66 GB in zod. The call-site cap makes the host's hoist a second line of defence rather than the first |

**What it deliberately does NOT refuse: a `status` the host will later downgrade.** A worker may
report `success`; the harvest may return `failed`. `skills/pifleet-worker/SKILL.md:131-142` —
*"Your report is a claim, not a verdict… It can never **upgrade** it."* A tool that pre-empted the
lattice would be deciding.

#### 6.2.2 `get_replies`

```ts
parameters: Type.Object({}),
```

**No parameters, and that is the design.** It returns the replies the **host declared** for this
task (§7.4), reading each named file from `/replies` — never a `readdir` (Finding E,
`src/run/replies.ts:24-30`). Returns one text block per reply plus
`details: { replies: [{ task_id, worker, aspect, bytes, ok }], missing: [...] }`, and the text block
for a missing declared reply says so explicitly rather than being omitted, because
`roles/triage.md` already distinguishes (**near `:324`; this cited `:299-312` until 2026-09-11, a range that lands on the `/replies/<child-task-id>.json` material instead**) *"No report was produced"* from *"A report was
produced and could not be read"* and losing that distinction would cost the collation its vocabulary.

**What it refuses:**

| Refusal | Why |
|---|---|
| Returning any file not in the declared set | Finding E: a standing console's `/replies` holds every sweep of the day |
| Returning a file that fails to parse as JSON, silently | It returns it as `{ ok: false, error }`. `e5d5751` is the recorded case of a right answer to the wrong document; an unreadable reply must read as unreadable |
| Being callable when the declared set is absent | Throws *"No replies were declared for this task."* — which is the correct and complete answer for a turn-one dispatch, and is exactly what `roles/triage.md` spends a paragraph saying, opening *"So checking cannot tell you anything"*. **(Read `:266-271`, "six lines of prose", until 2026-09-11; `:266` is a blank line and `:266-271` is the `summary` rule, a different subject. This is the second site carrying that stale range — `c61857c` de-numbered the copy in `report-tools.ts` and left this one and `:1204`.)** |

**This tool's value is not that it reads better than `read`.** It is that **the host now knows
whether the collator looked**, because a `get_replies` call is a tool call the extension can record.
Defect 6 was a collator that made zero tool calls; under this design that is a turn in which
`get_replies` was never invoked, which is a fact rather than an inference from a transcript.

#### 6.2.3 The case for `get_task`, and why it is refused

**The case for.** It would let the extension hand the model a typed task id, epoch, outbox path and
declared service list, replacing another slab of `roles/*.md` mechanics. It is the natural third tool
and it would be easy.

**The case against, which wins.**

1. **The model already has the brief.** `--append-system-prompt /briefing/system-append.md`
   (`render.ts:264`) plus the supervisor's `## This task` block (`src/supervisor/index.ts:3361-3395`)
   put the task in front of the model without a tool call. `get_task` would be a second copy of the
   same information, and `Docs/SRD-TRIAGE-CONSOLE.md` §7.8's argument against writing defaults into a
   tracked file applies unchanged: *"a value that must always equal a function of two others is one
   that will one day disagree with them."*
2. **It rewards the wrong turn shape.** `roles/collator.md` — under *"MEASURED, on the run this step
   was written for"* (**`:172-176`; this cited `:159-168` until 2026-09-11, which is the turn-two
   "new prompt" passage, a different subject**) — records a collator that *"spent
   its last twelve tool calls listing `/replies`, searching `/replies`"*, and `roles/triage.md` (**near `:289`, wrapped across lines; this cited `:273-278` until 2026-09-11, which is the "give it a status and one sentence" passage. Note the quoted sentence appears VERBATIM in two files — `roles/triage.md` and `roles/collator.md:73` — so a phrase pin alone does not disambiguate it here, and the file name is doing the work**)
   records a worker that *"read one file and grepped one document nine times in twenty seconds, wrote
   nothing, and burned a hundred and forty thousand tokens."* **Adding a free, safe, always-succeeds
   tool to a fleet whose measured failure is tool-thrash is adding fuel.**
3. **It is not needed for correctness.** The values it would return are the ones `submit_report`
   already reads for itself, from the same file, without a turn.

**Refused. If §11 Q5 measures that models cannot find the task id in the brief, this is the first
thing to revisit** — but it is refused now, on evidence, rather than added because it completes a
triad.

### 6.3 What happens when a turn ends without `submit_report` — four layers, one of which is a mechanism

**There is no veto (Finding B, §2.3).** What follows is ordered strongest-first and each layer is
labelled with what it actually is.

**Layer 1 — MECHANISM. Remove `write` from the roles that hold no `bash`.**
For `triage`, `collator`, `reviewer` and `verifier`, `submit_report` becomes the only way to create
any file at all. `fleet.yaml:687`, `:718`, `:831` give all three of the first `[read, write, grep,
find, ls]`; dropping `write` and adding `submit_report` leaves `[read, grep, find, ls,
submit_report]`. **A model in that seat cannot hand-write an envelope, cannot write a file called
`notes` (`src/contracts.ts:203-216`), cannot write a 1599-byte envelope with a fifth status, and
cannot produce a `.md` without a `.json`.** The failure modes those three recorded defects belong to
become unrepresentable rather than discouraged.

**This is the whole of the structural claim and it does not extend to the observer**, which holds
`bash` for `kubectl` (`fleet.yaml:534`) and can therefore always `cat > /outbox/...`. §6.8 works the
per-role split through and §10 D4 records the asymmetry as a cost.

**Layer 2 — INCENTIVE. `terminate: true`.** `submit_report` returns it, so delivering is the
cheapest possible way to end a turn: no follow-up LLM call, no further tokens. It makes the right
action the lazy action. It does nothing about a model that stops for other reasons.

**Layer 3 — PRESSURE. A bounded `agent_end` re-prompt.** On `agent_end`, if `submit_report` was not
called for the current `(task_id, epoch)`, the extension calls `pi.sendUserMessage` once with a fixed
host-authored string naming the omission and the tool. **Bounded to one nag per epoch**, with the
bound held in memory and MIRRORED through `pi.appendEntry` — for the HOST's benefit, not the
extension's.

**CORRECTED 2026-09-08 during Phase 4: the mirror does NOT survive a `/reload`, and this line said
it did.** `appendEntry` returns `void` and §7.6's surface has no read-back — verified against the
image's own `types.d.ts:871` rather than argued — so a reloaded extension starts with an empty
tally and may nag a second time for the same epoch. What the mirror actually buys is that the host
can see the nag happened; it is not state this file can rehydrate. **`MAX_NAGS = 1` is also not a
constant in the built code, deliberately**: the bound is the boolean `nagged` that §7.2's entry
already declares, and a counter whose only legal values are 0 and 1 sitting beside a boolean that
says the same thing is two spellings of one rule.

Four constraints on this layer, each of which is a way it could go wrong:

- **The message is a constant in the extension, not composed from anything the model produced.**
  `Docs/SRD.md` §12.6 and `Docs/SRD-TRIAGE-CONSOLE.md` §4.3. Re-feeding a model its own text through
  a host-shaped channel is the thing `5dbdafe` was fixing.
- **One nag, not a loop.** An unbounded re-prompt against a model that will never call the tool is
  an infinite spend against a token ceiling that ends the run on exit 5
  (`Docs/SRD-TRIAGE-CONSOLE.md` Finding C).
- **It must not fire on a turn that legitimately has nothing to report.** The extension nags only
  when `/policy/task` names a live task and this epoch has seen at least one tool call — an idle
  worker between dispatches must be left alone, and so must a worker whose brief was a question.
- **Its interaction with the supervisor's quiesce tracker is unmeasured.** `src/supervisor/index.ts:1216`
  confirms quiescence with two agreeing `get_state` probes; a message injected at `agent_end` should
  keep the session non-idle and prevent that agreement. **If it instead pushes the task past its
  deadline into `timed_out`, that is a strict improvement** — `timed_out` is not `success` and
  `joinSweep` already distinguishes it (`triage-envelope.ts:1141`). **If it does nothing, layer 3
  buys nothing.** Q1.

**Layer 4 — EVIDENCE. A host-readable record of the omission.** Whether or not the nag works, the
extension writes `pi.appendEntry("pifleet.submit/v1", …)` on delivery and
`pi.appendEntry("pifleet.no_submit/v1", …)` — **§7.2's seven fields**, not the four this line used
to list — at `agent_end` when nothing was delivered. (CORRECTED 2026-09-08 during task 3.3, the
second time this document has spelled an entry short beside an authoritative example; §7.1 and §7.2
are the shapes, and these prose mentions point at them.) Session entries land in the JSONL under `/sessions`, which is bind-mounted
**read-write from the run tree** (`render.ts:513`), so the host can read both without a new mount and
the model never sees either (`types.d.ts:871`: *"not sent to LLM"*).

**This is what turns Finding G from a `console.error` into a fact with a producer.**
`SweepJoin.claimedSuccess` currently infers *"the worker said it was done and wrote nothing"* from
the absence of a file and the presence of a `success` verdict. With layer 4 the host can distinguish
*the worker never called the tool* from *the worker called it and the write failed* — and those send
an operator to different places, which is the exact argument `triage-pass.ts:243-249` makes about
`coverage` versus `claimedSuccess`.

**Layer 4 is diagnosis and may not become authority.** §6.5.

### 6.4 Dispatch state — held by reading, not by reciting

The extension holds, per call, from host-written sources only:

| Field | Source | Why not the prompt |
|---|---|---|
| `task_id` | `/policy/task` line 1 | `task-policy.ts:15-28`, Finding D. The worker cannot write it; the model cannot forge it |
| `epoch` | `/policy/task` line 2 | Same. Replaces the sixteen lines of `skills/pifleet-worker/SKILL.md`'s `epoch` bullet — *"read it, never guess it"* |
| `worker` | `--session-id` is `w.id` (`render.ts:203`); read from `ctx` or the session path | Already unforgeable |
| `outbox_dir` | derived: `/outbox/<task_id>` | `/outbox` is the mount (`render.ts:481`); the task id is above. **No new contract** |
| `files_dir` | derived: `/outbox/<task_id>/files` | `SWEEP_FILES_DIR` (`triage-envelope.ts:116`), `OUTBOX_FILES_DIR` |
| `envelope_path` | derived: `/outbox/<task_id>/result.json` | `RESULT_ENVELOPE_NAME` (`src/contracts.ts:217`) |
| **`replies[]`** | **`/policy/replies`, new (§7.4)** | **Not derivable.** Finding E |

**Five of seven need no new host contract.** That is the design's best property and it is worth
saying plainly: the reason the extension can hold dispatch state at all is that this fleet already
decided, for the verbgate's sake, that task provenance travels as a host-written read-only file
rather than as environment or prose.

**Why holding beats re-deriving in prose**, in one sentence each:

- **It cannot drift.** `roles/triage.md`'s three-observer table has already drifted from its own
  one-observer section (§2.6).
- **It cannot be mis-copied.** The thirteen-line epoch paragraph exists because it was.
- **It is checkable by a test.** A fixture writes `/policy/task`, calls the tool, and asserts the
  bytes on disk. No fixture can assert that a model copied a number correctly.
- **It shrinks the prompt.** §8.

**And what holding it does NOT buy, restated because §1.3 matters more than this section:** the host
still derives its own paths, on its own side of the mount, and defects 1-4 were errors in that
derivation. **The extension makes the worker's half unforgeable. It does not check the host's half,
and nothing here should be read as if it did.**

### 6.5 Authority — `submit_report` is a delivery mechanism, and here is the fence

**The rule, restated so it can be quoted:** *the number the loop branches on is the one the host
counted, never the one the worker claimed.*

**How this design keeps it, as four properties that must each be independently testable:**

1. **The tool writes a file; the host reads that file.** `submit_report`'s return value reaches the
   model and the session transcript and **nothing else**. No host code reads a tool result.
2. **The host re-validates.** `ResultEnvelopeSchema.safeParse` (`src/harvest/outbox.ts:703`) and
   `readObserverArtifactAt` run unchanged, on the host, against the bytes on disk. **The tool's
   validation is a courtesy to the model; the host's is the one that decides.**
3. **`pifleet.submit/v1` and `pifleet.no_submit/v1` are diagnostic only.** They may appear in an
   actor log, in `pifleet monitor`, and in `claimedSuccess`'s message. They may not appear in a
   verdict, a coverage count, an incident transition or a notification.
4. **A worker that calls `submit_report` and whose file does not land is counted as having produced
   nothing.** Exactly as today.

**The drift this fence is built against is specific and attractive**, which is why it gets an
anti-criterion rather than a paragraph: once `pifleet.submit/v1` exists in the session, somebody will
notice that reading it is cheaper than re-reading the outbox, and the sweep's coverage count will
quietly start branching on a worker's claim. §12 pins that with a mutation.

### 6.6 Declaring extension tool names without reintroducing the silence

**Requirement (§4.4).** A role may request `submit_report`; a role that requests `submit_reprot` must
fail `pifleet config validate` loudly rather than be silently granted nothing.

**The design.** A second closed vocabulary beside the first, in the same file, with the same
argument:

```ts
/**
 * Tools registered by `docker/pi-extensions/report-tools.ts`, exactly. Closed for
 * PI_BUILTIN_TOOLS' reason and for one more that was measured rather than inherited:
 * `--tools` filters the EXTENSION registry too, so a name that does not exist is
 * silently granted nothing AND a name that is omitted silently deletes a tool that
 * does exist (SRD-WORKER-DISPATCH-EXTENSION §0.2, measured 2026-09-07).
 */
export const PI_EXTENSION_TOOLS = ["submit_report", "get_replies"] as const;
export const PI_ALL_TOOLS = [...PI_BUILTIN_TOOLS, ...PI_EXTENSION_TOOLS] as const;
```

`ToolNameSchema` becomes `z.enum(PI_ALL_TOOLS)`, so `tools:` and `exclude_tools:`
(`schema.ts:119-120`) accept the union and refuse everything else. `render.ts:260` is **unchanged** —
it already joins whatever `w.tools` holds — which is the property that makes this a schema change
rather than a rendering change.

**Two interactions that must be handled in the same edit, or this is a regression:**

1. **ISC-59's `effective()` must not treat an extension name as a built-in.**
   `schema.ts:1582-1592` resolves an omitted `tools:` to `PI_BUILTIN_TOOLS` before the
   `read_only`/`bash` cross-check. That default must stay `PI_BUILTIN_TOOLS` and **not** become
   `PI_ALL_TOOLS`, because an omitted `tools:` means "Pi's own defaults", and Pi's own defaults do
   not include a tool this repository invented. Getting this wrong makes the guard reason about a
   grant that was never made. **§12 pins it.**
2. **A new warning: a role that declares `submit_report` and also `write`.** Not an error — the
   observer needs exactly that combination for as long as it needs `bash` — but a config warning in
   the shape of `observerTuiEpochWarning` (`schema.ts:1841-1851`), because for the four bash-less
   roles that combination silently forfeits layer 1, which is the only mechanism in §6.3.

**Rejected: a free-string `extension_tools:` list.** It is the enum's own counter-argument, and
§0.2 row 7 is the measurement.

**Rejected: deriving the tool list from the extension at build time.** Attractive, and it would make
drift impossible — but a build-time derivation step is exercised by neither `bun run typecheck` nor
the suite, and a build step that CI does not run is a second silence. (**The reason given here used to
be that `docker/pi-extensions/` is outside `tsconfig.json`'s `include`. It is outside `include`, but
that is NOT why — see §3.2's correction: the file is pulled into the program transitively by its own
unit test and is typechecked. The rejection stands on the build STEP being unexercised, which is a
different and still-true argument.**) **§12's integration test closes the loop from the other end
instead**: it asserts that the names in `PI_EXTENSION_TOOLS` are exactly the names the real image
registers, which is a check that runs where the truth is.

### 6.7 Staging — baked, `--extension`, and the array that must not be forgotten

**D1: baked into the image, loaded by `--extension`.** Four arms were considered:

| Arm | Verdict |
|---|---|
| `~/.pi/agent/extensions/` auto-discovery | **Refused.** `render.ts:208` passes `--no-extensions`; and `/home/pi/.pi/agent` is a per-worker named volume (`render.ts:600`) that would shadow the image's copy with whatever a prior image left there |
| `.pi/extensions/` project-local | **Refused.** Requires a project and its trust; five roles run `isolation: none` and have no `/workspace` |
| Run-tree mount, `<run>/extensions/<role>:/extensions:ro` | **Refused, though it works.** It mirrors `materializeRoleSkills` (`materialize.ts:518`) exactly and would allow per-role extension sets — but §6.1's gating is `--tools`, which is better, and a second staging mechanism for no capability is `Docs/SRD-TRIAGE-CONSOLE.md` D4's cost paid twice |
| **Baked, `COPY --chmod=0444`, `--extension /opt/pifleet/report-tools.ts`** | **Taken.** Two files already do this |

**The image-tag consequence, and it is the one thing that will actually go wrong.** The new file must
be appended to `BUILD_CONTEXT_ASSETS` (`src/container/image.ts:102-134`) or the tag does not move
(`:231-240`, `:242-245`) and `up` reuses an image without the extension in it. `image.ts:200-202`
names this fail-open as ISC-270 and the Dockerfile carries the reminder above each `COPY`
(`:413-415`, `:433-435`, `:444-445`). **§13 task 2.3 is one line of code and is the single highest
risk-per-character task in this document.** §12 asks for a criterion whose probe is that adding the
file *without* the array entry leaves the tag unchanged — i.e. the mutation that reddens is the
omission itself.

**One measured detail worth recording**, because it is the sort of thing that fails at 2am: the
probe extension in §0.2 was loaded from a `:ro` bind mount and jiti compiled it without complaint. A
TypeScript extension does not need a writable location.

### 6.8 The per-role split — where the lever is structural and where it is exhortative

| Role | `tools:` today | Proposed | Layer 1? |
|---|---|---|---|
| `triage` (`fleet.yaml:831`) | `read, write, grep, find, ls` | `read, grep, find, ls, submit_report, get_replies` | **Yes.** No `bash`, no `write` — `submit_report` is the only writer |
| `collator` (`:718`) | `read, write, grep, find, ls` | `read, grep, find, ls, submit_report, get_replies` | **Yes** |
| `reviewer` (`:687`) | `read, write, grep, find, ls` | `read, grep, find, ls, submit_report` | **Yes.** This is the `rev-lang-1` seat |
| `verifier` (`:550`) | `read, bash, grep, find, ls` | `read, bash, grep, find, ls, submit_report` | No — holds `bash` |
| `observer` (`:534`) | `read, write, bash, grep, find, ls` | `read, bash, grep, find, ls, submit_report` | **No** — holds `bash`. Layers 2-4 only |
| `engineer` (`:593`), `sre` (`:508`), `ticketing` (`:623`) | full sets incl. `bash`, `edit` | `+ submit_report`, nothing removed | No |
| `tester` (`:766`) | `read, bash, grep, find, ls` | `+ submit_report` | No |

**The observer row is the honest one and deserves its own paragraph.** Dropping `write` from a role
that keeps `bash` removes a tool and not a capability: `cat > /outbox/…/observer-ops.json` is two
seconds of shell. It is proposed anyway, for a smaller reason that is still a reason — the failure
recorded at `roles/observer.md:19-22` is a model reasoning *about which tools it holds* and
concluding wrongly, and a seat whose only writing verb is named `submit_report` gives that reasoning
less room. **But it is not layer 1, this document will not call it layer 1, and §10 D4 records that
the defect with the most measurements behind it (45 consecutive passes, three models) is the one this
design attacks with its three weakest layers.**

**Two consequences of the removals that must be checked rather than assumed.** First, a reviewer
without `write` cannot produce `review.md` by hand — hence `submit_report`'s `report` parameter
(§6.2.1), which writes the long document and declares it in one call, absorbing the whole of
what were then `roles/reviewer.md:45-144` — the four envelope sections. **That absorption has since
happened**: `b94c58b` (task 8.1) deleted the block, the file went from 168 lines to 113, and the
obligation it spelled out is now two sentences saying the tool does it. Second, an `edit` grant
becomes meaningless for those roles, which is already true and already argued at
`fleet.yaml:682-686`.

### 6.9 The other two consoles, and `development`

**The commission asks whether this should apply to the review console. It should, and the review
console is where the argument is strongest, not weakest.**

The `rev-lang-1` defect is a `status` enum violation. `StringEnum(["success","partial","blocked","failed"])`
makes it unrepresentable, and typebox rejects it **before `execute`** — in front of the model, with
`isError: true`, while the model still has turn budget. Compare the current path: 1599 bytes are
written, the task settles, the harvest parses on the host minutes later
(`src/harvest/outbox.ts:703-713`), and the model that could have fixed it in one call is gone. **And
`reviewer` holds no `bash`** (`fleet.yaml:682-686`), so layer 1 is available there in full — unlike
the observer.

`development` (`engineer`, `tester`) gets `submit_report` and keeps every tool it has. Layer 1 is
unavailable and unwanted: an engineer's deliverable is a git diff, not a file in an outbox, and it
holds `bash` and `edit` for good reasons.

**What is shared and what is per-role**, stated so the implementation does not fork:

| Shared | Per-role |
|---|---|
| The extension file, one copy, in the image | Which tools are visible — `--tools`, §6.1 |
| `submit_report`'s schema, refusals and envelope composition | Whether `write` is removed — §6.8, and only where `bash` is absent |
| `/policy/task` reading and path derivation | Whether `get_replies` is granted — collator and triage only |
| Layers 2, 3 and 4 | The `report` parameter's conventional filenames — `review.md`, `observer-ops.{json,md}`, `triage.json` — which are **prose in the role file**, not schema fields, because they are a naming convention rather than a contract |

**One thing is deliberately NOT per-role: the envelope schema.** `pifleet.result/v1` is one contract
(`src/contracts.ts:219-235`) and every role writes it. A per-role envelope would be four schemas
drifting.

---

## 7. Contracts

### 7.1 `pifleet.submit/v1` — the session entry, new, diagnostic

```json
{ "schema": "pifleet.submit/v1", "task_id": "T-sweep-7-slice1", "epoch": 12,
  "worker": "obs-t1", "status": "success", "bytes": 2841,
  "artifact_files": ["observer-ops.json", "observer-ops.md"], "at": "2026-09-07T23:41:02Z" }
```

Written via `pi.appendEntry`. **Read by the host for diagnosis only** (§6.5 property 3). Lands in the
run's session JSONL under `<run>/sessions` (`render.ts:513`, `src/run/paths.ts:207`).

### 7.2 `pifleet.no_submit/v1` — the session entry, new, diagnostic

```json
{ "schema": "pifleet.no_submit/v1", "task_id": "T-sweep-7-slice1", "epoch": 12,
  "worker": "obs-t1", "tool_calls": 150, "nagged": true, "at": "2026-09-07T23:44:19Z" }
```

`tool_calls` is the count for this epoch, because it is the field that separates defect 5's two
measured shapes — the `gpt-oss-20b` that ran one `ls` and quit, and the `gemma-4-26b` that made 150
`kubectl` calls. **Those are different failures and an operator should not have to open a transcript
to tell them apart.**

### 7.3 `pifleet.result/v1` — existing, unchanged

`src/contracts.ts:219-235`. The extension composes it and the host parses it exactly as today. **One
observation for whoever implements this:** the schema is **not** `.strict()`, so unknown keys are
stripped rather than refused. The tool must therefore not rely on an extra field surviving the round
trip, and must not add one.

### 7.4 `/policy/replies` — NEW, and the one host contract this document proposes

**Why it is needed.** Finding E: `/replies` accumulates across sweeps, so `get_replies` cannot
enumerate. The set must be declared.

**Shape.** A host-written, `:ro`, inode-stable file at `/policy/replies`, following
`task-policy.ts`'s recipe exactly (chmod 0644 → truncate in place → chmod 0444, never rename —
`replies.ts:41-50`, `task-policy.ts:33-41`), rewritten at each dispatch alongside `/policy/task`:

```json
{ "schema": "pifleet.replies/v1", "task_id": "T-sweep-7-collate",
  "replies": [ { "task_id": "T-sweep-7-slice1", "worker": "obs-t1", "aspect": "slice1",
                 "path": "/replies/T-sweep-7-slice1.json" } ] }
```

**Empty array on a turn-one dispatch**, which is what makes `get_replies` able to answer *"nothing was
declared"* instead of *"the directory is empty"* — the distinction
`roles/triage.md` and `roles/collator.md` each spend a paragraph establishing — both opening *"So checking cannot tell you anything"*. **(Corrected 2026-09-11: this cited `roles/triage.md:266-271` and `roles/collator.md:153-158`, neither of which resolves — `:266-271` is the `summary` rule, a different subject, and the real material sits at `:281-283` and `:164-168` respectively. `c61857c` de-numbered the identical claim in `report-tools.ts` and left this twin and the one in `replies-policy.ts` numbered.)**

**Where the host writes it.** The same composition roots that already publish the replies:
**one function**, `productionRelayEffects.publishReplies` in `src/run/relay.ts` — reached by the
review console through `fanOut` -> `RelayTransport.publishReplies` and by the triage console through
`cli/index.ts`'s `publishRepliesFor`, which builds the same `consoleTransport`. (CORRECTED
2026-09-08 as task 5.3 was built: this named `relay.ts:2654` and *"the injected `publishReply` for
triage"* — two roots. **The port had to become SET-shaped for the criterion to be expressible at
all**, because a declaration is one document about one task's WHOLE set, so a per-child
`publishReply` could only ever be paired with a second declaring port and a turn calling one and not
the other is 9.6, invisible from the host side.) **Declaring and publishing must be one act**, so that the set a worker
can read is by construction the set the host published — which is the property that makes §12's
new fixture possible and which is the closest this design comes to touching defect 3's class.

**Rejected arms**, each with its reason:

| Arm | Why not |
|---|---|
| Extend `/policy/task` to three lines | Its reader is POSIX `sh` doing `sed -n 1p`/`2p` inside `verbgate` (`task-policy.ts:63-66`). Adding a line is *probably* compatible and "probably" is not a word this contract accepts |
| Reuse `/policy/dispatch` | *"Present and non-empty only when your task was **staged**"* (`skills/pifleet-worker/SKILL.md:18`). Collation turns are not staged |
| `readdir` and filter by task-id prefix | A derivation in code instead of prose — better, but still a derivation, and it breaks the moment a task id convention changes |
| Pass the set in the brief and have the tool parse it | The brief is worker-visible text; parsing it back is prose round-tripping with extra steps |

### 7.5 `PI_EXTENSION_TOOLS` — new, in `src/config/schema.ts`

§6.6. Closed enum, beside `PI_BUILTIN_TOOLS`, with `PI_ALL_TOOLS` as the union that
`ToolNameSchema` ranges over. **`schema.ts:1582-1592`'s `effective()` default stays
`PI_BUILTIN_TOOLS`.**

### 7.6 The extension's structural type declaration

`docker/pi-extensions/report-tools.ts` declares its Pi surface structurally, not by import
(`dispatch-trigger.ts:81-102`, `truncation-recovery.ts:119-124`), because the package is in the image
and not in this repository. The declared surface is `registerTool`, `on("agent_end")`, `on("tool_call")`,
`sendUserMessage`, `appendEntry`.

**`on("tool_call")` was ADDED 2026-09-08 by task 3.3, and the deviation is recorded because it was
forced rather than chosen.** §7.2 requires `tool_calls` and the four-member surface cannot produce it.
The only candidate within those four is `AgentEndEvent.messages`, and it is WRONG rather than merely
awkward: that array is the session's retained transcript, spanning every epoch a long-lived worker has
served and shortened by compaction — counting it would silently answer *"how many tool calls are still
in context"*, which is not the question §7.2 asks and would read plausibly forever.

**That handler is the one place in this extension where a diagnostic can break the thing it
diagnoses, and it was measured in the image rather than assumed** (verified independently
2026-09-08 in `0.79.6-base-51b82d0e7cad`): `dist/core/extensions/runner.js:639-657` calls
`await handler(event, ctx)` with **no `try`/`catch`**, unlike `emit` at `:522-534` which wraps it —
and `dist/core/agent-session.js:184-197` catches and RE-THROWS, an `Error` as-is and anything else
wrapped as *"Extension failed, blocking execution"*. So a throwing counter stops the worker running
tools at all. A truthy handler result carrying `block` is the same failure through another door,
since `:649-652` returns early on it. Hence a total `catch` and a bare return, both asserted.

**A drift check against the image's `.d.ts` is NOT what `report-tools-image.test.ts` shipped in task
2.5**, and this paragraph claimed it was. That file diffs Pi's tool registry across two runs and
pins the baked file's `sha256` to the tag — a real check of §9.1-9.3, and not this one. Nothing in
the tree compares the structural declaration to Pi's own type; see §3.2's correction.

---

## 8. Migration — what happens to `roles/*.md`

**The target: role prompts carry judgement, and mechanics live in the schema.** Not "shorter
prompts" as an aesthetic — Finding F counts the lines, and §2.6 shows two of them have already
drifted from the mechanism they describe.

**What comes out, per file, once `submit_report` is live:**

| File | Comes out | Stays |
|---|---|---|
| `skills/pifleet-worker/SKILL.md` | the *"Write it as ONE LINE"* rule and its bullets (the one-line/escaping rule — a tool takes structured arguments), the `epoch` bullet *"read it, never guess it"* (§6.4), the pretty-printed example (the `json` fence), and most of the *"Field rules, each of which is checked"* block | `:131-142` (**"Your report is a claim, not a verdict"** — this is judgement and is the most load-bearing paragraph in the bundle), the *"This is the last thing you do"* paragraph (why silence costs you the grading), the **"Choosing a status honestly"** table (which status *means* what — the enum constrains the spelling, not the choice) |
| `roles/reviewer.md` | **DONE 2026-09-10 (`b94c58b`, task 8.1).** What were `:45-144` — all four sections, ~62 lines — are deleted; the `report` parameter absorbed them and the file is 113 lines | `:15-45` (what a review is for, and how to rank and locate a finding) and the **"THE REFUSAL THAT IS NOT YOURS TO MAKE"** section, both kept as written |
| `roles/observer.md` | `:138-142` (filenames and directory), most of `:26-34` (the tool-permission disambiguation, which exists because `write`'s role was ambiguous) | `:39-58` — **the write-before-you-run-out-of-turn budget stays**, because it is a *judgement about pacing* that no schema expresses, and because §6.8 says layer 1 does not reach this role |
| `roles/triage.md` | The `triage.json` field-rule block — opening at *"Field rules. **They are not all enforced the same way, and each says which**"* — the largest single mechanics block in the repository. **(Read `:325-457`, "133-line", until 2026-09-11; that range predates `fe0735e` and no longer resolves.)** `:282-291` (reply paths). `:246-257` (envelope mechanics) | `:66-87`, `:293-323`, `:459-533` — what to do with what you read, and the notification boundary |
| `roles/collator.md` | `:170-254` (reply reading), `:255-346` (the `collation.json` schema) | `:9-26`, `:35-108`, `:392-421` |
| `roles/engineer.md`, `tester.md`, `verifier.md`, `sre.md` | The closing formula, one sentence each | Everything else — these are already ~85% judgement |

**And one thing that comes out of six files at once**: *"An envelope you never wrote does not fail
your task; it removes you from the grading"*, in its six paraphrases (Finding F). Under layer 1 it is
false for four roles — a `triage` worker without `write` cannot fail to write an envelope by
accident. **A sentence that is false for some readers and true for others is the worst kind of shared
prose**, and its removal from the four is the clearest single signal that the migration worked.

### 8.1 How the two coexist during rollout

**Both routes stay live and the prose is edited LAST.** The order is not negotiable:

1. **Phase A — additive.** `submit_report` ships; every role keeps `write`; the tool is granted and
   the prose is untouched. **Nothing can regress**, because nothing was taken away. This is where Q2
   and Q4 get measured: does a model reach for the tool when both are available, and does it recover
   from a rejected call?
2. **Phase B — narrow, one role at a time, bash-less first.** `reviewer` before `collator` before
   `triage`, because the review console runs on demand and the triage console runs unattended.
   `observer` never enters this phase (§6.8).
3. **Phase C — prose removal**, per role, only after that role has run a full console cycle in phase
   B. **The prose is deleted, not softened**, because a role file that describes both routes is a
   role file that has to explain when each applies.

**The rollback boundary is phase B and it is one config line.** Restoring `write` to a role's
`tools:` restores every capability it had before, and the prose is still there because phase C has not
run for that role. **This is why the order is prose-last.**

**One thing that must NOT be done during rollout**: granting `submit_report` while removing `write`
in the same edit. The `rev-ctx-1` failure (`src/contracts.ts:203-216`) is precisely a worker whose
tools and whose instructions disagreed, and it produced a review that graded as never written.

---

## 9. Failure modes, recovery, and what this costs

| # | Failure | What it looks like | Mitigation |
|---|---|---|---|
| **9.1** | **Extension fails to load** — syntax error, jiti failure, missing file | `docs/extensions.md` §Error Handling: *"Extension errors are logged, agent continues"*. So Pi starts, `submit_report` is absent, and under layer 1 the worker has **no writing verb at all** | **The worst failure in this design**, and the reason §12 asks for a criterion that the image contains a loadable extension. Detection: `pi.getAllTools()` in the integration test; at runtime, the first `pifleet.no_submit/v1` with `tool_calls: 0` |
| **9.2** | **Tool present, name not in `--tools`** | Silent (§0.2 row 2). Identical symptom to 9.1 | Closed enum (§6.6) makes the config side loud; the integration test makes the image side loud |
| **9.3** | **Name in `--tools`, extension not in the image** | Also silent — row 7: an unknown name is dropped without error | The `BUILD_CONTEXT_ASSETS` criterion (§12), because this is what a forgotten array entry looks like |
| **9.4** | **A worker needs to write and cannot** — layer 1 removed `write` and the model has a legitimate file to produce that `submit_report`'s `report` parameter does not cover | The model narrates the problem and settles. Indistinguishable from defect 5 in the transcript | Phase A→B→C ordering (§8.1); `report` accepts an arbitrary filename; **rollback is one config line** |
| **9.5** | **The nag loops** | Token ceiling reached, run ends on exit 5 | One nag per epoch, held as `nagged` on the epoch tally. §12 pins the bound. **A `/reload` DOES reset it** (`appendEntry` is write-only — §6.3's correction), so the true bound is one nag per epoch *per extension load*; the loop this row fears needs a reload per nag and is not reachable from the handler |
| **9.6** | **`/policy/replies` is stale** — a dispatch that did not rewrite it | `get_replies` returns a previous sweep's set. **This is Finding E arriving through the front door** | Declaring and publishing are one act (§7.4); the file carries its own `task_id` and the tool refuses a mismatch against `/policy/task` |
| **9.7** | **The tool writes a valid envelope the host still refuses** — `task_id`/`epoch` disagree with the location (`src/harvest/outbox.ts:721-724`) | Unchanged from today | Reading both from `/policy/task` makes it near-impossible; the host check stays as the fence (§6.5 property 2) |
| **9.8** | **Authority drift** — someone reads `pifleet.submit/v1` in a verdict path | Silent and total: the fleet starts trusting worker claims | §12's mutation. This is the one failure with no runtime symptom |
| **9.9** | **Image tag does not move** | `up` reuses an old image; the extension is absent; symptom is 9.1 | ISC-270, §6.7, §13 task 2.3 |
| **9.10** | **A model calls `submit_report` with a summary and no report, repeatedly** | Envelope churn; each call overwrites | Deliberate (§6.2.1) — `roles/observer.md:56-58` asks for exactly this. Bounded by the task deadline, not by the tool |

**What this design costs, stated as this document's convention requires.**

**Cost 1 — a third staging surface to keep in step.** `PI_EXTENSION_TOOLS` in `src/`, the tool
registration in `docker/pi-extensions/`, and the `tools:` lists in two YAML files must agree, and
only the integration test checks the middle one, because `docker/pi-extensions/` is outside
`tsconfig.json`'s `include` (§3.2). **This is the same class of gap ISC-572 records for `scripts/`**,
and it is accepted rather than solved.

**Cost 2 — the worker's failure modes move from "wrote the wrong thing" to "did not call the tool".**
Better, but not free: the current failures leave bytes on disk that an operator can read
(`describeUnreadableEnvelope` at `src/harvest/outbox.ts:225-233` is a genuinely good error message).
A worker that never calls the tool leaves a session entry, which is less legible. §7.2's `tool_calls`
field is the compensation and it is not a full one.

**Cost 3 — one more thing that must be true for a worker to work at all.** Today a worker with a
broken extension still has `write`. Under layer 1 it has nothing. **The blast radius of an extension
bug is the whole console**, where today it is one middleware.

**Cost 4 — the defect with the most evidence gets the weakest treatment.** §6.8, §10 D4.

---

## 10. Recorded decisions

| # | Decision | Specified in |
|---|---|---|
| **D1** | The extension is **baked into the image** and loaded with `--extension`, as two extensions already are. Rejected: `~/.pi/agent` auto-discovery (disabled by `--no-extensions`, and shadowed by a named volume); `.pi/extensions` (needs a project); a run-tree mount (works, buys nothing) | §6.7, §0.4 |
| **D2** | Extension tool names get their **own closed enum**, `PI_EXTENSION_TOOLS`, and `ToolNameSchema` ranges over the union. Rejected: a free-string list; `--exclude-tools` instead of `--tools`; deriving the list from the extension at build time | §6.6, §0.2 |
| **D3** | `submit_report` is a **delivery mechanism**. The host reads the file, re-validates it, and counts what landed. Four properties, one anti-criterion | §6.5, §4.1 |
| **D4** | **There is no turn-end veto.** Four layers, ordered, and only layer 1 is a mechanism | §6.3, §2.3 |
| **D5** | `get_task` is **refused**, on three grounds, the strongest being that it rewards tool-thrash in a fleet whose measured failure is tool-thrash | §6.2.3 |
| **D6** | `get_replies` takes **no arguments** and returns the **host-declared** set from a new `/policy/replies`. Rejected: `readdir`; a third line on `/policy/task`; reusing `/policy/dispatch`; parsing the brief | §6.2.2, §7.4 |
| **D7** | Dispatch state is **read from `/policy/task`**, and five of seven fields need no new contract | §6.4 |
| **D8** | The design covers **all three consoles and `development`**, with the review console as the strongest case rather than an afterthought | §6.9 |
| **D9** | Rollout is **additive → narrow → prose-removal**, per role, bash-less roles first, and **prose is edited last** | §8.1 |
| **D10** | The **read-only closure guard is unaffected**, verified by reading it, and its header gains a note saying its coverage here is zero | §4.3, §12 |

### The five that need no argument

**D1 — baked.** **The cost is that changing the extension requires an image rebuild**, so there is no
hot path for a fix and `/reload` is unreachable. Accepted because the alternative is a staging
mechanism this fleet turned off on purpose, and because `docker.pi_version` already means the image
is the unit of change.

**D3 — delivery, not authority.** **The cost is a second read of a file the tool just wrote.**
`e5d5751` made exactly this trade in the other direction and named it: *"A second read of a small
local file is the cheap half; the expensive half was a collation that looked like a worker fault and
was a host one."*

**D5 — no `get_task`.** **The cost is that the task id stays in the brief**, so a model that
misreads it still misreads it — but nothing downstream depends on the model's reading, because
`submit_report` does not take it as a parameter.

**D7 — read `/policy/task`.** **The cost is a file read per tool call.** Two lines, one syscall,
against a thirteen-line prose paragraph and two host-side refusal codes.

**D9 — prose last.** **The cost is a window in which both routes are documented and only one is
tested**, which is the shape `Docs/SRD.md` §12 calls a documentation defect. Accepted because the
reverse order — deleting the prose before the tool is proven — is the `rev-ctx-1` failure by
construction.

### D2 — the second enum

**What it costs.** `ToolNameSchema` is used by `tools:` **and** `exclude_tools:`
(`schema.ts:119-120`), so widening it makes `exclude_tools: [submit_report]` legal — a role that
grants a tool and excludes it. Pi resolves that coherently (`agent-session.js:1830`: the exclusion
wins) so it is not a bug, but it is a spelling of "no" that has a shorter spelling. **Not refused,
because a schema that forbids a coherent configuration to prevent a confusing one is a schema making
a style argument.**

**What it buys, and why it is not optional.** §0.2 row 7. Without it, `submit_reprot` in a role's
`tools:` is a role that silently gets nothing, and — worse than the `web_fetch` case the original
enum was written about — **it also silently loses the tool it meant to request**, because `--tools`
is an allowlist and the misspelling does not name the real tool. The original silence cost a
capability nobody had. This one costs a capability the role has and the config claims.

### D4 — no veto, and the honest ranking

**SETTLED by the type system, not by preference.** `ExtensionHandler<E, R = undefined>`
(`types.d.ts:804`) with `agent_end` and `turn_end` declared without `R` (`:824`, `:826`).

**What it costs, stated precisely because this is the decision most likely to disappoint.** The
commission's framing — *"refusing to settle a turn that never called `submit_report` is the crux of
fixing defect 5"* — describes a mechanism Pi 0.79.6 does not offer, and **the defect with the most
evidence behind it is the one this design attacks with its three weakest layers.** Defect 5 was
measured 45 consecutive times across three models on the `observer` role, and `observer` is the one
role where layer 1 is unavailable, because it needs `bash` for `kubectl` and `bash` is a writing verb.

**What is actually bought for the observer**, and it is worth being exact rather than gloomy:
a tool that is cheaper to call than to avoid (layer 2); one bounded prompt at the moment of failure,
which is the only intervention available at the only moment it could work (layer 3); and — the one
that is certain — **a host-readable record distinguishing "never called the tool" from "called it and
the write failed", carrying the epoch's tool-call count** (layer 4, §7.2). That is a strict
improvement over a `console.error` inferring a false success from an absence, which is the current
state (Finding G). **It is not prevention and this document does not call it prevention.**

**Where prevention IS bought is the review console**, where `reviewer` holds no `bash`, layer 1 is
fully available, and the recorded defect is a schema violation that a typed enum makes
unrepresentable. §6.9.

---

## 11. Open questions

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | **Does a `sendUserMessage` from `agent_end` extend the turn, or does it race the supervisor's quiesce tracker?** `src/supervisor/index.ts:1216` confirms quiescence with two agreeing `get_state` probes. Three outcomes are possible and they are not equally good: the turn extends and the model delivers (best); the turn extends and the task hits its deadline as `timed_out` (**still an improvement** — `timed_out` is not `success`); or the message is delivered after the supervisor has already settled and does nothing (layer 3 buys zero) | **Cheap and offline-able.** Dispatch one task to a `verifier` seat with an extension that always nags, and read `task-record`'s `verdict`/`reason` plus the event log. No cluster, no console | **Layer 3 only.** Layers 1, 2 and 4 are independent, and §13 Phase 3 can ship without it |
| **Q2** | **Does a model under `--no-builtin-tools`-equivalent narrowing actually call `submit_report`, or does it narrate that it would like to?** §3.3. The whole of layer 1 assumes a model reaches for the only writing tool it has rather than reasoning about its absence — and `roles/observer.md:19-22` records an observer doing precisely the opposite with `edit` | Dispatch a `reviewer` with `tools: [read, grep, find, ls, submit_report]` against a small real diff and read the outbox. **Must be run before Phase B narrows anything**, on each model in the fleet | **§8.1 Phase B.** Phase A is unaffected |
| **Q3** | **Does `terminate: true` reach the supervisor as a clean end, or as something it reads as an anomaly?** The doc calls it a *hint* that *"only takes effect when every finalized tool result in that batch is terminating"* — so a model that calls `submit_report` alongside a `read` in one batch does not terminate | Same probe as Q2; read `stop_reason` in the `tui_turn_ended` event and `reason` in the task record | **Nothing.** It is an optimisation; layer 2 degrades to "no effect" |
| **Q4** | **Does a 20B model recover from a rejected tool call?** The entire `rev-lang-1` argument (§6.9) rests on the model reading `isError: true` and correcting. If it instead loops on the same invalid call, a typed refusal is a token sink rather than a fix | Register a tool that rejects the first call unconditionally and accept the second; dispatch to each model in the fleet and count calls. **Cheap, and it decides whether refusals should be strict or coercive** — a `prepareArguments` shim (`docs/extensions.md` §Argument preparation) could fold a near-miss into a valid call instead of refusing it | **Nothing structurally.** It decides how strict §6.2's refusals should be |
| **Q5** | **Can models find the task id in the brief reliably enough that `get_task` stays refused?** D5's third ground | Read `pifleet.submit/v1` entries after a week and compare `task_id` against `/policy/task` — they cannot disagree by construction, so the real probe is whether models *ask* for it, visible as `read /policy/task` calls in transcripts | **Nothing.** It reopens D5 or confirms it |
| **Q6** | **Should `/policy/replies` be one file or should the replies be inlined into it?** Inlining would make `get_replies` a single read and remove `/replies` from the worker's path vocabulary entirely — but reply payloads are capped at 256 KiB (`src/run/relay.ts:270`) and a policy file that large is a different object from the 9-byte `/policy/task` | Measure a real collation's total reply bytes across a day of sweeps. **Not blocking** — §7.4's shape works either way, and the tool's signature does not change | **Nothing.** It is an implementation shape |
| **Q7** | **`roles/observer.md:140-141` asserts a `.md`-only clamp that `src/harvest/` does not implement for `observer` (Finding H). Should the clamp be built, or the sentence deleted?** They are different products: a clamp makes a half-written artifact pair `failed`; deleting the sentence makes it `success` with a missing file | **Not this document's to take** — it is SRD-OBSERVER-001's. Recorded here because it was found while reading for §8, because it is live today, and because it is the exact failure mode this document exists to argue against: prose asserting a mechanism the code does not have | **Nothing here.** §8's row for `roles/observer.md` does not touch `:140-141` either way |
| **Q8** | **Does the `report` parameter's `content` field hit a provider-side argument-size limit?** `skills/pifleet-worker/SKILL.md`'s *"Write it as ONE LINE"* paragraph records a measured failure — *"Past a certain length that write fails with `arguments must be valid JSON, got parse error`"* — for the `write` tool. **A tool call is a tool call**, so a `report.content` carrying a real review may hit the same wall. **The sizing evidence this row was written on is GONE, and the number it quoted was the smallest of the three available.** It cited an 8709-byte review from `roles/reviewer.md`; that anecdote was real, and `b94c58b` (task 8.1) deleted it as FALSE prose — it described a model with a `write` tool and no shell, which this role no longer is — so `grep 8709 roles/` now returns nothing and the figure survives only in this document. **Two larger measurements do survive and both should be read in its place:** `roles/reviewer.md`'s own surviving account of `rev-ctx-1` composing *"a 13 933-byte `write` call"*, and §11's 2026-09-08 census of 56 real reviewer envelopes, whose maximum is **13 965 bytes**. They agree to within 32 bytes and they move the question the same way — **the demand is ~1.6× what this row assumed**, so Q8 is harder than stated, not softer, and the 16 KB margin §11 reports is 15% rather than half | Call `submit_report` with a 4 KB, 16 KB and 64 KB `report.content` against each model. **Must be run before Phase B narrows `reviewer`**, because a reviewer without `write` and with a size-capped tool has no route at all. **Size the probe on 13 965, not on 8709** | **§8.1 Phase B for `reviewer`.** If it fails, `report` needs chunking or `reviewer` keeps `write`. §11 records the probe's result and the census that bounds the demand; this row is left open because closing it is that section's call, not this table's |
| **Q9** | **Should `truncation-recovery.ts` and this extension share a file after all?** They are separate today for good reasons (§6.1), but both now sit in the tool path and a `tool_result` middleware that rewrites a `submit_report` result is a real interaction nobody has thought about | Read `truncation-recovery.ts`'s handler against a `submit_report` result shape. **Cheap, and it should be done in Phase 2 rather than deferred** | **Nothing.** It is a correctness check, not a design fork |

### MEASURED — Phase 0, 2026-09-08

**Four seats, one per model in `fleet.yaml`, one scratch extension.** The vehicle is worth recording
because it cost nothing tracked: `render.ts:256` already emits
`--extension /opt/pifleet/truncation-recovery.ts` unconditionally, so the probe was a **local image
layer** replacing that file with a wrapper calling the real extension and the probe in turn, tagged
under a different `image_prefix` at the same content hash. No Dockerfile edit, no
`BUILD_CONTEXT_ASSETS` edit, no `render.ts` edit, and the real images and every running seat
untouched. The scratch role declared **no `tools:` key at all** — `render.ts:265` emits `--tools`
only when a list resolves, and `--tools` is an allowlist that deletes extension tools, so the probe's
tools exist only while the flag is absent. That is §6.6 interaction 1, met from the other side.

**Q1 — ANSWERED: the turn EXTENDS. The best of the three outcomes §11 allowed.**
`pi.sendUserMessage(text, {deliverAs: "followUp"})` from `agent_end` lands as a `queue_update` event
carrying the text in `followUp[]`, and Pi then runs a further agent cycle. All four models called the
tool the nag asked for, and the epoch settled `verdict: success, reason: quiesced`:

| model | nag sent | tool called | settled | margin |
|---|---|---|---|---|
| gemma-4-26b-a4b-it-bf16 | 05:56:25.442 | 05:56:27.513 | 05:56:28.348 | 0.84s |
| deepseek-v4-pro:0813 | 05:56:25.246 | 05:56:27.681 | 05:56:28.082 | 0.40s |
| qwen3.5:397b | 05:56:26.269 | 05:56:29.930 | 05:56:30.975 | 1.05s |
| glm-5.3 | 05:56:26.305 | 05:56:28.165 | 05:56:28.347 | 0.18s |

**The margin column is the caveat, and it is the number to design against.** The supervisor did not
settle early — it waited for the nag's cycle — but it settled between 0.18 and 1.05 seconds after the
model acted. Layer 3's runway is about a second of slack, not a turn. A model slower to answer a nag
than these four would have its delivery land after the epoch had already settled, which is Q1's third
outcome arriving intermittently rather than never. Layer 3 should therefore be built to make
non-delivery a FACT (layer 4's session entry) rather than to rely on the nag winning.

**Q3 — ANSWERED FOR `rpc` ONLY, and that limit was not stated until ISC-1105 found it.**
`agent_end` fired 2-4ms after the terminating tool result returned on every model, and every task
settled `success` / `quiesced`. The supervisor read nothing as an anomaly. **This was measured on the
`rpc` completion plane, which is not the one any console seat runs on.** Every seat in `fleet.yaml` is
`pane_mode: tui`, where §3.5 gives up `agent_end` and completion is read off the transcript instead —
and there `terminate: true` leaves the last assistant message on `stopReason: "toolUse"` for ever, which
`classifyTuiTurn` read as still-working until ISC-1105. Measured live 2026-09-08: 3 of 3 seats that
delivered through the tool settled `timed_out` with a complete report on disk. A measurement on the
plane the code does not run on is not coverage. It did NOT suppress the
nag's cycle, which is consistent with the doc rather than a contradiction of it: the hint governs the
*automatic follow-up LLM call after a tool batch*, and a queued `followUp` user message starts a new
agent run. Layer 2 works, and it is compatible with layer 3.

**Q4 — ANSWERED: every model recovers, on the first retry, with no shim.**
A tool that threw on call 1 and succeeded on call 2 was called exactly twice by all four models. None
looped on the invalid call; none abandoned the tool after the error. Retry latency
0.8s (glm), 1.1s (gemma), 1.4s (deepseek), 2.1s (qwen). **§6.2's refusals can be strict, and
`prepareArguments` is not needed** — a typed refusal is a correction, not a token sink.

**Q8 — ANSWERED, and the prediction was wrong in a way that strengthens §6.9.**

The probe returned a non-repeating payload of a known size from one tool and asked the model to pass
it verbatim into another, which records the bytes that ACTUALLY ARRIVED. Payloads were verified
untruncated on the way in: deepseek quoted the 16 KB tail (`...3f0.`) and the 64 KB tail
(`...cwa.cwb.cwc.`) back correctly, both of which match the generator.

| model | 4 KB | 8 KB | 16 KB | 64 KB |
|---|---|---|---|---|
| deepseek-v4-pro:0813 | 4096 ✅ | — | 16384 ✅ | **no tool call** |
| qwen3.5:397b | 4096 ✅ | — | 16384 ✅ | **no tool call** |
| glm-5.3 | 4096 ✅ | — | 16384 ✅ | **no tool call** |
| gemma-4-26b-a4b-it-bf16 | 4096 ✅ | **3219 of 8192** | request stalled 17 min | — |

**There are three distinct failure modes here and none of them is the predicted parse error.**

1. **64 KB on all three hosted models: the call is never emitted.** The model reads the payload,
   reasons about transcribing it, and produces no tool call at all. The epoch settles
   `verdict: failed, reason: no_tool_calls`. deepseek's own thinking, recorded verbatim:
   *"This is a massive 64KB payload… I need to reproduce the ENTIRE 64KB content… Given the enormous
   size, I'll carefully copy the full text."* — and then nothing. **This is ISC-517's shape exactly**:
   a report the model had and never delivered. It is the failure §6.9 exists to meet, arriving from a
   direction §11 did not predict.
2. **8 KB on gemma: the call SUCCEEDS and the content is silently short.** 3219 bytes of 8192
   arrived, `isError` false, epoch `success`. Whether the model abbreviated or the argument was
   clipped, the observable for `submit_report` is identical and is the worst of the three: **a
   delivered report, a green epoch, and 39% of the content.** Nothing downstream can detect it.
3. **16 KB on gemma: the request stalls.** No further event for 17 minutes at 0.05% container CPU,
   against an oMLX endpoint measured healthy and answering a fresh completion in 0.81s throughout.

**What this decides.** Phase 7 for `reviewer` is CLEARED at the size that matters: the 8709-byte
review this document was sizing on is inside the 16 KB that all three reviewer models passed
byte-exact, with margin. **Two corrections to that sentence, both below and neither changing the
verdict.** The 8709 figure came from a `roles/reviewer.md` anecdote that `b94c58b` has since deleted,
so it no longer has a source outside this document; and the census three paragraphs down measures the
real reviewer maximum at 13 965, which is the number the margin should have been quoted against.
**Phase 7 for `triage` and `observer` is NOT cleared**, because
their model truncates silently above 4 KB — those roles need either a chunked `report` or a size the
role brief actually bounds.

**Q8 follow-up — a census of what these roles ACTUALLY report, 2026-09-08.** The block above measures
what the WIRE carries. It does not say what any role needs it to carry, and "NOT cleared" above rests
on a limit with no demand next to it. So every envelope this fleet has ever harvested was measured:
all 283 `result.json` files under `~/.pifleet/runs/*/outbox/<worker>/<task>/`, summing every string
byte in each envelope — the payload a `submit_report` call would have had to carry to deliver that
same report.

| Role | Worker(s) | n | p50 | **max** | 4 KB floor | 16 KB ceiling |
|---|---|---|---|---|---|---|
| `triage` (collating seat) | `tri-1` | 95 | 142 | **519** | 7.9× under | — |
| `triage` (observer seats) | `obs-t1`, `obs-t3` | 24 | 296 | **1 472** | 2.8× under | — |
| `collator` | `col-1` | 41 | 480 | **964** | 4.2× under | — |
| `reviewer` | `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` | 56 | 1 539 | **13 965** | — | 1.17× under |
| `observer` | `obs-1` | **1** | 2 255 | **2 255** | 1.8× under | — |

**This census is plane-independent, and that is why it is quoted here.** It reads envelopes the
harvester already wrote; it says nothing about `rpc` versus `tui` because the size of a report does
not depend on how the report was delivered. The Q8 probe above IS plane-bound — it was run through
`report` on the `rpc` path — and the two are only usable together: the probe gives the ceiling, this
gives the demand.

**What it changes.**

- **7.3 (`triage`) is CLEARED**, on 119 real envelopes across the three seats that have produced any. The largest report this
  console has ever produced is 1 472 bytes, a factor of 2.8 inside the size at which its model was
  measured to truncate silently. This is the *"a size the role brief actually bounds"* arm above —
  with the correction that the brief does not currently bound anything, the OBSERVED size does, and
  an observed maximum is not a bound. 7.3 therefore carries a probe asserting the bound rather than
  resting on this table.
- **7.5 (`observer`) stays BLOCKED, and for a different reason than the one above.** Not because
  2 255 bytes is close to 4 096, but because **n = 1**. One envelope is an anecdote. `observer`'s work
  is ad-hoc cloud inquiry whose output is bounded by the size of whatever log excerpt the question
  drags in, which is the one shape in this fleet with no natural ceiling — so it is exactly the role
  whose maximum cannot be inferred from its median. It needs its own sample before its `write` comes
  out.
- **`reviewer`'s margin is thinner than §11 states.** The paragraph above sizes on 8 709 bytes, taken
  from a `roles/reviewer.md` anecdote — since deleted by `b94c58b`, so that figure now has no source
  outside this document. The real maximum across 56 reviewer envelopes is **13 965** — still inside
  16 384, but by 15% rather than by half. The decision does not change; the margin quoted for it
  should. **The surviving prose agrees**: `roles/reviewer.md` still records `rev-ctx-1` composing
  *"a 13 933-byte `write` call"*, an independently measured review 32 bytes off this census maximum.

**Failure mode 9.4 is confirmed and its detection column is wrong.** 9.4 is *"a worker needs to write
and cannot"*, detected as *"the model narrates the problem and settles"* — and a size-capped tool is
one way to reach it, which is why Q8 pointed at it. But nothing narrated anything. At 64 KB the model
produced no output at all and the epoch failed `no_tool_calls`; at 8 KB it produced a SUCCESSFUL call
carrying 39% of the content and narrated that it had done as asked. So the recorded detection is
optimistic in both directions, and 9.4's row should say `no_tool_calls`, a short `report.content`, or
a stalled request — not narration. (An earlier draft of this block said 9.4 "anticipates a loud parse
error". It does not; the parse error is Q8's own prediction, and 9.4 is about the consequence. Kept
here because the misreading is the easy one to make.)

**One limitation, stated rather than left for a reader to find.** The probe made the model COPY a
payload, and `submit_report` will make it COMPOSE one. Copying verbatim is a different and possibly
harder task than authoring, so these numbers may understate the ceiling for genuinely-authored
content. What they do establish is that the WIRE carries 16 KB on the hosted models — that half is
not model-dependent.

---

## 12. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria, each
phrased so the probe is obvious. **`ISC-1057` is the highest id in `ISA.md` as of 2026-09-07**, so
this block starts at `ISC-1058`. No ids are allocated here; `ISA.md` owns that numbering.

**One existing criterion is made newly load-bearing.** **ISC-517** (a lens that wrote a valid report
is never lost) gains a second mechanism that meets its hazard *before* the report is written rather
than after, and §6.9 is a **consumer of its openness, not a closure of it** — a typed enum stops
`rev-lang-1`'s failure and says nothing about a report lost some other way.

**The declaration (D2)**
- A role requesting a misspelled extension tool fails `config validate`. *Probe: `tools: [submit_reprot]`
  in a fixture; assert a schema error naming the field. **Reddened by** widening the enum to
  `z.string()`.*
- `render.ts` emits extension tool names in `--tools` without change. *Probe: `buildPiArgv` on a
  worker whose `tools` includes `submit_report`; assert the flag value contains it.*
- **Anti: ISC-59's default stays the built-in set.** *Probe: assert `effectiveToolGrant(undefined)`
  resolves to `PI_BUILTIN_TOOLS` BY VALUE. **Reddened by** changing that default to `PI_ALL_TOOLS`.*

  **CORRECTED 2026-09-07, during Phase 1, because the probe first written here could not redden.**
  It said: *"a role with `read_only: true` and no `tools:`; assert the `bash` violation still fires"*.
  `PI_ALL_TOOLS` is a SUPERSET of `PI_BUILTIN_TOOLS`, so under that exact mutation `tools.includes("bash")`
  is still true, the violation still fires, and the message is byte-identical — it branches on
  `declared === undefined`, not on the resolved set. Measured both ways rather than argued: with the
  default swapped, the stated probe reported **0 fail** and the by-value probe **1 fail**.
  §6.6 interaction 1.

  Holding this invariant needed the default to have a NAME, which is why Phase 1 exported
  `effectiveToolGrant()` — a deviation from task 1.2's `Touches:` line that the engineer flagged
  rather than hid, and the right call: there is no assertion available from the test file alone,
  because no config loads differently and `loadConfig` therefore cannot see the change.

  The behavioural probe is KEPT alongside it, filed as coverage of the WIRING rather than as the
  anti-criterion: it is the only test that reaches the ISC-59 shape with no `tools:` declared
  anywhere, and it reddens if the guard is unwired from `effectiveToolGrant`.
- A role granting both `submit_report` and `write` warns. *Probe: the `observer` fixture; assert one
  warning and zero errors, because the observer is the intended case.*

**The image (D1)**
- The extension is in `BUILD_CONTEXT_ASSETS` and the tag moves when it changes. *Probe: `imageTag`
  before and after a byte change to `docker/pi-extensions/report-tools.ts`; assert the twelve hex
  characters differ. **Reddened by** removing the array entry — which is ISC-270's fail-open aimed at
  the one file that would suffer most from it.*
- The image registers the tools the extension declares. *Probe: an integration test running `pi` in
  the real image with a command handler printing `getAllTools()`. **This is the only check that spans
  the `tsconfig` boundary of §3.2** and it is the answer to failure modes 9.1, 9.2 and 9.3 at once.*

  **SPLIT IN TWO 2026-09-07, because "equals `PI_EXTENSION_TOOLS`" cannot hold between Phase 2 and
  Phase 5.** The enum names both `submit_report` and `get_replies` (§6.6, §7.5) — it is the vocabulary
  config may REQUEST — while Phase 2 ships `report-tools.ts` registering `submit_report` alone and
  `get_replies` arrives in Phase 5. A set-equality criterion filed against Phase 2 would be red for
  three phases by construction, which is a criterion that trains its reader to ignore it.

  So: **from Phase 2**, the registered set is a SUBSET of `PI_EXTENSION_TOOLS` and contains
  `submit_report` — that is what catches a name the image does not serve. **From Phase 5**, it is
  SET-EQUAL to the enum, and that is where the "no name in the enum is unserved" claim is finally
  made. Raised by the engineer implementing 1.1 rather than found by a reader, which is the shape
  these contradictions usually take.
- The structural type declaration matches the image's `.d.ts`. *Probe: read
  `dist/core/extensions/types.d.ts` out of the running image and assert `registerTool`,
  `on`, `sendUserMessage` and `appendEntry` are still declared with compatible shapes. **There is no
  existing method to copy** — the precedent this bullet named until 2026-09-08 does not exist (§3.2),
  so this is new work and the only one of D1's bullets that is. Grade it `[ ]`, not `[~]`: nothing
  partial has been built.*

**The tools (D3, D6)**
- `submit_report` composes `task_id` and `epoch` from `/policy/task`, never from parameters.
  *Probe: a fixture `/policy/task` naming `T-x`/`7`; call the tool; assert the envelope on disk
  carries both. **Reddened by** adding either as a parameter.*
- `submit_report` refuses when `/policy/task` reads `<none>`. *Probe: the `TASK_POLICY_NONE` fixture;
  assert a throw and **that nothing was written**.*
- `submit_report` refuses a `report.filename` containing `/`, `..` or a leading `@`. *Probe: three
  fixtures; assert three throws and an empty `files/`.*
- A second `submit_report` in one epoch overwrites and does not throw. *Probe: two calls; assert the
  second's bytes. **This asserts a deliberate non-refusal** (§6.2.1) and is the criterion that stops
  someone "fixing" it into an error.*
- `get_replies` returns exactly the declared set. *Probe: `/policy/replies` naming one file while
  `/replies` holds three (the standing-console shape, Finding E); assert one reply returned and the
  other two neither read nor named.*
- `get_replies` reports a declared-but-absent reply as missing rather than omitting it. *Probe: a
  declared path that does not exist; assert it appears in `missing`.*
- **Anti: what the host published and what the tool returns are the same set.** *Probe: drive
  `publishReplies` and the declaration through one composition root over a fixture sweep; assert set
  equality **by reading both ARTEFACTS back off disk** — the replies directory and the replies-policy
  file — never by counting calls. **This is the only new assertion in this document that touches defect 3's class**, and
  §1.3 is explicit that it is a test surface rather than a prevention.*

**The layers (D4)**
- A bash-less role's resolved tools contain no writing verb but `submit_report`. *Probe: `resolveWorker`
  for `triage`, `collator`, `reviewer`; assert `write` and `edit` are absent and `bash` is absent.
  **This is layer 1 stated as a criterion** and it is the only one of the four that can be asserted
  statically.*
- The nag fires at most once per epoch. *Probe: two `agent_end` events with no delivery; assert one
  `sendUserMessage`. **Reddened by** removing the bound — failure mode 9.5.*
- The nag's text is a constant. *Probe: assert the sent string is identical across two fixtures whose
  transcripts differ. **Reddened by** interpolating anything from the event — §4.2.*
- `pifleet.no_submit/v1` carries this epoch's tool-call count. *Probe: a fixture with three tool calls;
  assert `tool_calls: 3`. **The field that separates defect 5's two measured shapes** (§7.2).*

**Authority (D3) — the anti-criteria that matter most**
- **Anti: no host module READS OR BRANCHES ON `pifleet.submit/v1` in a verdict path.** *Probe: a
  closure/grep guard over `src/run/triage-*.ts`, `src/harvest/`, `src/supervisor/` asserting no module
  that produces a verdict, a coverage count, an incident transition or a notification **consumes** the
  entry. **Reddened by** wiring it into `completeSweep`'s artifact count — which is failure mode 9.8,
  the one failure with no runtime symptom.*

  **AMENDED 2026-09-08, before anyone wrote it, by the engineer landing task 3.4.** This bullet said
  *"asserting the STRING APPEARS in no module"*, and a guard built to that letter would have been
  **red by construction on the commit that closed 3.4**: §6.5 property 3 sanctions both entry names
  *"in `claimedSuccess`'s message"*, and that message lives in `src/run/triage-envelope.ts` — squarely
  inside the stated scope. **A string-presence guard cannot express this criterion**, because the
  permitted use and the forbidden one are the same characters in the same file; only *"is it read
  back"* separates them. So the guard must either test consumption, or carry a named exemption for
  that one message the way `test/unit/triage-readonly.test.ts` exempts `DISPATCH_PATH` — and the
  exemption must be by MODULE AND REASON, not a count. **The behavioural half already exists and is
  green**: `triage-envelope.test.ts`'s by-value probe pins `joinSweep`'s whole return object, and
  `completeSweep` reads only `artifacts.length` and `blocked.length`, so smuggling the entry name into
  a returned value reddens it (measured: 3 fails). What a source guard adds is failure 9.8's
  no-runtime-symptom case, and that is the only reason to write one.
- **Anti: coverage is still counted from the run tree.** *Probe: `Docs/SRD-TRIAGE-CONSOLE.md` §12's
  existing criterion, re-run. It must not change, and this document's job is to leave it alone.*

**The guard's boundary (D10)**
- `test/unit/triage-readonly.test.ts`'s header records that its coverage of worker-side code is zero.
  *Probe: not a test — a documentation task, §13 task 1.4. It is here because §4.3 verified the
  guard's scope by reading it, and the next person will read the header first.*

---

## 13. Implementation Checklist

**Phases are ordered by dependency, and each task names the files it touches** — so that
`/ProjectManager` can consume it. A task naming no file cannot be partitioned and will serialise.

### Phase table

| Phase | Deliverable | Depends on | Exit criteria |
|---|---|---|---|
| **0 — Probes** ✅ **DONE 2026-09-08** | Q1, Q3, Q4 measured; Q8 measured for `reviewer` | — | Four numbers recorded in §11 with dates. **Every probe is one dispatch to one seat; none needs a cluster** |
| **1 — The declaration** ✅ **DONE 2026-09-08** | `PI_EXTENSION_TOOLS`, `PI_ALL_TOOLS`, `ToolNameSchema` widened, ISC-59 unchanged | — | `config validate` refuses a misspelling; the ISC-59 anti-criterion is green |
| **2 — The extension** | `report-tools.ts`, `submit_report` only, in the image | 1 | The integration test finds it registered under the real image tag |
| **3 — Layers 2 and 4** | `terminate: true`; both session entries | 2 | Fixtures assert both entry shapes; `tool_calls` is right |
| **4 — Layer 3** | The bounded nag | 2, Q1 | One nag per epoch, constant text |
| **5 — `/policy/replies` and `get_replies`** | The new contract, its writer, the tool | 2 | The declared-set criterion and the publish/declare set-equality criterion pass |
| **6 — Phase A rollout** ⚠️ **6.1 and 6.2 DONE 2026-09-08; 6.3 NOT MET** | Every role gains `submit_report`; nothing removed | 2, 3 | One review console cycle and one triage sweep deliver through the tool with `write` still present. **ISC-1104 stands at `[~]`, and the re-run settles the second half and then some — all four review seats `success`, none timed out, 3 of 3 lenses collated against 1 of 3 before. The FIRST half is what cannot close: *"at least one `pifleet.submit/v1` per seat"* requires every model to choose the tool, and Q2's whole finding is that it need not while both routes are open — `rev-arch-1` chose `write` in both runs, which Phase A explicitly permits. That is a defect in the acceptance clause, not in the system, and it is unmeetable until Phase 7 removes the other route for that seat.** |
| **7 — Phase B narrowing** ⚠️ **7.1-7.4 DONE 2026-09-10/11; 7.5 BLOCKED** | `write` removed, `reviewer` → `collator` → `triage` | 6, Q2, Q8 | Each role completes one full console cycle before the next is narrowed. **Accepted: 7.2 `collator` on ISC-1159 (run `2026-09-11T04-04-58Z-92e5`, task `T-rv-720`), 7.3 `triage` on ISC-1154 (sweeps 79-81, consecutive), 7.4's `HOLDS_A_WRITER` now EMPTY for `reviewer` and `triage`. 7.5 `observer` is BLOCKED and NOT on the size limit: §11's census found exactly ONE harvested `observer` envelope, which is an anecdote rather than a distribution, so its `write` stays until it has its own sample. That blockage is why task 8.4 found `observer`'s write-era prose still TRUE and deleted one sentence rather than the two ranges §13 named.** |
| **8 — Phase C prose** ✅ **COMPLETE 2026-09-11** | `roles/*.md` and the skill shrink | 7 | §8's table, one file per commit. **8.1 `b94c58b`, 8.2 `b24983e`, 8.3 `fe0735e`, 8.4 `8d58068`, 8.6 `099f9bd`; 8.5 superseded by `f06615f`. Two of the six needed no code: 8.5 was already delivered as ROUTING rather than deletion and its deletion now reddens `worker-docs-currency.test.ts`'s `HAND_ORDERS` pin, and 8.6's acceptance clause named two files the sentence was never in, so the invariant it reached for already held and was pinned instead. 8.4 deleted ONE sentence rather than the two ranges this list named, because 7.5 is still BLOCKED and `observer` therefore still holds `write`.** |

**Serialization:** 1 → 2 → 6 → 7 → 8. **Parallel after 2:** phases 3, 4 and 5 touch disjoint seams —
two session entries, one nag, one host contract. Phase 0 is parallel with 1 and 2 and gates only 4
and 7.

### Phase 0 — Probes ✅ COMPLETE 2026-09-08

**Intent.** Replace four expectations with four measurements before anything irreversible.

**All four are answered — §11's `MEASURED — Phase 0` block carries the numbers, the dates and
the vehicle.** Two of the four came back differently from the prediction: Q1 got its BEST
outcome (the turn extends) with a one-second margin worth designing against, and Q8's failure is
not the parse error §11 expected but three silent ones — a truncated-but-successful call, a
never-emitted call, and a hang. Nothing tracked was written to run them.

**Does not.** Write production code.

- **0.1** Q1: does an `agent_end` `sendUserMessage` extend the turn? Write a throwaway extension that
  always nags, dispatch one task to a `verifier` seat, read the task record's `verdict` and `reason`
  and the event log. Touches: nothing tracked (scratch extension). *Acceptance: one of §11 Q1's three
  outcomes recorded in §11 with the date and the observed `reason` string.*
- **0.2** Q3: does `terminate: true` produce a clean end? Same dispatch, read `stop_reason`.
  Touches: nothing tracked. *Acceptance: recorded in §11.*
- **0.3** Q4: does each model recover from a rejected tool call? A tool that throws on call one and
  succeeds on call two; dispatch to each model in `fleet.yaml`; count calls. Touches: nothing tracked.
  *Acceptance: a per-model number in §11, and a decision on whether §6.2's refusals gain a
  `prepareArguments` shim.*
- **0.4** Q8: how large may `report.content` be? Call with 4/16/64 KB against each model.
  Touches: nothing tracked. *Acceptance: a per-model ceiling in §11. **This gates Phase 7 for
  `reviewer` specifically** — see failure mode 9.4.*

### Phase 1 — The declaration ✅ COMPLETE 2026-09-08

**Intent.** Make an extension tool name a thing config can request and misspell loudly.

**Exit criteria met, through the real CLI rather than through the schema.** `tools:
[submit_reprot]` exits 2 naming `roles.observer.tools.1` and listing the nine legal options;
the same document with the spelling corrected exits 0. ISC-59's by-value anti-criterion is
green and reddens under the documented mutation.

**Task 1.3 was not finished by the commit that wrote it.** `submitReportWriteWarning` shipped
with five green tests and no caller — `config validate` reached its sibling
`observerTuiEpochWarning` and not this one, so the only command that tells an operator what
their document gives up said nothing. The five tests call the pair directly and stay green with
the wiring deleted, which is how the hole stayed open; the test added with the fix drives the
CLI and is the only one that reddens on that mutation.

**Does not.** Change `render.ts`. `:260` already joins whatever `w.tools` holds.

- **1.1** Add `PI_EXTENSION_TOOLS` and `PI_ALL_TOOLS`; point `ToolNameSchema` at the union. Keep the
  docblock's shape and add the measured second reason (§6.6). Touches: `src/config/schema.ts`.
  *Acceptance: `tools: [submit_report]` validates; `tools: [submit_reprot]` does not.*
- **1.2** Assert ISC-59's `effective()` default is still `PI_BUILTIN_TOOLS`, with the mutation that
  changing it reddens. Touches: `test/unit/config.test.ts`, `ISA.md`.
  *Acceptance: §12's anti-criterion. **Do this in the same commit as 1.1** — it is the interaction,
  not a follow-up.*
- **1.3** Add the grants-both-`submit_report`-and-`write` warning, in `observerTuiEpochWarning`'s
  shape (`schema.ts:1841-1851`). Touches: `src/config/schema.ts`, `test/unit/config.test.ts`.
  *Acceptance: the `observer` fixture warns and does not error.*
- **1.4** Add a note to `test/unit/triage-readonly.test.ts`'s header recording that its coverage of
  worker-side code is zero and why (§4.3). Touches: `test/unit/triage-readonly.test.ts`.
  *Acceptance: no assertion changes. **A comment task, filed as a task because §4.3 verified the
  scope and the next reader will not.***

### Phase 2 — The extension ✅ COMPLETE 2026-09-08

**Intent.** `submit_report` exists, in the real image, callable.

**Does not.** Remove any tool from any role. Phase 2 is purely additive.

**"Callable" is the word this phase did NOT earn, and it should not have been in the intent.**
The extension loads for every worker and `submit_report` is granted to none of them, because
`--tools` is applied at registry construction and filters extension tools through the same
allowlist, and every role in `fleet.yaml` declares `tools:`. That is Phase 6's job and it was
known before 2.4 was dispatched; what is wrong is the exit line, not the sequence. **Everything
else the phase claims is measured in the real image:** `ISC-1072`'s probe reads Pi's registry out
of `0.79.6-base-72c16f4efb2f` and finds `submit_report` there, as a difference across two runs
rather than by filtering against a copy of Pi's built-in list.

**Two SRD rows were corrected by the engineers who could not build them as written** (§6.2's
`typebox`/`StringEnum` imports, neither package resolvable from `test/`; §6.2.1's artifacts row,
stricter than the host it was quoting). Both are recorded in place rather than silently amended.

**A third correction was mine and is larger than either**, because it is a claim about this
repository rather than about the design: three passages said an existing integration test reads
Pi's `.d.ts` out of the image to catch drift in the structural declarations, and *"that is the
pattern this design copies wholesale, including the integration test"*. **No such test exists**,
for this extension or for the two already running in workers. Filed OPEN as `ISC-1073`.

**Task 2.5 shipped without a CI reader and was graded on that basis first.** Both of its probes
are `skipIf(!PIFLEET_DOCKER)`, and the only job opening that gate runs an explicit file list — so
the file was collected solely by the fast `test` job, where it skipped silently. It is now in the
gated list with `TOTAL_EXPECTED` re-derived by the hand method (146 -> 148). **The engineer
reported this against its own work rather than rounding up**, which is the reason it was fixed in
the same session instead of being discovered by a green board three phases later.

- **2.1** Write `report-tools.ts`: the structural type declaration, `submit_report`, `/policy/task`
  reading, path derivation, atomic envelope write, every §6.2.1 refusal. Touches:
  `docker/pi-extensions/report-tools.ts` (new).
  *Acceptance: unit-testable parts covered; the whole file loads under jiti.*

  **`import { Type } from "typebox"` RESOLVES from `/opt/pifleet/` — measured 2026-09-08 in the real
  base image, as a by-product of Phase 0.** §6.2 already SPECIFIES `Type` from `typebox`, so this
  confirms an assumption rather than settling an open question — but it was an assumption, and the two
  extensions already in that directory both avoid third-party imports and declare their `ExtensionAPI`
  structurally, which reads as a precedent forbidding it. It is not one: `typebox` is a dependency of `@earendil-works/pi-coding-agent` and
  jiti resolves it from Pi rather than from the extension's own directory. So `parameters` may be a
  real `Type.Object(...)` and need not be a hand-written JSON Schema literal. It does NOT resolve from
  an arbitrary path outside the image — the same import failed from a scratch directory on the host —
  so this is a property of the image, not of the file.

  **AND IT IS NOT A LICENCE TO IMPORT IT, which 2.1 established the hard way.** `typebox` and
  `@earendil-works/pi-ai` are not in this repo's `node_modules` at all, so a top-level import makes
  the file unimportable from `test/` and makes this task's own acceptance unprovable. The measurement
  above says the import would WORK AT RUNTIME IN THE IMAGE; it says nothing about the host, where the
  tests live. `parameters` is a JSON Schema literal for that reason — see §6.2's amendment, which
  also records that pi-ai treats that shape as first-class rather than tolerating it.
- **2.2** `COPY --chmod=0444` it to `/opt/pifleet/report-tools.ts`, with the
  `BUILD_CONTEXT_ASSETS` reminder comment the other two COPYs carry (`Dockerfile:413-415`,
  `:433-435`, `:444-445`). Touches: `docker/Dockerfile`.
- **2.3** **Append it to `BUILD_CONTEXT_ASSETS`.** Touches: `src/container/image.ts`.
  *Acceptance: `imageTag` changes when the extension's bytes change. **One line, and the single
  highest risk-per-character task in this document** — ISC-270, §6.7, failure mode 9.9.*
- **2.4** Emit `--extension /opt/pifleet/report-tools.ts` unconditionally, beside
  `TRUNCATION_RECOVERY_PATH`. Touches: `src/config/render.ts`, `test/unit/render.test.ts`.
  *Acceptance: `buildPiArgv` includes it in both pane modes.*
- **2.5** The image integration test: run `pi` in the real image with a command handler printing
  `getAllTools()`; assert the extension-sourced names equal `PI_EXTENSION_TOOLS`. Touches:
  `test/integration/report-tools-image.test.ts` (new), `ISA.md`.
  *Acceptance: green against a freshly built image; **red if 2.3 is reverted**.*
- **2.6** Q9: check `truncation-recovery.ts`'s `tool_result` handler against a `submit_report` result
  shape. Touches: possibly `docker/pi-extensions/truncation-recovery.ts`.
  *Acceptance: either a test showing it passes the result through unchanged, or a fix.*

### Phase 3 — Layers 2 and 4 ✅ COMPLETE 2026-09-08

**Intent.** Delivery becomes cheap, and non-delivery becomes a fact.

**Both halves hold, and the second one cost a design decision this document did not anticipate.**
Non-delivery is decided by an in-memory per-epoch FLAG, never by the absence of a
`pifleet.submit/v1` entry — because task 3.2's swallow (§6.5 property 4's inverse: a diagnostic write
may not un-deliver a report that landed) means **a failed session write produces a delivered report
with no entry**. An implementation reading absence backwards would file a false accusation against a
worker that did its job. `ISC-1080`.

**The declared surface grew a fifth member and §7.6 now says so.** `on("tool_call")` was forced, not
chosen: §7.2 requires `tool_calls` and the four-member surface cannot produce it, while the only
candidate among those four — `AgentEndEvent.messages` — is wrong rather than awkward. The hazard it
introduces was measured in the image and independently re-verified: a throwing `tool_call` handler
**stops the worker running tools at all**. `ISC-1081`.

**A comment that had become a lie was rewritten rather than left.** `report-tools.ts`'s swallow said
the missing entry was *"indistinguishable from a worker that never called the tool… the accepted
cost"*. Task 3.3 made three cases distinct — submit entry, `no_submit` entry, and NEITHER — so the
sentence was false the moment 3.3 landed.

**And one correction runs backwards into 3.4.** That task's message said `no_submit` *"means it never
called the tool at all"*; the extension writes it whenever the epoch was not DELIVERED, which also
covers a `submit_report` called and REFUSED. `ISC-1083`. **Two engineers, two rounds apart, each
found the defect the other's task had left** — which is the argument for small briefs, not for
better reviewers.

- **3.1** Return `terminate: true` from `submit_report`. Touches: `docker/pi-extensions/report-tools.ts`.
- **3.2** `pifleet.submit/v1` on delivery. Touches: same, `src/run/` schema if the host-side reader
  is written now. *Acceptance: §7.1's shape.*
- **3.3** `pifleet.no_submit/v1` at `agent_end` with the epoch's `tool_calls`. Touches: same.
  *Acceptance: §7.2's shape, and a fixture with three tool calls asserting `tool_calls: 3`.*
- **3.4** Have `claimedSuccess`'s message name the session entry, so the operator reading it knows
  where to look. Touches: `src/run/triage-envelope.ts`.
  *Acceptance: the message text changes; **no verdict, count or transition changes** — §12's
  authority anti-criterion must stay green through this task.*

### Phase 4 — Layer 3 ✅ COMPLETE 2026-09-08

**Depends on Q1.** If Q1's third outcome obtains — the message arrives after the settle — **this
phase is skipped and the reason is recorded in §11**, not silently dropped.

**NOT SKIPPED. Q1 returned the best of its three outcomes:** the turn EXTENDS, all four fleet models
acted on the follow-up, and the margin between a model acting and the supervisor settling was 0.18s
(glm) to 1.05s (qwen). That is about a second of runway rather than a whole turn, which is the
constraint the nag was built against — a message asking the model to re-derive anything loses that
race, so `NAG_TEXT` is a fixed string naming the omission and the tool.

**Two orderings carry the phase, and both are set against the case that is rarer and worse.** The nag
is sent BEFORE the entry is appended, because the only mirror this file has is `nagged` on that entry
— send after, and the mirror lags by one entry, harmless while the turn extends and total when it
does not (`ISC-1085`). And the send has its own `try`/`catch`, separate from the handler's, so a
throwing `sendUserMessage` cannot skip the append: the layer with no authority may not silence the
layer whose job is to be read.

**Layer 3's courtesy and layer 4's evidence separate here, deliberately.** A zero-tool-call turn gets
no nag and STILL gets its entry; an idle worker gets neither (`ISC-1086`).

**Two claims this document made about the bound were wrong and are corrected in §6.3 and row 9.5.**
`appendEntry` returns `void` and §7.6's surface has no read-back, so a `/reload` DOES reset the
in-memory bound — the mirror is for the host's eyes, not the extension's memory.

**And the phase filed an open criterion against itself.** `ISC-1087`: layer 3 has never run against a
live model. Q1 measured a scratch extension, not this code path.

- **4.1** The bounded nag: one per `(task_id, epoch)`, constant text, mirrored through `appendEntry`.
  Touches: `docker/pi-extensions/report-tools.ts`.
  *Acceptance: two `agent_end` events, one message; the string is identical across differing
  transcripts.*
- **4.2** Suppress it for an idle worker and for a zero-tool-call turn. Touches: same.
  *Acceptance: `/policy/task` reading `<none>` produces no nag.*

### Phase 5 — `/policy/replies` and `get_replies` ✅ COMPLETE 2026-09-08

**All four tasks landed, plus two criteria neither of them named.** The phase's own tasks are the
schema and renderer, the `:ro` mount, the publish/declare composition root and `get_replies`. What
those four did not cover, and what engineers found against files outside every Touches list, is what
made the phase actually work:

- **`ISC-1091`** — nothing established `/policy/replies` on the host before `docker run`, and Docker
  creates a missing bind-mount source as a DIRECTORY (confirmed by running it). Every worker would
  have come up unable to read or write its declared set, silently and permanently.
- **`ISC-1092`** — the file was not in `docker/verbgate`'s integrity loop, which is what makes a
  dropped `:ro` cost the whole worker rather than one forged declaration.

Both were filed and closed the same day, by the rounds they would otherwise have blocked.

**The port had to change shape, and that was forced.** A declaration is one document about one task's
WHOLE set, so a per-child `publishReply` could only be paired with a second declaring port — and a
turn calling one and not the other is failure mode 9.6, invisible from the host side. §12's criterion
is now asserted by reading BOTH ARTEFACTS back off disk and comparing them as sets, never by counting
calls.

**Re-anchoring a mutation found the thing it protected was no longer protected** (`ISC-1099`): after
the reshape, filing every reply under the wrong worker's plane survived the entire adapter suite,
because those probes inject the effect and pin the transport's arguments rather than the directory
the production effect derives. `/replies` is mounted per worker, so that defect would have made the
collator report every lens missing while every lens sat on disk.

**One thing this phase did NOT prove:** nothing end-to-end has run a real worker against a real
declaration. The images cannot currently be rebuilt on this host (`ISC-1101`), so Phase 6's rollout is
where `get_replies` first meets a model.


- **5.1** The schema and renderer, in `task-policy.ts`'s shape and with its write recipe. Touches:
  `src/run/replies-policy.ts` (new), `test/unit/replies-policy.test.ts`.
  *Acceptance: inode survives a rewrite — assert it directly, as `test/unit/task-policy.test.ts` does.*
- **5.2** Mount it `:ro` at `/policy/replies`. Touches: `src/config/render.ts`, `test/unit/render.test.ts`.
- **5.3** Write it wherever a reply is published, in the same act. Touches: `src/run/relay.ts`,
  `src/run/triage-envelope.ts`.
  *Acceptance: §12's publish/declare set-equality criterion.*
- **5.4** `get_replies`. Touches: `docker/pi-extensions/report-tools.ts`.
  *Acceptance: the declared-set criterion — three files in `/replies`, one declared, one returned.*

### Phase 6 — Phase A rollout

- **6.1** *(operator, not dispatchable)* Add `submit_report` to every role's `tools:` in the untracked
  live `fleet.yaml`. **Remove nothing.** Touches: `fleet.yaml`.
  *Acceptance: `config validate` exits 0. **Not dispatchable — `fleet.yaml` is gitignored
  (`.gitignore:9`) and an engineer editing it produces no diff**, which grades `failed` under ISC-93.*
- **6.2** The same additions in the tracked example. Touches: `fleet.example.yaml`.
- **6.3** One review console cycle and one triage sweep, with `write` still present. Touches: nothing.
  *Acceptance: at least one `pifleet.submit/v1` per seat, and the harvest reads the envelopes exactly
  as before. **Q2 is measured here for free** — whether models reach for the tool when both routes
  are open.*

### Phase 7 — Phase B narrowing

**One role per commit, one console cycle between commits, bash-less roles only.**

- **7.1** `reviewer`: remove `write`. **Gated on Q8** (failure mode 9.4). Touches: `fleet.yaml`
  (operator), `fleet.example.yaml`, and — after the first cycle measured why — `roles/reviewer.md:1-13`,
  the grant sentence through the *"That sentence and the `tools:` line are ONE edit"* paragraph.
  *Acceptance: one full review console run producing three lens reports through `report`.*

  **First cycle: 2 of 3, and the missing third is the phase order's own cost (T-rv-152, 2026-09-08).**
  The grant change landed alone, exactly as §8.1's prose-last order intends, so `roles/reviewer.md`
  still opened *"You have read, write, grep, find, ls and submit_report"*. `rev-arch-1` and
  `rev-lang-1` read the config, found no `write`, and delivered 2 091 and 5 691 bytes through
  `submit_report`. **`rev-ctx-1` believed the briefing**: it composed its entire review into a
  13 933-byte `write` call, received `Tool write not found`, and every turn after that ended
  `stopReason: error` — three retries of *"Stream ended without finish_reason"*, then nothing. Layer 3
  nagged and it could not answer; layer 4 recorded `pifleet.no_submit/v1` with
  `tool_calls: 11, nagged: true`. The console collated two lenses and named the third as a gap.

  Two things this settles. **The diagnostic layers work** — the gap was recorded, attributed and
  reported rather than settling green, which is §6.3's whole purpose and the first time all four
  layers have been exercised by a real failure. And **§8.1's prose-last argument was right about the
  wrong sentences.** Its property — *"restoring `write` to one `tools:` line would restore a coherent
  worker"* — is real, but it was bought at one lens in three for the length of Phase B, and the
  transcript shows the model reasoning correctly from a false premise rather than misbehaving. The
  sentence that states the grant therefore moves with the grant; §8.1's mechanics still do not.
  (Honest limit: the stream errors began immediately after the refused call and every turn before it
  succeeded, but that correlation does not establish that the refusal caused them. The finding does
  not rest on it — composing a review into a tool the role does not hold is a wasted epoch either
  way.)
- **7.2** `collator`: remove `write`. Touches: `fleet.yaml` (operator), `roles/collator.md`,
  `test/unit/collator-role.test.ts`. *Acceptance: one collation, from a `col-1` holding no `write`.*

  **"NO TRACKED DIFF and not dispatchable" was true when written and is now WRONG, and the
  sentence that made it wrong is 7.1's.** The original reasoning still holds for the half it was
  about: there is no `collator` in `fleet.example.yaml` — its `roles:` block is
  `sre observer verifier engineer reviewer tester ticketing triage` — so the config change really
  does live only in the operator's gitignored file, exactly as 6.1's does. What that reasoning
  missed is that the config is not the only thing a narrowing touches. **7.1 measured a role whose
  prompt still claimed a grant the config had taken away, and it cost a lens**: `rev-ctx-1`
  composed a 13 933-byte review into a `write` it no longer held, got `Tool write not found`, and
  every turn after that ended `stopReason: error`. The conclusion recorded there — *"the sentence
  that states the grant therefore moves with the grant"* — makes `roles/collator.md:5` part of THIS
  task rather than part of 8.2. That file is tracked, so the task has a diff after all.

  **And it needed both tools, not one.** The collator owes the same two things the triage collator
  owes, for the same two structural reasons. Its fan-out was a hand-written
  `/outbox/<task-id>/dispatch-request.json` at the TASK ROOT, which no `report` entry can name —
  `dispatch_request` (§7.3) carries it. Its turn two owes a PAIR, `collation.json` and `review.md`,
  and `submit_report` terminates the epoch, so there is no second call to deliver the second
  document in — `report` as a list (§6.2) carries that. Neither tool was built for this role and
  both were needed by it unchanged, which is the strongest evidence so far that these are contract
  shapes rather than role quirks.

  **DONE 2026-09-10 for the tracked half** (ISC-1156, ISC-1157, ISC-1158). The live cycle is
  ISC-1159, and it has since run — **`[x]` as of 2026-09-11 on run `2026-09-11T04-04-58Z-92e5`,
  task `T-rv-720`, with `col-1` holding no `write`**. §13 task 7.4's `HOLDS_A_WRITER` criterion is
  unaffected: with no `collator` in the example there is no resolved grant for it to read.
- **7.3** `triage`: remove `write`. **Gated on Q8, and the gate is now CLEARED** — §11's census
  measured 119 harvested envelopes from this console at a maximum of 1 472 bytes, 2.8× inside the
  4 KB at which its model truncates silently. Touches: `fleet.yaml` (operator), `fleet.example.yaml`.
  *Acceptance: **three consecutive sweeps**, because this console runs unattended and one is not
  evidence — plus a probe asserting the size bound, because what the census establishes is an
  OBSERVED maximum and the clearance above is only sound if something keeps it true.*

  **BLOCKED 2026-09-10 on a contract this document did not notice it had broken, and UNBLOCKED the
  same day.** This role owes an artifact PAIR — `roles/triage.md`: *"Both files, every time. A run
  that writes only the `.md` clamps to `failed`."* `submit_report`'s `report` parameter carried ONE
  file and its result sets `terminate: true`, so a write-less seat had no second call to deliver the
  second file on. §7.1's own example entry has claimed
  `["observer-ops.json", "observer-ops.md"]` since this document was written; the schema underneath
  it could not produce that.

  **The test that looked like coverage was not.** `report-tools.test.ts`'s *"a second call in the
  same epoch overwrites and does not throw"* calls `submitReport` twice from the test process, where
  no `terminate` exists and no model has to choose to emit a second call. It is a true statement
  about the function and says nothing about whether a seat can reach it — the same plane error §11
  records elsewhere in this document.

  **`report` is now a list** (§6.2, capped at 4, repeated filenames refused). The probe half of this
  task was already done: `triage-document.ts`'s whole-document 4 096-byte cap,
  `MAX_SERVICES_PER_ENVIRONMENT = 8` and `TRIAGE_NOTE_MAX_BYTES = 1 024` landed with it.

  **AND THAT WAS STILL NOT ENOUGH, which the first attempt had already proved and this document
  had not recorded.** `fleet.yaml`'s `triage` block carried the finding: narrowed on 2026-09-09,
  `tri-1` *"composed the fan-out correctly and was refused three times — `Tool write not found` —
  and the console dispatched nothing for three sweeps"*, and *"sweeps 5 and 6 settled
  `status: success` with the summary 'Dispatched sweep to obs-t1', having written no request at
  all."* The pair was the smaller of two gaps. The FAN-OUT is the larger one:
  `dispatchRequestPath` reads `<outbox>/<worker>/<task-id>/dispatch-request.json` — the TASK ROOT
  — and `report` writes into `<task-dir>/files/`. **One directory level, and it is not closable by
  widening `report`**: an entry that could name a parent directory would be a path where
  `filenameProblem` requires a bare name, which is the containment that stops a worker writing
  outside its own outbox.

  **`dispatch_request` is what that note asked for** — *"until a `dispatch_request` tool exists to
  carry it the way `submit_report` carries the envelope"*. It writes that one file, composes
  `schema` and `parent_task_id` from `/policy/task`, and sets NO `terminate`: turn one is the
  fan-out and then the envelope, and ending the turn on the fan-out would settle the parent with a
  request written and no envelope. `PI_EXTENSION_TOOLS` gains it, so the registered set and the
  requestable vocabulary stay equal (§12's set-equality criterion).

  **DONE AND ACCEPTED 2026-09-10** (PR #155, `1fb435c`). `write` withdrawn in both configs,
  `roles/triage.md` moved in the same commit, all three images rebuilt, `tri-1` restarted onto
  `0.79.6-base-8e90ff00f80e` and verified running `--tools read,grep,find,ls,submit_report,
  dispatch_request` — read from `docker inspect`, not from the config meant to produce it.

  **The acceptance is met on `T-sweep-79`, `T-sweep-80` and `T-sweep-81`** (14:54:10Z, 15:11:05Z,
  15:28:30Z, each `skips=0`), each verified from its own artifacts: `dispatch-request.json` at the
  TASK ROOT, both `triage.json` and `triage.md` declared in the envelope, three `healthy` services,
  `unaccounted: []`. ISC-1154 closes on it.

  **The window is 79-81 and NOT 78-80, and the difference is why this acceptance says CONSECUTIVE
  rather than three.** `T-sweep-78` completed and the ids 78-79-80 run consecutively with none
  skipped, which reads like the three. It is not: a `pass_failed` sits between 78 and 79 in the relay
  log — the `worker_prose [monitoring]` refusal, a latent ISC-1142 gap on `coverage[].channel` that
  the same PR fixes. Counting sweep ids instead of log lines would have closed this 34 minutes early
  on a window with a failure inside it. `T-sweep-77`, lost to the collator's repeat loop, is the
  other sweep excluded. **Both of those failures are what PR #155 fixes, which is exactly why neither
  may also count as its evidence.**

  The record above stated `0.79.6-base-1b6c4a15d1ac` until 2026-09-10 and the seat has never run it:
  a comment-only edit under `docker/` re-tagged the image before the restart, and the tag written
  here was the one that existed when the sentence was drafted. Both halves of §6.2's hash rule are in
  that: `BUILD_CONTEXT_ASSETS` hashes CONTENT, so a comment moves the tag, and a tag recorded from
  intent rather than from `docker inspect` is a claim, not a measurement.

  **One self-inflicted cost worth recording**: the sweep at 14:00:40 failed
  `roles.triage.tools.5: Invalid option` because the live config gained `dispatch_request` while an
  actor built from pre-change source was still running. Editing `fleet.yaml` and restarting the
  actor are one operation, not two.
- **7.4** The resolved-tools criterion for all three. Touches: `test/unit/config.test.ts`, `ISA.md`.
  **DONE 2026-09-10 for `reviewer` and `triage`.** `HOLDS_A_WRITER` is now EMPTY and the suite
  asserts that it is — the exemption table held `triage: ["write"]` from the 2026-09-09 reversal,
  and that entry's own note named what would retire it. `collator` is not in
  `fleet.example.yaml` (see 7.2), so it has no resolved grant this criterion can read.
- **7.5** `observer`: remove `write`, keep `bash`. **BLOCKED, and not on the size limit** —
  §11's census found exactly ONE harvested `observer` envelope, which is an anecdote rather than a
  distribution, and this is the one role whose output is bounded by whatever log excerpt the question
  drags in. It needs its own sample before its `write` comes out. Touches: `fleet.yaml` (operator),
  `fleet.example.yaml`.
  *Acceptance: three sweeps. **§6.8 is explicit that this is not layer 1** — it is proposed for the
  smaller reason and must be judged against `roles/observer.md:19-22`'s recorded misreading, not
  against a claim of prevention.*

### Phase 8 — Phase C prose ✅ COMPLETE 2026-09-11

**Two of the six tasks needed no code.** 8.5 was already delivered by `f06615f` as routing rather
than deletion, and performing its deletion now reddens a guard that shipped with that fix; 8.6's
acceptance clause was unmeetable as written and the invariant it reached for already held. Both are
recorded against their bullets below rather than closed by grading around them.

**One file per commit, and only for a role that has completed Phase 7.**

**Task 8.4 BREACHED that precondition knowingly, and the breach is recorded rather than waived.**
`observer` has not completed Phase 7 — 7.5 is BLOCKED on a sample of one envelope — so by the rule
above, `roles/observer.md` was not eligible for a prose task at all. What 8.4 removed was a sentence
made false by Phase A (`submit_report` exists and observer holds it), not by Phase B (a narrowing that
has not happened), which is why it was safe to do and why its scope collapsed to one sentence. The
rule is still right: the first attempt at 8.4, following §13's stated ranges, would have deleted prose
that is true precisely because 7.5 has not run. **A role mid-Phase-7 should be edited only where the
edit is independent of the narrowing still outstanding**, and that condition wants stating in the rule
rather than discovered per task.

- **8.1** `roles/reviewer.md`: delete `:45-144`. Touches: `roles/reviewer.md`.
  **`:1-13` are NOT in this range any more — they came forward into 7.1**, because a sentence that
  STATES THE GRANT is not the same kind of prose as the mechanics this phase defers, and leaving it
  false was measured to cost a lens (see 7.1's result). The rollback boundary is correspondingly one
  config line plus one prose line, and the two must move together.

  **DONE 2026-09-10** (`b94c58b`). The four sections are gone and the file is 113 lines. The commit
  separates what it deleted as FALSE — the worked `json` envelope whose first four fields are absent
  from `SUBMIT_REPORT_PARAMETERS`, the two *"write `/outbox/<task-id>/result.json`"* instructions a
  role with no `write` cannot follow, the `notes`-as-a-filename anecdote — from what it deleted as
  REDUNDANT, the DECLARE instruction and the hand-composed-JSON history. **One number this document
  cited went with it**: the anecdote's 8709-byte review, which §11 and Q8 had been sizing
  `report.content` on and which now has no source outside these pages. Read §11's census instead. The
  commit also retired a `65536` `notes` ceiling that this SRD never cited — the binding limit is
  `SUBMIT_REPORT_PARAMETERS`' 20000 — noted here so the next reader does not go looking for it.
- **8.2** `roles/collator.md`: delete `:170-254`, `:255-346`. Touches: `roles/collator.md`.

  **DONE 2026-09-11** (`b24983e`). The `notes`-as-a-filename anecdote and the JSON-escaping
  paragraph are gone, both deleted as FALSE rather than as redundant: `notes` is a typed parameter
  of `SUBMIT_REPORT_PARAMETERS`, and `submit_report` serialises the envelope, so no character of the
  prose can reach it as syntax. The split's surviving justification was already stated in the next
  paragraph and is kept. Recorded here 2026-09-11 because this bullet carried no result while 8.1
  and 8.3 both did — the missing thing was the note, not the work.
- **8.3** `roles/triage.md`: delete `:325-457`, `:282-291`, `:246-257` — **these ranges are the
  instruction AS GIVEN, against the file before `fe0735e`, and are left unrepointed on purpose: a
  record of what was ordered is not a claim about the file today.** **And fix the
  three-observer/one-observer contradiction (§2.6) in the same commit**, because the surviving prose
  must not carry it. Touches: `roles/triage.md`.

  **DONE 2026-09-10** (`fe0735e`), including the contradiction, which is why §2.6 now records that
  finding as closed. Resolved toward the roster and not the prose: the three-observer table, its
  fan-out reasoning, step 2's grouping paragraph and the worked turn-one envelope naming all three
  seats are deleted, and the *"YOU HAVE EXACTLY ONE OBSERVER"* section absorbed the judgement the
  table carried. The only surviving mention of `obs-t2` and `obs-t3` is the refusal row that says
  they do not exist.
- **8.4** `roles/observer.md`: delete `:138-142` and most of `:26-34`. **Keep `:39-58`** — the pacing
  budget is judgement. **Do not touch `:140-141`** — that is Q7's. Touches: `roles/observer.md`.

  **DONE 2026-09-11 (`8d58068`), but NOT as this bullet specifies — the ranges it names are stale
  and deleting them would have removed true prose.** `observer` holds
  `[read, write, bash, grep, find, ls, submit_report]` in both configs and **has never been
  narrowed**: task 7.5 is still BLOCKED for want of an envelope sample. So `:26-34` (*"Read-only
  describes what you do to the ENVIRONMENT… it does not describe your outbox"*) and `:138-142` (write
  the `observer-ops` pair) are both still TRUE, and this bullet was written against a narrowing that
  has not happened. It also contradicted itself at the line numbers it gave: `:140-141`, which it
  forbids touching as Q7's, sits *inside* the `:138-142` it orders deleted.

  **What was actually false was one sentence**, the old `:144` — *"Report as the `pifleet-worker`
  skill describes — `result.json` written last"*. Observer holds `submit_report`, and the contract
  skill's routing table (added by `f06615f`) says a worker holding it — even one that also holds
  `write` — must CALL it and leave the hand-composed envelope alone. The replacement routes on the
  grant: the envelope goes through `submit_report`, while the `observer-ops.json`/`.md` pair stays on
  `write` into `/outbox/<task-id>/files/` and is declared afterwards in `artifacts[]`.

  **That split is the CORRECTION, and the first attempt got it wrong. `8d58068` moved the artifact
  pair onto `report` as well; `c887c7a` reverted that half after review.** The routing table compels
  only the ENVELOPE — a holder of `submit_report` must call it rather than hand-compose
  `result.json`. It says nothing about artifacts, and `skills/pifleet-worker/SKILL.md` explicitly
  reserves `artifacts[]` for *"files you wrote yourself"*. Moving the pair too put it on a channel
  §11 measured UNSAFE for this exact role: `report.content` carries no `maxLength`, `observer`'s
  `gemma-4-26b-a4b-it-bf16` was measured delivering **3 219 of 8 192 bytes with `isError` false and
  the epoch `success`**, and the harvested `observer` pairs on the operator's machine reach
  **17 817 bytes, with 31 of 122 above 4 KB**. What that buys is a green epoch carrying a fraction of
  an evidence ledger — the failure §6.9 exists to prevent, and one nothing downstream can detect.
  **7.5 is BLOCKED precisely because this role's output has no measured ceiling: that is a reason to
  leave `write` in place, not a gap to route around.**

  **The edit was confined to a single hunk at `:144` on purpose.** This file is cited BY LINE in 14
  places across five files (`test/unit/report-tools.test.ts:818`, `src/config/schema.ts:2097`,
  `src/run/triage-envelope.ts:162`, and ten here, plus `test/unit/observer-role.test.ts:13`, which `8d58068` itself added). `git diff -U0` shows one hunk, `@@ -144,4 +144,9 @@`,
  so thirteen of the fourteen are untouched by arithmetic (**this census read "ten across four" until review recounted it 2026-09-11: the SRD alone carries ten by-line citations, not seven, and `8d58068` added a fifth file. The safety argument is unchanged — every citation but one terminates at or below `:143` — but a wrong citation census is the worst possible place in this document to be approximate**); only §2.6's `:138-147` moved, and it is now
  `:138-152` above. *Probe: `bun test test/unit/observer-role.test.ts` — 6 pass, including a CONTROL
  asserting observer holds `submit_report` alongside a write-capable tool, so the routing argument
  cannot go vacuously green if the grant changes.*

  **One consequence for 8.6**: the replacement reworded the surviving consequence to *"An envelope you
  never **submitted**"*. The sentence survives in substance, which is what 8.6 requires, but the verb
  is no longer the one the other three files use.
- **8.5** `skills/pifleet-worker/SKILL.md`: delete the *"Write it as ONE LINE"* rule and its bullets,
  the pretty-printed `json` example, and the mechanics under *"Field rules, each of which is checked"*.
  **Keep `:131-142`** — *"Your report is a claim, not a verdict"*. Touches:
  `skills/pifleet-worker/SKILL.md`. **These were `:152-157`, `:179-198` and `:200-224` when this list
  was written; `f06615f` moved all three down by ~51-59 lines**, which is why they are named here by
  the sentences they open with rather than by number.
  *Acceptance: **this file is injected into every worker regardless of role** (its own frontmatter),
  so it may only lose text that is false or redundant for **all** of them.*

  **DONE 2026-09-11 (`f06615f`), and executed as ROUTING rather than deletion — which is what the
  acceptance above actually requires.** The hand-composition route is still TRUE for any role
  without `submit_report`: a role that declares no `tools:` is granted Pi's builtins, and no builtin
  is named `submit_report`. So the three passages named above are not *"false or redundant for all
  of them"*, and deleting them would strand precisely the worker they are addressed to. `f06615f`
  scopes them instead — a routing table on the tool grant, `### Calling submit_report`, and
  `### Composing it by hand` — so a worker holding the tool is told to read past them rather than
  being left to discover they do not apply.

  **Further deletion is now REFUSED BY A GUARD that landed in this branch.**
  `test/unit/worker-docs-currency.test.ts` pins `HAND_ORDERS` — *"Write `/outbox/<task-id>/result.json`
  **atomically**"* and *"single string argument to your write tool"* — as PRESENT, and as positioned
  after the subheading that scopes them. The second of those opens the very *"Write it as ONE LINE"*
  paragraph this bullet orders deleted, so performing the deletion reddens the probe that shipped
  with the fix. **This bullet is superseded, not outstanding.**
- **8.6** Delete the six paraphrases [**the counts in this headline are WRONG — see the correction below**] of *"An envelope you never wrote…"* from the four roles where
  layer 1 makes it false, and keep it where it remains true. Touches: `roles/*.md`.
  *Acceptance as written: the sentence survives exactly in `observer`, `engineer`, `tester`, `sre`,
  `ticketing` — the roles that can still fail to write one.*

  **THE ACCEPTANCE IS UNMEETABLE AS WRITTEN, AND THE TASK IS ALREADY SATISFIED. 2026-09-11.**
  `engineer` and `sre` have never carried the sentence — `git log --all -S'An envelope you never
  wrote' -- roles/engineer.md roles/sre.md` returns nothing — so *"survives exactly in"* names two
  files it was never in, and no edit to `roles/*.md` can make the clause literally true.

  What the clause was reaching for is a ONE-DIRECTIONAL invariant, and that invariant already holds:
  the paraphrase appears in `observer`, `ticketing`, `tester` and `verifier` — every one of which
  holds a write-capable verb and can therefore genuinely fail to write an envelope — and in none of
  `reviewer`, `collator` or `triage`, which hold no writer.

  **Correction 2026-09-11, found by review: "had theirs removed by 8.1-8.3" was wrong for two of the
  three, and it was asserted rather than run — the same unverified-provenance error this entry exists
  to correct.** Measured with `git log --all -S`: `reviewer`'s was removed by `b94c58b` (task 8.1), as
  claimed. **`collator`'s was removed by `d6e6364` — task 7.2, not 8.2**; `git show b24983e -- roles/collator.md`
  removes zero occurrences. **`triage` never carried the sentence at all**, so nothing was removed from
  it by any task. The partition below is unaffected — those three carry no paraphrase today, which is
  what the invariant grades — but only one of the three absences is Phase 8's doing.
  `verifier` carries it and is absent from the clause's list, which is the same drafting error
  running the other way. **Nothing is left to delete; restating the invariant, and pinning it, is the
  deliverable.**

  **Anchoring caveat, because the obvious grep gives a FALSE NEGATIVE and did so twice while this
  entry was being written.** The sentence is not one literal string. Its verb varies — `observer`
  reads *"never submitted"* since `8d58068`, the other three read *"never wrote"* — and these files
  are hard-wrapped, so in `roles/tester.md:19-20` the phrase spans a newline (*"An envelope you ⏎
  never wrote"*). A contiguous, case-sensitive match therefore reports `tester` as not carrying a
  sentence it plainly carries. **Any probe of this invariant must flatten whitespace before matching,
  accept both verbs, and ignore case** (`roles/verifier.md:16` opens the sentence lower-case). What
  remains genuinely unguarded is a further rewording that keeps the meaning and shares no anchor
  phrase; that limit is recorded rather than hidden, because no phrase-matched probe can close it.

  **PINNED 2026-09-11 (`099f9bd`), and the anchor it chose is better than the one this entry
  proposed.** *Probe: `bun test test/unit/role-envelope-prose.test.ts` — 4 pass in CI and 5 locally, asserting the
  one-directional implication `carries the paraphrase -> resolves a write-capable grant` across every
  role in `fleet.example.yaml`, with CONTROLS on BOTH halves — a non-empty carrier set and a
  non-empty write-less set — so a future narrowing that emptied either cannot go vacuously green.*
  The anchor is `removes you from the grading` rather than either verb, which is what makes it
  survive the `wrote`/`submitted` split 8.4 introduced, matched against whitespace-normalised,
  lower-cased text. Its reddening is driven through RESOLUTION rather than by editing prose:
  `reviewer`'s real write-less grant is paired with `observer.md`'s real carrying prose and the
  checker must call that inconsistent, then the pairing is corrected and must pass — no `roles/*.md`
  is mutated to prove it. `evaluateRoles` THROWS on a role whose doc is missing rather than skipping
  it, so the probe cannot quietly cover less than it claims.

  **What it does NOT close, stated so the next reader does not over-read it.** `collator` has no
  block in `fleet.example.yaml`, so its GRANT is never resolved by the tracked probe; only the prose
  half is checked unconditionally (it carries no paraphrase, satisfying the implication vacuously).
  A `describe.skipIf` block re-runs the full nine-role check against the operator's own `fleet.yaml`,
  which is gitignored — **so that block SKIPS in CI and is local-only evidence.** ISC-1161 therefore
  stays `[~]`: nothing the repository ships grades the `collator`'s grant.

---

## 14. References

- **Inside the pinned image** `pifleet/pi-worker:0.79.6-base-b722edcf4699`,
  `@earendil-works/pi-coding-agent@0.79.6`, read and probed 2026-09-07:
  `docs/extensions.md` (Quick Start, Extension Locations, Lifecycle Overview, Agent Events, Tool
  Events, Custom Tools, Tool Definition, Overriding Built-in Tools, State Management, Error Handling,
  Mode Behavior); `dist/core/extensions/types.d.ts:804` (`ExtensionHandler`), `:824`/`:826`
  (`agent_end`/`turn_end`), `:739-743` (`ToolCallEventResult`), `:756-759` (`MessageEndEventResult`),
  `:294-296`/`:867-869` (`sendUserMessage`), `:871` (`appendEntry`);
  `dist/core/sdk.js:131-135`; `dist/core/agent-session.js:1828-1892`; `dist/main.js:330-341`;
  `examples/extensions/structured-output.ts`; `pi --help`.
- `src/config/schema.ts:60-68` — `PI_BUILTIN_TOOLS`, its docblock, `ToolNameSchema`; `:119-120` —
  `tools`/`exclude_tools`; `:1582-1623` — ISC-59 and `effective()`; `:1841-1851` —
  `observerTuiEpochWarning`, the warning shape §6.6 copies.
- `src/config/load.ts:624-636` — `pick`, replace-wins; `:759-760` — the tools merge.
- `src/config/render.ts:200-267` — `buildPiArgv`; `:208` — `--no-extensions`; `:241`/`:256` — the two
  existing extensions; `:260` — `--tools`; `:278-611` — the mount table; `:446-447`, `:493-503`,
  `:512-514`, `:524`, `:600`, `:608-611`.
- `src/container/image.ts:102-134` — `BUILD_CONTEXT_ASSETS`; `:200-202` — ISC-270's fail-open;
  `:231-245` — `configHash`, `imageTag`.
- `src/run/task-policy.ts:1-47`, `:73-79` — the host-written dispatch state and the argument §6.4
  reuses.
- `src/run/replies.ts:24-37`, `:41-50`, `:101`, `:171-173`, `:272-324` — the no-enumeration rule, the
  invisible-late-reply cost, the inode recipe, `writeReply`.
- `src/run/triage-envelope.ts:116-137`, `:708-745`, `:951-971`, `:1089-1156` — the constants, the
  collation brief, `publishReplies`'s docblock, `joinSweep` and `claimedSuccess`'s only effect.
- `src/run/triage-pass.ts:225-255`, `:942-1022` — `SweepJoin`, and `completeSweep` not reading
  `claimedSuccess`.
- `src/contracts.ts:52-53`, `:203-217`, `:219-235` — `StatusSchema`, `RESULT_ENVELOPE_NAME`'s docblock
  and the `rev-ctx-1` record, `ResultEnvelopeSchema` (not `.strict()`).
- `src/harvest/outbox.ts:225-233`, `:680-698`, `:703-734` — `describeUnreadableEnvelope`, the
  pre-schema cap hoist, the parse and the four post-parse refusals.
- `src/harvest/reconcile.ts:175`, `:202-204`, `:745-765` — the `ticket-ops` clamp that `observer`
  asserts and does not have (Finding H, Q7).
- `src/supervisor/index.ts:881`, `:1035-1053`, `:1216-1265`, `:2299-2325`, `:3361-3395` — `settle`,
  ISC-299's tree-hash downgrade and why it is unreachable for `workspace: none`, the RPC quiesce
  chain, the TUI chain, and the prompt block that writes the outbox path the supervisor never reads
  back. `src/supervisor/prose-detector.ts:97`, `:110`.
- `test/unit/triage-readonly.test.ts:73`, `:89-98`, `:116`, `:127-128`, `:219-231`, `:389-391` — the
  guard whose scope §4.3 verified.
- `docker/Dockerfile:244-245`, `:375-379`, `:413-415`, `:433-446` — the Pi pin, `.pi/agent`, the
  `BUILD_CONTEXT_ASSETS` reminders, the two `COPY`s this design copies.
- `fleet.yaml:39`, `:534`, `:682-686`, `:687`, `:713-718`, `:816-831` — `pi_version`, the four role
  tool lists this design edits, and the three comments that argue the capability discipline §4.5
  rests on.
- `roles/observer.md:10-64`, `:138-152` (was `:138-147` until `8d58068` — task 8.4 replaced four
  lines with nine); `roles/triage.md`'s opening protocol section and its
  **"YOU HAVE EXACTLY ONE OBSERVER"** section — the two §2.6 records as having contradicted each
  other until `fe0735e` — plus `:237-257`, `:266-323`, `:325-457` (**ranges against the file as it
  stood BEFORE `fe0735e`, left unrepointed on purpose: this sentence records what was there then**);
  `roles/collator.md:109-114`,
  `:153-183`, `:422-423`; `skills/pifleet-worker/SKILL.md:131-293`.
  `roles/reviewer.md:45-144` was on this list and **is no longer readable — `b94c58b` deleted it**;
  read it at `b94c58b^` if the four envelope sections are what you are after.
  **Every range above that is still a bare number is one nothing checks.** The ones named by sentence
  are pinned the way `test/support/isa-claims.ts` pins a claim, with `grep -nF`; the rest were
  accurate when written and are worth re-deriving before being relied on.
- Commits `efaf63a`, `8096fc4`, `e5d5751`, `5dbdafe` — the four host-side fixes, and the primary
  record of defect 5's forty-five passes.
- `triage/console.yaml` — the `recycle_after_sweeps: 0` block, which is where the seats' current
  `pane_mode: tui` and the 900/120 cadence are recorded against the measurements that forced them.
- `Docs/SRD.md` §4.2 (the tool-scope row §0.2 amends), §12.1, §12.6; `Docs/SRD-TRIAGE-CONSOLE.md`
  §6.5, §7.2, §12, Finding C; `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5; `Docs/SRD-REVIEW-CONSOLE.md`
  §6.5.
- `ISA.md` — the grading convention, ISC-517, ISC-572, ISC-1057 as the current high-water mark.

**A rule for maintaining this document.** Cite the file the behaviour is *in*, never the file a
comment *says* it is in — §0.4 correction 3 is this document's own instance of that failure, caught
by opening `src/container/mounts.ts` and finding no mount table. **And for the image citations
specifically: they are pinned by `docker.pi_version` and by nothing else.** A `pi_version` bump
invalidates every `dist/` line number here and may invalidate §0.2's measurements outright. **Re-run
the seven probes on any `pi_version` change before trusting a word of §0.2, §2.2 or §6.6** — they
cost seven `docker run` invocations and no model calls, which is the cheapest re-verification in this
repository.
