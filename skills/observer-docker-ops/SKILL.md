---
name: observer-docker-ops
description: How the observer-docker role writes its result — the observer-docker-ops.json/.md artifact pair, the brief inputs it reads, the verb grammar its forced command enforces on the target, and the measured facts a worker needs to read a Docker host's results honestly. Mounted for the observer-docker role.
---

# observer-docker-ops

**Scope of this file, stated up front.** This bundle exists so `observer-docker`'s `fleet.yaml`
entry (SRD-OBSERVER-ROLES §5.5) names a real, mounted skill directory rather than a bundle that
is not there. What is documented below is the part the role definition and the target-side script
already fix: the brief inputs, the whole of what the credential can run, the measured shape of
what comes back, and the artifact contract. What is **not** here: the procedure for turning a
mixed `state`/`health`/`logs`/`stats`/`events` read into one `assessment`, the call-budget rule,
and the `submit_report` routing paragraph. Those belong to `roles/observer-docker.md` (§5.5, a
later task) and reuse `roles/observer-k8s.md`, the same way `observer-ops` leaves its own procedural
content to a later piece of work.

## Reading your brief (§5.3)

`inputs[]` reaches no prompt. Everything you act on travels in `brief` prose, and the role prompt
and this skill teach you to find these fields there. When one is absent, say so in the artifact
rather than guessing.

| Input | Form | Default when absent |
|---|---|---|
| target | a target TOKEN from the enrolled inventory, `^[a-z0-9][a-z0-9-]{0,31}$` | none — if the inventory holds exactly one target, use it and say so; otherwise the row is `indeterminate` |
| containers | one or more container names, Docker's name grammar `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` | — |
| selector | `label=<key>=<value>` or `name=<substring>`, used instead of names | if neither names nor a selector is given: every running container, `ps` only, and the row says so |
| checks | a closed subset of `state`, `health`, `logs`, `stats`, `events` | `state, health, logs` |
| window | seconds, e.g. `300s` | `300s` |
| question | one sentence | "is it healthy" |
| `sweep_id`, `window_opened_at` | copied verbatim when the brief carries them | `null` |

`checks` is closed for the same reason `roles/observer-k8s.md` gives the k8s role: it bounds read
volume, and a check nobody asked for spends turn the artifact needed.

## The verb grammar — the whole of what the credential can do (§5.4)

The target-side script accepts exactly these verbs. Arguments are `key=value` tokens, never
flags, so no worker token can become a docker option.

| Verb | Accepted arguments | Runs |
|---|---|---|
| `ps` | `all`; zero or more `name=<n>` or `label=<k>=<v>` | `docker ps --no-trunc --format <FIXED>` plus `--all` and one `--filter` per argument |
| `inspect` | `<container>` | `docker inspect --type container --format <FIXED>` |
| `logs` | `<container> since=<N>s tail=<M>`, both REQUIRED, `M <= 500` | `docker logs --timestamps --since <N>s --tail <M> <container>` |
| `stats` | `<container>` | `docker stats --no-stream --no-trunc --format '{{json .}}' <container>` |
| `top` | `<container>` | `docker top <container>` |
| `events` | `since=<N>s`, optional `container=<c>` | `docker events --since <N>s --until 0s --format '{{json .}}'`, plus `--filter container=<c>` when given |
| `info` | — | `docker info --format <FIXED>` |
| `version` | — | `docker version --format '{{json .}}'` |

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
and it returns exactly these keys: `id`, `name`, `image`, `created`, `state` (Docker's own
`.State`, `Health` included, since Health lives inside State), `restart_count`,
`restart_policy`, `labels`, `ports`. `info`'s template is fixed the same way, to version, OS,
kernel, architecture, CPU count, total memory, container and image counts, storage driver and
cgroup driver — never `HttpProxy`/`HttpsProxy`/`NoProxy` (which can carry embedded credentials),
`RegistryConfig`, `Labels` or swarm details.

### Measured facts, so a result reads honest

These are measured against a real daemon (`test/fixtures/observe/docker-cli-shapes.json`,
`scripts/observe/characterise-docker`), not assumed from Docker's documentation:

- **`ps` returns one JSON object per container, one line each,** built from a fixed field set:
  `ID`, `Names`, `Image`, `Command`, `CreatedAt`, `RunningFor`, `State`, `Status`,
  `HealthStatus`, `Ports`, `Labels`, `Networks`. There is no `Mounts`, `LocalVolumes`, `Platform`
  or `Size`: a bind mount's host path is the same disclosure `inspect` leaves out. `HealthStatus`
  is `none` for a container without a healthcheck.
- **`name=` filters match as a SUBSTRING, not an exact name.** `name=web` also lists a container
  named `myweb` (measured: against four containers named `char-*`, `name=char` matched all four and
  `name=char-plain` matched one). Check `Names` in every returned row yourself before reporting on a
  specific container — the filter narrowed the query, it did not confirm the answer.
- **`inspect`'s `state.Health` is `null` for a container with no healthcheck defined.** That is
  the whole meaning of `null` here: "no healthcheck," not "unhealthy" and not "unknown." When a
  healthcheck exists, `state.Health` is an object holding `Status` (`starting`, `healthy` or
  `unhealthy`), `FailingStreak` (a number), and `Log`, an array of entries each holding `Start`,
  `End`, `ExitCode` and `Output`. A container answering `state.Health: null` is reporting `health`
  as `answered` — evidence says "no healthcheck defined" — not `not_attempted`.
- **`stats` values are strings, not numbers.** `CPUPerc` and `MemPerc` are percentage strings,
  `MemUsage`, `NetIO` and `BlockIO` are `"used / limit"` pairs as strings, and `PIDs` is a numeric
  value carried as a string. Compare and threshold them as the strings they are, or parse them
  yourself — the target does not hand back numbers.
- **`logs` needs both `since=<N>s` and `tail=<M>`, and `M` is capped at 500.** Neither is
  optional, the two may come in either order, and nothing else may follow the container. `N` is
  one to ten digits, and `tail=0` is accepted.
- **`events` needs `since=<N>s` and returns a bounded window, not a stream.** The target adds
  `--until 0s`, so the call returns the window's events and ends on its own. Each line is one
  JSON object with keys `Type`, `Action`, `Actor`, `scope`, `time`, `timeNano`. Key order is not a
  promise Docker or this target makes; read the object by key, never by position.

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
500 for `logs`, and why `events` carries a terminating bound rather than a stream: a call this
skill lets you make cannot by itself blow the wall, but a call that ignores its own cap — or one
answered across several containers without narrowing first — still can. Read one container at a
time, keep `tail` and `window` no wider than the question needs, and if a call still truncates,
re-run it bounded once and say so in the artifact rather than fetching a third time.

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
      "container_id": "3f2a9c1b7e4d",
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
- **A refused verb is `forbidden`, and the task status is `blocked`.** A container with no
  healthcheck is not a refusal: `health` is `answered`, and the evidence says so.
- **`container_id`, `image` and `restart_count` are optional.** Include them when `inspect`
  answered; leave them out rather than guess when it did not.
- **Copy `sweep_id` and `window_opened_at` out of the brief, verbatim, and from nowhere else** —
  not from your transcript, not reconstructed from the clock. An artifact whose `sweep_id` does
  not match is discarded whole.
- **Harvest validates the JSON by name, sweeps it for `OBSERVER_DOCKER_SSH_KEY`'s value, and
  clamps an orphaned `.md` to `failed`.**

## Enrolling a target (§5.7) — operator reference, never a worker's task

This is here so the artifact's `namespace`/target token and the credential's reach make sense; a
worker never runs any of it.

1. Create a non-root account on the target, a member of the `docker` group — root-equivalent on
   the target, with the forced command the only thing between the key and that root.
2. Install `scripts/observe/docker-forced-command` root-owned, mode `0755`, at a path the account
   cannot write.
3. Add one `authorized_keys` line:
   `restrict,command="<installed path>" ssh-ed25519 <public key> pifleet-observer-docker`.
4. Record the target's host key in `OBSERVER_DOCKER_KNOWN_HOSTS`, and add
   `token host port user` to `OBSERVER_DOCKER_TARGETS`.
5. Add `{host, port}` to `egress.allow` in `fleet.yaml`, and add the three secret names to
   `secrets.env_allowlist`.
