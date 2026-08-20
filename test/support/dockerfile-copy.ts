/**
 * The `COPY`/`ADD` reader behind ISC-270's build-context enrolment check.
 *
 * WHY IT IS A MODULE AND NOT A REGEX INSIDE THE TEST. `test/support/env-sweep.ts`
 * next door documents what happens to a sweep that lives inline: it asserted
 * `expect(offenders).toEqual([])` against an array it could never have filled,
 * passed on every commit, and would have passed on every possible commit. The
 * only defence against that is a reader that can be handed a fixture which
 * MUST produce an offender, and a reader can only be handed a fixture if it is
 * separable from the file it reads. So the parse lives here and both of its
 * directions — clean input and dirty input — are exercised by
 * `test/unit/dockerfile-build-assets.test.ts`.
 *
 * WHAT IT IS FOR. `BUILD_CONTEXT_ASSETS` in `src/container/image.ts` is a
 * hand-maintained array, and `configHash` hashes the content of exactly those
 * files. A file the Dockerfile `COPY`s that nobody added to the array is a
 * fail-open: the image changes, the hash does not, the tag does not, and a
 * stale image is reused with nothing anywhere reporting it. This module turns
 * "somebody remembered" into "the Dockerfile is read on every PR".
 *
 * ## What counts as a build-context source
 *
 * The hazard is a file read OUT OF THE BUILD CONTEXT — the directory `docker
 * build` is pointed at, which for pifleet is `repoRoot()`. Three operand forms
 * are read from the context and three are not:
 *
 *   - `COPY --from=<stage> …` copies out of an earlier BUILD STAGE, not the
 *     context. Those bytes are produced by the Dockerfile itself, which is
 *     already hashed, so enrolling them would be meaningless — and demanding
 *     enrolment for a path that does not exist on disk would be worse than
 *     meaningless. Excluded, and the exclusion is fixture-tested.
 *   - `ADD https://…` / `ADD git@…` fetch from the network. There is no file
 *     in the checkout to hash; that is a real and separate hole, and naming it
 *     here as an offender would only produce an unfixable failure. Excluded.
 *   - A heredoc source (`COPY <<EOF /dest`) is inline Dockerfile text, so it
 *     is already inside the hash by virtue of being in the Dockerfile.
 *     Excluded.
 *
 * `ADD` is read alongside `COPY` even though ISC-270 is worded over `COPY`.
 * The criterion is worded over the instruction that is actually used today;
 * the FAILURE it describes is "a context file reaches the image without
 * reaching the hash", and `ADD <local path>` does precisely that. Reading only
 * `COPY` would leave a one-keyword bypass around a control whose entire point
 * is that nobody has to remember it.
 *
 * ## Syntax actually handled
 *
 * Line continuations, `#` comments (including a comment line in the middle of
 * a continuation, which Docker also strips), flags in any position before the
 * operands, the shell form with single or double quoting, and the JSON-array
 * form `COPY ["src", "dest"]`. The last operand is the destination and is
 * never a source. `--parents`, `--chmod`, `--chown` and any future flag are
 * recognised structurally by their leading `--`, so a new one does not need a
 * change here.
 */

/** One source operand of one `COPY`/`ADD`, with the provenance that classifies it. */
export interface CopySource {
  /** `COPY` or `ADD`, upper-cased regardless of how it was written. */
  readonly instruction: "COPY" | "ADD";
  /** The operand exactly as written — not resolved, not normalized. */
  readonly source: string;
  /** The `--from=` stage when present. A stage source is not build context. */
  readonly from: string | undefined;
  /** 1-based line the instruction STARTS on, for a diagnostic that can be opened. */
  readonly line: number;
}

/** A `COPY`/`ADD` source that reaches the image without reaching the hash. */
export interface UnenrolledSource extends CopySource {
  /** Plain-spoken reason, written to be pasted into a failure message. */
  readonly why: string;
}

/** The build-context subdirectory `BUILD_CONTEXT_ASSETS` entries are relative to. */
export const ASSET_DIR = "docker/";

const INSTRUCTION = /^\s*(COPY|ADD)\s+(\S.*)$/i;

/** A scheme, an scp-style git remote, or a bare `github.com/…` — all network. */
const REMOTE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|git@|github\.com\/)/;

/**
 * Fold continuations and drop comments, keeping each instruction's start line.
 *
 * The line number is the one a person needs in order to open the file at the
 * offending instruction, which for a continued instruction is where it began
 * rather than where its operands happened to land.
 */
function logicalLines(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const raw = text.split(/\r?\n/);
  let buffer = "";
  let start = 1;

  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? "";
    const isComment = /^\s*#/.test(line);
    if (buffer === "") {
      if (isComment || line.trim() === "") continue;
      start = i + 1;
    } else if (isComment) {
      // Docker strips a comment line inside a continuation; so does this.
      continue;
    }

    const continued = /^(.*?)\\[ \t]*$/.exec(line);
    if (continued !== null) {
      buffer += `${continued[1] ?? ""} `;
      continue;
    }
    buffer += line;
    out.push({ text: buffer, line: start });
    buffer = "";
  }

  if (buffer.trim() !== "") out.push({ text: buffer, line: start });
  return out;
}

/** Split an operand list on whitespace, honouring `'` and `"` quoting. */
function shellOperands(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let open = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      open = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (current !== "" || open) out.push(current);
      current = "";
      open = false;
      continue;
    }
    current += c;
  }
  if (current !== "" || open) out.push(current);
  return out;
}

/** Operands of one instruction, plus the `--from=` stage if it carried one. */
function operandsOf(argText: string): { operands: string[]; from: string | undefined } {
  let rest = argText.trim();
  let from: string | undefined;

  // Flags precede the operands and are recognised by their leading `--`.
  for (;;) {
    const flag = /^(--[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S*))?)\s*/.exec(rest);
    if (flag === null) break;
    const text = flag[1] ?? "";
    const eq = /^--from=(.*)$/.exec(text);
    if (eq !== null) from = (eq[1] ?? "").replace(/^["']|["']$/g, "");
    rest = rest.slice(flag[0].length);
  }

  if (rest.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(rest);
      if (Array.isArray(parsed)) return { operands: parsed.map((v) => String(v)), from };
    } catch {
      // Not valid JSON after all; fall through and read it as the shell form.
    }
  }
  return { operands: shellOperands(rest), from };
}

/**
 * Every source operand of every `COPY`/`ADD` in `text`.
 *
 * Destinations are excluded (the final operand is never a source) and so are
 * instructions with fewer than two operands, which are malformed rather than
 * interesting. Nothing is filtered by provenance here — that is
 * `buildContextSources`' job, so a caller can see what the parse found before
 * anything is discarded.
 */
export function parseCopySources(text: string): CopySource[] {
  const out: CopySource[] = [];

  for (const { text: line, line: at } of logicalLines(text)) {
    const m = INSTRUCTION.exec(line);
    if (m === null) continue;
    const instruction = (m[1] ?? "").toUpperCase() === "ADD" ? "ADD" : "COPY";
    const { operands, from } = operandsOf(m[2] ?? "");
    if (operands.length < 2) continue;
    for (const source of operands.slice(0, -1)) {
      out.push({ instruction, source, from, line: at });
    }
  }

  return out;
}

/** The subset of `parseCopySources` that reads a file out of the build context. */
export function buildContextSources(text: string): CopySource[] {
  return parseCopySources(text).filter(
    (s) => s.from === undefined && !REMOTE.test(s.source) && !s.source.startsWith("<<"),
  );
}

/**
 * A source's path relative to `docker/`, or null when it is not under it.
 *
 * `BUILD_CONTEXT_ASSETS` entries are joined onto `repoRoot()/docker`, so a
 * source outside that directory cannot be expressed in the array at all — that
 * is what the null means, and why the caller reports it as its own kind of
 * offence rather than as a missing entry someone could go and add.
 */
export function assetNameOf(source: string): string | null {
  const normalized = source.replace(/^\.\//, "");
  if (!normalized.startsWith(ASSET_DIR)) return null;
  const name = normalized.slice(ASSET_DIR.length);
  if (name === "" || name.split("/").includes("..")) return null;
  return name;
}

/**
 * Every build-context source that is not enrolled in `enrolled`.
 *
 * Empty means the Dockerfile and the array agree. The comparison is a SUBSET
 * assertion in one direction only: `enrolled` legitimately holds entries that
 * are never `COPY`ed — the Dockerfile itself is hashed because the recipe
 * matters, not because it lands in the image.
 */
export function unenrolledSources(text: string, enrolled: readonly string[]): UnenrolledSource[] {
  const known = new Set(enrolled);
  const out: UnenrolledSource[] = [];

  for (const source of buildContextSources(text)) {
    const name = assetNameOf(source.source);
    if (name === null) {
      out.push({
        ...source,
        why:
          `reads '${source.source}' from the build context, which is outside ` +
          `'${ASSET_DIR}' and so cannot be named in BUILD_CONTEXT_ASSETS at all ` +
          `(entries there are resolved as ${ASSET_DIR}<entry>)`,
      });
      continue;
    }
    if (!known.has(name)) {
      out.push({
        ...source,
        why:
          `copies '${source.source}' into the image but '${name}' is absent from ` +
          `BUILD_CONTEXT_ASSETS, so configHash never reads it: edit that file and ` +
          `the tag does not move, and a stale image is reused silently`,
      });
    }
  }

  return out;
}

/** Render offenders for a failure message that can be acted on without a debugger. */
export function formatUnenrolled(offenders: readonly UnenrolledSource[]): string {
  return offenders
    .map((o) => `docker/Dockerfile:${o.line} ${o.instruction} ${o.why}`)
    .join("\n");
}
