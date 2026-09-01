/**
 * The theme list is only as good as its agreement with the image.
 *
 * `src/config/themes.ts` names 16 themes and a pinned bundle version. Nothing
 * in TypeScript can see inside a Docker image, so the chain that makes those
 * names mean something runs through the Dockerfile:
 *
 *   THEME_NAMES (themes.ts)  ←this file→  Dockerfile  ←`test -f` at build→  image
 *
 * This file is the first arrow. The second is the `for t in …; do test -f …`
 * loop in the Dockerfile, which fails the BUILD if a bundle version renames or
 * drops a file.
 *
 * Without both arrows the names in `themes.ts` are a claim nothing re-reads,
 * and a config naming `dracula` would resolve to Pi's default with no signal
 * anywhere — two panes meant to be tellable apart quietly becoming identical.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_THEMES,
  PI_BUILTIN_THEMES,
  PI_BUNDLED_THEMES,
  PI_THEMES_VERSION,
  THEMES_DIR,
  knownTheme,
} from "../../src/config/themes.ts";

const DOCKERFILE = readFileSync(join(import.meta.dir, "../../docker/Dockerfile"), "utf8");

describe("theme names agree with the image that carries them", () => {
  it("pins the same bundle version in themes.ts and the Dockerfile", () => {
    const m = /ARG PI_THEMES_VERSION=([0-9][^\s\\]*)/.exec(DOCKERFILE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(PI_THEMES_VERSION);
    // The install line must use the ARG rather than a second literal — a
    // hardcoded version there would pass the check above and still install
    // something else.
    expect(DOCKERFILE).toContain("@firstpick/pi-themes-bundle@${PI_THEMES_VERSION}");
  });

  it("asserts every bundled name is present at build time", () => {
    // The Dockerfile's `test -f` loop, parsed back out. Written as filenames
    // there and as theme names here; they agree for all 16, and this is the
    // check that keeps the two spellings from drifting.
    const loop = /for t in ([\s\S]*?); do/.exec(DOCKERFILE);
    expect(loop).not.toBeNull();
    const asserted = loop![1]!
      .split(/[\s\\]+/)
      .map((t) => t.trim())
      .filter((t) => t !== "");
    expect([...asserted].sort()).toEqual([...PI_BUNDLED_THEMES].sort());
  });

  it("copies the bundle to the path the flag names, outside every mount", () => {
    expect(DOCKERFILE).toContain(`cp -R "$(npm root -g)/@firstpick/pi-themes-bundle/themes" ${THEMES_DIR}`);
    // NOT under /home/pi/.pi/agent: `config/render.ts` mounts a named volume
    // there, and a volume masks whatever the image baked at its mountpoint —
    // so themes copied there would be invisible in real runs and visible in
    // every probe that mounts nothing, which is the worst way to be wrong.
    expect(THEMES_DIR.startsWith("/home/pi/")).toBe(false);
  });

  it("removes the npm copy so the themes have exactly one discovery route", () => {
    expect(DOCKERFILE).toContain("npm uninstall -g --ignore-scripts @firstpick/pi-themes-bundle");
  });
});

describe("knownTheme", () => {
  it("accepts Pi's built-ins as well as the bundle", () => {
    for (const name of [...PI_BUILTIN_THEMES, ...PI_BUNDLED_THEMES]) {
      expect(knownTheme(name)).toBe(true);
    }
    expect(KNOWN_THEMES.length).toBe(PI_BUILTIN_THEMES.length + PI_BUNDLED_THEMES.length);
  });

  it("rejects the near-misses an operator actually types", () => {
    // `catppuccin` is the one worth pinning: it is the name a person knows,
    // and the bundle has no theme by it — only -mocha and -latte.
    expect(knownTheme("catppuccin")).toBe(false);
    expect(knownTheme("dracular")).toBe(false);
    expect(knownTheme("")).toBe(false);
  });

  it("has no duplicate names", () => {
    expect(new Set(KNOWN_THEMES).size).toBe(KNOWN_THEMES.length);
  });
});
