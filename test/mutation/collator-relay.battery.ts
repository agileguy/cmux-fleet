/**
 * Mutation battery 4 — the five end-of-phase findings.
 *
 * Runs entirely inside the throwaway worktree; the live checkout is never
 * written to. Restore-first across BOTH files, checksum verified after every
 * step, hard timeout because the unbounded-poll mutation hangs.
 *
 * S-prefixed mutations are the security regression (typed plane). N-prefixed are
 * "nothing landed". A-prefixed are the run-map ambiguity. R-prefixed are the
 * collator-run resolution.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * THE WORKTREE TO MUTATE — required, and deliberately not defaulted.
 *
 * This script rewrites source files in place. Pointing it at a live checkout is
 * how a transient broken state gets read by something that spawns containers
 * from the tree, which cost a worker once. There is no default for the same
 * reason `--force-identity` is not one: the destructive path must be typed.
 *
 *   git worktree add /tmp/wt HEAD --detach
 *   ln -s "$PWD/node_modules" /tmp/wt/node_modules && cp fleet.yaml /tmp/wt/
 *   bun run test/mutation/collator-relay.battery.ts /tmp/wt
 */
const W = process.argv[2];
if (W === undefined || W === "" || W.endsWith("/cmux-fleet")) {
  throw new Error(
    "usage: collator-relay.battery.ts <throwaway-worktree>  (never the live checkout)",
  );
}
const CORE = `${W}/src/run/relay.ts`;
const CLI = `${W}/src/cli/commands/relay.ts`;
const TESTFILE = "test/unit/collator-relay-adapter.test.ts";

/**
 * The pristine copy is taken FROM THE WORKTREE at start-up rather than from a
 * side file, so the battery can never restore a stale version over newer work —
 * the failure mode that silently reverts a fix and reports every mutation green.
 */
const DR = `${W}/src/run/dispatch-request.ts`;
const PRISTINE: Record<string, string> = {
  [CORE]: readFileSync(CORE, "utf8"),
  [CLI]: readFileSync(CLI, "utf8"),
  [DR]: readFileSync(DR, "utf8"),
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TIMEOUT_MS = 25_000;

interface M {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  expect: "red" | "green";
  also?: Array<{ file?: string; find: string; replace: string }>;
}

const MUTATIONS: M[] = [
  // ── T1: brief-to-lens binding. The mutation the reviewer demonstrated. ───
  {
    id: "B1",
    what: "T1 BINDING: the seat's entry is chosen POSITIONALLY, not by worker",
    file: CORE,
    find: "    for (const seat of seats) {\n      const entry = request.requests.find((r) => r.worker === seat.worker);",
    replace: "    for (const [i, seat] of seats.entries()) {\n      const entry = request.requests[i];",
    expect: "red",
  },
  {
    id: "B2",
    what: "T1 BINDING: the fan-out walks the REQUEST's order instead of the table",
    file: CORE,
    find: "      const entry = request.requests.find((r) => r.worker === seat.worker);",
    replace: "      const entry = [...request.requests].reverse().find((r) => r.worker === seat.worker);",
    expect: "green",
  },
  // ── T2: the producer half of the run map. ────────────────────────────────
  {
    id: "B3",
    what: "T2 ORDER: candidates are no longer newest-first",
    file: CORE,
    find: "      const ids = [...(await src.listRunIds(root))].reverse();",
    replace: "      const ids = [...(await src.listRunIds(root))];",
    expect: "red",
  },
  {
    id: "B4",
    what: "T2 LIVENESS: a dead run is a candidate again",
    file: CORE,
    find: "    hasWorker: (run, worker) => src.isLiveWorker(run, worker),",
    replace: "    hasWorker: async () => true,",
    expect: "red",
  },
  {
    id: "B5",
    what: "T2 PIN: an explicit map is ignored and the scan runs anyway",
    file: CORE,
    find: "  if (pinned !== null) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "B6",
    what: "T2 PIN: the collator is taken from the environment rather than its own run",
    file: CORE,
    find: "      if (worker === input.sender) {\n        runs.set(worker, input.run);\n        continue;\n      }",
    replace: "      if (worker === input.sender && pinned.get(worker) === undefined) {\n        runs.set(worker, input.run);\n        continue;\n      }",
    expect: "green",
  },
  // ── D2/D3: the operator stream and its durable half. ─────────────────────
  {
    id: "B7",
    what: "D3: a dispatched outcome drops its reason before rendering",
    file: CLI,
    find: "      return o.reason === undefined ? line : `${line} — ${o.reason}`;",
    replace: "      return line;",
    expect: "red",
  },
  {
    id: "B8",
    what: "D3: the reason is never appended to the ledger",
    file: CLI,
    find: "    if (result.reason !== undefined) {",
    replace: "    if (false) {",
    expect: "green",
  },
  // ── SECURITY: the typed plane. ───────────────────────────────────────────
  {
    id: "S1",
    what: "SECURITY: the typed plane is allowed through the preflight",
    file: CORE,
    find: '      if (plane === "typed" || plane === "unknown") {',
    replace: '      if (plane === "unknown") {',
    expect: "red",
  },
  {
    id: "S2",
    what: "SECURITY: the preflight runs but its result is ignored",
    file: CORE,
    find: '      if (plane === "typed" || plane === "unknown") {',
    replace: '      if (false && (plane === "typed" || plane === "unknown")) {',
    expect: "red",
  },
  {
    id: "S3",
    what: "SECURITY: the preflight becomes a POST-check (too late by construction)",
    file: CORE,
    find: "      const plane = await effects.deliveryPlane(run, d.worker);",
    replace: "      const plane = (await effects.sendTask(run, d.worker, d)).via as RelayDeliveryPlane;",
    expect: "red",
  },
  {
    id: "S4",
    what: "SECURITY: an unknown launch shape is guessed as safe",
    file: CORE,
    find: '      if (plane === "typed" || plane === "unknown") {',
    replace: '      if (plane === "typed") {',
    expect: "red",
  },
  {
    id: "S5",
    what: "SECURITY: the `via: pane` backstop is removed",
    file: CORE,
    find: '      if (outcome.via === "pane") {',
    replace: "      if (false) {",
    expect: "red",
  },
  {
    id: "S6",
    what: "deliveryPlane: a non-adopted tui pane is reported as staged",
    file: CORE,
    find: '    return presentation?.adopted_terminal === true ? "staged" : "typed";',
    replace: '    return "staged";',
    expect: "green",
  },
  // ── P2: the deferred trigger. ────────────────────────────────────────────
  {
    id: "T1",
    what: "TRIGGER: an accepted-but-untriggered stage is counted as landed",
    file: CORE,
    find: "      if (outcome.error !== null) {",
    replace: "      if (false) {",
    expect: "red",
  },
  {
    id: "T2",
    what: "TRIGGER: the instruction is dropped from the refusal",
    file: CORE,
    find: "            `record can appear and the join would wait out its whole deadline for a keystroke: ` +\n            `${outcome.error}`,",
    replace: "            `record can appear and the join would wait out its whole deadline.`,",
    expect: "red",
  },
  // ── P1: nothing landed. ──────────────────────────────────────────────────
  {
    id: "N1",
    what: "NOTHING-LANDED: the arm is removed, so it falls through to not_collated",
    file: CORE,
    find: "  if (routed.length > 0 && landed.length === 0) {",
    replace: "  if (false) {",
    expect: "red",
  },
  {
    id: "N2",
    what: "NOTHING-LANDED: journalled as `dispatched` (the original defect)",
    file: CORE,
    find: '  if (outcome.kind === "refused" || outcome.kind === "none_landed") {',
    replace: '  if (outcome.kind === "refused") {',
    expect: "red",
  },
  {
    id: "N3",
    what: "NOTHING-LANDED: the guard also swallows a genuine `not_collated`",
    file: CORE,
    find: "  if (routed.length > 0 && landed.length === 0) {",
    replace: "  if (routed.length > 0 && survived.length === 0) {",
    expect: "red",
  },
  {
    id: "N4",
    what: "CHILDREN: planned ids are journalled again (issued filter removed)",
    file: CORE,
    find: "  const children = outcome.children\n    .filter((c) => c.issued)",
    replace: "  const children = outcome.children\n    .filter(() => true)",
    expect: "red",
  },
  {
    id: "N5",
    what: "CHILDREN: a refused dispatch is marked issued",
    file: CORE,
    find: "        // PLANNED but never issued — see `RelayChild.issued`. The id is kept so\n        // an operator can correlate the refusal; it is not evidence of a dispatch.\n        issued: false,",
    replace: "        issued: true,",
    expect: "red",
  },
  // ── F2: run-map ambiguity. ───────────────────────────────────────────────
  {
    id: "A1",
    what: "AMBIGUITY: the newest candidate wins again",
    file: CORE,
    find: "      if (matches.length === 1) {\n        runs.set(worker, matches[0]!);\n        continue;\n      }",
    replace: "      if (matches.length >= 1) {\n        runs.set(worker, matches[0]!);\n        continue;\n      }",
    expect: "red",
  },
  {
    id: "A2",
    what: "AMBIGUITY: recorded but not acted on — the fan-out proceeds",
    file: CORE,
    find: "    if (ambiguous.size > 0) {",
    replace: "    if (false) {",
    expect: "red",
  },
  {
    id: "A3",
    what: "AMBIGUITY: fails OPEN — only the ambiguous seat is dropped",
    file: CORE,
    find: "    if (ambiguous.size > 0) {",
    replace: "    if (ambiguous.size > 99) {",
    expect: "red",
  },
  // ── Carried forward. ─────────────────────────────────────────────────────
  {
    id: "C1",
    what: "COLLATION: the failed collation is reported as `collated`",
    file: CORE,
    find: '      kind: "collation_failed",\n      collation,',
    replace: '      kind: "collated" as "collation_failed",\n      collation,',
    expect: "red",
  },
  {
    id: "C5",
    what: "COLLATION: every dispatched result carries a reason",
    file: CORE,
    find: '  return { kind: "dispatched", children };\n}',
    replace: '  return { kind: "dispatched", children, reason: "ok" };\n}',
    expect: "red",
  },
  {
    id: "M7",
    what: "awaitSettled: the deadline check is removed (UNBOUNDED)",
    file: CORE,
    find: "        if (effects.now() - started >= deadlineMs) {",
    replace: "        if (false) {",
    expect: "red",
  },
  {
    id: "M11",
    what: "harvest: supervisor verdicts folded to `failed`",
    file: CORE,
    find: "        verdict: bundle.harvest.verdict,",
    replace: '        verdict: bundle.harvest.verdict === "success" ? "success" : "failed",',
    expect: "red",
  },
  {
    id: "M13",
    what: "publishReply: filed under the CHILD instead of the collator",
    file: CORE,
    find: "await effects.writeReply(collatorRun, collator, child, reply);",
    replace: "await effects.writeReply(collatorRun, child, child, reply);",
    expect: "red",
  },
  {
    id: "P1",
    what: "ROSTER PIN: a fourth reviewer with no seat",
    file: DR,
    find: 'reviewers: ["rev-arch-1", "rev-ctx-1", "rev-lang-1"],',
    replace: 'reviewers: ["rev-arch-1", "rev-ctx-1", "rev-lang-1", "rev-sec-1"],',
    expect: "red",
  },
  // ── Negative controls. ───────────────────────────────────────────────────
  {
    id: "NC1",
    what: "NEGATIVE CONTROL: rename the local `plane` in dispatch",
    file: CORE,
    find: "      const plane = await effects.deliveryPlane(run, d.worker);\n      if (plane === \"typed\" || plane === \"unknown\") {",
    replace: "      const route = await effects.deliveryPlane(run, d.worker);\n      if (route === \"typed\" || route === \"unknown\") {",
    expect: "green",
    also: [
      {
        find: '          plane === "typed" ? "pane_delivery_types_the_brief" : "delivery_plane_unknown",\n          plane === "typed"',
        replace: '          route === "typed" ? "pane_delivery_types_the_brief" : "delivery_plane_unknown",\n          route === "typed"',
      },
    ],
  },
  {
    id: "NC2",
    what: "NEGATIVE CONTROL: rename the local `matches` in the scan",
    file: CORE,
    find: "      const matches: RunPaths[] = [];\n      for (const run of candidates) {\n        if (await input.hasWorker(run, worker)) matches.push(run);\n      }\n      if (matches.length === 1) {\n        runs.set(worker, matches[0]!);\n        continue;\n      }\n      if (matches.length > 1) {\n        ambiguous.set(\n          worker,\n          matches.map((r) => r.runId),\n        );\n      }",
    replace: "      const holders: RunPaths[] = [];\n      for (const run of candidates) {\n        if (await input.hasWorker(run, worker)) holders.push(run);\n      }\n      if (holders.length === 1) {\n        runs.set(worker, holders[0]!);\n        continue;\n      }\n      if (holders.length > 1) {\n        ambiguous.set(\n          worker,\n          holders.map((r) => r.runId),\n        );\n      }",
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
    const child = spawn("bun", ["test", TESTFILE], { cwd: W });
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
  let bad = "";
  for (const extra of m.also ?? []) {
    const f = extra.file ?? m.file;
    const cur = readFileSync(f, "utf8");
    const n = cur.split(extra.find).length - 1;
    if (n !== 1) {
      bad = `secondary anchor matched ${n}x`;
      break;
    }
    writeFileSync(f, cur.replace(extra.find, extra.replace));
  }
  if (bad !== "") {
    process.stdout.write(`${m.id} | ${m.what} | ${bad} — NOT APPLIED\n`);
    findings += 1;
    restore();
    continue;
  }
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
