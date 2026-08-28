# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- **The egress relay bind-mounted three files from the checkout with nothing checking they were
  visible (ISC-292).** `up` asserts bind-mount visibility over the finished worker argvs, and none
  of the relay's sources appear on those: `relayScriptPath()`, `proxyScriptPath()` and
  `proxyPolicyScriptPath()` all resolve under `repoRoot()`, wherever the operator cloned, while the
  worker mounts come from `run.repo` and the runs and scratch roots. `up` also calls
  `ensureEgressRelay` some five hundred lines before that assertion.

  On a VM-backed runtime a checkout outside the shared set does not fail the `docker run`; it mounts
  three invented empty directories where the relay script, the CONNECT proxy and the shared matcher
  belong. The container exits 0 and the relay dies on a missing module, reported as "exited
  immediately after start" — a message that sends the operator looking at the listen port.

  The relay now probes its own sources before launching, over the same argv `docker run` is handed,
  on the launch path only, and ahead of `ensureUplinkNetwork` and the `rm -f` so a refusal cannot
  leave the operator with no relay and an orphan network. `doctor` reports the checkout as a third
  mount root, which is the half that can be run before `up` rather than after it.

  The grade does not move. The new probes substitute the injected runtime, so they re-check that the
  guard fires when a runtime reports a source invisible — not that a genuinely unshared path on a
  real runtime is caught. That direction still has no reproducible reader.

- **Every harvest leaked one open file descriptor per accepted artifact (ISC-301).**
  `scanOutboxFiles` hands back entries that each hold an open descriptor — that is the point of the
  ISC-246 restatement, and `OutboxFile` says "THE CALLER OWNS IT AND MUST CLOSE IT". `harvestTask`
  opened a scan, read its refusals, and dropped the object. `closeOutboxScan` had no caller anywhere
  in `src/` except `outbox.ts`'s own throw path.

  `MAX_HELD_DESCRIPTORS` is 128 because that is "half of that 256 floor, so the scan leaves headroom
  for the rest of the process". That reasoning is per scan. Nothing released between scans, and
  `harvestAll` loops `harvestTask` over every task in a run, so two tasks with full outboxes reach
  the exact soft limit the cap was sized against — defeated not by a scan that exceeded it but by
  scans that never handed anything back.

  `harvestTask` now owns the scan for its whole body and releases it in a `finally`, which also
  covers the throwing paths that `harvestAll` catches and loops past. `test/unit/harvest-fd-lifetime.test.ts`
  counts the process's open descriptors around five harvests of a five-artifact outbox, carries a
  control proving the fixture really does hold descriptors, and fails loudly rather than skipping
  where neither `/proc/self/fd` nor `/dev/fd` exists. Removing the release reproduces the leak at
  exactly the predicted size: 83 descriptors before, 108 after.

  Filed at `[~]`, not `[x]`, and the reason is measured: a second mutation moved the release onto
  the success path alone and both probes stayed green, because nothing induces a throw between the
  scan and the return. The leak is fixed on every path; the evidence covers one.

- **A reap's group action never reached the ledger, so the field added to report it was
  unreadable by the operator it was added for (ISC-300).** `ReapReport.group` — `addressed`,
  `narrowed_to_leader`, or `none` — was introduced so a reap could say which action it took about
  a capture-failed process group. It was computed correctly and asserted by three probes. The
  daemon then built its ledger row inside the `onReap` callback, copied `supervisor` and
  `container` across, and dropped `group` on the floor. `worker_reap_refused`, the row somebody
  reads when a worker will not die, could not distinguish a narrowing from a target that never had
  a group at all.

  Nothing was red, and nothing could have been: the probes assert `reapSupervisor`'s return value,
  and the mapping that discarded it lived in a closure handed to a daemon no test starts — the
  failure shape `verbgate-collect-wiring.test.ts` already names in its header as "correct code,
  green tests, and no worker's ledger ever actually collected".

  The mapping is now `recordReaps`, a named export the daemon calls in one line, and
  `test/integration/reap-ledger-wiring.test.ts` drives it with a real `LedgerWriter` and reads the
  rows back off disk. Re-introducing the defect reddens three of its four probes; hard-coding the
  value reddens only the probe written to catch that. One line — the hook's call — is still
  unreachable from any test, and the new file says so rather than implying otherwise.

  The criterion itself does not move. `down` still refuses where the reaper narrows, and an
  attempt to show that trade was illusory failed in both directions: refusing genuinely spares the
  container (removal is gated on the supervisor being stopped), and refusing is genuinely not
  silent (the staleness clock is kept deliberately, so every scan retries and writes another row).
  Both arms cost something real, so the choice stays an owner's.

- **The ISC-154 quiesce sample was failing outright on Linux, and the fix reverses a documented
  rejection.** `container-live` failed the ISC-290 chain probe with `the supervisor took no quiesce
  sample`, and — because the sampler now reports WHY — the artifact named it: `git add -A (snapshot)
  ... exited 128: insufficient permission for adding an object to repository database .git/objects`.

  The worker container runs as uid 10001 and writes into the host worktree through a bind mount, so
  it leaves `.git/objects/<xx>/` owned by 10001; the supervisor then samples as the host user and
  cannot add to the object store. Intermittent, because it fires only once the worker's own writing
  created the directory the sampler needs — and **invisible on macOS**, where the bind mount squashes
  file ownership, so it exists only on the Linux runner and no amount of local running would have
  found it.

  `treehash.ts` had rejected redirecting `GIT_OBJECT_DIRECTORY` in as many words — it "buys a smaller
  property than it costs in ways to be wrong" — but that was a judgement about purity, made when
  nothing was failing. The snapshot now writes into a throwaway object directory it owns, with the
  checkout's real store attached as an alternate, and asks git where that store is
  (`rev-parse --git-path objects`) rather than assuming `.git/objects`, which is a *file* in a linked
  worktree. The tree id is content-derived and unchanged — measured, not argued: the same worktree
  hashes to `6640fb01ffae1cdd778a3fe65b469f62a5230def` either way and the real store's loose-object
  count does not move. The property the old paragraph called too small to buy came free: harvest is
  now a pure read of every byte under `.git`.

- **`TREE_HASH_TIMEOUT_MS` back to 10s**, on the condition the 2026-08-26 raise wrote down for itself
  rather than on a fresh argument. That entry said "if the next event reads `git ... exited`, the
  bound was never the problem". It did. Both halves of the decision are kept at the constant, because
  the pair is the useful record.

  Two probes reproduce on a Mac what the real cause cannot: `chmod` reaches the same git code path as
  the uid mismatch, so the suite freezes `.git/objects` and asserts the sample still succeeds with the
  same hash a twin repository produces, and that `count-objects` does not move. Mutation-proved — and
  the mutation first caught a **vacuous probe of my own**: the original took its expected hash from the
  frozen repository, which wrote the blob before freezing, so the unfixed code passed. With the
  expected value taken from an identical-content twin, the same mutation reddens both probes and the
  first reproduces the CI failure verbatim, down to `error: unable to index file 'add.js'`.

### Added

- **ISC-189 closed: the launch gate is proved against REAL bytes on a REAL daemon.** The criterion's
  own TO CLOSE was specific — one probe in the Docker-gated `container` job that builds a real image
  and files it under another image's tag, asserting both that the labels come back as `buildImage`
  wrote them and that `assertImagesReady` refuses. That, plus the older residual it was carrying
  separately: the fails-verify half was a `docker` PATH shim, never a real image that really fails.

  Four probes in `test/integration/image.test.ts`, and the two that refuse are worthless without
  the two that do not:

  1. **The label round trip.** `docker image inspect` on the freshly built image must report
     `pifleet.pi-version`, `pifleet.toolchain` and `pifleet.config-hash` exactly as `parseImageTag`
     reads them off the tag it was built under. That is the equality `imageIdentityDrift` is built
     on, and no test read it back from an actual image store until now — the shim answered
     `{{json .Config.Labels}}` by taking the tag string apart, so nothing would have noticed if
     `buildImage` stopped stamping the labels tomorrow.
  2. **The stale-but-present case.** One `docker tag` files the real worker image under a tag whose
     config-hash is not its own. The probe asserts, in order, that `imagePresent` says PRESENT,
     that `verifyImage` says OK, and that the gate refuses anyway with `reason: "mismatched"`
     naming both hash values. The first two are the load-bearing ones: they establish that both
     halves of the pre-identity gate pass on the wrong image.
  3. **Fails-verify on real bytes.** An image built `FROM` the real one with nothing changed but
     `USER root`, stamped with identity labels that MATCH its own tag — so presence passes, the
     identity check passes, and the run reaches verification under its own power, where
     `verifyImage`'s `uid-10001` check refuses it.
  4. **The positive control**, which is not optional: a gate that refused everything would pass
     both refusal probes.

  Composed with `up-wiring.test.ts` — which proves the half about `up` (on the launch path, right
  diagnosis, before any clone, remote or supervisor) — the criterion is covered end to end. Neither
  file proves it alone, and that is stated in the ISA rather than left to be inferred.

  Mutation-proved, one probe reddened per mutation: neutering `imageIdentityDrift` reddens only the
  retag case (`the gate ACCEPTED pifleet/pi-worker:0.79.6-node-74f1f971d3b2`); neutering the verify
  verdict reddens only the fails-verify case. Both restored byte-identical under `shasum -c`. The
  exit code is deliberately the discriminator nowhere: this criterion already recorded a mutation
  that still exited 3 because a later preflight refuses with the same code.

  `TOTAL_EXPECTED` 107 → 111, **derived** by the hand method rather than incremented:
  `6 pass, 105 skip, 0 fail. Ran 111 tests across 12 files.`

- **ISC-48 closed: the minted token's identity is asked of GOOGLE, not asserted from the argv.** The
  criterion names a TOKEN, and until ISC-248 no `up` path minted one — so the previous close-out
  could only check the PLAN (every grant line names the SA, the operator's account never consulted),
  which is a real property and not this one.

  Both of the entry's stated blockers turned out to be false, and neither was removed by anything
  done to this criterion. *"`gcloudMinter` has NO CALLER ANYWHERE IN `src/cli/**`"* died with
  ISC-248. *"No real granted SA was available to test against"* was environmental: the old refusal
  was correct on its facts — the only discoverable service accounts belonged to a live production
  project — but a target now exists in the SAME personal project as the CI identity, with
  `roles/iam.serviceAccountTokenCreator` already granted to `cmux-fleet-ci`. **Nothing was created
  to close this**; the SA, the IAM binding and the `GCP_IMPERSONATION_TARGET` secret all already
  existed and were simply wired nowhere.

  The probe mints through the production `gcloudMinter` with impersonation and sends the token to
  the standard introspection endpoint — in a POST **body**, since a bearer token in a query string
  lands in logs and proxy history. Asserting that `mintArgv` carried `--impersonate-service-account`
  would prove we *asked* for impersonation, not that we got it.

  **It took three attempts to ask correctly, and both failures were mine rather than the product's.**
  The first asserted `email === <SA>` on the impersonated token and failed in CI with the literal
  string `(tokeninfo named no identity)` — a fallback that was a second defect in its own right, a
  diagnostic reporting only its own inability to answer. The second returned the claims whole (safe:
  the response echoes claims, never the credential) but moved the same assumption onto the CONTROL,
  asserting the un-impersonated mint reports an `email`. It does not, in CI.

  **Which claim carries the identity depends on the credential, and both reachable shapes were
  introspected rather than assumed.** A user credential — the operator's local ADC — returns `email`
  + `sub` + `azp` with `openid` and `userinfo.email` among its scopes. The CI credential is
  federated and already a service account: it returns `azp=106755930525734032049` and **nothing
  else** — no `email`, no `sub`, scope `cloud-platform` alone. That number is `cmux-fleet-ci`'s
  `uniqueId`, confirmed by `gcloud iam service-accounts describe`, so tokeninfo does name the
  principal there; it just uses a different field. An access token carries `email` only when its
  scopes include `openid`/`userinfo.email`, and a service-account token is minted with
  cloud-platform alone.

  So every assertion is now over the **set** of identity-bearing claims (`email`, `sub`, `azp`;
  `aud` excluded, since it names the token's audience rather than its presenter) and none of them
  names a field. Three, in order: a **control** — the un-impersonated mint names *somebody*, without
  which tokeninfo cannot see identity here and nothing after it means anything; **substitution** —
  the impersonated token's claim set is **disjoint** from the control's, which is the criterion's
  literal *"not the launching user's account"* and cannot be dodged by surfacing the same principal
  under a different key; and **positively the SA** — the service account's numeric `uniqueId`,
  resolved from the SA itself rather than hardcoded, appears among the token's claims. Disjointness
  alone would also be satisfied by some third principal, which is why the positive half exists.

  **The probe found a hole in the CI credential setup, which is worth more than the criterion it
  was written for.** `gcloud iam service-accounts describe` failed with `Failed to load credential
  file: [.../gha-creds-<id>.json]` — a path the "Move the federated credential out of the
  workspace" step had relocated minutes earlier. That step re-points
  `GOOGLE_APPLICATION_CREDENTIALS` and calls `gcloud auth login --force --cred-file` precisely so
  that "leaving it dangling would break any plain `gcloud` call the probes make". It did not:
  `google-github-actions/auth` also exports `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, which gcloud
  reads in preference to the account store and which still named the workspace path. Every plain
  `gcloud <api>` call in that job was broken, invisibly, because nothing made one — the ADC mints
  follow a different variable and were fine, and the step's own verification only exercised that
  half. Both stores are re-pointed now, by comparison with the source path rather than
  unconditionally, and the step proves both mints before the job proceeds.

  **One IAM change was made**, recorded here rather than left to be discovered: `cmux-fleet-ci` held
  no project-level roles and no permission to READ the SA it may impersonate, so `service-accounts
  describe` would have failed in CI. It was granted `roles/iam.serviceAccountViewer` on that single
  service account — read-only, one resource. The alternative was hardcoding the `uniqueId` into the
  test, which would compare a constant against itself the day the SA is recreated.

  **The delegation caveat stands and is not closed by this.** At real mint time the operator's ADC
  IS used to obtain the SA token, so "the launching user's account is never consulted" is true of
  planning and cannot be true of the mint itself. What the criterion claims, and all it claims, is
  that the issued token's identity is the SA.

  **CI-only, stated rather than hidden:** the `tokenCreator` binding is granted to `cmux-fleet-ci`
  alone, so minting impersonated from a developer host returns `IAM_PERMISSION_DENIED` and the probe
  self-skips with a message naming what it needs. Granting the role to a human account to make it
  locally runnable was deliberately not done.

### Changed

- **The chain probe tolerates ONE tool flail the model recovers from, instead of demanding zero.**
  `full-chain.test.ts` asserted `tool_errors === 0` while its own failure message argued the
  opposite — *"a model that flails once and recovers is not the same failure as a chain whose tool
  dispatch is broken"* — and then graded the two identically. Measured on 2026-08-27: four
  `container-live` reruns in one day (#84 twice, #89, #91), every one the same shape, a single
  `edit` whose `old_text` did not match followed by a corrected call that landed. Roughly eight
  minutes each, no product defect among them.

  The bar is now `tool_errors <= 1` **and** an error ratio under one third, and a loosened bar is
  only defensible if it still fails what the strict one caught. Checked against the record — this
  job's one real find was the uid defect in `ci.yml`, 17 tool calls with 11 failing on `EACCES`:

  | case | err/calls | ratio | `<= 1`? | `< 1/3`? | verdict |
  |---|---|---|---|---|---|
  | #84 / #89 flail | 1/6 | 0.17 | yes | yes | pass |
  | #91 flail | 1/4 | 0.25 | yes | yes | pass |
  | the uid defect | 11/17 | 0.65 | **no** | **no** | **fail** |
  | 1 error in a 2-call turn | 1/2 | 0.50 | yes | **no** | **fail** |

  Every flake that cost a rerun passes, the defect still fails on **both** guards, and a lone error
  in a turn too thin to have recovered from it still fails on the ratio. Recovery is not assumed
  either: `last_event === "agent_end"` and the ISC-290 file-edit assertion already rule out a model
  that errored once and gave up.

- **ISC-41 and ISC-47 re-graded `[~]` -> `[x]`. Neither criterion's code changed; their GROUNDS had
  become false.** ISC-41 said its deciding probe was *"LOCAL ONLY, not re-checked anywhere
  automated"*; ISC-47 said it *"SKIPS IN CI; nothing automated re-checks it"*. PR #82's keyless
  federated credential made `HOST_ADC_PRESENT` true through the production `hostAdcFile()` lookup
  rather than a test-only branch, and both probes un-skipped without a line of them changing.
  Verified by **reading the CI log**, not inferring from config: run 33032039999 shows both passing.

  ISC-47's two stated gaps are also closed, both by other work: *"nothing in `src/cli/**` mints or
  injects at all yet"* is false as of ISC-248, and the elapsed-interval gap is closed by ISC-248's
  probe, which compresses `token_refresh` in config and lets it genuinely elapse.

  A new `isa-claims` entry pins `EXPECTED_HOST_ADC_MINT_SKIPS: ""`, because both grades now depend
  on those probes being **required** to run — an operator who pinned them as expected skips would
  rot two grades silently. Mutation-proved: changing the pin fails the registry with
  `RE-GRADE ISC-41`.

### Fixed

- **The ISC-154 quiesce diagnostic is now READABLE, and the null it explains no longer has an
  unnamed third cause.** The diagnostic shipped days earlier wrote its reason to `events.jsonl`
  inside the run directory — and a CI runner is destroyed with that file on it. On 2026-08-27 a
  `container-live` run failed `expect(record.tree_hash).not.toBeNull()` with the message *"the
  supervisor took no quiesce sample"*, and the reason was in practice unrecoverable. The diagnostic
  existed and could not be read, which is the same defect it was written to remove, one layer out.

  Two halves, because there were two problems.

  **The reason now travels in the failure message.** `quiesceSampleDigest` reads the same
  `events.jsonl` and prints what the supervisor said, exactly as `toolErrorDigest` already does for
  the model's erroring tool calls two assertions above it. It POLLS rather than reading once:
  `logEvent` queues appends on a chain shared with the worker's stderr, so under a flood the record
  can be enqueued before the task record is written and land on disk after it — a single read that
  lost that race would report "no event" and send a reader hunting a bug that is not there.

  **A null hash had THREE origins and only one of them said anything.** `worktreeContentHash`
  failing emits `quiesce_sample_failed` with a reason; `settledWorkdir === null` emitted NOTHING and
  produced the identical null. So "no failure event" was ambiguous between *the sampler ran and
  could not answer*, *the epoch owned no workdir so nothing was sampled*, and *the sampler was never
  reached* — three different bugs behind one silence. The skipped case now logs
  `quiesce_sample_skipped` with its reason. It is deliberately not logged as a failure: a task
  dispatched with no worktree is a legitimate shape, so the event records why no sample was taken
  rather than complaining that none was.

  Mutation-proved: removing the `quiesce_sample_skipped` call fails
  `supervisor.test.ts`'s "a task with no worktree settles with a null hash, not a guess" with
  `Expected: true / Received: false`. The test asserts the REASON, not merely the event type — an
  event type with an empty reason is the same silence wearing a name.

### Added

- **The supervisor now runs the credential refresher (ISC-248) — and, it turned out, injects the
  initial token at all.** `TokenRefresher` had been unit-proved and callerless for two phases:
  `grep -rn 'security/refresh' src/` returned nothing, so the criterion's verb — *runs* — had no
  evidence and could have none. The recorded reason was honest (it attaches to a running container;
  the headless path started none) and stopped being true when the container launcher landed
  (ISC-286/287).

  **The gap was larger than the entry claimed.** `injectToken` and `gcloudMinter` had no production
  callers either. So there was no refresh loop AND no initial injection: the container got the
  gcloud tmpfs and the env pointing at `TOKEN_FILE`, and nothing ever wrote a token there. A
  `cloud_access: true` worker had a credential-shaped hole, not a stale credential.

  The credential PLAN now rides in `WorkerLaunch` — `planCredential`'s output, written by
  `run/materialize.ts` where config is known and read where the container is known, on the launch
  record's own argument that a detached supervisor does not share the cwd and environment `up`
  resolved in. The supervisor constructs a `TokenRefresher` after the container spawn and drives
  `run(signal)`, which ticks due-at-0, so ONE path serves both the initial injection and the loop
  rather than two places for the mint, the record and the failure handling to drift.
  `refreshAbort.abort()` on shutdown tears it down — without it the process holds a live loop and a
  pending timer and does not exit.

  **A failed mint degrades the worker loudly; it does not kill it.** An owner decision: a transient
  `gcloud` hiccup must not destroy a worker mid-task, but a worker configured for cloud access that
  silently has none is indistinguishable from a healthy one until a later task fails naming the
  wrong component. `state.credential.degraded` is set where `status` reads it, and is cleared by the
  next success rather than by time. `credentials.jsonl` is a new append-only sibling carrying every
  `CredentialInjection` — which has no token field by construction.

  **Probed against the real thing.** The 23 unit tests drive `tick()` on a fake clock, which is the
  right way to pin a schedule and structurally cannot answer "does a real supervisor start one".
  The closing probe uses a real supervisor, a real container and a real federated credential with
  `token_refresh` compressed to 2s — the only faked value, faked in the field an operator sets.
  Mutation-proved on both limbs: disabling the wiring fails it with `Received: 0`, and swapping
  `run()` for a single `injectNow()` fails it with `Received: 1`. Deliberately NOT asserted: that
  the token VALUE changed between generations — gcloud serves a cached token until near expiry, so
  that would pin gcloud's cache rather than this loop.

### Changed

- **The `scanOutboxFiles` hard-link test stops pinning WHICH defence catches the attack, and the
  `nlink` check gains a fixture that can pin it.** `test/unit/harvest-outbox.test.ts` asserted the
  refusal reason contained `"link"`, on a stated premise that "realpath resolves this INSIDE the
  outbox — the inode's other name is invisible from here". That premise is only usually true.
  `realpath(3)` may return ANY of a hard-linked inode's names, and on macOS/APFS it periodically
  returns the ORIGINAL one — the containment check then fires first with
  `file escapes the outbox (→ …/private/id_rsa)`, which contains no `"link"` at all.

  **Measured, not inferred:** over 60 fresh scans of that exact fixture, 17 took the containment
  branch and 43 took `nlink` — 28%, which accounts for the intermittent unit-suite failure seen at
  roughly one run in four. Both branches are correct refusals of the same attack; only the
  assertion was wrong.

  The attack test now asserts the OUTCOME — nothing accepted, and the reason is one of the two
  legitimate defences rather than an unrelated failure (EMFILE, "vanished", the descriptor cap)
  that would refuse it for reasons that are not security properties. Pinning `nlink` specifically
  needs a fixture where containment CANNOT fire, so a second test hard-links two names that both
  live inside the outbox: `realpath` resolves to a contained path whichever name APFS returns, and
  link count is the only check left. Deleting the `nlink > 1` branch fails both tests.

- **BREAKING: `pifleet down --force-identity` now takes a pid, and is repeatable.** As a bare
  boolean the flag meant "re-anchor on whatever holds the recorded pid, **for every worker in the
  run**" — the rung-0 self-anchor that ISC-272's criterion forbids in as many words ("never a start
  time read off the pid at rung 0"). An operator who typed it to stop ONE stuck supervisor also
  authorised the kill ladder against every other pid the run recorded, including — on a run whose
  pids the machine has since reissued — strangers nobody had looked at.

  The hatch is unchanged in kind and narrowed in reach. `down` still refuses every pid it cannot
  confirm and still prints each one; forcing now requires naming those numbers back:

  ```
  eng-1: refused to signal pid 41337 — …; re-run with --force-identity 41337 to signal it anyway
  ```

  Killing a stranger remains reachable — that is what a force flag *is* — but it now requires
  having looked at a pid and typed it, rather than typing a flag that meant "all of them, whatever
  they are". The refusal messages and `--prune` reasons carry the exact pid so the next command is
  handed to the operator rather than left to be assembled.

  **The bare spelling is now a usage error**, deliberately: a flag that used to mean everything must
  not keep meaning everything by omission. Scripts passing bare `--force-identity` will fail loudly
  rather than silently authorise the old blast radius.

  This closes ISC-191 residual (a) and the `--force-identity` half of ISC-272's open clause.
- **The ISC-154 quiesce sample now records WHY it could not be taken, and its bound moves 10s ->
  30s.** `worktreeContentHash` collapsed three different facts — git timed out, git failed, or the
  snapshot threw — onto a single `null`, one function below `writeTreeSnapshot`'s own docstring
  warning that catch-and-discard is *"where the reason for the failure goes to die"*. A CI run
  settled `success`/`quiesced` with a null hash and the chain probe reported "the supervisor took
  no quiesce sample"; no artifact anywhere said which failure had fired.

  The sampler takes an optional `onFailure`, called **at most once** with the deciding reason, and
  the supervisor logs `quiesce_sample_failed` / `live_sample_failed` events carrying it. The latch
  is load-bearing rather than tidy: `Promise.race` does not cancel the loser, so a timed-out sample
  would otherwise ALSO report git's later verdict — one missing hash, two conflicting reasons.

  The latch test asserts that ONE reason comes out, not which one. Which side of the race wins is
  scheduling: `setTimeout(…, 1)` fires when the loop next reaches its timers phase, and on a loaded
  runner git's exit can already be queued when it resumes. The first draft pinned the timer as the
  winner, passed locally seven times, and failed in CI — it had encoded one machine's scheduler as
  a property of the code. "The deciding reason" needs no assertion anyway: `report()` is called
  synchronously by whichever side settles first, so the reason that latches and the reason that
  decides the return value are the same event.

  **The return type and the verdict are unchanged**: still `string | null`, and a missing hash still
  voids nothing.

  `TREE_HASH_TIMEOUT_MS` is raised to 30s by owner decision. The cost is stated at the constant:
  `settle` now waits up to 30s on a wedged git before giving up, on every settle path. The
  suspicion that the bound was what fired is **not yet confirmed** — the diagnostic that would
  confirm it landed after the decision, so the next `quiesce_sample_failed` event is what settles
  it.

- **SRD §5.9 is retitled "The LLM is a private oMLX instance" — the constraint is PRIVACY, not
  LOCATION.** The section had been chasing its own code through two amendments: it began as "the LLM
  is local — oMLX on the Docker host", became "self-hosted — the Docker host or a trusted LAN peer"
  when a LAN server was permitted, and would have needed a third clause the moment an operator
  fronted their own server with a tunnel. Enumerating permitted *places* was the wrong axis — each
  new place read as a relaxation of the rule when none of them touched the rule at all. **Private
  means the operator runs the process, holds its key, and decides who may reach it.** The
  prohibition that actually matters — **no hosted provider, in any role, ever** — is unchanged and
  is explicitly not what this relaxed; none of the permitted deployments introduces a third party
  who serves the model.

  Three shapes are now named, and §5.9 states plainly that they are **not equivalent in exposure**:
  the Docker host (default — the key never leaves the machine), a trusted LAN peer (one unencrypted
  hop), and a private tunnel to the operator's own server (the public internet, TLS to the tunnel
  edge). Choosing among them is an operator decision with a security consequence, not a config
  detail.

  **No behaviour changes.** `relay_upstream` must still be an IP literal or the Docker-host alias —
  that rule came from a measured resolver failure, not a locality assumption, so "private instance"
  does not license a hostname there. `llm.base_url` still names `host.docker.internal`. Under the
  tunnel shape the tunnel terminates at a local listener, so the relay still dials the Docker host
  and §12.8's reachable set gains nothing.

- **SRD §12.4 re-takes the LLM credential argument for a tunnelled instance, and it does not
  inherit the LAN one.** The LAN residual rests on one row — *"an attacker is already adjacent to a
  port they can open anyway"* — which bounds its blast radius. For a publicly-resolvable endpoint
  that row is **false**: the key stops being one lock on an already-reachable port and becomes the
  **sole** gate. Transport gets better (TLS to the edge rather than cleartext `http://`); the
  reachable set gets much worse. Accepted as a residual on the unchanged basis that the key carries
  no billing authority, no cloud identity and no data at rest, and that the Class 2 Google
  credential never traverses this path — with a **stricter revisit trigger** than the LAN shape: a
  shared or guessable key is no longer proportionate when it is the only thing in front of the
  server.

### Fixed

- **Two fleets can now run against one repo, and a crashed run no longer blocks the next one
  (ISC-295).** A worker's checkout lived at `<repo>/.worktrees/<worker>` — keyed on the worker id
  alone — so two runs naming the same worker resolved to the same directory. `up` refused the second
  rather than adopting another run's tree, which was the right call and is unchanged; but it meant
  concurrent fleets against one repo were impossible, and a run that crashed left a checkout that
  blocked every later run of that worker until someone deleted the directory by hand. `git worktree
  prune` did not help: git's own metadata is pruned first, and what remains is an orphan directory git
  no longer tracks. Checkouts are now `<repo>/.worktrees/<run-id>/<worker>`, matching the branch,
  which was already run-scoped. `down --prune` removes a run's directory once its last worker is gone.

  **If you have checkouts under the old layout**, they are now orphans — nothing will find or reuse
  them, and nothing will delete them either. `<repo>/.worktrees/<worker>` (a worker id directly under
  `.worktrees/`, rather than a run id) is the old shape; remove those by hand once you are sure they
  hold no work you want.

- **Workers on the deny-all egress network can no longer reach the Docker host (ISC-51).** `--internal`
  was never the containment it reads as: Docker implements it in the FORWARD chain, which bounds
  traffic *leaving* the bridge, but the bridge gateway is on-link and inside that subnet, so
  gateway-destined packets went through INPUT unfiltered. A worker with no relay running could pull a
  live sshd banner off `172.18.0.1:22`, and every other port the Docker host listened on in its own
  network namespace was reachable the same way — while `up` reported the egress posture as deny-all.
  `pifleet up` now installs a firewall rule scoped to one bridge and one address
  (`-I INPUT -i br-<id> -d <gateway> -j DROP`) and **refuses to start if it cannot**, rather than
  running a fleet whose reported posture is not its real one. Container-to-container traffic and
  Docker's embedded DNS are unaffected — neither is gateway-destined.

  **Two operational notes.** pifleet needs no new privilege of its own and never calls `sudo`: the
  rule is written through the Docker daemon, in a privileged container joined to the daemon's host
  namespaces, so it lands on the machine whose listeners were actually exposed — on macOS that is the
  Lima/colima VM, not your Mac. And `pifleet down` deliberately leaves the rule in place, for the same
  reason it leaves the egress network and the relay standing: the network outlives the run, so
  removing the rule with the run would reopen the hole for whatever attaches next.

- **`dispatch --auto` no longer abandons a run before its own tasks are due (ISC-293, ISC-294).** The
  fleet-wide no-progress ceiling was a fixed ten minutes while `deadline_s` defaults to thirty, so a
  perfectly healthy task list was refused with `rc=4` and *"workers are alive but not settling"*
  twenty minutes before anything was late — and an operator reading only the exit code concluded the
  fleet hangs, on runs that settle, harvest and adjudicate on their own. The ceiling is now derived
  from the list being scheduled: the longest `deadline_s` plus ten minutes of grace. The timeout
  message names that derivation, so the number is auditable where it bites. A non-finite ceiling is
  now refused outright rather than obeyed — it does not disable the backstop, it makes the run poll
  forever.

### Added

- **`pifleet up` now re-points the egress relay when `llm.relay_upstream` changes, instead of
  adopting the old one (ISC-265).** A running relay was recognized by NAME alone, so moving the
  fleet to a different oMLX did nothing until an operator ran `docker rm -f` by hand — and the
  resulting failure was silent rather than loud: every worker connected, got real completions, and
  was talking to the previous server. `up` now reads `PIFLEET_RELAY_TARGETS` back off the running
  container and compares it as a set against what the config resolves to; a relay forwarding
  somewhere else is removed and rebuilt, and a new `relay_targets_replaced` ledger event records
  what was displaced. A relay whose targets cannot be read is replaced too, rather than trusted.
  **Operators sharing one egress network should know the trade this makes:** the relay is shared,
  so a replacement interrupts a concurrent fleet's in-flight turns. That is deliberate — with
  drifted targets the two fleets already disagree about a single shared resource, and the previous
  behaviour resolved the disagreement silently in favour of whoever booted first.

- **A durable file with an unrecognised stamp now refuses by name instead of throwing a library
  error (Phase G, ISC-157, ISC-192).** Both criteria asked to *read* an older file "rather than
  failing"; the owner chose the opposite deliberately — **refuse by design, named, with a hatch** —
  so both were **restated and closed against the restatement**, not built as written. No version
  stamp was added to ledger records and no `v0 -> v1` upgrade ladder exists. **Measured before it
  was fixed:** a `v0` stamp threw a bare `ZodError` whose message's first line was the lone
  character `[`, and a truncated file a bare `SyntaxError`; neither carried an `exitCode`, so both
  left the CLI as a stack trace on exit 1, off the §10 ladder entirely. Four readers now separate
  **provenance from damage** — `readRegistry`, `control-auth`, `attended/mode` and `report/collect`
  each pair a schema error naming a build to go back to with a damage error that deliberately does
  not. The stamp is checked **before** the schema at every site, so a future `v2` renaming a field
  is not misdiagnosed as a missing one. Two of the brief's premises were wrong and were corrected
  against the tree rather than implemented: `attended/mode.ts` was already wrapped, and `collect.ts`
  already caught — what neither could do was tell version skew from damage.

- **`down` no longer treats an unreadable `ps` as a dead worker, which was the data-loss half
  (Phase G).** `processStartTime` conflated "`ps` failed" with "no such process", and `down`'s
  `anchorIdentity` maps that to the one verdict that reports `stopped: true`, calls `reapContainer()`
  and makes the worker **prunable** — so a broken `ps` could destroy a live worker's container and
  worktree. It now raises `IdentityReadError` and `down` reports `identity_read_failed`. The rule it
  rests on was measured, not assumed: on Darwin, exit 1 with empty stdout does **not** identify an
  absent process — a reaped pid, an out-of-range pid, a malformed `-p` and an illegal flag all
  produce it. Only silence on **all three** channels does.

- **`mergeLedger`'s shape tolerance is pinned, including the position clause (Phase G).** A
  malformed record does not crash the merge, it lands in `errors`, and every well-formed record
  around it survives **regardless of position**. The position half is load-bearing and was measured:
  under a mutation hoisting the try/catch to per-shard, the last-position test still **passes** while
  mid-shard reddens — so a merge that silently drops the tail after an error would have passed a
  naive test. This pins shape tolerance and is **not** a version policy: a record failing today's
  schema is discarded rather than read, and the merge cannot tell "written by an older writer" from
  "corrupt shard".

- **The launch preflight refuses before it can leave anything behind (Phase F).** The image-presence
  gate runs ahead of any clone, remote registration or supervisor launch, so a missing image costs
  nothing to recover from.

- **Every rung of the kill ladder now validates the process GROUP, not just the leader (Phase F,
  ISC-272).** `down` signals `-pgid`, so the previous weak anchor aimed SIGTERM and then SIGKILL at
  an entire group named by a possibly stale file. A group that disagrees with the OS, or that the
  identity-validated supervisor does not lead, now refuses the ladder (`group_unconfirmed`). No
  schema field was needed — a group is named by its leader's pid, so its launch-time identity *is*
  the leader's, already recorded. Mutation-measured on real spawned groups: with the old rung
  restored, `foreign group members: 24667,24669,24670` became `(none — DEAD)` while the actual
  supervisor was never touched.

### Fixed

- **`pifleet down` could kill an unrelated live process on the operator's machine (#36, ISC-191).**
  `down` did not use `safety/kill.ts` at all — it ran its own inline ladder whose gate was
  `processStartTime(state.pid) !== null`, which is **liveness, not identity**. `started` was compared
  at no rung, and the daemon rung signalled a bare pid even though `daemon.pid` stores `{pid, started}`
  written in one call. A bare `pifleet down` resolves the *latest* run, so after a reboot it climbs a
  ladder against pids the OS has since reissued. **This was not hypothetical**: reproduced directly,
  a pre-fix `down` SIGTERMed and killed a live unrelated `sleep`. It had also already fired once in
  the repo's own history — `down-prune.test.ts`'s fixture comment records that an early revision used
  `process.pid` and `down` killed the test runner's own process group five seconds in; the fixture was
  then changed to route *around* the hazard rather than remove it. `down` now resolves a `ProcId` and
  climbs every rung on `signalIfSame`/`sameIdentity`.

- **A durable write that landed could be reported to the caller as failed (#29, ISC-218).** Only
  `dh.sync()` was guarded in `writeJsonAtomic`; the `open(dir, "r")` in front of it was not. Opening a
  directory needs **read** permission while writing and renaming inside it need only **write+search**,
  so against a `0o300` directory every durable step ran — tmp written, fsynced, renamed into place —
  and then the call threw `EACCES` at the caller with the correct file sitting on disk. Verified before
  fixing. A caller told "failed" retries, reports a broken worker, or unwinds a state machine over a
  file that is present and correct; downgrading the durability of a directory *entry* across power
  loss is strictly better than that. `fsyncDirBestEffort` now swallows the open, the sync **and** the
  close — the close because on some filesystems a deferred error surfaces there.

- **`up` would have died on its first real container launch (#43).** `render.ts` pushed
  `--env-file <run>/workers/<id>/env` unconditionally and nothing wrote that path — confirmed:
  `docker: open …/env: no such file or directory`. The omission was **deliberate**, a tripwire so a
  premature launch failed loudly rather than quietly. `src/run/worker-env.ts` is the writer it was
  waiting for, at mode 0600 because it carries the oMLX key, and the variable names come from
  `docker/entrypoint.sh` because that is the code which consumes them — getting them wrong doesn't
  crash, it produces that script's own stated worst case, a worker that "streams tokens happily and
  can reach no model at all".

 by the reaper while still alive
  (Phase F, found by review, not by grading).** Adding `group_unconfirmed` to `KillOutcome` was
  invisible to `tsc` for consumers that only *stored* the value: `reaper.ts` gated `docker rm -f` on
  the container merely being present, `registry.ts` deregistered every report it was handed, and
  `monitor.forget` dropped the staleness clock. A supervisor that was not its own group leader went
  stale **while alive**, was never signalled, lost its live container mid-write, lost its name in
  `registry.json`, and became invisible to every later scan — recorded in the ledger as
  `worker_reaped`. Fixed with three exhaustive switches carrying `never`-typed defaults, deliberately
  **not** one shared predicate, so a seventh member must be answered at all three sites by someone
  looking at all three.

- **Eight of ten guards added by the Phase G review were held in place by nothing (guard audit,
  `ac0d2a8`).** Each new guard was reverted in turn to see whether anything reddened. Reverting all
  five of `kill.ts`'s at once left 1335 unit and 19 reaper tests **green** — `processStartTime` got
  guards and tests, `processGroupId` got byte-identical guards and none. All ten are covered now.
  What still is not, stated rather than glossed: `down.ts`'s `waitGone` leniency, the worker rung's
  `how`/`stopped` guards and the daemon rung's outcome capture are **defensive, not exercised** —
  measured at thresholds 1 through 6, the verdict is `identity_read_failed` every time, produced
  earlier by the anchor or the SIGTERM rung.

### Changed

- **`soft_stop_at` is removed from `BudgetSchema` and `fleet.example.yaml` (#42, ISC-280).**
  **This is a behaviour change, not a tidy-up:** the schema is `.strict()`, so an existing
  `fleet.yaml` carrying the key now **fails validation** — including any config copied from the
  `fleet.example.yaml` that shipped it, which is the likely case. That is intended, but a bare
  `unrecognized key` describes it as a typo, and a typo and a removal want opposite reactions from
  a reader: one should be corrected, the other deleted. `REMOVED_KEYS` in `config/load.ts` gives the
  dotted path a message saying it was removed, why, and that deleting the line changes nothing. It
  was never implemented, and the SRD's risk rows **F12** (cost runaway) and **F24** (budget overshoot
  between polls) both named an "80% soft-stop" among their mitigations — so both overstated the
  product's protection against the two risks the budget machinery exists for. Both rows are now
  annotated rather than rewritten, because whether they need a replacement mitigation is an owner's
  call about risk.

- **`backend.kind` no longer defaults to `cmux` at the schema (Phase F, ISC-271).** It is
  `.optional()`, so `up` can distinguish an absent backend block from one explicitly set — without
  which every headless run silently became `cmux`. `up` now honours `config.backend.kind` when
  `--backend` is absent; an explicit flag still wins. **This affects every existing `fleet.yaml`.**

- **An identity value written before this build is reported `identity_legacy_format`, not
  `identity_mismatch`.** Pinning `ps -o lstart=` to `TZ=UTC LC_ALL=C` changes the bytes of every
  `started` value already on disk — including on a machine already in UTC, because `LC_ALL=C` also
  reorders the fields. Values written by this build carry a `utc1 ` tag; no locale renders a weekday
  as `utc1`, so the tag cannot collide with a legacy value. `--force-identity` is the named hatch.
  Reporting such a value as a mismatch would assert something false about the world and train the
  operator to reach reflexively for the one flag that re-opens the fail-open.

### Added

- **The run's budget is enforced on the dispatch path; five criteria closed from one call site
  (#37, ISC-235/114/115/193/109).** `src/safety/budget.ts` was finished, correct, thoroughly
  unit-tested — and imported by nothing. The audits that produced this are worth stating: a probe
  drove the real `runSchedule` with 6 workers against `max_concurrent: 2` and measured **peak
  in-flight = 6**; `EXIT.BUDGET` had **no runtime producer**, so no run could exit 5 for any reason;
  and `budget.json` had no path and no writer. `runSchedule` now calls `admit` before every dispatch,
  `settle`s on every terminal transition, drains in-flight work after a halt, and folds
  `budgetExitCode` into `worstExit`.

- **A wedged agent is now actually acted on (#40, ISC-110, ISC-117).** `classifyStall` distinguishes
  a QUEUED worker from a WEDGED one and had **no production caller**, so no worker was ever killed as
  wedged nor spared as queued by any code path; `event_stall_warn`/`event_stall_kill` were parsed by
  the schema and read by no production line. This could not have been wired before #37 — a worker can
  only be *queued* once admission is on the dispatch path. The policy moved to `src/safety/stall.ts`,
  which imports **nothing**, because `scheduler.ts` importing it from `kill.ts` tripped a module cycle
  (`ReferenceError: Cannot access 'realProcessOps' before initialization`); a module with no imports
  cannot be in a cycle, and `kill.ts` re-exports it so every existing caller keeps its address.

- **`doctor` reports whether the oMLX endpoint serves every `models_allowlist` entry (#35,
  ISC-256).** Both sides decompose per §6.1 first, matching `assertModelAllowed` — a raw compare
  would have `doctor` calling `omlx/X:high` unserved while `up` accepts it. **The check runs only
  against a list actually fetched**, and that gate is asserted rather than assumed: an unreachable
  endpoint serves nothing, so an ungated check would report every entry missing and send an operator
  off to edit a *correct* allowlist — on the default config that would fire on every machine, every
  run. Live evidence for the motivating finding: `fleet.example.yaml`'s three allowlist names give
  **0/3 served, exit 3**, including `Qwen3.5-35B-A3B-8bit` missing the served `-4bit` by a single
  character.

- **The control socket answers `export_html` (#32, ISC-234).** Forwarded to Pi's RPC at 8s, under
  the CLI's 10s fallback, with both directions proved on one run: `source: "rpc"` while the worker
  lives, `source: "local"` once it is gone. **Limit recorded on the criterion:** proved for a
  host-process Pi only — a containerised Pi resolves the path in the container namespace and degrades
  to the local render.

- **Five anti-criteria now have probes that can actually fail (ISC-138, 139, 140, 165, 199).** An
  `Anti:` criterion asserts an *absence*, which is the one claim a green suite cannot make on its
  own — each was satisfied by a codebase that had simply not done the forbidden thing yet. Every
  guard in `test/unit/anti-criteria.test.ts` is **mutation-verified**: seven planted violations,
  seven reds, baseline green before and after. **ISC-139 changed shape under measurement** — the
  first draft banned the bare tokens `claude`/`anthropic`/`copilot` and went red on six legitimate
  sites, because `CLAUDE.md` is a *filename* this tool must know (`repo-hazards.ts` scans
  repository instruction files). It now matches attribution *constructions*, which have no
  legitimate use here. Its more useful half is a **capability pin**: the git verbs appearing as
  argv literals under `src/` are add, branch, checkout, config, diff, log, rev-parse, status,
  symbolic-ref, worktree — no `commit`, no `push`, no `gh` — so the criterion's commit and PR-body
  clauses are *vacuous*, and the test pins that fact so they cannot silently go live. **ISC-165**
  checks per test that a `:ro` write refusal also reads from the mount, since an absent mount
  refuses writes just as happily as a read-only one. **ISC-140** is split from ISC-21 because the
  two fail in opposite directions: a test needing egress fails closed and everyone finds out; a
  test needing provider spend passes and quietly bills someone. **ISC-199** bans hardcoded `ps`
  output spellings, not `ps` itself. **ISC-138 is a bookkeeping correction** — its guard already
  existed beside ISC-137's, which had been `[x]` all along; the work was verifying it bites.

- **`adc_mode: file` is now tracked as a criterion rather than a caveat inside a closed one
  (ISC-268).** ISC-44 closed honestly about its `file`-mode probe — it "hand-writes the `-v` itself
  and inspects a shape it authored" — but that admission lived only in the prose of an `[x]`
  criterion, where nothing re-reads it. The measured state: `ADC_FILE_PATH`, `fileModeMaterials`
  and `fileModeStartupEnv` have ZERO callers in `src/` outside `adc.ts`, and `buildDockerArgv`
  emits no `/creds` mount, so `adc_mode: file` is accepted by the schema and does nothing. A mode
  that neither works nor fails is worse than an absent one: it surfaces as an unexplained
  permission error inside the container instead of a refusal at launch. It also leaves ISC-44's
  mount guard with one carve-out — the single ADC file `file` mode may mount — defending a path
  nothing takes, so the guard's most delicate branch has no production coverage and would be
  load-bearing on its first real run. ISC-268 closes on either arm: wire the mode through
  `buildDockerArgv` and prove it by `docker inspect`ing a container built from production argv, or
  reject the value in the schema and delete the three symbols and the carve-out together. No code
  changed in this entry — this records a known gap where it can be counted.
- **The suite is now judged under deliberate load rather than only on a quiet box (ISC-266).**
  `.github/scripts/test-under-load.sh` runs a target under `ceil(cores * 0.75)` busy loops and exits
  with the suite's own status, and a separate `load` job in CI runs it on every PR. A budget that is
  too small — or a test whose spawn count grows without its `cliBudget(N)` growing with it — now
  fails a PR instead of a developer's afternoon. Measured: the full integration suite under eleven
  loops on 14 cores ran 375 pass / 81 skip / 0 fail in 300.87 s against 167.76 s idle, a 1.79x
  inflation with every budget holding. On CI the job is confirmed to apply real load rather than
  merely pass: the same commit ran `test/integration` in 124.32 s in the `test` job and 222.78 s in
  the `load` job — 1.79x, the same factor. **What it does not prove is stated in the job's own
  comment:** the runner reports two cores against the 14 these numbers came from, and none of the
  editor, language server, browser and concurrent agents behind the load average of 18.40 ISC-266
  recorded, so it reproduces the *shape* of the contention at a smaller magnitude — a floor on the
  evidence, not a ceiling. The harness's cleanup traps a recorded PID list and never `jobs -p`, which is empty in a
  non-interactive shell and would read as correct while killing nothing.


### Fixed
- **A dependency-gating assertion failed on the scheduler's tick granularity rather than on gating
  (ISC-267, second instance).** `dispatch-auto.test.ts` asserted `gapMs > 100` between two
  dependent dispatches, justified by six local runs of 237-262 ms. The **ISC-266 load job caught
  it** — `Expected: > 100, Received: 100` — and it was the first thing that gate caught. The gap is
  quantised by `DEFAULT_POLL_MS`: the scheduler re-examines readiness once per 100 ms tick, so a
  gated dispatch lands a whole number of ticks later, never a continuum. The local runs were 2-3
  ticks because `a` needed more than one tick to settle on 14 cores; on a two-core runner it settled
  inside a single tick, the gap fell to its floor, and a strict `>` placed exactly on that floor
  called the best possible correct behaviour a bug. The comment's claim that "the margin only widens
  under load" was the error — load changes how many ticks elapse, not the one-tick floor. Now `>=`
  against the exported constant, so the test tracks the scheduler; the discrimination is untouched,
  since a same-pass dispatch is ~0-5 ms, two orders of magnitude below one tick.

- **Ctrl-C on `pifleet logs --follow` exited 130 instead of 0 whenever the worker had a backlog
  (ISC-269).** The SIGINT and SIGTERM handlers were registered *after* the first drain had already
  returned, leaving that whole drain unguarded, so a signal arriving inside it got Bun's default
  disposition. **It was not intermittent** — the window is exactly as long as the backlog takes to
  render, so the failure is proportional to how far behind the follower is. Measured on the unfixed
  code, killing on first output: 200 000 buffered events exits 130 five times out of five, 20 000
  the same, 5 000 four times out of five, and a single event exits 0 five times out of five. That
  gradient is why the existing test read as flaky for a session — it uses a one-event fixture, the
  fastest-draining case there is. The handlers now go up before the first drain, inside the same
  `try/finally`, so a signal mid-drain lets the drain finish and returns cleanly. A new test gives
  the follower 50 000 events and requires exit 0; mutation-verified `Expected: 0, Received: 130`
  against the unfixed source. A signal arriving before any output still exits 130, deliberately —
  nothing has been emitted, so there is no session to end cleanly.

- **Integration tests that spawn the CLI were failing on busy developer machines and passing in CI
  (ISC-266).** They inherited bun's default 5000 ms per-test budget — a number with no relationship
  to the work they do. Under ten busy loops on 14 cores, three `harvest.test.ts` tests died at
  exactly 5001-5003 ms (the timeout, not the work) and one reached 9991 ms once the budget was
  lifted; it failed 3/3 consecutively, so this was consistent under load rather than intermittent,
  which is why it first read as a genuine breakage. The harm is not the red test — it is that a red
  test on a busy machine gets dismissed as "the flaky one", which trains people to discount red
  generally, the same erosion a self-skipping test causes from the other direction.
  **The ceiling could not be raised repo-wide:** bun 1.3.11 ignores `[test] timeout` in
  `bunfig.toml` (probed — a deliberately-6s test still died at 5001.03 ms with `timeout = 12345`
  set), and `--timeout` only covers the invocation that passes it, so neither protects a developer
  running a bare `bun test`. `test/support/budget.ts` therefore computes
  `cliBudget(N) = max(5000, N * 1900 * 3 * 2)` from the spawns a test actually performs. `1900` is
  **not an average**: spawn cost is not uniform — `report` and `artifacts --all` grade a whole run
  at ~1.3-1.6 s each while `artifacts --task` and `render` cost ~50-200 ms — so it rounds up the
  worst single expensive spawn measured and charges every spawn at that rate on purpose. The result
  stays **bounded**: a genuinely hung subprocess still fails, because an unbounded budget trades a
  flaky test for a hanging suite. Eight budgets were applied where a test was at risk and had none;
  eleven pre-existing hand-picked budgets were audited and **not one was reduced**. Three slow tests
  are deliberately left alone because spawn count does not describe them — `supervisor`'s ISC-212
  test measures 11415 ms against a derived 11400, `acceptance`'s ISC-152 test spawns no CLI at all,
  and `worktree`'s L443 drives git in-process — and deriving budgets for those would have
  *tightened* passing tests. Not one assertion was weakened: zero `expect(...)` lines changed.

- **A CI-executable guard test was failing on the clock's precision rather than on the property it
  defends (ISC-267).** `doctor-omlx.test.ts` asserted a measured latency against the delay its stub
  **requested** (`await Bun.sleep(40)`). A sleep is a request to be woken no earlier than N, not a
  guarantee a caller can assert on, and it came in at 39 on a GitHub runner — a run that was
  otherwise 374 pass / 1 fail. This is NOT the load-sensitivity of ISC-266: load makes a measurement
  take *longer*; missing a floor by 1ms is the opposite signature. Measured 400 trials on
  macOS/bun 1.3.11, `Bun.sleep(40)` never resumed early (min 40.032ms), so the defect does not
  reproduce on the maintainer's machine at all — which is why the fix stops depending on timer
  precision instead of tuning a margin. The stub now holds via a deadline loop the clock has to
  agree with, and the floor is the delay the stub **observed itself taking**. That cannot be flaky
  by construction: the client's interval strictly contains the handler's hold, and `Math.round` is
  monotonic. **Fixing it exposed a real hole**: the assertion's comment claimed a stamped-in
  constant would fail, and it would not — `completionLatencyMs = 42` cleared a 40ms floor and left
  the suite green. A floor is about magnitude; "tracks elapsed time", which the test is named for,
  is about variation. The probe now runs twice against different delays and requires the figure to
  move, so no constant satisfies both floors. Mutation-verified: `42` fails (it passed before),
  `5000` fails, a clock read twice fails.

### Security

- **The run dir — holding the 0600 control-socket secret — could be mounted into a worker container
  (#34, ISC-127).** Measured before fixing: with `run.repo` set to a checkout containing the runs root,
  the rendered `/workspace` mount was an **ancestor of `<run-dir>/control-auth.json`**, along with the
  ledger, the inbox and every other worker's state. This defeats the control-auth design directly —
  `security/control-auth.ts` states its threat model is "a worker that escaped its container", and the
  mount handed that worker the secret **without any escape at all**. `classifyRunDirExposure` /
  `assertNoRunDirMount` now refuse it from `buildDockerArgv`; two relations are refused and not three,
  because SRD §5.5 mounts run-dir *children* deliberately. **Framed honestly: this was latent
  hardening, not an active breach** — `rendered.docker` reached no `exec` at the time. **Known limit,
  recorded on the criterion:** the launch-time guard is lexical (`resolve`, not `realpath`), so a
  symlinked `run.repo` could evade it at launch.

- **No cloud provider key can reach any container's environment, enforced structurally (#34,
  ISC-31).** The guard enumerates **every** `docker run` argv builder in `src/` and applies two rules:
  no cloud credential by name — importing `adc.ts`'s own `CREDENTIAL_ENV_VARS` rather than a copy —
  and **no bare `-e NAME`** host pass-through. The second rule is what catches a key nobody thought to
  list: a planted bare `-e FOOCLOUD_API_KEY`, in no enumerated list anywhere, fails on secret shape.
- **The mandatory native-tool-call gate was certifying a network path no worker uses.** `up`
  probed oMLX from the HOST, through a helper (`hostFacingBaseUrl`) whose only job was rewriting
  the worker-facing `host.docker.internal` into `localhost` so the host could reach it — while
  every worker reaches oMLX from inside the `--internal` egress bridge, where that name resolves
  to the relay and nothing else resolves at all. On a Docker-host-local oMLX both land on the same
  box, which hid the asymmetry completely. It is not harmless: the gate certifies a model, the
  fleet launches, and the workers are denied at RUNTIME — the "burns a whole run before anyone
  notices" failure §5.9 makes this probe mandatory to prevent. A gate that certifies reachability
  it did not test is worse than no gate, because it is trusted. The probe now runs in a throwaway
  container on `docker.network` and dials `llm.base_url` verbatim, so it tests the workers' path;
  `hostFacingBaseUrl` is deleted rather than relocated, and `fetchImpl` lost its global-`fetch`
  default so a host-side probe is no longer one omitted argument away. Nothing here names an oMLX
  address, which is what makes it independent of where the server moves next: relocating oMLX
  rewrites the relay's dial target, not the probe.
- **The probe's API key travels on stdin, never in argv.** `docker run` argv is visible in `ps` to
  every user on the host and is recorded by `docker inspect` for the container's lifetime. The
  script goes in argv, where it is not secret; the URL, headers and body go in on stdin. The
  container test asserts the far end received an `Authorization` header without putting a
  credential anywhere in the repository.

- **The relay's `decide()` gate is no longer vacuous, and the oMLX server may now live on a trusted
  LAN peer.** These are one change, in that order, because doing them the other way round would
  have been dangerous. The gate that landed previously judged a target derived from `llm.base_url`
  against a policy whose LLM rule derived from `llm.base_url`: two derivations of one field agree
  without checking anything. That was survivable only because the relay threw unless the dial host
  was literally `host.docker.internal`, so the worst case was a port on a machine the operator
  fully controls — and that host pin is exactly what permitting a LAN oMLX removes. Pointing the
  dial side at a LAN host while the target was still an unchecked derivation of `base_url` would
  have made this module a TCP tunnel from a bridge running untrusted model output to an arbitrary
  `host:port` on the operator's home LAN, established by editing one YAML string. So the dial side
  was decoupled and gated against operator-written allow rules **first**, and the pin relaxed only
  after.
  - **New `llm.relay_upstream`** (`host:port`, explicit port) is what the RELAY dials. `base_url`
    keeps its `host.docker.internal` pin and means only what a WORKER dials — that alias is the
    only name resolvable on the internal bridge. Default is
    `host.docker.internal:<port from base_url>`, so **every existing `fleet.yaml` is unaffected**.
  - **Relay targets are judged by `relayGatePolicy`, not `policyFromConfig`.** This is the fix, and
    the distinction is not cosmetic: passing the new field to `policyFromConfig` would re-open the
    circularity through a different field, since `base_url: http://192.168.86.49:8000/v1` yields an
    LLM rule authorizing the very upstream under test. `relayGatePolicy` contains no config-derived
    host except ones the operator wrote as allow rules — a compile-time-constant host at the listen
    port, plus `egress.allow`. `google_hosts` are excluded, because the relay forwards no Google
    traffic and a rule for a path that does not exist must not authorize one that does.
  - **A LAN upstream therefore needs two edits in two config blocks**, one of which is
    unambiguously a security decision. `relay_upstream` alone is refused with `rule: default-deny`
    before Docker is contacted at all. Proven by mutation rather than by inspection: with the allow
    entry the upstream is accepted, without it — from a byte-identical target — it is refused, and
    mutating the source to re-derive a rule from the upstream turns 5 tests red while ignoring
    `egress.allow` turns 2 red.
  - **A hostname upstream is refused at `config validate`.** The relay resolves through Docker's
    embedded DNS, which forwards to the host resolver, and this machine's resolver does not answer
    mDNS/`.local` names (`macbook.local` needed `dns-sd`). A name there yields a relay that starts
    cleanly, reports ready, and fails every connection with an error no operator surface shows.
    Consequently `--add-host host.docker.internal:host-gateway` is now emitted **only** when a
    target actually dials the Docker host, so it is never inert argv implying a route nothing uses.
- **SRD §12.4's credential argument was quoted, retired and restated rather than quietly edited.**
  It justified injecting `OMLX_API_KEY` straight into workers because the key "carries no billing
  authority and no value off this host". The second clause was load-bearing and true *by
  measurement* — oMLX here binds `127.0.0.1:8000`, loopback only. A LAN oMLX is bound to a routable
  interface by definition and `base_url` is plain `http://`, so **the key crosses an unencrypted
  LAN hop on every request and now has value on at least one other host**. Recorded as an
  **accepted residual** on the stated basis that the LAN is trusted, with the conditions that would
  make TLS *required* named up front: if the key ever gates billing authority or data access, is
  reused for a credential that does, or the LAN stops being one the operator controls. No billing
  authority remains unconditional; the Google credential never traverses this path.
- **The bridge gateway residual is narrower than it was documented to be, and enumeration is what found it.**
  `test/integration/relay.test.ts` now enumerates all three terms of SRD §12.8's reachable set instead of
  sampling them — a full 1–65535 port scan of the gateway, of the relay's own bridge address, and an
  authoritative `docker network inspect` of bridge membership. The scanner is built from what the worker
  image already has: measured by running it, `nmap`, `nc`, `ncat`, `socat`, `ss`, `netstat` and `ip` are all
  absent, but bash 5.2.15 has `/dev/tcp` compiled in. The expected gateway set is **not** derived from a
  second probe of the same shape — that is circular in the way ISC-253's `decide()` gate was — but from
  `/proc/net/tcp` read in a `--network host` container, the kernel's own socket table, obtained without
  sending a packet. Measured: kernel `[22, 53, 39375, 40375]`, ordinary bridge `[22, 39375, 40375]`,
  deny-all bridge `[22, 40375]`. Two strict narrowings, so the subset assertion is not a tautology.
  **A published container port is NOT reachable from the internal bridge** — Docker's isolation DROP lives
  in FORWARD, evaluated after nat/PREROUTING has rewritten the destination to an address outside the bridge
  subnet — so the previous `reachable == served` assertion was false in general and held only because all
  five of its guessed candidate ports happened to be host-namespace services. The §12.8 residual is
  therefore every **host-namespace** listener, not every port the Docker host listens on. Nothing is
  inconclusive and nothing is vacuous any more: both beacons and the stray sibling are **planted** before
  anything is measured, which removes the old `[inconclusive]` early return that passed while proving
  nothing, and makes an empty-set comparison impossible to mistake for a working scan.
- **A live inference is now asserted through the relay, differentially.** A real completion —
  `gemma-4-26b-a4b-it-4bit` answering in 428 ms from inside the deny-all bridge, with `completion_tokens > 0`
  and the echoed model checked, because a 200 with an empty string is not an inference. Model selection is an
  **allowlist, never a heuristic**: the embedding model is first in `/v1/models` and answers chat with an
  error, and "the first id that is not obviously an embedding model" selects a model that SIGABRTs the
  inference server during generation. Error shapes do not generalise either — the same embedding model
  returns HTTP 500 on one host and HTTP 400 on another — so no classification rule is safe. The control is
  re-checked **after** any relayed failure, because the server can die between the two calls; only a relayed
  failure against a still-succeeding control is a real failure. The key is read from the environment and
  passed by name via `-e OMLX_API_KEY`, never into argv.
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
  Targets are now gated through `decide()` before argv is built. **That gate was circular when it
  landed** — the policy's LLM rule derived from the same field — and a test said so by name; it has
  since been made non-vacuous by the trusted-LAN change below, which is where it became blocking.
- **One idle container could deny the whole fleet its model server.** The relay dialled upstream on
  accept, before any byte arrived, with no timeouts and no connection cap: 300 client connections
  sending zero bytes took it from 19 open FDs to 619, with 603 matching unauthenticated connections
  against oMLX. Upstream is now dialled on first byte, both legs carry idle timeouts, and
  concurrency is capped. Also: only a listen failure is fatal (an accept-time EMFILE used to
  crash-loop the relay and cut model access fleet-wide), the relay gets the same pids/memory/cpu
  limits as the workers it shares a bridge with, IP forwarding is turned off in its netns, and the
  ports in its own env parsing are range-checked — `listen(0)` would have bound a random port and
  reported healthy.

### Changed
- **`up` runs the ISC-53 gate after the egress network and relay, not before.** Not a preference:
  on an `--internal` bridge `host.docker.internal` resolves to the relay, and resolves to nothing
  before the relay exists, so the probe cannot test anything real until both are up. It still runs
  before `run.json`, the ledger and every supervisor, so a refusal still launches nothing.
- **`doctor` says which vantage its oMLX numbers come from.** It reports `vantage: "host"` in
  `--json`, prints `omlx (from host):` in the text output, and uses `llm.base_url` verbatim
  instead of silently rewriting it — the old rewrite answered "can this host reach SOME oMLX" in
  place of the question actually asked, and stops being even approximately right once the server
  is not on this box. When a container-facing hostname is unreachable from the host, `omlx.detail`
  now explains why rather than leaving a bare "unreachable" that reads as an outage. That
  explanation is a note, not a diagnosis: as a diagnosis it made `doctor` exit 3 on a healthy
  machine, because any diagnosis is a failure. `doctor` deliberately does NOT probe from inside
  the network — doing so would make ISC-54/55's only CI-executable test require a Docker daemon,
  turning live coverage into a self-skip.

### Added
- **`llm.relay_upstream` — where the egress relay dials, as distinct from where workers dial.**
  `host:port` with an explicit port; unset means `host.docker.internal:<port from base_url>`, which
  is exactly the previous behaviour. Must be an IP literal or the Docker-host alias, and anything
  other than the Docker host also requires a matching `egress.allow` entry. SRD §5.9 is retitled
  "The LLM is self-hosted — oMLX on the Docker host or a trusted LAN peer"; **the no-hosted-provider
  prohibition is unchanged and is explicitly not what was relaxed.** The motivating measurement:
  this Docker host's oMLX serves 3 models and none of `fleet.example.yaml`'s three allowlisted ones
  (it has `Qwen3.5-35B-A3B-4bit`, not the allowlisted `-8bit`), so `up` exits 2 against it, while
  the LAN server at `192.168.86.49:8000` serves 32 including all three.
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
- **The relay suite ran in no CI job at all, and the live-oMLX probes skipped invisibly**
  (ISC-257, ISC-262). `test/integration/relay.test.ts` is `PIFLEET_DOCKER`-gated exactly like
  `image`/`verbgate`/`egress`/`adc`, but the `container` job named those four literally and
  the relay file was not among them, while the fast `test` job never sets `PIFLEET_DOCKER` —
  so ISC-50/51/57's evidence executed on one machine and nowhere else. It is now in the job's
  `bun test` list and in the guard's accounting, and its probes genuinely execute: measured
  against a real daemon, **5 pass, 1 skip, 0 fail**, with Docker networks and containers
  verified identical before and after. Separately, `test/integration/model-probe.test.ts`
  gates on `PIFLEET_OMLX=1` and `grep -rn PIFLEET_OMLX .github/` returned nothing, so its
  four probes skipped everywhere and nothing counted them; they are now graded by their own
  step in the fast job. **Be precise about that second one: it does not make those probes
  run.** They need a real Apple-silicon inference server no runner has, so they still skip —
  every one. What changed is that an invisible skip became a name-pinned, enumerated one that
  goes red if a probe is renamed, deleted, added, or starts skipping for a different reason.
  That is a real improvement and it is not coverage, which is why ISC-262 is graded partial
  and not closed. `TOTAL_EXPECTED` 66 → 72, recomputed once for both changes rather than
  twice against a moving target, and derived by a method now written into the workflow: run
  the same file list with the gate variable UNSET, where every gate closes and the collection
  total is the summary line (`0 pass, 72 skip`, 49ms, no daemon). No secret is wired in for
  either — `OMLX_API_KEY` would flip nothing, because both suites also require a reachable
  server, so shipping a live credential to a runner would be pure exposure for zero coverage.
- **The probe guard could not itself be tested, and is now.** The grading logic lived inline
  in `ci.yml`, where the only way to exercise it was to push and hope; a second job now needs
  the same grading with a different file list, and two copies of subtle shell is how a parsing
  fix lands in one and not the other. It is now `.github/scripts/probe-guard.sh`, and
  `test/integration/probe-guard.test.ts` drives it against fixtures and asserts it goes RED
  for each failure mode separately — a file dropped from the list, a pin whose test was
  renamed, a pinned test that ran instead of skipping, an unpinned test that skipped while
  the count still matched, a real failure reported as a failure rather than as total drift, a
  `test.todo()`, an empty file list, and a missing required variable.
- **The total-count check gave shortfall advice for a surplus.** Mutating `TOTAL_EXPECTED`
  against a real relay run printed "a test dropped out of collection entirely" when the total
  had gone UP, sending the reader hunting a file that was never deleted. A surplus is a live
  scenario rather than a hypothetical, because `bun test` arguments are SUBSTRING filters over
  discovered paths — `bun test pinned.test.ts` also collects `unpinned.test.ts`, measured — so
  a future file whose name contains a listed one is swept in silently. The check now branches,
  with a cause and a fix named for each direction.
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
- **The relay script was only valid CommonJS because of where it was mounted.** `package.json`
  declares `"type": "module"`, so `docker/egress-relay.js` was an ES module inside the checkout and
  its `require()` calls threw `ReferenceError: require is not defined in ES module scope` the
  moment anything ran it on the host. It worked in the container purely because the file is
  mounted alone at `/relay/` with no `package.json` beside it, so Node fell back to CommonJS —
  meaning the script's correctness depended on its mount location, and no amount of exercising the
  Docker path could have surfaced it. Renamed to `docker/egress-relay.cjs`, which is CommonJS in
  both places by definition. Found by the new host-side suite on its first CI run.
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
