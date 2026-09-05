/**
 * Mutation battery — WHO THE CONSOLE BLAMES WHEN A REPORT CANNOT BE READ.
 *
 * A live three-lens review lost a lens and the record blamed the reviewer.
 * `rev-lang-1` wrote a 3906-byte review whose seat is regex correctness, so it
 * quoted a regex into a JSON string — `[\w\\-_]+` — and `\w` is not a valid JSON
 * escape. The envelope did not parse, the harvest settled `unknown`, and the
 * collation brief said the lens *"settled `unknown` and produced no report"*.
 * The report existed. The failure was in transport and the record named the
 * reviewer.
 *
 * The fix is prose: a note, a summary clause and a brief block. **Prose is
 * exactly what a probe can pin without proving**, which is why this battery
 * exists. Every mutation below is a plausible edit to that prose or to the one
 * expression that feeds it, and the question each asks is whether the suite
 * notices — including the two mutations that make the console MORE confident
 * rather than less, which is the direction the original defect ran in.
 *
 * ## THE SHAPE THIS IS WRITTEN AGAINST
 *
 * This branch's recurring defect is a fixture in which the two states being
 * distinguished coincide, so the probe passes against the right implementation
 * and the wrong one alike. The E11/E12 pair is the direct test of that: E11
 * gives the ABSENT lens the unreadable sentence and E12 gives the SILENT one
 * the strong claim. A suite that only ever asserted the unreadable case is
 * positive against both, and the console would be lying in a new direction with
 * every assertion green.
 *
 * Runs entirely inside a throwaway worktree; the live checkout is never written
 * to. Restore-first, checksum verified after every step.
 *
 *   git -C <repo> worktree add /tmp/wt HEAD --detach
 *   ln -s "<repo>/node_modules" /tmp/wt/node_modules
 *   # copy the working-tree versions of the files under test into /tmp/wt
 *   bun run test/mutation/envelope-attribution.battery.ts /tmp/wt
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE WORKTREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source files in place. The live fleet spawns containers
 * by reading the real working tree, and a transient broken state there has
 * already cost a worker its spawn once. There is no default for the same reason
 * `--force-identity` is not one: the destructive path must be typed.
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error(
    "usage: envelope-attribution.battery.ts <throwaway-worktree>  (never the live checkout)",
  );
}
const CORE = `${W}/src/run/relay.ts`;
const TESTFILES = [
  "test/unit/collator-relay.test.ts",
  "test/unit/collator-relay-adapter.test.ts",
];

/**
 * The pristine copy is taken FROM THE WORKTREE at start-up rather than from a
 * side file, so the battery can never restore a stale version over newer work —
 * the failure mode that silently reverts a fix and reports every mutation green.
 */
const PRISTINE: Record<string, string> = { [CORE]: readFileSync(CORE, "utf8") };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TIMEOUT_MS = 30_000;

interface M {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  expect: "red" | "green";
}

const MUTATIONS: M[] = [
  // ── The original defect, and the ways back to it. ────────────────────────
  {
    id: "E1",
    what: "THE LIVE DEFECT: an unreadable envelope is reported as having produced no report",
    file: CORE,
    find:
      "    case \"unreadable\":\n      return (\n        `it settled \\`${verdict}\\` and its report WAS WRITTEN AND COULD NOT BE READ: `",
    replace:
      "    case \"unreadable\":\n      return `it settled \\`${verdict}\\` and produced no report`;\n    case \"never\":\n      return (\n        `it settled \\`${verdict}\\` and its report WAS WRITTEN AND COULD NOT BE READ: `",
    expect: "red",
  },
  {
    id: "E2",
    what: "NOTE: the envelope is ignored entirely — one sentence for every missing lens",
    file: CORE,
    find:
      "        harvested.verdict === \"success\"\n          ? \"\"\n          : missingLensNote(harvested.verdict, envelope, outbox),",
    replace:
      "        harvested.verdict === \"success\"\n          ? \"\"\n          : `it settled \\`${harvested.verdict}\\` and produced no report`,",
    expect: "red",
  },
  {
    id: "E3",
    what: "SILENCE READ AS EVIDENCE: no envelope info still claims the reviewer produced nothing",
    file: CORE,
    // The outbox clause is KEPT by the mutation, deliberately: what E3 measures
    // is the CLAIM about the reviewer, and dropping the clause as well would
    // make a red here ambiguous between two different regressions.
    find:
      "    return `it settled \\`${verdict}\\` and no report reached the collator${outboxClause(outbox)}`;",
    replace:
      "    return `it settled \\`${verdict}\\` and produced no report${outboxClause(outbox)}`;",
    expect: "red",
  },
  {
    id: "E4",
    what: "OVER-CORRECTION: the ABSENT lens borrows the unreadable claim that a file exists",
    file: CORE,
    find:
      "    case \"absent\":\n      return (\n        `it settled \\`${verdict}\\` and produced no report — no result envelope exists for it` +\n        `${outboxClause(outbox)}`\n      );",
    replace:
      "    case \"absent\":\n      return (\n        `it settled \\`${verdict}\\` and its report WAS WRITTEN AND COULD NOT BE READ: ` +\n        `unknown is 0 bytes and did not parse (unknown: unknown)`\n      );",
    expect: "red",
  },
  {
    id: "E5",
    what: "OVER-CORRECTION: a readable envelope that failed is called a lens that produced nothing",
    file: CORE,
    find:
      "    case \"present\":\n      return (\n        `it settled \\`${verdict}\\`; its result envelope was readable, and no report reached the ` +\n        `collator because a reply is published only for a lens that succeeded`\n      );",
    replace:
      "    case \"present\":\n      return `it settled \\`${verdict}\\` and produced no report`;",
    expect: "red",
  },

  // ── The three facts that make the note actionable. ───────────────────────
  {
    id: "E6",
    what: "FACTS: the path is dropped, so nobody can open the review that exists",
    file: CORE,
    find: "        `${envelope.path} is ${envelope.bytes} bytes and did not parse ` +",
    replace: "        `the envelope is ${envelope.bytes} bytes and did not parse ` +",
    expect: "red",
  },
  {
    id: "E7",
    what: "FACTS: the size is dropped, so an empty file reads like a lost review",
    file: CORE,
    find: "        `${envelope.path} is ${envelope.bytes} bytes and did not parse ` +",
    replace: "        `${envelope.path} did not parse ` +",
    expect: "red",
  },
  {
    id: "E8",
    what: "FACTS: the parser's own complaint is replaced by a shrug",
    file: CORE,
    find: "        `(${envelope.code}: ${envelope.detail}). This is a transport failure, not a reviewer ` +",
    replace: "        `(it was unreadable). This is a transport failure, not a reviewer ` +",
    expect: "red",
  },

  // ── The brief's own block, and the guard the truncation section needed. ──
  {
    id: "E9",
    what: "BRIEF: the unreadable block never emits — the collator is never told to re-run",
    file: CORE,
    find:
      "    const unreadableLenses = missing.filter(\n      (c) => c.envelope?.kind === \"unreadable\" || c.envelope?.kind === \"unreadable_unspecified\",\n    );",
    replace: "    const unreadableLenses: typeof missing = [];",
    expect: "red",
  },
  {
    id: "E10",
    what: "BRIEF: the block emits for EVERY missing lens, so naming one means nothing",
    file: CORE,
    find:
      "    const unreadableLenses = missing.filter(\n      (c) => c.envelope?.kind === \"unreadable\" || c.envelope?.kind === \"unreadable_unspecified\",\n    );",
    replace: "    const unreadableLenses = missing;",
    expect: "red",
  },
  {
    id: "E18",
    what: "BRIEF: the detail-less unreadable arm loses the block, so an applied lens reads as one that was never re-runnable",
    file: CORE,
    find:
      "    const unreadableLenses = missing.filter(\n      (c) => c.envelope?.kind === \"unreadable\" || c.envelope?.kind === \"unreadable_unspecified\",\n    );",
    replace:
      "    const unreadableLenses = missing.filter((c) => c.envelope?.kind === \"unreadable\");",
    expect: "red",
  },
  {
    id: "E11",
    what: "SUMMARY: the count goes back to claiming the missing lenses produced nothing",
    file: CORE,
    find:
      "    `This console has ${children.length} review lenses. ${survived.length} produced a report ` +\n      `you can read; ${missing.length} did not.`,",
    replace:
      "    `This console has ${children.length} review lenses. ${survived.length} produced a report; ` +\n      `${missing.length} did not.`,",
    expect: "red",
  },

  // ── The single adapter point. ────────────────────────────────────────────
  {
    id: "E12",
    what: "ADAPTER: the harvester's envelope classification is dropped on the floor",
    file: CORE,
    find: "envelope: relayEnvelopeState(bundle),",
    replace: "envelope: undefined,",
    expect: "red",
  },
  {
    id: "E13",
    what: "ADAPTER: `null` is turned into manufactured evidence that no envelope existed",
    file: CORE,
    find: "  return undefined;",
    replace: "  return { kind: \"absent\" as const };",
    expect: "red",
  },
  {
    id: "E14",
    what: "ADAPTER: the harvester's fields are paraphrased instead of carried",
    file: CORE,
    find: "    return { kind: \"unreadable\", ...bundle.unreadableEnvelope };",
    replace:
      "    return {\n      kind: \"unreadable\" as const,\n      path: bundle.unreadableEnvelope.path,\n      bytes: 0,\n      code: bundle.unreadableEnvelope.code,\n      detail: bundle.unreadableEnvelope.detail,\n    };",
    expect: "red",
  },
  {
    id: "E15",
    what: "CHILD: the state is not carried onto the lens, so only prose can tell them apart",
    file: CORE,
    find: "    const envelope = harvested.envelope ?? null;",
    replace: "    const envelope = null as RelayEnvelopeState | null;",
    expect: "red",
  },

  // ── Negative controls. A battery whose every mutation reddens is measuring
  //    the suite's willingness to fail, not its ability to discriminate. ────
  {
    id: "N1",
    what: "NEGATIVE CONTROL: the local binding is renamed and nothing else changes",
    file: CORE,
    find:
      "    const envelope = harvested.envelope ?? null;\n    const outbox = harvested.outbox ?? null;\n    return {\n      worker: seat.worker,",
    replace:
      "    const envelopeState = harvested.envelope ?? null;\n    const envelope = envelopeState;\n    const outbox = harvested.outbox ?? null;\n    return {\n      worker: seat.worker,",
    expect: "green",
  },
  {
    id: "N2",
    what: "NEGATIVE CONTROL: a seat never dispatched keeps `null`, which is already its value",
    file: CORE,
    find:
      "        issued: false,\n        inlined: [],\n        envelope: null,\n        outbox: null,\n        note: \"the request never named this reviewer, so the lens was not applied\",",
    replace:
      "        issued: false,\n        inlined: [],\n        envelope: null as RelayEnvelopeState | null,\n        outbox: null,\n        note: \"the request never named this reviewer, so the lens was not applied\",",
    expect: "green",
  },
  {
    id: "E16",
    what: "BRIEF: the block is present and says nothing — the instruction is truncated away",
    file: CORE,
    find:
      "          `reason above in its note. Do NOT record it as a lens that found nothing or was not ` +\n          `applied: it was applied. Say in your prose report that this lens' review exists and ` +\n          `was not readable, so that a person can open the file and re-run the lens.`,",
    replace: "          `reason above in its note.`,",
    expect: "red",
  },
  {
    id: "E17",
    what: "BRIEF: the block stops saying the row is still `reported: false`",
    file: CORE,
    find: "          `not reach you. Record it as \"reported\": false — you have not read it — with the ` +",
    replace: "          `not reach you. Record it however you see fit, with the ` +",
    expect: "red",
  },
  {
    id: "E19",
    what: "REFUSED BRIEF: the refused block never emits — a complete review on disk goes unmentioned",
    file: CORE,
    find: "    const refusedLenses = missing.filter((c) => c.envelope?.kind === \"refused\");",
    replace: "    const refusedLenses: typeof missing = [];",
    expect: "red",
  },
  {
    id: "E20",
    what: "REFUSED BRIEF: the block emits for EVERY missing lens, so naming one means nothing",
    file: CORE,
    find: "    const refusedLenses = missing.filter((c) => c.envelope?.kind === \"refused\");",
    replace: "    const refusedLenses = missing;",
    expect: "red",
  },
  {
    id: "E21",
    what: "REFUSED BRIEF: the block is present and says nothing — the instruction is truncated away",
    file: CORE,
    find:
      "          `record it as a lens that found nothing, was not applied, or could not be read: the ` +\n          `review is complete and legible on disk. Say in your prose report that this lens' ` +\n          `review was written and rejected, and name the reason, so that a person can open the ` +\n          `file and read the findings this collation does not contain.`,",
    replace: "          `record it however you see fit.`,",
    expect: "red",
  },
  {
    id: "E22",
    what: "REFUSED BRIEF: the refused lens is told it was UNREADABLE, sending a person to look for damage in an intact file",
    file: CORE,
    find:
      "        `REFUSED ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and wrote a report that ` +\n          `PARSED and was then declined by the console for the reason above. Record it as ` +",
    replace:
      "        `UNREADABLE ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and its report was ` +\n          `not readable. Record it as ` +",
    expect: "red",
  },
  {
    id: "N4",
    what: "NEGATIVE CONTROL: the refused block's prose is reworded and every semantic clause survives",
    file: CORE,
    find:
      "        `REFUSED ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and wrote a report that ` +\n          `PARSED and was then declined by the console for the reason above. Record it as ` +",
    replace:
      "        `REFUSED ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and produced a report ` +\n          `that PARSED and that the console then turned down, for the reason above. Record it as ` +",
    expect: "green",
  },
  {
    id: "N3",
    what: "NEGATIVE CONTROL: the block's prose is reworded and every semantic clause survives",
    file: CORE,
    find:
      "        `UNREADABLE ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and its report did ` +\n          `not reach you.",
    replace:
      "        `UNREADABLE ENVELOPE: ${c.aspect} (${c.worker}) read the change and what it wrote ` +\n          `never arrived.",
    expect: "green",
  },
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

for (const m of MUTATIONS) {
  restore();
  const src = readFileSync(m.file, "utf8");
  const count = src.split(m.find).length - 1;
  if (count !== 1) {
    process.stdout.write(`${m.id} | ${m.what} | PRIMARY ANCHOR MATCHED ${count}x — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
  writeFileSync(m.file, src.replace(m.find, m.replace));
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
