/**
 * `pifleet doctor`'s cmux reporting (ISC-132, ISC-133, ISC-136).
 *
 * `doctor` had no tests at all, and it had also drifted: it kept its own copy
 * of the required-command list, and that copy was missing `respawn-pane` —
 * which the backend requires because it is how a viewer starts in a split
 * pane. So `doctor` would report a clean cmux that `up` then failed on, which
 * is precisely the failure `doctor` exists to prevent. Two lists that must
 * agree, in two files, with nothing comparing them.
 *
 * cmux is driven through a PATH shim rather than the real binary: the property
 * under test is how `doctor` REACTS to a cmux missing a command, and the
 * installed 0.64.20 has all of them. A shim is the only way to see the
 * reaction at all.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { REQUIRED_COMMANDS } from "../../src/backends/cmux/capabilities.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * A `cmux` whose `--help` lists exactly `commands`, so a command can be made
 * to go missing — plus healthy `docker` and `git`, which is the part that
 * makes the exit code MEAN something.
 *
 * The first version shimmed only cmux and asserted exit 3. It passed locally
 * for the wrong reason: this machine has no running Docker daemon, so the
 * docker probe failed, `doctor` exited 3 on that account, and the assertion
 * held whether or not a cmux command was missing. CI — where docker works —
 * returned a different code and exposed it. Shimming every required probe
 * makes cmux the only thing that can produce a diagnosis, so exit 3 is
 * attributable to the thing under test rather than to the machine.
 */
async function shimCmux(commands: readonly string[]): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-doctor-"));
  bases.push(base);
  const shim = join(base, "cmux");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "cmux 0.64.20 (100) [test-shim]" ;;',
      `  --help) printf '%s\\n' ${commands.map((c) => `'  ${c}'`).join(" ")} ;;`,
      '  capabilities) echo "{\\"access_mode\\":\\"full\\",\\"methods\\":[]}" ;;',
      '  ping) echo PONG ;;',
      '  identify) echo "{}" ;;',
      '  *) echo "cmux shim: unexpected argv: $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);

  // Healthy stand-ins for the other REQUIRED probes. Without these the
  // machine decides the exit code: no Docker daemon here means `doctor`
  // exits 3 on that account alone, which is how the first version of this
  // test passed while proving nothing.
  // `doctor` probes the SERVER version (`docker version --format ...`), not
  // `--version`, and since ISC-159 it floors what comes back. The shim used to
  // answer only `--version` and let the catch-all return `{}` — so the probe
  // that actually runs was reporting a docker whose server version was `{}`,
  // and this "healthy stand-in" was healthy by accident.
  await writeFile(
    join(base, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "Docker version 28.0.0, build test-shim" ;;',
      '  version) echo "28.0.0" ;;',
      '  *) echo "{}" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(join(base, "docker"), 0o755);
  await writeFile(join(base, "git"), ["#!/bin/sh", 'echo "git version 2.50.1"', ""].join("\n"));
  await chmod(join(base, "git"), 0o755);
  return base;
}

async function doctor(binDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "doctor", "--json"], {
    env: {
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      PIFLEET_RUNS_DIR: join(binDir, "runs"),
      HOME: binDir, // no developer cmux.json leaking in
      // Inside-a-pane, so `cmuxOnly` socket mode is not itself a diagnosis and
      // the assertions below are about the command list, not the socket.
      CMUX_WORKSPACE_ID: "ws-test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Parse `doctor --json`, surfacing stderr when it is not JSON.
 *
 * `JSON.parse` on empty stdout throws "Unexpected EOF", which says nothing
 * about WHY doctor produced nothing — that failure cost a CI round-trip
 * already. The diagnostic belongs in the assertion, not in a follow-up run.
 */
function parseDoctor(r: { code: number; stdout: string; stderr: string }): Record<string, unknown> {
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `doctor --json produced no parseable stdout (exit ${r.code}). stderr: ${r.stderr.slice(0, 800)}`,
    );
  }
}

/**
 * ISC-266: every test below is budgeted by the number of `doctor()` spawns it
 * performs, not by bun's 5000 ms default.
 *
 * Measured standalone on an idle 14-core machine, three runs. The cost here is
 * almost perfectly linear in the spawn count — one `doctor` invocation costs
 * 1026-1421 ms, two cost 2088-2345 ms — which is the `cliBudget` model holding
 * exactly, and it is also why the whole cluster is budgeted rather than only
 * its slowest member. The two single-spawn tests do the SAME work as each
 * other; their measured spread (1198 vs 1421 ms on the same run) is run-to-run
 * noise on one operation, so treating them differently would draw the line on
 * noise rather than on what the tests do.
 *
 * Against the 5000 ms default the two-spawn test had ~2.1x headroom, and the
 * 2.09x-2.98x inflation measured under load in `test/support/budget.ts` covers
 * that on its own. Nothing here was observed failing; it is budgeted because
 * the margin is already inside the range where contention is known to land.
 */
describe("doctor reports what cmux can and cannot do", () => {
  /**
   * ISC-133. `respawn-pane` specifically, because that is the command the
   * duplicated list had dropped — a regression test for the divergence, not
   * just for the mechanism.
   */
  test("a missing required cmux command exits 3 with a named diagnosis", async () => {
    const missing = "respawn-pane";
    const bin = await shimCmux(REQUIRED_COMMANDS.filter((c) => c !== missing));
    const r = await doctor(bin);
    expect(r.code, `doctor stderr: ${r.stderr.slice(0, 800)}`).toBe(EXIT.BACKEND_UNAVAILABLE);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("cmux-required-command-missing");
    expect(out).toContain(missing);
    // One `doctor` spawn; 1140-1421 ms idle across three standalone runs.
  }, cliBudget(1));

  test("a cmux with every required command does not fail on that account", async () => {
    const bin = await shimCmux([...REQUIRED_COMMANDS, "read-screen"]);
    const r = await doctor(bin);
    const parsed = parseDoctor(r);
    const cmux = parsed["cmux"] as Record<string, unknown>;
    // Every CLI command is present; whatever else a shim cannot satisfy (a
    // real socket, say) is a different diagnosis and not this test's subject.
    expect(cmux["missing_commands"]).not.toContain("respawn-pane");
    // One `doctor` spawn; 1026-1198 ms idle across three standalone runs.
  }, cliBudget(1));

  /**
   * ISC-132. `read-screen` is diagnostics-only, so its absence must NOT fail
   * the run — but it must be reported, or the operator cannot distinguish a
   * missing diagnostic from a broken one.
   */
  test("read-screen availability is reported, and its absence is not fatal", async () => {
    const withRs = await doctor(await shimCmux([...REQUIRED_COMMANDS, "read-screen"]));
    const withoutRs = await doctor(await shimCmux([...REQUIRED_COMMANDS]));

    const a = parseDoctor(withRs);
    const b = parseDoctor(withoutRs);
    const caps = (x: Record<string, unknown>): Array<{ name: string; ok: boolean }> => {
      // Top-level `cmux`; `backends` is a kind -> boolean map, not this report.
      const cmux = x["cmux"] as Record<string, unknown> | undefined;
      return (cmux?.["optional_capabilities"] as Array<{ name: string; ok: boolean }>) ?? [];
    };

    const rsA = caps(a).find((c) => c.name.includes("read-screen"));
    const rsB = caps(b).find((c) => c.name.includes("read-screen"));
    expect(rsA?.ok).toBe(true);
    expect(rsB?.ok).toBe(false);

    // Reported, never required: losing a diagnostic does not change the verdict.
    expect(withoutRs.code).toBe(withRs.code);
    // Two `doctor` spawns — the with/without pair; 2088-2345 ms idle.
  }, cliBudget(2));
});

/**
 * ISC-136 (anti): `readScreen` is diagnostics only. If any control-plane path
 * called it, a rendered pane would become correctness-bearing — the exact
 * coupling the SRD's "the pane is a view" principle forbids, and the reason
 * screen-scraping orchestrators cannot tell "succeeded" from "printed the word
 * success".
 */
describe("readScreen stays out of the control plane (ISC-136)", () => {
  test("no file outside the backends calls readScreen", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    const p = Bun.spawn(["git", "-C", root, "ls-files", "src"], { stdout: "pipe", stderr: "pipe" });
    const files = (await new Response(p.stdout).text())
      .split("\n")
      .filter((f) => f.endsWith(".ts"));
    await p.exited;
    expect(files.length).toBeGreaterThan(0);

    for (const rel of files) {
      // The backends DEFINE it; diagnostics may report it. Nothing else may
      // call it, and that is what this walks the tree to prove.
      if (rel.startsWith("src/backends/")) continue;
      const text = await Bun.file(join(root, rel)).text();
      expect(/\breadScreen\s*\(/.test(text), `${rel} calls readScreen`).toBe(false);
    }
  }, cliBudget(1));
});
