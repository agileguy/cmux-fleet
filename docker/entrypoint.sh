#!/bin/sh
# Worker container entrypoint (runs under tini as PID 1).
#
# Its one real job: render ~/.pi/agent/models.json from the environment before
# Pi starts. Pi reads oMLX provider configuration from that FILE, not from env,
# and only registers a provider when the models list is non-empty (SRD Q9 —
# recorded in the agentic-SRE work). Skipping this step produces a worker that
# streams tokens happily and can reach no model at all.
#
# Environment contract (injected by the supervisor via --env-file):
#   PIFLEET_LLM_PROVIDER   provider name, default "omlx"
#   PIFLEET_LLM_BASE_URL   e.g. http://host.docker.internal:8000/v1
#   PIFLEET_LLM_MODELS     comma-separated model ids; EMPTY means "render nothing"
#   OMLX_API_KEY           local server credential (not a billing key — SRD §5.9)
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

exec "${PIFLEET_WORKER_BIN:-pi}" "$@"
