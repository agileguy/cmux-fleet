---
name: observer-docker-ops
description: How the observer-docker role writes its result — the observer-docker-ops.json/.md artifact pair, the brief inputs it reads, the verb grammar its forced command enforces on the target, and the measured facts a worker needs to read a Docker host's results honestly. Mounted for the observer-docker role.
---

# observer-docker-ops

**Scope of this file, stated up front.** This bundle exists so `observer-docker`'s `fleet.yaml`
entry (SRD-OBSERVER-ROLES §5.5) names a real, mounted skill directory rather than a bundle that
is not there. What is documented below is the part the role definition and the target-side script
already fix: the brief inputs, the whole of what the credential can run, the measured shape of
what comes back, and the artifact contract. What is **not** here: the call-budget rule and the
`submit_report` routing paragraph, which live in `roles/observer-docker.md`. Neither file yet
spells out a procedure for turning a mixed `state`/`health`/`logs`/`stats`/`events` read into one
`assessment`.

## Reading your brief (§5.3)

`inputs[]` reaches no prompt. Everything you act on travels in `brief` prose, and the role prompt
and this skill teach you to find these fields there. When one is absent, say so in the artifact
rather than guessing.

| Input | Form | Default when absent |
|---|---|---|
| target | a target TOKEN from the enrolled inventory — list them with the command in "Calling the target, and reading its exit" below, `^[a-z0-9][a-z0-9-]{0,31}$` | none — a word in the brief that is a listed token is the target; if the file lists exactly one token, use it and say so; otherwise the row is `indeterminate` |
| containers | one or more container names, Docker's name grammar `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` | — |
| selector | `label=<key>=<value>` or `name=<pattern>`, used instead of names | if neither names nor a selector is given: every running container, surveyed once and filtered per "Surveying containers when the brief names none" below, and the row says so |
| checks | a closed subset of `state`, `health`, `logs`, `stats`, `events` | `state, health, logs` |
| window | seconds, e.g. `300s` | `300s` |
| question | one sentence | "is it healthy" |
| `sweep_id`, `window_opened_at` | copied verbatim when the brief carries them | `null` |

`checks` is closed for the same reason `roles/observer-k8s.md` gives the k8s role: it bounds read
volume, and a check nobody asked for spends turn the artifact needed.

## Calling the target, and reading its exit

The call form is `observe-docker <target> <verb> [key=value ...]`. `target` is one of the TOKENs
enrolled on this fleet. They live in the file whose PATH is the value of the environment variable
`OBSERVER_DOCKER_TARGETS_FILE` — one `token host port user` line per target, the same file
`docker/observe-ssh` itself reads for the docker kind. The token is the first field on each line.

List them by reading the variable — never a hard-coded `/secrets/...` path — and split fields the
same way `docker/observe-ssh`'s own parser does: on runs of spaces or tabs, skipping any line that
is blank or whose first field starts with `#`:

```
awk 'NF && $1 !~ /^#/ {print $1}' "$OBSERVER_DOCKER_TARGETS_FILE"
```

Only the token belongs in an artifact — never the host, port or user from that same line.

`observe-docker` is a thin alias for `observe-ssh docker <target> <verb> [key=value ...]`; it does
not itself enforce the verb grammar below, the target's forced command does.

A refusal naming the target as not enrolled (`observe-ssh`'s `target <target> is not enrolled in
OBSERVER_DOCKER_TARGETS_FILE` line) is answered by reading the targets file above and calling
again with a token it actually lists — never by guessing another name.

Read the exit status AND the stderr text before you write a row — the exit code alone does not say
who refused what:

| Exit | What it means | What the row says |
|---|---|---|
| `0` | the call succeeded | the channel is `answered`, and its evidence is the output |
| `77` with `observe-ssh: refused before ssh ran` on stderr | your own call was malformed — no ssh connection was even attempted | not a coverage result; fix the call and retry it once |
| `77` with `docker-forced-command: refused "<verb>": not a recognised verb...` on stderr | the credential itself refuses that verb | that channel is `forbidden`, and the task status is `blocked` — for an action verb, the report artifact contract's coverage bullet below names the channel (`state`) |
| `77` with any other `docker-forced-command: refused ...` line on stderr | the target's grammar refused an ARGUMENT, not the verb | your call was malformed; the reason says how — fix it and retry it once, not a coverage result. When the task needs a shape the grammar has no form for at all (a followed log, `stats` for every container), that channel is `forbidden` instead |
| `78` | the fleet did not deliver this worker's configuration | every row you cannot otherwise answer is `indeterminate` with coverage `not_attempted`, and the task status is `blocked` |
| `126` or `127` | `docker` did not run on the target at all — for example, it is not on the account's PATH | rows you cannot otherwise answer are `indeterminate` with coverage `not_attempted`, stderr goes in `evidence_ref`, and the task status is `blocked` |
| `255` | ssh's own failure — a host-key mismatch or a proxy refusal | the target is `unreachable` |
| `1` with `failed to connect to the docker API`, `Cannot connect to the Docker daemon`, or `permission denied while trying to connect to the` on stderr | `docker` on the target could not reach its own daemon — a stopped daemon, an account outside the socket's group, or `DOCKER_HOST` pointing elsewhere | the same as the `126`/`127` row: rows you cannot otherwise answer are `indeterminate` with coverage `not_attempted`, stderr goes in `evidence_ref`, and the task status is `blocked` |
| anything else | docker's own exit, returned from the target (e.g. no such container) | the channel is `answered`, and the error text goes in `evidence_ref` |

Measured on both docker versions: `.docker_errors` in the rendered fixture. A missing container
(`.docker_errors.no_such_container`) also exits 1, with `No such container:` on stderr, and that is
an answer.

A shim-side 77 (the `observe-ssh` line) is not evidence about the target at all — it is a bug in the
call you made, and retrying it once (fixed) costs less turn than reasoning about it as if the target
had refused something. A target-side 77 is not one thing either: the stderr line names either the
VERB the credential refuses outright, or an ARGUMENT its grammar refused — only the first is
`forbidden`. A refused argument is still your call to fix, from the reason the line gives, unless
what the task needs has no form the grammar accepts at all.

## Surveying containers when the brief names none

Run `ps` exactly once, and never repeat an unfiltered call. On 2026-09-15, an unfiltered `ps`
against a real host measured about 39KB of JSON, one line per container, full `Labels` and
`Command` included. Pipe that one call through `jq`, in the worker's own shell (jq is in the
image), and keep only `Names`, `State` and `Status`:

```
set -o pipefail; observe-docker <target> ps | jq -c '{Names, State, Status}'
```

`set -o pipefail` carries `observe-docker`'s own exit code through the pipe. Without it, the shell
reports `jq`'s exit code instead of `observe-docker`'s, and the exit table above stops routing on
the real result; with it, that same exit table still applies to this piped call, the same as to a
bare one. Pick the containers the brief means from the trimmed survey, then query only those by
name (`ps name=<n>`, `inspect`, `logs`). When the brief already names containers or gives a
selector, skip the survey and go straight to name-scoped calls.

## The verb grammar — the whole of what the credential can do (§5.4)

The target-side script accepts exactly these verbs. Arguments are `key=value` tokens, never
flags, so no worker token can become a docker option.

| Verb | Accepted arguments | Runs |
|---|---|---|
| `ps` | `all`; zero or more `name=<n>` or `label=<k>=<v>` | `docker ps --no-trunc --format <FIXED>` plus `--all` and one `--filter` per argument |
| `inspect` | `<container>` | `docker inspect --type container --format <FIXED> <container>` |
| `logs` | `<container> since=<N>s tail=<M>`, both REQUIRED, `M <= 500` | `docker logs --timestamps --since <N>s --tail <M> <container>` |
| `stats` | `<container>` | `docker stats --no-stream --no-trunc --format '{{json .}}' <container>` |
| `top` | `<container>` | `docker top <container>` |
| `events` | `since=<N>s`, optional `container=<c>` | `docker events --since <N>s --until 0s --format '{{json .}}' --filter type=container`, one `--filter event=` for each of the eleven lifecycle-and-health actions (below), plus `--filter container=<c>` when given |
| `info` | — | `docker info --format <FIXED>` |
| `version` | — | `docker version --format '{{json .}}'` |

**`name=<n>` and `label=<k>=<v>` each have their own grammar.** A `label` key and value each match
`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`, at most 128 bytes, and the value may not itself contain `=`. A
value outside that grammar is refused by the target — it is not truncated or escaped, the call
fails. `name=<n>` has no separate grammar of its own beyond the container-name characters; what it
does with the pattern it is given is a matching question, covered below, not a syntax one.

**`top` returns every process's command line, unfiltered, while the call runs.** That includes any
`docker exec` in progress inside the container: its command line is whatever the operator typed, the
same disclosure `ps`'s `Command` field carries below.

**Everything else exits 77 and runs no `docker` at all.** The grammar is an allowlist, so this
list is illustrative rather than the mechanism: `run`, `create`, `start`, `stop`, `restart`,
`kill`, `pause`, `unpause`, `rm`, `rmi`, `exec`, `attach`, `cp`, `export`, `save`, `commit`,
`update`, `rename`, `pull`, `push`, `build`, `compose`, `network`, `volume`, `system` (including
`system dial-stdio`, which is how `docker -H ssh://` gets the full Engine API over SSH), `context`,
`plugin`, `swarm`, `service`, `logs --follow`, and streaming `stats`.

- **`cp`, `export` and `save` are read-shaped, and refused anyway.** Each copies a container's
  filesystem off the host, which is a disclosure hazard the grammar closes regardless of intent.
- **`logs --follow` and streaming `stats` never terminate on their own.** An unbounded, ongoing
  read is refused for the same reason a `tail` is mandatory below: nothing here is allowed to
  outlive the call that asked for it.
- **`system dial-stdio` is the one that matters most to refuse.** It is how `docker -H ssh://`
  tunnels the full Docker Engine API over this same SSH session — every verb above, and every one
  refused, in one command. The grammar is an allowlist precisely so a single missed case like this
  one cannot reopen the whole surface.

**The `inspect` template is fixed on the target, and it is not the whole of `docker inspect`.**
It never includes `.Config.Env` or `.Mounts` — the disclosure boundary the role exists to hold —
and it returns exactly these keys: `id`, `name`, `image`, `created`, `state`, `restart_count`,
`restart_policy`, `labels`, `ports`. `state` is narrowed to exactly `status`, `running`, `paused`,
`restarting`, `oom_killed`, `dead`, `exit_code`, `error`, `started_at`, `finished_at` and `health`.
Docker's own `.State.Health` also carries a `Log` array holding what the healthcheck probe printed;
the template leaves that array out, so the probe's output is never returned. `info`'s template is fixed
the same way, to version, OS, kernel, architecture, CPU count, total memory, container and image
counts, storage driver and cgroup driver — never `HttpProxy`/`HttpsProxy`/`NoProxy` (which can
carry embedded credentials), `RegistryConfig`, `Labels` or swarm details.

### Measured facts, so a result reads honest

Each claim below says what it rests on. Most are measured against real daemons (docker 29.7.2 and
28.5.2) by `scripts/observe/characterise-docker`, and recorded in
`test/fixtures/observe/docker-cli-shapes.json` and
`test/fixtures/observe/docker-forced-command-rendered.json`. A few instead rest on Docker's own
documentation or its CLI source, and say so where they appear — nothing here is asserted without
saying where it comes from:

- **`ps` returns one JSON object per container, one line each, from an 11-field template:**
  `ID`, `Names`, `Image`, `Command`, `CreatedAt`, `RunningFor`, `State`, `Status`, `Ports`,
  `Labels`, `Networks`. There is no `Mounts`, `LocalVolumes`, `Platform` or `Size`: a bind mount's
  host path is the same disclosure `inspect` leaves out. There is also no separate health field:
  Docker's own default `ps --format '{{json .}}'` carries `HealthStatus` on 29.7.2 and not on 28.5.2
  (measured per version: `.runs["<version>"].default_ps_key_set` in the rendered fixture), and
  `docker/cli` source puts the field's introduction at 29.5.0. Health still shows up: it rides
  inside `Status`, e.g. `Up 2 seconds (healthy)` — the forced command's own `Status` value for a
  healthchecked container, measured per version at `.runs["<version>"].ps_health_status`.
  `Command` is the container's full command line, so do not quote it back into an artifact or a
  follow-up call without thinking about what it might carry.
- **`ps`'s `name=` filter is an unanchored regular expression on the name, not a substring and not
  an exact match.** `name=web` lists `myweb`, `web`, `web-2` and `webhook` alike. `name=w.b` lists
  the same four, because `.` matches any character and each of those names contains `web`. Measured: `.runs["<version>"].matching.ps_name_filter` in the rendered fixture.
  The grammar refuses `^` and `$`, so there is no way to anchor the pattern from a worker call.
  **Always check `Names` in every returned row yourself before reporting on a specific container** —
  the filter narrows the query, it does not confirm the answer.
- **`inspect`'s `state.health` is `null` for a container with no healthcheck defined.** That is
  the whole meaning of `null` here: "no healthcheck," not "unhealthy" and not "unknown." When a
  healthcheck exists, `state.health` is an object holding exactly `status` (`starting`, `healthy`
  or `unhealthy`) and `failing_streak` (a number) — nothing else; the probe's log output is not
  part of this template (see above). A container answering `state.health: null` is reporting
  `health` as `answered` — evidence says "no healthcheck defined" — not `not_attempted`.
- **`stats` values are strings, not numbers, and the three paired fields are not all the same
  pair.** `CPUPerc` and `MemPerc` are percentage strings and `PIDs` is a numeric value carried as a
  string. Of the three two-part fields, only `MemUsage` is a used/limit pair; `NetIO` is
  received/sent and `BlockIO` is written/read (Docker's own documentation defines all three this
  way — reading `NetIO` or `BlockIO` as "used of a limit" is a wrong-field mistake, not a rounding
  one). Compare and threshold them as the strings they are, or parse them yourself — the target
  does not hand back numbers.
- **`logs --timestamps` puts a fixed 31-byte prefix on every line**: a 30-byte RFC3339 timestamp
  plus one space, before the log text itself.
- **`logs` needs both `since=<N>s` and `tail=<M>`, and `M` is capped at 500.** Neither is
  optional, the two may come in either order, and nothing else may follow the container. `N` is 1
  to 9 digits and must be at least 1 — `since=0s` exits 77. `tail=0` is accepted.
- **`events` needs `since=<N>s`, and `N` has the same grammar as `logs`'s: 1 to 9 digits, at least
  1.** The target adds `--until 0s`, so the call returns one bounded window and ends on its own; it
  is not a stream. Events from the current second are not returned: an event less than a second
  old arrives on a later call, not this one. Every event carries at least the keys `Type`, `Action`,
  `Actor`, `scope`, `time` and `timeNano`, and the container's name is in `Actor.Attributes.name`.
  Docker 28.x also sends three more, deprecated keys — `status`, `id` and `from` — that 29.x drops
  (measured per version: `.runs["<version>"].cases[].key_sets` in the rendered fixture). Key order is
  not a promise Docker or this target makes; read the object by key, never by position, and do not
  assume a key beyond the first six is there on every daemon.
- **`events container=<c>` matches a prefix of the container's name OR its id — not a substring, and
  not the `ps` regex.** `container=web` returns events for `web`, `web-2` and `webhook`, but not
  `myweb`. `container=w.b` returns nothing, because `.` is not a wildcard here the way it is in
  `ps`'s `name=`. The first 12 characters of a container's id return that container too. So a name
  made only of hex characters (`db`, `cafe`) can match another container's id: keep only the events
  whose `Actor.Attributes.name` equals the container you asked about. Measured:
  `.runs["<version>"].matching.events_container_filter` in the rendered fixture (it uses
  `container=ebh`, because `eb` is itself hex).
- **`events` returns container lifecycle and health events only:** `create`, `start`, `restart`,
  `stop`, `die`, `kill`, `oom`, `pause`, `unpause`, `destroy` and `health_status` — eleven actions,
  fixed on the target (`.events.action_allowlist.filters` in the shapes fixture). `health_status`'s
  action text reads like `health_status: healthy`, measured per version at
  `.runs["<version>"].cases[].actions_raw` in the rendered fixture. No `exec_*` action ever comes
  back, because each one names the exec'd command line and an operator's `docker exec` can carry a
  secret there.
- **The daemon keeps a bounded buffer of past events, and it is smaller than it looks.** Measured
  (`.events.buffer` in the shapes fixture): after 120 `docker exec` calls against one container, an
  unfiltered query returned a few hundred events, that container's earlier `start` event was gone,
  and the query with this target's action filter returned nothing at all. A healthcheck probe runs
  as an exec too, so it likely fills the buffer the same way; only the `docker exec` flood was
  measured.
  **An empty or quiet-looking `events` result is not proof nothing happened in the
  window** — it can just as easily mean the buffer already rolled past it. Cross-check with
  `inspect`'s `started_at` and `restart_count` before reporting a window as quiet.

## Bounded reads, and why every one of them is

**`tail` is mandatory and capped because an unbounded log pull hits the 50KB tool-output wall and
is clipped from the front — exactly the window the question was about**
(`skills/observer-ops/SKILL.md`'s own "50KB wall" section explains the same failure for `kubectl
logs`). The truncation notice looks like this:

```
WARNING: OUTPUT TRUNCATED - the text below is NOT the whole output.
    kept  49.9KB of 61.6KB (225 of 297 lines), clipped from the FRONT - the limit hit was 50.0KB
```

**Clipped from the FRONT is the dangerous half.** The oldest lines go first, so the start of the
window you asked about is exactly what you lose, and what survives is a tail you would have got
from a much narrower `tail=` anyway. A verdict drawn from a truncated dump is a verdict about the
last few seconds wearing the label of the whole window.

That is why the grammar itself, not just good practice, makes `tail=<M>` required and caps it at
500 for `logs`, and why `events` carries a terminating bound rather than a stream. **The cap bounds
lines, not bytes, and a single capped call can blow the wall on its own:** `tail=500` of roughly
100-byte log lines, each carrying `logs --timestamps`'s 31-byte prefix, comes to about 65KB — past
the 50KB wall before a second container or a second check even enters the picture. Default to a
narrower `tail`, `tail=100` answers most questions, and keep `since`/`window` no wider than the
question needs; reach for `tail=500` only when the question genuinely requires that much history.
Read one container at a time, and if a call still truncates, re-run it bounded once and say so in
the artifact rather than fetching a third time.

## The report artifact contract (§5.6)

Two files in `/outbox/<task-id>/files/`: `observer-docker-ops.json` and `observer-docker-ops.md`,
both every time, declared in `artifacts[]`, sent through `submit_report`. A run that writes only
the `.md` clamps to `failed` — the same rule `observer-ops` and `ticketing` run under, and for the
same reason: the file nothing inspects is the one that was supposed to carry the evidence.

The JSON keeps the same document fields and row gate fields as `observer-ops.json`
(`skills/observer-ops/SKILL.md`), so `assessment`, `coverage[].result` and the four evidence
fields (`coverage`, `selector`, `window`, `evidence_ref`) mean the same thing in every observer
role. It adds one literal, `schema`, because harvest validation selects the file by its name and
confirms it by that declared kind (`src/harvest/reconcile.ts`).

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
      "assessment": "healthy",
      "coverage": [
        {"channel": "state", "result": "answered"},
        {"channel": "health", "result": "answered"},
        {"channel": "logs", "result": "answered"}
      ],
      "selector": "name=web-1",
      "window": "300s",
      "evidence_ref": ["observe-docker docker-host-a inspect web-1: State.Status=running, Health=healthy, RestartCount=0"],
      "container_id": "1b9b66a422e957b5bb5c1b3aa508f33b0d291da0953231a811863fcd9c623849",
      "image": "web:1.4.2",
      "restart_count": 0
    }
  ]
}
```

- **`services[]` keeps its name, and one row is one container.** `namespace` carries the TARGET
  TOKEN — the named scope the container lives in on this target — the same key `observer-ops`
  uses for a Kubernetes namespace, reused rather than renamed.
- **`coverage[].channel` is closed to `state`, `health`, `logs`, `stats`, `events`.**
  **`coverage[].result`** and **`assessment`** are the same closed enums `observer-ops` uses:
  `answered | unreachable | forbidden | not_attempted` and
  `healthy | degraded | unhealthy | indeterminate`. `failed` is a TASK status, never an
  `assessment` — a fifth token there voids the whole document, not just the row.
- **A refused VERB is `forbidden`, and the task status is `blocked`.** A refused ARGUMENT is not: fix
  the call from the stderr reason and retry it once. When the task needs a shape the grammar has no
  form for at all (a followed log, `stats` for every container), that channel is `forbidden` too. A
  container with no healthcheck is not a refusal: `health` is `answered`, and the evidence says so.
- **An action verb — restart, stop, start, kill, rm, exec, pause, or any other change to a
  container — is not one of the checks either.** Call it once anyway, so the refusal lands on
  record, then read the exit table's `77` row whose stderr reads `docker-forced-command: refused
  "<verb>": not a recognised verb`. Record `state` as `forbidden`, the row `indeterminate`, the
  refusal line in `evidence_ref`, and the task status `blocked`. Marking every channel
  `not_attempted` is wrong here — the call answered, with a refusal, and that refusal names a real
  channel.
- **`container_id`, `image` and `restart_count` are optional.** Include them when `inspect`
  answered; leave them out rather than guess when it did not. `container_id` is the full,
  untruncated id `inspect` returns (64 hex characters), the same one `--no-trunc` and `.Id` give —
  never the 12-character short form.
- **Copy `sweep_id` and `window_opened_at` out of the brief, verbatim, and from nowhere else** —
  not from your transcript, not reconstructed from the clock. An artifact whose `sweep_id` does
  not match is discarded whole.
- **Harvest validates the JSON by name, sweeps it for `OBSERVER_DOCKER_SSH_KEY`'s value, and
  clamps an orphaned `.md` to `failed`.**

## Enrolling a target (§5.7) — operator reference, never a worker's task

This is here so the artifact's `namespace`/target token and the credential's reach make sense; a
worker never runs any of it.

1. Create a non-root account on the target, a member of the `docker` group — root-equivalent on
   the target, with the forced command the only thing between the key and that root. Its login
   shell must be `/bin/sh`: sshd runs the forced command through the account's shell, and anything
   richer is surface this role does not need.
2. Install `scripts/observe/docker-forced-command` root-owned, mode `0755`, at a path the account
   cannot write. The account's home directory and its `~/.ssh` must be root-owned and not writable
   by the account itself — an account that could write either could replace the forced command's
   reach or its own `authorized_keys` line.
3. Add one `authorized_keys` line:
   `restrict,command="<installed path>" ssh-ed25519 <public key> pifleet-observer-docker`.
4. Configure sshd so no environment reaches the forced command from the client — this is four
   settings, not one, because `AcceptEnv` alone is not the whole path an environment variable takes:
   - `AcceptEnv` passes nothing through for this account. Inside a `Match User` block, OpenSSH's
     `AcceptEnv` directive itself needs at least one variable name to parse (checked with
     `sshd -T` on OpenSSH 10.3p1) — name one no client ever sends, e.g. `OBSERVER_DOCKER_UNUSED`,
     rather than a real one.
   - No `SetEnv` for the account. `SetEnv` hands the forced command a value regardless of what the
     client asks for, and does not go through `AcceptEnv` at all.
   - `PermitUserEnvironment no` (the default). With it off, an `environment=` option on the
     `authorized_keys` line and the account's `~/.ssh/environment` file are both ignored, so neither
     can hand the forced command a variable behind `AcceptEnv`'s back.
   - No `user_readenv` in this account's PAM stack, so `~/.pam_environment` is never read, and step
     2's root-owned home leaves the account nowhere to write one. A `PATH` that root sets through a
     stock `pam_env` and `/etc/environment` is fine, as long as it resolves `docker`.

   The forced command inherits whatever survives all four. An accepted `PATH` can make `docker`
   resolve to another binary, and an accepted `DOCKER_*` variable (`DOCKER_HOST` chief among them)
   can point its `docker` calls somewhere other than the local socket — so the account's own `PATH`
   must resolve `docker` on its own, with nothing above able to override it. That `PATH` can come
   from sshd's own default, from a root-owned `pam_env` directive, or from `/etc/environment` — never
   from the account itself. `IFS`, `ENV` and `BASH_ENV` stay hardening rather than something this step
   must forbid on its own. The forced command sets its own `IFS` before it splits
   `SSH_ORIGINAL_COMMAND`, so an inherited `IFS` never reaches its argument parsing. The `IFS=:` cases
   in the unit tests and the rendered fixture only show that sh, dash and busybox sh ignore an
   inherited `IFS`; they cannot fail on the script. `ENV` and `BASH_ENV` rely on step 1's `/bin/sh` login shell: a `bash` started as `bash -c`
   reads `BASH_ENV`, but a `bash` started as `sh` (as `/bin/sh` may itself be) does not.

   Verify afterward: `sshd -T -C user=<account>,host=<host>,addr=<addr>` for this account's effective
   `AcceptEnv`, `SetEnv` and `PermitUserEnvironment`; `getent passwd <account>` showing `/bin/sh`; and
   one `version` call through the key.
5. Record the target's host key in `OBSERVER_DOCKER_KNOWN_HOSTS`, and add
   `token host port user` to `OBSERVER_DOCKER_TARGETS`.
6. Add `{host, port}` to `egress.allow` in `fleet.yaml`, and add the three secret names to
   `secrets.env_allowlist`.
