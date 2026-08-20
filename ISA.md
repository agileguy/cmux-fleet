---
project: cmux-fleet
task: Implement the pifleet SRD as a working Bun/TypeScript CLI, phase by phase
effort: E4
phase: build
progress: 222/272
mode: build
started: 2026-07-27
updated: 2026-08-19
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

**Checkbox meanings.** A criterion earns `[x]` only when something REPRODUCIBLE re-checks
it — a test that runs in CI and covers what the criterion literally says. `[~]` means
partially proved: the note states exactly which half is machine-checked and which half rests
on a hand-run on a developer host, and `[~]` does NOT count toward `progress:`. `[ ]` is
open. A live probe that self-skips in CI when a real dependency is unavailable is CORRECT
and should stay — but a criterion resting only on such a probe is `[~]`, not `[x]`. This
distinction was introduced 2026-08-19 after a sibling branch found a criterion marked `[x]`
on evidence that turned out to be falsified; the ISA is a system of record, so it has to
earn that.

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
- [ ] ISC-32: `up` refuses to start when a role's image is missing. **NOT IMPLEMENTED — stays open, and the reason it looked otherwise has been removed.** No test named it (`grep -rn 'ISC-32\b' test/` returns nothing; the only hits anywhere in the tree are the two docstring back-references this grading itself added, in `src/container/image.ts` and `src/cli/commands/image.ts`, which are pointers to this entry and not coverage) and no code implements it. Measured, not inferred: `grep -in image src/cli/commands/up.ts` returns ZERO lines — `up.ts` does not contain the string at all; `verifyImage` has exactly one caller in the tree (`cli/commands/image.ts`, the `image verify` subcommand); and NONE of the three `docker image inspect` calls in `src/` is on `up`'s path — `doctor.ts`'s `imageStatus` REPORTS and `up.ts` does not import it, and the other two are `container/image.ts`'s `listImages` and `verifyImage`, reached only from the operator-driven `image list` / `image gc` / `image verify` subcommands. `config/render.ts` calls `imageTag` solely to place the tag into the `docker run` argv. WHAT ACTUALLY HAPPENS with a missing image, which is the opposite of a refusal: `up` creates the run directory, clones a checkout per worker, registers a remote per worker in the OPERATOR's repository, materializes every input, launches every supervisor, and only then meets the idle gate at the end of the command — where the dead child surfaces as `worker <id> died during startup` with `EXIT.WORKER_DIED` (or `EXIT.TIMEOUT`), leaving the whole run's state on disk. "Refuses to start" and "starts everything, then reports a corpse" are different exit codes, different diagnoses, and different amounts of cleanup. WHY THIS READ AS CLOSED: three docstrings in `src/` asserted the control. `container/image.ts`'s header carried ISC-189's sentence VERBATIM ("`up` refuses to run against an image that is absent or fails `verify`"), its `ImageInputs` doc said "`up`, which only refuses an image that is ABSENT", and `cli/commands/image.ts` said "`verify` failing is load-bearing: `up` refuses to start on it". All three are now corrected in place to state what the code does and to point back here — a comment is not a control, and this is the same defect class the module has been patched for twice already. TO CLOSE: an image-presence gate in `up`, before any clone or supervisor exists (next to `assertModelsAllowed`), plus a test in `up-wiring.test.ts` — whose docker PATH shim can already answer `image inspect` with a failure, so this needs no daemon and can run in the fast `test` job.
- [x] ISC-33: `gcloud version` succeeds inside every worker image regardless of `toolchain`.
- [x] ISC-34: `kubectl version --client` succeeds inside every worker image.
- [x] ISC-35: `helm version` succeeds inside every worker image.
- [x] ISC-36: `jq --version` succeeds inside every worker image.
- [x] ISC-37: `curl --version` succeeds inside every worker image.
- [x] ISC-38: PID 1 in a worker container is `tini`.
- [x] ISC-39: The container entrypoint renders `~/.pi/agent/models.json` from env and Pi registers the oMLX provider (SRD Q9).
- [x] ISC-40: The rendered `models.json` survives the read-only root (written to a writable tmpfs path Pi reads).
- [ ] ISC-270: Every `COPY` source in `docker/Dockerfile` appears in `BUILD_CONTEXT_ASSETS`. **FILED OPEN 2026-08-19, and filed rather than fixed deliberately — the array is CORRECT today, so there is nothing to repair; what is missing is the thing that keeps it correct.** Measured now, so a future grader inherits the baseline instead of re-deriving it: `BUILD_CONTEXT_ASSETS` is the hand-maintained three-element array `["Dockerfile", "verbgate", "entrypoint.sh"]` (`src/container/image.ts`), and the only `COPY` sources in `docker/Dockerfile` are `docker/verbgate` (five times, lines 78-82) and `docker/entrypoint.sh` (line 164) — so the array covers the build context exactly, plus the Dockerfile itself. **THE FAIL-OPEN.** `configHash` hashes the content of every file in that array and nothing else, and the array is maintained BY HAND. Add a file the Dockerfile `COPY`s without adding it to the array and the hash does not move, the tag does not move, and a stale image is silently reused — with nothing anywhere reporting it. The failure is silent in both directions that matter: the build succeeds, and the run succeeds against the wrong bytes. **WHY IT IS ITS OWN CRITERION.** This is the flank of ISC-160 ("a stale image is not silently reused after the Dockerfile changed"), which is `[x]` and genuinely proved — but proved for edits to files ALREADY in the array. ISC-160 does not, and cannot, observe a file that was never enrolled. Until now the gap lived only as a subordinate clause inside `ISC-189`'s note and as prose in the header of `container/image.ts` — i.e. inside the very module it describes, which is the arrangement that let three docstrings in this same module assert controls the code did not have. A gap named in prose by the thing it afflicts is not tracked; it is annotated. **TO CLOSE — and note how cheap it is.** One unit test: parse `docker/Dockerfile`, extract every `COPY` source under `docker/`, assert the set is a subset of `BUILD_CONTEXT_ASSETS`. No daemon, no image build, no Docker-gated job — it reads two files off disk, so it runs in the fast `test` job on every PR. **It does NOT depend on the `up` image gate that ISC-32 and ISC-189 are waiting on**, and must not be bundled into that work: those two need a new control on the launch path, this needs a subset assertion over two files that already exist. Blocking a five-minute test on a design decision about `up` is how this gap stayed prose for as long as it did.

### Group D — Google credentials

- [~] ISC-41: With `cloud_access: true` and `adc_mode: token`, `gcloud auth print-access-token` succeeds inside the container. **PARTIAL — the positive case is proved on a developer host only.** It had been marked `[x]` with NO evidence and was in fact FALSE as shipped: `grep -rn 'ISC-41\b' test/` returned only comment references, no test named it, and no test in `test/integration/adc.test.ts` invoked `gcloud` at all — while ISC-255's measured `[Errno 30]` crash meant every gcloud call in a real worker failed even with a valid credential. MACHINE-CHECKED, every CI run: `test/unit/render.test.ts` proves `buildDockerArgv` emits the writable gcloud-config tmpfs for every role (mutation-proved), and `adc.test.ts`'s "the gcloud config dir is writable by the worker uid" probe proves the container that flag produces is actually writable by uid 10001 on a tmpfs — the precondition whose absence made this criterion false. LOCAL ONLY, not re-checked anywhere automated: that real `gcloud auth print-access-token` then exits 0 and returns the injected token. That is `adc.test.ts`'s "with cloud_access and a token, gcloud auth print-access-token succeeds (ISC-41)", which mints a genuine ~1h token through the production `gcloudMinter` from the host's own ADC and asserts exit 0, stdout equal to the minted token (compared by sha256 digest so a failure never prints a live bearer token), and stderr EMPTY — empty stderr being load-bearing, since the root-owned-tmpfs near-miss also exits 0 while warning on every call. It is `test.skipIf(!HOST_ADC_PRESENT)` and skips on every CI runner, because no runner has an operator's Google login and no synthetic file can stand in for one. Run against `/usr/local/libexec/gcloud.real`, deliberately bypassing the PATH `verbgate` wrapper — see ISC-46 for why, and for the recorded consequence that the PATH form never exits 0 in a real worker. Verified locally 2026-08-19: 18/18 in `adc.test.ts` with a real host ADC present.
- [x] ISC-42: In `token` mode, no `refresh_token` appears in the container environment.
- [x] ISC-43: In `token` mode, no `refresh_token` appears anywhere on the container filesystem or in `/creds`.
- [x] ISC-44: The host `~/.config/gcloud` directory is not in any container's `docker inspect` mount list. Fully machine-checked in CI, at two altitudes. `test/unit/render.test.ts` (no daemon, runs everywhere) asserts the ARGV `renderWorker`/`buildDockerArgv` would launch never names `hostGcloudConfigDir()`, for a `cloud_access: false` role and a `cloud_access: true, adc_mode: file` role alike. `test/integration/adc.test.ts` (Docker-gated only — no host credential needed, so it runs in the container job) `docker inspect`s real containers in the role shapes §5.8 can produce and asserts no `.Mounts[].Source` is, is under, or CONTAINS the host directory, with the one documented exception of the single ADC file `file` mode may mount. THREE CORRECTIONS this round. (1) The ANCESTOR direction was entirely missing: both altitudes asked only whether a source was the store or sat UNDER it, so mounting `$HOME` or `$HOME/.config` handed over the whole multi-account auth store and passed every assertion — reachable through supported config, since `run.repo` is operator-settable and is mounted at `/workspace`. Worse, the unit check routed through `runStateHostPaths`, which DROPS every `/workspace` mount, so it was structurally blind to the one mount that could do this. Both now use `classifyHostGcloudExposure`, production's own three-relation predicate, and `assertNoHostGcloudMount` runs it inside `buildDockerArgv` itself, so the criterion is ENFORCED at launch rather than merely asserted about — the constants previously had zero importers in `src/` and closed nothing. A dedicated test drives `run.repo: ~` and `run.repo: ~/.config` through `renderWorker` and requires a `HostGcloudMountError`; mutation-proved by deleting the guard. (2) Mount sources are `realpath`-normalised on both sides in the integration check — a lexical compare passes a symlinked source (`/tmp -> /private/tmp` on macOS is the everyday case) or an APFS case variant. (3) The `file`-mode case is now marked FORWARD-LOOKING rather than production-verified, and honestly so: nothing in `src/` mounts an ADC file — `buildDockerArgv` emits no `/creds` mount and `fileModeMaterials`/`fileModeStartupEnv`/`ADC_FILE_PATH` have no production caller — so that test hand-writes the `-v` itself and inspects a shape it authored. It pins the contract `file` mode must satisfy when wired; it is not evidence about a launch `up` can perform today. It is also now CI-runnable via `PIFLEET_TEST_ADC_FILE` (it needs a FILE, not a valid credential), where before it silently ran in no job at all.
- [x] ISC-45: A role with `cloud_access: false` has no Google credential. Machine-checked in CI at two altitudes; no host credential needed for either. `test/integration/adc.test.ts` (Docker-gated) starts a container in the exact env `planCredential` returns for such a role — empty: no pointer, no token file, no `/creds` content — and probes both a fresh `env` and `/proc/1/environ` (the two can differ) for all four delivery vars, with a same-image contrast test on an injected `token`-mode container showing every one of those things present, so the absence is a property of the ROLE, not of the image. `test/unit/render.test.ts` adds the cheap always-runs counterpart the criterion previously lacked: for a `cloud_access: false` worker, neither the rendered argv nor the rendered `--env-file` names any of `CREDENTIAL_ENV_VARS` — the env-file specifically, because §5.6 delivers a worker's environment that way and the integration rig's `-e` flags exercise a path production does not use. THE VECTOR SET WAS OVERSOLD as "four env vars" and is corrected: `$CLOUDSDK_CONFIG` was the vector this suite had blinded itself to (ISC-255) and is now swept and asserted empty; `/home/pi/.kube/config` — the ONLY credential-bearing mount `buildDockerArgv` actually emits today, gated on `cloud.kubeconfig !== null && w.cloudAccess`, and a kubeconfig with a `gcp` auth-provider or an embedded token IS a Google credential — now has its own probe asserting the mount point is empty for such a role; and the GCE metadata fallback at 169.254.169.254 is closed by `--network none`, which `startContainer` now applies by default.
- [x] ISC-46: In a `cloud_access: false` role, `gcloud auth print-access-token` fails. The criterion as literally worded — FAILS without a credential — is machine-checked in CI: both probes are Docker-gated only and need no host credential. The first runs `/usr/local/libexec/gcloud.real` (the real binary, bypassing the PATH `verbgate` wrapper deliberately: verbgate classifies this verb as MUTATING regardless of credential state per ISC-210, a §5.10 concern orthogonal to this one, so testing through it would measure the gate rather than the credential) and requires gcloud's own credential-absence message, not merely a nonzero exit — so the test cannot be satisfied by gcloud being missing (127) or gated (77). That message is now matched by REGEX on the invariant fragments rather than pinned verbatim: it is google-cloud-cli's English, the image installs the SDK unpinned, and CI rebuilds the image every run, so an exact string was a false red waiting on an upstream copy edit. The second probe is new and covers the criterion's LITERAL command through PATH, where an agent actually types it: `gcloud auth print-access-token` exits 77 with verbgate's refusal. THE CONSEQUENCE IS RECORDED because it surprises anyone reading the criterion straight: in a real worker this command never exits 0, credential or no credential, so ISC-46 holds for a STRONGER reason than it claims. **Local only, not re-checked in CI:** the positive control — the same command in the same container flipping exit 1 to exit 0 once a REAL minted token is injected, with stdout equal to the token by sha256 digest. That is `test.skipIf(!HOST_ADC_PRESENT)` and skips on every runner. It is the strongest evidence in the block and it rests on a developer host; the criterion is nonetheless `[x]` because what it literally asserts (failure in the absence of a credential) is fully covered by the two CI-runnable probes.
- [~] ISC-47: After `token_refresh` elapses, a `gcloud` call inside a long-running container still succeeds. **PARTIAL — proved on a developer host only, and only the in-container half.** Like ISC-41 this had been marked `[x]` with NO evidence (`grep -rn 'ISC-47\b' test/` found only comments) and was equally falsified by ISC-255. The evidence is `adc.test.ts`'s "a gcloud call still succeeds after a refresh re-injection (ISC-47)": one long-running container, a real minted token injected, gcloud verified to return exactly that token, then a SECOND genuinely separate mint injected through the same production `injectToken` the refresh loop drives, and gcloud verified to return the NEW value — so the assertion is that the refresh took effect, not that a cached credential kept working. It is `test.skipIf(!HOST_ADC_PRESENT)` and SKIPS IN CI; nothing automated re-checks it. Two further gaps, stated plainly rather than smoothed over: (1) the re-injection stands in for the elapsed interval deliberately — sleeping out a real `token_refresh` costs minutes of wall clock and would measure the supervisor's timer, which is `supervisor.test.ts`'s monotonic-clock territory (ISC-155); (2) nothing in `src/cli/**` mints or injects at all yet (ISC-248; see ISC-48 on `gcloudMinter` having no caller), so this proves a mechanism, not that a live `up` run ever refreshes anything.
- [~] ISC-48: With `impersonate_service_account` set, the token's identity is the SA, not the launching user's account. **PARTIAL — the criterion names a TOKEN, and no token is ever minted.** MACHINE-CHECKED, every CI run (`test/integration/up-wiring.test.ts`, real CLI, real `adc.ts`, PATH-shimmed `gcloud`/`docker`, no Docker daemon or host credential required): every worker's grant line names the configured SA and never the shimmed operator account nor the `"(adc user)"` placeholder — substitution, not coexistence — and (the actual security property) the operator's own account is never even asked for, the `gcloud` shim's call log being empty for a run where every `cloud_access` worker impersonates, against a control run that logs exactly one `config get-value account`. That empty log is now itself verified: before `up` runs, the test drives one throwaway `gcloud` call through THAT RIG's own PATH and asserts it landed in THAT RIG's log, then truncates — previously the only control was a DIFFERENT rig, so a shim that failed to install in the impersonating rig produced an empty log and a green test, which is the exact hazard the control claimed to close. Mutation-proved: widening `up.ts`'s resolve-identity guard to fire regardless of impersonation leaves every grant line byte-identical and only the call-count assertion goes red. **NOT PROVED, and the blocker is structural rather than environmental — the previous close-out named the wrong one.** It said no such SA was available on this host; the larger truth is that `gcloudMinter` has NO CALLER ANYWHERE IN `src/cli/**` (`up.ts` plans and prints, then stops — ISC-248), so no `up` path mints in any configuration and there is no token whose identity could be checked. Even when it is wired, note that impersonation is DELEGATED: at real mint time the operator's ADC IS used to obtain the SA token, so "the launching user's account is never consulted" is true of PLANNING and cannot be true of the mint itself. Separately, no real granted SA was available to test against — the SRD's example project is not reachable under this host's identity, and the only discoverable service accounts belong to a live production project, so impersonating one for this personal project's suite was deliberately avoided.
- [x] ISC-49: `up` prints the granted identity, project, and ADC mode for every `cloud_access` worker. Machine-checked in CI (`test/integration/up-wiring.test.ts` needs no Docker daemon and no host credential): a real `up` run over three workers (two `cloud_access: true` sharing one role, one `cloud_access: false`) with `cloud.adc_mode: file` and a distinctive `cloud.quota_project` asserts every line is keyed by worker id (not merely found), that both cloud workers' lines carry identity + the distinctive project + `"file mode"` (and explicitly not `"token mode"`, so a line ignoring `cloud.adc_mode` is caught), and that the non-cloud worker's line says `"no credential"` and carries none of the three. A companion test confirms the lines reach actual stdout, not only the ledger, when `--json` is absent. THE IDENTITY WAS COMING FROM THE WRONG CREDENTIAL STORE and is fixed. `resolveIdentity` read `gcloud config get-value account` — the `gcloud auth login` account — but `mintArgv` mints from ADC and `file` mode hands over `application_default_credentials.json`; these are separate stores written by separate commands and they routinely differ, so the printed line could name an identity the worker was never granted, in BOTH modes, and the suite asserted that line was correct. It now prefers the ADC file's own principal (`client_email` for service-account ADC, `account` for `authorized_user`) and falls back to the config account only when the file cannot name one — which is not hypothetical: measured on this host, `gcloud auth application-default login` wrote `"account": ""`, present and EMPTY, so the fallback is load-bearing rather than decorative. A fixture whose two stores DISAGREE on purpose pins it, since on a machine where they match (the common case, and the case here) no test could tell them apart; mutation-proved by reverting to config-first, which turns only that test red. `hostAdcFile()` also now honours `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's own ADC override — deliberately NOT applied to `hostGcloudConfigDir()`, since letting an env var redirect a security boundary is how the boundary stops meaning anything. Also corrected: a `String(r.detail?.["plan"])` in the ledger helper yielded the literal string `"undefined"` on a missing field, which is truthy, non-empty, and contains none of the things the ISC-48/49 tests assert are absent — every `not.toContain` in this file was vacuous against a dropped field. The type is now asserted before coercion.

### Group E — Local model (oMLX)

- [~] ISC-50: A container completes a model call against `host.docker.internal:8000`. **[PARTIAL 2026-08-19 — DOWNGRADED from [x] by the PR #18 security review]** The MECHANISM is closed and unconditional: `test/integration/relay.test.ts`'s stub test proves a container attached to nothing but the deny-all internal bridge — no `--add-host`, no second network, no capabilities — completes a `GET http://host.docker.internal:<port>/v1/models` and receives the upstream's OWN body, carrying a nonce that cannot have been synthesized by Docker, on an EPHEMERAL port (which is what proves the port is read from `llm.base_url` rather than hardcoded). **Why this is no longer `[x]`:** the LIVE half — the same call against the real oMLX server, which is what ties the mechanism to the actual model server — self-skips when oMLX or `OMLX_API_KEY` is absent, and oMLX here binds `127.0.0.1:8000`, LOOPBACK ONLY. The live path therefore depends on Lima's host-gateway forwarding reaching macOS loopback: an environment property of this laptop, not a property of pifleet, and one that will not hold on a CI runner or on native Docker. Combined with ISC-257 (this suite runs in NO CI job at all), a criterion whose live evidence can only ever execute on one machine is `[~]`, not `[x]`. **Stated limit, unchanged:** what is asserted is a call to the model SERVER, not an INFERENCE — a real `POST /v1/chat/completions` was measured round-tripping through the relay by hand on 2026-08-19 (705 ms warm, correct answer from inside the bridge), but that measurement is deliberately not a test; see ISC-258.
- [~] ISC-51: That call succeeds with no route OFF THE BRIDGE SUBNET. **[PARTIAL 2026-08-19 — DOWNGRADED from [x], and the criterion itself RE-WORDED, by the PR #18 security review]** The previous wording was "with no route to the public internet" and it was closed on evidence that had been FALSIFIED: a container on the deny-all bridge, with no relay running, pulls `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.13` off the bridge gateway `172.18.0.1:22`. Docker's internal-network isolation lives in the FORWARD chain (`! -d 172.18.0.0/16 -i br-<id> -j DROP`), but the gateway is ON-LINK and inside that subnet, so gateway-destined traffic is delivered through INPUT (policy ACCEPT) and is never filtered. The old evidence probed `1.1.1.1` and `example.com` and never measured the gateway — sampling is precisely what missed it. See SRD §12.8's 2026-08-19 erratum for the full measurement and the decision to accept it as a residual. **What is now proved, and how:** `test/integration/relay.test.ts` ENUMERATES rather than samples — exactly one on-link route and zero default routes, read from `/proc/net/route`, which bounds the whole address space instead of five points in it; plus non-zero-exit probes for a public IP, a public name, the LAN oMLX candidate, the Lima host address and the cloud metadata address. The gateway residual is asserted as a POSITIVE (discovered from a non-internal network first, so the assertion is not circular), which converts the finding into a regression test: if the gateway is ever hardened, that test fails and this criterion can be tightened. **Why still `[~]` and not `[x]`:** the reachable set is `{relay ports} ∪ {gateway ports} ∪ {sibling container ports}` and is NOT fixed — anything the host or a sibling binds later joins it with no code change — so the criterion holds as re-worded but the posture is not the closed set the original wording implied. ISC-261 tracks re-taking this against an enumerated reachable set.
- [x] ISC-52: A model outside `models_allowlist` is refused at `up` with exit 2.
- [x] ISC-53: A model that answers a `tools`-bearing probe with prose is refused at `up` with exit 2. **[CLOSED 2026-08-19, Group E]** `security/model-probe.ts` sends one `tools`-bearing completion per DISTINCT resolved model (deduped — six workers on one model is the normal §5.9 F40 shape, and six real generations to learn one fact is a tax on every `up`), and refuses unless BOTH `finish_reason === "tool_calls"` and a non-empty `tool_calls[]` come back; either half alone lets through a server claiming a call it did not make. The refusal is a `ConfigError` subclass, so exit 2 is inherited from the machinery ISC-52 already uses rather than restated. Proven at the CLI, not just at the module: `test/integration/up-wiring.test.ts` → `the native-tool-call probe gates the launch path (ISC-53)` runs the real `up` against a stub oMLX that answers in prose and asserts exit 2, a message naming `eng-1`/`wiring-test-model`/`require_native_tool_calls`, and — the part that makes "launches nothing" a fact rather than a claim — an empty `workersDir` and an empty ledger. Mutation-proved: replacing `await assertModelsSupportToolCalls(...)` in `up.ts` with a no-op turns 4 of that describe's 5 tests red (re-measured 2026-08-19 after the review fixes; it was 3 of 4 before `the gate is ON by default` was added), so the wiring is held in place by tests rather than by hope. The three failure classes are kept apart deliberately: prose → exit 2 (the operator named the wrong model); unreachable/malformed → exit 3 (nothing was learned about the model, so sending the operator to edit a correct `model:` line would be a misdiagnosis). **Evidence split (all CI-executable).** Everything this criterion asserts runs on every push: `test/integration/up-wiring.test.ts` needs no oMLX, no Docker daemon and no GPU — it drives the real CLI against a stub server it owns — and `ci.yml`'s `test` job runs `bun test test/integration` on `ubuntu-latest`. Nothing here rests on a local run. **Review round 3 (PR #17) corrected two defects in this gate before it could honestly stay closed.** (1) `prose` was the FALL-THROUGH class, so any 2xx that was not exactly a well-formed tool call was reported as "this model answers in prose", exit 2 — which swept in `finish_reason: "length"` with no tool_calls, i.e. a REASONING model whose `<think>` preamble outran the probe's own 200-token budget, on a host that serves Qwen3.5-* reasoning models. `prose` is now identified POSITIVELY (`finish_reason === "stop"` and no calls); truncated, filtered, unknown-reason and self-contradictory answers land in a new `inconclusive` class at exit 3, and `max_tokens` is 2048. (2) A timeout was reported as `unreachable` ("Start oMLX") about a server that was up and cold-loading, and every non-2xx collapsed into "the server is down" — a 404 naming the model is now `model-not-found` at exit 2 with its own error class. Exit 2 is now reserved for the two classes where something in `fleet.yaml` is actually wrong. **Stated gap:** the live PROSE case is reproduced nowhere. §5.9 records `Qwen3-8B-4bit` answering in prose, but that model on the `192.168.86.49` endpoint returned a well-formed native `tool_calls` on 2026-08-19 — oMLX now applies per-model output parsers (`VLM tool calling enabled: parser=gemma4` in its own log), so the incompatibility may have been fixed server-side. The refusal is therefore proven against frozen wire shapes only; the POSITIVE control is live. That is the right way round: a gate must not require a broken model to exist in order to be testable.
- [x] ISC-54: `doctor` reports the oMLX model list. **[CLOSED 2026-08-19, Group E]** `doctor --json` emits `omlx.models`, and `test/integration/model-probe.test.ts` → `the model list doctor prints is the list the server is serving (ISC-54)` asserts it SET-EQUAL to what an independent `GET /v1/models` returned inside the same test. Set-equality is the load-bearing choice: a hardcoded list, a stale cache, or an echo of the configured `llm.model` all satisfy "non-empty", and none of them is reporting the server's model list. Measured live against `http://192.168.86.49:8000/v1` → 32 models reported, matching exactly. **Evidence split, added in review round 3 (PR #17).** That live test is `test.skipIf(!LIVE)` and CI has no oMLX, so until now this criterion's ONLY evidence was a local run transcribed into a PR body — reproducible by nobody, re-checked by nothing, and silent in Stated Gaps. The criterion is a statement about what `doctor` REPORTS, and reporting is exactly the half a stub can prove, so the two halves are now named separately. **MACHINE-CHECKED, every push:** `test/integration/doctor-omlx.test.ts` runs `doctor --json` as a real subprocess against a loopback oMLX-shaped server and asserts `omlx.models` SET-EQUAL to what was served, where two of the three served ids are strings no fleet.yaml in that file names — so an echo of `llm.model`, a hardcoded array and a stale cache all fail. Mutation: reporting the configured model instead of the served list turns 2 tests red. **LOCAL RUN ONLY:** that the list is a REAL server's — 32 models on actual hardware. That residual is a property of the endpoint, not of this code path, and it is the same code either way.
- [x] ISC-55: `doctor` reports a measured single-request oMLX latency. **[CLOSED 2026-08-19, Group E]** `doctor --json` emits `omlx.list_latency_ms` and `omlx.completion_latency_ms`, the latter from one real `max_tokens: 1` generation — the number §5.9 F40 says `max_concurrent` must be set from. Measured live: `/models 155ms, 1-token completion 63ms` against `Qwen3.5-0.8B-MLX-bf16`. The test asserts the value is non-null, finite, `> 0` and `< 120_000`; a bounded range is what distinguishes a measurement from a timeout or a clock read twice. Fixed along the way, and the reason this was not already closed: with no config `doctor` fell back to `models[0]`, which on a server whose list begins with an embedding model returns HTTP 500 — leaving `completion_latency_ms` null and ISC-55 silently unreported on exactly the invocation someone runs when they have no config yet. `chatProbeModel`/`isEmbeddingModelId` skip self-named embedding ids on the fallback path ONLY; a configured `llm.model` is always used verbatim, because second-guessing the operator would report a latency for a model no worker runs. **Evidence split, added in review round 3 (PR #17)** — same disease as ISC-54, and the honest accounting matters more here because the number is the point. **MACHINE-CHECKED, every push:** `test/integration/doctor-omlx.test.ts` proves the MEASUREMENT MECHANISM through the real `doctor --json` path — the stub deliberately holds its completion for 40ms and the reported `completion_latency_ms` must clear that floor, so a constant, a clock read twice, or a number invented elsewhere all fail; `probe_model` must be the model the config named; and `list_latency_ms` must come in BELOW the completion floor, which is what shows the two are genuinely separate timers rather than one figure reported twice. A failing completion must null the latency and still report the model list. Mutation: replacing the latency with a constant turns that test red. The 40ms floor is deliberate — a stub that answers instantly cannot distinguish a measurement from a constant, and a loopback round trip can round to 0ms, which would make `> 0` flaky rather than meaningful. **LOCAL RUN ONLY:** that the number describes a real generation on real Apple-silicon hardware (`/models 155ms, 1-token completion 63ms` against `Qwen3.5-0.8B-MLX-bf16`). A stub necessarily reports a measurement of the stub, and §5.9 F40 wants this figure for sizing `max_concurrent` against REAL throughput — so this half cannot be automated and is not claimed to be.
- [x] ISC-56: `up` refuses to start while an MLX training run is active, unless `--i-know` is passed. **[CLOSED 2026-08-19, Group E]** `safety/mlx-training-guard.ts` scans `ps -axo pid=,command=` for command lines pairing an `mlx_lm`/`mlx-lm`/`mlx.` module with a TRAINING verb (`lora`, `train`, `fuse`, `dpo`, `sft`) and never `server` or `generate` — the pairing is the entire design, because a bare `/mlx/` match would hit `mlx_lm.server`, the inference server a fleet REQUIRES, and refuse every `up` on every correctly configured host. `up` refuses with exit 3 (`BACKEND_UNAVAILABLE`: the command line is fine, the host is busy) before the run directory is populated, and `--i-know` proceeds while writing BOTH an immediate stderr warning and an `mlx_training_guard_overridden` ledger event, so the choice survives the scrollback for whoever reads `report` after a panic. Proven with a real process rather than a canned string: `test/integration/up-wiring.test.ts` → `the MLX training guard gates the launch path (ISC-56)` spawns a `#!/bin/sh` script literally named `mlx_lm.lora`, waits until the real `ps` publishes its argv, then asserts the refusal names that pid; the `--i-know` test asserts the pid INSIDE the ledger event, which is what fails if the append is ever reduced to a bare marker. `test/integration/mlx-training-guard.test.ts` adds the critical negative live — a real process named `mlx_lm.server` is spawned and NOT matched. Mutation-proved: forcing the scan to return `[]` turns 2 of the 3 launch-path tests red (re-measured 2026-08-19). All of it is CI-executable — the guard needs only `/bin/sh` and a `ps` supporting `-axo`, so no half of this criterion rests on a local run. **Review round 3 (PR #17) found the matcher itself defective, and the module's own comment asserting otherwise.** The patterns were substring-matched against the WHOLE `ps` command line, so a training entry point's NAME anywhere in the line counted as a running training run. Verified matching before the fix: `python -m mlx_lm.server --port 8000 --adapter-path /Users/dan/out/mlx_lm.lora`, `tail -f /Users/dan/logs/mlx_lm.lora.log`, and `grep -rn mlx_lm.lora /Users/dan/repos`. The first is the serious one — serving a LoRA adapter from a directory named for the entry point that produced it is the ordinary way to serve a fine-tune, so the guard refused every `up` on a host running exactly the inference server the fleet requires: the precise catastrophic outcome the design was written to avoid, and the outcome the comment claimed the verb-pairing made impossible. The verb pairing is NECESSARY BUT NOT SUFFICIENT; matching now also asks whether the token is the PROGRAM BEING RUN (`programTokens`), and the comment says so. The tested oMLX negative carried no such path, so it could only ever have failed if someone added a bare `/mlx/` pattern — it pinned the pattern list, not the discrimination, and a real-process version of the adapter-path case now covers that. Also closed four false negatives (the `mlx_lm/lora.py` venv script form, `grpo`/`orpo`/`finetune`, `mlx_vlm`, uppercase). Measured over a 27-case adversarial argv corpus run through the real matcher: **10 wrong before, 0 wrong after.** **Stated gap, by design:** this is a documented HEURISTIC, not an interlock. It cannot see a bespoke training script (`python train_my_model.py`), a run inside a container, a run on another machine, or a notebook kernel whose argv is just `python -m ipykernel_launcher`. `--i-know` exists because the operator knows things the scan cannot, in both directions; a false negative is merely the status quo before the guard existed, and a false positive costs one flag.
- [~] ISC-57: Egress to any host other than the oMLX endpoint and the configured Google endpoints is denied from inside a container. **[PARTIAL — NOTE REWRITTEN 2026-08-19; the previous reasoning was backwards]** **The gap is in the LOOSE direction, and that is the leading fact.** The previous note said the live posture was "strictly TIGHTER than this criterion describes, not looser". That is false. The bridge gateway IS a host other than the oMLX endpoint — a different machine, the Colima VM rather than the macOS host — and it is NOT denied: measured 2026-08-19, a container on the deny-all bridge with no relay running reaches `172.18.0.1:22` and gets a live sshd banner. The criterion is therefore VIOLATED in the loose direction, independently of anything to do with Google. `[~]` happened to be the right marker, but recorded for the wrong reason — which is worse than being unmarked, because the next reader closes it on reasoning that does not hold. Mechanism and measurement: SRD §12.8's 2026-08-19 erratum; enumerated evidence: `test/integration/relay.test.ts`. **The secondary half, which was already correct:** the configured Google endpoints are denied too, because no relay forwards them (ISC-253) — `oauth2.googleapis.com` fails with curl exit 6 in the same run. So "Google works" is not yet true and must not be implied. Both halves must be re-taken against an ENUMERATED reachable set rather than sampled destinations (ISC-261). The committed test asserts non-zero curl exits rather than specific error numbers; the hand-measured numbers (`1.1.1.1` exit 7 = no route, `example.com` exit 6 = no resolver) are recorded here as evidence, not asserted there as behaviour, so the suite is not hostage to curl's error taxonomy.
- [x] ISC-260: The ISC-53 native-tool-call probe is performed from INSIDE the egress network the workers use, not from the host. *(Added 2026-08-19 by PR #17's review round 3. Number chosen to clear the three in-flight branches: 255 is claimed by PR #16, 256 by this branch, and 257/258/259 by PR #18.)* Today `up` probes oMLX from the host — `hostFacingBaseUrl` exists precisely to rewrite the container-facing `llm.base_url` into something the host can reach — while every WORKER reaches oMLX through the internal egress bridge. On the current topology both resolve to the same box, which masks the asymmetry completely. The moment oMLX moves to the LAN (the decision behind the pending §5.9/§12 erratum) the two stop agreeing, and the failure mode is the bad one: ISC-53 passes on the host, certifying a model, while every worker is denied by the egress policy and discovers it at RUNTIME. That is precisely the "burns a whole run before anyone notices" outcome §5.9 makes this probe mandatory to prevent — a gate that certifies reachability it did not test is worse than no gate, because it is trusted. Closing this means running the probe from a container attached to `docker.network` rather than from the host process, at which point `hostFacingBaseUrl` and the doc comments at `security/model-probe.ts` and `cli/commands/doctor.ts` that explain it become dead weight and should go with it. Deliberately NOT implemented in PR #17: the topology decision is not this branch's to make, and a probe rewritten against a topology that has not landed yet would be rewritten twice.. **Merge note, 2026-08-19 (PR #18).** Landing the egress relay broke two of this criterion's sibling tests in `up-wiring.test.ts`, and the cause was a TEST FIXTURE, not the product. `stubOmlx` published its base_url as `http://127.0.0.1:<port>/v1`; `omlxRelayTarget` refuses any host but `host.docker.internal`, so `up` exited 3. **An earlier draft of this note claimed no value of `llm.base_url` could satisfy both the host-side ISC-53 probe and the relay. That was wrong, and the correction matters:** `hostFacingBaseUrl` (`src/security/model-probe.ts:195-209`) rewrites the HOSTNAME ONLY and preserves the port, so `http://host.docker.internal:<port>/v1` probes as `localhost:<port>` from the host AND relays as `host.docker.internal:<port>` from the bridge. Measured on the rebased tree; the fixture now uses that spelling and all 23 tests in the file pass with nothing skipped. **PRODUCTION WAS NEVER AFFECTED** — the schema default `http://host.docker.internal:8000/v1` already satisfies both by the same rewrite, verified directly. So this criterion remains what it always was: a design improvement (probe from inside the egress network rather than relying on a host-side hostname rewrite), NOT a blocker, and no test is dark because of it. **CLOSED 2026-08-19 (PR #20).** The probe now runs in a throwaway container on `docker.network` (`src/security/probe-transport.ts`), so it dials `llm.base_url` VERBATIM from where the workers dial it. `hostFacingBaseUrl` is DELETED, not relocated, and with it the five unit tests that pinned the rewrite — replaced by their inverse, that the base URL reaches the transport untouched. `probeNativeToolCalls` and `assertModelsSupportToolCalls` no longer DEFAULT `fetchImpl` to the global `fetch`: that default was a host-side probe one omitted argument away, which is the whole defect. **Ordering changed, and had to**: the probe moved from the line after ISC-52 to after `ensureEgressNetwork`/`ensureEgressRelay`, because on an `--internal` bridge `host.docker.internal` resolves to the relay and resolves to nothing at all before the relay exists. It still sits before `run.json`, the ledger and every supervisor, so "a refusal launches nothing" is unchanged. **EVIDENCE, and which half CI executes.** `test/integration/probe-in-network.test.ts` puts the stub oMLX in a CONTAINER on the internal bridge with no published port, so one identical URL gives opposite answers by vantage — measured: 200 with the body and auth header intact from a container, `Unable to connect` from the host. That asymmetry is what makes the criterion falsifiable rather than merely asserted: swapping `containerFetch` for the global `fetch` turns 2 of its 3 daemon tests red (the probe itself, and the stub's own log showing it was never reached), and NO url rewrite rescues them, because the host has neither a route nor a way to resolve the name. Its 3 daemon-gated tests are RUN by CI's container job — the file is listed in the probe-guard invocation and `TOTAL_EXPECTED` moved 72 -> 77, derived by the documented gate-closed method (measured: `2 pass, 75 skip`, 77 collected across 6 files) rather than by incrementing. Its other 2 tests are daemon-free argv pins (`--network` present, a flag-shaped network name refused) and run in the fast job on every push. `up-wiring.test.ts` remains 23 pass / 0 skip and still pins the WIRING: deleting the gate from `up.ts` turns 4 of its 5 ISC-53 tests red, as before. **NOT PROVEN HERE, stated plainly:** the container job's probe-guard run at 77 was not executed locally — it needs the worker-image build — so that constant rests on the gate-closed derivation plus this file's contribution measured both ways (2 pass + 3 skip closed, 5 pass + 0 skip open), not on a local green container job. **`doctor` deliberately did NOT move into the network,** and the filing's assumption that `hostFacingBaseUrl` becomes dead weight for `doctor` too is the one part of it measurement refuted. `doctor-omlx.test.ts` — the ONLY CI-executable evidence for ISC-54/55, added by #17's S3 — reaches its stub on `127.0.0.1` with no daemon; a containerized `doctor` probe would make that file `PIFLEET_DOCKER`-gated and convert live coverage into a self-skip in the fast job, which is the exact failure this round has five findings about. So `doctor` still probes from the host, but no longer PRETENDS otherwise: it uses `llm.base_url` verbatim, reports `vantage: "host"` in `--json`, prints `omlx (from host):` in the text output, and appends to `omlx.detail` why a container-facing hostname is unreachable from here. That explanation is a NOTE, not a `Diagnosis` — it was a `Diagnosis` first, and the integration suite caught it: `doctor` exits 3 on any diagnosis, so a finding whose own text read "this is not a fault to fix" turned 8 green tests red on a healthy machine. Reporting both vantages from `doctor` is the better end state and is NOT filed as a new ISC id here, deliberately: three branches are in flight against this section and a fourth new number would collide. File it once the merge order settles.]
- [ ] ISC-256: `doctor` reports, for every model in `models_allowlist`, whether the configured oMLX endpoint actually serves it — and flags any that it does not. *(Added 2026-08-19 by the Group E close-out. **Numbering resolved 2026-08-19 at merge**: no collision occurred — ISC-255 (Group D, #16), ISC-256 and ISC-260 (#17), and ISC-257/258/259/261/262 (#18) all landed distinctly. Note cleared by #18, the last branch in the merge order, rather than by a branch re-grading someone else's criterion mid-flight.)* Motivated by a live finding, not by symmetry: `fleet.example.yaml`'s allowlist names `Qwen3-Coder-30B-A3B-Instruct-4bit`, `Qwen3.5-35B-A3B-8bit` and `GLM-4.5-Air-MLX-4bit`, and the endpoint `llm.base_url` points at by default — oMLX on the Docker host — serves NONE of the three. All three exist on a different machine on the LAN. Today nothing reports that: ISC-52 checks the resolved model against the allowlist (a config-vs-config comparison that passes happily), and the ISC-53 probe only touches models workers actually resolve to, so an allowlist entry that exists nowhere is invisible until someone points a role at it and `up` dies at exit 3. The check is nearly free — `GET /v1/models` is already fetched for ISC-54 and the comparison is a set difference. Worth folding in at the same time: oMLX will accept a model it cannot fit, logging `Loading <model> without KV headroom (need 24.93GB, available 24.00GB)` and then aborting the whole server on a Metal command-buffer error mid-generation (observed three times on 2026-08-19, SIGABRT in `mlx::core::gpu::check_error`). A `doctor` that compared each allowlisted model's size against the server's `--max-model-memory` would catch both the missing-model and the will-not-fit cases before `up` ever loads anything. *(Review round 3 note: this criterion's wording is ADJACENT TO, not a duplicate of, PR #18's ISC-259 — the two were written against different questions and neither subsumes the other. It is also written against the pre-decision world: the clause "the endpoint `llm.base_url` points at by default serves NONE of the three" assumes oMLX is Docker-host-local, and the owner has since decided to amend SRD §5.9/§12 to permit a trusted-LAN oMLX. Both this wording and its relationship to ISC-259 get reconciled when that §5.9/§12 erratum lands as its own PR; nothing is renumbered before then.)*

### Group F — Configuration

- [x] ISC-58: `config validate` exits 2 with a field-level error on a malformed config.
- [x] ISC-59: `config validate` rejects a role combining `bash` with `read_only: true`.
- [x] ISC-60: `render --worker eng-1` emits the expected normalized argv without spawning anything.
- [ ] ISC-61: Changing the length of `workers:` changes the container count, with no other edit. **[RE-GRADED `[x]` -> `[ ]` 2026-08-19 by the unreachable-module sweep. The criterion is FALSE in production, and it is false in the direction the wording least suggests: `workers:` does not change the container count at all.]** **What is unreachable.** `renderAllWorkers` (`src/config/render.ts:336`) is the ONLY function anywhere that maps a `workers:` list of length N onto N rendered containers — its own docstring names this criterion — and it has ZERO callers in `src/`. Its only consumers are `test/unit/render.test.ts` and `test/e2e/scale-16-workers.test.ts`. Both ISC-61 tests exercise library functions rather than the launch path: `test/unit/render.test.ts:1011` calls `renderAllWorkers` directly, and `test/unit/config.test.ts:501` calls `resolveAllWorkers`, whose sole production caller (`doctor.ts:747`) uses it to collect the distinct TOOLCHAIN set for image checks and never consumes its length. **What production actually does.** `up.ts` derives its launch set from argv alone — `.option("--workers <ids>", ..., "eng-1")` at `up.ts:112`, split and de-duplicated at `up.ts:182`. The single occurrence of `config.workers` in `up.ts` (line 88, `assertModelsAllowed`) is a MEMBERSHIP set for the model allowlist and is explicitly written to `continue` past any id the config does not define. Every other `config.workers` reader in `src/` is likewise membership or reporting: `load.ts:276/279` (lookup), `model-probe.ts:541`, `materialize.ts:533` (membership), `config.ts:29` (`config validate` prints the ids). `up.ts:105`'s own comment concedes it — "the worker list comes from `--workers` until then". **Measured rather than inferred**, real CLI, headless backend, fake-pi double, no config file present: `up --backend headless --json` with no `--workers` flag launched exactly one worker, `eng-1`, the commander default string; `up --backend headless --workers a1,b2,c3 --json` launched three workers named `a1`, `b2`, `c3` — three ids no config defines. The count follows argv unconditionally, so editing `workers:` "with no other edit" changes nothing. **`[ ]` and not `[~]`:** there is no weaker true statement about the launch path to preserve, because the launch path never reads the list. **Wiring that would close it:** have `up` default its worker set to `loaded.config.workers` when `--workers` is absent (make the commander default `undefined` rather than `"eng-1"`), and render through `renderAllWorkers` instead of per-id `renderWorker`; then re-take the evidence at the CLI — two configs differing only in `workers:` length, asserting the `up --json` worker array length tracks it — rather than at the module.
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
- [ ] ISC-74: Closing a worker's pane does not stop the worker in rpc mode; the task still settles. **STAYS OPEN — a test was written for this and then DELETED, because a mutation proved it could not fail. [AUDITED 2026-08-19 by the referenced-criteria grading audit.]** **The existing reference is not evidence.** `grep -rn ISC-74 test/` returns one hit, `test/unit/voided.test.ts:72`, which asserts the id is ABSENT from the attended-mode voided table. That is a statement about a documentation table, not about panes; it would pass unchanged if closing a pane killed every worker in the fleet. **The adjacent coverage is real but is a proxy.** `test/integration/supervisor.test.ts` proves the process-tree facts the guarantee is built on — `pgid == pid`, no controlling tty (ISC-77/78), survives a dead launcher and reparents to PID 1 (ISC-75/76) — but never closes a pane, and a process-tree shape is the mechanism, not the outcome the criterion states. **What was attempted:** a `test/integration/pane-close.test.ts` driving a real tmux server on a private `-L` socket, launching the supervisor from INSIDE the pane (the stricter v1.1 arrangement `launch.ts`'s header names, chosen deliberately because production's arrangement — pane runs only the log viewer, supervisor launched separately — makes the assertion vacuous), dispatching a `slow-turn.json` task, killing the session mid-turn, then asserting the supervisor's (pid, start-time) identity is unchanged, that `T-PANE-1` settles `success`, and that the control socket still answers. It passed in 6s. **It was deleted because the mutation did not fail it.** Removing `detached: true` from `processLauncher.launchDetached` left it GREEN. Probed directly to find out why: a `Bun.spawn` child of a pane command shares the pane's pgid and tty (`ps` shows both at pgid 98379, `S+`, `ttys003`), but `tmux kill-session` terminates only the pane's IMMEDIATE process — the child was orphaned, dropped to `S`, and SURVIVED. tmux does not signal the pane's whole process group here, so on this platform a supervisor cannot be stopped by pane closure whether or not it is detached, and the test asserted a property that holds unconditionally. Per this repo's standing rule — a guard nobody has seen fail is indistinguishable from one that cannot fail — shipping it would have added 6s of CI time and a false checkbox, so it was removed rather than kept as decoration. **What this measurement means for the criterion:** it is very probably TRUE, and `detached: true` is not what makes it true in the pane-close case; ISC-77/78 already own the properties detachment actually delivers. Closing it honestly needs either a falsifiable observable (a backend arrangement in which pane teardown CAN reach the worker — e.g. a container-per-pane backend, or `respawn-pane`/`kill-server` paths that signal differently) or an acceptance that the criterion is structural, in which case it should be re-worded as an anti-criterion in the ISC-137 shape — "no `FleetBackend` method launches or signals a supervisor" — which IS mechanically checkable against `src/`. The `rpc mode` qualifier is also unexercised: nothing in the attempt distinguished rpc from any other mode.
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
- [ ] ISC-108: A worker completing 3 turns with zero tool calls is classified `failed:no_tool_calls`. **[GRADED 2026-08-19 — STAYS OPEN. The runtime detector does not exist, so there is nothing a test could hold.]** SRD §5.9/F39 specifies TWO detectors for the prose-instead-of-tool-calls failure and only the first is built. The STARTUP probe is real and enforced — `src/security/model-probe.ts` classifies a model that answers with prose, `llm.require_native_tool_calls` gates it, and `up` exits 2. The RUNTIME detector this criterion names is absent in every part: `grep -rn 'no_tool_calls' src/` returns NOTHING; `prose_turns_before_fail` (SRD's default of 3, and the number in this criterion) appears nowhere outside `Docs/SRD.md` — not in `config/schema.ts`, so the threshold is not even configurable; and although the supervisor does count tool calls (`state.tool_calls++` on `tool_execution_end`, `src/supervisor/index.ts`), NO VERDICT PATH READS THAT COUNTER — `cli/commands/harvest.ts` prints it, `harvest/transcript.ts` reports it as a metric, and `reconstruct`'s verdict switch keys on `stopReason` alone. The existing coverage does not cover this; it says the opposite out loud. `test/unit/completion.test.ts`'s "no-tool-calls: three turns with zero tool calls still settle cleanly" asserts settlement as `success` — correctly, because the completion tracker must not HANG on prose — and both it and `test/fixtures/scenarios/no-tool-calls.json` defer the classification to "the harvester's job (acceptance #61, Phase 2)". NO MUTATION WAS RUN, and that is the finding rather than an omission: there is no code whose corruption could change any outcome, which is the sharpest available evidence that the criterion is unimplemented. WHAT IS MISSING, concretely: a per-epoch zero-tool-call counter in the supervisor, `run.prose_turns_before_fail` in the config schema, and a settle path producing verdict `failed` with reason `no_tool_calls` — at which point `no-tool-calls.json` is already the fixture that proves it, and its `EXPECTED_SETTLES` entry becomes the thing to revise.
- [ ] ISC-109: With 6 workers up and `max_concurrent: 2`, at most 2 have an in-flight generation at any sampled moment. **[GRADED 2026-08-19 — STAYS OPEN, and it is not merely untested: it was MEASURED FALSE.]** The cap exists as a LIBRARY and has no caller. `BudgetManager.admit` in `src/safety/budget.ts` refuses a task with `reason: "max_concurrent"` once `inFlight().length >= opts.maxConcurrent`, and `test/unit/budget.test.ts`'s "a third in-flight task is refused at max_concurrent 2" pins that. But `grep -rn 'BudgetManager\|emptyBudget\|budgetExitCode' src/` finds the class ONLY in the file that defines it — nothing in `src/cli/**`, `src/orchestrate/**` or `src/run/**` ever constructs one — and `grep -rn 'max_concurrent' src/` shows the config key is parsed by `config/schema.ts` (default 2) and read by NOBODY. So the unit test proves a strictly weaker statement about a component the fleet does not use, which is why this is `[ ]` and not `[~]`: there is no path from the criterion's premise (`max_concurrent: 2` in `fleet.yaml`) to the mechanism. MEASURED, not inferred — a throwaway probe drove the production `runSchedule` (`src/orchestrate/scheduler.ts`) with 6 workers, 6 independent ready tasks and tasks held un-settled for several polls, and recorded **peak simultaneous in-flight = 6**, exit 0. That is the scheduler behaving exactly as written: its dispatch pass walks `graph.ready()` and hands each task the first free idle worker with no admission check anywhere in the loop. NO MUTATION WAS RUN against the enforcement path because there is no enforcement path to mutate; mutating `budget.ts` would only re-prove `budget.test.ts`, which already covers it and which nothing in production calls. WHAT IS MISSING: `runSchedule` (or the `SchedulerIO.dispatch` binding in `cli/commands/dispatch.ts`) must consult a `BudgetManager` built from `run.max_concurrent` before dispatching, and a task refused `max_concurrent` must stay `ready` rather than settling — after which this criterion needs a test that SAMPLES a 6-worker fleet, since the criterion is about the observed maximum over time and not about a single refusal.
- [ ] ISC-110: A worker queued behind others is not killed as wedged before `event_stall_warn` elapses. **[RE-GRADED `[x]` -> `[ ]` 2026-08-19 by the unreachable-module sweep. BOTH halves of this criterion — the queue and the stall policy — are unreachable from production, so the sentence has no subject and no verb.]** **The stall policy is callerless.** `classifyStall` (`src/safety/kill.ts:241`) is the function that distinguishes a queued worker from a wedged one, and `grep -rn classifyStall src/` returns only its own definition. Nothing in `src/` computes a `StallVerdict`, so no worker is killed as wedged — nor spared as queued — by any code path. `event_stall_warn` and `event_stall_kill` (`config/schema.ts:166-167`) are parsed by the schema and read by NO production line; the only other `stall` timer in `src/` is `scheduler.ts`'s `DEFAULT_STALL_TIMEOUT_MS`, a fleet-wide no-progress abort that throws `SchedulerError` at `EXIT.TIMEOUT` and neither reads those keys nor kills a worker. **The queue does not exist either.** `classifyStall`'s discriminator is `holdsSlot`, documented in place as `BudgetManager.holdsSlot`, and `BudgetManager` (`src/safety/budget.ts:102`) has no caller in `src/cli`, `src/orchestrate` or `src/run` — `max_concurrent` (`config/schema.ts:190`) is enforced only at `safety/budget.ts:168`, inside that callerless module. A probe drove the real `runSchedule` with 6 workers against `max_concurrent: 2` and measured peak in-flight = 6, so no worker is ever "queued behind others" in the first place (see ISC-109, correctly `[ ]`). **Evidence, and what it proves.** `test/unit/kill.test.ts` -> `classifyStall (ISC-110 / ISC-117): queued and wedged are different` passes, and its assertions are correct — about the function. It calls `classifyStall` directly with hand-built `StallInput` values; it proves the module, not the criterion. Recorded separately because it cost time to establish: that file throws `ReferenceError: Cannot access 'realProcessOps' before initialization` when it is the FIRST importer of `kill.ts` (an order-dependent init cycle `kill.ts` -> `run/registry.ts` -> `safety/reaper.ts` -> `kill.ts`), so it fails when run alone or in small groups. It DOES execute under `bun test test/unit` (measured: 1093 pass / 0 fail across 51 files), where an earlier file warms the cycle from the `registry.ts` side. So this is a local-isolation fragility, NOT a non-executing test, and it is not the grounds for this re-grade. **`[ ]` and not `[~]`:** production cannot reach the code under test from any entry point, and the criterion is only vacuously true — nothing kills for stall, so nothing spares a queued worker either. **Wiring that would close it:** construct a `BudgetManager` on the dispatch path (ISC-235) so `holdsSlot` has a live answer, have the supervisor sample `sinceLastEventMs` from its `Stopwatch` and feed `classifyStall` with `timers.event_stall_warn`/`event_stall_kill`, and drive the resulting `warn`/`kill` verdicts into the existing kill ladder. Closing that one call site closes ISC-110 and puts ISC-109 and ISC-117 within reach of a scenario test.
- [ ] ISC-111: A dialog `extension_ui_request` is answered `{cancelled:true}` within 5s. **[GRADED 2026-08-19 — STAYS OPEN. Nothing anywhere answers a UI request; the "within 5s" clause has no timer behind it.]** SRD §12.3 guard 2 is unbuilt. `grep -rni 'extension_ui\|ui_request' src/` returns exactly three hits and not one of them is a handler: `contracts.ts:207` declares the `WorkerState.ui_requests` counter `{answered, denied}`, `config/schema.ts:165` parses `ui_request_timeout` (prefault `5s` — the very 5 seconds this criterion names) and NO CODE READS IT, and `security/refresh.ts` matches only on the English word "cancelled" in a comment. Mechanically, an `extension_ui_request` is not a response (`isRpcResponse` keys on `type === "response"`), so it arrives through `RpcClient.onEvent` and lands in the supervisor's `onEvent`, which logs it, offers it to `CompletionTracker.observe` — where it matches no case and is not in `ACTIVITY_EVENTS` — and returns. No reply is ever written to the child's stdin. This is CONFIRMED FROM THE FAR END OF THE WIRE, not only by reading: the new `test/integration/ui-requests.test.ts` captures every line the supervisor writes to its Pi process (via fake-pi's new `PIFLEET_FAKE_REQUEST_LOG`) and the captured set contains only `prompt` and `get_state` — so `answered` and `denied` are both structurally 0 for every run, and `ui_requests` in `state.json` is a field that can never move off its default. NO MUTATION WAS RUN: there is no responder whose corruption could change an outcome. WHAT IS MISSING: a supervisor-side classifier over SRD §4.2's nine methods, a per-request timer seeded from `timers.ui_request_timeout`, a `{cancelled:true}` reply on the four dialog methods, and `WorkerState.ui_requests.denied` incremented when it fires. TESTING IT ALSO NEEDS FIXTURE WORK that does not exist yet: `test/fixtures/fake-pi.ts` can EMIT a UI request (the new `ui-fire-and-forget.json` does) but cannot BLOCK on one, and a dialog that does not block is not a dialog — the double needs a step form that withholds the turn's `agent_end` until a matching answer arrives, which is also the only way to measure the 5s bound honestly.
- [ ] ISC-112: An `editor` extension UI request does not hang the run. **[GRADED 2026-08-19 — STAYS OPEN, and of the three UI criteria this is the one most likely to be FALSE in production rather than merely unproven.]** Same missing handler as ISC-111, but the consequence is worse and SRD §4.2 says why: `select`/`confirm`/`input` carry an optional `timeout` and SELF-RESOLVE, so an unanswered one eventually unblocks itself; **`editor` has no timeout and hangs forever unanswered** — "the supervisor's timer is the only unblocker". There is no such timer (`ui_request_timeout` is parsed in `config/schema.ts:165` and read nowhere). So a real Pi extension issuing an `editor` request against today's supervisor blocks its turn until `deadline_s` expires, at which point the heartbeat's `deadline_exceeded` path sends an advisory `abort`, waits `ABORT_GRACE_MS`, and settles `timed_out` with reason `deadline_exceeded_no_terminal_event` before killing the child. That is the kill ladder working correctly and it is NOT this criterion: burning a whole task deadline before a SIGKILL is what "hangs the run" means, not the counter-example to it. Mitigated in practice — never closed — by §12.2's mandatory `--no-extensions`, which is what stops an `editor` request being issued at all; that makes the exposure conditional on a guard that lives elsewhere, and a criterion whose only defence is another criterion is not proved. NO MUTATION WAS RUN: there is nothing to mutate, and a test written today would have to assert the timeout behaviour rather than the criterion. WHAT IS MISSING: the ISC-111 responder (an `editor` answer is the same `{cancelled:true}` reply), plus fake-pi support for a UI request that WITHHOLDS `agent_end` until answered — without that the double cannot model a hang, and a scenario that emits an `editor` request and then finishes anyway would produce a green test proving only that the double does not block. Until the blocking-step form exists, any pass here is a false one.
- [~] ISC-113: Fire-and-forget UI methods receive no response and are logged. **[GRADED 2026-08-19 — PARTIAL. The sentence is now re-checked literally and in CI; it is `[~]` and not `[x]` because half of it passes VACUOUSLY.]** MACHINE-CHECKED, every CI run (`test/integration/ui-requests.test.ts`, collected by the workflow's `bun test test/integration` step, real detached supervisor, real fake-pi child, no Docker and no network): the new `test/fixtures/scenarios/ui-fire-and-forget.json` emits all FIVE fire-and-forget methods from SRD §4.2's vocabulary table — `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` — mid-turn, each carrying an id an answer could be addressed to, and the test asserts both clauses. **"Are logged":** all five reach `events.jsonl` verbatim, in emission order, with `id`, `method` AND `params` intact — asserted as an ordered deep-equal against a list of the methods written out in the test rather than derived from the scenario, so a scenario that silently lost a method shrinks nothing. **"Receive no response":** observed from the FAR END OF THE WIRE. Nothing in the run directory can carry this — `events.jsonl` records what the supervisor RECEIVED, and a message never sent leaves no trace on disk — so `test/fixtures/fake-pi.ts` gained an opt-in `PIFLEET_FAKE_REQUEST_LOG` that appends every raw line the supervisor writes to the double's stdin. The assertion is an ALLOWLIST (every logged request's `type` must be one of the supervisor's own six commands) rather than only "no request carries a UI id", because a responder could address the request by id, echo it in `params`, or reply with a bare `{"type":"response"}`, and only the allowlist covers all three; a second assertion additionally rejects any sent line containing `uireq-` under any key. The log is also asserted NON-EMPTY and to contain the `prompt`, so "nothing was sent about these" cannot be satisfied by a plumbing failure that recorded nothing at all. Env-gated and therefore inert for every existing scenario. **MUTATION-PROVED, twice, both against `src/supervisor/index.ts` and both restored (sha256 `61c06af4…` before and after):** (1) guarding the event log with `if (event.type !== "extension_ui_request")` turns the logging clause red — *"Expected: [{id: uireq-notify, method: notify}, …5 entries]  Received: []"*; (2) adding `void client.send("extension_ui_response", {request_id: event.id, cancelled: true})` on every UI event turns the silence clause red — *"the supervisor wrote something that is not one of its own commands: [{type: extension_ui_response, request_id: uireq-notify, cancelled: true}, …]"*, `- Expected - 1 / + Received + 32`. So the guard is one that CAN fail, in both directions, and it is precisely the mistake the two-class split exists to prevent: when §12.3 guard 2 is built, an implementation that answers all nine methods goes red here. **WHY `[~]` AND NOT `[x]`, stated plainly.** The supervisor does not DISTINGUISH the two classes — it answers nothing at all (see ISC-111/112). The "no response" clause therefore holds today because no responder exists, not because one classified these five correctly, and a reader seeing `[x]` beside an open ISC-111 would reasonably infer a fire-and-forget/dialog split that is not implemented. The "are logged" half is NOT vacuous and is fully earned; the silence half is a characterisation of an absence. Re-grade to `[x]` when guard 2 lands and this same test still passes alongside a dialog test that proves the other branch.
- [ ] ISC-114: Exceeding `tokens_ceiling` halts dispatch and exits 5, with artifacts still harvested. **STAYS OPEN — `src/safety/budget.ts` is an unreachable island: no production file imports it, so no run halts, exits 5, or harvests on a ceiling. [AUDITED 2026-08-19 by the referenced-criteria grading audit, and deliberately NOT closed.]** **What exists and genuinely works:** `test/unit/budget.test.ts`'s "ISC-114: crossing the ceiling halts dispatch" block drives the real `BudgetManager` and asserts that after the trip every admission — even a zero-reserve one — is refused `budget_halted`, that `settle` does NOT throw on the trip (so a halt can never destroy the harvest path), that landing exactly on the ceiling is not exceeding it, and that the first halt reason is kept. The reservation block covers the overshoot-between-polls case. MUTATION-PROVED: `and`-ing the halt condition with `false` in `BudgetManager`'s ceiling check turns four tests red across three describes, including "after the trip, every admission is refused budget_halted" (`Expected: true / Received: false`) and ISC-193's `budgetExitCode` producer (`Expected: 5 / Received: 0`). So the MODULE is a real guard. **Why that is not this criterion.** All three conjuncts are about a RUN, and the module has no production reachability at all: `grep -rn "budget.ts" src/` returns NOTHING — `test/unit/budget.test.ts` is the only importer in the repository. Concretely, (1) *halts dispatch*: neither `dispatch.ts` nor `orchestrate/scheduler.ts` ever constructs a `BudgetManager` or calls `admit`; the scheduler's own comment at `scheduler.ts:136` says `dispatch --auto` polls "no budget, no…" in as many words. (2) *exits 5*: `budgetExitCode` has NO CALLER, `BudgetCeilingError` is THROWN NOWHERE, and `wait.ts`'s `exitFor` cannot yield `EXIT.BUDGET` from any verdict — so no invocation of this CLI can exit 5 for any reason. (3) *artifacts still harvested*: there is no halt for a harvest to survive, and no test drives harvest across one. `tokens_ceiling` itself is read by nothing outside the schema and the orphan module (`grep -rn tokens_ceiling src/cli/ src/orchestrate/ src/supervisor/ src/harvest/` → empty); every fixture that sets it sets 1000000 as inert boilerplate. **Note for the next reader: ISC-115 is currently `[x]` on this same unreachable module** — its evidence is `budget.test.ts`'s sibling describe, which proves the token axis trips while `usd_spent` stays 0. That is a true statement about `BudgetManager` and, like this one, not a statement about a run; it was out of scope for this audit and is left as found rather than silently re-graded. **Same shape as ISC-117 in this audit and as the `FleetBackend.destroy` finding in `down-teardown.test.ts`'s header — the "fully-tested-but-unreachable subsystem" class this project keeps rediscovering.** Closing it needs the manager wired into the dispatch path, `budgetExitCode` folded into `wait`'s `worstExit`, and an integration test that trips a real ceiling mid-run and asserts exit 5 with artifacts present.
- [ ] ISC-115: Exceeding `tokens_ceiling` halts a run whose reported cost is 0 throughout. **[RE-GRADED `[x]` -> `[ ]` 2026-08-19 by the unreachable-module sweep. Nothing halts, because nothing accounts.]** **What is unreachable.** The whole of `src/safety/budget.ts` — `grep -rn "budget.ts" src/` returns nothing, and the module has zero importers anywhere outside `test/unit/budget.test.ts`. `BudgetManager`, `emptyBudget`, `budgetExitCode` and `BudgetCeilingError` therefore have no production caller, and `tokens_ceiling` (`config/schema.ts`, under `BudgetSchema`) is read by nothing outside the schema that parses it. There is no writer and no path for a persisted budget: `run/paths.ts` has no `budgetJson` member. No run can halt on a ceiling for any reason, so the criterion's premise ("exceeding `tokens_ceiling`") is unreachable before its consequent is even considered. **Evidence, and what it proves.** `test/unit/budget.test.ts` -> `ISC-115: the ceiling trips on tokens while usd stays 0 throughout` passes (14 pass / 0 fail, measured). Its assertions are correct and its reasoning about the token/usd inversion is sound — about `BudgetManager`. It constructs the manager directly and calls `admit`/`settle` on it; production never does. A unit test over a callerless module proves the module, not the criterion. **Related unreachability found in the same sweep, recorded so it is not rediscovered:** `usageFromSessionStats` (`src/harvest/usage.ts:60`) also has zero callers in `src/`, so the A6 element-wise merge that `harvest.ts:60` performs (`combineUsage(state.usage, transcriptUsage)`) draws its second source from the supervisor's persisted `state.usage` rather than from a parsed `get_session_stats` payload. That does not by itself falsify any other `[x]`, but it is the same shape and it is the numerator this ceiling would read. **`[ ]` and not `[~]`:** production cannot reach the ceiling at all; there is no weaker true statement about a halt that never happens. **Wiring that would close it:** call `BudgetManager.admit` on the dispatch path and persist its snapshot, then fold `budgetExitCode` into `worstExit` after harvest — exactly what ISC-235 already specifies. That single call site closes ISC-114, ISC-115 and ISC-193 together, and unblocks ISC-109/ISC-110.
- [x] ISC-116: A task exceeding `deadline_s` is aborted and reported `timed_out` with exit 4. **[CLOSED 2026-08-19 by the referenced-criteria grading audit — two of the three conjuncts were already covered and ungraded; the third was written for this.]** **The reference that named this criterion was the weakest evidence for it.** `grep -rn ISC-116 test/` returns only `test/unit/kill.test.ts:267`, whose whole content is that `TaskDeadlineError` satisfies `ExitCoded` and carries `EXIT.TIMEOUT === 4`. That class is thrown NOWHERE in `src/` (`grep -rn TaskDeadlineError src/` → its own definition only), so the one test naming this criterion pins an unreachable structural type and proves nothing about a task, a deadline, or an exit. Graded on that alone this would be `[ ]`. **The real mechanism, and where it actually lives:** `src/supervisor/index.ts`'s heartbeat compares `deadline.elapsedMs()` against `envelope.deadline_s * 1000`, then `noteTimedOut()` + `noteAbortRequested()`, logs `deadline_exceeded`, sends `abort`, and arms a 5s `ABORT_GRACE_MS` escalation that settles `timed_out` and kills the child if no terminal event arrives. `wait.ts`'s `exitFor` maps verdict `timed_out` → `EXIT.TIMEOUT`. **Conjuncts 2 and 3 (`reported timed_out`, `exit 4`) were already covered and never graded:** `test/integration/dispatch-auto.test.ts`'s "A times out -> B blocked by A -> C blocked by A" drives a real `dispatch --auto` over a real detached supervisor against `deaf-abort.json` with `deadline_s: 1`, and asserts `verdict: "timed_out"` and `auto.code === EXIT.TIMEOUT`. MUTATION-PROVED here: neutering the deadline branch to `if (false && …)` in `src/supervisor/index.ts` makes it RED twice over — the test hits its own 120s wall (`this test timed out after 120000ms`) because A never settles, and the exit assertion reads `Expected: 4 / Received: 143` (SIGTERM, not the ladder). Restored, it is green in 6.5s. **Conjunct 1 (`is aborted`) was NOT covered, and that gap is why the deaf-abort test cannot close this alone:** its agent ignores abort by construction, so deleting `client.send("abort")` from the deadline branch leaves that test green — the escalation settles the task either way. Closed by a new test, `test/integration/supervisor.test.ts`'s "ISC-116: a deadline aborts the agent, then reports timed_out", which uses `aborted.json` (an agent that HONOURS abort) so the abort's arrival is observable as an ABSENCE: when the request lands the turn ends inside the grace window and `deadline_escalated` is never logged. It asserts `deadline_exceeded` present for that task id, verdict `timed_out` (not `aborted` — `em.timedOut` outranks `em.abortRequested` on the quiesce path, and that precedence is now pinned one layer below `wait`), `deadline_escalated` ABSENT, and the settle reason not `deadline_exceeded_no_terminal_event`. MUTATION-PROVED: deleting `void client.send("abort").catch(() => {})` from the deadline branch fails it with `Expected: false / Received: true` on the `deadline_escalated` assertion. Green in 1.45s. **Both tests are in `test/integration`, which CI runs on every PR**, which is what earns `[x]` rather than `[~]`. **What this does NOT prove:** `TaskDeadlineError` still has no producer — the direct-exit path it exists for is unreachable, and it is a latent duplicate of the settle path rather than evidence for it; and `test/unit/kill.test.ts` CANNOT BE RUN ALONE (`bun test test/unit/kill.test.ts` → `ReferenceError: Cannot access 'realProcessOps' before initialization` from a `kill.ts` → `run/registry.ts` → `safety/reaper.ts` → `kill.ts` import cycle), so its assertions execute only because the whole-directory load order happens to resolve the cycle. Filed as an observation here rather than fixed, since it is not this criterion's mechanism.
- [ ] ISC-117: A wedged agent (no events, live heartbeat) is killed at `event_stall_kill`. **STAYS OPEN — the policy is written and unit-tested; nothing calls it, so no agent is ever killed. [AUDITED 2026-08-19 by the referenced-criteria grading audit, and deliberately NOT closed.]** **What exists and genuinely works:** `classifyStall` in `src/safety/kill.ts` returns `kill` only for a slot holder silent past `killMs`, `warn` otherwise, and `test/unit/kill.test.ts`'s "classifyStall (ISC-110 / ISC-117)" block covers the kill case, the queued-worker exemption and both edges of the warn band. MUTATION-PROVED: deleting the `if (input.holdsSlot && input.sinceLastEventMs >= input.killMs) return "kill";` line fails "a slot holder silent past event_stall_kill is killed" with `Expected: "kill" / Received: "warn"`. So the FUNCTION is a real guard. **Why that is not this criterion.** The sentence says a wedged agent *is killed*, and nothing kills one. `grep -rn classifyStall src/` returns its own definition and nothing else — it has NO CALLER anywhere in production. The only production importer of `kill.ts` is `src/safety/reaper.ts`, which takes `runKillLadder`, `realProcessOps`, `KillOutcome` and `ProcessOps`, and never `classifyStall`. The configuration is equally inert: `event_stall_warn`/`event_stall_kill` are parsed by `src/config/schema.ts` and read by nobody (`grep -rn timers src/` finds exactly one consumer, `up.ts`'s `heartbeat_interval`), so the window the criterion names cannot influence anything at runtime. **The distinction that decides the grade:** the reaper (ISC-118, `[x]`) kills a wedged SUPERVISOR on a stale heartbeat. This criterion is about the opposite and harder case — a supervisor whose heartbeat is LIVE, wrapped around an agent that has stopped emitting while holding the oMLX slot. Nothing observes event silence in production at all, so that agent holds its slot indefinitely and the reaper never sees a reason to act. Grading this `[x]` on `classifyStall`'s unit tests would close a criterion about a kill on evidence that only a pure function returns the string `"kill"`. **Same shape as ISC-114 in this audit and as the `FleetBackend.destroy` finding in `down-teardown.test.ts`'s header — a fully-tested, unreachable subsystem.** Closing it needs a caller: something that tracks per-worker time-since-last-event, asks `classifyStall`, and drives `runKillLadder` on a `kill` verdict — plus an integration test that wedges a real agent (a scenario that emits `agent_start` then goes silent while holding a slot) against a compressed `event_stall_kill` and asserts the child dies and the task settles.
- [x] ISC-118: A wedged supervisor is reaped by the daemon.
- [~] ISC-119: A repo carrying `.pi/extensions/hostile.ts` and a hostile `AGENTS.md` changes nothing about the run. **PARTIAL — the workspace exposure is now machine-checked in CI; "the run" itself still has no Pi in it.** What was here before named no test at all: `grep -rn 'ISC-119' test/ src/` returned NOTHING. `test/integration/hostile-repo.test.ts` is excellent and does not close this — it proves the SCANNER against a seeded tree and says so in its own header ("no Pi process runs here"), calling `neutralizeRepoHazards` directly and creating no run, no clone and no worker. The gap that hid behind it was concrete: a worker mounts `<repo>/.worktrees/<id>` at `/workspace`, which is a CLONE carrying the TRACKED hazards and none of the untracked ones — a different hazard profile from the tree that suite exercises — and the ONLY clone-side assertion anywhere was that `AGENTS.md.pifleet-quarantined` exists. `.pi/extensions/`, the in-process-EXECUTION class and the one this criterion names FIRST, was never checked in the clone at all. NEW, and CI-executable on every push (`test/integration/up-wiring.test.ts`, no Docker daemon, no skip gate — the file's docker is a PATH shim): "a committed .pi/extensions and AGENTS.md never reach the worker's workspace" drives the REAL `up` CLI against a repo carrying `.pi/extensions/hostile.ts` (the criterion's own filename) plus the fixture's root `AGENTS.md`, then asserts on the recorded worktree — both discovery paths absent from `/workspace`, the extension's bytes still readable under `extensions.pifleet-quarantined/hostile.ts` (nothing deleted), `inspectCloneDirt` reading `{dirty: false, statusLines: 0}` so an armed repo cannot make every worker read as holding work before it has done any, and the operator's own checkout keeping both files unrenamed (SRD §12.8). A `README.md` control pins that the assertions are looking at the clone the payloads were committed into. MUTATION-PROVED TWICE, and the second one is the point: (1) downgrading `neutralizeRepoHazards(created.path)` to `detectRepoHazards` in `up.ts` fails it — "Expected promise that rejects / Received promise that resolved" at the `lstat` loop, 4 expect() calls in; (2) deleting just the `pi_extension` row from `PI_DIRS` in `security/repo-hazards.ts` fails it at 5 expect() calls — `AGENTS.md` passes and `.pi/extensions` is the assertion that catches it, which is exactly the isolation the old coverage lacked. STILL MISSING, and why this is `[~]` not `[x]`: no Pi and no container run anywhere in this evidence. The worker is `fake-pi`, so nobody has watched Pi decline to load an extension; "changes nothing about the run" is established as "the hostile files are not in the workspace, and the argv denies discovery" (`buildPiArgv` emitting `--no-extensions --no-skills --no-context-files`, pinned in `hostile-repo.test.ts`) — structural, not observed. Closing it needs a container running real Pi against an armed clone.
- [x] ISC-120: An envelope naming `/Users/dan/.env` is refused before dereference.
- [x] ISC-121: A symlink in `<outbox>/files` pointing outside the outbox is refused.
- [x] ISC-122: An oversized envelope field is rejected without OOM.
- [x] ISC-123: No ref outside `fleet/<run-id>/*` moves during a run. Machine-checked on every push, no Docker daemon and no skip gate: `test/integration/up-wiring.test.ts`, "the operator's refs and porcelain are byte-identical across a run, and only the worker's own branch moves". It had NO test before — `grep -rn 'ISC-123' test/ src/` returned nothing — and the property was held in place by design alone (worker checkouts are CLONES, not linked worktrees, so the branch is created in the clone and the parent only ever gets a `remote add`). Proved at BOTH altitudes against a real `up`. Operator side, and stronger than the criterion asks: `git show-ref` is byte-identical across the run and `symbolic-ref HEAD` is unchanged — not one ref moves, appears or vanishes, checked against a repo deliberately carrying more than one ref (a second branch and a tag) so "no ref moved" is a statement about a SET. Worker side, the criterion's literal sentence: every ref in the clone is snapshotted, the worker then commits on its own branch, and every ref NOT under `refs/heads/fleet/<run-id>/` is required to hold its sha — with `expect(cloneAfter.get(workerRef)).not.toBe(cloneBefore.get(workerRef))` as the control, so the loop cannot pass by nothing having happened. The loop runs over 2 real refs (`refs/heads/main`, `refs/tags/v1`), measured, not assumed. Ref names come from `workerBranch(DEFAULT_BRANCH_PREFIX, ...)`, never a hardcoded `fleet/`, so an operator's `branch_prefix` cannot silently make this vacuous. MUTATION: adding `await runGit(repo, ["fetch", remoteName])` after the `remote add` in `registerWorkerRemote` — the realistic regression, since `up` registers that remote precisely so an operator CAN fetch. RED: `expect(received).toBe(expected)` with `+ refs/remotes/worker-eng-1/HEAD`, `+ refs/remotes/worker-eng-1/fleet/<run-id>/eng-1`, `+ refs/remotes/worker-eng-1/main`.
- [x] ISC-124: The main checkout's `git status --porcelain` is unchanged after a run. Same new test as ISC-123, same CI job, same absence of a skip gate. What existed before was ADJACENT and weaker: `worktree.test.ts`'s gitlink test asserts `git status --porcelain` is `""` after `git add -A`, but it runs `createWorkerWorktrees` in isolation rather than a run, and — the part that matters — an assertion that porcelain is EMPTY passes just as happily for a run that DISCARDED the operator's uncommitted work. The criterion says "unchanged", not "clean". So the fixture here is deliberately not pristine: a modified tracked file, a staged addition and an untracked file are all present before `up` starts, `expect(statusBefore).not.toBe("")` pins that the fixture is genuinely dirty, and the comparison is byte-for-byte against those exact lines — checked once after `up` and again after the worker commits, since a snapshot taken at `up` cannot show the second half. The production code carrying it is `excludeWorktreesDir`, which appends `/.worktrees/` to `.git/info/exclude` (never `.gitignore`, which is tracked content and would land in the operator's next commit — SRD §12.8). MUTATION: replacing the `await excludeWorktreesDir(repo)` call in `createWorkerWorktrees` with a no-op. RED exactly where predicted, with the one-line diff `+ ?? .worktrees/` against a porcelain that otherwise matched.
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
- [x] ISC-138: Anti: no code path uses `readline` or `split(/\r?\n/)` on an RPC or session stream. **[CLOSED 2026-08-19 — a GRADING correction, not new work.]** The coverage already existed and had existed for some time: `test/unit/rpc-client.test.ts` carries a block headed "Static anti-criteria (ISC-137, ISC-138)" which scans every file under `src/**/*.ts` for four readline usage forms (`from "node:readline"`, `require(...)`, dynamic `import(...)`, and any `createInterface(`) and for the literal split patterns `split(/\r?\n` and `split(/\n`. ISC-137, its sibling in the same block, has been `[x]` throughout; ISC-138 was left `[ ]`. **The guard is stricter than the criterion**, which is why this is safe to close: ISC-138 asks only about "an RPC or session stream", while the test bans these forms across the whole of `src/`. **Mutation-verified before grading rather than taken on trust**, since a guard nobody has seen fail is indistinguishable from one that cannot: planting `"x".split(/\r?\n/)` in `src/rpc/epoch.ts` turns it red, planting `import { createInterface } from "node:readline"` turns it red, and removing both returns it green.
- [x] ISC-139: Anti: no generated commit, branch, or PR body contains AI attribution. **[CLOSED 2026-08-19 by this PR.]** Two probes in `test/unit/anti-criteria.test.ts`, and the second is the one that matters. **First, attribution CONSTRUCTIONS under `src/`** — a `Co-Authored-By` trailer, a "generated with/by <tool>" credit, an `AI-`/`LLM-generated|assisted|authored` label. The first draft of this guard banned the bare TOKENS `claude`, `anthropic` and `copilot`, and went red immediately on six legitimate sites: `CLAUDE.md` is a FILENAME this tool must know, because `src/security/repo-hazards.ts` scans repository instruction files and `src/run/worktree.ts` reasons about a clone that carries one. A guard that fires on the subject matter rather than the defect is worse than no guard, so it matches phrasing that has no legitimate use here. **Second, a CAPABILITY PIN, because two thirds of this criterion is vacuous.** Enumerating the git subcommands that appear as argv literals under `src/` gives add, branch, checkout, config, diff, log, rev-parse, status, symbolic-ref, worktree — **no `commit`, no `push`, no `gh`**. pifleet creates branches and worktrees and nothing else, so "no generated COMMIT or PR BODY carries attribution" is true because there are none. A vacuously-true clause is exactly the kind that rots: someone adds `git commit` for a good reason and the clause silently goes live with nothing watching. The test therefore asserts the absence of the CAPABILITY and fails loudly the day it changes, naming what the next author must extend. **The one artifact that IS generated is pinned by behaviour**: `workerBranch` must return its three inputs joined and nothing more, so a later edit appending a suffix or a credit fails here rather than being noticed in `git branch` output months later. Mutation-verified three ways: a planted trailer, a planted `["git", "commit"]` literal, and a decorated branch template each turn it red.
- [x] ISC-140: Anti: no acceptance test in the `headless` suite requires provider spend or a cloud endpoint. **[CLOSED 2026-08-19 by this PR.]** `test/e2e/` IS the headless acceptance suite — `lifecycle.test.ts` opens by naming its own contract, "no Docker, no network, no GUI (ISC-19, ISC-128)". The guard requires that no file there names a provider credential (`*_API_KEY|SECRET|TOKEN`) or an `http(s)` endpoint, with loopback excluded since a fixture may legitimately name it. **Split from ISC-21 deliberately, because the two fail in opposite directions**: a test that needs egress fails CLOSED on an air-gapped runner and everybody finds out, while a test that needs provider spend PASSES and quietly bills someone — the second is the one no green tick will ever reveal, which is why it earns its own probe rather than riding on ISC-21's. Measured at closure: the suite touches only `PIFLEET_RUNS_DIR` and `PIFLEET_PI_*` and contains no URL at all. The guard also fails if it finds zero e2e files, so it cannot pass by pointing at nothing. Mutation-verified: a planted `process.env.OPENAI_API_KEY` and a planted `https://api.example.com` each turn it red.

### Group M — Review findings (added 2026-07-27, post-advisor)

Criteria that came out of the commitment-boundary review. Several correct the SRD
rather than merely implementing it; SRD errata are recorded in `## Changelog`.

- [~] ISC-141: Epoch attribution uses the RPC stream offset, and the SRD §7.5 interleaving is decided correctly when offset is the only distinguishing signal. **PARTIAL — both machines are mutation-proved; the supervisor line that joins them is not, and the e2e test named for this interleaving does not test it.** MACHINE-CHECKED every CI run (`bun test test/unit`). `epoch.test.ts`'s "EpochManager — stream-offset fencing (the §7.5 interleaving)" decides the interleaving on offset alone: epoch 1's straggler at seq 19 — read AFTER epoch 2 was allocated and byte-identical to what epoch 2's own terminal event will look like — is `prior` against `ack_seq` 20, while the same shape at seq 21 is `live`. Mutation-proved: collapsing `attribute` to `if (live !== null) return "live"`, which is exactly the SRD window rule this erratum exists to correct, fails it with `Expected: "prior" / Received: "live"`. That covered the DECISION and left the INPUT unpinned, so this audit added `rpc-client.test.ts`'s "RpcClient x EpochManager — the ack's offset is the fence post (ISC-141)": the real client driving a real `EpochManager`, with the straggler, the ack and epoch 2's output PACKED INTO ONE WRITE, so the ack has to land on the fence synchronously at its true position (record 2) before the next line in the same chunk is dispatched. It is mutation-proved twice over — `pending.onAck?.(seq)` -> `pending.onAck?.(0)` fails it with `Expected [2] / Received [0]`, and the `attribute` collapse fails it with `"prior"` -> `"live"`. **NOT PROVED, and this is precisely why the grade is not `[x]`: the fleet can stop using the offset entirely and CI stays green.** Rewriting `src/supervisor/index.ts`'s `em.attribute(seq)` to `em.attribute(Number.MAX_SAFE_INTEGER)` — every event live regardless of stream position — passed `test/unit`, `test/integration/{supervisor,dispatch-auto}.test.ts` and the e2e §7.5 case. Before the new test existed the `onAck?.(0)` mutation passed all of those too. **The e2e case that appears to cover this is load-bearing for something else:** `lifecycle.test.ts`'s "the §7.5 interleave" (filed under ISC-84) survives both mutations, because T-005's window never opens — `windowOpen`, not the fence, is what stops the straggler settling epoch 2 there — and its `"prior"` assertion is satisfied by post-settle stragglers arriving while `live` is null, a path that returns `prior` under every mutation tried. Closing this needs a test that drives the real supervisor and asserts the `epoch_attribution` records carry the stream's true seqs. **Grading this `[~]` also exposed a latent defect and fixed it:** `definedIscIds` in `src/attended/voided.ts` matched `- [` `[ x]` `]` only, so a criterion graded partial stopped counting as DEFINED — and because ISC-141 is itself a row in the `tui` voided table, the cross-check immediately reported that operator-facing table as pointing at a nonexistent criterion. A false positive of exactly the rot the check exists to catch. The character class is now `[ x~]`; strictness is unchanged and mutation-proved — dropping the anchor and the checkbox so bare prose mentions match fails "a prose mention of an ISC id is not a definition".
- [ ] ISC-142: A dispatch whose epoch is `<=` the worker's persisted `last_accepted_epoch` is rejected at the worker side, not merely bookkept by the allocator.
- [x] ISC-143: The epoch high-water-mark is durable before dispatch; allocate → crash → restart does not re-issue the same epoch.
- [x] ISC-144: The run-dir lease keys on pid plus process start-time, so a recycled pid is not mistaken for a live supervisor.
- [ ] ISC-145: A retried dispatch carrying the same `(task_id, attempt_uuid)` replays the stored response rather than returning a bare `already_completed`.
- [x] ISC-146: Every deadline and stall timer uses a monotonic clock; a wall-clock jump fires none of them early.
- [~] ISC-147: Across every hostile scenario, completion is never declared while the agent will still emit output. **PARTIAL — the scenario property table is far weaker than its name; the hand-written tracker tests are what actually defend this.** MACHINE-CHECKED every CI run (`bun test test/unit`): `completion.test.ts`'s "scenario property — never complete while output is still coming (ISC-147)" replays all 15 files in `test/fixtures/scenarios/` through a real `EpochManager` plus a real `CompletionTracker`, asserts the exact settle epochs per scenario, and carries a table-integrity test that fails the suite when a scenario is added without a reviewed expectation or an expectation outlives its scenario. The table CAN fail — making `queue_update` inert in `observe` turns `queue-race.json: settles exactly []` red. **What this audit found, and the reason the grade is not `[x]`: four separate mutations to the exact machine this criterion is about left all 15 scenario cases GREEN.** Dropping the probe generation token from `confirm`; replacing `countersEqual` with `true`; dropping `#queueEmpty` from `eligible`; and making `agent_end` set `#endedClean = true` regardless of `willRetry` were each caught ONLY by the hand-written `CompletionTracker` describes elsewhere in the same file ("hostile sequences", "probe validity", "queue conditions", "ISC-82, retries") — the scenario property never fired for any of them. Two structural reasons, both worth writing down: (1) the table asserts a settle COUNT and epoch, never a settle POSITION, so a premature settle in any of the 11 scenarios that expect one is invisible — only the four `[]` scenarios penalise prematurity at all; (2) `simulate()` is a re-implementation of the supervisor's routing INSIDE THE TEST FILE, and its own honest `isStreaming` model blocks several premature settles before the tracker is even consulted, which is why the `willRetry` mutation survived even the dedicated truncation test that exists to catch exactly that. **The quantifier is not met as written.** "Every hostile scenario" is 15 files replayed with `delay_ms`, `noise` and `partial` entries SKIPPED and with the harness never issuing an abort, so timing-dependent interleavings, the 16-worker flood and mid-record truncation are not exercised by this property at all, and `aborted.json`/`deaf-abort.json` collapse to natural completion (the file says so in its own comments). The real supervisor routing is exercised for a subset elsewhere — `lifecycle.test.ts` drives queue-race against real workers — but not for the set this criterion quantifies over.
- [x] ISC-148: Acceptance commands are resolved from the base SHA, not read out of the worker's tree. [live via `artifacts --run-acceptance`]
- [x] ISC-149: Acceptance commands run in a fresh clone by SHA, outside the worker's worktree, with no inherited environment. [live via `artifacts --run-acceptance`; fresh CONTAINER is still ISC-233]
- [x] ISC-150: A diff touching the test-harness surface caps the verdict at `blocked` or `unknown` and can never yield `success`.
- [x] ISC-151: `git merge-base --is-ancestor <base_ref> HEAD` is verified at harvest, so a rewritten base cannot shrink the diff to nothing.
- [x] ISC-152: A timed-out acceptance command yields `unknown`, not `failed`. [live via `artifacts --run-acceptance`]
- [x] ISC-153: The derived-fact bundle is hashed and recorded, so an adjudication can be replayed.
- [~] ISC-154: A worktree content hash differing between quiesce and harvest end forces `unknown` (backgrounded work kept writing). [LIVE but INERT — nothing populates `tree_hash_quiesce`/`tree_hash_harvest`, so the check cannot fire; needs supervisor cooperation] **PARTIAL — the decision rule is proved; its antecedent is unreachable, so nothing can satisfy it in a real run.** MACHINE-CHECKED every CI run (`bun test test/unit`): `adjudicate.test.ts`'s verdict-table case "ISC-154: a tree that moved between quiesce and harvest forces unknown" asserts verdict `unknown` carrying an `ISC-154` reason, and its paired case pins the other direction — a null hash is absence of evidence rather than proof of a move, so a harvest that could not hash the tree is NOT voided. Mutation-proved: replacing the inequality in `src/harvest/adjudicate.ts` with `false` fails it with `Expected: "unknown" / Received: "success"`. The check sitting FIRST in `adjudicate`, ahead of even the ISC-151 ancestor gate, is what makes a moved tree void self-reported failures too rather than merely capping successes. **NOT PROVED: that a moved tree is ever DETECTED.** The bracket note was re-verified in this audit rather than taken on trust — `grep -rn 'tree_hash_quiesce\|tree_hash_harvest' src/` returns only the two schema fields and the three lines of the comparison itself, no producer exists anywhere in `src/`, and the sole test data setting them (`integration/acceptance.test.ts`) sets them EQUAL. So this grades the adjudicator's arithmetic on a fact the fleet never computes, not the fleet's ability to notice backgrounded work.
- [x] ISC-155: Anti: no timeout, deadline, or stall computation reads `Date.now()`.
- [x] ISC-156: A SIGKILL at each syscall boundary of the atomic-write path leaves state recoverable and the ledger readable.
- [ ] ISC-157: A ledger written under an older schema version is read under a pinned, tested policy rather than crashing. **[STAYS OPEN — graded 2026-08-19, nothing written.]** The subject of the sentence does not exist: `grep -rn "schema_version\|SCHEMA_VERSION\|schemaVersion" src test` returns NOTHING, and `LedgerRecordSchema` (`src/contracts.ts:246`) carries no `schema` discriminator either — unlike the eleven envelopes that do, it has only `seq`, `ts`, `actor`, `run_id`, `event` and three optionals. Nothing stamps a version on a ledger record, so no record can be read as being from an older one, and there is no policy — pinned, tested or otherwise — to apply. What DOES happen was measured rather than assumed: a shard holding a record missing today's required `run_id` merges without crashing, the bad record is collected into `mergeLedger`'s `errors` and the other records survive. That is real and it is a strictly weaker statement than the criterion in two ways, which is why this is `[ ]` and not `[~]` — the record is DISCARDED, not read, and the behaviour is shape-driven, so it cannot tell "written by an older writer" from "corrupt shard", which is the exact distinction a version policy exists to make. Closing this needs a product decision first, not a test: either stamp a version on ledger records and pin a read policy against it, or restate the criterion as the shape-tolerance guarantee `mergeLedger` actually offers. Writing a test against the current behaviour would pin the absence of a policy and retire the criterion without satisfying it.
- [x] ISC-158: At 16 workers, no container-name or port collision occurs and no worker's event loop is starved by another's output. [no per-worker port surface EXISTS — see close-out]
- [x] ISC-159: `doctor` exits nonzero with an actionable message on a missing binary, a wrong version, and an absent daemon.
- [x] ISC-160: A stale image is not silently reused after the Dockerfile changed.

### Group N — Mount visibility (added 2026-07-27, found by the Docker-gated suite)

- [x] ISC-161: No host path that pifleet intends to bind-mount is derived from `os.tmpdir()`.
- [x] ISC-162: A bind mount is judged visible only by reading back a host-written sentinel, never by the mount succeeding or by `docker run` exiting 0.
- [x] ISC-163: A failed visibility probe reports that the daemon cannot see the path and names the override, rather than surfacing the bare `cat: No such file` beneath it.
- [x] ISC-164: `doctor` probes the runs root for mount visibility and exits nonzero when a worker's outbox would mount empty.
- [x] ISC-165: Anti: no `:ro` refusal test passes against a mount whose contents were never readable. **[CLOSED 2026-08-19 by this PR.]** The guard checks the property PER TEST, not per file: for every test body containing a `:ro` mount and an assertion that a command was rejected, it requires that same body to also assert a successful read. The reasoning is the criterion's own — a mount the daemon cannot see comes up as an EMPTY directory, and an empty `:ro` mount refuses writes too, so "touch failed" passes identically against a broken mount and a working one. `test/integration/image.test.ts` already gets this right and explains why in a comment; the guard turns a habit into a rule. It also fails if it finds zero `:ro` refusal tests to check, so renaming or deleting them cannot make it pass by vacuity. The test-body split is deliberately crude — chunking on the `it(`/`test(` boundary rather than parsing the AST — and errs strict: over-chunking would refuse to credit a read assertion in a neighbouring test, never the reverse. Mutation-verified: deleting the read assertion from the `/skills mounted ro` probe turns it red.

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
- [x] ISC-186: Registry writes are serialized, so concurrent registrations cannot lose a worker. **[CLOSED 2026-08-19 by this PR.]** The chain in `startRegistryDaemon` was already there; nothing had ever seen it fail. `test/integration/registry-serialization.test.ts` now watches `writeJsonAtomic`'s temp files, which exist for exactly the span of one write to `registry.json`, while twelve registrations arrive concurrently over the real socket AND a reaper scan deregisters three stale workers in the same window: never two at one instant, every registration present on disk afterwards, every reaped worker gone. The obvious test — fire N registrations, assert all N survive — is written up in the file as the weaker instrument it is, but NOT, as an earlier revision of this entry claimed, as one that cannot see the race at all. Measured with `persist()` bypassing `serialized()`, it failed 18 of 20 runs with no sampler present and 17 of 20 with one, losing a contiguous tail of the newest registrations (`w-11` alone at best, `w-2`…`w-11` at worst). It is a FLAKY detector, and that is a worse thing to rest a criterion on than no detector, because two-and-three green runs in twenty teach whoever hits the red to re-run until it passes. The mechanism assertion has no such mode: `maxConcurrent` read 12 with the chain bypassed and 1 with it intact, every run, the two distributions not overlapping. The earlier claim also defeated itself — it argued that a later-starting write is larger and therefore lands last, while the 512 KiB of filler the test adds makes one more worker a 167-byte step on a 524,562-byte write, a 0.03% difference that scheduling noise swamps. Completion order is roughly independent of snapshot recency, which is why the losses run the other way round from the prediction. Two vacuity guards stop the sampler passing having watched nothing: it must take more samples than there are writes, and must catch at least half the writes in flight (measured 13 of 13 on every one of 8 runs, over 95-113 samples). Reachability checked rather than assumed, since this ISA already has criteria whose library is correct and unreachable: `up` spawns `daemon` (`src/cli/commands/up.ts:717`), which calls `startRegistryDaemon` (`src/cli/commands/daemon.ts:42`), and supervisors send `register_worker` through it (`src/supervisor/index.ts:177`). BOTH writers to `registry.json` are pinned, which took a second pass to get right: `persist()` (`registry.ts:349`) and the reaper's post-scan deregistration (`registry.ts:430`). The first revision of this test passed no `opts.reaper`, so the reaper's write was never exercised and the criterion held only by inspection — a refactor could have lifted that call out of `serialized()` with the test still green. It now drives `reapOnce()` inside the same `Promise.all` as the registration burst, with a hand-driven clock and stubbed process ops so the reap is deterministic rather than timer-raced, and asserts the reap actually reported the three workers so the second writer cannot quietly stop being exercised. Mutation-verified separately against each writer, and the two detectors are not equally strong: bypassing `serialized()` in `persist()` turns it red on 20 of 20 runs with `expect(received).toBe(expected) / Expected: 1 / Received: 13`, while bypassing it in the reaper turns it red on 19 of 20 with `Expected: 1 / Received: 2`. The reaper mutation puts exactly ONE write outside the chain, so it is caught only when that write overlaps a registration write, and about one run in twenty it lands in a gap. Recorded at 19 of 20 rather than rounded up, and deliberately not tuned to 20 of 20 by arranging the overlap — that would be a weaker guarantee dressed as a stronger one, which is the failure this whole entry is a correction for. Green on 8 consecutive runs once both were restored. A second defect surfaced while checking this against the repo's own load harness (ISC-266): the test carried no explicit time budget, so it inherited bun's 5000 ms default over 32 ms of work, and under `LOAD_PROCS=32` it died at 5001.82 ms. It now derives `cliBudget(1)` = 11_400 ms from a counted spawn (`startRegistryDaemon` → `processStartTime` → one `ps`; everything else in the path is in-process or stubbed). Measured: 32 ms idle, 70-91 ms at the harness's DEFAULT load — a 2.2-2.8x inflation matching the repo's own measured CONTENTION of 2.09-2.98x — and 3.5-7.9 s at `LOAD_PROCS=32`, which is 2.3x cores and outside the harness's stated envelope. The budget clears the gate by 125x and the worst observed by 1.4x, and stays bounded. Worth recording that the first diagnosis here was WRONG and was caught by measuring it: the undelayed `while (!stop)` readdir sampler was blamed for starving the writes and for pinning a core on a 2-core runner, and an interleaved A/B refutes both — wall clock 26-31 ms either way idle and fully overlapping ranges under load, CPU time 0.09-0.11 s either way. The loop only looks like a spin; every iteration awaits a real `readdir`, so it is descheduled for nearly all of its life. The `Bun.sleep(0)` was kept regardless, for the `catch { continue }` path, which is the one place the loop genuinely has no syscall pacing it — but it is documented as that and not as a fix for a timeout it does not fix.
- [x] ISC-187: `image verify`'s read-only-root check proves the tmpfs is writable as well as that `/` is not.

Open — carried forward, not fixed here:

- [ ] ISC-172: The verbgate ledger is collected outside the container, so a worker cannot truncate its own audit trail. — STAYS OPEN, and the production code says so by criterion number. `docker/verbgate:26-30`: "KNOWN REMAINING EXPOSURE, stated plainly: the ledger is written by the worker, so a determined worker can still truncate it. Making the audit trail tamper-proof needs a collector outside the container — tracked as ISC-172, not solved here." What IS done is adjacent and must not be mistaken for it: the gate no longer lets its subject supply its own policy or redirect its own evidence (`PIFLEET_VERBGATE_LEDGER=/dev/null` and `PIFLEET_CLOUD_ALLOW_FILE` are refused; the policy file sits on a read-only mount and the gate exits 78 if it is writable by the current user). That reduces FORGERY and EVASION. It does not make the ledger authoritative against a hostile worker, which is the only thing this line claims. The verbgate suite is Docker-gated but genuinely runs in CI's `container` job with `PIFLEET_DOCKER=1`, so this is not an untested-code problem — it is an unbuilt-feature problem: no test asserts the containment property because no mechanism implements it. CLOSING IT COSTS: a host-side collector — the writable ledger mount replaced by a append-only sink the container cannot seek or truncate (a unix socket to a host collector, or a pipe drained by the supervisor), plus a rendezvous that survives worker restarts — and a probe that proves the property by ATTACKING it: a worker that runs `: > $ledger` (and `truncate`, and re-`open(O_TRUNC)`) and a host-side assertion that every prior line is still there. Anything less re-proves the evasion controls that already exist. NO MUTATION WAS RUN: there is no implementation to mutate, and mutating the evasion controls would produce a red test for a property this criterion does not assert.
- [x] ISC-188: `render.ts` and `run/paths.ts` compute the run directory once, not twice (`outbox`, `skills`, `env`, briefing paths, and `PIFLEET_RUNS_DIR` honoured).
- [ ] ISC-189: `up` refuses to run against an image that is absent or fails `verify`. **NOT IMPLEMENTED — stays open, and it is STRICTLY WEAKER-COVERED than ISC-32, not merely a duplicate of it.** Everything recorded against ISC-32 applies here and is not repeated; graded separately because this sentence adds "or fails `verify`", which is the harder half and the one with no machinery behind it at all. The ABSENT half at least has a cheap primitive available (`doctor.ts`'s `imageStatus` already does `docker image inspect`, it is simply not on `up`'s path). The FAILS-VERIFY half has none: `verifyImage` is operator-driven and nothing else in the tree consults it, so a stale-but-PRESENT image — same tag, wrong bytes — is not detected by anything on the launch path today. The only thing standing between an edited build context and a silently reused image is `configHash` moving the tag (ISC-160), which is a different mechanism from verification and fails open if a build context asset is ever added to the Dockerfile without being added to `BUILD_CONTEXT_ASSETS` — that fail-open is now tracked in its own right as ISC-270, which is closable by a unit test and does NOT depend on the `up` gate this criterion is waiting on. Note the shape of the near-miss for a future grader: ISC-24 (`image verify` fails on an image whose Pi version differs) IS `[x]` and genuinely proved in the Docker-gated container job — but it grades the `verify` PRIMITIVE, not `up` consuming it, and mistaking the one for the other is precisely how this criterion's sentence ended up copied verbatim into `container/image.ts`'s header as a statement of fact. TO CLOSE: both halves wired into the same up-side gate, and the `verify` half additionally needs the container job, since proving "a run refuses an image that fails verify" requires a real image that really fails.
- [x] ISC-190: `models_allowlist` is enforced — a worker whose model is not on the list does not start.
- [~] ISC-191: The kill ladder uses `(pid, started)` identity, never pid alone. **[RE-GRADED `[x]` -> `[~]` 2026-08-20 by the kill-path claim review. It was graded from a docstring that named a caller it did not have.]** **What was false.** `safety/kill.ts`'s header claimed this module was "used by `down`'s quiesce (SRD §9.3)". It was not. `src/cli/commands/down.ts` did not import `safety/kill.ts` at all, and `runKillLadder` had exactly ONE production caller — `safety/reaper.ts`. `down`, the only kill path an operator runs BY HAND, ran its own inline ladder over a bare `process.kill`, gated on `processStartTime(pid) !== null`, which is LIVENESS and not identity: `started` was compared at no rung, so the module's headline guarantee ("re-read from the OS and compared at EVERY rung") did not hold on the path where pid reuse matters most. The daemon rung was worse than unguarded-by-omission — `daemon.pid` holds `{pid, started}` written together by `startRegistryDaemon`, and the code parsed the file, took the pid and threw the recorded identity away. **Not theoretical, and proved by execution before the fix was written:** a run directory whose state file named a live, unrelated process had that process SIGTERMed and killed by a real `pifleet down`. `down-prune.test.ts`'s fixture already carried the scar — its first revision recorded `process.pid`, and `down` SIGTERMed the test runner's own process group and killed the suite five seconds in. The fixture was then changed to pick a pid that is NOT a group leader so the signal would raise ESRCH; the hazard was routed around, not removed. The operator case is a bare `pifleet down` after a reboot: it resolves the LATEST run, and the latest run is a dead one whose pids the machine has long since reissued. **What is now machine-checked.** `down` resolves a `ProcId` before it signals anything and climbs every rung on `signalIfSame`/`sameIdentity`; `anchorIdentity` refuses the entire ladder when a launch-recorded identity disagrees with the OS. `test/integration/down-identity.test.ts` asserts the NEGATIVE on both rungs — the bystander is still alive afterwards, and the worker reads `already_gone` rather than being laddered against a stranger — and is mutation-verified: deleting the single refusal line turns both tests red and kills the bystander again. `test/unit/kill.test.ts` continues to cover the reaper's ladder. **Why `[~]` and not `[x]`.** A worker with NO registry entry still anchors on whatever holds the pid at rung 0, because `WorkerState.started_at` is an ISO wall-clock string and is not comparable to `ps -o lstart=`. Every LATER rung is identity-checked, so the reuse-inside-a-grace-window case is closed, but the first rung is not proved for that case. ISC-270 carries it. **Recorded, and explicitly NOT grounds for this re-grade:** `bun test test/unit/kill.test.ts` alone throws `ReferenceError: Cannot access 'realProcessOps' before initialization` on a `kill.ts -> run/registry.ts -> safety/reaper.ts -> kill.ts` cycle. It executes normally under `bun test test/unit`, so it is local-isolation fragility rather than a dark test, and formed no part of this grading.
- [ ] ISC-192: A ledger or state file written under an older schema version is read under a pinned policy rather than failing. **[STAYS OPEN — graded 2026-08-19, nothing written.]** The ledger half is ISC-157's, unchanged: no version is stamped, so none can be older. The state-file half is worse than untested — current behaviour CONTRADICTS the criterion, measured directly. A `state.json` stamped `pifleet.state/v0` is rejected by `z.literal("pifleet.state/v1")` and `readWorkerState` raises `StateReadError: unreadable state file <path>: schema: Invalid input`; a `registry.json` stamped `pifleet.registry/v0` throws a bare `ZodError` out of `readRegistry` with no wrapper at all. Both are failures, which is precisely what "rather than failing" forbids. ISC-169 makes the state-file case a diagnosed one-line exit rather than a stack trace, and that is worth having, but a well-dressed refusal to read the file is still a refusal to read the file. Closing this needs a decision on what an older stamp should MEAN — accept and upgrade, accept read-only, or refuse by design — and if the answer is "refuse", the criterion is the thing that should change. **Recommend NOT tombstoning either this or ISC-157: they are not the same claim.** ISC-192 is wider in subject (adds state files, where the failure is real today) and stronger in outcome ("failing" covers a diagnosed error, "crashing" does not); ISC-157 is stronger in evidence, being the only one of the two that demands the policy be TESTED. Neither subsumes the other, so per the ID-stability rule both stay, and satisfying one would not satisfy the other.
- [ ] ISC-193: `EXIT.BUDGET` has a producer, or the code is removed from the ladder. **[RE-GRADED `[x]` -> `[ ]` 2026-08-19 by the unreachable-module sweep. This criterion is a DISJUNCTION and NEITHER arm holds — which is the exact state it was written to forbid.]** **Arm one — a producer — fails.** The only two things that can yield `EXIT.BUDGET` are `BudgetCeilingError.exitCode` (`src/safety/budget.ts:76`) and `budgetExitCode` (`:85`), and `src/safety/budget.ts` has zero importers in `src/`. `BudgetCeilingError` is constructed nowhere outside its own module and `budgetExitCode` is called nowhere at all, so no diagnosed failure and no folded verdict can carry 5. **Arm two — removed from the ladder — fails too.** `EXIT.BUDGET: 5` is still declared at `contracts.ts:349` and is still a member of `EXIT_SEVERITY` at `contracts.ts:399`, ranked between `BACKEND_UNAVAILABLE` and `WORKER_DIED`. **Demonstrated by enumerating the call sites rather than by grep alone.** Both `worstExit` callers were read in full. `wait.ts:171` folds `codes` built by `exitFor` (`wait.ts:186-209`), whose complete range is `TIMEOUT`, `WORKER_DIED`, `SUCCESS` and `PARTIAL` — there is no budget branch to mutate, because there is no budget branch. `scheduler.ts:351` folds its own `exitFor(t, reason)` over `graph.snapshot()`, whose states likewise never yield 5; the only exit `runSchedule` raises directly is `EXIT.TIMEOUT`, via `SchedulerError` on the no-progress path. So the ladder carries a rung nothing can stand on — precisely the dead-code hazard this criterion names. **Evidence, and what it proves.** `test/unit/budget.test.ts` -> `describe("ISC-193: EXIT.BUDGET has a producer")` passes. Read closely, it asserts that `budgetExitCode` RETURNS `EXIT.BUDGET` for a halted state and that `BudgetCeilingError` satisfies the `ExitCoded` protocol. Both are true of the functions and neither is a statement about production having a producer; the test names the criterion but measures the module. Its own comment — "budgetExitCode is what `wait` folds into `worstExit`" — asserts a wiring that `wait.ts` does not contain. **`[ ]` and not `[~]`:** a disjunction with both arms false has no partial reading. **Wiring that would close it, either way:** fold `budgetExitCode` into `worstExit` after harvest (ISC-235's second clause), which satisfies arm one and closes ISC-114/ISC-115 with it; or delete `EXIT.BUDGET` from `EXIT` and `EXIT_SEVERITY` together with `src/safety/budget.ts`, which satisfies arm two. Leaving the rung in the ladder with nothing able to produce it satisfies neither.

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
- [x] ISC-199: Anti: no assertion in the suite encodes a platform-specific spelling of a POSIX observation (`ps` printing `??` versus `?`). **[CLOSED 2026-08-19 by this PR.]** The guard bans hardcoded `ps` OUTPUT SPELLINGS in assertions, not `ps` itself — several tests legitimately spawn it, and `src/safety/mlx-training-guard.ts` parses `ps -axo pid=,command=` as a matter of design. What differs across platforms is what it PRINTS: a detached process shows `??` for its tty on macOS and `?` on Linux, and `ps -o sess=` reports 0 for every process on macOS while Linux gives a real session id — a difference `test/integration/supervisor.test.ts` already records in a comment. An assertion pinning either spelling is green on the machine it was written on and red on the other, which is the same "suite you learn to discount" failure as ISC-266, reached through portability instead of load. Mutation-verified: a planted `expect("x").toBe("??")` turns it red.
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
- [x] ISC-218: `writeJsonAtomic`'s directory-fsync failure cannot report a durable write as failed after the rename succeeded. **[CLOSED 2026-08-19 by this PR — and it was a live bug, not merely an untested claim.]** Only `dh.sync()` was guarded; the `open(dir, "r")` that precedes it was not, and that call needs READ permission on the directory while writing and renaming inside it need only write+search. So a `0o300` directory let every durable step run — tmp written, fsynced, renamed into place — and then threw `EACCES: permission denied, open '<dir>'` out of `writeJsonAtomic` with the correct file sitting on disk. A caller told a durable write failed retries it, marks a worker broken, or unwinds a state machine over a file that is already correct; losing the directory entry's crash-durability is the strictly smaller harm. The fix extracts `fsyncDirBestEffort` in `src/util/jsonl.ts`, which swallows the open, the sync AND the close — the close is in scope because a deferred filesystem error surfaces there and would escape a `finally` untouched. Two probes in `test/unit/jsonl.test.ts`: one calls the helper on a directory that does not exist, which no uid can open, so it does not depend on the permission model; the other drives the whole of `writeJsonAtomic` under a `0o300` directory and then asserts the file really did land and no temp was left. The second requires a non-root uid and asserts that precondition rather than skipping on it, so under uid 0 it fails loudly instead of passing having proved nothing. Mutation-verified: restoring the unguarded `dh = await open(dir, "r")` turns both red with `error: Expected promise that resolves`.
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
- [x] ISC-232: Harness-surface patterns come from config; `DEFAULT_HARNESS_PATTERNS` is the fallback, not the source of truth.
- [ ] ISC-233: Acceptance commands run in a fresh CONTAINER from the same image, not only a fresh clone (SRD §8.2).
- [x] ISC-234: The control socket answers `export_html`, so `transcript --html` uses the live path rather than the local-render fallback. — CLOSED. The verb did not exist: the supervisor's control switch went `ping|status|dispatch|steer|abort|shutdown` and fell to `default: unknown cmd`, and because `transcript.ts` catches every RPC failure and falls back silently, an unknown verb was indistinguishable from a dead worker — the live path was unreachable and every export, live or dead, took the local render. `src/supervisor/index.ts` now forwards `export_html` to Pi's own RPC (8s, deliberately under the CLI's 10s ceiling). Proved by `test/integration/supervisor.test.ts` > "a live worker exports through Pi; the same run falls back to the local render once it is gone" — a real detached supervisor over fake-pi, driven by the real CLI, asserting BOTH directions on one run: alive → `source:"rpc"` + the fixture's `EXPORT_MARKER` present, shut down → `source:"local"` + marker absent + still an openable document (ISC-101 unbroken). The marker lives in `test/fixtures/export-marker.ts` because the double consumes stdin at import time; the negative half is what proves the marker discriminates rather than merely occurring. Runs in CI's `test` job (`bun test test/integration`), no Docker gate. MUTATION: renamed the production case to `export_html_MUTATED` so it fell through to `default` → RED, `expect(received).toMatchObject(expected)` with `- "source": "rpc"` / `+ "source": "local"`; restored → 14/14 green, and the file's other 13 tests still pass. LATE-WRITE RACE — found reviewing this PR, and NEW WITH IT: before the verb existed the supervisor answered `unknown cmd` immediately, so Pi was never handed a path and never wrote. Pi renders the file ITSELF and the 8s deadline is advisory with no cancel verb, so the timeout stopped the supervisor WAITING, not Pi WRITING — t=8s the CLI falls back, writes its own render, prints `source:"local"`, exits 0; t=13s Pi finishes and overwrites it. The operator is told the file is the CLI's second opinion while the bytes on disk are the agent's: this criterion's own question, answered backwards, and a torn document if the writes interleave. CLOSED BY SINGLE-WRITER, not by ordering — Pi is aimed at a unique sibling `<path>.pi-export-<uuid>.tmp`, the supervisor returns `{ok:true, staged}` and never writes the requested path at all, and the CLI renames staging→path itself. Renaming inside the supervisor would only have NARROWED it: a Pi confirming at 7.9s with the reply delayed past the CLI's 10s ceiling puts the agent's bytes at the path AFTER the CLI wrote and reported `"local"` — the same inversion through a window too narrow to schedule. Removing the second writer leaves no window to size. The fallback now goes through `writeTextAtomic` (the ISC-156 tmp+fsync+rename+dir-fsync protocol, extracted from `writeJsonAtomic` rather than hand-rolled a second time); that does NOT decide who wins and is NOT what closes this — it bounds any other racer to whole-file replacement. Abandoned staging files are unlinked immediately on failure and again after 30s. 8s-UNDER-10s, PREVIOUSLY PINNED BY NOTHING: the comment was load-bearing and `EXPORT_HTML_TIMEOUT_MS = 60_000` inverted it with the whole suite still green. Both constants are now exported and `test/unit/export-html-race.test.ts` compares them directly — no clock, no subprocess, so the flip is red at any load — plus a ≥2s margin floor, because 9_999 against 10_000 honours the ordering in letter and loses it in practice. DEAD vs REFUSED: the bare `catch {}` in `transcript.ts` still could not tell a live worker answering `ok:false` from no worker at all — the same blindfold that let this criterion's ORIGINAL defect hide, left in place by the fix for it. `rpcExportFailure` now splits them: `SocketRequestError.neverDelivered` (ECONNREFUSED/ENOENT) and `ControlAuthError` stay silent because that IS the harvest case, and everything else — a refusal, a reachable-but-silent supervisor, an export that cannot be claimed — goes to stderr in distinct wording. Every branch still writes a file and exits 0. NOW PINNED by three further tests in `test/integration/supervisor.test.ts`: "a render that finishes after the supervisor gave up cannot overwrite the operator's file" (13s render, losing to both budgets; waits for `EXPORT_MARKER` to appear anywhere beside the output so the late render is proved to have HAPPENED — a wait on the staging path would assert the mechanism and pass vacuously against a Pi that never rendered — then asserts the operator's file is byte-identical to what they were handed); "a successful export leaves the requested path untouched until the CLI claims it" (the structural half: a confirmed success with `staged` set and `exists(outPath) === false`, which is what makes the race have NO residual window rather than a small one, since the dangerous ordering is not reproducible on demand); and "a render inside the CLI's window but outside the supervisor's: the supervisor is the side that reports" (9s render — the only interval where the two orderings differ observably). fake-pi's `export_html` case gained the `respond_delay_ms` branch that made all three expressible at all — `prompt`, `get_state` and `get_session_stats` honoured a delay and `export_html` did not — and it is deliberately NOT awaited, because `handle()` is awaited by the stdin loop and an awaited sleep models a WEDGED agent rather than a slow export. MUTATIONS, all measured at load average 4-6 on a 14-core box: (a) `const staging = path` → race test RED, `not.toContain("pi-export-html-marker")` against a page whose body is exactly that marker; (b) supervisor renames instead of returning `staged` → structural test RED, `expect(typeof staged).toBe("string")` receiving `"undefined"`; (c) `EXPORT_HTML_TIMEOUT_MS = 60_000` → unit test RED (`Expected: < 10000` / `Received: 60000`) AND ordering test RED (`- "source": "local"` / `+ "source": "rpc"`); (d) dropping the `ok:false` stderr note → ordering test RED, `toContain("refused export_html")` receiving `""`. Restored → 18/18 in `supervisor.test.ts`, 3/3 in the new unit file, 10/10 in `test/integration/transcript.test.ts`, 23/23 in `test/unit/jsonl.test.ts` (the ISC-156 SIGKILL cases, which now exercise the extracted body through `writeJsonAtomic` unchanged). RESIDUALS, three. (1) The container case is still unproved, and the mechanism moved: the CLI's `exists()` guard is now the rename, so a path Pi resolved in a container namespace fails ENOENT there instead — same correct degradation to the local render, same missing path translation, still proved only for a host-process Pi. (2) A supervisor killed between Pi's confirmation and the 30s sweep leaves one `.pi-export-*.tmp` beside the operator's file; harmless and namespaced, but reaped by nothing. (3) `msg["path"]` is still validated only as a non-empty string, so anyone who can reach the control socket can have Pi write any file Pi can write — narrow (the control secret is 0600 and the worker already holds Pi's authority), but the same class PR #34 adds an argv guard for, and this path gets none. Containment is NOT a one-line check here: `--html` is an operator-chosen path and confining it to the run directory would break the ordinary use, so it needs a policy decision — allowlist roots, or stage-and-copy-out — rather than a validation one-liner. **FILED AS ISC-276** (number allocated centrally, not picked here), which also records that this fix neither widens nor narrows that exposure: Pi's target changed from `path` to `<path>.pi-export-<uuid>.tmp` and the final write moved to the CLI, but the set of reachable files is identical.
- [ ] ISC-235: `BudgetManager.admit` is called on the dispatch path and its snapshot persisted; `budgetExitCode` folds into `worstExit` after harvest. — STAYS OPEN; all THREE conjuncts fail, and they fail for one root cause: `src/safety/budget.ts` has ZERO production importers. `grep -rln "safety/budget" src/` returns nothing; the only mentions of `BudgetManager` anywhere in `src/` outside the module itself are a COMMENT in `safety/kill.ts:219`. The module is reachable only from `test/unit/budget.test.ts`, which is why 20-odd green assertions have never contradicted this line. This is not merely unproven, it is observably FALSE at runtime, and independently so: the ISC-109 grading measured peak in-flight = 6 against `max_concurrent: 2` by driving the real `runSchedule` with 6 workers and 6 ready tasks. The mechanism is confirmed here — `max_concurrent` is defined at `config/schema.ts:190` and ENFORCED only at `safety/budget.ts:168`, inside the callerless module; `runSchedule`'s `inflight` map excludes a worker that is already busy but never caps the set against a ceiling, so idle workers are filled until they run out. `max_concurrent` is therefore parsed by the schema and read by no production code, and ISC-109 and this criterion share one root cause and will close together. Per conjunct: (1) ADMIT ON THE DISPATCH PATH — not called. `sendTaskEnvelope` (`src/cli/commands/dispatch.ts:113`) is THE dispatch path by its own docstring, and both the single-task command and `--auto` reach the supervisor through it without consulting a budget; nothing anywhere calls `.admit()` in production. (2) SNAPSHOT PERSISTED — no. `budget.json` does not exist as a path or a writer: `run/paths.ts` has no `budgetJson` member, and the only occurrence of the string in `src/` is a comment inside `budget.ts` describing a file nothing creates. (3) `budgetExitCode` FOLDS INTO `worstExit` — no. The two `worstExit` call sites (`wait.ts:171`, `scheduler.ts:351`) neither import nor call it, so `EXIT.BUDGET` has no RUNTIME producer at all — the unit test proves the pure function returns 5 for a halted state while nothing in production can ever construct one, which is the ISC-193 gap re-opened one layer up. NOT ATTEMPTED HERE, and the cost is why: this is a feature, not a wiring fix. It needs a `budget.json` path plus atomic writer; ceilings plumbed from `run.budget` (`config/schema.ts:152`) through commands that today never load config; a `settle` counterpart, because `admit` records a reservation that only `settle` releases and an unreleased hold wedges `max_concurrent` on the SECOND dispatch — and single-shot `pifleet dispatch` exits between the two, so the reservation has to be reconciled on load against on-disk task records; and a decision about concurrent writers, since N supervisors and the CLI would share one run-level file. Closing it honestly is a design session plus roughly a day, and a half-wired version that admits without settling is strictly worse than the current unwired one: it would refuse real dispatches for phantom in-flight tasks.
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
- [ ] ISC-246: `scanOutboxFiles` returns file DESCRIPTORS, not path strings — a validated path re-opened later is a TOCTOU window, and `nlink` can be raised after the scan. Latent while `safe` has no consumers; arms the moment E3 attaches artifacts. — STAYS OPEN, DELIBERATELY, and the criterion's own hedge is the reason. Current state: `OutboxFileScan.safe` is `string[]` (`src/harvest/outbox.ts:64-69`) — path strings, exactly as the criterion says it should not be. The scan validates with `lstat` + `realpath` on PATHS and opens nothing, so the refactor is genuinely undone, not half-done. **CORRECTION, 2026-08-20:** this note previously read "`nlink` is never read anywhere in the file", which was FALSE — `src/harvest/outbox.ts:537` reads `st.nlink` and refuses any entry with more than one name, and `test/unit/harvest-outbox.test.ts` > "a hard link to a file outside the outbox is refused" pins it (measured: delete the check and that test goes red with the linked private key sitting in `safe`). The correction makes this criterion MORE live, not less. Its own wording — "`nlink` can be raised after the scan" — describes a real read at a real instant rather than a hypothetical one: the scan reads the link count at T on a PATH, and a consumer that re-opens that path at T+1 gets no guarantee the inode still has one name. The path-string return is what leaves that window open, and it is still open. The LATENCY CLAIM IS TRUE AND WAS VERIFIED, not taken on trust: the sole production caller is `src/harvest/index.ts:207`, which reads `scan.refused` only and never touches `scan.safe`; every other read of `.safe` is inside `outbox.ts`'s own `push` calls or in `test/unit/harvest-outbox.test.ts`. Nothing in `src/` re-opens a scanned path, so there is no window to race today — the TOCTOU is armed by a consumer that does not exist. WHY NOT DO IT ANYWAY: the refactor is not small and it does not fully work. Returning descriptors changes the return type, ~10 call sites across the scan's five early-return paths and its bail-out branch, and introduces this repo's FIRST caller-owns-a-file-descriptor contract — every early return and every refusal becomes an fd-leak site, and the scan is explicitly bounded at 10,000 entries, so a leak there exhausts the process table rather than merely being untidy. Worse, it cannot close the window it names: Node exposes no `openat`/`O_NOFOLLOW` relative to a `FileHandle`, so the DIRECTORY walk stays path-based no matter what the leaves return, and the honest outcome is a partial fix carrying a full fd-lifetime tax. The trigger the criterion names ("E3 attaches artifacts") is a consumer nothing in this ISA has specified yet. CLOSING IT COSTS: ~90-110 lines in `outbox.ts`, an fd-lifetime discipline the codebase has no precedent for, and the existing symlink/containment tests (`harvest-outbox.test.ts:309-465`, all of which assert on path strings) rewritten to assert on descriptors — for an array no production code reads. That trade is worth taking WITH the consumer and not before; doing it now would be paying the tax to protect nothing, and re-writing containment tests while their subject has no user is how a real assertion gets quietly weakened. NO MUTATION WAS RUN: there is nothing implemented to mutate, and the existing tests pin the path-string behaviour the criterion wants replaced, so they would go red for the refactor rather than for a regression.
- [x] ISC-247: A backslash in an envelope path is refused. Harmless on POSIX, a separator anywhere else; not a control character, so the ISC-240 filter does not catch it.

### Phase 3 — security and cloud identity

- [x] ISC-248a: `up` refuses to start when the configured egress network exists but is NOT internal, rather than adopting it and reporting deny-all it does not enforce.
- [x] ISC-249: A checked-out repository is neutralized BEFORE any worker reads it; each hazard records `detected` and `neutralized` independently. **[CLOSED 2026-08-18, Slice 2]** Was open, blocked on ISC-27/ISC-28 (worktree/bind-mount round-tripping — both since closed) because neutralization needs a per-worker tree to run against, and nothing before Slice 2 created one. `run/worktree.ts`'s clone-based checkouts (SRD §9.2 erratum) close that gap: `up.ts`'s `onCreated` callback runs `neutralizeRepoHazards` against each finished CLONE — not the operator's own checkout, which stays detect-only, per SRD §12.8 — and unlike a linked worktree's pointer-file `.git` (which the scanner explicitly declines to follow), a clone's `.git` is a real directory the scanner acts on completely. Verified end to end, not inferred: `test/integration/up-wiring.test.ts`'s `egress verification and hazard neutralization...` test seeds a root `AGENTS.md` in the operator's repo, runs the real `up` CLI, and asserts a SECOND `repo_hazard` ledger event (`worker: "eng-1"`, `neutralized: true`) distinct from the operator-side detect-only one, that `AGENTS.md.pifleet-quarantined` exists inside the CLONE, and — closing the loop this criterion's own history warns about — that `inspectCloneDirt` reports the resulting checkout CLEAN rather than dirty-from-birth (see the `captureWorktreeBaseline` fix, ISA Changelog and Slice 2 close-out below, for why that last part needed its own fix once this test was written to check for it).
- [x] ISC-250: Every control-socket verb requires the per-run secret, `ping` included; a wrong or missing token is a clean refusal and the server stays up.
- [x] ISC-251: The Google grant is never silent — `up` states per worker which identity it got, or that it got none. Machine-checked in CI (`test/integration/up-wiring.test.ts`); the `token`-mode schema default is exercised here alongside ISC-49's explicit `file`, so the line is proved to REPORT the mode rather than to contain a constant that happens to read right. The identity it names is now resolved from the ADC principal rather than from `gcloud config get-value account` — a different credential store that routinely disagrees; see ISC-49's close-out for the full reasoning, the measured empty-`account` fallback, and the disagreeing-fixture test that pins it.
- [x] ISC-252: Egress host matching requires a label boundary; `evil-googleapis.com` and an empty leftmost label cannot ride a `*.googleapis.com` rule.
- [ ] ISC-248: `TokenRefresher` runs on the supervisor's lifecycle and re-injects before expiry. [IMPLEMENTED + UNIT AND DOCKER-VERIFIED, NOT WIRED — it attaches to a running container and the headless path starts none; wiring it now would attach it to nothing] **STAYS OPEN — audited 2026-08-19, and the first limb is FALSE rather than merely unproven.** `grep -rn 'security/refresh' src/` returns NOTHING: `TokenRefresher` has zero callers anywhere in `src/`, so it does not run on the supervisor's lifecycle or on any other, and `src/supervisor/**` imports only `security/control-auth.ts`. The bracket note's stated reason was re-verified independently rather than carried forward — `src/backends/headless/index.ts` is 45 lines and its `attachViewer` is a literal empty no-op, so the headless path genuinely starts no container for a refresher to attach to. **What IS proved is the second limb, and only as a MECHANISM:** `test/unit/refresh.test.ts` (23 tests, every CI run) pins that a worker with no token yet is due immediately, that the refresh fires at 45m — inside the ~1h token's lifetime — that each injection carries a genuinely fresh token rather than a reused one, that generations increment only on success, and that a failed mint or a failed `docker exec` reaches `onFailure` and retries on the short interval instead of leaving a dead token in the tmpfs for the full 45m. Mutation-proved: doubling `#intervalMs` in the constructor fails four of them, the on-point one being "refresh fires at 45m — before the ~1h token dies" with `Expected: "injected" / Received: "not_due"`. So the criterion's verb — *runs* — has no evidence and can have none until something constructs one. Deliberately NOT wired in this audit: attaching it to the headless path would attach it to nothing and would manufacture the appearance of a grade.
- [x] ISC-253: A relay consults `decide()` for live traffic. [STILL OPEN, and narrowed rather than closed by the 2026-08-18 egress relay. A relay now EXISTS and carries live traffic, but it does not consult `decide()`: it forwards a fixed, fully-specified target list (currently the oMLX endpoint alone) at the TCP layer, which is a stricter thing than the policy, not an application of it. Consulting `decide()` per destination only becomes meaningful for a relay that accepts arbitrary destinations — i.e. the Google half below — so this criterion stays coupled to that work. The `*.googleapis.com` rules remain policy-level and unit-tested with no live traffic path: a Docker network alias cannot be a wildcard, so routing them needs an HTTP CONNECT proxy or SNI-based TLS passthrough. Neither is built, and a `cloud_access` worker on the internal bridge consequently cannot reach Google at all. **UPDATED 2026-08-19 (PR #18 review, S13):** the stated reasoning above was half wrong and is corrected here. The relay's target list is NOT simply "fixed": `omlxRelayTarget` pins the HOST to a constant but reads the PORT straight out of `llm.base_url`, and nothing compared that port to `decide()`. So `llm.base_url: http://host.docker.internal:22/v1` produced a relay tunnelling the deny-all bridge to the Docker host's sshd on the alias every worker already resolves. `ensureEgressRelay` now calls `decide()` on every target before building argv and refuses on deny (`assertTargetsAllowed`). **Be precise about what that does NOT do:** `policyFromConfig` derives its llm rule from the SAME `base_url`, so the two still agree BY CONSTRUCTION and the gate does not today refuse the port-22 example — a unit test named `DOCUMENTED VACUITY` pins that fact so nobody mistakes the gate for protection it does not yet provide. What bounds the case today is the host pin: the worst outcome is a port on the Docker host, which SRD §12.8 now records as reachable from the bridge gateway anyway. The gate's value is the SEAM — when the dial side is decoupled from the listen alias (ISC-259), judging the target against an explicit `egress.allow` entry the operator WROTE becomes a change of input rather than a change of design. **This criterion is now BLOCKING for that work: S13 must land before the host pin is relaxed.** **CLOSED 2026-08-19 (ISC-259 branch), and the blocking obligation was honoured in order: decouple, gate, THEN relax.** The vacuity is gone because the two inputs to the comparison are now independent. The dial target comes from a NEW field, `llm.relay_upstream` (host:port, explicit port, defaulting to `host.docker.internal:<port from base_url>` so no existing config changes behaviour), and the policy comes from `relayGatePolicy` — NOT `policyFromConfig`. That distinction is the whole fix and it is not cosmetic: passing `relay_upstream` to `policyFromConfig` would have re-opened the circularity through a different field, because an operator writing `base_url: http://192.168.86.49:8000/v1` gets an `llm` rule that authorizes the very upstream under test. `relayGatePolicy` therefore contains NO config-derived host at all except ones the operator wrote as allow rules: rule 1 is `RELAY_LISTEN_ALIAS` (a compile-time constant, unreachable by editing YAML) at the listen port, plus every `egress.allow` entry. `google_hosts` are excluded — the relay forwards no Google traffic, so those rules must not authorize a relay target. **PROVEN BY MUTATION, not by inspection** (`test/unit/relay.test.ts`, fast `test` job, no Docker): one config with `relay_upstream: 192.168.86.49:8000`, varying ONLY `egress.allow`. The test first asserts the two configs produce a BYTE-IDENTICAL target, so the difference cannot be target construction; then asserts the with-entry case is ACCEPTED (which rules out the base_url pin, the upstream parser, port validation and `makeRule` as the refusing party); then asserts the without-entry case throws with `rule: default-deny` SPECIFICALLY — as opposed to `invalid-host`/`invalid-port`, which would mean the gate rejected the target's shape and never consulted the policy. Near-miss entries (right host wrong port, wrong host right port, a prefix of the host) are all still refused, so the check is "an entry covers THIS destination", not "an entry exists". A separate test drives `ensureEgressRelay` with a recording `exec` and asserts the refusal happens with ZERO docker calls made, because every other assertion would stay green if the production call site were wired back to `policyFromConfig`. Teeth verified by mutating the source two ways: re-deriving a rule from the upstream turned 5 tests red, ignoring `egress.allow` turned 2 red. PR #18's `DOCUMENTED VACUITY` test was REWRITTEN rather than left passing — it asserted a limitation this change removes, and a green test claiming the gate is circular would actively mislead the next reader. **Residual, stated rather than implied:** rule 1 authorizes the Docker host at the listen port with no allow entry, which is what keeps existing configs working. That is bounded by MEASUREMENT — SRD §12.8 records every port on the bridge gateway as already reachable from the deny-all bridge with no relay running — so the gate demands authorization for exactly the reachability the relay CREATES, which is everything off-host. **The Google half is NOT closed by this** and is split out as ISC-263 so this criterion can close honestly: `*.googleapis.com` rules remain policy-level with no live traffic path, and a `cloud_access` worker on the internal bridge still cannot reach Google.]
- [ ] ISC-254: The timing-safe comparator is pinned by a test. [Replacing `timingSafeEqual` with `===` leaves the suite green: the two are behaviourally identical by construction, so only a timing measurement distinguishes them and that is too flaky to gate CI. Documented in place; NOT covered]
- [x] ISC-255: A `cloud_access: true` worker's container can actually run `gcloud` — `CLOUDSDK_CONFIG` (`/home/pi/.config/gcloud`) is writable. FOUND 2026-08-18, FIXED 2026-08-19 in PRODUCTION rather than by relaxing the tests. `docker/Dockerfile` bakes `CLOUDSDK_CONFIG=/home/pi/.config/gcloud` as an ordinary directory on the image's root filesystem, but §5.6's `docker run` flag list is `--read-only` with only `/tmp` as tmpfs — so the FIRST `gcloud` call in a credentialed container crashed: `ERROR: gcloud crashed (OSError): [Errno 30] Read-only file system: '/home/pi/.config/gcloud/configurations'`, exit 1, empty stdout, measured on `pifleet/pi-worker:verify` with a VALID minted token present. `buildDockerArgv` now emits the tmpfs §5.2 always described, via `gcloudConfigTmpfsArgv()` in `src/security/adc.ts`. Every option is measured, not copied from `/tmp`'s line: `uid`/`gid` are REQUIRED — without them the tmpfs mounts root-owned 0755, gcloud hits EACCES rather than EROFS, TOLERATES it, and exits 0 while warning on every call and caching nothing, i.e. the un-owned version looks like it works; `size=16m` is ~4,000 gcloud invocations of headroom at a measured ~4 KB per call (one ~1.2 KB log per invocation, 10 calls left the directory at 64 KB against a 28 KB baseline); a SEPARATE tmpfs rather than repointing `CLOUDSDK_CONFIG` at `/tmp` (which would need no new mount) because the token file lives in `/tmp` and gcloud's unbounded log growth would otherwise consume the space `injectToken` needs, and a refresh that cannot write is a worker that silently loses cloud access an hour in. A tmpfs and not a bind mount, so it contributes no `.Mounts` entry and ISC-44's mount-table claim is untouched. Proved with a live differential in `test/integration/adc.test.ts`: one container in the pre-fix shape (`gcloudConfigTmpfs: false`, the one opt-in deviation the file allows) and one in production's, identical otherwise, each given a real token minted through production `gcloudMinter` — the first crashes on a read-only filesystem, the second exits 0 and prints the token back, with empty stderr (empty stderr specifically, because the root-owned near-miss also exits 0). `test/unit/render.test.ts` separately asserts `buildDockerArgv` EMITS the tmpfs for every role, cloud or not — mutation-proved: deleting the `argv.push` turns that test red while every integration probe stays green, since those build their container from the same exported function. THE SAME DEFECT HAD BEEN INTRODUCED INTO THE TESTS, which is how it survived: `adc.test.ts` added a `$CLOUDSDK_CONFIG` tmpfs of its own to every container it built, so five pre-existing tests ran in a shape `pifleet up` cannot launch — shadowing the credential store ISC-45/46 exist to probe, and making ISC-43's filesystem sweep search an empty overlay instead of the directory gcloud writes into. `startContainer` now builds production's flags and takes the tmpfs from production's own function.
- [x] ISC-257: `test/integration/relay.test.ts` executes in CI. **[CLOSED 2026-08-19 by PR #19.]** The file is now named in the `container` job's `bun test` list AND in the guard's accounting, and its probes genuinely EXECUTE — this is the half of the pair that could close properly, because Docker is a thing a runner actually has. Measured against a real daemon before the wiring was written: `PIFLEET_DOCKER=1 bun test test/integration/relay.test.ts` → **5 pass, 1 skip, 0 fail**, with `docker network ls` and `docker ps -a` verified identical before and after, so the suite cleans up after itself. The one skip is the live-oMLX probe, PINNED BY NAME (`EXPECTED_LIVE_OMLX_RELAY_SKIPS`) rather than allowed by a count. `TOTAL_EXPECTED` 66 → 72 — relay contributes 6 (2 bridge-denial + 4 relay probes) — recomputed ONCE for this and ISC-262 together, by the cheap exact method now written into the workflow: run the same file list with `PIFLEET_DOCKER` UNSET, where every gate closes and the collection total IS the summary line (`0 pass, 72 skip, 0 fail`, 49ms, no daemon, no image). Corroborated a third way: the full `bun test test/integration` reports 76 skips = 72 container-gated + 4 oMLX-gated. `relay-script.test.ts` deliberately NOT added — ungated, no Docker, already in the fast job. **The reproducible re-check this `[x]` rests on is the guard, and the guard is now itself tested:** `test/integration/probe-guard.test.ts`, 12 ungated cases in the fast job, asserts it goes RED when a file drops out of the list, when a pin is renamed, when a pinned test runs instead of skipping, when an unpinned test skips while the count still matches, and when a real failure would otherwise read as total drift. The committed pin was additionally checked end-to-end by reading it OUT of `ci.yml` and matching it against bun's junit output on a real daemon, so a typo in the workflow could not have passed. **What this does NOT close:** the live-oMLX relay probe is the only assertion anywhere that a REAL model list comes back through the relay; it does not run in CI and cannot. That is ISC-50's live-only residual, not this criterion's. [FILED 2026-08-19 with the egress relay, and NOT fixed by it. The relay suite is gated on `PIFLEET_DOCKER=1`, exactly like `image`/`verbgate`/`egress`/`adc` — but the `container` job in `.github/workflows/ci.yml` names those four files literally, and the relay file is not among them. The fast `test` job never sets `PIFLEET_DOCKER`, so the relay probes self-skip there. The net effect is that ISC-50/51/57's evidence executes on the maintainer's machine and in NO CI job at all: the identical silent-green failure the comment above `EXPECTED` in that workflow describes for `egress.test.ts` and `adc.test.ts`, reproduced one file later. Not fixed in the relay branch on purpose — `ci.yml` is owned this round by the Group D PR (#16), which is moving `TOTAL_EXPECTED` to 60, and two branches editing the same guard would collide. The fix is to add the file to the `container` job's `bun test` list AND to the guard's, then raise the expected count by the 3 relay probes that run unconditionally. The live-oMLX probe must NOT be counted: it needs a real inference server and `OMLX_API_KEY`, so it will always skip on a runner — which also means the guard's `skip -ne 0` arm has to tolerate exactly one skip in this file, or gain a `MAX_OMLX_SKIPS` in the shape `MAX_HOST_ADC_SKIPS` already has. **UPDATED 2026-08-19 (PR #18 review):** still open, still not fixed here — `.github/workflows/ci.yml` is owned this round by PR #16, and two branches editing the same guard would collide. Three things changed around it. (1) **S11 is fixed in advance of the wiring:** the live-oMLX probe used to interpolate the real `OMLX_API_KEY` into a shell string passed as `docker run` argv — visible in `ps`, in the ephemeral container's `docker inspect`, and in any CI log that echoes commands. It is now passed by NAME via `-e OMLX_API_KEY` and expanded by the container's own bash. No leak had occurred only because this file has never run anywhere but the maintainer's machine; it would have become a live exposure on the first CI run with a real secret, i.e. the moment this criterion is closed. (2) A NEW test file, `test/integration/relay-script.test.ts`, covers the relay script against real sockets with NO Docker and NO gate — so it runs in the fast `test` job today, and is currently the only relay coverage that executes in CI at all. It must NOT be added to the `container` job's list. (3) The `container` job's expected count must rise by the relay probes that run unconditionally — now FIVE in `relay.test.ts` (three original, plus the two new enumeration/residual probes), with the live-oMLX probe still excluded because it needs a real inference server and will always skip on a runner. The gateway-residual probe can also return early on a host whose gateway serves none of the candidate ports; it logs `[inconclusive]` and still counts as a pass, so it does not need a skip allowance. **The new file earned its keep on its first CI run:** it caught that `docker/egress-relay.js` was only valid CommonJS by accident of its mount location — `package.json` sets `"type": "module"`, so the checkout copy was an ES module and `require()` threw on the host, while the container copy is mounted alone with no `package.json` beside it and fell back to CommonJS. Renamed to `.cjs`. That bug was invisible to every Docker-path test and would have stayed invisible.]
- [~] ISC-258: A live INFERENCE — not just a model-server call — is asserted through the relay by a test. **[PARTIAL 2026-08-19 by this PR — the test exists and passes locally; no CI runner can execute it.]** `test/integration/relay.test.ts` now contains "a live INFERENCE round-trips through the relay, differentially against a host control". Measured: **`gemma-4-26b-a4b-it-4bit` answered `"4"` in 428 ms** from a container attached to nothing but the deny-all bridge, with the direct control answering `"4"` too; a second run under the full guard measured 511 ms. It asserts real GENERATION, not a 200: the echoed `model` must equal the model requested and `usage.completion_tokens` must be > 0, because an empty string with a 200 is not an inference. **The trap this filing exists to prevent is handled by an ALLOWLIST, never a heuristic.** Reproduced here, not taken on trust: on the local server `Qwen3-Embedding-4B-4bit-DWQ` is FIRST in `/v1/models` and answers chat with HTTP 500, so `data[0]` is wrong; and "the first id that is not obviously an embedding model" is WORSE, because it selects `Qwen3.5-35B-A3B-4bit`, which needs 24.93GB against a `--max-model-memory 24GB` cap and SIGABRTs inside MLX's Metal completion handler during generation, killing the server. No ordering rule is safe, so only names already run by hand are eligible (`SAFE_CHAT_MODELS`), and the 35B is additionally named in `FORBIDDEN_CHAT_MODELS` so that widening the allowlist means deleting a line that says it crashes the server. **A second reason no heuristic is safe, measured this round:** error shapes do not generalise across hosts — the same embedding model, same request, returns HTTP 500 "Internal server error" on the local server and HTTP 400 "is not an LLM / chat model" on the LAN one. A probe classifying models by how they fail would be right on one host and wrong on the other. `gemma-4-26b-a4b-it-4bit` answers correctly on BOTH (75.4 s cold / 0.76 s warm local; 4.8 s LAN), so the allowlist survives ISC-259 moving the upstream. **The differential is the shape the filing specified.** A control completion is taken directly from the host first; if it does not answer correctly the fixture cannot judge the relay and the probe bails rather than failing. After a relayed failure the control is RE-CHECKED, because in the observed crash the server died BETWEEN the two calls — a relayed failure with a control that has also gone away is a dead server, not a relay defect. Only a relayed failure against a still-succeeding control is a real failure. The relayed model list is additionally asserted IDENTICAL to the direct one before the completion, so the differential cannot silently compare two different servers; that is concrete rather than theoretical, since the local server serves 3 models and the LAN one 32. The key is read from `OMLX_API_KEY` and passed by NAME via `-e OMLX_API_KEY` for the container's own bash to expand — PR #18's argv fix is not regressed. **Why `[~]` and not `[x]`, honestly.** The probe is `test.skipIf(!OMLX_LIVE)` and needs an Apple-silicon inference server no GitHub runner has or will have, so not one line of it executes in CI. It is PINNED BY NAME in `EXPECTED_LIVE_OMLX_RELAY_SKIPS` so the skip is enumerated rather than invisible — an unpinned skip is how five self-skipping probes went unnoticed last round — and the guard goes red if it is renamed, deleted, or starts running. Second, and stated plainly: the two bail paths above are PASSES with a warning, which is what the guard counts. That is a real limitation and the price of exercising a fixture nothing else controls; the alternative is a suite that goes red whenever an unrelated server restarts. The capability is proven and re-runnable on the maintainer's machine; it is not re-checked by anything a runner executes, so it does not earn `[x]`. [FILED 2026-08-19. `POST /v1/chat/completions` was measured working through the relay from inside the deny-all bridge (705 ms warm, correct answer), so the capability is real; what is missing is a test that holds it. Writing one was attempted and DELIBERATELY BACKED OUT, because the local oMLX server is not a dependable enough fixture to gate a suite on: measured on 2026-08-19, `Qwen3-Embedding-4B-4bit-DWQ` is FIRST in `/v1/models` and answers `/v1/chat/completions` with HTTP 500 (so the obvious `data[0]` pick is wrong); `Qwen3.5-35B-A3B-4bit` took 2m20s and then closed the connection with no reply; and during the attempt the oMLX server itself CRASHED and restarted, turning a green suite red for a reason that has nothing to do with egress. That crash has since been root-caused and is NOT a pifleet bug: `com.pai.omlx` runs with `--max-model-memory 24GB`, and `Qwen3.5-35B-A3B-4bit` needs 24.93GB — it logs "Loading … without KV headroom" and then SIGABRTs inside MLX's Metal completion handler during generation. **Any live oMLX probe added here must exclude that model by name**, and use `gemma-4-26b-a4b-it-4bit` (15.26GB) or `Qwen3-Embedding-4B-4bit-DWQ` (2.21GB, embeddings only — it answers `/v1/chat/completions` with HTTP 500). Picking a chat model as "the first id that is not obviously an embedding model" walks straight into the 35B and kills the server, which is exactly the trap this note exists to keep the next person out of. The key is read from the environment (`OMLX_API_KEY`) and must never be written into a test, a fixture, or a commit. A differential design — take a direct completion from the host as the control, and only fail when the control succeeds and the relayed call does not — is the shape that would work, and it must re-check the control AFTER a relayed failure, because in the observed crash the server died BETWEEN the two calls. Until that is built, ISC-50 rests on the models-list roundtrip and this stays open rather than being closed on a hand measurement nothing re-runs]

- [~] ISC-259: The oMLX endpoint the SRD specifies and the oMLX endpoint that actually serves this fleet's models are the same machine. [FILED 2026-08-19 as an OPEN QUESTION for the owner, deliberately NOT answered here, and nothing was changed to accommodate either answer. **IDs 257-259 were consumed by this branch**; 255 is the Group D branch's and 256 the Group E probe/guard branch's, so numbering is not centrally allocated and may need reconciling at merge. **Overlaps deliberately, not accidentally**, with the probe/guard branch's criterion covering the same live finding from the `doctor` side ("report which allowlisted models the endpoint actually serves") — that one is about VISIBILITY, this one is about whether the relay may point off-host AT ALL, which is a containment question and not a reporting one. Whichever lands second should reference the first rather than restate it. SRD §5.9 is titled "The LLM is local — oMLX on the **Docker host**" and states it as a constraint rather than a default: "Every worker's model is served by oMLX running on the same machine as Docker. No hosted provider is involved, in any role, ever." Its verified-topology table records "oMLX listens on `:8000` on the host", and §12.4's containment argument is derived FROM that locality — the host auth proxy is not built because the key "guards a local inference server; losing it costs nothing beyond this machine". `src/security/relay.ts` implements exactly that: `omlxRelayTarget` THROWS unless `llm.base_url`'s host is literally `host.docker.internal`, because that alias is the only name the internal bridge resolves. MEASURED 2026-08-19, and this is the contradiction: the oMLX instance on THIS Docker host serves 3 models and NONE of the three in `fleet.example.yaml`'s `models_allowlist` (it has `Qwen3.5-35B-A3B-4bit`, not the allowlisted `-8bit`), so `up` against it fails the now-enforced allowlist check with exit 2. A DIFFERENT machine, `192.168.86.49:8000`, serves 32 models including all three. Note the subnet claim needs correcting: this host is `192.168.86.58/24`, i.e. the SAME segment as `.49` — its `10.x` addresses are Parallels bridges and a VPN tunnel, not the LAN. So the choice is between (a) loading the allowlisted models onto the Docker host, which keeps §5.9 and the relay untouched, and (b) pointing the fleet at a remote model server, which is an SRD amendment and not a config tweak: `host.docker.internal` means the Docker host by definition, so the relay would have to decouple its LISTEN-side alias from its DIAL-side target (today `omlxRelayTarget` forces them to be one host string), and — the part that actually matters — the deny-all bridge would gain a hole to another machine on the operator's LAN. ISC-51/ISC-57's evidence would need re-taking against that posture, because "reaches the Docker host and nothing else" is a different claim from "reaches an arbitrary LAN peer". Owner decision required before either path is coded. **AMENDED 2026-08-19 (PR #18 review, F1/F4) — the owner has decided to amend SRD §5.9 + §12 to permit a trusted-LAN oMLX at `192.168.86.49:8000`; that erratum is its own PR after #16/#17/#18 merge. This criterion must name two things the original filing missed.** **(a) §12.4's CREDENTIAL argument stops being true, not just its containment argument.** §12.4 justifies injecting `OMLX_API_KEY` straight into the worker with no auth proxy because the key "guards a local inference server on Dan's own machine — it carries no billing authority and no value off this host". Measured: oMLX here binds `127.0.0.1:8000`, loopback only, which is exactly what makes that sentence true. A LAN oMLX at `192.168.86.49:8000` is bound to a routable interface BY DEFINITION, reachable by every device on 192.168.86.0/24, and `llm.base_url` is plain `http://` — so the key would cross an UNENCRYPTED LAN hop on every request and would have value on at least one other host. The original filing flagged §5.9 and §12.4's containment argument; it must also flag §12.4's credential argument and the plaintext transport. **(b) SEQUENCING: ISC-253 (S13) must land BEFORE the host pin is relaxed.** The host pin is the only thing bounding the relay's blast radius today, and it is exactly what the LAN move removes. Point the dial side at a LAN host while the port is still an unchecked derivation of `llm.base_url`, and the same code becomes a TCP tunnel from a bridge running untrusted model output to an arbitrary host:port on the operator's home LAN, established by editing one YAML string. S13's `decide()` gate has landed (see ISC-253) but is circular until the dial target is decoupled from `base_url` and judged against an explicit `egress.allow` entry — so the ORDER is: decouple, then gate against operator-written allow rules, then relax the pin. This is the single most important sequencing consequence of the SRD amendment.] **[~] RESOLVED 2026-08-19 — the SRD contradiction is gone and the code permits a trusted-LAN oMLX; marked `[~]` rather than `[x]` because no test proves LIVE traffic through a relay to the LAN server.** WHAT IS PROVEN, and where: (a) the decoupling, the gate and the argv are covered by `test/unit/relay.test.ts` (45 tests, fast `test` job, no Docker) — see ISC-253 for the mutation proof; (b) `config validate` accepts a real LAN config and refuses a hostname upstream with the resolver diagnosis, run against a generated fleet.yaml on this machine; (c) the endpoint facts in SRD §5.9's re-measured table — LAN `192.168.86.49:8000` returns HTTP 200 and serves 32 models including all three allowlisted, the Docker host's oMLX binds `127.0.0.1:8000` loopback-only and serves 3 models with NONE allowlisted, and `route -n get 192.168.86.49` shows `interface: en0` with no gateway from this `192.168.86.58/24` host. (c) is a LOCAL measurement, reproducible only on this network, which is by itself enough to bar `[x]` under the strictness rule. WHAT IS NOT PROVEN: no test stands up a relay dialling `192.168.86.49:8000` and confirms a container on the internal bridge reaches it end-to-end. That is Docker-gated work in `test/integration/relay.test.ts`, owned by the concurrent ISC-261/258 change, and its evidence still describes the PRE-amendment topology — SRD §12.8's new erratum says so explicitly rather than leaving the reader to assume the old measurements still hold. SRD changes: §5.9 retitled and rewritten (Docker host becomes the DEFAULT; the no-hosted-provider prohibition is explicitly RETAINED and called out as not what was relaxed), §12.4's credential argument restated (the key crosses an unencrypted LAN hop and has value on one other host — accepted residual, with the conditions that would make TLS required named up front), §12.8's reachable set gains `∪ {one LAN host:port}` and records that this is the first time the relay WIDENS a worker's reach rather than renaming reachability the bridge already had. Alias decision: the `host.docker.internal` overload is ACCEPTED and stated in §5.9, not renamed — ISC-264. `--add-host` is now emitted only when a target actually dials the Docker host, and a hostname upstream is refused outright, so the flag is never dead weight and never a resolver bug.]

- [x] ISC-261: ISC-51 and ISC-57 are re-taken against an ENUMERATED reachable set, not sampled probes. **[CLOSED 2026-08-19 by this PR.]** All three terms of SRD §12.8's reachable set are now enumerated by `test/integration/relay.test.ts`, which runs unconditionally in the `container` job. **{every port on the bridge gateway}:** a full 1–65535 scan, from the deny-all bridge and from an ordinary bridge. The scanner is built from what the worker image already has — measured by running it, `nmap`, `nc`, `ncat`, `socat`, `ss`, `netstat` and `ip` are ALL absent, but bash 5.2.15 has `/dev/tcp` compiled in — one connect per port at `-P 512`, ~32 s for the range; re-run at `-P 128` it returned the identical set, so the fan-out is not costing accuracy. **The expected set is NOT derived from a second probe of the same shape**, which would be circular in exactly the way ISC-253's `decide()` gate was: ground truth is `/proc/net/tcp` + `/proc/net/tcp6` read from a `--network host` container — the kernel's own socket table, state `0A` = `TCP_LISTEN`, obtained without sending a packet. The relation is a STRICT subset and measurably so, which is what makes it worth asserting. Measured: kernel `[22, 53, 39375, 40375]`; ordinary bridge `[22, 39375, 40375]`; deny-all bridge `[22, 40375]`. **{relay listen ports}:** a full-range scan of the relay's own bridge address returns EXACTLY the one derived listen port (measured: `[59502]`) — "it forwards what we asked for" and "it forwards ONLY that" are different claims. **{sibling containers}:** `docker network inspect` is authoritative for membership rather than a sample of it. **Nothing is inconclusive and nothing is vacuous.** The old probe had an early-return that logged `[inconclusive]` and PASSED on a host serving none of its five guessed candidates — a silent pass wearing a warning label — and an empty-set-equals-empty-set comparison is true of a scanner that is simply broken. Evidence is now PLANTED rather than hoped for: a host-namespace beacon (`--network host`) and a published beacon (`-p`) go up before either scan and must both appear in the ordinary-bridge scan, which proves in one line that the scanner works and both beacons came up. The sibling assertion is planted the same way, because an idle bridge cannot distinguish a working enumeration from one that returns nothing (the vacuous-pass shape of PR #18's M3): a stray container is attached, the enumeration must SEE it, the membership rule must FLAG it as unaccounted for, its ports must be reachable from an ordinary worker, and removing it must return the bridge to a clean state. **The enumeration changed what this test asserts, which is the argument for building it.** The previous `reachable == served` is FALSE in general: a published container port is NOT reachable from the internal bridge, because Docker's isolation DROP lives in FORWARD and is evaluated AFTER nat/PREROUTING has rewritten the destination to an address outside the bridge subnet. The old assertion held only because all five guessed candidates happened to be host-namespace services. So §12.8's residual is NARROWER than "every port the Docker host listens on" — it is every HOST-NAMESPACE listener — and that was found by enumerating, not by reasoning about iptables. **Would it have caught M1?** Yes, and that is the point: it plants a listener in the host namespace and asserts, in a line someone has to write down and mean, that the deny-all bridge REACHES it. Under ISC-51's original "no route to anything" wording that assertion is a contradiction you cannot author without discovering the defect. Two probes at `1.1.1.1` and `example.com` can never surface it, because neither is on the bridge. `TOTAL_EXPECTED` 72 → 74 (the rewrite of the gateway probe is in place and changes no count; the new sibling probe is +1, ISC-258's is the other). Re-derived by measurement, not arithmetic: gate unset → `0 pass, 74 skip, 0 fail`, and the real `probe-guard.sh` run over the container file list with the constants read OUT of `ci.yml` reports `total=74 expected=74`, 74 pass, 212 s. **What this does NOT establish:** the probes have not yet been observed on a GitHub runner — they are wired in and pinned by the total, so a failure there is a RED build rather than a silent green, but the passing measurements above are all from Colima/macOS. The residual itself is NOT closed and is not closeable here; it is enumerated, bounded against kernel ground truth, and printed on every run. [FILED 2026-08-19 (PR #18 review, F5). The two-probe evidence (`1.1.1.1`, `example.com`) that closed ISC-51 could not distinguish the current posture from a materially looser one, and in fact did not catch the bridge gateway being wide open (M1; SRD §12.8 erratum). This branch replaces sampling with enumeration for the ROUTE TABLE — exactly one on-link route, zero default routes — which is the structurally strong half. What remains is the REACHABLE SET itself, which is not bounded by any test: `{relay listen ports} ∪ {every port on the bridge gateway} ∪ {every port on every sibling container on the bridge}`, none of which is fixed. Post-LAN-move (ISC-259) it gains `∪ {one LAN host:port}` and the distinction matters more, not less. The shape that closes this: assert exactly one on-link route and no default (DONE); assert the gateway reachable ONLY on ports the host is independently known to serve, enumerated rather than guessed; assert every sibling container on the bridge is an expected fleet member; and post-move assert the LAN peer unreachable except through the relay's listen port. **That test is also the one that would have caught M1**, which is the argument for building it rather than re-running what is already there. Blocked on nothing; deferred because the remediation strategy for the gateway residual is an owner decision and the enumeration's expected values depend on it.]

- [~] ISC-262: `test/integration/model-probe.test.ts` executes in CI. **[PARTIAL 2026-08-19 — PR #19 wired it, and wiring is NOT the same as executing here.]** **State the limit first, because this is the criterion most easily mis-closed.** The file is now named in a dedicated step of the fast `test` job and graded by the same guard as the container probes. **Its four probes still SKIP on every CI run, and they always will.** They need a real Apple-silicon inference server on `localhost:8000`; no GitHub-hosted runner has one. Naming a file in a job does not make its probes run — it makes them skip somewhere VISIBLE instead of invisibly, and grading this `[x]` on the grounds that the file now appears in a workflow would be the fifth self-skipping-test finding of this round, filed by the very PR meant to fix the class. **What the wiring genuinely bought, stated exactly:** the skip is now NAME-PINNED and ACCOUNTED FOR. Before, `grep -rn PIFLEET_OMLX .github/` returned nothing and the four skips vanished into a 449-test summary that nobody counts. Now, if a probe is renamed, deleted, added, or starts skipping for a different reason, the step goes red and names it. `TOTAL_EXPECTED: 4` catches the whole file falling out of collection — which bun does SILENTLY, exiting 0 even when every filter matches nothing (measured). Verified by reading the four pin strings out of `ci.yml` and matching them against bun's junit report: green as committed, red when one pin is dropped, red with an empty pin list. **The inverse case is covered by the same guard for free:** point this at a self-hosted runner with `PIFLEET_OMLX=1`, remove the pins, and an empty pin list permits NO skips — so a half-configured environment that asks for the live probes and gets skips fails loudly, which is what this file's own header demands. **A stub was considered and deliberately rejected.** `doctor-omlx.test.ts` (PR #17) already IS the stub half of ISC-54/55, is ungated, and already runs; `test/unit/model-probe.test.ts` is the stub half of ISC-53's refusal. Both files' headers document that split on purpose. Each remaining live probe needs the real server for a reason stated in its own comments — a stub latency measurement measures the stub, and a stub model list is the test that already exists. A second stub would have made a skip LOOK like coverage. **What is still unproven and needs a live host:** ISC-53's positive control (a real model answering a tools-bearing probe with a native call), ISC-55's measured generation latency, and the model-list set-equality against a real server. Those close only on a machine with oMLX, and this criterion stays `[~]` until such a runner exists. **NO SECRET IS WIRED IN,** deliberately: `OMLX_API_KEY` would flip nothing, because the reachability check fails regardless, so shipping a live credential to a runner would be pure exposure for zero coverage — and #18 moved that key out of argv precisely to stop it leaking. [FILED 2026-08-19 by PR #18 at merge time. Found during #16's rebase and correctly NOT re-graded there — re-grading another branch's criterion mid-flight is how two branches end up disagreeing about the same file — so it falls to the last branch in the merge order. VERIFIED here rather than taken on report: the file gates on `const LIVE = process.env["PIFLEET_OMLX"] === "1"`, `grep -rn PIFLEET_OMLX .github/` returns NOTHING, and running the file locally gives `0 pass, 4 skip`. So ISC-53's live probes execute in no automated job at all — the same silent-green class as ISC-257, on a different switch. **Scope, stated precisely so this is not read as bigger than it is:** `test/integration/doctor-omlx.test.ts` is UNGATED and does run (3 pass, confirmed here), so ISC-54/55's `[x]` stands on evidence that genuinely executes. This is about ISC-53's LIVE half only — the `[x]` there rests on unit-level coverage plus probes that never run in CI. **Fix together with ISC-257**, in a dedicated follow-up PR that owns `.github/workflows/ci.yml`: both are CI wiring, both need the container job's expected-count arithmetic re-done once, and splitting them across two PRs means doing that arithmetic twice against a moving target. That PR must also decide what a runner does without a real oMLX — a `MAX_OMLX_SKIPS` allowance in the shape `MAX_HOST_ADC_SKIPS` already has is the likely answer, since these probes need an inference server a runner does not have.]
- [ ] ISC-263: A `cloud_access` worker can actually reach the configured Google endpoints. [SPLIT OUT of ISC-253 on 2026-08-19 so that criterion could close honestly rather than carrying an unmet half. ISC-253 asked for a relay that consults `decide()` for live traffic; that is now true, non-vacuously, for every destination the relay CARRIES (see its close-out). It is not true for Google, and the reason is structural rather than unfinished work: `egress.google_hosts` rules are matched exhaustively by `decide()` in unit tests, but NO live traffic path to `*.googleapis.com` exists, because a Docker network alias cannot be a wildcard. Routing them needs an HTTP CONNECT proxy or SNI-based TLS passthrough, neither of which is built. **The user-visible consequence, stated so nobody rediscovers it from a stalled worker:** a `cloud_access: true` role on the internal bridge cannot reach Google at all, so ADC is granted and then unusable there. SRD §12.4's control table lists `egress allowlist` as bounding where a token can be used, which is accurate but reads as though the path exists. Closing this means building the proxy, then re-taking ISC-51/57's containment evidence against a relay that accepts arbitrary destinations — which is the case `decide()` was designed for and has never actually been exercised against.]
- [ ] ISC-264: The name a worker resolves for oMLX does not claim to be the Docker host. [FILED 2026-08-19 by the ISC-259 branch, as the deliberate cost of a decision taken there rather than as a defect discovered later. `RELAY_LISTEN_ALIAS` is `host.docker.internal`, and once `llm.relay_upstream` may name a LAN peer that alias means "wherever this fleet's oMLX is", not "the Docker host". The honest name is `omlx.pifleet.internal`. **The overload was ACCEPTED and stated in SRD §5.9 rather than renamed, for two checkable reasons, and neither is convenience:** (1) the name has no prior meaning on an `--internal` bridge to shadow — measured, a container there cannot resolve `host.docker.internal` at ALL because Docker does not inject it, so it resolves only because `relayConnectArgv` attaches it as an alias; (2) at the time of the change `model-probe.ts:hostFacingBaseUrl` rewrote that exact literal to `localhost` for host-side probing, so a second accepted spelling would have silently skipped the rewrite and misprobed — a NEW quiet failure introduced by a cosmetic rename. **Reason (2) HAS SINCE EXPIRED, and the record is updated rather than left predicting it.** ISC-260 merged (PR #21) and deleted `hostFacingBaseUrl` outright: the `up` probe now runs inside the egress network and dials `llm.base_url` verbatim, exactly as a worker does, so no rewrite keyed to this literal survives. `doctor` deliberately keeps a HOST vantage and labels it (`omlx (from host)`, `"vantage": "host"`) — ISC-260's engineer measured that containerising it would make `doctor-omlx.test.ts` Docker-gated and convert the only CI-executable evidence for ISC-54/55 into a self-skip — but that is a reporting choice, not a dependency on this alias. **Net effect on this criterion: it is now CHEAPER to close than when it was filed, not more urgent.** Reason (1) does not expire and is what the deferral now rests on alone. **What the overload actually costs:** anything legitimately needing the real Docker host from inside the bridge must use the gateway address (§12.8) and gets no error if it uses the name instead. Nothing in this codebase does that today, which is why this is a naming-honesty debt and not a live bug. Closing it means renaming the alias and rewriting at render time across four consumers — `models.json`, `llm.base_url`, `doctor`, `docker/entrypoint.sh` — with a compatibility alias during the transition.]
- [ ] ISC-265: Changing `llm.relay_upstream` takes effect without a manual `docker rm -f`. [FILED 2026-08-19 by the ISC-259 branch. `ensureEgressRelay` adopts an already-RUNNING relay by NAME without comparing its forwarding targets to the current config, and the relay is a durable, shared resource that `down` never removes and that `--restart unless-stopped` brings back across reboots. That limit was FAIR while only the PORT was configurable — the worker then connects to a port nothing is listening on, which is loud where it lands. **ISC-259 made it UNFAIR, and the new failure mode is the dangerous kind: after changing `relay_upstream`, an adopted relay keeps forwarding to the OLD machine and nothing anywhere is loud about it.** Every worker connects successfully, gets real completions, and is talking to the previous oMLX; there is no closed port to notice and no error to read. Worse for the amendment's own purpose: the operator who moves the fleet to the LAN server to get the allowlisted models may still be served by the host oMLX that lacks them. **Detectable but not refused today:** `ensureEgressRelay` returns `scriptSha256`/`targets` on EVERY run, adopted or created, and `up` writes them into the `egress_relay_ready` ledger event — so two runs that disagree leave a record. Detectable in a ledger is materially weaker than refused at `up`. **Not fixed in the branch that created the need, deliberately:** closing it means reading `PIFLEET_RELAY_TARGETS` back out of `docker inspect` and then deciding whether a mismatch may kill a relay other fleets may be using. That is a lifecycle decision, not a parsing one, and it wants its own change.]
- [x] ISC-266: An integration test that spawns subprocesses does not fail on a developer machine purely because the machine is busy. [FILED 2026-08-19 by the ISC-259 branch, after a REPORTING ERROR on that branch made the underlying defect visible — the error is recorded here because it is the more instructive half. **What was wrongly claimed:** `test/integration/harvest.test.ts > report honours the same config as artifacts` was reported in PR #20 as a "pre-existing failure on main", on the evidence that it also failed on a pristine `4207b89` worktree. That evidence was real but the CONCLUSION did not follow: running a test on a pristine checkout OF THIS MACHINE establishes "fails here at that commit", not "fails at that commit". **What is actually true, verified against CI rather than inferred:** run `32268059522` on `4207b89` concluded `success`, and its log contains `(pass) pifleet artifacts — the harvest API (§8.4) > report honours the same config as artifacts [1235.00ms]`. **main is not broken, and the distinction matters** — "main has a failing test" and "this test is load-sensitive locally" send the next reader to completely different places, and a false claim that main is broken is exactly the record-keeping class this project has spent a session eliminating. **The real defect, measured:** the test performs TWO sequential `runCli` subprocess spawns inside bun's default 5000 ms per-test budget. CI completes it in 1235 ms — roughly 4x headroom — and that headroom is not enough on a developer machine under concurrent load. Measured at the time of failure: load average **18.40 on 14 cores**, with three agents running test suites simultaneously and several shells at ~96% CPU. Under that load it failed 3/3 consecutive runs, i.e. it is CONSISTENT under load rather than intermittent, which is why it initially read as a genuine breakage. `materialize.test.ts` and `up-wiring.test.ts` showed the same shape in the same window (hook timeouts under parallel load, green in isolation), so this is a CLASS and not one test. **Why it deserves a criterion rather than a footnote:** a suite that is green in CI and red on every busy developer machine trains its readers to discount red, which costs more than the test ever pays for — the same failure mode as a self-skipping test, arrived at from the other direction. Closing it means giving subprocess-spawning integration tests a budget derived from what they actually do rather than inheriting a default that happens to fit an idle machine, and it should be judged by deliberately running the suite under load, not by re-running it on a quiet box until it passes.] **[CLOSED 2026-08-19 by PR #25 — graded AFTER the CI job below actually ran, not on the expectation that it would.]** **The fix is a budget derived from the work, not a bigger default.** `test/support/budget.ts` computes `cliBudget(N) = max(5000, N * 1900 * 3 * 2)` where `N` is the subprocess spawns a test actually performs. `1900` is not an average — spawn cost is NOT uniform, and that is the fact the model is built around: `report` and `artifacts --all` grade a whole run and cost ~1.3-1.6 s each, while `artifacts --task`, `config validate` and `render` cost ~50-200 ms. `1900` rounds up the worst single expensive spawn measured (1335, 1408, 1618, 1631 ms idle across the four one-spawn tests in `harvest.test.ts`), and charging every spawn at that rate is deliberate conservatism for mixed tests. `3` is the worst per-test inflation actually observed under load (2.09x-2.98x), `2` is headroom for the busier machine this criterion recorded. The result is BOUNDED on purpose: a genuinely hung subprocess still fails, it just fails later. An unbounded budget would trade a flaky test for a hanging suite, which is this same erosion of trust from the other direction. **Why a helper and not a config key:** bun 1.3.11 IGNORES `[test] timeout` in `bunfig.toml` — probed directly, a deliberately-6s test still died at 5001.03 ms with `timeout = 12345` set — and `--timeout` only covers the invocation that passes it, so neither protects a developer running a bare `bun test`, which is precisely the case this criterion is about. The per-test third argument is the only mechanism that travels with the test. (Probed on 1.3.11; CI pins 1.3.12 and was not probed. It does not matter to the fix: a config key that worked would still be a repo-wide number rather than a per-test one.) **What was applied, measured STANDALONE per file** — a full-suite run inflates per-test times through bun's own inter-file concurrency and would have sized every budget against the wrong number. 375 testcases, 23 at or above 1200 ms idle. Eight budgets went where a test was at risk and had NONE: `harvest.test.ts` x5 (including the four-spawn test this criterion was filed over) and `doctor-cmux.test.ts` x3. Eleven at-risk tests already carried hand-picked budgets and **every one of them exceeded its derived value, so NOT ONE WAS REDUCED**; each now records its spawn count, derived value and measured idle so the next reader can see why it stands rather than guessing. **The limits of the model, recorded because they bound what it is good for.** Three slow tests are NOT described by spawn count, and deriving budgets for them would have TIGHTENED tests that pass: `supervisor`'s ISC-212 test measures 11415 ms idle against a `cliBudget(1)` of 11400 — narrower than its own runtime — because its cost is a deliberate 1s deadline plus 5s abort grace, not spawn startup; `acceptance`'s ISC-152 test spawns no CLI at all, its 6006 ms IS the 6s run budget it sets on purpose; and `worktree`'s L443 drives git subprocesses in-process, so no CLI spawn count exists to derive from. All three were left alone rather than given an invented `N`. **The evidence, from both directions.** Before: under ten busy loops on 14 cores, three `harvest.test.ts` tests died at exactly 5001-5003 ms — the timeout, not the work — and the one this criterion names reached 9991 ms once the budget was lifted; it failed 3/3 consecutively, consistent rather than intermittent. After: the full integration suite under eleven loops ran **375 pass / 81 skip / 0 fail in 300.87 s** against 167.76 s idle, a 1.79x inflation with every budget holding, and the same pass/skip/fail split as the idle baseline so nothing skipped its way to green. **Why this earns `[x]` and not `[~]`.** This criterion says explicitly that it "should be judged by deliberately running the suite under load, not by re-running it on a quiet box until it passes", and a script under `.github/scripts/` that a developer must REMEMBER to run would not be a judgement — it would be a suggestion, which is what "just re-run it" already was. `.github/scripts/test-under-load.sh` is therefore wired into a dedicated `load` job in `.github/workflows/ci.yml` that runs `test/integration` under `ceil(cores * 0.75)` busy loops on every PR and exits with the suite's own status, so an inadequate budget — or a test whose spawn count grows without its `cliBudget(N)` growing too — fails a PR instead of a developer's afternoon. Verified green on run `32291463113` before this criterion was marked, and verified to be DOING something rather than merely passing: on that same run and the same commit, `test/integration` took **124.32 s in the `test` job and 222.78 s in the `load` job — 1.79x**, which is the same inflation factor measured locally on 14 cores (167.76 s -> 300.87 s). Two busy loops against two cores is real contention: three runnable threads competing for two CPUs. (The "load average now" line the script prints is NOT the evidence and should not be read as such — it is a one-minute average sampled two seconds after the generators start, so it always reads low, 0.95 on that run. The wall-clock comparison is the evidence.) **What that job does NOT prove, stated rather than implied.** The runner reports **two** cores — not the four this criterion's first draft assumed, and measured rather than guessed — against the 14 these numbers came from, and it carries none of the editor, language server, browser and concurrent agents behind the load average of 18.40 recorded above. It reproduces the SHAPE of the defect — CPU contention stretching subprocess spawns past a fixed ceiling — at a smaller magnitude. It is a floor on the evidence, not a ceiling, and if this criterion ever needs re-opening it will be because a developer machine outruns the runner by more than the 3x contention factor allows, not because the mechanism is wrong. **Not one assertion was weakened**: `git diff` shows zero `expect(...)` lines added, removed or altered across the whole change, and no file under `src/` was touched. **Two residuals observed and deliberately NOT fixed here**, so they are visible rather than lost: `test/e2e/lifecycle.test.ts:197` carries a `3_000` budget, BELOW bun's own 5000 default, and `test/integration/exec.test.ts` carries four hand-picked `30_000` budgets against a 200 ms slowest test — a 150x margin, the same "number unrelated to the work" pattern as this criterion, arrived at from the generous side.
- [x] ISC-267: A timing assertion in a CI-executable guard test does not fail on the clock's precision rather than on the property it defends. **[FILED AND CLOSED 2026-08-19 by this PR.]** DISTINCT FROM ISC-266, and the signature is what separates them: ISC-266 is subprocess tests timing out on a LOADED DEVELOPER MACHINE, where contention makes a measurement take LONGER. This fired in CI, on an idle GitHub runner, by coming in UNDER a floor — `doctor-omlx.test.ts:246`, `Expected: >= 40, Received: 39`, on a run that was otherwise 374 pass / 1 fail. Load cannot produce that; it is the opposite direction. **Why it matters more than its size.** `test/integration/doctor-omlx.test.ts` is the ONLY CI-executable evidence for ISC-54 and ISC-55 — ISC-260's engineer specifically declined to containerise `doctor`'s probe in order to keep it that way. A guard that fails 1-in-N erodes trust exactly as a self-skipping one does: people learn to re-run instead of read. **Diagnosis, measured rather than assumed.** The assertion compared the reported latency against `COMPLETION_DELAY_MS`, the delay the stub REQUESTED via `await Bun.sleep(40)`. A sleep is a request to be woken no earlier than N, not a guarantee the caller can assert on. Measured 400 trials on macOS/bun 1.3.11: `Bun.sleep(40)` never resumed early (min 40.032ms, zero of 400 below the floor), so the defect does NOT reproduce on the maintainer's machine and appears only on the Linux runner — which is precisely why the fix had to stop depending on timer precision rather than tune a margin. **The fix strengthens the test rather than widening it.** Two changes. (1) The stub now holds via a deadline loop that re-sleeps the remainder until the monotonic clock agrees, so it cannot return early whatever the timer does (measured over the same 400 trials: min 40.001ms, zero early). (2) The floor is now the delay the stub OBSERVED ITSELF TAKING, not the one it asked for. That form cannot be flaky by construction: the client starts its clock before the request and stops it after reading the body, so its interval strictly contains the handler's hold, and `Math.round` is monotonic non-decreasing, so `round(client) >= round(server)` follows. **And it uncovered a real hole while being fixed, found by mutation rather than by reading.** The comment on that assertion claimed a stamped-in constant would fail it. It would not: replacing the measurement with `report.completionLatencyMs = 42` left the suite GREEN, because 42 clears a 40ms floor. A floor is a statement about MAGNITUDE; "the number tracks elapsed time" — which is what the test is literally named for — is a statement about VARIATION, and nothing was asserting it. The probe now runs a second time against a stub holding four times as long and requires the reported figure to move with it, so no single constant can satisfy both floors at once. Mutation-verified after the fix: constant `42` FAILS (it passed before), constant `5000` FAILS (it clears every floor), and a clock read twice with no work between FAILS; the unmutated test passes. The tracking margin is deliberately loose — half the added delay — because the property is that the number MOVES, not that it moves precisely, and a tight margin would re-introduce the very timing-sensitivity this criterion is about. **[SECOND INSTANCE, 2026-08-19 — found by ISC-266's load job, which is the first thing that gate caught.]** `dispatch-auto.test.ts` asserted `gapMs > 100` on the delay between two dependent dispatches, justified by six local runs measuring 237-262 ms. It failed on the load job with `Expected: > 100, Received: 100`. The gap is QUANTISED by `DEFAULT_POLL_MS` in `src/orchestrate/scheduler.ts`: the scheduler re-examines readiness once per 100 ms tick, so a gated dispatch lands one, two or three ticks later and the observed gap is a multiple of 100, never a continuum. Those local runs were 2-3 ticks because 'a' took longer than one tick to settle on 14 cores; on a two-core runner it settled inside a single tick and the gap fell to its FLOOR — which the threshold had been placed exactly on, so a strict `>` called the best possible correct behaviour a bug. The comment's claim that "the margin only WIDENS under load" was the error: load changes how many ticks elapse, not the one-tick floor. Fixed by comparing `>=` against the exported constant rather than a hand-picked number, so the test tracks the scheduler if the interval changes; the discrimination it exists for is untouched, since a same-pass dispatch is ~0-5 ms, two orders of magnitude below one tick. **Recorded here rather than as a new criterion because the property is already stated** — a timing assertion must fail on the thing it defends, not on the measurement's granularity. Only the granularity differs: ISC-267 was the clock's, this is the scheduler's.
- [ ] ISC-268: `adc_mode: file` is not silently inert — it either mounts the ADC file through `buildDockerArgv`, or the mode is removed from the schema. **[FILED 2026-08-19, promoted out of ISC-44's prose so the gap is a criterion rather than a caveat inside a closed one.]** ISC-44 is honest about this and the admission deserves its own line: its `file`-mode probe "hand-writes the `-v` itself and inspects a shape it authored", so it pins a CONTRACT that mode must satisfy when wired, not evidence about a launch `up` can perform today. **Measured, not inferred:** `ADC_FILE_PATH` (`/creds/adc.json`, `src/security/adc.ts:69`), `fileModeMaterials` and `fileModeStartupEnv` have ZERO callers anywhere in `src/` outside `adc.ts` itself, and `buildDockerArgv` emits no `/creds` mount at all — a fact `adc.ts:63` already records in a comment. The net effect is a config value that is accepted and does nothing: an operator can set `adc_mode: file`, `up` will not refuse it, and no credential is mounted. A mode that neither works nor fails is worse than one that is absent, because the failure surfaces as an unexplained permission error inside the container rather than at launch. **Why this is load-bearing and not tidying.** ISC-44's three-relation mount guard carves out exactly ONE documented exception — the single ADC file `file` mode may mount. That exception currently defends a path nothing takes, so the guard's most delicate branch is precisely the one with no production coverage; the day `file` mode is wired, that carve-out is load-bearing on its first run, having never executed against real argv. **The probe, either arm of which closes this:** WIRED — `grep -rn 'ADC_FILE_PATH\|fileModeMaterials\|fileModeStartupEnv' src/ | grep -v 'security/adc.ts'` returns non-empty, AND an integration test `docker inspect`s a container built from `buildDockerArgv`'s own output (not hand-written `-v` flags) and asserts the ADC file is mounted while nothing else from the host gcloud store is. REMOVED — `adc_mode: file` is rejected by the config schema, and all three symbols plus ISC-44's carve-out are deleted in the same change. Leaving the value accepted and inert satisfies neither arm.
- [x] ISC-269: Interrupting `pifleet logs --follow` ends it cleanly, whatever the follower still has to catch up on. **[FILED AND CLOSED 2026-08-19 by this PR, promoted out of a test that had been read as flaky for a session.]** **The defect.** SIGINT and SIGTERM handlers were registered AFTER `await pollAll()` had already returned, so the entire first drain ran unguarded and a signal arriving inside it got Bun's default disposition — terminate, exit 130 — rather than the clean return the surrounding code documents. **Why it was mistaken for flakiness, and why that mistake is the instructive half.** The unguarded window is exactly as long as the backlog takes to render, so the failure is PROPORTIONAL to how far behind the follower is rather than random. Measured on the unfixed code, killing on first output: 200 000 buffered events exits 130 five times out of five, 50 000 the same, 20 000 the same, 5 000 four times out of five, and a single event exits 0 five times out of five. The existing test `SIGINT also ends a follower cleanly` uses a ONE-EVENT fixture — the fastest-draining case there is — so it sat in the coin-flip tail and read as an environmental annoyance. It is not an ISC-266 timeout (that is contention against a fixed budget) and not an ISC-267 clock-precision miss; it is a real product bug that a user hits every time they Ctrl-C a follower attached to a worker with any real history. **The fix** moves both registrations above the first drain and pulls that drain inside the existing try/finally, so listeners are still removed on every path including the `!follow` early return; a signal during the drain sets `stopped`, the drain finishes, and the follow loop is skipped — the same one-final-drain-then-return behaviour, applied to the first drain as well as the last. **Evidence.** A second test gives the follower 50 000 events and requires exit 0. Mutation-verified: it fails `Expected: 0, Received: 130` against the unfixed source and passes against the fixed one. It lives in `test/integration/logs.test.ts`, which the `test` job runs on every PR, so this is CI-executable rather than a hand-run — which is what earns `[x]` here rather than `[~]`. **Scope stated rather than implied.** A signal arriving BEFORE the first drain — during argument parsing or the `stat` calls — still exits 130, deliberately: nothing has been emitted, so there is no session to end cleanly. **On budgets:** the new test measures 120 ms, well under ISC-266's 1200 ms threshold, because it kills on first output rather than waiting out the drain — so it correctly carries no `cliBudget`.
- [ ] ISC-271: A `fleet.yaml` that sets `backend.kind` either gets that backend from `up`, or is rejected by `config validate` — it is never silently overridden by the flag default. **[FILED 2026-08-20 by the kill-path claim review, found while verifying an unrelated docstring and deliberately NOT fixed here.]** **The probe.** Write a config containing `backend: {kind: cmux}`, run `up` with no `--backend`, and read which backend was loaded. Today it is `headless`, and nothing anywhere says so. **The evidence.** `src/config/schema.ts:129` defaults `kind` to `"cmux"` inside `BackendSchema`, which `FleetConfigSchema` mounts at `backend:` (line 399), so the field parses and validates. Nothing reads it. Every `loadBackend` call site takes `opts.backend` — `up.ts`'s own `--backend` option, whose default is `"headless"` (line 113) — or a `presentation.backend` recorded from that same flag, or the literal `"cmux"` in `doctor`. The config's value reaches no selection anywhere. This is not confined to `kind`: `workspace`, `split` and `focus_on_dispatch` in the same block have no config read either, so the whole `BackendSchema` is inert rather than one field of it. `config validate` reports such a file as valid because it IS schema-valid — the field is simply never consulted, which is the same "documented flag that nothing reads" shape `down`'s `--keep-panes` and `--prune` were each caught in once already. **Why it is filed and not fixed.** Making `up` honour the config changes which backend a run actually selects for every `fleet.yaml` already carrying the schema default of `cmux`, which is a behaviour change with a real blast radius; removing the block is the same decision taken from the other side. Either resolution closes this criterion. Guessing which one does not.
- [ ] ISC-272: Every rung of `down`'s kill ladder compares against a start time recorded when the supervisor LAUNCHED, never one read off the pid at rung 0. **[FILED 2026-08-20 by the kill-path claim review, as the declared residual of the ISC-191 fix rather than a defect discovered later.]** **What the fix already closed.** `down` resolves a `ProcId` before signalling and climbs every rung on `signalIfSame`/`sameIdentity`, so no rung reaches `process.kill` on a pid alone. Where a launch-time identity EXISTS it is used, and disagreement refuses the whole ladder: the daemon's comes from `daemon.pid` (`{pid, started}`, written in one call by `startRegistryDaemon`), a worker's from the registry entry `register_worker` persists — whose own comment is "identity is (pid, start-time) so pid reuse cannot resurrect us later". Both are mutation-verified in `test/integration/down-identity.test.ts`. **What is left.** Worker registration is `{optional: true}`, so a daemon that never came up, or a `register_worker` that failed, leaves no entry — and `down` then anchors on whatever holds the pid at rung 0. That still identity-checks every LATER rung, closing the case where the target dies inside a grace period and the kernel rehomes its pid before the next signal, but it cannot tell a supervisor from a stranger at the FIRST rung. A stale run directory whose worker never registered can therefore still be laddered against an innocent process. **What closing it costs.** `WorkerState` cannot answer this today: `started_at` is `new Date().toISOString()` (`src/supervisor/index.ts`), which is not comparable to `ps -o lstart=`. Closing it means adding the `ps`-comparable string to `WorkerStateSchema` in `contracts.ts` — a Phase-3 seam file, READ-ONLY to the phase engineers — writing it from the supervisor, and deciding what `down` reports for a state file written before the field existed. That is a schema migration with a compatibility policy attached, which is ISC-192's territory, and it is why this is filed rather than folded into the ISC-191 fix.
- [ ] ISC-273: No test in `test/integration/down-prune.test.ts` runs on bun's inherited 5000 ms default; each derives its ceiling from the spawns it performs. **[FILED 2026-08-20 by the kill-path claim review, as an ISC-266 residual in a file that sweep did not reach.]** **The probe.** `grep -c cliBudget test/integration/down-prune.test.ts` returns 0. Twelve of its thirteen tests pass no third argument at all and so inherit bun's 5000 ms default; the thirteenth carries a hand-written `30_000` with a comment explaining the full-ladder wait — the right instinct expressed as a literal rather than as a budget derived from the work. Every one of them spawns the real CLI, and several also spawn `git` through the synthetic-repo fixture, so the default has no relationship to what they do. That is precisely what ISC-266 names, and this file predates it. **The evidence, stated with its limits.** Observed locally: run alongside two sibling `down` files, five of its tests failed with their subprocesses dying at `git init` exiting 143 (SIGTERM) around 5040 ms — the timeout, not the work — while the same file alone passed 13/13. That measurement was taken at load average 122 on a 14-core machine, far past the 18.40 ISC-266 recorded, so it is INDICATIVE of the failure mode rather than proof of a CI failure. The criterion does not rest on it: a file of subprocess-spawning tests inheriting a default with no derived budget is the defect whatever a loaded box happened to show, and the `load` job exists to make that consequence reproducible rather than anecdotal. **What closing it costs.** Counting the spawns each test actually performs and passing `cliBudget(n)`, per that helper's own instruction to count rather than estimate — the four-spawn test it was written for was first recorded as two. No assertion changes.

- [ ] ISC-276: A path accepted over the control socket cannot direct a worker's write outside a defined permitted set. **[FILED OPEN 2026-08-20 by the ISC-234 race branch; number allocated centrally, not picked on the branch.]** **THE PROBE, binary:** send `export_html` with a `path` outside the permitted set and the reply is a refusal with no file written anywhere the path named. Today it is a success. **THE GAP.** `src/supervisor/index.ts` validates `msg["path"]` only as a non-empty string, then hands a path derived from it to Pi, which writes with Pi's authority. Anyone who can reach the control socket can therefore have Pi write any file Pi can write. The exposure is NARROW and should not be overstated: the control secret is a 0600 CSPRNG file (SRD §12.7, ISC-238), and the adversary this bounds — a worker that escaped its container — already holds Pi's authority directly, so this is a defence-in-depth control rather than the only thing standing in the way. **NEITHER WIDENED NOR NARROWED BY THE ISC-234 RACE FIX, stated explicitly so this is not read as a regression that PR introduced.** Before it, Pi received `path` verbatim; after it, Pi receives `<path>.pi-export-<uuid>.tmp` and the CLI renames onto `path`. Both are attacker-chosen, both are written with the same authority, and the set of reachable files is identical. The fix changed WHICH process performs the final write — that is what closes the late-write race — and changed nothing about which paths are reachable. **WHY IT IS FILED AND NOT FIXED HERE, which is the substance of the criterion rather than an excuse for deferring it.** A containment check is not a validation one-liner, because there is no obviously-correct set to contain to: `--html <path>` is an OPERATOR-CHOSEN destination and the ordinary use is writing a transcript somewhere the operator can open it — a desktop, a scratch directory, anywhere off the run tree. Confining it to the run directory would close this by breaking the feature. Closing it honestly needs a policy decision taken deliberately: an allowlist of permitted roots (configured where? defaulting to what?), or stage-inside-the-run-directory and let the CLI copy out to wherever the operator asked, which moves the arbitrary write to the process that already runs with the operator's own authority rather than Pi's. Either is a design with consequences for the container phase, and neither belongs bolted onto a race fix. **SIBLING CASE:** PR #34 adds this same class of control to argv. Same question — a caller-supplied string reaching a subprocess with more authority than the caller should confer — different surface, and the two should probably converge on one answer rather than two.

> **Count reconciliation, 2026-08-19 (PR #18, last in merge order).** `208/263`, recounted from THIS file after rebasing onto merged `main` (`dbf924c`) rather than incremented from any branch's own frontmatter. Arithmetic from main's `208 [x] / 47 [ ] / 3 [~] = 258`: ISC-50, ISC-51 and ISC-57 each move `[ ]` -> `[~]` (open 47 -> 44, partial 3 -> 6), and five criteria are added open — ISC-257, 258, 259, 261, 262 (open 44 -> 49). Total 258 + 5 = 263. **The closed count does not move**, and that is the part worth stating plainly: ISC-50 and ISC-51 were never `[x]` on main. Their closure lived only on the unmerged relay branch, and this PR downgrades them to `[~]` before they ever land as closed — so the correction is visible as `[ ]` -> `[~]`, not as a regression from `[x]`. A projection that assumed main already carried them closed would predict `206 [x]` and be wrong by two for exactly that reason; `git show dbf924c:ISA.md` settles it. No duplicate IDs: 255 (#16), 256 and 260 (#17), 257/258/259/261/262 (#18) are all distinct.

> **Count reconciliation, 2026-08-19 (PR #19, CI wiring).** `209/263`, RECOUNTED from this file with `grep -c`, never incremented. Arithmetic from main's `208 [x] / 6 [~] / 49 [ ] = 263`: ISC-257 moves `[ ]` -> `[x]` (closed 208 -> 209, open 49 -> 48) and ISC-262 moves `[ ]` -> `[~]` (partial 6 -> 7, open 48 -> 47). `209 + 7 + 47 = 263`. **No criteria are added and the total does not move** — this PR wires existing evidence into CI rather than making new claims, so a projection expecting the denominator to grow is wrong. **The one-up/one-partial split is the substance, not bookkeeping:** ISC-257's probes can genuinely run on a runner and now do (5 pass, 1 skip against a real daemon), while ISC-262's need an inference server no runner has, so its four probes still skip and it does NOT earn `[x]` merely for being named in a job. On IDs: a naive duplicate check reports `248` twice, but those are `ISC-248a` and `ISC-248` — a pre-existing suffixed ID present on `main`, not a collision, and deliberately not renumbered here.

> **Count reconciliation, 2026-08-19 (PR #25, ISC-266).** `214/269`, RECOUNTED from this file with `grep -c` after rebasing onto merged `main` (`a2392e9`), never incremented and never projected. Arithmetic from main's `213 [x] / 9 [~] / 47 [ ] = 269`: ISC-266 moves `[ ]` -> `[x]` (closed 213 -> 214, open 47 -> 46). `214 + 9 + 46 = 269`. **This PR adds no criteria and does not move the total** — the denominator is 269 rather than 268 because PR #24 landed first and added ISC-268, which is why the number is recounted from the file after the rebase instead of carried forward from what this branch said before it. Two things worth stating so a later reader does not have to reconstruct them. First, **the grade was applied after the evidence existed, not before**: the `load` CI job was pushed, run, and seen green (run `32291463113`) in a commit that touched no criterion, and only then was this line marked — so the `[x]` cites a run rather than an intention. Second, **PR #24 landed first** (merge `a2392e9`, adding ISC-268), so this branch was rebased onto it; the conflict was exactly the one predicted — the frontmatter line alone, resolved additively to `214/269`, with the two criteria edits merging cleanly because they touch different lines. The apparent duplicate a naive ID check reports at `248` is `ISC-248a` versus `ISC-248`, a pre-existing suffixed ID on `main`, not a collision.

> **Count reconciliation, 2026-08-19 (PR for ISC-269, the follower Ctrl-C defect).** `215/270`, RECOUNTED from this file with `grep -c` after rebasing onto merged `main` (`fa58fb9`). Arithmetic from main's `214 [x] / 9 [~] / 46 [ ] = 269`: ISC-269 is ADDED already closed (closed 214 -> 215, total 269 -> 270). `215 + 9 + 46 = 270`. **This is the rarer shape — a criterion that is filed and closed in the same PR — and it is worth being explicit about why that is legitimate here rather than a shortcut.** The defect was not discovered by writing the criterion; it was discovered by refusing to accept a test as "flaky", measured until it was deterministic, and only then written down. Filing it open and closing it in a follow-up would record a gap that never existed. The same pattern was used for ISC-267.
> **Count reconciliation, 2026-08-19 (PR for the anti-criteria batch).** `220/270`, RECOUNTED from this file with `grep -c` after rebasing onto merged `main` (`0c6fc1c`), never carried forward from what this branch said before the rebase. Arithmetic from main's `215 [x] / 9 [~] / 46 [ ] = 270`: ISC-138, 139, 140, 165 and 199 each move `[ ]` -> `[x]` (closed 215 -> 220, open 46 -> 41). `220 + 9 + 41 = 270`. **No criteria are added and the total does not move.** One of the five is a pure bookkeeping correction and is labelled as such: ISC-138's coverage already existed in `test/unit/rpc-client.test.ts` alongside ISC-137's, which had been `[x]` all along — the work here was verifying that guard actually bites, not writing it. The other four are new probes. **Every one of the five was mutation-verified before it was graded**, seven planted violations in total, because an `Anti:` criterion asserts an absence and a guard nobody has seen fail is indistinguishable from a guard that cannot fail — the same standard the strictness rule applies to a self-skipping test, reached from the other direction.
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

- **2026-08-18 — Slice 2 real per-worker git isolation: clone, not `git worktree add`, decided
  after a security spike produced a confirmed RCE.** SRD §9.2 specified linked worktrees. Two
  worktree-based designs were built and run against a real container before this decision: one
  fails outright (a linked worktree's `.git` is a pointer file resolving outside the container's
  mounts), the other works and is a confirmed container-to-host RCE (a container with write
  access to the mounted gitdir zeroed the host's `refs/heads/main` and planted an executable
  post-checkout hook that ran as the operator on their next `git checkout`). Presented to the
  user with both findings; the user chose `git clone --no-hardlinks` (plus `--single-branch`,
  origin stripped, a parent-side `worker-<id>` remote for visibility) over abandoning per-worker
  isolation entirely. `--no-hardlinks` is not a hardening extra — a bare local clone hardlinks
  object files by default, and the spike that investigated this feature destroyed this
  repository's own pack file exactly that way before the flag was added; every clone path in
  both the implementation and the test fixtures now passes it, and `test/integration/
  worktree.test.ts` pins `nlink=1` and disjoint parent/clone inodes directly rather than trusting
  clone success as a proxy. SRD §9.2 carries this as an erratum rather than a silent rewrite; see
  `## Changelog` for the full conjectured/refuted/learned record and the Slice 2 close-out below
  for verification.
- **2026-08-18 — `config.run.root` left in the schema, and now read by nothing (ISC-188).**
  Closing ISC-188 meant deciding which of two answers to the runs root is THE answer.
  `run.root` is not a different concept from `runsRoot()` — its schema default is
  `~/.pifleet/runs`, byte-for-byte what `runsRoot()` falls back to — so this was one
  concept with two spellings, unlike its neighbour `run.repo`, which genuinely means
  something else (the operator's working repository). `runsRoot()` won because `up` and
  all nine other run-dir readers already use it and because it is the only one that can
  honour `PIFLEET_RUNS_DIR`; `render` was the sole reader of `run.root`.
  The field is deliberately NOT deleted. It is `.strict()`-validated, set in
  `fleet.example.yaml:27` and documented at `Docs/SRD.md:593`, so removing it would hard-
  fail every existing `fleet.yaml` that sets it — a breaking config change, and out of
  scope for a criterion about computing a path once. That leaves it accepted, defaulted
  and unread, which is honest about today (nothing has silently changed for anyone: `up`
  never consulted it) but is not a resting state — a user who sets `run.root: /data/runs`
  gets no runs in `/data/runs` and no diagnostic. The follow-up is a decision between
  making `runsRoot()` fall back to it BELOW `PIFLEET_RUNS_DIR` (which requires `up` to
  load config before computing the root — it currently does so after) and rejecting the
  key with a named error. Filed rather than chosen unilaterally.
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

- **conjectured:** SRD §9.2 specified `git worktree add` (linked worktrees, `git worktree prune`,
  per-repo serialization) as the mechanism behind `isolation: worktree` — a worker gets its own
  branch and its own tree, and a linked worktree is the obvious way to give it one without a
  full clone's cost.
  **refuted by:** a security spike that built and ran two `git worktree add`-based designs against
  a real container, not merely reasoned about them. Mounting only the linked worktree directory
  fails outright: a linked worktree's `.git` is a FILE holding a `gitdir:` pointer into the
  parent's `.git/worktrees/<name>`, a path outside anything the container's mount table can name,
  so git inside the container answers `fatal: not a git repository` and the worker cannot commit
  at all. Also mounting the gitdir at its real host path to fix that makes it work — and is a
  confirmed container-to-host remote code execution: from inside the container the spike zeroed
  the host's `refs/heads/main` and planted an executable `.git/hooks/post-checkout` that ran as
  the OPERATOR'S host user on their very next ordinary `git checkout`.
  **learned:** §9.1's "two nested boundaries" table treats the container and the worktree as
  independent controls, but they are not independent when the worktree mechanism's own control
  file (`.git`) is a pointer that must resolve OUTSIDE the container to work at all — mounting
  what makes it resolve hands the confined party write access to the confining party's hook
  directory, and the outer boundary dissolves. A design has to be run against a real container to
  find this; reading `git worktree add --help` does not surface it.
  **criterion now:** `run/worktree.ts` implements `isolation: worktree` as `git clone
  --no-hardlinks --single-branch --branch <the operator's checked-out branch>` per worker, with
  `origin` stripped immediately after (so the host's absolute repository path cannot be read out
  of a container-readable `.git/config`) and a `worker-<id>` remote registered in the PARENT so
  an operator can still read a worker's commits (`git -C <repo> fetch worker-<id>`) without
  leaving their own checkout. `--no-hardlinks` is independently load-bearing: a bare local clone
  defaults to `--local`, which hardlinks object files into the copy rather than copying them, and
  a worker container writing through its own "copy" then corrupts the PARENT'S object store
  through the shared inode — not hypothetical, it is how the spike investigating this feature
  destroyed this repository's own pack file, recovered via `git fetch origin --refetch` with no
  data lost. SRD §9.2 now carries this as a full erratum rather than a silent rewrite, and
  `pifleet worktrees` (new CLI command, §10) replaces the operator-visibility `git worktree list`
  used to provide, since an independent clone has no entry in the parent's worktree list at all.

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
image.test.ts`, `cli-exit-codes.test.ts`); ISC-42..43 (`adc.test.ts` — **this line originally read "ISC-41..43, 47" and that was wrong: neither ISC-41 nor ISC-47 was cited by any test in that file, and no test in it invoked `gcloud` at all. Corrected 2026-08-19; both are now `[~]` with their real, partly-local evidence stated in place**); ISC-58..68
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

### ISC-188 close-out — 2026-08-18

`render` and `up` computed the run directory independently, and the two disagreed the
moment `PIFLEET_RUNS_DIR` was set — which is how every test rig and the detached daemon
are pointed at their runs root. `up` calls `runsRoot()` (`src/cli/commands/up.ts:133`);
`render` derived its own from `expandPath(config.run.root, loaded.dir)`. So the command
whose entire purpose is to say what `up` will run named an `--env-file`, an `/outbox`, a
`/skills` mount, a `cloud-allow` policy, a kubeconfig and a briefing file under a
directory no real run would ever contain. Nothing threw: a preview is only compared to
reality by a human, and only if they look.

- **Mechanism.** `renderWorker` now calls `runPaths(runId, runsRoot())` and
  `workerPaths(run, id)`, and `buildDockerArgv` takes those two structs instead of a
  run-dir string — so no mount CAN be joined at the mount site. `run/paths.ts` gained the
  four per-worker container inputs (`envFile`, `systemAppendMd`, `cloudAllow`,
  `kubeconfig`) and `roleSkillsDir()`, since those were the paths render was hand-rolling.
  `config.run.root` is no longer read by anything; see `## Decisions`.
- **The old test could not have caught this.** The fixture set `run.root: ./runs` AND left
  `PIFLEET_RUNS_DIR` unset, so both sources named the same directory and all 31 tests
  passed identically against either implementation — the coverage shape ISC-66's comment
  in the same file already warns about. The fixture now sets `PIFLEET_RUNS_DIR` and points
  `run.root` at a decoy `./config-runs`, which turns five pre-existing path assertions into
  live ones.
- **Tests** — `test/unit/render.test.ts`, describe "the run directory is computed once
  (ISC-188)" (4 tests): every rendered path under `PIFLEET_RUNS_DIR` and none under the
  decoy; the four paths the criterion names asserted against the helpers the *other* side
  of each contract uses; `r.runDir` equal to `runPaths(runId, runsRoot()).root`; and a
  re-render under a second root requiring all 7 run-state host paths to follow it.
- **Mutation-verified in both directions.** Restoring the `config.run.root` derivation →
  `26 pass, 9 fail` (the 4 new tests plus the 5 pre-existing ones the decoy made live).
  Reverting the `--env-file` alone — one stray path out of eight — → `32 pass, 3 fail`.
  That narrow mutation is also what caught a weak assertion in the new suite: the
  "changing `PIFLEET_RUNS_DIR`" test was originally a prefix-swap comparison, which a
  *stuck* path passes straight through because it never moves. It now extracts the host
  paths and requires each to be under the run dir.
- **Verification:** `bun run typecheck` clean; `bun test test/unit` → **869 pass, 0 fail**
  across 43 files (three consecutive runs). One run showed the `harvest-outbox.test.ts`
  hard-link flake already recorded under `## Decisions` (2026-08-17) — same test, same
  wrong-refusal-reason symptom, green in isolation and on re-run, and this diff touches
  nothing in that path.

Progress: 194/255 → 195/255.

**PR #9 review round — 2026-08-18.** Same ProjectManager/CodeReviewer pattern as PR #7/#8:
three independent local reviewers (Claude, Gemini, Codex) against the diff, then a fourth
independent verification pass re-deriving each finding against the fix rather than trusting
the fix's own claims. All three reviewers independently converged on the same shadowed-`run`
hazard; Gemini and Codex additionally found the untested `kubeconfig` path and the
non-canonicalizing `runsRoot()` respectively (the latter reproduced live against a real
Docker daemon). Four fixes landed: the ambiguous `run` destructure in `buildDockerArgv` is
now unbound entirely (confirmed by direct compiler test — reintroducing the hazard is now a
`TS2304` compile error, not a runtime bug); the `kubeconfig` assertion now goes through
`workerPaths()` instead of a hand-rebuilt string; `runsRoot()` resolves `~` and relative
`PIFLEET_RUNS_DIR` values (verified absolute across 19 probed inputs); and role names are
now validated against `SESSION_ID_RE` at config-load time, closing a real (if narrow)
path-traversal gap a reviewer found in `roleSkillsDir()`. Verification re-ran every claim
independently — the compile-error claim, the pre/post-fix mutation deltas, and the 19-input
canonicalization sweep — rather than accepting the fix commit's word.
Filed, not fixed here (out of this PR's scope, tracked as follow-ups): `--run-id`/`--run`
accept unvalidated path segments on every command that takes them, the same traversal class
as the role-name fix but reaching further — it lets `run.root` itself escape to an arbitrary
host directory, taking the 0600 `control-auth.json` control-socket secret with it.
Test count after the fix commit (`bdd43b8`): `bun test test/unit` → **876 pass, 0 fail**
across 43 files (was 869 before this round's fixes). Mutation re-verified: restoring the old
`config.run.root` derivation → 31 pass / 9 fail on `render.test.ts` (not 26 — the fix commit
added tests of its own beyond the round-1 ISC-188 block).

### ISC-143/156 close-out — 2026-08-18

Both criteria name a SIGKILL at a *specific* point, and the only test that existed for either
slept 150ms and then killed a writer — a kill that lands wherever the scheduler puts it, proves
one of the five steps of `writeJsonAtomic`, and cannot say which. It was deleted and replaced
with ten deterministic cases, five per call site, driven by a new test-only preload
(`test/fixtures/kill-at-boundary.ts`) that wraps `node:fs/promises`'s `open` and `rename` and
makes the process kill ITSELF the instant a named step returns. Each case also asserts the trace
the fixture writes, so a case that killed at the wrong step fails rather than passing quietly.

Ran: `bun test test/unit/jsonl.test.ts test/integration/supervisor.test.ts` → **35 pass, 0 fail,
196 expect() calls** (was 26 pass). Full suite `bun test` → **1130 pass, 53 skip, 0 fail** across
75 files. `bun run typecheck` clean.

- ISC-156 — `test/unit/jsonl.test.ts`, describe "writeJsonAtomic survives a SIGKILL at every
  syscall boundary (ISC-156)", 5 cases against `writeJsonAtomic` directly. `open`: the temp file
  exists and is empty, the target is still the whole previous value. `write`: the whole body is
  in the temp, the target is still the previous value. `fsync`: body durable in the temp, the
  directory entry still names the old inode. `rename`: the commit point has passed, the target is
  the whole new value, no temp left. `dirfsync`: same, with the directory entry itself durable.
  Every case then writes a third value through the same path and asserts it lands — the orphaned
  temp a SIGKILL necessarily leaves behind (nothing runs the `unlink`) never blocks a later write,
  because the temp name carries a per-call UUID. The two payloads are deliberately different
  lengths, new one shorter, so an in-place write would leave the old tail behind and fail to
  parse at all.
- ISC-143 — `test/integration/supervisor.test.ts`, describe "epoch fence durability across a
  SIGKILL (ISC-143)", the same 5 boundaries against a REAL supervisor process killed inside the
  `await persistFence()` that precedes the prompt. Each run seeds `fence.json` as a previous
  incarnation left it (epoch 1 allocated, dispatched, settled), then dispatches a task that never
  gets an answer. Before the rename the surviving fence is byte-identical to the seed and the
  restart issues epoch 2 — correct, because that allocation's prompt was never sent; from the
  rename on the fence is durable with epoch 2 live, the restart burns it as
  `supervisor_restarted`, and the next epoch is 3. Epoch 1 — the one that *was* dispatched — is
  never re-issued at any boundary, which is the criterion. The ledger the crash cut across merges
  with zero unparseable lines, tightening the old test's "at most one".

Mutation-checked, per the discipline in `test/unit/backend-controls.test.ts`'s header. Moving
`await rename(tmp, path)` ahead of `await fh.sync()` in `writeJsonAtomic` — a real durability bug,
committing the directory entry before the data — left **29 pass / 6 fail**: the `fsync`, `rename`
and `dirfsync` cases of BOTH new blocks went red on the trace order, and nothing else in the repo
noticed, including the pre-existing "writes valid JSON and leaves no tmp file behind" round-trip
test. A second mutation truncating the body by five bytes (a classic short write) failed all five
ISC-156 cases with `Unterminated string` / `Unexpected EOF`. Both reverted; `src/util/jsonl.ts`
and `src/run/state.ts` are unchanged by this work — the kill mechanism lives entirely in the test
fixture and cannot fire without `PIFLEET_TEST_KILL_AT`, which no production call site passes.

Progress: 197/255 → 199/255.

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

### ISC-232 close-out — 2026-08-18

`harness.patterns` is now a `fleet.yaml` key, and `DEFAULT_HARNESS_PATTERNS` is
what a config that says nothing falls back to. The shape is
`harness: {patterns?: string[]}` — `.strict()`, `.prefault({})`, so every
existing config keeps loading and keeps meaning what it meant.

**Config REPLACES the defaults; it does not extend them.** That is what the
criterion's "fallback, not the source of truth" asks for, and what
`harnessSurface()`'s second argument has always meant — a union invented at
the wiring layer would have left the effective surface as something no reader
could compute from the document in front of them.

- The seam was already there and already tested (`acceptance.test.ts`,
  "explicit patterns replace the defaults"); what was missing was every
  caller. `harvestTask` called `harnessSurface(paths)` with no second
  argument, so no config could reach it.
- Wired through `HarvestOptions.harnessPatterns` → `harvestTask` →
  `harnessSurfaceFor`, which owns the fallback. Not a `??` at the call site:
  `??` rescues `undefined` and `null` but not `[]`, so every caller building
  `HarvestOptions` by hand could still have handed in an empty list and got
  `touched: []` — the ISC-150 cap off, silently. Empty throws.
- **Both** readers are wired, not just `artifacts`: `report/collect.ts` takes
  `CollectOptions.harnessPatterns` and forwards it to every `harvestTask`.
  They read the same run through the same adjudicator, so leaving `report` on
  the defaults would have meant one command capping a verdict and the other
  certifying it, with the answer depending on which one an operator typed —
  a smaller copy of the exact bug this criterion names.
- **The harvest path does not resolve config from the cwd.** `up` writes the
  resolved surface into `run.json` as `harness_patterns` when the run is
  created — the technique `heartbeat_interval_ms` already uses so a config
  edited mid-run cannot retroactively change results — and
  `harvest/patterns.ts` reads it back. `null` means "config had no opinion,
  use the defaults" and is written explicitly, so a run states its surface
  either way.

  Auto-discovery was the bug, not a convenience: `resolveConfigPath` falls
  through to `./fleet.yaml` and then a machine-global
  `~/.config/pifleet/fleet.yaml`, so `artifacts`/`report` with no `--config`
  graded an OLD run against whatever file was sitting in today's directory. A
  task the ISC-150 cap had refused to certify came back `success` months
  later with nothing about the run having changed — a verdict that is a
  function of when and where the command was typed is not a verdict, and
  `harvest/index.ts` had documented that exact prohibition while the CLI
  violated it. `--config` remains as the explicit override, for a run that
  predates persistence and for previewing a candidate config; it throws on
  anything unusable, because a named file is unambiguous intent.
- A configured surface that matches NOTHING in a diff the defaults would have
  flagged is recorded as `harness.defaults_missed` and raised as a
  discrepancy. Replacement means any narrow list disables the cap for some
  diffs, and the realistic route there is not malice — `patterns: ["ci/**"]`
  is the first thing an operator who cares about CI files writes, and it
  costs them all ~91 defaults. `Bun.Glob` matches nothing for a malformed
  pattern, so a typo is invisible to any check on the list itself; only
  comparing the two surfaces over a real diff tells them apart. The verdict
  still follows the config — narrowing is a legitimate decision — but it can
  no longer happen silently.
- `report --json` carries the harness surface and any degradation in
  `collection_notes`, not only on stderr. A note that exists only on stderr is
  invisible to `report --json > out.json`, which is the one consumer `--json`
  exists for.
- `patterns: []` is a validation error rather than "match nothing". An empty
  list reads like "no opinion" and would mean the opposite: `touched` could
  never be non-empty and the ISC-150 cap would be switched off by a key that
  looks like it says nothing. Omitting the key is how you say nothing.
- Capped at `MAX_ITEMS`, not the 64 the neighbouring config arrays use: these
  strings flow into `HarnessSurfaceSchema` (also `MAX_ITEMS`), and 64 sits
  below the ~91 globs the defaults already carry, so a config could not have
  restated the list it was overriding.

Evidence — `test/integration/harvest.test.ts`, fixture `T-cfg`, whose whole
diff (`ci/grade.sh`, `src/feature.ts`) is invisible to every default pattern,
so each assertion turns on config alone. Tested through the spawned CLI, not
by importing the seam: an option with no caller is indistinguishable at
runtime from one never written, which is what left ISC-150 dead.

- no config → `patterns == DEFAULT_HARNESS_PATTERNS`, `touched == []` (the
  backward-compatibility guarantee), and a config with no `harness:` key is
  byte-for-byte the same result.
- `harness: {patterns: [ci/**]}` → `touched == ["ci/grade.sh"]` and the
  verdict is capped off `success` with a `harness` reason.
- Replacement pinned against `T-harness` (`bunfig.toml` + `sneak.ts`, matched
  by the defaults and NOT by `ci/**`): with the custom config its `touched` is
  empty. A union implementation passes every other assertion and fails this.
- `report` and `artifacts` agree on `T-cfg` in both directions, and the two
  configs produce DIFFERENT verdicts (`success` → capped), so the test cannot
  pass against a `report` that ignored config.
- Mutation-verified in both directions: reverting the `harvest/index.ts`
  wiring → `23 pass, 3 fail`; changing replace to union → `24 pass, 2 fail`;
  restored → `26 pass, 0 fail`.

Schema half in `test/unit/config.test.ts` (shape, `fleet.example.yaml` still
omits the key, empty-list rejection, strict unknown-key, and a cap that admits
the full default list) plus `harnessPatternsFromConfig`'s four cases.

Full suite: `bun test` → **1137 pass, 53 skip, 0 fail** across 75 files
(1121 → 1137, +16). `bun run typecheck` → clean.

### ISC-158 close-out — 2026-08-18

Sixteen workers, three properties, proved three different ways in
`test/e2e/scale-16-workers.test.ts` (3 tests, 363 assertions, 3.9s wall — no
Docker, no network, no GUI, so it runs in the fast `test` CI job alongside the
other e2e files).

- **Container names.** `renderAllWorkers` over a sixteen-worker config yields
  sixteen distinct `--name` values, each equal to `pifleet-<run_id>-<worker_id>`
  AND to `attended/mode.ts`'s `workerContainerName(run_id, worker_id)` — the
  duplicate spelling that file declares as consolidation debt, now pinned
  against the renderer for a whole fleet rather than one worker. Rendered
  rather than run: `render` exists so argv can be inspected without a Docker
  daemon (ISC-60), and the name is a pure function of `(run_id, worker_id)`.
  Mutation-verified: `--name` templated to emit `eng-8` for `eng-9` →
  `Expected: 16, Received: 15`. **No other test in the repo catches that
  mutation** — `bun test test/unit test/integration` stayed green under it.

- **Ports: there is no collision surface at all, and that is the finding.**
  Nothing in pifleet allocates a TCP or UDP port per worker. `buildDockerArgv`
  emits no `-p`/`--publish`/`-P`/`--publish-all`/`--expose` on any branch;
  `DockerSchema` is `.strict()` with no port key and no raw-argv passthrough;
  `docker/Dockerfile` has no `EXPOSE`; every worker attaches to one shared
  `--internal` network. The per-worker addressable resource that a port would
  have been is a UNIX domain socket — `serveJsonlSocket` calls
  `Bun.listen({unix})`, never `{port}` — named by
  `sha256(run_id, worker_id).slice(0,16)` in `run/paths.ts` rather than
  allocated from a range, so uniqueness is a property of the hash and not of a
  registry that could hand a value out twice. The test therefore asserts the
  ABSENCE holds across all sixteen rendered argvs (including that `--network`
  is never `host`, the one way "no publish flag" could still mean one shared
  port space), each with a positive control so the absence cannot be satisfied
  by an empty array. If a later phase publishes a port, that assertion fails
  and the header comment says why it was there.

- **Sockets, live.** All sixteen control sockets exist on disk and each answers
  `ping` naming the worker whose path was dialled. This is the
  `EADDRINUSE`-equivalent: `serveJsonlSocket` unlinks a stale path before
  binding, so a collision would not fail loudly — it would silently redirect
  one worker's control traffic onto another's socket, and only asking each
  socket who it belongs to catches that. Sixteen distinct supervisor pids are
  asserted too: one pid twice is the starvation hazard by construction.

- **Starvation.** A live sixteen-worker `headless` fleet against
  `pifleet-fake-pi`: `up` → sixteen concurrent dispatches → `wait --all` →
  `status` → `artifacts --all` → `down`. `eng-1` floods stderr and `eng-2`
  floods stdout with ~800KB each (twelve times the ~64KB at which an undrained
  pipe blocks the child, SRD §3.4 rule 2), paced over ~1.6s; the other fourteen
  run 50ms turns. All sixteen settle `success` at epoch 1, exit 0, all return
  to `idle`. The assertion is an ORDERING, measured from each worker's own
  dispatch ack so sixteen `bun` spawns on a loaded runner cannot masquerade as
  starvation: every quiet worker settles before either flooder does. Measured
  margin — quiet `[39,59,57,48,64,57,63,63,42,65,69,55,48,52]ms` against noisy
  `[1636,1635]ms`, a 23x separation. A quiet worker finishing while ~1.6MB is
  still moving through two other workers' pipes cannot be explained by an event
  loop those pipes were blocking.

  The structural reason it holds: one supervisor process per worker (SRD §3.3),
  each owning its own child's pipes, and `launchDetached` sends supervisor
  stdio to a FILE rather than a pipe the launcher would have to drain. Neither
  `wait` nor `status` reads `events.jsonl`, so a flooder's 800KB never enters
  the shared read path; and `settle()` awaits `writeTaskRecord` directly rather
  than through the serialized `events.jsonl` append chain, so a settle is not
  queued behind a flood of `stderr_line` writes.

- **Anti-vacuity.** The floods are verified to have HAPPENED, counted out of
  `events.jsonl` — i.e. bytes that made it through the supervisor's drain, not
  bytes the double claims to have written: ≥2000 `stderr_line` records for
  `eng-1`, ≥2000 `message_update` for `eng-2`, both files >400KB. The flooders
  must also settle, so "the quiet ones were fine" cannot describe a fleet that
  lost two workers; and `fastestNoisy > 1000ms` proves the flood was genuinely
  still in flight while the quiet workers finished.

- Mutation-verified in both remaining directions. Dropping the supervisor's
  stderr drain for one worker → `Expected: >= 2000, Received: 0`. Worth
  recording precisely: on Bun 1.3.11/macOS that mutation did **not** wedge the
  worker — it still settled — so the drained-byte guard is what catches a lost
  drain, not a hang. Making a nominally-quiet worker flood too (adding `eng-3`
  to the noisy step's `sessions`) → `Expected: < 1631.6, Received: 1647.7`,
  which is the ordering assertion failing on exactly the quantity it claims to
  measure, so it is not inert. Both mutations reverted; `git diff` over `src/`
  is empty.

- Supporting change: `test/fixtures/fake-pi.ts` gains a `sessions` step filter
  and a `noise` emit entry. Both were forced by the shape of the problem — one
  `PIFLEET_PI_COMMAND` serves an entire fleet and only `--session-id`
  distinguishes workers, so a heterogeneous fleet is not expressible from the
  launch side. `noise` on stdout emits valid `message_update` records rather
  than filler because `RpcClient` treats one unparseable line as fatal and
  kills the child; raw filler there would have measured the protocol-kill path
  instead of throughput. `test/unit/completion.test.ts`'s scenario table — which
  fails the suite for any scenario lacking a reviewed expectation — declares
  `noisy-fleet.json: [1,2,3]`, and that claim was checked, not assumed.

- `bun run typecheck` → `rc=0`, zero diagnostics. `bun test` →
  `1125 pass, 53 skip, 0 fail` across 76 files.

Progress: 197/255 → 198/255.

### PR #14 close-out — 2026-08-18

`config/render.ts` decided WHAT every worker's `docker run` would bind-mount, and nothing
created the host paths it named. On a bind mount that gap does not fail — it succeeds
wrongly. Docker creates a missing `-v` source rather than refusing, so a missing directory
arrives EMPTY and a missing FILE arrives as an empty DIRECTORY. An unmaterialized `/skills`
is a worker briefed with no skills; an unmaterialized `/policy/cloud-allow` is
`docker/verbgate` reading a directory, whose `[ -r ]` passes, whose `while read` loop yields
nothing, and whose run therefore degrades to deny-all while leaving a spurious
`cloud-allow/` behind in the run dir. Every symptom reads as model behaviour. It is the same
silent-empty-mount failure class `container/mounts.ts` exists to describe, arriving one
layer earlier.

**Closes no ISC, and none was invented to fit it.** `## Criteria` states that the mount
table's paths are computed once (ISC-188, ISC-231) and that `/skills` is read-only INSIDE
the container (ISC-29), but nowhere states that the host sources exist before `docker run` —
which is part of why the defect survived a phase that pinned everything around it. Progress
stays 200/255.

- **Mechanism.** New `src/run/materialize.ts` writes the five sources `buildDockerArgv`
  names: the outbox (0777), the per-ROLE skill bundle (dirs 0755, files 0644), a zero-byte
  `cloud-allow` (0444), the concatenated briefing (0644), and a verbatim copy of the
  configured kubeconfig (0644). Briefing existence, content and host path all come from
  `renderWorker` rather than being re-derived, so the writer and the mount cannot disagree —
  ISC-188's doctrine applied to EXISTENCE rather than to spelling. The run dirs the two
  resolve are compared as well; a disagreement would write files under one root and mount
  from another, silently. Wired into `up` after the hazard report and the model allowlist and
  before anything detached exists, so a refusal costs nothing to reap; a failure aborts the
  whole launch, with no per-worker `continue`. `fleet.example.yaml` listed `sre`, `tdd` and
  `diagnose`, none of which have a source directory, so the new refusal would have made the
  shipped example un-runnable; the lists are trimmed to the one bundle that exists.

- **Not materialized, deliberately:** `/workspace` (no per-worker worktree exists yet —
  ISC-27/ISC-28), `/sessions` (`up` creates it), the `pifleet-piagent-<id>` named volume
  (Docker owns it by construction), and the `--env-file`. The last is the asymmetry worth
  recording: an EMPTY allow list is semantically correct (authorization is task-scoped, SRD
  §5.10, so deny-all is the right run-time default and read verbs are unaffected), while an
  empty env file is semantically WRONG. Leaving that path unwritten makes a premature
  `docker run` fail loudly on a MISSING `--env-file` instead of quietly on a wrong one.

- **Review round 1 — nine findings, three independent reviewers.** The per-role skill cache
  dropped per-worker `skills:` overrides. The bundle is per-ROLE but the list is per-WORKER
  overridable, and a cache keyed on the role alone and filled from whichever worker arrived
  first gave a worker `--skill /skills/X` against a bundle with no X, made the on-disk bytes
  a function of `--workers` ORDER, and let a nonexistent bundle named only by a LATER worker
  of an already-cached role skip the missing-bundle refusal entirely — the headline control
  of the original commit, silently not firing. Bundles are now planned as the UNION across
  every named worker of a role, in a pre-pass, before anything is written. Skill names were
  unvalidated path segments, so `skills: ["../../../../victim"]` walked out of the run root
  and chmod'd a 0600 key to 0644; refused at load under the role-name grammar, checked at
  all three merge levels. Also this round: `cloud-allow` moved to 0444, because verbgate
  refuses EVERY verb (exit 78) when its policy is writable by the uid consulting it and the
  macOS VM squashes ownership to the container user; `copySkillTree` gained the
  entry/file-size/depth bounds its docstring already claimed; destination symlinks were
  being dereferenced where source symlinks were refused; `shapeOf` reported EACCES as "no
  bundle exists", a config diagnosis (exit 2) for an environment fault (exit 3); and the
  ledger sink moved to per-worker, so a failure part-way still records what already exists
  on disk.

- **Review round 2 — the previous round's headline fix rested on a false premise, and was
  removed rather than tightened.** Round 1 chmod'd `<run>/`, `<run>/workers/` and
  `<run>/workers/<id>/` on the theory that a container walks the host's directory chain to
  reach a mounted file, so a 0700 ancestor under `umask 077` would make a 0644 mount
  unreadable. It does not. A bind mount is established by the privileged runtime, and the
  containerized process reaches the path at its MOUNTPOINT inside its own mount namespace;
  it never traverses the host chain and never sees the host path at all. Verified against a
  real Linux container — direct host-path access as uid 10001 IS denied through a 0700
  ancestor, while the same file through a `-v` reads back fine regardless. The chmods
  therefore fixed nothing and cost something real, widening directories a hardened umask had
  correctly closed, and were incomplete on their own terms anyway (`~/.pifleet/runs` and
  `~/.pifleet` sit two levels further up, untouched). The regression test that pinned
  ancestor traversal was pinning the wrong thing; it now asserts that every mounted inode
  carries its explicit mode AND that every ancestor is left exactly as the umask made it —
  absence pinned as firmly as presence. The symlink guards on those same parents stay,
  because `mkdir -p` through a link is a different problem from a mode — and this round
  found that guard applied to seven destinations and not to five, the worst miss being
  `<run>/outbox/<id>`, the one path this module chmods to 0777. Round 1's 0444 `cloud-allow`
  also broke re-materialization of the same worker: `--workers eng-1,eng-1` reached the
  write twice and the second hit the 0444 the first had just set (on POSIX the OWNER of a
  0444 file cannot open it for writing either — only `CAP_DAC_OVERRIDE` bypasses the mode),
  so a typo aborted the whole fleet with an exit-3 environment diagnosis. Fixed at both ends:
  `up` dedupes, and the write is chmod-write-chmod. Finally, `assertContained` was not the
  safety net it claimed to be for `.` — `resolvedWithin` correctly reports no escape, because
  the resolved path IS the root — so a direct call copied the ENTIRE skills source into the
  bundle; it gained the grammar the schema applies. The three walk bounds, untested until now
  (multiplying all three by 1000 left the suite green), each got a test.

- **Review round 3 — that grammar fix broke a different call site sharing the same helper.**
  `assertContained` served two unrelated purposes: names an operator TYPES into config, and
  filenames `readdir` DISCOVERS inside a bundle. Applying `SESSION_ID_RE` fixed the first and
  silently broke the second, since the grammar requires a name to begin and end alphanumeric.
  A skill bundle containing a `.DS_Store` — which macOS, this project's own development
  platform, writes into any directory Finder opens — failed the entire launch with
  `skill bundle entry ".DS_Store" is not a path segment`, a config diagnosis naming a file
  the operator never configured anywhere; `.gitignore` and any name carrying a space,
  parens, `@`, `~` or a non-ASCII character were refused the same way. The per-entry check is
  now a separate `assertEntryContained`, refusing only the traversal-relevant shapes (`""`,
  `.`, `..`, a separator, a NUL) and confirming containment through `resolvedWithin`; no
  filename is special-cased and there is no junk allowlist. This round also gave `role` its
  own containment check inside `materializeRoleSkills` — defence in depth for the exported
  function's direct-call surface, where the role was the one name nothing checked while every
  skill name beside it was.

- **Review round 4 — one new hole, and two justification comments that claimed more than was
  true.** Admitting ordinary dotfiles necessarily admitted dotted DIRECTORIES with them, and
  `.git` is one: a skill source root that is a real checkout copied its whole git database
  into the directory mounted `:ro` at `/skills` and read as INSTRUCTION. Reproduced with a
  token in `.git/config`'s remote URL, which landed inside the mount verbatim — the same
  hazard `copySkillTree`'s docstring cites for refusing symlinks, reached by a different
  route. `.git` is now refused by exact name, directory or file, at every recursion depth,
  while `.gitignore` and `.gitattributes` still copy, pinned by a test so a later
  `startsWith(".git")` cannot slip in. Separately, round 3's comment claimed the role was
  already fully validated upstream; it is not, and the claim was corrected rather than left
  standing (see the follow-up below). A second comment claimed that deriving the containment
  root from the already-joined path "would pass anything" — it would not, because
  `assertContained` runs its character-class check first and that check is root-independent.
  The fixed root is still correct, on the structural ground that a trust boundary must never
  be derived from the value it is validating.

- **Filed, not fixed here (out of this PR's scope, tracked as follow-ups):**
  - **Role membership is tested against the PROTOTYPE CHAIN.** `src/config/schema.ts:357`
    uses `w.role in cfg.roles` and `src/config/load.ts:282` uses `config.roles[entry.role]`;
    `cfg.roles` comes from `z.record` and therefore carries `Object.prototype`. All TWELVE of
    that object's own property names consequently pass the ISC-68 "unknown role" refusal as
    though they were declared roles — verified by running each through `parseConfig` and
    `resolveWorker` — and such a worker silently resolves against `defaults:` instead of
    being refused. Seven of them (`constructor`, `toString`, `toLocaleString`, `valueOf`,
    `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`) also satisfy `SESSION_ID_RE`
    and go on to materialize a bundle directory named after them; the five `__`-prefixed ones
    are stopped later by the character check this PR added to `materializeRoleSkills`, which
    is a misleading materialization-time error rather than the "unknown role" one the
    operator should have seen. It is not a traversal in any case — no key of
    `Object.prototype` contains `/` or `\`, and none spells `.` or `..` — which is why it is
    a follow-up rather than a blocker. The fix is `Object.hasOwn(cfg.roles, w.role)` and
    `Object.hasOwn(config.roles, entry.role)`.
  - **The same per-entry relaxation admits other credential-bearing dotfiles.** `.git`
    arrives without anyone authoring it into a bundle, which is why it is refused by name; a
    bundle AUTHOR placing `.npmrc`, `.env` or `.netrc` beside their `SKILL.md` is a different
    question, and those now copy into the instruction mount. Recorded because this codebase
    already treats `.npmrc` as a hazard in the other direction —
    `src/harvest/acceptance.ts:122` lists it on the harness surface for its `node-options`
    primitive.
  - **`buildDockerArgv` joins `w.role` into a `-v` with no check of its own**, so the
    consistency this PR gave `materializeRoleSkills` does not yet extend to the renderer.

- **Verification.** `bun run typecheck` clean. `bun test` → **1260 pass, 53 skip, 0 fail**
  across 80 files; `test/unit/materialize.test.ts` carries 46 of them. Every fix in rounds 3
  and 4 was mutation-proved by disabling it and recording the observed failure: without the
  role check, `materializeRoleSkills` RETURNED a path outside the run root, having chmod'd it
  0700 → 0755 and copied a bundle into it; with the per-entry check reverted to
  `assertContained`, the `.DS_Store` case failed with the exact production error; without the
  `.git` guard, materialization SUCCEEDED and `.git/config` — embedded credential and all —
  was readable inside the run's `/skills` bundle.

### Slice 2 close-out — real per-worker git isolation — 2026-08-18

SRD §9.2 specified `git worktree add` per worker. A security spike, run against a real
container rather than reasoned about, disqualified it outright: mounting only the linked
worktree directory fails (its `.git` is a `gitdir:` pointer FILE resolving into the parent's
`.git/worktrees/<name>`, a path outside anything the container's mount table can name, so git
inside the container answers `fatal: not a git repository`); also mounting the parent's real
gitdir to fix that works, and is a confirmed **container-to-host remote code execution** — from
inside such a container the spike zeroed the host's `refs/heads/main` and planted an executable
`.git/hooks/post-checkout` that ran as the OPERATOR'S host user on their next ordinary
`git checkout`. Presented to the user with both findings; the user chose **`git clone
--no-hardlinks`** per worker over dropping per-worker isolation. See `## Decisions` and
`## Changelog` above for the full conjectured/refuted/learned record, and `Docs/SRD.md` §9.2
for the erratum in place of a silent rewrite of the original spec.

- **Mechanism.** New `src/run/worktree.ts`. `resolveBaseRef` refuses a detached parent HEAD
  by name rather than silently cloning the wrong commit (`git clone --branch` accepts a branch
  or tag, never a SHA). `inspectBaseRef`/`assertBaseRefCloneable` scan the ref BEFORE any clone
  exists — a submodule clones as an empty directory and LFS-tracked content clones as a pointer
  stub, both silent-wrong-answer failures a clone cannot recover from after the fact, so both
  are a named refusal rather than a warning. `createWorkerWorktrees` then, per worker:
  `git clone --no-hardlinks --single-branch --branch <parent's branch> <repo> <path>`, `git
  switch -c <branch>`, `git remote remove origin`, and registers a `worker-<id>` remote in the
  PARENT pointing at the clone — the operator-visibility substitute for what a linked worktree
  used to give for free, since `git worktree list` against the parent now shows nothing about
  workers that are independent clones. `pruneWorkerWorktree` (SRD §9.3) defines "dirty" for a
  clone with no upstream — uncommitted paths OR commits past the recorded `baseSha`, since
  `origin` is stripped and there is no "it's pushed somewhere" case to fall back on. `up.ts`
  wires `neutralizeRepoHazards` onto each finished clone (not the operator's own checkout,
  which is scan-only) — unlike a linked worktree's pointer-file `.git`, which that scanner
  explicitly declines to follow, a clone's `.git` is a real directory the scanner can act on
  completely.

- **`branch_prefix` was configured, validated, and silently ignored.** `run.branch_prefix` has
  sat in the schema since Phase 1 with a `"fleet"` default and zero readers. `createWorker
  Worktrees` called `workerBranch("fleet", …)` with the literal string hard-coded rather than
  reading `loaded.config.run.branch_prefix` — the same dead-config-field shape this ISA has
  already caught twice (`models_allowlist`, `run.root`/ISC-188). An operator who set
  `branch_prefix: experiment` got a config key that validated, appeared in
  `fleet.example.yaml`, and changed nothing: every worker still committed on `fleet/<run>/
  <worker>`. Fixed at the one call site — `workerBranch(loaded.config.run.branch_prefix,
  run.runId, workerId)` — rather than by adding a second helper, per `run/paths.ts`'s own
  stated rule that a value derived in two places eventually derives differently in two places.
  `dispatch.ts`'s envelope builder was already correct on inspection: it reads `branch` back
  from the `WorkerWorktree` record `up` wrote (`readRunWorktrees`), which is the checkout that
  actually exists, rather than recomputing the branch name itself — so once the creation-time
  bug was fixed, dispatch's envelopes were automatically right with no second change. Both
  `test/integration/worktree.test.ts` (`branch_prefix is honoured end to end`) and
  `test/integration/down-prune.test.ts` (`dispatch names the checkout that actually exists`)
  assert the actual git branch a non-default prefix produces, not merely that the config field
  parses.

- **The `origin`-strip fix was already solid, not merely passing by accident.** Traced the
  "origin strip" reference in the prior progress note to `createWorkerWorktrees`'s `git remote
  remove origin` call (worktree.ts) and to a dedicated regression test, `the clone is
  self-contained > origin is stripped and the host repo path does not survive in the config`
  (`worktree.test.ts`), which asserts BOTH `git remote` prints nothing AND the literal host
  repo path is absent from `.git/config` — not just that the command exited 0. Reverting the
  `remote remove` call makes that test fail on the first assertion; the second guards against a
  narrower fix (e.g. renaming the remote) that would still leak the host path. Nothing further
  was needed here.

- **Hardlink safety, re-verified independently of the pinned test.** Per the standing
  constraint that a prior spike using local-path clones WITHOUT `--no-hardlinks` corrupted this
  repository's real object store, every clone path — implementation (`run/worktree.ts`) AND
  every test fixture (`test/fixtures/synthetic-repo.ts`, which never clones anything and only
  ever `git init`s a fresh temp repo) — was re-audited for the flag before this slice was
  considered done. Beyond the suite's own `--no-hardlinks` describe block (asserts `nlink=1`
  and disjoint parent/clone inodes for every object), verified by hand against a disposable
  synthetic repo under `/tmp` (never `~/repos/cmux-fleet`): `git clone --no-hardlinks
  --single-branch --branch main <src> <clone>` followed by `stat -f nlink,ino` over every file
  under `<clone>/.git/objects` showed `nlink=1` uniformly, and the clone's and source's inode
  sets were disjoint (`comm -12` on the sorted lists: 0 overlapping inodes). The real
  `~/repos/cmux-fleet` object store was checked read-only afterward — `git fsck --no-progress`
  exits 0 with no missing/corrupt objects — as a final sanity check that no step of this slice's
  work (implementation, tests, or manual verification) touched it.

- **New: `pifleet worktrees` (SRD §10), the `git worktree list` replacement.** A worker
  checkout is now an independent clone with no entry in the parent's `.git/worktrees/`, so
  `git worktree list` run against the parent answers "one worktree" regardless of how many
  workers `up` created — an operator reaching for the old habit sees nothing and could
  reasonably read that as "no workers running," which is wrong while a run is live. The new
  command reads the same `WorkerWorktree` record `dispatch` and `down --prune` already trust
  (`readRunWorktrees`) rather than re-deriving anything from git, lists every worker's branch,
  path, base sha, and remote name, and reports each checkout's state — `clean`, `dirty (N
  uncommitted path(s), M commit(s) ahead)`, or `MISSING` for one removed from disk by hand or
  by a prior prune — via `inspectCloneDirt`, the same function `down --prune` gates on. A pure
  read like `status` and `artifacts`: it exits 0 for any successfully emitted report, because a
  dirty or missing checkout is exactly the fact an operator runs it to find, not a failure of
  the command itself. `--run` and `--json` follow the same conventions as every other run-scoped
  command; `test/unit/cli.test.ts`'s ISC-14 SRD-surface check now names it.

- **Review round 1 — four independent reviewers (Claude, Gemini, Codex, and a fourth
  multi-angle pass), each probing the diff against real git rather than reasoning about it, all
  four returning CHANGES_REQUESTED with overlapping and distinct critical findings.** Every
  finding below was reproduced before being fixed.

  - **No atomicity between `git clone` succeeding and a checkout being RECORDED (Claude,
    Codex, and the fourth reviewer, independently).** `createWorkerWorktrees`'s six-step
    sequence (clone, switch, strip origin, register remote, read HEAD) recorded nothing until
    the LAST step; a failure anywhere after the clone left a real, on-disk checkout with no
    `run.json` entry, no ledger row, and a `StaleWorktreeError` on the next `up` whose own
    suggested recovery (`down --prune`) could not see it, because pruning reaps by RECORD.
    Reproduced by seeding a repo whose checked-out branch is already the exact string a
    worker's own branch would compute to, which makes `git switch -c` collide with the branch
    the clone just checked out — a git-ref-valid name the preflight below cannot catch. Fixed:
    everything after `git clone` now runs inside a `try`/`catch` that removes the clone
    directory and best-effort removes any registered remote before rethrowing, so a partial
    failure leaves NOTHING behind rather than an orphan (`test/integration/worktree.test.ts`,
    "a clone that exists but never finished setup is removed, not orphaned").

  - **`run.branch_prefix` and worker ids can produce a branch name git refuses, discovered only
    at `git switch -c` — after the clone (and, before the fix above, the orphan) already
    exists (Claude, Codex, Gemini — 3/3).** `branch_prefix` had zero grammar of its own, and
    `SESSION_ID_RE` (worker ids) permits both `..` and a trailing `.lock`. Fixed with a
    preflight, run for every wanted worker BEFORE any clone is attempted (the same "pure work
    first" rule the base-ref scan already follows): `git check-ref-format --branch <name>` on
    the exact computed branch. Delegated to git rather than hand-rolled, and to `--branch`
    mode specifically — measured directly, the bare `refs/heads/<name>` form accepts a leading
    `-` that `--branch` mode (and `git switch -c` itself) correctly refuses, because a NAME
    starting with `-` is indistinguishable from an option to the commands that consume it.

  - **`origin` being stripped does not stop the host's absolute path — or the operator's
    identity — from reaching the container (Claude, independently verified by Gemini).**
    `git clone` writes `clone: from <absolute source path>` into `.git/logs/HEAD` and
    `.git/logs/refs/heads/<base>`, neither of which `git remote remove origin` touches; the
    reflog line also carries the committer identity. `.git/config` alone — the property the
    original test asserted — is the weaker claim. Fixed: the clone's `.git/logs` is deleted
    wholesale right after `origin` is stripped (`core.logAllRefUpdates` recreates it, clean, on
    the worker's first ref update). The regression test now walks every file under `.git`
    rather than reading `.git/config` alone (`test/integration/worktree.test.ts`, "origin is
    stripped and the host repo path does not survive ANYWHERE under .git").

  - **An operator's ordinary `git add -A && git commit` embeds every worker's clone as a
    GITLINK, which then makes this module's OWN preflight refuse every future `up` with a
    "submodules present" diagnosis nobody authored (Codex, reproduced and mutation-tested).**
    Invisible in THIS repository's own development, because cmux-fleet's `.gitignore` already
    excludes `.worktrees/` — and therefore reachable by every other repository this tool runs
    against. Fixed: `.worktrees/` is now written into the operator's `.git/info/exclude`
    (idempotently, once, before the first clone) — never `.gitignore`, which is tracked
    content SRD §12.8 forbids editing. `.git/info/exclude` is untracked, local-only,
    read only by git itself — the same category of write `registerWorkerRemote` already makes
    to `.git/config`. SRD §12.8 itself is corrected by its own erratum, below.

  - **`up`'s own hazard neutralization made every clone dirty from the moment `up` finished,
    breaking `down --prune`'s core signal on essentially any real repository (Gemini,
    reproduced and mutation-tested against this exact fix).** Quarantine
    (`security/repo-hazards.ts`) neutralizes a tracked hazard file by RENAME — real,
    uncommitted change in `git status --porcelain` the instant it happens — so a clone of any
    repository with a root `AGENTS.md`/`CLAUDE.md` (common; this project's own skill-authoring
    conventions produce them) read as dirty before the worker had done anything, and
    `down --prune` refused every such worker without `--force`. Committing the change was
    considered and rejected: this module's git environment is hermetic (`HOME=/dev/null`, both
    config scopes blanked), so no identity exists to commit with, and a synthetic commit would
    have moved the exact same false positive from the working tree into `commitsAhead`, while
    also polluting the exact-diff equality ISC-90 expects. Fixed with a new
    `WorkerWorktree.baselineStatus` field and `captureWorktreeBaseline` (`run/worktree.ts`),
    called by `up` AFTER neutralization: `inspectCloneDirt` now compares CURRENT
    `git status --porcelain` against the recorded baseline rather than against assumed-empty,
    which generalizes to every present and future hazard-neutralization shape without this
    module ever enumerating them. `test/integration/up-wiring.test.ts` gained the missing
    end-to-end assertion (closing ISC-249, above) and is mutation-proved: reverting the fix
    reproduces `dirty: true, statusLines: 2` on exactly the fixture this finding described.

  - **`down --prune` treated "no supervisor ever launched" the same as "launched and
    survived the kill ladder", so a checkout orphaned by a crashed `up` was unreapable even
    with `--force` (Claude, independently reproduced by Gemini).** §9.3's refusal exists to
    protect a checkout a LIVE container is writing; a worker id with no `workers/<id>` state at
    all was never launched, so nothing was ever writing into it. Fixed:
    `stopped.has(id) && stopped.get(id) !== true` (survived the ladder) refuses; `!stopped.has(id)`
    (never launched) now falls through to the ordinary dirt check, which `--force` can
    override like any other. Two new tests in `down-prune.test.ts` cover both the clean
    (prunable) and dirty (needs `--force`) cases.

  - **`down --prune` silently exited 0 and reported `pruned: []` when the worktree record
    itself could not be read, indistinguishable from "this run truly left nothing behind"
    (Gemini, reproduced).** `readRunWorktrees` degrading to `note !== null` was logged but never
    counted as a refusal, so real clones and remotes could sit on disk with nothing left
    naming them while a script reaping runs in a loop read exit 0 as "safe to delete this run
    directory" — precisely the loop-reaper data loss this function's own comment says
    `EXIT.PARTIAL` exists to prevent, one case over. Fixed: a whole-record read failure, and
    now also a PER-WORKER one (see next item), both count toward `pruneRefusals`.

  - **One worker's malformed checkout record degraded ALL workers' records to "unreadable",
    including perfectly valid ones (the fourth reviewer).** `readRunWorktrees` parsed the
    entire `worktrees` array with one `z.array(...).safeParse()`; any single bad entry failed
    the whole array. Fixed: each entry is now parsed independently — a bad one is dropped and
    named in a new `perWorkerNotes: readonly string[]` field, every good one still reaches
    `byWorker`. `dispatch` and `down --prune` both surface `perWorkerNotes` (a ledger event and
    a refusal respectively) rather than silently losing the other workers.

  - **`dispatch`'s `branch_prefix` fix had a second gap: a worker with no checkout of its own
    (`shared-ro`, `none`) still fell back to the SCHEMA's global default rather than the run's
    actual `branch_prefix` (Claude).** The fallback chain's last link re-derived
    `DEFAULT_BRANCH_PREFIX` instead of reading what `up` actually launched with. Fixed: `up`
    now persists `branch_prefix` into `run.json` itself (the same pattern already used for
    `repo`), and `readRunWorktrees`/`dispatch` read it back. New test drives a real (minimal)
    control-socket exchange — the durable inbox record is only written on `accepted: true`, so
    proving the fallback reaches the envelope needed a dispatch that actually succeeds, not
    merely one that fails after building the envelope.

  - **`src/harvest/acceptance.ts`'s scratch clone was missing `--no-hardlinks` (Claude) —
    the ISA's own PR #14 close-out and this PR's body both claimed "every clone path... now
    passes it", which was false as stated.** This clone's source is `envelope.host_workdir` —
    the WORKER's own checkout — and acceptance commands are worker-authored by design (ISC-148
    ..151); a hardlinked scratch clone meant those commands could corrupt the worker's object
    store one hop removed from the host-corruption case this whole feature exists to prevent.
    Fixed: `--no-hardlinks` added to that `hardenedGitArgv` call.

  - **`Infinity` (an unanswerable "how many commits ahead") collapsed to JSON `null` — the
    same encoding `pifleet worktrees --json` uses for "not computed" (Claude, Codex, and the
    fourth reviewer — 3/3).** Fixed with an explicit `base_unreachable: boolean` field
    alongside `commits_ahead`, so the loudest possible dirty signal can no longer read as "no
    data" to a machine consumer.

  - **A successful-but-unparseable `git rev-list --count` collapsed to `commitsAhead: 0` via
    `NaN || 0` (the fourth reviewer).** An undetermined ahead-count silently read as "definitely
    zero", the same mistake `POSITIVE_INFINITY` two lines away exists to avoid for the sibling
    failure case. Fixed: `Number.isNaN` is checked explicitly.

  - **`pruneWorkerWorktree`'s recursive delete trusted a path read back from `run.json` with no
    containment check (Claude, Codex).** Not container-writable, but operator-editable; a
    hand-edited or truncated record could turn `--force` into an unbounded `rm -rf`. Fixed:
    gated on `resolvedWithin(join(repo, ".worktrees"), wt.path)`, refusing (as a normal
    `PruneOutcome`, not a throw) rather than deleting outside the expected root.

  - **Preflight's own `unscanned` findings — attribute files too large or too numerous to
    read — were silently dropped whenever nothing ELSE triggered a refusal (Gemini,
    reproduced).** `BaseRefFindings.unscanned`'s own doc comment says "Never silent"; a
    `.gitattributes` past `MAX_ATTRIBUTE_BYTES` declaring an LFS filter passed preflight with
    no warning at all, because `findings.lfs` can only report what the scan actually READ.
    Fixed: `assertBaseRefCloneable` now fails closed — any unscanned file is itself a refusal
    reason, not merely an appendix to one.

  - **`report/collect.ts`'s merge pre-check preferred the PARENT repository over the worker's
    own checkout for resolving a worker's branch — correct for `git worktree add` (shared
    refs), silently wrong for the clone design this PR ships (the fourth reviewer, most severe
    finding of the round).** Once `dispatch.ts` started populating `envelope.repo` with the
    parent path (rather than the literal `"unset"`), `report/collect.ts`'s pre-existing "prefer
    `env.repo`" logic activated for every worktree-isolated worker — but under the clone
    design a worker's branch is created with `git switch -c` INSIDE its own independent clone
    and never fetched into the parent, so `git -C <parent> rev-parse <branch>` fails to resolve
    it, silently degrading the merge pre-check to "branch does not resolve; nothing was
    checked" for a branch that may be perfectly clean. Fixed: the preference is reversed
    (worker's own checkout first, parent as fallback for modes with none of their own). New
    regression test builds a REAL independent clone (not `git worktree add`, which shares refs
    regardless of which path is checked and so cannot fail this way) whose branch exists ONLY
    in the clone, and asserts the merge pre-check resolves it; mutation-proved by reverting the
    fix and observing the exact reported failure.

  Filed, not fixed in this round (judged out of scope, each a narrower or more speculative
  finding than the ones above): a TOCTOU between `lstat`'s stale-directory check and the actual
  `git clone` for two concurrent `up` invocations racing the same repo+worker id; a matching gap
  where a losing racer's "remote already exists" is not recognized as retryable lock contention;
  the base-ref preflight scan running once per `up` rather than once per clone, so a branch that
  advances mid-fleet is not re-scanned for a later worker; `docker/Dockerfile`'s
  `git config --system` grant being broader (all-uid) than the single uid the container runs as;
  and `pifleet worktrees`'s per-worker git spawns running serially rather than via `Promise.all`
  (a pure-read command, unlike creation/prune, has no contention argument for it).

- **Verification.** `bun run typecheck` clean. `bun test` → **1308 pass, 53 skip, 0 fail**
  across 83 files (up from 1260/53/80 at PR #14 — 48 new tests across the review round: the
  atomicity/branch-validation/exclude/reflog/unscanned coverage in `worktree.test.ts`, the
  never-launched/unreadable-record/malformed-entry/branch_prefix-fallback coverage in
  `down-prune.test.ts`, the hazard-neutralization-baseline assertion added to
  `up-wiring.test.ts`, and the merge-pre-check regression test in `report-collect.test.ts`, on
  top of the 8 already added for `pifleet worktrees` in the prior pass). Both originally-failing
  regression tests pass: `branch_prefix is honoured end to end > a non-default prefix names the
  branch git actually checks out` and `dispatch names the checkout that actually exists >
  branch_prefix and the recorded path reach the envelope`. Most fixes in the round above were
  mutation-proved individually at the time — reverted, the exact reported failure reproduced,
  restored. **Correction (round 2, below): that claim was not true for all fourteen.** Four
  fixes (`--no-hardlinks` on the acceptance scratch clone, the `Infinity`→`base_unreachable`
  encoding, the `NaN`-collapse guard, and the prune path-containment check) shipped with no test
  that actually failed on their own revert — caught by a second review pass, not by this one.
  See below for what that pass found and how it was closed. Hardlink safety independently
  re-verified a second time after the round, against synthetic repos only; `git fsck
  --no-progress` on the real `~/repos/cmux-fleet` still exits 0 with no missing/corrupt objects.

- **Review round 2 — three more independent reviewers (Claude, Gemini, Codex again), reviewing
  round 1's FIXES rather than the original diff, all three converging independently on the same
  core defect: round 1's atomicity fix and dirty-clone fix each closed one door and left another
  open at the exact seam the first review didn't look at.**

  - **The rollback still didn't cover the one thing that actually records a checkout (Claude
    and Codex, independently reproduced; the third reviewer initially flagged the same seam
    from a stale pre-fix read before self-correcting).** Round 1's `try`/`catch` in
    `createWorkerWorktrees` closed before `created.push(record)` and `await opts.onCreated(...)`
    — and `onCreated` is the ONLY thing that records a checkout (`up.ts`'s callback writes
    `run.json` and the ledger). Worse, round 1 also moved hazard neutralization and baseline
    capture INTO that callback, ahead of the `run.json` write, specifically to fix the
    dirty-clone bug — which widened the very window the atomicity fix had just closed. A throw
    from `neutralizeRepoHazards` or `captureWorktreeBaseline` reproduced the identical orphan
    (clone on disk, remote registered, nothing in `run.json`) the round-1 fix's own commit
    message claimed was closed. Fixed: `created.push` and `opts.onCreated(...)` now run INSIDE
    the try block, so any failure anywhere in that sequence triggers the same rollback.
    Rollback ordering also tightened per a Codex recommendation: the remote is removed before
    the directory, and both cleanup steps are `.catch(() => {})`-guarded so a cleanup failure
    (EPERM, EBUSY, "no such remote") can never replace the ORIGINAL error as what propagates.

  - **The dirty-clone fix's own comparison mechanism had two false-negative classes that
    delete real worker output (Codex and Gemini, both independently reproduced against real
    git before either had seen the other's finding).** `inspectCloneDirt`'s
    `git status --porcelain` line-set comparison against a recorded baseline — the round-1 fix
    for the hazard-neutralization-dirties-every-clone bug — has two blind spots, both
    verified: (a) `git status` collapses a wholly-untracked directory into ONE line, so a file
    written beneath a directory `repo-hazards.ts` already quarantined as a unit changes
    nothing about that line; (b) `git status` reports a STATUS CODE per tracked path, not
    content, so a worker's edit to a file the baseline ALSO shows modified (a `.gitattributes`
    `repo-hazards.ts` already commented a line out of) produces the IDENTICAL status line and
    cancels out as "no change". Both reproduced directly: build a baseline with a quarantined
    directory and a quarantine-modified file, then have "the worker" add a file inside that
    directory and further edit that file — `statusLines` stays `0`, `dirty` reads `false`, and
    `pruneWorkerWorktree` deletes the checkout with no `--force` and no warning. Silent data
    loss on the exact signal `--force` exists to protect, and on any repo where
    `repo-hazards.ts` quarantines a directory or edits a tracked file in place — which is to
    say, most real repositories with a root `AGENTS.md`/`CLAUDE.md`.

    Fixed with a different mechanism entirely, not a patch to the line-diff: `WorkerWorktree`
    gained `baselineTree`, a git TREE OBJECT hash (`snapshotWorkingTree` in `run/worktree.ts`) —
    `git add -A` into a throwaway `GIT_INDEX_FILE`, then `git write-tree`, producing a full
    content digest of the entire working tree (tracked and untracked, respecting
    `.gitignore`) without ever touching the checkout's real index. `inspectCloneDirt`'s
    `dirty` decision now compares the CURRENT tree hash against `wt.baselineTree`, which is
    immune to both false-negative classes by construction (any byte anywhere that differs
    changes the hash) — verified against the exact two scratch-repo reproductions above before
    the fix was written, and again after. `git status --porcelain --untracked-files=all` is
    still captured (`baselineStatus`) and still diffed the old way, but ONLY for the
    human/JSON "N uncommitted path(s)" display count now — never for the safety-critical
    boolean. `runGit` (`harvest/git.ts`) gained an optional `extraEnv` parameter to make the
    throwaway-index technique possible without bypassing its own hardening: `GIT_INDEX_FILE`
    layers on top of `HERMETIC_GIT_ENV`, never replaces it.

  - **`worktrees: null` and `worktrees: []` still read identically to `readRunWorktrees`,
    defeating the very distinction `up.ts`'s own comment calls load-bearing (Claude,
    reproduced; chains directly with the rollback finding above — a crashed `up` leaves
    `null`, which then read as "nothing to reap" rather than "unknown").** Fixed:
    `readRunWorktrees` now branches on the key being ABSENT (a run predating this field —
    stays "nothing recorded", backward compatible) versus PRESENT and explicitly `null`
    (creation started and did not finish — now a `note`, counted as a `down --prune` refusal,
    same as an unreadable record). `up.ts`'s no-config Phase 1 path — the other legitimate
    producer of a run with no worktrees — now explicitly writes `worktrees: []` too, so it
    is not swept into the new `null` refusal by omission.

  - **The round-1 merge-precheck field swap (worker's own clone preferred over the parent —
    itself a necessary fix, see round 1 above) silently disabled sibling-vs-sibling conflict
    detection entirely (Claude and Gemini, both independently reproduced).** `checkPairwise`
    only runs `git merge-tree` between two workers sharing ONE `repo` value — true when every
    worker's `repo` was the same parent path (pre-round-1, via the literal string `"unset"`,
    which was itself already a degenerate, non-functional case — this is not a regression from
    working to broken, but from silently-broken-one-way to silently-broken-a-different-way),
    false the moment `repo` became each worker's own independent clone. Reproduced: two
    workers editing the same line of the same file, checked pairwise, report
    `conflicts_with: []` — indistinguishable, on the wire, from "checked, no conflicts",
    which was never actually computed. `conflicts_with` is an SRD §9.3 wire-contract field and
    an empty array is an affirmative claim; the same "never claim what was not computed"
    standard `checkAgainstBase`'s own docstring states for `clean`.

    Fixed to the extent scoped for this round: the skip is now EXPLICIT — each side's
    `detail` records `"pairwise check with sibling <id> not performed: different
    repositories"` rather than silently leaving `conflicts_with`/`detail` empty. **Filed, not
    fully fixed here:** actually computing sibling-vs-sibling conflicts under the clone design
    needs the parent to `fetch worker-<id> <branch>` for each sibling before diffing — the
    `worker-<id>` remote SRD §9.2 already registers is the natural place to do this from, but
    nothing wires the fetch up yet. `Docs/SRD.md` §9.3 carries this as its own erratum.

  - **A concurrency hazard in this review round itself, worth recording rather than
    quietly avoiding a mention of.** An earlier `code-review` skill invocation, launched by
    habit before the user's explicit "use CodeReviewer" instruction was followed, continued
    running as a background agent through this entire review round — including doing its own
    live `cp`-based file backup/restore mutation tests against `src/run/worktree.ts` and
    `src/harvest/acceptance.ts` WHILE this session was actively editing those same files to
    apply the round-2 fixes above. Given this repository's own history (the security spike
    that corrupted the real `~/repos/cmux-fleet` object store), any concurrent, uncoordinated
    mutation of shared working-tree state is treated as a real hazard, not a curiosity.
    Verified afterward: `git status --short` in the worktree showed exactly the files this
    session intended to have modified and nothing else, no stray `.bak`/backup files were
    left behind, `bun run typecheck` was clean, and the full suite was green (1308/53/0,
    unchanged from before the concern was raised) — the concurrent activity did not corrupt
    anything, but it was luck rather than a designed safety property, and no further
    live-file-mutating review agents were launched against this worktree after the risk was
    identified.

  - **Test coverage gap closed for two of the four fixes round 2's own reviewers found
    untested (the other two — `NaN`-collapse and the `Infinity`/`base_unreachable`
    JSON-field split — are addressed partially; see below).** `--no-hardlinks` on the
    acceptance scratch clone (`test/integration/acceptance.test.ts`, "the scratch clone
    shares no inode with the worker's own checkout" — walks `.git/objects` under
    `context.clone_path`, asserts `nlink=1` and disjoint inodes against the worker's own
    checkout, mirroring `worktree.test.ts`'s own pattern for the per-worker clone) and the
    prune path-containment check (`test/integration/worktree.test.ts`, "a record naming a
    path outside `<repo>/.worktrees/` is refused, not deleted") are now both mutation-proved:
    reverting each reproduces the exact defect the finding described. A third gap
    (`commitsAhead: Infinity` for a `baseSha` that does not resolve at all, as distinct from
    N commits ahead) is now covered at the `inspectCloneDirt` level
    (`worktree.test.ts`, "a baseSha that does not resolve at all is Infinity commits ahead,
    not zero" — constructs a `WorkerWorktree` with a deliberately bogus `baseSha` against a
    real clone) but not independently at the `pifleet worktrees --json` boundary specifically;
    left as a smaller residual gap given the JSON-serialization logic downstream of that value
    is a single ternary with no git calls of its own. The `NaN`-from-a-successful-but-
    unparseable-`rev-list`-count guard has NO new test — `git rev-list --count` does not
    fail this way under any git-level manipulation this session found, only under a stubbed
    return value, and stubbing `runGit`'s return would require an injection seam this module
    does not have. Left as defensive code without its own regression test, named here rather
    than silently left uncounted.

  - **`Docs/SRD.md` gained two more erratum blocks** (§9.3, on "confirmed dead" narrowing to
    exclude never-launched checkouts, and on the sibling-conflict-detection gap above) and a
    correction to §13's F23 row (the `index.lock`/`worktree add` contention it named no longer
    exists; the real contention point is the `.git/config` lock `registerWorkerRemote`
    already retries against). §12.8's erratum (round 1) also gained a note that its OPENING
    sentence — "Post-run, `pifleet` asserts…" — describes a runtime check that has never
    existed in `src/`, before or after this slice; the properties below it are true as static
    facts about what the code does, pinned by tests, not enforced by an assertion `pifleet`
    itself runs.

- **Verification (round 2).** `bun run typecheck` clean. `bun test` → **1311 pass, 53 skip,
  0 fail** across 83 files (one additional flaky, environment-sensitive failure —
  `logs.test.ts`'s SIGINT-follower test, exit 130 instead of 0 under system load — reproduced
  as green in isolation and confirmed unrelated: this session never touched `logs.ts` or its
  tests). `git fsck --no-progress` on the real `~/repos/cmux-fleet` re-verified clean a third
  time; `git status --short` there shows only the pre-existing untracked `.corrupted-pack-
  backup/` from the original spike, never anything this session wrote.

### Group E probe/guard close-out — 2026-08-19

Closes ISC-53, ISC-54, ISC-55, ISC-56. Adds ISC-256. Group E's remaining criteria (ISC-50,
ISC-51, ISC-57) are container-side and stay open — they need a worker actually calling oMLX
from inside the egress bridge, which is Group C/J territory, not this branch's.

**Validation.** `bun run typecheck` → `rc=0`, zero diagnostics. `bun test test/unit` →
`1006 pass, 0 fail` across 48 files. `bun test test/integration` → `340 pass, 57 skip,
0 fail` across 36 files. `PIFLEET_DOCKER=1 bun test test/integration/{image,verbgate,egress,adc}.test.ts`
→ `53 pass, 0 fail` — the exact count `ci.yml`'s guard pins, unchanged by this branch.
Live oMLX suite (`PIFLEET_OMLX=1`, against `http://192.168.86.49:8000/v1`) → `4 pass, 0 fail`.

**The handover was red, in a way the test suite could not see.** Two defects arrived with the
recovered work and both had to be fixed before any criterion could be called closed:

1. `tsc --noEmit` failed with five diagnostics in `test/unit/model-probe.test.ts`, while
   `bun test` reported the same file green — Bun strips types without checking them, so the
   suite was certifying code the project's own CI gate rejects. Root cause was
   `FetchLike = typeof fetch`, which under `@types/bun` carries the static `preconnect`
   property, making every hand-written double — the entire purpose of the type —
   un-assignable. Narrowed to the call signature the module actually uses. The remaining two
   were a `.catch()` whose `void | Error` union also concealed a real bug: had the gate ever
   failed to refuse, the test would have read `undefined.message` and reported a TypeError
   instead of the assertion failure.
2. Four tests in `test/integration/up-wiring.test.ts` failed with exit 3. `require_native_tool_calls`
   defaults to TRUE, so adding the ISC-53 gate made every `up` in that file send a real
   `tools` request to `localhost:8000` for a model called `wiring-test-model` that no server
   anywhere serves. The egress-ordering, ISC-190-allow, ISC-251-grant and §5.5-mount tests
   were failing for a reason with nothing to do with what any of them assert. Fixed by
   stating the gate's absence in the fixture (`require_native_tool_calls: false` by default,
   same convention `models_allowlist` already uses there) rather than by weakening the gate;
   the tests that DO exercise it point `base_url` at a stub they own.

**Per-criterion evidence.**

- ISC-53 — refusal proven at the CLI in `up-wiring.test.ts` → `a model that answers the probe
  with prose exits 2 and launches nothing`: real `up`, stub oMLX returning the §5.9 prose
  shape, `code === EXIT.USAGE`, stderr naming worker/model/knob, `workersDir` empty and ledger
  empty. The converse (`a model that DOES emit a native call still starts`) asserts
  `stub.requests.length === 1`, which is the assertion that dies if the gate is deleted while
  the exit code stays 0. `an unreachable oMLX exits 3, not 2` pins the class split. Mutation:
  gate → no-op ⇒ 3 of 4 red. Live positive control in `model-probe.test.ts` →
  `Qwen3.5-0.8B-MLX-bf16 → ok=true (answered with 1 native tool_call(s))`. Live prose case NOT
  reproducible — see the criterion for why, and why that is acceptable.
- ISC-54 — `the model list doctor prints is the list the server is serving`: `doctor --json`'s
  `omlx.models` set-equal to an independent `GET /v1/models`. Live: 32 models.
- ISC-55 — `the completion latency doctor prints is a real measured number`: `/models 155ms,
  1-token completion 63ms against Qwen3.5-0.8B-MLX-bf16`. Bounded-range assertion, plus
  `probe_model` identity. The no-config fallback's selection rule is asserted separately and
  ordering-independently (`the no-config fallback never picks an embedding model to chat with`)
  after a first version of that test encoded one machine's `GET /v1/models` order as a fact
  and passed locally while failing against the remote.
- ISC-56 — `an active training run refuses `up`, naming the process and the override` and
  `--i-know proceeds, warns on stderr, and records the override in the ledger`, both against a
  really-spawned decoy whose argv the real `ps` really publishes; plus `with no training run
  active, up is unaffected`, which is the one that matters daily. `mlx-training-guard.test.ts`
  spawns a real `mlx_lm.server` and asserts it is NOT matched. Mutation: scan → `[]` ⇒ 2 of 3
  red.

**An incident this work caused, recorded because the ISA is where that belongs.** The first
live run of the ISC-53/55 probes auto-selected its own model via `chatProbeModel(null, served)`
and landed on `Qwen3.5-35B-A3B-4bit` on the LOCAL oMLX, which runs with `--max-model-memory
24GB`. The server logged `Loading Qwen3.5-35B-A3B-4bit without KV headroom (need 24.93GB,
available 24.00GB)`, then SIGABRT'd inside a Metal completion handler
(`mlx::core::gpu::check_error` → uncaught C++ exception → `std::terminate`). Twice, at 05:51:52
and 05:55:46; the second landed two seconds after `Chat completion: 16 tokens in 50.92s`, which
was this branch's own native-tool-call probe. So the ISC-55 measurement destroyed the thing it
was measuring. The fix is not a bigger timeout: `test/integration/model-probe.test.ts` no
longer chooses its own workload at all — `PIFLEET_OMLX_MODEL` is required and an unset variable
fails loudly. A test suite must not pick its own GPU workload, because the set of models a
server lists is not the set it can safely load and oMLX exposes no metadata distinguishing
them. This is also the direct motivation for ISC-256.

### Group E review round 3 — correctness fixes from PR #17's security review — 2026-08-19

An independent security-focused review returned CHANGES_REQUESTED on PR #17 with two MUST
FIX and four SHOULD FIX findings. The reviewer independently re-verified the ISA arithmetic,
the exit-code routing, the guard's fail-open and the absence of credential material, and
found those clean. Both MUST FIX findings were real correctness defects, and one of them
refuted a design claim written in the module's own comment.

**Progress: 205/256 → 205/257** as this branch stood alone. **RECONCILED AT MERGE (PR #16
rebase, 2026-08-19): the merged figure is 208/258**, and neither branch's number survives —
which is exactly what the note below predicted. Recounted from the merged file rather than
added up from the two claims: `grep -c '^- \[x\] ISC-'` = 208, `grep -c '^- \[~\] ISC-'` = 3,
`grep -c '^- \[ \] ISC-'` = 47, total 258. The denominator is 256 (PR #16, including its
ISC-255) plus ISC-256 and ISC-260 from this branch. The numerator is this branch's 205 plus
PR #16's four Group D closures — five criteria closed there minus ISC-48, which #16 moved to
`[~]`, along with ISC-41 and ISC-47. `[~]` does not count toward `progress:` (see the
convention note at the head of the Criteria section, added by #16). ISC-248/ISC-248a remain
distinct criteria, so a naive unique-id count still reports one fewer than the checkbox
count. The original collision note stands as written and is left for the record: PR #18 is
still in flight against this section with ISC-257/258/259, so this arithmetic will move once
more and must be recounted from the file again rather than incremented. The PR body's
earlier "210/257" was stale on both halves and has been corrected.

**M1 — `prose` was the fall-through class, so a truncated model was blamed for it.** Any 2xx
with a non-empty `choices[]` that was not exactly `finish_reason: "tool_calls"` with calls
present became "this model answered with prose", exit 2, and the operator was told to point
the role at a different model. That swept in `finish_reason: "length"` with no tool_calls —
what a REASONING model returns when its `<think>` preamble outruns the probe's token budget,
and the budget was 200 while this host serves Qwen3.5-* reasoning models. §5.9's original
`Qwen3-8B-4bit` "prose" observation is itself consistent with truncation rather than template
incompatibility, which is worth knowing before anyone acts on it. `prose` is now identified
POSITIVELY (`stop`, no calls); truncated, filtered, unknown-reason and self-contradictory
answers land in a new `inconclusive` class at exit 3; `max_tokens` is 2048. The gate is
exactly as strict as before — `ok` is false in every one of those cases — but exit 2 is now
reserved for the cases where something in `fleet.yaml` is genuinely wrong.

**M2 — the guard's `mlx_lm.server` negative was trivially true, and the real patterns matched
the inference server.** Patterns were substring-matched against the whole `ps` command line,
so a training entry point's NAME anywhere in the line counted as a running training run.
Verified matching before the fix: an `mlx_lm.server` serving `--adapter-path
/Users/dan/out/mlx_lm.lora`, a `tail -f` of an `mlx_lm.lora.log`, and a `grep` for the
string. The first refused every `up` on a host doing exactly what the fleet requires. The
module comment asserted this could not happen ("Every pattern here has to name a training
verb"); the verb pairing is necessary but not sufficient, and the comment now says so and
explains why. Matching now also asks whether a token is the PROGRAM BEING RUN.

A note on the reviewer's suggested fix, which was directionally right and mechanically wrong:
"consider only argv[0]'s basename and the token following `-m`" would have disabled the guard
for the most common launch shape there is. macOS resolves a `#!/bin/sh` script by exec'ing
`/bin/sh <script> <args>` — measured here, not assumed — so every shebang-launched training
script, and every decoy these suites spawn, arrives with `sh` in argv[0]. The implemented
rule gates on argv[0] being a program RUNNER and then admits `-m` targets and non-flag,
non-flag-value tokens. 27-case adversarial argv corpus through the real matcher: 10 wrong
before, 0 wrong after.

**S1/S2 — two more misdiagnoses in the same function.** A timeout was reported as
`unreachable`, so the operator was told to "Start oMLX" about a server that was up and
cold-loading, which §5.9 records taking longer than the 60s budget on this host. And
`!res.ok` collapsed every non-2xx into "the server is down", including a 404 for a model the
server simply does not serve — a config error reported as an outage. Non-2xx bodies are now
read into the detail, a model-naming 404 is `model-not-found` at exit 2 with its own error
class, and the exit-3 error selects its remedy from the failure class rather than offering
one sentence that cannot be true of all of them. A bare 404 deliberately stays exit 3: that
is far more likely a wrong path than a wrong model, and blaming the model would merely
relocate the misdiagnosis.

**S3 — ISC-54/55 were `[x]` on evidence nothing could re-check.** The reviewer agreed the
live suite's self-skip is correct — CI has no oMLX and never will — so the fix was not to
force it to run but to add the half CI CAN execute.
`test/integration/doctor-omlx.test.ts` drives `doctor --json` as a real subprocess against a
loopback oMLX-shaped stub. The close-out notes for both criteria now state explicitly which
half is machine-checked on every push and which rests on a local run, rather than implying
both are covered. That accounting is the actual deliverable here; the test is what makes it
possible to write honestly.

**S4 — the mandatory gate's default was never proven to reach the CLI.** The up-wiring
fixture emitted `require_native_tool_calls` unconditionally, so no config in the file ever
omitted it and flipping the schema default from `true` to `false` left the whole file green.
Disabling the gate in the four unrelated tests remains right — they assert egress ordering,
allowlist-allow, the ADC grant and mount materialization, and making those need a live
inference server would make four unrelated controls untestable. Only the unconditional
emission was the defect. Fixed narrowly, and one new test omits the key entirely.

**Something the review did not catch, found by fixing one of its nits.** The nit was that
the "launches nothing" assertions were guarded so they passed either way. The guard the
reviewer described (`if (existsSync(run.workersDir))`) is not in this tree — the actual
spelling is `for (const runId of await readdir(rig.root))`, which asserts nothing when the
root is empty. Requiring the loop to be non-empty then turned the ISC-56 test RED, which
exposed the real defect: the MLX guard runs BEFORE `up` creates the run directory, so that
loop had been iterating zero times and proving nothing since it was written. The config
gates run after the mkdir, so an empty existing directory is the right claim there; the MLX
refusal now asserts the strictly stronger thing, that the runs root is empty. The reviewer's
inference — that the directory should not exist — was right for the MLX gate and wrong for
the ISC-53 gate, and the code is what settled which.

**LAN-move flags — filed, not implemented.** The reviewer's LAN-move section was context
only. Its first flag is now ISC-260: the probe runs from the HOST while workers reach oMLX
through the internal egress bridge, and on the current topology both resolve to the same box,
which masks the asymmetry entirely. Move oMLX to the LAN and ISC-53 can pass on the host
while every worker is denied — certifying a model no worker can use and pushing the failure
to runtime, which is the outcome §5.9 exists to prevent. ISC-256 carries a note that its
wording is adjacent to, not a duplicate of, #18's ISC-259, and that both reconcile when the
§5.9/§12 erratum lands.

**Validation.** `bunx tsc --noEmit` → rc=0, zero diagnostics (run explicitly: `bun test`
cannot see these, which is how five type errors shipped to the previous round). Mutation
evidence re-measured rather than carried forward: ISC-53's gate → no-op now turns 4 of 5 red
(was 3 of 4 before the new default test); ISC-56's scan → `[]` still turns 2 of 3 red;
M1's classification → fall-through turns 4 unit tests red; `max_tokens` → 200 turns the
wire-budget test red; the schema default → `false` turns exactly the new S4 test red;
`doctor`'s latency → a constant, and its model list → an echo of config, each turn the new
stub tests red.

**Endpoint discrepancy — flagged, deliberately NOT fixed here.** `fleet.example.yaml:46` sets
`base_url: http://host.docker.internal:8000/v1`, i.e. oMLX on the Docker host, and SRD §5.9 is
categorical about it: *"Every worker's model is served by oMLX running on the same machine as
Docker. No hosted provider is involved, in any role, ever. This is a constraint, not a
default."* But `fleet.example.yaml:50-54`'s allowlist names three models the Docker host does
not serve, all three of which exist on a different machine on the LAN (`192.168.86.49`) — so
the shipped config's model list was written against one endpoint and its `base_url` points at
another. Note also that the allowlist names `Qwen3.5-35B-A3B-8bit` while the local box has the
**4bit** build. Resolving this is a design decision about where the fleet's inference lives —
and it is not free: §12's security argument ("guards a local inference server on Dan's own
machine — carries no value off this host") and §5.9's egress posture both assume local, though
`security/egress.ts` parses the allowed endpoint FROM `llm.base_url` and would follow a change.
Left for the owner. The live tests reach the LAN endpoint through `PIFLEET_OMLX_BASE_URL`,
which changes no shipped default.

---

## 2026-08-19 — ISC-259: a trusted-LAN oMLX, and the gate that had to land first

**Progress: 209/263 → 210/267.** ISC-253 `[ ]` → `[x]`; ISC-259 `[ ]` → `[~]`; ISC-263, ISC-264,
ISC-265 and ISC-266 filed `[ ]`. Two closed, four opened, net +4 total.

**This closes the endpoint discrepancy flagged at the end of the previous entry**, which was
left for the owner and has now been decided: oMLX need not be on the Docker host, and a trusted
LAN server is sufficient. The SRD was amended to match rather than the config being bent to fit
a constraint nobody wanted.

**The order was the whole job, and it is the part most easily got wrong.** PR #18 landed a
`decide()` gate on relay targets that was vacuous *by construction* — `policyFromConfig` derived
its `llm` rule from the same `llm.base_url` the relay derived its target from, so the two agreed
without checking anything, pinned by a test literally named `DOCUMENTED VACUITY`. That vacuity
was survivable only because `omlxRelayTarget` threw unless the host was literally
`host.docker.internal`: the worst case was a port on a machine the operator fully controls. The
host pin is exactly what this change removes. Relaxing it first would have turned this module
into a TCP tunnel from a bridge running untrusted model output to an arbitrary host:port on the
operator's home LAN, established by editing one YAML string. So: **decouple, gate against
operator-written allow rules, then relax** — all three here, in that order.

**Why a new field rather than more meaning on `base_url`.** `base_url` already serves two
masters (the worker's URL and the egress policy's LLM rule). `llm.relay_upstream` is what the
RELAY dials; `base_url` stays what a WORKER dials and keeps its `host.docker.internal` pin,
because that alias is the only name resolvable on the internal bridge. The default is
`host.docker.internal:<port from base_url>`, expressed as `null` rather than a literal because
it depends on another field's value — a static default would be a second, drifting derivation
of that port. Every pre-existing `fleet.yaml` therefore behaves identically, asserted rather
than asserted-in-prose.

**Non-vacuity is a property of `relayGatePolicy`, not of the gate call.** Passing
`relay_upstream` to `policyFromConfig` would NOT have fixed anything: an operator writing
`base_url: http://192.168.86.49:8000/v1` gets an `llm` rule authorizing the very upstream under
test, and the circularity reappears through a different field. The fix is a policy containing no
config-derived host except ones the operator wrote as allow rules — a compile-time-constant host
at the listen port, plus `egress.allow`. `google_hosts` are excluded: the relay forwards no
Google traffic, so those rules must not authorize a relay target.

**Proved by mutation, because "the gate looks real" is exactly how ISC-253 stayed open across
two PRs.** Source mutated two ways: re-deriving a rule from the upstream turned **5 tests red**;
ignoring `egress.allow` turned **2 red**. The proof test holds `base_url`, `relay_upstream` and
therefore the whole target byte-identical across two configs and varies only `egress.allow` —
first asserting the targets are equal (so the difference cannot be target construction), then
that the with-entry case is ACCEPTED (ruling out the base_url pin, the parser, port validation
and `makeRule` as the refusing party), then that the without-entry case throws `rule:
default-deny` specifically rather than `invalid-host`/`invalid-port`, which would mean the gate
rejected the target's shape and never consulted the policy. A separate test drives
`ensureEgressRelay` with a recording `exec` and asserts **zero docker calls** before the refusal,
because every other assertion would stay green if the production call site were wired back to
`policyFromConfig`.

**`DOCUMENTED VACUITY` was rewritten, not left passing.** It asserted a limitation this change
removes; a green test claiming the gate is circular would actively mislead the next reader. Its
replacement pins the two facts that are now true: `policyFromConfig` still agrees with itself,
and it allows a destination `relayGatePolicy` refuses.

**Two things that would have broken quietly, both handled deliberately.** (1) `--add-host
host.docker.internal:host-gateway` becomes dead weight for an IP upstream and a *bug* for a
hostname one, because Docker's embedded DNS forwards to the host resolver and this machine's
resolver does not answer mDNS/`.local` (`macbook.local` needed `dns-sd`). Resolved on both
sides: a hostname upstream is REFUSED at `config validate` with that reason, and the flag is
emitted only when a target actually dials the Docker host — so it is never inert and never
misleading. (2) The `host.docker.internal` alias becomes a fleet-wide lie. Accepted and stated
in §5.9 rather than renamed, for two checkable reasons recorded in ISC-264; the rename is real
work across four consumers and belongs in its own change.

**SRD.** §5.9 retitled "The LLM is self-hosted — oMLX on the Docker host or a trusted LAN peer";
the no-hosted-provider prohibition is explicitly RETAINED and called out as not what was
relaxed. The verified-topology table was re-measured and per-row dated. §12.4's credential
argument was quoted, retired and restated: it was true *because* oMLX binds `127.0.0.1:8000`
(measured), and a LAN server is bound to a routable interface by definition, so the key crosses
an unencrypted LAN hop on every request and has value on one other host. Documented as an
**accepted residual** with the conditions that would make TLS *required* named up front, rather
than mitigated or quietly dropped. §12.8's reachable set gains `∪ {one LAN host:port}` and
records that this is the first time the relay WIDENS a worker's reach rather than renaming
reachability the bridge already had.

**A helper was written and then deleted.** The LAN upstream falsifies any rule that rewrites
`base_url` into a host-reachable URL, and the first pass added `hostFacingUpstreamUrl` to do it
correctly. Checking the concurrent ISC-260 work rather than assuming showed it deletes
`hostFacingBaseUrl` outright and probes from inside the egress network, dialling `base_url`
verbatim as a worker does — so the probe already follows whatever the relay forwards. The helper
was a duplicate derivation of an endpoint this file does not own, with no caller, and was
removed. Recorded because the absence is a decision.

**What is NOT proven, and why ISC-259 is `[~]` rather than `[x]`.** No test stands up a relay
dialling `192.168.86.49:8000` and confirms a container on the internal bridge reaches it
end-to-end. The endpoint facts are LOCAL measurements, reproducible only on this network, which
alone bars `[x]` under the strictness rule. Docker-gated integration evidence is owned by the
concurrent ISC-261/258 change and still describes the pre-amendment topology — §12.8's new
erratum says so explicitly rather than letting a reader assume the old numbers still hold.

**Container-guard arithmetic: unchanged at `TOTAL_EXPECTED: 72`,** re-derived rather than
assumed by running the documented command with the gate closed — `bun test
test/integration/{image,verbgate,egress,adc,relay}.test.ts` → `0 pass, 72 skip, 0 fail`. Every
test added here lives in `test/unit/relay.test.ts`, graded by the fast `test` job.

**A reporting error on this branch, corrected — and it earned a criterion (ISC-266).** The suite
run here showed `harvest.test.ts > report honours the same config as artifacts` failing, and it also
failed on a pristine `4207b89` worktree, so it was reported as a *pre-existing failure on main*. The
evidence was real; the conclusion did not follow. Running a test on a pristine checkout OF THIS
MACHINE establishes "fails here at that commit", not "fails at that commit". Checked against CI
rather than inferred: run `32268059522` on `4207b89` concluded `success`, with
`(pass) … report honours the same config as artifacts [1235.00ms]` in its log. **main is not broken.**
The accurate statement is that the test is **load-sensitive on this machine**: two sequential `runCli`
subprocess spawns inside bun's default 5000 ms budget, against 1235 ms in CI, failing 3/3 at load
average **18.40 on 14 cores** with three agents running suites concurrently. Consistent under load
rather than intermittent, which is precisely why it read as a real breakage. The conclusion that
MATTERED for this PR is unchanged and was established the same way — reproducing it at `4207b89` with
none of this branch's commits applied shows it is not caused by this change — but "main has a failing
test" and "this test is load-sensitive locally" send the next reader somewhere completely different,
and the second is what is true.
