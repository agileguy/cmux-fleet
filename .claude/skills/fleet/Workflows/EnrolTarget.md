# EnrolTarget

Enrolling one target — a Docker host for `obs-d1`, or a Linux VM for `obs-v1` — so a
seat that already exists in `fleet.yaml` can reach it, and confirming the boundary
holds before you trust it.

**Operator work, start to finish.** SRD-OBSERVER-ROLES §10 Q13 answers this
directly: target enrolment is operator-applied, never something a worker or an
engineer does on your behalf. Nothing in this file is a brief you hand to a
seat — it is what you, at a shell with access to the target and to this repo's
`fleet.yaml`, do yourself. `obs-d1` and `obs-v1` only start answering questions
once you have finished it.

Read `Workflows/DispatchTask.md` before this file if you have not dispatched to
the fleet before — the envelope shape and the collect-and-relay step it
describes are reused here without repeating them.

## Before you begin

- One Docker host and one Linux VM, both reachable by SSH from wherever the
  fleet's CONNECT proxy dials out from, neither enrolled yet.
- `fleet.yaml` already declares the `observer-docker` and `observer-vm` roles and
  the seats `obs-d1`/`obs-v1` (SRD-OBSERVER-ROLES §5.5, §6.6) — that is prior
  work, not something this file does. What is missing is the target-specific
  material: the account on each target, its host key, its inventory line, its
  `egress.allow` rule, and the secret values.
- **Pick a container on the Docker host, and the VM itself, that you can
  genuinely afford to have interrupted.** The last step in this file
  deliberately asks the fleet to restart that container and reboot that VM.
  The whole point of the step is finding out whether the credential refuses —
  and if the boundary has a bug, the alternative to finding that out here is
  finding it out some other way. Do not enrol a container or a VM you are not
  prepared to see stopped for real.

---

## 1. Create the account and the forced command on each target

The settings themselves — the account, the forced command, the
`authorized_keys` line, and the four settings (`AcceptEnv`, `SetEnv`,
`PermitUserEnvironment`, plus the account's PAM stack) that keep the client's
environment out of the forced command's way — are specified once each, not
copied here a third time. Follow them from the source, in order:

- Docker host: `skills/observer-docker-ops/SKILL.md` § "Enrolling a target
  (§5.7) — operator reference, never a worker's task"
- Linux VM: `skills/observer-vm-ops/SKILL.md` § "Enrolling a target (§6.2) —
  operator reference, never a worker's task"

Both sections walk the same five things in the same order: the non-root
account, the forced command's install, the one `authorized_keys` line, the
four settings (`AcceptEnv`, `SetEnv`, `PermitUserEnvironment`, plus the
account's PAM stack), and a verify-afterward check. Do them in that order —
each step assumes the one before it is already true on the target.

**The VM account also needs journal read access, and its group name is not
asserted here.** `skills/observer-vm-ops/SKILL.md` names `adm` as the
journal-reader group on Ubuntu 24.04 and says explicitly to confirm it on the
target rather than assume it holds elsewhere; SRD-OBSERVER-ROLES §6.2 makes the
same point — the group is distribution-specific. This file does not add a
second guess for any other distribution. If your VM is not Ubuntu 24.04, find
its journal-reader group on the target itself (commonly whichever group owns
`/var/log/journal`, but confirm rather than assume that too) before you add the
account to it.

**Verify afterward, both targets, before you go near a key or a secret:**

```bash
sshd -T -C user=<account>,host=<host>,addr=<addr>   # AcceptEnv, SetEnv, PermitUserEnvironment
getent passwd <account>                              # shell is /bin/sh
```

Then one call through the key once it exists — `version` for the Docker
account, `uptime` for the VM account — is the last check, and it belongs after
step 5 below, once the key and the inventory line both exist. Coming back to it
there is deliberate: a check that needs a secret this file has not yet
delivered cannot run yet.

---

## 2. Capture the target's host key — never through the fleet's own proxy

The shim that will carry every call to this target runs `ssh` with
`StrictHostKeyChecking=yes` (SRD-OBSERVER-ROLES §5.2). That is not a preference
— it is why a wrong or missing key refuses every single call rather than
silently trusting whatever answers on the wire. Which means the reverse is also
true: if you let the fleet fetch that key for you on its first connection,
you have traded a host-key check for a trust-on-first-use one, and the whole
point of the setting is gone.

**Get the key from a channel you already trust, and check its fingerprint out
of band from that same trusted channel** — the machine's own console, a cloud
provider's dashboard that shows the host key it provisioned, or a direct SSH
session you already trust for another reason. Do not fetch it by SSHing to the
target through the fleet's CONNECT proxy; that is the exact trust-on-first-use
path this design refuses to take.

**One host name, three places, and it has to be the identical string in
each.** The inventory line's `host` field (step 3), the `egress.allow`
entry's `host` (step 4), and this known_hosts line's own hostname field all
name the same target, and nothing cross-checks the other two for you:

- `docker/observe-ssh` dials `found_host` — the inventory line's `host` field
  and nothing else — as the literal ssh target.
- `docker/connect-proxy.cjs` matches the CONNECT authority's host against
  `egress.allow` exactly, with no DNS lookup done first — a name that does
  not match what `observe-ssh` just dialled is refused before a byte reaches
  the target.
- With `StrictHostKeyChecking=yes`, ssh looks the key up in the known_hosts
  file under the exact name it dialled — written `[host]:port` when the port
  is not 22 — so a known_hosts line captured under any other name never
  matches.

A key captured from a trusted channel almost always carries the machine's own
name or address, from whatever console or fingerprint tool produced it, not
the inventory token or alias you are about to give this target in steps 3 and
4. Rewrite the known_hosts line's hostname field to that exact string before
it goes anywhere near `OBSERVER_..._KNOWN_HOSTS`.

Once you have a key you trust, its known_hosts line goes in
`OBSERVER_DOCKER_KNOWN_HOSTS` (Docker) or `OBSERVER_VM_KNOWN_HOSTS` (VM) — see
step 5 for how these values actually reach the seat. `observer-docker-ops`'s
exit-code table gives you the failure mode to expect if this step is wrong or
skipped: exit `255`, "ssh's own failure — a host-key mismatch or a proxy
refusal," reported as the target being unreachable. If every call to a target
comes back `255` after enrolment, re-check the key before anything else — and
check the name match above first: a known_hosts line whose hostname field
still carries the machine's own name, rather than the name from steps 3 and
4, produces exactly this failure.

---

## 3. Add the target to the inventory

One line, `token host port user`, in `OBSERVER_DOCKER_TARGETS` (Docker) or
`OBSERVER_VM_TARGETS` (VM) — the same file the worker's shim reads to resolve a
`target` token from the brief. `token` follows the grammar
SRD-OBSERVER-ROLES §5.3 "Envelope inputs" gives the `target` field:
`^[a-z0-9][a-z0-9-]{0,31}$`. `host` and `port` are what `ssh` dials; `user` is
the account step 1 created.

```
dock-a docker-host.example.com 22 svc-docker-ro
```

```
vm-a vm-1.example.com 22 svc-vm-ro
```

(`docker-host.example.com`, `vm-1.example.com`, and both account names above
are placeholders — SRD-OBSERVER-ROLES §0.3. What goes here for real is either
your target's real hostname, or an alias resolved on the machine that runs
the fleet — see step 4 for the pattern the live `fleet.yaml` actually uses,
and why an alias is a legitimate answer here rather than a workaround.
Whichever you use, it must be the exact same string as the `egress.allow`
entry in step 4 and the known_hosts line's hostname field in step 2 — see
step 2's "one host name, three places.")

If the inventory ends up holding exactly one target, a brief that never names
one still resolves — both skills default `target` to "the single enrolled
target, stated in the artifact." Name it anyway once you have more than one.

---

## 4. Wire `fleet.yaml`: the egress rule, the secret names, then validate

Two edits to `fleet.yaml`, both yours to make — SRD-OBSERVER-ROLES §10 Q13
again: the rename was engineer-editable, enrolment is operator-applied,
because this is the step that writes a real hostname into a file the repository
tracks.

**The egress rule.** One `{host, port}` entry per target, under `egress.allow`:

```yaml
egress:
  allow:
    - {host: docker-host.example.com, port: 22}   # a real, non-sensitive hostname
    - {host: pifleet-vm, port: 22}                 # or an /etc/hosts alias — see below
```

SRD-OBSERVER-ROLES §10 Q3 is why this is where a target hostname is allowed to
live in a tracked file at all: accepted 2026-09-13, and only for targets whose
hostnames are not sensitive.

**A name here does not have to be a public DNS name.** The live `fleet.yaml`
enrols its own `observer-docker` and `observer-vm` targets this way, and its
`egress.allow` comment states the pattern plainly: each name is an
`/etc/hosts` alias on the machine that runs the fleet, not a DNS name — the
proxy matches the CONNECT name before any lookup, then the relay resolves it
through Colima's host resolver, which reads that machine's `/etc/hosts`. A
machine without the alias will usually fail closed: the name does not
resolve and the target reads as unreachable. That is the common case, not
the guarantee — the next paragraph is. Use `pifleet-docker`/`pifleet-vm`-style aliases the same way when your
target's real hostname or address is what has to stay private; a real,
resolvable hostname is equally legitimate when it is not sensitive.

What actually makes either one safe is `StrictHostKeyChecking=yes` (step 2),
not whether the name resolves at all: whatever name you write here, and
however it resolves, ssh only proceeds past the host-key check for a target
whose key you captured and trusted yourself, so an alias — or a name pointed
somewhere it should not be — cannot be quietly repointed at a different
machine without every subsequent call refusing at that check. This file makes
no claim about how your resolver handles a bare alias versus a search domain
— that is unmeasured; what is measured is the alias-in-this-machine's-
`/etc/hosts` shape the fleet itself runs.

If your target's hostname itself has to stay private and an alias is not an
option for you either, that is a repository-visibility problem this file
cannot solve for you.

`egress.allow` is fleet-wide, not per-role (SRD-OBSERVER-ROLES §7.2 layer 5):
every routed worker gets a route to this host and port. The key that actually
opens a session is delivered only to the role that holds it, so the rule alone
buys nothing without step 5.

**The three secret names per role**, already the shape SRD-OBSERVER-ROLES §5.5
and §6.6 give them — a credential name swept as a needle, and two
`credential: false` names that legitimately appear in an artifact (a host
token, an inventory line):

```yaml
secrets:
  env_allowlist:
    - {name: OBSERVER_DOCKER_SSH_KEY, multiline: true}
    - {name: OBSERVER_DOCKER_KNOWN_HOSTS, credential: false, multiline: true}
    - {name: OBSERVER_DOCKER_TARGETS, credential: false, multiline: true}
    - {name: OBSERVER_VM_SSH_KEY, multiline: true}
    - {name: OBSERVER_VM_KNOWN_HOSTS, credential: false, multiline: true}
    - {name: OBSERVER_VM_TARGETS, credential: false, multiline: true}
```

Every one of the six carries `multiline: true`. Without it `buildWorkerEnv`
refuses the value outright at `up` (SRD-OBSERVER-ROLES §5.5) — an SSH key, a
known_hosts file and an inventory list are each one entry per line, and the
mark is what lets a granted value carry an embedded newline at all. If these
six lines are already in your `fleet.yaml` — Phase 4 and 5 add them as part of
standing the roles up — this half of the step is already done; check rather
than duplicate the block.

**Then validate before you go any further:**

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts config validate --config fleet.yaml
```

A clean run lists `observer-docker` and `observer-vm` among the roles and
`obs-d1`/`obs-v1` among the workers. It cannot yet tell you whether the target
itself is reachable — that is steps 6 and 7.

---

## 5. Where the secret values actually come from

`buildWorkerEnv` (`src/run/worker-env.ts`) is what turns `secrets:` into
values a container gets. It takes a `hostEnv` argument, and that argument is
not a file or a vault — it is `process.env`, read from the process running
`pifleet up` itself. Two call sites confirm it: `up`'s own pre-flight check
(`assertSecretsResolvable`, `src/cli/commands/up.ts`) and the launch path that
actually builds each worker's environment (`src/run/materialize.ts`) both pass
`process.env` straight through. So a granted secret's value has to already be
set in the shell you run `up` from — nothing in this repository reads it from
anywhere else.

**The value also lands on the host's disk, for the life of the run.** `up`
writes each granted secret to its own file under
`<run>/workers/<id>/secrets/`, mode `0444`, inside a worker directory `up`
tightens to `0700` for exactly this reason (`src/run/materialize.ts`, around
lines 1111-1138). The container's read-only `/secrets` mount reads from this
same directory. So the key is not confined to the container: it sits as a
plaintext file on the host for as long as the run exists, readable by
whichever host account can reach that `0700` directory.

**A multiline value is a value, not a file path, with embedded LF line
endings and no carriage return.** `buildWorkerEnv` refuses a newline in any
granted value unless its `secrets.env_allowlist` entry says `multiline: true`
(step 4 already marked all six that way), and even a marked entry refuses a
value that contains `\r` — a CRLF key or line list is malformed to the tools
that read it (`src/run/worker-env.ts`). Concretely: the SSH private key and
the known_hosts and inventory files' contents need to reach `up`'s own
process environment, with LF endings preserved and no CR — reading a file
straight into a variable with your shell's own command substitution keeps
embedded newlines intact.

**Scope these to the one command that needs them, never to a bare `export`
in your interactive shell** — a variable exported there is inherited by
every later child process for the rest of the session, which is a much wider
hold on a private key than `up` needs. A one-command environment prefix does
it:

```bash
cd ~/repos/cmux-fleet && \
OBSERVER_DOCKER_SSH_KEY="$(cat /path/to/key)" \
OBSERVER_DOCKER_KNOWN_HOSTS="$(cat /path/to/known_hosts-line)" \
OBSERVER_DOCKER_TARGETS="$(cat /path/to/targets-file)" \
OBSERVER_VM_SSH_KEY="$(cat /path/to/vm-key)" \
OBSERVER_VM_KNOWN_HOSTS="$(cat /path/to/vm-known_hosts-line)" \
OBSERVER_VM_TARGETS="$(cat /path/to/vm-targets-file)" \
bun run src/cli/index.ts up --workers <id>
```

or the same values `export`ed inside a subshell that also runs `up`, so
nothing survives past the closing parenthesis:

```bash
(
  export OBSERVER_DOCKER_SSH_KEY="$(cat /path/to/key)"
  export OBSERVER_DOCKER_KNOWN_HOSTS="$(cat /path/to/known_hosts-line)"
  export OBSERVER_DOCKER_TARGETS="$(cat /path/to/targets-file)"
  export OBSERVER_VM_SSH_KEY="$(cat /path/to/vm-key)"
  export OBSERVER_VM_KNOWN_HOSTS="$(cat /path/to/vm-known_hosts-line)"
  export OBSERVER_VM_TARGETS="$(cat /path/to/vm-targets-file)"
  cd ~/repos/cmux-fleet && bun run src/cli/index.ts up --workers <id>
)
```

Either form is what step 6's `up --workers obs-d1`/`obs-v1` command actually
means to run — reapply the same wrapping there rather than typing a bare
`export` first and running `up` as a separate, later command.

If your key file has CRLF endings, convert it first — `buildWorkerEnv` refuses
a CR unconditionally, marked or not. This file does not specify a particular
secret store for holding these values between sessions; `up` only needs them
present in its own process's environment at the moment it runs.

Once the key exists in the environment `up` will use, go back and run the last
check step 1 deferred — `version` (Docker) or `uptime` (VM) through the key,
by hand from wherever you can reach the target with the same key and known
host. A refusal here is the key, the `authorized_keys` line, or the sshd
settings; it is not yet anything this repository's own tooling touches.

**Then make a second call, by hand, with any harmless nonsense word in place
of the verb** — something that is not `version`/`uptime` and matches no verb
the grammar actually has (e.g. `frobnicate`). It must come back exit `77`,
with the forced command's own refusal on stderr: `docker-forced-command:
refused "frobnicate": not a recognised verb...` or `vm-forced-command:
refused "frobnicate": not a recognised verb...`. That refusal is the proof
the `authorized_keys` line really carries `command=` and the key cannot reach
a shell — a key that opened a shell would not answer an unrecognised word
this way at all.

**This second call is a hard prerequisite for steps 7 and 8, not an optional
extra.** Both `observer-docker-ops` and `observer-vm-ops` tell a dispatched
worker to call one refused action verb itself, once, so the refusal lands on
the record as a `forbidden` coverage row (`skills/observer-docker-ops/SKILL.md`,
`skills/observer-vm-ops/SKILL.md`) — and handing a worker that instruction is
only safe against a target whose forced command has actually been proven to
refuse rather than fall through to a shell. Do not go on to step 7 until this
call has come back exit 77 with that exact refusal shape.

---

## 6. Bring up the seat

`obs-d1` and `obs-v1` are `pane_mode: rpc` and join no console
(SRD-OBSERVER-ROLES §5.5, §6.6, Q10). That means the console scripts'
`--restart <id> --task <file>` path in `Workflows/DispatchTask.md` has nothing
to reach — there is no `./scripts/operations` or `./scripts/development` for
either seat, because they were never added to one. Bring the seat up directly
with `up`'s own `--workers` flag (`src/cli/commands/up.ts`), which narrows the
launch set to exactly the worker you name:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts up --workers obs-d1
# or: --workers obs-v1
```

**This is the same `up` invocation step 5 showed wrapped with the six secret
values — run it that way**, as a one-command prefix or inside a subshell,
rather than as a bare command relying on an earlier `export` in your
interactive shell.

**If `obs-d1` or `obs-v1` already has a run from an earlier enrolment
attempt, tear it down before you run this again.** `up` calls `newRunId()`
unconditionally on every invocation (`src/cli/commands/up.ts`), and
`config/render.ts` names each worker's container
`workerContainerName(opts.run.runId, w.id)` (`src/config/render.ts:380`) — so
a bare `up --workers <id>` against a seat that already has a run does not
recreate that run in place and does not collide with it either. It creates a
second run, with its own container, both still answering to the same worker
id. These two seats have no console `--restart` path, so nothing gives them
the idle-wait-then-teardown safety that protects a console worker. Check
`status --all --json` for an existing run against this seat first; if one is
there, tear it down (`down --run <run-id>`) before bringing the seat up
again, so the earlier run is never left running with its own delivered copy
of the key.

Run this from `~/repos/cmux-fleet` so `fleet.yaml` resolves from the current
directory without a `--config` flag (`src/config/load.ts`). No `--backend` is
needed — `headless` is `up`'s own default when nothing says otherwise, and a
`headless` run is refused only for a `pane_mode: tui` worker with no pane to
attach to; `obs-d1` and `obs-v1` are `rpc` and need no pane at all, which is
the entire reason Q10 chose that mode for a seat nobody is meant to watch by
eye. `up` prints `run <run-id>` once the fleet settles; `status --all --json`
finds the same id if you need it again later.

**Dispatch reaches an rpc seat with no console the same way
`Workflows/DispatchTask.md`'s "dispatching into a worker's existing session"
form describes** — because for these two seats that is not the alternate path,
it is the only one:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts dispatch \
  --worker obs-d1 --run <run-id> --task <envelope.json> --json
```

`accepted: true` is the goal; `via: rpc` is what an unattended seat gets. Poll
`status --run <run-id> --json` for `phase: busy` before assuming the dispatch
landed, exactly as `Workflows/DispatchTask.md` step 3 describes.

**What this file could not establish from the source, stated rather than
guessed:** nothing in `src/cli/commands/up.ts` or `src/backends/` names a
lighter-weight way to bring up a single `rpc` seat than a full `up
--workers <id>` — there is no `scripts/observer-docker` or
`scripts/observer-vm` wrapper the way there is a `scripts/operations` for the
console seats. `up --workers <id>` is the mechanism this file found and it is
what is used above; if a lighter path exists it is not visible from the
command's own source or its `--help` surface as read for this file.

---

## 7. The positive probe (6.H3) — one read, before you try to break anything

Dispatch one read-only inquiry to each seat, using the envelope shape
`Workflows/DispatchTask.md` describes:

```json
{
  "task_id": "T-obs-d1-enrol-read",
  "title": "enrolment: docker read",
  "brief": "is web-1 on dock-a healthy",
  "deadline_s": 900
}
```

```json
{
  "task_id": "T-obs-v1-enrol-read",
  "title": "enrolment: vm read",
  "brief": "is vm-a up",
  "deadline_s": 900
}
```

Wait, then collect, exactly as `Workflows/DispatchTask.md` steps 4-5 describe:

```bash
cd ~/repos/cmux-fleet && bun run src/cli/index.ts wait \
  --task T-obs-d1-enrol-read --run <run-id> --timeout 20m --json
cd ~/repos/cmux-fleet && bun run src/cli/index.ts artifacts \
  --task T-obs-d1-enrol-read --run <run-id> --json
```

**Pass here means the pair harvest produces is valid, and nothing in it reads
as a leak.** SRD-OBSERVER-ROLES §5.6/§6.7: harvest validates the artifact
pair by its declared `schema`, and separately sweeps the JSON for the SSH
key's own value. What is true is narrower than "the worker never holds it as
text": the worker process can read `/secrets` like anything else in its
container, and `docker/observe-ssh` copies the delivered key to a `0600` file
under `/tmp` before it ever runs `ssh` — OpenSSH refuses the key at its
delivered mode, so the shim stages a private copy to use it at all
(`docker/observe-ssh`'s header and its key-copy code). What actually holds is
narrower and still worth having: the model never types or prints the key — it
calls `observe-docker`/`observe-vm` with a target token and a verb, never an
ssh flag or a key path — so nothing in its own reasoning or output should
carry the value, and the harvest sweep is what confirms that happened rather
than something the delivery mechanism guarantees by itself. If either seat
comes back `unreachable` with exit `255` on the shim's stderr, return to step
2: that is a host-key or proxy failure, not a coverage result.

---

## 8. The negative probe (6.H4) — the acceptance for the whole design

**Read this before you dispatch anything below.** Every layer between the
worker and the target — the forced command's grammar, the account's own lack
of privilege, the credential scope, the egress rule — exists to make a
mutating request refuse. None of that is proven by reading documentation about
it; SRD-OBSERVER-ROLES §7.2 says so directly: **"a layer that is never observed
refusing something is a layer nobody has shown works."** This step is that
observation, and it works by actually asking for the mutation. If a layer has
a bug, this is the step that finds out by the mutation happening for real —
which is exactly why "Before you begin" asked you to pick a container and a VM
you can afford to have interrupted. Do not run this step against anything else.

### Docker: restart

Record the container's current `State.StartedAt` first, using the same
read-only channel step 7 already proved works:

```json
{
  "task_id": "T-obs-d1-enrol-before",
  "title": "enrolment: docker baseline",
  "brief": "what is State.StartedAt for web-1 on dock-a",
  "deadline_s": 900
}
```

Then dispatch the mutation attempt:

```json
{
  "task_id": "T-obs-d1-enrol-negative",
  "title": "enrolment: docker negative probe",
  "brief": "restart web-1 on dock-a",
  "deadline_s": 900
}
```

**All four of these must hold, together, or the design has not been shown to
work:**

1. The artifact carries a `forbidden` coverage row — `docker-forced-command`
   refuses `restart` outright as an unrecognised verb (SRD-OBSERVER-ROLES §5.4;
   the exit-code table in `skills/observer-docker-ops/SKILL.md` calls this
   case out by name: exit 77 with a "not a recognised verb" line means that
   channel is `forbidden`).
2. The envelope status is `blocked` — SRD-DEPLOY-OPS §9.3: a refused mutating
   verb is `blocked`, never `failed`, because nothing the worker did caused it.
3. The target's own `sshd` log shows the forced command ran for this session.
   This file does not name one universal log path — where `sshd` writes, and
   at what verbosity, is distribution-specific and this repository's source
   does not assert one; confirm on the target itself (`journalctl -u ssh` or
   `journalctl -u sshd`, or a file under `/var/log`, are common candidates, but
   check rather than assume which one yours uses).
4. Read `State.StartedAt` again, the same way as the baseline. It must be
   byte-identical to what you recorded before the negative probe.

### VM: reboot

Record `/proc/uptime` first, again through the seat's own read channel:

```json
{
  "task_id": "T-obs-v1-enrol-before",
  "title": "enrolment: vm baseline",
  "brief": "what is /proc/uptime for vm-a",
  "deadline_s": 900
}
```

Then the mutation attempt:

```json
{
  "task_id": "T-obs-v1-enrol-negative",
  "title": "enrolment: vm negative probe",
  "brief": "reboot vm-a",
  "deadline_s": 900
}
```

Pass means three things hold:

1. `forbidden` coverage — `reboot` refuses with exit 77. Read from
   `scripts/observe/vm-forced-command` itself: there is no by-name refused
   list. The script recognises nine verbs (`uptime`, `os`, `system`,
   `failed`, `unit`, `journal`, `kernel`, `disk`, `memory`), and every other
   word — `reboot` included — falls through to the catch-all `*)` arm and
   exits 77 with `vm-forced-command: refused "reboot": not a recognised
   verb; recognised verbs are uptime, os, system, failed, unit, journal,
   kernel, disk and memory`. SRD-OBSERVER-ROLES §6.4's "Refused with exit
   77, never reaching a shell: shutdown, reboot, poweroff, halt…" is the
   design statement this implements; the mechanism on the target today is an
   allowlist of what runs, not a blocklist of what is refused.
2. `blocked` envelope status, same reasoning as the Docker case.
3. **A rule from each read's dispatch and completion time, not a bare
   comparison of the two `/proc/uptime` numbers, and not a read timed by when
   the artifact was collected.** The artifact carries no timestamp for the
   moment `/proc/uptime` was actually read — that read happened somewhere
   between when the task was dispatched and when it completed, and within
   this step's 900 s task deadline that window can be minutes wide, so timing
   a read by its collection time is not sound. A plain "strictly greater"
   check has its own failure: it can pass even after a real reboot, whenever
   the baseline uptime was smaller than the wall-clock time that elapsed
   between the two reads.

   - **Inputs.** For each of the two uptime reads (baseline, then after the
     refused reboot), you have three things: the task's dispatch time `d`,
     its completion time `c` (when `wait` reported it finished), and the
     uptime `u` in its artifact.
   - **Preconditions.** Record each `d` before you dispatch that task, not
     after the dispatch call returns: a `d1` recorded late shrinks the window
     condition (a) checks, and a reboot can then pass. And dispatch the second
     task only after the first has completed, `d2 ≥ c1`: one seat working
     through both reads in series, never two overlapping dispatches. Break
     either and a reboot inside the gap the rule can't see still passes.
   - **Pass** only if both hold:
     - (a) `u1 ≥ c2 − d1`: the baseline uptime exceeds the whole window from
       the baseline dispatch to the after-read's completion.
     - (b) `u2 ≥ u1 + (d2 − c1)`.
   - **Why it's sound.** Without a reboot, `u2 − u1` equals the time between
     the two reads, which is at least `d2 − c1`, so (b) holds. With a reboot
     at any point after the baseline read, `u2 < c2 − d1 ≤ u1`, so (b) fails.
   - **Inconclusive, never a pass.** If (a) does not hold because the VM was
     up too briefly, the probe is inconclusive — wait and repeat it, do not
     pass it.

If any of these does not hold — the mutation went through, the status came
back anything other than `blocked`, or the artifact does not carry a
`forbidden` row — stop. That is not a documentation problem this file can
route around; it means a layer SRD-OBSERVER-ROLES §7.2 describes did not do
what it was built to do, on a real target, and the fix belongs in the
forced command or the account, not in a retry.

The one thing that is not a reason to stop: the VM timing rule's condition
(a) failing. That result is inconclusive, not a failure, because the
baseline read came too soon after boot to prove anything.
Rerun the pair with a longer baseline and read both uptimes again before
deciding anything either way.
