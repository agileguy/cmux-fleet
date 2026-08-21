/**
 * Worker image lifecycle: `image build | list | verify | gc` (SRD §5.7).
 *
 * Tags are `<prefix>:<pi-version>-<toolchain>-<config-hash>`. The hash covers
 * exactly the inputs that change the image — pi_version, toolchain,
 * apt_packages, and the content of every file in `BUILD_CONTEXT_ASSETS` (the
 * Dockerfile plus everything it `COPY`s) — so two configs that build the same
 * bytes share a tag and any edit that matters forces a new one.
 *
 * WHAT `up` DOES WITH THIS, stated as narrowly as the code supports. `up` now
 * calls `assertImagesReady` (bottom of this file) immediately after
 * `assertModelsAllowed`, before the first clone and before any supervisor
 * exists, on the CONTAINER path only. That gate does two things per distinct
 * tag: `imagePresent` (one `docker image inspect`) and then `verifyImage`. A
 * failure of either is a refusal naming the ROLE.
 *
 * BE PRECISE ABOUT THE EVIDENCE BEHIND THAT SENTENCE, because this module's
 * header is where an overclaim has twice been mistaken for a control. The
 * ABSENT half is exercised end-to-end by the real CLI in
 * `test/integration/up-wiring.test.ts` against a `docker` PATH shim, in the
 * fast `test` CI job. The FAILS-VERIFY half is exercised by the same file
 * through the same shim — which proves the WIRING (that `up` calls verify, on
 * the tag it is about to launch, at the right point, and refuses with the right
 * exit code) and NOT that a real stale image is caught by a real daemon. No CI
 * job runs that: the `container` job's file list in `.github/workflows/ci.yml`
 * does not include `up-wiring.test.ts`. ISC-189 is graded `[~]` for exactly
 * that residual, and ISC-32 — the absent half alone — is the one with a
 * daemon-free reproducible reader.
 *
 * The gate is SKIPPED when `PIFLEET_PI_COMMAND` is set, and that is not a hole:
 * that variable is the documented statement "run the Pi double instead of
 * containers", `up` starts no container at all on that path, and there is
 * therefore no image for a gate to be about. See `up.ts` at the call site.
 *
 * WHAT IT WAS BEFORE, kept because the shape of the mistake is the point: this
 * docstring used to state ISC-189's sentence verbatim as a fact while `up.ts`
 * did not contain the string "image" at all, `verifyImage` had exactly one
 * caller in the tree (`cli/commands/image.ts`), and NONE of the three `docker
 * image inspect` calls in `src/` was on `up`'s path. An absent image was
 * discovered by the DAEMON, after `up` had created the run directory, cloned a
 * checkout per worker, registered a remote per worker in the operator's
 * repository, materialized every input and launched every supervisor —
 * surfacing as `worker <id> died during startup` (EXIT.WORKER_DIED) from the
 * idle gate at the END of `up`, not as a refusal. A comment is not a control.
 * If the gate below is ever deleted, delete these paragraphs with it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../contracts.ts";
import type { FleetConfig, Toolchain } from "../config/schema.ts";
import { probeWriteThrough } from "./mounts.ts";
import { realExec, repoRoot, type Exec } from "./run.ts";

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

/**
 * A build-context file that cannot be read.
 *
 * DIAGNOSED, and deliberately so. This used to throw a bare `Error`, which
 * `exitCodeForError` classifies as `EXIT.INTERNAL` — "a bug in pifleet, file
 * it, do not retry" (ISC-216). A missing or unreadable `docker/Dockerfile` is
 * the opposite of that: it is a broken checkout, the operator's to fix, and
 * pointing them at a pifleet bug report is the exact misclassification
 * `EXIT.INTERNAL` was added to prevent — aimed backwards.
 *
 * Modelled on `ConfigError` (config/load.ts): a `readonly exitCode` field is
 * all the structural `ExitCoded` protocol asks for, so no CLI import is needed.
 */
export class BuildContextError extends Error {
  /** A broken checkout is a usage failure, not a crash (SRD §10). */
  readonly exitCode = EXIT.USAGE;

  constructor(message: string) {
    super(message);
    this.name = "BuildContextError";
  }
}

/**
 * Every file under `docker/` that ends up INSIDE the image, in a fixed order.
 *
 * This is the enumeration the hash iterates and the list a future "does every
 * Dockerfile `COPY` source appear here" check would compare against — adding a
 * new build-context asset means adding one entry here and nothing else.
 *
 * The order is load-bearing: `configHash` walks this array rather than the
 * digest record's own keys, so the tag cannot move because someone reordered
 * an object literal.
 */
export const BUILD_CONTEXT_ASSETS = ["Dockerfile", "verbgate", "entrypoint.sh"] as const;
export type BuildContextAsset = (typeof BUILD_CONTEXT_ASSETS)[number];

/**
 * Resolve one build-context asset.
 *
 * Named once so the file that is HASHED and the file the build actually reads
 * cannot drift apart — a hash over a different Dockerfile than `-f` passes is
 * worse than no hash at all. `docker build` runs with `repoRoot()` as its
 * context, so these are the same bytes the daemon COPYs.
 */
export function buildContextPath(asset: BuildContextAsset): string {
  return join(repoRoot(), "docker", asset);
}

/** The one Dockerfile every worker image is built from — what `-f` receives. */
export function dockerfilePath(): string {
  return buildContextPath("Dockerfile");
}

/**
 * sha256 of one build-context file, CRLF-normalized.
 *
 * A digest rather than the text: the tag only needs to MOVE when the bytes
 * move, and carrying three whole files (verbgate alone is ~11KB) around in
 * every `ImageInputs` buys nothing.
 *
 * CRLF is folded to LF first because there is no `.gitattributes` in this repo,
 * so a checkout with `core.autocrlf=true` would otherwise hash different bytes
 * for the same content and rebuild an image that is already present.
 *
 * An unreadable file THROWS rather than degrading to a placeholder: a constant
 * stand-in would make every broken checkout hash alike, which is the silent tag
 * collision ISC-160 exists to prevent. Exported by path so the unreadable case
 * is testable without breaking the developer's own checkout.
 */
export function assetDigestAt(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BuildContextError(
      `cannot read ${path}, so no image tag can be computed: ${String(err)}`,
    );
  }
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/** The image-shaping subset of config. Anything else changing must NOT retag. */
export interface ImageInputs {
  piVersion: string;
  toolchain: Toolchain;
  aptPackages: string[];
  /**
   * sha256 per build-context file — their CONTENT, not their paths (ISC-160).
   *
   * The three fields above are the build ARGS; they are not the recipe. The
   * base image, the tini and gcloud installs, the uid 10001 user, the
   * entrypoint and the verbgate COPYs all live in the Dockerfile, and while
   * they were outside the hash an edit to any of them left the tag unchanged —
   * so a run found the stale image present under the expected tag and used it
   * with nothing reporting the reuse. (This clause once said "so `up`, which
   * only refuses an image that is ABSENT, found the stale one", at a time when
   * `up` refused NEITHER case. It now refuses both, through
   * `assertImagesReady`. The hash is still the mechanism that makes a changed
   * build context produce a DIFFERENT tag; the gate is what refuses a tag whose
   * bytes are wrong anyway. They are two controls, not one — ISC-270 tracks the
   * hash's own fail-open, where a new `COPY` source is added to the Dockerfile
   * without being added to `BUILD_CONTEXT_ASSETS`.)
   *
   * Hashing the Dockerfile alone closed only part of that. The Dockerfile
   * `COPY`s two files it does not contain: `docker/verbgate`, which IS the
   * cloud-mutation gate enforcing ISC-104/105/106/107, and
   * `docker/entrypoint.sh`, which renders `models.json`. Editing either left
   * the tag fixed, so a stale image with an OLD verb gate — the highest-
   * consequence staleness there is — was silently reusable.
   */
  assets: Record<BuildContextAsset, string>;
}

/** Digest every build-context asset, in enumeration order. */
export function buildContextDigests(): Record<BuildContextAsset, string> {
  const out = {} as Record<BuildContextAsset, string>;
  for (const asset of BUILD_CONTEXT_ASSETS) out[asset] = assetDigestAt(buildContextPath(asset));
  return out;
}

export function imageInputs(config: FleetConfig, toolchain: Toolchain): ImageInputs {
  return {
    piVersion: config.docker.pi_version,
    toolchain,
    aptPackages: [...config.docker.apt_packages].sort(),
    assets: buildContextDigests(),
  };
}

/** 12 hex chars of sha256 over the canonical inputs — stable across machines. */
export function configHash(inputs: ImageInputs): string {
  const canonical = JSON.stringify([
    inputs.piVersion,
    inputs.toolchain,
    inputs.aptPackages,
    // Walked in enumeration order, so key order in `assets` cannot move a tag.
    BUILD_CONTEXT_ASSETS.map((a) => [a, inputs.assets[a]]),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function imageTag(config: FleetConfig, toolchain: Toolchain): string {
  const inputs = imageInputs(config, toolchain);
  return `${config.docker.image_prefix}:${inputs.piVersion}-${toolchain}-${configHash(inputs)}`;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  toolchain: Toolchain;
  /** Overrides the config pin — used by tests to build a deliberate mismatch. */
  piVersion?: string;
  tag?: string;
  exec?: Exec;
  /** Image builds legitimately run for many minutes (google-cloud-cli alone is huge). */
  timeoutMs?: number;
}

export interface BuildResult {
  tag: string;
  ok: boolean;
  stderr: string;
}

export async function buildImage(config: FleetConfig, opts: BuildOptions): Promise<BuildResult> {
  const exec = opts.exec ?? realExec;
  const piVersion = opts.piVersion ?? config.docker.pi_version;
  // `--pi-version` overrides the pin (tests build a deliberate mismatch);
  // everything else, the Dockerfile content included, comes from the one
  // `imageInputs` reader, so the hash covers the same recipe `-f` passes below.
  const inputs: ImageInputs = { ...imageInputs(config, opts.toolchain), piVersion };
  const tag = opts.tag ?? `${config.docker.image_prefix}:${piVersion}-${opts.toolchain}-${configHash(inputs)}`;

  const argv = [
    "docker", "build",
    "-f", dockerfilePath(),
    "--build-arg", `PI_VERSION=${piVersion}`,
    "--build-arg", `TOOLCHAIN=${opts.toolchain}`,
    "--build-arg", `EXTRA_APT_PACKAGES=${inputs.aptPackages.join(" ")}`,
    // Labels are how `image list` reports build args without a sidecar file.
    "--label", `pifleet.pi-version=${piVersion}`,
    "--label", `pifleet.toolchain=${opts.toolchain}`,
    "--label", `pifleet.config-hash=${configHash(inputs)}`,
    "-t", tag,
    repoRoot(),
  ];
  const r = await exec(argv, { timeoutMs: opts.timeoutMs ?? 1_800_000 });
  return { tag, ok: r.code === 0, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ImageInfo {
  tag: string;
  id: string;
  created: string;
  size: string;
  labels: Record<string, string>;
}

export async function listImages(
  config: FleetConfig,
  exec: Exec = realExec,
): Promise<ImageInfo[]> {
  const r = await exec([
    "docker", "image", "ls",
    "--filter", `reference=${config.docker.image_prefix}`,
    "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}",
  ]);
  if (r.code !== 0) return [];
  const out: ImageInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [tag, id, created, size] = line.split("\t");
    if (!tag || !id) continue;
    const inspect = await exec(["docker", "image", "inspect", tag, "--format", "{{json .Config.Labels}}"]);
    let labels: Record<string, string> = {};
    if (inspect.code === 0) {
      try {
        labels = (JSON.parse(inspect.stdout.trim()) as Record<string, string> | null) ?? {};
      } catch {
        // Labels are informational; a parse failure must not hide the image.
      }
    }
    out.push({ tag, id, created: created ?? "", size: size ?? "", labels });
  }
  return out;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  tag: string;
  ok: boolean;
  checks: VerifyCheck[];
}

/** Flags shared by every verification `docker run` — mirrors the §5.6 posture. */
const RUN_HARDENED = ["--rm", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"];

/**
 * `image verify` (SRD §5.7): asserts the image's Pi version matches the pin
 * (ISC-23/24), uid 10001 (ISC-25), that a read-only root actually refuses
 * writes (ISC-26), tini as the entrypoint's PID 1 (ISC-38), and `/workspace`
 * write-through in both directions (ISC-27/28).
 */
export async function verifyImage(
  tag: string,
  expectedPiVersion: string,
  exec: Exec = realExec,
): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];

  // Pi version through the real entrypoint chain (tini → entrypoint → pi).
  const ver = await exec(["docker", "run", ...RUN_HARDENED, tag, "--version"], {
    timeoutMs: 120_000,
  });
  const got = ver.stdout.trim() || ver.stderr.trim();
  checks.push({
    name: "pi-version",
    ok: ver.code === 0 && got.includes(expectedPiVersion),
    detail: ver.code === 0 ? `pi --version → "${got}" (want ${expectedPiVersion})` : `exit ${ver.code}: ${ver.stderr.trim()}`,
  });

  // uid 10001 — deterministic bind-mount ownership on Colima/virtiofs (§5.2).
  const uid = await exec(["docker", "run", ...RUN_HARDENED, "--entrypoint", "/usr/bin/id", tag, "-u"]);
  checks.push({
    name: "uid-10001",
    ok: uid.code === 0 && uid.stdout.trim() === "10001",
    detail: `id -u → "${uid.stdout.trim()}"`,
  });

  // Read-only root refuses a write outside the tmpfs — while the tmpfs itself
  // still accepts one. Testing only "the write failed" accepted any failure at
  // all: a nonexistent image exits 125 and an image with no shell exits 127,
  // both of which read as "root is read-only". The positive half is what makes
  // the negative half mean something.
  const ro = await exec([
    "docker", "run", ...RUN_HARDENED, "--entrypoint", "/bin/sh", tag,
    "-c", "touch /tmp/probe-should-work && echo TMPFS_OK; touch /probe-should-fail 2>/dev/null && echo ROOT_WRITABLE; true",
  ]);
  const tmpfsOk = ro.stdout.includes("TMPFS_OK");
  const rootWritable = ro.stdout.includes("ROOT_WRITABLE");
  checks.push({
    name: "read-only-root",
    ok: ro.code === 0 && tmpfsOk && !rootWritable,
    detail: !tmpfsOk
      ? `container did not run (exit ${ro.code}): ${ro.stderr.trim() || "no output"}`
      : rootWritable
        ? "write to / SUCCEEDED — root is writable"
        : "write to / refused, tmpfs writable",
  });

  // tini is the entrypoint (PID 1). Static, because with the default entrypoint
  // running there is no honest way to observe /proc/1 from outside the process.
  const ep = await exec(["docker", "image", "inspect", tag, "--format", "{{json .Config.Entrypoint}}"]);
  let entrypoint: string[] = [];
  try {
    entrypoint = ep.code === 0 ? ((JSON.parse(ep.stdout.trim()) as string[] | null) ?? []) : [];
  } catch {
    // Fall through to the failing check below with an empty entrypoint.
  }
  checks.push({
    name: "tini-pid1",
    ok: entrypoint[0] === "/usr/bin/tini",
    detail: `entrypoint = ${JSON.stringify(entrypoint)}`,
  });

  // /workspace write-through, both directions (ISC-27/28). The scratch dir comes
  // from container/mounts.ts, not os.tmpdir(): on macOS the daemon cannot see
  // os.tmpdir() and mounts an empty directory in its place, which failed this
  // check on every Colima install while the image itself was fine.
  const wt = await probeWriteThrough(tag, exec);
  checks.push({ name: "workspace-write-through", ok: wt.visible, detail: wt.detail });

  return { tag, ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

export interface GcResult {
  kept: string[];
  removed: string[];
}

/** Prune old tags, newest-first by Docker's CreatedAt ordering (SRD §5.3 sizing note). */
export async function gcImages(
  config: FleetConfig,
  keep: number,
  exec: Exec = realExec,
): Promise<GcResult> {
  const images = await listImages(config, exec);
  // `docker image ls` returns newest first; rely on that rather than parsing
  // Docker's locale-formatted CreatedAt strings.
  const kept = images.slice(0, keep).map((i) => i.tag);
  const removed: string[] = [];
  for (const img of images.slice(keep)) {
    const r = await exec(["docker", "rmi", img.tag]);
    if (r.code === 0) removed.push(img.tag);
  }
  return { kept, removed };
}

// ---------------------------------------------------------------------------
// The launch gate (ISC-32, ISC-189)
// ---------------------------------------------------------------------------

/**
 * Is this exact tag in the local daemon's image store?
 *
 * `--format {{.Id}}` rather than a bare inspect so a present image produces a
 * short, loggable datum instead of a JSON document, and so "exit 0 with empty
 * stdout" cannot pass for a real answer.
 *
 * Deliberately does NOT distinguish "image absent" from "daemon unreachable"
 * or "docker not installed" in its RETURN — all three mean the same thing to
 * the caller (this run cannot have that container) and all three are the same
 * exit code. The distinction survives in `detail`, which the refusal quotes, so
 * an operator reading the message can still tell a missing build from a stopped
 * Docker Desktop.
 */
export async function imagePresent(
  tag: string,
  exec: Exec = realExec,
): Promise<{ present: boolean; detail: string }> {
  const r = await exec(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], {
    timeoutMs: 30_000,
  });
  const id = r.stdout.trim();
  if (r.code === 0 && id.length > 0) return { present: true, detail: id };
  const said = r.stderr.trim() || r.stdout.trim();
  return {
    present: false,
    detail: r.timedOut
      ? "docker image inspect timed out after 30s"
      : said.length > 0
        ? said
        : `docker image inspect exited ${String(r.code)} with no output`,
  };
}

/** One worker's demand on the image store, as the renderer computed it. */
export interface ImageRequirement {
  workerId: string;
  role: string;
  toolchain: Toolchain;
  /** The tag `renderWorker` put in this worker's `docker run` argv. */
  image: string;
}

/** The distinct tags a launch set needs, and who needs each. */
export interface RequiredImage {
  tag: string;
  toolchain: Toolchain;
  /** Every role landing on this tag, first-seen order. Named in the refusal. */
  roles: string[];
  /** Every worker landing on this tag, first-seen order. */
  workers: string[];
}

/**
 * Collapse per-worker demands onto the distinct tags behind them.
 *
 * Sixteen workers on one role are one image, and checking it sixteen times
 * would cost sixteen `docker image inspect` calls and — far worse — sixteen
 * full `verifyImage` runs, each of which starts several containers. The
 * criterion is about the image, not about the worker count.
 *
 * The requirement carries `image` rather than recomputing `imageTag` from the
 * config, and that is the whole design. A gate that checks a tag the launch
 * does not use is worse than no gate: it certifies the wrong bytes. The value
 * here comes from `renderWorker`, which is the same function that writes the
 * tag into the `docker run` argv, so the two cannot drift.
 */
export function requiredImages(entries: readonly ImageRequirement[]): RequiredImage[] {
  const byTag = new Map<string, RequiredImage>();
  for (const e of entries) {
    let rec = byTag.get(e.image);
    if (rec === undefined) {
      rec = { tag: e.image, toolchain: e.toolchain, roles: [], workers: [] };
      byTag.set(e.image, rec);
    }
    if (!rec.roles.includes(e.role)) rec.roles.push(e.role);
    if (!rec.workers.includes(e.workerId)) rec.workers.push(e.workerId);
  }
  return [...byTag.values()];
}

/**
 * A launch refused because a role's image is absent, or present and wrong.
 *
 * `EXIT.BACKEND_UNAVAILABLE`, matching the egress-network and hazard-scan
 * refusals in `up` and matching `image verify`'s own failure code — nothing is
 * wrong with the command line, the HOST is not in a state this run can use.
 * `EXIT.USAGE` would tell a machine caller to rewrite its arguments, which is
 * the misclassification `EXIT.INTERNAL` was added to stop (ISC-216), aimed the
 * other way.
 *
 * `readonly exitCode` is all the structural `ExitCoded` protocol wants, so this
 * needs no CLI import — same shape as `BuildContextError` above.
 */
export class ImageGateError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    message: string,
    readonly tag: string,
    readonly roles: readonly string[],
    readonly reason: "absent" | "unverified",
  ) {
    super(message);
    this.name = "ImageGateError";
  }
}

export interface ImageGateOptions {
  exec?: Exec;
  /** Injectable so a test can hold presence fixed and move only the verdict. */
  verify?: (tag: string, expectedPiVersion: string, exec: Exec) => Promise<VerifyResult>;
  /** Called once per tag that PASSED, for the ledger / stderr. */
  onReady?: (image: RequiredImage & { id: string }) => void | Promise<void>;
}

/**
 * Refuse the launch unless every required image is present AND verifies
 * (ISC-32, ISC-189).
 *
 * ## Why both halves are one function
 *
 * They are one sentence in the SRD and they fail for one reason — the operator
 * is about to run agents against bytes that are not what the config describes.
 * Splitting them would let a caller wire the cheap half and skip the expensive
 * one, which is precisely the state ISC-189 was filed over: the presence
 * primitive existed (in `doctor.ts`) and the verify primitive existed (here),
 * and neither was on the launch path.
 *
 * ## Why presence is checked first and separately
 *
 * `verifyImage` on an absent tag does not report an absent tag. It reports six
 * failed checks whose details are Docker's "Unable to find image" repeated six
 * times, and its read-only-root check documents in as many words that a
 * nonexistent image exits 125 and reads as "root is read-only". The cheap
 * inspect is what turns that into one accurate sentence, and it costs one
 * subprocess.
 *
 * ## The cost, stated rather than hidden
 *
 * `verifyImage` starts several containers per tag. This runs once per DISTINCT
 * tag, so a sixteen-worker single-role fleet pays it once — but a four-toolchain
 * fleet pays it four times, and on a cold daemon that is not free. It is paid
 * before the first clone, which is the only placement where paying it is cheap
 * relative to being wrong: after the clones, a refusal has state on disk to
 * reap; after the supervisors, it is not a refusal at all.
 *
 * There is deliberately NO flag to skip it. A control with an opt-out is a
 * control that is off in the shell profile of the one operator who most needed
 * it.
 *
 * ## Sequential, not `Promise.all`
 *
 * The first failure must be the one reported. Running the tags concurrently
 * would make WHICH role gets named a race, and this refusal's entire job is to
 * name a role.
 */
export async function assertImagesReady(
  required: readonly RequiredImage[],
  expectedPiVersion: string,
  opts: ImageGateOptions = {},
): Promise<void> {
  const exec = opts.exec ?? realExec;
  const verify = opts.verify ?? verifyImage;

  for (const req of required) {
    const roles = req.roles.map((r) => `'${r}'`).join(", ");
    const who =
      `role${req.roles.length > 1 ? "s" : ""} ${roles} ` +
      `(worker${req.workers.length > 1 ? "s" : ""} ${req.workers.join(", ")})`;
    const rebuild = `pifleet image build --toolchain ${req.toolchain}`;

    const presence = await imagePresent(req.tag, exec);
    if (!presence.present) {
      throw new ImageGateError(
        `refusing to start: ${who} needs image ${req.tag}, which is NOT present on this host ` +
          `— ${presence.detail}. Nothing has been cloned and no supervisor has been launched. ` +
          `Build it with: ${rebuild}`,
        req.tag,
        req.roles,
        "absent",
      );
    }

    const result = await verify(req.tag, expectedPiVersion, exec);
    if (!result.ok) {
      const failed = result.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name} (${c.detail})`)
        .join("; ");
      throw new ImageGateError(
        `refusing to start: ${who} needs image ${req.tag}, which IS present but FAILS ` +
          `verification — ${failed}. A tag that exists is not the same as an image that is ` +
          `what the config describes. Nothing has been cloned and no supervisor has been ` +
          `launched. Rebuild it with: ${rebuild}`,
        req.tag,
        req.roles,
        "unverified",
      );
    }

    await opts.onReady?.({ ...req, id: presence.detail });
  }
}
