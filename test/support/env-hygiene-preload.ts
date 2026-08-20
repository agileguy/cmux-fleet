/**
 * The preload entry that arms the `PIFLEET_*` environment guard (ISC-278).
 *
 * A separate, one-line file rather than an install at the bottom of
 * `env-hygiene.ts`, because that module is also IMPORTED by
 * `test/unit/env-hygiene-guard.test.ts` to exercise its pure functions. An
 * install on import would arm a second check inside that file's own scope,
 * against a baseline taken partway through the run — it would fire on drift
 * that is just a test doing its job. Preloading and importing are different
 * acts and this split keeps them different.
 *
 * Wired in `bunfig.toml` under `[test] preload`, so a bare `bun test` is
 * covered — which is the case that matters, since the leak this guards against
 * was found by a human sweep and not by any command anyone runs on purpose.
 * (`[test] preload` is honoured on bun 1.3.11; `[test] timeout` is not, per
 * `test/support/budget.ts`. Both were probed, neither assumed.)
 */

import { installEnvHygieneGuard } from "./env-hygiene.ts";

installEnvHygieneGuard();
