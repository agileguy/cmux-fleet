/**
 * Every stage that installs bun also runs bun's postinstall, so `bun` on PATH is
 * a runner and not a stub.
 *
 * WHAT WAS BROKEN. `docker/Dockerfile` installed bun as
 * `npm install -g --ignore-scripts bun@1.3.12` in both `toolchain-node` and
 * `toolchain-full`. The `bun` npm package is a ~450-byte shim; its postinstall
 * is the step that fetches the ~100MB platform binary that `bin/bun.exe` points
 * at. With scripts ignored the install still SUCCEEDS, the image still builds,
 * `which bun` still answers `/usr/local/bin/bun`, and the failure only surfaces
 * at the moment someone runs it:
 *
 *     $ bun --version
 *     Error: Bun's postinstall script was not run.
 *
 * Measured in `pifleet/pi-worker:0.79.6-node-76ea433ce619`, the image the
 * tester role was running. A tester dispatched to run this repo's own Bun suite
 * had no runner at all; it spent its turn hunting for one and then reported
 * `bun test → exit 0, 27 pass` in its result envelope. Harvest rejected that
 * (ISC-93, empty diff behind a success claim), which is the only reason the
 * fabrication did not become the answer.
 *
 * THE FAIL-OPEN THIS CLOSES. `--ignore-scripts` is the right default for this
 * image and appears on every `npm install` in it, so the obvious repair — drop
 * the flag for bun — trades a real supply-chain property for a working binary.
 * The Dockerfile instead names the one script it wants,
 * `node "$(npm root -g)/bun/install.js"`, which is bun's own postinstall and
 * nothing else. That is a pairing a future edit can silently break: bumping the
 * pin, or copying the `npm install` line into a new toolchain stage, reproduces
 * a stage whose bun does not run, with a green build either way. This test is
 * what notices.
 *
 * It parses the Dockerfile off disk — no daemon, no image build — so it runs in
 * the fast `test` job rather than behind the `PIFLEET_DOCKER=1` image gate.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dockerfilePath } from "../../src/container/image.ts";

/**
 * `docker/Dockerfile` as one entry per instruction, with `\`-continuations
 * folded in. Comment lines are dropped first: a `#` inside a folded instruction
 * would otherwise comment out the rest of it here while meaning nothing to
 * Docker, and this file's own explanatory comment sits directly above the RUN
 * it describes.
 */
export function instructions(dockerfile: string): string[] {
  const lines = dockerfile
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"));
  const out: string[] = [];
  let pending = "";
  for (const line of lines) {
    const continued = line.trimEnd().endsWith("\\");
    pending += continued ? `${line.trimEnd().slice(0, -1)} ` : line;
    if (continued) continue;
    if (pending.trim() !== "") out.push(pending.trim());
    pending = "";
  }
  if (pending.trim() !== "") out.push(pending.trim());
  return out;
}

/** Instructions that put the bun npm package into an image. */
export function bunInstalls(dockerfile: string): string[] {
  return instructions(dockerfile).filter(
    (i) => i.startsWith("RUN ") && /\bbun@/.test(i),
  );
}

/** Those that never run bun's postinstall, and so leave a stub on PATH. */
export function stubbedBunInstalls(dockerfile: string): string[] {
  return bunInstalls(dockerfile).filter((i) => !i.includes("bun/install.js"));
}

const DOCKERFILE = readFileSync(dockerfilePath(), "utf8");

describe("bun on PATH is a runner, not a stub", () => {
  test("the Dockerfile installs bun exactly once", () => {
    /*
     * This guard used to require TWO installs, because `toolchain-node` and
     * `toolchain-full` each carried their own copy. That duplication is gone:
     * every language toolchain now builds on `toolchain-node`, so bun is
     * installed once and inherited, and `dockerfile-toolchain-graph.test.ts`
     * is what checks the inheritance.
     *
     * The count still matters, for the reason it always did — at zero the
     * sweep below is vacuous, passing on a Dockerfile that had stopped
     * installing bun at all. It is now pinned from BOTH sides: a second copy
     * reappearing is the drift that made the bun-postinstall fix have to be
     * written twice, and this is where that would be noticed.
     */
    expect(bunInstalls(DOCKERFILE).length).toBe(1);
  });

  test("every bun install runs bun's postinstall", () => {
    expect(stubbedBunInstalls(DOCKERFILE)).toEqual([]);
  });

  test("bun's own script is named, not `--ignore-scripts` dropped wholesale", () => {
    for (const i of bunInstalls(DOCKERFILE)) {
      expect(i).toContain("--ignore-scripts");
    }
  });

  test("the sweep reports a stage that installs bun without its postinstall", () => {
    // The empty array above is one a reader can demonstrably fill.
    const broken = [
      "FROM base AS toolchain-node",
      "RUN npm install -g --ignore-scripts bun@1.3.12",
    ].join("\n");
    expect(stubbedBunInstalls(broken)).toEqual([
      "RUN npm install -g --ignore-scripts bun@1.3.12",
    ]);
  });

  test("a folded multi-line install counts as one instruction, and passes", () => {
    const fixed = [
      "FROM base AS toolchain-full",
      "RUN npm install -g --ignore-scripts bun@1.3.12 \\",
      ' && node "$(npm root -g)/bun/install.js" \\',
      " && apt-get update",
    ].join("\n");
    expect(bunInstalls(fixed)).toHaveLength(1);
    expect(stubbedBunInstalls(fixed)).toEqual([]);
  });
});
