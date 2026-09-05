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

#### Turn one ENDS — the polling defect, measured on run 5

The collator wrote both files correctly and then spent its **last twelve tool
calls** looking for something to do: `ls /replies`, `find /replies`, `ls /`,
`ls /briefing`, `ls /policy`, and re-reads of its own briefing and its own task.
It settled on its own, so the cost was tokens and a confusing transcript rather
than a wrong review — but the document already said *"You never wait"* and *"there
is no version of this where you sit and poll"*, and it happened anyway.

**Both of those are prohibitions, and prohibitions were not the missing thing.**
What turn one never carried was what DONE looks like, what happens next and who
does it, and why looking is futile rather than merely disallowed. A model that has
just written a file and holds no next instruction will go and look for one; telling
it not to is weaker than telling it there is nothing to find, and weaker again than
telling it what is coming instead. The three rows mutate one of those each, because
a document keeping only one of them is the document that produced the defect.

| # | Mutation | Catches |
|---|---|---|
| R11 | The envelope stops being named as the turn's last tool call | "Done" has no definition, which is the state the measured run was in. |
| R12 | The collator is no longer told turn two arrives as a NEW PROMPT | The positive half. Without it the model has an open question about what became of its request, and checking is the only way it has to answer one. |
| R13 | Polling is forbidden but no longer shown to be pointless | `/replies` is legitimately empty during turn one, so an empty listing confirms nothing either way. A rule with no reason is one a model breaks the moment it feels uncertain. |

#### The language seat's angle is the TARGET's language

`rev-lang-1` ran `roles/review/typescript-language.md` — an angle whose every
example was TypeScript — while this console's integration target, `~/repos/rally-cli`,
is a Python project. The collator had been steering around it inside each brief,
which is a workaround in the one place the console has no leverage: the brief is
written fresh every run by a model, so the correction was re-derived or forgotten
each time. This console reviews whatever repository it is launched from, so a
language fixed in config is wrong for every target but one.

| # | Mutation | Catches |
|---|---|---|
| R14 | The seat pre-commits to a language again (UPPER CASE) | **SURVIVED ITS FIRST RUN.** The probe tested `\bTypeScript\b` case-SENSITIVELY; headings in that file are upper case, so restoring the literal historical heading was invisible to it. The probe was blind to the exact defect it was written for, in the exact form that defect had on disk. |
| R14b | The seat pre-commits in MIXED case | The form the broken probe DID catch, so a regression that only restores case-sensitivity still reddens. |
| R14c | The seat pre-commits to Python | The mistake this seat would make NEXT, once someone assumes the current target is permanent. |
| R15 | The seat is no longer told to settle the language from evidence | "Consider the language" is the old defect wearing a different name. |
| R16 | The seat stops having to say which language it settled on | A determination nobody states is one nobody can find wrong. |
| R17 | The angle collapses with no defect classes | A reviewer told to "consider the language" is worthless next to one told what to look for; the four classes are the floor on specificity. |
| R18 | The config points back at the TypeScript aspect file | The other half. A fix to the document alone leaves the console loading the old angle. |
| R19 | `toolchain: node` returns to the seat | It pins a language-specific image onto the one seat whose job is not to assume the language — and the seat has no `bash`, so it could never invoke a toolchain anyway. **`fleet.yaml` is gitignored, so this is an UNTRACKED target: the anchors guard skips it by design and this battery is the only thing that checks it.** |
| R20 | The sibling aspect files still call seat three a TypeScript seat | Each reviewer reads only its own aspect file, so a stale cross-reference in the other two is invisible to everything else. |

#### `file` is a path, not a sentence

`collation-census.ts` stopped counting a prose `file` as located: a value carrying
whitespace, no directory separator and no extension on its last component is read
as a phrase. It closes a real hole — a relative `file` is JOINED onto the workdir,
so "the error handling could be tightened" resolved inside `/workspace` and counted
as an anchor for a finding that points at nothing. The refusal teaches a collator
this after the turn is spent; the briefing teaches it before.

| # | Mutation | Catches |
|---|---|---|
| R21 | The brief stops saying `file` must be a path | The collator learns the rule from a refusal instead of from its instructions. |
| R22 | The document's uncounted example is one the census actually counts | **The arm that matters.** The probes RUN `findingLocationProblem` over the document's own worked examples, so guidance and grader cannot drift — a document offering an example the census refuses is worse than one that says nothing. |
| R23 | Prose is no longer directed to `statement` | The collator is told what not to put in `file` and not where to put it instead, so it drops the observation rather than relocating it. |

### The reviewer's briefing, and the mitigation that has to hold at both ends

The gap these guard is the one `src/run/collation.ts`'s header spends a section
on: `HarvestedArtifactSchema` is `{path, bytes, sha256}` with **no contents**, and
a reviewer's `/outbox` is worker-scoped, so a review filed at
`/outbox/<task-id>/files/review.md` is a document nothing in this console can
open. **Nothing goes red when that happens.** Two prompts say the same thing —
the reviewer's role and every brief the collator writes — because a guard whose
failure is silent is worth two copies, and a probe that asserted only one would
survive half of it being deleted.

**REWRITTEN 2026-09-05, because the contract changed.** The instruction is no
longer "put the whole review in `notes`". It is a SPLIT: the long review goes to
`/outbox/<task-id>/files/review.md` and is declared in the envelope's `artifacts`
array, and `notes` carries a short summary. Two measured losses forced it, and
both had the review intact with the envelope destroyed around it — a 3906-byte
envelope holding a mis-escaped regex (its `files/review.md` was on disk, 4849
bytes, whole) and a 7099-byte envelope cut short mid-write (no artifact; nothing
survived). RV1–RV4 were re-anchored onto the new instruction rather than repointed
at the old sentence, and RV3's anchor had already rotted to 0x under a partial fix.

**The reason the split works is not the obvious one, and RV4 pins the correction.**
A file does NOT reach the collator past a broken envelope: `relay.ts` sets
`succeeded: harvested.verdict === "success"`, an unparseable envelope settles
`unknown`, and only surviving lenses have a reply published. What the split buys is
that the envelope stops being the fragile part. A reviewer that believed otherwise
would treat the artifact as a safety net and go back to writing long envelopes.

| # | Mutation | Catches |
|---|---|---|
| RV1 | The review's destination is unnamed — "file it wherever suits you" | The reviewer has nothing to write to, and the artifact half of the split evaporates while the summary half still reads as a complete instruction. |
| RV2 | The two caps stop failing differently | `MAX_TEXT` and `MAX_REPLY_ARTIFACT_BYTES` are the SAME 65536, so a document stating both caps and stopping there gives no reason to prefer either channel. The asymmetry — an over-cap artifact truncates and is NAMED, an over-cap `notes` fails the whole envelope — is the entire argument. |
| RV3 | The collator's copy of the split instruction is dropped | The other end of the same guard. The collator repeats this in every brief, so its copy alone can re-create the defect on a fleet whose reviewer role is already fixed. |
| RV4 | The file is promised to rescue a broken envelope | **The plausible lie**, and the one this change nearly shipped. It reads as reassurance, it is false, and believing it puts the long review back in the envelope. |
| RV21 | The envelope may hold the whole review again | The pre-fix contract restored in one clause. |
| RV22 | The review file need not be declared | `reconcile.ts` grades an empty `artifacts` array against the files actually in the outbox, so an undeclared review is a discrepancy on the reviewer's own record. |
| RV23 | The stated per-file cap drifts from `MAX_REPLY_ARTIFACT_BYTES` | **SURVIVED ITS FIRST RUN.** The probe asserted `toContain("64 KiB")` over the whole section, and the section says the number twice — once as the cap, once as "64 KiB of prose is roughly ten thousand words". Mutating the cap left the second occurrence satisfying the match. The number is now pinned inside the clause that states it. |
| RV23b | The stated per-reply cap drifts from `MAX_REPLY_INLINE_BYTES` | The other number, because a fix that reached only one of the two would look identical from here. |
| RV24 | The `notes` ceiling is dropped | Both channels then look unbounded, and the asymmetry has nothing to stand on. |
| RV25 | The collator's brief stops requiring the declaration | RV22's other end. |
| RV26 | The collator's copy promises the file survives a broken envelope | RV4's other end. |
| RV27 | The worked envelope stops claiming the review file | The example is the part of a prompt a model copies most literally; one that writes an artifact and declares nothing teaches exactly the shape `reconcile.ts` flags. |
| RV28 | The worked envelope carries a wire tag the schema refuses | The example is now PARSED against `ResultEnvelopeSchema` rather than eyeballed. |
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
