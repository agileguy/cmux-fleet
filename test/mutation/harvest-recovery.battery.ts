/**
 * Mutation battery — THE LENS NOBODY READ, AND WHETHER ANYTHING POINTS AT IT.
 *
 * ISC-517's chain had three links. Two were closed on the previous branch: a
 * relative artifact path is now resolved rather than refused, and a refusal is
 * now a state rather than a silence. This battery grades the third, which is
 * the arm where the harvest itself THROWS — a torn `state.json`, an unreadable
 * inbox record, a `git` that would not run.
 *
 * There, nothing at all is read: no envelope, no artifacts, no verdict. The
 * console recorded WHY and stopped, and a review written perfectly well sat in
 * a directory nothing named. The fix is a listing taken at the moment of
 * failure — possible because `listTaskOutbox` shares no input with the harvest
 * that just failed — carried back on the rejection, appended to the note, and
 * turned into an instruction in the brief.
 *
 * ## THE SHAPE THIS IS WRITTEN AGAINST
 *
 * `H4` is the mutation that matters most and it deletes nothing: it swaps the
 * new clause for `outboxClause`, the one the successful-harvest path uses. That
 * is the edit a reader would make on the grounds that two clauses saying "here
 * is what is sitting there" should be one. It reads perfectly and it inverts
 * the meaning of `empty` — which, after a failed harvest, is the arm that
 * decides whether an operator goes and looks at a `result.json` nobody opened.
 * `H5` and `H6` grade the two arms it would corrupt, one each.
 *
 * `H10` runs the other way: it flags a SUCCESSFUL harvest as failed, so the
 * block fires on lenses that were read perfectly. A suite that only asserted
 * the positive case is green against both it and the right implementation.
 *
 * Runs entirely inside a throwaway worktree; the live checkout is never written
 * to. Restore-first, checksum verified after every step.
 *
 *   git -C <repo> worktree add /tmp/wt HEAD --detach
 *   ln -s "<repo>/node_modules" /tmp/wt/node_modules
 *   # copy the working-tree versions of the files under test into /tmp/wt
 *   bun run test/mutation/harvest-recovery.battery.ts /tmp/wt
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
    "usage: harvest-recovery.battery.ts <throwaway-worktree>  (never the live checkout)",
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
  {
    id: "H1",
    what: "ADAPTER: the failed harvest stops taking a listing, so the lens is lost again",
    file: CORE,
    find:
      "        const outbox = await effects\n          .listTaskOutbox(run, task.worker, task.taskId)\n          .catch(() => null);",
    replace:
      "        const outbox = null;",
    expect: "red",
  },
  {
    id: "H2",
    what: "ADAPTER: a listing that throws is reported as `unlistable`, claiming a readdir that never ran",
    file: CORE,
    find:
      "        const outbox = await effects\n          .listTaskOutbox(run, task.worker, task.taskId)\n          .catch(() => null);",
    replace:
      "        const outbox = await effects\n          .listTaskOutbox(run, task.worker, task.taskId)\n          .catch(() => ({ kind: \"unlistable\" }) as const);",
    expect: "red",
  },
  {
    id: "H3",
    what: "CORE: the listing on the rejection is ignored, so the pointer never reaches the child",
    file: CORE,
    find:
      "    if (err instanceof RelayHarvestError && err.outbox !== null) {\n      failedHarvestOutbox.set(p.seat.aspect, err.outbox);\n    }",
    replace:
      "",
    expect: "red",
  },
  {
    id: "H4",
    what: "NOTE: the successful-harvest clause is reused, which inverts what `empty` means here",
    file: CORE,
    find:
      "  return `${head}${unreadOutboxClause(outbox)}`;",
    replace:
      "  return `${head}${outboxClause(outbox)}`;",
    expect: "red",
  },
  {
    id: "H5",
    what: "NOTE: the empty arm stops pointing at the usual places, so a person is told not to look",
    file: CORE,
    find:
      "  if (outbox.kind === \"empty\") {\n    return `. Its task outbox holds no unexpected entries. ${usual}`;\n  }",
    replace:
      "  if (outbox.kind === \"empty\") {\n    return \". Its task outbox holds no unexpected entries\";\n  }",
    expect: "red",
  },
  {
    id: "H6",
    what: "NOTE: a listing that failed is dropped, so two failed reads read as a silent reviewer",
    file: CORE,
    find:
      "  if (outbox.kind === \"unlistable\") {\n    return `. Its task outbox could not be listed either, so nothing here can say what is in it. ${usual}`;\n  }",
    replace:
      "  if (outbox.kind === \"unlistable\") {\n    return \"\";\n  }",
    expect: "red",
  },
  {
    id: "H7",
    what: "BRIEF: the harvest-failed block never emits",
    file: CORE,
    find:
      "    const unharvestedLenses = missing.filter((c) => c.harvestFailed);",
    replace:
      "    const unharvestedLenses: typeof missing = [];",
    expect: "red",
  },
  {
    id: "H8",
    what: "BRIEF: the block emits for EVERY missing lens, so naming one means nothing",
    file: CORE,
    find:
      "    const unharvestedLenses = missing.filter((c) => c.harvestFailed);",
    replace:
      "    const unharvestedLenses = missing;",
    expect: "red",
  },
  {
    id: "H9",
    what: "BRIEF: the instruction is truncated away \u2014 the block is present and says nothing",
    file: CORE,
    find:
      "          `opened its outbox. Say in your prose report that this lens was dispatched and never ` +\n          `read, and repeat what its note says the outbox holds, so that a person can look for a ` +\n          `review that may be sitting there complete.`,",
    replace:
      "          `opened its outbox.`,",
    expect: "red",
  },
  {
    id: "H10",
    what: "CHILD: a successful harvest is flagged as failed, so the block fires on lenses that were read",
    file: CORE,
    find:
      "      harvestFailed: false,\n      inlined: harvested.inlined ?? [],",
    replace:
      "      harvestFailed: true,\n      inlined: harvested.inlined ?? [],",
    expect: "red",
  },
  {
    id: "N1",
    what: "NEGATIVE CONTROL: the block's prose is reworded and every semantic clause survives",
    file: CORE,
    find:
      "        `HARVEST FAILED: ${c.aspect} (${c.worker}) was dispatched and the host could not read ` +\n          `its result at all \u2014 no envelope, no artifacts, no verdict. Record it as \"reported\": ` +",
    replace:
      "        `HARVEST FAILED: ${c.aspect} (${c.worker}) was sent out and nothing here managed to ` +\n          `read what came back \u2014 no envelope, no artifacts, no verdict. Record it as \"reported\": ` +",
    expect: "green",
  },
  {
    id: "N2",
    what: "NEGATIVE CONTROL: the recovery listing is taken with the arguments named rather than positional-inline",
    file: CORE,
    find:
      "        const outbox = await effects\n          .listTaskOutbox(run, task.worker, task.taskId)\n          .catch(() => null);",
    replace:
      "        const { worker: w, taskId: tid } = task;\n        const outbox = await effects.listTaskOutbox(run, w, tid).catch(() => null);",
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
