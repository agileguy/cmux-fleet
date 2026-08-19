# syntax=docker/dockerfile:1
#
# Pi worker image (SRD §5.2) — a hardened elaboration of Pi's own shipped
# docs/containerization.md "Plain Docker" pattern.
#
# A worker is not "pi with some flags"; it is a reproducible environment with a
# declared toolchain, a fixed uid, and a mount table. Two workers on the same
# role must be byte-identical environments or the fleet's results are not
# comparable (SRD §5.1). PI_VERSION is pinned because §4.2's entire protocol
# contract is version-specific — the SRD itself is one casualty of assuming
# otherwise.

# Globals: an ARG used in a FROM stage name must be declared BEFORE the first
# FROM; stages that consume a value re-declare it locally below.
ARG NODE_TAG=24-bookworm-slim
ARG PI_VERSION=0.79.6
ARG TOOLCHAIN=base          # base | node | python | go | full
ARG EXTRA_APT_PACKAGES=""   # config `image.apt_packages`, appended as a layer (§5.3)

FROM node:${NODE_TAG} AS base

ARG TARGETARCH              # arm64 on this machine (Colima/aarch64)

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep jq curl less tini gnupg \
 && rm -rf /var/lib/apt/lists/*

# --- cloud CLI baseline: present in EVERY worker image (SRD §5.3) ---
# SRE-shaped tasks are a primary use case; a role that discovers mid-task that
# kubectl is missing is a wasted run.
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin kubectl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
      | HELM_INSTALL_DIR=/usr/local/bin bash

# --- verb gate: real binaries move aside, wrappers take their names (§5.10) ---
# Read verbs flow freely; mutating verbs need the task's cloud_allow[]. The
# shim is defence-in-depth against the CASUAL destructive action — a worker
# with bash can still reach the .real path, which is why impersonation remains
# the stronger control.
# `mv` alone is wrong here. The Cloud SDK installs /usr/bin/gcloud as a
# *relative* symlink to ../lib/google-cloud-sdk/bin/gcloud, which resolves under
# /usr/lib. Moving that link into /usr/local/libexec/ re-anchors it at
# /usr/local/lib, where nothing exists — the link survives the move, the build
# succeeds, and every gcloud and kubectl call in the finished image exits 127.
# Resolve to the absolute target before relocating, and re-link rather than move
# when the source was a symlink so the SDK's own layout stays intact.
# gsutil and bq ship with google-cloud-cli, share the same credentials, and are
# fully mutating (`gsutil rm -r`, `bq rm`). Wrapping only gcloud/kubectl/helm
# left two ungated destructive CLIs on PATH. The SDK also installs a second
# kubectl copy under its own bin dir, which is relocated for the same reason.
RUN set -eux; \
    mkdir -p /usr/local/libexec; \
    for b in gcloud kubectl helm gsutil bq; do \
      src="$(command -v "$b")" || continue; \
      real="$(readlink -f "$src")"; \
      if [ "$real" != "$src" ]; then \
        ln -sfn "$real" "/usr/local/libexec/${b}.real"; \
        rm -f "$src"; \
      else \
        mv "$src" "/usr/local/libexec/${b}.real"; \
      fi; \
      # Fail the build here rather than ship an image whose tools are all 127.
      test -x "/usr/local/libexec/${b}.real"; \
    done
# NOTE: the SDK's own bin dir keeps copies of some of these, and they are not
# hidden. Hardening them is pointless theatre while `.real` is reachable by
# design (see the shim header): a determined worker with bash does not need a
# second copy. PATH ordering is what routes the CASUAL call through the gate,
# and credential scoping is the control that actually binds. An earlier attempt
# to chmod these away also broke the wrappers outright, because the relocated
# `.real` entries are symlinks INTO this directory.
COPY --chmod=0755 docker/verbgate /usr/local/bin/gcloud
COPY --chmod=0755 docker/verbgate /usr/local/bin/kubectl
COPY --chmod=0755 docker/verbgate /usr/local/bin/helm
COPY --chmod=0755 docker/verbgate /usr/local/bin/gsutil
COPY --chmod=0755 docker/verbgate /usr/local/bin/bq

# --- optional toolchain layers, selected by build arg (§5.3) ---
FROM base AS toolchain-base
FROM base AS toolchain-node
RUN npm install -g --ignore-scripts bun@1.3.12
FROM base AS toolchain-python
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
FROM base AS toolchain-go
RUN apt-get update && apt-get install -y --no-install-recommends golang-go \
 && rm -rf /var/lib/apt/lists/*
FROM base AS toolchain-full
RUN npm install -g --ignore-scripts bun@1.3.12 \
 && apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv golang-go \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
FROM toolchain-${TOOLCHAIN} AS final

ARG PI_VERSION
ARG EXTRA_APT_PACKAGES

# Per-config OS packages — a role can add imagemagick without a new Dockerfile.
RUN if [ -n "${EXTRA_APT_PACKAGES}" ]; then \
      apt-get update \
   && apt-get install -y --no-install-recommends ${EXTRA_APT_PACKAGES} \
   && rm -rf /var/lib/apt/lists/*; \
    fi

# --ignore-scripts: install-time scripts are an unnecessary supply-chain surface.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

# Every toolchain variant must carry a working gcloud/kubectl/helm/jq/curl
# (§5.3). Executing each one at build time is the difference between an image
# that *contains* the tools and an image where they *run*: the relocation above
# once produced a build that passed every presence check and exited 127 on use.
RUN set -eux; \
    gcloud version >/dev/null; \
    kubectl version --client >/dev/null; \
    helm version >/dev/null; \
    jq --version >/dev/null; \
    curl --version >/dev/null; \
    pi --version >/dev/null

# Non-root, fixed uid so bind-mount ownership is deterministic on Colima/virtiofs.
RUN groupadd -g 10001 pi && useradd -u 10001 -g 10001 -m -s /bin/bash pi

# /policy holds the task's cloud_allow[] and is deliberately NOT chowned to the
# worker: it was previously read from /outbox, which the worker owns, so the
# subject of the policy could rewrite the policy. Root-owned and mounted
# read-only; verbgate refuses every verb if it finds this path writable.
RUN mkdir -p /workspace /outbox /sessions /skills /creds /policy \
             /home/pi/.pi/agent /home/pi/.config/gcloud /home/pi/.kube \
 && chown -R 10001:10001 /workspace /outbox /sessions /home/pi \
 && chown -R 0:0 /policy \
 && chmod 0555 /policy

# /workspace is a bind-mounted git clone the worker must be able to commit in,
# and git refuses to operate in a repository it thinks someone else owns:
# `fatal: detected dubious ownership in repository at '/workspace'`. On this
# machine's Colima/virtiofs setup that is not hypothetical — it is the default,
# and it fails in a way that reads as a broken worker rather than a mount
# property.
#
# `--system`, NOT `--global`, and the distinction is the whole reason this is
# baked into the image. uid 10001's $HOME is /home/pi, which under
# `--read-only` roots is not writable, so `git config --global` at runtime has
# nowhere to write and the setting silently does not take. The system file
# (/etc/gitconfig) is written HERE, as root, at build time, and is readable by
# every uid afterwards.
#
# Baked rather than discovered at runtime for a second reason: the failure is
# INTERMITTENT to observe. The mountpoint itself reports uid 0 until the first
# write refreshes virtiofs's attribute cache, after which subsequent commands
# see uid 10001 — so a probe-and-fix at container start can pass on the very
# run where the worker's first real `git commit` fails.
RUN git config --system --add safe.directory /workspace

# Entry wrapper renders ~/.pi/agent/models.json from env before exec'ing pi —
# Pi reads oMLX provider config from that file, NOT from env (SRD Q9).
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/pifleet-entrypoint

USER 10001:10001
WORKDIR /workspace
ENV PI_OFFLINE=0 \
    HOME=/home/pi \
    PIFLEET_CONTAINER=1 \
    CLOUDSDK_CONFIG=/home/pi/.config/gcloud \
    CLOUDSDK_CORE_DISABLE_PROMPTS=1 \
    USE_GKE_GCLOUD_AUTH_PLUGIN=True

# tini as PID 1 so signals reach pi and zombies are reaped — without it,
# `docker kill --signal=INT` does not interrupt cleanly (SRD §5.2).
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/pifleet-entrypoint"]
