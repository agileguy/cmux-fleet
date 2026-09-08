---
name: observer-ops
description: How the observer role writes its result — the observer-ops.json/.md artifact pair, the deploy and inquiry task shapes, and where the fuller procedural content (target resolution, channel reconciliation, the degradation ladder) belongs. Mounted for the observer role.
---

# observer-ops

**Scope of this file, stated up front.** This bundle exists so `observer`'s `fleet.yaml` entry
names a real, mounted skill directory rather than a bundle that is not there — the shape
`fleet.example.yaml`'s own comment on `sre`/`tdd`/`diagnose` warns against, restated here in the
other direction: the DIRECTORY exists, and inventing the channel-reconciliation content it will
eventually carry (Docs/SRD-DEPLOY-OPS.md §4, §5, §8) to make this file longer would be worse than
saying plainly that it is not built yet. What is documented below is the part the role definition
and the config surface already depend on: the artifact contract. The rest — target resolution
(§4.1), delivery-mechanism detection (§4.2), the four observation channels and their failure modes
(§5), and the full skill procedure §8 specifies — is a separate, later piece of work.

## The two task shapes

Read `mode` before anything else. `mode: deploy` watches a merged change through its pipeline
into a running system, checked against a baseline taken before the merge. `mode: inquiry`
answers a bounded question about a system nobody just changed, and is the default when `mode`
is absent — an envelope written with no `observer`-specific fields at all still runs as an
inquiry (Docs/SRD-DEPLOY-OPS.md §6.1, §7.1).

## The artifact pair

Your whole output is `observer-ops.json` and `observer-ops.md` in
`/outbox/<task-id>/files/`, exactly as `pifleet-worker` describes for `<task-id>`. Both files,
every time: a run that writes only the `.md` clamps to `failed`, the same rule `ticketing`
runs under and for the same reason — the file nothing inspects is the one that was supposed to
carry the evidence. The `.md` is for the human who was not watching; the `.json` is what the
harvester validates and sweeps for a leaked credential.

**`observer-ops.json` MUST carry three fields the host gates on, and two of them are the
ones runs keep forgetting:**

```json
{
  "worker": "<your worker id>",
  "sweep_id": "<the sweep id from your brief, character for character>",
  "window_opened_at": "<the observation-window instant from your brief, verbatim>",
  ...your rows...
}
```

**Copy both out of the brief, and from nowhere else.** Not from your transcript, not from a
previous artifact, not reconstructed from the clock. The host compares what it minted against
what comes back: an artifact whose `sweep_id` is missing or does not match is **discarded
whole**, and every service in it is recorded as one nobody observed.

**`assessment` is a CLOSED FOUR-MEMBER ENUM, and `failed` is not in it:**

```
healthy | degraded | unhealthy | indeterminate
```

**A fifth token voids the WHOLE DOCUMENT, not the row it is in.** The collation is parsed
with one schema in one pass, so a single unrecognised assessment refuses `triage.json`
entire and every service in the sweep - including the ones you graded correctly - is
recorded as unobserved. Measured 2026-09-08: `grafana` was written `failed`, and the parser
answered

```
services.2.assessment: Invalid option: expected one of "healthy"|"degraded"|"unhealthy"|"indeterminate"
```

so two healthy services and one real Grafana fault all became `coverage`. One word in one row.

**`failed` is a TASK STATUS and belongs in `result.json`, never in an assessment.** The two
vocabularies sit a few lines apart in this file - "a run that writes only the `.md` clamps to
`failed`" is about your TURN - and that adjacency is exactly how the wrong one gets reached
for. A service whose channels answered and answered badly is **`unhealthy`**; a service
answering worse than it should but still serving is **`degraded`**; a service you could not
see is **`indeterminate`**. There is no fourth thing that "failed" describes.

**An absent field is not a smaller report, it is no report.** Measured 2026-09-08 across a
whole session: five consecutive sweeps produced correct, well-shaped artifacts — right
workloads, right verdicts, a real Grafana fault found — and every one was thrown away for
want of these two strings. The console recorded `coverage` on a cluster that had answered,
`consecutive_indeterminate` climbed to 60, and nothing in the observer's own output looked
wrong. This is the single cheapest way to make a whole turn's work count for nothing, and it
is invisible from inside the task.

## Resolving the target before you report on it

A request names a service, a URL or an address. None of those is a workload. Resolve it, and say
in the artifact what you resolved it to — a confident report about the wrong object is the
failure this step exists to prevent.

Work outward from whichever end you were given: an address to the service that answers on it, a
service to its selector, a selector to the pods actually matched. `kubectl get ingress,svc -A`
and `kubectl describe svc <name> -n <ns>` connect the first two.

**A named service is often SEVERAL workloads, and `NotFound` on the literal name is the
START of resolution rather than the end of it.** The name in a brief is a LOGICAL service
- the thing an operator calls it - and nothing promises a Kubernetes object carries that
string. A namespace whose brief omits `workload` omits it precisely because more than one
deployment lives there; that omission is an instruction to resolve, not a gap to report.

Measured 2026-09-08, and it is the whole failure in three lines:

```
kubectl get svc -n aodapnc-alerts-notifier-dev alert-notifier   -> Error: services "alert-notifier" not found
kubectl get svc -n aodapnc-alerts-notifier-dev                  -> alert-processor, ingestor, notification-processor
```

The observer reported `indeterminate - no service named alert-notifier found` while its own
NEXT command printed the three deployments that ARE it: `alert-notifier` is the pipeline
`ingestor -> alert-processor -> notification-processor`, every component 3/3 and 110 days
old. It stopped one step short of an answer that was already on its screen. A previous sweep
resolved the same target correctly, so this is inconsistency rather than an impossible task -
which is exactly what a written rule fixes.

So when the literal lookup misses:

- **Enumerate the namespace before concluding anything.** `kubectl get deploy,statefulset,svc -n <ns>`
  is one call and it either shows you the component set or genuinely shows you nothing.
- **A component set IS the resolution.** Several workloads whose names are obviously facets of
  the requested one - a pipeline, a producer/consumer pair, an api/worker split - resolve the
  target. Report a row per component, or one row that NAMES every component it covers. Do not
  pick one silently, and do not average their health into a single word without saying which
  ones you looked at.
- **`indeterminate` still requires that you looked.** "I could not resolve this" is legitimate
  only after the namespace enumeration came back with nothing plausible. "The literal name was
  not a Service object" is not a resolution attempt, and an artifact saying so about a namespace
  holding three healthy matching deployments is a wrong answer wearing an honest word.


## The commands, and what each one does not tell you

```bash
kubectl get deploy -n <ns> -o wide          # rollout completion, and image tags
kubectl get pods  -n <ns> -o wide           # per-pod phase AND restart counts
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -40
kubectl get pods -n <ns> -l <selector> -o name       # enumerate FIRST, then one at a time
kubectl logs -n <ns> <pod> -c <ctr> --since=300s --tail=200   # bounded: see "The 50KB wall"
```

**`get deploy` answers "did the rollout complete" and nothing else.** `3/3` with every replica
available is compatible with a service delivering nothing at all. When the question is whether
something is working, the deployment line is context, not the answer.

**Read restart counts, not just phase.** A pod in `Running` that has restarted forty times is a
crash loop between crashes. `READY 1/1` and `RESTARTS 40` appear on the same line and only one
of them is usually read.

**Confirm your selector matched something before you trust a quiet log.** `kubectl logs -l` with
a label nothing carries exits zero and prints nothing — identical to a healthy, silent service.
Label conventions differ between charts; `app.kubernetes.io/name=<x>` and `app=<x>` are both
common and picking the wrong one yields a clean-looking zero. Run `kubectl get pods -l <selector>`
first and put the pod count in the artifact.

**Container logs rotate.** Roughly a day of history is on disk regardless of how long the pod
has run, so `--since=72h` returns what survived, not seventy-two hours. For anything older,
go to a log sink or a datastore and say which you used.

## The 50KB wall, and writing before you hit it

**`kubectl logs -l <selector>` across a multi-replica workload will blow the tool
output cap, and the truncation notice is not a warning you can read past.** It looks
like this:

```
WARNING: OUTPUT TRUNCATED - the text below is NOT the whole output.
    kept  49.9KB of 61.6KB (225 of 297 lines), clipped from the FRONT - the limit hit was 50.0KB
```

**Clipped from the FRONT is the dangerous half.** The oldest lines go first, so the
window you were asked about is exactly the part you lose, and what survives is the
tail you would have got from a much narrower query anyway. A verdict drawn from a
truncated dump is a verdict about the last few seconds wearing the label of a
five-minute window.

Measured 2026-09-08 on `T-sweep-1-slice1`: an observer hit this on three of seven
calls, spent the turn re-running variations of the same unbounded `logs` command to
recover what had been clipped, and its turn ended with an empty outbox. Every read
was thrown away and the service was recorded unobserved.

**So bound the pull before you make it, every time:**

```bash
kubectl logs -n <ns> <pod> -c <container> --since=300s --tail=200   # ONE pod, ONE container
kubectl get pods -n <ns> -l <selector> -o name                      # enumerate first
```

- **`--tail=` is not optional on a `logs` call.** 200 lines per container is enough to
  see a crash loop, a panic or a flood; the whole buffer is not.
- **Enumerate pods, then read them one at a time.** `-l <selector>` multiplies the
  output by the replica count, which is what puts a three-replica workload over the
  cap on a single call. Per-pod also tells you WHICH replica is unhealthy, which the
  merged dump cannot.
- **A truncated result is a failed read, not a smaller one.** Do not analyse it.
  Re-run it bounded, once, and if it truncates again say so in the artifact and move
  on rather than fetching a third time.

**Write the pair at fifty calls, whatever you have.** `roles/observer.md` says twenty,
and twenty was sized for the unbounded dumps this section forbids - when one `logs`
call could eat a whole turn's budget, stopping early was the only way to get an
artifact at all. Bounded reads change the arithmetic: `--tail=200` against one
container is cheap, a three-service sweep across several components is legitimately
dozens of them, and cutting off at twenty now buys a written artifact by throwing away
the investigation that would have made it worth reading.

So fifty is a CHECKPOINT, not a stop. Write `observer-ops.json` and `observer-ops.md`
at fifty with whatever rows you can support - `indeterminate` is a legitimate row and
names what you could not see - then keep going and overwrite them with a better
version. A first artifact on disk at call fifty and a second at call eighty is strictly
better than one perfect pair that never gets written, and it is the only version of
this that survives running out of turn.

## What you do NOT run, and why the refusal is correct

**Never `kubectl exec`. You do not have it, and you are not supposed to.** The verb gate
refuses it and the refusal names the task:

```
verbgate: 'kubectl exec <pod>' not authorized for task <task-id>; add it to cloud_allow[] to permit
```

**That message reads like a gap to be filled and it is not one.** Measured on `T-prom-1-slice1`,
2026-09-08: an observer tried `kubectl exec … -- curl -s http://localhost:9090/-/healthy`, was
refused, and recorded the service `indeterminate` *because it had been blocked*. Read plainly,
that is an observer asking for a shell inside a production container in order to talk to that
container about itself — and the answer it would have got is the least trustworthy evidence
available, since a process reporting its own liveness from inside its own network namespace has
told you nothing about whether anything else can reach it.

So the rule is a REFUSAL rather than a budget:

- **No `kubectl exec`, for any reason.** Not to curl, not to `cat` a config, not to list a
  directory, not "just to check". There is no task shape that makes it appropriate here.
- **No `curl` to `localhost` or a pod IP from inside anything.** See above: it is a container
  asking itself, and it is the one probe that cannot distinguish healthy from unreachable.
- **No `curl` at an ingress, a service URL, or any external endpoint.** Reaching a live endpoint
  is a different capability with a different blast radius, and it is not this role's. Resolving
  an ingress to the workload behind it — `kubectl get ingress,svc -A` — is in scope; *calling*
  it is not.

**And do not write the block into the artifact as the reason for a verdict.** "indeterminate
because exec was denied" is a report about your own permissions, not about the environment, and
it sends a reader looking for a `cloud_allow[]` entry that is deliberately absent. If the
channels you DO have cannot settle the question, say which channels you read and what they could
not show — that is a real coverage statement and it is actionable. An endpoint check simply is
not one of the procedures you run; a request that names it is answered from rollout, logs,
events and the sink, or it is answered `indeterminate` on those grounds.

## Cloud logging, and the two ways it lies

```bash
gcloud logging read '<filter> AND timestamp>="2026-09-01T00:00:00Z"' \
  --project <p> --limit 200 --format json
```

- **An explicit `timestamp>=` bound, always.** A relative freshness flag combined with ascending
  order returns rows outside the window you asked for. Set the boundary in the filter itself and
  check the newest and oldest rows you got back against it.
- **Routing is not uniform.** Whether a given workload's logs are readable from a given project
  varies, and an unreadable source returns zero rows with a zero exit — the same shape as
  nothing having happened. **Prove the query reaches the source** by first fetching ANY row for
  that workload over a wide window. If you cannot, the finding is that you could not look, not
  that there was nothing to see.

## Before and after

The baseline is taken FIRST. When the task is a `mode: deploy` watch you take it before the
merge lands; capture the same commands you intend to run afterwards, so the two are comparable
rather than two different questions asked at two different times.

When you are handed the work after the fact — which is the common case, since the request
usually arrives once a pipeline has already finished — you have no observed baseline. Say so,
and reconstruct what you can from retained history: the previous ReplicaSet's image tag, log
lines predating the rollout timestamp, the deployment's own revision annotations. A
reconstructed baseline is worth having. One presented as though it were observed is not.

Compare like for like: the same selector, the same window length, the same source on both sides.
An "after" window three times longer than the "before" window will show more errors for that
reason alone.

## What is NOT yet in this bundle

Target resolution and the control-plane and log procedures are above. Still unwritten: the CI
channel and its two dialects (D4), the dashboard channel, the convergence predicate, the verdict
rule (which of the four assessment tokens a mixed channel set earns), and the backfill
behaviour on a resumed watch
(D13). Docs/SRD-DEPLOY-OPS.md §8 is the specification for that content when it lands.

Until the verdict rule is written here, apply the one your briefing states and do not invent a
finer one: a channel you could not reach is `indeterminate`, never `healthy`.
