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
    isc: "ISC-337",
    grade: "[x]",
    claim:
      "The env plan assigns the POINTER and never the value. This is the single line the whole " +
      "criterion rests on: `vars` is what `serializeEnvFile` renders and what `--env-file` " +
      "carries, so a value never assigned into it cannot reach any process in the container. " +
      "Pinned on the ASSIGNMENT rather than on a count of mentions, because `secretContainerPath` " +
      "appears in prose in this repo's comments and an editor tidying those must not be able to " +
      "turn the claim red. It goes red if someone restores `vars[requested] = value`, which is " +
      "exactly the mutation ISC-337 was proved against.",
    argv: ["grep", "-nF", "vars[pointer] = secretContainerPath(requested);", "src/run/worker-env.ts"],
    expect: 1,
  },
  {
    isc: "ISC-337",
    grade: "[x]",
    claim:
      "NO name under `secrets:` is assigned into the env plan by its own name. An ABSENCE claim, " +
      "and the direction matters: the claim above pins what the code DOES, and this pins what it " +
      "must never go back to doing. `vars[requested]` is the exact expression that put a " +
      "credential in a durable artifact and on the wire to the inference server, and a future " +
      "edit could reintroduce it beside the pointer rather than in place of it — which every " +
      "assertion pinned on the pointer's presence would survive.",
    argv: ["grep", "-rnF", "vars[requested] = value", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-340",
    grade: "[x]",
    claim:
      "The secret store's mount is emitted READ-ONLY, from the path `run/paths.ts` names, and " +
      "there is exactly one of it. Pinned on the whole `-v` expression including the `:ro` " +
      "suffix, so it goes red on three separate regressions that have no other symptom: the " +
      "flag being dropped, the path being joined at the mount site instead of taken from " +
      "`workerPaths()` (ISC-188's shape, where Docker silently creates the missing source), and " +
      "the mount being deleted outright.",
    argv: [
      "grep",
      "-nF",
      "argv.push(\"-v\", `${opts.worker.secretsDir}:${SECRETS_MOUNT}:ro`);",
      "src/config/render.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-339",
    grade: "[~]",
    claim:
      "The worker directory holding the store is TIGHTENED to 0700, which is what makes the " +
      "0444 file mode safe on the host rather than a regression against the 0600 env file it " +
      "replaced. Pinned because it is the load-bearing half of a two-part trade and the half " +
      "with no visible symptom if it disappears: removing it leaves every probe in the suite " +
      "green except the one that reads the mode back, and leaves a world-readable credential " +
      "under a world-traversable run directory. The grade is `[~]` because the mode deviates " +
      "from the commissioned 0400 — see the entry for why 0400 is unreadable to the worker uid " +
      "on Linux and invisibly fine on macOS.",
    argv: ["grep", "-nF", "await chmod(paths.dir, 0o700);", "src/run/materialize.ts"],
    expect: 1,
  },
  {
    isc: "ISC-341",
    grade: "[x]",
    claim:
      "The anti-criterion is proved by SPAWNING a shell, not by inspecting an object. `/bin/sh` " +
      "runs with the env plan as its entire environment and `$TICKET_API_TOKEN` must expand to " +
      "nothing. Pinned as a `nonempty` claim because what can go wrong here is the probe being " +
      "SILENTLY WEAKENED — rewritten as `expect(plan.vars[...]).toBeUndefined()`, which asserts " +
      "something about a JavaScript object rather than about what a worker's shell prints, and " +
      "which no checkbox anywhere would notice had happened.",
    argv: [
      "grep",
      "-nF",
      "const p = Bun.spawn([\"/bin/sh\", \"-c\", `printf %s \"${expr}\"`], {",
      "test/unit/worker-secret-files.test.ts",
    ],
    expect: "nonempty",
  },
  {
    isc: "ISC-342",
    grade: "[x]",
    claim:
      "The secret writer VERIFIES by reading back, rather than trusting `writeFile` to have " +
      "resolved. Pinned on the `stat` because that call is the whole refusal: with it replaced " +
      "by a fabricated result — the mutation this criterion was proved against — a full disk, a " +
      "device node, or a mode the worker uid cannot read all produce a launch that reports " +
      "success and a container that cannot authenticate.",
    argv: ["grep", "-nF", "const st = await stat(path).catch(() => null);", "src/run/worker-env.ts"],
    expect: 1,
  },
  {
    isc: "ISC-343",
    grade: "[x]",
    claim:
      "The credential sweep's needle supplier reads the SECRET STORE, which is where the " +
      "values live once ISC-337..342 moved them out of the environment. Empty here is the " +
      "supplier reading only the env file again — which after that move carries `<NAME>_FILE` " +
      "pointers and no values, so every grant resolves to nothing and the sweep runs empty. " +
      "That is ISC-333's defect restored by its own sibling, and it fails GREEN: the delivery " +
      "tests assert the value is absent from the env file, which is the same fact that blinds " +
      "the sweep.",
    argv: ["grep", "-nF", "valuesFromStore(wp, granted)", "src/harvest/needles.ts"],
    expect: 1,
  },
  {
    isc: "ISC-343",
    grade: "[x]",
    claim:
      "The sweep's fixture builds its store with the PRODUCTION writer rather than " +
      "hand-writing the layout. Empty here means the fixture has gone back to encoding a " +
      "layout of its own, which is what let the delivery change and the supplier disagree " +
      "while both their test suites stayed green. Sourcing it from the writer is what makes " +
      "a future change to delivery a red build here instead of a quiet zero on the next " +
      "real harvest.",
    argv: [
      "grep",
      "-nF",
      "writeWorkerSecretFiles(wp.secretsDir, plan)",
      "test/unit/harvest-credential-sweep-wiring.test.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-344",
    grade: "[~]",
    claim:
      "The mounted skill tells the worker to filter on the SERVER rather than download a " +
      "collection and grep it. Empty here means the guidance was dropped from the bundle a " +
      "worker actually receives. This claim is deliberately weak and the grade says so: it " +
      "verifies the fleet SHIPS the instruction, and verifies nothing about whether a worker " +
      "followed it. A run that grepped pages out of 59,616 objects reported zero tickets for " +
      "a user who had thirty, and no mechanism here would catch that recurring.",
    argv: ["grep", "-nF", "Filter on the server", "skills/ticket-ops/SKILL.md"],
    expect: 1,
  },
  {
    isc: "ISC-344",
    grade: "[~]",
    claim:
      "The canonical call in the mounted skill carries `--max-time`, so the shape a worker " +
      "copies is a bounded one. Empty here means the documented example went back to an " +
      "unbounded request — which inside a container does not fail but HANGS, leaving the " +
      "supervisor nothing but silence and killing the run with no reason recorded. Still " +
      "`[~]`: this pins the EXAMPLE, not the calls a worker actually issues.",
    // The pattern deliberately starts at `curl` rather than at `--max-time`:
    // a pattern leading with `-` is consumed by grep as an OPTION, which is how
    // this claim failed the first time it ran. It failed loudly, which is the
    // guard doing its job — but a claim that cannot express its own subject is
    // worth a comment so the next one is not written the same way.
    argv: [
      "grep",
      "-nF",
      "curl -sS --fail-with-body --max-time 60 --config",
      "skills/ticket-ops/SKILL.md",
    ],
    expect: 1,
  },
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
    grade: "[x]",
    claim:
      "The denylist is still the mechanism the graded allowlist is UNIONED with, and the " +
      "criterion was RESTATED on 2026-08-27 to say so rather than to claim it was " +
      "replaced. An empty result here means the denylist was deleted — at which point the " +
      "restated wording is wrong in the OTHER direction and the entry needs rewriting, " +
      "not this line editing.",
    argv: ["grep", "-rn", "DEFAULT_HARNESS_PATTERNS", "src/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-243",
    grade: "[x]",
    claim:
      "The graded surface is READ by the adjudicator. Empty here means the allowlist " +
      "has become a correct module beside a path nothing exercises — the RC-1 shape " +
      "this ISA has now recorded ten times, and the exact defect ISC-150 shipped as.",
    argv: ["grep", "-rn", "harness.graded", "src/harvest/adjudicate.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-243",
    grade: "[x]",
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
  /**
   * REPLACED 2026-08-27, and the replacement is the point rather than a
   * bookkeeping detail.
   *
   * The old claim was `grep -rn hazard src/report/` -> empty, worded as "the
   * run report carries no security field at all … any hit means the reporting
   * half of this criterion has been built". ISC-125 then built the reporting
   * half — as `security.escape_watch`, not as hazards — so that command STILL
   * returns empty and the claim would have gone on passing while the sentence
   * it defends had become false. A grep that cannot fail when the thing it
   * describes changes is the stale-grounds shape this whole file exists to
   * catch, arriving through the one direction the two-direction design does
   * not cover: a claim whose SUBJECT moved.
   *
   * `RepoHazard` remains unwired to any report surface. That is now stated in
   * the ISA entry as an explicitly unclosed residual rather than carried here
   * as a claim about ISC-125, because it never was one.
   */
  {
    isc: "ISC-125",
    grade: "[x]",
    claim:
      "The report's security surface exists and is REACHED: `security.escape_watch` in " +
      "the schema, filled by `collectEscapeWatch`, rendered by `renderEscapeWatch`. All " +
      "three, because any one alone is the defect the others hide — a field nothing " +
      "fills, a collector nothing reads, or a renderer for a field that is always empty.",
    // `-l` rather than `-n`: the claim is "all THREE surfaces reference it",
    // which is one output line per file. A line count would also move when a
    // comment mentioning the field is reworded, so it would be brittle about
    // the wrong thing.
    argv: ["grep", "-rEl", "escape_watch", "src/contracts.ts", "src/report/collect.ts", "src/report/render.ts"],
    expect: 3,
  },
  /**
   * The detector's two halves, which are shell and node rather than
   * TypeScript and so are invisible to every other check in this repo.
   *
   * The socket path is what makes the seed the one the criterion names, and
   * the fatal branch is the owner decision the whole guarantee rests on: a
   * honeypot whose listener has silently died reports "no escape attempt"
   * when it was simply not watching. An entrypoint that went back to a bare
   * `exec` would leave every probe in honeypot.test.ts still passing except
   * one, and this line makes the removal visible by itself.
   */
  {
    isc: "ISC-125",
    grade: "[x]",
    claim:
      "The bait is bound at /var/run/docker.sock and the entrypoint ends the worker if " +
      "the listener dies. Both files, because the detector and its supervisor fail " +
      "independently and the second failing is the silent one.",
    argv: ["grep", "-En", "/var/run/docker.sock|ending the worker", "docker/honeypot.cjs", "docker/entrypoint.sh"],
    expect: "nonempty",
  },
  /**
   * ISC-119's closing evidence is a Docker-gated probe, so nothing here can
   * re-run it. What CAN be re-checked is the coupling that makes it
   * non-vacuous: the probe takes its denial flags from `buildPiArgv` rather
   * than spelling them out, so production dropping a flag reddens the probe
   * instead of leaving it proving that a flag nobody uses works.
   */
  {
    isc: "ISC-119",
    grade: "[x]",
    claim:
      "The real-Pi probe derives the denial flags from production. A literal list here " +
      "would go green on a `buildPiArgv` that had stopped emitting `--no-extensions`.",
    argv: ["grep", "-n", "buildPiArgv", "test/integration/hostile-pi.test.ts"],
    expect: "nonempty",
  },
  /**
   * ISC-141 rests on a scenario capability that did not exist: `emit_before_ack`
   * is the only way to place a record BELOW `ack_seq`, which is the only region
   * where `attribute` can answer `prior` for a live epoch. Delete it and the
   * supervisor probe stops testing the fence while still passing on the
   * post-ack half.
   */
  {
    isc: "ISC-141",
    grade: "[x]",
    claim:
      "The pre-ack region is reachable from a scenario. `emit_before_ack` in the double " +
      "and the fixture that uses it are what put a record below `ack_seq`; without both, " +
      "no test can drive the conjunct this criterion closed on.",
    argv: [
      "grep", "-rl", "emit_before_ack",
      "test/fixtures/fake-pi.ts", "test/fixtures/scenarios/stale-start.json",
    ],
    expect: 2,
  },
  /**
   * A claim against the WIRING, added 2026-08-27 because nothing here defended
   * it and the entry's own headline bracket had gone stale describing its
   * absence.
   *
   * These are the two lines that make the rule's antecedent reachable, and they
   * are pinned rather than the FIELDS because the inert state assigned those
   * same field names a literal `null`. A grep for the assignment would have
   * matched the broken code and stayed green through exactly the regression
   * that caused the original filing. It is the SAMPLING that is load-bearing:
   * measured 2026-08-27, reverting both lines to `= null` reddens all three
   * ISC-154 probes in `harvest.test.ts`.
   *
   * The entry's residual was a LEVEL, not a mutation — every probe was a
   * host-process test — and `full-chain.test.ts` now drives the rule through a
   * real containerised backgrounded writer, which is what moved the grade.
   */
  {
    isc: "ISC-154",
    grade: "[x]",
    claim:
      "Both tree hashes are really SAMPLED — the quiesce one read from an epoch-matched " +
      "task record, the harvest one hashed off the live worktree. Without these two the " +
      "fields are null on every run, the comparison can never differ, and the criterion's " +
      "rule is decorative. This pins the antecedent as reachable; it does not close the " +
      "criterion, whose residual is an end-to-end containerised run.",
    argv: [
      "grep", "-En",
      "record\\.tree_hash : null|worktreeContentHash\\(envelope\\.host_workdir\\)",
      "src/harvest/index.ts",
    ],
    expect: 2,
  },
  /**
   * ISC-191's residual is closed as a PINNED CONSEQUENCE rather than a fix, and
   * a pin nobody can see is not a pin. `group_spared` is the whole reporting
   * half: without it `down` says `stopped: true, forced_identity: true` and
   * leaves an operator to infer that the supervisor's children went with it.
   *
   * The production site is pinned, not the test, because the test asserting a
   * field production has stopped emitting is the failure this registry exists
   * to catch elsewhere in this file.
   */
  {
    isc: "ISC-191",
    grade: "[x]",
    claim:
      "A forced stop REPORTS the group it declined to signal. Losing this line makes the " +
      "orphaned children silent again, which is the state the residual was closed out of.",
    argv: ["grep", "-n", "group_spared", "src/cli/commands/down.ts"],
    expect: 3,
  },
  /**
   * ISC-272's residual (2) turned on EPERM ceasing to be an exception. The
   * grep is for the MAPPING, not for the string: `signal_refused` appears in
   * the type, in three consumers and in `down`'s table, so any of those would
   * satisfy a looser search while the one line that produces it was gone.
   */
  {
    isc: "ISC-272",
    grade: "[x]",
    claim:
      "EPERM is answered, not thrown. Without this line the ladder escapes again and one " +
      "unsignallable worker takes `reapStale`'s whole pass with it.",
    argv: ["grep", "-n", 'code === "EPERM"', "src/safety/kill.ts"],
    expect: 1,
  },
  /**
   * ISC-300 is FILED, not started, and this is what keeps that honest. The
   * criterion is about a disagreement between two sites; if the reaper's side
   * of it changes, the entry describing the trade stops describing the code and
   * the grade has to move one way or the other.
   *
   * THIS CLAIM WAS VACUOUS FOR ONE COMMIT AND THE FAILURE IS WORTH KEEPING. It
   * first pinned the narrowing at its old call site. When the decision moved
   * into `reapSupervisor` — same behaviour, one place instead of two — the old
   * spelling survived only inside a COMMENT explaining the move, and the grep
   * went on passing against prose while the code it was defending had gone.
   * Green, and defending nothing. `ISC-272`'s writer claim in this same file
   * warns about exactly this ("a comment that teaches the broken spelling is
   * how it comes back") and the warning turned out to cut both ways: prose can
   * keep a claim ALIVE as easily as it can reintroduce a defect. The comment
   * at that site now deliberately declines to quote the form.
   */
  {
    isc: "ISC-300",
    grade: "[x]",
    claim:
      "The reaper NARROWS a capture-failed group to the leader rather than refusing — the arm " +
      "the owner chose, pinned at the one line that makes the decision. A miss means somebody " +
      "flipped the trade without revisiting the entry that records why it was settled this way.",
    argv: ["grep", "-n", "narrowed ? null : target.pgid", "src/safety/reaper.ts"],
    expect: 1,
  },
  /**
   * The REPORTING half, pinned where it was actually broken.
   *
   * The claim above pins the decision. This one pins the fact that the decision
   * reaches the permanent record, because for one commit it did not: `group`
   * was on `ReapReport`, asserted by three probes, and dropped by the daemon
   * callback that builds the ledger row. Pinning the field on the type would
   * have stayed green throughout — the type was never the broken part.
   */
  {
    isc: "ISC-300",
    grade: "[x]",
    claim:
      "The reap ledger row carries the group action, not just the in-process report. " +
      "A miss means the daemon is back to writing a row an operator cannot read the " +
      "narrowing out of.",
    argv: ["grep", "-n", "group: r.group", "src/cli/commands/daemon.ts"],
    expect: 1,
  },
  /**
   * The release site, pinned in the file that leaked rather than in `outbox.ts`.
   *
   * `closeOutboxScan` has always EXISTED; what it lacked was a caller. Greping
   * for its definition would have been green throughout the leak, which is the
   * distinction this claim exists to make.
   */
  /**
   * TWO claims, because either alone is the defect the other hides: a
   * combinator that releases but nothing calls, or a caller that takes
   * ownership from something that does not give the descriptors back.
   *
   * This pair replaced a single claim pinned at `harvest/index.ts`, which went
   * red the moment the release moved into the combinator. That was the guard
   * working: the release had genuinely moved, and a claim that survived the
   * move would have been pinning a location rather than a property.
   */
  {
    isc: "ISC-301",
    grade: "[x]",
    claim:
      "The scan combinator releases in a `finally`, so the descriptors come back on the " +
      "throwing path too — the path `harvestAll` catches and loops past, which is the one " +
      "that would accumulate the most of them.",
    argv: ["grep", "-n", "await closeOutboxScan(scan);", "src/harvest/outbox.ts"],
    expect: 1,
  },
  {
    isc: "ISC-301",
    grade: "[x]",
    claim:
      "harvestTask takes its scan FROM that combinator rather than opening one it must " +
      "remember to close. A miss means ownership went back to being a contract in a comment.",
    argv: [
      "grep",
      "-nF",
      "return await withOutboxScan(loc, async (scan) =>",
      "src/harvest/index.ts",
    ],
    expect: 1,
  },
  /**
   * The relay's own preflight, pinned at the CALL and not at the import.
   *
   * An import survives the call being deleted, and the call is the entire
   * guarantee: `up`'s assertion runs some five hundred lines later and over the
   * worker argvs, none of which carry the relay's sources.
   */
  {
    isc: "ISC-292",
    grade: "[x]",
    claim:
      "The relay probes its own bind-mount sources before it launches. A miss means a " +
      "checkout outside the runtime's shared set silently mounts three empty directories " +
      "where the relay's scripts belong, and the relay dies blaming its listen port.",
    argv: [
      "grep",
      // -F, because the call carries square brackets and a BRE would read
      // them as a character class — matching any one of r, u, n, A, g, v, and
      // so passing against almost any line in the file.
      "-nF",
      "assertBindMountsVisible([runArgv], RELAY_IMAGE, exec)",
      "src/security/relay.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-292",
    grade: "[x]",
    claim:
      "`doctor` reports the CHECKOUT as a mount root, not just the runs and scratch roots — " +
      "the half an operator can run BEFORE up rather than after it.",
    argv: ["grep", "-n", 'name: "checkout"', "src/cli/commands/doctor.ts"],
    expect: 1,
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
    grade: "[x]",
    claim:
      "The consumer exists and it is production: `harvestTask` reconciles the envelope's " +
      "artifact claims against the scan inside its own ownership window. This replaced an " +
      "absence-claim that expected `scan.safe` to have no reader at all — it went red when " +
      "the reconciler landed, which is what it was written to do. RE-PINNED for ISC-332: " +
      "the call grew a fourth argument (the `secrets` needle list the ticket-ops validation " +
      "takes), so the old fixed string stopped matching a call that was still there. The " +
      "new pattern is the same pin one argument wider — it still names the scan, the " +
      "claim list and the location positionally, so it fails if the call is deleted, if the " +
      "reconciler stops being handed the scan, or if the claims stop being handed to it.",
    argv: [
      "grep",
      "-nF",
      "await reconcileArtifactClaims(scan, claimed?.artifacts ?? null, loc, {",
      "src/harvest/index.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-246",
    grade: "[x]",
    claim:
      "The bytes come off the DESCRIPTOR the scan validated, not off the name. Pinned as " +
      "the positional read rather than as a mention of `handle`, because the whole " +
      "criterion is that the inode which passed realpath/nlink/O_NOFOLLOW is the inode a " +
      "consumer reads.",
    argv: ["grep", "-nF", "await f.handle.read(buf, 0, want, total)", "src/harvest/reconcile.ts"],
    expect: 1,
  },
  {
    isc: "ISC-246",
    grade: "[x]",
    claim:
      "The reconciler cannot dereference a worker-authored path even by accident: it " +
      "imports no filesystem module. §12.5 calls opening a claimed path an exfiltration " +
      "primitive, and the guarantee here is structural rather than a convention a later " +
      "edit could forget — an import is what such an edit would have to add first.",
    argv: ["grep", "-n", "node:fs", "src/harvest/reconcile.ts"],
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
    grade: "[x]",
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
    grade: "[x]",
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
  {
    isc: "ISC-304",
    grade: "[x]",
    claim:
      "`secrets.env_allowlist` HAS A READER. This criterion exists because the field " +
      "shipped with exactly one occurrence in the tree — its own declaration — so an " +
      "operator could write it and no variable reached any container. Empty here means " +
      "the selector was deleted and the field is documentation again.",
    argv: ["grep", "-rn", "env_allowlist", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-307",
    grade: "[~]",
    claim:
      "The stderr grant line interpolates the NAMES field and not the values map. This is " +
      "the grep the [~] grade rests on: nothing reads that line back, so it is the only " +
      "thing standing between an operator-facing log and a secret inside it.",
    argv: ["grep", "-rn", "secretNames", "src/run/materialize.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-308",
    grade: "[x]",
    claim:
      "The reserved-name refusal still consults the REAL credential set rather than a " +
      "hand-copied list. Empty means worker-env.ts stopped importing it, at which point a " +
      "variable added to that set is silently requestable through `secrets:`.",
    argv: ["grep", "-rn", "CREDENTIAL_ENV_VARS", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-308",
    grade: "[x]",
    claim:
      "The namespaces the fleet owns outright are still enforced by prefix. Empty means " +
      "that arm was dropped and only explicitly-named variables are refused, which " +
      "reopens PIFLEET_* and GIT_CONFIG_* to a config line.",
    argv: ["grep", "-rn", "RESERVED_PREFIXES", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-309",
    grade: "[x]",
    claim:
      "The proxy gate names the egress grant, not the cloud grant alone. Empty here means " +
      "the route was welded back onto `cloud_access` and a worker needing only a network " +
      "path must again be handed a Google identity to get one.",
    argv: ["grep", "-rn", "egressAccess", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-305",
    grade: "[x]",
    claim:
      "`up` still refuses an unresolvable `secrets:` BEFORE the run directory exists. " +
      "Empty means the hoisted gate went away and the refusal moved back to materialize, " +
      "after the clones and the remotes in the operator's own repository.",
    argv: ["grep", "-rn", "assertSecretsResolvable", "src/cli/commands/up.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-332",
    grade: "[x]",
    claim:
      "The schema HAS a production caller, and this line is the far side of a tripwire that " +
      "fired as designed. It previously read `expect: 1` on `grep -rn parseTicketOpsArtifact " +
      "src/` — an absence-claim asserting the definition was the only occurrence — and it " +
      "went red the moment the harvester began parsing a `ticket-ops.json` it finds, which " +
      "is precisely what it was written to detect. The criterion was then RE-GRADED to `[x]` " +
      "and this entry rewritten; the number was not bumped with the entry left saying the " +
      "wiring is absent. It flipped to `nonempty` with the direction reversed for the same " +
      "reason: what can go wrong now is the wiring being SILENTLY REMOVED, and no checkbox " +
      "would notice. Pinned on the CALL rather than on a count of mentions, because two of " +
      "the five occurrences in `src/` are prose in comments and an editor tidying those " +
      "must not be able to turn this claim red.",
    argv: ["grep", "-nF", "parseTicketOpsArtifact(raw, secrets)", "src/harvest/reconcile.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-332",
    grade: "[x]",
    claim:
      "A failed ticket-ops validation still DEGRADES THE VERDICT, which is the half of the " +
      "criterion a discrepancy alone does not satisfy: the finding without the clamp is a " +
      "`success` task with 'this artifact is malformed' printed underneath it, which is the " +
      "surprise at read time relocated rather than removed. Pinned in `harvest/index.ts` " +
      "because the adjudicator structurally cannot do this — it is handed derived facts and " +
      "a claim, never a descriptor, so artifact CONTENT is the one class of evidence it " +
      "never sees. Empty means the clamp was dropped and the reconciler's ceiling is " +
      "computed and discarded, which is the ISC-153 defect exactly.",
    argv: ["grep", "-nF", "verdict = reconciled.verdictCeiling;", "src/harvest/index.ts"],
    expect: 1,
  },
  {
    isc: "ISC-333",
    grade: "[x]",
    claim:
      "The credential sweep HAS A NEEDLE SUPPLIER, and it is wired into the harvest. This " +
      "line replaced an ABSENCE claim: while ISC-333 was `[~]` it asserted `secrets: " +
      "opts.secrets` appeared exactly once in `src/` and that no supplier sat beside it, " +
      "and the guard going red on this branch is precisely what reported that the wiring " +
      "had arrived. Flipped to `nonempty` with the direction reversed for the same reason " +
      "ISC-332's did: what can go wrong now is the supplier being SILENTLY DISCONNECTED — " +
      "someone restoring the `[]` default, or deleting the resolve — and no checkbox " +
      "anywhere would notice, because every direct test of `findCredentialLeaks` hands the " +
      "function its own needles and stays green through exactly that regression. Pinned on " +
      "the CALL that hands the resolved values to the reconciler rather than on a count of " +
      "mentions, so an editor tidying the prose around it cannot turn this claim red. " +
      "Mutating it to `secrets: []` is one of the five proofs recorded in the entry.",
    argv: ["grep", "-nF", "secrets: supply.needles", "src/harvest/index.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-333",
    grade: "[x]",
    claim:
      "The harvester holds the granted VALUES, and `reconcile.ts` still imports no " +
      "filesystem API — the half of ISC-333 that is a promise about what did NOT change. " +
      "The needles arrive as an argument from `harvestTask`, which already holds the run " +
      "directory, so the module that reads artifact bytes keeps reading them solely " +
      "through descriptors the scan is holding. That structural absence is ISC-246's " +
      "anti-exfiltration guarantee, and supplying the sweep would have been the obvious " +
      "place to trade it away for a one-line convenience. Empty is the required answer: " +
      "any `node:fs`, `Bun.file` or bare `open(` in that file means a credential sweep " +
      "bought its needles with the guarantee the module exists to make checkable.",
    argv: ["grep", "-nE", "node:fs|Bun\\.file|[^a-zA-Z]open\\(", "src/harvest/reconcile.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-330",
    grade: "[x]",
    claim:
      "The shipped example's ticketing worker is asserted against the ENV PLAN it would " +
      "actually be launched with, not against a synthetic document. This claim replaced a " +
      "tripwire: while the reader was on an unmerged branch the probe asserted `egress_access` " +
      "was ABSENT from the schema, and the guard going red on the rebase is precisely what " +
      "reported that the blockage had lifted. Empty here means the example's ticketing worker " +
      "stopped being probed against `fleet.example.yaml` itself, which is the only thing that " +
      "can answer whether an operator's copy receives the token and no Google credential.",
    argv: ["grep", "-n", "the shipped example's ticketing worker (ISC-330)", "test/unit/worker-secrets.test.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-320",
    grade: "[x]",
    claim:
      "The `ticket-ops` bundle POINTS AT its renderer: the skill tells the worker to pipe a " +
      "block list through `render-blocks.mjs`, which is the structural control behind " +
      "'the model does not author markup'. Empty means the prose and the script have been " +
      "split apart, leaving a role instructed to use a renderer it is never told how to reach " +
      "— which degrades silently to hand-written HTML rather than failing.",
    argv: ["grep", "-rn", "render-blocks.mjs", "skills/ticket-ops/"],
    expect: "nonempty",
  },
  {
    isc: "ISC-328",
    grade: "[x]",
    claim:
      "The shipped example's role briefings are checked against the DISK, not just parsed as " +
      "strings. Empty means the guard was removed and a role whose " +
      "`append_system_prompt_file` was never committed goes back to parsing clean and failing " +
      "at `up`, on the operator's machine.",
    argv: ["grep", "-rn", "append_system_prompt_file", "test/unit/role-briefings.test.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-334",
    grade: "[x]",
    claim:
      "The scrub happens at `logEvent`, the single funnel every `events.jsonl` append passes " +
      "through. Empty means the transform was dropped from the append and the supervisor is " +
      "writing worker tool output to disk unscrubbed again — the exact 2026-08-28 state, with " +
      "a correct `security/redact.ts` still sitting beside it passing its own unit suite.",
    argv: ["grep", "-n", "transform: (line) => redactor.redact(line)", "src/supervisor/index.ts"],
    expect: 1,
  },
  {
    isc: "ISC-334",
    grade: "[x]",
    claim:
      "The granted NAMES ride the same 0600 env file as the values, so the two cannot drift. " +
      "Empty means `buildWorkerEnv` stopped declaring them and every supervisor arms against " +
      "an empty list while still reporting itself armed.",
    argv: ["grep", "-rn", "SECRET_NAMES_VAR", "src/run/worker-env.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-335",
    grade: "[x]",
    claim:
      "Every JSONL file this repo creates is born 0600, set on `open(2)` rather than chmod-ed " +
      "after. Empty means the mode came off the append and `events.jsonl` is world-readable " +
      "from its first byte again.",
    argv: ["grep", "-rn", "JSONL_FILE_MODE", "src/util/jsonl.ts"],
    expect: "nonempty",
  },
  {
    isc: "ISC-335",
    grade: "[x]",
    claim:
      "`<run>/sessions` is CREATED 0700 and widened deliberately, rather than created at the " +
      "umask default and corrected. Empty means the mode came off the `mkdir` and the window " +
      "between creation and the widen is back.",
    argv: ["grep", "-rn", "run.sessionsDir, { recursive: true, mode: 0o700 }", "src/"],
    expect: 1,
  },
  {
    isc: "ISC-336",
    grade: "[x]",
    claim:
      "The wiring probe does NOT import the module it proves is wired. NONEMPTY means someone " +
      "repaired a red build by calling the scrubber directly, which turns the one test that " +
      "can detect an unwired scrubber into another test of a module nothing calls.",
    argv: ["grep", "-rn", "security/redact", "test/integration/secret-redaction-wiring.test.ts"],
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

/**
 * A comment-masked mirror of the tracked tree, built once per process.
 *
 * ## Why the claims no longer search the real files (ISC-302)
 *
 * A claim is a `grep`, and a `grep` cannot tell code from prose. Both failure
 * directions were measured here within two days:
 *
 *   - ISC-300 went VACUOUSLY GREEN. Its pinned decision moved to a new call
 *     site and the old spelling survived in a comment explaining the move, so
 *     the claim passed against a sentence while the code it defended was gone.
 *   - ISC-246 went FALSELY RED. Three lines of new docstring named the field it
 *     greps for, so it reported a production consumer that did not exist.
 *
 * Every `.ts` file is mirrored with its comment bytes replaced by spaces, so a
 * claim searches code only. Lengths and newlines are preserved, which keeps
 * every reported line number pointing at the right line of the REAL file — the
 * number a reader is going to act on.
 *
 * ## What is mirrored verbatim, and why the limit is stated rather than hidden
 *
 * Everything that is not `.ts`: `ci.yml`, `docker/entrypoint.sh`, JSON
 * fixtures. Masking those means a second comment syntax — `#`, which is also an
 * ordinary character inside shell strings and YAML values — and no claim's
 * correctness currently rests on it. The one claim that greps `ci.yml` already
 * pins an ASSIGNMENT rather than a mention, precisely because it could not rely
 * on this.
 */
let maskedTree: Promise<string> | null = null;

/**
 * The repo-relative paths the masked mirror is built from.
 *
 * Exported for one reason: the flags below are the whole content of ISC-303,
 * and a fix that lives inside a memoised private function cannot be re-checked
 * by anything. The mirror is built once per process, so a probe that creates an
 * untracked file after the first claim has run would be testing the cache
 * rather than the listing.
 */
export async function listMirroredFiles(): Promise<string[]> {
  const ls = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    stdout: "pipe",
  });
  const [listing] = await Promise.all([new Response(ls.stdout).text(), ls.exited]);
  return listing.split("\n").filter((l) => l.trim() !== "");
}

function buildMaskedTree(): Promise<string> {
  return (async () => {
    const { mkdtemp, mkdir, writeFile, copyFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { maskComments } = await import("./mask-comments.ts");
    const root = await mkdtemp(join(tmpdir(), "pifleet-isa-masked-"));
    /*
     * `--others --exclude-standard` as well as the index, and the reason is a
     * near-miss rather than a tidiness preference.
     *
     * A plain `git ls-files` lists TRACKED files only. Every absence-claim —
     * the ones that assert a spelling appears nowhere in `src/` — is therefore
     * vacuously green for exactly as long as the code that would falsify it
     * sits untracked. Measured: `src/harvest/reconcile.ts` was written, wired
     * into `harvestTask` and passing its own tests while ISC-246's claim went
     * on reporting that no production consumer existed. It went red on `git
     * add`, not on the code arriving.
     *
     * That is the worst possible window for the guard to be blind in, because
     * it is precisely the window in which someone is deciding whether the work
     * is done.
     *
     * This changes nothing in CI, and that is the point rather than a caveat: a
     * clean checkout has no untracked files, so the listing is byte-identical
     * there (measured: 353 paths either way). The fix buys back only the local
     * signal, which is the only place it was ever lost.
     *
     * `--exclude-standard` keeps `.gitignore` authoritative, so build output
     * and `node_modules` stay out of the mirror.
     */
    for (const rel of await listMirroredFiles()) {
      const dest = join(root, rel);
      await mkdir(dirname(dest), { recursive: true });
      if (rel.endsWith(".ts")) {
        await writeFile(dest, maskComments(await Bun.file(rel).text()));
      } else {
        await copyFile(rel, dest).catch(() => {});
      }
    }
    return root;
  })();
}

/**
 * Argument prefixes treated as PATHS to rewrite into the masked mirror.
 *
 * An allowlist rather than a filesystem check, because a claim's search STRING
 * can itself look like a path — `grep -rn "src/" …` is a legitimate pattern —
 * and rewriting that would change what is searched FOR rather than where. A new
 * top-level directory therefore needs a deliberate edit here instead of
 * silently starting or stopping to be masked.
 */
const TRACKED_PREFIXES = ["src/", "test/", "docker/", ".github/", "Docs/", "docs/"] as const;

/** What one claim's command actually returns now. */
export async function runIsaClaim(c: IsaClaim): Promise<string[]> {
  maskedTree ??= buildMaskedTree();
  const root = await maskedTree;
  const argv = c.argv.map((a) =>
    TRACKED_PREFIXES.some((prefix) => a.startsWith(prefix)) ? `${root}/${a}` : a,
  );
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const drop = [...SELF, ...(c.exclude ?? [])];
  return out
    .split("\n")
    .map((l) => (l.startsWith(`${root}/`) ? l.slice(root.length + 1) : l))
    .filter((l) => l.trim() !== "")
    .filter((l) => !drop.some((prefix) => l.startsWith(prefix)));
}
