/**
 * Egress policy matcher (SRD §5.9, §12.4; ISC-57) — exhaustive, daemon-free.
 *
 * The unit suite carries the correctness weight for the policy: the
 * integration suite proves the NETWORK denies, but only these tests prove the
 * MATCHER does — and the matcher is where an allowlist quietly becomes a
 * suggestion. Every "attack" case here (label-boundary spoofs, homoglyphs,
 * trailing dots, IP-vs-wildcard) is asserted as an explicit denial, not left
 * to the default expectation of a helper.
 */

import { describe, expect, test } from "bun:test";
import { EgressSchema } from "../../src/config/schema.ts";
import { EgressDecisionSchema, type EgressDecision } from "../../src/contracts.ts";
import {
  decide,
  makeRule,
  normalizeHost,
  policyFromConfig,
  ruleHostError,
  RULE_DEFAULT_DENY,
  RULE_INVALID_HOST,
  RULE_INVALID_PORT,
  type EgressPolicy,
  decisionForRecord,
} from "../../src/security/egress.ts";
import {
  assertNetworkName,
  networkCreateArgv,
  networkInspectArgv,
  parseNetworkInspect,
} from "../../src/security/network.ts";

/** The default-shaped policy: oMLX from config + the Google endpoints on 443. */
function defaultPolicy(baseUrl = "http://host.docker.internal:8000/v1"): EgressPolicy {
  return policyFromConfig({
    llm: { base_url: baseUrl },
    egress: {
      google_hosts: ["oauth2.googleapis.com", "*.googleapis.com", "accounts.google.com"],
      allow: [],
    },
  });
}

/**
 * Every decision with a representable port must round-trip the contracts.ts
 * seam — a decision the schema refuses cannot cross a process boundary, and
 * finding that out in production is finding it out in a ledger write.
 */
function check(host: string, port: number, policy: EgressPolicy): EgressDecision {
  const d = decide(host, port, policy);
  EgressDecisionSchema.parse(d);
  return d;
}

describe("decide: deny-all default", () => {
  const p = defaultPolicy();

  test("an unlisted destination is denied and the denial names default-deny", () => {
    const d = check("example.com", 443, p);
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_DEFAULT_DENY);
  });

  test("an empty policy denies everything, including the oMLX host", () => {
    const d = check("host.docker.internal", 8000, { rules: [] });
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_DEFAULT_DENY);
  });

  test("the denial record carries the asked host and port", () => {
    const d = check("evil.test", 9999, p);
    expect(d.host).toBe("evil.test");
    expect(d.port).toBe(9999);
  });
});

describe("decide: the oMLX rule comes from config, not from a constant", () => {
  test("default base_url allows host.docker.internal:8000", () => {
    const d = check("host.docker.internal", 8000, defaultPolicy());
    expect(d.allowed).toBe(true);
    expect(d.rule).toBe("llm");
  });

  test("a reconfigured base_url moves the allow WITH the config", () => {
    // The hardcode failure: fleet moves its model server, policy still allows
    // only the old host, every worker silently loses its LLM (§5.9).
    const p = defaultPolicy("http://10.0.0.5:9000/v1");
    expect(check("10.0.0.5", 9000, p).allowed).toBe(true);
    const stale = check("host.docker.internal", 8000, p);
    expect(stale.allowed).toBe(false);
    expect(stale.rule).toBe(RULE_DEFAULT_DENY);
  });

  test("a base_url without an explicit port derives it from the scheme", () => {
    expect(check("llm.internal.example", 443, defaultPolicy("https://llm.internal.example/v1")).allowed).toBe(true);
    expect(check("llm.internal.example", 80, defaultPolicy("http://llm.internal.example/v1")).allowed).toBe(true);
  });

  test("an unparseable base_url throws instead of emitting a policy missing its LLM rule", () => {
    expect(() => defaultPolicy("not a url")).toThrow(/base_url/);
  });
});

describe("decide: label boundary — the headline requirement", () => {
  const p = defaultPolicy();

  test("*.googleapis.com matches a real subdomain", () => {
    const d = check("storage.googleapis.com", 443, p);
    expect(d.allowed).toBe(true);
    expect(d.rule).toBe("google:*.googleapis.com");
  });

  test("*.googleapis.com matches a deep subdomain", () => {
    expect(check("a.b.googleapis.com", 443, p).allowed).toBe(true);
  });

  test("evil-googleapis.com is DENIED — a suffix match is not a label match", () => {
    const d = check("evil-googleapis.com", 443, p);
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_DEFAULT_DENY);
  });

  test("googleapis.com.evil.test is DENIED — our name inside their zone", () => {
    const d = check("googleapis.com.evil.test", 443, p);
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_DEFAULT_DENY);
  });

  test("the bare apex googleapis.com is DENIED — the wildcard covers subdomains only", () => {
    // The needed apex hosts (oauth2, accounts) are listed exactly; widening the
    // wildcard to the apex would be a silent policy change, not a convenience.
    expect(check("googleapis.com", 443, p).allowed).toBe(false);
  });

  test("xgoogleapis.com is DENIED — one character is all a boundary bug needs", () => {
    expect(check("xgoogleapis.com", 443, p).allowed).toBe(false);
  });

  test("empty labels are DENIED — '..googleapis.com' must not ride the wildcard", () => {
    // The URL host grammar allows empty labels, DNS does not; without the
    // explicit refusal this satisfies endsWith(".googleapis.com") AND the
    // length check, with an empty leftmost label.
    for (const bad of ["..googleapis.com", ".googleapis.com", "a..googleapis.com"]) {
      const d = check(bad, 443, p);
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe(RULE_INVALID_HOST);
    }
  });

  test("exact rules match exactly", () => {
    expect(check("oauth2.googleapis.com", 443, p).rule).toBe("google:oauth2.googleapis.com");
    expect(check("accounts.google.com", 443, p).allowed).toBe(true);
    expect(check("accounts.google.com.evil.test", 443, p).allowed).toBe(false);
  });
});

describe("decide: normalization", () => {
  const p = defaultPolicy();

  test("hostnames are case-insensitive on both sides", () => {
    expect(check("OAUTH2.GoogleAPIs.COM", 443, p).allowed).toBe(true);
    const viaRule = decide("api.example.com", 443, { rules: [makeRule("r", "API.Example.COM", 443)] });
    expect(viaRule.allowed).toBe(true);
  });

  test("a single trailing dot is the DNS root label, not a different host", () => {
    expect(check("oauth2.googleapis.com.", 443, p).allowed).toBe(true);
    expect(check("storage.googleapis.com.", 443, p).allowed).toBe(true);
  });

  test("doubled trailing dots are not a host", () => {
    const d = check("oauth2.googleapis.com..", 443, p);
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_INVALID_HOST);
  });

  test("IDN input compares in punycode: münchen.example meets its A-label rule", () => {
    const rules = { rules: [makeRule("idn", "xn--mnchen-3ya.example", 443)] };
    expect(decide("münchen.example", 443, rules).allowed).toBe(true);
    expect(decide("MÜNCHEN.example", 443, rules).allowed).toBe(true);
  });

  test("a homoglyph of an allowed apex is DENIED — Cyrillic о is not Latin o", () => {
    // "googleapis.cоm" (Cyrillic о in the TLD) punycodes to a different ascii
    // name entirely; comparing U-labels raw would have let it through.
    const d = check("googleapis.cоm", 443, p);
    expect(d.allowed).toBe(false);
  });

  test("things that are not hosts are refused as invalid-host, not defaulted", () => {
    for (const bad of ["", ".", "http://evil.com", "evil.com:443", "evil .com", "a..b"]) {
      const d = check(bad, 443, p);
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe(RULE_INVALID_HOST);
    }
  });

  test("an absurdly long host is refused before any work is done", () => {
    const d = check(`${"a".repeat(5000)}.com`, 443, p);
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe(RULE_INVALID_HOST);
  });
});

describe("decide: IP literals", () => {
  test("an exact IPv4 rule matches", () => {
    const p: EgressPolicy = { rules: [makeRule("vm", "192.168.5.2", 8000)] };
    expect(decide("192.168.5.2", 8000, p).allowed).toBe(true);
    expect(decide("192.168.5.3", 8000, p).allowed).toBe(false);
  });

  test("a wildcard NEVER matches an IP literal, even when the text ends right", () => {
    // "*.5.2" is a legal-looking pattern and "192.168.5.2" ends with ".5.2" as
    // text — but an IP is not a name in anyone's zone, and matching it would
    // hand out address space by string accident.
    const p: EgressPolicy = { rules: [makeRule("w", "*.5.2", 8000)] };
    expect(decide("192.168.5.2", 8000, p).allowed).toBe(false);
    expect(decide("192.168.5.2", 8000, p).rule).toBe(RULE_DEFAULT_DENY);
  });

  test("IPv6 literals match textually, brackets and case stripped", () => {
    const p: EgressPolicy = { rules: [makeRule("v6", "::1", 8000)] };
    expect(decide("[::1]", 8000, p).allowed).toBe(true);
    expect(decide("::1", 8000, p).allowed).toBe(true);
    expect(decide("[::FFFF:1]", 8000, p).allowed).toBe(false);
  });

  test("IPv6 hex case is normalized — the one place toLowerCase is load-bearing", () => {
    // domainToASCII lowercases DOMAINS on its own; IP literals bypass it, so
    // without the explicit lowercase an uppercase-hex spelling of an allowed
    // address would be silently denied — a fail-closed bug, but still a bug.
    const p: EgressPolicy = { rules: [makeRule("v6", "::ffff:1", 8000)] };
    expect(decide("[::FFFF:1]", 8000, p).allowed).toBe(true);
  });

  test("a non-canonical IPv6 spelling fails CLOSED against a canonical rule", () => {
    // Documented shortcut: no numeric canonicalization. The miss is a denial,
    // never an allow, so the failure mode is an operator writing the rule in
    // canonical form — not a bypass.
    const p: EgressPolicy = { rules: [makeRule("v6", "::1", 8000)] };
    expect(decide("0:0:0:0:0:0:0:1", 8000, p).allowed).toBe(false);
  });
});

describe("decide: the port is part of the rule", () => {
  const p = defaultPolicy();

  test("the oMLX host on any other port is denied", () => {
    expect(check("host.docker.internal", 8001, p).allowed).toBe(false);
    expect(check("host.docker.internal", 443, p).allowed).toBe(false);
  });

  test("an allowed Google host off 443 is denied", () => {
    expect(check("oauth2.googleapis.com", 80, p).allowed).toBe(false);
    expect(check("storage.googleapis.com", 8443, p).allowed).toBe(false);
  });

  test("nonsense ports are refused as invalid-port", () => {
    // Not `check`: a denial for port 0 cannot round-trip the schema's
    // positive-int bound by design — it is for logging, never for envelopes.
    for (const bad of [0, -1, 1.5, 65536, Number.NaN]) {
      const d = decide("oauth2.googleapis.com", bad, p);
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe(RULE_INVALID_PORT);
    }
  });
});

describe("policy construction", () => {
  test("extra config rules are admitted under a config: name", () => {
    const p = policyFromConfig({
      llm: { base_url: "http://host.docker.internal:8000/v1" },
      egress: { google_hosts: [], allow: [{ host: "pypi.org", port: 443 }] },
    });
    const d = decide("pypi.org", 443, p);
    expect(d.allowed).toBe(true);
    expect(d.rule).toBe("config:pypi.org:443");
    expect(decide("oauth2.googleapis.com", 443, p).allowed).toBe(false);
  });

  test("rule patterns the matcher cannot match are refused at construction", () => {
    expect(() => makeRule("r", "*", 443)).toThrow(/deny-all/);
    expect(() => makeRule("r", "*.", 443)).toThrow(/deny-all/);
    expect(() => makeRule("r", "a.*.b.com", 443)).toThrow(/leading/);
    expect(() => makeRule("r", "*.com", 443)).toThrow(/TLD/);
    expect(() => makeRule("r", "*.192.168.5.2", 443)).toThrow(/IP literal/);
    expect(() => makeRule("r", "not a host", 443)).toThrow(/not a valid/);
    expect(() => makeRule("r", "ok.example.com", 0)).toThrow(/port/);
  });

  test("refusal rule names are reserved and cannot label an allow", () => {
    expect(() => makeRule(RULE_DEFAULT_DENY, "ok.example.com", 443)).toThrow(/reserved/);
    expect(() => makeRule(RULE_INVALID_HOST, "ok.example.com", 443)).toThrow(/reserved/);
    expect(() => makeRule(RULE_INVALID_PORT, "ok.example.com", 443)).toThrow(/reserved/);
  });

  test("rule hosts are normalized at construction, so matching is one compare", () => {
    const r = makeRule("r", "API.Example.COM.", 443);
    expect(r.host).toBe("api.example.com");
    const w = makeRule("w", "*.Example.COM", 443);
    expect(w.host).toBe("*.example.com");
  });

  test("ruleHostError accepts what the matcher supports and nothing else", () => {
    expect(ruleHostError("oauth2.googleapis.com")).toBeNull();
    expect(ruleHostError("*.googleapis.com")).toBeNull();
    expect(ruleHostError("192.168.5.2")).toBeNull();
    expect(ruleHostError("*")).not.toBeNull();
    expect(ruleHostError("*.com")).not.toBeNull();
    expect(ruleHostError("http://x")).not.toBeNull();
  });
});

describe("normalizeHost", () => {
  test("normalizes case, root dot, brackets, and IDN", () => {
    expect(normalizeHost("EXAMPLE.com.")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("münchen.example")).toBe("xn--mnchen-3ya.example");
    expect(normalizeHost("192.168.5.2")).toBe("192.168.5.2");
  });

  test("returns null for non-hosts", () => {
    for (const bad of ["", ".", "..", "a b", "http://x", "x:80", `${"a".repeat(5000)}`]) {
      expect(normalizeHost(bad)).toBeNull();
    }
  });
});

describe("config egress section (schema wiring)", () => {
  test("defaults: the ADC/GKE Google endpoints, no extra rules", () => {
    const e = EgressSchema.parse({});
    expect(e.google_hosts).toEqual([
      "oauth2.googleapis.com",
      "*.googleapis.com",
      "accounts.google.com",
    ]);
    expect(e.allow).toEqual([]);
  });

  test("the parsed defaults feed policyFromConfig end-to-end", () => {
    const p = policyFromConfig({
      llm: { base_url: "http://host.docker.internal:8000/v1" },
      egress: EgressSchema.parse({}),
    });
    expect(decide("storage.googleapis.com", 443, p).allowed).toBe(true);
    expect(decide("host.docker.internal", 8000, p).allowed).toBe(true);
    expect(decide("example.com", 443, p).allowed).toBe(false);
  });

  test("a dead allow rule is a loud field-level error, not a silent no-match", () => {
    const r = EgressSchema.safeParse({ allow: [{ host: "*", port: 443 }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues[0]!;
      expect(issue.path).toEqual(["allow", 0, "host"]);
      expect(issue.message).toContain("deny-all");
    }
  });

  test("google_hosts entries are validated with the same predicate", () => {
    expect(EgressSchema.safeParse({ google_hosts: ["*.com"] }).success).toBe(false);
    expect(EgressSchema.safeParse({ google_hosts: ["*.googleapis.com"] }).success).toBe(true);
  });

  test("ports outside 1..65535 and unknown keys are refused", () => {
    expect(EgressSchema.safeParse({ allow: [{ host: "pypi.org", port: 0 }] }).success).toBe(false);
    expect(EgressSchema.safeParse({ allow: [{ host: "pypi.org", port: 70000 }] }).success).toBe(false);
    expect(EgressSchema.safeParse({ allow: [{ host: "pypi.org", port: 443, x: 1 }] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// network.ts — the pure halves (argv builders + inspect parser). The daemon
// halves live in test/integration/egress.test.ts behind PIFLEET_DOCKER.
// ---------------------------------------------------------------------------

describe("network argv builders", () => {
  test("create argv carries --internal — the deny-all bit itself", () => {
    expect(networkCreateArgv("pifleet-egress")).toEqual([
      "network",
      "create",
      "--internal",
      "pifleet-egress",
    ]);
  });

  test("inspect argv is exact", () => {
    expect(networkInspectArgv("pifleet-egress")).toEqual(["network", "inspect", "pifleet-egress"]);
  });

  test("names that could parse as flags or shell are refused before argv", () => {
    for (const bad of ["", "-x", "--driver=host", "a b", "a;b", "$(x)", "a\nb"]) {
      expect(() => assertNetworkName(bad)).toThrow(/network name/);
    }
    expect(() => assertNetworkName("pifleet-egress")).not.toThrow();
    expect(() => assertNetworkName("net_1.test-x")).not.toThrow();
  });
});

describe("parseNetworkInspect", () => {
  const entry = (over: Record<string, unknown> = {}) =>
    JSON.stringify([{ Name: "pifleet-egress", Id: "abc123", Internal: true, ...over }]);

  test("reads exists + internal + id from a well-formed answer", () => {
    const s = parseNetworkInspect("pifleet-egress", entry());
    expect(s).toEqual({ name: "pifleet-egress", exists: true, internal: true, id: "abc123" });
  });

  test("a non-internal network reports internal: false — never assumed true", () => {
    expect(parseNetworkInspect("pifleet-egress", entry({ Internal: false })).internal).toBe(false);
  });

  test("a MISSING Internal field reads as not internal — refuse, don't reassure", () => {
    const s = JSON.stringify([{ Name: "pifleet-egress", Id: "abc123" }]);
    expect(parseNetworkInspect("pifleet-egress", s).internal).toBe(false);
  });

  test("an answer about a different network means absent, not adopted", () => {
    const s = JSON.stringify([{ Name: "other", Id: "x", Internal: true }]);
    expect(parseNetworkInspect("pifleet-egress", s).exists).toBe(false);
  });

  test("an empty array means absent", () => {
    expect(parseNetworkInspect("pifleet-egress", "[]").exists).toBe(false);
  });

  test("malformed output throws — it must not read as 'missing' and trigger a create", () => {
    expect(() => parseNetworkInspect("pifleet-egress", "not json")).toThrow(/unparseable/);
    expect(() => parseNetworkInspect("pifleet-egress", '{"Name":"x"}')).toThrow(/array/);
  });
});

/**
 * `decide` refuses invalid ports, and a refusal must be able to REPORT the
 * port it refused. That put its return value in conflict with its declared
 * type: `EgressDecision` is inferred from a schema requiring
 * `int().positive()`, so the refusal branch returned something the type said
 * was impossible and any caller parsing the result threw on precisely the
 * inputs the branch exists for.
 *
 * The types now say where each is legal. These tests pin both directions:
 * the refusal is representable, and the seam still rejects it.
 */
describe("a refusal reports the port as asked, and does not pass as a record", () => {
  const policy = defaultPolicy();

  test.each([0, -1, 1.5, NaN, 70000])("port %p is refused and reported verbatim", (port) => {
    const v = decide("storage.googleapis.com", port, policy);
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe(RULE_INVALID_PORT);
    // Verbatim: substituting a placeholder would hide what was actually asked.
    expect(Object.is(v.port, port)).toBe(true);
  });

  test.each([0, -1, 1.5, NaN])("an invalid-port refusal cannot become a record", (port) => {
    const v = decide("storage.googleapis.com", port, policy);
    expect(EgressDecisionSchema.safeParse(v).success).toBe(false);
    // null rather than a thrown error or an invented port: there is nothing
    // schema-valid for this verdict to become.
    expect(decisionForRecord(v)).toBeNull();
  });

  test("an allowed verdict does round-trip through the schema", () => {
    const v = decide("storage.googleapis.com", 443, policy);
    expect(v.allowed).toBe(true);
    const rec: EgressDecision | null = decisionForRecord(v);
    expect(rec).not.toBeNull();
    expect(rec!.port).toBe(443);
  });

  /**
   * 70000 is in range for the schema (a positive int) but not a TCP port, so
   * it is the one refusal that CAN round-trip — worth pinning, because it is
   * the case that makes "refused" and "unrecordable" visibly different
   * properties rather than synonyms.
   */
  test("an out-of-range but positive-int port is refused yet still recordable", () => {
    const v = decide("storage.googleapis.com", 70000, policy);
    expect(v.allowed).toBe(false);
    expect(decisionForRecord(v)).not.toBeNull();
  });
});
