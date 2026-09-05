/**
 * What `test/unit` silently assumes about the machine running it (and the lever
 * that stops it assuming quietly).
 *
 * ## The failure this exists to make visible
 *
 * `spawn-cli.ts` documents one direction of this problem: a green build that
 * was "not evidence the suite was sound — it was evidence the runner lacked the
 * state that breaks it". This module is the mirror image. A green
 * `bun test test/unit` on a developer's Mac was not evidence the suite was
 * hermetic; it was evidence the Mac HAD the things the suite reaches for
 * without saying so.
 *
 * MEASURED. Dispatching this repository's own unit suite to a container worker
 * returned `3091 pass, 55 fail` — on an unmodified checkout that was green
 * everywhere it had ever been run. Thirty-three of those were a genuine image
 * defect (`procps`, now fixed and pinned by `dockerfile-runtime-deps.test.ts`)
 * and eleven were a leaked seam (`ensureUplinkNetwork` took no `exec`, so tests
 * holding a fake daemon spawned the real docker binary; closed in
 * `security/network.ts`). The eleven left are this module's subject: unit tests
 * that need an executable temp directory or a real writable `$HOME`.
 *
 * `docker` is deliberately NOT a capability here. It was, for as long as those
 * eleven relay tests needed the binary — and gating them was the wrong repair,
 * because they were never meant to touch it. A capability nobody gates on is
 * the same unexamined claim a stale coverage exemption is, so it goes when its
 * last user does.
 *
 * ## Why capability PROBES rather than an opt-in flag
 *
 * `test/integration` gates on `PIFLEET_DOCKER=1` — default-skip, opt in. That
 * polarity is right there and wrong here. A unit test that skips unless someone
 * remembers a flag is a unit test that stops running on every laptop in the
 * project, and nobody would notice for months. So these run WHEREVER THEY CAN
 * and step aside only where the capability is provably absent.
 *
 * ## The fail-closed lever
 *
 * Probing has its own failure mode, and it is the worse one: a probe broken to
 * return `false` skips its tests everywhere, on CI included, and every run is
 * green. `PIFLEET_REQUIRE_HOST_DEPS=1` turns a missing capability from a skip
 * into a hard failure, and CI sets it — so a probe that stops finding `docker`
 * on `ubuntu-latest` is a red build, not a quieter one.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** `$HOME` inside a pifleet worker image, from `docker/Dockerfile`. */
export const IMAGE_HOME = "/home/pi";

/** Set by CI. Turns every absent capability into a failure instead of a skip. */
export function requireHostDeps(): boolean {
  return process.env["PIFLEET_REQUIRE_HOST_DEPS"] === "1";
}

/** Is `name` on `PATH`? */
export function hasExecutable(name: string): boolean {
  return Bun.which(name) !== null;
}

let execTmp: boolean | null = null;

/**
 * Can a file written to the temp directory be EXECUTED?
 *
 * A worker mounts `/tmp` `noexec` (`config/render.ts`), so a test that writes a
 * fake `ps` or a stub `pi` onto `PATH` and runs it gets exit 126 — "found, not
 * executable" — which surfaces as whatever the code under test does with a
 * command that failed for a reason it never anticipated.
 *
 * Probed rather than inferred from the mount table: `noexec` is one way to lose
 * this, and a `TMPDIR` on a filesystem mounted the same way is another.
 */
export function hasExecutableTmpdir(): boolean {
  if (execTmp !== null) return execTmp;
  try {
    const dir = mkdtempSync(join(tmpdir(), "pifleet-execprobe-"));
    const script = join(dir, "probe.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    execTmp = Bun.spawnSync([script]).exitCode === 0;
  } catch {
    execTmp = false;
  }
  return execTmp;
}

/** Is this process's `$HOME` the one baked into the worker image? */
export function homeIsImageHome(): boolean {
  return process.env["HOME"] === IMAGE_HOME;
}

let hostHome: boolean | null = null;

/**
 * Is `$HOME` a real user's home — writable, and not the worker image's?
 *
 * Both halves were measured, and they fail differently:
 *
 *  - `render.test.ts` asserts that no rendered docker argv mounts the HOST's
 *    gcloud config directory, computing that path from `$HOME`. Inside a worker
 *    `$HOME` is `/home/pi`, which is also where the image mounts its own gcloud
 *    tmpfs — so the assertion collides with itself on a machine where the
 *    property it describes is not expressible.
 *  - `mount-preflight.test.ts` calls `mkdtemp(join(homedir(), ...))` to build
 *    a default-shaped root, and gets `EROFS: read-only file system` because the
 *    worker's `$HOME` sits on the read-only root.
 *
 * One capability rather than two: both tests want the same thing, an ordinary
 * home directory belonging to a person, and neither is meaningful without it.
 */
export function hasHostHome(): boolean {
  if (hostHome !== null) return hostHome;
  if (homeIsImageHome()) {
    hostHome = false;
    return hostHome;
  }
  try {
    const probe = mkdtempSync(join(homedir(), ".pifleet-homeprobe-"));
    rmSync(probe, { recursive: true, force: true });
    hostHome = true;
  } catch {
    hostHome = false;
  }
  return hostHome;
}

export interface HostCapability {
  /** Short name, used in the skip banner. */
  readonly name: string;
  readonly present: boolean;
  /** What a reader should do about it. */
  readonly needed: string;
}

/** Every capability `test/unit` depends on, evaluated once. */
export function hostCapabilities(): readonly HostCapability[] {
  return [
    {
      name: "exec-tmpdir",
      present: hasExecutableTmpdir(),
      needed: "a temp directory that is not mounted noexec; these tests write a stub onto PATH and run it",
    },
    {
      name: "host-home",
      present: hasHostHome(),
      needed:
        `a writable \$HOME that is not the worker image's ${IMAGE_HOME}; ` +
        "these tests compute host paths from it and create directories under it",
    },
  ];
}

/**
 * Gate for a test that needs `name`. `true` runs it.
 *
 * Under `PIFLEET_REQUIRE_HOST_DEPS=1` this always returns `true`, so the test
 * runs and FAILS on the missing capability rather than disappearing.
 */
export function hostHas(name: string): boolean {
  // The name is validated BEFORE the lever, not after. A typo'd capability
  // gates its test on a value nothing produces, and the whole point of the
  // lever is that CI is where that gets noticed — so an early `return true`
  // would make CI the one place the typo is invisible.
  const cap = hostCapabilities().find((c) => c.name === name);
  if (cap === undefined) throw new Error(`unknown host capability ${JSON.stringify(name)}`);
  if (requireHostDeps()) return true;
  return cap.present;
}

let announced = false;

/** Print one `[skip]` line per absent capability, once per process. */
export function announceMissingHostDeps(): void {
  if (announced) return;
  announced = true;
  if (requireHostDeps()) return;
  for (const cap of hostCapabilities()) {
    if (cap.present) continue;
    console.log(
      `[skip] host capability ${JSON.stringify(cap.name)} is absent — tests that need it will not run. ` +
        `Needs ${cap.needed}. Set PIFLEET_REQUIRE_HOST_DEPS=1 to fail instead of skipping.`,
    );
  }
}
