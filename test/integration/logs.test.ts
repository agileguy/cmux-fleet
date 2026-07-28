/**
 * `pifleet logs` against a run directory built by hand, through the real CLI.
 *
 * Spawned rather than imported, because the observable contract is the
 * process: the integer it exits with, what lands on stdout versus stderr,
 * and whether SIGTERM ends a follower cleanly. The follow tests are the ones
 * that matter most — `up`'s pane viewer will run exactly this command, and a
 * viewer that dies when the events file does not exist yet reintroduces the
 * race `tail -F` was chosen to avoid.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const LOGS_SRC = new URL("../../src/cli/commands/logs.ts", import.meta.url).pathname;

const RUN_ID = "2026-07-27T00-00-00Z-aaaa";
const WORKER = "sre-1";

interface Fixture {
  root: string;
  eventsPath: string;
  supervisorLog: string;
}

/** A minimal run directory: run.json (latestRunId requires it) + one worker. */
async function makeRun(events: string[] = []): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-logs-"));
  const workerDir = join(root, RUN_ID, "workers", WORKER);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(root, RUN_ID, "run.json"), `${JSON.stringify({ run_id: RUN_ID })}\n`);
  const eventsPath = join(workerDir, "events.jsonl");
  if (events.length > 0) {
    await writeFile(eventsPath, `${events.join("\n")}\n`);
  }
  return { root, eventsPath, supervisorLog: join(workerDir, "supervisor.log") };
}

function runCli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "logs", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PIFLEET_RUNS_DIR: root },
  });
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]).then(
    async ([stdout, stderr]) => ({ code: await p.exited, stdout, stderr }),
  );
}

/** Spawn a follower and capture its stdout incrementally. */
function spawnFollow(root: string, args: string[]) {
  // The CLI DIRECTLY, not `bun run <cli>`. `bun run` is a wrapper process,
  // so `proc.kill("SIGINT")` hit the wrapper rather than the command and the
  // test measured `bun run`'s signal semantics: it reported 130 on Linux
  // while macOS gave 0, so the suite passed locally and failed in CI on a
  // difference that had nothing to do with the code under test. Every other
  // suite in this repo spawns `[process.execPath, CLI, ...]`.
  const p = Bun.spawn([process.execPath, CLI, "logs", "--worker", WORKER, "--follow", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PIFLEET_RUNS_DIR: root },
  });
  let buf = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of p.stdout) buf += decoder.decode(chunk, { stream: true });
  })();
  return {
    proc: p,
    stdout: () => buf,
    stderr: () => new Response(p.stderr).text(),
    drained,
  };
}

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const evt = (rec: Record<string, unknown>) =>
  JSON.stringify({ ts: "2026-07-27T12:00:00.000Z", ...rec });

describe("logs — one-shot", () => {
  test("prints the existing stream verbatim and exits 0", async () => {
    const lines = [evt({ type: "event", seq: 1, event: { type: "agent_start" } }), evt({ type: "settled", task_id: "T-1", epoch: 0, verdict: "success" })];
    const f = await makeRun(lines);
    try {
      const r = await runCli(f.root, ["--worker", WORKER]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toBe(`${lines.join("\n")}\n`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("--json passes raw event objects through unchanged", async () => {
    const lines = [evt({ type: "event", seq: 1, event: { type: "agent_start" } }), evt({ type: "stderr_line", line: "x" })];
    const f = await makeRun(lines);
    try {
      const r = await runCli(f.root, ["--worker", WORKER, "--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      // Unchanged means unchanged: byte-identical lines, each parseable.
      expect(r.stdout).toBe(`${lines.join("\n")}\n`);
      for (const line of r.stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("--json skips a malformed complete line instead of corrupting the stream", async () => {
    const good = [evt({ type: "event", seq: 1, event: { type: "a" } }), evt({ type: "event", seq: 2, event: { type: "b" } })];
    const f = await makeRun([good[0]!, "this is not json", good[1]!]);
    try {
      const r = await runCli(f.root, ["--worker", WORKER, "--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toBe(`${good.join("\n")}\n`);
      expect(r.stderr).toContain("malformed");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a half-written last line is withheld, not emitted or fatal", async () => {
    const whole = evt({ type: "event", seq: 1, event: { type: "agent_start" } });
    const f = await makeRun();
    try {
      // No trailing newline: the record is still being written.
      await writeFile(f.eventsPath, `${whole}\n{"ts":"2026-07-2`);
      const r = await runCli(f.root, ["--worker", WORKER, "--json"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toBe(`${whole}\n`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("--render emits legible lines, not raw JSON, and includes the supervisor log", async () => {
    const f = await makeRun([
      evt({ type: "event", seq: 3, event: { type: "agent_start" } }),
      evt({ type: "settled", task_id: "T-4", epoch: 1, verdict: "partial", reason: "one red" }),
    ]);
    try {
      await writeFile(f.supervisorLog, "supervisor crashed: boom\n");
      const r = await runCli(f.root, ["--worker", WORKER, "--render"]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toContain("12:00:00 event #3 agent_start");
      expect(r.stdout).toContain("T-4");
      expect(r.stdout).toContain("partial");
      expect(r.stdout).toContain("supervisor crashed: boom");
      for (const line of r.stdout.trim().split("\n")) expect(line.startsWith("{")).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("an events file the supervisor has not created yet is empty output, not an error", async () => {
    const f = await makeRun(); // worker dir exists; no events.jsonl
    try {
      const r = await runCli(f.root, ["--worker", WORKER]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toBe("");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("an explicit --run is honoured", async () => {
    const line = evt({ type: "event", seq: 1, event: { type: "agent_start" } });
    const f = await makeRun([line]);
    try {
      const r = await runCli(f.root, ["--worker", WORKER, "--run", RUN_ID]);
      expect(r.code).toBe(EXIT.SUCCESS);
      expect(r.stdout).toBe(`${line}\n`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("logs — refusals", () => {
  test("a worker that does not exist is loud, naming worker and run", async () => {
    const f = await makeRun();
    try {
      const r = await runCli(f.root, ["--worker", "nope-9"]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("nope-9");
      expect(r.stderr).toContain(RUN_ID);
      expect(r.stderr).not.toContain("at async");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a run that does not exist is loud", async () => {
    const f = await makeRun();
    try {
      const r = await runCli(f.root, ["--worker", WORKER, "--run", "2099-01-01T00-00-00Z-ffff"]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("no such run");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("an empty runs root is 'no runs found', exit 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-logs-empty-"));
    try {
      const r = await runCli(root, ["--worker", WORKER]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("no runs found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a path-shaped worker id is refused before any path is joined", async () => {
    const f = await makeRun();
    try {
      const r = await runCli(f.root, ["--worker", "../../etc"]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("invalid worker id");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("--render with --json is a named refusal, not a silent precedence", async () => {
    const f = await makeRun();
    try {
      const r = await runCli(f.root, ["--worker", WORKER, "--render", "--json"]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("mutually exclusive");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("logs — follow", () => {
  test("picks up lines appended after it starts and exits 0 on SIGTERM", async () => {
    const first = evt({ type: "event", seq: 1, event: { type: "agent_start" } });
    const f = await makeRun([first]);
    try {
      const fw = spawnFollow(f.root, []);
      await until(() => fw.stdout().includes(first), "the pre-existing line");

      const second = evt({ type: "event", seq: 2, event: { type: "tool_call" } });
      const third = evt({ type: "settled", task_id: "T-1", epoch: 0, verdict: "success" });
      await appendFile(f.eventsPath, `${second}\n${third}\n`);
      await until(() => fw.stdout().includes(third), "the appended lines");
      expect(fw.stdout()).toContain(second);

      fw.proc.kill("SIGTERM");
      // Clean exit is THE assertion: a follower that dies 143 out of a signal
      // leaves `up`'s pane viewer reporting a crash on every teardown.
      expect(await fw.proc.exited).toBe(0);
      expect(await fw.stderr()).not.toContain("at async");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("waits for an events file that does not exist yet instead of dying", async () => {
    const f = await makeRun(); // no events.jsonl at spawn time
    try {
      const fw = spawnFollow(f.root, []);
      // Give it time to have died if it were going to (tail -f semantics
      // would have): still running is the property under test.
      await Bun.sleep(400);
      let exited = false;
      void fw.proc.exited.then(() => {
        exited = true;
      });
      expect(exited).toBe(false);

      const line = evt({ type: "event", seq: 1, event: { type: "agent_start" } });
      await appendFile(f.eventsPath, `${line}\n`);
      await until(() => fw.stdout().includes(line), "the late-created file's line");

      fw.proc.kill("SIGTERM");
      expect(await fw.proc.exited).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("SIGINT also ends a follower cleanly", async () => {
    const f = await makeRun([evt({ type: "event", seq: 1, event: { type: "agent_start" } })]);
    try {
      const fw = spawnFollow(f.root, ["--render"]);
      await until(() => fw.stdout().length > 0, "first output");
      fw.proc.kill("SIGINT");
      expect(await fw.proc.exited).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

/**
 * Requirement 3, pinned the way ISC-136 pins readScreen: the read-only
 * property of a viewer is the kind that regresses silently — one convenience
 * import of the control client and the pane becomes a channel. The command's
 * source must reference no control socket and no write API, and every module
 * it imports (statically or dynamically) must come from a known read-only
 * set, so the ban cannot be laundered through a helper.
 */
describe("logs is read-only (SRD §3.3)", () => {
  test("the source references no control socket and no write API", async () => {
    const src = await Bun.file(LOGS_SRC).text();
    // Positive control: we are scanning the real implementation.
    expect(src).toContain("TailReader");

    const banned = [
      "controlSock",
      "socketPath",
      "daemonSock",
      "createConnection",
      "net.connect",
      "Bun.connect",
      "Bun.serve",
      "Bun.write",
      "appendJsonl",
      "writeJsonAtomic",
      "writeFile",
      "appendFile",
      "createWriteStream",
      "mkdir",
      "unlink",
      "rename",
      "truncate",
      "chmod",
      "chown",
      "symlink",
      "rmdir",
    ];
    for (const name of banned) {
      expect(src.includes(name), `logs.ts references ${name}`).toBe(false);
    }
  });

  /**
   * The denylist above is necessary and not sufficient, and it leaked.
   *
   * `node:fs/promises` has to be importable — `stat` is how the viewer waits
   * for an events file that does not exist yet — and the denylist named the
   * obvious write verbs while `open` was in neither list. So this passed the
   * whole 17-test suite:
   *
   *   import { open } from "node:fs/promises";
   *   const fh = await open(path, "a");
   *   await fh.write("a viewer wrote this\n");
   *
   * A file handle's `write` is a method, not an imported name, so no
   * name-based ban can see it. That is the same shape as the ISC-137 seam
   * test missing backtick imports: a denylist enumerates the ways you
   * thought of.
   *
   * So the fs surface is an ALLOWLIST of read-only functions. `open` is
   * excluded even though it can be opened read-only, because the mode is an
   * argument and this test reads names — a check that has to interpret
   * arguments to stay correct is one that will eventually be wrong.
   */
  test("only read-only fs functions are imported, by allowlist", async () => {
    const src = await Bun.file(LOGS_SRC).text();
    const READ_ONLY_FS = new Set([
      "stat",
      "lstat",
      "access",
      "readFile",
      "readdir",
      "opendir",
      "realpath",
      "readlink",
    ]);

    // Both forms: the static header and the deferred `await import(...)`
    // destructure the viewer actually uses.
    const bindings: string[] = [];
    const patterns = [
      /import\s*\{([^{}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g,
      /\{([^{}]*)\}\s*=\s*await\s+import\("node:fs(?:\/promises)?"\)/g,
    ];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        for (const raw of m[1]!.split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0]!.trim();
          if (name !== "") bindings.push(name);
        }
      }
    }

    // Positive control: the viewer really does reach for fs, so an empty
    // match set means this test stopped looking rather than found nothing.
    expect(bindings.length).toBeGreaterThan(0);
    for (const name of bindings) {
      expect(READ_ONLY_FS.has(name), `logs.ts imports non-read-only fs function: ${name}`).toBe(
        true,
      );
    }

    // A namespace import would put every fs function one property access
    // away and defeat the allowlist entirely. Both forms are bound to an
    // IDENTIFIER — the destructuring form above is the legitimate one, and a
    // first draft of this check matched it too and failed on clean source.
    expect(/import\s+\*\s+as\s+\w+\s+from\s*["'`]node:fs/.test(src)).toBe(false);
    expect(
      /(?:const|let|var)\s+\w+\s*=\s*await\s+import\(["'`]node:fs(?:\/promises)?["'`]\)/.test(src),
    ).toBe(false);

    /**
     * A viewer that can start a process can do anything a process can — write
     * files, reach the control socket, run git. `Bun.spawn` needs no import
     * at all, so neither the banned-token list nor the module allowlist can
     * see it; it was demonstrated writing into the run directory with the
     * whole suite green.
     */
    for (const spawner of ["Bun.spawn", "Bun.$", "child_process", "execSync", "spawnSync"]) {
      expect(src.includes(spawner), `logs.ts can start a process via ${spawner}`).toBe(false);
    }
  });

  /**
   * The behavioural backstop, and the only check here that is not structurally
   * defeatable.
   *
   * Every source scan enumerates the mechanisms someone thought of. Three
   * separate evasions of the scans above were demonstrated — `fs.open` plus a
   * FileHandle `.write()` (a handle's method is not an imported name, and
   * bare `write` can never be banned because `process.stdout.write` is this
   * command's entire job), a backtick dynamic import, and `Bun.spawn` with a
   * shell redirect — each of which left the suite fully green while `logs`
   * wrote bytes into the run directory.
   *
   * So this asserts the PROPERTY rather than its spelling: run the real
   * command over a real run directory, in every mode, and require the
   * directory to be byte-identical afterwards. It cannot be evaded by
   * choosing a different API, because it never looks at the API.
   */
  test("running logs leaves the run directory byte-identical, in every mode", async () => {
    const lines = [
      evt({ type: "event", seq: 1, event: { type: "agent_start" } }),
      evt({ type: "settled", task_id: "T-1", epoch: 0, verdict: "success" }),
    ];
    const f = await makeRun(lines);
    try {
      await writeFile(f.supervisorLog, "supervisor said something\n");

      /** Every file under the run root, with its exact bytes. */
      const fingerprint = async (): Promise<string> => {
        const { readdir, readFile, stat } = await import("node:fs/promises");
        const out: string[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
            a.name < b.name ? -1 : 1,
          )) {
            const abs = join(dir, e.name);
            const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
            if (e.isDirectory()) {
              out.push(`D ${rel}`);
              await walk(abs, rel);
            } else {
              const [body, st] = await Promise.all([readFile(abs), stat(abs)]);
              out.push(`F ${rel} ${st.size} ${Bun.hash(body).toString(16)}`);
            }
          }
        };
        await walk(f.root, "");
        return out.join("\n");
      };

      const before = await fingerprint();
      // Positive control: the fixture is real, so "identical" is not the
      // trivial equality of two empty listings.
      expect(before).toContain("events.jsonl");

      for (const args of [
        ["--worker", WORKER],
        ["--worker", WORKER, "--json"],
        ["--worker", WORKER, "--render"],
      ]) {
        const r = await runCli(f.root, args);
        expect(r.code).toBe(EXIT.SUCCESS);
      }

      expect(await fingerprint()).toBe(before);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a follower leaves the run directory byte-identical too", async () => {
    const f = await makeRun([evt({ type: "event", seq: 1, event: { type: "agent_start" } })]);
    try {
      const { readdir } = await import("node:fs/promises");
      const namesBefore = (await readdir(join(f.root, RUN_ID, "workers", WORKER))).sort();
      const follower = spawnFollow(f.root, []);
      await until(() => follower.stdout().includes("agent_start"), "the first line");
      await appendFile(f.eventsPath, `${evt({ type: "event", seq: 2, event: { type: "b" } })}\n`);
      await until(() => follower.stdout().includes('"seq":2'), "the appended line");
      follower.proc.kill("SIGTERM");
      await follower.proc.exited;
      // The follow path holds the file open for the whole run — the mode
      // most likely to acquire a "just a small cache file" write later.
      expect((await readdir(join(f.root, RUN_ID, "workers", WORKER))).sort()).toEqual(namesBefore);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("every import resolves to a known read-only module", async () => {
    const src = await Bun.file(LOGS_SRC).text();
    const specifiers = [
      ...[...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!),
      ...[...src.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]!),
    ];
    expect(specifiers.length).toBeGreaterThan(3);
    const allowed = new Set([
      "commander",
      "../index.ts", // CliError + the exit ladder
      "../../contracts.ts", // EXIT, SESSION_ID_RE — constants only
      "../../run/paths.ts", // path computation, no I/O on the write side
      "../../util/jsonl.ts", // TailReader/LineSplitter (reads only are used)
      "node:fs/promises", // stat — existence checks
    ]);
    for (const s of specifiers) {
      expect(allowed.has(s), `unexpected import in logs.ts: ${s}`).toBe(true);
    }
  });
});
