/**
 * Bridge-gateway containment — argv and refusal semantics (ISC-51).
 *
 * No daemon here. What these pin is the part that is dangerous to get subtly
 * wrong: a rule too WIDE takes the host off the network, a rule too NARROW
 * silently drops nothing while `up` reports containment. Both failures are
 * invisible at the call site, so the argv is asserted byte-for-byte rather
 * than "an iptables command was built".
 *
 * The end-to-end proof that the rule closes the hole is Docker-gated and lives
 * in `test/integration/relay.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  assertGatewayAddress,
  bridgeInterfaceFor,
  gatewayBlockRuleArgv,
  hostIptablesArgv,
} from "../../src/security/gateway-block.ts";
import { RELAY_IMAGE } from "../../src/security/relay.ts";

describe("bridgeInterfaceFor", () => {
  test("is Docker's own naming: br- plus the first 12 hex characters", () => {
    expect(bridgeInterfaceFor("bbae97e1f14e0123456789abcdef")).toBe("br-bbae97e1f14e");
  });

  test("a 12-character id is used whole", () => {
    expect(bridgeInterfaceFor("d801779ea4a4")).toBe("br-d801779ea4a4");
  });

  // Guessing an interface name from something that is not a network ID would
  // produce a rule that matches nothing — containment reported, none applied.
  test("refuses anything that is not a long-enough hex id", () => {
    for (const bad of ["", "short", "ZZZZZZZZZZZZ", "abc123", "br-abc123def456", "abcdef01234"]) {
      expect(() => bridgeInterfaceFor(bad)).toThrow(/refusing to derive a bridge interface/);
    }
  });
});

describe("assertGatewayAddress", () => {
  test("accepts the addresses Docker actually hands out", () => {
    for (const ok of ["172.18.0.1", "172.20.0.1", "10.0.0.1", "192.168.86.1", "0.0.0.0"]) {
      expect(() => assertGatewayAddress(ok)).not.toThrow();
    }
  });

  // Argv arrays stop quoting injection but NOT flag injection: iptables parses
  // a leading `-` as an option, so an unvalidated "gateway" could rewrite the
  // rule it was supposed to be an operand of.
  test("refuses anything that could parse as a flag or a range", () => {
    for (const bad of [
      "--jump=ACCEPT",
      "-j",
      "172.18.0.0/16",
      "172.18.0.1 -j ACCEPT",
      "fd00::1",
      "999.1.1.1",
      "172.18.0",
      "172.18.0.1.5",
      "",
      "01.2.3.4",
    ]) {
      expect(() => assertGatewayAddress(bad)).toThrow(/expected an IPv4 gateway address/);
    }
  });
});

describe("gatewayBlockRuleArgv", () => {
  // This exact rule is the security property. `-i` bounds it to one bridge and
  // `-d` to one address; drop either and the rule stops being safe to install.
  test("is scoped to one bridge and one address, and drops", () => {
    expect(gatewayBlockRuleArgv("br-bbae97e1f14e", "172.18.0.1", "-I")).toEqual([
      "-I", "INPUT", "-i", "br-bbae97e1f14e", "-d", "172.18.0.1", "-j", "DROP",
    ]);
  });

  test("check and delete differ from insert ONLY in the operation", () => {
    const insert = gatewayBlockRuleArgv("br-abc123abc123", "10.0.0.1", "-I");
    for (const op of ["-C", "-D"] as const) {
      const other = gatewayBlockRuleArgv("br-abc123abc123", "10.0.0.1", op);
      expect(other.slice(1)).toEqual(insert.slice(1));
      expect(other[0]).toBe(op);
    }
  });

  test("validates the gateway before building anything", () => {
    expect(() => gatewayBlockRuleArgv("br-abc123abc123", "--jump=ACCEPT", "-I")).toThrow(
      /expected an IPv4 gateway address/,
    );
  });

  test("never writes to a chain or target other than INPUT/DROP", () => {
    const argv = gatewayBlockRuleArgv("br-abc123abc123", "172.18.0.1", "-I");
    expect(argv).toContain("INPUT");
    expect(argv).toContain("DROP");
    expect(argv).not.toContain("ACCEPT");
    expect(argv).not.toContain("FORWARD");
    expect(argv).not.toContain("OUTPUT");
  });
});

describe("hostIptablesArgv", () => {
  const argv = hostIptablesArgv(gatewayBlockRuleArgv("br-bbae97e1f14e", "172.18.0.1", "-C"));

  // The privilege comes from the daemon, not from sudo and not from the client
  // — which is why this works identically on a Linux runner and on macOS,
  // where pifleet cannot run iptables at all.
  test("borrows the host's namespaces rather than the client's privilege", () => {
    expect(argv).toEqual([
      "run", "--rm", "--privileged", "--pid", "host", "--network", "host",
      "--entrypoint", "nsenter", RELAY_IMAGE,
      "-t", "1", "-m", "-n", "-i", "iptables",
      "-C", "INPUT", "-i", "br-bbae97e1f14e", "-d", "172.18.0.1", "-j", "DROP",
    ]);
  });

  // Reusing the already-pinned relay digest is what keeps this from adding a
  // second image to pull and re-pin. The image supplies `nsenter`; `-m` then
  // borrows the HOST's iptables binary, which the image does not contain.
  test("reuses the pinned relay image, by digest", () => {
    expect(argv).toContain(RELAY_IMAGE);
    expect(RELAY_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("--rm is present, so a refused run leaves no container behind", () => {
    expect(argv).toContain("--rm");
  });

  test("the rule is passed through unchanged, as the tail", () => {
    const rule = gatewayBlockRuleArgv("br-abc123abc123", "10.9.8.1", "-D");
    expect(hostIptablesArgv(rule).slice(-rule.length)).toEqual(rule);
  });
});
