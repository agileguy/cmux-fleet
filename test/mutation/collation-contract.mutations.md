# Collation contract and the review console's role documents — mutation table

What `test/unit/collation.test.ts`, `test/unit/collator-role.test.ts` and
`test/unit/reviewer-role.test.ts` actually catch in `src/run/collation.ts`,
`roles/collator.md`, `roles/reviewer.md` and `roles/review/cross-file-contracts.md`,
and what they do not. Produced by
`test/mutation/collation-contract.battery.ts`, which must be pointed at a
throwaway `git worktree` — it rewrites source files in place, and a transient
broken state in a live checkout is read by things that spawn containers from the
tree.

```sh
git worktree add /tmp/wt HEAD --detach
ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
cp src/run/collation.ts /tmp/wt/src/run/
cp test/unit/collation.test.ts test/unit/collator-role.test.ts \
   test/unit/reviewer-role.test.ts /tmp/wt/test/unit/
cp roles/collator.md roles/reviewer.md /tmp/wt/roles/
cp roles/review/cross-file-contracts.md /tmp/wt/roles/review/
bun run test/mutation/collation-contract.battery.ts /tmp/wt
```

The battery snapshots the worktree's own files at start-up, restores before and
after every mutation, and verifies the checksum each time. It refuses a path
ending in `/cmux-fleet`. **It measures the unmutated baseline first and refuses
to run if it is not green** — a battery whose suite is already red reports every
mutation as caught, which is the most flattering possible failure.

Run of 2026-09-04: **BASELINE pass, 94 mutations, 0 unexpected, ALL FILES
RESTORED OK.** Restore additionally verified out of band by `shasum -a 256` over
all six mutable files against the live checkout, and by `git diff --stat`.

**Anchor rot is now caught in CI without running this.** `test/unit/mutation-anchors.test.ts`
reads every `find:` anchor in every battery from `HEAD` and asserts each occurs
exactly once in the file it names. The expensive half stays manual; the cheap
half — "is this battery still about the code" — runs on every push. That closes
the standing objection that a battery nobody runs is a table nobody can trust,
and it is what caught eight stale anchors in this file after the role documents
were rewritten under it.

**What each probe checks BY CONSTRUCTION and what it checks by rule**, because a
table that overstates this is the same defect as a document that overstates a
path:

| Property | How it is checked | What it cannot see |
|---|---|---|
| Container paths in role documents | **By construction** — allowlist derived from the builders and constants that produce them (`test/support/role-docs.ts`) | Nothing, for paths. An invented path fails whatever it is called. |
| Shell-only capability claims | **By a sentence-level negation rule** — the word may appear only where the sentence denies having it | A false claim expressed without those words, e.g. asserting a capability by describing its effect |
| The reviewer's tool grant | **By construction**, member by member, against `fleet.example.yaml` | Nothing for the tracked config; the live `fleet.yaml` is a separate gated probe |
| Wire tags and file names | **By construction**, against the schema constants | — |
| Tone, judgement, review advice | **Not checked**, deliberately — see U8/U9 | Everything |

**Both configs are in the mutable set, and which one is which matters.**
`fleet.example.yaml` is TRACKED and is what CI grades against, so the capability
mutations (RV15, RV16) target it; `fleet.yaml` is gitignored, copied into the
worktree, and carries only the divergence probe (RV17). A mutation in the
gitignored file would prove nothing about a clean checkout, which is the same
mistake as reading it in a test.

**The bash refusal and the write grant are pinned independently**, because a probe
that merely noticed "the tools list changed" would be satisfied by either and
RV15 would stop meaning what its name says. RV15 adds `bash`; RV16 removes
`write`; both redden, from different assertions.

## The role documents are source

They are mutated alongside the TypeScript because they are the programs these
workers execute, and both had the same defect in the same shape.

**`roles/collator.md`** told the collator to write its fan-out to
`/outbox/fanout.json` and to read three reports from `/outbox/reports/rev-arch-1.md`
— **neither path has ever existed in this repository.** R1 is that defect,
re-applied.

**`roles/reviewer.md`** opened with *"Review the diff against its stated intent.
The task envelope says what the change was supposed to do."* **Both halves were
false.** The reviewer is `tools: [read, grep, find, ls]` with no bash, so it
cannot run `git diff`, and nothing in `render.ts`, `task-policy.ts` or
`dispatch-policy.ts` delivers one; and `renderPrompt` emits the title, the brief,
the acceptance lines and four identity values — never the envelope. The trap that
made the second claim look survivable is that `/policy/task` IS mounted and IS
named for the task: `writeTaskPolicy(path, task_id, epoch)` writes two fields
into it for the verbgate's provenance line. RV7, RV8, RV10 and RV11 are those
defects and the plausible wrong repair, re-applied.

Both were found by grepping each claim rather than by reading the prose again.

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

### The reviewer's briefing, and the mitigation that has to hold at both ends

The gap these guard is the one `src/run/collation.ts`'s header spends a section
on: `HarvestedArtifactSchema` is `{path, bytes, sha256}` with **no contents**, and
a reviewer's `/outbox` is worker-scoped, so a review filed at
`/outbox/<task-id>/files/review.md` is a document nothing in this console can
open. **Nothing goes red when that happens.** Two prompts say the same thing —
the reviewer's role and every brief the collator writes — because a guard whose
failure is silent is worth two copies, and a probe that asserted only one would
survive half of it being deleted.

| # | Mutation | Catches |
|---|---|---|
| RV1 | The instruction is deleted from `roles/reviewer.md` | Back to one prompt, and the surviving copy looks like a complete guard. |
| RV2 | The WHY is dropped — "not the contents" removed | An instruction with no mechanism behind it is a style preference, and a model under budget pressure drops style preferences first. |
| RV3 | The collator's copy is dropped | The other end of the same guard. |
| RV4 | The mitigation stops being labelled a mitigation | The next person to read the reply plane concludes the gap was closed. The coordinator asked for this specifically and it is asserted rather than trusted. |
| RV5 | The design note stops naming a recommendation | "Here are two options" leaves the decision to whoever is in a hurry. |
| RV6 | The design note drops the recommendation's cost | Fix A is only correct WITH a byte cap; a recommendation with no cost is one nobody can weigh. |
| RV7 | The false diff premise restored in `roles/reviewer.md` | The defect this change repairs. |
| RV8 | The `There is no diff` correction removed | Same, at the other end of the sentence. |
| RV9 | The false diff premise restored in the ASPECT file only | **ASYMMETRIC against RV7/RV8.** `load.ts` concatenates role and worker briefings into ONE prompt, so the correction can stand in `roles/reviewer.md` while the aspect file appended after it still instructs work on a diff — a prompt contradicting itself, which neither file alone can detect. |
| RV10 | The aspect file points at the task envelope again | Same shape, second claim. |
| RV11 | The document points at `/policy/task` for the intent | **The plausible wrong repair.** It is mounted, it is named for the task, and it holds two fields for the verbgate. A correction that lands there reads as more precise than the error it replaces. |
| RV12 | A reviewer is pointed at a sibling's reply | §6.6's concurrency anti-criterion: a reviewer reading another's report before writing its own destroys the consensus arithmetic while looking like a better-informed review. |
| RV13 | The location's spelling guidance is dropped | The collator has to guess at `file` and `line`, and a location it guesses wrong is one the collation drops. |
| RV14 | The collator loses its instruction for a `path:line` it is handed | The other end of RV13: reviewers will still write `src/foo.ts:12`, and the collator has to split it rather than paste it into `file`. |
| RV15 | `bash` is granted to the reviewer in `fleet.yaml` | The capability claim is checked against the GRANT. A role that gains bash makes "there is no diff" false, and the document would say it anyway. |

### The denominator, the binding, and the survivors a review found

Added after a grading-honesty review and a test-integrity review. Each row is a
hole that was open at the previous run of this table, so the "0 unexpected" above
was true and incomplete — a battery measures what someone thought to mutate.

| # | Mutation | Catches |
|---|---|---|
| G1 | A lens row may be OMITTED | **The fabrication the previous rules missed.** Crediting a lens marked `reported: false` was refused; DELETING its row achieved the identical reading and was legal. Two reporting rows over a three-lens console ship `{total: 2, reported: 2, missing: []}` — a clean 2/2 — and one row was legal, so 1/1 was reachable. |
| G2 | An extra row may pad the table | The other direction: a reader that does not exist, turning a 1/3 into a 1/4 that reads as diligence. |
| G3 | A row may carry another lens's aspect | The aspect is the word the record uses to name a missing lens, so a renamed row reports the wrong lens absent. |
| G4 | The table is checked as a SUBSET rather than a set equality | The extra-row arm removed wholesale. |
| G5 | The document is trusted about which task it belongs to | **A document cannot be its own witness.** A collation declaring `T-9-collate`/`T-9` while sitting in `T-1-collate`'s outbox is internally consistent, parses, and was published as T-1's record — the exact misfiling that breaks the only link D5 leaves. |
| G6 | The seats come from the DOCUMENT rather than from config | D11 inverted: the collator defines the console it is graded against. |
| G7 | The derivation check is put where the structural one belongs | The documented ordering, which was unasserted until a fixture failing BOTH checks existed. The battery proved it by reordering and staying green. |
| P2 | The byte cap counts UTF-16 units | Admits up to 2× `MAX_COLLATION_BYTES` of astral text into the host process that grades it. The module's docblock stated the property and the only fixture was ASCII, where the two measures agree. |
| P3 | `disputed_by`'s not-a-lens arm is removed | The document is still refused — by the wrong arm, with the wrong reason. Its `raised_by` twin was already message-pinned; this is C38's standard applied to the twin that lacked it. |
| P4 | A task id may be 6400 characters at the schema | 64 is the length at which an id stops being a legal path segment. **The second site is gone rather than tested twice**: `spellable` and `MAX_RELAY_TASK_ID_CHARS` are now imported from `task-ids.ts`, so there is one bound to mutate. |
| H5 | The rank comparison is dropped from `capCollationVerdict` | **A failed review rescues itself.** A task clamped to `failed` by a malformed `ticket-ops.json` is lifted to `partial` by its own zero-finding collation. This is the "may only ever lower" property that the whole instrument rests on, and it was proved by argument until this row existed. |
| H7 | The cap ignores the ceiling's no-op arm | When §6.8's rule is silent the ceiling returns the CLAIM, which would then be applied as a cap — the function doing `adjudicate`'s job a second time. Found by the battery; the fixture did not exist. |
| H8 | A relative path is reported as the arm that can fail | `findingLocationArm` is the predicate the census needs to publish `located` split by arm; inverting it makes every location look checked. |
| RV15 | `bash` granted in the TRACKED config | The capability claim, checked against the grant. |
| RV16 | `write` removed from the TRACKED config | **The defect the owner's decision repaired.** Without it the reviewer cannot write `result.json`, every lens reports nothing, no collation is dispatched, and the fan-out task settles `success` with the review showing green. |
| RV17 | The live config diverges from the tracked one | The console runs from `fleet.yaml`; CI grades `fleet.example.yaml`. A silent divergence is a console that behaves unlike the thing under test. |
| RV18 | A fresh invented path under a real mount, in the reviewer document | **The first-segment hole.** `/policy/envelope.json` passed the old guard because `/policy` is a mount. |
| RV19 | A fresh false capability claim in unseen wording | *"Start from the diff and work outwards."* The denylist it replaces held RV7's and RV9's own replacement strings — the probe and the mutation had been written to each other. |
| RV20 | The same invented-path attack against the collator document | `/outbox/reports-v2/...`, which `/outbox` being a mount used to admit. |

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
| H6 | `capCollationVerdict`'s explicit out-of-lattice guard removed | **Filed as a red and measured as a no-op, which is the useful outcome.** `rank` returns `-1` for `unknown`, `aborted` and `timed_out`, so the `b >= a` comparison already returns the current verdict for all three — the explicit `a < 0` test can never be the thing that saves them. The guard is KEPT anyway: without it the code's correctness depends on a `-1` coincidence rather than on the three verdict classes the docblock names, and a reader who thought that line was only about `unknown` would special-case it and clamp a killed task. |

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
| U10 | The historical "why both" paragraph in `roles/reviewer.md` | Deliberately unpinned. It explains a defect that is now FIXED, and a probe demanding it would freeze the document's account of its own past — the failure `371dc08` corrected when it deleted probes requiring the docs to say the contents "do not cross". What IS pinned is the current justification (RV4) and the current reason to prefer `notes` (RV2). |
| U8 | The whole `Give the failing case` instruction is deleted | **The reviewer role's JUDGEMENT content, and this is a boundary rather than an oversight.** These probes hold a document's CLAIMS ABOUT THE SYSTEM — its paths, its capabilities, its wire tags — because those are decidable against code. Whether "give the failing case" is good reviewing advice is not, and a probe pinning that sentence would be pinning a preference. |
| U9 | The ranking instruction is inverted (a naming preference outranks a correctness bug) | Same boundary, and the sharper illustration: this is unambiguously WORSE advice and nothing catches it, because nothing can. It is here so the line is measured rather than described. |

**The honest summary, corrected.** The previous run of this table said "every
LENGTH and COUNT bound is unasserted; every RULE is asserted", and a review showed
the second half was false in three places — the byte cap's UNITS (P2), the
`disputed_by` arm's REASON (P3), and the id bound's second site (P4), which U4
declared at one site while prescribing a fixture that would have left the other
open. All three now redden, and the id bound has one site rather than two. What
remains true is the shape of the gap: the surviving unasserted items are LENGTH
bounds only. That is a coherent gap rather than a random
one — the bounds are byte-budget hygiene taken from
`MAX_DISPATCH_REQUEST_BYTES`' arithmetic, and none of them is load-bearing for a
property §6.8 states. **U4 is closed and is now P4.** 64 is not hygiene — it is
the length at which a task id stops being a legal path segment — and the fix was
not the fixture U4 prescribed. A 65-character fixture through the schema would
have left `spellable`'s own `<= 64` untouched, which a review found as a second
undeclared survivor. `spellable` and `MAX_RELAY_TASK_ID_CHARS` are now imported
from `task-ids.ts`, so the duplicate is gone rather than tested twice.

U8 and U9 are a different kind of gap and should NOT be closed. They mark where
a document stops making checkable claims and starts giving advice, and a suite
that crept past that line would be pinning one author's taste in review prose —
green until someone improves the wording.

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

**Whether a review ever reaches the collator.** This was the console's largest
unmeasured risk at the previous run and **it is now closed in code**: `371dc08`
inlines each artifact's contents into the reply under 64 KiB / 256 KiB caps, with
contention resolved by max-min fair allocation so that which half of a review
survives is not a property of `readdir` order, and with `TRUNCATED` and
`UNREADABLE` named separately in the brief because "arrived short" and "did not
arrive" are different facts. RV1–RV4 now assert the surviving PROMPT-level
belt-and-braces and its justification — `notes` remains the only uncapped channel
— rather than a mitigation holding the feature up on its own.

**Whether a model FOLLOWS any instruction in either document.** Unchanged and
unclosable here. Every probe in this table reads text; none dispatches a worker.

**Whether the reviewer can act on the write it was just granted.** The grant is
asserted in config and the document is asserted against the grant, and no probe
runs a container. `config validate` accepts it and the console has never been
started with it.
