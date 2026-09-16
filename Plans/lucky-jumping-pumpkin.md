# Close the open ISA criteria in cmux-fleet

## Context

The README fix (previous task) corrected the phase-status table to say all six SRD phases
are "done" — which is true in the sense that every command in SRD §10 exists and the CLI
surface works end to end. But `ISA.md` (the project's actual done-condition) still has
**127 of ~254 criteria unchecked**. "Phase done" meant "the commands exist," not "every ISA
criterion is verified." This plan closes that remaining gap.

Two Explore agents traced every open ISC in Groups D/F/G/H/J/M/Q/R/S and the Phase-3
carried-open items to real file:line evidence — nothing here is guessed. The headline
finding: most of the "missing" work is not missing code. Groups C/D/E/F/G (container image,
Google credentials, oMLX, config, lifecycle — roughly 70 of the 127 open criteria) map to
code that already exists and looks correct (no TODOs found anywhere in `src/`), but was
never live-probed and checked off because a prior session on this machine had no Docker
daemon. Docker (via Colima) is running now. A smaller set (~35 criteria) are genuine code
or test gaps, mostly small and independent (Group Q mutation-testing findings). A handful
are large, architectural, and some are explicitly blocked on each other.

Two environment blockers were also found that gate *any* live verification, and must be
fixed first:
1. `bun install` in a clean clone fails with `ConnectionClosed` on every tarball (corporate
   proxy blocking registry fetches — same class of issue already documented in this
   project's CLAUDE.md for npm/pypi).
2. `pi` on `$PATH` resolves to `~/bin/pi` → `@oh-my-pi/pi-coding-agent` (a fork), **not**
   the pinned `@earendil-works/pi-coding-agent@0.79.6` this project is built and tested
   against. Per explicit instruction, vanilla pi.dev must be the one actually exercised —
   the oh-my-pi install is not to be touched or removed.

## Workstream 0 — Unblock the environment (prerequisite to everything else)

1. Resolve `bun install`'s proxy-blocked tarball fetches (try disabling the Symantec WSS
   proxy per this project's own SSL-troubleshooting note, then retry; fall back to an
   internal mirror if one exists).
2. `bun install -g --ignore-scripts @earendil-works/pi-coding-agent@0.79.6`. This installs
   to `~/.bun/bin/pi`, which sits **earlier** in `$PATH` than `~/bin/pi` (the oh-my-pi
   wrapper) — so `pi` resolves to vanilla pi.dev without editing or removing the existing
   oh-my-pi setup at all.
3. Confirm `pi --version` reports `0.79.6` from the `@earendil-works` package.
4. Set `OMLX_API_KEY` for the local oMLX server (already answering on `:8000`, just needs
   the key) so Group E probes can run.
5. No action needed on Docker (Colima already running) or cmux (already installed,
   0.64.22 — the version drift vs. the ISA's pinned 0.64.20 is expected `doctor` noise,
   already flagged to the user after install).

**Exit criteria:** `bun install` exits 0 in a clean clone; `pi --version` = `0.79.6` from
`@earendil-works`; `bun run src/cli/index.ts doctor --json` reports no missing-binary
diagnosis for pi, docker, or cmux.

## Workstream 1 — Live-probe verification sweep (no new code)

Covers Groups C, D, E, F, G, most of H and J — roughly 70 open ISCs. Once Workstream 0
lands:

```
PIFLEET_DOCKER=1 bun test test/integration
PIFLEET_DOCKER=1 bun test test/e2e
```

against real Pi + Docker, capturing pass/fail evidence per ISC. For each criterion that
passes: flip `[ ]` → `[x]` in `ISA.md` with an evidence line in `## Verification`, matching
the format already used in the Phase 1/4/6 close-out sections. Anything that actually
*fails* live is a real bug the static exploration couldn't see — triage it into Workstream
3 or 4 below rather than force-checking it.

This sweep should run **before** any new feature code, since there's no point hardening
subsystems that already work. It also likely resolves ISC-249 as a side effect (it's
blocked on ISC-27/28, both in this sweep's scope).

**Bundle in — trivial checkbox-only items** (Explore confirmed already implemented and
tested, just needs the tick + an adversarial test where noted):
ISC-142 (needs a two-allocator e2e proof), ISC-144, ISC-145 (already tested), ISC-186
(needs a dedicated concurrency test), ISC-218, ISC-229 (already satisfied).

## Workstream 2 — Small, independent code fixes

Each is a single-file fix with its own regression test. Good unit of work for one
`engineer`-role agent per 3–5 items, each in its own git worktree
(`git -C ~/repos/cmux-fleet worktree add`, per this ISA's existing Decision on manual
worktrees for parallel engineers):

- **ISC-214** — `src/rpc/client.ts` `feed()`: check `#closed` inside the per-line loop so
  it stops dispatching once `#fatal()` fires mid-chunk.
- **ISC-215** — `src/rpc/client.ts` `send()`'s EPIPE catch: set `#closed` alongside the
  rejection, not just the pending-map clear.
- **ISC-216** — `src/cli/index.ts`: give the undiagnosed-internal-error branch its own
  exit code, distinct from commander's usage-error `EXIT.USAGE`.
- **ISC-217** — `src/cli/commands/dispatch.ts` / `src/rpc/epoch.ts`: a named
  `MalformedEpochError` for negative/fractional epochs instead of silent normalization.
- **ISC-219** — `test/integration/verbgate.test.ts`: add a case tampering the *old*
  `/outbox/policy/cloud-allow` path to prove the fixed shim ignores it.
- **ISC-228** — a scenario driving a late `success:false` matching `livePromptId` to
  exercise the `late_prompt_failure` settle guard in `src/supervisor/index.ts`.
- **ISC-247** — `src/harvest/outbox.ts`: extend the control-char refusal to include
  backslash (`0x5C`).
- **ISC-190** — enforce `models_allowlist` (schema field exists, unused) in
  `resolveWorker`/`up.ts` before a worker launches.
- **ISC-160** — `src/container/image.ts` `configHash`: hash Dockerfile content too, not
  only `piVersion`/`toolchain`/`aptPackages`, so a Dockerfile edit actually busts the
  cached image tag.
- **ISC-22** — add `bunfig.toml` `[test] coverage=true` (or a `test:coverage` script)
  covering all of `src/`.
- **ISC-7** — process only: push the current `main` (one commit ahead — the README fix)
  and confirm CI goes green on the true HEAD before checking the box.

## Workstream 3 — Medium-scope, single-subsystem features

Each below is sizeable enough for its own worktree/engineer dispatch, but doesn't cross
subsystem boundaries:

- **ISC-143 + ISC-156** — replace the existing stochastic SIGKILL test with one
  deterministic case per syscall boundary (open/write/fsync/rename/dir-fsync) for
  `writeJsonAtomic` (`src/util/jsonl.ts`) and the fence-persist path
  (`src/supervisor/index.ts`).
- **ISC-154** — compute a real git-tree hash at quiesce (`src/supervisor/index.ts`) and
  again at harvest end (`src/harvest/index.ts`), populating `tree_hash_quiesce` /
  `tree_hash_harvest`, which `adjudicate.ts` already reads but nothing populates today.
- **ISC-158** — a new e2e test bringing up 16 workers, asserting no container/port
  collision and no event-loop starvation.
- **ISC-159** — `src/cli/commands/doctor.ts`: split the collapsed single diagnosis into
  distinct exit codes/messages for missing-binary vs. wrong-version vs. absent-daemon, and
  add the version-floor checks that today capture but never compare docker/git/tmux
  versions.
- **ISC-188** — unify `src/config/render.ts`'s run-dir computation with
  `src/run/paths.ts`'s `runsRoot()`, so the `render` preview command and the real `up`
  launch can't diverge on `PIFLEET_RUNS_DIR`.
- **ISC-189** — wire `container/image.ts`'s `verifyImage` into `up` so it refuses to
  launch against a missing or failing image instead of trying anyway.
- **ISC-232** — add a `harness` field to `src/config/schema.ts`, thread it through
  `loadConfig` → `harvest/index.ts`'s `harnessSurface()` call, so
  `DEFAULT_HARNESS_PATTERNS` becomes the fallback, not the only source.
- **ISC-234** — add an `export_html` case to the supervisor's control-socket switch
  (`src/supervisor/index.ts`) so `transcript --html` uses the live RPC path instead of
  always falling back to local rendering.

## Workstream 4 — Large / architectural items (design note before code)

- **ISC-157 / ISC-192 — ledger/state schema versioning.** No version-dispatch or
  migration scheme exists at all (`LedgerRecordSchema` has no version field; state schemas
  hard-fail on any mismatch). Needs a real design: a `schema_version` field, a
  migration/compat-read layer, and an explicit "how many versions back" policy.
- **ISC-233 — acceptance runs in a real container, not just a fresh clone.**
  `src/harvest/acceptance.ts` runs commands via bare `Bun.spawn` on the host today. Needs
  `docker run` against the worker's *verified* image, mounting the fresh clone, mirroring
  `image.ts`'s hardened flags — a real change to the harvest execution model.
- **ISC-243 — replace the harness-surface denylist with a graded allowlist.** Depends on
  ISC-232 landing first. This is the anti-criterion's own point: a glob denylist "cannot be
  complete"; the fix is a different mechanism (resolution-surface allowlist), not a bigger
  denylist.
- **ISC-246 — TOCTOU-safe outbox scanning.** `scanOutboxFiles` (`src/harvest/outbox.ts`)
  validates via lstat/realpath then returns path *strings*; needs to open descriptors
  (`O_NOFOLLOW`) during validation and return fd-backed handles. Explore flagged this as
  latent today but "arms the moment E3 attaches artifacts" — worth prioritizing if any
  Workstream-3 item starts consuming `safe` results downstream.
- **ISC-172 — verbgate ledger collected outside the container.** The verb-decision log
  currently lives inside the worker's own bind-mounted outbox (`docker/verbgate` documents
  this itself as a known exposure). Needs a genuinely different collection mechanism — a
  Unix socket/FIFO the supervisor owns — so a worker can't truncate its own audit trail
  before harvest reads it.
- **ISC-235 — wire `BudgetManager.admit` into the real dispatch path.** Fully built and
  tested in isolation (`src/safety/budget.ts`) but never called outside tests. Needs
  wiring into `dispatch`, persisting the snapshot, and folding `budgetExitCode` into
  `worstExit` after harvest (`wait.ts` / `scheduler.ts`).
- **ISC-248 — wire `TokenRefresher` to a real running container.** `up.ts` currently only
  calls `planCredential`; minting and the refresh loop never attach to an actual container
  process. Re-check during Workstream 1 whether `up` genuinely launches real (non-test-
  double) containers today — that determines whether this is "wire the refresher" (small)
  or "the real launch path itself needs finishing" (large).
- **ISC-253 — build the egress relay.** `decide()` (`src/security/egress.ts`) is a fully
  unit-tested pure policy function nothing calls in production; `network.ts`'s own
  docstring names a "model-provider proxy" that should consult it, but no relay/proxy
  component exists anywhere in the repo. Net-new: a small proxy on the internal Docker
  bridge calling `decide()` per outbound connection.

## Workstream 5 — Accept as open (don't implement)

- **ISC-254** — the ISA's own notes already establish that replacing `timingSafeEqual`
  with `===` leaves the suite green (the two are behaviorally identical by construction;
  only a timing measurement distinguishes them, and that's too flaky to gate CI). Leave
  this open with its existing documented-in-place status; record it as an accepted,
  permanent `[ ]` in `## Decisions` rather than something this plan closes.
- **ISC-129** — needs a run from *inside* a live cmux pane (cmux's `socketControlMode`
  refuses calls from outside one). Now that cmux is installed, this is a one-time manual
  verification session (open cmux, run `pifleet up --backend cmux`, confirm panes) — not a
  dispatched engineering task.

## Delegation approach

Every dispatched agent gets only the tools its role needs, matching the least-authority
pattern already encoded in this repo's own `roles/*.md` briefs:

- **Workstream 1 (live sweep)** — an `sre`-flavored agent, Bash + Read only.
- **Workstream 2/3 (fixes and features)** — `engineer`-role agents, Read/Edit/Bash, one
  per item or small cluster, each in its own git worktree so parallel edits can't collide.
- **Workstream 4 (large items)** — an `investigator`-role agent (read-only, no bash
  mutation, no edit) per item first, to produce a short design note; only then an
  `engineer` agent to implement against it.
- **All workstreams** — a `reviewer`-role agent (Read/Grep/Find only, no bash, no write)
  checks each diff against its ISC before it's marked `[x]`, per the existing
  `roles/reviewer.md` brief.

## Suggested sequencing

0 → 1 (closes the largest ISC count for the least effort, and re-derives whether 248/249
are still blocked) → 2 → 3 → 4, with Workstream 5 called out as accepted-open throughout
rather than deferred indefinitely.

## Verification

- After every workstream: `bun run typecheck` and the relevant `bun test` suites stay
  green.
- Every criterion flipped to `[x]` gets an evidence line in `ISA.md`'s `## Verification`
  section, in the same format as the existing Phase 1/4/6 close-out entries.
- Final gate before calling any workstream done:
  `PIFLEET_DOCKER=1 bun test test/integration test/e2e`.
