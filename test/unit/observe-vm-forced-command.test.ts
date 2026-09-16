/**
 * `scripts/observe/vm-forced-command` is the whole of what the
 * `observer-vm` credential can do (SRD-OBSERVER-ROLES §6.2-6.4; Phase 5 task
 * 5.1 landed `uptime`, `os`, `system`, `failed`, `unit`, `disk`, `memory`;
 * task 5.3 adds `journal` and `kernel`, both covered below).
 *
 * sshd runs this script directly for the enrolled key
 * (`restrict,command="<installed path>"`, §6.2), with NO arguments of its
 * own — every case here spawns the REAL script file exactly that way, with
 * `SSH_ORIGINAL_COMMAND` set in its environment and nothing else, and
 * recording fakes for `systemctl`, `journalctl`, `df`, `cat` and `timeout`
 * first on `PATH`. The script has no mutable state and no fixed filesystem
 * location baked into it (it only ever reads an environment variable and
 * execs one of those five commands), so there is no per-run copy to make:
 * the real file is what every case below executes.
 *
 * Only one of the five fakes ever actually runs per script invocation
 * (the script always ends in exactly one `exec`), so all five share one
 * record file: each fake writes its OWN NAME as the first record element,
 * then its argv, NUL-separated so an element holding a space survives as
 * one record. "No invocation recorded" means that record file does not
 * exist — the atomic write-then-rename below is what makes that reliable
 * even against a process that never gets that far. `journal` and `kernel`
 * are the first verbs to reach the `journalctl` fake; every other verb
 * still never records anything naming it.
 *
 * The `journal`/`kernel` since-spelling tests never hand-type
 * `--since=-<N>s`: they build it from
 * `test/fixtures/observe/vm-tool-shapes.json` `.since.chosen`, the MEASURED
 * spelling the real script's header cites (choice 7). If either the fixture
 * or the script changes spelling, the mismatch turns those tests red
 * instead of silently passing against a stale literal.
 *
 * ## Shell coverage
 *
 * `shells()` runs every case under each POSIX shell it finds, deduplicated
 * by realpath: `/bin/sh` (bash 3.2 in sh mode on macOS, dash on Debian) and
 * `dash` where it is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
/** The real script. Executed directly by every case — see the header. */
const REAL_SCRIPT = join(ROOT, "scripts", "observe", "vm-forced-command");
const SRC = readFileSync(REAL_SCRIPT, "utf8");

/**
 * MEASURED, never hand-typed: test/fixtures/observe/vm-tool-shapes.json.
 * `.since.chosen` is the exact `--since=-{N}s` template the real script's
 * header (choice 7) says it emits; `{N}` is replaced with the actual count
 * by `sinceArg` below.
 */
const VM_TOOL_SHAPES = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "vm-tool-shapes.json"), "utf8")) as {
  since: { chosen: string };
};
const SINCE_TEMPLATE: string = VM_TOOL_SHAPES.since.chosen;

/**
 * MEASURED, never hand-typed: test/fixtures/observe/vm-forbidden-commands.json.
 * Every `.entries[].command`, sent as SSH_ORIGINAL_COMMAND, must be refused.
 */
const VM_FORBIDDEN_COMMANDS = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "vm-forbidden-commands.json"), "utf8")) as {
  entries: Array<{ command: string; source: string }>;
};

/** Builds the `--since=-<n>s`-shaped argument from the fixture's measured template, never hand-typed. */
function sinceArg(n: number): string {
  return SINCE_TEMPLATE.replace("{N}", String(n));
}

/** One refusal message every case below can recognise, verb-agnostic. */
const REFUSAL_PREFIX = 'vm-forced-command: refused';

/**
 * The FULL reason text the script prints for every `since=` grammar
 * refusal — both the "no trailing 's'" branch and the `is_since_n` branch
 * print this exact string. Asserted in full, not as a prefix: a prefix like
 * "a since= value must be" would still match if one branch regressed to
 * describing a different class (e.g. the stale `[0-9]{1,9}`,
 * leading-zero-permitting grammar) than the other.
 */
const SINCE_REASON = "a since= value must be [1-9][0-9]{0,8} digits, no leading zero, followed by 's'";

/** The other refusals' full reasons, held once so a stale word in any of them goes red, as `SINCE_REASON` does. */
const VERB_REASON = "not a recognised verb; recognised verbs are uptime, os, system, failed, unit, journal, kernel, disk and memory";
const LINES_REASON = "a lines= value must be 1-500, decimal digits only, no leading zero";
const PRIORITY_REASON = "a priority= value must be exactly one digit 0-7";

/** Reads a `NAME=<digits>` bare (unquoted) shell assignment out of the real script. */
function extractBareDigits(varName: string): string {
  const match = SRC.match(new RegExp(`${varName}=([0-9]+)`));
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`could not find ${varName}=<digits> in ${REAL_SCRIPT}`);
  }
  return value;
}

/**
 * The byte cap on a unit name (the script header's tightening #2). Typed by
 * hand: read from the script, a changed cap would move every boundary case
 * with it and nothing would go red.
 */
const UNIT_MAX = 255;

// --- expected argv per verb (SRD §6.4) --------------------------------------

function uptimeArgv(): string[] {
  return ["cat", "/proc/uptime", "/proc/loadavg"];
}
function osArgv(): string[] {
  return ["cat", "/etc/os-release"];
}
function systemArgv(): string[] {
  return ["systemctl", "is-system-running"];
}
function failedArgv(): string[] {
  return ["systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager"];
}
function unitArgv(unit: string): string[] {
  return ["systemctl", "show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestamp,ExecMainStatus"];
}
/**
 * `journal`'s expected argv (SRD §6.4, header choices 1-7). `sinceSeconds`
 * builds its `--since=` element from the fixture's MEASURED spelling
 * (`sinceArg`), never a hand-typed literal. `unit`/`priority` are omitted
 * from the argv entirely when not given, in that order, matching the real
 * script's own build order.
 */
function journalArgv(lines: number, sinceSeconds: number, opts: { unit?: string; priority?: number } = {}): string[] {
  const argv = ["journalctl", "--no-pager", "--output=short-iso", `--lines=${lines}`, sinceArg(sinceSeconds)];
  if (opts.unit !== undefined) argv.push(`--unit=${opts.unit}`);
  if (opts.priority !== undefined) argv.push(`--priority=${opts.priority}`);
  return argv;
}
/** `kernel`'s expected argv (SRD §6.4, header choices 1-3 and 7): no `unit`/`priority`, ever. */
function kernelArgv(lines: number, sinceSeconds: number): string[] {
  return ["journalctl", "--no-pager", "--dmesg", "--output=short-iso", `--lines=${lines}`, sinceArg(sinceSeconds)];
}
/** `disk`'s expected argv: SRD §6.4 at HEAD, principal decision 2026-09-14 — bounded by `timeout 20` ahead of `df` itself. */
function diskArgv(): string[] {
  return ["timeout", "20", "df", "-P", "-k"];
}
function memoryArgv(): string[] {
  return ["cat", "/proc/meminfo"];
}

/** One recording fake body, parameterised by its own binary name. */
function fakeBody(name: string): string {
  return `#!/bin/sh
# Recording fake ${name} for test/unit/observe-vm-forced-command.test.ts.
# Never contacts anything real.
set -u
rec=\${FAKE_VM_RECORD_DIR:?}
{ printf '%s\\0' '${name}'; printf '%s\\0' "$@"; } > "$rec/argv.partial"
mv "$rec/argv.partial" "$rec/argv"
printf '%s' "\${FAKE_VM_STDOUT:-}"
if [ -n "\${FAKE_VM_STDERR:-}" ]; then
  printf '%s' "\${FAKE_VM_STDERR}" >&2
fi
exit "\${FAKE_VM_EXIT:-0}"
`;
}

const FAKE_BINARIES = ["cat", "systemctl", "df", "journalctl", "timeout"];

let scratch = "";
let fakeBin = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "test-vm-forced-command-"));
  fakeBin = mkdtempSync(join(scratch, "bin-"));
  for (const name of FAKE_BINARIES) {
    const path = join(fakeBin, name);
    writeFileSync(path, fakeBody(name));
    chmodSync(path, 0o755);
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function shells(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ["/bin/sh", Bun.which("dash")]) {
    if (!candidate || !existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(candidate);
  }
  return out;
}

interface RunOpts {
  exit?: number;
  stdout?: string;
  stderr?: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** [binaryName, ...argv] the fake was invoked with, or null when none ran. */
  cmd: string[] | null;
}

function readRecord(rec: string): string[] | null {
  const argvPath = join(rec, "argv");
  if (!existsSync(argvPath)) return null;
  const argv = readFileSync(argvPath, "utf8").split("\0");
  argv.pop(); // every record is NUL-terminated, so the last split is empty
  return argv;
}

/**
 * Spawns the REAL script (see header), with an environment holding ONLY
 * what is listed here — nothing is inherited from this process, so an
 * `SSH_ORIGINAL_COMMAND` on the developer's machine cannot satisfy a case
 * that means to test its absence. `sshOriginalCommand` of `undefined` means
 * the variable is not set at all, not set to the empty string.
 *
 * `extraEnv` merges additional variables into that same closed environment
 * — used to simulate a caller whose IFS reaches this script already set.
 */
function runScript(
  shell: string,
  sshOriginalCommand: string | undefined,
  opts: RunOpts = {},
  cwd = scratch,
  extraEnv: Record<string, string> = {},
): Run {
  const rec = mkdtempSync(join(scratch, "rec-"));
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_VM_RECORD_DIR: rec,
    FAKE_VM_EXIT: String(opts.exit ?? 0),
    FAKE_VM_STDOUT: opts.stdout ?? "",
    FAKE_VM_STDERR: opts.stderr ?? "",
    ...extraEnv,
  };
  if (sshOriginalCommand !== undefined) {
    env.SSH_ORIGINAL_COMMAND = sshOriginalCommand;
  }
  const proc = Bun.spawnSync([shell, REAL_SCRIPT], { env, cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    cmd: readRecord(rec),
  };
}

describe("the real script's safety invariants", () => {
  test("never calls eval outside a comment", () => {
    const code = SRC.split("\n").filter((line) => !/^\s*#/.test(line));
    expect(code.some((line) => /(^|[^A-Za-z0-9_])eval\b/.test(line))).toBe(false);
  });

  test("turns globbing off before the unquoted re-split", () => {
    const lines = SRC.split("\n");
    const setF = lines.indexOf("set -f");
    const firstUnquotedResplit = lines.findIndex((l) => l.includes("set -- ${"));
    expect(setF).toBeGreaterThanOrEqual(0);
    expect(firstUnquotedResplit).toBeGreaterThan(setF);
  });

  test("pins IFS to the POSIX default before the unquoted re-split, and restores it to that same pinned constant rather than an inherited value", () => {
    // REVERT CHECK: dropping the `IFS="${POSIX_IFS}"` pin, or restoring via
    // a variable that captured whatever IFS was active a moment before
    // (e.g. a re-introduced `saved_ifs=$IFS`), must turn this assertion red.
    const lines = SRC.split("\n");
    const pinIndex = lines.findIndex((l) => l.trim() === 'IFS="${POSIX_IFS}"');
    const firstUnquotedResplit = lines.findIndex((l) => l.includes("set -- ${"));
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(pinIndex).toBeLessThan(firstUnquotedResplit);
    expect(SRC).not.toContain("saved_ifs");
  });

  test("the file is executable", () => {
    const mode = statSync(REAL_SCRIPT).mode & 0o777;
    expect(mode & 0o100).not.toBe(0); // owner-executable
  });

  test(`the script's UNIT_MAX is the hand-pinned ${UNIT_MAX}`, () => {
    expect(Number(extractBareDigits("UNIT_MAX"))).toBe(UNIT_MAX);
  });
});

test("at least one POSIX shell is available to run the script", () => {
  expect(shells().length).toBeGreaterThanOrEqual(1);
});

/** Every printable ASCII byte outside the unit grammar's `[A-Za-z0-9@._:-]` (`is_unit` in the script). */
const UNIT_CHARS_ALLOWED = new Set<string>([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), // A-Z
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)), // a-z
  ...Array.from({ length: 10 }, (_, i) => String(i)), // 0-9
  "@",
  ".",
  "_",
  ":",
  "-",
]);
const UNIT_CHARS_DISALLOWED: string[] = [];
for (let code = 0x21; code <= 0x7e; code++) {
  const ch = String.fromCharCode(code);
  if (!UNIT_CHARS_ALLOWED.has(ch)) UNIT_CHARS_DISALLOWED.push(ch);
}

/** Allowed anywhere in a unit name, but refused as the FIRST character — this script's tightening #1 (header). */
const UNIT_LEADING_ONLY_DISALLOWED = ["@", ".", "_", ":", "-"];

describe("the forbidden-commands fixture is populated (test/fixtures/observe/vm-forbidden-commands.json)", () => {
  // The fixture walk below is a `test.each` over `entries`, and a
  // `test.each` over an empty or truncated array runs fewer tests than
  // intended and still passes. These two guard against that: a fixture with
  // 207 entries today must never regress to a handful, and the two
  // specific entries below (the SRD's own revert-check payload, and a
  // sub-verb that must be refused on argument count) must always be present.
  test("has at least 200 entries", () => {
    expect(VM_FORBIDDEN_COMMANDS.entries.length).toBeGreaterThanOrEqual(200);
  });

  test("includes the --vacuum-time=1s revert-check payload", () => {
    expect(VM_FORBIDDEN_COMMANDS.entries.some((e) => e.command === "journal since=60s lines=10 --vacuum-time=1s")).toBe(true);
  });

  test("includes a unit sub-verb entry", () => {
    expect(VM_FORBIDDEN_COMMANDS.entries.some((e) => e.command === "unit restart sshd.service")).toBe(true);
  });
});

describe.each(shells())("scripts/observe/vm-forced-command under %s", (shell) => {
  describe("the exact target argv per verb (SRD §6.4)", () => {
    test("uptime: no arguments", () => {
      const r = runScript(shell, "uptime");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(uptimeArgv());
    });

    test("os: no arguments", () => {
      const r = runScript(shell, "os");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(osArgv());
    });

    test("system: no arguments", () => {
      const r = runScript(shell, "system");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(systemArgv());
    });

    test("failed: no arguments", () => {
      const r = runScript(shell, "failed");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(failedArgv());
    });

    test("unit: one unit name", () => {
      const r = runScript(shell, "unit nginx.service");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(unitArgv("nginx.service"));
    });

    test("journal: minimum form, since= and lines= only", () => {
      const r = runScript(shell, "journal since=300s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300));
    });

    test("journal: with unit=", () => {
      const r = runScript(shell, "journal since=300s lines=5 unit=nginx.service");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300, { unit: "nginx.service" }));
    });

    test("journal: with priority=", () => {
      const r = runScript(shell, "journal since=300s lines=5 priority=3");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300, { priority: 3 }));
    });

    test.each([0, 1, 2, 3, 4, 5, 6, 7])("journal: priority=%i is accepted (the full syslog 0-7 range, each digit pinned)", (priority) => {
      const r = runScript(shell, `journal since=300s lines=5 priority=${priority}`);
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300, { priority }));
    });

    test("journal: with both unit= and priority=", () => {
      const r = runScript(shell, "journal since=300s lines=5 unit=nginx.service priority=3");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300, { unit: "nginx.service", priority: 3 }));
    });

    test("journal: keys accepted in any order, argv is still built in the script's own order", () => {
      const r = runScript(shell, "journal priority=3 unit=nginx.service lines=5 since=300s");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 300, { unit: "nginx.service", priority: 3 }));
    });

    test("journal: lines=1 is the accepted lower boundary", () => {
      const r = runScript(shell, "journal since=60s lines=1");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(1, 60));
    });

    test("journal: lines=499 is accepted, one under the exact-500 boundary", () => {
      const r = runScript(shell, "journal since=60s lines=499");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(499, 60));
    });

    test("journal: lines=500 is the accepted upper boundary", () => {
      const r = runScript(shell, "journal since=60s lines=500");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(500, 60));
    });

    test("journal: since=1s is the accepted lower boundary (a single digit, no leading zero)", () => {
      const r = runScript(shell, "journal since=1s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 1));
    });

    test("journal: since=999999999s is the accepted upper boundary (9 digits)", () => {
      const r = runScript(shell, "journal since=999999999s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(journalArgv(5, 999999999));
    });

    test("kernel: since= and lines= only", () => {
      const r = runScript(shell, "kernel since=300s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(kernelArgv(5, 300));
    });

    test("kernel: since=1s is the accepted lower boundary (a single digit, no leading zero)", () => {
      const r = runScript(shell, "kernel since=1s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(kernelArgv(5, 1));
    });

    test("kernel: since=999999999s is the accepted upper boundary (9 digits)", () => {
      const r = runScript(shell, "kernel since=999999999s lines=5");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(kernelArgv(5, 999999999));
    });

    test("kernel: keys accepted in either order", () => {
      const r = runScript(shell, "kernel lines=5 since=300s");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(kernelArgv(5, 300));
    });

    test("disk: no arguments", () => {
      const r = runScript(shell, "disk");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(diskArgv());
    });

    test("memory: no arguments", () => {
      const r = runScript(shell, "memory");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(memoryArgv());
    });
  });

  describe(`IFS: ${shell} ignores an inherited IFS (these two tests cannot fail on any change to vm-forced-command)`, () => {
    // sh, dash and `bash --posix` all discard an IFS inherited from the
    // environment (measured on this machine: a shell spawned with IFS=":"
    // exported still reports its own IFS as the POSIX default the instant
    // it starts) — this describe.each block only ever runs under sh or
    // dash (see shells() above), and both tests below run under whichever
    // one this iteration is. So neither test can fail on any change to the
    // script — including removing its own IFS pin entirely: the
    // caller-supplied IFS=":" never reaches vm-forced-command's parsing
    // regardless of what the script does. They exist only to SHOW that
    // fact about the shell this iteration runs under, not to guard the
    // script's pin.
    //
    // The real guard on the script's own IFS pin is the static test above,
    // "pins IFS to the POSIX default before the unquoted re-split, …" —
    // that is the one that goes red if the `IFS="${POSIX_IFS}"` pin is
    // removed. The Docker skill's enrolment step on IFS, ENV and BASH_ENV
    // (skills/observer-docker-ops/SKILL.md) makes this same point for the
    // Docker role's forced command.
    test("shown, not guarded: journal: unit= plus priority= produce the same argv whether or not IFS=: is inherited, because this shell discards it before parsing — not because of vm-forced-command's own pin", () => {
      const withoutColonIfs = runScript(shell, "journal since=300s lines=5 unit=nginx.service priority=3");
      const withColonIfs = runScript(shell, "journal since=300s lines=5 unit=nginx.service priority=3", {}, scratch, { IFS: ":" });
      expect(withoutColonIfs.exitCode).toBe(0);
      expect(withColonIfs.exitCode).toBe(0);
      expect(withColonIfs.cmd).toEqual(withoutColonIfs.cmd);
      expect(withColonIfs.cmd).toEqual(journalArgv(5, 300, { unit: "nginx.service", priority: 3 }));
    });

    test("shown, not guarded: a colon-joined token such as 'unit:nginx.service' is still refused as one bad verb, never split into a valid verb and argument, when IFS=: is inherited — again because this shell discards the inherited IFS before parsing, not because of vm-forced-command's own pin", () => {
      const r = runScript(shell, "unit:nginx.service", {}, scratch, { IFS: ":" });
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain("the verb is not [a-z][a-z0-9-]{0,31}");
      expect(r.cmd).toBeNull();
    });
  });

  describe("the target command's own exit status and output reach the caller unchanged", () => {
    test("system: a non-zero exit (e.g. 'degraded') and its stdout both pass through exec, unreinterpreted", () => {
      const r = runScript(shell, "system", { exit: 1, stdout: "degraded\n" });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("degraded\n");
      expect(r.stderr).toBe("");
      expect(r.cmd).toEqual(systemArgv());
    });

    test("disk: stdout, stderr and a non-zero exit code (124, a timeout) all pass through exec unchanged", () => {
      // coreutils `timeout` exits 124 on expiry and passes a child's exit
      // through unchanged (measured, Ubuntu 24.04) — this pins that exact
      // code reaching the caller, not just "some non-zero exit".
      const r = runScript(shell, "disk", { exit: 124, stdout: "hello-stdout\n", stderr: "hello-stderr\n" });
      expect(r.exitCode).toBe(124);
      expect(r.stdout).toBe("hello-stdout\n");
      expect(r.stderr).toBe("hello-stderr\n");
      expect(r.cmd).toEqual(diskArgv());
    });

    test("journal: the target command's own non-zero exit status passes through exec unchanged", () => {
      const r = runScript(shell, "journal since=300s lines=5", { exit: 3 });
      expect(r.exitCode).toBe(3);
      expect(r.cmd).toEqual(journalArgv(5, 300));
    });

    test("kernel: the target command's own non-zero exit status passes through exec unchanged", () => {
      const r = runScript(shell, "kernel since=300s lines=5", { exit: 3 });
      expect(r.exitCode).toBe(3);
      expect(r.cmd).toEqual(kernelArgv(5, 300));
    });

    test("a 77 from the target command itself is not relabelled as this script's own refusal", () => {
      const r = runScript(shell, "uptime", { exit: 77, stderr: "cat: something remote\n" });
      expect(r.exitCode).toBe(77);
      expect(r.stderr).not.toContain(REFUSAL_PREFIX);
      expect(r.cmd).toEqual(uptimeArgv());
    });
  });

  describe("a missing or empty SSH_ORIGINAL_COMMAND is refused, not read as any verb", () => {
    test("the variable is not set at all", () => {
      const r = runScript(shell, undefined);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.cmd).toBeNull();
    });

    test("the variable is set to the empty string", () => {
      const r = runScript(shell, "");
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.cmd).toBeNull();
    });

    test("the variable holds only whitespace", () => {
      const r = runScript(shell, "   \t  ");
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.cmd).toBeNull();
    });
  });

  describe("refusals: exit 77, the verb named on stderr, and no invocation recorded", () => {
    const UNIT_REASON = `a unit name must match ^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$, max ${UNIT_MAX} bytes`;
    // [label, SSH_ORIGINAL_COMMAND, verb stderr names, the full reason the script prints].
    const cases: Array<[string, string, string, string]> = [
      ["an unknown verb", "restart nginx.service", "restart", VERB_REASON],
      ["stop as a top-level verb", "stop nginx.service", "stop", VERB_REASON],
      ["start as a top-level verb", "start nginx.service", "start", VERB_REASON],
      ["enable as a top-level verb", "enable nginx.service", "enable", VERB_REASON],
      ["shutdown", "shutdown", "shutdown", VERB_REASON],
      ["reboot", "reboot", "reboot", VERB_REASON],
      ["poweroff", "poweroff", "poweroff", VERB_REASON],
      ["halt", "halt", "halt", VERB_REASON],
      ["sudo", "sudo systemctl restart nginx.service", "sudo", VERB_REASON],
      ["kill", "kill nginx.service", "kill", VERB_REASON],
      ["journal: missing since=", "journal lines=10", "journal", "since=<N>s is required"],
      ["journal: missing lines=", "journal since=60s", "journal", "lines=<M> is required"],
      ["journal: lines=501, one over the cap", "journal since=60s lines=501", "journal", LINES_REASON],
      ["journal: lines=0", "journal since=60s lines=0", "journal", LINES_REASON],
      ["journal: lines=1000, a 4-digit value far over the cap", "journal since=60s lines=1000", "journal", LINES_REASON],
      ["journal: lines=99999, a 5-digit value far over the cap", "journal since=60s lines=99999", "journal", LINES_REASON],
      ["kernel: lines=1000, a 4-digit value far over the cap", "kernel since=60s lines=1000", "kernel", LINES_REASON],
      ["kernel: lines=99999, a 5-digit value far over the cap", "kernel since=60s lines=99999", "kernel", LINES_REASON],
      ["journal: a leading-zero N", "journal since=007s lines=10", "journal", SINCE_REASON],
      ["journal: a leading-zero M", "journal since=60s lines=007", "journal", LINES_REASON],
      ["journal: N without a trailing 's'", "journal since=60 lines=10", "journal", SINCE_REASON],
      ["journal: a 10-digit N", `journal since=${"1".repeat(10)}s lines=10`, "journal", SINCE_REASON],
      ["journal: since=0s, a lone zero is refused (an empty lookback reads as \"nothing happened\")", "journal since=0s lines=5", "journal", SINCE_REASON],
      ["kernel: since=0s, a lone zero is refused (an empty lookback reads as \"nothing happened\")", "kernel since=0s lines=5", "kernel", SINCE_REASON],
      ["journal: priority=8, one over the range", "journal since=60s lines=10 priority=8", "journal", PRIORITY_REASON],
      ["journal: priority=37, two digits", "journal since=60s lines=10 priority=37", "journal", PRIORITY_REASON],
      ["journal: priority=3x, a digit followed by a non-digit", "journal since=60s lines=10 priority=3x", "journal", PRIORITY_REASON],
      ["journal: priority=err, not a digit at all", "journal since=60s lines=10 priority=err", "journal", PRIORITY_REASON],
      ["journal: unit= fails the unit-name grammar", "journal since=60s lines=10 unit=nginx!service", "journal", UNIT_REASON],
      ["journal: unit= with a leading '-' fails the unit-name grammar", "journal since=60s lines=10 unit=-x", "journal", UNIT_REASON],
      ["kernel: unit= is not a key kernel accepts", "kernel since=60s lines=10 unit=nginx.service", "kernel", "unrecognised argument key"],
      ["kernel: priority= is not a key kernel accepts", "kernel since=60s lines=10 priority=3", "kernel", "unrecognised argument key"],
      ["journal: a repeated key", "journal since=60s since=70s lines=10", "journal", "since= may be given only once"],
      ["journal: a repeated lines=", "journal since=60s lines=10 lines=20", "journal", "lines= may be given only once"],
      ["journal: a repeated unit=", "journal since=60s lines=10 unit=a.service unit=b.service", "journal", "unit= may be given only once"],
      ["journal: a repeated priority=", "journal since=60s lines=10 priority=3 priority=4", "journal", "priority= may be given only once"],
      ["journal: an unknown key", "journal since=60s lines=10 foo=bar", "journal", "unrecognised argument key"],
      ["journal: a bare token without '='", "journal since=60s lines=10 bogus", "journal", "every argument must be key=value"],
      ["journal: a --vacuum-time=1s token is refused as an unrecognised key, never appended to journalctl's argv", "journal since=60s lines=10 --vacuum-time=1s", "journal", "unrecognised argument key"],
      [
        "unit with a sub-verb (restart as a unit argument) — two arguments, refused on count before any grammar check",
        "unit restart nginx.service",
        "unit",
        "unit takes exactly one argument, a unit name; got 2",
      ],
      ["unit with zero arguments", "unit", "unit", "unit takes exactly one argument, a unit name; got 0"],
      ["unit with three arguments", "unit a b c", "unit", "unit takes exactly one argument, a unit name; got 3"],
      ["unit: unit name fails the grammar (bad character)", "unit nginx!service", "unit", UNIT_REASON],
      ["unit: unit name fails the grammar (leading '-')", "unit -nginx.service", "unit", UNIT_REASON],
      [`unit: unit name longer than ${UNIT_MAX} bytes`, `unit ${"a".repeat(UNIT_MAX + 1)}`, "unit", UNIT_REASON],
      ["uptime with an extra argument", "uptime extra", "uptime", "uptime takes no arguments; got 1"],
      ["os with an extra argument", "os extra", "os", "os takes no arguments; got 1"],
      ["system with an extra argument", "system extra", "system", "system takes no arguments; got 1"],
      ["failed with an extra argument", "failed extra", "failed", "failed takes no arguments; got 1"],
      ["disk with an extra argument", "disk extra", "disk", "disk takes no arguments; got 1"],
      ["memory with an extra argument", "memory extra", "memory", "memory takes no arguments; got 1"],
      ["a verb with a leading '-'", "-V nginx.service", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb starting with a digit", "1uptime", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb longer than 32 characters", `${"u".repeat(33)}`, "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb holding an uppercase letter", "Uptime", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a path as a verb", "/bin/sh", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
    ];
    test.each(cases)("%s", (_label, cmd, expectSubstring, reason) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain(expectSubstring);
      // The whole reason, from refuse()'s `": "` through its newline, so a stale or appended word goes red.
      expect(r.stderr).toContain(`": ${reason}\n`);
      expect(r.cmd).toBeNull();
    });
  });

  describe("journal/kernel: a refusal never echoes caller bytes, even one carrying an embedded newline followed by a forged-looking line", () => {
    // Mirrors "an embedded newline inside the unit argument is refused and
    // never echoed into stderr" below, but for the journal/kernel
    // key=value argument grammar's own two refusal branches
    // (parse_journal_kernel_args's `*=*` and final `*` cases) — today only
    // the `unit` verb's newline case is covered. Each `arg` below carries an
    // embedded newline (never a token boundary here — see the header on why
    // the resplit excludes newline) followed by text made to look like a
    // second, forged line of output.
    //
    // "foo=bar\nFORGED=1" contains an '=' (from "FORGED=1" itself), so it
    // takes the `*=*` "unrecognised argument key" branch, same as the
    // existing "an unknown key" case above, just with the forged line
    // appended. "bogus\nFORGED" deliberately carries no '=' anywhere —
    // appending "=1" here would flip it onto the `*=*` branch instead
    // (measured) — so it stays on the bare-token "every argument must be
    // key=value" branch, same as the existing "a bare token without '='"
    // case above.
    const cases: Array<[string, string, string]> = [
      ["journal: an unknown key carrying an embedded newline and a forged line", "journal since=60s lines=10 foo=bar\nFORGED=1", "FORGED=1"],
      ["journal: a bare token carrying an embedded newline and a forged line", "journal since=60s lines=10 bogus\nFORGED", "FORGED"],
      ["kernel: an unknown key carrying an embedded newline and a forged line", "kernel since=60s lines=10 foo=bar\nFORGED=1", "FORGED=1"],
      ["kernel: a bare token carrying an embedded newline and a forged line", "kernel since=60s lines=10 bogus\nFORGED", "FORGED"],
    ];
    test.each(cases)("%s", (_label, cmd, forged) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).not.toContain(forged);
      expect(r.cmd).toBeNull();
    });
  });

  describe("a leading '-' anywhere is refused by construction, never reaches the target command as a flag", () => {
    const cases: Array<[string, string]> = [
      ["the verb position", "-V"],
      ["the unit argument", "unit -nginx.service"],
    ];
    test.each(cases)("%s", (_label, cmd) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.cmd).toBeNull();
    });
  });

  test("an embedded newline inside the unit argument is refused and never echoed into stderr", () => {
    const r = runScript(shell, "unit a\nrm-everything");
    expect(r.exitCode).toBe(77);
    expect(r.stderr).not.toContain("rm-everything");
    expect(r.cmd).toBeNull();
  });

  test("a newline between two tokens does not split them into a third argument", () => {
    // "unit nginx.service\nfailed" splits on the space into ["unit",
    // "nginx.service\nfailed"] — the newline does not create a second
    // argument, so this is refused as a bad unit name (one embedded
    // newline), not as "got 2 arguments".
    const r = runScript(shell, "unit nginx.service\nfailed");
    expect(r.exitCode).toBe(77);
    expect(r.stderr).toContain("a unit name must match");
    expect(r.cmd).toBeNull();
  });

  describe("set -f: a literal '*' is refused by grammar, never glob-expanded", () => {
    // `set -f` matters at the unquoted re-split, before any grammar check.
    // Without it, a unit argument of `web-*` becomes a matching filename
    // from the script's cwd, which could pass the grammar and reach
    // systemctl. This plants a file the whole token matches, so removing
    // `set -f` turns it red.
    test("unit: a unit value of 'web-*', run in a directory holding a file literally named 'web-1', still refuses", () => {
      const dir = mkdtempSync(join(scratch, "glob-cwd-"));
      writeFileSync(join(dir, "web-1"), "");
      const r = runScript(shell, "unit web-*", {}, dir);
      expect(r.exitCode).toBe(77);
      expect(r.cmd).toBeNull();
    });
  });

  test(`a unit name at the ${UNIT_MAX}-byte limit reaches systemctl; one byte over is refused`, () => {
    const at = "a".repeat(UNIT_MAX);
    const over = "a".repeat(UNIT_MAX + 1);
    const ok = runScript(shell, `unit ${at}`);
    expect(ok.exitCode).toBe(0);
    expect(ok.cmd).toEqual(unitArgv(at));
    const refused = runScript(shell, `unit ${over}`);
    expect(refused.exitCode).toBe(77);
    expect(refused.cmd).toBeNull();
  });

  describe("unit-name grammar refuses every disallowed character, in the unit position", () => {
    // Rows assert the refusal, not its exact reason text.
    const disallowedAnywhere: Array<[string, string]> = UNIT_CHARS_DISALLOWED.map((c) => [
      `unit grammar refuses '${c}' embedded in the unit name`,
      `unit web${c}service`,
    ]);
    const leadingOnlyDisallowed: Array<[string, string]> = UNIT_LEADING_ONLY_DISALLOWED.map((c) => [
      `unit grammar refuses leading '${c}' (allowed elsewhere, refused as the first character)`,
      `unit ${c}webservice`,
    ]);
    test.each([...disallowedAnywhere, ...leadingOnlyDisallowed])("%s", (_label, cmd) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr.startsWith(REFUSAL_PREFIX)).toBe(true);
      expect(r.cmd).toBeNull();
    });

    test("every character SRD §6.3's base class allows is accepted mid-name (a-z, A-Z, 0-9, @, ., _, :, -)", () => {
      // The one representative unit name below exercises every allowed
      // character at least once, all accepted together.
      const r = runScript(shell, "unit a-Z0@nginx.service:unit_9");
      expect(r.exitCode).toBe(0);
      expect(r.cmd).toEqual(unitArgv("a-Z0@nginx.service:unit_9"));
    });
  });

  describe("the forbidden-commands fixture walk (test/fixtures/observe/vm-forbidden-commands.json)", () => {
    // Every entry — every disallowed systemctl/journalctl verb and flag,
    // every package manager, sudo, kill, shutdown/reboot/poweroff/halt, and
    // every `unit`/`journal`/`kernel` sub-verb or stray flag SRD §6.4 names
    // as forbidden — must be refused: exit 77, the refusal prefix, and no
    // recorded invocation. This is the SRD's own revert check for
    // journal/kernel's `--vacuum-time=1s` entries: letting a `--`-prefixed
    // token reach journalctl's argv turns exactly those rows red.
    test.each(VM_FORBIDDEN_COMMANDS.entries.map((e) => [e.command] as [string]))("%s is refused, no invocation recorded", (command) => {
      const r = runScript(shell, command);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.cmd).toBeNull();
    });
  });
});
