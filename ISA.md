---
project: cmux-fleet
task: Implement the pifleet SRD as a working Bun/TypeScript CLI, phase by phase
effort: E4
phase: build
progress: 104/236
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

- [x] ISC-1: `bun install` in a clean clone exits 0.
- [x] ISC-2: `bun run typecheck` exits 0 with zero errors.
- [x] ISC-3: `bun test` exits 0 with at least one passing test.
- [x] ISC-4: `Docs/SRD.md` exists in the repo and is byte-identical to the source SRD at the commit that imported it.
- [x] ISC-5: `ISA.md` exists at the repo root and parses as valid YAML frontmatter plus twelve sections.
- [x] ISC-6: A GitHub Actions workflow runs typecheck, unit, integration, and e2e as separate named steps.
- [ ] ISC-7: CI passes on the default branch.
- [x] ISC-8: `README.md` documents install, `pifleet doctor`, and the six-phase status.
- [x] ISC-9: `CHANGELOG.md` exists and has an entry for every merged phase.
- [x] ISC-10: `git log --format=%B` over all commits contains no AI/LLM/Claude attribution string.
- [x] ISC-11: The repo has a remote and `gh pr list --state all` returns one PR per completed phase.
- [x] ISC-12: `package.json` pins `commander`, `zod`, and `yaml`; the lockfile is committed.
- [x] ISC-13: `src/` compiles under `strict: true` with `noUncheckedIndexedAccess`.
- [x] ISC-14: `bun run src/cli/index.ts --help` lists every command in SRD §10.

### Group B — Test infrastructure

- [x] ISC-15: `test/unit`, `test/integration`, and `test/e2e` each contain at least one test file and run independently via their own script.
- [x] ISC-16: `bun test test/unit` completes in under 30s with no Docker daemon running.
- [x] ISC-17: `pifleet-fake-pi` (the test double) speaks the RPC framing and is invoked by the e2e suite.
- [x] ISC-18: The double can be scripted to emit an arbitrary event sequence from a fixture file.
- [x] ISC-19: The e2e suite runs `up → dispatch → wait → artifacts` end-to-end against the double.
- [x] ISC-20: Integration tests exercise real subprocess spawning, real filesystem, and real git, with no network.
- [x] ISC-21: No test in the `headless` suite requires network egress.
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

- [x] ISC-88: `artifacts --task T --json` validates against the `pifleet.result/v1` schema.
- [x] ISC-89: The `verdict` field validates against the SRD §7.3 domain.
- [x] ISC-90: The reported diff equals `git diff` on the worker's branch.
- [x] ISC-91: Killing a worker after edits but before `result.json` still yields a reconstructed verdict.
- [x] ISC-92: A worker claiming a file it did not change is flagged.
- [x] ISC-93: A worker whose envelope says `success` with an empty diff is reported failed.
- [x] ISC-94: A missing envelope does not downgrade a task with a clean diff and green acceptance commands.
- [x] ISC-95: `session_path` in `state.json` equals the path `get_state` reported; no globbing occurs.
- [x] ISC-96: A worker that dies before its first assistant message is distinguishable from one with a wrong path.
- [x] ISC-97: Harvesting a transcript mid-write succeeds and resumes on the next poll.
- [x] ISC-98: A transcript containing `U+2028` inside a JSON string parses correctly.
- [x] ISC-99: A 4-byte codepoint split across a poll boundary produces no `U+FFFD`.
- [x] ISC-100: A session file that shrinks or changes inode is re-read from offset 0.
- [x] ISC-101: `transcript --html` produces an openable file.
- [x] ISC-102: The outbox envelope contract is enforced by schema before any field is dereferenced.

### Group J — Safety and security

- [ ] ISC-103: A `kubectl get` in a `cloud_access` worker succeeds.
- [ ] ISC-104: A `kubectl delete` not in `cloud_allow[]` exits 77 and is refused.
- [ ] ISC-105: A mutating verb named in the task's `cloud_allow[]` executes.
- [ ] ISC-106: That permitted mutating verb is recorded in the ledger with task id and argv.
- [ ] ISC-107: Every cloud invocation, permitted or refused, appears in the run ledger.
- [ ] ISC-108: A worker completing 3 turns with zero tool calls is classified `failed:no_tool_calls`.
- [ ] ISC-109: With 6 workers up and `max_concurrent: 2`, at most 2 have an in-flight generation at any sampled moment.
- [x] ISC-110: A worker queued behind others is not killed as wedged before `event_stall_warn` elapses.
- [ ] ISC-111: A dialog `extension_ui_request` is answered `{cancelled:true}` within 5s.
- [ ] ISC-112: An `editor` extension UI request does not hang the run.
- [ ] ISC-113: Fire-and-forget UI methods receive no response and are logged.
- [ ] ISC-114: Exceeding `tokens_ceiling` halts dispatch and exits 5, with artifacts still harvested.
- [x] ISC-115: Exceeding `tokens_ceiling` halts a run whose reported cost is 0 throughout.
- [ ] ISC-116: A task exceeding `deadline_s` is aborted and reported `timed_out` with exit 4.
- [ ] ISC-117: A wedged agent (no events, live heartbeat) is killed at `event_stall_kill`.
- [x] ISC-118: A wedged supervisor is reaped by the daemon.
- [ ] ISC-119: A repo carrying `.pi/extensions/hostile.ts` and a hostile `AGENTS.md` changes nothing about the run.
- [x] ISC-120: An envelope naming `/Users/dan/.env` is refused before dereference.
- [x] ISC-121: A symlink in `<outbox>/files` pointing outside the outbox is refused.
- [x] ISC-122: An oversized envelope field is rejected without OOM.
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
- [x] ISC-146: Every deadline and stall timer uses a monotonic clock; a wall-clock jump fires none of them early.
- [ ] ISC-147: Across every hostile scenario, completion is never declared while the agent will still emit output.
- [ ] ISC-148: Acceptance commands are resolved from the base SHA, not read out of the worker's tree. [IMPLEMENTED + UNIT-VERIFIED, NOT WIRED — `artifacts` does not execute acceptance; see ISC-233]
- [ ] ISC-149: Acceptance commands run in a fresh clone by SHA, outside the worker's worktree, with no inherited environment. [IMPLEMENTED + UNIT-VERIFIED, NOT WIRED — see ISC-233]
- [x] ISC-150: A diff touching the test-harness surface caps the verdict at `blocked` or `unknown` and can never yield `success`.
- [x] ISC-151: `git merge-base --is-ancestor <base_ref> HEAD` is verified at harvest, so a rewritten base cannot shrink the diff to nothing.
- [ ] ISC-152: A timed-out acceptance command yields `unknown`, not `failed`. [IMPLEMENTED + UNIT-VERIFIED, NOT WIRED — no acceptance runs on the live path; see ISC-233]
- [x] ISC-153: The derived-fact bundle is hashed and recorded, so an adjudication can be replayed.
- [ ] ISC-154: A worktree content hash differing between quiesce and harvest end forces `unknown` (backgrounded work kept writing). [LIVE but INERT — nothing populates `tree_hash_quiesce`/`tree_hash_harvest`, so the check cannot fire; needs supervisor cooperation]
- [x] ISC-155: Anti: no timeout, deadline, or stall computation reads `Date.now()`.
- [ ] ISC-156: A SIGKILL at each syscall boundary of the atomic-write path leaves state recoverable and the ledger readable.
- [ ] ISC-157: A ledger written under an older schema version is read under a pinned, tested policy rather than crashing.
- [ ] ISC-158: At 16 workers, no container-name or port collision occurs and no worker's event loop is starved by another's output.
- [ ] ISC-159: `doctor` exits nonzero with an actionable message on a missing binary, a wrong version, and an absent daemon.
- [ ] ISC-160: A stale image is not silently reused after the Dockerfile changed.

### Group N — Mount visibility (added 2026-07-27, found by the Docker-gated suite)

- [x] ISC-161: No host path that pifleet intends to bind-mount is derived from `os.tmpdir()`.
- [x] ISC-162: A bind mount is judged visible only by reading back a host-written sentinel, never by the mount succeeding or by `docker run` exiting 0.
- [x] ISC-163: A failed visibility probe reports that the daemon cannot see the path and names the override, rather than surfacing the bare `cat: No such file` beneath it.
- [x] ISC-164: `doctor` probes the runs root for mount visibility and exits nonzero when a worker's outbox would mount empty.
- [ ] ISC-165: Anti: no `:ro` refusal test passes against a mount whose contents were never readable.

### Group O — PR #1 review findings (added 2026-07-27)

Fixed in this phase:

- [x] ISC-166: The epoch fence post is recorded before any event that follows the ack, including when the ack and the event arrive in one stdout chunk.
- [x] ISC-167: A deadline whose `abort` produces no terminal event still settles the task and kills the child; the worker never stays `busy` forever.
- [x] ISC-168: `writeJsonAtomic` produces a parseable file under concurrent same-path writes and leaves no temp files behind.
- [x] ISC-169: A truncated or wrong-shaped state file exits on the ladder with one line, never a stack trace — including from `down`.
- [x] ISC-170: Every commander-diagnosed usage error exits 2; `--help`/`--version` exit 0; naming no command exits 2.
- [x] ISC-171: A dead child's EPIPE, a `null` record, and a throwing event handler each surface as a diagnosed failure rather than killing the supervisor.
- [x] ISC-173: `TailReader` detects replacement by identity, not size, and never returns a fragment of a record as a complete line.
- [x] ISC-174: `MAX_LINE_UNITS` bounds every emitted line, not only the unterminated residue.
- [x] ISC-175: A role or worker that is `read_only` with no explicit tools is rejected — the effective set is every builtin, `bash` included.
- [x] ISC-176: `unknown` maps to `EXIT.PARTIAL`; only `reason === "worker_died"` maps to `EXIT.WORKER_DIED`.
- [x] ISC-177: `wait` against a run id that names nothing exits 2, never 0.
- [x] ISC-178: `CliError` satisfies the structural `ExitCoded` protocol.
- [x] ISC-179: The verbgate policy path and ledger path are constants; a worker cannot supply its own policy or redirect its own audit trail.
- [x] ISC-180: verbgate refuses every verb (exit 78) when it finds its policy file writable by the current uid.
- [x] ISC-181: gcloud classification stops at the first recognized verb, so a read-keyword positional cannot outvote a mutating verb.
- [x] ISC-182: No verbgate classification path is influenced by the working directory (globbing disabled).
- [x] ISC-183: `gsutil` and `bq` are gated on the same rules as gcloud/kubectl/helm.
- [x] ISC-184: Known global flags before a verb are parsed past; unknown flag shapes still fail closed.
- [x] ISC-185: No ledger row can be forged by control characters in argv, at any argv size.
- [ ] ISC-186: Registry writes are serialized, so concurrent registrations cannot lose a worker.
- [x] ISC-187: `image verify`'s read-only-root check proves the tmpfs is writable as well as that `/` is not.

Open — carried forward, not fixed here:

- [ ] ISC-172: The verbgate ledger is collected outside the container, so a worker cannot truncate its own audit trail.
- [ ] ISC-188: `render.ts` and `run/paths.ts` compute the run directory once, not twice (`outbox`, `skills`, `env`, briefing paths, and `PIFLEET_RUNS_DIR` honoured).
- [ ] ISC-189: `up` refuses to run against an image that is absent or fails `verify`.
- [ ] ISC-190: `models_allowlist` is enforced — a worker whose model is not on the list does not start.
- [x] ISC-191: The kill ladder uses `(pid, started)` identity, never pid alone.
- [ ] ISC-192: A ledger or state file written under an older schema version is read under a pinned policy rather than failing.
- [x] ISC-193: `EXIT.BUDGET` has a producer, or the code is removed from the ladder.

### Group P — CI portability (added 2026-07-27, found the first time CI actually ran the probes)

The container job had been red since it was added: it read `d.images[0].tag` from
`image list --json`, which emits a bare array, so the TypeError killed the step
before it could tag the image. Every Group C and Group J criterion had therefore
been reported against a job that never executed a single probe. Fixing the
extraction ran them for the first time and seven failed at once.

- [x] ISC-194: The container CI job tags the built image from the real `image list --json` shape and fails loudly on an empty list.
- [x] ISC-195: A host directory pifleet bind-mounts is accessible to the worker's uid, not left at `mkdtemp`'s 0700 or `mkdir`'s 0755.
- [x] ISC-196: The scratch root itself is traversable, since a 0700 parent makes every 0777 child unreachable.
- [x] ISC-197: `WORKER_UID` is pinned against the Dockerfile's `USER`, so the permission widening cannot drift onto the wrong account.
- [x] ISC-198: A read-only mount is made traversable and readable without being made world-writable.
- [ ] ISC-199: Anti: no assertion in the suite encodes a platform-specific spelling of a POSIX observation (`ps` printing `??` versus `?`).
- [x] ISC-200: Anti: no CI step can fail in a way that leaves its job green, or pass in a way that never executed its probes.

### Group Q — Round-2 review findings (added 2026-07-27)

Mutation testing was the finding that mattered: five separate mutations of
production code — each reverting a fix a test is *named* after — left the suite
green. A regression test that cannot fail is worse than no test, because it
retires the criterion.

- [x] ISC-201: The epoch placeholder predicate is exported and tested directly; the test no longer re-implements the expression it guards.
- [x] ISC-202: `assertNoAtPaths` is tested against argv that actually contains an `@`, and both call sites are pinned.
- [x] ISC-203: The `willRetry` e2e waits for the retrying `agent_end` to be observed, rather than sleeping for less time than the settle path takes.
- [x] ISC-204: `up`'s call to `makeWorkerAccessible` is pinned by an assertion on the run directory's mode, not only by unit tests of the helper.
- [x] ISC-205: `TailReader` detects an in-place rewrite that regrows past the old offset — inode identity alone cannot see it, and the enabled test returned a record fragment.
- [x] ISC-206: A plain append is never misread as a rewrite; the head fingerprint covers a fixed, already-consumed prefix.
- [x] ISC-207: An oversized line does not discard the records completed before it in the same chunk.
- [x] ISC-208: An oversized unterminated residue is dropped rather than re-thrown on every later push.
- [x] ISC-209: The verbgate ledger fallback sanitizes `task_id` and `epoch`, so a worker cannot append a duplicate `decision` key that `JSON.parse` prefers.
- [x] ISC-210: `gcloud auth print-access-token`, `print-identity-token` and `get-credentials` are refused despite matching the `print-*`/`get-*` read globs.
- [x] ISC-211: Genuine gcloud reads (`list`, `describe`) still reach the real binary and record `allow_read`.
- [x] ISC-212: No `void settle(...)` can turn a durable-write failure into an unhandled rejection that exits the supervisor.
- [x] ISC-213: The CI anti-skip guard asserts an exact probe count and zero skips, instead of a case pattern that cannot match bun's output.
- [ ] ISC-214: `RpcClient` stops dispatching the remainder of a chunk once `#fatal` has closed it.
- [ ] ISC-215: The EPIPE write path sets `#closed`, so the error does not assert a state the object is not in.
- [ ] ISC-216: An undiagnosed internal error is distinguishable by exit code from a usage error.
- [ ] ISC-217: A malformed `epoch` (negative, fractional) is a named error rather than silently normalized to a fresh allocation.
- [ ] ISC-218: `writeJsonAtomic`'s directory-fsync failure cannot report a durable write as failed after the rename succeeded.
- [ ] ISC-219: The verbgate policy-rewrite test attempts the `/outbox` path the pre-fix shim actually read, not only the path the fix uses.

### Group R — Round-3 mutation review (added 2026-07-27)

Round 3 mutation-tested the round-2 *fixes*. Three of six were genuinely covered
(dispatch, jsonl, verbgate); three were not, and one fix introduced a new defect
of the same class it repaired.

- [x] ISC-220: The `@`-guard sits in the data path and returns its argv, so a disabled call site fails to compile rather than passing a source-text grep.
- [x] ISC-221: Anti: no test asserts a production invariant by grepping the source text of the file that implements it.
- [x] ISC-222: A `settle()` rejection is observably survivable — the supervisor is still alive and answering after every durable write in the settle path fails.
- [x] ISC-223: The oversized-line drop resyncs to the next newline, so the continuation of the rejected record is never emitted as a complete line.
- [x] ISC-224: A resync spanning several pushes still emits no fragment.
- [x] ISC-225: An unreadable head fingerprint is treated as unknown, not as changed, so a transient read error cannot replay the whole file as new records.
- [x] ISC-226: A failed head anchor is retried on later polls rather than silently disabling rewrite detection for the reader's lifetime.
- [x] ISC-227: The `willRetry` e2e states plainly that its discrimination comes from `completion.test.ts`, not from itself — the double reports `isStreaming: true` for a retrying `agent_end`.
- [ ] ISC-228: The `late_prompt_failure` settle guard has its own test, not only the deadline-escalation one.
- [ ] ISC-229: Anti: no scenario file exists without a reviewed `EXPECTED_SETTLES` entry.

### Group S — Phase 2 findings (added 2026-07-27)

- [x] ISC-230: An acceptance command that was attempted and returned no answer caps the verdict — a timed-out exam cannot certify success, and the worker's claim is not adopted.
- [x] ISC-231: `workerOutboxDir()` lives in `run/paths.ts`, computed once, rather than duplicating the expression inlined in `render.ts`.
- [ ] ISC-232: Harness-surface patterns come from config; `DEFAULT_HARNESS_PATTERNS` is the fallback, not the source of truth.
- [ ] ISC-233: Acceptance commands run in a fresh CONTAINER from the same image, not only a fresh clone (SRD §8.2).
- [ ] ISC-234: The control socket answers `export_html`, so `transcript --html` uses the live path rather than the local-render fallback.
- [ ] ISC-235: `BudgetManager.admit` is called on the dispatch path and its snapshot persisted; `budgetExitCode` folds into `worstExit` after harvest.
- [x] ISC-236: The daemon calls `reapStale` on an interval and deregisters the workers it reports.
- [x] ISC-237: `runGit` executes nothing the graded repository names — no external diff driver, textconv or fsmonitor, and no inherited environment.
- [x] ISC-238: One task that cannot be harvested degrades to `harvest_status` alone; `artifacts --all` still emits valid JSON and exits 0 for every other task.
- [x] ISC-239: Containment under the outbox is checked at the ROOTS, so a symlinked `files/` or task directory cannot launder outside content into `safe`.
- [x] ISC-240: An envelope path containing a control character is refused; nothing worker-authored reaches an operator's terminal unescaped.
- [x] ISC-241: `pifleet artifacts` adjudicates through `harvest/adjudicate.ts`; the evidence rules are on the live path, not only under test.
- [x] ISC-242: The harness surface covers files the test command RESOLVES THROUGH — runner config, inherited config, toolchain selection — not only files that look like tests.
- [ ] ISC-243: Anti: the harness surface is a denylist and cannot be complete; a graded allowlist of the resolution surface replaces it.

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
- **2026-07-27 — refined: engineer briefs are sized per subsystem, not per phase.** Both Phase 1
  engineers were truncated at a context ceiling (226k and 241k tokens), not finished — each stopped
  on a statement of intent, and the harness reported it as completion. Engineer B's brief listed 24
  files across seven subsystems. Remaining phases dispatch ~10-14 files per engineer, keep image
  builds in the parent so build logs do not consume an engineer's budget, and treat integration and
  e2e suites as their own dispatch unit because that is reliably what gets cut.
- **2026-07-27 — scratch directories that get bind-mounted live under `$HOME`, never `os.tmpdir()`.**
  Measured on this machine: Colima shares `$HOME` and shares neither `/tmp` nor
  `/var/folders/...`. An unshared `-v` source does not error — the daemon mounts an empty
  directory in its place. `image verify` therefore failed on a perfectly good image, and the
  same mistake in the worker launch path would give every worker an empty `/workspace` and an
  outbox the harvester never sees, with exit 0 throughout. Scratch allocation moves to
  `container/mounts.ts` (`PIFLEET_SCRATCH_DIR`, default `~/.pifleet/scratch`), visibility is
  proved by reading back a sentinel rather than by a successful mount, and `doctor` probes the
  runs root so the failure is loud and early. The default runs root was already under `$HOME`
  and was never affected; `PIFLEET_RUNS_DIR` pointing elsewhere was, which is what ISC-164 guards.

## Changelog


- **conjectured:** the 4 MiB byte cap also bounds the COST of validating an envelope, so ISC-122 needs
  no element-count limb. I measured 1,048,550 elements at 127 MB / 46 ms — about 30x — and recorded the
  reported 2.88 GB figure as quantitatively refuted.
  **refuted by:** my own measurement, of the wrong shape. The reviewer's elements were INVALID for their
  field; mine were valid. zod type-validates every element and allocates one issue object per FAILING
  element before it ever reports the length violation, so the cost is a function of how many elements are
  wrong, not how many there are. Re-measured with invalid elements: 2,097,101 of them in exactly 4,194,304
  bytes cost **2.66 GB and 1.2 s** — matching the original report, and 20x my own number.
  **learned:** two measurements of "the same thing" that differ by 20x are measuring different things, and
  the discrepancy was the finding rather than noise around it. I had published the refutation before
  looking for a shape that would explain the gap. A byte cap cannot bound validation cost when elements
  can be 2 bytes and each wrong one allocates an object — and only `issues[0]` is ever read, so the other
  2,097,100 issue objects are built to be discarded.
  **criterion now:** ISC-122 gains an element-count limb. Array lengths are checked on the parsed value
  BEFORE the schema, so zod never sees an oversized array: same envelope now refused in 18 ms at 55 MB.

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

- **conjectured:** the SRD's `CompactionEntry.retainedTail` named a real field of the Pi session
  format. **refuted by:** the installed `docs/session-format.md` for 0.79.6, which spells the same
  concept as `summary` plus `firstKeptEntryId` — `retainedTail` does not exist. **learned:** the
  SRD's §8.2 reconstruction rule was written from the concept rather than from the binary, the
  same failure mode §18 records eleven of. Ground truth is the installed version.
  **criterion now:** ISC-91's leaf-to-root walk is specified against `firstKeptEntryId`; SRD §8.2
  carries an erratum.

- **conjectured:** `unknown` as the lattice identity was safe in every direction, so a task with
  no independent evidence could adopt the worker's claim. **refuted by:** probing a timed-out
  acceptance run against a claimed `success` — verdict `success`, for a worker whose exam never
  finished, reachable without touching a single harness file by shipping a change that makes an
  existing command hang. **learned:** identity is right for a missing CLAIM and wrong for missing
  EVIDENCE; the two had been conflated because ISC-94 only ever exercised the first.
  **criterion now:** ISC-230 caps the verdict when an attempted command returns no answer, while
  ISC-152 still forbids calling it `failed`.

## Verification

*(Evidence per ISC, appended as each criterion passes.)*

### Phase 1 close-out — 2026-07-27

- ISC-1: `bun install --frozen-lockfile` → `rc=0`.
- ISC-2: `bun run typecheck` (`tsc --noEmit`) → `rc=0`, zero diagnostics.
- ISC-3: `bun test` → `220 pass, 38 skip, 1 todo, 0 fail` across 15 files.
- ISC-4: `cmp Docs/SRD.md <source>` → `IDENTICAL`.
- ISC-5: frontmatter parses; twelve section headers present.
- ISC-6: `.github/workflows/ci.yml` carries named steps `Typecheck`, `Unit tests`,
  `Integration tests`, `E2E tests`, plus a separate `container` job.
- ISC-9: `CHANGELOG.md` has an entry for Phase 0 (0.1.0) and Phase 1 (0.2.0).
- ISC-10: `git log --format=%B | rg -ci "claude|co-authored-by|generated with|LLM|AI-assisted"`
  → `0 matches` across all commits.
- ISC-12: `commander ^14.0.2`, `zod ^4.1.13`, `yaml ^2.8.1`; `bun.lock` committed.
- ISC-13: `tsconfig.json` sets `"strict": true` and `"noUncheckedIndexedAccess": true`;
  ISC-2's clean typecheck is the proof it holds.
- ISC-14: `--help` lists all 19 SRD §10 commands: abort artifacts attach config
  daemon dispatch doctor down exec harvest image logs render report status steer
  transcript up wait.
- ISC-15/16/20/21: unit, integration and e2e directories each carry files and run
  independently; the unit suite completes with no Docker daemon and no network.
- ISC-161..164, 166..187: covered by `test/unit/review-regressions.test.ts` (15
  tests, each of which fails against the pre-fix code) and the Docker-gated
  `test/integration/verbgate.test.ts` (18 tests).
- ISC-194..198: `PIFLEET_DOCKER=1 bun test test/integration/{image,verbgate}.test.ts`
  → `38 pass, 0 fail` on macOS; the Linux CI `container` job is the probe that
  matters, and it executed its assertions for the first time this session.
