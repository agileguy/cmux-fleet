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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** `HOME` inside the worker image. Must track `ENV HOME` in `docker/Dockerfile`. */
export const WORKER_HOME = "/home/pi";

/**
 * The one writable place a worker may clone OTHER repositories into.
 *
 * `~/repos` inside the container, chosen because it is where an agent already
 * reaches. Measured 2026-09-04: `tst-1`, asked to run the tests of a project
 * at `~/repos/rally-cli`, ran
 *
 *   git clone https://github.com/…/rally-cli.git ~/repos/rally-cli
 *   fatal: could not create leading directories of
 *   '/home/pi/repos/rally-cli': Read-only file system
 *
 * — the right instinct into a read-only root. Putting the scratch where the
 * agent already tried means the capability needs no prompt engineering to be
 * discovered, and it mirrors the operator's own host layout.
 *
 * NOT under `/workspace`. That is the run's git worktree, and harvest derives
 * its authoritative facts from that tree's branch and diff (SRD §7.3); an
 * unrelated clone inside it would show up as the worker's own changes, which
 * is the difference between "cloned a dependency" and "committed a vendored
 * copy of somebody else's repository".
 *
 * SAME FOR EVERY ROLE, by construction rather than by convention — it is a
 * `docker:` setting, not a role field, so a tester, an engineer and a reviewer
 * cannot drift apart on where a checkout lives or on whether they have one.
 */
export const WORKER_SCRATCH_DIR = `${WORKER_HOME}/repos`;

/**
 * Where a host git working directory is exposed, read-only, to be cloned FROM.
 *
 * Separate from {@link WORKER_SCRATCH_DIR} on purpose, and the separation is
 * the design rather than tidiness: `/repos-src/<name>` is the operator's real
 * repository and must never be written, `~/repos/<name>` is the worker's own
 * clone and is meant to be dirtied. One path that was both would make "read
 * the project" and "build the project" the same permission.
 */
export const WORKER_CLONE_SRC_ROOT = "/repos-src";

/**
 * Container path a host working directory at `hostPath` is mounted at.
 *
 * The BASENAME only — the host's absolute path is not reproduced inside the
 * container. `/Users/someone/repos/rally-cli` becoming
 * `/repos-src/rally-cli` keeps the operator's directory layout, and their
 * username, out of a container an agent can read.
 */
export function cloneSourceMount(hostPath: string): string {
  const base = hostPath.replace(/\/+$/, "").split("/").pop() ?? "";
  if (base === "" || base === "." || base === "..") {
    throw new Error(`pifleet: cannot expose ${hostPath} — it has no usable directory name`);
  }
  return `${WORKER_CLONE_SRC_ROOT}/${base}`;
}

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
 * Open a host FILE's permissions for a read-only mount.
 *
 * The directory analogue is `makeWorkerAccessible(dir, false)`; a file needs no
 * execute bit to be read, so this is 0644 rather than 0755. Same Linux
 * ownership reasoning as the header: the briefing, the verbgate policy and the
 * kubeconfig are written by the operator's uid and read by uid 10001, so a file
 * left at the 0600 an umask-tightened host produces is unreadable there while
 * working perfectly under the macOS VM's ownership squash.
 *
 * The execute bit is withheld deliberately rather than incidentally. Every file
 * this is pointed at is CONTENT a worker reads — policy lines, prompt text, a
 * kubeconfig — and none of them is a program; a mode that would let the
 * container execute one is a wider grant than the mount needs.
 *
 * `hostRewritable: false` drops the owner write bit as well, giving 0444, and
 * the verbgate policy is why the distinction exists. `docker/verbgate` refuses
 * EVERY verb (exit 78) when its allow file is writable by the uid consulting
 * it — and the macOS VM squashes ownership to the container user, so a 0644
 * policy reads as owner-writable INSIDE the container with only the `:ro`
 * mount flag standing between that check and a fleet-wide refusal. Files a
 * later phase must rewrite in place (the briefing, the kubeconfig) pass
 * `true`; a policy file passes `false`, because nothing should hold write
 * permission on it by any path.
 */
export async function makeWorkerReadable(file: string, hostRewritable: boolean): Promise<void> {
  await chmod(file, hostRewritable ? 0o644 : 0o444);
}

/** Outcome of a recursive widen; a datum rather than a throw, so each caller frames it. */
export interface TreeWidenResult {
  ok: boolean;
  code: number;
  stderr: string;
}

/**
 * Open an ENTIRE host tree so the worker uid can read, traverse and WRITE it.
 *
 * `makeWorkerAccessible` above opens one directory, which is enough to create,
 * `sed -i` and rm+recreate inside it — and NOT enough to open an existing file
 * for writing. That distinction was measured (ISC-298, inside a Linux
 * container, so the macOS ownership squash was not in the path): a 0777
 * directory holding 0644 files owned by another uid takes an `open(O_WRONLY)`
 * and returns `EACCES`, which is precisely what an agent's write/edit tool
 * does and the first thing it reaches for. A directory-only widen therefore
 * yields a tree where SOME edits land and others do not depending on which
 * tool the model picked — worse than an honest total failure.
 *
 * `a+rwX` and not `a+rwx`: the capital X sets the execute bit on directories
 * and on files that already have one, so a widen does not turn every source
 * file into a program.
 *
 * ONE implementation, here, rather than a `chmod -R` spawn per caller. Both
 * callers — the worker's own clone and the acceptance exam's clone — widen for
 * the identical reason (a baked uid meets a host-created tree), and two copies
 * of one magic argv are two things that drift.
 *
 * Callers MUST only point this at a tree pifleet created. It is a deliberate
 * widening of host permissions and has no business inside an operator's
 * repository or home directory.
 */
export async function widenTreeForWorker(dir: string): Promise<TreeWidenResult> {
  const p = Bun.spawn(["chmod", "-R", "a+rwX", dir], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { ok: code === 0, code, stderr };
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

/**
 * The name every mount probe writes, in ONE spelling.
 *
 * `mount-preflight.ts` writes the same file for the same purpose, and two
 * literals of one magic name are two things that can drift — the second would
 * then be left behind by the first's cleanup.
 */
export const MOUNT_PROBE_SENTINEL = ".pifleet-mount-probe";

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
  const sentinel = MOUNT_PROBE_SENTINEL;
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

/**
 * Should `dir` be exposed to workers as a clone source?
 *
 * `null` — expose nothing — in three cases, each for its own reason:
 *
 *  - `dir` is not a git working directory. The point is to clone a repository,
 *    and mounting an arbitrary directory an operator happened to be standing
 *    in would put unrelated files in front of an agent with no one having
 *    decided to.
 *  - `dir` IS `run.repo`. That repository already reaches the worker as its
 *    `/workspace` worktree; a second mount under another name would give one
 *    repository two identities in the container, one harvested and one not.
 *  - `dir` is inside `run.repo`. Same repository, subdirectory spelling.
 *
 * A worktree or submodule has `.git` as a FILE rather than a directory, so the
 * check is for existence and not for a directory — a linked worktree is a
 * working directory and refusing it would be arbitrary.
 */
export async function resolveCloneSource(
  loaded: { config: { run: { repo: string } }; dir: string },
  cwd: string,
): Promise<string | null> {
  const { expandPath } = await import("../config/load.ts");
  const here = resolve(cwd);
  const repo = resolve(expandPath(loaded.config.run.repo, loaded.dir));
  if (here === repo || here.startsWith(`${repo}/`)) return null;
  if (!existsSync(join(here, ".git"))) return null;
  return here;
}
