/**
 * cmux capability probing (SRD §11; ISC-131/132/133).
 *
 * `doctor` and `up` both need the same answer to "can this backend actually
 * present a fleet?", and they need it as named facts rather than a boolean:
 * exit 3 with a diagnosis an operator can act on is the contract, because
 * "backend unavailable" without the WHY sends them straight to disabling the
 * backend instead of fixing a one-line config key.
 *
 * `read-screen` is deliberately `required: false`. It is diagnostics only
 * (SRD §4.1, ISC-132) — and the live probe that shaped this module watched it
 * fail with `internal_error: Failed to read terminal text` on a freshly
 * created background surface while every load-bearing verb kept working. A
 * probe that required it would fail runs over a capability the design forbids
 * depending on.
 */

import { EXIT, type ExitCode } from "../../contracts.ts";
import type { Capability } from "../types.ts";
import {
  capabilitiesArgv,
  helpArgv,
  pingArgv,
  versionArgv,
  type CmuxClient,
} from "./client.ts";
import { parseAccessMode } from "./parse.ts";

/**
 * CLI commands the backend cannot function without. Presence is checked
 * against `--help` text because the CLI listing is the surface cmux commits
 * to keeping stable — socket method names carry no such promise (SRD §4.1).
 * `respawn-pane` is in the list because it is how a viewer starts in a split
 * pane; without it panes would be empty shells and ISC-129 unmeetable.
 */
export const REQUIRED_COMMANDS = [
  "ping",
  "capabilities",
  "identify",
  "workspace",
  "new-split",
  "list-panes",
  "focus-pane",
  "respawn-pane",
] as const;

/** Every diagnosis is NAMED so exit-3 messages are grep-able and testable (ISC-131). */
export const DIAG = {
  binaryMissing: "cmux-binary-missing",
  socketUnreachable: "cmux-socket-unreachable",
  commandMissing: "cmux-required-command-missing",
  overPermissive: "cmux-socket-over-permissive",
} as const;

/**
 * A backend failure that already knows its exit code. The CLI entry point
 * recognizes anything `ExitCoded` (contracts.ts) and prints one line instead
 * of a stack trace — which is exactly what "exit 3 with a named diagnosis"
 * means in process terms.
 */
export class CmuxUnavailableError extends Error {
  readonly exitCode: ExitCode = EXIT.BACKEND_UNAVAILABLE;
  readonly diagnosis: string;
  constructor(diagnosis: string, detail: string) {
    super(`${diagnosis}: ${detail}`);
    this.name = "CmuxUnavailableError";
    this.diagnosis = diagnosis;
  }
}

export interface CmuxProbeReport {
  capabilities: Capability[];
  /** The first failed REQUIRED capability, as a throwable, or null when usable. */
  fatal: CmuxUnavailableError | null;
}

/**
 * Probe the installed cmux through the given client. Pure orchestration over
 * the CLI — every fact is something the binary said just now, not something
 * remembered from a doc page (the SRD's whole §18 is the cost of doing
 * otherwise).
 */
export async function probeCmux(client: CmuxClient): Promise<CmuxProbeReport> {
  const caps: Capability[] = [];
  let fatal: CmuxUnavailableError | null = null;
  const fail = (diag: string, detail: string): void => {
    // First failure wins: later probes against a dead binary would only
    // manufacture noise, and the operator needs one actionable message.
    if (fatal === null) fatal = new CmuxUnavailableError(diag, detail);
  };

  // 1. Binary present. Everything else is unreachable without it.
  const version = await client.run(versionArgv());
  if (version.code !== 0) {
    const detail = "`cmux --version` failed — is cmux installed and on PATH?";
    caps.push({ name: "cmux-binary", ok: false, required: true, detail });
    fail(DIAG.binaryMissing, detail);
    return { capabilities: caps, fatal };
  }
  caps.push({
    name: "cmux-binary",
    ok: true,
    required: true,
    detail: version.stdout.trim().split("\n")[0] ?? "",
  });

  // 2. Required commands, from `--help`. Checked before the socket because a
  // stale binary is a different fix (upgrade) than a dead socket (launch/auth),
  // and `--help` works with no daemon at all.
  const help = await client.run(helpArgv());
  const helpText = `${help.stdout}\n${help.stderr}`;
  const missing = REQUIRED_COMMANDS.filter((c) => !helpText.includes(c));
  if (missing.length > 0) {
    const detail = `cmux is missing required CLI command(s): ${missing.join(", ")} — need cmux >= 0.64.20`;
    caps.push({ name: "cmux-cli-commands", ok: false, required: true, detail });
    fail(DIAG.commandMissing, detail);
  } else {
    caps.push({
      name: "cmux-cli-commands",
      ok: true,
      required: true,
      detail: `all ${REQUIRED_COMMANDS.length} required commands present`,
    });
  }

  // `read-screen` availability is REPORTED, never required (ISC-132): the run
  // must succeed identically with or without it.
  caps.push({
    name: "cmux-read-screen",
    ok: helpText.includes("read-screen"),
    required: false,
    detail: helpText.includes("read-screen")
      ? "available (diagnostics only)"
      : "absent — diagnostics degrade, nothing else changes",
  });

  // 3. Socket liveness. `ping` exercises the full path — socket file, app up,
  // auth accepted — so its failure is THE "socket unreachable" diagnosis
  // (ISC-131), whatever the underlying cause.
  const ping = await client.run(pingArgv());
  const pong = ping.code === 0 && ping.stdout.trim() === "PONG";
  if (!pong) {
    const detail =
      "`cmux ping` did not answer PONG — cmux may not be running, or " +
      "automation.socketControlMode refuses this caller (use \"password\" mode " +
      "and provide the socket password)";
    caps.push({ name: "cmux-socket", ok: false, required: true, detail });
    fail(DIAG.socketUnreachable, detail);
    return { capabilities: caps, fatal };
  }
  caps.push({ name: "cmux-socket", ok: true, required: true, detail: "PONG" });

  // 4. Access mode. `allowAll` means any local process can drive the
  // operator's terminal — pifleet never writes it and refuses to normalize it
  // by running on top of it (SRD §4.1).
  const capsOut = await client.run(capabilitiesArgv());
  if (capsOut.code === 0) {
    try {
      const mode = parseAccessMode(capsOut.stdout);
      const over = mode === "allowAll";
      caps.push({
        name: "cmux-access-mode",
        ok: !over,
        required: true,
        detail: over
          ? 'socketControlMode is "allowAll" — any local process can drive cmux; use "password" mode'
          : `socketControlMode is "${mode}"`,
      });
      if (over) fail(DIAG.overPermissive, 'socketControlMode is "allowAll"; use "password" mode');
    } catch (err) {
      // A socket that answers PONG but emits unparseable capabilities is a
      // version-drift smell; report it, do not guess a mode.
      caps.push({
        name: "cmux-access-mode",
        ok: false,
        required: true,
        detail: String(err),
      });
      fail(DIAG.commandMissing, `\`cmux capabilities --json\` output unparseable: ${String(err)}`);
    }
  } else {
    const detail = "`cmux capabilities --json` failed after a successful ping";
    caps.push({ name: "cmux-access-mode", ok: false, required: true, detail });
    fail(DIAG.commandMissing, detail);
  }

  return { capabilities: caps, fatal };
}
