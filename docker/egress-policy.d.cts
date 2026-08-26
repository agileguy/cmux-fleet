/**
 * Types for `egress-policy.cjs`, whose implementation is plain CommonJS so the
 * in-container CONNECT proxy and the host-side TypeScript can share ONE
 * matcher (ISC-263). See that file's header for why it is not a `.ts`.
 */
export interface EgressRule {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}
export interface EgressPolicy {
  readonly rules: readonly EgressRule[];
}
export interface EgressVerdict {
  readonly allowed: boolean;
  readonly host: string;
  readonly port: number;
  readonly rule: string;
}
export declare const MAX_SHORT: number;
export declare const RULE_DEFAULT_DENY: string;
export declare const RULE_INVALID_HOST: string;
export declare const RULE_INVALID_PORT: string;
export declare function validPort(port: number): boolean;
export declare function normalizeHost(raw: string): string | null;
export declare function ruleHostError(host: string): string | null;
export declare function makeRule(name: string, host: string, port: number): EgressRule;
export declare function hostMatches(host: string, ruleHost: string): boolean;
export declare function decide(host: string, port: number, policy: EgressPolicy): EgressVerdict;
