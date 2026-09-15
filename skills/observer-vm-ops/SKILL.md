---
name: observer-vm-ops
description: How the observer-vm role writes its result — the observer-vm-ops.json/.md artifact pair, the brief inputs it reads, the verb grammar its forced command enforces on the target, and the facts a worker needs to read a VM's results honestly. Mounted for the observer-vm role.
---

# observer-vm-ops

**Scope of this file, stated up front.** This bundle exists so `observer-vm`'s `fleet.yaml`
entry (SRD-OBSERVER-ROLES §6.6) names a real, mounted skill directory rather than a bundle that
is not there. Documented below: the brief inputs, the whole of what the credential can run, the
report artifact contract, and a short operator enrolment note for reference. Not here: the
call-budget rule and the `submit_report` routing paragraph, which live in `roles/observer-vm.md`.

## Reading your brief (§6.3)

`inputs[]` reaches no prompt. Everything you act on travels in `brief` prose. When a field is
absent, say so in the artifact rather than guessing.

| Input | Form | Default when absent |
|---|---|---|
| target | a target TOKEN from the enrolled inventory, `^[a-z0-9][a-z0-9-]{0,31}$` | the single enrolled VM, stated in the artifact; otherwise the row is `indeterminate` |
| units | zero or more systemd unit names, each matching `^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$`, at most 255 bytes | none — system-level checks only |
| checks | a closed subset of `reachability`, `system`, `units`, `logs`, `resources`, `cloud` | `reachability, system, units, logs` |
| window | seconds, e.g. `300s` | `300s` |
| question | one sentence | "is it healthy" |
| `sweep_id`, `window_opened_at` | copied verbatim when the brief carries them | `null` |

`checks` is closed because it bounds read volume: a check nobody asked for spends turn the artifact
needed.

## Calling the target, and reading its exit

The call form is `observe-vm <target> <verb> [argument ...]`. `target` is one of the TOKENs
enrolled on this fleet. `observe-vm` is a thin alias for `observe-ssh vm <target> <verb>
[argument ...]`; it does not itself enforce the verb grammar below — the target's forced command
does.

Read the exit status AND the stderr text before you write a row — the exit code alone does not
say who refused what. The table is read top to bottom; the first row whose condition matches is
the one that applies, with "anything else" last:

| Exit | What it means | What the row says |
|---|---|---|
| any exit, with `Hint: You are currently not seeing messages from other users and the system.` or `No journal files were opened due to insufficient permissions.` on stderr | the account cannot read the journal as itself — measured 2026-09-14 on systemd 255 (Ubuntu 24.04), running as an account outside `adm`/`systemd-journal`: both `journal` and `kernel` exited 1 with zero stdout lines and both of these lines on stderr. Not measured: an account that holds user journal files of its own, which may get the Hint at exit 0 with only its own entries — so this row sits above the `0` row | the `logs` channel is `forbidden`, and the row is `indeterminate` — never evidence of a quiet window |
| `0` | the call succeeded | the channel is `answered`, and its evidence is the output |
| `77` with `observe-ssh: refused before ssh ran` on stderr | your own call was malformed — no ssh connection was even attempted | not a coverage result; fix the call and retry it once |
| `77` with `vm-forced-command: refused "<verb>": not a recognised verb...` on stderr | the credential itself refuses that verb | that channel is `forbidden`, and the task status is `blocked` |
| `77` with any other `vm-forced-command: refused ...` line on stderr | the target's grammar refused an ARGUMENT, not the verb | your call was malformed; the reason says how — fix it and retry it once, not a coverage result. When the task needs a shape the grammar has no form for at all, that channel is `forbidden` instead |
| `78` | the fleet did not deliver this worker's configuration | every row you cannot otherwise answer is `indeterminate` with coverage `not_attempted`, and the task status is `blocked` |
| `124` from `disk` | `df` did not return inside the 20-second bound `disk` runs it under, most likely a hung network mount | the `resources` coverage is `unreachable` — asked, never answered — and the row is `indeterminate`; never evidence of free space; any stderr goes in `evidence_ref` |
| `125` from `disk`, or `126` or `127` from any verb | `125`: `timeout` itself failed, so `df` never ran. `126`/`127`: the target command did not run at all — for example, it is not on the account's PATH | rows you cannot otherwise answer are `indeterminate` with coverage `not_attempted`, stderr goes in `evidence_ref`, and the task status is `blocked` |
| `128` or above from `disk` | `df` was killed by something other than `timeout`'s own expiry — for example `137` — so that is not `df`'s answer either | the `resources` coverage is `unreachable`, and the row is `indeterminate`; never evidence of free space; any stderr goes in `evidence_ref` |
| `255` | ssh's own failure — a host-key mismatch or a proxy refusal | `reachability` is `unreachable`, and the row is `indeterminate` |
| `1` with stdout exactly `This account is currently not available.` and stderr empty | the account's login shell is `nologin` (measured: `/usr/sbin/nologin` on Ubuntu 24.04 writes that line to stdout, nothing to stderr, and exits 1), so the forced command never ran and the target is mis-enrolled | the task status is `blocked`, and every row you cannot otherwise answer is `indeterminate` with coverage `not_attempted` |
| any non-zero exit from any verb with both stdout and stderr empty | no §6.4 command fails silently, so this is not a real command's own answer — a login shell of `/bin/false` produces exactly this shape | the task status is `blocked`, and every row not otherwise answered is `indeterminate` with coverage `not_attempted` |
| any other non-zero exit from `journal` or `kernel` | measured to exit `0` in every case this project has data for, so a non-zero exit here is never a quiet window | the `logs` channel is `unreachable`, the row is `indeterminate`, and stderr goes in `evidence_ref` |
| anything else | the target command's own exit, returned from the target | the channel is `answered`; the error or state text goes in `evidence_ref` |

**The unreachable rule (§6.3), stated plainly.** An SSH round trip that never completed (exit
`255`) is `coverage.result: unreachable` and `assessment: indeterminate`, never `unhealthy`. You
cannot tell a down VM from a down route, so do not guess which one it is.

**`system` exiting non-zero is an answer, not a failure.** `systemctl is-system-running` prints a
state word (for example `degraded`) and can exit non-zero for it; that is `answered` coverage
with the state word as evidence, not a reason to retry the call or mark it `unreachable`.

**Fail closed on `journal` and `kernel`.** In every case `test/fixtures/observe/vm-tool-shapes.json`
measures — `.journal.oldest.exit`, `.journal.oldest_empty_window.exit`, `.journal.target.exit`,
`.kernel.oldest.exit` and `.kernel.target.exit` — both verbs exit `0`, including the empty-window
case. So a non-zero exit from either one is never a quiet window; it is refused or broken, not
silence. The permission-refusal row above is measured on systemd 255 only — the systemd 239 floor
this project also tracks is unmeasured for it — and that is exactly why the fail-closed row exists:
any other non-zero exit from `journal` or `kernel` is `unreachable` coverage and an `indeterminate`
row, with stderr recorded rather than the gap assumed empty.

**A silent mis-enrolment never reads as `answered`.** A login shell of `/bin/false` makes every
call exit `1` with empty stdout and empty stderr — no verb ever runs. No §6.4 command fails this
quietly on its own: `system` prints its state word even when it exits non-zero, and every refusal
this credential can produce names itself on stderr. So an exit with nothing on either stream is
never a command's own answer; it reads as a broken account, not a result. The `nologin` row above
is measured against `/usr/sbin/nologin` on Ubuntu 24.04; util-linux's `nologin` instead prints the
contents of `/etc/nologin.txt` on stdout when that file exists, which is unmeasured here. The
enrolment verify step's `getent passwd <account>` showing `/bin/sh` is the guard against mistaking
either shape for a working account.

**`disk`'s timeout, stated plainly.** `timeout 20` ends a `df` stuck in a killable wait, such as a
hung NFS mount, with exit `124` inside that 20-second bound. It does not end every hang: a `df` in
uninterruptible sleep ignores every signal `timeout` sends it, its kill included, until the
kernel's own I/O wait resolves — so `timeout` waits on it too, and the whole call can run past its
20-second bound with no exit code at all. `observe-ssh`'s keepalives (the `ServerAliveInterval` and
`ServerAliveCountMax` options it passes to `ssh`) do not help here: they end a connection that
stops answering, not one whose remote command is still running but has not returned. A `disk` call
that never returns is never evidence of free space — nor of anything else.

Measured on Ubuntu 24.04, coreutils' `timeout` exits `124` when it kills `df` and the kill
succeeds, `125` when `timeout` itself fails, `126` when `df` cannot be executed and `127` when it
is not found, `128` or above when `df` is killed by a signal `timeout` did not send, and otherwise
passes `df`'s own exit straight through. So `124` is the hung-mount case the table above can
actually kill, `125` from `disk` and `126`/`127` are the "did not run at all" row, `128` or above
is `df` killed by something else, and only an exit below `124` is `df`'s own answer.

## Checks, and the verbs that answer them

| Check | Answered by |
|---|---|
| `reachability` | any verb call whose round trip completes at all |
| `system` | `system`, `uptime`, `os` |
| `units` | `failed`, plus `unit <name>` for each requested name |
| `logs` | `journal`, `kernel` |
| `resources` | `disk`, `memory` |
| `cloud` | none — this role has `cloud_access: false`, so `cloud` is never attempted; record its coverage as `not_attempted` |

## The verb grammar — the whole of what the credential can do (§6.4)

| Verb | Accepted arguments | Runs |
|---|---|---|
| `uptime` | none | `cat /proc/uptime /proc/loadavg` |
| `os` | none | `cat /etc/os-release` |
| `system` | none | `systemctl is-system-running` |
| `failed` | none | `systemctl list-units --state=failed --no-legend --plain --no-pager` |
| `unit` | one unit name, `^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$`, at most 255 bytes | `systemctl show <unit> --no-pager --property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestamp,ExecMainStatus` |
| `journal` | `since=<N>s lines=<M>`, both required, `M <= 500`; optional `unit=<unit>`, `priority=<0-7>` | `journalctl --no-pager --output=short-iso --lines=<M>` plus the since bound, `--unit` and `--priority` |
| `kernel` | `since=<N>s lines=<M>`, both required, `M <= 500` | `journalctl --no-pager --dmesg --output=short-iso …` |
| `disk` | none | `timeout 20 df -P -k` |
| `memory` | none | `cat /proc/meminfo` |

Every no-argument verb (`uptime`, `os`, `system`, `failed`, `disk`, `memory`) refuses any
argument at all — one extra token and the whole call is refused with exit 77. `unit` takes
exactly one argument; zero, two, or more are refused the same way.

**The `journal`/`kernel` argument grammar, precisely.** Both take zero or more `key=value`
tokens, in any order, and a repeated key is refused:

- `since=<N>s` — `N` is 1 to 9 ASCII digits, first digit `1`-`9` (no leading zero); `since=0s`
  is refused.
- `lines=<M>` — 1 to 500, decimal digits only, no leading zero (so `lines=0` and `lines=00` are
  both refused).
- `priority=<P>` (`journal` only) — exactly one digit `0`-`7`. A symbolic name such as `err` is
  refused; only the digit form is accepted.
- Each key may appear at most once per call.
- `kernel` accepts only `since=` and `lines=`; `unit=` and `priority=` are refused for it exactly
  as an unrecognised key would be.
- A `unit=<unit>` value tops out at 251 bytes in practice, not the 255-byte cap the unit-name
  grammar itself allows: `observe-ssh` caps every argument token, key and value together, at 256
  bytes, in `is_argument()` (`docker/observe-ssh`), and `unit=` is 5 of those bytes before the
  value starts.
- A unit name starting with `-`, or one carrying a backslash escape (for example the `\x2d`
  escaping systemd gives device and mount units — names that can turn up verbatim in `failed`
  output), cannot be queried through this grammar: `observe-ssh`'s own argument grammar has no
  backslash in its accepted character set, and the unit grammar's first character must be
  alphanumeric. Record such a unit by name in the artifact; do not retry the call, because no
  argument shape gets it through.

**Refused with exit 77, never reaching a shell:** `shutdown`, `reboot`, `poweroff`, `halt`;
`systemctl` with any verb other than `is-system-running` and `show` (`start`, `stop`, `restart`,
`reload`, `enable`, `disable`, `mask`, `kill`, `isolate`, `daemon-reload`, `set-property`, and
more); `journalctl` with `--vacuum-*`, `--rotate`, `--flush` or `--sync`; `kill`; any package
manager; `sudo`; any free-form path read — no verb here takes a path. The account also holds no
sudo, so even a bypassed grammar could not run a mutating `systemctl` verb.

**Disclosure.** `journal` returns whatever services logged. Quote only the lines that support a
finding, never whole windows. Arbitrary application log files are out of reach by construction,
because no verb takes a path.

**Bounded reads.** `lines` is required and capped at 500 for both `journal` and `kernel`. An
unbounded read risks a tool-output limit that truncates
from the FRONT — discarding exactly the oldest part of the window the question was about, so
what survives reads like the whole window when it is really just its last few seconds. Default
to a narrow `lines` value; reach for `lines=500` only when the question genuinely needs that much
history, and if a call still truncates, re-run it bounded once and say so in the artifact rather
than fetching a third time.

### Measured facts, so a result reads honest

Each claim rests on `test/fixtures/observe/vm-tool-shapes.json`, written by
`scripts/observe/characterise-vm` against a real target (systemd 255, Ubuntu 24.04.5 LTS) and the
oldest systemd this project tracks (systemd 239, Rocky Linux 8):

- **`unit` on a unit that does not exist exits `0` with `LoadState=not-found`.** That is "no such
  unit," not a stopped service — `LoadState` is `loaded` for a real unit whether it is currently
  `active` or `failed`. Measured: `.show.oldest.missing` (and confirmed present the same way on the
  current target's own resolver). Read `LoadState` before reading `ActiveState`.
- **The property order `systemctl show` prints is not the order the `--property=` flag requested.**
  The verb asks for `Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestamp,ExecMainStatus`;
  measured output comes back as `Result, NRestarts, ExecMainStatus, Id, LoadState, ActiveState,
  SubState, ActiveEnterTimestamp` on both systemd versions (`.show.oldest.active.property_order`,
  `.show.target.active.property_order`). Read each line by its own `Key=Value` shape, never by
  position.
- **On systemd 239, `journal` and `kernel` output opens with a header line** —
  `-- Logs begin at <date>, end at <date>. --` — that is not a log entry
  (`.journal.oldest.marker_lines`, `.kernel.oldest.marker_lines`). The current target, systemd 255,
  printed no such line for the same call (`.journal.target.marker_lines`,
  `.kernel.target.marker_lines`: both empty) — don't expect the header on every system. On systemd
  239, a window with nothing in it adds a second marker line, `-- No entries --`, after the header
  (`.journal.oldest_empty_window.marker_lines`) — that too is not evidence, it is the absence of it.
- **A `failed` row is whitespace-columnar, not JSON, and carries five columns, not four.** Measured
  on the oldest target: `char-fail-<id>.service loaded failed failed` are the first four
  (`.failed.oldest.failed_unit_row_first_four`), and the row has a fifth, the unit's description
  (`.failed.oldest.failed_unit_row_columns`: 5). The current target returned zero failed-unit rows
  at measurement time (`.failed.target.rows`), so an empty `failed` result there is not itself
  suspicious.

## The report artifact contract (§6.7)

Two files in `/outbox/<task-id>/files/`: `observer-vm-ops.json` and `observer-vm-ops.md`, both
every time. A run that writes only the `.md` clamps to `failed` — the file nothing inspects is
the one that was supposed to carry the evidence.

```json
{
  "schema": "pifleet.observer-vm-ops/v1",
  "worker": "obs-v1",
  "sweep_id": null,
  "window_opened_at": null,
  "services": [
    {
      "name": "vm-1.example.com",
      "namespace": "vm-1",
      "assessment": "healthy",
      "coverage": [
        {"channel": "reachability", "result": "answered"},
        {"channel": "system", "result": "answered"},
        {"channel": "units", "result": "answered"},
        {"channel": "logs", "result": "answered"},
        {"channel": "resources", "result": "not_attempted"},
        {"channel": "cloud", "result": "not_attempted"}
      ],
      "selector": "vm-1",
      "window": "300s",
      "evidence_ref": ["observe-vm vm-1 system: state running", "observe-vm vm-1 failed: 0 units listed"],
      "uptime_s": 431827,
      "system_state": "running",
      "failed_units": []
    }
  ]
}
```

- **`services[]` keeps its name, and one row is one VM.** `name` is the VM's own name, and
  `namespace` is the target token.
- **`coverage[].channel` is closed to `reachability`, `system`, `units`, `logs`, `resources`,
  `cloud`.** **`coverage[].result`** and **`assessment`** are the same closed enums every observer
  target uses: `answered | unreachable | forbidden | not_attempted` and
  `healthy | degraded | unhealthy | indeterminate`. `failed` is a TASK status, never an
  `assessment` — a fifth token there voids the whole document, not just the row.
- **`uptime_s`, `system_state` and `failed_units[]` are optional.** Include them when the
  matching verb answered; leave them out rather than guess when it did not. `system_state` is the
  state word `system` printed, verbatim. `failed_units[]` holds unit names copied verbatim from
  `failed` output, one per entry.
- **Copy `sweep_id` and `window_opened_at` out of the brief, verbatim, and from nowhere else** —
  not from your transcript, not reconstructed from the clock. An artifact whose `sweep_id` does
  not match is discarded whole.
- **Harvest validates the JSON by name, sweeps it for `OBSERVER_VM_SSH_KEY`'s value, and clamps
  an orphaned `.md` to `failed`.**

## Enrolling a target (§6.2) — operator reference, never a worker's task

A non-root account on the target, holding no sudo, with a login shell of `/bin/sh` — sshd runs the
forced command through the account's own shell, so anything richer than `sh` is surface this role
has no use for (the same reasoning §5.7 gives the Docker role). The account is a member of the
distribution's journal-reader group so it can read the journal without sudo; that group's name is
distribution-specific — on Ubuntu 24.04 it is `adm` — so confirm it on the target rather than
assuming it. The account's home directory and its `~/.ssh` must be root-owned and not writable by
the account itself: an account that could write either could widen the forced command's reach or
rewrite its own `authorized_keys` line.

`scripts/observe/vm-forced-command` is installed root-owned, mode `0755`, at a path the account
cannot write, named in the account's one `authorized_keys` line: `restrict,command="<installed
path>" ssh-ed25519 <public key> pifleet-observer-vm`.

**sshd is configured so no environment reaches the forced command from the client — this is four
settings, not one, the same four §5.7 gives the Docker role:**

- `AcceptEnv` passes nothing through for this account — name one no client ever sends, e.g.
  `OBSERVER_VM_UNUSED`, rather than a real one. That inside a `Match User` block, OpenSSH's
  `AcceptEnv` directive itself needs at least one variable name to parse (checked with `sshd -T`
  on OpenSSH 10.3p1) is measured in the Docker role's own enrolment note
  (`skills/observer-docker-ops/SKILL.md`), not here — the measurement is about `sshd`, not about
  which role's account it is checked against.
- No `SetEnv` for the account. `SetEnv` hands the forced command a value regardless of what the
  client asks for, and does not go through `AcceptEnv` at all.
- `PermitUserEnvironment no` (the default). With it off, an `environment=` option on the
  `authorized_keys` line and the account's `~/.ssh/environment` file are both ignored.
- No `user_readenv` in this account's PAM stack, so `~/.pam_environment` is never read, and the
  account's root-owned home leaves it nowhere to write one.

**PATH, for this role's own binaries.** `vm-forced-command` resolves `systemctl`, `journalctl`,
`cat`, `df` and `timeout` through PATH — it names none of them by an absolute path. That PATH must
come from sshd's own default, a root-owned `pam_env` directive or `/etc/environment`, never from
the account itself: an accepted `PATH` could make any of those five resolve to another binary.

**IFS, ENV and BASH_ENV.** `vm-forced-command` pins its own `IFS` before it re-splits
`SSH_ORIGINAL_COMMAND` (the `IFS=" ${tab}"` assignment set immediately before `set -- ${original}`,
restored to the script's own pinned constant right after), so an inherited `IFS` never reaches its
argument parsing. `ENV` and `BASH_ENV` rely on this account's `/bin/sh` login shell the same way
the Docker role's note gives: a `bash` started as `bash -c` reads `BASH_ENV`, but a `bash` started
as `sh` (as `/bin/sh` may itself be) does not.

A login shell of `/bin/false` or `nologin` makes every call fail the same way; the exit table above
says how that reads.

The target's host key goes in `OBSERVER_VM_KNOWN_HOSTS`, one `token host port user` line in
`OBSERVER_VM_TARGETS`, and `{host, port}` in `egress.allow`.

**Verify afterward, the same three checks §5.7 gives the Docker role, adapted to this one:**
`sshd -T -C user=<account>,host=<host>,addr=<addr>` for this account's effective `AcceptEnv`,
`SetEnv` and `PermitUserEnvironment`; `getent passwd <account>` showing `/bin/sh`; and one
`uptime` call through the key.
