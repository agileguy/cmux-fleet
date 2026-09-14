/**
 * Every binary pifleet's OWN code spawns is installed in the worker image.
 *
 * WHAT WAS BROKEN. `safety/procstart.ts` and `safety/procgroup.ts` shell out to
 * `ps`; it is how a run decides whether a pid is alive before it stops, reaps
 * or prunes anything. The base image installed
 * `bash ca-certificates git ripgrep fd-find jq curl less tini gnupg` and not
 * `procps`, so no worker container had `ps` at all.
 *
 * The wrapper in `procstart.ts` names this exact scenario — "the likeliest real
 * instance of 'the measuring instrument is broken': a minimal container image
 * with no procps" — and converts the raw spawn throw into an `IdentityReadError`
 * so it reports as an environment failure instead of a pifleet bug. What nobody
 * noticed is that the worker image WAS that minimal container.
 *
 * MEASURED. Dispatching this repository's own unit suite to a tester produced
 * `3091 pass, 55 fail`; 35 of the 55 were `ps`, spread across six files that
 * name nothing about processes — `staged-visibility`, `monitor-read`,
 * `status-live-run`. Installing `procps` into the same image and rerunning took
 * all six to zero failures. The symptom nowhere resembled the cause, because
 * `IdentityReadError` wears `EXIT.BACKEND_UNAVAILABLE`: a `wait` that should
 * have exited 9 exited 3, and the reader is sent to look at a backend.
 *
 * THE FAIL-OPEN THIS CLOSES. The dependency is invisible from both ends. The
 * Dockerfile has no reason to mention `ps`, and the TypeScript that needs it
 * spawns a bare string — no import, no manifest entry, nothing a build or a
 * typecheck can follow. `tsc` is green either way and so is every test that
 * runs on a developer's machine, because a Mac has `ps`. This test is the only
 * thing that connects the two files.
 *
 * It greps source off disk, so it runs in the fast job rather than behind the
 * `PIFLEET_DOCKER=1` image gate.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dockerfilePath } from "../../src/container/image.ts";

/** Binaries pifleet spawns by bare name, and the package that provides each. */
const RUNTIME_BINARIES: ReadonlyArray<{
  bin: string;
  aptPackage: string;
  /** A source file that spawns it, so the claim is checkable and not folklore. */
  spawnedBy: string;
}> = [
  { bin: "ps", aptPackage: "procps", spawnedBy: "src/safety/procstart.ts" },
  { bin: "git", aptPackage: "git", spawnedBy: "src/harvest/git.ts" },
];

/** The packages named across every `apt-get install` in the Dockerfile. */
export function aptPackages(dockerfile: string): Set<string> {
  const out = new Set<string>();
  // Fold `\`-continuations so a package on its own line is still seen as part
  // of the install it belongs to, then take the words after `install`.
  const folded = dockerfile
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");
  for (const line of folded.split("\n")) {
    const at = line.indexOf("apt-get install");
    if (at === -1) continue;
    for (const word of line.slice(at).split(/\s+/).slice(2)) {
      if (word.startsWith("-") || word === "&&" || word === "\\") continue;
      if (word.includes("$") || word.includes(";")) continue;
      out.add(word);
    }
  }
  return out;
}

const DOCKERFILE = readFileSync(dockerfilePath(), "utf8");
const REPO = new URL("../../", import.meta.url).pathname;

describe("the image ships what pifleet itself spawns", () => {
  test("the sweep finds the base image's packages, so it is not vacuous", () => {
    const found = aptPackages(DOCKERFILE);
    // A parse that silently matched nothing would pass every assertion below.
    expect(found.size).toBeGreaterThan(5);
    expect(found).toContain("bash");
  });

  for (const { bin, aptPackage, spawnedBy } of RUNTIME_BINARIES) {
    test(`\`${bin}\` is spawned by ${spawnedBy}, and ${aptPackage} is installed`, () => {
      // Both halves, so neither can rot alone: if the spawn goes away the
      // dependency can be dropped deliberately, and until it does the package
      // has to be there.
      const source = readFileSync(`${REPO}${spawnedBy}`, "utf8");
      expect(source).toContain(`"${bin}"`);
      expect(aptPackages(DOCKERFILE)).toContain(aptPackage);
    });
  }

  test("the sweep reports a base image that dropped procps", () => {
    // The assertions above are ones a reader can demonstrably make fail.
    const stripped = DOCKERFILE.replace(" procps ", " ");
    expect(aptPackages(stripped).has("procps")).toBe(false);
    expect(aptPackages(DOCKERFILE).has("procps")).toBe(true);
  });
});

/**
 * `ssh` does not fit the table above honestly (SRD-OBSERVER-ROLES task 3.3).
 *
 * `RUNTIME_BINARIES`'s check is `source.includes('"${bin}"')` — built for the
 * TypeScript call sites above, where the binary is a quoted string literal
 * passed to a spawn helper. `ssh` is spawned by `docker/observe-ssh`, POSIX
 * `sh`, not by anything under `src/`, and its own call site is unquoted —
 * `exec ssh \` (SRD-OBSERVER-ROLES §5.2 task 3.2) — so the literal `"ssh"`
 * this table demands never appears there. Forcing it into the table would
 * either fail on an honest shim or have to be satisfied by rewriting the shim
 * to suit the test, which is backwards. `ssh` gets its own pair of
 * assertions instead, in the same shape as the `procps` check above: that
 * `observe-ssh` really does invoke it, and that `openssh-client` — the
 * package that provides it — is installed.
 */
describe("observe-ssh's ssh dependency (SRD-OBSERVER-ROLES task 3.3)", () => {
  const OBSERVE_SSH = readFileSync(`${REPO}docker/observe-ssh`, "utf8");

  test("docker/observe-ssh really execs ssh, so the claim below is checkable", () => {
    expect(OBSERVE_SSH).toMatch(/\bexec ssh\b/);
  });

  test("openssh-client is installed in the base image", () => {
    expect(aptPackages(DOCKERFILE)).toContain("openssh-client");
  });

  test("the sweep reports a base image that dropped openssh-client", () => {
    const stripped = DOCKERFILE.replace(" openssh-client ", " ");
    expect(aptPackages(stripped).has("openssh-client")).toBe(false);
    expect(aptPackages(DOCKERFILE).has("openssh-client")).toBe(true);
  });
});

/**
 * The shim is actually exercised at build time, not just present on disk
 * (SRD-OBSERVER-ROLES task 3.3, round-2 follow-up). Presence checks — the
 * COPY exists, the package is installed — do not prove either smoke command
 * still runs: a `RUN set -eux; \` block is a hand-maintained list, and a line
 * dropped from it is silent everywhere else, the same fail-open ISC-270
 * documents for `BUILD_CONTEXT_ASSETS`. It also does not prove the COPY runs
 * BEFORE the block that calls it — a COPY placed after that RUN fails the
 * real build, which no unit test observes, so the ordering is asserted here
 * instead of left to the first Docker build to find it.
 */
describe("observe-ssh is exercised at build time (SRD-OBSERVER-ROLES task 3.3)", () => {
  /** Anchors the smoke `RUN` block; `gcloud version` appears nowhere else. */
  const SMOKE_ANCHOR = "RUN set -eux; \\\n    gcloud version";

  /** The smoke RUN block's text, up to the blank line that ends it. */
  function smokeBlock(): string {
    const start = DOCKERFILE.indexOf(SMOKE_ANCHOR);
    expect(start, "expected the smoke RUN block (gcloud version …) in docker/Dockerfile").toBeGreaterThan(
      -1,
    );
    const end = DOCKERFILE.indexOf("\n\n", start);
    return DOCKERFILE.slice(start, end === -1 ? undefined : end);
  }

  test("the smoke RUN block runs `ssh -V`", () => {
    expect(smokeBlock()).toContain("ssh -V;");
  });

  test("the smoke RUN block runs `observe-ssh --help`", () => {
    expect(smokeBlock()).toContain("observe-ssh --help >/dev/null;");
  });

  test("the shim's COPY precedes the RUN block that executes it", () => {
    const copyIdx = DOCKERFILE.indexOf(
      "COPY --chmod=0755 docker/observe-ssh /usr/local/bin/observe-ssh",
    );
    expect(copyIdx, "expected observe-ssh's COPY line in docker/Dockerfile").toBeGreaterThan(-1);
    const runIdx = DOCKERFILE.indexOf(SMOKE_ANCHOR);
    expect(runIdx, "expected the smoke RUN block (gcloud version …) in docker/Dockerfile").toBeGreaterThan(
      -1,
    );
    // A COPY placed after the RUN that runs it would fail the real build.
    expect(copyIdx).toBeLessThan(runIdx);
  });
});
