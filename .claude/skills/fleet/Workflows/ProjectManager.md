# ProjectManager

Run an SRD through the fleet, phase by phase. Two consoles, one integration
branch.

## Before anything else

Re-read the **CARDINAL RULE** in `SKILL.md`, and read this corollary with it.
The rule is not weakened here.

**The SRD is the brief.** You author the SPLIT — which of the document's tasks
go to which worker — and the acceptance commands. You do NOT author the task
text. Copy each phase task's own words into the envelope. Do not resolve the
paths it names, do not look up the API it references, and do not decide what it
"really means". If a task is too ambiguous to dispatch, ASK — do not research
your way to an answer.

A reader holding the SRD and the envelope should be able to find the brief
inside the document **by string search**. That is the rule's operational form,
and it is what makes it checkable.

## The seats

| Console | Seats | What they are |
|---------|-------|---------------|
| development | `eng-1`, `eng-2` — `role: engineer`, `node` | own clone and branch, `bash`, **no egress** |
| development | `tst-1`, `tst-2` — `role: tester`, `python` | own clone and branch, `bash`, egress to the package registries |
| review | `col-1` — `role: collator`, `base` | writes the three briefs, collates the three reports; does not review |
| review | `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` — `role: reviewer`, `base` | `shared-ro`, **no `bash`**, three different vendors |

**The development console's fourth seat is `tst-2` on `role: tester`.** There is
no `rev-1` — `scripts/development --restart rev-1` refuses with an unknown pane
title. The `reviewer` role is NOT retired: it is the system prompt all three
`review` console lenses inherit, and each lens adds only its own angle on top.

**The development console does not review any more.** A defect written in task 3
of a phase is read by no reviewer until that phase's review round, after the
host has merged it. That is the price of moving review to a console that reads
the integrated result on three vendors, and it is why the review round in step 6
is not optional.

## Arguments

Two, and the first is not what it looks like.

- **A repository.** This is the LAUNCH DIRECTORY for both consoles, and the
  launch directory BECOMES the run's repository (`SKILL.md`, "Choosing a
  worker's platform"). So the repo argument is not a value you pass to anything
  — it is the directory you `cd` to before every console command in this
  workflow. Both consoles.
- **An SRD path INSIDE that repository.** Resolve it relative to the repo
  argument, and read it from the host. Workers never see it: they see
  `/workspace`, and the SRD's content reaches them only as the `brief` fields
  you copy out of it.

## Preconditions — check all eight, in order, and stop at the first failure

1. **The repo is a git checkout with a clean tree.**
   `git -C <repo> status --porcelain` is empty. A dirty tree becomes every
   worker's clone baseline and the harvest grades against it.

2. **The SRD exists and has an "Implementation Checklist" with numbered
   phases.** No phases means nothing to dispatch; say so and stop.

3. **The remote is cleared for hosted review.**
   `git -C <repo> remote get-url origin`. If it matches an AppNeta or Broadcom
   pattern, it must equal `run.hosted_repo_consent` in
   `~/repos/cmux-fleet/fleet.yaml`. If it does not, STOP and tell the user — do
   not launch and let `up` refuse four containers in.

   **"Equal" means BYTE-FOR-BYTE.** The comparison is an exact string match, so
   an `ssh://git@…` remote will not match an `https://…` consent value, a
   trailing `.git` or a trailing slash will not match its absence, and a case
   difference will not match. A refusal here is far more often a spelling
   mismatch than a policy decision — say which of the two it is rather than
   reporting "not consented".

4. **The toolchains can run this repository's language.**
   `pyproject.toml`/`setup.py` -> python, `go.mod` -> go, `package.json` ->
   node. The engineer seats are `node` and the tester seats are `python`.

   **Every toolchain includes node, structurally** — `docker/Dockerfile` builds
   `toolchain-python` and `toolchain-go` FROM `toolchain-node` — so `python` is a
   strict superset and a tester runs a `bun` suite perfectly well (measured on
   `pi-worker:0.79.6-python`: bun 1.3.12, node v24.20.0, Python 3.11.2, uv, ruff,
   mypy). **The mismatch that actually bites is the other direction**: a python or
   go repository reaching the `node` ENGINEER seats, which carry no `python3`, no
   `pytest` and no `go`. That is a `fleet.yaml` edit plus `pifleet image build
   --toolchain <name>`, and it is the user's call, not yours.

5. **No console is already open on a DIFFERENT repository.**
   `docker ps --format '{{.Names}}' | grep pifleet` then, for one container per
   console, `docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}'
   <name>`. A console pointed elsewhere CANNOT be repointed by `--restart` — the
   mount is in the pane's launch argv. Repointing it is `--recreate`, which downs
   every run in that workspace. **Say so and get the user's word before you do
   it.**

6. **The review console's relay is alive and serving THIS console.**
   Read `~/.pifleet/review-relay.json`: it carries `pid`, `started`, `run_id`,
   `pinned` and `workers`. A record whose `run_id` names a dead run is a relay
   polling nothing. `./scripts/review` restarts it idempotently; `--relay-stop`
   stops one.

7. **THE REVIEW TARGET IS READABLE FROM `/workspace`.**
   Reviewer seats are `isolation: shared-ro` — `/workspace` is the operator's
   checkout at whatever ref it currently stands on — and they hold NO `bash`.
   They cannot run `git show`, `git diff`, `git log`, or anything else. **A
   branch that is not checked out in the operator's own checkout is invisible to
   them.**

   Before dispatching any review, confirm the integration branch is the
   checked-out ref:

   ```bash
   git -C <repo> rev-parse --abbrev-ref HEAD    # must be the integration branch
   ```

   If it is not, either check it out, or inline the text to be reviewed into the
   brief. Do NOT tell a lens to run a git command. **This precondition exists
   because it was skipped**: a review of the SRD returned a collation claiming one
   of three lenses reported, when in truth none of the three could read the file
   at all.

8. **No worker is holding work.**
   `cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --all --json`. Any
   non-null `task_id` or `staged_task_id` — name the worker and what it is doing
   before you touch anything.

## Setup, once per run

```bash
cd <repo>
git checkout <base_branch> && git pull
git checkout -b <integration-branch>        # BEFORE the console; up clones from here
cd <repo> && ~/repos/cmux-fleet/scripts/development
cd <repo> && ~/repos/cmux-fleet/scripts/review
```

Write `.claude/project-manager-state.json` with the partition plan empty and
`current_phase: 0`. Record which directory each console was launched from — you
will be asked, and a console on the wrong repository is silent.

## The state file

`<repo>/.claude/project-manager-state.json`, schema `pifleet.pmstate/v1`,
validated on every read against the zod schema in
`~/repos/cmux-fleet/src/run/pm-state.ts` — a hand-edited or half-written cursor
is refused at the boundary rather than acted on.

```
srd_path, repo_path, base_branch, baseline_commit
branch_model: "long-lived" | "per-phase"
branch                       the integration branch
total_phases, current_phase, completed_phases[], status
consoles: {development: {launched_from, workspace_id}, review: {…}}
phases[]: {n, slug, name,
           partition: [{worker, round, task_ids[], files[]}],
           dispatched: [{worker, task_id, run_id}],
           integration: {…}
           review: {parent_task_id, collate_task_id, coverage, verdict, iteration}}
answered_questions{}, out_of_band_commits{}, pr_policy
```

**`partition` is the field that makes a resumed run possible**, because it is the
one thing the run tree cannot supply: which SRD tasks were meant to go where —
and, since a phase is dispatched in rounds, in what order. `round` is 1-based and
defaults to 1. File ownership is unique **within** a round and free across rounds;
a task id belongs to exactly one round and one worker. A resumed run reads the
highest round with a merge behind it and briefs the next one.

**Everything else in this file is a cursor and must be treated as one.** A phase
listed in `completed_phases` whose artifacts do not exist is a stale file, not a
completed phase, and the run tree wins. **The file is advisory in exactly one
direction: it may say a phase was never started, and it may not say a phase was
finished.**

## Per phase

**1. Partition, then SIZE — a phase is 4 or 5 ROUNDS, not one big dispatch.**

Read the phase's tasks and split them **twice**: across the two engineers, and
then along the phase into a sequence of rounds. Steps 2-5 run once per round.

**The size cap.** One engineer's brief in one round carries **at most two SRD
tasks and about four files**. A phase with eight criteria is four rounds, not one
dispatch of eight. When a slice is close to the line, take the smaller one — the
cost of an extra round is one merge, and the cost of an oversized one is a
worker's entire output discarded.

**Why the cap exists, and why it is not about time.** A brief that names four
criteria does not run slowly, it runs OUT. Measured on this project across two
phases and eight agent runs — those were orchestrator-side agents rather than
fleet seats, so read the NUMBERS as indicative and the MECHANISM as the finding:
given the whole slice at once, an agent produces a complete, well-argued module,
never wires it to a caller, stops mid-sentence, and reports success. Every seat
in this loop generates against a bounded context, so nothing about the mechanism
is specific to where the agent runs. The ceiling lands on whatever is LAST
in the queue — implement, then test, then integrate — so what it eats is always
the integration, and integration is the part that has no local unit test to go
red. Cheaper test commands delay that wall; they do not move it. **Only a smaller
brief moves it.**

**Split by CRITERION, never by src/test.** Each engineer gets a complete vertical
slice: the source, its tests, and its call site. A src/test split across two
workers manufactures the exact failure the cap is there to prevent — the test
author writes probes against a contract the source author has not wired, and
neither one owns the wiring.

**Disjointness binds WITHIN a round, not across the phase.** Two engineers
editing one file at the same time is a merge conflict, so no file appears in two
partitions OF THE SAME ROUND; a task naming a file another partition owns joins
that partition even if the split becomes uneven, and if a round cannot be made
disjoint, DO NOT SPLIT IT — give that round to one engineer and leave the other
idle for it. The same file returning in round 3 is not a conflict at all: round
3's clone is taken after round 2 merged, so it already contains round 2's work.
This is the same mechanism as the tester-freshness rule below, and it is the
reason rounds are cheap.

**Record every round's partition in the state file before you dispatch it**, each
entry carrying its `round` (1-based; the key defaults to 1, so a single-round
phase and every file written before rounds existed are unchanged). The validator
in `~/repos/cmux-fleet/src/run/pm-state.ts` enforces the scoping: a file with two
owners in one round is refused, the same file in two rounds parses, and a task id
in two rounds is refused because a dispatch must trace to exactly one round.

**Recognise an oversized round afterwards and TIGHTEN THE CAP — do not just
re-run it.** The signature is consistent: a report whose text ends mid-sentence,
`commitsAhead: 0` after twenty minutes, or commits that stop before the last
criterion in the brief. **Read the diff, not the report** — the suite goes green
with the defect in, because the tests that would catch it were written in the
same exhausted turn and never run. When the deliverable is "a thing that runs",
the check is `grep` for its caller, not the suite that exercises the module
directly:

```bash
cd <repo> && git diff --stat <base>...HEAD                      # THREE dots, as below
cd <repo> && grep -rn "<new-module>" src/ | grep -v "^src/<new-module>"   # must be non-empty
```

A call sitting inside the defining file is a real caller — check for an internal
one before declaring a module unwired.

**Resume ONCE, then split.** A worker that stalled recovers reliably on a single
resume when the brief names ONLY the remaining items. It does not recover on a
second — the resume continues the same transcript, so the ceiling that was
already reached is reached again sooner. After a second stall, split the
remainder into further rounds or finish it by hand.

**2. Dispatch both engineers for THIS ROUND, in one message.**

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-1 --task <env-1.json>
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-2 --task <env-2.json>
```

Envelopes go in the scratchpad, not the repo. Four fields plus `acceptance`.
`brief` is the SRD's words. `acceptance` must survive tokenizing — no shell
metacharacters, and `"bun test passes"` is prose that tokenizes to a three-word
argv and exits non-zero. Write the runner and its arguments, or commit a script.

**Do NOT tell a worker to configure a git identity.** A `worktree` seat is handed
one by the host through git's own `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` channel in
the container's env file (`src/run/worker-env.ts`), from `run.git_identity` in
`fleet.yaml` (`src/config/schema.ts`; default `pifleet
<pifleet@pifleet.invalid>`). No model can skip it or override it, and it is never
the operator's own address. `git config --global` was never available in these
containers — the root filesystem is read-only and there is no writable `$HOME` for
a gitconfig to land in — so a brief that asks for an identity buys nothing except
the chance that a worker improvises a repository-local one, which is an
unattributable author on the integration branch.

**3. Confirm both started — from `status`, NOT from the dispatch output.** After
~30s, `status --run <id> --json` per worker. `busy` with growing
`transcript_activity.entries` is working. `idle` with a `staged_task_id` set is
staged and UNTRIGGERED — say so rather than waiting silently.

**This step is not a courtesy check.** These seats are `tui`, so every dispatch is
staged, and `dispatch --json`'s accepted payload carries no `error` field: a
staged envelope whose trigger line was never typed prints `accepted: true`,
`via: "staged"` and exits 0. **The JSON cannot tell you the turn never started.
Only `status` can.**

**Do not eyeball it — `pm-guard` holds the judgement.** Capture both streams and
ask; it exits 0 when the worker really has the task and 7 when it does not, so
`&&` is enough to stop the phase over a refusal:

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-1 --task <env-1.json> \
  > /tmp/eng-1-dispatch.json
cd ~/repos/cmux-fleet && bun run src/cli/index.ts status --run <id> --json > /tmp/status.json
bun run src/cli/index.ts pm-guard dispatch-started --worker eng-1 --task <task-id> \
  --dispatch-output /tmp/eng-1-dispatch.json --status /tmp/status.json
```

It answers with three states and a distinct exit for each.

| exit | state | what it means | what to do |
|------|-------|---------------|------------|
| 0 | `started` | the worker is holding this task | continue |
| 4 | `staged` | the envelope landed, the turn has not begun | **look again — do NOT re-dispatch** |
| 7 | `refused` | the dispatch never landed | fix the envelope, re-run the same dispatch |
| 7 | `unconfirmed` | the payload claims success and the fleet does not show it | investigate before anything else |

**`staged` is not a failure and it is not a start**, and keeping those apart is
the whole point of the step. `via: "staged"` IS success for the question *did the
envelope land*, which is why re-dispatching on it is the documented mistake. It
is not an answer to *did the turn start*, and the accepted payload carries no
field that separates the two. **`unconfirmed` is the dangerous one**, because
everything an operator would look at reads like success.

**4. Wait, then harvest.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts wait --task <id> --run <id> --timeout 45m --json
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts --task <id> --run <id> --json
```

Run the waits in the background so the turn is not blocked.

**5. Integrate — through the gate, never with a bare `git merge`.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts worktrees --run <id> --json   # branch + commitsAhead
```

The merge is `mergeWorkerBranch` in
`~/repos/cmux-fleet/src/run/pm-integration.ts` — fetch, inspect, merge,
neutralize, in that order, once per worker branch. **There is no `pifleet merge`
verb**: it is a library the orchestrator calls, so run it from a scratchpad script
and persist what it returns.

```ts
// <scratchpad>/merge-eng-1.ts
import {
  mergeWorkerBranch,
  toIntegrationWorkerRow,
} from "/Users/<you>/repos/cmux-fleet/src/run/pm-integration.ts";

const r = await mergeWorkerBranch({
  repoRoot: "<repo>",                  // must be sitting ON the integration branch
  worker: "eng-1",
  remote: "worker-eng-1",              // up wrote this remote into <repo>/.git/config
  branch: "fleet/<run-id>/eng-1",      // run.branch_prefix / run id / worker id
  taskId: "<the task that produced it>",
  // baseRef defaults to HEAD — right the instant before this merge and wrong the
  // instant after, so do not cache it across two workers.
});
console.log(JSON.stringify(toIntegrationWorkerRow(r), null, 2));
```

```bash
cd ~/repos/cmux-fleet && bun run <scratchpad>/merge-eng-1.ts
```

Three outcomes, and each is a different next move:

| `outcome.kind` | What happened | What you do |
|----------------|---------------|-------------|
| `refused_hazard` | the incoming tree writes `AGENTS.md`, `CLAUDE.md`, `.pi/**`, `.agents/skills/**`, a `.gitattributes` at any depth, or anything under `.github/workflows/` | nothing was merged. Show the user the `hazards[]` rows — a legitimate edit to one of these is one they approve by hand, not one this loop approves by silence |
| `merge_failed` | git refused; the tree was left as it was found | a conflict — move the BASE, below |
| `merged` | `mergeCommit`, plus `postMergeHazards[]` from the scan of your own checkout | write the record, then carry on |

The record goes through `writeIntegrationRecord` to
`<repo>/.claude/project-manager/phase-<N>/integration.json`, and is validated on
read.

**Driving the gate by hand instead — the inspect step takes THREE DOTS.**

```bash
cd <repo> && git fetch worker-eng-1 fleet/<run-id>/eng-1
cd <repo> && git rev-parse FETCH_HEAD                       # pin the SHA now; FETCH_HEAD moves
cd <repo> && git rev-list --count <base>..<head>            # two dots: already a range
cd <repo> && git diff --name-only <base>...<head>           # THREE dots
cd <repo> && git -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null \
               merge --no-ff --no-edit <head>
```

`git diff A..B` is just `diff A B`, a comparison of two ENDPOINTS — for `git diff`
two dots do NOT mean the range they mean for `rev-list`. On a long-lived
integration branch the orchestrator commits between merges, so everything HEAD
gained since the worker branched reads as a path the worker changed. **Measured:
inspecting a worker branch against `HEAD` with two dots listed
`.claude/project-manager-state.json` — a file that branch never touched — and the
gate refused a clean branch on it. A gate that refuses good branches gets turned
off.** `A...B` is git's name for "what B changed since the merge base", which is
the question the gate is actually asking.

**`core.attributesFile=/dev/null` does not do what it looks like it does.**
`core.hooksPath=/dev/null` genuinely suppresses a base-configured hook —
reproduced. `core.attributesFile` names an ADDITIONAL, global attributes file and
was never the switch for a repository's own tracked `.gitattributes`, so a
`filter=` driver already resident in your checkout still runs during the merge's
checkout step. Both flags stay — they cover a driver arriving in a worker's diff,
which the inspect step refuses anyway — but a driver already sitting in the base
is not covered by anything here. What covers it is knowing your own checkout: no
`.gitattributes`, no `filter.*`/`diff.*` keys in `.git/config`, no non-sample
hook. Check that, do not assume it.

**If `worktrees --json` fails or omits a worker, STOP — do not merge what it did
return.** A missing worker record means the run directory is incomplete, and the
branch name is the one thing the merge cannot guess: it is derived from the run
id, which a partial record may not carry. Re-read `status --all --json` for that
worker's current run and retry; if the run is gone, the worker's clone may still
exist under `~/.pifleet/runs/<run>/worktrees/<id>` and its branch is
`fleet/<run-id>/<worker-id>` — verify with `git -C <path> branch --show-current`
before fetching from it. **A partial integration that reports success is worse
than a refused one**, because the phase's review then reads half the work as
though it were all of it.

`commitsAhead: 0` means that worker committed nothing — check its envelope before
merging nothing and calling it done.

**On a CONFLICT, move the BASE, not the commit.** A worker's clone has no remotes
— `origin` is stripped at clone time — so it cannot fetch the other engineer's
work and cannot rebase onto it. Telling it to is an instruction with no mechanism:

```bash
cd <repo> && git merge --abort
cd <repo> && git checkout <integration-branch>     # now holds engineer 1's work
cd <repo> && ~/repos/cmux-fleet/scripts/development --restart eng-2 --task <redo.json>
```

The restart re-clones from the checkout as it now stands, so engineer 2's fresh
`/workspace` already contains engineer 1's changes. Re-state its original
partition and name the conflicting files. Its earlier commits are discarded — that
is the cost, and it is why the partition rule exists. **Do not resolve the
conflict yourself** — every line you write is a line no reviewer was told to look
at.

Write the integration record.

**Then go back to step 2 for the next round, if the phase has one.** The merge
you just performed is what makes the next round possible: `--restart` re-clones
from the checkout as it now stands, so round N+1's engineers open a `/workspace`
that already contains round N. That is why a file may be revisited in a later
round and why the rounds must not be dispatched concurrently — **a round is
briefed only after the previous round is merged.** Two rounds in flight at once
is just the oversized dispatch again, with a conflict added.

One integration record covers the phase, so a later round's merge updates it
rather than writing a second; the per-round evidence that a round happened is its
merge commit on the integration branch, not a field in this file.

**When the last round is merged**, repeat steps 2-5 for `tst-1` and `tst-2` —
AFTER that merge, so each tester's clone holds every round's work. Each tester
takes the files its paired engineer touched. Testers are sized by the same rule:
a tester handed the whole phase's surface runs out exactly where an engineer
does.

**Prove the clone is current before dispatching, rather than trusting the
order.** A restart that silently did not happen leaves a tester that runs a real
suite against the previous phase's tree and reports a real pass about it —
nothing in the envelope, the status table or the result marks it, and a worker's
clone has no remotes so it cannot fetch the merge afterwards:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts pm-guard tester-fresh \
  --worker tst-1 --phase <n> --repo <repo>
```

Exit 0 means the clone contains every commit this phase merged. Exit 7 names the
ones it is missing, and the only remedy is `--restart … --task` so the tester
re-clones from the checkout as it now stands.

**6. Review, in the review console.**

```bash
cd <repo> && ~/repos/cmux-fleet/scripts/review --restart col-1 --task <review-env.json>
```

That form is fresh-collator-then-dispatch: it waits for `col-1` to be holding
nothing, stops its run, respawns its pane, dispatches into the run it comes back
in, and restarts the relay — the host process that turns the collator's
`dispatch-request.json` into three reviews. Nothing else in the console is
touched. See `Consoles.md`.

`task_id` must be short: children are DERIVED by concatenation and REFUSED past 64
characters. `T-rv-p<N>` leaves room — the three children are `T-rv-p<N>-arch`,
`-context` and `-lang`, and the collation is `T-rv-p<N>-collate`.

The brief carries the four things the collator cannot derive:

1. the integration branch and its base ref, so the subject is a range and not a
   tree;
2. the changed-file list from the merge you just performed — one path per line,
   repo-relative, no globs and no ranges, under a literal `CHANGED FILES:`
   heading, terminated by a blank line, and truncated past 200 entries with an
   explicit `… and N more` rather than silently;
3. the exact SHA `git rev-parse HEAD` returns immediately before dispatch,
   recorded so the round can be voided if the checkout moves;
4. the phase's name and its SRD section, so a lens can ask whether the change does
   what the phase said it would.

**And nothing about the development run** — not its run id, not its workers, not
its envelopes. The review console reviews code, not a fleet.

**7. Derive the verdict — from the run tree and the COLLATE task, not the
parent.**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts --task T-rv-p<N>-collate --run <col-run> --json
```

The parent settles when the fan-out is ISSUED, so its envelope says nothing about
the review. Read `files/collation.json` and `files/review.md`.

The mapping is `deriveReviewVerdict` in
`~/repos/cmux-fleet/src/run/pm-verdict.ts` — a pure function over four values,
reading no file and reaching no network:

```
collation     the parsed collation.json from the -collate task, or null
coverage      the HOST's coverage of the fan-out (below)
recordedSha   the SHA the review request recorded at dispatch
currentSha    git rev-parse HEAD, now
```

**COVERAGE COMES FROM THE RUN TREE. NEVER FROM THE COLLATION.**

| Quantity | Where it is read | Why it cannot be forged |
|----------|------------------|-------------------------|
| denominator — lenses dispatched | `~/.pifleet/runs/<run>/relay/col-1/<parent>.json` → `children[]` | host-written by the relay after it dispatches; `<run>/relay/` is mounted into no container |
| numerator — reports that survived | the `~/.pifleet/runs/<run>/replies/col-1/<child>.json` files that exist AND parse | host-written, once per survived child; the mount is read-only to the collator |

`collation.lenses[]` and every census figure derived from it are
collator-authored — the relay even puts the coverage line into the collation brief
as text the collator is asked to copy, and a number a worker is asked to copy is a
worker-authored number. Read `lenses[]` **only as a cross-check**: a row missing
for a dispatched child, a row for a lens that was never dispatched, or
`reported: true` on a lens with no readable reply is reportable in its own right,
and it is the only signal available that a collator is not copying its brief
faithfully.

| Verdict | Means | Counts against `max_review_iterations` |
|---------|-------|---------------------------------------|
| `VOID` | `recordedSha` ≠ `currentSha` — the checkout moved under the lenses, so every `file:line` points into a different history. Re-run the round | no |
| `NO_COLLATION` | `refused_or_none_landed`, `not_collated`, or `missing_collation` — there is no collation to be short | no |
| `REVIEW_INCOMPLETE` | some, not all, dispatched lenses reported. Not APPROVED and not CHANGES_REQUESTED | no |
| `APPROVED` | full coverage, `findings[]` empty | no |
| `APPROVED_WITH_DISSENT` | every finding raised by exactly one lens and disputed by another — proceed, and carry those findings into the PR body verbatim | no |
| `CHANGES_REQUESTED` | consensus findings (`raised_by.length >= 2`) first, single-lens findings ranked below | **yes** |

On `REVIEW_INCOMPLETE`, report which lenses are missing and which KIND each is: a
lens that produced nothing was not applied; a lens whose report was written and
could not be read WAS applied and its review is on disk. Those are different
things to do next, and neither is "run the round again and hope".

The fix brief is built from `findings[]`, never from `review.md`. Rewrite each
finding's container `file` to repo-relative (`toRepoRelativePath`), partition them
by file owner, and go to step 2. A `finding_count` that disagrees with
`findings.length` is reported, and `findings.length` is the one used.

**8. PR, CI, merge — all on the host.**

```bash
cd <repo> && git push -u origin <integration-branch>
gh pr create --title "..." --body "..."      # attach review.md
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

Workers have no GitHub egress and never will. On a CI failure, partition the
failures and dispatch fixes exactly as in step 7.

## Gotchas

- **The repo argument is the launch directory, and it is silent when wrong.** A
  console launched from `~/repos/cmux-fleet` gives every worker cmux-fleet no
  matter what your briefs say. Measured three times on this fleet. Confirm with
  `docker exec -u 10001 <container> ls /workspace` before dispatching a phase.
- **A console already open on another repository cannot be repointed.**
  `--restart` keeps the pane's mounts, and the mount is in its launch argv. Only
  `--recreate` moves it, and that downs every run in the workspace. Get the
  user's word.
- **The integration branch must exist BEFORE the console comes up.** `up` clones
  from the checkout as it stands. A branch created afterwards is in no worker's
  clone, and every worker will have branched from the wrong base.
- **`--task` refuses having stopped nothing.** If a worker will not settle in 20
  minutes the command refuses and the fleet is exactly as it was found. That is
  the safe outcome. Do not reach for a bare `--restart` to get around it — that
  one is destructive and needs the user's word.
- **A worker's clone has NO remotes.** `origin` is stripped after the clone,
  deliberately, so the host's path is not disclosed to the container. A worker
  therefore cannot fetch, pull, rebase onto another worker's branch, or push. Any
  brief that assumes it can will stall. Move the base by restarting the worker
  instead.
- **A tester that is not restarted between phases tests the previous phase.** Its
  clone is from its previous run, taken at the previous base, so it never saw this
  phase's merge. It will report truthfully about the wrong tree and nothing will
  look wrong. Always `--restart … --task` a tester after an integration merge.
- **Two dots in the gate's inspect step is a defect, not a style.** `git diff
  <base>..<head>` compares endpoints and reports the orchestrator's own commits as
  the worker's, so the gate refuses clean branches. Three dots.
- **A lens cannot run git. It has no shell.** Reviewer seats are `shared-ro` with
  `[read, write, grep, find, ls]`, so `/workspace` is the operator's checkout at
  whatever ref it is on and nothing can move it. A brief saying "run `git show X`"
  gets you a `blocked` from a careful lens and an invented review from an
  incautious one — **and the incautious one is counted as having reported.** Check
  the branch out first, or inline the text. Measured: a review came back "1 of 3
  reported" when the true figure was 0 of 3.
- **`accepted: true` does not mean the worker woke up.** Every development and
  review seat is `tui`, so every dispatch is staged, and the accepted JSON payload
  has no `error` field even though the underlying result does. Confirm from
  `status`.
- **Read the collate task, not the review request.** The parent settles as soon as
  the fan-out is issued, and it claims `success` for having written a request. A
  loop that reads it will approve a review that has not happened.
- **Count coverage from the run tree, not from the collation.** Nothing caps a
  collator claiming `success` over a partial fan-out, and a `partial` collation
  gets no structural check at all — the census ceiling is switched off for exactly
  the status that triggers the gate.
- **A 2-of-3 collation is a valid document.** It parses, the collator's verdict is
  `success`, and one `lenses[]` row says `reported: false`. Nothing goes red.
  Count the children in the journal.
- **The collator's status is about its collation, never about coverage.** A
  collation that faithfully reports two reviews is `success`. It is not a
  two-thirds review that passed.
- **A lens lost to a failed harvest does not come back.** The fan-out is journalled
  after dispatch, so a re-issued pass finds it done. The review is on disk and
  missing from the document — say so, and do not re-run the whole round hoping.
- **The token ceiling in `fleet.yaml` does not bound this loop.** Budget admission
  is reached only from `dispatch --auto`, which cannot target these seats. Two
  engineers generating at once are bounded by the inference server and nothing
  else, and the four review seats are hosted, so they are bounded by a rate limit
  and BILLED. Count your own spend.
- **`commitsAhead: 0` on a worker that reported `success` is a contradiction worth
  stopping on.** Either it did the work in the wrong place or its envelope is not
  about this task. Read the transcript.
- **An oversized brief does not fail, it reports success.** A worker given a
  phase's whole slice at once writes the module, skips the call site, stops
  mid-sentence and returns `success` — measured across eight agent runs in two
  phases, four of four in one of them producing a module `grep` could not find a
  caller for. Nothing in the envelope, the status table or the suite goes red,
  because the tests that would have caught it were written in the same exhausted
  turn. **Two SRD tasks per engineer per round, four or five rounds per phase**,
  and read the diff rather than the report.
- **Rounds are sequential, and that is the whole point.** Round N+1's clone is
  taken from the checkout after round N merged, which is what lets a file be
  revisited and what keeps the briefs small. Dispatching two rounds at once
  restores the big dispatch and adds a merge conflict to it.
- **An engineer cannot `bun install`.** The role has no `egress_access`, so a fresh
  clone's dependency install hangs against the deny-all policy until the tool
  timeout — it does not fail, it sits at ~1.6% CPU with nothing written. Testers
  can. Put the install in the tester's brief, or say so and ask.
- **Acceptance commands run in a fresh clone at the BASE revision.** A command that
  depends on a file the worker just wrote will not resolve. That is deliberate.
- **Attribution: none, anywhere, ever.** No `Co-Authored-By` trailer, no "generated
  with" footer, and no naming of a model, an assistant or a vendor in a commit
  message, a PR body, or a code comment. Flag it as a defect if you see one in a
  worker's output.
