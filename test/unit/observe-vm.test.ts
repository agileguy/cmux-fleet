/**
 * `docker/observe-vm` is a thin alias for `exec observe-ssh vm "$@"`, plus
 * one branch: `--help`/`-h` as the SOLE argument prints its own usage to
 * stdout and exits 0 without ever invoking observe-ssh (SRD-OBSERVER-ROLES
 * §6.2; Phase 5 task 5.2). Passed on, `observe-ssh vm --help` would put
 * `--help` where observe-ssh expects a target token and be refused, exit 77.
 *
 * Nothing about the Dockerfile's COPY, the build-asset enrolment or the smoke
 * lines notices the alias handing observe-ssh the wrong kind, dropping an
 * argument, or splitting one: `observe-ssh docker "$@"` is refused at build
 * time in exactly the words `observe-ssh vm "$@"` is. So these run the real
 * alias under the host's POSIX shells with a recording fake `observe-ssh`
 * first on `PATH`, and read back the argv it was handed, NUL-separated so an
 * element holding a space or a newline survives as one record — except the
 * help cases, which must show the fake was never invoked at all (the record
 * file is absent).
 *
 * The `--help extra` case runs the alias against the REAL `docker/observe-ssh`
 * instead, because the image's smoke line greps for the refusal text and a
 * reworded refusal would fail every build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;
const ALIAS = join(REPO, "docker/observe-vm");
const REAL_SHIM = join(REPO, "docker/observe-ssh");

/** The text the Dockerfile's smoke line greps `observe-vm --help extra` for. */
const SMOKE_REFUSAL = "observe-ssh: refused before ssh ran";

/** The line the shim's own usage branch is expected to open with. */
const USAGE_HEADER = "usage: observe-vm <target> <verb> [key=value ...]";

/** The phrase `scripts/observe/vm-forced-command`'s catch-all refusal prints, which usage tells a worker to route on. */
const VERB_REFUSAL = "not a recognised verb";

/** Records its argv, one NUL-terminated element each, then exits with `FAKE_EXIT`. */
const FAKE_OBSERVE_SSH = `#!/bin/sh
for arg in "$@"; do printf '%s\\0' "$arg"; done > "$FAKE_RECORD"
exit "$FAKE_EXIT"
`;

let scratch = "";
let fakeBin = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "test-observe-vm-"));
  fakeBin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(fakeBin, "observe-ssh"), FAKE_OBSERVE_SSH);
  chmodSync(join(fakeBin, "observe-ssh"), 0o755);
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

/** Run the real alias with `bin` first on PATH and nothing else inherited. */
function runAlias(shell: string, bin: string, args: string[], fakeExit = 0) {
  const record = join(mkdtempSync(join(scratch, "rec-")), "argv");
  const proc = Bun.spawnSync([shell, ALIAS, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_RECORD: record, FAKE_EXIT: String(fakeExit) },
    cwd: scratch,
    stdout: "pipe",
    stderr: "pipe",
  });
  const argv = existsSync(record) ? readFileSync(record, "utf8").split("\0").slice(0, -1) : null;
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), argv };
}

for (const shell of shells()) {
  describe(`observe-vm under ${shell}`, () => {
    test("hands observe-ssh the vm kind and every argument, unsplit and in order", () => {
      const args = ["vm-host-a", "journal", "unit=web 1", "", "since=60s\nlines=5", "*", "--follow"];
      const r = runAlias(shell, fakeBin, args);
      expect(r.argv).toEqual(["vm", ...args]);
      expect(r.exitCode).toBe(0);
    });

    test("with no arguments, observe-ssh still receives only the kind", () => {
      expect(runAlias(shell, fakeBin, []).argv).toEqual(["vm"]);
    });

    test("observe-ssh's exit status reaches the caller unchanged", () => {
      for (const code of [77, 78, 255]) expect(runAlias(shell, fakeBin, ["t", "uptime"], code).exitCode).toBe(code);
    });

    test("--help alone exits 0, prints usage to stdout, and never invokes observe-ssh", () => {
      const r = runAlias(shell, fakeBin, ["--help"]);
      expect(r.argv).toBeNull();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(USAGE_HEADER);
    });

    test("-h alone exits 0, prints usage to stdout, and never invokes observe-ssh", () => {
      const r = runAlias(shell, fakeBin, ["-h"]);
      expect(r.argv).toBeNull();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(USAGE_HEADER);
    });

    test("--help with another argument still reaches observe-ssh unchanged", () => {
      const r = runAlias(shell, fakeBin, ["--help", "extra"]);
      expect(r.argv).toEqual(["vm", "--help", "extra"]);
      expect(r.exitCode).toBe(0);
    });

    test("--help extra reaches the real observe-ssh and is refused in the words the smoke line greps for", () => {
      const realBin = mkdtempSync(join(scratch, "real-bin-"));
      copyFileSync(REAL_SHIM, join(realBin, "observe-ssh"));
      chmodSync(join(realBin, "observe-ssh"), 0o755);
      const r = runAlias(shell, realBin, ["--help", "extra"]);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SMOKE_REFUSAL);
    });
  });
}

test(`usage and the forced command's catch-all both carry "${VERB_REFUSAL}"`, () => {
  const forced = readFileSync(join(REPO, "scripts/observe/vm-forced-command"), "utf8");
  expect(forced).toContain(`"not a recognised verb;`);
  for (const shell of shells()) expect(runAlias(shell, fakeBin, ["--help"]).stdout).toContain(VERB_REFUSAL);
});

test("the two smoke lines match what these tests pin", () => {
  const dockerfile = readFileSync(join(REPO, "docker/Dockerfile"), "utf8");
  expect(dockerfile).toContain("observe-vm --help >/dev/null;");
  expect(dockerfile).toContain(
    `observe-vm --help extra 2>&1 | grep -qF '${SMOKE_REFUSAL}';`,
  );
});
