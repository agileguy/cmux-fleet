# System Requirements Document — `pifleet` completion plan

**An ordered delivery specification for the 54 criteria `ISA.md` has not closed**

| | |
|---|---|
| **Document ID** | SRD-PIFLEET-002 |
| **Version** | v1.0 |
| **Date** | 2026-08-20 |
| **Author** | Architect |
| **Status** | DRAFT v1.0 — written against `ISA.md` at `progress: 239/293` (commit `4ad83f0`) |
| **Relationship** | Does **not** supersede SRD-PIFLEET-001. 001 is the *design*; 002 is the *order in which the remaining design gets built*. |
| **Input** | `ISA.md` — 35 `[ ]` + 19 `[~]` = **54** criteria |
| **Target repo** | `~/repos/cmux-fleet` |

---

## 0. Preamble

### 0.1 The one-paragraph thesis

`ISA.md` knows *what* is unfinished with unusual precision — every open criterion carries a
graded note naming what was measured, what was assumed, and what a test would have to hold.
What it does not carry is **order**. Its nineteen groups (A through S, plus "Phase 3") are
*filing* order: they record when a review round found a gap, which is a fact about the
project's history and carries no information about what must be built first. This document
supplies the missing axis. It classifies all 54 by root cause, derives a phase order from
dependency rather than from group letter or ISC number, and names the probe that closes each
one.

### 0.2 The three findings that shape the order

**Finding 1 — the 54 gaps have five causes, and two of them are not engineering.**

Nine criteria describe mechanisms that already work and that no CI runner can witness.
Three are disjunctions waiting on an owner's answer, where the two arms differ in size by an
order of magnitude. Scheduling either class as ordinary backlog mis-sizes the work by weeks.

**Finding 2 — the criteria that tighten *grading* must land before the work they will grade.**

Five items (ISC-254, 270, 273, 274, 278) are properties over the test suite itself: no leaked
`PIFLEET_*` env, no test on bun's inherited 5000 ms default, no `COPY` source outside
`BUILD_CONTEXT_ASSETS`. They read like end-of-project cleanup. They are the opposite — they
are the rules under which every later phase is graded. Landing them last means every PR
before them was accepted under weaker rules and has to be re-checked. They go **second**,
after the decisions and before any feature work.

**Finding 3 — the critical path to `ISC-290` is one code item long.**

`ISC-290` ("a worker container launched by `up` completes a real RPC turn end to end") is the
criterion that integrates all the others, and it reads like the last thing anyone could
possibly do. Its own note names exactly two blockers. The first — this Docker host's oMLX
serving none of the allowlisted models — was dissolved by `ISC-259`'s resolution: the SRD
§5.9 amendment permits a trusted-LAN oMLX, and the LAN peer serves all three. That blocker is
now **configuration**. The second is `ISC-291`: the host-side model probe dials
`llm.base_url`, whose host component is pinned to `host.docker.internal`, an alias that does
not resolve on the host — so `up` reports the server unreachable while it is running and
reachable. Fix that one probe, point `relay_upstream` at the LAN peer, and the end-to-end
criterion is attemptable. **It is two phases from done, not eleven.**

### 0.3 Precedence

Same rule SRD-001 states, extended by one line:

> Where this document and `ISA.md` disagree, **`ISA.md` wins** and this document gets a
> correction. Where this document and SRD-PIFLEET-001 disagree about *design*, **001 wins**.
> Where they disagree about *order*, this document wins — 001's §16 phase table describes the
> original build, which is complete through Phase 6 and does not describe the remainder.

### 0.4 Reading guide

§1 defines the input set. §2 classifies it. §3 argues the order. §4 is the phase table. §5 is
the critical path. §6 specifies each phase. §7 is the full 54-row assignment with probes. §8
states the grading rules a phase's exit criteria must survive. §9 records residual risk.

### 0.5 Start here

If you are opening one PR today, this is the whole decision:

```
  A  Decide          3 questions, no code          ── ask now, they gate I and J
  B  Suite guards    5 criteria, ~3 PRs            ── land before any feature work
  C  Proof plane     10 criteria, needs a runner   ── the long-lead item; start provisioning at A
  ───────────────────────────────────────────────────────────────────────────────
  D  Accounting      6    ┐
  E  Control seam    6    │  independent of each other — run in parallel after B
  F  Launch preflight 8   │
  G  Durable formats 2    │
  H  Evidence        4    ┘
  ───────────────────────────────────────────────────────────────────────────────
  I  Acceptance      3    ── needs A + F
  J  Egress          5    ── needs A + C
  K  End to end      5    ── needs C + D + E + F
```

**The single highest-value PR in the plan is `ISC-291` in Phase F** — one change in
`security/model-probe.ts` — because it is the only unbuilt code item between today and
`ISC-290`, the criterion that integrates the whole system (§5).

**The single highest-value non-code action is provisioning Phase C's runner**, because nine
criteria are already-working mechanisms with no witness, and no amount of engineering closes
them.

---

## 1. The input set

**54 criteria: 35 `[ ]` and 19 `[~]`.** Both are in scope. Excluding the partials would drop
the hardest work silently — several were *downgraded* from `[x]` by a review round that found
the original evidence falsified (ISC-50, 51, 57, 110, 115, 191, 193).

Measured at `4ad83f0`:

```
$ grep -c '^- \[x\]' ISA.md   # 239
$ grep -c '^- \[ \]' ISA.md   # 35
$ grep -c '^- \[~\]' ISA.md   # 19
239 + 35 + 19 = 293            # matches frontmatter progress: 239/293
```

`[~]` is not a weaker `[x]`. Under the project's standing strictness rule (§8) it means *the
mechanism may be complete, but nothing reproducible re-checks it*. That distinction is what
makes §2's classification possible at all.

---

## 2. Root-cause classification

The 54 are not 54 independent problems. Five classes account for all of them, and each class
has a different remedy shape — which is why the classification, not the enumeration, is what
determines order.

| Class | Diagnosis | Remedy shape | Count |
|---|---|---|---|
| **RC-1** | **Unreachable module** — code written, unit-tested, **zero production callers** | Wire the existing module to a runtime seam. The code exists; the caller does not. | 8 |
| **RC-2** | **Mechanism absent** — the feature does not exist in any form | Build it. A test alone closes nothing; there is nothing for a test to hold. | 22 |
| **RC-3** | **Unwitnessed** — the mechanism works, no CI runner can observe it | Provide the runner. This is infrastructure, not engineering. | 9 |
| **RC-4** | **Proof too weak** — something passes that a mutation shows cannot fail | Strengthen or replace the probe. No `src/` change. | 12 |
| **RC-5** | **Owner decision** — an answer changes the shape of the work | Ask. Building first is speculative. | 3 |

**RC-1 (8):** ISC-61, 110, 115, 117, 154, 193, 248, 271.
Each named a module with a grep-provable absence of callers AT THE TIME OF FILING. Two have
since been wired, and their rows are CORRECTED below rather than deleted, because the absence
is the fact each criterion was filed over: `renderAllWorkers` (0 callers then, `up.ts:488`
now),
`src/safety/budget.ts` (0 importers), `classifyStall` (definition only, before the scheduler
wiring), `TokenRefresher` (0 callers), `backend.kind` (parsed and read by nothing then; now
the middle term of `up.ts`'s `explicit --backend > backend.kind > DEFAULT_BACKEND`),
`tree_hash_quiesce`/`tree_hash_harvest` (never populated).

**RC-2 (22):** ISC-32, 51, 57, 108, 111, 112, 125, 126, 157, 172, 189, 192, 233, 246, 263,
265, 272, 276, 277, 282, 291, 292.
ISC-51 and ISC-57 are here rather than in RC-3 because they are **violated in the loose
direction**, measured — the bridge gateway is reachable — so re-measuring them closes nothing.
ISC-282 is here because the stall policy's production adapters do not exist, even though its
scheduler half now does.

**RC-3 (9):** ISC-22, 41, 47, 48, 50, 258, 259, 262, 290.
Every one is blocked by the same missing thing: a runner that is an Apple-silicon host with a
Docker daemon, an oMLX server, and a Google credential. GitHub-hosted runners have none of
these. ISC-262's note already names the hazard of pretending otherwise: *"naming a file in a
job does not make its probes run — it makes them skip somewhere visible instead of
invisibly."*

**RC-4 (12):** ISC-74, 113, 119, 141, 147, 191, 254, 270, 273, 274, 278, 281 — of which the
five suite-wide properties (254, 270, 273, 274, 278) are separated into Phase B because they
govern how everything after them is graded.

**RC-5 (3):** ISC-243, 264, 268. Each is a disjunction whose arms differ in size:

| Criterion | Arm 1 | Arm 2 | Size ratio |
|---|---|---|---|
| ISC-243 | Build a graded allowlist of the acceptance resolution surface | Restate the anti-criterion; keep the denylist with its incompleteness documented and the verdict cap widened | ~20:1 |
| ISC-264 | Rename `RELAY_LISTEN_ALIAS` to `omlx.pifleet.internal` | Formally accept the `host.docker.internal` overload as SRD §5.9 already states, and pin the documented name with a test | ~8:1 |
| ISC-268 | Wire `adc_mode: file` through `buildDockerArgv` and prove the mount | Remove the mode from the schema, delete the three dead symbols and ISC-44's carve-out | ~4:1 |

> A criterion assigned to a class does not change class when the plan proceeds. Where a note
> is ambiguous, the class is chosen from what the note **measured**, not what it argued.

---

## 3. The ordering argument

Four rules produce the sequence. Each is stated as a rule so a future re-plan can check
whether it still holds, rather than re-deriving the order from scratch.

**Rule 1 — decisions before the work they shape.** An unanswered disjunction makes any build
against it speculative. Phase A closes no criteria; it produces three recorded answers and
routes ISC-243, 264 and 268 to their build phases. It is first because it is cheap and
because being wrong about it is not.

**Rule 2 — grading rules before the work they grade.** Phase B's five properties change what
counts as evidence. A phase that lands after them is graded under them; a phase that lands
before them is graded twice. This is the only rule that moves *cheap* work *early*, and it is
the one most likely to be reversed by an impatient re-plan.

**Rule 3 — witnesses before claims that need witnessing.** Phase C provisions the runner. It
is third rather than first only because Phase B's guards decide what the runner is allowed to
certify. Eleven criteria depend on C and none of them can be honestly graded before it.

**Rule 4 — seams before the features that hang off them.** The remaining phases are ordered by
the runtime seam they attach to, not by subject matter. Phases D (accounting), E (supervisor
control), F (launch preflight) each open one seam that several criteria then use. G through J
are independent of one another and parallelizable. K is the integral and is last by
definition.

**What the order deliberately is not:** it is not group order (A–S is chronological), not ISC
number order (numbers were allocated by whichever branch filed first, and two engineers
collided on 270), and not cheapest-first (Rule 2 defeats that, and so does the fact that the
cheapest items in the set — ISC-254 at one test, ISC-270 at one guard — are also the ones
whose absence silently weakens everything else).

---

## 4. Phase table

| Phase | Deliverable | Closes | Depends on | Exit criteria |
|---|---|---|---|---|
| **A — Decide** | Three recorded answers in `ISA.md` `## Decisions`, each naming the chosen arm and the criteria it routes | — (gates 243, 264, 268) | — | Each of the three criteria carries a `## Decisions` entry naming its arm; no arm is "revisit later" |
| **B — Suite guards** | Five properties over the suite, each with a guard that fails the suite when violated | 254, 270, 273, 274, 278 | A | Each guard **mutation-proved**: introduce the violation, the named test fails |
| **C — Proof plane** | Self-hosted Apple-silicon runner + the bridge-gateway containment its probes expose | 22, 41, 47, 48, 50, 51, 57, 258, 259, 262 | B | Every listed probe **executes** (not skips) on the runner, and a container on the deny-all bridge cannot reach `172.18.0.1:22` |
| **D — Accounting and stall** | Budget on the dispatch path with a persisted `budget.json`; production adapters for the stall policy | 110, 115, 117, 193, 281, 282 | B | A run whose reported cost is 0 throughout halts on `tokens_ceiling` and exits 5; a wedged agent is killed by production code |
| **E — Supervisor control seam** | `extension_ui_request` handler with a real `ui_request_timeout` timer; control-socket path allowlist and peer-uid check; runtime `no_tool_calls` detector | 108, 111, 112, 113, 126, 276 | B | An `editor` request is answered within `ui_request_timeout` and the turn continues; a foreign-uid connect is refused by code, not by umask |
| **F — Launch preflight and identity** | `up` preflight (image present + verifies, backend honored, mount sources shared, probe target host-reachable); launch-time `(pid, started, pgid)` recorded and used at every rung | 32, 61, 189, 191, 271, 272, 291, 292 | B | `up` refuses each seeded precondition failure with a named exit code; `down`'s ladder reads no identity off the pid |
| **G — Durable formats** | `schema` discriminator on ledger, state and registry records, with a pinned read policy for older versions | 157, 192 | B | A record stamped `v0` is read under the policy; neither `StateReadError` nor a bare `ZodError` escapes |
| **H — Evidence outside the container** | Host-side verbgate ledger collector; escape-attempt detector and report; quiesce/harvest tree hashing; fd-based outbox scan | 125, 154, 172, 246 | B | A worker truncating its own ledger changes nothing collected; a seeded escape is reported by name |
| **I — Containerized acceptance** | Daemon-visibility sentinel, then acceptance in a fresh container from the same image, then the resolution-surface decision from A | 233, 243, 277 | A, F | The sentinel fails loudly on an unshared path; acceptance runs with `docker` as argv[0] |
| **J — Egress and identity completeness** | Google CONNECT/SNI path, relay config-drift detection, the alias and `adc_mode: file` arms from A, `TokenRefresher` on the supervisor lifecycle | 248, 263, 264, 265, 268 | A, C | A `cloud_access` worker reaches `*.googleapis.com`; changing `relay_upstream` takes effect with no manual `docker rm -f` |
| **K — End to end** | The full `up` → container → dispatch → settle → harvest chain, and the three proof-strength items that need a real run | 74, 119, 141, 147, 290 | C, D, E, F | One command produces one real Pi turn in a real container, harvested; a hostile repo changes nothing about it |

**Serialization:** A → B → C. **Parallel after B:** D, E, F, G, H may proceed concurrently —
they touch disjoint seams. **I** waits on F (ISC-292's mount check is ISC-277's precondition).
**J** waits on A and C. **K** waits on C, D, E, F.

**Effort, in PR-sized units** (one PR = one reviewable change closing one to three criteria):

| Phase | A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PRs | 1 | 3 | 2 + infra | 3 | 3 | 4 | 1 | 4 | 3 | 4 | 3 |

≈ 31 PRs plus one infrastructure provisioning task. Phase C's "infra" is the single largest
non-code cost in the plan and is called out again in §6.C.

---

## 5. The critical path

```
   A ──► B ──► C ─────────────────────────┐
               │                          ▼
               └──► F ── ISC-291 ────►  K ── ISC-290
```

**To `ISC-290` specifically, the path is two code items:**

1. **ISC-291** — the host-side native-tool-call probe must dial a host-reachable endpoint.
   `llm.base_url`'s host is pinned to `host.docker.internal` by design (it is what a *worker*
   dials from inside the bridge); the probe runs on the host, where that alias does not
   resolve. `llm.relay_upstream` already exists as the separately-configured host-reachable
   dial target. This is a `security/model-probe.ts` change, not an architecture change.
2. **Configuration** — point `relay_upstream` at the LAN oMLX. Not code: `ISC-259`'s
   resolution already amended SRD §5.9 to permit it, `config validate` already accepts a real
   LAN config, and the LAN peer already serves all three allowlisted models.

Everything else `ISC-290` needs was completed by the container launcher (ISC-286/287/288):
`up` records a launch argv, the supervisor spawns exactly it, `down` reaps it.

**This is the plan's most actionable claim and the one most worth falsifying first.** If a
run still fails after ISC-291 and the config change, the failure is new information and every
later phase should be re-ordered around it.

---

## 6. Phase specifications

Each phase states its intent, the criteria it closes, what blocks it, and — deliberately —
what it does **not** do. The per-criterion probes are in §7.

### 6.A — Decide

**Intent.** Convert three disjunctions into three answers, each recorded in `ISA.md`
`## Decisions` with the chosen arm named.

**Closes.** Nothing. This phase is a routing gate; each criterion closes in its build phase.

**Gates.** ISC-243 → Phase I. ISC-264 → Phase J. ISC-268 → Phase J.

**The three questions, stated so they can be answered without re-reading the ISA:**

1. **ISC-243 — acceptance harness surface.** Today's `DEFAULT_HARNESS_PATTERNS` is a 91-glob
   denylist, measured to miss 40 of 40 probed resolution-surface paths, with six
   adjacent-sibling holes (`go.mod` but not `go.sum`, `Cargo.toml` but not `Cargo.lock`).
   A worker can green a red suite through `.env.test` or `vite.config.ts` and be certified
   `success`. The ISA argues a *partial* allowlist is strictly worse than a known-partial
   denylist, because the operator's only escape hatch (`harness.patterns`) **replaces** rather
   than extends. **Question:** build the graded allowlist (per-runner resolution manifests,
   inheritance closure, toolchain pins, three tiers) — or close the six measured sibling holes,
   widen the cap, and restate the anti-criterion as an accepted residual?
2. **ISC-264 — the relay alias.** `RELAY_LISTEN_ALIAS` is `host.docker.internal`. Since
   ISC-259 that name means "wherever this fleet's oMLX is", which may be a LAN peer.
   SRD §5.9 already states the overload as accepted, on two checkable grounds. **Question:**
   rename to `omlx.pifleet.internal` (a breaking change to every config and doc), or close the
   criterion as accepted-residual with a test pinning the documented name?
3. **ISC-268 — `adc_mode: file`.** Accepted by the schema, mounts nothing. `ADC_FILE_PATH`,
   `fileModeMaterials` and `fileModeStartupEnv` have zero callers. **Question:** wire it, or
   delete it together with ISC-44's mount-guard carve-out?

**Does not.** Write code. Change the schema. Pre-empt an answer by building the cheaper arm.

**Exit.** Three `## Decisions` entries, each naming an arm. "Revisit later" is not an arm.

---

### 6.B — Suite guards

**Intent.** Land the five properties that govern how every later phase is graded.

**Closes.** ISC-254, 270, 273, 274, 278.

**Why second.** Each is a property over the *suite*, not over a feature:

- **ISC-278** — no test leaves a `PIFLEET_*` env var changed at process exit. The defect is
  invisible in both states today; a leaked `PIFLEET_RUNS_DIR` pointing at a deleted directory
  is exactly the shape that makes a later phase's test pass for the wrong reason.
- **ISC-273 / ISC-274** — no subprocess-spawning test inherits bun's 5000 ms default.
  ISC-274 is the class; ISC-273 is the one file the earlier sweep missed. Every phase after B
  adds spawning tests; adding them before the guard means adding them wrong.
- **ISC-270** — every `COPY` source in `docker/Dockerfile` appears in `BUILD_CONTEXT_ASSETS`.
  The array is *correct today*; what is missing is what keeps it correct. Phase C rebuilds the
  image on a new runner, which is precisely when a fail-open `configHash` would bite.
- **ISC-254** — the timing-safe comparator is pinned. The ISA records honestly that
  `timingSafeEqual` and `===` are behaviourally identical and only timing distinguishes them,
  which is too flaky to gate CI. The closing probe is therefore **structural** — an assertion
  that the comparator symbol is the one in use — not a timing measurement.

**Does not.** Fix the individual known sites and call the property closed. ISC-278's own note
is explicit that the sites are already known and fixing them is not what closes it.

**Exit.** Each guard mutation-proved: introduce the violation, the named test fails.

---

### 6.C — Proof plane and bridge containment

**Intent.** Provide the witness that eleven criteria are waiting for, and close the
containment gap those probes have already exposed.

**Closes.** ISC-22, 41, 47, 48, 50, 51, 57, 258, 259, 262.

**The infrastructure, named with its cost.** A **self-hosted Apple-silicon runner** with:
a Docker daemon (Colima or Docker Desktop), an oMLX server reachable at the configured
`relay_upstream`, and a Google credential for the ADC probes. This is the single largest
non-code line item in the plan. Nothing in RC-3 can be honestly graded without it, and
`ISC-262`'s note already names the failure mode of pretending otherwise.

**The containment work, which is not merely proof.** ISC-51 and ISC-57 are *violated in the
loose direction*, measured: a container on the deny-all `--internal` bridge pulls a live sshd
banner from the bridge gateway `172.18.0.1:22`. Docker's internal-network isolation lives in
the FORWARD chain; the gateway is on-link and inside the subnet, so gateway-destined traffic
is delivered through INPUT and never filtered. Closing these two needs an actual rule, not a
re-measurement.

**Does not.** Grade a criterion `[x]` because its file now appears in a workflow. A probe that
skips on the runner is `[~]`, exactly as ISC-262 records.

**Exit.** Every listed probe **executes** on the runner — asserted by the probe-guard's
`TOTAL_EXPECTED` accounting, not by the job's exit code — and a container on the deny-all
bridge cannot reach `172.18.0.1:22`.

---

### 6.D — Accounting and stall

**Intent.** Open the accounting seam. `src/safety/budget.ts` has zero importers; nothing in
the product accounts for tokens, so nothing can halt on a ceiling.

**Closes.** ISC-110, 115, 117, 193, 281, 282.

**The seam.** Budget on the dispatch path, with a persisted `budget.json` (`run/paths.ts` has
no `budgetJson` member today), and `budgetExitCode` folded into `worstExit` after harvest.

**ISC-193's recommended arm is arm one — a producer.** The ISA states the coupling: folding
`budgetExitCode` into `worstExit` satisfies arm one *and* closes ISC-114/ISC-115 with it.
Arm two (deleting `EXIT.BUDGET`, `EXIT_SEVERITY`'s rung and `budget.ts` together) is
recorded as viable but discards a built module to close a criterion about wiring.

**ISC-281 is a correctness constraint on the same seam, not a separate feature:**
`session_present === false` is unreliable within its own lag window, so no consumer that must
not lose money may treat it as evidence the worker never spent.

**ISC-282 is the production half of ISC-110/117.** The scheduler acts on a verdict today,
proved with an injected clock and a fake `eventSilenceMs`. What is untested is whether
`stat(events.jsonl).mtimeMs` really moves when an event is appended and really answers `null`
rather than infinite silence when the file is absent, and whether the `abort` RPC
`killWedged` sends actually ends a wedged agent.

**Does not.** Close ISC-110 or ISC-117 on the scheduler test alone. Both stay `[~]` until
ISC-282's production halves are covered.

**Exit.** A run whose reported cost is `0` throughout halts on `tokens_ceiling` and exits 5,
artifacts still harvested; a wedged agent is killed by production code, not by a test double.

---

### 6.E — Supervisor control seam

**Intent.** The supervisor answers RPC messages it currently ignores, and refuses ones it
currently trusts.

**Closes.** ISC-108, 111, 112, 113, 126, 276.

**Four things at one seam:**

- **UI requests (111, 112, 113).** `ui_request_timeout` is parsed at `config/schema.ts:165`
  with a `5s` prefault and **read by no code**. `select`/`confirm`/`input` carry an optional
  timeout and self-resolve; **`editor` has no timeout and hangs forever unanswered** — the
  supervisor's timer is the only unblocker and there is no timer. ISC-112 is the one of the
  three most likely to be *false in production* rather than merely unproven.
- **Path allowlist (276).** `src/supervisor/index.ts` validates `msg["path"]` only as a
  non-empty string, then hands a derived path to Pi, which writes with Pi's authority.
- **Peer uid (126).** No uid check exists. The refusal that does occur is an unasserted
  side-effect of the operator's umask — measured `0755` on socket and directory.
- **Runtime `no_tool_calls` (108).** SRD §5.9/F39 specifies two detectors; only the startup
  probe is built. `prose_turns_before_fail` appears nowhere outside `Docs/SRD.md`.

**Does not.** Answer a UI request by timing out the whole turn. ISC-112's failure today is
that the turn blocks until `deadline_s`; a fix that merely renames that outcome closes
nothing.

**Exit.** An `editor` request is answered within `ui_request_timeout` and the turn continues;
a connect from another uid is refused by code with the umask deliberately widened in the test.

---

### 6.F — Launch preflight and identity

**Intent.** `up` refuses, before launching anything, every precondition it currently ignores;
and the kill ladder addresses identities recorded at launch.

**Closes.** ISC-32, 61, 189, 191, 271, 272, 291, 292.

**Preflight (32, 189, 271, 291, 292).** Five checks, one seam, all before the first
`docker run`:

| Check | Today | Note |
|---|---|---|
| Role image present | `grep -in image src/cli/commands/up.ts` returns **zero lines** | `doctor.ts`'s `imageStatus` already does the inspect |
| Role image verifies | `verifyImage` has one caller — the `image verify` subcommand | The harder half; a stale-but-present image is invisible |
| `backend.kind` honored | **CLOSED.** Was parsed at `schema.ts:129` and read by nothing, with `up` silently using the flag default. `BackendSchema.kind` is `.optional()` at `schema.ts:147` now, so an absent block is distinguishable from `kind: cmux`; the flag carries no commander default; `up` honors the config. | Binding it has a cost, which is why `fleet.example.yaml` no longer ships `kind:` live: a config naming a backend the host cannot present is exit 3 and no fleet. |
| Probe target reachable | Probe dials `llm.base_url` from the host, where the alias does not resolve | **On the critical path — §5** |
| Mount sources shared | An unshared macOS path is silently replaced by an empty directory | Cost a false diagnosis once already; ISC-277's precondition |

**Identity (191, 272).** `down` now climbs every rung on `signalIfSame`, but `ISC-272` is the
declared residual: no rung may read a start time off the pid at rung 0, and no `pgid` may be
taken on trust from a state file. Both must be recorded when the supervisor **launched** —
the same launch-record mechanism the container launcher introduced.

**ISC-61 belongs here** because it is a launch-path fact, not a config-rendering fact:
`renderAllWorkers` is the only function mapping N `workers:` entries onto N containers, and it
HAD zero callers in `src/` when this was filed -- changing `workers:` length changed nothing.
It is called from `up.ts:488` now, and `--workers` no longer carries a commander default, so an
absent flag means every worker the config declares.

**Does not.** Add a preflight that runs after the first container starts. The value of every
check in this phase is that it fires before any side effect.

**Exit.** Each seeded precondition failure is refused with a named exit code and a message
identifying the offending role; `down`'s ladder reads no identity off a live pid.

---

### 6.G — Durable formats

**Intent.** Stamp a schema version and pin a read policy.

**Closes.** ISC-157, 192.

**Measured state.** `grep -rn "schema_version|SCHEMA_VERSION|schemaVersion" src test` returns
nothing; `LedgerRecordSchema` carries no discriminator. The state half is worse than untested:
a `state.json` stamped `pifleet.state/v0` raises `StateReadError`, and a `registry.json`
stamped `pifleet.registry/v0` throws a **bare `ZodError`** out of `readRegistry` with no
wrapper — both failures, which is exactly what "rather than failing" forbids.

**Does not.** Write a migration engine. The criteria ask for a *pinned, tested policy*, which
may legitimately be "refuse with a named error and a documented recovery", provided that
policy is tested against a real older-version fixture.

**Exit.** A ledger record and a state file, each stamped one version back, are read under the
policy; no bare `ZodError` escapes any reader.

---

### 6.H — Evidence outside the container

**Intent.** Move the audit trail beyond the reach of its subject, and populate the two hashes
an existing verdict rule depends on.

**Closes.** ISC-125, 154, 172, 246.

- **ISC-172.** `docker/verbgate:26-30` states the exposure in production code, by criterion
  number: the ledger is written by the worker, so a determined worker can truncate it. The
  gate already refuses to let its subject supply its own policy or redirect its own evidence.
  What is missing is a collector outside the container.
- **ISC-125.** All three halves are absent — nothing seeds an escape, nothing detects one,
  nothing reports one. What exists is *prevention*, which is a different posture and is
  already credited to ISC-25/26/29/30. Detection is the deliverable.
- **ISC-154.** The decision rule is proved and mutation-checked; its antecedent is
  unreachable because nothing populates `tree_hash_quiesce`/`tree_hash_harvest`. Needs
  supervisor cooperation at the quiesce boundary.
- **ISC-246.** `OutboxFileScan.safe` is `string[]`. The scan validates with `lstat` +
  `realpath` on **paths** and opens nothing, so a validated path re-opened later is a TOCTOU
  window and `nlink` can be raised after the scan. Latent while `safe` has no consumers;
  arms the moment artifacts are attached.

**Does not.** Ship ISC-125 as a log line. A detector that cannot be seeded and shown to fire
closes nothing — the criterion names three halves and a test must exercise all three.

**Exit.** A worker truncating its own ledger changes nothing about what the host collected;
a seeded escape attempt is reported by name; a tree that moved between quiesce and harvest
forces `unknown` in a real run.

---

### 6.I — Containerized acceptance

**Intent.** Run acceptance where the SRD says it runs, and only after proving the ground it
runs on is real.

**Closes.** ISC-233, 243, 277.

**Strict internal order: ISC-292 (Phase F) → ISC-277 → ISC-233 → ISC-243.**

ISC-277 is a **blocking precondition**, not a restatement. Someone can finish ISC-233's argv
work completely — bind-mount, entrypoint override, hardened flags, all correct — and still
ship a containerized acceptance run that grades an empty tree and certifies the worker. The
sentinel (host writes, container reads back) is what makes an unshared path fail loudly.

**ISC-233's gap, measured.** `runAcceptance` clones by SHA into a scratch dir on the host and
executes each command with `Bun.spawn` inside `execBounded` — the argv is the acceptance
command itself, never `docker`. The path is reachable and graded; it is simply the wrong path.

**ISC-243 executes whichever arm Phase A chose.**

**Does not.** Reuse the worker's own container. The criterion says *a fresh container from the
same image*, which is what makes the acceptance run independent of anything the worker did to
its own environment.

**Exit.** The sentinel fails loudly on an unshared path; `docker` is argv[0] of every
acceptance command; the Phase A arm is implemented and its probe passes.

---

### 6.J — Egress and identity completeness

**Intent.** Finish the network and credential paths that the relay's arrival left partial.

**Closes.** ISC-248, 263, 264, 265, 268.

- **ISC-263 is the large one.** `egress.google_hosts` rules are matched exhaustively by
  `decide()` in unit tests, but no live traffic path to `*.googleapis.com` exists, because a
  Docker network alias cannot be a wildcard. It needs an HTTP CONNECT proxy or SNI-based TLS
  passthrough. The user-visible consequence today: a `cloud_access: true` role on the internal
  bridge cannot reach Google at all — ADC is granted and then unusable.
- **ISC-265 is the dangerous one.** `ensureEgressRelay` adopts an already-running relay by
  **name** without comparing its forwarding targets to the current config, and the relay is
  durable (`--restart unless-stopped`) and never removed by `down`. That was fair while only
  the port was configurable. Since ISC-259 it is not: after changing `relay_upstream`, an
  adopted relay keeps forwarding to the **old machine** and nothing is loud about it.
- **ISC-248** is wiring, and it is newly unblocked — `TokenRefresher` had nothing to attach to
  until the container launcher landed. `grep -rn 'security/refresh' src/` returns nothing.
- **ISC-264 and ISC-268** execute the arms Phase A chose.

**Does not.** Close ISC-263 by widening the bridge. The criterion is satisfied by a
*routed* path that `decide()` still gates — which is the case `decide()` was designed for and
has never been exercised against.

**Exit.** A `cloud_access` worker reaches `*.googleapis.com` through a gated path; changing
`relay_upstream` takes effect with no manual `docker rm -f`; ISC-51/57's containment evidence
is re-taken against the new posture.

---

### 6.K — End to end

**Intent.** One command, one real turn, harvested — and the three proof-strength items that
require a real run to close.

**Closes.** ISC-74, 119, 141, 147, 290.

- **ISC-290** is the integral. See §5: two items on its path.
- **ISC-119** needs a real run by construction. `hostile-repo.test.ts` is excellent and does
  not close it — its own header says "no Pi process runs here". The gap is that a worker
  mounts a *clone* carrying the tracked hazards.
- **ISC-74** had a test written and then **deleted**, because a mutation proved it could not
  fail. The existing `grep` hit asserts an id is absent from a documentation table, which
  would pass unchanged if closing a pane killed every worker in the fleet.
- **ISC-141** — both machines are mutation-proved; the supervisor line that joins them is
  not, and the e2e test named for the interleaving does not test it.
- **ISC-147** — the scenario property table is weaker than its name; the hand-written tracker
  tests are what actually defend the property.

**Does not.** Grade ISC-290 from its parts. Three probes each covering a segment do not add
up to end-to-end — that is the reasoning that produced its current `[~]`.

**Exit.** `up` → container → dispatch → settle → harvest completes in one motion against a
real Pi and a real model, and the hostile-repo variant of the same run changes nothing.

---

## 7. Assignment — all 54, with probes

Every remaining criterion appears **exactly once**. `Class` is from §2; `Phase` is from §4.
`Probe` is the single tool call that returns yes/no on whether the criterion is met — the
granularity rule the ISA itself enforces.

### Phase B — Suite guards

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 254 | RC-4 | Timing-safe comparator is pinned | Structural assertion that the auth path calls `timingSafeEqual`; mutation to `===` fails the named test. **Not** a timing measurement — the ISA records that as too flaky to gate CI |
| 270 | RC-4 | Every `COPY` source is in `BUILD_CONTEXT_ASSETS` | Test parses `docker/Dockerfile` for `COPY` sources and set-compares against the array; add an uncovered `COPY`, test fails |
| 273 | RC-4 | `down-prune.test.ts` derives every ceiling | `grep -c cliBudget test/integration/down-prune.test.ts` equals its test count (today: `0` of 13) |
| 274 | RC-4 | No spawning test inherits bun's 5000 ms | Suite-wide guard: every test file calling `Bun.spawn` passes a derived third argument |
| 278 | RC-4 | No test leaks a `PIFLEET_*` env var | Snapshot `PIFLEET_*` at process load, diff at exit; non-empty diff fails |

### Phase C — Proof plane

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 22 | RC-3 | Coverage lists every `src/` module | `bun run test:coverage` on the runner; the absent set equals exactly the two structural modules (`backends/types.ts`, `supervisor/index.ts`) |
| 41 | RC-3 | `gcloud auth print-access-token` succeeds in-container | `docker exec` on the runner returns a token for a `cloud_access` worker |
| 47 | RC-3 | Token survives `token_refresh` | Two genuinely separate mints; in-container `gcloud` returns the **second** value |
| 48 | RC-3 | Impersonated token's identity is the SA | Token introspection returns the configured SA, not the operator account |
| 50 | RC-3 | Container completes a model call | Container on the deny-all bridge `GET`s `/v1/models` from the real oMLX and receives the upstream's own nonce |
| 51 | RC-2 | No route off the bridge subnet | Container `nc 172.18.0.1 22` times out (today: returns a live sshd banner) |
| 57 | RC-2 | Egress denied to all but oMLX + Google | Enumerated dial list — gateway, LAN peer, public host — only allowlisted destinations connect |
| 258 | RC-3 | A live **inference** through the relay | `usage.completion_tokens > 0` and echoed `model` equals the model requested |
| 259 | RC-3 | SRD endpoint and serving endpoint are one machine | A container on the internal bridge reaches the LAN oMLX end-to-end through a relay |
| 262 | RC-3 | `model-probe.test.ts` executes in CI | The probe guard reports its four probes **executed**, zero skipped |

### Phase D — Accounting and stall

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 110 | RC-1 | A queued worker is not killed as wedged | Production run with `max_concurrent` < worker count; no kill lands on undispatched work |
| 115 | RC-1 | Ceiling halts a run whose cost is 0 | Run reporting `0` throughout exits 5 with artifacts harvested |
| 117 | RC-1 | Wedged agent killed at `event_stall_kill` | A silent slot-holder is killed by production code, not by a test double |
| 193 | RC-1 | `EXIT.BUDGET` has a producer | A real run exits `5`; `worstExit` folds `budgetExitCode` (arm 1 — recommended) |
| 281 | RC-4 | `session_present` lag is not money evidence | No consumer that can lose money branches on `session_present === false` |
| 282 | RC-2 | Production stall inputs and action are covered | Appending to `events.jsonl` moves `mtimeMs`; an absent file answers `null`; the `abort` RPC ends a wedged agent |

### Phase E — Supervisor control seam

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 108 | RC-2 | 3 prose turns → `failed:no_tool_calls` | Fixture scenario emits three tool-call-free turns; verdict carries the classification |
| 111 | RC-2 | Dialog answered `{cancelled:true}` within 5s | Fixture emits a dialog request; a response frame is observed and elapsed < `ui_request_timeout` |
| 112 | RC-2 | An `editor` request does not hang the run | Fixture emits `editor`; the turn continues well inside `deadline_s` |
| 113 | RC-4 | Fire-and-forget receives no response, is logged | Non-vacuous: assert **no response frame on the wire** for each of the five methods, plus the log line |
| 126 | RC-2 | Control socket refuses another uid | Connect as a different uid with the umask deliberately widened; refusal comes from code |
| 276 | RC-2 | A path outside the permitted set is refused | `export_html` with an outside path is refused and no file is written where the path named |

### Phase F — Launch preflight and identity

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 32 | RC-2 | `up` refuses a missing role image | Remove the image; `up` exits a named code naming the role |
| 61 | RC-1 | `workers:` length changes container count | `up` with N workers; `docker ps` filtered by run id counts N |
| 189 | RC-2 | `up` refuses an image that fails `verify` | Present-but-wrong image (same tag, wrong bytes) is refused on the `up` path |
| 191 | RC-4 | Kill ladder uses `(pid, started)` | Mutation: drop the `started` comparison at any rung; a named test fails |
| 271 | RC-1 | `backend.kind` is honored or rejected | Config sets `kind: cmux` with no flag; `up` loads cmux, or `config validate` exits 2 |
| 272 | RC-2 | Every rung uses launch-recorded pid **and** pgid | Assert the ladder reads the launch record; no rung derives `started` from a live pid |
| 291 | RC-2 | Probe dials a host-reachable endpoint | With oMLX on `127.0.0.1:8000`, `up`'s probe succeeds instead of reporting unreachable |
| 292 | RC-2 | Unshared bind-mount source refused or reported | `-v` from a path outside the runtime's shared set produces a named refusal, not an empty directory |

### Phase G — Durable formats

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 157 | RC-2 | Older ledger read under a pinned policy | A `v0`-stamped ledger record is read under the policy; no crash |
| 192 | RC-2 | Older state/registry read under a pinned policy | `v0` `state.json` and `registry.json` are handled; no bare `ZodError` escapes any reader |

### Phase H — Evidence outside the container

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 125 | RC-2 | A seeded escape is detected and reported | Seed the attempt; the report names it. All three halves exercised |
| 154 | RC-1 | Moved tree between quiesce and harvest → `unknown` | Real run whose tree changes after quiesce; verdict is `unknown` with the ISC-154 reason |
| 172 | RC-2 | Verbgate ledger collected outside the container | Worker truncates its own ledger; the host-collected copy is unchanged |
| 246 | RC-2 | `scanOutboxFiles` returns descriptors | `OutboxFileScan.safe` carries fds; raising `nlink` after the scan is refused |

### Phase I — Containerized acceptance

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 277 | RC-2 | Scratch root proved daemon-visible first | Host-written sentinel is read back from inside the container **before** any acceptance command runs |
| 233 | RC-2 | Acceptance runs in a fresh container | `docker` is argv[0] of every acceptance command (today: the command itself) |
| 243 | RC-5 | Graded allowlist replaces the denylist | Per the Phase A arm: either the allowlist grades the six measured sibling holes, or the restated anti-criterion's cap widens and its probe passes |

### Phase J — Egress and identity completeness

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 248 | RC-1 | `TokenRefresher` runs on the supervisor's lifecycle (distinct from `ISC-248a`, which is closed) | `grep -rn 'security/refresh' src/` is non-empty **and** a long-running container's token is re-injected before expiry |
| 263 | RC-2 | A `cloud_access` worker reaches Google | `curl https://*.googleapis.com` from inside a worker succeeds through a `decide()`-gated path |
| 264 | RC-5 | The oMLX name does not claim to be the Docker host | Per the Phase A arm: the renamed alias resolves, or a test pins the documented accepted overload |
| 265 | RC-2 | `relay_upstream` change takes effect | Change the value, run `up` with a relay already running; traffic reaches the **new** target with no manual `docker rm -f` |
| 268 | RC-5 | `adc_mode: file` is not silently inert | Per the Phase A arm: `docker inspect` on `buildDockerArgv`'s own output shows the ADC mount, or the schema rejects the mode |

### Phase K — End to end

| ISC | Class | Criterion (short) | Probe |
|---|---|---|---|
| 74 | RC-4 | Closing a pane does not stop an rpc-mode worker | Close the pane in a real run; the task still settles. Mutation-proved this time |
| 119 | RC-4 | A hostile repo changes nothing about the run | Real run against a seeded clone carrying `.pi/extensions/hostile.ts` and a hostile `AGENTS.md` |
| 141 | RC-4 | Epoch attribution uses the stream offset | Mutate the **supervisor join line**; a named test fails |
| 147 | RC-4 | Never complete while output is still coming | Strengthened scenario property; mutation-proved against each hostile fixture |
| 290 | RC-3 | `up` → container → real RPC turn, end to end | One command produces one harvested artifact from a real Pi in a real container |

---

## 8. Grading rules a phase's exit criteria must survive

These are inherited, not invented here. They are restated because a phase that satisfies its
deliverable and fails these has closed nothing.

1. **The strictness rule.** A criterion is `[x]` only when something **reproducible**
   re-checks it. Local-only evidence, or evidence only the author's machine can produce, is
   `[~]`. Losing a checkbox to this rule is the intended cost.
2. **A self-skipping test is not an exit criterion.** Naming a file in a CI job does not make
   its probes run. Phase C's exit is measured by the probe guard's executed/skipped
   accounting, never by the job's exit code. The ISA records four prior instances of this
   exact mis-close.
3. **A unit test over a callerless module proves the module, not the criterion.** This is what
   put eight criteria in RC-1. Any phase closing an RC-1 item must show the production caller.
4. **A probe that cannot fail is not evidence.** Every closing probe in §7 must be
   mutation-proved: introduce the defect, watch the named test fail.
5. **Prevention is not detection.** ISC-125's note is the canonical case — hardened flags are
   already credited to other criteria and do not close a criterion whose verb is *detected*.
6. **No AI attribution** in any commit, PR body, branch name or file content.

---

## 9. Residual risk

| Risk | Consequence | Mitigation in this plan |
|---|---|---|
| The self-hosted runner is not provisioned | Eleven RC-3 criteria stay `[~]` forever and Phase K cannot be graded | Phase C is placed early and its cost is stated in §4 and §6.C rather than buried |
| Phase A's answers arrive late | Phases I and J stall on their last item each | A closes no criteria, so B–H proceed regardless; only 243/264/268 wait |
| ISC-263's proxy proves larger than one phase | Phase J slips | It is the last item on no critical path; ISC-290 does not depend on it |
| §5's two-item claim is wrong | The plan's headline is wrong | It is stated as the first thing to falsify, not as an assumption to build on |
| A later review round files new criteria | The 54 becomes 60 | Expected — it has happened in every round so far. New criteria classify into §2 and route by §3's rules without re-planning |
| Phase B is skipped as "cleanup" | Every later phase is graded twice | Rule 2 in §3 exists to make this refusal explicit |

---

## 10. Relationship to the other two documents

| Document | Role | Authority |
|---|---|---|
| `Docs/SRD.md` (SRD-PIFLEET-001) | The **design**. What `pifleet` is and why. | Wins on any design question |
| `ISA.md` | The **done condition** and system of record. The graded criteria. | Wins on any disagreement with either SRD |
| `Docs/SRD-COMPLETION.md` (this) | The **order**. Which unclosed criterion is built when, and why that one. | Wins only on ordering |

This document is finished when `ISA.md` reads `293/293`. Every phase that closes updates
`ISA.md` directly — the criteria are not restated here as a parallel checklist, because the
ISA is the system of record and a second checklist would drift from it.
