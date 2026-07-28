/**
 * Phase 4 headline (ISC-134 / ISC-128): the `tmux` backend produces the SAME
 * acceptance results as `headless`. Skeleton — assertions land per test below.
 */

import { describe, test } from "bun:test";

describe("e2e backend equivalence (ISC-134/128)", () => {
  test.todo("the same run on headless and tmux settles identical artifacts");
  test.todo("a failing run settles identically on both backends");
  test.todo("ISC-135 (anti): a broken readScreen changes no acceptance result");
});
