/**
 * Transcript and harvest, end to end: real files, real state.json, and the
 * real CLI spawned as a subprocess (the thing a caller observes is stdout
 * plus the integer, and importing the command functions would test neither).
 *
 * Every test names the production change that would make it fail. The CLI is
 * pointed at a scratch runs root via PIFLEET_RUNS_DIR — the same seam the
 * production `runsRoot()` honours.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { TranscriptReader } from "../../src/harvest/transcript.ts";
import { EXIT, type WorkerState } from "../../src/contracts.ts";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function runCli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PIFLEET_RUNS_DIR: root },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

// --- fixtures --------------------------------------------------------------

const TS = "2026-07-27T00:00:00.000Z";
const RUN_ID = "2026-07-27T00-00-00Z-ha11";

function header(id = "sess-1"): object {
  return { type: "session", version: 3, id, timestamp: TS, cwd: "/workspace" };
}

function user(id: string, parentId: string | null, content: string): object {
  return { type: "message", id, parentId, timestamp: TS, message: { role: "user", content, timestamp: 0 } };
}

function assistant(
  id: string,
  parentId: string | null,
  opts: { text?: string; stopReason?: string; input?: number; output?: number } = {},
): object {
  return {
    type: "message", id, parentId, timestamp: TS,
    message: {
      role: "assistant",
      content: [{ type: "text", text: opts.text ?? "ok" }],
      api: "openai", provider: "omlx", model: "qwen3",
      usage: {
        input: opts.input ?? 100, output: opts.output ?? 50, cacheRead: 0, cacheWrite: 0,
        totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: opts.stopReason ?? "stop",
      timestamp: 0,
    },
  };
}

function jsonl(...records: object[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

interface Fixture {
  root: string;
  runId: string;
  sessionPath: (worker: string) => string;
  addWorker: (worker: string, patch: Partial<WorkerState>) => Promise<void>;
}

async function makeRun(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-int-"));
  dirs.push(root);
  const run = runPaths(RUN_ID, root);
  await writeJsonAtomic(run.runJson, { schema: "pifleet.run/v1", run_id: RUN_ID });
  await mkdir(run.sessionsDir, { recursive: true });
  return {
    root,
    runId: RUN_ID,
    sessionPath: (worker) => join(run.sessionsDir, `${TS.replace(/[:.]/g, "-")}_${worker}.jsonl`),
    addWorker: async (worker, patch) => {
      const state = {
        ...initialWorkerState({ worker, runId: RUN_ID, pid: 1, pgid: 1, startedAt: TS }),
        ...patch,
      };
      await writeWorkerState(workerPaths(run, worker), state);
    },
  };
}

// --- transcript ------------------------------------------------------------

describe("pifleet transcript", () => {
  test("default output is A4 verbatim — the bytes Pi wrote", async () => {
    const fx = await makeRun();
    const sp = fx.sessionPath("eng-1");
    const raw = jsonl(header(), user("000000aa", null, "hi"), assistant("000000ab", "000000aa", {}));
    await writeFile(sp, raw);
    await fx.addWorker("eng-1", { session_path: sp, session_present: true });

    const r = await runCli(fx.root, ["transcript", "--worker", "eng-1", "--run", fx.runId]);
    expect(r.code).toBe(EXIT.SUCCESS);
    // Byte-equality, not shape-equality: fails if the command starts
    // re-serializing parsed records, which is a second opinion, not A4.
    expect(r.stdout).toBe(raw);
  });

  test("--json parses the transcript through the harvest reader", async () => {
    const fx = await makeRun();
    const sp = fx.sessionPath("eng-1");
    await writeFile(
      sp,
      jsonl(header(), user("000000aa", null, "hi"), assistant("000000ab", "000000aa", { input: 200, output: 80 })),
    );
    await fx.addWorker("eng-1", { session_path: sp, session_present: true });

    const r = await runCli(fx.root, ["transcript", "--worker", "eng-1", "--run", fx.runId, "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const d = JSON.parse(r.stdout) as {
      schema: string; entry_count: number; usage: { input_tokens: number }; entries: unknown[];
    };
    // Fails if the command stops using the production reader/fold — these
    // numbers come from TranscriptReader and the A4 usage aggregation, and a
    // reimplementation would have to get every one right independently.
    expect(d.schema).toBe("pifleet.transcript/v1");
    expect(d.entry_count).toBe(2);
    expect(d.entries).toHaveLength(2);
    expect(d.usage.input_tokens).toBe(200);
  });

  // ISC-101
  test("--html writes an openable, escaped file with no live supervisor", async () => {
    const fx = await makeRun();
    const sp = fx.sessionPath("eng-1");
    await writeFile(
      sp,
      jsonl(
        header(),
        user("000000aa", null, "run this"),
        assistant("000000ab", "000000aa", { text: "injecting <script>alert(1)</script> now" }),
      ),
    );
    await fx.addWorker("eng-1", { session_path: sp, session_present: true });
    const out = join(fx.root, "t.html");

    // No supervisor is running, so the export_html RPC path cannot answer —
    // this IS the harvest case: the worker that most needs exporting is dead.
    // Fails if the RPC failure aborts instead of falling back to the local
    // render (ISC-101 would then only hold for live workers).
    const r = await runCli(fx.root, [
      "transcript", "--worker", "eng-1", "--run", fx.runId, "--html", out, "--json",
    ]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(JSON.parse(r.stdout)).toMatchObject({ html: out, source: "local" });

    const html = await Bun.file(out).text();
    // Openable: a real document, not a fragment.
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    // Escaped: transcript content is worker-authored and worker-authored
    // prose is data, never markup (SRD §12.6). Fails if the renderer stops
    // escaping — the worker's <script> would land in the page executable.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("a worker id that names nothing exits 2, never 0", async () => {
    const fx = await makeRun();
    // The ISC-177 lesson relearned here: fails if resolveWorker starts
    // treating a missing state.json as an empty-but-successful read — an
    // orchestrator that typo'd a worker id would read silence as success.
    const r = await runCli(fx.root, ["transcript", "--worker", "ghost", "--run", fx.runId]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("ghost");
    expect(r.stderr).not.toContain("at async"); // diagnosis, not a stack trace
  });

  test("transcript without --worker is a usage error", async () => {
    const fx = await makeRun();
    const r = await runCli(fx.root, ["transcript", "--run", fx.runId]);
    expect(r.code).toBe(EXIT.USAGE);
  });
});

// --- the live-file scenario ------------------------------------------------

describe("a real file appended to and rewritten underneath the reader", () => {
  test("appends arrive incrementally; a rewrite is re-read from zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-live-"));
    dirs.push(dir);
    const path = join(dir, "live.jsonl");

    // Phase 1: initial content.
    await writeFile(path, jsonl(header(), user("000000aa", null, "start")));
    const reader = new TranscriptReader(path);
    await reader.poll();
    expect(reader.entries.map((e) => e.id)).toEqual(["000000aa"]);

    // Phase 2: an append lands whole. Positive signal: the new id — not a
    // timer racing the write, which was a forbidden Phase 1 pattern.
    await appendFile(path, `${JSON.stringify(assistant("000000ab", "000000aa", {}))}\n`);
    await reader.poll();
    expect(reader.entries.map((e) => e.id)).toEqual(["000000aa", "000000ab"]);

    // Phase 3: an append lands TORN — half a record, no terminator. The poll
    // must return nothing new and hold the fragment (ISC-97). Fails if the
    // reader hands the fragment to JSON.parse (malformed would tick) or
    // drops it (the completed record below would never parse).
    const third = JSON.stringify(user("000000ac", "000000ab", "more"));
    await appendFile(path, third.slice(0, 20));
    await reader.poll();
    expect(reader.entries).toHaveLength(2);
    expect(reader.malformed).toBe(0);

    await appendFile(path, `${third.slice(20)}\n`);
    await reader.poll();
    expect(reader.entries.map((e) => e.id)).toEqual(["000000aa", "000000ab", "000000ac"]);

    // Phase 4: Pi rewrites the file wholesale (migration/session switch) —
    // same path, new header, fewer bytes. Fails if TailReader resumes from
    // the stale offset (new entry unseen, or a fragment surfaced as a line)
    // or if the store keeps the dead entries alongside the new (ISC-100).
    await writeFile(path, jsonl(header("sess-2"), user("bbbb0001", null, "reborn")));
    await reader.poll();
    expect(reader.entries.map((e) => e.id)).toEqual(["bbbb0001"]);
    expect(reader.header?.["id"]).toBe("sess-2");
    expect(reader.malformed).toBe(0);
  });
});

// --- harvest --reconstruct -------------------------------------------------

describe("pifleet harvest --reconstruct", () => {
  test("a worker killed before result.json still yields a verdict (ISC-91)", async () => {
    const fx = await makeRun();
    const sp = fx.sessionPath("eng-2");
    await writeFile(
      sp,
      jsonl(
        header(),
        user("000000aa", null, "fix the bug"),
        assistant("000000ab", "000000aa", { input: 300, output: 120, text: "edited src/x.ts" }),
      ),
    );
    // The supervisor's persisted stats claim MORE input than the transcript
    // (a compaction can hide transcript tokens) and LESS output.
    await fx.addWorker("eng-2", {
      session_path: sp,
      session_present: true,
      task_id: "T-9",
      epoch: 3,
      usage: { input_tokens: 1_000, output_tokens: 10, usd: 0, priced: false },
    });

    const r = await runCli(fx.root, ["harvest", "--reconstruct", "--worker", "eng-2", "--run", fx.runId, "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const d = JSON.parse(r.stdout) as Record<string, unknown> & {
      usage: { input_tokens: number; output_tokens: number; priced: boolean };
    };
    expect(d["schema"]).toBe("pifleet.reconstruction/v1");
    expect(d["task_id"]).toBe("T-9");
    expect(d["epoch"]).toBe(3);
    expect(d["harvest_status"]).toBe("complete");
    // A clean stop is unknown — the lattice identity — so the repository's
    // derived facts carry the final verdict and the missing envelope
    // downgrades nothing (ISC-94). Fails if a clean ending maps to failed
    // (invented evidence) or success (unprovable from a transcript).
    expect(d["verdict"]).toBe("unknown");
    // A6 merge is element-wise max across both sources (ISC-115: an
    // under-count feeding a token ceiling never trips). Fails if the command
    // prefers one source or sums them.
    expect(d.usage.input_tokens).toBe(1_000);
    expect(d.usage.output_tokens).toBe(120);
    expect(d["tokens_total"]).toBe(1_120);
    expect(d.usage.priced).toBe(false);
  });

  test("an aborted transcript reconstructs as aborted through the CLI", async () => {
    const fx = await makeRun();
    const sp = fx.sessionPath("eng-3");
    await writeFile(
      sp,
      jsonl(header(), user("000000aa", null, "go"), assistant("000000ab", "000000aa", { stopReason: "aborted" })),
    );
    await fx.addWorker("eng-3", { session_path: sp, session_present: true });

    const r = await runCli(fx.root, ["harvest", "--reconstruct", "--worker", "eng-3", "--run", fx.runId, "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    // Pins the CLI to the production reconstruct(): fails if the command
    // stops consulting stopReason and reports every transcript as unknown.
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: "aborted" });
  });

  // ISC-96 — the two absent cases must be DIFFERENT facts in the payload.
  test("died-before-first-message and wrong-path are distinguishable", async () => {
    const fx = await makeRun();
    const absent = fx.sessionPath("gone");
    await fx.addWorker("w-never", { session_path: absent, session_present: false });
    await fx.addWorker("w-wrong", { session_path: absent, session_present: true });

    const never = await runCli(fx.root, ["harvest", "--reconstruct", "--worker", "w-never", "--run", fx.runId, "--json"]);
    const wrong = await runCli(fx.root, ["harvest", "--reconstruct", "--worker", "w-wrong", "--run", fx.runId, "--json"]);
    // A pure read (§8.4): both emitted valid output, both exit 0, and the
    // trustworthiness lives in the payload, not the integer.
    expect(never.code).toBe(EXIT.SUCCESS);
    expect(wrong.code).toBe(EXIT.SUCCESS);

    const dNever = JSON.parse(never.stdout) as { presence: string; reasons: string[]; harvest_status: string };
    const dWrong = JSON.parse(wrong.stdout) as { presence: string; reasons: string[]; harvest_status: string };
    // Fails if classifySession stops reading session_present — the two
    // workers differ in NOTHING else, so any collapse makes these equal.
    expect(dNever.presence).toBe("never_created");
    expect(dWrong.presence).toBe("missing_after_present");
    expect(dNever.presence).not.toBe(dWrong.presence);
    expect(dNever.reasons.join(" ")).toContain("died_before_first_assistant_message");
    expect(dWrong.reasons.join(" ")).toContain("missing_at_recorded_path");
    expect(dNever.harvest_status).toBe("unavailable");
  });

  test("harvest without --reconstruct is a usage error", async () => {
    const fx = await makeRun();
    await fx.addWorker("eng-1", {});
    const r = await runCli(fx.root, ["harvest", "--worker", "eng-1", "--run", fx.runId]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--reconstruct");
  });
});
