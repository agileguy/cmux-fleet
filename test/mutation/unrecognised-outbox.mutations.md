# Mutation results — can the console tell an empty outbox from a full one

Run: 2026-09-04, `bun run test/mutation/unrecognised-outbox.battery.ts <throwaway>`

**22 mutations, 21 as expected, 1 survivor (M16, analysed below and left in
place deliberately).**

The battery runs four unit files against each mutation:
`collator-outbox-note.test.ts`, `harvest-task-outbox.test.ts`,
`harvest-task-outbox-wiring.test.ts`, and `collator-relay.test.ts` — the last so
that a mutation which *widens* the new clause onto an arm this change did not
touch is caught by the suite that owns that arm.

## The defect being measured

`rev-lang-1` produced a complete 12,759-byte review and wrote it to
`/outbox/R-rally-async-6-lang/artifact.json` — the task ROOT, under a name it
invented, carrying an invented `"schema": "pifleet.ticketops/v1"`. It wrote no
`result.json` and created no `files/`. The harvest reads exactly those two names,
so both of its readers missed it, and the collation brief said:

> MISSING ASPECT: lang (rev-lang-1) — it settled `unknown` and no report reached
> the collator.

Every word true, and the whole of what anyone was told.

## Where the throwaway tree came from

The battery header documents `git worktree add`. This run could not use one — the
agent executing it was itself confined to a git worktree and its harness refuses
`git` commands aimed outside that confinement. A plain `cp -R` of `src/` and
`test/` with `node_modules` and `docker/` symlinked was used instead. It gives
the same guarantee and slightly more: the copy has no `.git` at all, so no git
operation in it can reach the live checkout. The live checkout's five source
files were checksummed before the run and verified with `shasum -a 256 -c`
after it — all five `OK`.

## Results

| id | mutation | expected | got | |
|----|----------|----------|-----|---|
| M1 | THE LIVE DEFECT: the silent lens' note never mentions its outbox at all | red | fail | as expected |
| M2 | COINCIDING FIXTURES: only the EMPTY arm goes silent | red | fail | as expected |
| M3 | COUNT: the total becomes the length of the capped list | red | fail | as expected |
| M4 | TRUNCATION: the list is cut in silence | red | fail | as expected |
| M5 | FACTS: the size is dropped | red | fail | as expected |
| M6 | OVER-CLAIM: the disclaimer becomes "the review is in one of these" | red | fail | as expected |
| M7 | ADAPTER: the harvester's listing is dropped on the floor | red | fail | as expected |
| M8 | ADAPTER: silence manufactured into `empty` | red | fail | as expected |
| M9 | TAXONOMY WIDENED: the clause is appended to the `unreadable` arm | red | fail | as expected |
| M10 | RECOGNISED: `files/` stops being recognised | red | fail | as expected |
| M11 | BOUND: the cap is removed | red | fail | as expected |
| M12 | SYMLINK: a link stops being classified as one | red | fail | as expected |
| M13 | INJECTION: a worker-chosen name reaches the report unswept | red | fail | as expected |
| M14 | ORDER: the sort reverses | red | fail | as expected |
| M15 | SILENCE AS EVIDENCE: `unlistable` reported as `empty` | red | fail | as expected |
| **M16** | **TOCTOU: the stat's own type re-check is dropped** | **red** | **pass** | **SURVIVED** |
| M17 | WIRING: the discrepancy never emits | red | fail | as expected |
| M18 | WIRING: the listing is computed and never attached | red | fail | as expected |
| M19 | WIRING: the discrepancy fires for every listing | red | fail | as expected |
| N1 | NEGATIVE CONTROL: local binding renamed | green | pass | as expected |
| N2 | NEGATIVE CONTROL: entry-kind branches reordered | green | pass | as expected |
| N3 | NEGATIVE CONTROL: empty-list early return rewritten | green | pass | as expected |

`ALL FILES RESTORED OK: true`.

The baseline is asserted before any mutation is applied and the battery exits
non-zero if the unmutated tree is not green — a tree that was already failing
would report every mutation as caught while measuring nothing.

## The survivor: M16

```
-        bytes = st.isFile() ? st.size : null;
+        bytes = st.size;
```

**Left in place. It is a defence no unit test can reach, not an untested
feature, and the difference is the whole of the analysis.**

`readdir(withFileTypes)` types the entry, and the size is taken only where that
type is `file`. Reaching the discarded comparison requires the entry to STOP
being a regular file between the `readdir` that typed it and the `lstat` that
measures it — a worker replacing its own `artifact.json` with a directory, a
FIFO, or a symlink inside that window. Forcing that ordering needs a hook this
module does not have; for every input a test can construct the dirent and the
stat agree, so the two spellings are byte-identical in behaviour and the
mutation is a true no-op against the suite.

This is the same shape `harvest/outbox.ts` already records twice about itself —
its `realpath` containment check on the accept path ("deleting it leaves
`harvest-outbox.test.ts` at 40/40 green (measured, not assumed)") and its
read-time size bound ("reaching it requires the file to grow between the lstat
and the read"). The house answer in both cases is to keep the check and write
the silence down rather than delete a guard because a test cannot build its
input, and the code carries that note at the line.

**What is NOT weakened by this survivor.** The symlink property people actually
care about — that a link's target size is never published — does not rest on
this comparison at all. It rests on `kindOf` classifying the dirent as
`symlink` so the `lstat` is never reached, and on `lstat` rather than `stat` if
it were. M12 deletes the classification and the suite goes red; the symlink test
asserts `{kind: "symlink", bytes: null}` against a 4,096-byte target.

## What M2 is for, specifically

M2 is the guard against this branch's recurring probe defect — two fixtures in
which the states being distinguished coincide. It silences the `empty` arm
*only*. The empty-vs-unrecognised pair still differs after it, so a suite that
owned just that one pair would pass; what fails is the *second* asymmetric pair,
`an outbox checked and found bare does not read the same as one never checked`,
which exists purely to hold this line. Without that second pair M2 survives, and
an operator loses the ability to tell a verified-bare outbox from one nothing
ever listed — which is the ambiguity the whole change exists to remove.

## What is NOT covered

- **The `files/` scan itself.** This battery does not mutate `scanOutboxFiles`;
  `harvest-outbox.test.ts` owns it.
- **A real container writing to a real outbox.** Every fixture here is a
  temp directory. The live-defect *shape* is reproduced faithfully (no
  `result.json`, no `files/`, one invented name at the task root) but not the
  live *path*.
- **The collator's behaviour on reading the new clause.** That is a model's
  response to a prompt and no unit test asserts on it. What is pinned is that
  the sentence reaches the brief and what it does and does not claim.
