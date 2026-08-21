/**
 * NO DURABLE READER PARSES FILE BYTES WITH A SCHEMA OUTSIDE A `try` (ISC-192).
 *
 * ## Why this is a source scan and not a list of readers
 *
 * `durable-format-refusal.test.ts` drives the readers this tree has today and
 * asserts each one refuses by name. That is the behavioural half, and it is
 * the half that can say a diagnosis is CORRECT. What it cannot do is notice a
 * reader that does not exist yet. ISC-192 was itself three readers, written at
 * three different times, each repeating the same one-line shape:
 *
 *     XSchema.parse(JSON.parse(await file.text()))
 *
 * A hand-written list would have named whichever two existed when it was
 * written. So this file asks the question structurally instead: find every
 * schema parse whose input came off the disk, and require that a `try`
 * encloses it. A NEW reader written in that shape anywhere under `src/` fails
 * this test on the day it is committed, with no edit here.
 *
 * ## WHAT THIS GUARD DOES NOT PROVE — read this before trusting a pass
 *
 * It is a wrapping check, not a diagnosis check. Stated plainly because a
 * green suite is exactly what makes an incomplete guard look finished:
 *
 *  - **A `try` whose `catch` rethrows the raw error passes.** Deciding whether
 *    a catch block produces a NAMED diagnosis rather than
 *    `throw err` or `` `${err}` `` needs dataflow into the catch body, and a
 *    rule that guessed would be wrong in both directions. That property is
 *    pinned per reader, by hand, in the behavioural suites — which means the
 *    "named diagnosis" half of ISC-192 IS enumerated and WILL rot. It is not
 *    covered here.
 *  - **Dataflow is intra-function only.** `const doc = await f.json()` then
 *    `S.parse(doc)` is followed inside one function body. A helper that
 *    returns already-parsed JSON across a function boundary is invisible to
 *    this scan.
 *  - **Only callees whose object name ends in `Schema` are considered.** A
 *    reader that aliases a schema to another name is missed.
 *  - **`safeParse` is out of scope** — it returns rather than throws. A reader
 *    that calls `safeParse` and then does `throw result.error` leaks a bare
 *    `ZodError` and this guard says nothing about it.
 *
 * Every one of those limits fails toward MISSING a violation rather than
 * inventing one, which is the right direction for a guard that gates a suite —
 * but it means a pass here is "no reader is unwrapped", not "no `ZodError` can
 * escape".
 *
 * ## Why the positive controls exist
 *
 * The real scan over `src/` is expected to return an EMPTY list, and an empty
 * list is indistinguishable from a scanner that matches nothing at all. The
 * synthetic fixtures below are the non-vacuity proof: each is a file the
 * scanner MUST flag, and each corresponds to a shape that really occurred in
 * this tree. Delete the detection logic and those fail, whatever the real
 * source tree happens to contain.
 *
 * No subprocess is spawned anywhere in this file — every case is a string
 * parsed in memory — so no `budget.ts` allowance applies.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as ts from "typescript";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Call expressions that mean "these bytes came off the disk".
 *
 * `JSON.parse` is included because it is the boundary in practice: every
 * shape ISC-192 found reached the schema through it, and a `JSON.parse` of
 * anything is a parse of untrusted text whether or not this scan can see the
 * file read behind it.
 */
const READ_CALLS = new Set(["json", "text", "readFile", "arrayBuffer", "bytes"]);

/** True when `node`'s subtree contains a file read or a `JSON.parse`. */
function isFileDerived(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c) && READ_CALLS.has(c.name.text)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(c) && READ_CALLS.has(c.text)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(c) &&
        c.name.text === "parse" &&
        ts.isIdentifier(c.expression) &&
        c.expression.text === "JSON"
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function enclosingFunction(n: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = n.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function isAncestor(a: ts.Node, b: ts.Node): boolean {
  let cur: ts.Node | undefined = b;
  while (cur) {
    if (cur === a) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * True when a `try` BLOCK (not a `catch`, not a `finally`) encloses `n`.
 *
 * The distinction matters: a schema parse inside a `catch` is not protected by
 * the `try` it belongs to, and reporting it as wrapped would be exactly the
 * false negative this guard is for.
 */
function inTryBlock(n: ts.Node): boolean {
  let cur: ts.Node | undefined = n.parent;
  while (cur) {
    if (ts.isTryStatement(cur) && isAncestor(cur.tryBlock, n)) return true;
    cur = cur.parent;
  }
  return false;
}

export interface ParseSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly wrapped: boolean;
}

/** Every file-derived `*Schema.parse(...)` in one source file. */
function scanSource(abs: string, rel: string): ParseSite[] {
  const sf = ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const sites: ParseSite[] = [];

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "parse" &&
      /Schema$/.test(n.expression.expression.getText(sf))
    ) {
      const arg = n.arguments[0];
      if (arg !== undefined) {
        let derived = isFileDerived(arg);
        // The two-step shape: `const doc = JSON.parse(await f.text())` and
        // then `S.parse(doc)` further down the same function body.
        if (!derived && ts.isIdentifier(arg)) {
          const fn = enclosingFunction(n);
          if (fn !== null) {
            const name = arg.text;
            const scan = (m: ts.Node): void => {
              if (
                ts.isVariableDeclaration(m) &&
                ts.isIdentifier(m.name) &&
                m.name.text === name &&
                m.initializer !== undefined &&
                isFileDerived(m.initializer)
              ) {
                derived = true;
              }
              if (
                ts.isBinaryExpression(m) &&
                ts.isIdentifier(m.left) &&
                m.left.text === name &&
                isFileDerived(m.right)
              ) {
                derived = true;
              }
              ts.forEachChild(m, scan);
            };
            scan(fn);
          }
        }
        if (derived) {
          sites.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            text: n.getText(sf).slice(0, 90).replace(/\s+/g, " "),
            wrapped: inTryBlock(n),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function scanTree(): ParseSite[] {
  return walk(join(ROOT, "src")).flatMap((f) => scanSource(f, relative(ROOT, f)));
}

const describeSite = (s: ParseSite): string => `${s.file}:${s.line}  ${s.text}`;

describe("no durable reader parses file bytes with a schema outside a try", () => {
  test("src/ has no unwrapped file-derived schema parse", () => {
    const unwrapped = scanTree().filter((s) => !s.wrapped);
    expect(unwrapped.map(describeSite)).toEqual([]);
  });

  /**
   * The scan must actually be LOOKING at something. An empty violation list
   * over a tree the scanner failed to parse is the same green as a clean one.
   */
  test("the scan finds the readers it is supposed to be guarding", () => {
    const sites = scanTree();
    expect(sites.length).toBeGreaterThanOrEqual(4);
    const files = new Set(sites.map((s) => s.file));
    // The three readers ISC-192 named, by file. If a reader moves, this fails
    // and someone re-points it deliberately rather than losing the coverage.
    expect(files).toContain("src/security/control-auth.ts");
    expect(files).toContain("src/attended/mode.ts");
    expect(files).toContain("src/report/collect.ts");
    expect(sites.every((s) => s.wrapped)).toBe(true);
  });
});

/**
 * Positive controls: shapes the scanner MUST flag.
 *
 * These are the non-vacuity proof. Each fixture is a real shape from this
 * tree's history, and each fails if the detection logic is weakened.
 */
describe("the detector itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "pifleet-readerscan-"));
  function scan(body: string, name = "f.ts"): ParseSite[] {
    const p = join(dir, name);
    writeFileSync(p, body, "utf8");
    return scanSource(p, name);
  }

  test("flags the one-liner ISC-192 found three times", () => {
    const sites = scan(`
      export async function read() {
        return XSchema.parse(JSON.parse(await Bun.file(p).text()));
      }
    `);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.wrapped).toBe(false);
  });

  test("flags the .json() spelling too", () => {
    const sites = scan(`
      export async function read() {
        return XSchema.parse(await Bun.file(p).json());
      }
    `, "b.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.wrapped).toBe(false);
  });

  test("follows a local binding — the two-step shape", () => {
    const sites = scan(`
      export async function read() {
        const doc = JSON.parse(await f.text());
        return XSchema.parse(doc);
      }
    `, "c.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.wrapped).toBe(false);
  });

  test("accepts a parse inside a try", () => {
    const sites = scan(`
      export async function read() {
        const doc = JSON.parse(await f.text());
        try {
          return XSchema.parse(doc);
        } catch (err) {
          throw new NamedError(err);
        }
      }
    `, "d.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.wrapped).toBe(true);
  });

  test("a parse in the CATCH is not protected by its own try", () => {
    // The false negative worth having a test for: `catch` is not `tryBlock`.
    const sites = scan(`
      export async function read() {
        try {
          return await other();
        } catch {
          return XSchema.parse(JSON.parse(await f.text()));
        }
      }
    `, "e.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.wrapped).toBe(false);
  });

  test("ignores a WRITER — validating an in-memory record on the way out", () => {
    // `writeJsonAtomic(path, XSchema.parse(record))` must not be flagged: a
    // throw there is correct, and demanding a try would be noise.
    const sites = scan(`
      export async function write(record) {
        await writeJsonAtomic(p, XSchema.parse(record));
        return XSchema.parse({ schema: "x/v1", a: 1 });
      }
    `, "g.ts");
    expect(sites).toEqual([]);
  });
});
