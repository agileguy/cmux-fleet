/**
 * Mutation battery 5 — the structural census, the console's actor, and the
 * adoption guard (SRD-REVIEW-CONSOLE §6.5, §6.8, §6.10, D8).
 *
 * Runs entirely inside a throwaway worktree; the live checkout is never written
 * to. Restore-first across every file, checksum verified after each step.
 *
 * C-prefixed mutations are the census and its location rule. K-prefixed are the
 * ceiling §6.8's first rule produces. A- and H-prefixed are the two WIRINGS —
 * the adjudicator's and the harvester's — which are what stop this being a
 * tested mechanism with no live call site. S-prefixed are the worker→run map the
 * script hands the relay. O-prefixed are §6.10's adoption guard. I-prefixed is
 * ISC-468, the pin this change broke once and now re-checks.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE WORKTREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source files in place. Pointing it at a live checkout is
 * how a transient broken state gets read by something that spawns containers
 * from the tree, which cost a worker once.
 *
 *   git worktree add /tmp/wt HEAD --detach
 *   ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
 *   bun run test/mutation/review-grading.battery.ts /tmp/wt
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error(
    "usage: review-grading.battery.ts <throwaway-worktree>  (never the live checkout)",
  );
}

const CENSUS = `${W}/src/harvest/collation-census.ts`;
const ADJ = `${W}/src/harvest/adjudicate.ts`;
const HARVEST = `${W}/src/harvest/index.ts`;
const STATUS = `${W}/src/run/status-runs.ts`;
const OPS = `${W}/src/backends/cmux/operations.ts`;
const COLLATION = `${W}/src/run/collation.ts`;
const CONSOLE = `${W}/src/run/console-relay.ts`;

const TESTFILES = [
  "test/unit/collation-census.test.ts",
  "test/unit/harvest-collation-wiring.test.ts",
  "test/unit/review-console-relay.test.ts",
  "test/unit/monitor-readonly.test.ts",
];

/**
 * The pristine copy is taken FROM THE WORKTREE at start-up rather than from a
 * side file, so the battery can never restore a stale version over newer work —
 * the failure mode that silently reverts a fix and reports every mutation green.
 */
const PRISTINE: Record<string, string> = Object.fromEntries(
  [CENSUS, ADJ, HARVEST, STATUS, OPS, COLLATION, CONSOLE].map((p) => [p, readFileSync(p, "utf8")]),
);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TIMEOUT_MS = 60_000;

interface M {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  expect: "red" | "green";
}

const MUTATIONS: M[] = [
  // ── C: the census, and the location rule §6.8 hands it. ──────────────────
  {
    id: "C1",
    what: "CONTAINMENT: `relative` becomes a prefix test",
    file: CENSUS,
    find:
      "  const rel = relative(root, target);\n" +
      '  if (rel === "") return null; // the workdir itself is not a file to quote\n' +
      "  if (isAbsolute(rel)) return null;\n" +
      '  return rel.split(sep)[0] === ".." ? null : rel;',
    replace: "  return target.startsWith(root) ? relative(root, target) : null;",
    expect: "red",
  },
  {
    id: "C2",
    what: "CONTAINMENT: a path that climbs out of the workdir is accepted",
    file: CENSUS,
    find: '  return rel.split(sep)[0] === ".." ? null : rel;',
    replace: "  return rel;",
    expect: "red",
  },
  {
    id: "C3",
    what: "CONTAINMENT: the workdir itself counts as a quotable file",
    file: CENSUS,
    find: '  if (rel === "") return null; // the workdir itself is not a file to quote',
    replace: '  if (rel === "") return "";',
    expect: "red",
  },
  {
    id: "C3b",
    what: "CONTAINMENT: the absolute-`rel` arm is removed (dead on POSIX)",
    file: CENSUS,
    find: "  if (isAbsolute(rel)) return null;",
    replace: "  if (false) return null;",
    expect: "green",
  },
  // ── G2: the phrase rule, and each conjunct's own separating fixture. ──────
  {
    id: "C13",
    what: "PHRASE: the shape check is removed, so a sentence counts as located again",
    file: CENSUS,
    find: "  if (looksLikePhrase(rel)) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "C14",
    what: "PHRASE: the whitespace conjunct is dropped, condemning `Makefile`",
    file: CENSUS,
    find: "  if (!/\\s/.test(rel)) return false;",
    replace: "  if (false) return false;",
    expect: "red",
  },
  {
    id: "C15",
    what: "PHRASE: the separator conjunct is dropped, condemning `docs/design notes`",
    file: CENSUS,
    find: "  if (rel.includes(sep)) return false;",
    replace: "  if (false) return false;",
    expect: "red",
  },
  {
    id: "C16",
    what: "PHRASE: the extension conjunct is dropped, condemning `design notes.md`",
    file: CENSUS,
    find: "  return !/\\.[^.\\s]+$/.test(rel);",
    replace: "  return true;",
    expect: "red",
  },
  {
    id: "C17",
    what: "PHRASE: the shape is judged on the SPELLING rather than on the name inside the workdir",
    file: CENSUS,
    find: "  if (looksLikePhrase(rel)) {",
    replace: "  if (looksLikePhrase(file)) {",
    expect: "red",
  },
  {
    id: "C10",
    what: "EMPTY PATH: the empty-path refusal is removed",
    file: CENSUS,
    find: '  if (file === "") return "finding carries an empty file path";',
    replace: "  if (false) return null;",
    expect: "red",
  },
  {
    id: "C11",
    what: "LINE: a fractional line number is accepted",
    file: CENSUS,
    find: "  if (!Number.isInteger(line) || line < 1) {",
    replace: "  if (line < 1) {",
    expect: "red",
  },
  {
    id: "C12",
    what: "REFUSED CENSUS: `declared` becomes 0, claiming a count the document never gave",
    file: CENSUS,
    find: "    declared: null,",
    replace: "    declared: 0,",
    expect: "red",
  },
  {
    id: "C4",
    what: "LOCATED: an unlocatable finding is counted as located anyway",
    file: CENSUS,
    find: "    if (problem === null) located += 1;",
    replace: "    located += 1;",
    expect: "red",
  },
  {
    id: "C5",
    what: "LINE: a non-positive line number is accepted",
    file: CENSUS,
    find: "  if (!Number.isInteger(line) || line < 1) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "C6",
    what: "BACKSLASH: the separator-confusion refusal is removed",
    file: CENSUS,
    find: '  const bs = file.indexOf("\\\\");\n  if (bs !== -1)',
    replace: '  const bs = -1;\n  if (bs !== -1)',
    expect: "red",
  },
  {
    id: "C7",
    what: "BANDS: the histogram counts findings rather than reviewers",
    file: CENSUS,
    find: "    const n = f.raised_by.length;",
    replace: "    const n = 1;",
    expect: "red",
  },
  {
    id: "C8",
    what: "COVERAGE: every lens is reported as missing",
    file: CENSUS,
    find: "    lenses_missing: [...coverage.missing],",
    replace: "    lenses_missing: [],",
    expect: "red",
  },
  {
    id: "C9",
    what: "DECLARED: the document's own count is smoothed to the list's",
    file: CENSUS,
    find: "    declared: collation.finding_count,",
    replace: "    declared: collation.findings.length,",
    expect: "red",
  },
  // ── K: §6.8's first rule as a ceiling. ───────────────────────────────────
  {
    id: "K1",
    what: "CEILING: the claim antecedent is dropped, so a task with no envelope is capped",
    file: CENSUS,
    find: '  if (claimedStatus !== "success") return null;',
    replace: "  if (false) return null;",
    expect: "red",
  },
  {
    id: "K2",
    what: "CEILING: the located comparison always holds, so it never fires",
    file: CENSUS,
    find: "  if (census.counted === 0 || census.located === census.counted) return null;",
    replace: "  if (census.counted === 0 || census.located <= census.counted) return null;",
    expect: "red",
  },
  {
    id: "K3",
    what: "CEILING: a shape defect is graded `failed` rather than `partial`",
    file: CENSUS,
    find: '    ceiling: "partial",',
    replace: '    ceiling: "failed" as "partial",',
    expect: "red",
  },
  {
    id: "K4",
    what: "CEILING: the zero-findings short-circuit is removed (rule 3 is not ours)",
    file: CENSUS,
    find: "  if (census.counted === 0 || census.located === census.counted) return null;",
    replace: "  if (census.located === census.counted) return null;",
    expect: "green",
  },
  {
    id: "K5",
    what: "CEILING: the unreadable guard is removed",
    file: CENSUS,
    find: "  if (census === null || !census.readable) return null;",
    replace: "  if (census === null) return null;",
    expect: "green",
  },
  // ── A: the ADJUDICATOR's wiring. ─────────────────────────────────────────
  {
    id: "A1",
    what: "WIRING: the census ceiling is never consulted by the adjudicator",
    file: ADJ,
    find: "  const census = censusCeiling(facts.collation, claimed?.status);",
    replace: "  const census = null as ReturnType<typeof censusCeiling>;",
    expect: "red",
  },
  {
    id: "A2",
    what: "WIRING: the ceiling becomes an ASSIGNMENT, so it can raise a verdict",
    file: ADJ,
    find: "    if (rank(verdict) > rank(census.ceiling)) verdict = census.ceiling;",
    replace: "    verdict = census.ceiling;",
    expect: "red",
  },
  // ── H: the HARVESTER's wiring. ───────────────────────────────────────────
  {
    id: "H1",
    what: "WIRING: the census never reaches the fact bundle",
    file: HARVEST,
    find: "      collation: reconciled.collation,",
    replace: "      collation: null,",
    expect: "red",
  },
  {
    id: "H2",
    what: "WIRING: the census is never published in the harvest record",
    file: HARVEST,
    find: "      collation: factsWithHarness.collation,",
    replace: "      collation: null,",
    expect: "red",
  },
  {
    id: "H3",
    what: "WIRING: `collationCeiling` is never applied (§6.8 rule 3 goes dark)",
    file: HARVEST,
    find: "    if (collationCap !== null && rank(verdict) > rank(collationCap.status)) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "H4",
    what: "ISC-94: a task with NO ENVELOPE is given a claim of success",
    file: CENSUS,
    find: "  if (claimed === null) return null;",
    replace: '  if (claimed === null) claimed = { status: "success" };',
    expect: "red",
  },
  {
    id: "H4b",
    what: "ISC-94: the guard is inverted, so only envelope-less tasks are graded",
    file: CENSUS,
    find: "  if (claimed === null) return null;",
    replace: "  if (claimed !== null) return null;",
    expect: "red",
  },
  {
    id: "H5",
    what: "WIRING: the collation ceiling becomes an assignment rather than a cap",
    file: HARVEST,
    find: "    if (collationCap !== null && rank(verdict) > rank(collationCap.status)) {",
    replace: "    if (collationCap !== null) {",
    expect: "red",
  },
  {
    id: "H6",
    what: "WIRING: the call site fabricates a claim the wrapper would have refused",
    file: HARVEST,
    find: "    const collationCap = collationCeilingFor(taskId, claimed, reconciled.collationRead);",
    replace:
      "    const collationCap = collationCeilingFor(taskId, claimed ?? { status: \"success\" }, reconciled.collationRead);",
    expect: "red",
  },
  // ── S: the worker→run map the script hands the relay (§6.5). ─────────────
  {
    id: "S1",
    what: "PIN: a dead worker holds its seat again",
    file: STATUS,
    find: "      if (w.alive !== true) continue;",
    replace: "      if (false) continue;",
    expect: "red",
  },
  {
    id: "S2",
    what: "PIN: an ambiguous worker is resolved to the first run seen",
    file: STATUS,
    find: "    if (held.length === 1) pins.set(w, held[0]!);",
    replace: "    if (held.length >= 1) pins.set(w, held[0]!);",
    expect: "red",
  },
  {
    id: "S3",
    what: "PIN: a PARTIAL map is spelled, freezing its own gap",
    file: STATUS,
    find: "  if (map.pins.size !== workers.length) return null;",
    replace: "  if (false) return null;",
    expect: "red",
  },
  // ── O: §6.10's adoption guard. ───────────────────────────────────────────
  {
    id: "O1",
    what: "ADOPTION: the guard never refuses, so a stranger's workspace is adopted",
    file: OPS,
    find: "  if (key(present) === key(planned)) return null;",
    replace: "  if (true) return null;",
    expect: "red",
  },
  {
    id: "O2",
    what: "ADOPTION: titles are compared in ORDER, so a healthy console is refused",
    file: OPS,
    find: '[...xs].map((t) => t ?? "\u0000untitled").sort().join("\u0001");',
    replace: '[...xs].map((t) => t ?? "\u0000untitled").join("\u0001");',
    expect: "red",
  },
  {
    id: "O3",
    what: "ADOPTION: BOTH separators dropped, so titles that concatenate alike match",
    file: OPS,
    find: '[...xs].map((t) => t ?? "\u0000untitled").sort().join("\u0001");',
    replace: '[...xs].map((t) => t ?? "untitled").sort().join("");',
    expect: "red",
  },
  {
    id: "O4",
    what: "ADOPTION: only the JOIN separator is dropped (the NUL is not one)",
    file: OPS,
    find: '[...xs].map((t) => t ?? "\u0000untitled").sort().join("\u0001");',
    replace: '[...xs].map((t) => t ?? "\u0000untitled").sort().join("");',
    expect: "red",
  },
  // ── W: the supervision (§6.5's "dies with the console", §9 Q4). ──────────
  {
    id: "W1",
    what: "WATCH: a console that is gone is never abandoned",
    file: CONSOLE,
    find: "    if (this.consecutiveGone < this.tolerance) return null;",
    replace: "    if (true) return null;",
    expect: "red",
  },
  {
    id: "W2",
    what: "WATCH: the actor exits on the FIRST transient negative observation",
    file: CONSOLE,
    find: "    if (this.consecutiveGone < this.tolerance) return null;",
    replace: "    if (this.consecutiveGone < 1) return null;",
    expect: "red",
  },
  {
    id: "W3",
    what: "WATCH: a positive observation no longer resets the streak",
    file: CONSOLE,
    find: "    if (collatorIsLive) {\n      this.consecutiveGone = 0;\n      return null;\n    }",
    replace: "    if (collatorIsLive) {\n      return null;\n    }",
    expect: "red",
  },
  {
    id: "W4",
    what: "IDENTITY: a relay serving another console is adopted as this one's",
    file: CONSOLE,
    find: "  if (record.run_id !== console_.runId) return false;",
    replace: "  if (false) return false;",
    expect: "red",
  },
  {
    id: "W5",
    what: "IDENTITY: the worker set is not compared",
    file: CONSOLE,
    find: "  return a === b;",
    replace: "  return true;",
    expect: "red",
  },
  {
    id: "W6",
    what: "IDENTITY: the capture-failed sentinel is compared rather than recognised",
    file: CONSOLE,
    find: "  if (!isPinnedIdentity(record.started)) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "W7",
    what: "IDENTITY: an unreadable `ps` is reported as a dead relay",
    file: CONSOLE,
    find: "    return {\n      kind: \"unverifiable\",\n      record,\n      reason: `the identity of pid ${record.pid} could not be read (${",
    replace: "    return {\n      kind: \"stale\" as \"unverifiable\",\n      record,\n      reason: `the identity of pid ${record.pid} could not be read (${",
    expect: "green",
  },
  {
    id: "W8",
    what: "LOCK: two invocations may both start a relay",
    file: CONSOLE,
    find: "      await link(tmp, path);",
    replace: "      await rename(tmp, path);",
    expect: "red",
  },
  // ── I: ISC-468, the pin this change broke once. ──────────────────────────
  {
    id: "I1",
    what: "ISC-468: the collation contract reaches the actor again, dragging in the CLI",
    file: COLLATION,
    find: '} from "./task-ids.ts";',
    replace: '} from "./relay.ts";',
    expect: "red",
  },
  // ── Negative controls. ───────────────────────────────────────────────────
  {
    id: "NC1",
    what: "NEGATIVE CONTROL: rename the local `coverage` in the census",
    file: CENSUS,
    find:
      "  const coverage = lensCoverage(collation);",
    replace: "  const lenses = lensCoverage(collation);",
    expect: "green",
  },
  {
    id: "NC2",
    what: "NEGATIVE CONTROL: reword the backslash sentence, which nothing quotes",
    file: CENSUS,
    find: '  if (bs !== -1) return `finding path contains a backslash (0x5c) at index ${bs}`;',
    replace: '  if (bs !== -1) return `finding path holds a backslash at ${bs}`;',
    expect: "green",
  },
  {
    id: "NC3",
    what: "NEGATIVE CONTROL: reword the unquoted half of the phrase refusal",
    file: CENSUS,
    find: '      `it names ${safeForReport(rel)}, which carries whitespace, no directory and no file ` +',
    replace:
      '      `it names ${safeForReport(rel)}, which holds whitespace, sits in no directory and has no file ` +',
    expect: "green",
  },
];

/**
 * NC1 renames a declaration whose three uses must move with it, or the mutation
 * is a compile error rather than a behaviour-preserving rewrite. Applied as a
 * whole-file substitution for that reason.
 */
const NC1_EXTRA: Array<{ find: string; replace: string }> = [
  { find: "    lenses_total: coverage.total,", replace: "    lenses_total: lenses.total," },
  { find: "    lenses_reported: coverage.reported,", replace: "    lenses_reported: lenses.reported," },
  { find: "    lenses_missing: [...coverage.missing],", replace: "    lenses_missing: [...lenses.missing]," },
];

function restore(): void {
  for (const [path, body] of Object.entries(PRISTINE)) {
    writeFileSync(path, body);
    if (sha(readFileSync(path, "utf8")) !== sha(body)) throw new Error(`RESTORE FAILED: ${path}`);
  }
}

async function runTests(): Promise<"pass" | "fail" | "TIMEOUT"> {
  return await new Promise((resolve) => {
    const child = spawn("bun", ["test", ...TESTFILES], { cwd: W });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("TIMEOUT");
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "pass" : "fail");
    });
  });
}

let findings = 0;
restore();

// THE BASELINE COMES FIRST. A battery whose unmutated tree is red reports every
// mutation as caught and has measured nothing.
const baseline = await runTests();
process.stdout.write(`BASELINE | unmutated worktree | ${baseline}\n`);
if (baseline !== "pass") {
  process.stdout.write("=== BASELINE IS NOT GREEN; every result below would be meaningless\n");
  process.exit(1);
}

for (const m of MUTATIONS) {
  restore();
  const src = readFileSync(m.file, "utf8");
  const count = src.split(m.find).length - 1;
  if (count !== 1) {
    process.stdout.write(`${m.id} | ${m.what} | ANCHOR MATCHED ${count}x — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
  let mutated = src.replace(m.find, m.replace);
  if (m.id === "NC1") {
    for (const e of NC1_EXTRA) {
      if (mutated.split(e.find).length - 1 !== 1) {
        mutated = "";
        break;
      }
      mutated = mutated.replace(e.find, e.replace);
    }
    if (mutated === "") {
      process.stdout.write(`${m.id} | ${m.what} | SECONDARY ANCHOR MISSED — NOT APPLIED\n`);
      findings += 1;
      restore();
      continue;
    }
  }
  writeFileSync(m.file, mutated);
  const outcome = await runTests();
  restore();
  const reddened = outcome !== "pass";
  const ok = m.expect === "red" ? reddened : !reddened;
  if (!ok) findings += 1;
  process.stdout.write(
    `${m.id} | ${m.what} | expected ${m.expect} | got ${outcome} | ${ok ? "as expected" : "*** UNEXPECTED ***"}\n`,
  );
}

restore();
const allOk = Object.entries(PRISTINE).every(([p, b]) => sha(readFileSync(p, "utf8")) === sha(b));
process.stdout.write(`\n=== ALL FILES RESTORED OK: ${allOk}\n=== UNEXPECTED RESULTS: ${findings}\n`);
