/**
 * Exit-code ladder, exercised through the real CLI process.
 *
 * These spawn `src/cli/index.ts` rather than importing the command functions,
 * because the thing under test is what a caller observes: the integer, and
 * whether the message on stderr is a diagnosis or a stack trace. Importing the
 * function would test neither.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

describe("exit-code ladder", () => {
  test("a valid config exits 0", async () => {
    const r = await runCli(["config", "validate", "-c", "fleet.example.yaml"]);
    expect(r.code).toBe(EXIT.SUCCESS);
  });

  // ISC-58
  test("a malformed config exits 2 with field-level errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-cli-"));
    try {
      const p = join(dir, "bad.yaml");
      await writeFile(p, "version: 2\nworkers:\n  - {id: eng-1, role: nonexistent}\n");
      const r = await runCli(["config", "validate", "-c", p]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("validation error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISC-59
  test("a role combining bash with read_only exits 2 and names the role", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-cli-"));
    try {
      const base = await Bun.file("fleet.example.yaml").text();
      const p = join(dir, "ro.yaml");
      await writeFile(
        p,
        base.replace("  reviewer:\n", "  badrole:\n    tools: [read, bash]\n    read_only: true\n  reviewer:\n"),
      );
      const r = await runCli(["config", "validate", "-c", p]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("badrole");
      expect(r.stderr).toContain("bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Regression. A missing config threw a `ConfigError`, which the entry point's
   * catch did not recognise — so a one-character typo in a path produced a
   * TypeScript stack trace and exit 1 instead of one line and exit 2. Asserting
   * the absence of the stack trace is the half that would have caught it; the
   * exit code alone could be fixed while still dumping the trace.
   */
  test("a missing config exits 2 with a message, not a stack trace", async () => {
    const r = await runCli(["config", "validate", "-c", "/nonexistent/fleet.yaml"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("config not found");
    expect(r.stderr).not.toContain("at async");
    expect(r.stderr).not.toContain(".ts:");
  });

  test("an unknown command exits nonzero without a stack trace", async () => {
    const r = await runCli(["no-such-command"]);
    expect(r.code).not.toBe(EXIT.SUCCESS);
    expect(r.stderr).not.toContain("at async");
  });
});

describe("render", () => {
  const render = () => runCli(["render", "-c", "fleet.example.yaml", "--worker", "sre-1", "--json"]);

  // ISC-60 — rendering spawns nothing, so it works with no daemon at all.
  test("emits argv without spawning anything", async () => {
    const r = await render();
    expect(r.code).toBe(EXIT.SUCCESS);
    const d = JSON.parse(r.stdout);
    expect(d.worker).toBe("sre-1");
    expect(Array.isArray(d.docker)).toBe(true);
  });

  // ISC-65 — the flag is not repeatable; last would silently win.
  test("passes exactly one --append-system-prompt", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.filter((a: string) => a === "--append-system-prompt")).toHaveLength(1);
  });

  // ISC-66 — Pi has no @ sigil; an @-path is appended as literal text, silently.
  test("emits no @-prefixed argument", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.filter((a: string) => a.startsWith("@"))).toEqual([]);
  });

  // SRD §12.2 — repo content is untrusted, so discovery is denied by default.
  test("denies extension, skill and context-file discovery", async () => {
    const d = JSON.parse((await render()).stdout);
    for (const flag of ["--no-extensions", "--no-skills", "--no-context-files"]) {
      expect(d.docker).toContain(flag);
    }
  });

  // ISC-64 — pifleet-worker is re-injected post-merge and cannot be removed.
  test("always injects the pifleet-worker skill", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.join(" ")).toContain("/skills/pifleet-worker");
  });

  // ISC-30
  test("does not mount the host ~/.pi/agent", async () => {
    const d = JSON.parse((await render()).stdout);
    const mounts = d.docker.join(" ");
    expect(mounts).not.toContain(`${process.env.HOME}/.pi/agent`);
  });

  /**
   * ISC-62 — two roles differ in brain.
   *
   * This used to assert differing `--skill` SETS here too (ISC-63), against
   * `fleet.example.yaml`. It cannot any more, and the reason is worth stating:
   * `up` now COPIES each configured skill by name out of `<repo>/skills/<name>/`
   * and refuses a name with no bundle there, so the example config may only
   * list bundles that exist. Exactly one does — `pifleet-worker` — and it is
   * re-injected post-merge and cannot be removed (ISC-64), so no two roles in a
   * RUNNABLE example can differ in skills until a second bundle is authored.
   *
   * ISC-63 is unaffected and is pinned where it belongs: `test/unit/
   * render.test.ts` asserts the exact sets against its own fixture, where a
   * name nothing copies costs nothing. Shipping an example that `up` refuses,
   * purely so an integration test could keep re-checking a criterion a unit
   * test already checks harder, would be the wrong trade.
   */
  test("different roles render different models", async () => {
    const sre = JSON.parse((await render()).stdout);
    const rev = JSON.parse(
      (await runCli(["render", "-c", "fleet.example.yaml", "--worker", "rev-1", "--json"])).stdout,
    );
    const modelOf = (d: { docker: string[] }) => d.docker[d.docker.indexOf("--model") + 1];
    expect(modelOf(sre)).not.toBe(modelOf(rev));
  });
});
