/**
 * `pifleet shell --worker <id>` — an interactive shell in a worker's container,
 * on any backend.
 *
 * The action itself needs a live run and a docker daemon, so what is pinned
 * here is the surface and the two safety-relevant decisions inside it. Both are
 * decisions a reviewer has to be able to read as facts rather than infer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command } from "commander";

import { register } from "../../src/cli/commands/shell.ts";
import { interactiveArgv } from "../../src/attended/mode.ts";
import { stripComments } from "../support/source-structure.ts";

const SRC = stripComments(
  readFileSync(new URL("../../src/cli/commands/shell.ts", import.meta.url).pathname, "utf8"),
);

describe("the shell command's surface", () => {
  const program = (): Command => {
    const p = new Command();
    p.exitOverride();
    register(p);
    return p;
  };

  test("registers `shell` with --worker and --run", () => {
    const cmd = program().commands.find((c) => c.name() === "shell");
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain("--worker");
    expect(flags).toContain("--run");
  });

  test("it does NOT take a [cmd...] argument — that is `exec`", () => {
    // The two verbs are one character apart in intent and would be easy to
    // conflate. `exec` runs a command and returns its exit code as a datum;
    // this hands over a terminal. A `shell -- rm -rf /` that quietly behaved
    // like `exec` would be a very unwelcome surprise.
    const cmd = program().commands.find((c) => c.name() === "shell")!;
    expect(cmd.registeredArguments.length).toBe(0);
  });
});

describe("the two decisions inside it", () => {
  test("it reuses interactiveArgv rather than spelling docker exec itself", () => {
    // ONE definition of what an attended session runs. A second spelling here
    // would drift from the attended path — and the flag that must not drift is
    // `-it`: without it `docker exec` gives a non-interactive process and the
    // operator gets a pane that accepts no keystrokes.
    expect(SRC).toMatch(/interactiveArgv\(/);
    expect(interactiveArgv("2026-01-01T00-00-00Z-abcd", "w1")).toEqual([
      "docker",
      "exec",
      "-it",
      "pifleet-2026-01-01T00-00-00Z-abcd-w1",
      "bash",
    ]);
  });

  test("it requires a LIVE worker before exec'ing", () => {
    // Not a formality. `docker exec` against a run whose supervisor is gone
    // either fails with a docker error naming no worker, or succeeds against a
    // container the reaper has not reached — handing someone a shell in a dead
    // run they believe is live.
    expect(SRC).toMatch(/requireLiveWorker\(/);
  });

  test("stdio is INHERITED — a piped stream is not a TTY", () => {
    // `docker exec -it` fails outright on a captured stream, and the operator
    // gets "the input device is not a TTY" instead of a shell.
    expect(SRC).toMatch(/stdin:\s*"inherit"/);
    expect(SRC).toMatch(/stdout:\s*"inherit"/);
  });

  test("a container-less worker is refused by name, not by a docker error", () => {
    // The `PIFLEET_PI_COMMAND` path has no container by design. Failing on a
    // name that was never created reads like a docker problem.
    expect(SRC).toMatch(/state\.container === null/);
    expect(SRC).toMatch(/PIFLEET_PI_COMMAND/);
  });
});
