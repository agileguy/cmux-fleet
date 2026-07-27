/**
 * Config loader + merge semantics (ISC-58, ISC-59, ISC-61, ISC-64, ISC-67,
 * ISC-68 and the three §6.1 merge exceptions).
 *
 * Everything here runs with no Docker daemon and no network: fixtures are
 * temp-dir YAML files, and the one CLI-level test spawns `bun` only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  ConfigError,
  ConfigValidationError,
  decomposeModel,
  loadConfig,
  resolveAllWorkers,
  resolveWorker,
} from "../../src/config/load.ts";
import { parseDuration } from "../../src/config/schema.ts";

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
  // ISC-67: all six SRD roles load from the shipped default config.
  test("fleet.example.yaml loads with all six SRD roles", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(Object.keys(loaded.config.roles).sort()).toEqual(
      ["engineer", "investigator", "reviewer", "sre", "tester", "verifier"].sort(),
    );
    expect(loaded.config.workers).toHaveLength(6);
    // Every worker resolves without error.
    const resolved = resolveAllWorkers(loaded);
    expect(resolved.map((w) => w.id)).toEqual(["sre-1", "sre-2", "inv-1", "ver-1", "eng-1", "rev-1"]);
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

  test("duplicate worker ids are rejected", async () => {
    const doc = baseDoc();
    doc["workers"] = [
      { id: "w1", role: "eng" },
      { id: "w1", role: "eng" },
    ];
    await expectIssue(doc, "workers.1.id", "duplicate");
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
