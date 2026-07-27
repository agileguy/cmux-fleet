---
project: cmux-fleet
task: Implement the pifleet SRD as a working Bun/TypeScript CLI, phase by phase
effort: E4
phase: build
progress: 0/160
mode: build
started: 2026-07-27
updated: 2026-07-27
---

# cmux-fleet — Ideal State Artifact

Implements `Docs/SRD.md` (SRD-PIFLEET-001 v2.3). The SRD is the *design*; this ISA is the
*done condition*. Where they disagree, the ISA's criteria are what gets tested and the SRD
gets an erratum entry in `## Changelog`.

## Problem

Claude can drive one coding agent at a time, in its own context, at its own pace. Work that
decomposes into six independent investigations — six services to diagnose, six modules to
port, one fix plus five verifications — serializes anyway, because there is no way to hand a
task to a *separate* agent and get a trustworthy artifact back.

cmux can show N panes of N agents. That solves the *display*, not the *handoff*. Reading a
pane's rendered text back is lossy, racy, and unparseable: ANSI escapes, reflow on resize,
scrollback eviction, no completion signal. An orchestrator built on screen-scraping cannot
tell "the agent finished and succeeded" from "the agent printed the word success". And an
unsandboxed agent with a bash tool, pointed at a real repo with real cloud credentials, can
rewind a worktree or delete a deployment — that already happened once on this machine.

There is no tool that lets Claude configure a fleet, dispatch typed tasks to it, know
authoritatively when each task settled, and harvest each agent's work as structured
artifacts — with the blast radius bounded.

## Vision

Claude writes six task envelopes, runs one command, and walks away. Six containers wake up,
each with exactly the skills its role needs and no credential it does not need. cmux shows
six live panes — because a human wants to *watch* — but nothing about the run depends on
those panes existing. When the tasks settle, `pifleet artifacts --all --json` returns six
structured results whose claims have been checked against the actual git diffs, and a worker
that says it succeeded while changing nothing is reported as failed. The euphoric surprise is
that closing a pane, or never opening one, changes nothing at all.

## Out of Scope

Not in v1: a hosted/multi-user service; any non-Pi agent backend; Windows; running workers on
a remote host (all containers are local to the Docker host that also runs oMLX); a web UI;
automatic PR creation or merging by workers; cloud-hosted inference of any kind; cost
accounting in currency (local models are unpriced — `tokens_ceiling` is the only ceiling);
and autonomous task decomposition (Claude writes the envelopes; pifleet dispatches them).

The `tui` pane mode (Phase 6) is explicitly a *degraded* mode that voids ten requirements;
it is a convenience for attended debugging, not the supported path.

## Principles

- **The pane is a view, not a channel.** Every control-plane fact comes from the Pi RPC
  stream, the session transcript, or the outbox — never from rendered pane text. Presentation
  can be deleted without loss.
- **Ground truth is the installed binary.** Interfaces are verified by executing the pinned
  version, not by reading a documentation site. v1.1 of the SRD invented three protocol
  messages this way and would have hung on every task.
- **Self-report is a claim, not a fact.** A worker's own verdict is adjudicated against
  independent evidence (git diff, acceptance commands, transcript) before it is believed.
- **Least authority per role.** A role gets the credentials, tools, and skills its job needs
  and nothing else; the default is deny.
- **Failure must be loud and fast.** A wedged agent, a silent no-tool-call loop, or a blown
  budget terminates with a named diagnosis rather than hanging until a human notices.

## Constraints

- Bun + TypeScript. `bun test` is the test runner. No npm/yarn/pnpm (corporate proxy).
- Pi is pinned to **0.79.6**; cmux to **0.64.20**. Version drift fails `doctor`.
- Every worker runs inside a Docker container: read-only root, uid 10001, tini as PID 1.
- The LLM is **always** local oMLX on the Docker host (`host.docker.internal:8000`). No
  cloud inference, ever. No provider API key enters a container except `OMLX_API_KEY`.
- Google credentials enter containers as a ~1h **access token** only. A refresh token must
  never be present, and `~/.config/gcloud` is never mounted.
- Mutating `gcloud`/`kubectl`/`helm` verbs pass through the `verbgate` PATH shim and require
  task-scoped authorization.
- No AI attribution in any commit message, PR description, or code comment.
- The `headless` backend must run the entire acceptance suite with cmux not installed.

## Goal

`pifleet` is a Bun CLI that brings up a configurable fleet of containerized Pi 0.79.6 workers
— optionally surfaced as cmux panes — accepts typed task envelopes, detects completion
authoritatively via `agent_end{willRetry:false}` plus a correlated `get_state` fence, and
returns adjudicated structured artifacts, with all 160 criteria below passing and the full
suite green on `headless` against a test double.

## Criteria

### Group A — Repository foundation (Phase 0)

- [ ] ISC-1: `bun install` in a clean clone exits 0.
- [ ] ISC-2: `bun run typecheck` exits 0 with zero errors.
- [ ] ISC-3: `bun test` exits 0 with at least one passing test.
- [ ] ISC-4: `Docs/SRD.md` exists in the repo and is byte-identical to the source SRD at the commit that imported it.
- [ ] ISC-5: `ISA.md` exists at the repo root and parses as valid YAML frontmatter plus twelve sections.
- [ ] ISC-6: A GitHub Actions workflow runs typecheck, unit, integration, and e2e as separate named steps.
- [ ] ISC-7: CI passes on the default branch.
- [ ] ISC-8: `README.md` documents install, `pifleet doctor`, and the six-phase status.
- [ ] ISC-9: `CHANGELOG.md` exists and has an entry for every merged phase.
- [ ] ISC-10: `git log --format=%B` over all commits contains no AI/LLM/Claude attribution string.
- [ ] ISC-11: The repo has a remote and `gh pr list --state all` returns one PR per completed phase.
- [ ] ISC-12: `package.json` pins `commander`, `zod`, and `yaml`; the lockfile is committed.
- [ ] ISC-13: `src/` compiles under `strict: true` with `noUncheckedIndexedAccess`.
- [ ] ISC-14: `bun run src/cli/index.ts --help` lists every command in SRD §10.

### Group B — Test infrastructure

- [ ] ISC-15: `test/unit`, `test/integration`, and `test/e2e` each contain at least one test file and run independently via their own script.
- [ ] ISC-16: `bun test test/unit` completes in under 30s with no Docker daemon running.
- [ ] ISC-17: `pifleet-fake-pi` (the test double) speaks the RPC framing and is invoked by the e2e suite.
- [ ] ISC-18: The double can be scripted to emit an arbitrary event sequence from a fixture file.
- [ ] ISC-19: The e2e suite runs `up → dispatch → wait → artifacts` end-to-end against the double.
- [ ] ISC-20: Integration tests exercise real subprocess spawning, real filesystem, and real git, with no network.
- [ ] ISC-21: No test in the `headless` suite requires network egress.
- [ ] ISC-22: A test-coverage report can be produced and lists every `src/` module.

### Group C — Container image

- [ ] ISC-23: `image build --toolchain node` produces an image whose `pi --version` matches the pinned version.
- [ ] ISC-24: `image verify` fails on an image whose Pi version differs from config.
- [ ] ISC-25: A worker container runs as uid 10001.
- [ ] ISC-26: A worker container runs with a read-only root filesystem.
- [ ] ISC-27: A file written to `/workspace` appears in the host worktree.
- [ ] ISC-28: A file written in the host worktree appears at `/workspace`.
- [ ] ISC-29: `/skills` is read-only inside the container; a write attempt fails.
- [ ] ISC-30: The host `~/.pi/agent` is not mounted in any container.
- [ ] ISC-31: `docker inspect` shows no cloud provider key in any container's environment (only `OMLX_API_KEY`).
- [ ] ISC-32: `up` refuses to start when a role's image is missing.
- [ ] ISC-33: `gcloud version` succeeds inside every worker image regardless of `toolchain`.
- [ ] ISC-34: `kubectl version --client` succeeds inside every worker image.
- [ ] ISC-35: `helm version` succeeds inside every worker image.
- [ ] ISC-36: `jq --version` succeeds inside every worker image.
- [ ] ISC-37: `curl --version` succeeds inside every worker image.
- [ ] ISC-38: PID 1 in a worker container is `tini`.
- [ ] ISC-39: The container entrypoint renders `~/.pi/agent/models.json` from env and Pi registers the oMLX provider (SRD Q9).
- [ ] ISC-40: The rendered `models.json` survives the read-only root (written to a writable tmpfs path Pi reads).

### Group D — Google credentials

- [ ] ISC-41: With `cloud_access: true` and `adc_mode: token`, `gcloud auth print-access-token` succeeds inside the container.
- [ ] ISC-42: In `token` mode, no `refresh_token` appears in the container environment.
- [ ] ISC-43: In `token` mode, no `refresh_token` appears anywhere on the container filesystem or in `/creds`.
- [ ] ISC-44: The host `~/.config/gcloud` directory is not in any container's `docker inspect` mount list.
- [ ] ISC-45: A role with `cloud_access: false` has no Google credential.
- [ ] ISC-46: In a `cloud_access: false` role, `gcloud auth print-access-token` fails.
- [ ] ISC-47: After `token_refresh` elapses, a `gcloud` call inside a long-running container still succeeds.
- [ ] ISC-48: With `impersonate_service_account` set, the token's identity is the SA, not the launching user's account.
- [ ] ISC-49: `up` prints the granted identity, project, and ADC mode for every `cloud_access` worker.

### Group E — Local model (oMLX)

- [ ] ISC-50: A container completes a model call against `host.docker.internal:8000`.
- [ ] ISC-51: That call succeeds with no route to the public internet.
- [ ] ISC-52: A model outside `models_allowlist` is refused at `up` with exit 2.
- [ ] ISC-53: A model that answers a `tools`-bearing probe with prose is refused at `up` with exit 2.
- [ ] ISC-54: `doctor` reports the oMLX model list.
- [ ] ISC-55: `doctor` reports a measured single-request oMLX latency.
- [ ] ISC-56: `up` refuses to start while an MLX training run is active, unless `--i-know` is passed.
- [ ] ISC-57: Egress to any host other than the oMLX endpoint and the configured Google endpoints is denied from inside a container.

### Group F — Configuration

- [ ] ISC-58: `config validate` exits 2 with a field-level error on a malformed config.
- [ ] ISC-59: `config validate` rejects a role combining `bash` with `read_only: true`.
- [ ] ISC-60: `render --worker eng-1` emits the expected normalized argv without spawning anything.
- [ ] ISC-61: Changing the length of `workers:` changes the container count, with no other edit.
- [ ] ISC-62: Two roles produce different `--model` values.
- [ ] ISC-63: Two roles produce different `--skill` sets.
- [ ] ISC-64: A role that overrides `skills:` still receives `pifleet-worker`.
- [ ] ISC-65: Multiple briefing fragments produce exactly one `--append-system-prompt` argument.
- [ ] ISC-66: No rendered argv contains an `@`-prefixed path.
- [ ] ISC-67: All six SRD roles (`sre`, `investigator`, `verifier`, `engineer`, `reviewer`, `tester`) load from the default config.
- [ ] ISC-68: An unknown role name referenced by a worker fails `config validate` with a named error.

### Group G — Lifecycle

- [ ] ISC-69: `up` returns a `run_id`.
- [ ] ISC-70: Every worker reaches `idle` within 60s of `up`.
- [ ] ISC-71: `status --json` reflects `busy` within 2s of dispatch.
- [ ] ISC-72: `down` leaves no running container for that run.
- [ ] ISC-73: `down` leaves no supervisor process for that run.
- [ ] ISC-74: Closing a worker's pane does not stop the worker in rpc mode; the task still settles.
- [ ] ISC-75: Killing the `pifleet` CLI mid-run leaves supervisors running.
- [ ] ISC-76: After the CLI is killed, `status --run` re-attaches and `wait` still returns a verdict.
- [ ] ISC-77: No supervisor has the CLI or a pane shell as its parent: `pgid == pid`.
- [ ] ISC-78: A supervisor's session id differs from the launcher's.

### Group H — Dispatch and completion

- [ ] ISC-79: A dispatched task appears in the transcript as a `UserMessage`.
- [ ] ISC-80: `steer` injects a message that appears before the next assistant turn.
- [ ] ISC-81: `abort` returns the worker to `idle` within 10s.
- [ ] ISC-82: A scenario emitting `agent_end{willRetry:true}` then continuing is not reported complete.
- [ ] ISC-83: A scenario settling on an aborted turn is reported `aborted`, not `success`.
- [ ] ISC-84: The SRD §7.5 interleaving scenario does not attribute epoch N's diff to epoch N+1.
- [ ] ISC-85: Re-dispatching a completed `(worker, task_id, epoch)` is a no-op returning `already_completed`.
- [ ] ISC-86: A `prompt` that acks then fails late fails its epoch rather than reporting accepted.
- [ ] ISC-87: Completion is detected via `agent_end{willRetry:false}` plus a correlated `get_state` showing `isStreaming:false` and `pendingMessageCount:0`.

### Group I — Artifacts

- [ ] ISC-88: `artifacts --task T --json` validates against the `pifleet.result/v1` schema.
- [ ] ISC-89: The `verdict` field validates against the SRD §7.3 domain.
- [ ] ISC-90: The reported diff equals `git diff` on the worker's branch.
- [ ] ISC-91: Killing a worker after edits but before `result.json` still yields a reconstructed verdict.
- [ ] ISC-92: A worker claiming a file it did not change is flagged.
- [ ] ISC-93: A worker whose envelope says `success` with an empty diff is reported failed.
- [ ] ISC-94: A missing envelope does not downgrade a task with a clean diff and green acceptance commands.
- [ ] ISC-95: `session_path` in `state.json` equals the path `get_state` reported; no globbing occurs.
- [ ] ISC-96: A worker that dies before its first assistant message is distinguishable from one with a wrong path.
- [ ] ISC-97: Harvesting a transcript mid-write succeeds and resumes on the next poll.
- [ ] ISC-98: A transcript containing `U+2028` inside a JSON string parses correctly.
- [ ] ISC-99: A 4-byte codepoint split across a poll boundary produces no `U+FFFD`.
- [ ] ISC-100: A session file that shrinks or changes inode is re-read from offset 0.
- [ ] ISC-101: `transcript --html` produces an openable file.
- [ ] ISC-102: The outbox envelope contract is enforced by schema before any field is dereferenced.

### Group J — Safety and security

- [ ] ISC-103: A `kubectl get` in a `cloud_access` worker succeeds.
- [ ] ISC-104: A `kubectl delete` not in `cloud_allow[]` exits 77 and is refused.
- [ ] ISC-105: A mutating verb named in the task's `cloud_allow[]` executes.
- [ ] ISC-106: That permitted mutating verb is recorded in the ledger with task id and argv.
- [ ] ISC-107: Every cloud invocation, permitted or refused, appears in the run ledger.
- [ ] ISC-108: A worker completing 3 turns with zero tool calls is classified `failed:no_tool_calls`.
- [ ] ISC-109: With 6 workers up and `max_concurrent: 2`, at most 2 have an in-flight generation at any sampled moment.
- [ ] ISC-110: A worker queued behind others is not killed as wedged before `event_stall_warn` elapses.
- [ ] ISC-111: A dialog `extension_ui_request` is answered `{cancelled:true}` within 5s.
- [ ] ISC-112: An `editor` extension UI request does not hang the run.
- [ ] ISC-113: Fire-and-forget UI methods receive no response and are logged.
- [ ] ISC-114: Exceeding `tokens_ceiling` halts dispatch and exits 5, with artifacts still harvested.
- [ ] ISC-115: Exceeding `tokens_ceiling` halts a run whose reported cost is 0 throughout.
- [ ] ISC-116: A task exceeding `deadline_s` is aborted and reported `timed_out` with exit 4.
- [ ] ISC-117: A wedged agent (no events, live heartbeat) is killed at `event_stall_kill`.
- [ ] ISC-118: A wedged supervisor is reaped by the daemon.
- [ ] ISC-119: A repo carrying `.pi/extensions/hostile.ts` and a hostile `AGENTS.md` changes nothing about the run.
- [ ] ISC-120: An envelope naming `/Users/dan/.env` is refused before dereference.
- [ ] ISC-121: A symlink in `<outbox>/files` pointing outside the outbox is refused.
- [ ] ISC-122: An oversized envelope field is rejected without OOM.
- [ ] ISC-123: No ref outside `fleet/<run-id>/*` moves during a run.
- [ ] ISC-124: The main checkout's `git status --porcelain` is unchanged after a run.
- [ ] ISC-125: A seeded escape attempt from inside a container is detected and reported.
- [ ] ISC-126: The control socket refuses a connection from another uid.
- [ ] ISC-127: The run-dir is not mounted in any container.

### Group K — Backends

- [ ] ISC-128: The full acceptance suite passes on `headless` with cmux not running.
- [ ] ISC-129: `up` on the cmux backend creates one workspace and N panes, each showing its worker id and live activity.
- [ ] ISC-130: `attach --worker eng-2` focuses that pane.
- [ ] ISC-131: With the cmux socket unreachable, `up` exits 3 with a named diagnosis or falls back to `tmux`.
- [ ] ISC-132: `doctor` reports `read-screen` availability, and the run succeeds identically either way.
- [ ] ISC-133: `doctor` exits 3 when a `required` cmux CLI command is missing.
- [ ] ISC-134: The `tmux` backend brings up N panes and the same acceptance results as `headless`.

### Group L — Anti-criteria

- [ ] ISC-135: Anti: disabling `read-screen` entirely changes no acceptance result.
- [ ] ISC-136: Anti: no code path outside diagnostics calls `readScreen()`.
- [ ] ISC-137: Anti: no file under `src/` imports a cmux symbol outside `src/backends/cmux/`.
- [ ] ISC-138: Anti: no code path uses `readline` or `split(/\r?\n/)` on an RPC or session stream.
- [ ] ISC-139: Anti: no generated commit, branch, or PR body contains AI attribution.
- [ ] ISC-140: Anti: no acceptance test in the `headless` suite requires provider spend or a cloud endpoint.

### Group M — Review findings (added 2026-07-27, post-advisor)

Criteria that came out of the commitment-boundary review. Several correct the SRD
rather than merely implementing it; SRD errata are recorded in `## Changelog`.

- [ ] ISC-141: Epoch attribution uses the RPC stream offset, and the SRD §7.5 interleaving is decided correctly when offset is the only distinguishing signal.
- [ ] ISC-142: A dispatch whose epoch is `<=` the worker's persisted `last_accepted_epoch` is rejected at the worker side, not merely bookkept by the allocator.
- [ ] ISC-143: The epoch high-water-mark is durable before dispatch; allocate → crash → restart does not re-issue the same epoch.
- [ ] ISC-144: The run-dir lease keys on pid plus process start-time, so a recycled pid is not mistaken for a live supervisor.
- [ ] ISC-145: A retried dispatch carrying the same `(task_id, attempt_uuid)` replays the stored response rather than returning a bare `already_completed`.
- [ ] ISC-146: Every deadline and stall timer uses a monotonic clock; a wall-clock jump fires none of them early.
- [ ] ISC-147: Across every hostile scenario, completion is never declared while the agent will still emit output.
- [ ] ISC-148: Acceptance commands are resolved from the base SHA, not read out of the worker's tree.
- [ ] ISC-149: Acceptance commands run in a fresh clone by SHA, outside the worker's worktree, with no inherited environment.
- [ ] ISC-150: A diff touching the test-harness surface caps the verdict at `blocked` or `unknown` and can never yield `success`.
- [ ] ISC-151: `git merge-base --is-ancestor <base_ref> HEAD` is verified at harvest, so a rewritten base cannot shrink the diff to nothing.
- [ ] ISC-152: A timed-out acceptance command yields `unknown`, not `failed`.
- [ ] ISC-153: The derived-fact bundle is hashed and recorded, so an adjudication can be replayed.
- [ ] ISC-154: A worktree content hash differing between quiesce and harvest end forces `unknown` (backgrounded work kept writing).
- [ ] ISC-155: Anti: no timeout, deadline, or stall computation reads `Date.now()`.
- [ ] ISC-156: A SIGKILL at each syscall boundary of the atomic-write path leaves state recoverable and the ledger readable.
- [ ] ISC-157: A ledger written under an older schema version is read under a pinned, tested policy rather than crashing.
- [ ] ISC-158: At 16 workers, no container-name or port collision occurs and no worker's event loop is starved by another's output.
- [ ] ISC-159: `doctor` exits nonzero with an actionable message on a missing binary, a wrong version, and an absent daemon.
- [ ] ISC-160: A stale image is not silently reused after the Dockerfile changed.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-1..3 | build | clean-clone install, typecheck, test | exit 0 | `bun` |
| ISC-4 | integration | byte-compare SRD copy against source | `cmp` silent | `cmp` |
| ISC-5 | unit | frontmatter + section parse | 12 sections found | `bun test` |
| ISC-6..7, ISC-11 | e2e | workflow run + PR list | all steps green | `gh` |
| ISC-8..9, ISC-12 | unit | file presence + content assertions | pattern match | `bun test` |
| ISC-10, ISC-139 | integration | scan all commit bodies for banned strings | zero matches | `git log` + `rg` |
| ISC-13 | build | strict typecheck | zero errors | `tsc` |
| ISC-14 | e2e | `--help` output vs SRD §10 command list | every command present | `bun test` |
| ISC-15..16, ISC-20..22 | integration | suite isolation, timing, no-network assertion | under 30s; zero sockets | `bun test` |
| ISC-17..19 | e2e | scripted double drives full run | verdict returned | `pifleet-fake-pi` |
| ISC-23..40 | integration | `docker run` probes against a built image | each command exit 0 | `docker` |
| ISC-31, ISC-44, ISC-127 | integration | `docker inspect` env + mount list | zero matches | `docker inspect` + `jq` |
| ISC-41..49 | integration | in-container gcloud probes | token identity + expiry behaviour | `docker exec` |
| ISC-50..57 | integration | in-container model call + allowlist refusal | exit codes 0 / 2 | `curl`, `pifleet up` |
| ISC-58..68 | unit | config loader + renderer, table-driven | exact argv match | `bun test` |
| ISC-69..78 | e2e | lifecycle against the double | states + `pgid == pid` | `bun test`, `ps` |
| ISC-79..87 | e2e | scripted event sequences per scenario | verdict matches expectation | fixture scenarios |
| ISC-88..102 | integration | schema validation + harvest fixtures | zod parse passes | `bun test` |
| ISC-103..107 | integration | verbgate shim behaviour + ledger read-back | exit 0 / 77; ledger row present | `docker exec` |
| ISC-108..118 | e2e | seeded stall/budget/timeout scenarios | named terminal state + exit code | fixture scenarios |
| ISC-119..127 | integration | seeded hostile repo, envelope escapes, socket uid | refusal recorded | `bun test` + `docker` |
| ISC-128..134 | e2e | backend matrix | identical verdicts across backends | `bun test` (manual for cmux) |
| ISC-135..138, ISC-140 | unit | static analysis over `src/` and `test/` | zero matches | `rg` in a test |

Live-probe rule: every ISC touching a container, a socket, or a process is verified by running
the real thing, not by asserting on a mock. Mocks are permitted only inside `test/unit`.

## Features

| name | description | satisfies | depends_on | parallelizable |
|---|---|---|---|---|
| repo-foundation | Repo skeleton, tsconfig, CI, README, test scaffolding, fake-pi double | ISC-1..22 | — | no |
| container-image | Dockerfile, toolchain layers, entrypoint, `image` subcommands, verbgate build | ISC-23..40 | repo-foundation | yes |
| config-renderer | Zod config schema, role merge, argv renderer, `config validate`, `render` | ISC-58..68 | repo-foundation | yes |
| rpc-core | RPC client, framing, epoch fencing, completion detector, supervisor launcher | ISC-79..87 | repo-foundation | no |
| lifecycle | `up`/`down`/`status`/`daemon`, detached supervisors, run registry, reaper | ISC-69..78 | rpc-core, container-image | no |
| artifacts | Outbox contract, harvester A1/A2/A4/A6, adjudicator, `artifacts`/`transcript`/`harvest` | ISC-88..102 | rpc-core | yes |
| safety | Budget ceilings, kill ladder, envelope hardening, worktree isolation, UI-request handling | ISC-108..127 | lifecycle, artifacts | yes |
| cloud-identity | ADC token injection + refresh, egress bridge, verbgate runtime, ledger | ISC-41..57, ISC-103..107 | container-image | yes |
| backends | cmux backend (password mode, viewer panes), tmux backend, headless backend | ISC-128..134 | lifecycle | yes |
| orchestration | `dispatch --auto`, dependencies, `report` + merge pre-check, role briefings, Fleet skill | ISC-67, ISC-85 | all above | no |
| attended | `tui` pane mode, `steer`, live model switch | ISC-80 | backends | no |

## Decisions

- **2026-07-27 — Project ISA, not task ISA.** cmux-fleet is a thing with persistent identity, so
  the ISA lives at `~/repos/cmux-fleet/ISA.md` as system of record, per Algorithm v6.3.0 §ISA homes.
- **2026-07-27 — 140 ISCs from 89 SRD acceptance criteria.** Compound SRD criteria were split per
  the Splitting Test (e.g. SRD-9's five toolchain probes became ISC-33..37; SRD-58's two verbs
  became ISC-103/104), and Groups A and B were added because the SRD assumes the repo already
  exists and says nothing about the test pyramid the user explicitly asked for.
- **2026-07-27 — `bun test` over vitest.** The SRD constrains the stack to Bun; adding a second
  test runner would need a second config surface and a second CI install step for no gain.
- **2026-07-27 — Manual git worktrees for parallel engineers.** `isolation: "worktree"` forks the
  calling session's repo (paisley), not the target repo. Worktrees are created with
  `git -C ~/repos/cmux-fleet worktree add`, and every engineer brief carries absolute
  worktree-prefixed paths.
- **2026-07-27 — Phase order follows SRD §16 unchanged.** Phases 1–3 are load-bearing; Phase 3
  precedes any real-repo run because the kill ladder and budget ceilings must exist first.

- **2026-07-27 — refined: epoch attribution moves from a wall-clock window to a stream offset.**
  The SRD discards terminal events "outside an open epoch window", which is not a causal order —
  a late `agent_end` for epoch N is byte-identical to N+1's. Pi's events and responses share one
  ordered stdout stream, so a monotonic per-record `streamSeq` plus the `ackSeq` recorded at
  dispatch gives a real happens-before relation. SRD erratum; see ISC-141.
- **2026-07-27 — the fence is enforced at the worker, not only at the allocator.** "Sole epoch
  allocator" is an assumption a detached supervisor plus a CLI relaunch can violate. The worker
  side persists `last_accepted_epoch` and rejects stale dispatch; the run-dir lease keys on pid
  plus process start-time because pid reuse would otherwise resurrect a dead supervisor. ISC-142..144.
- **2026-07-27 — the harvester's independence was overstated.** Re-running the acceptance commands
  executes an artifact the gradee authored: the command string resolves through `package.json`
  scripts, `conftest.py`, `.git/hooks`, `Makefile` — all inside the mutable surface. Acceptance
  now resolves from the base SHA and runs in a fresh clone outside the worktree, and a diff
  touching the harness surface caps the verdict. This is the single largest correction to the
  SRD's §8.2 adjudication story. ISC-148..151.
- **2026-07-27 — gauges cannot prove quiescence.** `pendingMessageCount:0` sampled twice does not
  mean zero in between, and `isStreaming:false` also describes the gap between a tool call and the
  next turn. The stream-offset fence is the primary defence; monotonic-counter equality is the
  secondary one. ISC-147.
- **2026-07-27 — show your math on delegation.** Two engineers per phase rather than four: the
  Phase 1 surface splits cleanly along a config/container seam and an RPC/lifecycle seam with one
  shared contracts module, and a third writer would have to touch one of those two territories.
- **2026-07-27 — SRD Q1 answered by measurement: oMLX batches, it does not serialize.**
  Probed live on `:8000` with `Qwen3-Coder-30B-A3B-Instruct-4bit`: a single short request took
  1.51s; four concurrent finished in 1.77s wall (3.40x), and the speedup plateaus near 4.1-4.3x
  at N=8-12. So F40's premise — that N workers queue behind one inference server — is wrong as
  stated. The honest caveat is that these were 80-token requests with negligible KV cache, and a
  real agentic turn carries a far larger context, so the memory-bound ceiling will sit below the
  compute-bound one measured here. `max_concurrent: 2` stays the default as a memory-safety
  margin rather than a throughput necessity, and ISC-158 (16 workers, no starvation) is what
  would justify raising it.

## Changelog


- **conjectured:** the SRD's epoch-window rule was sufficient to attribute terminal events to epochs.
  **refuted by:** a commitment-boundary review pointing out that events carry no correlation id, so a
  late `agent_end` for epoch N and a real one for N+1 are byte-identical under a wall-clock window.
  **learned:** the ordering signal was already available and unused — events and responses share one
  stdout stream, so a per-record sequence number yields a genuine happens-before relation.
  **criterion now:** ISC-141 requires the §7.5 interleaving to be decided when stream offset is the
  only distinguishing signal.
- **conjectured:** re-running the acceptance commands gave the harvester facts independent of the
  worker being graded. **refuted by:** the observation that the command string resolves through
  `package.json` scripts, `conftest.py`, `.git/hooks` and the Makefile, every one of which is inside
  the worker's mutable surface — so "independently re-run the tests" grades the worker using the
  worker's own harness. **learned:** independence is a property of *where and from which tree* the
  command is resolved and executed, not of *who* runs it. **criterion now:** ISC-148..150 require
  base-SHA resolution, a fresh clone outside the worktree, and a verdict cap when the diff touches
  the harness surface.

## Verification

*(Evidence per ISC, appended as each criterion passes.)*
