/**
 * `doctor`'s launch preflight over BIND-MOUNT SOURCES (ISC-292).
 *
 * ## The hazard
 *
 * On macOS the container runtime is a Linux VM and only a declared set of host
 * directories is shared into it. A `-v <src>:<dst>` whose `<src>` lies outside
 * that set DOES NOT FAIL. The VM has no such path, so the runtime creates an
 * empty directory and mounts that — the container sees an empty directory where
 * the host has content, and exits 0.
 *
 * It cost a false diagnosis once already: a run dir under `/var/folders`
 * produced `EISDIR` on a briefing file that was a perfectly good 995-byte
 * regular file on the host, which reads as a mount-table bug in `render.ts` and
 * is not one. That case was LOUD only because a worker tried to read the mount
 * as a file. `/workspace`, `/skills` and `/outbox` would each have mounted
 * empty and produced a worker that ran, found no code and no skills, wrote its
 * outbox where nothing would collect it, and named the cause in no log.
 *
 * ## Why these tests are shaped as an AGREEMENT check
 *
 * The set of shared paths is a property of the RUNTIME, and this suite has to
 * pass on all of them. Measured on the machine this was written on — colima
 * 0.9.x, macOS Virtualization.Framework, virtiofs — the VM's `/proc/mounts`
 * contains exactly ONE host share:
 *
 *     mount0 /Users/de895996 virtiofs rw,relatime 0 0
 *
 * so `$HOME` is shared and `/private/tmp`, `/tmp` and `os.tmpdir()` are not. On
 * a native Linux daemon every path is shared and none of that holds. Hardcoding
 * either answer would produce a test that is green on one runtime and red on
 * another while the CODE is correct in both.
 *
 * So the assertion is not "this path is unshared". It is that **`doctor`'s
 * verdict matches an independent measurement of the same path**, taken by this
 * file with its own `docker run`, and that a diagnosis is raised exactly when
 * the path is invisible. That contract is runtime-agnostic because it never
 * names a runtime — it compares two measurements of whatever the runtime does.
 *
 * WHAT IT ASSUMES: that `docker` here is the same daemon `doctor` will use.
 * Both go through the ambient `DOCKER_HOST`/context, so a test that pointed at
 * one daemon while `doctor` used another would compare two different machines.
 * Nothing in this repo switches contexts mid-run, and the alternative — parsing
 * a VM's mount table — is precisely the runtime-specific check this avoids.
 *
 * Gated `PIFLEET_DOCKER=1`, exactly like the egress, relay and image suites: it
 * needs a real daemon and there is nothing meaningful to assert without one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { containerBudget } from "../support/budget.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");
const DOCKER = process.env["PIFLEET_DOCKER"] === "1";

if (!DOCKER) {
  console.warn(
    "[skip] test/integration/doctor-preflight.test.ts needs a container daemon. " +
      "Run with PIFLEET_DOCKER=1.",
  );
}

const it = test.skipIf(!DOCKER);

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A scratch directory under `root`, remembered for teardown. */
async function scratchUnder(root: string): Promise<string> {
  const d = await mkdtemp(join(root, "pifleet-isc292-"));
  made.push(d);
  return d;
}

/**
 * An INDEPENDENT measurement of whether `dir` is really shared into the
 * runtime — this file's own, not the product's.
 *
 * Deliberately does not import `probeMountVisibility`. The whole value of the
 * agreement assertion is that the two sides are arrived at separately; calling
 * the product's helper to check the product's verdict would compare a function
 * with itself and pass no matter what either did.
 */
async function sharedWithRuntime(dir: string): Promise<boolean> {
  const token = `isc292-${process.pid}-${Date.now()}`;
  await writeFile(join(dir, "independent-sentinel"), `${token}\n`);
  const p = Bun.spawn(
    [
      "docker", "run", "--rm",
      "-v", `${dir}:/probe:ro`,
      "--entrypoint", "/bin/sh",
      IMAGE,
      "-c", "cat /probe/independent-sentinel 2>&1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return stdout.includes(token);
}

/** Any image with a shell. The relay's pinned base is present wherever the relay has run. */
const IMAGE = process.env["PIFLEET_TEST_IMAGE"] ?? "alpine:3";

interface MountRoot {
  name: string;
  env: string;
  dir: string;
  visible: boolean;
  probed: boolean;
  detail: string;
}

interface DoctorJson {
  mounts: { runs_dir: string; visible: boolean; detail: string; roots: MountRoot[] };
  diagnoses: Array<{ name: string; class: string; message: string }>;
}

/**
 * `doctor --json` with the runs root pointed wherever the caller says.
 *
 * `HOME` is left ALONE, unlike `doctor-diagnoses.test.ts`, and the reason is
 * this criterion specifically: `$HOME` is the one path the measured runtime
 * shares, so relocating it would move the very variable under test.
 */
async function doctor(runsDir: string, scratchDir: string): Promise<{ code: number; json: DoctorJson }> {
  const p = Bun.spawn([process.execPath, CLI, "doctor", "--json"], {
    env: { ...process.env, PIFLEET_RUNS_DIR: runsDir, PIFLEET_SCRATCH_DIR: scratchDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`doctor --json emitted no JSON (exit ${code}). stderr: ${stderr.slice(0, 800)}`);
  }
  return { code, json: JSON.parse(stdout.slice(start)) as DoctorJson };
}

function root(json: DoctorJson, name: string): MountRoot {
  const found = json.mounts.roots.find((r) => r.name === name);
  if (found === undefined) {
    throw new Error(`doctor reported no mount root named ${name}: ${JSON.stringify(json.mounts)}`);
  }
  return found;
}

describe("a bind-mount source outside the runtime's shared paths is reported (ISC-292)", () => {
  /**
   * The criterion, as an agreement between two independent measurements.
   *
   * Runs against BOTH a path under `$HOME` and one under `os.tmpdir()` — the
   * two candidates the recorded incident distinguishes — so on a runtime where
   * they differ this test exercises the reporting path in both directions, and
   * on one where they do not it still proves the verdicts are measured rather
   * than assumed.
   *
   * Six container operations: two `docker run` per candidate from
   * `sharedWithRuntime`, plus the probes `doctor` itself performs.
   */
  it(
    "doctor's verdict for each mount root matches an independent bind-mount measurement",
    async () => {
      const home = await scratchUnder(homedir());
      const temp = await scratchUnder(tmpdir());

      const homeShared = await sharedWithRuntime(home);
      const tempShared = await sharedWithRuntime(temp);
      console.log(
        `[measured] ${IMAGE} on this runtime: $HOME shared=${homeShared}, os.tmpdir() shared=${tempShared}`,
      );

      // The runs root under one candidate, the scratch root under the other, so
      // ONE doctor run covers both directions wherever they differ.
      const r = await doctor(temp, home);

      const runs = root(r.json, "runs_dir");
      const scratch = root(r.json, "scratch_dir");

      // Both were actually MEASURED — a skipped probe must never read as a
      // verdict. This is also the ISC-292 self-skip fix: no worker image is
      // built in this checkout and the probe still ran.
      expect(runs.probed).toBe(true);
      expect(scratch.probed).toBe(true);

      // THE AGREEMENT. doctor's answer for each path equals this file's own.
      expect(runs.visible).toBe(tempShared);
      expect(scratch.visible).toBe(homeShared);

      // The env var that set the path is named, because that is the knob the
      // operator has to turn.
      expect(runs.env).toBe("PIFLEET_RUNS_DIR");
      expect(scratch.env).toBe("PIFLEET_SCRATCH_DIR");

      /**
       * A diagnosis EXACTLY when a root is invisible — in both directions.
       *
       * The negative half is what stops this passing vacuously: a `doctor` that
       * emitted the diagnosis unconditionally would satisfy the positive half
       * on every machine while being useless.
       */
      const named = (n: string) => r.json.diagnoses.some((d) => d.name === n);
      expect(named("runs-dir-not-mountable")).toBe(!tempShared);
      expect(named("scratch-dir-not-mountable")).toBe(!homeShared);

      // And an invisible root must make `doctor` REFUSE, not merely mention it
      // — "says so rather than launching".
      if (!tempShared || !homeShared) {
        expect(r.code).not.toBe(0);
        const d = r.json.diagnoses.find((x) => x.name.endsWith("-not-mountable"))!;
        expect(d.class).toBe("misconfigured");
        // The message must say what actually happens, since the whole hazard is
        // that the operator sees no error at all.
        expect(d.message).toContain("EMPTY directory");
      }
    },
    containerBudget(6),
  );

  /**
   * A path under `$HOME` must not be reported as a fault.
   *
   * The complement of the test above and not a duplicate of it: this one pins
   * the shape of a HEALTHY report, which is what a check that learned to cry
   * wolf would break. `doctor`'s exit code is deliberately not asserted — a
   * developer machine legitimately carries unrelated diagnoses (no cmux, no
   * image) and this criterion is not entitled to grade those.
   *
   * Three container operations: one independent `docker run`, two from doctor.
   */
  it(
    "the default-shaped roots under $HOME raise no mount diagnosis",
    async () => {
      const home = await scratchUnder(homedir());
      if (!(await sharedWithRuntime(home))) {
        // Not a skip: on a runtime that shares nothing under $HOME the DEFAULT
        // configuration is itself broken, and saying so is the right outcome.
        console.warn(
          `[note] $HOME is not shared with this runtime, so pifleet's DEFAULT runs root ` +
            `is unmountable here — the diagnosis below is correct, not a test failure.`,
        );
      }
      const r = await doctor(join(home, "runs"), join(home, "scratch"));
      for (const m of r.json.mounts.roots) {
        expect(m.probed).toBe(true);
        expect(m.visible).toBe(true);
        expect(m.detail).toContain("visible inside the container");
      }
      expect(r.json.diagnoses.filter((d) => d.name.endsWith("-not-mountable"))).toEqual([]);
    },
    containerBudget(3),
  );
});
