/**
 * `scripts/observe/docker-forced-command` is the whole of what the
 * `observer-docker` credential can do (SRD-OBSERVER-ROLES §5.2, §5.4; Phase 4
 * task 4.1 landed `ps`, `inspect`, `info` and `version`; round 2 task 4.3
 * adds `logs`, `stats`, `top` and `events`, plus the fixed `ps` template).
 *
 * sshd runs this script directly for the enrolled key
 * (`restrict,command="<installed path>"`, §5.7), with NO arguments of its
 * own — every case here spawns the REAL script file exactly that way, with
 * `SSH_ORIGINAL_COMMAND` set in its environment and nothing else, and a
 * recording fake `docker` first on `PATH`. Unlike `docker/observe-ssh`, this
 * script has no mutable state and no fixed filesystem location baked into
 * it (it only ever reads an environment variable and execs `docker`), so
 * there is no per-run copy to make here: the real file is what every case
 * below executes.
 *
 * The fake `docker` writes the argv it was handed, NUL-separated so an
 * element holding a space survives as one record, then emits whatever
 * stdout/stderr/exit code the case asked for. "No docker invocation
 * recorded" means that record file does not exist — the atomic
 * write-then-rename below is what makes that reliable even against a
 * process that never gets that far.
 *
 * Both fixed templates that predate this round (`INSPECT_FORMAT`,
 * `INFO_FORMAT`) and the one this round adds (`PS_FORMAT`) are read out of
 * the real script's own source, never retyped here: the "exact argv" tests
 * below build their expectations from the same strings the script runs, so
 * a wording change to a template shows up as a disclosure-assertion failure
 * (if it adds a forbidden field) rather than a silent pass against a stale
 * copy. The `events` terminating bound is read from the MEASURED fixture
 * (`test/fixtures/observe/docker-cli-shapes.json`), never typed by hand, so
 * a re-measurement that changes the bound turns that test red instead of
 * silently passing against a stale literal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
/** The real script. Executed directly by every case — see the header. */
const REAL_SCRIPT = join(ROOT, "scripts", "observe", "docker-forced-command");
const SRC = readFileSync(REAL_SCRIPT, "utf8");

/** One refusal message every case below can recognise, verb-agnostic. */
const REFUSAL_PREFIX = "docker-forced-command: refused";

/** Reads a `NAME='...'` single-quoted shell assignment out of the real script. */
function extractSingleQuoted(varName: string): string {
  const match = SRC.match(new RegExp(`${varName}='([^']*)'`));
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`could not find ${varName}='...' in ${REAL_SCRIPT}`);
  }
  return value;
}

/** The `"Key":{{json .Key}}` fields a fixed template selects, in the order they appear. */
function templateKeys(template: string): string[] {
  const keys: string[] = [];
  const re = /"([A-Za-z]+)":\{\{json /g;
  let m: RegExpExecArray | null;
  // biome-ignore lint: straightforward exec-loop over a global regex
  while ((m = re.exec(template)) !== null) keys.push(m[1] as string);
  return keys;
}

const INSPECT_FORMAT = extractSingleQuoted("INSPECT_FORMAT");
const INFO_FORMAT = extractSingleQuoted("INFO_FORMAT");
const PS_FORMAT = extractSingleQuoted("PS_FORMAT");
const JSON_FORMAT = extractSingleQuoted("JSON_FORMAT");

/** MEASURED, never hand-typed: test/fixtures/observe/docker-cli-shapes.json. */
const DOCKER_CLI_SHAPES = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "docker-cli-shapes.json"), "utf8")) as {
  ps: { key_set: string[] };
  events: { terminating_bound: string[]; action_allowlist: { filters: string[] } };
};
/** The exact `["--until", "<value>"]` pair this round's `events` verb must carry. */
const EVENTS_TERMINATING_BOUND: string[] = DOCKER_CLI_SHAPES.events.terminating_bound;
/** The lifecycle-and-health `--filter` words, measured to keep every `exec_*` command line out. */
const EVENTS_ACTION_FILTERS: string[] = DOCKER_CLI_SHAPES.events.action_allowlist.filters;
const EVENTS_FILTERS = extractSingleQuoted("EVENTS_FILTERS");

/** MEASURED, never hand-typed: test/fixtures/observe/docker-forbidden-verbs.json. */
const DOCKER_FORBIDDEN_VERBS = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "docker-forbidden-verbs.json"), "utf8")) as {
  entries: Array<{ command: string; source: string }>;
};

function psArgv(extra: string[] = []): string[] {
  return ["ps", "--no-trunc", "--format", PS_FORMAT, ...extra];
}
function inspectArgv(container: string): string[] {
  return ["inspect", "--type", "container", "--format", INSPECT_FORMAT, container];
}
function infoArgv(): string[] {
  return ["info", "--format", INFO_FORMAT];
}
function versionArgv(): string[] {
  return ["version", "--format", JSON_FORMAT];
}
function logsArgv(container: string, since: string, tail: string): string[] {
  return ["logs", "--timestamps", "--since", `${since}s`, "--tail", tail, container];
}
function statsArgv(container: string): string[] {
  return ["stats", "--no-stream", "--no-trunc", "--format", JSON_FORMAT, container];
}
function topArgv(container: string): string[] {
  return ["top", container];
}
function eventsArgv(since: string, container?: string): string[] {
  const base = ["events", "--since", `${since}s`, ...EVENTS_TERMINATING_BOUND, "--format", JSON_FORMAT, ...EVENTS_ACTION_FILTERS];
  return container ? [...base, "--filter", `container=${container}`] : base;
}

const FAKE_DOCKER = `#!/bin/sh
# Recording fake docker for test/unit/observe-docker-forced-command.test.ts.
# Never contacts anything real.
set -u
rec=\${FAKE_DOCKER_RECORD_DIR:?}
printf '%s\\0' "$@" > "$rec/argv.partial"
mv "$rec/argv.partial" "$rec/argv"
printf '%s' "\${FAKE_DOCKER_STDOUT:-}"
if [ -n "\${FAKE_DOCKER_STDERR:-}" ]; then
  printf '%s' "\${FAKE_DOCKER_STDERR}" >&2
fi
exit "\${FAKE_DOCKER_EXIT:-0}"
`;

let scratch = "";
let fakeBin = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "test-docker-forced-command-"));
  fakeBin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER);
  chmodSync(join(fakeBin, "docker"), 0o755);
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
  /** The argv `docker` was called with, or null when it was never invoked. */
  docker: string[] | null;
}

function readDockerRecord(rec: string): string[] | null {
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
 */
function runScript(shell: string, sshOriginalCommand: string | undefined, opts: RunOpts = {}, cwd = scratch): Run {
  const rec = mkdtempSync(join(scratch, "rec-"));
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_DOCKER_RECORD_DIR: rec,
    FAKE_DOCKER_EXIT: String(opts.exit ?? 0),
    FAKE_DOCKER_STDOUT: opts.stdout ?? "",
    FAKE_DOCKER_STDERR: opts.stderr ?? "",
  };
  if (sshOriginalCommand !== undefined) {
    env.SSH_ORIGINAL_COMMAND = sshOriginalCommand;
  }
  const proc = Bun.spawnSync([shell, REAL_SCRIPT], { env, cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    docker: readDockerRecord(rec),
  };
}

describe("the fixed templates (SRD §0.3, §5.4) — the disclosure assertion", () => {
  test("all three fixed templates were found in the real script and use docker's json function", () => {
    expect(INSPECT_FORMAT).toContain("{{json ");
    expect(INFO_FORMAT).toContain("{{json ");
    expect(PS_FORMAT).toContain("{{json ");
    expect(JSON_FORMAT).toBe("{{json .}}");
  });

  test("the inspect template selects id, name, image, created, state, restart count, restart policy, labels and ports", () => {
    for (const field of [
      ".Id",
      ".Name",
      ".Config.Image",
      ".Created",
      ".State",
      ".RestartCount",
      ".HostConfig.RestartPolicy",
      ".Config.Labels",
      ".NetworkSettings.Ports",
    ]) {
      expect(INSPECT_FORMAT).toContain(field);
    }
  });

  test("the inspect template never discloses .Config.Env or .Mounts", () => {
    // REVERT CHECK (SRD §12 task 4.1): adding `.Config.Env` to INSPECT_FORMAT
    // in the real script must turn this assertion red.
    expect(INSPECT_FORMAT).not.toContain(".Config.Env");
    expect(INSPECT_FORMAT).not.toContain(".Mounts");
  });

  test("the info template selects only version, OS, kernel, architecture, CPU count, total memory, container and image counts, storage driver and cgroup driver", () => {
    for (const field of [
      ".ServerVersion",
      ".OperatingSystem",
      ".KernelVersion",
      ".Architecture",
      ".NCPU",
      ".MemTotal",
      ".Containers",
      ".Images",
      ".Driver",
      ".CgroupDriver",
    ]) {
      expect(INFO_FORMAT).toContain(field);
    }
  });

  test("the info template never discloses HttpProxy, HttpsProxy, NoProxy, RegistryConfig, daemon Labels, or swarm details", () => {
    for (const forbidden of ["HttpProxy", "HttpsProxy", "NoProxy", "RegistryConfig", "Swarm", ".Labels"]) {
      expect(INFO_FORMAT).not.toContain(forbidden);
    }
  });
});

describe("the fixed ps template (round 2 PM decision) — the disclosure assertion", () => {
  const EXPECTED_PS_KEYS = ["ID", "Names", "Image", "Command", "CreatedAt", "RunningFor", "State", "Status", "HealthStatus", "Ports", "Labels", "Networks"];

  test("the ps template's key list equals exactly the twelve named keys", () => {
    expect(templateKeys(PS_FORMAT)).toEqual(EXPECTED_PS_KEYS);
  });

  test("every ps template key is in the fixture's measured ps key set (test/fixtures/observe/docker-cli-shapes.json → .ps.key_set)", () => {
    for (const key of EXPECTED_PS_KEYS) {
      expect(DOCKER_CLI_SHAPES.ps.key_set).toContain(key);
    }
  });

  test("the ps template never discloses Mounts, LocalVolumes, Size or Platform", () => {
    // REVERT CHECK: adding "Mounts" (or any of the other three) back to
    // PS_FORMAT in the real script must turn this assertion red. Mounts in
    // particular carries a bind mount's host source path — the same class
    // of disclosure the inspect template above excludes.
    for (const forbidden of ["Mounts", "LocalVolumes", "Size", "Platform"]) {
      expect(PS_FORMAT).not.toContain(forbidden);
    }
  });
});

describe("the real script's safety invariants", () => {
  test("never calls eval outside a comment", () => {
    const code = SRC.split("\n").filter((line) => !/^\s*#/.test(line));
    expect(code.some((line) => /(^|[^A-Za-z0-9_])eval\b/.test(line))).toBe(false);
  });

  test("turns globbing off before either unquoted re-split", () => {
    const lines = SRC.split("\n");
    const setF = lines.indexOf("set -f");
    const firstUnquotedResplit = lines.findIndex((l) => l.includes("set -- ${"));
    expect(setF).toBeGreaterThanOrEqual(0);
    expect(firstUnquotedResplit).toBeGreaterThan(setF);
  });

  test("the file is executable", () => {
    const mode = statSync(REAL_SCRIPT).mode & 0o777;
    expect(mode & 0o100).not.toBe(0); // owner-executable
  });
});

test("at least one POSIX shell is available to run the script", () => {
  expect(shells().length).toBeGreaterThanOrEqual(1);
});

describe.each(shells())("scripts/observe/docker-forced-command under %s", (shell) => {
  describe("the exact docker argv per verb and argument shape", () => {
    test("ps: no arguments", () => {
      const r = runScript(shell, "ps");
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv());
    });

    test("ps: all", () => {
      const r = runScript(shell, "ps all");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv(["--all"]));
    });

    test("ps: one name= filter", () => {
      const r = runScript(shell, "ps name=web-1");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv(["--filter", "name=web-1"]));
    });

    test("ps: one label= filter", () => {
      const r = runScript(shell, "ps label=com.example.tier=db");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv(["--filter", "label=com.example.tier=db"]));
    });

    test("ps: all plus multiple filters, applied in the order given", () => {
      const r = runScript(shell, "ps all name=web-1 label=com.example.tier=db");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv(["--all", "--filter", "name=web-1", "--filter", "label=com.example.tier=db"]));
    });

    test("ps: 'all' appearing after the filters still applies --all", () => {
      const r = runScript(shell, "ps name=web-1 all");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(psArgv(["--all", "--filter", "name=web-1"]));
    });

    test("inspect: one container", () => {
      const r = runScript(shell, "inspect web-1");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(inspectArgv("web-1"));
    });

    test("info: no arguments", () => {
      const r = runScript(shell, "info");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(infoArgv());
    });

    test("version: no arguments", () => {
      const r = runScript(shell, "version");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(versionArgv());
    });

    test("logs: container, since=, tail= in written order", () => {
      const r = runScript(shell, "logs web-1 since=60s tail=10");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "60", "10"));
    });

    test("logs: since= and tail= reversed still produce the same, canonically-ordered argv", () => {
      const r = runScript(shell, "logs web-1 tail=10 since=60s");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "60", "10"));
    });

    test("logs: tail=0 is accepted", () => {
      const r = runScript(shell, "logs web-1 since=60s tail=0");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "60", "0"));
    });

    test("logs: tail at the 500 cap is accepted", () => {
      const r = runScript(shell, "logs web-1 since=60s tail=500");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "60", "500"));
    });

    test("logs: leading zeros in since= and tail= are accepted and passed through unnormalised", () => {
      const r = runScript(shell, "logs web-1 since=007s tail=007");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "007", "007"));
    });

    test("logs: a since= digit string at the 10-digit cap is accepted", () => {
      const since = "1".repeat(10);
      const r = runScript(shell, `logs web-1 since=${since}s tail=10`);
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", since, "10"));
    });

    test("stats: one container", () => {
      const r = runScript(shell, "stats web-1");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(statsArgv("web-1"));
    });

    test("top: one container", () => {
      const r = runScript(shell, "top web-1");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(topArgv("web-1"));
    });

    test("events: since= only carries the measured terminating bound from the fixture", () => {
      const r = runScript(shell, "events since=60s");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv("60"));
    });

    test("events: since= plus container=", () => {
      const r = runScript(shell, "events since=60s container=web-1");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv("60", "web-1"));
    });

    test("events: container= before since= still produces the same, canonically-ordered argv", () => {
      const r = runScript(shell, "events container=web-1 since=60s");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv("60", "web-1"));
    });

    test("events: the filter list is the measured one, and no exec_* action is in it", () => {
      expect(EVENTS_FILTERS.split(" ")).toEqual(EVENTS_ACTION_FILTERS);
      const r = runScript(shell, "events since=60s");
      expect(r.exitCode).toBe(0);
      const events = (r.docker ?? []).filter((w) => w.startsWith("event="));
      expect(events).toContain("event=health_status");
      expect(events.filter((w) => w.startsWith("event=exec_"))).toEqual([]);
      expect(r.docker).toContain("type=container");
    });
  });

  describe("docker's own exit status and output reach the caller unchanged", () => {
    test("stdout, stderr and a non-zero exit code all pass through exec", () => {
      const r = runScript(shell, "version", { exit: 3, stdout: "hello-stdout\n", stderr: "hello-stderr\n" });
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toBe("hello-stdout\n");
      expect(r.stderr).toBe("hello-stderr\n");
      expect(r.docker).toEqual(versionArgv());
    });

    test("a 77 from docker itself is not relabelled as this script's own refusal", () => {
      const r = runScript(shell, "version", { exit: 77, stderr: "docker: something remote\n" });
      expect(r.exitCode).toBe(77);
      expect(r.stderr).not.toContain(REFUSAL_PREFIX);
      expect(r.docker).toEqual(versionArgv());
    });
  });

  describe("a missing or empty SSH_ORIGINAL_COMMAND is refused, not read as any verb", () => {
    test("the variable is not set at all", () => {
      const r = runScript(shell, undefined);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.docker).toBeNull();
    });

    test("the variable is set to the empty string", () => {
      const r = runScript(shell, "");
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.docker).toBeNull();
    });

    test("the variable holds only whitespace", () => {
      const r = runScript(shell, "   \t  ");
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain("SSH_ORIGINAL_COMMAND");
      expect(r.docker).toBeNull();
    });
  });

  describe("refusals: exit 77, the verb named on stderr, and no docker invocation", () => {
    // [label, SSH_ORIGINAL_COMMAND, substring stderr must contain]
    const cases: Array<[string, string, string]> = [
      ["an unknown verb", "restart web-1", "restart"],
      ["a mutating verb from the illustrative forbidden list (SRD §5.4)", "rm web-1", "rm"],
      ["another illustrative forbidden verb", "exec web-1", "exec"],
      ["a disclosure-shaped verb refused on its own grounds (SRD §5.4)", "cp web-1", "cp"],
      ["inspect with zero arguments", "inspect", "inspect"],
      ["inspect with two arguments", "inspect web-1 web-2", "inspect"],
      ["inspect: container fails Docker's name grammar (bad character)", "inspect web!1", "inspect"],
      ["inspect: container fails Docker's name grammar (leading '-')", "inspect -web-1", "inspect"],
      ["inspect: container longer than 128 bytes", `inspect ${"a".repeat(129)}`, "inspect"],
      ["info with an argument", "info extra", "info"],
      ["version with an argument", "version extra", "version"],
      ["ps: an argument that is neither 'all' nor name=/label=", "ps foo", "ps"],
      ["ps: a bare '-a' argument", "ps -a", "ps"],
      ["ps: a name= value with a leading '-'", "ps name=-x", "ps"],
      ["ps: a name= value that is empty", "ps name=", "ps"],
      ["ps: a label= with no second '='", "ps label=onlykey", "ps"],
      ["ps: a label= key with a leading '-'", "ps label=-k=v", "ps"],
      ["ps: a label= value containing a second '='", "ps label=k=v=extra", "ps"],
      ["logs: missing both since= and tail=", "logs web-1", "logs"],
      ["logs: missing tail=", "logs web-1 since=60s", "logs"],
      ["logs: missing since=", "logs web-1 tail=10", "logs"],
      ["logs: since= repeated, tail= never given", "logs web-1 since=60s since=90s", "logs"],
      ["logs: tail= repeated, since= never given", "logs web-1 tail=10 tail=20", "logs"],
      ["logs: an extra token after both keys (--follow)", "logs web-1 since=60s tail=10 --follow", "logs"],
      ["logs: an extra token after both keys (follow=true)", "logs web-1 since=60s tail=10 follow=true", "logs"],
      ["logs: tail= is not an integer", "logs web-1 since=60s tail=abc", "logs"],
      ["logs: tail= exceeds the 500 cap", "logs web-1 since=60s tail=501", "logs"],
      ["logs: since= is missing its trailing 's'", "logs web-1 since=60 tail=10", "logs"],
      ["logs: since= digit string longer than the 10-digit cap", `logs web-1 since=${"1".repeat(11)}s tail=10`, "logs"],
      ["logs: container fails Docker's name grammar", "logs -web-1 since=60s tail=10", "logs"],
      ["stats with zero arguments (a bare 'stats' would stream every container)", "stats", "stats"],
      ["stats with two arguments", "stats web-1 web-2", "stats"],
      ["stats: container fails Docker's name grammar", "stats -web-1", "stats"],
      ["top with zero arguments", "top", "top"],
      ["top with two arguments", "top web-1 web-2", "top"],
      ["top: container fails Docker's name grammar", "top -web-1", "top"],
      ["events: missing since=", "events container=web-1", "events"],
      ["events: an unrecognised argument", "events since=60s foo", "events"],
      ["events: container= fails Docker's name grammar", "events since=60s container=-web-1", "events"],
      ["events: since= digit string longer than the 10-digit cap", `events since=${"1".repeat(11)}s`, "events"],
      ["events: since= given twice", "events since=60s since=120s", "events"],
      ["events: container= given twice", "events since=60s container=web-1 container=web-2", "events"],
      ["a verb with a leading '-'", "-V web-1", "(unrecognised)"],
      ["a verb starting with a digit", "1ps web-1", "(unrecognised)"],
      ["a verb longer than 32 characters", `${"p".repeat(33)} web-1`, "(unrecognised)"],
      ["a verb holding an uppercase letter", "Inspect web-1", "(unrecognised)"],
    ];
    test.each(cases)("%s", (_label, cmd, expectSubstring) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain(expectSubstring);
      expect(r.docker).toBeNull();
    });
  });

  describe("a leading '-' anywhere is refused by construction, never reaches docker as a flag", () => {
    const cases: Array<[string, string]> = [
      ["the verb position", "-V"],
      ["a bare ps argument", "ps -a"],
      ["a ps name= value", "ps name=-x"],
      ["a ps label= key", "ps label=-k=v"],
      ["a ps label= value", "ps label=k=-v"],
      ["the inspect container", "inspect -web-1"],
      ["the logs container", "logs -web-1 since=60s tail=10"],
      ["the stats container", "stats -web-1"],
      ["the top container", "top -web-1"],
      ["an events container= value", "events since=60s container=-web-1"],
    ];
    test.each(cases)("%s", (_label, cmd) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.docker).toBeNull();
    });
  });

  test("an embedded newline inside a token is refused and never echoed into stderr", () => {
    const r = runScript(shell, "ps name=a\nrm-everything");
    expect(r.exitCode).toBe(77);
    expect(r.stderr).not.toContain("rm-everything");
    expect(r.docker).toBeNull();
  });

  describe("set -f: a literal '*' is refused by grammar, never glob-expanded", () => {
    test("a name= value of '*', run where a matching filename exists, still refuses", () => {
      const dir = mkdtempSync(join(scratch, "glob-cwd-"));
      writeFileSync(join(dir, "web-1"), "");
      const r = runScript(shell, "ps name=*", {}, dir);
      expect(r.exitCode).toBe(77);
      expect(r.docker).toBeNull();
    });
  });

  test("a container name at the 128-byte limit reaches docker; one byte over is refused", () => {
    const at = "a".repeat(128);
    const over = "a".repeat(129);
    const ok = runScript(shell, `inspect ${at}`);
    expect(ok.exitCode).toBe(0);
    expect(ok.docker).toEqual(inspectArgv(at));
    const refused = runScript(shell, `inspect ${over}`);
    expect(refused.exitCode).toBe(77);
    expect(refused.docker).toBeNull();
  });

  describe("the forbidden-verbs fixture walk (test/fixtures/observe/docker-forbidden-verbs.json)", () => {
    // Every entry — including the three that start with an allowed verb
    // (`stats`, `logs --follow`, `logs web since=60s tail=10 --follow`) —
    // must be refused by the grammar, exit 77, with no docker invocation.
    // This is the SRD's revert check: adding a verb (e.g. `restart`) to the
    // case statement turns the test named for that entry's command red.
    test.each(DOCKER_FORBIDDEN_VERBS.entries.map((e) => [e.command] as [string]))("%s is refused, no docker invocation recorded", (command) => {
      const r = runScript(shell, command);
      expect(r.exitCode).toBe(77);
      expect(r.docker).toBeNull();
    });
  });
});
