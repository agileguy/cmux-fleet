/**
 * The five producers a sweep needs — SRD-TRIAGE-CONSOLE §7.2, §7.4, §7.5, §12.6;
 * §13 task 6.1a.
 *
 * ## Why this module exists, and why it is not four lines in the command
 *
 * `SweepDriver` has nine members. Task 6.2 wired four of them from the run tree
 * and found that the other four had **no producer anywhere in `src/`** and were
 * assigned to no task in §13 — so `pifleet triage --once` refused by name rather
 * than sweeping nothing and reporting success. This module is those producers.
 *
 * §13 refused to let the envelope be written inline in the command and gave the
 * reason as the acceptance criterion: it *"carries its own §7.2/§12.6 security
 * contract — no credential, no host path, no raw command, and above all not 'the
 * contents of a previous worker's report as instruction' — which is a decision
 * §12's mirror anti-criterion forbids living in an untested CLI layer one level
 * down."*
 *
 * ## THE ANTI-CRITERION IS STRUCTURAL FIRST AND AUDITED SECOND
 *
 * §7.2 forbids four classes and §13 ranks one of them above the others, because
 * a cadence invites violating it: *"the obvious way to give a sweep continuity is
 * to paste the last sweep's prose into it."* Two mechanisms, in this order.
 *
 * **1. The projection, which makes the violation unrepresentable.**
 * {@link renderSweepEnvelope} takes the previous sweep's `triage.json` as a WHOLE
 * DOCUMENT and projects it itself — a caller cannot hand it prose because there
 * is no parameter that accepts any. {@link projectPreviousState} keeps exactly
 * two things per row: a service name **the host itself declared**, and an
 * `assessment` token from a closed four-member enum. The selector, the window
 * spelling, the evidence ledger, the coverage channel names and the
 * `unaccounted[]` list are worker-authored strings and none of them has anywhere
 * to sit.
 *
 * **2. The audit, which is the tripwire for the day somebody adds a field.**
 * {@link envelopeIssues} re-reads the rendered text against the very document it
 * was projected from and refuses any of its prose that survived, and
 * {@link renderSweepEnvelope} runs that audit on its own output and throws. A
 * structural guarantee that nothing checks is a guarantee that lasts until the
 * next edit; this is what makes that edit red.
 *
 * The other three classes are checked in the same pass and by the same shape — a
 * closed, exported set of names ({@link FORBIDDEN_ENVELOPE_CLASSES}), so a fifth
 * class or a quietly deleted fourth is an edit somebody makes on purpose. That is
 * `test/unit/monitor-readonly.test.ts:363-369`'s rule, which §12 asks this
 * console to inherit rather than rediscover.
 *
 * ## A NOTE ON WHAT THE `credential` REFUSAL PRINTS
 *
 * Nothing. `notifyEndpointIssue` (`triage-config.ts:223`) records the property
 * and it applies with more force here: this message reaches §7.7's append-only
 * log, *"which appends forever and is never truncated"*, and `--status` prints
 * from the same family of surfaces. A refusal that quoted the secret back would
 * publish the thing it refused.
 *
 * ## THE DISPATCH IS A PORT, AND THAT IS FORCED RATHER THAN CHOSEN
 *
 * §12 permits this console exactly ONE mutating exception — its dispatch path,
 * `run/dispatch-request.ts` — and the 2026-09-06 RULING says *"a second entry
 * would be the tell that this ruling was quietly reversed"*. The production
 * dispatch is `sendTaskEnvelope`, which lives in `cli/commands/dispatch.ts` and
 * requires a `LedgerWriter`; both are banned from this subtree by name in
 * `test/unit/triage-readonly.test.ts`. So {@link SweepDispatch} is an injected
 * effect, this module's own import closure reaches no mutating verb and no ledger
 * writer, and the question of who constructs the production effect is recorded
 * against §13 rather than answered by widening the allowlist.
 *
 * **{@link SweepDispatch} returns when the task has SETTLED, not when it was
 * accepted, and that is a contract this module depends on rather than a
 * preference.** §6.3 numbers dispatch and read as separate steps (2-3 and 8-9)
 * but gives `SweepDriver` no member between them, so `collate` must be able to
 * read the document the task it just dispatched wrote. Putting the wait behind
 * the port keeps it out of every fixture and keeps this module free of a clock —
 * `triage-pass.ts`'s own posture: *"It does not sleep, retry, or schedule."*
 */

import { readDispatchRequest, TRIAGE_CONSOLE_ROSTER } from "./dispatch-request.ts";
import { workerOutboxDir, type RunPaths } from "./paths.ts";
import { replyMountPath } from "./replies.ts";
import { childTaskId, collationTaskId, TRIAGE_CONSOLE_ASPECTS } from "./task-ids.ts";
import { TRIAGE_COLLATOR } from "./triage-actor.ts";
import {
  parseTriageDocument,
  type TriageDocumentContext,
  type TriageDocumentRead,
} from "./triage-document.ts";
import type { PartitionAssignment } from "./triage-partition.ts";
import type { SweepCollation, SweepJoin, SweepOpen } from "./triage-pass.ts";
import { TRIAGE_CHECKS, type TriageService } from "./triage-targets.ts";
import {
  COVERAGE_RESULTS,
  OBSERVER_ASSESSMENTS,
  type ObserverArtifact,
  type ObserverAssessment,
  type TriageDocument,
} from "./triage-verdict.ts";

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Names on disk
// ---------------------------------------------------------------------------

/**
 * `<outbox>/<task-id>/files/` — the directory every artifact pair lands in.
 *
 * **A deliberate second spelling of `harvest/outbox.ts`'s `OUTBOX_FILES_DIR`,
 * and the duplication is recorded rather than hidden.** §12's read-only block
 * scopes its bans to this console's own subtree, and importing `harvest/` from a
 * console module — to reach a four-character string — would put a harvester in
 * the import closure of a module whose whole claim is that it cannot act on the
 * fleet. The copy is pinned to the original by an assertion in
 * `test/unit/triage-envelope.test.ts`, which is not in the subtree and may import
 * both, so the two cannot drift while that test is green.
 */
export const SWEEP_FILES_DIR = "files";

/** `skills/observer-ops/SKILL.md:26-33`'s pair, the half a host validates. */
export const OBSERVER_ARTIFACT_FILE = "observer-ops.json";

/** §7.5's document, written by `tri-1` on turn two beside a `triage.md`. */
export const TRIAGE_DOCUMENT_FILE = "triage.json";

/** Where one observer's reply artifact sits on the host. */
export function observerArtifactPath(run: RunPaths, worker: string, taskId: string): string {
  return join(workerOutboxDir(run.root, worker), taskId, SWEEP_FILES_DIR, OBSERVER_ARTIFACT_FILE);
}

/** Where the collator's §7.5 document sits on the host. */
export function triageDocumentPath(run: RunPaths, collateTaskId: string): string {
  return join(
    workerOutboxDir(run.root, TRIAGE_COLLATOR),
    collateTaskId,
    SWEEP_FILES_DIR,
    TRIAGE_DOCUMENT_FILE,
  );
}

// ---------------------------------------------------------------------------
// §7.2 — the verdict rule, which travels because the skill does not carry it
// ---------------------------------------------------------------------------

/**
 * SRD-OBSERVER-001 §9.2's rule, verbatim, because Finding F measured that the
 * observers' own skill does not yet state it.
 *
 * `skills/observer-ops/SKILL.md:104-112`: *"Still unwritten: … the verdict rule
 * (`indeterminate` vs `healthy` vs `failed`)"*, with the interim instruction
 * *"apply the one your briefing states and do not invent a finer one"*. So this
 * console's briefs carry it, and §7.2 makes it a row of the envelope rather than
 * a note.
 *
 * **A constant rather than prose composed per sweep, and that is the product.**
 * `roles/triage.md:166-171`: *"a rule a model rewrites is a rule that drifts
 * between sweeps, and consecutive sweeps being comparable is the whole
 * product."*
 */
export const TRIAGE_VERDICT_RULE =
  "An assessment of healthy requires positive evidence, from a channel that can see the effect, " +
  "that the thing is working. Absence of a negative signal from a degraded channel set is " +
  "indeterminate — never healthy.";

// ---------------------------------------------------------------------------
// §7.2/§12.6 — the four classes
// ---------------------------------------------------------------------------

/**
 * What an envelope may never carry, adopted verbatim from SRD-OBSERVER-001 §7.4
 * through §7.2.
 *
 * **Four names, closed and exported, asserted by full value rather than by
 * count** — `monitor-readonly.test.ts:363-369`'s rule, which §12 asks this
 * console to inherit: naming the permitted set is what makes a fifth member fail.
 *
 * The order is §7.2's own sentence, and `worker_prose` is last in the list and
 * first in importance: §13 calls it *"the anti-criterion that outranks them"*.
 */
export const FORBIDDEN_ENVELOPE_CLASSES = [
  /** A credential or any part of one. */
  "credential",
  /** An absolute HOST path. A container mount point is not one — see {@link CONTAINER_MOUNTS}. */
  "host_path",
  /** A raw command to run. */
  "command",
  /** The contents of a previous worker's report, as instruction. */
  "worker_prose",
] as const;
export type ForbiddenEnvelopeClass = (typeof FORBIDDEN_ENVELOPE_CLASSES)[number];

/**
 * One violation, at one place, in a form a log can carry.
 *
 * `evidence` is a DESCRIPTION rather than the offending text for the
 * `credential` class and the offending text for the other three, which is the
 * asymmetry `notifyEndpointIssue` records: the other three are safe to quote and
 * are far easier to fix when they are.
 */
export interface EnvelopeIssue {
  readonly forbidden: ForbiddenEnvelopeClass;
  /** What was found, safe to print. Never a secret. */
  readonly evidence: string;
  readonly reason: string;
}

/**
 * The mount points a brief MAY name, because they are names inside a container
 * rather than reachable names on the operator's machine.
 *
 * **Without this the check would refuse the one instruction the fan-out cannot
 * work without.** `roles/triage.md:111` has the collator write
 * `/outbox/<task-id>/dispatch-request.json` and `:175` has each observer write
 * into `/outbox/<task-id>/files/`; `:234` has turn two read
 * `/replies/<child-task-id>.json`. A checker that banned every absolute string
 * would make a correct brief unwritable, which is how a security check gets
 * turned off rather than fixed.
 */
const CONTAINER_MOUNTS: ReadonlySet<string> = new Set([
  "outbox",
  "replies",
  "skills",
  "workspace",
]);

/**
 * Shapes that are a credential or a labelled place one goes.
 *
 * Two families and they catch different mistakes: a token with a recognisable
 * issuer prefix pasted bare, and any long opaque value introduced by a word that
 * means *"secret"*. Neither is exhaustive and neither is meant to be — the
 * structural defence is that the host composes this text out of typed fields, and
 * this is the tripwire for a hand-edited constant.
 */
const CREDENTIAL_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bghp_[A-Za-z0-9]{20,}/, what: "a GitHub token prefix" },
  { re: /\bgho_[A-Za-z0-9]{20,}/, what: "a GitHub token prefix" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: "a GitHub fine-grained token prefix" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token prefix" },
  { re: /\bsk-[A-Za-z0-9]{20,}/, what: "an OpenAI-style key prefix" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "a JWT" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a PEM private key header" },
  {
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]?\s*\S{8,}/i,
    what: "a secret-labelled value",
  },
];

/**
 * Command leaders, plus shell substitution and a shell code fence.
 *
 * §7.2 bans *"a raw command to execute"*, and the reason is §6.10's: the observer
 * has a verb gate and the brief must not be the thing that decides what it runs.
 * A closed leader list rather than a general "looks like shell" heuristic, on the
 * same rule the rest of this file follows — a named set fails loudly when it is
 * incomplete, and a heuristic fails quietly when it is wrong.
 */
const COMMAND_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /```(?:bash|sh|zsh|shell|console)\b/, what: "a shell code fence" },
  { re: /\$\(/, what: "a shell command substitution" },
  {
    re: /(^|[\s`'"([])(kubectl|gcloud|docker|helm|curl|wget|psql|bash|sh|rm|chmod|ssh)\s+-{0,2}[A-Za-z]/,
    what: "a command leader",
  },
];

/**
 * A path-shaped run of characters, anchored so ordinary prose does not match.
 *
 * Preceded by a boundary rather than matched anywhere, so `and/or` and
 * `services[0]` are not paths; and required to have a second segment, so a bare
 * `/` is not one either.
 */
const ABSOLUTE_PATH_RE = /(?:^|[\s`'"(<])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._<>{}-]*)+)/g;

/**
 * The floor under which a previous document's string is not evidence of
 * anything.
 *
 * **A short string cannot be told apart from the host's own vocabulary**, and the
 * document's fields are full of it: a `coverage[].channel` of `rollout` is also a
 * member of {@link TRIAGE_CHECKS}, which every brief names by design. The class
 * being defended is *"the CONTENTS of a previous worker's report"* — a finding, a
 * recommendation, a selector, a ledger reference — and none of those is seven
 * characters. Members of the host's closed vocabularies are skipped regardless of
 * length, so the floor is a second line rather than the only one.
 */
export const MIN_PROSE_LENGTH = 8;

/** Every token the HOST owns, which a document echoing one has not authored. */
const HOST_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...TRIAGE_CHECKS,
  ...OBSERVER_ASSESSMENTS,
  ...COVERAGE_RESULTS,
]);

/**
 * Every worker-authored string the previous document carries, as a set.
 *
 * Service names are deliberately ABSENT: {@link projectPreviousState} filters
 * them against the host's own declared list, which is a stronger check than a
 * substring search and is the one that belongs to them. `unaccounted[]` IS here,
 * because it is the worker's own claim about names and nothing filters it.
 */
function workerAuthoredStrings(document: TriageDocument): readonly string[] {
  const out: string[] = [];
  const keep = (value: string | null): void => {
    if (value === null) return;
    if (value.length < MIN_PROSE_LENGTH) return;
    if (HOST_VOCABULARY.has(value)) return;
    out.push(value);
  };
  for (const row of document.services) {
    keep(row.selector);
    keep(row.window);
    // §13 task 5.8's carrier, added 2026-09-07. `note` is the one field on this
    // document whose PURPOSE is to be a sentence, so it is never a member of the
    // host's vocabulary and never short by accident — `MIN_PROSE_LENGTH`'s floor
    // matters least for it and the ban matters most.
    //
    // Nothing can leak through it today: `projectPreviousState` emits only
    // `{service, assessment}`, so no note crosses into the next brief. This list
    // is the SECOND mechanism — the re-audit that exists to catch a widened
    // projection — and a re-audit blind to a carrier is worse than no re-audit,
    // because it looks like coverage.
    keep(row.note ?? null);
    for (const ref of row.evidence_ref) keep(ref);
    for (const entry of row.coverage) keep(entry.channel);
  }
  for (const name of document.unaccounted) keep(name);
  return out;
}

/**
 * Audit one piece of envelope text against all four classes.
 *
 * `previous` is the document the text was PROJECTED FROM, and passing it is what
 * makes the fourth class checkable at all: without it the function can only
 * assert that some prose is absent, which is not a claim about anything. Pass
 * `null` for text that had no previous sweep behind it.
 *
 * Every class is evaluated — the result is a list rather than a first-match —
 * because a hand-edited constant is usually wrong in one way and a pasted report
 * is usually wrong in several, and an operator fixing the first of four is an
 * operator who runs this three more times.
 */
export function envelopeIssues(
  text: string,
  previous: TriageDocument | null,
): readonly EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];

  for (const { re, what } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      issues.push({
        forbidden: "credential",
        evidence: what,
        reason:
          `the envelope carries ${what}, and §7.2 refuses a credential or any part of one. ` +
          `The value is deliberately not quoted back — this refusal reaches §7.7's log, which ` +
          `appends forever and is never truncated. A secret reaches a worker through the ` +
          `container's own environment, never through a brief.`,
      });
      break;
    }
  }

  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const path = match[1]!;
    const first = path.split("/")[1] ?? "";
    if (CONTAINER_MOUNTS.has(first)) continue;
    issues.push({
      forbidden: "host_path",
      evidence: path,
      reason:
        `${path} is an absolute path that is not one of this fleet's container mounts ` +
        `(${[...CONTAINER_MOUNTS].sort().join(", ")}), so it is a HOST path. §7.2 refuses one: a ` +
        `worker cannot reach it, and naming it tells a model the shape of a filesystem it has no ` +
        `business knowing.`,
    });
    break;
  }

  for (const { re, what } of COMMAND_PATTERNS) {
    if (re.test(text)) {
      issues.push({
        forbidden: "command",
        evidence: what,
        reason:
          `the envelope carries ${what}, and §7.2 refuses a raw command. What a worker may run ` +
          `is decided by its verb gate and its role (§6.10), never by the brief — a brief that ` +
          `carries a command is a brief that has started deciding.`,
      });
      break;
    }
  }

  if (previous !== null) {
    for (const prose of workerAuthoredStrings(previous)) {
      if (!text.includes(prose)) continue;
      issues.push({
        forbidden: "worker_prose",
        evidence: prose,
        reason:
          `the envelope carries a string the PREVIOUS sweep's worker wrote. §7.2: what crosses ` +
          `between passes is structured state, "never a previous worker's recommendations ` +
          `rendered as a brief". A brief that carries the last sweep's prose makes two sweeps ` +
          `incomparable, which is the one property this console exists to have.`,
      });
      break;
    }
  }

  return issues;
}

/** A refusal to emit an envelope, carrying every class it violated. */
export class SweepEnvelopeError extends Error {
  readonly issues: readonly EnvelopeIssue[];
  constructor(message: string, issues: readonly EnvelopeIssue[] = []) {
    super(message);
    this.name = "SweepEnvelopeError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// §7.2 — the projection, and the renderer
// ---------------------------------------------------------------------------

/**
 * One service's carried state — TWO FIELDS, and the shortness is the point.
 *
 * §7.2 carries *"the previous sweep's per-service state, as **structured state
 * only**"*. Both members are host-checkable: the name against the targets file,
 * the assessment against a closed enum. There is deliberately no `note`, no
 * `summary` and no `evidence` member, because a field that admits free text is
 * where the next person will put the last sweep's paragraph.
 */
export interface PreviousServiceState {
  readonly service: string;
  readonly assessment: ObserverAssessment;
}

const ASSESSMENTS: ReadonlySet<string> = new Set<string>(OBSERVER_ASSESSMENTS);

/**
 * Project the previous sweep's `triage.json` down to what may cross.
 *
 * **Filtered against `declared` rather than deduplicated or sanitised**, because
 * a service name is worker-authored too: `triage.json`'s rows are whatever `tri-1`
 * wrote, and a row naming a service the targets file never declared would put an
 * attacker-chosen token into the next brief under the host's own voice. The host
 * knows the legal names; nothing else has to be trusted.
 *
 * Order follows `declared` rather than the document, so two sweeps whose worker
 * happened to order its rows differently produce the same brief — the
 * comparability §6.6 is about, applied to the one input a worker controls.
 */
export function projectPreviousState(
  document: TriageDocument | null,
  declared: readonly string[],
): readonly PreviousServiceState[] {
  if (document === null) return [];
  const byName = new Map<string, ObserverAssessment>();
  for (const row of document.services) {
    if (!ASSESSMENTS.has(row.assessment)) continue;
    if (byName.has(row.service)) continue;
    byName.set(row.service, row.assessment);
  }
  const out: PreviousServiceState[] = [];
  for (const name of declared) {
    const assessment = byName.get(name);
    if (assessment !== undefined) out.push({ service: name, assessment });
  }
  return out;
}

/** What §7.2's renderer is handed. Every member is host-owned or host-checkable. */
export interface SweepEnvelopeInput {
  readonly sweepId: string;
  /** ISO-8601 UTC. The lower bound of this sweep's observation window. */
  readonly windowOpenedAt: string;
  readonly environment: string;
  /** The environment's services, in FILE order, with their own bounds. */
  readonly services: readonly TriageService[];
  /** §7.1's `default_window`, resolved to seconds. */
  readonly defaultWindowS: number;
  /**
   * The previous sweep's document, handed over WHOLE so this function can
   * project it and then prove nothing else crossed. Never rendered.
   */
  readonly previousDocument: TriageDocument | null;
  /** Defaults to {@link TRIAGE_VERDICT_RULE}. Audited like everything else. */
  readonly verdictRule?: string;
}

/** A `dispatchrequest`-shaped pair. `roles/collator.md:81-91`'s two prose fields. */
export interface SweepEnvelope {
  readonly title: string;
  readonly brief: string;
}

/**
 * §7.2's `window_opened_at`, derived — **the LOWER bound of the observation
 * window, and NOT the instant the host dispatched at.**
 *
 * ## The two sentences that describe this field do not obviously agree, and the
 * ## table settles it
 *
 * §7.2:1818 calls it *"the lower bound of this sweep's observation window"*.
 * §7.4:1935 calls it *"the moment the observer's queries start looking back
 * from"*, which reads naturally as the opposite end — you look back FROM now.
 * §7.4's own refusal table decides it: a value *"earlier than `dispatched_at −
 * default_window − reserve_s`"* is refused because *"the observer looked further
 * back than configured"*, and that reason is only a sentence about the LOWER
 * bound. An echo carrying the dispatch instant would be in range on every sweep
 * no matter how far back the observer actually queried, which would make §7.4's
 * whole check — *"queried six hours against a five-minute configuration"* —
 * unable to catch the one thing it exists for.
 *
 * **The environment's `default_window` and not a per-service override**, because
 * one artifact carries one echo and §7.1 refuses an override wider than the
 * default (resolved 2026-09-06). The widest legal window is therefore the
 * default, so a bound computed from it admits every service's own window and
 * admits nothing else.
 *
 * Throws on an unparseable instant rather than returning one, on this console's
 * split: a document a container wrote gets a value, and a HOST argument that is
 * wrong for the life of the run gets a throw. `dispatchedAt` is the actor's own.
 */
export function windowOpenedAt(dispatchedAt: string, defaultWindowS: number): string {
  const at = Date.parse(dispatchedAt);
  if (!Number.isFinite(at)) {
    throw new SweepEnvelopeError(
      `the sweep's dispatch instant ${JSON.stringify(dispatchedAt)} is not an ISO-8601 instant, ` +
        `so §7.2's window_opened_at cannot be derived from it. This value is minted host-side, ` +
        `so it is a host fault rather than something a worker wrote.`,
    );
  }
  return new Date(at - defaultWindowS * 1000).toISOString();
}

/** One service's line, with its OWN window rather than the environment's. */
function serviceBlock(service: TriageService, defaultWindowS: number): string {
  const windowS = service.window ?? defaultWindowS;
  const workload = service.workload ?? "(resolved by selector — no single workload name)";
  return [
    `- service: ${service.name}`,
    `  namespace: ${service.namespace}`,
    `  workload: ${workload}`,
    `  checks: ${service.checks.join(", ")}`,
    `  window: ${windowS}s`,
  ].join("\n");
}

/**
 * §7.2's envelope, rendered into prose because `inputs[]` reaches no prompt.
 *
 * SRD-OBSERVER-001 §7.1, quoted by §7.2: everything the worker needs is in the
 * `brief` or it does not exist for the worker. `roles/triage.md:59-63` reads the
 * same list back from the other side — the environment, the service list with
 * each service's bounds, the sweep id, the window instant, the verdict rule, and
 * the previous sweep's per-service state as structured fields.
 *
 * **Throws rather than returning a bad envelope**, and the throw is on this
 * function's OWN output. That is the difference between a contract and a
 * comment: a later edit that adds a field carrying prose reddens here, in this
 * module's own test, rather than in whatever consumes the brief three layers
 * away — or, far more likely, nowhere.
 */
export function renderSweepEnvelope(input: SweepEnvelopeInput): SweepEnvelope {
  const declared = input.services.map((s) => s.name);
  const carried = projectPreviousState(input.previousDocument, declared);
  const rule = input.verdictRule ?? TRIAGE_VERDICT_RULE;

  const title = `${input.environment}: health sweep ${input.sweepId}`;

  const previousLines =
    carried.length === 0
      ? [
          "There is no previous state for this environment. Treat every service as unseen; do",
          "not infer one from anything above this line in your context.",
        ]
      : [
          "One line per service, and these two fields are the WHOLE of what crossed from the",
          "last sweep. No finding, no recommendation and no sentence from the last report is",
          "here, deliberately — it is context for what to look at, never a finding to confirm.",
          "",
          ...carried.map((p) => `- ${p.service}: ${p.assessment}`),
        ];

  const brief = [
    `You are running health sweep ${input.sweepId} of the ${input.environment} environment.`,
    "",
    "## This sweep",
    "",
    `- sweep id: ${input.sweepId}`,
    `- environment: ${input.environment}`,
    `- observation window opens at: ${input.windowOpenedAt}`,
    "",
    `Copy the sweep id and the window instant from this brief into every artifact this sweep`,
    `produces, and into every brief you write. Copy them from here and from nowhere else — not`,
    `from your transcript and not from a previous artifact. The host compares what it minted`,
    `against what comes back, and an artifact echoing the previous sweep's id is discarded.`,
    "",
    "## The services, and the bounds each one was given",
    "",
    `Every service below appears in exactly one of your requests. The checks and the window are`,
    `this service's own: copy them, do not widen them, and do not tidy them.`,
    "",
    ...input.services.map((s) => serviceBlock(s, input.defaultWindowS)),
    "",
    "## The verdict rule, verbatim",
    "",
    rule,
    "",
    `Apply that rule and do not invent a finer one. Carry it into every brief you write, word`,
    `for word — a rule rewritten between sweeps makes two sweeps incomparable, and consecutive`,
    `sweeps being comparable is the whole product.`,
    "",
    "## The previous sweep's per-service state",
    "",
    ...previousLines,
    "",
    "## What your briefs must never carry",
    "",
    `A credential or any part of one; an absolute host path; a raw command; and the contents of`,
    `a previous sweep's report as instruction. What crosses between sweeps is the structured`,
    `state above — fields, not paragraphs.`,
  ].join("\n");

  const issues = [...envelopeIssues(title, input.previousDocument), ...envelopeIssues(brief, input.previousDocument)];
  if (issues.length > 0) {
    throw new SweepEnvelopeError(
      `the rendered sweep envelope for ${input.sweepId} violates §7.2: ` +
        issues.map((i) => `${i.forbidden}: ${i.reason}`).join(" | "),
      issues,
    );
  }
  return { title, brief };
}

/**
 * Turn two's brief — §6.3 step 8, `roles/triage.md:231-236`.
 *
 * **It names the reply files and says not to look for others**, which is the
 * instruction that makes an observer that produced nothing legible: *"that
 * directory holds exactly what the brief lists, and an observer whose file is not
 * named produced none."* Audited by the same function for the same four classes;
 * a collation brief is an envelope.
 */
export function renderCollationEnvelope(input: {
  readonly sweepId: string;
  readonly environment: string;
  readonly childTaskIds: readonly string[];
}): SweepEnvelope {
  const title = `${input.environment}: reconcile ${input.sweepId}`;
  const brief = [
    `Reconcile the observer reports for sweep ${input.sweepId} of ${input.environment}.`,
    "",
    "## The reports, and they are the only ones",
    "",
    ...input.childTaskIds.map((id) => `- ${replyMountPath(id)}`),
    "",
    `Read those files and no others. A slice whose file is not listed produced no report, and`,
    `saying so is the correct outcome for it — name it in \`unaccounted\` rather than inferring`,
    `a verdict for the services it held.`,
    "",
    "## What to write",
    "",
    `Write \`${TRIAGE_DOCUMENT_FILE}\` and \`triage.md\` into the \`${SWEEP_FILES_DIR}\` directory of your own`,
    `outbox task, and declare both in the envelope's \`artifacts\` array. One row per service,`,
    `never one verdict over a batch. Echo the sweep id ${input.sweepId} in the document.`,
    "",
    `Carry each observer's own \`assessment\` word through unchanged. Do not upgrade a row whose`,
    `coverage is empty, and do not decide whether anything should be notified — that decision`,
    `belongs to the host, which can see across sweeps and you cannot.`,
  ].join("\n");

  const issues = envelopeIssues(`${title}\n${brief}`, null);
  if (issues.length > 0) {
    throw new SweepEnvelopeError(
      `the rendered collation envelope for ${input.sweepId} violates §7.2: ` +
        issues.map((i) => `${i.forbidden}: ${i.reason}`).join(" | "),
      issues,
    );
  }
  return { title, brief };
}

// ---------------------------------------------------------------------------
// §7.4 — `observer-ops.json` → `ObserverArtifact`, and §9.3's `blocked`
// ---------------------------------------------------------------------------

/** SRD-OBSERVER-001 §9.3's domain for `status`. Closed, and asserted by name. */
export const OBSERVER_STATUSES = ["success", "partial", "blocked", "failed"] as const;
export type ObserverStatus = (typeof OBSERVER_STATUSES)[number];

/** One observer's artifact plus the field §6.7's table reads separately. */
export interface ObserverReply {
  readonly artifact: ObserverArtifact;
  /**
   * §9.1's *"did the observation succeed"*. `null` when the artifact named no
   * value in §9.3's domain — recorded as unknown rather than coerced, because
   * `blocked` is the only value that becomes an issue and guessing at it in
   * either direction is wrong.
   */
  readonly status: ObserverStatus | null;
}

export type ObserverArtifactRead =
  | { readonly kind: "ok"; readonly reply: ObserverReply }
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

const STATUSES: ReadonlySet<string> = new Set<string>(OBSERVER_STATUSES);

/** A field that must be a non-empty string to be an echo, and is `null` otherwise. */
function echo(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read one `observer-ops.json` into the two values the host's own gates spend.
 *
 * ## AN OMITTED ECHO IS `null`, AND IS NOT A REFUSAL
 *
 * This is the whole reason the reader is this lenient. §7.4 makes `sweep_id` and
 * `window_opened_at` REQUIRED and gives each a host-side gate — `sweepIdEcho`
 * answers `stale_replay`, `windowEcho` answers `stale_window` — and
 * `ObserverArtifact` models both as `string | null` precisely so *"an artifact
 * that omitted it is a contract violation the host must be able to RECORD"*. A
 * reader that refused the file instead would delete the fault before the gate
 * built to record it ever saw it, and the two failures would arrive at
 * `assessTriageSweep` wearing one costume.
 *
 * What IS refused is a file that is not a JSON object at all: that is not an
 * artifact with a missing field, it is a turn that produced something other than
 * the document it was asked for, and `parseTriageDocument`'s own three-way split
 * is followed here for the same reason it exists there.
 *
 * `worker` comes from the CONTEXT — the outbox directory the file sat in — never
 * from the document, on `TriageDocumentContext.worker`'s rule: *"a document that
 * could name its own author could attribute a sweep to a seat that never ran
 * one."*
 */
export function parseObserverArtifact(
  text: string,
  ctx: { readonly worker: string; readonly path: string },
): ObserverArtifactRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { kind: "refused", path: ctx.path, reason: `${ctx.path} is not JSON: ${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "refused",
      path: ctx.path,
      reason:
        `${ctx.path} is not a JSON object, so it carries no §7.4 fields at all. An artifact ` +
        `missing an echo is a contract violation the host records; a file that is not an ` +
        `object is a turn that produced something else.`,
    };
  }
  const record = raw as Record<string, unknown>;
  const status = record["status"];
  return {
    kind: "ok",
    reply: {
      artifact: {
        worker: ctx.worker,
        sweep_id: echo(record, "sweep_id"),
        window_opened_at: echo(record, "window_opened_at"),
      },
      status: typeof status === "string" && STATUSES.has(status) ? (status as ObserverStatus) : null,
    },
  };
}

/** How this module reads bytes. Injected so a fixture needs no temp directory. */
export type SweepFileRead = (path: string) => Promise<string | null>;

const DEFAULT_READ: SweepFileRead = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
};

/** {@link parseObserverArtifact} over a path, with the absence arm a path has. */
export async function readObserverArtifactAt(
  path: string,
  ctx: { readonly worker: string; readonly path: string },
  read: SweepFileRead = DEFAULT_READ,
): Promise<ObserverArtifactRead> {
  const text = await read(path);
  if (text === null) return { kind: "absent", path };
  return parseObserverArtifact(text, ctx);
}

/**
 * SRD-OBSERVER-001 §9.3's extractor — the seats whose observation was prevented
 * by something outside the worker.
 *
 * **`failed` is deliberately not here.** §9.3: *"A tunnel-down control plane is
 * `blocked`, not `failed`. Nothing the worker did caused it and no retry inside
 * the container fixes it."* §6.8a gives `blocked` a console-health `kind` of its
 * own for exactly that reason, and folding `failed` in would send an operator to
 * debug a task when the answer is a network.
 */
export function blockedObservers(
  replies: readonly { readonly artifact: ObserverArtifact; readonly status: ObserverStatus | null }[],
): readonly string[] {
  return replies.filter((r) => r.status === "blocked").map((r) => r.artifact.worker);
}

// ---------------------------------------------------------------------------
// §7.5 — the path-reading wrapper `parseTriageDocument` deliberately lacks
// ---------------------------------------------------------------------------

/**
 * {@link TriageDocumentRead} plus the one arm §7.5 refused to give it.
 *
 * `parseTriageDocument` takes TEXT and has *"no `missing` arm"*, on the recorded
 * ground that *"an absent `triage.json` is not this module's to interpret: §6.5
 * counts coverage from the run tree, so a sweep that produced no document is a
 * zero-row sweep the ACTOR names, not a parse result."* The actor still has to
 * tell an absent file from a malformed one, so the distinction is drawn HERE, by
 * the only function that can see it, and the parser keeps its two-arm shape.
 */
export type TriageDocumentFileRead =
  | TriageDocumentRead
  | { readonly kind: "absent"; readonly path: string };

export async function readTriageDocumentAt(
  path: string,
  ctx: TriageDocumentContext,
  read: SweepFileRead = DEFAULT_READ,
): Promise<TriageDocumentFileRead> {
  const text = await read(path);
  if (text === null) return { kind: "absent", path };
  return parseTriageDocument(text, ctx);
}

// ---------------------------------------------------------------------------
// The four `SweepDriver` members
// ---------------------------------------------------------------------------

/** What the injected dispatch can say. §6.10 exit 5 is a value, never a throw. */
export type SweepDispatchOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "budget_exhausted"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The one effect this module does not own — see the header.
 *
 * **Returns when the task has SETTLED**, not when it was accepted, because
 * `collate` reads the document the task it dispatched writes and §6.3 gives
 * `SweepDriver` no member between the two steps.
 */
export type SweepDispatch = (args: {
  readonly taskId: string;
  readonly worker: string;
  readonly title: string;
  readonly brief: string;
}) => Promise<SweepDispatchOutcome>;

export interface SweepProducerDeps {
  readonly run: RunPaths;
  readonly environment: string;
  readonly services: readonly TriageService[];
  readonly defaultWindowS: number;
  /** The previous sweep's document, fetched lazily. Projected, never rendered. */
  readonly previousDocument: () => Promise<TriageDocument | null>;
  readonly dispatch: SweepDispatch;
  readonly read?: SweepFileRead;
}

/** The four members `SweepDriver` had no producer for. */
export interface SweepProducers {
  readonly openSweep: (sweepId: string, dispatchedAt: string) => Promise<SweepOpen>;
  readonly dispatchObserver: (sweepId: string, assignment: PartitionAssignment) => Promise<void>;
  readonly join: (sweepId: string) => Promise<SweepJoin>;
  readonly collate: (sweepId: string) => Promise<SweepCollation>;
}

/**
 * Assemble the four, over one injected dispatch.
 *
 * A factory rather than four exported functions each taking the same six
 * arguments: the deps are one set, and four call sites that each rebuild them is
 * four chances for two of them to disagree about which run they are serving —
 * the failure §6.4 refuses two processes for, at a smaller scale.
 */
export function sweepProducers(deps: SweepProducerDeps): SweepProducers {
  const read = deps.read ?? DEFAULT_READ;

  const openSweep = async (sweepId: string, dispatchedAt: string): Promise<SweepOpen> => {
    const envelope = renderSweepEnvelope({
      sweepId,
      windowOpenedAt: windowOpenedAt(dispatchedAt, deps.defaultWindowS),
      environment: deps.environment,
      services: deps.services,
      defaultWindowS: deps.defaultWindowS,
      previousDocument: await deps.previousDocument(),
    });
    const outcome = await deps.dispatch({
      taskId: sweepId,
      worker: TRIAGE_COLLATOR,
      title: envelope.title,
      brief: envelope.brief,
    });
    if (outcome.kind === "budget_exhausted") {
      return { kind: "budget_exhausted", reason: outcome.reason };
    }
    if (outcome.kind === "refused") {
      throw new SweepEnvelopeError(
        `the request plane refused sweep ${sweepId}: ${outcome.reason}. This is a HOST fault — ` +
          `the envelope was composed here and the roster is a constant — so it is a thrown pass ` +
          `rather than a §6.10 exit, which is a configured limit doing its job.`,
      );
    }
    return { kind: "opened" };
  };

  /**
   * §6.3 step 5. The brief is the COLLATOR's, read back out of the fan-out
   * request it wrote, which is the one place §7.3 sanctions a worker's string
   * becoming a dispatch — the same path the review console's fan-out takes.
   *
   * A slice with no request is a HOST invariant violation rather than a worker
   * fault: `dispatchPartition` only reaches here after `checkTriagePartition`
   * accepted a partition projected from that very file, so the file was there a
   * moment ago. It throws, and the loop's catch reports a fault.
   */
  const dispatchObserver = async (
    sweepId: string,
    assignment: PartitionAssignment,
  ): Promise<void> => {
    const seat = TRIAGE_CONSOLE_ASPECTS.find((s) => s.worker === assignment.worker);
    if (seat === undefined) {
      throw new SweepEnvelopeError(
        `${assignment.worker} is not a seat of the triage console (${TRIAGE_CONSOLE_ASPECTS.map(
          (s) => s.worker,
        ).join(", ")}), so no child task id can be derived for it.`,
      );
    }
    const request = await readDispatchRequest({
      runRoot: deps.run.root,
      sender: TRIAGE_COLLATOR,
      taskId: sweepId,
      roster: TRIAGE_CONSOLE_ROSTER,
    });
    const item =
      request.kind === "ok"
        ? request.request.requests.find((r) => r.worker === assignment.worker)
        : undefined;
    if (item === undefined) {
      throw new SweepEnvelopeError(
        `the fan-out request for ${sweepId} holds no entry for ${assignment.worker}, but the ` +
          `partition this dispatch came from was projected from it. The file changed under the ` +
          `sweep, and dispatching a brief this host did not read is the one thing worse than ` +
          `refusing.`,
      );
    }
    const outcome = await deps.dispatch({
      taskId: childTaskId(sweepId, seat.aspect),
      worker: assignment.worker,
      title: item.title,
      brief: item.brief,
    });
    if (outcome.kind !== "accepted") {
      throw new SweepEnvelopeError(
        `dispatching ${assignment.worker}'s slice of ${sweepId} was ${outcome.kind}: ${outcome.reason}`,
      );
    }
  };

  /**
   * §6.3 steps 6-7. Reads the run tree, never the worker's account of it.
   *
   * A seat with no readable artifact is ABSENT from `artifacts[]` rather than
   * present with nulls — `ObserverArtifact`'s own docblock: *"there is no
   * `present: boolean`, because an absent artifact is an absent element and a
   * boolean would let a caller record an artifact that is not there."* A file
   * that exists and is not an object is treated the same way and for the same
   * reason: §6.7 counts what came back, and something that is not a reply did not
   * come back.
   */
  const joinSweep = async (sweepId: string): Promise<SweepJoin> => {
    const replies: ObserverReply[] = [];
    for (const seat of TRIAGE_CONSOLE_ASPECTS) {
      const taskId = childTaskId(sweepId, seat.aspect);
      const path = observerArtifactPath(deps.run, seat.worker, taskId);
      const found = await readObserverArtifactAt(path, { worker: seat.worker, path }, read);
      if (found.kind === "ok") replies.push(found.reply);
    }
    return { artifacts: replies.map((r) => r.artifact), blocked: blockedObservers(replies) };
  };

  /**
   * §6.3 steps 8-9.
   *
   * `evidenceRef` is filled on EVERY path, including the one where no document
   * came back, because `SweepCollation.evidenceRef` is non-nullable for the
   * stated reason: *"a sweep that collated nothing still has a task an operator
   * can go and read"*, and a clear that names nothing is a clear derived from an
   * absence.
   */
  const collate = async (sweepId: string): Promise<SweepCollation> => {
    const collateTaskId = collationTaskId(sweepId);
    const envelope = renderCollationEnvelope({
      sweepId,
      environment: deps.environment,
      childTaskIds: TRIAGE_CONSOLE_ASPECTS.map((s) => childTaskId(sweepId, s.aspect)),
    });
    const outcome = await deps.dispatch({
      taskId: collateTaskId,
      worker: TRIAGE_COLLATOR,
      title: envelope.title,
      brief: envelope.brief,
    });
    const evidenceRef = `${TRIAGE_COLLATOR}:${collateTaskId}/${SWEEP_FILES_DIR}/${TRIAGE_DOCUMENT_FILE}`;
    if (outcome.kind !== "accepted") return { document: null, evidenceRef };

    const path = triageDocumentPath(deps.run, collateTaskId);
    const found = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path }, read);
    return { document: found.kind === "ok" ? found.document : null, evidenceRef };
  };

  return { openSweep, dispatchObserver, join: joinSweep, collate };
}
