# Collation contract and collator role — mutation table

What `test/unit/collation.test.ts` and `test/unit/collator-role.test.ts` actually
catch in `src/run/collation.ts` and `roles/collator.md`, and what they do not.
Produced by `test/mutation/collation-contract.battery.ts`, which must be pointed
at a throwaway `git worktree` — it rewrites source files in place, and a
transient broken state in a live checkout is read by things that spawn containers
from the tree.

```sh
git worktree add /tmp/wt HEAD --detach
ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
cp src/run/collation.ts /tmp/wt/src/run/
cp test/unit/collation.test.ts test/unit/collator-role.test.ts /tmp/wt/test/unit/
cp roles/collator.md /tmp/wt/roles/
bun run test/mutation/collation-contract.battery.ts /tmp/wt
```

The battery snapshots the worktree's own files at start-up, restores before and
after every mutation, and verifies the checksum each time. It refuses a path
ending in `/cmux-fleet`. **It measures the unmutated baseline first and refuses
to run if it is not green** — a battery whose suite is already red reports every
mutation as caught, which is the most flattering possible failure.

Run of 2026-09-04: **BASELINE pass, 61 mutations, 0 unexpected, ALL FILES
RESTORED OK.** Restore additionally verified out of band by `shasum -a 256`
against the live checkout and `git diff --stat`, which shows `roles/collator.md`
as the only tracked file this change touches.

## The role document is source

`roles/collator.md` is mutated alongside the TypeScript because it is the program
the collator executes. The version this change replaces told the collator to
write its fan-out to `/outbox/fanout.json` and to read three reports from
`/outbox/reports/rev-arch-1.md` — **neither path has ever existed in this
repository.** A collator following it writes a file no poller reads, and every
layer downstream records a healthy console that reviewed nothing. R1 is that
defect, re-applied, to prove it now reddens.

## Reds — the mutation changes behaviour and a test catches it

### The contract

| # | Mutation | Catches |
|---|---|---|
| C1 | `raised_by` need only name a lens, not one that REPORTED | **The 3/3 fabrication.** A two-lens review crediting the missing lens records three independent readers where there were two. |
| C2 | A repeated reviewer in `raised_by` is accepted | `1/3` read as `2/3` by anything that counts the array — the same fabrication `resolveAspects` refuses for duplicate seats. |
| C3 | A worker outside the lens table may raise a finding | A finding attributed to a reader that does not exist. |
| C4 | `raised_by` may be empty | An unattributed finding: "three reviews destroyed to make one". |
| C5 | One lens may both raise and dispute a finding | One reader counted on both sides of a contradiction. |
| C6 | A lens that never reported may dispute a finding | A lens that produced nothing recorded as having taken a position. |
| C7 | One worker may hold two lenses | The denominator doubles; `1/3` prints as `1/4`. |
| C8 | One aspect may have two rows | Two rows for one lens. |
| C9 | A collation in which NO lens reported is accepted | §6.6 dispatches no collation when zero children succeed, so the document describes a task that cannot exist — a review manufactured out of a fan-out that produced nothing. |
| C10 | `lenses[]` may be empty | The record loses its denominator entirely. |
| C11–C13 | `acceptance`, `verified`, `status` accepted as fields | **D8's line.** §6.8: calling this acceptance "would be claiming an independence it does not possess". `status` additionally: a second claim about one task that nothing reads and that is free to disagree with the first. |
| C38 | `verified` loses its NAMED refusal and falls to `.strict()`'s generic one | The document is still refused and the reason an operator would act on is gone. The whole value of `notHere` over `.strict()` is that the refusal says why. |
| C14 | Unknown keys pass through instead of being refused | An accepted-and-ignored `severity` reads to its author as an honoured one. |
| C15 | A control character in a path is accepted | A CR or an ANSI introducer in a finding's path is a worker writing lines into the report that grades it. |
| C16 | The refusal ECHOES the path it refuses | The same injection, arriving through the refusal instead of the finding. |
| C17 | A fractional line number is accepted | `line: 12.5` is not a line. |
| C18 | `file` becomes optional | A bare prose finding sits in the structural record as though it had been located. |
| C19 | Containment is re-decided here as a string rule | **The layering, asserted rather than described.** Refusing a traversal here looks more careful and discards every other finding in the document, using a weaker test than `findingLocationProblem`'s `relative()` against the real workdir. C15 and C19 are the pair that pins which failures may cost the whole document. |
| C20 | `finding_count` becomes optional | An optional field is one a collator omits on the run where it would have disagreed. |
| C21 | A declared count disagreeing with the list is REFUSED | Deletes the datum the census was built to record: `declared` beside `counted` is how a truncated report says so. |
| C22 | The ceiling trusts `finding_count` instead of counting the list | A collator escapes §6.8's third bullet by arithmetic — "4 findings" over an empty array. |
| C23 | An absent artifact is reported as a refusal | "Nobody wrote one" and "somebody wrote something unreadable" become indistinguishable. |
| C24 | The byte cap is removed | An unbounded worker-authored document buffered into the grader. |
| C25 | The D5 link is not checked | A collation filed against any parent. Under D5 the derived id is the ONLY thing tying the two halves of one review together. |
| C26 | Bad JSON is reported as a schema failure | Two different faults with two different remedies collapse into one. |
| C27 | The ceiling's task-id guard is removed | **Every task in the fleet is missing a collation artifact**, so every `success` in the fleet caps to `partial` — including the fan-out task `T`, whose job is to issue the request and which correctly has no artifact. |
| C28 | The claim is no longer the antecedent | The instrument SUPPLIES a verdict rather than capping one: combined through `adjudicate`, where `unknown` is the identity, it would clamp a task whose worker wrote no envelope. ISC-94. |
| C29 | A missing collation lets a success claim stand | Write no artifact, claim success, get success. |
| C30 | An unreadable collation lets a success claim stand | Write a broken artifact, same result. |
| C31 | Zero findings with success is recorded as success | §6.8's third bullet, deleted. |
| C32 | Coverage's `missing` names workers instead of aspects | The operator is told which container did not answer rather than which LENS is absent. |
| C33 | Coverage's `total` counts only the lenses that reported | `2/3` prints as `2/2`, which is the whole §9 Q6 hazard. |
| C34 | `reportedReviewers` returns every lens | The census's roster gains a reader that never read. |
| C35 | The artifact path drops its spellability guard | A task id becomes a `join` that resolves `..`. |
| C36 | The artifact lands beside the envelope instead of under `files/` | The grader looks where the role file does not write. |
| C37 | The wire tag is not checked by name | `pifleet.result/v1` also carries a `task_id` and an array; a reader could hand one over by mistake. |

### The role document

| # | Mutation | Catches |
|---|---|---|
| R1 | The fan-out documented at `/outbox/fanout.json` | **The defect this change repairs.** A file no poller reads; a console that reviews nothing and looks healthy. |
| R2 | Turn one told to claim `partial` | The lattice combines by `min`, so a `partial` on turn one puts a floor under the whole review that nothing downstream can lift. §6.6 step 1 says `success`. |
| R3 | The worked example shows all three lenses reporting | A collator with only the easy case in front of it omits the `reported: false` row, and the denominator goes with it. |
| R4 | The worked example no longer demonstrates a contradiction | A collator with only agreeing examples records a disagreement as agreement — corroboration where there was dissent. |
| R5 | The example names a reviewer outside the roster | A fan-out the actor refuses whole (D7). |
| R6 | The example's own `finding_count` disagrees with its list | The example is the part a model copies most literally. |
| R7 | The document names a mount the collator does not have | An epoch spent discovering the mount is not there. |
| R8 | The collation example carries the wrong wire tag | Every collation refused. |
| R9 | The derived collation id dropped from the turn-one instruction | D5's whole mitigation: the link between the request a person made and the collation they will read. |
| R10 | The D8 statement is removed from the grading section | The schema still refuses an `acceptance` field, but only after a turn spent writing one — and the collator is left believing its review was accepted. |

## Greens — and which kind of green each one is

Two different things look identical in a battery and must not be conflated.

### Negative controls — must stay green or the battery reddens on everything

| # | Mutation |
|---|---|
| NC1 | Rename the local `reported` set in the cross-field pass (declaration + both `has` arms) |
| NC2 | Rename `firstIssue` to `describeIssue` (declaration + its only call) |

### Semantic no-ops — the mutation genuinely changes nothing

| # | Mutation | Why green is correct |
|---|---|---|
| NO1 | `findings.length < 1` instead of `=== 0` | A non-negative array length makes the two predicates identical. |
| NO2 | The `not_json` refusal's wording changes | The refusal's CODE is the assertion surface and its prose is the explanation — `DispatchRefusal`'s division, taken unchanged. A probe that pinned this sentence would be pinning the part that gets rewritten. Contrast C38, where the prose IS the property. |

### Uncovered regions — the mutation changes behaviour and NOTHING catches it

Declared, not counted. These are real gaps.

| # | Mutation | Why nothing reaches it |
|---|---|---|
| U1 | The lens `note` loses its length bound | No fixture carries an over-long note. The field is free text copied from the collation brief, so the bound is hygiene rather than a property anything depends on. |
| U2 | `findings[]` loses its cap (`MAX_COLLATION_FINDINGS`) | No fixture builds 201 findings. |
| U3 | `lenses[]` loses its cap (`MAX_COLLATION_LENSES`) | Likewise, at 9. |
| U4 | A task id may be 6400 characters | The id tests exercise the GRAMMAR (`SESSION_ID_RE`) and never the length, so `max(64)` is unasserted — and 64 is the number that makes an id a legal path segment. |
| U5 | `statement` loses its length bound | No fixture carries a 4 KiB statement. |
| U6 | A refusal loses the field-path prefix that says WHERE | `readCollation`'s `schema` refusal is asserted for `code` and for a reason longer than ten characters, never for naming the field. |
| U7 | `disputed_by` loses its cap | Same shape as U2/U3. |

**The honest summary.** Every LENGTH and COUNT bound in this contract is
unasserted; every RULE is asserted. That is a coherent gap rather than a random
one — the bounds are byte-budget hygiene taken from
`MAX_DISPATCH_REQUEST_BYTES`' arithmetic, and none of them is load-bearing for a
property §6.8 states. **U4 is the one worth closing**, because 64 is not hygiene:
it is the length at which a task id stops being a legal path segment, and
`replies.ts` and `dispatch-request.ts` each spell the same 64 for the same
reason. Closing it is one fixture with a 65-character id.

The rest close the same way — a fixture at the bound and one past it — and each
costs more than it buys today. `collator-relay.mutations.md` records the same
posture for the ledger append and the production `deliveryPlane`.

## What this battery does not reach at all

**Whether a collation ever gets written.** Every probe here runs against strings
and against a markdown file. Nothing dispatches a collator, nothing renders a
briefing into a container, and no model is called. §10's anti-criterion asks for
exactly that (*"no criterion in this block requires a real terminal, a real
model, or the network"*), so it is a property rather than a gap — but it means
the claim "a collator following this document produces a document this schema
accepts" rests on the two ends agreeing by construction and on
`collator-role.test.ts` parsing the worked examples through the real schemas. It
has never been observed end to end.

**Whether the census and this contract compose.** `harvest/collation-census.ts`
holds a narrower view of the same document and its header names the three fields
it cannot do without. That reconciliation is one import away and is not made
here; until it is, two schemas describe one wire format, which is the condition
both files' headers warn about.
