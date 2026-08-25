/**
 * The exam actually held in a container (ISC-233), against a real daemon.
 *
 * `test/unit/acceptance-container.test.ts` pins the argv and
 * `test/unit/acceptance-wiring.test.ts` pins the refusal, both without Docker.
 * Neither can answer the only question that matters at the end: does the
 * command run INSIDE the image, over the mounted clone, and come back with a
 * result that reflects the code? That needs a daemon and the worker image, so
 * it lives here and is listed in CI's `container` job.
 *
 * ## The differential each probe is built around
 *
 * The weak version of this file would assert `outcome === "passed"` for a
 * command that would also pass on the host, which proves the harness ran and
 * nothing about WHERE. Every probe below is instead chosen so that the host
 * and the container disagree:
 *
 *   - `PIFLEET_CONTAINER` is baked into the image and is absent on the host.
 *   - `id -u` is 10001 in the image and the operator's uid on the host.
 *   - `/etc/gitconfig`'s `safe.directory` exists only in the image.
 *   - the read-only root refuses a write the host would accept.
 *
 * A probe that passes for the wrong reason is the failure mode this whole ISA
 * keeps re-learning, and a same-either-way assertion is exactly that shape.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveFromEnvelope, runAcceptance } from "../../src/harvest/acceptance.ts";
import { makeDaemonScratch } from "../../src/container/mounts.ts";
import { Deadline } from "../../src/util/clock.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";
const IMAGE = "pifleet/pi-worker:verify";

if (!DOCKER) {
  console.log(
    "[skip] acceptance-container tests need a Docker daemon and pifleet/pi-worker:verify. " +
      "Run with PIFLEET_DOCKER=1 after 'pifleet image build'.",
  );
}

let repo: string;
let scratch: string;
let head: string;
const cleanups: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err || out}`);
  return out.trim();
}

/** One command, run through the production path, in the worker's image. */
async function exam(cmd: string, timeoutMs = 120_000) {
  const r = await runAcceptance({
    repo,
    head_sha: head,
    scratch_dir: scratch,
    commands: resolveFromEnvelope([cmd], "0".repeat(40)),
    deadline: new Deadline(300_000),
    per_command_timeout_ms: timeoutMs,
    container: { image: IMAGE },
  });
  return { run: r.runs[0]!, context: r.context };
}

/** Names of exam containers currently alive, so a leak is visible as a diff. */
async function runningAcceptanceContainers(): Promise<string[]> {
  const p = Bun.spawn(["docker", "ps", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "pipe" });
  const [, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("pifleet-accept-"))
    .sort();
}

/** The same command on the HOST path — the control every probe is read against. */
async function examOnHost(cmd: string, timeoutMs = 120_000) {
  const r = await runAcceptance({
    repo,
    head_sha: head,
    scratch_dir: scratch,
    commands: resolveFromEnvelope([cmd], "0".repeat(40)),
    deadline: new Deadline(300_000),
    per_command_timeout_ms: timeoutMs,
  });
  return { run: r.runs[0]!, context: r.context };
}

beforeAll(async () => {
  if (!DOCKER) return;
  repo = await mkdtemp(join(tmpdir(), "pifleet-accept-container-repo-"));
  cleanups.push(repo);
  // The scratch root must be daemon-visible — that is ISC-277, and using the
  // production allocator here rather than `mkdtemp(tmpdir())` is deliberate:
  // a fixture that hand-picks a shared path would hide a regression in the
  // very function the criterion is about.
  scratch = await makeDaemonScratch("accept-it");
  cleanups.push(scratch);
  await git(repo, "init", "--quiet", "-b", "main");
  await writeFile(join(repo, "data.txt"), "needle\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "-m", "base");
  head = await git(repo, "rev-parse", "HEAD");
});

afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
});

describe.skipIf(!DOCKER)("the exam is held inside the worker's image (ISC-233)", () => {
  /**
   * The load-bearing one. `PIFLEET_CONTAINER=1` is an `ENV` line in
   * `docker/Dockerfile` and exists nowhere on a developer's machine, so this
   * single command answers "did it run in the image" with a yes/no that cannot
   * be produced any other way — and the host arm is asserted in the same test
   * so a green here can never mean "the command is just always true".
   */
  test("the command runs in the image, not on the host", async () => {
    // Single-quoted so `tokenize` keeps the script as ONE argv element:
    // `sh -c` takes one string, and an unquoted `sh -c test "$X" = 1` splits
    // into six elements, making `test` the whole script and `$X` its $0.
    const cmd = `sh -c 'test "$PIFLEET_CONTAINER" = 1'`;
    const inside = await exam(cmd);
    expect(inside.run.outcome).toBe("passed");

    const outside = await examOnHost(cmd);
    expect(outside.run.outcome).toBe("failed");
  });

  test("it runs as the image's baked uid, not the operator's", async () => {
    const r = await exam(`sh -c 'test "$(id -u)" = 10001'`);
    expect(r.run.outcome).toBe("passed");
    // The host arm would be the operator's own uid, whatever that is; asserting
    // "not 10001" there would be a claim about the developer's machine and
    // false on a runner that happens to use it. The container arm is exact,
    // and `container-env.test.ts` already pins the `--user` flag itself.
  });

  test("the fresh clone is on the other side of the mount, with real content", async () => {
    // Not "the mount exists" — an unshared path mounts as an EMPTY directory
    // and would pass that. This reads a file the fixture committed.
    expect((await exam("grep -q needle data.txt")).run.outcome).toBe("passed");
    expect((await exam("grep -q not-in-this-file data.txt")).run.outcome).toBe("failed");
  });

  /**
   * The mount is WRITABLE by the baked uid, which is a separate fact from it
   * being readable and needs its own probe.
   *
   * The clone is created by the operator's uid and the container runs as
   * 10001, so without the recursive widen every write into `/workspace` fails.
   * That is not an edge case: a suite writing a snapshot, a coverage file or a
   * `.pytest_cache` is an ordinary suite, and ISC-298 measured that a
   * DIRECTORY-only widen is not enough — an existing file owned by another uid
   * still refuses `open(O_WRONLY)`, so some edits land and others do not
   * depending on which call the tool made.
   */
  test("the baked uid can write the mounted clone, files as well as directories", async () => {
    // A new file: needs the directory bit.
    expect((await exam(`sh -c 'echo x > /workspace/new-file.txt'`)).run.outcome).toBe("passed");
    // An EXISTING file the host committed: needs the recursive widen. This is
    // the half a directory-only chmod passes and should not.
    expect((await exam(`sh -c 'echo x > /workspace/data.txt'`)).run.outcome).toBe("passed");
  });

  /**
   * The claim `acceptance-container.ts` makes about `/workspace` being a fixed
   * path, measured rather than asserted in prose. The image bakes
   * `git config --system --add safe.directory /workspace`; without it, a
   * container running as 10001 over a mount that presents as root-owned gets
   * `fatal: detected dubious ownership` from every git subcommand.
   */
  test("git works in the mounted clone, on the baked safe.directory", async () => {
    const r = await exam("git status --porcelain");
    expect(r.run.outcome).toBe("passed");
    expect(r.run.excerpt).not.toContain("dubious ownership");
  });

  test("the exam's root filesystem is read-only, as the worker's is", async () => {
    const r = await exam(`sh -c 'touch /etc/pifleet-should-fail'`);
    expect(r.run.outcome).toBe("failed");
    // /tmp is the tmpfs, and it IS writable — the contrast that shows the
    // failure above is the read-only root and not a broken container.
    expect((await exam(`sh -c 'touch /tmp/ok'`)).run.outcome).toBe("passed");
  });

  test("the audit record names the image the exam actually ran in", async () => {
    const r = await exam("true");
    expect(r.context.image).toBe(IMAGE);
    // And the host arm, in the same file, against the same fixture: `null`
    // is the honest answer when no container was involved.
    expect((await examOnHost("true")).context.image).toBeNull();
  });

  /**
   * ISC-152 still holds on the new path. A `docker run` that outlives its
   * budget is `timed_out`, not `failed` — running out of wall clock proves
   * nothing about the code, and the adjudicator maps it to `unknown`.
   */
  test(
    "a container that outlives its budget is timed_out, and is reaped",
    async () => {
      const before = await runningAcceptanceContainers();
      const r = await exam("sleep 120", 8_000);
      expect(r.run.outcome).toBe("timed_out");
      expect(r.run.exit_code).toBeNull();

      /**
       * The half that is not about the verdict.
       *
       * The timeout SIGKILLs the docker CLIENT; `--rm` is a client-side action,
       * so without an explicit reap the container keeps running to completion
       * with nothing left to remove it. This assertion is the reason
       * `reapAcceptanceContainer` exists: writing the file's first draft left a
       * `sleep 60` container `Up` on the maintainer's machine after the run had
       * been recorded and returned, and a real acceptance suite runs for far
       * longer than a sleep. `sleep 120` is deliberately longer than anything
       * else in this file, so a surviving container cannot be mistaken for one
       * that simply finished on its own.
       */
      expect(await runningAcceptanceContainers()).toEqual(before);
    },
    // Above the 8s budget the probe itself sets, plus container start-up. The
    // default 5s would time the TEST out before the RUNNER could time the
    // command out, which reads as a failure of the thing being measured.
    60_000,
  );
});

describe.skipIf(!DOCKER)("the mount is proved against the real daemon (ISC-277)", () => {
  /**
   * What is provable here, and what is NOT — stated rather than implied.
   *
   * PROVABLE: that the gate is consulted on the production path against a real
   * daemon, and that a visible root passes it. That is the probe below.
   *
   * NOT PROVABLE HERE: the SILENTLY-EMPTY case, which is the failure the
   * criterion is actually about. It needs a daemon whose shared set excludes
   * the path — a macOS/Colima VM — and this job runs on Linux, where the
   * daemon shares the whole filesystem and no unshared path exists to point
   * at. An earlier draft of this file tried to manufacture one by naming a
   * directory that did not exist yet; `runAcceptance` creates its scratch root
   * before probing, so the probe came back VISIBLE and the assertion was
   * measuring nothing. The negative arm is covered in
   * `test/unit/acceptance-wiring.test.ts` with an injected probe exec, which
   * is the only way to produce that answer on demand on any host.
   */
  test("the production scratch root IS visible, which is why the gate stays quiet", async () => {
    const r = await exam("true");
    expect(r.run.outcome).toBe("passed");
    expect(r.run.excerpt).not.toContain("ISC-277");
  });
});
