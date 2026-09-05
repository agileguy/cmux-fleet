# Mutation battery — the lens nobody read

`test/mutation/harvest-recovery.battery.ts`, run 2026-09-05 against
`feature/harvest-recovery`.

## What it grades

ISC-517's chain had three links. Two were closed on the previous branch: a
relative artifact path is resolved rather than refused, and a refusal is a state
rather than a silence. This grades the third — the arm where the harvest itself
THROWS, and nothing at all is read.

Until this change the console recorded WHY that lens was lost and stopped there.
`envelope: null`, `outbox: null`, one sentence, and a review that may be sitting
complete in a directory nothing pointed at. The refused-envelope path next door
has carried an outbox listing all along, because its harvest SUCCEEDS and the
listing comes back with the bundle. The one case where nothing was read at all
was the one case that named nothing at all.

The fix is a listing taken at the moment of failure. `listTaskOutbox` needs the
worker's outbox directory and the task id and nothing else — not the inbox
envelope, not the epoch, not the worktree — so it can answer exactly when the
harvester could not. It rides back on `RelayHarvestError`, is appended to the
note, and becomes an instruction in the brief.

## Results

| id | mutation | expected | observed |
|----|----------|----------|----------|
| H1 | The failed harvest stops taking a listing | red | red |
| H2 | A listing that throws is reported as `unlistable` | red | red |
| H3 | The listing on the rejection is ignored by the core | red | red |
| H4 | The successful-harvest clause is reused | red | red |
| H5 | The `empty` arm stops pointing at the usual places | red | red |
| H6 | A listing that failed is dropped from the note | red | red |
| H7 | The harvest-failed block never emits | red | red |
| H8 | The block emits for every missing lens | red | red |
| H9 | The instruction is truncated away | red | red |
| H10 | A successful harvest is flagged as failed | red | red |
| N1 | Negative control: the block is reworded, semantics survive | green | green |
| N2 | Negative control: the listing call is destructured | green | green |

12 mutations, 0 unexpected, all files restored with checksums verified.

## The one worth reading twice

`H4` deletes nothing. It swaps the new clause for `outboxClause`, the one the
successful-harvest path already uses — the edit a reader makes on the reasonable
grounds that two clauses saying "here is what is sitting there" should be one.
**I wrote that version first.**

It reads perfectly and it inverts the meaning of `empty`. `listTaskOutbox`
filters the RECOGNISED names out, so `empty` means *no unexpected entries* — and
after a failed harvest the likeliest thing sitting unread is `result.json`
itself. The success-path clause renders `empty` as *"holds nothing besides what
the harvest already reads, so there is no other file to look in"*, which tells an
operator not to bother looking at the exact moment they should. `H5` and `H6`
grade the two arms it corrupts, one each.

`H10` runs the other way, which is the direction this repo keeps finding its own
defects in: it flags a SUCCESSFUL harvest as failed, so the block fires on lenses
that were read perfectly. A suite that only asserted the positive case is green
against it and against the right implementation alike.

## What this battery does NOT measure

- **Whether `harvestTask` throws for the right reasons.** Every probe here
  injects the throw. What makes a harvest fail is `harvest/index.ts`'s.
- **Whether the review is actually recoverable from the named files.** The
  listing reports names, kinds and sizes; nothing here opens anything, which is
  the same promise `harvest/task-outbox.ts` makes.
- **The collator's obedience.** These read the bytes dispatched. Nothing grades
  the model.

## Reproducing

```
git -C <repo> worktree add /tmp/wt HEAD --detach
ln -s "<repo>/node_modules" /tmp/wt/node_modules
# copy the working-tree versions of the files under test into /tmp/wt
bun run test/mutation/harvest-recovery.battery.ts /tmp/wt
```

Never against the live checkout: the fleet spawns containers by reading that
working tree, and a transient broken state there has cost a worker its spawn.
