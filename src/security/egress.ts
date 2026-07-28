/**
 * Egress policy — the pure core of the deny-all bridge (SRD §5.9, §12.4; ISC-57).
 *
 * Workers sit on an internal Docker network (`src/security/network.ts`), so the
 * DEFAULT is that no destination is reachable at all. Whatever relays traffic
 * off that bridge consults `decide` per destination, and `decide` says yes only
 * to an explicit rule. The two halves are deliberately separate: matching is
 * pure string/number work that must be exhaustively testable without a daemon,
 * because a policy that can only be tested end-to-end is a policy nobody
 * re-tests after an edit — and an egress policy that fails open is worse than
 * none, since it reports a containment it does not provide.
 *
 * The headline correctness requirement is the LABEL BOUNDARY. `*.googleapis.com`
 * must match `storage.googleapis.com` and must NOT match `evil-googleapis.com`
 * (a bare suffix string-match) or `googleapis.com.evil.test` (an attacker
 * spelling our name inside their own domain). This is the same bug class as
 * prefix-matching a filesystem path — see `resolvedWithin` in
 * `src/harvest/outbox.ts` — and it is the difference between an allowlist and
 * a suggestion.
 */

import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { EgressDecisionSchema, MAX_SHORT, type EgressDecision } from "../contracts.ts";

/**
 * What `decide` returns: an `EgressDecision` widened at `port`.
 *
 * `EgressDecision` is inferred from `EgressDecisionSchema`, whose `port` is
 * `int().positive()` — correct for anything crossing the contracts seam, and
 * wrong as a return type for the function whose job includes REFUSING ports
 * that are none of those things. A refusal must be able to report the port as
 * asked, including `0`, `-1`, `1.5` and `NaN`.
 *
 * Kept as a distinct type rather than loosening the schema: a verdict that
 * reaches an envelope or a ledger still has to satisfy the positive-int bound,
 * and `EgressDecisionSchema.parse` is what enforces it at that boundary. The
 * two types encode where each is legal, so the compiler carries the rule
 * instead of a comment asking callers to remember it.
 */
export interface EgressVerdict {
  readonly allowed: boolean;
  readonly host: string;
  /** As asked. May violate `EgressDecisionSchema` — that IS the refusal case. */
  readonly port: number;
  readonly rule: string;
}

/**
 * Narrow a verdict to a schema-valid decision, or `null` when it cannot be.
 *
 * The `null` is deliberate and is not an error path: a verdict refused for an
 * invalid port has nothing schema-valid to become, and forcing one would mean
 * inventing a port the caller never asked for.
 */
export function decisionForRecord(v: EgressVerdict): EgressDecision | null {
  const parsed = EgressDecisionSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/** Rule names reserved for refusals; no allow rule may ever carry them. */
export const RULE_DEFAULT_DENY = "default-deny";
export const RULE_INVALID_HOST = "invalid-host";
export const RULE_INVALID_PORT = "invalid-port";

/**
 * One allow rule. `host` is stored NORMALIZED (see `normalizeHost`) so that
 * matching is a plain comparison — normalizing at decision time on one side
 * only is how `OAUTH2.googleapis.com.` sails past a policy that lists the
 * lowercase form.
 */
export interface EgressRule {
  /** Carried into every decision this rule makes, so a verdict is diagnosable. */
  readonly name: string;
  /** Exact host, IP literal, or `*.suffix` wildcard — normalized. */
  readonly host: string;
  readonly port: number;
}

export interface EgressPolicy {
  readonly rules: readonly EgressRule[];
}

/** True for a TCP port a rule or a decision may legitimately carry. */
function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Normalize a hostname for comparison; null means "not a host".
 *
 * Steps, and the spoof each one closes:
 *  - lowercase          — DNS is case-insensitive; `GoogleAPIs.com` is googleapis.com.
 *  - strip `[...]`      — URL bracket syntax around an IPv6 literal, not address text.
 *  - strip ONE trailing dot — the DNS root label; `example.com.` IS `example.com`,
 *    and a resolver treats them identically even when a string compare does not.
 *  - IDN → punycode     — `münchen.example` and `xn--mnchen-3ya.example` are the
 *    same zone; comparing U-labels on one side and A-labels on the other lets a
 *    homoglyph of an allowed apex through (`googleapis.cоm` with a Cyrillic о
 *    punycodes to a DIFFERENT ascii name and must not compare equal).
 *
 * IP literals are returned textually (lowercased) and never punycoded. IPv6
 * text is NOT numerically canonicalized — `0:0:0:0:0:0:0:1` will not match a
 * rule written `::1`. That failure is closed (a denial), so the shortcut is
 * safe; rules must be written in canonical form.
 */
export function normalizeHost(raw: string): string | null {
  // Bound before any work: the decision record is schema-bounded to MAX_SHORT
  // (contracts.ts) and no real hostname approaches 4 KiB — DNS caps at 253.
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
  // EMPTY leftmost label — a name no zone can contain but a naive relay might
  // still act on.
  if (ascii.split(".").some((label) => label === "")) return null;
  return ascii;
}

/**
 * Why `host` cannot be an allow-rule pattern, or null when it can.
 *
 * Shared with the config schema so a bad rule is a loud, field-level `config
 * validate` error instead of a rule that silently never matches — a dead allow
 * rule denies a legitimate destination, which trains operators to widen the
 * policy until it means nothing.
 */
export function ruleHostError(host: string): string | null {
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
      // `*.com` / `*.internal` allowlists an entire TLD, which is never one
      // destination. If a whole private zone is genuinely needed, list hosts.
      return `wildcard suffix ${JSON.stringify(suffix)} is a single label — that allowlists a whole TLD`;
    }
    return null;
  }
  if (host.includes("*")) return "wildcards are only supported as a leading '*.'";
  return normalizeHost(host) === null ? `${JSON.stringify(host)} is not a valid hostname or IP literal` : null;
}

/**
 * Build one rule, normalizing the host — the only constructor. Throws on a
 * pattern `ruleHostError` refuses: a policy silently built around a dead rule
 * would deny the very destination it was written to allow.
 */
export function makeRule(name: string, host: string, port: number): EgressRule {
  const err = ruleHostError(host);
  if (err !== null) throw new Error(`egress rule ${JSON.stringify(name)}: ${err}`);
  if (!validPort(port)) throw new Error(`egress rule ${JSON.stringify(name)}: invalid port ${port}`);
  if (name === RULE_DEFAULT_DENY || name === RULE_INVALID_HOST || name === RULE_INVALID_PORT) {
    // An allow rule named `default-deny` would make every diagnosis a lie.
    throw new Error(`egress rule name ${JSON.stringify(name)} is reserved for refusals`);
  }
  if (host.startsWith("*.")) {
    return { name, host: `*.${normalizeHost(host.slice(2))!}`, port };
  }
  return { name, host: normalizeHost(host)!, port };
}

/**
 * Does a normalized host satisfy a rule host?
 *
 * For `*.suffix`: the candidate must END WITH `.suffix` — dot included. The
 * dot IS the label boundary. `host.endsWith(suffix)` alone admits
 * `evil-googleapis.com`, and checking `includes` admits
 * `googleapis.com.evil.test`; both were the attack, not an edge case.
 * A wildcard also never matches an IP literal: `192.168.5.2` ends with `.5.2`
 * as text, but an IP is not a name in anyone's zone.
 */
function hostMatches(host: string, ruleHost: string): boolean {
  if (ruleHost.startsWith("*.")) {
    if (isIP(host) !== 0) return false;
    const suffix = ruleHost.slice(2);
    return host.length > suffix.length + 1 && host.endsWith(`.${suffix}`);
  }
  return host === ruleHost;
}

/**
 * The decision function — pure, total, and Docker-free (task requirement 5).
 *
 * Never throws: hosts and ports arrive from whatever parses proxy traffic, and
 * an exception escaping a relay's accept loop converts hostile input into a
 * denial of service for every worker. Anything unparseable is DENIED with a
 * named reason instead.
 *
 * Port is part of every rule, not an afterthought: an allowed host on an
 * unexpected port is exactly how a permitted name becomes a tunnel.
 */
export function decide(host: string, port: number, policy: EgressPolicy): EgressVerdict {
  // Recorded host is always bounded so the decision can cross the contracts.ts
  // seam; the RAW prefix is kept for refusals so the log shows what was asked.
  const asAsked = host.slice(0, MAX_SHORT);
  if (!validPort(port)) {
    // The record carries the port AS ASKED — 0, -1, 1.5 and NaN all reach here
    // — which is why the return type is `EgressVerdict` and not
    // `EgressDecision`. `EgressDecision` is inferred from a schema requiring a
    // positive int, so declaring this function as returning one was a claim the
    // compiler could not check and this branch broke: any caller round-tripping
    // the result through `EgressDecisionSchema.parse` threw on exactly the
    // inputs the refusal exists to handle. Naming the wider type is the fix;
    // the previous version documented the unsoundness in a comment instead,
    // which left every caller to remember it.
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

// ---------------------------------------------------------------------------
// Policy from config (SRD §5.9, §12.4)
// ---------------------------------------------------------------------------

/**
 * The slice of `FleetConfig` the policy reads — structural, so this module
 * never imports the config schema and the schema may import `ruleHostError`
 * without a cycle.
 */
export interface EgressConfigView {
  llm: { base_url: string };
  egress: {
    google_hosts: readonly string[];
    allow: ReadonlyArray<{ host: string; port: number }>;
  };
}

/**
 * Derive the full allowlist from config. Three sources, nothing else:
 *
 *  1. The oMLX endpoint, parsed FROM `llm.base_url` — never hardcoded. A
 *     hardcoded `host.docker.internal:8000` means a fleet whose config moved
 *     the model server is silently denied its own LLM, and every worker then
 *     stalls with no tool calls (§5.9's exact quiet-failure shape).
 *  2. The Google endpoints ADC + GKE need, on 443 (§12.4) — configurable
 *     because ISC-57 says "the CONFIGURED Google endpoints".
 *  3. Explicit extra rules from `egress.allow`, already schema-validated.
 *
 * Throws on an unparseable `base_url` rather than emitting a policy with no
 * LLM rule: config validation bounds this already, and a policy that quietly
 * lost its most important rule should not exist at all.
 */
export function policyFromConfig(cfg: EgressConfigView): EgressPolicy {
  let url: URL;
  try {
    url = new URL(cfg.llm.base_url);
  } catch {
    throw new Error(`egress: llm.base_url is not a URL: ${JSON.stringify(cfg.llm.base_url)}`);
  }
  const llmPort = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const rules: EgressRule[] = [makeRule("llm", url.hostname, llmPort)];
  for (const h of cfg.egress.google_hosts) {
    rules.push(makeRule(`google:${h}`, h, 443));
  }
  for (const r of cfg.egress.allow) {
    rules.push(makeRule(`config:${r.host}:${r.port}`, r.host, r.port));
  }
  return { rules };
}
