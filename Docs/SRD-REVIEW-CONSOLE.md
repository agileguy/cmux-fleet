# System Requirements Document — a `review` console and a `collator` worker

**SRD-REVIEW-CONSOLE-001 v0.1 — DRAFT FOR OWNER REVIEW**
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001) and **proposes amendments to its §5.9 (the hosted
provider's bounded scope), §9.1 (`shared-ro` and what the harvest can grade) and §12.1's posture on
what a role's tool grant means**. It also proposes the first worker capability that is not a tool:
**a worker whose output causes other workers to run.** Until those amendments are adopted,
`Docs/SRD.md` wins and this document is a proposal. Where this document and the SRD disagree today,
that disagreement is the subject of §4 rather than an oversight.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operator wants a `review` console: a 2×2 of four equal panes, a `collator` top-left that receives
one multi-aspect code-review request, three `reviewer` workers filling the other three squares, and a
collation of their three findings returned against the original request. The layout is free — the
`development` console is already four equal panes and §3.1 shows the equality is achieved by
*omission* rather than by a layout verb. The models are settled (§6.2). **Everything hard is in one
sentence: a worker that dispatches to other workers has no mechanism today, and every mechanism that
looks cheap grants the whole run.** The control socket is authenticated by a single per-run CSPRNG
secret enforced at the framing layer before any verb is seen (`src/run/registry.ts:499`,
`src/security/control-auth.ts:286-308`), and the supervisor behind it accepts nine verbs including
`dispatch`, `steer` and `abort` (`src/supervisor/index.ts:2374-2907`). There is no per-verb and no
per-worker scoping to hand out. So a collator handed enough to dispatch is a collator handed enough to
inject an arbitrary prompt into every worker it can reach — which is `Docs/SRD.md` §12.7's own
threat sentence, arriving from inside a container instead of from another user on the host. **This
document therefore refuses to give the collator a control channel at all.** It proposes instead that
the collator *writes a request* into the outbox plane it already owns, and that a host-side actor —
which already has every capability, by construction — performs the dispatches and delivers the
replies. The collator gets no `bash`, no socket, no secret and no network. §6.3 shows that the
file-shaped mechanism is also what removes the need for `bash`, and §6.6 shows the same choice
removes the deadlock.

### 0.2 The decision that matters — this is a new capability class, and it is not a tool

Every capability a worker has today is a **tool**, and `Docs/SRD.md` §12.1 is explicit about what
that means: *"Tool scope is not a boundary — the container is."* A role granted `bash` is fully
privileged inside its container and the statement stops there. The container is what bounds it.

**Dispatch is not that shape.** A worker that can cause another worker to run has an effect that
leaves its own container by design. No container boundary bounds it, because the effect is the point.
It is the first capability in this fleet whose blast radius is measured in *other workers* rather than
in *its own filesystem*, and §12.1's sentence — the sentence the whole security chapter rests on —
does not cover it.

`fleet.yaml:511-514` already draws the distinction this document needs, in a comment written about
something else:

> "reviewer carries NO bash (§12.1) and that is unchanged here: a tui pane is a person's keyboard on
> Pi's own interface, not a widening of the agent's tool grant. `pifleet shell` still reaches the
> container, because **that is the FLEET exec'ing in, not a tool the reviewer may call.**"

That is exactly the seam. **The fleet may dispatch. The question this document answers is whether an
agent may.** §6 says no, and routes the collator's intent through the fleet instead of through the
agent — which costs latency and an extra moving part, and buys a design in which a compromised or
merely confused collator can produce a *bad review request* and nothing else.

**Two honest dispositions, and §4 works through both:**

1. **Grant the capability.** Mount sibling control sockets (or one broker socket) into the collator's
   container, give it the run secret, and let it call `dispatch` directly. §4.3 is why not.
2. **Route the intent.** The collator emits a request as data; the host performs it. No new inbound
   surface, no secret in a container, no `bash`.

**This document recommends (2) and §6 specifies it.** (1) is not merely less elegant; §4.3 argues it
is unsafe in a way that has nothing to do with taste, and it should be rejected deliberately rather
than as a side effect of preferring the other.

### 0.3 The disclosure boundary

This document names no employer, no ticket system, no cloud project and no credential value. It does
name two things it cannot avoid and that are already in the tree: the hosted provider `ollama-cloud`
and its models, because §5.9's amendment and `fleet.yaml:135-188` already publish them; and the fact
that the operator's `~/repos/rally-cli` is a proprietary checkout, because §4.4 turns on it and the
finding is worthless stated abstractly. The repository's *contents* are not described. This follows
§0.3 of `Docs/SRD-INFERENCE-PROVIDERS.md`.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Read** | code in this repository, opened and read on 2026-09-04, file and line cited at every claim | §2 in its entirety, §3.1-§3.3, §4.1-§4.2 |
| **Observed** | the live run tree `~/.pifleet/runs/2026-09-04T04-54-27Z-59e3/` and `cmux workspace list`, both read on 2026-09-04 | §2.2, §2.4, §2.7, §6.4's file shapes |
| **Measured by the operator** | the 2026-09-04 Ollama Cloud catalogue probe supplied with the commission — 19 models, vendor `capabilities`, and a fresh run of the fleet's own `probeNativeToolCalls` | §6.2 only. **Not re-probed by this document**, and labelled as the operator's measurement wherever used |
| **Recorded** | `Docs/SRD.md` §5.6/§5.9/§9.1/§12.1/§12.7 and their errata; `ISA.md`'s 2026-09-02 adoption entry; `~/.claude/skills/CodeReviewer/` | §1.3, §4.1, §4.4, §5 |
| **Inferred** | reasoning from the above | §6, §7, §8, §9. **These are proposals, not observations, and they are where the owner's review is most valuable.** |

**One thing was probed and it is small.** `git -C ~/repos/rally-cli remote -v` was run, and
`cmux workspace list` was run. Nothing else was executed: no fleet was stood up, no container started,
no model called, no dispatch issued. Every §2 claim is a claim about **what the code says it does**.
Where a claim would need a running system to settle, §9 holds it as an open question rather than
asserting it — and §9's two BLOCKING entries are both of that kind.

### 0.5 Five corrections to the premises this document was commissioned against

The commission was assembled quickly and says so. Five of its statements are wrong, and two of the
five change what §6 may assume.

**1. `developmentPanes()` is at `src/backends/cmux/operations-plan.ts:620`, not `:622`.** Line 622 is
the third line of the body. `DEVELOPMENT_SPEC` at `operations.ts:103` and
`DEFAULT_DEVELOPMENT_WORKERS` at `operations-plan.ts:568` are both correct, as is the pane-order
comment "near line 480" — it is `operations-plan.ts:479-501`.

**2. `workers:` in `fleet.yaml` is at line 463, not ~505.** Line 505 is a comment inside the block.

**3. `/workspace` is a `git clone --no-hardlinks`, not a worktree — and this matters.**
`src/run/worktree.ts:1-3`: *"Per-worker code isolation (SRD §9.1) — **implemented as a CLONE, not a
linked worktree.** The module keeps the name `worktree` because `isolation: worktree` is the
vocabulary an operator writes in `fleet.yaml`."* The rejected alternative is not a matter of taste:
`worktree.ts:12-25` records that `git worktree add` with the parent gitdir mounted is **"a confirmed
container-to-host remote code execution"** — the spike zeroed the host's `refs/heads/main` and planted
an executable `.git/hooks/post-checkout`. **A reviewer under `isolation: shared-ro` has no clone at
all** (`src/config/render.ts:446` mounts `<repo>:/workspace:ro`), and §2.6 shows that single fact is
what makes a review ungradable.

**4. The control socket is not gated by filesystem permissions alone.** There are three independent
layers, and the commission's framing — *"a security property, not an oversight"* — is right about the
conclusion and understates the mechanism. (a) The directory and the socket inode are both `chmod`ed
`0700` **in code**, not inherited from umask (`src/run/registry.ts:428-429`, `:529`); the header at
`:406-412` records that `mkdir`'s `mode` is masked by umask and ignored entirely when the directory
already exists, which is the ordinary case. (b) An accept-time peer-uid gate runs in the `open`
handler **before a byte is read** (`registry.ts:461`, `:470-471`), via `getpeereid` or `SO_PEERCRED`
(`src/security/peer-uid.ts:325-361`) — and it **fails open** where the platform cannot report, stated
deliberately at `peer-uid.ts:83-101`. (c) A 256-bit CSPRNG per-run token, mode 0600, exclusively
created, timing-safe compared, enforced at the **framing** layer and stripped before any handler runs
(`src/security/control-auth.ts:61-63`, `:286-308`; `registry.ts:499`, `:506`). `registry.ts:384-390`
gives the reason it is not per-verb: *"Enforcing per verb inside each handler is how `ping` — the verb
everyone forgets — becomes an unauthenticated oracle for whether a run exists."*

The commission's mechanism for why a container cannot reach it — *"a worker container has its own
tmpfs `/tmp` mounted `noexec` and cannot see the host's"* — is true and is not the operative reason.
**The operative reason is that no socket of any kind is mounted into any container**, and
`assertNoRunDirMount` (`src/run/paths.ts:827-836`, called at `render.ts:574`) refuses to launch if a
bind source is, contains, or is another run's directory. Its message names the stake:
*"the run directory holds control-auth.json, the ledger, the inbox and every other worker's state,
none of which is a worker's to read — SRD §5.5 / ISC-127."*

Also: `socketPath` (`src/run/paths.ts:917-920`) hashes `` `${runId}\0${workerId}` `` and takes the
**first 16 hex characters**, not the whole digest, under `os.tmpdir()`. `paths.ts:11-17` gives the
reason — `sun_path` is capped near 104 bytes on macOS.

**5. The cmux workspace named `review` exists, and no pifleet code knows about it.**
`cmux workspace list` on 2026-09-04 returns `workspace:56 operations`, `workspace:68 development`,
`workspace:69 review`, `workspace:31 planning`. But `grep -rn ": WorkspaceSpec = {" src/` returned
exactly two hits (`operations.ts:96`, `:103`), and `grep -rni collator` over the repository returned
**zero** — **both measured at 22:58 on 2026-09-04 and both since overtaken; §0.7 records by what.**
So `review` was a hand-made workspace, and that is a hazard rather than a head start:
`ensureWorkspace` find-or-creates by exact `custom_title` match
(`src/backends/cmux/index.ts:114-156`), so a `scripts/review` naming its workspace `review` would
**adopt whatever is currently in that workspace** on its first run. `operations-plan.ts:534-537`
argues exact matching is what stops the two consoles adopting each other; it does not stop either
adopting a workspace a person made. §6.10 makes that a refusal.

### 0.6 What reading the code found

Four findings, all latent, all reachable today, three of which need none of this feature to exist in
order to be wrong. They are stated up front because each changes what a section downstream may assume.

| # | Finding | Reachable today? | § |
|---|---|---|---|
| **A** | **A review is graded `failed`, and the chain is four links.** `reviewer` is `isolation: shared-ro` (`fleet.yaml:434`) → no worktree entry → `host_workdir: "unset"` (`dispatch.ts:786`) → `hasWorktree === false` (`harvest/index.ts:222`) → acceptance is **not run**, because line `:569` requires `hasWorktree` → `facts.acceptance` is empty → `acceptanceEvidence` returns `unknown` (`adjudicate.ts:89-91`) → the ISC-93 branch sees `claimed.status === "success"`, an empty diff, and acceptance that is not `success`, and sets `derived = "failed"` (`adjudicate.ts:231-245`). **Every honest reviewer result in this fleet is currently graded as fabrication.** | Yes — `rev-1` exists and is dispatchable today | §2.6 |
| **B** | **The ISC-93 check is not gated on `facts.repository` and its sibling clamp is.** ISC-151's clamp at `adjudicate.ts:150` reads `if (facts.repository && !facts.base_is_ancestor)`, and `harvest/index.ts:226-242` argues that gate at length: *"NO WORKDIR IS A KIND OF TASK, NOT A DEGRADED HARVEST… A ticket query or a cluster read has no repository BY DESIGN, and grading it as a tampered diff makes its verdict unusable no matter how good its evidence is."* **The identical argument applies to an empty diff and the gate was not added there.** ISC-93 fires on tasks that never had a repository. | Yes — any `isolation: none` or `shared-ro` worker | §2.6 |
| **C** | **The remedy ISC-93's own reason string offers is unavailable to the role it fires on.** The message says *"If this task was not meant to change files, give it acceptance commands — the harvester re-runs those itself and they are what makes a no-diff task gradable"* (`adjudicate.ts:240-243`). The harvester cannot run acceptance for a worker with no worktree (`harvest/index.ts:569`). A `shared-ro` reviewer cannot take the advice it is given. | Yes | §2.6 |
| **D** | **Acceptance commands cannot contain shell metacharacters, and the repository has no working example of the ISC-93 exemption.** `src/harvest/acceptance.ts:428` refuses `\| & ; < > ` $ ( ) \ * ? ~` outright, with the message *"shell metacharacter '…' outside quotes (no shell is ever invoked; commit a script at the base SHA instead)"* (`:457`). `Docs/SRD.md:1239`'s own example — `"kasa status --json \| jq -e .devices exits 0"` — would be `not_run`, and its sibling `"bun test passes"` is prose that tokenizes to a three-word argv and exits non-zero. | Yes | §2.6, §6.8 |

**And one finding that shapes the whole design.** The capability the collator needs already exists on
the host and is *trivially* available there: a host-side process running as the operator can read any
run's `control-auth.json` (mode 0600, same uid), compute any worker's socket path from
`sha256(runId\0workerId)`, and call all nine verbs. **Nothing needs to be built to make dispatch
possible. What has to be decided is who is allowed to ask for it.** This document is therefore not
asking for a new capability; it is asking for a *request channel* into one that already works, and
§4.3 is the argument that the channel must not be the capability itself.

### 0.7 An implementation landed while this was being written, and it agrees on the hard part

**Between 23:12 and 23:16 on 2026-09-04 — after §2's measurements and before this document was
saved — a partial implementation appeared in the working tree.** It is recorded here rather than
quietly incorporated, because a specification that silently rewrites itself to match code has stopped
being able to disagree with it.

What is there: `REVIEW_WORKSPACE`/`REVIEW_TOP_FRACTION`/`reviewPanes` and a `REVIEW_SPEC`
(`operations-plan.ts:766`, `:822`, `:831`; `operations.ts:122-125`), an extracted
`agentSquarePanes(opts, workers, label)` shared with `development`, `scripts/review`,
`test/unit/review-plan.test.ts`, `roles/collator.md`, three aspect files under `roles/review/`, and a
`collator` role plus four workers in `fleet.yaml` — **which is untracked, so `git status` does not show
it changing.**

**It converges on every decision §0.2 and §4.3 argue for, independently.** `REVIEW_TOP_FRACTION` is
`null` (§6.1's equal panes by omission); the square-pane plan is extracted rather than copied (D3's
second half); the collator is `tools: [read, write, grep, find, ls]` with the no-`bash` argument
spelled out in the config itself; and `roles/collator.md` opens *"You cannot dispatch to the reviewers
directly; the fleet does that for you"* — which is D1 and D12, reached without this document.
**Convergence is evidence, not proof, and §4.3 remains the argument of record.**

**Four things it settles that this document had left open, and one where it and this document
disagree.**

| | Status |
|---|---|
| **§9 Q7 — the collator's model** | **Settled: `ollama-cloud/deepseek-v4-pro:0813`, deliberately the same as the architecture reviewer**, on the argument that collation is the same long-reasoning shape and *"costs nothing in diversity: the collator does not vote, it reports who said what."* That reasoning is sound and Q7 should be closed on it — with §4.4's note that a fourth hosted seat is *"four copies of the diff leaving the machine, not three"*, which the config states itself |
| **§6.2's allowlist prerequisite** | **Done, then NARROWED.** It reached five entries as §6.2 required; the owner's later 2026-09-04 decisions took it to three — now `deepseek-v4-pro:0813`, `qwen3.5:397b`, `glm-5.3` — because the models the other entries served are named by no role. See §6.2's amendment |
| **Worker ids** | `col-1`, `rev-arch-1`, `rev-ctx-1`, `rev-lang-1` — better than this document's `rev-a/b/c`, because the id names the lens and the id is what `dispatch --worker` takes (`operations-plan.ts:650-656`). **Read §6 with those ids substituted** |
| **A per-worker `toolchain` override** | `rev-lang-1` carries `toolchain: node` over `reviewer`'s `base`, because the TypeScript lens needs `tsc` and base has none. This document missed it and it is correct |
| **D13 — three reviewers on `rpc`** | **DISAGREES. All four workers are `pane_mode: tui`**, so the console is four adopted terminals, matching `development`. §8 D13 is therefore a live disagreement rather than a settled decision, and §6.1's argument for `rpc` should be answered or D13 withdrawn |

**On D13, the disagreement is real and neither side is obviously right.** Since the owner's 2026-09-02
reversal of SRD-TUI-DISPATCH's D2, a dispatch to a `tui` worker stages *and* auto-triggers, so `tui`
reviewers are dispatchable and §6.1's main objection is weaker than it reads. What `tui` still costs is
four adopted terminals where three are never typed at, and a delivery path that depends on the cmux
surface being present — the route that *"hands the operator the line and says why it could not type
it"* when a surface is unavailable (`ISA.md`, 2026-09-02). What it buys is that each reviewer's pane is
Pi's own interface rather than a log view, which an operator debugging a review will want.
**§9 gains this as Q10, and it is not blocking either way.**

**Nothing else in this document has been altered to match the implementation.** In particular Findings
A-D (§0.6) and §9's two BLOCKING questions are unaffected by it: the code that landed builds a console
and does not touch the harvest, and **a `review` console standing up on a tree where every review is
graded `failed` (Finding A) is the worst of the available orders.** D9 is the first thing to take.

---

## 1. Problem statement

### 1.1 What was asked for, and what of it is free

| Asked for | Status |
|---|---|
| Four equal panes in a 2×2 | **Free.** `developmentPanes` already builds one and §3.1 shows how |
| Top-left is a Pi TUI pane for a `collator` | **Nearly free.** `agentPaneCommand`'s `attach` arm (`operations-plan.ts:302`) is exactly this; the role does not exist |
| The other three are `reviewer` workers | **Free**, with the model overrides §6.2 settles |
| A collator can dispatch to other workers | **Does not exist, and is the whole of §4 and §6** |
| The collator collates into its own `result.json` | **Blocked twice** — by Finding A (the result is graded `failed`) and by §6.6 (the collator cannot wait) |
| Three different aspects from `/CodeReviewer` | **Free at the prompt level** (`append_system_prompt_file`); §6.9 argues who assigns them |

### 1.2 The console that exists, and why `review` is a variant rather than a copy

`DEVELOPMENT_SPEC` (`src/backends/cmux/operations.ts:102-107`) is three fields —
`name`, `panes`, `topFraction` — and `operations.ts:71-81` says why: *"Only three things vary, and
they are exactly these three."* A `review` console differs in all three by only a little: a different
`name`, a `panes` function that is `developmentPanes` with one pane attached instead of four, and the
same `topFraction: null`.

That is the argument for a variant. **The argument against a third script is already written in the
tree**, and it is the answer to the commission's question about a shared spec-driven entry point.
`scripts/development:26-31`:

> "The two scripts are deliberately separate ENTRY POINTS over one shared builder (`ensureWorkspace`,
> given a `WorkspaceSpec`). **A single script with a `--workspace` flag would make "which console am I
> opening" a value the operator has to get right on every invocation, and getting it wrong adopts or
> rebuilds the other one.**"

The build layer is *already* spec-driven — `ensureWorkspace` (`operations.ts:544`), `createWorkspace`
(`:293`) and `restartConsolePane` (`:217`) all take a `WorkspaceSpec`. What is duplicated is the CLI
and reporting layer, and it is duplicated heavily: **164 of `scripts/operations`' 315 lines (52.1%) are
byte-identical and in order to lines in `scripts/development`**, rising to 183 (57.9%) after
normalising the console's own name; the run of `scripts/operations:55-78` ≡ `scripts/development:74-97`
is 24 identical lines carrying the whole `flag()` parser, and `runOutput()` is identical at the same
line numbers (`:303-316`) in both files. A third copy takes that to ~500 duplicated lines.

**D3 takes the repository's own argument and pays the duplication**, because the failure it prevents —
an operator rebuilding the wrong console — is destructive and the failure duplication causes is a
divergence a test can pin. §8 D3 records what that costs and names the cheaper half that should be
taken anyway.

### 1.3 The three aspects, and what the skill actually does

`~/.claude/skills/CodeReviewer/SKILL.md:92-96` defines three angles and the strengths each is chosen
for:

| Aspect | Strengths, verbatim | `SKILL.md` |
|---|---|---|
| **Architecture + security** | "Deep code analysis, security patterns, architectural insights, vendor-source spelunking" | `:94` |
| **Broad cross-file context** | "Broad cross-file context, contract coverage, FR-by-FR matrix verification, multi-perspective synthesis" | `:95` |
| **TypeScript / JavaScript specialist** | "JSDoc + tsc validation, browser API correctness, async cleanup, surrogate-pair edge cases, live runtime probing" | `:96` |

Six dimensions are evaluated by **each** reviewer, not split between them
(`SKILL.md:61-68`): Correctness, Security, Performance, Readability, Best Practices, Error Handling.
**That is load-bearing for §6.9.** The aspects are *lenses*, not a partition of the work: three
reviewers each cover all six dimensions and differ in what they look hardest at. A design that split
the six dimensions three ways would produce three partial reviews that cannot disagree, and
disagreement is the product — `workflows/Review.md:240-249` scores findings by how many reviewers
found them independently (`3/3 — highest confidence`, `2/3 — high confidence`, then single-reviewer).

**Three observations about the skill that the fleet version cannot inherit, and each is a §6 decision.**

- **The fan-out and the join are performed by the caller, not by one of the three reviewers.**
  `Review.md:223-231` — Step 3 "Wait for ALL Three Agents to Complete", Step 4 "Synthesize Reviews" —
  are the *orchestrator's* steps. In the skill, the thing playing the collator's part already has the
  capability to launch agents, by construction. In the fleet it does not, and §0.2 is that whole gap.
- **The shared artifact is a file in `/tmp`.** `Review.md:55-61` dumps the diff to `/tmp/pr-N.diff`
  and each agent reads it. In this fleet `/tmp` is a per-container `tmpfs` (`render.ts:315`), shared
  with nobody. §6.4's request plane is the replacement.
- **Independence is asserted, never enforced.** The three agents receive the same context and are
  launched in one message so they cannot see each other. §6.6 has to reproduce that property
  deliberately, because a collator that dispatches *sequentially* and passes reviewer 1's findings to
  reviewer 2 destroys the consensus arithmetic while looking like a smarter design.

### 1.4 The cost of not having it, stated honestly

There is no measured incident here and this document will not manufacture one. The fleet has a
`reviewer` role and one `rev-1` worker (`fleet.yaml:515`); a single-reviewer review is what it does
today, and Finding A says its result is graded `failed` when it succeeds. **The cost is therefore two
things: one reviewer where the skill's whole argument is that three independent readers catch what one
misses, and a grading pipeline that cannot record either outcome.** The second is worth fixing
whether or not the first is built, and §5.1 puts it in scope for that reason.

### 1.5 Success in one sentence

An operator types a review request at the top-left pane of `scripts/review`; three reviewers on three
different vendors' models each read the target through a different lens without seeing each other's
work; and `pifleet artifacts` returns one collated document, ranked by consensus, under an id the
original request named — with a verdict that is `success` when the review happened and `partial` when
fewer than three reviewers answered.

---

## 2. The current state, read from the code

> Every claim below carries a file and a line. **Read on 2026-09-04, not executed**, except the four
> facts §0.4 marks as observed from the live run tree. §0.4 states what that is worth.

### 2.1 The 2×2 is equal by omission, and that is a property worth not breaking

`developmentPanes` (`operations-plan.ts:620-666`) builds four panes from a hand-written table
(`:643-647`):

```ts
const shape: readonly { split: SplitDirection; splitFrom?: number }[] = [
  { split: "right" },
  { split: "down", splitFrom: 0 },
  { split: "down", splitFrom: 1 },
];
```

with index 0 taking the initial surface. `newSplitArgv` (`src/backends/cmux/client.ts:131-135`) takes
**no size argument** — it halves. So two columns, each halved once, are four quarters before anything
measures anything. `DEVELOPMENT_TOP_FRACTION` is `null` (`operations-plan.ts:590`) and
`applyTopFraction` returns immediately on `null` (`operations.ts:426`), so **no resize command is ever
issued for this console.** The rationale is at `operations-plan.ts:575-583`:

> "The development console's panes are EQUAL, and `null` says so. `new-split` halves, so four panes
> built as two columns each split once are already four quarters — the correction
> {@link OPERATIONS_TOP_FRACTION} exists for is one this layout does not need. `null` skips the resize
> entirely rather than asking for a fraction of `1/2` and relying on the sub-pixel guard to make it a
> no-op."

**There is no layout verb in the cmux path.** The only sizing primitive is
`resize-pane --amount <pixels>` (`client.ts:146-152`), which has exactly three references repo-wide —
its definition, one import, and one call at `operations.ts:480`. The tmux backend does have
`select-layout … tiled` (`src/backends/tmux/argv.ts:167`); the cmux backend deliberately does not, and
`src/backends/cmux/index.ts:159-165` says so: alternating splits *"yields a roughly balanced grid
without depending on the undocumented `--layout <json>` schema (SRD §19 Q3)."*

`DEVELOPMENT_MAX_PANES` is 4 (`operations-plan.ts:593`) with the comment *"The largest 2x2 there is. A
fifth pane has nowhere in this shape to go."*, and `developmentPanes` refuses more (`:629-634`) and an
empty set (`:626-628`).

### 2.2 Pane creation order decides the layout, and this console is the easy case

`operations-plan.ts:479-501`, verbatim and load-bearing for §6.1:

> "DOWN off the OBSERVER, and SECOND in creation order — which is what makes it span the WHOLE bottom
> rather than a column of it.
>
> **The first split decides the major axis, and that is the entire reason this pane is created before
> `ticketing` rather than after it.** Built third, it could only ever split one column: by then the
> surface has already been divided left/right and there is no surface left that spans both."

That comment is about the `operations` console's asymmetric 2-over-1. **The `development` 2×2 is the
case where order does not fight the layout** — but it still matters, and `createWorkspace` says why
(`operations.ts:309-313`): the `surfaces[]` array exists so *"the bottom-right pane splits off the
top-right, not off the bottom-left it was created after… the layout silently comes out as 3+1 rather
than 2+2."* The `splitFrom` indices in `shape` are what encode that, and they are pinned by
`test/unit/development-plan.test.ts:65-72`.

**The consequence for `review`: index 0 is top-left and must be the collator.** Index 0 is the pane
that takes the initial surface (`operations-plan.ts:640-642`, `:664`), and it is also the only pane
`--attach-here` can be given (§2.3). The operator's "top-left is the collator" is therefore not a
preference the design has to honour; it is the only position the attached pane can occupy.

### 2.3 Four panes are four runs, and every seat in `development` is `tui`

`agentPaneCommand`'s docblock (`operations-plan.ts:246-253`):

> "## ONE `up` PER AGENT PANE, each naming only its own worker
>
> A single `up` naming several cannot attach them all — `--attach-here` hands over the terminal of the
> process that runs it, and one process has one terminal, so `attended/adopt.ts` refuses with 'can
> hand over ONE terminal and this run has N tui workers'. **N attended panes are therefore N runs**,
> which is why `status` grew `--all` and why `--recreate` stops every live run rather than only the
> newest."

`adoptRefusal` (`src/attended/adopt.ts:101-103`) permits exactly one `tui` worker per run and refuses
zero and many. Every `development` worker is `pane_mode: tui` (`fleet.yaml:500`, `:501`, `:504`,
`:515`), so that console is four runs today.

**A pane does not require `tui`.** `agentPaneCommand:257-268` describes four rungs, and rung 1 without
`attach` is *"`up` returns at once and stage 2 is the pane's whole life"* — stage 2 being
`logs --follow --render`, which **blocks and prints events as they happen**. So an `rpc` worker still
occupies a full pane, as a live rendered event view. §6.1 uses this.

`logs` takes `-r, --run <id>` defaulting to the most recent run (`src/cli/commands/logs.ts:309`).
`pifleet attach` does **not** help: `attach.ts:1-6` — *"Focus is the ONLY thing this does. It does not
attach a terminal, does not read the pane, and does not touch the control plane."* There is no way to
hand a terminal to a worker in an already-created run; `up --attach-here` is the only route, and it
creates the run. §9 Q2 holds what that costs a single-run console.

### 2.4 The control socket: three gates, nine verbs, one run-scoped secret

The nine verbs the worker supervisor accepts (`src/supervisor/index.ts:2374-2907`): `ping` (`:2376`),
`status` (`:2379`), `dispatch` (`:2382`), `stage` (`:2628`), `unstage` (`:2645`), `steer` (`:2655`),
`export_html` (`:2768`), `abort` (`:2853`), `shutdown` (`:2901`). The registry daemon's own socket
accepts five more (`registry.ts:810-836`).

**There is no per-verb and no per-worker authorization.** Authentication is one shared secret per
**run** — `control-auth.json` at the run root, `{schema, run_id, secret, created_at}`, mode 0600,
observed on the live run tree — checked at the framing layer before any handler sees a verb
(`registry.ts:499`, `:506`). The socket is per **worker**, at a deterministic path
(`paths.ts:917-920`). So the capability's natural unit is: *(one worker's socket path) + (that run's
secret) = every verb on that worker.*

**Because each attended pane is its own run (§2.3), the capability is already worker-shaped**, and
that is a genuine accident of the console's design rather than a security control anyone chose. §4.3
declines to rely on it.

### 2.5 What a container can reach, and what it cannot

| Target | Reachable from a worker container? | Evidence |
|---|---|---|
| Another worker's control socket | **No.** No socket is mounted anywhere; `render.ts`'s mount table has none | `render.ts:303-546`; `assertNoRunDirMount` at `:574` |
| The run directory | **No, and refusing is enforced on the finished argv** | `paths.ts:827-836`, message at `:803-807` |
| The Docker socket | **No — and the path is a honeypot that records the attempt** | `docker/honeypot.cjs:7-10`, `docker/entrypoint.sh:356-380` (exit 71 if it cannot bind) |
| The Docker host | **No.** `--internal` is a FORWARD-chain control only; the gateway is closed by an explicit `iptables -I INPUT … -j DROP` | `src/security/gateway-block.ts:4-18`; measured 2026-08-19, a container pulled `SSH-2.0-OpenSSH_9.6p1` off `172.18.0.1:22` before the rule |
| **Another worker container** | **YES** | `gateway-block.ts:21-24`: *"container-to-container traffic and Docker's embedded DNS both survive it, because neither is gateway-destined"* |
| Its own `/outbox` | **Yes, read-write**, and a host-side reader already polls it | `render.ts:453`; `VerbgateCollector` on the daemon's `setInterval`, `registry.ts:896-900`, `:922-936` |

Two entries carry §6. **Worker-to-worker network reachability already exists** — so a "collator talks
to reviewers" design that used HTTP between containers would need no new mount and no new mechanism,
and would also be entirely outside the fleet's control plane, unaudited, unfenced, and invisible to
`report`. §5.2 refuses it explicitly rather than by omission.

**And the outbox is already a one-way channel from a container to a host-side actor that already
polls it.** `registry.ts:922-936` runs the verbgate collector on the daemon's interval, reading
`<run-dir>/outbox/<worker>/ledger/verbgate.jsonl` through a `TailReader` holding a byte offset, plus a
bounded final pass at shutdown (`:974-1004`). **There is no `fs.watch` or `chokidar` anywhere in
`src/`** — everything is interval polling. §6.4 is the same shape with a second file.

### 2.6 A review is graded `failed`, and the chain is four links

The lattice is `failed < blocked < partial < success` with `unknown` as the **identity**, not the
bottom (`src/contracts.ts:71-79`) — the commission's `:72` is the docblock's first line and is
correct. The full verdict enum is seven values (`contracts.ts:56-64`): the four lattice members plus
`aborted`, `timed_out` and `unknown`.

`adjudicate` (`src/harvest/adjudicate.ts:119`) weighs derived facts against the claim. The ISC-93
branch, after commit `ddf8b16`, is at `:231-245`:

```ts
if (claimed.status === "success" && emptyDiff) {
  if (acceptance.verdict === "success") {
    reasons.push("empty diff, but the acceptance commands passed when the harvester re-ran them …");
  } else {
    derived = "failed";
    reasons.push("envelope claims success with an empty diff and no commits (ISC-93). If this task "
      + "was not meant to change files, give it acceptance commands …");
  }
}
```

Its docblock (`:200-230`) is exactly right about the case and is the reason this document can be
short about it:

> "An empty diff is not evidence of idleness — it is the NORMAL shape of a task whose deliverable is
> information rather than a change: run this suite, **review this branch**, find out whether X
> reproduces… `acceptance.verdict === "success"` is not the worker's word for it. `facts.acceptance`
> holds the exit codes of the commands THE HARVESTER re-ran, in a fresh clone, in a container the
> worker never touched — the one piece of evidence in this function a fabricating worker cannot
> author."

**And the exemption is unreachable for a reviewer.** Four links, each independently correct:

1. `reviewer` is `isolation: shared-ro` (`fleet.yaml:434`), which mounts `<repo>:/workspace:ro` and
   creates **no worktree** (`render.ts:446`).
2. With no worktree entry, `dispatch` writes `host_workdir: "unset"` — `dispatch.ts:786`,
   `partial["host_workdir"] ?? wt?.path ?? "unset"`.
3. `hasWorktree` is `envelope.host_workdir !== "unset" && … !== ""` (`harvest/index.ts:222`), so it is
   false; and the acceptance runner's guard is
   `if (opts.runAcceptance === true && git.ok && git.facts.head_ref !== null && hasWorktree)`
   (`:569`). Its own docblock says why (`:565-567`): *"Requires a real head SHA and a worktree to
   clone from. Without either there is nothing to examine."*
4. `facts.acceptance` therefore stays empty, `acceptanceEvidence` returns
   `{verdict: "unknown", reasons: ["no acceptance commands were run"]}` (`adjudicate.ts:89-91`), the
   `else` arm fires, and `derived = "failed"`.

**A reviewer that reads the code, finds three real defects, writes a correct envelope and claims
`success` is recorded as having fabricated its work.** The self-report cannot rescue it: the lattice
combination is `min`, and *"Self-report may downgrade, never upgrade"* (`adjudicate.ts:14`, SRD §7.3);
`skills/pifleet-worker/SKILL.md:138` states the same to the worker.

**Finding D closes the last escape.** Even granting a worktree, the acceptance commands must survive
`tokenize`, which refuses `| & ; < > ` $ ( ) \ * ? ~` outright (`acceptance.ts:428`) with the message
*"no shell is ever invoked; commit a script at the base SHA instead"* (`:457`). Commands are resolved
**from the base SHA, never from the worker's tree** (`harvest/index.ts:558-563`) — *"independence is a
property of where the command is resolved from, not of who runs it, because the command string routes
through `package.json` scripts, `conftest.py` and the Makefile, all of which the worker can edit."*

So the honest statement of the problem §6.8 must solve: **the harvester's only instrument for grading
a no-diff task is re-running a committed command in a fresh clone of a worktree, and a review has no
worktree, no diff, and no command that could prove a person's judgement was exercised.**

### 2.7 Nothing named `collator`, and `review` is a workspace pifleet has never heard of

**As measured at 22:58 on 2026-09-04**, and every figure here was overtaken during this document's
authorship — §0.7. `grep -rni collator` over the repository (excluding `node_modules`, `.git`,
`coverage`): **zero hits.** `review` in `fleet.yaml`: five hits, all the `reviewer` role and worker
(`:418`, `:433`, `:511`, `:514`, `:515`). `WorkspaceSpec` instances in `src/`: two. And §0.5
correction 5 records the live cmux workspace that existed anyway.

There is also **no console selector on the CLI.** `src/cli/commands/` holds 24 files and none is
`console` or `workspace`; selection is entirely which script you ran. `package.json:19` has an
`"operations"` script entry and **no matching `"development"` entry** — a small existing asymmetry a
third console makes worse.

---

## 3. What is knowable

### 3.1 Knowable and free: four equal panes

§2.1. `shape` plus `topFraction: null` plus a `new-split` that halves. A `review` console that reuses
`developmentPanes`' table gets the 2×2 with no new code and no resize call. **The one thing that must
not be copied is `DEFAULT_DEVELOPMENT_WORKERS`**, and §6.1 says which function should be shared and
which must not.

### 3.2 Knowable and currently unused: an `rpc` worker's pane is a live event view

§2.3, `agentPaneCommand:257-268`. This is the fact that lets three of the four seats be dispatchable
over the control socket while still filling their squares.

### 3.3 Not knowable without a probe, and it decides §6.6: whether a collator can wait

`TUI_QUIET_MS = 2_000` (`src/supervisor/tui.ts:234`). A `tui` turn settles after **two seconds** of
transcript quiet following a stop. `TUI_ERROR_GRACE_MS` is longer and its docblock (`:236-250`)
records the measured reason: on run `2026-09-04T00-26-46Z-1002` a provider dropped three turns, the
supervisor settled the worker `failed` at 00:28:43.537, and the worker went on to run the suite and
finish cleanly at 00:28:59.568.

**A collator that fans out and then waits has to stay in-turn**, because a turn that stops is settled
two seconds later. Staying in-turn means emitting tool calls continuously. **And the collator has no
way to pace them**: a role with `tools: [read, write, grep, find, ls]` has no `sleep`, and giving it
`bash` to get one is precisely the §12.1 widening §4.1 refuses. So the choice is between a collator
that busy-reads a reply file for up to half an hour, and a design in which the collator never waits.
§6.6 takes the second. **This is the strongest single argument in the document and it is an argument
from a constant, not from taste.**

### 3.4 Not knowable at all: whether a reviewer read anything

Nothing in this fleet observes what a model attended to. `transcript_activity`
(`supervisor/index.ts:2013-2019`) records that the session file grew. A reviewer that emits a plausible
review having read one file is indistinguishable from one that read forty. §6.8 and §7.3 both turn on
this, and neither pretends otherwise: the consensus arithmetic (§1.3) is the only instrument the design
has, and it detects *disagreement*, not *effort*.

---

## 4. The principles this bumps into

### 4.1 §12.1 — tool scope is not a boundary, and `config validate` enforces the reviewer's shape

`Docs/SRD.md:1790-1792`:

> "Pi's `bash` tool spawns a shell with `cwd` as a *starting directory only* and the full process
> environment. Nothing in Pi prevents `cd /`, redirection, `rm -rf`, `git push`, or `curl | sh`.
> **Therefore:** a role granted `bash` is fully privileged *inside its container*, and that is the
> only statement `pifleet` makes. Roles claimed read-only (`reviewer`, `researcher`) are given
> `[read, grep, find, ls]` and **not** `bash`. `config validate` **rejects** any role that combines
> `bash` with a `read_only: true` marker."

Two mechanical facts qualify it and both matter for the collator. The refusal is enforced at **both**
the role and the worker level and resolves an omitted `tools:` to the full builtin set **first**
(`schema.ts:1462-1503`), so the common shape — `read_only: true` with no `tools:` — is caught rather
than passing as "no bash named". And `schema.ts:1465-1472` states the trap in the other direction:
*"Omitting `tools` is NOT 'no tools' — pifleet then passes no `--tools` flag and Pi grants every
builtin, `bash` among them."*

**`PI_BUILTIN_TOOLS` is seven names** (`schema.ts:66`): `read, bash, edit, write, grep, find, ls`.
They are passed to Pi verbatim (`render.ts:232`, `--tools <csv>`) with no mapping layer and no
validation on Pi's side — `schema.ts:60-65` records that *"v1.1's researcher role requested
[`web_fetch`] and was silently granted nothing."*

**There is therefore no tool name that means "dispatch", and there cannot be one without a Pi
extension.** A collator cannot be granted the capability as a tool. It can only be granted a *general*
capability — `bash` — and reach something with it. **That is the whole reason §0.2 calls this a new
capability class**: the request is for a narrow power and the only available grant is a broad one.

### 4.2 The seam the config already draws

`fleet.yaml:511-514`, quoted in §0.2: *"`pifleet shell` still reaches the container, because that is
the FLEET exec'ing in, not a tool the reviewer may call."* `pifleet exec` is the same shape —
`src/cli/commands/exec.ts:1-6` runs `docker exec` **from the host** and is unavailable inside a
container by construction.

So the fleet already has two capabilities it exercises *on* workers that no worker may invoke, and it
already has the vocabulary for the distinction. §6 adds a third and keeps it on the same side of the
seam.

### 4.3 The argument that decides it: a granted socket is a prompt-injection channel with a fleet-issued identity

Suppose disposition (1). The collator's container gets `bash`, a mount of three sibling sockets (or
one broker socket), and the run secret in a file it can read.

**What a compromised or confused collator then holds.** Not "the ability to dispatch a review". The
socket accepts nine verbs (§2.4) and there is no per-verb scoping to withhold. Concretely, it holds
`dispatch` and `steer` — the ability to put arbitrary text into another agent's prompt — against three
workers, one of which (`engineer`, if the console is ever widened) has `write`, `edit` and `bash`.
`Docs/SRD.md` §12.7 names this in its own opening sentence: *"the control socket accepts
`dispatch`/`steer`/`abort` — **arbitrary prompt injection into a privileged agent**."* The section
exists to keep that away from *another user on the host*. Disposition (1) hands it to a program the
fleet is running on untrusted input.

**And the input is untrusted by the SRD's own account.** `Docs/SRD.md` §12.2 — *"Repo content is
untrusted input"* — and §12.6 — *"Worker-authored prose is data, never instruction"*. **A review
console reads more untrusted content than any other role, because breadth is the job.** The collator's
context is a review request that may name a branch, plus three reviewer reports that are themselves
worker-authored prose. A design that gives *that* process a dispatch capability has inverted §12.6:
the prose is now upstream of an instruction.

**Four things make this worse than an ordinary trust extension, and none is hypothetical.**

1. **A broker does not fix it, it relocates it.** A broker that accepts "dispatch task T to rev-a"
   still accepts a *task body*, and the task body is the injection. Narrowing the *verb* set to
   `{dispatch}` and the *worker* set to `{rev-a, rev-b, rev-c}` leaves the payload unconstrained,
   which is the part that matters. To constrain the payload the broker would have to understand what a
   legitimate review request looks like — and then it is not a broker, it is §6's actor with a socket
   bolted on.
2. **The blast radius is not bounded by the container, so §12.1's sentence does not apply.** Every
   other capability in this fleet is answered by "and that is the only statement `pifleet` makes,
   because the container bounds it". This one is not bounded by the container. It is the first
   capability for which the SRD's standard answer is unavailable.
3. **The audit trail would be right and useless.** A `dispatch` arriving over the socket is ledgered
   as a dispatch. Nothing in the row distinguishes "the operator asked for this" from "a model
   decided to". The fleet's identity model has one principal — the run secret — and it would now be
   held by two very different kinds of actor.
4. **The transport is unproven on this host and the gate may fail the wrong way.** `classifyPeer(fd,
   expectedUid)` admits exactly one uid (`peer-uid.ts:314-345`); a container process is uid 10001
   (`render.ts:309`) and the supervisor is the operator's uid, so the gate should refuse — but
   `peer-uid.ts:83-101` records that the check **fails open** where the platform cannot report
   credentials, and a unix socket bind-mounted across the Docker Desktop / colima file-sharing
   boundary is exactly the case where it might not. **This document did not probe it** (§9 Q3), and
   the point is not which way it resolves: a security control whose direction depends on an
   unmeasured VM boundary is not one to build a capability on.

**Could it be guarded?** Partly. A dedicated per-capability token, a verb allowlist in the framing
layer, a broker that pattern-matches request bodies. Each is real work, each is a new thing to get
right, and the sum of them reconstructs a host-side actor with extra steps and a live socket into a
container. §6 builds the actor and skips the socket.

### 4.4 §5.9 and the launch directory — the repo-sensitivity rule fires, and it fires today

The `CodeReviewer` skill has a routing rule whose whole purpose is the situation this console creates.
`workflows/Review.md:35-49`, Step 0:

> "**Before gathering context, determine whether the target repo is Broadcom or AppNeta-owned.** These
> repos must never have their code sent to external Gemini/Codex APIs — only Claude-family agents may
> see them… Contains `github.com/appneta` or `github.com/dan-elliott-appneta` → **SENSITIVE**."

**The `review` console's stated launch directory is `~/repos/rally-cli`, whose origin is
`https://github.com/dan-elliott-appneta/rally-cli.git`** — read on 2026-09-04. Under the skill's own
rule that is SENSITIVE.

And the launch directory is not incidental: it **becomes the run's repository**.
`resolveLaunchRepo` (`src/container/mounts.ts:393-398`) is called at `up.ts:1045` and assigns
`loadedConfig.config.run.repo = launchRepo` at `:1047`. Its docblock (`:369-392`) records the measured
failure that forced it — *"a console launched from `~/repos/rally-cli` to test rally-cli handed every
worker **cmux-fleet** as its workspace… **The launch directory has to BE the workspace**"*.

So the chain is: launch dir → `run.repo` → `<repo>:/workspace:ro` for a `shared-ro` reviewer
(`render.ts:446`) → the model that reads it. And the model is hosted. `fleet.yaml:136-139`:

> "**HOSTED.** A third party serves the model, and everything in an assigned worker's context — its
> transcript, its tool output, and **the repository under /workspace as the agent reads it** — is sent
> to them."

`Docs/SRD.md:742`: *"There is no ceiling, timeout or scope that reduces a transcript after it has been
sent."*

**Three consequences, and the owner must take the first two explicitly.**

1. **§5.9's permission does not cover this console.** `Docs/SRD.md:733-735` bounds it: *"On this fleet
   that is Ollama Cloud, on the `engineer`, `tester` and `reviewer` roles — **the `development`
   console's four seats** — and nothing else."* A `review` console is not those seats. §6.2's design
   sends the same repository to **three** vendors instead of one, which is a widening of the
   disclosure axis in both dimensions — more seats and more third parties. **This is an amendment to
   §5.9, and this document asks for it as one rather than reading the existing sentence generously.**
2. **There is no in-fleet analogue of the skill's Claude-only fallback, and pretending otherwise would
   be the error.** The skill's answer to a sensitive repo is to route all three angles through the
   *one* vendor already trusted with it. The fleet's equivalent is `provider: omlx` — the operator's
   own instance, `hosted: false` (`fleet.yaml:104`). So the analogue **exists and costs the design its
   whole premise**: three local reviewers on two allowlisted local models
   (`Qwen3.5-35B-A3B-8bit`, `gpt-oss-20b-MXFP4-Q8`, `fleet.yaml` `omlx.models_allowlist`) cannot
   deliver §6.2's family diversity, because there are not three families. **The choice is between
   vendor diversity and repository confidentiality, and it cannot be had both ways for a proprietary
   target.** §9 Q1 is BLOCKING for exactly this reason.
3. **The precedent for choosing confidentiality already exists and is recent.** `fleet.yaml:358-362`,
   on the `observer` role, by owner decision 2026-09-03:

   > "LOCAL 20b, by owner decision 2026-09-03 — not `ollama-cloud/gpt-oss:120b`, which is the same
   > family served by a third party. **An observer reads clusters and logs, so its context is the
   > fleet's most sensitive and the one least worth sending out.**"

   The identical sentence can be written about a reviewer with the word "repository" substituted, and
   the owner has already made this trade once on the same axis in the opposite direction from §6.2.

**What this document will not do is pick a default.** §6.2's models are settled by owner decision and
are written as settled. Whether that decision survives contact with a *proprietary* launch directory
is not a technical question and §9 Q1 puts it back.

### 4.5 The shape of the exception this document asks for

**On the control plane: none.** §6 asks for no new inbound surface, no socket in a container, no
secret in a container, and no widening of the nine verbs or their single-principal auth model. The
collator writes a file in a directory it already has, and a host-side process that already has every
capability reads it.

**On the tool grant: one word.** The collator gets `write`, which `observer` already has for the same
reason (`fleet.yaml:365`, *"write is for the outbox artifact only"*). It does not get `bash`.

**On §5.9: a real amendment, and §4.4 is the argument.** That one is not free and should not be
written as though it were.

---

## 5. Scope and non-goals

### 5.1 In scope

- A `review` console: `WorkspaceSpec`, pane plan, and `scripts/review` (§6.1, D3).
- A `collator` role and worker, and the three reviewer workers with their per-aspect models and
  prompts (§6.2, §6.9).
- The request plane by which a collator asks for work to be dispatched, and the host-side actor that
  performs it and returns the replies (§6.3-§6.5).
- Fan-out, join and partial-result semantics against the existing lattice (§6.6).
- Deadline arithmetic across a two-level dispatch (§6.7).
- **Findings A, B and C as prerequisites, in their own change** (§6.8, D9). They are wrong today,
  independently of this console.
- The §5.9 amendment §4.4 requires (D2), which is an owner decision and not an implementation.

### 5.2 Non-goals

- **A control socket, a broker socket, or any inbound channel into a worker container.** §4.3. D1.
- **Worker-to-worker HTTP**, which §2.5 shows already works at the network layer and which is refused
  explicitly rather than by omission: it is outside the ledger, outside the fence, invisible to
  `report`, and would make `pifleet down` non-authoritative about what is running.
- **A Pi extension that provides a `dispatch` tool.** §12.2 makes `--no-extensions` mandatory and
  non-overridable (`render.ts:124` pushes it unconditionally); re-opening extension loading for this
  is a larger change than the feature.
- **Giving the collator `bash`.** §3.3 and §4.1. If §9 Q4 resolves such that the collator must wait
  in-container, this becomes a live question again and should be re-taken, not assumed.
- **A collator dispatching to a collator, or to itself.** D7.
- **Reading pane text**, for any purpose. `Docs/SRD.md` §0.2 Decision 1.
- **Making `review` schedulable by `dispatch --auto`.** The collator's seat is `tui`; `--auto` refuses
  those, and a DAG that blocks on a two-level fan-out through a file plane is a different design.
- **Grading the *quality* of a review.** §3.4. The design records what three readers said and how much
  they agreed; it does not certify that any of them read anything.

### 5.3 Deliberately deferred

- **A general `depends_on` fan-out for any role.** `TaskSpecSchema` already carries `depends_on`
  (observed in the inbox record) and `src/orchestrate/` already has a scheduler with a DAG. §6's actor
  is a narrower thing that does not use it, and unifying them is the right eventual shape and the
  wrong first step. §9 Q5.
- **More than three reviewers.** `DEVELOPMENT_MAX_PANES` is 4 (`operations-plan.ts:593`) and a fourth
  reviewer has nowhere in a 2×2 to go. A headless reviewer with no pane would fit and is not designed
  here.
- **Cross-console collation** — a collator in `review` dispatching to `eng-1` in `development`. The
  actor could do it (§0.6's last finding); D7 refuses it for now because the console's worker set is
  what makes the aspect assignment legible.

---

## 6. The design

### 6.1 The console

**One `WorkspaceSpec`, one plan function shared with `development`, one new script.**

```
REVIEW_SPEC: { name: "review", panes: reviewPanes, topFraction: null }
```

`topFraction: null` for the reason `DEVELOPMENT_TOP_FRACTION` has it (§2.1) — the panes are equal and
`null` says so rather than asking for a fraction of ½.

**`reviewPanes` is `developmentPanes` with two changes and one thing that must not be shared.**
The split table (`operations-plan.ts:643-647`), the `DEVELOPMENT_MAX_PANES` refusal, the
worker-id-as-title rule (`:650-656`, *"The id is also what `dispatch --worker` takes, so the title is
the argument"*) and the `assertPlainValue` guards are all correct here unchanged and should be
**extracted into one shared `squarePanes(opts)` rather than copied**. What must not be shared is
`DEFAULT_DEVELOPMENT_WORKERS`: a `DEFAULT_REVIEW_WORKERS` of `["col-1", "rev-a", "rev-b", "rev-c"]`
sits beside it, and index 0 is the collator because index 0 is the pane that takes the initial surface
(§2.2) and the only one `--attach-here` can be given.

**The four seats, and the pane_mode split is the design's quiet load-bearer:**

| Pane | Worker | `pane_mode` | What the pane runs |
|---|---|---|---|
| top-left | `col-1` | `tui` | `up --workers col-1 --attach-here --attach-clear` — Pi's own interface; the operator types here |
| top-right | `rev-a` | `rpc` | `up --workers rev-a` then `logs --worker rev-a --follow --render` |
| bottom-left | `rev-b` | `rpc` | as above |
| bottom-right | `rev-c` | `rpc` | as above |

**Three `rpc` seats, not `tui`, and the reason is not cosmetic.** §2.3: an `rpc` worker still fills its
pane with a live rendered event view, and it is dispatchable over the control socket with no staging,
no typed trigger and no adopted terminal. `development` makes all four `tui` and pays four runs for it
(`fleet.yaml:500-515`); `review` needs exactly one interactive seat and should not pay for four.
**`operations` is the precedent, not `development`** — `fleet.yaml:477-478` keeps `obs-2` on `rpc` to
take dispatched passes while `obs-1` is the human's seat.

**This console is still four runs**, one per pane, because each pane runs its own `up` naming only its
own worker (`operations-plan.ts:246-253`). D4 records why a single-run console was rejected and what it
would have bought.

`scripts/review` is a third copy of the ~165-line CLI shell (§1.2). D3 takes it and names the cheaper
half that should be taken with it.

### 6.2 The workers and the models — settled

**Owner decision, 2026-09-04.** Three reviewers, three vendors, one aspect each.

> **AMENDED by owner decision later on 2026-09-04 — twice, and both revisions are recorded because a
> table that changes without saying so reads as drift.** The constant across both is that `kimi-k3` is
> not to be used as a reviewer model; that is the rule, the rest was a pick.
>
> **First revision:** `rev-arch-1` -> `glm-5.3`, `rev-ctx-1` -> `gemma4:31b`, `rev-lang-1` ->
> `gpt-oss:120b`, collator and every `development` seat -> `glm-5.3`.
>
> **Second revision, and the one in force:**
>
> | Worker | Model | Window | Why this seat |
> |---|---|---|---|
> | `rev-arch-1` | `ollama-cloud/deepseek-v4-pro:0813` | 1,048,576 | back to its original: the deepest single-thread reasoner, for the angle that thinks longest per token read |
> | `rev-ctx-1` | `ollama-cloud/qwen3.5:397b` | 262,144 | back to its original: the largest model at 397B, for the angle whose job is holding the whole neighbourhood at once |
> | `rev-lang-1` | `ollama-cloud/glm-5.3` | 1,048,576 | the seat that actually changed hands — `kimi-k3`'s replacement, and what keeps the console at three vendors |
>
> **The three-vendor property survives both revisions**: DeepSeek, Qwen and Zhipu, so every consensus
> argument below stands unchanged. The collator returns to `deepseek-v4-pro:0813` and so keeps Q7's
> arrangement — the same model as the architecture reviewer, which is what Q7 settled on. Separately,
> every `development` console seat runs `deepseek-v4-pro:0813`; that console's seats do not
> cross-check each other, so uniformity there costs no signal. `thinking: high` is unchanged for all
> four review seats, and all three models attest `thinking` and `tools`. Probed host-side 2026-09-04:
> `deepseek-v4-pro:0813` 1165ms, `qwen3.5:397b` 1874ms, `glm-5.3` 1454ms — with one 26,148ms cold
> outlier on `glm-5.3` worth knowing, because this probe is a gate that refuses the whole fleet.
>
> **`roles/collator.md`'s copy of this table is now pinned to the config by
> `test/unit/review-plan.test.ts`.** It had gone stale across the first revision — all three names
> wrong in the document the collator briefs from — and the probe caught the second revision
> immediately, which is the only reason this row and that table still agree.
>
> The original three, superseded:

| Worker | Aspect (`SKILL.md:94-96`) | Model | `thinking` |
|---|---|---|---|
| `rev-a` | Architecture + security — OWASP, security patterns, vendor-source spelunking | `ollama-cloud/deepseek-v4-pro:0813` | `high` |
| `rev-b` | Broad cross-file context, contract coverage, FR-by-FR verification matrix | `ollama-cloud/qwen3.5:397b` | `high` |
| `rev-c` | TypeScript/JS specialist — tsc, async cleanup, runtime probing | `ollama-cloud/kimi-k3` | `high` |

**Family diversity is the product, and it is the reason for three models rather than three seats on
one.** Three workers on one model is one reviewer with three transcripts: a shared training blind spot
is invisible by construction, and the console exists precisely to catch what one reader misses. The
consensus arithmetic of §1.3 — `3/3` is the highest-confidence band — is arithmetic over *independent*
readers, and two readers with the same weights are not two readers. DeepSeek, Qwen and Moonshot are
three vendors, three corpora, three failure profiles. **That is the whole reason the aspect split is
worth building rather than running one reviewer three times.**

**Each pick matches its aspect.** `deepseek-v4-pro` is the `pro` build and the deepest single-thread
reasoner in the catalogue — architecture and security is the aspect that must think longest per token
read, which is already the argued reason the `reviewer` role runs it today (`fleet.yaml:424-427`:
*"Review is the role that should think longest per token read"*), and that argument carries over
unchanged. `qwen3.5:397b` is the largest model available at 397B, and "hold the whole diff and every
contract in mind at once" is the cross-file aspect's entire job. `kimi-k3` is the frontier general
build of the family the `engineer` role already trusts for code (`ollama-cloud/kimi-k2.7-code`,
`fleet.yaml:399`) — `k3` rather than `k2.7-code` because the language-specialist reviewer *reads and
reasons about* TypeScript, it does not write it.

**Two exclusions, both measured by the operator on 2026-09-04, both named so a later operator does not
re-litigate them.**

- **`mistral-large-3:675b` is excluded on CAPABILITY, not speed.** Its vendor `capabilities` are
  `completion, tools, vision` — **no `thinking`**. Every reviewer here carries `thinking: high`.
- **`kimi-k2.6` is excluded on LATENCY, and the mechanism matters.** It answered correctly in
  **102,486 ms**, which exceeds this provider's `probe_timeout_ms: 90000` (`fleet.yaml:188`). Naming it
  would make `up` refuse the whole fleet with a `timeout` verdict **on a model that is in fact
  answering correctly** — and the schema's own error text says what to do instead
  (`schema.ts:829-831`): *"For a model that genuinely needs longer, exclude it with this provider's
  models_allowlist (SRD D16) rather than widening the budget for every model on the endpoint."*
  `schema.ts:794-800` gives D16's second job as *"excluding models measured near the ceiling"* and
  calls it *"the cheaper of the two controls because it needs no code at all."*
- **`nemotron-3-super` (1,282 ms) and `nemotron-3-ultra` (19,332 ms)** are inside budget; `ultra` is
  ~20× the cheapest pick. **Noted as the fallback if one of the three is withdrawn, not as a pick.**

**The allowlist is a prerequisite and an ordered step.** `fleet.yaml:173-176` names exactly three
models — `kimi-k2.7-code`, `gpt-oss:120b`, `deepseek-v4-pro:0813` — and its own comment (`:158-161`)
states the consequence: *"the allowlist is the ceiling `up` checks every role's `model:` against — so
a role naming anything else fails at `up` with the field and the file rather than at generation
time."* **`qwen3.5:397b` and `kimi-k3` are not on it.** Widening it from three to five is required
before the console comes up once. Two second-order effects come with it: the tool-call gate is
*"sequential and mandatory"* so an operator waits `distinct (provider, model) pairs × budget`
(`schema.ts:788-790`) — five allowlisted models at a 90 s ceiling is a 7.5-minute worst case for `up`,
against ~7 s at the operator's measured times; and the allowlist's own comment says "THREE MODELS, ONE
PER ROLE", which stops being true and should be rewritten rather than left to mislead.

**`tag_style: true` is why `qwen3.5:397b` is spellable at all.** `fleet.yaml:177-181`: Ollama's entire
catalogue is tag-style, so `:thinking` suffix stripping is off for this provider or *"a tag that
happens to be spelled like a thinking level is silently eaten."* `:397b` is a tag; `thinking: high` is
the key. Both models added here carry a colon and both depend on that flag being set.

**The cost is disclosure, and it is larger than §5.9 currently permits.** Every one of these is
`hosted: true`. A code review sends the diff, the surrounding files the reviewer chooses to read, and
its whole transcript to a third party — **and a review console reads more of a repository than any
other role, because breadth is the job.** Three vendors means the same repository content reaches
three third parties instead of one. What bounds it is real but narrow: `tools: [read, grep, find, ls]`
means a reviewer cannot exfiltrate by any route of its own, and `isolation: shared-ro` means it cannot
write. What does not bound it is anything after the fact — `Docs/SRD.md:742`. §4.4 and §9 Q1 are where
this is decided, not here.

**One role with three worker-level overrides, not three roles.** `WorkerEntrySchema` extends
`RoleFieldsSchema` (`schema.ts:185-188`), so a worker may override every role key. The decisive fact is
that **briefings CONCATENATE across levels while every other field is replace-wins** — `load.ts:754-756`:
*"Briefings CONCATENATE across levels by design — the one deliberate departure from replace-wins."*
So:

- `roles/reviewer.md` stays where it is and keeps the shared discipline it already carries (rank by
  consequence, give the failing case, quote file and line, write the envelope last).
- each of `rev-a`/`rev-b`/`rev-c` carries a worker-level `model:` and a worker-level
  `append_system_prompt_file: ./roles/review-arch.md` (resp. `-context`, `-lang`) holding **only** the
  aspect.
- the two are concatenated into one `/briefing/system-append.md` by `render.ts:126-141`.

**Three roles was the alternative and it loses on DRY without winning anything back**: the shared
review discipline would be triplicated in three role files with no include mechanism, and the one
thing three roles would buy — a role name in `up`'s allowlist refusal — is worth less than three copies
of a prompt that will drift. **The cost of the recommendation is real and should be stated:** the
`workers:` block is currently a one-line-per-worker table (`fleet.yaml:466-515`,
`- {id: rev-1, role: reviewer, pane_mode: tui, theme: nord}`), and three workers carrying a `model:`
and an `append_system_prompt_file:` break that shape. The most important fact about each reviewer —
which lens it is — then lives in the workers block rather than the roles block. §9 Q6 offers the
operator the reverse trade.

**The collator's model is NOT settled and this document will not invent one.** §9 Q7. The argument
cuts both ways and the owner has made it once already in the opposite direction (§4.4 consequence 3):
the collator's context is the *union* of three reviews of the repository — the most concentrated view
of the code anywhere in the console, which argues for `omlx` and local; and its job is synthesis over
three long documents, which argues for capability the two local allowlisted models may not have.

### 6.3 The collator's tool grant, stated plainly

```yaml
collator:
  model: <OPEN — §9 Q7>
  thinking: high
  toolchain: base
  tools: [read, write, grep, find, ls]   # NO bash — §12.1, and §6.4 is why none is needed
  skills: [pifleet-worker]
  append_system_prompt_file: ./roles/collator.md
  isolation: shared-ro
  pane_mode: tui
```

**`write` and nothing else new.** `observer` already carries `write` on exactly this justification
(`fleet.yaml:365`, *"write is for the outbox artifact only"*). The collator writes two things: a
dispatch request (§6.4) and its own `result.json`.

**Why this is acceptable where the reviewer's would not be.** The commission anticipated that the
collator "will necessarily need `bash` or an equivalent" and that is true of every socket-shaped
mechanism and **false of the one §6.4 specifies**. A file-shaped request needs `write`. A *waiting*
collator would need `sleep` and therefore `bash` — and §6.6 removes the waiting. **The two decisions
are the same decision**: routing the intent through a file rather than a socket is what lets the
collator keep §12.1's read-only posture, and the collator that never waits is what stops that posture
being reopened by the back door.

`isolation: shared-ro` rather than `none`, so the collator can read the target it is being asked to
have reviewed and frame the request against real paths. That puts it under §4.4's disclosure chain
alongside the reviewers, which is the honest place for it to be.

### 6.4 The request plane — one file, written where the host already looks

The collator writes, into its own outbox for the task it is executing:

```
/outbox/<task-id>/dispatch-request.json
```

Shape (`pifleet.dispatchrequest/v1`): the parent task id, and a list of requests each naming a
**worker id from a fixed set**, a title, a brief, and nothing else. **No model, no tools, no
deadline, no worker outside the console's own three, and no `acceptance`** — every one of those is a
host-side or config-side fact and the request must not be able to name them. The actor validates
against the schema and refuses the whole file on any violation.

**Why the outbox rather than a new mount.** Three properties come free and they are the reason:

- **It already exists and is already writable by exactly this worker.** `render.ts:453`,
  `-v <run-dir>/outbox/<worker>:/outbox`. No new mount, no new `assertNoRunDirMount` exposure, and
  the worker-scoping is structural — a collator cannot write into a reviewer's outbox because it
  cannot see one.
- **A host-side reader already polls that exact subtree on an interval.** `VerbgateCollector`
  (`registry.ts:896-900`, driven at `:922-936`) reads `<run-dir>/outbox/<worker>/ledger/verbgate.jsonl`
  with a byte-offset `TailReader`. §2.5: there is no `fs.watch` anywhere in `src/`; polling is the
  house pattern and this is the same shape with a second path.
- **It is already the untrusted-content boundary.** `harvest/outbox.ts` and `Docs/SRD.md` §12.5 —
  *"The result envelope is untrusted input"* — already establish that everything arriving from this
  directory is schema-validated and distrusted. The request inherits that posture rather than
  inventing one.

**The reply direction is a new read-only mount, and it is the one new mount this design asks for:**

```
/replies/<child-task-id>.json     mode 0444, mounted :ro
```

written by the actor with each reviewer's harvested result. It follows `/policy/dispatch`'s recipe
exactly — chmod 0644 → truncate in place → chmod 0444, never rename, because *"a bind mount pins the
INODE"* (`src/run/task-policy.ts:31-41`) — and it must be added to `docker/verbgate`'s policy-integrity
loop, which already iterates three paths and exits 78 if any is writable by the worker
(`docker/verbgate:144-151`). D6 records the alternative (a directory the collator lists) and why it
loses.

**The refusal that makes this safe is not in the collator.** The actor is the only thing that turns a
request into a dispatch, and §6.5 is where the policy lives.

### 6.5 The actor — where it runs is the part this document cannot settle

The actor: reads dispatch requests, validates them, performs the dispatches host-side via
`controlCall`, waits for the children to settle, harvests their results, writes `/replies/*`, and
dispatches the collation task. It needs no new capability — §0.6's last finding — because a host
process running as the operator can already read any run's secret and reach any worker's socket.

**Three candidate homes, and none of them is obviously right.**

| Home | For | Against |
|---|---|---|
| **Extend the per-run registry daemon** | It already polls the outbox on an interval; it already holds the run secret; it is already started detached by `up` and reaped with the run | **It is scoped to one run and this console is four (§6.1).** Reaching across runs widens its charter from *"the SINGLE writer of `registry.json`"* (`daemon.ts:16-21`) to a cross-run actor, and `daemon.ts:17-19` argues its thinness is deliberate: *"it holds no RPC stream and owns no container, so one crash cannot take the fleet"* |
| **A new `pifleet relay --console review` process, started by `scripts/review`** | Correctly scoped to the console; holds the worker→run map the script already computes; dies with the console | A fifth process with no pane, no supervision, and no story for what happens when it dies mid-fan-out. **Nothing in this fleet is currently supervised by a shell script** |
| **`scripts/review` itself, in a foreground loop** | No new process | The script exits after building the workspace. Making it not exit changes what `--recreate` and `--restart` mean and occupies a terminal the console does not have |

**This is §9 Q4 and it is BLOCKING.** The *mechanism* is settled — a request file and a host-side
performer — and the mechanism is what §4.3 was about. **Where the performer lives determines whether
the console works unattended, what happens when the performer dies with three children in flight, and
whether `pifleet down` is still authoritative**, and this document has no evidence that settles it.
Recommending the second option without an answer for its supervision would be inventing a default,
which §0.2 of the sibling SRDs is written against.

### 6.6 Fan-out, join, and partial — the collator never waits

**The collator's task is two tasks, and §3.3 is why.**

1. The operator dispatches `T` to `col-1`. The collator reads the request, decides *what* is to be
   reviewed (not *who* reviews which angle — §6.9), writes `dispatch-request.json` naming three
   children `T-arch`, `T-context`, `T-lang`, writes a `result.json` with `status: "success"` whose
   `notes` and `artifacts` name the three child ids and the collation id, and **ends its turn**.
2. The actor dispatches the three children concurrently, joins them, writes `/replies/*`, and
   dispatches `T-collate` back to `col-1` with a brief naming the three reply files.
3. The collator reads three files and writes the collated document.

**Why not one epoch and a polling collator.** §3.3: `TUI_QUIET_MS` is 2,000 ms, so a turn that stops
is settled two seconds later; staying in-turn for the length of three reviews means emitting tool calls
continuously, and the collator has no `sleep` because it has no `bash`. **A design whose correctness
depends on a model choosing to busy-read a file for twenty minutes is a design with no failure mode you
can name.** D5 records this and its cost.

**The cost of the recommendation, stated rather than buried:** the operator asked that the collator
"collate their results **in response to the original review request**", and under this design `T`
settles when the fan-out is *issued*, not when the review is *done*. A reader asking "what came of
`T`?" follows one link. The mitigations are weaker than the property they replace: the child and
collation ids are in `T`'s envelope, `report` can print the chain, and the ids are derived rather than
minted so the relationship is legible. **If that is unacceptable, D5 is where to say so, and §9 Q4's
answer changes what the alternative costs.**

**Concurrency, and it must be enforced rather than assumed.** The three children are dispatched
**concurrently, in one pass, and no child's brief may contain another child's findings.** §1.3: the
skill's consensus bands are arithmetic over independent readers, and a sequential fan-out that passed
`rev-a`'s report to `rev-b` would look like a smarter design while destroying the only instrument the
console has. This is an anti-criterion in §10, not a comment.

**Join and partial.** The actor waits for all three to reach a terminal state and then proceeds
regardless of what those states are. The mapping onto the existing lattice
(`contracts.ts:71-79`, `failed < blocked < partial < success`, `unknown` the identity):

| Children | Collation dispatched? | Collator's claimed status |
|---|---|---|
| 3 succeeded | Yes | `success` |
| 1-2 succeeded | Yes, with the missing aspects **named in the brief** | `partial` |
| 0 succeeded | **No** — nothing to collate | the collator's `T` result stands; the collation is not dispatched and the actor records why |
| any child `timed_out` / `aborted` | Treated as not-succeeded; those are supervisor verdicts, not lattice members, and `min` is undefined over them | — |

**`partial` is the right member and the lattice makes it cheap.** A two-aspect review is a real result
that is not a complete one, which is what `partial` means, and because the combination is `min` a
collator that honestly claims `partial` can never be lifted back to `success` by anything downstream
(`adjudicate.ts:14`). **The collator must be told in its brief which aspects are missing**, because a
collator that does not know it is missing a lens will write a confident three-lens conclusion from
two — and `report` has no way to detect that.

### 6.7 Deadlines and budget

**The arithmetic the commission asked for.** `deadline_s` defaults to 1800 (`contracts.ts:1729`) and
is armed at the **trigger**, not at stage — `supervisor/index.ts:622-631` records that deliberately:
*"Setting `deadlineMs` at stage time would make a 20-minute task `timed_out` before it begins."* It is
compared once per heartbeat (`:1811`) and cleared immediately (`:1812`) so it fires exactly once, and
on expiry the supervisor settles `timed_out` with reason `deadline_exceeded_no_terminal_event`
(`:1861`). **For a `tui` worker the kill that follows is a no-op** — `tui_kill_unavailable`
(`:1876-1883`) — so a timed-out collator is *graded* but not *stopped*.

Under §6.6 **there is no nesting to compute**, and that is the design's second dividend: the collator's
first task ends in seconds, the children run under their own deadlines, and the collation task gets its
own. No deadline contains another. Under the rejected single-epoch design the rule would have been
`collator.deadline_s > max(child.deadline_s) + fan-out + collation`, i.e. ≥ 3600 against children at
1800 — a number that has to be re-derived every time a child's deadline changes, which is the shape of
constraint that silently stops holding.

**Stall.** `classifyStall` (`src/safety/stall.ts:48-52`) has exactly two states and its docblock
(`:24-33`) argues for exactly two: *"a QUEUED worker and a WEDGED one are byte-identical if all you
watch is event silence… A slot holder is generating; its silence is spent inference time and bounded
by `event_stall_kill`. A non-holder is waiting its turn behind `max_concurrent`."* **A collator waiting
on siblings is a third state** — it holds a slot and is not generating — and under the two-state
classifier it reads as `kill`. §6.6's design never enters that state.

**Two qualifications, so the hazard is not overstated.** The stall policy runs only inside the
scheduler and only when a budget exists — `scheduler.ts:611-614`: *"No budget, so `holdsSlot` is
unknowable… `classifyStall` would see `holdsSlot: false` and saturate at `warn` anyway."* A console
dispatch is manual, so **`event_stall_kill: 25m` does not bite the console today.** And
`max_concurrent: 1` (`fleet.yaml:63`, *"bounded by oMLX throughput, not pane count (§5.9)"*) is
per-run (`scheduler.ts:175`), so four runs are four independent slots and the fan-out is not
serialised by it. **Both qualifications are properties of how the console happens to be driven, not
guarantees**, and D5's design is the one that does not depend on either.

**Token budget.** `budget: {tokens_ceiling: 6000000, per_task_reserve_tokens: 400000}` is per run
(observed). Three reviewers reading a repository at `thinking: high` on 397B-class models is the most
expensive thing this fleet does per dispatch, and `usd_ceiling` is *"still absent and is now a real
gap rather than a deleted field"* for hosted providers (`Docs/SRD.md:754-755`). §9 Q8.

### 6.8 Grading a review, and the prerequisite that comes first

**Findings A, B and C must be fixed before this console can record anything, and they are worth fixing
anyway (D9).** The minimum repair is one line: gate ISC-93's empty-diff check on `facts.repository`,
exactly as ISC-151's clamp beside it already is (`adjudicate.ts:150`), on the argument
`harvest/index.ts:226-242` already makes — *"NO WORKDIR IS A KIND OF TASK, NOT A DEGRADED HARVEST."*
That turns a review from `failed` into gradable-on-its-own-terms and needs none of this feature to
justify it.

**What is left after the repair, stated honestly: not much, and the design should not pretend
otherwise.** With `repository: false`, `derived` comes from acceptance evidence alone, which is
`unknown` with no commands; `unknown` is the lattice identity, so the verdict becomes **the worker's
own claim**. A review is graded on self-report.

**Are acceptance commands the right instrument here? No, and §2.6 Finding D is why.** They are a
re-execution instrument: a committed argv, resolved from the base SHA, re-run in a fresh clone, with no
shell available. There is no argv that proves a person's judgement was exercised. Forcing one would
produce exactly the ceremony ISC-93 exists to catch — a command that exits 0 and certifies nothing.

**What this document proposes instead, and it is deliberately weak.** Grade a review on **structural
completeness of its envelope**, which is checkable, and record consensus as a *datum* rather than a
verdict:

- the collator's artifact must carry a finding count and, for each finding, a file path and a line
  number that resolve inside `/workspace` — the same class of check `readResultEnvelope` already makes
  on `artifacts[]` paths (`skills/pifleet-worker/SKILL.md:183-205`);
- each finding carries which reviewers raised it, so `3/3` and `1/3` are visible in the record;
- a collation with **zero** findings and `status: "success"` is `partial`, not `success` — "I found
  nothing" from three readers is a claim that needs a human, and it is the exact shape ISC-93 was
  written about arriving in a domain where the diff cannot adjudicate it.

**This is a new instrument and it needs a name and a decision (D8, and §9 Q9 holds the harder half).**
It is not acceptance and should not be spelled as acceptance, because the harvester's guarantee for
acceptance — *"the one piece of evidence in this function a fabricating worker cannot author"*
(`adjudicate.ts:218-220`) — is precisely what a structural check on worker-authored JSON does **not**
have. **Calling it acceptance would be claiming an independence it does not possess**, which is the
failure mode this repository's errata keep finding.

### 6.9 Who assigns the aspects — config does, not the collator

**Fixed by worker id, in `fleet.yaml`, at config time. The collator chooses what is reviewed and never
who reviews which angle.** Three arguments, in descending order of force:

1. **The aspect determines the model, and the model is a config-time fact `up` has already checked.**
   §6.2 pins each lens to a vendor whose selection is argued from that lens' job, and `up` validates
   every role's `model:` against `models_allowlist` before the fleet exists (`fleet.yaml:158-161`). A
   collator "assigning" an aspect at dispatch time would be assigning a lens to a model that was fixed
   an hour earlier — a choice with no effect, which is worse than no choice at all.
2. **A collator that can assign lenses can skew them.** The consensus arithmetic assumes three fixed,
   known, different angles. A collator that sent the same lens twice would produce a `2/2` agreement
   that reads as corroboration and is duplication. §4.3's untrusted-input argument applies at reduced
   volume: the collator's input includes worker-authored prose, and its output should not be able to
   reshape the instrument.
3. **A task should mean the same thing twice.** `attempt_id` for a file dispatch is `file:<hash>`
   (observed on the live task record), deterministic so a re-dispatch replays rather than re-runs. A
   review whose lenses were chosen at runtime is not re-runnable in that sense even when the ids match.

**The rejected alternative and what it would have bought:** letting the collator route aspects would
let it adapt — send two security lenses at an auth change, skip the TypeScript lens on a Python repo.
That is real value, and it is available without the capability: **the collator can say in the brief
what each lens should concentrate on within its own aspect**, which is adaptation inside a fixed
frame. The frame stays in `fleet.yaml` where `up` can check it and a reader can see it.

### 6.10 Refusals

- **`scripts/review` refuses to adopt a workspace it did not create.** §0.5 correction 5: a `review`
  workspace already exists on this machine and `ensureWorkspace` matches `custom_title` exactly. The
  first run must either refuse and name `--recreate`, or verify the pane count and titles before
  adopting. **Silently adopting a person's workspace and respawning its panes is data loss.**
- **The actor refuses a request naming a worker outside the console's three.** D7.
- **The actor refuses a request from a worker whose role is not `collator`.** The role is on the launch
  record; the check is cheap and the absence of it is how "any worker can dispatch" arrives by
  accident.
- **The actor refuses a second request while one is in flight for the same parent task**, for the
  reason `EpochManager.allocate` refuses `busy` (`src/rpc/epoch.ts:183-185`): at most one unsettled
  fan-out per collator keeps attribution unambiguous.
- **The actor refuses a request whose child worker is a `collator`.** D7 — no nesting, no self-dispatch.
- **`up` still refuses a model outside the allowlist**, unchanged, which is what makes §6.2's
  prerequisite a hard ordering rather than a note.

---

## 7. What this costs

### 7.1 Unchanged

The nine control verbs and their single-principal auth model. The three socket gates. The mount table's
exclusions and `assertNoRunDirMount`. `--no-extensions`. The reviewer's `[read, grep, find, ls]`.
`config validate`'s `read_only`+`bash` refusal. Decision 1 — a pane is a view, not a channel: this
design writes no bytes to any terminal beyond what `up --attach-here` and the existing staged trigger
already do. Worker-to-worker network reachability, which stays as it is and stays unused.

### 7.2 What is added, in both directions

| | Cost |
|---|---|
| **A new mount** | `/replies`, `:ro`, `0444`, and a fourth path in `docker/verbgate`'s integrity loop. The loop is already a loop, so this is one array element — but it is one more surface whose read-only-ness is load-bearing, enforced only by an exit-78 in a shell script |
| **A new host process** | §6.5, and it has no supervision story. **This is the largest unresolved structural cost in the document** |
| **A third console script** | ~165 duplicated lines on top of an existing 52.1% duplication (§1.2). D3 |
| **A disclosure widening** | §4.4. Three vendors instead of one, on a console whose job is breadth, against a §5.9 permission that names four seats and does not include these |
| **A grading instrument that is weaker than the one beside it** | §6.8. Acceptance re-runs a committed command in a container the worker never touched; this checks the shape of a document the worker wrote |
| **A two-task shape for one request** | §6.6. `T` settles before the review is done |

### 7.3 What this cannot see, and must not imply it can

- **Whether any reviewer read anything.** §3.4.
- **Whether three "independent" readers were independent.** They share a prompt template, a repository,
  and — under §6.2 — a single API endpoint. Family diversity is an argument about training corpora, not
  a measurement of decorrelation, and this document has none.
- **Whether the collation is faithful to the three reports.** The collator is a model summarising three
  documents into one, and `report` reads the summary. `report/collect.ts:5-11` states the general form
  of the problem: *"Nothing in this module reads an envelope's `status` field, and nothing here may
  start to: a reporter that trusts the actor it reports on stops being a report."* **This design does
  exactly that at one remove**, and the only mitigation is that the three reply files are retained so a
  human can check.
- **Whether a finding is real.** Consensus measures agreement, and three models trained on overlapping
  corpora can agree and be wrong together. `3/3` is the highest-confidence band available; it is not a
  proof.

---

## 8. Recorded decisions

Each states what was chosen, what was rejected, and what it costs. **Five are put to the owner as
genuinely open: D2, D3, D5, D8 and D10. A sixth, D13, is DISPUTED — the implementation §0.7 records
has already decided it the other way, and §9 Q10 is how to settle it.**

| # | Decision | Specified in |
|---|---|---|
| **D1** | No control socket, no broker socket, no inbound channel into a worker container. The collator's intent travels as data | §0.2, §4.3, §5.2, §6.4 |
| **D2** | **OPEN** — amend §5.9 to cover this console's seats and three vendors, or reject the design's premise | §4.4, §6.2 |
| **D3** | **OPEN** — `scripts/review` is a third entry point, not a `--workspace` flag | §1.2, below |
| **D4** | The console is four runs, matching `development`, not one run with three viewer panes | §6.1, below |
| **D5** | **OPEN** — the collator never waits; the fan-out is two tasks | §3.3, §6.6 |
| **D6** | Replies arrive as a `:ro` `/replies` mount, not a directory the collator lists | §6.4, below |
| **D7** | No nesting: a collator may not dispatch to a collator, to itself, or outside its console | §5.3, §6.10 |
| **D8** | **OPEN** — a review is graded on structural completeness, and that instrument is not acceptance and must not be spelled as it | §6.8 |
| **D9** | Findings A/B/C are a prerequisite, fixed in their own change | §0.6, §6.8 |
| **D10** | **OPEN** — one `reviewer` role with three worker-level overrides, not three roles | §6.2 |
| **D11** | Aspects are assigned by config, never by the collator | §6.9 |
| **D12** | The collator gets `write` and not `bash` | §4.1, §6.3 |
| **D13** | **DISPUTED** — three reviewer seats are `rpc`, only the collator is `tui`. The implementation §0.7 records makes all four `tui` | §6.1, §0.7, §9 Q10 |

### The five that need no argument

**D1 — no socket.** §4.3 is the whole argument and it does not need restating. **The cost is latency
and a moving part**: a dispatch that would have been a function call becomes a file, a poll interval,
and a process that has to be alive. §6.5 is where that cost is unpaid.

**D4 — four runs.** Rejected: one run with `col-1` attached and three `rpc` workers, which
`adoptRefusal` permits (exactly one `tui` worker, `adopt.ts:101-103`) and which would give the actor a
single run secret and a single daemon to live in. **It was rejected on sequencing, not on preference.**
`up --attach-here` is the only way to hand a terminal to a worker and it *creates* the run
(`attach.ts:1-6` — focus is all `pifleet attach` does), so pane 1 must create the run that panes 2-4
need the id of, and panes are created in sequence from a plan computed up front. The available fixes
are a bounded retry loop in three pane commands or a new "adopt an existing run's terminal" verb, and
both are larger than the problem. **The cost: the actor must resolve worker→run across four runs and
read four secrets, and `--recreate` stops four runs rather than one** — which `development` already
does and `scripts/operations:193-201` already handles.

**D6 — a mount, not a listing.** Rejected: a `/replies` directory the collator enumerates. A directory
hands the worker a listing to walk and re-introduces exactly the discoverability the outbox contract
denies in the other direction (`harvest/layout.ts:26-38`, *"this module never descends, never opens,
never stats a leaf"*). Named files, named in the brief, are the same shape `/policy/dispatch` already
uses. **The cost: the collation brief has to carry three paths, so a reply that arrives after the
brief is written is invisible** — which is fine under D5, where all three are in before the brief
exists, and would not be under a streaming design.

**D9 — the findings first.** One line of the repair (Finding B's gate) is independently correct today,
needs no part of this feature, and would be a second writer of the same behaviour if shipped
alongside. Fix it first, in its own change, with its own test. **The cost: nothing. This is the
cheapest thing in the document and it is blocking everything else in it.**

**D11 — config assigns aspects.** §6.9. **The cost: the console cannot adapt its lenses to the target**
— a Python repository still gets a TypeScript reviewer. The mitigation (the brief steers within a fixed
lens) is real but weaker, and an operator reviewing a non-TypeScript repository regularly will want
D11 revisited rather than worked around.

### D2 — the §5.9 amendment

**OPEN. No recommendation, and that is deliberate.**

§4.4 lays out the conflict: the `CodeReviewer` skill's Step 0 marks
`github.com/dan-elliott-appneta/*` SENSITIVE and routes it away from external vendors; the console's
stated launch directory is such a repository; the launch directory becomes `/workspace`; and
`/workspace` reaches the vendor. §6.2's design makes that three vendors.

**What makes this the owner's decision and not this document's:** the fleet has no equivalent of the
skill's fallback. The skill can route three angles through one *already-trusted* vendor. The fleet's
trusted provider is `omlx` with two allowlisted local models, so the local fallback delivers three
seats and **not** three families — which is §6.2's entire argument, discarded. **The trade is vendor
diversity against repository confidentiality and it cannot be split.**

Three dispositions, and the owner should pick one rather than let the launch directory pick:

1. **Amend §5.9 to name this console and its three vendors, and accept the disclosure.** Honest, and
   the amendment must say what §5.9's existing one says: there is no scope or timeout that reduces a
   transcript after it is sent.
2. **Keep the design and constrain the targets** — `review` runs only against repositories the
   operator is content to disclose, enforced by refusing to launch when `run.repo`'s origin matches a
   sensitive pattern. That is the skill's Step 0, ported, and it is buildable.
3. **Keep the launch directory and lose the vendor diversity** — three local reviewers, three lenses,
   two models. §6.2's argument is what this costs.

**Nothing in this document should be read as having chosen. §9 Q1 is BLOCKING for this reason.**

### D3 — a third script

**OPEN. Recommended: yes, and take the cheaper half with it.**

`scripts/development:26-31` already argues it and the argument is good: a `--workspace` flag makes
"which console am I opening" a value the operator gets wrong occasionally and destructively. **But the
argument is about the *flag*, not about the *duplication***, and the measured 52.1% is already a
maintenance liability that a third copy makes worse — `runOutput()` is identical at the same line
numbers in both files (`:303-316`).

**The recommendation is therefore two things, and the second is the one that pays:** add
`scripts/review` as a third entry point, **and** extract the shared CLI shell — `flag()`, the
`--dry-run` printer, the `--recreate` down-loop and cmux probe, `recreateThenDispatch`, `runOutput` —
into one module the three scripts import. That keeps the property the docblock defends (three
unambiguous entry points) and removes the cost it does not address.

**The cost of the recommendation: a shared module whose three callers have slightly different flag
sets** — `operations` has `--poll` and the others do not, and `--restart` takes a pane title in one and
a worker id in another. Those differences are real and would have to survive the extraction as
parameters rather than being smoothed away.

### D5 — the collator never waits

**OPEN. Recommended: yes. Rejected: one epoch, with the collator polling `/replies`.**

The recommendation rests on `TUI_QUIET_MS = 2_000` (`supervisor/tui.ts:234`) and on the collator having
no `sleep`, and the two compound: a turn that stops settles in two seconds, and the only way to not
stop is to emit tool calls the role has no way to pace. **A worker with `bash` could poll properly, and
giving the collator `bash` is the widening §4.1 refuses** — so the polling design and the tool grant
are one decision, not two.

**What the rejected arm would have bought is exactly what the commission asked for**: the collation
lands in `result.json` for the task the operator dispatched, and the chain is one link. Under the
recommendation it is two, and §6.6 states that cost without softening it.

**Two things that would change the recommendation, and both are measurable.** If a probe shows a Pi
agent reliably staying in-turn across a bounded read loop for tens of minutes (§9 Q4's sibling), the
polling arm becomes viable at the cost of tokens. If §9 Q4 resolves such that the actor lives somewhere
that can `steer` the collator, delivery could wake a live worker without a second dispatch — `steer` is
an existing verb (`supervisor/index.ts:2655`) and injecting into a live turn is what it is for. **This
document did not probe either.**

### D8 — grade on structure, and do not call it acceptance

**OPEN. Recommended: yes, and the recommendation is weak on purpose.**

§6.8. Acceptance is a re-execution instrument and a review has nothing to re-execute; Finding D shows
the mechanism refuses shell metacharacters and resolves commands from the base SHA specifically so the
worker cannot influence them, and **there is no argv whose exit code is evidence that judgement
happened.**

**The rejected alternative is to force acceptance commands onto review tasks anyway** — a committed
script that greps the collator's artifact for a finding count and exits 0. It would satisfy ISC-93's
exemption, produce a green `success`, and certify nothing, because the artifact it examines is the
worker's own output. **That is the exact shape ISC-93 exists to catch**, and building it would be
using the fabrication guard to launder a fabrication.

**The cost of the recommendation, stated plainly: a review's verdict is substantially the worker's own
claim, and this design does not fix that.** It bounds the claim's shape and records the consensus
counts so a human can see three readers rather than one. §9 Q9 asks the harder question — whether a
verdict a fabricating worker can author should be recorded as a verdict at all, or whether review
tasks should carry a distinct terminal state that says "recorded, not graded".

### D10 — one role, three overrides

**OPEN. Recommended: one `reviewer` role with worker-level `model:` and `append_system_prompt_file:`
overrides. Rejected: three roles.**

The mechanism that decides it is `load.ts:754-756` — briefings **concatenate** across defaults → role →
worker, *"the one deliberate departure from replace-wins"* — so the shared review discipline can live
once in `roles/reviewer.md` and each aspect once in its own worker-level file, with `render.ts:126-141`
folding them into one briefing. Three roles would triplicate the discipline with no include mechanism
and would drift.

**The cost is legibility in the wrong place.** `fleet.yaml`'s `workers:` block is a one-line-per-worker
table (`:466-515`), and three workers carrying two extra keys each break it — putting "which lens is
this" in the least readable file in the config. **If the owner would rather read the lens in the roles
block, D10 is where to reverse it**, and the price is three copies of a prompt.

---

## 9. Open questions

**Q1 and Q4 block the design. Q1 blocks its premise and Q4 blocks its architecture, and they are
independent** — Q1 could be answered "run it locally" and Q4 would still be open. The rest do not
block the shape. Where a section depends on a question, it says so.

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q1** | **ANSWERED 2026-09-04 — and it was answered twice, once by the owner and once in code.** The owner authorised THIS repository: *"run real reviews of `~/repos/rally-cli` through the live review console as often as needed"*. What was missing is that nothing in the fleet knew it, so the same authorisation silently covered every other sensitive repo a console might be launched from — and `roles/collator.md`'s refusal never fired on three runs because it named a condition and never named the probe. `security/sensitive-repo.ts` now refuses at `up`, before any clone or container, whenever a Broadcom/AppNeta `origin` meets a `hosted: true` worker; consent is `run.hosted_repo_consent`, which echoes the exact remote so it cannot transfer to the next repository. Disposition 2's feasibility question is answered by construction: `git remote get-url origin` is read on the host, and a repo with no origin is NOT classified — a stated hole. **BLOCKING.** Is the operator content to send a proprietary repository to three third-party vendors?** `~/repos/rally-cli`'s origin is `github.com/dan-elliott-appneta` (read 2026-09-04), the `CodeReviewer` skill's own Step 0 marks that SENSITIVE and routes it away from external vendors, the launch directory becomes `/workspace` (`mounts.ts:393-398`, `up.ts:1045-1047`), and every model in §6.2 is `hosted: true`. §5.9's permission names *"the `development` console's four seats — and nothing else"* (`SRD.md:733-735`). | **Not a probe — an owner decision**, and D2 lists the three dispositions. What a probe *can* settle is disposition 2's feasibility: does `run.repo`'s origin give a reliable sensitivity signal at `up` time for every launch shape (worktree, submodule, no remote)? | **The premise.** Under disposition 3 the whole of §6.2 is rewritten, and with it §1.3's argument for three reviewers at all |
| **Q4** | **ANSWERED 2026-09-04 — home decided and built, probe RUN: all four arms answered.** The probe killed the actor mid-fan-out with `SIGKILL`. **Children settle: YES** — all three reviewers were idle with written envelopes when the actor died, so the fan-out does not depend on the actor surviving it. **A re-run REPLAYS, it does not re-dispatch** — every child's inbox envelope was still `epoch=2 attempt=1` and the relay logged `already dispatched, unchanged`, which is the idempotency this row said a design must have. **The `detached` claim is REAL** — the relay held `PPID=1` and its own process group, having outlived the shell that launched it. **`/replies` partial: ANSWERED 2026-09-05 — yes, and it is INERT.** Measured host-side rather than by racing the console, because the window is ~1ms wide and a live re-run cannot be aimed at it. `SIGKILL` *inside* `writeReply` leaves that reply **truncated and at 0644** (115,736,576 bytes of an intended 200MB; `jq`: *"Unfinished string at EOF"*). `SIGKILL` *before* the widen leaves the previous reply **intact at 0444 and parsing** — step 1 of the module's own contract holding, unprompted. The window is **0.989ms per reply** at the enforced 256 KiB cap (mean of 200 writes), three replies per fan-out. **Nothing ever reads the damaged file**, for three reasons each verified rather than argued: the collation brief carries the paths and is dispatched only after every publish returns, which `test/unit/collator-relay.test.ts:559` *enforces* (`last("reply:") < first("dispatch:enter:T-collate")`) rather than leaving to the comment at `relay.ts:906`; a pass that throws journals nothing (`relay.ts:2328`), so the next pass re-issues the same fan-out; and `childTaskId` is `derive(parentTaskId, aspect)`, so that re-issue rewrites **the same filenames in place** and the pinned inode survives — it self-heals. The 0644 residue is **not** a privilege regression: `/replies` is bound `:ro` (`src/config/render.ts:512`) and the verbgate tests the DIRECTORY rather than the files (`docker/verbgate:242`) — an earlier version that iterated `/replies/*` was removed after measurement. **The one real residue is litter:** an actor that never runs again leaves a truncated 0644 file under a name no brief references. **The probe also found a defect, since fixed** (`fdb1ea1`, `0996e88`): a reviewer wrote a real 3,906-byte review containing a regex quoted into a JSON string, the envelope would not parse, and the console reported the lens as one that *"produced no report"* — attributing a transport failure to the reviewer, with the parse failure logged nowhere. The historical record follows.**  The actor runs from the console script with `ConsoleWatch` supervision — it observes its collator's liveness each pass and exits after a run of negatives, so `pifleet down` stays authoritative. §6.5's table listed *"dies with the console"* and *"correctly scoped to the console"* as reasons to prefer this home when neither had been built; both now are. **What has NOT been run is the failure probe this row names** — kill the actor mid-fan-out, establish whether the children settle, whether `/replies` is left partial, and whether a re-run replays or re-dispatches. Until it runs, the row stays open. **BLOCKING.** Where does the actor run, and what supervises it?** §6.5 has three candidate homes and rejects each for a different reason: the per-run daemon is scoped to one run and this console is four; a new process has no supervision story; the script exits. **This is not a detail of the mechanism — it decides whether the console works unattended, what happens when the actor dies with three children in flight, and whether `pifleet down` remains authoritative about what is running.** | Decide the home first, then probe the failure: kill the actor mid-fan-out and establish whether the children settle, whether `/replies` is left partial, and whether a re-run replays or re-dispatches. A design that cannot answer the third has no idempotency | **§6.5, and through it §6.6's two-task shape.** A supervised actor that can `steer` reopens D5's rejected arm |
| **Q2** | Can a terminal be handed to a worker in an already-created run? `up --attach-here` is the only route today and it creates the run (`attach.ts:1-6`, `adopt.ts:101-103`). | Establish whether a `pifleet adopt --run <id> --worker <w>` is buildable from the existing `adoptedAttachArgv` path without a second `up`. | **Only a reversal of D4.** Recorded because a single-run console is otherwise the better shape and this is the one thing standing in its way |
| **Q3** | **ANSWERED 2026-09-05 — the mount does not work at all on this host, so `classifyPeer` never runs and §4.3 argument 4's fail-open worry is unreachable by this route.** MEASURED, host and container read at the same instant: the host holds `srwxr-xr-x test.sock` and a host `nc -U` returns the server's greeting, while inside a `--user 10001:10001` worker container bind-mounted `-v <dir>:/sock:ro` the directory is EMPTY and `stat` answers *"cannot statx '/sock/test.sock': No such file or directory"*. Docker Desktop's VM does not project a unix-socket inode across its shared filesystem, so there is nothing to connect to and nothing to classify. **On Linux the answer differs and is still not fail-open:** this module's own header records `SO_PEERCRED` returning a real uid inside a container, and a worker's 10001 against the operator's expected uid is a MISMATCH — `peer_uid_denied`, which is fail-CLOSED. The fail-open branch needs a platform where the FFI cannot read credentials at all, which is neither platform pifleet supports. **The original question follows.** Does a host unix socket bind-mounted into a container work at all on this host, and which way does `classifyPeer` fail? §4.3 argument 4: the container is uid 10001, the supervisor is the operator's uid, and `peer-uid.ts:83-101` records that the check **fails open** where the platform cannot report credentials. | Mount one socket into a throwaway container and connect. Read what `classifyPeer` returns. | **Nothing in this design**, which is why it is not blocking — D1 does not mount sockets. It blocks any future reversal of D1, and the answer should be recorded before anyone proposes one |
| **Q5** | Should this reuse `depends_on` and the existing scheduler rather than a bespoke actor? `TaskSpecSchema` carries `depends_on`, `src/orchestrate/graph.ts` and `scheduler.ts` already run DAGs, and `dispatch --auto` already fans out. | Establish whether the scheduler can be driven by a request arriving mid-run rather than by a task list supplied up front. If it can, §6.5's actor shrinks to a request validator | **Nothing now.** It decides whether §6 is a step toward the general mechanism or a thing that has to be unpicked to get there — which is worth knowing before the first line |
| **Q6** | **ANSWERED 2026-09-05 by the owner — SPLIT THE AXES.** Coverage becomes its own datum BESIDE the verdict rather than being folded into it: the record says how many lenses reported *and* what the findings say, and neither word stands in for the other. **The collision this removes is real and not cosmetic** — today a COMPLETE review of shaky code and a BROKEN review of sound code both read `partial`, so the single word an operator scans first is the one word that cannot separate *the console failed* from *the code has problems*. That is the same confusion §6.8's grading rules spend their length avoiding one layer down, arriving at the layer an operator actually reads. **Implementation is PENDING and deliberately deferred**, not forgotten: it lands in `relay.ts`'s `claim` computation (`missing.length === 0 ? "success" : "partial"`), the collation contract, §6.6's table and the collator's brief — four files that were held by in-flight work when the decision was taken. **The original question follows.** Is `partial` the right verdict for a two-of-three review, or is it the wrong axis? `partial` in this fleet has meant "the work was partly done". A two-lens review is *complete work with a missing lens*. | Decide whether the record needs a `coverage` datum beside the verdict rather than folding coverage into it | **§6.6's table.** The lattice mapping works either way; what changes is whether an operator reading `partial` learns the right thing |
| **Q7** | **ANSWERED 2026-09-04 by the implementation §0.7 records — `deepseek-v4-pro:0813`, the same model as the architecture reviewer**, on the argument that collation is the same long-reasoning shape and costs nothing in diversity because *"the collator does not vote, it reports who said what."* That is a better answer than either arm below and this row should close on it. The original question, kept as the record: **which model does the collator run?** §6.2 settles the three reviewers and left this open. Its context is the union of three reviews — the most concentrated view of the repository in the console — which argues for local `omlx` on the `observer` precedent (`fleet.yaml:358-362`); its job is synthesis over three long documents, which argues for capability the two allowlisted local models may not have. | Run the collation prompt against `Qwen3.5-35B-A3B-8bit` and against a hosted candidate on three real reviewer reports and compare. **This is cheap and should be done before the role is written** | **§6.3's role definition.** Nothing structural — but under Q1's disposition 3 it is settled by that answer instead |
| **Q8** | **ANSWERED 2026-09-04 by one full end-to-end review** (rally-cli `efe2777`, three lenses plus collation): **≈7.18M input and ≈78K output tokens over 132 turns** — rev-arch-1 3,179,142/30,037 in 37 turns, rev-lang-1 2,255,644/27,617 in 34, rev-ctx-1 1,169,395/5,951 in 41, col-1 579,950/14,713 in 20. Input is cumulative across turns, so that is the billed figure. The console now has a cost model; it still has no ceiling, and this row said the number *"should block the first unattended run"*. The original question: what does one review cost? Three `thinking: high` reviewers on 397B-class hosted models reading a repository is the most expensive dispatch this fleet makes, `budget.tokens_ceiling` is per run and this console is four runs, and `usd_ceiling` is *"a real gap rather than a deleted field"* (`SRD.md:754-755`). | Run one review end to end and read the token counts. Until then the console has no cost model and no ceiling | **Nothing structurally.** It should block the first unattended run |
| **Q9** | **ANSWERED 2026-09-04 by the owner — WEAK VERDICT.** Grade structurally (required shape plus consensus counts) and record an ordinary `success`/`partial`/`failed`; no new terminal state and no coverage datum, so no consumer switching on the verdict enum pays for it. The original question: should a review carry a *verdict* at all? §6.8's instrument checks the shape of a document the worker wrote; `adjudicate.ts:218-220` calls acceptance *"the one piece of evidence in this function a fabricating worker cannot author"*, and this has no such evidence. | Decide between a weak verdict and a distinct terminal state meaning "recorded, not graded" — the second is honest and costs every consumer that switches on the verdict enum | **D8's shape**, not this design's viability |
| **Q10** | **ANSWERED 2026-09-04 — `tui` STANDS, D13 WITHDRAWN.** `stageForAdoptedTerminal` returns `accepted: true` WITH `error: trigger.reason` (`dispatch.ts:1812-1837`), which is exactly the first-class *"here is the line, I could not type it"* answer this row asks for. Measured since across three live fan-outs. The original question: are the three reviewer seats `tui` or `rpc`? `tui` or `rpc`?** §0.7: the implementation makes all four `tui`; D13 says three should be `rpc`. Since D2's reversal a `tui` worker is dispatchable (staged plus auto-trigger), so the objection is weaker than §6.1 states — what remains is that `tui` costs four adopted terminals where three are never typed at, and makes delivery depend on the cmux surface being present. | Dispatch to a `tui` reviewer with the surface available and again with it unavailable, and read what the route reports in each case. If the second is a first-class "here is the line, I could not type it" answer, `tui` is fine and D13 should be withdrawn | **Nothing.** It changes four config lines either way, and the pane plan is identical |

---

## 10. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria, each
phrased so the probe is obvious, because a criterion whose verification is unclear is one that will be
graded `[~]` forever.

**`ISC-510` is the highest id in use as of 2026-09-04 — verified by
`grep -o "ISC-[0-9]\{1,4\}" ISA.md | sort -u -t- -k2 -n | tail` — so this block starts at `ISC-511`.**
No ids are allocated here: `ISA.md` owns that numbering, and two criteria sharing a number is a worse
outcome than a list that needs ids assigned on adoption. **Q1 and Q4 will each add criteria that cannot
be phrased until they are answered**, and reserving a block for them is the right shape.

**Two existing criteria are made stale by §0.6, independently of whether this design is built. Take
these first.**

| ISC | What it says | What this work does to it |
|---|---|---|
| **ISC-93** | `success` with an empty diff is `failed` — an envelope describing work that did not happen is worse than no envelope. Amended by `ddf8b16` to exempt green harvester-run acceptance. | **Not falsified, and incomplete in a way its own amendment could not see.** The exemption's precondition is unreachable for any worker without a worktree (Finding A), and its sibling clamp ISC-151 carries a `facts.repository` gate this one lacks (Finding B). **It should gain that gate whether or not this console is built.** And per Finding D, **the repository contains no working example of the exemption**, so the amendment is currently unexercised by anything. |
| **ISC-59** | `config validate` rejects `read_only: true` combined with `bash`, at both role and worker level, resolving an omitted `tools:` to the full builtin set first (`schema.ts:1462-1503`). | Unchanged in force and newly load-bearing. D12 makes the collator's grant the thing that keeps §12.1's posture intact, and `collator` is the first role where an omitted `tools:` would be a *security* regression rather than an over-grant. Worth asserting for this role by name. |

**Criteria that must be re-read before any of them is claimed to still hold:** **ISC-94** (a missing
envelope must not clamp — §6.8 makes the identity rule carry a review's whole verdict), **ISC-150 /
ISC-243** (the harness-surface cap — a review that touches nothing cannot trip it, which should be
asserted rather than assumed), **ISC-151** (the base-ancestor clamp and its `facts.repository` gate —
Finding B is the same gate missing next door), **ISC-110 / ISC-117** (the stall policy's two states —
§6.7 argues a collator would be a third, and the design's claim is that it never enters it),
**ISC-127** (the run dir is not mounted — D1's whole posture), **ISC-126** (the peer-uid gate — Q3),
**ISC-172** (the ledger collector — §6.4 puts a second reader on the same polling tick), **ISC-407 /
ISC-408 / ISC-409 / ISC-410 / ISC-411** (hosted providers, the key file, the egress bridge — §6.2 adds
two models and three workers to that surface).

Proposed new criteria, by area:

**The prerequisites (D9)**
- ISC-93's empty-diff check is gated on `facts.repository`, as ISC-151's clamp beside it is.
  *Probe: harvest a task with `host_workdir: "unset"` claiming `success` with no diff, and assert the
  verdict is not `failed`; assert the reason names no diff at all.*
- A `shared-ro` worker's result is gradable. *Probe: end to end on `rev-1` as it exists today —
  **this criterion fails before the fix and is the one that proves Finding A was real.***
- The ISC-93 exemption has a working example. *Probe: a fixture task whose acceptance commands survive
  `tokenize` (no metacharacters), run green in the fresh clone, and carry an empty diff to `success`.
  Finding D says none exists; a criterion whose mechanism has never executed is a claim, not a test.*

**The console (D3, D4, D13)**
- `reviewPanes` produces four panes whose `split`/`splitFrom` table is byte-identical to
  `developmentPanes`'. *Probe: compare the two plans structurally; a divergence in the shared table
  fails. This is what makes "the same 2×2" checkable rather than asserted.*
- The review console issues **no** `resize-pane`. *Probe: assert `topFraction` is `null` and that
  `resizePaneArgv` is not reached — the property §2.1 says is achieved by omission, asserted as
  omission.*
- Index 0 is the collator and is the only attached pane. *Probe: assert the plan's first entry has
  `split: null` and carries `--attach-here`, and that no other pane does.*
- The three reviewer panes are `rpc` and their pane command is the log viewer. *Probe: assert
  `--attach-here` appears exactly once across four pane commands.*
- **Anti: `scripts/review` does not adopt a workspace it did not create.** *Probe: pre-create a
  `review` workspace with unrelated panes, run the script, assert it refuses and names `--recreate`.
  §6.10 — this is the criterion that protects a person's own window.*

**The models (D2, D10)**
- `up` refuses before the allowlist is widened. *Probe: name `qwen3.5:397b` with the current
  three-entry allowlist and assert the refusal names the field and the file. **This asserts the
  prerequisite is ordered rather than documented.***
- Each reviewer resolves to its intended model and to `thinking: high`. *Probe: assert the rendered
  `--model` and `--thinking` per worker; a role-level default silently winning fails.*
- The briefing for each reviewer contains **both** the shared discipline and exactly one aspect.
  *Probe: render all three and assert `roles/reviewer.md`'s text appears in each and that no two share
  an aspect file. This is the criterion that pins `load.ts:754-756`'s concatenation, which D10 depends
  on and which nothing currently asserts for a worker-level briefing.*
- **Anti: `mistral-large-3:675b` and `kimi-k2.6` are not allowlisted.** *Probe: assert both absent, and
  assert the comment beside the allowlist names why — capability and the 90 s budget respectively. §6.2
  exists so a later operator does not re-litigate this; a comment nothing checks will be edited away.*

**The request plane (D1, D6, D12)**
- **Anti: no socket is mounted into any container.** *Probe: assert no `-v` in the rendered argv names
  a socket and that `assertNoRunDirMount` still passes. **This is D1, and it is the criterion that
  would catch a future edit re-opening §4.3.***
- **Anti: `collator` has no `bash`.** *Probe: assert the resolved tool list, and assert `config
  validate` refuses a `collator` with `bash` added. The role-level and worker-level arms both.*
- A dispatch request naming a worker outside the console's three is refused. *Probe: the refusal names
  the worker and the allowed set.*
- A dispatch request from a non-`collator` worker is refused. *Probe: write the same file from a
  reviewer's outbox and assert nothing is dispatched.*
- A dispatch request naming a `collator` is refused. *Probe: D7, both the nesting and the self-dispatch
  arms.*
- `/replies` is `0444`, mounted `:ro`, rewritten in place. *Probe: assert the inode is unchanged across
  two writes; a rename fails. Same recipe as `/policy/task` (`task-policy.ts:91-116`).*
- The verbgate refuses to run when a reply file is writable. *Probe: chmod one and assert exit 78 —
  the existing loop, one path wider.*

**Fan-out and join (D5, D11)**
- **Anti: the three children are dispatched concurrently and no child's brief contains another's
  findings.** *Probe: assert all three dispatches are issued before any child settles, and assert no
  reviewer brief contains text from a reply file. **§1.3: a sequential fan-out destroys the consensus
  arithmetic while looking like a better design, and nothing else in the system would notice.***
- Two of three children succeeding produces a collation dispatched with the missing aspects named, and
  a collator claim of `partial`. *Probe: fail one child deliberately; assert the brief names the
  missing lens and assert the verdict is not `success`.*
- Zero of three succeeding dispatches no collation. *Probe: assert the actor records the reason and
  that no `T-collate` exists.*
- A child that times out is treated as not-succeeded. *Probe: `timed_out` is a supervisor verdict and
  not a lattice member; assert the join does not attempt `min` over it.*
- The collator's first result names the three child ids and the collation id. *Probe: read the
  envelope. **This is the whole of D5's mitigation and it is the only thing linking the two halves of
  one request.***
- Aspect assignment is not reachable from the request. *Probe: a request attempting to name a model,
  a lens or a deadline is refused by schema. D11.*

**Grading (D8)**
- A collation whose findings carry no resolvable `file:line` is not `success`. *Probe: assert against a
  fixture artifact with a bare prose finding.*
- A collation with zero findings and `status: "success"` is recorded `partial`. *Probe: §6.8's third
  bullet, asserted rather than documented.*
- **Anti: the structural check is not spelled as acceptance.** *Probe: assert `facts.acceptance` stays
  empty for a review task and that the structural result is carried in a distinct field. §6.8 — the
  guarantee acceptance carries is independence from the worker, and a check on worker-authored JSON
  must not be able to borrow the word.*

**Reporting**
- `report` shows a review as one request with two task records and names the link. *Probe: the line
  exists and names both ids.*
- **Anti: no criterion in this block requires a real terminal, a real model, or the network.** *Probe:
  the whole block passes under the existing Docker gate with the plans called as pure functions, the
  actor driven against fixture directories, and the models named but not called.
  `Docs/SRD-TUI-DISPATCH.md` §10 records ISC-377/378/379/387 sitting at `[~]` for exactly this reason,
  and `Docs/SRD-FLEET-MONITOR.md` ISC-491 records the cost of discovering it at grading time. **If this
  block cannot be written to that standard, say so at filing time.***

---

## 11. References

- `Docs/SRD.md` §0.2 (Decision 1 — the pane is a view), §5.5 (the mount table), §5.6 (runtime flags),
  §5.9 and its 2026-09-03 amendment (the hosted provider, its bounded scope, and the exposure ladder),
  §7.3 (self-report may downgrade, never upgrade), §8.2 (the exam and class F5), §9.1 (isolation modes
  — and the two rows §0.5 and §2.6 show the renderer has never emitted), §12.1 (tool scope is not a
  boundary), §12.2 (repo content is untrusted), §12.5 (the result envelope is untrusted), §12.6
  (worker prose is data), §12.7 (the control socket) and its two errata.
- `Docs/SRD-TUI-DISPATCH.md` — the format sibling; §0.4's provenance table, §4.3's hazard argument, and
  §10's criterion-numbering discipline. Its four OPEN decisions were adopted 2026-09-02 and D2 was
  reversed by the owner, which is why a dispatch to a `tui` worker now stages *and* triggers.
- `Docs/SRD-FLEET-MONITOR.md` — §4.3 (a viewer that lies is worse than one that admits) and ISC-491.
- `Docs/SRD-INFERENCE-PROVIDERS.md` — §0.3's disclosure precedent, §3 (what was probed about Ollama
  Cloud and what was not), §7.4 (data handling), D12 (`tag_style`), D16 (`models_allowlist` as the
  cheaper control).
- `~/.claude/skills/CodeReviewer/SKILL.md` — the three angles (`:92-96`), the six dimensions
  (`:61-68`), the enforced rules and the repo-sensitive routing override (`:100-102`).
- `~/.claude/skills/CodeReviewer/workflows/Review.md` — Step 0's sensitivity detection (`:35-49`), the
  three agent briefs, Step 3's join and Step 4's consensus bands (`:223-271`).
- `~/.claude/skills/CodeReviewer/ReviewRules.md` — the dimension checklists, the severity ladder, and
  the vendor-routing rule (`:182-184`).
- `src/backends/cmux/operations.ts` — `WorkspaceSpec`, `DEVELOPMENT_SPEC`, `createWorkspace`,
  `restartConsolePane`, `ensureWorkspace`, `applyTopFraction`.
- `src/backends/cmux/operations-plan.ts` — `developmentPanes`, `operationsPanes`, `agentPaneCommand`,
  the split tables, `DEVELOPMENT_MAX_PANES`, `DEVELOPMENT_TOP_FRACTION`, and the pane-order comment.
- `src/backends/cmux/client.ts` — `newSplitArgv`, `resizePaneArgv`, `SplitDirection`.
- `scripts/development`, `scripts/operations` — the duplicated CLI shell and the entry-point argument.
- `src/run/registry.ts` — `serveJsonlSocket`, the three socket gates, the daemon's verbs, and the
  verbgate collector's polling tick.
- `src/security/control-auth.ts`, `src/security/peer-uid.ts` — the per-run token and the accept-time
  uid gate, including its fail-open note.
- `src/run/paths.ts` — `socketPath`, `assertNoRunDirMount`, `RunDirMountError`, the outbox and task
  record paths.
- `src/config/render.ts` — the mount table, the hardening flags, `--tools`, the briefing fold.
- `src/config/schema.ts` — `PI_BUILTIN_TOOLS`, `RoleFieldsSchema`, `WorkerEntrySchema`, `ProviderSchema`,
  `probe_timeout_ms`'s bounds and their arguments, and the ISC-59 refusal.
- `src/config/load.ts` — `pick`'s replace-wins rule and the briefing concatenation that departs from it.
- `src/container/mounts.ts`, `src/run/worktree.ts` — `resolveLaunchRepo`, and the clone-not-worktree
  decision with its rejected RCE.
- `src/harvest/adjudicate.ts` — `adjudicate`, `acceptanceEvidence`, the ISC-93 branch as amended by
  `ddf8b16`, and the ISC-151 clamp with the gate its sibling lacks.
- `src/harvest/index.ts` — `hasWorktree`, the acceptance guard, and the `repository: false` docblock.
- `src/harvest/acceptance.ts` — `tokenize`'s metacharacter refusal and `execBounded`.
- `src/contracts.ts` — the verdict enum, the lattice and its identity rule, the task and result
  envelopes, `deadline_s`.
- `src/safety/stall.ts`, `src/orchestrate/scheduler.ts` — `classifyStall`'s two states and the
  conditions under which the policy engages at all.
- `src/supervisor/index.ts` — the nine control verbs, the deadline arm, the tui transcript poll.
- `src/supervisor/tui.ts` — `TUI_QUIET_MS` and the measured settle regression beside it.
- `src/attended/adopt.ts` — `adoptRefusal`'s one-terminal rule.
- `src/cli/commands/attach.ts`, `exec.ts`, `logs.ts` — what focus does and does not do, the host-side
  exec, and `--run` pinning.
- `docker/verbgate` — the policy-integrity loop and exit 78.
- `docker/honeypot.cjs`, `src/security/gateway-block.ts`, `src/security/network.ts` — what a container
  can and cannot reach, measured.
- `fleet.yaml` — the `reviewer` role and its §12.1 comment, the workers block, the two providers, the
  allowlist and its ceiling, `tag_style`, `probe_timeout_ms`, and the `observer` role's local-model
  decision.
- `skills/pifleet-worker/SKILL.md` — the outbox contract, the `## This task` block, and the
  downgrade-never-upgrade rule as the worker receives it.
- `ISA.md` — the 2026-09-02 adoption entry for SRD-TUI-DISPATCH's four decisions and three questions;
  ISC-59, ISC-92, ISC-93, ISC-94, ISC-110, ISC-117, ISC-126, ISC-127, ISC-150, ISC-151, ISC-152,
  ISC-153, ISC-154, ISC-172, ISC-243, ISC-407..ISC-411.
