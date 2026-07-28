/**
 * Phase 4 backend selection and fallback (ISC-131). Skeleton — assertions land
 * per test below.
 */

import { describe, test } from "bun:test";

describe("backend selection and fallback (ISC-131)", () => {
  test.todo("unavailable primary with --backend-fallback tmux lands on tmux, visibly");
  test.todo("unavailable primary with no fallback exits 3 with a named diagnosis");
  test.todo("unknown --backend exits 2");
  test.todo("unknown --backend-fallback exits 2");
});
