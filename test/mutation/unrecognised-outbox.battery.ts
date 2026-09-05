/**
 * Mutation battery — CAN THE CONSOLE TELL AN EMPTY OUTBOX FROM A FULL ONE.
 *
 * A live three-lens review lost a lens and every sentence anybody read was
 * true. `rev-lang-1` produced a complete 12,759-byte review and wrote it to
 * `/outbox/R-rally-async-6-lang/artifact.json` — the TASK ROOT, under a name it
 * invented, carrying an invented `"schema": "pifleet.ticketops/v1"`. It wrote no
 * `result.json` and created no `files/`. The harvest has exactly two readers of
 * that region and each looks at exactly one name, so both missed it, and the
 * brief said:
 *
 *     MISSING ASPECT: lang (rev-lang-1) — it settled `unknown` and no report
 *     reached the collator.
 *
 * Honest, and the whole of what anyone was told. The fix adds ONE FACT — is that
 * outbox empty, or does it hold things nothing here reads — and the fix is
 * prose plus a `readdir`. **Prose is exactly what a probe can pin without
 * proving**, which is why this battery exists.
 *
 * ## THE TWO DIRECTIONS THIS MEASURES
 *
 * 1. **Can the suite see the fact disappear?** M1–M5, M10–M15, M17–M19 delete
 *    or corrupt it in the ways a plausible refactor would.
 * 2. **Can the suite see the console get MORE CONFIDENT than its evidence?**
 *    M6, M8, M9 and M16 push in the direction the original defect ran in —
 *    claiming a review was found, manufacturing `empty` from silence, widening
 *    the clause onto arms whose evidence does not support it. A suite that only
 *    asserted the presence of the new sentence is green against all four, and
 *    the console would be lying in a new direction with every assertion passing.
 *
 * ## THE FIXTURE SHAPE THIS IS WRITTEN AGAINST
 *
 * This branch's recurring defect is a probe whose two fixtures make the two
 * states being distinguished COINCIDE, so it passes against the right
 * implementation and the wrong one alike. M2 is the direct test of that: it
 * silences the `empty` arm only, which leaves the empty/unrecognised pair still
 * differing and would sail past a suite that owned just that one pair.
 *
 * Runs entirely inside a throwaway tree; the live checkout is never written to.
 * Restore-first, checksum verified after every step.
 *
 *   # a throwaway COPY (this agent could not create a git worktree):
 *   mkdir -p /tmp/wt && cp -R <repo>/src <repo>/test /tmp/wt/
 *   cp <repo>/package.json <repo>/tsconfig.json <repo>/bunfig.toml /tmp/wt/
 *   ln -s <repo>/node_modules /tmp/wt/node_modules
 *   ln -s <repo>/docker /tmp/wt/docker
 *   bun run test/mutation/unrecognised-outbox.battery.ts /tmp/wt
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE TREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source files in place. The live fleet spawns containers
 * by reading the real working tree, and a transient broken state there has
 * already cost a worker its spawn once. There is no default for the same reason
 * `--force-identity` is not one: the destructive path must be typed.
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error(
    "usage: unrecognised-outbox.battery.ts <throwaway-tree>  (never the live checkout)",
  );
}
const RELAY = `${W}/src/run/relay.ts`;
const LIST = `${W}/src/harvest/task-outbox.ts`;
const HARV = `${W}/src/harvest/index.ts`;

const TESTFILES = [
  "test/unit/collator-outbox-note.test.ts",
  "test/unit/harvest-task-outbox.test.ts",
  "test/unit/harvest-task-outbox-wiring.test.ts",
  // The arms this change did NOT touch. A mutation that widened the clause onto
  // `unreadable` or `present` has to be caught by the suite that owns them.
  "test/unit/collator-relay.test.ts",
];

/**
 * The pristine copy is taken FROM THE TREE at start-up rather than from a side
 * file, so the battery can never restore a stale version over newer work — the
 * failure mode that silently reverts a fix and reports every mutation green.
 * Keyed by FULL PATH, so two files with the same basename cannot collide.
 */
const PRISTINE: Record<string, string> = {
  [RELAY]: readFileSync(RELAY, "utf8"),
  [LIST]: readFileSync(LIST, "utf8"),
  [HARV]: readFileSync(HARV, "utf8"),
};
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
  // ── The live defect, and the ways back to it. ────────────────────────────
  {
    id: "M1",
    what: "THE LIVE DEFECT: the silent lens' note never mentions its outbox at all",
    file: RELAY,
    find:
      "    return `it settled \\`${verdict}\\` and no report reached the collator${outboxClause(outbox)}`;",
    replace: "    return `it settled \\`${verdict}\\` and no report reached the collator`;",
    expect: "red",
  },
  {
    id: "M2",
    what: "COINCIDING FIXTURES: only the EMPTY arm goes silent, so checked-and-bare reads as never-checked",
    file: RELAY,
    find:
      "  if (outbox.kind === \"empty\") {\n    return (\n      `. Its task outbox WAS checked and holds nothing besides what the harvest already ` +\n      `reads, so there is no other file to look in`\n    );\n  }",
    replace: "  if (outbox.kind === \"empty\") return \"\";",
    expect: "red",
  },
  {
    id: "M3",
    what: "COUNT: the total becomes the length of the capped list, so forty files report as eight",
    file: RELAY,
    find: "    `. Its task outbox is NOT EMPTY: the task root holds ${outbox.total} ` +",
    replace: "    `. Its task outbox is NOT EMPTY: the task root holds ${outbox.named.length} ` +",
    expect: "red",
  },
  {
    id: "M4",
    what: "TRUNCATION: the list is cut in silence, so a reader infers it is complete",
    file: RELAY,
    find: "    `${more > 0 ? `, and ${more} more not named` : \"\"}`\n  );",
    replace: "    `${more > 0 ? \"\" : \"\"}`\n  );",
    expect: "red",
  },
  {
    id: "M5",
    what: "FACTS: the size is dropped, so a stray notes.txt and a lost review read alike",
    file: RELAY,
    find:
      "  return e.bytes === null ? `${e.name} (size unavailable)` : `${e.name} (${e.bytes} bytes)`;",
    replace: "  return e.name;",
    expect: "red",
  },

  // ── The over-confident direction — the one the original defect ran in. ───
  {
    id: "M6",
    what: "OVER-CLAIM: the disclaimer becomes an assertion that the review is in there",
    file: RELAY,
    find:
      "    `the result envelope and the files/ directory. Listed by name and size ONLY; nothing here ` +\n    `opened them, so nothing here can say what any of it contains — a person has to look: ` +",
    replace:
      "    `the result envelope and the files/ directory. The review is in one of these: ` +",
    expect: "red",
  },
  {
    id: "M7",
    what: "ADAPTER: the harvester's listing is dropped on the floor",
    file: RELAY,
    find: "        outbox: bundle.taskOutbox ?? undefined,",
    replace: "        outbox: undefined,",
    expect: "red",
  },
  {
    id: "M8",
    what: "ADAPTER: silence is manufactured into evidence that the outbox was empty",
    file: RELAY,
    find: "        outbox: bundle.taskOutbox ?? undefined,",
    replace: "        outbox: bundle.taskOutbox ?? ({ kind: \"empty\" } as const),",
    expect: "red",
  },
  {
    id: "M9",
    what: "TAXONOMY WIDENED: the clause is appended to the `unreadable` arm, which already names its file",
    file: RELAY,
    find:
      "        `that found nothing — the review exists on disk and no report reached the collator`\n      );",
    replace:
      "        `that found nothing — the review exists on disk and no report reached the collator` +\n        `${outboxClause(outbox)}`\n      );",
    expect: "red",
  },

  // ── The listing itself. ──────────────────────────────────────────────────
  {
    id: "M10",
    what: "RECOGNISED: files/ stops being recognised, so every correct outbox reports a finding",
    file: LIST,
    find: "const RECOGNISED = new Set<string>([RESULT_ENVELOPE_NAME, OUTBOX_FILES_DIR]);",
    replace: "const RECOGNISED = new Set<string>([RESULT_ENVELOPE_NAME]);",
    expect: "red",
  },
  {
    id: "M11",
    what: "BOUND: the cap is removed, so a worker that wrote 10,000 files names 10,000",
    file: LIST,
    find: "  for (const e of unrecognised.slice(0, MAX_NAMED_UNRECOGNISED_ENTRIES)) {",
    replace: "  for (const e of unrecognised) {",
    expect: "red",
  },
  {
    id: "M12",
    what: "SYMLINK: a link stops being classified as one, so it is sized like a file",
    file: LIST,
    find: "  if (e.isSymbolicLink()) return \"symlink\";\n  if (e.isDirectory()) return \"directory\";",
    replace: "  if (e.isDirectory()) return \"directory\";",
    expect: "red",
  },
  {
    id: "M13",
    what: "INJECTION: a worker-chosen name reaches the report unswept",
    file: LIST,
    find: "    named.push({ name: safeForReport(e.name), kind, bytes });",
    replace: "    named.push({ name: e.name, kind, bytes });",
    expect: "red",
  },
  {
    id: "M14",
    what: "ORDER: the sort reverses, so the cap decides WHICH entries get named",
    file: LIST,
    find: "    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));",
    replace: "    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));",
    expect: "red",
  },
  {
    id: "M15",
    what: "SILENCE AS EVIDENCE: an unlistable outbox is reported as an empty one",
    file: LIST,
    find: "    return { kind: \"unlistable\" };",
    replace: "    return { kind: \"empty\" };",
    expect: "red",
  },
  {
    id: "M16",
    what: "TOCTOU: the stat's own type re-check is dropped, so a swapped inode is sized anyway",
    file: LIST,
    find: "        bytes = st.isFile() ? st.size : null;",
    replace: "        bytes = st.size;",
    expect: "red",
  },

  // ── The harvest's own wiring. ────────────────────────────────────────────
  {
    id: "M17",
    what: "WIRING: the discrepancy never emits, so `pifleet artifacts` shows nothing",
    file: HARV,
    find: "    if (taskOutbox.kind === \"unrecognised\") {",
    replace: "    if (taskOutbox.kind === \"unrecognised\" && false) {",
    expect: "red",
  },
  {
    id: "M18",
    what: "WIRING: the listing is computed and never attached, so the relay gets nothing",
    file: HARV,
    find: "      taskOutbox,",
    replace: "      taskOutbox: { kind: \"unlistable\" as const },",
    expect: "red",
  },
  {
    id: "M19",
    what: "WIRING: the discrepancy fires for every listing, so naming one means nothing",
    file: HARV,
    find: "    if (taskOutbox.kind === \"unrecognised\") {\n      const named = taskOutbox.named.map(describeUnrecognisedEntry).join(\", \");",
    replace:
      "    if (taskOutbox.kind !== \"unlistable\") {\n      const named =\n        taskOutbox.kind === \"unrecognised\"\n          ? taskOutbox.named.map(describeUnrecognisedEntry).join(\", \")\n          : \"\";",
    expect: "red",
  },

  // ── Negative controls. A battery whose every mutation reddens is measuring
  //    the suite's willingness to fail, not its ability to discriminate. ────
  {
    id: "N1",
    what: "NEGATIVE CONTROL: the local binding is renamed and nothing else changes",
    file: RELAY,
    find: "    const outbox = harvested.outbox ?? null;",
    replace:
      "    const outboxListing = harvested.outbox ?? null;\n    const outbox = outboxListing;",
    expect: "green",
  },
  {
    id: "N2",
    what: "NEGATIVE CONTROL: the entry-kind branches are reordered, which cannot change any answer",
    file: RELAY,
    find:
      "  if (e.kind === \"directory\") return `${e.name}/ (directory, not descended)`;\n  if (e.kind === \"symlink\") return `${e.name} (symlink, not followed)`;",
    replace:
      "  if (e.kind === \"symlink\") return `${e.name} (symlink, not followed)`;\n  if (e.kind === \"directory\") return `${e.name}/ (directory, not descended)`;",
    expect: "green",
  },
  {
    id: "N3",
    what: "NEGATIVE CONTROL: the empty-list early return is rewritten as an explicit branch",
    file: LIST,
    find: "  if (unrecognised.length === 0) return { kind: \"empty\" };",
    replace:
      "  if (unrecognised.length === 0) {\n    const empty: TaskOutboxListing = { kind: \"empty\" };\n    return empty;\n  }",
    expect: "green",
  },
];

function restore(): void {
  for (const [path, body] of Object.entries(PRISTINE)) {
    writeFileSync(path, body);
    if (sha(readFileSync(path, "utf8")) !== sha(body)) throw new Error(`RESTORE FAILED: ${path}`);
  }
}

/**
 * `"TIMEOUT"` IS ITS OWN OUTCOME AND IS NEVER A RESULT.
 *
 * macOS has no `timeout(1)`, so the bound is here. The distinction matters more
 * than it looks: an arm that never finished did not "fail", and folding it into
 * `red` would let a mutation that WEDGES the suite be reported as one the suite
 * caught. The caller treats it as a finding regardless of what was expected.
 */
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

/**
 * THE BASELINE, and it is not a formality. Every `expect: "red"` below is only
 * meaningful if the unmutated tree is GREEN — a tree that was already failing
 * would report every mutation as caught, and the battery would be measuring
 * nothing at all while printing a perfect score.
 */
const baseline = await runTests();
process.stdout.write(`BASELINE | unmutated tree | ${baseline}\n`);
if (baseline !== "pass") {
  process.stdout.write("=== BASELINE IS NOT GREEN — every result below would be meaningless\n");
  process.exit(1);
}

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
  // An arm that never ran is never "as expected", whichever way it was expected
  // to go. See `runTests`.
  const ok = outcome === "TIMEOUT" ? false : m.expect === "red" ? outcome === "fail" : outcome === "pass";
  if (!ok) findings += 1;
  process.stdout.write(
    `${m.id} | ${m.what} | expected ${m.expect} | got ${outcome} | ${ok ? "as expected" : "*** UNEXPECTED ***"}\n`,
  );
}

restore();
const allOk = Object.entries(PRISTINE).every(([p, b]) => sha(readFileSync(p, "utf8")) === sha(b));
process.stdout.write(`\n=== ALL FILES RESTORED OK: ${allOk}\n=== UNEXPECTED RESULTS: ${findings}\n`);
