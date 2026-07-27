# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.2.0] — 2026-07-27 — Phase 1: container and headless core

`up → dispatch → wait → down` runs end to end on the `headless` backend against
the Pi double, and against real Pi 0.79.6.

### Added
- **Worker container** — `image build|list|verify|gc`. Read-only root, uid 10001,
  tini as PID 1, `gcloud`/`kubectl`/`helm`/`gsutil`/`bq` behind the `verbgate`
  PATH shim with a task-scoped allow list on a read-only mount.
- **Config** — `fleet.yaml` loader and validator with field-level errors, and
  `render --worker` to print the exact `docker run` and `pi` argv without
  executing either.
- **Detached supervisor** — its own session and process group, so it outlives the
  CLI that started it. One per worker.
- **Pi RPC client** — JSONL framing over stdin/stdout with a monotonic per-record
  stream sequence, split on `\n` only (never `readline`, which also splits on
  `U+2028`).
- **Completion detection** — `agent_end{willRetry:false}` plus a correlated
  double-read of `get_state`. There is no `agent_settled` message; the original
  design waited for one and would have hung on every task.
- **Epoch fencing** — every task attempt gets an epoch bound at the stream offset
  of its prompt ack, so a late event from a previous attempt cannot be
  misattributed to the current one.
- **Run state** — `state.json`, `fence.json`, `events.jsonl`, and a per-writer
  ledger, all written atomically.
- **CLI** — `doctor`, `up`, `daemon`, `status`, `dispatch`, `wait`, `abort`,
  `logs`, `exec`, `down`, on a strict exit-code ladder (2 usage, 3 backend, 4
  timeout, 5 budget, 6 worker died, 7 partial).
- **`pifleet-fake-pi`** — the scriptable test double the whole suite runs against.

### Fixed
- The epoch fence is recorded synchronously with the prompt ack. Resolving a
  promise only schedules a microtask, so a fence recorded after `await send(…)`
  landed *after* an `agent_start` that arrived in the same stdout chunk — the
  window never opened, every later event including `agent_end` was discarded, and
  the task hung forever.
- A deadline whose `abort` produces no terminal event now settles the task and
  kills the child, instead of leaving the worker `busy` indefinitely.
- `writeJsonAtomic` uses a unique temp name per call and cleans up on the throw
  path; concurrent writes to one path were producing unparseable files.
- `TailReader` detects file replacement by identity rather than size, so a
  rewritten session file is re-read from zero instead of resuming mid-record.
- Bind-mounted host paths are never derived from `os.tmpdir()`. On macOS the
  daemon runs in a VM that shares only a declared set of directories, and a `-v`
  against an unshared path mounts a silently *empty* directory with exit 0.
- Bind-mounted host directories are made accessible to uid 10001. A Linux bind
  mount passes host ownership through untouched, so `mkdtemp`'s 0700 and
  `mkdir`'s 0755 left the worker unable to write its own outbox — invisible on
  macOS, where the VM squashes ownership.
- `read_only` is enforced against the *effective* tool set. Omitting `tools`
  is not "no tools": Pi then grants every builtin, `bash` included, so the most
  natural way to write the role skipped the check entirely.
- verbgate's policy and ledger paths are constants rather than environment
  variables — the worker could previously hand the gate its own allow list and
  redirect its own audit trail.
- `dispatch` accepts the mandatory `epoch: 0` placeholder. The envelope schema
  requires the field and documents 0 as the placeholder, but dispatch treated any
  number as an explicit request, so every hand-written envelope was rejected
  `stale_epoch` for supplying the one value the schema forces its author to give.
- The container CI job tags the built image from the real `image list --json`
  shape. It read `d.images[0].tag` from what is a bare array, so the job had been
  red since it was added and no container probe had ever executed.

## [0.1.0] — 2026-07-26 — Phase 0: verify and scaffold

### Added
- Repository foundation: Bun/TypeScript skeleton, strict tsconfig, CI workflow,
  test pyramid layout.
- `Docs/SRD.md` — the pifleet system requirements document (v2.3), rewritten
  from live execution of the cmux and Pi surfaces. Eleven errors in the previous
  revision are recorded in its §18.
- `ISA.md` — the criteria that define done.
