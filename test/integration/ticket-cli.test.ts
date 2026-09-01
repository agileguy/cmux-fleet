/**
 * The ticket CLI's configuration shim, against the real image.
 *
 * ## What only this file can prove
 *
 * `test/unit/ticket-cli.test.ts` reads the shim as TEXT: it asserts the pin
 * agrees with the Dockerfile, that no delivered value reaches argv, that the
 * refusal exits 78. Every one of those is a property of the source, and all of
 * them hold for a script that never runs — a missing `python3`, a venv at the
 * wrong path, a `COPY` that lost the exec bit, and the file still reads
 * perfectly.
 *
 * So this runs it. The image, the shim, four mounted files, and the CLI's own
 * `config` command reporting what it received.
 *
 * ## No real credential is used, and that is not a compromise
 *
 * The token here is the literal string `sentinel-not-a-real-key`. What is under
 * test is the MAPPING — four `<NAME>_FILE` pointers becoming four `RALLY_*`
 * variables inside the CLI's process — and `rally-cli config` reports every one
 * of them without dialling anything. A probe that used a live key would prove
 * the same mapping plus Rally's uptime, and would put a credential in a test
 * fixture to do it.
 *
 * The one thing it therefore does NOT prove is that the key is accepted by the
 * server. That is a live-run property; the credential's last four characters
 * are echoed by `config` and are the operator's check, not this file's.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliBudget } from "../support/budget.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";
const IMAGE = process.env["PIFLEET_TEST_IMAGE"] ?? "pifleet/pi-worker:verify";

if (!DOCKER) {
  // eslint-disable-next-line no-console
  console.log(
    `[skip] ticket-cli integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

const scratches: string[] = [];
afterAll(async () => {
  for (const s of scratches) await rm(s, { recursive: true, force: true }).catch(() => {});
});

const SENTINEL = "sentinel-not-a-real-key";

/**
 * The four delivered files, in the shape the fleet actually mounts them: a
 * read-only `/secrets` directory of 0444 files, with no value in the
 * environment except the paths.
 *
 * Under `$HOME` rather than `/tmp`, and that is a measured constraint rather
 * than a preference: on this host Docker runs under Colima, which shares the
 * user's home directory and does NOT share `/private/tmp`. A `-v` of a path
 * outside the shared set does not fail — it mounts an EMPTY directory, and the
 * probe fails with "cannot be read" while looking exactly like a permissions
 * bug. `mkdtemp` under `$HOME` avoids the whole class.
 */
async function deliver(
  omit?: "token" | "baseurl" | "workspace" | "project",
): Promise<{ mounts: string[]; env: string[] }> {
  const home = process.env["HOME"] ?? tmpdir();
  const dir = await mkdtemp(join(home, ".pifleet-ticketcli-"));
  scratches.push(dir);
  // 0755: the container runs as uid 10001, which must be able to traverse.
  await chmod(dir, 0o755);
  const files: Record<string, string> = {
    token: SENTINEL,
    baseurl: "https://rally1.rallydev.com/slm/webservice/v2.0",
    workspace: "WS-Sentinel",
    project: "PR-Sentinel",
  };
  await mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    if (name === omit) continue;
    await writeFile(join(dir, name), value);
    await chmod(join(dir, name), 0o444);
  }
  return {
    mounts: ["-v", `${dir}:/secrets:ro`],
    env: [
      // The pointer is ALWAYS set, even for the omitted file. That is the
      // deployment shape worth probing: `secrets:` granted the name and the
      // file did not arrive, which must be a refusal and not a default.
      "-e",
      "TICKET_API_TOKEN_FILE=/secrets/token",
      "-e",
      "TICKET_BASE_URL_FILE=/secrets/baseurl",
      "-e",
      "TICKET_WORKSPACE_FILE=/secrets/workspace",
      "-e",
      "TICKET_PROJECT_FILE=/secrets/project",
    ],
  };
}

async function runShim(
  args: string[],
  extra: { mounts?: string[]; env?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      ...(extra.mounts ?? []),
      ...(extra.env ?? []),
      "--entrypoint",
      "rally-cli",
      IMAGE,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

describe.skipIf(!DOCKER)("the ticket CLI is on PATH and pre-configured", () => {
  test(
    "four delivered files become the CLI's configuration",
    async () => {
      const d = await deliver();
      const r = await runShim(["config"], d);
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);

      // The mapping, one assertion per delivered value, so a shim that wired
      // three of four is red on the one it missed rather than on a blob.
      expect(r.stdout).toContain("WS-Sentinel");
      expect(r.stdout).toContain("PR-Sentinel");
      // The base URL is delivered whole and the CLI wants a HOSTNAME: scheme
      // and path stripped. Asserted as the transformation, not just presence.
      expect(r.stdout).toContain("rally1.rallydev.com");
      expect(r.stdout).not.toContain("https://");
      expect(r.stdout).not.toContain("/slm/webservice");
    },
    cliBudget(1),
  );

  test(
    "the credential reaches the CLI without ever being printed whole",
    async () => {
      const d = await deliver();
      const r = await runShim(["config"], d);
      // `config` reports that a key is set and shows its last four characters.
      // Both halves matter: the first proves the value arrived, the second
      // proves nothing echoes it in full.
      expect(r.stdout).toContain("set via RALLY_APIKEY");
      expect(r.stdout + r.stderr).not.toContain(SENTINEL);
    },
    cliBudget(1),
  );

  /**
   * The refusal, per value, and it is the half that matters most.
   *
   * An unconfigured CLI does not fail — it succeeds at something else. Without
   * a project it queries the whole workspace and returns rows, which reads as
   * an answer to the question that was asked. So a value that fails to arrive
   * must stop the command, and the message must name WHICH value, because the
   * fix differs: an absent pointer is a `secrets:` selector that did not name
   * it, an unreadable file is an `env_allowlist` that did not permit it.
   */
  test(
    "a value that fails to arrive is a refusal naming that value, not a default",
    async () => {
      for (const missing of ["token", "baseurl", "workspace", "project"] as const) {
        const d = await deliver(missing);
        const r = await runShim(["config"], d);
        expect(r.code, `omitting ${missing} did not refuse`).toBe(78);
        expect(r.stderr).toContain(`/secrets/${missing}`);
        expect(r.stderr).toContain("blocked");
        // And it did not fall through to the CLI: no configuration report.
        expect(r.stdout).not.toContain("Rally CLI Configuration");
      }
    },
    cliBudget(4),
  );

  test(
    "an unconfigured worker gets a refusal, not an unscoped query",
    async () => {
      // No mounts and no pointers at all — the shape a role that did not
      // request the secrets would run in. The dangerous outcome is a CLI that
      // starts and asks Rally something wider than intended.
      const r = await runShim(["tickets"]);
      expect(r.code).toBe(78);
      expect(r.stderr).toContain("TICKET_API_TOKEN_FILE is not set");
    },
    cliBudget(1),
  );

  test(
    "the real entry point is present and is the pinned release",
    async () => {
      // Through the venv path, not the PATH name: the shim refuses without
      // configuration, so this is the only way to ask the tool its version.
      // It is what the Dockerfile's build-time grep asserts, re-checked here
      // against the image that was actually produced.
      const p = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "/opt/pifleet/rally-cli/bin/rally-cli",
          IMAGE,
          "--version",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(p.stdout).text();
      await p.exited;
      const { TICKET_CLI_VERSION } = await import("../../src/config/ticket-cli.ts");
      expect(out).toContain(`version ${TICKET_CLI_VERSION}`);
    },
    cliBudget(1),
  );

  test(
    "the venv does not leak its dependencies into the system python",
    async () => {
      // `textual`, `httpx` and `pydantic` are this tool's dependencies, not the
      // fleet's. A worker doing Python work must not find them already
      // resolved at versions it did not choose — which is the whole reason the
      // CLI is installed into its own venv rather than system-wide.
      const p = Bun.spawn(
        ["docker", "run", "--rm", "--entrypoint", "python3", IMAGE, "-c", "import textual"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("No module named 'textual'");
    },
    cliBudget(1),
  );
});
