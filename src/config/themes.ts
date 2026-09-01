/**
 * Pi TUI colour themes — what a worker may name, and where the files live.
 *
 * ## Why this module exists at all
 *
 * Pi 0.79.6 ships exactly TWO themes, `dark` and `light`
 * (`dist/modes/interactive/theme/{dark,light}.json` in the npm package).
 * Everything else is a JSON file defining all 51 colour tokens.
 *
 * That two-theme floor is the whole problem. The operations console puts two
 * attended Pi panes side by side, and `light` is not a usable second choice
 * for one of them: a Pi theme has NO page-background token — `text` resolves to
 * the terminal's own foreground — so the light theme paints dark ink on
 * whatever background the terminal already has. In a dark pane that is not a
 * different look, it is an unreadable one. Two visually distinct panes
 * therefore need themes Pi does not ship, which is why the image carries a
 * bundle.
 *
 * ## Why a bundle rather than themes written here
 *
 * `@firstpick/pi-themes-bundle` is 16 themes at 51 tokens each. Hand-writing
 * even two of those is 102 colour decisions that no test can check for taste,
 * and the well-known palettes (Catppuccin, Dracula, Nord, Gruvbox…) are ones
 * an operator can already recognise by name.
 *
 * The version is PINNED, and pinned HERE and in the Dockerfile both, because
 * this is third-party code entering every worker container. What the pin buys
 * is stated narrowly: the registry serves one immutable tarball per version,
 * so a pinned version cannot change under the build. It does not make the
 * package trustworthy — that was a separate reading of the published tarball,
 * summarised in the Dockerfile above the install.
 *
 * ## The three-way agreement this module is the middle of
 *
 *   THEME_NAMES (here)  ←test→  the Dockerfile's own list  ←build→  the image
 *
 * `test/unit/themes.test.ts` asserts the first arrow: the names below and the
 * names the Dockerfile asserts are present must be the same set. The Dockerfile
 * asserts the second by `test -f`-ing every one of them at build time, so an
 * image whose bundle moved, shrank or renamed a file FAILS TO BUILD rather than
 * producing a worker whose configured theme silently falls back.
 *
 * Without that second arrow the list here would be a claim about a package
 * nothing re-reads — which is exactly the shape of check that reports green
 * while the thing it describes has drifted.
 */

/**
 * The pinned bundle version. MUST match the Dockerfile's `PI_THEMES_VERSION`.
 *
 * `test/unit/themes.test.ts` reads the Dockerfile and compares, because a
 * version bumped in one place only is a stale-image bug that surfaces as a
 * theme name that resolves on one machine and not another.
 */
export const PI_THEMES_VERSION = "0.1.6";

/**
 * Where the bundle's `*.json` live INSIDE the worker container.
 *
 * Deliberately NOT under `/home/pi/.pi/agent`, which is Pi's own custom-theme
 * directory and would be the obvious place. That path is a per-worker named
 * volume (`config/render.ts` mounts `pifleet-piagent-<id>` there), and a volume
 * MASKS whatever the image baked at its mountpoint — so themes copied there at
 * build time would be invisible at run time, and invisible only in real runs,
 * never in an `image verify` that mounts no volume. `/opt/pifleet/themes` is
 * outside every mount this fleet makes.
 */
export const THEMES_DIR = "/opt/pifleet/themes";

/**
 * Pi's own built-in themes. Always selectable, never in `THEMES_DIR`.
 *
 * Listed so `knownTheme` can accept them: an operator asking for plain `dark`
 * is asking for something real, and refusing it because it is not in the
 * bundle would be a warning about the one theme that cannot possibly be
 * missing.
 */
export const PI_BUILTIN_THEMES = ["dark", "light"] as const;

/**
 * Every theme name the bundle provides, sorted.
 *
 * These are the `name` fields inside the files, which is what Pi's settings key
 * selects on — not the filenames. They happen to agree for all 16, and the
 * Dockerfile's `test -f` list is written in terms of filenames for that reason;
 * `test/unit/themes.test.ts` is what holds the two spellings together.
 */
export const PI_BUNDLED_THEMES = [
  "catppuccin-latte",
  "catppuccin-mocha",
  "crimson-noir",
  "dracula",
  "everforest-dark",
  "gruvbox-dark",
  "gruvbox-light",
  "matrix",
  "nord",
  "one-dark",
  "rose-pine",
  "rose-pine-dawn",
  "solarized-dark",
  "solarized-light",
  "tokyo-night",
  "tokyo-night-storm",
] as const;

/** Every name a worker's `theme:` may carry without a warning. */
export const KNOWN_THEMES: readonly string[] = [...PI_BUILTIN_THEMES, ...PI_BUNDLED_THEMES];

/** Is this a theme the image can actually resolve? */
export function knownTheme(name: string): boolean {
  return KNOWN_THEMES.includes(name);
}
