/**
 * `scripts/observe/docker-forced-command` is the whole of what the
 * `observer-docker` credential can do (SRD-OBSERVER-ROLES §5.2, §5.4; task
 * 4.1 landed `ps`, `inspect`, `info` and `version`; task 4.3 adds `logs`,
 * `stats`, `top` and `events`, plus the fixed `ps` template).
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
 * All three fixed templates (`INSPECT_FORMAT`, `INFO_FORMAT` and
 * `PS_FORMAT`) are read out of the real script's own source, never retyped
 * here: the "exact argv" tests below build their expectations from the same
 * strings the script runs, so a wording change to a template shows up as a
 * disclosure-assertion failure
 * (if it adds a forbidden field) rather than a silent pass against a stale
 * copy. The `events` terminating bound is read from the MEASURED fixture
 * (`test/fixtures/observe/docker-cli-shapes.json`), never typed by hand, so
 * a re-measurement that changes the bound turns that test red instead of
 * silently passing against a stale literal.
 *
 * One deliberate exception: the EXPECTED_*_FORMAT
 * constants below ARE retyped by hand, because they exist specifically to
 * catch a change to the real script's templates — extracting the value
 * under test from the same file under test cannot do that (it would only
 * ever compare the template to itself). `templateKeys`'s `[A-Za-z]+` key
 * regex also cannot see a nested object or a `{{with}}` block, so a
 * key-list check alone lets a widened template through unnoticed. The
 * EXPECTED_*_FORMAT constants are the one place in this file a template is
 * pinned as a full literal, on purpose.
 *
 * ## Shell coverage
 *
 * `shells()` runs every case under each POSIX shell it finds, deduplicated
 * by realpath: `/bin/sh` (bash 3.2 in sh mode on macOS, dash on Debian) and
 * `dash` where it is installed. busybox sh, the `/bin/sh` of `docker:dind`,
 * is not run here; `observe-docker-forced-command-rendered.test.ts` reads
 * back a real run of this script under it.
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

/** Reads a `NAME=<digits>` bare (unquoted) shell assignment out of the real script. */
function extractBareDigits(varName: string): string {
  const match = SRC.match(new RegExp(`${varName}=([0-9]+)`));
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`could not find ${varName}=<digits> in ${REAL_SCRIPT}`);
  }
  return value;
}

/** The digit-count cap on `since=<N>s` and `tail=<M>` (header, argument-grammar section, choice 3). */
const DIGITS_MAX = extractBareDigits("DIGITS_MAX");

/**
 * Hand-typed pins — see the header for why these three
 * are the deliberate exception to "never retyped here". Each is the exact,
 * full literal the real script's INSPECT_FORMAT / INFO_FORMAT / PS_FORMAT
 * must equal, byte for byte.
 */
const EXPECTED_INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"created":{{json .Created}},"state":{"status":{{json .State.Status}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"oom_killed":{{json .State.OOMKilled}},"dead":{{json .State.Dead}},"exit_code":{{json .State.ExitCode}},"error":{{json .State.Error}},"started_at":{{json .State.StartedAt}},"finished_at":{{json .State.FinishedAt}},"health":{{with index .State "Health"}}{"status":{{json .Status}},"failing_streak":{{json .FailingStreak}}}{{else}}null{{end}}},"restart_count":{{json .RestartCount}},"restart_policy":{{json .HostConfig.RestartPolicy}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}}}';
const EXPECTED_INFO_FORMAT =
  '{"version":{{json .ServerVersion}},"os":{{json .OperatingSystem}},"kernel":{{json .KernelVersion}},"architecture":{{json .Architecture}},"cpus":{{json .NCPU}},"mem_total":{{json .MemTotal}},"containers":{{json .Containers}},"images":{{json .Images}},"storage_driver":{{json .Driver}},"cgroup_driver":{{json .CgroupDriver}}}';
const EXPECTED_PS_FORMAT =
  '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"Command":{{json .Command}},"CreatedAt":{{json .CreatedAt}},"RunningFor":{{json .RunningFor}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}},"Labels":{{json .Labels}},"Networks":{{json .Networks}}}';

/** MEASURED, never hand-typed: test/fixtures/observe/docker-cli-shapes.json. */
const DOCKER_CLI_SHAPES = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "docker-cli-shapes.json"), "utf8")) as {
  ps: { key_set: string[] };
  events: { terminating_bound: string[]; action_allowlist: { filters: string[] } };
};
/** The exact `["--until", "<value>"]` pair the `events` verb must carry. */
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
 *
 * `extraEnv` merges additional variables into that
 * same closed environment — used to simulate a caller whose IFS reaches
 * this script already set (e.g. `IFS: ":"`), to prove IFS is pinned rather
 * than inherited.
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
    FAKE_DOCKER_RECORD_DIR: rec,
    FAKE_DOCKER_EXIT: String(opts.exit ?? 0),
    FAKE_DOCKER_STDOUT: opts.stdout ?? "",
    FAKE_DOCKER_STDERR: opts.stderr ?? "",
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

  test("the inspect template selects id, name, image, created, the named state subfields, restart count, restart policy, labels and ports", () => {
    for (const field of [
      ".Id",
      ".Name",
      ".Config.Image",
      ".Created",
      ".State.Status",
      ".State.Running",
      ".State.Paused",
      ".State.Restarting",
      ".State.OOMKilled",
      ".State.Dead",
      ".State.ExitCode",
      ".State.Error",
      ".State.StartedAt",
      ".State.FinishedAt",
      ".RestartCount",
      ".HostConfig.RestartPolicy",
      ".Config.Labels",
      ".NetworkSettings.Ports",
    ]) {
      expect(INSPECT_FORMAT).toContain(field);
    }
  });

  test("the inspect template builds health as {status, failing_streak} or null, via index rather than a direct .State.Health access", () => {
    expect(INSPECT_FORMAT).toContain('{{with index .State "Health"}}');
    expect(INSPECT_FORMAT).toContain("{{else}}null{{end}}");
    expect(INSPECT_FORMAT).toContain('"failing_streak":{{json .FailingStreak}}');
  });

  test("the inspect template never discloses .Config.Env or .Mounts", () => {
    // REVERT CHECK (SRD §12 task 4.1): adding `.Config.Env` to INSPECT_FORMAT
    // in the real script must turn this assertion red.
    expect(INSPECT_FORMAT).not.toContain(".Config.Env");
    expect(INSPECT_FORMAT).not.toContain(".Mounts");
  });

  test("the inspect template never returns the whole of .State", () => {
    // REVERT CHECK: replacing the field-by-field `state` object in
    // INSPECT_FORMAT with `{{json .State}}` in the real script must turn
    // this assertion red.
    expect(INSPECT_FORMAT).not.toContain("{{json .State}}");
  });

  test("the inspect template never returns a healthcheck run's log output", () => {
    // REVERT CHECK: the whole of `.State` (or `.State.Health` rendered with
    // `{{json}}`) carries `.State.Health.Log[].Output` — a healthcheck's
    // stdout. Nothing in INSPECT_FORMAT may contain `.Log`.
    expect(INSPECT_FORMAT).not.toContain(".Log");
  });

  test("the inspect template accesses .State.Health only through `index`, never a direct dotted access", () => {
    // REVERT CHECK: writing `{{if .State.Health}}` (or any other direct
    // `.State.Health` access) instead of `{{with index .State "Health"}}`
    // in the real script must turn this assertion red — see the header for
    // why a direct access breaks the credential on every container with no
    // healthcheck configured.
    expect(INSPECT_FORMAT).not.toContain(".State.Health");
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

describe("the fixed ps template — the disclosure assertion", () => {
  const EXPECTED_PS_KEYS = ["ID", "Names", "Image", "Command", "CreatedAt", "RunningFor", "State", "Status", "Ports", "Labels", "Networks"];

  test("the ps template's key list equals exactly the eleven named keys", () => {
    expect(templateKeys(PS_FORMAT)).toEqual(EXPECTED_PS_KEYS);
  });

  test("the ps template's key list has exactly 11 entries and never HealthStatus", () => {
    // REVERT CHECK: adding "HealthStatus" back to PS_FORMAT in the real
    // script (it exits 1 on docker CLI < 29.5.0 — see the header) must turn
    // this assertion red.
    const keys = templateKeys(PS_FORMAT);
    expect(keys).toHaveLength(11);
    expect(keys).not.toContain("HealthStatus");
    expect(PS_FORMAT).not.toContain("HealthStatus");
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

describe("the fixed templates equal their full literal string exactly", () => {
  // A key-list or toContain check cannot see a nested object or a `{{with}}`
  // block, so a widened template can slip past those. These three compare
  // the whole template, byte for byte, against a hand-typed pin — see the
  // header for why that pin is the one deliberate exception to "never
  // retyped here" in this file.
  test("INSPECT_FORMAT equals its full literal string exactly", () => {
    expect(INSPECT_FORMAT).toBe(EXPECTED_INSPECT_FORMAT);
  });

  test("INFO_FORMAT equals its full literal string exactly", () => {
    expect(INFO_FORMAT).toBe(EXPECTED_INFO_FORMAT);
  });

  test("PS_FORMAT equals its full literal string exactly", () => {
    expect(PS_FORMAT).toBe(EXPECTED_PS_FORMAT);
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

  test("pins IFS to the POSIX default before either unquoted re-split, and restores it to that same pinned constant rather than an inherited value", () => {
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
});

test("at least one POSIX shell is available to run the script", () => {
  expect(shells().length).toBeGreaterThanOrEqual(1);
});

describe("the forbidden-verbs fixture is populated (test/fixtures/observe/docker-forbidden-verbs.json)", () => {
  // The forbidden-verbs walk below is a `test.each` over `entries`, and a
  // `test.each` over an empty array runs no tests and passes. These two fail
  // on an empty or truncated fixture. NAMED_FORBIDDEN is SRD §5.4's list,
  // where a bare `stats` is the streaming form.
  const NAMED_FORBIDDEN = [
    "run",
    "create",
    "start",
    "stop",
    "restart",
    "kill",
    "pause",
    "unpause",
    "rm",
    "rmi",
    "exec",
    "attach",
    "cp",
    "export",
    "save",
    "commit",
    "update",
    "rename",
    "pull",
    "push",
    "build",
    "compose",
    "network",
    "volume",
    "system",
    "context",
    "plugin",
    "swarm",
    "service",
    "system dial-stdio",
    "logs --follow",
    "stats",
  ];

  test("every command SRD §5.4 names as forbidden is present in the fixture's entries", () => {
    const commands = DOCKER_FORBIDDEN_VERBS.entries.map((e) => e.command);
    for (const cmd of NAMED_FORBIDDEN) {
      expect(commands).toContain(cmd);
    }
  });

  test("entries holds more than the named set alone", () => {
    expect(DOCKER_FORBIDDEN_VERBS.entries.length).toBeGreaterThan(NAMED_FORBIDDEN.length);
  });
});

describe("events filter prefix safety", () => {
  // With `event=health_status` among the filters, the daemon matches `event=`
  // values as prefixes: `event=exec` alone matched nothing, and beside
  // `event=health_status` it matched exec_create, exec_start and exec_die
  // (docker 28.5.2 and 29.7.2, .events_prefix_match in
  // docker-forced-command-rendered.json). The per-shell exec_* check below only
  // sees a value that starts `event=exec_`, so this rejects any value that is a
  // prefix of an exec_* action, the empty value included.
  test("no event= value in EVENTS_FILTERS is a prefix of exec_create, exec_start, exec_die or exec_detach", () => {
    const EXEC_ACTIONS = ["exec_create", "exec_start", "exec_die", "exec_detach"];
    const values = EVENTS_FILTERS.split(" ")
      .filter((w) => w.startsWith("event="))
      .map((w) => w.slice("event=".length));
    for (const value of values) {
      for (const action of EXEC_ACTIONS) {
        expect(action.startsWith(value)).toBe(false);
      }
    }
  });
});

/**
 * Every printable ASCII byte outside the name grammar's `[A-Za-z0-9._-]`
 * (`is_docker_name` in the script), computed. Space, tab and newline are
 * covered by the re-split and embedded-newline cases.
 */
const NAME_GRAMMAR_ALLOWED_CHARS = new Set<string>([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), // A-Z
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)), // a-z
  ...Array.from({ length: 10 }, (_, i) => String(i)), // 0-9
  ".",
  "_",
  "-",
]);
const NAME_GRAMMAR_DISALLOWED_CHARS: string[] = [];
for (let code = 0x21; code <= 0x7e; code++) {
  const ch = String.fromCharCode(code);
  if (!NAME_GRAMMAR_ALLOWED_CHARS.has(ch)) NAME_GRAMMAR_DISALLOWED_CHARS.push(ch);
}

/** The five places a name-grammar value appears in the verb grammar. */
const NAME_GRAMMAR_POSITIONS: Array<{
  label: string;
  /** SSH_ORIGINAL_COMMAND with `c` spliced into the middle of an otherwise-valid name. */
  middle: (c: string) => string;
  /** SSH_ORIGINAL_COMMAND with `c` as the name's first character. */
  leading: (c: string) => string;
}> = [
  { label: "inspect", middle: (c) => `inspect web${c}1`, leading: (c) => `inspect ${c}web1` },
  { label: "ps name=", middle: (c) => `ps name=web${c}1`, leading: (c) => `ps name=${c}web1` },
  { label: "ps label= key", middle: (c) => `ps label=we${c}b=x`, leading: (c) => `ps label=${c}web=x` },
  { label: "ps label= value", middle: (c) => `ps label=k=web${c}1`, leading: (c) => `ps label=k=${c}web1` },
  {
    label: "events container=",
    middle: (c) => `events since=60s container=web${c}1`,
    leading: (c) => `events since=60s container=${c}web1`,
  },
];

/** [test label, SSH_ORIGINAL_COMMAND] rows: every disallowed character in every position, plus a bad leading character in every position. */
const NAME_GRAMMAR_CASES: Array<[string, string]> = [
  ...NAME_GRAMMAR_DISALLOWED_CHARS.flatMap((c) =>
    NAME_GRAMMAR_POSITIONS.map((pos): [string, string] => [`name grammar refuses '${c}' in ${pos.label}`, pos.middle(c)]),
  ),
  ...[".", "_", "-"].flatMap((c) =>
    NAME_GRAMMAR_POSITIONS.map((pos): [string, string] => [`name grammar refuses leading '${c}' in ${pos.label}`, pos.leading(c)]),
  ),
];

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

    test("logs: tail=08 is compared as decimal, not octal, and passed through as given", () => {
      const r = runScript(shell, "logs web-1 since=60s tail=08");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "60", "08"));
    });

    test("logs: a since= digit string at the 9-digit cap is accepted", () => {
      const since = "1".repeat(9);
      const r = runScript(shell, `logs web-1 since=${since}s tail=10`);
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", since, "10"));
    });

    test("logs: since=1s, the 1-second minimum, is accepted", () => {
      const r = runScript(shell, "logs web-1 since=1s tail=10");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "1", "10"));
    });

    test("logs: since=001s, the 1-second minimum written with leading zeros, is accepted", () => {
      const r = runScript(shell, "logs web-1 since=001s tail=10");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(logsArgv("web-1", "001", "10"));
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

    test("events: a since= digit string at the 9-digit cap is accepted", () => {
      const since = "1".repeat(9);
      const r = runScript(shell, `events since=${since}s`);
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv(since));
    });

    test("events: since=1s, the 1-second minimum, is accepted", () => {
      const r = runScript(shell, "events since=1s");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv("1"));
    });

    test("events: since=001s, the 1-second minimum written with leading zeros, is accepted", () => {
      const r = runScript(shell, "events since=001s");
      expect(r.exitCode).toBe(0);
      expect(r.docker).toEqual(eventsArgv("001"));
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

  describe("IFS: the caller's IFS never changes docker's argv", () => {
    // busybox sh, dash and bash all ignore an IFS inherited from the
    // environment (measured), so these two cannot go red if the script's IFS
    // pin is removed; the static "pins IFS" invariant above guards the pin.
    // These show end to end that docker's argv does not follow the caller's IFS.
    test("ps: all plus two filters produce the same argv whether or not IFS=: is inherited from the caller", () => {
      const withoutColonIfs = runScript(shell, "ps all name=web label=app=web");
      const withColonIfs = runScript(shell, "ps all name=web label=app=web", {}, scratch, { IFS: ":" });
      expect(withoutColonIfs.exitCode).toBe(0);
      expect(withColonIfs.exitCode).toBe(0);
      expect(withColonIfs.docker).toEqual(withoutColonIfs.docker);
      expect(withColonIfs.docker).toEqual(psArgv(["--all", "--filter", "name=web", "--filter", "label=app=web"]));
    });

    test("events: since= plus container= produce the same argv whether or not IFS=: is inherited from the caller", () => {
      const withoutColonIfs = runScript(shell, "events since=60s container=web");
      const withColonIfs = runScript(shell, "events since=60s container=web", {}, scratch, { IFS: ":" });
      expect(withoutColonIfs.exitCode).toBe(0);
      expect(withColonIfs.exitCode).toBe(0);
      expect(withColonIfs.docker).toEqual(withoutColonIfs.docker);
      expect(withColonIfs.docker).toEqual(eventsArgv("60", "web"));
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
    // [label, SSH_ORIGINAL_COMMAND, verb stderr names, reason stderr contains].
    // Exit 77 and the verb cannot tell which check refused a case, so a row
    // could pass while exercising the wrong one; the reason pins the check.
    // `logs` takes exactly three arguments, so a repeated key plus the other
    // key is four tokens, refused on the count before any once-check runs.
    const cases: Array<[string, string, string, string]> = [
      ["an unknown verb", "restart web-1", "restart", "not a recognised verb"],
      ["a mutating verb from the illustrative forbidden list (SRD §5.4)", "rm web-1", "rm", "not a recognised verb"],
      ["another illustrative forbidden verb", "exec web-1", "exec", "not a recognised verb"],
      ["a disclosure-shaped verb refused on its own grounds (SRD §5.4)", "cp web-1", "cp", "not a recognised verb"],
      ["inspect with zero arguments", "inspect", "inspect", "inspect takes exactly one argument, a container name; got 0"],
      ["inspect with two arguments", "inspect web-1 web-2", "inspect", "inspect takes exactly one argument, a container name; got 2"],
      ["inspect: container fails Docker's name grammar (bad character)", "inspect web!1", "inspect", "the container argument must match"],
      ["inspect: container fails Docker's name grammar (leading '-')", "inspect -web-1", "inspect", "the container argument must match"],
      ["inspect: container longer than 128 bytes", `inspect ${"a".repeat(129)}`, "inspect", "the container argument must match"],
      ["info with an argument", "info extra", "info", "info takes no arguments; got 1"],
      ["version with an argument", "version extra", "version", "version takes no arguments; got 1"],
      ["ps: an argument that is neither 'all' nor name=/label=", "ps foo", "ps", "arguments must be 'all', name=<n> or label=<k>=<v>"],
      ["ps: a bare '-a' argument", "ps -a", "ps", "arguments must be 'all', name=<n> or label=<k>=<v>"],
      ["ps: a name= value with a leading '-'", "ps name=-x", "ps", "a name= value must match"],
      ["ps: a name= value that is empty", "ps name=", "ps", "a name= value must match"],
      ["ps: a label= with no second '='", "ps label=onlykey", "ps", "a label= argument must be label=<key>=<value>"],
      ["ps: a label= key with a leading '-'", "ps label=-k=v", "ps", "a label= key must match"],
      ["ps: a label= value containing a second '='", "ps label=k=v=extra", "ps", "may not itself contain '='"],
      ["logs: missing both since= and tail=", "logs web-1", "logs", "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 1"],
      ["logs: missing tail=", "logs web-1 since=60s", "logs", "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 2"],
      ["logs: missing since=", "logs web-1 tail=10", "logs", "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 2"],
      ["logs: since= repeated, tail= never given", "logs web-1 since=60s since=90s", "logs", "since=<N>s may be given only once"],
      ["logs: tail= repeated, since= never given", "logs web-1 tail=10 tail=20", "logs", "tail=<M> may be given only once"],
      [
        "logs: since= repeated plus tail= (four tokens, refused on the count)",
        "logs web-1 since=1s since=2s tail=5",
        "logs",
        "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 4",
      ],
      [
        "logs: tail= repeated plus since= (four tokens, refused on the count)",
        "logs web-1 since=1s tail=5 tail=6",
        "logs",
        "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 4",
      ],
      [
        "logs: an extra token after both keys (--follow)",
        "logs web-1 since=60s tail=10 --follow",
        "logs",
        "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 4",
      ],
      [
        "logs: an extra token after both keys (follow=true)",
        "logs web-1 since=60s tail=10 follow=true",
        "logs",
        "logs takes exactly three arguments: a container, since=<N>s and tail=<M>; got 4",
      ],
      ["logs: tail= is not an integer", "logs web-1 since=60s tail=abc", "logs", `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`],
      ["logs: tail= exceeds the 500 cap", "logs web-1 since=60s tail=501", "logs", "tail must be <= 500"],
      ["logs: tail= has a leading '-' — not a digit string", "logs web-1 since=60s tail=-1", "logs", `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`],
      ["logs: tail= has a leading '+' — not a digit string", "logs web-1 since=60s tail=+5", "logs", `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`],
      ["logs: tail= is hex-shaped — not a digit string", "logs web-1 since=60s tail=0x10", "logs", `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`],
      ["logs: tail= is empty", "logs web-1 since=60s tail=", "logs", `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`],
      [
        "logs: tail= digit string longer than the 9-digit cap",
        `logs web-1 since=60s tail=${"1".repeat(10)}`,
        "logs",
        `a tail= value must be [0-9]{1,${DIGITS_MAX}} digits`,
      ],
      ["logs: since= is missing its trailing 's'", "logs web-1 since=60 tail=10", "logs", "arguments after the container must be since=<N>s or tail=<M>"],
      [
        "logs: since= digit string longer than the 9-digit cap",
        `logs web-1 since=${"1".repeat(10)}s tail=10`,
        "logs",
        `a since= value must be [0-9]{1,${DIGITS_MAX}} digits followed by 's'`,
      ],
      ["logs: since=0s is refused — a zero-second lookback", "logs web-1 since=0s tail=10", "logs", "a since= value must be at least 1 second"],
      [
        "logs: since=000s is refused — a zero-second lookback written with leading zeros",
        "logs web-1 since=000s tail=10",
        "logs",
        "a since= value must be at least 1 second",
      ],
      ["logs: container fails Docker's name grammar", "logs -web-1 since=60s tail=10", "logs", "the container argument must match"],
      [
        "stats with zero arguments (a bare 'stats' would stream every container)",
        "stats",
        "stats",
        "stats takes exactly one argument, a container name; got 0",
      ],
      ["stats with two arguments", "stats web-1 web-2", "stats", "stats takes exactly one argument, a container name; got 2"],
      ["stats: container fails Docker's name grammar", "stats -web-1", "stats", "the container argument must match"],
      ["top with zero arguments", "top", "top", "top takes exactly one argument, a container name; got 0"],
      ["top with two arguments", "top web-1 web-2", "top", "top takes exactly one argument, a container name; got 2"],
      ["top: container fails Docker's name grammar", "top -web-1", "top", "the container argument must match"],
      ["events: missing since=", "events container=web-1", "events", "since=<N>s is required"],
      ["events: an unrecognised argument", "events since=60s foo", "events", "arguments must be since=<N>s or container=<c>"],
      ["events: container= fails Docker's name grammar", "events since=60s container=-web-1", "events", "a container= value must match"],
      [
        "events: since= digit string longer than the 9-digit cap",
        `events since=${"1".repeat(10)}s`,
        "events",
        `a since= value must be [0-9]{1,${DIGITS_MAX}} digits followed by 's'`,
      ],
      ["events: since=0s is refused — a zero-second lookback", "events since=0s", "events", "a since= value must be at least 1 second"],
      [
        "events: since=000s is refused — a zero-second lookback written with leading zeros",
        "events since=000s",
        "events",
        "a since= value must be at least 1 second",
      ],
      ["events: since= given twice", "events since=60s since=120s", "events", "since=<N>s may be given only once"],
      ["events: container= given twice", "events since=60s container=web-1 container=web-2", "events", "container=<c> may be given only once"],
      [
        "ps: a newline between two valid tokens does not split them",
        "ps all\nname=web",
        "ps",
        "arguments must be 'all', name=<n> or label=<k>=<v>",
      ],
      ["inspect: container holding '/', outside the name grammar", "inspect web/1", "inspect", "the container argument must match"],
      ["ps: a name= value holding ':', outside the name grammar", "ps name=web:1", "ps", "a name= value must match"],
      ["ps: a label= key holding '@', outside the name grammar", "ps label=we@b=v", "ps", "a label= key must match"],
      ["ps: a label= value holding '+', outside the name grammar", "ps label=k=v+1", "ps", "a label= value must match"],
      [
        "events: a container= value holding '/', outside the name grammar",
        "events since=60s container=web/1",
        "events",
        "a container= value must match",
      ],
      [
        "logs: tail=0600 is compared as decimal and exceeds the 500 cap",
        "logs web-1 since=60s tail=0600",
        "logs",
        "tail must be <= 500",
      ],
      ["a verb with a leading '-'", "-V web-1", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb starting with a digit", "1ps web-1", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb longer than 32 characters", `${"p".repeat(33)} web-1`, "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
      ["a verb holding an uppercase letter", "Inspect web-1", "(unrecognised)", "the verb is not [a-z][a-z0-9-]{0,31}"],
    ];
    test.each(cases)("%s", (_label, cmd, expectSubstring, reasonSubstring) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(REFUSAL_PREFIX);
      expect(r.stderr).toContain(expectSubstring);
      expect(r.stderr).toContain(reasonSubstring);
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
    // `set -f` matters at the unquoted re-split, before any grammar check.
    // Without it, a token such as `web-*` becomes a matching filename from
    // the script's cwd, which passes the grammar and reaches docker. Each
    // test plants a file the whole token matches, so removing `set -f`
    // turns it red.
    test("inspect: a container value of 'web-*', run in a directory holding a file literally named 'web-1', still refuses", () => {
      const dir = mkdtempSync(join(scratch, "glob-cwd-"));
      writeFileSync(join(dir, "web-1"), "");
      const r = runScript(shell, "inspect web-*", {}, dir);
      expect(r.exitCode).toBe(77);
      expect(r.docker).toBeNull();
    });

    test("ps: a name= value of 'web-*', run in a directory holding a file literally named 'name=web-1', still refuses", () => {
      const dir = mkdtempSync(join(scratch, "glob-cwd-"));
      writeFileSync(join(dir, "name=web-1"), "");
      const r = runScript(shell, "ps name=web-*", {}, dir);
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

  describe("name grammar refuses every disallowed character, in every position a name appears", () => {
    // Rows assert the refusal, not its reason: a character such as '=' changes which half
    // of label=<k>=<v> the refusal names.
    test.each(NAME_GRAMMAR_CASES)("%s", (_label, cmd) => {
      const r = runScript(shell, cmd);
      expect(r.exitCode).toBe(77);
      expect(r.stderr.startsWith(REFUSAL_PREFIX)).toBe(true);
      expect(r.docker).toBeNull();
    });
  });
});
