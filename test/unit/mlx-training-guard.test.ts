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
  programTokens,
} from "../../src/safety/mlx-training-guard.ts";

/** One canned `ps` line, so a case reads as the command line it is about. */
function matches(command: string): boolean {
  return detectActiveMlxTraining(` 4242 ${command}`).length > 0;
}

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

  /**
   * The SCRIPT form — and the most common one there is on a machine that
   * installs with `uv` or a plain venv. `python …/mlx_lm/lora.py` runs the
   * module's FILE rather than the module, so the slash-separated path never
   * contains the dotted `mlx_lm.lora` the original patterns keyed on. Verified
   * non-matching before the fix.
   */
  test("the venv script form is caught, dot or no dot", () => {
    const site = "/Users/dan/.venv/lib/python3.11/site-packages/mlx_lm/lora.py";
    expect(matches(`python ${site} --train`)).toBe(true);
    // Directly executable, so argv[0] IS the script.
    expect(matches(`${site} --train`)).toBe(true);
  });

  /**
   * The verb list had three real gaps. `grpo`/`orpo` are the preference-tuning
   * entry points `mlx_lm` ships alongside `dpo`, and `finetune` is the name
   * several harnesses use for the whole job — each is exactly as
   * GPU-saturating as `lora`, which is the only property this guard cares
   * about.
   */
  test("the preference-tuning and finetune verbs are caught", () => {
    expect(matches("python -m mlx_lm.grpo --train")).toBe(true);
    expect(matches("python -m mlx_lm.orpo --train")).toBe(true);
    expect(matches("python -m mlx_lm.finetune --train")).toBe(true);
  });

  /**
   * VLM fine-tuning, which this host is a plausible place to run: oMLX's own
   * log announces `VLM tool calling enabled` here, so the vision models are
   * present and someone will eventually tune one.
   */
  test("mlx_vlm training is caught, not just mlx_lm", () => {
    expect(matches("python -m mlx_vlm.lora --train")).toBe(true);
  });

  /**
   * Case. Not a spelling anyone types deliberately — but a guard exists for the
   * argv nobody predicted, and no legitimate command line is swept in by
   * allowing it.
   */
  test("an uppercase invocation is still a training run", () => {
    expect(matches("python -m MLX_LM.LORA --train")).toBe(true);
  });

  /**
   * The shape the integration suites actually spawn, and the reason the matcher
   * cannot key on argv[0] alone. macOS resolves a `#!/bin/sh` script by exec'ing
   * `/bin/sh <script> <args…>` — measured, not assumed — so the script's real
   * identity is argv[1] and argv[0] is the interpreter.
   */
  test("a shebang-launched training script is caught through its interpreter", () => {
    expect(matches("/bin/sh /tmp/pifleet-trainguard-abc/mlx_lm.lora --model Qwen3-8B --train")).toBe(
      true,
    );
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

  /**
   * THE case the old matcher got wrong, and the one that made the oMLX negative
   * above trivially true.
   *
   * Serving a fine-tune means pointing the INFERENCE server at the directory
   * the training run wrote, and that directory is conventionally named after
   * the entry point that produced it. The old patterns substring-matched the
   * whole command line, so this — a correctly configured host doing exactly
   * what the fleet needs — was reported as an active training run and refused
   * every `up`. The tested decoy carried no such path, so the assertion could
   * not fail; it pinned the pattern list, not the discrimination.
   */
  test("serving a LoRA adapter is NOT a training run, however the path is named", () => {
    expect(
      matches("python -m mlx_lm.server --port 8000 --adapter-path /Users/dan/out/mlx_lm.lora"),
    ).toBe(false);
  });

  /**
   * A filename is not a process. Both of these were verified MATCHING before
   * the fix — `mlx_lm.lora` appears in each, as a log file and as a search
   * string, and neither line runs anything of the kind.
   */
  test("a training entry point named as data does not match", () => {
    expect(matches("tail -f /Users/dan/logs/mlx_lm.lora.log")).toBe(false);
    expect(matches("grep -rn mlx_lm.lora /Users/dan/repos")).toBe(false);
    // No flags at all, so the flag-value rule cannot be what saves it — the
    // runner gate is: `less` executes nothing, so its argument is data.
    expect(matches("less /Users/dan/out/mlx_lm.lora/adapters.safetensors")).toBe(false);
  });

  /**
   * The `$` anchor, isolated. Even reached as a program token, a `.log` suffix
   * means the token is not the entry point — belt to the runner gate's braces.
   */
  test("a suffixed lookalike does not match even in program position", () => {
    expect(matches("python /Users/dan/mlx_lm.lora.log")).toBe(false);
    expect(matches("/Users/dan/bin/mlx_lm.lora.backup --train")).toBe(false);
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

/**
 * The position half of the matcher, tested directly.
 *
 * The patterns answer "is this token a training entry point". `programTokens`
 * answers "is this token the program being run", and that second question is
 * the one the original implementation never asked — which is why a path in a
 * `--adapter-path` argument could refuse every `up`. A rule that only ever gets
 * observed through `detectActiveMlxTraining` is a rule that drifts, so it is
 * asserted here on its own terms.
 */
describe("programTokens separates programs from their arguments", () => {
  test("argv[0] always qualifies", () => {
    expect(programTokens("mlx_lm.lora --train")).toContain("mlx_lm.lora");
  });

  test("the token after -m qualifies, however far right it sits", () => {
    expect(programTokens("python -u -X dev -m mlx_lm.lora --train")).toContain("mlx_lm.lora");
  });

  /** The defect, stated as the rule that fixes it. */
  test("a flag's value never qualifies", () => {
    const toks = programTokens(
      "python -m mlx_lm.server --port 8000 --adapter-path /Users/dan/out/mlx_lm.lora",
    );
    expect(toks).toContain("mlx_lm.server");
    expect(toks).not.toContain("/Users/dan/out/mlx_lm.lora");
  });

  /**
   * The runner gate. `grep` and `tail` execute nothing, so everything after
   * argv[0] is data no matter how it is punctuated — which is what makes the
   * no-flag spellings (`grep mlx_lm.lora .`) safe too, where the flag-value
   * rule alone would not have helped.
   */
  test("a non-runner's arguments never qualify", () => {
    expect(programTokens("grep mlx_lm.lora /Users/dan/repos")).toEqual(["grep"]);
    expect(programTokens("tail -f /Users/dan/logs/mlx_lm.lora.log")).toEqual(["tail"]);
  });

  test("a runner's positional argument does qualify", () => {
    expect(programTokens("/bin/sh /tmp/x/mlx_lm.lora --train")).toContain("/tmp/x/mlx_lm.lora");
  });

  test("versioned interpreters are recognised by shape, not by a list", () => {
    expect(programTokens("python3.11 -m mlx.lora --iters 600")).toContain("mlx.lora");
    expect(programTokens("python3.14 -m mlx.lora")).toContain("mlx.lora");
  });

  /** `mlx-lm train` folded into the dotted form the patterns already cover. */
  test("a bare console script's subcommand is folded into dotted form", () => {
    expect(programTokens("mlx-lm train --data ./corpus")).toContain("mlx-lm.train");
  });

  test("an empty or whitespace command line yields nothing", () => {
    expect(programTokens("")).toEqual([]);
    expect(programTokens("   ")).toEqual([]);
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
