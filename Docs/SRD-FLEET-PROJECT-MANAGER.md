# System Requirements Document — the fleet as the engineers, testers and reviewers of a `/ProjectManager` run

**SRD-FLEET-PM-001 v0.2 — DRAFT FOR OWNER REVIEW**
*v0.2 revises v0.1 after a review round that could not read the document (§0.8). Every incorporated
finding was re-verified against the repository before acceptance; §0.9 lists what was accepted, what
was rejected, and two errata in this document's own drafting. The most consequential change is §7.5:
v0.1's coverage gate read a worker-authored number and said it was the host's.*
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001) and `Docs/SRD-REVIEW-CONSOLE.md`
(SRD-REVIEW-CONSOLE-001). It **consumes** the review console's collator dispatch rather than
re-specifying it: §6.5 and §7.4 are readings of machinery that shipped in `2ccf851`, not
proposals. It **proposes amendments** to `Docs/SRD.md` §9.1 (what per-worker isolation means
when several workers are meant to produce one change) and to the `development` console's seat
roster as recorded in `fleet.yaml:712-727`. Where this document and `Docs/SRD.md` disagree
today, that disagreement is the subject of §4 rather than an oversight.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operator wants `/ProjectManager` — the skill that walks an SRD phase by phase, running
parallel engineers, a review round, a CI wait and a merge — to be played by the fleet instead
of by in-process subagents. Most of it is free: the `development` console already has two
engineers and a tester, the `review` console already turns one request into three independent
lens reviews and a collation, and a host-side actor already exists to drive the second.
**Everything hard is in one sentence: the current skill tells two engineers to commit to the
same branch, and in this fleet there is no same branch.** Each worker's `/workspace` is a
`git clone --no-hardlinks` (`src/run/worktree.ts:1-3`) on its own branch
`fleet/<run-id>/<worker-id>`, in its own container, with its own `.git`. Two engineers handed
one branch name produce two branches with that name in two repositories that have never heard
of each other. So the integration step is not a detail the skill can keep hand-waving; it is
the load-bearing part, and this document's central claim is that **it already has a mechanism
and the mechanism is on the host**: `up` registers each worker's clone as a remote
`worker-<id>` on the operator's own repository (`worktree.ts:435`, `:465-470`), so
`git fetch worker-eng-1 fleet/<run>/eng-1` reads an engineer's commits from the operator's
terminal with the parent's own branch untouched — *"verified end to end"*, in the module's own
words. §6.2 makes the calling session the integrator on that mechanism, and §4.1 is the
argument that this does not violate the `/fleet` skill's cardinal rule.

### 0.2 The decision that matters — the orchestrator does not move into the fleet

`/ProjectManager` today is an orchestrator that also does the work, because the Task tool
gives it subagents that share its checkout. Porting it to the fleet splits those two things,
and there are exactly two places the orchestrator can end up.

1. **Inside the fleet.** A new `pm` role, a fifth console, a worker that decomposes phases and
   dispatches engineers. §4.2 is why not, and it is the review console's §0.2 argument
   unchanged: a worker that causes other workers to run has an effect that leaves its own
   container by design, and `Docs/SRD.md` §12.1's sentence — *"Tool scope is not a boundary —
   the container is"* — does not cover it. The review console answered this by refusing the
   collator a control channel and routing its intent through a host-side actor. A ProjectManager
   worker would need strictly more: `gh pr create`, `gh pr merge`, GitHub credentials, and write
   access to the operator's own branch.
2. **In the calling Claude Code session, which already has every capability by construction.**
   It has the repo checked out, it has `gh`, it has the operator's git identity, and it is
   already the thing that reads the SRD.

**This document takes (2), and it is not a close call.** The interesting consequence is what
falls out of it: the fleet gains **no new role and no new console** for this feature. What it
gains is a `development` console whose seats match the work (§6.1), a documented integration
path (§6.2), and a `/fleet` workflow that drives both consoles from one repository argument
(§8). Everything else is the existing dispatch, harvest and relay machinery used in an order
nobody has written down.

**The cost of (2), stated rather than discovered.** The orchestrator is a Claude Code session,
which means it is not restartable the way `pifleet relay` is, its state is a JSON file it
writes itself, and a `/compact` between phases is a real interruption. §6.6 makes the run tree
authoritative and the state file a cursor, so a resumed run re-derives rather than remembers;
§11 Q3 holds the part that cannot be closed by design.

### 0.3 The disclosure boundary

This document names two things it cannot avoid and that are already in the tree: the hosted
provider `ollama-cloud` and the three models the review console runs on, because
`fleet.yaml:248-251` already publishes them; and the fact that a repository's remote decides
whether the fleet will review it at all, because `run.hosted_repo_consent`
(`fleet.yaml:76`) turns on it. No employer, ticket system, cloud project or credential value is
named. This follows §0.3 of `Docs/SRD-REVIEW-CONSOLE.md`.

**One consequence belongs here rather than in §4, because it constrains the feature's
audience.** A `/ProjectManager` run puts the target repository's code in front of four hosted
`development` seats and four hosted `review` seats. For a repository whose remote matches the
patterns `sensitive-repo.ts` refuses, this feature **does not run** unless the owner has written
that remote into `run.hosted_repo_consent`, one URL at a time. That is a property of the fleet
and not something this document may relax.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Read** | code in this repository, opened on 2026-09-05, file and line cited at every claim | §2 in its entirety, §3.1-§3.2, §4 |
| **Observed** | `.claude/project-manager-state.json` as it exists on `feature/harvest-recovery`, and `git log`/`gh pr view 147` on 2026-09-05 | §0.7, §2.7, §3.3 |
| **Recorded** | `Docs/SRD.md` §5.9/§9.1/§12.1, `Docs/SRD-REVIEW-CONSOLE.md` §0.2/§6.4/§6.5, `ISA.md`, `~/.claude/skills/ProjectManager/SKILL.md`, `~/.claude/skills/fleet/` | §1, §4, §8 |
| **Inferred** | reasoning from the above | §5-§10, §13.  **These are proposals, not observations, and they are where the owner's review is most valuable.** |

**Nothing was executed against a live fleet.** No console was opened, no worker recreated, no
dispatch issued, no model called. Every §2 claim is a claim about **what the code says it
does**. Where a claim would need a running system to settle, §11 holds it as an open question
rather than asserting it — and §11's two BLOCKING entries are both of that kind.

### 0.5 Four corrections to the premises this document was commissioned against

**1. The `reviewer` role does not go away when `rev-1` does.** The commission asks whether
`reviewer` "survives as a role at all", on the premise that the review console's lens workers
have their own roles. They do not. `fleet.yaml:759-807` shows all three lenses as
`role: reviewer` with per-worker `model:` and `append_system_prompt_file:` overrides, and the
config's own comment (`:736-743`) argues the point at length: *"ONE `reviewer` ROLE, three
workers — not three roles. The shared review discipline … lives once in `roles/reviewer.md`,
and each worker adds only its ANGLE … Three roles would be three copies of the discipline, and
three copies is where the drift starts."* **So `roles/reviewer.md` is load-bearing for the
review console and must not be retired.** What retiring `rev-1` actually does is smaller and
sharper, and §6.1 states it: the `reviewer` role's `model:` and `thinking:` defaults stop
reaching any worker, because all three lenses override `model:`. The default becomes dead
config, and `fleet.yaml:551-554`'s comment — *"THIS DEFAULT NOW REACHES ONE WORKER — `rev-1`,
the development console's review seat"* — becomes false the moment the seat is renamed.

**2. `--restart` cannot repoint a console at a different repository, and this is the feature's
sharpest operational constraint.** The commission's framing has the repo argument driving both
console launches, which is right, and understates what that costs on a console that is already
open. `.claude/project-manager-state.json` on `feature/harvest-recovery` records the
measurement in the operator's own words: *"each pane's launch argv hardcodes
`-v /Users/de895996/repos/rally-cli:/workspace:ro`, so `--restart` cannot repoint it."*
`Workflows/Consoles.md:45-47` says the same thing from the other side — *"The pane keeps its
working directory, so the worker returns with the same mounts — same repository, same image."*
**A console standing on the wrong repository is therefore a `--recreate`, which is the
destructive verb**, and §8.2 makes checking it a precondition rather than a gotcha.

**3. `tester` has no `write` tool and does not need one.** `fleet.yaml:659` gives the role
`tools: [read, bash, grep, find, ls]`. A reader comparing it against `reviewer`'s
`[read, write, grep, find, ls]` (`:588`) may conclude a second tester cannot write its result
envelope. It can: `config/schema.ts` counts `{write, edit, bash}` as the writer set —
`fleet.yaml:565-567` says so while explaining why `reviewer` needed `write` — and `bash` is how
`tester` writes. This is recorded because getting it wrong would add a tool grant for no
capability.

**5. A `python` toolchain does not cost a worker `bun` — it is a strict superset of `node`.**
`docker/Dockerfile:145` is `FROM toolchain-node AS toolchain-python` and `:118-119` installs bun in
the node stage — with an explicit postinstall, without which bun is on `PATH` and non-functional — so
every language toolchain contains node's. **Python was previously built `FROM base` and genuinely had
no bun; the re-layer is commit `2ccf851`, which is this branch's own base.** The date is worth one
line because two sources disagree: `docker/Dockerfile:132`'s comment says `2026-09-04`, the commit's
author date is 2026-09-05. **`fleet.yaml:656-658` still carries the
pre-fix comment** — *"SWITCHED 2026-09-04: rally-cli is a pytest project. Costs this role `bun`, so
tst-1 can no longer run cmux-fleet's own suite"* — and it is stale. **v0.1 repeated it as fact in
§6.8 and that was an error**; the corrected text is there. Two qualifications a reader must carry:
this is a statement about the **Dockerfile**, and an *image* built before `2ccf851` genuinely lacks
bun until it is rebuilt — which is what makes §13's `image build` task load-bearing rather than
hygienic.

**4. `run.max_concurrent: 1` does not serialise the console.** It bounds each **run**, and every
attended pane is its own run (`operations-plan.ts:246-253`: *"N attended panes are therefore N
runs"*). Four `development` seats are four runs of one worker each, so four seats generate
concurrently. What actually bounds them is the vendor's rate limit and the operator's bill —
`fleet.yaml:746-750` states it, and §5.3 keeps it out of scope.

### 0.6 What reading the code found

Five findings, all reachable today, four of which need none of this feature to exist in order
to matter. They are stated up front because each changes what a section downstream may assume.

| # | Finding | Reachable today? | § |
|---|---|---|---|
| **A** | **The integration mechanism already exists and is undocumented at the workflow level.** `up` registers `worker-<id>` as a git remote on the operator's own repository, pointing at that worker's clone (`worktree.ts:435`, `registerWorkerRemote` at `:465-470`), and `pifleet worktrees --json` reports each worker's branch, path, dirt and `commitsAhead` from the recorded `WorkerWorktree` (`cli/commands/worktrees.ts:33-45`). **Nothing in `~/.claude/skills/fleet/` mentions either.** The one line `Workflows/Observe.md:51-52` gives it — *"`worktrees` lists each worker's own git checkout"* — does not say the commits are fetchable. | Yes | §2.1, §6.2 |
| **B** | **`/ProjectManager`'s "two engineers, one branch" is incoherent against `isolation: worktree` and would fail silently.** Each engineer writes `branch: "fleet/<run-id>/<worker-id>"` into its own envelope (`skills/pifleet-worker/SKILL.md:172`) regardless of what the brief said. A brief naming `phase-3-relay-actor` produces two workers that either ignore it or create that branch inside their own clone, where it is invisible to the other. Nothing goes red. | Yes | §1.2, §6.2 |
| **C** | **A collated review is journalled, so a lens lost to a failed harvest never re-enters that collation.** This is ISC-517's hazard and it is the one a ProjectManager loop is most likely to mis-read, because a 2-of-3 collation is a valid `pifleet.collation/v1` document with a `reported: false` row in it and a `success` verdict on the collator's own task. `roles/collator.md:228-235` is explicit that the collator's status is *"about YOUR collation, never about how many lenses reported"*. **A loop that branches on the collator's verdict is therefore branching on the wrong number.** §7.5 makes coverage a separate gate. | Yes | §7.5, §9.4 |
| **D** | **Renaming `rev-1` touches ten functional locations, not two — and the config that matters most is not committable.** *(v0.1 said "two real pins"; that was measured with a gitignore-aware `grep` and was wrong.)* Two config files, one plan constant, one script and five test files, including `test/unit/config.test.ts:119`, `test/integration/cli-exit-codes.test.ts:238` and `test/integration/operations-console.test.ts:112`/`:206`. **`fleet.yaml` is gitignored (`.gitignore:9`)**, so the live seat change produces no diff and cannot be dispatched to a worker without tripping ISC-93. §13 Phase 1 splits on that line. Roughly sixty further `rev-1` strings are arbitrary fixture ids and must NOT be renamed. | Yes, on the first `bun test` after the rename | §6.1, §13 Phase 1 |
| **E** | **There is already a `/ProjectManager` state file in this repository, and its shape has outgrown the skill that writes it.** `.claude/project-manager-state.json` on `feature/harvest-recovery` carries `branch_model: "long-lived"`, an `integration` block naming a console and a workspace id, an `answered_questions` map, per-phase commit lists, `out_of_band_commits`, and `pr_policy: "Do NOT open a PR"`. The skill's documented schema (`SKILL.md:240-252`) has none of those. **The skill is behind its own practice**, and §7.6 specifies the shape that practice already reached rather than the one the skill documents. | Observed | §2.7, §7.6 |

### 0.7 The dependency on PR #147 is satisfied — it merged as `d70acf4`

**v0.1 held this open as its schedule-blocking question.** `origin/main` was `2ccf851` and PR #147
(`feature/harvest-recovery`) was open, carrying three behaviours this design reads as present. **It
merged as `d70acf4` and is on `origin/main` as of 2026-09-05.** The record is kept rather than
deleted, because two of the three are still the reason a section is written the way it is:

| Landed in #147 | What still depends on it |
|---|---|
| `fb38fc8` — *"A dispatch that did not land is no longer reported as one"* (`fresh-dispatch.ts`) | §6.4's lifecycle dispatches through `--restart … --task`. Without it a refused envelope prints *"recreated and dispatched"* and exits 0. §9.2's first row and §12's re-assertion of the property exist because this was once absent |
| ISC-522 — a failed harvest names the review it could not read | §9.4 reads that naming to tell the two kinds of missing lens apart |
| ISC-523 — the inlining had never carried a byte | §7.4 reads the review out of `inlined_artifacts` |

**What this changes downstream: §13 Phase 0 loses its merge task, Q1 is withdrawn, and nothing else
moves.** The design was written to be correct once these landed and they have.

**One consequence of the branch this document sits on.** `docs/srd-fleet-project-manager` is based on
`2ccf851`, before the merge, and is deliberately not rebased — the commit history of a specification
should not silently acquire code it was not written against. **Line citations to `fresh-dispatch.ts`
and `relay.ts` in this document were re-taken against merged `main` on 2026-09-05**, so they are
correct for the tree a reader will check out and may be off by a few lines against this branch's own
parent.

### 0.8 The review round that produced v0.2 did not read this document

**Recorded here because a reader is entitled to know the coverage of the review that shaped a
revision, and because this round is a worked example of the defect it found.**

The `review` console was pointed at v0.1 and returned a collation recording **1 of 3 lenses
reported**. The true coverage was **0 of 3**:

- The document existed only on a branch whose sole worktree was host-side, and reviewer seats are
  `isolation: shared-ro` — `/workspace` is the operator's checkout at whatever ref it stands on.
- The seats hold `tools: [read, write, grep, find, ls]` and **no `bash`** (`fleet.yaml:588`), so the
  brief's instruction to run `git show` was not something they could execute.
- `rev-ctx-1` and `rev-lang-1` filed `blocked`. `rev-arch-1` reviewed from the commit message and
  the brief, and was recorded `reported: true`.

**So §§0.5, 0.7, 4.1, 7.5, 7.6, 9.7 and 13 have never been read by a reviewer.** Every finding
incorporated into v0.2 was verified against the repository by this author before being accepted —
§0.9 lists which were confirmed, which were rejected, and why — but none should be read as *"a
reviewer read this section and disagreed."*

**Three things follow, and each lands somewhere.** The failure is a missing precondition, so §8.2
gains one and a gotcha: **a review target must be readable from `/workspace`**, and the remedies are
to check the branch out in the operator's own checkout or to inline the text into the brief. The
`reported: true` on a lens that read no source is §7.5's finding stated as an incident — the
collation's coverage is the collator's account, not the host's. And the round is the reason §12
proposes a criterion that a review's target is reachable before the fan-out is issued.

### 0.9 What v0.2 accepted from that review, and what it rejected

**Accepted, all verified against the repository before incorporation:** the coverage gate reads a
worker-authored number (§7.5, the most consequential correction in this revision); the seat change is
a privilege widening (§6.1, §4.3); removing `rev-1` leaves an in-loop review gap (§6.1); the
development seats are `tui` and the loop must be written against staging (§6.10); nothing bounds the
loop's concurrency across runs (§6.11); Q10 is answerable and is now D13 (§6.8); the seat rename is a
five-surface edit (§13); the review round's trigger was under-specified (§6.5).

**Rejected, with reasons.**

| Rejected | Why |
|---|---|
| *"Testers cannot run this repository's `bun` suite."* | **False, and v0.1 repeated the same error from a stale config comment.** `docker/Dockerfile:145` is `FROM toolchain-node AS toolchain-python` and `:118` installs bun in the node stage, so `python` is a strict superset of `node`. Changed by `2ccf851`, *"Every toolchain includes node (ISC-405)"*, on 2026-09-04. §0.5 correction 5 states it and §6.8 is corrected |
**One finding this author initially rejected and then confirmed, recorded because the mistake is
instructive.** The claim that the tracked `fleet.example.yaml` has `tester` at `node` while the
gitignored `fleet.yaml` says `python` is **TRUE** — `fleet.example.yaml:489` is `toolchain: node`,
`fleet.yaml:656` is `toolchain: python`, and the tracked surface never received the switch. A draft
of this section rejected it as false **before the verification it claimed had returned**. That is the
same defect as §7.5's: asserting a check rather than performing one. It is left in the record rather
than quietly corrected, and §13 Phase 1 gains a task because of it.

**One erratum in v0.2's own drafting.** An earlier draft of §0.5 and §6.8 cited the toolchain
re-layer as commit `2b96f8f`. **No such object exists in this repository.** The commit is `2ccf851`,
*"Collator dispatch for the review console (ISC-431..ISC-521)"* — which is also this branch's base,
so the re-layer is present in the tree this document sits on. A fabricated hash in a specification is
worse than a missing one, and it is recorded here rather than silently replaced.

---

## 1. Problem statement

### 1.1 What was asked for, and what of it is free

| Asked for | Status |
|---|---|
| Parallel engineers implementing a phase | **Nearly free.** `eng-1`/`eng-2` exist, `role: engineer`, `toolchain: node`, `isolation: worktree`. What is missing is not the workers, it is what happens to their two branches — §6.2 |
| A tester seat | **Free**, and about to be two — §6.1 |
| A reviewer seat | **Free and in the wrong console.** The `review` console is the review stage; `rev-1` becomes `tst-2` — §6.1 |
| End-of-phase / PR code review by the review console | **Free at the mechanism level.** One collator request becomes three lens reviews and a collation, and `pifleet relay` already drives it. What is missing is the mapping from a collation to a loop verdict — §7.5 |
| A `/fleet` workflow taking a repo and an SRD path | **Does not exist**, and is §8 |
| An integration step that turns N engineer branches into one | **Does not exist as a workflow**, and its mechanism does — Finding A, §6.2 |
| Branch creation, PR, CI wait, merge, version bump | **Free and stays on the host** — §6.7 |

### 1.2 The skill as it stands, and the one sentence that does not survive contact

`~/.claude/skills/ProjectManager/SKILL.md:49-87` launches two engineers with the Task tool and
gives both the same instruction:

> ```
> Repository: {repo_path}
> Branch: phase-{N}-{slug}
> ```
> `5. Do NOT create PR or push yet`

For in-process subagents this is coherent: they share one checkout, `git checkout -b` runs once,
and "commit to this branch" means what it says. **For the fleet every clause of it is wrong in a
different way.** `{repo_path}` is a host path a container cannot open — the worker sees
`/workspace`. `Branch: phase-{N}-{slug}` names a branch the worker will not be on and cannot
usefully create, because `up` has already put it on `fleet/<run-id>/<worker-id>` and
`skills/pifleet-worker/SKILL.md:172` has it report that branch in its envelope. And *"do not
push"* is vacuous: an engineer worker has no egress to GitHub at all (§6.7).

**The failure mode is silence, which is what makes it worth a finding.** Two engineers given
that brief both report `success`, both have real commits, the harvest grades both against their
own clone's diff and both come back green — and there is no branch anywhere holding both halves.
The operator learns this at `gh pr create`.

`roles/engineer.md:18-26` is the one thing standing between this and a worse outcome: it tells a
worker whose brief names something not in `/workspace` to report `blocked` rather than invent it,
on a measured precedent (*"the one that reported `blocked` was right, and the one that reported
`success` had written a 43-line file and tested it"*). That discipline catches a bad path. It
does not catch a bad branch name, because a branch name is not a thing you can fail to find.

### 1.3 Two consoles, two jobs, and the handoff between them is the design

The `development` console (`fleet.yaml:692-727`) and the `review` console (`:728-807`) are
already separate workspaces with separate scripts, separate rosters and separate runs. A
ProjectManager phase spans both:

```
  development console                     review console
  ┌─────────────┬─────────────┐           ┌─────────────┬─────────────┐
  │    eng-1    │    eng-2    │           │    col-1    │  rev-arch-1 │
  ├─────────────┼─────────────┤    ──▶    ├─────────────┼─────────────┤
  │    tst-1    │    tst-2    │           │  rev-ctx-1  │  rev-lang-1 │
  └─────────────┴─────────────┘           └─────────────┴─────────────┘
   implement, then test                    review the integrated branch
```

The arrow is the whole design problem. It is not a dispatch — the two consoles share no run, no
inbox and no reply plane. **It is a host-side integration step** (§6.2) that produces the one
artifact the review console can be pointed at: a branch on the operator's own repository holding
every engineer's and tester's work. §6.4 sequences it and §11 Q7 asks whether both consoles stay
up for the whole run or the review console is brought up per phase.

### 1.4 The cost of not having it, stated honestly

There is no measured incident here and this document will not manufacture one. What there is,
is §0.6 Finding E: a `/ProjectManager` run has already been driven against this repository by
hand, through three phases, and the state file it left behind records the workarounds — a
`long-lived` branch instead of a branch per phase, a `pr_policy` of *"Do NOT open a PR"*, a
one-time console recreate authorised in prose because `--restart` could not repoint the mounts,
and an `out_of_band_commits` map for *"defect found during integration, not in the SRD"*.
**Each of those is a place the documented workflow did not fit and a person made a decision.**
The cost of not having this document is that those decisions are not repeatable and not
reviewable; the value of having it is that §7.6 makes them fields and §10 makes them decisions.

### 1.5 Success in one sentence

An operator says *"run ProjectManager on `~/repos/foo` against `Docs/SRD-BAR.md`"*; the
`development` console comes up on `~/repos/foo` with two engineers and two testers, each phase's
work is fetched from the workers' own clones onto one integration branch on the operator's
repository, the `review` console reviews that branch through three independent lenses and returns
a collation the loop can branch on — and at no point does a 2-of-3 review get treated as a
3-of-3, or a dispatch that did not land get reported as one.

---

## 2. The current state, read from the code

> Every claim below carries a file and a line. **Read on 2026-09-05, not executed.** §0.4 states
> what that is worth.

### 2.1 A worker's workspace is a clone, and the parent repository has a remote pointing at it

`src/run/worktree.ts:1-3`: per-worker isolation is *"implemented as a CLONE, not a linked
worktree. The module keeps the name `worktree` because `isolation: worktree` is the vocabulary an
operator writes in `fleet.yaml`."* The rejected alternative is not taste — `worktree.ts:12-25`
records that `git worktree add` with the parent gitdir mounted was *"a confirmed
container-to-host remote code execution"*.

Three facts follow, and together they are §6.2's whole mechanism.

**The branch is derived, not chosen.** `workerBranch(prefix, runId, workerId)` builds
`<branch_prefix>/<run-id>/<worker-id>` — `fleet/2026-…-1a2b/eng-1` with this file's
`branch_prefix: fleet` (`fleet.yaml:62`) — and it is validated against `git check-ref-format
--branch` for every wanted worker *before any clone is attempted* (`worktree.ts:488-530`).
Nothing in the task envelope can change it.

**The parent repository gets a remote per worker.** `workerRemoteName(workerId)` is
`worker-<id>` (`worktree.ts:435`), and `registerWorkerRemote` adds it to the operator's own
repository pointing at that worker's clone path, with a bounded retry around `.git/config`'s
lockfile (`:452-470` — *"twelve concurrent `git remote add` calls … produced five failures"*).
The module's own header states the capability in one line: **`git … worker-<id>/<branch>` reads
the worker's commits from the operator's own terminal; verified end to end, with the parent's
own branch untouched.**

**The record is queryable.** `WorkerWorktree` (`worktree.ts:94-134`) carries `workerId`, `path`,
`branch`, `baseSha`, `remoteName`, `baselineStatus` and `baselineTree`, and
`pifleet worktrees --json` reports it plus liveness, dirt and `commitsAhead`
(`cli/commands/worktrees.ts:36-55`). It reads the recorded state rather than re-deriving from
git, deliberately: *"a second way to compute a fact that already has one owner is how the two
drift."*

**`baseSha` is the floor.** It is *"the value `harvest` would grade a diff from"*
(`worktree.ts:89-91`), which makes it the right base for an integration merge as well.

**This is the one claim in the document that has been independently confirmed against a live tree,
and it is worth recording as such.** The review round checked it three ways: the mechanism in code
(`worktree.ts:435-437`, `:443-501`); the operator's own `.git/config`, which **already carries
`worker-eng-1`, `worker-eng-2` and `worker-tst-1` remotes** left by runs on 2026-09-04; and
`config/load.ts:770`, which confirms that a role declaring no `isolation` inherits `run.isolation` —
so `engineer`, `tester` and a future `tst-2` all get clones and all get remotes. **§6.2's integration
model therefore rests on a mechanism that is not merely documented but observably in use.**

### 2.2 The development console is four attended panes, four runs, and one hardcoded mount each

`DEFAULT_DEVELOPMENT_WORKERS` is `["eng-1", "eng-2", "tst-1", "rev-1"]`
(`operations-plan.ts:632`), `DEVELOPMENT_WORKSPACE` is `"development"` (`:602`), and
`developmentPanes` delegates to the shared `agentSquarePanes` (`:685`). All four workers are
`pane_mode: tui` (`fleet.yaml:712-727`), so each pane runs its own `up --attach-here` and the
console is **four runs**, not one (`operations-plan.ts:246-253`). `status --all` reports them
together; `--recreate` tears them all down; `--restart <id>` respawns exactly one
(`scripts/development`, `restartConsolePane`).

`scripts/development --restart <id> --task <file>` is recreate-then-dispatch, via
`recreateThenDispatch` (`fresh-dispatch.ts:184-284`). Its guarantees are worth quoting because
§6.4 depends on all three: it **waits** for the worker to hold nothing — no `task_id`, no
`staged_task_id`, `phase: idle` (`settledEnough`, `:117-121`) — it **refuses having stopped
nothing** on timeout (`:199-206`), and on `feature/harvest-recovery` it **checks that the
dispatch landed** (`:268-276`, `dispatchProblem` at `:299-318`).

### 2.3 The review console is four seats plus a fifth process

`DEFAULT_REVIEW_WORKERS` (`operations-plan.ts:867`) and `REVIEW_CONSOLE_ROSTER`
(`dispatch-request.ts:298-301`) name `col-1` as the sole collator and
`rev-arch-1`/`rev-ctx-1`/`rev-lang-1` as the reviewers. `scripts/review` starts a host-side
actor unless `--no-relay` is given, and `src/run/console-relay.ts:1-61` is the supervision story:
the record at `~/.pifleet/review-relay.json` carries `pid`, a `processStartTime` token, the
`run_id` it serves, its `pinned` value and its `workers` set, so *"already running"* is a
comparison rather than a head-count.

`pifleet relay` takes `-r/--run <id>`, `--once`, `--poll <seconds>` and `--json`
(`cli/commands/relay.ts:612-620`). Its header states the property this document reuses:
*"Idempotency is still true and still lives in `run/relay-journal.ts`"*, and *"nothing is
recorded until the children are dispatched, so a killed relay re-dispatches rather than losing a
review."* A pass reads the **host's** inbox (`<run>/inbox/<task-id>.json`), never the worker's
outbox, *"because `/outbox` is the directory the WORKER owns"* (`:45-62`).

### 2.4 The launch directory becomes the run's repository, and a restart cannot change it

`resolveLaunchRepo` (`container/mounts.ts:393-398`, called from `up.ts:1045`) assigns the launch
directory to `run.repo`, overriding `fleet.yaml`. Two cases fall back to the configured value:
launching from inside the fleet's own repo, and launching from a directory that is not a git
checkout. `~/.claude/skills/fleet/Workflows/Consoles.md:22-24` calls this *"the single most
consequential thing about opening a console"*, and the reason is that getting it wrong is
silent: *"the run comes up healthy and the workers do good work on the wrong codebase."*

**And it is fixed at pane-creation time.** The pane's launch argv carries the bind mount, so
`--restart` — which *"keeps its working directory"* (`Consoles.md:45-47`) — returns the worker
with the same repository. §0.5 correction 2 quotes the operator's own record of hitting this.

### 2.5 The relay's fan-out, and the depth bound that stops a second generation

The review console's shape is one parent task `T` producing four derived ids — `T-arch`,
`T-context`, `T-lang` and `T-collate` (`roles/collator.md:136-139`) — in **two generations of
dispatch and exactly two collator turns**. Turn one writes
`/outbox/<T>/dispatch-request.json` (`pifleet.dispatchrequest/v1`) and stops; the host
dispatches three lenses, waits for all three, harvests each, publishes each as
`/replies/<child-task-id>.json`, and dispatches the collator a second time with a brief naming
the reports by path (`collator.md:77-204`).

**A third generation is refused.** `.claude/project-manager-state.json` records the trust-boundary
review finding — *"S4 … nothing bounds fan-out DEPTH; a collator can re-fan-out on its collation
turn"* — and its closure in phase 2 as *"depth refusal (`collation_parent`)"* (commit `f39722f`).
So the review round is one fan-out and one collation, and a design that wanted the collator to
dispatch a fix engineer cannot have it.

### 2.6 What a container can and cannot reach

| Target | From a worker container? | Evidence |
|---|---|---|
| The operator's own repository | **No.** Only its own clone at `/workspace` | `render.ts` mount table; `worktree.ts:1-3` |
| Another worker's clone | **No** | same |
| The run directory | **No, and refusing is enforced on the finished argv** | `assertNoRunDirMount`, `paths.ts:827-836` |
| GitHub | **No.** `egress.allow` (`fleet.yaml:283-336`) names the model relay, the ticket system, npm, PyPI and one GKE master. **`github.com` is not in it** | `fleet.yaml:284-336` |
| The package registries | **Yes, for a role with `egress_access: true`** — `tester` has it (`:661`), `engineer` does not | `fleet.yaml:661-672` |
| Its own `/outbox` | **Yes, read-write**, and a host-side reader already polls it | `render.ts:453`; `registry.ts:922-936` |

**Two rows carry §6.7.** No engineer or tester worker can reach GitHub, so every `gh` verb is
host-side by construction rather than by policy — which is the good direction, and §6.7 declines
to widen it. And `engineer` has no `egress_access`, so **an engineer in a fresh clone cannot run
`bun install`** — the registry entry in `egress.allow` says which hosts are reachable and
`egress_access` says which roles may reach them (`fleet.yaml:661-672`, with the measured symptom:
*"the container sat at 1.6% CPU with 34.9kB of network and 0B written"*). §11 Q4 holds it.

### 2.7 There is already a ProjectManager state file, and it is not the documented one

`.claude/project-manager-state.json` on `feature/harvest-recovery` — Finding E. Beyond the
fields §0.6 lists, three of its entries are design input rather than history:

- `"review_at_end_of_each_phase": true` and `"pr_policy": "Do NOT open a PR. Ask the owner when
  all phases are complete."` — a run that reviews every phase but opens **one** PR at the end.
  That is a different branch model from the skill's, and §10 D2 adopts it as the default.
- `"branch_model": "long-lived"` with `branch`, `base_branch` and `baseline_commit` — one feature
  branch across all phases, not `phase-{N}-{slug}` per phase.
- `"out_of_band_commits"` — a map from sha to *"defect found during integration, not in the
  SRD"*. Real runs find real defects that the phase plan did not name, and the practice was to
  record them rather than to pretend the phase plan was complete.

---

## 3. What is knowable

### 3.1 Knowable and free: the integration path

§2.1. `git fetch worker-eng-1 fleet/<run>/eng-1` from the operator's repository, with
`pifleet worktrees --json` supplying every argument. No new code, no new mount, no new grant. The
only thing that does not exist is a document saying to do it, which is §8.

### 3.2 Knowable and free: two testers cost nothing but an image

§6.1. `tester` is an existing role with an existing image (`toolchain: python`), and the console
plan is a table of four titles. What is not free is the image *tag*: it is a hash over the build
context, so a stale one is refused rather than run
(`~/.claude/skills/fleet/SKILL.md:216-219`). §13 Phase 0 builds it.

### 3.3 Not knowable without a probe, and it decides §6.3: how a phase splits

The commission asks who splits a phase into N engineer envelopes and what happens when the split
is unbalanced or overlapping. **This document cannot settle it from the code, because nothing in
the code has an opinion about it.** What it can do is bound the question, and §6.3 does:
the splitter is the calling session (it is the only actor holding the SRD), the split is by
**file ownership** rather than by task count, and an overlap is detected after the fact at
integration time as a merge conflict rather than prevented before it. §11 Q5 records what that
gives up.

### 3.4 Not knowable at all: whether a review was thorough

Unchanged from `Docs/SRD-REVIEW-CONSOLE.md` §3.4 — nothing in this fleet observes what a model
attended to. `transcript_activity` records that the session file grew. The consensus arithmetic
across three vendors is the only instrument, and it detects **disagreement**, not **effort**.
§7.5's verdict mapping is built on that and claims nothing more.

---

## 4. The principles this bumps into

### 4.1 The `/fleet` cardinal rule, and why a decomposing workflow does not break it

`~/.claude/skills/fleet/SKILL.md:14-46` is unambiguous:

> **When the user says "use tick-1" (or any worker), they are telling you WHO does the work. Your
> job is to relay their instruction, not to complete it first.** … **Pass the user's instruction
> VERBATIM as the `brief`.**

A ProjectManager workflow writes eight or ten briefs the user never typed. **That is a real
tension and it should be resolved explicitly rather than by noticing that nobody complained.**

The resolution is that the cardinal rule is about **substituting your understanding of a task for
the user's at the moment they were most specific**, and its own "How to apply" clause names the
boundary: *"Discover only what dispatch itself mechanically requires."* In `DispatchTask` the
user's instruction **is** the unit of work, so anything you resolve first is work you took from
the worker. In `ProjectManager` the user's instruction is *"implement this SRD"* and the unit of
work is a phase task — **which the SRD already contains.** The briefs are not the orchestrator's
paraphrase of the user's request; they are transcriptions of the document the user pointed at.

So the rule survives with its sense intact, and §8.2 states it as a rule of its own:

> **The SRD is the brief.** Copy each phase task's own words into the envelope. Do not restate
> them in your own, do not resolve the file paths it names, do not look up the API it references,
> and do not decide what it "really means". If a task is too ambiguous to dispatch, say so and
> ask — exactly as `DispatchTask` says — rather than researching your way to an answer.

**What the orchestrator legitimately authors is the SPLIT, not the CONTENT** — which worker gets
which of the SRD's tasks, and the acceptance commands. §6.3 keeps that boundary visible by making
the split a list of task ids from the document rather than a rewrite of them.

### 4.2 §12.1, and why the orchestrator does not become a worker

`Docs/SRD.md:1790-1792`: *"a role granted `bash` is fully privileged inside its container, and
that is the only statement `pifleet` makes."* `Docs/SRD-REVIEW-CONSOLE.md` §0.2 extends it:
dispatch is the first capability whose blast radius is measured in *other workers*, so the
container does not bound it and §12.1's sentence does not cover it. The review console's answer
was to keep the capability on the host and give the collator a request channel instead.

A ProjectManager worker would need that capability **plus** GitHub write credentials, **plus**
the ability to push to the operator's own branch. Every one of those is a widening whose
justification would be convenience. §0.2's decision is the same one the review console made, one
layer up.

### 4.3 §9.1 — per-worker isolation is a security control, and this feature is its first real cost

`isolation: worktree` exists because the alternative was a measured container-to-host RCE
(§2.1). It is not negotiable and this document does not ask for it to be.

**What is worth saying plainly is that this is the first feature for which isolation is a cost
rather than only a benefit.** Every prior use of the fleet dispatched independent tasks whose
results were independent artifacts. This one dispatches N tasks whose results are meant to
*combine*, and the isolation that makes each worker safe is exactly what makes combining them a
step someone has to perform. §6.2 performs it on the host, where the operator's own git identity
and credentials already are, and §10 D3 records the alternative that was rejected.

**And there is a second cost, added in v0.2 because the review round found it and v0.1 had not
named it.** Isolation is per worker, so the console's exposure scales with its seat count and its
seats' grants — and §6.1's seat change raises both. `rev-1` was `shared-ro` with no `bash` and no
egress; `tst-2` inherits `run.isolation: worktree`, holds `bash`, and carries `egress_access: true`.
**The console goes from three shell-capable seats to four, from one egress seat to two, and loses
its only seat that could not run a shell.** §6.1.1 argues why that is acceptable — in short, a tool
grant was never the boundary and the egress grant widens a route rather than a destination — but the
widening is real, it is this section's second entry, and it should not be discovered later by
someone counting containers.

### 4.4 §5.9 and `hosted_repo_consent` — the disclosure gate fires per repository

`fleet.yaml:63-76` records the owner's Q1 decision as a **URL and not a `true`**, with the reason
stated: *"consent to rally-cli must not become consent to the next AppNeta or Broadcom repository
someone happens to launch a console from."* A `/ProjectManager` run against a repository whose
remote matches a refused pattern and is not that URL will be refused at `up`, and **that is the
correct behaviour**. §8.2 makes it a precondition check so the refusal arrives before four
containers are built rather than after.

---

## 5. Scope and non-goals

### 5.1 In scope

1. A `development` console seat model matching the work: `eng-1`, `eng-2`, `tst-1`, `tst-2`
   (§6.1), with the `fleet.yaml`, plan-constant and test changes that implies.
2. A specified **integration model**: how N workers' commits become one branch, who does it, and
   what happens on conflict (§6.2).
3. A specified **phase lifecycle** spanning both consoles, including the handoff (§6.4).
4. A **verdict mapping** from the review console's `collation.json` to the loop's
   APPROVED / CHANGES_REQUESTED branch, with coverage as a separate gate (§7.5).
5. A new `~/.claude/skills/fleet/Workflows/ProjectManager.md`, its routing-table row, and the
   corrected fleet table in `SKILL.md` (§8).
6. A **run state contract** (§7.6) matching the shape practice already reached.
7. Failure and recovery for every stage, expressed in the existing taxonomy (§9).

### 5.2 Non-goals — refused rather than omitted

- **A `pm` role or a fifth console.** §0.2, §4.2.
- **Giving any worker GitHub egress.** §2.6, §6.7. The refusal is not "not yet"; it is that
  `gh pr create` from a container would need a credential the fleet has no channel for and would
  put the operator's GitHub identity behind a hosted model.
- **Worker-to-worker communication.** The bridge permits it (`gateway-block.ts:21-24`) and
  `Docs/SRD-REVIEW-CONSOLE.md` §5.2 already refuses it. Two engineers coordinating directly is
  exactly the design this document declines.
- **Changing the collator's contract.** §7.4 reads `pifleet.collation/v1` as it stands. A field
  the loop wants and the schema lacks is an open question (§11 Q6), not a unilateral extension.
- **Automating `/compact`.** The skill's step 2.9 stays a note to the operator.
- **A second review mechanism.** The review console is the review stage; nothing here adds one.

- **Throughput.** Eight hosted seats across two consoles is a bill and a rate limit
  (`fleet.yaml:746-750`). This document does not optimise it and §11 Q7 asks whether both consoles
  should be up at once for that reason.
- **Making the fleet's verdict trustworthy.** §3.4. The grading is structural; it always was.
- **Supporting repositories the disclosure gate refuses.** §4.4.
- **A migration.** The seat rename is a requirement inside this SRD (§6.1) with its blast radius
  named (§0.6 Finding D), not a migration plan.

### 5.3 Deliberately deferred

- **Closing ISC-517.** A lens lost to a failed harvest never re-enters its collation, because the
  fan-out is journalled after dispatch. §7.5 makes the loop *see* that rather than fixing it, and
  §11 Q6 holds the fix. **This is the one deferral that changes what a ProjectManager run means**,
  and §9.4 says what the loop does about it.
- **More than two engineers or two testers.** The mechanism generalises — `MAX_DISPATCH_REQUEST_ITEMS`
  is 8 and the console plan refuses a fifth pane (`operations-plan.ts`, `DEVELOPMENT_MAX_PANES = 4`)
  — but the integration cost is superlinear in conflicts and nothing has measured it. §11 Q5.
- **An `engineer` seat that can install dependencies.** §2.6: the role has no `egress_access`, so a
  fresh clone's `bun install` hangs against the deny-all policy. §11 Q4 asks whether to grant it or
  to make dependency installation the tester's job.
- **Making the state file authoritative.** §6.6 makes the run tree authoritative and the state file
  a cursor. A design in which the state file *is* the record needs a durability story the calling
  session cannot supply. §11 Q3.

---

## 6. The design

### 6.1 The seat model — the development console stops reviewing

**Two engineers and two testers, and the reviewer seat moves to the console that already reviews.**

```yaml
# fleet.yaml — the `development` console's four seats
- {id: eng-1, role: engineer, pane_mode: tui, theme: tokyo-night}
- {id: eng-2, role: engineer, pane_mode: tui, theme: gruvbox-dark}
- {id: tst-1, role: tester,   pane_mode: tui, theme: everforest-dark}
- {id: tst-2, role: tester,   pane_mode: tui, theme: nord}   # was rev-1/reviewer; nord is freed by the move
```

**The argument is that `rev-1` was a second review mechanism and this design only wants one.** The
`review` console produces three independent readings on three vendors and a collation that records
who said what (`fleet.yaml:730-750`). A single `rev-1` produces one reading whose only structural
grading is the same `collationCeiling` machinery run over nothing. Keeping both would mean a phase
could be approved by the weaker instrument, and it would make "what reviewed this" a question with
two answers.

**What the second tester buys, stated so it is not just symmetry.** `roles/tester.md:6-13` asks for
behaviour tests and failure-path coverage — *"The happy path is usually already exercised by whoever
wrote the feature. The value you add is in the boundary."* One tester against two engineers' work is
the seat most likely to run out of budget before it reaches the boundary cases, and the split §6.3
uses for engineers applies unchanged: **each tester takes the files its paired engineer touched.**

**Five things follow and each is a requirement, not a consequence to discover.**

| # | Requirement | Why |
|---|---|---|
| 1 | `fleet.yaml`'s `rev-1` worker entry becomes `tst-2` on `role: tester`, keeping `pane_mode: tui` and taking `theme: nord` | `theme` uniqueness across attended workers is graded (`config.test.ts`, ISC-400), and `nord` is freed by the same edit |
| 2 | **`pifleet image build --toolchain python` must run before the first `up`** | `tester` is `toolchain: python` and `reviewer` was `base`. The tag is a hash over the build context, so a stale tag is REFUSED rather than silently run — which is the good direction and is still a hard stop |
| 3 | `DEFAULT_DEVELOPMENT_WORKERS` (`operations-plan.ts:632`) becomes `["eng-1", "eng-2", "tst-1", "tst-2"]` | It is what `scripts/development` passes and what the pane plan titles |
| 4 | `test/unit/development-plan.test.ts:47` and `:53`, and `test/unit/status-runs.test.ts:38`, are updated | Finding D. These are the only real pins; the seven other `rev-1` strings are fixture labels |
| 5 | **`roles/reviewer.md` is NOT retired, and `fleet.yaml`'s `reviewer` role comment is corrected** | §0.5 correction 1. All three lenses are `role: reviewer`. What the rename does is orphan the role's `model:` and `thinking:` defaults, because every lens overrides `model:` — so the comment claiming the default *"NOW REACHES ONE WORKER — `rev-1`"* becomes false and the default becomes dead config |

**What breaks, stated honestly.** Nothing at runtime for an existing run: run ids, worktrees and
journals are keyed by worker id and a run that already exists keeps its own roster. What breaks is
**the suite, immediately** — item 4, and §13 has the full surface list — and **any operator muscle
memory** that types `scripts/development --restart rev-1`, which will refuse with an unknown pane
title rather than doing something surprising. §11 Q8 asks whether the `reviewer` role's now-orphaned
`model:` should be removed or left as documentation of the development console's history.

#### 6.1.1 This seat change is a privilege widening, and v0.1 did not say so

**It is, it is accepted, and the reason it is acceptable is narrower than "a tester is like an
engineer".** v0.1's §5.2 said *"no worker gains dispatch or GitHub egress"*, which is true, is about
the orchestrator, and **does not address this at all.**

| | `rev-1` (going) | `tst-2` (arriving) |
|---|---|---|
| `isolation` | `shared-ro` — the operator's checkout, read-only, no clone | `worktree` (inherited from `run.isolation`, `config/load.ts:770`) — its own clone and branch |
| tools | `[read, write, grep, find, ls]` — **no `bash`** | `[read, bash, grep, find, ls]` — **`bash`** |
| `egress_access` | absent | **`true`** (`fleet.yaml:661`) |
| toolchain | `base` | `python` |

**So the console goes from three `bash` seats to four, from one egress seat to two, and loses its
only seat that could not run a shell.** That is a widening on three axes and it should be recorded as
one.

**The argument that it is nonetheless the right trade, in three parts.**

1. **The lost read-only seat was never a boundary.** `Docs/SRD.md` §12.1 is explicit that *"Tool
   scope is not a boundary — the container is"*, and `fleet.yaml:723-726` applies it to this exact
   seat: a tool grant is not what bounds a worker. `rev-1` holding no `bash` made it a *weaker*
   worker, not a *fenced* one; the container was doing the fencing either way. **Removing it forfeits
   no containment.**
2. **The egress widening is a route, not a destination.** `egress_access: true` grants a path to the
   CONNECT proxy; `egress.allow` remains the ceiling and is unchanged (`fleet.yaml:661-672` says
   so: *"Widens no destination; the allowlist is still the ceiling"*). The set of reachable hosts is
   identical before and after. What widens is **how many containers can reach that fixed set**, which
   is a real increase in exposure surface and a much smaller one than "a new egress seat" suggests.
3. **The `bash` widening is the one with no mitigation, and it is the price of the seat doing its
   job.** A tester that cannot run a test runner is not a tester. This is the same grant `tst-1`
   already holds, in the same console, on the same repository.

**What this costs, stated so it is not discovered later: the `development` console after this change
has four containers that can each run a shell against a clone of the operator's repository, two of
which can reach the package registries.** That is the blast radius, it is larger than before, and
§4.3 now carries it as per-worker isolation's second real cost. **If the owner does not accept it,
the withdrawal is cheap and specific** — keep `rev-1`, take §6.1's other four requirements, and
accept the two-review-mechanism problem this section opened with.

#### 6.1.2 It also removes the only in-loop reviewer, and that is a real gap

**"Review happens in one place" is true and it hides this.** `rev-1` is the only seat that can
review **per task, before integration**. The review console's lenses are `shared-ro` on the
operator's checkout and read the **integrated** result at end of phase (§6.4 step 9). So after this
change:

> **A defect `eng-1` introduces is not seen by any reviewer until after the host has merged it onto
> the integration branch.**

**That is a genuine loss of a feedback edge and v0.1 did not name it.** The engineer's own test, the
tester's suite and the harvest's diff grading all still run per task — but none of them is a
*reader*, and §3.4 is clear that reading is the only instrument this system has for "is this the
right change".

**It is accepted, on three grounds, and the third is the one that decides it.**

1. **The merge is local and nothing is published until the review passes.** §6.4 pushes at step 11,
   after step 10's verdict. "Merged" here means merged into a branch on the operator's own machine
   that no one else can see. A defect merged and then rejected costs a fix dispatch, not a bad
   release.
2. **A pre-integration review reviews code that is about to change.** `eng-1`'s branch reviewed alone
   is reviewed without `eng-2`'s half, and §6.3's whole partition rule exists because the two halves
   interact. The finding most worth having — *"these two changes disagree"* — is only visible after
   the merge.
3. **A per-task review by one seat is the weaker instrument, and preferring it would invert §6.1's
   own argument.** One reading with no consensus arithmetic is what `rev-1` offered. Trading three
   independent readings at end of phase for one reading per task is a trade this document declines.

**What would change the decision.** If phases routinely produce integration merges that the review
console then rejects wholesale, the feedback loop is too long and the right answer is smaller
phases — not a fourth development seat. §11 Q5's measurement would show it.

### 6.2 The integration model — the host is the integrator, and the mechanism already exists

**Chosen: the calling session fetches each worker's branch from the `worker-<id>` remote and merges
them onto one integration branch on the operator's own repository. Rejected: an integrator seat, and
a shared branch.**

§2.1 is the whole mechanism. After `up`, the operator's repository has a remote per worker pointing
at that worker's clone, and `pifleet worktrees --json` names the branch. So the integration step is
four ordinary git commands the calling session already has every credential for:

```
git -C <repo> fetch worker-eng-1 fleet/<run-id>/eng-1
git -C <repo> fetch worker-eng-2 fleet/<run-id>/eng-2
git -C <repo> merge --no-ff FETCH_HEAD ...      # one per worker, onto the integration branch
```

**The integration branch is created by the host before the console is launched, and it is the base
every worker clones from.** That ordering is not cosmetic: `up` clones from the launch directory's
current checkout and records `baseSha` per worker (`worktree.ts:89-91`), so a branch created *after*
`up` is a branch no worker's clone contains. §6.4 sequences it.

**Why not an integrator seat.** A worker that merges other workers' branches needs their clones
mounted, which is `assertNoRunDirMount`'s refusal (`paths.ts:827-836`); or it needs the operator's
repository mounted read-write, which is the mount `isolation: worktree` exists to avoid (§2.1's
measured RCE). Neither is available and neither should be built for this.

**Why not a shared branch.** Finding B. There is no shared checkout to hold one, and the branch name
in an envelope is derived rather than read (`worktree.ts:488-530`).

**Conflict resolution, which is the part a design can get wrong by not mentioning it.** A merge that
conflicts is resolved **by dispatching a fix task to one of the engineers, not by the orchestrator
editing the tree.** The orchestrator aborts the merge, and dispatches to the engineer whose branch
merged *second* a brief naming the conflicting hunks and the other engineer's commit — that worker
then rebases inside its own clone and the fetch is retaken. The orchestrator resolving it itself is
available and is refused for one reason: **it makes the orchestrator an author, and every line it
writes is a line no reviewer was told to look at.** §11 Q5 records that this is untested at more than
two engineers.

**The split that makes conflicts rare is §6.3's, and it is the real mitigation.** Conflict resolution
is the fallback; disjoint file ownership is the design.

### 6.3 Task decomposition — the SRD splits it, the orchestrator assigns it, and the unit is a file

**Chosen: the orchestrator assigns the SRD's own phase tasks to workers by file ownership, and
authors no task text. Rejected: splitting a phase in half by task count.**

The current skill splits *"first half"* / *"second half"* of a phase's tasks
(`ProjectManager/SKILL.md:60`, `:78`). That is the right shape for subagents sharing a checkout and
the wrong one here, because two halves of a task list touch overlapping files as often as not, and
an overlap that is free in one checkout is a merge conflict in two.

**The rule: a file has one owner per phase.**

1. Read the phase's tasks from the SRD. Each task in a well-formed phase names the files it touches
   (§12's bullet grammar and §13's checklist both do).
2. Partition the phase's tasks so that **no file appears in two partitions**. A task naming a file
   another partition already owns joins that partition, even if it makes the split uneven.
3. If the partition cannot be made disjoint — a phase where every task edits one file — **do not
   split it.** Dispatch it to one engineer and leave the other idle for that phase. An uneven split
   is cheaper than a merge conflict, and a serialised phase is cheaper than both.
4. Each tester is paired to an engineer and receives the same partition, dispatched **after** its
   engineer settles (§6.4).

**What the orchestrator authors and what it copies.** It authors the *partition* — which task ids
go to which worker — and the `acceptance` array. It **copies the task text verbatim** from the SRD
into `brief`. §4.1 is the argument; the practical test is that a reader holding the SRD and the
envelope can diff them and find the brief inside the document.

**Unbalanced and overlapping splits, answered rather than assumed away.** An unbalanced split is
accepted and visible — the state file records the partition (§7.6's shape), so a phase where one
engineer got eight tasks and the other got one is a fact in the record rather than a thing that
happened. An overlapping split is **detected at integration time as a merge conflict**, not
prevented at dispatch time, because nothing in the fleet knows what files a brief will cause a
worker to touch. §11 Q5 asks whether a post-hoc check — comparing the two workers' `files_changed`
arrays before merging — is worth building; it would catch the overlap one step earlier than git
does, and it would catch it after the tokens were already spent.

### 6.4 The phase lifecycle — twelve steps across two consoles

**The handoff between the consoles is a branch, and it is the only thing that crosses.**

| # | Step | Where | Notes |
|---|---|---|---|
| 1 | Create the integration branch from `base_branch` and push nothing | **host** | Must precede step 2 — §6.2 |
| 2 | `cd <repo> && scripts/development` | **host** | The launch directory becomes `run.repo`. Four runs come up, each worker clones the integration branch |
| 3 | Partition the phase's tasks | **host** | §6.3. Recorded in the state file before dispatch |
| 4 | `scripts/development --restart eng-1 --task <env>` and the same for `eng-2` | **host → containers** | Recreate-then-dispatch, so each engineer starts on a fresh session (`fresh-dispatch.ts:1-17`'s measured reason) |
| 5 | Wait for both, then `pifleet artifacts` each | **host** | §9.1 covers a stall |
| 6 | Fetch and merge both engineer branches onto the integration branch | **host** | §6.2 |
| 7 | `scripts/development --restart tst-1 --task <env>` and `tst-2` | **host → containers** | **After** the merge, so each tester's clone contains both engineers' work |
| 8 | Wait, harvest, fetch and merge both tester branches | **host** | Same as 5-6 |
| 9 | `cd <repo> && scripts/review` and dispatch `col-1` a review request naming the integration branch | **host → review console** | §6.5 |
| 10 | Read the collation; branch on §7.5's verdict | **host** | CHANGES_REQUESTED loops to step 4 with a fix partition; `max_review_iterations` bounds it |
| 11 | Push the integration branch; `gh pr create`; `gh pr checks --watch` | **host** | §6.7 |
| 12 | Merge, version bump, docs, `/compact`, next phase | **host** | Under D2 (§10) the PR is opened once at the end, not per phase |

**Steps 4 and 7 are sequential and steps 4a/4b are parallel.** Two engineers are dispatched in one
message and run concurrently; the testers wait because a tester dispatched before the merge tests
half the phase. The cost is that a phase's wall time is engineer-time **plus** tester-time **plus**
review-time rather than the maximum of them, and §11 Q7 asks whether that is acceptable.

**Step 9's dispatch is the only cross-console act, and it carries no state.** The review console
learns nothing about the development run — not its run id, not its worktrees, not its envelopes. It
is pointed at a branch in the operator's repository and reviews it, exactly as it would for a review
a person asked for by hand.

### 6.5 The review round — a collator fan-out, consumed rather than re-specified

**Nothing here is new. This section says which existing behaviour the loop depends on.**

The round is `pifleet.dispatchrequest/v1` → three lens dispatches → three harvests → three replies →
one collation, over two collator turns (§2.5). Its shape for a ProjectManager phase:

```
review request  T-review-p3        dispatched by the host to col-1
  ├── T-review-p3-arch       rev-arch-1    (architecture + security)
  ├── T-review-p3-context    rev-ctx-1     (cross-file contracts)
  ├── T-review-p3-lang       rev-lang-1    (implementation language)
  └── T-review-p3-collate    col-1         (turn two — the collation)
```

**Child ids are derived by concatenation, not minted** — `childTaskId(parent, aspect)` is
`` `${parent}-${aspect}` `` (`task-ids.ts:135-176`), and the 64-character cap **refuses rather than
truncates**, because *"two parents whose names differ only past the cut would derive one child id,
and the second fan-out would replay the first one's task instead of running."* **This is a naming
constraint on the ProjectManager run**: `T-review-p3` plus `-context` is 19 characters and safe, and
a parent id built from a phase slug is not automatically so. §10 D6 fixes the id grammar.

**How the round is actually triggered and waited on, because "consumed rather than re-specified" was
doing too much work in v0.1.** The fan-out is not a library call the orchestrator makes; it is an
exchange between three parties, and only the first and last steps are the calling session's:

| # | Step | Who |
|---|---|---|
| 1 | The `review` console is up and its relay record names the live collator run | **session** — §8.2 precondition 6 |
| 2 | A review-request envelope is staged to `col-1` (`scripts/review --restart col-1 --task …`) | **session** |
| 3 | `col-1` turn one writes `/outbox/<T>/dispatch-request.json` and settles | collator |
| 4 | The relay reads the host's inbox, fans out three lens dispatches, journals after dispatch | **relay** |
| 5 | The relay waits for all three, harvests each, publishes surviving replies | **relay** |
| 6 | The relay dispatches `col-1` turn two with a brief naming the reports | **relay** |
| 7 | `col-1` writes `collation.json` and `review.md` | collator |
| 8 | The session reads `artifacts --task <T>-collate` and applies §7.5 | **session** |

**Steps 3-7 are not observable as a single call and there is no "wait for the review" verb.** The
session waits by polling for the collate task's artifacts, with the run tree as its progress signal:
the journal at `<run>/relay/col-1/<T>.json` appears when step 4 has happened, and reply files appear
as step 5 completes. **`pifleet wait --task <T>` is the wrong thing to wait on** — that is the
fan-out parent, which settles at step 3.

**This is a long wait with several silent failure modes and §11 Q12 asks whether it should be a human
step instead.** The honest position: the mechanism is automatic, the *supervision* of it is not, and
a session that polls forever because the relay died is §9.3's failure with no timeout of its own.
**The loop must bound its own wait** and report the run tree's state when it expires.

**The three facts the loop must not get wrong.**

1. **The parent task settles when the fan-out is issued, not when the review is done** — D5 of the
   review-console SRD. `pifleet artifacts --task T-review-p3` returns the collator's *turn one*
   envelope, which claims `success` for having written a dispatch request. **The loop must read
   `T-review-p3-collate`, not `T-review-p3`.**
2. **The collator's own verdict is about its collation, not about the code and not about coverage.**
   `roles/collator.md:228-235`, and ISC-514 made coverage and verdict separate axes for exactly this
   reason. §7.5 derives the loop's verdict from the collation's *contents*.
3. **The relay must be running.** `scripts/review` starts it unless `--no-relay` is passed
   (`console-relay.ts:20-51`), and a console whose relay is dead has four healthy workers and no way
   for a request to become reviews. §8.2's preconditions check the record.

**The review target is a branch, and the lenses see it as a working tree.** Reviewers are
`isolation: shared-ro` (`fleet.yaml:591`), so `/workspace` is the operator's checkout mounted `:ro`
— **the checkout as it stands when `up` ran, at whatever ref it is on.** §6.7 resolves what that
means for reviewing a *diff*.

### 6.6 Supervision and idempotency — the run tree is authoritative and the state file is a cursor

**The relay's property is that all state derives from the run tree, and a re-issued fan-out rewrites
the same files.** `relay-journal.ts:117-151` chooses to journal AFTER dispatch and states both arms:
journalling first *"turns a crash into a review that silently never happens"*, journalling last
*"turns it into one that happens twice"* — **"This module chooses AFTER, and takes the duplicate."**
The journal is one file per request at `<run>/relay/<sender>/<task-id>.json`, keyed on
`(sender, task-id)` and **rewritten, not appended**.

**A ProjectManager run keeps that property by deriving its own state the same way, and the rule is
one sentence: nothing the orchestrator writes is evidence.**

| Question a resumed run asks | Answered from | Not from |
|---|---|---|
| Did phase N's engineers run? | `pifleet artifacts --task <id> --run <id> --json` | the state file's `completed_phases` |
| Did their work reach the integration branch? | `git log <integration-branch>` and `git merge-base --is-ancestor` per worker branch | the state file's commit lists |
| Was phase N reviewed? | the collation artifact under `T-…-collate` | `review_at_end_of_each_phase` |
| Is a worker mid-task right now? | `pifleet status --all --json` | anything |

**The state file's job is to say what was INTENDED, so a resumed run can tell an incomplete phase
from an unstarted one.** It records the partition, the task ids and the integration branch — all
things the run tree cannot supply because they are decisions rather than events. §7.6 is its shape.

**What a resumed or interrupted run does, in order.** (1) Read the state file for the intended
partition. (2) `status --all --json`; if any worker holds a task from this run, **wait for it** —
`recreateThenDispatch` would refuse anyway, having stopped nothing (`fresh-dispatch.ts:199-206`).
(3) For each intended task id, `artifacts` it; a task with a result envelope is done and is not
re-dispatched. (4) For each done engineer, check whether its branch is already an ancestor of the
integration branch; merge only the ones that are not. (5) Resume at the first step whose evidence is
absent.

**Re-dispatching a task id that already ran is the one thing this must not do**, and the reason is
the epoch: an envelope whose `epoch` does not match is refused and the work harvests as though the
container produced nothing (`skills/pifleet-worker/SKILL.md:184-196`). Step 3 is what prevents it.

**What is NOT idempotent, said plainly.** A re-issued *review* fan-out is idempotent — derived child
ids rewrite the same reply files and the same journal entry. A re-issued *engineer* dispatch is not:
it is a fresh task into a recreated worker, and the previous attempt's commits are still on that
worker's old branch in a clone `down --prune` may have removed. §9.2 covers it.

### 6.7 The host/worker boundary — and why an engineer needs no GitHub

**The rule: anything that touches the operator's repository, the operator's credentials, or GitHub
stays on the host. Anything that reads or writes `/workspace` is a worker's.**

| Step | Side | Why |
|---|---|---|
| Read the SRD, partition the phase | host | The SRD is a host file; a worker sees only `/workspace` |
| Create the integration branch | host | §6.2 — must exist before `up` clones |
| Write code, write tests, run the suite | **worker** | This is the whole point |
| Fetch and merge worker branches | host | The remotes are on the operator's repository |
| Dispatch the review request | host | §4.2 — dispatch is not a tool |
| `git push`, `gh pr create`, `gh pr checks --watch`, `gh pr merge` | host | Below |
| Version bump, CHANGELOG | host | Post-merge, on the operator's branch |

**Does an engineer worker need GitHub reach? No, and the answer is structural rather than
preferential.** `egress.allow` (`fleet.yaml:284-336`) names the model relay, the ticket system, the
package registries and one GKE master. **`github.com` is absent.** Adding it would not be enough on
its own — `engineer` also has no `egress_access: true`, so it has no route to the proxy at all — but
the reason not to is what those two edits would buy: a `gh` verb from inside a container needs a
GitHub token in the container, delivered through `secrets:`, in a worker whose model is hosted.
**That puts the operator's GitHub identity one prompt injection away from an untrusted repository's
contents**, which is `Docs/SRD.md` §12.2's own subject. The host already has the credential and the
identity; nothing is gained by moving the verb.

**The one place this bites is the review target.** §6.5 notes that a lens sees `/workspace` as a
checkout, not as a diff, and a lens with no GitHub cannot fetch a PR. **The host supplies the diff
into the run**, and there are two ways to do it:

- **Chosen: launch the review console with the integration branch checked out**, and name the base
  ref in the review brief. Each lens then has the whole tree at the right ref and can run
  `git diff <base>...HEAD` — except that reviewers hold no `bash` (`fleet.yaml:588`), so they
  cannot. **So the brief must name the changed files explicitly**, which the orchestrator has from
  the merge it just performed.
- **Rejected: write the diff into the run as a file the lenses read.** It would work — the collator
  could name a path — but it duplicates a thing git already holds, it goes stale the moment a fix
  lands, and it makes the review's subject a file rather than the tree.

**So the review request's brief carries the base ref and the changed-file list, and the tree carries
the code.** §7.4 makes that a contract rather than a habit.

### 6.8 Toolchain and identity — both are requirements

**Toolchain.** `toolchain:` is per role and decides what exists in the image (`fleet.yaml`,
`SKILL.md`'s table). A ProjectManager run against a Python repository dispatched to `engineer`
(`toolchain: node`) produces a worker that can read the code and cannot run it. **The requirement:
the workflow refuses to start when the target repository's language and the seats' toolchains
disagree**, and names the build command rather than proceeding.

Detection is a heuristic and this document says so: a `pyproject.toml` or `setup.py` at the repo
root means Python, a `go.mod` means Go, a `package.json` means Node. A repository with two of them is
ambiguous and the workflow **asks** rather than guessing. §11 Q9 records that the heuristic is
untested and that `full` (python + go) exists as the escape hatch at the cost of image size.

**One asymmetry that looks like a problem and is not.** `tester` is `toolchain: python` and
`engineer` is `node`, which reads as a tester that cannot run a node project's suite.
**It is not**: `python` is built `FROM toolchain-node` (`docker/Dockerfile:145`) and bun is installed
in that stage (`:118-119`), so a tester holds node's tools and Python's. **v0.1 said the opposite
here, on the authority of a `fleet.yaml` comment that has been stale since `2ccf851`** — §0.5
correction 5. A toolchain adds a platform; it never trades one away.

**Three things remain true and narrower, and they are what the requirement above is for.** An image
built before `2ccf851` lacks bun until rebuilt — and `src/container/image.ts:242-244` hashes the
Dockerfile into the tag, so a stale python image cannot be silently reused, it is refused. The
`engineer` seats at `node` genuinely cannot run pytest, **so the mismatch that matters is
engineer-side, not tester-side.** And the tracked `fleet.example.yaml:489` still declares the tester
at `toolchain: node`, so a `tst-2` added there without also switching the toolchain is a node
tester — §13 Phase 1 carries both edits for that reason.

**Identity.** A commit made inside a container is made by whatever git identity that container has.
Nothing in `fleet.yaml`'s `secrets:` block delivers one, and `docker/entrypoint.sh` is not a
credential channel. **The requirement: every worker container has `user.name` and `user.email` set
before the first commit**, sourced from the run's own configuration rather than from the operator's
`~/.gitconfig` — which is not mounted and must not be.

**v0.2 closes this. It was Q10 and BLOCKING in v0.1; it is now D13, because the review round showed
it is answerable from the code rather than requiring an owner preference.**

**What is true today, and it was measured rather than reasoned.** Nothing supplies an identity:
`docker/Dockerfile:400` sets only `git config --system --add safe.directory /workspace`, and
`worker-env.ts:783-787` delivers only `GIT_CONFIG_COUNT=1` with `safe.directory` as key 0. Neither
sets `user.name` or `user.email`, and a repository-wide grep finds no non-test occurrence of either.

**A probe against the real image settles it.** Run against
`pifleet/pi-worker:0.79.6-base-…` under `--read-only` as uid 10001 with exactly the env
`worker-env.ts` delivers:

```
Author identity unknown
*** Please tell me who you are.
fatal: unable to auto-detect email address (got 'pi@4150f1e03ea1.(none)')
COMMIT_EXIT=128
```

Auto-detection fails because `Dockerfile:369`'s `useradd` leaves an empty gecos and the container
hostname has no domain. **So an uninstructed worker cannot commit at all, and every §6.4 step that
depends on a worker's commits is currently unreachable.** That is sharper than v0.1's "the identity
is unknown": the loop does not have a provenance problem, it has a hard stop.

> **An erratum in v0.2's own drafting, recorded rather than corrected silently.** An earlier draft
> cited `worktree.ts:852-855` — *"a commit would fail outright"* — as evidence for this. **That
> passage is about the HOST**: it is `captureWorktreeBaseline`'s docblock explaining why `up` records
> a baseline instead of committing the hazard-neutralisation rename, and "this module's hermetic
> environment" is the host pifleet process, not the container. The conclusion survives; the citation
> was wrong and the probe above replaces it.

**Two further measured facts decide the arms below.** `git config --global` **fails** inside the
container — `could not lock config file /home/pi/.gitconfig: Read-only file system` — because
`render.ts:600` mounts a volume only at `/home/pi/.pi/agent` and `HOME` stays read-only. But the
clone **is** writable: `mounts.ts:216` runs `chmod -R a+rwX` over the worker's worktree, and a live
clone's `.git/config` is mode `-rw-rw-rw-`. So a worker **can** set a repository-local identity, and
in the probe it did — committing as `eng-1 <eng-1@pifleet.invalid>`, **an identity it invented, that
nothing in the fleet constrains or records.**

**That is the real exposure and it is worse than "cannot commit":** an uninstructed worker is
blocked, and an improvising one is unattributable.

**Two arms, and D13 takes both in order:**

1. **Interim, no code change — the brief instructs it.** Each engineer and tester envelope carries
   `git config user.name …` / `user.email …` as its first step (repository-local; `--global` is
   unavailable). This unblocks §13 Phase 2 immediately. **Its weakness is not that a worker might
   skip it** — a skip fails loudly at the first commit — **but that a worker might improvise
   instead**, which is what the probe did, and that failure is silent and lands on the integration
   branch.
2. **Durable — extend the `GIT_CONFIG_*` channel in `worker-env.ts:783-787`.** The precedent is in
   that exact block, git's own mechanism needs no writable file, and no model can skip or override
   it. **One implementation note that is easy to get wrong: `GIT_CONFIG_COUNT` is currently `"1"`,
   so adding an identity means setting it to `"3"` and adding keys 1 and 2 — appending keys without
   bumping the count leaves them silently unread.**

**Arm 2 is the answer; arm 1 is what makes Phase 2 dispatchable before arm 2 exists.** Because
arm 1's failure mode is an invented identity rather than a refusal, **§12's attribution criterion
must assert the author's exact value, not merely that a commit succeeded.**

**The interim arm is not a shortcut past the durable one**; it is what makes Phase 2 independent of
Phase 2's own code change, and §13 sequences both.

**Whichever is chosen, the identity must not be the operator's own.** A commit authored as the
operator by a hosted model is a provenance claim nobody made, and the integration merge on the host
is where the operator's authorship legitimately enters. **And no commit message, code comment or PR
body produced by this system carries an AI or assistant attribution line** — `roles/engineer.md:28`
and `roles/collator.md:419` both already instruct it, and §13's checklist re-asserts it as a
gradable property rather than an instruction.

### 6.9 Observability — how the calling session sees progress without polling blindly

**Three surfaces, each answering a different question, and none of them is the pane.**

```
pifleet status --all --json          # phase, task_id, staged_task_id, transcript_activity
pifleet worktrees --run <id> --json  # per worker: branch, dirty, commitsAhead
pifleet artifacts --task <id> --run <id> --json
```

**`transcript_activity` is how working is told from wedged** (`Workflows/Observe.md:15-18`): a `busy`
worker whose `entries` count is not growing and whose `last_growth_at` is minutes old is stuck,
whatever `phase` says. The orchestrator polls `status --all --json` on the same cadence
`DispatchTask` already prescribes — once at ~30s to confirm the task started, then at the wait
interval — and **does not read panes for any purpose** (`Docs/SRD.md` §0.2 Decision 1).

**`worktrees --json` is the progress signal the current skill has no equivalent of.** `commitsAhead`
against `baseSha` says whether an engineer has committed anything yet, without reading its
transcript and without waiting for its envelope. A phase where both engineers are `busy` with
`commitsAhead: 0` after twenty minutes is a phase in trouble, and that is knowable now.

**For the review round, the run tree and the journal are the surfaces.** `<run>/relay/col-1/<parent>.json`
exists exactly when the fan-out has been issued and journalled; `status` gained a check for an
unconsumed dispatch request with its age (ISC-513). A review that has not started and a review that
is in flight are distinguishable without opening a container.

**What the orchestrator reports to the operator per phase**, so progress is legible without asking:
the partition, each worker's `task_id` and `phase`, `commitsAhead` per branch, and — after step 9 —
the coverage as `<reported>/<dispatched>` **counted from the run tree**, never from the collation.
That last number is the one §7.5 refuses to let it round up.

### 6.10 The dispatch plane is staged, not RPC, and the loop must be written against that

**Every seat in both consoles is `pane_mode: tui`, and that is not a detail of presentation — it
changes which orchestration primitives exist.** v0.1's §6.3 partition happens to avoid every edge the
dispatch plane refuses, and it should be recorded that this is **the shape the plane permits, not a
preference this document arrived at independently.**

| Constraint | Evidence | What the loop must do |
|---|---|---|
| A `tui` worker never takes the RPC route | `planDispatch`: `if (mode === "tui") return { kind: "pane" };` (`src/cli/commands/dispatch.ts:291-302`); the supervisor's own refusal reason is `pane_mode_tui_has_no_rpc_dispatch` (`src/supervisor/index.ts:2424`) | Expect `via: "staged"`. It is success, not a warning |
| `depends_on` onto a `tui` worker is refused at graph construction, exit 2 | `orchestrate/graph.ts:49-73`, thrown at `:195-199` — *"a tui worker's completion cannot be waited on"* | **No cross-worker dependencies.** A phase cannot be expressed as a dependency graph across seats |
| Auto-scheduling never targets a pane route | `orchestrate/graph.ts:97-100`; rejected `pane_mode_tui_is_not_auto_schedulable` at `dispatch.ts:1246-1261` | **No `--auto`.** Every task is pinned to a named worker |

**And one constraint that is worse than the review round reported, which is why this subsection is
not just a restatement.** The staged arm of the dispatch *function* does return
`accepted: true` alongside an `error` field carrying `trigger.reason`
(`src/cli/commands/dispatch.ts:1848-1856`) — the reason **nobody typed the trigger line**, which
`:1862-1867` glosses as *"it means nobody is going to start this turn — a human must type the
line."* **But `pifleet dispatch --json` does not emit that field.** Its accepted payload
(`dispatch.ts:981-998`) is `accepted`, `task_id`, `worker`, `epoch`, `attempt_id`, `replayed`, `via`,
`summary` — and no more. The only consumer that reads `error` is the relay
(`relay.ts:2442-2451`, which turns it into `stage_trigger_deferred`).

> **So a staged dispatch whose trigger was never typed prints `accepted: true`, `via: "staged"`, and
> exits 0. The envelope is on disk, the worker has not been woken, and nothing in the JSON says
> so.** The review round's advice — *"check `error` as well as `accepted`"* — is not available to a
> CLI caller. This is the same failure shape as the one `fb38fc8` closed for a dispatch that did not
> land, in a case that fix does not cover.

**The remedy is the one the fleet skill already prescribes for a different reason, and this makes it
load-bearing rather than hygienic:** confirm from `status`, not from the dispatch payload. §6.4 step 3
polls at ~30s for `phase: busy` with growing `transcript_activity.entries`; a worker still `idle`
with a `staged_task_id` set is precisely this case. **`pifleet dispatch --json` returning `accepted:
true` is not evidence that a turn started, and the loop must not treat it as such.**

**So the loop's shape is forced: tasks pinned per worker, no `depends_on`, no `--auto`, and dispatch
acceptance confirmed from `status` rather than from the dispatch result.** §6.3's file-ownership
partition satisfies the first three — each partition names its worker, and nothing declares a
dependency — but it satisfies them because disjoint file ownership happens to be expressible without
a graph, not because the partition was designed around the refusals.

**The sequencing §6.4 needs is therefore the orchestrator's own, not the plane's.** "Testers after
the merge" (step 7) is enforced by the calling session waiting, because `depends_on` is unavailable.
**That is a correctness obligation on the loop and it has no mechanical backstop** — a session that
dispatches a tester early gets a tester testing half a phase, and nothing refuses it. §12 makes it a
criterion.

### 6.11 Nothing in the fleet bounds this loop's concurrency — the loop counts its own budget

**The bound is absent for two independent reasons, and the second is stronger than "per-run".**

1. **Scope.** `run.max_concurrent` and `run.budget` are per-run: the `BudgetManager` is *"ONE of
   these per run … not one per worker"* (`orchestrate/scheduler.ts:174-178`), its state file is
   `<run>/budget.json` (`paths.ts:210`), and it **refuses to adopt another run's spend** —
   *"budget.json belongs to run '…', not '…'"* (`safety/budget.ts:110`). Four attended panes are
   four runs (`operations-plan.ts:620-631`: *"this console is four keyboards, so it is four runs"*).
2. **Reachability — and this is the part that matters.** `admit()`, which enforces both the
   concurrency cap (`budget.ts:293-299`) and the token ceiling (`:304-314`), has **exactly one
   caller**: `scheduler.ts:812`, inside the `--auto` loop. **§6.10 establishes that this loop cannot
   use `--auto` at all.** So the enforcement path is not merely scoped too narrowly — it is
   unreachable from every dispatch this design makes. `wait.ts:343-345` states the consequence
   plainly: *"a manual dispatch has no budget.json and no ceiling to cross."*

**So two engineers generating at once are bounded by nothing but the inference server itself.** Add
the review console and a phase's review round is four more hosted seats in four more runs. The
fleet's own comments say the equivalent from the other direction (`operations-plan.ts:626-631`,
`fleet.yaml:746-750`) — *"Admission control cannot queue across runs, so six panes generating at once
is six concurrent requests. That is a throughput decision the operator makes by opening this
console"* — but those are observations, not limits.

**The `tokens_ceiling: 6000000` in `fleet.yaml:80` therefore does not bound a ProjectManager run.**
An operator reading that line as this feature's spending limit would be wrong, and that is worth
stating because it is the natural reading.

**The requirement: the orchestrator counts its own spend and reports it per phase.** Concretely, it
records how many seats it has in flight and stops dispatching a new phase while a previous phase's
seats are unsettled — which §6.4's step ordering already produces, and which is here stated as the
reason rather than left as a consequence. **This document does not propose a fleet-side bound**; a
cross-run ceiling is a change to the run model and §11 Q7 is where the throughput question lives.

---

## 7. Contracts

**Four of the six below already exist and are quoted; two are new and are specified the way this
repository specifies contracts — a path, a versioned media-type string, and prose enumerating both
the fields and the fields that are refused.** No new zod schema is authored here; `src/contracts.ts`
and `src/run/collation.ts` own the ones that exist and this document does not fork them.

### 7.1 The engineer and tester envelope — existing, unchanged, and three fields are load-bearing

`TaskEnvelopeSchema` (`src/contracts.ts:146-171`) is what `pifleet dispatch --task <file>` accepts.
The orchestrator writes four of its fields and the host fills the rest:

```ts
schema: z.literal("pifleet.task/v1")
task_id: shortStr
title: text
brief: text
acceptance: z.array(text).max(MAX_ITEMS).default([])
deadline_s: z.number().int().positive()
// filled by dispatch: run_id, epoch, attempt, worker, dispatched_at, repo,
// host_workdir, container_workdir, branch, base_ref, inputs, constraints, outbox, depends_on
// cloud_allow is DESCOPED at this layer and must be empty (contracts.ts:167)
```

**`brief` is the SRD's own words** (§4.1, §6.3). **`acceptance` is the orchestrator's**, and it is
the one field that decides whether a no-diff task can be graded at all — `Docs/SRD-REVIEW-CONSOLE.md`
Finding D records that acceptance commands are refused if they contain
`` | & ; < > ` $ ( ) \ * ? ~ ``, resolved from the base SHA rather than the worker's tree, so
*"commit a script at the base SHA instead"*. A ProjectManager phase whose acceptance is `bun test`
tokenizes to a three-word argv and exits non-zero; the correct spelling is the runner and its
arguments, or a committed script.

**`branch` is NOT the orchestrator's to set.** It is written by dispatch from `workerBranch()`
(§2.1). An envelope naming a branch is not refused — it is ignored, which is worse, and Finding B is
what that costs.

### 7.2 The integration record — new

```
<repo>/.claude/project-manager/phase-<N>/integration.json
```

Shape (`pifleet.pmintegration/v1`): the run id, the integration branch, its base SHA, and one row
per worker carrying `worker`, `remote` (`worker-<id>`), `branch`, `task_id`, `head` (the SHA
fetched), `commits_ahead`, `merged` (boolean) and `merge_commit` (nullable). **Refused: any field
naming a model, a container, a mount, or a host path outside the repository.** The record's whole
purpose is to make step 6 of §6.4 re-derivable, and a path into `~/.pifleet` would make it a second
spelling of the run tree.

**It is written AFTER each merge, never before**, on `relay-journal.ts:117-151`'s own reasoning
transposed: a record written first turns a crash into a merge that silently never happens, and a
record written last turns it into one that is attempted twice — and a re-attempted merge of an
already-merged branch is a no-op that git reports as such. **This document takes the duplicate, for
the same reason the journal does.**

### 7.3 The review request — the host's envelope to `col-1`

An ordinary `pifleet.task/v1` envelope, dispatched by the host, whose `brief` carries four things
the collator cannot derive:

1. **The integration branch and its base ref**, so the review's subject is a range and not a tree.
2. **The changed-file list**, from the merge the orchestrator just performed. §6.7 — the lenses hold
   no `bash` and cannot compute it.
3. **The phase's name and its SRD section**, so a lens can ask whether the change does what the
   phase said it would.
4. **Nothing about the development run.** Not its run id, not its workers, not its envelopes. The
   review console reviews code, not a fleet.

**`task_id` must survive child derivation.** `childTaskId` concatenates (`task-ids.ts:135-176`) and
**refuses** past `MAX_RELAY_TASK_ID_CHARS = 64` rather than truncating. The longest suffix in play is
`-collate` (8) and the longest aspect is `-context` (8), so a parent id of 56 characters or fewer is
safe. §10 D6 fixes the grammar at `T-rv-p<N>` and §12's checklist grades it.

### 7.4 The collation — existing, and the loop reads three of its fields

`CollationSchema` (`src/run/collation.ts:486-664`), written by `col-1` to
`/outbox/<task-id>/files/collation.json` and harvested as an artifact:

```
schema: "pifleet.collation/v1"
task_id           the COLLATION id, T-<parent>-collate
parent_task_id    the review request
lenses[]          {aspect, worker, reported: boolean, note?}   — EVERY seat, not just the answerers
finding_count     the collator's own count, recorded beside findings[] rather than enforced
findings[]        {statement, file, line, raised_by[], disputed_by[]}
```

**Three fields are refused by the schema and the refusal is the contract that matters**:
`acceptance`, `verified` and `status` are `notHere(...)` (`collation.ts:543-559`). **A collation may
not carry a verdict.** That is D8 of the review-console SRD, and it is why §7.5 has to derive one.

**`lenses[]` is the denominator and it is checked against the console's seats.** A row missing, a row
too many, or a row whose `aspect` does not match its worker refuses the document
(`roles/collator.md:302-312`). `reported` is **about what reached the collator**, not about what the
reviewer did — a lens whose review was written and could not be read is `reported: false`.

**The prose half is `review.md`** at the same `files/` path, and it is what a person reads. The loop
does not parse it; it attaches it to the PR.

### 7.5 The review verdict mapping — new, and it is the contract this design turns on

**The loop needs APPROVED / CHANGES_REQUESTED. The collation is forbidden from carrying one. So the
orchestrator derives it, and the derivation has two independent gates that must BOTH pass.**

```
<run>/outbox/col-1/<T>-collate/files/collation.json     the structural record
<run>/outbox/col-1/<T>-collate/files/review.md          the prose
```

**Gate 1 — coverage, read from the run tree and NOT from the collation.**

> **v0.2 correction, and it reversed this section's central claim.** v0.1 said the coverage numbers
> in the collation were *"the host's number, not the model's"*. **That is false.** `lenses[]` is
> collator-authored, and so are the census fields derived from it — `contracts.ts:1118-1120`'s
> `lenses_total` / `lenses_reported` / `lenses_missing` are marked *"Recorded as a DATUM and
> consulted by no ceiling"*. The relay does count coverage itself, and `relay.ts:1737` puts it in
> the collation **brief** as text — *"COVERAGE: N of M lenses reported. That is the host's…"* — which
> means it reaches the collator as a number it is asked to copy. **A number a worker is asked to
> copy is a worker-authored number.** Reading it as the host's was the most consequential error in
> v0.1, in the section that says the design turns on it.

**Two facts make this worse than a wrong citation, and both are load-bearing.**

1. **Nothing caps a `success` claimed over a partial fan-out.** `collationCeiling`
   (`collation.ts:1046-1053`) names the gap in its own docblock: *"It does not cap a `success`
   claimed over a partial fan-out… a collator that ignores its brief and claims `success` over two
   lenses is capped by nothing here."*
2. **A `partial` collation gets no structural check at all.** `censusCeiling`
   (`collation-census.ts:488`) is `if (claimedStatus !== "success") return null;`. **So the one
   instrument that bounds the shape of a collation is switched off for exactly the status that
   triggers this gate.**

**So the gate reads the run tree, where both numbers are host-written and no worker can reach
them:**

| Quantity | Host-side source | Why it cannot be forged |
|---|---|---|
| **Denominator** — lenses dispatched | `<run>/relay/<sender>/<parent>.json` → `children[]` (`RelayJournalEntry`, `relay-journal.ts:281-302`) | The journal is written by the relay after it dispatches. `/outbox` is the worker's; `<run>/relay/` is not mounted into any container |
| **Numerator** — lenses whose report survived | the count of `<replies-dir>/<child-task-id>.json` files that exist | Each is written by the host's `publishReply`, once per survived child (`relay.ts:1180-1183`), and the mount is read-only to the collator (`replies.ts:204-206`) |

```
coverage_reported  = |{ c in journal.children : replyHostPath(dir, c) exists }|
coverage_dispatched = |journal.children|
```

| Coverage | The loop's action |
|---|---|
| `reported === dispatched` | Proceed to Gate 2 |
| `reported < dispatched` | **`REVIEW_INCOMPLETE`. Not APPROVED, and not CHANGES_REQUESTED either.** Report which lenses are missing and, for each, which of the two kinds it is (§9.4). Do **not** advance the phase and do **not** count the round against `max_review_iterations` |
| no journal entry for `<parent>` | The fan-out was never issued. §9.3's `refused` or `none_landed` |
| journal exists, no reply files | `not_collated` — lenses were dispatched and none survived. §9.3 |

**The collation's own `lenses[]` is still read, and it is read as a CROSS-CHECK rather than as the
count.** Where the collator's row set disagrees with the journal's `children[]` — a row missing, a
row for a lens never dispatched, or `reported: true` on a lens with no reply file — **that
disagreement is itself reportable**, and it is the only signal available that a collator is not
copying its brief faithfully. §12 makes it a criterion.

**This gate exists because of ISC-517 and it is the honest response to it.** ISA.md's entry is
explicit: *"a fan-out that collates is journalled, so the lens is absent from that collation
permanently and no later pass brings it back… The review is findable by a human and still missing
from the document."* Its close condition is *"a re-harvest before the journal, or a collation
deferred until every dispatched lens has been read or declared unreadable — and neither is built."*
**A ProjectManager loop cannot fix that and must not paper over it.** Treating a 2-of-3 collation as
a full review is the precise failure the criterion was filed to make visible, and §11 Q6 is where the
fix belongs.

**A worked example, and it is this document's own review round.** The collation for the review that
produced v0.2 recorded **1 of 3 lenses reported**. The truth was **0 of 3**: the review target was a
branch with no host-side checkout, the reviewer seats are `shared-ro` with no `bash`, and the brief
told them to run `git show`, which they cannot. Two lenses filed `blocked`; the third reviewed from
the commit message and the brief and was recorded `reported: true`. **Gate 1 as written in v0.1
would have read `1 of 3` from the collation and called it `REVIEW_INCOMPLETE` — the right verdict
for the wrong reason, and it would have been `3 of 3` and APPROVED had the third lens been joined by
two more that read no more than it did.** §0.8 records the round; §8.2 adds the precondition that
prevents it.

**This gate exists because of ISC-517 and it is the honest response to it.** ISA.md's entry is
explicit: *"a fan-out that collates is journalled, so the lens is absent from that collation
permanently and no later pass brings it back… The review is findable by a human and still missing
from the document."* Its close condition is *"a re-harvest before the journal, or a collation
deferred until every dispatched lens has been read or declared unreadable — and neither is built."*
**A ProjectManager loop cannot fix that and must not paper over it.** Treating a 2-of-3 collation as
a full review is the precise failure the criterion was filed to make visible, and §11 Q6 is where the
fix belongs.

**Gate 2 — findings.** With full coverage, read `findings[]`:

| Condition | Verdict |
|---|---|
| `findings[]` is empty | **APPROVED** |
| Every finding has `disputed_by` naming at least one lens and `raised_by` naming exactly one | **APPROVED WITH DISSENT** — proceed, and carry the disputed findings into the PR body verbatim. A finding one lens raised and another disputed is not a defect the loop should act on; it is a disagreement a person should read |
| Any finding has `raised_by.length >= 2` | **CHANGES_REQUESTED**, and those findings are the fix brief. Independent agreement across vendors is the strongest signal this console produces (`fleet.yaml:730-735`) |
| Any single-lens finding remains | **CHANGES_REQUESTED**, ranked below the consensus ones |

**The fix brief is built from `findings[]`, not from `review.md`.** Each finding carries `file` and
`line` as required fields, and `file` must be a container path — `/workspace/src/run/relay.ts`, not
`src/run/relay.ts` (`collator.md:313-319`, because *"a relative string is JOINED onto that workdir,
so any string at all lands 'inside' and the check proves nothing"*). The orchestrator rewrites those
paths to repo-relative before partitioning them by file owner (§6.3) and dispatching fixes.

**What this mapping deliberately does not do.** It does not weigh severity, because the collation
carries none. It does not read the collator's `status`, because that is about the collation
(`collator.md:228-235`). And it does not treat `finding_count` as authoritative — the schema records
it beside `findings[]` precisely so a disagreement is visible (`collation.ts:342-345`), and the loop
**reports a mismatch and uses `findings.length`.**

### 7.6 The run state file — new shape for an existing file

```
<repo>/.claude/project-manager-state.json
```

Shape (`pifleet.pmstate/v1`). The existing file (§2.7) is the starting point and the additions are
the ones §6.3 and §6.6 require:

```
srd_path, repo_path, base_branch, baseline_commit
branch_model: "long-lived" | "per-phase"
branch                       the integration branch
total_phases, current_phase, completed_phases[], status
consoles: {development: {launched_from, workspace_id}, review: {…}}
phases[]: {n, slug, name,
           partition: [{worker, task_ids[], files[]}],
           dispatched: [{worker, task_id, run_id}],
           integration: {…}            — or a pointer to §7.2's record
           review: {parent_task_id, collate_task_id, coverage, verdict, iteration}}
answered_questions{}, out_of_band_commits{}, pr_policy
```

**`partition` is the field that makes a resumed run possible**, because it is the one thing §6.6's
table cannot derive from the run tree: which SRD tasks were meant to go where.

**Everything else in this file is a cursor and must be treated as one.** §6.6's rule stands — a
phase listed in `completed_phases` whose artifacts do not exist is a stale file, not a completed
phase, and the run tree wins. **The file is advisory in exactly one direction: it may say a phase was
never started, and it may not say a phase was finished.**

---

## 8. The `/fleet` skill changes

### 8.1 The routing table row and the fleet table

`~/.claude/skills/fleet/SKILL.md`'s **Workflow Routing** table gains one row, placed first because it
is the workflow that owns the others:

```markdown
| **ProjectManager** | "run ProjectManager on <repo> against <SRD>", "implement this SRD with the fleet", "run the SRD through the fleet", "have the fleet build <SRD path>", "project-manage this SRD" | `Workflows/ProjectManager.md` |
```

The **fleet table** changes one row and gains none:

```markdown
| Worker | Role | Console | Toolchain | Notes |
|--------|------|---------|-----------|-------|
| `obs-1` | observer | operations | `base` | read-only cluster/log questions; has cloud access |
| `tick-1` | ticketing | operations | `base` | Rally via `TICKET_*` secrets; egress to `rally1.rallydev.com` |
| `eng-1`, `eng-2` | engineer | development | `node` | hosted model, own git checkout, no egress |
| `tst-1`, `tst-2` | tester | development | `python` | hosted model, own git checkout, egress to the registries |
| `col-1` | collator | review | `base` | writes the fan-out request; does not review |
| `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` | reviewer | review | `base` | three vendors, read-only, `shared-ro` |
```

**`rev-1` leaves the table** (§6.1) and the `review` console's four seats join it — they are absent
today, which is a gap this change closes whether or not the seat rename is taken. The skill's
frontmatter `description` gains `col-1`, `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` and `tst-2` to its
worker list and drops `rev-1`, because that list is what the skill matches on.

### 8.2 `Workflows/ProjectManager.md`

Written in the terse imperative of the existing workflow files. This is the specification of the
file, at the granularity `DispatchTask.md` uses.

---

````markdown
# ProjectManager

Run an SRD through the fleet, phase by phase. Two consoles, one integration branch.

## Before anything else

Re-read the **CARDINAL RULE** in `SKILL.md`, and read this corollary with it.

**The SRD is the brief.** You author the SPLIT — which of the document's tasks go to
which worker — and the acceptance commands. You do NOT author the task text. Copy each
phase task's own words into the envelope. Do not resolve the paths it names, do not look
up the API it references, and do not decide what it "really means". If a task is too
ambiguous to dispatch, ASK — do not research your way to an answer.

A reader holding the SRD and the envelope should be able to find the brief inside the
document.

## Arguments

Two, and the first is not what it looks like.

- **A repository.** This is the LAUNCH DIRECTORY for both consoles, and the launch
  directory BECOMES the run's repository (`SKILL.md`, "Choosing a worker's platform").
  So the repo argument is not a value you pass to anything — it is the directory you
  `cd` to before every console command in this workflow. Both consoles.
- **An SRD path INSIDE that repository.** Resolve it relative to the repo argument, and
  read it from the host. Workers never see it: they see `/workspace`, and the SRD's
  content reaches them only as the `brief` fields you copy out of it.

## Preconditions — check all eight, in order, and stop at the first failure

1. **The repo is a git checkout with a clean tree.**
   `git -C <repo> status --porcelain` is empty. A dirty tree becomes every worker's
   clone baseline and the harvest grades against it.

2. **The SRD exists and has an "Implementation Checklist" with numbered phases.**
   No phases means nothing to dispatch; say so and stop.

3. **The remote is cleared for hosted review.**
   `git -C <repo> remote get-url origin`. If it matches an AppNeta or Broadcom pattern,
   it must equal `run.hosted_repo_consent` in `~/repos/cmux-fleet/fleet.yaml`. If it
   does not, STOP and tell the user — do not launch and let `up` refuse four containers
   in.

4. **The toolchains match the repository's language.**
   `pyproject.toml`/`setup.py` -> python, `go.mod` -> go, `package.json` -> node. The
   engineer seats are `node` and the tester seats are `python`. A mismatch is a
   `fleet.yaml` edit plus `pifleet image build --toolchain <name>`, and it is the user's
   call, not yours.

5. **No console is already open on a DIFFERENT repository.**
   `docker ps --format '{{.Names}}' | grep pifleet` then, for one container per console,
   `docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' <name>`. A console
   pointed elsewhere CANNOT be repointed by `--restart` — the mount is in the pane's
   launch argv. Repointing it is `--recreate`, which downs every run in that workspace.
   **Say so and get the user's word before you do it.**

6. **The review console's relay is alive and serving THIS console.**
   Read `~/.pifleet/review-relay.json`: it carries `pid`, `started`, `run_id` and
   `workers`. A record whose `run_id` names a dead run is a relay polling nothing.
   `./scripts/review` restarts it idempotently; `--relay-stop` stops one.

7. **THE REVIEW TARGET IS READABLE FROM `/workspace`.**
   Reviewer seats are `isolation: shared-ro` — `/workspace` is the operator's checkout
   at whatever ref it currently stands on — and they hold NO `bash`. They cannot run
   `git show`, `git diff`, `git log`, or anything else. **A branch that is not checked
   out in the operator's own checkout is invisible to them.**

   Before dispatching any review, confirm the integration branch is the checked-out ref:

   ```bash
   git -C <repo> rev-parse --abbrev-ref HEAD    # must be the integration branch
   ```

   If it is not, either check it out, or inline the text to be reviewed into the brief.
   Do NOT tell a lens to run a git command. **This precondition exists because it was
   skipped**: a review of this document returned a collation claiming one of three
   lenses reported, when in truth none of the three could read the file at all.

8. **No worker is holding work.**
   `cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json`. Any non-null
   `task_id` or `staged_task_id` — name the worker and what it is doing before you
   touch anything.

## Setup, once per run

```bash
cd <repo>
git checkout <base_branch> && git pull
git checkout -b <integration-branch>        # BEFORE the console; up clones from here
cd <repo> && ~/repos/cmux-fleet/scripts/development
cd <repo> && ~/repos/cmux-fleet/scripts/review
```

Write `.claude/project-manager-state.json` with the partition plan empty and
`current_phase: 0`. Record which directory each console was launched from — you will be
asked, and a console on the wrong repository is silent.

## Per phase

**1. Partition.** Read the phase's tasks. Split them so NO FILE APPEARS IN TWO
PARTITIONS. A task naming a file another partition owns joins that partition even if the
split becomes uneven. If it cannot be made disjoint, DO NOT SPLIT — give it to one
engineer and leave the other idle. Record the partition in the state file before you
dispatch.

**2. Dispatch both engineers, in one message.**

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-1 --task <env-1.json>
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-2 --task <env-2.json>
```

Envelopes go in the scratchpad, not the repo. Four fields plus `acceptance`. `brief` is
the SRD's words. `acceptance` must survive tokenizing — no shell metacharacters, and
`"bun test passes"` is prose that tokenizes to a three-word argv and exits non-zero.
Write the runner and its arguments, or commit a script.

**3. Confirm both started — from `status`, NOT from the dispatch output.** After ~30s,
`status --run <id> --json` per worker. `busy` with growing
`transcript_activity.entries` is working. `idle` with a `staged_task_id` set is staged
and UNTRIGGERED — say so rather than waiting silently.

**This step is not a courtesy check.** These seats are `tui`, so every dispatch is
staged, and `dispatch --json`'s accepted payload carries no `error` field: a staged
envelope whose trigger line was never typed prints `accepted: true`, `via: "staged"` and
exits 0. **The JSON cannot tell you the turn never started. Only `status` can.**

**4. Wait, then harvest.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts wait --task <id> --run <id> --timeout 45m --json
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts --task <id> --run <id> --json
```

Run the waits in the background so the turn is not blocked.

**5. Integrate.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts worktrees --run <id> --json   # branch + commitsAhead
cd <repo> && git fetch worker-eng-1 <branch> && git merge --no-ff FETCH_HEAD
cd <repo> && git fetch worker-eng-2 <branch> && git merge --no-ff FETCH_HEAD
```

`commitsAhead: 0` means that worker committed nothing — check its envelope before
merging nothing and calling it done. On a CONFLICT: `git merge --abort`, then dispatch a
rebase task to the engineer whose branch merged second, naming the conflicting hunks and
the other engineer's commit. **Do not resolve it yourself** — every line you write is a
line no reviewer was told to look at.

Write the integration record. Then repeat steps 2-5 for `tst-1` and `tst-2` — AFTER the
merge, so each tester's clone holds both engineers' work.

**6. Review, in the review console.**

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/review --restart col-1 --task <review-env.json>
```

`task_id` must be short: children are DERIVED by concatenation and REFUSED past 64
characters. `T-rv-p<N>` leaves room. The brief carries the integration branch, its base
ref, the changed-file list and the phase's SRD section — the lenses hold no `bash` and
cannot compute a diff.

**7. Read the collation — from the COLLATE task, not the parent.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts --task T-rv-p<N>-collate --run <col-run> --json
```

The parent settles when the fan-out is ISSUED, so its envelope says nothing about the
review. Read `files/collation.json`.

**Then count `lenses[]` BEFORE reading `findings[]`.** `reported` less than `total` is
`REVIEW_INCOMPLETE` — not approved and not changes-requested. Report which lenses are
missing and which KIND each is: a lens that produced nothing was not applied; a lens
whose report was written and could not be read WAS applied and its review is on disk.
Those are different things to do next. Do not count an incomplete round against
`max_review_iterations`.

With full coverage: findings with `raised_by.length >= 2` are the fix brief. Rewrite
their `/workspace/...` paths to repo-relative, partition them by file owner, and go to
step 2.

**8. PR, CI, merge — all on the host.**

```bash
cd <repo> && git push -u origin <integration-branch>
gh pr create --title "..." --body "..."      # attach review.md; no AI attribution anywhere
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

Workers have no GitHub egress and never will. On a CI failure, partition the failures and
dispatch fixes exactly as in step 7.

## Gotchas

- **The repo argument is the launch directory, and it is silent when wrong.** A console
  launched from `~/repos/cmux-fleet` gives every worker cmux-fleet no matter what your
  briefs say. Measured three times on this fleet. Confirm with
  `docker exec -u 10001 <container> ls /workspace` before dispatching a phase.
- **A console already open on another repository cannot be repointed.** `--restart`
  keeps the pane's mounts, and the mount is in its launch argv. Only `--recreate` moves
  it, and that downs every run in the workspace. Get the user's word.
- **The integration branch must exist BEFORE the console comes up.** `up` clones from
  the checkout as it stands. A branch created afterwards is in no worker's clone, and
  every worker will have branched from the wrong base.
- **`--task` refuses having stopped nothing.** If a worker will not settle in 20
  minutes the command refuses and the fleet is exactly as it was found. That is the safe
  outcome. Do not reach for a bare `--restart` to get around it — that one is
  destructive and needs the user's word.
- **A lens cannot run git. It has no shell.** Reviewer seats are `shared-ro` with
  `[read, write, grep, find, ls]`, so `/workspace` is the operator's checkout at
  whatever ref it is on and nothing can move it. A brief saying "run `git show X`" gets
  you a `blocked` from a careful lens and an invented review from an incautious one —
  **and the incautious one is counted as having reported.** Check the branch out first,
  or inline the text. Measured: a review of this SRD came back "1 of 3 reported" when
  the true figure was 0 of 3.
- **`accepted: true` does not mean the worker woke up.** Every development and review
  seat is `tui`, so every dispatch is staged, and the accepted JSON payload has no
  `error` field even though the underlying result does. Confirm from `status`.
- **Read the collate task, not the review request.** The parent settles as soon as the
  fan-out is issued, and it claims `success` for having written a request. A loop that
  reads it will approve a review that has not happened.
- **Count coverage from the run tree, not from the collation.** `lenses[]` and the
  census counts derived from it are written by the collator. The host's own numbers are
  the journal's `children[]` at `<run>/relay/<sender>/<parent>.json` and the reply files
  that exist beside it. Nothing caps a collator claiming `success` over a partial
  fan-out, and a `partial` collation gets no structural check at all.
- **The token ceiling in `fleet.yaml` does not bound this loop.** Budget admission is
  reached only from `dispatch --auto`, which cannot target these seats. Two engineers
  generating at once are bounded by the inference server and nothing else. Count your
  own spend.
- **A 2-of-3 collation is a valid document.** It parses, the collator's verdict is
  `success`, and one `lenses[]` row says `reported: false`. Nothing goes red. Count the
  rows.
- **The collator's status is about its collation, never about coverage.** A collation
  that faithfully reports two reviews is `success`. It is not a two-thirds review that
  passed.
- **A lens lost to a failed harvest does not come back.** The fan-out is journalled
  after dispatch, so a re-issued pass finds it done. The review is on disk and missing
  from the document — say so, and do not re-run the whole round hoping.
- **`commitsAhead: 0` on a worker that reported `success` is a contradiction worth
  stopping on.** Either it did the work in the wrong place or its envelope is not about
  this task. Read the transcript.
- **An engineer cannot `bun install`.** The role has no `egress_access`, so a fresh
  clone's dependency install hangs against the deny-all policy until the tool timeout —
  it does not fail, it sits at ~1.6% CPU with nothing written. Testers can. Put the
  install in the tester's brief, or say so and ask.
- **Acceptance commands run in a fresh clone at the BASE revision.** A command that
  depends on a file the worker just wrote will not resolve. That is deliberate.
- **Never put AI, LLM, "generated with" or a `Co-Authored-By` line in a commit message,
  a PR body, or a code comment.** Flag it as a defect if you see one in a worker's
  output.
````

---

### 8.3 How this coexists with the cardinal rule

§4.1 is the argument. In the workflow file it appears twice on purpose — once at the top as the
corollary above, and once in step 1 as the partition rule — because the failure it prevents happens
at a specific moment: the moment the orchestrator reads a phase task and thinks it could say it
better. **The rule's operational form is that the brief must be findable in the SRD by string
search.** That is checkable, and §13's checklist makes it a criterion.

---

## 9. Failure modes, recovery, and what this costs

**Nothing below invents a taxonomy.** Every failure named here is an existing typed refusal, an
existing error class, or an existing `RelayOutcome` arm. Where a failure has no existing name, that
is said rather than covered over.

### 9.1 A worker stalls or does not settle

**Detection:** `phase: busy` with `transcript_activity.entries` not growing and `last_growth_at`
minutes old (`Workflows/Observe.md:15-18`). `phase` alone does not say it.

**What the fleet already does.** `event_stall_warn: 3m` and `event_stall_kill: 25m`
(`fleet.yaml:90-91`) bound it, and `per_task_timeout: 25m` bounds the task. **These are the run's
own clocks and the orchestrator does not race them** — it waits on `pifleet wait --timeout` and
lets the supervisor settle the worker.

**What the loop does.** A worker that settles `timed_out` or `aborted` has an envelope-free task.
Re-dispatch is available and is **not automatic**: a stall that repeats is a brief the worker cannot
act on, and re-issuing it burns the budget twice. The orchestrator reports the stall, names the
partition that produced it, and asks. **One measured caution belongs here**: `wait` *"has reported
`success` on tasks that never started"* (`Workflows/DispatchTask.md:118-120`), so when `wait` and
`artifacts` disagree the transcript decides.

**The one stall this design adds.** A phase where both engineers are `busy` with `commitsAhead: 0`
after the warn threshold is a stall the fleet does not see, because generating tokens is activity.
§6.9 makes it visible; nothing kills it.

### 9.2 An engineer's harvest fails, or its dispatch never landed

**Two different failures that look identical from the state file, and telling them apart is the
whole of the recovery.**

| | Name | What it means | Recovery |
|---|---|---|---|
| **Dispatch did not land** | `dispatchProblem` (`fresh-dispatch.ts:299-318`), three arms: empty stdout, unparseable stdout, `accepted: false` | The envelope was refused by the validator, or the supervisor refused it on a stale epoch. **The worker is up and holding nothing.** | Fix the envelope and re-run the same `--restart … --task`. Nothing was consumed. **This is only true with PR #147** — before `fb38fc8` the console printed *"recreated and dispatched"* and exited 0 |
| **Harvest failed** | `RelayHarvestError(worker, taskId, outbox, detail)` on the review path; on the development path a task with no readable `result.json` | The worker ran and its envelope could not be read. **Its commits are still on its branch.** | §6.2's fetch does not need the envelope. `pifleet worktrees --json` gives `commitsAhead`; if it is non-zero, **merge the branch and treat the missing envelope as a reporting failure, not a work failure** |

**That second row is the recovery this design gets for free from `isolation: worktree`, and it is
worth stating as a property**: a development-console worker's output is a git branch, and a branch
survives an envelope that does not. The review console has no equivalent — a lens's output *is* its
envelope and its artifact — which is exactly why ISC-517 is about lenses and not about engineers.

**`pifleet harvest` can rebuild a verdict from the transcript when the envelope never landed**
(`Workflows/Observe.md:41-42`). Use it before concluding a worker produced nothing.

### 9.3 The review round does not produce a collation

`relayFanOut` returns one of five arms (`relay.ts:742-838`), and three of them mean no collation:

| Arm | Meaning | The loop's action |
|---|---|---|
| `refused` / `run_unresolved` | A seat's run could not be resolved. **Nothing was dispatched** — `relay.ts:938-939`: *"issuing the other lenses first would leave reviews running that no join is waiting on"* | The review console is not healthy. Check `status --all`, restart the seat, re-dispatch. Nothing was consumed |
| `refused` / `underivable_id` | A child id would exceed 64 characters | §7.3 — the parent id is too long. Shorten it and re-dispatch. **§10 D6 is the fix that prevents it** |
| `none_landed` | Lenses were asked for and not one dispatch landed | Split out of `not_collated` deliberately, *"because the shared one was journalled"* (`relay.ts:746-749`). Re-dispatchable |
| `not_collated` | Some lenses landed, **none survived** to be harvested | No replies were published and no collation was dispatched. The reviews, if any, are on disk. **Report and stop the phase** |
| `collation_failed` | Children were journalled and the collation dispatch threw | **The children are journalled, so a retry re-issues nothing.** The reviews exist as replies and no collator turn two was dispatched. Recovering means dispatching the collation by hand |

> **One retry semantic is genuinely unsettled and this table takes the conservative arm.**
> `relay.ts:2438-2451` treats a deferred stage trigger as re-stageable on a later pass — a replay —
> while this repository's own triage holds that a journalled fan-out plus `already_done` means the
> retry never happens. **This document did not probe which is true**, and the rows above assume the
> pessimistic reading: that nothing is re-issued. **§11 Q11 holds it, and no recovery path here
> should be built on the optimistic reading until it is settled.**

**And the request itself can be refused before any of that.** `DispatchRefusal` has twelve codes
(`dispatch-request.ts:669-681`); the four a ProjectManager run can actually provoke are
`parent_task_mismatch` (the request's `parent_task_id` does not match the directory it was written
into), `worker_not_in_console`, `duplicate_target` and `collation_parent` (a fan-out attempted from a
collation turn — the depth bound, §2.5). All twelve are the collator's mistakes, not the
orchestrator's, and all twelve name the field.

### 9.4 A lens is lost and the collation is partial

**This is ISC-517 and it is the failure this design most needs to not paper over.**

The relay counts coverage itself — `RelayOutcome.coverage` is `{reported, dispatched}`, *"Counted
here rather than asked of the model, because the host is the only party that knows it"*
(`relay.ts:791-804`) — and the collation brief names each missing lens with its reason. **Two
reasons wear that label and they call for different actions**, and `roles/collator.md:237-247` is
explicit that conflating them is *"the specific falsehood this instruction exists to stop"*:

| `MISSING ASPECT` reason | What happened | What to do |
|---|---|---|
| *"it settled `unknown` and produced no report — no result envelope exists for it"* | **The lens was not applied.** | The angle is genuinely uncovered. Re-dispatching that one lens against the same branch is available and is a NEW parent id, because the old fan-out is journalled |
| *"its report WAS WRITTEN AND COULD NOT BE READ: `<path>` is N bytes and did not parse"* | **The lens WAS applied.** A review exists on disk | ISC-522 put the path in the brief for exactly this. **Read it.** A human can recover the review; the collation cannot |

**The loop's rule, from §7.5: `REVIEW_INCOMPLETE`.** Not approved, not changes-requested, and not
counted against `max_review_iterations` — because the round did not fail on the code's merits and
charging it to the iteration budget would spend the operator's remaining rounds on a transport
defect.

**What this design cannot do, said plainly.** It cannot bring the lens back into that collation.
ISA.md's ISC-517 states the close condition — *"a re-harvest before the journal, or a collation
deferred until every dispatched lens has been read or declared unreadable"* — and both are unbuilt.
§11 Q6 is where that belongs, and it is not this document's to build.

### 9.5 The review loop exceeds `max_review_iterations`, or CI fails

**Review deadlock.** `max_review_iterations` defaults to 3 (`ProjectManager/SKILL.md:277`). On the
third CHANGES_REQUESTED the loop **stops and reports**, and it reports three specific things rather
than "review failed": the findings that survived every round with their `raised_by` sets, the
findings that appeared only in the last round (which are usually the fix's own defects), and the
per-round coverage. **A round that ended `REVIEW_INCOMPLETE` is excluded from the count** (§9.4).

**Why not more rounds.** Each round is four hosted seats reading the whole change. Three rounds that
did not converge is evidence about the phase, not about the reviewers, and the honest action is to
hand it to a person.

**CI failure.** Host-side, and it is the one stage where the fleet has no seat: `gh pr checks
--watch` runs on the host and the failure log is a host artifact. The loop partitions the failing
checks by the files they implicate and dispatches fixes exactly as §6.3 partitions a phase. Three CI
fixes without a green run is the same stop as a review deadlock. **The tester seats are the right
target for a CI fix that is a failing test, and the engineer seats for one that is a failing
build** — which is the one place the toolchain asymmetry of §6.8 helps rather than hurts.

**Merge conflict.** §6.2. It is not a failure of the fleet; it is evidence the partition overlapped,
and §6.3 step 2 is what should have prevented it.

### 9.6 What is unchanged

The nine control verbs and their single-principal auth model. The three socket gates. The mount
table's exclusions and `assertNoRunDirMount`. `isolation: worktree` and the clone-not-worktree
decision. The relay's journal-after-dispatch ordering and its `(sender, task-id)` key. The
collation schema and its three forbidden fields. `hosted_repo_consent`. The verdict lattice and
*"Self-report may downgrade, never upgrade"*. **This design adds no new capability to any container
and removes none.**

### 9.7 What is added, in both directions

| | Cost |
|---|---|
| **A seat change** | `rev-1` → `tst-2`. Ten functional locations across two config files, a plan constant, a script and five test files, plus an image build — v0.1 costed this at "two pins" and was wrong (§0.6 Finding D). **Still cheap, and it blocks the console coming up correctly** |
| **A privilege widening** | The `development` console gains a fourth shell-capable seat and a second egress seat, and loses its only seat that could not run a shell. Argued in §6.1.1, recorded in §4.3 as per-worker isolation's second cost |
| **A lost feedback edge** | No reviewer reads a task before it is merged onto the integration branch. §6.1.2 accepts it on the grounds that the merge is local and unpublished until the review passes |
| **An unbounded spend** | Budget admission is reachable only from `dispatch --auto`, which this loop cannot use, so `tokens_ceiling` bounds nothing here. **The orchestrator is the only thing counting.** §6.11 |
| **A host-side integration step** | Four git commands per phase, on the operator's own repository, performed by a Claude Code session. **It is the first time this system writes to the operator's branch as part of an automated loop**, and the mitigation is that it only ever merges — it never authors |
| **A second console in the loop** | Four more hosted seats per phase, billed, on a vendor rate limit. §11 Q7 |
| **A state file with a partition in it** | One more thing that can be stale. §7.6 bounds it to advisory-in-one-direction, which is the smallest useful guarantee |
| **A workflow that authors briefs** | The `/fleet` cardinal rule's first real exception, argued in §4.1 and bounded by the string-search test in §8.3. **This is the largest unresolved conceptual cost in the document** — the bound is a convention, not a mechanism, and nothing enforces it |
| **Dependence on an unmerged PR** | §0.7. Three behaviours this design reads as present are in #147 |

### 9.8 What this cannot see, and must not imply it can

- **Whether a reviewer read anything.** §3.4. The consensus arithmetic detects disagreement, not
  effort, and a 3/3 finding across three vendors is the strongest signal available — not proof.
- **Whether an engineer's commits implement the task.** The harvest grades a claim against a diff.
  It cannot grade a diff against an intention, and the review round is the only thing that tries.
- **Whether a partition was correct.** An overlap surfaces as a conflict; a *gap* — a task nobody
  was given — surfaces as nothing at all. §11 Q5.
- **Whether the SRD's phases are well-formed.** A phase whose tasks name no files cannot be
  partitioned by §6.3's rule, and the workflow will serialise it onto one engineer rather than
  refusing. That is the safe direction and it is silent.

---

## 10. Recorded decisions

Each states what was chosen, what was rejected, and what it costs. **Four are put to the owner as
genuinely open: D2, D4, D8 and D9.** The rest are recorded so a later reader does not re-litigate
them.

| # | Decision | Specified in |
|---|---|---|
| **D1** | The orchestrator is the calling Claude Code session, not a fleet worker and not a new console | §0.2, §4.2, §5.2 |
| **D2** | **OPEN** — one long-lived integration branch and one PR at the end, not a branch and a PR per phase | §2.7, below |
| **D3** | The host is the integrator, over the `worker-<id>` remotes `up` already creates. Rejected: an integrator seat; rejected: a shared branch | §6.2, §4.3 |
| **D4** | **OPEN** — a phase is partitioned by file ownership, and an unpartitionable phase is serialised rather than split | §6.3, below |
| **D5** | The review round is the `review` console's collator fan-out, consumed unchanged. No second review mechanism | §6.5, §5.2 |
| **D6** | Review parent task ids use the grammar `T-rv-p<N>` (and `T-rv-p<N>-r<K>` for round K), so every derived child fits inside 64 characters | §7.3, §9.3 |
| **D7** | The loop's verdict is derived from `collation.json`'s contents through two independent gates, coverage first | §7.5 |
| **D8** | **OPEN** — a partial collation is `REVIEW_INCOMPLETE`, which neither approves nor counts against the iteration budget | §7.5, §9.4, below |
| **D9** | **OPEN** — where the container's git identity comes from | §6.8, below |
| **D10** | `rev-1` becomes `tst-2`; `roles/reviewer.md` and the `reviewer` role stay, because the three lenses are that role | §6.1, §0.5 |
| **D11** | No worker gets GitHub egress. Every `gh` verb stays on the host | §6.7, §5.2 |
| **D12** | The run tree is authoritative; the state file is advisory in one direction only | §6.6, §7.6 |
| **D13** | **Closed in v0.2 — was Q10.** Worker git identity: brief-supplied repository-local config as the interim, a `GIT_CONFIG_*` channel in `worker-env.ts` as the durable answer | §6.8 |
| **D14** | The loop is written against a staged dispatch plane: pinned tasks, no `depends_on`, no `--auto`, and acceptance confirmed from `status` rather than from `dispatch --json` | §6.10 |
| **D15** | The seat change is accepted as a privilege widening — three shell seats become four, one egress seat becomes two — and the in-loop per-task reviewer is given up with it | §6.1.1, §6.1.2, §4.3 |

### The eight that need no argument

**D1 — the orchestrator stays outside.** §4.2 is the whole argument and it does not need restating.
**The cost is that the orchestrator is the one component with no supervision story**: `pifleet relay`
restarts idempotently and a Claude Code session does not. §6.6 answers it by making the run tree
authoritative, which is the same answer the relay gives, reached without the relay's durability.

**D3 — the host integrates.** Rejected: an integrator seat, which would need sibling clones mounted
(`assertNoRunDirMount` refuses) or the operator's repository mounted read-write (the mount
`isolation: worktree` exists to avoid). **The cost is that integration happens in a session that can
be interrupted mid-merge**, leaving a repository with a merge in progress. §7.2's record is written
after each merge so a resumed run can tell which ones landed, and `git merge --abort` is the
operator's remedy for the one in flight.

**D5 — one review mechanism.** **The cost is a phase's wall time**: the review round is a second
console, two collator turns and three hosted models, where `rev-1` was one dispatch. What it buys is
that the review's coverage is a number the host counted rather than a claim a model made.

**D6 — a short id grammar.** Rejected: deriving the parent id from the phase slug, which reads
better and is unbounded. `childTaskId` **refuses** past 64 characters rather than truncating
(`task-ids.ts:151-158`), so a long slug turns a review into a `refused`/`underivable_id` at
dispatch. **The cost is legibility**: `T-rv-p3-r2` says less than `T-review-phase-3-relay-actor-r2`,
and the state file carries the mapping.

**D11 — no GitHub in a container.** §6.7. **The cost is that the review console cannot fetch a PR**,
so the review's subject is a branch and a changed-file list the host supplies (§7.3).

**D12 — the run tree wins.** Rejected: trusting `completed_phases`. **The cost is a slower resume**
— every intended task id is `artifacts`-checked before the run advances — and that cost is the
point: the state file is written by the least durable component in the system.

**D7 — two gates, coverage first.** Rejected: a single gate over `findings[]`, which is what a
reader expects and what §7.5 would be if ISC-517 were closed. Coverage runs first because a
findings-only gate reads an empty `findings[]` as APPROVED whether it came from three clean reviews
or from one review and two lost lenses. **The cost is a third verdict state** — `REVIEW_INCOMPLETE`
— which the loop cannot resolve on its own, and D8 is where that is argued rather than assumed.

**D10 — `rev-1` becomes `tst-2`, and the `reviewer` role stays.** Rejected: retiring
`roles/reviewer.md` along with the seat, which §0.5 correction 1 refutes — all three lenses are
`role: reviewer` and the discipline lives there once by deliberate design. **The cost is a
`fleet.yaml` role whose `model:` and `thinking:` defaults now reach no worker**, which is dead
config and reads as an oversight to the next person. §11 Q8 is whether to remove them; either way
the comment naming `rev-1` must be corrected, because a comment nothing checks will be edited away.

### D2 — one branch, one PR

**OPEN. Recommended: yes, and the recommendation is the practice rather than the design.**
**Rejected: the skill's `phase-{N}-{slug}` branch and a PR per phase.**

`.claude/project-manager-state.json` (§2.7) records a real run that chose `branch_model:
"long-lived"` and `pr_policy: "Do NOT open a PR. Ask the owner when all phases are complete."` **The
argument for it is mechanical rather than stylistic:** a per-phase branch means a per-phase `up`,
because `up` clones from the checkout as it stands and workers cannot switch branches
(`worktree.ts` derives the branch and the clone is made once). So a branch per phase is a console
teardown and rebuild per phase — eight containers, a fresh image pull path, and every seat's session
lost — for a branch boundary that buys nothing the integration record does not already carry.

**What the rejected arm would have bought is real and should be said**: a PR per phase is a review
surface a person can read incrementally, and CI runs per phase rather than once at the end. Under
the recommendation, CI failures all arrive together at step 11 of the last phase, which is the worst
time to find them. **The mitigation is that the review round runs per phase regardless** —
`review_at_end_of_each_phase: true` — so the code is read incrementally even though it is not
merged incrementally.

**The cost, stated: an integration branch that lives for eight phases is an integration branch that
can diverge from `main` for eight phases.** Nothing in this design rebases it, and §11 Q2 asks
whether it should.

### D4 — partition by file, and serialise what will not split

**OPEN. Recommended: yes. Rejected: splitting a phase's task list in half by count.**

§6.3 is the argument: an overlap that is free in one checkout is a merge conflict in two, and the
current skill's *"first half / second half"* has no notion of what a half touches.

**What the rejected arm would have bought is throughput.** Every phase uses both engineers under a
count split; under a file split some phases use one. **This document accepts idle seats over merge
conflicts**, on the grounds that an idle engineer costs a phase's latency and a conflicted merge
costs a phase's latency *plus* a fix dispatch *plus* the risk of a bad resolution.

**What would change the recommendation, and it is measurable.** If a run shows that file-disjoint
partitions are rare enough that most phases serialise anyway, the split is buying nothing and the
right answer is one engineer and one tester with the second seats used for fixes and CI. **Nothing
has measured it.** §11 Q5.

### D8 — a partial collation is neither approved nor rejected

**OPEN. Recommended: yes. Rejected: treating a 2-of-3 collation as a review that passed; rejected:
treating it as CHANGES_REQUESTED.**

**Rejecting the first arm is not a close call** — it is the exact failure ISC-517 was filed to make
visible, and §7.5's coverage gate exists for it. **Rejecting the second is the part worth arguing.**
Counting a lost lens as CHANGES_REQUESTED would be "safe" in the sense that it never approves
something unreviewed. It is wrong because it charges a transport defect to the phase's iteration
budget: three rounds lost to a harvest failure and the loop stops on a review deadlock that never
happened, and the operator is told the code could not pass review when the review could not be read.

**The cost is that `REVIEW_INCOMPLETE` is a third state the loop has to handle and a human has to
resolve.** It stops the phase. That is the intended behaviour and it should be uncomfortable —
ISC-517 is `[~]` precisely because the loss is permanent within that collation, and a loop that
carried on would be the mechanism by which a `[~]` criterion silently stops mattering.

### D9 — where a container's git identity comes from

**CLOSED IN v0.2 as D13. v0.1 left this open on the reasoning below, which the review round showed
was answering the wrong question.**

v0.1 framed it as an owner preference between a `run.commit_identity` in `fleet.yaml` and a per-task
identity in the envelope, on the grounds that `CLAUDE.md` records three distinct git identities for
three remote families. **That framing assumed a worker could commit at all.** A probe against the
real image shows it cannot — exit 128, *"unable to auto-detect email address"* — and that the clone
is writable enough for a worker to invent one instead (§6.8). So the question was never "which
configured value" but "is there any value, and what happens when there is not".

**D13 is the answer: brief-supplied repository-local config as the interim, a `GIT_CONFIG_*` channel
as the durable fix.** The per-repository-identity question v0.1 raised is real and survives into the
durable arm's design — the channel's value is per run, and a run's launch directory already
determines its repository — but it is a detail of arm 2, not a blocker.

**What is NOT open, and was not in v0.1 either:** the identity must not be the operator's own, and no
commit, comment or PR body carries an AI or assistant attribution line. Both are constraints on
either arm, and §12's criterion now asserts the author's exact value because an invented identity is
the measured failure mode.

**The cost of leaving it open: nothing can be dispatched until it is answered.** A worker with no
configured identity either refuses to commit or invents one from its uid and hostname, and **this
document did not probe which** — the container runs as uid 10001 (`render.ts:309`), and whether git
can auto-detect an address for it depends on the image's `/etc/passwd` and on `user.useConfigOnly`.
**Both outcomes are failures and the second is the worse one**: a refusal stops a phase visibly,
while an invented identity lands on every commit and reaches the operator's branch through §6.2's
merge. **v0.1 held this open as a BLOCKING question; v0.2 closes it as D13** (§6.8), because the
probe settled which of the two happens and both arms of the fix were already available in the tree.

---

## 11. Open questions

**v0.2 status: Q1 withdrawn, Q10 answered and promoted to D13, Q11 and Q12 added by the review
round.** Q11 blocks one mechanism and nothing else. Where a section depends on a question, it says
so.

**Two of v0.1's questions are closed in v0.2 and are kept as rows so a reader is not left looking for
them.** **Q1 (does #147 land first) is WITHDRAWN** — it merged as `d70acf4`, §0.7. **Q10 (the git
identity) is ANSWERED and promoted to D13** — the review round showed it was decidable from the code,
and a probe against the real image settled the symptom (§6.8). **No question blocks the design's
shape any more. Q11 is the only one that blocks work, and it blocks one narrow mechanism.**

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q11** | **BLOCKING for anything built on relay retry semantics.** `relay.ts:2438-2451` treats a deferred stage trigger as re-stageable on a later pass — a REPLAY — while this repository's own triage holds that a journalled fan-out plus an `already_done` verdict means the retry never happens. **One of the two is wrong and this document did not settle it.** §9.3's `collation_failed` row and §6.5's step 4 both sit next to it | A run where a stage trigger is forced to defer, followed by a second relay pass, observing whether the child is re-dispatched or reported done. **Until that is taken, build on neither reading** | Any recovery path that assumes a second relay pass will re-issue a deferred lens. §9.3 currently assumes it will NOT, which is the conservative arm |
| **Q12** | Should the review round be driven by the calling session at all, or is it a human step? §6.5's step table shows only steps 1-2 and 8 are the session's; steps 3-7 are the collator and the relay, there is no "wait for the review" verb, and a session polling for the collate artifact has no timeout of its own | Run three review rounds and record how often the session's poll ends in something other than a collation. **If the answer is "never", the automation is fine; if it is "sometimes", the failure is silent and expensive** | Nothing structurally. It decides whether §8.2's step 6-7 is a loop or an instruction to the operator |
| **Q2** | Should the long-lived integration branch be rebased onto `base_branch` between phases? D2 accepts one branch for the whole run, which means it can diverge for eight phases. A rebase between phases would keep it current and would invalidate every worker's clone base | Run two phases with a deliberate upstream commit between them and measure whether the phase-2 merge conflicts. **Cheap, and it decides whether D2 needs a step 0 per phase** | **Nothing structurally.** It adds a step to §6.4 or it does not |
| **Q3** | What does a ProjectManager run do when the calling session is compacted or lost mid-phase? §6.6 makes recovery derivable and §7.6 makes the partition recoverable, but nothing *restarts* the orchestrator the way `./scripts/review` restarts the relay | Kill a session mid-phase with two engineers running, then resume from the state file and confirm §6.6's five-step recovery reaches the same integration branch. **This is the honest test of D1's cost** | **Nothing in the design.** It bounds how much of a phase an interruption costs |
| **Q4** | Should `engineer` gain `egress_access: true`, or is dependency installation the tester's job? §2.6 — a fresh clone has no `node_modules`, `bun install` hangs against the deny-all policy rather than failing, and `engineer` has no route to the proxy while `tester` does | Dispatch an engineer a task in a repository whose tests need an install, and observe. **The measured symptom is already recorded** (`fleet.yaml:295-299`): 1.6% CPU, 34.9kB of network, 0B written, until the tool timeout | **Nothing structurally**, and it decides whether an engineer can run the suite it was told to keep green |
| **Q5** | Is file-disjoint partitioning worth its idle seats, and should an overlap be detected before the merge? §6.3, D4. A post-hoc check comparing the two workers' `files_changed` arrays would catch an overlap one step earlier than git — after the tokens are spent, before the merge | Run five phases and record: how many partitioned disjointly, how many serialised, how many conflicted anyway. **Under ten phases this is a measurement, not a study** | **Nothing.** D4 is recorded as recommended-and-unmeasured, which is what this row exists to say |
| **Q6** | How is ISC-517 closed — a re-harvest before the journal, or a collation deferred until every dispatched lens has been read or declared unreadable? ISA.md names both and neither is built. §7.5's coverage gate makes the loss visible; it does not recover the lens | **Not this document's to probe.** It belongs to the review console's SRD and to whoever takes ISC-517. Recorded here because a ProjectManager run is the first consumer that will hit it repeatedly rather than occasionally | **Nothing in this design** — §9.4 handles the failure. It bounds how often `REVIEW_INCOMPLETE` fires |
| **Q7** | Do both consoles stay up for the whole run, or is the review console brought up per phase? §1.3, §6.4. Eight hosted seats standing idle between phases is a rate limit and a bill; bringing the review console up per phase is a `--recreate` per phase, and §0.5 correction 2 is why that is not free | Measure the idle cost of four review seats over one phase's engineer-and-tester time. **If the seats generate nothing while idle the question answers itself**; the vendor's billing model decides it | **Nothing structurally.** It is an operating decision recorded so it is made rather than defaulted |
| **Q8** | With `rev-1` gone, the `reviewer` role's `model:` and `thinking:` reach no worker — every lens overrides `model:`. Remove them, or keep them as the documented default a fourth lens would inherit? §6.1, §0.5 correction 1 | **Not a probe — a config-hygiene decision.** What must happen either way is that `fleet.yaml:551-554`'s comment, which names `rev-1` as the worker the default reaches, is corrected | **Nothing.** A stale comment is the whole exposure, and this document already names it |
| **Q9** | Is the language heuristic in §6.8 good enough? `pyproject.toml` → python, `go.mod` → go, `package.json` → node, two of them → ask. A repository with a `package.json` for tooling and a `pyproject.toml` for the product is the common case it gets wrong | Run it over the operator's own repositories and count. **Cheap and worth doing before the workflow ships**, because the failure is a worker that reads code it cannot run and reports `blocked` — correct, and a wasted phase | **Nothing structurally.** `toolchain: full` is the escape hatch, at the cost of image size |

---

## 12. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria,
each phrased so the probe is obvious, because a criterion whose verification is unclear is one that
will be graded `[~]` forever.

**`ISC-523` is the highest id in use on `feature/harvest-recovery` as of 2026-09-05 — on `main` it
is `ISC-521`, because ISC-522 and ISC-523 are in PR #147 — so this block starts at `ISC-524` and
assumes Q1 is answered "merge first".** No ids are allocated here: `ISA.md` owns that numbering, and
two criteria sharing a number is a worse outcome than a list that needs ids assigned on adoption.
**Q10 will add a criterion that cannot be phrased until it is answered** (the identity's source is
the subject of the assertion), and reserving for it is the right shape.

**Two existing criteria are made stale by §0.6, independently of whether this design is built. Take
these first.**

| ISC | What it says | What this work does to it |
|---|---|---|
| **ISC-517** | `[~]` — a lens that wrote a valid report is never lost. Quarantined by ISC-522 and still not shut: *"a fan-out that collates is journalled, so the lens is absent from that collation permanently and no later pass brings it back."* | **Not falsified, and about to matter far more often.** A ProjectManager run fans out once per phase per round rather than once when a person asks, so the exposure is multiplied by the phase count. §7.5's coverage gate is a CONSUMER of the criterion's openness, not a closure of it, and the criterion should record that a second reader now depends on it |
| **ISC-400** | `[x]` — a second standing console exists, `development`, four equal panes, four attended workers. Its closing evidence names the roster `eng-1`/`eng-2`/`tst-1`/`rev-1` and its live verification screenshot shows those four titles. | **Unchanged in force and stale in its evidence.** §6.1 changes the fourth seat. The criterion is about the console's *shape*, which is unaffected, but its recorded proof names a worker that will not exist. It should gain a note rather than be reopened |

**Criteria that must be re-read before any of them is claimed to still hold:** **ISC-349** (`[~]` —
the worker binds `<task-id>`; `PIFLEET_TASK_ID` *"is SET NOWHERE IN PRODUCTION"*, and a misnamed
outbox directory makes the whole outbox invisible, which under §9.2 is a phase's work lost),
**ISC-514** (coverage and verdict are separate axes — §7.5 is the first consumer that branches on
both), **ISC-513** (an unconsumed dispatch request is visible with its age — §6.9 reads it),
**ISC-93 / ISC-151** (the empty-diff check and its `facts.repository` gate — a tester that runs a
suite and changes nothing is exactly the no-diff shape), **ISC-522 / ISC-523** (both in #147; §7.5
and §9.4 read what they produce), **ISC-432 / ISC-444 / ISC-377** (all `[~]`, all about `tui`
workers, and every seat in both consoles is `tui`).

Proposed new criteria, by area:

**The seat model (D10)**
- The `development` console's roster is `eng-1`, `eng-2`, `tst-1`, `tst-2`, and no worker in it
  holds `role: reviewer`. *Probe: assert `DEFAULT_DEVELOPMENT_WORKERS` and assert the resolved role
  of each; a `reviewer` in this console fails.*
- `roles/reviewer.md` still reaches three workers. *Probe: resolve each `review` console worker and
  assert its `append_system_prompt_file` chain contains both the role file and the lens file. **This
  is what stops a future edit retiring the role on the reasoning §0.5 correction 1 refutes.***
- **Anti: no seat in either console shares a theme with another attended worker.** *Probe: the
  existing `config.test.ts` uniqueness grade, re-run over the changed roster — it must still name the
  offending pair on failure, so mutate one theme and assert the message.*

**Integration (D3)**
- Every worker's clone is reachable from the operator's repository by its recorded remote. *Probe:
  after `up`, `git -C <repo> ls-remote worker-<id>` resolves the branch `pifleet worktrees --json`
  reports, for every worker. **This asserts Finding A's mechanism rather than citing its docblock.***
- An engineer's commits reach the integration branch without its result envelope. *Probe: harvest a
  task whose `result.json` is deleted before harvest, then fetch and merge its branch and assert the
  commits are ancestors of the integration branch. This is §9.2's recovery, asserted.*
- **Anti: the integration step never authors a commit.** *Probe: every commit on the integration
  branch is either a merge commit or has a worker branch as an ancestor; a commit authored directly
  onto it fails. This is D3's cost bounded as a property.*

**Decomposition (D4)**
- A phase whose tasks cannot be partitioned disjointly is dispatched to one engineer. *Probe: a
  fixture phase whose every task names one file produces a one-worker partition, not two.*
- **Anti: a brief is not the orchestrator's prose.** *Probe: every dispatched `brief` appears as a
  substring of the SRD file the run names. §8.3 — this is the cardinal rule made checkable, and it
  is the only mechanism this document has for it.*

**The review round (D5, D7, D8)**
- The loop reads the collation from the `-collate` task, never from the fan-out parent. *Probe: a
  fixture where the parent settles `success` and no collation exists; the loop must not report
  APPROVED. **This is the criterion that would catch the most expensive misreading in the design.***
- A collation with `reported < total` yields `REVIEW_INCOMPLETE`. *Probe: a fixture collation with
  one `reported: false` row and an empty `findings[]`; assert the verdict is neither APPROVED nor
  CHANGES_REQUESTED, and assert the round does not increment the iteration counter.*
- The two kinds of missing lens are reported differently. *Probe: two fixtures — one whose
  `MISSING ASPECT` line says no envelope exists, one whose line names a written-but-unreadable
  envelope and its path — and assert the loop's report names the path in the second and not the
  first. §9.4.*
- Consensus findings drive the fix brief. *Probe: a fixture collation with one 2-of-3 finding and
  one single-lens finding; assert both reach the fix brief and the consensus one is ranked first.*
- **Anti: the loop never reads the collator's `status` as the review's verdict.** *Probe: a fixture
  whose collation is well-formed with zero findings and whose collator envelope claims `partial`;
  assert APPROVED. `roles/collator.md:228-235` is the reason.*

**Ids and refusals (D6)**
- Every review parent id derives four children inside 64 characters. *Probe: for phases 1..99,
  `childTaskId(parentFor(n), aspect)` succeeds for every aspect and for `collate`. **This asserts
  the grammar rather than the current phase count.***
- **Anti: a refused dispatch is never reported as a landed one.** *Probe: wire the dispatch dep to a
  runner that returns empty, and assert the workflow reports a failure. This is `fb38fc8`'s property
  re-asserted at the workflow layer, and it is the one #147 dependency worth grading twice.*

**Coverage is the host's count (v0.2, §7.5)**
- The loop's coverage numbers come from the run tree, never from the collation. *Probe: a fixture in
  which `collation.json` claims three lenses reported while the run tree holds a journal with three
  `children[]` and only two reply files; assert the verdict is `REVIEW_INCOMPLETE`. **A gate reading
  `lenses[]` passes this fixture and is exactly the defect being pinned.***
- **Anti: a collator's `lenses[]` disagreeing with the journal is reported, not silently preferred.**
  *Probe: the same fixture asserts the report names the disagreement.*
- **Anti: the gate does not depend on `censusCeiling`.** *Probe: a `partial` collation still yields a
  verdict. `collation-census.ts:488` returns null unless the claim is `success`, so a gate that leant
  on the census would be blind for exactly the status this gate exists to handle.*

**The review target is reachable (v0.2, §0.8, §8.2)**
- A review is not dispatched unless its target is readable from `/workspace`. *Probe: with the
  operator's checkout on a different ref than the integration branch, the workflow refuses rather
  than dispatching. **This is the criterion the round that reviewed v0.1 would have failed.***

**Staged dispatch (v0.2, §6.10, D14)**
- A dispatch is confirmed started from `status`, never from `dispatch --json`. *Probe: a fixture
  where the dispatch payload is `{accepted: true, via: "staged"}` and the worker remains `idle` with
  a `staged_task_id`; assert the workflow reports the turn as not started. **The accepted payload
  carries no `error` field, so a loop reading only the dispatch result cannot distinguish these.***
- **Anti: no task in a phase declares `depends_on`, and `--auto` is never invoked.** *Probe: assert
  over the generated envelopes; either would be refused by `graph.ts` at exit 2 or rejected as
  `pane_mode_tui_is_not_auto_schedulable`.*

**Identity and attribution**
- Every commit a worker makes carries the configured identity — **asserted as an exact value, not as
  "a commit succeeded"**. *Probe: after a dispatched task, `git log -1 --format='%an <%ae>'` on the
  worker's branch equals the configured value. **The exactness is the point: the measured failure is
  not a refusal but an invented identity — a probe worker committed as `eng-1 <eng-1@pifleet.invalid>`
  — and a criterion asserting only that a commit exists passes that.***
- **Anti: no worker commits under the operator's own address.** *Probe: the same `%ae` is not the
  operator's.*
- **Anti: no commit message, code comment, PR body or generated document produced by this system
  contains an AI or assistant attribution.** *Probe: grep every commit on the integration branch and
  the PR body for `Co-Authored-By`, `Claude`, `AI-generated`, `Generated with`; any hit fails.
  `roles/engineer.md:28` and `roles/collator.md:419` instruct it and an instruction is not a
  mechanism.*
- **Anti: no criterion in this block requires a real terminal, a real model, or the network.**

---

## 13. Implementation Checklist

**Phases are ordered by dependency, and each task names the files it touches** — which is §6.3's
partition requirement applied to this document, so that `/ProjectManager` can consume it. A task
naming no file cannot be partitioned and will serialise.

### Phase table

| Phase | Deliverable | Depends on | Exit criteria |
|---|---|---|---|
| **0 — Prerequisites** | The python image built and the identity symptom recorded | — | `pifleet image build --toolchain python` exits 0; the probe's output is in `ISA.md` |
| **1 — The seat model** | `rev-1` → `tst-2` across config, plan and tests | 0 | `bun test` green; `./scripts/development --dry-run` prints four panes titled `eng-1 eng-2 tst-1 tst-2` |
| **2 — Container identity** | A worker commits under a configured identity | 0 (Q10) | A dispatched task's commit shows the configured author, and it is not the operator's address |
| **3 — The integration path** | The host can fetch and merge a worker's branch, recorded | 1 | Two workers' branches reach one integration branch; `integration.json` re-derives the merge |
| **4 — The verdict mapping** | `collation.json` → APPROVED / CHANGES_REQUESTED / REVIEW_INCOMPLETE | 0 | Every fixture in §12's review-round block passes |
| **5 — The skill** | `Workflows/ProjectManager.md`, the routing row, the corrected fleet table | 1, 3, 4 | The workflow routes on its trigger phrases; the fleet table names eight workers |
| **6 — The dogfood run** | This document run through the workflow it specifies | 2, 5 | One phase completes end to end: partition, dispatch, integrate, review, verdict |

**Serialization:** 0 → 1 → 3 → 5. **Parallel after 0:** phases 2 and 4 touch disjoint seams (a
container's git config; a host-side JSON reader) and may proceed alongside 1 and 3.

### Phase 0 — Prerequisites

**Intent.** Remove the dependencies that make every later phase's evidence unreliable.

**Does not.** Change any behaviour. This phase builds and measures; it writes no product code.

> **v0.1's task 0.1 was "merge PR #147". It merged as `d70acf4` and the task is gone** (§0.7).
> v0.1's 0.3 was "record D9's chosen arm"; D9 is now closed as D13 (§6.8), so the remaining task is
> to record the *symptom*, not the decision.

- **0.1** Build the python toolchain image so `tester` can take a fourth seat, and so any image
  predating the `2ccf851` re-layer is replaced. Touches: nothing — `docker/Dockerfile` is unchanged;
  the tag is a hash over the existing build context, so a stale image is refused rather than run
  (`src/container/image.ts:242-244`).
  *Acceptance: `bun run src/cli/index.ts image build --toolchain python` exits 0, and
  `docker run --rm <tag> bun --version` prints a version — which is what proves the re-layer, since
  `:118-119`'s explicit postinstall is what makes bun functional rather than merely present.*
- **0.2** Record the git-identity symptom so D13's two arms are anchored to a measurement rather than
  to this document's prose. Touches: `ISA.md`.
  *Acceptance: `ISA.md` carries the observed failure — a commit in a worker container exits 128 with
  "unable to auto-detect email address" — and the observation that a worker CAN self-configure a
  repository-local identity because `mounts.ts:216` widens the clone `a+rwX`.*

### Phase 1 — The seat model

**Intent.** The development console stops reviewing and gains a second tester.

**Does not.** Touch `roles/reviewer.md`, the `reviewer` role, or any `review` console seat. §0.5
correction 1.

> **v0.1 said this was "two real pins". It is not — it is ten functional locations across two
> config files, one plan constant, one script and five test files, plus roughly twenty prose
> mentions.** The fuller list below came from the review round and was re-verified. v0.1's own
> `grep` missed four of them because it was gitignore-aware and silently skipped `fleet.yaml`,
> `fleet-development.yaml` and the extensionless `scripts/development`.

**And one interaction that is not obvious and bites this very phase.** `fleet.yaml` is **gitignored**
(`.gitignore:9`); `fleet.example.yaml` is the only tracked config. So an engineer dispatched to "edit
`fleet.yaml`" produces **no diff** — and a task with a `success` claim and an empty diff is graded
`failed` under ISC-93 as a fabrication. **The live config must be edited by the operator by hand, and
only `fleet.example.yaml` may be given to a worker.** Task 1.1 is split on that line.

- **1.1a** *(operator, not dispatchable)* In the untracked live `fleet.yaml`: replace the `rev-1`
  worker entry (`:727`) with `tst-2` on `role: tester`, `pane_mode: tui`, `theme: nord`, and correct
  the stale `reviewer` role comment at `:551` and the stale toolchain comment at `:656-658`
  (§0.5 correction 5). Touches: `fleet.yaml`, `fleet-development.yaml:129`.
  *Acceptance: `config validate` exits 0. **Not dispatchable — produces no diff.***
- **1.1b** In the tracked example: `fleet.example.yaml:605` becomes `tst-2` on `role: tester`, **and
  the `tester` role's `toolchain` at `:489` changes `node` → `python`** — without the second edit the
  example declares a node tester, and the two files stay out of step (§0.9). Touches:
  `fleet.example.yaml`.
- **1.2** Update the development roster constant at `src/backends/cmux/operations-plan.ts:636`, and
  the 2×2 diagram at `:611` that names the seat. Touches: `src/backends/cmux/operations-plan.ts`.
- **1.3** Update the script's own header diagram and its `--restart` docstring. Touches:
  `scripts/development:5`, `:16`, `:195`.
- **1.4** Update the assertions that pin the roster. Touches:
  `test/unit/development-plan.test.ts:47`, `:53` (and `:96`, `:134`, which v0.1 missed);
  `test/unit/status-runs.test.ts:38`; `test/unit/config.test.ts:119` (asserts the exact id list of
  `fleet.example.yaml`); `test/integration/cli-exit-codes.test.ts:238`
  (`render -c fleet.example.yaml --worker rev-1`).
  *Acceptance: `bun test` green.*
- **1.5** Update the two integration assertions that depend on the example config's roster. Touches:
  `test/integration/operations-console.test.ts:112` (whose `:117` requires all four seats to resolve
  as `tui`) and `:206`.
  *Note the mechanism at `:206`, because it is not obvious: it passes
  `--workers eng-1,eng-2,tst-1,rev-1` to `scripts/review` as a stand-in roster, and that works ONLY
  because the example config declares those four. The review console's real seats exist only in the
  untracked `fleet.yaml`, so under `--config fleet.example.yaml` they degrade to non-attended and the
  assertion's value cannot be produced. If `rev-1` leaves the example without this line changing,
  worker resolution throws, `scripts/development:130-139` swallows it, panes go non-attended, and the
  test fails on a missing `--workspace-name` rather than on anything about rosters.*
- **1.6** Add the roster and role criteria from §12's seat-model block. Touches:
  `test/unit/config.test.ts`, `ISA.md`.
- **1.7** *(prose, no behaviour)* Correct the seat name where it is documented. Touches:
  `README.md:52`, `src/backends/cmux/client.ts:108`, `:111`, `src/monitor/views/fleet.tsx:77`,
  `src/run/registry.ts:93`, `test/unit/console-restart.test.ts:11`, `:14`.
  *Do NOT touch the ~60 remaining `rev-1` strings in `test/unit/render.test.ts`,
  `test/integration/up-wiring.test.ts`, `down-prune`, `no-diff-gradability`, `monitor-render`,
  `monitor-workspace`, `operations-plan.test.ts`, `replies.test.ts` or `verbgate-collect.test.ts`:
  those build their own inline configs and use `rev-1` as an arbitrary worker id. Renaming them is
  churn that hides the real edits in review.*

### Phase 2 — Container identity

**Intent.** A worker commits under a known identity. Today it commits under an unknown one — either
git refuses, or it invents an address from uid 10001 and the container id. **Task 2.0 settles which,
and it comes first because the answer changes nothing about the fix and everything about the
symptom a reader will have seen.**

**Does not.** Mount the operator's `~/.gitconfig`, or use the operator's address. §6.8.

- **2.0** Probe what a worker's identity is today. Touches: nothing.
  *Acceptance: `docker exec -u 10001 <container> git -C /workspace config --get user.email` and a
  throwaway `git commit --allow-empty` in the same container, with both outputs recorded in `ISA.md`.
  This re-takes D13's probe on this operator's own image and settles whether the symptom here is a
  refusal or a bad author.*
- **2.1** *(D13 arm 1, no code)* Add the repository-local identity commands to the engineer and
  tester brief template, so Phase 2 is dispatchable before 2.2 exists. Note `--global` is
  unavailable — `/home/pi` is read-only. Touches: the envelope template used by §8.2 step 2.
- **2.2** *(D13 arm 2, the durable fix)* Extend the `GIT_CONFIG_*` block to deliver an identity.
  **`GIT_CONFIG_COUNT` is currently `"1"` and must become `"3"`** — appending keys 1 and 2 without
  bumping the count leaves them silently unread. Touches: `src/run/worker-env.ts:783-787`,
  `src/config/schema.ts` (the configured value).
- **2.3** Add the identity criteria from §12, asserting the exact author value. Touches:
  `test/unit/worker-env.test.ts`, `ISA.md`.
- **2.4** Add the attribution anti-criterion as a grep-based probe over an integration branch.
  Touches: `test/unit/attribution.test.ts` (new), `ISA.md`.

### Phase 3 — The integration path

**Intent.** Make §6.2's mechanism a supported, recorded operation rather than a docblock.

**Does not.** Merge anything automatically, or add a `pifleet merge` verb. The commands are git's and
the orchestrator runs them; what this phase adds is the record and the criteria.

- **3.1** Define and write the integration record. Touches:
  `src/run/pm-integration.ts` (new), `test/unit/pm-integration.test.ts` (new).
  *Acceptance: a record round-trips and refuses a host path outside the repository.*
- **3.2** Add the three integration criteria from §12. Touches: `ISA.md`,
  `test/integration/worker-remote.test.ts` (new).
- **3.3** Document the fetch-and-merge path where an operator will find it. Touches:
  `Docs/SRD.md` (§9.1's amendment — what per-worker isolation means when several workers produce one
  change).

### Phase 4 — The verdict mapping

**Intent.** Turn `collation.json` into a loop verdict, coverage first.

**Does not.** Change `CollationSchema`, add a field to it, or read the collator's `status`. §5.2.

- **4.1** Implement the two gates as a pure function over a parsed collation plus the host's
  coverage. Touches: `src/run/pm-verdict.ts` (new).
- **4.2** Add every fixture in §12's review-round block. Touches:
  `test/unit/pm-verdict.test.ts` (new), `ISA.md`.
  *Acceptance: the `REVIEW_INCOMPLETE` fixture asserts both halves — not APPROVED, and the iteration
  counter unchanged.*
- **4.3** Add the id-grammar criterion for phases 1..99. Touches: `test/unit/task-ids.test.ts`.

### Phase 5 — The skill

**Intent.** The workflow file, its routing, and the corrected tables.

**Does not.** Change `SKILL.md`'s cardinal rule. §4.1 argues the exception; it does not weaken the
rule.

- **5.1** Write the workflow. Touches: `~/.claude/skills/fleet/Workflows/ProjectManager.md` (new).
- **5.2** Add the routing row and correct the fleet table and the frontmatter worker list. Touches:
  `~/.claude/skills/fleet/SKILL.md`.
- **5.3** Add the review-console seats to the skill's tables — they are absent today, and that gap
  is closed by this change whether or not Phase 1 is taken. Touches:
  `~/.claude/skills/fleet/SKILL.md`, `~/.claude/skills/fleet/Workflows/Consoles.md`.
- **5.4** Add the brief-is-a-substring criterion. Touches: `ISA.md`.

### Phase 6 — The dogfood run

**Intent.** Run this document through the workflow it specifies, on this repository, for one phase.

**Does not.** Run unattended, or open a PR without the owner's word. D2's `pr_policy`.

- **6.1** Launch both consoles from `~/repos/cmux-fleet`, confirm `/workspace` in one container of
  each, and confirm the relay record names the live review run.
- **6.2** Run Phase 1 of this checklist *through the workflow* — partition, dispatch, integrate,
  review, verdict — and record what it cost. Touches: `.claude/project-manager-state.json`.
- **6.3** Record what the run found that this document did not predict. Touches: `ISA.md`,
  `Docs/SRD-FLEET-PROJECT-MANAGER.md` (§11, as answered questions in place — never deleted, always
  prepended with the date and the answer).

---

## 14. References

- `src/run/worktree.ts` — `WorkerWorktree`, `workerBranch`, `workerRemoteName`,
  `registerWorkerRemote`, `assertValidBranchName`, and the clone-not-worktree decision with its
  measured RCE.
- `src/run/fresh-dispatch.ts` — `recreateThenDispatch`, `settledEnough`, `busyRefusal`,
  `dispatchProblem`, and the refuse-having-stopped-nothing property.
- `src/run/relay.ts` — `relayFanOut`, `RelayOutcome`'s five arms, `RelayHarvestError`,
  `RelaySettleTimeoutError`, `RelayEnvelopeState`, `RelayOutboxListing`, `planInlineBudget`,
  `RELAY_SETTLE_DEADLINE_MS`, and the host-counted `coverage`.
- `src/run/relay-journal.ts` — `RelayJournalEntry`, `recordDispatch`, `classifyRequest`, the
  journal-after-dispatch argument, and the `(sender, task-id)` key.
- `src/run/task-ids.ts` — `childTaskId`, `collationTaskId`, `isCollationTaskId`,
  `MAX_RELAY_TASK_ID_CHARS`, `REVIEW_CONSOLE_ASPECTS`, and the depth bound.
- `src/run/collation.ts` — `CollationSchema`, `CollationLens`, `CollationFinding`, `LensCoverage`,
  `collationCeiling`, and the three `notHere` fields.
- `src/run/dispatch-request.ts` — `DispatchRequestSchema`, `DispatchRefusal`'s twelve codes,
  `REVIEW_CONSOLE_ROSTER`, `ConsoleRosterError`.
- `src/run/replies.ts` — `replyMountPath`, `writeReply`, and the never-rename rule.
- `src/run/console-relay.ts` and `src/cli/commands/relay.ts` — the actor, its record, its
  supervision story and `--once`.
- `src/contracts.ts` — `TaskEnvelopeSchema`, the verdict enum and the lattice.
- `src/cli/commands/worktrees.ts` — what replaced `git worktree list`, and `commitsAhead`.
- `fleet.yaml` — both consoles' seats, the roles, `hosted_repo_consent`, `egress.allow`, and the
  one-role-three-workers argument for the lenses.
- `roles/collator.md` — the two-turn protocol, `dispatch-request.json`, `collation.json`'s field
  rules, and the two kinds of missing lens.
- `roles/engineer.md`, `roles/tester.md`, `roles/reviewer.md` — the seat prompts.
- `skills/pifleet-worker/SKILL.md` — `pifleet.result/v1` and the epoch rule.
- `ISA.md` — the grading convention, ISC-517, ISC-522, ISC-523, ISC-514, ISC-513, ISC-400, ISC-349.
- `Docs/SRD.md` §5.9, §9.1, §12.1, §12.2 — hosted disclosure, per-worker isolation, tool scope,
  untrusted repository content.
- `Docs/SRD-REVIEW-CONSOLE.md` §0.2, §6.4, §6.5, §6.6, D5, D8 — the capability class, the request
  plane, the actor, the never-wait argument, and grading on structure.
- `~/.claude/skills/ProjectManager/SKILL.md` — the workflow being ported.
- `~/.claude/skills/fleet/SKILL.md` and `Workflows/` — the cardinal rule, the routing table, the
  launch-directory rule and the gotchas this document extends.
- `.claude/project-manager-state.json` on `feature/harvest-recovery` — the state file practice
  already reached.
