# System Requirements Document — `observer` becomes `observer-k8s`, and two siblings: `observer-docker` and `observer-vm`

**SRD-OBSERVER-ROLES-001 v0.1 — DRAFT FOR OWNER REVIEW**

*Sits alongside `Docs/SRD-DEPLOY-OPS.md` (SRD-OBSERVER-001), which specified the `observer` role this
document renames, and `Docs/SRD-TRIAGE-CONSOLE.md` (SRD-TRIAGE-CONSOLE-001), whose console runs three
seats of that role. It **consumes** SRD-OBSERVER-001's verdict vocabulary (§9.3) and its artifact row
shape (`skills/observer-ops/SKILL.md:35-58`) rather than inventing new ones. It **changes no triage
contract**; §4.5 says why, with each contract named. Its implementation plan (§12) is shaped for the
`/ProjectManager` workflow: one branch, one PR, one review and one squash merge per phase.*

---

## 0. Preamble

### 0.1 The one-paragraph thesis

The operator asked for three things: rename `observer` to `observer-k8s`, and add `observer-docker` and
`observer-vm`, which can be dispatched to report the health, logs and state of Docker containers and of
a running virtual machine. The rename is mechanical, but it is not small. The role identifier is
load-bearing in two tracked config files, one source predicate, seven test files, three worker-facing
documents and the operator skill (§4.1), and the English word "observer" appears hundreds of times
where it means something else (§4.2). The two new roles are not mechanical at all, because of one
fundamental constraint. **Kubernetes has an authorization model and Docker does not.** `observer`
is read-only today because the cluster identity it holds is a `view`-bound ServiceAccount
(`fleet.yaml:559-569`) and because `docker/verbgate` refuses mutating `kubectl` verbs
(`docker/verbgate:332-335`). Whoever can reach a Docker Engine API is root on that host, whatever
verbs they intend. A VM reached over SSH is the same: a shell is a shell. So the read-only boundary
for both new roles cannot live in a prompt, a tool list or a verb gate inside the worker. **It has to
live on the target, in the credential itself.** This document puts it in an SSH key whose
`authorized_keys` entry forces one command, and that command is an allowlist grammar shipped and
tested in this repository (§7).

### 0.2 The decision that matters — where the read-only boundary lives

Three places were available. Only one of them binds.

| Where | Mechanism | Binds against a worker with `bash`? |
|---|---|---|
| The prompt and skill | "do not restart anything" | No. It is a request (`Docs/SRD-DEPLOY-OPS.md` §10.3's point about filters and shells applies with more force) |
| A worker-side verb gate | a `docker` shim like `docker/verbgate` | No. `docker/verbgate:12-15` says so of itself: "bash can reach the .real path directly" |
| The credential, on the target | `restrict,command="…"` on the key, plus a target-side allowlist | **Yes.** Whatever the worker sends, sshd runs the forced command and nothing else |

The third row is the same argument SRD-OBSERVER-001 §6.3 and §10.3 make for Kubernetes: *"the control
that does not depend on the command line is the credential's scope"*. For Kubernetes that scope is
RBAC. For Docker and for a VM, this document makes it a forced command. §7 gives the rest of the
stack and is honest about what each layer does not stop.

### 0.3 The disclosure boundary

This repository is public. `fleet.yaml` is tracked (`.claude/skills/fleet/SKILL.md:111-117`), and
`fleet.example.yaml:386-405` records that since 2026-09-12 no ignored file is left to hide a value in.
Every example here uses reserved `example.com` names. Q3 (§10) exists because enrolling a real Docker
host or VM means writing its hostname into a tracked, public file, and no mechanism in the tree avoids
that: `egressRuleHost` refuses placeholders at load time (`fleet.example.yaml:407-411`).

Read-only is not the same as disclosure-safe, and both new roles meet that gap on day one.
`docker inspect` returns every container's environment, and environments hold database passwords.
`journalctl` returns whatever services chose to log. §5.4 and §6.4 therefore fix the output templates
on the target side rather than trusting the worker to leave those fields out.

### 0.4 Evidence provenance — what rests on what

| Claim | Rests on |
|---|---|
| Where the role identifier is load-bearing | `rg` over the tree, then every hit read at its line (§4.1 cites each) |
| The honeypot occupies `/var/run/docker.sock` | `docker/Dockerfile:417-428`, `docker/honeypot.cjs:7-23` |
| Workers cannot reach host ports | `src/security/gateway-block.ts:1-23`, `src/security/network.ts:1-10` |
| Egress is one CONNECT proxy, fleet-wide, any port 1-65535 | `docker/connect-proxy.cjs:30-40`, `docker/egress-policy.cjs:46-50`, `src/run/worker-env.ts:959-979` |
| How gcloud VM verbs classify | `docker/verbgate:356-399`, `:423-466` |
| Harvest validates artifacts by FILENAME | `src/harvest/reconcile.ts:144-175`, `:743-801`, `:814` |
| The shapes `docker` and `journalctl` emit | **Not established.** §12 makes this committed fixture work, done before engineers are briefed |
| That OpenSSH works through the CONNECT proxy from a worker | Measured at §12 task 3.0, re-run at the Phase 3 review: `test/fixtures/observe/ssh-transport-facts.json`, written by `scripts/observe/characterise-ssh-transport` against a throwaway sshd (§5.2) |

Nothing in this document was run against a cluster, a Docker host, a VM or the fleet.

### 0.5 Corrections to the premises this document was commissioned against

1. **"`obs-1` in the operations console" is one of FIVE seats on the role, not the only non-triage
   one.** `obs-2` is declared in both files (`fleet.yaml:1116`, `fleet.example.yaml:844`) and is in no
   console default I read: `DEFAULT_OPERATIONS_WORKERS` is `["obs-1", "tick-1"]`
   (`src/backends/cmux/operations-plan.ts:114`). The operator skill's fleet table omits it
   (`.claude/skills/fleet/SKILL.md:100-109`).
2. **"A docker host" cannot mean the local colima daemon without reversing a stated invariant.** A
   worker has "NO Docker socket mount" (`docker/honeypot.cjs:9-10`, ISC-25/26/29/30). The path
   `/var/run/docker.sock` is a honeypot that records any connect as an escape attempt
   (`docker/Dockerfile:417-428`). The host's own ports are dropped at the bridge gateway
   (`src/security/gateway-block.ts:15-23`). And the local daemon is the one running every worker, so
   reading it means reading the fleet's own relay and sibling containers. Q1 records the default.
3. **`gcloud compute ssh` is not a route to a cloud VM.** `ssh` and `scp` are in the gate's mutating
   set (`docker/verbgate:390-393`), and the policy file is written empty, so every mutating verb is
   refused (`Docs/SRD-DEPLOY-OPS.md:1611-1616`).
4. **`fleet-operations-local.yaml` declares `obs-1` and `obs-2` on `role: observer`
   (`fleet-operations-local.yaml:301-302`) and is not tracked.** `git ls-files` lists
   `fleet.example.yaml` and `fleet.yaml` and not it, so no commit can rename it. It is an operator-local
   edit (§12, Phase 1 host tasks).

### 0.6 What reading the code found

- **Exactly one source predicate keys on the role NAME:** `observerTuiWorkers`,
  `if (w.role !== "observer") continue;` (`src/config/schema.ts:1950`). Its docblock says it is keyed
  to the literal name on purpose (`:1937-1945`). Nothing in `src/run/triage-*.ts` compares a role to
  `"observer"`. The triage console addresses its seats by worker id.
- **The role name also becomes a host path segment.** `render.ts` mounts
  `roleSkillsDir(opts.run.root, w.role)` at `/skills` (`src/config/render.ts:561`). A run launched
  before the rename keeps its old directory, so live seats must be restarted rather than left running
  (§4.4).
- **Harvest validates `ticket-ops.json` and nothing observer-shaped.** Selection is by filename
  (`src/harvest/reconcile.ts:175`, `:814`), and `src/harvest/` never names `observer-ops`. So the rule
  that "a run that produces only the `.md` clamps to `failed`" (`roles/observer.md:138-142`,
  `skills/observer-ops/SKILL.md:28-33`) has no harvest-side enforcement I could find. Its only consumer
  is the triage reader (`src/run/triage-envelope.ts:1446-1524`). This document adds enforcement for the
  two NEW artifacts (Phase 2) and records the existing gap as deferred (§3.3).
- **`reconcile.ts` already argues for keying artifacts on filenames, not role names**
  (`src/harvest/reconcile.ts:147-173`): *"a role name is an operator's label in `fleet.yaml`, changed by
  editing a string"*. That is why the rename cannot silently switch any harvest validation off, and it
  is the pattern the new contracts follow.
- **Two stale line citations point at the role block,** and the rename is a natural moment to fix them.
  `src/backends/cmux/operations-plan.ts:1278` says `observer:` is at `fleet.example.yaml:457`; it is at
  `:486`. `src/config/schema.ts:2004` says the observer's tools are at `fleet.yaml:542`; they are at
  `:696`.
- **A comment in `fleet.yaml` contradicts the file.** `fleet.yaml:1294-1295` says the `observer` role
  "already IS `gpt-oss-20b-MXFP4-Q8`", but the role's model is a LAN-served Gemma 4 26B
  (`fleet.yaml:669`). It is prose, so the rename does not depend on it. It is recorded here so a
  reader does not trust it.
- **`TaskSpec.role` never contained `observer`.** It is `["sre", "investigator", "verifier"]`
  (`src/contracts.ts:1931`), still naming the role SRD-OBSERVER-001 D2 retired. The rename does not
  touch it, and fixing it is out of scope.

---

## 1. Problem statement

### 1.1 What was asked for

Verbatim from the operator: *"create an SRD to rename the observer role to observer-k8s and to create
two new roles observer-docker and observer-vm. One would be able to be dispatched to check on the
health, logs etc of one or mor docker containers on a docker host and the other would be able to check
on the health, logs etc of a running virtual machine"*.

### 1.2 Why rename at all

With one observer, `observer` names the job. With three, it names none of them: an operator reading
`role: observer` beside `role: observer-docker` cannot tell which one holds the cluster identity. The
cost of not renaming falls on reading configs and briefs rather than on code, and it lasts for as long
as the fleet exists.

### 1.3 Why the new roles are separate roles, not modes of the existing one

SRD-OBSERVER-001 §6.1 merged `investigator` into `observer`, and recorded the cost in its own words:
*"Every former `investigator` task now runs with a wider grant … that it does not need"*
(`Docs/SRD-DEPLOY-OPS.md:1042-1046`). Folding Docker and VM access into `observer-k8s` would repeat
that cost three times over. Every cluster watch would hold an SSH key to every enrolled host, and every
Docker inquiry would hold a Google identity. Separate roles give separate `secrets:`, `cloud_access`
and skills (`src/config/schema.ts:215-303`), so each seat holds exactly one kind of access.

### 1.4 Success in one sentence

`observer-k8s` behaves exactly as `observer` did under a new name that nothing still spells the old
way, and `obs-d1` and `obs-v1` return a harvest-validated report pair about named containers or a named
VM through a credential that cannot restart, stop, remove, exec into or power off anything, **even when
the brief asks it to**.

---

## 2. The current state, read from the code

### 2.1 The role, in both tracked files

| Field | `fleet.example.yaml` | `fleet.yaml` |
|---|---|---|
| role key | `:486` | `:665` |
| model | `gemma-4-26b-a4b-it-bf16` (`:490`) | a LAN-served Gemma 4 26B (`:669`) |
| tools | `[read, write, bash, grep, find, ls, submit_report]` (`:493`) | same (`:696`) |
| skills | `[pifleet-worker, observer-ops]` (`:494`) | same (`:697`) |
| `cloud_access` / `egress_access` | `true` / `true` (`:495-496`) | `true` / `true` (`:698-699`) |
| secrets | six CI/dashboard names (`:497-503`) | omitted on purpose (`:700-703`) |
| isolation / pane_mode | `none` / `rpc` (`:504-505`) | `none` / `rpc` (`:704-705`) |
| prompt | `./roles/observer.md` (`:508`) | `./roles/observer.md` (`:708`) |

### 2.2 The seats — five per file, and the `workers:` block is a list

The `workers:` block is a LIST of `{id, role}` maps, so a `^\s+obs-1:` search finds nothing
(`.claude/skills/fleet/SKILL.md:146-149`). Every seat below was found by `role: observer`.

| Seat | Console | `fleet.example.yaml` | `fleet.yaml` |
|---|---|---|---|
| `obs-1` | operations (`DEFAULT_OPERATIONS_WORKERS`, `operations-plan.ts:114`) | `:843`, `pane_mode: tui` | `:1115`, `pane_mode: tui`, own `model:` |
| `obs-2` | none | `:844` | `:1116` |
| `obs-t1` | triage | `:1002` | `:1366`, tui |
| `obs-t2` | triage | `:1027` | `:1417`, tui |
| `obs-t3` | triage | `:1028` | `:1418`, tui |

The triage seat roster has five code-level sources, and **all five name worker ids, never the role**:
`TRIAGE_CONSOLE_ROSTER.reviewers` (`src/run/dispatch-request.ts:463`), `DEFAULT_TRIAGE_WORKERS`
(`src/backends/cmux/operations-plan.ts:1335-1340`), `TRIAGE_CONSOLE_ASPECTS`
(`src/run/task-ids.ts:165`), and the two `workers:` blocks above. Only two TESTS pin the (id, role)
pairs: `test/unit/triage-plan.test.ts:449-454` and `test/unit/dispatch-request.test.ts:1680-1684`.

### 2.3 What a worker can reach

- **Network.** Workers sit on an `--internal` bridge (`src/security/network.ts:1-10`). The gateway is
  dropped, so host ports are unreachable (`src/security/gateway-block.ts:15-23`). A worker with
  `egress_access: true` is handed `HTTPS_PROXY` (`src/run/worker-env.ts:1020`) to a CONNECT proxy
  that allows exactly `egress.allow`'s host:port pairs (`docker/connect-proxy.cjs:30-40`). Any port
  from 1 to 65535 is a legal rule (`docker/egress-policy.cjs:46-50`). **The allowlist is fleet-wide:**
  every routed worker reaches every allowed destination (`fleet.yaml:530-534`,
  `fleet.example.yaml:370-379`).
- **Tools in the image.** The base apt layer installs `bash ca-certificates git ripgrep fd-find jq curl
  less tini gnupg procps` (`docker/Dockerfile:48-49`), plus the Cloud SDK, `kubectl` and `helm`
  (`:56-64`). **There is no `ssh` client and no `docker` CLI.** Extra packages can come from
  `docker.apt_packages` (`src/config/schema.ts:392`, `docker/Dockerfile:238-240`), and they enter the
  image hash (`src/container/image.ts:4-8`).
- **Secrets.** Delivery is by name, and a name must appear in both the fleet ceiling and the role's
  `secrets:` (`src/config/schema.ts:246-260`). The value lands in a file, and the environment receives
  `<NAME>_FILE` (`Docs/SRD-DEPLOY-OPS.md:1156-1159`). Values are swept as leak needles unless marked
  `credential: false` (`:1168-1189`). The prefixes `PIFLEET_`, `GIT_CONFIG_`, `CLOUDSDK_` and `GOOGLE_`
  are reserved (`src/run/worker-env.ts:473`).

### 2.4 What the harvest checks

`src/harvest/reconcile.ts` selects artifacts to validate by FILENAME (`:814`), validates against a
schema whose first field is a `schema` literal (`:165-173`), sweeps the validated document for the
worker's credential values inside the parse (`:777-781`), and clamps the verdict to `failed` when a
`.md` sits in a directory without its `.json` (`:743-801`). Today exactly one contract gets this
treatment: `ticket-ops.json`.

---

## 3. Scope and non-goals

### 3.1 In scope

1. Rename the role identifier `observer` to `observer-k8s` in both tracked configs, the role prompt
   filename and its first line, the one source predicate, the tests that pin it, the worker-facing and
   operator skill text that names the role, and the path citations that name the prompt file.
2. A new `observer-docker` role and one seat, `obs-d1`, for inquiry about one or more containers on
   an enrolled Docker host.
3. A new `observer-vm` role and one seat, `obs-v1`, for inquiry about one enrolled VM.
4. Shared machinery: an SSH transport through the existing CONNECT proxy, target-side forced-command
   allowlists, and harvest validation for the two new artifact pairs.

### 3.2 Non-goals — refused, not omitted

- **Any action on a target.** No restart, stop, start, kill, rm, exec, pause, update, pull, and no VM
  power action. SRD-OBSERVER-001 §10.2 already says acting is a different role, and it applies here
  word for word (`Docs/SRD-DEPLOY-OPS.md:1659-1668`).
- **Mounting any Docker socket into any worker.** It reverses the posture `docker/honeypot.cjs:7-13`
  describes, and it hands root on the VM that runs the fleet to a model with `bash`.
- **Adding the new roles to the triage console.** Its roster, aspects, envelope and verdict are
  unchanged (§4.5).
- **Renaming the `observer-ops` skill, the `observer-ops.json` artifact, the triage document's
  `observer` field, the `observer_blocked` incident kind, or any worker id.** None of these is the role
  identifier (§4.2).

### 3.3 Deliberately deferred

- **Harvest validation of `observer-ops.json`** (the gap in §0.6). It is real, but it predates this
  document, and adding it changes grading for a console that is running today.
- **A `deploy` mode for the new roles.** Both are inquiry-only in v1. SRD-OBSERVER-001 §7.5's
  watch-by-redispatch design is Kubernetes-pipeline-shaped and does not transfer as written.
- **A Docker API filtering proxy on the target,** as a stronger alternative to a docker-group account
  behind a forced command. See Q7.
- **Local hypervisors and the local colima daemon.** See Q1 and Q2.

---

## 4. The rename

### 4.1 Where the identifier is load-bearing — MUST change

Every row was read at its line. **Identifier** means the string is compared, looked up, resolved or
shown to a model as the role's name.

**Config (tracked):**

| Site | What it is |
|---|---|
| `fleet.example.yaml:486` | role key `observer:` |
| `fleet.example.yaml:508` | `append_system_prompt_file: ./roles/observer.md` |
| `fleet.example.yaml:843`, `:844` | `obs-1`, `obs-2` — `role: observer` |
| `fleet.example.yaml:1002`, `:1027`, `:1028` | `obs-t1`, `obs-t2`, `obs-t3` — `role: observer` |
| `fleet.yaml:665` | role key |
| `fleet.yaml:708` | prompt path |
| `fleet.yaml:1115`, `:1116` | `obs-1`, `obs-2` |
| `fleet.yaml:1366`, `:1417`, `:1418` | `obs-t1`, `obs-t2`, `obs-t3` |

**Config (untracked, operator-local):** `fleet-operations-local.yaml:301-302`.

**Role prompt:** the file `roles/observer.md` becomes `roles/observer-k8s.md`. Every other prompt in
`roles/` is named for its role (`collator`, `engineer`, `reviewer`, `sre`, `tester`, `ticketing`,
`triage`, `verifier`), and a model is told its role at `roles/observer.md:1`: *"You are `observer`,
the fleet's read-only diagnostic role."*

**Source:**

| Site | What it is |
|---|---|
| `src/config/schema.ts:1950` | `if (w.role !== "observer") continue;` in `observerTuiWorkers`, called from `src/cli/commands/config.ts:157` |
| `src/config/schema.ts:2097` | an operator-visible warning string citing `roles/observer.md:19-22` |

**Tests:**

| File | Lines |
|---|---|
| `test/unit/config.test.ts` | `:196` (role-name set), `:540` (`roles["observer"]`), `:2370-2371`, `:2386-2387`, `:2404-2405`, `:2457-2458`, `:2507`, `:2511`, `:3317-3318` (fixture documents) |
| `test/unit/role-briefings.test.ts` | `:49` (the briefed-role list) |
| `test/unit/observer-role.test.ts` | `:49` (reads `roles/observer.md`), `:76` (`roleGrant(config, "observer")`) |
| `test/unit/role-envelope-prose.test.ts` | `:267`, `:276`, `:277` |
| `test/unit/triage-plan.test.ts` | `:451-453` (id-and-role pins) |
| `test/unit/dispatch-request.test.ts` | `:1681-1683` (id-and-role pins) |
| `test/unit/worker-secrets.test.ts` | `:646`, `:657` (fixture) |

**Worker-facing documents (mounted into containers):**

| Site | Text |
|---|---|
| `skills/observer-ops/SKILL.md:3` | "Mounted for the observer role." |
| `skills/observer-ops/SKILL.md:8` | "`observer`'s `fleet.yaml` entry" |
| `skills/observer-ops/SKILL.md:23` | "no `observer`-specific fields" |
| `skills/observer-ops/SKILL.md:234` | path `roles/observer.md` |
| `roles/triage.md:263` | path `roles/observer.md` |
| `skills/pifleet-worker/SKILL.md:15` | "a `none` role (observer, verifier, ticketing)" |

**Operator skill:** `.claude/skills/fleet/SKILL.md:102` and `:109`, the Role column of the fleet table.

**Path citations in comments** (these rot when the file moves, so they are fixed in the same phase):
`src/run/triage-envelope.ts:195`, `test/unit/report-tools.test.ts:818`,
`test/unit/observer-role.test.ts:2`, `:14`, and `test/unit/role-envelope-prose.test.ts:253`.

### 4.2 Where "observer" is English, a console concept or another identifier — MAY stay

| Kept | Why it is not the role identifier |
|---|---|
| The operations pane title `"observer"` (`src/backends/cmux/operations-plan.ts:498`), its tests (`test/unit/operations-plan.test.ts:71`, `test/unit/console-restart.test.ts:291`, `test/unit/operations-workspace.test.ts:303`), the `--restart` help text (`scripts/operations:52-54`) and the refusal text (`src/run/fresh-dispatch.ts:447`) | A pane LABEL an operator types. `plannedPane` accepts the title or the worker id (`src/backends/cmux/operations.ts:402-409`), so nothing resolves a role from it. Renaming it would change operator muscle memory for no behaviour. See Q8 |
| `skills/observer-ops/`, `observer-ops.json`/`.md`, `OBSERVER_ARTIFACT_FILE` (`src/run/triage-envelope.ts:146`), `roles/triage.md:238` | Skill and artifact names. They are triage contracts (§4.5). See Q12 |
| `observer` in `triage.json` rows (`src/run/triage-document.ts:287`) | Holds the WORKER ID that produced a row |
| `observer_blocked` (`src/run/triage-incident.ts:109`, `src/run/triage-notify.ts:83`) | An incident kind |
| `observerTuiWorkers`, `observerTuiEpochWarning` (`src/config/schema.ts:2009`, `:2043`; `src/cli/commands/config.ts:15-16`) | Symbol names. They read as English and renaming them buys nothing |
| Worker ids `obs-1`, `obs-2`, `obs-t1`, `obs-t2`, `obs-t3` | Ids, and the triage roster's keys |
| The ServiceAccount `pifleet/observer` (`fleet.yaml:565-567`) | A cluster-side object outside this repository |
| "observer(s)" in prose: `roles/triage.md`, `.claude/skills/fleet/Workflows/Triage.md`, `Consoles.md`, `README.md:89`, `triage/console.yaml`, source docblocks | The triage console's concept of a seat that looks |
| `ISA.md:169` (ISC-392), `:5218` (ISC-575), `:6142` (ISC-1162); `Docs/SRD-*.md` | Closed criteria and historical specifications. This document is their erratum for the name. See Q11 |

### 4.3 How to prove nothing that means the role still says `observer`

Three layers. Each catches something the others do not.

1. **The config refuses it.** A worker naming an unknown role fails to load
   (`src/config/schema.ts:1628-1634`, `src/config/load.ts:663`). After the flip, any `role: observer`
   left behind makes `bun run src/cli/index.ts config validate --config fleet.example.yaml` exit
   non-zero (the flag is `src/cli/commands/config.ts:84`). This does not catch a stale string in a test
   fixture or a document.
2. **A guard test sweeps for the identifier forms** (new, Phase 1 task 1.8). It scans `src/`, `test/`,
   `scripts/`, `roles/`, `skills/`, `.claude/skills/fleet/`, `fleet.yaml` and `fleet.example.yaml` for:
   a YAML role key `observer:` at role indentation; `role: observer` not followed by `-` or a word
   character; `roles["observer"]` or `roles['observer']`; `roleGrant(…"observer")`; the path
   `roles/observer.md`; and the phrase ``You are `observer` ``. A quoted `"observer"` literal in `src/`
   or `test/` is also refused, except at sites NAMED in the test for the pane title. They are named,
   not counted, following `test/unit/triage-readonly.test.ts:141-157`. The guard excludes itself.
3. **The literal new name is pinned once.** The guard asserts the example's role set contains
   `observer-k8s` and not `observer`, that `roles/observer-k8s.md` exists and `roles/observer.md` does
   not, and that `observerTuiWorkers` on the example returns `["obs-1"]`. That last assertion is the
   existing expectation at `test/unit/config.test.ts:2423-2425`, and it goes red if the predicate and
   the config disagree about the name.

A reviewer can check by hand without the guard:

```
rg -n -P 'role:\s*"?observer"?(?![-\w])' fleet.yaml fleet.example.yaml src test
rg -n 'roles/observer\.md' src test roles skills .claude/skills/fleet
test -e roles/observer.md && echo STILL-PRESENT
```

All three must print nothing.

### 4.4 What happens to the existing seats

All five seats in each file keep their ids and become `role: observer-k8s`, with no change to model,
tools, secrets, egress, isolation, pane mode or theme. The operations console still plans `obs-1`
first under the title `observer`. `obs-2` is still in no console.

**Live seats must be restarted, not left running,** for two reasons in the code. The role's skills are
staged under a per-run directory named for the role (`src/config/render.ts:561`), and a worker's
system prompt is set at launch from `append_system_prompt_file`. So a seat still running after the
merge keeps its old prompt, which names it `observer`. The restart is the operator's call. It uses the
per-console verbs the operator skill documents: `./scripts/operations --restart obs-1` and
`./scripts/triage --recreate` (`.claude/skills/fleet/SKILL.md:188-202`). Whether a live run record
caches the role name anywhere `status` reports it is **not verified**, so Phase 1's host task checks
`status --all --json` after the restart instead of assuming.

### 4.5 The triage console's contracts do not change

| Contract | Changes? | Evidence |
|---|---|---|
| Seat roster | No. It is ids | `src/run/dispatch-request.ts:462-463`, `src/backends/cmux/operations-plan.ts:1335-1340`, `src/run/task-ids.ts:165` |
| Sweep envelope and brief | No. It names seats and `observer-ops.json` | `src/run/triage-envelope.ts:146` |
| Observer artifact reader | No. It reads by filename | `src/run/triage-envelope.ts:1502-1524` |
| `triage.json` row field `observer` | No. It holds a worker id | `src/run/triage-document.ts:287` |
| Read-only import walk | No. No new module is imported by a triage ROOT, and `DISPATCH_PATH` keeps its one member | `test/unit/triage-readonly.test.ts:130-157` |
| Tests pinning id-and-role pairs | **Literal role only** | `test/unit/triage-plan.test.ts:451-453`, `test/unit/dispatch-request.test.ts:1681-1683` |

The triage prompt changes by one path (`roles/triage.md:263`). Its seats need the restart in §4.4.

---

## 5. `observer-docker`

### 5.1 What "a Docker host" means here

**A Linux host running a Docker daemon, reachable by SSH on a port the operator names, and enrolled
by the operator** (§5.7). That is Q1's recommended default. It rules out the local colima daemon for
the four reasons in §0.5 item 2, and it rules out `DOCKER_HOST=tcp://…` because a TLS client
certificate for the Engine API is an unfiltered root credential. There is nothing to scope.

### 5.2 The access path, end to end

```
worker (obs-d1, internal bridge)
  └─ observe-docker <target> <verb> [key=value …]              baked shim, docker/observe-docker (new)
       └─ observe-ssh docker <target> …                          baked shim, docker/observe-ssh (new)
            └─ ssh -F /dev/null -n -T -o BatchMode=yes -o IdentitiesOnly=yes
                   -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<known_hosts file>
                   -o GlobalKnownHostsFile=/dev/null
                   -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
                   -o ProxyCommand="node /opt/pifleet/ssh-connect.cjs %h %p"
                   -i <key file> -p <port> -l <user> <host> -- <verb> [key=value …]
                 └─ CONNECT <host>:<port> via HTTPS_PROXY          docker/connect-proxy.cjs, egress.allow
                      └─ sshd on the target: key line is  restrict,command="<forced command>"
                           └─ observe-docker-forced-command reads SSH_ORIGINAL_COMMAND,
                              matches the grammar in §5.4, execs one fixed docker argv or exits 77
```

**One connection runs one verb, and a dispatch may make as many calls as its checks need** (Q1,
answered 2026-09-13). The forced command is single-shot: it reads one `SSH_ORIGINAL_COMMAND`, runs one
fixed `docker` argv and exits. A worker checking several containers, or running several checks on one
container, calls the shim once per verb, and each call is a fresh SSH connection. No state carries
between calls, so every call passes the §5.4 grammar on its own. `target` stays one host per dispatch
(§5.3).

Every hop has a precedent in the tree:

- **The shims** follow `docker/ticket-cli`. It is installed as `rally-cli` so that "a worker never
  types the credential" (`docker/Dockerfile:345-348`). The model never writes an `ssh` flag.
- **The ProxyCommand** exists because the proxy speaks CONNECT only (`docker/connect-proxy.cjs:30-40`),
  OpenSSH has no native CONNECT support, and the image carries no `nc` or `socat`
  (`docker/Dockerfile:48-49`). Node is in every image, because the base IS `node:*-bookworm-slim`
  (`docker/Dockerfile:20`).
- **Exit 77 on refusal** matches the verb gate (`docker/verbgate:9`, `:466`), so an operator reads one
  code for "not authorised" across the fleet.
- **`ssh` joins its remote arguments with spaces,** so word boundaries are lost on the way. The forced
  command re-splits on whitespace with globbing off (`set -f`, the lesson at `docker/verbgate:39-43`),
  and the grammar forbids whitespace inside any argument. Nothing is ever `eval`ed.
- **`-n`, `ConnectTimeout` and the keepalive** were added at the Phase 3 review (principal decision,
  2026-09-14). `-n` gives ssh `/dev/null` as stdin, so a caller looping over a list on its own stdin
  keeps the rest of the list. `ConnectTimeout=10` bounds how long establishing the connection may take.
  `ServerAliveInterval=15` with `ServerAliveCountMax=3` ends a session whose path has gone silent for
  about 45 seconds. The keepalive is a protocol request sshd answers itself, so a command that is merely
  quiet is not cut off. Measured at the Phase 3 review: a 130-second silent command completed through
  the shim, while raw `ssh` without the keepalive was cut at 120 seconds by the proxy's idle timeout. A
  paused target ended the session 51 seconds after the pause, and a target that closed mid-session ended
  it in under 1.5 seconds.

**Established by measurement (§12 task 3.0, re-run at the Phase 3 review):** the facts this section
rests on are in `test/fixtures/observe/ssh-transport-facts.json`, written by
`scripts/observe/characterise-ssh-transport`. That script delivers the secrets through `buildWorkerEnv`
with this section's `multiline: true` allowlist and installs the shim and the ProxyCommand with the
Dockerfile's own COPY lines. Most probes run through `observe-ssh` and the real CONNECT proxy; three
run raw `ssh` instead — the key at its delivered mode, the key with no trailing newline, and the
no-keepalive control — because those measure the reasons the shim exists rather than the shim itself.
OpenSSH refuses the key at its delivered mode `0444`, and also refuses a key with no trailing newline.
So the shim copies the key to a `0600` file in `/tmp` that always ends in a newline. The fixture reads
that location off the container. A remote exit 77 arrives as 77; a host-key mismatch and a proxy
refusal both exit 255. Not measured: a Linux host's bind-mount ownership (the run was on Colima), and
a rebuilt worker image (the client was the newest local image plus `openssh-client` and the two COPY
lines).

### 5.3 Envelope inputs

`inputs[]` reaches no prompt (`Docs/SRD-DEPLOY-OPS.md:1231-1236`). Everything the worker acts on
travels in `brief` prose, and the dispatch path is the ordinary four-field envelope
(`.claude/skills/fleet/Workflows/DispatchTask.md:17-24`). The role prompt and skill teach the worker
to find these in the brief. When one is absent, the worker says so in the artifact rather than
guessing.

| Input | Form | Default when absent |
|---|---|---|
| target | a target TOKEN from the enrolled inventory, `^[a-z0-9][a-z0-9-]{0,31}$` | none — if the inventory holds exactly one target the worker uses it and says so; otherwise the row is `indeterminate` |
| containers | one or more container names, each matching Docker's name grammar `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (the same grammar as `src/security/docker-names.ts:15`) | — |
| selector | `label=<key>=<value>` or `name=<substring>`, used instead of names | if neither names nor a selector is given: every running container, `ps` only, and the row says so |
| checks | a closed subset of `state`, `health`, `logs`, `stats`, `events` | `state, health, logs` |
| window | seconds, e.g. `300s` | `300s` |
| question | one sentence | "is it healthy" |
| `sweep_id`, `window_opened_at` | copied verbatim when the brief carries them | `null` — the triage reader already models an absent echo as `null` (`src/run/triage-envelope.ts:1481-1491`) |

`checks` is closed for the reason `roles/observer.md:60-64` gives: it bounds read volume, and a check
nobody asked for spends turn the artifact needed.

### 5.4 The target-side grammar — the whole of what the credential can do

The forced command (new, `scripts/observe/docker-forced-command`, POSIX `sh`) accepts exactly these
verbs. Arguments are `key=value` tokens, never flags, so no worker token can become a docker option.
That is the flag-injection hazard `src/security/docker-names.ts:4-11` records for argv arrays.

| Verb | Accepted arguments | Runs |
|---|---|---|
| `ps` | `all`; zero or more `name=<n>` or `label=<k>=<v>` | `docker ps --no-trunc --format '<FIXED PS TEMPLATE>'` plus `--all` and one `--filter` per argument — template selects `ID, Names, Image, Command, CreatedAt, RunningFor, State, Status, HealthStatus, Ports, Labels, Networks`, never `Mounts` (a bind mount's host source path), `LocalVolumes`, `Size` or `Platform` |
| `inspect` | `<container>` | `docker inspect --type container --format '<FIXED INSPECT TEMPLATE>' <container>` |
| `logs` | `<container> since=<N>s tail=<M>`, both REQUIRED, `M <= 500` | `docker logs --timestamps --since <N>s --tail <M> <container>` |
| `stats` | `<container>` | `docker stats --no-stream --no-trunc --format '{{json .}}' <container>` |
| `top` | `<container>` | `docker top <container>` |
| `events` | `since=<N>s`, optional `container=<c>` | `docker events --since <N>s --until 0s --format '{{json .}}'` — `--until 0s` is the measured terminating bound (`test/fixtures/observe/docker-cli-shapes.json` → `.events.terminating_bound`) |
| `info` | — | `docker info --format '<FIXED INFO TEMPLATE>'` |
| `version` | — | `docker version --format '{{json .}}'` |

**The inspect template is fixed on the target and never includes `.Config.Env` or `.Mounts`.** It
selects the id, name, image, created time, `.State` (including `.State.Health`), restart count,
restart policy, labels and published ports. That is the disclosure boundary from §0.3 enforced where
the worker cannot widen it.

**`tail` is mandatory and capped** because an unbounded log pull hits the 50KB tool-output wall and
is clipped from the front, exactly the window the question was about
(`skills/observer-ops/SKILL.md:195-232`).

**Everything else exits 77 and runs no `docker` at all.** The grammar is an allowlist, so this list is
illustrative rather than the mechanism: `run`, `create`, `start`, `stop`, `restart`, `kill`, `pause`,
`unpause`, `rm`, `rmi`, `exec`, `attach`, `cp`, `export`, `save`, `commit`, `update`, `rename`, `pull`,
`push`, `build`, `compose`, `network`, `volume`, `system` (including `system dial-stdio`, which is how
`docker -H ssh://` gets the full Engine API over SSH), `context`, `plugin`, `swarm`, `service`,
`logs --follow`, and streaming `stats`. `cp`, `export` and `save` are read-shaped. They are refused on
disclosure grounds, because each copies a container's filesystem off the host.

### 5.5 The role entry

```yaml
# fleet.example.yaml — roles:
observer-docker:
  model: gemma-4-26b-a4b-it-bf16          # the same local model as observer-k8s, see Q5
  thinking: high
  toolchain: base                         # nothing Docker-specific is installed; see below
  tools: [read, write, bash, grep, find, ls, submit_report]   # write is for the outbox pair only
  skills: [pifleet-worker, observer-docker-ops]
  cloud_access: false                     # holds no Google identity
  egress_access: true                     # a ROUTE to the CONNECT proxy; destinations are egress.allow
  secrets:
    - OBSERVER_DOCKER_SSH_KEY             # credential: swept as a needle
    - OBSERVER_DOCKER_KNOWN_HOSTS         # credential: false — public host keys
    - OBSERVER_DOCKER_TARGETS             # credential: false — "token host port user" per line
  isolation: none
  pane_mode: rpc
  append_system_prompt_file: ./roles/observer-docker.md

# workers:
- {id: obs-d1, role: observer-docker}

# secrets.env_allowlist, the fleet ceiling. All three values are one entry per line, so each entry is
# marked multiline: true; without it buildWorkerEnv refuses the value at `up`.
- {name: OBSERVER_DOCKER_SSH_KEY, multiline: true}
- {name: OBSERVER_DOCKER_KNOWN_HOSTS, credential: false, multiline: true}
- {name: OBSERVER_DOCKER_TARGETS, credential: false, multiline: true}

# egress.allow (one exact host, one port per target, as fleet.example.yaml:378-379 requires):
- {host: docker-host.example.com, port: 22}
```

Each field, with its reason:

- **`toolchain: base`.** The worker runs `observe-docker`, `jq` and `bash`. There is deliberately **no
  `docker` CLI** in the image: a default `docker ps` connects to `/var/run/docker.sock` and would log
  an escape attempt on every call (`docker/honeypot.cjs:17-23`). `openssh-client` and the two shims are
  added to the shared base layer (Phase 3), so every toolchain carries them. Q6 records that trade.
- **`tools`.** Identical to `observer-k8s`'s grant, and for the same reason: `write` delivers the pair
  and `submit_report` delivers the envelope (`test/unit/observer-role.test.ts:59-90` argues it). There
  is no `edit`.
- **`cloud_access: false`.** A Docker inquiry has no use for a Google identity, and granting one would
  also trip `kubeconfigScopeWarning` (`src/config/schema.ts:1901-1934`) for nothing.
- **Secrets names** avoid every reserved prefix (`src/run/worker-env.ts:473`) and follow the
  `credential: false` rule for values that legitimately appear in an artifact
  (`Docs/SRD-DEPLOY-OPS.md:1168-1193`). A report naming the host it looked at must not be refused as a
  leak.
- **The cost of `egress.allow`, stated.** The rule is fleet-wide, so every routed worker reaches
  `docker-host.example.com:22`, and `fleet.yaml:530-534` names three such roles. Reaching port 22
  without the key buys a banner and nothing else. The key is delivered only to `observer-docker`.
- **One seat.** `obs-d1`, rpc, in no console. See Q10.
- **`multiline: true` on all three allowlist entries** (principal decision, 2026-09-14, Phase 3 review).
  `buildWorkerEnv` refuses a newline in any granted value (`src/run/worker-env.ts`), because the ticket
  secrets are concatenated into a single curl header line. An OpenSSH key, a known_hosts file and a
  targets list are one entry per line, so their entries opt in. The mark permits LF only; a carriage
  return is refused for every name, and every unmarked name stays refused. The credential sweep also
  takes each line of a multi-line credential as a needle, PEM armor excluded, so a key leaked one line
  at a time is still found.

### 5.6 The report artifact contract

Two files in `/outbox/<task-id>/files/`: `observer-docker-ops.json` and `observer-docker-ops.md`, both
every time, declared in `artifacts[]`, with the envelope sent through `submit_report`. That is the
routing `roles/observer.md:144-152` gives `observer-k8s`.

The JSON keeps **the same document fields and row gate fields as `observer-ops.json`**
(`skills/observer-ops/SKILL.md:35-58`), so the four evidence fields and both closed enums mean the
same thing in all three roles. It adds a `schema` literal, because harvest validation selects by name
and confirms by declared kind (`src/harvest/reconcile.ts:165-173`):

```json
{
  "schema": "pifleet.observer-docker-ops/v1",
  "worker": "obs-d1",
  "sweep_id": null,
  "window_opened_at": null,
  "services": [
    {
      "name": "web-1",
      "namespace": "docker-host-a",
      "assessment": "healthy | degraded | unhealthy | indeterminate",
      "coverage": [
        {"channel": "state",  "result": "answered | unreachable | forbidden | not_attempted"},
        {"channel": "health", "result": "answered"},
        {"channel": "logs",   "result": "answered"}
      ],
      "selector": "name=web-1",
      "window": "300s",
      "evidence_ref": ["observe-docker docker-host-a inspect web-1: State.Status=running, Health=healthy, RestartCount=0"],
      "container_id": "<full id>",
      "image": "<image reference>",
      "restart_count": 0
    }
  ]
}
```

- **`services[]` keeps its name and one row is one container.** `namespace` carries the TARGET TOKEN:
  the named scope the container lives in on this target, as a Kubernetes namespace is on a cluster.
  D5 records why the key is reused rather than renamed.
- **`coverage[].channel` is closed** to `state`, `health`, `logs`, `stats` and `events`.
  **`coverage[].result`** and **`assessment`** are the existing closed enums
  (`skills/observer-ops/SKILL.md:74-112`).
- **A refused verb is `forbidden`, and the task status is `blocked`**, per SRD-OBSERVER-001 §9.3
  (`Docs/SRD-DEPLOY-OPS.md:1580`, `:1592-1593`). A container that has no health check is not a
  refusal: `health` is `answered` and the evidence says "no healthcheck defined".
- **`container_id`, `image` and `restart_count` are optional.**
- **Harvest** validates the JSON by name, sweeps it for `OBSERVER_DOCKER_SSH_KEY`'s value, and clamps
  an orphaned `.md` to `failed` (Phase 2).

### 5.7 Enrolling a target — operator work outside the repository

1. Create a non-root account on the target, a member of the `docker` group. **That is root-equivalent
   on the target, and the forced command is the only thing between the key and that root** (Q7).
2. Install `scripts/observe/docker-forced-command` root-owned, mode `0755`, at a path the account
   cannot write.
3. Add one `authorized_keys` line:
   `restrict,command="<installed path>" ssh-ed25519 <public key> pifleet-observer-docker`.
   OpenSSH's `restrict` turns off port, agent and X11 forwarding and PTY allocation. The forced command
   replaces whatever the client asks to run.
4. Record the target's host key in the value of `OBSERVER_DOCKER_KNOWN_HOSTS`, and add
   `token host port user` to `OBSERVER_DOCKER_TARGETS`.
5. Add `{host, port}` to `egress.allow` in `fleet.yaml` (Q3), and add the three names to
   `secrets.env_allowlist`.

---

## 6. `observer-vm`

### 6.1 What "a running virtual machine" means here

**A Linux VM running systemd, reachable by SSH, and enrolled the same way as a Docker host.** That is
Q2's default, and it covers a cloud instance, a VM on a hypervisor the operator runs, and anything
else with sshd. The hypervisor or cloud control plane is an **optional second channel**, `cloud`,
enabled only for cloud instances and only if Q2 says so (§6.5). A VM on the local machine is out of
scope, because host ports are unreachable from a worker (`src/security/gateway-block.ts:15-23`).

### 6.2 The access path

The same as §5.2 with `observe-vm` in place of `observe-docker`, `OBSERVER_VM_*` secrets, and
`scripts/observe/vm-forced-command` on the target. The account is non-root, holds **no** sudo, and has
read access to the journal through its distribution's journal-reader group. That group's name is
distribution-specific, so it is recorded in the enrolment runbook rather than asserted here.

### 6.3 Envelope inputs

| Input | Form | Default when absent |
|---|---|---|
| target | inventory token | the single enrolled VM, stated in the artifact; otherwise `indeterminate` |
| units | zero or more systemd unit names, `^[a-zA-Z0-9@._:-]+$` | none: system-level checks only |
| checks | closed subset of `reachability`, `system`, `units`, `logs`, `resources`, `cloud` | `reachability, system, units, logs` |
| window | seconds | `300s` |
| question, `sweep_id`, `window_opened_at` | as §5.3 | as §5.3 |

`reachability` is answered by whether the SSH round-trip completed at all. An unreachable VM is
`coverage.result: unreachable` and `assessment: indeterminate`, never `unhealthy`, because the worker
cannot tell "the VM is down" from "the route is down". That is the rule `roles/observer.md:131-136`
applies to a control plane.

### 6.4 The target-side grammar

| Verb | Accepted arguments | Runs |
|---|---|---|
| `uptime` | — | `cat /proc/uptime /proc/loadavg` |
| `os` | — | `cat /etc/os-release` |
| `system` | — | `systemctl is-system-running` (a non-zero exit is passed through as data: `degraded` is an answer) |
| `failed` | — | `systemctl list-units --state=failed --no-legend --plain --no-pager` |
| `unit` | `<unit>` | `systemctl show <unit> --no-pager --property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestamp,ExecMainStatus` |
| `journal` | `since=<N>s lines=<M>`, both required, `M <= 500`; optional `unit=<unit>`, `priority=<0-7>` | `journalctl --no-pager --output=short-iso --lines=<M>` plus the since bound, `--unit` and `--priority` — the relative-since spelling is characterisation (§12 Phase 5) |
| `kernel` | `since=<N>s lines=<M>` | `journalctl --no-pager --dmesg --output=short-iso …` |
| `disk` | — | `df -P -k` |
| `memory` | — | `cat /proc/meminfo` |

**Refused with exit 77, never reaching a shell:** `shutdown`, `reboot`, `poweroff`, `halt`; `systemctl`
with any verb other than the two above (`start`, `stop`, `restart`, `reload`, `enable`, `disable`,
`mask`, `kill`, `isolate`, `daemon-reload`, `set-property`, …); `journalctl` with `--vacuum-*`,
`--rotate`, `--flush` or `--sync`; `kill`; any package manager; `sudo`; any free-form path read. The
account's lack of sudo is the second layer: `systemctl restart` run by a non-root user without polkit
authorisation fails even if the grammar were bypassed.

**Disclosure:** `journal` returns whatever services logged. The skill tells the worker to quote the
lines that support a finding, not whole windows, and harvest sweeps the artifact for the key.
Arbitrary application log files are out of reach by construction, because no verb takes a path.

### 6.5 The optional `cloud` channel

For a cloud instance, the gated `gcloud` in every image already classifies exactly as a read-only VM
observer needs, and this document asks nothing new of the gate:

| Command | Classified | Evidence |
|---|---|---|
| `gcloud compute instances describe <vm>` | read | `docker/verbgate:386`; `test/integration/verbgate.test.ts:302` |
| `gcloud compute instances get-serial-port-output <vm>` | read (`get-*`) | `docker/verbgate:386` |
| `gcloud logging read '<filter>'` | read | `docker/verbgate:379-386` |
| `gcloud compute instances start` / `stop` / `reset` / `resize`, `gcloud compute ssh` | mutating, refused 77 | `docker/verbgate:390-393` |
| `gcloud compute instances suspend` / `resume` | no recognised verb, so it falls into the mutating path and is refused | `docker/verbgate:366-399`, `:423-466` |

Enabling it means `cloud_access: true` on `observer-vm` (Q2). The authority boundary is then the
identity's IAM, which SRD-OBSERVER-001 §6.3 recommends be an impersonated read-only service account.
The verb gate stops the casual call and the IAM scope stops the determined one
(`docker/verbgate:12-15`).

### 6.6 The role entry

```yaml
observer-vm:
  model: gemma-4-26b-a4b-it-bf16
  thinking: high
  toolchain: base
  tools: [read, write, bash, grep, find, ls, submit_report]
  skills: [pifleet-worker, observer-vm-ops]
  cloud_access: false                     # true only if Q2 enables the cloud channel
  egress_access: true
  secrets:
    - OBSERVER_VM_SSH_KEY
    - OBSERVER_VM_KNOWN_HOSTS             # credential: false
    - OBSERVER_VM_TARGETS                 # credential: false
  isolation: none
  pane_mode: rpc
  append_system_prompt_file: ./roles/observer-vm.md

# workers:
- {id: obs-v1, role: observer-vm}

# secrets.env_allowlist (marked multiline: true for the reason §5.5 gives):
- {name: OBSERVER_VM_SSH_KEY, multiline: true}
- {name: OBSERVER_VM_KNOWN_HOSTS, credential: false, multiline: true}
- {name: OBSERVER_VM_TARGETS, credential: false, multiline: true}

# egress.allow:
- {host: vm-1.example.com, port: 22}
```

### 6.7 The report artifact contract

`observer-vm-ops.json` and `observer-vm-ops.md`, with the same document fields as §5.6 and
`"schema": "pifleet.observer-vm-ops/v1"`. There is one row per VM (`name` is the VM name, `namespace`
the target token), and `coverage[].channel` is closed to `reachability`, `system`, `units`, `logs`,
`resources` and `cloud`. The optional row fields are `uptime_s`, `system_state` and `failed_units[]`,
each a unit name taken from `failed` output and quoted verbatim.

---

## 7. The read-only boundary, enforced rather than requested

### 7.1 Allowed and forbidden, per role

| | `observer-k8s` (unchanged) | `observer-docker` | `observer-vm` |
|---|---|---|---|
| **Allowed** | `kubectl get/describe/logs/top/explain/api-resources/version/diff` (`docker/verbgate:332-335`); `helm list/get/status/history/…` (`:337-340`); gcloud read verbs (`:386`) | the eight verbs in §5.4, and nothing else | the nine verbs in §6.4; with `cloud`, the gcloud reads in §6.5 |
| **Forbidden** | every mutating verb, `kubectl exec` included (`skills/observer-ops/SKILL.md:249-283`) | restart, stop, start, kill, rm, exec, pause, update, cp/export/save, pull, `system dial-stdio`, … | VM power actions (`shutdown`, `reboot`, `poweroff`, gcloud `start/stop/reset/suspend`); `systemctl` mutating verbs; journal maintenance; `sudo`; path reads |

### 7.2 The enforcement stack for the two new roles, layer by layer

| # | Layer | Mechanism | What it stops | What it does not stop |
|---|---|---|---|---|
| 1 | **Credential on the target** | `restrict,command=` on the only key the role holds (§5.7, §6.2) | every command outside the grammar, every forwarding and every PTY, whatever the worker sends | a target administrator editing the `authorized_keys` line; a bug in the forced command (layer 2) |
| 2 | **The grammar** | an allowlist in POSIX `sh`: `set -f`, no `eval`, `key=value` tokens only, exit 77 | flag injection, verb smuggling, word-splitting tricks | nothing further. It is the boundary, and that is why Phases 4 and 5 test it exhaustively against a recording fake `docker`/`systemctl`/`journalctl` |
| 3 | **Account privilege** | VM: no sudo. Docker: `docker` group, which is root-equivalent | VM: a mutating `systemctl` even if layer 2 failed | Docker: nothing. Layer 2 is the last barrier (Q7) |
| 4 | **Credential scope** | one key per ROLE; `cloud_access: false` by default | `observer-k8s` touching a Docker host; `observer-docker` touching a cluster or cloud API | — |
| 5 | **Egress** | `egress.allow` holds one host:22 per enrolled target; internal bridge; gateway dropped | reaching any unenrolled host, and the local daemon or local hypervisor | other routed roles reaching the same host:22 (fleet-wide union, `fleet.yaml:530-534`) without a key |
| 6 | **Image** | no `docker` CLI, no socket, the honeypot at `/var/run/docker.sock` | a worker talking the Engine API directly, and it records the attempt | — |
| 7 | **Tool list** | no `edit`; `write` is for the outbox pair | nothing on the target, because `bash` is present. Tool scope is not a boundary (`Docs/SRD-DEPLOY-OPS.md:1089-1092`) | — |
| 8 | **Shim, prompt, skill** | the model never composes ssh flags; the forbidden list is stated with reasons | the casual mistake | a determined worker. Layers 1-3 carry that |

**Where the boundary is verified, not believed:** layer 2 by unit tests in this repository (Phases 4
and 5). Layers 1, 3 and 5 by the live negative probe in Phase 6: a brief that explicitly asks for a
restart must produce a `forbidden` coverage row and a `blocked` status, and the target container's
`State.StartedAt` must be unchanged before and after. **A layer that is never observed refusing
something is a layer nobody has shown works.**

---

## 8. What this costs

### 8.1 Unchanged

The triage console, its contracts and its import walk (§4.5). The operations console's plan and pane
titles. `observer-k8s`'s grant. The `observer-ops` skill's content.

### 8.2 Added

- An `openssh-client` package and three baked files in the shared base image. **Every toolchain's tag
  moves, and every image in use must be rebuilt** before `up` accepts it, because the tag is a hash
  over the build context and apt packages (`src/container/image.ts:4-8`). Phase 3's host task builds
  them.
- Up to six new `secrets.env_allowlist` names.
- One `egress.allow` rule per enrolled target, reachable by every routed worker (§7.2 layer 5).
- Two harvest contracts in `src/harvest/reconcile.ts`. That file's validation, sweep and pair clamp
  grow from one filename to three.

### 8.3 What the new roles cannot see, and must not imply they can

- Anything inside a container: no exec, so configuration as deployed is inferred from `inspect` and
  labelled as inference (`Docs/SRD-DEPLOY-OPS.md:1649-1653`).
- Logs a container wrote more than `tail` lines ago, and journal lines beyond `lines`.
- Environment variables and mount sources. They are excluded from the inspect template on purpose.
- Whether a VM is down or only unreachable. That is `indeterminate`, never `unhealthy` (§6.3).

---

## 9. Recorded decisions

### The six that need no argument

| # | Decision | Reason in one line |
|---|---|---|
| D1 | The rename changes the ROLE IDENTIFIER only | Pane title, skill, artifact, triage fields, incident kinds and worker ids are other identifiers or English (§4.2) |
| D2 | New roles are separate roles, not modes | Grant minimisation, the lesson of the `investigator` merge (§1.3) |
| D3 | Both new roles are inquiry-only in v1 | The deploy-watch shape is pipeline-specific (§3.3) |
| D4 | New seats join no console | Keeps both consoles' plans and every roster test unchanged (§4.5) |
| D6 | One seat per new role | Read-only concurrency is safe, but nothing yet dispatches in parallel to these (Q10) |
| D8 | Exit 77 for a refused target verb | One code for "not authorised" fleet-wide (`docker/verbgate:9`) |

### D5 — reuse `observer-ops.json`'s row shape, including the `services` and `namespace` keys

**Adopted.** The alternative was new keys, `containers[]` and `host`. It reads better and it forks the
contract: the four evidence fields and both closed enums are what make a `healthy` believable
(`skills/observer-ops/SKILL.md:60-64`), and SRD-TRIAGE-CONSOLE's gates are written over exactly these
names. A future console that sweeps Docker hosts would get those gates for free under the reused shape
and would need a translation layer under the renamed one. **The cost is two keys whose names are one
analogy away from their meaning.** The skill and the schema docblock state that analogy once, in
words.

### D7 — enforce on the target with a forced command, not with a pifleet-side API gate

**Adopted for v1.** The alternative was a pifleet-owned gate process that holds the Docker credential
and exposes an allowlisted, GET-only subset of the Engine API on the bridge. It is testable here, and
it could serve the local daemon too. It was rejected on three grounds:

1. **It only covers Docker.** A VM needs a forced command regardless, so the gate is a second
   mechanism rather than the only one.
2. **It moves a root-equivalent credential into a long-running fleet process**, which is a new kind of
   component: the relay and proxy hold no credential.
3. **It enables the local-daemon case,** which §0.5 item 2 argues against on its own merits.

Q7 keeps a target-side filtering API proxy open as the stronger Docker option.

---

## 10. Open questions — for the operator

Each has a recommended default. The implementation plan proceeds on the defaults unless an answer
changes them. An answer is recorded here in place, with its date.

| # | Question | Recommended default | Reasoning |
|---|---|---|---|
| **Q1** | What is "a Docker host": the local colima daemon, a remote host over SSH, or a remote `DOCKER_HOST=tcp://`? | **Remote Linux host over SSH, behind a forced command.** Local colima and TCP+TLS are out of scope. **Answered 2026-09-13: accepted.** The operator adds that one dispatch may make more than one read-only call to check the containers it is asked about; §5.2 states how | The local daemon needs a socket mount, which the honeypot and ISC-25/26/29/30 forbid, and it is the fleet's own daemon. A TCP+TLS client cert is unscopable root (§5.1) |
| **Q2** | What kind of VM: a cloud instance, a local hypervisor, or anything reachable by SSH? And is the `cloud` channel on? | **Any Linux/systemd VM reachable by SSH. `cloud` channel OFF** until a read-only impersonated service account exists. **Answered 2026-09-13: accepted** | SSH covers all three kinds uniformly. Local hypervisors are unreachable (§6.1). The cloud channel needs `cloud_access`, which the role otherwise has no use for |
| **Q3** | `fleet.yaml` is tracked in a public repository. Where does a real target hostname go? | **`egress.allow` in `fleet.yaml`, following the existing cluster-hostname precedent, and only for targets whose names are not sensitive.** User, port, token and key live in secrets. **Answered 2026-09-13: accepted** | `egressRuleHost` refuses placeholders (`fleet.example.yaml:407-411`), and no ignored config file remains (`:386-405`). A hostname that must stay private is a repository-visibility problem, not a config one |
| **Q4** | May `observer-docker` see every container on an enrolled host? | **Yes, every container on a host the operator enrolled.** An optional target-side deny pattern is deferred | Enrolling a host is already the operator's decision about that host. Env and mounts are excluded regardless (§5.4) |
| **Q5** | Which model runs the new roles, and may it be hosted? | **The same local model `observer-k8s` runs in each file** | The reason `observer` stayed local applies unchanged: its context is the fleet's most sensitive (`fleet.yaml:688-693`) |
| **Q6** | `openssh-client` and the shims in the shared base layer, or a new toolchain? | **Shared base layer** | A new toolchain is a five-value enum change (`src/config/schema.ts:175`) plus a stage the toolchain-graph test must admit. `ssh` with no key and no route grants nothing to other roles |
| **Q7** | A `docker`-group account behind a forced command is root-equivalent if the grammar has a bug. Accept it, or require a GET-only Engine API proxy on each target? | **Accept for v1, with the grammar tested exhaustively**; the proxy stays open. **Answered 2026-09-13: accepted** | The proxy is per-target infrastructure outside this repository, with its own allowlist to maintain |
| **Q8** | Rename the operations pane title `observer`? | **No** | It is an operator-typed label, and `plannedPane` already accepts the worker id (`src/backends/cmux/operations.ts:402-409`) |
| **Q9** | Should `observerTuiWorkers`'s warning cover the new roles? | **No** — `observer-k8s` only | Its hazard is repeated watch dispatch through `observer-ops` (`src/config/schema.ts:2002-2007`). The new roles are rpc and inquiry-only |
| **Q10** | Seat ids and count for the new roles? | **`obs-d1` and `obs-v1`, one each, rpc, in no console** | Matches the `obs-` convention, and D4 |
| **Q11** | Rewrite `observer` in closed ISA criteria and historical SRDs? | **No.** They are records; this document is the erratum | Rewriting a closed criterion's text rewrites what was measured |
| **Q12** | Rename the `observer-ops` skill to `observer-k8s-ops`? | **No** | Its name is a triage contract (`src/run/triage-envelope.ts:146`, `roles/triage.md:238`), and renaming it changes the one console this document leaves alone |
| **Q13** | May an engineer edit the live `fleet.yaml`, or is it operator-applied? | **Engineer-editable for the rename (Phase 1); operator-applied for target enrolment (Phase 6)** | The rename is an exact string change. Enrolment writes real hostnames into a public file (Q3). SRD-TRIAGE-CONSOLE §13 Phase 1 records this as "not re-decided" |
| **Q14** | Which VM operating systems? | **Linux with systemd** | The grammar is `systemctl`/`journalctl`-shaped. Others need their own grammar |

---

## 11. Hooks for acceptance criteria

These are the criteria an ISA entry would be written from. ISC numbers are allocated centrally, not
picked on a branch (`test/support/isa-claims.ts:1-9`), so this section names criteria and does not
number them.

- **Rename, complete:** the §4.3 guard passes, and `config validate` exits 0 on both tracked files.
- **Rename, wired:** `observerTuiWorkers(example)` is `["obs-1"]`. Reverting the literal at
  `src/config/schema.ts:1950` makes it `[]`.
- **Triage unchanged:** `test/unit/triage-readonly.test.ts` passes with no edit, and
  `git diff --stat` on the phase's squash shows no `src/run/triage-*.ts` beyond comment lines.
- **Grammar, allow:** each §5.4/§6.4 verb produces its exact argv on a recording fake binary.
- **Grammar, refuse:** every verb in a committed forbidden-verbs fixture exits 77 and the fake binary
  records NO invocation.
- **Disclosure:** the inspect argv contains neither `.Config.Env` nor `.Mounts`.
- **Harvest:** a malformed `observer-docker-ops.json` clamps to `failed`; an orphaned `.md` clamps to
  `failed`; an artifact carrying the key value is refused as a leak.
- **Transport:** the shim's ssh argv carries `StrictHostKeyChecking=yes`, `BatchMode=yes` and
  `IdentitiesOnly=yes`, and refuses an unknown target token without invoking ssh.
- **Live, negative:** a restart request yields `forbidden` plus `blocked`, and the target is unchanged.

---

## 12. Implementation Checklist

**Shaped for `/ProjectManager`.** Each phase below is one branch named `phase-{N}-{slug}`, one PR, one
review and one squash merge. Each is shippable on its own: a merged phase leaves the tree green and the
fleet working. The patch-version bump and the CHANGELOG/README pass run after each merge as part of the
workflow, so no task below repeats them.

**Sizing rules every phase obeys.** At most two tasks and about four files per engineer per round; four
to five rounds per phase, or fewer where a phase is genuinely small, and it says so. Each task is a
vertical slice: source, tests and the call site that proves it is wired. File ownership is unique
within a round, and every **Conflicts** line names the tasks that must not share a round. Where a round
cannot be made disjoint, one engineer takes it and the other is idle, and the round plan says so.

**PM-owned pre-work.** A task of the form "find out what `docker`, `journalctl` or `ssh` emits or
accepts" is done by the project manager before engineers are briefed. It is committed as a fixture plus
the script that regenerates it, and the engineer tasks only WIRE those fixtures. The script accumulates
into sets and prints each set once, sorted, never per item. **No task asks an engineer to write out more
than about fifteen similar identifiers**: forbidden-verb lists come from committed fixtures, and the
rename is split by file group.

**Host / operator tasks** are labelled `(host)`. They build images, touch a live seat or touch a real
target, and none of them is dispatched to an engineer.

**One hazard before Phase 1.** This document was written on a checkout standing on a feature branch,
not on the default branch. The workflow's first step, `git checkout main && git pull origin main`,
switches that checkout, so the operator confirms the feature branch's work is merged or safely pushed
before Phase 1 starts.

### Phase table

| Phase | Slug | Deliverable | Depends on |
|---|---|---|---|
| 1 | `rename-observer-k8s` | The role identifier is `observer-k8s` everywhere it is load-bearing, and a guard proves it | — |
| 2 | `observer-target-artifacts` | Harvest validates, sweeps and pair-clamps `observer-docker-ops` and `observer-vm-ops` | — |
| 3 | `observe-ssh-transport` | `ssh` through the CONNECT proxy via a baked shim; image carries it | — |
| 4 | `observer-docker-role` | Target grammar, worker shim, role, prompt, skill, seat `obs-d1` | 2, 3 |
| 5 | `observer-vm-role` | The same for VMs, seat `obs-v1`; the `cloud` channel if Q2 enables it | 2, 3, 4 |
| 6 | `observer-operator-enrolment` | Operator skill, enrolment runbook, live enrolment and the negative probe | 1-5 |

Phases 1, 2 and 3 touch disjoint seams (config naming, harvest, image transport), but `/ProjectManager`
runs phases sequentially, so the table order is the execution order.

---

### Phase 1 — Rename `observer` to `observer-k8s` (`rename-observer-k8s`)

**Goal a reviewer tests the diff against.** After the squash, no identifier site in §4.1 says
`observer`, every §4.2 site is untouched, `observer-k8s` resolves with exactly the old grant, and the
triage console's contracts are byte-identical apart from the literal role in two test pins.

**Does not.** Change any grant, model, worker id, pane title, skill name or artifact name, or any
`src/run/triage-*.ts` logic.

**How the phase stays green round by round.** Rounds 1-3 route every identifier use through one new
constant, `OBSERVER_K8S_ROLE`, still valued `"observer"`, so nothing observable changes. Round 4 flips
the constant, both configs and the prompt filename in one commit. Round 5 adds the guard that pins the
literal.

- **1.1** Add `export const OBSERVER_K8S_ROLE = "observer";` to `src/config/schema.ts` and replace the
  literal in `observerTuiWorkers` (`src/config/schema.ts:1950`) with it. Convert the fixture documents
  in `test/unit/config.test.ts`'s `pane_mode: tui on the observer role warns` block (`:2367-2425`: the
  role keys and `role:` values at `:2370-2371`, `:2386-2387`, `:2404-2405`) to use the constant.
  **Files:** `src/config/schema.ts`, `test/unit/config.test.ts`. **Call site:** `observerTuiWorkers`
  is called from `src/cli/commands/config.ts:157`.
  *Acceptance: `bun test test/unit/config.test.ts`; `bun run typecheck`.*
  *Revert check: set the comparison at `:1950` back to any other literal. The test "an observer role
  resolving pane_mode: tui is named" goes red.*
- **1.2** Convert the remaining role-name sites in `test/unit/config.test.ts` to `OBSERVER_K8S_ROLE`:
  `:196` (role-name set), `:540` (`roles["observer"]`), `:2457-2458`, `:2507`, `:2511`, `:3317-3318`.
  **Files:** `test/unit/config.test.ts`. **Call site:** these assertions load `fleet.example.yaml`
  through `loadConfig`. *Acceptance: `bun test test/unit/config.test.ts`.*
- **1.3** Convert the id-and-role pins and a secrets fixture to the constant:
  `test/unit/triage-plan.test.ts:451-453`, `test/unit/dispatch-request.test.ts:1681-1683`,
  `test/unit/worker-secrets.test.ts:646`, `:657`. **Files:** those three. **Call site:** the pins read
  `DEFAULT_TRIAGE_WORKERS` and `TRIAGE_CONSOLE_ROSTER` against the parsed example.
  *Acceptance: `bun test test/unit/triage-plan.test.ts test/unit/dispatch-request.test.ts test/unit/worker-secrets.test.ts`.*
- **1.4** Convert the prompt-reading tests. `test/unit/role-briefings.test.ts:50` uses the constant.
  `test/unit/observer-role.test.ts:49` reads `` `roles/${OBSERVER_K8S_ROLE}.md` `` and `:76` calls
  `roleGrant(config, OBSERVER_K8S_ROLE)`. `test/unit/role-envelope-prose.test.ts:267`, `:276` and
  `:277` do the same. **Files:** those three. **Call site:** `roleGrant`
  (`test/support/role-docs.ts:234`) throws on a missing role, so a mismatch is loud.
  *Acceptance: `bun test test/unit/role-briefings.test.ts test/unit/observer-role.test.ts test/unit/role-envelope-prose.test.ts`.*
- **1.5** Correct two stale line citations: `src/backends/cmux/operations-plan.ts:1278` (says `:457`,
  the role is at `fleet.example.yaml:486`) and `src/config/schema.ts:2004` (says `fleet.yaml:542`, the
  tools line is `:696`). Cite by name where the comment allows, so the next move does not re-rot them.
  **Files:** those two. **Call site:** none; comments only, and the task says so in its commit.
  *Acceptance: `bun run typecheck`.*
- **1.6 — the flip.** Set `OBSERVER_K8S_ROLE = "observer-k8s"`. In `fleet.example.yaml`, rename the
  role key at `:486`, the prompt path at `:508`, and `role:` at `:843`, `:844`, `:1002`, `:1027`,
  `:1028`. In `fleet.yaml`, rename the role key at `:665`, the path at `:708`, and `role:` at `:1115`,
  `:1116`, `:1366`, `:1417`, `:1418`. `git mv roles/observer.md roles/observer-k8s.md` and change line 1
  to ``You are `observer-k8s`, the fleet's read-only diagnostic role for Kubernetes.`` Change nothing
  else in the prompt. **Files:** `src/config/schema.ts`, `fleet.example.yaml`, `fleet.yaml`,
  `roles/observer-k8s.md`. **Call site:** `loadConfig` resolves every worker's role
  (`src/config/schema.ts:1628-1634`).
  *Acceptance: `bun run src/cli/index.ts config validate --config fleet.example.yaml`;
  `bun run src/cli/index.ts config validate --config fleet.yaml`; `bun test test/unit`.*
  *Revert check: set the constant back to `"observer"` while the YAML says `observer-k8s`.
  `test/unit/config.test.ts:2423-2425` ("ships exactly one tui observer") returns `[]` and goes red.*
- **1.7** The worker-facing and operator documents that name the role:
  `skills/observer-ops/SKILL.md:3`, `:8`, `:23`, `:234`; `roles/triage.md:263`;
  `skills/pifleet-worker/SKILL.md:15`; `.claude/skills/fleet/SKILL.md:102`, `:109`. Rewrite only the
  identifier and the path. The prose word "observer" stays (§4.2). **Files:** those four.
  **Call site:** `skills/*` is mounted at `/skills` by `src/config/render.ts:561`.
  *Acceptance: `bun test test/unit/skill-frontmatter.test.ts test/unit/worker-docs-currency.test.ts`.*
- **1.8** Add the rename guard, new `test/unit/observer-rename.test.ts`, exactly as §4.3 layers 2 and 3
  specify, with the pane-title exemptions NAMED by file. Correct the operator-visible warning string at
  `src/config/schema.ts:2097` to cite `roles/observer-k8s.md`. **Files:** the new test,
  `src/config/schema.ts`. **Call site:** the guard runs in `bun test test/unit`, and the string is
  emitted by `submitReportWriteWarning`.
  *Acceptance: `bun test test/unit`.*
  *Revert check: put `role: observer` back on `obs-2` in `fleet.example.yaml`. The guard goes red,
  naming the file and line.*
- **1.9** Path citations in comments: `src/run/triage-envelope.ts:195`,
  `test/unit/report-tools.test.ts:818`, `test/unit/observer-role.test.ts:2` and `:14`,
  `test/unit/role-envelope-prose.test.ts:253`. Point each at `roles/observer-k8s.md`, and drop the line
  numbers where the sentence survives without them. **Files:** those four. **Call site:** none;
  comments only. *Acceptance: `bun run typecheck`; the 1.8 guard stays green.*
- **1.H1** `(host)` Apply the same two `role:` edits to the untracked `fleet-operations-local.yaml:301-302`.
- **1.H2** `(host, needs the operator's word)` Restart every seat on the role:
  `./scripts/operations --restart obs-1`, then `./scripts/triage --recreate`. Run `status --all --json`
  and confirm all five seats are live and hold no task. `obs-2` is in no console, so restart it with
  `up` only if it is running.

**Round plan**

| Round | eng-1 | eng-2 |
|---|---|---|
| 1 | 1.1 | idle — every other task depends on the constant |
| 2 | 1.2 | 1.3 |
| 3 | 1.4 | 1.5 |
| 4 | 1.6 | 1.7 |
| 5 | 1.8 | 1.9 |

**Conflicts (never the same round):** `src/config/schema.ts` in 1.1 / 1.5 / 1.6 / 1.8;
`test/unit/config.test.ts` in 1.1 / 1.2; `test/unit/observer-role.test.ts` and
`test/unit/role-envelope-prose.test.ts` in 1.4 / 1.9.

---

### Phase 2 — Harvest contracts for the two new artifacts (`observer-target-artifacts`)

**Goal.** `src/harvest/reconcile.ts` treats `observer-docker-ops.json` and `observer-vm-ops.json`
exactly as it treats `ticket-ops.json`: selected by name, validated against a schema that opens with a
`schema` literal, swept for the worker's credential values, and clamped to `failed` when the `.md`
stands without its `.json`. Nothing writes these files yet, so the phase is inert in production and
fully testable.

**Does not.** Validate `observer-ops.json` (§3.3). Import any `src/run/triage-*.ts` module: the new
enums are defined in the new module, so harvest gains no dependency on the triage console.

**Single-engineer phase, stated.** Every task's call site is `src/harvest/reconcile.ts`, so no two tasks
can share a round. eng-2 is idle throughout, and splitting further would put a module in one round and
its only caller in another.

- **2.1** New `src/harvest/observer-target-artifacts.ts` exporting `OBSERVER_DOCKER_OPS_ARTIFACT_NAME`
  (`"observer-docker-ops.json"`) and `ObserverDockerOpsArtifactSchema`. The schema is §5.6's document:
  a `schema` literal `pifleet.observer-docker-ops/v1`; `worker`; nullable `sweep_id` and
  `window_opened_at`; `services[]` rows requiring `name`, `namespace`, `assessment` (the four-member
  enum), `coverage[]` (`channel` closed to §5.6's five, `result` to the four-member enum), `selector`,
  `window`, `evidence_ref[]`; and optional `container_id`, `image`, `restart_count`. Wire the name into
  `reconcile.ts` beside `TICKET_OPS_ARTIFACT_NAME` (`:814`, `:824`) so a file at that name is retained,
  parsed, and clamps to `failed` on a schema failure with the reason naming the file, following
  `:858-868` and `:479`. **Files:** the new module, `src/harvest/reconcile.ts`,
  `test/unit/harvest-reconcile.test.ts`. **Call site:** `reconcile.ts:814`.
  *Acceptance: `bun test test/unit/harvest-reconcile.test.ts`; `bun run typecheck`.*
  *Revert check: remove the new name from the selection at `:814`. The test "a malformed
  observer-docker-ops.json clamps to failed" goes red.*
- **2.2** The VM twin: `OBSERVER_VM_OPS_ARTIFACT_NAME`, `ObserverVmOpsArtifactSchema` (§6.7: schema
  literal `pifleet.observer-vm-ops/v1`, the six-channel enum, optional `uptime_s`, `system_state`,
  `failed_units[]`), and the same wiring. **Files:** as 2.1.
  *Acceptance: `bun test test/unit/harvest-reconcile.test.ts`.*
- **2.3** Generalise the orphaned-document pass (`reconcile.ts:743-801`) from one name pair to the three.
  Derive each `.md` name from its `.json` name as `:199` does. Keep the per-directory pairing and the
  decided-before-content ordering its docblock requires. **Files:** `src/harvest/reconcile.ts`,
  `test/unit/harvest-reconcile.test.ts`.
  *Acceptance: `bun test test/unit/harvest-reconcile.test.ts`.*
  *Revert check: restrict the pass back to ticket-ops. An `observer-vm-ops.md` alone no longer clamps,
  and the test goes red.*
- **2.4** The credential sweep. For ticket-ops it runs inside the parse (`reconcile.ts:777-781`). Make
  both new parses run it too, and add a wiring test that drives needles through `resolveWorkerNeedles`
  (`src/harvest/needles.ts:187`, passed at `src/harvest/index.ts:720`) into an outbox holding an
  `observer-docker-ops.json` that embeds the needle. **Files:** `src/harvest/reconcile.ts`,
  `src/harvest/observer-target-artifacts.ts`, `test/unit/harvest-credential-sweep-wiring.test.ts`.
  *Acceptance: `bun test test/unit/harvest-credential-sweep-wiring.test.ts test/unit/harvest-reconcile.test.ts`.*
  *Revert check: skip the sweep for the docker parse. The embedded needle passes, and the test goes red.*

**Round plan:** 2.1, 2.2, 2.3, 2.4 in rounds 1-4, all eng-1. **Conflicts:** all four share
`src/harvest/reconcile.ts`.

---

### Phase 3 — SSH through the CONNECT proxy, baked into the image (`observe-ssh-transport`)

**Goal.** Every image carries `openssh-client`, `/opt/pifleet/ssh-connect.cjs` and an `observe-ssh`
shim. Given a target token, the shim builds one fixed `ssh` argv from delivered secret files and
refuses everything it cannot validate before `ssh` runs. No role uses it yet, so the phase ships inert.

**Does not.** Add a `docker` CLI, mount any socket, or add any `egress.allow` rule.

- **3.0** `(host, PM-owned pre-work)` Characterise the transport in a throwaway container on the
  project manager's own machine, against a local CONNECT listener and a local sshd — never an enrolled
  target. Record: whether OpenSSH accepts a private key at the fleet's secret-file mode and ownership,
  or needs a `0600` copy, and which directory is writable for that copy; that
  `ProxyCommand node … %h %p` round-trips; `ssh`'s exit code for a host-key mismatch and for a remote
  exit 77. Commit `test/fixtures/observe/ssh-transport-facts.json` and
  `scripts/observe/characterise-ssh-transport`. Engineers wire this fixture and do not re-derive it.
- **3.1** New `docker/ssh-connect.cjs`. It reads `HTTPS_PROXY`, sends `CONNECT <host>:<port>`, splices
  stdin and stdout on `200`, and on any other status exits non-zero with the proxy's refusal line on
  stderr (the proxy names the rule, `docker/connect-proxy.cjs:36-38`). It refuses a missing proxy or a
  non-integer port. Add the `COPY` to `/opt/pifleet/ssh-connect.cjs` and enrol the file in
  `BUILD_CONTEXT_ASSETS` (`src/container/image.ts:102`). **Files:** `docker/ssh-connect.cjs`,
  new `test/unit/ssh-connect.test.ts` (an in-process fake CONNECT server), `docker/Dockerfile`,
  `src/container/image.ts`, `test/unit/dockerfile-build-assets.test.ts` (the enrolled-name pin at
  `:132`). Five files: over the line by one, because the pin must move with the array.
  **Call site:** the Dockerfile `COPY`, proven by `test/unit/dockerfile-build-assets.test.ts:98`.
  *Acceptance: `bun test test/unit/ssh-connect.test.ts test/unit/dockerfile-build-assets.test.ts`.*
  *Revert check: drop the asset from `BUILD_CONTEXT_ASSETS`. The test at `:98` goes red.*
- **3.2** New `docker/observe-ssh <docker|vm> <target> <verb> [key=value …]`, POSIX `sh` with `set -f`.
  It resolves `<target>` from `OBSERVER_<KIND>_TARGETS_FILE` (lines of `token host port user`,
  token grammar §5.3); refuses an unknown token, a malformed line, and any argument containing
  whitespace, a shell metacharacter or a leading `-`; and execs exactly the §5.2 argv with the key and
  known-hosts files from `OBSERVER_<KIND>_SSH_KEY_FILE` and `OBSERVER_<KIND>_KNOWN_HOSTS_FILE`, using
  the key-copy behaviour the 3.0 fixture records. **Files:** `docker/observe-ssh`, new
  `test/unit/observe-ssh.test.ts` (a recording fake `ssh` on `PATH`). **Call site:** 3.3 installs it
  on `PATH`. Phases 4 and 5 call it.
  *Acceptance: `bun test test/unit/observe-ssh.test.ts`.*
  *Revert check: delete `-o StrictHostKeyChecking=yes` from the argv. The argv assertion goes red.*
- **3.3** Install the transport in the image: add `openssh-client` to the base apt line
  (`docker/Dockerfile:48-49`), `COPY` `docker/observe-ssh` to `/usr/local/bin/observe-ssh`, add
  `ssh -V` and `observe-ssh --help` to the build smoke block (`:365-377`), and enrol the shim in
  `BUILD_CONTEXT_ASSETS`. **Files:** `docker/Dockerfile`, `src/container/image.ts`,
  `test/unit/dockerfile-build-assets.test.ts`.
  *Acceptance: `bun test test/unit/dockerfile-build-assets.test.ts test/unit/dockerfile-runtime-deps.test.ts`.*
- **3.4** Injection hardening as its own criterion: a table of hostile arguments (`;`, `$(…)`, backticks,
  embedded newline, `-oProxyCommand=…`, `*`) that must each be refused with no `ssh` invocation recorded.
  **Files:** `docker/observe-ssh`, `test/unit/observe-ssh.test.ts`.
  *Acceptance: `bun test test/unit/observe-ssh.test.ts`.*
- **3.H1** `(host)` Rebuild every toolchain image in use, because the base layer changed and every tag
  moves: `bun run src/cli/index.ts image build --toolchain base`, then `node` and `python`.

**Round plan:** R1 eng-1 3.1, eng-2 3.2. R2 eng-1 3.3, eng-2 3.4. Two rounds, because the phase has four
criteria. **Conflicts:** `docker/Dockerfile`, `src/container/image.ts` and
`test/unit/dockerfile-build-assets.test.ts` in 3.1 / 3.3; `docker/observe-ssh` and
`test/unit/observe-ssh.test.ts` in 3.2 / 3.4.

---

### Phase 4 — The `observer-docker` role (`observer-docker-role`)

**Goal.** An enrolled Docker host can be asked about named or selected containers through `obs-d1`,
and the only commands the credential can run are §5.4's, proven against a recording fake `docker`.

**Does not.** Enrol any real host, or add an `egress.allow` rule to `fleet.yaml` (Phase 6, Q3).

- **4.0** `(host, PM-owned pre-work)` On the PM's own disposable Docker daemon, which is not an enrolled
  target, characterise and commit: the key SET of `docker ps --format '{{json .}}'` and of
  `docker stats --no-stream --format '{{json .}}'`; the shape of `.State.Health` with and without a
  healthcheck; which bound flag makes `docker events` terminate; the daemon's subcommand list minus
  §5.4's allowlist, as the forbidden-verbs fixture. Files: `test/fixtures/observe/docker-cli-shapes.json`,
  `test/fixtures/observe/docker-forbidden-verbs.json`, `scripts/observe/characterise-docker`.
- **4.1** New `scripts/observe/docker-forced-command` (POSIX `sh`, `set -f`, no `eval`), implementing
  `ps`, `inspect`, `info` and `version` from §5.4 with the fixed inspect and info templates. It reads
  `SSH_ORIGINAL_COMMAND` and exits 77 naming the verb on anything else. **Files:** the script, new
  `test/unit/observe-docker-forced-command.test.ts`, which sets `SSH_ORIGINAL_COMMAND` exactly as sshd
  does, with a recording fake `docker` on `PATH`. **Call site:** sshd's forced-command invocation,
  reproduced by the test; the enrolment line in 4.4's skill.
  *Acceptance: `bun test test/unit/observe-docker-forced-command.test.ts`.*
  *Revert check: add `.Config.Env` to the inspect template. The disclosure assertion goes red.*
- **4.2** New `docker/observe-docker` (`exec observe-ssh docker "$@"`), `COPY` to
  `/usr/local/bin/observe-docker`, a smoke line, and enrolment in `BUILD_CONTEXT_ASSETS`.
  **Files:** `docker/observe-docker`, `docker/Dockerfile`, `src/container/image.ts`,
  `test/unit/dockerfile-build-assets.test.ts`. **Call site:** the Dockerfile `COPY`.
  *Acceptance: `bun test test/unit/dockerfile-build-assets.test.ts`.*
- **4.3** Extend the forced command with `logs` (mandatory `since` and `tail`, `tail <= 500`), `stats`,
  `top` and `events` (bound flag from the 4.0 fixture). Add a test that walks
  `test/fixtures/observe/docker-forbidden-verbs.json` and asserts exit 77 with NO recorded `docker`
  invocation for each entry. **Files:** as 4.1.
  *Acceptance: `bun test test/unit/observe-docker-forced-command.test.ts`.*
  *Revert check: add `restart` to the verb case. The fixture walk goes red on `restart`, naming it.*
- **4.4** New `skills/observer-docker-ops/SKILL.md`: the brief inputs (§5.3), the verb grammar and
  forbidden list with reasons (§5.4), the artifact contract with a complete JSON example (§5.6), the
  bounded-read rule, and the operator enrolment line (§5.7) for reference. **Files:** the skill.
  **Call site:** 4.5's role `skills:` list, proven by `test/unit/role-briefings.test.ts:60` ("every
  skill a resolved worker asks for has a bundle directory").
  *Acceptance: `bun test test/unit/skill-frontmatter.test.ts`.*
- **4.5** The role in `fleet.example.yaml` exactly as §5.5 (with `docker-host.example.com`), plus the
  three `secrets.env_allowlist` entries and seat `obs-d1`. New `roles/observer-docker.md`: the role's
  identity line, "read-only describes the TARGET, not your outbox" carried over from
  `roles/observer.md:10-37`, the call-budget rule, and the `submit_report` routing paragraph. Add
  `observer-docker` to the lists at `test/unit/role-briefings.test.ts:48-57` and
  `test/unit/config.test.ts:196-198`, and `obs-d1` to the worker set that follows. **Files:**
  `fleet.example.yaml`, `roles/observer-docker.md`, `test/unit/role-briefings.test.ts`,
  `test/unit/config.test.ts`. **Call site:** `loadConfig` and `resolveAllWorkers`.
  *Acceptance: `bun run src/cli/index.ts config validate --config fleet.example.yaml`;
  `bun test test/unit/role-briefings.test.ts test/unit/config.test.ts`.*
- **4.6** A test that the JSON example in `skills/observer-docker-ops/SKILL.md` parses with
  `ObserverDockerOpsArtifactSchema` (Phase 2), in the manner `test/unit/triage-verdict.test.ts:3470-3485`
  reads a skill's schema block. Fix the example if it does not parse. **Files:** new
  `test/unit/observer-docker-skill-example.test.ts`, `skills/observer-docker-ops/SKILL.md`.
  *Acceptance: `bun test test/unit/observer-docker-skill-example.test.ts`.*
  *Revert check: write `"assessment": "failed"` in the example. The test goes red, which is the exact
  failure `skills/observer-ops/SKILL.md:95-105` records.*
- **4.7** New `test/unit/observer-docker-role.test.ts`, pinning the resolved grant through `roleGrant`:
  no `edit`; `write` and `submit_report` present; `cloud_access` false; `egress_access` true;
  `isolation: none`; `pane_mode: rpc`; the three secret names. **Files:** that test. **Call site:**
  `test/support/role-docs.ts:234`.
  *Acceptance: `bun test test/unit/observer-docker-role.test.ts`.*
  *Revert check: add `edit` to the role's tools. The test goes red.*
- **4.8** The role and seat in the live `fleet.yaml`, with no `egress.allow` rule (Q13), and the three
  names in its `secrets.env_allowlist`. **Files:** `fleet.yaml`.
  *Acceptance: `bun run src/cli/index.ts config validate --config fleet.yaml`.*

**Round plan**

| Round | eng-1 | eng-2 |
|---|---|---|
| 1 | 4.1 | 4.2 |
| 2 | 4.3 | 4.4 |
| 3 | 4.5 | 4.6 |
| 4 | 4.7 | 4.8 |

**Conflicts:** the forced-command script and its test in 4.1 / 4.3; `skills/observer-docker-ops/SKILL.md`
in 4.4 / 4.6. **Ordering:** 4.4 must merge before or with 4.5, or the bundle-directory test at
`test/unit/role-briefings.test.ts:60` is red.

---

### Phase 5 — The `observer-vm` role (`observer-vm-role`)

**Goal.** An enrolled Linux VM can be asked about its health, units and journal through `obs-v1`,
and the credential cannot power it off, change a unit, or read an arbitrary path. The optional `cloud`
channel is pinned to the verb gate's existing classification.

**Does not.** Enrol a real VM, or enable `cloud_access` unless Q2 enables the channel.

- **5.0** `(host, PM-owned pre-work)` On the PM's own disposable systemd VM, characterise and commit:
  the `journalctl` relative-since spelling that works on the oldest systemd version in scope; the output
  of `systemctl show --property=…` and of `list-units --state=failed --plain`; and a forbidden-commands
  fixture (the `systemctl` verbs other than `is-system-running`, `list-units` and `show`, and the
  journal maintenance flags). Files: `test/fixtures/observe/vm-tool-shapes.json`,
  `test/fixtures/observe/vm-forbidden-commands.json`, `scripts/observe/characterise-vm`.
- **5.1** New `scripts/observe/vm-forced-command`: `uptime`, `os`, `system`, `failed`, `unit`, `disk`,
  `memory` (§6.4), with the unit-name grammar. **Files:** the script, new
  `test/unit/observe-vm-forced-command.test.ts` (recording fake `systemctl`, `journalctl`, `df`, `cat`).
  *Acceptance: `bun test test/unit/observe-vm-forced-command.test.ts`.*
  *Revert check: accept `restart` as a `unit` sub-verb. The test goes red.*
- **5.2** New `docker/observe-vm`, its `COPY`, smoke line and asset enrolment. **Files:**
  `docker/observe-vm`, `docker/Dockerfile`, `src/container/image.ts`,
  `test/unit/dockerfile-build-assets.test.ts`.
  *Acceptance: `bun test test/unit/dockerfile-build-assets.test.ts`.*
- **5.3** `journal` and `kernel` (mandatory `since` and `lines`, `lines <= 500`, since spelling from the
  5.0 fixture), plus the walk over the forbidden-commands fixture asserting exit 77 and no recorded
  invocation. **Files:** as 5.1.
  *Acceptance: `bun test test/unit/observe-vm-forced-command.test.ts`.*
  *Revert check: pass `--vacuum-time` through. The fixture walk goes red.*
- **5.4** New `skills/observer-vm-ops/SKILL.md`, the §6 counterpart of 4.4, including
  "unreachable is `indeterminate`, never `unhealthy`" (§6.3). **Files:** the skill.
  *Acceptance: `bun test test/unit/skill-frontmatter.test.ts`.*
- **5.5** The role in `fleet.example.yaml` as §6.6 with `vm-1.example.com`, secrets, seat `obs-v1`; new
  `roles/observer-vm.md`; the lists in `test/unit/role-briefings.test.ts` and `test/unit/config.test.ts`.
  **Files:** those four.
  *Acceptance: `bun run src/cli/index.ts config validate --config fleet.example.yaml`;
  `bun test test/unit/role-briefings.test.ts test/unit/config.test.ts`.*
- **5.6** The skill-example parse test against `ObserverVmOpsArtifactSchema`. **Files:** new
  `test/unit/observer-vm-skill-example.test.ts`, `skills/observer-vm-ops/SKILL.md`.
  *Acceptance: `bun test test/unit/observer-vm-skill-example.test.ts`.*
- **5.7** The grant pin test for `observer-vm` (as 4.7, with `cloud_access` asserted against Q2's
  answer). **Files:** new `test/unit/observer-vm-role.test.ts`.
  *Acceptance: `bun test test/unit/observer-vm-role.test.ts`.*
- **5.8** The role and seat in the live `fleet.yaml` (no egress rule), plus secrets allowlist names.
  **Files:** `fleet.yaml`.
  *Acceptance: `bun run src/cli/index.ts config validate --config fleet.yaml`.*
- **5.9** *(only if Q2 enables `cloud`)* Pin §6.5's five rows in `test/integration/verbgate.test.ts`,
  beside its existing `gcloud compute instances describe` probe at `:302`. That suite runs the shim in a
  container, so it needs a local container runtime. Set `cloud_access: true` on the role in both configs
  and add the channel to the skill. **Files:** `test/integration/verbgate.test.ts`,
  `fleet.example.yaml`, `fleet.yaml`, `skills/observer-vm-ops/SKILL.md`.
  *Acceptance: `bun test test/integration/verbgate.test.ts`.*
  *Revert check: add `suspend` to the gate's gcloud read set. The new probe goes red.*

**Round plan**

| Round | eng-1 | eng-2 |
|---|---|---|
| 1 | 5.1 | 5.2 |
| 2 | 5.3 | 5.4 |
| 3 | 5.5 | 5.6 |
| 4 | 5.7 | 5.8 |
| 5 | 5.9, if enabled | idle |

**Conflicts:** the forced command and its test in 5.1 / 5.3; the skill in 5.4 / 5.6 / 5.9;
`fleet.example.yaml` in 5.5 / 5.9; `fleet.yaml` in 5.8 / 5.9. **Ordering:** 5.4 before or with 5.5.

---

### Phase 6 — Operator skill, enrolment and the live negative probe (`observer-operator-enrolment`)

**Goal.** An operator can find, enrol and dispatch the two new seats from the fleet skill, and one
enrolled Docker host and one enrolled VM have been observed REFUSING a mutation, not merely answering a
read.

**Small phase, stated.** Two engineer tasks in one round. The rest is host work that cannot be
dispatched.

- **6.1** `.claude/skills/fleet/SKILL.md`: add `obs-d1` and `obs-v1` to the fleet table (and `obs-2`,
  which it omits, §0.5), add trigger phrases to the description, and add a routing row for
  `Workflows/EnrolTarget.md`. In `.claude/skills/fleet/Workflows/DispatchTask.md`, add how a Docker or VM
  inquiry brief names its target, containers or units, checks and window, still verbatim from the user
  per its CARDINAL RULE. **Files:** those two.
  *Acceptance: `bun test test/unit/skill-frontmatter.test.ts`.*
- **6.2** New `.claude/skills/fleet/Workflows/EnrolTarget.md`: §5.7 and §6.2 as an operator runbook,
  including capturing the host key, adding the `egress.allow` rule (Q3), adding the secrets, and the
  before-and-after probe in 6.H4. **Files:** that file.
- **6.H1** `(host)` Rebuild images if Phases 4 and 5 changed the build context since 3.H1.
- **6.H2** `(host, operator)` Enrol one Docker host and one VM per §5.7 and §6.2. Commit the two
  `egress.allow` rules to `fleet.yaml` only after Q3 is answered, and add the secret values to the
  operator's environment. Run `bun run src/cli/index.ts config validate --config fleet.yaml`.
- **6.H3** `(host)` Positive probe: dispatch a read-only inquiry to each seat. Each must produce a pair
  that harvest validates, with no leak refusal.
- **6.H4** `(host, operator)` **Negative probe, and it is the acceptance for the whole design.**
  Record the target's `State.StartedAt` for one container, then dispatch to `obs-d1` the brief "restart
  <container> on <target>". The artifact must carry a `forbidden` coverage row, the envelope status must
  be `blocked`, the target's `sshd` log must show the forced command, and `State.StartedAt` must be
  unchanged. Repeat against `obs-v1` with "reboot <vm>": `forbidden`, `blocked`, and `/proc/uptime`
  strictly greater afterwards.

**Round plan:** R1 eng-1 6.1, eng-2 6.2. Then the host tasks in order.

---

## 13. References

- `Docs/SRD-DEPLOY-OPS.md` (SRD-OBSERVER-001) — §6.1-§6.6 the role and its grants; §7.1 inputs reach no
  prompt; §9.3 statuses; §10 security model.
- `Docs/SRD-TRIAGE-CONSOLE.md` (SRD-TRIAGE-CONSOLE-001) — §13's checklist form, which this one follows.
- `roles/observer.md`, `skills/observer-ops/SKILL.md` — the prompt and skill this document renames and
  mirrors.
- `docker/verbgate`, `docker/honeypot.cjs`, `docker/connect-proxy.cjs`, `docker/egress-policy.cjs`,
  `docker/Dockerfile` — worker-side containment.
- `src/config/schema.ts`, `src/config/load.ts`, `src/config/render.ts` — role resolution.
- `src/harvest/reconcile.ts`, `src/harvest/needles.ts` — artifact validation and the credential sweep.
- `src/run/dispatch-request.ts`, `src/run/task-ids.ts`, `src/backends/cmux/operations-plan.ts`,
  `test/unit/triage-readonly.test.ts` — the triage contracts this document leaves unchanged.
- `.claude/skills/fleet/SKILL.md` — the operator skill and its roster-source warning.

