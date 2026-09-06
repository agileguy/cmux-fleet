# Collated review — T-rv-p6 (Phase 6 dogfood: the §9.1 fetch-and-merge amendment)

Coverage: 3 of 3 lenses reported, and all three reviews reached me complete — no truncation, no unreadable envelopes. Every finding below names the lens that raised it.

The task's core question — *is the amendment true of this repository's actual mechanisms, and would an operator reading §9.1 alone be led into an unsafe merge?* — is answered **yes, it would**, by two independent lenses, and the strongest finding is the one they both reached.

---

## Consensus (2 of 3 lenses, independent)

### 1. "merge with hooks and attribute drivers disabled" is false for the attribute-driver half — and the code is more honest than the amendment

Raised independently by **rev-arch-1** and **rev-lang-1**.

The amendment (`Docs/SRD.md:1647`) claims the merge runs "with hooks and attribute drivers disabled." The code (`src/run/pm-integration.ts:365-367`) passes `-c core.hooksPath=/dev/null -c core.attributesFile=/dev/null`. The hooks half works. The attributes half does not: `core.attributesFile` names an *additional* global attributes file, so redirecting it does nothing to the repository's own tracked `.gitattributes` or `.git/info/attributes`. A `filter=` driver already resident in the base still runs its smudge/clean on worker-authored files during the merge checkout.

Both reviewers note the code itself concedes this: the module's docblock (`pm-integration.ts:49-66`) reproduces a live experiment, the ISC-536 test (`test/unit/pm-integration.test.ts:509-536`) pins the false half as a named assertion, and the workflow skill repeats the caveat. The amendment alone omits it. The residual is bounded — a driver *assignment* cannot arrive via the merge, because part 2 refuses any `.gitattributes` touch — but the sentence as written is false.

This is the strongest signal in the review: two vendors, two different angles (security framing vs. runtime semantics), same conclusion, both quoting the same code and the same test.

---

## Divergence (not a contradiction — different questions)

**rev-ctx-1** concluded "no findings requiring correction" and verified all cross-references as accurate. That is **not** a disagreement with the finding above: ctx's brief was to check that the cross-references *exist and point at the right files* (§9.2 erratum, §9.3 "pifleet never merges", §10 `worktrees --json`, SRD-FLEET-PM-001 §6.2.1, `pm-integration.ts`), and to judge the bookkeeping files against the range — not to test whether the amendment's security claims are *true*. On that question it found everything present and consistent.

One point to flag: ctx's §6.2.1 verification lists "Merge with hooks and attributes disabled" as part of the gate spec and marks it MET, without noting that the "attributes disabled" clause is the same false claim arch and lang both found. That is a coverage gap in ctx's review (it verified the reference is correct, not that the referenced text is true), not a contradiction. Nothing to settle — the two findings answer a different question than ctx was asked.

---

## Singles, ranked by consequence

### 2. The amendment's step 3 is an ungated merge, and §9.1 never routes the operator to the gate — rev-arch-1 (Tier 1)

The amendment's only concrete commands (`Docs/SRD.md:1645`) are `git fetch worker-<id> <branch>` and `git merge --no-ff` — bare git, no `-c` flags, no inspection, no re-scan. The gate is `mergeWorkerBranch` (`pm-integration.ts:328`), a library function with no CLI verb and no production caller; only the workflow skill (`ProjectManager.md:231-244`) reaches it, and §9.1 does not reference that skill. An operator reading §9.1 alone has exactly one set of commands, and they are the ungated merge — hooks live, attribute drivers live, no hazard inspection, no re-scan. This is the direct answer to the task's core question.

### 3. The inspect step can be bypassed by any hazard path git quotes in the listing — rev-lang-1 (Tier A)

`git diff --name-only` at `pm-integration.ts:270` is run without `-z` (and without `core.quotePath=false`). Git C-quotes paths containing non-ASCII or control bytes, so a worker branch adding e.g. `.github/workflows/deploy-café.yml` or a `.pi/` path with a tab produces a listed line beginning with `"`, and every `startsWith`/`endsWith` hazard rule misses. Part 2 reports a clean tree and the merge materialises a file in exactly the class the gate exists to refuse. The repo's own precedent is `worktree.ts`'s `ls-tree -r -z` (NUL-split), used for precisely this reason. This is the one place where the shape of the gate's input is controlled by the party being gated.

### 4. "Inspect before materialising" covers only six path classes; the rest is caught after — rev-arch-1 (Tier 2)

Part 2 (`pm-integration.ts:134-140`, `HAZARD_PATH_CLASSES`) refuses six classes (AGENTS.md, CLAUDE.md, `.pi/**`, `.agents/skills/**`, `.gitattributes`, `.github/workflows/**`). But `neutralizeRepoHazards` (part 4) scans more — `.mcp.json`/`.pi/mcp.json` (`repo-hazards.ts:76`) and `.pi/settings.json` (line 94). A worker branch adding those is not refused before materialisation; it lands in the operator's tree and is only neutralized after. The amendment's prose reads as if the whole incoming tree is inspected before materialisation; it is not. The design is defensible (refuse the worst before, neutralize the rest after) but the limitation is unstated.

### 5. "Fetch freely" reasons only about the operator's side of the wire — rev-lang-1 (Tier B)

A local-path fetch also runs the server side of the transfer against the worker's clone, whose `.git/config` the worker can rewrite for the whole run (the up-time scan predates the worker; part 4 scans the checkout, never the clone). `repo-hazards.ts:163` itself names `uploadpack.packObjectsHook` as a key class. The scan-timing gap is certain; whether that specific key is honoured on local-path fetches is a suspicion the reviewer could not verify without a live git run. Cheap mitigation: a read-only `detectRepoHazards` pass on the clone before the fetch.

### 6. FETCH_HEAD is one mutable file shared by every fetch — rev-lang-1 (Tier B)

`pm-integration.ts:333-337` fetches then `rev-parse FETCH_HEAD`. The immediate capture defends only against this module's own next fetch; any concurrent fetch (operator's terminal, a second scratchpad script) between fetch and rev-parse swaps the SHA, and the gate then inspects, merges and records the wrong head under this worker's task_id. Fix: fetch into an explicit destination ref, or verify FETCH_HEAD's first line names the requested branch.

### 7. The merge-failure cleanup swallows its own failure — rev-lang-1 (Tier B)

`pm-integration.ts:377` runs `merge --abort` with `.catch(() => {})`, neither inspecting nor reporting the abort's result. If the abort fails (index.lock contention, EPERM), the checkout can be left mid-conflict with a live MERGE_HEAD while the outcome reports `merge_failed` and the note says nothing. Contrast `worktree.ts`'s rollback, which documents its swallow.

### 8. A failed `rev-list --count` becomes `commits_ahead: 0` — rev-lang-1 (Tier C)

`pm-integration.ts:343-344` (nonzero exit → NaN) and 521 (`Number.isFinite(...) ? ... : 0`). A git failure on the count is indistinguishable in the record from "zero commits ahead" — the exact NaN-or-0 shape `worktree.ts`'s `inspectCloneDirt` explicitly refuses to ship.

### 9. The "must be sitting ON the integration branch" precondition is docblock-only — rev-lang-1 (Tier C)

`pm-integration.ts:295-296` asserts the precondition in a docblock; the merge path verifies nothing about HEAD or the working tree. A dirty tree merges whenever paths don't overlap, interleaving worker content with the operator's uncommitted edits.

### 10. "The first outbound path in this system" is imprecise — rev-arch-1 (Tier 3)

The harvest/outbox path (worker artifacts → host run directory) is also outbound and predates the merge. The substantive claim — the merge is the first time worker-authored files land in the operator's *checkout*, where the operator's git identity and credentials live — is accurate; the wording overstates it.

---

## What the amendment gets right (for the record)

Both arch and lang independently confirmed the parts that DO match the code: "fetch freely" (fetch writes no working-tree file, runs no filter), the three-dot `diff <base>...<head>` form (correct "what the worker changed since merge base" semantics, pinned both directions), and "re-scan after every merge" (part 4 runs `neutralizeRepoHazards` after every merged outcome, before anything reads the checkout). Hooks ARE disabled by a real mechanism. The merge does run in the operator's checkout with the operator's identity inherited.

---

## What was not covered

- **No lens was missing**: 3 of 3 reported, all complete (no truncation, no unreadable envelopes).
- **rev-ctx-1 named its own edge**: it could not run git commands directly, so its range verification rests on the bookkeeping files and visible repo state, not on a `git log`/`git diff` of the range. Its cross-reference and bookkeeping conclusions are complete; its "does the range show what was done" check is bookkeeping-consistency only.
- **rev-lang-1 named its own edge**: the F5 exploit detail (whether `uploadpack.packObjectsHook` is honoured on local-path fetches) needs a live git run it could not perform; the scan-timing gap is certain, the specific key is a suspicion.
- **The two bookkeeping files were read by ctx only**; arch and lang did not examine them (their briefs were the amendment and the code). No lens independently re-derived the git range from the object store.
