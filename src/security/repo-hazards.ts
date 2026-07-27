/**
 * Hostile-repository neutralization (SRD §12.2) — Phase 3.
 *
 * A checked-out repository is INPUT, and several files in it are read by the
 * agent as INSTRUCTIONS. `.pi/extensions/` is TypeScript Pi executes
 * in-process; `AGENTS.md`/`CLAUDE.md` are loaded into the system prompt;
 * `core.hooksPath` and `.git/hooks` name programs git executes; an MCP config
 * names servers a client will connect to. A repo under grading can therefore
 * rewrite the behaviour of the thing grading it — no exploit required, just a
 * committed file.
 *
 * Two invariants shape everything below:
 *
 *  1. Detection EXECUTES NOTHING. `.git/config` is parsed as text — never
 *     `git config`, because spawning git inside a hostile tree runs whatever
 *     `core.fsmonitor` names, which is the compromise the scan exists to find.
 *     The walk is lstat-first and never descends through a symlink, following
 *     the discipline in `harvest/outbox.ts`.
 *
 *  2. `detected` and `neutralized` are recorded INDEPENDENTLY, matching the
 *     seam in `RepoHazardSchema`. "We saw it and left it" and "we saw it and
 *     defused it" are different security postures, and a neutralization step
 *     that fails (permissions, races) must surface as detected-but-live rather
 *     than silently reading as handled.
 *
 * On undoability, stated honestly (the requirement asks for it): every
 * neutralization here mutates the WORKTREE, which is mounted rw into the
 * container — so a worker with `bash` and the git object store can restore a
 * tracked `AGENTS.md` with one `git checkout --`. In-tree quarantine is
 * therefore NOT the load-bearing control. The controls a worker cannot reach
 * live outside the mount: `--no-extensions --no-skills --no-context-files` on
 * the Pi argv (`config/render.ts`, unconditional) and the `-c
 * core.hooksPath=/dev/null …` hardening on every host-side git spawn
 * (`harvest/git.ts`). What quarantine buys is (a) protection for the window
 * and the tools those flags do not cover — host editors, ad-hoc git runs,
 * anything that opens the tree before or beside Pi — and (b) a visible,
 * explicable record: nothing is deleted, everything is renamed in place with
 * a suffix a confused worker (or the operator debugging one) can see in `ls`.
 */

import { chmod, lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RepoHazardSchema, type RepoHazard } from "../contracts.ts";
import { safeForReport } from "../harvest/outbox.ts";

/**
 * Suffix appended on quarantine. A rename, not a delete (requirement: a
 * worker whose legitimate AGENTS.md vanished with no record will be debugged
 * as a mystery) — the content sits beside its old name, self-describing.
 */
export const QUARANTINE_SUFFIX = ".pifleet-quarantined";

/** Entries examined per directory before the scan refuses to continue. */
export const MAX_DIR_ENTRIES = 10_000;

/**
 * Byte cap on `.git/config` before we decline to parse it. A config this
 * large is not a configuration, it is a payload; it is reported as a hazard
 * rather than buffered.
 */
export const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

/** How many directory-entry names are echoed (escaped) into a detail string. */
const DETAIL_NAME_LIMIT = 20;

/**
 * Root-level files Pi loads into the system prompt (§4.2 context discovery).
 * Root-level only, deliberately: the worker's cwd is the workspace root and
 * Pi discovers context files from cwd upward, so a nested AGENTS.md is never
 * read — flagging it would be the detector that flags everything, which is as
 * useless as one that flags nothing.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** MCP server configs a client in the tree would connect out through. */
const MCP_FILES = [".mcp.json", join(".pi", "mcp.json")] as const;

/**
 * Discovery directories Pi probes from the workspace root (§4.2). Extensions
 * are the in-process-execution case and get their own kind; the rest are
 * instruction-bearing and reported as `other`. `.pi/settings.json` rides
 * along because a settings file can re-enable the very discovery the argv
 * flags deny.
 */
const PI_DIRS: ReadonlyArray<{ rel: string; kind: RepoHazard["kind"]; why: string }> = [
  { rel: join(".pi", "extensions"), kind: "pi_extension", why: "TypeScript executed in-process by Pi" },
  { rel: join(".pi", "skills"), kind: "other", why: "skill discovery root" },
  { rel: join(".pi", "prompts"), kind: "other", why: "prompt discovery root" },
  { rel: join(".agents", "skills"), kind: "other", why: "skill discovery root" },
];

/**
 * `.git/config` keys that name a program git will execute, or pull further
 * config from a path the repo controls. Mirrors the `-c` list in
 * `harvest/git.ts` — the host harvester already suppresses these per-spawn;
 * this scan makes the committed state itself inert and visible.
 */
const CONFIG_HAZARDS: ReadonlyArray<{
  section: RegExp;
  key: RegExp;
  kind: RepoHazard["kind"];
  why: string;
}> = [
  { section: /^core$/, key: /^hookspath$/, kind: "hooks_path", why: "redirects git hooks to a repo-controlled directory" },
  { section: /^core$/, key: /^fsmonitor$/, kind: "other", why: "names a program git runs on status/diff" },
  { section: /^include(if)?(\.|$)/, key: /^path$/, kind: "other", why: "pulls additional config from a repo-controlled path" },
  { section: /^diff\./, key: /^(command|textconv)$/, kind: "other", why: "names a program git runs to produce diffs" },
  { section: /^filter\./, key: /^(clean|smudge|process)$/, kind: "other", why: "names a program git runs on checkout/add" },
];

export interface RepoHazardScanOptions {
  /** When true, each hazard is defused as it is found and the outcome recorded. */
  neutralize: boolean;
}

/** Detect every hazard class under `worktreeRoot` without modifying anything. */
export async function detectRepoHazards(worktreeRoot: string): Promise<RepoHazard[]> {
  return scanRepoHazards(worktreeRoot, { neutralize: false });
}

/** Detect AND defuse, recording per-hazard whether the defusal actually took. */
export async function neutralizeRepoHazards(worktreeRoot: string): Promise<RepoHazard[]> {
  return scanRepoHazards(worktreeRoot, { neutralize: true });
}

/**
 * One walk, two modes. Detection and neutralization share the walk on
 * purpose: a separate "neutralize this list" entry point would have to map
 * report text back to filesystem paths, and report text is exactly the thing
 * `safeForReport` has already rewritten for human eyes. Paths in a report are
 * for reading, never for dereferencing — the outbox module learned that the
 * hard way, so here the raw dirent name is used at find time and only its
 * escaped form ever leaves the function.
 */
export async function scanRepoHazards(
  worktreeRoot: string,
  opts: RepoHazardScanOptions,
): Promise<RepoHazard[]> {
  // The root is FLEET input, not worker input — `run/paths.ts` computed it.
  // A missing or non-directory root is a caller bug and throws, unlike every
  // hazard below, which is expected input and never throws.
  const rootSt = await lstat(worktreeRoot);
  if (!rootSt.isDirectory()) {
    throw new Error(`repo hazard scan root is not a directory: ${worktreeRoot}`);
  }

  const out: RepoHazard[] = [];

  /**
   * The ONLY way a hazard enters the result — and the ONLY place text is
   * escaped for the report.
   *
   * Callers pass RAW filesystem names and raw detail text on purpose. An
   * earlier version escaped names at each discovery site as well as here, and
   * the redundancy was not free: with two layers, neither one was pinnable —
   * deleting the escaping *here* left every test green, because the callers
   * had already sanitized. Defence that cannot be observed failing is
   * indistinguishable from defence that is not there. One choke point, tested.
   */
  const record = (kind: RepoHazard["kind"], relPath: string, neutralized: boolean, detail: string): void => {
    out.push(
      RepoHazardSchema.parse({
        path: safeForReport(relPath),
        kind,
        detected: true,
        neutralized,
        detail: safeForReport(detail, 2048),
      }),
    );
  };

  /**
   * Quarantine by rename. `rename` operates on the LINK when given a symlink,
   * never on its target, which is why it is safe against every escape trick a
   * committed symlink can play — the worst case is renaming the symlink
   * itself, which is precisely the goal. Numbered fallbacks cover a worker
   * that pre-created the quarantine name to make the rename fail.
   */
  const quarantine = async (abs: string): Promise<{ ok: true; to: string } | { ok: false; reason: string }> => {
    const candidates = [
      `${abs}${QUARANTINE_SUFFIX}`,
      ...Array.from({ length: 4 }, (_, i) => `${abs}${QUARANTINE_SUFFIX}-${i + 2}`),
    ];
    for (const to of candidates) {
      try {
        await lstat(to);
        continue; // occupied — try the next numbered name
      } catch {
        // free — fall through to the rename
      }
      try {
        await rename(abs, to);
        return { ok: true, to };
      } catch (err) {
        return { ok: false, reason: String(err) };
      }
    }
    return { ok: false, reason: "all quarantine names already occupied" };
  };

  /** Neutralize-or-explain wrapper: returns the flag plus a suffix for detail. */
  const defuse = async (abs: string): Promise<{ neutralized: boolean; note: string }> => {
    if (!opts.neutralize) return { neutralized: false, note: "detected only; not neutralized" };
    const q = await quarantine(abs);
    return q.ok
      ? { neutralized: true, note: `renamed aside with suffix ${QUARANTINE_SUFFIX}` }
      : { neutralized: false, note: `neutralization FAILED: ${q.reason}` };
  };

  // ---- instruction files at the root (AGENTS.md, CLAUDE.md) ----------------
  for (const name of INSTRUCTION_FILES) {
    const abs = join(worktreeRoot, name);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(abs);
    } catch {
      continue; // absent — the common, clean case
    }
    const shape = st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "non-regular entry";
    const d = await defuse(abs);
    record("agents_md", name, d.neutralized, `${shape} loaded into the system prompt by context discovery; ${d.note}`);
  }

  // ---- MCP server configs --------------------------------------------------
  for (const rel of MCP_FILES) {
    // A symlinked `.pi` would make `.pi/mcp.json` resolve through it; the
    // `.pi` symlink case is caught below and the intermediate check here
    // keeps this loop from ever traversing a hostile link.
    if (rel.includes("/") && (await isSymlink(join(worktreeRoot, rel.split("/")[0]!)))) continue;
    const abs = join(worktreeRoot, rel);
    try {
      await lstat(abs);
    } catch {
      continue;
    }
    const d = await defuse(abs);
    record("mcp_config", rel, d.neutralized, `MCP server config in the tree; ${d.note}`);
  }

  // ---- Pi discovery directories -------------------------------------------
  // Parent dot-dirs first: if `.pi` or `.agents` is itself a symlink, every
  // path through it resolves wherever the link points — outside the worktree
  // if the repo chooses. The link is quarantined as a unit and NOTHING below
  // it is touched, because "below it" is not inside this tree.
  const symlinkedParents = new Set<string>();
  for (const parent of [".pi", ".agents"]) {
    const abs = join(worktreeRoot, parent);
    if (await isSymlink(abs)) {
      symlinkedParents.add(parent);
      const d = await defuse(abs);
      record("other", parent, d.neutralized, `discovery parent is a symlink (not followed); ${d.note}`);
    }
  }
  for (const dir of PI_DIRS) {
    if (symlinkedParents.has(dir.rel.split("/")[0]!)) continue;
    const abs = join(worktreeRoot, dir.rel);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      const d = await defuse(abs);
      record(dir.kind, dir.rel, d.neutralized, `discovery dir is a symlink (not followed); ${d.note}`);
      continue;
    }
    if (!st.isDirectory()) {
      const d = await defuse(abs);
      record(dir.kind, dir.rel, d.neutralized, `discovery path is not a directory; ${d.note}`);
      continue;
    }
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      names = [];
    }
    if (names.length === 0) continue; // an empty discovery dir loads nothing
    // The whole directory is quarantined as ONE unit — per-entry renames
    // would leave the directory itself discoverable and turn one hazard into
    // a race against however many files the repo committed.
    // Length-clipped only; ESCAPING belongs to `record` alone (see above).
    const shown = names.slice(0, DETAIL_NAME_LIMIT).map((n) => n.slice(0, 64));
    const more = names.length > shown.length ? ` (+${names.length - shown.length} more)` : "";
    const d = await defuse(abs);
    record(dir.kind, dir.rel, d.neutralized, `${dir.why}; entries: ${shown.join(", ")}${more}; ${d.note}`);
  }

  // ---- git: config keys and hooks -----------------------------------------
  const gitAbs = join(worktreeRoot, ".git");
  let gitSt: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    gitSt = await lstat(gitAbs);
  } catch {
    gitSt = null; // no .git at all — nothing git-shaped to scan
  }
  if (gitSt !== null) {
    if (gitSt.isSymbolicLink()) {
      const d = await defuse(gitAbs);
      record("other", ".git", d.neutralized, `.git is a symlink (not followed); ${d.note}`);
    } else if (gitSt.isFile()) {
      // Linked worktree: `.git` is a one-line `gitdir:` pointer and the real
      // git dir lives OUTSIDE this mount — created by the fleet, unreachable
      // by the container, and every host-side spawn goes through the
      // `harvest/git.ts` hardening. Following the pointer would walk out of
      // the tree this scan is scoped to, so it is deliberately not followed
      // and deliberately not flagged: this is pifleet's own normal shape, and
      // flagging it on every run trains the operator to ignore the field.
    } else if (gitSt.isDirectory()) {
      await scanGitConfig(worktreeRoot, opts, record);
      await scanGitHooks(worktreeRoot, opts, record, defuse);
    }
  }

  return out;
}

async function isSymlink(abs: string): Promise<boolean> {
  try {
    return (await lstat(abs)).isSymbolicLink();
  } catch {
    return false;
  }
}

type Record_ = (kind: RepoHazard["kind"], relPath: string, neutralized: boolean, detail: string) => void;
type Defuse = (abs: string) => Promise<{ neutralized: boolean; note: string }>;

/**
 * Parse `.git/config` as TEXT for keys that make git execute repo-chosen
 * programs. Neutralization rewrites the file with each offending line
 * commented out behind a `; pifleet-quarantined` marker — content preserved,
 * meaning removed, and the marker keeps a re-scan from flagging the same line
 * twice (a commented line no longer matches a key assignment).
 */
async function scanGitConfig(worktreeRoot: string, opts: RepoHazardScanOptions, record: Record_): Promise<void> {
  const rel = join(".git", "config");
  const abs = join(worktreeRoot, rel);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(abs);
  } catch {
    return; // no config file — nothing configured
  }
  if (st.isSymbolicLink()) {
    // Reading through it would read whatever the repo pointed it at; the
    // symlink itself is the finding. Quarantine handled via plain rename to
    // keep this function free of the file-content path.
    const d = opts.neutralize
      ? await renamePlain(abs)
      : { neutralized: false, note: "detected only; not neutralized" };
    record("other", rel, d.neutralized, `.git/config is a symlink (not followed); ${d.note}`);
    return;
  }
  if (!st.isFile()) {
    record("other", rel, false, ".git/config is not a regular file; left untouched");
    return;
  }
  if (st.size > MAX_GIT_CONFIG_BYTES) {
    record("other", rel, false, `.git/config is ${st.size} bytes (cap ${MAX_GIT_CONFIG_BYTES}); not parsed, not neutralized`);
    return;
  }

  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    record("other", rel, false, `.git/config could not be read: ${String(err)}`);
    return;
  }

  // Minimal INI walk: track the current `[section]` / `[section "sub"]`, and
  // match `key = value` lines. Git treats section and key names
  // case-insensitively; subsections keep their case and are folded into the
  // dotted form the CONFIG_HAZARDS patterns match against.
  //
  // Two forms this walk used to miss, both of which git itself honours:
  //
  //   [core] hooksPath = /tmp/evil        header and key on ONE line
  //   [core]\r\n\thooksPath = ...\r\n     CRLF line endings
  //
  // The first slipped through because the header pattern was anchored `\]\s*$`
  // while the key pattern required the line to START with a key — a line
  // carrying both matched NEITHER, so it was invisible rather than
  // half-parsed. The second because `.` in a JS regex excludes `\r`, so the
  // value capture could never reach `$`; the header line still parsed, which
  // made that failure selective and silent instead of total.
  //
  // Both were found by a probe that asks `git config --get` for the effective
  // value and prints it beside this scanner's verdict, so neither side can be
  // graded against the other's assumptions. It is the regression test now.
  const rawLines = text.split("\n");
  let section = "";
  const offenders: Array<{
    index: number;
    kind: RepoHazard["kind"];
    why: string;
    shown: string;
    /** The `[section]` text if it shared this line with the key, else "". */
    header: string;
    /** The line with `\r` stripped and any leading header removed. */
    tail: string;
  }> = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!.replace(/\r$/, "");
    // Not anchored at end: a header may be followed by a key on the same line.
    const sec = /^(\s*\[([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\])/.exec(line);
    let header = "";
    let tail = line;
    if (sec !== null) {
      section = sec[3] !== undefined ? `${sec[2]!.toLowerCase()}.${sec[3]}` : sec[2]!.toLowerCase();
      header = sec[1]!;
      tail = line.slice(header.length);
    }
    const kv = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(tail);
    if (kv === null) continue;
    const key = kv[1]!.toLowerCase();
    for (const h of CONFIG_HAZARDS) {
      if (h.section.test(section) && h.key.test(key)) {
        // Clipped, not escaped — `record` is the single escaper.
        offenders.push({
          index: i,
          kind: h.kind,
          why: h.why,
          shown: `${section}.${key} = ${kv[2]!.slice(0, 128)}`,
          header,
          tail,
        });
        break;
      }
    }
  }
  if (offenders.length === 0) return;

  let neutralized = false;
  let note = "detected only; not neutralized";
  if (opts.neutralize) {
    for (const o of offenders) {
      // A key sharing its line with a `[section]` header cannot simply be
      // commented out: that would comment out the HEADER too, and every
      // following indented key would silently re-attach to whatever section
      // preceded this one — turning a neutralization into a semantic edit of
      // unrelated settings. Split instead: header kept on its own line, key
      // quarantined beneath it. Emitting "\n" inside one element is safe
      // because the join happens after every index has been addressed.
      rawLines[o.index] =
        o.header === ""
          ? `; pifleet-quarantined ${o.tail}`
          : `${o.header}\n; pifleet-quarantined ${o.tail}`;
    }
    try {
      // Plain truncate-write, no tmp+rename dance: this runs on the host
      // BEFORE the container exists, so there is no concurrent writer to
      // race, and a torn write here fails loudly on the next parse rather
      // than silently passing.
      await writeFile(abs, rawLines.join("\n"), "utf8");
      neutralized = true;
      note = "offending lines commented out with a pifleet-quarantined marker";
    } catch (err) {
      note = `neutralization FAILED: ${String(err)}`;
    }
  }
  for (const o of offenders) {
    record(o.kind, rel, neutralized, `${o.shown} — ${o.why}; ${note}`);
  }
}

async function renamePlain(abs: string): Promise<{ neutralized: boolean; note: string }> {
  try {
    await rename(abs, `${abs}${QUARANTINE_SUFFIX}`);
    return { neutralized: true, note: `renamed aside with suffix ${QUARANTINE_SUFFIX}` };
  } catch (err) {
    return { neutralized: false, note: `neutralization FAILED: ${String(err)}` };
  }
}

/**
 * Scan `.git/hooks` for entries git would execute. Git runs a hook only when
 * it is an executable file found under the hook's exact name, so the
 * detector's precision comes cheap: `.sample` files and non-executable files
 * are inert and deliberately NOT flagged — a detector that flags every fresh
 * `git init` (which ships a dozen `.sample` hooks) is noise, and noise gets
 * ignored.
 *
 * Neutralization renames AND strips the execute bit. The rename is the one
 * that matters — git looks hooks up by name — and the chmod is belt and
 * braces for anything that later renames the file back without thinking.
 */
async function scanGitHooks(
  worktreeRoot: string,
  opts: RepoHazardScanOptions,
  record: Record_,
  defuse: Defuse,
): Promise<void> {
  const rel = join(".git", "hooks");
  const abs = join(worktreeRoot, rel);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    const d = await defuse(abs);
    record("hooks_path", rel, d.neutralized, `.git/hooks is a symlink (not followed); ${d.note}`);
    return;
  }
  if (!st.isDirectory()) return;

  let names: string[];
  try {
    names = await readdir(abs);
  } catch {
    return;
  }
  if (names.length > MAX_DIR_ENTRIES) {
    record("other", rel, false, `.git/hooks has ${names.length} entries (cap ${MAX_DIR_ENTRIES}); scan stopped, nothing neutralized`);
    return;
  }
  for (const name of names) {
    if (name.endsWith(".sample") || name.endsWith(QUARANTINE_SUFFIX)) continue;
    const entryAbs = join(abs, name);
    const entryRel = join(rel, name);
    let est: Awaited<ReturnType<typeof lstat>>;
    try {
      est = await lstat(entryAbs);
    } catch {
      continue; // vanished mid-scan; nothing to run, nothing to report
    }
    if (est.isSymbolicLink()) {
      const d = await defuse(entryAbs);
      record("hooks_path", entryRel, d.neutralized, `hook is a symlink (not followed); ${d.note}`);
      continue;
    }
    if (est.isDirectory()) continue; // git cannot exec a directory
    if (est.isFile()) {
      if ((est.mode & 0o111) === 0) continue; // not executable — git will not run it
      const d = await defuse(entryAbs);
      if (d.neutralized) {
        // Strip the bit on the QUARANTINED name; failure here does not
        // un-neutralize (the rename already took the hook out of git's
        // lookup), so the error is folded into detail rather than the flag.
        await chmod(`${entryAbs}${QUARANTINE_SUFFIX}`, 0o600).catch(() => {});
      }
      record("hooks_path", entryRel, d.neutralized, `executable git hook; ${d.note}`);
      continue;
    }
    // FIFO, socket, device under hooks/: nothing legitimate lives here, and
    // opening one to "check" can block forever — renamed without being read.
    const d = await defuse(entryAbs);
    record("other", entryRel, d.neutralized, `non-regular entry under .git/hooks; ${d.note}`);
  }
}
