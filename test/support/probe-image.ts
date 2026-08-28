/**
 * The container image the ISC-126 second-uid probe runs in, PINNED BY DIGEST.
 *
 * ## Why a second pinned image exists at all
 *
 * `src/security/pinned-image.ts` pins the relay's Node image for production.
 * This one is test-only, so it lives here rather than in `src/`: nothing pifleet
 * ships ever pulls it, and a production module that names an image production
 * never runs is a module that invites someone to use it.
 *
 * ## Why not the worker image
 *
 * `pifleet/pi-worker` would need no new pin, and it was the first choice. It
 * cannot be used, for a measured reason: the probe's server half must execute
 * `serveJsonlSocket` — the real one, not a copy — so the image needs `bun`, and
 * the worker image only has it under `--toolchain node`, whose layer is
 * `npm install -g bun`. On the maintainer's machine that layer cannot be built
 * at all: the corporate proxy blocks npmjs.org from inside a Docker build, so
 * `npm install -g --ignore-scripts bun@1.3.12` fails there while Docker Hub
 * PULLS succeed. Pinning the worker image would therefore have produced a probe
 * that runs only on CI — and a probe whose green state has never been observed
 * is the failure ISA.md's mutation convention exists to prevent. With this pin,
 * the probe's red and green were both observed on the maintainer's machine
 * before it shipped.
 *
 * ## Why the version tracks CI's bun
 *
 * 1.3.12 is the version `.github/workflows/ci.yml` pins for the runner. The
 * probe's server is production code, and running it against a materially older
 * or newer runtime than the rest of the suite would make a failure here mean
 * two things at once.
 *
 * The digest is the multi-arch OCI INDEX, not a platform manifest — verified
 * with `docker buildx imagetools inspect oven/bun:1.3.12-slim`, which lists
 * `linux/amd64` and `linux/arm64` beneath it. That is what lets the same
 * constant resolve on a GitHub runner and on Apple silicon, and it is the same
 * property `pinned-image.ts` documents for `RELAY_IMAGE`.
 *
 * ROLLED: 2026-08-24. To roll it, re-run that command, paste the index
 * `Digest:` here, and keep the tag's bun version in step with ci.yml.
 */
export const PROBE_BUN_IMAGE =
  "oven/bun:1.3.12-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f";

/**
 * The docker-in-docker image the ISC-292 remote-daemon probe runs, PINNED BY
 * DIGEST.
 *
 * ## What it is for
 *
 * ISC-292's hazard — a `-v` whose source the DAEMON cannot see is silently
 * replaced by an empty directory instead of failing — had no reproducible
 * reader, because it was believed to be a macOS-VM property and a test cannot
 * ask a native Linux daemon to forget a path it can plainly see. That premise
 * is wrong. The hazard is not about macOS; it is about a daemon whose
 * filesystem DIFFERS FROM THE CLIENT'S, and dind produces exactly that on any
 * host. `docker:28.5-dind` started `--privileged` with `DOCKER_TLS_CERTDIR=`
 * and its 2375 published is a SECOND daemon with its own root filesystem —
 * confirmed distinct by `docker info` reporting `Alpine Linux v3.24
 * (containerized) / 29.7.2` through it against `Ubuntu 24.04.2 / 28.4.0` on
 * the ambient one. Point a client at it and `/Users/...` exists on the client
 * and nowhere in the daemon, which is the hazard, reproduced deliberately.
 *
 * ## Why it is pinned HERE
 *
 * The same reason `PROBE_BUN_IMAGE` is: nothing pifleet ships ever pulls it.
 * `src/security/pinned-image.ts` pins images production runs, and putting a
 * test-only daemon image there would advertise it as one production could use.
 *
 * ## Why 28.5 and not `dind` or `latest`
 *
 * A floating tag would let the daemon under test change without a commit,
 * which for a suite whose entire subject is a difference between two daemons
 * is the one variable that must not drift. 28.5 is deliberately close to the
 * ambient daemon the rest of the suite uses (28.4.0 as measured above) so the
 * inner daemon is a plausible peer rather than an exotic one — the test's
 * claim is "a different filesystem", not "a different Docker".
 *
 * The digest is the multi-arch OCI INDEX, not a platform manifest — verified
 * with `docker buildx imagetools inspect docker:28.5-dind`, which lists
 * `linux/amd64` and `linux/arm64/v8` beneath it. That is what lets the same
 * constant resolve on a GitHub runner and on Apple silicon, exactly as
 * `PROBE_BUN_IMAGE` and `pinned-image.ts`'s `RELAY_IMAGE` both document.
 *
 * ROLLED: 2026-08-28. To roll it, re-run that command, paste the index
 * `Digest:` here, and keep the tag within a minor or so of whatever daemon
 * `PIFLEET_DOCKER=1` suites run against, so a failure means the mount and not
 * the Docker generation.
 */
export const PROBE_DIND_IMAGE =
  "docker:28.5-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac";
