/**
 * The bind-mount sources a finished `docker run` argv would actually mount.
 *
 * ONE reader for every spelling, because the two security guards that consume
 * it (`assertNoRunDirMount`, `assertNoHostGcloudMount`) each had their own
 * inline copy and both copies understood exactly one of Docker's four, so
 * three valid spellings of the same mount walked past both. Measured on the
 * guards as shipped, against `-v <runDir>:/rundir`:
 *
 *   REFUSED   ["-v", "<src>:<dst>"]                     the split short form
 *   REFUSED   ["--volume", "<src>:<dst>"]               the split long form
 *   ALLOWED   ["--volume=<src>:<dst>"]                  valid docker
 *   ALLOWED   ["-v<src>:<dst>"]                         valid docker
 *   ALLOWED   ["--mount", "type=bind,source=…,target=…"] valid docker
 *
 * That gap was LATENT rather than live — `config/render.ts` emits only the
 * split short form — and latency is exactly why it was worth closing. The
 * entire stated justification for checking the FINISHED argv (see
 * `classifyRunDirExposure`) is that the offending path does not come from a
 * literal anyone can audit; a guard that then relies on upstream continuing to
 * spell the flag one particular way has re-imported the assumption it was
 * built to remove. The next person to add a mount is under no obligation to
 * pick the spelling the guard happens to parse, and nothing would tell them.
 *
 * ## Scope, stated rather than implied
 *
 * The whole argv is scanned, INCLUDING the elements after the image, which are
 * the container's own command rather than Docker flags. That is deliberate and
 * it errs toward refusing: a container command containing a literal
 * `-v <hostpath>:<x>` naming the run directory is not a thing any caller in
 * this repo produces, whereas stopping at the image would require this module
 * to know which element IS the image — a question with no reliable syntactic
 * answer, and getting it wrong re-opens the hole. The ISA records the same
 * trap from the other side: a mutation placed after the image produced a green
 * run because Docker would never have created that mount.
 *
 * ## Named volume versus host path
 *
 * Docker's own rule, not an approximation of it: a source that is a bare name
 * — no separator, no leading dot — is a NAMED VOLUME and names nothing on the
 * host, so it cannot expose a host directory and is dropped. Everything else
 * is a path and is `resolve()`d.
 *
 * That last clause is a behaviour CHANGE and it fixes a real gap. Both guards
 * previously dropped any source without a leading `/`, commented "a named
 * volume, not a host path" — but `./runs/r-1` is a host path, `runs/r-1` is a
 * host path, and Docker mounts both (relative sources resolve against the
 * client's working directory). The comment described the common case and the
 * code enforced it as though it were the only one. Resolving against
 * `process.cwd()` is right rather than merely convenient here: the guards run
 * in the same process that spawns `docker`, so this IS the working directory
 * Docker would resolve against.
 */

import { resolve } from "node:path";

/** A bare volume name: no separator, no leading dot. Docker's own grammar. */
const NAMED_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Every host path this argv would bind-mount, absolute and `resolve()`d.
 *
 * Lexical only — `resolve()` closes `..` and trailing-slash spellings and does
 * NOT close symlinks. Callers that can afford I/O (`renderWorker` is `async`)
 * should `realpath` the results; the synchronous guards inside
 * `buildDockerArgv` deliberately cannot, and say so.
 */
export function bindMountSources(argv: readonly string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    const prev = argv[i - 1];
    let spec: string | null = null;
    let kind: "volume" | "mount" | null = null;

    if (prev === "-v" || prev === "--volume") {
      spec = a;
      kind = "volume";
    } else if (prev === "--mount") {
      spec = a;
      kind = "mount";
    } else if (a.startsWith("--volume=")) {
      spec = a.slice("--volume=".length);
      kind = "volume";
    } else if (a.startsWith("--mount=")) {
      spec = a.slice("--mount=".length);
      kind = "mount";
    } else if (a.startsWith("-v") && a.length > 2 && !a.startsWith("--")) {
      // The glued short form. `-v` alone is the split form and is handled by
      // the `prev` branch on the NEXT element.
      spec = a.slice(2);
      kind = "volume";
    }
    if (spec === null || kind === null) return;

    const source = kind === "volume" ? volumeSource(spec) : mountSource(spec);
    if (source === null) return;
    const host = hostPath(source);
    if (host !== null) out.push(host);
  });
  return out;
}

/** `<src>:<dst>[:opts]` — the source is everything before the first colon. */
function volumeSource(spec: string): string | null {
  const sep = spec.indexOf(":");
  return sep === -1 ? spec : spec.slice(0, sep);
}

/**
 * `type=bind,source=<src>,target=<dst>` — and `src=`, which Docker accepts as
 * an alias for `source=`. Both are read; `type` is deliberately NOT filtered
 * on, because `hostPath` already drops anything that is a volume NAME, so a
 * `type=volume` mount falls out on its own without this module having to
 * predict Docker's default for a missing `type`.
 */
function mountSource(spec: string): string | null {
  for (const field of spec.split(",")) {
    const eq = field.indexOf("=");
    if (eq === -1) continue;
    const key = field.slice(0, eq).trim();
    if (key === "source" || key === "src") return field.slice(eq + 1);
  }
  return null;
}

/** The absolute host path this source names, or `null` for a named volume. */
function hostPath(source: string): string | null {
  if (source === "") return null;
  if (NAMED_VOLUME.test(source)) return null;
  return resolve(source);
}
