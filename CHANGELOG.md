# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Security
- **The deny-all bridge does not deny the bridge gateway, and this branch was claiming otherwise.**
  Measured, not inferred: a container attached to nothing but the `--internal` `pifleet-egress`
  network — no `--add-host`, no second network, no capabilities, no relay running — pulls a live
  `SSH-2.0-OpenSSH_9.6p1` banner off `172.18.0.1:22`. Docker implements internal-network isolation
  as FORWARD-chain rules (`! -d 172.18.0.0/16 -i br-<id> -j DROP`), but the bridge gateway is
  on-link and inside that subnet, so traffic to it is delivered through INPUT (policy ACCEPT) and
  is never filtered. `--internal` really does remove the default route — `1.1.1.1`, the LAN oMLX
  candidate, the Lima host address and `169.254.169.254` are all genuinely unreachable — but it
  cannot filter the gateway. The prior evidence sampled two public destinations and never measured
  it. Accepted as a documented residual (SRD §12.8 erratum) rather than fixed, because closing it
  needs host-side iptables outside Docker's model, or a Docker host whose gateway serves nothing.
  The reachable set is `{relay listen ports} ∪ {gateway ports} ∪ {sibling container ports}` and is
  **not fixed** — anything the host or a sibling binds later joins it with no code change.
  ISC-51/57 are re-worded to what Docker actually guarantees (no route off the bridge *subnet*),
  ISC-50/51 downgraded from closed to partial, and the relay suite now **enumerates** the route
  table instead of sampling addresses. The gateway residual is asserted as a positive, so hardening
  it later turns that test red and flags §12.8 as stale rather than drifting silently.
- **The oMLX API key no longer travels in `docker run` argv.** The live relay probe interpolated
  the real key into a shell string passed as arguments — visible in `ps`, in the ephemeral
  container's `docker inspect`, and in any CI log that echoes commands. It is now passed by name
  and expanded inside the container. No leak occurred, because that test has only ever run on one
  machine; it would have become a live exposure on the first CI run with a real secret.
- **The relay container is pinned by image digest.** It bridges the deny-all bridge to a NAT'd
  network under `--restart unless-stopped`, and it was pulling a floating Docker Hub tag — so the
  code on that boundary could change under a machine reboot with no commit in this repo.
- **The relay applies the egress policy instead of re-deriving it.** `omlxRelayTarget` pinned the
  host but read the port straight from `llm.base_url` with nothing comparing it to `decide()`, so
  `http://host.docker.internal:22/v1` produced a relay tunnelling the bridge to the host's sshd.
  Targets are now gated through `decide()` before argv is built. The gate is still circular today
  (the policy's LLM rule derives from the same field) and a test says so by name; its value is the
  seam it creates for the pending off-host oMLX move, where it becomes blocking.
- **One idle container could deny the whole fleet its model server.** The relay dialled upstream on
  accept, before any byte arrived, with no timeouts and no connection cap: 300 client connections
  sending zero bytes took it from 19 open FDs to 619, with 603 matching unauthenticated connections
  against oMLX. Upstream is now dialled on first byte, both legs carry idle timeouts, and
  concurrency is capped. Also: only a listen failure is fatal (an accept-time EMFILE used to
  crash-loop the relay and cut model access fleet-wide), the relay gets the same pids/memory/cpu
  limits as the workers it shares a bridge with, IP forwarding is turned off in its netns, and the
  ports in its own env parsing are range-checked — `listen(0)` would have bound a random port and
  reported healthy.

### Added
- **`up` now refuses to start a fleet on a model that cannot emit native tool calls**
  (SRD §5.9 F39, ISC-53). Whether a model answers a `tools`-bearing request with `tool_calls`
  or with prose is a property of its chat template, not of oMLX — and a worker on such a
  model looks perfectly healthy while accomplishing nothing, because its intended actions
  never become tool calls. `up` sends one probe per distinct resolved model (deduped: six
  workers on one model is the normal fleet shape, and six real generations to learn one fact
  would be a tax on every launch) and refuses with exit 2. An oMLX that cannot be reached
  exits 3 instead — nothing has been learned about the model, so reporting it as a usage
  error would send the operator to edit a `model:` line that is probably correct.
  `llm.require_native_tool_calls: false` disables the gate. Exit 2 is reserved for the two
  cases where something in `fleet.yaml` is genuinely wrong — the model answers in prose, or
  the server does not serve it. An answer that settles nothing (truncated, filtered, an
  unknown finish reason) exits 3, because a probe that failed to get an answer is not
  evidence about the model.
- **`up` now refuses to start while an MLX training run appears to be active**, unless
  `--i-know` is passed (ISC-56). §5.9 records concurrent heavy GPU load on this machine
  turning a process OOM into a kernel watchdog panic, which costs the training run as well as
  the fleet. Detection is an explicitly documented heuristic over `ps`, and it asks two questions
  rather than one: is this token a training entry point — `mlx_lm`/`mlx-lm`/`mlx.`/`mlx_vlm`
  paired with a training verb (`lora`, `train`, `fuse`, `dpo`, `sft`, `grpo`, `orpo`,
  `finetune`), never `server` or `generate` — and is this token the PROGRAM BEING RUN. The
  second question is what keeps a filename from counting as a process: matching the name
  anywhere in the command line refuses `up` on a host merely SERVING a LoRA adapter, or
  tailing a training log, and the oMLX inference server every fleet requires is exactly the
  thing that gets hit. An override is recorded both on stderr and in the run ledger
  (`mlx_training_guard_overridden`), so a run that raced a training run says so in its own
  record months later.
- **New criterion ISC-256**: `doctor` should report whether each `models_allowlist` entry is
  actually served by the configured endpoint. `fleet.example.yaml`'s allowlist names three
  models the default `base_url` serves none of, and nothing reports that today — the
  allowlist check is config-vs-config, and the tool-call probe only touches models a worker
  resolves to. Its wording is adjacent to, not a duplicate of, the criterion added on the
  sibling branch, and both reconcile when the SRD §5.9/§12 erratum lands — see the ISA entry.
- **New criterion ISC-260**: the native-tool-call probe should run from INSIDE the egress
  network the workers use, not from the host. `up` probes from the host today while workers
  reach oMLX through the internal bridge; both currently resolve to the same box, which masks
  the asymmetry. If oMLX moves off the Docker host, ISC-53 can pass on the host while every
  worker is denied — certifying a model no worker can use and pushing the failure to runtime,
  which is what §5.9 makes the probe mandatory to prevent.

### Fixed
- **Every `gcloud` call in a worker crashed on a read-only filesystem, with a perfectly
  good credential in hand.** The image bakes `CLOUDSDK_CONFIG=/home/pi/.config/gcloud` as
  an ordinary directory on the root filesystem, and SRD §5.6 launches with `--read-only`
  and only `/tmp` as tmpfs — so gcloud could not write its own config and died with
  `ERROR: gcloud crashed (OSError): [Errno 30] Read-only file system:
  '/home/pi/.config/gcloud/configurations'`, exit 1, empty stdout. It read as a broken
  credential rather than a missing mount. `buildDockerArgv` now mounts the tmpfs §5.2
  always described. Every option on it is measured rather than copied from `/tmp`'s line:
  `uid`/`gid` are required (without them the tmpfs is root-owned, gcloud hits EACCES
  instead of EROFS, *tolerates* it, and exits 0 while warning on every call and caching
  nothing — the broken version looks like it works), and `size=16m` is roughly 4,000 gcloud
  invocations of headroom at a measured ~4 KB per call. A separate tmpfs rather than
  repointing `CLOUDSDK_CONFIG` at `/tmp`, because the injected token lives in `/tmp` and
  gcloud's unbounded log growth would otherwise eat the space the refresh needs.
- **The ADC test suite had the same defect, which is how it survived.** Those tests added a
  `$CLOUDSDK_CONFIG` tmpfs of their own to every container they built, so five
  already-closed criteria were being probed in a shape `pifleet up` cannot launch. The
  fake tmpfs shadowed gcloud's real credential store — neutralising the exact vector the
  `cloud_access: false` criteria exist to disprove — and made the "no refresh_token
  anywhere on the filesystem" sweep search an empty overlay instead of the directory gcloud
  actually writes into. Tests now build the production shape from production's own exported
  flags; deviations are opt-in and default off.
- **Mounting `$HOME` handed a worker the entire multi-account gcloud auth store, and every
  assertion passed.** The "host `~/.config/gcloud` is never a mount source" checks asked
  only whether a source *was* that directory or sat *under* it — never whether it
  *contained* it. `run.repo` is operator-configurable and is mounted at `/workspace`, so
  `run.repo: ~` was a supported config that did exactly this. Worse, the unit-level check
  routed through a helper that drops every `/workspace` mount, so it was structurally blind
  to the one mount that could cause it. All three relations are now covered by a single
  production predicate, and `buildDockerArgv` calls it on the argv it is about to launch —
  so this is enforced at launch rather than asserted about afterwards.
- **The printed grant line could name an identity the worker was never given.** Identity
  was resolved from `gcloud config get-value account` (the `gcloud auth login` account),
  but tokens are minted from ADC and `file` mode hands over
  `application_default_credentials.json` — separate stores, written by separate commands,
  which routinely disagree. Resolution now prefers the ADC file's own principal and falls
  back to the config account only when the file cannot name one. That fallback is
  load-bearing, not decorative: measured here, `gcloud auth application-default login`
  wrote `"account": ""`, present and empty.
- **A live refresh token was mounted into a container with full network egress.** The
  file-mode test mounted the operator's real ADC — refresh token included — into a
  container started with no `--network` at all, on the default bridge, in an image that
  ships `curl`. Containers in that suite now default to `--network none`, which also closes
  the GCE metadata-server fallback as a credential vector. Measured: every probe passes
  without a network, because minting happens on the host.
- **A failing container probe produced a red CI step with no output whatsoever.** `set -eu`
  around `out="$(bun test ...)"` aborts at the assignment, so the `echo "$out"` on the next
  line never ran — no test names, no stack, not even the `::error::` lines. The guard also
  never parsed `fail` or `todo`, and since a failure *shortens* the collected total it
  reported real failures as "update TOTAL_EXPECTED if probes were added" — advice that
  papers over the exact regression the job exists to catch. Failures and todos are now
  checked first and reported as themselves, and the skip set is pinned BY NAME rather than
  by count, so converting an unrelated probe to `.skip` while un-skipping a credential
  probe can no longer keep the arithmetic green.
- **The MLX training guard refused `up` on a host that was merely SERVING a fine-tune.**
  Patterns were substring-matched against the whole `ps` command line, so a training entry
  point's name anywhere in the line counted as a running training run. All three of these
  were verified matching: an `mlx_lm.server` started with `--adapter-path
  /Users/dan/out/mlx_lm.lora`, a `tail -f` of an `mlx_lm.lora.log`, and a `grep` for the
  string. Serving a LoRA adapter out of a directory named for the entry point that produced
  it is the ordinary way to serve a fine-tune, so the guard refused every `up` on a correctly
  configured host — the exact failure the design was written to avoid, and which the module's
  own comment asserted was impossible. Matching now considers only tokens that name the
  program being run. This also closed four false negatives: the `mlx_lm/lora.py` venv script
  form, the `grpo`/`orpo`/`finetune` verbs, `mlx_vlm` training, and uppercase spellings.
- **A model whose answer was cut off got blamed for not supporting tool calls.** `prose` was
  the fall-through class of the native-tool-call probe, so any 2xx that was not a well-formed
  tool call became "this model answered with prose", exit 2 — including `finish_reason:
  "length"` with no tool_calls, which is what a reasoning model returns when its `<think>`
  preamble outruns the probe's token budget. The budget was 200. `prose` is now identified
  positively (a completed generation that produced no call), everything inconclusive exits 3,
  and the budget is 2048.
- **A slow oMLX was reported as a dead one.** A probe timeout was classified `unreachable`
  and the operator was told to start a server that was already running and cold-loading their
  weights, which §5.9 records taking longer than the 60-second budget on this host. Timeouts
  now carry their own message and advise waiting for the load.
- **A model the server does not serve was reported as an outage.** Every non-2xx collapsed
  into "oMLX unreachable", so a 404 for a missing model — a `fleet.yaml` problem — sent the
  operator to restart a healthy server. Non-2xx response bodies now reach the operator, and a
  404 that names a model exits 2 as the config error it is. A 404 with no such body stays
  exit 3, because that is far more likely a wrong URL path than a wrong model.
- **`hostFacingBaseUrl` corrupted URLs that merely contained the container hostname.** It was
  a substring `.replace()`, so `https://host.docker.internal.example.com/v1` and
  `http://proxy:8000/host.docker.internal/v1` were both rewritten into endpoints nobody
  configured — and the resulting failure read as "oMLX is down". It now parses with `new URL`
  and swaps the hostname, matching what `security/egress.ts` already does with the same field.
- **`doctor` reported no oMLX latency at all on the invocation that most needs it.** With no
  config it probed `models[0]`, and on a server whose model list begins with an embedding
  model that completion returns HTTP 500 — so `completion_latency_ms` came back `null` and
  ISC-55's number went unreported on exactly the run someone makes when they have no config
  yet and are trying to size `max_concurrent`. The no-config fallback now skips models whose
  ids name themselves as embedding models; a configured `llm.model` is still used verbatim,
  because second-guessing the operator would report a latency for a model no worker runs.
- **`tsc --noEmit` failed on the model-probe tests while `bun test` reported them green.**
  Bun strips types without checking them, so the suite was certifying code the project's own
  CI gate rejects. `FetchLike` was `typeof fetch`, which under `@types/bun` carries the static
  `preconnect` property and makes every hand-written test double — the entire point of the
  type — un-assignable; it is now the call signature the module actually uses. A related
  `.catch()` returning `void | Error` would additionally have thrown a TypeError instead of an
  assertion failure had the gate ever failed to refuse.
- **Adding the ISC-53 gate broke four unrelated `up` integration tests.**
  `require_native_tool_calls` defaults to true, so the egress-ordering, allowlist-allow,
  ADC-grant and mount-materialization tests all began sending a real `tools` request to
  `localhost:8000` for a model no server serves, and failed with exit 3 for a reason having
  nothing to do with what any of them assert. The fixture now states the gate's absence
  explicitly (the same convention `models_allowlist` already used there) rather than the gate
  being weakened; the tests that do exercise it point `base_url` at a stub they own.
- **The relay suite's deny-half assertions could pass having proven nothing.** The probe helper
  returned `stdout + stderr` and never checked the exit code, so a failed `docker run` returned an
  error message — and `expect(x).not.toContain("ip=0")` is true of every error message ever
  written. That was the whole of ISC-51/57's evidence. The helper now throws on a non-zero exit and
  the negatives became positives. Two further bugs were caught by the new socket-level suite that
  this made possible: a lazy-dial ordering bug that deadlocked every relayed connection
  (`pause()` before `once("data")` never fires), and an incomplete half-close fix —
  `allowHalfOpen` must be set on **both** legs, or Node ends the writable side on FIN and tears the
  socket down before any handler can forward it.
- **The only test proving crash-recoverability of atomic writes was stochastic** — it
  killed a writer process ~150ms into a loop, proving one of five syscall boundaries at
  random and never saying which. Replaced with deterministic per-boundary tests
  (open/write/fsync/rename/dir-fsync) against both `writeJsonAtomic` and the supervisor's
  fence-persist path, using a test-only self-kill fixture with no production-code changes.
  Found and fixed along the way: `up`'s idle-gate wait only checked `state.json`'s `phase`
  field, which outlives the process that wrote it — a supervisor that reached idle and
  then died (SIGKILL/OOM) left a file reading "idle" forever, so `up` could report a dead
  fleet as successfully started. Now checks the recorded pid is actually live.
- **A harvest re-run months later could grade a task against whatever `fleet.yaml`
  happened to be sitting in the current directory that day.** `artifacts`/`report`
  auto-discovered config from cwd when no `--config` was given, so the harness-pattern
  surface a run was graded against was a function of when and where you happened to run
  the harvest command, not of the run itself. `up` now persists the resolved harness
  patterns into the run directory at launch time (the same pattern already used for the
  heartbeat interval); harvesting reads that persisted value, and cwd/global config
  auto-discovery is no longer consulted on the harvest path at all.
- **`render`'s preview could name a different run directory than `up`'s real launch.**
  `render` computed the run root from the config file's `run.root` field; `up` always used
  `runsRoot()` (which honors `PIFLEET_RUNS_DIR`). Whenever that variable was set — every test
  rig and the detached daemon — the two disagreed on where the `--env-file`, `/outbox`,
  `/skills`, `cloud-allow` policy, kubeconfig, and briefing mount would land. `render` now
  builds every one of those paths through the same `RunPaths`/`WorkerPaths` structs `up`
  uses, so a mount path can't be computed twice in two places by construction. `runsRoot()`
  also now resolves `~` and relative `PIFLEET_RUNS_DIR` values, and role names are validated
  against a safe identifier pattern (closing a path-traversal gap that let a role literally
  named `../../etc` mount a host directory read-only into a worker container).
- **A chunk containing a fatal error kept dispatching the lines after it.** `RpcClient.feed()`
  and `feedText()` now share one line loop that re-checks `#closed` between lines, so nothing
  past the fatal line in the same chunk reaches a handler.
- **An EPIPE write left the client silently open.** The `send()` EPIPE catch now calls
  `close()`, so a dead pipe is reported as closed instead of one request failing while the
  object still accepts feeds and further sends.
- **An undiagnosed internal error and a usage error shared an exit code.** New `EXIT.INTERNAL`,
  ranked first in the severity ladder.
- **A negative, fractional, or unsafely-large `epoch` silently allocated a fresh one instead of
  failing.** New `MalformedEpochError`; the bound is `Number.isSafeInteger`, not
  `Number.isInteger` — a value at or past `2**53` could never advance the fence.
- **A stale worker image could be silently reused after the Dockerfile — or the files it
  `COPY`s — changed.** The image tag's config hash now covers `docker/Dockerfile`,
  `docker/verbgate`, and `docker/entrypoint.sh`, not only `pi_version` / `toolchain` /
  `apt_packages`. A structural test asserts every `COPY` source in the real Dockerfile is
  accounted for.
- **A backslash in an envelope path passed the control-character filter.** Harmless on POSIX,
  a path separator elsewhere; now refused independently of the control-character check.
- **An unreadable `docker/Dockerfile` was reported as an internal pifleet bug (exit 8) instead
  of a fixable environment problem (exit 2).** `doctor` also no longer aborts its entire probe
  when one toolchain's image tag can't be computed — it reports a diagnosis row instead.
- **The `models_allowlist` gate could be silently bypassed by an unrelated config error.** A
  worker resolution failure now propagates instead of being treated as "nothing to check."
- **On the cmux backend, every pane's viewer failed to attach and its tab never showed the
  worker id.** `respawn-pane`/`rename-tab` need a `--workspace` argument on cmux 0.64.22 that
  this client never sent, so both calls failed against a surface id `new-split` had just
  returned (`Surface not found`/`Tab not found`). Fixed; `pifleet up --backend cmux` now shows
  live worker activity in each pane as designed. A pane id recorded by a pifleet build
  predating this fix (persisted in `presentation.json`) is now refused with a named,
  actionable error on `attach`/`tui` instead of an opaque parse failure.
- **`doctor` could report a healthy tmux as absent.** An unparseable version banner was
  folded into "below the floor," silently flipping `backends.tmux` to `false` with no
  diagnosis even when `up --backend tmux` would launch fine against the same binary.
  Diagnoses now carry a `class` (`missing-binary` / `wrong-version` / `absent-daemon` /
  `misconfigured`) so an unreadable banner can no longer masquerade as a real failure.
- **`run.branch_prefix` validated, defaulted, documented — and read by nothing.** Every
  worker's checkout branch was hard-coded to `fleet/<run>/<worker>` regardless of what an
  operator configured, the same dead-config-field shape `models_allowlist` and `run.root`
  were each caught in. Fixed at the single call site that names the branch
  (`workerBranch(loaded.config.run.branch_prefix, …)` in `run/worktree.ts`); `dispatch`'s
  envelope builder was already reading the branch back from what was actually checked out
  rather than recomputing it, so it needed no change once creation was fixed. A second gap
  in the same fix: a worker with no checkout of its own (`shared-ro`, `none`) still fell back
  to the schema's global default rather than the run's actual prefix, because the fallback
  never had anywhere to read it from — `up` now persists `branch_prefix` into `run.json`
  itself, the same way it already does for `repo`.
- **A per-worker checkout could clone successfully and then be lost, unrecorded, if any step
  after the clone failed** — `git switch -c`, stripping `origin`, registering the parent-side
  remote, or reading back `HEAD`. The clone directory stayed on disk with no `run.json` entry
  and no ledger row, invisible to `down --prune` (which reaps by record) and blocking every
  later `up` at that path with `StaleWorktreeError` — whose own suggested recovery,
  `down --prune`, could not see the very thing it was supposed to reap. Everything after the
  clone now runs inside a rollback: on any failure the checkout directory and any
  partially-registered remote are removed before the error propagates. The likeliest cause is
  independently closed: `run.branch_prefix` and worker ids reach `git switch -c` with zero
  validation of their own, so a value like `"my prefix"`, `"a..b"`, `"x.lock"`, or a leading
  `-` produced a branch name git refuses — after the clone already existed. Every wanted
  worker's branch name is now checked with `git check-ref-format --branch` before any clone is
  attempted, matching the "pure work first" refusal the submodule/LFS preflight already uses.
- **`git remote remove origin` did not stop the host's absolute repository path — or the
  operator's identity — from reaching the container.** `git clone` also writes
  `clone: from <absolute source path>` into `.git/logs/HEAD` and
  `.git/logs/refs/heads/<branch>`, both inside the mount and untouched by removing the
  remote; the reflog line carries the committer's name too. The clone's `.git/logs` is now
  deleted immediately after `origin` is stripped — git recreates it, clean, on the worker's
  first ref update.
- **An operator's ordinary `git add -A && git commit` embedded every worker's clone as a
  GITLINK**, because an un-ignored nested `.git` directory reads to git as a candidate
  submodule rather than as content — which then made the submodule/LFS preflight refuse
  every SUBSEQUENT `up` with a "submodules present" diagnosis the operator never authored.
  `.worktrees/` is now added to the operator's `.git/info/exclude` (idempotently, once, per
  repo) — never `.gitignore`, which is tracked content this project's own containment rule
  forbids editing; `.git/info/exclude` is untracked, local-only bookkeeping in the same
  category as the `worker-<id>` remote this feature already writes to `.git/config`.
- **`up`'s own hazard neutralization made a worker's clone read as dirty from the moment `up`
  finished, on any repository with a root `AGENTS.md`/`CLAUDE.md`.** Quarantining a hazard
  renames a tracked file, which is real uncommitted change in `git status --porcelain` from
  that instant — so `down --prune` refused essentially every such worker without `--force`,
  for work the worker never did. `up` now captures a `git status` baseline immediately AFTER
  neutralization finishes, and every later dirt check compares against that baseline instead
  of assuming a clean start — generalizing to any hazard-neutralization shape without having
  to enumerate them.
- **`down --prune` treated a checkout whose supervisor never launched at all the same as one
  that survived the kill ladder, refusing to prune it even with `--force`.** The two are not
  the same fact: §9.3's refusal exists to protect a checkout a LIVE container is still
  writing to, and a worker id with no supervisor state was never written to by anything. A
  never-launched checkout — the shape a crashed `up` leaves behind — now falls through to the
  ordinary dirt check like any other, and `--force` works on it exactly as it does elsewhere.
- **`down --prune` silently exited 0 and reported `pruned: []` when the checkout record
  itself could not be read**, indistinguishable from "this run truly left nothing behind" —
  exactly the loop-reaper data-loss shape this command's own `EXIT.PARTIAL` policy exists to
  prevent, one case over. An unreadable record — whole or, now, per-worker (one malformed
  entry no longer blinds every other worker's perfectly good one) — is a refusal, not silence.
- **`pifleet report`'s merge pre-check silently stopped working for every worktree-isolated
  worker** the moment `dispatch` started recording the parent repository in the envelope.
  `report/collect.ts` preferred the parent over the worker's own checkout for resolving a
  worker's branch — correct when isolation meant `git worktree add` (shared refs), false
  once it means an independent clone whose branch is never fetched into the parent. Reversed:
  the worker's own checkout is preferred, with the parent as a fallback only for modes with
  no checkout of their own.
- **`src/harvest/acceptance.ts`'s scratch clone — of a worker's own checkout, to run
  worker-authored acceptance commands in — was missing `--no-hardlinks`**, one hop removed
  from the exact object-store corruption class this slice's core safety property exists to
  prevent.
- **`Infinity` commits-ahead (history rewritten past `baseSha`) serialized to JSON `null`** —
  the same encoding `pifleet worktrees --json` uses for "not computed", collapsing the
  loudest possible dirty signal into the wire value for "nothing to report." Carried as its
  own `base_unreachable` boolean now. A related, narrower bug in the same function: a
  successful but unparseable `git rev-list --count` collapsed to "0 commits ahead" via
  `NaN || 0` instead of the same unknown-is-not-zero treatment its sibling failure case
  already got.
- **A submodule/LFS preflight scan that could not fully read every `.gitattributes` file
  (too large, too many) silently ACCEPTED the ref when nothing else tripped a refusal** —
  the "not fully scanned" record existed but was only ever surfaced inside an error message
  that never fired. An unscanned attribute file is now itself a refusal reason.
- **`down --prune`'s recursive delete trusted a checkout path read back from `run.json` with
  no containment check.** Not container-writable, but operator-editable; gated on the path
  resolving inside `<repo>/.worktrees/` before anything is removed.
- **The atomicity fix above stopped one step short of its own goal: the rollback covered every
  git step but not the call that actually RECORDS a checkout.** `createWorkerWorktrees`'s
  `onCreated` callback — the only thing that writes `run.json` and the ledger — ran outside
  the rollback's `try`/`catch`, and the same round's dirty-clone fix (below) moved hazard
  neutralization and baseline capture INTO that callback, widening the exact window the
  atomicity fix had just closed. A throw there reproduced the identical orphan: a real clone
  on disk, a remote registered in the parent, nothing in `run.json`. Fixed by moving the
  record and the callback inside the try block, so any failure anywhere in the sequence rolls
  back the same way.
- **The dirty-clone baseline fix (`WorkerWorktree.baselineStatus`, above) compared
  `git status --porcelain` LINES against a recorded baseline, which has two false-negative
  classes that delete real worker output without `--force`.** `git status` collapses a
  wholly-untracked directory into one line, so a file written beneath a directory
  `repo-hazards.ts` already quarantined as a unit is invisible to a line diff; and `git
  status` reports a status CODE per tracked path, not content, so a worker's further edit to
  a file the baseline already shows modified produces an identical line and cancels out as
  "no change". Replaced with a content-addressed git tree hash (`WorkerWorktree.baselineTree`,
  via a `git add -A` + `git write-tree` against a throwaway index) as the authoritative
  dirty/clean signal; the status-line diff survives only for the informational "N uncommitted
  path(s)" display count.
- **`worktrees: null` and `worktrees: []` read identically to `down --prune`**, defeating the
  distinction `up` itself documents as load-bearing — a crashed `up` (leaving `null`) reported
  the same "nothing to reap" as a legitimately empty fleet (`[]`). `readRunWorktrees` now
  treats a present-but-`null` `worktrees` key as "creation did not finish" (a refusal), and
  `up`'s no-config path now explicitly writes `[]` rather than leaving the key `null` forever.
- **The merge-precheck fix above (worker's own clone preferred over the parent) silently
  disabled sibling-vs-sibling conflict detection.** `checkPairwise` only runs between two
  workers sharing one `repo` value, which stopped being true for any two worktree-isolated
  workers the moment each got its own independent clone. `conflicts_with: []` then read as an
  affirmative "no conflicts", never actually computed — the SRD's own wire contract. The skip
  is now an explicit `detail` note rather than silence; actually computing cross-clone
  conflicts (fetching each sibling's branch into the parent via its existing `worker-<id>`
  remote) is filed as a follow-up, not built in this pass.

### Changed
- The container suite runs ONCE in CI instead of twice. It had been executed for its own
  sake and then again inside the guard purely to re-count the summary — doubling real
  Docker time for no extra coverage, inside a 60-minute budget that also builds
  google-cloud-cli, and leaving two runs that could disagree with each other.
- The ADC file-mode mount-shape test is now CI-runnable via `PIFLEET_TEST_ADC_FILE`. It
  only ever needed *a file* to inspect a mount table, but it was pinned to the operator's
  real credential and so ran in no automated job at all.
- ISA criteria now distinguish `[x]` (something reproducible re-checks it) from `[~]`
  (partly proved, with the local-only half named explicitly). ISC-41, ISC-47 and ISC-48
  moved to `[~]` — the first two had been marked closed with no evidence of any kind, and
  the third names a token that nothing in the CLI ever mints.

### Added
- **An egress relay, so the deny-all bridge stops denying the fleet its own model server.**
  Workers sit on a Docker `--internal` bridge with no default route and no NAT, which is
  deny-all in hardware — and denies `host.docker.internal:8000` along with everything else,
  so every worker started healthy and could accomplish nothing. `src/security/relay.ts`
  stands up the single container that reopens exactly one destination: it runs with a
  dedicated NON-internal uplink network as its primary network so `--add-host` has something
  to route through, then attaches to the internal bridge under the DNS alias
  `host.docker.internal`, so a worker's baked-in `llm.base_url` resolves to it with no
  per-worker flags at all. Measured live rather than read from documentation: a container on
  an internal network cannot reach the host even WITH `--add-host` (internal genuinely
  removes the route), and Docker's automatic `/etc/hosts` injection was not dependable on
  this project's Colima setup, so the alias and the `--add-host` are both always explicit.
  The relay runs `--read-only`, `--cap-drop ALL`, `no-new-privileges`, and as uid `node`,
  because it listens on a bridge every worker can reach. `up` ensures it immediately after
  the network and records `egress_relay_ready`; failure is `BACKEND_UNAVAILABLE`.
- **The relay forwards oMLX and nothing else, on purpose.** `egress.google_hosts` remains a
  policy-level allow rule with no live traffic path — a Docker network alias cannot be a
  wildcard, so routing `*.googleapis.com` needs an HTTP CONNECT proxy or SNI passthrough,
  neither of which is built. A `cloud_access` worker on the internal bridge consequently
  cannot reach Google at all. Tracked as ISC-253/ISC-57 rather than implied away.
- **`models_allowlist` is now enforced.** A worker whose resolved model isn't on a non-empty
  allowlist refuses to start, checked for every worker before any of them launch.
- **Exit code `8` (internal error) documented in the README's exit ladder.**
- **A test-coverage report.** `bun run test:coverage` (Bun's built-in coverage,
  text + lcov, no threshold gate).
- **The `late_prompt_failure` settle guard has its own regression test**, alongside the
  existing deadline-escalation one — the two are different call sites reached by different
  events.
- **Version-floor checks for docker (>= 23.0.0), git (>= 2.32.0), and tmux (>= 2.4.0,
  reported only, not enforced).** `doctor` previously captured each tool's version but never
  compared it to a minimum; each floor is derived from a concrete feature dependency this
  project already relies on (BuildKit's `COPY --chmod=`, hermetic git's
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, tmux's `respawn-pane -c`) rather than picked
  arbitrarily.
- **`harness.patterns` is now a `fleet.yaml` key.** A config that supplies patterns
  replaces `DEFAULT_HARNESS_PATTERNS` entirely for the ISC-150 anti-gaming cap; an empty
  list is a validation error rather than "match nothing" (silently disabling the cap
  through a key that reads as harmless). Because an honest, non-malicious pattern list
  that simply doesn't match a worker's diff has the same silencing effect as an empty
  one, the harvester now also compares the configured surface against the built-in
  defaults and records a discrepancy — visible in both the human report and `--json` —
  whenever narrowing the surface would have changed the verdict.
- **A 16-worker e2e test proving no container-name collision, no port-collision surface,
  and no worker starves another's event loop under load.** Found and fixed along the
  way: the supervisor's completion-latency measurement was stamped from the dispatch
  CLI subprocess's exit rather than the actual dispatch ack, so it silently included
  `writeJsonAtomic`'s real fsync time in the "quiet" baseline — measurably wrong on an
  idle machine (recorded latencies below a scripted delay that made them physically
  impossible) and capable of a silent false-pass under real load. Latency is now derived
  from the supervisor's own event log. Also fixed: a failed `up` no longer orphans all
  16 detached supervisors — cleanup now runs regardless of whether `up`'s own result
  could be parsed.
- **`up` now creates the host side of every mount before the container starts (SRD §5.5).**
  `render` decided what each worker would bind-mount and nothing made those host paths exist
  — and on a bind mount that gap doesn't fail, it succeeds wrongly: Docker creates a missing
  `-v` source, so a missing directory arrives empty and a missing *file* arrives as an empty
  *directory*. A worker's `/skills` came up with no skills at all, and `/policy/cloud-allow`
  came up as a directory that verbgate's `[ -r ]` accepts and reads no lines from, quietly
  degrading the run to deny-all and leaving a stray `cloud-allow/` in the run dir. Every
  symptom read as model behaviour. `up` now writes the outbox, the per-role skill bundle, a
  zero-byte `cloud-allow` at 0444 (verbgate refuses *every* verb if its policy is writable by
  the uid consulting it), the concatenated briefing, and a verbatim copy of the configured
  kubeconfig — all through the same path helpers that emit the mounts — and refuses the whole
  launch rather than starting a worker with an input missing. Skill bundles are copied from
  `<repo>/skills/<name>/` (override with `PIFLEET_SKILLS_DIR`); a configured skill with no
  source bundle is a refusal naming the worker, role, skill and resolved path instead of a
  bundle that silently shrinks by one. Symlinks are refused rather than followed on both the
  source and the destination side, and a `.git` directory inside a bundle is refused rather
  than copied into the read-only directory the agent reads as instruction (its `config` can
  carry a credential in a remote URL) — ordinary dotfiles like `.DS_Store` and `.gitignore`
  copy normally. Found and fixed along the way: `skills: ["../../../../victim"]` walked out
  of the run directory and reopened a 0600 key to 0644, so skill and role names are now
  validated as single path segments where they enter the system; `--workers eng-1,eng-1`
  aborted the entire fleet with an environment error, because the duplicate id reached the
  policy write twice and the second attempt hit the 0444 the first had just set; an
  unreadable skill source was diagnosed as "no bundle exists", sending the operator to edit a
  config that was already correct; and `fleet.example.yaml` named three skill bundles that
  have no source directory, which the new refusal would have made un-runnable as shipped.
- **Real per-worker git isolation (SRD §9.1/§9.2), implemented as `git clone --no-hardlinks`
  rather than the SRD's originally specified `git worktree add`.** A security spike ran two
  worktree-based designs against a real container before this one shipped: mounting only the
  linked worktree fails outright (`.git` is a `gitdir:` pointer file resolving outside the
  container's mounts), and also mounting the gitdir to fix that is a confirmed
  container-to-host remote code execution (a container with write access to it zeroed the
  host's `refs/heads/main` and planted an executable `post-checkout` hook that ran as the
  operator on their next `git checkout`). `run/worktree.ts` instead clones each worker with
  `--no-hardlinks --single-branch --branch <parent's checked-out branch>`, strips `origin`
  immediately (so the host's absolute repo path can't be read out of `.git/config`), and
  registers a `worker-<id>` remote in the parent so an operator can still fetch a worker's
  commits without leaving their own checkout. `--no-hardlinks` is load-bearing, not hygiene: a
  bare local clone hardlinks object files into the copy, and a worker container writing
  through its own "copy" then corrupts the PARENT'S object store through the shared inode —
  which is how the spike investigating this feature destroyed this repository's own pack file
  before the flag was added. `Docs/SRD.md` §9.2 carries the full erratum. Preflight
  (`inspectBaseRef`/`assertBaseRefCloneable`) refuses a ref with submodules or LFS-tracked
  content before any clone is attempted — both clone as silently-wrong content (empty
  directories, pointer stubs) rather than failing — and a detached parent HEAD is a named
  refusal rather than a base silently substituted for the one the operator is sitting on.
  `down --prune` (SRD §9.3) defines "dirty" for a clone with no upstream: uncommitted paths OR
  commits past the recorded base sha, since stripping `origin` removes the usual "it's pushed
  somewhere" escape hatch. `up` also now runs hazard neutralization against each finished
  clone rather than the operator's own checkout, closing the gap a linked worktree's
  pointer-file `.git` (which the scanner explicitly declines to follow) would have left open.
- **`pifleet worktrees [--run r] [--json]` — the `git worktree list` replacement.** A worker
  checkout is now an independent clone with no entry in the parent's `.git/worktrees/`, so
  `git worktree list` against the parent shows nothing about workers regardless of how many
  `up` created, which reads as "no workers running" to an operator who reaches for the old
  habit. The new command lists every worker's branch, path, base sha and remote name from the
  same on-disk record `dispatch` and `down --prune` already trust, and reports each checkout
  as `clean`, `dirty (…)`, or `MISSING` via the same dirt-inspection `down --prune` gates on.

## [1.0.0] — 2026-07-28 — Phase 6: attended

The last phase. Every command in SRD §10 is implemented.

### Added
- **`steer` / `abort` / `exec`** — the supervisor already spoke `steer` and
  `abort`; these are the CLI layer and the proof. ISC-80 asserts the message's
  *position* in the event stream, not that a call returned ok; ISC-81 asserts
  the phase transition on a real clock.
- **`tui` pane mode** — hands a worker's pane to a person and records it. The
  record is written once and never removed: `--leave` sets `left_at`, because
  the point is that the run *was* touched, not what the pane is doing now.
- **The voided-requirements table** — attended mode's honest failure is silent.
  The run still produces a result envelope, a verdict and a diff, and none of
  them mean what they mean unattended. Eight criteria, each with a consequence
  an operator can act on.

### Fixed
- **A tampered or crash-truncated attended record read as autonomous.**
  `attended: []` is an affirmative claim that nobody drove the run, and the
  warning sat in `collection_notes` — an array whose own contract is findings
  about *collection*. There is now an `attended_unverified` signal with a
  top-of-report banner, cross-checked against `tui_entered` and `steer_sent` in
  the append-only ledger, so the record and the ledger must be tampered with
  together.
- **`tui --leave` fabricated a hand-back.** It guarded on "a record exists"
  rather than "the pane was handed over", and `steer` writes a record too — so
  `--leave` on a merely-steered worker stamped an ending for a session that had
  no beginning.
- **Four voided rows named criteria that still hold**, and the two a container
  shell genuinely breaks were missing. The pane's shell inherits the image
  PATH, where the verbgate sits over `gcloud`/`kubectl`/`helm`/`gsutil`/`bq`,
  so a person's mutating cloud verbs land in the ledger in the agent's row
  shape with no author (ISC-106) and the ledger stops being a record of what
  the *agent* did (ISC-107).
- **A torn read of an atomically-written state file.** `writeJsonAtomic` is
  tmp + fsync + rename, so a reader must see one whole file or the other; the
  size can still come from one inode and the bytes from its replacement. Read
  once more, and carry the bytes into the error either way.

### Testing
- 1069 pass, 52 skip, 0 fail across 75 files.
- The voided set is asserted exactly in both directions, and every consequence
  must be distinct prose — review had gutted the table to three rows and
  replaced every sentence with one placeholder without turning anything red.
- `readAttended` returning null instead of throwing on corrupt JSON — a
  plausible "consistency" refactor that would turn a tampered record into
  "never attended" — now fails two tests.

## [0.6.0] — 2026-07-28 — Phase 5: orchestration

A fleet you hand a task list to, and a report you can read afterwards.

### Added
- **`dispatch --auto`** — a dependency DAG over a task list, assigned to idle
  workers. A cycle or an unknown dependency is refused **before anything is
  dispatched**, and a failed dependency names the task that actually failed:
  two hops away, C is `blocked_by: A`, not by its blocked neighbour B.
- **`pifleet report`** — derived facts only. Verdicts enter solely through
  harvest adjudication; neither a worker's self-report nor the scheduler's own
  snapshot can donate one. The merge pre-check runs in the object database via
  `merge-tree` — never `merge`, `stash` or `checkout` — so it can be run
  against dirty worker trees, which is the state they are in when a run has
  gone wrong.
- **`pifleet logs`** — the pane viewer, read-only by construction. `up`'s panes
  now run `logs --follow --render` instead of a raw `tail -F`.
- **Role briefings** — `sre`, `investigator`, `verifier`. Resolution takes no
  envelope, config or worker identity, so it structurally cannot make a
  capability decision; the verb allowlist stays on the envelope.

### Fixed
- **A dispatch whose outcome was unknown could run twice.** A control-socket
  timeout was reported as "unreachable", which the scheduler read as "the task
  is untouched" and re-offered to another worker — but the supervisor may have
  accepted the envelope and replied late. The fence that would catch the second
  run is per-worker, so the second worker accepts it, and two agents run the
  same brief against the same branch. Only a provable connect failure is now
  retried; anything else settles `unknown`.
- **`dispatch --auto` could spin forever.** The deadlock guard fired only when
  every worker was dead, so a supervisor that was alive but wedged polled
  indefinitely with no budget and no output.
- **`report` crashed on a fleet of more than a thousand tasks** — the schema
  cap was treated as an assertion about reality. Rows are capped to fit, the
  note says what was cut, and totals count everything.
- **`TaskSpec.role` reached no worker.** It validated, travelled through the
  DAG and reached the snapshot without ever composing into a brief — so a task
  could report as `verifier` while the container ran a generic one.

### Testing
- 1009 pass, 52 skip, 0 fail across 68 files.
- The `logs` read-only guarantee is now **behavioural**: the real command runs
  over a real run directory in every mode and the directory must be
  byte-identical afterwards. The previous source-text denylist was evaded three
  ways — `fs.open` plus a FileHandle `write`, a backtick dynamic import, and
  `Bun.spawn` with a shell redirect — each with the whole suite green.
- The merge pre-check's "leaves every tree untouched" test was vacuous: a
  literal `git stash` passed all eleven, because `stash` on a clean tree is a
  no-op and the fixture was always clean. It is deliberately dirty now.
- A SIGINT test signalled a `bun run` wrapper rather than the CLI, so it
  measured the wrapper's exit semantics and failed only on Linux.

## [0.5.0] — 2026-07-28 — Phase 4: panes

Two real backends behind one seam, and panes that show what a worker is doing.

### Added
- **`FleetBackend` registry** — `src/backends/registry.ts` turns a
  `BackendKind` into a backend by keyed lazy `import()`. Lazy is a requirement,
  not a style choice: a static import would drag the cmux module into every
  `headless` run, and the kind is validated against a literal allowlist before
  it reaches an import specifier, since `--backend` is operator input and an
  unchecked value interpolated into a module path is a load-anything primitive.
- **cmux and tmux backends** — presentation only, by contract. Neither can name
  the run directory, and nothing outside a backend may interpret a backend-native
  id.
- **`pifleet attach --worker <id>`** — was a stub that threw for three phases.
  Reads the backend from the worker's `presentation.json` rather than a flag,
  because the run already decided it; refuses a headless worker by name instead
  of silently succeeding.
- **Panes show live activity (ISC-129, partial)** — each pane runs `tail -F`
  over its worker's `events.jsonl`, titled with the worker id. `tail` and
  nothing else: a follower cannot send anything back, so the pane stays a view
  and never becomes a channel.
- **`down` destroys the workspace it opened**, honouring `--keep-panes`.

### Fixed
- **`realExec` threw on a missing executable.** `Bun.spawn` raises rather than
  returning 127, so `doctor` — whose job is reporting which tools are missing —
  died with exit 2 and no JSON on a machine missing one. Every spawn failure is
  now a datum; the errno cannot separate "not installed" from "installed and
  unusable" anyway, and `stderr` carries the distinction.
- **The subprocess timeout never fired.** SIGTERM with no escalation, and the
  pipe reads awaited alongside `proc.exited`, so a process that traps SIGTERM
  and one whose grandchild holds the stdout pipe both hung `realExec` forever.
  Every backend call passes `timeoutMs: 15_000`, so `up` hung rather than
  losing a pane.
- **`attachViewer` wrote its 0700 launch script before validating the surface
  id**, so an id like `x/../../victim/target` escaped the viewer directory —
  an arbitrary-file overwrite with `#!/bin/sh` content. The guard existed; it
  ran on the last line of the method.
- **`setProgressArgv` emitted the literal string `"NaN"`** through the clamp
  written to contain out-of-domain values.
- **A ledger append failure discarded a working fallback**, exiting 1 with no
  diagnosis while tmux sat there healthy.
- **`doctor` reported `backends.cmux: true` beside a `cmux-probe-failed`
  diagnosis** — an empty missing-commands list read as "nothing missing".
- **`up` recorded every run's backend as `headless`**, so `attach` had nothing
  to focus.

### Testing
- 874 pass, 52 skip, 0 fail across 56 files.
- The `doctor` exit-code test previously passed for the wrong reason: this
  machine has no Docker daemon, so the 3 came from docker regardless of cmux.
  Now attributable in both directions.
- The ISC-137 seam test missed backtick imports — the idiom `registry.ts`
  itself teaches.
- A raw NUL byte made `cmux-client.test.ts` binary to git; `grep` and `diff`
  refused it, and two reviewers independently concluded `shellQuote` was
  untested when it has 56 tests.
- Two invariants had no test at all, both found by mutation: the tmux empty-id
  guard, and the cmux socket password staying out of argv.

## [0.4.0] — 2026-07-28 — Phase 3: security and cloud identity

The posture a graded worker runs under, and the identity it is given. Six
subsystems under `src/security/`, all wired into `up`.

### Added
- **Egress (§5.9, §12.4)** — a deny-by-default allowlist whose matching is
  label-boundary correct: `*.googleapis.com` matches `storage.googleapis.com`
  and refuses both `evil-googleapis.com` and `googleapis.com.evil.test`. Hosts
  are normalized (case, trailing root dot, IDN → punycode, empty labels
  rejected) before comparison, because normalizing one side only is how a
  homoglyph of an allowed apex gets through.
- **Network lifecycle** — the worker network is created `--internal`, and `up`
  REFUSES to adopt a pre-existing network of that name that is not. A network
  wearing the configured name without `--internal` gives every worker
  unrestricted egress while the fleet reports deny-all, and nothing would say
  so.
- **Repository hazard scan (§12.2)** — a checked-out repo is INPUT, and several
  files in it are read by the agent as INSTRUCTIONS. The scan parses
  `.git/config` and `.git/config.worktree` as text (never `git config`, which
  would execute whatever `core.fsmonitor` names), covers every attributes
  source git honours, and records `detected` and `neutralized` as separate
  fields so "we saw it and left it" cannot read as "we defused it".
- **Cloud identity (§5.8, §12.4)** — per-worker credential planning, stated
  explicitly including when the grant is nothing. A refresh loop that schedules
  on the MONOTONIC clock, never from the issuer's `expires_at` label: this
  fleet runs on a laptop that sleeps, and a wall-clock comparison wakes to find
  every token simultaneously fresh or dead.
- **Control-socket auth (§12.7)** — a per-run 256-bit secret minted with
  `link(2)` so two racing minters cannot each serve their own, mode 0600, never
  mounted into a container. Every verb requires it, `ping` included.

### Fixed
- **`--no-ext-diff` alone did not close the diff-driver escape — it relocated
  it.** `.gitattributes` assigns `diff=name`; `[diff "name"]` may define
  `command` OR `textconv`, and `command` wins when both are present. So
  suppressing `command` made git fall back to *executing* `textconv`, on the
  host, outside the container. The middle state was strictly worse than no
  hardening, because a dormant driver became the live one.
- **The hazard scanner missed five `.git/config` forms git honours** —
  `[section] key = value` on one line (the header pattern was anchored and the
  key pattern demanded a line-initial key, so a line carrying both matched
  neither), CRLF endings (`.` excludes `\r`, so the value capture could not
  reach `$`), and a second `[header]` on the same line.
- **`up` quarantined the operator's own repository.** It scanned
  `config.run.repo` with the mutating entry point, renaming their real
  `AGENTS.md` aside and commenting out `filter.lfs.*` while leaving
  `filter.lfs.required = true` — which hard-fails every later `git add` on an
  LFS-tracked path. It also defended nothing, since workers read
  `<repo>/.worktrees/<id>`. Now detect-and-report only.
- **The harvester's environment crossed into git.** `runGit` spread
  `process.env` into a subprocess operating on a tree the graded worker
  controls, handing it cloud credentials and tokens; the sibling module built
  its env from a literal and the asymmetry was the bug.
- **A credential that shipped could be reported dead.** `onInjected` — the
  supervisor persisting a record — ran inside the try guarding mint/inject, so
  an ordinary `ENOSPC` there was reported as a failed refresh naming a
  generation never attempted.
- **The refresh loop ignored abort and pinned the process.** The signal was
  re-checked only after the sleep resolved (45 minutes at the default), and the
  timer was never `unref`'d, so the process outlived all of its work.

### Notes
- ISC-249 is OPEN, not met: neutralization belongs on the per-worker worktree
  at the moment it is created, and nothing creates one yet (ISC-27/28).
- ISC-248 and ISC-253 are OPEN: the refresher attaches to a running container
  and the headless path starts none; the egress relay does not exist, so
  containment is enforced by network isolation alone.
- ISC-254 is OPEN and unpinnable as written — `timingSafeEqual` and `===` are
  behaviourally identical, so only a timing measurement separates them.

## [0.3.0] — 2026-07-27 — Phase 2: artifacts and safety

A worker's self-report is now adjudicated against independent evidence, and a
run can be stopped before it spends everything.

### Added
- **Outbox contract (A1)** — `result.json` is untrusted input. It is
  schema-validated before any field is dereferenced; a path naming anything
  outside the mount table is refused *before* the path is opened; a symlink
  under `files/` pointing out of the outbox is refused via `lstat` + `realpath`
  rather than followed first; an oversized file is refused rather than buffered.
- **Repository harvest (A2)** — diff, commits and changed files from the
  worker's branch, gated on `git merge-base --is-ancestor <base> HEAD`. Without
  that gate a rewritten base still produces a plausible, much smaller diff
  through the surviving merge-base, and a worker that changed nothing looks
  clean.
- **Transcript harvest (A4) and usage (A6)** — reuses the existing `TailReader`.
  `U+2028` inside a JSON string survives (`readline` splits on it and silently
  drops the record); a 4-byte codepoint split across a poll boundary produces no
  `U+FFFD`; a session file rewritten in place is re-read from zero. Usage
  merges element-wise-max across sources, because an undercount feeding a token
  ceiling is a ceiling that never trips.
- **Acceptance runner** — commands are resolved from the **base SHA** and
  executed in a fresh clone outside the worker's worktree with no inherited
  environment. Independence is a property of *where the command is resolved
  from*, not of who runs it: the command string routes through `package.json`
  scripts, `conftest.py`, `.git/hooks` and the Makefile, every one of which is
  inside the worker's mutable surface.
- **Adjudicator** — the `failed < blocked < partial < success` lattice with
  `unknown` as the identity element, the harness-surface cap, discrepancy
  detection, and a hashed derived-fact bundle so an adjudication can be
  replayed. The hash covers the facts and not the verdict, so "same hash,
  different verdict" and "different hash" are distinguishable failures.
- **Budget ceilings** — on **tokens**, with an up-front reservation released on
  settle. Local models are unpriced, so a ceiling watching dollars never trips
  and is a comment rather than a control. The reservation doubles as the
  admission slot, which is also what distinguishes a *queued* worker from a
  *wedged* one — they look identical if you only watch event silence.
- **Kill ladder** — re-validates `(pid, started)` at every rung. A pid is not an
  identity: pids are reused, and a ladder escalating on an unvalidated pid
  eventually SIGKILLs a process that merely inherited the number.
- **Reaper** — staleness by monotonic change-detection, not by subtracting a
  wall-clock heartbeat label written by another process. Subtraction would
  mass-reap the whole fleet when a laptop resumes from sleep.
- **`src/util/clock.ts`** — the single home for monotonic time. The rule that no
  timing path may read `Date.now()` is now a test rather than a convention.

### Fixed
- A timed-out acceptance run adjudicated to `unknown`, and `unknown` being the
  lattice identity meant the worker's claim was adopted verbatim — so a task
  whose exam never finished was reported `success`. The route needed no harness
  edit: ship a change that makes an existing command hang, claim success,
  collect it. An attempted command that returns no answer now caps the verdict.
  It is still never `failed` — a timeout proves nothing about the code.
- Symlink containment canonicalizes its root. On macOS `/var` is a symlink to
  `/private/var`, so an uncanonicalized root made every legitimate in-outbox
  symlink compare as escaping.

### Notes
- The SRD's `CompactionEntry.retainedTail` does not exist in Pi 0.79.6; the
  installed session format spells the same concept as `summary` plus
  `firstKeptEntryId`. Implemented against the binary. Erratum in `ISA.md`.

### Security — found by adversarial review of this phase
- **`git diff` no longer executes what the graded repository tells it to.** A
  `.gitattributes` in the tree assigns a diff driver per path and
  `[diff "name"] command` in the repository's own config names a program git
  runs — on the host, as the harvester, outside the container the worker is
  confined to. Neutralized on the command line, because `GIT_CONFIG_GLOBAL`
  and `GIT_CONFIG_SYSTEM` do not suppress `.git/config` and nothing in the
  environment can. `runGit` also no longer spreads `process.env`, which had
  been handing that subprocess the harvester's cloud credentials.
- **Outbox containment is checked at the roots.** `files/` was walked directly
  and so never met the per-entry symlink branch: a worker that replaced it
  with a link to `~/.ssh` had every key returned as a safe artifact with
  nothing refused. A symlinked task directory separately re-rooted containment
  onto the attacker's own directory, after which escaping links were approved.
  Accepted files are canonicalized and refused when their link count shows a
  second name elsewhere.
- **Envelope paths carrying control characters are refused.** A NUL is a single
  contained path as a JavaScript string and truncates to a different file at
  the C boundary; the same characters let a worker rewrite the harvest report
  that is judging it, since these paths reach an operator's terminal.
- **The harness surface covers what the test command resolves *through*.** The
  pattern list omitted `bunfig.toml` — the config for the runner this
  repository itself uses, whose `[test] preload` executes before any test — so
  a worker could turn a red suite green with the implementation still wrong and
  have nothing classified as harness. Runner config, inherited config
  (`tsconfig` `extends`, Makefile `include`) and toolchain selection are now
  included. A denylist cannot express this completely; the allowlist redesign
  is tracked as ISC-243.

### Fixed — found by mutation and adversarial review
- **One unharvestable task no longer destroys the run's harvest.**
  `readResultEnvelope` opened the file outside its own guard, so an envelope
  that `lstat`'d cleanly but could not be opened threw out of a function whose
  contract promises it never throws, propagated through an unguarded loop, and
  exited `artifacts` with code 2 and no JSON at all — losing every healthy
  task's harvest with the poisoned one.
- **The adjudicator is on the live path.** `artifacts` reached the two-argument
  lattice combinator, so the module implementing the evidence rules — the
  harness cap, the replay hash, the moved-tree void, the inconclusive-exam cap
  — had a full passing test suite and no production caller. This also settles a
  contradiction between two implementations of F5: SRD §880 makes
  *disagreement* between the envelope and the diff a hard failure class,
  unqualified, so concealment now fails as fabrication already did.
- **`facts_hash` is recorded, not just computed** — ISC-153 asks for hashed
  *and* recorded, and the hash was being dropped.
- **Flaky supervisor tests fixed at the root.** `socketPath` hashes
  `(run_id, worker_id)` into the shared `os.tmpdir()`, so tests using hardcoded
  run ids made concurrent test processes share a control socket and answer each
  other's RPCs. Six parallel lanes went from 5/6 failing to 6/6 green.

### Added — wiring completed after review
- **`artifacts --run-acceptance` holds the exam.** SRD §8.2 has the harvester
  re-run the acceptance commands *itself*; the runner existed, was unit-tested,
  and had no production caller, so `derived.acceptance` was always empty and a
  worker's self-report was the only thing grading it. Commands are resolved
  from the base SHA, not the worker's tree — independence is a property of
  where a command is resolved from, not of who runs it. Opt-in, because the
  default must stay a pure read: a read that silently clones a repository and
  executes code out of it is a different operation wearing the same name.
  Running in a fresh *container* rather than a fresh clone remains ISC-233.
- The daemon runs the reaper on an interval and deregisters what it reaps
  (ISC-236); the staleness threshold travels with the run in `run.json`, so the
  detached daemon judges by the interval the fleet was started under. This also
  makes `up --config` do something, which it previously accepted and ignored.
- `workerOutboxDir` has one definition (ISC-231). It was computed
  independently by the mount builder and the harvester, and a divergence there
  does not throw — harvest would find an empty directory and report a task that
  produced artifacts as having produced none.

## [0.2.0] — 2026-07-27 — Phase 1: container and headless core

`up → dispatch → wait → down` runs end to end on the `headless` backend against
the Pi double, and against real Pi 0.79.6.

### Added
- **Worker container** — `image build|list|verify|gc`. Read-only root, uid 10001,
  tini as PID 1, `gcloud`/`kubectl`/`helm`/`gsutil`/`bq` behind the `verbgate`
  PATH shim with a task-scoped allow list on a read-only mount.
- **Config** — `fleet.yaml` loader and validator with field-level errors, and
  `render --worker` to print the exact `docker run` and `pi` argv without
  executing either.
- **Detached supervisor** — its own session and process group, so it outlives the
  CLI that started it. One per worker.
- **Pi RPC client** — JSONL framing over stdin/stdout with a monotonic per-record
  stream sequence, split on `\n` only (never `readline`, which also splits on
  `U+2028`).
- **Completion detection** — `agent_end{willRetry:false}` plus a correlated
  double-read of `get_state`. There is no `agent_settled` message; the original
  design waited for one and would have hung on every task.
- **Epoch fencing** — every task attempt gets an epoch bound at the stream offset
  of its prompt ack, so a late event from a previous attempt cannot be
  misattributed to the current one.
- **Run state** — `state.json`, `fence.json`, `events.jsonl`, and a per-writer
  ledger, all written atomically.
- **CLI** — `doctor`, `up`, `daemon`, `status`, `dispatch`, `wait`, `abort`,
  `logs`, `exec`, `down`, on a strict exit-code ladder (2 usage, 3 backend, 4
  timeout, 5 budget, 6 worker died, 7 partial).
- **`pifleet-fake-pi`** — the scriptable test double the whole suite runs against.

### Fixed
- The epoch fence is recorded synchronously with the prompt ack. Resolving a
  promise only schedules a microtask, so a fence recorded after `await send(…)`
  landed *after* an `agent_start` that arrived in the same stdout chunk — the
  window never opened, every later event including `agent_end` was discarded, and
  the task hung forever.
- A deadline whose `abort` produces no terminal event now settles the task and
  kills the child, instead of leaving the worker `busy` indefinitely.
- `writeJsonAtomic` uses a unique temp name per call and cleans up on the throw
  path; concurrent writes to one path were producing unparseable files.
- `TailReader` detects file replacement by identity rather than size, so a
  rewritten session file is re-read from zero instead of resuming mid-record.
- Bind-mounted host paths are never derived from `os.tmpdir()`. On macOS the
  daemon runs in a VM that shares only a declared set of directories, and a `-v`
  against an unshared path mounts a silently *empty* directory with exit 0.
- Bind-mounted host directories are made accessible to uid 10001. A Linux bind
  mount passes host ownership through untouched, so `mkdtemp`'s 0700 and
  `mkdir`'s 0755 left the worker unable to write its own outbox — invisible on
  macOS, where the VM squashes ownership.
- `read_only` is enforced against the *effective* tool set. Omitting `tools`
  is not "no tools": Pi then grants every builtin, `bash` included, so the most
  natural way to write the role skipped the check entirely.
- verbgate's policy and ledger paths are constants rather than environment
  variables — the worker could previously hand the gate its own allow list and
  redirect its own audit trail.
- `dispatch` accepts the mandatory `epoch: 0` placeholder. The envelope schema
  requires the field and documents 0 as the placeholder, but dispatch treated any
  number as an explicit request, so every hand-written envelope was rejected
  `stale_epoch` for supplying the one value the schema forces its author to give.
- The container CI job tags the built image from the real `image list --json`
  shape. It read `d.images[0].tag` from what is a bare array, so the job had been
  red since it was added and no container probe had ever executed.

## [0.1.0] — 2026-07-26 — Phase 0: verify and scaffold

### Added
- Repository foundation: Bun/TypeScript skeleton, strict tsconfig, CI workflow,
  test pyramid layout.
- `Docs/SRD.md` — the pifleet system requirements document (v2.3), rewritten
  from live execution of the cmux and Pi surfaces. Eleven errors in the previous
  revision are recorded in its §18.
- `ISA.md` — the criteria that define done.
