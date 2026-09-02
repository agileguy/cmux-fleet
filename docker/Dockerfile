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

# `ripgrep` and `fd-find` are not general conveniences here — they are the two
# binaries Pi's own tools-manager BOOTSTRAPS OVER THE NETWORK when it cannot
# find them, downloading release tarballs from api.github.com and
# objects.githubusercontent.com on first start. A pifleet worker runs behind a
# deny-all egress policy (§12.4), so that fetch cannot succeed and must not:
# widening the allowlist to let every worker pull an unpinned binary from
# GitHub at startup would put a supply-chain fetch inside the sandbox, and the
# whole point of a pinned image is that two workers on one role are
# byte-identical. Shipping both tools makes the download UNREACHED rather than
# merely blocked.
#
# The symlink is load-bearing, not tidiness. Debian ships the binary as
# `fdfind` (the name `fd` belongs to fdclone), and Pi 0.79.6 happens to accept
# either — `systemBinaryNames: ["fd", "fdfind"]`. Providing BOTH names means
# the fix does not depend on Pi continuing to know Debian's rename, and a
# worker's own `fd ...` command line works the way its muscle memory expects.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep fd-find jq curl less tini gnupg \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

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

# Pi TUI colour themes (src/config/themes.ts holds the reasoning and the names).
#
# Pi ships exactly two, `dark` and `light`, and `light` is not a usable second
# choice: a Pi theme defines no page background, so it paints light-mode ink
# onto whatever the terminal already has. The operations console runs two
# attended panes side by side and needs them tellable apart, so the image
# carries a bundle of well-known palettes.
#
# WHAT WAS READ BEFORE TRUSTING THIS, because it is third-party code entering
# every worker container. The published 0.1.6 tarball is 19 files: 16 theme
# JSONs, README, an MIT LICENSE, package.json. It carries NO JavaScript at all,
# no `scripts` block (so no pre/post-install hook — `--ignore-scripts` below is
# belt to that braces), no dependencies, no `bin`, no `main`: nothing in it is
# executable or require-able. Every theme file is pure ASCII with no control
# characters, which matters more than it sounds — theme values are emitted to
# the terminal as escape sequences, so a smuggled ESC would be terminal
# injection — and every value is a hex colour, an integer 0-255, or a reference
# to that file's own `vars`.
#
# The version is PINNED and must equal `PI_THEMES_VERSION` in
# src/config/themes.ts; test/unit/themes.test.ts asserts the two agree. One
# immutable tarball per version is all the pin buys. It is not a claim that some
# future version is safe, and bumping it means reading the tarball again.
#
# COPIED OUT of the npm tree, then uninstalled, for two reasons: /home/pi/.pi/
# agent is Pi's own custom-theme directory and is a named volume at run time,
# which would mask anything baked at that path; and leaving the package in the
# global tree would give the same 16 themes two possible discovery routes.
#
# The `test -f` loop is the load-bearing half. It is the second arrow in
# themes.ts's `THEME_NAMES → Dockerfile → image` chain: a bundle that renamed or
# dropped a file fails the BUILD here, instead of shipping a worker whose
# configured theme silently falls back to the default.
ARG PI_THEMES_VERSION=0.1.6
RUN set -eux; \
    npm install -g --ignore-scripts @firstpick/pi-themes-bundle@${PI_THEMES_VERSION}; \
    mkdir -p /opt/pifleet; \
    cp -R "$(npm root -g)/@firstpick/pi-themes-bundle/themes" /opt/pifleet/themes; \
    npm uninstall -g --ignore-scripts @firstpick/pi-themes-bundle; \
    for t in catppuccin-latte catppuccin-mocha crimson-noir dracula everforest-dark \
             gruvbox-dark gruvbox-light matrix nord one-dark rose-pine rose-pine-dawn \
             solarized-dark solarized-light tokyo-night tokyo-night-storm; do \
      test -f "/opt/pifleet/themes/${t}.json"; \
    done; \
    chmod -R a+rX /opt/pifleet

# The ticket CLI (src/config/ticket-cli.ts holds the pin; skills/ticket-ops
# says how to drive it).
#
# THIS REVERSES A DECISION THE SKILL USED TO ARGUE FOR, and the reversal is
# recorded rather than quietly applied. `skills/ticket-ops/SKILL.md` said "there
# is no ticket CLI in the image and there is not going to be one", on two
# grounds: a vendor CLI "puts a vendor's name in the image hash and in a public
# repository", and it pins the fleet to whatever that CLI calls an update. The
# first ground is spent — this repository is private, and the skill has named
# `rally1.rallydev.com` since 2026-08-30, so the vendor is already here. The
# second is real and is answered by the pin below rather than by abstention.
#
# WHAT IT BUYS, which is the reason the owner asked for it: the hand-rolled curl
# path had to be TAUGHT the vendor — which URL segment is a user story, that a
# FormattedID is not an object id, which fields must be in `fetch=` or the reply
# is tens of kilobytes. Every one of those was a sentence in a document that
# nothing re-ran, and one of them (`Authorization: Token`, which Rally answers
# with an HTML login page) was wrong for months because no credential existed to
# exercise it. A CLI moves that knowledge behind a command that fails loudly.
#
# PINNED TO A COMMIT, not a tag or a branch. A tag is a moving reference: the
# same `v1.2.0` can be re-pointed, and an image rebuilt a month later would
# install different code under an unchanged Dockerfile. The commit is what makes
# `docker/Dockerfile`'s digest a real input to the image hash.
#
# ITS OWN VIRTUALENV at /opt/pifleet/rally-cli, not the system python, so the
# `python` toolchain variant's site-packages stay the operator's to use —
# textual, httpx and pydantic are this tool's dependencies, not the fleet's, and
# a worker doing Python work must not find them already resolved at versions it
# did not choose. Only the entry point is published onto PATH.
ARG TICKET_CLI_REPO=https://github.com/dan-elliott-appneta/rally-cli.git
ARG TICKET_CLI_COMMIT=38a3b5e462393259c215ddc6babae505d62be1e2
ARG TICKET_CLI_VERSION=1.2.0
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 python3-venv; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/pifleet/rally-cli; \
    /opt/pifleet/rally-cli/bin/pip install --no-cache-dir --quiet --upgrade pip; \
    /opt/pifleet/rally-cli/bin/pip install --no-cache-dir --quiet \
        "git+${TICKET_CLI_REPO}@${TICKET_CLI_COMMIT}"; \
    chmod -R a+rX /opt/pifleet/rally-cli; \
    # The load-bearing half, and it asserts the VERSION rather than presence.
    # `pip install` of a git ref succeeds for any commit that builds, so a
    # mis-typed sha would produce a working image running something else
    # entirely. This is the same arrow the themes block's `test -f` loop is:
    # a pin that nothing re-reads at build time is a comment.
    #
    # Run against the REAL entry point, not the PATH name: the shim below
    # refuses to exec without delivered configuration, which no build has.
    /opt/pifleet/rally-cli/bin/rally-cli --version | grep -qF "version ${TICKET_CLI_VERSION}"

# The shim that configures it. On PATH as `rally-cli`, so a worker never types
# the credential — see the file's own header for why this is a shim and not a
# paragraph in the skill.
COPY --chmod=0755 docker/ticket-cli /usr/local/bin/rally-cli

# Every toolchain variant must carry a working gcloud/kubectl/helm/jq/curl/rg/fd
# (§5.3). Executing each one at build time is the difference between an image
# that *contains* the tools and an image where they *run*: the relocation above
# once produced a build that passed every presence check and exited 127 on use.
# `fd` and `fdfind` are BOTH executed because they are two names for one
# binary and the symlink is what makes the first of them exist.
RUN set -eux; \
    gcloud version >/dev/null; \
    kubectl version --client >/dev/null; \
    helm version >/dev/null; \
    jq --version >/dev/null; \
    curl --version >/dev/null; \
    rg --version >/dev/null; \
    fd --version >/dev/null; \
    fdfind --version >/dev/null; \
    /opt/pifleet/rally-cli/bin/rally-cli --version >/dev/null; \
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

# The escape-attempt honeypot (ISC-125) — an AF_UNIX listener bound at
# /var/run/docker.sock, so that a worker reaching for the Docker socket is
# RECORDED rather than merely refused. node, not python3: the base image IS
# node:*-bookworm-slim so it is present in every toolchain variant, while
# python3 is only a transitive dependency of google-cloud-cli and would vanish
# with a packaging change nobody here would notice.
#
# ADDING THIS COPY MEANS ADDING "honeypot.cjs" TO `BUILD_CONTEXT_ASSETS` in
# src/container/image.ts. That list is what the image tag's config hash walks;
# a COPY source missing from it is ISC-270's fail-open, where an edited build
# context leaves the tag unchanged and a stale image is silently reused.
COPY --chmod=0755 docker/honeypot.cjs /usr/local/bin/pifleet-honeypot

# The auto-trigger extension (SRD-TUI-DISPATCH §9 Q4) — what removes the
# keystroke from a staged dispatch.
#
# 0444 and root-owned by default, which is the whole reason it is baked in
# rather than bind-mounted. Pi loads it with `--extension` and runs it IN
# PROCESS with the full extension API, so a worker able to write it would be a
# worker able to make itself dispatch anything. A mount would carry that
# guarantee in a `:ro` flag that is one character from being dropped; a root-owned
# image layer carries it in the filesystem.
#
# `--no-extensions` stays on the pi argv alongside `--extension`: that flag
# disables DISCOVERY only, so repo-supplied `.pi/extensions/*.ts` remains denied
# (SRD §12.2) while this one path still loads.
#
# ADDING THIS COPY MEANT ADDING "pi-extensions/dispatch-trigger.ts" TO
# `BUILD_CONTEXT_ASSETS` in src/container/image.ts — a stale copy of this file
# stops triggering silently, which is worse than any loud failure.
COPY --chmod=0444 docker/pi-extensions/dispatch-trigger.ts /opt/pifleet/dispatch-trigger.ts

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
