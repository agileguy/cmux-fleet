/**
 * The capability probes themselves, and the lever that stops them lying.
 *
 * `host-deps.ts` exists because `bun test test/unit` was green on every machine
 * it had ever run on and failed 55 tests the first time a container worker ran
 * it. Twenty-two of those survive as capability-gated tests. A gate is a way to
 * stop a test failing, which makes it also a way to stop a test RUNNING, so the
 * probes need their own guard: a `hasExecutable` that returned `false` for
 * everything would skip all twenty-two, on CI included, and go green.
 *
 * Hence `PIFLEET_REQUIRE_HOST_DEPS=1`, which CI sets: under it `hostHas`
 * returns `true` unconditionally, the gated tests run, and a genuinely absent
 * capability is a red build rather than a quieter one. The tests below pin both
 * halves — that the probes answer honestly, and that the lever overrides them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  IMAGE_HOME,
  hasExecutable,
  hasExecutableTmpdir,
  hasHostHome,
  homeIsImageHome,
  hostCapabilities,
  hostHas,
  requireHostDeps,
} from "../support/host-deps.ts";

const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url).pathname, "utf8");

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe("the probes answer about this machine, not about a flag", () => {
  test("hasExecutable finds something that exists and misses something that does not", () => {
    // Both directions: a probe stuck on `true` is as useless as one stuck on
    // `false`, and only the second is caught by the CI lever.
    expect(hasExecutable("sh")).toBe(true);
    expect(hasExecutable("pifleet-no-such-binary-a7f3")).toBe(false);
  });

  test("every capability is named, and the set is not empty", () => {
    const caps = hostCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.name).not.toBe("");
      // The banner tells a reader what to do about it; an empty string would
      // print a skip nobody can act on.
      expect(c.needed.length).toBeGreaterThan(20);
    }
    expect(caps.map((c) => c.name).sort()).toEqual(["docker", "exec-tmpdir", "host-home"]);
  });

  test("hostHas refuses a name it does not know", () => {
    // A typo'd capability would otherwise gate a test on `undefined` and skip
    // it forever.
    expect(() => hostHas("not-a-capability")).toThrow(/unknown host capability/);
  });

  test("the image's own $HOME is recognised as the image's", () => {
    // Both directions, without assuming which one this machine is. The suite
    // runs inside a worker often enough that "we are not in the image" is not
    // a fact any test may assert — that assumption is the whole class of bug
    // this module was written for.
    expect(withEnv("HOME", IMAGE_HOME, () => homeIsImageHome())).toBe(true);
    expect(withEnv("HOME", "/home/a-real-person", () => homeIsImageHome())).toBe(false);
  });
});

describe("PIFLEET_REQUIRE_HOST_DEPS turns a skip into a failure", () => {
  test("the lever is off by default here, and the probes are consulted", () => {
    expect(withEnv("PIFLEET_REQUIRE_HOST_DEPS", undefined, () => requireHostDeps())).toBe(false);
  });

  test("under the lever, hostHas is true even for a capability that is absent", () => {
    withEnv("PIFLEET_REQUIRE_HOST_DEPS", "1", () => {
      expect(requireHostDeps()).toBe(true);
      // Whatever this machine lacks, every gate opens — so the gated test runs
      // and fails on the real cause instead of vanishing from the count.
      for (const c of hostCapabilities()) expect(hostHas(c.name)).toBe(true);
    });
  });

  test("CI sets the lever on the unit job", () => {
    // Without this the lever is a feature nobody turned on, and the fail-open
    // it closes is open again.
    expect(CI).toContain('PIFLEET_REQUIRE_HOST_DEPS: "1"');
    const unit = /- name: Unit tests[\s\S]*?run: bun test test\/unit/.exec(CI);
    expect(unit, "the unit-test step could not be located").not.toBeNull();
    expect(unit![0]).toContain("PIFLEET_REQUIRE_HOST_DEPS");
  });
});

describe("this machine's capabilities, stated rather than assumed", () => {
  // Not assertions about every machine — statements about THIS one, so a run
  // that skipped tests leaves a record of why in its own output.
  test("the probes agree with each other about this machine", () => {
    // Not a claim about every machine — a consistency check on THIS one, so a
    // run that skipped tests leaves a record of why in its own output.
    if (homeIsImageHome()) {
      // Inside a worker image: `$HOME` is the image's, so it is not a host home
      // however writable it happens to be.
      expect(hasHostHome()).toBe(false);
      return;
    }
    expect(hasExecutableTmpdir()).toBe(true);
    expect(hasHostHome()).toBe(true);
  });
});
