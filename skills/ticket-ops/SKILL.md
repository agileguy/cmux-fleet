---
name: ticket-ops
description: How to read and write tickets from inside a worker container with the `rally-cli` in the image — the command surface, the JSON envelope, the read-back check that decides the verdict, and the block renderer for rich-text fields. Mounted for the `ticketing` role.
---

# ticket-ops

The `ticketing` role says what you must do. This says how, for this vendor.

**The image carries `rally-cli`, and it is already configured.** Run it. You do not build a
request, you do not hold a credential, and you do not need to know which URL segment Rally calls
a user story.

> **This document used to say the opposite**, and the reversal is recorded rather than quietly
> applied. It opened with "there is no ticket CLI in the image and there is not going to be one",
> on the grounds that baking one puts a vendor's name in a public repository. That repository is
> private, and this file has named `rally1.rallydev.com` in its own table since 2026-08-30 — the
> vendor was already here. What the CLI actually replaces is a page of vendor knowledge that
> nothing re-ran: which path segment is a story, that a `FormattedID` is not an object id, which
> fields must be in `fetch=`. One of those sentences was WRONG for months — it specified
> `Authorization: Token`, which Rally answers with an HTML login page — and nothing caught it
> because no credential existed to exercise it. A command that fails loudly beats a paragraph
> that cannot.

## What you are given

| Name | What it is |
|---|---|
| `rally-cli` | on `PATH`, pre-configured against the workspace and project you are scoped to |
| ticket ids | from the task envelope, and **only** there — the objects you may touch |

**You never handle the credential.** There is no `RALLY_APIKEY` in your environment and no token
file you need to open. `/usr/local/bin/rally-cli` is a shim: it reads the delivered files in its
own process, exports what the CLI needs, and `exec`s. `env | grep -i rally` prints nothing.

That is the point, and it is worth understanding rather than just relying on. Every hand-written
way of bridging a secret file to this CLI leaks:

```bash
rally-cli --apikey "$(cat "$TICKET_API_TOKEN_FILE")"   # argv — `ps` can see it
export RALLY_APIKEY="$(cat ...)"                       # `env` can see it, all turn
```

You do not write either. Do not try to "help" by setting `RALLY_APIKEY` or passing `--apikey`,
`--workspace`, `--project` or `--server`: the shim already set them, and an override is how a
query silently changes scope.

**If `rally-cli` exits 78** with `this is 'blocked', not 'failed'`, the fleet did not deliver its
configuration — the worker's `secrets:` selector did not name a value, or the fleet's
`env_allowlist` did not permit it. That is `blocked`. It is not something to work around, and
there is no fallback path you are expected to reach for.

`HTTPS_PROXY` is set for you if the fleet routes egress through one. You do not set it, and you
need no Google identity — this role is configured without one.

## The one rule that breaks every JSON pipe

**`2>&1` into `jq` will fail.** `rally-cli` fans some queries across all four artifact types, and
Rally rejects the ones that do not apply — so a perfectly good `--state` query prints this to
**stderr** before printing its JSON to stdout:

```
Rally API error fetching Task: Could not read: The provided query is invalid. … for class Task
```

It is harmless and it is not an error you act on. But merged into the pipe it is a parse failure
that reads like a broken query, so:

```bash
rally-cli tickets --current-iteration --my-tickets --format json 2>/dev/null > /tmp/q.json
```

`2>/dev/null` on every `--format json` invocation. Check the **exit status** for failure, and the
envelope's `success` field — never the presence of stderr.

## The envelope

`--format json` always returns the same three keys:

```json
{ "success": true, "data": [ … ], "error": null }
```

- **`data` is a LIST for the query commands** (`tickets`, `search`, `iterations`, `users`) and an
  **object** for the single-subject ones (`tickets show`, `discussions`, `summary`). Read the
  command you ran, not the last one you read about.
- **Keys are `snake_case`** — `formatted_id`, `object_id`, `schedule_state`, `ticket_type`,
  `last_update_date`. They are NOT Rally's own WSAPI PascalCase (`FormattedID`). Code written
  against the WSAPI names gets `None` from every row and reports nothing wrong.
- **The point estimate is `points`**, not `plan_estimate`.
- **`state` and `schedule_state` both appear** and carry the same value for stories and defects.
- **`success: false` with a populated `error`** is the failure shape. An empty `data` with
  `success: true` is a real empty result — which is a finding, not a failure, and must be
  reported as one.

```bash
jq -r '.data[] | "\(.formatted_id) \(.state) \(.points // 0) \(.name)"' /tmp/q.json
```

Reason over the JSON in the container. Do not paste it into your result envelope.

**Every request is already bounded — you add no timeout.** The CLI sets a 30-second HTTP timeout
per request and retries a transport failure at most three times with backoff capped at 10s, so
the worst case for one command is on the order of 100 seconds and it always ends. That matters
more than it sounds: an unbounded request inside a container does not fail, it HANGS, and the
only signal reaching the supervisor is that you stopped emitting events — so you are killed with
nothing written and no reason recorded. Measured on the `curl` path this replaced: an unbounded
paging loop went silent for 180s and lost the whole run. The bound now lives in the tool instead
of in a flag you have to remember, which is strictly better; do not wrap commands in `timeout`
to re-add one.

## Resolving what the request meant, before you query for it

Two words in almost every request are lookups, not literals. Both fail silently when assumed:
the query succeeds, the rows are real, and they are the wrong rows.

**"me" / "my" / "mine" — `--my-tickets`.** It resolves to whoever the delivered credential is,
which is the only correct reading of "my" and is not necessarily the person who asked. If the
request names a different person, that is `--owner "Display Name"` instead. Never assume the two
are the same person.

**"this iteration" / "this sprint" — `--current-iteration`.** The CLI resolves it. Then confirm
what it resolved to and **name it, with its dates, in the artifact**:

```bash
rally-cli iterations --current --format json 2>/dev/null \
  | jq -r '.data[] | "\(.name)  \(.start_date) → \(.end_date)"'
```

That is not ceremony. On a day that is one sprint's end date and the next one's start date, both
can be marked current, and roughly one iteration OBJECT exists per project in the workspace — all
sharing the sprint's name. The iteration you settled on is a conclusion you reached, and it is
the one thing a reader cannot re-derive from your output if you omit it.

**"the team" means the project you are scoped to.** Not the workspace. The shim scopes every
query to one project; if a request seems to ask about a wider group, say which project you
answered for. Measured 2026-09-01: an iteration summary asked about "the team" without a project
returned 49 projects and roughly 180 people, and read as a plausible answer to the question that
was asked.

## Reading tickets

```bash
# The common one, whole and server-side:
rally-cli tickets --current-iteration --my-tickets --format json 2>/dev/null > /tmp/q.json

# One object, in full:
rally-cli tickets show S529596 --format json 2>/dev/null > /tmp/one.json
```

`tickets` filters, all applied by the server:

| Flag | What it narrows to |
|---|---|
| `--current-iteration` | the current sprint |
| `--iteration "<name>"` | a named sprint |
| `--my-tickets` | owned by the credential |
| `--owner "<display name>"` | owned by someone named |
| `--state "<state>"` | one schedule state |
| `--ticket-type userstory\|defect\|task\|testcase` | one type |
| `--query "<WSAPI>"` | anything the flags cannot express |

### `--query` REPLACES every other filter. It does not combine with them.

**This is the single most dangerous thing in the tool, and it fails by returning MORE rather than
by erroring.** Measured 2026-09-01, on this workspace:

| Command | Rows |
|---|---|
| `tickets --current-iteration --my-tickets` | **28** |
| `tickets --my-tickets --query '(ScheduleState < "Accepted")'` | **19,439** |

The second is not "my non-Accepted tickets". It is every non-Accepted artifact in the workspace:
`--my-tickets` was silently discarded, and so was the iteration. It takes about a minute, it
exits 0, and `success` is `true`. A worker that piped it into `jq` and counted would report a
number with total confidence.

So: **if you pass `--query`, it must carry EVERY term itself** — owner, iteration and state — or
you have widened the question instead of narrowing it. When in doubt, do not pass it.

### "Not Accepted" — the shape that is actually correct

`--state` takes ONE state, and "not Accepted" is not a state. `ScheduleState` is an ordered
enum — `Idea`, `Defined`, `In-Progress`, `Completed`, `Accepted`, then released states.

**Narrow with the flags, then partition what came back:**

```bash
rally-cli tickets --current-iteration --my-tickets --format json 2>/dev/null > /tmp/q.json
jq -r '[.data[] | select(.state != "Accepted")] | .[] | "\(.formatted_id)  \(.state)  \(.name)"' /tmp/q.json
```

This is not the "download a collection and grep it" the next rule forbids, and the difference is
worth being precise about: every narrowing the QUESTION contains — owner, iteration — was applied
by the server, so `/tmp/q.json` is the complete answer to a scoped question and the `jq` splits a
set you already hold. Grepping is wrong when the server was never asked; partitioning is right
when it was asked everything it could be.

**Always report both halves** — how many came back and how many survived the partition. "28
tickets in the iteration, 8 not Accepted" is checkable; "8 tickets" is not.

**Filter on the server. Never fetch an unfiltered collection and grep it.** That is the failure
this rule exists for: a run that pulled pages out of 59,616 objects and grepped for an owner name
reported zero tickets for a user who had thirty. The second form above is fine because the flags
did the narrowing; the difference is whether the set you filtered is the complete answer to a
scoped question. If a filter you need is expressible in neither the flags nor `--query`, report
`blocked` and say which one — a stated inability to ask the question beats a confident wrong
answer.

**Paging is the CLI's problem, not yours.** Rally's own default page is 20; `rally-cli` returned
164 rows for a whole-project iteration query on 2026-09-01, so it pages internally. You still
**reconcile the count against what you claim** — an artifact whose prose says "8 open stories"
and whose `queried` array holds 5 is contradicting itself in the half that gets read
mechanically.

**`--query`'s grammar is unforgiving, on top of it replacing your other filters.** Every binary
operator must be parenthesised, the whole expression included: `(A AND B)` is REJECTED,
`((A) AND (B))` works, and three terms nest pairwise — `(((A) AND (B)) AND (C))`. A flat `AND`
list fails in a way that reads exactly like the feature being absent, and a run once concluded
from that "Rally WSAPI does not support AND" and reported a wrong count with confidence. Traverse
references with dots: `Owner.UserName`, not `Owner`, which matches nothing and errors on nothing.

Between the grammar and the override, a self-contained `--query` is three nested terms you have
to get right in one go. Reach for it only when the flags genuinely cannot express the question,
and say in the artifact that you did.

## Other objects

| Ask | Command |
|---|---|
| the sprint's shape | `rally-cli summary` (add `--iteration "<name>"`) |
| a ticket's comments | `rally-cli discussions <id>` |
| free-text search | `rally-cli search "<text>"` (`--current-iteration`, `--type`, `--limit`) |
| who is on the project | `rally-cli users` |
| sprints | `rally-cli iterations --current \| --past \| --future` |
| attachments | `rally-cli attachments list\|upload\|download <id>` |
| features, releases, tags | `rally-cli features`, `releases`, `tags` |

**Comments are readable now**, and this replaces a standing gap: until 2026-09-01 this document
recorded that Rally's discussion objects could not be queried at all — `discussion`, `post` and
`DiscussionPost` were each rejected as artifact types — and instructed you to report that you
could not look. `rally-cli discussions <id>` returns `{formatted_id, count, discussions}`. A
`count` of 0 is now a real finding: no comments, rather than no way to ask.

**Sub-objects are their own query.** `tickets show` returns one object's own fields, never its
children. Tasks under a story: `--ticket-type task --query '(WorkProduct.FormattedID = "S12345")'`.
A task's iteration is read through from its parent — moving a story carries its tasks, and a task
cannot be moved on its own.

## Writing

```bash
rally-cli tickets update S529596 --state "In-Progress" --points 3
rally-cli tickets update S529596 S529597 --state "Completed"     # bulk, same change
rally-cli comment S529596 "…"                                    # or --message-file
rally-cli tickets create "Title" --description "…" --points 1    # --type defect, --backlog
```

`tickets update` also carries `--owner`, `--iteration` / `--no-iteration`, `--parent`, `--name`,
`--release` / `--no-release`, `--add-tag` / `--remove-tag`, `--blocked` / `--no-blocked` with
`--blocked-reason`, `--ready`, `--expedite`, `--target-date`, and — **defects only** —
`--severity`, `--priority`, `--defect-state`, `--resolution`.

**`--state` and `--defect-state` are different fields.** `--state` sets `ScheduleState`, the flow
state every artifact has. `--defect-state` sets a defect's own `Submitted`/`Open`/`Fixed`/`Closed`
field. Setting the one you meant to leave alone is a write that succeeds and reports the wrong
thing to everyone reading the board.

## Rich text is HTML, and you do not write HTML

`--description`, `--notes` and `--ac` write **HTML** fields. The rest — a state, an owner, a point
estimate — are plain and go as-is. Two failures, both silent:

- **Markdown into an HTML field** renders as one collapsed run-on paragraph with the literal `#`,
  `*` and `-` still visible. The write succeeds. Nothing warns you.
- **Hand-written HTML** hits a server-side sanitizer that keeps a small subset and drops the rest
  without saying so. `<h2>`, `<table>`, `<div>`, `<span style>` and — the one that catches
  people — **`<pre>` and `<code>`** are stripped. Text inside a stripped tag usually survives
  unstyled, so a code block comes back as an unformatted run and a table as concatenated cells.

So you do not author markup. You emit a **block list**, pipe it through the renderer, and pass the
file:

```bash
jq -n '[
  {"type":"h","spans":[{"text":"Root cause"}]},
  {"type":"p","spans":[
     {"text":"The probe targets "},
     {"text":"8080","bold":true},
     {"text":" but the container listens on 3000."}
  ]},
  {"type":"ul","items":[
     [{"text":"Confirmed on the last three deploys"}]
  ]}
]' | node /skills/ticket-ops/render-blocks.mjs > /tmp/body.html

rally-cli tickets update S529596 --notes-file /tmp/body.html --overwrite
```

The renderer emits only what the server keeps: `<p>`, `<b>`/`<strong>`, `<i>`/`<em>`, `<ul><li>`,
`<ol><li>`, `<br/>`, `<a href>`. It entity-escapes `&`, `<` and `>` in your content, so a body may
contain `a < b && c > d` without breaking the field. It refuses any `href` that is not `http(s)`,
and it refuses an unknown block type or span key outright — exit 2, empty stdout — rather than
rendering the parts it understood. A partially-rendered body written into a system of record is
worse than no write.

There is no `code` block and no `pre` block. A command or a log line goes in a paragraph of its
own; it will be unstyled, which is what the server was going to give you anyway.

## Append versus replace

**These three fields APPEND by default.** A "replace the description" that omits `--overwrite`
concatenates your body onto the old one, exits 0, and leaves a ticket that reads as though
someone said the same thing twice with different conclusions.

Decide which the task asked for, pass it explicitly every time, and record the mode per field in
the artifact. Then let the read-back settle it: after a **replace**, the stored value equals what
you sent — if it *contains* what you sent and the old text too, `--overwrite` did not take, and
that is a `mismatch`, not a rounding error.

## The read-back check

This is where the verdict comes from. After every write:

1. **Re-read the object.** `rally-cli tickets show <id> --format json 2>/dev/null`. The write's
   own exit status is not evidence — the sanitizer runs between your bytes and the stored value.
2. **Compare STORED against SENT.** Byte-for-byte on plain fields. On HTML fields the stored value
   may differ in whitespace or attribute order, so compare on tag-and-text content and say which
   comparison you used.
3. **Classify, per field:**

   | Result | Meaning | Verdict contribution |
   |---|---|---|
   | `exact` | stored equals sent | `success` |
   | `sanitized` | stored is sent minus tags the server dropped | `partial` — say which tags |
   | `mismatch` | stored is neither (appended, truncated, unchanged) | `partial` or `failed` |
   | `unverified` | the re-read itself failed | `failed` — you do not know the state |

4. **Do not retry a mismatch blindly.** A second identical write against an append-by-default
   field doubles the damage, and a sanitizer that dropped a tag once will drop it again. Report
   what the round trip returned and stop. The one legitimate retry is a re-read after a timeout on
   the READ, because that leaves the stored value genuinely unknown.

`unverified` is the important one. A write you sent and could not read back is not "probably
fine" — it is a change of unknown extent in a system other people are reading, and it needs a
human to look. Say so in the artifact, in those terms.

## The artifact — two files, and the `.json` is the one with teeth

Write **both**, every time, under the id you were dispatched with (`pifleet-worker` says where to
read that id; it is not a name you pick):

| Path | Who reads it |
|---|---|
| `/outbox/<task-id>/files/ticket-ops.json` | the harvester, mechanically |
| `/outbox/<task-id>/files/ticket-ops.md` | the human operator |

Same content. Different consequences.

### The exact shape of the `.json`, because guessing it fails the task

**This section did not exist until 2026-08-30, and its absence was measured.** Two live runs and
one fixture run each wrote a sensible-looking object of the worker's own invention —
`{summary, query, defects, writes_made}` — and every one failed `TicketOpsArtifactSchema` on the
same four required fields. The harvest did its job each time: the malformed document reached
`discrepancies`, `harvest_status` went `partial`, and the verdict came out `unknown` rather than
the `success` the worker claimed. The work was done, the answer was right, and the run was
ungradeable.

```bash
jq -n '{
  schema:       "pifleet.ticket-ops/v1",
  task_id:      "<the id from ## This task — NOT a name you pick>",
  worker:       "<the worker from ## This task>",
  epoch:        0,
  operation:    "query",
  ticket_host:  "rally1.rallydev.com",
  generated_at: (now | todateiso8601),
  no_change_needed: false,
  queried:      [ {ticket: "S529596", fields: [{field: "state", value: "In-Progress"}]} ],
  updates:      [],
  commands:     ["rally-cli tickets --current-iteration --my-tickets --format json"],
  verdict:      "success",
  notes:        "the iteration you resolved and its dates, and any count that did not reconcile"
}' > /outbox/<task-id>/files/ticket-ops.json
```

- **`task_id`, `worker` and `epoch` are given to you** in the `## This task` block of your prompt.
  They are not derivable from anything you can see, which is why they are handed over.
- **`operation` is `query` or `update`, and nothing else.** A query that changed nothing is an
  `operation: "query"` with `updates: []` — not an `update` with an empty list.
- **`verdict` is one of `success`, `partial`, `blocked`, `failed`.** It is YOUR claim, and the
  harvest may lower it; it can never raise it.
- **`queried` is one entry per object you actually read**, and it is what a reader counts.
- **`ticket_host` is the HOST** — no scheme, no path. It is `rally1.rallydev.com` unless the
  delivered base URL says otherwise, and you can confirm which server you reached with
  `rally-cli config`, which prints the host and redacts the key.
- **Inside `queried[].fields[]` the key is `field`, not `name`.** Measured: the first version of
  this example said `name`, and a run that copied it faithfully failed validation on every row.
  The schema is `{field, value}`, `value` may be `null`, nothing else is accepted. Copy the shape,
  do not paraphrase it.
- **`commands` records what you ran.** Write the command as you ran it. It names no credential —
  that is the shim's whole point — so there is nothing to elide, and a `commands` entry containing
  an `--apikey` is evidence you bypassed the shim.

### The shape of `updates[]`, because the query example above is not enough

**This is a second, measured gap, not a variant of the first.** The example above is a
`query` — its only populated array is `queried`, and `queried[]`'s shape is `{ticket,
fields: [{field, value}]}`. A worker moving four tickets between iterations copied that
shape into `updates[]` faithfully and failed validation on every one of six required keys,
because `updates[]` entries are not `queried[]` entries with a different name. Here is the
shape that actually validates:

```bash
jq -n '{
  schema:       "pifleet.ticket-ops/v1",
  task_id:      "<the id from ## This task — NOT a name you pick>",
  worker:       "<the worker from ## This task>",
  epoch:        0,
  operation:    "update",
  ticket_host:  "rally1.rallydev.com",
  generated_at: (now | todateiso8601),
  no_change_needed: false,
  queried:      [],
  updates: [
    {
      ticket:    "S511387",
      requested: "move to FY26-Q4 PI Sprint 4 (20), the sprint the task named",
      fields: [
        {
          field:     "iteration",
          mode:      "replace",
          sent:      "FY26-Q4 PI Sprint 4 (20)",
          read_back: "FY26-Q4 PI Sprint 4 (20)",
          match:     "exact",
          detail:    ""
        }
      ],
      verdict: "success"
    }
  ],
  commands: [
    "rally-cli tickets update S511387 --iteration \"FY26-Q4 PI Sprint 4 (20)\""
  ],
  verdict: "success",
  notes: ""
}' > /outbox/<task-id>/files/ticket-ops.json
```

- **Every entry in `updates[]` needs `ticket`, `requested`, `fields[]` and its own
  `verdict`.** `requested` is prose, not measurement — a sentence or two on what the task
  asked for on THIS ticket — because it is the one thing a reader who was not there cannot
  get from the round trip below: the round trip proves what was SENT, not that it was the
  RIGHT thing to send.
- **Each entry in `fields[]` carries six keys: `field`, `mode`, `sent`, `read_back`, `match`,
  `detail`.** `mode` is `replace` or `append` — nothing else — record which one you actually
  did, per field, every time, the same distinction the append-versus-replace section above
  makes. `sent` is exactly what went over the wire, after the block renderer ran on a
  rich-text field. `read_back` is what the second GET returned: a string, or `null`, and a
  `null` means exactly one thing (next bullet). `detail` defaults to `""` and is REQUIRED —
  non-empty — for anything other than `match: "exact"`.
- **A `null` `read_back` and `match: "unverified"` are the same fact spelled two ways, and the
  schema enforces that they are spelled together** — one without the other is a parse-time
  rejection, not a warning. This is the case the read-back section above already calls "the
  important one": a write you sent and could not re-read is a change of unknown extent, not a
  success with a gap in it.

  ```json
  { "field": "notes", "mode": "append", "sent": "Blocked on S511200; escalated to on-call.",
    "read_back": null, "match": "unverified",
    "detail": "the re-read timed out twice after the write; stored value not confirmed" }
  ```

- **`match: "exact"` requires `read_back` to equal `sent` byte-for-byte. `sanitized` and
  `mismatch` both require `read_back` to DIFFER from `sent`.** Recording `exact` next to two
  values that differ, or `sanitized`/`mismatch` next to two values that are identical, fails
  validation — the schema holds `sent` and `read_back` side by side and re-derives the
  comparison itself, rather than trusting the label you put on it.
- **A ticket's `verdict` may be no better than its worst field's `match` supports, and never
  better.** The floor, per `match`: `exact` → `success`, `sanitized` → `partial`, `mismatch` →
  `partial`, `unverified` → `failed`. Claiming `success` on a ticket carrying an `unverified`
  field fails validation. Downgrade yourself for a reason the fields don't carry if you must —
  you cannot upgrade past what the read-backs prove.

**The harvester selects on the filename `ticket-ops.json` and on nothing else** — not on your
role, not on what the document turns out to contain. That exact string is what puts a file through
`TicketOpsArtifactSchema` in `src/contracts.ts`, and through the sweep that looks for the
credential's literal bytes in what you are about to publish. A file under any other name is an
ordinary artifact: unvalidated and unswept.

**A run that writes only `ticket-ops.md` FAILS.** The harvest finds the `.md` with no `.json`
beside it, records that "the ticket-ops schema validation and the credential sweep DID NOT RUN on
it; this document is unchecked, not clean", and clamps the verdict to `failed`. Deliberate rather
than harsh: with neither check run, nothing is known about what you did to a system of record
other people share.

Measured, and the reason the check exists: a worker wrote `files/ticket-ops.md`, omitted the
`.json`, and neither the schema check nor the credential sweep ran on the only output that run
produced — including the one that exists to catch you having put the write credential into your
own write-up. At the time, that run reported clean.

If the tickets already said what the task wanted, write **both files** with
`no_change_needed: true`, an empty `updates` array, and report `success`. That is a real outcome,
not a failure to find work — and a run with nothing to report is the one most likely to skip the
`.json` on the reasoning that there is nothing in it worth validating. There is: that no write
happened is itself the finding, and the `.json` is where a machine can read it.
