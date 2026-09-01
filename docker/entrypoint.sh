#!/bin/bash
# Worker container entrypoint (runs under tini as PID 1).
#
# Its FIRST job: render ~/.pi/agent/models.json from the environment before
# Pi starts. Pi reads oMLX provider configuration from that FILE, not from env,
# and only registers a provider when the models list is non-empty (SRD Q9 —
# recorded in the agentic-SRE work). Skipping this step produces a worker that
# streams tokens happily and can reach no model at all.
#
# Its SECOND job, and the reason this file stopped being a bare `exec` at its
# last line: SUPERVISE the escape-attempt honeypot alongside the worker
# (ISC-125). See the block above the supervisor at the bottom.
#
# bash rather than sh, and only for that supervisor: `wait -n -p` is the one
# construct that reports WHICH child exited without polling, and `kill -0`
# cannot substitute for it — a child that has exited but not been reaped is a
# zombie, and `kill -0` succeeds on zombies, so a poll loop would never notice
# either process ending. bash 5.2 is in the base image (`node:*-bookworm-slim`
# plus an explicit apt install).
#
# Environment contract (injected by the supervisor via --env-file):
#   PIFLEET_LLM_PROVIDER   provider name, default "omlx". THE WORKER'S RESOLVED
#                          provider, not the fleet-wide one: a worker's `model:`
#                          may carry a `provider/` prefix that overrides
#                          `llm.provider`, and the same resolved value is what
#                          `config/render.ts` puts on `pi --provider`. The two
#                          have to name the same provider or Pi is launched
#                          naming one its own models.json does not define.
#   PIFLEET_LLM_BASE_URL   e.g. http://host.docker.internal:8000/v1
#   PIFLEET_LLM_MODELS     comma-separated model ids; EMPTY means "render nothing"
#   PIFLEET_LLM_API_KEY_FILE
#                          The PATH of the file holding the provider credential
#                          — `/secrets/<NAME>`, mode 0444, on the read-only
#                          /secrets mount. A fleet-owned FIXED name carrying a
#                          PATH (D8, SRD-INFERENCE-PROVIDERS §6.6); the operator
#                          names the HOST variable via `llm.api_key_env` and
#                          that name never reaches this container.
#                          UNSET means the fleet configured no credential, which
#                          is a supported fleet. SET-BUT-UNREADABLE is a
#                          different event entirely and is fatal — see the
#                          credential block below.
#                          The credential is NOT in the environment under any
#                          name (ISC-31, ISC-407).
#   PIFLEET_HONEYPOT       "1" arms the escape-attempt listener and makes its
#                          death fatal. UNSET means no listener at all, which is
#                          how `image verify` and the acceptance containers run:
#                          they have no /run tmpfs and no /outbox, so a listener
#                          could neither bind nor record. A real worker that
#                          comes up without this set is NOT silently fine — it
#                          reports as `unwatched` in `pifleet report`, which is
#                          the whole point of the third state.
#   PIFLEET_PANE_MODE      "tui" or "rpc" (SRD §3.5). Decides WHICH OF THE TWO
#                          STDIN CONTRACTS is installed below — see the long
#                          block above the launch. UNSET means "rpc", so every
#                          container built before this variable existed, and
#                          every probe that does not set it (`image verify`,
#                          the acceptance containers, test/integration/
#                          honeypot.test.ts), keeps exactly the plumbing it
#                          has always had.
#   PIFLEET_PI_THEME       Pi colour theme name, or "" for "no opinion". Pi has
#                          no theme env var, so this is written into
#                          settings.json below. EMPTY is not the same as unset-
#                          and-defaulted: it leaves an operator's own /settings
#                          choice in place, which a default would overwrite on
#                          every restart.
#   PIFLEET_WORKER_BIN     test seam: binary to exec instead of pi (ISC-39/40
#                          verification needs to observe the rendered file, and
#                          pi itself cannot print it)
set -eu

# --- find a writable agent dir despite the read-only root (ISC-39/40) --------
# In a real run a named volume is mounted at /home/pi/.pi/agent, so it is
# writable. Under bare `--read-only` (image verify, probes) it is not: the
# permission bits lie, so probe by writing, then fall back to the /tmp tmpfs
# and re-point HOME — Pi derives its config dir from $HOME.
agent_dir="${HOME}/.pi/agent"
if ! ( mkdir -p "${agent_dir}" && touch "${agent_dir}/.rw-probe" ) 2>/dev/null; then
  export HOME=/tmp/pi-home
  agent_dir="${HOME}/.pi/agent"
  mkdir -p "${agent_dir}"
else
  rm -f "${agent_dir}/.rw-probe"
fi

# --- render models.json ------------------------------------------------------
# jq ships in every toolchain variant (ISC-36), and is the only sane way to get
# JSON string escaping right in shell. A provider with an empty models list is
# never written: Pi would refuse to register it, and an empty-but-present file
# reads as "configured" to a human debugging the container.
#
# ## The credential arrives as a FILE, and its NAME is no longer this file's
# ## problem (D8 — SRD-INFERENCE-PROVIDERS §6.6)
#
# This block has read the credential three ways. It read a literal
# `${OMLX_API_KEY:-}`, which agreed with `worker-env.ts` only because both
# strings happened to be `OMLX_API_KEY` — Defect A. It then followed
# `PIFLEET_LLM_API_KEY_ENV` to whatever name the operator chose, which repaired
# the disagreement but kept the indirection. **It now reads a PATH**, and that
# is what makes Defect A permanent rather than patched: the entrypoint stops
# needing to know the operator's chosen variable name at all, because the
# indirection is a path and the name is the fleet's.
#
# It buys two more things beyond the defect. The credential is no longer in the
# container's environment under ANY name, so `env` and a serialised crash dump
# no longer disclose it — which is exactly what ISC-337..342 bought for Class 3,
# and it makes ISC-31 pass for the right reason rather than by renaming the
# variable out of the assertion's way. And §12.4's `env_allowlist` prohibition
# stays INTACT rather than repealed: `env_allowlist` is the operator's grant
# ceiling, and a provider key is fleet-assigned, not operator-granted.
#
# THE ENVIRONMENT READ IS GONE, NOT DEMOTED, and that is a deliberate refusal of
# the obvious kindness. A file-then-environment fallback would look like
# robustness and would resurrect the defect on the first day the pointer failed
# to arrive: this file would silently read some other variable and render
# `apiKey: ""` — Defect A verbatim, exit 0, nothing on stderr. Worse, a worker
# that also holds `OMLX_API_KEY` through `secrets:` would authenticate to the
# configured provider with the LOCAL oMLX credential, a wrong-credential 401
# strictly harder to diagnose than the empty key it replaced. A channel with two
# sources has two failure modes and no way to tell which one fired.
#
# ## UNSET means keyless; SET-AND-BROKEN means the host lied. They are not the
# ## same event and they do not get the same behaviour.
#
# An absent pointer is a supported configuration. A local oMLX with no
# credential is legitimate (SRD §5.9), `worker-env.ts`'s standing convention for
# that case is to omit the variable rather than write it blank, and the
# non-supervisor callers — `image verify`, the acceptance containers — run this
# script with no worker env file at all. So: empty key, exit 0, no complaint.
#
# A pointer that is SET and cannot be honoured is the host side failing to write
# what its own environment says it wrote, and inheriting the empty-key
# behaviour there would reproduce §2.2's silent failure on a brand-new channel.
# The guard below tests the base URL and the model list and NOT the key, so
# `models.json` would still be written, Pi would still register the provider,
# the container would still boot and `up` would still report success. The first
# symptom is an authentication error at generation time, inside a container, on
# a worker that looks healthy — and against a metered provider that reads at
# first glance as a billing problem.
#
# SRD §5.9 has a standing ruling on exactly this shape. A `relay_upstream`
# hostname "produces a relay that starts cleanly, reports ready, and then fails
# every connection with a resolution error no operator-facing surface shows.
# `config validate` refuses it, so the failure becomes a sentence instead."
# This is that trade taken at the container's altitude, and it is why an EMPTY
# file is fatal too: `cat` succeeds on an empty file, so every existence check
# passes and the render proceeds with `apiKey: ""` — Defect A's exact output
# reached by a different route.
#
# CHECKED WHETHER OR NOT models.json IS RENDERED, and that independence is the
# structural half of the fix. §2.2's diagnosis of why Defect A was silent names
# the coupling precisely: "the guard above the block is `[ -n BASE_URL ] &&
# [ -n MODELS ]` — it does not test the key." Putting the credential check
# inside that guard would make the credential's health contingent on two
# unrelated variables, which is the same mistake approached from the other side.
#
# ## Why the PATH is validated, and what the validation does NOT close
#
# The old code validated the NAME against ENV_KEY_RE's own pattern. That guard
# is not being dropped, it is being re-aimed, and against a strictly worse
# consequence. A bad name degraded to an empty key; a bad PATH does not degrade
# at all — it admits SOME OTHER FILE'S contents, and `models.json` lands on a
# named volume that outlives `--rm`. An unvalidated pointer turns the credential
# channel into a read primitive whose output is persisted, so `/proc/self/environ`
# or `/etc/passwd` would be copied into a JSON string on that volume.
#
# The reason to check here rather than trust the host is the same one that kept
# the identifier guard: this file reads an ENVIRONMENT VARIABLE, not config. The
# host does constrain the value — `RESERVED_PREFIXES` blocks `PIFLEET_` from
# `secrets:` at both the requested name and the derived pointer, and `schema.ts`
# refuses a malformed or reserved `api_key_env` at parse time — but a
# hand-assembled env file, a future harness, or a supervisor bug reaches this
# variable with none of that applied.
#
# **WHAT THIS DOES NOT CLOSE, stated because a guard read as total is worse than
# no guard.** `/secrets` is a SHARED namespace: `secretFilePath()` puts every
# Class 3 grant at `/secrets/<name>` and D8 puts Class 1 in the same directory.
# A pointer aimed at another grant's basename is shape-valid and this block will
# read it, copying a Class 3 secret into `models.json` on a persisting volume.
# Distinguishing the two requires the Class 3 name list, which exists only on
# the host, so that half is the host's to close and is NOT closed here. The
# checks below are the half a container can decide by itself: absolute, no `..`
# segment, not a symlink, a readable regular file, non-empty.
#
# The `..` test is on SEGMENTS rather than substrings — a legitimate secret name
# may contain dots — and `/secrets/..` is caught because the haystack is padded
# on both ends, which is the case a naive "one segment below the mount" check
# lets through: it carries no slash of its own.
api_key=""
api_key_file="${PIFLEET_LLM_API_KEY_FILE:-}"

# Exit 73, following this file's own precedent for container-side refusals: 71
# is the escape-attempt listener failing to arm and 72 is a tui worker with no
# terminal, and a credential refusal must not be read as either.
refuse_key_file() {
  echo "pifleet: PIFLEET_LLM_API_KEY_FILE=${api_key_file} $1 (D8, SRD-INFERENCE-PROVIDERS §6.6). The fleet writes the provider credential to a 0444 file on the read-only /secrets mount and points this variable at it, so a pointer that cannot be honoured means the supervisor did not write what its own environment claims. Refusing to start: rendering models.json with an empty key would produce a worker that boots, registers its provider and reports healthy, and then fails authentication at generation time." >&2
  exit 73
}

if [ -n "${api_key_file}" ]; then
  case "${api_key_file}" in
    /*) ;;
    *) refuse_key_file "is not an absolute path" ;;
  esac
  case "/${api_key_file}/" in
    *"/../"*) refuse_key_file "contains a '..' segment" ;;
  esac
  if [ -L "${api_key_file}" ]; then
    refuse_key_file "is a symbolic link"
  fi
  if [ ! -f "${api_key_file}" ]; then
    refuse_key_file "is not an existing regular file"
  fi
  # THE READ IS THE READABILITY CHECK. An explicit `[ ! -r ]` stood here and was
  # deleted after a mutation measured it dead: removing it changed no observable
  # behaviour, because `cat` fails on the same file and this branch refuses
  # identically. It was strictly worse than the read it guarded — it cannot see
  # a file that is readable but not openable, and it leaves a TOCTOU window
  # between the test and the open that the read does not have.
  #
  # `if !` rather than a bare assignment, because under `set -e` a failing
  # command substitution aborts the script with bash's own diagnostic and cat's
  # exit status: measured, a 0000 file then exits 1 instead of 73, and the
  # operator gets neither the sentence nor a code distinguishable from any other
  # bash failure.
  #
  # HONEST ACCOUNT OF WHY THIS ONE AND NOT `-r`, because the measurement does
  # not settle it and a reader should not think it did. The two are REDUNDANT:
  # with `-r` restored, deleting this `if !` is still green, and with this `if !`
  # present, deleting `-r` was still green. Either alone yields exit 73. Keeping
  # the read is a judgement call — it covers strictly more (a file readable but
  # not openable, an I/O error part-way through, and the TOCTOU window `-r`
  # opens between its test and this open) — not something the tests force.
  #
  # Command substitution strips trailing newlines, which is what this wants both
  # ways round: `writeWorkerSecretFiles` writes "the RAW value and NOTHING ELSE
  # — no trailing newline, deliberately", and a file that acquired one anyway
  # must not put it inside the JSON string.
  if ! api_key="$(cat "${api_key_file}" 2>/dev/null)"; then
    refuse_key_file "could not be read"
  fi
  if [ -z "${api_key}" ]; then
    refuse_key_file "is empty"
  fi
fi

if [ -n "${PIFLEET_LLM_BASE_URL:-}" ] && [ -n "${PIFLEET_LLM_MODELS:-}" ]; then
  jq -n \
    --arg provider "${PIFLEET_LLM_PROVIDER:-omlx}" \
    --arg baseUrl "${PIFLEET_LLM_BASE_URL}" \
    --arg apiKey "${api_key}" \
    --arg models "${PIFLEET_LLM_MODELS}" \
    '{
      providers: {
        ($provider): {
          name: $provider,
          baseUrl: $baseUrl,
          api: "openai-completions",
          apiKey: $apiKey,
          models: ($models | split(",") | map(select(length > 0)) | map({id: ., name: .}))
        }
      }
    }' > "${agent_dir}/models.json"
fi

# --- select the Pi colour theme ----------------------------------------------
# Pi has no PI_THEME environment variable; the ONLY way to select a theme
# non-interactively is the `theme` key in settings.json, so this writes it.
# The theme FILES are baked into the image at /opt/pifleet/themes and are put on
# Pi's discovery path by `--theme`, which `config/render.ts` passes in the flag
# list — a name selected here that was never discovered leaves Pi on its
# default.
#
# MERGED, not overwritten, and that is the whole reason this is four lines
# rather than one. settings.json is Pi's OWN state file: it persists the model,
# the thinking level, the last changelog seen and anything else `/settings`
# touches, and it lives on a per-worker named volume that outlives the run. A
# `jq -n` here — the shape the models.json block above uses, which is correct
# there because that file is entirely ours — would silently discard all of it on
# every container start.
#
# Absent or empty means LEAVE IT ALONE. That is the difference between "config
# claims this pane's colours" and "config has no opinion"; defaulting to `dark`
# would take the second case and overwrite a theme the operator chose by hand.
#
# The `|| echo '{}'` guards a settings.json that is not valid JSON — a
# half-written file from a killed container, say. Under `set -e` a jq parse
# failure here would kill the worker before it started, which is a container
# that does not boot because a colour scheme could not be applied. Losing the
# malformed file's contents is the lesser harm and the only recoverable one.
# TWO KEYS, TWO DIFFERENT OWNERSHIP RULES, and the difference is the reason
# this is one block rather than two one-liners:
#
#   theme         CONFIG IS AUTHORITATIVE. Written on every start when the
#                 variable is non-empty, so a fleet.yaml edit takes effect on
#                 the next `up` without anyone touching the volume.
#   quietStartup  A SEEDED DEFAULT. Written only when settings.json does not
#                 exist yet — i.e. once per worker volume — so an operator who
#                 turns the listing back on inside the pane keeps it.
#
# quietStartup is set at all because of what loading themes DOES to a pane. Pi
# prints an inventory of loaded resources at startup, and it is skipped when
# there is nothing to inventory — so putting 16 themes on the discovery path
# turned a three-line header into an eleven-line one, in the two standing panes
# whose whole complaint was startup text. Quiet suppresses the LISTING only:
# Pi's startup call passes `showDiagnosticsWhenQuiet: true`, so resource
# collisions and load errors still print, and ctrl+o still shows the full
# listing on demand. That is the trade — an inventory nobody reads goes away,
# and the diagnostics that would explain a missing skill do not.
settings="${agent_dir}/settings.json"
if [ ! -f "${settings}" ]; then
  echo '{"quietStartup":true}' > "${settings}" 2>/dev/null || true
fi

if [ -n "${PIFLEET_PI_THEME:-}" ]; then
  existing='{}'
  if [ -f "${settings}" ]; then
    existing="$(jq '.' "${settings}" 2>/dev/null || echo '{}')"
  fi
  if printf '%s' "${existing}" \
     | jq --arg t "${PIFLEET_PI_THEME}" '. + {theme: $t}' > "${settings}.new" 2>/dev/null; then
    mv "${settings}.new" "${settings}"
  else
    rm -f "${settings}.new"
    echo "pifleet: could not select theme ${PIFLEET_PI_THEME} (settings.json unwritable); the pane will use Pi's default" >&2
  fi
fi

# --- supervise the honeypot and the worker (ISC-125) -------------------------
# THE OWNER DECISION THIS IMPLEMENTS: the listener's death is FATAL. If the
# escape-attempt listener dies, the worker container ends.
#
# The reasoning, because it is what makes the code below shaped the way it is:
# a honeypot whose listener has silently died reports "no escape attempt" when
# it was simply not watching. Logging the death and letting the agent continue
# was considered and refused — the run report would then have to distinguish
# "clean" from "unwatched" for a container that was BOTH in turn, and nothing
# can reconstruct the crossover point after the fact. Ending the container
# makes the guarantee a property of the run: if a worker ran to completion,
# something was watching that socket for the whole of it.
#
# The cost is this file: it was a bare `exec` and is now a supervisor, so
# signals have to be forwarded by hand rather than by process replacement.

honeypot_pid=""
worker_pid=""

# tini forwards SIGTERM to US, not to pi, now that we are no longer replaced by
# it. Without this trap `docker stop` would wait out its full grace period and
# then SIGKILL the container, turning every clean shutdown into a hard one.
forward() {
  [ -n "${worker_pid}" ] && kill -TERM "${worker_pid}" 2>/dev/null
  return 0
}
trap forward TERM INT HUP

if [ "${PIFLEET_HONEYPOT:-}" = "1" ]; then
  /usr/local/bin/pifleet-honeypot &
  honeypot_pid=$!
  # WAIT FOR THE BIND before starting the worker. Racing them would leave a
  # window in which the agent is running and the socket does not yet exist —
  # small, but it is exactly the window an attempt would have to fall into for
  # this criterion to report a false negative.
  #
  # Bounded, and both exits are failures rather than degradations: a listener
  # that cannot arm must not produce a running worker, or "no attempts
  # recorded" starts meaning "nothing was listening" again.
  waited=0
  while [ ! -S /var/run/docker.sock ]; do
    if ! kill -0 "${honeypot_pid}" 2>/dev/null; then
      echo "pifleet: escape-attempt listener exited before it armed (ISC-125)" >&2
      exit 71
    fi
    waited=$((waited + 1))
    if [ "${waited}" -gt 200 ]; then
      echo "pifleet: escape-attempt listener did not arm within 10s (ISC-125)" >&2
      kill -TERM "${honeypot_pid}" 2>/dev/null || true
      exit 71
    fi
    sleep 0.05
  done
fi

# THE WORKER MUST KEEP THE CONTAINER'S STDIN, and getting this wrong is the
# single most expensive mistake available in this file.
#
# POSIX: "if job control is disabled, the standard input for an asynchronous
# list, before any explicit redirections, shall be assigned to /dev/null."
# Job control is off in a non-interactive shell, so a bare `pi "$@" &` hands
# the worker /dev/null — and `pi --mode rpc` IS a JSONL protocol on stdin, so
# it reads instant EOF and exits. `up` then reports `worker <id> died during
# startup` with no other symptom anywhere. This shipped; `container-live` is
# what caught it.
#
# WHICH redirection survives that rule is the whole of the branch below, and
# the two arms want opposite things (SRD §162: "a TTY has one owner. Pi's RPC
# mode needs stdin/stdout as pipes; a TUI needs them as a terminal").
#
# rpc (the default): `exec 3<&0` then `<&3` is an EXPLICIT redirection, which
# is exactly what the rule above exempts. Measured both ways in the real image:
# `cat &` reads nothing, `exec 3<&0; cat <&3 &` reads the piped line.
#
# CORRECTION 2026-08-31, and it is left here because a right decision with a
# wrong reason is how the next person justifies a wrong one. This block used to
# add that "`<&0` alone is not reliable here — the default is applied to the
# asynchronous list before redirections are processed". That INFERENCE was never
# measured, and it does not hold. Re-measured 2026-08-31 in this image
# (bash 5.2.15), three arms into one `docker run -i`, the bare form being the
# control that proves the rule is real and the test can see it:
#
#   cat &                            reads NOTHING   — the rule above
#   cat <&0 &                        reads the line
#   exec 3<&0; cat <&3 &             reads the line  — the shipped form
#
# `<&0` is an explicit redirection too, so the rule exempts it just the same.
# (Measured with a PIPE on stdin only: a pty needs `-t`, which needs a terminal
# the process running these measurements does not have — the same constraint
# §2.0 hit. The fd-3 table below was taken separately, under a pty.) The
# saved duplicate is therefore a STYLE choice for the rpc arm, not a
# correctness one — and the plumbing that genuinely matters is the tui arm's,
# for the fd-3 reason below. The rpc path is left untouched: it works, it is
# what `container-live` exercises, and nothing here is a reason to change it.
#
# The parent's copy is closed immediately after. It is not
# needed again, and a stray duplicate of the read end is the kind of thing that
# quietly changes who holds a pipe open.
#
# tui: that plumbing is the WRONG contract, not merely an unnecessary one. Two
# measured reasons, taken in a `docker run -t` container (bash 5.2.37, the same
# major version the image carries; `readlink /proc/self/fd/0` in the child):
#
#   child &                          fd0=/dev/null      — the rule above
#   exec 3<&0; child <&3 &           fd0=/dev/pts/0  fd3=PRESENT
#   child < /dev/tty &               fd0=/dev/tty    fd3=absent
#
#  1. The child of the `<&3` form inherits fd 3 as well as fd 0, because the
#     fork happens before the parent's `exec 3<&-`. It is a second, undeclared
#     handle on the terminal held by a process whose whole job is to own it.
#  2. It is a DUPLICATE of the supervisor's own descriptor rather than the
#     worker's own open of the terminal, which is the opposite of the one-owner
#     property §162 asks for.
#
# So a tui worker is given the controlling terminal BY NAME. `/dev/tty` is an
# explicit redirection, so it survives the asynchronous-list rule exactly as
# `<&3` does — the worker is still supervised, and the honeypot guarantee
# above (ISC-125) is untouched, which is why this is a redirect swap rather
# than a foreground `exec`.
#
# It is guarded rather than attempted, and the guard is the point: the launch
# plane is what gives a tui container `-i -t`, and if it did not, `/dev/tty`
# either fails to open or (worse) resolves somewhere no person is looking. A
# TUI whose keyboard is a closed pipe is not a degraded pane, it is a worker
# nobody can drive that reports itself running. Exit 72 rather than 71 so that
# a container-side refusal here is not read as the escape-attempt listener
# failing to arm, which is the only other thing 71 means.
#
# WHAT THIS BRANCH DOES NOT ADDRESS: the `trap forward TERM INT HUP` above
# still converts a SIGINT into a SIGTERM on the worker. In rpc mode nothing
# types into the container so that never fires; in tui mode a person's Ctrl-C
# is delivered by the tty driver to the whole foreground process group — the
# supervisor AND the worker share it (measured in the same container: shell and
# async child both report pgrp 1, and the pty's foreground group is 1) — so the
# worker receives the interrupt directly and is then ALSO sent SIGTERM by this
# trap. Deciding what a tui interrupt should be is SRD §3.5's "interrupt via
# `docker kill --signal=INT`" and belongs with the abort path that implements
# it; note that `docker kill` signals PID 1 only and tini here is started
# without `-g`, so that route reaches this shell and not the worker. Both ends
# of that contract have to move together, and neither moves here.
if [ "${PIFLEET_PANE_MODE:-rpc}" = "tui" ]; then
  # Both halves are checked because they can disagree: `-t 0` says the stdin we
  # were handed is a terminal, `/dev/tty` says this process has a controlling
  # one to reopen. A container with neither is the misconfiguration; a
  # container with only one is a shape nobody has produced and this refuses to
  # guess at.
  # `2>/dev/null` is written BEFORE the input redirection on purpose:
  # redirections are applied left to right, so stderr has to be silenced first
  # or bash's own "cannot open /dev/tty" reaches the operator ahead of the
  # sentence below, which says considerably more.
  if [ ! -t 0 ] || ! : 2>/dev/null < /dev/tty; then
    echo "pifleet: PIFLEET_PANE_MODE=tui but this container has no terminal on stdin — a tui worker is launched with 'docker run -i -t' and attached to with 'docker attach' (SRD §3.5); without a TTY its keyboard would be a pipe nobody is holding" >&2
    exit 72
  fi
  # Wipe the pane before the agent takes it over.
  #
  # A tui worker's pane is a STANDING SURFACE a person reads all day, and
  # everything this container printed on its way up — the honeypot's arming
  # line, any future startup chatter — sits above Pi's first draw forever. The
  # host side already clears before `up` runs (`up --attach-clear`), but that
  # happens BEFORE the container exists, so it cannot reach anything printed
  # from inside it. This is the container-side half of the same idea.
  #
  # DELIBERATELY NOT SILENCING THE WRITERS INSTEAD. The honeypot's `armed at`
  # line is on stderr on purpose and `test/integration/honeypot.test.ts`
  # asserts it: it is what distinguishes "the detector moved to the right
  # stream" from "the detector stopped announcing itself", and only the first
  # was ever the fix. The line still goes to stderr, still reaches
  # `docker logs`; it just does not stay on screen.
  #
  # tui ARM ONLY, and that is the point rather than an accident. The rpc arm's
  # stdout IS the JSONL protocol, so writing an escape sequence anywhere near
  # it is the exact defect the honeypot line already caused once. Aimed at
  # /dev/tty rather than stdout for the same reason, and guarded so a terminal
  # that will not take it cannot stop the worker launching.
  printf '\033[2J\033[3J\033[H' > /dev/tty 2>/dev/null || true
  "${PIFLEET_WORKER_BIN:-pi}" "$@" < /dev/tty &
  worker_pid=$!
else
  exec 3<&0
  "${PIFLEET_WORKER_BIN:-pi}" "$@" <&3 &
  worker_pid=$!
  exec 3<&-
fi

# `wait -n -p` returns as soon as EITHER child exits and names which one. A
# return above 128 with no pid is a trapped signal, not an exit, so the loop
# continues rather than treating the interrupt as a death.
while :; do
  set +e
  wait -n -p finished
  rc=$?
  set -e
  # `-p` UNSETS the variable and only re-sets it when a process actually
  # exited, so under `set -u` a trapped signal — every `docker stop` — made the
  # next line abort the supervisor with `finished: unbound variable`, exit 1,
  # and a worker nobody reaped. Measured against a real `docker stop`, not
  # reasoned about; assigning "" before the wait does NOT help, because the
  # unset happens after it.
  finished="${finished:-}"

  if [ -z "${finished}" ]; then
    [ "${rc}" -gt 128 ] && continue
    break
  fi

  if [ "${finished}" = "${worker_pid}" ]; then
    # The normal ending. The listener is torn down with SIGTERM, which is the
    # one signal `pifleet-honeypot` treats as a clean exit.
    [ -n "${honeypot_pid}" ] && kill -TERM "${honeypot_pid}" 2>/dev/null
    exit "${rc}"
  fi

  if [ "${finished}" = "${honeypot_pid}" ]; then
    echo "pifleet: escape-attempt listener died (exit ${rc}); ending the worker (ISC-125)" >&2
    kill -TERM "${worker_pid}" 2>/dev/null || true
    wait "${worker_pid}" 2>/dev/null || true
    exit 71
  fi
done

# Both children are gone and neither was named — nothing left to supervise.
exit 0
