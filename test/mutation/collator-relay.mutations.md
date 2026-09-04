# Collator relay — mutation table

What `test/unit/collator-relay-adapter.test.ts` actually catches, and what it
does not. Produced by `test/mutation/collator-relay.battery.ts`, which must be
pointed at a throwaway `git worktree` — it rewrites source files in place, and a
transient broken state in a live checkout is read by things that spawn
containers from the tree.

```sh
git worktree add /tmp/wt HEAD --detach
ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
bun run test/mutation/collator-relay.battery.ts /tmp/wt
```

The battery snapshots the worktree's own files at start-up, restores before and
after every mutation, and verifies the checksum each time. It refuses a path
ending in `/cmux-fleet`.

## Why this file is committed

Every previous round's evidence lived in session logs. A claim that a control
stayed green is worthless if nobody can re-run it, and a battery that reddens on
everything reports itself as a triumph unless the greens are written down beside
the reds. Both halves are here.

## Reds — the mutation changes behaviour and a test catches it

| # | Mutation | Catches |
|---|---|---|
| I1 | Artifact contents not attached to the reply | The reply carries a digest of a file the collator cannot open — the original reply-plane gap, restored. |
| I2–I3 | Per-artifact cap ignored / per-reply total ignored | A 10 MB log makes a reply no model can read. |
| I4–I5 | First-come-first-served allocation / sorted descending | Which half of a review survives contention decided by `readdir` order (I4), or 300 bytes of budget wasted and the largest document losing them (I5). |
| I6–I9 | Cut not marked / brief stops naming cuts / brief names them unconditionally / unreadable folded into truncated | A truncated review reading as a complete one — worse than an absent review, because there is no gap in it to notice. I8 is the negative half: a warning on every brief is one a reader learns to skip. |
| B1 | Seat's request entry chosen POSITIONALLY (`requests[i]`) rather than by worker | A collator ordering `[lang, ctx, arch]` delivers the **lang brief to `rev-arch-1`** under id `T-arch`. Ids, aspects and counts all stay correct. D11's influence-by-order claim. |
| B3 | Run candidates no longer newest-first | Ambiguity refusals report the least likely run first. |
| B4 | A dead run is a candidate again | The host-wide scan returns; a crashed console's corpse holds the seat. |
| B5 | `PIFLEET_RELAY_RUNS` ignored | The explicit map §6.5 asked for silently stops working. |
| B7 | `dispatched` outcome drops its reason before rendering | A failed collation becomes invisible to the operator. |
| S1–S5 | Typed plane allowed / preflight ignored / preflight made a post-check / unknown launch shape guessed safe / `via: pane` backstop removed | A container-authored, unsanitized brief typed line-by-line into a pane that may be hosting the operator's shell. S3 specifically: a post-check is too late — the keystrokes precede the return. |
| T1–T2 | Untriggered stage counted as landed / trigger instruction dropped | 30 min stall per lens, serially, then a lost lens with nothing telling the operator how to rescue it. |
| N1–N3 | `none_landed` arm removed / journalled as dispatched / guard also swallows a genuine `not_collated` | A fan-out where **nothing** landed recorded as done: `already_done` forever, reviews never run, row reads `dispatched 3 children`. |
| N4–N5 | Planned ids journalled / a refused dispatch marked issued | The journal's `children` becomes a copy of the request rather than a record of what happened. |
| A1–A3 | Newest candidate wins / ambiguity recorded but not acted on / fails open | A review dispatched into another fleet's worker — its secret, grant, model, repo — and collated here as this console's lens. |
| C1, C5 | Failed collation reported as `collated` / every result carries a reason | Collapses the two arms that share a `kind` and a child count. |
| M7 | `awaitSettled` deadline check removed | **Hangs rather than fails** — a promise loop never yields to the test timer. The battery's own timeout catches it. |
| M11 | Supervisor verdicts folded to `failed` | Records that a reviewer produced a failing review when it never reported. |
| M13 | Reply filed under the child instead of the collator | Reports delivered where nothing reads them. |
| P1 | A fourth reviewer with no aspect seat | A lens neither reported nor reported missing. |

## Greens — and which kind of green each one is

Two different things look identical in a battery and must not be conflated.

### Semantic no-ops — the mutation genuinely changes nothing

| # | Mutation | Why green is correct |
|---|---|---|
| B2 | `.find()` over a reversed copy of `request.requests` | `resolveAspects` guarantees one entry per worker, so `find` on a unique key is order-insensitive. Green here is evidence FOR the implementation, not a gap: it shows the binding depends on the key and not on position, which is exactly what B1 proves the other way round. |

### Negative controls — must stay green or the battery reddens on everything

| # | Mutation |
|---|---|
| NC1 | Rename the local `plane` in `dispatch` (declaration + both uses) |
| NC2 | Rename the local `matches` in the candidate scan |

### Uncovered regions — the mutation changes behaviour and NOTHING catches it

Declared, not counted. These are real gaps.

| # | Mutation | Why nothing reaches it |
|---|---|---|
| S6 | `deliveryPlane` reports a non-adopted tui pane as `staged` | `productionRelayEffects.deliveryPlane` is never called by a unit test — the seam is injected. Covered only by the end-to-end harness. |
| I10 | An artifact outside the worker's outbox is read anyway | `productionRelayEffects.readArtifact` is injected too, so the containment re-check, the symlink refusal and the `O_NONBLOCK` FIFO guard are asserted by construction rather than by mutation. This is the same class as S6 and the same fix: an integration-shaped test over a real run tree. |
| B6 | The collator's run taken from `PIFLEET_RELAY_RUNS` instead of its own run | No test pins that a pin for the sender is ignored. |
| B8 | The `collation_failed` reason never appended to the ledger | `relayPass`'s `ledger` is optional and the unit fixtures pass none, so the append is unreachable from `test/unit`. |

The honest summary: the ledger append (D3's durability half) and the production
`deliveryPlane` and pin-precedence branches are asserted by construction and by
the harness, not by mutation. Closing them means a `relayPass` fixture with a
`LedgerWriter` over a temp run dir, which is an integration-shaped test.

## Two fixtures the battery caught in the round that added them

Worth recording because both looked correct and neither was:

- **I5** — the starvation fixture was `[10, 100_000]`, where the equal share
  exceeds the per-artifact cap either way, so ascending and descending give the
  same answer and sorting DESCENDING survived. Max-min fairness only differs
  from its reverse when small claims are numerous enough that satisfying them
  first RELEASES budget. Rebuilt as `[10, 10, 10, 900]` against a total of 440.
- **I8** — the "a whole review produces no truncation line" test asserted the
  absence of the per-artifact lines but not of the GUIDANCE line, so an
  unconditional section passed it while telling every collator its documents
  might be partial.

Both are the same shape as the degenerate fixtures this table already records:
an assertion that cannot distinguish the implementation from its plausible
wrong twin.

## The end-to-end harness

Behavioural before/after runs live outside this battery. Modes: `rpc`, `tui`
(all four panes staged), `collatorfail`, `allbusy`. It stands up four real runs,
speaks the real newline-delimited control protocol over real unix sockets with
the real per-run secret, and models supervisor attempt-id replay. It is what
demonstrated:

- the wrong-verb defect (every pane refused, `dispatched 3 children` journalled);
- `none_landed` (zero dispatches, journalled as done, permanent `already_done`);
- `collation_failed` (three reviews re-run on every tick before the arm existed).
