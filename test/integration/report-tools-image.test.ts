/**
 * `report-tools.ts` INSIDE THE REAL IMAGE (SRD-WORKER-DISPATCH-EXTENSION §12,
 * "The image (D1)", second bullet) — the only check in this tree that spans the
 * `tsconfig` boundary of §3.2.
 *
 * ## Why a container and not a stub
 *
 * `test/unit/report-tools.test.ts` already drives `register()` against a
 * recording `pi` and asserts it pushes exactly `submit_report`. That is a test
 * of THIS repository's source. It says nothing about whether the file reached
 * the image, whether Pi's real loader accepts it, or whether Pi's registry ends
 * up holding the name — and §9's failure modes 9.1/9.2/9.3 are all failures of
 * precisely that span:
 *
 *   9.1 the extension fails to load — `docs/extensions.md` §Error Handling:
 *       *"Extension errors are logged, agent continues"*. Pi starts, the tool is
 *       simply absent, and under §12.2's layer 1 the worker has no writing verb
 *       at all. There is no non-zero exit anywhere to notice.
 *   9.2/9.3 the name the image serves and the name config may REQUEST drift
 *       apart. `--tools` does no validation (§0.2, row 7, measured): a name the
 *       image does not serve is granted silently.
 *
 * A stub cannot reach any of those, because in a stub the loader, the registry
 * and the image are all this file's imagination.
 *
 * ## The assertion is a SET EQUALITY, as of Phase 5
 *
 * §12 SPLIT this criterion on 2026-09-07 and held it at a subset for three
 * phases. `PI_EXTENSION_TOOLS` names both `submit_report` and `get_replies` — it
 * is the vocabulary config may request — while Phase 2 shipped `report-tools.ts`
 * registering `submit_report` alone. A set-equality assertion filed then would
 * have been red for three phases by construction, which is a test that trains
 * its reader to ignore it, so the claim was: the registered set is a SUBSET of
 * the enum and CONTAINS `submit_report`.
 *
 * **Phase 5 registers `get_replies` and this file was tightened in the same
 * commit** (SRD task 5.4). The claim is now
 * `expect(registered).toEqual(new Set(PI_EXTENSION_TOOLS))`, and it is strictly
 * stronger in the direction the subset could not reach: **no name in the enum is
 * unserved by the image.** That is failure mode 9.3 — *"Name in `--tools`,
 * extension not in the image"*, which `--tools` answers by dropping the name
 * without an error (§0.2 row 7, measured) — and it is unreachable from a subset
 * assertion, which is green for an image that serves nothing at all beyond
 * `submit_report`.
 *
 * **The tightening adds no test.** It replaces two assertions inside the
 * existing `it` with one, so this file still collects two, and CI's
 * `TOTAL_EXPECTED` does not move.
 *
 * ## How the registered set is observed, and why it costs no model call
 *
 * Measured 2026-09-08 against `pifleet/pi-worker:0.79.6-base-72c16f4efb2f`:
 *
 *   - `pi --list-models` and everything else that exits before session start
 *     does NOT load extensions. Nothing can be learned from those.
 *   - `pi.getAllTools()` called from an extension's DEFAULT EXPORT throws
 *     `Extension runtime not initialized. Action methods cannot be called
 *     during extension loading.` — so the probe hooks `session_start` instead,
 *     which fires after every `-e` has loaded.
 *   - `pi -e … -ne --offline --session-dir /tmp -p hi` reaches `session_start`
 *     and only THEN fails with "No API key found for the selected model". So
 *     the whole registry is readable with no provider, no key and no network.
 *     `--session-dir /tmp` is required because the image root is read-only.
 *
 * The set is taken as a DIFFERENCE across two runs — one with the baked
 * extension on the argv, one without — rather than by filtering `getAllTools()`
 * against a list of built-ins. A filter would be a second copy of Pi's built-in
 * set maintained here, and it would attribute a name to this extension that any
 * other source had introduced. The difference attributes it to the one thing
 * that changed. The baseline run's assertion that it does NOT already carry
 * `submit_report` is what makes that attribution checkable rather than assumed.
 *
 * ## `--extension` is not on the worker argv yet
 *
 * Task 2.4 adds it to `src/config/render.ts`; this file predates it and must
 * not import that constant. `-e /opt/pifleet/report-tools.ts` is passed to `pi`
 * directly, and the path is read out of the Dockerfile's own `COPY` rather than
 * written twice.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import {
  assetDigestAt,
  buildContextPath,
  buildImage,
  dockerfilePath,
  imageInputs,
  imageTag,
  type BuildContextAsset,
} from "../../src/container/image.ts";
import { makeDaemonScratch } from "../../src/container/mounts.ts";
import { realExec } from "../../src/container/run.ts";
import { PI_EXTENSION_TOOLS } from "../../src/config/schema.ts";
import { containerBudget } from "../support/budget.ts";

const DOCKER = process.env.PIFLEET_DOCKER === "1";
if (!DOCKER) {
  console.warn(
    "[skip] test/integration/report-tools-image.test.ts needs a Docker daemon. " +
      "Run with PIFLEET_DOCKER=1 after 'pifleet image build'.",
  );
}

const it = test.skipIf(!DOCKER);

/**
 * The build runs in `beforeAll` under its own ceiling, so no per-test budget
 * ever has to cover it. Copied from `image.test.ts` for the same reason it
 * carries the number there: the image installs google-cloud-cli and a first,
 * uncached build legitimately runs for many minutes. Warm — the tag already
 * present — this is a layer-cache hit measured at a few seconds.
 */
const BUILD_TIMEOUT = 2_400_000;

/**
 * `base` rather than `node`: it is the smallest of the three worker images
 * (2.43 GB against 3.0 GB) and it is the toolchain the live console runs, so
 * the tag is normally already built. Nothing in this file is toolchain-specific
 * — the `COPY` under test is in the shared part of the Dockerfile — so the
 * cheapest image that carries it is the right one to probe.
 */
const TOOLCHAIN = "base" as const;

/**
 * A virtual config, NOT the repository's `fleet.yaml`, and the difference
 * matters: the operator's file is edited (an `apt_packages` entry, say), and a
 * test that read it would answer a rebuild of a 2.4 GB image for an edit that
 * has nothing to do with this criterion. The defaults below hash to the same
 * tag `fleet.yaml` does today — verified 2026-09-08, both
 * `pifleet/pi-worker:0.79.6-base-72c16f4efb2f` — so this costs no extra build
 * while staying independent of an unrelated edit.
 */
const CONFIG_YAML = `
version: 2
name: report-tools-image-test
docker:
  pi_version: "0.79.6"
run:
  repo: .
  budget:
    tokens_ceiling: 1000000
llm:
  model: TestModel
roles:
  eng: { toolchain: node }
workers:
  - { id: w1, role: eng }
`;

/**
 * The build-context asset under test, TYPED against `BuildContextAsset`.
 *
 * This is the tripwire for the 2.3 revert. Removing
 * `"pi-extensions/report-tools.ts"` from `BUILD_CONTEXT_ASSETS` narrows that
 * union, so the `satisfies` below stops compiling (`bun run typecheck` red) and
 * `imageInputs(...).assets[…]` returns `undefined` at runtime (`bun test` red,
 * since bun strips the types). Reddening in only one of the two would be the
 * "type tripwires do not redden test probes" trap.
 */
const REPORT_TOOLS_ASSET = "pi-extensions/report-tools.ts" satisfies BuildContextAsset;

/** What the probe extension prints, and the only thing this file parses. */
const MARKER = "PIFLEET_TOOLS";

/**
 * The probe extension, written to a bind mount at run time rather than checked
 * in: it is scaffolding for one assertion, it must never be a file the image
 * could accidentally bake, and its whole body is the four lines below.
 *
 * Deliberately untyped (`any`). It is transpiled by Pi's own jiti inside the
 * container, never by this repository's `tsc`, and giving it a hand-written
 * `ExtensionAPI` here would be a second structural declaration of Pi's surface
 * — the thing §7.6 keeps to exactly one file.
 */
const PROBE_EXTENSION = `
export default function (pi) {
  pi.on("session_start", () => {
    const names = pi.getAllTools().map((t) => t?.definition?.name ?? t?.name);
    process.stderr.write("\\n${MARKER} " + JSON.stringify(names) + "\\n");
  });
}
`;

let loaded: LoadedConfig;
let tag: string;
let probeDir = "";
/** `/opt/pifleet/report-tools.ts`, read out of the Dockerfile's own `COPY`. */
let bakedPath = "";

/**
 * Where the Dockerfile `COPY`s one build-context source to.
 *
 * Read rather than restated. A test that hardcoded `/opt/pifleet/report-tools.ts`
 * would keep passing `-e` a path that no longer exists if the `COPY` moved, and
 * `pi` answers a missing `-e` path by logging and continuing (§9.1) — so the
 * probe would report a registry with no `submit_report` in it and the failure
 * would read as "the extension registers nothing" rather than "the file is not
 * there". Throwing here says which.
 */
function copyDestination(dockerfile: string, source: string): string {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^COPY\\s+(?:--\\S+\\s+)*${escaped}\\s+(\\S+)\\s*$`, "m").exec(dockerfile);
  if (!m?.[1]) throw new Error(`docker/Dockerfile has no COPY of ${source}`);
  return m[1];
}

beforeAll(async () => {
  if (!DOCKER) return;
  loaded = await parseConfig(CONFIG_YAML, "/virtual/report-tools-image/fleet.yaml");
  tag = imageTag(loaded.config, TOOLCHAIN);
  bakedPath = copyDestination(
    await readFile(dockerfilePath(), "utf8"),
    `docker/${REPORT_TOOLS_ASSET}`,
  );
  const built = await buildImage(loaded.config, { toolchain: TOOLCHAIN, timeoutMs: BUILD_TIMEOUT });
  if (!built.ok) throw new Error(`image build failed:\n${built.stderr.slice(-4000)}`);

  // NOT `mkdtemp(tmpdir())`. On macOS the daemon runs in a VM that shares only
  // declared directories and `os.tmpdir()` (`/var/folders/…`) is not one of
  // them: the mount comes up EMPTY with exit 0, `pi` reports "Extension path
  // does not exist", and the probe prints nothing at all.
  probeDir = await makeDaemonScratch("pifleet-tools-probe");
  await writeFile(join(probeDir, "tools-probe.ts"), PROBE_EXTENSION, { mode: 0o444 });
}, BUILD_TIMEOUT);

afterAll(async () => {
  if (probeDir) await rm(probeDir, { recursive: true, force: true });
});

/**
 * One `docker run --rm` of the real image, returning the tool names Pi's
 * registry held at `session_start`.
 *
 * `--network none` is not decoration: it makes "no test reaches the network" a
 * property of the container rather than a claim about the flags, and it is
 * measured to change nothing here — the honeypot listener is an AF_UNIX socket
 * and `--offline` was already keeping Pi off the wire.
 */
async function registryNames(opts: { withExtension: boolean }): Promise<string[]> {
  const piArgs = [
    ...(opts.withExtension ? ["-e", bakedPath] : []),
    "-e", "/probe/tools-probe.ts",
    // Discovery stays off; `-e` is unaffected by it. This is the flag pair a
    // real worker runs under (docker/Dockerfile:429), so the probe is not
    // observing a configuration no worker uses.
    "-ne",
    "--offline",
    // The image root is read-only; without this Pi cannot open a session at all.
    "--session-dir", "/tmp",
    "-p", "hi",
  ];
  const r = await realExec([
    "docker", "run", "--rm", "--read-only", "--network", "none",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "-v", `${probeDir}:/probe:ro`,
    tag,
    ...piArgs,
  ], { timeoutMs: containerBudget(1) });

  // `pi` exits non-zero here — it reaches the agent loop and finds no API key,
  // which is the whole point of the recipe — so the exit code is NOT the
  // signal. The marker is. Its absence means the probe never ran, and that
  // must fail loudly rather than read as "the registry was empty".
  const line = `${r.stdout}\n${r.stderr}`
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(`${MARKER} `));
  if (!line) {
    throw new Error(
      `probe extension never reported (exit ${r.code}); last stderr:\n${r.stderr.slice(-2000)}`,
    );
  }
  return JSON.parse(line.slice(MARKER.length + 1)) as string[];
}

describe("report-tools.ts in the real worker image (§12 D1)", () => {
  /**
   * The bytes serving `submit_report` in the image are the bytes the TAG is a
   * hash of — which is what makes every measurement below attributable to a
   * version of this repository rather than to whatever the daemon happens to
   * hold under that name.
   *
   * **This is the assertion the 2.3 revert reddens.** Dropping
   * `"pi-extensions/report-tools.ts"` from `BUILD_CONTEXT_ASSETS` does NOT
   * remove the `COPY`, so the extension keeps loading and the tools test below
   * stays green — the file would still be in the image, just no longer in the
   * tag. That is ISC-270's fail-open aimed at the one asset that suffers most
   * from it: a stale copy of THIS file does not fall silent like the other two
   * in-process extensions. It goes on emitting well-formed `pifleet.result/v1`
   * envelopes, checked against a rule set that has since moved, under an
   * unchanged tag. So the probe's own premise is what has to carry the check:
   * `assets[REPORT_TOOLS_ASSET]` becomes `undefined` and this goes red naming
   * the enrolment.
   *
   * Both digests are LF here (`assetDigestAt` folds CRLF; the checkout is LF,
   * so `docker build` sent the same bytes it hashed) and were measured equal at
   * `2ce8ea61aebe…` on 2026-09-08. Under a CRLF checkout they would genuinely
   * differ, and that difference is worth reporting rather than normalising
   * away: it is the tag describing bytes the image does not carry.
   */
  it("the baked extension is the file the image tag is a hash of", async () => {
    const enrolled = imageInputs(loaded.config, TOOLCHAIN).assets[REPORT_TOOLS_ASSET];
    expect(Object.keys(imageInputs(loaded.config, TOOLCHAIN).assets)).toContain(REPORT_TOOLS_ASSET);

    const r = await realExec(
      ["docker", "run", "--rm", "--read-only", "--network", "none",
        "--entrypoint", "/usr/bin/sha256sum", tag, bakedPath],
      { timeoutMs: containerBudget(1) },
    );
    expect(r.code).toBe(0);
    const inImage = r.stdout.trim().split(/\s+/)[0];

    expect(inImage).toBe(enrolled);
    // And the host file the tag hashed is the one this repository ships, so a
    // green run above cannot be satisfied by two matching stale copies.
    expect(enrolled).toBe(assetDigestAt(buildContextPath(REPORT_TOOLS_ASSET)));
  }, containerBudget(1));

  /**
   * §12 D1, the Phase 5 form: the registered set EQUALS `PI_EXTENSION_TOOLS`.
   *
   * Read as two claims that fail in opposite directions and that only an
   * equality makes together:
   *
   * - **No name reaches Pi's registry that config has no vocabulary to
   *   request.** Failure mode 9.2 — a tool the image serves under a name no
   *   `tools:` list can name is a tool no worker will ever be granted, and
   *   `--tools` reports nothing about it.
   * - **No name in the vocabulary is unserved by the image.** Failure mode 9.3 —
   *   `--tools` drops an unknown name silently (§0.2 row 7, measured), so a
   *   config that requests `get_replies` from an image that does not carry it
   *   produces a worker that is simply missing a tool, with no non-zero exit
   *   anywhere. This is the half the subset assertion could not reach and the
   *   reason this file was tightened.
   *
   * Neither is reachable from a unit test against a recording `pi`, which sees
   * this repository's source rather than the image.
   */
  it("registers exactly PI_EXTENSION_TOOLS", async () => {
    const baseline = await registryNames({ withExtension: false });
    const withExtension = await registryNames({ withExtension: true });

    // Anti-vacuity, and the reason the difference below means anything. A
    // baseline that already carried one of these names — a future built-in, a
    // third baked extension — would make the difference short by that name
    // while every other assertion here still read as satisfiable. Under an
    // equality that shows up as a failure rather than as a weakened test, but
    // it would name the wrong culprit, so it is checked directly.
    expect(baseline.length).toBeGreaterThan(0);
    for (const name of PI_EXTENSION_TOOLS) expect(baseline).not.toContain(name);
    // The extension ADDS; it must not displace a built-in on the way in.
    for (const name of baseline) expect(withExtension).toContain(name);

    const registered = new Set(withExtension.filter((n) => !baseline.includes(n)));

    expect(registered).toEqual(new Set<string>(PI_EXTENSION_TOOLS));
  }, containerBudget(2));
});
