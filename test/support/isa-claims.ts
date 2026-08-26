/**
 * NO CRITERION NUMBER WAS ALLOCATED FOR THIS, deliberately.
 *
 * ISC-299 is taken (the all-writes-refused epoch), and this ISA's own
 * convention — written into ISC-297's filing note — is that numbers are
 * "allocated centrally, not picked on the branch". A guard over the ISA is
 * repo hygiene rather than a statement about the product, so it is named
 * rather than numbered. If the owner wants it graded, the number is theirs to
 * allocate.
 */
/**
 * The ISA's mechanically-checkable claims, re-run every CI run.
 *
 * WHY THIS FILE EXISTS, stated as the measurement that produced it rather
 * than as a principle.
 *
 * On 2026-08-25 an audit found ISC-115 and ISC-193 graded `[ ]` on the
 * sentences *"`grep -rn "budget.ts" src/` returns nothing"* and *"neither arm
 * holds"*. Both were true when written on 2026-08-19 and false from
 * 2026-08-20, when the wiring commission gave the module three importers. That
 * commission re-graded ISC-109, ISC-114 and ISC-235 and stopped; nothing in
 * the repo re-reads a criterion's REASONS, only a human re-reads its checkbox,
 * so two criteria spent five days asserting the opposite of the code. The same
 * sweep found the same staleness in ISC-110, ISC-117 and a comment in
 * `src/safety/kill.ts` that told a reader at the source that the stall policy
 * was consulted by nothing.
 *
 * WHY A REGISTRY AND NOT A SCRAPER. Scraping the greps out of `ISA.md` was
 * tried first and is the wrong instrument: 41 backticked grep commands are in
 * that file and most are HISTORY — ISC-32's *"returns nothing"* describes the
 * state before the criterion closed, and re-running it now correctly returns
 * 13. A scraper cannot tell a live claim from a superseded one without reading
 * the paragraph around it, so it reports mostly false alarms, and a guard that
 * cries wolf gets its expectations edited rather than its subject fixed.
 * Listing the live ones by hand costs one line each and says something a
 * scraper cannot: that a human decided this claim still carries a grade.
 *
 * WHAT A FAILURE HERE MEANS. Not "fix the test". It means the code moved under
 * a criterion and the ISA now says something false about it. The fix is to
 * re-grade the criterion — verify, mutate, rewrite the entry — and only then
 * to update the line below. Editing the expectation to match the code, with
 * the entry left as it was, reproduces exactly the failure this file exists to
 * catch, and does it while showing green.
 *
 * TWO DIRECTIONS, DELIBERATELY. An `expect: "empty"` claim catches an entry
 * that has gone stale because something was BUILT ("nothing calls this" —
 * until something does). An `expect: "nonempty"` claim catches the opposite
 * and rarer case: a closed criterion whose wiring is silently REMOVED, which
 * no checkbox anywhere would notice. Both are how a grade stops being true.
 *
 * ARGV, NOT A SHELL STRING. `ISA.md` records
 * `grep -rn 'getpeereid|SO_PEERCRED|…' src/` for ISC-126 and
 * `grep -rni 'escape attempt|breakout|…' src/` for ISC-125. Neither can
 * produce the count its entry reports: `grep` without `-E` reads `|` as a
 * literal, so both return zero against entries claiming NOTHING and exactly
 * one respectively. A claim whose command cannot reproduce its own number is
 * not evidence, and building this registry is what surfaced it. Everything
 * here is spawned as argv with the pattern flavour named explicitly.
 */

/** One claim in `ISA.md` that a command can re-check. */
export interface IsaClaim {
  /** The criterion whose grade rests on this, e.g. `"ISC-115"`. */
  isc: string;
  /** That criterion's grade at the time this line was written. */
  grade: "[x]" | "[~]" | "[ ]";
  /** The claim as `ISA.md` words it, so a failure quotes the entry. */
  claim: string;
  /** Spawned directly — no shell, so no quoting can change the pattern. */
  argv: readonly string[];
  /** Result lines under these path prefixes are dropped before counting. */
  exclude?: readonly string[];
  /** `"empty"`, `"nonempty"`, or an exact line count. */
  expect: "empty" | "nonempty" | number;
}

export const ISA_CLAIMS: readonly IsaClaim[] = [
  {
    isc: "ISC-74",
    grade: "[x]",
    claim:
      "No backend implementation names supervisor-lifecycle machinery — the " +
      "restated anti-criterion. This entry REPLACED one asserting that nothing in " +
      "test/ named ISC-74 at all, which was the state while the criterion was open " +
      "and became false the moment it closed; kept as a worked example of a claim " +
      "that had to be revisited with its grade rather than edited to match.",
    argv: [
      "grep",
      "-rEn",
      "launchDetached|processLauncher|supervisorArgv|runKillLadder|killWedged|process\\.kill",
      "src/backends/",
    ],
    exclude: ["src/backends/types.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-114",
    grade: "[x]",
    claim:
      "The supervisor parses no `get_session_stats` payload, so in production the " +
      "ceiling rides entirely on the transcript's A4 usage.",
    argv: ["grep", "-rn", "get_session_stats", "src/supervisor/"],
    expect: "empty",
  },
  {
    isc: "ISC-115",
    grade: "[x]",
    claim:
      "`src/safety/budget.ts` is reachable from production — the unreachable-island " +
      "state this criterion was re-graded for is over. Empty here means the budget " +
      "has been unwired and nothing halts again.",
    argv: ["grep", "-rn", "safety/budget", "src/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-193",
    grade: "[x]",
    claim:
      "`budgetExitCode` folds into `worstExit`, in `wait` and in the scheduler. Empty " +
      "here means EXIT.BUDGET is a rung in EXIT_SEVERITY with nothing able to stand " +
      "on it, which is the state arm one of this disjunction forbids.",
    argv: ["grep", "-rn", "codes.push(budgetExitCode", "src/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-110",
    grade: "[x]",
    claim:
      "The scheduler consults `classifyStall` on every poll. This entry claimed the " +
      "opposite for four days after the stall-wiring commission made it false; empty " +
      "here means the policy is a written rule nothing reads, again.",
    argv: ["grep", "-rn", "classifyStall(", "src/orchestrate/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-116",
    grade: "[x]",
    claim:
      "`TaskDeadlineError` still has no producer — the direct-exit path it exists for " +
      "is unreachable, and this criterion rests on the exit-code protocol it satisfies " +
      "rather than on a caller.",
    argv: ["grep", "-rn", "new TaskDeadlineError", "src/"],
    exclude: ["src/safety/kill.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-125",
    grade: "[ ]",
    claim:
      "The run report carries no security field at all, so a detected hazard reaches " +
      "no operator-visible surface. Any hit means the reporting half of this criterion " +
      "has been built and the entry's cost estimate is out of date.",
    argv: ["grep", "-rn", "hazard", "src/report/"],
    expect: "empty",
  },
  {
    isc: "ISC-157",
    grade: "[x]",
    claim: "The subject of the sentence does not exist: there is no schema version anywhere.",
    argv: ["grep", "-rEn", "schema_version|SCHEMA_VERSION|schemaVersion", "src/", "test/"],
    expect: "empty",
  },
  {
    isc: "ISC-246",
    grade: "[~]",
    claim:
      "`scan.safe` has no production consumer — `harvest/index.ts` reads `scan.refused` " +
      "and never touches it. That is precisely why this stays `[~]`: the descriptor " +
      "work is a module nothing calls. A hit here is the E3 consumer arriving, and the " +
      "grade can move.",
    argv: ["grep", "-rn", "scan.safe", "src/"],
    exclude: ["src/harvest/outbox.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-248",
    grade: "[ ]",
    claim:
      "`TokenRefresher` has zero callers anywhere in `src/`, so it does not run on the " +
      "supervisor's lifecycle or on any other.",
    argv: ["grep", "-rn", "security/refresh", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-248",
    grade: "[ ]",
    claim:
      "There is no credential RUNTIME path to attach a refresher to: nothing in " +
      "production mints a token and nothing injects one, outside `security/adc.ts` and " +
      "`security/refresh.ts`'s own options interface.",
    argv: ["grep", "-rEn", "injectToken|gcloudMinter|: Minter", "src/"],
    exclude: ["src/security/adc.ts", "src/security/refresh.ts"],
    expect: "empty",
  },
] as const;

/**
 * THE GUARD MUST NOT OBSERVE ITSELF, and it did on its first run.
 *
 * Every claim above quotes its own search string, so a claim scanning `test/`
 * matches this registry and the file that runs it: ISC-74 expected 1 hit and
 * got 4, three of them these two files, and ISC-157's "no schema version
 * anywhere" was falsified by the line that looks for schema versions. Left
 * alone the obvious repair is to relax the expectation — which is precisely
 * the move the header warns against, and would have been made against a
 * failure that says nothing about the product at all.
 */
const SELF = ["test/support/isa-claims.ts", "test/unit/isa-claims.test.ts"] as const;

/** What one claim's command actually returns now. */
export async function runIsaClaim(c: IsaClaim): Promise<string[]> {
  const p = Bun.spawn([...c.argv], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const drop = [...SELF, ...(c.exclude ?? [])];
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => !drop.some((prefix) => l.startsWith(prefix)));
}
