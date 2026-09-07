---
name: fleet
description: Send tasks to the cmux-fleet of containerised Pi agents (obs-1, tick-1, eng-1, eng-2, tst-1, tst-2, col-1, rev-arch-1, rev-ctx-1, rev-lang-1) via pifleet. USE WHEN the user says use tick-1, use eng-1, use the fleet, ask the observer, dispatch to a worker, send this to a worker, get the fleet to do it, run an SRD through the fleet, project-manage an SRD, recreate or restart a worker or container, change a worker's toolchain or platform (node/python/go), launch a worker against a particular repo, recreate the operations/development/review/triage workspace, run or check the triage console ("start triaging", "is the triage console running", "what is triage saying", "sweep now"), or names any fleet worker or console by name.
---

# fleet

Dispatching work to the `cmux-fleet` — containerised Pi agents, each with its own
role, model, secrets and egress allowlist. Repo: `~/repos/cmux-fleet`. CLI:
`bun run src/cli/index.ts <cmd>` from that directory (the `pifleet` bin).

**This skill lives in the repo it describes.** Its files are
`~/repos/cmux-fleet/.claude/skills/fleet/`, tracked there, and
`~/.claude/skills/fleet` is a symlink to them. So editing the skill through the
`~/.claude` path edits the working tree of `cmux-fleet` — the change shows up in
`git status` there and wants a commit, rather than being an untracked file on
one machine. It is not put under `~/repos/cmux-fleet/skills/`, which is the
WORKER skill tree: those directories are staged per role and mounted at
`/skills:ro` inside a container, and this is an operator skill with no business
in one. (A repo-root `SKILLS/` was not an option either — this filesystem is
case-insensitive, so it would collide with `skills/`.)

---

## CARDINAL RULE — DO NOT DO THE WORK BEFORE SENDING THE MESSAGE

**When the user says "use tick-1" (or any worker), they are telling you WHO does
the work. Your job is to relay their instruction, not to complete it first.**

Forbidden before dispatch:

- Resolving the current sprint/iteration name "so the brief is precise"
- Looking up ticket IDs, tag spellings, project names, cluster names
- Running `rally-cli`, `kubectl`, `gcloud`, `gh` or any other query the worker
  itself is equipped to run
- Reading the worker's role file to "work out what it needs"
- Rewriting the user's wording into what you judge to be a better prompt

**Pass the user's instruction VERBATIM as the `brief`.** Typos, ambiguity and
all. If they wrote "any PRs the have linked", that string goes in the brief
unchanged.

**Why:** the worker has the role prompt, the skills, the credentials and the
egress that make it the right agent for the job — that is the entire reason it
exists. Pre-resolving details does three things wrong: it burns the user's time
and tokens on work already delegated, it substitutes your understanding of the
task for theirs at the exact moment they were most specific, and it hides which
agent actually produced the answer. A brief you improved is a brief the user did
not write.

**How to apply:** on hearing a worker's name, the NEXT tool call is writing the
task envelope. Discover only what dispatch itself mechanically requires — the
worker's run id — and nothing else. If the instruction is genuinely
undispatchable, ask the user; do not research your way to an answer.

### This applies to CONFIGURING a console, not only to dispatching one

**Recorded 2026-09-07, because it was violated while fixing the triage console.**
Told *"use alert notifier, prometheus and grafana in cni-dev"*, the right next
action was to write those three names into `triage/targets.yaml` and start the
console. What happened instead was a `kubectl get ns` to find the real namespace
spellings, and then a `kubectl get deploy,statefulset` in each one to enumerate
the workloads — through an observer's own container, which is the tell that the
worker equipped to do it was right there.

**Filling a config field is dispatch preparation and the rule covers it.** The
operator gave three service names and an environment; expanding those into
namespaces, workload names and check lists is the discernment the console exists
to perform. An observer that is handed a workload list has been told what it was
supposed to find out, and — worse — it will believe the list. A wrong name in a
targets file becomes `indeterminate`, then a coverage incident, then an operator
sent to a cluster over a typo the host invented.

The narrow exception is unchanged and is worth stating so it is not stretched:
running a read to DIAGNOSE a fault the user reported ("the observers had auth
problems") is answering their question, not doing a worker's job. The line is
whether the answer becomes an instruction you hand a worker. Diagnosis, yes;
pre-filling the brief or the targets file, no.

Corollary: **do not summarise, second-guess or "improve" the worker's output
either.** Relay it. Add your own analysis only if asked, and mark it as yours.

---

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ProjectManager** | "run ProjectManager on <repo> against <SRD>", "implement this SRD with the fleet", "run the SRD through the fleet", "have the fleet build <SRD path>", "project-manage this SRD" | `Workflows/ProjectManager.md` |
| **DispatchTask** | "use tick-1", "send this to eng-1", "get the fleet to…", "ask the observer" | `Workflows/DispatchTask.md` |
| **Consoles** | "recreate the operations workspace", "rebuild the development console", "open the review console", "open the triage console", "open the consoles", "restart tst-1", "make it a python worker", "launch it from <repo>" | `Workflows/Consoles.md` |
| **Observe** | "what is the fleet doing", "is eng-1 still working", "show me the transcript" | `Workflows/Observe.md` |
| **Intervene** | "steer eng-1", "abort that task", "unstage it", "take the terminal" | `Workflows/Intervene.md` |
| **Triage** | "start triaging", "sweep now", "is the triage console running", "what is triage saying", "why did I get that alert" | `Workflows/Triage.md` |

---

## The fleet

| Worker | Role | Console | Toolchain | Notes |
|--------|------|---------|-----------|-------|
| `obs-1` | observer | operations | `base` | read-only cluster/log questions; has cloud access |
| `tick-1` | ticketing | operations | `base` | Rally via `TICKET_*` secrets; egress to `rally1.rallydev.com` |
| `eng-1`, `eng-2` | engineer | development | `node` | hosted model, own git checkout, no egress |
| `tst-1`, `tst-2` | tester | development | `python` | hosted model, own git checkout, egress to the registries |
| `col-1` | collator | review | `base` | writes the fan-out request; does not review |
| `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` | reviewer | review | `base` | three vendors, read-only, `shared-ro` |
| `tri-1` | triage | triage | `base` | the collator: partitions the environment's services and collates the sweep. **Local `gpt-oss-20b-MXFP4-Q8`** |
| `obs-t1`, `obs-t2`, `obs-t3` | triage | triage | `base` | one share of services each, per sweep. Same local model; `tools: [read, write, grep, find, ls]` |

**This table describes the operator's own `~/repos/cmux-fleet/fleet.yaml`**, which
is gitignored. The tracked `fleet.example.yaml` differs in three ways worth
knowing before it is used to reason about this one: its `tester` role declares no
`egress_access` and its `egress.allow` names no package registry, so **"egress to
the registries" is false there**; its development seats run local oMLX models
rather than hosted ones; and the `review` console's four seats are not declared in
it at all. **The `triage` console's four ARE** — `{id: tri-1, role: triage}` and the three
`obs-t*` seats appear in both files, on the local `gpt-oss-20b-MXFP4-Q8` the role pins, so the
example can stand that console up where it cannot stand up `review`. Checked 2026-09-07 rather
than assumed: the `workers:` block is a LIST of `{id, role}` maps, and a `^\s+<id>:` search over
it finds nothing and reads as *"not declared"* — which is how this sentence would have grown a
fourth false clause. `rev-1` is gone from both — the development console's fourth seat is
`tst-2` on `role: tester`, and `role: reviewer` now serves the three `review`
console lenses.

Roles, models, secrets, egress and **toolchain** are in
`~/repos/cmux-fleet/fleet.yaml`; per-role system prompts are in `roles/*.md`.
**Read these only when the user asks about configuration** — never as
preparation for a dispatch. The toolchain column is the one exception worth
knowing by heart, because it decides what a worker can even run — see
**Choosing a worker's platform** below.

---

## A worker that has run before is not a clean worker

**Default to recreating a worker as part of dispatching to it.** One command
does both:

```bash
cd <the project the task is about> && \
  ~/repos/cmux-fleet/scripts/development --restart tst-1 --task <envelope.json>
```

**Why.** A `pane_mode: tui` worker keeps its session across dispatches, so the
previous task's context, its half-finished reasoning and its already-answered
question are all still in the window. Measured on this fleet: a re-dispatch to
`tst-1` came back with **the previous task's answer**, replayed as though it
were fresh work. Nothing in the envelope, the status table or the result flagged
it. A restart is the only thing that makes "fresh" mean fresh.

**The safety property, and why it matters more than the speed.** `--task` waits
for the worker to be holding nothing — no `task_id`, no `staged_task_id`, and
`phase: idle` — before it stops anything. Up to 20 minutes by default, polling
every 3s. **If it times out it refuses having torn down nothing at all**, so the
fleet is exactly as it was found and the message names what is holding the
worker. It never recreates over live work. Do not reach for a bare `--restart`
to get around a refusal: that is the destructive one, and it needs the user's
word.

**Restart the worker, not the console.** `--recreate` rebuilds the whole
workspace and downs every run in it — three bystanders killed to refresh one.
`--restart <id>` respawns that one pane; the others are not touched. The pane
keeps its working directory, so the restarted worker comes back with the same
mounts — same repository, same image.

**All three consoles have it.** `scripts/operations` addresses its panes by
title, because not all of them are agents; the other two address them by worker
id:

```bash
~/repos/cmux-fleet/scripts/operations  --restart <title> --task <file>
~/repos/cmux-fleet/scripts/development --restart <id>    --task <file>
~/repos/cmux-fleet/scripts/review      --restart <id>    --task <file>
```

---

## Choosing a worker's platform

Two separate choices, and they are made in different places.

**1. The toolchain — what tools exist in the image.** Set per role in
`fleet.yaml` as `toolchain:`, one of:

| Toolchain | Contains |
|-----------|----------|
| `base` | `gcloud`, `kubectl`, `helm`, `curl`, `jq`, `git`, `ripgrep`, `node` |
| `node` | base + `bun`, `typescript`, `eslint` |
| `python` | **node** + `python3`, `pip`, `uv`, `ruff`, `mypy` |
| `go` | **node** + `go` 1.24, `staticcheck` |
| `full` | python + go |

**Every language toolchain includes node**, structurally — each builds on the
`node` stage. This is deliberate and load-bearing: when `tester` first moved
`node → python` to get pytest, it silently lost `bun`, and the same worker could
no longer run its own repo's suite. **A toolchain adds a platform; it never
trades one away.** Each also ships that platform's typechecker and linter, so a
freshly cloned checkout can be checked before its dependencies are installed.

Changing a role's toolchain means building that image before `up` will use it —
the tag is a hash over the build context, so a stale image is refused rather
than silently run:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts image build --toolchain python
```

**2. The launch directory — which repository the workers work on.** The
directory a console script is run from **becomes the run's repository**. Each
worker gets a worktree of it at `/workspace`, and the harvest reads its diff:

```bash
cd ~/repos/rally-cli && ~/repos/cmux-fleet/scripts/development --restart tst-1
#   -> /workspace is a worktree of ~/repos/rally-cli
#      fleet.yaml's run.repo is not used for this run
```

It overrides `run.repo` in `fleet.yaml`. Two cases leave the configured value
alone: launching from **inside `~/repos/cmux-fleet`** (the fleet's own repo, and
the ordinary case), and launching from a directory that is **not a git
checkout** — `up` builds worktrees, so it needs one. `up` prints which
repository it chose. Confirm rather than assume:

```bash
docker exec -u 10001 <container> ls /workspace
```

**Match the two.** A python project reached by a `node` worker still fails —
the launch directory decides *which* repo, the toolchain decides whether its
tests can run at all.

---

## Quick Reference

| Need | Command |
|------|---------|
| Find a worker's run id | `pifleet status --all --json` |
| Dispatch | `pifleet dispatch --worker <id> --run <run-id> --task <file> --json` |
| Wait | `pifleet wait --task <task-id> --run <run-id> --timeout 20m --json` |
| Result | `pifleet artifacts --task <task-id> --run <run-id> --json` |
| Live view | `pifleet monitor --repo ~/repos/cmux-fleet` |
| Transcript | `pifleet transcript --worker <id> --run <run-id>` |
| Mid-turn correction | `pifleet steer --worker <id> --run <run-id> -m "…"` |
| **Fresh worker, then dispatch** | `./scripts/<console> --restart <id> --task <file>` |
| Restart one worker, nothing else | `./scripts/<console> --restart <id>` |
| Build an image for a platform | `pifleet image build --toolchain <base\|node\|python\|go\|full>` |

---

## Gotchas

- **`--run` is effectively mandatory.** Omitting it targets the most recent live
  run, and each worker is its own run in these consoles — so a bare
  `dispatch --worker tick-1` tries `tick-1`'s id against another worker's control
  socket and fails with `worker tick-1 is unreachable: SocketRequestError`.
  That error means *wrong run*, not *dead worker*. Get the id from
  `status --all --json` first.
- **`via: "staged"` is success, not a warning.** An attended (`pane_mode: tui`)
  worker has no RPC surface, so the envelope is written durably and the trigger
  is not delivered by keystroke. The worker still picks it up. Confirm by
  polling `status` for `phase: busy` — do not re-dispatch.
- **`session_present: false` on a fresh worker is expected.** The transcript file
  appears on the first dispatch, not at `up`.
- **`--recreate` is for the console; `--restart <id>` is for a worker.**
  `--recreate` downs every run the old panes created — refreshing one worker
  with it kills the other three. Reach for `--restart <id>`, which leaves them
  running. Either way, check `status --all` for a worker with a `task_id`
  first and say so before tearing anything down.
- **`--recreate` can strand a pinned workspace half-torn-down.** It stops the
  runs before closing the workspace, and the close then fails with
  `protected: Pinned workspaces can't be closed while pinned` — by which point
  the agents are already gone. Recovery is
  `cmux workspace-action --action unpin --workspace <id>` and a retry. Known
  defect, unfixed; one more reason to prefer `--restart`.
- **A changed toolchain needs its image built.** The tag is a hash over the
  build context, so editing `fleet.yaml` or the Dockerfile alone leaves `up`
  refusing a stale tag rather than running one. Build it:
  `pifleet image build --toolchain <name>`.
- **If a worker tests the wrong repository, check where the console was
  launched from — not the worker.** Measured three times: `tst-1`, briefed to
  test `~/repos/rally-cli`, ran **cmux-fleet's** suite instead, because
  `/workspace` was cmux-fleet and that is what "the repository" meant. It was
  not disobeying. Two rounds of documentation did not move it and could not;
  making the launch directory the workspace fixed it on the first try. The
  lesson generalises: **a worker doing the wrong thing consistently is usually
  being handed the wrong thing.**
- **The consoles are not the fleet.** Workers survive a closed cmux window;
  `status --all` is the truth, a visible pane is not.
