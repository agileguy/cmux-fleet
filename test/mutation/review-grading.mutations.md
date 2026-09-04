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

Result: baseline measured green before every run, and the battery aborts if it is
not. Counts are re-derived on each run rather than carried forward — the previous
revision of this line recorded 84 probes when the four files collected 86, which
is the same drift the CI totals in `.github/workflows/ci.yml` keep a whole
paragraph about.

**Neither battery runs in CI, and that is now a decision rather than a
consequence of the filename.** `bun test` does not collect `*.battery.ts`, which
is right: each run executes the unit suite dozens of times. The cost was that
nothing noticed when a battery stopped being *about* the code — an anchor is a
literal string, and a rename turns it into `0x` silently for everyone who does
not re-run the battery by hand. `test/unit/mutation-anchors.test.ts` closes that
half: it reads every committed battery, resolves every `find` anchor against the
committed source, and fails when one no longer matches exactly once. The
expensive half stays manual; the half that rots is checked on every push.

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
| H4 | The ISC-94 guard is removed, so a task with NO ENVELOPE is given a claim of `success` | **This was filed as a semantic no-op and the argument was false.** It claimed a verdict can only exceed `partial` when the claim was `success` — but ISC-94 makes `claimed === null` a NO-OP rather than a downgrade, so a task with green harvester-run acceptance and no envelope grades `success` with no claim at all. Measured: a `-collate` task with a worktree and one passing acceptance command grades `success` unmutated and `partial` mutated. **A document the worker never wrote clamping the one class of evidence a fabricating worker cannot author.** It does not bite in the shipped config only because the collator is `shared-ro` — a config fact, and `isCollationTaskId` also matches any operator task named `*-collate`. |
| H4b | The ISC-94 guard is inverted, so ONLY envelope-less tasks are graded | The other half of the conjunction; without it, deleting the rule outright would pass H4's assertion. |
| H5 | The harvester's collation ceiling becomes an assignment | **Also mis-filed as a no-op, in a row whose own body said "untested rather than proven inert" — which cannot both be true.** Measured: a `-collate` repository task with an empty diff, a claim of `success` and no `collation.json` grades `failed` by ISC-93 unmutated, and `partial` mutated. A worker's own MISSING document promoting a verdict the diff already refused, which is A2's defect one module over. The separating fixture builds a real one-commit git repository with `base_ref` at `HEAD`, so `base..HEAD` is empty by construction — no container, no exam, no network. |
| H6 | The wrapper is bypassed and the raw ceiling is handed a fabricated claim | The wiring half of H4: the guard is only worth having if the call site uses it. |
| C10 | The empty-path refusal is removed | `withinWorkdir("/workspace","")` already returns false through the `rel === ""` arm, so **both branches agreed** and the fixture — which asserted only `typeof problem === "string"` — could not tell them apart. It now asserts the SENTENCE, which is the only thing that separates them. |
| C11 | `!Number.isInteger(line)` is dropped from the line check | Every fixture's line was a whole number, so `line: 12.5` counted as located. `findingLocationProblem` is exported and has callers beyond the census, so the bound is its own. |
| C12 | A refused census publishes `declared: 0` instead of `null` | "This document never told us a count" and "this document declared zero findings" are different claims. The refused arm's published fields were asserted only for `readable` and `refusal`. |
| W1 | The watch never abandons a console that is gone | §6.5's *"dies with the console"*, deleted. The relay polls a dead run forever and the next `scripts/review` believes an actor is serving the new console. |
| W2 | The watch exits on the FIRST negative observation | Liveness is read from a state file and a `ps`, both of which fail transiently; the actor's lifetime would depend on a race it has no stake in. |
| W3 | A positive observation no longer resets the streak | Isolated transient failures accumulate into an exit. The separating fixture interleaves them. |
| W4 | A relay serving another console is adopted as this one's | **The measured L1 defect.** Run the script, close the workspace by hand, run it again: four new runs, and the script reports the old console's relay as healthy. |
| W5 | The worker set is not compared | Two `--workers` variants produce relays that differ in nothing `run_id` can see. |
| W6 | The capture-failed sentinel is compared rather than recognised | `""` matches no real start time, so a LIVE relay reads as stale; `--recreate` then deletes its record and tears down the runs it is polling. `isPinnedIdentity` is the repository's own test for "is this comparable at all". |
| W8 | The start lock drops `O_EXCL` | Two invocations both spawn, and the console has two actors it can account for one of. |
| I1 | `run/collation.ts` imports the ids from `relay.ts` again | ISC-468. This is the exact edge this change opened once: `monitor -> read/report -> report/collect -> harvest/index -> run/collation -> run/relay -> cli/commands/*` put all 27 CLI command modules in the monitor's closure. |

### C1's anchor covers three arms, and only two are separated

`C1` replaces the whole body of `withinWorkdir`, so it reddens if ANY of the
three containment arms matters. `C2` and `C3` separate two of them. The third —
`if (isAbsolute(rel)) return false` — is `C3b`, and it is **green**: on POSIX,
`relative()` never returns an absolute path, so the arm is unreachable. It is
kept because `node:path`'s Windows flavour can return one, and named here so the
table is not read as per-arm coverage when it is not.

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

### Negative controls — must stay green or the battery reddens on everything

| # | Mutation |
|---|---|
| NC1 | Rename the local `coverage` in `censusCollation` (declaration + three uses) |
| NC2 | Reword the empty-path defect sentence, which no assertion quotes |

## Uncovered regions — named, not counted

These are real gaps. Each is a place where a behaviour change would not be
caught by the four files this battery runs.

- **`scripts/review` AFTER the dry-run boundary.** The first clause of the
  previous version of this entry — that `main()` runs at import, so the script is
  not importable — is true. The second, that no probe reaches it, was **false**:
  `test/integration/operations-console.test.ts` spawns
  `scripts/review --dry-run --config fleet.example.yaml` and asserts on its
  output, which exercises argv parsing, `--workers`, `loadConfig`,
  `resolveWorker` and `reviewPanes` down to the `--dry-run` return.
  **Overstating a gap is the safe direction, but the stated reason is what a
  future reader uses to decide not to write the test**, and this one prescribed
  a shape (`relay-script.test.ts`'s fake-`pifleet`-on-PATH) that was already in
  use two directories away. Genuinely uncovered is what runs after that return:
  the `--recreate`/`stopRelay` ordering, `startRelay` after the panes, and the
  `--no-relay` and `--relay-stop` branches. L1 lived in exactly that region.
- **The spawn itself.** `startRelay` opens the log fd, spawns detached, `unref`s,
  captures the identity and writes the record. `consoleRelayArgv` and
  `readRelayStatus` are pinned; the spawn between them is not, so a relay started
  with the wrong cwd, without `PIFLEET_RELAY_RUNS` in its environment, or with its
  output going nowhere would pass everything here.
- **`signalRelay`.** Never called by a test. Sending a real SIGTERM in a unit
  suite means spawning a process to kill, which is integration-shaped.
- **The watch's OBSERVATION, as opposed to its policy.** `ConsoleWatch` is
  pinned exhaustively, and the `productionRunSources.isLiveWorker` call that
  feeds it is not — a loop that observed the wrong worker, or inverted the
  boolean, would pass every probe here. `W7` is the same shape one function over:
  reporting an unreadable `ps` as `stale` is green because no fixture makes
  `processStartTime` throw.
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
