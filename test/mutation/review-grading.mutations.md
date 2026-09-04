# The review console's grading and wiring — mutation table

What `test/unit/collation-census.test.ts`, `test/unit/harvest-collation-wiring.test.ts`,
`test/unit/review-console-relay.test.ts` and `test/unit/monitor-readonly.test.ts`
actually catch, and what they do not. Produced by
`test/mutation/review-grading.battery.ts`, which must be pointed at a throwaway
`git worktree` — it rewrites source files in place, and a transient broken state
in a live checkout is read by things that spawn containers from the tree.

```sh
git worktree add /tmp/wt HEAD --detach
ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
bun run test/mutation/review-grading.battery.ts /tmp/wt
```

The battery snapshots the worktree's own files at start-up, restores before and
after every mutation, and verifies the checksum each time. It refuses a path
ending in `/cmux-fleet`. **It measures its own baseline first and exits 1 if the
unmutated worktree is not green** — a battery whose baseline is red reports every
mutation as caught and has measured nothing.

Result on `cc3f1ce`: baseline green (84 probes), **31 mutations, 0 unexpected.**

## Reds — the mutation changes behaviour and a test catches it

| # | Mutation | Catches |
|---|---|---|
| C1 | `relative()` containment becomes `startsWith` | `/workspacex/a.ts` and `/workspace/../etc/passwd` both counted as located. The prefix test is the mutation this rule was always going to lose to, and the two fixtures exist for it specifically. |
| C2 | A path whose first segment is `..` is contained | Traversal out of the workdir reads as a quotable finding. |
| C3 | The workdir itself is a quotable file | `/workspace:1` is a finding nobody can act on. |
| C4 | `located` incremented regardless of the problem | §6.8's first rule stops meaning anything while the defect list still reads correctly. **Caught as a TIMEOUT rather than a failure** — see the note below. |
| C5 | `line < 1` accepted | `line: 0` and `line: -3` are what a model emits when it has nothing to point at. |
| C6 | The backslash refusal is removed | ISC-247's separator confusion: `/workspace/src\..\..\etc\passwd` is one POSIX segment inside the workdir and traversal to any consumer that normalizes separators. |
| C7 | The agreement histogram counts findings rather than reviewers | Every finding reads as `1/3`; the consensus band §1.3's whole arithmetic rests on is gone from the record. |
| C8 | `lenses_missing` is always empty | A two-lens review records as three-lens. §9 Q6's datum silently disappears. |
| C9 | `declared` is set from `findings.length` | The one disagreement the field exists to make legible — four findings claimed over a list of two — becomes unrepresentable. |
| K1 | The ceiling's claim antecedent is dropped | A task with NO envelope is capped by a document the worker wrote, over the harvester's own re-run acceptance. The one case the antecedent is load-bearing for. |
| K2 | `located === counted` becomes `located <= counted` | The ceiling never fires. Always-true comparisons are the quiet way a rule is disabled. |
| K3 | A shape defect grades `failed` rather than `partial` | A collation with one unlocatable finding is not a failed review. |
| A1 | The adjudicator never consults the census ceiling | §6.8's first rule has no live call site. |
| A2 | The adjudicator's ceiling becomes an assignment | A worker's own document RAISES a verdict ISC-93's empty-diff rule already failed. |
| H1 | The census never reaches the fact bundle | It leaves `facts_hash`, so the adjudication stops being replayable, and the ceiling goes dark with it. |
| H2 | The census is never published in the harvest | `3/3` and `1/3` never reach the record §6.8 asks for them to be visible in. |
| H3 | `collationCeiling` is never applied | §6.8's third rule and its `missing`/`refused` siblings go dark; "write no artifact" becomes the way out of the instrument. |
| S1 | A dead worker holds its seat in the pin | `pifleet down` leaves directories, so the relay is pinned to a corpse — and a pin REPLACES the scan that would have found the live run. |
| S2 | An ambiguous worker resolves to the first run seen | A review dispatched into another fleet's worker and collated here as this console's lens. |
| S3 | A partial pin is spelled | `consoleRunResolution` takes the pinned branch whole, so the missing worker stays missing for the life of the process while the relay looks configured. |
| O1 | The adoption guard never refuses | §6.10: a person's `review` workspace adopted and its panes respawned with pifleet commands. |
| O2 | Pane titles compared in order rather than as a multiset | A healthy console is REFUSED, which sends the operator to `--recreate` and causes the destruction the guard exists to prevent. |
| O3 | Both separators dropped from the comparison key | `["ab","c"]` and `["a","bc"]` are different pane sets that concatenate alike. |
| O4 | Only the join separator dropped | Same collision. **The NUL is not a separator** — it prefixes the `untitled` placeholder only, so a real pane titled `untitled` cannot impersonate an untitled one. Written down because the battery's first run assumed otherwise and was wrong. |
| I1 | `run/collation.ts` imports the ids from `relay.ts` again | ISC-468. This is the exact edge this change opened once: `monitor -> read/report -> report/collect -> harvest/index -> run/collation -> run/relay -> cli/commands/*` put all 27 CLI command modules in the monitor's closure. |

### C4 is caught by a TIMEOUT, and that is worth naming

Counting every finding as located makes `censusCeiling` return `null` on the
degraded fixtures, which changes what several probes assert — but the observable
in the battery is a 60 s timeout rather than a clean failure. The mutation makes
`harvest-collation-wiring.test.ts` do more filesystem work per probe than the
budget allows. It is a real red, and it is a red whose SHAPE is a hang, so the
battery's own timeout is load-bearing here exactly as `M7`'s was in
`collator-relay.mutations.md`. A battery without a hard timeout would report this
one as a pass, because the run never ends.

## Greens — and which kind of green each one is

### Semantic no-ops — the mutation genuinely changes nothing

| # | Mutation | Why green is correct |
|---|---|---|
| K4 | The `counted === 0` short-circuit is removed from `censusCeiling` | With zero findings, `located` and `counted` are both 0, so the next disjunct returns `null` anyway. The short-circuit is documentation of intent, not a branch — and §6.8's third rule is deliberately NOT this function's, it is `collationCeiling`'s. |
| K5 | The `!census.readable` guard is removed | A refused census carries `counted: 0`, so it exits through the same disjunct. The guard states which module owns the `refused` arm; it does not decide anything. |
| H4 | The harvester passes `"success"` where it passed `claimed?.status ?? "unknown"` | **A no-op by the lattice, not by luck.** The ceiling is applied under `rank(verdict) > rank(collationCap.status)`, and a verdict can only exceed `partial` when it IS `success` — which requires the claim to have been `success`, since self-report may downgrade and never upgrade. So the two expressions can only differ where the guard already blocks. The `?? "unknown"` is honest defence for a future edit that removes the rank guard, and nothing observable rests on it today. |
| H5 | The harvester's collation ceiling becomes an assignment | Reachable only when `collationCeiling` returns a status ABOVE the current verdict, and it only ever returns `partial` or the claim itself. No fixture separates them, and the rank guard is retained for the same reason ISC-243's is: a maximum that reads as one. **This one is a green I would not lean on** — it is untested rather than proven inert. |

### Negative controls — must stay green or the battery reddens on everything

| # | Mutation |
|---|---|
| NC1 | Rename the local `coverage` in `censusCollation` (declaration + three uses) |
| NC2 | Reword the empty-path defect sentence, which no assertion quotes |

## Uncovered regions — named, not counted

These are real gaps. Each is a place where a behaviour change would not be
caught by the four files this battery runs.

- **`scripts/review`'s own control flow.** The script runs `main()` at import, so
  nothing in it is importable and no probe reaches it. Everything it DECIDES was
  pushed into `status-runs.ts`, `console-relay.ts` and `operations.ts` and is
  covered above — but the ORDER it calls them in is not: that `stopRelay` runs
  before the runs go down, that `startRelay` runs after the panes are up, that
  `--no-relay` suppresses it and `--relay-stop` returns before the cmux probe.
  Closing this means an integration test that drives the script with a fake
  `pifleet` on PATH, which is the shape `relay-script.test.ts` uses for the
  egress relay.
- **The spawn itself.** `startRelay` opens the log fd, spawns detached, `unref`s,
  captures the identity and writes the record. `consoleRelayArgv` and
  `readRelayStatus` are pinned; the spawn between them is not, so a relay started
  with the wrong cwd, without `PIFLEET_RELAY_RUNS` in its environment, or with its
  output going nowhere would pass everything here.
- **`signalRelay`.** Never called by a test. Sending a real SIGTERM in a unit
  suite means spawning a process to kill, which is integration-shaped.
- **A second `collation.json` in a subdirectory.** `reconcile.ts` reports it and
  keeps the first in path order. No fixture writes two, so the branch is
  unexecuted — and its whole point is that a worker must not get to pick which
  collation is graded.
- **The byte-cap arm of the collation read.** `reconcile.ts` maps a
  `digestHeldArtifact` refusal onto `{kind: "refused", code: "too_large"}` so that
  making the file enormous cannot turn the census off. Reaching it needs an
  artifact above `MAX_ARTIFACT_BYTES`, which no fixture writes.
- **`relayLogPath` and the log's append semantics.** The path is asserted to sit
  outside the runs root; that its content survives a restart is not.
- **Everything downstream of a real relay pass.** This battery never starts one.
  `collator-relay.mutations.md` covers the fan-out core; what is untested is the
  seam where `scripts/review` hands it a run id and a pin.
