/**
 * Worker image lifecycle: `image build | list | verify | gc` (SRD §5.7).
 *
 * Tags are `<prefix>:<pi-version>-<toolchain>-<config-hash>`. The hash covers
 * exactly the inputs that change the image (pi_version, toolchain,
 * apt_packages), so two configs that build the same bytes share a tag and a
 * config edit that matters forces a new one. `up` refuses to run against an
 * image that is absent or fails `verify` — a run must never silently use a
 * stale image (SRD §5.7).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FleetConfig, Toolchain } from "../config/schema.ts";
import { probeWriteThrough } from "./mounts.ts";
import { realExec, repoRoot, type Exec } from "./run.ts";

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

/** The image-shaping subset of config. Anything else changing must NOT retag. */
export interface ImageInputs {
  piVersion: string;
  toolchain: Toolchain;
  aptPackages: string[];
}

export function imageInputs(config: FleetConfig, toolchain: Toolchain): ImageInputs {
  return {
    piVersion: config.docker.pi_version,
    toolchain,
    aptPackages: [...config.docker.apt_packages].sort(),
  };
}

/** 12 hex chars of sha256 over the canonical inputs — stable across machines. */
export function configHash(inputs: ImageInputs): string {
  const canonical = JSON.stringify([inputs.piVersion, inputs.toolchain, inputs.aptPackages]);
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
  const inputs: ImageInputs = {
    piVersion,
    toolchain: opts.toolchain,
    aptPackages: [...config.docker.apt_packages].sort(),
  };
  const tag = opts.tag ?? `${config.docker.image_prefix}:${piVersion}-${opts.toolchain}-${configHash(inputs)}`;

  const argv = [
    "docker", "build",
    "-f", join(repoRoot(), "docker", "Dockerfile"),
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

  // Read-only root refuses a write outside the tmpfs.
  const ro = await exec([
    "docker", "run", ...RUN_HARDENED, "--entrypoint", "/bin/sh", tag,
    "-c", "touch /probe-should-fail 2>/dev/null",
  ]);
  checks.push({
    name: "read-only-root",
    ok: ro.code !== 0,
    detail: ro.code !== 0 ? "write to / refused" : "write to / SUCCEEDED — root is writable",
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
