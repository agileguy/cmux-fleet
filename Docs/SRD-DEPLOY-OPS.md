# System Requirements Document — the `observer` role

**SRD-OBSERVER-001 v0.1 — DRAFT FOR OWNER REVIEW**
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001). Where the two disagree, `Docs/SRD.md` wins and this
document gets the erratum.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operator spends a large share of his working day *looking at things he did not change*. A deploy
is merged and then watched — polled every few minutes for the better part of an hour, across a CI
server, a Kubernetes control plane, a log-query API and a dashboard, none of which agrees with the
others about whether it worked. Between deploys, the same operator is interrupted by questions with
the same shape and a tenth of the ceremony: *is this thing healthy, what do its logs say, why is it
restarting.* Both are read-only. Both are mechanical enough to write down — the operator has already
written them down, twice, as skills he runs by hand. Neither needs a frontier model, and both eat
the context of the session that happens to be open. `observer` is the pifleet role that takes them:
a containerised worker holding a read-only cloud identity, working from a skill document, that
answers a bounded question about a running system and returns a checked artifact saying what it saw,
what it could not see, and which of those two the answer rests on.

### 0.2 The decision that matters — one substrate, two modes

**The name and the two-mode scope are the owner's, not this document's inference.** The role was
specified as covering deploy pipeline monitoring and service checks before and after deploys, and
then widened in the next breath: *"this should not just handle deployments though. If I ask about a
service, we should be able to offload checking its logs and state to this agent. call it observer."*
So `observer` is a given, and the design question is only how the two modes relate.

The obvious shape is a deploy-monitoring role that later grows an ad-hoc-inquiry feature. That shape
is wrong, and building it would produce two divergent implementations of the same five problems.

**A deploy watch and a service inquiry differ only in what starts them and what ends them.**
Everything between is identical: resolve a name to a workload, work out which delivery mechanism
owns it, ask four observation channels that each lie in a different way, reconcile what they said,
and report with the gaps named. The deploy case adds a baseline taken beforehand and a termination
condition supplied by a pipeline. The inquiry case supplies neither — and is otherwise the same
machine.

So §4 defines the substrate once, and §5 defines the channels once, and the two modes in §7 are
specialisations that differ in their envelope and their stopping rule. This is not tidiness. It is
the difference between one set of channel-failure rules that gets hardened by every run and two sets
that each get half the evidence.

**The second decision, stated here because everything downstream assumes it: `observer` never
mutates anything, and that is enforced by the fleet rather than promised by the role.** §10 makes
the argument. It is short, because §5.10 of the main SRD already made it: mutating cloud verbs are
refused for every worker, permanently, by owner decision. `observer` does not need an exception and
must not be the reason one gets built.

### 0.3 Where the register comes from

`skills/ticket-ops/SKILL.md` is the precedent this document mirrors, in three specific ways worth
naming so a reader can check whether it was followed:

1. **Disclosure.** `ticket-ops` names a public SaaS vendor and the shape of its API, and nothing
   internal. Its endpoint arrives in a mounted file; its object ids arrive in the task envelope.
2. **Credentials.** Mounted read-only files, never environment values, never in `argv`.
3. **Verdicts.** A stated inability to answer beats a confident wrong answer, and the rule that
   decides `blocked` from `failed` is written down rather than left to judgement.

### 0.4 The disclosure boundary — a design requirement, not a redaction pass

`agileguy/cmux-fleet` is a public repository. That is a constraint on the *design*, not only on this
document's prose, and the constraint is this:

**Nothing site-specific may be knowable from the repository.** No CI hostnames, no cloud project
identifiers, no cluster names, no kubectl context names, no namespace names, no service names. Every
one of those arrives at runtime through a mounted secret file or a task envelope field, and the
repository carries only the *shape* — that there is a CI server with a REST API of a certain form,
that contexts follow a per-environment pattern, that namespaces are derived rather than guessed.

Two consequences that are easy to miss:

- **The `observer-ops` skill is mounted from this repository** (§5.4 of the main SRD copies
  `skills/<name>/` into the bundle). A skill document that names a real host to make an example
  concrete has published that host. Examples use `<ci-host>`, `<context>`, `<namespace>` — and §8
  requires that every such placeholder be a *field the worker reads*, not a string it substitutes,
  because a placeholder the worker is expected to fill from memory is a placeholder that becomes a
  guess.
- **`fleet.example.yaml` is committed; so, since 2026-09-12, is `fleet.yaml`** — this line read
  "`fleet.yaml` is gitignored" until then, and the ignore was dropped because the live config had
  drifted from the example with no diffable record of how. The example carries
  `example.com`-class values that resolve nowhere, so an unedited copy fails closed. `egressRuleHost`
  refuses a literal `<PLACEHOLDER>` string at load time, which is correct: a rule the matcher can
  never match silently denies the destination it was written for.

This document therefore uses `<ci-host>`, `<project>`, `<cluster>`, `<context>`, `<namespace>`,
`<service>`, and refers to environments as *development*, *staging* and *production* tiers across
*two product families*, one of which mirrors some workloads into a disaster-recovery region. Those
are the only topology facts the design needs. Public product names — Jenkins, Kubernetes, Helm,
Flux, Prometheus, Grafana, Google Cloud Logging, Google Cloud Monitoring — are named, on exactly the
basis `ticket-ops` names its vendor: they are public products whose API shapes are public, and a
document that will not name them cannot specify anything.

---

### 0.5 Evidence provenance — what rests on what

Sources differ in strength, and a reader deciding whether to trust a requirement should be able to
see which kind is behind it.

| Strength | Source | Used for |
|---|---|---|
| **Measured** | code in this repository, read directly, and probes run against the built image | every claim about the verb gate, the mount table, timeouts, secret delivery, and `credential: false`. §5.3's blocker and §10.1a's table were read out of `docker/verbgate` on 2026-08-31 and then **independently confirmed against the live image**: `gcloud logging read` exits 77 while `gcloud logging list` passes, `kubectl events` exits 77 while `kubectl get events` passes, and `kubectl auth can-i` exits 77 |
| **Codified** | the operator's own skill documents | the phase structure, the poll cadence, the convergence predicate, the before/after classification, the failure-diagnosis walk, and every "surface it, never click it"-class prohibition. These are the operator's own written rules, so they are strong evidence of intent even where no session was observed following them |
| **Recorded** | the operator's dated findings and session history | every named failure — the false-greens, the nine-hour GitOps blindness, the empty-log false negative, the permission asymmetry, the naming mismatches, the frequency ratio, and the pushback pattern in §9.2 |
| **Inferred** | reasoning from the above | the two-mode unification (§0.2), the status/subject-state inversion (§9.1), the verdict rule (§9.2), the one-pass-per-task watch (§7.5), and the whole of §6's configuration. **These are design proposals, not observations, and they are where the owner's review is most valuable.** |

Two specific corrections to the premises this document was commissioned against, both recorded
rather than silently accommodated:

- **The permission gap is wider than briefed.** It was described as `pods/log` and `pods/exec`; it
  also covers `secrets` get and list, which takes out `helm history` and `helm list` entirely on one
  production tier. §5.2.
- **`gcloud logging read` does not currently run in a worker at all.** The brief assumed the log-query
  API was available as the fallback channel. It is refused by the verb gate. §5.3.

#### How the corpus was found, and what that cost

**The real deploy corpus was located late, after two of this document's headline conclusions had
already been drawn from the wrong material — and both were wrong.** The record is kept because it
explains why the earlier draft said what it did, and because it is a caution for anyone re-mining
this ground.

The per-repository transcript directories named after the deployment repos contain almost no genuine
sessions; they are dominated by short automated sidecar runs that reconstruct a truncated view of a
conversation rather than recording it. **The driving sessions live in the operator's own home
project directory even when the target was a deployment repo**, because that is his interactive
working directory and the skills reach out into the target repos from there. Of roughly 1,100 files
there, **seven carry a genuine deploy-monitoring invocation marker** with real tool calls,
timestamps and polling. That is the load-bearing set.

The two corrections that came out of it:

- **The live watch *is* delegated.** An earlier draft concluded that the operator does the waiting
  himself and delegates only post-hoc verification. False — full "merge, monitor, check logs before
  and after" invocations are real, and post-hoc is one of three weights (§1.1).
- **Pre-deploy baselines *are* captured**, verbatim and routinely, for the live-watch shape. An
  earlier draft concluded they were never taken and inverted the requirement (§2.1 Phase A).

Both are now corrected against the raw transcripts. Anything in this document that survived from
before that discovery has been re-checked against it.

Three remaining gaps, named rather than papered over:

- **The failure classes the brief supplied — image-pull and crash-loop backoffs, the benign
  volume-attach warning, StatefulSet update-revision tracking, and gate stalls — appear only in an
  uncommitted working-tree addition to the operator's skill file dated 2026-08-23**, which postdates
  the entire mined window. They are real and this document cites them, but they are **codified, not
  observed**, and no transcript evidence for them exists in the corpus searched.
- **There is no session directory at all for one of the two product lines.** Monitoring work on it
  either ran from the home project directory or was never logged, so nothing in this document rests
  on observed practice specific to it.
- **The three invocation weights and the cadence figures rest on a seven-file sample.** They are
  consistent and they match the operator's own written cadence table, but they are not a large
  sample, and §12's questions are weighted accordingly.

---

## 1. Problem statement

### 1.1 What the operator does by hand today

Two activities, with very different profiles.

#### Three invocation weights, and the role must carry all three

A deploy request does not arrive in one shape. Three distinct weights appear in the transcripts, all
routing through the same skill, and a design that implements only one of them is wrong in a
different way for each of the other two.

| Weight | What the operator says | What it wants |
|---|---|---|
| **Full live watch** | *"merge, monitor through jenkins and k8s deploy checking logs before and after"* | baseline → merge → poll to terminal → converge → before/after diff → functional check → report |
| **Light-touch** | *"I merged this ⟨PR⟩ please open its jenkins pipeline in my browser"* | exactly that, and nothing else. One observed session ended ~21 minutes later with no polling at all |
| **Post-hoc** | *"I have merged this and the pipeline is complete. Please check on the deployment and logs before and after"* | verification only; the pipeline has already finished |

**The distinguishing signal is in the instruction itself and must be read, not assumed.** A worker
that answers a light-touch request with a full watch has burned a run on work nobody asked for; one
that answers a full-watch request with a post-hoc check has skipped the baseline and the poll. The
envelope therefore carries the weight as an explicit field (§7.2), and the orchestrator sets it from
the operator's phrasing rather than defaulting.

**The handoff can also be a human message.** In one recorded session the assistant announced it was
polling a running build and the operator interrupted with *"I will tell you when it is done so you
can check logs etc"* — then sent *"it's done, check the logs"* **three times** when the assistant was
slow to act on the signal, the session's own sidecar recording frustration at having to repeat it.
That is not evidence against watching; it is a fourth thing the design must support: **an operator
who elects to own the waiting, and a dispatch triggered by his signal rather than by discovery.**

So the role supports being told to watch, being told to open a page, being told to verify after the
fact, and being told to wait for a human "go". The cost of getting this wrong is asymmetric —
over-executing a light-touch request wastes a run, but under-executing a full watch means the deploy
went unobserved.

**Watching a deploy.** A tag-bump PR is merged into a long-lived pipeline branch; the merge *is* the
deploy. From that moment the operator is committed to a loop that runs for tens of minutes: resolve
which pipeline the base branch maps to, find the build, poll its stage list, compare Helm revisions
between the primary cluster and its DR mirror, look at pod state, and — on a failure — walk the CI
server's node graph to find the stage that actually failed and the node that printed the log. The
operator's own `deploy-monitor` skill codifies this and gives the cadence explicitly: **270s while a
build has started but not signalled, 120–180s when completion is imminent, 240–300s across a long
Terraform or Helm stage, and 1200s once the build has failed and is waiting on a human fix** — with
a note that 300s exactly is the wrong number because it "pays the cache miss without amortizing".
The loop is not a blocking sleep; it reschedules itself. **A single watch therefore spans well past
an hour of wall-clock, during which the operator's session is pinned to a task that produces one
line of new information every four minutes.**

And the watch does not end when the pipeline goes green. A green build is the *start* of
verification, not the end of it — §1.3 is about why.

**Answering a question about a running service.** Far shorter, far more frequent, and
interrupt-shaped. The operator names a service the way a person names it — often a nickname that is
not the namespace, not the deployment, and not the repository. Resolving that name is itself a step,
and it is a step that has gone wrong: a request to check "the `<service>` namespace" found no such
namespace, because the workload lives under a longer, subsystem-prefixed name and the short name
exists only in conversation.

**One correction to the obvious assumption, because it changes the envelope.** The expected form was
an abstract health poll — *is it up, is it healthy, what's the status.* **That form was not
observed.** Real inquiries are always anchored to a **named signal**: a disk filling, a queue
depth, a notification channel, an alert that did or did not fire, a metric that stopped flowing, a
specific error string. The operator does not ask whether a service is well; he asks about the thing
he already suspects. So §7.3's `question` field is a *named signal*, not a generic health request,
and a worker that answers with a general status sweep has answered a question nobody asked.

### 1.2 Which of the two is the bigger win

Deploy watches are the *expensive* activity per instance. **Ad-hoc inquiries are roughly an order of
magnitude more frequent** — session history over the sampled window shows around fifteen times as
many ad-hoc investigations as explicit deploy-monitoring invocations.

The sharper finding is not the ratio but the *interleaving*: **deploy-monitoring threads are
routinely interrupted by ad-hoc investigation of unrelated services.** One multi-day deploy thread
carried at least eight distinct tangents, each one displacing the watch that was supposedly in
progress. That is the strongest available argument for two things this document does: treating
inquiry as a peer mode rather than a feature of the watcher (§0.2), and running **two** `observer`
workers so a watch and an interruption do not contend (§6.2).

> **Evidence status.** §2 reconstructs both workflows from the operator's own skills and from
> session history. Where a claim rests on the skills — which are a *codification* of the workflow,
> written by the operator, and therefore strong evidence of intent — rather than on an observed
> session, this document says so.

### 1.3 Why this is not "run the skill in a container"

Four reasons, each of which is a section below.

1. **The observation channels disagree, and each lies in a characteristic way.** A green CI stage
   does not mean the effect happened — there are three independently recorded cases (§5.1). An empty
   log query does not mean the service is idle — it once produced a confident false "not deployed"
   (§5.3). A `Ready` pod does not mean a working pod (§5.2). The value of this role is entirely in
   handling those correctly, and a role that trusts any single channel is worse than no role,
   because it produces confident wrong answers at machine speed.

2. **Reachability is a first-order design problem, not an error path.** The Kubernetes control plane
   is reachable only over a corporate VPN tunnel. A worker container may have no route to it at all.
   §5.5 defines what the worker does then, and the answer is not "fail".

3. **The credential is asymmetric across environments.** The operator's identity lacks
   `pods/log`, `pods/exec` **and `secrets` get/list** on exactly the two highest tiers of one product
   family. The `secrets` half is the one that bites: Helm 3 stores release state in namespace
   Secrets, so `helm history` and `helm list` **do not work at all** on the production tier of that
   family. A design that assumes `kubectl logs` and `helm history` everywhere is broken precisely
   where it matters most (§5.2).

4. **A watch is not shaped like a task, even when it fits inside one.** pifleet's
   `per_task_timeout` is 25 minutes and `event_stall_kill` is 25 minutes — and the latter fires on
   *silence*, so a worker sleeping quietly between polls is a worker killed as wedged. Measured
   merge-to-report times are 10–18 minutes, so most watches would in fact fit; but a watch that
   stalls on a human approval gate, or a finding that needs re-checking the next day, does not.
   §7.5 makes one task one observation pass for that reason, and because it is what makes a watch
   survivable across a slept laptop.

### 1.3a What the role is actually worth — the findings come from next door

The clearest argument for building this is not that deploy verification is tedious. It is that
**the highest-value catches in the observed sessions were not about the deploy under test.** In at
least three cases the deploy itself was clean at every pipeline, Helm and pod level, and the finding
came from something adjacent that the verification happened to walk past:

- **A collector silently dead for roughly three months**, found incidentally while checking something
  else. Nothing had alerted on it in that entire period.
- **A workload that had ingested nothing for three hours** while reporting `2/2 Running` with zero
  restarts, because its readiness probe tested a generic HTTP endpoint rather than the ingestion
  path.
- **A dual-writer race in a rolling deploy**: old and new pods running fixed, non-jittered timers on
  the same interval, so their writes permanently collide inside the destination's deduplication
  window. Structurally invisible — both pods healthy, both doing exactly what they were told.

The operator's own summary of one of these is the line to design against: ***"This is a regression,
and nothing alerted on it."***

Two consequences. First, this is the strongest available justification for **verifying at the sink**
(§2.1) rather than at the pipeline — every one of these passed every upstream check. Second, it is an
argument for the role being *cheap enough to run often*, because the value came from routine
verification sweeping past adjacent state, not from a targeted investigation anyone commissioned. A
role that is expensive to invoke will only be invoked when something is already suspected, which is
exactly when these findings do not happen.

### 1.4 Success in one sentence

The operator merges a deploy PR or asks a question, dispatches one envelope, and gets back a
structured artifact whose claim of "clean" is backed by an observation of the *effect* and whose
claim of "I don't know" is backed by a named channel that would not answer — with the operator never
having polled anything himself, and never having to guess which of those two he received.

---

## 2. The workflow as practised

This is the heart of the document. The phases below are named so §7, §8 and §9 can refer to them.

### 2.1 Deploy-bound observation

**Where it begins.** A merged PR into a long-lived pipeline branch. Not a ticket, not a tag bump in
isolation — the *merge* is the trigger, because merging is what runs the pipeline. The operator says
some variant of "monitor this PR" / "watch this through Jenkins" / "check on the deploy".

The merge itself is a human decision and stays one (§11). The operator's fanout skill is explicit:
*"Do not merge on your own initiative. Confirm with the user which PRs are ready to merge and when."*
`observer` starts after that decision, never before it.

**Phase A — the pre-deploy baseline.** Captured *before* the merge, and **observed being captured**:
the assistant announces it (*"Let me capture pre-deploy k8s baselines before merging, then merge all
5"*), confirms it (*"Baseline captured. Merging all five now…"*), and states its content in terms
that are already a verdict (*"Baseline clean — 0 app-container error rows… single pod, up since
⟨date⟩, 0 restarts. Merging:"*). Alongside the workload state, a **fixed 30-minute BEFORE log window**
is captured pre-merge specifically so it can be diffed against an equal-length AFTER window in
Phase C.

**The baseline is conditional on invocation weight, and this is the requirement.** It is standard
practice for the full live watch, where the merge has not happened yet and there is something to
baseline. It is **absent by construction** for the light-touch and post-hoc shapes, because by the
time the operator asks, the pipeline has already run. A design that makes it mandatory cannot serve
two of the three shapes; a design that omits it degrades the one shape where it is genuinely
available.

**The fallback, for the shapes with no baseline, is to date the anomaly.** A post-deploy error is
attributed or dismissed by finding when it was *first seen* and comparing that to the deploy window —
observed verdicts read *"pre-existing from ⟨date⟩"* and *"pre-existing since ⟨date⟩"*, each ruling out
a regression with no captured "before" state. Dating needs no forethought and works on a deploy
nobody planned to watch. **It is the fallback, not the general method**, because it can only speak to
anomalies that leave a datable trace, where a baseline captures the whole state.

The two findings below explain why the *comparison* — however obtained — is load-bearing:

- **A pre-existing error is not a regression.** Phase C classifies log errors into three buckets and
  only one of them matters; the discriminator is whether the same pattern was already firing at the
  same cadence beforehand. Without a baseline that question cannot be asked, and the failure mode is
  reporting someone else's long-standing broken integration as your deploy's regression. That is not
  hypothetical — a recorded verification run found a third-party notification integration returning
  403 continuously, and correctly classified it as pre-existing rather than as the deploy's doing.
- **Counts hide things that names reveal.** A recorded case: a chart-version bump quietly carried an
  unrelated new item forward, so the post-deploy count was one higher than predicted. A count
  baseline would have flagged a phantom problem; a *name* baseline (`comm -13 before after`) named
  the actual extra item. **Baselines are sets of identifiers, never cardinalities.**

**Phase B — the watch.** Resolve the pipeline from the PR's base branch; resolve the target clusters
from the pipeline's own deploy descriptor rather than guessing them; then poll. Per poll: the
build's status and stage list, the Helm revision on primary and DR, and DR workload state. The
cadence table in §1.1 is the operator's, and §7.5 explains why a pifleet worker cannot implement it
as written.

Three things the watch must recognise that a naive poller does not:

- **A stage list is not ordered by causality.** A cleanup stage runs *after* the failure and
  succeeds, so the last stage in the list is routinely green on a failed build. The rule is to scan
  for `status == "FAILED"`, never to read the tail.
- **The build number lags the merge.** Immediately after a merge, the CI server's "last build" is
  the *previous* one until the webhook propagates, and a stale last-build is indistinguishable from
  "no build triggered yet". The build's timestamp must be compared against the merge time before it
  is trusted.
- **A pipeline can block on a human approval gate for up to an hour**, and there may be one gate per
  target cluster, so a two-cluster pipeline blocks twice. §11 covers what the worker does about it.
  The short version: it reports, and it does not click.

**Phase B′ — backfill, when a watch resumes after a gap.** A watch is a sequence of dispatched
passes (§7.5), and the sequence can be interrupted — a closed laptop, a run that ended, an operator
who stopped dispatching and picked it up later. **The deploy carried on regardless.** So a resuming
pass must first account for the interval it was not looking at, bounded by the last recorded
observation timestamp and now — which is what makes §12 D13's timestamp requirement load-bearing
rather than tidy bookkeeping: **the backfill window is computed from it.**

**Backfill reads history, not state.** This is the whole point and it is easy to get wrong. A fresh
point-in-time read answers "what is true now" and is blind to anything that started and cleared
inside the gap — a crash loop that recovered, a pod that was evicted and rescheduled, a rollout that
stalled and then completed. **That transient class is precisely what §1.3a says the role exists to
catch**, so a resume that only re-reads state has skipped the interesting part. Three signals, read
across the gap:

| Signal | What it proves | Retention |
|---|---|---|
| **Restart counts** | a restart happened, even with no surviving trace of it | **cumulative — survives an arbitrary gap** |
| **Log deltas over the window** | what was happening, in the workload's own words | days |
| **Cluster events** | scheduling, eviction, image-pull and probe failures | **shortest — order of an hour** |

The retention ordering is the operational point. **Restart counters are the only signal that
survives an arbitrarily long gap**, which is why they are named separately rather than folded into
"state": a counter delta is evidence of an event whose log and event record have both expired. Events
expire first, so a gap of a few hours already loses them while logs remain.

**When the gap outruns retention, that is a `coverage: partial`, recorded — not papered over.** The
artifact names which signal was lost and over what interval, and the assessment falls to
`indeterminate` for anything that signal alone would have decided. §9.2's rule applies here exactly
as it applies to an unreachable channel: an unobserved interval is not a clean interval.

**Phase C — post-deploy verification.** A green build is not the end. It is the input to a separate
workflow whose entire premise is that the pipeline's verdict is insufficient. Verification has two
halves:

- **The rollout actually converged.** Not `readyReplicas`. §5.2 gives the predicate and the three
  successive refinements it took to get right, each one prompted by a real false-green.
- **The effect is visible and nothing new is broken.** ERROR-severity logs are pulled for two
  roughly equal windows of 15–30 minutes straddling the deploy timestamp, and every distinct pattern
  is classified as *severity misclassification* (the log router mistags routine informational output
  as ERROR), *pre-existing* (same pattern, same cadence, in the before window), or *genuine new
  regression* (present only after). **Only the third blocks.** And the workflow is explicit that raw
  counts are misleading and that message text must be read, not the severity label.

  Then the application-level check, whose necessity is stated flatly in the operator's own words:
  *"'No errors in logs' isn't proof the change actually took effect."* For a rule change, the rule
  is fetched from the running server and its health field is read. For a dashboard, the dashboard is
  fetched by uid. The generalisation is §5's organising principle: **verify the effect, at the layer
  that would show it.**

#### Verify the sink, not the pod — the single most load-bearing practice observed

This is the practice that most distinguishes a real verification from a plausible one, and it is
**underspecified in the operator's own skill** — it shows up in what he actually does rather than in
what the skill tells you to do.

**Pod-Ready is explicitly treated as insufficient.** The real checks query the *destination* of the
data directly — the metrics store, the warehouse, whatever the workload writes into — rather than
trusting that a scrape target exists or that a process is up. Where the workload is driven by a
schedule, verification waits for the first live post-deploy execution to complete rather than
inferring from configuration that it will.

**And "clean" is tied to freshness at the destination.** Observed confirmations are of the form
*data landed within the last 25–35 seconds of now* — a statement about the sink, timestamped, not a
statement about the source. Pipeline SUCCESS never earns a clean verdict on its own, and §9 records
that helm-revision-match was **never** the deciding factor in any observed declaration, even though
the skill lists it as a step.

The reason this matters more than any other rule here is that **the structurally-correct-but-
functionally-dead case is real and recurs**: a workload reporting `2/2 Running` with zero restarts
that had ingested nothing for three hours, because its probes only checked a generic HTTP endpoint
and not the path that does the work. Every layer above the sink said healthy.

#### The post-deploy checklist, in observed order

Each step is necessary and none above the last is sufficient:

1. **Pipeline build state** — necessary, never sufficient.
2. **Commit SHA match** against the merge commit — proves the build built *this* change.
3. **Helm release state.**
4. **Image tag on the live pod** — the deployed artifact, not the intended one.
5. **Rollout mechanics** — new replica set up, old one at zero (§5.2's predicate).
6. **Per-named-pod ready, restart count and events** — per pod, named, not aggregated.
7. **Service endpoints repointed.**
8. **Before/after log diff over equal windows** (§2.1 Phase A).
9. **Functional check — always last, and the one that decides.**
10. **Cross-environment spot-check**, where the change landed in more than one place.

Steps 2 and 4 deserve emphasis because they catch different failures: a SHA match proves the
pipeline built the merge, and an image-tag read proves the cluster is *running* what the pipeline
built. The recorded wrong-file case (§5.1) passes step 1 and fails step 4.

**Phase D — failure diagnosis.** On a failed build: find the failed stage by scanning for the failed
status; drill into its flow nodes; find the node that printed the log file (recognisable because the
failing shell node has an empty description and the *succeeding* node right after it is the one that
prints the log); fetch that node's log and read its tail. Then match the excerpt against a table of
known bug classes. The operator's table has five entries with distinct fixes, and — importantly for
a small model — matching is on a literal error substring, not on interpretation.

The most valuable row is the one that is *not* a pipeline bug: a build that succeeded while pods sit
in `ImagePullBackOff` or exceed their progress deadline is an image-tag or registry-mirror problem,
and no amount of re-reading the pipeline will show it.

**Phase E — reporting.** A fixed-shape report per phase, and — when the work belongs to a ticket —
a write-up appended to the ticket by the `ticketing` role, not by this one. The division is
deliberate and §3 keeps it: `observer` produces the evidence; `ticketing` owns the write credential
and the vendor's rich-text rules. A role that holds both a cloud identity and a write credential to
a shared system of record is a strictly larger blast radius for no gain.

That handoff already exists in the operator's own tooling: the ticket write-up workflow takes a
build result and a verification result *per environment* as its inputs, and is explicit that it must
not be drafted until both exist for every environment in scope — or until the operator has said the
verification is unavailable. **`observer`'s artifact is precisely that input**, which is a strong
argument that the artifact schema in §8 should carry those two fields per environment as first-class
values rather than leaving them to be read out of prose.

**Phase 0 — check the premise.** Placed last because it was found last, and it belongs first. A
recorded exchange opens with the operator stating that a deploy had completed and asking for the
post-deploy verification; the correct answer was that **the deploy was not complete — it was stuck,
with pods failing to pull an image tag that had never been built.** The assistant contradicted the
premise rather than verifying on top of it.

This generalises into a requirement that is cheap and prevents a whole class of confident wrong
answers: **an `observer` task that is told a state must confirm that state before reasoning from
it.** A deploy asserted complete gets its convergence checked before its logs are classified;
otherwise the before/after windows straddle an event that never happened, and the resulting "clean"
is a statement about the wrong moment in time.

### 2.2 Ad-hoc service inquiry

**Where it begins.** A sentence. There is no pipeline, no merge, no baseline and no supplied
termination condition. The operator names a target — sometimes a service nickname, sometimes a
deployment name, sometimes only a symptom — and expects a short answer.

**The shape of the work.** Resolve the name to a workload (§4.1); establish which delivery mechanism
owns it (§4.2); read its current state; read recent logs; look for anomaly signatures; report. The
signatures worth naming, because they are the ones that recur: `CrashLoopBackOff`,
`ImagePullBackOff`, `OOMKilled`, `Evicted`, pods `Pending` or `NotReady`, restart counts climbing,
init containers that never terminated cleanly, and — the subtle one — a workload that is `Ready` and
wrong.

**The target is not always a Kubernetes object.** Observed inquiries also target a managed instance
group, cloud NAT routers, a message-queue topic and its subscriptions, and the reachability of a URL
*from inside* the cluster. The first three are answerable with read verbs on the cloud API and
belong in scope. **The last is not: reaching an in-cluster endpoint needs `kubectl exec`, `run` or
`port-forward`, and all three are refused (§10.1a).** In-cluster reachability probes are therefore
out of scope for v1, and the skill must say so rather than let a worker discover it as a refusal.

**Why it is not simply "run kubectl and paste".** Four reasons, all of them the substrate's:

- The name has to be resolved, and it does not resolve by string equality (§4.1).
- The delivery mechanism determines where "should be" is written down (§4.2).
- The log channel may be the only one available, or may be forbidden on this tier, and its
  absence-of-data is not evidence of absence (§5.3).
- The honest answer is often "I could see this much and not that much", and that has to be
  *reportable* rather than rounded to a verdict (§9.2).

### 2.3 What the two share — and it is nearly everything

| Step | Deploy-bound | Inquiry |
|---|---|---|
| Resolve target name → workload | from the pipeline's deploy descriptor | from the envelope, possibly via a nickname |
| Determine delivery mechanism | needed, to know if a pipeline even exists | needed, to know what "should be" means |
| Consult channels | all four | all four |
| Reconcile disagreement | yes | yes |
| Reachability degradation | yes | yes |
| Report gaps as gaps | yes | yes |
| Baseline beforehand | **yes** | no — nothing to compare to |
| Termination condition | **supplied** (build terminal + rollout converged) | **not supplied** — bounded by the envelope |

Two rows differ. Everything else is one implementation.

---

## 3. Scope and non-goals

### 3.1 In scope

- Watching a deploy that a human has already triggered, and reporting its progress and outcome.
- Verifying, after a deploy, that the intended effect is visible and that no new error pattern
  appeared — with pre-existing and misclassified noise separated out.
- Diagnosing a failed pipeline build to the point of naming the failed stage, the error excerpt, and
  the bug class where the excerpt matches a known one.
- Answering a bounded question about a named running service: state, recent log signal, anomalies.
- Saying precisely what could not be observed, and why.

### 3.2 Non-goals, and what stays with the human

**Triggering, merging, re-running, or rolling back anything.** The merge decision is the deploy
decision. The operator's fanout skill already requires confirmation before merge and requires
surfacing — not resolving — a merge blocked by branch protection. Nothing in `observer` touches it.

**Clicking an approval gate.** Stated in the operator's own skill and adopted verbatim as a
requirement: *"This is an approval belonging to a human — surface it, never click it."*

**Any mutation at all.** No scale, no restart, no delete, no Helm operation, no Terraform apply, no
ticket write, no git push. §10 explains why this is currently enforced by the fleet rather than by
this document, and why that is the right place for it.

**Deciding to promote to a higher tier.** A worker that decides on its own when a change reaches
production is not the deliverable. Tier promotion is a human decision with a human's context.

**Writing the ticket.** `ticketing` does that, from `observer`'s artifact (§2.1 Phase E). Note that
the ticket workflow also treats a **state transition** — moving a ticket to accepted — as requiring
explicit instruction and never inferring it from "everything verified". `observer` produces no state
transitions of any kind, in any system.

**Opening PRs, fanning changes out across repositories, classifying new alert types.** That is the
fanout skill's territory and it is a *write* activity. Explicitly out.

**Deciding that a finding is an incident.** `observer` reports a new error pattern. Whether that is
a page, a ticket, or a shrug is not its call.

### 3.3 Deliberately deferred

- **Autonomous watch scheduling.** The orchestrator re-dispatches (§7.5). A worker that schedules
  its own next wake-up is a second scheduler in a system that has one.
- **Cross-run trend memory.** Each task is stateless apart from what its envelope carries. A
  baseline store that outlives a run is a real feature and a separate design.
- **Metric-value judgement.** `observer` can report that a metric feed stopped. It does not decide
  that a latency figure is bad.

---

## 4. The substrate

Everything in this section is shared by both modes and must be implemented once.

### 4.1 Target resolution — a name is not a namespace

The operator names things the way people do. The resolution rules, in order of preference, each of
which is deterministic and checkable:

1. **The envelope names the resolved target.** Environment plus namespace plus workload, supplied by
   the dispatcher. This is the preferred shape and §7 makes it the default.
2. **The pipeline's own deploy descriptor names it.** For deploy-bound work the target clusters and
   namespace are read out of the descriptor committed on the pipeline branch, not derived from the
   branch name. **This is a hard rule, from a measured failure: the pipeline branch name and the
   namespace are not the same string.** One recorded case has an unhyphenated branch token against a
   hyphenated namespace, so a substring search for the branch's token returns nothing and reads as
   "the namespace does not exist". A second has one branch in a family spelling out a tier suffix in
   full where its four siblings abbreviate it, so a loop that constructs the name by appending the
   abbreviation silently 404s on exactly one pipeline.
3. **The CI stage name spells the namespace verbatim.** Where the descriptor is awkward to reach,
   the initialisation stage's own name contains the namespace as a literal. This works for every
   pipeline and needs no repository checkout.
4. **Substring search over the namespace list, recorded as an inference.** The fallback for a
   nickname. A recorded case: a short subsystem nickname resolves to a namespace that contains it as
   an infix behind a product prefix and ahead of a tier suffix, and a direct lookup on the nickname
   404s. When the worker resolves this way it **records the candidate set it saw and the one it
   chose** — because a nickname matching two namespaces is an ambiguity a human must settle, not one
   the worker should break.

**Never construct a namespace by string-templating a branch name.** That is rule 2's whole point.

**A namespace may host more than one release.** Resolution produces a workload, not just a
namespace, and a report that names only the namespace when several releases share it is ambiguous.

#### How the operator actually names a target, and the mode that breaks a worker

Four forms appear, in decreasing frequency:

1. **A service or component nickname** — the common case, and the one rule 4 exists for.
2. **An environment shorthand plus a nickname** — the same, with the tier disambiguated.
3. **A literal infrastructure name** — used when a nickname has already failed to resolve. The
   observed pattern is an escalation: the operator opens with the nickname, the resolution comes back
   ambiguous or empty, and he drops to the exact resource name. **That escalation loop is precisely
   what §4.1's rule 4 prescribes — report the candidate set, pick nothing — and it is confirmed as
   the operator's own preferred repair rather than an imposition.**
4. **Nothing at all.** *"are they all still running"*, *"check the logs"* — where the referent lives
   only in the preceding conversation.

**Form 4 is the one that breaks a worker, and it is not rare.** A pifleet worker has no
conversational context: it receives a brief and nothing else. A dispatch carrying an unresolved
pronoun is a task that cannot be started, and the worker's honest response is `blocked` — which is a
poor outcome for a question the orchestrator could have resolved before dispatching.

**Requirement: the orchestrator resolves the referent before dispatch.** The envelope's `target`
carries a name the worker can act on without knowing what was said five minutes ago. This is a
constraint on the *dispatcher*, not on the worker, and it is the single biggest behavioural
difference between asking the question in a session and offloading it.

### 4.2 Delivery-mechanism detection — a requirement, not an assumption

Not every workload reaches a cluster through the CI server, and assuming otherwise has already cost
nine hours of blindness. The recorded case: a subsystem migrated to GitOps reconciliation, its old
CI pipeline branch dead for months, and **six of its seven deployments sat in `ImagePullBackOff` for
over nine hours, completely invisible to any pipeline-status check, because there was no build to
watch.** The release tag the manifests asked for did not exist; the source resolved a release
candidate instead. Five of the six were degraded but still serving from an older replica set; one
was fully down. A downstream scheduled job failed on every run because the thing it depended on was
not running.

#### Ownership is two independent axes, not one enum

The obvious model is a single "who owns this target" field. That model is wrong, and the recorded
case above is why: **"was the image built" and "was the image deployed" are different questions,
answered by different servers, and a target can fail either one while passing the other.**

| Axis | Question | Answered by |
|---|---|---|
| **Deploy owner** | did the intended version reach the cluster | a CD pipeline, or a GitOps reconciler |
| **Build owner** | does the intended version exist, and if not, why | the image-build CI server (D4), corroborated by the registry |

The worker establishes **both** before it decides what "healthy" means. Deploy owner first:

| Signal | Deploy owner | Where "should be" is written |
|---|---|---|
| Pipeline branch carries a Helm command descriptor | CD pipeline + Helm | the pipeline branch's values files |
| Pipeline branch carries a GitOps command descriptor | GitOps | a *different, shared* deploy-config repository |
| Reconciliation and source objects present in the namespace | GitOps | as above |
| Neither | unknown | **report it — do not assume a CD pipeline** |

**Why the second axis earns its cost, using this section's own worked example.** The nine-hour
blindness case had **no deploy-side pipeline at all** — the workload was GitOps-reconciled and its
old pipeline branch had been dead for months — and the actual fault was on the *build* side: the
release tag the manifests asked for did not exist, so the source resolved a release candidate
instead. With only the CD servers in scope, that incident is diagnosable to "pods cannot pull an
image" and no further. **The image-build channel is what turns that into a cause.** D4 is therefore
not scope creep; it closes the gap this very section was written to name.

**The registry is a cheaper corroborating channel, not a substitute.** A registry read answers *does
this tag exist* with the cloud identity the worker already holds and no extra credential — so it is
the right first probe, and it is often enough to explain an image-pull failure. It cannot answer
*why the build that should have produced it failed*, which is the question D4 was decided for. Order
of use: registry first because it is cheap, build server when the answer is "the tag is absent" or
"the build failed".

Three consequences the worker must carry:

- **For a GitOps-owned target, pipeline status is not merely unavailable — it is meaningless**, and a
  worker that reports "no recent build" as a finding has said nothing. The correct observation is
  the reconciliation object's own status and the workload's actual image against the intended one.
- **A dead pipeline branch is not evidence of a dead service.** The branch in the recorded case still
  existed and was still committable; it had simply stopped being the delivery path. Reading its git
  history to explain a live incident is time spent on the wrong artifact.
- **There is more than one CI server.** The development tier and the staging/production tiers are
  separate deployments with separate credentials, and image-build CI is a third instance again
  against which the deploy credentials return a 404. **A credential is bound to a host**, and using
  the wrong pair produces an authentication failure that reads like a missing job. §6.5 makes the
  binding explicit in configuration rather than leaving it to the worker to infer.

### 4.3 The evidence ledger

Every observation the worker makes is recorded as a triple — **channel, question, answer** — plus
whether the channel answered at all. This is not bookkeeping; it is what §9.2 reads to decide
whether a "healthy" is a healthy or an "I couldn't see". The artifact schema in §8 makes it a
required array, for the same reason `ticket-ops` requires `queried[]`: an artifact whose prose says
one thing and whose machine-readable half says another is contradicting itself in the half that gets
read mechanically.

---

## 5. Observation channels and their failure modes

Four channels. For each: what it can tell you, when it lies, and what happens when it is unreachable.

### 5.1 The CI pipeline API

**Shape.** A REST API on the CI server: a job endpoint for current state, a per-build endpoint for
result, a workflow endpoint for the stage list, a per-node endpoint for a stage's flow nodes, and a
per-node log endpoint. Read with `curl` and parsed with `jq` — both in every worker image — for the
same reason `ticket-ops` uses `curl` against the ticket vendor: a vendor CLI would put a vendor's
name in the image hash and in a public repository.

**What it can tell you.** Whether a build exists, whether it is running, which stage it is on, which
stage failed, and — through the log node — the error text.

**When it lies.** This is the channel with the most recorded deceptions, and they are the reason the
whole role exists.

- **A green terminal result does not mean the effect happened.** Three independent recorded cases:
  (i) a deploy PR edited the wrong file of the two that carry an image tag, so the build ran green,
  the release's values still held the old tag, and no pod ever restarted; (ii) a dashboard-provisioning
  stage went green while the dashboard was rejected on save and returned 404 from the API — dozens of
  times across two environments; (iii) a build flipped to `SUCCESS` while the namespace still held
  two active replica sets, because **the result fires when the API server accepts the manifest, not
  when the rollout converges.** The generalised rule from the operator's own notes: *"Never evaluate
  rollout criteria at the instant the build result flips; poll the cluster to convergence
  independently."*
- **A green *last* stage does not mean a green build.** A cleanup stage runs after the failure.
- **The "last build" lags a merge.** §2.1 Phase B.
- **A blocked human gate looks like a slow build.** And a gate can block even when its plan reports
  no changes, because the approval step is unconditional in some pipelines. So *"gate waiting"* and
  *"gate wants to change something"* are different situations, and the plan must be read before
  either is escalated. One recorded gate is worse than uninformative: its Terraform plan proposes a
  change that the cloud provider does not persist, so the apply succeeds and the very next plan in
  the same build shows the identical pending change — a gate that can never converge and that three
  separate humans have approved on three separate builds.

**Two mechanical traps.** Bracket characters in a query parameter are glob metacharacters to `curl`
and must be escaped or globbing disabled, or the request silently returns nothing. And a log node's
text is large; the operator's own procedure reads the last few thousand characters, which is the
right instinct for a worker whose context is finite.

**When unreachable.** This channel rides the corporate proxy and is available when the control plane
is not (§5.5). If it is unreachable, that is `blocked` — there is no substitute for "what did the
build do". Note that a CI authentication failure is a *different* system and a different fix from a
cluster permission failure, and the artifact must not conflate them.

#### 5.1a Two CI dialects, and telling them apart is the worker's job

D4 puts the image-build server in scope, so this is not one channel but two, and they are not the
same API wearing different hostnames.

| | CD servers | Image-build server |
|---|---|---|
| Answers | did the intended version reach the cluster | does the intended version exist, and why did the build fail |
| Shape | multibranch pipeline: job → build → stage list → flow nodes → node log | a conventional build job: job → build → result → console log |
| Stage graph | present; §2.1 Phase D's node walk applies | **absent** — there is no flow-node graph to walk |
| Failure diagnosis | find the failed stage, then its log node | read the build's console log directly |
| Credential | one pair per tier | its own pair; the CD pairs return 404 here |

**The consequence for §2.1 Phase D is concrete: the flow-node walk does not apply to the build
server.** A worker that runs the CD diagnosis procedure against an image build will look for a stage
list that is not there, find nothing, and report a shape problem as a missing build. The skill (§8)
must present the two procedures separately and key them on which server is being addressed, not on
"a CI server" in the abstract.

**Which server to ask is derived from §4.2's two axes, never guessed.** An image-pull failure is a
build-axis question; a rollout that never started is a deploy-axis question. The evidence ledger
records which server answered, because "the build succeeded" and "the deploy succeeded" are claims a
reader must be able to tell apart.

### 5.2 The Kubernetes control plane

**Shape.** `kubectl` and `helm`, in every worker image, against a filtered kubeconfig (§6.6).

**What it can tell you.** The authoritative answer to *what is actually running*. The operator's own
note, learned from a false negative: **deployment truth is the control plane, never log volume.**

**When it lies.** Not by returning wrong data — by having its simplest fields misread.

- **`readyReplicas` counts old-revision pods.** A StatefulSet mid-roll reports ready while two thirds
  of its pods are on the previous image. Progress is `updatedReplicas` against the spec and
  `updateRevision` against `currentRevision`.
- **StatefulSets roll sequentially in reverse ordinal and throw benign volume-attach warnings**
  during the swap, because the new pod is scheduled before the old pod's exclusive volume detaches.
  A worker that reports `Multi-Attach error` as a failure reports a healthy rollout as broken. The
  rule is to check whether the pod reached ready afterwards. A three-pod StatefulSet takes roughly
  three times as long as an equivalent Deployment for this reason, so "slow" is also not a finding.
- **The Deployment predicate took three attempts to get right**, and this is the single most useful
  worked example in the corpus for a role that must be mechanical:

  1. `readyReplicas == spec.replicas` — wrong, counts old pods.
  2. `spec.replicas == updatedReplicas == availableReplicas` — wrong; it went true while the old
     replica set still had a pod running and the new one was two-thirds ready.
  3. Exactly one replica set with `spec.replicas > 0`, its `readyReplicas == spec.replicas`, every
     other replica set at `status.replicas == 0` — **still wrong**, because the old replica set
     decrements when it *starts* deleting, and **a terminating pod is still a Running pod** serving
     the old image inside its grace window. The recorded case satisfied this predicate while three
     pods were still serving the old image.
  4. Correct: count pods with **no `deletionTimestamp`**, require that count to equal
     `spec.replicas`, and require zero terminating.

- **`Ready` is not `working`.** A DR workload once sat fully ready while silently dropping every
  message, because a workload-identity annotation was empty in that region's values. Pod status
  never surfaced it; the logs did.
- **DR expectations are workload-specific.** Some mirrors are warm standby at zero replicas with
  suspended scheduled jobs; some are hot and running. **"DR has no running pods" is the correct state
  for some workloads and a failure for others**, so the worker must be told which — it cannot be
  derived from the cluster.
- **An init container that never completed is invisible to every readiness count.** Database
  migration init containers fail this way; the pod sits in an init phase and the deployment never
  progresses. The check is the init container's own terminated exit code, per pod.

**When it lies about permissions.** This is the constraint that most shapes the design.

| Tier | `get`/`describe`/`events` | `logs` / `exec` | `secrets` get/list → `helm` |
|---|---|---|---|
| development, both families | works | works | works |
| one family's staging and production tiers | works | **Forbidden** | **Forbidden — `helm history`/`helm list` fail outright** |
| the other family, all tiers and DR mirrors | works | works | works |

The brief this document was written against described the gap as `pods/log` and `pods/exec`. **It is
wider: `secrets` get and list are included, and because Helm 3 stores release state in namespace
Secrets, the Helm-revision comparison that Phase A and Phase B are built on is simply unavailable on
the tier where a mistake is most expensive.** The substitutes are the CI build console's own revision
line, and reading the deployed image off the workload spec rather than out of Helm. This is recorded
as a correction to the brief rather than silently accommodated, because it invalidates a step the
workflow otherwise treats as universal.

**When unreachable.** An i/o timeout or context-deadline-exceeded against a control-plane address
means **the VPN tunnel is down, not that the credential is bad.** The signature is that *several*
control planes in different projects and regions fail together while every proxy-routed API keeps
working. A worker must never respond to this by re-fetching credentials — that path succeeds,
returns the same endpoint, and proves nothing, which is exactly how the diagnosis was originally got
wrong. §5.5 gives the ladder.

### 5.3 The log-query API

**Shape.** Google Cloud Logging via `gcloud logging read`, filtered by resource type, namespace,
container and an explicit timestamp range.

**What it can tell you.** Container output on tiers where `kubectl logs` is forbidden, and history
beyond what the node retains — the control plane keeps roughly a day of logs even for pods that have
run far longer, so a multi-day question can only be answered here.

**Why it is the designated fallback.** It rides the corporate proxy, so **it works when the control
plane does not.**

> **BLOCKER, measured 2026-08-31 against `docker/verbgate`: `gcloud logging read` is refused with
> exit 77 today, and this role cannot ship until that changes.**
>
> The shim classifies `gcloud` by scanning for the first *recognized* verb token. The read set is
> `list|describe|version|info|help|get-*|print-*|search|check|wait|tail`; the mutating set is
> `create|delete|update|...|run|submit|...`. **`logging` matches neither, and `read` matches
> neither.** The loop ends with `is_read` still at its initial `0` (`docker/verbgate:174`), the
> command falls into the mutating path, the mounted policy is empty because task-scoped
> authorization was descoped, and the call is refused.
>
> This is not a corner case. It takes out **the only channel that can read logs on the two tiers
> where `kubectl logs` is `Forbidden`, and the only observation channel that survives a down VPN
> tunnel.** Both of §5.5's degraded rows depend on it.
>
> **The two obvious workarounds are also closed, and deliberately so.** Reaching Cloud Logging over
> its REST API with `curl` — which the gate does not police — needs a bearer token, and
> `gcloud auth print-access-token` is explicitly classified mutating with a comment naming this
> exact evasion: *"curl is in the image, so the agent could mint a bearer token and issue any
> mutating REST call with zero gate rows and zero refusals — the containment story inverted by a
> glob. It is also the first thing a confused agent tries after a 77."* That reasoning is correct
> and should not be relaxed.
>
> So the fix belongs in the gate, and it is small: **`read` joins the `gcloud` read set.** No
> mutating `gcloud` command uses `read` as its verb, so the widening is one token. §12 D5 puts it to
> the owner as a required precondition rather than an enhancement, because a worker that discovers
> this at runtime reports `blocked` on every degraded path and looks like a broken role.

**When it lies.**

- **`--freshness` combined with ascending order silently returns stale results** — a two-hour window
  once returned entries from a month earlier. Recency checks must use explicit `timestamp >=` and
  `timestamp <` bounds and sanity-check the newest and oldest row returned. This is not a preference;
  a recency check built on that flag combination is wrong and looks right.
- **Absence of logs is not absence of a service.** The strongest single rule in this document, and it
  is recorded as a mistake already made: an empty log query was read as "not deployed / DR cold" for
  a set of clusters that were in fact all warm and fully replicated. Log routing differs per cluster
  and some route somewhere else entirely. **A negative from this channel can never upgrade to a
  positive claim about existence or health.** §9.2 encodes this.
- **The severity label is not the severity.** The log router mistags routine informational output as
  ERROR. Message text must be read.
- **Multi-container pods.** A prior "clean" verdict was wrong because only a sidecar's logs were
  read. Container selection is explicit, and a pod with more than one container needs each of them
  named. Chatty sidecars must also be excluded when counting, or the count is the sidecar's.
- **Counts across a multi-service pipeline double-count.** Where several components log the same
  event, a log-derived total is larger than the truth; where a database of record exists, it is
  authoritative and the logs are not.

**When unreachable.** If both this and the control plane are unreachable, no state question can be
answered and the honest verdict is `blocked` with both channels named.

### 5.4 Metrics and dashboards

**Shape.** Grafana's HTTP API (health, datasources, the datasource proxy, dashboard-by-uid) and
Cloud Monitoring's time-series API.

**What it can tell you.** Whether a metric feed that used to flow still flows; whether a specific
dashboard object exists; whether a metric pipeline is emitting fresh samples.

**When it lies.**

- **Dashboard search matches titles, not filenames.** Searching the config-map slug returns zero and
  reads as "missing". A recorded false alarm, burned recently. Look up by uid, or search title words.
- **A provisioning error burst after a multi-item deploy can be transient.** A reload storm produces
  a burst of save failures that decays, and every item named in an error was present afterwards. The
  discriminators are whether the erroring items are the *new* ones, whether they resolve by title,
  and **whether the per-minute error rate is decaying.** A single-sample check reports a healthy
  system as broken.
- **A load-balancer backend annotation lags reality by minutes.** After a health-check fix the
  annotation stays unhealthy for a while; the authoritative signal is the endpoint returning 200.
- **A registered metric descriptor is not a flowing metric.** Descriptors are never de-registered, so
  a dead metric family reads as "registered" forever.
- **A short query window can catch pre-batch state and report a false zero**, because exporters batch
  on an interval; a window shorter than a couple of batch periods is not a measurement.
- **Some listing endpoints are blocked at the ingress for the available token** even though
  proxy paths and by-uid lookups work. A 403 from a listing endpoint is an infrastructure fact, not
  a missing object.

**When unreachable.** Degrades to `partial` — the state question can still be answered without it.
This is the only channel whose absence is not disqualifying.

#### 5.4a Alert state is a separate question, and omitting it is a recorded failure

Buried in the metrics channel is a check important enough to name on its own. In a recorded exchange
the assistant reported that workloads were **"all still running"** across three environments; the
operator's next message was *"why is there an alert in prometheus?"*

**"All pods running" is not "no active alerts", and the operator treats a health report that omits
alert state as wrong rather than incomplete.** Alerts fire on conditions — error rates, queue depth,
metric staleness — that pod status cannot express, which is the entire reason they exist.

**Requirement: any `assessment: healthy` claim, in either mode, must include an explicit check of
active alert state for the target, and the artifact must record it as its own ledger entry.** A
`healthy` with no alert-state row is a claim the evidence does not support, and §9.2's rule applies
to it exactly as it applies to an unreachable channel.

Relatedly, and from the same corpus: a request to *"confirm alerts are flowing"* after a deploy was
answered not with pod status but with **row counts from the alerts datastore and downstream delivery
counts over a window**. Where a system of record exists for the thing being verified, it is
authoritative and the logs are not (§5.3), and "is it flowing" means counting records, not observing
that a process is up.

### 5.5 The degradation ladder

The worker establishes what it can reach *before* it decides what it can conclude, and it records the
result in the evidence ledger. Reachability is probed, not assumed, with a short explicit timeout.

| Reachable | Deploy-bound capability | Inquiry capability |
|---|---|---|
| CI + control plane + logs + metrics | full | full |
| CI + logs, **no control plane** (tunnel down) | build progress and outcome; **no rollout convergence check** | recent log signal only; **no state claim** |
| control plane + logs, no CI | rollout convergence and effect; no pipeline story | full |
| logs only | nothing sound about a deploy | **anomaly signal only, and no healthy claim** |
| none | `blocked` | `blocked` |

**The rule the ladder exists to enforce: a degraded channel set can produce a negative finding but
never a positive all-clear.** Finding a crash loop in logs is a real finding no matter what else is
down. Finding *no* crash loop in logs while the control plane is unreachable is not health — it is
`indeterminate`, and §9 requires it to be reported as such.

---

## 6. Roles and configuration

### 6.1 One role, `observer`

Named for what it does rather than for one of its two modes, which is the point of §0.2. It is the
fleet's read-only diagnostic role — **singular**, because it **replaces `investigator` in the same
change that introduces it** (§12 D2), rather than sitting beside it.

One role, one skill bundle, two task shapes. `mode: deploy` and `mode: inquiry` differ in their
envelope and their stopping rule and share everything else (§0.2). Nothing about the merge with
`investigator` adds a third mode: **`investigator`'s work *is* `mode: inquiry`** — read-only
diagnosis against live systems, no repository, output an explanation. The merge is therefore a
consolidation of two definitions of the same job, not the addition of a job.

#### What the merge actually changes, stated before it is done

`investigator` is `read, bash, grep, find, ls` with `cloud_access: true`, `isolation: none`, no
skill beyond `pifleet-worker`, and a briefing file. `observer` is that plus `write`, plus the
`observer-ops` bundle, plus `egress_access`, plus credentials. So the merge is additive in
capability and the migration is cheap — **an existing `investigator` task maps onto an `observer`
`mode: inquiry` task with no envelope field becoming mandatory that was previously absent.**

That claim rests on something already established rather than on optimism: §7.1 records that
`inputs[]` reaches no prompt, so the structured fields are a *record* for the harvester and the
brief prose is the only channel to the worker. An `investigator` task named its target in prose;
an `observer` inquiry task still does. `mode` **defaults to `inquiry`** precisely so that an
envelope written for the old role parses and runs. `environment`, `target`, `channels` and
`question` remain optional fields that improve a report and are not preconditions for one.

**Three things do change, and the owner took the risk knowingly:**

1. **The output contract tightens.** `investigator` wrote a free-form write-up. `observer` must
   write the `observer-ops.json`/`.md` pair, and a run that writes only the `.md` clamps to
   `failed` (§8 §10). **A migrated task that would previously have passed with prose alone now
   fails.** This is the sharp edge of the merge and the one to watch on first use.
2. **The worker now follows a skill that expects to resolve a target and enumerate channels.** A
   task whose brief names its subject vaguely got a best-effort answer before; it now gets a
   resolution step that may report an ambiguous candidate set and stop (§4.1). That is better
   behaviour and it is *different* behaviour.
3. **Every former `investigator` task now runs with a wider grant** — egress to CI and dashboard
   hosts, and credentials for both — that it does not need. That is a real widening, and it is the
   strongest argument for D3's scoped service account and for the per-fleet kubeconfig (D9): the
   credential's scope, not the role's task list, is what should bound an inquiry that never touches
   a pipeline.

#### The migration

`roles/investigator.md` is not deleted but folded: its two rules that generalise — *"distinguish
what you observed from what you inferred"* and *"if two causes remain consistent with the evidence,
name both and say what observation would separate them"* — move into `roles/observer.md`, which
§11.3 already requires. The `investigator` role entry and the `inv-1` worker leave `fleet.yaml`;
their replacement is an `observer` worker. Nothing else in the fleet dispatches to `investigator`
today, which is what makes doing this now cheaper than doing it after `observer` has run.

### 6.2 The `fleet.yaml` entry

```yaml
roles:
  observer:
    model: Qwen3.5-35B-A3B-8bit
    thinking: high              # reconciling four disagreeing channels is the whole job
    toolchain: base             # gcloud, kubectl, helm, curl, jq are already in every image
    tools: [read, write, bash, grep, find, ls]
    skills: [pifleet-worker, observer-ops]
    append_system_prompt_file: ./roles/observer.md
    cloud_access: true          # ADC — read verbs only; §5.10 refuses every mutating verb
    egress_access: true         # a ROUTE to the proxy; destinations are egress.allow
    secrets:                    # two CI servers, two dialects, two credentials — §5.1
      - CI_CD_TOKEN
      - CI_CD_BASE_URL
      - CI_BUILD_TOKEN
      - CI_BUILD_BASE_URL
      - GRAFANA_TOKEN
      - GRAFANA_BASE_URL
    isolation: none             # no repository; the artifact in the outbox is the whole output
    pane_mode: rpc

workers:
  - {id: obs-1, role: observer}
  - {id: obs-2, role: observer}
  # `investigator` and its `inv-1` worker are REMOVED in the same change — §6.1.
  # `observer` with `mode: inquiry` is their replacement, not their sibling.
```

Each field, with the reason:

- **`tools`** includes `write` because the artifact is written to the outbox, and excludes `edit`
  because there is nothing to edit. `bash` is unavoidable — `kubectl`, `gcloud`, `helm` and `curl`
  are shell commands — and §12.1 of the main SRD is already clear that tool scope is not the
  boundary; the container is.
- **`isolation: none`.** No `/workspace` at all, exactly like `ticketing`. The role works against
  live systems and its entire output is the artifact. This also removes the diff-based half of the
  harvest, which §9.3 accounts for.
- **`pane_mode: rpc`, not `tui`.** `tui` voids epoch fencing entirely — with no epoch there is no
  `already_completed`, so a re-dispatch of the same task runs it twice. A watch is *built* on
  repeated dispatch of near-identical tasks (§7.5), which makes `observer` the role least able to
  afford that. `tui` would also void the dispatch acknowledgement, meaning "accepted" would only
  prove that bytes reached a terminal.
- **`thinking: high`.** The level `investigator` carried, and for a stronger reason: the judgement
  here is reconciliation across contradictory channels, which is where a small model most needs the
  budget.
- **Two workers.** Unlike `ticketing` — which is capped at one because a second concurrent writer
  could interleave edits on one object — `observer` is read-only, so concurrency is safe. Two lets a
  watch on one target proceed while an inquiry about another is answered.

### 6.3 `cloud_access: true` — and what it costs

This is a real privilege grant and the main SRD says so plainly: a worker with `bash` and
`cloud_access: true` can do anything the operator's Google identity can do, for the lifetime of its
token. The mitigations that apply here are the fleet's, not this role's: token mode only (a ~1h
access token, never the account-wide refresh token), the host gcloud store never mounted, the grant
printed at `up`, and the egress allowlist bounding where the token can be spent.

**The strongest available control is `cloud.impersonate_service_account`, and this role is the best
argument yet for setting it.** `observer` needs a strictly smaller set of permissions than the
operator holds — read verbs on workloads, log read, monitoring read — and a service account scoped
to exactly that is bounded by the cloud provider's own authorization, which no amount of shell in
the container can widen. §12 puts the provisioning question to the owner.

### 6.4 `egress_access: true` and the `egress.allow` entries

`egress_access` decides whether the worker gets a route to the proxy at all; `egress.allow` decides
the destinations. `observer` needs, as *classes*:

| Destination class | Why | Port |
|---|---|---|
| the CD CI server(s) | pipeline state, stage list, node logs | 443 |
| the image-build CI server | build state and **build-failure logs** for image builds — D4 | 443 |
| the Kubernetes control plane endpoints | `kubectl`, `helm` | 443 |
| Google API endpoints (container, logging, monitoring, auth) | credentials, log query, metrics | 443 |
| the Grafana instance(s) | dashboard and datasource checks | 443 |

**Every rule is one exact host and one port.** The example config says it and it is worth restating
in this role's context: *the narrowest thing available is the rule itself*, and **a rule granting a
host any port is a tunnel** — it turns a destination allowance into general reachability of a machine
that happens to run other things. There is no destination in the table above that needs anything but
443.

Three cautions:

- **This is a materially wider allowlist than any existing role's.** `ticketing` has one entry.
  `observer` has several, and they point at infrastructure control planes rather than at a ticket
  vendor. That widening is the substance of the security decision, and §10 argues it is acceptable
  only because the verb gate makes the identity read-only.
- **Three CI instances, three rules, three credential pairs**, each bound to its host (§6.5): two CD
  servers split by tier, plus the image-build server (D4). A credential presented to the wrong one
  returns a 404 that reads like a missing job, so the binding is configuration, not inference.
- **The bridge's residual applies unchanged.** An internal bridge does not deny the bridge gateway;
  the honest reachable set already includes every port on the Docker host and on sibling containers.
  `observer` does not widen that, and it does not fix it.

### 6.5 Secrets — and the `credential: false` trap this role will hit

Delivery follows Class 3 of §12.4: a name must appear in both the fleet's `secrets.env_allowlist`
(the ceiling) and the role's `secrets:` (the request); the value lands at `/secrets/<NAME>` at mode
0444 and the environment receives `<NAME>_FILE` — the pointer, never the value. `echo $CI_CD_TOKEN`
prints an empty line, by design.

The token is got into a request the way `ticket-ops` does it, and for the same reasons: a `curl`
config file built with `umask 077`, `cat` writing into a redirect rather than through a command
substitution, and no assignment to a shell variable ever. **This role has more than one credential
pair, so it needs one config file per host and must not reuse one against another** — the recorded
failure is a credential valid on one CI instance returning a 404 against another, which reads like a
missing job rather than like an authentication problem.

**Now the trap, and it is the `TICKET_BASE_URL` lesson repeating in a role with several times the
surface.** `harvest/needles.ts` sweeps every granted *value* through the leak detector. `observer`'s
artifacts legitimately and necessarily contain the endpoints it was pointed at — a build URL is the
single most useful line in a deploy report. If the base URLs are granted as credentials, **every
artifact this role produces is refused as carrying a credential, every refusal becomes a discrepancy,
and every verdict clamps** — which is exactly what happened to `ticket-ops` until the 2026-08-31
erratum. So:

```yaml
secrets:
  env_allowlist:
    - CI_CD_TOKEN                                       # bare string = credential: true = swept
    - CI_BUILD_TOKEN
    - GRAFANA_TOKEN
    - {name: CI_CD_BASE_URL,    credential: false}      # delivered, NOT swept
    - {name: CI_BUILD_BASE_URL, credential: false}
    - {name: GRAFANA_BASE_URL,  credential: false}
```

`credential: false` says one thing only: do not use this value as a needle. It buys no privilege and
forfeits a check, and the default is `true` so a mistake falls toward sweeping. **The tokens are
never `credential: false`.**

A design consequence worth stating: **a namespace or a context name that appears in an artifact is
not a credential and must not be delivered as one.** Those arrive in the task envelope, which is not
swept, which is the right channel for an identifier that must appear in the output.

### 6.6 `cloud.kubeconfig` — the strongest fence this role has

The mount table admits a filtered kubeconfig at `/home/pi/.kube/config`, read-only, present only when
`cloud.kubeconfig` is set *and* the worker has `cloud_access`. Its comment is emphatic: *a filtered
copy, never the host `~/.kube/config` wholesale.*

For `observer` this is not hygiene, it is the scope fence. §7.4 needs a way to bound what a worker
may look at, and instruction is the weak version of that. **A kubeconfig containing only the contexts
this role may reach is the strong version**, because it bounds reachability rather than intent, and
it composes with the credential's own IAM scope (§6.3). The host kubeconfig contains every context
the operator has ever used; a worker asked about one environment has no business holding the others.

**Requirement: `cloud.kubeconfig` must be set for any fleet running `observer`, and the file must
contain only the contexts named in that fleet's tasks.** Whether it should be narrowed further —
per-task rather than per-fleet — is §12's question, and the honest answer is that the mount is fixed
at container start, so per-task narrowing would need the same dispatch-time write that §5.10's
descoped policy rewriter needed. It is not available, and this document does not ask for it to be
built.

---

## 7. The task envelope

### 7.1 What both shapes carry

Beyond the standard fields (§7.1 of the main SRD — `task_id`, `epoch`, `worker`, `title`, `brief`,
`acceptance`, `outbox`, `deadline_s`), an `observer` brief carries:

| Field | Meaning |
|---|---|
| `mode` | `deploy` or `inquiry` — selects the specialisation |
| `environment` | the logical environment token, matching a context in the filtered kubeconfig |
| `target` | the resolved namespace and workload where known; a nickname otherwise, with resolution recorded |
| `channels` | which of the four this task may use; defaults to all permitted for the environment |
| `question` | for `inquiry`: what is actually being asked, in one sentence |

**Note a live constraint on all of this: `inputs[]` reaches no prompt.** The main SRD's erratum
records that `renderPrompt` takes only `{title, brief, acceptance}`, so a structured field carried in
the envelope is a *record*, not a channel to the agent. **Everything the worker must act on has to be
in the `brief` prose.** The structured fields above are still worth carrying — they are what a
harvester and a human read, and they are where a future `## Inputs` renderer would draw from — but a
design that assumes the worker can read them today is wrong.

`cloud_allow` is **not** carried. It is refused at parse time by both envelope schemas, and this
document does not ask for it back (§10.2).

### 7.2 The deploy shape

Adds: **the invocation weight** (`watch` | `light_touch` | `post_hoc`, §1.1) which selects how much
of §2.1 runs at all; the pipeline identifier; the build number once known; the merge timestamp
(which anchors the before/after windows in Phase C); the baseline captured in Phase A where the
weight is `watch`; and the DR expectation for this workload — warm-standby-at-zero, suspended, or hot
— because §5.2 establishes that this cannot be derived from the cluster.

**The weight is set by the orchestrator from the operator's phrasing and is never defaulted.** A
missing weight is a task the worker cannot size, and §1.1's cost asymmetry says it should ask rather
than guess: over-executing a light-touch request wastes a run, under-executing a watch leaves a
deploy unobserved.

#### The `phase` field, and its mapping onto §2.1

A deploy-mode task does one phase per dispatch (§7.5). The enumeration and its mapping are fixed
here so the two sections cannot drift apart:

| `phase` | §2.1 | Runs for weights | Produces |
|---|---|---|---|
| `baseline` | Phase A | `watch` only — the other two have nothing to baseline | the baseline the later passes compare against |
| `watch` | Phase B | `watch` | build state, a recommended next delay, and everything the next pass needs |
| `backfill` | Phase B′ | `watch`, on resume only | history across the gap — events, restart deltas, log deltas |
| `verify` | Phase C | all three | the convergence and effect judgement, and the clean-or-not verdict |
| `diagnose` | Phase D | any, on a failure | failed stage, error excerpt, bug class |

Phase 0 — the premise check (§2.1) — is not a `phase` value. **It is a precondition of every pass**,
because any of them can be dispatched against an asserted state that is not true.

`report` is likewise not a phase: every pass writes the artifact pair, so reporting is a property of
each dispatch rather than a terminal step someone might skip.

**`backfill` composes rather than replaces.** A resuming pass is `phase: backfill` *followed by* the
phase it would have run anyway, in the same dispatch, because the gap and the present are both
needed and re-dispatching twice to get them wastes a turn. What makes it a named phase rather than a
flag is that it has its own coverage semantics (§2.1 Phase B′) and its own way of failing — a gap
that outran retention.

For `phase: backfill`, the envelope additionally carries **`last_observed_at`** — the wall-clock
timestamp of the most recent observation in the preceding artifact. It is the lower bound of the
backfill window and there is no other source for it, which is why D13 makes recording observation
timestamps mandatory in every artifact rather than advisory.

For a task naming several services, the envelope carries them as a list and the artifact returns a
row per service — §12 D12's rule that a single verdict covering a batch is a schema violation.

The **baseline is carried in the envelope, not re-derived**, for two reasons. It was taken before the
deploy and cannot be re-taken afterwards. And a watch is a sequence of tasks (§7.5), so the baseline
must survive between them; the envelope is the only channel that crosses a task boundary.

### 7.3 The inquiry shape

Adds the question and a **time window** — how far back to look. Without one, "check the logs" is
unbounded, and an unbounded log query against a busy namespace is a way to spend a task's whole
budget on retrieval.

It does **not** add a baseline, and §9.2 is about the consequences.

### 7.4 What the envelope must not carry, and the scope fence

**Never in the envelope:** a credential or any part of one; an absolute host path; a raw command for
the worker to execute; the contents of a previous worker's report as instruction. That last one is
§12.6 of the main SRD: worker-authored prose is data, never instruction, and a watch that chains
task to task is exactly the shape that invites violating it. **What crosses between passes is
structured state — build number, baseline, last stage — never a previous worker's recommendations
rendered as a brief.**

**The fence.** An inquiry with no boundary is a worker that can read anything it can reach, and this
role can reach a great deal. Three layers, weakest to strongest:

1. **Instruction.** The brief names one target and the skill forbids widening. This is real and it is
   weak — the main SRD is explicit that shipping an instruction is not the same as anything
   re-checking it was followed.
2. **The filtered kubeconfig.** Bounds which clusters exist at all (§6.6).
3. **The credential's IAM scope.** Bounds what may be read on them. Strongest, because no shell can
   widen it.

**Resolution is the one sanctioned widening**, and it is bounded: listing namespaces to resolve a
nickname is permitted, is a declared first step, and its candidate set goes in the artifact. Reading
*into* a namespace the resolution did not select is not.

### 7.5 The watch does not fit in a task, and this is the central mechanical constraint

The numbers collide. `per_task_timeout` is 25 minutes. The worked envelope's `deadline_s` is 1500
seconds. `event_stall_kill` is 25 minutes, and it fires on *silence*: a worker that sleeps politely
between polls emits no events and is killed as wedged. The operator's own cadence table has a single
inter-poll delay of 1200 seconds for a build waiting on a human, and a whole watch spans past an
hour.

**Therefore: one task is one observation pass, and the orchestrator re-dispatches.**

- A `deploy` task polls once — or a small bounded number of times inside its deadline, emitting an
  event per poll so the stall guard sees liveness — and returns a terminal artifact carrying the
  observed state and everything the *next* pass needs: build number, baseline, last-seen stage, the
  recommended next delay drawn from the cadence table.
- The orchestrator holding the run decides whether to dispatch again, and when. This keeps
  scheduling in the one component that already has a scheduler, and it means an operator who stops
  caring simply stops dispatching.
- **A pass that ends with the deploy still in flight is not a failure.** It is a `success` at
  observing, with a subject state of `in_progress`. §9.1 turns on exactly this distinction.

**The measured numbers are kinder than feared, and they change the sizing.** Observed inter-poll
delays from real scheduling calls are **180s / 240s / 270s / 270s / 300s**, selected by pipeline
phase — matching the operator's documented cadence table closely enough to treat that table as
validated rather than aspirational. And the observed **merge-to-report wall clock is 10–18 minutes**,
not the hour this document assumed: roughly 11 and 10 minutes for single-PR deploys, and about 18
minutes for a five-PR, two-cluster batch that was *deliberately* extended past pod-Ready to wait for
a scheduled job's next run so the proof would be functional rather than structural (§2.1).

**Most watches therefore fit inside a single 25-minute task.** The one-pass-per-task design stays —
it is what makes a watch resumable, survives a slept laptop, and keeps scheduling in the
orchestrator — but it is now a correctness property rather than a workaround for a deadline the
common case would breach anyway.

**One observed pattern the design must accommodate: the loop is not "poll until green".** One
investigation was re-armed **the following calendar day** after a deploy that had gone green showed
zero post-deploy ingestion. So a watch can terminate successfully and still need re-opening on a
much longer horizon. That is an orchestrator behaviour, not a worker one — the worker reports what
it saw and a recommended follow-up interval; nothing in the container should be trying to wake up
tomorrow.

There is also a **background poller running alongside the explicit wakeups**, with the scheduled
calls acting as a safety net rather than as the only clock. This document does not reproduce that
arrangement: two schedulers is the thing §3.3 rules out, and pifleet's orchestrator is the one that
already exists.

Two supporting facts. The credential survives a long watch: the supervisor re-mints and re-injects
the access token every 45 minutes on a monotonic clock, leaving margin before the ~1h token dies
mid-call. And the run has its own ceiling — `run_timeout: 2h` — so a watch that outlives a run is
the operator's problem to re-open, not the worker's to sit through.

**A rejected alternative, recorded so it is not re-proposed:** raising `deadline_s` to cover a whole
watch. It would need `event_stall_kill` raised with it, which disarms the guard that catches a
genuinely wedged worker for every other role in the fleet — trading a real protection for a
scheduling convenience the orchestrator already provides.

---

## 8. The `observer-ops` skill — what it must document

A sibling of `skills/ticket-ops/`, mounted for the `observer` role. This section specifies it; it
does not write it. The register is `ticket-ops`': every rule states the failure behind it, and
measured claims carry their date.

**§1 — What you are given.** The table of `<NAME>_FILE` pointers, one row per endpoint and token,
and the flat statement that the values are not in the environment. The rule that a missing or
unreadable pointer is `blocked`, not something to work around — and specifically that it must not
degrade into polling forever. This has a measured cost behind it: an environment-sourcing failure
that emptied the CI credentials once produced **a full ten-minute watch that never detected a build
which had already finished**. A credential failure that presents as "still running" is the most
expensive failure this role can have, so an authentication failure is named as such, immediately, and
`--fail-with-body` is mandatory for exactly the reason `ticket-ops` gives.

**§2 — Getting a credential into a request without holding it.** The `curl --config` construction,
verbatim from `ticket-ops` including the four rules about why the shorter forms leak. Plus this
role's addition: **one config file per host**, and never one against another host.

**§3 — Target resolution.** §4.1's four rules in order, the two recorded name-mismatch cases, and the
prohibition on templating a namespace from a branch name.

**§4 — Ownership detection, on both axes.** §4.2's two-axis model — deploy owner and build owner —
with its tables, the nine-hour GitOps blindness case as the worked example of why one axis is not
enough, the instruction to report `unknown` deploy ownership rather than assume a CD pipeline, and
the ordering rule that the registry is probed before the build server because it is cheaper and
often sufficient.

**§5 — The four channels.** One subsection each, following §5's structure: the call shapes, what the
channel can answer, its named lies, and its unreachable behaviour. The mechanical traps go here:
bracket globbing, the log-flag combination that returns stale rows, the explicit timestamp bounds,
result limits, container selection on multi-container pods, and dashboard lookup by uid rather than
by filename search.

**§6 — Bounding every call.** `--max-time` on every `curl`, an explicit request timeout on every
`kubectl`, and a bound on every log query. The reason is `ticket-ops`': a request with no deadline
does not fail inside a container, it hangs, and the only signal reaching the supervisor is that the
worker stopped emitting events — so it is killed with nothing written and no reason recorded.

**§7 — The rollout convergence predicate.** §5.2's four-step history, stated as history, because the
three wrong versions are each the obvious thing to write and a worker that has not seen them refuted
will write one of them. Plus the StatefulSet variant and the benign volume-attach warning.

**§8 — The before/after classification.** Window selection, the three buckets, the rule that only a
new pattern blocks, and the rule that message text is read rather than severity labels counted.

**§9 — Failure diagnosis, as two procedures keyed to which server is being addressed.** For a CD
server: the stage-scan rule, the flow-node walk, the log-node recognition pattern, the tail bound,
and the bug-class table matched on literal error substrings. For the image-build server: **no stage
graph exists**, so the procedure is build → result → console log directly, and a worker that goes
looking for a stage list there will report a shape mismatch as a missing build (§5.1a). The two must
be presented separately and never as "the CI procedure" with a note about variations.

**§9a — Backfill.** §2.1 Phase B′: the window is `last_observed_at` to now; read events, restart
deltas and log deltas rather than current state; the three retention profiles and which signal
survives an arbitrary gap; and the rule that a gap outrunning retention is a recorded
`coverage: partial`, never a silent one.

**§10 — The artifact.** The exact JSON shape, exhaustively — because `ticket-ops` learned that a
document explaining at length what a file is *for* while never saying what it must *contain*
produces sensible-looking artifacts of the worker's own invention that fail schema validation every
time. Both files, `observer-ops.json` and `observer-ops.md`, and the rule that writing only the `.md`
fails the task because the `.md` is the half nothing inspects. The `.json` carries `coverage[]` and
the evidence ledger as required arrays (§4.3, §9.1), and — for deploy mode — a build result and a
verification result **per environment**, because that is exactly the shape the ticket write-up
consumes (§2.1 Phase E).

**§10a — The two durable reporting channels, and what each requires.** Reporting is not one thing.
Two channels are durable and must both be specified; a third is ad-hoc and needs no spec.

- **The in-session terminal report.** Read once, by the person who dispatched. This is where the
  comparison table lives (§11.3) — concrete values, per environment, before and after.
- **The persisted ticket write-up.** Read later, by people who were not here. Its constraints are
  specific and each has a failure behind it: **one short paragraph per environment**, with the
  environment name in bold; the pull request referenced **by number, not by raw URL**; **appended,
  never overwriting** what is already there; and **round-trip verified afterwards**, because the
  tracker silently strips markup it does not allow — which is `ticket-ops`' read-back rule arriving
  from a second direction.

  One content rule that is easy to get wrong and reads as a false accusation when you do: **a
  pre-existing unrelated issue found during verification gets its own explicitly-labelled sentence**,
  so nothing in the write-up implies this deploy caused it. §2.1 Phase C's three-bucket
  classification is what produces that label; the write-up is where dropping it does damage.

`observer` does not write the ticket — `ticketing` does, from this artifact. But the artifact must
carry the per-environment structure the write-up needs (§8 §10), because a write-up assembled by
re-parsing prose is a write-up that loses the environment boundaries.

**§11 — What you never do.** No mutating verb, no approval gate, no ticket write, no ticket state
transition, no merge, no retry of a build. And the operator's own strongest prohibition, adopted because it generalises past
its origin: **never stage a destructive command with the intention of cancelling it** — a
backgrounded-then-killed delete has executed anyway across three separate recorded incidents.

---

## 9. Verdicts

### 9.1 The inversion that makes this coherent

**The worker's `status` is about the observation. The subject's condition is a field in the
artifact.** Without this, `failed` is ambiguous between *the deploy failed* and *I failed to observe*
— and those need opposite responses from whoever reads the report.

So: **a deploy that failed, observed correctly and reported with the error excerpt, is `status:
success`.** The task was to observe. It was observed.

| Field | Domain | Meaning |
|---|---|---|
| `status` | `success` \| `partial` \| `blocked` \| `failed` | did the observation succeed |
| `subject_state` (deploy) | `not_started` \| `in_progress` \| `gate_waiting` \| `succeeded` \| `failed` \| `indeterminate` | what the deploy is doing |
| `assessment` (inquiry) | `healthy` \| `degraded` \| `unhealthy` \| `indeterminate` | what the service is doing |
| `coverage` | per channel: `answered` \| `unreachable` \| `forbidden` \| `not_attempted` | what the answer rests on |

### 9.2 An inquiry has no pass or fail — it has a report with a completeness marker

This is the design problem the mode raises and it does not have a naming answer. A question is not a
task that can fail by its answer being bad news.

**The verdict of an inquiry is `status`, and the *answer* is `assessment` qualified by `coverage`.**
The rule that binds them, and it is the whole value of the role:

> **`assessment: healthy` requires positive evidence, from a channel that can see the effect, that
> the thing is working. Absence of a negative signal from a degraded channel set is
> `indeterminate` — never `healthy`.**

That rule is not a preference. It is the direct consequence of two recorded false negatives: an
empty log query read as "not deployed" for clusters that were all warm, and a `Ready` workload that
was dropping every message. **"I looked and it is fine" and "I could not see enough to tell you" must
be different values in a machine-readable field**, because a human skimming prose will read them the
same way, and the second one is the answer that changes what the operator does next.

Consequently: **`partial` is the common honest outcome for this role, and that is correct.** A role
whose usual verdict is `partial` will be tempted to round up. `ticket-ops` records what rounding up
costs — a run that graded its own criterion as met while its evidence contradicted the claim it was
offered to support. Grading yourself is not checking yourself.

#### The evidence that this is the right rule, from the operator's own reactions

Session history answers the question "will the operator tolerate an inconclusive answer" more
clearly than any design argument could, and it answers it in a direction worth stating plainly:

- **He never pushed back on an honest "inconclusive".** Not once in the sampled window. An
  investigation that reported what it had established and what it could not was accepted as a
  result.
- **He pushed back, immediately and repeatedly, on confident claims that were unsupported or
  wrong.** In one exchange the assistant reported that a set of workloads were "all still running";
  the operator produced an alert contradicting it within the same turn. In another, a one-line
  answer drew a demand to show the work.

**So the cost asymmetry is measured, not assumed: a confident wrong answer costs more than an honest
gap, in this operator's judgement, on this material.** That is the entire justification for the
`indeterminate` value existing and for the rule that a degraded channel set cannot produce an
all-clear.

#### The shape of an inconclusive report

Inconclusive answers in the corpus are never a bare "I don't know". Every one has three parts, and
the artifact schema (§8 §10) requires all three:

1. **What *was* established** — the positive findings that survived, however partial.
2. **What was attempted and why it did not resolve** — the channel, the call, and the failure.
3. **What a resolving step would require** — the permission, the network path, or the access that
   would answer it.

Part 3 is what makes the report actionable rather than merely honest, and it is what turns a
`blocked` into a request the operator can act on in one step.

### 9.2a What an observed "clean" is actually made of

The rule above says positive evidence is required. The transcripts say precisely which evidence, and
it is narrower than the codified workflow implies. **Every observed "clean" declaration is backed by
the same three things:**

1. **Ready counts** for the named workloads.
2. **Restart counts**, per pod, named.
3. **An explicit confirmation of data freshness at the sink** — §2.1's principle, stated as a
   timestamped observation.

Two absences are as informative as the presences:

- **Pipeline SUCCESS alone never earns a clean verdict** in any observed declaration.
- **Helm-revision match was never the deciding factor** in any of them, despite being a documented
  step in the operator's own skill. It is corroborating evidence, not the thing that closes the
  question — which is fortunate, because §5.2 records that it is unavailable outright on one
  production tier.

**Requirement: the schema treats the freshness-at-sink confirmation as mandatory for
`assessment: healthy` in deploy mode.** A verdict carrying ready and restart counts but no sink
observation is `indeterminate`, on exactly the reasoning in §9.2 — it is the upstream evidence that
the three §1.3a findings all satisfied while being broken.

The three-bucket log rubric (§2.1 Phase C) is invoked **by name** in-session, which is worth noting
because it means the classification is already a shared vocabulary between operator and worker
rather than a scheme this document is introducing.

### 9.3 `blocked` versus `failed` versus `unknown`

| Verdict | Use when |
|---|---|
| `success` | every channel the question needed answered, and the artifact says what was found — **whatever it was** |
| `partial` | some channels answered and some did not, the worker can name which, and the report is real but incomplete |
| `blocked` | something outside the worker's control prevented the observation: no credential; a refused verb (exit 77); a `Forbidden` on the only channel that could answer; **every** channel that could answer unreachable; a control plane behind a down tunnel with no log fallback for the question asked |
| `failed` | the worker attempted the observation and its own process broke — it could not parse what it got, wrote a malformed artifact, or ran out of deadline with nothing written |

The distinctions that matter, each with its rationale:

- **A tunnel-down control plane is `blocked`, not `failed`.** Nothing the worker did caused it and no
  retry inside the container fixes it. Reporting it as `failed` sends the operator to debug the task
  instead of the network — which is the exact confusion §12.4 of the main SRD cites when it insists a
  credential failure must never present as a task failure.
- **A `Forbidden` is `blocked`, and the artifact must name the verb and the tier.** It is a standing
  property of the environment, not an incident, and a report that says "could not read logs" without
  saying "because this tier forbids `pods/log` for this identity" will be re-investigated every time.
- **A refused mutating verb is `blocked` and is not to be routed around.** It means the task did not
  authorize the action — and for this role it means the task asked for something out of scope.
- **`unknown` is the harvester's, never the worker's.** The worker writes `status`; the harvester
  writes `verdict` and may lower but never raise it. Because `isolation: none` leaves no diff, the
  artifact and the transcript are the *only* derived facts available — which makes writing the
  envelope, and writing the `.json`, disproportionately load-bearing for this role. A missing envelope
  does not fail the task; it removes the worker from the grading, and with no repository change to
  speak for it in its absence there is nothing left to grade.

---

## 10. Security model

### 10.1 Read-only by default — and, today, by mechanism

The recommendation is that `observer` be read-only by default. The stronger fact is that **the fleet
currently makes it read-only by construction, for every role, and this document does not ask for an
exception.**

The verb gate moves the real binaries aside at image build and puts a shim on `PATH`. Read verbs —
`kubectl get/describe/logs/top`, `gcloud list/describe`, `helm list/get/status/history` — exec
unconditionally. Mutating verbs consult a mounted policy file. **That policy is written empty at `up`
and never rewritten; task-scoped cloud authorization was descoped by owner decision, and
`cloud_allow[]` is now refused at parse time.** So every mutating cloud verb is refused with exit 77
for every worker for the life of every run.

That is not a degraded mode; it is the shipped behaviour, and it is exactly the posture `observer`
wants. **Every read verb this role needs is on the always-exec list.** The role therefore imposes no
new requirement on the gate — which is the strongest possible form of "read-only by default", because
it required no new mechanism and can be verified by reading a policy file that is empty.

One caveat stated rather than glossed: the verb gate covers `gcloud`, `kubectl`, `helm`, `gsutil`
and `bq`. It does **not** cover `curl`, and `observer` uses `curl` against a CI server and a Grafana
instance. **Those two credentials must therefore be read-scoped at the server**, because nothing in
the container prevents a POST. This is the one place where the role's security depends on a grant
made outside the fleet, and §12 D6 asks the owner to confirm the tokens are read-only.

### 10.1a What the gate costs this role, enumerated

The gate is the right posture and it is not free. These are techniques the operator uses routinely
that a worker **cannot** use, each refused with exit 77. They are listed because a skill that
assumes them would fail at runtime in a way that reads like a broken cluster, and because the
substitutes are not always adequate.

| Refused | Used today for | Substitute available to the worker |
|---|---|---|
| `kubectl exec` | reading a *deployed* config file out of a running container; querying an in-cluster database; reaching a service with no public URL | **None that is equivalent.** Config-as-deployed must be inferred from the workload spec and the values source, which is a weaker claim and must be labelled as inference |
| `kubectl run` | an ephemeral debug pod to reach an in-cluster endpoint | None |
| `kubectl port-forward` | reaching an in-cluster service from outside | None |
| `kubectl events` | recent namespace events | **`kubectl get events` — the verb is `get`, which is on the read list.** A one-token difference between working and refused, so the skill must spell it out |
| `kubectl auth can-i` | probing whether a permission exists before using it | Attempt the read and classify the `Forbidden`; §9.3 already requires naming the verb and tier |
| `gcloud container clusters get-credentials` | obtaining a kubeconfig | **None — and this is why `cloud.kubeconfig` is mandatory (§6.6), not advisory.** A worker cannot mint its own cluster access |
| `gcloud auth print-access-token` | minting a bearer token for a REST call | None, deliberately (§5.3) |
| `gcloud logging read` | **the entire fallback log channel** | None. §5.3's blocker; must be fixed in the gate |

Two of these deserve a sentence rather than a table row.

**Losing `kubectl exec` is a real reduction in what this role can conclude**, and the honest response
is to narrow the claims rather than to seek an exception. Where the operator would read a config file
out of a running container to prove what is deployed, the worker reads the workload spec and says so
— an inference, marked as one, per `roles/investigator.md`'s rule about not presenting inference as
observation.

**`kubectl get events` versus `kubectl events` is the sharpest edge in the whole toolchain**, because
both are valid `kubectl` and only one survives the gate. It goes in the skill as an explicit rule
with the reason attached, not as an example that happens to use the working form.

### 10.2 If the worker is ever to act, that is a different role

Stated explicitly so it is not implied: **triggering a build, rolling back a release, restarting a
workload, or scaling anything is out of scope, and adding it later is not a configuration change.**
It would require reviving the dispatch-time policy rewriter that was deliberately descoped, with its
own acceptance criteria, its own audit trail, and its own answer to the fact that a worker with
`bash` can reach the real binaries directly. A remediating role would be a sibling of `sre`, would
carry `isolation: worktree` so its changes land on a branch, and would be dispatched by a human who
just read an `observer` artifact. **`observer` is the thing that makes that human's decision
well-informed. It is not the thing that acts on it.**

### 10.3 What the credential can do, stated plainly

A worker with `bash` and `cloud_access: true` can do anything the operator's Google identity can do
for the lifetime of its token. The verb gate filters a command line and `bash` can route around a
filter. The control that does not depend on the command line is the credential's **scope**, which is
why §6.3 recommends `impersonate_service_account` and §12 asks the owner to provision one.

Two honest residuals:

- **The allowlist is wide by this fleet's standards** (§6.4), and it points at control planes.
- **The bridge gateway residual is unchanged.** An internal bridge does not filter the gateway;
  the reachable set already includes every port the Docker host listens on. `observer` neither
  widens nor fixes that.

### 10.4 Credentials

Class 3 file delivery, `curl --config`, never a variable, never `argv`, never echoed — §6.5, and
`ticket-ops`' section on this is the normative text. The one addition this role forces is
**per-host config files**, because it holds more than one credential and they are not
interchangeable.

The standing limit is the same one `ticket-ops` names: file delivery removes the *accident* surface,
not the capability. A worker that wants to put its own credential in its transcript can still read
the file aloud. This narrows the accident, not the agent.

---

## 11. Escalation and human-in-the-loop

The decision points below are not a policy invented here. Each is a place the operator has already
drawn a line, and the requirement is that `observer` surfaces and stops.

| Situation | Worker does | Why |
|---|---|---|
| A pipeline is blocked on an approval gate | reports it, **including the plan summary**, and stops | *"This is an approval belonging to a human — surface it, never click it."* And because a gate can block with an empty plan, the plan must be reported so the operator can tell "waiting" from "wants to change something" |
| A deploy failed | reports stage, excerpt, bug class; **does not re-run, roll back, or fix** | Remediation is a write |
| A merge is blocked by branch protection | not this role's business at all | The fanout skill already requires the operator be asked whether to wait for review or force-merge, rather than an override being applied |
| A new error pattern appears post-deploy | reports it as a regression finding | Whether it is an incident is a human call (§3.2) |
| A finding suggests a mutation would fix it | names the mutation in prose; **never stages it** | Never stage a destructive command intending to cancel it — three recorded incidents where the race was lost |
| Impersonation or a write returns permission denied | reports; does not retry, does not seek a broader grant, does not try another identity | Recorded as a known dead-end for specific environment/operation pairs — *"not a transient failure to push through"* |
| A nickname resolves ambiguously | reports the candidate set; picks nothing | An ambiguity broken silently is a report about the wrong service |
| The control plane is unreachable | reports `blocked` naming the tunnel as the likely cause | No client-side workaround exists; the operator repairs the VPN |
| Anything touching the production tier beyond reading | out of scope, full stop | §3.2 |

### 11.0 "Stuck" requires two observations, and is provisional until the second

A stall is never declared off a single read. The observed discipline is two-stage and the language
marks which stage it is in:

- **Provisional, on the first observation** — *"Dev is still stuck — same three pods unchanged after
  several more minutes."* Hedged, and explicitly time-qualified.
- **Confirmed, only after a second independent check** — *"Confirmed — this is a permanent deadlock,
  not something that resolves with more waiting."*

**Requirement: `subject_state: stalled` may only be reported after two separated observations of the
same unchanged state, and a single observation reports `in_progress` with the stall noted as
provisional.** The reason is the whole of §5.2: rollouts that look frozen are frequently sequential,
slow, or mid-terminating, and every one of those resolves on its own. A one-shot stall call is the
false-positive that costs the operator a wasted intervention.

This composes with §7.5's one-pass-per-task design rather than fighting it: the second observation
is simply the next dispatched pass, and the provisional finding rides between them in the envelope.

### 11.0a A ticket state transition is never inferred from a clean verification

`observer` writes no tickets at all (§3.2), but the boundary matters because the role's artifact is
what a ticket write-up is built from, and the temptation is to let a clean verdict imply a workflow
transition. It does not. **Moving a ticket to an accepted state requires a separate, explicit
instruction**, and a verification that came back clean is not that instruction. A worker or
orchestrator that advances a ticket because everything looked fine has taken a decision belonging to
a person.

### 11.1 Approval is keyed to action class, not to environment tier

The intuitive model — production is gated harder than development — **is not what session history
shows**, and designing to it would be designing to the wrong axis.

- **The approval bar is flat across tiers.** A live pod delete in development and a live pod delete
  in production both cleared on a one-word *"yes"*. The only observed difference is that the
  production ask **names the tier in the question** — *"This is a production pod delete — want me to
  go ahead?"* — with no extra scrutiny, no cooldown, and no second confirmation.
- **What actually gates is the class of action.** Live cluster-state mutation and
  infrastructure-plan-affecting changes always require an explicit ask. Reading logs, metrics, pod
  state and alert state never did, in any tier, at any point in the sampled window.
- **Credential and secret material is a categorical block that ignores tier entirely.** An attempt to
  decode raw secret values was refused *in a development namespace*, and the refusal held even under
  a prior blanket approval — while a pod restart in the same investigation cleared instantly. So
  data sensitivity is orthogonal to environment, not a point on the same scale.

For `observer` this is convenient rather than constraining: **the role performs only the class of
action that was never gated in any tier.** It is the reason the same role definition can serve
development and production without a tier-dependent policy.

**One nuance about raised cautions.** When the assistant flagged a skipped promotion stage, the
operator's response was to move on to the next item without acknowledging it — and the work
proceeded. **Silence after a flagged caution is this operator's "proceed", not "wait".** So the
requirement is to *raise* the caution once, record it in the artifact, and not to block on an answer.

### 11.2 The two failure modes are tier-correlated, and they are opposites

A clean asymmetry emerges from where the operator's corrections land:

| Tier | Dominant failure | What it looks like |
|---|---|---|
| development | **under-execution** | a status summary where an action was asked for; an instruction repeated verbatim because the previous turn explained instead of doing |
| production | **under-verification** | *"you told me it was fine but didn't actually check"* — a success claim not backed by a query |

Not once in the window did a correction take the form *"you moved too fast."* **The operator's risk
model for autonomous production work is under-verification, not over-action** — which is precisely
what §9.2's rule is built to prevent, and it is the strongest available evidence that the rule is
aimed at the right target.

For `observer`, whose only action *is* verification, this collapses to one instruction: **the failure
to guard hardest against is reporting healthy without having checked.**

### 11.3 The report shows the evidence, not a paraphrase of it

Two recorded corrections converge on the same requirement. *"This is not a very human usable
digestible format. I want to see the actual messages and what it is doing"* — and, separately, the
closing report of a successful deploy took the form of a **comparison table with the concrete values
in it**: image tag per service, pod counts, restart counts, per environment, before and after.

So the `.md` half of the artifact is not a narrative summary. **It carries the actual log lines and
the actual field values**, in a per-environment table, with the prose confined to what they mean.
A paraphrase of a log line is not evidence of the log line.

The general rule behind all of this, and the one to keep if the tables are ever trimmed: **the
worker's output is an explanation, not a change.** That sentence opens `roles/investigator.md`, and
`roles/observer.md` — which replaces it under D2 — should open with a version of it.

Two further lines carry across from the same file, because they are the difference between a useful
artifact and a confident wrong one: *"Distinguish what you observed from what you inferred"*, and
*"If two causes remain consistent with the evidence, name both and say what observation would
separate them."* The second is the escalation format for an ambiguous finding — and it is the rule
§4.1 already invokes when a nickname resolves to more than one candidate.

**These three lines are the whole of what the merge must preserve.** D2 retires a role definition;
it must not retire the reasoning discipline that role encoded, which is the part that was working.

---

## 12. Recorded decisions

All thirteen questions this document opened with were answered on 2026-08-31. They are kept as
**decisions** rather than deleted, because the reasoning behind a settled choice is what a later
reader needs on the day it looks arbitrary. Ten went the way this document recommended; **three did
not**, and those three carry the consequences worked through below.

| # | Decision | Specified in |
|---|---|---|
| **D1** | One role, `observer`, with a `mode` field | §6.1, §7.1 |
| **D2** | **Absorb `investigator` into `observer` NOW** — *overruled* | §6.1 |
| **D3** | Provision a scoped observer service account | §6.3, §10.3 |
| **D4** | **The image-build CI server IS in scope** — *overruled* | §4.2, §5.1a, §6.4, §8 §9 |
| **D5** | Add `read` to the `gcloud` read set in the verb gate | §5.3, §10.1a |
| **D6** | Read-only tokens issued for both CI and the dashboard host | §10.1 |
| **D7** | Hold the `ticket-ops` disclosure line | §0.4, §8 |
| **D8** | An `observer` task captures the baseline before the merge | §2.1 Phase A, §7.2 |
| **D9** | Per-fleet kubeconfig, only the environments that fleet touches | §6.6 |
| **D10** | Cadence in the envelope — worker recommends, orchestrator decides | §7.5 |
| **D11** | `pane_mode: rpc` plus the log viewer | §6.2 |
| **D12** | Every service verified individually, per-service verdict row | §7.2, §9 |
| **D13** | **Resume and backfill the unobserved window** — *no recommendation existed* | §2.1 Phase B′, §7.2 |

### The ten that were adopted as recommended

**D1 — one role, two modes.** The alternative was two roles sharing a skill bundle that must not
drift. The counter-case noted at the time survives and is now handled by D3 and D9 instead: an
inquiry needs no CI access, and the right way to narrow that is a scoped credential and a filtered
kubeconfig, not a second role definition.

**D3 — a scoped service account.** The highest-value item in the original list, and D2 raised its
value further: every former `investigator` task now runs under `observer`'s wider grant (§6.1), so
the credential's scope is doing work that role separation used to do. `impersonate_service_account`
is the only control that binds a worker holding `bash`.

**D5 — the verb-gate widening.** `read` joins the `gcloud` read set. This was the one decision
blocking implementation rather than shaping it; §5.3 records the measurement and why the two obvious
workarounds are deliberately closed.

**D6 — read-only tokens.** Confirms the assumption §10.1 refused to make. The verb gate does not
police `curl`, so for the CI and dashboard channels the read-only property is a property of the
token. With D4 adding a third credential pair, this now covers three tokens rather than two.

**D7 — hold the disclosure line.** Everything site-specific arrives from a mounted file or the task
envelope; the skill names public products and API shapes only. The open worry — that a skill which
cannot name a single real host is unusable by a small model — is accepted as a risk to test on first
run rather than designed around.

**D8 — an `observer` task captures the baseline.** With the ordering constraint accepted knowingly:
a baseline task must complete before the merge, so a planned merge now waits on a worker. §2.1
Phase A confines this to the `watch` weight; the other two shapes have no baseline by construction
and fall back to dating the anomaly.

**D9 — per-fleet kubeconfig.** Not per-task, which would need the dispatch-time write to a
bind-mounted file that §5.10's descoped policy rewriter needed and which this document does not ask
to be built. The operator should expect to run separate fleets when working on production tiers.

**D10 — cadence in the envelope.** The worker returns a recommended next delay; the orchestrator
decides. §7.5's measured cadence validates the operator's own table, and keeping the authority
outside the container is what stops the worker becoming a second scheduler.

**D11 — `rpc` plus the log viewer.** The preference for a watchable worker is real and established,
but `tui` allocates no epoch, which would make a re-dispatched watch pass run twice. `pifleet logs
--worker <id> --follow --render` gives the visibility without voiding the fencing that §7.5 depends
on.

**D12 — per-service verdicts.** A single `assessment` covering a batch is a schema violation. Drawn
from a recorded instruction to check every sibling in a batch rather than extrapolate from one.

### D2 — absorb `investigator` now

**Overruled: this document recommended shipping `observer` alongside `investigator` and retiring the
older role once `observer-ops` had run for real. The decision is to merge in the same change,
before `observer` has run once.**

The full working-through is §6.1, which is now written as a replacement rather than a sibling. The
short version, and the reason the decision is cheap:

- **`investigator`'s tasks map onto `mode: inquiry` with no envelope field becoming mandatory that
  was previously absent.** `mode` defaults to `inquiry`; `environment`, `target`, `channels` and
  `question` are all optional. This holds because §7.1 already establishes that structured fields
  reach no prompt — the brief prose is the channel either way.
- **The output contract tightens, and that is the sharp edge.** A task that would have passed with a
  free-form write-up now fails unless it writes the `observer-ops` artifact pair. That is the one
  regression to watch on first use, and it is the honest cost of the merge.
- **Every former `investigator` task now runs with a wider grant than it needs.** This is the
  security cost, named rather than glossed, and it is why D3 matters more than it did.

Doing this now is cheaper than doing it later precisely because nothing else in the fleet currently
dispatches to `investigator`. The window in which the migration is free closes the first time a
task is written against the old role.

### D4 — the image-build CI server is in scope

**Overruled: this document recommended deferring it, on the grounds that the questions it answers
are better served by a registry read. That reasoning was wrong about which question was being
asked.** The decision was taken for **build-failure diagnosis**, not tag existence — and a registry
read cannot say why a build failed.

Three pieces of design follow, all now in the body:

1. **Ownership becomes two axes** (§4.2). "Was the image built" and "was the image deployed" are
   different questions answered by different servers, and a target can fail either while passing the
   other. A single owner enum cannot express that.
2. **There are two CI dialects, not one API on two hosts** (§5.1a). The build server has no
   flow-node graph, so §2.1 Phase D's stage walk does not apply to it; the skill carries two
   procedures keyed to which server is addressed.
3. **A third credential pair, a third egress rule, bound to its host** (§6.4, §6.5). A credential
   presented to the wrong instance returns a 404 that reads like a missing job.

**The decision is vindicated by this document's own worked example.** The nine-hour blindness case
had no deploy-side pipeline at all and a fault that lived entirely on the build side. With only the
CD servers in scope it is diagnosable to "pods cannot pull an image" and no further. The registry
survives as the cheaper first probe — it answers *does this tag exist* with no extra credential —
and the build server is what turns an absent tag into a cause.

### D13 — resume and backfill the unobserved window

**No recommendation existed; this was left genuinely open.** The decision is that a watch resuming
after a gap must account for the interval it missed rather than simply re-reading the present.

The consequence is that this document's own derived requirement — *every artifact records the
wall-clock time of each observation* — **stops being tidy bookkeeping and becomes load-bearing: the
backfill window is computed from it**, and `last_observed_at` has no other source (§7.2).

§2.1 Phase B′ specifies the rest, and its central rule is that **backfill reads history, not state**.
A point-in-time read is blind to anything that started and cleared inside the gap — a crash loop
that recovered, an eviction, a stall that resolved — and that transient class is exactly what §1.3a
says the role exists to catch. So it reads events, restart deltas and log deltas, whose three
retention profiles differ sharply: restart counters survive an arbitrary gap, logs last days, events
expire first.

**When the gap outruns retention, the artifact records a `coverage: partial` naming the lost signal
and the interval.** An unobserved interval is not a clean interval, and §9.2's rule applies to it
exactly as it applies to an unreachable channel.

---

## 13. Hooks for acceptance criteria

Not criteria — this document does not write them. These are the places where a criterion can be
attached to something that re-checks itself, which is the standard `ISA.md` holds.

- **Config.** A `fleet.yaml` with an `observer` role validates; one whose `secrets:` names something
  the ceiling omits refuses at `up` **by name**; one with `pane_mode: tui` on `observer` is refused or
  warns (§6.2's reasoning); one with `cloud_access: true` and no `cloud.kubeconfig` warns (§6.6).
- **Verb gate.** Every read verb this role's skill uses execs; a representative mutating verb is
  refused with exit 77. This is testable in the image, without a cluster.
- **Egress.** From a worker on the bridge, each allowed destination class is reachable on 443 and a
  neighbouring port on the same host is not — the `port` half of the rule enforced, not just the host.
- **Credential handling.** No granted token value appears in any artifact this role produces; the
  base URLs *do* appear and are **not** refused, which is the `credential: false` behaviour (§6.5)
  asserted as a positive so that regressing it fails a test rather than drifting.
- **Artifact schema.** An `observer-ops.json` missing any required field fails validation; a run that
  writes only the `.md` clamps to `failed`.
- **The verdict rule.** Given a fixture where the control plane is unreachable and logs show no
  errors, the artifact's `assessment` is `indeterminate` and not `healthy`. **This is the single most
  important criterion in the document** — it is the encoded form of §9.2, and it is checkable with
  fixtures and no infrastructure.
- **Convergence predicate.** Given fixture workload JSON with one terminating old-revision pod
  present, the predicate reports *not converged*. Derived directly from a recorded false-green, and
  likewise needs no cluster.
- **Degradation ladder.** For each row of §5.5's table, a fixture produces the stated capability and
  the stated verdict.
- **Log-window construction.** A generated log query carries explicit `timestamp >=` and `timestamp <`
  bounds and does not combine the freshness flag with ascending order (§5.3).
- **The verb-gate widening landed (D5).** `gcloud logging read` execs and is recorded as
  `allow_read`; `gcloud auth print-access-token` and `gcloud container clusters get-credentials`
  still refuse with exit 77. Asserting the *refusals* alongside the new allowance is the point — a
  widening that took more than one token with it is the failure mode.
- **`investigator` migration (D2).** An envelope written for the old role — no `mode`, no
  `environment`, no `target` — parses, defaults to `mode: inquiry`, and dispatches. This is the
  claim §6.1 rests on and it is checkable at the schema, with no worker.
- **Two CI dialects (D4).** Given a build-server fixture with no stage graph, the diagnosis path
  reads the console log and does **not** report a missing build. Derived from §5.1a's stated failure
  mode, fixture-testable.
- **Backfill reads history, not state (D13).** Given a fixture where a pod crash-looped and
  recovered entirely within the gap, a `phase: backfill` pass reports the restart, while a
  point-in-time state read of the same fixture does not. **This is the criterion that encodes D13's
  whole justification**, and it needs no infrastructure.
- **Backfill retention honesty.** Given a gap longer than the event retention window, the artifact
  records `coverage: partial` naming the lost signal, rather than reporting a clean interval.

The last several are the shape to prefer: **fixtures, not live infrastructure.** The main SRD's
strictness rule holds that a criterion re-checked only by a local, environment-dependent probe grades
`[~]` rather than `[x]`, and every criterion in this role that depends on a VPN tunnel, a corporate
proxy or a real cluster is exactly that. **The channel-reconciliation logic — which is where the
value and all the recorded failures live — is fixture-testable, and it should be built so that it is.**

---

## 14. References

- `Docs/SRD.md` — §3.5 pane modes, §5.3 toolchain, §5.5 mount table, §5.8 Google credentials,
  §5.10 verb gate, §6 configuration, §7.1–7.3 envelopes and verdicts, §9.1 isolation, §12.4
  credentials and egress, §12.6 worker prose as data, §12.8 containment.
- `skills/ticket-ops/SKILL.md` — the precedent for credentials, artifacts and verdicts.
- `skills/pifleet-worker/SKILL.md` — the role-independent worker contract.
- `roles/ticketing.md` — the register for `roles/observer.md`.
- `roles/investigator.md` — **superseded by `roles/observer.md` under D2**; retained here as the
  source of the two rules §11.3 carries forward, and as the register the replacement is written to.
- `fleet.example.yaml` — the disclosure discipline for a committed config.
