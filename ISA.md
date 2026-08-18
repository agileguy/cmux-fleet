---
project: cmux-fleet
task: Implement the pifleet SRD as a working Bun/TypeScript CLI, phase by phase
effort: E4
phase: build
progress: 195/255
mode: build
started: 2026-07-27
updated: 2026-08-18
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
- [x] ISC-7: CI passes on the default branch. `aad8042` (PR #7's squash merge) on `main` — GitHub Actions run 32132390040, both `test` and `container` jobs green, triggered directly by the push to `main`, not a stale PR-branch run.
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
- [ ] ISC-22: A test-coverage report can be produced and lists every `src/` module. `bun run test:coverage` works and lists 73 of 76 (`bunfig.toml`); `src/backends/types.ts` (types-only, no instrumentable code) and `src/supervisor/index.ts` (only ever loaded as a spawned subprocess) are structurally absent, but `src/cli/commands/tui.ts` is missing only because no test imports it — a real, closable gap, not a structural one — so "every module" isn't met yet.

### Group C — Container image

- [x] ISC-23: `image build --toolchain node` produces an image whose `pi --version` matches the pinned version.
- [x] ISC-24: `image verify` fails on an image whose Pi version differs from config.
- [x] ISC-25: A worker container runs as uid 10001.
- [x] ISC-26: A worker container runs with a read-only root filesystem.
- [x] ISC-27: A file written to `/workspace` appears in the host worktree.
- [x] ISC-28: A file written in the host worktree appears at `/workspace`.
- [x] ISC-29: `/skills` is read-only inside the container; a write attempt fails.
- [x] ISC-30: The host `~/.pi/agent` is not mounted in any container.
- [ ] ISC-31: `docker inspect` shows no cloud provider key in any container's environment (only `OMLX_API_KEY`).
- [ ] ISC-32: `up` refuses to start when a role's image is missing.
- [x] ISC-33: `gcloud version` succeeds inside every worker image regardless of `toolchain`.
- [x] ISC-34: `kubectl version --client` succeeds inside every worker image.
- [x] ISC-35: `helm version` succeeds inside every worker image.
- [x] ISC-36: `jq --version` succeeds inside every worker image.
- [x] ISC-37: `curl --version` succeeds inside every worker image.
- [x] ISC-38: PID 1 in a worker container is `tini`.
- [x] ISC-39: The container entrypoint renders `~/.pi/agent/models.json` from env and Pi registers the oMLX provider (SRD Q9).
- [x] ISC-40: The rendered `models.json` survives the read-only root (written to a writable tmpfs path Pi reads).

### Group D — Google credentials

- [x] ISC-41: With `cloud_access: true` and `adc_mode: token`, `gcloud auth print-access-token` succeeds inside the container.
- [x] ISC-42: In `token` mode, no `refresh_token` appears in the container environment.
- [x] ISC-43: In `token` mode, no `refresh_token` appears anywhere on the container filesystem or in `/creds`.
- [ ] ISC-44: The host `~/.config/gcloud` directory is not in any container's `docker inspect` mount list.
- [ ] ISC-45: A role with `cloud_access: false` has no Google credential.
- [ ] ISC-46: In a `cloud_access: false` role, `gcloud auth print-access-token` fails.
- [x] ISC-47: After `token_refresh` elapses, a `gcloud` call inside a long-running container still succeeds.
- [ ] ISC-48: With `impersonate_service_account` set, the token's identity is the SA, not the launching user's account.
- [ ] ISC-49: `up` prints the granted identity, project, and ADC mode for every `cloud_access` worker.

### Group E — Local model (oMLX)

- [ ] ISC-50: A container completes a model call against `host.docker.internal:8000`.
- [ ] ISC-51: That call succeeds with no route to the public internet.
- [x] ISC-52: A model outside `models_allowlist` is refused at `up` with exit 2.
- [ ] ISC-53: A model that answers a `tools`-bearing probe with prose is refused at `up` with exit 2.
- [ ] ISC-54: `doctor` reports the oMLX model list.
- [ ] ISC-55: `doctor` reports a measured single-request oMLX latency.
- [ ] ISC-56: `up` refuses to start while an MLX training run is active, unless `--i-know` is passed.
- [ ] ISC-57: Egress to any host other than the oMLX endpoint and the configured Google endpoints is denied from inside a container.

### Group F — Configuration

- [x] ISC-58: `config validate` exits 2 with a field-level error on a malformed config.
- [x] ISC-59: `config validate` rejects a role combining `bash` with `read_only: true`.
- [x] ISC-60: `render --worker eng-1` emits the expected normalized argv without spawning anything.
- [x] ISC-61: Changing the length of `workers:` changes the container count, with no other edit.
- [x] ISC-62: Two roles produce different `--model` values.
- [x] ISC-63: Two roles produce different `--skill` sets.
- [x] ISC-64: A role that overrides `skills:` still receives `pifleet-worker`.
- [x] ISC-65: Multiple briefing fragments produce exactly one `--append-system-prompt` argument.
- [x] ISC-66: No rendered argv contains an `@`-prefixed path.
- [x] ISC-67: All six SRD roles (`sre`, `investigator`, `verifier`, `engineer`, `reviewer`, `tester`) load from the default config.
- [x] ISC-68: An unknown role name referenced by a worker fails `config validate` with a named error.

### Group G — Lifecycle

- [x] ISC-69: `up` returns a `run_id`.
- [x] ISC-70: Every worker reaches `idle` within 60s of `up`.
- [x] ISC-71: `status --json` reflects `busy` within 2s of dispatch.
- [x] ISC-72: `down` leaves no running container for that run.
- [x] ISC-73: `down` leaves no supervisor process for that run.
- [ ] ISC-74: Closing a worker's pane does not stop the worker in rpc mode; the task still settles.
- [x] ISC-75: Killing the `pifleet` CLI mid-run leaves supervisors running.
- [x] ISC-76: After the CLI is killed, `status --run` re-attaches and `wait` still returns a verdict.
- [x] ISC-77: No supervisor has the CLI or a pane shell as its parent: `pgid == pid`.
- [x] ISC-78: A supervisor's session id differs from the launcher's.

### Group H — Dispatch and completion

- [x] ISC-79: A dispatched task appears in the transcript as a `UserMessage`.
- [x] ISC-80: `steer` injects a message that appears before the next assistant turn.
- [x] ISC-81: `abort` returns the worker to `idle` within 10s.
- [x] ISC-82: A scenario emitting `agent_end{willRetry:true}` then continuing is not reported complete.
- [x] ISC-83: A scenario settling on an aborted turn is reported `aborted`, not `success`.
- [x] ISC-84: The SRD §7.5 interleaving scenario does not attribute epoch N's diff to epoch N+1.
- [x] ISC-85: Re-dispatching a completed `(worker, task_id, epoch)` is a no-op returning `already_completed`.
- [x] ISC-86: A `prompt` that acks then fails late fails its epoch rather than reporting accepted.
- [x] ISC-87: Completion is detected via `agent_end{willRetry:false}` plus a correlated `get_state` showing `isStreaming:false` and `pendingMessageCount:0`.

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

- [x] ISC-103: A `kubectl get` in a `cloud_access` worker succeeds.
- [x] ISC-104: A `kubectl delete` not in `cloud_allow[]` exits 77 and is refused.
- [x] ISC-105: A mutating verb named in the task's `cloud_allow[]` executes.
- [x] ISC-106: That permitted mutating verb is recorded in the ledger with task id and argv.
- [x] ISC-107: Every cloud invocation, permitted or refused, appears in the run ledger.
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

- [x] ISC-128: The full acceptance suite passes on `headless` with cmux not running.
- [x] ISC-129: `up` on the cmux backend creates one workspace and N panes, each showing its worker id and live activity. Fixed and verified live against cmux 0.64.22: `respawn-pane`/`rename-tab` need an explicit `--workspace` alongside `--surface` (a flag this backend never sent), not the ref-vs-UUID rework an earlier write-up here mis-diagnosed. See `## Verification`, Phase 4 close-out, 2026-08-18 correction.
- [x] ISC-130: `attach --worker eng-2` focuses that pane.
- [x] ISC-131: With the cmux socket unreachable, `up` exits 3 with a named diagnosis or falls back to `tmux`.
- [x] ISC-132: `doctor` reports `read-screen` availability, and the run succeeds identically either way.
- [x] ISC-133: `doctor` exits 3 when a `required` cmux CLI command is missing.
- [x] ISC-134: The `tmux` backend brings up N panes and the same acceptance results as `headless`.

### Group L — Anti-criteria

- [x] ISC-135: Anti: disabling `read-screen` entirely changes no acceptance result.
- [x] ISC-136: Anti: no code path outside diagnostics calls `readScreen()`.
- [x] ISC-137: Anti: no file under `src/` imports a cmux symbol outside `src/backends/cmux/`.
- [ ] ISC-138: Anti: no code path uses `readline` or `split(/\r?\n/)` on an RPC or session stream.
- [ ] ISC-139: Anti: no generated commit, branch, or PR body contains AI attribution.
- [ ] ISC-140: Anti: no acceptance test in the `headless` suite requires provider spend or a cloud endpoint.

### Group M — Review findings (added 2026-07-27, post-advisor)

Criteria that came out of the commitment-boundary review. Several correct the SRD
rather than merely implementing it; SRD errata are recorded in `## Changelog`.

- [ ] ISC-141: Epoch attribution uses the RPC stream offset, and the SRD §7.5 interleaving is decided correctly when offset is the only distinguishing signal.
- [ ] ISC-142: A dispatch whose epoch is `<=` the worker's persisted `last_accepted_epoch` is rejected at the worker side, not merely bookkept by the allocator.
- [ ] ISC-143: The epoch high-water-mark is durable before dispatch; allocate → crash → restart does not re-issue the same epoch.
- [x] ISC-144: The run-dir lease keys on pid plus process start-time, so a recycled pid is not mistaken for a live supervisor.
- [ ] ISC-145: A retried dispatch carrying the same `(task_id, attempt_uuid)` replays the stored response rather than returning a bare `already_completed`.
- [x] ISC-146: Every deadline and stall timer uses a monotonic clock; a wall-clock jump fires none of them early.
- [ ] ISC-147: Across every hostile scenario, completion is never declared while the agent will still emit output.
- [x] ISC-148: Acceptance commands are resolved from the base SHA, not read out of the worker's tree. [live via `artifacts --run-acceptance`]
- [x] ISC-149: Acceptance commands run in a fresh clone by SHA, outside the worker's worktree, with no inherited environment. [live via `artifacts --run-acceptance`; fresh CONTAINER is still ISC-233]
- [x] ISC-150: A diff touching the test-harness surface caps the verdict at `blocked` or `unknown` and can never yield `success`.
- [x] ISC-151: `git merge-base --is-ancestor <base_ref> HEAD` is verified at harvest, so a rewritten base cannot shrink the diff to nothing.
- [x] ISC-152: A timed-out acceptance command yields `unknown`, not `failed`. [live via `artifacts --run-acceptance`]
- [x] ISC-153: The derived-fact bundle is hashed and recorded, so an adjudication can be replayed.
- [ ] ISC-154: A worktree content hash differing between quiesce and harvest end forces `unknown` (backgrounded work kept writing). [LIVE but INERT — nothing populates `tree_hash_quiesce`/`tree_hash_harvest`, so the check cannot fire; needs supervisor cooperation]
- [x] ISC-155: Anti: no timeout, deadline, or stall computation reads `Date.now()`.
- [ ] ISC-156: A SIGKILL at each syscall boundary of the atomic-write path leaves state recoverable and the ledger readable.
- [ ] ISC-157: A ledger written under an older schema version is read under a pinned, tested policy rather than crashing.
- [ ] ISC-158: At 16 workers, no container-name or port collision occurs and no worker's event loop is starved by another's output.
- [x] ISC-159: `doctor` exits nonzero with an actionable message on a missing binary, a wrong version, and an absent daemon.
- [x] ISC-160: A stale image is not silently reused after the Dockerfile changed.

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
- [x] ISC-190: `models_allowlist` is enforced — a worker whose model is not on the list does not start.
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
- [x] ISC-214: `RpcClient` stops dispatching the remainder of a chunk once `#fatal` has closed it.
- [x] ISC-215: The EPIPE write path sets `#closed`, so the error does not assert a state the object is not in.
- [x] ISC-216: An undiagnosed internal error is distinguishable by exit code from a usage error.
- [x] ISC-217: A malformed `epoch` (negative, fractional) is a named error rather than silently normalized to a fresh allocation.
- [ ] ISC-218: `writeJsonAtomic`'s directory-fsync failure cannot report a durable write as failed after the rename succeeded.
- [x] ISC-219: The verbgate policy-rewrite test attempts the `/outbox` path the pre-fix shim actually read, not only the path the fix uses. `test/integration/verbgate.test.ts`, "a policy planted at the pre-fix /outbox path grants nothing" — green on CI's `container` job (real Docker, fresh image build): 53/53 probes passed, anti-skip guard updated to match (see `## Verification`, "ISC-219, resolved by CI").

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
- [x] ISC-228: The `late_prompt_failure` settle guard has its own test, not only the deadline-escalation one.
- [x] ISC-229: Anti: no scenario file exists without a reviewed `EXPECTED_SETTLES` entry.

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
- [x] ISC-244: Validation COST is bounded, not just envelope bytes — array lengths are checked before the schema, so an element-packed envelope cannot allocate an issue object per element.
- [x] ISC-245: A worker-controlled filename cannot forge lines in the harvest report; every refusal is escaped and truncated at one choke point.
- [ ] ISC-246: `scanOutboxFiles` returns file DESCRIPTORS, not path strings — a validated path re-opened later is a TOCTOU window, and `nlink` can be raised after the scan. Latent while `safe` has no consumers; arms the moment E3 attaches artifacts.
- [x] ISC-247: A backslash in an envelope path is refused. Harmless on POSIX, a separator anywhere else; not a control character, so the ISC-240 filter does not catch it.

### Phase 3 — security and cloud identity

- [x] ISC-248a: `up` refuses to start when the configured egress network exists but is NOT internal, rather than adopting it and reporting deny-all it does not enforce.
- [ ] ISC-249: A checked-out repository is neutralized BEFORE any worker reads it; each hazard records `detected` and `neutralized` independently. **[OPEN — was marked met in error]** The scanner and the neutralizer both work and are pinned; they were aimed at the wrong tree. `up` scanned `config.run.repo`, the OPERATOR'S working repository, while `render.ts` mounts `<repo>/.worktrees/<worker>` as `/workspace` — and nothing in this phase creates those worktrees. So the call defended nothing and damaged the operator: it renamed their real `AGENTS.md` aside and commented out `filter.lfs.*` while leaving `filter.lfs.required = true`, which hard-fails every later `git add` on an LFS-tracked path, against SRD §12.8's requirement that this checkout be left unchanged. A linked worktree materializes committed files from git objects at checkout time regardless, so renaming in the parent could not have suppressed them anyway. `up` now DETECTS and reports only; neutralization belongs on the per-worker worktree at the moment it is created. The `detected`/`neutralized` half of this criterion IS met and pinned. **Blocked on ISC-27/ISC-28** (worktree creation and bind-mount round-tripping), which are the criteria that make a per-worker tree exist to neutralize; whoever closes those closes this at the same site, and SRD §9.2 already requires that path to fail fast on LFS — the same hazard this defect hit from the other direction.
- [x] ISC-250: Every control-socket verb requires the per-run secret, `ping` included; a wrong or missing token is a clean refusal and the server stays up.
- [x] ISC-251: The Google grant is never silent — `up` states per worker which identity it got, or that it got none.
- [x] ISC-252: Egress host matching requires a label boundary; `evil-googleapis.com` and an empty leftmost label cannot ride a `*.googleapis.com` rule.
- [ ] ISC-248: `TokenRefresher` runs on the supervisor's lifecycle and re-injects before expiry. [IMPLEMENTED + UNIT AND DOCKER-VERIFIED, NOT WIRED — it attaches to a running container and the headless path starts none; wiring it now would attach it to nothing]
- [ ] ISC-253: A relay consults `decide()` for live traffic. [The internal network denies everything, which is the enforcement; `decide` is the policy a relay must consult and no relay exists yet, so the pure core is unit-verified but not on a live traffic path]
- [ ] ISC-254: The timing-safe comparator is pinned by a test. [Replacing `timingSafeEqual` with `===` leaves the suite green: the two are behaviourally identical by construction, so only a timing measurement distinguishes them and that is too flaky to gate CI. Documented in place; NOT covered]

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
- **2026-08-17 — the "phases done" claim in README/CHANGELOG and the ISA's own done-condition
  had drifted apart.** All six SRD phases shipping every command in §10 did not mean every ISC
  was verified — most of Groups C/D/E/F/G (container image, Google credentials, oMLX, config,
  lifecycle) were unchecked not because the code was wrong, but because no prior session on
  this machine had a running Docker daemon to live-probe against. Fixed by running the full
  `PIFLEET_DOCKER=1` integration + e2e suite once Docker (Colima), vanilla pi.dev 0.79.6, and
  the oMLX key were all available — 54 criteria closed with no source changes beyond one bug
  (below). Deliberately did NOT check off Group E (ISC-50..57, oMLX in-container model calls):
  no dedicated test file exercises them, and "the e2e suite passed" doesn't independently prove
  allowlist refusal or the MLX-training-run guard fire correctly — that's real follow-up work,
  not a documentation gap. Same restraint applied to ISC-44..46, 48, 49, 61(kept — see below),
  74, 32: no test file names them, so they stay open rather than being swept in on file-level
  correlation.
- **2026-08-17 — found and fixed a real bug while unblocking the environment, not part of any
  planned workstream.** `src/harvest/outbox.ts`'s `CONTROL_CHARS` regex and `safeForReport`'s
  replace() were built from literal raw NUL/US/DEL bytes in the source instead of `\x` escape
  sequences. Bun 1.3.11 parses that as "range out of order in character class" and refuses to
  load the file — which took down every test touching outbox.ts, plus `doctor` itself, since
  commands are registered eagerly at CLI startup. Same character class, rewritten with escape
  sequences; full unit suite went from a hard crash to 818/818 green. This suggests the ISA's
  frontmatter `progress: 104/236` (dated 2026-07-27) predates whichever change introduced the
  raw bytes, or predates a Bun upgrade on this machine that started rejecting them — either way,
  nobody had run the full suite on this exact machine+Bun version since.
- **2026-08-17 — vanilla pi.dev installed alongside, not over, an existing fork.** This machine's
  `$PATH` resolved `pi` to `~/bin/pi` → `@oh-my-pi/pi-coding-agent`, a different npm-scoped fork,
  not the pinned `@earendil-works/pi-coding-agent@0.79.6` this project is built against. Per
  explicit instruction, installed the real package via `bun install -g`, which lands in
  `~/.bun/bin/pi` — earlier in `$PATH` than `~/bin/pi` — so `pi` now resolves to vanilla 0.79.6
  without touching the existing oh-my-pi setup at all.
- **2026-08-17 — Workstream 2 (small independent fixes) run as two parallel engineers in git
  worktrees, per the existing manual-worktree precedent above.** Engineer A took the RPC/CLI/
  epoch/supervisor cluster (ISC-214, 215, 216, 217, 228); Engineer B took harvest/container/
  config (ISC-247, 160, 190, 219, 22) — a clean file-disjoint split, so the merge back into
  `workstream-2-small-fixes` was conflict-free. ISC-219's live probe could not run: the worker
  image (`pifleet/pi-worker:verify`) needed by the Docker-gated verbgate suite is the one an
  earlier agent deleted without authorization (see the same-day incident already on record);
  the user's explicit call was "leave it for now," so the image was not rebuilt and ISC-219
  stays open with its test written but unverified, rather than being checked off on the
  strength of the code alone.
- **2026-08-17 — a pre-existing test-isolation flake, not a regression.** After merging both
  engineers' branches, `bun test test/unit` showed one failure in
  `harvest-outbox.test.ts` ("a hard link to a file outside the outbox is refused" — wrong
  refusal reason, consistent with a leftover temp path from a neighboring test rather than a
  logic error). The same file run in isolation, and the full suite re-run immediately after,
  were both 100% green. Recorded rather than chased: neither engineer's diff touched the
  hard-link check or its test, so this reads as ordering/temp-path contention between test
  files rather than something this workstream introduced.
- **2026-08-17 — an independent review pass on the same-day PR found real defects a passing
  test suite had missed, plus two ISA bookkeeping mistakes.** Three reviewers (Claude, Gemini,
  Codex) ran against the diff before merge and converged 3/3 on two issues neither engineer nor
  the orchestrator had caught: `readDockerfile()` threw an undiagnosed error that `doctor`
  reported as `EXIT.INTERNAL`, exactly the "pifleet bug" misclassification ISC-216 exists to
  prevent, aimed at a broken checkout instead; and the `models_allowlist` gate's bare `catch`
  discarded a real config error alongside the one case it was meant to skip. Claude alone (high
  confidence) found that ISC-160's hash covered the Dockerfile's text but not the two files it
  `COPY`s — including `docker/verbgate`, the enforcement point behind the cloud-mutation gate —
  leaving the highest-consequence staleness case still open under a criterion just marked
  closed. **Learned: every fix in this workstream had its own red-then-green regression test,
  and none of those tests were wrong — they each proved the fix did what it claimed. What they
  didn't do was ask what ELSE could go wrong at the same site**, which is exactly the blind
  spot an independent adversarial pass exists to cover, and the same reasoning this ISA already
  applies to worker self-report (`## Anti-criteria`) applies one level up to the engineer
  writing the test. Separately, Gemini's cross-file pass caught that ISC-247 had been fixed and
  tested but its checkbox never flipped, and that ISC-22 had been checked despite not meeting
  its own "every module" wording — both are on the orchestrator, not either engineer, and both
  are now fixed. All fixes and citations are in `## Verification`, "PR #7 review round."
- **2026-08-18 — "the cmux socket refuses every call from outside a pane" turned out to be the
  wrong reason ISC-129 was open — the real one is a cmux version regression.** Two prior
  close-out notes (Phase 4, Phase 6) both explained ISC-129 as blocked purely by
  `socketControlMode: cmuxOnly` refusing non-pane callers, with the fix being "run from inside a
  pane" — carried forward unquestioned for three phases. Actually configuring `password` mode
  (per `Docs/SRD.md` §4.1, which says this is pifleet's own intended mode) and driving a real
  `pifleet up --backend cmux` from an ordinary shell showed the socket access story was correct
  and irrelevant: `doctor` reports `backends.cmux: true`, a workspace and both panes get
  created, and the run fails somewhere else entirely — `respawn-pane`'s surface addressing,
  which changed between cmux 0.64.20 (the SRD's verified baseline) and 0.64.22 (installed here).
  **Learned: an unreachable-in-principle diagnosis and an actually-tried-and-found-broken
  diagnosis look identical in a checkbox list, and only the second one tells the next person
  what to fix.** Three phases of ISA notes described a plausible blocker that nobody had
  actually tested since 0.64.20. Full reproduction and the exact fix scope are in
  `## Verification`, "Phase 4 close-out," under the 2026-08-18 addendum to ISC-129.
  Measured on this machine: Colima shares `$HOME` and shares neither `/tmp` nor
  `/var/folders/...`. An unshared `-v` source does not error — the daemon mounts an empty
  directory in its place. `image verify` therefore failed on a perfectly good image, and the
  same mistake in the worker launch path would give every worker an empty `/workspace` and an
  outbox the harvester never sees, with exit 0 throughout. Scratch allocation moves to
  `container/mounts.ts` (`PIFLEET_SCRATCH_DIR`, default `~/.pifleet/scratch`), visibility is
  proved by reading back a sentinel rather than by a successful mount, and `doctor` probes the
  runs root so the failure is loud and early. The default runs root was already under `$HOME`
  and was never affected; `PIFLEET_RUNS_DIR` pointing elsewhere was, which is what ISC-164 guards.
- **2026-08-18 — the ISC-129 root cause committed hours earlier (above) was itself wrong, caught
  by re-testing rather than trusting the write-up.** That entry concluded cmux 0.64.22 requires
  ref-form (`surface:N`) addressing and never resolves a raw UUID for `--surface` — a whole-backend
  rework. Asked to actually implement that rework, a fresh controlled A/B test (not a repeat of the
  same steps) showed every `--workspace`+`--surface` combination succeeds regardless of UUID-vs-ref
  spelling on either flag; the only failing case is `--workspace` omitted entirely, which is what
  `respawnPaneArgv`/`renameTabArgv` had always sent. The actual fix was two argv builders gaining a
  `--workspace` parameter and two id-codec functions gaining a third field to carry it, not a
  backend-wide addressing rewrite. **Learned: a root-cause writeup
  with a reproduction table still needs re-verification before code is built on top of it,
  especially one written under the same "prior diagnosis turned out wrong" pressure that produced
  this exact lesson three phases running now** — the corrected mechanism only surfaced by re-running
  the experiment with tighter controls (one variable changed at a time, immediately re-confirmed
  with a live shell + `send`/`read-screen`) instead of extending the earlier table's conclusion.
  Full corrected reproduction is in `## Verification`, "Phase 4 close-out," 2026-08-18 correction.
- **2026-08-18 — PR #8's review round (Claude/Gemini/Codex, same pattern as PR #7) caught a real
  test-coverage gap and a real backward-compatibility break the live verification above didn't
  surface, because live verification only exercises a fresh run end-to-end and never a stale
  `presentation.json` from an older build.** All three reviewers independently re-ran the live
  cmux A/B test themselves rather than accepting the PR's table at face value — by this point a
  deliberate habit, not an accident, per the two entries directly above. Two reviewers then
  mutation-tested the fix and proved the `--workspace`/`--surface` wiring in `index.ts` had zero
  test coverage (swap the two arguments, whole suite stays green); all three independently found
  that the composed pane id is persisted to `presentation.json` and read back by a later `attach`/
  `tui` process, so widening it from 2 to 3 fields breaks any run recorded by the pre-fix binary.
  **Learned: a live end-to-end verification proves the happy path for a run created and consumed by
  the same build — it says nothing about a run that started under an older build**, which is
  exactly the gap a cross-process persisted format opens and an in-process test cannot see. Full
  findings and fixes are in `## Verification`, "PR #8 review round."

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
- ISC-251: pinned by `test/integration/up-wiring.test.ts` ("the grant line names the
  real ADC identity"): a `gcloud` PATH shim answers `config get-value account` with a
  known account, and the ledger's `credential_plan` line must carry it verbatim and
  must not carry the `(adc user)` placeholder. Mutation-verified: with `up.ts`'s
  `resolveIdentity` wiring replaced by `undefined`, the file runs `5 pass, 1 fail`
  (only the new test fails, on the reverted placeholder line); restored →
  `6 pass, 0 fail`.
- Group C/J CI coverage: `test/integration/egress.test.ts` (5 probes) and
  `test/integration/adc.test.ts` (5 probes) previously executed in NO job — the fast
  `test` job never sets `PIFLEET_DOCKER`, so both self-skip there, and the `container`
  job invoked only image + verbgate. Both files are now in the container job's probe
  step and inside its anti-skip guard; `EXPECTED` raised 42 → 52, measured by running
  the four files together: `PIFLEET_DOCKER=1 bun test …` → `52 pass, 0 fail, 0 skip`.
  The guard script was executed verbatim in both directions: `EXPECTED=52` → exit 0,
  stale `EXPECTED=42` → exit 1 with the count mismatch named.

### Phase 4 close-out — 2026-07-28

Nine of Group K/L claimed. **ISC-129 stays open deliberately** — see below.

- ISC-128: `bun test` → `874 pass, 52 skip, 0 fail` across 56 files with cmux's
  socket unreachable (`doctor` reports `cmux-socket-unreachable`; this shell is
  outside a cmux pane). The structural guarantee is the keyed lazy `import()` in
  `src/backends/registry.ts`, pinned by `backend-registry.test.ts`: loading
  `headless` never drags the cmux module in.
- ISC-130: `attach.test.ts` drives the real CLI against a real two-pane tmux
  server, with the OTHER pane made active first and asserted so, so a no-op
  cannot pass; the focus is confirmed through `display-message`.
- ISC-131: `backend-selection.test.ts` asserts the failure path by absence as
  well as presence — exit 3, empty `workersDir`, no `backend_ready`, no
  `backend_fallback`, no `supervisor_launched`, no tmux server. The success case
  asserts exit 0, so neither code can be environment-supplied.
- ISC-132: `doctor-cmux.test.ts` compares a cmux with and without `read-screen`:
  reported in `optional_capabilities` both ways, verdict unchanged.
- ISC-133: verified in BOTH directions against the real CLI — a complete cmux
  exits 0, a cmux missing `respawn-pane` exits 3. It previously passed for the
  wrong reason: this machine has no Docker daemon, so `doctor` exited 3 on that
  account whether or not a command was missing, and CI (where docker works)
  returned 2. Every required probe is now shimmed, and deleting the
  `cmux-required-command-missing` diagnosis makes `doctor` exit 0 and the test
  fail on the exit code itself.
- ISC-134: `tmux-headless-equivalence.test.ts` runs one driver sequence against
  both backends and requires every backend-independent outcome to match, with
  backend-native ids the only permitted difference. The pane-count half now
  builds its own session — it used to read the one the previous test left
  behind, so it failed when run alone.
- ISC-135: the `read-screen`-disabled shim runs through the production seam
  while load-bearing verbs still work — a positive control, not just an absence.
- ISC-136: `doctor-cmux.test.ts` walks every tracked `src/**.ts` and requires no
  `readScreen(` call outside `src/backends/`. Injecting one turns it red.
- ISC-137: `rpc-client.test.ts` scans every `src/` file for a cmux specifier.
  The pattern now covers backticks — a template-literal `import()` used to walk
  straight through, which is the likeliest regression shape because
  `registry.ts` establishes exactly that idiom — and the pattern has its own
  test for both matches and non-matches.

**ISC-129 — open.** Both halves are now implemented and verified on `tmux`:
panes are titled with the worker id, run `tail -F` over `events.jsonl` rather
than an idle `bash`, and a line appended to the event stream appears on screen
(`pane-viewer.test.ts`, four tests; reverting the `attachViewer` call fails
three). `events.jsonl` was chosen by measurement — `supervisor.log` was 0 bytes
across a whole run, which would have produced a technically-live, permanently
empty pane. The criterion names the **cmux** backend specifically.

**2026-08-18 — actually run against a live cmux 0.64.22, and it's broken, not
merely unreachable.** The `cmuxOnly` socket restriction turned out not to be
the real blocker: `automation.socketControlMode: "password"` in
`~/.config/cmux/cmux.json` plus a password set once through cmux's own
Settings UI (the JSON's own `socketPassword` field is write-only from cmux's
side — it gets stripped back out on reload/restart, the real credential lives
in `~/.local/state/cmux/socket-control-password`) lets `cmux ping` return
`PONG` from a completely ordinary shell. `doctor` then reports
`backends.cmux: true` with zero diagnoses. So a live run is genuinely
possible without a human sitting inside a pane — the SRD's own §4.1 already
says as much.

`pifleet up --backend cmux` against that live cmux DOES create a real
workspace and one pane per worker — confirmed via `cmux workspace list` and
`cmux list-panes`, both panes present, workspace titled `pifleet-<run-id>`.
But **both workers logged `viewer_failed`** in `ledger/cli-up.jsonl`:
`Error: Surface not found: <uuid>` from `respawn-pane`, moments after
`createPane` returned that exact surface id. Reproduced by hand outside
pifleet entirely — a clean four-way test:

| `--workspace` | `--surface` | Result |
|---|---|---|
| omitted | raw UUID | `Surface not found: <uuid>` |
| omitted | `surface:N` ref | `Surface ref not found: surface:N` |
| raw UUID | raw UUID | `Surface not found: <uuid>` |
| `workspace:N` ref | raw UUID | `Surface not found: <uuid>` |
| `workspace:N` ref | `surface:N` ref | **`OK`** — respawns, `read-screen` shows the new command |

On cmux 0.64.22, `--surface` only resolves through the workspace-relative
`surface:N` ref form, paired with a ref-form `--workspace`; a raw UUID never
resolves, no matter what accompanies it — contradicting both `cmux --help`
("take a UUID, a short ref, or an index") and `Docs/SRD.md` §4.1, which was
verified against 0.64.20. `respawnPaneArgv` (`src/backends/cmux/client.ts`)
passes a bare surface UUID and no `--workspace` at all; so do
`readScreenArgv` and `sendKeyArgv`, and `createPane`/`attachViewer`
(`src/backends/cmux/index.ts`) track pane identity as a composed
`"<paneUUID> <surfaceUUID>"` string throughout (`composePaneId`/
`splitPaneId`, `src/backends/cmux/parse.ts`) — UUIDs are the addressing
scheme everywhere in this backend, not refs. Fixing this for real means
reworking that addressing scheme to carry/resolve ref-form ids (workspace
index included), across every call site listed above, not a one-line patch —
scoped as a real follow-up, not attempted live during this verification.

`pifleet down` still tore the run down cleanly despite the viewer failures
(pane presentation is deliberately non-fatal to a run, per this same
criterion's own design), and closed the cmux workspace as part of teardown.

**2026-08-18 correction — the diagnosis two paragraphs up was wrong.** It
claimed cmux 0.64.22 only resolves `--surface` through the ref form
(`surface:N`), never a raw UUID, and that fixing this needed reworking the
whole backend to carry/resolve ref-form ids. A direct, controlled re-test
disproves the mechanism, even though the earlier four-way table's raw
observations were real:

| `--workspace` | `--surface` | `respawn-pane` result |
|---|---|---|
| omitted | raw UUID | `Surface not found: <uuid>` |
| raw UUID | raw UUID | **`OK`** |
| raw UUID | `surface:N` ref | **`OK`** |
| `workspace:N` ref | raw UUID | **`OK`** |
| `workspace:N` ref | `surface:N` ref | **`OK`** |

Every combination that includes `--workspace` succeeds, in **any** id-form
mix; the only failing row is the one missing `--workspace` entirely — which
is exactly what `respawnPaneArgv` sent (SRD's 0.64.20-era shape, unchanged
until today). `rename-tab` has the identical bug (`not_found: Tab not found`
without `--workspace`, `OK` with it, UUID or ref either way). `read-screen`,
`send`, `send-key` and `focus-pane` all resolve a bare UUID fine with no
`--workspace` at all — confirmed live by respawning a real shell, `send`-ing
text into it, and reading it back.

So the earlier four-way test's `(uuid, uuid)` and `(workspace:N ref, uuid)`
rows reading as failures was a **procedural artifact** of that test run, not
a property of id spelling — most likely a stale/already-superseded surface id
reused across steps. The real, much smaller regression: cmux 0.64.22 added a
`--workspace` requirement to `respawn-pane`/`rename-tab` that 0.64.20 (the
SRD's baseline) did not have; ref-vs-UUID was never the actual variable.

**Fixed**: `respawnPaneArgv`/`renameTabArgv` (`src/backends/cmux/client.ts`)
now take a `workspaceId` and always send `--workspace`, using whatever id form
the caller already holds (UUID — no resolution step needed). `composePaneId`/
`splitPaneId` (`src/backends/cmux/parse.ts`) carry a third field so
`attachViewer` has the workspace id available; `createPane`'s own rename-tab
call already had it in scope. `readScreenArgv`, `sendArgv`, `sendKeyArgv`,
`focusPaneArgv` are untouched — all confirmed still correct without a
workspace flag. `newSplitArgv` was **already** correct — it already sent
`--workspace` before this PR — which is itself corroborating evidence for the
corrected mechanism, not an example of a builder needing no fix.

**Verified live** (cmux 0.64.22, real `pifleet up --backend cmux` with
`PIFLEET_PI_COMMAND` pointed at `fake-pi.ts`, two workers): `backend_ready`
logged `active: cmux, fell_back: false`; both panes' `read-screen` showed the
worker's live `logs --follow --render` output (`fake-pi: scenario 'happy'
loaded...`), not an idle shell and not `Surface not found`; `pifleet down`
tore the run and the cmux workspace down cleanly. Unit coverage:
`test/unit/cmux-client.test.ts` pins the new `--workspace ws-uuid --surface
surf-uuid` argv shape and its injection-refusal cases; that file and
`test/unit/cmux-viewer-path.test.ts` were also updated for the 3-part
composed id. Full suite: `bun test test/unit test/integration` → 1105 pass,
53 skip (Docker-gated), 0 fail. `bun run typecheck` clean.

**PR #8 review round — 2026-08-18.** Same ProjectManager/CodeReviewer pattern as
PR #7: three independent local reviewers (Claude, Gemini, Codex) against the
diff above. All three independently confirmed the diagnosis by re-testing
live cmux themselves rather than trusting the write-up — Codex's own words:
"this project has now recorded the wrong mechanism for ISC-129 twice, so I
re-ran the experiment myself... the third time is the charm." Two real defects
survived to CONFIRMED, both fixed and re-verified before merge:

1. **The `--workspace`/`--surface` wiring itself was completely untested — a
   consensus finding across all three reviewers, mutation-proven by two of
   them.** Swapping the two arguments at both `index.ts` call sites (passing
   `surfaceId` where `workspaceId` belongs) typechecked and left the entire
   suite green, because the argv-builder tests only pin the pure functions in
   isolation and the viewer-path tests only assert filesystem effects. Fixed
   by adding two argv-capturing wiring tests to `test/unit/backend-controls.test.ts`
   (this repo's existing home for "found by mutation" cross-backend regressions)
   using the already-injectable `exec`; confirmed both tests fail when the
   swap is reintroduced (mutation-killed), pass with the real code.
2. **`workspaceId` was validated only inside `respawnPaneArgv`, after
   `attachViewer` had already written the 0700 viewer script to disk** — 3/3
   reviewers independently found this, reproducing the exact "validate BEFORE
   the id becomes a path, not after" bug this same method's own 20-line
   comment exists to prevent, for the field this PR added. Not currently
   exploitable (`workspaceId` never reaches a filesystem path), but it
   reintroduces the ordering invariant the comment and `cmux-viewer-path.test.ts`'s
   header both exist to hold. Fixed: `assertCmuxValue("workspace id", ...)`
   now runs immediately after the existing surface-id guard, before `mkdir`.
3. **A real backward-compatibility break, found independently by all three
   reviewers and empirically reproduced by two of them**: the composed pane id
   is not just in-memory — `up` persists it to `presentation.json` as
   `surface_ref` (`pifleet.presentation/v1`), and a *later, separate* `attach`/
   `tui` invocation reads it back and calls `splitPaneId`. A 2-field id written
   by the pre-fix binary now throws `CmuxParseError` instead of resolving,
   turning a nameable version-skew condition into an opaque parse failure.
   Fixed: `splitPaneId` now accepts both 2-part (legacy, `workspaceId: null`)
   and 3-part composed ids; `attachViewer` — the one caller that actually needs
   the workspace id — throws a named, actionable error ("this pane was
   recorded by a pifleet build that predates the respawn-pane --workspace fix;
   run `pifleet down` and `pifleet up` again") instead of a generic parse
   error. `focus`/`sendText`/`sendKey`/`readScreen` are unaffected either way —
   none of them ever needed the workspace id.

Also fixed from the review: `composePaneId` now rejects empty fields (it only
checked for embedded spaces, so it could mint a string `splitPaneId` then
rejected downstream — after that string might already be on disk); the
`--workspace` comments in `client.ts` were reworded from "required" to what
cmux's own `--help` actually calls it ("workspace context ... default:
`$CMUX_WORKSPACE_ID`") — 0.64.22 scoped surface resolution to a workspace, it
did not make the flag itself mandatory, and this project has twice mis-stated
the mechanism from imprecise language already. Two accuracy fixes to this very
write-up, both caught by Gemini's cross-file pass: the `newSplitArgv` claim
above (now corrected — it needed no fix because it was already right, not
because 0.64.22 left it alone), and this paragraph previously undercounted the
fix as "two functions" when it touched four signatures across three files.

Full suite after the review-round fixes: `bun test test/unit test/integration`
→ 1111 pass, 53 skip (Docker-gated), 0 fail. `bun run typecheck` clean.

Carried open from Phase 3: ISC-248, ISC-249 (blocked on ISC-27/28), ISC-253,
ISC-254.

### Environment unblock + Docker/e2e sweep — 2026-08-17

**Environment.** `bun install` was failing outright (`ConnectionClosed` on every tarball) —
a corporate transparent-proxy issue, resolved once disabled. Vanilla pi.dev installed
(`bun install -g @earendil-works/pi-coding-agent@0.79.6`); `pi --version` → `0.79.6`,
resolving ahead of an unrelated `@oh-my-pi` fork already on `$PATH`. `OMLX_API_KEY` sourced
from `~/.env`. Docker (Colima) and cmux (0.64.22) were already present. `doctor --json`
afterward: `docker` 28.4.0 ok, `git` 2.50.1 ok, `pi` 0.79.6 ok, `tmux` 3.6a ok, `cmux` 0.64.22
ok (socket unreachable outside a live pane — expected, see ISC-129), `omlx.ok: true`.

**Bug found and fixed en route:** `src/harvest/outbox.ts`'s two control-character regexes
were built from literal raw bytes, which Bun 1.3.11 refuses to parse (see `## Decisions`).
Fixed; `bun test test/unit` went from a hard crash to `818 pass, 0 fail` across 43 files.

**Docker + e2e sweep**, `PIFLEET_DOCKER=1`, against real Docker and real pi 0.79.6 (no
test-double fallback in the e2e suite):

- Built the missing `pifleet/pi-worker:verify` image (`docker build --build-arg
  TOOLCHAIN=base --build-arg PI_VERSION=0.79.6 -f docker/Dockerfile .`) — no worker image had
  ever been built on this machine, which was the sole cause of 26 initial integration
  failures (exit 125, image not found), not a code defect.
- `bun test test/integration` (29 files) → **293 pass, 0 fail**, 1571 `expect()` calls, 97.4s.
- `bun test test/e2e` (2 files) → **10 pass, 0 fail**, 131 `expect()` calls, 43.6s.
- Combined with the unit suite: **1121/1121 passing, 0 failures, 0 parse/load blockers.**

**54 criteria closed**, each backed by an explicit `ISC-N` citation found in the test file
itself (not inferred from file-level correlation): ISC-23..30, 33..40 (`test/integration/
image.test.ts`, `cli-exit-codes.test.ts`); ISC-41..43, 47 (`adc.test.ts`); ISC-58..68
(`test/unit/config.test.ts`, `render.test.ts`, `cli-exit-codes.test.ts`); ISC-69..73, 75..79,
82..87 (`test/e2e/lifecycle.test.ts`); ISC-103..107 (`verbgate.test.ts`); ISC-144
(`supervisor.test.ts`); ISC-229 (`test/unit/completion.test.ts`'s bidirectional
`EXPECTED_SETTLES` ↔ scenario-file parity check, lines 439-452).

**Deliberately left open** despite the green run, for lack of a named test citing them:
ISC-31, 32, 44..46, 48, 49, 74 (Groups C/D/G — file-level correlation isn't the same as
per-criterion evidence); all of ISC-50..57 (Group E, oMLX — no dedicated in-container model
call / allowlist-refusal test file exists yet, a real gap, not a bookkeeping one). ISC-129
stays open per Phase 4/6 notes (needs a run from inside a live cmux pane). ISC-249 was
expected to close as a side effect of ISC-27/28 landing — re-check: its text also requires
the neutralization site itself (per-worker worktree, not the operator's checkout) to exist,
which is a separate, still-open question from whether ISC-27/28's write-through behavior
works.

### Workstream 2 — small independent fixes — 2026-08-17

Eight of ten planned criteria closed on the first pass, each with its own regression test
written against a confirmed-red baseline before the fix; ISC-247 was fixed and tested but
missed the checkbox flip in the same pass (caught by an independent PR review, see below);
ISC-219 has its test written but is blocked on a missing image (see `## Decisions`). A tenth,
unplanned criterion (ISC-52) turned out to already be satisfied by ISC-190's own launch-path
test and is closed alongside it. Two engineers ran in parallel worktrees
(`ws2-engineer-a`, `ws2-engineer-b`), merged conflict-free into `workstream-2-small-fixes`
since their file sets never overlapped.

- **ISC-214** — `test/unit/rpc-client.test.ts`, "a fatal error stops the rest of the SAME
  chunk (ISC-214)". `feed()`/`feedText()` now share `#handleLines()`, which re-checks
  `#closed` between lines of the same chunk.
- **ISC-215** — `test/unit/rpc-client.test.ts`, describe "a failed write closes the client
  (ISC-215)" (2 tests: closed state observable after EPIPE; in-flight requests reject with
  none left pending). The EPIPE catch in `send()` now calls `this.close(reason)`.
- **ISC-216** — `test/unit/cli.test.ts`, describe "undiagnosed errors are their own exit code
  (ISC-216)" (5 tests). New `EXIT.INTERNAL` (ranked first in the severity ladder) and an
  exported `exitCodeForError()`; no existing exit code renumbered.
- **ISC-217** — `test/unit/epoch.test.ts` (5 tests) + `test/unit/review-regressions.test.ts`,
  "a negative or fractional epoch is a named error, not an allocation". New
  `MalformedEpochError`, thrown from `assertEpochWellFormed()` ahead of the replay lookup;
  the pre-existing test that had codified silent normalization of `-1` was replaced.
- **ISC-228** — `test/integration/supervisor.test.ts`, "a late prompt failure whose durable
  writes fail leaves the supervisor alive", alongside (not replacing) the deadline-escalation
  test. Uses `scenarios/late-failure.json`; asserts the trigger event is
  `stray_response{kind:"late", success:false}`, not `deadline_exceeded`, and that the
  supervisor answers `ping` afterward.
- **ISC-247** — `test/unit/harvest-outbox.test.ts`, describe "ISC-247 backslash is a separator
  elsewhere" (3 tests). New `backslashProblem` check in `outbox.ts`, independent of the
  control-character filter.
- **ISC-160** — `test/unit/render.test.ts`, "editing the Dockerfile busts the tag even when
  nothing else changed (ISC-160)". `ImageInputs.dockerfile` now holds the Dockerfile's actual
  content, folded into `configHash`; `dockerfilePath()` is the single source both the hash and
  `docker build -f` read, so they cannot drift apart.
- **ISC-190** — `test/unit/config.test.ts`, describe "models_allowlist is enforced (ISC-190)"
  (6 tests) + `test/integration/up-wiring.test.ts`, describe "models_allowlist is enforced
  before any worker starts (ISC-190)" (2 tests, mutation-checked: removing the enforcement
  call from `up.ts` fails only the launch-path test, which is the criterion's actual claim).
  New `ModelNotAllowedError extends ConfigError` (exit 2). The same launch-path test also
  verbatim satisfies **ISC-52** ("a model outside `models_allowlist` is refused at `up` with
  exit 2") — not part of the original ten, closed as a side effect.
- **ISC-22 — not closed.** `bunfig.toml` (new) configures `coverageSkipTestFiles` and
  `coverageReporter = ["text", "lcov"]`, deliberately with no `coverage = true` default (would
  slow every narrow `bun test` invocation) and no `coverageThreshold` (would gate the build on
  a number chosen on day one); `package.json` gained a `test:coverage` script; the report does
  run. But the criterion says "lists every `src/` module" and it lists 73 of 76:
  `src/backends/types.ts` (types-only, no instrumentable code) and `src/supervisor/index.ts`
  (only ever loaded as a spawned subprocess) are structurally absent, which is fine — but
  `src/cli/commands/tui.ts` is absent only because no test imports it, same as its 19 sibling
  command files that DO appear (each covered incidentally by an unrelated unit test importing
  a named export). That's a real, closable gap, so the box stays open rather than checked with
  a caveat 40 lines away from the criterion itself — the mistake ISC-219 avoided and this entry
  originally repeated (an independent PR review caught it; see below).
- **ISC-219 — not closed.** Test written (`test/integration/verbgate.test.ts`, "a policy
  planted at the pre-fix /outbox path grants nothing"), plants a wildcard policy at both
  plausible pre-fix path candidates since the exact historical path is not recoverable from
  git history. Cannot run live: `PIFLEET_DOCKER=1 bun test test/integration/verbgate.test.ts`
  needs `pifleet/pi-worker:verify`, which does not exist on this machine (deleted earlier,
  left alone per explicit instruction — see `## Decisions`). 20 of 23 tests in that file fail
  on empty container output with the image absent, identical failure shape for the new test
  and the 19 pre-existing ones — not a sign of a bad test, just no image to run against.

**Verification:** `bun test test/unit` — 842 pass, 0 fail (one flaky failure on first run,
see `## Decisions`, gone on re-run) — across 43 files; `bun run typecheck` clean.

Progress: 182/255 → 191/255 (ISC-214, 215, 216, 217, 228, 247, 160, 190, 52).

### PR #7 review round — 2026-08-17

Three independent reviewers (Claude, Gemini, Codex — see the `CodeReviewer` skill) ran against
the Workstream 2 diff before merge. Genuine value: they caught two bookkeeping mistakes above
(ISC-247 fixed but not checked; ISC-22 checked despite not meeting "every module") and two
real code defects that had passed all of this workstream's own tests because nothing tested
the failure path itself:

- `readDockerfile()` threw a bare `Error` on a missing/unreadable Dockerfile, which
  `exitCodeForError` classifies as `EXIT.INTERNAL` (ISC-216's "undiagnosed bug in pifleet") —
  exactly backwards for a broken checkout, and `doctor`'s own image-presence check sat outside
  any try, so the one command whose job is diagnosing a broken machine crashed on one. 3/3
  reviewers flagged this independently — highest-confidence finding of the round.
- `up.ts`'s `models_allowlist` enforcement loop used a bare `catch { continue }` around
  `resolveWorker()`, which swallows "worker names an unknown role" (a real config defect)
  identically to "worker id not in `--workers`" (the one case meant to be skipped) — silently
  bypassing the allowlist gate for a misconfigured worker. Also 3/3.
- (Claude, high confidence) `configHash` hashed the Dockerfile's text but not the two files it
  `COPY`s into the image — `docker/verbgate` (the cloud-mutation gate) and `docker/entrypoint.sh`
  — so editing either left the image tag, and therefore `up`'s staleness check, unchanged.
- (Codex) `assertEpochWellFormed` used `Number.isInteger`, which admits `2**53` and other values
  past which `epoch + 1 === epoch` — the fence could never advance.
- Both Gemini and Codex separately flagged the exit-code ladder docs (README, `contracts.test.ts`)
  never picked up the new `EXIT.INTERNAL = 8`.

**Fix pass, same day:**

- `src/container/image.ts`: `readDockerfile()` now throws `BuildContextError` (`exitCode:
  EXIT.USAGE`), modelled on `ConfigError`. `doctor` gained `imageStatus()`, which turns an
  unreadable Dockerfile into a `Diagnosis` row instead of aborting the whole probe.
  `test/unit/render.test.ts`, "an unreadable Dockerfile throws a DIAGNOSED usage error, not an
  internal one" + "doctor reports an unreadable Dockerfile as a diagnosis instead of aborting."
- `src/container/image.ts`: new `BUILD_CONTEXT_ASSETS` enumeration (`Dockerfile`, `verbgate`,
  `entrypoint.sh`) feeds `configHash` via a sha256 digest per file (CRLF folded to LF first);
  `dockerfilePath()` generalizes to `buildContextPath()`. `test/unit/render.test.ts`, "editing
  docker/verbgate busts the tag even though the Dockerfile is untouched (ISC-160)" + same for
  `entrypoint.sh` + a structural test asserting every `COPY` source parsed out of the real
  Dockerfile appears in `BUILD_CONTEXT_ASSETS`, so the enumeration cannot silently fall behind
  a new `COPY` line.
- `src/cli/commands/up.ts`: the allowlist loop is now `assertModelsAllowed()`, an explicit
  membership test against `workers:` rather than a bare `catch`. The unknown-role bypass this
  was meant to close turned out to be unreachable through a real `up` — `FleetConfigSchema`'s
  `superRefine` already rejects an unknown role at parse time (ISC-68) — so the regression test
  builds a `LoadedConfig` past the schema to prove the second line of defence doesn't discard
  its own errors, rather than shipping a test that would have passed against the original bug
  too. `test/unit/config.test.ts` (3 cases) + `test/integration/up-wiring.test.ts`, "a worker
  naming an unknown role is refused before the repo is touched."
- `src/rpc/epoch.ts`: `assertEpochWellFormed` uses `Number.isSafeInteger`, not
  `Number.isInteger` — a value at/past `2**53` could never advance the fence (`epoch + 1 ===
  epoch`). `test/unit/epoch.test.ts`, boundary cases at `MAX_SAFE_INTEGER + 1`, `2**53`,
  `2**60`, `Infinity` refused; `MAX_SAFE_INTEGER` itself still accepted.
- `README.md`: exit code `8` (`EXIT.INTERNAL`) added to the ladder line.
- `test/unit/contracts.test.ts`: `worstExit` suite covers `EXIT.INTERNAL` outranking every
  other code, including usage.

Also fixed as part of the same round (bookkeeping, not code): ISC-247's checkbox (fixed and
tested in the first pass, but the checkbox flip was missed), ISC-22 reverted to open (checked
prematurely — see its criterion line for why), ISC-52 closed as a side effect of ISC-190's own
test. See the commit immediately above this section for the exact ISA diff.

**Verification, review round:** `bun test test/unit` — 856 pass, 0 fail (43 files); `bun test
test/integration/up-wiring.test.ts` — 10 pass, 0 fail; `bun run typecheck` clean. No new ISC
numbers closed by this round — it hardens ISC-160/190/216/217, already counted above.

**ISC-219, resolved by CI (not local Docker).** GitHub Actions' `container` job builds its own
worker image from scratch every run — it does not depend on this machine's deleted
`pifleet/pi-worker:verify` — so pushing this branch gave the ISC-219 test its first real
execution anywhere. Result: 52 of 53 tests in `verbgate.test.ts` passed, including the new one's
actual assertions; the job still went red because its `afterEach` scratch cleanup hit `EACCES`
removing `/outbox/policy` and `/outbox/cloud-allow` — files the test has the container itself
`mkdir`/`printf` into the bind-mounted outbox. On Linux a bind mount passes the container's uid
10001 straight through to the host, so the CI runner's own user cannot remove what uid 10001
created; macOS Docker Desktop's VM masks exactly this class of ownership mismatch, which is why
it looked fine when written and reviewed locally on this machine — the same asymmetry Group N's
mount-visibility notes already describe, on the write side instead of the read side. Fixed by
having the same container `rm -rf` the two paths it created before the script exits, so nothing
uid-10001-owned is left for the host-level cleanup to trip on. That push also exposed a second,
unrelated issue: the `container` job's own anti-skip guard (`EXPECTED: "52"`) was never updated
when the ISC-219 test was added, so a fully green 53/0/0 run still failed the guard on a count
mismatch — fixed by bumping `EXPECTED` to 53 (`.github/workflows/ci.yml`; needed the `workflow`
OAuth scope added to this machine's `gh` token, since the default scope set can't push changes
to workflow files). Re-run: **both CI jobs green** — `test` and `container`, 53/53 probes, no
skips. **ISC-219 closed.**

Progress: 191/255 → 192/255.

### Phase 6 close-out — 2026-07-28

- ISC-80: `steer.test.ts` asserts the injected message's POSITION in the
  worker's event stream — after the prompt, before the assistant entry — not
  that the call returned ok. Sending `ping` instead of `steer` turns it red.
- ISC-81: `abort.test.ts` aborts a 30s turn and asserts the observed phase
  transition back to `idle` inside 10s on a real clock, with verdict
  `aborted`. Sending `ping` instead of `abort` turns it red.

**ISC-129 remains open**, carried from Phase 4 for the same reason: both
halves are verified on `tmux`, but the criterion names the **cmux** backend,
whose `socketControlMode` is `cmuxOnly` and therefore refuses every call from
outside a pane. Claiming it needs a run from inside one.

*(2026-08-18 — both this diagnosis and the one before it were wrong; ISC-129
is now `[x]`, fixed, and live-verified. See the criterion line at the top of
`## Criteria` and `## Verification`, "Phase 4 close-out," for the real
mechanism and the fix.)*

Carried open from Phase 3: ISC-248, ISC-249 (blocked on ISC-27/28), ISC-253,
ISC-254.

### ISC-159 close-out — 2026-08-18

`doctor` could not meet this criterion for two independent reasons, and both are fixed
in `src/cli/commands/doctor.ts`. `versionProbe` captured a version string and compared it
to nothing, so "a wrong version" was undetectable by construction; and every finding —
whatever its cause — landed in one untyped `diagnoses` array that produced a single
`EXIT.BACKEND_UNAVAILABLE` throw, so "a missing binary" and "an absent daemon" were the
same row. `docker version --format {{.Server.Version}}` failing printed
`not available (docker exited 1)` whether Docker was uninstalled or merely stopped.

**Exit code: still 3 for every class, deliberately.** The ladder was NOT widened and
`src/contracts.ts` is untouched. An exit code is one number and `doctor` routinely trips
several classes in a single run, so encoding the class in the code forces a
`worstExit`-style collapse that destroys the very distinction this criterion asks for.
`EXIT.INTERNAL` is the one precedent for extending the ladder, and it was split from
`EXIT.USAGE` because a machine caller must take a categorically *different action*
(rewrite your arguments vs. stop, pifleet is broken); these three do not diverge that
way — all of them say "the host is not ready, fix it and re-run" and differ only in what
a human then types, which is what the criterion puts in the message. SRD §11 already
fixes the number ("Any missing `required` capability → exit 3 with a named diagnosis").
The distinction now travels as a `class` tag on `Diagnosis` — `missing-binary` /
`wrong-version` / `absent-daemon` / `misconfigured` — named for what the operator must
DO, surfaced per-diagnosis and as a top-level `diagnosis_classes` array in `--json`, and
led with in the human report (`DIAGNOSIS [absent-daemon] …`). The decision has one
documented home, the exported `exitForDiagnoses`.

**Version floors, and why these numbers.** No floor for docker, git or tmux is stated in
`Docs/SRD.md` or `fleet.example.yaml`, so each was derived from a feature this repo
already calls rather than picked:

- **docker >= 23.0.0** — `docker/Dockerfile` uses `COPY --chmod=` (a BuildKit frontend
  feature) six times and `container/image.ts` shells out to plain `docker build` without
  ever setting `DOCKER_BUILDKIT=1`. BuildKit became the default builder in Engine 23.0;
  on 22.x the classic builder runs and rejects `--chmod`, so no worker image builds.
- **git >= 2.32.0** — `harvest/git.ts`'s `HERMETIC_GIT_ENV` neutralises the developer's
  config against an untrusted repo via `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, both
  introduced in 2.32. Older git *ignores* them, so the hardening fails **open**, silently
  and unobservably — the strongest case here for enforcing rather than reporting.
- **tmux >= 2.4.0** — `backends/tmux/argv.ts` sets `pane-border-status` and
  `select-pane -T` (2.3) and calls `respawn-pane -c` (2.4). Applied as a *report*, not a
  gate: tmux is probed `required: false`, an absent tmux has never been a diagnosis, and
  "absent is fine but stale is fatal" would be incoherent — a below-floor tmux withdraws
  `backends.tmux` instead, the reported-never-required shape `read-screen` already has.

Ordering is part of the fix: a missing binary and a dead daemon both make the version
unknowable, so neither is ever followed by a floor verdict. An *unparseable* banner is a
third status (`unreadable`), reported as "could not verify the minimum" rather than as a
pass or as a violation, since only one of those is known.

`unreadable` only pays for itself if every consumer honours all three states, and two
places initially did not — both caught in review and fixed:

- **`backends.tmux` gated on `floor?.status === "ok"`**, folding `unreadable` in with
  `below` and withdrawing the backend. Because `floorDiagnosis` returns null for an
  optional tool, nothing was pushed to explain it: a working tmux vanished from
  `backends` with no finding anywhere in the report and an exit of 0. `tmux master` —
  what a git-built tmux prints, and *newer* than every numbered release — landed there,
  while `TmuxBackend.probe()` reported the same binary `ok: true`, so `doctor` called a
  tmux dead that `up --backend tmux` drove without complaint. The gate now tests
  `!== "below"`: only a version that actually parsed and actually lost the comparison is
  evidence enough to withdraw a backend.
- **The `unreadable` diagnosis was tagged `wrong-version`**, contradicting the
  remediation it shipped with. It is `misconfigured`: nothing parsed, so nothing lost a
  comparison and the tool may be current — what is known is that the name does not
  resolve to something answering with a recognisable banner, which is a property of the
  environment. Wrapper scripts, shims and version managers land here.

`doctor`'s banner parser is renamed `parseVersionTriple`, because
`backends/tmux/argv.ts` exports its own `parseVersion` over the same tmux banner
answering a different question (raw token for display and a present/absent test, versus
numbers for a comparison). They legitimately disagree on `tmux master` — `"master"` there,
`null` here — and two same-named exports that disagree on one input is how a later
"de-duplicate these" pass deletes the wrong one. Unifying them is a larger change and is
deliberately not attempted here.

Observed, per class, driven through PATH shims with `PATH` set to the shim dir **alone**
so the developer's own binaries cannot answer a probe
(`test/integration/doctor-diagnoses.test.ts`):

- *missing-binary*: no `git` on PATH → exit 3, `git-not-installed`, "install git and
  re-run". Absent `docker` → `docker-not-installed`, and `absent-daemon` is **not** in
  `diagnosis_classes` — the discrimination the criterion turns on.
- *absent-daemon*: a docker shim whose `--version` succeeds (client-only, never opens the
  socket) while `version` exits 1 → exit 3, `docker-daemon-unreachable`, message names the
  client version found and says to start Docker; `missing-binary` absent from the classes.
- *wrong-version*: `git version 2.20.1` → exit 3, `git-version-below-minimum`, message
  carries both 2.20.1 and 2.32.0. Docker `20.10.24` → `docker-version-below-minimum`.
- *misconfigured*: `git version unknown` → exit 3, `git-version-unreadable`, with
  `misconfigured` in `diagnosis_classes` and `wrong-version` asserted **absent** — the
  fix the message names ("check what `git` resolves to on PATH") is a PATH change, not
  an upgrade, and an operator filtering on `wrong-version` must not be sent here.
- *control*: docker 23.0.0 + git 2.32.0 exactly at the floors → exit 0, zero diagnoses.
- *optional floor*: `tmux 1.8` → exit 0, zero diagnoses, `backends.tmux: false`, probe
  detail naming 2.4.0; `tmux 3.6a` → `backends.tmux: true`. `tmux master` — unparseable,
  and newer than every numbered release — → exit 0, zero diagnoses, floor status
  `unreadable`, and `backends.tmux: **true**`: a backend is withdrawn only on confirmed
  evidence of staleness, never on the absence of evidence. The two non-`ok` statuses are
  additionally asserted side by side reaching opposite verdicts, since the bug was
  precisely that they converged.
- *multi-class*: a single run tripping a dead daemon beside a below-floor git yields
  `["absent-daemon", "wrong-version"]`, and beside an unparseable git
  `["absent-daemon", "misconfigured"]` — the array shape `diagnosis_classes` exists for,
  and which every single-fault case above leaves unexercised.
- All three classes asserted to share exit 3 while yielding three distinct messages and
  three distinct `diagnosis_classes` — the decision above pinned as a test, not left
  incidental. The human-readable branch is asserted separately from `--json`, since it is
  a different code path.

`test/unit/version-floor.test.ts` pins the parser against the three banner formats that
disagree (`git version 2.43.0`, `tmux 3.6a`, docker's bare `28.0.1`) and against the two
implementations that pass a casual read and are wrong: string comparison ranks `2.9`
above `2.10` (asserted directly), and `split(".")` turns `3.6a` into `NaN`.

The sibling suite's "healthy" docker shim was fixed in the same commit: it answered only
`--version` and let its catch-all return `{}` to the `docker version --format` call
`doctor` actually makes, so the stand-in was healthy by accident and reported a server
version of `{}`.

`bun run typecheck` → clean, zero diagnostics. `bun test` → **1142 pass, 53 skip, 0 fail**
across 77 files. `src/contracts.ts` unmodified; `EXIT_SEVERITY` unchanged.

Progress: 194/255 → 195/255.
