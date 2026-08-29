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
| `TICKET_API_TOKEN` | env, via the worker's `secrets:` selector | the write credential |
| `TICKET_BASE_URL` | env | `https://<TICKET_HOST>/api/v2` |
| ticket ids | the task envelope, and **only** there | the objects you may touch |

`HTTPS_PROXY` is set for you if the fleet routes egress through one. You do not set it, and you
do not need a Google identity — this role is configured without one.

If `TICKET_API_TOKEN` is unset or empty, that is `blocked`, not `failed`, and not something to
work around. It means the worker's `secrets:` selector did not name it or the fleet's
`secrets.env_allowlist` did not permit it.

## Calling the API

```bash
curl -sS --fail-with-body \
     -H "Authorization: Token ${TICKET_API_TOKEN}" \
     -H 'Accept: application/json' \
     "${TICKET_BASE_URL}/issue/${ID}" -o /tmp/issue.json
```

Four rules about that command, each of which has a failure behind it:

- **`--fail-with-body`, never bare `-s`.** Without it `curl` exits 0 on a 401 and you parse the
  error page as a ticket. With it you get the non-zero exit *and* the body that explains it.
- **The token goes in a header, never in the URL.** A query string is logged by every proxy on
  the path, lands in the server's access log, and appears in your own shell history. There is no
  endpoint here worth reaching that requires it.
- **Never `echo` the token, and never `set -x` a block that uses it.** Your session transcript is
  read by the orchestrator and by a human. Expand it inside the `curl` invocation and nowhere
  else.
- **Write bodies to a file, not to a variable you later echo.** It keeps large payloads out of
  the transcript, and it gives you the exact bytes to diff against the read-back.

Read the fields you need with `jq -r '.fields.summary'`. Reason over the JSON in the container.
Do not paste it into your result envelope.

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

## The artifact

Write `/outbox/<task-id>/files/ticket-ops.json` and `ticket-ops.md` — the same content, once for
a machine and once for a person. The JSON is validated against
`TicketOpsArtifactSchema` in `src/contracts.ts`; a malformed one is a build failure, not a
surprise at read time.

Per updated field the JSON carries `mode`, `sent`, `read_back` and `match`, so a reader can see
what was asked for, what went out, what came back, and how the two compared — without a
credential for the API and without opening the ticket.

**The credential never appears in either file.** Not in a recorded command, not in a header
dump, not in a URL. When you record the `curl` you ran, record it with the header value elided
as `Authorization: Token <redacted>`. This is checked.

If the tickets already said what the task wanted, write the artifact with `no_change_needed:
true`, an empty `updates` array, and report `success`. That is a real outcome, not a failure to
find work.
