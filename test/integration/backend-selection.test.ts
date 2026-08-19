/**
 * Backend selection and fallback through the REAL CLI (ISC-131).
 *
 * The property under test is visibility. `--backend` picks what the operator
 * watches; when the primary cannot present, the run must either land on the
 * named fallback AND SAY SO — stderr for the terminal, ledger for the durable
 * record — or refuse with exit 3 and a named diagnosis. The failure modes this
 * file exists to catch are both silent: a fallback nothing announced (the
 * operator watches panes they believe are cmux), and a downgrade to headless
 * nothing asked for (six panes requested, none delivered, nothing said).
 *
 * cmux is made unavailable with a PATH shim, the way up-wiring.test.ts shims
 * docker: a `cmux` that answers `--version` and `--help` like the real 0.64.20
 * but refuses `ping`. That drives the probe through its full sequence — binary
 * present, commands present, socket dead — so the diagnosis under test is the
 * one a real dead cmux produces, not a degenerate exec failure. The shim fails
 * loudly on unexpected argv rather than absorbing a changed invocation.
 *
 * tmux (the fallback) is REAL — 3.6a is installed — and every fleet gets a
 * private TMUX_TMPDIR so its default-socket server can never collide with the
 * developer's tmux or a concurrent test run. (This repo has been bitten by
 * suites sharing a socket path; a per-rig tmpdir makes collision structurally
 * impossible.) mkdtemp under os.tmpdir(), not a deep scratch path: the socket
 * lives at $TMUX_TMPDIR/tmux-$UID/default and macOS caps sun_path at ~104
 * bytes — a long tmpdir fails as "File name too long".
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { runPaths } from "../../src/run/paths.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

interface Rig {
  base: string;
  /** PIFLEET_RUNS_DIR. */
  root: string;
  /** Private tmux socket directory — this rig's server and nobody else's. */
  tmuxTmp: string;
  /** PATH-prepended shim directory. */
  bin: string;
  env: Record<string, string>;
}

const rigs: Rig[] = [];
afterAll(async () => {
  for (const rig of rigs) {
    // Down every run the rig started — including runs from a FAILED `up`,
    // which print no run id but have already launched the detached daemon.
    // Skipping those would leak a daemon process per test run.
    for (const runId of await readdir(rig.root).catch(() => [] as string[])) {
      await cli(rig, ["down", "--run", runId, "--json"]).catch(() => {});
    }
    // Kill this rig's private tmux server even when a test failed mid-way;
    // real tmux is not on the shimmed PATH inside every rig, so call it by
    // name from the test process with the rig's socket dir.
    await Bun.spawn(["tmux", "kill-server"], {
      env: { ...process.env, TMUX_TMPDIR: rig.tmuxTmp },
      stdout: "ignore",
      stderr: "ignore",
    }).exited.catch(() => {});
    await rm(rig.base, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * A `cmux` whose socket is dead: `--version` and `--help` answer like the
 * probed 0.64.20 (all REQUIRED_COMMANDS listed, `read-screen` present), and
 * `ping` fails. The probe therefore reaches its socket-liveness step and
 * fails THERE — the diagnosis of a cmux that is installed but not running,
 * which is the shape ISC-131's exit-3 contract was written for.
 */
async function writeDeadSocketCmuxShim(bin: string): Promise<void> {
  const shim = join(bin, "cmux");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "cmux 0.64.20" ;;',
      "  --help)",
      '    echo "Commands: ping capabilities identify workspace new-split list-panes focus-pane respawn-pane read-screen"',
      "    ;;",
      "  ping)",
      '    echo "connection refused" >&2',
      "    exit 1",
      "    ;;",
      "  *)",
      // Loud on anything else: a probe that started issuing new verbs against
      // a dead socket should surface here, not be absorbed by a catch-all 0.
      '    echo "cmux shim: unexpected argv: $*" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
}

/** A `tmux` that cannot even report its version — the fallback's probe fails. */
async function writeBrokenTmuxShim(bin: string): Promise<void> {
  const shim = join(bin, "tmux");
  await writeFile(shim, ["#!/bin/sh", 'echo "tmux shim: broken on purpose" >&2', "exit 1", ""].join("\n"));
  await chmod(shim, 0o755);
}

async function makeRig(): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-sel-"));
  const root = join(base, "runs");
  const tmuxTmp = join(base, "tmux");
  const bin = join(base, "bin");
  await mkdir(root, { recursive: true });
  await mkdir(tmuxTmp, { recursive: true });
  await mkdir(bin, { recursive: true });
  const rig: Rig = {
    base,
    root,
    tmuxTmp,
    bin,
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}`,
      TMUX_TMPDIR: tmuxTmp,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
  };
  rigs.push(rig);
  return rig;
}

async function cli(
  rig: Rig,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...rig.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

/** `tmux has-session` against the rig's PRIVATE server, bypassing rig PATH shims. */
async function hasSession(rig: Rig, session: string): Promise<boolean> {
  const p = Bun.spawn(["tmux", "has-session", "-t", `=${session}`], {
    env: { ...process.env, TMUX_TMPDIR: rig.tmuxTmp },
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await p.exited) === 0;
}

describe("ISC-131: fallback lands on tmux and the switch is VISIBLE", () => {
  test(
    "cmux dead + --backend-fallback tmux: run succeeds on tmux, announced on stderr AND in the ledger, before any supervisor",
    async () => {
      const rig = await makeRig();
      await writeDeadSocketCmuxShim(rig.bin);

      const up = await cli(rig, [
        "up",
        "--workers",
        "eng-1",
        "--backend",
        "cmux",
        "--backend-fallback",
        "tmux",
        "--json",
      ]);
      // The fleet came up — an unavailable PRIMARY with a healthy fallback is
      // a working run, not a failure.
      expect(up.code).toBe(EXIT.SUCCESS);
      const runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;

      // The operator's terminal was told. Both halves matter: the reason the
      // primary failed (so they can fix cmux) and where the run actually went
      // (so they stop staring at cmux waiting for panes).
      expect(up.stderr).toContain("WARNING: backend 'cmux' unavailable");
      expect(up.stderr).toContain("cmux-socket");
      expect(up.stderr).toContain("falling back to 'tmux'");

      // The durable record was told, with the diagnosis attached. A stderr
      // line scrolls away; the ledger is what a post-mortem reads.
      const { records, errors } = await mergeLedger(runPaths(runId, rig.root));
      expect(errors).toEqual([]);
      const cliUp = records.filter((r) => r.actor === "cli-up").sort((a, b) => a.seq - b.seq);

      const fallback = cliUp.find((r) => r.event === "backend_fallback");
      expect(fallback).toBeDefined();
      expect(fallback!.detail?.["from"]).toBe("cmux");
      expect(fallback!.detail?.["to"]).toBe("tmux");
      // The event must carry WHY, not merely THAT: an empty reasons array is
      // a fallback nobody can explain afterwards.
      const reasons = fallback!.detail?.["reasons"] as Array<{ name: string }>;
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons[0]?.name).toBe("cmux-socket");

      // `backend_ready` states what the run is actually presenting on. If it
      // said `active: "cmux"` here, every later reader of the ledger would be
      // lied to in exactly the way the operator no longer is.
      const ready = cliUp.find((r) => r.event === "backend_ready");
      expect(ready).toBeDefined();
      expect(ready!.detail?.["requested"]).toBe("cmux");
      expect(ready!.detail?.["active"]).toBe("tmux");
      expect(ready!.detail?.["fell_back"]).toBe(true);

      // Order: the switch is on the record BEFORE the first supervisor exists.
      // A fallback announced after launch is an announcement racing the thing
      // it announces.
      const firstSup = cliUp.find((r) => r.event === "supervisor_launched");
      expect(firstSup).toBeDefined();
      expect(fallback!.seq).toBeLessThan(firstSup!.seq);
      expect(ready!.seq).toBeLessThan(firstSup!.seq);

      // And the run really LANDED on tmux: the session exists on this rig's
      // private server. Without this, everything above could be satisfied by
      // bookkeeping around a silent headless downgrade.
      expect(await hasSession(rig, `pifleet-${runId}`)).toBe(true);

      const down = await cli(rig, ["down", "--run", runId, "--json"]);
      expect(down.code).toBe(EXIT.SUCCESS);
    },
    // ISC-266 audit: stands. Two spawns (`up`, then `down`) derive
    // cliBudget(2) = 22_800 ms; measured idle is 1516-1741 ms. Not reduced.
    90_000,
  );
});

describe("ISC-131: an unavailable primary with NO fallback refuses, loudly", () => {
  test(
    "cmux dead, no --backend-fallback: exit 3 with the named diagnosis, no supervisors, no silent downgrade",
    async () => {
      const rig = await makeRig();
      await writeDeadSocketCmuxShim(rig.bin);

      const up = await cli(rig, ["up", "--workers", "eng-1", "--backend", "cmux", "--json"]);

      // Exit 3 — BACKEND_UNAVAILABLE on the §10 ladder. Not 0 (a silent
      // headless downgrade would exit 0) and not 1 (an undiagnosed crash).
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);

      // The diagnosis is NAMED: which backend, which probed capability, and
      // that no fallback was configured. "backend unavailable" alone sends the
      // operator off to disable the backend; naming `cmux-socket` sends them
      // to start cmux. (The resolver surfaces the failed CAPABILITY name; the
      // DIAG constants in backends/cmux/capabilities.ts surface on the
      // ensureWorkspace path — see the phase report.)
      expect(up.stderr).toContain("backend 'cmux' unavailable");
      expect(up.stderr).toContain("cmux-socket");
      expect(up.stderr).toContain("no --backend-fallback");

      // No fleet pretended to start: no run id on stdout…
      expect(up.stdout).not.toContain("run_id");

      // …and the run directory that `up` had already created holds no
      // supervisors and no backend_ready claim. A `backend_ready` here — any
      // `active` at all — would BE the silent downgrade this test forbids.
      const runIds = await readdir(rig.root);
      for (const runId of runIds) {
        const run = runPaths(runId, rig.root);
        expect(await readdir(run.workersDir)).toEqual([]);
        const { records } = await mergeLedger(run);
        const events = records.map((r) => r.event);
        expect(events).not.toContain("backend_ready");
        expect(events).not.toContain("backend_fallback");
        expect(events).not.toContain("supervisor_launched");
      }

      // Nothing quietly went to tmux either: this rig's private tmux tmpdir
      // has no server, so no session of any name exists.
      const ls = Bun.spawn(["tmux", "ls"], {
        env: { ...process.env, TMUX_TMPDIR: rig.tmuxTmp },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await ls.exited).not.toBe(0);
    },
    90_000,
  );

  test(
    "cmux dead AND tmux broken: exit 3 names BOTH diagnoses",
    async () => {
      // "cmux down, so we tried tmux, also down" is a much faster morning
      // than "backend unavailable" — the resolver promises both names.
      const rig = await makeRig();
      await writeDeadSocketCmuxShim(rig.bin);
      await writeBrokenTmuxShim(rig.bin);

      const up = await cli(rig, [
        "up",
        "--workers",
        "eng-1",
        "--backend",
        "cmux",
        "--backend-fallback",
        "tmux",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(up.stderr).toContain("backend 'cmux' unavailable");
      expect(up.stderr).toContain("fallback 'tmux' also unavailable");
      expect(up.stdout).not.toContain("run_id");
    },
    90_000,
  );
});

describe("unknown backend kinds are usage errors, refused before any side effect", () => {
  test("unknown --backend exits 2 and creates no run", async () => {
    const rig = await makeRig();
    const up = await cli(rig, ["up", "--workers", "eng-1", "--backend", "screen", "--json"]);
    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("unknown backend 'screen'");
    // Validation precedes the run directory: a rejected kind must not leave a
    // half-born run for `status`/`down` to trip over. (The kind is also an
    // import-specifier ingredient in the registry — refusing it at the CLI
    // edge is the first fence in front of that.)
    expect(await readdir(rig.root)).toEqual([]);
  });

  test("unknown --backend-fallback exits 2 even when the primary is valid", async () => {
    const rig = await makeRig();
    const up = await cli(rig, [
      "up",
      "--workers",
      "eng-1",
      "--backend",
      "headless",
      "--backend-fallback",
      "screen",
      "--json",
    ]);
    // The fallback kind is validated UP FRONT, not lazily at first use — a
    // bogus fallback discovered only when the primary dies would turn a
    // recoverable morning into an unrecoverable one at the worst moment.
    expect(up.code).toBe(EXIT.USAGE);
    expect(up.stderr).toContain("unknown fallback backend 'screen'");
    expect(await readdir(rig.root)).toEqual([]);
  });
});
