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
import { cliBudget } from "../support/budget.ts";
import { spawnCli } from "../support/spawn-cli.ts";

/**
 * The repo root, and the one place in the suite that deliberately runs the CLI
 * from it.
 *
 * Every other file gets `spawnCli`'s hermetic default cwd, so an ambient
 * `fleet.yaml` cannot reach it (ISC-296). This file cannot: it names
 * `fleet.example.yaml` by RELATIVE path on the argv, so the CLI has to run
 * where that file is. That is safe here precisely because the path is
 * explicit — every case passes `-c`, so config DISCOVERY never runs and the
 * gitignored `fleet.yaml` beside it is never consulted. The cwd is stated
 * rather than inherited, which is the difference that matters.
 */
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(args, { cwd: REPO_ROOT });
}

describe("exit-code ladder", () => {
  test("a valid config exits 0", async () => {
    const r = await runCli(["config", "validate", "-c", "fleet.example.yaml"]);
    expect(r.code).toBe(EXIT.SUCCESS);
  }, cliBudget(1));

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
  }, cliBudget(1));

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
  }, cliBudget(1));

  /**
   * ISC-402, through the CLI, because the criterion's probe is a CLI probe.
   *
   * ## Why a unit test on `resolveWorker` was not enough
   *
   * `config.test.ts` pins the REFUSAL — `resolveWorker` throws for a provider
   * the document does not declare. That is half of it. The other half is that
   * `config validate` ever calls `resolveWorker` at all, and until this change
   * it did not: the command loaded the document and stopped, so every refusal
   * that can only be seen after the worker/role/defaults merge was invisible to
   * it. `validate` printed `ok:` for configs `up` then refused.
   *
   * That is the same plan-versus-script gap `operations-console.test.ts`
   * documents, and it is worse here, because the operator has been told the
   * file is fine. So this drives the real binary and asserts the exit code, and
   * it is what makes the criterion's own probe — "exits non-zero and the
   * message contains both" — something that re-runs.
   */
  test("a worker resolving to an undeclared provider exits 2, naming field and file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-cli-"));
    try {
      const p = join(dir, "undeclared.yaml");
      await writeFile(
        p,
        [
          "version: 2",
          "name: isc-402",
          'docker: { pi_version: "0.79.6" }',
          'run: { repo: "./repo", budget: { tokens_ceiling: 1000000 } }',
          "llm:",
          "  provider: ollama-cloud",
          "  model: m",
          "  providers:",
          "    ollama-cloud:",
          "      hosted: true",
          "      base_url: https://ollama.com/v1",
          "      api_key_env: OLLAMA_API_KEY",
          "roles:",
          '  engineer: { model: "typo-provider/m" }',
          "workers:",
          "  - { id: eng-1, role: engineer }",
          "",
        ].join("\n"),
      );
      const r = await runCli(["config", "validate", "-c", p]);
      expect(r.code).toBe(EXIT.USAGE);
      // The FILE, so `-c` against a path the operator did not type still says
      // which document is wrong.
      expect(r.stderr).toContain(p);
      // The FIELD — and specifically which of the two routes to a provider this
      // was, since `llm.provider` and a `model:` prefix are different lines to
      // go and edit.
      expect(r.stderr).toContain("typo-provider");
      expect(r.stderr).toContain("prefix");
      // What IS declared, so the fix does not need a second command.
      expect(r.stderr).toContain("ollama-cloud");
      // A refusal, not a crash.
      expect(r.stderr).not.toContain("at async");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * ANTI-VACUITY, and it guards a real hazard rather than a hypothetical one.
   *
   * `validate` now runs the merge, so it can newly REFUSE documents it used to
   * pass. If that went too far — a merge-time throw on an ordinary fleet — this
   * test fails and the one above still passes, because a command that refused
   * everything would satisfy every assertion in it.
   */
  test("the shipped example still validates, now that validate runs the merge", async () => {
    const r = await runCli(["config", "validate", "-c", "fleet.example.yaml"]);
    expect(r.code).toBe(EXIT.SUCCESS);
  }, cliBudget(1));

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
  }, cliBudget(1));

  test("an unknown command exits nonzero without a stack trace", async () => {
    const r = await runCli(["no-such-command"]);
    expect(r.code).not.toBe(EXIT.SUCCESS);
    expect(r.stderr).not.toContain("at async");
  }, cliBudget(1));
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
  }, cliBudget(1));

  // ISC-65 — the flag is not repeatable; last would silently win.
  test("passes exactly one --append-system-prompt", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.filter((a: string) => a === "--append-system-prompt")).toHaveLength(1);
  }, cliBudget(1));

  // ISC-66 — Pi has no @ sigil; an @-path is appended as literal text, silently.
  test("emits no @-prefixed argument", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.filter((a: string) => a.startsWith("@"))).toEqual([]);
  }, cliBudget(1));

  // SRD §12.2 — repo content is untrusted, so discovery is denied by default.
  test("denies extension, skill and context-file discovery", async () => {
    const d = JSON.parse((await render()).stdout);
    for (const flag of ["--no-extensions", "--no-skills", "--no-context-files"]) {
      expect(d.docker).toContain(flag);
    }
  }, cliBudget(1));

  // ISC-64 — pifleet-worker is re-injected post-merge and cannot be removed.
  test("always injects the pifleet-worker skill", async () => {
    const d = JSON.parse((await render()).stdout);
    expect(d.docker.join(" ")).toContain("/skills/pifleet-worker");
  }, cliBudget(1));

  // ISC-30
  test("does not mount the host ~/.pi/agent", async () => {
    const d = JSON.parse((await render()).stdout);
    const mounts = d.docker.join(" ");
    expect(mounts).not.toContain(`${process.env.HOME}/.pi/agent`);
  }, cliBudget(1));

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
    const obs = JSON.parse(
      (await runCli(["render", "-c", "fleet.example.yaml", "--worker", "obs-1", "--json"])).stdout,
    );
    const modelOf = (d: { docker: string[] }) => d.docker[d.docker.indexOf("--model") + 1];
    expect(modelOf(sre)).not.toBe(modelOf(obs));
  }, cliBudget(2));
});
