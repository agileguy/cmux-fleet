/**
 * `docker/entrypoint.sh` installs ONE of two stdin contracts, chosen by
 * `PIFLEET_PANE_MODE` (SRD §3.5, §162).
 *
 * These run the real script under the host's bash with a PIPE on stdin — no
 * daemon, no image — because the property under test is a property of the
 * script's control flow, not of Docker. The tty-side half (a `docker run -t`
 * container, where the tui arm redirects the worker's stdin from `/dev/tty`
 * and the rpc arm hands it a duplicate of fd 0 plus an inherited fd 3) was
 * measured directly against a container and is recorded in the block above the
 * launch in that file; it cannot be reached from a unit test, which has no
 * controlling terminal to offer.
 *
 * What IS reachable here, and is the thing most worth pinning, is that the two
 * arms are actually separate:
 *
 *  - a `tui` worker must never fall through to the RPC plumbing. It refuses,
 *    loudly, and the worker binary is never started at all;
 *  - an `rpc` worker — including every container launched before this variable
 *    existed, which sets nothing — still receives the container's stdin.
 *
 * The second is asserted because it is the regression that would cost most:
 * `pi --mode rpc` IS a JSONL protocol on stdin, so a worker handed /dev/null
 * reads instant EOF and exits, and `up` reports only `worker <id> died during
 * startup`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRYPOINT = join(REPO_ROOT, "docker", "entrypoint.sh");

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Run the entrypoint with a stand-in worker that records what it was handed.
 *
 * `PIFLEET_WORKER_BIN` is the script's own documented test seam, and
 * `test/integration/honeypot.test.ts` drives it the same way. The stand-in
 * writes an evidence file rather than printing, so the assertions do not have
 * to distinguish its output from the supervisor's.
 *
 * HOME is redirected because the script's first act is to find a writable
 * agent directory under it; left alone it would create `~/.pi/agent` on the
 * machine running the suite.
 *
 * `PIFLEET_HONEYPOT` is deliberately NOT set: the listener binds
 * `/var/run/docker.sock`, which exists on a developer's Mac and is not ours to
 * touch. Its absence is a supported configuration — the script says so at the
 * definition of the variable — and the launch below is unaffected by it.
 */
async function runEntrypoint(
  paneMode: string | undefined,
  stdinText: string,
): Promise<{ code: number; stderr: string; evidence: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-entrypoint-"));
  dirs.push(dir);
  const evidence = join(dir, "worker-saw.txt");
  const stand_in = join(dir, "stand-in.sh");
  await writeFile(
    stand_in,
    [
      "#!/bin/sh",
      // `read` returns non-zero at EOF with a partial line, so the status is
      // ignored on purpose: what is being recorded is what arrived, and
      // "nothing arrived" has to be recordable rather than fatal.
      "line=''",
      "read -r line || true",
      `printf 'stdin=%s\\n' "$line" > ${JSON.stringify(evidence)}`,
      "",
    ].join("\n"),
  );
  await chmod(stand_in, 0o755);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    PIFLEET_WORKER_BIN: stand_in,
  };
  if (paneMode !== undefined) env["PIFLEET_PANE_MODE"] = paneMode;

  const p = Bun.spawn(["bash", ENTRYPOINT], {
    env,
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);

  // Polled rather than read once. The supervisor loop at the bottom of the
  // script uses `wait -n -p`, which bash 3.2 — still the /bin/bash on macOS —
  // does not implement, so on that host the script can return before its
  // asynchronous child has finished writing. The deadline is what makes the
  // rpc assertion honest on both hosts instead of quietly host-dependent.
  //
  // Bounded well under bun's 5s per-test default, because the REFUSAL cases
  // wait out the whole window by design — nothing is ever written there — and
  // a deadline at the timeout would turn a passing assertion into a timeout.
  const deadline = Date.now() + 1_500;
  let seen: string | null = null;
  do {
    seen = await readFile(evidence, "utf8").catch(() => null);
    if (seen !== null) break;
    await Bun.sleep(25);
  } while (Date.now() < deadline);

  return { code, stderr, evidence: seen };
}

/**
 * The pane wipe belongs to ONE arm, and which one is a correctness question.
 *
 * A tui worker's pane is a standing surface, so anything the container printed
 * on its way up — the honeypot's `armed at` line, any future startup chatter —
 * would sit above Pi's first draw for the life of the pane. Clearing fixes
 * that. Writing the same escape sequence in the RPC arm would be the defect
 * that already shipped once from this file: an rpc worker's STDOUT IS the JSONL
 * protocol, and one stray sequence ahead of Pi's first message kills the worker
 * during startup with nothing anywhere saying why.
 *
 * READ OUT OF THE SOURCE, and the reason is stated rather than glossed: the tui
 * arm needs a CONTROLLING TERMINAL, which a unit test has none of — every
 * behavioural probe in this file drives the rpc arm or the tui arm's REFUSAL.
 * So this is a shape assertion, and it is the weaker half deliberately: the
 * functional guard on the half that can break a run already exists, in
 * `test/integration/honeypot.test.ts`, which asserts an rpc worker's stdout
 * carries the worker's bytes and NOTHING ELSE with `toBe` rather than
 * `toContain` — an escape sequence leaking into that arm reddens it.
 */
describe("the pane wipe is tui-only", () => {
  const script = readFileSync(ENTRYPOINT, "utf8");

  /**
   * Sliced from the pane-mode `if` OUTWARD, not matched with a regex over the
   * whole file.
   *
   * The first shape of this test used `/\nelse\n([\s\S]*?)\nfi\n/` for the rpc
   * arm and was WRONG: the script has an earlier if/else — the writable
   * agent-dir probe — so the match landed on that block, and a mutation that
   * added a screen clear to the real rpc arm passed. Caught by mutating rather
   * than by reading, which is the only reason it is not still passing.
   */
  const start = script.indexOf('if [ "${PIFLEET_PANE_MODE:-rpc}" = "tui" ]; then');
  const block = script.slice(start);
  const elseAt = block.indexOf("\nelse\n");
  const fiAt = block.indexOf("\nfi\n", elseAt);
  const tuiArm = block.slice(0, elseAt);
  const rpcArm = block.slice(elseAt, fiAt);

  test("the arms were actually located", () => {
    // Without this the two assertions below pass vacuously on empty strings.
    expect(start).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(-1);
    expect(fiAt).toBeGreaterThan(elseAt);
    expect(tuiArm).toContain("/dev/tty");
    expect(rpcArm).toContain("exec 3<&0");
  });

  test("the tui arm clears the terminal before launching the worker", () => {
    expect(tuiArm).toContain("[2J");
    // Aimed at the terminal by NAME, not at stdout — the same one-owner rule
    // that makes the tui arm redirect the worker from /dev/tty.
    expect(tuiArm).toMatch(/\[2J[\s\S]*?> \/dev\/tty/);
  });

  test("the rpc arm writes no escape sequence at all", () => {
    expect(rpcArm).not.toContain("[2J");
    expect(rpcArm).not.toContain("\\033");
  });
});

describe("PIFLEET_PANE_MODE selects the stdin contract (SRD §3.5)", () => {
  /**
   * The refusal, and the assertion that carries the weight: the worker binary
   * is NEVER STARTED. Exit status alone would not distinguish "refused before
   * launching" from "launched, and the worker happened to fail".
   */
  test("a tui worker with no terminal on stdin refuses instead of using the RPC plumbing", async () => {
    const r = await runEntrypoint("tui", "{}\n");
    expect(r.code).toBe(72);
    expect(r.stderr).toContain("PIFLEET_PANE_MODE=tui");
    expect(r.stderr).toContain("no terminal on stdin");
    expect(r.evidence).toBeNull();
  });

  /**
   * 72 rather than 71, because 71 already means "the escape-attempt listener
   * failed to arm" (ISC-125) everywhere else in this script. A shared code
   * would make a TTY misconfiguration read as a security-control failure in
   * the run report.
   */
  test("the tui refusal does not reuse the honeypot's exit code", async () => {
    const r = await runEntrypoint("tui", "");
    expect(r.code).not.toBe(71);
  });

  test("an rpc worker still receives the container's stdin", async () => {
    const r = await runEntrypoint("rpc", "HELLO-RPC\n");
    expect(r.evidence).toBe("stdin=HELLO-RPC\n");
  });

  /**
   * Absence is `rpc`. Every container built before this variable existed sets
   * nothing, and so do `image verify`, the acceptance containers and the
   * honeypot probes — all of which must keep the plumbing they have.
   */
  test("an unset pane mode is rpc, not a refusal", async () => {
    const r = await runEntrypoint(undefined, "HELLO-DEFAULT\n");
    expect(r.code).toBe(0);
    expect(r.evidence).toBe("stdin=HELLO-DEFAULT\n");
  });
});
