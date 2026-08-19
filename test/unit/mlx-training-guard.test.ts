/**
 * The MLX training guard's parser and patterns (ISC-56, SRD §5.9).
 *
 * `detectActiveMlxTraining` is pure, so every case below is a canned `ps`
 * string — including the ones that are hard to arrange for real, like an
 * inference server and a training run being up simultaneously. The live
 * counterpart (`test/integration/mlx-training-guard.test.ts`) spawns a real
 * process with a matching command line and proves the whole path finds it.
 *
 * The load-bearing test in this file is the oMLX one. A fleet REQUIRES the oMLX
 * inference server (`mlx_lm.server`) to be running, so a guard that matched
 * "mlx" generically would refuse every `up` on a correctly configured host —
 * turning a safety feature into a total outage. That is not a hypothetical
 * failure mode; it is the obvious first implementation.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MLX_TRAINING_PATTERNS,
  PS_ARGV,
  describeMatch,
  detectActiveMlxTraining,
} from "../../src/safety/mlx-training-guard.ts";

/** Real `ps -axo pid=,command=` output shape: right-aligned pid, then argv. */
const REAL_WORLD = [
  "    1 /sbin/launchd",
  "  335 /usr/libexec/logd",
  " 4821 /Applications/Firefox.app/Contents/MacOS/firefox",
  "  902 /bin/zsh -l",
].join("\n");

describe("detectActiveMlxTraining finds training runs", () => {
  test("the dotted module form is caught", () => {
    const out = `${REAL_WORLD}\n 7788 python -m mlx_lm.lora --model Qwen3-8B --train --data ./data`;
    const hits = detectActiveMlxTraining(out);
    expect(hits.length).toBe(1);
    expect(hits[0]!.pid).toBe(7788);
    expect(hits[0]!.command).toContain("mlx_lm.lora");
  });

  test("the bare console-script form is caught", () => {
    const hits = detectActiveMlxTraining(" 1234 mlx_lm.train --config train.yaml");
    expect(hits.map((h) => h.pid)).toEqual([1234]);
  });

  test("the whitespace subcommand form is caught", () => {
    const hits = detectActiveMlxTraining(" 555 mlx-lm train --data ./corpus");
    expect(hits.map((h) => h.pid)).toEqual([555]);
  });

  test("the mlx. namespace form is caught", () => {
    const hits = detectActiveMlxTraining(" 606 python3.11 -m mlx.lora --iters 600");
    expect(hits.map((h) => h.pid)).toEqual([606]);
  });

  test("fuse and dpo are caught too", () => {
    const out = [" 11 mlx_lm.fuse --save-path ./out", " 12 python -m mlx_lm.dpo --beta 0.1"].join(
      "\n",
    );
    expect(detectActiveMlxTraining(out).map((h) => h.pid)).toEqual([11, 12]);
  });

  test("several concurrent runs are all reported", () => {
    const out = [REAL_WORLD, " 100 mlx_lm.lora --train", " 200 mlx_lm.fuse"].join("\n");
    expect(detectActiveMlxTraining(out).length).toBe(2);
  });
});

describe("detectActiveMlxTraining does not over-match", () => {
  /**
   * THE critical negative. oMLX is the inference server this whole fleet runs
   * on; it must be up for `up` to succeed at all. Matching it would refuse
   * every single run.
   */
  test("the oMLX inference server is NOT a training run", () => {
    const out = [
      REAL_WORLD,
      " 9001 python3.11 -m mlx_lm.server --port 8000 --model gemma-4-26b-a4b-it-4bit",
    ].join("\n");
    expect(detectActiveMlxTraining(out)).toEqual([]);
  });

  test("mlx_lm.generate is not training either", () => {
    expect(detectActiveMlxTraining(" 42 mlx_lm.generate --prompt hello")).toEqual([]);
  });

  /** An unrelated command that merely mentions mlx must not trip the guard. */
  test("an incidental mention of mlx does not match", () => {
    const out = [
      " 71 vim /Users/dan/notes/mlx-benchmarks.md",
      " 72 tail -f /var/log/mlx-server.log",
      " 73 grep -r mlx /Users/dan/repos",
    ].join("\n");
    expect(detectActiveMlxTraining(out)).toEqual([]);
  });

  /** Word boundary: a longer identifier ending in the pattern is not a match. */
  test("a lookalike identifier does not match", () => {
    expect(detectActiveMlxTraining(" 80 python -m not_mlx_lm.lora")).toEqual([]);
  });

  test("ordinary output produces no matches", () => {
    expect(detectActiveMlxTraining(REAL_WORLD)).toEqual([]);
  });

  test("empty output produces no matches", () => {
    expect(detectActiveMlxTraining("")).toEqual([]);
    expect(detectActiveMlxTraining("\n\n  \n")).toEqual([]);
  });

  test("unparseable lines are skipped rather than throwing", () => {
    const out = ["garbage with no pid", "", "   ", " 90 mlx_lm.lora --train"].join("\n");
    expect(detectActiveMlxTraining(out).map((h) => h.pid)).toEqual([90]);
  });

  /**
   * A scan that finds ITSELF refuses every `up` forever. The primary defence is
   * that `PS_ARGV` contains no matching string at all (asserted below), but the
   * pid exclusion is the belt to that braces — a future argv, or a test
   * harness, could still carry one.
   */
  test("the current process is excluded even if its command line matches", () => {
    const out = `${process.pid} python -m mlx_lm.lora --train`;
    expect(detectActiveMlxTraining(out)).toEqual([]);
  });

  /**
   * The self-match bug at its root: keep the needle out of the haystack. If
   * this argv ever gains the word "mlx", the guard starts finding its own `ps`.
   */
  test("the ps invocation cannot match the guard's own patterns", () => {
    const argv = PS_ARGV.join(" ");
    for (const p of DEFAULT_MLX_TRAINING_PATTERNS) expect(p.test(argv)).toBe(false);
    expect(argv).not.toContain("mlx");
  });
});

describe("describeMatch renders a match for an operator", () => {
  test("pid and command both appear", () => {
    expect(describeMatch({ pid: 77, command: "mlx_lm.lora --train" })).toBe(
      "pid 77: mlx_lm.lora --train",
    );
  });

  test("a pathological command line is truncated", () => {
    const long = describeMatch({ pid: 1, command: "x".repeat(500) });
    expect(long.length).toBeLessThan(140);
    expect(long).toContain("...");
  });
});
