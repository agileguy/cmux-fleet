/**
 * D9's policy half: the operator authorizes the NAME, the relay dials the
 * ADDRESS, and both are true of the same run (ISC-428, §6.7).
 *
 * ## The claim this file was written to CHECK, not to assume
 *
 * §6.7 says of this exact change: *"`assertTargetsAllowed` then needs the NAME
 * for its policy comparison while the relay dials the ADDRESS, so `egress.allow`
 * carries `{host: ollama.com, port: 443}` and the operator authorizes a name.
 * `normalizeHost` and `decide` already match on names — that is how
 * `egress.allow`'s existing non-LLM entries work through the CONNECT proxy — so
 * this is a change of input, not of mechanism."*
 *
 * Half of that held and half of it did not, and the half that did not is the
 * one that decides whether D9 works at all. `normalizeHost` and `decide` do
 * match on names — that part is exactly right, and no line of `egress.ts`
 * needed to change. But `assertTargetsAllowed` did not FEED them a name. It
 * passed `t.host`, which under ISC-426 is the resolved literal, so a
 * name-carrying `egress.allow` and a literal-carrying target met at
 * `default-deny` and the relay was refused at `up`:
 *
 *     relay: refusing to forward ollama -> 34.36.183.157:443 — the egress
 *     policy denies it (rule: default-deny).
 *
 * "A change of input" was therefore the correct diagnosis and an incomplete
 * one: the input had to become available before it could be changed. A
 * `RelayTarget` had exactly one host, which was simultaneously the thing dialled
 * and the thing judged, and D9 is precisely the case where those stop being the
 * same string. So the target now carries both, and this file pins that they
 * stay distinct.
 *
 * ## Why the third clause is the one that matters
 *
 * The first two clauses — a name in `allow` admits, removing it refuses — pass
 * against a policy that matches EITHER the name or the literal. That policy
 * would be strictly more permissive than the one §6.7 describes, and the
 * operator's authorization would silently stop meaning what the SRD says it
 * means: not "I authorized this name" but "I authorized this name or whatever
 * it happens to point at". The third clause — an `allow` naming ONLY the
 * resolved literal does NOT admit the relay — is what bounds the cost D9
 * accepts to the one sentence §6.7 wrote down.
 *
 * It is also the clause that would decay silently. A future "be helpful, accept
 * the address too" edit breaks nothing else in this suite.
 */

import { describe, expect, test } from "bun:test";
import { assertTargetsAllowed, relayGatePolicy, type RelayTarget } from "../../src/security/relay.ts";

/**
 * The vendor name an operator writes in `egress.allow`, and the address §3.1
 * measured behind it. The literal is a fixture, not a pin: nothing here
 * resolves anything, which is the point — this file tests the POLICY seam, and
 * the resolution that produces the literal is ISC-426's.
 */
const VENDOR_NAME = "ollama.com";
const RESOLVED_LITERAL = "34.36.183.157";
const PORT = 443;

function configWithAllow(allow: ReadonlyArray<{ host: string; port: number }>) {
  return {
    llm: { base_url: `https://ollama.pifleet.internal:${PORT}`, relay_upstream: null },
    egress: { google_hosts: [] as readonly string[], allow },
  };
}

/**
 * The target shape D9 produces: dialled at the resolved ADDRESS, judged against
 * the authorized NAME.
 *
 * Built here as a literal rather than through `providerRelayTarget`, and
 * deliberately: the resolution mechanism is ISC-426's and lands separately.
 * This file is a statement about the POLICY's contract with that shape, so it
 * builds the shape directly and stays green whichever way the producer is
 * written — which is what lets the two halves be integrated independently
 * instead of one blocking the other.
 */
const d9Target: RelayTarget = {
  listenPort: PORT,
  host: RESOLVED_LITERAL,
  port: PORT,
  name: "ollama",
  policyHost: VENDOR_NAME,
};

describe("the operator authorizes the NAME while the relay dials the ADDRESS (ISC-428)", () => {
  test("a name in egress.allow ADMITS a relay whose target is the resolved literal", () => {
    const policy = relayGatePolicy(configWithAllow([{ host: VENDOR_NAME, port: PORT }]));
    expect(() => assertTargetsAllowed([d9Target], policy)).not.toThrow();
  });

  test("removing the name from egress.allow REFUSES it", () => {
    const policy = relayGatePolicy(configWithAllow([]));
    expect(() => assertTargetsAllowed([d9Target], policy)).toThrow(/refusing to forward/);
    expect(() => assertTargetsAllowed([d9Target], policy)).toThrow(/egress policy denies/);
  });

  /**
   * THE BOUNDING CLAUSE. An `allow` naming only the address does NOT admit the
   * relay, because the address is not what the operator authorized.
   *
   * This is the assertion that keeps D9's stated cost — "the operator
   * authorized this name, and the fleet recorded what it resolved to" — from
   * quietly becoming "the operator authorized either form". Note the literal
   * here is the very address the target dials: the ONLY reason this is refused
   * is that the policy comparison reads the name.
   */
  test("an egress.allow naming ONLY the resolved literal does NOT admit it", () => {
    const policy = relayGatePolicy(configWithAllow([{ host: RESOLVED_LITERAL, port: PORT }]));
    expect(() => assertTargetsAllowed([d9Target], policy)).toThrow(/refusing to forward/);
  });

  /**
   * The refusal has to name the thing that was JUDGED, or it sends the operator
   * to the wrong edit.
   *
   * Without this, the message reads "refusing to forward ollama ->
   * 34.36.183.157:443", the operator adds `{host: 34.36.183.157}` to
   * `egress.allow` — the address the message just showed them — and the fleet
   * refuses again with the identical text, because the clause above says that
   * entry can never match. A dead-end diagnostic on the one path a fleet cannot
   * start without.
   */
  test("the refusal names the AUTHORIZED NAME, not just the dialled address", () => {
    const policy = relayGatePolicy(configWithAllow([{ host: RESOLVED_LITERAL, port: PORT }]));
    expect(() => assertTargetsAllowed([d9Target], policy)).toThrow(new RegExp(VENDOR_NAME));
  });

  /**
   * A target with no `policyHost` is judged on its dial host, exactly as every
   * pre-D9 target always was.
   *
   * The non-hosted path is the DEFAULT path, and ISC-427 makes it the only one
   * an operator's own oMLX can be on. If adding the D9 field had changed how a
   * literal-only target is judged, D9 would have weakened the property on
   * blocks it was explicitly scoped away from — which is the failure §6.7's
   * scoping paragraph exists to prevent.
   */
  test("a target with no policyHost is still judged on its dial host", () => {
    const plain: RelayTarget = {
      listenPort: 8000,
      host: "192.168.86.49",
      port: 8000,
      name: "omlx",
    };
    const allowed = relayGatePolicy(configWithAllow([{ host: "192.168.86.49", port: 8000 }]));
    expect(() => assertTargetsAllowed([plain], allowed)).not.toThrow();

    const denied = relayGatePolicy(configWithAllow([{ host: VENDOR_NAME, port: 8000 }]));
    expect(() => assertTargetsAllowed([plain], denied)).toThrow(/refusing to forward/);
  });
});
