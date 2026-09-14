/**
 * `docker/observe-ssh` is the only road from an observer worker to a Docker host
 * or VM (SRD-OBSERVER-ROLES §5.2, §6.2; Phase 3 task 3.2).
 *
 * These run the REAL shim under the host's POSIX shells, with a recording fake
 * `ssh` first on `PATH`. The fake writes the argv it was handed, NUL-separated
 * so an element holding a newline or a space survives as one record, plus the
 * mode, last byte and bytes of whatever file `-i` named, and then exits with a
 * code the test chooses. "No ssh invocation recorded" means that record file
 * does not exist.
 *
 * ## Why the key assertions read a fixture
 *
 * What OpenSSH does with a delivered key was MEASURED in the real worker
 * posture by `scripts/observe/characterise-ssh-transport`, and the result is
 * `test/fixtures/observe/ssh-transport-facts.json`. The SRD says engineers wire
 * that fixture rather than re-derive it, so the key-copy expectations below are
 * read off it: `copy_required` puts `-i` under `copy_dir` at `copy_mode`, and
 * `accepted_without_trailing_newline: false` makes the copy end in a newline
 * even when the delivered file does not. If a re-measurement ever flips one of
 * those facts, the pin block fails first and says which.
 *
 * ## Which shells
 *
 * The worker image's `/bin/sh` is Debian's dash, so dash is the shell that
 * matters. Every case runs under `/bin/sh` and under `dash` when one is on this
 * machine, de-duplicated by real path (on Debian they are the same binary; on
 * macOS `/bin/sh` is bash 3.2 in POSIX mode, a second implementation). The
 * shell is in every test name, so the run output says which ran.
 *
 * ## The key copy lands in the real /tmp
 *
 * The shim's copy location is a constant, deliberately not movable by any
 * variable (its header says why), so a test cannot redirect it into a scratch
 * directory. The copies these tests leave are fake key material, and `afterAll`
 * removes them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SHIM = join(ROOT, "docker", "observe-ssh");
const FACTS_PATH = join(ROOT, "test", "fixtures", "observe", "ssh-transport-facts.json");

interface TransportFacts {
  key_delivery: {
    delivered_mode: string;
    accepted_at_delivered_mode: boolean;
    copy_required: boolean;
    copy_dir: string;
    copy_mode: string;
    accepted_as_copy: boolean;
    accepted_without_trailing_newline: boolean;
  };
  proxy_command: { argv_value: string; round_trips: boolean };
  exit_codes: {
    success: number;
    remote_exit_77: number;
    host_key_mismatch: number;
    proxy_refused: number;
  };
}

const FACTS = JSON.parse(readFileSync(FACTS_PATH, "utf8")) as TransportFacts;

type Kind = "docker" | "vm";

/** Fake key material. Deliberately not PEM-shaped: nothing here is a real key. */
const KEY = "fake-observer-key-material-for-tests-only";
const DOCKER_TARGETS = "web-1 docker-host.example.com 22 observe\n";
const VM_TARGETS = "build-vm 10.0.0.12 2222 observe_vm\n";
const KNOWN_HOSTS = "docker-host.example.com ssh-ed25519 AAAAfakehostkeyfortestsonly\n";

/** The one line every shim refusal carries, and a remote 77 never does. */
const SHIM_REFUSAL = "refused before ssh ran";

/** Where the shim must put the key copy, derived from the measured facts. */
function keyCopyPath(kind: Kind): string {
  return `${FACTS.key_delivery.copy_dir}/observe-ssh-${kind}.key`;
}

const FAKE_SSH = `#!/bin/sh
# Recording fake ssh for test/unit/observe-ssh.test.ts. Never contacts anything.
set -u
rec=\${FAKE_SSH_RECORD_DIR:?}
printf '%s\\0' "$@" > "$rec/argv.partial"
key=
want=0
for a in "$@"; do
  if [ "$want" = 1 ]; then key=$a; break; fi
  [ "$a" = "-i" ] && want=1
done
if [ -n "$key" ] && [ -f "$key" ]; then
  stat -c %a "$key" 2>/dev/null > "$rec/key-mode" || stat -f %Lp "$key" > "$rec/key-mode"
  cat "$key" > "$rec/key-bytes"
fi
mv "$rec/argv.partial" "$rec/argv"
exit "\${FAKE_SSH_EXIT:-0}"
`;

let scratch = "";
let fakeBin = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "observe-ssh-test-"));
  fakeBin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(fakeBin, "ssh"), FAKE_SSH);
  chmodSync(join(fakeBin, "ssh"), 0o755);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  // The shim's fixed copy location, see the header. Fake material only.
  for (const kind of ["docker", "vm"] as const) rmSync(keyCopyPath(kind), { force: true });
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

interface World {
  dir: string;
  env: Record<string, string>;
  targets: string;
  key: string;
  knownHosts: string;
}

/**
 * A delivered secret set for one kind, in the fleet's shape: one file per
 * secret, mode 0444 (the fixture's `delivered_mode`), pointed at by
 * `<NAME>_FILE`.
 */
function world(kind: Kind, targetsText: string, keyText: string = KEY): World {
  const prefix = `OBSERVER_${kind.toUpperCase()}_`;
  const dir = mkdtempSync(join(scratch, `${kind}-`));
  const targets = join(dir, `${prefix}TARGETS`);
  const key = join(dir, `${prefix}SSH_KEY`);
  const knownHosts = join(dir, `${prefix}KNOWN_HOSTS`);
  const mode = Number.parseInt(FACTS.key_delivery.delivered_mode, 8);
  for (const [path, text] of [
    [targets, targetsText],
    [key, keyText],
    [knownHosts, KNOWN_HOSTS],
  ] as const) {
    writeFileSync(path, text);
    chmodSync(path, mode);
  }
  return {
    dir,
    env: {
      [`${prefix}TARGETS_FILE`]: targets,
      [`${prefix}SSH_KEY_FILE`]: key,
      [`${prefix}KNOWN_HOSTS_FILE`]: knownHosts,
    },
    targets,
    key,
    knownHosts,
  };
}

interface Record_ {
  argv: string[];
  keyMode: string | null;
  keyBytes: string | null;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** null when the fake ssh never ran. */
  ssh: Record_ | null;
}

function readRecord(rec: string): Record_ | null {
  const argvPath = join(rec, "argv");
  if (!existsSync(argvPath)) return null;
  const argv = readFileSync(argvPath, "utf8").split("\0");
  argv.pop(); // every record is NUL-terminated, so the last split is empty
  const modePath = join(rec, "key-mode");
  const bytesPath = join(rec, "key-bytes");
  return {
    argv,
    keyMode: existsSync(modePath) ? readFileSync(modePath, "utf8").trim() : null,
    keyBytes: existsSync(bytesPath) ? readFileSync(bytesPath, "utf8") : null,
  };
}

/**
 * The child's whole environment. Nothing is inherited from this process, so an
 * `OBSERVER_*` variable on the developer's machine cannot satisfy a lookup.
 */
function childEnv(rec: string, fakeExit: number, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_SSH_RECORD_DIR: rec,
    FAKE_SSH_EXIT: String(fakeExit),
    ...extra,
  };
}

function runShim(shell: string, args: string[], env: Record<string, string>, fakeExit = 0, cwd = scratch): Run {
  const rec = mkdtempSync(join(scratch, "rec-"));
  const proc = Bun.spawnSync([shell, SHIM, ...args], {
    env: childEnv(rec, fakeExit, env),
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    ssh: readRecord(rec),
  };
}

/** The name of the one file in `globDir()`: valid as a token, verb, word, value, host and user. */
const GLOB_BAIT = "web-1";

let globDirPath = "";

/**
 * A working directory holding exactly one file, `web-1`. A pattern such as
 * `*`, `web-?` or `[w]eb-1` that reached pathname expansion here would expand
 * to exactly that one word, which is valid in every position and is also the
 * enrolled docker target. So a glob that slipped past `set -f` or quoting
 * would turn a refusal into an ssh call, rather than into a different refusal
 * (several matches, or none, would each still be refused and hide it).
 * Created lazily: `describe` bodies run before `beforeAll` makes `scratch`.
 */
function globDir(): string {
  if (globDirPath === "") {
    globDirPath = mkdtempSync(join(scratch, "glob-cwd-"));
    writeFileSync(join(globDirPath, GLOB_BAIT), "");
  }
  return globDirPath;
}

/** SRD §5.2 `:422-426`, element by element. */
function section52Argv(w: World, kind: Kind, port: string, user: string, host: string, remote: string[]): string[] {
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${w.knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `ProxyCommand=${FACTS.proxy_command.argv_value}`,
    "-i",
    keyCopyPath(kind),
    "-p",
    port,
    "-l",
    user,
    host,
    "--",
    ...remote,
  ];
}

describe("the measured transport facts this suite is wired to", () => {
  test("still record the key behaviour the shim was built against", () => {
    // If a re-characterisation flips any of these, the shim's key handling is
    // answering a question that is no longer the measured one.
    expect(FACTS.key_delivery.accepted_at_delivered_mode).toBe(false);
    expect(FACTS.key_delivery.copy_required).toBe(true);
    expect(FACTS.key_delivery.accepted_as_copy).toBe(true);
    expect(FACTS.key_delivery.copy_dir).toBe("/tmp");
    expect(FACTS.key_delivery.copy_mode).toBe("600");
    expect(FACTS.key_delivery.accepted_without_trailing_newline).toBe(false);
  });

  test("still record the ProxyCommand and the exit codes ssh passes through", () => {
    expect(FACTS.proxy_command.round_trips).toBe(true);
    expect(FACTS.proxy_command.argv_value).toBe("node /opt/pifleet/ssh-connect.cjs %h %p");
    expect(FACTS.exit_codes.remote_exit_77).toBe(77);
    expect(FACTS.exit_codes.host_key_mismatch).toBe(255);
    expect(FACTS.exit_codes.proxy_refused).toBe(255);
  });
});

test("at least one POSIX shell is available to run the shim", () => {
  expect(shells().length).toBeGreaterThanOrEqual(1);
});

describe.each(shells())("docker/observe-ssh under %s", (shell) => {
  test("--help prints usage on stdout and exits 0 without running ssh", () => {
    const r = runShim(shell, ["--help"], {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("usage: observe-ssh <docker|vm> <target> <verb>");
    expect(r.ssh).toBeNull();
  });

  describe("the argv", () => {
    test("docker: execs exactly the §5.2 argv", () => {
      const w = world("docker", DOCKER_TARGETS);
      const remote = ["ps", "all", "name=api", "label=com.example.tier=db"];
      const r = runShim(shell, ["docker", "web-1", ...remote], w.env);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.ssh?.argv).toEqual(section52Argv(w, "docker", "22", "observe", "docker-host.example.com", remote));
    });

    test("vm: execs exactly the §5.2 argv, from OBSERVER_VM_* alone", () => {
      const w = world("vm", VM_TARGETS);
      const remote = ["units", "sshd.service", "since=300s"];
      const r = runShim(shell, ["vm", "build-vm", ...remote], w.env);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.ssh?.argv).toEqual(section52Argv(w, "vm", "2222", "observe_vm", "10.0.0.12", remote));
    });

    test("a verb with no arguments ends the argv at the verb", () => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(0);
      expect(r.ssh?.argv.slice(-2)).toEqual(["--", "info"]);
    });

    test("blank lines and whole-line comments are skipped; a last line with no newline is read", () => {
      const text = [
        "# enrolled Docker hosts",
        "",
        "   ",
        "\t# indented comment",
        "db-1\tdb-host.example.com\t2200\tobserve",
        "web-1   docker-host.example.com   22   observe",
      ].join("\n"); // no trailing newline, on purpose
      const w = world("docker", text);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.stderr).toBe("");
      expect(r.ssh?.argv).toEqual(section52Argv(w, "docker", "22", "observe", "docker-host.example.com", ["info"]));
      const db = runShim(shell, ["docker", "db-1", "info"], w.env);
      expect(db.ssh?.argv).toEqual(section52Argv(w, "docker", "2200", "observe", "db-host.example.com", ["info"]));
    });
  });

  describe("the key copy (test/fixtures/observe/ssh-transport-facts.json)", () => {
    test("-i names a copy under copy_dir at copy_mode, never the delivered file", () => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(0);
      const argv = r.ssh?.argv ?? [];
      const keyArg = argv[argv.indexOf("-i") + 1];
      expect(FACTS.key_delivery.copy_required).toBe(true);
      expect(keyArg).not.toBe(w.key);
      expect(keyArg?.startsWith(`${FACTS.key_delivery.copy_dir}/`)).toBe(true);
      expect(r.ssh?.keyMode).toBe(FACTS.key_delivery.copy_mode);
    });

    test("the copy ends in a newline although the delivered value has none", () => {
      const w = world("docker", DOCKER_TARGETS);
      expect(readFileSync(w.key, "utf8").endsWith("\n")).toBe(false);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(FACTS.key_delivery.accepted_without_trailing_newline).toBe(false);
      expect(r.ssh?.keyBytes).toBe(`${KEY}\n`);
      // The delivered file is read, never rewritten.
      expect(readFileSync(w.key, "utf8")).toBe(KEY);
      expect((statSync(w.key).mode & 0o777).toString(8)).toBe(FACTS.key_delivery.delivered_mode);
    });

    test("a delivered value that already ends in a newline is copied byte for byte", () => {
      const w = world("docker", DOCKER_TARGETS, `${KEY}\n`);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.ssh?.keyBytes).toBe(`${KEY}\n`);
    });

    test("TMPDIR cannot move the copy out of /tmp", () => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["docker", "web-1", "info"], { ...w.env, TMPDIR: w.dir });
      expect(r.exitCode).toBe(0);
      const argv = r.ssh?.argv ?? [];
      expect(argv[argv.indexOf("-i") + 1]).toBe(keyCopyPath("docker"));
    });

    test("each kind gets its own copy, holding its own key", () => {
      const d = world("docker", DOCKER_TARGETS, "docker-fake-key");
      const v = world("vm", VM_TARGETS, "vm-fake-key");
      const rd = runShim(shell, ["docker", "web-1", "info"], d.env);
      const rv = runShim(shell, ["vm", "build-vm", "info"], v.env);
      expect(rd.ssh?.keyBytes).toBe("docker-fake-key\n");
      expect(rv.ssh?.keyBytes).toBe("vm-fake-key\n");
    });

    test("concurrent calls each hand ssh a complete copy", async () => {
      // Smoke, not proof: a non-atomic write would usually pass this too. The
      // mktemp-then-rename in the shim is what makes it hold; this catches a
      // regression that breaks it outright.
      const w = world("docker", DOCKER_TARGETS);
      const recs = Array.from({ length: 8 }, () => mkdtempSync(join(scratch, "rec-")));
      const procs = recs.map((rec) =>
        Bun.spawn([shell, SHIM, "docker", "web-1", "info"], {
          env: childEnv(rec, 0, w.env),
          cwd: scratch,
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      const codes = await Promise.all(procs.map((p) => p.exited));
      expect(codes).toEqual(recs.map(() => 0));
      for (const rec of recs) expect(readRecord(rec)?.keyBytes).toBe(`${KEY}\n`);
    });
  });

  describe("ssh's exit status reaches the caller unchanged (exec)", () => {
    const cases: Array<[string, number]> = [
      ["success", FACTS.exit_codes.success],
      ["a remote refusal (77)", FACTS.exit_codes.remote_exit_77],
      ["a host-key mismatch (255)", FACTS.exit_codes.host_key_mismatch],
      ["a proxy refusal (255)", FACTS.exit_codes.proxy_refused],
    ];
    test.each(cases)("%s", (_label, code) => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env, code);
      expect(r.ssh).not.toBeNull();
      expect(r.exitCode).toBe(code);
      // A 77 from the far side must not read as the shim's own refusal.
      expect(r.stderr).not.toContain(SHIM_REFUSAL);
    });
  });

  describe("argument refusals exit 77 before ssh runs", () => {
    // One representative per class and position. The dedicated hostile table
    // (`;`, `$(…)`, backticks, `-oProxyCommand=…`, `*`) is task 3.4's.
    const cases: Array<[string, string[]]> = [
      ["no arguments", []],
      ["a kind and target with no verb", ["docker", "web-1"]],
      ["an unknown kind", ["k8s", "web-1", "ps"]],
      ["an unknown target token", ["docker", "nope", "ps"]],
      ["a target outside the token grammar", ["docker", "Web-1", "ps"]],
      ["a target longer than 32 characters", ["docker", `w${"e".repeat(32)}`, "ps"]],
      ["whitespace in the target", ["docker", "web 1", "ps"]],
      ["a metacharacter in the target", ["docker", "web-1|", "ps"]],
      ["a leading '-' on the target", ["docker", "-web-1", "ps"]],
      ["a tab in the verb", ["docker", "web-1", "p\ts"]],
      ["a metacharacter in the verb", ["docker", "web-1", "ps&"]],
      ["a leading '-' on the verb", ["docker", "web-1", "-V"]],
      ["an embedded newline in an argument", ["docker", "web-1", "logs", "web\nrm"]],
      ["a space in a key=value argument", ["docker", "web-1", "ps", "name=a b"]],
      ["a metacharacter in a key=value argument", ["docker", "web-1", "ps", "name=a>b"]],
      ["a leading '-' on an argument", ["docker", "web-1", "ps", "-a"]],
      ["an empty argument", ["docker", "web-1", "ps", ""]],
      ["a key=value with an empty value", ["docker", "web-1", "ps", "name="]],
      ["a key that is not lower-case", ["docker", "web-1", "ps", "Name=api"]],
      ["a slash in a bare word", ["docker", "web-1", "inspect", "a/b"]],
      ["a verb starting with a digit", ["docker", "web-1", "1ps"]],
      ["a key=value value with a leading '-'", ["docker", "web-1", "ps", "name=-a"]],
    ];
    test.each(cases)("%s", (_label, args) => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, args, w.env);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      expect(r.ssh).toBeNull();
    });

    // No OBSERVER_* variables at all, so a check that ran after the
    // configuration reads would exit 78 instead. Every position is here
    // because the target and verb are checked on their own lines and the
    // arguments in a later loop; a hostile verb alone cannot show where that
    // loop sits.
    const beforeConfiguration: Array<[string, string[]]> = [
      ["a hostile target", ["docker", "web-1;pwn", "ps"]],
      ["a hostile verb", ["docker", "web-1", "-V"]],
      ["a hostile bare-word argument after a valid verb", ["docker", "web-1", "ps", "all;pwn"]],
      ["a hostile key=value value after a valid verb", ["docker", "web-1", "ps", "name=api;pwn"]],
    ];
    test.each(beforeConfiguration)("argument safety is judged before any configuration is read: %s", (_label, args) => {
      const r = runShim(shell, args, {});
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      expect(r.ssh).toBeNull();
    });
  });

  describe("injection hardening (SRD 3.4): hostile values exit 77 before ssh runs", () => {
    // Each payload rides on a base that is valid in its position, so the
    // payload is the only thing wrong with the word. "Before a valid prefix"
    // forms exercise the whole-word check; "after a valid prefix" forms get
    // past the first-character check and exercise the every-character one.
    // Each run's working directory is `globDir()`, where `*` would expand to
    // the enrolled target if anything globbed.
    const positions: Array<[string, string, (value: string) => string[]]> = [
      ["the target", "web-1", (v) => ["docker", v, "ps"]],
      ["the verb", "ps", (v) => ["docker", "web-1", v]],
      ["a bare-word argument", "all", (v) => ["docker", "web-1", "ps", v]],
      ["a key=value value", "api", (v) => ["docker", "web-1", "ps", `name=${v}`]],
    ];
    const payloads: Array<[string, (base: string) => string]> = [
      ["';' after a valid prefix", (b) => `${b};pwn`],
      ["a lone ';'", () => ";"],
      ["'$(…)' after a valid prefix", (b) => `${b}$(pwn)`],
      ["a whole-word '$(…)'", () => "$(pwn)"],
      ["backticks after a valid prefix", (b) => `${b}\`pwn\``],
      ["a whole-word backtick substitution", () => "`pwn`"],
      ["an embedded newline", (b) => `${b}\npwn`],
      ["a leading newline", (b) => `\n${b}`],
      ["'-oProxyCommand=…'", () => "-oProxyCommand=/tmp/pwn"],
      ["a lone '*'", () => "*"],
      ["'*' after a valid prefix", (b) => `${b}*`],
    ];
    const rows = positions.flatMap(([where, base, build]) =>
      payloads.map(([what, payload]) => [where, what, build(payload(base))] as [string, string, string[]]),
    );

    test.each(positions)("control: the benign base in %s reaches ssh", (_where, base, build) => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, build(base), w.env, 0, globDir());
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.ssh).not.toBeNull();
    });

    test.each(rows)("%s: %s", (_where, _what, args) => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, args, w.env, 0, globDir());
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      // Messages never echo a refused value, which may hold a newline.
      expect(r.stderr).not.toContain("pwn");
      expect(r.ssh).toBeNull();
    });
  });

  describe("length limits, each tested where no other refusal can mask it", () => {
    const TARGETS_WITH = (token: string) => `${token} docker-host.example.com 22 observe\n`;
    const token32 = `w${"e".repeat(31)}`;
    const token33 = `w${"e".repeat(32)}`;

    test("a 32-character token, enrolled and requested, reaches ssh", () => {
      const w = world("docker", TARGETS_WITH(token32));
      const r = runShim(shell, ["docker", token32, "info"], w.env);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.ssh).not.toBeNull();
    });

    test("a 33-character token in the targets file refuses the file, even for a valid target", () => {
      // The request is for the valid `web-1`, so no unknown-token refusal can
      // stand in for the limit.
      const w = world("docker", `${TARGETS_WITH(token33)}${DOCKER_TARGETS}`);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      expect(r.stderr).toContain("OBSERVER_DOCKER_TARGETS_FILE line 1");
      expect(r.ssh).toBeNull();
    });

    test("a 33-character target is refused for its shape, not as unknown", () => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["docker", token33, "info"], w.env);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain("the target is not an enrolled-token shape");
      expect(r.ssh).toBeNull();
    });

    const limits: Array<[string, string[], string[]]> = [
      ["the verb (32)", ["docker", "web-1", `p${"s".repeat(31)}`], ["docker", "web-1", `p${"s".repeat(32)}`]],
      ["a bare-word argument (256)", ["docker", "web-1", "ps", "a".repeat(256)], ["docker", "web-1", "ps", "a".repeat(257)]],
      [
        "a key=value argument (256)",
        ["docker", "web-1", "ps", `name=${"a".repeat(251)}`],
        ["docker", "web-1", "ps", `name=${"a".repeat(252)}`],
      ],
      ["a key (32)", ["docker", "web-1", "ps", `${"k".repeat(32)}=v`], ["docker", "web-1", "ps", `${"k".repeat(33)}=v`]],
    ];
    test.each(limits)("%s: at the limit reaches ssh, one over is refused", (_label, atLimit, overLimit) => {
      const w = world("docker", DOCKER_TARGETS);
      const ok = runShim(shell, atLimit, w.env);
      expect(ok.stderr).toBe("");
      expect(ok.exitCode).toBe(0);
      expect(ok.ssh?.argv.slice(-(atLimit.length - 2))).toEqual(atLimit.slice(2));
      const over = runShim(shell, overLimit, w.env);
      expect(over.exitCode).toBe(77);
      expect(over.stderr).toContain(SHIM_REFUSAL);
      expect(over.ssh).toBeNull();
    });
  });

  describe("the targets-file split never globs (set -f)", () => {
    // `parse_line ${line}` is the shim's one unquoted expansion. It runs in
    // `globDir()`, where every pattern below matches exactly the file `web-1`,
    // so a glob would rewrite the line into a VALID enrolment of `web-1` and
    // the request for `web-1` would reach ssh. The file holds only this line:
    // a second `web-1` line would turn a glob into a duplicate-token refusal
    // and hide it.
    const cases: Array<[string, string]> = [
      ["a '*' token", "* docker-host.example.com 22 observe"],
      ["a '?' token", "web-? docker-host.example.com 22 observe"],
      ["a bracket-expression token", "[w]eb-1 docker-host.example.com 22 observe"],
      ["a '*' host", "web-1 * 22 observe"],
      ["a '*' user", "web-1 docker-host.example.com 22 *"],
    ];
    test.each(cases)("%s is malformed, not expanded against the working directory", (_label, line) => {
      const w = world("docker", `${line}\n`);
      const r = runShim(shell, ["docker", GLOB_BAIT, "info"], w.env, 0, globDir());
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      expect(r.stderr).toContain("OBSERVER_DOCKER_TARGETS_FILE line 1");
      expect(r.ssh).toBeNull();
    });
  });

  describe("a malformed targets file refuses every target (77)", () => {
    // Each file also enrols a VALID `web-1`, and the request is for `web-1`, so
    // the refusal can only come from the malformed line, never from an unknown
    // token.
    const VALID = "web-1 docker-host.example.com 22 observe";
    const cases: Array<[string, string]> = [
      ["three fields", "db-1 db-host.example.com 22"],
      ["five fields", "db-1 db-host.example.com 22 observe extra"],
      ["a token outside the grammar", "Db-1 db-host.example.com 22 observe"],
      ["port 0", "db-1 db-host.example.com 0 observe"],
      ["port 65536", "db-1 db-host.example.com 65536 observe"],
      ["a non-integer port", "db-1 db-host.example.com 22x observe"],
      ["a port with a leading zero", "db-1 db-host.example.com 022 observe"],
      ["a host with a leading '-'", "db-1 -db-host.example.com 22 observe"],
      ["a host with a metacharacter", "db-1 db-host&.example.com 22 observe"],
      ["a user with a metacharacter", "db-1 db-host.example.com 22 obs;erve"],
      ["a user with a leading '-'", "db-1 db-host.example.com 22 -observe"],
      ["a trailing comment", "db-1 db-host.example.com 22 observe # primary"],
      ["a CRLF line ending", "db-1 db-host.example.com 22 observe\r"],
      ["a duplicated token", VALID],
    ];
    test.each(cases)("%s", (_label, bad) => {
      const w = world("docker", `${bad}\n${VALID}\n`);
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SHIM_REFUSAL);
      expect(r.stderr).toContain("OBSERVER_DOCKER_TARGETS_FILE");
      expect(r.ssh).toBeNull();
    });
  });

  describe("undelivered configuration exits 78 and names the variable", () => {
    for (const kind of ["docker", "vm"] as const) {
      const token = kind === "docker" ? "web-1" : "build-vm";
      const text = kind === "docker" ? DOCKER_TARGETS : VM_TARGETS;
      const prefix = `OBSERVER_${kind.toUpperCase()}_`;
      for (const name of ["TARGETS", "SSH_KEY", "KNOWN_HOSTS"] as const) {
        const variable = `${prefix}${name}_FILE`;

        test(`${kind}: ${variable} unset`, () => {
          const w = world(kind, text);
          const env = { ...w.env };
          delete env[variable];
          const r = runShim(shell, [kind, token, "info"], env);
          expect(r.exitCode).toBe(78);
          expect(r.stderr).toContain(variable);
          expect(r.ssh).toBeNull();
        });

        test(`${kind}: ${variable} names a file that cannot be read`, () => {
          const w = world(kind, text);
          const r = runShim(shell, [kind, token, "info"], { ...w.env, [variable]: join(w.dir, "absent") });
          expect(r.exitCode).toBe(78);
          expect(r.stderr).toContain(variable);
          expect(r.ssh).toBeNull();
        });
      }
    }

    test("the docker secrets do not satisfy a vm call", () => {
      const w = world("docker", DOCKER_TARGETS);
      const r = runShim(shell, ["vm", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(78);
      expect(r.stderr).toContain("OBSERVER_VM_TARGETS_FILE");
      expect(r.ssh).toBeNull();
    });

    test("an empty delivered key", () => {
      const w = world("docker", DOCKER_TARGETS, "");
      const r = runShim(shell, ["docker", "web-1", "info"], w.env);
      expect(r.exitCode).toBe(78);
      expect(r.stderr).toContain("OBSERVER_DOCKER_SSH_KEY_FILE");
      expect(r.ssh).toBeNull();
    });

    test("a known-hosts path ssh's option parser would re-tokenise", () => {
      // `-o UserKnownHostsFile=<path>` is split on whitespace by ssh itself.
      const w = world("docker", DOCKER_TARGETS);
      const spaced = join(w.dir, "known hosts");
      writeFileSync(spaced, KNOWN_HOSTS);
      const r = runShim(shell, ["docker", "web-1", "info"], {
        ...w.env,
        OBSERVER_DOCKER_KNOWN_HOSTS_FILE: spaced,
      });
      expect(r.exitCode).toBe(78);
      expect(r.stderr).toContain("OBSERVER_DOCKER_KNOWN_HOSTS_FILE");
      expect(r.ssh).toBeNull();
    });
  });
});
