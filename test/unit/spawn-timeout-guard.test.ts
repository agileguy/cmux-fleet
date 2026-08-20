/**
 * Every integration and e2e test that spawns a subprocess carries a DERIVED
 * time budget, never bun's inherited 5000 ms default (ISC-274, ISC-273).
 *
 * WHY THIS IS A GUARD AND NOT A SWEEP. ISC-266 established that bun's 5000 ms
 * default has no relationship to what a subprocess-spawning test does, and
 * `test/support/budget.ts` exists to replace it. What a one-time sweep cannot
 * establish is that the replacement stays UNIVERSAL. A test written next month
 * that spawns and carries no third argument inherits the default again,
 * passes CI on an idle runner, and fails under contention — the same signature
 * ISC-266 documented, in a file no sweep visited because it did not exist yet.
 * ISC-273 is the proof that this happens: `down-prune.test.ts` predates
 * ISC-266's sweep, was never reached by it, and sat at twelve inherited
 * defaults until this guard named it. A criterion whose only enforcement is a
 * report nobody re-reads is not enforced.
 *
 * WHAT "SPAWNS" MEANS HERE, AND WHY IT IS A CALL GRAPH RATHER THAN A GREP.
 * ISC-274 phrases its probe file-scoped — "a file that contains a spawn must
 * give every `test(...)` in it an explicit third argument" — because that form
 * is grep-answerable. It is answerable, and it is also WRONG in both
 * directions on this tree, which is why the check below resolves the call
 * graph instead:
 *
 *   - FALSE POSITIVES. `logs.test.ts` mixes CLI-driving tests with static
 *     source scans ("only read-only fs functions are imported, by allowlist")
 *     that read files and spawn nothing. A file-scoped rule demands a budget
 *     for a 10 ms text scan, and the only way to satisfy it is to write a
 *     spawn count that is not true. `budget.ts` says count, do not estimate;
 *     a rule that forces a fictional count corrupts the thing it enforces.
 *   - FALSE NEGATIVES. `down-prune.test.ts`'s tests do not contain the token
 *     `Bun.spawn` in their own bodies at all. They call `down()`, which
 *     spawns the CLI, and `makeRig()`, which reaches `git` through
 *     `seedGitRepo` in `test/fixtures/synthetic-repo.ts` and through
 *     `createWorkerWorktrees` in `src/run/worktree.ts`. A grep for spawns
 *     INSIDE a test body finds nothing in the very file ISC-273 was filed
 *     over. The spawn is two and three modules away.
 *
 * So a test is IN SCOPE when any call reachable from its body — through local
 * helpers, through imported fixtures, through `src/`, and through the
 * `await import(...)` forms these tests use — reaches a subprocess primitive.
 * That is what "the spawns it performs" means when the spawning is done by a
 * helper, which is how every one of these files is written.
 *
 * WHAT COUNTS AS A DERIVED CEILING. ISC-274 is explicit that the rule is that
 * "the ceiling is DERIVED and the derivation is written down — not that
 * `cliBudget` appears literally". Two shapes satisfy it and the guard accepts
 * both:
 *
 *   1. A budget helper from `test/support/budget.ts` as the third argument,
 *      directly or through a named constant. There are two, because there are
 *      two costs: `cliBudget(n)` for tests whose time goes on this project's
 *      CLI startup, and `containerBudget(n)` for tests whose time goes on
 *      `docker`. The guard reads that file's export surface rather than naming
 *      them, so the accepted set follows the model instead of a copy of it.
 *   2. A hand-picked literal WITH an inline audit note that names the
 *      `cliBudget` value it was compared against and says why that value does
 *      not govern. This is the standing exception ISC-274 reserves for a test
 *      "whose cost is bounded by something OTHER than process startup", and
 *      it is not hypothetical: `supervisor.test.ts`'s ISC-212 settle-failure
 *      test keeps 45_000 because `cliBudget(1)`'s 11_400 ms would be NARROWER
 *      than the 11_415 ms the test actually takes, its cost being a
 *      deliberate 1 s deadline plus the abort ladder rather than spawning.
 *      Replacing that literal with the derived number would break the test,
 *      so the criterion cannot be "`cliBudget` appears" — it has to be "the
 *      number was derived, and you can read the derivation".
 *
 * The audit note is required to name `cliBudget` precisely because that is
 * what makes the comparison legible: a bare "// 45s, this one is slow" records
 * a guess, while "cliBudget(1) = 11_400 ms is narrower than the 11_415 ms
 * measured" records a decision. The guard cannot judge whether a stated reason
 * is a good one. It can insist that a reason exists and that it was measured
 * against the model, which is the difference between a budget and a number.
 *
 * WHAT THE GUARD DELIBERATELY DOES NOT ACCEPT. A test that spawns and carries
 * NO third argument, however well commented. ISC-274 records one such standing
 * exception — ISC-269's follower test, which kills on first output and
 * measures 120 ms — and this guard declines it. 120 ms is the cost of the
 * WORK; the cost of the SPAWN is still paid before the first byte arrives, and
 * a runner under the load ISC-266 recorded can spend the whole 5000 ms getting
 * there. A test that is fast when idle and inherits a default it never chose
 * is exactly the exposure this criterion is about. Those tests now carry
 * `cliBudget(1)`, which costs nothing — a genuinely hung follower still fails,
 * at 11.4 s instead of 5 s — and removes the last shape a future test can copy
 * to reintroduce the default.
 *
 * KNOWN LIMITS, STATED SO NOBODY READS MORE INTO A PASS THAN IT MEANS. The
 * resolver follows relative imports only; a spawn reached through an npm
 * package is invisible to it (none exists in this tree — the only subprocess
 * primitives here are bun's own and `node:child_process`). It matches
 * declarations by NAME within a module, so a local helper deliberately
 * shadowing an imported one could be misread. Recursion through an import
 * cycle stops at the cycle rather than continuing, which can only UNDER-report.
 * Every one of these fails toward missing a violation rather than inventing
 * one, which is the right direction for a guard that gates a suite.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Directories whose tests are in scope.
 *
 * `test/unit/` is not among them, and that is a scope decision rather than an
 * oversight: a unit test that spawns is the same defect, but ISC-274 names
 * `test/integration/**` and this branch's remit stops at integration and e2e.
 * Widening the roots is a one-line change when someone owns that sweep.
 */
const ROOTS = ["test/integration", "test/e2e"] as const;

// ---------------------------------------------------------------------------
// Subprocess primitives
// ---------------------------------------------------------------------------

/**
 * Property-access spellings that ARE a subprocess, wherever they appear.
 *
 * `Bun.$` is included as a tagged template (`` Bun.$`ls` ``) as well as a
 * call, because the shell helper spawns either way.
 */
const BUN_PRIMITIVES = new Set(["Bun.spawn", "Bun.spawnSync", "Bun.$"]);

/** `node:child_process` exports that spawn. Matched only when imported from there. */
const CHILD_PROCESS_PRIMITIVES = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

/**
 * Method names that launch a process through an indirection the resolver
 * cannot follow — `processLauncher.launchDetached` is reached through an
 * injected interface, so no declaration in any module names the body that
 * ultimately spawns. ISC-274 names this spelling explicitly.
 */
const LAUNCHER_METHODS = new Set(["launchDetached"]);

// ---------------------------------------------------------------------------
// Module parsing and symbol resolution
// ---------------------------------------------------------------------------

interface ModuleInfo {
  readonly path: string;
  readonly sf: ts.SourceFile;
  /** Callable declarations by local name — function decls and const-bound functions. */
  readonly functions: Map<string, ts.Node[]>;
  /** Every `const`/`let` declaration by name, for reading a named timeout's derivation. */
  readonly values: Map<string, ts.VariableDeclaration>;
  /** Local binding -> the module and original name it came from. */
  readonly imports: Map<string, { spec: string; imported: string }>;
  /** `import * as ns` bindings -> module specifier. */
  readonly namespaces: Map<string, string>;
  /** Specifiers imported from `node:child_process`, by local name. */
  readonly childProcessBindings: Set<string>;
}

const moduleCache = new Map<string, ModuleInfo | null>();

/**
 * Read and index one module.
 *
 * Synchronous IO on purpose. This walk is a graph traversal whose shape is
 * decided by what it has already read, and threading promises through it buys
 * nothing but a chance to interleave reads of a tree that is not changing.
 */
function loadModule(abs: string): ModuleInfo | null {
  const cached = moduleCache.get(abs);
  if (cached !== undefined) return cached;

  if (!existsSync(abs) || !statSync(abs).isFile()) {
    moduleCache.set(abs, null);
    return null;
  }
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  const functions = new Map<string, ts.Node[]>();
  const values = new Map<string, ts.VariableDeclaration>();
  const imports = new Map<string, { spec: string; imported: string }>();
  const namespaces = new Map<string, string>();
  const childProcessBindings = new Set<string>();

  const addFunction = (name: string, body: ts.Node): void => {
    const existing = functions.get(name);
    if (existing) existing.push(body);
    else functions.set(name, [body]);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      addFunction(node.name.text, node.body);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      values.set(node.name.text, node);
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        addFunction(node.name.text, init.body);
      }
      // `const { a, b } = await import("./x.ts")` — the dynamic form these
      // tests use to defer loading a command module until inside the test.
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const spec = dynamicImportSpecifier(node.initializer);
      if (spec !== null) {
        for (const el of node.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const imported =
            el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
          imports.set(el.name.text, { spec, imported });
        }
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        if (clause.name) imports.set(clause.name.text, { spec, imported: "default" });
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) namespaces.set(nb.name.text, spec);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            imports.set(el.name.text, { spec, imported });
            if (spec === "node:child_process" || spec === "child_process") {
              if (CHILD_PROCESS_PRIMITIVES.has(imported)) childProcessBindings.add(el.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const info: ModuleInfo = { path: abs, sf, functions, values, imports, namespaces, childProcessBindings };
  moduleCache.set(abs, info);
  return info;
}

/** `await import("./x.ts")` / `import("./x.ts")` -> the specifier, else null. */
function dynamicImportSpecifier(init: ts.Expression | undefined): string | null {
  if (!init) return null;
  const expr = ts.isAwaitExpression(init) ? init.expression : init;
  if (!ts.isCallExpression(expr)) return null;
  if (expr.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const arg = expr.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : null;
}

/**
 * Resolve a relative specifier to a file on disk.
 *
 * Bare specifiers return null — an npm package is outside this graph, and
 * saying so explicitly is better than a resolver that silently walks
 * `node_modules` looking for a spawn that is not there.
 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Does this reach a subprocess?"
// ---------------------------------------------------------------------------

const symbolCache = new Map<string, boolean>();

/** Does calling `name` in `mod` reach a subprocess primitive? */
function symbolSpawns(mod: ModuleInfo, name: string, visiting: Set<string>): boolean {
  const key = `${mod.path}#${name}`;
  const cached = symbolCache.get(key);
  if (cached !== undefined) return cached;
  if (visiting.has(key)) return false; // cycle — under-report rather than hang
  visiting.add(key);

  let answer = false;
  const bodies = mod.functions.get(name);
  if (bodies) {
    answer = bodies.some((b) => nodeSpawns(mod, b, visiting));
  } else {
    const imported = mod.imports.get(name);
    if (imported) {
      const target = resolveSpec(mod.path, imported.spec);
      const targetMod = target === null ? null : loadModule(target);
      if (targetMod) answer = symbolSpawns(targetMod, imported.imported, visiting);
    }
  }

  visiting.delete(key);
  symbolCache.set(key, answer);
  return answer;
}

/** Does any call reachable from `node` reach a subprocess primitive? */
function nodeSpawns(mod: ModuleInfo, node: ts.Node, visiting: Set<string>): boolean {
  return collectSpawnSites(mod, node, visiting, true).length > 0;
}

/**
 * The call sites within `node` that reach a subprocess, in source order.
 *
 * `stopAtFirst` exists only so the boolean question does not pay for a full
 * traversal of `src/`. The reported list — used to tell an author how many
 * spawns a test performs — always collects everything.
 */
function collectSpawnSites(
  mod: ModuleInfo,
  node: ts.Node,
  visiting: Set<string>,
  stopAtFirst: boolean,
): Array<{ text: string; line: number }> {
  const hits: Array<{ text: string; line: number }> = [];

  const record = (n: ts.Node, text: string): void => {
    const line = mod.sf.getLineAndCharacterOfPosition(n.getStart(mod.sf)).line + 1;
    hits.push({ text, line });
  };

  const calleeSpawns = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) {
      if (mod.childProcessBindings.has(callee.text)) return true;
      return symbolSpawns(mod, callee.text, visiting);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const full = callee.getText(mod.sf).replace(/\s+/g, "");
      if (BUN_PRIMITIVES.has(full)) return true;
      if (LAUNCHER_METHODS.has(callee.name.text)) return true;
      // `ns.helper()` where `ns` is `import * as ns from "./x.ts"`.
      if (ts.isIdentifier(callee.expression)) {
        const spec = mod.namespaces.get(callee.expression.text);
        if (spec !== undefined) {
          const target = resolveSpec(mod.path, spec);
          const targetMod = target === null ? null : loadModule(target);
          if (targetMod) return symbolSpawns(targetMod, callee.name.text, visiting);
        }
      }
      return false;
    }
    return false;
  };

  const walk = (n: ts.Node): void => {
    if (stopAtFirst && hits.length > 0) return;
    if (ts.isTaggedTemplateExpression(n)) {
      const tag = n.tag.getText(mod.sf).replace(/\s+/g, "");
      if (BUN_PRIMITIVES.has(tag)) record(n, tag);
    }
    if (ts.isCallExpression(n)) {
      if (calleeSpawns(n.expression)) record(n, n.expression.getText(mod.sf).replace(/\s+/g, ""));
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hits;
}

// ---------------------------------------------------------------------------
// Test call sites
// ---------------------------------------------------------------------------

interface TestSite {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly spawnCount: number;
  readonly hasTimeout: boolean;
  readonly derivationFound: boolean;
}

/**
 * `test`, `it`, `test.skip`, `test.skipIf(cond)(...)`, `test.each(rows)(...)`.
 *
 * The conditional and table forms are calls whose CALLEE is itself a call, so
 * the base identifier is two levels down — and every one of them still takes
 * the timeout as its third argument, which is the whole reason they have to be
 * recognised rather than skipped.
 */
function testBaseName(expr: ts.Expression): string {
  let e: ts.Node = expr;
  if (ts.isCallExpression(e)) e = e.expression;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : "";
}

/**
 * The names that COUNT as a derivation, read from `test/support/budget.ts`
 * rather than hardcoded here.
 *
 * `cliBudget` is not the only honest answer and was never meant to be. A
 * `docker run` is a different cost with a different distribution, so reaching a
 * workable ceiling for a container test by inflating its CLI spawn count would
 * encode a lie as arithmetic — which is why `containerBudget` exists alongside
 * it. Hardcoding one name here would have forced exactly that lie, or an
 * exemption list, which is the silent-disable this guard exists to prevent.
 *
 * Reading the export surface instead means a third helper — measured and
 * documented in `budget.ts` the way these two are — is accepted the moment it
 * is written, and a helper DELETED from `budget.ts` stops counting the moment
 * it goes. The guard tracks the model rather than a copy of its name list.
 */
function budgetHelperNames(): string[] {
  const abs = join(ROOT, "test/support/budget.ts");
  const mod = loadModule(abs);
  if (!mod) throw new Error("test/support/budget.ts is missing — nothing can derive a budget");
  const names: string[] = [];
  for (const stmt of mod.sf.statements) {
    const exported = ts
      .getModifiers(stmt as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported !== true) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) names.push(stmt.name.text);
  }
  if (names.length === 0) throw new Error("budget.ts exports no budget function");
  return names;
}

const DERIVATION_MARKER = new RegExp(`\\b(?:${budgetHelperNames().join("|")})\\b`);

/**
 * Everything an author could have written the derivation into, as one string.
 *
 * The call's own text covers a note placed anywhere inside it — before the
 * literal in the argument list (the `down-prune.test.ts` shape) or inside the
 * callback body (the `supervisor.test.ts` shape) — because `getText` spans the
 * source range and keeps interior comments. Leading trivia covers a docstring
 * above the test. A named constant is followed to its declaration so that
 * `}, budgetMs)` is judged on what `budgetMs` is, not on its name.
 */
function derivationEvidence(mod: ModuleInfo, call: ts.CallExpression, timeout: ts.Expression): string {
  const src = mod.sf.getFullText();
  const parts = [call.getText(mod.sf)];

  const stmt = enclosingStatement(call);
  if (stmt) {
    for (const r of ts.getLeadingCommentRanges(src, stmt.getFullStart()) ?? []) {
      parts.push(src.slice(r.pos, r.end));
    }
  }

  const seen = new Set<string>();
  const followIdentifiers = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      seen.add(n.text);
      const decl = mod.values.get(n.text);
      if (decl) {
        parts.push(decl.getText(mod.sf));
        // The docstring hangs off the `const` STATEMENT, not off the
        // declaration inside it — a `VariableDeclaration`'s full start is
        // after the `const` keyword, where there is never a comment. Reading
        // the wrong node here made the guard flag `container-env.test.ts`,
        // whose named budget carries the most explicit derivation in the tree.
        const declStmt = enclosingStatement(decl) ?? decl;
        for (const r of ts.getLeadingCommentRanges(src, declStmt.getFullStart()) ?? []) {
          parts.push(src.slice(r.pos, r.end));
        }
      }
    }
    ts.forEachChild(n, followIdentifiers);
  };
  followIdentifiers(timeout);

  return parts.join("\n");
}

function enclosingStatement(node: ts.Node): ts.Node | null {
  let n: ts.Node | undefined = node;
  while (n && !ts.isSourceFile(n)) {
    if (ts.isStatement(n)) return n;
    n = n.parent;
  }
  return null;
}

/** Every `test(...)`/`it(...)` in one file, with its spawn reach and its derivation. */
function scanTestFile(abs: string, repoRelative: string): TestSite[] {
  const mod = loadModule(abs);
  if (!mod) return [];
  const sites: TestSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const base = testBaseName(node.expression);
      if (base === "test" || base === "it") {
        const args = node.arguments;
        const body = args[1];
        const timeout = args[2];
        const titleNode = args[0];
        const spawnSites =
          body === undefined ? [] : collectSpawnSites(mod, body, new Set<string>(), false);
        sites.push({
          file: repoRelative,
          line: mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1,
          title: (titleNode ? titleNode.getText(mod.sf) : "<unnamed>").replace(/\s+/g, " ").slice(0, 90),
          spawnCount: spawnSites.length,
          hasTimeout: timeout !== undefined,
          derivationFound:
            timeout !== undefined && DERIVATION_MARKER.test(derivationEvidence(mod, node, timeout)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return sites;
}

/** Violations across a set of already-scanned sites. */
function violations(sites: readonly TestSite[]): TestSite[] {
  return sites.filter((s) => s.spawnCount > 0 && !(s.hasTimeout && s.derivationFound));
}

function describeViolation(s: TestSite): string {
  const why = !s.hasTimeout
    ? `inherits bun's ${5_000} ms default (no third argument)`
    : "carries a ceiling with no written derivation (no cliBudget comparison in scope)";
  return `${s.file}:${s.line}  ${s.title}\n      ${s.spawnCount} spawn call site(s) reachable; ${why}`;
}

async function inScopeFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const root of ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*.test.ts`);
    for await (const f of glob.scan({ cwd: ROOT })) out.push(f);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

describe("no spawning test inherits bun's default timeout (ISC-274, ISC-273)", () => {
  test("every subprocess-spawning integration and e2e test carries a derived budget", async () => {
    const files = await inScopeFiles();
    expect(files.length).toBeGreaterThan(30); // the scan found the tree, not an empty glob

    const all: TestSite[] = [];
    for (const rel of files) all.push(...scanTestFile(join(ROOT, rel), rel));
    expect(all.length).toBeGreaterThan(300); // and the tests inside it

    const bad = violations(all);
    const report = bad.map((s) => `  - ${describeViolation(s)}`).join("\n");
    expect(
      bad.length,
      bad.length === 0
        ? ""
        : `${bad.length} test(s) spawn a subprocess without a derived time budget.\n` +
            `Give each one a third argument of cliBudget(n) from test/support/budget.ts, where n is\n` +
            `the number of spawns the test performs — or, if its cost is bounded by something other\n` +
            `than process startup, keep the literal and write an inline note naming the cliBudget(n)\n` +
            `it was compared against and why that value does not govern.\n${report}`,
    ).toBe(0);
  });

  /**
   * ISC-273 as its own assertion, so the file that motivated the class cannot
   * quietly regress behind a green class-wide check that someone later scopes
   * down. It also states the count, so deleting the tests is not a way to pass.
   */
  test("down-prune.test.ts specifically: every test derives its ceiling", () => {
    const rel = "test/integration/down-prune.test.ts";
    const sites = scanTestFile(join(ROOT, rel), rel);
    expect(sites.length).toBe(13);
    expect(sites.filter((s) => s.spawnCount > 0).length).toBe(13);
    expect(violations(sites).map(describeViolation)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard's own mutation proof
// ---------------------------------------------------------------------------

/**
 * A guard nobody has seen fail is indistinguishable from a guard that cannot
 * fail — `test/unit/anti-criteria.test.ts` states the rule and these follow it.
 *
 * Each case below is a real module written to a real temp directory and read
 * back through the real resolver, not a string handed to an internal function.
 * The import-resolution and comment-scanning paths are exactly the parts most
 * likely to be silently broken, and a fixture that bypassed them would prove
 * only that the pure arithmetic works.
 */
describe("the guard can fail (mutation proof)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-timeout-guard-"));

  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body, "utf8");
    return p;
  };

  const scan = (path: string): TestSite[] => {
    moduleCache.delete(path);
    symbolCache.clear();
    return scanTestFile(path, relative(dir, path));
  };

  const PREAMBLE = `import { test } from "bun:test";\nimport { cliBudget } from "./budget.ts";\n`;

  write("budget.ts", "export function cliBudget(n: number): number { return n * 11400; }\n");
  write("helper.ts", 'export async function run(): Promise<void> { Bun.spawn(["true"]); }\n');
  write("indirect.ts", 'import { run } from "./helper.ts";\nexport const twice = async (): Promise<void> => { await run(); await run(); };\n');

  test("a direct spawn with no third argument is a violation", () => {
    const p = write("a.test.ts", `${PREAMBLE}test("x", async () => { Bun.spawn(["true"]); });\n`);
    expect(violations(scan(p)).length).toBe(1);
  });

  test("the same test with cliBudget is clean", () => {
    const p = write("b.test.ts", `${PREAMBLE}test("x", async () => { Bun.spawn(["true"]); }, cliBudget(1));\n`);
    expect(violations(scan(p)).length).toBe(0);
  });

  test("a spawn reached only through a LOCAL helper is still caught", () => {
    const p = write(
      "c.test.ts",
      `${PREAMBLE}async function go(): Promise<void> { Bun.spawn(["true"]); }\ntest("x", async () => { await go(); });\n`,
    );
    const sites = scan(p);
    expect(sites[0]?.spawnCount).toBe(1);
    expect(violations(sites).length).toBe(1);
  });

  test("a spawn reached only through an IMPORTED module is still caught", () => {
    const p = write(
      "d.test.ts",
      `${PREAMBLE}import { run } from "./helper.ts";\ntest("x", async () => { await run(); });\n`,
    );
    expect(violations(scan(p)).length).toBe(1);
  });

  test("a spawn two modules deep is still caught, and every call site is counted", () => {
    const p = write(
      "e.test.ts",
      `${PREAMBLE}import { twice } from "./indirect.ts";\ntest("x", async () => { await twice(); await twice(); });\n`,
    );
    const sites = scan(p);
    expect(sites[0]?.spawnCount).toBe(2); // two call sites in the body, not four spawns
    expect(violations(sites).length).toBe(1);
  });

  test("a test that spawns nothing needs no budget", () => {
    const p = write("f.test.ts", `${PREAMBLE}test("x", async () => { const n = 1 + 1; void n; });\n`);
    const sites = scan(p);
    expect(sites[0]?.spawnCount).toBe(0);
    expect(violations(sites).length).toBe(0);
  });

  test("a bare literal with no derivation is a violation", () => {
    const p = write("g.test.ts", `${PREAMBLE}test("x", async () => { Bun.spawn(["true"]); }, 30_000);\n`);
    expect(violations(scan(p)).length).toBe(1);
  });

  test("a literal WITH an inline cliBudget audit note is accepted", () => {
    const p = write(
      "h.test.ts",
      `${PREAMBLE}test("x", async () => { Bun.spawn(["true"]); },\n  // cliBudget(1) = 11_400 ms is narrower than the 20 s ladder this waits out.\n  30_000);\n`,
    );
    expect(violations(scan(p)).length).toBe(0);
  });

  test("a named constant is judged on its derivation, not on its name", () => {
    const clean = write(
      "i.test.ts",
      `${PREAMBLE}const BUDGET = cliBudget(2);\ntest("x", async () => { Bun.spawn(["true"]); }, BUDGET);\n`,
    );
    expect(violations(scan(clean)).length).toBe(0);

    const dirty = write(
      "j.test.ts",
      `${PREAMBLE}const BUDGET = 30_000;\ntest("x", async () => { Bun.spawn(["true"]); }, BUDGET);\n`,
    );
    expect(violations(scan(dirty)).length).toBe(1);
  });

  test("the conditional and table forms are not a way around the check", () => {
    const p = write(
      "k.test.ts",
      `${PREAMBLE}const DOCKER = false;\ntest.skipIf(!DOCKER)("x", async () => { Bun.spawn(["true"]); });\ntest.each([1, 2])("y %s", async () => { Bun.spawn(["true"]); });\n`,
    );
    expect(violations(scan(p)).length).toBe(2);
  });
});
