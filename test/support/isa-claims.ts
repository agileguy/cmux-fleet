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
    isc: "ISC-263",
    grade: "[x]",
    claim:
      "The matcher is SHARED, not copied: `src/security/egress.ts` imports the same " +
      "`egress-policy.cjs` the in-container proxy requires. Empty here means the two " +
      "have been split back into separate implementations, and the label-boundary " +
      "rule is the thing least survivable as two copies.",
    argv: ["grep", "-rn", "egress-policy.cjs", "src/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-263",
    grade: "[x]",
    claim:
      "A cloud_access worker is actually TOLD about the proxy. Empty here means the " +
      "proxy runs and nothing points at it — the credential-granted-for-a-path-that-" +
      "does-not-exist failure this criterion exists to close, reintroduced.",
    argv: ["grep", "-rn", "HTTPS_PROXY", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-263",
    grade: "[x]",
    claim:
      "The relay entrypoint still STARTS the proxy. Listed separately from the two " +
      "above because every loopback probe spawns connect-proxy.cjs directly: if this " +
      "call went away they would all stay green while a cloud_access worker got " +
      "connection-refused.",
    argv: ["grep", "-rn", "startProxy", "docker/egress-relay.cjs"],
    expect: "nonempty",
  },
  {
    isc: "ISC-263",
    grade: "[x]",
    claim:
      "The CLOSING probe — the live enumeration of the proxy's destination surface — " +
      "still exists. This is the criterion's own stated closing condition, and it is " +
      "the only thing that measures the `{3128 -> POLICY}` term of the reachable set; " +
      "every port scan in the suite reports `3128 open` and stops.",
    argv: ["grep", "-rn", "ISC-263 closing", "test/integration/relay.test.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-243",
    grade: "[~]",
    claim:
      "The denylist is still the mechanism the graded allowlist was UNIONED with, not " +
      "one it replaced. This criterion grades `[~]` precisely because `replaces` is " +
      "unsatisfied, so an empty result here means the denylist was deleted — at which " +
      "point the grade is wrong in the OTHER direction and the entry needs rewriting, " +
      "not this line editing.",
    argv: ["grep", "-rn", "DEFAULT_HARNESS_PATTERNS", "src/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-243",
    grade: "[~]",
    claim:
      "The graded surface is READ by the adjudicator. Empty here means the allowlist " +
      "has become a correct module beside a path nothing exercises — the RC-1 shape " +
      "this ISA has now recorded ten times, and the exact defect ISC-150 shipped as.",
    argv: ["grep", "-rn", "harness.graded", "src/harvest/adjudicate.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-243",
    grade: "[~]",
    claim:
      "The graded surface is WRITTEN by the harvester. The read above and this write " +
      "are listed separately on purpose: ISC-150 had a live reader and no writer, and " +
      "one claim covering both would have gone green on that exact bug.",
    argv: ["grep", "-rn", "gradedSurface", "src/harvest/index.ts"],
    expect: "nonempty",
  },
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
    grade: "[x]",
    claim:
      "The supervisor CONSTRUCTS a `TokenRefresher` and drives its production loop — the " +
      "criterion's verb. Both lines, because either alone is the defect the other hides: a " +
      "refresher nobody runs, or a `run()` on something else.",
    argv: ["grep", "-En", "new TokenRefresher\\(|refresher\\.run\\(", "src/supervisor/index.ts"],
    expect: 2,
  },
  {
    isc: "ISC-248",
    grade: "[x]",
    claim:
      "The refresher is torn down on the supervisor's shutdown path. Without this the " +
      "process kept a live loop and a pending timer and would not exit — which is a wiring " +
      "defect that looks exactly like a hang.",
    argv: ["grep", "-n", "refreshAbort.abort()", "src/supervisor/index.ts"],
    expect: 1,
  },
  {
    isc: "ISC-248",
    grade: "[x]",
    claim:
      "The credential PLAN travels in the launch record rather than being re-derived by " +
      "the supervisor, so the container that starts and the credential it is given cannot " +
      "disagree.",
    argv: ["grep", "-n", "credential:", "src/run/materialize.ts"],
    expect: 1,
  },
  {
    isc: "ISC-41",
    grade: "[x]",
    claim:
      "The ADC-gated probes are REQUIRED to run in the `container` job, not merely allowed to. " +
      "ISC-41 and ISC-47 are graded on those probes executing in CI; an operator who pinned them " +
      "as expected skips would rot both grades silently, so the empty pin is what this checks.",
    argv: ["grep", "-n", 'EXPECTED_HOST_ADC_MINT_SKIPS: ""', ".github/workflows/ci.yml"],
    expect: 1,
  },
  {
    isc: "ISC-48",
    grade: "[x]",
    claim:
      "The impersonation target reaches the probe from CI. The grade rests on that probe RUNNING " +
      "in the container job, and it self-skips when the variable is empty — so a workflow that " +
      "stopped passing the secret would skip it and look green.",
    // The ASSIGNMENT, not any mention: a TOTAL_EXPECTED derivation comment
    // names the variable too, and a claim that counted both would stay green
    // if the assignment were deleted and the comment left behind.
    argv: [
      "grep",
      "-nE",
      "^ +PIFLEET_IMPERSONATION_TARGET: \\$\\{\\{ secrets\\.GCP_IMPERSONATION_TARGET \\}\\}$",
      ".github/workflows/ci.yml",
    ],
    expect: 1,
  },
  {
    isc: "ISC-189",
    grade: "[x]",
    claim:
      "`buildImage` stamps all THREE identity labels. The whole launch-gate identity check reads " +
      "them back, so dropping one silently converts `imageIdentityDrift` into a check that " +
      "compares two fields instead of three — and dropping all three converts it into one that " +
      "fails closed on every image, which is the loud direction but still not the graded one. " +
      "The real-daemon probe in `image.test.ts` reads these back from a built image and would " +
      "catch it, but ONLY in the Docker-gated container job; this re-reads the claim in every " +
      "job, in milliseconds, without a daemon.",
    argv: ["grep", "-nE", '"--label", `pifleet\\.', "src/container/image.ts"],
    expect: 3,
  },
  {
    isc: "ISC-290",
    grade: "[x]",
    claim:
      "`ci.yml` carries exactly TWO `PIFLEET_OMLX_MODEL:` assignments — GLM-4.5-Air-MLX-4bit " +
      "for `omlx-live`'s single-call probe, Qwen3.5-35B-A3B-8bit at `container-live`'s JOB " +
      "level for the whole chain — with the warmup step inheriting the job value rather than " +
      "repeating it. A THIRD assignment means a step-level pin has been reintroduced and the " +
      "model that gets loaded can drift from the model that gets graded. That drift is the " +
      "defect this criterion's 2026-08-26 note exists for: the chain failed intermittently for " +
      "two days against a model that answers the single-call probe 3/3 and cannot complete a " +
      "multi-turn agentic turn. Counts ASSIGNMENTS only, so the warmup's `${PIFLEET_OMLX_MODEL:?}` " +
      "reference is correctly not counted — inheriting is the fix, not the fault.",
    argv: ["grep", "-En", "^ +PIFLEET_OMLX_MODEL: ", ".github/workflows/ci.yml"],
    expect: 2,
  },
  {
    isc: "ISC-272",
    grade: "[~]",
    claim:
      "Neither identity WRITER spells its capture-failed degrade as a bare " +
      "`(await processStartTime(process.pid)) ?? \"\"`. That form does not degrade: since " +
      "ISC-192 `processStartTime` THROWS on a read it cannot trust, so `??` never sees the " +
      "failure and the writer dies instead. Measured 2026-08-26 against a `ps` on PATH that " +
      "exits 1 with a diagnostic — `supervisor/index.ts` died at startup before writing any " +
      "state file, and `startRegistryDaemon` threw out of the call, so on a host with no " +
      "procps `pifleet up` could not start a run at all. NONEMPTY here means the unguarded " +
      "form is back somewhere in `src/` and the `identity_unrecorded` refusal that `down.ts` " +
      "documents is once again unreachable from a real broken-`ps` writer. The pattern also " +
      "matches the form quoted in prose, deliberately: a comment that teaches the broken " +
      "spelling is how it comes back.",
    argv: ["grep", "-rn", 'processStartTime(process.pid)) ?? ""', "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-191",
    grade: "[~]",
    claim:
      "`--force-identity` is SCOPED to the pids the operator named, at BOTH anchor refusal " +
      "branches — the identity refusal and the group refusal. Two lines, because there are two " +
      "ways to be refused and a hatch that covers only one of them is a hatch with a hole. As a " +
      "boolean this flag authorised the rung-0 self-anchor against every refused pid in the run, " +
      "which is what held ISC-191 residual (a) and ISC-272's \"never a start time read off the " +
      "pid at rung 0\" clause open. Fewer than 2 means a branch went back to trusting the flag " +
      "rather than the pid; more means a third anchor site appeared and this claim needs " +
      "re-deriving rather than bumping.",
    argv: ["grep", "-rn", "opts.force.has(pid)", "src/cli/commands/down.ts"],
    expect: 2,
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
