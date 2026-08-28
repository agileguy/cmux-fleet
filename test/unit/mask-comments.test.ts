/**
 * The comment masker, tested against the two failures that motivated it.
 *
 * Both are real and both happened here, in opposite directions: a claim that
 * stayed GREEN against a comment after its code had moved, and a claim driven
 * RED by three lines of new docstring while its code was untouched. They are
 * the first two probes below, quoted closely enough to be recognisable.
 *
 * The rest pin the ways a naive implementation gets this wrong — a `//` inside
 * a URL string, a regex whose body contains what looks like a comment, and a
 * comment nested inside a template substitution, which IS a comment even though
 * it sits inside a string literal.
 */

import { describe, expect, test } from "bun:test";
import { maskComments } from "../support/mask-comments.ts";

/** The property every claim's line numbers depend on. */
function sameShape(src: string, masked: string): void {
  expect(masked).toHaveLength(src.length);
  expect(masked.split("\n")).toHaveLength(src.split("\n").length);
}

describe("maskComments blanks prose and leaves code alone", () => {
  test("the vacuous-green case: a comment quoting a form the code no longer has", () => {
    const src = [
      "/*",
      " * This line used to narrow the sentinel with a ternary HERE:",
      " * pgid: entry.pgid > 0 ? entry.pgid : null",
      " */",
      "const pgid = narrowed ? null : target.pgid;",
    ].join("\n");
    const masked = maskComments(src);
    sameShape(src, masked);
    expect(masked).not.toContain("entry.pgid > 0");
    expect(masked).toContain("narrowed ? null : target.pgid");
  });

  test("the false-red case: a docstring naming a field the code does not read", () => {
    const src = [
      "/**",
      " * Every entry in `scan.safe` is holding an OPEN DESCRIPTOR.",
      " */",
      "const held = scan.refused.length;",
    ].join("\n");
    const masked = maskComments(src);
    sameShape(src, masked);
    expect(masked).not.toContain("scan.safe");
    expect(masked).toContain("scan.refused");
  });

  test("a line comment goes, and the code before it on the same line stays", () => {
    const src = 'const port = 8000; // scan.safe is not read here\n';
    const masked = maskComments(src);
    sameShape(src, masked);
    expect(masked).toContain("const port = 8000;");
    expect(masked).not.toContain("scan.safe");
  });

  /**
   * The case a "delete every // to end of line" implementation destroys. A URL
   * in a string is code, and blanking it would make a claim about a real
   * endpoint go red for a reason that has nothing to do with the endpoint.
   */
  test("a // inside a string is not a comment", () => {
    const src = 'const url = "http://omlx.pifleet.internal:8000/v1";\n';
    expect(maskComments(src)).toContain("http://omlx.pifleet.internal:8000/v1");
  });

  test("a // inside a template literal is not a comment", () => {
    const src = "const u = `http://${host}:8000/v1`;\n";
    const masked = maskComments(src);
    expect(masked).toContain("http://");
    expect(masked).toContain("${host}");
  });

  /**
   * The nesting that makes this more than a two-state machine: inside `${...}`
   * the language is code again, so a comment there really is a comment.
   */
  test("a comment inside a template substitution IS masked", () => {
    const src = "const u = `a${b /* scan.safe */}c`;\n";
    const masked = maskComments(src);
    expect(masked).not.toContain("scan.safe");
    expect(masked).toContain("`a${b");
    expect(masked).toContain("c`");
  });

  test("a regex whose body looks like a comment does not open one", () => {
    const src = ['const re = /https:\\/\\//;', 'const kept = "sentinel";'].join("\n");
    const masked = maskComments(src);
    expect(masked).toContain('const kept = "sentinel";');
  });

  test("division is not a regex", () => {
    const src = "const half = total / 2;\nconst kept = 1;\n";
    expect(maskComments(src)).toContain("const kept = 1;");
  });

  test("an escaped quote does not end its string", () => {
    const src = 'const s = "a \\" // not a comment";\nconst kept = 2;\n';
    const masked = maskComments(src);
    expect(masked).toContain("// not a comment");
    expect(masked).toContain("const kept = 2;");
  });

  /**
   * The whole file, as a shape assertion. Any drift in length or line count
   * makes every `grep -n` line number this guard reports a lie.
   */
  test("line and column geometry survives a real source file", async () => {
    const src = await Bun.file("src/safety/reaper.ts").text();
    sameShape(src, maskComments(src));
  });
});
