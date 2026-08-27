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
#   PIFLEET_LLM_PROVIDER   provider name, default "omlx"
#   PIFLEET_LLM_BASE_URL   e.g. http://host.docker.internal:8000/v1
#   PIFLEET_LLM_MODELS     comma-separated model ids; EMPTY means "render nothing"
#   OMLX_API_KEY           local server credential (not a billing key — SRD §5.9)
#   PIFLEET_HONEYPOT       "1" arms the escape-attempt listener and makes its
#                          death fatal. UNSET means no listener at all, which is
#                          how `image verify` and the acceptance containers run:
#                          they have no /run tmpfs and no /outbox, so a listener
#                          could neither bind nor record. A real worker that
#                          comes up without this set is NOT silently fine — it
#                          reports as `unwatched` in `pifleet report`, which is
#                          the whole point of the third state.
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
if [ -n "${PIFLEET_LLM_BASE_URL:-}" ] && [ -n "${PIFLEET_LLM_MODELS:-}" ]; then
  jq -n \
    --arg provider "${PIFLEET_LLM_PROVIDER:-omlx}" \
    --arg baseUrl "${PIFLEET_LLM_BASE_URL}" \
    --arg apiKey "${OMLX_API_KEY:-}" \
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
# `exec 3<&0` then `<&3` is an EXPLICIT redirection, which is exactly what the
# rule above exempts. `<&0` alone is not reliable here — the default is applied
# to the asynchronous list before redirections are processed, so the saved
# duplicate is the form that survives it. Measured both ways in the real image:
# `cat &` reads nothing, `exec 3<&0; cat <&3 &` reads the piped line.
#
# The parent's copy is closed immediately after. It is not needed again, and a
# stray duplicate of the read end is the kind of thing that quietly changes who
# holds a pipe open.
exec 3<&0
"${PIFLEET_WORKER_BIN:-pi}" "$@" <&3 &
worker_pid=$!
exec 3<&-

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
