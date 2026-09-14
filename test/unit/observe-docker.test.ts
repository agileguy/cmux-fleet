/**
 * `docker/observe-docker` is `exec observe-ssh docker "$@"` and nothing else
 * (SRD-OBSERVER-ROLES §5.2; Phase 4 task 4.2).
 *
 * Nothing about the Dockerfile's COPY, the build-asset enrolment or the smoke
 * line notices the alias handing observe-ssh the wrong kind, dropping an
 * argument, or splitting one: `observe-ssh vm "$@"` is refused at build time in
 * exactly the words `observe-ssh docker "$@"` is. So these run the real alias
 * under the host's POSIX shells with a recording fake `observe-ssh` first on
 * `PATH`, and read back the argv it was handed, NUL-separated so an element
 * holding a space or a newline survives as one record.
 *
 * The last case runs the alias against the REAL `docker/observe-ssh` instead,
 * because the image's smoke line greps for the refusal text and a reworded
 * refusal would fail every build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;
const ALIAS = join(REPO, "docker/observe-docker");
const REAL_SHIM = join(REPO, "docker/observe-ssh");

/** The text the Dockerfile's smoke line greps `observe-docker --help` for. */
const SMOKE_REFUSAL = "observe-ssh: refused before ssh ran";

/** Records its argv, one NUL-terminated element each, then exits with `FAKE_EXIT`. */
const FAKE_OBSERVE_SSH = `#!/bin/sh
for arg in "$@"; do printf '%s\\0' "$arg"; done > "$FAKE_RECORD"
exit "$FAKE_EXIT"
`;

let scratch = "";
let fakeBin = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "test-observe-docker-"));
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
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString(), argv };
}

for (const shell of shells()) {
  describe(`observe-docker under ${shell}`, () => {
    test("hands observe-ssh the docker kind and every argument, unsplit and in order", () => {
      const args = ["docker-host-a", "logs", "web 1", "", "since=60s\ntail=5", "*", "--follow"];
      const r = runAlias(shell, fakeBin, args);
      expect(r.argv).toEqual(["docker", ...args]);
      expect(r.exitCode).toBe(0);
    });

    test("with no arguments, observe-ssh still receives only the kind", () => {
      expect(runAlias(shell, fakeBin, []).argv).toEqual(["docker"]);
    });

    test("observe-ssh's exit status reaches the caller unchanged", () => {
      for (const code of [77, 78, 255]) expect(runAlias(shell, fakeBin, ["t", "ps"], code).exitCode).toBe(code);
    });

    test("--help reaches the real observe-ssh as a target and is refused in the words the smoke line greps for", () => {
      const realBin = mkdtempSync(join(scratch, "real-bin-"));
      copyFileSync(REAL_SHIM, join(realBin, "observe-ssh"));
      chmodSync(join(realBin, "observe-ssh"), 0o755);
      const r = runAlias(shell, realBin, ["--help"]);
      expect(r.exitCode).toBe(77);
      expect(r.stderr).toContain(SMOKE_REFUSAL);
    });
  });
}

test("the smoke line greps for the same refusal text these tests pin", () => {
  expect(readFileSync(join(REPO, "docker/Dockerfile"), "utf8")).toContain(
    `observe-docker --help 2>&1 | grep -qF '${SMOKE_REFUSAL}';`,
  );
});
