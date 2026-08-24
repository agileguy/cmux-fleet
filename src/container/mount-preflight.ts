/**
 * The launch-path guard: every bind-mount source this run will use is one the
 * container runtime can actually see (ISC-292).
 *
 * ## The failure
 *
 * On a VM-backed runtime — Docker Desktop, colima, Rancher — only a declared
 * set of host directories is shared into the VM. `-v <src>:<dst>` against a
 * path outside that set DOES NOT FAIL. The VM has no such path, so the runtime
 * CREATES an empty directory there and mounts that. The container sees an empty
 * directory where the host has content, and `docker run` exits 0.
 *
 * Reproduced on this machine (colima 0.9.x, macOS Virtualization.Framework,
 * virtiofs, arm64) while writing this module:
 *
 *   -v /private/tmp/x/probe.mjs:/probe.mjs   node: Cannot find module '/probe.mjs'
 *   -v /private/tmp/x:/probe:ro              /probe/probe.mjs is a DIRECTORY
 *   -v $HOME/y:/probe:ro                     /probe/probe.mjs is a 29-byte file
 *
 * `docker run` exited **0** in all three. That silent 0 is the whole defect:
 * the host file was a perfectly good regular file in every case.
 *
 * ## Why it is enforced HERE and not only in `doctor`
 *
 * `doctor` has probed the two operator-settable ROOTS since Phase F, and that
 * is a report an operator has to remember to ask for. The criterion says a bad
 * mount is "refused or reported"; a fleet that launches anyway has only the
 * second half, and the launch is where the cost lands. This is the same
 * altitude ISC-44 and ISC-127 are enforced at and for the same stated reason:
 * the offending path is not a literal any reviewer can audit in the mount
 * table, it arrives from `run.repo`, `PIFLEET_RUNS_DIR` and `PIFLEET_SCRATCH_DIR`,
 * so the FINISHED argv is the only place the value is knowable.
 *
 * It also covers strictly more than `doctor` does. `doctor` knows about the two
 * roots it can name; the finished argv carries `run.repo` and the kubeconfig
 * too, which were the residuals the ISC-292 entry recorded as unchecked.
 *
 * ## The witness, and why it is a REGULAR FILE OF A KNOWN SIZE
 *
 * Presence of the mount proves nothing and neither does an entry COUNT. That
 * is measured rather than assumed: after `-v <unshared>/probe.mjs:/probe.mjs`
 * the VM retains an empty DIRECTORY named `probe.mjs` inside its own copy of
 * the unshared path, so a later directory mount of that path reports one entry
 * bearing exactly the right name. A count-based check reads that as shared.
 *
 * The runtime creates DIRECTORIES for missing mount sources and never files, so
 * "a regular file of exactly N bytes" is a witness the silently-empty case
 * cannot fake. The host picks one, the container is asked about that one, and
 * the two answers must agree.
 *
 * ## Nothing is written into a path pifleet does not own
 *
 * The witness is borrowed from content that is ALREADY there wherever there is
 * any, which is what lets this run over `run.repo` — the operator's own git
 * checkout. A sentinel is written only into a directory that is EMPTY, where
 * there is nothing to borrow and nothing to disturb, and it is removed again in
 * a `finally`.
 *
 * The empty case is not skippable, which is why it is worth the write. `/outbox`
 * is created empty by `materialize` and mounted READ-WRITE: an unshared one
 * takes every artifact the worker produces and the host collects nothing —
 * the "wrote its outbox nowhere the host would read" half of the incident this
 * criterion was filed for.
 *
 * ## What it does NOT check, said out loud
 *
 * Only host -> container. Sharing is a property of the mount and is
 * bidirectional on every runtime here — an unshared path is a VM-local
 * directory with no connection in either direction — so this is a sound proxy
 * for the container -> host direction that `/outbox` actually depends on, not a
 * measurement of it. `probeWriteThrough` measures both, and `image verify` is
 * where that cost belongs.
 *
 * A source ABSENT from the host is not probed at all, deliberately: `docker run
 * -v <missing>:<dst>` CREATES the source, so probing one would make this
 * diagnostic the thing that materialized the directory it was asked about. A
 * missing source is ISC-188's criterion and is loud there.
 */

import { lstat, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT } from "../contracts.ts";
import { bindMountSources } from "./docker-argv.ts";
import { MOUNT_PROBE_SENTINEL, MOUNT_SHARING_HINT } from "./mounts.ts";
import { realExec, type Exec } from "./run.ts";

export { MOUNT_PROBE_SENTINEL };

/** What the sentinel holds when one has to be written. Its SIZE is the witness. */
const SENTINEL_BODY = "pifleet-mount-ok\n";

/** How long the single probe container gets. Generous: it cold-starts a VM path on macOS. */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * How many entries of a directory are stat'd looking for a witness file.
 *
 * Bounded because `run.repo` can be a checkout with tens of thousands of
 * top-level-reachable entries and this runs on the interactive path. A
 * directory whose first 64 entries are all directories or empty files falls
 * back to the sentinel, which is correct rather than merely cheap.
 */
const WITNESS_SCAN_LIMIT = 64;

/**
 * Entry names safe to interpolate into the probe script.
 *
 * The alternative to a whitelist is quoting, and quoting is the thing that
 * goes wrong quietly. A name outside this set is simply not used as a witness
 * — the sentinel is written instead — so no shell metacharacter, newline or
 * leading dash from a user's repository ever reaches the script.
 */
const SHELL_SAFE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export interface MountSourceVerdict {
  /** The absolute host path, as the finished argv would mount it. */
  source: string;
  /** True only when the container's answer AGREED with the host's measurement. */
  visible: boolean;
  detail: string;
}

/** A host-side measurement waiting for the container to be asked about it. */
interface Witness {
  source: string;
  /** Path relative to the mount target; "" when the source IS the witness file. */
  rel: string;
  /** The host's byte count for the witness file. */
  size: number;
  /** True when this module created the witness and must remove it. */
  wrote: boolean;
}

/**
 * A diagnosed refusal, not a stack trace.
 *
 * `EXIT.BACKEND_UNAVAILABLE` rather than `USAGE`, and the choice is about
 * agreeing with ourselves: `doctor` classifies exactly this condition as
 * `misconfigured` and therefore exits 3. Two commands reporting one condition
 * under two codes is precisely the confusion ISC-216 records, over the only
 * channel a machine caller has. It is also true on its own terms — nothing is
 * wrong with the operator's ARGUMENTS; what is wrong is which paths their
 * container runtime has been given permission to see.
 */
export class MountNotVisibleError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(readonly verdicts: readonly MountSourceVerdict[]) {
    const lines = verdicts.map((v) => `  ${v.source} — ${v.detail}`).join("\n");
    super(
      `refusing to launch: ${verdicts.length} bind-mount source(s) are not visible inside a ` +
        `container, so mounting them would present an EMPTY directory to the worker while the ` +
        `host content stayed untouched — a fleet that runs, finds nothing, and says nothing:\n` +
        `${lines}\n` +
        `${MOUNT_SHARING_HINT} — SRD §5.5 / ISC-292`,
    );
    this.name = "MountNotVisibleError";
  }
}

/**
 * Measure every source in ONE container, and report rather than throw.
 *
 * One container for the whole fleet because sharing is a property of the
 * DAEMON, not of the call: six mounts across six workers is thirty-six
 * container starts if each is probed alone, on a command an operator runs
 * interactively.
 *
 * Sources that cannot be probed — a named volume, a path absent from the host —
 * yield no verdict at all rather than a `visible: true` one. A pass is a thing
 * this module MEASURED, and a "not applicable" that looks like a pass is the
 * shape of bug this criterion exists to close.
 */
export async function probeBindMountSources(
  sources: readonly string[],
  tag: string,
  exec: Exec = realExec,
): Promise<MountSourceVerdict[]> {
  const verdicts: MountSourceVerdict[] = [];
  const witnesses: Witness[] = [];

  for (const source of unique(sources)) {
    if (source.includes(":")) {
      // Docker's own `-v` grammar cannot express this, so it could not have
      // reached a real mount either. Said rather than dropped.
      verdicts.push({
        source,
        visible: false,
        detail: "contains a colon, which no `-v` spec can express",
      });
      continue;
    }
    const kind = await pathKind(source);
    if (kind === "missing") continue; // See the header: probing it would CREATE it.
    if (kind === "file") {
      const st = await stat(source);
      witnesses.push({ source, rel: "", size: st.size, wrote: false });
      continue;
    }
    if (kind === "other") continue; // A socket or device is not content a worker reads.

    const borrowed = await borrowWitness(source);
    if (borrowed !== null) {
      witnesses.push({ source, rel: borrowed.name, size: borrowed.size, wrote: false });
      continue;
    }
    try {
      await writeFile(join(source, MOUNT_PROBE_SENTINEL), SENTINEL_BODY);
    } catch (err) {
      verdicts.push({
        source,
        visible: false,
        detail: `cannot write a probe sentinel into ${source}: ${(err as Error).message}`,
      });
      continue;
    }
    witnesses.push({
      source,
      rel: MOUNT_PROBE_SENTINEL,
      size: Buffer.byteLength(SENTINEL_BODY),
      wrote: true,
    });
  }

  if (witnesses.length === 0) return verdicts;

  try {
    const argv = probeArgv(witnesses, tag);
    const r = await exec(argv, { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) {
      /**
       * An unusable probe is a REFUSAL, not a shrug.
       *
       * The entire class of bug here is a check that passes without measuring.
       * A probe container that will not start has measured nothing, so it
       * cannot license a launch — and the operator gets the runtime's own
       * words rather than a guess about them.
       */
      const why = r.timedOut
        ? `the probe container did not finish within ${PROBE_TIMEOUT_MS}ms`
        : `the probe container exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`;
      for (const w of witnesses) verdicts.push({ source: w.source, visible: false, detail: why });
      return verdicts;
    }
    const answers = parseAnswers(r.stdout);
    for (const [i, w] of witnesses.entries()) {
      const a = answers.get(i);
      if (a === undefined) {
        verdicts.push({
          source: w.source,
          visible: false,
          detail: "the probe container reported nothing about this path",
        });
        continue;
      }
      const what = w.rel === "" ? w.source : join(w.source, w.rel);
      if (a.kind === "f" && a.size === w.size) {
        verdicts.push({ source: w.source, visible: true, detail: `${w.source} is visible inside the container` });
        continue;
      }
      verdicts.push({
        source: w.source,
        visible: false,
        detail:
          `the host has ${what} as a ${w.size}-byte regular file and the container sees ` +
          `${describeAnswer(a)} — the mount would come up EMPTY`,
      });
    }
    return verdicts;
  } finally {
    for (const w of witnesses) {
      if (w.wrote) await rm(join(w.source, MOUNT_PROBE_SENTINEL), { force: true }).catch(() => {});
    }
  }
}

/**
 * ISC-292 as a RUNTIME GUARD on the argv production actually launches.
 *
 * Deliberately shaped like `assertNoRunDirMount` and `assertNoHostGcloudMount`,
 * and for the reason those record: a predicate with no importer in `src/`
 * closes nothing. Throwing beats returning a flag — a launcher that ignores a
 * returned warning is the same launcher that would have shipped the mount.
 *
 * It takes the WHOLE FLEET's argvs rather than one, which is the one shape
 * difference from its two siblings and is not cosmetic: those two ask a
 * question about each argv on its own, and this one asks a question about the
 * daemon, whose answer is the same for every worker. Handing it the set is what
 * lets it charge one container for a fleet, and it means EVERY worker is
 * checked before ANY is launched — the same rule `assertModelsAllowed` states,
 * for the same reason: refusing inside the launch loop leaves a half-started
 * fleet behind the refusal.
 */
export async function assertBindMountsVisible(
  argvs: readonly (readonly string[])[],
  tag: string,
  exec: Exec = realExec,
): Promise<void> {
  const sources = unique(argvs.flatMap((a) => bindMountSources(a)));
  const verdicts = await probeBindMountSources(sources, tag, exec);
  const bad = verdicts.filter((v) => !v.visible);
  if (bad.length > 0) throw new MountNotVisibleError(bad);
}

/** The finished probe argv. Read-only, network-less, disposable, every mount `:ro`. */
function probeArgv(witnesses: readonly Witness[], tag: string): string[] {
  const argv = ["docker", "run", "--rm", "--read-only", "--network", "none"];
  for (const [i, w] of witnesses.entries()) argv.push("-v", `${w.source}:/probe/${i}:ro`);
  argv.push("--entrypoint", "/bin/sh", tag, "-c", probeScript(witnesses));
  return argv;
}

/**
 * The in-container measurement.
 *
 * `-h` is tested BEFORE `-f`, because `[ -f ]` follows symlinks and a symlink
 * that happens to resolve to a same-sized file would otherwise read as the
 * witness itself. Every interpolated path is built from a `SHELL_SAFE` name and
 * a fixed target, so the single quotes cannot be escaped from.
 */
function probeScript(witnesses: readonly Witness[]): string {
  const lines = [
    `probe() { if [ -h "$2" ]; then echo "$1 l 0"; ` +
      `elif [ -f "$2" ]; then echo "$1 f $(wc -c < "$2" | tr -d ' ')"; ` +
      `elif [ -d "$2" ]; then echo "$1 d 0"; else echo "$1 x 0"; fi; }`,
  ];
  for (const [i, w] of witnesses.entries()) {
    lines.push(`probe ${i} '${w.rel === "" ? `/probe/${i}` : `/probe/${i}/${w.rel}`}'`);
  }
  return lines.join("\n");
}

interface Answer {
  kind: string;
  size: number;
}

function parseAnswers(stdout: string): Map<number, Answer> {
  const out = new Map<number, Answer>();
  for (const line of stdout.split("\n")) {
    const m = /^(\d+) ([fdlx]) (\d+)$/.exec(line.trim());
    if (m === null) continue;
    out.set(Number(m[1]), { kind: m[2]!, size: Number(m[3]) });
  }
  return out;
}

function describeAnswer(a: Answer): string {
  if (a.kind === "d") return "a DIRECTORY — the shape a runtime invents for an unshared path";
  if (a.kind === "x") return "nothing there at all";
  if (a.kind === "l") return "a symlink";
  return `a ${a.size}-byte file`;
}

/** A file already in `dir` that can serve as the witness, or null. */
async function borrowWitness(dir: string): Promise<{ name: string; size: number } | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let scanned = 0;
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (scanned >= WITNESS_SCAN_LIMIT) break;
    if (!e.isFile()) continue; // `Dirent.isFile` is already lstat-shaped: a symlink is not a file.
    if (!SHELL_SAFE.test(e.name)) continue;
    scanned += 1;
    try {
      const st = await lstat(join(dir, e.name));
      // Zero bytes is no discriminator at all — an invented empty path could
      // hold a zero-byte file just as easily. Only a size proves something.
      if (st.size > 0) return { name: e.name, size: st.size };
    } catch {
      continue;
    }
  }
  return null;
}

async function pathKind(p: string): Promise<"file" | "dir" | "missing" | "other"> {
  try {
    const st = await stat(p); // Follows symlinks, as Docker's own resolution does.
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return "other";
  } catch {
    return "missing";
  }
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
