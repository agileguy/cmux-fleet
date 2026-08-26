#!/usr/bin/env node
"use strict";
/**
 * The egress matcher — ONE implementation, two runtimes (ISC-263).
 *
 * This file exists in plain CommonJS rather than in `src/security/egress.ts`
 * for a reason that is structural, not stylistic. The CONNECT proxy
 * (`docker/connect-proxy.cjs`) has to decide, INSIDE the container, whether an
 * arbitrary destination a worker asked for is allowed — that is what makes it
 * a proxy rather than a port forwarder. It runs on the pinned upstream Node
 * image (`src/security/pinned-image.ts`), which deliberately has no `bun` and
 * must not depend on `pifleet image build` having run, so it cannot import the
 * TypeScript module.
 *
 * The alternative was a second copy of the matcher in the container. That is
 * exactly the wrong thing to duplicate: the headline correctness requirement
 * here is the LABEL BOUNDARY — `*.googleapis.com` must match
 * `storage.googleapis.com` and must NOT match `evil-googleapis.com` or
 * `googleapis.com.evil.test` — and two copies of a boundary check drift in the
 * direction of the one nobody re-reads. `src/security/egress.ts` now imports
 * this file and re-exports it with types, so the host-side policy and the
 * in-container proxy are not merely consistent, they are the same code.
 *
 * Dependency-free and node-builtin-only, so it can be bind-mounted read-only
 * into the relay container beside the proxy that requires it.
 *
 * The reasoning behind each normalization step and each match rule lives in
 * `src/security/egress.ts`'s header, which is still the module a reader should
 * start from.
 */

const { isIP } = require("node:net");
const { domainToASCII } = require("node:url");

/**
 * Mirrors `MAX_SHORT` in `src/contracts.ts`. Duplicated as a NUMBER because
 * this file cannot import the schema, and pinned by a unit test that asserts
 * the two are equal — a bound that silently diverged would let a host far
 * longer than any decision record can carry reach the matcher.
 */
const MAX_SHORT = 4096;

/** Rule names reserved for refusals; no allow rule may ever carry them. */
const RULE_DEFAULT_DENY = "default-deny";
const RULE_INVALID_HOST = "invalid-host";
const RULE_INVALID_PORT = "invalid-port";

/** True for a TCP port a rule or a decision may legitimately carry. */
function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Normalize a hostname for comparison; null means "not a host".
 *
 * Steps, and the spoof each one closes: lowercase (DNS is case-insensitive);
 * strip `[...]` (URL bracket syntax around an IPv6 literal); strip ONE
 * trailing dot (the DNS root label); IDN to punycode (so a homoglyph of an
 * allowed apex cannot compare equal to it).
 */
function normalizeHost(raw) {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_SHORT) return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) {
    h = h.slice(0, -1);
    // "." and "a.." are not hosts; only a SINGLE root-label dot is grammar.
    if (h === "" || h.endsWith(".")) return null;
  }
  if (h === "") return null;
  if (isIP(h) !== 0) return h;
  // Rejects embedded schemes, ports, paths, spaces, and anything else the URL
  // host grammar forbids — `evil.com:443` and `http://evil.com` are not hosts.
  const ascii = domainToASCII(h);
  if (ascii === "") return null;
  // The URL host grammar PERMITS empty labels; DNS does not. Refusing them is
  // load-bearing: `..googleapis.com` ends with `.googleapis.com` and is longer
  // than the suffix, so it would satisfy the wildcard's boundary check with an
  // EMPTY leftmost label.
  if (ascii.split(".").some((label) => label === "")) return null;
  return ascii;
}

/** Why `host` cannot be an allow-rule pattern, or null when it can. */
function ruleHostError(host) {
  if (host === "*" || host === "*.") {
    return "a bare wildcard would allow every destination — the policy is deny-all; list hosts explicitly";
  }
  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    if (suffix.includes("*")) return "only a single leading '*.' wildcard is supported";
    const norm = normalizeHost(suffix);
    if (norm === null) return `wildcard suffix ${JSON.stringify(suffix)} is not a valid hostname`;
    if (isIP(norm) !== 0) return "a wildcard cannot have an IP literal as its suffix";
    if (!norm.includes(".")) {
      return `wildcard suffix ${JSON.stringify(suffix)} is a single label — that allowlists a whole TLD`;
    }
    return null;
  }
  if (host.includes("*")) return "wildcards are only supported as a leading '*.'";
  return normalizeHost(host) === null
    ? `${JSON.stringify(host)} is not a valid hostname or IP literal`
    : null;
}

/** Build one rule, normalizing the host — the only constructor. */
function makeRule(name, host, port) {
  const err = ruleHostError(host);
  if (err !== null) throw new Error(`egress rule ${JSON.stringify(name)}: ${err}`);
  if (!validPort(port)) throw new Error(`egress rule ${JSON.stringify(name)}: invalid port ${port}`);
  if (name === RULE_DEFAULT_DENY || name === RULE_INVALID_HOST || name === RULE_INVALID_PORT) {
    // An allow rule named `default-deny` would make every diagnosis a lie.
    throw new Error(`egress rule name ${JSON.stringify(name)} is reserved for refusals`);
  }
  if (host.startsWith("*.")) {
    return { name, host: `*.${normalizeHost(host.slice(2))}`, port };
  }
  return { name, host: normalizeHost(host), port };
}

/**
 * Does a normalized host satisfy a rule host?
 *
 * For `*.suffix`: the candidate must END WITH `.suffix` — dot included. The
 * dot IS the label boundary. `host.endsWith(suffix)` alone admits
 * `evil-googleapis.com`, and `includes` admits `googleapis.com.evil.test`;
 * both were the attack, not an edge case. A wildcard never matches an IP
 * literal: `192.168.5.2` ends with `.5.2` as text, but an IP is not a name.
 */
function hostMatches(host, ruleHost) {
  if (ruleHost.startsWith("*.")) {
    if (isIP(host) !== 0) return false;
    const suffix = ruleHost.slice(2);
    return host.length > suffix.length + 1 && host.endsWith(`.${suffix}`);
  }
  return host === ruleHost;
}

/**
 * The decision function — pure, total, and Docker-free.
 *
 * Never throws: hosts and ports arrive from whatever parses proxy traffic, and
 * an exception escaping a proxy's accept loop converts hostile input into a
 * denial of service for every worker. Anything unparseable is DENIED with a
 * named reason instead.
 */
function decide(host, port, policy) {
  const asAsked = typeof host === "string" ? host.slice(0, MAX_SHORT) : "";
  if (!validPort(port)) {
    return { allowed: false, host: asAsked, port, rule: RULE_INVALID_PORT };
  }
  const norm = normalizeHost(host);
  if (norm === null) {
    return { allowed: false, host: asAsked, port, rule: RULE_INVALID_HOST };
  }
  for (const r of policy.rules) {
    if (r.port === port && hostMatches(norm, r.host)) {
      return { allowed: true, host: norm, port, rule: r.name };
    }
  }
  return { allowed: false, host: norm, port, rule: RULE_DEFAULT_DENY };
}

module.exports = {
  MAX_SHORT,
  RULE_DEFAULT_DENY,
  RULE_INVALID_HOST,
  RULE_INVALID_PORT,
  validPort,
  normalizeHost,
  ruleHostError,
  makeRule,
  hostMatches,
  decide,
};
