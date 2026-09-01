/**
 * Config loader + merge semantics (ISC-58, ISC-59, ISC-61, ISC-64, ISC-67,
 * ISC-68 and the three §6.1 merge exceptions).
 *
 * Everything here runs with no Docker daemon and no network: fixtures are
 * temp-dir YAML files, and the one CLI-level test spawns `bun` only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  ConfigError,
  ConfigValidationError,
  ModelNotAllowedError,
  assertModelAllowed,
  decomposeModel,
  loadConfig,
  resolveAllWorkers,
  resolveWorker,
  type LoadedConfig,
} from "../../src/config/load.ts";
import { resolveHarnessPatterns } from "../../src/harvest/patterns.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import { DEFAULT_HARNESS_PATTERNS } from "../../src/harvest/acceptance.ts";
import { assertModelsAllowed } from "../../src/cli/commands/up.ts";
import {
  BackendSchema,
  kubeconfigScopeWarning,
  observerTuiEpochWarning,
  observerTuiWorkers,
  unknownThemeWarning,
  unknownThemeWorkers,
  parseDuration,
  workersMissingKubeconfig,
} from "../../src/config/schema.ts";
import { omlxRelayTarget } from "../../src/security/relay.ts";
import { EXIT } from "../../src/contracts.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-config-"));
  cleanups.push(dir);
  return dir;
}

/** Smallest valid document; tests override pieces of it. */
function baseDoc(): Record<string, unknown> {
  return {
    version: 2,
    name: "test-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel" },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
  };
}

async function writeAndLoad(doc: unknown, dir?: string) {
  const d = dir ?? (await tempDir());
  const path = join(d, "fleet.yaml");
  await writeFile(path, stringify(doc));
  return loadConfig(path);
}

async function expectIssue(doc: unknown, path: string, messageFragment?: string) {
  try {
    await writeAndLoad(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigValidationError);
    const issues = (err as ConfigValidationError).issues;
    const hit = issues.find((i) => i.path === path);
    expect(hit, `no issue at "${path}" — got: ${issues.map((i) => i.path).join(", ")}`).toBeDefined();
    if (messageFragment !== undefined) expect(hit!.message).toContain(messageFragment);
    return;
  }
  throw new Error(`expected validation failure at "${path}" but config loaded`);
}

// ---------------------------------------------------------------------------

describe("worked example", () => {
  // ISC-67: all seven shipped roles load from the shipped default config.
  // observer replaces investigator (SRD-OBSERVER-001 D2) — ISC-391.
  test("fleet.example.yaml loads with all seven shipped roles", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(Object.keys(loaded.config.roles).sort()).toEqual(
      ["engineer", "observer", "reviewer", "sre", "tester", "ticketing", "verifier"].sort(),
    );
    expect(loaded.config.workers).toHaveLength(8);
    // Every worker resolves without error.
    const resolved = resolveAllWorkers(loaded);
    expect(resolved.map((w) => w.id)).toEqual([
      "sre-1",
      "sre-2",
      "obs-1",
      "obs-2",
      "ver-1",
      "eng-1",
      "rev-1",
      "tick-1",
    ]);
  });

  test("the ticketing role gets no Google identity and no worktree (ISC-326)", async () => {
    // The two properties that make this role's blast radius what the ISA says
    // it is. Asserted on the RESOLVED worker rather than the role block,
    // because `defaults <- roles <- worker` is where either could be undone.
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const tick = resolveAllWorkers(loaded).find((w) => w.id === "tick-1");
    expect(tick).toBeDefined();
    expect(tick!.cloudAccess).toBe(false);
    expect(tick!.isolation).toBe("none");
    expect(tick!.toolchain).toBe("base");
    expect(tick!.skills).toContain("ticket-ops");
    // It needs a shell for curl and a writer for the outbox artifact.
    expect(tick!.tools).toContain("bash");
    expect(tick!.tools).toContain("write");
  });

  test("the fleet-wide egress rule names an example host, never a real one (ISC-327)", async () => {
    // This file is committed to a PUBLIC repository. A real internal hostname
    // here is an infrastructure disclosure that editing it later does not take
    // back, so the shipped value is pinned to a reserved documentation domain.
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    for (const rule of loaded.config.egress.allow) {
      expect(rule.host).toMatch(/(^|\.)example\.(com|net|org)$|(^|\.)(test|invalid|localhost)$/);
    }
  });

  test("durations in the example are parsed to seconds", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(loaded.config.run.budget.per_task_timeout).toBe(25 * 60);
    expect(loaded.config.run.budget.run_timeout).toBe(2 * 3600);
    expect(loaded.config.run.timers.event_stall_warn).toBe(3 * 60);
    expect(loaded.config.cloud.token_refresh).toBe(45 * 60);
  });
});

describe("durations", () => {
  const cases: [string, number][] = [
    ["5s", 5],
    ["25m", 1500],
    ["2h", 7200],
    ["500ms", 0.5],
    ["1d", 86400],
    ["1.5h", 5400],
  ];
  for (const [raw, seconds] of cases) {
    test(`"${raw}" → ${seconds}s`, () => {
      expect(parseDuration(raw)).toBe(seconds);
    });
  }

  for (const bad of ["5 minutes", "m5", "5", "5x", ""]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseDuration(bad)).toThrow();
    });
  }

  test("a malformed duration is a field-level error", async () => {
    const doc = baseDoc();
    (doc["run"] as Record<string, unknown>)["budget"] = {
      tokens_ceiling: 1000,
      per_task_timeout: "25 minutes",
    };
    await expectIssue(doc, "run.budget.per_task_timeout");
  });
});

describe("resolution order", () => {
  test("./fleet.yaml is found from the cwd when no --config is given", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "fleet.yaml"), stringify(baseDoc()));
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.path).toBe(join(dir, "fleet.yaml"));
  });

  test("an explicit --config beats ./fleet.yaml", async () => {
    const dir = await tempDir();
    const other = await tempDir();
    await writeFile(join(dir, "fleet.yaml"), stringify(baseDoc()));
    const explicit = join(other, "explicit.yaml");
    await writeFile(explicit, stringify(baseDoc()));
    const loaded = await loadConfig(explicit, dir);
    expect(loaded.path).toBe(explicit);
  });

  test("an explicit --config that does not exist is an error, not a fallthrough", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "fleet.yaml"), stringify(baseDoc()));
    await expect(loadConfig(join(dir, "nope.yaml"), dir)).rejects.toThrow(ConfigError);
  });
});

describe("merge: defaults ← role ← worker, shallow", () => {
  test("the most specific level wins per key", async () => {
    const doc = baseDoc();
    doc["defaults"] = { thinking: "low", toolchain: "base", cloud_access: false };
    doc["roles"] = { eng: { thinking: "medium", toolchain: "node" } };
    doc["workers"] = [
      { id: "w1", role: "eng", thinking: "high" },
      { id: "w2", role: "eng" },
    ];
    const loaded = await writeAndLoad(doc);
    const w1 = resolveWorker(loaded, "w1");
    const w2 = resolveWorker(loaded, "w2");
    expect(w1.thinking).toBe("high"); // worker wins
    expect(w2.thinking).toBe("medium"); // role wins
    expect(w1.toolchain).toBe("node"); // role wins where worker is silent
    expect(w1.cloudAccess).toBe(false); // defaults reach through
  });

  // §6.1 exception 1 (first half): arrays REPLACE, they do not concatenate.
  test("arrays replace across levels", async () => {
    const doc = baseDoc();
    doc["defaults"] = { tools: ["read"] };
    doc["roles"] = { eng: { tools: ["read", "grep"] } };
    doc["workers"] = [
      { id: "w1", role: "eng", tools: ["ls"] },
      { id: "w2", role: "eng" },
    ];
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").tools).toEqual(["ls"]);
    expect(resolveWorker(loaded, "w2").tools).toEqual(["read", "grep"]);
  });

  // §6.1 exception 1 (second half) / ISC-64: pifleet-worker cannot be merged away.
  test("a role that overrides skills still receives pifleet-worker", async () => {
    const doc = baseDoc();
    doc["defaults"] = { skills: ["pifleet-worker", "sre"] };
    doc["roles"] = { eng: { skills: ["tdd"] } };
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").skills).toEqual(["pifleet-worker", "tdd"]);
  });

  test("skills: [] still yields the contract skill", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { skills: [] } };
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").skills).toEqual(["pifleet-worker"]);
  });

  test("pifleet-worker is not duplicated when already listed", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { skills: ["tdd", "pifleet-worker"] } };
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").skills).toEqual(["tdd", "pifleet-worker"]);
  });
});

describe("merge: model decomposition (§6.1 exception 2)", () => {
  test("a :thinking suffix outranks a thinking: key on the same level", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { model: "SomeModel:high", thinking: "low" } };
    const loaded = await writeAndLoad(doc);
    const w = resolveWorker(loaded, "w1");
    expect(w.model).toBe("SomeModel");
    expect(w.thinking).toBe("high");
  });

  test("the suffix outranks a thinking: key at ANY level, including a more specific one", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { model: "SomeModel:high" } };
    doc["workers"] = [{ id: "w1", role: "eng", thinking: "low" }];
    const loaded = await writeAndLoad(doc);
    // The worker set thinking: low, but the merged MODEL string still carries
    // :high — and the suffix wins wherever the key was written.
    expect(resolveWorker(loaded, "w1").thinking).toBe("high");
  });

  test("a provider/ prefix decomposes into --provider", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { model: "vertex/Gemma-3:low" } };
    const loaded = await writeAndLoad(doc);
    const w = resolveWorker(loaded, "w1");
    expect(w.provider).toBe("vertex");
    expect(w.model).toBe("Gemma-3");
    expect(w.thinking).toBe("low");
  });

  test("no prefix falls back to llm.provider", async () => {
    const loaded = await writeAndLoad(baseDoc());
    expect(resolveWorker(loaded, "w1").provider).toBe("omlx");
  });

  test("a suffix that is not a thinking level stays in the model id", () => {
    // A typo must surface as "unknown model" at the server, not vanish.
    const spec = decomposeModel("Qwen3.5-35B-A3B-8bit", "omlx", undefined);
    expect(spec.model).toBe("Qwen3.5-35B-A3B-8bit");
    expect(spec.thinking).toBeUndefined();
    const typo = decomposeModel("SomeModel:hot", "omlx", "low");
    expect(typo.model).toBe("SomeModel:hot");
    expect(typo.thinking).toBe("low");
  });
});

/**
 * ISC-190 / ISC-52 — `models_allowlist` is ENFORCED, not merely accepted.
 *
 * The field has been in the schema since v2 and nothing read it, so a typo'd
 * or deliberately-swapped model started a worker exactly as if the operator
 * had listed it. The list is the fleet's statement about which models it has
 * probed for native tool calls (SRD §5.9); an unlisted one is a model nobody
 * checked, and finding out costs an hour of a run rather than a second of
 * `up`.
 */
describe("models_allowlist is enforced (ISC-190)", () => {
  /** Resolve `w1` under an allowlist, returning the assertion's outcome. */
  async function check(allowlist: string[], model: string): Promise<Error | null> {
    const doc = baseDoc();
    doc["llm"] = { model: "DefaultModel", models_allowlist: allowlist };
    doc["roles"] = { eng: { model } };
    const loaded = await writeAndLoad(doc);
    try {
      assertModelAllowed(loaded, resolveWorker(loaded, "w1"));
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  test("a model absent from a non-empty allowlist is refused", async () => {
    const err = await check(["Allowed-A", "Allowed-B"], "Sneaky-C");
    expect(err).toBeInstanceOf(ModelNotAllowedError);
    // Actionable: which worker, which model, and what it could have been.
    expect(err!.message).toContain("w1");
    expect(err!.message).toContain("Sneaky-C");
    expect(err!.message).toContain("Allowed-A");
  });

  // ISC-52 names the code, so it is asserted rather than assumed.
  test("the refusal carries exit 2, the usage code", async () => {
    const err = await check(["Allowed-A"], "Sneaky-C");
    expect((err as ModelNotAllowedError).exitCode).toBe(EXIT.USAGE);
  });

  // The other half: a gate that refuses everything is not a gate.
  test("a model ON the allowlist is permitted", async () => {
    expect(await check(["Allowed-A", "Allowed-B"], "Allowed-B")).toBeNull();
  });

  /**
   * The schema default. Every existing config omits the key, and turning that
   * into "no model may run" would be a refusal nobody asked for.
   */
  test("an empty allowlist constrains nothing", async () => {
    expect(await check([], "Anything-At-All")).toBeNull();
  });

  /**
   * Both sides are compared AFTER §6.1 decomposition, because `provider/` and
   * `:thinking` are flags rather than part of the model's identity. Comparing
   * raw strings would break in both directions: a worker written
   * `omlx/Allowed-A:high` would be refused by an allowlist that names it, and
   * an entry written `omlx/Allowed-A` would be a rule that can never match —
   * the dead-rule shape `EgressRuleSchema` already refuses to ship.
   */
  test("a decorated worker model matches a bare allowlist entry", async () => {
    expect(await check(["Allowed-A"], "omlx/Allowed-A:high")).toBeNull();
  });

  test("a decorated allowlist entry is not a dead rule", async () => {
    expect(await check(["omlx/Allowed-A:high"], "Allowed-A")).toBeNull();
  });

  /**
   * The gate's own error handling, which is where ISC-190 was escapable.
   *
   * `up` skips a `--workers` id the config does not define — a legitimate
   * Phase 1 shape, since a `PIFLEET_PI_COMMAND` double has no configured model
   * to check. That skip was a `catch { continue }` around `resolveWorker`, and
   * `resolveWorker` throws `ConfigError` for two unrelated conditions: an id
   * absent from `workers:`, and a worker that IS defined but names a role
   * `roles:` does not. A bare catch cannot tell them apart, so the second —
   * a real config defect — was silently treated as "nothing to check here".
   *
   * `FleetConfigSchema.superRefine` rejects that config at parse time
   * (ISC-68), so the hole was not reachable through a config `up` could load.
   * That is exactly why it needs pinning HERE, on a hand-built `LoadedConfig`
   * that bypasses the schema: the value of a second line of defence is what it
   * does when the first one is absent, and a second line that discards its own
   * errors is not one. The construction is deliberate, not a shortcut.
   */
  describe("the gate does not swallow a resolution failure", () => {
    /** A LoadedConfig assembled past the schema, so `w1` names a missing role. */
    async function unresolvable(): Promise<LoadedConfig> {
      const doc = baseDoc();
      doc["llm"] = { model: "DefaultModel", models_allowlist: ["Allowed-A"] };
      const loaded = await writeAndLoad(doc);
      const workers = loaded.config.workers.map((w) => ({ ...w, role: "no-such-role" }));
      return { ...loaded, config: { ...loaded.config, workers } };
    }

    test("a DEFINED worker naming an unknown role propagates, it is not skipped", async () => {
      const loaded = await unresolvable();
      // Sanity: `w1` really is in `workers:`, so this is the defect case and
      // not the absent-id case the skip legitimately covers.
      expect(loaded.config.workers.map((w) => w.id)).toContain("w1");

      let caught: unknown;
      try {
        assertModelsAllowed(loaded, ["w1"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as Error).message).toContain("unknown role");
      expect((caught as Error).message).toContain("no-such-role");
      // Loud the same way it would be without the allowlist feature at all.
      expect((caught as ConfigError).exitCode).toBe(EXIT.USAGE);
    });

    test("an id absent from workers: is still skipped, not refused", async () => {
      const loaded = await unresolvable();
      expect(loaded.config.workers.map((w) => w.id)).not.toContain("ghost-1");
      expect(() => assertModelsAllowed(loaded, ["ghost-1"])).not.toThrow();
    });

    test("a defined, resolvable worker is still checked against the list", async () => {
      const doc = baseDoc();
      doc["llm"] = { model: "DefaultModel", models_allowlist: ["Allowed-A"] };
      doc["roles"] = { eng: { model: "Sneaky-C" } };
      const loaded = await writeAndLoad(doc);
      // The skip must not have widened into "check nothing".
      expect(() => assertModelsAllowed(loaded, ["w1"])).toThrow(ModelNotAllowedError);
    });
  });
});

describe("merge: relative paths (§6.1 exception 3)", () => {
  test("append_system_prompt_file resolves against the config dir, not cwd", async () => {
    const dir = await tempDir();
    const doc = baseDoc();
    doc["roles"] = { eng: { append_system_prompt_file: "./roles/eng.md" } };
    const loaded = await writeAndLoad(doc, dir);
    // cwd is the repo checkout, nowhere near `dir` — the path must not care.
    const w = resolveWorker(loaded, "w1");
    expect(w.briefing).toHaveLength(1);
    expect(w.briefing[0]!.value).toBe(join(dir, "roles", "eng.md"));
  });

  test("~ expands to the home directory", async () => {
    const loaded = await writeAndLoad(baseDoc());
    // baseDoc run.root default is ~/.pifleet/runs — resolved lazily by render;
    // here we assert the briefing resolver's tilde handling directly.
    const doc = baseDoc();
    doc["roles"] = { eng: { append_system_prompt_file: "~/frag.md" } };
    const loaded2 = await writeAndLoad(doc);
    const w = resolveWorker(loaded2, "w1");
    expect(w.briefing[0]!.value.startsWith("/")).toBe(true);
    expect(w.briefing[0]!.value.includes("~")).toBe(false);
    expect(loaded.config.run.root).toBe("~/.pifleet/runs");
  });
});

describe("validation rejections", () => {
  // ISC-59, at the role level.
  test("a role combining bash with read_only: true is rejected with a field-level error", async () => {
    const doc = baseDoc();
    doc["roles"] = { rev: { tools: ["read", "bash"], read_only: true } };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    await expectIssue(doc, "roles.rev.tools", "bash");
  });

  test("bash inherited from defaults into a read_only role is still rejected", async () => {
    const doc = baseDoc();
    doc["defaults"] = { tools: ["read", "bash"] };
    doc["roles"] = { rev: { read_only: true } };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    await expectIssue(doc, "roles.rev.tools", "bash");
  });

  test("a worker override that re-adds bash to a read_only role is rejected", async () => {
    const doc = baseDoc();
    doc["roles"] = { rev: { tools: ["read"], read_only: true } };
    doc["workers"] = [{ id: "w1", role: "rev", tools: ["read", "bash"] }];
    await expectIssue(doc, "workers.0.tools", "bash");
  });

  // ISC-68.
  test("a worker naming an unknown role fails with a named error", async () => {
    const doc = baseDoc();
    doc["workers"] = [{ id: "w1", role: "nosuchrole" }];
    await expectIssue(doc, "workers.0.role", "nosuchrole");
  });

  /**
   * A role name is a MOUNT PATH SEGMENT, not just a label.
   *
   * `roleSkillsDir` joins the role into the host directory mounted read-only
   * at `/skills` in every worker of that role (SRD §5.5), and nothing between
   * the config and the `-v` flag inspected it. A role named
   * `../../../../../../etc` therefore resolves to the host's `/etc` and
   * `render` prints — and `up` executes — a mount of it into the container.
   * The traversal is authored by the same document that names the role, so
   * this is refused at load, where the name enters the system.
   */
  test("a role name that would escape the skills directory is rejected", async () => {
    const doc = baseDoc();
    doc["roles"] = { "../../../../../../etc": {} };
    doc["workers"] = [{ id: "w1", role: "../../../../../../etc" }];
    await expectIssue(doc, "roles.../../../../../../etc", "path segment");
  });

  test("a role name containing a separator is rejected even without a traversal", async () => {
    // `..` is not the only escape: any separator makes the name more than one
    // segment, and a name is only safe to join if it cannot be one.
    const doc = baseDoc();
    doc["roles"] = { "eng/sub": {} };
    doc["workers"] = [{ id: "w1", role: "eng/sub" }];
    await expectIssue(doc, "roles.eng/sub", "path segment");
  });

  test("web_fetch is not a Pi tool and is rejected by the schema", async () => {
    // v1.1's researcher requested web_fetch and was silently granted nothing.
    const doc = baseDoc();
    doc["roles"] = { eng: { tools: ["read", "web_fetch"] } };
    await expectIssue(doc, "roles.eng.tools.1");
  });

  test("an unknown top-level key is a field-level error, not silently ignored", async () => {
    const doc = baseDoc();
    doc["budgets"] = { typo: true };
    await expectIssue(doc, "budgets");
  });

  /**
   * ISC-280: `soft_stop_at` was removed, and the removal is enforced here.
   *
   * Deleting a key from a `.strict()` schema is a behaviour change for every
   * config that carries it — including any copied from the `fleet.example.yaml`
   * that shipped it — so it wants a test rather than a diff. Without this, the
   * key could be re-added by a merge that looks like a restoration and nothing
   * would notice it had no reader again.
   */
  test("run.budget.soft_stop_at is refused, and the message says removed, not typo", async () => {
    const doc = baseDoc();
    (doc["run"] as Record<string, unknown>)["budget"] = {
      tokens_ceiling: 1_000_000,
      soft_stop_at: 0.8,
    };
    // The path, so a same-named key under another parent is not what is caught.
    await expectIssue(doc, "run.budget.soft_stop_at", "removed");
    // And the reason, so the diagnosis survives someone rewording the map.
    await expectIssue(doc, "run.budget.soft_stop_at", "ISC-280");
  });

  /**
   * The generic path still behaves generically — a real typo must NOT inherit
   * the removed-key wording, which would send someone to delete a line they
   * meant to spell correctly.
   */
  test("a genuine typo in the same block is still a plain unrecognized key", async () => {
    const doc = baseDoc();
    (doc["run"] as Record<string, unknown>)["budget"] = {
      tokens_ceiling: 1_000_000,
      tokens_celing: 5,
    };
    await expectIssue(doc, "run.budget.tokens_celing", "unrecognized key");
  });

  test("duplicate worker ids are rejected", async () => {
    const doc = baseDoc();
    doc["workers"] = [
      { id: "w1", role: "eng" },
      { id: "w1", role: "eng" },
    ];
    await expectIssue(doc, "workers.1.id", "duplicate");
  });
});

/**
 * `pane_mode: tui` in a shape that has no pane (SRD §3.5).
 *
 * `pane_mode` was parsed by the schema and read by NOTHING — `load.ts` resolved
 * it into `ResolvedWorker.paneMode` and no consumer existed — which is the same
 * dead-field shape `max_concurrent`, `branch_prefix` and `ui_request_timeout`
 * were each caught in. Making it binding means two documents that describe a
 * worker nobody could ever drive have to start failing, and BOTH are refused
 * here rather than at `up`: a `config validate` error names the field and the
 * file, whereas the same refusal from inside `up` arrives after worktrees,
 * containers and panes exist.
 *
 * The message is asserted, not merely the throw. A bare "it rejected" passes
 * for the wrong error, and these two are refusals an operator has to be able to
 * ACT on — the fix for one is `kind:`, for the other `backend.kind:`, and a
 * message that named neither would send them to delete the pane mode they
 * actually wanted.
 */
describe("pane_mode: tui is refused where there is no pane (SRD §3.5)", () => {
  test("a role pairing tui with the oneshot lifecycle is rejected, naming both fields", async () => {
    const doc = baseDoc();
    doc["roles"] = { pair: { pane_mode: "tui", kind: "oneshot" } };
    doc["workers"] = [{ id: "w1", role: "pair" }];
    await expectIssue(doc, "roles.pair.pane_mode", "kind: oneshot");
    // The REASON, so the diagnosis survives someone rewording the sentence:
    // oneshot launches `pi -p`, which is Pi's non-interactive mode.
    await expectIssue(doc, "roles.pair.pane_mode", "non-interactive");
  });

  test("a worker override that completes tui + oneshot is rejected at the worker", async () => {
    const doc = baseDoc();
    doc["roles"] = { pair: { kind: "oneshot" } };
    doc["workers"] = [{ id: "w1", role: "pair", pane_mode: "tui" }];
    await expectIssue(doc, "workers.0.pane_mode", "kind: oneshot");
  });

  /**
   * Assembled ACROSS levels, which is the shape the read_only guard above was
   * originally caught getting wrong: neither `defaults` nor the role states
   * the combination on its own, and the merge produces it anyway.
   */
  test("tui from defaults and oneshot from the role is still rejected", async () => {
    const doc = baseDoc();
    doc["defaults"] = { pane_mode: "tui" };
    doc["roles"] = { pair: { kind: "oneshot" } };
    doc["workers"] = [{ id: "w1", role: "pair" }];
    await expectIssue(doc, "roles.pair.pane_mode", "kind: oneshot");
    await expectIssue(doc, "workers.0.pane_mode", "kind: oneshot");
  });

  test("tui on the headless backend is rejected, naming backend.kind and the reason", async () => {
    const doc = baseDoc();
    doc["backend"] = { kind: "headless" };
    doc["roles"] = { eng: { pane_mode: "tui" } };
    await expectIssue(doc, "roles.eng.pane_mode", "backend.kind is headless");
    // Consistent with `pifleet tui --worker`, which refuses a headless worker
    // at runtime because there is no pane to hand over.
    await expectIssue(doc, "workers.0.pane_mode", "docker attach");
  });

  /**
   * The negative controls. Without these the guard could be satisfied by
   * refusing `pane_mode: tui` outright, which would make the whole feature
   * unreachable while every rejection test above still passed.
   */
  test("tui with the default lifecycle on a cmux backend loads", async () => {
    const doc = baseDoc();
    doc["backend"] = { kind: "cmux" };
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").paneMode).toBe("tui");
    expect(resolveWorker(loaded, "w1").kind).toBe("persistent");
  });

  test("oneshot on a headless backend loads while the pane mode stays rpc", async () => {
    const doc = baseDoc();
    doc["backend"] = { kind: "headless" };
    doc["roles"] = { eng: { kind: "oneshot" } };
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").paneMode).toBe("rpc");
    expect(resolveWorker(loaded, "w1").kind).toBe("oneshot");
  });

  /**
   * `backend.kind` is OPTIONAL and an absent block means UNSET (ISC-271), so
   * this check can only see the document that SAYS headless. Stated as a test
   * rather than only in a comment, because the honest bound of a guard is the
   * part most likely to be misremembered as wider than it is.
   *
   * ## The bound is UNCHANGED; where it is CLOSED has changed
   *
   * Every assertion below still holds and is still the point: the schema does
   * not refuse this document, and must not start to — `parseConfig` has no
   * `--backend` and no `DEFAULT_BACKEND`, so a schema that guessed would refuse
   * a perfectly good `up --backend cmux`.
   *
   * What was stale was the sentence that used to end this comment: "`pifleet
   * tui --worker` is what refuses that worker at runtime". That was true when
   * it was written and describes the wrong guard now. `pifleet tui` refuses one
   * COMMAND, after a fleet is already up with no pane to attach to; TUI spec
   * item 4's second half asked for the check against the EFFECTIVE backend, and
   * `up` now makes it — `assertTuiBackendPossible` in `cli/commands/up.ts`,
   * proven in both directions in `test/unit/tui-guards.test.ts` and through the
   * real CLI in `test/integration/up-wiring.test.ts`.
   *
   * Worth knowing while reading this test: `DEFAULT_BACKEND` is `headless`, so
   * the very document below is one `up` with no `--backend` now refuses. The
   * two statements are consistent — the schema cannot see that and `up` can,
   * which is the whole reason the check had to move.
   */
  test("a tui worker with no backend block stated is NOT refused here", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await writeAndLoad(doc);
    expect(loaded.config.backend.kind).toBeUndefined();
    expect(resolveWorker(loaded, "w1").paneMode).toBe("tui");
  });
});

/**
 * The two non-fatal config warnings SRD-OBSERVER-001 section 6.2/6.6 call for
 * (section 13's "Config." bullet) — ISC-392, ISC-393. Neither fails
 * `.safeParse`, so these call the pure functions directly rather than going
 * through `expectIssue`, on the same reasoning `tui-guards.test.ts` uses for
 * `unattendedTuiWarning`: a document that trips one of these must still load.
 */
describe("cloud_access without cloud.kubeconfig warns, never refuses (SRD-OBSERVER-001 §6.6)", () => {
  test("a role resolving cloud_access: true with no cloud.kubeconfig is named", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { cloud_access: true } };
    const loaded = await writeAndLoad(doc);
    expect(loaded.config.cloud.kubeconfig).toBeNull();
    const missing = workersMissingKubeconfig(loaded.config);
    expect(missing).toEqual(["w1"]);
    const warning = kubeconfigScopeWarning(missing);
    expect(warning).not.toBeNull();
    expect(warning).toContain("w1");
    expect(warning).toContain("cloud.kubeconfig");
  });

  test("the same document still loads — this is a warning, not a schema refusal", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { cloud_access: true } };
    // Must not throw.
    await writeAndLoad(doc);
  });

  test("cloud.kubeconfig set clears the warning even with cloud_access: true", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { cloud_access: true } };
    doc["cloud"] = { kubeconfig: "/run/pifleet/kubeconfig" };
    const loaded = await writeAndLoad(doc);
    expect(workersMissingKubeconfig(loaded.config)).toEqual([]);
    expect(kubeconfigScopeWarning(workersMissingKubeconfig(loaded.config))).toBeNull();
  });

  test("cloud_access: false raises nothing, kubeconfig unset or not", async () => {
    const doc = baseDoc();
    const loaded = await writeAndLoad(doc);
    expect(workersMissingKubeconfig(loaded.config)).toEqual([]);
  });

  test("a worker-level override completes the grant a role left unset", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng", cloud_access: true }];
    const loaded = await writeAndLoad(doc);
    expect(workersMissingKubeconfig(loaded.config)).toEqual(["w1"]);
  });
});

describe("pane_mode: tui on the observer role warns, never refuses (SRD-OBSERVER-001 §6.2, §7.5)", () => {
  test("an observer role resolving pane_mode: tui is named, and the mechanism is stated", async () => {
    const doc = baseDoc();
    doc["roles"] = { observer: { pane_mode: "tui" } };
    doc["workers"] = [{ id: "obs-1", role: "observer" }];
    const loaded = await writeAndLoad(doc);
    const tuiWorkers = observerTuiWorkers(loaded.config);
    expect(tuiWorkers).toEqual(["obs-1"]);
    const warning = observerTuiEpochWarning(tuiWorkers);
    expect(warning).not.toBeNull();
    expect(warning).toContain("obs-1");
    // The mechanism, not just the fact — this is what a reader has to act on.
    expect(warning).toMatch(/no epoch/);
    expect(warning).toMatch(/already_completed/);
    expect(warning).toMatch(/twice/);
  });

  test("the same document still loads — this is a warning, not a schema refusal", async () => {
    const doc = baseDoc();
    doc["roles"] = { observer: { pane_mode: "tui" } };
    doc["workers"] = [{ id: "obs-1", role: "observer" }];
    // Must not throw, unlike the tui+oneshot / tui+headless refusals above.
    await writeAndLoad(doc);
  });

  test("pane_mode: tui on a DIFFERENT role's name raises nothing", async () => {
    // Keyed to the literal role name "observer" — the hazard is a property of
    // what the observer-ops skill does, not a generic fact this schema can
    // derive from any read-only role.
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await writeAndLoad(doc);
    expect(observerTuiWorkers(loaded.config)).toEqual([]);
  });

  test("observer at pane_mode: rpc (the shipped default) raises nothing", async () => {
    const doc = baseDoc();
    doc["roles"] = { observer: {} };
    doc["workers"] = [{ id: "obs-1", role: "observer" }];
    const loaded = await writeAndLoad(doc);
    expect(observerTuiWorkers(loaded.config)).toEqual([]);
  });

  /**
   * The shipped example deliberately DOES carry one tui observer, and this
   * asserts exactly which. `obs-1` is the operations console's worker —
   * `scripts/operations` resolves pane 1's mode from it, and only `tui` makes
   * that pane Pi's own interface rather than a rendered log tail.
   *
   * Asserting the identity rather than a count is the point. `up` permits
   * exactly one tui worker in a fleet, so this is a seat with room for one, and
   * a bare count cannot tell "obs-1 holds it" apart from "someone moved the
   * override onto obs-2, or up onto the role". The role-level case is the one
   * that matters: on the role it would apply to every observer, and tui
   * allocates no epoch, so a re-dispatched watch pass would run twice.
   */
  test("fleet.example.yaml ships exactly one tui observer, and it is the console's", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(observerTuiWorkers(loaded.config)).toEqual(["obs-1"]);
    expect(resolveWorker(loaded, "obs-2").paneMode).toBe("rpc");
  });
});

describe("theme resolves three-level and warns on a name the image lacks", () => {
  test("a worker override beats the role, which beats defaults", async () => {
    const doc = baseDoc();
    doc["defaults"] = { theme: "nord" };
    doc["roles"] = { eng: { theme: "gruvbox-dark" }, obs: {} };
    doc["workers"] = [
      { id: "w1", role: "eng", theme: "dracula" },
      { id: "w2", role: "eng" },
      { id: "w3", role: "obs" },
    ];
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").theme).toBe("dracula");
    expect(resolveWorker(loaded, "w2").theme).toBe("gruvbox-dark");
    expect(resolveWorker(loaded, "w3").theme).toBe("nord");
  });

  /**
   * UNSET must stay unset, not become "dark".
   *
   * `docker/entrypoint.sh` writes Pi's `settings.json` `theme` key only when
   * the value is non-empty, so an absent theme means "leave whatever the
   * operator picked with /settings alone". A default resolved here would
   * overwrite that hand-made choice on every container start, which is a
   * setting that silently will not stick.
   */
  test("no theme anywhere resolves to undefined, not to a default", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng" }];
    const loaded = await writeAndLoad(doc);
    expect(resolveWorker(loaded, "w1").theme).toBeUndefined();
  });

  test("an unknown name on a tui worker warns and names both worker and theme", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng", pane_mode: "tui", theme: "catppuccin" }];
    const loaded = await writeAndLoad(doc);
    const bad = unknownThemeWorkers(loaded.config);
    expect(bad).toEqual([{ id: "w1", theme: "catppuccin" }]);
    const warning = unknownThemeWarning(bad);
    expect(warning).not.toBeNull();
    expect(warning).toContain("w1");
    expect(warning).toContain("catppuccin");
    // The consequence, which is the part a reader has to act on: it does not
    // fail, it looks like every other pane.
    expect(warning).toMatch(/default theme/);
    // And the way out — the real names, since a near-miss spelling is the
    // overwhelmingly likely cause.
    expect(warning).toContain("catppuccin-mocha");
  });

  test("the same document still loads — a colour scheme must not refuse a fleet", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng", pane_mode: "tui", theme: "nope" }];
    await writeAndLoad(doc);
  });

  /**
   * An rpc worker renders no pane, so its theme is unobservable and warning
   * about it is noise. This is not hypothetical tidiness: `defaults.theme`
   * lands on EVERY worker in the fleet, so without this filter one typo in
   * defaults would print a line naming every worker that exists.
   */
  test("an unknown name on an rpc worker raises nothing", async () => {
    const doc = baseDoc();
    doc["defaults"] = { theme: "nope" };
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng" }];
    const loaded = await writeAndLoad(doc);
    expect(unknownThemeWorkers(loaded.config)).toEqual([]);
    expect(unknownThemeWarning([])).toBeNull();
  });

  test("Pi's own built-ins are accepted, not just the bundle", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: {} };
    doc["workers"] = [{ id: "w1", role: "eng", pane_mode: "tui", theme: "dark" }];
    const loaded = await writeAndLoad(doc);
    expect(unknownThemeWorkers(loaded.config)).toEqual([]);
  });

  /**
   * The shipped example's two attended panes must carry DIFFERENT themes.
   *
   * Asserting the two names rather than merely "both set" is the point: the
   * whole reason the key exists is that an operator glancing at a two-pane
   * console can tell which agent they are typing at, and two panes that both
   * resolved to the same name would satisfy every weaker assertion while
   * failing the only requirement.
   */
  test("fleet.example.yaml gives its two attended panes different themes", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const obs = resolveWorker(loaded, "obs-1").theme;
    const tick = resolveWorker(loaded, "tick-1").theme;
    expect(obs).toBe("catppuccin-mocha");
    expect(tick).toBe("catppuccin-latte");
    expect(obs).not.toBe(tick);
    expect(unknownThemeWorkers(loaded.config)).toEqual([]);
  });
});

describe("worker count follows config (ISC-61)", () => {
  test("changing only the workers: length changes the resolved count", async () => {
    const three = baseDoc();
    three["workers"] = [
      { id: "w1", role: "eng" },
      { id: "w2", role: "eng" },
      { id: "w3", role: "eng" },
    ];
    const four = baseDoc();
    four["workers"] = [...(three["workers"] as unknown[]), { id: "w4", role: "eng" }];
    expect(resolveAllWorkers(await writeAndLoad(three))).toHaveLength(3);
    expect(resolveAllWorkers(await writeAndLoad(four))).toHaveLength(4);
  });
});

/**
 * ISC-232: the harness surface is a CONFIG decision, and
 * `DEFAULT_HARNESS_PATTERNS` is what a silent config falls back to.
 *
 * These pin the schema half — the shape, the fallback, and the two ways an
 * operator can get the surface wrong. The wiring half (that a config actually
 * changes what `pifleet artifacts` treats as harness) is pinned end-to-end in
 * `test/integration/harvest.test.ts`, because a schema field nothing reads
 * would satisfy every assertion here and still change nothing at runtime.
 */
describe("harness.patterns (ISC-232)", () => {
  // The backward-compatibility guarantee: every fleet.yaml written before
  // this key existed must keep loading, and must keep meaning what it meant.
  // `undefined` — not `[]` — is what tells the harvester to use its defaults.
  test("omitting harness leaves patterns undefined, not empty", async () => {
    const loaded = await writeAndLoad(baseDoc());
    // `replace: false` is the ISC-243 default and carries no opinion of its
    // own: with `patterns` undefined there is nothing to extend or replace, so
    // the meaning of an omitted `harness` key is byte-for-byte what it was.
    expect(loaded.config.harness).toEqual({ replace: false });
    expect(loaded.config.harness.patterns).toBeUndefined();
  });

  test("the shipped example still omits the key", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(loaded.config.harness.patterns).toBeUndefined();
  });

  test("a declared list is carried through verbatim", async () => {
    const doc = baseDoc();
    doc["harness"] = { patterns: ["ci/**", "grade/*.sh"] };
    const loaded = await writeAndLoad(doc);
    expect(loaded.config.harness.patterns).toEqual(["ci/**", "grade/*.sh"]);
  });

  /**
   * The important rejection. `patterns: []` reads like "no opinion" and would
   * mean the opposite: nothing could ever match, `touched` would be
   * permanently empty, and the ISC-150 cap — the only thing standing between
   * a rewritten exam and a certified success — would be switched off by a key
   * that looks like it says nothing. Omitting the key is how you say nothing.
   */
  test("an empty list is refused rather than read as 'match nothing'", async () => {
    const doc = baseDoc();
    doc["harness"] = { patterns: [] };
    await expectIssue(doc, "harness.patterns");
  });

  // Strictness matches the rest of the document: a typo'd key is a loud error,
  // not a silently ignored intention to widen the surface.
  test("an unknown key under harness is a field-level error", async () => {
    const doc = baseDoc();
    doc["harness"] = { pattern: ["ci/**"] };
    await expectIssue(doc, "harness.pattern", "unrecognized key");
  });

  /**
   * The cap must clear `DEFAULT_HARNESS_PATTERNS`' own length, or a config
   * could not even restate the list it is overriding. Guards against someone
   * "tidying" this to the `.max(64)` the neighbouring arrays use.
   */
  test("the list is long enough to restate the defaults", async () => {
    const doc = baseDoc();
    doc["harness"] = { patterns: [...DEFAULT_HARNESS_PATTERNS] };
    const loaded = await writeAndLoad(doc);
    expect(loaded.config.harness.patterns).toHaveLength(DEFAULT_HARNESS_PATTERNS.length);
  });
});

describe("resolveHarnessPatterns (ISC-232)", () => {
  /**
   * Build a run directory whose `run.json` holds `body`, and hand back the
   * `RunPaths` a harvest would be given. `null` writes no `run.json` at all —
   * the shape of a run assembled by hand or created before the field existed.
   */
  async function runWith(body: Record<string, unknown> | null): Promise<RunPaths> {
    const root = await tempDir();
    const run = runPaths("run-h", root);
    await mkdir(run.root, { recursive: true });
    if (body !== null) await writeFile(run.runJson, JSON.stringify(body));
    return run;
  }

  // The ordinary case for a pure read over a run directory: defaults, no
  // degradation, and a surface line that says so out loud.
  test("a run recording no surface uses the defaults, silently", async () => {
    const got = await resolveHarnessPatterns(await runWith(null));
    expect(got.patterns).toBeUndefined();
    expect(got.warnings).toEqual([]);
    expect(got.surface).toContain("built-in defaults");
  });

  // An explicit null is `up` saying "config had no opinion" — a positive
  // record, not an absence, and equally silent.
  test("harness_patterns: null is the defaults, silently", async () => {
    const got = await resolveHarnessPatterns(await runWith({ harness_patterns: null }));
    expect(got.patterns).toBeUndefined();
    expect(got.warnings).toEqual([]);
  });

  test("patterns recorded at run creation are what the harvest grades against", async () => {
    const got = await resolveHarnessPatterns(await runWith({ harness_patterns: ["ci/**"] }));
    expect(got.patterns).toEqual(["ci/**"]);
    expect(got.warnings).toEqual([]);
    expect(got.surface).toContain("run.json");
  });

  /**
   * `[]` cannot come from a valid `fleet.yaml`, so reaching it here means a
   * hand-edited or corrupt `run.json`. Falling back keeps the pure read
   * working; the warning is because an empty list would have disabled the
   * ISC-150 cap outright, and silently repairing that hides it.
   */
  test("an empty recorded surface is refused, loudly", async () => {
    const got = await resolveHarnessPatterns(await runWith({ harness_patterns: [] }));
    expect(got.patterns).toBeUndefined();
    expect(got.warnings.join(" ")).toContain("EMPTY");
  });

  test("an unreadable recorded surface degrades rather than crashing the read", async () => {
    const got = await resolveHarnessPatterns(await runWith({ harness_patterns: 42 }));
    expect(got.patterns).toBeUndefined();
    expect(got.warnings.join(" ")).toContain("harness surface");
  });

  // The documented escape hatch: a run that predates persistence, or a
  // dry-run preview of how a candidate config would grade.
  test("an explicit --config overrides what the run recorded", async () => {
    const run = await runWith({ harness_patterns: ["recorded/**"] });
    const dir = await tempDir();
    const doc = baseDoc();
    doc["harness"] = { patterns: ["explicit/**"] };
    const path = join(dir, "fleet.yaml");
    await writeFile(path, stringify(doc));
    const got = await resolveHarnessPatterns(run, path);
    // The EFFECTIVE list, which since ISC-243 EXTENDS the built-in defaults
    // rather than replacing them. This assertion used to read
    // `toEqual(["explicit/**"])`, and that expectation was the old semantics:
    // a config adding one pattern narrowed the surface to that pattern alone
    // and switched the ISC-150 cap off for every diff that missed it.
    expect(got.patterns).toContain("explicit/**");
    expect(got.patterns).toContain("package.json");
    expect(got.patterns).not.toContain("recorded/**");
    expect(got.surface).toContain("overriding");
  });

  // The named opt-out, and the control for the case above: an operator who
  // means "start from nothing" still gets exactly that.
  test("harness.replace makes an explicit --config start from nothing", async () => {
    const run = await runWith({ harness_patterns: ["recorded/**"] });
    const dir = await tempDir();
    const doc = baseDoc();
    doc["harness"] = { patterns: ["explicit/**"], replace: true };
    const path = join(dir, "fleet.yaml");
    await writeFile(path, stringify(doc));
    const got = await resolveHarnessPatterns(run, path);
    expect(got.patterns).toEqual(["explicit/**"]);
  });

  // An operator who NAMED a config meant it. Answering a bad --config with
  // the defaults would silently ignore the one case where intent is explicit.
  test("an explicit --config that is missing or invalid throws", async () => {
    const run = await runWith(null);
    const dir = await tempDir();
    await expect(resolveHarnessPatterns(run, join(dir, "nope.yaml"))).rejects.toThrow(ConfigError);
    const bad = join(dir, "bad.yaml");
    await writeFile(bad, stringify({ version: 2, name: "broken" }));
    await expect(resolveHarnessPatterns(run, bad)).rejects.toThrow(ConfigValidationError);
  });

  /**
   * The reproducibility property itself (ISC-232), stated as a test rather
   * than left to the absence of a cwd parameter.
   *
   * A `fleet.yaml` sitting in the process's own directory must not reach a
   * harvest. Before this, `resolveConfigPath` fell through to `./fleet.yaml`
   * and then to `~/.config/pifleet/fleet.yaml`, so the same run harvested on
   * two days from two directories could be graded two ways — a task capped by
   * the ISC-150 rule one day and certified `success` the next, with nothing
   * about the run having changed.
   */
  test("a fleet.yaml in the cwd cannot change how a run is graded", async () => {
    const run = await runWith({ harness_patterns: ["recorded/**"] });
    const cwd = await tempDir();
    const doc = baseDoc();
    doc["harness"] = { patterns: ["ambient/**"] };
    await writeFile(join(cwd, "fleet.yaml"), stringify(doc));
    const original = process.cwd();
    try {
      process.chdir(cwd);
      const got = await resolveHarnessPatterns(run);
      expect(got.patterns).toEqual(["recorded/**"]);
    } finally {
      process.chdir(original);
    }
  });

  // The same guarantee for a run that recorded nothing: the ambient config
  // must not be able to invent a surface either.
  test("a fleet.yaml in the cwd cannot supply a surface the run never had", async () => {
    const run = await runWith(null);
    const cwd = await tempDir();
    const doc = baseDoc();
    doc["harness"] = { patterns: ["ambient/**"] };
    await writeFile(join(cwd, "fleet.yaml"), stringify(doc));
    const original = process.cwd();
    try {
      process.chdir(cwd);
      const got = await resolveHarnessPatterns(run);
      expect(got.patterns).toBeUndefined();
    } finally {
      process.chdir(original);
    }
  });
});

describe("loadConfig on an unreadable file (ISC-232)", () => {
  /**
   * A config that EXISTS and cannot be read is a bad config, not a crash.
   *
   * As a raw `Error` it escaped every `instanceof ConfigError` handler and
   * exited 8 ("internal error"), taking `artifacts` and `report` down with it
   * — while malformed YAML, which is strictly less recoverable, degraded
   * politely. Same class of operator mistake, so the same class of error.
   */
  test("a mode-000 config raises ConfigError, not a bare Error", async () => {
    const dir = await tempDir();
    const path = join(dir, "fleet.yaml");
    await writeFile(path, stringify(baseDoc()));
    await chmod(path, 0o000);
    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError);
      const err = await loadConfig(path).catch((e: unknown) => e);
      expect((err as ConfigError).exitCode).toBe(EXIT.USAGE);
    } finally {
      await chmod(path, 0o600);
    }
  });
});

describe("config validate CLI (ISC-58)", () => {
  async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "src", "cli", "index.ts"), ...args], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("exits 0 on the shipped example", async () => {
    const r = await runCli(["config", "validate", "--config", join(REPO_ROOT, "fleet.example.yaml")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  /**
   * The shipped example does not teach the alias this repo deprecated (ISC-264).
   *
   * `base_url` was renamed `host.docker.internal` -> `omlx.pifleet.internal`
   * because the old name claimed the relay was the Docker host, which stopped
   * being true once `relay_upstream` could name a LAN peer. The old spelling
   * still resolves and is still accepted WITH A WARNING — and this file is what
   * every new fleet is COPIED FROM, so shipping the old spelling here meant each
   * fresh config began life emitting that warning. `relay.ts` says why that
   * matters in its own words: "silently accepting a spelling that is on its way
   * out is how a transition becomes permanent."
   *
   * ## Driven through `omlxRelayTarget`, and NOT through `config validate`
   *
   * Measured, and it is the reason this test is shaped the way it is. A first
   * attempt asserted on `config validate --config fleet.example.yaml`'s stderr,
   * and putting the deprecated spelling back left it GREEN: that command never
   * reaches the warning. Nothing outside `relay.ts` calls `relayListenPort`, and
   * the alias is only read when a relay is actually being built. A probe that
   * cannot observe the thing it is named after is worth nothing, so this one
   * calls the function that emits it.
   *
   * Asserted on the WARNING rather than on the file's text, because the warning
   * is what an operator sees and what the rename exists to retire; a grep for
   * the new spelling would also pass on a config carrying both.
   *
   * The DIAL side is deliberately not covered: `relay_upstream`'s default is
   * still `host.docker.internal` and still correct, because that one names the
   * real Docker host rather than an alias on the bridge.
   */
  test("the shipped example raises no deprecated-alias warning", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      omlxRelayTarget(loaded.config);
    } finally {
      process.stderr.write = real;
    }
    const stderr = written.join("");
    expect(stderr).not.toContain("OLD listen alias");
    expect(stderr).not.toContain("ISC-264");
  });

  test("exits 2 with a field-level error on a malformed config", async () => {
    const dir = await tempDir();
    const doc = baseDoc();
    doc["workers"] = [{ id: "w1", role: "ghost" }];
    const path = join(dir, "bad.yaml");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringify(doc));
    const r = await runCli(["config", "validate", "--config", path]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("workers.0.role");
  });

  test("--json carries the same field-level errors on stdout", async () => {
    const dir = await tempDir();
    const doc = baseDoc();
    doc["workers"] = [{ id: "w1", role: "ghost" }];
    const path = join(dir, "bad.yaml");
    await writeFile(path, stringify(doc));
    const r = await runCli(["config", "validate", "--json", "--config", path]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as { valid: boolean; errors: { path: string }[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.some((e) => e.path === "workers.0.role")).toBe(true);
  });
});

/**
 * `BackendSchema.kind` is OPTIONAL, and nothing else in this file parses it.
 *
 * The whole of ISC-271 rests on one property of this schema: that an absent
 * `backend:` block is distinguishable from `backend: {kind: cmux}` after parse.
 * It used to carry `.default("cmux")`, under which all three spellings below
 * produced byte-identical objects — so `up` could not honour a config that SET
 * `kind` without also forcing cmux onto every config that said nothing, which
 * is exit 3 on every host with no cmux.
 *
 * Three lines, asserted on the SCHEMA directly rather than through `loadConfig`,
 * because a default restored here would break `up`'s precedence silently: the
 * integration tests that cover it drive the CLI, and a config that suddenly
 * means `cmux` fails them with a backend error whose cause is three layers
 * away. This fails at the source, and says which.
 */
describe("BackendSchema.kind distinguishes 'unset' from 'cmux' (ISC-271)", () => {
  test("an absent block, an empty block, and an explicit kind parse to three different answers", () => {
    // Absent: `prefault({})` supplies the block, and `kind` stays undefined.
    expect(BackendSchema.parse(undefined).kind).toBeUndefined();
    // Present but empty: same answer, because "{}" says nothing about kind.
    expect(BackendSchema.parse({}).kind).toBeUndefined();
    // Explicit: the operator's word, carried through.
    expect(BackendSchema.parse({ kind: "cmux" }).kind).toBe("cmux");
  });
});
