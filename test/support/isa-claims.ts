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

/**
 * RETIRED CRITERIA KEEP THEIR CLAIMS, and the choice is the load-bearing half
 * of ISC-368 rather than an implementation detail.
 *
 * A retired criterion (`[-]`) is one whose PREMISE was superseded. Its premise
 * is not its code. ISC-307 was written when a granted secret's value reached a
 * 0600 env file; secrets are delivered as files now, so the sentence describes
 * a design that no longer exists — but the claim it carried, that the stderr
 * grant line interpolates the NAMES field and never the values map, is a live
 * property of the shipped tree and the only thing standing between an
 * operator-facing log and a credential inside it. ISC-360 is the same shape
 * twice: the empty policy write and the absence of `PIFLEET_TASK_ID` from
 * `src/` are both still true, and after the descope the second one is a
 * REGRESSION GUARD against the withdrawn mechanism coming back by the carrier
 * that was rejected.
 *
 * DELETING THOSE CLAIMS WITH THE GRADE WOULD MAKE RETIREMENT A WAY TO DROP
 * GUARDS, which is exactly the abuse ISC-368 exists to refuse. So the grade
 * union admits `[-]`, the claims stay in the registry, and the "still at the
 * grade recorded" check in `test/unit/isa-claims.test.ts` keeps working in
 * both directions: un-retiring a criterion without revisiting its claims goes
 * red, and so does retiring one without revisiting them.
 *
 * The cost is stated so it is not discovered later: a `[-]` line in this file
 * means "this command still passes, and the criterion it was filed under is no
 * longer counted". It is NOT a claim that the retired criterion's sentence is
 * true — nothing here re-checks that, and nothing should.
 */

/** One claim in `ISA.md` that a command can re-check. */
export interface IsaClaim {
  /** The criterion whose grade rests on this, e.g. `"ISC-115"`. */
  isc: string;
  /** That criterion's grade at the time this line was written. `[-]` = retired. */
  grade: "[x]" | "[~]" | "[ ]" | "[-]";
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
    grade: "[x]",
    claim:
      "The worker directory holding the store is TIGHTENED to 0700, which is what makes the " +
      "0444 file mode safe on the host rather than a regression against the 0600 env file it " +
      "replaced. Pinned because it is the load-bearing half of a two-part trade and the half " +
      "with no visible symptom if it disappears: removing it leaves every probe in the suite " +
      "green except the one that reads the mode back, and leaves a world-readable credential " +
      "under a world-traversable run directory. The mode DEVIATES from the commissioned 0400, " +
      "and the owner accepted that deviation on 2026-08-30 — see the entry for why 0400 is " +
      "unreadable to the worker uid on Linux and invisibly fine on macOS, and for what the " +
      "trade costs. The `[x]` rests on this line: the file itself is world-readable, so THIS " +
      "chmod is the containment, not the mode.",
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
    // Pins the CALL, which moved to the shared resolver under ISC-345 after
    // the same defect turned up in a second reader. The criterion is unchanged
    // — the sweep still reads the store — only the function that answers
    // "where do values live" is now shared instead of local.
    argv: [
      "grep",
      "-nF",
      "resolveGrantedSecretValues(wp.secretsDir, wp.envFile, granted)",
      "src/harvest/needles.ts",
    ],
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
      "The mounted skill states that requests are BOUNDED and names where the bound comes " +
      "from, so a worker does not re-add one or assume there is none. Empty means the " +
      "guarantee was dropped from the bundle a worker actually receives. " +
      "SUPERSEDED 2026-09-01, and the supersession is the interesting part. This claim used " +
      "to count `--max-time` in the skill's canonical `curl` examples — it went 1 -> 2 -> 3 as " +
      "sections were added — and it recorded its own weakness at the time: the number was a " +
      "floor on the good shape and NOT a ceiling on the bad one, so an unbounded example " +
      "beside the others would have left it green. The image now carries `rally-cli`, there " +
      "are no `curl` examples left to count, and the bound moved INTO the tool: httpx " +
      "`DEFAULT_TIMEOUT = 30.0` with tenacity `stop_after_attempt(3)` and backoff capped at " +
      "10s (read in the pinned commit on 2026-09-01), so the worst case per command is about " +
      "100 seconds and always terminates. That is strictly stronger than a flag a worker had " +
      "to remember. Still `[~]`, and for a SHARPER reason than before: this pins the " +
      "SENTENCE, and the mechanism it describes lives in a third-party repository this tree " +
      "cannot re-read. A bump of TICKET_CLI_COMMIT that removed the timeout would leave this " +
      "green.",
    argv: ["grep", "-nF", "Every request is already bounded", "skills/ticket-ops/SKILL.md"],
    expect: 1,
  },
  {
    isc: "ISC-369",
    grade: "[x]",
    claim:
      "The relay's listen-alias set is DERIVED from `llm.base_url`, in one function, and that " +
      "derivation is what `NO_PROXY` is built from too. Empty on either line means the two " +
      "went back to independent lists — which is the exact defect the first live bring-up " +
      "against the tunnel hit: `up` reported success while the ticketing worker, the one role " +
      "with `egress_access: true`, got `CONNECT tunnel failed, response 403` on every " +
      "inference call because its model host was not in a hardcoded NO_PROXY.",
    argv: [
      "grep",
      "-rn",
      "relayListenAliases",
      "src/security/relay.ts",
      "src/run/worker-env.ts",
    ],
    // FIVE since D7 (2026-09-01), and the number is a measurement rather than a
    // guess: the registry greps a COMMENT-MASKED mirror, so the prose mentions
    // of this name do not count. What remains is the exported definition, the
    // call in `ensureEgressRelay`, the call in `egressBridgePlan` that gives
    // each provider's relay its own alias set, the import into worker-env and
    // its use there.
    //
    // A count rather than a mere presence check, because dropping the
    // worker-env side is precisely the failure that shipped green — and the
    // count had to MOVE for that to keep being true. Left at 4, deleting the
    // worker-env use leaves exactly four occurrences behind, since the import
    // survives it unused, and this guard would go green on the one defect it
    // was written for. Verified by mutation on 2026-09-01 rather than reasoned:
    // at 5 that deletion is red.
    expect: 5,
  },
  {
    isc: "ISC-369",
    grade: "[x]",
    claim:
      "The relay container is launched with the unprivileged-port sysctl, so a published " +
      "`https://` endpoint's listen port of 443 can be bound by a process running `--user " +
      "node --cap-drop ALL`. Empty means the flag was dropped and such a fleet gets a " +
      "container that `docker run -d`s cleanly and dies on EACCES milliseconds later, " +
      "reported as \"exited immediately after start\" — a message that blames the port for a " +
      "permissions problem. A SYSCTL and not `--cap-add NET_BIND_SERVICE`: the cap set stays " +
      "empty and only this netns's floor moves.",
    argv: ["grep", "-nF", "net.ipv4.ip_unprivileged_port_start=0", "src/security/relay.ts"],
    expect: 1,
  },
  {
    isc: "ISC-345",
    grade: "[x]",
    claim:
      "There is exactly ONE module that answers where a granted secret's value lives, and both " +
      "consumers call it. Empty means someone re-implemented the lookup locally — which is the " +
      "condition that produced the leak: two independently-written readers, each with its own " +
      "env-file parser, one of them fixed when delivery moved and the other forgotten until a " +
      "live credential reached an event log.",
    argv: ["grep", "-rln", "resolveGrantedSecretValues", "src/"],
    expect: 3,
  },
  {
    isc: "ISC-345",
    grade: "[x]",
    claim:
      "The redactor takes the secret store as a REQUIRED parameter, so a future delivery move " +
      "is a compile error at every call site rather than a silent no-op. Empty means the " +
      "parameter went away or became optional, which restores the exact failure mode: existing " +
      "callers keep compiling while reading a file that no longer holds the values.",
    argv: ["grep", "-nF", "secretsDir: string,", "src/security/redact.ts"],
    expect: 1,
  },
  {
    isc: "ISC-345",
    grade: "[x]",
    claim:
      "A granted name the redactor cannot value is REPORTED rather than skipped. Empty means " +
      "the `continue` is back: the run says protect this, the redactor cannot, and nothing " +
      "anywhere says so. That silence is why the leak survived review and CI both.",
    argv: ["grep", "-nF", "readonly unresolved: readonly string[];", "src/security/redact.ts"],
    expect: 1,
  },
  {
    isc: "ISC-349",
    grade: "[~]",
    claim:
      "The mounted worker skill names the ONE place a task id is readable — the prompt's `#` " +
      "heading, which `dispatch.ts` defaults to the task id. Empty here means the binding was " +
      "dropped and `<task-id>` is an unbindable placeholder again, which is the state that " +
      "produced `/outbox/list-tickets-2026-08-29/` for a task dispatched as `my-iteration-2`. " +
      "`[~]` and not `[x]`: this proves the sentence is SHIPPED. Nothing here observes a " +
      "worker resolving its id, and nothing can, because the value is still not sent to it.",
    argv: [
      "grep",
      "-nF",
      "defaults to its id, so unless an operator wrote a separate human title",
      "skills/pifleet-worker/SKILL.md",
    ],
    expect: 1,
  },
  {
    isc: "ISC-349",
    grade: "[~]",
    claim:
      "The skill states the COST of a guessed outbox directory in mechanism terms, not as a " +
      "bare imperative: `harvest/outbox.ts` scans `join(workerOutboxDir, taskId)` and only " +
      "that, so a wrongly-named directory's CONTENT is invisible rather than merely untidy. " +
      "Empty here means the rule went back to an instruction with no stated consequence — the " +
      "form it was in when a worker disregarded it.\n\n" +
      "PINNED STRING CHANGED 2026-08-30, and the reason is the failure this registry exists " +
      "for. It used to be `not scanned, not reported, and not swept`, and the middle word went " +
      "FALSE when ISC-346..348 built `harvest/layout.ts`'s `unexplainedOutboxDirs`: a guessed " +
      "directory IS reported now, by name, as holding nothing that was checked. The skill was " +
      "telling a worker the harvest is blind to something it had learned to see, and this " +
      "claim was green over that sentence for as long as the wording held.",
    argv: [
      "grep",
      "-nF",
      "not scanned, not validated, and not swept for credentials",
      "skills/pifleet-worker/SKILL.md",
    ],
    expect: 1,
  },
  {
    isc: "ISC-349",
    grade: "[~]",
    claim:
      "`result.json` is stated as the LAST action with the cost of omitting it — a missing " +
      "envelope does not fail a task, it removes the worker from the grading (ISC-94), which " +
      "for work driven through a remote API leaves no diff to grade in its place. Empty here " +
      "means the requirement went back to being one bullet in the middle of the document.",
    argv: ["grep", "-nF", "it removes you from the grading", "skills/pifleet-worker/SKILL.md"],
    expect: 1,
  },
  {
    isc: "ISC-350",
    grade: "[~]",
    claim:
      "The mounted skill states that the harvester selects on the FILENAME `ticket-ops.json` " +
      "and on nothing else — the fact that makes writing only the `.md` skip both schema " +
      "validation and the credential sweep while reporting clean. Empty here means the pair " +
      "rule went back to 'the same content, once for a machine and once for a person', which " +
      "reads as redundancy and is what a worker dropped.",
    argv: [
      "grep",
      "-nF",
      "The harvester selects on the filename",
      "skills/ticket-ops/SKILL.md",
    ],
    expect: 1,
  },
  {
    isc: "ISC-350",
    grade: "[~]",
    claim:
      "The ticketing ROLE no longer tells the worker its artifact is written for the human " +
      "operator and not for the orchestrator. This claim is an ABSENCE and points at the role " +
      "rather than the skill on purpose: the standing prompt outranks a reference skill at the " +
      "moment of deciding what to write, so that one sentence overruled the skill's pair rule " +
      "and a worker produced a single `.md` exactly as its role described. Nonempty here means " +
      "the sentence is back, and the pair rule is overruled again.",
    argv: [
      "grep",
      "-nF",
      "for the human operator, not for the orchestrator",
      "roles/ticketing.md",
    ],
    expect: "empty",
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
    grade: "[-]",
    claim:
      "The stderr grant line interpolates the NAMES field and not the values map. This is " +
      "the grep the grade rested on: nothing reads that line back, so it is the only " +
      "thing standing between an operator-facing log and a secret inside it. " +
      "**THE CRITERION IS RETIRED (2026-08-30, ISC-368) AND THIS CLAIM IS NOT.** What was " +
      "retired is ISC-307's premise — a value reaching a 0600 env file, a design ISC-337 " +
      "replaced with file delivery. This grep is about the stderr surface, which still " +
      "exists, still names variables, and still has nothing reading it back. Deleting it " +
      "with the grade would turn retirement into a way to drop a guard, which is the abuse " +
      "ISC-368 refuses by name.",
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
    isc: "ISC-306",
    grade: "[x]",
    claim:
      "The refusal is scoped to the INTERSECTION rather than to the whole allowlist, and the " +
      "narrowing is pinned as an ASSERTION and not a comment. Registered on 2026-08-30, when " +
      "the owner CHOSE that scope over the wider reading the commission asked for, because the " +
      "choice makes this one probe the only thing defending it. Widening the source back to " +
      "the declined reading reddens this probe and no other probe in the ISC-306 block, which " +
      "is the discrimination it exists for; DELETING the probe reddens nothing at all, and the " +
      "chosen scope would then be undefended with no symptom anywhere. Pinned as a count for " +
      "that second case, which no checkbox would notice.",
    argv: [
      "grep",
      "-nF",
      'test("an allowlisted name NOBODY requested may be absent without refusing"',
      "test/unit/worker-secrets.test.ts",
    ],
    expect: 1,
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
  {
    isc: "ISC-346",
    grade: "[x]",
    claim:
      "The layout check is WIRED into the harvest, at the one call site that reaches every " +
      "consumer. Pinned on the CALL rather than on a count of mentions, because `layout.ts` " +
      "names its own exports and an editor tidying prose must not be able to turn this red. " +
      "Empty means the detector became a module nothing runs — which is the ISC-332 and " +
      "ISC-333 defect exactly, and no checkbox anywhere would notice, because every direct " +
      "test of the listing would keep passing over a function no harvest calls.",
    argv: [
      "grep",
      "-nF",
      "discrepancies.push(...(await unexplainedOutboxDirs(run, envelope.worker)));",
      "src/harvest/index.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-346",
    grade: "[x]",
    claim:
      "The verbgate ledger's exemption is DERIVED from the path `run/paths.ts` owns, not " +
      "spelled a second time. NONEMPTY here means someone hard-coded the directory name, " +
      "after which a ledger that moved would leave the harvest reporting every worker that " +
      "ran a gated verb as having written a stray directory — a finding that fires on correct " +
      "behaviour, which this repo treats as worse than no finding. Comments are masked before " +
      "this runs, so the prose that explains the rule cannot satisfy or falsify it.",
    argv: ["grep", "-nE", "\"ledger\"|'ledger'", "src/harvest/layout.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-346",
    grade: "[x]",
    claim:
      "The layout check reads NAMES and never content: no `open`, no `realpath`, no " +
      "`Bun.file`. The same structural argument ISC-333 pins on `reconcile.ts`, for a module " +
      "whose whole subject is worker-authored directories. NONEMPTY means something started " +
      "dereferencing a path the WORKER chose, which is the §12.5 primitive this module was " +
      "written the long way round to avoid.",
    argv: ["grep", "-nE", "[^a-zA-Z]open\\(|realpath|Bun\\.file", "src/harvest/layout.ts"],
    expect: "empty",
  },
  {
    isc: "ISC-347",
    grade: "[x]",
    claim:
      "A dispatched task with no envelope reaches `discrepancies`, the channel §8.4 publishes " +
      "for contract violations — not only `reasons`, where it always was and where it read " +
      "like the procedural note it sat among. Pinned on the finding's own words. Empty means " +
      "the statement was removed or moved back, and moving it back is precisely the defect: " +
      "the harvest still says it, in the channel nobody scans for problems.",
    argv: ["grep", "-nF", "has no result envelope at", "src/harvest/index.ts"],
    expect: 1,
  },
  {
    isc: "ISC-348",
    grade: "[x]",
    claim:
      "The document name that must accompany the validated artifact is DERIVED from it, so " +
      "the pair cannot drift: renaming one renames the other in the same edit. Empty means " +
      "someone wrote `\"ticket-ops.md\"` as a second literal, after which a rename of the " +
      "JSON leaves the pairing check looking for a file no skill tells a worker to write.",
    argv: [
      "grep",
      "-nF",
      "export const TICKET_OPS_DOCUMENT_NAME = `${basename(TICKET_OPS_ARTIFACT_NAME, \".json\")}.md`;",
      "src/harvest/reconcile.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-348",
    grade: "[x]",
    claim:
      "The finding states what DID NOT RUN, in those words. The whole criterion is that " +
      "'nothing was reported' becomes 'nothing was checked, and here is why' — a finding that " +
      "said only 'no ticket-ops.json' would be a filing complaint an operator can shrug at, " +
      "and the credential sweep having been skipped is the part that matters. Empty means the " +
      "wording was softened, which costs the criterion its entire point while leaving a " +
      "discrepancy in place to look like coverage.",
    argv: ["grep", "-nF", "credential sweep DID NOT RUN on it", "src/harvest/reconcile.ts"],
    expect: 1,
  },
  {
    isc: "ISC-356",
    grade: "[x]",
    claim:
      "SRD §12.4 records that a granted secret is delivered as a FILE reached through " +
      "`<NAME>_FILE`, not as a value in the environment. Empty means the erratum was reverted " +
      "and the document is back to describing only env delivery — under which a reader " +
      "concludes `echo $NAME` prints a credential, when it has printed an empty line since " +
      "ISC-337..342 landed on 2026-08-29.",
    argv: ["grep", "-nF", "<NAME>_FILE=/secrets/<NAME>", "Docs/SRD.md"],
    expect: 1,
  },
  {
    isc: "ISC-356",
    grade: "[x]",
    claim:
      "SRD §12.4 states the limit rather than overclaiming the boundary: a worker can still " +
      "read its own credential file deliberately, and what file delivery removes is the " +
      "ACCIDENT surface. Empty means the honest half was dropped and the section now reads as " +
      "though the value were unreachable, which ISC-341 exists to deny.",
    argv: ["grep", "-nF", "This narrows the accident, not the", "Docs/SRD.md"],
    expect: 1,
  },
  {
    isc: "ISC-356",
    grade: "[x]",
    claim:
      "SRD §8.2a records that a diff touching the test-harness surface caps the verdict at " +
      "`unknown`. Empty means the section went away and §8 is back to describing the " +
      "harvester's re-run of acceptance as authoritative with no mention that a worker who " +
      "edited the suite cannot be certified by it — the state in which the cap shaped every " +
      "verdict this tool ever issued while appearing in no version of the design.",
    argv: ["grep", "-nF", "8.2a The test-harness cap", "Docs/SRD.md"],
    expect: 1,
  },
  {
    isc: "ISC-356",
    grade: "[x]",
    claim:
      "§8.2a records that NEGATIVE evidence survives the cap — the cap refuses to grade, it " +
      "does not fail. Empty means the asymmetry was lost, and a reader would expect a worker's " +
      "own harness to be unable to indict the worker, which is backwards: trusting it only " +
      "ever downgrades.",
    argv: ["grep", "-nF", "Negative evidence (`failed`, `blocked`) **survives**", "Docs/SRD.md"],
    expect: 1,
  },
  {
    isc: "ISC-356",
    grade: "[x]",
    claim:
      "An ABSENCE claim on the stale rule `fleet.example.yaml` carried until 2026-08-30: " +
      "`patterns` described as REPLACING the defaults, true when written and false since " +
      "ISC-243 on 2026-08-25. Non-empty means the sentence came back, and with it the one " +
      "document that covered `harness:` telling operators the opposite of the shipped default " +
      "— in the direction that silently weakens the cap.",
    argv: ["grep", "-nF", "REPLACES the defaults, it does not extend them", "fleet.example.yaml"],
    expect: 0,
  },
  {
    isc: "ISC-360",
    grade: "[-]",
    claim:
      "**ISC-360 IS RETIRED (2026-08-30, ISC-368); THIS CLAIM STILL RUNS.** ISC-366 descoped " +
      "the mechanism, so the criterion's subject — an erratum recording it as designed-but-" +
      "not-built — describes a state the SRD no longer holds. The empty write is still the " +
      "shipped behaviour and is still the only write of the file, so the guard is kept. " +
      "The verbgate's policy file is written EMPTY, once per worker at `up`, and this is the " +
      "only write of it in the tree. SRD §5.10 and §17's criterion 59 now say so; if this line " +
      "goes away — because someone wired the dispatch-time rewriter `run/materialize.ts` " +
      "addresses in its own comment — both errata become false and the acceptance criterion " +
      "becomes meetable again. Pinned on the whole expression including the empty-string " +
      "argument, so writing a POPULATED policy at the same call site reddens it too.",
    argv: ["grep", "-nF", 'await writeFile(paths.cloudAllow, "");', "src/run/materialize.ts"],
    expect: 1,
  },
  {
    isc: "ISC-360",
    grade: "[-]",
    claim:
      "**ISC-360 IS RETIRED (2026-08-30, ISC-368); THIS CLAIM IS THE REASON RETIREMENT DOES " +
      "NOT DELETE CLAIMS.** After ISC-366 withdrew task-scoped cloud authorization, this is " +
      "the guard that goes red if the withdrawn mechanism comes back through the carrier " +
      "ISC-362 rejected. The criterion it was filed under is no longer counted; the property " +
      "it pins is more load-bearing now than when it was written. " +
      "`PIFLEET_TASK_ID` is set NOWHERE in `src/`, and after ISC-362 that is a REGRESSION GUARD " +
      "rather than a report of the defect. **THIS CLAIM\'S ORIGINAL REASONING WAS WRONG AND IS " +
      "KEPT HERE AS THE RECORD.** It read: \'any real implementation of task-scoped authorization " +
      "must set this variable, so binding it is exactly the change that must retire §5.10\'s " +
      "erratum, and this goes red on that commit.\' ISC-362 fixed the provenance half WITHOUT " +
      "setting it — environment is the wrong carrier twice over (a container outlives an epoch, " +
      "and the worker can rewrite its own environment) — so the claim stayed GREEN across the " +
      "commit it predicted would redden it. A guard pinned to a PROXY passes over the property " +
      "it was standing in for. What it now asserts is the narrow thing it can: the env carrier " +
      "has not been reintroduced. The provenance property itself is pinned by ISC-362\'s claims.",
    argv: ["grep", "-rnF", "PIFLEET_TASK_ID", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-362",
    grade: "[x]",
    claim:
      "The verbgate takes its ledger provenance from the mounted policy FILE, not from the " +
      "environment the worker controls. Pinned on the shell expansion rather than the variable " +
      "name, because the header still names both variables to explain why they went away.",
    argv: ["grep", "-nF", 'task_file="/policy/task"', "docker/verbgate"],
    expect: 1,
  },
  {
    isc: "ISC-366",
    grade: "[x]",
    claim:
      "`cloud_allow[]` is refused rather than accepted-and-ignored, on BOTH doors — the task spec " +
      "an operator writes and the envelope the supervisor parses off the control socket. Pinned on " +
      "the shared refusal helper with an expected count of 2, so restoring a plain array on either " +
      "schema goes red. A descope that leaves the field accepted is a trap with a plausible name.",
    argv: ["grep", "-nF", "cloud_allow: cloudAllowDescoped(", "src/contracts.ts"],
    expect: 2,
  },
  {
    isc: "ISC-365",
    grade: "[x]",
    claim:
      "F11's pre-emptive `compact` is NOT BUILT, and §13's table says so. A TRIPWIRE, not a report: " +
      "the claim is pinned to the ABSENCE, so the commit that builds it goes red and the row " +
      "cannot keep saying NOT BUILT after it stops being true. A mitigation named in the " +
      "present tense that does not exist is worse than a blank cell, because it stops the " +
      "reader looking further — and §13 is read mid-incident.",
    argv: ["grep", "-rF", "\"compact\"", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-365",
    grade: "[x]",
    claim:
      "F13's retry backoff is NOT BUILT, and §13's table says so. A TRIPWIRE, not a report: " +
      "the claim is pinned to the ABSENCE, so the commit that builds it goes red and the row " +
      "cannot keep saying NOT BUILT after it stops being true. A mitigation named in the " +
      "present tense that does not exist is worse than a blank cell, because it stops the " +
      "reader looking further — and §13 is read mid-incident.",
    argv: ["grep", "-rF", "backoff", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-365",
    grade: "[x]",
    claim:
      "F19's interrogative detection, which needs the assistant's last text is NOT BUILT, and §13's table says so. A TRIPWIRE, not a report: " +
      "the claim is pinned to the ABSENCE, so the commit that builds it goes red and the row " +
      "cannot keep saying NOT BUILT after it stops being true. A mitigation named in the " +
      "present tense that does not exist is worse than a blank cell, because it stops the " +
      "reader looking further — and §13 is read mid-incident.",
    argv: ["grep", "-rF", "get_last_assistant_text", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-365",
    grade: "[x]",
    claim:
      "F35's `skipped:dependency_failed` is NOT BUILT, and §13's table says so. A TRIPWIRE, not a report: " +
      "the claim is pinned to the ABSENCE, so the commit that builds it goes red and the row " +
      "cannot keep saying NOT BUILT after it stops being true. A mitigation named in the " +
      "present tense that does not exist is worse than a blank cell, because it stops the " +
      "reader looking further — and §13 is read mid-incident.",
    argv: ["grep", "-rF", "dependency_failed", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-365",
    grade: "[x]",
    claim:
      "F36's auth-failure detection is NOT BUILT, and §13's table says so. A TRIPWIRE, not a report: " +
      "the claim is pinned to the ABSENCE, so the commit that builds it goes red and the row " +
      "cannot keep saying NOT BUILT after it stops being true. A mitigation named in the " +
      "present tense that does not exist is worse than a blank cell, because it stops the " +
      "reader looking further — and §13 is read mid-incident.",
    argv: ["grep", "-rF", "invalid_grant", "src/"],
    expect: "empty",
  },
  {
    isc: "ISC-364",
    grade: "[x]",
    claim:
      "The worker skill's status instruction is a single sentence the probe cuts at the first " +
      "full stop. Pinned on that sentence because the clause AFTER it names two statuses the " +
      "worker must NOT write — a probe reading the whole line inverts the document's meaning.",
    argv: ["grep", "-nF", "`status` is exactly one of", "skills/pifleet-worker/SKILL.md"],
    expect: 1,
  },
  {
    isc: "ISC-364",
    grade: "[x]",
    claim:
      "The worker-document path probe admits placeholders. An ABSENCE-shaped claim on the " +
      "character class: without `<` in it every interesting path in these documents — " +
      "`/outbox/<task-id>/result.json` above all — is invisible, which is how the first version " +
      "stayed green while the envelope contract's own path was rewritten to a directory that " +
      "does not exist.",
    argv: ["grep", "-nF", "[a-zA-Z0-9<]", "test/unit/worker-docs-currency.test.ts"],
    expect: 1,
  },
  {
    isc: "ISC-363",
    grade: "[x]",
    claim:
      "The identifier sweep runs over the SRD every CI run. Pinned on the ERRATUM-STRIPPING line " +
      "rather than on the file existing, because the sweep without that line flags every erratum " +
      "that spells a name it is correcting — it would be red on a correct document, and the first " +
      "response to a probe that is red on a correct document is to delete the probe.",
    argv: ["grep", "-nF", 'startsWith(">")', "test/unit/srd-identifier-sweep.test.ts"],
    expect: 1,
  },
  {
    isc: "ISC-363",
    grade: "[x]",
    claim:
      "§4.2 names the real Dockerfile. An ABSENCE claim on the dead path the sweep found: " +
      "`docker/pi-worker.Dockerfile` never existed, and a reader following the design to the " +
      "build looked for a file that is not there.",
    argv: ["grep", "-rnF", "docker/pi-worker.Dockerfile", "Docs/SRD.md"],
    expect: "empty",
  },
  {
    isc: "ISC-362",
    grade: "[x]",
    claim:
      "`render` mounts the provenance file READ-ONLY. The `:ro` is the whole integrity argument " +
      "— a writable provenance file lets a worker attribute its own destructive verbs to another " +
      "task — so the claim pins the mode, not just the path.",
    argv: ["grep", "-nF", "${TASK_POLICY_MOUNT}:ro`", "src/config/render.ts"],
    expect: 1,
  },
  {
    isc: "ISC-361",
    grade: "[x]",
    claim:
      "The bridge gateway is DROPped for traffic from the egress bridge, and the rule is the " +
      "narrow `-i <bridge> -d <gateway>` pair rather than a blanket drop — which is both the " +
      "security property and the blast-radius bound. SRD §12.8's reachable set no longer " +
      "carries the gateway term because of this line; if it is generalised or deleted, the " +
      "residual comes back and three unions in that section become right again.",
    argv: [
      "grep",
      "-nF",
      'return [op, CHAIN, "-i", bridge, "-d", gateway, "-j", TARGET];',
      "src/security/gateway-block.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-361",
    grade: "[x]",
    claim:
      "The block is installed from inside `ensureEgressNetwork`, so it is not a step an " +
      "operator or a caller can skip on the way to a running fleet. Empty means the call site " +
      "moved or went away, and SRD §12.8's erratum — the only place the closure is written " +
      "down — is asserting a containment the network setup no longer establishes.",
    argv: [
      "grep",
      "-nF",
      "await ensureGatewayBlocked(status.id, status.gateway);",
      "src/security/network.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-370",
    grade: "[x]",
    claim:
      "`--mode rpc` is pushed for every worker that is NOT tui — the whole of 'a tui worker's " +
      "pi argv omits --mode entirely', in one line. Pinned on the NEGATED condition rather " +
      "than on a mention of `paneMode`, because the defect this criterion was filed against " +
      "is a field that parses and is read by nothing: before Phase 1 `pane_mode: tui` " +
      "validated and produced an argv identical to `rpc`'s. Inverting this condition, or " +
      "unguarding the push, makes every tui worker an RPC worker again with no other symptom.",
    argv: [
      "grep",
      "-nF",
      'if (w.paneMode !== "tui") argv.push("--mode", "rpc");',
      "src/config/render.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-370",
    grade: "[x]",
    claim:
      "…and the other mark, which must move with it. `-t` is what gives the container the " +
      "pseudo-TTY Pi needs to present a TUI at all. The two lines are also what " +
      "`launchPaneMode` reads back to decide whether a worker can be signalled or attached " +
      "to, so a change to either without the other produces a record whose marks disagree — " +
      "which every consumer then refuses, correctly, and which no operator can act on. " +
      "`tui-interrupt.test.ts`'s 'the ends that must move together' asserts the same pair " +
      "from the other side.",
    argv: [
      "grep",
      "-nF",
      'if (w.paneMode === "tui") argv.push("-t");',
      "src/config/render.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-374",
    grade: "[x]",
    claim:
      "There is EXACTLY ONE detacher in the supervisor. The count is the claim, not the " +
      "presence: a second call site would mean two places deciding the launch shape, and the " +
      "next reader would have to work out which won — the ISC-188 shape `detachedDockerArgv` " +
      "itself throws on. Empty means the tui launch path is gone; more than one means it " +
      "grew a rival.",
    argv: ["grep", "-cF", "detachedDockerArgv(", "src/supervisor/index.ts"],
    expect: 1,
  },
  {
    isc: "ISC-374",
    grade: "[x]",
    claim:
      "The mode reaches the launch record at all. This is the line whose deletion left 82 " +
      "tests green on a fleet that could no longer launch a TUI, because " +
      "`WorkerLaunchSchema` DEFAULTS `pane_mode` to `rpc` and every in-memory fixture went " +
      "on passing. A registered claim is the cheapest guard that notices a line whose " +
      "absence is indistinguishable from a default.",
    argv: ["grep", "-rnF", "pane_mode: w.paneMode", "src/"],
    expect: 1,
  },
  {
    isc: "ISC-382",
    grade: "[x]",
    claim:
      "The voided table stamped into a worker's attended record — which is the list `report` " +
      "prints — is CHOSEN by how `up` launched that worker, at the one site that writes it. " +
      "A presence claim, and the direction matters: if this call site reverts to a constant, " +
      "a `pane_mode: tui` run reports the attended table alone and an operator is never told " +
      "that a re-dispatch would run the task twice.",
    argv: [
      "grep",
      "-nF",
      'voided: [...voidedFor(args.paneMode ?? "rpc")],',
      "src/attended/mode.ts",
    ],
    expect: 1,
  },
  {
    isc: "ISC-382",
    grade: "[x]",
    claim:
      "NO production path stamps the attended table unconditionally. The absence half of the " +
      "claim above, and the one a presence check cannot make: a future edit could add a " +
      "second writer of `attended.json` — `up` is the obvious one, since ISC-382's own " +
      "residual asks for exactly that — and spell it the way this module did before Phase 4. " +
      "That would leave `voidedFor` present, called, and bypassed.",
    argv: ["grep", "-rnF", "voided: [...TUI_VOIDED]", "src/"],
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
