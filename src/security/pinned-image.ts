/**
 * The one upstream image this fleet pins, and why it lives alone in a module.
 *
 * It was extracted from `relay.ts` when `gateway-block.ts` came to need it
 * too: `network.ts` imports the containment module, `relay.ts` imports
 * `network.ts`, and a digest constant reached through that path would have
 * closed an import cycle around the two modules that decide the egress
 * posture. A second copy of the digest would have been worse — the pin is
 * only a pin while there is exactly one of it.
 *
 * Plain upstream Node, not the worker image — PINNED BY DIGEST.
 *
 * The relay must not depend on `pifleet image build` having run — `up` would
 * then refuse to start over an unrelated image problem — and it needs nothing
 * the worker image adds. `docker/egress-relay.cjs` is dependency-free Node for
 * the same reason.
 *
 * The digest is not decoration. This is the ONE container bridging the
 * deny-all bridge to a NAT'd network, it runs `--restart unless-stopped`, and
 * a floating Docker Hub tag means the code on that boundary can change under
 * a machine reboot with no commit in this repo. `test/unit/relay.test.ts`
 * pins the whole argv byte-for-byte, so the digest is pinned by that test for
 * free and cannot drift silently.
 *
 * The digest below is the multi-arch OCI index (`linux/amd64` + `linux/arm64`
 * both present), so it resolves on CI runners and on Apple silicon alike —
 * verified with `docker buildx imagetools inspect node:24-bookworm-slim`.
 *
 * ROLLED: 2026-08-19. To roll it, re-run that command, paste the index
 * `Digest:` here, and update the unit test's expected argv.
 */
export const RELAY_IMAGE =
  "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
