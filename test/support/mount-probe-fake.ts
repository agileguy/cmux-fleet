/**
 * A fake container runtime's half of the ISC-292 bind-mount preflight.
 *
 * `assertBindMountsVisible` measures a witness file on the host, mounts its
 * source into a throwaway container, and asks the container about the same
 * file. Any test that drives a code path which now runs that preflight has to
 * answer the second question, or the guard refuses — correctly, because a
 * probe container that says nothing has measured nothing and must never read
 * as a pass. `ensureEgressRelay` is the path that forced this to be shared:
 * `test/unit/relay.test.ts` drives it for the ISC-265 drift decision and
 * `test/unit/relay-mount-preflight.test.ts` drives it for the guard itself, and
 * a second private copy of the answering logic in either file would be a place
 * for the two to disagree about what a truthful runtime says.
 *
 * ## Truthful, not agreeable
 *
 * `answerMountProbe` reads the ACTUAL host files the argv mounts and reports
 * their real sizes. A fake that simply replied "visible" to whatever it was
 * asked would keep every test green while the guard was pointed at the wrong
 * paths entirely — which is the failure mode the guard exists to catch, moved
 * into the test fixture. `mountProbeSeesEmptyDirs` is the opposite pole: the
 * verbatim shape a VM-backed runtime produces for an unshared source, an empty
 * DIRECTORY where the host has a file.
 *
 * Neither of these starts a container or requires a daemon, so tests built on
 * them run on every platform rather than self-skipping where Docker is absent.
 */

import { join } from "node:path";
import type { ExecResult } from "../../src/container/run.ts";

/**
 * Is this argv the preflight's probe container?
 *
 * Recognized by the SCRIPT it carries — `probe <i> '<path>'` lines, emitted by
 * `probeScript` — rather than by the image tag or the `--entrypoint` flag. The
 * script is what the answer has to be derived from anyway, and a caller that
 * changes which image it probes in (the relay uses `RELAY_IMAGE`, `up` uses
 * the worker image) must not need this predicate updated to match.
 */
export function isMountProbe(argv: readonly string[]): boolean {
  return /^probe \d+ '/m.test(argv[argv.length - 1] ?? "");
}

/**
 * Answer the probe from the real files on disk.
 *
 * Each `-v <src>:/probe/<i>:ro` is translated back to the host path it came
 * from and stat'd, so a "visible" verdict means the code agreed with a
 * truthful container — not that anything defaulted to true. A source that is
 * genuinely absent answers `x`, which is what an honest empty runtime would
 * say, rather than a fabricated size.
 */
export async function answerMountProbe(argv: readonly string[]): Promise<ExecResult> {
  const script = argv[argv.length - 1] ?? "";
  const out: string[] = [];
  for (const m of script.matchAll(/^probe (\d+) '([^']*)'$/gm)) {
    const idx = m[1]!;
    const containerPath = m[2]!;
    const spec = argv.find((a, i) => argv[i - 1] === "-v" && a.includes(`:/probe/${idx}:`));
    const src = spec?.split(":")[0] ?? "";
    // "" when the SOURCE is the witness file itself — the shape every one of
    // the relay's three mounts has, since all three are files.
    const rel = containerPath.slice(`/probe/${idx}`.length);
    const f = Bun.file(rel === "" ? src : join(src, rel));
    out.push((await f.exists()) ? `${idx} f ${f.size}` : `${idx} x 0`);
  }
  return { code: 0, stdout: `${out.join("\n")}\n`, stderr: "", timedOut: false };
}

/**
 * The hazard itself: every witness comes back as an empty directory.
 *
 * This is what a VM-backed runtime reports for a source outside its shared
 * set — it invents a directory inside the VM and mounts that — and the reason
 * the exit status cannot be the signal is that `docker run` still exits 0.
 */
export async function mountProbeSeesEmptyDirs(argv: readonly string[]): Promise<ExecResult> {
  const script = argv[argv.length - 1] ?? "";
  const out: string[] = [];
  for (const m of script.matchAll(/^probe (\d+) '/gm)) out.push(`${m[1]!} d 0`);
  return { code: 0, stdout: `${out.join("\n")}\n`, stderr: "", timedOut: false };
}
