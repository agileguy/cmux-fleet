/**
 * Blank out TypeScript comments so a text search can tell code from prose.
 *
 * ## The defect this exists for
 *
 * `isa-claims.ts` defends the ISA's grounds by grepping the source. A grep is
 * a text search over bytes, and it cannot tell a line of code from a line of
 * comment — so a claim can be satisfied, or broken, by prose. Both directions
 * were MEASURED in this repository within two days of each other:
 *
 *   - ISC-300's claim went VACUOUSLY GREEN. The decision it pinned moved to a
 *     new call site, and the old spelling survived inside a comment explaining
 *     the move. The claim went on passing against that sentence while the code
 *     it defended was gone.
 *
 *   - ISC-246's claim went FALSELY RED. Three lines of new docstring named the
 *     field the claim greps for, so the claim reported a production consumer
 *     that did not exist. The code was untouched.
 *
 * The convention that followed — comments deliberately decline to spell any
 * greppable form, and say so — is written into `safety/reaper.ts` and
 * `harvest/index.ts`. It works, and it is unenforceable: it asks every future
 * author to know which strings some other file greps for.
 *
 * ## Why MASK rather than strip
 *
 * Every comment byte becomes a space and every newline is kept, so the result
 * is the same length as the input and every line and column number is
 * unchanged. A claim's `grep -n` output therefore still names the line the
 * reader will find in the real file. Deleting comment text instead would
 * renumber the file and make every reported line number a lie.
 *
 * ## What this handles, stated rather than implied
 *
 * Line comments, block comments, the three string forms, escapes, and
 * `${...}` substitutions nested inside template literals. Regular-expression
 * literals are recognised by the standard previous-token heuristic, which is
 * what keeps `/` in `a / b` from opening one.
 *
 * The heuristic can be wrong, and the direction it fails in is the reason it is
 * acceptable here: mistaking code for a comment BLANKS it, so a claim that
 * depended on it goes red and someone looks. Mistaking a comment for code
 * leaves the old behaviour exactly as it was. Neither failure is silent, and
 * the first is the loud one.
 */

type State = "code" | "line" | "block" | "single" | "double" | "template";

/** Characters after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

/**
 * Whether the `/` at `i` starts a regex literal rather than a division.
 *
 * Looks back past whitespace to the previous significant character. A `/`
 * following a value — an identifier, a number, a closing bracket — divides;
 * one following an operator or an opening bracket starts a pattern.
 */
function opensRegex(src: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return REGEX_PRECEDERS.has(c);
  }
  return true;
}

/**
 * `src` with every comment byte replaced by a space.
 *
 * Length and line breaks are preserved exactly; nothing else is altered.
 */
export function maskComments(src: string): string {
  const out = src.split("");
  /** Template-literal nesting: each entry is the `${` depth of one template. */
  const templates: number[] = [];
  let state: State = "code";
  let i = 0;

  /** Blank one byte, keeping newlines so the line count cannot drift. */
  const blank = (at: number): void => {
    if (out[at] !== "\n" && out[at] !== "\r") out[at] = " ";
  };

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (state === "line") {
      if (c === "\n") state = "code";
      else blank(i);
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        state = "code";
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    if (state === "single" || state === "double") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if ((state === "single" && c === "'") || (state === "double" && c === '"')) state = "code";
      i += 1;
      continue;
    }
    if (state === "template") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && next === "{") {
        // Inside a substitution the language is CODE again, comments included.
        templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + 1;
        state = "code";
        i += 2;
        continue;
      }
      if (c === "`") {
        templates.pop();
        state = "code";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // state === "code"
    if (c === "/" && next === "/") {
      blank(i);
      blank(i + 1);
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      blank(i);
      blank(i + 1);
      state = "block";
      i += 2;
      continue;
    }
    if (c === "/" && opensRegex(src, i)) {
      // Skip the literal wholesale: a `//` inside one must not open a comment.
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j++) {
        const d = src[j]!;
        if (d === "\\") {
          j += 1;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
      }
      i = j + 1;
      continue;
    }
    if (c === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (c === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (c === "`") {
      templates.push(0);
      state = "template";
      i += 1;
      continue;
    }
    if (c === "}" && templates.length > 0 && (templates[templates.length - 1] ?? 0) > 0) {
      templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) - 1;
      state = "template";
      i += 1;
      continue;
    }
    if (c === "{" && templates.length > 0 && (templates[templates.length - 1] ?? 0) > 0) {
      // A brace inside a substitution, so the matching `}` is not the end of it.
      templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}
