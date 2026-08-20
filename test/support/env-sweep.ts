/**
 * The source-level sweep for `docker run -e NAME` pass-throughs (ISC-31).
 *
 * Extracted out of `test/unit/container-env.test.ts` for ONE reason: while it
 * lived inline as a regex literal there was no way to demonstrate that it
 * could match anything at all, and it could not. The pattern was
 * `/"-e",\s*\n?\s*"([A-Z][A-Z0-9_]*)"/` — a quoted, SCREAMING_CASE string
 * literal immediately after a quoted `-e` — and the repository contains no
 * such sequence, so the assertion `expect(offenders).toEqual([])` compared an
 * empty array it could never have filled against an empty array. It passed on
 * every commit, would have passed on every possible commit, and was the only
 * stated instrument for the two producers that build argv from inline array
 * literals rather than from an exported builder.
 *
 * Neither real `-e` site in `src/` is even in the shape it looked for:
 * `security/relay.ts` passes a TEMPLATE LITERAL
 * (`` `PIFLEET_RELAY_TARGETS=${JSON.stringify(targets)}` ``) and
 * `security/probe-transport.ts` passes a BARE IDENTIFIER (`PROBE_SCRIPT`). A
 * sweep that cannot see either of the two forms its own codebase actually
 * uses is not a weak instrument, which is what its comment claimed; it is a
 * decoration.
 *
 * ## What counts as an offence
 *
 * The hazard is the PASS-THROUGH form: `-e NAME` with no `=`, which tells
 * Docker to copy `NAME`'s value out of the host environment and into the
 * container. `-e NAME=VALUE` is the safe form — the value is supplied, not
 * inherited — so an element that provably contains an `=` is not flagged.
 * That is the discrimination, and it is a property of the ELEMENT rather than
 * of its spelling, so quoted strings, template literals and bare identifiers
 * are all read the same way.
 *
 * ## What it deliberately does not flag
 *
 * `node -e <script>` and `bun -e <script>` are an interpreter's eval flag, not
 * Docker's, and both appear in this repo AFTER the image name where every
 * element belongs to the container's own command line. Source text cannot tell
 * "before the image" from "after the image" — there is no reliable syntactic
 * marker for which element IS the image — so this uses the one signal that is
 * actually present: the element immediately preceding the flag. `"node", "-e"`
 * is an interpreter invocation; `docker run` never places `node` immediately
 * before its own `-e`.
 *
 * That is a heuristic and is stated as one. It is sound in the direction that
 * matters — a real `docker run` argv cannot accidentally acquire a preceding
 * `"node"` literal — and the fixture test exercises BOTH sides of it, so the
 * exclusion cannot silently widen into "matches nothing" the way its
 * predecessor did.
 *
 * A source sweep remains the weakest instrument in this file and is used only
 * where no value can be inspected. `expectCleanEnv` on real argv is the strong
 * one, and it covers every producer that exports a builder.
 */

/** A single argv element as it appears in source: string, template, or name. */
const ELEMENT = String.raw`"(?:[^"\\]|\\.)*"|` + "`(?:[^`\\\\]|\\\\.)*`" + String.raw`|[A-Za-z_$][\w$.]*`;

/** `<preceding element>, "-e", <element>` — the split form, either flag name. */
const SPLIT = new RegExp(
  String.raw`(?:(${ELEMENT})\s*,\s*)?"(?:-e|--env)"\s*,\s*(${ELEMENT})`,
  "g",
);

/** `"-eNAME"` / `"--env=NAME"` — the glued forms, which take no second element. */
const GLUED = new RegExp(String.raw`"(?:-e|--env=)([A-Za-z_][\w]*)"`, "g");

/** Interpreters whose own `-e` takes a script. See the header. */
const INTERPRETERS = new Set(["node", "bun", "sh", "bash", "python", "python3", "perl", "ruby"]);

function unquote(element: string): string {
  const first = element[0];
  if (first === '"' || first === "`") return element.slice(1, -1);
  return element;
}

/**
 * Every `-e`/`--env` in `text` that would pass a HOST variable through, by
 * name and with no value supplied. Empty means the file is clean.
 */
export function bareEnvPassThroughs(text: string): string[] {
  const out: string[] = [];

  for (const m of text.matchAll(SPLIT)) {
    const preceding = m[1];
    const value = m[2];
    if (value === undefined) continue;
    // `-e NAME=VALUE` supplies the value rather than inheriting it.
    if (unquote(value).includes("=")) continue;
    // An interpreter's own eval flag, after the image. See the header.
    if (preceding !== undefined && INTERPRETERS.has(unquote(preceding))) continue;
    out.push(`-e ${value}`);
  }

  for (const m of text.matchAll(GLUED)) {
    if (m[1] !== undefined) out.push(`-e ${m[1]}`);
  }

  return out;
}
