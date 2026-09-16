/**
 * `roles/observer-vm.md`'s resolved grant — SRD-OBSERVER-ROLES §6, task 5.7.
 *
 * ## What is checkable here
 *
 * The grant `observer-vm` actually resolves to in the shipped reference
 * config, read through the same functions the host resolves it with rather
 * than by regex-matching the YAML:
 *
 * - **Tools** — `roleGrant(config, ROLE)` (`test/support/role-docs.ts`), which
 *   is `defaults ← role`, then `exclude_tools` subtracted: `render.ts`'s real
 *   `--exclude-tools` argv, restated as a probe.
 * - **Everything else** — `resolveAllWorkers(loaded)` (`src/config/load.ts`),
 *   the exact merge `config validate` runs (`src/cli/commands/config.ts:117`),
 *   read off the one seat that names this role, `obs-v1`. Wherever the
 *   resolver exposes it, the assertion is against the resolved *seat*, not
 *   the raw role block, so a worker-level override on `obs-v1` would be
 *   graded honestly instead of being invisible to a role-only probe.
 *
 * `cloud_access` is asserted `false` per Q2 (principal, 2026-09-13): any
 * Linux/systemd VM reachable over SSH, with the cloud channel off.
 *
 * `observer-vm` has no exported role-name constant today either — only
 * `OBSERVER_K8S_ROLE` does (`src/config/schema.ts`) — so this file names it
 * with a local constant instead of inventing one in `src/`.
 *
 * Not checked: `roles/observer-vm.md`'s prose. This task pins the resolved
 * grant only.
 */
import { describe, expect, test } from "bun:test";

import { loadConfig, resolveAllWorkers } from "../../src/config/load.ts";
import { multilineSecretNames, nonCredentialSecretNames } from "../../src/config/schema.ts";
import { roleGrant } from "../support/role-docs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** No exported constant for this role name exists today — see docblock above. */
const OBSERVER_VM_ROLE = "observer-vm";

/** The one seat that names the role (§6.6, Q10 — no console, no second seat). */
const OBSERVER_VM_SEAT = "obs-v1";

/** Resolve the one seat under test, throwing loudly if the config stops naming it. */
async function resolvedSeat() {
  const loaded = await loadConfig(`${ROOT}fleet.example.yaml`);
  const worker = resolveAllWorkers(loaded).find((w) => w.id === OBSERVER_VM_SEAT);
  if (worker === undefined) {
    throw new Error(
      `no worker named "${OBSERVER_VM_SEAT}" — the probe has rotted. Configured workers: ` +
        resolveAllWorkers(loaded)
          .map((w) => w.id)
          .join(", "),
    );
  }
  return worker;
}

describe("observer-vm's resolved grant (task 5.7)", () => {
  test("the seat obs-v1 resolves to the observer-vm role", async () => {
    const worker = await resolvedSeat();
    expect(worker.role).toBe(OBSERVER_VM_ROLE);
  });

  test("tools: no edit", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const tools = roleGrant(config, OBSERVER_VM_ROLE);
    expect(tools).not.toContain("edit");
  });

  test("tools: write is present", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const tools = roleGrant(config, OBSERVER_VM_ROLE);
    expect(tools).toContain("write");
  });

  test("tools: submit_report is present", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const tools = roleGrant(config, OBSERVER_VM_ROLE);
    expect(tools).toContain("submit_report");
  });

  test("cloud_access: false — Q2 left the cloud channel off", async () => {
    const worker = await resolvedSeat();
    expect(worker.cloudAccess).toBe(false);
  });

  test("egress_access: true — a route to the CONNECT proxy", async () => {
    const worker = await resolvedSeat();
    expect(worker.egressAccess).toBe(true);
  });

  test("isolation: none — no repository, the outbox artifact is the whole output", async () => {
    const worker = await resolvedSeat();
    expect(worker.isolation).toBe("none");
  });

  test("pane_mode: rpc — one seat, no console", async () => {
    const worker = await resolvedSeat();
    expect(worker.paneMode).toBe("rpc");
  });

  /**
   * The exact set, not "at least these" — an extra name (a fourth secret this
   * role should not hold) must go red exactly as readily as a missing one, so
   * this compares against the full set rather than three separate
   * `toContain` calls.
   */
  test("secrets: exactly the three observer-vm credential names", async () => {
    const worker = await resolvedSeat();
    expect(new Set(worker.secrets)).toEqual(
      new Set(["OBSERVER_VM_SSH_KEY", "OBSERVER_VM_KNOWN_HOSTS", "OBSERVER_VM_TARGETS"]),
    );
  });

  /**
   * The `worker.secrets` set above pins WHICH names are granted; it says
   * nothing about the `multiline`/`credential` marks each name carries on the
   * fleet-wide `secrets.env_allowlist` (§6.6, for the reason §5.5 records
   * as the principal's decision of 2026-09-14). Those marks live on the
   * allowlist entry, not on the grant,
   * so they are read off `config.secrets.env_allowlist` through the same
   * `multilineSecretNames`/`nonCredentialSecretNames` helpers `up` and the
   * harvester use (`src/run/worker-env.ts`) — never by regex-matching the
   * YAML.
   *
   * `OBSERVER_VM_SSH_KEY` is an OpenSSH private key: multiline, and left
   * as a credential (the sweep must still catch it).
   */
  test("OBSERVER_VM_SSH_KEY is multiline and a credential", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const entries = config.secrets.env_allowlist;
    expect(multilineSecretNames(entries)).toContain("OBSERVER_VM_SSH_KEY");
    expect(nonCredentialSecretNames(entries)).not.toContain("OBSERVER_VM_SSH_KEY");
  });

  /**
   * `OBSERVER_VM_KNOWN_HOSTS` (public host keys) and `OBSERVER_VM_TARGETS`
   * (`token host port user` per line) are each legitimately multi-line AND
   * legitimately not secret — an artifact that names the host it looked at
   * must not be refused as leaking its own target list.
   */
  test("OBSERVER_VM_KNOWN_HOSTS and OBSERVER_VM_TARGETS are multiline and credential: false", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const entries = config.secrets.env_allowlist;
    for (const name of ["OBSERVER_VM_KNOWN_HOSTS", "OBSERVER_VM_TARGETS"]) {
      expect(multilineSecretNames(entries)).toContain(name);
      expect(nonCredentialSecretNames(entries)).toContain(name);
    }
  });
});
