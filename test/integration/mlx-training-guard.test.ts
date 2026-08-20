/**
 * The MLX training guard against the REAL host process list (ISC-56).
 *
 * `test/unit/mlx-training-guard.test.ts` proves the parser exhaustively from
 * canned strings, which is the right place for the pattern work — but every one
 * of those strings was written by the same person who wrote the patterns. If
 * `ps -axo pid=,command=` does not emit what this code believes it emits, the
 * whole unit file agrees with itself and the guard finds nothing on a real
 * machine. That is the failure mode a heuristic can least afford: it looks
 * exactly like "no training run is active".
 *
 * So both cases here run against a genuinely spawned process and the real `ps`:
 *
 *  1. A training-shaped command line IS found.
 *  2. The oMLX INFERENCE server's command line is NOT found.
 *
 * The second is the one worth the file. A fleet requires `mlx_lm.server` to be
 * running, so a guard that matched it would refuse every `up` on every
 * correctly configured host — turning a safety feature into a total outage. The
 * unit suite asserts that against a string; this asserts it against a process
 * that really exists in a real process table.
 *
 * No gate. This needs no Docker, no oMLX, no GPU and no model weights — just
 * `/bin/sh` and a `ps` that supports `-axo`, which is true of macOS and of the
 * Linux runners CI uses. A guard whose live proof only ran on the author's
 * laptop would be a guard nothing checks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMlxTrainingGuard,
  detectActiveMlxTraining,
  listHostProcesses,
} from "../../src/safety/mlx-training-guard.ts";
import { cliBudget } from "../support/budget.ts";

const bases: string[] = [];
const running: { kill: () => void; exited: Promise<number> }[] = [];

afterAll(async () => {
  /**
   * Reaped, not merely signalled, and before the scratch dirs go.
   *
   * A zombie keeps its command line in `ps`. A leaked decoy would therefore
   * make the ISC-56 guard fire for every later `up` on this machine — including
   * other test files, and including the developer's own shell long after the
   * suite exits. This teardown is the only thing standing between a decoy and
   * that, so it runs unconditionally rather than per-test.
   */
  for (const p of running) {
    p.kill();
    await p.exited.catch(() => 0);
  }
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * Spawn a real process whose command line has the given basename.
 *
 * The trick is the shebang: exec'ing `<dir>/<name> --flags` makes the kernel
 * run `/bin/sh <dir>/<name> --flags`, so the script's NAME lands in argv where
 * `ps` will report it. That reproduces the shape of a real `mlx_lm.lora` run
 * without any of its substance.
 *
 * The script body sleeps rather than `exec sleep`: `exec` would REPLACE the
 * argv with a bare `sleep`, the decoy would stop resembling anything, and both
 * tests below would pass for the wrong reason — the positive one by never
 * finding its target and the negative one by having nothing to not-find.
 */
async function spawnDecoy(name: string, args: string[]): Promise<{ pid: number }> {
  // The scratch prefix deliberately avoids the string "mlx": the guard matches
  // on the whole command line, so a path component could otherwise supply the
  // match and a test would certify a pattern that never fired on the argv.
  const base = await mkdtemp(join(tmpdir(), "pifleet-trainguard-"));
  bases.push(base);
  const script = join(base, name);
  /**
   * 30s, not 300. `afterAll` reaps these, but a SIGKILLed test RUN never gets
   * to `afterAll` — and an orphan whose command line is literally `mlx_lm.lora`
   * makes the ISC-56 guard refuse every `up` on the developer's own machine
   * until it exits. Five minutes of that is a self-inflicted outage on the one
   * host this project is developed on; 30 seconds still outlives any test here
   * by an order of magnitude.
   */
  await writeFile(script, "#!/bin/sh\nsleep 30\n");
  await chmod(script, 0o755);
  const proc = Bun.spawn([script, ...args], { stdout: "ignore", stderr: "ignore" });
  running.push({ kill: () => proc.kill("SIGKILL"), exited: proc.exited });

  /**
   * Wait until the real `ps` can see it. `Bun.spawn` returns once the child
   * exists, which is not the same instant the process table publishes its
   * argv — polling `ps` itself, rather than sleeping a hopeful interval, is
   * what keeps this deterministic on a loaded machine.
   */
  const deadline = Date.now() + 15_000;
  for (;;) {
    const listed = await listHostProcesses();
    if (new RegExp(`^\\s*${proc.pid}\\s`, "m").test(listed)) break;
    if (Date.now() > deadline) throw new Error(`decoy pid ${proc.pid} never appeared in ps output`);
    await Bun.sleep(50);
  }
  return { pid: proc.pid };
}

describe("the guard reads the real host process list (ISC-56)", () => {
  test(
    "a genuinely running training-shaped process is detected end to end",
    async () => {
      const decoy = await spawnDecoy("mlx_lm.lora", [
        "--model",
        "Qwen3-8B",
        "--train",
        "--data",
        "./corpus",
      ]);
      // The whole path: real `ps`, real output format, real parse.
      const hits = await checkMlxTrainingGuard();
      const mine = hits.find((h) => h.pid === decoy.pid);
      expect(mine).toBeDefined();
      // And it captured the command line, not just the pid — the refusal
      // message shows this string to the operator.
      expect(mine!.command).toContain("mlx_lm.lora");
      expect(mine!.command).toContain("--train");
    },
    cliBudget(1),
  );

  test(
    "the oMLX INFERENCE server is not mistaken for a training run",
    async () => {
      const server = await spawnDecoy("mlx_lm.server", [
        "--port",
        "8000",
        "--model",
        "gemma-4-26b-a4b-it-4bit",
      ]);
      const listed = await listHostProcesses();
      // Precondition: `ps` really is showing this process, so a pass below is
      // "the patterns rejected it" and never "the scan missed it entirely".
      expect(new RegExp(`^\\s*${server.pid}\\s.*mlx_lm\\.server`, "m").test(listed)).toBe(true);

      const hits = detectActiveMlxTraining(listed);
      expect(hits.find((h) => h.pid === server.pid)).toBeUndefined();
    },
    cliBudget(1),
  );

  /**
   * The oMLX negative, made non-trivial.
   *
   * The test above spawns `mlx_lm.server --port 8000 --model gemma-…`, whose
   * command line contains no training entry point at all — so it passed under
   * the ORIGINAL substring matcher too, and could only ever have failed if
   * someone added a bare `/mlx/` pattern. It pinned the pattern list; it was
   * not evidence the matcher discriminates.
   *
   * This is the case that discriminates. Serving a fine-tune means pointing the
   * inference server at the directory the training run wrote, and that
   * directory is conventionally named for the entry point that produced it — so
   * the command line of a perfectly healthy oMLX contains the exact string
   * `mlx_lm.lora`. Verified MATCHING before the fix, against a real process in a
   * real process table: the guard refused every `up` on a host doing exactly
   * what the fleet requires.
   */
  test(
    "an inference server SERVING a LoRA adapter is not mistaken for training it",
    async () => {
      const server = await spawnDecoy("mlx_lm.server", [
        "--port",
        "8000",
        "--model",
        "gemma-4-26b-a4b-it-4bit",
        "--adapter-path",
        "/Users/dan/out/mlx_lm.lora",
      ]);
      const listed = await listHostProcesses();
      // Precondition, and the whole point: the training entry point's name IS
      // on this line. A pass below is the matcher rejecting a string it can
      // see, never the string being absent.
      expect(new RegExp(`^\\s*${server.pid}\\s.*mlx_lm\\.lora`, "m").test(listed)).toBe(true);

      expect(detectActiveMlxTraining(listed).find((h) => h.pid === server.pid)).toBeUndefined();
    },
    cliBudget(1),
  );

  /**
   * `ps` output is only useful if it parses. A format change (or a platform
   * whose `ps` ignores `-axo`) would yield zero matches forever — a guard that
   * silently never fires — so the parse is checked against the one process
   * certain to be present: this one.
   */
  test("the ps format the guard requests actually parses", async () => {
    const listed = await listHostProcesses();
    expect(listed.length).toBeGreaterThan(0);
    const lines = listed.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
    // Every line must be `<pid> <command>`; a header row would break this, which
    // is why `pid=,command=` suppresses it.
    const parseable = lines.filter((l) => /^\s*\d+\s+\S/.test(l));
    expect(parseable.length).toBe(lines.length);
    // The test runner itself is in there, which proves the pid column is real.
    expect(new RegExp(`^\\s*${process.pid}\\s`, "m").test(listed)).toBe(true);
  }, 30_000);
});
