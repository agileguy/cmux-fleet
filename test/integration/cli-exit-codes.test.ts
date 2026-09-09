/**
 * Exit-code ladder, exercised through the real CLI process.
 *
 * These spawn `src/cli/index.ts` rather than importing the command functions,
 * because the thing under test is what a caller observes: the integer, and
 * whether the message on stderr is a diagnosis or a stack trace. Importing the
 * function would test neither.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveWorker } from "../../src/config/load.ts";
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

/**
 * The triage pair, through the real command (SRD-TRIAGE-CONSOLE §7.1, §7.8,
 * task 3.5).
 *
 * ## Why these are CLI tests and not more unit tests
 *
 * `test/unit/triage-targets.test.ts` already drives D11's fence hard — fifteen
 * mutations, an asymmetric fixture, the degenerate empty-allowlist shape. None
 * of that made the fence defend anything, because until this wiring existed no
 * module under `src/` imported the loader at all: the only importer was the
 * test. ISC-579 is written against exactly that gap and its probe is a grep for
 * an IMPORT, so the thing that has to be re-checked here is not whether the
 * function narrows — it does — but whether a real `pifleet` invocation, reading
 * real files off a real disk, reaches it. That is only observable from the
 * outside, which is what this file is for.
 *
 * Every rig writes its own `fleet.yaml`, its own kubeconfig and its own
 * `triage/` directory into a temp dir and passes `-c` at it, so none of them
 * reads the repository's own tracked pair — except the last one, which reads it
 * deliberately and says so.
 */
describe("config validate — the triage pair", () => {
  const KUBECONFIG = (contexts: string[]): string =>
    [
      "apiVersion: v1",
      "kind: Config",
      "contexts:",
      ...contexts.map((c) => `  - {name: ${c}, context: {cluster: c1, user: u1}}`),
      "",
    ].join("\n");

  const TARGETS = (env: string, context: string, extra = ""): string =>
    [
      "version: 1",
      "environments:",
      `  ${env}:`,
      `    kube_context: ${context}`,
      ...(extra === "" ? [] : [`    ${extra}`]),
      "    services:",
      "      - {name: mia, namespace: ns, workload: mia, checks: [rollout, logs]}",
      "",
    ].join("\n");

  interface Rig {
    /** `contexts` the fleet's kubeconfig carries; `null` leaves `cloud.kubeconfig` unset. */
    contexts?: string[] | null;
    /** `triage/targets.yaml`'s text; `null` writes no file at all. */
    targets?: string | null;
    /** `triage/console.yaml`'s text; `null` writes no file at all. */
    consoleYaml?: string | null;
  }

  /** A temp fleet whose `triage/` directory is entirely this test's. */
  async function rig(spec: Rig): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-triage-"));
    const kubeconfig = join(dir, "kubeconfig.yaml");
    if (spec.contexts != null) await writeFile(kubeconfig, KUBECONFIG(spec.contexts));
    await mkdir(join(dir, "triage"), { recursive: true });
    if (spec.targets != null) await writeFile(join(dir, "triage", "targets.yaml"), spec.targets);
    if (spec.consoleYaml != null)
      await writeFile(join(dir, "triage", "console.yaml"), spec.consoleYaml);
    await writeFile(
      join(dir, "fleet.yaml"),
      [
        "version: 2",
        "name: triage-fence",
        'docker: { pi_version: "0.79.6" }',
        'run: { repo: "./repo", budget: { tokens_ceiling: 1000000 } }',
        "llm: { model: m }",
        "roles:",
        "  engineer: {}",
        "workers:",
        "  - { id: eng-1, role: engineer }",
        "cloud:",
        spec.contexts == null ? "  kubeconfig: null" : `  kubeconfig: ${kubeconfig}`,
        "",
      ].join("\n"),
    );
    return dir;
  }

  const validate = (dir: string, extra: string[] = []) =>
    runCli(["config", "validate", "-c", join(dir, "fleet.yaml"), ...extra]);

  /**
   * ISC-579's own claim, re-taken against the CLI rather than the function.
   *
   * The kubeconfig and the targets file hold ASYMMETRIC context sets — the
   * kubeconfig carries `cni-dev` and `cni-verify`, the file names `cni-dev` and
   * `cni-prod`, and neither set contains the other. So a check that compared
   * SIZES, or that ran the subset the wrong way round, would see two-and-two and
   * pass; and the environment that must survive is asserted BY NAME, so
   * "exactly one refusal" cannot be reached by refusing the wrong half.
   */
  test("an environment naming a context the kubeconfig lacks exits 2, naming the file", async () => {
    const dir = await rig({
      contexts: ["cni-dev", "cni-verify"],
      targets: [
        "version: 1",
        "environments:",
        "  cni-dev:",
        "    kube_context: cni-dev",
        "    services: [{name: mia, namespace: ns, workload: mia, checks: [rollout]}]",
        "  cni-prod:",
        "    kube_context: cni-prod",
        "    services: [{name: mia, namespace: ns, workload: mia, checks: [rollout]}]",
        "",
      ].join("\n"),
      consoleYaml: "version: 1\n",
    });
    try {
      const r = await validate(dir);
      expect(r.code).toBe(EXIT.USAGE);
      // The FILE, because three files are read in this pass and the operator
      // has to know which editor to open.
      expect(r.stderr).toContain(join(dir, "triage", "targets.yaml"));
      // The FIELD, at the offending environment's own path.
      expect(r.stderr).toContain("environments.cni-prod.kube_context");
      // What the kubeconfig DOES carry, so the fix needs no second command.
      expect(r.stderr).toContain("cni-verify");
      // NARROWING: the reachable environment is not refused. A fence that
      // refused everything would satisfy every assertion above.
      expect(r.stderr).not.toContain("environments.cni-dev.kube_context");
      expect(r.stderr).toContain("1 validation error");
      expect(r.stderr).not.toContain("at async");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * ANTI-VACUITY for the test above, and the half that makes it evidence rather
   * than an assertion about a broken command: the same file, the same command,
   * one context added to the kubeconfig, and it passes — reporting the pair it
   * fenced.
   */
  test("the same file validates once the kubeconfig carries every context", async () => {
    const dir = await rig({
      contexts: ["cni-dev", "cni-prod", "cni-verify"],
      targets: [
        "version: 1",
        "environments:",
        "  cni-dev:",
        "    kube_context: cni-dev",
        "    services: [{name: mia, namespace: ns, workload: mia, checks: [rollout]}]",
        "  cni-prod:",
        "    kube_context: cni-prod",
        "    services: [{name: mia, namespace: ns, workload: mia, checks: [rollout]}]",
        "",
      ].join("\n"),
      consoleYaml: "version: 1\n",
    });
    try {
      const r = await validate(dir, ["--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      const d = JSON.parse(r.stdout);
      expect(d.triage.fenced).toBe(true);
      expect(d.triage.environments).toEqual(["cni-dev", "cni-prod"]);
      expect(d.triage.services).toBe(2);
      // The COMPUTED deadline, from the defaults an empty console.yaml resolves
      // to: 300 - 60. `sweep_deadline_s` is not a field anywhere.
      expect(d.triage.cadence_s).toBe(300);
      expect(d.triage.sweep_deadline_s).toBe(240);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * §7.8's cross-file note and §12's own probe: `default_window: 6h` in one file
   * against `cadence_s: 300` in the other. **Both filenames must appear**, since
   * either could be the one the operator meant to change and "a refusal naming
   * one file when two disagree sends the operator to the wrong editor."
   */
  test("a default_window wider than the cadence exits 2 naming BOTH files", async () => {
    const dir = await rig({
      contexts: ["cni-dev"],
      targets: TARGETS("cni-dev", "cni-dev", "default_window: 6h"),
      consoleYaml: "version: 1\ncadence_s: 300\n",
    });
    try {
      const r = await validate(dir);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain(join(dir, "triage", "targets.yaml"));
      expect(r.stderr).toContain(join(dir, "triage", "console.yaml"));
      expect(r.stderr).toContain("environments.cni-dev.default_window");
      expect(r.stderr).toContain("cadence_s");
      expect(r.stderr).not.toContain("at async");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * The same cross-file bound on the arm where the kube-context fence CANNOT
   * run — and this test exists because its absence let a mutation live.
   *
   * Deleting `windowIssues` from the un-fenced arm changed nothing in the suite:
   * every window fixture had a kubeconfig, so every one of them went down the
   * fenced path where `fenceTriageTargets` applies that check itself. The
   * un-fenced arm's whole claim is that it is a MISSING FENCE and not a skipped
   * file — that a fleet with no `cloud.kubeconfig` still has its targets file
   * checked against the cadence — and until this fixture existed that claim was
   * prose. §12's degenerate-fixture lesson, one layer up: two paths that agree
   * on every fixture are one path being tested twice.
   */
  test("a window wider than the cadence is refused even when nothing can be fenced", async () => {
    const dir = await rig({
      contexts: null,
      targets: TARGETS("cni-dev", "cni-dev", "default_window: 6h"),
      consoleYaml: "version: 1\ncadence_s: 300\n",
    });
    try {
      const r = await validate(dir);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain(join(dir, "triage", "targets.yaml"));
      expect(r.stderr).toContain(join(dir, "triage", "console.yaml"));
      expect(r.stderr).toContain("environments.cni-dev.default_window");
      // Not the fence — that check is the one this arm cannot make, and saying
      // it ran would be worse than not running it.
      expect(r.stderr).not.toContain("kube_context");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * §7.8 property 1, through the CLI: `sweep_deadline_s` is COMPUTED and writing
   * it is a field-level error NAMING THE KEY — not `(root): Unrecognized key`,
   * which would send an operator hunting for a typo they did not make.
   */
  test("sweep_deadline_s in console.yaml exits 2 as a field-level error naming the key", async () => {
    const dir = await rig({
      contexts: ["cni-dev"],
      targets: TARGETS("cni-dev", "cni-dev"),
      consoleYaml: "version: 1\nsweep_deadline_s: 240\n",
    });
    try {
      const r = await validate(dir);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain(join(dir, "triage", "console.yaml"));
      expect(r.stderr).toContain("sweep_deadline_s");
      expect(r.stderr).toContain("cadence_s - reserve_s");
      expect(r.stderr).not.toContain("(root)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * §6.9 requirement 4 and §12's highest-priority credential fixture, reachable
   * from the command an operator actually runs before committing: ntfy's own
   * documented `?auth=<token>` form.
   *
   * The second half is the one that would be easy to lose — **the refusal must
   * not itself print the token**, because this text goes to a terminal and, once
   * the console is running, to a log that appends forever.
   */
  test("notify.endpoint carrying ?auth= exits 2 without echoing the token", async () => {
    const dir = await rig({
      contexts: ["cni-dev"],
      targets: TARGETS("cni-dev", "cni-dev"),
      consoleYaml: [
        "version: 1",
        "notify:",
        "  endpoint: https://ntfy.example.test/Alerts?auth=tk_secret_value",
        "",
      ].join("\n"),
    });
    try {
      const r = await validate(dir);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain(join(dir, "triage", "console.yaml"));
      expect(r.stderr).toContain("notify.endpoint");
      expect(r.stderr).toContain("token_env");
      // The VALUE, and the URL it sat in: the query case quotes no part of the
      // endpoint back, because a bare `?tk_abc…` carries the secret as the
      // parameter NAME, so listing names would not be safe either. The
      // message's reference to ntfy's documented `?auth=<token>` FORM is the
      // diagnosis and is not the operator's string.
      expect(r.stderr).not.toContain("tk_secret_value");
      expect(r.stderr).not.toContain("ntfy.example.test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * The `no-inventory` arm, asserted in BOTH directions so silence is not an
   * option: a fleet with no `triage/targets.yaml` validates and reports no
   * triage pair — **and its `triage/console.yaml` is still parsed**, which is
   * the half that would otherwise rot into a tracked file nothing reads.
   */
  test("a fleet with no targets file validates, and its console.yaml is still checked", async () => {
    const clean = await rig({ contexts: null, targets: null, consoleYaml: "version: 1\n" });
    const broken = await rig({
      contexts: null,
      targets: null,
      consoleYaml: "version: 1\ncadence_s: 3\n",
    });
    try {
      const ok = await validate(clean, ["--json"]);
      expect(ok.code).toBe(EXIT.SUCCESS);
      expect(JSON.parse(ok.stdout).triage).toBeNull();

      const bad = await validate(broken);
      expect(bad.code).toBe(EXIT.USAGE);
      expect(bad.stderr).toContain(join(broken, "triage", "console.yaml"));
      expect(bad.stderr).toContain("cadence_s");
    } finally {
      await rm(clean, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
    }
  }, cliBudget(2));

  /**
   * The REPOSITORY'S OWN tracked pair, read by the real command — the one test
   * here that deliberately does not build a rig.
   *
   * `fleet.example.yaml` sits beside `triage/`, so this is the assertion that
   * the files task 3.6 tracks are the files `config validate` actually reads
   * and that they parse.
   *
   * **It no longer asserts the DEFAULTS, and that is not a weakening.** This
   * test used to read `cadence_s: 300` / `sweep_deadline_s: 240` off the
   * tracked pair on the grounds that `triage/console.yaml` "carrying nothing
   * but `version: 1`" proved §7.8's defaults were reachable. That file stopped
   * being empty on 2026-09-07: a 35B observer was measured being cut off
   * mid-artifact at the 240s deadline, so the operator set `cadence_s: 900` and
   * `reserve_s: 120` with the measurement written beside them. The assertion
   * was then reading one document to make a claim about a different one, and it
   * failed the moment the operator's measurement landed.
   *
   * So the claim was SPLIT rather than dropped. This test asserts what the
   * tracked file says; `defaults are reachable from a version-only console`
   * below asserts the reachability, against a fixture that really does state
   * only its version — which is the document the claim was always about.
   *
   * The example declares `cloud.kubeconfig: null`, so the kube-context fence has
   * no reach to check against and the pass says so in a warning instead of
   * refusing. That split is ISC-392's, not a new one: the same field, the same
   * document, and its recorded reason — "a refusal would reject a document the
   * fleet already runs." The **warning is asserted**, so the un-fenced state can
   * never be silent.
   */
  test("the tracked triage/ pair is what validate reads beside the shipped example", async () => {
    const r = await runCli(["config", "validate", "-c", "fleet.example.yaml", "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const d = JSON.parse(r.stdout);
    expect(d.triage.targets_path).toBe(join(REPO_ROOT, "triage", "targets.yaml"));
    expect(d.triage.console_path).toBe(join(REPO_ROOT, "triage", "console.yaml"));
    expect(d.triage.environments).toEqual(["cni-dev"]);
    expect(d.triage.services).toBe(3);
    // The tracked file's own values, and the derivation between them:
    // `sweep_deadline_s` is `cadence_s - reserve_s` (§7.8 property 1) and is
    // not a field, so 900 - 120 = 780 is the arithmetic being checked here as
    // much as the two numbers are.
    expect(d.triage.cadence_s).toBe(900);
    expect(d.triage.sweep_deadline_s).toBe(780);
    // Not fenced, and never silently so.
    expect(d.triage.fenced).toBe(false);
    expect(r.stderr).toContain("was NOT fenced");
    expect(r.stderr).toContain("REFUSES TO START");
  }, cliBudget(1));

  /**
   * The half of the test above that the tracked file can no longer carry.
   *
   * §7.8's table gives nine knobs documented defaults, and `triage/console.yaml`'s
   * header argues at length that writing any of them into a tracked file makes a
   * second definition that outranks the schema the day the schema changes. The
   * proof that the defaults are REACHABLE therefore has to come from a document
   * that states only its version — and since 2026-09-07 that is no longer the
   * tracked one, which now carries four measured overrides.
   *
   * Written as a fixture rather than by restoring the tracked file, because the
   * operator's 900/120 is a measurement (a 35B observer cut off mid-artifact at
   * 240s) and a test is not a reason to give it back.
   *
   * `sweep_deadline_s` is asserted alongside `cadence_s` because it is DERIVED —
   * `cadence_s - reserve_s`, §7.8 property 1, not a field — so a default that
   * resolved for one and not the other would otherwise pass.
   */
  test("§7.8's defaults are reachable from a console stating only its version", async () => {
    // A targets file is required for `triage` to be a summary at all rather
    // than `null` — the console is the PAIR, and half of it summarises to
    // nothing (the "no console" case the first test in this block asserts).
    const dir = await rig({
      contexts: null,
      targets: TARGETS("cni-dev", "cni-dev"),
      consoleYaml: "version: 1\n",
    });
    try {
      const r = await validate(dir, ["--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      const d = JSON.parse(r.stdout);
      expect(d.triage.cadence_s).toBe(300);
      expect(d.triage.sweep_deadline_s).toBe(240);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(1));

  /**
   * The tracked pair again — this time PASSED THROUGH THE FENCE, by copying both
   * files verbatim beside a fleet whose kubeconfig carries the context they
   * name.
   *
   * The test above proves the tracked files parse. This one proves the tracked
   * `kube_context` is a value the fence can actually admit, which is a different
   * claim and the one that decides whether task 3.6's worked example is a
   * working example or a shape. It is also what makes an edit to that line
   * FAIL: change `cni-dev` in `triage/targets.yaml` to anything else and this
   * test goes red, while every schema-level assertion elsewhere stays green.
   *
   * The kubeconfig is written by the test rather than read from the host, so
   * this asserts nothing about the operator's own filtered copy — which is the
   * one thing on this path that is environment-specific, and the reason the
   * tracked file names the LOGICAL token `cni-dev` rather than a cloud
   * provider's generated context id (§0.3's disclosure boundary; §6.2 property
   * 3).
   */
  test("the tracked triage/targets.yaml passes the fence against a kubeconfig carrying its context", async () => {
    const dir = await rig({ contexts: ["cni-dev", "cni-verify"], targets: null, consoleYaml: null });
    try {
      for (const name of ["targets.yaml", "console.yaml"]) {
        await writeFile(
          join(dir, "triage", name),
          await Bun.file(join(REPO_ROOT, "triage", name)).text(),
        );
      }
      const r = await validate(dir, ["--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      const d = JSON.parse(r.stdout);
      expect(d.triage.fenced).toBe(true);
      expect(d.triage.environments).toEqual(["cni-dev"]);
      expect(d.triage.services).toBe(3);
      // 900 - 120, off the tracked console.yaml copied in above — see the
      // previous test for why this is no longer §7.8's default of 240.
      expect(d.triage.sweep_deadline_s).toBe(780);
      expect(r.stderr).not.toContain("was NOT fenced");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
  /**
   * **[SUPERSEDED 2026-09-09] The differing-models half moved for the SAME
   * reason ISC-63's differing-skills half did, one paragraph up.**
   *
   * This asserted `modelOf(sre) !== modelOf(obs)` against `fleet.example.yaml`.
   * It cannot any more: every role in that file now names
   * `gemma-4-26b-a4b-it-bf16`, because a second local model in the tracked
   * example stands up a second set of weights on a shared oMLX — the collision
   * that starved a live seat (ISC-1116, ISC-1124). A RUNNABLE example and a
   * differing-brains demonstration are no longer the same file.
   *
   * ISC-62 is unaffected and is pinned where ISC-63 already lives:
   * `test/unit/render.test.ts` → `two roles produce different --model values`,
   * which is STRICTLY STRONGER than what stood here — it fixes both exact model
   * strings against its own fixture and asserts the inequality, where this could
   * only assert the inequality. Loosening the example to keep an integration
   * test re-checking a criterion a unit test checks harder would be the same
   * wrong trade the paragraph above refuses.
   *
   * What is left here is the half only an END-TO-END render can show: that
   * `--model` is emitted per worker and carries the RESOLVED value, not the
   * fleet default by accident. That still fails if the renderer stops threading
   * a model through, which is the wiring this file exists to check.
   */
  test("each worker renders --model with its resolved value", async () => {
    const sre = JSON.parse((await render()).stdout);
    const obs = JSON.parse(
      (await runCli(["render", "-c", "fleet.example.yaml", "--worker", "obs-1", "--json"])).stdout,
    );
    const modelOf = (d: { docker: string[] }) => d.docker[d.docker.indexOf("--model") + 1];

    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    // Read back from the config rather than hard-coded, so this tracks the
    // example instead of pinning a second copy of the model string.
    expect(modelOf(sre)).toBe(resolveWorker(loaded, "sre-1").model);
    expect(modelOf(obs)).toBe(resolveWorker(loaded, "obs-1").model);
    // Anti-vacuity: `indexOf` returns -1 for a missing flag and `d.docker[0]`
    // is a real string, so a renderer that dropped --model entirely would
    // otherwise compare two arbitrary argv tokens.
    expect(sre.docker).toContain("--model");
    expect(obs.docker).toContain("--model");
  }, cliBudget(2));
});
