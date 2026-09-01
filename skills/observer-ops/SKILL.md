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

## Resolving the target before you report on it

A request names a service, a URL or an address. None of those is a workload. Resolve it, and say
in the artifact what you resolved it to — a confident report about the wrong object is the
failure this step exists to prevent.

Work outward from whichever end you were given: an address to the service that answers on it, a
service to its selector, a selector to the pods actually matched. `kubectl get ingress,svc -A`
and `kubectl describe svc <name> -n <ns>` connect the first two.

## The commands, and what each one does not tell you

```bash
kubectl get deploy -n <ns> -o wide          # rollout completion, and image tags
kubectl get pods  -n <ns> -o wide           # per-pod phase AND restart counts
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -40
kubectl logs -n <ns> -l <selector> --since=6h --tail=2000
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
rule (`indeterminate` vs `healthy` vs `failed`), and the backfill behaviour on a resumed watch
(D13). Docs/SRD-DEPLOY-OPS.md §8 is the specification for that content when it lands.

Until the verdict rule is written here, apply the one your briefing states and do not invent a
finer one: a channel you could not reach is `indeterminate`, never `healthy`.
