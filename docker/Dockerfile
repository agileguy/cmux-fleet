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
# `procps` is pifleet's OWN dependency, not a convenience for the agent.
# `safety/procstart.ts` and `safety/procgroup.ts` both shell out to `ps` — it is
# how a run decides whether a pid is alive before it stops, reaps or prunes
# anything. `procstart.ts` already anticipates its absence in so many words
# ("a minimal container image with no procps"); what nobody noticed is that the
# worker image WAS that container. Without it every liveness read raises
# `IdentityReadError`, which wears `EXIT.BACKEND_UNAVAILABLE` — so the failure
# arrives as exit 3 from an unrelated command rather than as a missing binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep fd-find jq curl less tini gnupg procps openssh-client \
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
# `--ignore-scripts` is this image's supply-chain default, but bun's npm package
# is only a stub: its postinstall is what fetches the ~100MB platform binary that
# `bin/bun.exe` points at. Skip it and `bun` is still on PATH, but answers every
# invocation with "Bun's postinstall script was not run" — so a tester asked to
# run a Bun project's suite has no runner at all. Run that one known script by
# name and the default stays in force for every other package.
RUN npm install -g --ignore-scripts bun@1.3.12 \
 && node "$(npm root -g)/bun/install.js"
# TYPECHECKER AND LINTER, on PATH without a project install.
#
# A cloned checkout carries no `node_modules` — it is gitignored — so `tsc` and
# `eslint` are absent in a fresh clone until its dependencies are installed,
# and a worker asked to "typecheck this" would have to install the world first
# or report a missing binary. Global copies make the quick answer available;
# a project that vendors its own still wins, because `npx`/`bun x` resolve the
# local one ahead of the global.
#
# `--ignore-scripts` stays in force: unlike bun's stub package, neither of these
# needs a postinstall to be usable.
RUN npm install -g --ignore-scripts typescript eslint
# --- every language toolchain includes node (2026-09-04) ---
#
# The chain is `base -> node -> <language>`, so `python` means "python AND
# node" and every language added later inherits the same rule by building on
# `toolchain-node` rather than on `base`.
#
# The reason is that node here is not a language choice, it is the harness. The
# base image IS `node:24-bookworm-slim`, so `node` itself was always present —
# what `toolchain-node` adds is `bun`, and bun is what runs this repository's
# own suite and a great many projects' tooling. Measured: switching the tester
# from `node` to `python` gave it pytest and silently took away its ability to
# run any bun project at all, including cmux-fleet's. A toolchain that removes
# a capability to add one makes the choice a trade rather than an addition.
FROM toolchain-node AS toolchain-python
# `python3-pip` alongside `uv`, and the reason is not redundancy.
#
# A cloned project's own instructions say `pip install -r requirements.txt`, and
# a tester following them must not hit `pip: command not found` and have to
# invent an equivalent. `uv` stays because it is the faster path and the one
# this fleet's own docs prefer; `uv pip install` speaks the same surface.
#
# PEP 668: Debian marks the system interpreter EXTERNALLY-MANAGED, so a bare
# `pip install` into it refuses with `error: externally-managed-environment`.
# That refusal is correct and is left in place — the answer is a venv, which is
# why `python3-venv` is here, and `~/repos` is writable and executable so one
# can be created next to the clone. A worker that reads the refusal will do the
# right thing; one that is handed a system-wide install would poison the image
# for every later task in the same container.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
# LINTER AND TYPECHECKER for python, installed as TOOLS rather than as packages.
#
# `uv tool install` gives each its own isolated environment and drops only the
# entry points into `UV_TOOL_BIN_DIR`. That matters here because the system
# interpreter is PEP 668 externally-managed: `pip install ruff` into it is
# refused, and forcing past that with `--break-system-packages` would put
# pifleet's tooling in the same site-packages a cloned project's dependencies
# land in, where a version conflict makes the linter a project's problem.
#
# `/usr/local/bin` because that is on every worker's PATH; uv's default is a
# per-user directory under a `$HOME` that is read-only at runtime.
# BOTH directories, and the second one is the whole of the bug it fixes.
#
# `UV_TOOL_BIN_DIR` alone put the entry points in `/usr/local/bin` as symlinks
# INTO `/root/.local/share/uv/tools/...`. The build succeeded, the links were
# there, and `ruff --version` still reported command-not-found for uid 10001 —
# root's home is 0700, so the worker cannot traverse to the target. A dangling
# permission is worse than a missing tool: `command -v ruff` finds it.
#
# `UV_TOOL_DIR` moves the environments somewhere every uid can read, and the
# chmod is explicit rather than trusted to umask.
ENV UV_TOOL_DIR=/opt/uv-tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install ruff \
 && uv tool install mypy \
 && chmod -R a+rX /opt/uv-tools
# UPSTREAM GO, NOT DEBIAN'S. Bookworm ships go1.19.8 (2023), which is past end
# of life and cannot build most current Go code — including its own linter:
#
#   honnef.co/go/tools/lintcmd/cmd.go:11:2:
#     package go/version is not in GOROOT (/usr/lib/go-1.19/src/go/version)
#   golang.org/x/tools/go/packages/external.go:16:2:
#     package slices is not in GOROOT
#
# `slices` and `go/version` are 1.21 standard library. A toolchain whose
# compiler predates the language most projects now write is not a Go toolchain,
# so the apt package is skipped entirely rather than supplemented.
#
# `TARGETARCH` is re-declared because ARGs do not cross stage boundaries, and
# Go's own naming (`amd64`, `arm64`) matches Docker's, so it is used verbatim.
FROM toolchain-node AS toolchain-go
ARG TARGETARCH
ARG GO_VERSION=1.24.7
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
      -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go \
 && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt
# `go vet` and `gofmt` ship inside the toolchain, so the gap is a real linter.
# GOBIN puts it on the worker's PATH; GOPATH/GOCACHE are set to a world-readable
# place because a worker running as uid 10001 cannot use root's default and Go
# fails hard rather than degrading when its cache is unwritable.
ENV GOPATH=/opt/go GOCACHE=/opt/go/cache
RUN GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2025.1.1 \
 && chmod -R a+rX /opt/go
FROM toolchain-python AS toolchain-full
ARG TARGETARCH
ARG GO_VERSION=1.24.7
ENV GOPATH=/opt/go GOCACHE=/opt/go/cache
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
      -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go \
 && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
 && GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2025.1.1 \
 && chmod -R a+rX /opt/go
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

# The SSH transport shim (SRD-OBSERVER-ROLES §12 Phase 3, task 3.3). Turns
# one enrolled target token into a fixed `ssh` argv. Per the file's own "Who
# owns what": it owns ARGV SAFETY, refusing every argument it cannot validate
# before `ssh` ever runs; the target's own forced command owns the verb
# allowlist, because only the target can enforce a rule the worker cannot
# step around. On PATH as `observe-ssh`, and called by `observe-docker` below.
COPY --chmod=0755 docker/observe-ssh /usr/local/bin/observe-ssh

# The Docker role's entry-point alias (SRD-OBSERVER-ROLES §12 Phase 4, task
# 4.2), called by the `observer-docker` role. It answers `--help`/`-h` when that
# is the sole argument and passes every other argv to `observe-ssh docker`
# unchanged. On PATH as `observe-docker`.
COPY --chmod=0755 docker/observe-docker /usr/local/bin/observe-docker

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
    ssh -V; \
    observe-ssh --help >/dev/null; \
    observe-docker --help >/dev/null; \
    observe-docker --help extra 2>&1 | grep -qF 'observe-ssh: refused before ssh ran'; \
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

# The truncation-recovery extension. Same reasoning as the file above on every
# count — in-process, root-owned, 0444, denied to the worker — and it is loaded
# for EVERY worker rather than only the auto-triggered ones, because a truncated
# tool result is not a `tui` concept. An rpc worker truncates identically and
# its operator is a program that will not notice.
#
# ADDING THIS COPY MEANT ADDING "pi-extensions/truncation-recovery.ts" TO
# `BUILD_CONTEXT_ASSETS` in src/container/image.ts.
COPY --chmod=0444 docker/pi-extensions/truncation-recovery.ts /opt/pifleet/truncation-recovery.ts

# The report-tools extension (SRD-WORKER-DISPATCH-EXTENSION D1). It registers
# `submit_report`, which composes the `pifleet.result/v1` envelope from
# /policy/task — a file the worker cannot write — instead of asking a model to
# copy `schema`, `task_id`, `epoch` and `worker` correctly out of its prompt.
# Same reasoning as the two files above on every count: in-process, root-owned,
# 0444, denied to the worker. This COPY only PLACES it — nothing loads it yet.
# The `--extension /opt/pifleet/report-tools.ts` argv is task 2.4 and lands in
# src/config/render.ts; until it does, the file is present and inert.
#
# ADDING THIS COPY MEANT ADDING "pi-extensions/report-tools.ts" TO
# `BUILD_CONTEXT_ASSETS` in src/container/image.ts. Stale here is quiet in a
# different way from the two above, and worth naming: this file's job is to
# VALIDATE and only then write, so an image carrying an older copy does not
# stop producing envelopes and does not produce malformed ones. It produces
# well-formed envelopes checked against a rule set that has since moved.
COPY --chmod=0444 docker/pi-extensions/report-tools.ts /opt/pifleet/report-tools.ts

# The SSH ProxyCommand (SRD-OBSERVER-ROLES §5.2 task 3.1). `observe-ssh`
# (task 3.2, shipped and on PATH via task 3.3 above; no role calls it yet)
# runs every observer SSH call as
# `-o ProxyCommand="node /opt/pifleet/ssh-connect.cjs %h %p"`, because OpenSSH
# has no native CONNECT support and this image carries no `nc`/`socat`
# (`:48-49` above) — `node` is the one thing guaranteed present, since the
# base image itself is `node:*-bookworm-slim` (`:20`). Read by `node`, never
# executed directly, so 0444 — same reasoning as the three extensions above.
#
# ADDING THIS COPY MEANT ADDING "ssh-connect.cjs" TO `BUILD_CONTEXT_ASSETS` in
# src/container/image.ts. A stale copy here is dangerous in the same shape the
# honeypot's staleness is: it is the ONLY thing standing between an operator
# and the proxy's `403` rule name (`docker/connect-proxy.cjs:257-265`), so a
# copy that regresses the refusal path hides WHY egress was denied behind
# OpenSSH's own opaque `kex_exchange_identification` failure instead.
COPY --chmod=0444 docker/ssh-connect.cjs /opt/pifleet/ssh-connect.cjs

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
