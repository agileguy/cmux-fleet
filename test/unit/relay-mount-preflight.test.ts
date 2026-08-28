/**
 * The relay's OWN bind mounts are checked before the relay is launched
 * (ISC-292).
 *
 * ## The gap these close
 *
 * `up` asserts bind-mount visibility over the finished WORKER argvs, far down
 * its body. `ensureEgressRelay` runs some five hundred lines earlier and mounts
 * three files of its own — `relayScriptPath`, `proxyScriptPath` and
 * `proxyPolicyScriptPath`, all under `repoRoot()`. Those sources appear on no
 * worker argv, so nothing in the launch path had ever asked whether the
 * container runtime can see the pifleet checkout.
 *
 * On a VM-backed runtime that question has teeth. Only a declared set of host
 * directories is shared into the VM, and `-v <src>:<dst>` against a path
 * outside it DOES NOT FAIL: the runtime invents an empty directory and mounts
 * that. A checkout under `/opt`, `/srv`, `/private/tmp` or an external volume
 * therefore produces a relay whose script, CONNECT proxy and matcher are three
 * empty directories, `docker run -d` exits 0, and the container dies on
 * `Cannot find module` — which `ensureEgressRelay` reports as "exited
 * immediately after start … check that nothing else holds port 8000". The
 * operator is sent to look at ports for a mount fault.
 *
 * ## Why these are unit tests with a substituted exec
 *
 * The same reason `mount-preflight.test.ts` gives: which paths are shared is a
 * property of the RUNTIME, and the DECISION has to be checkable on every
 * platform. On a native Linux daemon — CI — every path is shared, so the
 * negative direction cannot be produced against a real daemon at all. These
 * substitute the injected `Exec` and assert the decision: a runtime that
 * reports the relay's scripts as invented empty directories REFUSES the
 * launch, a truthful one does not, and the adoption path never pays for the
 * check.
 *
 * They do not witness a genuinely unshared path. Nothing in this repo can, off
 * a VM-backed runtime; `test/integration/doctor-preflight.test.ts` is where the
 * agreement with a real daemon is measured.
 *
 * ## The one thing these tests do NOT drive to completion
 *
 * `ensureEgressRelay` calls `ensureUplinkNetwork`, which takes no injected
 * `Exec` and reaches the real `docker` binary. It sits AFTER the guard, so
 * every assertion below is about what happened before it — which is exactly
 * the property under test — and no test here needs a daemon to reach its
 * verdict.
 */

import { describe, expect, test } from "bun:test";
import { MountNotVisibleError } from "../../src/container/mount-preflight.ts";
import type { Exec } from "../../src/container/run.ts";
import { EXIT, isExitCoded } from "../../src/contracts.ts";
import {
  ensureEgressRelay,
  omlxRelayTarget,
  proxyPolicyFor,
  proxyPolicyScriptPath,
  proxyScriptPath,
  relayContainerName,
  relayScriptPath,
  PROXY_POLICY_ENV,
  RELAY_IMAGE,
  RELAY_TARGETS_ENV,
} from "../../src/security/relay.ts";
import {
  answerMountProbe,
  isMountProbe,
  mountProbeSeesEmptyDirs,
} from "../support/mount-probe-fake.ts";

const NET = "pifleet-egress";

/**
 * A `RelayConfigView` shaped like an untouched `fleet.yaml`.
 *
 * The current alias spelling (ISC-264) rather than `host.docker.internal`, so
 * these runs do not emit the rename warning and nothing here depends on which
 * of the two names a future default uses.
 */
const cfg = {
  llm: { base_url: "http://omlx.pifleet.internal:8000/v1", relay_upstream: null },
  egress: { google_hosts: ["oauth2.googleapis.com"], allow: [] },
};

/** The three files the relay bind-mounts out of this checkout. */
const RELAY_MOUNT_SOURCES = [relayScriptPath(), proxyScriptPath(), proxyPolicyScriptPath()];

/**
 * A `docker inspect` payload for a RUNNING relay that already forwards and
 * enforces exactly what `cfg` resolves to — the adoption case.
 *
 * Stamped from `omlxRelayTarget` and `proxyPolicyFor` rather than from
 * hand-written literals: this has to be a relay the drift check finds
 * up-to-date, and a literal that fell out of step with either derivation would
 * turn the adoption test below into a second, silent test of the create path.
 */
const upToDateRelay = JSON.stringify([
  {
    Name: `/${relayContainerName(NET)}`,
    Id: "abc123",
    State: { Running: true },
    Config: {
      Env: [
        `${RELAY_TARGETS_ENV}=${JSON.stringify([omlxRelayTarget(cfg)])}`,
        `${PROXY_POLICY_ENV}=${JSON.stringify(proxyPolicyFor(cfg))}`,
      ],
    },
  },
]);

/** What the daemon says when the relay does not exist yet — the create path. */
const NO_RELAY = { code: 1, stdout: "", stderr: "Error: No such object: relay", timedOut: false };

/**
 * A fake daemon that records every argv and answers the mount probe with the
 * given runtime.
 *
 * `inspectStdout` of `null` means "no such container", which is what sends
 * `ensureEgressRelay` down the create path this guard protects.
 */
function daemon(probe: Exec, inspectStdout: string | null) {
  const calls: string[][] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push([...argv]);
    if (isMountProbe(argv)) return probe(argv, opts);
    if (argv[1] === "inspect") {
      return inspectStdout === null
        ? NO_RELAY
        : { code: 0, stdout: inspectStdout, stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "[]", stderr: "", timedOut: false };
  };
  return { calls, exec };
}

/** Every `docker run` that is NOT the preflight's own throwaway container. */
const launches = (calls: string[][]) =>
  calls.filter((c) => c[1] === "run" && !isMountProbe(c));

describe("a relay whose scripts the runtime cannot see is refused, not launched (ISC-292)", () => {
  /**
   * THE CRITERION. A runtime reporting the checkout as invented empty
   * directories refuses, and the relay is never started.
   *
   * The launch assertion is the half that matters. Throwing while still
   * handing the daemon a `docker run` would leave the exact container this
   * refusal exists to prevent — running, adoptable by name on every later
   * `up`, and serving workers a relay with no script in it.
   */
  test("an unshared checkout refuses the launch, and nothing is started", async () => {
    const { calls, exec } = daemon(mountProbeSeesEmptyDirs, null);
    await expect(ensureEgressRelay(cfg, NET, exec)).rejects.toThrow(MountNotVisibleError);
    expect(launches(calls)).toEqual([]);
    // Nor was anything torn down on the way to the refusal: the guard sits
    // ahead of the `rm -f`, so an operator with a bad checkout keeps whatever
    // relay they already had.
    expect(calls.filter((c) => c[1] === "rm")).toEqual([]);
  });

  /**
   * The message has to name all three paths, because the operator's fix is to
   * move or share ONE directory and they can only find it if it is written
   * down. Naming a single mount would understate the fault.
   */
  test("the refusal names every script mount and carries doctor's own exit code", async () => {
    const { exec } = daemon(mountProbeSeesEmptyDirs, null);
    const err = await ensureEgressRelay(cfg, NET, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MountNotVisibleError);
    for (const source of RELAY_MOUNT_SOURCES) expect((err as Error).message).toContain(source);
    // Exit 3, agreeing with `doctor`, which classifies this same condition as
    // `misconfigured`. Two commands reporting one condition under two codes is
    // the confusion ISC-216 records, over the only channel a machine caller
    // has.
    expect(isExitCoded(err)).toBe(true);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  });

  /**
   * The complement, without which the test above passes on a guard that
   * refuses everything.
   *
   * It asserts the absence of a REFUSAL rather than a completed launch, and
   * that is deliberate rather than weak: `ensureUplinkNetwork` runs after the
   * guard with no injected exec, so what happens past this point depends on
   * whether the machine has a daemon. What this file claims is that the mount
   * guard let the launch through, and that claim is checkable everywhere.
   */
  test("a runtime that can really see the checkout is not refused", async () => {
    const { calls, exec } = daemon(answerMountProbe, null);
    const err = await ensureEgressRelay(cfg, NET, exec).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MountNotVisibleError);
    // …and it was actually MEASURED. A guard that silently stopped probing
    // would satisfy the line above forever.
    expect(calls.filter(isMountProbe).length).toBe(1);
  });

  /**
   * The probe measures the relay's OWN sources, in the image the relay is
   * about to run.
   *
   * Both halves are load-bearing. A probe pointed at some other path would
   * pass on a machine where the checkout is unshared — the guard would exist
   * and prove nothing. And the tag must be `RELAY_IMAGE` for the reason `up`
   * gives for reusing the worker image: a preflight that pulls an image of its
   * own is slow on a cold machine and fails outright on an offline one, and
   * this is the image the very next `docker run` uses anyway.
   */
  test("the probe mounts exactly the relay's three scripts, in RELAY_IMAGE", async () => {
    const { calls, exec } = daemon(answerMountProbe, null);
    await ensureEgressRelay(cfg, NET, exec).catch(() => undefined);
    const probe = calls.find(isMountProbe)!;
    expect(probe).toBeDefined();
    const mounted = probe
      .filter((a, i) => probe[i - 1] === "-v")
      .map((spec) => spec.split(":")[0]);
    expect(mounted.sort()).toEqual([...RELAY_MOUNT_SOURCES].sort());
    expect(probe).toContain(RELAY_IMAGE);
  });
});

describe("the guard costs nothing when no relay is launched (ISC-292)", () => {
  /**
   * ADOPTION DOES NOT PROBE.
   *
   * A running relay that already forwards and enforces what this config
   * resolves to is adopted untouched — nothing is mounted, so there is nothing
   * to be visible. Probing anyway would charge every single `up` a container's
   * cold start for a mount no one is about to make, which is the same cost
   * `probeBindMountSources` goes out of its way to pay once per fleet rather
   * than once per mount. A guard nobody can afford is a guard that gets
   * removed.
   */
  test("an already-correct relay is adopted with no probe container at all", async () => {
    const { calls, exec } = daemon(answerMountProbe, upToDateRelay);
    const status = await ensureEgressRelay(cfg, NET, exec);
    expect(status.created).toBe(false);
    expect(calls.filter(isMountProbe)).toEqual([]);
    // One call total, and it is the inspect: the adoption path is unchanged by
    // this criterion, which is the property `up`'s idempotence rests on.
    expect(calls.length).toBe(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["docker", "inspect"]);
  });

  /**
   * The pairing that keeps the test above from passing on a guard that never
   * runs at all: the SAME fake daemon, differing only in whether a relay is
   * already there, does probe when one has to be built.
   */
  test("…but the very same daemon IS probed when a relay must be created", async () => {
    const { calls, exec } = daemon(answerMountProbe, null);
    await ensureEgressRelay(cfg, NET, exec).catch(() => undefined);
    expect(calls.filter(isMountProbe).length).toBe(1);
  });
});
