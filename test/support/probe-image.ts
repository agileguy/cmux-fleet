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
