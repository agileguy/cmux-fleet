---
name: ticket-ops
description: How to read and write tickets over the ticket system's REST API from inside a worker container — curl call shapes, the rich-text block renderer, and the read-back check that decides the verdict. Mounted for the `ticketing` role.
---

# ticket-ops

The `ticketing` role says what you must do. This says how, for this vendor.

There is no ticket CLI in the image and there is not going to be one. You talk to the API with
`curl` and parse with `jq`, both of which are in every worker image. That is deliberate: a
vendor CLI would have to be baked, which puts a vendor's name in the image hash and in a public
repository, and it would pin you to whatever that CLI decided an update was.

## What you are given

| Name | Where from | What it is |
|---|---|---|
| `TICKET_API_TOKEN_FILE` | env | the **path** to a read-only file holding the write credential |
| `TICKET_BASE_URL_FILE` | env | the path to a file holding `https://rally1.rallydev.com/slm/webservice/v2.0` |
| ticket ids | the task envelope, and **only** there | the objects you may touch |

**There is no `TICKET_API_TOKEN` variable.** `echo $TICKET_API_TOKEN` prints an empty line, and
so does `env | grep TOKEN`. The value is not in your environment at all — it is in a file at
`$TICKET_API_TOKEN_FILE`, mounted read-only, and the sections below are about getting it into a
request without it passing through your shell on the way.

`HTTPS_PROXY` is set for you if the fleet routes egress through one. You do not set it, and you
do not need a Google identity — this role is configured without one.

If `TICKET_API_TOKEN_FILE` is unset, or names a file you cannot read, that is `blocked`, not
`failed`, and not something to work around. It means the worker's `secrets:` selector did not
name the credential, or the fleet's `secrets.env_allowlist` did not permit it.

## Getting the credential into a request without holding it

Build a `curl` config file once, at the start of your work. `curl --config` reads request
options out of a file, so a `header` line in it reaches the request without the value ever
being an argument, an environment variable, or a shell variable:

```bash
umask 077
{ printf 'header = "ZSESSIONID: '
  cat "$TICKET_API_TOKEN_FILE"
  printf '"\n'
} > /tmp/ticket.curlrc
```

**`ZSESSIONID`, not `Authorization`.** This document said `Authorization: Token` until
2026-08-30, which is the shape of a different vendor entirely and was never exercised — no
credential existed on any machine that ran this fleet, so the line had never reached a server.
Rally's WSAPI authenticates an API key with a `ZSESSIONID` header and answers `Authorization:
Token` with a 401 whose body is an HTML login page. Verified against
`/user?fetch=UserName` on 2026-08-30: `ZSESSIONID` returns the user object.

That is worth pausing on, because the failure it would have produced is the one this whole
document is written against: `--fail-with-body` turns the 401 into a non-zero exit and a body,
so a worker would have reported `blocked` with an HTML page attached and nobody would have known
whether the credential was wrong, the header was wrong, or the host was down.

Read that construction carefully, because the obvious shorter forms are the ones that leak:

- **`cat` writes to the redirect, not to your terminal.** Its output goes into the file and is
  never rendered, so nothing about this lands in the transcript.
- **No command substitution.** `printf '...%s...' "$(cat "$TICKET_API_TOKEN_FILE")"` looks
  tidier and is worse: the value becomes a shell word, which puts it in `printf`'s argv where
  `ps` can see it, and one `set -x` away from your own transcript.
- **`umask 077` first.** The file you are creating holds the credential in a writable tmpfs.
- **Never assign it to a variable.** Not `TOKEN=$(cat ...)`, not for "just this one call". A
  variable is what `env`, `set` and an accidental `echo` all reach.

Then every call uses the config and never mentions the credential:

```bash
BASE_URL="$(cat "$TICKET_BASE_URL_FILE")"   # not a credential — a variable is fine

curl -sS --fail-with-body --max-time 60 --config /tmp/ticket.curlrc \
     -H 'Accept: application/json' \
     "${BASE_URL}/defect/${ID}?fetch=FormattedID,Name,State,Owner" -o /tmp/issue.json
```

**The path segment is the Rally TYPE, and getting it wrong is a 404 rather than a redirect.**
`defect`, `hierarchicalrequirement` (a user story — the URL does not say "story"), `task`,
`iteration`. A `FormattedID` like `US12345` or `DE181674` is not an object id and cannot be
substituted into the path: fetch by `FormattedID` with a query instead —
`${BASE_URL}/hierarchicalrequirement?query=(FormattedID = "US12345")` — and read the `_ref` out
of the result. **`fetch=` is not optional in practice**: without it Rally returns every field on
the object, which is tens of kilobytes per row and the difference between a readable artifact
and a payload that eats the turn.

Seven rules about that command, each of which has a failure behind it:

- **`--fail-with-body`, never bare `-s`.** Without it `curl` exits 0 on a 401 and you parse the
  error page as a ticket. With it you get the non-zero exit *and* the body that explains it.
- **The token goes in a header, never in the URL.** A query string is logged by every proxy on
  the path, lands in the server's access log, and appears in your own shell history. There is no
  endpoint here worth reaching that requires it.
- **Never `cat` the credential file to your own output, and never `set -x` a block that touches
  it.** The delivery change above removes the *accidental* disclosure — the variable swept up by
  `env`, the expansion into a command you did not think of as sensitive. It cannot stop a
  deliberate one. `cat "$TICKET_API_TOKEN_FILE"` on its own line puts the value in the
  transcript exactly as `echo $TICKET_API_TOKEN` used to.
- **Do not copy the file.** One `/tmp/ticket.curlrc` is the working copy; a second copy is a
  second thing to reason about and nothing needs it.
- **Write bodies to a file, not to a variable you later echo.** It keeps large payloads out of
  the transcript, and it gives you the exact bytes to diff against the read-back.
- **`--max-time` on every call, no exceptions.** A request with no deadline does not fail inside
  a container, it hangs, and the only signal reaching the supervisor is that you stopped emitting
  events — so you are killed with nothing written and no reason recorded. Measured: an unbounded
  paging loop went silent for 180s and lost the whole run. Sixty seconds is a reasonable default;
  a deliberately larger one is fine, absent is not.
- **Filter on the server. Never fetch a collection and search it locally.** Use the API's own
  query parameters to match owner, state, iteration or anything else it can match. Fetching pages
  and grepping them is not merely slow — it is *wrong*, because you end up reporting on the pages
  you happened to pull rather than on the system. Measured: a run that pulled pages out of 59,616
  objects and grepped for an owner name reported zero tickets for a user who had thirty. If a
  filter you need is not expressible, report `blocked` and say which one; a stated inability to
  ask the question beats a confident wrong answer.

Read the fields you need with `jq -r '.fields.summary'`. Reason over the JSON in the container.
Do not paste it into your result envelope.

**Reconcile every count.** These APIs paginate, and the default page is small — smaller than
many real answers. Ask for a large page, then compare how many records you actually received
against the total the response reports. If they differ, page until they agree or say in the
artifact that they did not. A first page mistaken for a complete answer is the same error as
grepping a download, and it looks just as confident.

## Rally's query grammar and pagination, because guessing them produced a wrong answer

**Every fact in this section was measured on 2026-08-30, immediately after a run got all three
of them wrong.** That run was asked to count the open defects owned by one user. It reported
**5**. The answer is **8**. It did not report a wrong number because the API was hard; it
reported one because it concluded, from two failed guesses, that the server could not answer the
question — and then filtered the one page it had. Its artifact called them "API Limitations
Encountered". Both were wrong:

> *"Compound queries not supported: Rally WSAPI does not support `AND` in query strings"* — it
> does. **Every binary operator must be parenthesised, including the whole expression.**
> `(A AND B)` is rejected; `((A) AND (B))` works. Three terms nest pairwise:
> `(((A) AND (B)) AND (C))`. A flat `AND` list is the shape that fails, and failing that way
> reads exactly like the feature being absent.
>
> *"Pagination broken: the `startIndex` parameter does not work"* — there is no `startIndex`
> parameter. It is **`start`, and it is 1-BASED**, alongside `pagesize` (default 20). `start=21`
> returns `StartIndex: 21` and the next page. A parameter Rally does not recognise is IGNORED,
> not rejected, so a wrong name gives you page one every time and looks like a broken server.

```bash
# The whole answer, server-side, in one request:
curl -sS --fail-with-body --max-time 60 --config /tmp/ticket.curlrc \
     -H 'Accept: application/json' -G "${BASE_URL}/defect" \
     --data-urlencode 'query=((Owner.UserName = "someone@example.com") AND (State != "Closed"))' \
     --data-urlencode 'fetch=FormattedID,Name,State' \
     --data-urlencode 'pagesize=200' -o /tmp/q.json
jq '.QueryResult | {total: .TotalResultCount, got: (.Results|length), errors: .Errors}' /tmp/q.json
```

- **Traverse with dots.** `Owner` is a reference object, and comparing it to an email matches
  nothing while erroring on nothing. `Owner.UserName` is the field a person means.
- **`--data-urlencode` with `-G`, never a hand-built query string.** The grammar is full of
  spaces, quotes and parentheses, and one unescaped space is a 400 that reads like a syntax
  error in your filter.
- **Read `TotalResultCount` and `Results|length` in the same breath, every time.** They disagree
  by default — the page is 20 — and that disagreement is the whole trap. `Errors: []` is part of
  the check: Rally answers a malformed query with `200` and an `Errors` array, so a non-empty
  `Errors` with zero results is a broken query, not an empty result set.
- **If you cannot express the filter, say so and report `blocked`.** Do not fall back to
  filtering a page. A stated inability beats a confident wrong total — and note that the run
  above also marked its own acceptance criterion *"count based on TotalResultCount"* as **met**,
  with `TotalResultCount: 33, open defects visible: 5` as the evidence. Two numbers that
  contradict the claim they were offered to support. Grading yourself is not checking yourself.

## Rich text is HTML, and you do not write HTML

Some fields on these objects are plain strings — a state, an owner, a point estimate. Those you
send as-is. The description-shaped fields are **HTML**, and they are the ones that go wrong.

Two failures, both silent:

- **Markdown into an HTML field** renders as one collapsed run-on paragraph with the literal
  `#`, `*` and `-` characters still visible. The write succeeds. Nothing warns you.
- **Hand-written HTML** hits a server-side sanitizer that keeps a small subset and drops the
  rest without saying so. `<h2>`, `<table>`, `<div>`, `<span style>`, and — the one that catches
  people — **`<pre>` and `<code>`** are stripped. Text inside a stripped tag usually survives
  unstyled, so a code block comes back as an unformatted run and a table comes back as its cells
  concatenated.

So you do not author markup. You emit a **block list** and pipe it through the renderer:

```bash
jq -n '[
  {"type":"h","spans":[{"text":"Root cause"}]},
  {"type":"p","spans":[
     {"text":"The probe targets "},
     {"text":"8080","bold":true},
     {"text":" but the container listens on 3000."}
  ]},
  {"type":"ul","items":[
     [{"text":"Confirmed on the last three deploys"}],
     [{"text":"Tracked in "},{"text":"issue 412","href":"https://<TICKET_HOST>/issue/412"}]
  ]}
]' | node /skills/ticket-ops/render-blocks.mjs > /tmp/body.html
```

The renderer emits only what the server keeps: `<p>`, `<b>`/`<strong>`, `<i>`/`<em>`,
`<ul><li>`, `<ol><li>`, `<br/>`, `<a href>`. It entity-escapes `&`, `<` and `>` in your content,
so a ticket body may contain `a < b && c > d` without breaking the field. It refuses any `href`
that is not `http(s)`, and it refuses an unknown block type or span key outright — exit 2, empty
stdout — rather than rendering the parts it understood. A partially-rendered body written into a
system of record is worse than no write.

There is no `code` block and no `pre` block. If you need to show a command or a log line, put it
in a paragraph of its own; it will be unstyled, which is what the server was going to give you
anyway.

## Append versus replace

**These fields append by default.** A "replace the description" that omits the overwrite flag
concatenates your new body onto the old one, returns 200, and leaves a ticket that reads as
though someone said the same thing twice with different conclusions.

Decide which one the task asked for, send it explicitly every time, and record the mode in the
artifact per field. Then let the read-back settle it: after a **replace**, the stored value
equals what you sent — if it *contains* what you sent and also the old text, the overwrite flag
did not take, and that is a `mismatch`, not a rounding error.

## The read-back check

This is the part the verdict comes from. After every write:

1. **Re-fetch the object.** A second `GET`. The write's own 200 and the write's own response
   body are not evidence — the sanitizer runs between them and the stored value.
2. **Compare the STORED value against what you sent.** Byte-for-byte on plain fields. On HTML
   fields the stored value may differ in whitespace or attribute order after normalisation, so
   compare on the tag-and-text content and say which comparison you used.
3. **Classify, per field:**

   | Result | Meaning | Verdict contribution |
   |---|---|---|
   | `exact` | stored equals sent | `success` |
   | `sanitized` | stored is sent minus tags the server dropped | `partial` — say which tags |
   | `mismatch` | stored is neither (appended, truncated, unchanged) | `partial` or `failed` |
   | `unverified` | the re-fetch itself failed | `failed` — you do not know the state |

4. **Do not retry a mismatch blindly.** A second identical write against an append-by-default
   field doubles the damage, and a sanitizer that dropped a tag once will drop it again. Report
   what the round trip returned and stop. The one retry that is legitimate is a re-fetch after a
   5xx or a timeout on the *read*, because that leaves the stored value genuinely unknown.

`unverified` is the important one. A write you sent and could not read back is not "probably
fine" — it is a change of unknown extent in a system other people are reading, and it needs a
human to look. Say so in the artifact, in those terms.

## The artifact — two files, and the `.json` is the one with teeth

Write **both** of these, every time, under the id you were dispatched with (`pifleet-worker`
says where to read that id; it is not a name you pick):

| Path | Who reads it |
|---|---|
| `/outbox/<task-id>/files/ticket-ops.json` | the harvester, mechanically |
| `/outbox/<task-id>/files/ticket-ops.md` | the human operator |

They carry the same content. They do not carry the same consequences, and that is the part to
read twice.

**The harvester selects on the filename `ticket-ops.json` and on nothing else** — not on your
role's name, not on what the document turns out to contain. That exact string is what puts a
file through `TicketOpsArtifactSchema` in `src/contracts.ts`, and it is what puts it through the
sweep that looks for the credential's literal bytes in the thing you are about to publish. A
file under any other name is an ordinary artifact: unvalidated and unswept.

**A run that writes only `ticket-ops.md` FAILS.** The harvest looks for a `ticket-ops.md` with no
`ticket-ops.json` beside it, records that "the ticket-ops schema validation and the credential
sweep DID NOT RUN on it; this document is unchecked, not clean", and clamps the verdict to
`failed`. That is deliberate rather than harsh: with neither check run, nothing is known about
what you did to a system of record other people share, and any softer verdict would assert more
than the harvest can support.

Measured, and the reason that check exists: a worker wrote `files/ticket-ops.md`, omitted the
`.json`, and neither the schema check nor the credential sweep ran on the only output that run
produced — including the one that exists to catch you having put the write credential into your
own write-up. At the time, that run reported clean.

The `.md` is not a substitute and it is not the safe half; it is the half nothing inspects. A
malformed `.json` is loud — a schema violation, reported, and it clamps the verdict. An absent
one used to be silent, which was worse; it is loud now, and it still costs you the task.

Per updated field the JSON carries `mode`, `sent`, `read_back` and `match`, so a reader can see
what was asked for, what went out, what came back, and how the two compared — without a
credential for the API and without opening the ticket.

**The credential never appears in either file.** Not in a recorded command, not in a header
dump, not in a URL. When you record the `curl` you ran, record it as the `--config` form you
actually ran — `curl --config /tmp/ticket.curlrc ...` — which names no header value at all. If
you record an expanded header for any reason, elide it as `Authorization: Token <redacted>`.
This is checked.

If the tickets already said what the task wanted, write **both files** with `no_change_needed:
true`, an empty `updates` array, and report `success`. That is a real outcome, not a failure to
find work — and a run with nothing to report is exactly the one most likely to skip the `.json`
on the reasoning that there is nothing in it worth validating. There is: that no write happened
is itself the finding, and the `.json` is where a machine can read it.
