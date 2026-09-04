# Envelope attribution — what the console says when a report cannot be read

Companion to `test/mutation/envelope-attribution.battery.ts`. Twenty mutations,
run against `test/unit/collator-relay.test.ts` and
`test/unit/collator-relay-adapter.test.ts` inside a throwaway worktree.

**Result: 20/20 as expected — 17 reddened, 3 negative controls stayed green,
every file restored with a matching SHA-256.**

## The defect being measured

A live three-lens review lost a lens and blamed the wrong component. `rev-lang-1`
wrote a genuine 3906-byte review; its seat is regex correctness, so it quoted a
regex into a JSON string — `[\w\\-_]+` — and `\w` is not a valid JSON escape. The
envelope did not parse, the harvest settled `unknown`, and the collation brief
said the lens *"settled `unknown` and produced no report"*. The collation
recorded the same sentence and the result was `partial`.

The report existed. The failure was in transport. An operator reading `partial`
learned that a lens found nothing, when what was true is that a review was
sitting on disk and nothing could open it — a different instruction entirely.

**The fix is almost entirely PROSE**, which is exactly the kind of change a suite
can appear to cover without covering. That is why this battery exists.

## The direction that matters

The obvious probe asserts the unreadable case and stops. It is satisfied by an
implementation that prints the unreadable sentence for *every* missing lens —
which would be a console lying in a new direction with every assertion green.
`E4`, `E5` and `E13` are that direction: each makes the console MORE confident
rather than less, and each must redden. They do.

`E3` is the subtlest and is the live defect's own root: a transport that never
looked at an envelope has evidence for nothing, and the sentence it produces must
not claim the reviewer produced nothing. The live console made exactly that
inference from exactly that silence.

## The table

| ID | Mutation | Expected | Got |
|----|----------|----------|-----|
| E1 | The unreadable arm returns the live defect's own sentence | red | red |
| E2 | The note ignores the envelope — one sentence for every missing lens | red | red |
| E3 | Silence read as evidence: no envelope info still claims "produced no report" | red | red |
| E4 | Over-correction: the ABSENT lens borrows the claim that a file exists | red | red |
| E5 | Over-correction: a readable envelope that failed is called a lens that produced nothing | red | red |
| E6 | The path is dropped, so nobody can open the review that exists | red | red |
| E7 | The size is dropped, so an empty file reads like a lost review | red | red |
| E8 | The parser's own complaint is replaced by a shrug | red | red |
| E9 | The brief's unreadable block never emits | red | red |
| E10 | The block emits for every missing lens, so naming one means nothing | red | red |
| E11 | The summary count goes back to claiming the missing lenses produced nothing | red | red |
| E12 | The adapter drops the harvester's classification on the floor | red | red |
| E13 | The adapter turns `null` into manufactured evidence of an absent envelope | red | red |
| E14 | The adapter paraphrases the harvester's fields instead of carrying them | red | red |
| E15 | The state is not carried onto the lens, so only prose can tell them apart | red | red |
| E16 | The block is present and says nothing — the instruction is truncated away | red | red |
| E17 | The block stops saying the row is still `reported: false` | red | red |
| N1 | Negative control: the local binding is renamed | green | green |
| N2 | Negative control: a never-dispatched seat keeps the `null` it already had | green | green |
| N3 | Negative control: the block is reworded and every semantic clause survives | green | green |

## What the battery changed about the probes

`E16` was first written as a declared survivor, `N3`, on the argument that
pinning an instruction's wording is pinning a sentence. It ran green, and the
green was correct and useless: the block was present, counted once, and said
nothing. The remedy was not to pin the sentence but to pin its three SEMANTIC
clauses as short phrases — *"it was applied"*, *`"reported": false`*, *"re-run
the lens"* — which leaves the prose around them free. `N3` was then rewritten as
a genuine reword that preserves all three, and it stays green. That pair is the
evidence that the probes discriminate meaning rather than text.

## What this battery does NOT measure, stated plainly

- **Whether the harvester's absent/unreadable classification is correct.** That
  is `harvest-outbox-contract`'s, and its own asymmetric probe. Everything here
  takes the classification as a fixture value, so a harvester that reported every
  absent envelope as unreadable would leave all twenty of these as they are.
- **Whether the collator obeys the brief.** These read the bytes dispatched. The
  role file is graded by `collator-role.test.ts`; nothing grades the model.
- **The `\w` failure end to end.** No JSON is parsed anywhere in this battery.
- **The `present` arm in production.** `RelayHarvestView.unreadableEnvelope`
  surfaces one of the harvester's four outcomes, so the adapter cannot yet emit
  `absent` or `present`. `E4` and `E5` grade the core's vocabulary against
  injected fixtures, not a live path.

## Reproducing

```
git -C <repo> worktree add /tmp/wt HEAD --detach
ln -s "<repo>/node_modules" /tmp/wt/node_modules
# copy the working-tree versions of the files under test into /tmp/wt
bun run test/mutation/envelope-attribution.battery.ts /tmp/wt
```

Never against the live checkout: the fleet spawns containers by reading that
working tree, and a transient broken state there has cost a worker its spawn.
