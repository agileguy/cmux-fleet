/**
 * `doctor`'s three diagnosis classes (ISC-159).
 *
 * The criterion asks that `doctor` exit nonzero with an ACTIONABLE message on
 * a missing binary, a wrong version, and an absent daemon. It could not: every
 * finding funnelled into one untyped `diagnoses` array, and a required probe
 * that failed produced the same `not available (docker exited 1)` line whether
 * Docker was uninstalled or merely stopped. Those have opposite fixes, and an
 * operator told the first when the second is true goes and reinstalls a Docker
 * they already have.
 *
 * Every tool is driven through a PATH shim, and PATH is set to the shim
 * directory ALONE. Anything less lets the developer's own machine answer the
 * probes — the first version of the sibling `doctor-cmux` suite asserted exit
 * 3 and passed for the wrong reason, because this machine has no running
 * Docker daemon and `doctor` was exiting 3 on that account rather than on the
 * thing under test. A closed PATH makes each scenario the only possible cause
 * of its own verdict.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/** A `docker` whose CLI works and whose daemon answers, at `server`. */
function healthyDocker(server: string): string {
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) echo "Docker version ${server}, build test-shim" ;;`,
    `  version) echo "${server}" ;;`,
    // `image inspect` — reported absent so no mount probe is attempted; a shim
    // cannot satisfy one and its failure is a different diagnosis.
    '  *) exit 1 ;;',
    "esac",
    "",
  ].join("\n");
}

/**
 * A `docker` that is INSTALLED but whose daemon is down.
 *
 * `docker --version` is client-only — it never opens the socket — so it
 * succeeds here while `docker version`, which must ask the server, does not.
 * That asymmetry is the whole discriminator between `missing-binary` and
 * `absent-daemon`, and it is what a stopped Docker Desktop really looks like.
 */
function daemonlessDocker(client: string): string {
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) echo "Docker version ${client}, build test-shim" ;;`,
    '  version) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2; exit 1 ;;',
    '  *) exit 1 ;;',
    "esac",
    "",
  ].join("\n");
}

const script = (line: string): string => ["#!/bin/sh", line, ""].join("\n");

interface Shims {
  docker?: string;
  git?: string;
  tmux?: string;
}

/** Write the named shims into a fresh dir; anything omitted is ABSENT. */
async function shimBin(shims: Shims): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-doctor-dx-"));
  bases.push(base);
  for (const [name, body] of Object.entries(shims)) {
    if (body === undefined) continue;
    const p = join(base, name);
    await writeFile(p, body);
    await chmod(p, 0o755);
  }
  return base;
}

interface DoctorRun {
  code: number;
  stdout: string;
  stderr: string;
  json: {
    ok: boolean;
    probes: Array<{
      name: string;
      ok: boolean;
      version?: string;
      detail: string;
      floor?: { min: string; status: string };
    }>;
    backends: Record<string, boolean>;
    diagnoses: Array<{ name: string; class: string; message: string }>;
    diagnosis_classes: string[];
  };
}

async function doctor(binDir: string): Promise<DoctorRun> {
  const p = Bun.spawn([process.execPath, CLI, "doctor", "--json"], {
    // PATH is the shim dir and NOTHING else: the real docker/git/tmux/cmux on
    // the developer's machine must not be able to answer a probe this test is
    // asserting on.
    env: {
      PATH: binDir,
      PIFLEET_RUNS_DIR: join(binDir, "runs"),
      // No developer `fleet.yaml` or `cmux.json` leaks in — with HOME here,
      // config resolution fails and `doctor` probes with defaults, which is
      // the "broken machine is still diagnosable" path §11 promises.
      HOME: binDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  let json: DoctorRun["json"];
  try {
    json = JSON.parse(stdout) as DoctorRun["json"];
  } catch {
    throw new Error(
      `doctor --json produced no parseable stdout (exit ${code}). stderr: ${stderr.slice(0, 800)}`,
    );
  }
  return { code, stdout, stderr, json };
}

/** The same probe without `--json` — the operator-facing branch of `register`. */
async function doctorHuman(binDir: string): Promise<string> {
  const p = Bun.spawn([process.execPath, CLI, "doctor"], {
    env: { PATH: binDir, PIFLEET_RUNS_DIR: join(binDir, "runs"), HOME: binDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  await p.exited;
  return `${stdout}${stderr}`;
}

const HEALTHY_GIT = script('echo "git version 2.50.1"');

function findDiagnosis(r: DoctorRun, name: string): { name: string; class: string; message: string } {
  const d = r.json.diagnoses.find((x) => x.name === name);
  if (d === undefined) {
    throw new Error(
      `no diagnosis named "${name}"; got ${JSON.stringify(r.json.diagnoses.map((x) => `${x.class}/${x.name}`))}`,
    );
  }
  return d;
}

describe("a missing binary is diagnosed as one (ISC-159)", () => {
  test("an absent required binary exits 3 and names the install", async () => {
    const bin = await shimBin({ docker: healthyDocker("28.0.1") }); // no git
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    const d = findDiagnosis(r, "git-not-installed");
    expect(d.class).toBe("missing-binary");
    // Actionable: what to do, not merely what was observed.
    expect(d.message).toContain("install git");
    expect(r.json.diagnosis_classes).toContain("missing-binary");
  }, cliBudget(1));

  /**
   * The discrimination ISC-159 turns on. Absent docker and stopped docker
   * used to be the same row; if this class ever reads `absent-daemon` the
   * operator is sent to start a daemon that is not installed.
   */
  test("an absent docker is missing-binary, never absent-daemon", async () => {
    const bin = await shimBin({ git: HEALTHY_GIT }); // no docker at all
    const r = await doctor(bin);

    expect(r.code).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(findDiagnosis(r, "docker-not-installed").class).toBe("missing-binary");
    expect(r.json.diagnosis_classes).not.toContain("absent-daemon");
  }, cliBudget(1));
});

describe("an absent daemon is diagnosed as one (ISC-159)", () => {
  test("an installed docker CLI with a dead daemon exits 3 and says so", async () => {
    const bin = await shimBin({ docker: daemonlessDocker("28.0.1"), git: HEALTHY_GIT });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    const d = findDiagnosis(r, "docker-daemon-unreachable");
    expect(d.class).toBe("absent-daemon");
    // The message must distinguish itself from "not installed" on its face:
    // it reports the client it FOUND, and tells the operator to start Docker.
    expect(d.message).toContain("28.0.1");
    expect(d.message).toContain("start");
    // …and must not send them to an install they have already done.
    expect(r.json.diagnosis_classes).not.toContain("missing-binary");
  }, cliBudget(1));
});

describe("a version below the floor is diagnosed as one (ISC-159)", () => {
  /**
   * `doctor` captured a version string and compared it to nothing, so this
   * class was unreachable. 2.20.1 is below git 2.32, the release that
   * introduced the `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` variables that
   * `harvest/git.ts` uses to neutralise a developer's config against an
   * untrusted repository — on older git those are IGNORED and the hardening
   * fails open, silently.
   */
  test("a too-old required binary exits 3, naming both versions", async () => {
    const bin = await shimBin({
      docker: healthyDocker("28.0.1"),
      git: script('echo "git version 2.20.1"'),
    });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    const d = findDiagnosis(r, "git-version-below-minimum");
    expect(d.class).toBe("wrong-version");
    expect(d.message).toContain("2.20.1"); // what you have
    expect(d.message).toContain("2.32.0"); // what is required
    // Not conflated with absence: the binary is right there.
    expect(r.json.diagnosis_classes).not.toContain("missing-binary");
  }, cliBudget(1));

  test("a docker below its floor is caught the same way", async () => {
    const bin = await shimBin({ docker: healthyDocker("20.10.24"), git: HEALTHY_GIT });
    const r = await doctor(bin);

    expect(r.code).toBe(EXIT.BACKEND_UNAVAILABLE);
    const d = findDiagnosis(r, "docker-version-below-minimum");
    expect(d.class).toBe("wrong-version");
    expect(d.message).toContain("23.0.0");
  }, cliBudget(1));

  /**
   * A banner `doctor` cannot parse is not evidence of health. Reporting it as
   * a pass would be the same "we cannot say it is healthy" mistake the cmux
   * capability probe already refuses to make — but the message says the floor
   * could not be VERIFIED, not that it was violated, because those are
   * different things and only one of them is known.
   *
   * The class is `misconfigured`, not `wrong-version`. Nothing parsed, so
   * nothing lost a comparison and the tool may be perfectly current; what is
   * known is that `git` on this PATH does not answer with a banner pifleet
   * recognises. The message has always ended "check what `git` resolves to on
   * PATH", which is a configuration fix — tagging that `wrong-version` sent
   * an operator filtering on the class to upgrade on no evidence at all.
   */
  test("an unreadable version banner is reported as unverified, not as a pass", async () => {
    const bin = await shimBin({ docker: healthyDocker("28.0.1"), git: script('echo "git version unknown"') });
    const r = await doctor(bin);

    expect(r.code).toBe(EXIT.BACKEND_UNAVAILABLE);
    const d = findDiagnosis(r, "git-version-unreadable");
    expect(d.class).toBe("misconfigured");
    expect(d.message).toContain("2.32.0");
    // The distinction that makes the retag worth having: an unverifiable
    // banner must not appear anywhere in the "upgrade something" bucket.
    expect(r.json.diagnosis_classes).toContain("misconfigured");
    expect(r.json.diagnosis_classes).not.toContain("wrong-version");
  }, cliBudget(1));

  test("a required binary at or above its floor produces no diagnosis", async () => {
    const bin = await shimBin({ docker: healthyDocker("23.0.0"), git: script('echo "git version 2.32.0"') });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.SUCCESS);
    expect(r.json.diagnoses).toEqual([]);
    const docker = r.json.probes.find((p) => p.name === "docker");
    expect(docker?.floor).toEqual({ min: "23.0.0", status: "ok" });
  }, cliBudget(1));
});

/**
 * ISC-159 asks for the three to be told apart; it does not ask for three exit
 * codes, and `doctor` deliberately does not mint any. One run can trip all
 * three at once, so a single scalar cannot carry the distinction — collapsing
 * them into one number would destroy exactly what the criterion wants. The
 * class travels in the report, and the code stays the §11 value.
 */
describe("the three classes are distinguishable without being separate exit codes", () => {
  const scenarios = {
    missing: { git: HEALTHY_GIT },
    daemon: { docker: daemonlessDocker("28.0.1"), git: HEALTHY_GIT },
    version: { docker: healthyDocker("28.0.1"), git: script('echo "git version 2.20.1"') },
  } satisfies Record<string, Shims>;

  test("each class exits 3 with its own name, class, and message", async () => {
    const runs = await Promise.all(
      Object.values(scenarios).map(async (s) => doctor(await shimBin(s))),
    );

    for (const r of runs) {
      expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
      expect(r.json.ok).toBe(false);
    }

    expect(runs.map((r) => r.json.diagnosis_classes)).toEqual([
      ["missing-binary"],
      ["absent-daemon"],
      ["wrong-version"],
    ]);

    // Distinguishable messages, not three renderings of one sentence — the
    // "actionable message" half of the criterion, which a shared class tag
    // would otherwise let slide.
    const messages = new Set(runs.map((r) => r.json.diagnoses.map((d) => d.message).join("|")));
    expect(messages.size).toBe(3);
  }, cliBudget(1));

  /**
   * The human branch of `register` is a separate code path from `--json` and
   * has to carry the class too, or the operator reading a terminal still sees
   * the undifferentiated wall the JSON no longer is.
   */
  test("the class leads each line of the operator-facing report", async () => {
    const out = await Promise.all(
      Object.values(scenarios).map(async (s) => doctorHuman(await shimBin(s))),
    );
    expect(out[0]).toContain("DIAGNOSIS [missing-binary]");
    expect(out[1]).toContain("DIAGNOSIS [absent-daemon]");
    expect(out[2]).toContain("DIAGNOSIS [wrong-version]");
  }, cliBudget(1));

  /**
   * `diagnosis_classes` is an ARRAY because one run can trip several classes
   * at once — which is the stated reason the exit code refuses to encode the
   * class at all. Every other case here drives exactly one fault, so the
   * multi-class shape the field exists for was asserted nowhere: an
   * implementation that reported only the first class found, or that let the
   * last diagnosis overwrite the earlier one, passed the entire suite.
   */
  test("one run carries every class it found, deduplicated and sorted", async () => {
    const bin = await shimBin({
      docker: daemonlessDocker("28.0.1"), // absent-daemon
      git: script('echo "git version 2.20.1"'), // wrong-version
    });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    // Both findings survive, each keeping its own remediation.
    expect(findDiagnosis(r, "docker-daemon-unreachable").class).toBe("absent-daemon");
    expect(findDiagnosis(r, "git-version-below-minimum").class).toBe("wrong-version");
    expect(r.json.diagnosis_classes).toEqual(["absent-daemon", "wrong-version"]);
  }, cliBudget(1));

  /**
   * The same shape with `misconfigured` in it — the class that had no coverage
   * of its own at all. A stopped daemon beside a git whose banner will not
   * parse: two findings, two classes, one exit code, neither erased by the
   * other, and the unparseable banner NOT filed under "upgrade something".
   */
  test("a misconfigured finding coexists with another class", async () => {
    const bin = await shimBin({
      docker: daemonlessDocker("28.0.1"), // absent-daemon
      git: script('echo "git version unknown"'), // misconfigured
    });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(r.json.diagnoses).toHaveLength(2);
    expect(r.json.diagnosis_classes).toEqual(["absent-daemon", "misconfigured"]);
    expect(findDiagnosis(r, "git-version-unreadable").class).toBe("misconfigured");
  }, cliBudget(1));
});

/**
 * tmux is probed `required: false` — the fleet runs on headless by design and
 * an absent tmux has never been a diagnosis. A too-old tmux must therefore
 * not be one either: "absent is fine, but stale is fatal" is incoherent, and
 * it would fail a machine over a backend the operator may never select.
 * Reported, never required — the same shape `read-screen` already has.
 */
describe("an optional tool's floor is reported, not enforced", () => {
  test("a below-floor tmux withdraws the backend without failing the run", async () => {
    const bin = await shimBin({
      docker: healthyDocker("28.0.1"),
      git: HEALTHY_GIT,
      tmux: script('echo "tmux 1.8"'),
    });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.SUCCESS);
    expect(r.json.diagnoses).toEqual([]);
    // The verdict that DOES change: pifleet will not drive this tmux.
    expect(r.json.backends["tmux"]).toBe(false);
    const tmux = r.json.probes.find((p) => p.name === "tmux");
    expect(tmux?.floor).toEqual({ min: "2.4.0", status: "below" });
    // Still reported, or the operator cannot tell why the backend vanished.
    expect(tmux?.detail).toContain("2.4.0");
  }, cliBudget(1));

  test("a current tmux keeps the backend", async () => {
    const bin = await shimBin({
      docker: healthyDocker("28.0.1"),
      git: HEALTHY_GIT,
      tmux: script('echo "tmux 3.6a"'),
    });
    const r = await doctor(bin);

    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.json.backends["tmux"]).toBe(true);
  }, cliBudget(1));

  /**
   * A tmux that is present and working must not disappear from the report.
   *
   * `backends.tmux` gated on `floor?.status === "ok"`, which folded the third
   * status, `unreadable`, in with `below` and withdrew the backend. Nothing
   * announced it: `floorDiagnosis` returns null for an optional tool, so the
   * run pushed no finding and exited 0. The operator was told the tmux backend
   * was unavailable and given no sentence anywhere in the report saying why —
   * strictly worse than the merge ISC-159 set out to undo, because at least a
   * merged diagnosis is a diagnosis.
   *
   * `tmux master` is what makes this concrete rather than theoretical: a tmux
   * built from git prints exactly that, and it is NEWER than every numbered
   * release. `TmuxBackend.probe()` keeps the banner token as a string and so
   * reports `ok: true` for it — meaning `doctor` called a tmux dead that
   * `up --backend tmux` then drove without complaint.
   */
  test("an unparseable tmux banner keeps the backend rather than silently dropping it", async () => {
    const bin = await shimBin({
      docker: healthyDocker("28.0.1"),
      git: HEALTHY_GIT,
      tmux: script('echo "tmux master"'),
    });
    const r = await doctor(bin);

    expect(r.code, `stderr: ${r.stderr.slice(0, 600)}`).toBe(EXIT.SUCCESS);
    // The regression itself. Absence of evidence that tmux is stale is not
    // evidence that it is — and this binary is ahead of the floor, not behind.
    expect(r.json.backends["tmux"]).toBe(true);

    const tmux = r.json.probes.find((p) => p.name === "tmux");
    expect(tmux?.ok).toBe(true);
    // `unreadable` must survive as its own status all the way into the report;
    // if it ever reads `below` here the gate has been re-collapsed upstream.
    expect(tmux?.floor).toEqual({ min: "2.4.0", status: "unreadable" });

    // No verdict may be reached without a sentence for it. The verdict here is
    // "keep the backend", so the correct report is an empty one.
    expect(r.json.diagnoses).toEqual([]);
  }, cliBudget(1));

  /**
   * The two non-`ok` floor statuses, side by side, reaching OPPOSITE verdicts.
   *
   * Pinned together in one test because the bug was precisely that they
   * converged. Everything else about these two runs matches — same optional
   * tool, same exit, same empty diagnosis list — so `backends.tmux` is the
   * only thing distinguishing "confirmed too old to drive" from "cannot tell,
   * and no reason to doubt it", and it has to keep doing so.
   */
  test("unreadable and below-the-floor reach opposite backend verdicts", async () => {
    const [unreadable, below] = await Promise.all([
      doctor(
        await shimBin({
          docker: healthyDocker("28.0.1"),
          git: HEALTHY_GIT,
          tmux: script('echo "tmux master"'),
        }),
      ),
      doctor(
        await shimBin({
          docker: healthyDocker("28.0.1"),
          git: HEALTHY_GIT,
          tmux: script('echo "tmux 1.8"'),
        }),
      ),
    ]);

    expect(unreadable.json.backends["tmux"]).toBe(true);
    expect(below.json.backends["tmux"]).toBe(false);

    // Neither fails the run — tmux is optional, and this fix does not change
    // that. The difference is confined to which backends are on offer.
    expect(unreadable.code).toBe(EXIT.SUCCESS);
    expect(below.code).toBe(EXIT.SUCCESS);
    expect(unreadable.json.diagnoses).toEqual([]);
    expect(below.json.diagnoses).toEqual([]);
  }, cliBudget(2));
});
