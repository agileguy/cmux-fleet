/**
 * Config loader + merge semantics (ISC-58, ISC-59, ISC-61, ISC-64, ISC-67,
 * ISC-68 and the three §6.1 merge exceptions).
 *
 * Everything here runs with no Docker daemon and no network: fixtures are
 * temp-dir YAML files, and the one CLI-level test spawns `bun` only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

import { LlmSchema } from "../../src/config/schema.ts";
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
  type ResolvedWorker,
} from "../../src/config/load.ts";
import { resolveHarnessPatterns } from "../../src/harvest/patterns.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import { DEFAULT_HARNESS_PATTERNS } from "../../src/harvest/acceptance.ts";
import { assertModelsAllowed, tuiWorkerIds } from "../../src/cli/commands/up.ts";
import { buildProgram, exitCodeForError } from "../../src/cli/index.ts";
import { register as registerConfigCommand } from "../../src/cli/commands/config.ts";
import { cliBudget } from "../support/budget.ts";
import { DEFAULT_DEVELOPMENT_WORKERS } from "../../src/backends/cmux/operations-plan.ts";
import { REVIEW_CONSOLE_ROSTER } from "../../src/run/dispatch-request.ts";
import {
  BackendSchema,
  PI_BUILTIN_TOOLS,
  PI_EXTENSION_TOOLS,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIXES,
  effectiveToolGrant,
  kubeconfigScopeWarning,
  OBSERVER_K8S_ROLE,
  observerTuiEpochWarning,
  observerTuiWorkers,
  DEFAULT_GIT_IDENTITY,
  operatorIdentityWarning,
  unknownThemeWarning,
  unknownThemeWorkers,
  parseDuration,
  submitReportWriteWarning,
  submitReportWriteWorkers,
  workersMissingKubeconfig,
  writeCapableIn,
  type ToolName,
} from "../../src/config/schema.ts";
import { omlxRelayTarget } from "../../src/security/relay.ts";
import { EXIT } from "../../src/contracts.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The `triage` console's two seats, ENUMERATED once (SRD-TRIAGE-CONSOLE §6.1).
 *
 * Named as a set rather than derived from a filter, because every assertion
 * below is about this set EXISTING as well as about what it resolves to. A
 * probe written as "every worker whose pane_mode is rpc is on the 20b" is
 * satisfied by a file with no triage seats in it at all; a probe written
 * against these two ids is not. That is the whole difference between a
 * criterion and a tautology here, and the seats are one careless YAML edit
 * from being deletable without a single test going red.
 *
 * Phase 2 introduces the roster constant in `src/` that the console's own code
 * dispatches through (§13). When it lands this list is what it must agree
 * with — the same relationship `REVIEW_CONSOLE_ROSTER` already has with
 * ISC-526's lens map above — and the roster test below is the one place that
 * has to change.
 */
/*
 * IN `fleet.example.yaml`'S DECLARATION ORDER, which as of 2026-09-13 happens to
 * EQUAL pane order — and the coincidence is worth naming so nobody builds on it.
 *
 * This comment used to record a real divergence: the file declared two pairs,
 * `tri-1, obs-t1, tri-2, obs-t2`, while `DEFAULT_TRIAGE_WORKERS` listed both
 * collators before both observers, because that is what put each observer under
 * its own collator in the 2x2. Two orders, two constants, neither wrong.
 *
 * The console is now ONE collator over THREE observers, and `obs-t3` was
 * APPENDED after `obs-t2` rather than dropped into `tri-2`'s old slot — so both
 * orders read `tri-1, obs-t1, obs-t2, obs-t3` and the two constants agree
 * element for element. **They are still two different facts.** This list is
 * whatever `resolveAllWorkers` yields from the file; `DEFAULT_TRIAGE_WORKERS` is
 * the order that puts the collator in the full-width pane. Re-ordering the YAML
 * would move this and not that, and an assertion that leaned on today's
 * agreement would fail somewhere unrelated to the edit that caused it.
 */
const TRIAGE_SEATS = ["tri-1", "obs-t1", "obs-t2", "obs-t3"] as const;

/**
 * D1, settled 2026-09-06 as arm 3: all four seats run the LOCAL 20b, in both
 * config files. Not a performance choice — §0.2's argument is that an
 * observer's context (namespaces, pod names, restart counts, log excerpts,
 * cluster endpoints from a live environment, 288 sweeps a day) may not leave
 * the machine, and nothing reduces a transcript after it has been sent.
 */
/*
 * [CHANGED 2026-09-09] `gpt-oss-20b-MXFP4-Q8` -> `gemma-4-26b-a4b-it-bf16`.
 *
 * The privacy argument above is unchanged and is why this is still a LOCAL
 * model. What changed is which one: the operator's `fleet.yaml` moved every
 * oMLX worker to bf16 on 2026-09-07, SRD §11 Q8's tool-argument ceilings were
 * measured on this model, and CI now generates against it too — see ISC-1116 at
 * the foot of this file for why those three have to be the same string.
 */
const TRIAGE_MODEL = "gemma-4-26b-a4b-it-bf16";

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

/**
 * ISC-527's assertion, as a value rather than an inline `expect` — so a
 * fixture built to collide two themes can inspect what the failure SAYS
 * instead of just failing the test that builds it.
 *
 * Throws naming the two worker ids, not just the theme, because a message
 * that only lists theme values lets a reader count a duplicate without
 * finding it among six-plus attended panes.
 */
function assertDistinctThemes(attended: readonly { id: string; theme?: string }[]): void {
  const byTheme = new Map<string, string>();
  for (const w of attended) {
    if (w.theme === undefined) continue;
    const prior = byTheme.get(w.theme);
    if (prior !== undefined) {
      throw new Error(`workers "${prior}" and "${w.id}" both use theme "${w.theme}"`);
    }
    byTheme.set(w.theme, w.id);
  }
}

// ---------------------------------------------------------------------------

describe("worked example", () => {
  // ISC-67: all eight shipped roles load from the shipped default config.
  // observer replaces investigator (SRD-OBSERVER-001 D2) — ISC-391.
  // `triage` is the eighth (SRD-TRIAGE-CONSOLE §6.1): the console with no
  // keyboard. It is asserted as a NAME in the set rather than by a bumped
  // count, for the same reason the worker list below is — a count says one
  // changed and never which.
  test("fleet.example.yaml loads with all eight shipped roles", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    expect(Object.keys(loaded.config.roles).sort()).toEqual(
      ["engineer", "observer", "reviewer", "sre", "tester", "ticketing", "triage", "verifier"].sort(),
    );
    // Every worker resolves without error, and the SET is asserted rather than
    // its size. A bare `toHaveLength` fails on a number when a worker is added
    // or dropped, which says how many changed and never which — and the two
    // consoles now differ only by which ids they name, so which is the whole
    // question. The count comes off this list, so there is one place to edit.
    const expected = [
      "sre-1",
      "sre-2",
      "obs-1",
      "obs-2",
      "ver-1",
      // The `development` console's four seats. eng-2 and tst-1 exist for it;
      // the `tester` role had no worker at all before it.
      "eng-1",
      "eng-2",
      "tst-1",
      "tst-2",
      "tick-1",
      // The `triage` console's two seats (SRD-TRIAGE-CONSOLE §6.1). One run,
      // two ids, and the observer is the EXISTING observer role at a
      // cadence rather than a second role — which is why it appears here and
      // nowhere in the roles assertion above.
      //
      // Spliced from `TRIAGE_SEATS` rather than re-typed, so this roster and
      // the model/pane_mode criteria below cannot come to disagree about which
      // ids the console has — a second copy of a set is how ISC-264 got two
      // constants that quietly meant different things.
      ...TRIAGE_SEATS,
    ];
    expect(loaded.config.workers).toHaveLength(expected.length);
    const resolved = resolveAllWorkers(loaded);
    expect(resolved.map((w) => w.id)).toEqual(expected);
  });

  /**
   * Every ATTENDED pane is tellable apart from every other at a glance.
   *
   * With one attended console holding two panes this was a nicety. With two
   * consoles holding six between them — and TWO OF THEM running the same role,
   * so identical in every other on-screen respect — the palette is the only
   * thing that says which container a pane belongs to before you read the
   * title. A duplicate theme is therefore a defect, not an aesthetic choice,
   * and nothing else in the suite would notice one.
   *
   * Asserted on RESOLVED workers because `defaults <- roles <- worker` is where
   * a theme could be inherited rather than set, and two workers inheriting one
   * role's theme is exactly how a duplicate would arrive.
   */
  test("no two attended workers share a theme", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const attended = resolveAllWorkers(loaded).filter((w) => w.paneMode === "tui");
    // Anti-vacuity: an empty or single-element set passes any uniqueness check.
    expect(attended.length).toBeGreaterThan(1);
    expect(attended.filter((w) => w.theme === undefined)).toEqual([]);
    // Named in the failure, not just counted, so the message says WHICH pair —
    // see `assertDistinctThemes` and ISC-527 below.
    expect(() => assertDistinctThemes(attended)).not.toThrow();
  });

  /**
   * ISC-525 (§12 seat model, D10). The `development` console's roster is
   * `eng-1`, `eng-2`, `tst-1`, `tst-2`, and — the actual regression this
   * guards, since the id list alone would not catch a role left behind by a
   * partial edit — no worker in it resolves to `role: reviewer`.
   */
  test("ISC-525: the development console's roster holds no reviewer", async () => {
    expect([...DEFAULT_DEVELOPMENT_WORKERS]).toEqual(["eng-1", "eng-2", "tst-1", "tst-2"]);
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    for (const id of DEFAULT_DEVELOPMENT_WORKERS) {
      const role = resolveWorker(loaded, id).role;
      expect(role, `${id} resolved to role "${role}"`).not.toBe("reviewer");
    }
  });

  /**
   * ISC-526 (§0.5 correction 1). The seat rename retires nothing: three
   * `review`-console workers still hold `role: reviewer`, and each still
   * layers its lens file ON TOP OF `roles/reviewer.md` rather than replacing
   * it — `resolveWorker(...).briefing` is `defaults -> role -> worker`
   * concatenated (`src/config/load.ts`), so the chain drops the role file the
   * moment a future edit removes the role rather than widens it.
   *
   * The `review` console's real workers exist only in `fleet.yaml` — and the
   * word this sentence used to carry, "untracked", is now wrong: that file has
   * been TRACKED since 2026-09-12 by operator decision, so it is on every clean
   * checkout and in CI along with everything else. What has NOT changed is the
   * half that actually forces the fixture: `fleet.example.yaml` still never
   * declares `rev-arch-1`/`rev-ctx-1`/`rev-lang-1` (SRD §13, 1.5's note), and
   * the example is the config this whole file grades. So this resolves a fixture
   * shaped like that console rather than reaching for the live file — the
   * fixture is what keeps the assertion about the RESOLUTION CHAIN rather than
   * about which seats the operator's fleet happens to hold this week.
   */
  test("ISC-526: roles/reviewer.md still reaches three workers", async () => {
    const roleFile = join(REPO_ROOT, "roles", "reviewer.md");
    const lensFiles: Record<string, string> = {
      "rev-arch-1": join(REPO_ROOT, "roles", "review", "architecture-security.md"),
      "rev-ctx-1": join(REPO_ROOT, "roles", "review", "cross-file-contracts.md"),
      "rev-lang-1": join(REPO_ROOT, "roles", "review", "implementation-language.md"),
    };
    // Not `lensFiles[id]` inline: that is `string | undefined`, and a
    // `toContain(undefined)` on a roster that grew a fourth reviewer would
    // report a missing FILE rather than a missing MAPPING — the wrong defect,
    // pointing at the wrong file. Drift between the roster constant and this
    // map fails here, by name, before any config is written.
    const lensOf = (id: string): string => {
      const f = lensFiles[id];
      if (f === undefined) {
        throw new Error(
          `REVIEW_CONSOLE_ROSTER names reviewer "${id}" with no lens file in this fixture; ` +
            `known: ${Object.keys(lensFiles).join(", ")}`,
        );
      }
      return f;
    };

    const doc = baseDoc();
    doc["roles"] = { eng: {}, reviewer: { append_system_prompt_file: roleFile } };
    doc["workers"] = [
      { id: "w1", role: "eng" },
      ...REVIEW_CONSOLE_ROSTER.reviewers.map((id) => ({
        id,
        role: "reviewer",
        append_system_prompt_file: lensOf(id),
      })),
    ];
    const loaded = await writeAndLoad(doc);
    for (const id of REVIEW_CONSOLE_ROSTER.reviewers) {
      const files = resolveWorker(loaded, id)
        .briefing.filter((f) => f.kind === "file")
        .map((f) => f.value);
      expect(files, `${id} briefing files: ${JSON.stringify(files)}`).toContain(roleFile);
      expect(files).toContain(lensOf(id));
    }
  });

  /**
   * ISC-527 (anti). `assertDistinctThemes` above is what "no two attended
   * workers share a theme" now runs — this proves that when two DO collide,
   * the failure names the pair rather than only counting one.
   */
  test("ISC-527 (anti): a duplicated theme names the offending pair, not just the count", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const attended = resolveAllWorkers(loaded).filter((w) => w.paneMode === "tui");
    expect(() => assertDistinctThemes(attended)).not.toThrow();

    // Mutate one seat's theme onto another attended worker's — the exact
    // shape a copy-pasted worker line or a wrong theme after a rename would
    // produce.
    const mutated = attended.map((w, i) => (i === 0 ? { ...w, theme: attended[1]!.theme } : w));
    let caught: unknown;
    try {
      assertDistinctThemes(mutated);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(mutated[0]!.id);
    expect((caught as Error).message).toContain(attended[1]!.id);
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

/**
 * The `triage` console's seats, as configuration (SRD-TRIAGE-CONSOLE §6.1,
 * §12's configuration block, §13 tasks 1.3 and 1.4).
 *
 * THE TRAP THIS BLOCK IS WRITTEN AGAINST, named because falling into it makes
 * the whole block worthless: a criterion that only asserts "the two seats
 * resolve to `gemma-4-26b-a4b-it-bf16`" passes just as happily if someone deletes
 * the seats entirely, and an absence asserted over a filtered set is satisfied
 * by an empty set. So every assertion here is made against `TRIAGE_SEATS` —
 * a list this file NAMES — and the seats' presence is checked before their
 * properties are. A filter that never narrows anything survives every mutation.
 *
 * Everything runs against `fleet.example.yaml`. The reason given here used to be
 * that the operator's live `fleet.yaml` "is gitignored and CI has no copy, so it
 * cannot be read here" — THAT REASON IS DEAD as of 2026-09-12, when `fleet.yaml`
 * became tracked by operator decision, and it is named rather than quietly
 * deleted because a reader who takes it at face value will conclude this block
 * cannot do something it now plainly can.
 *
 * The choice survives on a different argument, which was always the better one:
 * `fleet.example.yaml` is the annotated reference copy — the artifact this
 * repository SHIPS and the one a new operator copies — so a suite that grades it
 * is asserting something about the product, where a suite grading the live file
 * would be asserting something about one machine's current fleet. The two files
 * still agree at the resolved level and disagree at the role level (the live one
 * reaches its weights through `gabe/`, the example through the bare oMLX ids),
 * and which of those this block can see is still the reason the override test
 * below is written the way it is. What changed is that the disagreement is now a
 * reviewable DIFF between two tracked files rather than an invisible drift —
 * which is precisely what tracking `fleet.yaml` was for.
 */
describe("the triage console's four seats, in two pairs (SRD-TRIAGE-CONSOLE §6.1, §12)", () => {
  /**
   * The example's two seats, resolved, in the order `TRIAGE_SEATS` names them.
   *
   * Throws BY NAME on a missing seat rather than yielding `undefined` into an
   * expectation, because the two defects want different edits: a seat resolving
   * to the wrong model is a `model:` line, and a seat that is not there at all
   * is a deleted worker entry. A `toEqual` against `undefined` reports the
   * first when it means the second.
   */
  function seatsOf(loaded: LoadedConfig): ResolvedWorker[] {
    const byId = new Map(resolveAllWorkers(loaded).map((w) => [w.id, w]));
    return TRIAGE_SEATS.map((id) => {
      const w = byId.get(id);
      if (w === undefined) {
        throw new Error(
          `${loaded.path} declares no worker "${id}" — the seat is GONE, not merely retuned. ` +
            `It holds: ${[...byId.keys()].join(", ")}`,
        );
      }
      return w;
    });
  }

  test("both resolve to the one local model on omlx (D1, arm 3)", async () => {
    // Anti-vacuity on the ENUMERATION itself. Every assertion in this block is
    // a walk over `TRIAGE_SEATS`, so a truncated or empty list would make all
    // of them pass while checking nothing.
    expect(TRIAGE_SEATS).toHaveLength(4);

    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    // ONE set-shaped comparison rather than four independent expectations: a
    // seat deleted, repointed at another provider, or left on another model all
    // fail here with the same readable diff, and the diff says which seat.
    expect(seatsOf(loaded).map((w) => `${w.id}=${w.provider}/${w.model}`)).toEqual(
      TRIAGE_SEATS.map((id) => `${id}=omlx/${TRIAGE_MODEL}`),
    );
  });

  /**
   * **This replaces a non-degeneracy guard that the file outgrew, and it is a
   * STRONGER assertion rather than a relaxed one (ISC-1116).**
   *
   * What stood here asserted that `llm.model` was NOT the triage model, and that
   * some other worker ran something else — anti-vacuity for the set comparison
   * above, so "the seats resolve to X" could not be true merely because
   * everything did. That premise was a property of a file with three local
   * models in it, and on 2026-09-09 the file stopped having them: every role
   * moved to `gemma-4-26b-a4b-it-bf16`, because a second local model in the
   * tracked example is the same collision ISC-1116 closed in CI — a cold load
   * beside the resident weights, which is what returned `stop_reason: "error"`
   * on a live seat mid-sweep.
   *
   * So the anti-vacuity moves to where the risk actually is. "The seats differ
   * from the default" was a PROXY for "the example does not stand up two sets of
   * weights"; this asserts the thing itself, and it fails on the drift the proxy
   * would have missed — a fourth role quietly acquiring its own local model
   * while the triage seats stay put.
   */
  test("the example names EXACTLY ONE local model, fleet-wide (ISC-1116)", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const workers = resolveAllWorkers(loaded);
    // Anti-vacuity on the walk itself: an empty fleet satisfies "one model".
    expect(workers.length).toBeGreaterThan(1);

    const local = workers.filter((w) => w.provider === "omlx");
    expect(local.length).toBeGreaterThan(1);
    expect([...new Set(local.map((w) => w.model))]).toEqual([TRIAGE_MODEL]);

    // The default is part of the surface: a role added tomorrow with no
    // `model:` inherits it, so a default off this model reintroduces the second
    // set of weights through the one line nobody edits.
    expect(loaded.config.llm.model).toBe(TRIAGE_MODEL);
    // And the allowlist is the ceiling `up` checks, so a stale entry there is a
    // standing permission for exactly what this test forbids.
    expect(loaded.config.llm.models_allowlist).toEqual([TRIAGE_MODEL]);
  });

  /**
   * §6.1's 2026-09-06 correction, as an assertion rather than as a paragraph.
   *
   * §6.11 says the three observers take the `observer` role's model unchanged,
   * with a worker-level override "only if arm 1 or 2 is taken" — and arm 3 was
   * taken. That sentence is written against the operator's live `fleet.yaml`,
   * where `observer` and `triage` name the SAME local model, so inheriting there
   * delivers arm 3 exactly. In THIS file the same role carried a different local
   * model, so inheriting here would have delivered something else, and the
   * override was what made the tracked example show the decision rather than a
   * model that merely shares its posture.
   *
   * TWO THINGS THIS PARAGRAPH USED TO SAY ARE WRONG, named here rather than
   * overwritten. It called `fleet.yaml` "untracked": that file has been TRACKED
   * since 2026-09-12, so both configs are on every checkout and in CI, and the
   * role-level difference between them is a reviewable diff rather than drift
   * only the operator's machine could see. And it identified the live `observer`
   * model as "the 20b", which stopped being true on 2026-09-09 when every oMLX
   * seat moved to Gemma-4-26B — the same move `TRIAGE_MODEL`'s own note at the
   * head of this file records. Neither correction touches the argument: the
   * example is still the file this test reads, for the reason the block header
   * gives, and the override is still gone for the reason stated below.
   *
   * IF THIS FAILS BECAUSE THE EXAMPLE'S `observer` ROLE BECAME THE 20b, the fix
   * is to DELETE the three overrides, not to loosen the test: the two files
   * would then agree at the role level and the override would be the thing that
   * is wrong. That is the only shape of role-level drift between the two files
   * this suite can see, and it can see it only in this direction.
   */
  test("no seat carries a worker-level model: — §6.11's rule, now unqualified", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));

    // The override this test used to REQUIRE on obs-t1 is gone, and the
    // paragraph above is why: it existed only because `observer` named a
    // different local model, and it does not any more. That deletion was this
    // test's own prescription — "the fix is to DELETE the three overrides, not
    // to loosen the test" — followed rather than argued with.
    const observerRoleModel = loaded.config.roles["observer"]?.model;
    expect(observerRoleModel).toBe(TRIAGE_MODEL);
    expect(loaded.config.roles["triage"]?.model).toBe(TRIAGE_MODEL);

    // §6.11 unqualified: the seats INHERIT. Set-shaped over the WHOLE worker
    // list so the copied-line defect — an override arriving on `obs-1` or
    // `tst-2` — fails here too, which is the half that still has teeth now that
    // the expected set is empty.
    const stated = loaded.config.workers
      .filter((w) => w.model !== undefined)
      .map((w) => `${w.id}=${w.model}`);
    expect(stated).toEqual([]);
  });

  /**
   * §12's `Anti: removing it from models_allowlist throws` — and the gap it
   * pins, which was MEASURED rather than imagined.
   *
   * `config validate` stops at `resolveAllWorkers` and never calls
   * `assertModelAllowed`. So before the triage model was added to this
   * file's `llm.models_allowlist`, the example validated CLEAN and `up` then
   * refused all four seats with `ModelNotAllowedError` — the operator told the
   * file was fine and then having it rejected, which is exactly what
   * `src/cli/commands/config.ts` argues against in its own words. That was
   * measured by hand against an in-memory copy and nothing re-ran it. This is
   * what re-runs it.
   *
   * The mutation is IN MEMORY. Nothing on disk is touched, so a failure here
   * cannot leave the repository holding a broken example.
   */
  describe("the allowlist entry is what admits the seats, not the model string", () => {
    /**
     * The loaded example with `entry` SUBSTITUTED for another name, rather than
     * removed.
     *
     * **Removal stopped being a valid mutation when the example went uniform,
     * and the reason is a real hazard rather than a test detail.** The allowlist
     * now holds exactly one entry, and `assertModelAllowed`'s own docblock is
     * explicit: *"A declared provider with an empty `models_allowlist`
     * constrains nothing."* So deleting the entry does not refuse the fleet — it
     * DISARMS THE GATE, and the old assertion here failed with "Received
     * function did not throw" rather than with a refusal. A one-line allowlist
     * is one deletion away from off.
     *
     * Substituting keeps the gate armed and tests what it is for: that it
     * discriminates on the NAME. That is the property `up` relies on.
     */
    function withAllowlistRepointed(loaded: LoadedConfig, entry: string): LoadedConfig {
      const allowlist = loaded.config.llm.models_allowlist;
      // A mutation that changes nothing proves nothing. If the entry is renamed,
      // or moves into a `providers.<name>.models_allowlist` block, this says so.
      expect(allowlist, `"${entry}" is not on llm.models_allowlist to begin with`).toContain(entry);
      const repointed = allowlist.map((m) => (m === entry ? "some-other-model-nobody-runs" : m));
      // The gate must still be ARMED after the mutation, or the test below is
      // measuring absence rather than refusal — which is exactly the trap the
      // removal-shaped mutation fell into.
      expect(repointed.length).toBeGreaterThan(0);
      return {
        ...loaded,
        config: { ...loaded.config, llm: { ...loaded.config.llm, models_allowlist: repointed } },
      };
    }

    /**
     * The hazard the substitution above sidesteps, asserted so it is a KNOWN
     * property of a one-model fleet rather than a surprise the next reader meets
     * as a green test that proves nothing.
     */
    test("an EMPTY allowlist disarms the gate — one entry is one deletion from off", async () => {
      const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
      expect(loaded.config.llm.models_allowlist).toHaveLength(1);
      const emptied: LoadedConfig = {
        ...loaded,
        config: { ...loaded.config, llm: { ...loaded.config.llm, models_allowlist: [] } },
      };
      // Not a refusal. Nothing throws, and every worker is admitted.
      expect(() => assertModelsAllowed(emptied, TRIAGE_SEATS)).not.toThrow();
      for (const w of resolveAllWorkers(emptied)) {
        expect(() => assertModelAllowed(emptied, w)).not.toThrow();
      }
    });

    test("unmutated, both are admitted — the gate is not refusing everything", async () => {
      const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
      expect(() => assertModelsAllowed(loaded, TRIAGE_SEATS)).not.toThrow();
    });

    test("strip the entry and the WHOLE fleet is refused", async () => {
      const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
      const mutated = withAllowlistRepointed(loaded, TRIAGE_MODEL);

      const errors = new Map<string, unknown>();
      for (const w of resolveAllWorkers(mutated)) {
        try {
          assertModelAllowed(mutated, w);
        } catch (err) {
          errors.set(w.id, err);
        }
      }

      // This used to read "EXACTLY the four seats are refused", and the set
      // equality was doing real work: the fleet ran three local models, so a
      // removal that reached every worker meant the mutation had emptied the
      // list rather than removed one entry. On 2026-09-09 the example went
      // uniform (ISC-1116) and the honest expectation is now the whole fleet.
      //
      // The anti-vacuity that assertion carried moves rather than evaporates:
      // `withoutAllowlistEntry` already refuses to run if the entry is not on
      // the list, and the fleet is asserted non-trivial here, so "everything
      // throws" cannot be satisfied by an empty roster or a no-op mutation.
      const all = resolveAllWorkers(mutated).map((w) => w.id);
      expect(all.length).toBeGreaterThan(1);
      expect([...errors.keys()].sort()).toEqual([...all].sort());

      for (const id of TRIAGE_SEATS) {
        const err = errors.get(id);
        expect(err, `${id} was not refused`).toBeInstanceOf(ModelNotAllowedError);
        // The typed refusal naming the model, not an incidental throw from
        // somewhere else in the resolve that happens to land on the same ids.
        expect((err as ModelNotAllowedError).model).toBe(TRIAGE_MODEL);
        expect((err as ModelNotAllowedError).exitCode).toBe(EXIT.USAGE);
      }
    });

    test("`up` is where it lands, and `config validate` never sees it", async () => {
      const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
      const mutated = withAllowlistRepointed(loaded, TRIAGE_MODEL);
      // `up`'s own gate, not only the per-worker assertion underneath it.
      expect(() => assertModelsAllowed(mutated, TRIAGE_SEATS)).toThrow(ModelNotAllowedError);
      // The measured gap, asserted so it stops being folklore: the same mutated
      // config RESOLVES clean, and resolving is all `config validate` does. The
      // allowlist entry is the only thing standing between a file that
      // validates and a fleet that refuses to start.
      expect(() => resolveAllWorkers(mutated)).not.toThrow();
    });
  });

  /**
   * §12 (freshness, anti): NO SEAT IN THIS CONSOLE RESOLVES TO `pane_mode: tui`.
   *
   * §2.3 is the argument. `tui` allocates no epoch; this console dispatches 288
   * times a day; without the `already_completed` fence a re-dispatched sweep
   * runs a second time — on the one console nobody is watching. It is also what
   * keeps layer 4 implementable: a `tui` seat cannot be recycled without a
   * terminal.
   *
   * The hazard §12 names is a COPIED WORKER LINE. This file already ships three
   * of the shape `{id: tst-2, role: tester, pane_mode: tui, theme: nord}`, and
   * one of them pasted into the triage block is the entire defect — which is
   * why the theme half is asserted here rather than left as decoration.
   */
  test("no seat in this console resolves to pane_mode: tui", async () => {
    const loaded = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    const seats = seatsOf(loaded);

    // THE ANTI-VACUITY THAT MAKES THIS AN ABSENCE WORTH ASSERTING. An absence
    // over an empty set is free: `tuiWorkerIds` SKIPS an id the config does not
    // define, so a file whose triage seats had been deleted would answer "no
    // tui seats" and pass. The four have to be present before their having no
    // keyboard means anything at all.
    expect(seats.map((w) => w.id)).toEqual([...TRIAGE_SEATS]);
    expect(seats.map((w) => `${w.id}=${w.paneMode}`)).toEqual(
      TRIAGE_SEATS.map((id) => `${id}=rpc`),
    );

    // Through the function `up` actually uses to decide who gets a terminal,
    // rather than only through the resolved field that function reads.
    expect(tuiWorkerIds(loaded, TRIAGE_SEATS)).toEqual([]);
    // …and that function still NARROWS. The example does ship attended panes,
    // so the empty answer above is a fact about these seats and not about a
    // helper that returns nothing for everybody.
    expect(tuiWorkerIds(loaded, loaded.config.workers.map((w) => w.id)).length).toBeGreaterThan(0);

    // No theme either (§6.1). A palette on a pane nobody types at is the
    // visible half of the copied line, and it is the half a reviewer notices.
    expect(seats.filter((w) => w.theme !== undefined).map((w) => `${w.id}=${w.theme}`)).toEqual([]);
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
 * ISC-405 / SRD-INFERENCE-PROVIDERS §2.4 "Defect C", D12 — a tag-style
 * provider's `:tag` is not eaten by the thinking-suffix parser.
 *
 * Some vendors spell a model id `name:tag`; Ollama's whole catalogue does
 * (`gpt-oss:120b`, `qwen3.5:397b`). The six thinking levels are ordinary words
 * in a namespace the VENDOR owns, so a tag that collides is a rename away.
 * Measured on the unfixed code, `ollama/some-model:high` resolved to model
 * `some-model` with thinking `high` — the tag gone and a level invented from
 * it — and the failure surfaces at the far end as `model-not-found` against a
 * name the operator can read back off their `fleet.yaml` and see is correct.
 *
 * BOTH DIRECTIONS ARE GRADED, and that is the point of the block rather than
 * thoroughness for its own sake: a suite that only asserts the flag-ON case
 * cannot tell "reads the flag" apart from "never strips a suffix", and one
 * that only asserts flag-OFF cannot tell it from "always strips". Either
 * single-sided half passes under an implementation that ignores the argument
 * entirely, which is precisely the mutation this criterion exists to catch.
 */
/**
 * A NON-EMPTY `model:` that resolves to an EMPTY model.
 *
 * `schema.ts` enforces `.min(1)` on the raw string, so this looks covered and
 * is not: `omlx/` and `:high` are both non-empty and both decompose to `""`,
 * because the prefix split and the thinking strip each consume their side and
 * leave nothing between them.
 *
 * The reason it is a refusal rather than a warning is what happened next.
 * `PIFLEET_LLM_MODELS=""` makes the entrypoint's `[ -n ... ]` guard false, so
 * NO `models.json` is written at all — exit 0, nothing on stderr — while argv
 * still carries `--model ""`. Nothing in `src/` reads the rendered file back
 * and the container is `--rm`, so from the host "no file", "empty key" and
 * "wrong provider" are indistinguishable. The only thing in front of it,
 * `assertModelsSupportToolCalls`, returns early when
 * `require_native_tool_calls: false`, which is supported — and then the fleet
 * comes up clean and can reach no model at all, from a one-character typo.
 */
describe("a model that resolves to nothing is refused, not shipped", () => {
  for (const bad of ["omlx/", ":high", "omlx/:high"]) {
    test(`model: ${JSON.stringify(bad)} is refused at resolve time`, async () => {
      const loaded = await writeAndLoad({ ...baseDoc(), llm: { model: bad } });
      expect(() => resolveWorker(loaded, "w1")).toThrow(/resolves to an empty model name/);
    });
  }

  test("a normal model still resolves — the guard is not swallowing everything", async () => {
    // Anti-vacuity: a refusal that fired on every input would pass the three
    // cases above and break every fleet in the repo.
    const loaded = await writeAndLoad({ ...baseDoc(), llm: { model: "omlx/gpt-oss:120b" } });
    const w = resolveWorker(loaded, "w1");
    expect(w.model).toBe("gpt-oss:120b");
    expect(w.provider).toBe("omlx");
  });
});

// ---------------------------------------------------------------------------
// `llm.providers` — the map (SRD-INFERENCE-PROVIDERS §6.1, §6.2)
// ---------------------------------------------------------------------------

/** A complete, minimal provider block. Tests override pieces of it. */
function providerBlock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hosted: false,
    base_url: "http://omlx.pifleet.internal:8000/v1",
    api_key_env: "OMLX_API_KEY",
    ...over,
  };
}

/** `baseDoc()` with an `llm:` block carrying a provider map. */
function docWithProviders(
  providers: Record<string, unknown>,
  llmOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...baseDoc(),
    llm: { model: "DefaultModel", providers, ...llmOver },
  };
}

describe("a provider block describes one endpoint (§6.2)", () => {
  test("two providers load, and each block keeps its own values", async () => {
    const loaded = await writeAndLoad(
      docWithProviders({
        omlx: providerBlock({ models_allowlist: ["Qwen3.5-35B-A3B-8bit"] }),
        "ollama-cloud": providerBlock({
          hosted: true,
          base_url: "https://ollama.com/v1",
          relay_upstream: "ollama.com:443",
          api_key_env: "OLLAMA_API_KEY",
          models_allowlist: ["gpt-oss:120b"],
          tag_style: true,
        }),
      }),
    );
    const p = loaded.config.llm.providers;
    expect(Object.keys(p ?? {})).toEqual(["omlx", "ollama-cloud"]);
    expect(p?.["ollama-cloud"]).toMatchObject({
      hosted: true,
      base_url: "https://ollama.com/v1",
      relay_upstream: "ollama.com:443",
      api_key_env: "OLLAMA_API_KEY",
      models_allowlist: ["gpt-oss:120b"],
      tag_style: true,
    });
    // The two blocks do not bleed into each other: this is the whole point of
    // the map, and a shared-object bug would show here and nowhere else.
    expect(p?.omlx?.hosted).toBe(false);
    expect(p?.omlx?.tag_style).toBe(false);
    expect(p?.omlx?.api_key_env).toBe("OMLX_API_KEY");
  });

  test("the optional fields default, and the defaults are the flat keys' meanings", async () => {
    const loaded = await writeAndLoad(docWithProviders({ omlx: providerBlock() }));
    expect(loaded.config.llm.providers?.omlx).toMatchObject({
      relay_upstream: null,
      models_allowlist: [],
      tag_style: false,
    });
  });

  /**
   * `base_url` and `api_key_env` are REQUIRED in a block, and this is the test
   * that says the flat defaults were not quietly copied down.
   *
   * Every flat default describes oMLX on the operator's own machine. A hosted
   * provider that omitted `api_key_env` and inherited `OMLX_API_KEY` would send
   * the operator's own model-server credential to someone else's endpoint —
   * §6.2's "two endpoints cannot share a credential", arrived at by silence
   * rather than by decision.
   */
  test("a block that omits base_url or api_key_env is refused, not defaulted", async () => {
    await expectIssue(
      docWithProviders({ omlx: { hosted: false, api_key_env: "OMLX_API_KEY" } }),
      "llm.providers.omlx.base_url",
    );
    await expectIssue(
      docWithProviders({ omlx: { hosted: false, base_url: "http://x:1/v1" } }),
      "llm.providers.omlx.api_key_env",
    );
  });

  test("an unknown key inside a block is refused", async () => {
    await expectIssue(
      docWithProviders({ omlx: providerBlock({ base_urls: "typo" }) }),
      "llm.providers.omlx.base_urls",
    );
  });

  test("base_url inside a block is held to the same http/https narrowing", async () => {
    await expectIssue(
      docWithProviders({ omlx: providerBlock({ base_url: "file:///etc/passwd" }) }),
      "llm.providers.omlx.base_url",
      "http: or https:",
    );
  });
});

describe("hosted is declared, never inferred (D3)", () => {
  test("a block without `hosted` is refused, naming the field", async () => {
    await expectIssue(
      docWithProviders({ omlx: { base_url: "http://x:1/v1", api_key_env: "OMLX_API_KEY" } }),
      "llm.providers.omlx.hosted",
      "never inferred",
    );
  });

  /**
   * The measured reason, as a test rather than as a paragraph.
   *
   * §6.1: the operator's own tunnel is `https:`, publicly resolvable, on a
   * public address, and emphatically NOT hosted — it is §5.9's third permitted
   * private shape. Every inference available reads this fixture as hosted, so
   * an implementation that guessed would classify the one shape §5.9 spent an
   * amendment establishing exactly backwards. Here it must still be asked.
   */
  test("a public https URL on a public hostname is still not inferred", async () => {
    await expectIssue(
      docWithProviders({
        omlx: { base_url: "https://inference.agileguy.ca/v1", api_key_env: "OMLX_API_KEY" },
      }),
      "llm.providers.omlx.hosted",
    );
    // And the operator's answer for that shape is accepted: `false` on a public
    // https endpoint is a legal, meaningful configuration, not a contradiction.
    const loaded = await writeAndLoad(
      docWithProviders({
        omlx: {
          hosted: false,
          base_url: "https://inference.agileguy.ca/v1",
          api_key_env: "OMLX_API_KEY",
        },
      }),
    );
    expect(loaded.config.llm.providers?.omlx?.hosted).toBe(false);
  });

  test("`hosted` will not take a string", async () => {
    await expectIssue(
      docWithProviders({ omlx: providerBlock({ hosted: "true" }) }),
      "llm.providers.omlx.hosted",
    );
  });
});

/**
 * D9 (§6.7) — a hostname upstream is permitted in ONE place, and the scoping is
 * the whole of the decision.
 *
 * The IP-literal rule is measured, not stylistic: the relay publishes
 * `base_url`'s host as an alias on the bridge it is itself attached to, so a
 * hostname upstream matching a published alias resolves to the relay ITSELF and
 * every forwarded connection loops back into its own listener — a hang, on the
 * one path a fleet cannot run without, with nothing in `docker logs` saying why.
 *
 * D9 relaxes it only where the address belongs to somebody else: a vendor
 * behind a global load balancer with no published range, where `up` resolves
 * the name on the HOST and stamps the literal into the target. §6.7 is explicit
 * that this "cannot spread" — a non-hosted block still refuses a hostname at
 * `config validate`, so the stronger property is ENFORCED rather than merely
 * the default, and an operator cannot opt their own oMLX into the weaker one.
 *
 * That last sentence is the one these tests exist to hold. Without them the
 * relaxation is one careless edit from applying everywhere.
 */
describe("a hostname upstream is a hosted-only relaxation (D9)", () => {
  test("a NON-hosted block refuses a hostname upstream", async () => {
    await expectIssue(
      docWithProviders({
        omlx: providerBlock({ hosted: false, relay_upstream: "ollama.com:443" }),
      }),
      "llm.providers.omlx.relay_upstream",
      "is a hostname",
    );
  });

  test("a hosted block accepts the same hostname", async () => {
    // Anti-vacuity for the refusal above: a rule that refused every upstream,
    // or one that never ran at all and let `.strict()` do the work, would pass
    // that test and fail this one.
    const loaded = await writeAndLoad(
      docWithProviders(
        {
          omlx: providerBlock(),
          "ollama-cloud": providerBlock({
            hosted: true,
            base_url: "https://ollama.com/v1",
            api_key_env: "OLLAMA_API_KEY",
            relay_upstream: "ollama.com:443",
          }),
        },
        { provider: "omlx" },
      ),
    );
    expect(loaded.config.llm.providers?.["ollama-cloud"]?.relay_upstream).toBe("ollama.com:443");
  });

  test("`hosted: true` relaxes ONE clause, not the whole validator", async () => {
    // The shape rules are the reason this is a flag on the existing validator
    // rather than a second one. A hosted block still needs an explicit port and
    // a well-formed host; only the "must be an IP literal" clause is lifted.
    for (const bad of ["ollama.com", "ollama.com:0", "ollama.com:99999", "ollama.com:443/v1"]) {
      await expectIssue(
        docWithProviders(
          {
            omlx: providerBlock(),
            "ollama-cloud": providerBlock({
              hosted: true,
              base_url: "https://ollama.com/v1",
              api_key_env: "OLLAMA_API_KEY",
              relay_upstream: bad,
            }),
          },
          { provider: "omlx" },
        ),
        "llm.providers.ollama-cloud.relay_upstream",
      );
    }
  });

  test("an IP literal is still accepted on a non-hosted block", async () => {
    // Anti-vacuity: without this, a per-provider check that refused every
    // upstream would satisfy the refusal test and break every LAN-peer fleet.
    const loaded = await writeAndLoad(
      docWithProviders({ omlx: providerBlock({ relay_upstream: "192.168.86.49:8000" }) }),
    );
    expect(loaded.config.llm.providers?.omlx?.relay_upstream).toBe("192.168.86.49:8000");
  });

  test("the FLAT relay_upstream keeps the strict rule — there is no flat `hosted`", async () => {
    // The flat keys are the legacy single-provider shorthand and carry no
    // `hosted` declaration, so there is nothing that could authorize the
    // relaxation for them. A hostname there stays refused.
    await expectIssue(
      { ...baseDoc(), llm: { model: "DefaultModel", relay_upstream: "ollama.com:443" } },
      "llm.relay_upstream",
      "is a hostname",
    );
  });
});

/**
 * ISC-420 — `require_native_tool_calls` has no per-provider override.
 *
 * The key is DECLARED in `ProviderSchema` purely so this refusal can explain
 * itself; `.strict()` would already reject it, with the same "unrecognized key"
 * an operator gets for a typo. §6.8: the field states what the FLEET will
 * tolerate, and a per-provider opt-out is exactly how a hosted provider would
 * quietly leave a gate the SRD calls mandatory.
 */
describe("require_native_tool_calls is fleet-wide, and the schema says so (ISC-420)", () => {
  for (const value of [true, false]) {
    test(`\`require_native_tool_calls: ${value}\` inside a provider entry is refused`, async () => {
      await expectIssue(
        docWithProviders({ omlx: providerBlock({ require_native_tool_calls: value }) }),
        "llm.providers.omlx.require_native_tool_calls",
        "fleet-wide",
      );
    });
  }

  test("the refusal explains the scope rather than reading as a typo", async () => {
    // The whole reason the key is declared instead of left to `.strict()`. A
    // message that said "unrecognized key" would send an operator looking for a
    // misspelling of a field that is spelled correctly.
    try {
      await writeAndLoad(docWithProviders({ omlx: providerBlock({ require_native_tool_calls: false }) }));
    } catch (err) {
      const hit = (err as ConfigValidationError).issues.find(
        (i) => i.path === "llm.providers.omlx.require_native_tool_calls",
      );
      expect(hit?.message).not.toContain("nrecognized key");
      expect(hit?.message).toContain("no per-provider override");
      return;
    }
    throw new Error("a per-provider require_native_tool_calls was accepted");
  });

  test("anti-vacuity: it is still settable at the fleet level, beside a provider map", async () => {
    // Without this, the refusal above would also pass if the key had simply
    // been banned everywhere, which would break every existing fleet.
    const loaded = await writeAndLoad(
      docWithProviders({ omlx: providerBlock() }, { require_native_tool_calls: false }),
    );
    expect(loaded.config.llm.require_native_tool_calls).toBe(false);
    expect(loaded.config.llm.providers?.omlx).not.toHaveProperty("require_native_tool_calls");
  });
});

/**
 * The per-provider `api_key_env` carries the SAME guard as the flat one.
 *
 * This is the failure this change was most likely to introduce. The flat field
 * got `ENV_VAR_NAME_RE`/`RESERVED_ENV_PREFIXES`/`RESERVED_ENV_NAMES` exactly one
 * commit before `llm.providers` existed, and it got them because the hole was
 * MEASURED: `api_key_env: PIFLEET_LLM_MODELS` parsed, and the credential was
 * then written into `models.json` as a model id, on a named volume outliving
 * the container's `--rm`, with `missingApiKey` false and the ISC-31 test still
 * green. Adding a second, unguarded door into the same namespace would have
 * reopened that hole one commit after closing it — and reopened it for hosted
 * providers, whose keys are the ones worth stealing.
 *
 * The candidates are DERIVED from the exported constants rather than listed, so
 * a fourth reserved prefix added later cannot be guarded on the flat side and
 * forgotten on this one.
 */
describe("the api_key_env guard applies inside a provider block too", () => {
  const reserved = [
    ...RESERVED_ENV_PREFIXES.map((p) => `${p}SOMETHING`),
    ...RESERVED_ENV_NAMES,
  ];
  const malformed = ["9LIVES", "MY-KEY", "MY KEY", "MY.KEY", ""];

  test("the derived candidate list is not empty", () => {
    // Anti-vacuity: an empty list would make every loop below a no-op that
    // reports green, which is the exact shape of a guard that stopped running.
    expect(reserved.length).toBeGreaterThanOrEqual(10);
    expect(reserved).toContain("PIFLEET_SOMETHING");
    expect(reserved).toContain("PATH");
  });

  for (const name of [
    ...RESERVED_ENV_PREFIXES.map((p) => `${p}SOMETHING`),
    ...RESERVED_ENV_NAMES,
    "9LIVES",
    "MY-KEY",
  ]) {
    test(`api_key_env: ${JSON.stringify(name)} is refused inside a provider entry`, async () => {
      await expectIssue(
        docWithProviders({ omlx: providerBlock({ api_key_env: name }) }),
        "llm.providers.omlx.api_key_env",
      );
    });
  }

  test("both doors refuse the same set — neither is guarded alone", async () => {
    // The structural assertion. Each candidate is put through the FLAT field
    // and the PER-PROVIDER field and both must refuse it; a guard applied to
    // one spelling only fails here rather than in production.
    for (const name of [...reserved, ...malformed]) {
      const flat = LlmSchema.safeParse({ model: "m", api_key_env: name });
      const nested = LlmSchema.safeParse({
        model: "m",
        providers: { omlx: providerBlock({ api_key_env: name }) },
      });
      expect(flat.success, `flat api_key_env accepted ${JSON.stringify(name)}`).toBe(false);
      expect(nested.success, `provider api_key_env accepted ${JSON.stringify(name)}`).toBe(false);
    }
  });

  test("anti-vacuity: a well-formed, unreserved name is accepted on both", async () => {
    // Without this, a guard that refused every string would pass every
    // assertion above and break every fleet in the repo.
    expect(LlmSchema.safeParse({ model: "m", api_key_env: "OLLAMA_API_KEY" }).success).toBe(true);
    const loaded = await writeAndLoad(
      docWithProviders({ omlx: providerBlock({ api_key_env: "OLLAMA_API_KEY" }) }),
    );
    expect(loaded.config.llm.providers?.omlx?.api_key_env).toBe("OLLAMA_API_KEY");
  });

  test("the refusal message names the reserved namespace, not just the field", async () => {
    await expectIssue(
      docWithProviders({ omlx: providerBlock({ api_key_env: "PIFLEET_LLM_MODELS" }) }),
      "llm.providers.omlx.api_key_env",
      "PIFLEET_",
    );
  });
});

/**
 * ISC-403 — the flat keys and the map cannot both spell one provider.
 *
 * §6.1 keeps the flat keys accepted, meaning "the block for `llm.provider`", so
 * an existing `fleet.yaml` needs no edit. Writing both is a refusal rather than
 * a merge: whichever spelling lost would sit in the file looking authoritative,
 * and two constants that quietly disagree is what ISC-264 cost a rename to find.
 */
describe("a flat key and a providers entry for the same provider is refused (ISC-403)", () => {
  const flatValues: Record<string, unknown> = {
    base_url: "http://omlx.pifleet.internal:8000/v1",
    relay_upstream: "host.docker.internal:8000",
    api_key_env: "OMLX_API_KEY",
    models_allowlist: ["m"],
  };

  for (const [key, value] of Object.entries(flatValues)) {
    test(`llm.${key} beside llm.providers.omlx is refused`, async () => {
      await expectIssue(
        docWithProviders({ omlx: providerBlock() }, { [key]: value }),
        `llm.${key}`,
        "two spellings of one value",
      );
    });
  }

  test("the refusal names BOTH spellings, so the operator knows what to delete", async () => {
    try {
      await writeAndLoad(
        docWithProviders({ omlx: providerBlock() }, { base_url: "http://x:1/v1" }),
      );
    } catch (err) {
      const hit = (err as ConfigValidationError).issues.find((i) => i.path === "llm.base_url");
      expect(hit?.message).toContain("llm.base_url");
      expect(hit?.message).toContain("llm.providers.omlx.base_url");
      return;
    }
    throw new Error("a flat key beside its own provider entry was accepted");
  });

  /**
   * The collision is detected on the RAW document, and this is the test that
   * proves it. Every flat key has a default, so an implementation that checked
   * the PARSED object would see `base_url` present on every fleet ever written
   * and refuse them all — or, checking for inequality against the default
   * instead, would let an operator who writes the default value verbatim
   * through while refusing the operator who writes anything else.
   */
  test("writing the flat key's own DEFAULT value is still a collision", async () => {
    await expectIssue(
      docWithProviders({ omlx: providerBlock() }, { api_key_env: "OMLX_API_KEY" }),
      "llm.api_key_env",
      "two spellings of one value",
    );
  });

  test("explicit `relay_upstream: null` counts as written", async () => {
    // `null` is the documented "derive it" spelling, not an absence, and next
    // to a block that sets a real upstream the two disagree — which is the
    // whole hazard. Absence is how an operator says nothing.
    await expectIssue(
      docWithProviders(
        { omlx: providerBlock({ relay_upstream: "host.docker.internal:8000" }) },
        { relay_upstream: null },
      ),
      "llm.relay_upstream",
    );
  });

  test("anti-vacuity: the flat keys alone, with no map, still load unchanged", async () => {
    // §6.1's compatibility rule. If this ever fails, every existing fleet.yaml
    // in the wild has been broken by the map.
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: {
        model: "DefaultModel",
        base_url: "http://omlx.pifleet.internal:8000/v1",
        api_key_env: "OMLX_API_KEY",
        models_allowlist: ["DefaultModel"],
      },
    });
    expect(loaded.config.llm.base_url).toBe("http://omlx.pifleet.internal:8000/v1");
    expect(loaded.config.llm.providers).toBeUndefined();
  });

  test("a fleet-wide key beside a map is not a collision", async () => {
    // `provider`, `model` and `thinking` are fleet defaults, not endpoint
    // descriptions, so they sit beside the map by design. A collision check
    // that keyed on "any llm key" would refuse every multi-provider fleet.
    const loaded = await writeAndLoad(
      docWithProviders({ omlx: providerBlock() }, { provider: "omlx", thinking: "high" }),
    );
    expect(loaded.config.llm.provider).toBe("omlx");
    expect(loaded.config.llm.thinking).toBe("high");
  });
});

describe("the fleet default must name a declared provider", () => {
  test("llm.provider naming nothing in the map is refused at the field", async () => {
    await expectIssue(
      docWithProviders({ "ollama-cloud": providerBlock({ hosted: true }) }, { provider: "omlx" }),
      "llm.provider",
      "ollama-cloud",
    );
  });

  test("the DEFAULTED provider is checked too, not only a written one", async () => {
    // `llm.provider` defaults to `omlx`. A fleet that declares only a hosted
    // provider and never writes `provider:` is relying on that default, and
    // every unprefixed model in it resolves to an endpoint the document does
    // not describe — which is the failure, whether or not the operator typed
    // the word.
    await expectIssue(
      docWithProviders({ "ollama-cloud": providerBlock({ hosted: true }) }),
      "llm.provider",
    );
  });

  test("`providers: {}` is refused rather than read as 'no map'", async () => {
    await expectIssue(docWithProviders({}), "llm.provider");
  });

  test("anti-vacuity: no map at all is fine, and a map naming the default is fine", async () => {
    const bare = await writeAndLoad(baseDoc());
    expect(bare.config.llm.provider).toBe("omlx");
    const mapped = await writeAndLoad(
      docWithProviders({ "ollama-cloud": providerBlock({ hosted: true }) }, { provider: "ollama-cloud" }),
    );
    expect(mapped.config.llm.provider).toBe("ollama-cloud");
  });
});

describe("a provider key has to be usable as a name", () => {
  test("a key containing a slash is refused", async () => {
    // `decomposeModel` splits a `provider/model` prefix on the FIRST slash, so
    // `a/b` describes a provider no worker can name — and a model written
    // `a/b/m` resolves to provider `a`, silently.
    await expectIssue(
      docWithProviders({ "a/b": providerBlock() }, { provider: "a/b" }),
      "llm.providers.a/b",
      "first",
    );
  });

  for (const key of ["", "-leading", "has space"]) {
    test(`provider key ${JSON.stringify(key)} is refused`, async () => {
      await expectIssue(
        docWithProviders({ [key]: providerBlock() }, { provider: key }),
        `llm.providers.${key}`,
      );
    });
  }

  test("anti-vacuity: the names the SRD actually uses are accepted", async () => {
    const loaded = await writeAndLoad(
      docWithProviders(
        { omlx: providerBlock(), "ollama-cloud": providerBlock({ hosted: true }) },
        { provider: "omlx" },
      ),
    );
    expect(Object.keys(loaded.config.llm.providers ?? {}).sort()).toEqual(["ollama-cloud", "omlx"]);
  });
});

/**
 * ISC-405 — Defect C, closed, asserted end to end.
 *
 * ## What this block used to be
 *
 * A tripwire pinned to the BLOCKER's absence. ISC-405 says "on a `tag_style:
 * true` provider", and for two commits no such provider could be SPELLED —
 * first because the flag had no config surface, then because nothing in
 * production passed the predicate to `decomposeModel`. Both halves have
 * landed, both tripwires fired, and this is the positive assertion they
 * existed to force. That is the pattern working, not a formality: had the
 * guard simply been a passing test of `decomposeModel` in isolation, ISC-405
 * would have drifted green the day `llm.providers` merged and nobody would
 * have been told the headline had finally become checkable.
 *
 * ## What it asserts now
 *
 * The whole path, through `resolveWorker`, from a document. `decomposeModel`
 * being able to keep a tag was never the criterion; a fleet keeping it is.
 *
 * The negative direction carries the same weight as the positive one and is
 * the reason the flag exists per-provider rather than fleet-wide: on a
 * provider WITHOUT `tag_style`, `:low` is a thinking level and must still be
 * stripped. An implementation that kept every colon would satisfy the first
 * test here and silently break the six-level suffix every existing fleet
 * relies on.
 */
describe("a tag-style provider keeps its tag through the whole resolve (ISC-405)", () => {
  /** Two providers, identical but for the flag. The flag is the only variable. */
  function twoProviders(): Record<string, unknown> {
    return {
      omlx: {
        hosted: false,
        base_url: "http://omlx.pifleet.internal:8000/v1",
        api_key_env: "OMLX_API_KEY",
      },
      "ollama-cloud": {
        hosted: true,
        base_url: "https://ollama.com/v1",
        api_key_env: "OLLAMA_API_KEY",
        tag_style: true,
      },
    };
  }

  function fleet(model: string): Record<string, unknown> {
    return {
      ...baseDoc(),
      llm: { model, provider: "omlx", providers: twoProviders() },
    };
  }

  test("the tag survives, and no thinking level is invented from it", async () => {
    const loaded = await writeAndLoad(fleet("ollama-cloud/gpt-oss:high"));
    const w = resolveWorker(loaded, "w1");
    expect(w.provider).toBe("ollama-cloud");
    expect(w.model).toBe("gpt-oss:high");
    expect(w.thinking).toBeUndefined();
  });

  test("THE NEGATIVE HALF: the same suffix on a provider without the flag is a level", async () => {
    // `omlx` carries no `tag_style`, so this must decompose exactly as it
    // always did. A fix that kept every colon passes the test above and
    // destroys the thinking suffix for every fleet in this repo.
    const loaded = await writeAndLoad(fleet("omlx/some-model:high"));
    const w = resolveWorker(loaded, "w1");
    expect(w.provider).toBe("omlx");
    expect(w.model).toBe("some-model");
    expect(w.thinking).toBe("high");
  });

  test("the flag is per-provider within ONE fleet, not a fleet-wide mode", async () => {
    // Both readings, from the same document, decided by which provider the
    // worker resolves to. This is the assertion a fleet-wide boolean fails.
    const tagged = resolveWorker(await writeAndLoad(fleet("ollama-cloud/m:low")), "w1");
    const level = resolveWorker(await writeAndLoad(fleet("omlx/m:low")), "w1");
    expect(tagged.model).toBe("m:low");
    expect(tagged.thinking).toBeUndefined();
    expect(level.model).toBe("m");
    expect(level.thinking).toBe("low");
  });

  test("an explicit `thinking:` still applies to a tag-style model", async () => {
    // The tag is not a level, so the level has to come from somewhere — and
    // the merged `thinking:` key is that somewhere. A model whose tag was
    // preserved must not become a model that can never think.
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: {
        model: "ollama-cloud/gpt-oss:120b",
        provider: "omlx",
        thinking: "high",
        providers: twoProviders(),
      },
    });
    const w = resolveWorker(loaded, "w1");
    expect(w.model).toBe("gpt-oss:120b");
    expect(w.thinking).toBe("high");
  });

  test("with no providers map at all, nothing changes", async () => {
    // Every fleet written before this feature. The predicate answers false to
    // everything when there is no map, because there is no block to carry the
    // flag — so this is the pre-existing behaviour, unmodified.
    const loaded = await writeAndLoad({ ...baseDoc(), llm: { model: "omlx/m:high" } });
    const w = resolveWorker(loaded, "w1");
    expect(w.model).toBe("m");
    expect(w.thinking).toBe("high");
  });
});

describe("tag-style providers keep their :tag (ISC-405)", () => {
  /** The criterion's own probe, both ways round. */
  test("the flag decides whether `p/m:high` keeps its tag", () => {
    const tagged = decomposeModel("p/m:high", "omlx", undefined, () => true);
    expect(tagged.provider).toBe("p");
    expect(tagged.model).toBe("m:high");
    expect(tagged.thinking).toBeUndefined();

    const plain = decomposeModel("p/m:high", "omlx", undefined, () => false);
    expect(plain.provider).toBe("p");
    expect(plain.model).toBe("m");
    expect(plain.thinking).toBe("high");
  });

  test("omitting the predicate is exactly today's behaviour", () => {
    // Every existing caller passes three arguments and must keep its meaning
    // without an edit, so ABSENT has to mean "no provider is tag-style" —
    // not "unknown", and not a refusal.
    const spec = decomposeModel("p/m:high", "omlx", undefined);
    expect(spec.model).toBe("m");
    expect(spec.thinking).toBe("high");
  });

  test("the predicate is asked about the RESOLVED provider, not the fallback", () => {
    // The flag belongs to the provider the model actually names. An
    // implementation that consults the fleet default instead still passes the
    // one-provider tests above, and is wrong for every prefixed model — which
    // is the whole population this defect affects.
    const asked: string[] = [];
    decomposeModel("ollama/m:high", "omlx", undefined, (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual(["ollama"]);
  });

  test("the flag is per provider, not fleet-wide", () => {
    // D12's ruling is a per-provider opt-out: oMLX must be unaffected by a
    // hosted provider next to it in the same fleet. A predicate that answered
    // the same for both would satisfy neither half of §6.2's table.
    const isTagStyle = (p: string) => p === "ollama";
    expect(decomposeModel("ollama/m:high", "omlx", undefined, isTagStyle).model).toBe("m:high");
    expect(decomposeModel("omlx/m:high", "omlx", undefined, isTagStyle).model).toBe("m");
  });

  test("an unprefixed model is judged by the fallback provider's flag", () => {
    // `model: gpt-oss:120b` with no prefix resolves to `llm.provider`, so that
    // is the provider whose flag decides — otherwise the shorthand every
    // single-provider fleet uses would be the one spelling the fix misses.
    const spec = decomposeModel("m:high", "ollama", undefined, (p) => p === "ollama");
    expect(spec.provider).toBe("ollama");
    expect(spec.model).toBe("m:high");
    expect(spec.thinking).toBeUndefined();
  });

  test("a tag-style provider still honours the merged thinking: key", () => {
    // D12 names the cost plainly: the `:thinking` SUFFIX is unavailable on
    // these providers and the operator must use the key. Turning the suffix
    // off must not also discard the key — that would take away the only
    // remaining way to set the level.
    const spec = decomposeModel("p/m:high", "omlx", "low", () => true);
    expect(spec.model).toBe("m:high");
    expect(spec.thinking).toBe("low");
  });

  /**
   * The prefix is split BEFORE the suffix is stripped, which is a reordering
   * of the original body. It is behaviour-preserving rather than merely
   * believed to be, and this pins the one input where the two orders could
   * conceivably diverge: a colon sitting inside the PROVIDER segment.
   */
  test("a colon in the provider segment is untouched by either order", () => {
    const spec = decomposeModel("weird:high/m", "omlx", undefined);
    expect(spec.provider).toBe("weird:high");
    expect(spec.model).toBe("m");
    expect(spec.thinking).toBeUndefined();
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

  /** Resolve `w1` under a PROVIDER MAP, returning the assertion's outcome. */
  async function checkProvider(
    allowlist: string[],
    workerModel: string,
  ): Promise<Error | null> {
    const doc = docWithProviders(
      {
        omlx: providerBlock({ models_allowlist: allowlist }),
        "ollama-cloud": providerBlock({ hosted: true, base_url: "https://ollama.invalid/v1" }),
      },
      { provider: "omlx" },
    );
    doc["roles"] = { eng: { model: workerModel } };
    const loaded = await writeAndLoad(doc);
    try {
      assertModelAllowed(loaded, resolveWorker(loaded, "w1"));
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  /**
   * The gate is over a (provider, model) PAIR, and it was over half of one.
   *
   * `assertModelAllowed`'s own docblock says carrying a verdict across providers
   * "is not a widening of the rule, it is a different rule" — and then the
   * comparison decomposed each entry and kept `.model`, discarding the provider
   * it had just parsed. So an entry naming a foreign provider authorized its
   * bare model name here. Raised independently by the architecture and language
   * lenses on T-rv-155.
   *
   * `ollama-cloud` is declared in the map, so this is not a refusal about an
   * unknown provider leaking in from somewhere: it is a fully legal entry about
   * a DIFFERENT endpoint, which is exactly the case that must not carry.
   */
  test("an allowlist entry naming another provider does not authorize this one", async () => {
    const err = await checkProvider(["ollama-cloud/Qwen3"], "Qwen3");
    expect(err, "a foreign-provider entry admitted this provider's model").not.toBeNull();
    expect(String(err?.message)).toContain("Qwen3");
  });

  /**
   * Anti-vacuity, and the reason this is a filter rather than a refusal.
   *
   * The cheapest way to pass the test above is to refuse every prefixed entry,
   * or to compare the raw strings — both of which break the two spellings an
   * operator actually writes. A bare entry means THIS provider's model, and a
   * prefix naming this provider is the same statement written out.
   */
  test("a bare entry and a same-provider prefix both still authorize", async () => {
    expect(await checkProvider(["Qwen3"], "Qwen3"), "a bare entry stopped working").toBeNull();
    expect(
      await checkProvider(["omlx/Qwen3"], "Qwen3"),
      "a prefix naming this provider stopped working",
    ).toBeNull();
  });

  /**
   * A SLASH IS NOT ALWAYS A PROVIDER PREFIX, and the first version of the
   * provider filter forgot it.
   *
   * `mlx-community/Qwen3.5-35B-A3B-4bit` is one model id in the standard
   * MLX/HuggingFace repo-id form; `mlx-community` is an org, not an endpoint.
   * Filtering on the decomposed provider refused it, which is the case
   * `doctor-allowlist.test.ts` names "THE case that was broken" — broken a
   * second time by the fix for a different defect, and caught only because
   * that file already pinned it.
   *
   * Pinned HERE as well, from the allowlist ENTRY side rather than the
   * `model:` side, because that is the position the filter reads and the one
   * the other file does not exercise.
   */
  test("a repo-id entry whose prefix is not a declared provider still authorizes", async () => {
    expect(
      await checkProvider(["mlx-community/Qwen3"], "Qwen3"),
      "a HuggingFace repo-id entry was read as a foreign provider",
    ).toBeNull();
  });

  /**
   * `config validate` MAKES THIS REFUSAL TOO, and until 2026-09-08 it did not.
   *
   * The command's own docblock promises that "what passes here is exactly what
   * `up` will accept", on the reasoning that a `validate` printing `ok:` for a
   * config `up` then refuses "is worse than not having the command, because the
   * operator has been told the file is fine". `resolveAllWorkers` was the merge
   * half of that promise; the allowlist was the half nobody wired.
   *
   * MEASURED, and the symptom is why this is a test and not a note. `gemma4:31b`
   * was given to a reviewer seat with its `context_windows` entry and without
   * its `models_allowlist` line. `config validate` printed `ok:` and listed the
   * worker. The console script reported the pane respawned. `up` refused INSIDE
   * that pane, where nothing was reading, and the only visible symptom was
   * `status --all` showing eleven workers where there had been twelve — a seat
   * simply absent, with the reason on a surface already scrolled past.
   *
   * Run through `buildProgram` rather than by calling `assertModelAllowed`
   * again: the function was already correct and already covered, and what broke
   * was that nothing in this command CALLED it. A test that calls it directly
   * would have stayed green through the entire defect.
   */
  test("config validate refuses it too, not just up", async () => {
    const doc = baseDoc();
    doc["llm"] = { model: "DefaultModel", models_allowlist: ["Allowed-A"] };
    doc["roles"] = { eng: { model: "Sneaky-C" } };
    const dir = await tempDir();
    const path = join(dir, "fleet.yaml");
    await writeFile(path, stringify(doc));

    const program = buildProgram();
    registerConfigCommand(program);
    let thrown: unknown = null;
    try {
      await program.parseAsync(["config", "validate", "--config", path], { from: "user" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "config validate accepted a model up would refuse").not.toBeNull();
    expect(String((thrown as Error).message)).toContain("models_allowlist");
    expect(exitCodeForError(thrown)).toBe(EXIT.USAGE);
  }, cliBudget(1));

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

/**
 * Extension tool names in `tools:` (SRD-WORKER-DISPATCH-EXTENSION §6.6, §12).
 *
 * The hazard these guard is the one `PI_BUILTIN_TOOLS`' docblock was written
 * against, measured a second time on 2026-09-07 and found to hold for a second
 * class of name: `--tools read,bash,submit_report,does_not_exist` built a
 * registry of `read, bash, submit_report` and said nothing about the fourth
 * name. Widening `ToolNameSchema` to the union is what lets a role ASK for an
 * extension tool; keeping the union CLOSED is what makes asking wrongly loud.
 * A widening that dropped the enum would satisfy the first and lose the second,
 * which is why the misspelling below is asserted next to the acceptance.
 */
describe("extension tool declaration (§6.6)", () => {
  test("a role may request submit_report and it survives to the resolved worker", async () => {
    const doc = baseDoc();
    doc["roles"] = { rev: { tools: ["read", "grep", "submit_report"] } };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    const loaded = await writeAndLoad(doc);
    // Resolved, not merely parsed: `render.ts:260` joins THIS array into
    // `--tools`, so a name that validates but is dropped by the merge would be
    // the same silence with extra steps.
    expect(resolveWorker(loaded, "w1").tools).toEqual(["read", "grep", "submit_report"]);
  });

  /**
   * Driven off the constant rather than a hand-written list, so the name Phase
   * 5 adds (`get_replies`) is covered the day it becomes requestable instead of
   * the day someone remembers to extend this test.
   */
  test("every name in PI_EXTENSION_TOOLS is accepted in a tools list", async () => {
    expect(PI_EXTENSION_TOOLS.length).toBeGreaterThan(0);
    for (const name of PI_EXTENSION_TOOLS) {
      const doc = baseDoc();
      doc["roles"] = { rev: { tools: ["read", name] } };
      doc["workers"] = [{ id: "w1", role: "rev" }];
      const loaded = await writeAndLoad(doc);
      expect(resolveWorker(loaded, "w1").tools).toContain(name);
    }
  });

  test("a misspelled extension tool name is refused, naming the element", async () => {
    // `submit_reprot` is what the silence looks like from the operator's side:
    // Pi drops it from the registry and grants the worker nothing by that name.
    const doc = baseDoc();
    doc["roles"] = { rev: { tools: ["read", "submit_reprot"] } };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    await expectIssue(doc, "roles.rev.tools.1");
  });

  test("exclude_tools ranges over the same vocabulary, and refuses a misspelling", async () => {
    const ok = baseDoc();
    ok["roles"] = { rev: { exclude_tools: ["submit_report"] } };
    ok["workers"] = [{ id: "w1", role: "rev" }];
    const loaded = await writeAndLoad(ok);
    expect(resolveWorker(loaded, "w1").excludeTools).toEqual(["submit_report"]);

    const bad = baseDoc();
    bad["roles"] = { rev: { exclude_tools: ["submit_reprot"] } };
    bad["workers"] = [{ id: "w1", role: "rev" }];
    await expectIssue(bad, "roles.rev.exclude_tools.0");
  });

  /**
   * ANTI-CRITERION (§12, §6.6 interaction 1): ISC-59's default stays the
   * BUILT-IN set.
   *
   * This is asserted against the resolution itself and not through a fixture,
   * because there is no fixture that can see it. `PI_ALL_TOOLS` is a superset
   * of `PI_BUILTIN_TOOLS`, so a default swapped to the union leaves
   * `includes("bash")` true, every ISC-59 message byte-identical and every
   * existing rejection in place. §12's stated probe — "a role with
   * `read_only: true` and no `tools:`; assert the `bash` violation still
   * fires" — stays GREEN under the mutation it names, and was verified to do so
   * before this test was written. The behavioural test below is kept anyway,
   * because it is what proves the guard is still WIRED to this function; it is
   * simply not what makes the mutation red.
   */
  test("an omitted tools list resolves to the built-in set, never the union", () => {
    expect([...effectiveToolGrant(undefined)]).toEqual([...PI_BUILTIN_TOOLS]);
    for (const name of PI_EXTENSION_TOOLS) {
      // The whole of the mutation: a grant nobody made. An omitted `tools:`
      // means "Pi's own defaults", and Pi's own defaults cannot contain a tool
      // this repository invented — the extension's tools reach a worker only
      // when a role names one.
      expect(effectiveToolGrant(undefined)).not.toContain(name);
    }
    // A DECLARED list is still returned untouched, extension names included —
    // the default is the only thing narrowed.
    expect([...effectiveToolGrant(["read", "submit_report"])]).toEqual(["read", "submit_report"]);
  });

  test("a read_only role with no tools at all is still rejected for bash", async () => {
    // The case `effectiveToolGrant` exists for, and the one shape of the ISC-59
    // violation that had no test: the other three fixtures above all declare a
    // tools list somewhere, so none of them ever reaches the default.
    const doc = baseDoc();
    doc["roles"] = { rev: { read_only: true } };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    await expectIssue(doc, "roles.rev.tools", "no explicit tools");
  });

  /**
   * The re-inlining hole, closed by reading the file.
   *
   * The value assertion above cannot see a default that is re-inlined at the
   * call site — someone writing `declared ?? PI_ALL_TOOLS` back into the
   * refinement leaves `effectiveToolGrant` correct and unused, and every other
   * test in this file green. What is actually true of this codebase is
   * narrower and checkable: `PI_ALL_TOOLS` is the vocabulary the SCHEMA ranges
   * over, and it has exactly two code references — the declaration and the
   * `z.enum` it feeds. Any third one is either that mistake or a decision worth
   * a human reading this comment.
   *
   * Comment lines are excluded rather than counted: the docblocks in
   * `schema.ts` argue about `PI_ALL_TOOLS` at length, and a guard that goes red
   * when someone explains the invariant better is a guard that gets deleted.
   */
  test("PI_ALL_TOOLS widens the schema and nothing else", async () => {
    const text = await readFile(join(REPO_ROOT, "src", "config", "schema.ts"), "utf8");
    const refs = text
      .split("\n")
      .map((line, i) => ({ at: i + 1, text: line.trim() }))
      .filter((l) => /\bPI_ALL_TOOLS\b/.test(l.text))
      .filter((l) => !l.text.startsWith("*") && !l.text.startsWith("/*") && !l.text.startsWith("//"));
    const shown = refs.map((l) => `schema.ts:${l.at}  ${l.text}`).join("\n");
    const why =
      "PI_ALL_TOOLS is the vocabulary `tools:`/`exclude_tools:` range over, and nothing else.\n" +
      "In particular it is NOT what an omitted `tools:` resolves to: it is a superset of\n" +
      "PI_BUILTIN_TOOLS, so using it as ISC-59's default leaves every message and every\n" +
      "rejection identical while making the guard reason about a grant nobody made\n" +
      "(SRD-WORKER-DISPATCH-EXTENSION §6.6 interaction 1). References found:\n" +
      shown;
    expect(refs.length, why).toBe(2);
    expect(refs.filter((l) => /^export const PI_ALL_TOOLS\b/.test(l.text)), why).toHaveLength(1);
    expect(refs.filter((l) => /z\.enum\(PI_ALL_TOOLS\)/.test(l.text)), why).toHaveLength(1);
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
    doc["roles"] = { [OBSERVER_K8S_ROLE]: { pane_mode: "tui" } };
    doc["workers"] = [{ id: "obs-1", role: OBSERVER_K8S_ROLE }];
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
    doc["roles"] = { [OBSERVER_K8S_ROLE]: { pane_mode: "tui" } };
    doc["workers"] = [{ id: "obs-1", role: OBSERVER_K8S_ROLE }];
    // Must not throw, unlike the tui+oneshot / tui+headless refusals above.
    await writeAndLoad(doc);
  });

  test("pane_mode: tui on a DIFFERENT role's name raises nothing", async () => {
    // Keyed to the role name OBSERVER_K8S_ROLE — the hazard is a property of
    // what the observer-ops skill does, not a generic fact this schema can
    // derive from any read-only role.
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await writeAndLoad(doc);
    expect(observerTuiWorkers(loaded.config)).toEqual([]);
  });

  test("observer at pane_mode: rpc (the shipped default) raises nothing", async () => {
    const doc = baseDoc();
    doc["roles"] = { [OBSERVER_K8S_ROLE]: {} };
    doc["workers"] = [{ id: "obs-1", role: OBSERVER_K8S_ROLE }];
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

/**
 * §6.6 interaction 2: `submit_report` beside `write`.
 *
 * The combination is not an error and must never become one. §13's phase 6
 * adds `submit_report` to every role and removes nothing, and phase 7 removes
 * `write` one role at a time behind a full console cycle each — so a fleet is
 * REQUIRED to hold both for as long as phase 7 takes. What must not happen is
 * that it holds both silently: for `triage`, `collator` and `reviewer` the
 * second grant is the whole of what §6.3's layer 1 removes, and layer 1 is the
 * only one of the four layers that is a mechanism rather than a nudge.
 */
describe("submit_report beside write warns, never refuses (SRD-WORKER-DISPATCH-EXTENSION §6.6)", () => {
  /** The shipped observer's tools (`fleet.yaml:542`) with phase 6 applied. */
  const OBSERVER_TOOLS = ["read", "write", "bash", "grep", "find", "ls", "submit_report"];
  /** The shipped reviewer/collator/triage tools (`:695`, `:726`, `:839`), phase 6 applied. */
  const BASH_LESS_TOOLS = ["read", "write", "grep", "find", "ls", "submit_report"];

  /**
   * §12's acceptance hook, verbatim: *"the `observer` fixture; assert one
   * warning and zero errors, because the observer is the intended case."*
   *
   * Zero errors is asserted by `writeAndLoad` RESOLVING — every schema issue
   * in this file arrives as a thrown `ConfigValidationError`, so a document
   * that loads is a document with no issues at any path.
   */
  test("the observer's pairing warns, names the bash asymmetry, and still loads", async () => {
    const doc = baseDoc();
    doc["roles"] = { observer: { tools: OBSERVER_TOOLS } };
    doc["workers"] = [{ id: "obs-1", role: "observer" }];
    const loaded = await writeAndLoad(doc); // zero errors, or this throws
    const found = submitReportWriteWorkers(loaded.config);
    expect(found).toEqual([{ id: "obs-1", bash: true }]);
    const warning = submitReportWriteWarning(found);
    expect(warning).not.toBeNull();
    expect(warning).toContain("obs-1");
    // The observer belongs in the bash bucket, and the bucket's whole content
    // is the finding: there is nothing here to take away.
    expect(warning).toMatch(/bash can cat > a file/);
    expect(warning).toMatch(/a tool and not a capability/);
    // And it must not read as a refusal, because phase 6 IS this state.
    expect(warning).toMatch(/Not a refusal/);
  });

  /**
   * The seat the warning exists for. `reviewer` is the `rev-lang-1` seat — the
   * one whose recorded defect (§6.9, ISC-517) is a valid report that was never
   * delivered — and it holds no `bash`, so `write` is the entire difference
   * between layer 1 and no mechanism at all.
   */
  test("a bash-less seat is named as the forfeiting case, with the mechanism stated", async () => {
    const doc = baseDoc();
    doc["roles"] = { reviewer: { tools: BASH_LESS_TOOLS } };
    doc["workers"] = [{ id: "rev-1", role: "reviewer" }];
    const loaded = await writeAndLoad(doc);
    const found = submitReportWriteWorkers(loaded.config);
    expect(found).toEqual([{ id: "rev-1", bash: false }]);
    const warning = submitReportWriteWarning(found);
    expect(warning).toMatch(/Forfeited here, and removing write is the fix \(rev-1\)/);
    // The mechanism, not just the fact — this is the part a reader acts on.
    expect(warning).toMatch(/layer 1/);
    expect(warning).toMatch(/only way to create a file/);
    // The bash bucket must be ABSENT, not merely empty of ids: a reader told
    // "removing write takes away a tool and not a capability" about a seat
    // that holds no shell has been told the opposite of the truth.
    expect(warning).not.toMatch(/bash can cat > a file/);
  });

  /**
   * The asymmetric fixture, and the reason it is written out rather than
   * folded into the two above: with one worker per test, a `bash` flag that
   * was hardcoded, inverted, or read off the wrong tool would satisfy every
   * single-seat assertion in this block. Only a document holding one of each
   * can tell the two buckets apart.
   */
  test("a bash holder and a bash-less seat land in different buckets, in one document", async () => {
    const doc = baseDoc();
    doc["roles"] = {
      observer: { tools: OBSERVER_TOOLS },
      reviewer: { tools: BASH_LESS_TOOLS },
    };
    doc["workers"] = [
      { id: "obs-1", role: "observer" },
      { id: "rev-1", role: "reviewer" },
    ];
    const loaded = await writeAndLoad(doc);
    const found = submitReportWriteWorkers(loaded.config);
    expect(found).toEqual([
      { id: "obs-1", bash: true },
      { id: "rev-1", bash: false },
    ]);
    const warning = submitReportWriteWarning(found)!;
    expect(warning).toContain("2 worker(s)");
    const forfeitLine = warning.split("\n").find((l) => l.includes("Forfeited here"))!;
    const shellLine = warning.split("\n").find((l) => l.includes("bash can cat"))!;
    expect(forfeitLine).toContain("rev-1");
    expect(forfeitLine).not.toContain("obs-1");
    expect(shellLine).toContain("obs-1");
    expect(shellLine).not.toContain("rev-1");
  });

  /** §6.8's proposed rows — the state phase 7 is trying to reach. */
  test("submit_report with no write raises nothing", async () => {
    const doc = baseDoc();
    doc["roles"] = { reviewer: { tools: ["read", "grep", "find", "ls", "submit_report"] } };
    doc["workers"] = [{ id: "rev-1", role: "reviewer" }];
    const loaded = await writeAndLoad(doc);
    expect(submitReportWriteWorkers(loaded.config)).toEqual([]);
    expect(submitReportWriteWarning([])).toBeNull();
  });

  /**
   * Every role in `fleet.yaml` today, before phase 6. A warning that fired on
   * `write` alone would print on the shipped fleet from the moment it landed
   * and would name nothing anyone could act on.
   */
  test("write with no submit_report raises nothing — this is the pre-phase-6 fleet", async () => {
    const doc = baseDoc();
    doc["roles"] = { reviewer: { tools: ["read", "write", "grep", "find", "ls"] } };
    doc["workers"] = [{ id: "rev-1", role: "reviewer" }];
    const loaded = await writeAndLoad(doc);
    expect(submitReportWriteWorkers(loaded.config)).toEqual([]);
  });

  /**
   * `--exclude-tools` is a real subtraction Pi applies (`render.ts:261`), so a
   * declared-then-excluded `write` is not a grant. Warning about it would be a
   * false positive, and this warning's only currency is that it is read.
   */
  test("exclude_tools removes write for this check, not just from the argv", async () => {
    const doc = baseDoc();
    doc["roles"] = { reviewer: { tools: BASH_LESS_TOOLS, exclude_tools: ["write"] } };
    doc["workers"] = [{ id: "rev-1", role: "reviewer" }];
    const loaded = await writeAndLoad(doc);
    expect(submitReportWriteWorkers(loaded.config)).toEqual([]);
  });

  /**
   * Resolved three-level, for `paneModeIssues`' reason: either level can
   * complete the pair on its own, and a check that read only `roles:` would
   * miss a fleet that put its tool list in `defaults:` — which is exactly
   * where a phase 6 rollout is most tempted to put `submit_report`.
   */
  test("the pair inherited from defaults is found", async () => {
    const doc = baseDoc();
    doc["defaults"] = { tools: BASH_LESS_TOOLS };
    doc["roles"] = { rev: {} };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    const loaded = await writeAndLoad(doc);
    expect(submitReportWriteWorkers(loaded.config)).toEqual([{ id: "w1", bash: false }]);
  });

  test("a worker override that completes the pair against a narrowed role is found", async () => {
    const doc = baseDoc();
    doc["roles"] = { rev: { tools: ["read", "grep", "find", "ls", "submit_report"] } };
    doc["workers"] = [{ id: "w1", role: "rev", tools: BASH_LESS_TOOLS }];
    const loaded = await writeAndLoad(doc);
    expect(submitReportWriteWorkers(loaded.config)).toEqual([{ id: "w1", bash: false }]);
  });

  /**
   * §6.6 interaction 1, observed from the other end. An omitted `tools:`
   * resolves to Pi's own builtins — which carry `write` and cannot carry
   * `submit_report`, because an extension tool reaches a worker only when a
   * role names it. So the most common shape of a role block cannot reach this
   * warning at all, and it is `effectiveToolGrant`'s default that makes that
   * true rather than a filter written here.
   */
  test("an omitted tools: cannot pair, because no built-in is named submit_report", async () => {
    const doc = baseDoc();
    doc["roles"] = { rev: {} };
    doc["workers"] = [{ id: "w1", role: "rev" }];
    const loaded = await writeAndLoad(doc);
    expect(effectiveToolGrant(undefined)).toContain("write");
    expect(effectiveToolGrant(undefined)).not.toContain("submit_report");
    expect(submitReportWriteWorkers(loaded.config)).toEqual([]);
  });
});

/**
 * SRD-WORKER-DISPATCH-EXTENSION §13 task 7.4 — layer 1 stated as a criterion,
 * and §6.3 is explicit that it is the only one of the four layers that can be
 * asserted statically at all.
 *
 * ## The property, and why `bash` is the selector rather than an afterthought
 *
 * *"A bash-less role's resolved tools contain no writing verb but
 * `submit_report`."* The describe ABOVE pins Phase A, where holding both routes
 * merely warns. This is Phase B: for a role that has actually been narrowed,
 * the same shape is a fact the suite refuses to let go of.
 *
 * §6.8 is the reason the rule is conditioned on the shell instead of being
 * stated over every role. Removing `write` from a role that holds `bash` takes
 * away a tool and not a capability — `cat > /outbox/…` is still right there —
 * so asserting this of `sre`, `observer` or `ticketing` would be asserting
 * something both false and undesirable.
 *
 * ## What this can reach, and what it provably cannot
 *
 * §13's probe reads *"`resolveWorker` for `triage`, `collator`, `reviewer`"*,
 * and exactly ONE of those three is reachable that way from THE CONFIG THIS
 * BLOCK READS. That qualifier used to say "from a tracked file", which was a
 * true sentence while `fleet.yaml` was ignored and is a false one now: the live
 * file has been tracked since 2026-09-12 and declares seats for all three. The
 * scoping that actually holds is narrower, and was always the real one — every
 * assertion below goes through `example()`, which loads `fleet.example.yaml`,
 * because the example is the shipped reference this suite grades:
 *
 * - **`triage`** has a role and a seat (`tri-1`), so it resolves. It is also
 *   the one still holding `write`, because task 7.3 has not landed.
 * - **`reviewer`** has a role and **no seat IN THE EXAMPLE** — the `review`
 *   console's four workers are declared only in `fleet.yaml`, which is tracked
 *   as of 2026-09-12 but is still not the file this block loads. The ROLE arm
 *   below is its whole coverage here, and the worker arm structurally cannot
 *   provide any without pointing the block at a different config.
 * - **`collator`** is in neither the example's roles nor its workers, so
 *   nothing here can assert a thing about it; the last test is what makes its
 *   ARRIVAL a failure rather than a silence. Task 7.2 is marked as producing
 *   "no tracked diff" for this reason, and THAT half has expired: `fleet.yaml`
 *   declares both the `collator` role and `col-1`, and since 2026-09-12 an edit
 *   there is a reviewable diff like any other. The coverage gap described here
 *   is unchanged, because it was never about trackability — it is about the
 *   example being the file this block reads.
 *
 * A block written against the worker arm alone would therefore be one third of
 * itself while reading as the whole criterion — which is the ISC-572 shape, and
 * the reason both arms are here.
 */
describe("Phase B: a bash-less role holds no writer but submit_report (§13 task 7.4)", () => {
  /**
   * The bash-less roles that hold a writer, and which writers. **A tripwire,
   * not an allowance:** the test below asserts each exemption is still TRUE, so
   * the commit that narrows one of these turns this file red and cannot be
   * finished without deleting its entry — at which point the general assertion
   * above starts covering it with nobody having to remember that it should.
   *
   * THE MECHANISM HAS NOW WORKED IN BOTH DIRECTIONS IN ONE DAY, which is worth
   * recording because the second direction is the one nobody designs for.
   * Task 7.3 removed `triage`'s `write`, this file went red exactly as
   * intended, and the entry was deleted. Three sweeps later the grant came
   * back — `submit_report` writes the ENVELOPE and this role's actual product
   * is a second file, `/outbox/<task-id>/dispatch-request.json`, which the tool
   * has no route for — and the entry is back with it.
   *
   * So the exemption below is not "not yet narrowed". It is **narrowed, tried,
   * and reverted for a stated reason**, and the distinction is the whole value
   * of writing it down: the next person to read §13 task 7.3 will find a task
   * marked CLEARED whose acceptance cannot be met, and this is where they learn
   * why without re-running it.
   */
  /**
   * EMPTY, as of 2026-09-10 — and empty is the state this table is FOR.
   *
   * It held one entry, `triage: ["write"]`, from the reversal on 2026-09-09:
   * narrowed, `tri-1` composed a correct fan-out and got `Tool write not found`
   * three times, and sweeps 5 and 6 settled `success` having dispatched nothing
   * at all. That entry's own note said what would retire it — *"restoring the
   * invariant needs a `dispatch_request` tool, not a config edit"* — and that
   * tool now exists, so the entry is gone rather than amended.
   *
   * **An empty map does not make the tests below vacuous, and the assertion that
   * it is empty is what says so.** The per-entry loop is then a loop over
   * nothing, which is correct: every bash-less role is now covered by the
   * STRONGER criterion above it. If an exemption ever returns, it returns with
   * a comment naming the measurement that forced it, the way this one did.
   */
  const HOLDS_A_WRITER: Readonly<Record<string, readonly ToolName[]>> = {};

  async function example(): Promise<LoadedConfig> {
    return await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
  }

  type Cfg = LoadedConfig["config"];

  /**
   * A ROLE's resolved grant: `defaults ← role`, then `exclude_tools` subtracted.
   *
   * `exclude_tools` is a real subtraction Pi applies at the argv (`render.ts`),
   * so a declared-then-excluded `write` is not a grant and must not read as
   * one — the same correction the Phase A block above makes for its warning.
   */
  function roleGrant(cfg: Cfg, name: string): readonly ToolName[] {
    const role = cfg.roles[name];
    if (role === undefined) {
      throw new Error(
        `fleet.example.yaml declares no role "${name}" — it is GONE, not merely retooled. ` +
          `It holds: ${Object.keys(cfg.roles).join(", ")}`,
      );
    }
    const declared = role.tools ?? cfg.defaults?.tools;
    const excluded = role.exclude_tools ?? cfg.defaults?.exclude_tools ?? [];
    return effectiveToolGrant(declared).filter((t) => !excluded.includes(t));
  }

  /** The same, for a worker that has been through the full three-level resolve. */
  function workerGrant(w: ResolvedWorker): readonly ToolName[] {
    const excluded = w.excludeTools ?? [];
    return effectiveToolGrant(w.tools).filter((t) => !excluded.includes(t));
  }

  function bashLessRoles(cfg: Cfg): string[] {
    return Object.keys(cfg.roles)
      .filter((r) => !roleGrant(cfg, r).includes("bash"))
      .sort();
  }

  /**
   * THE ANTI-VACUITY THIS BLOCK RESTS ON, and it closes a specific hole rather
   * than a general one.
   *
   * Every assertion below is made over a FILTERED set, and a filter that
   * narrows to nothing satisfies an absence for free. The hole is not
   * hypothetical here: `effectiveToolGrant` resolves an OMITTED `tools:` to
   * every Pi builtin — `bash` included — so deleting one line from
   * `reviewer` would drop it out of the bash-less set entirely and take its
   * coverage with it, while looking like tidying. Naming the set is what turns
   * that into a failure. (ISC-59's `read_only: true` makes the same deletion a
   * parse error; two independent refusals, because this one is the one that
   * survives the flag being removed too.)
   */
  test("the example ships exactly two bash-less roles, and they are Phase 7's", async () => {
    const { config } = await example();
    expect(bashLessRoles(config)).toEqual(["reviewer", "triage"]);
  });

  test("a narrowed bash-less role holds no writer, and holds submit_report instead", async () => {
    const { config } = await example();
    const narrowed = bashLessRoles(config).filter((r) => !(r in HOLDS_A_WRITER));
    // By NAME, or every loop below is free. `triage` joined `reviewer` on
    // 2026-09-10 (task 7.3) once `dispatch_request` gave it a route to the one
    // file `submit_report` cannot reach — see HOLDS_A_WRITER, now empty.
    expect(narrowed).toEqual(["reviewer", "triage"]);

    for (const r of narrowed) {
      const grant = roleGrant(config, r);
      // Against schema.ts's own writer set, not a second copy written here: a
      // fourth writer added there must widen this criterion, not slip past it.
      expect(writeCapableIn(grant), `role "${r}" resolves a write-capable tool`).toEqual([]);
      // The "but submit_report" half, and it is load-bearing rather than
      // decorative. A bash-less role with no writer AND no submit_report cannot
      // produce result.json at all — outbox.ts only ever reads it — which is
      // the exact state that emptied a whole review console and is why `write`
      // was granted here in the first place. Take one away, the other must be
      // there.
      expect(grant, `role "${r}" has no route to write its envelope`).toContain("submit_report");
    }
  });

  test("a bash-less role that holds a writer holds EXACTLY the ones exempted", async () => {
    const { config } = await example();
    // ASSERTED BY VALUE, so the map's contents are a fact this suite states
    // rather than a shape it tolerates. Empty means task 7.4 is closed for every
    // bash-less role; a name appearing here again is a narrowing that was tried
    // and reverted, and it must arrive with the measurement that reverted it.
    expect(Object.keys(HOLDS_A_WRITER)).toEqual([]);

    for (const [r, writers] of Object.entries(HOLDS_A_WRITER)) {
      // An exemption for a role holding a shell would be excusing a rule that
      // never applied to it — §6.8 conditions the whole property on bash.
      expect(bashLessRoles(config), `"${r}" is exempted but is not bash-less`).toContain(r);
      expect(
        writeCapableIn(roleGrant(config, r)),
        `"${r}" no longer holds ${writers.join(", ")}. If that is deliberate, DELETE its ` +
          `HOLDS_A_WRITER entry and let the criterion above cover it — but read that entry ` +
          `first: this exact narrowing was tried on 2026-09-09 and reverted, because ` +
          `submit_report writes the envelope and this role's product is dispatch-request.json`,
      ).toEqual([...writers]);
    }
  });

  test("through resolveWorker, every bash-less SEAT obeys the same rule", async () => {
    const loaded = await example();
    const seats = resolveAllWorkers(loaded).filter((w) => !workerGrant(w).includes("bash"));

    // By NAME, for `seatsOf`'s reason above: a seat deleted and a seat retooled
    // want different edits, and an emptied filter reports neither.
    //
    // **ONE seat since 2026-09-13, and this assertion earned its wording.** It
    // read `["tri-1", "tri-2"]` while the console ran two collators; `tri-2` was
    // DELETED from the config when the console became one collator over three
    // observers. A count check would have said "2 became 1" and left open which
    // of the two failures it was — a seat removed, or a seat that quietly grew
    // `bash` and fell out of the filter. Naming them distinguishes those, and
    // that is exactly the distinction that mattered here.
    expect(seats.map((w) => w.id).sort()).toEqual(["tri-1"]);

    for (const w of seats) {
      const exempt = HOLDS_A_WRITER[w.role] ?? [];
      expect(writeCapableIn(workerGrant(w)), `seat "${w.id}" (role ${w.role})`).toEqual([...exempt]);
      expect(workerGrant(w), `seat "${w.id}" has no route to write its envelope`).toContain(
        "submit_report",
      );
    }
  });

  /**
   * `collator`'s absence, asserted so that its arrival is a failure.
   *
   * This is the one arm of §13's probe that no tracked file can satisfy, and
   * the honest thing to do with an unreachable criterion is to make the day it
   * becomes reachable loud. If a `collator` role or seat is ever added to the
   * example, this goes red and whoever added it has to bring it under the
   * assertions above — rather than the criterion silently continuing to cover
   * two roles out of three while claiming three.
   */
  test("collator is in neither the example's roles nor its seats — and arriving must fail", async () => {
    const { config } = await example();
    expect(Object.keys(config.roles)).not.toContain("collator");
    expect(config.workers.map((w) => w.role)).not.toContain("collator");
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

  /**
   * The WIRING, and it is a separate test because the schema-level block above
   * passes with `config validate` never calling either function.
   *
   * That is not hypothetical here: `submitReportWriteWarning` shipped in commit
   * 8310846 with five green tests and zero callers outside them, and stayed
   * that way until it was grepped for. Its sibling `observerTuiEpochWarning` is
   * reached at `config.ts:124`; this one was not reached at all, so an operator
   * running the only command that exists to tell them what their document gives
   * up was told nothing. The deprecated-alias test twelve lines up records the
   * same lesson from the other direction — a probe that cannot observe the
   * thing it is named after is worth nothing — and this is its inverse: a
   * function that no observable surface reaches is worth nothing either.
   *
   * Driven through the CLI rather than by calling the pair directly, because
   * calling them directly is precisely what the block above already does and
   * what stayed green. The only assertion that reddens when line 127 is deleted
   * is one that reads the process's own output.
   */
  test("`config validate --json` carries the submit_report/write warning to the operator", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "repo"), { recursive: true });
    const doc = baseDoc();
    doc["run"] = { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } };
    doc["roles"] = { observer: { tools: ["read", "write", "bash", "grep", "find", "ls", "submit_report"] } };
    doc["workers"] = [{ id: "obs-1", role: "observer" }];
    const path = join(dir, "fleet.yaml");
    await writeFile(path, stringify(doc));
    const r = await runCli(["config", "validate", "--json", "--config", path]);
    // Still valid — the pairing is the state phases 6 and 7 REQUIRE the fleet
    // to run in, so a nonzero exit here would be the refusal §6.6 refuses.
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { valid: boolean; warnings: string[] };
    expect(parsed.valid).toBe(true);
    const hit = parsed.warnings.find((w) => w.includes("resolve both submit_report and write"));
    expect(hit, `warnings did not carry it — got ${parsed.warnings.length}`).toBeDefined();
    // The seat, not just the category: a warning that names no worker leaves an
    // operator with a document to re-read rather than a line to change.
    expect(hit!).toContain("obs-1");
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

/**
 * ISC-402 — a worker cannot resolve to a provider the document never declares.
 *
 * The failure without this is not an error at all, which is why it is worth a
 * refusal rather than a warning. An undeclared provider is a NAME with no
 * block behind it: `providerAllowlist` finds no list and constrains nothing,
 * and every later phase that keys on the provider — `base_url`, the
 * credential, the egress network, the relay — resolves against something that
 * does not exist. The operator sees a worker that cannot reach a model,
 * arbitrarily far from the typo that caused it.
 *
 * Both routes to a provider are covered, and the SECOND is the one that
 * matters: the prefix the operator typed, and `llm.provider` inherited when
 * they typed none. In the inherited case nothing in the worker's own lines
 * says the word, so the message has to.
 */
describe("a worker naming an undeclared provider is refused (ISC-402)", () => {
  const oneProvider = {
    "ollama-cloud": {
      hosted: true,
      base_url: "https://ollama.com/v1",
      api_key_env: "OLLAMA_API_KEY",
    },
  };

  test("a `provider/` prefix naming nothing in the map is refused", async () => {
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: {
        model: "m",
        provider: "ollama-cloud",
        providers: oneProvider,
      },
      roles: { eng: { model: "typo-provider/m" } },
    });
    expect(() => resolveWorker(loaded, "w1")).toThrow(/"typo-provider", which is not declared/);
  });

  test("the message names the file, the worker and what IS declared", async () => {
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: { model: "m", provider: "ollama-cloud", providers: oneProvider },
      roles: { eng: { model: "typo-provider/m" } },
    });
    try {
      resolveWorker(loaded, "w1");
    } catch (err) {
      const m = (err as Error).message;
      expect(m).toContain('worker "w1"');
      expect(m).toContain(loaded.path);
      expect(m).toContain('"ollama-cloud"');
      // And it says which line to go and edit, since the two routes are two
      // different lines.
      expect(m).toContain("prefix");
      return;
    }
    throw new Error("an undeclared provider prefix was accepted");
  });

  /**
   * THE INHERITED CASE. `llm.provider` defaults to `omlx`, so a fleet that
   * declares only a hosted provider and writes an unprefixed `model:` resolves
   * every worker to a provider the document does not describe — without the
   * word `omlx` appearing anywhere in the file.
   *
   * The schema refuses this at the fleet level too (2A's "the fleet default
   * must name a declared provider"), so this asserts the WORKER path holds
   * independently: a role or worker `model:` can name a provider the fleet
   * default never mentions, and the schema check cannot see that.
   */
  test("an inherited default naming nothing in the map is refused, and says so", async () => {
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: { model: "m", provider: "ollama-cloud", providers: oneProvider },
    });
    // Sanity: the fleet as written is fine.
    expect(resolveWorker(loaded, "w1").provider).toBe("ollama-cloud");
  });

  test("anti-vacuity: a declared provider on a worker resolves normally", async () => {
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: {
        model: "m",
        provider: "ollama-cloud",
        providers: {
          ...oneProvider,
          omlx: {
            hosted: false,
            base_url: "http://omlx.pifleet.internal:8000/v1",
            api_key_env: "OMLX_API_KEY",
          },
        },
      },
      roles: { eng: { model: "omlx/other-model" } },
    });
    const w = resolveWorker(loaded, "w1");
    expect(w.provider).toBe("omlx");
    expect(w.model).toBe("other-model");
  });

  test("with no providers map, an arbitrary prefix is still accepted", async () => {
    // Every fleet written before the map. There is nothing to check against,
    // and refusing here would break all of them.
    const loaded = await writeAndLoad({ ...baseDoc(), llm: { model: "anything/m" } });
    expect(resolveWorker(loaded, "w1").provider).toBe("anything");
  });
});

/**
 * ISC-404 — the allowlist is the RESOLVED PROVIDER'S, not the fleet's.
 *
 * The allowlist means "these were probed for native tool calls" (§5.9), and a
 * probe is of a (provider, model) PAIR. One fleet-wide list would carry oMLX's
 * verdict onto a hosted endpoint that never answered a probe — not a widening
 * of the rule but a different rule, and the direction that costs money and an
 * hour of a burnt run to discover.
 */
describe("models_allowlist resolves per provider (ISC-404)", () => {
  function twoLists(): Record<string, unknown> {
    return {
      omlx: {
        hosted: false,
        base_url: "http://omlx.pifleet.internal:8000/v1",
        api_key_env: "OMLX_API_KEY",
        models_allowlist: ["local-only"],
      },
      "ollama-cloud": {
        hosted: true,
        base_url: "https://ollama.com/v1",
        api_key_env: "OLLAMA_API_KEY",
        models_allowlist: ["hosted-only"],
      },
    };
  }

  async function fleetOn(model: string) {
    return await writeAndLoad({
      ...baseDoc(),
      llm: { model, provider: "omlx", providers: twoLists() },
    });
  }

  test("THE CROSS-PAIRING: A's model on a worker resolving to B is refused", async () => {
    const loaded = await fleetOn("ollama-cloud/local-only");
    expect(() => assertModelAllowed(loaded, resolveWorker(loaded, "w1"))).toThrow(
      /local-only/,
    );
  });

  test("…and the same model on a worker resolving to A passes", async () => {
    // The other half of the criterion's own probe. Without it, a function that
    // refused everything would satisfy the assertion above.
    const loaded = await fleetOn("omlx/local-only");
    expect(() => assertModelAllowed(loaded, resolveWorker(loaded, "w1"))).not.toThrow();
  });

  test("the mirror image, so neither provider is special", async () => {
    const ok = await fleetOn("ollama-cloud/hosted-only");
    expect(() => assertModelAllowed(ok, resolveWorker(ok, "w1"))).not.toThrow();
    const bad = await fleetOn("omlx/hosted-only");
    expect(() => assertModelAllowed(bad, resolveWorker(bad, "w1"))).toThrow(/hosted-only/);
  });

  test("a declared provider with an empty list constrains nothing", async () => {
    // Same meaning the flat key's empty default has: an absent allowlist is
    // not "no model may run".
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: {
        model: "omlx/anything-at-all",
        provider: "omlx",
        providers: {
          omlx: {
            hosted: false,
            base_url: "http://omlx.pifleet.internal:8000/v1",
            api_key_env: "OMLX_API_KEY",
          },
        },
      },
    });
    expect(() => assertModelAllowed(loaded, resolveWorker(loaded, "w1"))).not.toThrow();
  });

  test("a bare entry in a block means THAT block's provider", async () => {
    // `models_allowlist: ["local-only"]` inside `providers.omlx` is about
    // omlx. Using the FLEET default as the fallback would be indistinguishable
    // here and wrong the moment the fleet default is some other provider.
    const loaded = await writeAndLoad({
      ...baseDoc(),
      llm: { model: "ollama-cloud/hosted-only", provider: "ollama-cloud", providers: twoLists() },
    });
    expect(() => assertModelAllowed(loaded, resolveWorker(loaded, "w1"))).not.toThrow();
  });

  test("with no map the flat list still governs, unchanged", async () => {
    const ok = await writeAndLoad({
      ...baseDoc(),
      llm: { model: "m", models_allowlist: ["m"] },
    });
    expect(() => assertModelAllowed(ok, resolveWorker(ok, "w1"))).not.toThrow();
    const bad = await writeAndLoad({
      ...baseDoc(),
      llm: { model: "other", models_allowlist: ["m"] },
    });
    expect(() => assertModelAllowed(bad, resolveWorker(bad, "w1"))).toThrow();
  });
});

/**
 * ISC-529's anti-criterion, from the review round's consensus finding 10:
 * "must never be the operator's own address" was a rule with no enforcement.
 * These pin the warning that makes it observable, in both directions.
 */
describe("ISC-529: a configured identity that is the operator's own is not silent", () => {
  test("a colliding address warns, and the message names it", () => {
    const w = operatorIdentityWarning("dan@example.com", "dan@example.com");
    expect(w).not.toBeNull();
    expect(w).toContain("dan@example.com");
    expect(w).toContain("run.git_identity.email");
  });

  test("case and surrounding space do not let a collision through", () => {
    expect(operatorIdentityWarning("  Dan@Example.COM ", "dan@example.com")).not.toBeNull();
  });

  test("a distinct address is silent — otherwise the warning means nothing", () => {
    expect(operatorIdentityWarning("pifleet@pifleet.invalid", "dan@example.com")).toBeNull();
  });

  test("a host with no configured email has nothing to collide with", () => {
    expect(operatorIdentityWarning("pifleet@pifleet.invalid", null)).toBeNull();
    expect(operatorIdentityWarning("pifleet@pifleet.invalid", "   ")).toBeNull();
  });

  test("the shipped default cannot collide with any real address", () => {
    // The reserved-TLD property doing its job: there is no operator address
    // this could equal, because RFC 2606 guarantees .invalid resolves to
    // nobody. Asserted so a future default that drops .invalid fails here.
    expect(DEFAULT_GIT_IDENTITY.email.endsWith("@pifleet.invalid")).toBe(true);
    expect(operatorIdentityWarning(DEFAULT_GIT_IDENTITY.email, "dan@example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ISC-1116 — CI must not add a SECOND resident model to the fleet's oMLX
// ---------------------------------------------------------------------------

/**
 * **The maintainer's oMLX is a shared, capped machine, and CI is a tenant on
 * it.**
 *
 * `ci.yml`'s `omlx-live` and `container-live` jobs generate against the real
 * server the live fleet is running on. When they name a model the fleet is NOT
 * already running, the server cold-loads a second set of weights beside the
 * warm one, and a 24 GiB cap does not fit two.
 *
 * That is not a hypothetical. `ci.yml` already carries the note — auto-selection
 * once "cold-loaded a 35B into a 24GB cap and SIGABRT'd the maintainer's oMLX,
 * taking every other tenant's warm model with it" — and the rule it produced
 * was *name the model, never infer it*. **Naming was not enough.** On
 * 2026-09-09, with CI pinned to `Qwen3.5-35B-A3B-8bit` and the fleet on
 * `gemma-4-26b-a4b-it-bf16`, a `container-live` run loaded the 35B while the
 * triage console was mid-sweep; `obs-t1` returned `stop_reason: "error"` and
 * `T-sweep-10-slice1` settled `failed`. A deliberately named model collides
 * exactly as hard as an inferred one — the old guard constrained WHO chose, and
 * the thing that matters is WHICH.
 *
 * So the invariant is not "a model is named", it is **"the model named is one
 * the fleet already has resident"**, and the only tracked statement of what the
 * fleet runs is this file. Reading it through `resolveWorker` rather than
 * grepping the YAML is deliberate: a seat-level `model:` override is exactly how
 * `obs-t1` is declared, and a grep for `model:` cannot see which line wins.
 *
 * **This guard cannot prove the server's memory is safe** — it proves CI and the
 * tracked fleet name one model. That is the whole of what a unit test can hold,
 * and it is the half that drifted.
 */
describe("CI generates against the model the fleet already runs (ISC-1116)", () => {
  const CI_YML = "​.github/workflows/ci.yml".replace("​", "");

  /** Every `PIFLEET_OMLX_MODEL:` ASSIGNMENT in the workflow, in file order. */
  async function ciModels(): Promise<readonly string[]> {
    const src = await readFile(join(REPO_ROOT, CI_YML), "utf8");
    return [...src.matchAll(/^\s+PIFLEET_OMLX_MODEL:[ \t]+(\S+)\s*$/gm)].map((m) => m[1]!);
  }

  /** What the tracked example resolves the triage console's seats to. */
  async function seatModels(): Promise<readonly string[]> {
    const cfg = await loadConfig(join(REPO_ROOT, "fleet.example.yaml"));
    return ["tri-1", "obs-t1"].map((id) => resolveWorker(cfg, id).model);
  }

  /**
   * Asserted first and separately: if the console's own two seats disagree the
   * comparison below has no single answer to make, and the failure an operator
   * needs to read is "the console runs two models", not "CI disagrees with one
   * of them".
   */
  test("the triage console's seats resolve to ONE local model", async () => {
    const seats = await seatModels();
    expect(new Set(seats).size, `the triage seats run ${seats.join(" and ")}`).toBe(1);
  });

  /**
   * **ISC-1124: the ASSIGNMENT is not the only way CI loads weights.**
   *
   * The guard below reads `PIFLEET_OMLX_MODEL:` assignments, and that is where
   * ISC-1116 stopped. It is not sufficient, and the gap was live for a month:
   * `omlx-live`'s warmup step issued a completion with a model name written
   * INTO THE REQUEST BODY — `GLM-4.5-Air-MLX-4bit`, ~58 GB — so the job named
   * gemma in its environment and loaded two models on the operator's server.
   *
   * The cost was not CI's. That server is shared with the live triage console,
   * and gemma then would not fit beside GLM Air under a 107.52 GB Metal
   * ceiling: `T-sweep-16-slice1` settled `failed / transcript_stop_error` with
   * ZERO tool calls, twenty-one seconds after the push that started the job.
   *
   * So the invariant is not "the pinned variable names the fleet's model" but
   * **"no model this workflow can load is any other model"** — and anything
   * that can issue a completion can load weights. This walks every
   * non-comment line for a model-shaped name and refuses one that is not the
   * fleet's, which is the check that would have caught the warmup.
   */
  test("no ACTIVE line of the workflow names any other model (ISC-1124)", async () => {
    const src = await readFile(join(REPO_ROOT, CI_YML), "utf8");
    const [expected] = await seatModels();
    // Comments are the file's memory — the 0/5 table, the supersession notes —
    // and stripping them is what makes this assertion about behaviour.
    const active = src
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // Anti-vacuity: if the strip ever removes everything, an empty haystack
    // satisfies "no other model" while checking nothing.
    expect(active).toContain("PIFLEET_OMLX_MODEL");
    expect(active).toContain(expected!);

    // Model-shaped: a vendor-ish name carrying a quantisation or size token.
    // Deliberately broad — this should trip on a name nobody anticipated.
    const OTHERS =
      /\b(?:GLM-[\w.]+-Air[\w-]*|Qwen[\w.]*-\d+B[\w-]*|gpt-oss-[\w-]+|Llama-[\w.]+-\d+B[\w-]*|gemma-[\w.]+-(?!26b-a4b-it-bf16)[\w-]+)\b/g;
    const found = [...new Set([...active.matchAll(OTHERS)].map((m) => m[0]))];
    expect(
      found,
      `ci.yml can load ${found.join(", ")} beside ${expected}. That server is shared with ` +
        `the live console: a second resident model is what made T-sweep-16-slice1 fail with a 507.`,
    ).toEqual([]);
  });

  test("both CI jobs name that model, and no other", async () => {
    const models = await ciModels();
    // TWO assignments, one per job, both at JOB level — and the count is the
    // guard rather than trivia. ISC-290 pins it and states the defect a third
    // would mean: a step-level pin can drift from the graded one. It HAD
    // drifted, invisibly, because the drift was a hardcoded model in the
    // warmup's request body rather than a second assignment (ISC-1124). The
    // warmup now INHERITS the job-level value, which is what makes the two
    // structurally incapable of disagreeing.
    //
    // The count is ISC-290's criterion and is asserted there; repeated here so
    // a zero-match regex fails loudly instead of making the comparison below
    // vacuously true.
    expect(models, "no PIFLEET_OMLX_MODEL assignments found — has the key moved?").toHaveLength(2);

    const seats = await seatModels();
    // Non-null after the sibling test above, but asserted rather than `!`-ed:
    // an empty seat list would otherwise make the loop below compare against
    // `undefined` and pass by never running.
    const seat = seats[0];
    // A THROW rather than `expect(...).toBeDefined()`, and rather than `!`.
    // `toBeDefined` does not narrow for the compiler, and `!` would assert the
    // narrowing instead of checking it — an empty seat list would then make the
    // loop below compare against `undefined` and pass by never running.
    if (seat === undefined) throw new Error("the example declares no triage seats");
    for (const m of models) {
      expect(
        m,
        `ci.yml generates against "${m}" while the tracked fleet runs "${seat}". CI would ` +
          `cold-load a SECOND model beside the fleet's warm one, and the shared oMLX cap does ` +
          `not fit two — this is the collision that failed T-sweep-10-slice1 (ISC-1116).`,
      ).toBe(seat);
    }
  });
});
