/**
 * `attachViewer` validates the surface id BEFORE it becomes a path.
 *
 * The guard existed and ran too late. Its only caller was `respawnPaneArgv`,
 * on the last line of `attachViewer`, while the surface id was interpolated
 * into a filename and written with mode 0700 several lines earlier.
 * `splitPaneId` requires only two non-empty space-separated parts, so `/` and
 * `.` both survive it, and an id like `x/../../victim/target` escapes
 * `viewerScriptDir` into a sibling directory — an arbitrary-file overwrite
 * whose content is a `#!/bin/sh` script. The `viewer-` prefix absorbs a plain
 * leading `../`, which is exactly why a naive traversal fails and the real
 * one is easy to miss.
 *
 * The id comes from cmux's own JSON, so it takes a hostile or broken cmux to
 * reach — and it stayed latent until `up` started calling `attachViewer` for
 * every pane. Ordering bugs of this shape are invisible right up until
 * something wires the caller in.
 *
 * These assert on the FILESYSTEM, not on the exception: a refusal that still
 * wrote the file first would satisfy a `toThrow` and miss the entire point.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxBackend } from "../../src/backends/cmux/index.ts";

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

async function rig(): Promise<{ dir: string; viewers: string; backend: CmuxBackend }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-viewerpath-"));
  bases.push(dir);
  const viewers = join(dir, "nested", "viewers");
  return { dir, viewers, backend: new CmuxBackend({ viewerScriptDir: viewers }) };
}

/** Every path under `dir`, so an escape anywhere is visible. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      out.push(rel);
      if (e.isDirectory()) await walk(join(d, e.name), rel);
    }
  };
  await walk(dir, "");
  return out.sort();
}

describe("a hostile surface id never reaches the filesystem", () => {
  test.each([
    ["p1 x/../../victim/target", "escapes past the viewer- prefix"],
    ["p1 ../../etc/pwn", "plain traversal"],
    ["p1 a/b", "a separator at all"],
    ["p1 .", "current directory"],
    ["p1 ..", "parent directory"],
  ])("refuses %j (%s) and writes nothing", async (paneId) => {
    const { dir, backend } = await rig();
    const before = await tree(dir);
    await expect(backend.attachViewer({ backend: "cmux", id: paneId }, ["tail", "-F", "/tmp/x"])).rejects.toThrow(
      /refusing/,
    );
    // The real assertion: no directory created, no script written, nothing
    // outside the viewer directory touched.
    expect(await tree(dir)).toEqual(before);
  });

  /**
   * The positive control. Without it, a guard that refused EVERY id would
   * pass every test above while breaking the feature outright — the same
   * shape as a fixture that cancels its own defect.
   */
  test("a legitimate surface id is still accepted and writes exactly one script", async () => {
    const { dir, viewers, backend } = await rig();
    // The cmux call afterwards fails here (no reachable socket); the write
    // happens first, which is the step under test.
    await backend
      .attachViewer({ backend: "cmux", id: "pane-1 surface-abc123" }, ["tail", "-F", "/tmp/x"])
      .catch(() => {});
    const entries = await readdir(viewers);
    expect(entries).toEqual(["viewer-surface-abc123.sh"]);
    // 0700: the script is executed by the pane and must not be world-readable.
    const st = await stat(join(viewers, entries[0]!));
    expect(st.mode & 0o777).toBe(0o700);
    expect(await tree(dir)).toContain("nested/viewers/viewer-surface-abc123.sh");
  });
});
