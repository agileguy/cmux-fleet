/**
 * A small structural reader for TypeScript source, used where a control has to
 * be pinned by its SHAPE because its BEHAVIOUR does not distinguish it.
 *
 * ISC-254 is the case that forced this. `timingSafeEqual` and `===` return the
 * same booleans for the same inputs by construction — the whole point of the
 * constant-time comparator is that it is behaviourally indistinguishable — so
 * the only runtime signal is a timing measurement, and a timing assertion is
 * far too flaky to gate CI on. What CAN be asserted is that the auth path calls
 * the comparator, and that is a fact about the source text.
 *
 * ## Why comments are stripped first, and why that is the entire design
 *
 * A structural probe that greps the raw file is worse than no probe. The header
 * of `src/container/image.ts` records what this repo already did to itself:
 * three docstrings in one module asserted controls the code did not have, and a
 * grep for a control's NAME finds the docstring that promises it just as
 * happily as the call that implements it. `src/security/control-auth.ts` says
 * "`timingSafeEqual` compares every byte unconditionally" in prose at line 127,
 * so a raw grep for `timingSafeEqual` in that file passes even if the body is
 * `return expected === provided`. Everything here therefore runs on
 * comment-stripped text, and `stripComments` is fixture-tested on exactly that
 * confusion.
 *
 * ## Deliberate limits
 *
 * This is a scanner, not a parser, and it is used only on files in this repo
 * that it is exercised against.
 *
 *   - Regex literals are not tracked. A regex containing `//` or an unbalanced
 *     quote would confuse `stripComments`. No such literal exists in the files
 *     read here, and a fixture would catch it if one appeared.
 *   - `functionBody` finds `function <name>(` — declarations, not arrow
 *     constants or methods — and takes the first `{` after the parameter list.
 *     A return-type annotation that is an inline object type would be read as
 *     the body. Both targets return `boolean` and `AuthRefusal | null`.
 *   - `strictComparisons` scrapes operands textually rather than building an
 *     AST, so it reports `a.length` and `b.length` as written and does not
 *     resolve anything.
 *
 * Each limit is stated because a scanner whose limits are undocumented becomes
 * a scanner nobody can safely extend, and then it becomes a scanner nobody
 * trusts, and then it is deleted along with the control it was holding.
 */

/**
 * `source` with `//` and block comments removed and everything else preserved.
 *
 * String and template literals survive intact, so a `"//"` inside a string is
 * not mistaken for a comment. Newlines inside block comments are re-emitted so
 * that line numbers computed from the result still refer to the real file.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < source.length) {
        const ch = source[i] ?? "";
        out += ch;
        i += 1;
        if (ch === "\\") {
          if (i < source.length) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (ch === c) break;
      }
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Advance past a string literal that starts at `i`, returning the index after it. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

/**
 * The `{ … }` body of `function <name>`, braces included, or null if absent.
 *
 * Pass comment-stripped text: a `}` inside a comment would otherwise close the
 * body early and the caller would assert over a truncated fragment, which fails
 * open in the direction that matters.
 */
export function functionBody(strippedSource: string, name: string): string | null {
  const decl = new RegExp(String.raw`\bfunction\s+${name}\s*\(`).exec(strippedSource);
  if (decl === null) return null;

  // Walk out of the parameter list first — a default value can contain braces.
  let i = decl.index + decl[0].length;
  let parens = 1;
  while (i < strippedSource.length && parens > 0) {
    const c = strippedSource[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(strippedSource, i);
      continue;
    }
    if (c === "(") parens += 1;
    else if (c === ")") parens -= 1;
    i += 1;
  }

  while (i < strippedSource.length && strippedSource[i] !== "{") i += 1;
  if (i >= strippedSource.length) return null;

  const open = i;
  let depth = 0;
  while (i < strippedSource.length) {
    const c = strippedSource[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(strippedSource, i);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return strippedSource.slice(open, i + 1);
    }
    i += 1;
  }

  return null;
}

/** Every `name(` call in `text`, by callee name, in source order and with repeats. */
export function callsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

/** One `===`/`!==` occurrence with its operands as written. */
export interface StrictComparison {
  readonly left: string;
  readonly op: "===" | "!==";
  readonly right: string;
  /** `left op right`, for a failure message that shows the code. */
  readonly text: string;
}

/**
 * Every `===`/`!==` in `text`, with the operand text on each side.
 *
 * Used to say something a keyword grep cannot: not "is `timingSafeEqual`
 * mentioned" but "is anything in this function comparing the two secrets with
 * a short-circuiting operator". `a.length !== b.length` is reported as written,
 * so a caller can allow a length comparison while refusing a content one.
 */
export function strictComparisons(text: string): StrictComparison[] {
  const out: StrictComparison[] = [];
  const pattern = /([A-Za-z_$][\w$.]*(?:\[[^\]]*\])?)\s*(===|!==)\s*([A-Za-z_$][\w$.]*(?:\[[^\]]*\])?)/g;
  for (const m of text.matchAll(pattern)) {
    const left = m[1];
    const op = m[2];
    const right = m[3];
    if (left === undefined || right === undefined) continue;
    if (op !== "===" && op !== "!==") continue;
    out.push({ left, op, right, text: `${left} ${op} ${right}` });
  }
  return out;
}
