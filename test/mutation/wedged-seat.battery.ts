/**
 * Mutation battery — the wedged seat (`status.ts`'s `classifyWorkerSilence`).
 *
 * Runs entirely inside a throwaway worktree; the live checkout is never written
 * to. Restore-first before every step, checksum verified after every restore,
 * hard timeout on each run.
 *
 * ## What this battery adds to the house pattern
 *
 * Per-mutation NEGATIVE-CONTROL TRACKING, not just a green mutation at the end
 * of the list. Every mutation records whether the control block — the one that
 * exercises `transcriptNote`, which none of these mutations touch — stayed
 * green. A mutation that reddens the whole file proves nothing: it says the
 * suite notices damage, not that the probe under test is aimed at the defect.
 * The claim worth making is that the RIGHT tests failed and the unrelated ones
 * did not, and this reports both halves.
 *
 *   git worktree add --detach /tmp/wt HEAD
 *   ln -s "$PWD/node_modules" /tmp/wt/node_modules
 *   cp src/cli/commands/status.ts /tmp/wt/src/cli/commands/
 *   cp test/unit/status-wedged-seat.test.ts /tmp/wt/test/unit/
 *   bun run test/mutation/wedged-seat.battery.ts /tmp/wt
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE WORKTREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source in place, and the live fleet on this host spawns
 * containers by reading the live working tree. There is no default for the same
 * reason `collator-relay.battery.ts` has none: the destructive path must be
 * typed.
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error("usage: wedged-seat.battery.ts <throwaway-worktree>  (never the live checkout)");
}

const STATUS = `${W}/src/cli/commands/status.ts`;
const TESTFILES = ["test/unit/status-wedged-seat.test.ts", "test/unit/status-transcript-activity.test.ts"];

/** The describe block that must survive EVERY mutation below. */
const CONTROL = "negative control: the pre-existing transcript column is untouched";

/**
 * Taken FROM THE WORKTREE at start-up rather than from a side file, so the
 * battery can never restore a stale version over newer work — the failure mode
 * that silently reverts a fix and then reports every mutation green.
 */
const PRISTINE: Record<string, string> = { [STATUS]: readFileSync(STATUS, "utf8") };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TIMEOUT_MS = 30_000;

interface M {
  id: string;
  what: string;
  /** The assertion this mutation exists to prove is load-bearing. */
  catches: string;
  /**
   * The file this mutation edits, as one of the `${W}` constants above.
   *
   * Every entry here names `STATUS`, so this looks redundant and is not. The
   * shared drift guard in `test/unit/mutation-anchors.test.ts` parses batteries
   * WITHOUT executing them, and the shape it reads is `file: CONST,` followed by
   * `find:`. A battery that carried its target only in a module constant parsed
   * to ZERO anchors — which failed that guard's own vacuity check for every
   * battery in the tree, not just this one, and would otherwise have left these
   * anchors free to rot unwatched. Naming the target per entry is what puts them
   * under the guard.
   *
   * It is also read at RUNTIME below rather than being decoration the parser
   * alone consumes: a field that only a regex believes is a field that drifts
   * from what the runner actually mutates.
   */
  file: string;
  find: string;
  replace: string;
  expect: "red" | "green";
}

const MUTATIONS: M[] = [
  // ── The bands: the honest edge, in both directions. ──────────────────────
  {
    id: "B1",
    what: "the alarm fires at WARN instead of KILL",
    catches: "a reviewer ten minutes into one model call is quiet, NOT wedged",
    file: STATUS,
    find: '  if (silentMs >= input.window.killMs) return { verdict: "wedged", silentMs };',
    replace: '  if (silentMs >= input.window.warnMs) return { verdict: "wedged", silentMs };',
    expect: "red",
  },
  {
    id: "B2",
    what: "the warn band is deleted — everything under kill reads as working",
    catches: "one millisecond under warn is working; warn itself is quiet",
    file: STATUS,
    find: '  if (silentMs >= input.window.warnMs) return { verdict: "quiet", silentMs };',
    replace: '  if (false) return { verdict: "quiet", silentMs };',
    expect: "red",
  },
  {
    id: "B3",
    what: "the boundary is exclusive, so the configured threshold itself never fires",
    catches: "one millisecond under kill is quiet; kill itself is wedged",
    file: STATUS,
    find: "  const silentMs = Math.max(0, beat - grew);\n  if (silentMs >= input.window.killMs)",
    replace: "  const silentMs = Math.max(0, beat - grew);\n  if (silentMs > input.window.killMs)",
    expect: "red",
  },

  // ── The gates: who may be judged at all. ─────────────────────────────────
  {
    id: "G1",
    what: "the busy gate is widened — an idle worker can be called wedged",
    catches: "an idle worker with the same dead transcript is not applicable",
    file: STATUS,
    find: '  if (input.phase !== "busy") return { verdict: "not_applicable" };',
    replace: '  if (input.phase === "dead") return { verdict: "not_applicable" };',
    expect: "red",
  },
  {
    id: "G2",
    what: "the dead-supervisor gate is dropped — 231 dead runs on this host would alarm",
    catches: "supervisor=gone is not_applicable however stale the transcript",
    file: STATUS,
    find: '  if (!input.supervisorAlive) return { verdict: "not_applicable" };',
    replace: "  void input.supervisorAlive;",
    expect: "red",
  },

  // ── The four unknowns, which must stay four. ─────────────────────────────
  {
    id: "U1",
    what: "a transcript that never grew is called wedged (the claim the supervisor forbids)",
    catches: "a watched transcript that has never grown makes no claim either way",
    file: STATUS,
    find:
      '  if (input.activity.last_growth_at === null) return { verdict: "unknown", why: "no_growth_yet" };',
    replace:
      '  if (input.activity.last_growth_at === null) return { verdict: "wedged", silentMs: 0 };',
    expect: "red",
  },
  {
    id: "U2",
    what: "an rpc worker with no activity record is treated as measured-and-healthy",
    catches: "an rpc worker carries no activity record at all",
    file: STATUS,
    find: '  if (input.activity === null) return { verdict: "unknown", why: "no_activity_record" };',
    replace: '  if (input.activity === null) return { verdict: "working", silentMs: 0 };',
    expect: "red",
  },
  {
    id: "U3",
    what: "two unknown reasons collapse onto one string",
    catches: "no two of the four unknowns share a reason string",
    file: STATUS,
    find: '  if (input.window === null) return { verdict: "unknown", why: "no_window" };',
    replace: '  if (input.window === null) return { verdict: "unknown", why: "no_activity_record" };',
    expect: "red",
  },
  {
    id: "U4",
    what: "an unparseable stamp is reported as a quiet worker rather than a corruption",
    catches: "a stamp that will not parse is a corruption, not a quiet worker",
    file: STATUS,
    find: '    return { verdict: "unknown", why: "unreadable_stamp" };',
    replace: '    return { verdict: "quiet", silentMs: 0 };',
    expect: "red",
  },

  // ── The clock: the property that makes the reading portable. ─────────────
  {
    id: "C1",
    what: "the span is measured against the READER's wall clock instead of the supervisor's",
    catches: "the same state read at two different real instants gives one answer",
    file: STATUS,
    find: "  const beat = input.heartbeatAt === null ? Number.NaN : Date.parse(input.heartbeatAt);",
    replace: "  const beat = Date.now();",
    expect: "red",
  },
  {
    id: "C2",
    what: "the clamp is dropped — sub-tick ordering renders as negative silence",
    catches: "growth stamped after the heartbeat clamps to zero rather than going negative",
    file: STATUS,
    find: "  const silentMs = Math.max(0, beat - grew);",
    replace: "  const silentMs = beat - grew;",
    expect: "red",
  },

  // ── What an operator sees. ───────────────────────────────────────────────
  {
    id: "R1",
    what: "the alarm also shouts for `quiet` — the slow reviewer becomes a false alarm",
    catches: "the slow-but-live worker gets NOTHING, which is the false alarm avoided",
    file: STATUS,
    find: '  if (reading.verdict === "wedged") {',
    replace: '  if (reading.verdict === "wedged" || reading.verdict === "quiet") {',
    expect: "red",
  },
  {
    id: "R2",
    what: "the missing-window case goes quiet — no alarm is indistinguishable from healthy",
    catches: "a busy worker with no recorded window says the window is unknown",
    file: STATUS,
    find: '  if (reading.verdict === "unknown" && reading.why === "no_window") {',
    replace: '  if (false) {',
    expect: "red",
  },
  {
    id: "R3",
    what: "the alarm drops the span, so a seat 5m past reads like one dead an hour",
    catches: "the wedged worker gets a loud line naming the silence and the cause",
    file: STATUS,
    find: "      `WEDGED heartbeating but transcript silent ${coarseDuration(reading.silentMs)} ` +",
    replace: "      `WEDGED heartbeating but transcript silent ` +",
    expect: "red",
  },

  // ── Wiring: correctness that never reaches an operator. ──────────────────
  {
    id: "W1",
    what: "the alarm is computed and never printed",
    catches: "the text line appends the note, and appends nothing when there is none",
    file: STATUS,
    find: "            const wedge = silenceNote(w.silence);",
    replace: "            const wedge = null;",
    expect: "red",
  },
  {
    id: "W2",
    what: "the threshold is hard-coded instead of read from the run",
    catches: "the window is read from the run rather than hard-coded",
    file: STATUS,
    find: "    return (await readRunBudgetPolicy(run)).stall;",
    replace: "    void readRunBudgetPolicy;\n    return { warnMs: 180_000, killMs: 1_500_000 };",
    expect: "red",
  },
  {
    id: "W3",
    what: "`--json` drops the verdict, leaving machine readers to parse the human line",
    catches: "`--json` carries the verdict too",
    file: STATUS,
    find: "                silence: {",
    replace: "                silence_omitted: {",
    expect: "red",
  },

  // ── Negative controls: behaviour-preserving edits that must stay GREEN. ──
  {
    id: "N1",
    what: "NEGATIVE CONTROL: rename the `grew` local without changing behaviour",
    catches: "nothing — proves the battery is aimed, not merely destructive",
    file: STATUS,
    find:
      "  const grew = Date.parse(input.activity.last_growth_at);\n" +
      "  if (Number.isNaN(beat) || Number.isNaN(grew)) {\n" +
      '    return { verdict: "unknown", why: "unreadable_stamp" };\n' +
      "  }",
    replace:
      "  const grownAt = Date.parse(input.activity.last_growth_at);\n" +
      "  if (Number.isNaN(beat) || Number.isNaN(grownAt)) {\n" +
      '    return { verdict: "unknown", why: "unreadable_stamp" };\n' +
      "  }\n" +
      "  const grew = grownAt;",
    expect: "green",
  },
  {
    id: "N2",
    what: "NEGATIVE CONTROL: reword the alarm's parenthetical, keeping every fact it states",
    catches: "nothing — proves the alarm probe asserts facts, not one exact string",
    file: STATUS,
    find: "      `(container may be gone)`",
    replace: "      `(its container may already be gone)`",
    expect: "green",
  },
];

function restore(): void {
  for (const [path, body] of Object.entries(PRISTINE)) {
    writeFileSync(path, body);
    if (sha(readFileSync(path, "utf8")) !== sha(body)) throw new Error(`RESTORE FAILED: ${path}`);
  }
}

interface Run {
  outcome: "pass" | "fail" | "TIMEOUT";
  /** Names of the failing tests, so the control can be checked per mutation. */
  failed: string[];
}

async function runTests(): Promise<Run> {
  return await new Promise((resolve) => {
    const child = spawn("bun", ["test", ...TESTFILES], { cwd: W });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ outcome: "TIMEOUT", failed: [] });
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = [...out.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!);
      resolve({ outcome: code === 0 ? "pass" : "fail", failed });
    });
  });
}

/**
 * Every target has a pristine copy, or the run refuses before it edits anything.
 *
 * `PRISTINE` is built above from `STATUS` alone, because that is the only file
 * these mutations touch today. Now that each entry names its own target, a
 * second one can be added without noticing that `restore()` has no copy of it —
 * and the symptom of that is the worst one this harness has: a mutation left
 * APPLIED, every later arm measuring a file nobody reverted, and the final
 * `allOk` hash check comparing only the file it did know about. Loud, once, up
 * front.
 */
for (const m of MUTATIONS) {
  if (!(m.file in PRISTINE)) {
    throw new Error(
      `mutation ${m.id} targets ${m.file}, which has no pristine copy — add it to PRISTINE, ` +
        `or restore() would leave this mutation applied and every later arm would measure it`,
    );
  }
}

let findings = 0;
restore();

process.stdout.write(`id  | expect | got     | control | mutation\n`);
process.stdout.write(`----+--------+---------+---------+---------------------------------------\n`);

for (const m of MUTATIONS) {
  restore();
  const src = readFileSync(m.file, "utf8");
  const count = src.split(m.find).length - 1;
  if (count !== 1) {
    process.stdout.write(`${m.id.padEnd(3)} | ANCHOR MATCHED ${count}x — NOT APPLIED: ${m.what}\n`);
    findings += 1;
    restore();
    continue;
  }
  writeFileSync(m.file, src.replace(m.find, m.replace));
  const run = await runTests();
  restore();

  const reddened = run.outcome !== "pass";
  const ok = m.expect === "red" ? reddened : !reddened;
  // The control must hold for EVERY mutation, red or green. A mutation that
  // takes the control down with it has not been shown to be aimed at anything.
  const controlHeld = !run.failed.some((f) => f.includes(CONTROL));
  if (!ok || !controlHeld) findings += 1;
  process.stdout.write(
    `${m.id.padEnd(3)} | ${m.expect.padEnd(6)} | ${run.outcome.padEnd(7)} | ` +
      `${(controlHeld ? "held" : "BROKE").padEnd(7)} | ${m.what}\n` +
      (ok && controlHeld ? "" : `    *** UNEXPECTED *** catches: ${m.catches}\n`) +
      (m.expect === "red" && reddened
        ? run.failed.map((f) => `      red: ${f}\n`).join("")
        : ""),
  );
}

restore();
const allOk = Object.entries(PRISTINE).every(([p, b]) => sha(readFileSync(p, "utf8")) === sha(b));
process.stdout.write(`\n=== ALL FILES RESTORED OK: ${allOk}\n=== UNEXPECTED RESULTS: ${findings}\n`);
