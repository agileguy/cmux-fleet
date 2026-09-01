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

## What is NOT yet in this bundle

Target resolution, the CI/control-plane/log/dashboard channel procedures, the two CI dialects
(D4), the convergence predicate, the verdict rule (`indeterminate` vs `healthy` vs `failed`),
and the backfill behaviour on a resumed watch (D13) all belong here and are not written yet.
Docs/SRD-DEPLOY-OPS.md §8 is the specification for that content when it lands.
