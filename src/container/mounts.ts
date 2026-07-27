/**
 * Host paths that have to survive a bind mount.
 *
 * On macOS the Docker daemon runs inside a VM (Colima, Docker Desktop) and only
 * a declared set of host directories is shared into it. `-v` against a path
 * outside that set does NOT fail: the daemon creates an empty directory in the
 * VM and mounts that instead. The container then reads an empty `/workspace`,
 * writes an outbox nobody harvests, and exits 0. Every symptom points at the
 * agent; the cause is the mount.
 *
 * Measured on this machine (Colima 0.9, default profile):
 *
 *   /var/folders/.../T  (os.tmpdir())  → not shared, silently empty
 *   /tmp                               → not shared, silently empty
 *   $HOME/...                          → shared
 *
 * So: anything pifleet intends to bind-mount lives under `$HOME`, and the
 * assumption is probed rather than trusted. Docker Desktop shares `/Users` by
 * default, which contains `$HOME`, so the same rule holds there.
 *
 * ---
 *
 * The second way a bind mount silently does not work is OWNERSHIP, and it hides
 * on macOS for the same reason the first one hides on Linux.
 *
 * The worker image runs as uid 10001 (`docker/Dockerfile`). A Linux bind mount
 * passes host ownership through untouched, so a directory the host created —
 * `mkdtemp` gives 0700, `mkdir` gives 0755 — is unwritable, and at 0700 not
 * even traversable, to that uid. The macOS VM's shared filesystem squashes
 * ownership to the container user instead, so all of these paths work here and
 * none of them work there. Seven container probes failed at once on the first
 * Linux runner: `/workspace` unwritable, `/skills` unreadable, and the verbgate
 * ledger never created — an ENOENT on the append, which reads as "the gate made
 * no decisions" rather than as a mount fault.
 *
 * Matching uids is not available: the image bakes in uid 10001 with a home
 * directory to match, and the host uid is whatever the operator happens to be.
 * So the host side opens the permission bits instead — scoped to the run
 * directory and the scratch root, both under `$HOME` and containing only
 * material pifleet itself put there.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { realExec, type Exec } from "./run.ts";

/**
 * Root for scratch directories that get bind-mounted into a container.
 *
 * Deliberately NOT `os.tmpdir()`. Override with `PIFLEET_SCRATCH_DIR` when the
 * daemon's shared set is configured differently — the value must be a path the
 * daemon can see, and `probeMountVisibility` is how you find out whether it is.
 */
export function daemonScratchRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return env["PIFLEET_SCRATCH_DIR"] ?? join(homedir(), ".pifleet", "scratch");
}

/** The uid the worker image runs as. Must track `USER` in `docker/Dockerfile`. */
export const WORKER_UID = 10001;

/**
 * Open a host directory's permissions so the worker uid can use it.
 *
 * `writable: true` for a mount the worker writes (its outbox, its workspace);
 * `false` for one it only reads (`:ro` skills, policy), which still needs the
 * execute bit to traverse.
 *
 * This is a deliberate widening of host-side permissions, which is why callers
 * must only point it at directories pifleet created under the run root — never
 * at a user's repository or home directory.
 */
export async function makeWorkerAccessible(dir: string, writable: boolean): Promise<void> {
  await chmod(dir, writable ? 0o777 : 0o755);
}

/**
 * Create a fresh scratch directory under the daemon-visible root.
 *
 * `mkdtemp` deliberately creates 0700 — correct for a private temp directory,
 * fatal for one about to be handed to another uid, so the mode is reopened
 * immediately rather than left to each caller to remember.
 */
export async function makeDaemonScratch(
  prefix: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const root = daemonScratchRoot(env);
  await mkdir(root, { recursive: true });
  // A root left at 0700 by an earlier run makes every 0777 child unreachable:
  // traversal is checked at every path component, not just the leaf.
  await chmod(root, 0o755).catch(() => {});
  const dir = await mkdtemp(join(root, `${prefix}-`));
  await makeWorkerAccessible(dir, true);
  return dir;
}

/** What to tell a user whose bind mount came up empty. */
export const MOUNT_SHARING_HINT =
  "the Docker daemon cannot see this path — on macOS only directories shared into the " +
  "VM are mountable (Colima shares $HOME by default; /tmp and os.tmpdir() are NOT shared). " +
  "Move the directory under $HOME, or add it to the VM's mounts and set PIFLEET_SCRATCH_DIR.";

export interface MountVisibility {
  /** True only when a byte written on the host was read back inside the container. */
  visible: boolean;
  detail: string;
}

/**
 * Bind-mount `dir` and check that host-written content is actually there.
 *
 * Presence of the mount proves nothing — an unshared path mounts successfully
 * as an empty directory. Only reading back a host-written sentinel distinguishes
 * "shared" from "silently empty", so that is what this does.
 */
export async function probeMountVisibility(
  dir: string,
  tag: string,
  exec: Exec = realExec,
): Promise<MountVisibility> {
  const sentinel = ".pifleet-mount-probe";
  const token = "pifleet-mount-ok";
  try {
    await writeFile(join(dir, sentinel), `${token}\n`);
  } catch (err) {
    return { visible: false, detail: `cannot write to ${dir}: ${(err as Error).message}` };
  }
  try {
    const r = await exec([
      "docker", "run", "--rm", "--read-only",
      "-v", `${dir}:/probe:ro`,
      "--entrypoint", "/bin/sh", tag,
      "-c", `cat /probe/${sentinel} 2>&1`,
    ]);
    if (r.code === 0 && r.stdout.includes(token)) {
      return { visible: true, detail: `${dir} is visible inside the container` };
    }
    return {
      visible: false,
      detail: `${dir} mounted but the host sentinel was not readable inside the container — ${MOUNT_SHARING_HINT}`,
    };
  } finally {
    await rm(join(dir, sentinel), { force: true });
  }
}

/**
 * Round-trip check used by `image verify`: host → container AND container →
 * host, through a read-write mount.
 */
export async function probeWriteThrough(
  tag: string,
  exec: Exec = realExec,
  env: Record<string, string | undefined> = process.env,
): Promise<MountVisibility> {
  let host: string;
  try {
    host = await makeDaemonScratch("verify", env);
  } catch (err) {
    return {
      visible: false,
      detail: `cannot create a scratch directory under ${daemonScratchRoot(env)}: ${(err as Error).message}`,
    };
  }
  try {
    await writeFile(join(host, "from-host"), "host-wrote-this\n");
    const r = await exec([
      "docker", "run", "--rm", "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "-v", `${host}:/workspace`,
      "--entrypoint", "/bin/sh", tag,
      "-c", "cat /workspace/from-host && echo container-wrote-this > /workspace/from-container",
    ]);
    let roundTrip = false;
    try {
      roundTrip = (await readFile(join(host, "from-container"), "utf8")).includes(
        "container-wrote-this",
      );
    } catch {
      roundTrip = false;
    }
    if (r.code === 0 && r.stdout.includes("host-wrote-this") && roundTrip) {
      return { visible: true, detail: "both directions visible" };
    }
    // An unshared mount fails on the read, not on the mount, so the error text
    // is a missing file. Say what that actually means.
    const cause =
      r.code !== 0
        ? `exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`
        : "container write was not visible on the host";
    return { visible: false, detail: `${cause} — ${MOUNT_SHARING_HINT}` };
  } finally {
    await rm(host, { recursive: true, force: true });
  }
}
