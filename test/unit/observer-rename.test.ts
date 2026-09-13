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
 * Every form in {@link FORMS} reads every scanned file, with two exceptions.
 * The quoted literal reads `src/`, `test/` and `scripts/` only; the scripts are
 * extensionless Bun TypeScript, so the scope is by directory, not extension.
 * The docs form reads `skills/`, `roles/` and `.claude/skills/fleet/` only, the
 * worker and operator documents where §4.1 found the role named in markdown.
 *
 * The docs form reads three shapes, each the name used as an identifier and none
 * of them a sentence: the backticked name followed by `'s` or a hyphen
 * (`` `observer`'s ``, `` `observer`-specific ``); a table cell holding the name
 * alone, bare, bold or backticked; and a comma list with a role name beside it,
 * as in `(observer, verifier, ticketing)`. Role names are read off the prompts
 * in `roles/`, so an English list such as "one file per observer, read-only"
 * stays quiet.
 *
 * Three things are deliberately NOT guarded:
 *
 * - **English prose, the phrase "observer role" included.** "The observer" in a
 *   comment, a role prompt or a skill is §4.2's seat that looks, and §4.2 lets
 *   English stay. A form reading "observer role" would refuse legitimate future
 *   sentences, so no form reads words.
 * - **Backtick spans outside the docs form's shapes.** The quoted-literal form
 *   covers `"` and `'` only, and the index form reads a backticked index only.
 *   Docblocks and documents name the role in backticks as English dozens of
 *   times.
 * - **One §4.1 row, the named residual.** On the pre-rename tree (909f817),
 *   `skills/observer-ops/SKILL.md:3` read "How the observer role writes …" and
 *   "Mounted for the observer role." Both are English, so nothing here catches
 *   that row. Its text is a pinned miss in the detector cases, so the gap stays
 *   visible.
 *
 * ## Five traps the detectors are built around
 *
 * **Word boundaries.** `\b` after `observer` matches `observer-k8s`, because
 * `\b` sits between `r` and `-`. Every form ending in the bare name anchors
 * with `(?![-\w])` or a closing quote or backtick instead.
 *
 * **Newlines.** Swept text is a whole file, so `\s` crosses lines. Where a
 * match must stay on one line it spells `[ \t]`, or it reads one line at a time.
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
 * A `roles` map opens as a YAML key, a fixture key or assignment, or a typed
 * declaration (`const roles: Record<string, RoleDoc> = {`), with its `{` on the
 * same line or alone on the next. A map written on one line is read key by key
 * at depth one, so `{sre: {}, observer: {}}` fires and `{sre: {observer:
 * obs-t1}}` does not.
 *
 * **A quoted key is not a quoted literal.** The same row field is a quoted key
 * in JSON, as in `{"service": "api", "observer": "obs-t1"}`. The quoted-literal
 * form lets a literal through when `:` follows its closing quote directly.
 * The colon must be adjacent, so a ternary's spaced ` : ` still fires. A quoted
 * ROLE key is still refused, by the role-key form, which reads structure
 * instead of quotes.
 *
 * **A variable named for the seat is not the role.** `src/run/triage-verdict.ts`
 * holds a variable called `observer`, so a `role:` whose value is
 * `observer.role` reads a property, not the role name. The role-value form lets
 * the bare name through when `.` or `?.` and an identifier follow it.
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
 * Every regular file under `rel`, relative to `root`. Below the root, only
 * directories and regular files are read: a symlink is skipped, so a dangling
 * link or a loop cannot crash module load. A missing root throws, naming itself,
 * rather than sweeping nothing.
 */
function walk(rel: string, root = REPO): string[] {
  if (!statSync(join(root, rel)).isDirectory()) return [rel];
  return readdirSync(join(root, rel), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ path: join(rel, entry.name), dir: entry.isDirectory() }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .flatMap(({ path, dir }) => (dir ? walk(path, root) : [path]));
}

const FILES = SCAN_ROOTS.flatMap((root) => walk(root)).filter((rel) => rel !== SELF);
const TEXT = new Map(FILES.map((rel) => [rel, readFileSync(join(REPO, rel), "utf8")]));

/** 1-based line numbers at which `re` starts a match. `re` must carry the `g` flag. */
function matchLines(text: string, re: RegExp): number[] {
  return [...text.matchAll(re)].map((m) => text.slice(0, m.index).split("\n").length);
}

/**
 * `roles` opening a map, as regex source matched against ONE line: a key or an
 * assignment (`roles:`, `doc["roles"] =`), or a typed declaration
 * (`const roles: Record<string, RoleDoc> =`). The type is a name with optional
 * generic arguments, so `{ roles: someVar, x: 1 }; const y =` does not open one.
 */
const ROLES_OPENER = String.raw`\broles(?:["']?\]?\s*[:=]|\s*:\s*[\w.]+(?:<[^=;]*>)?(?:\[\])?\s*=)`;
/** A line ending at the opener or its `{`: the map's keys are on the lines below. */
const BLOCK_OPENER = new RegExp(String.raw`^(\s*)(?:\S.*)?${ROLES_OPENER}\s*(\{\s*)?(?:(?:#|\/\/).*)?$`);
/** An opener and its `{` on one line; the rest of the line is a flow map to read. */
const FLOW_OPENER = new RegExp(String.raw`${ROLES_OPENER}\s*\{`, "g");
/** The old name as a key, starting exactly at `lastIndex`. */
const OLD_KEY = /[ \t]*["']?observer["']?[ \t]*:/y;

function oldKeyAt(text: string, at: number): boolean {
  OLD_KEY.lastIndex = at;
  return OLD_KEY.test(text);
}

/** Neither blank nor a comment. */
const significant = (line: string): boolean => !/^\s*(?:$|#|\/\/)/.test(line);

/**
 * Whether a flow map holds the old name as a DIRECT key. `rest` is its line after
 * the `{`. Depth counts every bracket, so a key nested under a role is not read,
 * and a quoted span closed on the line is skipped whole, so a brace inside a
 * string cannot end the map early.
 */
function flowMapHoldsOldKey(rest: string): boolean {
  let depth = 1;
  for (let i = -1; i < rest.length; i++) {
    const ch = i < 0 ? "," : rest[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = rest.indexOf(ch, i + 1);
      if (close !== -1) i = close;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      if (--depth === 0) return false;
    } else if (ch === "," && depth === 1 && oldKeyAt(rest, i + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Lines holding `observer:` as a DIRECT key of a `roles` map.
 *
 * A map opened by {@link ROLES_OPENER} is read one of three ways. With `{` and
 * more on the same line, the rest of the line is a flow map, read key by key.
 * With the line ending at the opener or its `{`, the map is a block: its child
 * indentation is that of its first line that is neither blank nor a comment, and
 * the first such line at or left of the opener closes it. Blank and comment lines
 * do neither, so a comment between two roles cannot hide the second. With no `{`
 * on the opener and one starting the next such line, that line is read as a flow
 * map and the block's children must sit deeper than it.
 */
function roleKeyLines(text: string): number[] {
  const lines = text.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(FLOW_OPENER)) {
      if (flowMapHoldsOldKey(line.slice(m.index! + m[0].length))) hits.push(i + 1);
    }
    const opener = BLOCK_OPENER.exec(line);
    if (!opener) return;
    let base = opener[1]!.length;
    let j = i + 1;
    while (j < lines.length && !significant(lines[j]!)) j++;
    const brace = lines[j]?.trimStart() ?? "";
    if (opener[2] === undefined && brace.startsWith("{")) {
      if (flowMapHoldsOldKey(brace.slice(1))) hits.push(j + 1);
      base = lines[j]!.length - brace.length;
      j++;
    }
    let childIndent: number | undefined;
    for (; j < lines.length; j++) {
      if (!significant(lines[j]!)) continue;
      const body = lines[j]!.trimStart();
      const indent = lines[j]!.length - body.length;
      if (indent <= base) break;
      childIndent ??= indent;
      if (indent === childIndent && oldKeyAt(body, 0)) hits.push(j + 1);
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

/** Role names, read off the prompts in `roles/`: each one there is named for its role (§4.1). */
const ROLE_NAMES = FILES.flatMap((rel) => /^roles\/([^/]+)\.md$/.exec(rel)?.slice(1) ?? []);

/**
 * The old name used as the role's name in a document, in three shapes; see the
 * header. Each is read within one line, and a line is reported once.
 */
function docsRoleNameLines(text: string): number[] {
  const names = ROLE_NAMES.join("|");
  const shapes = [
    /`observer`(?:['’]s|-[A-Za-z])/g,
    /(?<=\|)[ \t]*(\*\*|`)?observer\1[ \t]*(?=\|)/g,
    new RegExp(String.raw`(?<![-\w])observer\x60?[ \t]*,[ \t]*(?:(?:and|or)[ \t]+)?\x60?(?:${names})(?![-\w])`, "g"),
    new RegExp(String.raw`(?<![-\w])(?:${names})\x60?[ \t]*,[ \t]*(?:(?:and|or)[ \t]+)?\x60?observer(?![-\w])`, "g"),
  ];
  return [...new Set(shapes.flatMap((re) => matchLines(text, re)))].sort((a, b) => a - b);
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
    name: `"role: ${OLD}" on one line, not followed by "-", a word character or a property access`,
    scope: everywhere,
    find: (t) => matchLines(t, /role["']?[ \t]*:[ \t]*["']?observer(?![-\w]|\??\.[A-Za-z_$])/g),
  },
  rolesIndex: {
    name: `roles.${OLD} or roles["${OLD}"], in any quote and optionally chained`,
    scope: everywhere,
    find: (t) => matchLines(t, /roles(?:\??\.observer(?![-\w])|(?:\?\.)?\[\s*(["'`])observer\1\s*\])/g),
  },
  roleGrant: {
    name: `roleGrant(…"${OLD}")`,
    scope: everywhere,
    find: (t) => matchLines(t, /roleGrant\s*\([^)]*?(["'])observer\1\s*(?:,\s*)?\)/g),
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
    name: `a quoted "${OLD}" literal in src/, test/ or scripts/ outside the named pane-title line shapes`,
    scope: (rel) => ["src/", "test/", "scripts/"].some((root) => rel.startsWith(root)),
    find: unshapedLiteralLines,
  },
  docsRoleName: {
    name: `the role name ${OLD} in worker or operator docs as a backticked name, a table cell or a comma list of roles`,
    scope: (rel) => ["skills/", "roles/", ".claude/skills/fleet/"].some((root) => rel.startsWith(root)),
    find: docsRoleNameLines,
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

  for (const form of Object.values(FORMS)) {
    test(`no line holds ${form.name}`, () => {
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
  /**
   * §4.1's worker- and operator-document rows, verbatim from the pre-rename tree
   * (909f817) with the old name spliced back in. Before the docs form, no form
   * caught any of them.
   */
  const PRE_RENAME_DOC_LINES = {
    "skills/observer-ops/SKILL.md:8":
      "**Scope of this file, stated up front.** This bundle exists so `" + OLD + "`'s `fleet.yaml` entry",
    "skills/observer-ops/SKILL.md:23":
      "is absent — an envelope written with no `" + OLD + "`-specific fields at all still runs as an",
    "skills/pifleet-worker/SKILL.md:15":
      "| `/workspace` | your checkout of the repo, on a branch created for you. **Whether it exists and whether it " +
      "is writable depend on your role.** A `worktree` role gets its own writable checkout and may commit; a " +
      "`shared-ro` role (the reviewer) gets the operator's checkout mounted **read-only**; a `none` role (" +
      OLD +
      ", verifier, ticketing) gets **no `/workspace` at all** and works against live systems. An absent or " +
      "read-only `/workspace` is your role, not a fault |",
    ".claude/skills/fleet/SKILL.md:102":
      "| `obs-1` | " + OLD + " | operations | `base` | read-only cluster/log questions; has cloud access |",
    ".claude/skills/fleet/SKILL.md:109":
      "| `obs-t1`, `obs-t2`, `obs-t3` | **" +
      OLD +
      "** | triage | `base` | three seats under the one collator, each handed a share of the environment and " +
      "never the whole list. They run CONCURRENTLY against one deadline, so the sweep costs the largest share " +
      "rather than the sum. Same model; `tools: [read, write, bash, grep, find, ls, submit_report]` |",
  };

  /** §4.1's `skills/observer-ops/SKILL.md:3` row, verbatim from 909f817. English, so the named residual. */
  const PRE_RENAME_RESIDUAL =
    "description: How the " +
    OLD +
    " role writes its result — the observer-ops.json/.md artifact pair, the deploy and inquiry task shapes, and " +
    "where the fuller procedural content (target resolution, channel reconciliation, the degradation ladder) " +
    "belongs. Mounted for the " +
    OLD +
    " role.";

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
        // A flow map whose old key is not first, in YAML and in TS.
        `roles: {sre: {}, ${OLD}: {}}`,
        `const doc = { roles: { sre: { tools: [read] }, ${OLD}: {} } };`,
        // No space after the colon.
        `const doc = {\n  roles: {\n    ${OLD}:{},\n  },\n};`,
        // A typed opener, across lines and on one line.
        `const roles: Record<string, RoleDoc> = {\n  ${OLD}: { tools: [] },\n};`,
        `const roles: Record<string, RoleDoc> = { sre: {}, ${OLD}: {} };`,
        // The opening brace on the line after the opener, as a block and as a flow map.
        `const doc = {\n  roles:\n  {\n    ${OLD}: {},\n  },\n};`,
        `roles:\n  {sre: {}, ${OLD}: {}}\n`,
      ],
      miss: [
        "roles:\n  observer-k8s:\n    tools: [read]\n",
        `rows:\n  ${OLD}: obs-t1\n`,
        `roles:\n  triage:\n    ${OLD}: obs-t1\n`,
        `roles:\n  sre: {}\nworkers:\n${OLD}: x\n`,
        'doc["roles"] = { [OBSERVER_K8S_ROLE]: { pane_mode: "tui" } };',
        'doc["roles"] = {\n  "observer-k8s": {},\n};',
        `const row = {\n  ${OLD}: "obs-t1",\n};`,
        `const row = { ${OLD}: "obs-t1" };`,
        // A key nested under a role is not a role key, on one line or across lines.
        `roles: {sre: {${OLD}: obs-t1}}`,
        `const doc = { roles: { triage: { ${OLD}: "obs-t1" } } };`,
        `const roles: Record<string, RoleDoc> = {\n  triage: {\n    ${OLD}: "obs-t1",\n  },\n};`,
        "roles: {sre: {}, observer-k8s: {}}",
      ],
    },
    roleValue: {
      hit: [
        `  - {id: obs-2, role: ${OLD}}`,
        `{ id: "obs-1", role: "${OLD}" }`,
        `"role": "${OLD}"`,
        `role: ${OLD} # the read-only seat`,
      ],
      miss: [
        "  - {id: obs-2, role: observer-k8s}",
        `role: ${OLD}s`,
        `role: "${OLD}_blocked"`,
        // A bare role key, then a row field on the next line: the value does not cross the newline.
        `role:\n  ${OLD}: obs-t1\n`,
        // A property of a variable named for the seat, as src/run/triage-verdict.ts holds.
        `const seat = { role: ${OLD}.role };`,
        `const seat = { role: ${OLD}?.role };`,
      ],
    },
    rolesIndex: {
      hit: [
        `roles["${OLD}"]`,
        `roles['${OLD}']`,
        `cfg.roles[ "${OLD}" ]`,
        `cfg.roles.${OLD}`,
        `const stale = cfg.roles.${OLD};`,
        `roles?.${OLD}`,
        `roles?.["${OLD}"]`,
        `roles[\`${OLD}\`]`,
      ],
      miss: [
        'roles["observer-k8s"]',
        "roles[OBSERVER_K8S_ROLE]",
        "roles.observer-k8s",
        `roles.${OLD}s`,
        "roles[`observer-k8s`]",
        "roles?.[OBSERVER_K8S_ROLE]",
      ],
    },
    roleGrant: {
      hit: [`roleGrant(config, "${OLD}")`, `roleGrant(\n  config,\n  '${OLD}',\n)`, `roleGrant(config, "${OLD}",)`],
      miss: [
        'roleGrant(config, "observer-k8s")',
        "roleGrant(config, OBSERVER_K8S_ROLE)",
        `roleGrant(config, "${OLD}", extra)`,
      ],
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
    docsRoleName: {
      hit: [
        ...Object.values(PRE_RENAME_DOC_LINES),
        `the \`${OLD}\`’s brief`,
        `| \`${OLD}\` | read-only |`,
        `a \`none\` role (sre, ${OLD})`,
        `the ${OLD}, verifier and ticketing roles`,
        `| \`obs-9\` | ${OLD} | operations | \`base\` |`,
      ],
      miss: [
        PRE_RENAME_RESIDUAL,
        "How the observer-k8s role writes its result",
        "This bundle exists so `observer-k8s`'s `fleet.yaml` entry",
        "no `observer-k8s`-specific fields",
        "a `none` role (observer-k8s, verifier, ticketing)",
        "| `obs-1` | observer-k8s | operations | `base` |",
        "| `obs-t1` | **observer-k8s** | triage | `base` |",
        `the \`${OLD}\` role`,
        `| \`${OLD}_blocked\` | an incident kind |`,
        `| **DispatchTask** | "use tick-1", "ask the ${OLD}" | \`Workflows/DispatchTask.md\` |`,
        // English lists that hold the word beside something that is not a role, as roles/triage.md does.
        `| ONE entry per ${OLD}, all in ONE file | one entry for each seat |`,
        `\`/replies/<child-task-id>.json\`, one file per ${OLD}, read-only.`,
        `the ${OLD}, the collator and the reviewer`,
        // The triage.json row field in a documented example.
        `      "${OLD}": "obs-t1",`,
      ],
    },
  };

  for (const [key, { hit, miss }] of Object.entries(CASES)) {
    const form: Form = FORMS[key as keyof typeof FORMS];
    test(`${key}: ${form.name}`, () => {
      const wrong = [
        ...hit.filter((text) => form.find(text).length === 0).map((text) => `should fire on ${JSON.stringify(text)}`),
        ...miss.filter((text) => form.find(text).length > 0).map((text) => `should stay quiet on ${JSON.stringify(text)}`),
      ];
      expect(wrong, `${key}: the cases this detector gets wrong`).toEqual([]);
    });
  }

  test("a hit is reported at the offending line, not the start of its block or file", () => {
    expect(FORMS.roleKey.find(`# head\nroles:\n  sre: {}\n  ${OLD}: {}\n`)).toEqual([4]);
    const multiLine = `doc["roles"] = {\n  ${OLD}: {},\n};\n`;
    expect(FORMS.roleKey.find(multiLine), "not also at the opener").toEqual([2]);
    const seats = `workers:\n  - {id: obs-1, role: sre}\n  - {id: obs-2, role: ${OLD}}\n`;
    expect(FORMS.roleValue.find(seats)).toEqual([3]);
    expect(FORMS.roleKey.find(`# head\nroles: {sre: {}, ${OLD}: {}}\n`), "a flow map").toEqual([2]);
    const nextLineBrace = `const doc = {\n  roles:\n  {\n    sre: {},\n    ${OLD}: {},\n  },\n};`;
    expect(FORMS.roleKey.find(nextLineBrace), "a brace on the line after the opener").toEqual([5]);
    const typed = `const roles: Record<string, RoleDoc> = {\n  sre: {},\n  ${OLD}: {},\n};`;
    expect(FORMS.roleKey.find(typed), "a typed opener").toEqual([3]);
    const table = `| Worker | Role |\n|---|---|\n| \`obs-1\` | ${OLD} |\n`;
    expect(FORMS.docsRoleName.find(table), "a table cell").toEqual([3]);
  });

  test("quotedLiteral reaches src/, test/ and scripts/, the named pane-title files included", () => {
    const reached = ["src/run/a.ts", "test/unit/b.test.ts", "scripts/operations", ...Object.keys(PANE_TITLE_SITES)];
    expect(reached.filter((rel) => !FORMS.quotedLiteral.scope(rel)), "should be in scope").toEqual([]);
    const prose = ["roles/triage.md", "skills/observer-ops/SKILL.md", ".claude/skills/fleet/SKILL.md", "fleet.yaml"];
    expect(prose.filter((rel) => FORMS.quotedLiteral.scope(rel)), "should be out of scope").toEqual([]);
  });

  test("docsRoleName reaches skills/, roles/ and .claude/skills/fleet/, and nothing else", () => {
    const docs = ["skills/observer-ops/SKILL.md", "roles/triage.md", ".claude/skills/fleet/Workflows/Triage.md"];
    expect(docs.filter((rel) => !FORMS.docsRoleName.scope(rel)), "should be in scope").toEqual([]);
    const code = ["src/run/a.ts", "test/unit/b.test.ts", "scripts/operations", "fleet.yaml", "Docs/SRD-OBSERVER-ROLES.md"];
    expect(code.filter((rel) => FORMS.docsRoleName.scope(rel)), "should be out of scope").toEqual([]);
    expect(ROLE_NAMES, "the comma-list shape's role names, read off roles/*.md").toContain("observer-k8s");
    expect(ROLE_NAMES, "a role name the pre-rename list held beside the old one").toContain("verifier");
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

/** The sweep walks at module load, so a walk that throws takes every test in this file down with it. */
describe("the walk skips symlinks and still refuses a missing root", () => {
  function inScratch(check: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "observer-rename-walk-"));
    try {
      mkdirSync(join(root, "tree", "sub"), { recursive: true });
      writeFileSync(join(root, "tree", "sub", "file.md"), "");
      check(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a dangling link under a root is skipped", () => {
    inScratch((root) => {
      symlinkSync(join(root, "missing"), join(root, "tree", "dangling"));
      expect(walk("tree", root)).toEqual([join("tree", "sub", "file.md")]);
    });
  });

  test("a link back up the tree is skipped, not followed", () => {
    inScratch((root) => {
      symlinkSync(join(root, "tree"), join(root, "tree", "sub", "loop"));
      expect(walk("tree", root)).toEqual([join("tree", "sub", "file.md")]);
    });
  });

  test("a missing root throws, naming itself", () => {
    inScratch((root) => {
      expect(() => walk("absent-root", root)).toThrow("absent-root");
    });
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
