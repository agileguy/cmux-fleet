# System Requirements Document — a `triage` console, a scheduled sweep, and three observers

**SRD-TRIAGE-CONSOLE-001 v0.1 — DRAFT FOR OWNER REVIEW**

*Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001), `Docs/SRD-DEPLOY-OPS.md` (SRD-OBSERVER-001),
`Docs/SRD-REVIEW-CONSOLE.md` (SRD-REVIEW-CONSOLE-001) and `Docs/SRD-FLEET-PROJECT-MANAGER.md`
(SRD-FLEET-PM-001). It **consumes** the review console's request plane and fan-out rather than
re-specifying them: §6.5 and §7.3 are readings of machinery that shipped in `2ccf851`, not
proposals. It **consumes** the `observer` role's verdict vocabulary from SRD-OBSERVER-001 §9
rather than inventing one. It **proposes an amendment** to `Docs/SRD.md` §5.9 — the bounded
hosted-provider decision — because the commission asks for the one role that amendment names as
excluded, and §0.2 is that collision stated rather than absorbed.*

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operator wants a fourth standing console: one `triage` worker and three `observer` workers that
sweep a named list of services in a named environment every five minutes and say something when a
service breaks. **Most of the machinery already exists and none of it is where a reader expects.**
The fan-out is the review console's — a worker writes `dispatch-request.json` into its outbox and a
host-side actor turns it into three dispatches (`roles/collator.md:77-96`,
`src/run/dispatch-request.ts`), and its roster type is already generic
(`ConsoleRoster` at `dispatch-request.ts:279-283`), so a second console is a data addition rather
than a code change. The health check is the `observer` role's, whose verdict vocabulary already
separates *"did I observe"* from *"what is the subject doing"* from *"what does my answer rest on"*
(SRD-OBSERVER-001 §9.1) — which is exactly the distinction a notifier needs and the one it would
otherwise get wrong. **Everything hard is in three sentences.** There is no clock anywhere in this
fleet, and a worker may not be one (§4.4). There is no notification channel anywhere in this fleet,
and the one the commission most plausibly names is not running on this machine today (§2.5). And a
console that dispatches 288 times a day is the first thing in this fleet that cannot afford a `tui`
seat, cannot afford a `--restart` per dispatch, and cannot afford to be four runs (§2.2, §2.3) —
so the design that falls out is **one run, four `rpc` seats, no keyboard, and a host-side actor
that is both the clock and the fan-out performer, because two processes that must agree about run
ids is a failure mode nobody needs.**

### 0.2 The decision that matters — the model the commission names is the one this fleet's config refuses, in writing

The commission says: *"They will all use ollama cloud gpt-oss-120b."* That is not a configuration
detail. It is a request to reverse a recorded owner decision, for the exact role that decision was
written about.

`fleet.yaml:471-475`, on the `observer` role:

> ```yaml
> model: gpt-oss-20b-MXFP4-Q8           # LOCAL 20b, by owner decision 2026-09-03 — not
>                                       # `ollama-cloud/gpt-oss:120b`, which is the same
>                                       # family served by a third party. An observer reads
>                                       # clusters and logs, so its context is the fleet's
>                                       # most sensitive and the one least worth sending out.
> ```

`Docs/SRD.md` §5.9's 2026-09-03 amendment says the same thing from the other side, and names the
exclusion:

> *"On this fleet that is Ollama Cloud, on the `engineer`, `tester` and `reviewer` roles — the
> `development` console's four seats — and nothing else. Every other role, **including `observer`**
> and `ticketing`, stays on the operator's own oMLX."*

**So the commission and the config disagree, and the disagreement is not about a model name — it is
about whether an observer's context may leave the machine.** §5.9's own ladder is explicit about
what that costs: *"everything in an assigned worker's context reaches them: its transcript, its tool
output"*, and *"There is no ceiling, timeout or scope that reduces a transcript after it has been
sent."* For this console the context is not source code. It is namespaces, workload names, pod
names, restart counts, log lines, error excerpts and cluster endpoints, from a live environment,
288 times a day.

**This document does not take that decision.** It specifies the console so that the model assignment
is one line per role, states the two arms, and puts it to the owner as **Q1, BLOCKING** (§11). What
it will not do is quietly write `ollama-cloud/gpt-oss:120b` into a role and let a recorded decision
be reversed by a config edit nobody argued for — which is precisely the shape `fleet.yaml:471-475`
exists to prevent.

**The three arms, so the question is answerable rather than open-ended:**

1. **Take the commission as written.** All four seats on `ollama-cloud/gpt-oss:120b`. §5.9 gains a
   second amendment naming `triage` and `observer`, `fleet.yaml:471-475`'s comment is rewritten
   rather than deleted, and the exposure is accepted in writing. Two config edits make the model
   resolvable (§6.11).
2. **Split the seats.** The three observers stay local (`gpt-oss-20b-MXFP4-Q8`) because they are the
   ones holding cluster and log text; the `triage` worker runs
   `ollama-cloud/gpt-oss:120b` because its context is three already-summarised artifacts rather than
   raw output. **This is the arm this document would recommend if it had standing to**, and it is
   the one that reads §5.9's privacy axis as being about *what reaches the vendor* rather than about
   *which role name*. Its honest cost: an observer's `.md` half carries actual log lines
   (SRD-OBSERVER-001 §11.3 requires it), so the triage worker's context still contains them at one
   remove. **The split narrows the exposure; it does not remove it, and this document will not
   claim it does.**
3. **All four local.** The console works, the fleet's privacy posture is unchanged, and the
   commission's model request is refused. Costs whatever a 20B model costs against a 120B one on a
   reconciliation task — which is the task SRD-OBSERVER-001 §6.2 says most needs the budget.

**Nothing else in this document depends on which arm is taken.** Every other section is written to
be correct under all three.

### 0.3 The disclosure boundary, and the gate that does not cover this console

This document names two things it cannot avoid and that are already in the tree: the hosted provider
`ollama-cloud` and its endpoint, because `fleet.yaml:149-282` already publishes them; and the fact
that `cni-dev` and the service names `mia`, `authorization` and `authentication` appear here, because
the commission names them and a specification whose worked example is invented is worse than one
whose example is real. No cloud project, no cluster endpoint, no namespace, no credential value and
no ticket system is named.

**One consequence belongs here rather than in §4, because it is a finding rather than a caveat.**
`run.hosted_repo_consent` (`fleet.yaml:76`) is the fleet's disclosure gate for a hosted provider, and
it keys on **the repository's remote**. Its value is a URL, deliberately, *"so consent cannot
transfer to the next repo launched from"*. Every seat in this console is `isolation: none` (§6.1):
there is no `/workspace`, no clone, and no repository content of any kind reaching the vendor.

**So the gate does not fire, and the exposure this console creates is the one the gate was never
designed to see.** A `triage` console on a hosted provider sends live infrastructure observation to a
third party while `hosted_repo_consent` correctly reports that no repository was disclosed. That is
not a defect in the gate — it is a gate answering the question it was built for. It is recorded here
because a reader checking "is this console consented" will find a green answer to a different
question, and because it is the strongest available argument for §0.2 arm 2 or 3.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Read** | code and config in this repository, opened 2026-09-06, file and line cited at every claim | §2, §3.1-§3.3, §4, §6.11 |
| **Measured** | two probes run on this host on 2026-09-06 and recorded in §0.6 | Finding E only |
| **Recorded** | `Docs/SRD.md` §5.9/§12.1/§12.5/§12.6, `Docs/SRD-DEPLOY-OPS.md` §3.3/§6.2/§7.1/§7.5/§9/§11, `Docs/SRD-REVIEW-CONSOLE.md` §0.2/§6.4/§6.5/§6.6, `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5, `~/.claude/skills/fleet/` | §1, §4, §6.5-§6.7, §8 |
| **Inferred** | reasoning from the above | §5-§7, §9, §10, §13. **These are proposals, not observations, and they are where the owner's review is most valuable.** |

**Nothing was executed against a live fleet.** No console was opened, no worker created, no dispatch
issued, no model called, no cluster read. Every §2 claim is a claim about **what the code says it
does**. The two things that were executed are named in Finding E and they touched nothing in this
repository. Where a claim would need a running system to settle, §11 holds it as an open question
rather than asserting it.

### 0.5 Four corrections to the premises this document was commissioned against

**1. The model is spelled `ollama-cloud/gpt-oss:120b`, with a colon, and it does not resolve today.**
The commission writes `gpt-oss-120b`. Ollama's catalogue is tag-style and `fleet.yaml:271-276` says
so — `tag_style: true` — so the id carries a colon and the `:120b` is not eaten as a thinking suffix.
More consequentially, the model is **not in `llm.providers.ollama-cloud.models_allowlist`**
(`fleet.yaml:248-251`, which holds `deepseek-v4-pro:0813`, `qwen3.5:397b` and `glm-5.3`) and has **no
`context_windows` entry** (`:267-270`). A worker resolving to it is refused at `up` by
`assertModelsAllowed` (`src/cli/commands/up.ts:441-447`) via `ModelNotAllowedError`
(`src/config/load.ts:799-812`, `:835-880`). §6.11 is the two-line fix; §0.2 is whether to apply it.

**2. There is no `consoles:` key, and a console is a code change rather than a config edit.**
`FleetConfigSchema` is `.strict()` with thirteen keys (`src/config/schema.ts:1486-1502`), so writing
`consoles:` is a hard validation error. Console membership lives in
`src/backends/cmux/operations-plan.ts` as three pairs of constants — `REVIEW_WORKSPACE` /
`DEFAULT_REVIEW_WORKERS` at `:833` and `:869-874` are the pattern — and each console is a
`WorkspaceSpec` value in `src/backends/cmux/operations.ts:85-96`, whose own comment (`:136-139`)
states the intent: *"adding a console is a value here"*. So a `triage` console is a value, a pane
plan, a driver script, and four `workers:` entries. It is not a `fleet.yaml` feature.

**3. `pifleet relay` is not a general actor — it is the review console's, and its roster default is
hardcoded.** `resolveRoster` (`dispatch-request.ts:427-428`) falls back to `REVIEW_CONSOLE_ROSTER`
(`:298-300`), and `src/cli/commands/relay.ts:377-392` records that `--console` **has not landed**:
*"it should be solved once — when `--console` lands (§6.5) — rather than twice in two shapes."* A
triage console is the second consumer that needs it, so this document does not get to treat
`--console` as present. §13 Phase 2 builds it.

**4. "Send a notification via claude" has no implementation anywhere in this repository, and the
endpoint it most plausibly names is not running.** See Finding E. This is the least specified part
of the commission and §6.9 picks an arm rather than assuming one; §11 Q2 is the ambiguity flagged
rather than buried.

### 0.6 What reading the code found

Six findings. Four of them change what a section downstream may assume; two are reachable today and
matter whether or not this console is ever built.

| # | Finding | Reachable today? | § |
|---|---|---|---|
| **A** | **The request plane already generalises to a second console, and the generalisation is free.** `ConsoleRoster` is `{collators: readonly string[], reviewers: readonly string[]}` (`dispatch-request.ts:279-283`), the context takes a `roster` (`:427`), and `relayPass` is bounded by `new Set([...roster.collators, ...roster.reviewers])` (`relay.ts:394`). A `TRIAGE_CONSOLE_ROSTER` is a value. `MAX_DISPATCH_REQUEST_ITEMS = 8` (`dispatch-request.ts:158`) leaves room for three targets, and `duplicate_target` (`:681`) means **one request per observer, never two** — which is the fan-out rule of §6.5 arriving from the schema rather than from taste. The two field names become slightly wrong for this console and the shape is exactly right. | Yes | §2.1, §6.5 |
| **B** | **The relay pins its run ids for the life of the process, so a scheduler that restarts a worker is a scheduler that breaks its own actor.** `Workflows/Consoles.md:124-129`: *"The relay holds `--run` for the collator and a `PIFLEET_RELAY_RUNS` pin for the other three, both fixed for the life of the process; a relay left pointing at a run that no longer exists polls forever in silence, and a pinned worker it cannot resolve refuses every fan-out."* A five-minute cadence that restarted its observers would invalidate those pins **864 times a day**. This is the single constraint that decides the console's shape. | Yes | §2.2, §6.1, §6.6 |
| **C** | **`run.budget.tokens_ceiling` is per RUN and IS enforced; `run.budget.run_timeout` is per run and is enforced by NOTHING.** `budget.ts:293-297` refuses admission on `max_concurrent` and the ceiling is the run's, ending it on exit 5. `grep -rn 'run_timeout' src/` returns exactly one line — `src/config/schema.ts:319`, the declaration — and **no reader anywhere**. So a standing console is not killed at two hours, which is why this design is possible at all; and it has a hard lifetime measured in tokens, which nothing currently announces. **A triage console that stops triaging because it spent its budget is silent today.** §6.10. | Yes | §2.7, §6.10 |
| **D** | **`pane_mode: tui` allocates no epoch, and `fleet.yaml:487-489` already argues that the `observer` role is the one least able to afford it.** *"the ROLE stays rpc — tui allocates no epoch, so a re-dispatched watch pass would run twice."* `fleet.example.yaml:551-556` puts it at length and names the reason: an observer watch is *"built on repeated dispatch of near-identical tasks"*. A five-minute cadence is that argument multiplied by 288. The schema already warns on it — `observerTuiEpochWarning`, `schema.ts:1841-1851`, keyed on the role NAME because the hazard is what `observer-ops` does. `tui` also costs `--auto` outright: `dispatch.ts:1219-1231` rejects a `pane` route with `pane_mode_tui_is_not_auto_schedulable`. | Yes | §2.3, §6.1 |
| **D′** | **`rpc` buys the epoch fence and NOT a fresh session, and this is the finding this design most nearly got wrong.** A worker's Pi session id **is its worker id** (`src/config/render.ts:203`, `--session-id w.id`) and its session directory is the **run's** (`render.ts:513`, `-v <run>/sessions:/sessions`). So a session is per `(run, worker)` and survives every dispatch into that run, on **both** pane modes. `grep` finds no `/clear`, no context-reset verb, no session rotation anywhere in `src/`. **A standing triage run therefore accumulates 288 sweeps of transcript per day into one session, and Pi auto-compacts it.** The only lever in the tree is a **new run** — and `fresh-dispatch.ts:29-42` is the measured proof of what the absence costs: *"it answered about `T-unit-tests-2` — the PREVIOUS task — reciting that envelope's contents without opening the new one… The run settled `success` seven seconds after staging."* | Yes | §2.3a, §6.6 |
| **G** | **A notification API exists in this repository, has ZERO call sites, and is explicitly forbidden from carrying anything that matters.** `src/backends/types.ts:49-52` declares `interface Notification { title: string; body: string }`; `:116` makes `notify?()` optional on the backend; `cmux/client.ts:256-261` builds the argv and `cmux/index.ts:342-344` is the only implementation, while `tmux/index.ts:233-237` is a deliberate no-op — *"Not implemented rather than pretending delivery happened."* The header at `types.ts:104` settles it: **"Presentation plane only. Nothing correctness-bearing may live behind this."** So it is not this console's notifier. **And the name is already taken twice**: `notify` is a Pi UI-request method the supervisor is contractually required *not* to answer (`src/supervisor/ui-requests.ts:127-138`, `FIRE_AND_FORGET_METHODS`). | Yes | §2.5, §6.9 |
| **E** | **There is no clock and no notifier anywhere in this fleet, and the endpoint the commission most plausibly names is not listening.** `run:` carries `per_task_timeout`, `run_timeout` and four `timers` (`fleet.yaml:86-92`) and **nothing that schedules**. The one recurring host process is `pifleet relay`, whose loop is a `setTimeout` around an exported single pass (`relay.ts:82-88`, `:767`) — which is the pattern this design copies rather than the scheduler it needs. For the notifier: **measured on this host 2026-09-06** — `curl` to `localhost:8888` and `localhost:31337` both returned no response, and `lsof -nP -iTCP -sTCP:LISTEN` showed neither port bound. The PAI voice server is real (`~/repos/paisley/.claude/voice-server/server.ts:249`, `POST /notify`, payload `{title, message, voice_enabled, voice_id}`, launchd `com.paivoice.server`, `PORT` default `8888` at `:24`) and its service was **not loaded**. | Yes | §2.4, §2.5, §6.9 |
| **F** | **The verdict vocabulary a notifier needs already exists, is exactly right, and is NOT YET WRITTEN into the skill the observers follow.** SRD-OBSERVER-001 §9.1 separates `status` (did I observe) from `assessment` (`healthy \| degraded \| unhealthy \| indeterminate`) from `coverage` (per channel). `skills/observer-ops/SKILL.md:104-112` says the verdict rule is **not in the bundle yet**: *"Still unwritten: … the verdict rule (`indeterminate` vs `healthy` vs `failed`)"*, with the interim instruction *"apply the one your briefing states and do not invent a finer one"*. **So this console's briefs must carry the verdict rule until §8 of SRD-OBSERVER-001 lands**, and a design that assumed a shipped rule would be reading a document rather than the skill. | Yes | §2.6, §6.7, §7.4 |

---

## 1. Problem statement

### 1.1 What was asked for, and what of it is free

> *"create an SRD for a triage worker. It will exist in a new pan called triage with 3 observer
> workers. They will all use ollama cloud gpt-oss-120b. The triage worker will work through a list of
> services in an environment (e.g. mia, authorization and authentication services in cni-dev) and
> will on a cadence (configurable, default every 5 minutes) it will dispatch the observer workers to
> check the health of the services. If the find an issue the triage agent will send a notification
> via claude"*

Free, or nearly:

- **The fan-out.** Finding A. A worker writes a request; a host actor performs it. No new capability,
  no new mount, no new secret in a container.
- **The health check itself.** `roles/observer.md` is 97 lines of exactly this job, down to the
  sentences that matter most here: *"Deployed and working are separate findings"*, *"A query that
  returned nothing is not evidence of absence"*, and *"a channel you could not reach is a gap in what
  you saw, not a clean result wearing one fewer data point."*
- **The verdict vocabulary.** Finding F. `healthy`/`degraded`/`unhealthy`/`indeterminate`, plus a
  coverage axis, plus the rule that binds them — SRD-OBSERVER-001 §9.2's *"`assessment: healthy`
  requires positive evidence… Absence of a negative signal from a degraded channel set is
  `indeterminate` — never `healthy`."*
- **The provider.** `ollama-cloud` exists, its relay target is already in `egress.allow`
  (`fleet.yaml:291`), and `OLLAMA_API_KEY` is already the provider credential (`:170`). §6.11 is two
  lines, not an integration phase.
- **The one-pass-per-task design.** SRD-OBSERVER-001 §7.5 already decided that *"one task is one
  observation pass, and the orchestrator re-dispatches"*, for reasons — `per_task_timeout: 25m`,
  `event_stall_kill: 25m` firing on **silence** — that apply here unchanged.

### 1.2 The three things that are not free, and they are the whole document

**1. The clock.** Every dispatch in this fleet today is one-shot and human-initiated. Nothing in
`src/` schedules anything. The clock needs a home, a supervision story, a behaviour when a sweep
overruns its own cadence, and a way to be stopped. §6.4.

**2. The notification.** There is no notifier. There is no "an issue" predicate. There is no
deduplication. A five-minute cadence against a broken service is **288 notifications a day** unless
something says otherwise, and the something has to survive a service that flaps — which a naive
edge-triggered rule does not, because a service that alternates every sweep transitions every sweep.
§6.7, §6.8, §6.9.

**3. Freshness at 288 dispatches a day, which is two problems rather than one.** A session is per
`(run, worker)` and nothing rotates it, so a standing console **accumulates** a day's transcript into
one window and Pi compacts it — certain, and derivable from two argv flags (§2.3a). Separately it may
**replay**, which is measured on `tui` seats and unmeasured on `rpc` ones (§3.4). The fleet's own
remedy for both is `--restart <id> --task <file>` (`SKILL.md:103-127`), and Finding B says a scheduler
cannot use it per sweep. So the answer is four layers, and the one that makes an unattended console
possible at all is available only because an `rpc` recreate needs no terminal. §6.6.

### 1.3 The cost of not having it, stated honestly

The operator can already ask `obs-1` about a service, one service at a time, by hand, and get a good
answer. What this buys is **the sweep nobody remembers to run**: the check at 03:00, the check on the
service nobody was thinking about, and — the one that pays for the console — the **before** half of a
before-and-after. SRD-OBSERVER-001 §9.2a: *"A baseline has to exist before the change to be a
baseline"*, and today every baseline in this fleet is reconstructed after the fact. A console that
has been sweeping every five minutes has an observed baseline for free.

**What it does not buy, and this must not be implied:** it is not monitoring, it does not replace an
alerting system, and it has no more coverage than three read-only agents polling four channels can
see. SRD-OBSERVER-001 §3.2 is explicit that *"Deciding that a finding is an incident"* is a human
call. This console reports; it does not page.

### 1.4 Success in one sentence

**A console that has been up for a day can say, for every service in its targets file, when it was
last observed, what it was, and — for anything that broke — exactly one notification when it broke
and exactly one when it recovered.**

---

## 2. The current state, read from the code

### 2.1 The request plane already generalises, and the two field names are the only thing wrong

`ConsoleRoster` (`src/run/dispatch-request.ts:279-283`):

```ts
export interface ConsoleRoster {
  collators: readonly string[];
  reviewers: readonly string[];
}
```

The module's own comment (`:274-278`) says what each half is for: *"`collators` answers 'may this
worker ask?' … `reviewers` answers"* whether a target is legal. `assertRoster` (`:388-405`) refuses
an empty half on either side, `resolveRoster` (`:427-428`) defaults to `REVIEW_CONSOLE_ROSTER`, and
`relayPass` bounds its scan to the union (`relay.ts:394`) with the comment *"Still bounded by the
ROSTER, so this is not a scan of every worker in the fleet."*

So `TRIAGE_CONSOLE_ROSTER = {collators: ["tri-1"], reviewers: ["obs-t1", "obs-t2", "obs-t3"]}` is a
value that needs no schema change and no new refusal. The names read wrong — an observer is not a
reviewer — and **renaming them is out of scope**, because the type is load-bearing in a shipped
console and a rename is churn that hides the real change. §10 D5.

The refusals come free too, and two of them are load-bearing here: `duplicate_target` (`:681`) makes
a partition that names one observer twice a refused file rather than a lost service, and
`worker_not_in_console` (`:680`) makes a triage worker that invents a worker id a refused file rather
than a dispatch. Both are the host counting rather than the worker claiming.

### 2.2 The relay pins run ids, and that decides the console's shape

Finding B. The mechanism, from `Workflows/Consoles.md:124-129`, is that restarting **any** review
pane restarts the relay too, *"required rather than tidy"*.

Follow that through for a scheduler and the arithmetic is brutal: 288 sweeps a day, three observers,
a `--restart` per observer per sweep for freshness — **864 pane respawns and 864 actor restarts a
day**, each one a window in which a fan-out cannot be performed. That is not a tuning problem. It
rules out the obvious design.

**Two properties fall out and they are the spine of §6.1.** The seats must not be restarted per
sweep, which forces freshness to come from epoch fencing rather than from container recreation
(§6.6). And if the seats are never restarted, their run ids are stable for the console's life — at
which point the pin is not a problem at all, and the simpler arrangement becomes available: **one run
holding all four workers**, rather than four runs needing a pin map.

The one run is available only because none of the seats is `tui`. `Workflows/Consoles.md:147-148`:
*"`development` and `review` are four runs each, because every pane is attended and `--attach-here`
hands over the terminal of the process that runs it."* An `rpc` worker needs no terminal, and
`README.md:52` shows the shape directly: `pifleet up --workers eng-1,tst-2`.

**The cost of one run is real and is `run.max_concurrent`.** It bounds each run
(`operations-plan.ts:627-632`, `budget.ts:293-297`), and this fleet sets it to `1`
(`fleet.yaml:77`). Four workers in one run at `max_concurrent: 1` generate strictly one at a time, so
a three-observer fan-out serialises — three passes end to end inside a five-minute cadence is not a
budget, it is a hope. §11 Q3 puts the number to the owner with one observation that makes it cheap:
**raising it binds only runs that hold more than one worker**, and every seat in the other three
consoles is its own run of one, where a concurrency of three can never be reached.

### 2.3 A `tui` seat is the one thing this console cannot have

Finding D, and the config already argues it. `fleet.yaml:487-489` on the `observer` role, and
`fleet.example.yaml:551-556` at length:

> *"Moving it up to the role would put every observer on tui, and tui allocates no epoch: with no
> `already_completed` fence a re-dispatched pass runs the same task twice, which an observer watch —
> built on repeated dispatch of near-identical tasks (§7.5) — is the least able role to afford."*

`obs-1` carries `pane_mode: tui` as a **worker-level override** (`fleet.yaml:730`) because it is the
operations console's keyboard; `obs-2` takes the dispatched passes on the role's `rpc`
(`fleet.example.yaml:572`, and its comment `:556`: *"obs-1 is the one a human watches; obs-2 takes
the dispatched passes"*).

The rest of what `tui` costs is enumerated in `unattendedTuiWarning` (`src/cli/commands/up.ts:414-439`)
and every item bites a scheduler: `dispatch --auto` will not schedule it — the refusal is explicit,
`pane_mode_tui_is_not_auto_schedulable` (`dispatch.ts:1219-1231`), because *"a tui worker is prompted
through its pane and settles from its transcript; `--auto` cannot observe that task reaching a
terminal state"*; `dispatch` types into the pane with a null epoch and no acknowledgement; completion
is transcript-derived and coarse (`supervisor/tui.ts:322-334`: *"an agent that answers 'I'll get right
on that' and stops reads exactly like one that finished"*); and **closing the pane stops the worker**.
A console meant to run when nobody is watching cannot have a seat whose liveness depends on a window
being open.

**One `tui` cost is a hard blocker rather than a degradation, and it decides §6.6.** Recreating a
`tui` pane goes through `up --attach-here`, which **requires a real TTY on both stdin and stdout** —
`src/attended/adopt.ts:96-114`'s `adoptRefusal` returns `not_a_terminal` otherwise, and
`up.ts:349-351` names the exact callers that fail it: *"CI, a cron entry, a detached wrapper and a
`nohup` all present as three pipes."* **An unattended actor cannot refresh a `tui` seat at all.** It
can refresh an `rpc` one, because `up`/`down` on an `rpc` worker needs no terminal — and that is what
makes §6.6's recycling implementable without a GUI.

### 2.3a `rpc` fixes the epoch and not the session, and 288 sweeps a day is the number that matters

Finding D′, and it is the correction this design most nearly missed. The session is per
`(run, worker)` and structural: `--session-id` is the worker id (`src/config/render.ts:203`) and
`--session-dir` is `/sessions`, bound from the **run's** `sessions/` directory (`render.ts:513`).
Nothing rotates it. `grep` over `src/` finds no `/clear`, no context-reset verb and no session
rotation of any kind.

So a standing triage run does not merely *risk* a replay — it **accumulates**. 288 sweeps a day, each
one a brief plus three artifacts' worth of reasoning, into one transcript that Pi will auto-compact
rather than refuse. `fleet.yaml:252-257` already records what auto-compaction does to a worker in this
fleet, in a different context and for a different reason: a seat compacted at 152,447 tokens.

**The only lever in the tree is a new run**, and `fresh-dispatch.ts:29-42` is the measured statement
of both the failure and the fix:

> *"A `pane_mode: tui` worker keeps its session across epochs. Measured 2026-09-04… it answered about
> `T-unit-tests-2` — the PREVIOUS task — reciting that envelope's contents without opening the new
> one… The run settled `success` seven seconds after staging. A worker that has never seen another
> task cannot do that. So the fix available here is not a better trigger but a fresh session:
> recreate first, dispatch second."*

The measurement is on a `tui` worker and §3.4 keeps that qualification. **The accumulation is not
mode-dependent and needs no probe** — it follows from two argv flags — which is why §6.6 promotes
recycling from a deferred idea to a designed one.

### 2.4 There is no clock in this fleet, and the one recurring process says how to build one

`run:` (`fleet.yaml:46-92`) carries budgets and timeouts and nothing periodic. The only recurring
host process is `pifleet relay`, and its module docblock is the design note this document needs
(`src/cli/commands/relay.ts:82-88`):

> ## `--once` is the real command and the loop is the wrapper
>
> *"`relayPass` is one pass, exported, and takes its fan-out as an argument. The loop is `setTimeout`
> around it. That ordering is a testability decision made deliberately: a poller written as an
> infinite loop can only be tested by starting it and killing it, which is a test that measures its
> own timeout, and `scripts/` will want a single pass anyway for a console that is driven by hand."*

The command already carries `--once` and `--poll <seconds>` (`relay.ts:618-619`) with a
`DEFAULT_POLL_S`, and the loop is one `setTimeout` (`:767`). **This is both the pattern and the
coverage-gate answer** (§3.3): a scheduler whose tick is an exported pure-ish pass and whose loop is
a three-line wrapper is a scheduler a unit test can drive in-process.

Its bookkeeping convention is equally reusable: `~/.pifleet/review-relay.json` (`pid`, `started`,
`run_id`, `pinned`, `workers`), `review-relay.log` *"appended, never truncated"*, and
`review-relay.lock` (`Workflows/Consoles.md:64-66`).

Two more properties of that process are worth taking rather than rediscovering. **It supervises
itself downward**: `ConsoleWatch` (`src/run/console-relay.ts:274-312`, `RELAY_ABANDON_PASSES = 5`)
exits the actor once the console it serves stops being live, *"which is what makes `pifleet down`
authoritative over a process it has never heard of"* (`relay.ts:724-739`), and it requires a **run**
of negative observations because *"Liveness is read from the worker's state file and a `ps`, and both
can fail transiently… A RUN of them cannot be transient"* (`console-relay.ts:261-273`). And **its
loop survives a thrown pass** (`relay.ts:700-723`) — it was `for(;;) { emit(await relayPass(...)) }`
with no catch, so *"any throw ENDED the actor"*, and nothing restarts it: *"it has no pane, no
supervisor, and `scripts/review` does not mention it."* `--once` deliberately does not get the catch.

**One collision to design around rather than trip over.** The actor's three bookkeeping paths are
host-wide with hard-coded `review-` basenames (`console-relay.ts:79-86`, `:525-527`), and its roster
and aspect tables are module constants (`dispatch-request.ts:298-301`,
`task-ids.ts:124-128`). A second console's actor sharing those files would take over the review
console's lock. **Five things must be parameterised**, and the seams already exist: `relayFanOut`
takes aspects as a parameter (`task-ids.ts:113-118`) and `readDispatchRequest` takes `roster` as a
context field (`dispatch-request.ts:717-721`).

### 2.5 There is no notification channel in this fleet either

Finding E. Nothing in `src/` sends anything anywhere: a sweep for `ntfy`, `pushover`, `telegram`,
`smtp`, `pagerduty`, `discord`, `curl -X POST`, `osascript`, `terminal-notifier` and `notify-send`
across `src/`, `scripts/`, `docker/`, `roles/`, `skills/` and `test/` returns nothing. The fleet's
outputs are files in a run tree and what `pifleet report`, `artifacts` and `status` print to a
terminal a person is looking at.

**One thing that looks like an exception and is not.** Finding G: `backend.notify()` exists, is
optional on the interface, has **zero production call sites**, and its own header forbids the use
this console would put it to — *"Presentation plane only. Nothing correctness-bearing may live behind
this"* (`src/backends/types.ts:104`). Its tmux implementation is a deliberate no-op. **A triage
notification is correctness-bearing by construction** — it is the console's entire output — so it does
not go there, and §6.9's transport is separate. The name must also not be reused: `notify` is already
a Pi UI-request method in `FIRE_AND_FORGET_METHODS` (`supervisor/ui-requests.ts:127-138`).

The candidate the commission most plausibly names is host-side and outside this repository:
`~/repos/paisley/.claude/voice-server/server.ts` serves `POST /notify` at `:249`, taking
`{title, message, voice_enabled, voice_id}` (`:252-255`), with a rate limiter that returns 429
(`:240-246`), installed as launchd `com.paivoice.server` on port `8888`
(`macos-service/com.paivoice.server.plist:18`, `server.ts:24`).

**Measured 2026-09-06 on this host: it is not running.** Neither `8888` nor `31337` answered, and
neither was in `lsof -nP -iTCP -sTCP:LISTEN`. So the channel this design picks is real, is the
operator's own, and **is not available today** — which makes §6.9's undelivered-notification path a
requirement rather than a nicety.

### 2.6 The verdict rule this console depends on is specified and not yet shipped

Finding F. `skills/observer-ops/SKILL.md:104-112` names what is missing by name — *"the verdict rule
(`indeterminate` vs `healthy` vs `failed`)"* — and gives the interim instruction:

> *"Until the verdict rule is written here, apply the one your briefing states and do not invent a
> finer one: a channel you could not reach is `indeterminate`, never `healthy`."*

So the rule travels in the brief. §7.2 makes it a required, host-rendered block of the sweep envelope
rather than something a triage worker composes, because a rule a model writes is a rule that drifts
between sweeps and this console's whole value is that consecutive sweeps are comparable.

### 2.7 The budget ceiling is per run, and this console is one run that never ends

Finding C. `run.budget.tokens_ceiling: 6000000` (`fleet.yaml:79`) is *"THE ceiling — local models have
no price table"*, and `per_task_reserve_tokens: 400000` (`:85`) makes the last slice unreachable:
*"a run that spends its budget ends on exit 5 'budget refused admission', not on a crossed ceiling"*
(`:79-84`).

Every other console in this fleet is short-lived relative to that number, or is four runs each
spending separately. **A triage console is one run that is meant to live for days.** So the ceiling
binds here first and hardest, and when it binds the console stops sweeping — quietly, because nothing
announces it. §6.10 makes that a notification. §11 Q4 asks whether the number is right for a console
whose job is to keep running.

`run_timeout: 2h` would have made this impossible, and it does not, because nothing reads it.
That is recorded as a **dependency rather than a relief**: if `run_timeout` ever gains a reader, this
console dies at two hours and the failure will look like anything but a config default.

---

## 3. What is knowable

### 3.1 Knowable and free: the roster, the refusals, and the provider

Finding A and §6.11. The fan-out's roster is a value, its refusals already cover the two ways a
partition can be wrong, and the provider needs two lines rather than an integration.

### 3.2 Knowable and free: `isolation: none` removes this console's worst foot-gun

`Workflows/Consoles.md:16-30` calls the launch directory *"the single most consequential thing about
opening a console"*, and *"it is silent if you get it wrong — the run comes up healthy and the workers
do good work on the wrong codebase."* Every seat here is `isolation: none` — the `observer` and
`ticketing` precedent (`fleet.yaml:486`, `:563`) — so there is no `/workspace`, no clone, and **the
launch directory does not matter.** That is a genuine simplification and the only one this console
gets for free.

### 3.3 Knowable from the CI config: what a new `src/` module must look like

`.github/workflows/ci.yml:61-62` runs `bun run test:coverage` then `bun scripts/coverage-modules.ts`,
inside the `test` job. That script's rule (`scripts/coverage-modules.ts:133-138`):

> `MISSING: <m> is not in the coverage report — nothing imports it in-process.`
> `  Either add a test that imports it, or declare it in STRUCTURAL_ABSENCES with the`
> `  structural reason the profiler cannot reach it. "We have not tested it yet" is not one.`

And it fails in **both** directions (`:14-20`): a stale exemption that now appears in the report fails
too. `STRUCTURAL_ABSENCES` currently holds exactly one entry — `src/backends/types.ts`, *"types-only"*
(`:58-63`).

**So every module this document proposes must be drivable in-process by a unit test**, which means
the house pattern rather than a new one: decisions as exported pure functions over injected
dependencies (`compareModules(onDisk, covered, exemptions)` at `:87-97`; `FreshDispatchDeps`'
`quiesce: (() => Promise<void>) | null`, *required and nullable* per ISC-572; `relayPass` taking its
fan-out as an argument), and I/O confined to a `main()` the script imports.

**Three existing patterns, and using them is cheaper than arguing about them.** `src/cli/index.ts` is
the template for a guarded entrypoint: `main` is **not exported** (`:90`) and sits behind
`if (import.meta.main)` (`:163`), while everything a test needs — `CliError` (`:23`),
`exitCodeForError` (`:54`), `buildProgram` (`:74`) — is exported above the guard. **Guard the side
effect, export the policy.** `src/monitor/read/docker.ts:122` names its injected seam as a type
(`export type DockerPsRun = () => Promise<DockerPsResult>`) and takes it through an optional ports
object with real defaults and an injected clock (`:209-214`); `src/report/merge.ts:48` uses the other
idiom, a defaulted last parameter (`run: GitRunner = runGit`), with the pure half split out at
`:234`.

**And a warning from the gate's own history: the command-wiring layer is the layer that keeps falling
out of the report.** `test/unit/pm-guard-command.test.ts:57` exists for exactly one reason — its own
header records that `pm-guards.test.ts` already drove both judgements as pure functions and *"does not
touch `src/cli/commands/pm-guard.ts`, and the coverage gate noticed."* A `src/cli/commands/triage.ts`
will land in the same hole unless a test imports its `register` directly.

**Two related registration facts.** `test/unit/cli.test.ts` asserts a `SRD_COMMANDS` set in **both**
directions (`:40` *"registers every command in SRD §10"*, `:45` *"registers no command outside SRD
§10"*), and five commands — `tui`, `monitor`, `relay`, `unstage`, `pm-guard` — are excluded on
purpose, each with its own importer test. **A `triage` command either joins that list and gets a
`Docs/SRD.md` §10 row, or it needs its own.** Getting this wrong reddens a test whose message is
about a table rather than about the command.

**One trap, recorded rather than discovered later.** `scripts/` is **outside `tsconfig.json`'s
`include`** — ISA ISC-572 records it: *"a console that forgot `quiesce` is caught by neither
`bun run typecheck` nor the suite."* So `scripts/triage` must be I/O only, exactly as
`scripts/development:36-40` says of itself (*"Only I/O lives here… The decisions are in
`src/backends/cmux/operations-plan.ts`"*), and every decision must live in `src/` where the typechecker
and the coverage gate can both reach it.

### 3.4 Not knowable without a probe, and it is narrower than it looks: does an `rpc` worker *replay*?

The **accumulation** in §2.3a needs no probe — it follows from `--session-id` and `--session-dir`.
What needs one is whether accumulation becomes *replay*.

The measured replay is a `tui` one, twice recorded.
`~/.claude/skills/fleet/SKILL.md:113-118`: *"a re-dispatch to `tst-1` came back with **the previous
task's answer**, replayed as though it were fresh work. Nothing in the envelope, the status table or
the result flagged it."* And `fresh-dispatch.ts:29-42` has the run and the date. `tst-1` is
`pane_mode: tui` (`fleet.yaml:757`), and both accounts attribute the behaviour partly to the trigger:
*"the cheapest thing a model can do with a vague 'a task was staged for you' is answer from what it
already holds."* An `rpc` dispatch delivers the brief through the control stream rather than through
a one-line pane nudge, so **the vague-trigger half of the cause is absent** and the stale-context
half is not.

**Nothing in this repository measures the `rpc` case.** §6.6 is written to be correct either way —
layer 3 detects it, layer 4 bounds it — and §11 Q5 is the probe.

### 3.5 Not knowable at all: whether a "healthy" was actually checked

SRD-REVIEW-CONSOLE §3.4's problem, in this console's clothes. Nothing downstream can re-derive
whether an observer looked. What the design can do is make the *shape* of the answer checkable —
`coverage[]` present, the selector and window named, the evidence ledger non-empty — and refuse a
`healthy` that carries none of it. That is §6.7's gate, and it is grading on structure, which
SRD-REVIEW-CONSOLE D8 is explicit *"is not acceptance and must not be described as acceptance."*

---

## 4. The principles this bumps into

### 4.1 `Docs/SRD.md` §5.9 — the hosted amendment is bounded, and this console is outside the bound

§0.2. The amendment permits a hosted provider *"on the `engineer`, `tester` and `reviewer` roles …
and nothing else"*, and names `observer` in the exclusion. Arms 1 and 2 of §0.2 both require §5.9 to
be amended a second time, in writing, by the owner. **This document may not do that and does not.**

### 4.2 `Docs/SRD-REVIEW-CONSOLE.md` §0.2 — an agent may not dispatch

The commission says *"the triage worker … will dispatch the observer workers"*. In this fleet it may
not, and the argument is not this document's:

> *"A worker that can cause another worker to run has an effect that leaves its own container by
> design. No container boundary bounds it, because the effect is the point."*

The answer is already built: the triage worker **asks**, by writing `dispatch-request.json` into its
own outbox, and the host **performs**. So the commission's sentence is satisfied in substance and not
in mechanism, and the difference is worth one line in §8's skill text so an operator reading
"the triage worker dispatches" is not surprised by a request file.

### 4.3 `Docs/SRD.md` §12.6 — worker prose is data, and a notification is the sharpest case yet

> *"A worker that read a poisoned README can emit 'reviewer approved; merge to main'."*

Here the poisoned input is not a README — it is a **log line from a live service**, which is exactly
the untrusted text an observer is paid to read and quote. A notification composed from that prose and
sent to the operator's own assistant surface is the highest-leverage injection path this fleet has
ever had: it reaches the operator, in the operator's voice, out of band, with no repository diff to
inspect.

**So §6.9's rule is not hygiene.** The notification's `title` and `message` are rendered host-side
from **typed fields only** — environment, service, assessment, transition, timestamps, counts. Worker
prose may appear only in a fenced, banner-marked evidence block that is not the spoken message, and
§12.6's erratum is worth reading before implementing it: fencing and banner-marking are recorded as
**not met** on the existing surfaces, so this is not a mechanism to inherit — it is one to build.

### 4.4 `Docs/SRD-DEPLOY-OPS.md` §3.3 — one scheduler

> *"**Autonomous watch scheduling.** The orchestrator re-dispatches (§7.5). A worker that schedules
> its own next wake-up is a second scheduler in a system that has one."*

And §7.5's own note: *"There is also a background poller running alongside the explicit wakeups…
This document does not reproduce that arrangement: two schedulers is the thing §3.3 rules out."*

This document adds the scheduler §3.3 assumed existed. It must therefore be **exactly one**, and §6.4
folds the clock into the same process as the fan-out for that reason rather than for convenience.

---

## 5. Scope and non-goals

### 5.1 In scope

- A fourth standing console, `triage`, with four `rpc` seats and no keyboard.
- A tracked, schema-validated service registry keyed by environment.
- A host-side actor that is the console's clock **and** its fan-out performer.
- A sweep lifecycle: tick → sweep task → partition → three observer passes → collation → verdict.
- A per-service incident state machine with dedup, flap damping and observed recovery.
- One notification channel, host-side, composed from typed fields.
- The `fleet.yaml` and `fleet.example.yaml` edits, and the `/fleet` skill's fourth console.

### 5.2 Non-goals — refused rather than omitted

- **Any mutation, in any environment, by any seat.** SRD-OBSERVER-001 §3.2, inherited whole. No
  restart, no scale, no rollback, no ticket write, no state transition.
- **Deciding that a finding is an incident.** This console reports and notifies. Whether that is a
  page is a person's call.
- **Metric-value judgement.** SRD-OBSERVER-001 §3.3. The console can say a feed stopped; it does not
  decide a latency number is bad.
- **A second notification channel.** One, chosen in §6.9, with the ambiguity flagged. Two channels
  is two dedup states and a way to send half a recovery.
- **A `pifleet` verb that mutates the targets file.** It is a tracked YAML file edited by a person or
  by a dispatched worker with a diff, like every other tracked file here.
- **Cross-run trend memory beyond the incident record.** SRD-OBSERVER-001 §3.3 calls a baseline store
  a separate design and it is right. The incident record is deliberately small: state, timestamps,
  counts, and a pointer to the last artifact. Not a history.

### 5.3 Deliberately deferred

- **A seat restart per sweep.** §6.6 layer 4 recycles every `recycle_after_sweeps` instead; a restart
  per sweep is 288 container recreations a day for a problem a shorter recycle window addresses
  first, and layer 3's sweep-id echo is the detector that would say the window is too long.
- **Per-service cadence.** One cadence per console in v1. A per-service `interval` is a schema field
  and a scheduler that has to reason about phase alignment, and nothing has asked for it.
- **A spend gate.** §6.10 names the exposure and §11 Q4 asks the number. `usd_ceiling` does not exist
  and inventing one here is out of scope.
- **Renaming `ConsoleRoster`'s two fields.** §2.1.

---

## 6. The design

### 6.1 The console — four `rpc` seats, one run, and no keyboard

```yaml
# fleet.yaml — the `triage` console
roles:
  triage:
    model: <see §0.2 — one line, three arms>
    thinking: high            # the job is reconciliation across three partial reports
    toolchain: base
    tools: [read, write, grep, find, ls]   # write is /outbox only; NO bash — §12.1
    skills: [pifleet-worker]
    isolation: none           # no repository; the outbox artifact is the whole output
    pane_mode: rpc            # 288 dispatches a day; the epoch fence is not optional
    append_system_prompt_file: ./roles/triage.md

workers:
  - {id: tri-1,   role: triage}
  - {id: obs-t1,  role: observer}
  - {id: obs-t2,  role: observer}
  - {id: obs-t3,  role: observer}
```

Each field, with the reason:

- **`role: triage`, not `role: collator`.** The two are shaped alike — `read, write, grep, find, ls`,
  no `bash`, one tool more than a reviewer and one short of dispatch (`fleet.yaml:646-651`) — and
  they are not the same job. A collator collates three readings of one artifact; a triage worker
  partitions a service list, judges three readings of *different* subjects, and decides whether a
  human is disturbed. Sharing the role would mean sharing `roles/collator.md`, whose every paragraph
  is about reviews. **The tool grant is copied deliberately, the prompt is not.**
- **No `bash`, on the collator's argument** (`fleet.yaml:646-651`) and §12.1's. A triage worker needs
  to read three files and write two. It needs no shell, and a shell is what turns a request-writing
  worker into a dispatching one.
- **`isolation: none` on all four.** §3.2. No `/workspace`, so the launch directory is irrelevant and
  `hosted_repo_consent` does not fire (§0.3).
- **`pane_mode: rpc` on all four, and this is the console's defining property.** §2.3. It is the
  first console in this fleet with no keyboard, and that is the point: it is the first console that
  runs when nobody is watching.
- **The three observers take the `observer` role unchanged** — including `cloud_access: true`,
  `egress_access: true` and `skills: [pifleet-worker, observer-ops]` (`fleet.yaml:467-490`) — with a
  worker-level `model:` override only if §0.2 arm 1 or 2 is taken. **No new role, and no widened
  grant.** That is the single strongest thing this design has going for it: the observers are the
  role that already exists, doing the job it was written for, at a cadence.
- **`thinking: high` on `triage`**, the `observer`/`collator`/`reviewer` level, and for the same
  reason `fleet.yaml:476` gives: reconciling channels that disagree is where the budget pays.

**The run.** One `pifleet up --workers tri-1,obs-t1,obs-t2,obs-t3`, one run id, stable for the life
of the console. §2.2. `run.max_concurrent` must be at least 3 or the fan-out serialises; §11 Q3.

**The panes.** Four, in the shared 2×2 (`agentSquarePanes`, `operations-plan.ts:707`, capped at
`SQUARE_MAX_PANES = 4` at `:659`) — but **panes here are views, not terminals**, which is
`README.md:10-12`'s rule arriving somewhere it has never been used. `Docs/SRD-REVIEW-CONSOLE.md`
§3.2 records the capability and its status in one line: *"Knowable and currently unused: an `rpc`
worker's pane is a live event view."* **No console does this today**, so §11 Q6 asks whether the
triage console is where it lands or whether v1's panes are simply `pifleet monitor` and a tail of the
actor's log — both of which are just commands in a pane, which `scripts/operations` already does.

### 6.2 The service registry — a tracked file, not `fleet.yaml`, not argv

**`triage/targets.yaml` at the repository root, tracked, schema-validated.**

Rejected, each with its reason:

- **`fleet.yaml`.** Three reasons, and the third is decisive. `FleetConfigSchema` is `.strict()`
  (`schema.ts:1502`), so a `triage:` key is a schema change to the fleet's own contract for data that
  is not fleet configuration. A service inventory changes on a different clock than roles and models.
  And **`fleet.yaml` is gitignored** (`.gitignore:9`), so a service list there is untracked,
  undiffable, and undispatchable — a worker told to edit it produces no diff and is graded `failed`
  as a fabrication under ISC-93, which is the trap `Docs/SRD-FLEET-PROJECT-MANAGER.md` §13 Phase 1
  had to split a task around.
- **A CLI argument.** 288 invocations a day against a list nobody can review. An inventory in argv is
  an inventory with no history.
- **The task envelope.** SRD-OBSERVER-001 §7.1 records that `inputs[]` reaches no prompt — *"a
  structured field carried in the envelope is a record, not a channel to the agent"* — so the list
  would have to be rendered into prose anyway. It is; §7.2. The question is where the source of truth
  lives, and prose is not it.

**Shape** (`pifleet.triagetargets/v1`, full schema §7.1):

```yaml
version: 1
environments:
  cni-dev:
    kube_context: <a context present in cloud.kubeconfig>
    default_window: 5m          # matches the cadence, not "6h" — §6.10
    services:
      - {name: mia,            namespace: <ns>, workload: <name>, checks: [rollout, logs]}
      - {name: authorization,  namespace: <ns>, workload: <name>, checks: [rollout, logs, sink]}
      - {name: authentication, namespace: <ns>, workload: <name>, checks: [rollout, logs, sink]}
```

Four properties this shape is chosen for:

1. **Adding an environment or a service is a YAML edit and nothing else.** The commission's explicit
   requirement.
2. **`kube_context` is declared, never derived.** SRD-OBSERVER-001 §4.1's rule — *"the prohibition on
   templating a namespace from a branch name"* — generalised: nothing here is inferred from a name.
3. **The environment key is the logical token the observer's envelope carries** (§7.1 of
   SRD-OBSERVER-001: *"the logical environment token, matching a context in the filtered
   kubeconfig"*), which makes the fence in §6.10 checkable: a targets file naming a context the
   fleet's `cloud.kubeconfig` does not carry is refused at load, not discovered at the first
   `kubectl`.
4. **`checks[]` is a closed enum**, so a targets file cannot smuggle a command. The observers'
   procedures are `observer-ops`'; the targets file selects among them and cannot extend them.

### 6.3 The sweep lifecycle — eleven steps, and only two of them are new machinery

| # | Step | Who | Where it lands |
|---|---|---|---|
| 1 | tick fires; a sweep is due and none is in flight | actor | `~/.pifleet/triage.json` cursor advances |
| 2 | render the sweep envelope: the environment, the service list, the verdict rule, the sweep id | actor | `<run>/workers/tri-1/inbox/T-sweep-<n>.json` |
| 3 | dispatch it to `tri-1` | actor | `via: rpc`, epoch allocated |
| 4 | partition the services across the three observers and write the fan-out | `tri-1` | `<run>/outbox/tri-1/T-sweep-<n>/dispatch-request.json` |
| 5 | **validate the partition against the targets file**, then dispatch three children | actor | `<run>/relay/tri-1/T-sweep-<n>.json` → `children[]` |
| 6 | each observer runs one pass and writes its artifact pair | `obs-t*` | `/outbox/<child>/files/observer-ops.{json,md}` |
| 7 | join, publish every surviving reply, name the missing ones | actor | `<run>/replies/tri-1/<child>.json` |
| 8 | dispatch the collation | actor | task `T-sweep-<n>-collate` |
| 9 | read three replies; write the per-service verdict document | `tri-1` | `/outbox/<collate>/files/triage.{json,md}` |
| 10 | **read `triage.json`, count coverage host-side, drive the incident machine** | actor | `~/.pifleet/triage/<env>/<service>.json` |
| 11 | emit notifications for state transitions only | actor | the channel, §6.9 |

**Steps 4-8 are the review console's fan-out, unchanged.** The two-turn protocol
(`roles/collator.md:27-33`, *"YOU ARE DISPATCHED TWICE"*), the reason the worker never waits
(SRD-REVIEW-CONSOLE §6.6: *"the collator has no `sleep` because it has no `bash`… A design whose
correctness depends on a model choosing to busy-read a file for twenty minutes is a design with no
failure mode you can name"*), and the join-and-proceed rule are all consumed rather than
re-specified.

**Steps 1-3 and 10-11 are the new machinery.** Everything this document is actually asking to be
built is the clock, the partition check, the incident machine, and the notifier.

### 6.4 The clock — one process, and it is the same one that performs the fan-out

**Decision: a host-side actor, `pifleet triage`, started last by `scripts/triage`, that is both the
console's clock and its fan-out performer.** Its pass is exported and `--once` runs exactly one;
the loop is a `setTimeout` wrapper. `relay.ts:82-88`'s pattern, copied for its stated reason.

**Why one process and not two.** The tick must dispatch into a run, and the fan-out must dispatch
into the same run. Two processes that must agree about a run id is a new failure mode with no
observable — the tick lands in a run the fan-out no longer serves, and the symptom is a sweep that
starts and never collates. One process holds one pin set.

**Rejected alternatives, each with the reason:**

| Home | Why not |
|---|---|
| **Inside `tri-1`'s own session** — a loop in the worker | §4.4: *"A worker that schedules its own next wake-up is a second scheduler."* Mechanically it is worse than that: `tri-1` has no `bash` and therefore no `sleep`; `event_stall_kill: 25m` (`fleet.yaml:91`) fires on **silence**, so a worker sleeping politely is killed as wedged (SRD-OBSERVER-001 §7.5 states exactly this); and a turn that stops is settled two seconds later (`TUI_QUIET_MS`), so "stay in-turn for five minutes" means emitting tool calls continuously for five minutes, forever |
| **launchd / cron** | The honest arm, and it wins on exactly one axis: it re-derives run ids every tick, so it cannot hold a stale pin, and it survives a closed GUI. It loses on three. It ticks into a console that is not there — 288 times a day, into a log nobody reads, with no record saying whether it is armed. It has no way to know a sweep is still running without reading the run tree, which is the state the actor holds anyway. And the fleet's convention is that a host actor's on/off switch is its console script (`Workflows/Consoles.md:68-72`), so a launchd job is an on switch in a second place. **Recorded as the arm to take if the console must survive the GUI — §11 Q7** |
| **The calling Claude Code session, looping** | `Docs/SRD-FLEET-PROJECT-MANAGER.md` §0.2 records the cost of putting an orchestrator in a session: *"it is not restartable the way `pifleet relay` is"*. A five-minute cadence for days is not a session's job, and a `/compact` between ticks is a real interruption |
| **`scripts/triage` itself, in a foreground loop** | SRD-REVIEW-CONSOLE §6.5's third row, unchanged: *"The script exits after building the workspace. Making it not exit changes what `--recreate` and `--restart` mean and occupies a terminal the console does not have"* |

**Across restarts: the run tree is authoritative and the record is a cursor.** This is
`Docs/SRD-FLEET-PROJECT-MANAGER.md` D12's rule, and it applies here for the same reason — the record
is written by the least durable component. On start the actor derives in-flight state by reading the
run tree, not by trusting `~/.pifleet/triage.json`: a sweep whose parent task exists and whose
`-collate` task has not settled is in flight, and the actor resumes it rather than starting a new one.
**A restarted actor never double-dispatches a sweep**, and that is a criterion, not a hope (§12).

**When a sweep is still running as the next tick falls due: SKIP, never queue.** Record the skip with
its reason and the sweep it is waiting on. A queue of skipped ticks becomes a thundering herd the
moment the stall clears, which converts one slow sweep into three concurrent ones against the same
control plane — a triage console causing the outage it exists to notice. Consecutive skips are
counted, and at `max_consecutive_skips` (default 3, i.e. fifteen minutes of not sweeping) **the actor
notifies**: a triage console that has stopped triaging is exactly the condition this console exists
to catch, applied to itself.

**Supervision, taken from the relay rather than reinvented.** Three properties, each already built
and each already argued: the loop **catches a thrown pass and continues** (`relay.ts:700-723` — the
version without it meant *"any throw ENDED the actor"*, and nothing restarts one); `--once`
deliberately does **not** get the catch, because a single pass is somebody's command and its exit
code should mean something; and a `ConsoleWatch` (`console-relay.ts:274-312`) exits the actor after
`RELAY_ABANDON_PASSES = 5` consecutive observations that its console is gone, which is what makes
`pifleet down` authoritative over a process it has never heard of. **The triage actor watches
`tri-1`** for the same reason the relay watches its collator.

**Its record, log and lock must be per-console.** `console-relay.ts:79-86` and `:525-527` hard-code
`review-relay.{json,log,lock}` beside the runs root, host-wide. A triage actor writing those would
take over the review console's lock. So `relayRecordPath`/`relayLogPath`/`relayLockPath` gain a
console argument, and the record's `RelayRecordSchema` (`console-relay.ts:88-115`) gains the console
name — which also makes `servesConsole` (`:350-377`) answer the question it is named for. **Everything
else in that module is taken unchanged**, and two parts of it are worth not re-deriving: the
four-verdict status (`absent | stale | unreadable | unverifiable | live`, `:144-156`, where
*"`unverifiable` never licenses a signal"*), and `acquireRelayLock`'s write-then-`link` claim with
`rename`-decided takeover (`:393-522`), whose docblock records that the obvious `open(path,"wx")`
spelling left a zero-byte lock that *"refused forever and the console was permanently actorless."*

**Stopping.** `scripts/triage --actor-stop`, mirroring `--relay-stop` (`Workflows/Consoles.md:71`),
plus the console teardown. And ISC-572's lesson is inherited rather than repeated: the stop is a
`quiesce` dep passed to `recreateThenDispatch`, firing **after** the settle wait and **before** the
teardown, so `--restart <id> --task <file>`'s promise — *"refuses having torn nothing down"* — is
true on this console too. `scripts/operations` and `scripts/development` pass `null`; `review` passes
a function; `triage` passes a function. Getting this wrong on a fourth console is the same defect a
fourth time, and it is the reason §13 Phase 4 names the test before the script.

### 6.5 Fan-out — the partition is the worker's, the completeness check is the host's

**The rule.** One request per observer, never two — `duplicate_target` (`dispatch-request.ts:681`)
makes it a refusal rather than a convention. So a fan-out is at most three requests and the width is
fixed at three; **depth grows with N, width does not.**

| N services | Requests | Behaviour |
|---|---|---|
| N = 0 | — | a targets file with an empty environment is refused at load, not at dispatch |
| 1 ≤ N < 3 | N | fewer than three requests is legal (`.min(1)`, `:636`). **An idle observer is not an error** — the same posture SRD-FLEET-PM-001 D4 takes: idle seats over a wrong answer |
| N ≥ 3 | 3 | ⌈N/3⌉ services per observer, in one brief, and `observer-ops.json` returns **a row per service** — SRD-OBSERVER-001 §12 D12: *"a single verdict covering a batch is a schema violation"* |

**The partition is the triage worker's to make**, because it is a judgement — which services are
related, which are cheap, which changed since the last sweep — and it is the shape the request plane
already supports. **The completeness check is the host's**, because a model that partitions can drop
a service and nothing downstream would notice: two clean reports and a missing third reads exactly
like a clean sweep.

So the actor validates the request against the targets file before dispatching any of it, and
refuses the whole file on a violation (§6.4 of SRD-REVIEW-CONSOLE: *"The actor validates against the
schema and refuses the whole file on any violation"*). Two new refusal codes, joining the twelve at
`dispatch-request.ts:669-682`:

- `partition_incomplete` — a service in the environment appears in no request.
- `partition_duplicate` — a service appears in more than one.

This is `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5's discipline in a second place: **the number the loop
branches on is the one the host counted, never the one the worker claimed.**

**Deadline arithmetic, and it is a refusal rather than advice.** A sweep whose deadline exceeds its
cadence guarantees that skipping is the normal path. So `sweep_deadline_s` is derived —
`cadence_s − reserve_s`, default `300 − 60 = 240` — and a configuration where
`sweep_deadline_s ≥ cadence_s` is **refused at load**. Note the observer-side ceiling this sits far
under: `per_task_timeout: 25m` (`fleet.yaml:86`) and `deadline_s` default 1800. This console is not
bounded by the fleet's task timeout; it is bounded by its own cadence, and that is the tighter
number.

**And the actor's own settle deadline must move with it, in the right direction.** The relay's
`RELAY_SETTLE_DEADLINE_MS = 1_800_000` (`src/run/relay.ts:2044-2087`) is a backstop deliberately
ordered **above** the child's own `deadline_s: 1500`, so *"the child settles `timed_out` on its own
clock first and the join observes a real record. If either number moves, that ordering is the property
to re-check."* This console moves both. **The triage settle deadline is `sweep_deadline_s` plus a
margin — 270s against a 240s child at the 5-minute default — and the ordering is the invariant, not
the numbers.** A settle deadline left at 30 minutes would make a single stalled observer eat six
cadences.

**One property of the actor that a cadence makes expensive: `relayPass` is serial.**
`relay.ts:2428-2439` states the cost in the review console's own terms — a dispatch counted as landed
that never triggers is *"a thirty-minute stall and then a lost lens… `relayPass` is serial — three of
them stop the actor for an hour and a half."* At a five-minute cadence the equivalent stall is not an
inconvenience, it is the console stopping. So the settle bound above is load-bearing rather than
defensive, and §6.4's skip counter is what makes a serial actor's stall visible instead of silent.

**Join, partial, and stall.** The actor waits for all three children to reach a terminal state and
then proceeds regardless — SRD-REVIEW-CONSOLE §6.6's table, adopted whole, including its zero-row:
**with no child succeeding, no collation is dispatched.** And that case is itself notifiable, because
a sweep that observed nothing is not a clean sweep, and §6.7 must never read the absence of findings
as an all-clear. A service whose observer stalled is `indeterminate` for that sweep, never `healthy`
— §9.2's rule, and the whole reason `indeterminate` exists.

### 6.6 Freshness — four layers, because one problem is certain and the other cannot be proved

288 dispatches a day into four long-lived sessions. **Two distinct problems, and conflating them is
how a design ends up with one fix for the wrong one.** *Accumulation* is certain and needs no probe
(§2.3a): the session is per `(run, worker)` and nothing rotates it, so the transcript grows all day
and Pi compacts it. *Replay* is possible and is measured only on `tui` (§3.4). Layers 1-3 address
replay; layer 4 addresses accumulation and happens to bound replay as well.

The fleet's own answer to both, `--restart <id> --task`, is unavailable per sweep (§2.2, Finding B).
So:

**Layer 1 — the epoch fence. `pane_mode: rpc` on every seat.** §2.3. This stops the same task id
running twice, which is what `tui` cannot do, and it is the layer the config already argues for in
its own words.

**Layer 2 — a distinct task id per sweep.** `T-sweep-<n>` from a monotonic counter that lives in the
actor's record and is re-derived from the run tree on restart. No sweep ever reuses an id, so
`already_completed` never fires for a legitimate new sweep, and a resumed actor that re-derives the
same id is refused rather than duplicated.

**Layer 3 — detection, because layers 1 and 2 do not address the failure that was actually
measured.** §3.4: the replay measured on this fleet was a session carrying the *previous task's
answer* forward, and nothing about an epoch stops that. Nothing in this repository measures whether
an `rpc` worker does it too.

So the design does not assume it cannot:

> **Every sweep's brief carries the sweep id and the observation window's opening timestamp, and
> `observer-ops.json` must echo both. The actor refuses an artifact whose `sweep_id` is not the one
> it dispatched, and records it as `stale_replay`.**

That converts an unmeasurable risk into a red finding. It costs one required field in the artifact
and one comparison host-side, and it is the only thing in this design that would catch a replay at
03:00 with nobody watching. **A worker cannot forge it into correctness by accident**: the value is
minted host-side, per sweep, and echoing last sweep's id is exactly the failure being caught.

**Layer 4 — recycling, because accumulation is certain.** After `recycle_after_sweeps` (default 48,
i.e. four hours at the default cadence) the actor takes the console down and brings it back up: a new
run id, a new `<run>/sessions/` directory, four empty transcripts. It does this **between** sweeps,
never during one, and it re-derives its own pins afterwards because it minted the new run itself.

Three things make this implementable here and nowhere else in this fleet:

- **An `rpc` recreate needs no terminal.** `up --attach-here` is what demands a TTY on both streams
  (`src/attended/adopt.ts:96-114`), and an `rpc` worker is not attached. So an unattended actor can do
  what an unattended actor could never do for the `development` or `review` consoles. §2.3.
- **The actor already holds the whole run**, so a recycle is one `down` and one `up`, not a
  four-way pane dance.
- **The idempotency rules are the same ones §6.4 already needs**: recycle only with no sweep in
  flight, and re-derive from the run tree afterwards.

**This is not the same knob as a per-sweep restart, and the difference is the whole reason it is
affordable.** A restart per sweep is 288 container recreations a day; a recycle every 48 sweeps is 6.
`recycle_after_sweeps: 0` disables it, which is the setting to use while measuring Q5 — but leaving
it there indefinitely means accepting a transcript that grows until Pi compacts it, which is a
decision rather than a default.

**Still not built: a restart per sweep.** §5.3. If Q5 shows `rpc` workers replay *within* a recycle
window, the answer is a shorter window before it is a per-sweep restart, and layer 3 is what would
tell us the window is too long.

### 6.7 What counts as an issue — derived from the observer's own fields, never judged fresh

**The predicate is mechanical, and it is the observer's vocabulary rather than a new one.**
SRD-OBSERVER-001 §9.1's four fields do all the work:

| Observed | Is it an issue? | Why |
|---|---|---|
| `assessment: unhealthy` | **Yes**, after confirmation | the service is not doing its job |
| `assessment: degraded` | **Yes**, after confirmation | same axis, lower amplitude |
| `assessment: healthy` | No | and it must carry positive evidence — see the gate below |
| `assessment: indeterminate` (1-2 consecutive) | **No** — recorded as a coverage gap | *"I could not see enough to tell you"* is not *"it is broken"*, and treating it as one is how a console becomes noise |
| `assessment: indeterminate` (3+ consecutive, same service) | **Yes**, as a *coverage* issue | fifteen minutes of not being able to see a service is a finding about the console, and it must not be silent |
| observer `status: blocked` | **Yes**, as a *console-health* issue, not a service issue | SRD-OBSERVER-001 §9.3: a tunnel-down control plane is `blocked`, *"Nothing the worker did caused it"* |
| child stalled / no collation dispatched | **Yes**, as a console-health issue | §6.5's zero-row |

**Two rules make this trustworthy rather than merely tidy.**

**1. Confirmation, on the operator's own recorded discipline.** SRD-OBSERVER-001 §11.0 requires two
separated observations before a stall is called, and marks the language: *"Provisional, on the first
observation… Confirmed, only after a second independent check."* Its closing note is that this
*"composes with §7.5's one-pass-per-task design rather than fighting it: the second observation is
simply the next dispatched pass."* This console has a next dispatched pass every five minutes, so
confirmation costs one cadence and halves the false-positive rate. **A notification fires on
confirmation, never on the first observation.**

**2. The structural gate on `healthy`.** §3.5. Nothing can re-derive whether an observer looked, but
the shape of a real answer is checkable, and SRD-OBSERVER-001 §9.2a says exactly what a real "clean"
is made of: ready counts, per-pod restart counts, and an explicit freshness-at-sink confirmation. So
**a `healthy` whose row carries an empty `coverage[]`, no named selector, no window, or an empty
evidence ledger is downgraded host-side to `indeterminate`** and recorded as `unevidenced_healthy`.
That is grading on structure — SRD-REVIEW-CONSOLE D8 — and it *"is not acceptance and must not be
described as acceptance."* It cannot tell a lazy `healthy` from a real one. It can tell a `healthy`
with no evidence attached from one with evidence attached, and SRD-OBSERVER-001 §11.2 names that as
this operator's dominant production failure: *"you told me it was fine but didn't actually check."*

**Coverage is counted host-side.** The number of services observed comes from the run tree — the
journal's `children[]` against the reply files present — never from `triage.json`'s own claim. This
is ISC-517's hazard and SRD-FLEET-PM-001 §7.5's correction, and this console meets it 288 times a day
rather than occasionally.

### 6.8 The incident state machine — one notification per transition, and flapping is its own state

**Per `(environment, service)`, in `~/.pifleet/triage/<env>/<service>.json`.** Not in the run tree,
because it must outlive a run; not a history, because §5.2 refuses one.

```
                 confirmed issue
   clear ──────────────────────────▶ provisional ──────▶ firing
     ▲                                    │                 │
     │            observed healthy        │ cleared before  │ observed healthy
     └────────────────────────────────────┘  confirmation   │
     └──────────────────────────────────────────────────────┘
```

**Transitions are the only thing that notifies.**

| Transition | Notifies | Note |
|---|---|---|
| `clear → provisional` | **no** | §6.7 rule 1. One observation is not a finding |
| `provisional → firing` | **yes — the open notification** | confirmed on a second consecutive sweep |
| `provisional → clear` | no | the thing resolved before it was confirmed; recorded, not announced |
| `firing → firing` | no | `last_seen` and `sweep_count` advance and nothing is sent. **This is the rule that turns 288 into 1** |
| `firing → clear` | **yes — the recovery notification** | and see the recovery rule below |
| `firing → flapping` | **yes, once** | see below |
| `flapping → clear` | **yes**, after `flap_window` of stability | |

**Three refinements, each closing a hole a pure transition rule leaves open:**

**Flap damping, because a transition rule alone does not solve the problem it was written for.** A
service that alternates healthy/unhealthy every sweep *transitions* every sweep, so edge-triggering
emits 288 notifications a day for exactly the service most likely to do it. So: more than
`flap_threshold` (default 3) `firing → clear → firing` round trips inside `flap_window` (default 1h)
marks the record `flapping`, emits **one** notification saying so, and goes quiet until the service
has been stable for a full `flap_window`. **The flapping notification is the useful one** — a service
that cannot make up its mind is a different finding from a service that is down, and it is usually
the more interesting of the two.

**A re-notify floor, so a long outage is not forgotten.** While `firing`, one reminder every
`renotify_after` (default 6h; `0` disables). An issue that has been firing since yesterday and has
scrolled past should be able to say so once a shift. The default is deliberately long: this is the
knob that undoes the whole design if it is set small, and §8 says so in the operator-facing text.

**Recovery must be OBSERVED, and this is the rule most likely to be got wrong.** A `firing → clear`
transition requires a sweep in which that service returned `assessment: healthy` **with the evidence
§6.7's gate demands**. A service that goes from `unhealthy` to `indeterminate` — the observer could
not reach it — **does not recover**, and the record stays `firing` with its coverage gap recorded.
This is SRD-OBSERVER-001 §9.2's rule applied to a state machine, and it is the entire reason the
machine has an `indeterminate` path rather than treating "not currently unhealthy" as clear. **A
recovery notification for a service nobody could see is the single most damaging message this console
could send**, because it is an all-clear derived from an absence, and the operator would act on it.

**What a recovery notification says**: the service, the environment, how long it was firing, how many
sweeps, and the evidence that closed it — with the word *observed*, because the artifact it is
derived from carries a positive check rather than a silence.

### 6.9 The notification — host-side, typed, and one channel

**Decision: `POST http://localhost:8888/notify`, the operator's PAI voice server, with
`{title, message}` composed host-side from typed fields.** §11 Q2 flags the ambiguity explicitly and
this is a pick, not a reading.

**Why this arm.** The commission says *"via claude"*. Four readings were available: the orchestrating
Claude Code session (SRD-FLEET-PM-001 §0.2's actor); the PAI notify endpoint; `backend.notify()`; or
a chat/ticket channel. The first is unavailable by construction — this console's whole premise is that
it runs when no session is open. **The third is refused by its own header** (Finding G): *"Presentation
plane only. Nothing correctness-bearing may live behind this"*, and a triage notification is this
console's entire output. The fourth is out of scope (§5.2) and would need a credential and an egress
rule this design otherwise does not want. The second is the operator's own assistant surface, it is
the one channel in this environment whose entire job is *"tell me something happened"*, it is
host-side (which is where a notification must be performed regardless), and its payload is already the
shape this design needs: `{title, message, voice_enabled, voice_id}` (`server.ts:252-255`).

**Do not call it `notify` in `src/`.** The name is taken twice already — the presentation-plane
backend method, and a Pi UI-request method in `FIRE_AND_FORGET_METHODS`
(`supervisor/ui-requests.ts:127-138`) that the supervisor is contractually required not to answer. A
third meaning in the same tree is how a reader ends up at the wrong one. `src/run/triage-notify.ts`
exports `composeAnnouncement` and `deliverAnnouncement`.

**Three requirements, and the first is a security control rather than a style rule.**

**1. Typed fields only in the spoken message.** §4.3. `title` and `message` are rendered host-side
from `{environment, service, assessment, transition, first_seen, sweep_count}` through a pure
function. **No worker-authored string is ever interpolated into them.** Worker prose — the log lines
an observer quotes, which are the reason the report is worth reading — appears only in a fenced,
banner-marked evidence block that is not the spoken message and not the notification body. §12.6's
erratum is why this is built rather than inherited: fencing and banner-marking are recorded there as
**not met** on the existing surfaces.

**2. An undelivered notification is retained, never dropped.** §2.5: measured 2026-09-06, the endpoint
is not listening. A `429` from its rate limiter (`server.ts:240-246`), a connection refused, or a
non-2xx all mark the notification `undelivered` in the incident record with its reason and timestamp.
The next successful delivery names the backlog — *"3 notifications were not delivered between 04:10
and 09:35"* — and the count is visible in `pifleet triage --status`. **A notifier that silently
swallows is precisely the failure this console exists to catch, and it would be catching it about
itself.**

**3. The channel is configuration, and its absence is not a startup failure.** `notify.endpoint`
in the console's own config with a null default. A console with no notifier configured still sweeps,
still drives the incident machine, and still records every transition — it just cannot announce them,
and `--status` says so. Refusing to start would make a diagnostic console depend on a voice server.

### 6.10 Safety — read-only by mechanism, and what stops a sweep becoming an outage

**Read-only is inherited, not asked for.** SRD-OBSERVER-001 §10.1: the verb gate moves the real
binaries aside at image build and puts a shim on `PATH`, and every mutating cloud verb is refused
with exit 77. **This document asks for no exception**, and the triage worker has no `bash` at all
(§6.1), so it could not issue one.

**Credential scope.** The observers take `cloud_access: true` unchanged, which is ADC in token mode —
a ~1h access token, never the refresh token, re-minted every 45 minutes (SRD-OBSERVER-001 §7.5). Two
fences apply and one becomes a hard requirement here:

- **`cloud.kubeconfig` MUST be set, and the targets file must be a subset of it.**
  SRD-OBSERVER-001 §6.6 calls it *"the strongest fence this role has"* because *"it bounds
  reachability rather than intent"*. Made checkable: a `triage/targets.yaml` naming a
  `kube_context` the fleet's kubeconfig does not carry is **refused at load**, and the actor refuses
  to start. `workersMissingKubeconfig` (`schema.ts:1772`) already warns; for this console the warning
  becomes a refusal, because a console reading a live environment 288 times a day should not be able
  to reach an environment nobody wrote down.
- **`cloud.impersonate_service_account` is `null` today and this console is the strongest argument
  yet for setting it.** SRD-OBSERVER-001 §6.3 already makes the case; a continuous, unattended reader
  makes it again with a bigger number. §11 Q8.

**What stops a triage sweep becoming an outage of its own.** Four mechanisms, because this is the
question the design most has to answer honestly:

1. **Read amplification is bounded by the window, and the window defaults to the cadence.** A six-hour
   log window re-read every five minutes is 72× the necessary read volume against a live logging API,
   and it is the obvious default a person would write. `default_window: 5m` in the targets file, and
   `observer-ops` §6's existing rule — *"a bound on every log query"*, *"`--max-time` on every
   `curl`"*, *"an explicit request timeout on every `kubectl`"* — carried into every rendered brief.
2. **Concurrency is bounded by `run.max_concurrent`** (`budget.ts:293-297`), which for one run of four
   workers is a real bound rather than a nominal one. §2.2.
3. **A sweep never overlaps itself.** §6.4's skip rule, and its explicit rationale: a queue of ticks
   becomes concurrent sweeps against the same control plane the moment a stall clears.
4. **The blast radius of a confused triage worker is a bad brief and a wrong notification** — no
   mutating verb, no `/workspace`, no shell — which is why §6.9 spends its rigour on where the
   notification's words come from rather than on what the worker can do.

**The exposure this design does NOT bound, stated rather than discovered.** A hosted provider is
metered and `usd_ceiling` does not exist — §5.9's amendment says so: *"a hosted provider is metered
and this fleet has no spend gate for it."* This console is the first workload in this fleet that runs
**unattended and continuously**. The only gate that binds is `run.budget.tokens_ceiling: 6000000`
(`fleet.yaml:79`), which is **per run** (Finding C), and a triage console is one run — so the console
has a hard lifetime measured in tokens, after which `up`'s budget refuses admission and the run ends
on exit 5. **Nothing announces that today**, so this design makes it a notification: budget
exhaustion is a console-health issue on §6.7's table, and the actor emits it on the way down. §11 Q4
asks whether 6,000,000 is the right number for a console whose job is to keep running, and notes that
raising it is the one change here with an unbounded bill attached.

### 6.11 The models and the config edits

**The provider exists; the model does not resolve.** `llm.providers.ollama-cloud` is declared with
`hosted: true`, `base_url: https://ollama.com/v1`, `relay_upstream: 34.36.133.15:443`,
`api_key_env: OLLAMA_API_KEY`, `tag_style: true` and `probe_timeout_ms: 90000`
(`fleet.yaml:149-282`). Two edits make `gpt-oss:120b` usable, and both are required:

```yaml
# fleet.yaml, llm.providers.ollama-cloud
models_allowlist:
  - deepseek-v4-pro:0813
  - qwen3.5:397b
  - glm-5.3
  - gpt-oss:120b            # ADD — without this, up refuses (load.ts:835-880)
context_windows:
  deepseek-v4-pro:0813: 1048576
  qwen3.5:397b: 262144
  glm-5.3: 1048576
  gpt-oss:120b: <measured>  # ADD — without this, Pi registers it at its own 128,000 default
```

The second is not optional hygiene. `fleet.yaml:252-257` records `rev-arch-1` auto-compacting at
152,447 tokens for exactly this omission, and `fleet.example.yaml:149-153` states the general case:
two 1,048,576-token models *"ran at 12% of capacity, auto-compacted, and in one case could not resume
at all."* The value is the provider's; read it from `POST /api/show` (`fleet.yaml:264`), do not guess
— `fleet.example.yaml:169-172`: *"Say nothing rather than guess."*

**What needs no change at all**, and this is the good news of §7:

- **Egress.** `{host: 34.36.133.15, port: 443}` is already allowed (`fleet.yaml:291`) because it is
  the relay's dial target. Model traffic rides the relay, not the CONNECT proxy, so **a triage worker
  on `ollama-cloud` needs no egress rule and no `egress_access`** for inference. The observers keep
  `egress_access: true` for their own CI/dashboard destinations, which is the `observer` role's
  existing grant.
- **Secrets.** `OLLAMA_API_KEY` is the provider key, delivered as a 0444 file with a `_FILE` pointer.
  Provider keys must **never** appear in `secrets.env_allowlist` (`schema.ts:1332`:
  *"NEVER provider keys"*), so there is no `secrets:` edit.
- **Auth.** Nothing.

**How the model choice is tested without a live endpoint.** `up` probes every allowlisted model
(`require_native_tool_calls: true`, `fleet.yaml:105`) and **refuses the whole fleet** on a timeout —
a live gate that CI cannot run. What CI *can* re-check, in-process:

- a fixture config declaring `gpt-oss:120b` resolves through `resolveWorker` to provider
  `ollama-cloud` and model `gpt-oss:120b`, with the `:120b` **not** stripped as a thinking suffix
  (`load.ts:258-267`, `tag_style: true`);
- removing it from `models_allowlist` makes the same fixture throw `ModelNotAllowedError`
  (`load.ts:799-812`) — the mutation that proves the assertion is about the allowlist and not about
  the string;
- the `context_windows` entry is present for every allowlisted model this console names, so the
  128,000-default trap cannot be reintroduced by adding a model and forgetting a window.

The probe itself is a hand-run and its criterion is `[~]` until it is taken. `fleet.yaml:280` records
`gpt-oss:120b` as *"in the fast group"* against the 90s budget, but that is a measurement of a model
that is **not currently allowlisted**, taken on 2026-09-03/04. **Re-measure before allowlisting**: a
model near the ceiling makes `up` refuse the entire fleet with a `timeout` verdict on a model that is
answering correctly, which `schema.ts:829-831` names as the exact reason `models_allowlist` is the
control to reach for.

---

## 7. Contracts

### 7.1 `triage/targets.yaml` — new, tracked

`pifleet.triagetargets/v1`. Zod-validated in `src/run/triage-targets.ts`, refused on any violation,
and validated by `pifleet config validate` alongside `fleet.yaml`.

| Field | Rule |
|---|---|
| `version` | literal `1` |
| `environments` | record, ≥1 key; each key is the logical environment token and must match `SESSION_ID_RE` (it becomes part of a path under `~/.pifleet/triage/`) |
| `environments.<env>.kube_context` | required; **must be present in the fleet's `cloud.kubeconfig`** or the file is refused (§6.10) |
| `environments.<env>.default_window` | duration, default `5m`; refused if greater than the cadence (§6.10 rule 1) |
| `environments.<env>.services` | array, ≥1, ≤64; `name` unique within the environment |
| `services[].name` | the logical service name — `mia`, `authorization`, `authentication` |
| `services[].namespace`, `services[].workload` | declared, never derived (§6.2 rule 2). `workload` optional when the service is resolved by selector |
| `services[].checks` | array from a closed enum `[rollout, logs, sink, endpoint]`; **no free strings**, so a targets file cannot carry a command |
| `services[].window` | optional per-service override of `default_window` |

`.strict()` at every level, on `fleet.yaml`'s own rule (`schema.ts:4-7`): an unknown key is a
field-level error, never an ignored typo.

### 7.2 The sweep envelope — host-rendered, and the verdict rule travels in it

Standard fields plus, **all rendered into the `brief` prose** because SRD-OBSERVER-001 §7.1 records
that `inputs[]` reaches no prompt:

| Carried | Why |
|---|---|
| `sweep_id` | §6.6 layer 3. Minted host-side; must be echoed |
| `window_opened_at` | the lower bound of this sweep's observation window |
| the environment token and its service list, in full | the triage worker partitions it (§6.5) |
| **the verdict rule, verbatim** | Finding F. `observer-ops` does not carry it yet, and *"apply the one your briefing states and do not invent a finer one"* |
| the per-service `checks[]` and window | so a brief cannot widen a check the targets file bounded |
| the previous sweep's per-service state, as **structured state only** | SRD-OBSERVER-001 §7.4: *"What crosses between passes is structured state… never a previous worker's recommendations rendered as a brief"* |

**What the envelope must never carry**, adopted verbatim from SRD-OBSERVER-001 §7.4: a credential or
any part of one; an absolute host path; a raw command to execute; **the contents of a previous
worker's report as instruction.** The last is the one a cadence invites violating, because the
obvious way to give a sweep continuity is to paste the last sweep's prose into it. §12.6.

### 7.3 The fan-out request — existing, unchanged

`pifleet.dispatchrequest/v1` (`roles/collator.md:81-91`, `src/run/dispatch-request.ts`).
`worker`, `title`, `brief`, **and nothing else** — a request naming a model, a tool list, a deadline
or an acceptance command is refused whole, with the field named. `parent_task_id` must be the writer's
own task id and must match the directory it was written into.

Consumed as-is. What changes is the roster it is validated against (§2.1) and two new refusal codes
(§6.5).

### 7.4 `observer-ops.json` — existing, plus two required fields

The artifact pair is `skills/observer-ops/SKILL.md:26-33`'s and the rule that a run writing only the
`.md` clamps to `failed` is inherited. This console requires two additions:

- **`sweep_id`** — echoed from the envelope. §6.6 layer 3. An artifact whose value is not the
  dispatched one is `stale_replay` and the row is not counted.
- **a row per service**, each carrying `assessment`, `coverage[]`, the selector, the window, and the
  evidence ledger. SRD-OBSERVER-001 §12 D12 already forbids one verdict over a batch; §6.7's
  structural gate is what reads these.

### 7.5 `triage.json` — new

Written by `tri-1` on turn two, at `/outbox/<collate-task-id>/files/triage.json`, beside a
`triage.md` for the person who was not watching — the same split, for the same measured reason
(`roles/collator.md:116-123`): a document carried as one long string inside an envelope makes that
envelope's structure depend on every character of the prose, and *"the failure landed on the OBJECT
rather than on the review, so the report did not arrive short — it ceased to exist."*

Carries: the sweep id; per service a row with `assessment`, `coverage`, `evidence_ref` and the
observer that produced it; the services it could **not** account for, named; and nothing that
resembles a decision to notify. **The notify decision is the actor's**, because §6.8's state lives
across sweeps and a worker sees one.

**The host's counterpart already exists and should be reused rather than re-shaped.**
`CollationCensusSchema` (`src/contracts.ts:1077-1152`) is the only structure in this repository that
expresses *"how many independent readers reported, and how many agreed"*: `lenses_total`,
`lenses_reported`, `lenses_missing[]`, `declared` versus `counted`, and an `agreement[]` histogram.
Its denominator argument (`:1113-1120`) is exactly §6.5's problem stated for reviews — *"A count of
readers who agreed is not `3/3` without it."* A triage sweep's host-side coverage record is the same
census with services in place of lenses, and the `declared`-versus-`counted` split is precisely the
worker-claim-versus-host-count distinction §6.7 turns on.

### 7.6 The incident record — new

`~/.pifleet/triage/<env>/<service>.json`. `state`, `since`, `last_seen`, `sweep_count`,
`consecutive_indeterminate`, `flap_transitions[]` (timestamps inside `flap_window`),
`last_notified_at`, `undelivered[]`, and `last_artifact_ref`. Zod-validated on read, so a malformed
record refuses rather than being acted on — SRD-FLEET-PM-001 Phase 5 task 5.4's rule.

### 7.7 The actor record — new, and deliberately the relay's shape

`~/.pifleet/triage.json` (`pid`, `started`, `run_id`, `workers`, `cadence_s`, `sweep_cursor`,
`consecutive_skips`), `~/.pifleet/triage.log` appended never truncated, `~/.pifleet/triage.lock`.
`Workflows/Consoles.md:64-66`'s convention, copied rather than invented — including the behaviour it
names for a record it cannot verify: *"left exactly where it is and nothing is signalled."*

---

## 8. The `/fleet` skill changes

`~/.claude/skills/fleet/` is a symlink into `~/repos/cmux-fleet/.claude/skills/fleet/`
(`SKILL.md:12-21`), so these are tracked edits in this repository.

- **`SKILL.md`'s fleet table gains four rows** — `tri-1` (triage, triage console, `base`) and
  `obs-t1`/`obs-t2`/`obs-t3` (observer, triage console, `base`) — and its frontmatter `description`
  gains the four worker ids and the word "triage", since routing is keyed on names.
- **`Workflows/Consoles.md` becomes four consoles.** Its table gains a row, and the *"The review
  console has a fifth process"* section gains a sibling: the triage console has one too, it is both
  the clock and the actor, and `~/.pifleet/triage.json` names the run it serves.
- **One sentence that must be there**, because an operator reading the commission's words will look
  for the wrong thing: *the triage worker does not dispatch; it writes a request and the actor
  performs it* (§4.2).
- **One sentence about the notify floor**, because `renotify_after` is the knob that undoes the
  design if it is set small (§6.8).
- **A new `Workflows/Triage.md`** covering: opening the console, `--dry-run`, the cadence flag,
  `--actor-stop`, `pifleet triage --once` for a hand-run sweep, `--status` for the incident table and
  the undelivered count, and how to read a `stale_replay`.

**How this coexists with the cardinal rule.** `SKILL.md:25-58` forbids the calling session doing a
worker's work before dispatching. A scheduled console never has a calling session, so the rule is not
engaged — but the *reason* behind it is: the sweep brief is rendered from the targets file by a pure
function, never composed by a model or a session that "improved" it. The rendered brief is a
deterministic function of `targets.yaml` and the sweep id, and §12 makes that a criterion.

---

## 9. Failure modes, recovery, and what this costs

| # | Failure | What happens | Recovery |
|---|---|---|---|
| 9.1 | An observer stalls or times out | the actor joins on terminal states and proceeds; the collation brief **names the missing services**; those services are `indeterminate` for this sweep, never `healthy` | the next tick. Three consecutive → a coverage issue (§6.7) |
| 9.2 | No child succeeds | **no collation is dispatched** (SRD-REVIEW-CONSOLE §6.6) and the sweep is recorded as producing nothing | notifiable as a console-health issue. **The one thing that must not happen is reading it as clean** |
| 9.3 | The triage worker's partition is wrong | `partition_incomplete` / `partition_duplicate`; the whole request is refused and nothing is dispatched | the sweep fails visibly. §6.5 |
| 9.4 | An artifact echoes the wrong `sweep_id` | `stale_replay`; the row is not counted and the service is `indeterminate` for this sweep | §6.6. **This is the failure with no other detector** |
| 9.5 | A sweep overruns its cadence | the next tick is **skipped**, never queued; the skip is recorded with the sweep it waits on | 3 consecutive skips → notify. §6.4 |
| 9.6 | The actor dies mid-sweep | the run tree is authoritative; on restart the actor resumes an in-flight sweep rather than starting one | `./scripts/triage` again — idempotent, as `scripts/review` is |
| 9.7 | The actor's record names a pid it cannot verify | left exactly where it is, nothing signalled, nothing started; the script says so | `Workflows/Consoles.md:83-85`, inherited |
| 9.8 | The notify endpoint is down (**true today** — §2.5) | notifications marked `undelivered` with reason and timestamp; retained | the next successful delivery names the backlog; `--status` shows the count |
| 9.9 | The run's token ceiling is reached | admission is refused, exit 5, the console stops sweeping | notified on the way down (§6.10). **Silent today, and that is the defect this row exists to close** |
| 9.10 | A pane is restarted by hand | the actor's pin is invalidated | the actor is stopped before and started after, as `scripts/review` does — and it is a `quiesce` dep so the settle-wait refusal stays honest (ISC-572). Note the pin **decays** rather than sticking (`relay.ts:2915-2954`), so a seat that returns in a new run is found rather than waited for forever |
| 9.11 | A recycle is due while a sweep is in flight | the recycle waits; nothing is torn down | the next boundary. §6.6 layer 4 |
| 9.12 | The sweep counter resets across a recycle | every task id collides with one the epoch fence saw in a previous run | prevented, not recovered: §12's anti-criterion. The symptom would be intermittent and would read as a dispatch bug |
| 9.13 | A copy-paste actor claims `review-relay.lock` | the review console silently stops fanning out | prevented by Phase 2.3's per-console paths, and asserted in §12 |
| 9.14 | A pass throws | logged to stderr; the loop continues | `relay.ts:700-723`. **`--once` propagates instead**, because a single pass is somebody's command |

**What this cannot see, and must not imply it can.** Anything outside the four channels an observer
polls; anything between two sweeps; anything a five-minute window does not reach; and — the important
one — **whether a `healthy` was actually checked**. §3.5 and §6.7's structural gate bound this and do
not close it.

---

## 10. Recorded decisions

| # | Decision | Specified in |
|---|---|---|
| **D1** | **OPEN, BLOCKING** — which seats run a hosted model, against `fleet.yaml:471-475` and `Docs/SRD.md` §5.9 | §0.2, §11 Q1 |
| **D2** | The clock and the fan-out live in **one** host-side process, `pifleet triage`, whose pass is exported and whose loop is a wrapper. Rejected: a worker loop; launchd; a session; the script | §6.4 |
| **D3** | All four seats are `pane_mode: rpc` in **one run**. Rejected: `tui` seats and four runs | §6.1, §2.2, §2.3 |
| **D4** | The service registry is a **tracked** `triage/targets.yaml`. Rejected: `fleet.yaml` (strict, gitignored, wrong clock); argv; the envelope | §6.2 |
| **D5** | The request plane is consumed with a new roster value. Rejected: renaming `ConsoleRoster`'s fields; a second request mechanism | §2.1 |
| **D6** | The worker partitions; **the host checks completeness**. Two new refusal codes | §6.5 |
| **D7** | Freshness is epoch fence + unique id + **a host-minted sweep id the artifact must echo** + **a periodic recycle of the whole run**. Rejected (deferred): a restart per sweep | §6.6, §5.3 |
| **D7a** | The console's own modules are held read-only by a transitive-import-closure guard, with its one dispatch exception **named** rather than counted | §6.10, §12 |
| **D8** | An issue is derived from the observer's `assessment`/`coverage`/`status`, **confirmed on a second consecutive sweep** before it notifies | §6.7 |
| **D9** | Notification is edge-triggered on an incident state machine, **with flapping as its own state**, a long re-notify floor, and recovery that must be **observed** | §6.8 |
| **D10** | **OPEN** — the notification channel is `localhost:8888/notify`, composed host-side from typed fields only | §6.9, §11 Q2 |
| **D11** | `cloud.kubeconfig` becomes a **requirement** for this console, and the targets file must be a subset of it | §6.10 |
| **D12** | The run tree is authoritative; `~/.pifleet/triage.json` is a cursor | §6.4 |

### The seven that need no argument

**D2 — one process.** Two processes that must agree about a run id is a failure mode with no
observable. **The cost: the console dies with the actor**, and the actor is supervised by a shell
script — which SRD-REVIEW-CONSOLE §6.5 already names as this fleet's weakest supervision story
(*"Nothing in this fleet is currently supervised by a shell script"*). Inherited knowingly; Q7 is
whether it is good enough for a console that is meant to run for days.

**D3 — `rpc`, one run.** **The cost is `run.max_concurrent`**, which binds a multi-worker run and
does not bind the other consoles at all. Q3 is the number.

**D4 — a tracked file.** **The cost is a second config file** with its own schema, its own validation
step and its own way to be stale relative to `fleet.yaml`. Bounded by validating it in the same
`config validate` pass, so a mismatch is one command away rather than one incident away.

**D5 — consume the roster.** **The cost is two field names that read wrong** for the rest of this
console's life. Accepted over a rename that would touch a shipped console for no behaviour.

**D6 — the host counts.** SRD-FLEET-PM-001 §7.5's discipline. **The cost is that a legitimate
partial partition is impossible** — a triage worker cannot deliberately skip a service it judges
uninteresting. That is intended: the targets file decides what is swept, not a model's judgement on
the day.

**D8 — confirm before notifying.** **The cost is one cadence of latency**, five minutes by default,
between a service breaking and a notification. Accepted on the operator's own recorded discipline
(SRD-OBSERVER-001 §11.0) and on the arithmetic: a console that pages on single observations is a
console whose notifications get muted, at which point it has zero value rather than five minutes less.

**D12 — the run tree wins.** **The cost is a slower start** — the actor reads the run tree before it
ticks. That cost is the point: the record is written by the least durable component.

### D1 — the hosted model assignment

**OPEN and BLOCKING.** §0.2 has the three arms and the argument. Nothing can be dispatched to this
console until it is answered, because the answer is a line in every role and worker entry §13 Phase 1
writes. **This document's own reading, offered as a reading rather than a recommendation:** arm 2 is
the one that treats §5.9's axis as being about *what reaches the vendor* rather than about a role
name, and it is honest about not eliminating the exposure — an observer's `.md` carries real log
lines and the triage worker reads them.

### D10 — the notification channel

**OPEN.** §6.9 has the pick and the reasoning. What is **not** open, under any arm: the message is
composed host-side from typed fields, worker prose never reaches the spoken text, and an undelivered
notification is retained. Those are §4.3 and §2.5, and they hold whichever channel is chosen.

---

## 11. Open questions

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | **BLOCKING.** Which seats run `ollama-cloud/gpt-oss:120b`? §0.2's three arms. `fleet.yaml:471-475` and `Docs/SRD.md` §5.9 both record the opposite of what the commission asks, for the exact role it asks about | **Not a probe — an owner decision**, and it needs one because the recorded decision is explicit and dated. What a probe *would* add: measure `gpt-oss:120b` against `probe_timeout_ms: 90000` before allowlisting it, because a model near the ceiling makes `up` refuse the whole fleet | **Everything.** Phase 1 writes a `model:` line and cannot write it |
| **Q2** | **BLOCKING for §6.9 only.** Is *"a notification via claude"* the PAI notify endpoint, a Claude Code session, a chat channel, or a ticket? §6.9 picks the first and this row is the ambiguity flagged rather than buried | **Not a probe — an owner decision.** One supporting fact: measured 2026-09-06, `localhost:8888` is not listening and `com.paivoice.server` is not loaded, so whichever arm is taken, §6.9's undelivered path is required rather than defensive | §13 Phase 5. **Nothing else** — the incident machine is channel-agnostic by construction |
| **Q3** | What should `run.max_concurrent` be? It is `1` (`fleet.yaml:77`) and this is the first console that puts several workers in one run, so it is the first place the value binds. Three observers serialised will not fit a five-minute cadence | Time one observer pass against a real environment, ×3, and compare with the cadence. **And check the cheap half first:** raising it binds only runs holding more than one worker, so confirm by inspection that no other console has such a run before treating the change as fleet-wide | **Nothing structurally.** It decides whether the default cadence is 5 minutes or something longer |
| **Q4** | Is `tokens_ceiling: 6000000` right for a run that is meant to live for days? Finding C: it is per run, it is the only spend gate that exists, and it ends the console on exit 5 when reached | Run the console for a day and measure the spend per sweep, then divide. **Cheap and it must be done before the console is left running unattended**, because the current answer is "unknown, and the failure is silent" | **Nothing structurally.** It decides the console's lifetime and whether §6.10's exhaustion notification is a rare event or a daily one |
| **Q5** | Does an `rpc` worker *replay* a previous task's answer the way the measured `tui` worker did, and after how many sweeps? §3.4 — both measurements are on `tui` seats, and both attribute the behaviour partly to the vague staged trigger, which an `rpc` dispatch does not have. **The `accumulation` half needs no probe** (§2.3a) and is why layer 4 is built regardless | Dispatch two clearly different tasks to one `rpc` worker without a restart and read the second answer; then repeat at 10, 50 and 100 dispatches to find where a session stops being usable. **Cheap, and what it decides is the DEFAULT of `recycle_after_sweeps`, not whether recycling exists** | **Nothing.** It sets one number |
| **Q6** | Should the triage console's panes be live event views for `rpc` workers? SRD-REVIEW-CONSOLE §3.2 records the capability as *"knowable and currently unused"* — **no console does it today**, so this console would be the first | Build the pane plan with `pifleet monitor` and a log tail first (both are just commands in a pane), and try the event view as a second step. **The console works either way**; this decides whether it is nice to watch | **Nothing.** §13 Phase 4 can ship the simple plan |
| **Q7** | Must this console survive the GUI? If the answer is yes, §6.4's launchd arm becomes the right one and the actor gains a supervision story the fleet does not currently have for anything | **Not a probe — a requirement question.** It is asked because "a health check every 5 minutes" and "only while a cmux window is open" are different products and the commission does not distinguish them | **Nothing in the design's shape** — the actor's pass is the same either way. It decides who starts it |
| **Q8** | Should `cloud.impersonate_service_account` be provisioned before this console runs? SRD-OBSERVER-001 §6.3 already argues it; a continuous unattended reader argues it harder | **Not this document's to probe** — it is a cloud-provisioning decision. Recorded because this console is the first workload that makes the operator's full identity available to an agent continuously rather than occasionally | **Nothing.** D11's kubeconfig fence is the control that ships either way |
| **Q9** | Does `event_stall_kill: 25m` (`fleet.yaml:91`) count an idle-between-sweeps worker as stalled? `stall.ts:31` excuses a worker waiting behind `max_concurrent` as *"the queue"*; whether an idle `rpc` worker between tasks is excused the same way is not established here | Read `stall.ts` and `state.ts` against an `rpc` worker's idle state, or leave a console up for 30 minutes with the cadence disabled and see what happens | **Nothing at a 5-minute cadence** — the gap never reaches 25 minutes. It binds if the cadence is ever set above ~20 minutes, or after 5 consecutive skips |
| **Q10** | If `run_timeout` ever gains a reader, this console dies at two hours. Finding C. Should the ceiling be raised now, or should the console be exempted, or should the field be retired? | **Not a probe.** Recorded so that whoever implements `run_timeout` finds this row rather than finding a triage console that stops every two hours for no visible reason | **Nothing today.** It is a tripwire pointed at a future change |

---

## 12. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria, each
phrased so the probe is obvious, because a criterion whose verification is unclear is graded `[~]`
forever. **`ISC-573` is the highest id in `ISA.md` as of 2026-09-06, so this block starts at
`ISC-574`.** No ids are allocated here; `ISA.md` owns that numbering.

**Two existing criteria are made stale or newly load-bearing by this design, independently of whether
it is built.** **ISC-517** (`[~]`, a lens that wrote a valid report is never lost) gains a second
consumer that meets its hazard 288 times a day rather than occasionally, and §6.7's host-side coverage
count is a **consumer of the criterion's openness, not a closure of it**. **ISC-572** (the `quiesce`
ordering) gains a fourth console that must pass it, and its own closing note — *"`scripts/` is outside
`tsconfig.json`'s `include`, so a console that forgot `quiesce` is caught by neither
`bun run typecheck` nor the suite"* — is why §13 Phase 4 writes the test before the script.

**The clock (D2)**
- One pass is exported and a test drives it with no timer. *Probe: `triagePass` is called directly
  with injected deps and returns an outcome; no test starts the loop. **This is the coverage gate's
  requirement stated as a criterion** — §3.3.*
- A tick that falls due while a sweep is in flight is skipped, not queued. *Probe: a fixture run tree
  with an unsettled `-collate` task; assert the pass dispatches nothing and records a skip naming the
  in-flight sweep.*
- **Anti: a restarted actor never double-dispatches a sweep.** *Probe: a fixture run tree holding a
  dispatched sweep and an empty record; assert the pass resumes rather than minting a new sweep id.
  D12 asserted, and the failure it prevents is two concurrent sweeps against one control plane.*
- Consecutive skips are counted and reach a notification. *Probe: three fixture passes each finding a
  sweep in flight; assert the third emits.*

**The partition (D6)**
- A request missing a service in the environment is refused whole. *Probe: a fixture request naming
  two of three services; assert `partition_incomplete` and that **nothing was dispatched**.*
- A request naming one observer twice is refused. *Probe: the existing `duplicate_target` code, driven
  through the triage roster — this asserts the roster is wired, not that zod works.*
- **Anti: coverage is counted from the run tree, never from `triage.json`.** *Probe: a fixture where
  `triage.json` claims three services observed while the journal holds three `children[]` and two
  reply files; assert the missing service is `indeterminate`. **A gate reading the worker's claim
  passes this fixture and is exactly the defect being pinned.***

**Freshness (D7)**
- An artifact echoing the wrong `sweep_id` is `stale_replay` and its rows are not counted. *Probe: a
  fixture artifact carrying the previous sweep's id; assert the service is `indeterminate` and the
  outcome names `stale_replay`.*
- **Anti: no seat in this console resolves to `pane_mode: tui`.** *Probe: resolve all four workers
  through `resolveWorker` and assert `rpc`; a `tui` seat fails. This pins §2.3's argument against a
  future edit that copies a theme line from another console, **and it is the criterion that keeps
  layer 4 implementable** — a `tui` seat cannot be recycled without a terminal.*
- A recycle happens only between sweeps. *Probe: a fixture pass at the recycle boundary **with a
  sweep in flight**; assert nothing is torn down. The mirror fixture with no sweep in flight asserts
  the recycle runs.*
- **Anti: the sweep counter survives a recycle.** *Probe: recycle a fixture console and assert the
  next sweep id is `n+1`, not `1`. A counter that resets makes every task id a replay of an id the
  epoch fence has already seen in a previous run, and the symptom would be intermittent.*

**The issue predicate (D8)**
- A first `unhealthy` observation notifies nothing. *Probe: one fixture sweep; assert the record is
  `provisional` and no notification was composed.*
- A second consecutive `unhealthy` notifies exactly once. *Probe: two fixture sweeps; assert one
  notification.*
- A `healthy` row with an empty `coverage[]` is downgraded to `indeterminate`. *Probe: a fixture row
  claiming healthy with no evidence; assert `unevidenced_healthy` and that it does **not** clear a
  firing incident.*
- Three consecutive `indeterminate` on one service is an issue. *Probe: three fixture sweeps; assert
  the third notifies as a coverage issue and not as a service issue.*

**Deduplication and recovery (D9) — the highest-value criteria in this document**
- **Anti: a service firing for 288 consecutive sweeps produces one notification.** *Probe: drive 288
  fixture sweeps through the machine and assert `notifications.length === 1`. **The literal number,
  because the commission's implicit failure is 288 and a criterion asserting "few" would pass a
  design that sends twelve.***
- **Anti: a service alternating every sweep does not notify every sweep.** *Probe: 20 alternating
  fixture sweeps; assert the machine reaches `flapping`, emits once, and then goes quiet. **This is
  the case a pure edge-trigger fails, and it is why `flapping` is a state rather than a comment.***
- **Anti: `unhealthy → indeterminate` is NOT a recovery.** *Probe: a firing record followed by a sweep
  in which that service is `indeterminate`; assert the record stays `firing` and no recovery
  notification is composed. **This is the most damaging message this console could send and the
  criterion that stops it.***
- A recovery requires an observed `healthy` with evidence. *Probe: the same fixture with a healthy row
  carrying `coverage[]` and a ledger; assert exactly one recovery notification naming the duration and
  the sweep count.*
- The re-notify floor fires at most once per `renotify_after`. *Probe: fixture sweeps spanning 24h at
  the 6h default; assert 4 reminders, not 288.*

**The notification (D10)**
- **Anti: no worker-authored string reaches the notification's `title` or `message`.** *Probe: a
  fixture `triage.json` whose prose fields contain a marker string and an injection-shaped sentence;
  assert the composed `message` contains neither, and that the marker appears only inside the fenced
  evidence block. **§4.3 — this is the criterion that is worth the most and would be the easiest to
  omit.***
- An undelivered notification is retained and the backlog is named. *Probe: a fixture transport that
  returns 429, then 200; assert the second delivery names the first.*
- **Anti: a console with no notifier configured still sweeps and still records transitions.** *Probe:
  `notify.endpoint: null`; assert the incident record advances and `--status` reports the channel as
  unconfigured.*

**Configuration (D4, D11, §6.11)**
- A targets file naming a `kube_context` absent from `cloud.kubeconfig` is refused. *Probe: a fixture
  pair; assert the load throws and the actor refuses to start.*
- A `default_window` greater than the cadence is refused. *Probe: `default_window: 6h` with
  `cadence: 5m`; assert refusal. §6.10 rule 1 as a gate rather than a note.*
- `sweep_deadline_s >= cadence_s` is refused. *Probe: as above. §6.5.*
- A worker resolves to `ollama-cloud/gpt-oss:120b` with the tag intact. *Probe: `resolveWorker` on a
  fixture config; assert provider and model, and assert the `:120b` is **not** stripped as thinking.*
- **Anti: removing `gpt-oss:120b` from `models_allowlist` throws.** *Probe: the mutation. **This is
  what proves the assertion is about the allowlist rather than about a string.***
- Every allowlisted model this console names has a `context_windows` entry. *Probe: assert over the
  tracked example config. This pins the 128,000-default trap `fleet.yaml:252-257` measured.*

**The console and the actor (D3, D12, §13 Phase 4, §13 Phase 6)**
- `./scripts/triage --dry-run` prints four panes and touches nothing.
- **Anti: `scripts/triage --restart <id> --task <f>` stops the actor AFTER the settle wait.** *Probe:
  ISC-572's own probe, re-taken on this console: with a worker holding a task, assert the refusal AND
  that the triage actor record still names a live pid. **The same defect a fourth time is the one
  most likely to ship.***
- **Anti: no decision lives in `scripts/triage`.** *Probe: the script imports its plan and its deps;
  assert the roster, the pane plan and the cadence default are all `src/` exports. §3.3 — `scripts/`
  is untypechecked and uncovered.*
- **Anti: the triage actor's record, log and lock are not the review console's.** *Probe: assert the
  three paths differ from `relayRecordPath`/`relayLogPath`/`relayLockPath`'s review values, and that
  `servesConsole` refuses a record naming the other console. **`console-relay.ts:79-86` and `:525-527`
  hard-code `review-`, so a copy-paste actor takes over the review console's lock and the symptom is
  a review console that silently stops fanning out.***
- **Anti: the actor exits when its console is gone.** *Probe: a fixture where `tri-1` reports not-live
  for `RELAY_ABANDON_PASSES` passes; assert the loop returns and ledgers the reason. And the mirror:
  four negatives followed by one positive resets the streak — `console-relay.ts:290-301`, because
  transient read failures must not reap a healthy actor.*
- **Anti: a thrown pass does not end the actor, and `--once` still exits nonzero.** *Probe: inject a
  throwing pass; assert the loop continues and that `--once` propagates. `relay.ts:700-723` is the
  measured version of the first half.*
- `src/cli/commands/triage.ts` is imported in-process by a test. *Probe: a test importing its
  `register` and driving `buildProgram`. **This is the coverage gate's own recorded pattern** —
  `test/unit/pm-guard-command.test.ts` exists because the wiring layer fell out of the report once
  already.*
- The command's place in `test/unit/cli.test.ts` is settled in one direction or the other. *Probe:
  either `SRD_COMMANDS` contains `triage` and `Docs/SRD.md` §10 has its row, or the exclusion list
  does and this console has its own importer test. **The set is asserted in both directions, so
  silence is not an option.***

**Read-only, as a layering guard rather than a promise (§6.10)**
- **Anti: no mutating verb, control-socket client or ledger writer is reachable from the triage
  console's own modules.** *Probe: mirror `test/unit/monitor-readonly.test.ts` — walk the transitive
  import closure from a pinned `ROOTS` set and assert the absences by name, not by count.* **Two
  lessons from that file are worth inheriting rather than rediscovering: scope the ban to the
  console's own subtree** (its first draft banned spawning across the whole closure and found nine
  offenders reached through `run/state.ts → run/worktree.ts`), **and name the one permitted exception
  rather than counting them** (`:363-369` asserts `["monitor/read/docker.ts"]` exactly). The triage
  actor's permitted exception is its dispatch path, and naming it is what makes a second one fail.

**Attribution**
- **Anti: no file this console produces — artifact, record, notification, log line or commit — carries
  an AI or assistant attribution.** *Probe: grep every generated artifact and every commit on the
  branch for `Co-Authored-By`, `Claude`, `AI-generated`, `Generated with`; any hit fails.*

**Anti: no criterion in this block requires a real terminal, a real model, a real cluster, or the
network.**

---

## 13. Implementation Checklist

**Phases are ordered by dependency, and each task names the files it touches** — so that
`/ProjectManager` can consume it. A task naming no file cannot be partitioned and will serialise.

### Phase table

| Phase | Deliverable | Depends on | Exit criteria |
|---|---|---|---|
| **0 — Decisions** | Q1 and Q2 answered; Q3 measured or defaulted | — | `Docs/SRD.md` §5.9 carries the amendment (or D1 arm 3 is recorded); the notify channel is named; `run.max_concurrent` is set |
| **1 — Config and roles** | Four seats declared and resolvable | 0 | `pifleet config validate` exits 0; `resolveWorker` returns `rpc` and the intended model for all four |
| **2 — The roster and `--console`** | The request plane serves a second console, with its own record paths | — | A triage-roster fixture drives `relayPass`; `--console` selects a roster; the actor's lock is not the review console's |
| **3 — The targets file** | `triage/targets.yaml`, schema, validation | — | A fixture round-trips; every §12 configuration criterion passes |
| **4 — The console** | `scripts/triage` and its plan | 1 | `--dry-run` prints four panes; the `quiesce` ordering test is green |
| **5 — The sweep** | Partition check, verdict mapping, incident machine, notifier | 2, 3 | Every §12 fixture passes, including the 288-sweep and alternating-sweep ones |
| **6 — The clock** | `pifleet triage --once`, its loop, its watch, and recycling | 4, 5 | `--once` drives one pass in a test with no timer; the recycle and read-only criteria pass |
| **7 — The skill** | Four consoles in the operator's skill | 4, 6 | `Workflows/Triage.md` exists; the fleet table names ten workers plus four |
| **8 — The live run** | One console, one environment, one day | 0, 6, 7 | A day's sweeps produce the incident table §1.4 describes, and Q4 is measured |

**Serialization:** 0 → 1 → 4 → 6 → 8. **Parallel after 0:** phases 2, 3 and 5 touch disjoint seams —
a roster value, a config schema, a set of pure host-side decisions — and may proceed alongside 1
and 4.

### Phase 0 — Decisions

**Intent.** Remove the two questions that make every later phase's config unwritable.

**Does not.** Write any code.

- **0.1** *(owner, not dispatchable)* Answer Q1. If arm 1 or 2, add the second amendment to
  `Docs/SRD.md` §5.9 naming `triage` and the observer seats, and **rewrite rather than delete**
  `fleet.yaml:471-475`'s comment, because a comment that records a superseded decision is how the next
  reader learns there was one. Touches: `Docs/SRD.md`, `fleet.yaml`.
  *Acceptance: §5.9 names this console, or D1 arm 3 is recorded in §10.*
- **0.2** *(owner, not dispatchable)* Answer Q2. Touches: `Docs/SRD-TRIAGE-CONSOLE.md` §11, as an
  answered question **in place** — never deleted, always prepended with the date and the answer.
- **0.3** Measure `ollama-cloud/gpt-oss:120b` against `probe_timeout_ms: 90000` **before** it is
  allowlisted. Touches: nothing.
  *Acceptance: the latency is recorded in `ISA.md`. `fleet.yaml:280` calls it "in the fast group" and
  that is a 2026-09-03/04 measurement of a model not currently on the list; a model near the ceiling
  makes `up` refuse the whole fleet.*
- **0.4** Set `run.max_concurrent` (Q3), after confirming by inspection that no other console has a
  run holding more than one worker. Touches: `fleet.yaml`, `fleet.example.yaml`.

### Phase 1 — Config and roles

**Intent.** Four seats that `config validate` accepts and `resolveWorker` resolves.

**Does not.** Change the `observer` role's tools, grants or skills. The observers are the role that
already exists.

**And one interaction that bites this phase, inherited from SRD-FLEET-PM-001 §13 Phase 1.**
`fleet.yaml` is **gitignored** (`.gitignore:9`), so an engineer dispatched to edit it produces **no
diff**, and a `success` claim with an empty diff is graded `failed` under ISC-93 as a fabrication.
**The live config is edited by the operator by hand; only `fleet.example.yaml` may be given to a
worker.** Task 1.1 is split on that line.

- **1.1a** *(operator, not dispatchable)* In the untracked live `fleet.yaml`: add the `triage` role
  (§6.1), the four worker entries, and — if Q1 requires it — `gpt-oss:120b` to
  `llm.providers.ollama-cloud.models_allowlist` (after `:251`) and its measured window to
  `context_windows` (after `:270`). Touches: `fleet.yaml`.
  *Acceptance: `pifleet config validate` exits 0. **Not dispatchable — produces no diff.***
- **1.1b** The same additions in the tracked example. Touches: `fleet.example.yaml`.
- **1.2** Write the triage role prompt. It is **not** a copy of `roles/collator.md`: it covers the
  partition, the two-turn protocol, `triage.json`'s field rules, and the rule that it does not decide
  whether to notify. Touches: `roles/triage.md` (new).
  *Acceptance: `skills:` names only real directories — `fleet.example.yaml:451-456`'s rule, and only
  `pifleet-worker`, `observer-ops` and `ticket-ops` exist today.*
- **1.3** Add the model-resolution criteria from §12's configuration block, including the
  allowlist-removal mutation. Touches: `test/unit/config.test.ts`, `ISA.md`.
- **1.4** Add the anti-criterion that no seat resolves to `tui`. Touches: `test/unit/config.test.ts`,
  `ISA.md`.

### Phase 2 — The roster and `--console`

**Intent.** Make the request plane serve a second console, once, in the shape `relay.ts:377-392` says
it should be solved.

**Does not.** Rename `ConsoleRoster`'s fields (§10 D5), or add a second request mechanism.

- **2.1** Add `TRIAGE_CONSOLE_ROSTER`, a triage aspect table, and the two new refusal codes. Touches:
  `src/run/dispatch-request.ts`, `src/run/task-ids.ts`, `test/unit/dispatch-request.test.ts`.
  *Note: no aspect may be named `collate` — `resolveAspects` throws `RelayAspectError`
  (`relay.ts:157-164`) — and no sweep task id may end `-collate`, or `isCollationTaskId`
  (`task-ids.ts:181-207`) refuses the fan-out outright. `T-sweep-<n>` satisfies both; a future
  rename must re-check it.*
- **2.2** Add `--console <name>` to the actor path, selecting a roster and an aspect table, so the
  worker→run scoping problem is solved once rather than twice. Touches: `src/cli/commands/relay.ts`,
  `src/run/relay.ts`, `test/unit/relay-console.test.ts` (new).
  *Note: `relay.ts:377-392` is the comment this task closes; it should be updated rather than left
  describing a gap that no longer exists.*
- **2.3** Parameterise the actor's three bookkeeping paths and add the console name to
  `RelayRecordSchema`, so a second actor cannot claim the review console's lock. Touches:
  `src/run/console-relay.ts`, `test/unit/console-relay.test.ts`.
  *Acceptance: §12's actor-record anti-criterion passes. **Take the module's existing decisions
  unchanged** — the four-verdict status, and `acquireRelayLock`'s write-then-`link` claim with
  `rename`-decided takeover (`:393-522`), whose docblock records that the obvious spelling left the
  console "permanently actorless".*
- **2.4** *(prose, no behaviour)* Correct the two stale docblocks that still say a set
  `PIFLEET_RELAY_RUNS` skips the host-wide scan — `src/run/status-runs.ts:166-167` and
  `scripts/review:471`. `relay.ts:2915-2954` made the pin a hint that **decays**, and this document's
  §2.2 reasoning depends on the current behaviour rather than the documented one. Touches:
  `src/run/status-runs.ts`, `scripts/review`.
- **2.5** Add the roster-wiring criteria from §12's partition block. Touches: `ISA.md`.

### Phase 3 — The targets file

**Intent.** A tracked, validated service registry.

**Does not.** Add a `pifleet` verb that writes it. §5.2.

- **3.1** Define the schema and the loader. Touches: `src/run/triage-targets.ts` (new),
  `test/unit/triage-targets.test.ts` (new).
  *Acceptance: a fixture round-trips; `.strict()` refuses an unknown key with a field-level error.*
- **3.2** Add the kubeconfig-subset check and the two duration refusals (`default_window` > cadence;
  `sweep_deadline_s` ≥ `cadence_s`). Touches: `src/run/triage-targets.ts`,
  `test/unit/triage-targets.test.ts`.
  *Acceptance: §12's three configuration probes pass. **This is D11's fence and it is the phase's
  highest-priority task** — without it the console can reach an environment nobody wrote down.*
- **3.3** Wire it into `pifleet config validate` so one command checks both files. Touches:
  `src/cli/commands/config.ts`, `test/integration/cli-exit-codes.test.ts`.
- **3.4** Write the worked file for the commission's example. Touches: `triage/targets.yaml` (new).

### Phase 4 — The console

**Intent.** A fourth `WorkspaceSpec` and a thin driver.

**Does not.** Put any decision in `scripts/`. §3.3 — it is untypechecked and uncovered.

- **4.1** Add `TRIAGE_WORKSPACE`, `DEFAULT_TRIAGE_WORKERS`, `triagePanes()` and `TRIAGE_TOP_FRACTION`,
  reusing `agentSquarePanes`. Touches: `src/backends/cmux/operations-plan.ts`,
  `test/unit/triage-plan.test.ts` (new).
- **4.2** Add `TRIAGE_SPEC` and `ensureTriage()`. Touches: `src/backends/cmux/operations.ts`,
  `test/unit/operations-workspace.test.ts`.
- **4.3** **Write the `quiesce`-ordering test BEFORE the script.** ISC-572 is the reason: the same
  defect on a fourth console would be caught by neither `typecheck` nor the suite. Touches:
  `test/unit/fresh-dispatch.test.ts`, `test/unit/console-restart.test.ts`.
  *Acceptance: the test asserts `scripts/triage` **hands the stop over** — no `quiesce(` call between
  the branch and `recreateThenDispatch(`, and `quiesce` present in the deps object — bounded narrowly,
  because ISC-572 records that a wider span was satisfied by the literal `quiesce,` inside a comment.*
- **4.4** Write the driver: argv parsing, exits, printing, and nothing else. Flags: `--dry-run`,
  `--recreate`, `--restart <id>`, `--task <path>`, `--workers <ids>`, `--no-actor`, `--actor-stop`,
  `--cadence <duration>`. Touches: `scripts/triage` (new).
- **4.5** Add the console criteria from §12. Touches:
  `test/integration/triage-console.test.ts` (new), `ISA.md`.

### Phase 5 — The sweep

**Intent.** Every host-side decision, as pure functions over fixtures. **This phase touches no
container and no network, and that is what makes it the one phase CI can fully re-check.**

**Does not.** Read the collator's `status` as the sweep's verdict — `roles/collator.md:228-235`'s rule,
and SRD-FLEET-PM-001 D7's.

- **5.1** The partition completeness check. Touches: `src/run/triage-partition.ts` (new),
  `test/unit/triage-partition.test.ts` (new).
- **5.2** The verdict mapping: `triage.json` + host-counted coverage → per-service assessment,
  including the structural gate that downgrades an unevidenced `healthy`. Touches:
  `src/run/triage-verdict.ts` (new), `test/unit/triage-verdict.test.ts` (new).
- **5.3** The `sweep_id` echo check. Touches: `src/run/triage-verdict.ts`,
  `test/unit/triage-verdict.test.ts`.
- **5.4** The incident state machine, as a pure `(record, observation) => {record, notifications[]}`.
  Touches: `src/run/triage-incident.ts` (new), `test/unit/triage-incident.test.ts` (new).
  *Acceptance: the 288-consecutive-sweeps fixture asserts exactly one notification; the alternating
  fixture reaches `flapping` and emits once; the `unhealthy → indeterminate` fixture does **not**
  recover.*
- **5.5** The incident record's schema and validated read. Touches: `src/run/triage-incident.ts`,
  `test/unit/triage-incident.test.ts`.
- **5.6** The notification composer — typed fields in, `{title, message}` out, pure — and the
  transport with its undelivered path. Touches: `src/run/triage-notify.ts` (new),
  `test/unit/triage-notify.test.ts` (new).
  *Acceptance: §12's injection fixture passes. **This is the phase's highest-priority task after 5.4**
  — §4.3 is why.*
- **5.7** Add every §12 fixture in the issue-predicate, dedup and notification blocks. Touches:
  `ISA.md`.

### Phase 6 — The clock

**Intent.** One pass, exported; one loop, a wrapper.

**Does not.** Start a second scheduler anywhere. §4.4.

- **6.1** `triagePass(deps)` — read the run tree, decide tick-or-skip, perform the fan-out, drive the
  incident machine, emit. Touches: `src/run/triage-pass.ts` (new),
  `test/unit/triage-pass.test.ts` (new).
  *Acceptance: every test calls the pass directly; **no test starts the loop**.*
- **6.2** `pifleet triage` with `--once`, `--poll`, `--status`, `--json`, and the loop's
  catch-and-continue — **which `--once` deliberately does not get** (`relay.ts:700-723`). Touches:
  `src/cli/commands/triage.ts` (new), `test/unit/triage-command.test.ts` (new).
  *Acceptance: the command is imported in-process by its own test, and its place in
  `test/unit/cli.test.ts`'s bidirectional `SRD_COMMANDS` set is settled — either the set gains
  `triage` and `Docs/SRD.md` §10 gains its row, or the exclusion list does. **§3.3: the
  command-wiring layer is the layer the coverage gate keeps catching.***
- **6.3** The actor record, log and lock (per-console, from Phase 2.3) plus a `ConsoleWatch` over
  `tri-1`. Touches: `src/run/triage-actor.ts` (new), `test/unit/triage-actor.test.ts` (new).
  *Acceptance: §12's exit-when-the-console-is-gone criterion and its streak-reset mirror both pass.*
- **6.4** Resume-from-run-tree, and the anti-criterion that a restart never double-dispatches.
  Touches: `src/run/triage-pass.ts`, `test/unit/triage-pass.test.ts`, `ISA.md`.
- **6.5** Recycling (§6.6 layer 4): `down` then `up` between sweeps at `recycle_after_sweeps`, with
  the sweep counter carried across. Touches: `src/run/triage-actor.ts`,
  `test/unit/triage-actor.test.ts`, `ISA.md`.
  *Acceptance: the in-flight fixture recycles nothing, the idle fixture recycles, and the sweep
  counter continues rather than resetting. **This task is what makes an unattended console possible
  at all** — §2.3a — and it is buildable only because an `rpc` recreate needs no TTY.*
- **6.6** Add the read-only closure guard, mirroring `test/unit/monitor-readonly.test.ts` and scoped
  to the console's own subtree with its one dispatch exception **named**. Touches:
  `test/unit/triage-readonly.test.ts` (new), `ISA.md`.
- **6.7** Wire the actor start/stop into `scripts/triage` as a `quiesce` dep. Touches:
  `scripts/triage`, and **nothing in `src/` that Phase 4.3's test does not already pin**.

### Phase 7 — The skill

**Intent.** Four consoles, and one sentence that stops an operator looking for a dispatch.

- **7.1** Add the four rows and update the frontmatter description. Touches:
  `.claude/skills/fleet/SKILL.md`.
- **7.2** Add the console row and the actor section. Touches:
  `.claude/skills/fleet/Workflows/Consoles.md`.
- **7.3** Write the workflow. Touches: `.claude/skills/fleet/Workflows/Triage.md` (new).
- **7.4** Update the three-console description. Touches: `README.md`.

### Phase 8 — The live run

**Intent.** One console, one environment, one day. Everything before this is fixtures.

**Does not.** Run against a production tier on the first day, or leave the console unattended before
Q4 is measured.

- **8.1** Open the console against `cni-dev` with the commission's three services, and confirm one
  observer's `/workspace` is absent and its kubeconfig contexts are the expected subset.
- **8.2** Run for one day. Record: sweeps completed, sweeps skipped, `stale_replay` count,
  notifications emitted, undelivered count, and **tokens spent** (Q4). Touches: `ISA.md`.
- **8.3** Record what the run found that this document did not predict. Touches: `ISA.md`,
  `Docs/SRD-TRIAGE-CONSOLE.md` (§11, as answered questions **in place** — never deleted, always
  prepended with the date and the answer).

---

## 14. References

- `src/run/dispatch-request.ts` — `ConsoleRoster`, `REVIEW_CONSOLE_ROSTER`, `assertRoster`,
  `resolveRoster`, `DispatchRequestSchema`, the twelve refusal codes, `MAX_DISPATCH_REQUEST_ITEMS`.
- `src/run/relay.ts` and `src/cli/commands/relay.ts` — `relayPass`, `consoleFanOut`, the
  `--once`-is-the-real-command argument, `--poll`, and the `--console` gap at `:377-392`.
- `src/run/fresh-dispatch.ts` — `recreateThenDispatch`, `FreshDispatchDeps.quiesce`, and the
  refuse-having-stopped-nothing property.
- `src/backends/cmux/operations-plan.ts` and `operations.ts` — the three consoles as values,
  `agentSquarePanes`, `SQUARE_MAX_PANES`, `WorkspaceSpec`.
- `src/config/schema.ts` — `FleetConfigSchema`, `RoleFieldsSchema`, `ProviderSchema`,
  `IsolationSchema`, `pane_mode`, `observerTuiEpochWarning`, `workersMissingKubeconfig`, and every
  `.strict()`.
- `src/config/load.ts` — `resolveWorker`, `decomposeModel`, `assertModelAllowed`,
  `ModelNotAllowedError`, and the `defaults ← role ← worker` merge.
- `src/safety/budget.ts` — `max_concurrent` admission control and the run's token ceiling.
- `scripts/coverage-modules.ts` — `STRUCTURAL_ABSENCES` and the both-directions rule.
- `.github/workflows/ci.yml:61-62` — where the coverage gate runs.
- `fleet.yaml` — the `observer` role and its 2026-09-03 model decision (`:467-490`), the
  `ollama-cloud` provider (`:149-282`), `egress.allow` (`:283-372`), `secrets` (`:392-408`), and
  `run:` (`:46-92`).
- `fleet.example.yaml` — the tracked config, the `obs-1`/`obs-2` tui-override argument (`:546-573`),
  and the `observer` role entry (`:415-437`).
- `roles/observer.md` — the role prompt, and the three sentences §1.1 names.
- `roles/collator.md` — the two-turn protocol, `dispatch-request.json`'s shape, the artifact split
  argument, and the rule that the collator's status is about the collation.
- `skills/observer-ops/SKILL.md` — the artifact pair, the bounded-call rules, and the **unwritten**
  verdict rule at `:104-112`.
- `Docs/SRD.md` §5.9, §12.1, §12.5, §12.6 — the bounded hosted amendment, tool scope, the untrusted
  envelope, and worker prose as data.
- `Docs/SRD-DEPLOY-OPS.md` §3.3, §6.2, §6.6, §7.1, §7.4, §7.5, §9, §11.0, §11.2, §11.3 — one
  scheduler, the role's config, the kubeconfig fence, the envelope, one-pass-per-task, the verdict
  vocabulary, the two-observation rule, and under-verification as the production failure.
- `Docs/SRD-REVIEW-CONSOLE.md` §0.2, §3.2, §6.4, §6.5, §6.6, D8 — the capability class, the unused
  `rpc` pane, the request plane, the actor's three homes, the join, and grading on structure.
- `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5, D7, D12 — coverage as the host's count, two gates, and
  the run tree as authoritative.
- `ISA.md` — the grading convention at `:97-119`, ISC-517, ISC-572, ISC-573.
- `.claude/skills/fleet/SKILL.md` and `Workflows/Consoles.md` — the cardinal rule, the measured
  replay, the relay's pins, and the console verbs.
- `~/repos/paisley/.claude/voice-server/server.ts` — `POST /notify`, its payload and its rate limiter.

**A rule for maintaining this document.** Cite the file the behaviour is *in*, never the file a
comment *says* it is in; and re-open the cited lines when editing the section around them.
`Docs/tools/check-srd-citations.py` exists for the sibling SRD and its limits are recorded there —
it verifies only citations carrying a tight anchor, and it catches three of four known drifts. **Do
not assert that citations have been verified unless it has been run and its output recorded.** This
document's §0.2 was found by following a citation into `fleet.yaml`, which is the argument for all of
it.
