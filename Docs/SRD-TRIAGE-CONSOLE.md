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

**ANSWERED 2026-09-06 by the owner: arm 3 — all four seats run the local
`gpt-oss-20b-MXFP4-Q8`.** The commission's model request is refused, the recorded 2026-09-03 decision
stands unreversed, and **no amendment to `Docs/SRD.md` §5.9 and no edit to `fleet.yaml:471-475`'s
comment are required** — which is the one arm that needed neither. The argument below is kept in
full, undeleted, because it is what the answer was taken against and because the next reader of
`fleet.yaml:471-475` deserves to find the reasoning rather than the outcome alone. D1 records the
cost.

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
be correct under all three, and **arm 3 is the one taken**: §6.11's worker-level `model:` override is
therefore not written, `llm.providers.ollama-cloud.models_allowlist` is not extended, and §13 task
0.3's latency measurement is moot because the model it would have measured is not being allowlisted.
The observers take the `observer` role's model unchanged, and `triage` is declared with the same
one.

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
| **E** | **There is no clock and no notifier anywhere in this fleet, and the endpoint the commission's wording most plausibly named is not listening** — a finding that survived the channel decision it prompted; D10 picked a webhook instead (§6.9), and the reason this row still matters is that it is *why* the undelivered path is a requirement. `run:` carries `per_task_timeout`, `run_timeout` and four `timers` (`fleet.yaml:86-92`) and **nothing that schedules**. The one recurring host process is `pifleet relay`, whose loop is a `setTimeout` around an exported single pass (`relay.ts:82-88`, `:767`) — which is the pattern this design copies rather than the scheduler it needs. For the notifier: **measured on this host 2026-09-06** — `curl` to `localhost:8888` and `localhost:31337` both returned no response, and `lsof -nP -iTCP -sTCP:LISTEN` showed neither port bound. The PAI voice server is real (`~/repos/paisley/.claude/voice-server/server.ts:249`, `POST /notify`, payload `{title, message, voice_enabled, voice_id}`, launchd `com.paivoice.server`, `PORT` default `8888` at `:24`) and its service was **not loaded**. | Yes | §2.4, §2.5, §6.9 |
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
before-and-after. SRD-OBSERVER-001 §2.1 records that a captured baseline is **"absent by
construction"** for two of its three invocation shapes, because by the time the operator asks, the
pipeline has already run; the fallback there is to date the anomaly instead, and that document is
explicit about what the fallback costs — *"It is the fallback, not the general method, because it can
only speak to anomalies that leave a datable trace, where a baseline captures the whole state."* A
console that has been sweeping every five minutes holds the whole state, observed, for the shapes
that today have to fall back to dating.

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
neither was in `lsof -nP -iTCP -sTCP:LISTEN`.

**This is a reading of what exists, not the channel this design picks — and that sentence is a
correction.** The draft did pick it; §6.9 and D10 withdrew the pick the same day, and this subsection
is retained because the measurement is what made the withdrawal necessary rather than stylistic. The
channel is a configurable webhook (§6.9, §7.8). What survives the withdrawal intact is the lesson:
the operator's own notifier was **not available** on the day the console was specified, so §6.9's
undelivered-notification path is a requirement rather than a nicety, and it would have been one for a
loopback socket too.

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

> **CORRECTION 2026-09-06, measured while implementing task 4.4: this console is four runs, not one,
> and so is every other console in the fleet.** `agentSquarePanes` gives each seat its own pane whose
> command is `pifleet up --workers <one worker>`, and `operations-plan.ts:310` states it outright —
> *"Each pane creates its own run."* `./scripts/triage --dry-run` prints exactly that. The heading's
> "one run" is what the design intended and not what the fleet does; the same measurement is what
> closed §13 task 0.4, where `run.max_concurrent` turned out to have had nothing to bind on at any
> value. **Nothing in Phases 1–5 depends on the difference** — `consoleRunPins` reads live status, so
> the pin machinery works either way. **Phase 6's recycling does**: "`down` then `up` between sweeps"
> is written against the one-run reading and must be re-read as four runs before 6.6 is implemented.
> **Settled 2026-09-06:** four `down`s and four `up`s, with a per-seat boundary so a partial recycle
> is finished rather than restarted. See §6.6 layer 4.

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

  **CORRECTION 2026-09-06, found while implementing 1.1b: that override rule is right for the live
  file and wrong for the tracked one, because the two disagree about what the `observer` role's model
  is.** The sentence above cites `fleet.yaml:467-490`, and in the live file the role is
  `model: gpt-oss-20b-MXFP4-Q8` (`:486`) — so inheriting it delivers arm 3 exactly. In
  `fleet.example.yaml` the same role is `model: Qwen3.5-35B-A3B-8bit`, so inheriting it delivers a
  *different* local model. **Both are local and both satisfy arm 3's privacy property**, which is why
  this is a correction about legibility rather than about exposure: the tracked example is where a
  reader looks to see what was decided, and it should show the decision rather than a model that
  merely shares its posture. So `obs-t1`, `obs-t2` and `obs-t3` carry an explicit
  `model: gpt-oss-20b-MXFP4-Q8` **in the example only**, commented with why an override exists where
  this section says none should. `tri-1` is unaffected — the `triage` role declares the model itself.

  **The general lesson, recorded because it will recur:** every rule in this document that cites
  `fleet.yaml` is a rule about the untracked file, and the example is not guaranteed to agree with
  it. §13 Phase 1 already splits task 1.1 on that line for the *diff* reason. This is the same seam
  biting for a second, unrelated reason, and a task that touches both files should check both rather
  than assume the citation covers them.
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
| 1 | tick fires; a sweep is due and none is in flight | actor | `~/.pifleet/triage-relay.json` cursor advances |
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
run tree, not by trusting `~/.pifleet/triage-relay.json`: a sweep whose parent task exists and whose
`-collate` task has not settled is in flight, and the actor resumes it rather than starting a new one.
**A restarted actor never double-dispatches a sweep**, and that is a criterion, not a hope (§12).

**CORRECTION 2026-09-06, found by task 6.2 and it is the sharpest defect this document has had.** The
in-flight predicate above — *"a sweep whose parent task exists and whose `-collate` task has not
settled"* — **has a state it can never leave.** §6.5's zero-row sweep dispatches **no collation at
all**, so *"the `-collate` task has not settled"* is true, true for the same reason forever, and can
never become false. An actor reading this sentence literally skips every subsequent tick, counts to
`max_consecutive_skips`, notifies once that it has stopped triaging, and **never sweeps again —
silently, because a skip is not an error and the console is otherwise behaving exactly as designed.**
One zero-row sweep would end the console. The discrimination is the PARENT's own task record: a
settled parent with no collation is a finished zero-row sweep, not an in-flight one. Task 6.2
implemented the corrected predicate and pinned all four quadrants (ISC-805); this sentence is
corrected here, and §12's skip criterion quotes it, so the quote moves with it.

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
- ~~**The actor already holds the whole run**, so a recycle is one `down` and one `up`, not a
  four-way pane dance.~~ **FALSE, and §6.1's correction is why: the console is four runs.** A recycle
  is four `down`s and four `up`s. The *cost* survives the correction with room to spare — 24
  container recreations a day against the 288 a per-sweep restart would cost — but the **atomicity
  the sentence assumed does not**, and that is what the resolution below is about.
- **The idempotency rules are the same ones §6.4 already needs**: recycle only with no sweep in
  flight, and re-derive from the run tree afterwards.

**This is not the same knob as a per-sweep restart, and the difference is the whole reason it is
affordable.** A restart per sweep is 288 container recreations a day; a recycle every 48 sweeps is 6.
`recycle_after_sweeps: 0` disables it, which is the setting to use while measuring Q5 — but leaving
it there indefinitely means accepting a transcript that grows until Pi compacts it, which is a
decision rather than a default.

**RESOLVED 2026-09-06 by the operator: recycle all four seats, and make the recycle RESUMABLE.**
A four-run recycle can half-succeed where a one-run recycle could not — three seats up, one down, and
a console that fans out to nobody. There is no transaction available across four `up`s, so the answer
is re-entrancy instead.

**The boundary condition is per-seat, not per-console.** The actor does not ask *"have
`recycle_after_sweeps` sweeps elapsed since the last full recycle"*; it asks, of each seat, *"is this
seat's run older than `recycle_after_sweeps`, or absent"*. A crash between the second seat and the
third then leaves a state the next boundary **reads correctly and finishes**, rather than one it
reads as done. Two consequences, both Phase 6's to build:

- **No sweep is admitted while any seat's pin is unresolved.** Constraint B is the reason: a pinned
  worker the relay cannot resolve *refuses every fan-out*, so a sweep dispatched into a half-recycled
  console fails four times and reads as a model problem. **The gate is four pins re-derived, not four
  containers running** — those are different moments and only the later one is safe.
- **§7.7's `run_id` is wrong and becomes `runs`**, a per-seat map of worker id to run id. D12 keeps
  the run tree authoritative over the record, so recovery still reads run trees — four of them now;
  the record is the hint that makes finding them cheap. Task 6.3 writes it.

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
| **two or more observers in one sweep produced no artifact at all** | **Yes**, as a *saturation* issue naming **inference**, never the environment | rule 3 below. It **suppresses** the coverage escalation two rows up rather than sitting beside it |

**Three rules make this trustworthy rather than merely tidy.**

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

**3. Saturation is its own verdict, and it must never arrive as a coverage gap.** All four seats
resolve to one model on one provider — `gpt-oss-20b-MXFP4-Q8` on `omlx`, which is `hosted: false` and
is the operator's own server (`fleet.yaml:113-140`) — and `fleet.yaml:77` already names that server as
this fleet's scarce resource in its own words: `max_concurrent: 1  # bounded by oMLX throughput, not
pane count (§5.9)`. So the failure this console will actually meet is not the inference server being
*down*. It is the server being *slow*. Four seats contend for it, observers exceed
`sweep_deadline_s`, their services come back with no artifact, those services are `indeterminate`,
and three consecutive sweeps of that escalates through the row above into a **coverage** issue. The
console then tells the operator *"I could not see `mia`, `authorization` and `authentication`"* and
points them at the cluster, while the fault is one process on their own machine. **That is the
console misdiagnosing itself, in the direction that costs the most** — it spends the operator's
attention on the environment it was built to watch in order to hide a defect in the watcher.

The discriminator is available host-side and needs no new machinery:

- **Correlation, and it is the primary signal.** A cluster fault does not arrive at three independent
  observers in the same sweep; a shared dependency does, and the only dependency all three share is
  the inference server. **Two or more observers producing no artifact in one sweep is a statement
  about what they have in common**, and what they have in common is not the environment.
- **Confirmation, from a probe this repository already exports.** `probeNativeToolCalls`
  (`src/security/model-probe.ts:230`), run host-side against `hostReachableBaseUrl` (`:603`), once per
  saturation candidate and never per sweep. Its failure classes are already the two this verdict has
  to keep apart, and its own docblock says why they are worth keeping apart: *"A timeout is NOT
  "unreachable", and conflating them is a misdiagnosis this project has the incident report for
  (S1)."* A `timeout` verdict is saturation. An `unreachable` verdict is the server being down, which
  is a different sentence on the operator's screen and a different thing for them to go and do.

**Ordering, because both rules can be true of one sweep.** Saturation is evaluated **before** the
coverage escalation and **suppresses** it: a service's `consecutive_indeterminate` counter does not
advance across a sweep marked saturated. Without that ordering the console emits both findings and
the operator reads the one that names their cluster, which is the failure this rule exists to
prevent rather than to describe. The announcement composed for a saturation issue carries the
**provider and model** as its subject and the environment only as the scope of what went unobserved
— and that is a typed field (§6.9), so a later edit that reuses the service template cannot get it
the wrong way round without failing a test.

**Coverage is counted host-side.** The number of services observed comes from the run tree — the
journal's `children[]` against the reply files present — never from `triage.json`'s own claim. This
is ISC-517's hazard and SRD-FLEET-PM-001 §7.5's correction, and this console meets it 288 times a day
rather than occasionally.

**THREE FINDINGS FROM TASK 5.3's MUTATION BATTERY, 2026-09-06, graded and ruled.** Each came from a
survivor rather than from reading, which is why they are recorded here rather than left to the module.

**1. `duplicate_rows` is ADOPTED as a seventh assessment reason.** `triage.json` can carry two rows
for one service, and the battery found first-row-wins and last-row-wins mutually indistinguishable —
**under either, a worker overturns its own `unhealthy` by appending a `healthy`.** That is a silent
upgrade past the whole gate, by a document the worker controls end to end. The refusal is the only
answer that is not the host picking a verdict, which rule 1's opening sentence removes from the host:
`indeterminate`, not counted, agreement deliberately not consulted, and **asserted in both orders** so
the fixture cannot pass by accident. It is a vocabulary addition the draft did not name; it is
adopted because refusing to choose is the *conservative* direction and choosing would be judgement.

**2. A FIFTH condition joins rule 2, and it is condition 1 read honestly rather than a new
judgement.** A `healthy` whose `coverage[]` is non-empty but whose every entry is `not_attempted`
passes the gate as written. It should not, and the reason it is safe to say so is that **zero attempts
and zero entries carry exactly the same information** — the observer attempted nothing either way, and
the array's length is the only thing that differs. This needs no threshold and decides no channel set,
so it does not reopen the judgement rule 2's opening sentence closes. Contrast the check that *would*:
*"were these channels enough"* has a threshold in it and is refused. Task 5.3b.

**3. §6.6 layer 3's second echo is specified and enforced nowhere.** Layer 3 requires the artifact to
echo *"the sweep id **and the observation window's opening timestamp** … must echo **both**"*, while
§7.4's two required additions are `sweep_id` and the per-service rows — the timestamp is not among
them and no refusal is written for it. **The row-level `window` field is not the same check and does
not cover it**: `evidenceGaps` tests that a window was *named*, not that it was *opened when it should
have been*, so an observer can echo the right sweep id, name a window, and have queried six hours
against a five-minute configuration. Both halves are needed and only one exists. Task 5.3c settles it
— either §7.4 grows the field and a refusal, or layer 3's clause is struck as overstated.

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
| `flapping → firing` | **yes, once** | after `flap_window` with no observed clear, **on OBSERVED issues only**. Added 2026-09-06 |
| `flapping → firing` (blind) | **yes, once**, as `coverage` | §6.7 row 5's escalation, widened to `flapping` by 5.4c. `COVERAGE_THRESHOLD` blind sweeps, `evidenceRef: null` |

**`flapping → firing` was MISSING, and the hole it left is the worst shape a notifier has — found
2026-09-06 while implementing task 5.4, from the state machine rather than from a fixture.** A service
that flaps and then goes hard down was **silent indefinitely**: it is not stable, so `flapping → clear`
never fires; it is not `firing`, so the re-notify floor never reaches it. The operator's last word on
it was *"this is flapping"*, which by then is false and reassuring in the wrong direction. **The
service that most needs attention is the one that goes quiet**, and no probe in §12 would have caught
it because every flap fixture keeps flapping.

The repair needs **no new knob and no new judgement**, which is what makes it safe to add here rather
than defer: `flap_window` already means *"how long a thing must hold before I believe it"*, and it is
spent on stability in one direction and on instability in the other.

| direction | condition over `flap_window` | result |
|---|---|---|
| `flapping → clear` | no transitions, and the state observed is healthy | the recovery notification |
| `flapping → firing` | no transitions, and no observed clear | the open notification, **once**, and the re-notify floor restarts |

**What a window of BLINDNESS does — ruled and SHIPPED 2026-09-06 as task 5.4c.** The condition column says *"no transitions, and no observed clear"*, and a window in which
nothing was seen at all satisfies both — so 5.4b fires, with `evidenceRef: null`, and argues the case
in the code. That was the right call **given the escalation guard as it stands**, because refusing
would leave a service that flaps and then goes invisible silent forever, which is the identical hole
this edge closes. But it announces the record's last known reason — `unhealthy`, or the literal
fallback — when the true fact is *"we could not see it"*, and that is §6.7 rule 3's misdiagnosis
family in miniature.

**The better answer was already in the module and guarded away from this state:** `onUnobserved`'s
coverage escalation is restricted to `clear` and `provisional`, so a flapping service that goes blind
never reaches it. Widening it to `flapping` is the same `COVERAGE_THRESHOLD` applied to one more
state — **not a new judgement, and the same oversight family as the missing edge itself**, since both
come from a table that treated `flapping` as terminal. With that widened, the edge can require an
OBSERVED issue and the two paths stop overlapping: blind escalates as `coverage`, hard-down opens
with what was seen.

**Built, and the removal costs nothing** — which was the argument and is now measured. The escalation
fires at `COVERAGE_THRESHOLD` sweeps where the settle edge needed a full `flap_window`: **fifteen
minutes rather than an hour** at the shipped defaults. So the blind branch was deleted rather than
narrowed, and the notification finally says the true word.

**One thing the fixture had to earn.** The first test written for this asserted the finished
oscillation record is dropped — `flap_transitions` empty after the escalation — and the mutation
that carries it forward instead **SURVIVED**. The timeline stopped alternating at the flapping
notice, so the list was already empty by the time the escalation fired and the assertion compared
empty against empty. The fixture now alternates four sweeps PAST the notice, so §6.8's
not-yet-stable branch keeps appending clears and the list is genuinely live, **with the premise
asserted rather than assumed** — one sweep before the escalation, the record is flapping and its
window is non-empty. That is the seventh appearance of the degenerate-fixture defect on this branch
and the first in the orchestrator's own test.

The symmetry is the argument: a window of unbroken *anything* means the service has stopped flapping,
and which state it settled into decides which notification is owed. Task 5.4b.

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

### 6.8a Console-health issues reuse that machine, and this is the hole that closes

**The machine above is keyed per `(environment, service)`. Seven of the things this console can notify
about are not a service, and until this section they had no dedup identity at all** — which is not a
small omission. §6.7 makes an observer's `blocked` notifiable, and a tunnel that is down for a day is
`blocked` on **every** sweep: 288 identical notifications, from the console whose §6.8 exists
precisely to turn 288 into 1. §6.4 has the same shape from the other side — it fires at
`max_consecutive_skips` and says nothing about skips 4, 5 and 6.

**They reuse §6.8's machine unchanged. Only the identity is new**, and the identity is the whole
fix: a state machine with no key deduplicates nothing.

**The identity is `(scope, kind)`**, recorded at `~/.pifleet/triage/<scope>/_console/<kind>.json`,
where `scope` is an environment token for the kinds that are about an environment and the literal
`_console` for the kinds that are about the console itself. `kind` is a closed enum, on §6.2's rule
for `checks[]` — a closed set cannot acquire a seventh member by accident, and a `kind` a reader **It acquired one ON PURPOSE in task 5.4d, and the two independently spelled copies of the table caught it — which is the rule working, not failing.**
cannot enumerate is a `kind` nobody writes a criterion for.

| `kind` | `scope` | Raised when | Cleared by |
|---|---|---|---|
| `observer_blocked` | environment | an observer returned `status: blocked` (SRD-OBSERVER-001 §9.3) | a sweep in which that environment's observers returned a non-`blocked` status |
| `sweep_produced_nothing` | environment | §6.5's zero-row: no child succeeded, so no collation was dispatched | a sweep that collated |
| `sweeps_skipped` | `_console` | consecutive skips reach `max_consecutive_skips` (§6.4) — **raised one skip earlier, see below** | a sweep that ran |
| `inference_saturated` | `_console` | §6.7 rule 3 | a sweep in which every observer produced an artifact |
| `inference_unreachable` | `_console` | §6.7 rule 3's `unreachable` half — the confirming probe could not reach the endpoint at all | a sweep in which every observer produced an artifact |
| `budget_exhausted` | `_console` | admission refused on the run's ceiling, exit 5 (§6.10) | a new run — which in practice means a recycle or a restart |
| `reporter_undelivered` | `_console` | §9.15 — the delivery path itself is failing | a delivery that succeeds |

**THE SKIP THRESHOLD CARRIES A DELIBERATE OFF-BY-ONE, resolved 2026-09-06 while implementing task
5.4a.** §12 asks for two things at once — *"skips 4, 5 and 6 send nothing"* and *"exactly one
notification, at the third"* — with `max_consecutive_skips` defaulting to 3. Those are only
consistent if the OPEN lands on skip 3, and this section inherits §6.7 rule 1, so an open needs a
confirmation sweep behind it. **Raising the issue AT the threshold would put the open on skip 4 and
falsify both of §12's sentences.**

So the issue is raised one skip early and the machine's own confirmation carries it to the threshold.
That is not a second rule: **§6.4's number is a statement about when the OPERATOR is told**, and
confirmation is how the machine gets there. Absorbing it in the identity layer is precisely what lets
this section's *"the machine unchanged"* stay literally true — the alternative was a special case
inside `advanceIncident`, which is the failure condition §13 task 5.4a names for itself.

Two smaller rules fall out of the same place and are worth stating because the obvious choice is
wrong for both:

- **A skipped pass below the raise line produces NO observation** — not an `unobserved` one. A
  skipped pass is not *"a sweep that ran"*, so it cannot clear; and `unobserved` would advance
  `consecutive_indeterminate` toward the coverage escalation, announcing that the console cannot SEE
  a service when the fact is that it chose not to look yet.
- **`saturated: null` is not `saturated: false`.** A sweep that could not tell says nothing about
  `inference_saturated`; only a sweep that positively observed every observer producing an artifact
  clears it. §6.7 rule 3's own distinction, at the one place a `boolean` would have erased it.

**What reuse buys, stated as the three properties it inherits rather than left implied:**

1. **Confirmation.** One sweep of `blocked` is `provisional` and silent; two consecutive is `firing`
   and notifies **once**. A tunnel down for a day is one notification and then the `renotify_after`
   floor — **single digits rather than 288**, and the exact figure is deliberately not stated here
   any more. **CORRECTED 2026-09-06, found while implementing task 5.4:** this sentence said *"4
   messages in 24h"* while §12 asked for *"4 reminders"* on top of the open, and both were
   defensible — the difference is whether the 24h window is closed (`0,6,12,18,24` → one open and
   four reminders) or half-open (`0,6,12,18` → one open and three). **A criterion whose literal
   count depends on an unstated inclusivity makes a correct implementation red**, which is worse
   than the vagueness it was written to avoid. §12 now pins the INSTANTS instead, and the count
   follows from them; the rule is that each reminder falls exactly one `renotify_after` after the
   message before it.
2. **`firing → firing` is silent.** That is the rule §6.8 calls *"the rule that turns 288 into 1"*,
   and it is the direct answer to §6.4's unstated question about skips 4, 5 and 6: they advance
   `sweep_count` and send nothing.
3. **Recovery must be observed, on §6.8's rule and for §6.8's reason.** A `kind` clears on a sweep
   that positively saw the good state, never on the absence of the bad one. `sweeps_skipped` does
   **not** clear because the actor stopped counting — an actor that died stops emitting skips, and
   reading that as recovery would announce that a dead console is healthy.

**One thing carries over that a reader might not expect, and one thing cannot carry over at all.**

- **`flapping` applies, and it is the more useful verdict here than it is for a service.** An
  environment whose control plane is reachable every other sweep is a finding about the network, and
  it is exactly the shape §6.8's flap damping was written for. Nothing special is needed; the same
  `flap_threshold` and `flap_window` apply.
- **`reporter_undelivered` cannot notify through the channel it is about**, which is why it has §9.15
  and its own paragraph in §6.9 rather than a row here that pretends otherwise.

### 6.9 The notification — a configurable webhook, host-side, typed, with ntfy as the default adapter

**Decision: a configurable webhook. The actor `POST`s to `notify.endpoint`, which defaults to
`https://ntfy.agileguy.ca/Alerts`, and the request is built by a named adapter from a typed
announcement composed host-side. `notify` lives in the console config contract §7.8 defines, not in
`fleet.yaml` and not in argv. This supersedes the `localhost:8888` PAI voice-server pick this
document carried in draft — including §2.5's closing candidate — and it closes §11 Q2.**

**The default was checked before it was written down**, because a default URL nobody verified is
exactly the class of claim this document's closing rule forbids. Measured on this host, 2026-09-06:

| Check | Result |
|---|---|
| `dig agleguy.ca A` — the spelling the commission used | **NXDOMAIN.** No A record, no zone. It is a typo, not an alternative, and a console defaulting to it would have failed DNS on every notification forever |
| `dig ntfy.agileguy.ca A` | `104.21.70.27`, `172.67.218.174` |
| `GET https://ntfy.agileguy.ca/v1/health` | `200`, body `{"healthy":true}`. `docs.ntfy.sh/config/` defines this endpoint and its rule: *"If a non-200 HTTP status code is returned or if the returned `healthy` field is false the ntfy service should be considered as unhealthy"* |
| anonymous `GET https://ntfy.agileguy.ca/Alerts/json?poll=1` | **`403`.** The server is not open by default, so **the default endpoint needs a credential** — which is why the auth field below is a requirement and not scaffolding. Read was refused; **publish was deliberately not attempted**, because the only way to test a publish is to send the operator a notification |
| `GET /v1/account` (anonymous tier) | `messages: 17280` per `messages_expiry_duration: 259200` — 5,760 a day, against a console whose §6.8 design target is single digits. **The rate limit is not the binding constraint here** |

**And one coincidence that is a finding rather than a convenience.** `104.21.70.27` is the address
`fleet.yaml:131` already pins as `relay_upstream` for `inference.agileguy.ca`, and `fleet.yaml:355`
already carries `{host: 104.21.70.27, port: 443}` as an `egress.allow` entry. Both names sit behind
the same Cloudflare account, so **an IP-keyed allow rule written for the inference relay also admits
the notification endpoint**, and nobody would have to add a line to make that true.
`fleet.yaml:126-128` records half of this already — *"this pins a CDN anycast address Cloudflare does
not contract to keep"* — and the other half belongs beside it: **it does not contract to keep that
address unique to that name either**, so an IP-keyed entry for an anycast CDN grants reachability its
own comment does not describe. It costs this console nothing, because the transport does not run in a
container (**Egress**, below). It would cost something the day anything else did.

#### Why a webhook, and what the three rejected readings were

The commission says *"via claude"*, and §0.5 correction 4 recorded that as the least specified part of
it. Four readings were available and three are refused on grounds that do not depend on taste:

- **The orchestrating Claude Code session** (SRD-FLEET-PM-001 §0.2's actor) is **unavailable by
  construction**. This console's whole premise is that it runs when no session is open.
- **`backend.notify()` is refused by its own header** (Finding G): *"Presentation plane only. Nothing
  correctness-bearing may live behind this"* (`src/backends/types.ts:104`), and a triage notification
  is this console's entire output. Its tmux implementation is a deliberate no-op.
- **The PAI voice server** was this document's draft pick and is now withdrawn. Two reasons, and the
  second is the one that matters. It is not running — measured 2026-09-06, neither `8888` nor `31337`
  answered and `com.paivoice.server` was not loaded (Finding E). More consequentially, **it is a
  single hard-coded endpoint on the loopback interface of the machine the console runs on**, which
  means a console whose job is to reach the operator can only reach them while they are sitting at
  it. A health check that only works when you are already watching is the product this console exists
  not to be.
- **A webhook is the general case of all three**, and `ntfy` is one configuration of it. The endpoint
  is a URL in a tracked config file; the operator points it at their phone today and at a chat channel
  tomorrow without a code change; and the default is an endpoint that is up, that the operator already
  runs, and that was checked above rather than assumed.

**Do not call it `notify` in `src/`.** The name is taken twice already — the presentation-plane
backend method, and a Pi UI-request method in `FIRE_AND_FORGET_METHODS`
(`supervisor/ui-requests.ts:127-138`) that the supervisor is contractually required not to answer. A
third meaning in the same tree is how a reader ends up at the wrong one. `src/run/triage-notify.ts`
exports `composeAnnouncement`, `renderRequest` and `deliverAnnouncement`.

#### The payload — a typed envelope with named adapters, and ntfy is one of them

*"Configurable webhook"* and *"defaults to ntfy"* pull against each other, and the pull has to be
resolved in the design rather than left for whoever implements it. **Three arms, and the choice turns
on where the message's words are allowed to be decided.**

| Arm | Why not |
|---|---|
| **ntfy's shape, always** | Then "configurable webhook" means "configurable ntfy server", and pointing `notify.endpoint` at anything else produces a request that endpoint cannot read. It also bakes one vendor's wire format into the composer, so a second destination is a rewrite of the thing §12's injection criterion guards |
| **A body template in config** | **Refused, and this is the decisive one.** §6.9's entire security property is that the message is produced by a *pure typed function* that no worker string reaches. A template makes the composition configurable — and a configurable composition is a **configurable injection guard**. A template is also a second rendering language, living in a YAML file, outside `tsconfig.json`'s reach and outside the suite's. §6.2's rule 4 refused free strings in `checks[]` *"so a targets file cannot smuggle a command"*; a body template is the same smuggling with a different payload |
| **A typed envelope, rendered by a named adapter** | **Chosen.** `composeAnnouncement` produces an `Announcement` **value** — fields, not a string. `renderRequest(announcement, notify)` turns it into `{method, url, headers, body}`. `adapter` is a **closed enum**, `["ntfy", "json"]`, on §6.2's rule for `checks[]`: a closed set cannot acquire a third member by accident, and the set is small enough that every member has a criterion |

**What the two adapters do, and the ntfy one is specified from what ntfy actually accepts rather than
from what a JSON API usually looks like.**

- **`ntfy`** — `POST` to `notify.endpoint` **verbatim**, with the **topic in the URL path** (which is
  what `/Alerts` is), a **plain-text body carrying the message**, and the title, priority and tags as
  **headers**: `Title`, `Priority`, `Tags` (`docs.ntfy.sh/publish/` lists these as aliases of
  `X-Title`, `X-Priority`, `X-Tags`). Priority is an int 1–5, *"with 1=min, 3=default and 5=max"*.
  **This is the arm a reasonable person gets wrong**: ntfy also accepts a JSON body, and the obvious
  move is to `POST` JSON to the topic URL. The docs refuse it in a call-out box — *"To publish as
  JSON, you must PUT/POST to the ntfy root URL, not to the topic URL. Be sure to check that you're
  POST-ing to `https://ntfy.sh/` (correct), and not to `https://ntfy.sh/mytopic` (incorrect)"* — and
  the failure is silent rather than loud: the server accepts it and **the JSON becomes the message
  text**, so the operator's phone shows a wall of braces and the console reports a successful
  delivery. The adapter therefore never rewrites the configured URL and never sends JSON to it.
- **`json`** — `POST` the `Announcement` envelope itself as `application/json` to `notify.endpoint`,
  unchanged. This is the escape hatch for every destination that is not ntfy, and it is deliberately
  the *typed envelope* rather than a shaped-for-someone-else body: a receiver that needs a different
  shape puts a five-line function in front of it, which is a place a template cannot smuggle
  anything into the composer.

**One ntfy constraint that becomes a rule on our side.** The title travels as an HTTP header, and
*"The message title is limited to 1 KB, and all tags combined to 512 bytes. Requests exceeding either
are rejected with HTTP 400"* (`docs.ntfy.sh/publish/`). So `composeAnnouncement` emits a title that is
**a single line of printable ASCII, at most 200 bytes**, and `renderRequest` asserts it. A violation
is a **composer defect that fails the suite**, never a delivery outcome — because a title that could
carry a newline is a title that could carry a header, and §12.6's fencing rule applies to a header
boundary exactly as it applies to a prompt.

#### Seven requirements, and the first is a security control rather than a style rule

**1. Typed fields only in the composed message.** §4.3. `title` and `message` are rendered host-side
from `{kind, scope, subject, environment, service, assessment, transition, first_seen, sweep_count}`
through a pure function. **No worker-authored string is ever interpolated into them.** Worker prose —
the log lines an observer quotes, which are the reason the report is worth reading — appears only in a
fenced, banner-marked evidence block that is neither the title nor the body. §12.6's erratum is why
this is built rather than inherited: fencing and banner-marking are recorded there as **not met** on
the existing surfaces. Note that `subject` is what makes §6.7 rule 3 expressible: a saturation
announcement's subject is the provider and model, and a service announcement's is the service, and the
composer reads the field rather than guessing from the shape.

**2. The delivery call is bounded, and this is not defensive — it is what stops one wedged endpoint
from stopping the console.** `relayPass` is serial; §6.5 already quotes the cost in the review
console's own terms — *"`relayPass` is serial — three of them stop the actor for an hour and a half."*
An unbounded `fetch` inside that pass is strictly worse than a slow one, because a half-open socket to
an endpoint that accepted the connection and will never answer has **no** natural end at all: the pass
blocks, the loop blocks, the console stops sweeping, and the operator's only evidence is silence from
a console whose entire output is messages. So:

> **Every delivery carries `AbortSignal.timeout(notify.timeout_ms)`, default `5000`.**

That is the house pattern and not a new one — `src/security/model-probe.ts:252` and
`src/cli/commands/doctor.ts:1122` both spell it exactly that way. Five seconds against a 240-second
sweep deadline is invisible on the happy path and is the difference between a degraded console and a
stopped one on the unhappy one.

**3. The transport is an injected, named, exported type.** The idiom is
`export type DockerPsRun = () => Promise<DockerPsResult>` (`src/monitor/read/docker.ts:122`), taken
through an optional ports object with real defaults and an injected clock (`:209-214`). So:

```ts
export type NotifyTransport = (req: NotifyRequest) => Promise<NotifyOutcome>;
```

`deliverAnnouncement` takes it through `{transport?, now?}` with the real `fetch`-backed default. That
is what makes §12's "returns 429, then 200" fixture a unit test rather than a live-endpoint hand-run,
and §3.3 is why it is not optional: a module CI cannot drive in-process fails the coverage gate.
**`deliverAnnouncement` returns a `NotifyOutcome` and never returns `void`** — a void-returning
transport is one whose failure is indistinguishable from its success at the call site, which is the
silent swallow this console exists to catch.

**4. Auth reaches the actor as an environment variable NAME, never as a value in a tracked file.**
`notify.token_env` names a variable; the actor reads it from its own process environment at delivery
time and sends `Authorization: Bearer <value>` (`docs.ntfy.sh/publish/`: *"Use access tokens via
Bearer/Basic auth, e.g. `Authorization: Bearer tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2`"*). **This is the
fleet's existing mechanism, reused rather than invented**: it is `api_key_env`'s shape, and the guard
is already an exported function — `envVarNameIssue` (`src/config/schema.ts:672`), which
`ProviderSchema` and `llm.api_key_env` both call, and whose own refusal states the rule this field
needs verbatim: *"The value is read from the host environment under this name; it is never written in
config."* It rejects the reserved prefixes and the names the container's own environment depends on,
which is a guard §7.8 gets for free by calling it.

**Two rejected alternatives, each with the reason:**

- **A token in the URL** — `https://user:tk_…@host/Alerts`, or ntfy's documented `?auth=` query form.
  **Refused.** `triage/console.yaml` is *tracked*, so that is a credential in git history. It is also
  a credential in `~/.pifleet/triage-relay.log`, which appends and is never truncated (§7.7), and in
  `pifleet triage --status`, which prints the endpoint. §7.8 makes this a **refusal rather than
  advice**: the schema rejects an `endpoint` carrying userinfo or a query string, so the failure is a
  `config validate` error at the moment it is written rather than a secret discovered in a log later.
- **`secrets.env_allowlist`** — the fleet's other secret channel, and the wrong one. It is the
  **per-worker container** delivery path — `fleet.yaml:392-408`'s own comment calls it *"the only
  per-worker delivery channel"* — and it carries values into containers as files. The actor is a host
  process; it needs a *name*, not a delivery. Its scope discipline points the same way:
  `schema.ts:1332` says *"NEVER provider keys"*, and a notification credential is the same class of
  thing.

**A credential refusal is not a wedged endpoint, and must not be treated as one.** A `4xx` that is not
`429` — a rejected token, or the `400` ntfy returns for an oversized title — cannot be fixed by
sending the identical bytes again. It is `rejected`, it does **not** enter the backoff, and it raises
`reporter_undelivered` on the **first** occurrence rather than waiting for §6.8a's confirmation,
because a misconfiguration that looks like a transient outage is a misconfiguration nobody fixes.
(`docs.ntfy.sh` does not state which code an auth failure returns, so the rule is written on the
class — not-`429` `4xx` — rather than on a number this document cannot cite.)

**5. Egress: the actor runs on the host, so no `egress.allow` entry is required and none should be
added.** `src/security/egress.ts:4-6` is explicit about what that list governs: *"Workers sit on an
internal Docker network (`src/security/network.ts`), so the DEFAULT is that no destination is
reachable at all."* `pifleet triage` is not on that bridge; it is the same kind of host process
`pifleet relay` is. **This is a positive design property and not an accident**, and it is worth
stating as a rule rather than a fact: *the notification transport stays host-side.* Moving it into a
container would need an `egress.allow` entry, and — per the coincidence recorded above — it would
appear to work **without** one, through the IP rule written for oMLX, which is the worst possible
version of that change: a containment boundary crossed by a line nobody added.

**6. Retry, backoff, and why the ordering question dissolves.** Three outcome classes, and they are
not interchangeable:

| Outcome | When | What happens |
|---|---|---|
| `delivered` | 2xx | recorded with the timestamp. **`delivered` is not `acknowledged`** — a 200 is evidence the server accepted bytes, not that a human read them, and `--status` uses the first word. §6.7's gate on `healthy` is the same discipline applied to this console's own output |
| `retryable` | `429`, any `5xx`, a timeout, a refused connection | marked `undelivered` in the record with reason and timestamp. **No retry loop inside the pass** |
| `rejected` | any other non-2xx | as above, plus: no backoff, and `reporter_undelivered` fires immediately (requirement 4) |

**There is no retry loop, and the cadence is the backoff.** One attempt per notification per pass —
because a backoff loop inside a serial actor is the stall §6.5 spent a paragraph avoiding, and a
five-minute cadence is a longer and better backoff than any client library would choose, at a cost of
zero lines. Consecutive `retryable` outcomes double the wait in units of sweeps, from 1 to
`notify.max_retry_sweeps` (default 12, one hour at the 5-minute cadence).

**And the ordering question dissolves rather than being answered, because an undelivered notification
is never re-sent as itself.** A notification is a statement about a transition at a time; re-sending
it four hours later asserts a present tense that is no longer true, and *"`authorization` is
unhealthy"* arriving after it recovered is a worse message than none. So:

> **The backlog is carried as a count and a window, appended to the next message that does go out** —
> *"3 notifications were not delivered between 04:10 and 09:35"* — and the individual messages are
> retained in the record, visible in `pifleet triage --status`, and never replayed.

Nothing is reordered because nothing is requeued. **The one case this leaves open is closed by
§6.8a**: if the endpoint is down and nothing new fires, no message goes out to carry the backlog — so
`reporter_undelivered` is itself an incident, and the first thing delivered when the channel returns
is the statement that the reporter was down for N sweeps and M notifications were lost. §9.15.

**One note on `429` specifically.** ntfy's documented limiter is a 60-request burst refilling at one
per five seconds (`docs.ntfy.sh/publish/`), and this console's design target is single-digit messages
a day. **So a `429` from this endpoint is not a capacity problem — it is evidence that §6.8's
deduplication has broken**, and it is recorded as such rather than merely retried: a second,
independent check on the failure §6.8 exists to prevent, arriving from outside the process that would
be wrong about it.

**7. A failure of the webhook must never look like health. This is the rule, stated as a rule.**

> **The delivery result is an input to nothing.** The incident machine advances on *observations*
> only. A `NotifyOutcome` is written to the incident record's `undelivered[]` and to
> `reporter_undelivered`, and it is read by `--status` and by the next composition's backlog line. It
> **never** clears an incident, **never** completes a transition, **never** marks a sweep clean, and
> **never** decides whether the next sweep runs.

Three corollaries, because the rule is easy to agree with and easy to violate in code:

- **A transition is recorded before it is delivered, not after.** `firing → clear` is written on the
  observed evidence; whether anyone was told is a separate fact with a separate field. Coupling them
  would mean an unreachable endpoint silently re-opening a closed incident on the next sweep, and the
  console re-notifying the same recovery forever once it came back.
- **The absence of notifications is never evidence of health**, and `--status` must not be readable
  that way. It reports sweeps completed, incidents by state, and the undelivered count as three
  separate numbers, so *"quiet"* and *"could not speak"* are never the same row.
- **The channel is configuration, and its absence is not a startup failure.** `notify: null` disables
  it. A console with no notifier still sweeps, still drives both state machines, and still records
  every transition — it just cannot announce them, and `--status` says so. Refusing to start would
  make a diagnostic console depend on a webhook, which inverts which of the two is load-bearing.

#### What building §6.9 found in §6.9 — five corrections, recorded 2026-09-06

Task 5.6/5.6a implemented this section and read it against §12 line by line. Four of the five are
places where §12's acceptance criteria silently corrected this text; the fifth is a consequence this
section states nowhere and an operator would meet on their phone.

**1. Requirements 1 and §12 together push the evidence block OUT of the ntfy request.** Requirement 1
says worker prose appears *"only in a fenced, banner-marked evidence block that is **neither the title
nor the body**"*; §12's ntfy probe says `body` is *"the message text"*. Both cannot hold with the prose
in the body. Resolved by making `Announcement.evidence` its own field carried only by the `json`
adapter — **and the consequence belongs here rather than being left to be discovered**: the operator's
phone shows `evidence: <ref>` and never the log lines, so *"the reason the report is worth reading"*
does not reach the notification. Putting the fenced block back into the ntfy body is a legitimate later
choice; it requires changing §12's `body === message` probe, which is the tell that it is a design
change and not a fix.

**2. Requirement 2 under-specifies the bound, and §12 silently corrects it.** Requirement 2 specifies
`AbortSignal.timeout(notify.timeout_ms)` and nothing more. §12's fixture is a **transport** that never
resolves — and a signal handed to `fetch` bounds `fetch`, not a transport that never calls it. The bound
therefore has to be a race around the transport call **as well as** a signal on the request. The sharp
edge is worth writing down because it defeats the obvious implementation: `AbortSignal.abort()` never
emits `abort`, so a listener-only implementation **hangs on the exact fixture written to prove it cannot
hang**. Graded as ISC-682 and ISC-683, which are deliberately two criteria: a hard-coded bound satisfies
the first and fails the second.

**3. This section names three exports and the phase needs a fourth.** The sweep-unit backoff and the
backlog fit in none of `composeAnnouncement` (pure), `renderRequest` (pure) or `deliverAnnouncement`
(which §13 task 5.6a forbids from returning anything but a `NotifyOutcome`). `deliverySweep` was added.
Leaving it to the caller would have put the console's cadence rule inside task 6.1's loop, which is the
shape §12's *"no decision lives in `scripts/triage`"* is written against.

**4. The backlog sentence is illustrative and loses the date.** *"3 notifications were not delivered
between 04:10 and 09:35"* is ambiguous across a UTC day boundary, which a 12-sweep backoff can cross.
The implementation renders full ISO instants and asserts the line by exact value (ISC-687).

**5. §7.8's priority table gives four knobs and one reason, and the reason does not decide the
console-health recovery.** The stated reason — *"a recovery is not worth a long vibration burst at 3
a.m."* — is about recoveries, not about services, so `recovered` takes `priority.recover` for **both**
record kinds. All eight `(kind, transition)` pairs are asserted by value against a four-distinct-value
knob fixture, so reversing this decision is one line with a red test to show it.

**OPEN — the scope token, and it is a real fork rather than a detail.** §6.7 rule 3 gives a saturation
announcement **the environment** as its scope; §6.8a's table gives `inference_saturated` the record
scope **`_console`**. The implementation treats `Announcement.scope` as a display field and lets the two
differ, which is defensible and undecided. If they are meant to be the same token, one of those two
lines has to move. Deferred rather than resolved because it changes what an operator reads on a
notification, which is an operator's call.

**RESOLVED 2026-09-06 by task 6.1: `DeliveryState` stays in MEMORY.** It is threaded in as
`deps.delivery` and out as `outcome.delivery`. `undelivered[]` survives on §7.6's record, because an
operator must be able to see what was lost; **the countdown does not.** A restarted actor retries on
its next pass rather than continuing a twelve-sweep wait it can no longer justify — *the endpoint may
be what was restarted* — and a persisted wait would keep a healthy actor silent for an hour over an
outage that ended while it was down. The cost is one extra attempt per restart, which is the cheaper
of the two errors by a wide margin. Reasoning recorded on `TriagePassOutcome.delivery`'s docblock so a
later reader does not re-derive it.

**RULED 2026-09-06 on §6.8a's `budget_exhausted` clearing rule, which the table and the shipped code
disagreed about.** The table says it is *"cleared by … a new run — which in practice means a recycle
or a restart"*; `consoleHealthObservations` clears it on ANY sweep that ran, same run included. **The
code is right and the table is corrected to match.** A granted admission IS a positive observation —
it is the console watching itself succeed at the thing it was refused for — and §6.8's whole rule is
that a clear must be *observed*, which this is. What would be indefensible is a PASS that never asked
clearing it, and task 6.1 handles exactly that case: on the `budget_exhausted` and `skipped` exits the
pass supplies its own honest values with `environments: []`. On the skip path it reports
`budgetExhausted: false`, justified in its own code as *"a skip happens because a sweep the actor
already dispatched is still running, which is the presence of an admitted task rather than the absence
of a refusal"* — which is the same argument, and it holds.

**Not assigned anywhere: `DeliveryState` has no on-disk contract.** §7.6 puts `undelivered[]` on the
incident record, which task 5.5 validates. The delivery state — the backoff countdown, the consecutive
counters, the retained notes — lives in memory between sweeps and has no schema. That is correct while
the actor holds it in one process, and wrong the first time the actor restarts mid-backoff. No task in
§13 assigns it; task 6.1 is where the decision lands.

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

**The exposure this design does NOT bound, stated rather than discovered.** This console is the first
workload in this fleet that runs **unattended and continuously**, and the resource it consumes
continuously is not a vendor's — every seat resolves to `gpt-oss-20b-MXFP4-Q8` on `omlx`, which is
`hosted: false` (`fleet.yaml:118`) and is one process on the operator's own machine. **So there is no
bill to bound and there is a throughput to bound**, and the fleet has already written down which one
of those is scarce: `max_concurrent: 1  # bounded by oMLX throughput, not pane count`
(`fleet.yaml:77`). Four seats, one server, 288 sweeps a day. That is §6.7 rule 3's whole argument, and
it is why the saturation verdict exists: the honest statement of this console's cost is not money, it
is that **it is the first thing in this fleet that can starve the fleet's own inference server around
the clock**, and the console has to be able to say so about itself.

The one hard ceiling that does bind is `run.budget.tokens_ceiling: 6000000` (`fleet.yaml:79`), which
is **per run** (Finding C), and a triage console is one run — so the console has a hard lifetime
measured in tokens, after which `up`'s budget refuses admission and the run ends on exit 5. **Nothing
announces that today**, so this design makes it a notification: `budget_exhausted` is a console-health
issue on §6.8a's table, with §6.8a's identity and §6.8a's dedup, and the actor emits it on the way
down. §11 Q4 asks whether 6,000,000 is the right number for a console whose job is to keep running.

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
| `services[].window` | optional per-service override of `default_window`; **refused if greater than that environment's `default_window`** (§7.4, resolved 2026-09-06), and transitively therefore never greater than the cadence. An override may only NARROW. The cadence refusal (§6.10 rule 1) is still applied directly, so a file whose `default_window` is itself out of bounds names both faults by path |

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

**OPEN 2026-09-06, found while implementing task 5.1, and it blocked the actor rather than the
check.** This section fixes the document at `worker`/`title`/`brief` **and nothing else**, so a
`dispatch-request.json` carried **no machine-readable service list**. §6.3 step 5 nevertheless has the
actor *"validate the partition against the targets file"*, and §6.5 makes completeness the host's
question on the ground that *"a model that partitions can drop"*. There was no specified way for the
host to recover which services each request covered, short of parsing the brief's prose — which is
the one thing a check against a partitioning model must not depend on.

`src/run/triage-partition.ts` is therefore built over a partition VALUE and is correct as written;
what was unspecified was its caller. Three arms were weighed:

1. **A structured field on the request.** Cheapest to check, but it reopens §7.3's closed shape, and
   that shape is closed for a measured reason.
2. **A sidecar the worker writes beside the request**, leaving `pifleet.dispatchrequest/v1` untouched.
3. **The ACTOR assigns the services and the worker returns only an ordering.** This deletes the
   completeness question rather than answering it — the host cannot drop what it dealt itself — and
   costs §6.5's premise that the partition is the model's judgement.

**RESOLVED 2026-09-06 by the operator: arm 1.** The arms stand above as the record of what was
weighed; below is what was chosen, and what makes its cost affordable.

`pifleet.dispatchrequest/v1` grows exactly one field:

```jsonc
{
  "worker": "obs-t1",
  "title":  "...",
  "brief":  "...",
  "services": ["svc-a", "svc-b"]   // NEW
}
```

**Required on the triage console, refused on the review console, and the roster is the
discriminator.** Those two halves are one rule rather than a concession. A field merely *optional*
everywhere would make `partition_incomplete` unreachable by the cheapest failure available to a
model — omitting it — and an unreachable refusal is a check that passes because nothing asked.

| Console | `services` present | `services` absent |
|---|---|---|
| **triage** | validated against `triage/targets.yaml` (§6.5) | refused, `services_missing` |
| **review** | refused, `services_not_permitted` | unchanged — exactly today's shape |

The review row is §7.3's own promise — *"refused whole, with the field named"* — **spent on the new
field rather than weakened by it**. No review request changes behaviour, and that is what reduces
this arm's cost from "a console" to "a schema line".

**No caller grows a parameter.** `resolveRoster` already defaults to `REVIEW_CONSOLE_ROSTER` and
`TRIAGE_CONSOLE_ROSTER` is spelled beside it (`dispatch-request.ts:298,340`), so the console identity
is *already* threaded to the check; `ConsoleRoster` carries the discriminator and the refinement
reads it. §10 D5's bet survives — a third console is still a third constant.

> **CORRECTED 2026-09-06 while implementing 5.1a.** This sentence said *"`ConsoleRoster` gains the
> NAME"*. It gains the **rule** instead — `services: "required" | "refused"` — and the deviation is
> accepted, because the engineer's two reasons beat mine. `ConsoleSpec.name` already exists at
> `relay.ts:280` as the `--console` value, and a second spelling of one console's name, constructible
> to disagree with the first, is the precise hazard that interface's docblock spends its length on.
> A name field would also put the literal `"triage"` inside the check, which is the shape
> `ConsoleRoster`'s own docblock exists to refuse. **Carrying the rule keeps this section's survival
> claim literally true** — a third console is a third constant, with no table, no union and no edit
> to `dispatch-request.ts`.

**AND ONE COST THIS SECTION MISSED, found the same day and owned here.** The paragraph above reasons
that keeping the tag at `v1` avoids *"an edit to `roles/collator.md:81-91` — a model-facing prompt
with no test"*. That is right about the TAG and wrong about the consequence: **the field obliges a
prompt edit regardless of the tag.** `roles/triage.md:115-130` still shows a request with no
`services` key and still says *"`worker`, `title` and `brief`, and **nothing else**"*, so the live
worker writes a document this schema refuses `services_missing` on the first sweep. Phase 5 is
host-side and CI cannot see it. Task 5.1b.

**Two refusal codes join the alphabet**, by the rule §6.5 already set for the first two: they are
spelled in `dispatch-request.ts` because that is the vocabulary of the request plane, whichever
module spends them.

- `services_missing` — a triage request with no service list. The model dropped the field itself,
  which is the failure §6.5 predicted one level up.
- `services_not_permitted` — a service list on a console with no targets file to check it against.

**The wire tag stays `v1`, and that is a decision rather than an oversight.** The tag exists so a
reader can refuse a shape it does not know; a v1 reader meeting a triage request refuses it on
`services_not_permitted` regardless, so a bump buys no refusal that is not already there. It would
cost an edit to `roles/collator.md:81-91` — a model-facing prompt with no test — and there is one
binary and one fleet, with every request consumed inside the sweep that wrote it. **No request
outlives a version**, so there is nothing for a version to protect.

**What this unblocks:** the actor reads the sweep's requests, projects `services` out of them, and
hands the projection to `checkTriagePartition` — which needs no change and gets its production caller
in Phase 6. §6.5's premise survives intact: the partition is still the model's judgement, and the
host still checks it.

### 7.4 `observer-ops.json` — existing, plus three required fields

The artifact pair is `skills/observer-ops/SKILL.md:26-33`'s and the rule that a run writing only the
`.md` clamps to `failed` is inherited. This console requires three additions:

- **`sweep_id`** — echoed from the envelope. §6.6 layer 3. An artifact whose value is not the
  dispatched one is `stale_replay` and the row is not counted.
- **`window_opened_at`** — an ISO-8601 UTC instant, the moment the observer's queries start looking
  back from. §6.6 layer 3's *other* half. **RESOLVED 2026-09-06 by the operator: grow the field
  rather than strike the clause.** See below.
- **a row per service**, each carrying `assessment`, `coverage[]`, the selector, the window, and the
  evidence ledger. SRD-OBSERVER-001 §12 D12 already forbids one verdict over a batch; §6.7's
  structural gate is what reads these.

**Why `window_opened_at` is a THIRD field rather than a duplicate of the second.** The two echoes
catch different lies and neither implies the other. `sweep_id` proves the observer ran *this* sweep;
`window_opened_at` proves it looked at *the right stretch of time*. An observer can echo the correct
sweep id, name a window in every row, and have queried six hours against a five-minute configuration
— **reporting stale data as fresh, which is the exact failure layer 3 exists to prevent.** The
row-level `window` field does not cover it either: §6.7's gate tests that a window was NAMED, not that
it was opened when it should have been.

**The bound needs no new knob**, which is what makes this affordable. The host dispatched the sweep at
a known instant and the configuration already holds the two values that fix the legal range —
**though they live in two different files, corrected 2026-09-06**: `reserve_s` is §7.8's
(`triage/console.yaml`), and `default_window` is **§7.1's** (`environments.<env>.default_window` in
`triage/targets.yaml`). This sentence named §7.8 for both. It costs nothing structurally — §7.8's
`default_window ≤ cadence_s` refusal already requires one loader to hold both, and states that it
*"spans two files and therefore lives in neither schema"* — but it sent a reader to the wrong file for
half of the bound.

| condition | verdict |
|---|---|
| absent | refused |
| earlier than `dispatched_at − default_window − reserve_s` | refused — the observer looked further back than configured |
| later than `dispatched_at` | refused — a window that opens in the future is not a window |
| otherwise | accepted |

**It is an ARTIFACT-level check, so it discards the artifact rather than gapping a row**, exactly as
`stale_replay` does and for the same reason: a wrong window applies to every row the document
carries. It spends its own reason, `stale_window`, because the operator response differs — a stale
sweep id is a worker replaying an old answer, and a wrong window is a worker answering the wrong
question. Shaped as a `windowEcho` beside `sweepIdEcho`, three states for the refusal's two, so a log
can say which of `absent` and `out_of_range` occurred.

**RESOLVED 2026-09-06 by the operator: refuse `window > default_window` in §7.1's schema, so this
table is correct exactly as written.** The conflict found while implementing this check was that
§7.1 made `services[].window` an override with **nothing bounding it above**, while this table bounds
the check by `default_window` alone — so an observer holding a service with a WIDER override echoed a
`window_opened_at` that was truthful and out of range, and because the check is artifact-level that
discarded **every row that observer produced**, including rows for services carrying no override at
all.

The band was narrower than it first looked: only `default_window < window ≤ cadence_s` fails, and at
shipped defaults (`default_window: 5m`, `cadence_s: 300`) that band is **empty**, which is why it
survived until the echo was built. Three resolutions were available and two were refused.

- **Bound this check by the widest override in the observer's share — REFUSED.** It makes the check as
  weak as the loosest service that observer happens to hold: one service with a six-hour override
  gives every service in that share a six-hour band, which is precisely the *"queried six hours
  against a five-minute configuration"* failure this section exists to catch. It would leave the check
  in place and quietly stop it working.
- **Move the check per-row — REFUSED for now**, on the paragraph above.
- **Refuse `window > default_window` — ADOPTED.** One clause in `windowIssues`
  (`src/run/triage-targets.ts`), a function that already carried §6.10 rule 1's cadence refusal for
  the same field. It is a schema tightening, so the only configurations it can refuse are ones that
  would otherwise have caused silent artifact-wide discards, and the operator learns at
  `pifleet config validate` rather than by losing a sweep's rows.

**What it narrows, stated rather than buried.** A genuinely sparse service can no longer be given a
window wider than its environment's default. If that need arrives, the answer is to move
`window_opened_at` onto the **row**, beside the `window` field §6.7 already gates — and the argument
above against a per-row check holds only while there is one window per artifact, so it stops applying
at exactly the moment you would need to.

**Available strengthening, not taken.** §7.2:1784 has the host sending `window_opened_at` in the
envelope. If the host dictates the exact instant, an EQUALITY check is available and is strictly
stronger than this range, which admits a worker that ignored the instant it was given and picked
another one inside the band. The range is what this table says, so the range is what was built.

### 7.5 `triage.json` — new

> **A SECOND GAP in `roles/triage.md`, found while implementing task 5.5a and fixed the same day as
> task 5.1c — and this one FAILED OPEN.** The worked example at `roles/triage.md:288-317` disagreed
> with this contract in three places: `coverage[]` held channel NAMES rather than `{channel, result}`
> entries, `evidence_ref` was a single string rather than a ledger array, and `unaccounted[]` held
> objects rather than service names. Two of the three would have refused the sweep. **The third was
> silent and inverted the evidence gate**: `attempted(entry)` is `entry.result !== "not_attempted"`,
> a string entry has no `result`, and `undefined !== "not_attempted"` is `true` — so every channel
> NAME counted as an attempted channel, §6.7 rule 2's first condition could never fail, and a row
> carrying no evidence at all passed the gate built to catch exactly that.
>
> **Task 5.1b fixed the request example in the same file and did not look at the rest of it.** That
> is the orchestrator's miss and the lesson generalises past this document: a schema change obliges
> an audit of every worked example a container reads, not of the one that prompted the change.
> `test/unit/triage-document.test.ts` now parses this example through the real schema and asserts
> the three shapes on the PARSED value, so a later relaxation cannot re-open the silent one.

> **GAP found while implementing task 5.3, 2026-09-06: nothing validates this document.** §7.6's
> per-service records are *"Zod-validated on read, so a malformed record refuses rather than being
> acted on"*; this contract has no schema, and no task in §13 assigns it one — task 5.5 covers the
> **incident** record, which is §7.6. So between the file a container wrote and `assessTriageSweep`,
> which takes an already-typed value, **there is currently no validator at all**. The asymmetry is
> the wrong way round: §7.6 is written by the host and §7.5 is written by a worker, and it is the
> untrusted one that is unchecked. Task 5.5a.

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

`~/.pifleet/triage/<env>/<service>.json`. **`subject`**, `state`, **`reason`**, `since`,
`last_seen`, `sweep_count`, `consecutive_indeterminate`, `flap_transitions[]` (timestamps inside
`flap_window`), `last_notified_at`, `undelivered[]`, and `last_artifact_ref`. Zod-validated on read,
so a malformed record refuses rather than being acted on — SRD-FLEET-PM-001 Phase 5 task 5.4's rule.

> **CORRECTED 2026-09-06 while implementing task 5.5: this list omitted `subject` and `reason`**,
> both of which `IncidentRecord` has carried since round 7 and both of which are load-bearing.
> `subject` is what `advanceIncident` compares to refuse a foreign observation; `reason` is what the
> recovery notification names. The list grew rather than the record shrinking — the code was right
> and the contract was short, which is the direction that costs nothing to fix and would have cost a
> schema had it been resolved the other way.

**§6.8a's console-health records are the SECOND kind and share this file layout**, keyed under a
`_console` subject rather than a service. They cannot collide: `SESSION_ID_RE` requires an
alphanumeric first character, so no environment or service can be named `_console` and the two
layouts are unrepresentable as the same path — prevented rather than merely unlikely.

### 7.7 The actor record — new, and deliberately the relay's shape

`~/.pifleet/triage-relay.json` (`pid`, `started`, `runs`, `workers`, `cadence_s`, `sweep_cursor`,
`consecutive_skips`) — **`runs` is a per-seat MAP of worker id to run id, not a single `run_id`;
see §6.1's correction and §6.6 layer 4's resolution** —, `~/.pifleet/triage-relay.log` appended never truncated, `~/.pifleet/triage-relay.lock`.

**Three corrections to this section, all found by building it (task 6.3, 2026-09-06).**

**1. The filenames were wrong and are corrected above.** This section originally named
`~/.pifleet/triage.json`, `.log` and `.lock`. §6.4 is the operative sentence and says something else —
*"`relayRecordPath`/`relayLogPath`/`relayLockPath` gain a console argument"* — and Phase 2.3 built
exactly that: `consoleStem()` makes the console name a filename stem, so the shipped paths are
`triage-relay.{json,log,lock}`, which is also what `Workflows/Consoles.md` produces. The shipped names
win, and not on seniority: **§12's own actor probe is phrased over those three functions, so a second
spelling means `--actor-stop` signals nobody.** Every occurrence in this document was corrected, not
just this one.

**2. `triage.json` named two different contracts.** §7.5's is the WORKER's artifact at
`/outbox/<collate-task-id>/files/triage.json`; this section's was the ACTOR's record. No path
collision — different roots — but §6.3's lifecycle table used both spellings within four lines of each
other. Correction 1 fixes this for free, and the worker's artifact keeps the name.

**3. `run_id` and `runs` are BOTH kept, and their relationship is pinned.** §6.6 layer 4's resolution
says *"§7.7's `run_id` is wrong and becomes `runs`"*, but Phase 2.3 shipped `RelayRecordSchema.run_id`
and `servesConsole` compares it — so deleting it makes every triage record **unadoptable by the
fleet's own reader**, which answers `unreadable`, and that verdict never licenses a signal. The
settled reading: `run_id` is **derived** from `runs["tri-1"]`, and a record whose two fields disagree
is refused by the schema. "The record has two answers to which run" is therefore unrepresentable
rather than merely discouraged. Keeping `pifleet.consolerelay/v1` as the schema tag is load-bearing
for the same reason — a private literal makes a triage actor unstoppable by `readRelayStatus`.
`Workflows/Consoles.md:64-66`'s convention, copied rather than invented — including the behaviour it
names for a record it cannot verify: *"left exactly where it is and nothing is signalled."*

### 7.8 `triage/console.yaml` — new, tracked, and the home nine knobs did not have

**This contract exists because a review of the draft found that it did not.** §6.9 said the endpoint
lived *"in the console's own config"* and no such config was specified anywhere; §7.1-§7.7 hold seven
contracts and none of them is it. Meanwhile §6 names **nine** tuning values with defaults —
`cadence_s`, `reserve_s`, `max_consecutive_skips`, `recycle_after_sweeps`, `flap_threshold`,
`flap_window`, `renotify_after`, `sweep_deadline_s` and now `notify` — and every one of them was
homeless. A default with no contract is a default that becomes a literal in whichever module reads it
first, which is the shape §12's *"no decision lives in `scripts/triage`"* criterion is written against.

`pifleet.triageconsole/v1`. Zod-validated in `src/run/triage-config.ts`, refused on any violation,
and validated by `pifleet config validate` in the same pass as `fleet.yaml` and `triage/targets.yaml`.

**Why a third tracked file rather than any of the four cheaper answers:**

| Home | Why not |
|---|---|
| **`fleet.yaml`** | §6.2's three reasons, unchanged and all still binding: `FleetConfigSchema` is `.strict()` with thirteen keys (`schema.ts:1486-1502`), so a `triage:` key is a schema change to the fleet's own contract for data that is not fleet configuration; it changes on a different clock than roles and models; and **it is gitignored** (`.gitignore:9`), so a notification endpoint written there is untracked, undiffable and undispatchable |
| **A CLI flag** | **This is the arm to reject loudest, because it is the one that looks reasonable.** §6.2 already refused argv as the inventory mechanism — *"288 invocations a day against a list nobody can review. An inventory in argv is an inventory with no history."* Every word of that applies here and one more besides: the endpoint is the console's **output destination**, so an endpoint in argv is a console whose entire product is decided by a shell line nobody reviewed, changed by editing a script that `bun run typecheck` does not read (§3.3). `--cadence` survives as an **override** for a hand-run, and an override with a home is a different thing from a value with no home |
| **Merged into `triage/targets.yaml`** | Tempting — one file is cheaper than two, and §10 D4 already books the cost of a second one. Refused on **blast radius**: the targets file is the one an operator edits *often* (§6.2 property 1, *"Adding an environment or a service is a YAML edit and nothing else"*), and this file holds the two values whose accidental edit costs the most — the cadence and the endpoint. Different edit frequency, different file. It is §6.2's own argument applied one level down, and it costs nothing extra, because both files are validated in the same `config validate` pass |
| **`~/.pifleet/triage-relay.json`** | That is the actor's **record** (§7.7), written by the actor, and D12 makes the run tree authoritative over it. Configuration an operator writes and state a process writes must not share a file, or a crashed actor rewrites the cadence |

**The schema**, and it is written out because three of its properties are load-bearing rather than
decorative:

```ts
// src/run/triage-config.ts
export const TRIAGE_CONSOLE_SCHEMA = "pifleet.triageconsole/v1";

/** ntfy priority: "1=min, 3=default and 5=max" — docs.ntfy.sh/publish/. */
const NtfyPriority = z.number().int().min(1).max(5);

export const NotifyConfigSchema = z
  .object({
    /** The URL POSTed to, VERBATIM. For ntfy the topic is this path. */
    endpoint: z.string().url().superRefine(notifyEndpointIssue),
    adapter: z.enum(["ntfy", "json"]).default("ntfy"),
    /** AbortSignal.timeout(). §6.9 requirement 2. */
    timeout_ms: z.number().int().min(1_000).max(30_000).default(5_000),
    /** A NAME. The value is read from the host environment; never written here. */
    token_env: envVarName("notify.token_env").nullable().default(null),
    /** The backoff cap, in sweeps. §6.9 requirement 6. */
    max_retry_sweeps: z.number().int().min(1).max(288).default(12),
    priority: z
      .object({
        open: NtfyPriority.default(4),
        recover: NtfyPriority.default(3),
        flapping: NtfyPriority.default(3),
        console_health: NtfyPriority.default(4),
      })
      .strict()
      .default({}),
  })
  .strict();

export const TriageConsoleConfigSchema = z
  .object({
    version: z.literal(1),
    cadence_s: z.number().int().min(60).max(3_600).default(300),
    reserve_s: z.number().int().min(15).max(600).default(60),
    max_consecutive_skips: z.number().int().min(1).max(24).default(3),
    recycle_after_sweeps: z.number().int().min(0).max(1_000).default(48),
    flap_threshold: z.number().int().min(2).max(20).default(3),
    flap_window_s: z.number().int().min(300).max(86_400).default(3_600),
    renotify_after_s: z.number().int().min(0).max(604_800).default(21_600),
    /** `null` DISABLES. Absent takes the default below. §6.9 requirement 7. */
    notify: NotifyConfigSchema.nullable().default(DEFAULT_NOTIFY),
  })
  .strict()
  .superRefine(reserveFitsCadence);

export const DEFAULT_NOTIFY = {
  endpoint: "https://ntfy.agileguy.ca/Alerts",
  // …the field defaults above.
};

/** COMPUTED, never configured. §6.5 derives it; this is where that becomes true. */
export function sweepDeadlineS(cfg: TriageConsoleConfig): number {
  return cfg.cadence_s - cfg.reserve_s;
}
```

**The three properties that are doing work:**

**1. `sweep_deadline_s` is absent from the schema on purpose, and `.strict()` is what enforces it.**
§6.5 derives it as `cadence_s − reserve_s` and refuses a configuration where
`sweep_deadline_s ≥ cadence_s`. Making it a field would mean carrying a value that must always equal
a function of two others — and a redundant field is a field that will one day disagree. So it is
computed, writing it is a **field-level error** on `fleet.yaml`'s own rule (`schema.ts:4-7`: an
unknown key is a field-level error, never an ignored typo), and the operator who wants a shorter deadline raises
`reserve_s`. **§6.5's refusal then becomes unreachable rather than merely checked**, because
`reserve_s.min(15)` and `cadence_s.min(60)` make `sweep_deadline_s ≥ cadence_s` impossible to
construct. A refusal you cannot reach is better than a refusal you have to remember to test, and it
is the reason the bound on `reserve_s` is a bound and not a comment.

**2. `token_env` calls the fleet's existing guard rather than restating it.** `envVarName` wraps
`envVarNameIssue` (`src/config/schema.ts:672`) — the same exported function `ProviderSchema` and
`llm.api_key_env` both call, written as a function for exactly this reason: its docblock records that
*"an inline copy of these checks on the flat field only would have left the per-provider one bare"*,
and a third door into the same namespace would be the same mistake a third time. It brings the
reserved-prefix and reserved-name refusals with it for free.

**3. `notifyEndpointIssue` refuses a credential rather than discouraging one.** Three rules, and each
one is a thing that would otherwise become a secret in a tracked file, an appended-forever log
(`~/.pifleet/triage-relay.log`, §7.7) and `--status` output:

- the scheme must be `http:` or `https:`;
- **`url.username` and `url.password` must be empty** — no `https://user:tk_…@host/Alerts`;
- **`url.search` must be empty** — which specifically refuses ntfy's own documented `?auth=` form
  (`docs.ntfy.sh/publish/`), and refuses it *because* it is documented: an operator who finds that
  page will reach for it, and the schema is the only place that can catch them before git does.

**The fields, with what each is for:**

| Field | Default | Note |
|---|---|---|
| `version` | — | literal `1` |
| `cadence_s` | `300` | §6.4's tick. `--cadence` overrides it for a hand-run and does not persist |
| `reserve_s` | `60` | the margin `sweep_deadline_s` is derived against. §6.5 |
| `max_consecutive_skips` | `3` | fifteen minutes of not sweeping. Raises `sweeps_skipped` (§6.8a) |
| `recycle_after_sweeps` | `48` | four hours. `0` disables — the setting for measuring Q5, and §6.6 records that leaving it there is a decision rather than a default |
| `flap_threshold` | `3` | §6.8 |
| `flap_window_s` | `3600` | §6.8 |
| `renotify_after_s` | `21600` | six hours. `0` disables. **The knob that undoes the design if it is set small** — §6.8 and §8 both say so, and the schema's `min(0)`/`max(604800)` bound it but cannot protect it |
| `notify` | the ntfy block | `null` disables the channel without disabling the console. §6.9 requirement 7 |
| `notify.endpoint` | `https://ntfy.agileguy.ca/Alerts` | checked 2026-09-06 — §6.9's table. POSTed verbatim; the topic is the path |
| `notify.adapter` | `ntfy` | closed enum, `["ntfy", "json"]`. §6.9 |
| `notify.timeout_ms` | `5000` | `AbortSignal.timeout()`. §6.9 requirement 2 |
| `notify.token_env` | `null` | **the default endpoint refused an anonymous read with `403`, so this will need setting** — §6.9's table and §11 Q11 |
| `notify.max_retry_sweeps` | `12` | one hour at the default cadence. §6.9 requirement 6 |
| `notify.priority.*` | `4/3/3/4` | ntfy's 1–5 scale. `open` and `console_health` are `high`; a recovery is not worth a long vibration burst at 3 a.m. |

**Loading, and it obeys §3.3 rather than being an exception to it.** The parse is pure —
`parseTriageConsoleConfig(text: string)` — and the I/O is one injected dep, the house pattern named as
a type: `export type TriageConfigRead = (path: string) => Promise<string | null>`, taken through an
optional ports object with a real default, exactly as `DockerPsRun` is
(`src/monitor/read/docker.ts:122`, `:209-214`). **A missing file is not an error**: it resolves to the
schema's defaults, which is what makes the default endpoint the default rather than a thing an
operator must type. An unparseable or invalid file **is** an error and the actor refuses to start,
because a console running on half a config is a console whose cadence nobody knows.

**One check spans two files and therefore lives in neither schema.** §7.1's `default_window` must not
exceed `cadence_s`, which is in this file. So the cross-file refusal belongs to the loader that holds
both — the same place §6.10's kubeconfig-subset fence lives — and it is refused at load with both
file names in the message. A refusal that names one file when two disagree sends the operator to
the wrong editor.

---

## 8. The `/fleet` skill changes

`~/.claude/skills/fleet/` is a symlink into `~/repos/cmux-fleet/.claude/skills/fleet/`
(`SKILL.md:12-21`), so these are tracked edits in this repository.

- **`SKILL.md`'s fleet table gains four rows** — `tri-1` (triage, triage console, `base`) and
  `obs-t1`/`obs-t2`/`obs-t3` (observer, triage console, `base`) — and its frontmatter `description`
  gains the four worker ids and the word "triage", since routing is keyed on names.
- **`Workflows/Consoles.md` becomes four consoles.** Its table gains a row, and the *"The review
  console has a fifth process"* section gains a sibling: the triage console has one too, it is both
  the clock and the actor, and `~/.pifleet/triage-relay.json` names the run it serves.
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
| 9.8 | The notify endpoint refuses, times out or rate-limits | the outcome is `retryable`; the notification is marked `undelivered` with reason and timestamp and is **never re-sent as itself**; the backoff doubles in sweeps to `max_retry_sweeps` | the next successful delivery names the backlog as a count and a window; `--status` shows it. §6.9 requirement 6. A `429` is additionally recorded as evidence §6.8's dedup has broken, because this console's volume is nowhere near ntfy's documented limiter |
| 9.9 | The run's token ceiling is reached | admission is refused, exit 5, the console stops sweeping | notified on the way down (§6.10). **Silent today, and that is the defect this row exists to close** |
| 9.10 | A pane is restarted by hand | the actor's pin is invalidated | the actor is stopped before and started after, as `scripts/review` does — and it is a `quiesce` dep so the settle-wait refusal stays honest (ISC-572). Note the pin **decays** rather than sticking (`relay.ts:2915-2954`), so a seat that returns in a new run is found rather than waited for forever |
| 9.11 | A recycle is due while a sweep is in flight | the recycle waits; nothing is torn down | the next boundary. §6.6 layer 4 |
| 9.12 | The sweep counter resets across a recycle | every task id collides with one the epoch fence saw in a previous run | prevented, not recovered: §12's anti-criterion. The symptom would be intermittent and would read as a dispatch bug |
| 9.13 | A copy-paste actor claims `review-relay.lock` | the review console silently stops fanning out | prevented by Phase 2.3's per-console paths, and asserted in §12 |
| 9.14 | A pass throws | logged to stderr; the loop continues | `relay.ts:700-723`. **`--once` propagates instead**, because a single pass is somebody's command |
| 9.15 | **The thing that cannot be reported IS the reporter** | see below — this row has a section rather than a cell | |
| 9.16 | The inference server is slow, not down | ≥2 observers produce no artifact in one sweep; the sweep is marked **saturated**, `consecutive_indeterminate` does not advance, and the announcement names the provider and model | §6.7 rule 3. **Without this row the console reports a coverage gap and points the operator at their cluster**, which is the wrong finger at the worst moment |
| 9.17 | The endpoint answers `4xx` other than `429` — a rejected token, or a title over ntfy's 1 KB header limit | the outcome is `rejected`, **not** `retryable`: no backoff, and `reporter_undelivered` fires on the **first** occurrence | §6.9 requirement 4. Resending identical bytes cannot fix either cause, and a misconfiguration wearing the costume of a transient outage is a misconfiguration nobody fixes |
| 9.18 | The delivery fails and the console reads it as health | **prevented, not recovered.** §6.9 requirement 7: the delivery result is an input to nothing. A transition is recorded on the observation, before and independently of whether anyone was told | §12's anti-criterion. The failure it prevents is an unreachable endpoint silently re-opening a closed incident every sweep |

#### 9.15 — when the reporter is the thing that failed

**§6.9's `undelivered[]` covers the record of a lost message. It does not cover the case where the
component that cannot report is the reporting component**, and that case has a property none of the
other fourteen rows have: **it cannot use the channel to say so.** Every other failure in this table
is announced through the notifier; this one is the notifier.

So it gets four mechanisms, in the order they become available, and the ordering is the design:

1. **The record, immediately.** `reporter_undelivered` is a `_console`-scoped console-health incident
   (§6.8a) with §6.8's state machine and §6.8's dedup — so a channel down for a day is one incident
   with a sweep count, not 288 records. It enters `firing` on the first `rejected` outcome
   (§6.9 requirement 4) and on the second consecutive `retryable` one.
2. **The log, immediately.** `~/.pifleet/triage-relay.log`, which appends and is never truncated (§7.7).
   This is the only surface that is guaranteed to work, because it is a file on the machine the actor
   is already running on.
3. **`pifleet triage --status`, on demand.** It reports the channel state, the undelivered count, and
   the window — as fields distinct from the sweep count, so that *"quiet"* and *"could not speak"*
   are never the same number (§6.9 requirement 7).
4. **The channel itself, when it returns.** The `firing → clear` transition for
   `reporter_undelivered` composes a notification and **that notification is delivered first**, ahead
   of the sweep's own. It is the only message in this design whose subject is the console's own
   silence: *the reporter was unable to deliver for N sweeps between T1 and T2, and M notifications
   were lost.*

**The property that makes this honest rather than decorative**, and it is the one worth writing a
criterion against: **the console must never be quieter about its own failure than about a service's.**
A design that logged this and stopped would have the console's most serious failure be its least
visible one, which is precisely the shape §6.7's structural gate on `healthy` exists to refuse —
applied, as it should be, to the console rather than to the cluster.

**And the boundary, stated so nobody mistakes this for a solved problem.** If the actor is dead, none
of the four mechanisms fire, because all four are the actor's. **This console cannot report its own
death**, and no arrangement of its own components can change that — the observer would have to be
outside it. That is what §11 Q7 is really asking, and it is recorded here rather than in a row
because it is a limit rather than a failure mode: the honest statement is that the operator's
detector for a dead triage console is the absence of the sweeps they expected, and this document does
not have a better one to offer.

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
| **D10** | **SETTLED** — the notification channel is a **configurable webhook**, defaulting to `https://ntfy.agileguy.ca/Alerts`, composed host-side from typed fields only, rendered by a closed-enum adapter, bounded by `AbortSignal.timeout`, through an injected transport. Rejected: the PAI voice server; `backend.notify()`; a session; a body template in config | §6.9, §11 Q2 |
| **D11** | `cloud.kubeconfig` becomes a **requirement** for this console, and the targets file must be a subset of it | §6.10 |
| **D12** | The run tree is authoritative; `~/.pifleet/triage-relay.json` is a cursor | §6.4 |
| **D13** | Console-health issues get a **`(scope, kind)` identity** over a closed `kind` enum and **reuse §6.8's state machine unchanged**. Rejected: a second machine; per-sweep emission | §6.8a |
| **D14** | The console's nine knobs and the webhook live in a **third tracked file**, `triage/console.yaml`, with `sweep_deadline_s` **computed rather than configured**. Rejected: `fleet.yaml`; a CLI flag; merging into `targets.yaml`; the actor's record | §7.8 |
| **D15** | **Endpoint saturation is its own verdict**, evaluated before the coverage escalation and **suppressing** it, with the provider as the announcement's subject | §6.7 rule 3, §9.16 |

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

**SETTLED 2026-09-06 by the owner: arm 3.** All four seats — `tri-1` and the three observers — run
the local `gpt-oss-20b-MXFP4-Q8`. §0.2 has the argument; this records the outcome and its price.

**What the change costs, stated as this section's convention requires. The cost is quality on the
one task this console has that most wants a bigger model**, and it is worth naming precisely rather
than waving at: SRD-OBSERVER-001 §6.2 argues the reconciliation turn is where the budget pays, and
the reconciliation turn is exactly what `tri-1` does. A 20B model reconciling three observers'
`triage.json` fragments will be worse at it than a 120B one, and the failure will not look like a
model failure — it will look like a noisy console. §6.7's structural gates are the mitigation and
they are not a substitute: they downgrade an unevidenced `healthy` and they refuse a partial
partition, but nothing in them makes a weak reconciliation strong. **§11 Q4's day-long run is where
this cost becomes measurable**, and if the console is noisy, this decision is the first thing to
re-examine rather than the last.

**What it buys, and why the document does not treat the cost as regrettable.** The exposure this arm
refuses is not hypothetical: an observer's context is namespaces, workload names, pod names, restart
counts, log lines and cluster endpoints from a live environment, 288 times a day, and §5.9 records
that *"there is no ceiling, timeout or scope that reduces a transcript after it has been sent."*
This document's own draft reading preferred arm 2. **The owner took the stricter arm, and it is the
only one of the three that reverses no recorded decision and widens no boundary** — so `Docs/SRD.md`
§5.9 is untouched, `fleet.yaml:471-475`'s comment stands as written, and §0.3's disclosure gate has
nothing new to cover.

### D10 — the notification channel

**SETTLED, and the settlement is a shape rather than a URL.** The channel is a webhook whose endpoint
is configuration (§7.8), and `https://ntfy.agileguy.ca/Alerts` is its default — checked on
2026-09-06 rather than assumed, because §14's closing rule makes an unverified default the same class
of defect as an unverified citation. The commission's spelling, `agleguy.ca`, is **NXDOMAIN**; the
corrected name resolves, its `/v1/health` answers `200`, and its `Alerts` topic refuses an anonymous
read with `403` — which is how the credential field stopped being scaffolding.

**What the change costs, stated as this section's convention requires.** **The cost is that the
console's output now depends on a network, a DNS name and a third-party CDN**, where the withdrawn
design depended on a loopback socket. That is a real regression in one dimension and the trade is
made deliberately: a loopback notifier can only reach an operator who is sitting at the machine, and
this is a console built for the hours when nobody is. §6.9's undelivered path, §6.8a's
`reporter_undelivered` identity and §9.15's four mechanisms are what buy the trade back, and none of
them would have been written for a channel that could not fail.

**What is not open under any arm, and did not change when the channel did:** the message is composed
host-side from typed fields through a pure function; worker prose never reaches the title or the body
(§4.3, §12.6); an undelivered notification is retained and never replayed as itself; and **a delivery
failure is an input to nothing** (§6.9 requirement 7). Those hold for the ntfy adapter, for the
generic `json` one, and for whatever the operator points `notify.endpoint` at next.

---

## 11. Open questions

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | **ANSWERED 2026-09-06 by the owner: arm 3 — all four seats on the local `gpt-oss-20b-MXFP4-Q8`.** The original question — which seats run `ollama-cloud/gpt-oss:120b`? — is answered *none*, so the recorded 2026-09-03 decision at `fleet.yaml:471-475` and `Docs/SRD.md` §5.9 stands rather than being amended. §0.2 keeps the three arms and the argument undeleted | Settled by decision, and the probe it named is **moot rather than skipped**: the latency measurement existed only to protect an allowlisting that is no longer happening, so §13 task 0.3 is closed for want of a subject, not for want of a measurement | **Nothing.** Phase 1 can write its `model:` line, and it writes the role's existing one |
| **Q2** | **ANSWERED 2026-09-06 by the owner: a configurable webhook, defaulting to ntfy.** The original question — is *"a notification via claude"* the PAI notify endpoint, a Claude Code session, a chat channel, or a ticket? — is superseded rather than picked between: the endpoint is a config field (§7.8), and the readings that are not endpoints (a session, `backend.notify()`) are refused in §6.9 on grounds that do not depend on the answer. The draft's `localhost:8888` pick is **withdrawn**, and §6.9 records why the loopback arm was the wrong shape as well as the wrong host | Settled. The one thing the answer changed and a probe could not: the spelling. `agleguy.ca` is **NXDOMAIN**; `ntfy.agileguy.ca` resolves, is healthy, and refuses anonymous reads — all three measured 2026-09-06 and recorded in §6.9 | **Nothing.** §13 Phase 5 is unblocked; the incident machine was channel-agnostic by construction and stayed that way |
| **Q3** | What should `run.max_concurrent` be? It is `1` (`fleet.yaml:77`) and this is the first console that puts several workers in one run, so it is the first place the value binds. Three observers serialised will not fit a five-minute cadence | Time one observer pass against a real environment, ×3, and compare with the cadence. **And check the cheap half first:** raising it binds only runs holding more than one worker, so confirm by inspection that no other console has such a run before treating the change as fleet-wide | **Nothing structurally.** It decides whether the default cadence is 5 minutes or something longer |
| **Q4** | Is `tokens_ceiling: 6000000` right for a run that is meant to live for days? Finding C: it is per run, it is the only spend gate that exists, and it ends the console on exit 5 when reached | Run the console for a day and measure the spend per sweep, then divide. **Cheap and it must be done before the console is left running unattended**, because the current answer is "unknown, and the failure is silent" | **Nothing structurally.** It decides the console's lifetime and whether §6.10's exhaustion notification is a rare event or a daily one |
| **Q5** | Does an `rpc` worker *replay* a previous task's answer the way the measured `tui` worker did, and after how many sweeps? §3.4 — both measurements are on `tui` seats, and both attribute the behaviour partly to the vague staged trigger, which an `rpc` dispatch does not have. **The `accumulation` half needs no probe** (§2.3a) and is why layer 4 is built regardless | Dispatch two clearly different tasks to one `rpc` worker without a restart and read the second answer; then repeat at 10, 50 and 100 dispatches to find where a session stops being usable. **Cheap, and what it decides is the DEFAULT of `recycle_after_sweeps`, not whether recycling exists** | **Nothing.** It sets one number |
| **Q6** | Should the triage console's panes be live event views for `rpc` workers? SRD-REVIEW-CONSOLE §3.2 records the capability as *"knowable and currently unused"* — **no console does it today**, so this console would be the first | Build the pane plan with `pifleet monitor` and a log tail first (both are just commands in a pane), and try the event view as a second step. **The console works either way**; this decides whether it is nice to watch | **Nothing.** §13 Phase 4 can ship the simple plan |
| **Q7** | Must this console survive the GUI? If the answer is yes, §6.4's launchd arm becomes the right one and the actor gains a supervision story the fleet does not currently have for anything | **Not a probe — a requirement question.** It is asked because "a health check every 5 minutes" and "only while a cmux window is open" are different products and the commission does not distinguish them | **Nothing in the design's shape** — the actor's pass is the same either way. It decides who starts it |
| **Q8** | Should `cloud.impersonate_service_account` be provisioned before this console runs? SRD-OBSERVER-001 §6.3 already argues it; a continuous unattended reader argues it harder | **Not this document's to probe** — it is a cloud-provisioning decision. Recorded because this console is the first workload that makes the operator's full identity available to an agent continuously rather than occasionally | **Nothing.** D11's kubeconfig fence is the control that ships either way |
| **Q9** | Does `event_stall_kill: 25m` (`fleet.yaml:91`) count an idle-between-sweeps worker as stalled? `stall.ts:31` excuses a worker waiting behind `max_concurrent` as *"the queue"*; whether an idle `rpc` worker between tasks is excused the same way is not established here | Read `stall.ts` and `state.ts` against an `rpc` worker's idle state, or leave a console up for 30 minutes with the cadence disabled and see what happens | **Nothing at a 5-minute cadence** — the gap never reaches 25 minutes. It binds if the cadence is ever set above ~20 minutes, or after 5 consecutive skips |
| **Q10** | If `run_timeout` ever gains a reader, this console dies at two hours. Finding C. Should the ceiling be raised now, or should the console be exempted, or should the field be retired? | **Not a probe.** Recorded so that whoever implements `run_timeout` finds this row rather than finding a triage console that stops every two hours for no visible reason | **Nothing today.** It is a tripwire pointed at a future change |
| **Q11** | **Which credential does `https://ntfy.agileguy.ca/Alerts` need, and under what variable name?** Measured 2026-09-06: an anonymous read of that topic returns `403`, so the server is not open by default and a publish should be assumed to need a token until an authorised one is measured. §7.8's `token_env` defaults to `null`, which means the shipped default is an endpoint that will refuse | **A probe the OPERATOR must take, not this document** — the only way to test a publish is to send a real notification, so it was deliberately not attempted here. Mint an ntfy access token, export it, set `notify.token_env`, and `pifleet triage --once` against a fixture incident. **Two things to check while doing it:** that a wrong token produces §9.17's `rejected` outcome and not a silent retry loop, and that the topic name in the path is the one the operator's phone is subscribed to | **§13 Phase 8 only** — Phase 5's fixtures never touch the network. It decides whether the first live sweep announces anything, not whether the console works |

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
- The re-notify floor fires at most once per `renotify_after`. *Probe: fixture sweeps every 5m from
  the firing instant `t0` through `t0+24h` inclusive at the 6h default; assert the message instants
  are **exactly `[t0, t0+6h, t0+12h, t0+18h, t0+24h]` BY VALUE** — one `opened` and four
  `reminder`s. Asserting instants rather than a count is what makes the criterion survive the
  inclusivity question that made this number wrong once already (§6.8a), and it still fails a design
  that sends 288.*

**Console-health deduplication (D13) — the same shape as the block above, applied to the console**
- **Anti: an observer reporting `blocked` on 288 consecutive sweeps produces one notification.**
  *Probe: drive 288 fixture sweeps in which one environment's observer returns `status: blocked`;
  assert one `opened` and the `renotify_after` reminders **at their instants by value**, as the
  service-path criterion above spells them — **literal and not "few", because "few" would pass a
  design that sends twelve**, and by instant rather than by count because a bare count inherits the
  inclusivity ambiguity §6.8a was corrected for. This is the
  288-a-day hole §6.8a was written to close, and asserting it on the service path only would leave it
  open.*
- **Anti: skips 4, 5 and 6 send nothing.** *Probe: six consecutive fixture passes each finding a
  sweep in flight; assert exactly one notification, at the third. §6.4 names the threshold and says
  nothing about what follows it; this is what says it.*
- A console-health `kind` clears only on a positively observed good state. *Probe: a `firing`
  `observer_blocked` record followed by a sweep that did not run at all; assert it stays `firing` and
  composes no recovery. **The mirror of §6.8's `unhealthy → indeterminate` rule, and wrong for the
  same reason: an actor that stopped counting is not an actor that recovered.***
- **Anti: `kind` is a closed set.** *Probe: assert the enum's members by name against §6.8a's table,
  not by count — `test/unit/monitor-readonly.test.ts:363-369`'s lesson, that naming the permitted set
  is what makes a seventh member fail.*

**Saturation (D15)**
- **Anti: two observers producing no artifact in one sweep is `saturated`, not a coverage gap.**
  *Probe: a fixture sweep with one artifact of three; assert the outcome is `saturated`, that each
  service's `consecutive_indeterminate` did **not** advance, and that no coverage issue was composed.
  **A gate that escalates to coverage here passes every other criterion in this document and is
  exactly the misdiagnosis §6.7 rule 3 exists to prevent.***
- The saturation announcement names the provider and model, never the environment. *Probe: assert the
  composed `subject` equals the provider/model pair and that the environment appears only as scope.*
- One observer missing is **not** saturation. *Probe: a fixture sweep with two artifacts of three;
  assert the normal `indeterminate` path and that `consecutive_indeterminate` **did** advance. This
  is the fixture that stops the verdict swallowing ordinary coverage gaps.*

**The notification (D10)**
- **Anti: no worker-authored string reaches the notification's `title` or `message`.** *Probe: a
  fixture `triage.json` whose prose fields contain a marker string and an injection-shaped sentence;
  assert the composed `message` contains neither, and that the marker appears only inside the fenced
  evidence block. **§4.3 — this is the criterion that is worth the most and would be the easiest to
  omit.***
- **Anti: the composed title is header-safe.** *Probe: assert every fixture's title is a single line
  of printable ASCII under 200 bytes, and that `renderRequest` throws on one that is not. **The title
  travels as an HTTP header** (§6.9), so a newline is a header-injection boundary and ntfy rejects
  over 1 KB with a `400` — which would arrive as a delivery failure for what is actually a composer
  defect.*
- **Anti: the delivery call is bounded.** *Probe: a fixture transport that never resolves; assert the
  pass returns within `timeout_ms` and records `retryable`. **A pass that hangs here stops the console
  — §6.9 requirement 2 — and this is the only criterion that would catch it, because the happy path is
  identical either way.***
- The `ntfy` adapter POSTs the configured URL verbatim with a plain-text body and header metadata.
  *Probe: assert `url` is `notify.endpoint` unchanged, `body` is the message text, and the title,
  priority and tags are headers. **Anti, in the same test: the request body is never JSON for the
  `ntfy` adapter** — ntfy accepts JSON only at the root URL and turns JSON POSTed to a topic URL into
  the message text, so the wrong version delivers successfully and shows the operator a wall of
  braces.*
- The `json` adapter POSTs the typed envelope unchanged. *Probe: assert the parsed body round-trips
  to the `Announcement`, so the escape hatch cannot quietly acquire a shape.*
- An undelivered notification is retained and the backlog is named. *Probe: a fixture transport that
  returns 429, then 200; assert the second delivery names the first as a count and a window.*
- **Anti: an undelivered notification is never re-sent as itself.** *Probe: the same fixture; assert
  the second request's body does **not** contain the first message's text. §6.9 requirement 6 — a
  transport that replays the backlog passes the criterion above and fails this one, and replaying a
  four-hour-old "`authorization` is unhealthy" after it recovered is the message that makes an
  operator stop reading.*
- **Anti: a non-`429` `4xx` is `rejected`, not `retryable`.** *Probe: a fixture transport returning
  `401`; assert no backoff was scheduled and that `reporter_undelivered` fired on the **first**
  occurrence. §9.17.*
- **Anti: a delivery failure never advances or clears an incident.** *Probe: a `firing` record, a
  sweep observing `healthy` with evidence, and a transport that fails; assert the record is `clear`,
  the recovery is recorded, and the failure appears **only** in `undelivered[]`. **§6.9 requirement 7
  — the rule this document states most plainly and the one a plausible implementation violates by
  writing the transition after the `await`.***
- The reporter's own failure reaches all four of §9.15's surfaces. *Probe: a fixture channel down for
  five sweeps then up; assert the incident record, a log line, a `--status` count, and that the
  **first** message delivered on recovery is the one naming the outage and the lost count — before
  the sweep's own.*
- **Anti: a console with `notify: null` still sweeps and still records transitions.** *Probe: assert
  the incident record advances and `--status` reports the channel as disabled rather than failing.*
- **Anti: `--status` cannot be read as an all-clear.** *Probe: assert sweeps completed, incidents by
  state, and the undelivered count are three distinct fields. **A single "OK" line is how "quiet" and
  "could not speak" become the same row** (§6.9 requirement 7).*

**Configuration (D4, D11, D14, §6.11)**
- A targets file naming a `kube_context` absent from `cloud.kubeconfig` is refused. *Probe: a fixture
  pair; assert the load throws and the actor refuses to start.*
- A `default_window` greater than the cadence is refused, **and the message names both files**.
  *Probe: `default_window: 6h` in `targets.yaml` against `cadence_s: 300` in `console.yaml`; assert
  refusal and assert both filenames appear in it. §6.10 rule 1 and §7.8's cross-file note — a refusal
  naming one file when two disagree sends the operator to the wrong editor.*
- **Anti: `sweep_deadline_s` cannot be written.** *Probe: a fixture `console.yaml` carrying the key;
  assert a **field-level** `.strict()` error naming it, and separately assert
  `sweepDeadlineS({cadence_s: 300, reserve_s: 60}) === 240`. §7.8 property 1 — §6.5's
  `sweep_deadline_s ≥ cadence_s` refusal is unreachable by construction, and this pair is what says so
  rather than a comment claiming it.*
- **Anti: `notify.endpoint` cannot carry a credential.** *Probe: three fixtures —
  `https://u:tk_x@host/Alerts`, `https://host/Alerts?auth=x`, and `ftp://host/Alerts`; assert each is
  refused at load. **The query-string case is the one that matters most**, because ntfy documents
  `?auth=` and an operator who finds that page will reach for it — and `console.yaml` is tracked,
  `~/.pifleet/triage-relay.log` appends forever, and `--status` prints the endpoint.*
- `notify.token_env` is a NAME and is guarded by the fleet's own function. *Probe: assert
  `token_env: PIFLEET_X` and `token_env: PATH` are both refused with `envVarNameIssue`'s messages —
  **driving the shared function, not a copy of its rules**, which is the defect
  `src/config/schema.ts:649-666` records having already been made once.*
- The shipped defaults are the documented ones. *Probe: parse an empty `console.yaml` and assert every
  field of §7.8's table, `notify.endpoint === "https://ntfy.agileguy.ca/Alerts"` included. **A missing
  file resolves to the same values** — assert that too, because "the default endpoint" is only true if
  an operator who writes no file gets it.*
- `notify: null` parses and disables; `notify:` absent parses and enables the default. *Probe: both
  fixtures. The two must not be confused — `FreshDispatchDeps.quiesce`'s docblock records the same
  distinction being got wrong, that "an omitted optional field and a console that genuinely has no
  relay look identical at the call site".*
- **Anti: no `src/` module reads a triage tuning value that `TriageConsoleConfigSchema` does not
  define.** *Probe: grep the triage modules for the nine knob names and assert each occurrence is a
  read from the config object. **This is the criterion that keeps §7.8 from becoming decorative** —
  a contract nothing is required to route through is a second copy of the defaults.*
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

**RULING 2026-09-06 on what "ledger" means here, because §12 uses the word twice with two senses.**
The console-and-actor block asks the abandonment to *"ledger the reason"*; this block bans a *"ledger
writer"* from the console's own modules. They are not in conflict, and the resolution is the narrow
one: **the abandonment reason goes to §7.7's own append-only log** — §9.15 surface 2, *"the only
surface that is guaranteed to work"* — and **not** to the fleet ledger. `cli/commands/relay.ts`'s
`ledger.append("relay_console_gone", …)` is the review console's answer and is exactly the reachability
this block forbids. So task 6.6's permitted-exception list stays at ONE entry (the dispatch path), and
a second entry would be the tell that this ruling was quietly reversed. Task 6.3 read it this way
before the ruling existed; the ruling ratifies rather than corrects it.
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
| **0 — Decisions** | ~~Q1 and Q2 answered; Q3 measured or defaulted~~ **COMPLETE 2026-09-06** | — | **Met.** D1 arm 3 is recorded in §10 (so §5.9 needs no amendment — the arm that reverses nothing); the notify channel is named a configurable webhook (D10, §6.9, §7.8); `run.max_concurrent` is `4`. **Q11 is the one thing outstanding and it gates Phase 8 alone** — it is an operator credential, and every phase up to 8 is offline |
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

- **0.1** ~~Answer Q1.~~ **DONE 2026-09-06** — **arm 3**, recorded in §10 D1 with its cost, answered
  in place in §11 and at the head of §0.2. Arm 3 is the one arm that required no edit anywhere:
  `Docs/SRD.md` §5.9 is untouched and `fleet.yaml:471-475`'s comment stands as written, because
  nothing was superseded. **The conditional half of this task therefore did not fire**, and that is
  the outcome rather than a skipped step.
- **0.2** ~~Answer Q2.~~ **DONE 2026-09-06** — answered in place in §11 with the date, per this task's
  own rule. The channel is a configurable webhook defaulting to `https://ntfy.agileguy.ca/Alerts`
  (D10, §6.9, §7.8), and §13 Phase 5 is unblocked.
- **0.2a** *(operator, not dispatchable)* Q11: mint an ntfy access token for the `Alerts` topic and
  export it under the name `notify.token_env` will carry. **Not a code task and not a fixture task** —
  Phase 5 is entirely offline and does not need it; Phase 8 does not work without it. Touches:
  nothing tracked. *Acceptance: `pifleet triage --once` against a fixture incident delivers, and a
  deliberately wrong token produces §9.17's `rejected` outcome rather than a retry loop.*
- **0.3** ~~Measure `ollama-cloud/gpt-oss:120b` against `probe_timeout_ms: 90000`.~~ **MOOT
  2026-09-06** — closed for want of a subject, not for want of a measurement. The probe existed only
  to protect an allowlisting, and under D1 arm 3 nothing is allowlisted: `models_allowlist` is not
  extended and `context_windows` gains no row. **Recorded rather than deleted** because the reasoning
  is a live tripwire — if that model is ever added, it must be measured against the ceiling first, or
  a model near it makes `up` refuse the whole fleet.
- **0.4** ~~Set `run.max_concurrent` (Q3).~~ **DONE 2026-09-06 — set to `4`, in both files, with the
  inspection this task required actually performed.** The finding: `agentPaneCommand` builds
  `up --workers <one worker>` and `operations-plan.ts:310` states it outright — *"Each pane creates
  its own run"* — so **no run in this fleet has ever held more than one worker, and the key has had
  nothing to bind on at any value.** Raising it is therefore inert for every existing console rather
  than merely safe for them, which is a stronger result than the task asked for. `4` is the console's
  own size: three observers fan out at once and `tri-1` reconciles. Touches: `fleet.yaml` (live,
  untracked — operator-applied), `fleet.example.yaml` (tracked).
  *Acceptance: `pifleet config validate` exits 0 against the live file. **Verified 2026-09-06:** it
  does, with only the pre-existing `obs-1 pane_mode: tui` warning, which this console does not touch.*

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

**Intent.** Make the request plane serve a second console, once, in the shape
`src/cli/commands/relay.ts:377-392` says it should be solved.

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
  *Note: **`src/cli/commands/relay.ts:377-392`** is the comment this task closes; it should be updated
  rather than left describing a gap that no longer exists. **Qualify the path when citing it** — §0.6
  writes it in full and this section originally wrote it bare, which reads as `src/run/relay.ts`, where
  those lines are inside `relayEnvelopeState` and concern envelope states rather than console
  selection. That bare form sent an implementer to the wrong file in round 4; corrected 2026-09-06
  after the implementer caught it. Two modules in this tree are called `relay.ts` and every citation of
  either needs its directory.*
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
- **3.3** **The console config contract (D14, §7.8).** `TriageConsoleConfigSchema`,
  `NotifyConfigSchema`, `DEFAULT_NOTIFY`, the computed `sweepDeadlineS`, and the pure
  `parseTriageConsoleConfig` behind an injected `TriageConfigRead`. Touches:
  `src/run/triage-config.ts` (new), `test/unit/triage-config.test.ts` (new).
  *Acceptance: §12's configuration block passes, including the empty-file and missing-file default
  fixtures and the `sweep_deadline_s`-is-not-a-field pair. **Call `envVarNameIssue`
  (`src/config/schema.ts:672`) for `token_env` rather than restating its rules** — `:649-666` records
  that an inline copy on one door left the other bare, and this is a third door.*
- **3.4** `notifyEndpointIssue`: refuse a `notify.endpoint` carrying userinfo, a query string, or a
  scheme other than `http:`/`https:`. Touches: `src/run/triage-config.ts`,
  `test/unit/triage-config.test.ts`.
  *Acceptance: §12's three-fixture credential probe passes. **The `?auth=` case is the priority** —
  ntfy documents that form, so it is the one an operator will reach for, and `triage/console.yaml` is
  tracked.*
- **3.5** Wire **both** files into `pifleet config validate` so one command checks all three, and put
  the cross-file `default_window ≤ cadence_s` refusal in the loader that holds both — naming both
  files in the message. Touches: `src/cli/commands/config.ts`, `src/run/triage-config.ts`,
  `test/integration/cli-exit-codes.test.ts`.
- **3.6** Write the worked files: the targets file for the commission's example, and a
  `console.yaml` carrying `version: 1` and nothing else, **so that the tracked example is also the
  proof that the defaults are reachable**. Touches: `triage/targets.yaml` (new),
  `triage/console.yaml` (new).

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
- **5.3a** **The saturation verdict (D15, §6.7 rule 3). DONE 2026-09-06.** The correlation rule, the suppression of the
  coverage escalation, and the confirming probe — which is `probeNativeToolCalls`
  (`src/security/model-probe.ts:230`) over `hostReachableBaseUrl` (`:603`), **injected as a dep, never
  called in a fixture**. Touches: `src/run/triage-verdict.ts`, `test/unit/triage-verdict.test.ts`.
  *Acceptance: §12's Saturation block passes, including the two-of-three fixture that must **not**
  saturate. **Write the suppression before the verdict** — a saturation verdict that does not stop
  `consecutive_indeterminate` advancing is a console that reports both findings and lets the operator
  pick the wrong one.*
- **5.4** The incident state machine, as a pure `(record, observation) => {record, notifications[]}`.
  Touches: `src/run/triage-incident.ts` (new), `test/unit/triage-incident.test.ts` (new).
  *Acceptance: the 288-consecutive-sweeps fixture asserts exactly one notification; the alternating
  fixture reaches `flapping` and emits once; the `unhealthy → indeterminate` fixture does **not**
  recover.*
- **5.4a** **Console-health identities (D13, §6.8a). DONE 2026-09-06** — the types with task 5.5
  (a record kind whose subject cannot be spelled cannot be validated), the mapping and §12's
  fixtures after it. The closed `kind` enum, the `(scope, kind)` record path, and
  `consoleHealthObservations` — a pure map from one sweep's facts to `IncidentObservation`s, **driven
  through 5.4's machine unchanged**; no `switch` in `advanceIncident` reads a subject or a reason. Touches: `src/run/triage-incident.ts`,
  `test/unit/triage-incident.test.ts`.
  *Acceptance: §12's Console-health block passes, including the 288-sweep `blocked` fixture and the
  skips-4-5-6 fixture. **If this task finds itself writing a second state machine, it has gone wrong**
  — the whole content of §6.8a is that the identity was missing and the machine was not.*
- **5.5** **DONE 2026-09-06.** The incident record's schema and validated read, for both record kinds. Touches:
  `src/run/triage-incident.ts`, `test/unit/triage-incident.test.ts`.
- **5.6** **The composer and the adapters (D10, §6.9). DONE 2026-09-06.** `composeAnnouncement` — typed fields in, an
  `Announcement` **value** out, pure, with `subject` distinct from `environment` so §6.7 rule 3's
  notification can name the provider — and `renderRequest(announcement, notify)` with the closed
  `["ntfy", "json"]` adapter enum. Touches: `src/run/triage-notify.ts` (new),
  `test/unit/triage-notify.test.ts` (new).
  *Acceptance: §12's injection fixture and the header-safety fixture pass. **This is the phase's
  highest-priority task after 5.4** — §4.3 is why. **Two things to get right and one not to invent:**
  the `ntfy` adapter POSTs the configured URL **verbatim** with a plain-text body and header metadata
  and **never JSON**, because ntfy accepts JSON only at its root URL and silently turns JSON POSTed to
  a topic URL into the message text; and the title is asserted header-safe by `renderRequest` rather
  than trusted, because ntfy rejects a title over 1 KB with a `400` that would otherwise arrive
  looking like an endpoint failure.*
- **5.6a** **The transport and its outcomes. DONE 2026-09-06.** `export type NotifyTransport`, taken through
  `{transport?, now?}` with a `fetch`-backed default carrying
  `AbortSignal.timeout(notify.timeout_ms)` — `src/security/model-probe.ts:252` and
  `src/cli/commands/doctor.ts:1122` are the two existing spellings. The three outcome classes
  (`delivered` / `retryable` / `rejected`), the sweep-unit backoff to `max_retry_sweeps`, and the
  backlog carried as a count and a window. Touches: `src/run/triage-notify.ts`,
  `test/unit/triage-notify.test.ts`.
  *Acceptance: §12's 429-then-200 fixture, the never-resolving-transport fixture, the `401`-is-not-
  retryable fixture, and the anti-criterion that no undelivered message is re-sent as itself.
  **`deliverAnnouncement` must return a `NotifyOutcome` and never `void`** — a void return makes
  failure indistinguishable from success at the call site, which is the silent swallow this console
  exists to catch.*
- **5.6b** **The reporter's own failure (§9.15). DONE 2026-09-06.** Wire `reporter_undelivered` through 5.4a's
  identity, and make the recovery notification the **first** thing delivered when the channel returns.
  Touches: `src/run/triage-incident.ts`, `src/run/triage-notify.ts`,
  `test/unit/triage-notify.test.ts`.
  *Acceptance: §12's four-surfaces probe passes. **And the anti-criterion that outranks it: assert a
  delivery failure never advances or clears an incident** (§6.9 requirement 7) — the plausible
  implementation writes the transition after the `await`, and it fails only this test.*

  **The seam task 5.6a left, named 2026-09-06 so this task does not re-derive it.** Four things cross:
  (a) `reporterUndelivered(state)` is already implemented and tested with its anti-twin — `true` on the
  **first** `rejected` and on the **second** consecutive `retryable` — so a wiring that fires on one
  retryable reddens in `triage-notify.test.ts` before it reaches the incident machine; (b)
  `DeliverySweepResult.disposition` (`attempted` / `held` / `disabled` / `nothing_to_send`) and
  `.outcome` carry enough to write `undelivered[]` and a log line without inspecting anything else;
  (c) `AnnouncementFacts` is the translation target — build one from an `IncidentNotification`, mapping
  `kind`/`scope`/`subject` from the subject, `assessment` from `reason`, `transition` from
  `NotificationKind`, and `first_seen` from `at − firingForMs`; (d) the *"delivered first"* ordering
  needs no new machinery — call `deliverySweep` with the `reporter_undelivered` recovery facts before
  the sweep's own. `triage-notify.ts` deliberately imports **nothing** from `triage-incident.ts` and a
  source probe asserts that absence (ISC-689), so this task is where the two meet for the first time.

  **How it actually landed, recorded 2026-09-06 so a later reader does not "fix" it back.** The
  prediction above — that the coupling arrives in the notifier — is wrong, and the other arrangement is
  better. `src/run/triage-incident.ts` takes a **type-only** import of `AnnouncementFacts` and
  `NotifyBacklog`; the notifier still imports nothing from the incident machine, so ISC-689's source
  probe stands **unmodified**. The translation (`announcementFacts`) lives beside `IncidentNotification`
  where it can read `CONSOLE_SCOPE` directly, and `reportSweep` takes `readonly AnnouncementFacts[]` —
  values the caller has already translated — which makes §6.9 requirement 7's *"a transition is
  recorded before it is delivered"* a property of the call graph rather than of anyone's discipline. A
  mirror probe was added for the other direction: the incident module may see the announcement
  vocabulary and may **never** name a delivery outcome. Requirement 7 is more structurally guarded
  after this task than before it.

  **Three residues, none of them closable in Phase 5.** (a) `withUndelivered` fills
  `IncidentRecord.undelivered[]` and nothing persists it — there is a `loadIncidentRecord` and no
  `saveIncidentRecord`; the schema already accepts the field and task 5.5's round-trip covers the
  shape, so this is the actor's wiring. (b) §12's `--status` criterion asks for three fields; only the
  undelivered count exists in Phase 5, and **the criterion must be re-checked at the actor rather than
  marked closed by the Phase 5 probe** (ISC-705). (c) The reminder edge for a firing
  `reporter_undelivered` is unexercised: `renotify_after_s` defaults to 21600 s = 72 sweeps, so a
  channel down over six hours composes a reminder about the reporter that it cannot deliver. Correct by
  construction, untested, and it needs a 72-sweep fixture that belongs with the actor.
- **5.1a** Implement §7.3's resolution: `services: string[]` on `pifleet.dispatchrequest/v1`,
  required on triage and refused on review with `ConsoleRoster` as the discriminator, spending the
  two new codes `services_missing` and `services_not_permitted`. **Then wire both waiting modules** —
  `checkTriagePartition` and `assessTriageSweep` project their partition out of the sweep's requests.
  Touches: `src/run/dispatch-request.ts`, `test/unit/dispatch-request.test.ts`,
  `src/run/triage-partition.ts`, `test/unit/triage-partition.test.ts`. **(The last two were missing
  from this line until 2026-09-06; the acceptance bullet below has always required them.)**
  *Acceptance: a review request carrying `services` refuses by code; a triage request without it
  refuses by code; a triage request with it validates against `triage/targets.yaml`; and a
  `partitionFromRequests` projection beside `checkTriagePartition` turns a sweep's requests into the
  partition value both waiting modules already take.*
  **This task removes the SPECIFICATION blocker, not the caller gap.** The production caller is the
  actor, which is task 6.1 and does not exist yet, so `grep` will still find no caller outside these
  files and that is the correct outcome rather than an unfinished one. Saying so here because a brief
  that demands a caller which cannot exist is the shape that has cost this phase twice (ISC-600,
  ISC-609).
- **5.1b** Edit `roles/triage.md:115-130` so the `dispatch-request.json` example carries `services`
  and the sentence under it stops saying *"and nothing else"*. **Without this the live console
  refuses its own first sweep**, and no host-side test can see it. Touches: `roles/triage.md`,
  `test/unit/roles.test.ts` (or wherever a role-prompt probe can live), `ISA.md`.
  *Acceptance: a probe reads `roles/triage.md` and asserts the example parses through
  `parseDispatchRequest` under `TRIAGE_CONSOLE_ROSTER` — the same working-tree source-probe posture
  ISC-600 forced on `scripts/`, for the same reason: nothing else checks this file.*
- **5.1c** **DONE 2026-09-06.** Correct `roles/triage.md:288-317`'s `triage.json` worked example to §7.5's contract —
  `coverage[]` as `{channel, result}`, `evidence_ref` as a ledger array, `unaccounted[]` as service
  names — and hold it there with a probe. **DONE 2026-09-06.** Touches: `roles/triage.md`,
  `src/run/triage-document.ts`, `test/unit/triage-document.test.ts`.
  *Acceptance: the example parses through `parseTriageDocument`, AND the three shapes are asserted
  on the parsed value so a later relaxation cannot re-open the silent failure; the example carries
  both an attempted and a `not_attempted` channel so it teaches the whole enum.*
- **5.4c** Blind flapping records escalate as COVERAGE, not as an issue (§6.8). Widen
  `onUnobserved`'s coverage escalation to include `flapping` — the same `COVERAGE_THRESHOLD` applied
  to one more state, not a new judgement — and narrow the `flapping → firing` edge to require an
  OBSERVED issue, so the two paths cannot both fire. Touches: `src/run/triage-incident.ts`,
  `test/unit/triage-incident.test.ts`, `ISA.md`.
  *Acceptance: a flapping service blind for `COVERAGE_THRESHOLD` sweeps opens with
  `reason: "coverage"` and `evidenceRef: null`; a flapping service observed unhealthy across a
  `flap_window` opens with the observed reason and its artifact; and neither fixture produces two
  notifications.*
- **4.5a** **DONE 2026-09-06.** Two source probes task 4.5 left open, both in round 6's files.
  (a) ~~`scripts/triage` spells its four seats as literals rather than importing
  `DEFAULT_TRIAGE_WORKERS`~~ — **this premise was STALE and the correction is the finding.** The
  script has imported the constant since round 6 (`scripts/triage:93`, resolved once at `:263`) and
  no seat id appears anywhere in its **code**. What still spells the four as literals is its
  **prose**: the usage banner `:5-8`, the pane diagram `:14-20`, the `--no-actor` help text `:156`,
  and comments at `:47`, `:358`, `:491`, `:515`. The divergence the task names is real; it moved into
  the documentation. The probe was split to match — one arm counts the single resolution site with
  comments and the banner stripped, the other parses the pane diagram's cells and asserts them equal
  to the constant in both directions. (b) `test/unit/console-restart.test.ts:471`
  asserts ISC-572 for triage by reading source text, while `test/integration/triage-console.test.ts`
  now EXECUTES it — keep both and say which is load-bearing. Touches:
  `test/unit/fresh-dispatch.test.ts`, `test/unit/console-restart.test.ts`, `ISA.md`.
- **5.4b** The `flapping → firing` edge (§6.8, added 2026-09-06): after `flap_window` with no
  observed clear, a flapping record opens once and restarts the re-notify floor. Touches:
  `src/run/triage-incident.ts`, `test/unit/triage-incident.test.ts`, `ISA.md`.
  *Acceptance: a fixture that flaps and then goes hard down notifies exactly once more and its
  message instants are asserted by value; the anti-twin — a fixture that keeps flapping — still
  notifies exactly once in total, so the new edge cannot be satisfied by a machine that re-opens on
  every sweep.*
- **5.3b** **DONE 2026-09-06 in round 8** (ISC-648, ISC-649, ISC-650; `test/unit/triage-verdict.test.ts:445`). §6.7 rule 2's fifth condition: a `healthy` whose `coverage[]` is non-empty and whose every
  entry is `not_attempted` fails the gate, spending the existing `coverage` gap rather than a new one.
  Touches: `src/run/triage-verdict.ts`, `test/unit/triage-verdict.test.ts`, `ISA.md`.
  *Acceptance: an all-`not_attempted` fixture and an empty-`coverage[]` fixture reach the same
  assessment and the same gap by name; a mixed fixture with one `answered` entry does not.*
- **5.3c** **DONE 2026-09-06.** Implement §7.4's `window_opened_at` echo, **decided 2026-09-06: the field grows.** A
  `windowEcho(dispatchedAt, openedAt, policy)` beside `sweepIdEcho`, three states (`fresh`,
  `absent`, `out_of_range`) spent as one reason `stale_window`; `SweepCoverage` carries the dispatch
  instant and the environment's `default_window`. Artifact-level, so a bad window discards every row
  the document carries. Touches: `src/run/triage-verdict.ts`, `test/unit/triage-verdict.test.ts`,
  `ISA.md`.
  *Acceptance: fixtures at each boundary asserted BY VALUE — exactly on `dispatched_at −
  default_window − reserve_s` (accepted), one second earlier (refused), exactly on `dispatched_at`
  (accepted), one second later (refused), and absent (refused). A correct `sweep_id` with a bad
  window still discards, and a bad `sweep_id` with a good window still discards, so neither check can
  be satisfied by the other.*
- **5.5a** **DONE 2026-09-06.** A Zod schema for `triage.json` (§7.5), refused on any violation, matching §7.6's
  validated-on-read posture. Touches: `src/run/triage-document.ts` (new),
  `test/unit/triage-document.test.ts` (new), `ISA.md`.
  *Acceptance: a document with a row missing `assessment`, one with an unknown assessment value, and
  one that is not an object each refuse by name rather than reaching `assessTriageSweep`.*
- **5.4d** **§6.8a's `kind` enum grows a SEVENTH member, `inference_unreachable`. RULED 2026-09-06, DONE 2026-09-06 — but see 5.4e: the member exists and nothing computes it.**
  Task 5.3a found the gap and could not close it: §6.7 rule 3 makes `unreachable` a first-class
  outcome — *"a different sentence on the operator's screen and a different thing for them to go and
  do"* — while §6.8a's `kind` enum is closed at six with no member for it, and §9's table has only
  §9.16, whose title is *"The inference server is slow, **not down**"*. So an `endpoint_down` sweep
  composes **nothing**. The two available resolutions were to grow the enum or to strike §6.7 rule 3's
  `unreachable` sentence as unimplementable.
  **Grow it.** Striking the sentence throws away a distinction the probe can already make reliably —
  `probeNativeToolCalls` separates the two classes and carries the incident report for a system that
  conflated them — and "the inference endpoint is down" is a console-health fact about the console
  itself, which is precisely what §6.8a's record kind is for. The cost is one enum member and one
  §6.8a table row; ISC-665 asserts the enum BY NAME, so the change is one line with a red test to
  prove it landed. Touches: `src/run/triage-incident.ts`, `test/unit/triage-incident.test.ts`,
  `Docs/SRD-TRIAGE-CONSOLE.md` §6.8a's table, `ISA.md`.
  *Acceptance: `CONSOLE_HEALTH_KINDS` is seven and ISC-665's probe names the seventh; an
  `endpoint_down` sweep composes an observation on the new kind; and the anti-twin — a `timeout` sweep
  still composes `inference_saturated` and NOT the new kind, because the whole point of ISC-731 is
  that the two do not collapse into one.*
  **The mitigation that makes this a one-cadence hole rather than a silence:** when the endpoint is
  really down, NO observer produces an artifact, so §6.5's zero-row raises `sweep_produced_nothing`
  and the console does speak. The uncovered case is the PARTIAL one.
- **5.4e** **Wire the seventh kind, added 2026-09-06 as the residue of 5.4d.** The enum member, its
  observation and its anti-twin all landed; **nothing computes it.** `ConsoleHealthFacts.unreachable`
  is optional, so absent means `null` — *"this sweep could not tell"*, which composes nothing rather
  than a false clear — and the caller that would set it is `triage-pass.ts`, which 5.4d's *Touches*
  line excluded and which task 6.1 had already completed by the time the seventh member was ruled in.
  **So ISC-820..823 are all satisfiable by hand-built facts and an `endpoint_down` sweep still
  composes nothing in production.** ISC-824 is filed OPEN against exactly this. Touches:
  `src/run/triage-pass.ts`, `test/unit/triage-pass.test.ts`, `ISA.md`.
  *Acceptance: a pass fixture whose saturation outcome is `endpoint_down` produces
  `unreachable: true` with `saturated: null`, and the anti-twin on a `timeout` outcome produces the
  reverse — the mapping table is already written down as `VERDICT_PAIR` in
  `test/unit/triage-incident.test.ts`, so this task consumes it rather than inventing one.*
  **A lesson recorded with the task, because it cost a round:** 5.4d was ruled in AFTER 6.1 shipped,
  and its *Touches* line was drawn from the sections it changed rather than from the callers it
  obliged. A criterion satisfiable entirely by hand-built fixtures is a criterion that has not
  reached an operator, and the acceptance clause has to say so or the gap ships looking closed.
- **5.3e** **A per-row `evidence_ref`, added 2026-09-06 from task 5.3a. DONE 2026-09-06.** `sweepObservations` cites one
  sweep-level ref because `ServiceAssessment` carries none, following `consoleHealthObservations`'
  precedent rather than changing 5.2's output shape from outside its *Touches* line. §6.8 wants *"the
  evidence that closed it"*, singular and per-incident, so a per-row ref is strictly better. One field
  on `ServiceAssessment` and one line in `assessTriageSweep`. Touches: `src/run/triage-verdict.ts`,
  `test/unit/triage-verdict.test.ts`, `ISA.md`.

  **RULED 2026-09-06, because 5.3e's own sentence did not cover the ordinary case.** *"Cites the
  row's own"* says nothing about a row that HAS none, and that case is ordinary rather than
  exceptional: §6.7 rule 2's gate applies to `healthy` alone, so a `degraded` row with an empty ledger
  is legal. `IncidentSignal["issue"].evidenceRef` is `string | null`; `observed_clear`'s is a required
  `string`. **The two are ASYMMETRIC and the asymmetry is a consequence, not a preference.** A clear
  cites the row's ref or REFUSES — becoming `unobserved` — because substituting the sweep's ref would
  turn a null citation into a well-formed clear wearing the collation document as a disguise, and
  `observed_clear` moves a record toward `clear` on its own and is §6.8's most expensive message. An
  issue cites the row's ref and falls back to the sweep's, because dropping the fallback buys no
  stricter type — the field is already nullable — and just hands the operator `null` instead of a
  document. An issue is confirmable and never notifies alone. **The bar differs because the
  consequence differs** (ISC-764, ISC-768).

  **Three count errors in the two task lines above, corrected 2026-09-06 by the engineer who hit
  them.** (a) *"the three literals in `triage-document.test.ts`"* — that file has TWO literal sites;
  the real count across the slice is SEVEN, the other five being in `triage-verdict.test.ts`, which is
  also on the *Touches* line, so it was a count error and not a scope error. (b) *"a compile error at
  `:251` and `:254`"* — only `:254` is reported, because TypeScript stops at the first assignability
  failure for that literal and `:251` surfaces only once `:254` is fixed. (c) *"a red test at
  `:286`"* is CONDITIONAL — it reddens only if the fixture is completed without an in-range
  `window_opened_at`; a valid echo keeps it green throughout. The prediction read as unconditional.
  Recorded because a task line that predicts compiler output is a claim like any other.
- **5.3d** **Make the window fields required, added 2026-09-06 as recorded debt from task 5.3c. DONE 2026-09-06.**
  `SweepCoverage.window` and `ObserverArtifact.window_opened_at` shipped OPTIONAL, and the reason is a
  process constraint rather than a design judgement: making either required is a compile error at
  `test/unit/triage-document.test.ts:251` and `:254` and a red test at `:286`, and that file is
  outside task 5.3c's *Touches* line. The hazard is closed rather than hidden — `SweepAssessment`
  publishes `window_checked`, so a caller reading `stale_window: []` can tell a clean sweep from one
  where nobody looked — but a required member is what actually makes the check unskippable. Touches:
  `src/run/triage-verdict.ts`, `test/unit/triage-verdict.test.ts`, `test/unit/triage-document.test.ts`,
  `ISA.md`.
  *Acceptance: both `?` dropped, the three literals in `triage-document.test.ts` updated, and
  `window_checked` either retired or kept with a stated reason — it is the skip's own witness, so
  retiring it is a decision and not a cleanup.*
- **5.8** **§7.5 grows a bounded prose field. RULED 2026-09-06, found by task 6.1.**
  §12's D10 marker criterion asks for *"a fixture `triage.json` whose **prose fields** contain a marker
  string … assert the marker appears only inside the fenced evidence block."* **§7.5 has no prose
  field**, and neither does `TriageRow`. The consequence task 6.1 measured is the one that matters:
  the pass passes `evidence: null` to every announcement, so `Announcement.evidence` and the
  `EVIDENCE_BANNER_*` block are **structurally unreachable in production**. ISC-680 grades the
  containment against a synthetic prose string, which is the right unit test and is not the end-to-end
  criterion §12 asks for.
  Two resolutions were available: grow the field, or restate §12's criterion as composer-level.
  **Grow it.** §6.9's containment machinery exists *because* worker prose flows into a notification;
  with no prose field it is a guard standing over a road nobody uses, and §6.9's own complaint —
  recorded in round 9 — is that *"the reason the report is worth reading"* never reaches the operator,
  who gets `evidence: <ref>` and no sentence. A console that notifies without a reason has moved the
  operator's first question from *"what broke"* to *"where do I look"*.
  Touches: `src/run/triage-document.ts`, `src/run/triage-verdict.ts`, their tests,
  **`roles/triage.md`** and `test/unit/triage-role.test.ts`, `ISA.md`.
  *Acceptance: one optional `note` per row, bounded in bytes and refused above the bound by name;
  the pass carries it into `Announcement.evidence`; §12's marker fixture passes END TO END, with the
  marker appearing only between the banners. **And the anti-criterion that is really the point:** a
  `note` containing a `Title:` line and a newline still lands inside the fence with every line
  prefixed, so ISC-680's guarantee is proved on the production path rather than on a fixture.*
  **This is a schema change, so it obliges the model-facing prompt edit in the SAME task** — §7.3's
  ruling learned that the hard way (ISC-651), and `roles/triage.md` is on the Touches line above for
  that reason, with its worked example parsed through the real parser.
- **5.7** **DONE 2026-09-06.** Add every §12 fixture in the
  issue-predicate, saturation, dedup, console-health and notification blocks. Touches: `ISA.md`.
  The console-health block (ISC-673..677) and the notification block (ISC-678..690a) were closed as
  their tasks landed. The issue-predicate and dedup blocks were **not** — those fixtures were built in
  rounds 5–7, before per-round transcription was the habit, and seven §12 bullets had a passing test
  and no criterion: ISC-712..718. **The saturation block closed with task 5.3a the same day** — its
  three §12 bullets are ISC-728 (two silent observers saturate, one does not), ISC-729 (a stale
  artifact is an artifact, so it counts against saturation) and ISC-738 (the announcement names the
  provider and model, never the environment).
  *Method note for whoever finishes this: match ISA's `-t "…"` filters against the test names rather
  than matching whole names, and check the direction — a probe filter is a SUBSTRING of its test's
  name, so a naive equality check reports most of the file as uncovered. Verify each transcribed probe
  resolves to exactly one test and passes before recording it.*

### Phase 6 — The clock

**Intent.** One pass, exported; one loop, a wrapper.

**Does not.** Start a second scheduler anywhere. §4.4.

- **6.1** **DONE 2026-09-06.** `triagePass(deps)` — read the run tree, decide tick-or-skip, perform the fan-out, drive the
  incident machine, emit. Touches: `src/run/triage-pass.ts` (new),
  `test/unit/triage-pass.test.ts` (new), **`src/run/triage-incident.ts` and
  `test/unit/triage-incident.test.ts` for `saveIncidentRecord`** (widened 2026-09-06 — see below).
  *Acceptance: every test calls the pass directly; **no test starts the loop**.*

  **Two things task 5.3a built that this task must REUSE rather than rewrite, recorded 2026-09-06.**
  (a) `sweepObservations(assessment, saturation, context)` in `triage-verdict.ts` is the
  service-observation mapper. §12's Saturation block asks for *"no coverage issue was composed"*,
  which no probe could assert before a mapper existed, so it landed with 5.3a rather than here — the
  same hazard §13 named for task 5.4a, and the answer is the same: reuse it, and do not write a second
  one. (b) **The confirming probe is deduplicated HERE, not there.** §6.7 says the probe runs *"once
  per saturation candidate and never per sweep"*; Phase 5 has no cross-sweep state, so twelve
  consecutive saturated sweeps currently make twelve probes. ISC-730 pins one-per-candidate WITHIN a
  sweep; the across-sweeps half is this task's, and it is the half that decides whether the console
  can starve the inference server it is diagnosing.

  **`saveIncidentRecord` belongs to this task, and this line was too narrow to let it.** Task 5.6b
  left `IncidentRecord.undelivered[]` filled by `withUndelivered` with a `loadIncidentRecord` and no
  writer. Task 6.3 argued the writer is not the actor's, and the argument holds: §7.6's record is
  per-SUBJECT with its own schema and its own path helpers, all of which live in `triage-incident.ts`,
  so a writer that does not sit beside its reader becomes a second definition of where those files
  are; and **only the pass ever holds an `IncidentRecord`**. ISC-706 also pins WHERE in the sequence
  it persists — the record must be `clear` before the transport is called — which is a decision
  unmakeable outside the module that writes the sequence. Left unwidened, this task's implementer
  would be outside its own *Touches* line the moment it tried to persist, **which is exactly the
  constraint that made task 5.3c ship two `?`s it did not want** (task 5.3d).
- **6.2** **DONE 2026-09-06 — but see 6.1a: four of `SweepDriver`'s nine members are a refusing port.** `pifleet triage` with `--once`, `--poll`, `--status`, `--json`, and the loop's
  catch-and-continue — **which `--once` deliberately does not get** (`relay.ts:700-723`). Touches:
  `src/cli/commands/triage.ts` (new), `test/unit/triage-command.test.ts` (new), **`src/cli/index.ts`**
  (widened 2026-09-06 — omitting it meant the command was not registered in the shipped CLI, and
  `pifleet triage` nearly shipped where four separate surfaces reported it as present and an operator
  typing it got nothing; ISC-830 is now the guard).
  *Acceptance: the command is imported in-process by its own test, and its place in
  `test/unit/cli.test.ts`'s bidirectional `SRD_COMMANDS` set is settled — either the set gains
  `triage` and `Docs/SRD.md` §10 gains its row, or the exclusion list does. **§3.3: the
  command-wiring layer is the layer the coverage gate keeps catching.***
- **6.1a** **The five producers `SweepDriver` needs, and NONE of them was assigned to a task. Added
  2026-09-06 by task 6.2, which found them by walking every export in the console's own modules.**
  Four of `SweepDriver`'s nine members — `openSweep`, `dispatchObserver`, `join` and `collate` — are a
  refusing port in `src/cli/commands/triage.ts`, and `productionTriageDeps()` refuses both `--once`
  and `--poll` by name (ISC-809) rather than sweeping nothing and reporting success. **This is the
  task that makes the console able to sweep at all.**

  | Missing producer | Feeds | Was assigned to |
  |---|---|---|
  | §7.2's sweep-envelope renderer | `openSweep` | **nothing** |
  | §7.4's `observer-ops.json` → `ObserverArtifact` reader | `join` | **nothing** |
  | SRD-OBSERVER-001 §9.3's `blocked` extractor | `join` | **nothing** |
  | A path-reading wrapper around `parseTriageDocument` (it takes text only, deliberately) | `collate` | **nothing** |
  | The per-observer dispatch (`sendTaskEnvelope`) | `dispatchObserver` | task 6.7, ambiguously |

  **§7.2 in particular is described in full and assigned nowhere** — not in Phase 5, not in Phase 6.
  Writing the envelope inline in the command was refused for a stated reason and the reason is the
  acceptance criterion: it carries its own §7.2/§12.6 security contract — no credential, no host path,
  no raw command, and above all **not *"the contents of a previous worker's report as instruction"*** —
  which is a decision §12's mirror anti-criterion forbids living in an untested CLI layer one level
  down. Touches: `src/run/triage-envelope.ts` (new) and its test, `src/run/triage-document.ts`,
  `src/run/triage-verdict.ts`, their tests.
  *Acceptance: §12.6's envelope fixtures pass — a rendered envelope carries none of the four forbidden
  classes, asserted by NAME; and the anti-criterion that outranks them, that a previous sweep's report
  cannot reach the next sweep's brief as prose, on a fixture where the previous report contains a
  marker string.*
- **6.2a** **Move `incidentCensus` beside its readers. Added 2026-09-06 from task 6.2.** It lives in
  `src/cli/commands/triage.ts` because that is what 6.2's *Touches* line allowed, and by task 6.1's
  own recorded argument — *"a writer that does not sit beside its reader becomes a second definition
  of where those files are"* — it belongs in `triage-incident.ts` beside `incidentRecordPath` and
  `parseIncidentRecord`. ISC-804 travels with it unchanged. Touches: `src/run/triage-incident.ts`,
  `test/unit/triage-incident.test.ts`, `src/cli/commands/triage.ts`, `test/unit/triage-command.test.ts`.
- **6.3** The actor record, log and lock (per-console, from Phase 2.3) plus a `ConsoleWatch` over
  `tri-1`. Touches: `src/run/triage-actor.ts` (new), `test/unit/triage-actor.test.ts` (new).
  *Acceptance: §12's exit-when-the-console-is-gone criterion and its streak-reset mirror both pass.*
- **6.3a** **The abandonment sentence is review-console prose, found 2026-09-06 by task 6.3. DONE 2026-09-06** (ISC-780; a `Record<ConsoleName, …>` rather than a `switch`, so a third console is a `tsc` error rather than a silent fall-through).**
  `ConsoleWatch.observe`'s exit reason (`src/run/console-relay.ts:437-446`) hard-codes
  `scripts/review` and `SRD-REVIEW-CONSOLE §6.5, §9 Q4`, so a triage actor that reaps itself cites the
  wrong console and the wrong document on 6.2's stderr. Task 6.3's log event is unaffected — it
  carries worker, run and pass count as structured FIELDS rather than as prose, which is why this is
  cosmetic rather than a correctness bug — but the string a human reads is wrong. Touches:
  `src/run/console-relay.ts`, `test/unit/console-relay.test.ts`.
  *Acceptance: the reason names the console it was started for, asserted for BOTH consoles in one
  test — a fixture that only checks triage would pass an implementation that broke review.*
- **6.4** Resume-from-run-tree, and the anti-criterion that a restart never double-dispatches.
  Touches: `src/run/triage-pass.ts`, `test/unit/triage-pass.test.ts`, `ISA.md`.
- **6.5** Recycling (§6.6 layer 4): **four** `down`s and four `up`s between sweeps at
  `recycle_after_sweeps`, per-seat boundary condition, sweep counter carried across. Touches:
  `src/run/triage-actor.ts`, `test/unit/triage-actor.test.ts`, `ISA.md`.
  *Acceptance: the in-flight fixture recycles nothing; the idle fixture recycles all four; the sweep
  counter continues rather than resetting; **a fixture interrupted after two seats is completed by
  the next boundary rather than restarted**, asserted by naming the two seats it did NOT touch
  again; and **a fixture with one pin unresolved admits no sweep**. **This task is what makes an
  unattended console possible at all** — §2.3a — and it is buildable only because an `rpc` recreate
  needs no TTY. The four-run shape is §6.1's correction, not the heading's intent.*
- **6.6** **DONE 2026-09-06.** Add the read-only closure guard, mirroring `test/unit/monitor-readonly.test.ts` and scoped
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

> **SCOPE 2026-09-06, set by the operator: the `triage-console` branch ends after task 7.4.** The
> code and the operator skill go to PR and merge with the console complete; **Phase 8 then runs on
> `main` as its own piece of work**, and what it finds becomes a follow-up branch. This is what task
> 8.3 was always going to produce — §13 calls it *what the document did not predict* — and a
> day-long run plus its fix rounds is a poor thing to hold a reviewed branch open for. Two
> consequences worth stating: **Q11 (the ntfy token) and the `cni-dev` kubeconfig context stop
> gating this branch entirely**, and every criterion in Phases 0-7 must therefore be provable
> offline, which they are.


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
- `src/security/model-probe.ts` — `FetchLike` and `ProbeRequestInit` (the injected-`fetch` idiom this
  console's transport copies), `AbortSignal.timeout` at `:252`, `probeNativeToolCalls` at `:230` and
  `hostReachableBaseUrl` at `:603` (§6.7 rule 3's confirming probe), and the timeout-is-not-
  unreachable argument at `:257-270`.
- `src/monitor/read/docker.ts:122`, `:209-214` — `export type DockerPsRun`, and the optional-ports
  object with real defaults: the named-injected-seam pattern §6.9 and §7.8 both take.
- `src/config/schema.ts:672`, `:649-666` — `envVarNameIssue` and the docblock recording why the
  `api_key_env` rules are a shared function rather than a paragraph two schemas each remember.
  `notify.token_env` is the third door.
- `src/security/egress.ts:4-6`: *"Workers sit on an internal Docker network
  (`src/security/network.ts`), so the DEFAULT is that no destination is reachable at all."* That is
  what `egress.allow` governs, and it is why a host-side notifier needs no entry on it.
- `docs.ntfy.sh/publish/` and `docs.ntfy.sh/config/` — the topic-in-the-path form, the JSON-only-at-
  the-root call-out, the `Title`/`Priority`/`Tags` header aliases, the 1–5 priority scale, the
  `Authorization: Bearer tk_…` form and the `?auth=` form §7.8 refuses, the 1 KB title limit and its
  `400`, the request limiter behind `429`, and `/v1/health`. Read 2026-09-06.

**A rule for maintaining this document.** Cite the file the behaviour is *in*, never the file a
comment *says* it is in; and re-open the cited lines when editing the section around them.
`Docs/tools/check-srd-citations.py` exists for the sibling SRD and its limits are recorded there —
it verifies only citations carrying a tight anchor, and it catches three of four known drifts. **Do
not assert that citations have been verified unless it has been run and its output recorded.** This
document's §0.2 was found by following a citation into `fleet.yaml`, which is the argument for all of
it.
