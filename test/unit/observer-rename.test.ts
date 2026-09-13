/**
 * The `observer` → `observer-k8s` rename cannot come back quietly.
 * `Docs/SRD-OBSERVER-ROLES.md` §4.3, layers 2 and 3 (Phase 1 task 1.8).
 *
 * Layer 1 is the config loader: a worker naming an unknown role fails to load.
 * That catches a stale role name in a config the loader reads, and nothing
 * else. A test fixture, a role prompt, a skill document or an operator-visible
 * warning can keep the old name while every load succeeds, which is why this
 * file sweeps text instead of trusting the loader.
 *
 * ## What is swept, and what is not
 *
 * {@link SCAN_ROOTS} is §4.3's list exactly. `Docs/` is NOT in it: design
 * documents spell the old name on purpose, because they record what the name
 * was (§4.2, last row). This file excludes itself, because its detector cases
 * spell every form it refuses.
 *
 * Every form in {@link FORMS} reads every scanned file, except the quoted
 * literal, which reads `src/`, `test/` and `scripts/` only. The scripts are
 * extensionless Bun TypeScript, so the scope is by directory, not extension.
 *
 * Two things are deliberately NOT guarded:
 *
 * - **English prose.** "The observer" in a comment, a role prompt or a skill is
 *   §4.2's seat that looks. No form reads words; each one is an identifier
 *   shape.
 * - **Backtick spans.** The quoted-literal form covers `"` and `'` only.
 *   Docblocks name the role in backticks dozens of times, and §4.2 lets English
 *   and historical prose stay.
 *
 * ## Four traps the detectors are built around
 *
 * **Word boundaries.** `\b` after `observer` matches `observer-k8s`, because
 * `\b` sits between `r` and `-`. Every form ending in the bare name anchors
 * with `(?![-\w])` or a closing quote or backtick instead.
 *
 * **Newlines.** Swept text is a whole file, so `\s` crosses lines. Where a
 * match must stay on one line it spells `[ \t]`.
 *
 * **Role indentation is structural.** `observer:` is also the `triage.json`
 * row field holding a worker id (`src/run/triage-document.ts`, §4.2), and test
 * fixtures spell it as a key at several indentations. A key is only a role key
 * when it is a direct child of a `roles` block, and that block may be YAML or a
 * test fixture object that becomes a fleet document. Run against the tree at
 * 909f817, a YAML-only reading missed seven such keys in `config.test.ts` and
 * `worker-secrets.test.ts`; §4.3's other forms reached them only through a
 * paired `role:` line in the same fixture.
 *
 * **A quoted key is not a quoted literal.** The same row field is a quoted key
 * in JSON, as in `{"service": "api", "observer": "obs-t1"}`. The quoted-literal
 * form lets a literal through when `:` follows its closing quote directly.
 * The colon must be adjacent, so a ternary's spaced ` : ` still fires. A quoted
 * ROLE key is still refused, by the role-key form, which reads structure
 * instead of quotes.
 *
 * ## The exemptions are line shapes, NAMED per file
 *
 * The operations console's pane title is the one quoted literal §4.2 keeps.
 * {@link PANE_TITLE_SITES} names each file that may hold it and, within that
 * file, the shapes of line that may. A shape is a whole-line regex, matched
 * against the line with its indentation trimmed. A line it admits must also
 * hold exactly one quoted literal, so an open tail cannot carry a second. Every
 * other quoted literal in a named file fires, exactly as it would anywhere
 * else.
 *
 * Following `test/unit/triage-readonly.test.ts`'s `DISPATCH_PATH`, the list is
 * named, not counted. The grain is the shape, not the line: a further line of
 * an allowed shape in its own file passes, and a new shape is an edit somebody
 * has to justify. Shapes carry no line numbers, because line numbers rot.
 *
 * The check runs both ways. A shape that matches no line of its file fails, and
 * so does a quoted literal in a named file that no shape of that file admits.
 * The list shrinks when a reason goes away, and it cannot widen by accident.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { loadConfig } from "../../src/config/load.ts";
import { OBSERVER_K8S_ROLE, observerTuiWorkers } from "../../src/config/schema.ts";

const REPO = join(import.meta.dir, "..", "..");
const SELF = relative(REPO, import.meta.path);

/**
 * The old role name, spelled once. Test names, detector cases and the prompt
 * path are built from it, so §4.3's two hand-check greps print nothing for this
 * file either. The regex literals below spell it too, but behind an escape or a
 * character class, where neither grep matches.
 */
const OLD = "observer";
const OLD_PROMPT = `roles/${OLD}.md`;
/** The pane title as the named sites quote it. */
const TITLE = `"${OLD}"`;

/**
 * A whole-line shape. The template is regex source for one line with its
 * indentation trimmed, and each `${TITLE}` marks where the quoted title sits.
 * The raw strings are used, so `\(` reaches the regex as written.
 */
function lineShape(source: TemplateStringsArray, ...titles: string[]): RegExp {
  return new RegExp(`^${String.raw(source, ...titles)}$`);
}

/** §4.3 layer 2's scan list, in its order. Directories are walked; the two configs are files. */
const SCAN_ROOTS = [
  "src",
  "test",
  "scripts",
  "roles",
  "skills",
  ".claude/skills/fleet",
  "fleet.yaml",
  "fleet.example.yaml",
];

type TitleShape = { shape: RegExp; why: string };

/**
 * **The only lines that may hold a quoted `"observer"` literal: per file, their
 * shapes, and why each may.**
 *
 * The operations console titles its first agent pane `observer`. That title is a
 * console concept, not the role (§4.2): it is a label an operator types, and
 * `plannedPane` accepts the title or the worker id, so nothing resolves a role
 * from it. Renaming it would change operator muscle memory for no behaviour
 * (§4.2, Q8). One file defines the title and three pin it.
 *
 * A shape admits a trimmed line holding exactly one quoted literal; see the
 * header. Adding a file or a shape here is an edit somebody has to justify in
 * its `why`.
 */
const PANE_TITLE_SITES: Readonly<Record<string, readonly TitleShape[]>> = {
  "src/backends/cmux/operations-plan.ts": [
    { why: "defines the title: the `title:` of the first agent pane it plans", shape: lineShape`title: ${TITLE},` },
  ],
  "test/unit/operations-plan.test.ts": [
    {
      why: "pins the planned pane order",
      shape: lineShape`expect\(plan\(\)\.map\(\(p\) => p\.title\)\)\.toEqual\(\[${TITLE}, "monitor", "ticketing"\]\);`,
    },
    {
      why: "walks the two single-worker panes by title",
      shape: lineShape`for \(const t of \[${TITLE}, "ticketing"\]\) \{`,
    },
    {
      why: "looks the planned pane up by that title, with or without plan options, and reads its split or command",
      shape: lineShape`(?:expect\(|const cmd = )paneNamed\(${TITLE}(?:, \{ \w+: [^}]* \})?\)\.(?:split\)\.toBeNull\(\);|command(?:;|\)\.(?:not\.)?toContain\(.*))`,
    },
  ],
  "test/unit/operations-workspace.test.ts": [
    {
      why: "pins the built workspace's pane titles",
      shape: lineShape`expect\(titles\)\.toEqual\(\[${TITLE}, "monitor", "ticketing"\]\);`,
    },
  ],
  "test/unit/console-restart.test.ts": [
    { why: "pins that the operations plan has a pane of that title", shape: lineShape`expect\(titles\)\.toContain\(${TITLE}\);` },
    {
      why: "resolves the operations pane by its title",
      shape: lineShape`(?:expect\(|const byTitle = )plannedPane\(OPERATIONS_SPEC, OPTS, ${TITLE}\)(?:;|\.command\)\.toContain\(.*)`,
    },
    {
      why: "pins that the pane a worker id resolves to carries that title",
      shape: lineShape`expect\(byWorker\.title\)\.toBe\(${TITLE}\);`,
    },
  ],
};

/**
 * Every file under `rel`, repo-relative. A missing root throws, naming itself,
 * rather than sweeping nothing.
 */
function walk(rel: string): string[] {
  if (!statSync(join(REPO, rel)).isDirectory()) return [rel];
  return readdirSync(join(REPO, rel))
    .sort()
    .flatMap((name) => walk(join(rel, name)));
}

const FILES = SCAN_ROOTS.flatMap(walk).filter((rel) => rel !== SELF);
const TEXT = new Map(FILES.map((rel) => [rel, readFileSync(join(REPO, rel), "utf8")]));

/** 1-based line numbers at which `re` starts a match. `re` must carry the `g` flag. */
function matchLines(text: string, re: RegExp): number[] {
  return [...text.matchAll(re)].map((m) => text.slice(0, m.index).split("\n").length);
}

/**
 * Lines holding `observer:` as a DIRECT child of a `roles` block.
 *
 * A block opens on a line ending `roles:` (YAML), `roles: {` or `roles"] = {`
 * (a fixture object). Its child indentation is that of its first line that is
 * neither blank nor a comment, and the first such line at or left of the opener
 * closes it. Blank and comment lines do neither, so a comment between two roles
 * cannot hide the second. A one-line `{ observer: … }` is caught when the old
 * name is its first key, the only one-line shape the pre-rename tree held.
 */
function roleKeyLines(text: string): number[] {
  const lines = text.split("\n");
  // `[ \t]`, not `\s`: a `\s` here crosses the newline and reports a multi-line block at its opener too.
  const hits = matchLines(text, /\broles["']?\]?[ \t]*[:=][ \t]*\{[ \t]*["']?observer["']?[ \t]*:/g);
  lines.forEach((line, i) => {
    const opener = /^(\s*)(?:\S.*)?\broles["']?\]?\s*[:=]\s*\{?\s*(?:(?:#|\/\/).*)?$/.exec(line);
    if (!opener) return;
    let childIndent: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j]!.trimStart();
      if (body === "" || body.startsWith("#") || body.startsWith("//")) continue;
      const indent = lines[j]!.length - body.length;
      if (indent <= opener[1]!.length) break;
      childIndent ??= indent;
      if (indent === childIndent && /^["']?observer["']?\s*:(\s|$)/.test(body)) hits.push(j + 1);
    }
  });
  return hits.sort((a, b) => a - b);
}

/** A quoted literal, unless `:` follows its closing quote directly (a JSON or YAML key). */
const quotedLiteralLines = (text: string): number[] => matchLines(text, /(["'])observer\1(?!:)/g);

/**
 * The quoted literals in `text` that `rel`'s shapes do not admit. A file with no
 * entry in {@link PANE_TITLE_SITES} has no shapes, so every literal is reported.
 */
function unshapedLiteralLines(text: string, rel = ""): number[] {
  const shapes = Object.hasOwn(PANE_TITLE_SITES, rel) ? PANE_TITLE_SITES[rel]! : [];
  const lines = text.split("\n");
  const found = quotedLiteralLines(text);
  return found.filter((n) => {
    const once = found.filter((m) => m === n).length === 1;
    const line = lines[n - 1]!.trim();
    return !(once && shapes.some(({ shape }) => shape.test(line)));
  });
}

type Form = {
  name: string;
  scope: (rel: string) => boolean;
  /** 1-based lines holding the form. `rel` is the file's repo-relative path; only quotedLiteral reads it. */
  find: (text: string, rel?: string) => number[];
};

const everywhere = (): boolean => true;

const FORMS = {
  roleKey: {
    name: `a role key "${OLD}:" at role indentation, in YAML or a fixture object`,
    scope: everywhere,
    find: roleKeyLines,
  },
  roleValue: {
    name: `"role: ${OLD}" not followed by "-" or a word character`,
    scope: everywhere,
    find: (t) => matchLines(t, /role["']?\s*:\s*["']?observer(?![-\w])/g),
  },
  rolesIndex: {
    name: `roles["${OLD}"] or roles['${OLD}']`,
    scope: everywhere,
    find: (t) => matchLines(t, /roles\[\s*(["'])observer\1\s*\]/g),
  },
  roleGrant: {
    name: `roleGrant(…"${OLD}")`,
    scope: everywhere,
    find: (t) => matchLines(t, /roleGrant\s*\([^)]*?(["'])observer\1\s*,?\s*\)/g),
  },
  promptPath: {
    name: `the path ${OLD_PROMPT}`,
    scope: everywhere,
    find: (t) => matchLines(t, /roles\/observer\.md/g),
  },
  promptPhrase: {
    name: `the phrase "You are \`${OLD}\`"`,
    scope: everywhere,
    find: (t) => matchLines(t, /You are `observer`/g),
  },
  quotedLiteral: {
    name: `a quoted "${OLD}" literal in src/, test/ or scripts/ on no named pane-title line shape`,
    scope: (rel) => ["src/", "test/", "scripts/"].some((root) => rel.startsWith(root)),
    find: unshapedLiteralLines,
  },
} satisfies Record<string, Form>;

/** `file:line: text` for each line, the form every sweep failure names. */
function located(rel: string, found: number[]): string[] {
  const lines = TEXT.get(rel)!.split("\n");
  return found.map((n) => `${rel}:${n}: ${lines[n - 1]!.trim().slice(0, 140)}`);
}

describe("§4.3 layer 2: nothing that means the role still says the old name", () => {
  test("the sweep read every root §4.3 names, nothing under Docs/, and not this file", () => {
    const empty = SCAN_ROOTS.filter((root) => !FILES.some((f) => f === root || f.startsWith(`${root}/`)));
    expect(empty, "scan roots that contributed no file").toEqual([]);
    expect(FILES.filter((f) => f.startsWith("Docs/")), "Docs/ must not be scanned").toEqual([]);
    expect(SELF, "the self-exclusion must name this file").toBe("test/unit/observer-rename.test.ts");
  });

  for (const form of Object.values(FORMS) as Form[]) {
    test(`no ${form.name}`, () => {
      const hits = FILES.filter(form.scope).flatMap((rel) => located(rel, form.find(TEXT.get(rel)!, rel)));
      expect(hits, `found ${form.name}; each entry is file:line`).toEqual([]);
    });
  }

  test("each named file's shapes and its quoted literals agree both ways, so no exemption outlives its reason", () => {
    const named = Object.entries(PANE_TITLE_SITES);
    const idle = named.flatMap(([rel, shapes]) => {
      const lines = (TEXT.get(rel) ?? "").split("\n").map((line) => line.trim());
      return shapes.filter(({ shape }) => !lines.some((line) => shape.test(line))).map(({ why }) => `${rel}: ${why}`);
    });
    expect(idle, "PANE_TITLE_SITES shapes matching no line of their file; remove them").toEqual([]);
    const unshaped = named.flatMap(([rel]) => (TEXT.has(rel) ? located(rel, unshapedLiteralLines(TEXT.get(rel)!, rel)) : []));
    expect(unshaped, "quoted literals in a named file that none of its shapes admits").toEqual([]);
  });
});

/**
 * The tree is clean, so the sweep above passes whether or not a detector works.
 * These cases are what make its green mean something: each form fires on its own
 * spelling and stays quiet on the new name and on the near-misses §4.2 keeps.
 */
describe("each detector fires on its form and stays quiet on the new name", () => {
  const CASES: Record<keyof typeof FORMS, { hit: string[]; miss: string[] }> = {
    roleKey: {
      hit: [
        `roles:\n  sre: {}\n  ${OLD}:\n    tools: [read]\n`,
        `roles:\n  sre: {}\n# a comment between two roles\n  ${OLD}: {}\n`,
        `    roles:\n      ${OLD}: {}\n`,
        `roles: {${OLD}: {}}`,
        `doc["roles"] = { ${OLD}: { pane_mode: "tui" } };`,
        `doc["roles"] = {\n  ${OLD}: { tools: OBSERVER_TOOLS },\n  reviewer: { tools: BASH_LESS_TOOLS },\n};`,
        `const doc = {\n  roles: {\n    // the read-only seat\n    ${OLD}: {\n` +
          `      secrets: [],\n    },\n  },\n};`,
        // A QUOTED role key is this form's, not quotedLiteral's, which lets any quoted key through.
        `roles:\n  "${OLD}":\n    tools: [read]\n`,
        `{"roles": {"${OLD}": {}}}`,
      ],
      miss: [
        "roles:\n  observer-k8s:\n    tools: [read]\n",
        `rows:\n  ${OLD}: obs-t1\n`,
        `roles:\n  triage:\n    ${OLD}: obs-t1\n`,
        `roles:\n  sre: {}\nworkers:\n${OLD}: x\n`,
        'doc["roles"] = { [OBSERVER_K8S_ROLE]: { pane_mode: "tui" } };',
        'doc["roles"] = {\n  "observer-k8s": {},\n};',
        `const row = {\n  ${OLD}: "obs-t1",\n};`,
      ],
    },
    roleValue: {
      hit: [`  - {id: obs-2, role: ${OLD}}`, `{ id: "obs-1", role: "${OLD}" }`, `"role": "${OLD}"`],
      miss: ["  - {id: obs-2, role: observer-k8s}", `role: ${OLD}s`, `role: "${OLD}_blocked"`],
    },
    rolesIndex: {
      hit: [`roles["${OLD}"]`, `roles['${OLD}']`, `cfg.roles[ "${OLD}" ]`],
      miss: ['roles["observer-k8s"]', "roles[OBSERVER_K8S_ROLE]"],
    },
    roleGrant: {
      hit: [`roleGrant(config, "${OLD}")`, `roleGrant(\n  config,\n  '${OLD}',\n)`],
      miss: ['roleGrant(config, "observer-k8s")', "roleGrant(config, OBSERVER_K8S_ROLE)"],
    },
    promptPath: {
      hit: [`append_system_prompt_file: ./${OLD_PROMPT}`, `the failure at ${OLD_PROMPT}:19-22`],
      miss: ["append_system_prompt_file: ./roles/observer-k8s.md"],
    },
    promptPhrase: {
      hit: [`You are \`${OLD}\`, the fleet's read-only diagnostic role.`],
      miss: ["You are `observer-k8s`, the fleet's read-only diagnostic role for Kubernetes."],
    },
    quotedLiteral: {
      hit: [
        `title: "${OLD}",`,
        `const r = '${OLD}';`,
        // A ternary's colon is spaced, so the key carve-out does not reach it.
        `const pick = k8s ? "${OLD}" : "sre";`,
        `if (w.role === "${OLD}") return;`,
      ],
      miss: [
        '"observer-k8s"',
        `the \`${OLD}\` role`,
        "observerTuiWorkers(cfg)",
        // The triage.json row field holding a worker id (§4.2), as JSON and as YAML.
        `{"service": "api", "${OLD}": "obs-t1"}`,
        `'${OLD}': obs-t1`,
      ],
    },
  };

  for (const [key, { hit, miss }] of Object.entries(CASES)) {
    const form: Form = FORMS[key as keyof typeof FORMS];
    test(`${key}: ${form.name}`, () => {
      for (const text of hit) {
        expect(form.find(text), `should fire on ${JSON.stringify(text)}`).not.toEqual([]);
      }
      for (const text of miss) {
        expect(form.find(text), `should stay quiet on ${JSON.stringify(text)}`).toEqual([]);
      }
    });
  }

  test("a hit is reported at the offending line, not the start of its block or file", () => {
    expect(FORMS.roleKey.find(`# head\nroles:\n  sre: {}\n  ${OLD}: {}\n`)).toEqual([4]);
    const multiLine = `doc["roles"] = {\n  ${OLD}: {},\n};\n`;
    expect(FORMS.roleKey.find(multiLine), "not also at the opener").toEqual([2]);
    const seats = `workers:\n  - {id: obs-1, role: sre}\n  - {id: obs-2, role: ${OLD}}\n`;
    expect(FORMS.roleValue.find(seats)).toEqual([3]);
  });

  test("quotedLiteral reaches src/, test/ and scripts/, the named pane-title files included", () => {
    const reached = ["src/run/a.ts", "test/unit/b.test.ts", "scripts/operations", ...Object.keys(PANE_TITLE_SITES)];
    expect(reached.filter((rel) => !FORMS.quotedLiteral.scope(rel)), "should be in scope").toEqual([]);
    const prose = ["roles/triage.md", "skills/observer-ops/SKILL.md", ".claude/skills/fleet/SKILL.md", "fleet.yaml"];
    expect(prose.filter((rel) => FORMS.quotedLiteral.scope(rel)), "should be out of scope").toEqual([]);
  });

  /**
   * The exemption grain, pinned on text rather than on the tree: the tree only
   * holds allowed lines, so the sweep stays green whether or not a shape is tight.
   */
  test("a named file admits a quoted title on a line of ITS allowed shapes and nowhere else", () => {
    const restart = "test/unit/console-restart.test.ts";
    const allowed = `expect(titles).toContain("${OLD}");`;
    const restartText = [
      `    ${allowed}`,
      `    if (w.role === "${OLD}") return;`,
      `    expect(roles.get("obs-1")).toBe("${OLD}");`,
      `    ${allowed} // and "${OLD}"`,
      // operations-plan.ts's shape, in the wrong file.
      `      title: "${OLD}",`,
    ].join("\n");
    expect(FORMS.quotedLiteral.find(restartText, restart)).toEqual([2, 3, 4, 4, 5]);

    // A shape with an open tail still admits exactly one literal per line.
    const planTest = "test/unit/operations-plan.test.ts";
    const tail = `    expect(paneNamed("${OLD}").command).toContain("up");\n` +
      `    expect(paneNamed("${OLD}").command).toContain("${OLD}");`;
    expect(FORMS.quotedLiteral.find(tail, planTest)).toEqual([2, 2]);

    expect(FORMS.quotedLiteral.find(allowed, "test/unit/config.test.ts"), "an unnamed file").toEqual([1]);
  });
});

describe("§4.3 layer 3: the literal new name is pinned once", () => {
  test("OBSERVER_K8S_ROLE is the literal `observer-k8s`", () => {
    expect(OBSERVER_K8S_ROLE, "src/config/schema.ts: OBSERVER_K8S_ROLE").toBe("observer-k8s");
  });

  test("fleet.example.yaml's role set holds observer-k8s and not the old name", async () => {
    const loaded = await loadConfig(join(REPO, "fleet.example.yaml"));
    const roles = Object.keys(loaded.config.roles);
    expect(roles, `fleet.example.yaml declares no observer-k8s role (roles: ${roles.join(", ")})`).toContain(
      "observer-k8s",
    );
    const oldKey = roleKeyLines(TEXT.get("fleet.example.yaml")!).join(",");
    expect(roles, `fleet.example.yaml:${oldKey}: the old role key is back`).not.toContain(OLD);
  });

  test(`roles/observer-k8s.md exists and ${OLD_PROMPT} does not`, () => {
    expect({
      "roles/observer-k8s.md": existsSync(join(REPO, "roles/observer-k8s.md")),
      [OLD_PROMPT]: existsSync(join(REPO, OLD_PROMPT)),
    }).toEqual({ "roles/observer-k8s.md": true, [OLD_PROMPT]: false });
  });

  /**
   * The existing expectation in `test/unit/config.test.ts`, loaded the same way.
   * Red if the predicate and the config disagree about the name.
   */
  test("observerTuiWorkers on the example returns obs-1", async () => {
    const loaded = await loadConfig(join(REPO, "fleet.example.yaml"));
    expect(observerTuiWorkers(loaded.config), "fleet.example.yaml: observerTuiWorkers").toEqual(["obs-1"]);
  });
});
