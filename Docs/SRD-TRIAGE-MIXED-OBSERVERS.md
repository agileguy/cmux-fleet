# System Requirements Document: the triage console grows from one collator over three Kubernetes observers to one collator over six mixed observers

**SRD-TRIAGE-MIXED-OBSERVERS-001 v0.2, DRAFT FOR OWNER REVIEW**

*Sits on top of `Docs/SRD-TRIAGE-CONSOLE.md` (the console this document extends) and
`Docs/SRD-OBSERVER-ROLES.md` (the roles, credentials and artifact schemas this document reuses without
change). It changes no target-side access boundary. Everything it touches is console plumbing: pane
layout, roster, the targets inventory, partition, and how the collator reads a reply. The implementation
plan (§11) is shaped for `/ProjectManager` on one long-lived branch: each phase closes with local
typecheck, the full unit suite and a review fix loop, with no CI and no push until the branch is ready
to merge.*

---

## 0. Thesis

The `observer-k8s`, `observer-docker` and `observer-vm` roles, their credentials and their artifact
schemas already exist (`fleet.yaml:1171-1176`, `fleet.example.yaml:544-585`), built by
`Docs/SRD-OBSERVER-ROLES.md`. `obs-d1` and `obs-v1` hold the docker and vm seats today, both in no
console. This document adds three more seats to the triage console instead of reusing those two, and
teaches the console to sweep three kinds of target in one collated document instead of one. Nothing
here changes what a seat may run on its target. What changes is how many seats there are, how the
console's pane rows are built, how the target inventory names a kind, how work is partitioned per kind,
and how the collator reads each seat's reply.

## 1. Owner decisions

1. **Layout.** `tri-1` full width on top. Below it, two full-width rows of three: row one is
   `obs-t1`, `obs-t2`, `obs-t3` (role `observer-k8s`, unchanged), left to right; row two is
   `obs-td1`, `obs-td2` (role `observer-docker`, new), `obs-tv1` (role `observer-vm`, new), left to
   right. This replaces the earlier one-row-of-six idea.
2. **One sweep, one collated document.** `tri-1` sweeps all six seats and writes one `triage.json`
   and `triage.md` per sweep, as it does today for three.
3. **New seats, not `obs-d1`/`obs-v1`.** Those two stay in no console, kept for ad-hoc inquiries.
4. **Docker target: one enrolled host, token `docker`.** Its monitoring stack, `grafana`,
   `grafana-renderer`, `prometheus`, `cadvisor`, `node_exporter`, is what gets triaged. Both Docker
   seats work that one host, split between them.
5. **VM target: one enrolled VM, token `vm`, swept by `obs-tv1` alone.** No split. Its checks are
   the whole-system set (`uptime`, `system`, `failed`, `disk`, `memory`) plus three named units on
   every sweep: `docker.service`, `ssh.service`, `systemd-journald.service`.
6. **Concurrency.** `run.max_concurrent` becomes 12 in both `fleet.yaml` and `fleet.example.yaml`.
7. **Inventory.** `triage/targets.yaml` grows a target kind on each environment. No second file.
8. **Reply file, tui warning, acceptance bar, freshness gates.** All four unchanged from this
   document's own earlier defaults: a filename per kind, the tui hazard generalized to all three
   observer roles, one live sweep with rows from every kind and no partition refusal as the bar, and
   `sweep_id`/`window_opened_at` gates applying uniformly across kinds. See §8 D11 to D13.
9. **Process.** This SRD goes to the owner for review, then gets implemented phase by phase.

## 2. Current state, verified against the tree at HEAD `936e932`

**Layout.** `triagePanes` delegates to `collatorOverRowPanes(opts, DEFAULT_TRIAGE_WORKERS, "triage")`
(`operations-plan.ts:1496-1497`), shared with `reviewPanes` (`:1188-1189`) and capped at
`SQUARE_MAX_PANES = 4` (`:715`, checked at `:877`). Its split table is `[null, down-from-0,
right-from-1, right-from-2, ...]`: one `down` split opens the row below the collator, every later pane
splits `right` off the one before it, walking a SINGLE row. Nothing in it groups panes by row, so it
has no shape for a second one. `TRIAGE_OBSERVER_WIDTH_FRACTION = 1/3` (`:1440`) and
`TRIAGE_TOP_FRACTION = 1/3` (`:1404`) both assume one observer row.

`applyTopFraction` (`operations.ts:717-`) groups panes by `y` into "the top row" and "everything
else," then resizes whichever side needs it. The grow branch moves only the top row and is unaffected
by how many rows sit below it. The shrink branch is not: it moves EVERY pane in "everything else" with
`-U`, each against `containerHeight * (1 - fraction)`, a target sized for a single row below the
collator. With two observer rows, a row-one pane's height is roughly half that target, so its computed
delta over-moves the collator's border, and a row-two pane's `-U` addresses the border BETWEEN the two
observer rows, not the collator's. So this pass does NOT settle the collator's own share when the top
row must shrink over two lower rows; see §4.3.
`applyBottomWidths` (`operations.ts:859-899`) corrects widths only in "the bottom row," the panes
sharing the LARGEST `y`; with two observer rows only the lower one would be corrected today.

**Roster.** `DEFAULT_TRIAGE_WORKERS` (`operations-plan.ts:1336-1341`) holds four ids, in pane CREATION
order (`createWorkspace`, `operations.ts:588-`, iterates this array and references an EARLIER index as
each pane's split anchor; today's single row happens to make creation order and reading order the
same). `TRIAGE_CONSOLE_ROSTER` (`dispatch-request.ts:442-475`) has `reviewers: ["obs-t1", "obs-t2",
"obs-t3"]` (`:463`). `TRIAGE_CONSOLE_ASPECTS` (`task-ids.ts:165-196`) pairs each worker id with an
`aspect`; `AspectSeat` (`:101-106`) is shared with `REVIEW_CONSOLE_ASPECTS`. `CONSOLES`
(`relay.ts:300-313`) wires roster and aspects per console name. Tests pinning three seats:
`triage-role.test.ts:534`, `dispatch-request.test.ts:1678-1702` (set equality, sorted rather than
ordered, since pane order and role grouping are different facts), `triage-plan.test.ts:165-175`,
`fresh-dispatch.test.ts:911` and `:949`, `triage-command.test.ts:1857`.

`run.max_concurrent: 4` (`fleet.yaml:92`, `fleet.example.yaml:103`) carries a tracked comment sizing it
to exactly four seats with nothing spare. `obs-1`, `tri-1`, `obs-t1..3` carry `pane_mode: tui`;
`obs-d1`/`obs-v1` inherit `rpc`. `observerTuiWorkers` (`schema.ts:1996-2019`) matches only
`w.role !== OBSERVER_K8S_ROLE`, keyed to the role name because the hazard (an unadopted `tui` pane
allocates no epoch, so a re-dispatched pass runs the same task twice) is a property of
`observer-ops`'s watch pattern, not something the schema can derive.

**Roles and credentials already exist.** `observer-docker` and `observer-vm`
(`fleet.example.yaml:544-585`, `fleet.yaml:741-773`) hold no cluster identity, one SSH key each,
`egress_access: true`, no `docker` CLI in the image. Both targets' accounts, forced commands and sshd
settings are done (`Docs/SRD-OBSERVER-ROLES.md` host task 6.H2, 2026-09-14), and the live `fleet.yaml`
already carries a fleet-wide `egress.allow` entry for each (`pifleet-docker:22`, `pifleet-vm:22`; the
"no egress.allow rule here" comment beside each role means the rule lives fleet-wide, not that it is
absent). The live probes (6.H3, 6.H4) are still open, and this document's live-probe phase depends on
them. Access is enforced target-side; this document does not touch that boundary.

**Sweep path and the one-environment limit.** `pifleet triage` dispatches through `sweepProducers(deps)`,
whose `openSweep`/`dispatchObserver` read a resolved `pairs` array while `joinSweep` loops the module
constant `TRIAGE_CONSOLE_ASPECTS` directly (`triage-envelope.ts:1786-2001`), a pattern not worth
copying forward. `soleEnvironment` (`src/cli/commands/triage.ts:1001-1015`, confirmed present at that
line and current) refuses a targets file declaring anything other than EXACTLY ONE environment,
quoting `Docs/SRD-TRIAGE-CONSOLE.md` §12: "one sweep is ONE environment." A mixed-kind file needs up to
three environments (one per kind) present at once for the acceptance sweep, so this refusal cannot
survive unmodified; §6.1 replaces it. The seam is already half built: `ConsoleHealthFacts.environments`
(`triage-incident.ts:1790-1829`) is already `readonly ConsoleEnvironmentFacts[]`, today populated with
one element by `triage-pass.ts`'s `settle()`; a multi-environment sweep is a shape this type already
expected.

**Reply harvest.** `OBSERVER_ARTIFACT_FILE = "observer-ops.json"` (`triage-envelope.ts:146`), read by
`parseObserverArtifact`/`readObserverArtifactAt` (`:1502-1548`), is lenient about a missing echo: an
absent `sweep_id` reads `null`, turned by the host-side gates `sweepIdEcho`/`windowEcho` into
`stale_replay`/`stale_window` rather than a refusal. Docker and vm roles write
`observer-docker-ops.json`/`observer-vm-ops.json` instead (`src/harvest/observer-target-artifacts.ts:109-136`),
each with its own `schema` literal and the same required-but-nullable echo keys.
`triage-envelope.ts` refuses to import `src/harvest/`, so today a docker or vm seat's reply is simply
invisible to a sweep: the reader only ever looks for `observer-ops.json`.

**Partition.** `checkTriagePartition` (`src/run/triage-partition.ts:275-330`) takes a flat `declared:
string[]` and a list of `{worker, services}` assignments; width-agnostic in its counting, but its
`partition_duplicate` text hardcodes "the fan-out is three requests wide (§6.5)" at line 309. With
mixed kinds a container must never land in a k8s observer's request or vice versa, so partitioning
has to run per kind.

`roles/triage.md:83-107` ("YOU HAVE EXACTLY ONE OBSERVER") describes splitting one environment evenly
across "your observers" as one group; §5 rewrites it for three kinds. Its "## The seats" block renders
data-driven from `TRIAGE_CONSOLE_ASPECTS`, so it needs no code change to list six. `console-relay.ts:546-555`
still calls the roster "the pair," `["tri-1", "obs-t1"]`, already stale. `Docs/SRD-OBSERVER-ROLES.md`
section 4.5 and D4 say the two new roles join no console; this document supersedes both for the three
new triage-only seats, leaving `obs-d1`/`obs-v1` exactly as that document left them (owner decision 3).

## 3. Scope

### 3.1 In scope

1. A dedicated triage pane layout: two full-width rows of three under the collator, seven panes
   total, built by a plan of its own rather than the shared square/row builders.
2. Grow the roster and aspects to six observers, in the owner's reading order; the pane plan's own
   worker order differs from reading order for a reason §4 states.
3. Add two new seats to `fleet.yaml`/`fleet.example.yaml`: `obs-td1`, `obs-td2` (role
   `observer-docker`) and `obs-tv1` (role `observer-vm`), each `pane_mode: tui`, joining the triage
   console only.
4. Extend `triage/targets.yaml`'s schema with an environment `kind` (k8s, docker, vm), so the file
   can declare a docker host's containers and a VM's units alongside the existing Kubernetes
   environment, and replace `soleEnvironment`'s one-environment refusal with a kind-aware version.
5. Per-kind partitioning: three separate completeness checks per sweep instead of one.
6. Teach the collator's reader to find each seat's reply at the right filename for its kind.
7. Raise `run.max_concurrent` to 12 in both configs.

### 3.2 Non-goals

- **Any change to what a seat may run on its target.** That boundary belongs to
  `Docs/SRD-OBSERVER-ROLES.md` and is untouched.
- **`obs-d1` or `obs-v1` joining any console.** They stay ad-hoc, per owner decision 3.
- **A second Docker host or a second VM.** One of each, per owner decisions 4 and 5.
- **Renaming `observer-ops.json`, `OBSERVER_ARTIFACT_FILE`, or either new artifact's schema.**
- **Widening `REVIEW_CONSOLE_ASPECTS`, the review console's pane cap, or `collatorOverRowPanes`
  itself.** Untouched; see D1.

## 4. Design: layout

### 4.1 A dedicated builder, not a wider parameter

`collatorOverRowPanes` is left exactly as it is and stays `reviewPanes`'s only caller.
Two full-width rows of three cannot be reached by giving that function a bigger pane ceiling: its
split table only ever creates ONE row (`down` once, `right` for every later pane), so a longer list
just makes one wider row, not two. `triagePanes` instead builds its own seven-entry table, on the same
precedent `agentSquarePanes` set for its own shape: a hardcoded table beside a docblock diagram, not a
computed sequence, because the anchor discipline (which pane a split names as `splitFrom`) is the part
that breaks under a "same as the previous one" assumption.

### 4.2 The split table, and why creation order is not reading order

A full-width row can only be peeled off BEFORE the row above it gets divided into columns; once a
pane has been split `right`, a later `down` split off it only affects that narrowed cell, not the
whole row. So the down-split that opens row two must happen before row one's own `right` splits. The
seven panes are therefore created in this order (index is array position, which is also the
`createWorkspace` creation order):

| Index | Worker | Split | splitFrom |
|---|---|---|---|
| 0 | `tri-1` | none (initial surface) | |
| 1 | `obs-t1` | down | 0 |
| 2 | `obs-td1` | down | 1 |
| 3 | `obs-t2` | right | 1 |
| 4 | `obs-t3` | right | 3 |
| 5 | `obs-td2` | right | 2 |
| 6 | `obs-tv1` | right | 5 |

Panes 1 and 2 open both rows, full width, before either row is divided into columns; panes 3-4 then
split row one into three and panes 5-6 split row two into three. The RESULT matches the owner's reading
order exactly (row one left to right `obs-t1, obs-t2, obs-t3`; row two `obs-td1, obs-td2, obs-tv1`),
even though the CREATION order interleaves the two rows' leading panes. `DEFAULT_TRIAGE_WORKERS` is
reordered to this creation order (§5 D3); it is used only to build the pane plan. `TRIAGE_CONSOLE_ASPECTS`
and `TRIAGE_CONSOLE_ROSTER` stay in the owner's reading order, because dispatch, the rendered "## The
seats" block and every existing test read them as a set or in reading order, never as a geometry.

The builder refuses any count other than exactly seven, naming the console: the table has no
sensible degraded shape for five or six workers the way a flat row degrades to a shorter prefix.

### 4.3 Height: two passes, not one

The earlier draft of this section said `applyTopFraction`'s top-vs-rest grouping tolerates more than
one row underneath; that premise turned out false, and the owner chose the fix below on 2026-09-15.

`applyTopFraction`'s shrink branch narrows from "every pane below the top row" to "the panes at the
smallest `y` below the top row" — the row directly beneath the collator. It moves those panes `-U` by
`topHeight - topTarget` (the current top-row height minus `containerHeight * fraction`), re-reading
geometry before each pane exactly as today. For a console with exactly one row below the top — review,
operations; development sets `topFraction: null` and never runs this pass — this issues the same
command sequence as before: the amount is identical in a layout with no divider between the rows, and
on a live console can differ by at most the divider's width, since the old target counted the divider
into the lower row and the new one does not. The grow branch is unchanged: top-row panes still move
`-D`.

A second, new pass, `applyMiddleRowFraction`, runs in `createWorkspace` right after `applyTopFraction`
and before `applyBottomWidths`. It is gated on a new optional `WorkspaceSpec` field,
`middleRowFraction?: number | null`; only `TRIAGE_SPEC` sets it, to a new constant
`TRIAGE_OBSERVER_ROW_FRACTION = 1/2` in `operations-plan.ts`. Unset or `null` means the pass returns
before reading geometry, a no-op for every console but triage. It acts only when the layout has exactly
three rows — the top row plus two below; on any other shape it reads geometry and does nothing. Its
target is `middleRowFraction` of the two lower rows' COMBINED height (middle-row height plus
bottom-row height, so a divider between them does not skew the split). It applies the same per-pane
rule as `applyTopFraction`, one level down: middle row too short moves the middle-row panes `-D`;
middle row too tall moves the bottom-row panes `-U`; geometry is re-read before each pane, sub-pixel and
wrong-sign deltas are skipped, and it is best-effort, with a stderr line on a refused resize. At `1/2`
the two observer rows end equal, so with the collator at `1/3` every row is a third of the container.

The first pass has to run first: moving the collator's border redistributes the lower region
proportionally across both observer rows, because each full-width row is a subtree of one vertical
split, so the second pass has to run after it to see the settled region rather than the one it was
planned against.

Whether the live boundary actually lands at thirds is not yet measured the way the width fraction was
on 2026-09-13; §9's remaining question is verifying this live.

### 4.4 Width: one function, more rows

`applyBottomWidths` corrects widths only in the row sharing the LARGEST `y`; with two observer rows
only the lower one would be corrected today. It generalizes to loop over every distinct `y` group
holding two or more panes, applying the same left-to-right, one-border-at-a-time correction to each.
Backward compatible by construction: review has exactly one such row. `TRIAGE_OBSERVER_WIDTH_FRACTION`
stays `1/3`, since each row still holds three panes.

## 5. Design: roster, aspects, per-kind partitioning

`DEFAULT_TRIAGE_WORKERS` becomes the seven ids in §4.2's CREATION order: `tri-1`, `obs-t1`, `obs-td1`,
`obs-t2`, `obs-t3`, `obs-td2`, `obs-tv1`. `TRIAGE_CONSOLE_ROSTER.reviewers` becomes the six observer ids
in the owner's READING order: `obs-t1`, `obs-t2`, `obs-t3`, `obs-td1`, `obs-td2`, `obs-tv1`.
`TRIAGE_CONSOLE_ASPECTS` gains three entries, also in reading order. The k8s aspects keep their existing
names (`slice1`/`slice2`/`slice3`); the three new entries get their own prefix, `docker1`, `docker2`,
`vm1`, rather than continuing the `slice` sequence, so a task id like `T-sweep-7-docker1` says which
kind it covers on its own.

`AspectSeat` stays exactly `{worker, aspect}`, shared unchanged with the review console (D2). A seat's
kind lives in a new, triage-only lookup keyed by worker id, consulted by the partition check and the
reply reader (§7); keeping it out of the shared type means review's aspects need no schema change.

Partitioning becomes three independent checks per sweep, one per kind, each against its own declared
inventory (§6): k8s unchanged (`obs-t1..3` split the environment's services, ceil(N/3) each); docker
(`obs-td1`/`obs-td2` split the five named containers, three and two); vm (`obs-tv1` gets every declared
unit and every whole-system check, one seat, no split, though `checkTriagePartition` still runs since
an empty or partial claim is still worth catching).

`checkTriagePartition`'s counting needs no change; it already takes a declared set and a list of
assignments and works for any width. It gains a `context: {kind, width}` argument used only in its
refusal text, so `partition_duplicate` names "3 requests wide, for k8s" or "2 requests wide, for
docker" instead of a hardcoded three. The three checks run in a fixed order (k8s, docker, vm); the
first refusal stops the sweep, so `PartitionFault` stays a single value.

`roles/triage.md:83-107` is rewritten for three kinds: "one observer" becomes "one observer per kind,"
and a new sentence states a k8s service, a docker container and a VM unit never share a request. The
"## The seats" block needs no code change, only the data behind it growing to six.

## 6. Design: extending the target inventory with a kind

`TriageEnvironmentSchema` (`triage-targets.ts:206-`) gains an optional `kind` field,
`"k8s" | "docker" | "vm"`, defaulting to `"k8s"` when absent so today's file parses unchanged. The
three shapes differ enough (`kube_context` versus a target token, a different closed `checks`
vocabulary) that a discriminated union on `kind` is the cleanest fit: a loader-side preprocessing step
fills in the default `kind` before the union discriminates, then three sibling schemas replace the
single one. The duplicate-service-name check stays shared across all three, since incident state keys
on the service name within its own environment regardless of kind.

```yaml
version: 1
environments:
  do-cluster:
    kind: k8s               # optional; absent means k8s, unchanged from today
    kube_context: do-cluster
    default_window: 5m
    services: [...]         # unchanged: TRIAGE_CHECKS enum, namespace required
  docker-host:
    kind: docker
    target: docker           # the OBSERVER_DOCKER_TARGETS token, not a kube_context
    default_window: 5m
    services:
      - {name: grafana,          namespace: docker, checks: [state, health, logs]}
      - {name: grafana-renderer, namespace: docker, checks: [state, health, logs]}
      - {name: prometheus,       namespace: docker, checks: [state, health, logs]}
      - {name: cadvisor,         namespace: docker, checks: [state, health, logs]}
      - {name: node_exporter,    namespace: docker, checks: [state, health, logs]}
  vm-host:
    kind: vm
    target: vm                # the OBSERVER_VM_TARGETS token
    default_window: 5m
    services:
      - {name: vm-1, namespace: vm, checks: [system, units, resources],
         units: [docker.service, ssh.service, systemd-journald.service]}
```

- **`kube_context` is required only on a k8s environment; docker and vm environments carry `target`
  instead**, the enrolled SSH token their own `OBSERVER_DOCKER_TARGETS`/`OBSERVER_VM_TARGETS` secret
  already names. Each is still `.strict()`, so a k8s field on a docker environment, or vice versa, is
  refused at load.
- **`checks` is a different closed enum per kind.** k8s keeps `TRIAGE_CHECKS`. Docker's is
  `[state, health, logs, stats, events]`, matching `observer-docker-ops`'s own vocabulary; rows default
  to `[state, health, logs]`, the skill's own default when a brief omits `checks`. VM's is
  `[reachability, system, units, logs, resources, cloud]`; the vm-host row fixes it to
  `[system, units, resources]` per owner decision, covering the five whole-system verbs (`uptime`,
  `system`, `failed`, `disk`, `memory`) plus the three named units.
- **`units[]` is new, vm-only**: zero or more systemd unit names, the observer's own grammar
  `^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$`, at most 255 bytes each, bounded the way
  `MAX_SERVICES_PER_ENVIRONMENT` bounds a k8s service list.
- **`namespace` on a docker or vm row carries that environment's `target` token**, matching what the
  observer's own artifact echoes back, so the collator's reconciliation compares like against like.

### 6.1 Replacing `soleEnvironment`

`soleEnvironment` refuses anything other than exactly one declared environment. With three kinds
possibly present at once, it is replaced by a kind-aware function (working name `environmentsByKind`)
requiring exactly one k8s environment (preserving today's "at least one, not two," scoped to k8s) and
at most one docker and at most one vm. `triage.ts:1298`'s call site and the
`triage-command.test.ts:2172-2174` pins move to it. Downstream, `sweepProducers`'s
`openSweep`/`dispatchObserver` (today one `deps.environment`) and `triage-pass.ts`'s `settle()` (today
one `ConsoleEnvironmentFacts` element) widen to loop over whichever kinds are present, one dispatch
pass and one facts entry per kind, the seam §2 notes `ConsoleHealthFacts.environments` already left
open as an array.

## 7. Design: reading a reply per kind

Unchanged from this document's own earlier default (owner decision 8): `parseObserverArtifact`,
`readObserverArtifactAt` and the `joinSweep` loop gain a filename parameter, resolved per seat from
§5's kind lookup: `observer-ops.json` for k8s, `observer-docker-ops.json` for docker,
`observer-vm-ops.json` for vm. `sweepIdEcho` and `windowEcho` need no change; they compare plain strings
against whatever `ObserverReply` the reader hands them. `joinSweep`'s read of the module constant
`TRIAGE_CONSOLE_ASPECTS` at `:2001` switches to the resolved `pairs` its sibling functions already use,
closing the gap §2 notes.

`observerTuiWorkers` currently matches only `OBSERVER_K8S_ROLE`. Once `obs-td1`, `obs-td2` and
`obs-tv1` run `pane_mode: tui` on a console, the hazard it warns about (an unadopted tui pane allocating
no epoch, so a re-dispatched pass runs the same task twice) is no longer k8s-specific, and it
generalizes to match all three observer roles.

## 8. Recorded decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Triage's layout is a dedicated, hardcoded seven-pane table local to `triagePanes`, not a parameter on `collatorOverRowPanes`. `reviewPanes` and its builder are untouched. | Two full-width rows are a different shape from a longer single row; the shared builder cannot express it at any pane count. |
| D2 | `AspectSeat` stays `{worker, aspect}`; a seat's kind lives in a separate, triage-only lookup. | Keeps `REVIEW_CONSOLE_ASPECTS` and its schema untouched. |
| D3 | `DEFAULT_TRIAGE_WORKERS`'s array order is pane CREATION order, which differs from the owner's stated READING order; `TRIAGE_CONSOLE_ASPECTS`/`TRIAGE_CONSOLE_ROSTER` stay in reading order. | A full-width second row can only be split off before its row's own columns exist; creation order and reading order cannot both be satisfied by one array here. |
| D4 | `applyTopFraction`'s shrink branch narrows to the row directly beneath the top row; a second, gated pass (`applyMiddleRowFraction`) splits the two observer rows evenly. | The old shrink resized every lower pane against a one-row target, which crushes the collator with two rows below; narrowing keeps one-lower-row consoles' command sequence, and the second pass reuses the same per-pane rule one level down. |
| D5 | Row width correction generalizes from "the single bottom row" to "every row with two or more panes." | Backward compatible: review still has exactly one such row. |
| D6 | `TRIAGE_OBSERVER_WIDTH_FRACTION` stays `1/3`. | Each row still holds three panes. |
| D7 | k8s aspects keep their `sliceN` names; new seats get `dockerN`/`vmN`. | `obs-t1..3`'s task ids should not move; the new prefix makes a task id legible about its kind. |
| D8 | Partitioning runs once per kind, in a fixed order (k8s, docker, vm); the first refusal stops the sweep. | A container must never land in a k8s observer's request or vice versa, and `PartitionFault` stays a single value. |
| D9 | The docker/VM inventory extends `triage/targets.yaml` with an optional `kind` field, discriminating the environment's shape, rather than a second file. | Owner decision 7; today's file parses unchanged when `kind` is absent. |
| D10 | `soleEnvironment`'s one-environment refusal is replaced by a kind-aware check: exactly one k8s, at most one docker, at most one vm. | The mixed design needs up to three environments declared at once; `ConsoleHealthFacts.environments` already expected an array. |
| D11 | The reply reader resolves a filename per seat's kind, rather than docker/vm also writing `observer-ops.json`. | Keeps the distinct `schema` literals harvest already validates. |
| D12 | `sweep_id`/`window_opened_at` freshness gates apply uniformly across all three kinds. | Owner-confirmed; both new schemas already require the keys, nullable. |
| D13 | `observerTuiWorkers` generalizes to all three observer roles. | Owner-confirmed; an unadopted tui pane re-runs a re-dispatched task regardless of role. |
| D14 | `obs-d1`/`obs-v1` are untouched by this document. | Owner decision 3. |
| D15 | Docker's two seats split five containers three and two; the VM's one seat takes its whole declared set. | Owner decisions 4 and 5. |
| D16 | `run.max_concurrent` becomes 12 in both configs. | Owner decision 6, not derived from seat-count arithmetic. |
| D17 | VM checks fix to `[system, units, resources]` plus three named units; docker rows default to `[state, health, logs]`. | Owner decision 5 for the VM; the docker default matches the skill's own default when a brief omits `checks`. |

## 9. Open questions

| # | Question | Recommended default | Reasoning |
|---|---|---|---|
| Q1 | Do the two observer rows actually land at equal thirds of height, and is a third-width, third-height pane legible? | Proceed with the §4.3/§4.4 design, verify visually at the live host task | The width correction was measured live once before (2026-09-13, single row); the new row-height pass has not been, and this console runs unattended, so the first real look at it is the host task that recreates it. |

## 10. Acceptance criteria hooks

- **Layout:** `triagePanes` builds exactly seven panes in the shape of §4.2's table and refuses any
  other count; `reviewPanes` still refuses a fifth, unchanged.
- **Roster:** `TRIAGE_CONSOLE_ROSTER.reviewers`, `DEFAULT_TRIAGE_WORKERS` and both configs' `role:`
  entries agree as a SET (not an order, per D3).
- **Inventory:** `triage/targets.yaml` validates with three environments, one per kind; a k8s field on
  a docker environment, or vice versa, is refused by `.strict()`.
- **Partition:** a k8s service claimed by a docker seat's request is refused, and vice versa; an
  incomplete or duplicated claim within one kind is refused, naming that kind.
- **Reply reading:** a docker or vm seat's artifact is present in the joined sweep's replies, not
  silently absent as it is today.
- **Freshness:** a null `sweep_id` from a docker or vm seat grades `stale_replay`, exactly as it does
  for a k8s seat today.
- **Concurrency:** `config validate` passes with `max_concurrent: 12` and seven declared triage seats.
- **Live:** one real sweep produces a collated document with rows from k8s, docker and vm, each read
  from its own seat's reply file, and no partition refusal.

## 11. Implementation Checklist

**Shaped for `/ProjectManager` on one long-lived branch.** Each phase closes with local typecheck, the full `bun test test/unit` suite and a review fix loop capped at three iterations; no PR, CI or push until the branch is ready to merge. At most
two tasks per engineer per round. Host tasks are marked `(host)` and are never dispatched to an
engineer.

### Phase table

| Phase | Slug | Deliverable | Depends on |
|---|---|---|---|
| 1 | `triage-two-row-layout` | Seven-pane, two-row builder; height and width corrections generalized | (none) |
| 2 | `triage-mixed-roster` | Six-seat roster, aspects, new seats in both configs, `max_concurrent: 12` | 1 |
| 3 | `triage-targets-kind` | `triage/targets.yaml` gains `kind`; `soleEnvironment` replaced | 2 |
| 4 | `triage-mixed-partition` | Per-kind completeness check; `roles/triage.md` rewritten | 3 |
| 5 | `triage-mixed-reader` | Collator reads all three artifact filenames; tui warning generalized | 3, 4 |
| 6 | `triage-mixed-live` | Recreate the console at seven panes, one live sweep across all three kinds | 1-5, and observer SRD 6.H3/6.H4 |

---

### Phase 1: two-row layout (`triage-two-row-layout`)

**Goal.** `triagePanes` builds §4.2's seven-pane table over synthetic worker ids, not yet the real
roster. `applyTopFraction`'s shrink branch narrows to the row directly beneath the top row, the second
height pass (`applyMiddleRowFraction`) lands, and `applyBottomWidths`'s generalization lands, tested
against review's and operations' one-lower-row command sequences as a regression guard. Does not touch
`DEFAULT_TRIAGE_WORKERS`, the roster, or any config file.

- **1.1** Replace `triagePanes`'s body with §4.2's own seven-entry table (no longer calling
  `collatorOverRowPanes`). Refuse any `--workers` count other than seven, naming the console. Files:
  `operations-plan.ts`. Acceptance: `bun test test/unit/triage-plan.test.ts` (rewritten for seven
  synthetic ids) and `bun test test/unit/review-plan.test.ts` unchanged and green.
  Revert check: pass seven workers in the OLD flat-row order; the pane-order assertions catch a single
  wide row where two were expected.
- **1.2** Narrow `applyTopFraction`'s shrink branch to the row directly beneath the top row (§4.3). Add
  the second height-correction pass, `applyMiddleRowFraction`, gated on the new optional
  `middleRowFraction` field that only `TRIAGE_SPEC` sets. Generalize `applyBottomWidths` to loop over
  every row with two or more panes (§4.4). Files: `operations.ts`, `operations-plan.ts` (the constant),
  `test/unit/operations-geometry.test.ts`, `test/unit/operations-workspace.test.ts`.
  Acceptance: `bun test test/unit/operations-geometry.test.ts test/unit/operations-workspace.test.ts`.
  Revert check: reverting the shrink branch to resize every lower pane, removing the second pass's call
  from `createWorkspace`, or setting `middleRowFraction` on a one-lower-row console each reddens the
  geometry suite.

Round plan: single engineer, two sequential tasks (1.2 also touches its own test files).

---

### Phase 2: six-seat roster and config (`triage-mixed-roster`)

**Goal.** `DEFAULT_TRIAGE_WORKERS` (creation order), `TRIAGE_CONSOLE_ROSTER.reviewers` and
`TRIAGE_CONSOLE_ASPECTS` (reading order) all name six observers. `obs-td1`, `obs-td2`, `obs-tv1` exist
in both configs, `pane_mode: tui`, in no console but this one. `max_concurrent` is 12 in both files.
Does not add the target inventory or change partition/reader logic (Phases 3-5).

- **2.1** Set `DEFAULT_TRIAGE_WORKERS` (`operations-plan.ts:1336-1341`) to §4.2's seven ids in creation
  order. Update the pins at `triage-plan.test.ts:165` and `:175`. Files: `operations-plan.ts`,
  `triage-plan.test.ts`. Acceptance: `bun test test/unit/triage-plan.test.ts`.
- **2.2** Extend `TRIAGE_CONSOLE_ROSTER.reviewers` (`dispatch-request.ts:463`) to the six ids in
  reading order. Add `docker1`, `docker2`, `vm1` to `TRIAGE_CONSOLE_ASPECTS` (`task-ids.ts:165-196`).
  Update the pins at `triage-role.test.ts:534` and `dispatch-request.test.ts:1678-1702` (kept as a
  sorted set-equality check, per D3). Files: `dispatch-request.ts`, `task-ids.ts`, both test files.
  Acceptance: `bun test test/unit/dispatch-request.test.ts test/unit/triage-role.test.ts`.
- **2.3** Add `obs-td1`, `obs-td2` (`role: observer-docker`) and `obs-tv1` (`role: observer-vm`) to
  `fleet.example.yaml`'s triage `workers:` block, each `pane_mode: tui`. Bump `max_concurrent` (`:103`)
  to 12. Files: `fleet.example.yaml`. Acceptance: `bun run src/cli/index.ts config validate --config
  fleet.example.yaml`.
- **2.4** The same three seats and the `max_concurrent` bump (`:92`) in the live `fleet.yaml`. Fix the
  stale "the pair" comment at `console-relay.ts:546-555`. Files: `fleet.yaml`, `console-relay.ts`.
  Acceptance: `bun run src/cli/index.ts config validate --config fleet.yaml`; `bun test test/unit`.

Round plan: R1 eng-1 2.1, eng-2 2.2. R2 eng-1 2.3, eng-2 2.4. No conflicts:
`fleet.example.yaml`/`fleet.yaml` each touched once.

---

### Phase 3: target inventory kind (`triage-targets-kind`)

**Goal.** `triage/targets.yaml` can declare a k8s, docker or vm environment; `soleEnvironment` is
replaced by a kind-aware check; downstream single-environment assumptions widen to loop by kind. Does
not change partition logic or the reply reader (Phases 4-5).

- **3.1** Add `kind` to `TriageEnvironmentSchema`, defaulting to `"k8s"`, and split it into a
  discriminated union of three sibling schemas per §6 (k8s unchanged, docker with `target` and its own
  `checks` enum, vm with `target`, `units[]` and its own `checks` enum). Keep the shared duplicate-name
  check. New tests for each kind's required fields and for `.strict()` refusing a k8s field on a docker
  environment. Files: `triage-targets.ts`, `triage-targets.test.ts`.
  Acceptance: `bun test test/unit/triage-targets.test.ts`. Revert check: today's unmodified
  `triage/targets.yaml` still parses, as a k8s environment.
- **3.2** Replace `soleEnvironment` with a kind-aware `environmentsByKind` per §6.1: exactly one k8s,
  at most one docker, at most one vm. Move `triage.ts:1298`'s call site and the
  `triage-command.test.ts:2172-2174` pins onto it. Files: `triage.ts`, `triage-command.test.ts`.
  Acceptance: `bun test test/unit/triage-command.test.ts`.
- **3.3** Widen `sweepProducers`'s `openSweep`/`dispatchObserver` and `triage-pass.ts`'s `settle()` to
  loop the kinds `environmentsByKind` returns, one dispatch pass and one `ConsoleEnvironmentFacts`
  entry per present kind. Files: `triage-envelope.ts`, `triage-pass.ts`, their tests.
  Acceptance: `bun test test/unit/triage-envelope.test.ts test/unit/triage-pass.test.ts`.
- **3.4** Write `docker-host`/`vm-host` into the tracked `triage/targets.yaml` per §6's worked example,
  five containers and the VM's fixed checks and named units. Files: `triage/targets.yaml`.
  Acceptance: `bun run src/cli/index.ts config validate --config fleet.yaml` (the targets file is
  validated in the same pass).

Round plan: R1 eng-1 3.1 solo (3.2 and 3.3 both need its schema; pair only if eng-2 codes against a
stub and reconciles at review). R2 eng-1 3.2, eng-2 3.3. R3 eng-1 3.4 (small, single task).

---

### Phase 4: per-kind partition (`triage-mixed-partition`)

**Goal.** Three independent completeness checks per sweep, each named correctly in its refusal.
`roles/triage.md` rewritten for three kinds. Does not touch the reply reader (Phase 5) or run against a
real target (Phase 6).

- **4.1** A small worker-id-to-kind lookup for the six triage seats. Change the call site that invokes
  `checkTriagePartition` once per sweep to invoke it once per kind (k8s, then docker, then vm),
  stopping at the first refusal. Add the `context: {kind, width}` argument to `checkTriagePartition`
  and rewrite its `:309` refusal text to use it. Files: the new lookup module, `triage-partition.ts`,
  its caller, its test. Acceptance: `bun test test/unit/triage-partition.test.ts`.
  Revert check: a docker container fed into the k8s kind's declared set still reports
  `partition_incomplete` for k8s rather than being silently accepted.
- **4.2** Wire the per-kind inventory from Phase 3 into the triage CLI actor; refuse to start a sweep
  if a seat's kind has no matching environment. Files: the triage command module.
  Acceptance: `bun test` on the actor's existing test file.
- **4.3** Rewrite `roles/triage.md:83-107` for three kinds per §5's closing paragraph. Files:
  `roles/triage.md`. Acceptance: `bun test test/unit/worker-docs-currency.test.ts` if it covers this
  file, otherwise a manual read-through noted in the phase report.

Round plan: R1 eng-1 4.1, eng-2 4.2. R2 eng-1 4.3 (small, single task).

---

### Phase 5: reading a reply per kind (`triage-mixed-reader`)

**Goal.** The collator's joined sweep includes docker and vm replies, read from their own filenames.
Freshness gates apply to both. The tui warning covers all three observer roles. Does not change
harvest's own validation (`src/harvest/reconcile.ts`), which already covers both new artifacts.

- **5.1** Add a filename parameter to `parseObserverArtifact`, `readObserverArtifactAt` and the
  `joinSweep` loop, resolved per seat from Phase 4.1's kind lookup. Switch `joinSweep`'s read of
  `TRIAGE_CONSOLE_ASPECTS` to the resolved `pairs` its sibling functions already use. Files:
  `triage-envelope.ts`. Acceptance: `bun test test/unit/triage-envelope.test.ts`.
  Revert check: hardcoding `OBSERVER_ARTIFACT_FILE` back into the docker/vm path reddens a new test
  asserting a docker seat's reply appears in the joined sweep.
- **5.2** A test per new kind that a null `sweep_id`/`window_opened_at` grades `stale_replay`/
  `stale_window` exactly as it does for a k8s seat today. Generalize `observerTuiWorkers`
  (`schema.ts:2010-2019`) to match all three observer roles. Files: `triage-envelope.ts`'s test,
  `schema.ts`, `config.test.ts`. Acceptance: `bun test test/unit/triage-envelope.test.ts
  test/unit/config.test.ts`.
- **5.3** One-line updates to `Docs/SRD-OBSERVER-ROLES.md` section 4.5 and D4 noting this document
  supersedes them for the three new triage-only seats. Files: `Docs/SRD-OBSERVER-ROLES.md`.

Round plan: R1 eng-1 5.1, eng-2 5.2. R2 eng-1 5.3 (small, single task).

---

### Phase 6: the live probe (`triage-mixed-live`)

**Goal.** The docker host and VM are actually reachable, the console runs at seven panes, and one real
sweep produces a collated document covering all three kinds. All host work; nothing here is dispatched
to an engineer.

- **6.H1** `(host)` Confirm `Docs/SRD-OBSERVER-ROLES.md` host tasks 6.H3 and 6.H4 closed on evidence.
  Run `config validate` on `fleet.yaml`.
- **6.H2** `(host)` Rebuild any toolchain image whose build context changed. None is expected from
  Phases 1 through 5, since no Dockerfile is touched; confirm rather than assume.
- **6.H3** `(host)` Recreate the triage console. Run `status --all --json` and confirm all seven seats
  are live.
- **6.H4** `(host)` Trigger one sweep. Confirm the collated document carries rows sourced from k8s,
  docker and vm, each read from its own seat's reply file, with no `partition_incomplete`/
  `partition_duplicate` for any kind. Look at the running console and confirm Q1: whether the two
  observer rows land at equal thirds and are legible; if not, the fallback is a taller terminal window,
  not a third row.

---

## 12. References

- `Docs/SRD-OBSERVER-ROLES.md`: roles, credentials and artifact schemas reused unchanged; sections 5-7
  target-side grammars and enforcement; host tasks 6.H3/6.H4, which Phase 6 depends on.
- `Docs/SRD-TRIAGE-CONSOLE.md`: §6.2 the service registry pattern extended per kind; §6.5 the fan-out
  arithmetic generalized; §12 the one-environment limit §6.1 replaces.
- `src/backends/cmux/operations-plan.ts`, `operations.ts`: pane layout, roster and width/height
  constants. `src/run/dispatch-request.ts`, `src/run/task-ids.ts`: console roster and aspect constants.
- `src/run/triage-envelope.ts`, `triage-pass.ts`, `triage-incident.ts`: sweep envelope, artifact
  reader, freshness gates, console-level facts. `src/run/triage-partition.ts`: the completeness check.
- `src/run/triage-targets.ts`, `triage/targets.yaml`: the registry this document extends with `kind`.
  `src/cli/commands/triage.ts`: `soleEnvironment`, replaced per §6.1.
- `src/harvest/observer-target-artifacts.ts`: the two artifact schemas harvest already validates.
  `roles/triage.md`: the collator's own instructions, rewritten in Phase 4.
- `fleet.yaml`, `fleet.example.yaml`: role and seat configuration.
- `skills/observer-docker-ops/SKILL.md`, `skills/observer-vm-ops/SKILL.md`: check vocabularies and
  input grammars §6 draws its docker/vm schema from. `.claude/skills/fleet/SKILL.md`,
  `Workflows/EnrolTarget.md`: the operator runbook Phase 6 uses.
