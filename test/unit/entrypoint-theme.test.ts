/**
 * `docker/entrypoint.sh` selects the Pi colour theme by writing `settings.json`.
 *
 * Pi has no theme environment variable. The ONLY non-interactive way to select
 * one is the `theme` key in Pi's own `settings.json`, so the entrypoint writes
 * it — and `settings.json` is not ours. It is Pi's live state file: the model,
 * the thinking level, the last changelog seen, everything `/settings` touches,
 * on a per-worker named volume that outlives the run.
 *
 * That ownership is the whole reason this file exists. The `models.json` block
 * a few lines above in the same script is a `jq -n` that writes a file whole,
 * which is right there because that file is entirely ours, and WRONG here: the
 * same shape applied to `settings.json` would discard Pi's state on every
 * container start, and it would do it invisibly — the container comes up, the
 * theme is correct, and the model quietly reverted.
 *
 * These run the real script under the host's bash with HOME redirected, the
 * same harness `entrypoint-pane-mode.test.ts` uses and for the same reason:
 * the property is a property of the script's control flow, not of Docker.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRYPOINT = join(REPO_ROOT, "docker", "entrypoint.sh");

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Run the entrypoint with a stand-in worker, and return what landed in
 * `settings.json`.
 *
 * `existingSettings` is written BEFORE the script runs, standing in for the
 * named volume's contents from a previous run — which is the state the merge
 * exists to preserve and the state a `jq -n` would destroy.
 */
async function runWithTheme(
  theme: string | undefined,
  existingSettings: string | null,
): Promise<{ code: number; settings: string | null; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-theme-"));
  dirs.push(dir);
  const agentDir = join(dir, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  if (existingSettings !== null) await writeFile(settingsPath, existingSettings);

  // Exits immediately: this file is about what the script wrote before the
  // launch, so the worker only has to not hang.
  const standIn = join(dir, "stand-in.sh");
  await writeFile(standIn, "#!/bin/sh\nexit 0\n");
  await chmod(standIn, 0o755);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    PIFLEET_WORKER_BIN: standIn,
  };
  if (theme !== undefined) env["PIFLEET_PI_THEME"] = theme;

  const p = Bun.spawn(["bash", ENTRYPOINT], {
    env,
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  const settings = await readFile(settingsPath, "utf8").catch(() => null);
  return { code, settings, stderr };
}

describe("PIFLEET_PI_THEME selects the Pi theme through settings.json", () => {
  test("a named theme is written into a settings.json that did not exist", async () => {
    const r = await runWithTheme("dracula", null);
    expect(r.settings).not.toBeNull();
    expect(JSON.parse(r.settings!)["theme"]).toBe("dracula");
  });

  /**
   * The assertion this file was written for.
   *
   * A fixture with TWO unrelated keys, checked individually rather than by
   * counting: a merge that dropped everything and a merge that kept one key
   * both fail here, and a length check could not tell either from success.
   */
  test("Pi's own settings survive the write", async () => {
    const before = JSON.stringify({
      defaultModel: "some-model",
      defaultThinkingLevel: "high",
      theme: "nord",
    });
    const r = await runWithTheme("dracula", before);
    const after = JSON.parse(r.settings!);
    expect(after["theme"]).toBe("dracula");
    expect(after["defaultModel"]).toBe("some-model");
    expect(after["defaultThinkingLevel"]).toBe("high");
  });

  /**
   * EMPTY means "config has no opinion", and it must not be a write.
   *
   * This is the difference between a theme an operator chose inside the pane
   * with `/settings` sticking across restarts and being silently reset every
   * time the container comes up. `run/worker-env.ts` sends "" rather than
   * omitting the key, so this is the case that actually ships for every worker
   * whose config names no theme — which is most of them.
   */
  test("an empty theme leaves an existing selection untouched", async () => {
    const before = JSON.stringify({ theme: "gruvbox-dark", defaultModel: "m" });
    const r = await runWithTheme("", before);
    const after = JSON.parse(r.settings!);
    expect(after["theme"]).toBe("gruvbox-dark");
    expect(after["defaultModel"]).toBe("m");
  });

  /**
   * `quietStartup` is SEEDED, not enforced, and the two halves below are the
   * whole contract.
   *
   * It exists because of what loading themes does to a pane: Pi prints an
   * inventory of loaded resources at startup and skips it when there is
   * nothing to inventory, so putting 16 themes on the discovery path turned a
   * three-line header into an eleven-line one — in the two standing panes whose
   * whole complaint was startup text.
   */
  test("a fresh volume is seeded quiet, so themes do not become preamble", async () => {
    const r = await runWithTheme("dracula", null);
    const after = JSON.parse(r.settings!);
    expect(after["quietStartup"]).toBe(true);
    expect(after["theme"]).toBe("dracula");
  });

  test("an operator who turned the listing back on keeps it", async () => {
    // The other half of "seeded, not enforced". A settings.json that already
    // exists is one Pi and the operator have been writing to, and re-seeding it
    // every start would make the toggle in /settings impossible to keep.
    const before = JSON.stringify({ quietStartup: false, defaultModel: "m" });
    const r = await runWithTheme("dracula", before);
    const after = JSON.parse(r.settings!);
    expect(after["quietStartup"]).toBe(false);
    expect(after["theme"]).toBe("dracula");
  });

  test("an absent variable still seeds a fresh volume quiet", async () => {
    // The seed is NOT gated on a theme: a worker whose config names no theme
    // gets the same startup treatment, because the listing is noise in every
    // pane, not only tinted ones.
    const r = await runWithTheme(undefined, null);
    expect(r.settings).not.toBeNull();
    const after = JSON.parse(r.settings!);
    expect(after["quietStartup"]).toBe(true);
    // ...but no theme key is invented for it.
    expect(Object.hasOwn(after, "theme")).toBe(false);
  });

  /**
   * A malformed settings.json must not stop the container.
   *
   * The script runs under `set -e`, so an unguarded `jq` parse failure would
   * end the worker before it started — a container that does not boot because
   * a colour scheme could not be applied. A half-written file is exactly what a
   * killed container leaves on the named volume, so this is a state the fleet
   * can actually reach.
   */
  test("a corrupt settings.json is replaced rather than made fatal", async () => {
    const r = await runWithTheme("dracula", "{not json at all");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.settings!)["theme"]).toBe("dracula");
  });
});
