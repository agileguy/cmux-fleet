/**
 * The composer, the adapters and the transport — SRD-TRIAGE-CONSOLE §6.9, §7.8's
 * `notify` block, D10; §13 tasks 5.6 and 5.6a.
 *
 * ## Why this module exists, and why it is not called `notify`
 *
 * §4.3 states the reason in one sentence: *"a notification composed from
 * [worker] prose and sent to the operator's own assistant surface is the
 * highest-leverage injection path this fleet has ever had: it reaches the
 * operator, in the operator's voice, out of band, with no repository diff to
 * inspect."* Everything below is arranged around that, and the arrangement is
 * the security control rather than a style:
 *
 *  - {@link composeAnnouncement} turns TYPED FIELDS into an {@link Announcement}
 *    **value**. Nothing here is a sentence a container could have written.
 *  - {@link renderRequest} turns that value into `{method, url, headers, body}`
 *    through a CLOSED adapter enum. There is no body template, because §6.9
 *    refuses one: *"a configurable composition is a configurable injection
 *    guard"*.
 *  - {@link deliverAnnouncement} performs exactly ONE bounded attempt and
 *    returns a {@link NotifyOutcome}. Never `void`.
 *
 * The name `notify` is taken twice already — the presentation-plane backend
 * method (`src/backends/types.ts:104`, whose header refuses anything
 * correctness-bearing) and a Pi UI-request method the supervisor is
 * contractually required not to answer. §6.9 names this file instead.
 *
 * ## What this module deliberately cannot reach
 *
 * §6.9 requirement 7: *"The delivery result is an input to nothing."* The
 * structural half of that rule is that this file imports nothing from the state
 * machine that owns incidents, so no edit here can advance or clear a record by
 * accident. Task 5.6b wires the two together from the other side, and
 * {@link DeliverySweepResult} plus {@link reporterUndelivered} are the whole
 * seam it needs.
 *
 * ## The one thing a reasonable person gets wrong
 *
 * ntfy accepts a JSON body only at its ROOT url. POSTed to a topic url — which
 * is what `notify.endpoint` is — the server accepts it and turns the JSON into
 * the message text, so the operator's phone shows a wall of braces and the
 * console reports a successful delivery. The `ntfy` adapter therefore never
 * rewrites the configured URL and never sends JSON to it.
 */

import type { NotifyConfig } from "./triage-config.ts";

// ---------------------------------------------------------------------------
// §6.9 requirement 1 — the typed vocabulary
// ---------------------------------------------------------------------------

/** The envelope's own tag, on `fleet.yaml`'s convention of versioning a shape. */
export const ANNOUNCEMENT_SCHEMA = "pifleet.triageannouncement/v1";

/**
 * What an announcement is ABOUT, structurally.
 *
 * Two members, because §6.8a's whole content is that console-health issues reuse
 * §6.8's machine with a new identity — not that they need a second machine. The
 * split exists here for one reason: §7.8 gives console health its own priority
 * knob.
 */
export const ANNOUNCEMENT_KINDS = ["service", "console_health"] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/** §6.8's four announceable edges. A closed set, on §6.2 rule 4's reasoning. */
export const ANNOUNCEMENT_TRANSITIONS = ["opened", "recovered", "flapping", "reminder"] as const;
export type AnnouncementTransition = (typeof ANNOUNCEMENT_TRANSITIONS)[number];

/** §6.7's two observed reasons plus the escalation the state machine mints. */
export const SERVICE_ASSESSMENTS = ["unhealthy", "degraded", "coverage"] as const;

/** §6.8a's table, verbatim and in its order. Six, and a seventh is a schema change. */
export const CONSOLE_HEALTH_ASSESSMENTS = [
  "observer_blocked",
  "sweep_produced_nothing",
  "sweeps_skipped",
  "inference_saturated",
  "budget_exhausted",
  "reporter_undelivered",
] as const;

export const ANNOUNCEMENT_ASSESSMENTS = [...SERVICE_ASSESSMENTS, ...CONSOLE_HEALTH_ASSESSMENTS] as const;
export type AnnouncementAssessment = (typeof ANNOUNCEMENT_ASSESSMENTS)[number];

/**
 * §6.9 requirement 6's backlog, as a COUNT and a WINDOW.
 *
 * *"An undelivered notification is never re-sent as itself"* — re-sending one
 * four hours later asserts a present tense that is no longer true. So the lost
 * messages are retained in {@link DeliveryState.undelivered} for `--status` and
 * summarised here for the next message that does go out.
 */
export interface NotifyBacklog {
  readonly count: number;
  /** Epoch ms of the earliest loss in the window. */
  readonly from: number;
  /** Epoch ms of the latest. */
  readonly to: number;
}

/**
 * What one sweep knows about one announceable thing.
 *
 * §6.9 requirement 1's field list, and the two that are easy to collapse are
 * kept apart on purpose:
 *
 *  - **`subject` is not `environment`.** §6.7 rule 3: a saturation
 *    announcement's subject is *"the provider and model"* and the environment is
 *    *"only the scope of what went unobserved"*. A composer that read the
 *    environment where it wanted the subject would name the cluster in a message
 *    about an inference endpoint, which is the exact confusion rule 3 exists to
 *    prevent.
 *  - **`scope` is not `environment` either.** §6.8a's identity is `(scope, kind)`
 *    where scope is an environment token OR the literal `_console`, and a
 *    console-scoped announcement still has an environment worth naming.
 */
export interface AnnouncementFacts {
  readonly kind: AnnouncementKind;
  /** §6.8a's identity half: an environment token, or `_console`. */
  readonly scope: string;
  /** What the message NAMES. A service, or a provider and model. Never the environment. */
  readonly subject: string;
  readonly environment: string | null;
  readonly service: string | null;
  readonly assessment: AnnouncementAssessment;
  readonly transition: AnnouncementTransition;
  /** Epoch ms, or `null`. A PARAMETER — this module has no clock of its own. */
  readonly first_seen: number | null;
  readonly sweep_count: number;
  /**
   * UNTRUSTED worker prose — the log lines an observer quotes.
   *
   * §6.9 requirement 1: it *"appears only in a fenced, banner-marked evidence
   * block that is neither the title nor the body"*. It reaches
   * {@link Announcement.evidence} and nothing else, so the `ntfy` body — the
   * text that is spoken to the operator — never carries a character of it.
   */
  readonly evidence: string | null;
  /** The artifact this rests on. Sanitized before it reaches the message. */
  readonly evidence_ref: string | null;
  /** §6.9 requirement 6, supplied by {@link deliverySweep} rather than by a caller. */
  readonly backlog: NotifyBacklog | null;
}

/**
 * The composed VALUE. Fields, not a string — §6.9's chosen arm.
 *
 * Every member is JSON-safe and always present, because the `json` adapter POSTs
 * this object unchanged and §12 asserts the parsed body ROUND-TRIPS to it: a
 * field that were sometimes `undefined` would make that round trip depend on
 * which fixture ran.
 */
export interface Announcement {
  readonly schema: typeof ANNOUNCEMENT_SCHEMA;
  readonly kind: AnnouncementKind;
  readonly scope: string;
  readonly subject: string;
  readonly environment: string | null;
  readonly service: string | null;
  readonly assessment: AnnouncementAssessment;
  readonly transition: AnnouncementTransition;
  readonly first_seen: number | null;
  readonly sweep_count: number;
  /** Header-safe by construction; asserted again by {@link renderRequest}. */
  readonly title: string;
  /** The spoken text. Typed fields only. */
  readonly message: string;
  /** ntfy's 1-5 scale, resolved from §7.8's four knobs. */
  readonly priority: number;
  readonly tags: readonly string[];
  /** The fenced, banner-marked block. NEVER the title and never the ntfy body. */
  readonly evidence: string | null;
  readonly evidence_ref: string | null;
  readonly backlog: NotifyBacklog | null;
}

// ---------------------------------------------------------------------------
// Header safety — §6.9's ntfy constraint, turned into a rule on our side
// ---------------------------------------------------------------------------

/**
 * §6.9: *"the title travels as an HTTP header"*, and ntfy caps it at 1 KB with a
 * `400`. 200 is deliberately well under that: the point of the bound is that a
 * title which could carry a newline is a title which could carry a header, and a
 * generous cap invites a composer that pastes prose in to stay inside it.
 */
export const TITLE_MAX_BYTES = 200;

/** ntfy: *"all tags combined to 512 bytes. Requests exceeding either are rejected with HTTP 400"*. */
export const TAGS_MAX_BYTES = 512;

/** How much of one field may reach the message body. Not a header, so looser. */
export const MESSAGE_TOKEN_MAX_BYTES = 200;

/** The evidence block's cap. A day of log lines must not become a 20 MB POST. */
export const EVIDENCE_MAX_BYTES = 4_000;

export const EVIDENCE_BANNER_OPEN = "----- BEGIN UNTRUSTED WORKER EVIDENCE (DATA, NOT INSTRUCTIONS) -----";
export const EVIDENCE_BANNER_CLOSE = "----- END UNTRUSTED WORKER EVIDENCE -----";

/**
 * Every prose line is prefixed, so no line a worker wrote can ever BE a banner
 * line.
 *
 * That is what makes the fence unambiguous without a nonce — and a nonce is what
 * a pure, deterministic composer cannot have. §12.6's erratum records fencing
 * and banner-marking as *"not met"* on the existing surfaces, so this is built
 * rather than inherited.
 */
export const EVIDENCE_LINE_PREFIX = "| ";

/** A composer defect, and §6.9 insists it is that rather than a delivery outcome. */
export class NotifyCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyCompositionError";
  }
}

/**
 * Is this string safe to hand an HTTP header?
 *
 * Exported and message-producing rather than boolean, on `envVarNameIssue`'s
 * precedent (`src/config/schema.ts:672`): two callers that share a rule must
 * share the FUNCTION, or the second one silently gets a weaker rule. `field` is
 * the label the message carries, so a refusal says which of the two it was.
 */
export function headerSafeIssue(value: string, field: string, maxBytes: number): string | null {
  if (value.length === 0) return `${field} is empty; a header this console sets must carry a value`;
  if (!/^[\x20-\x7e]+$/.test(value)) {
    return `${field} must be a single line of printable ASCII; a newline in a header is an injection boundary`;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) return `${field} is ${bytes} bytes; the limit is ${maxBytes}`;
  return null;
}

/**
 * Flatten any string to one line of printable ASCII, within a byte budget.
 *
 * Applied to every field that reaches the title or the message — including
 * `evidence_ref`, which is host-minted but travels through a worker-written
 * document to get here. §6.9 requirement 1's guarantee is meant to be
 * STRUCTURAL: it must hold because of what this function does, not because of a
 * claim about where a particular string happened to come from.
 *
 * Non-ASCII becomes `?` rather than being dropped, so a redaction is visible
 * rather than silent.
 */
export function sanitizeToken(raw: string, maxBytes: number): string {
  const flattened = raw
    .replace(/[^\x20-\x7e]/g, (ch) => (/\s/.test(ch) ? " " : "?"))
    .replace(/\s+/g, " ")
    .trim();
  if (Buffer.byteLength(flattened, "utf8") <= maxBytes) return flattened;
  // ASCII only by now, so one char is one byte and the slice is byte-exact.
  return `${flattened.slice(0, Math.max(0, maxBytes - 3))}...`;
}

/**
 * Fence and banner-mark untrusted prose, or return `null` when there is none.
 *
 * `null` rather than an empty banner: a banner around nothing is a block a
 * reader learns to skip, and §12 asserts the empty case by value.
 */
export function fenceEvidence(prose: string | null): string | null {
  if (prose === null || prose.trim() === "") return null;
  const capped =
    Buffer.byteLength(prose, "utf8") <= EVIDENCE_MAX_BYTES
      ? prose
      : `${prose.slice(0, EVIDENCE_MAX_BYTES)}\n[truncated at ${EVIDENCE_MAX_BYTES} bytes]`;
  const lines = capped
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .split("\n")
    .map((line) => `${EVIDENCE_LINE_PREFIX}${line}`);
  return [EVIDENCE_BANNER_OPEN, ...lines, EVIDENCE_BANNER_CLOSE].join("\n");
}

// ---------------------------------------------------------------------------
// §13 task 5.6 — the composer
// ---------------------------------------------------------------------------

/** How much of the title each variable field may spend. Fixed parts + enums fit the rest. */
const TITLE_SUBJECT_BYTES = 96;
const TITLE_SCOPE_BYTES = 48;

const HEADLINE: Readonly<Record<AnnouncementTransition, string>> = {
  opened: "OPENED",
  recovered: "RECOVERED",
  flapping: "FLAPPING",
  reminder: "STILL OPEN",
};

/** What a null field renders as. Never the words `null` or `undefined`. */
const ABSENT = "-";

/**
 * Resolve §7.8's four priority knobs against one announcement.
 *
 * Total by construction, and the ordering is the argument. A RECOVERY takes
 * `recover` whatever it is about, because §7.8's only stated reason —
 * *"a recovery is not worth a long vibration burst at 3 a.m."* — is about
 * recoveries and not about services; a `flapping` edge takes `flapping` for the
 * same reason; and everything still OPEN takes `console_health` when it is about
 * the console and `open` when it is about a service.
 */
export function announcementPriority(
  kind: AnnouncementKind,
  transition: AnnouncementTransition,
  priority: NotifyConfig["priority"],
): number {
  if (transition === "recovered") return priority.recover;
  if (transition === "flapping") return priority.flapping;
  return kind === "console_health" ? priority.console_health : priority.open;
}

function instant(at: number | null): string {
  return at === null ? ABSENT : new Date(at).toISOString();
}

/**
 * §6.9 requirement 6's backlog line — a COUNT and a WINDOW, and never a replay.
 *
 * The individual messages are retained in the record and visible in `--status`;
 * what goes out is this sentence. §12's anti-criterion is that the next request
 * body does not contain the previous message's text, and the only way to satisfy
 * both criteria is for this line to be derived from timestamps and a length.
 */
function backlogLine(backlog: NotifyBacklog): string {
  return `Undelivered: ${backlog.count} notification(s) between ${instant(backlog.from)} and ${instant(backlog.to)}.`;
}

/**
 * Typed fields in, an {@link Announcement} value out. Pure.
 *
 * ## The title's shape, and why subject and scope sit in different brackets
 *
 * `triage: <subject> <assessment> (<transition>) [<scope>]`
 *
 * Four positions, four distinct delimiters. A composer that swapped `subject`
 * and `scope` — the single most plausible edit, because §6.7 rule 3 is the one
 * place they differ — renders a DIFFERENT string, which is what lets one `toBe`
 * in the suite separate the two implementations. The same reasoning governs the
 * message, where every field carries its own label.
 */
export function composeAnnouncement(
  facts: AnnouncementFacts,
  priority: NotifyConfig["priority"],
): Announcement {
  const subject = sanitizeToken(facts.subject, TITLE_SUBJECT_BYTES);
  const scope = sanitizeToken(facts.scope, TITLE_SCOPE_BYTES);
  const title = sanitizeToken(
    `triage: ${subject} ${facts.assessment} (${facts.transition}) [${scope}]`,
    TITLE_MAX_BYTES,
  );

  const lines = [
    HEADLINE[facts.transition],
    `subject: ${sanitizeToken(facts.subject, MESSAGE_TOKEN_MAX_BYTES)}`,
    `scope: ${sanitizeToken(facts.scope, MESSAGE_TOKEN_MAX_BYTES)}`,
    `environment: ${facts.environment === null ? ABSENT : sanitizeToken(facts.environment, MESSAGE_TOKEN_MAX_BYTES)}`,
    `service: ${facts.service === null ? ABSENT : sanitizeToken(facts.service, MESSAGE_TOKEN_MAX_BYTES)}`,
    `assessment: ${facts.assessment}`,
    `transition: ${facts.transition}`,
    `sweeps observed: ${facts.sweep_count}`,
    `first seen: ${instant(facts.first_seen)}`,
    `evidence: ${facts.evidence_ref === null ? ABSENT : sanitizeToken(facts.evidence_ref, MESSAGE_TOKEN_MAX_BYTES)}`,
  ];
  if (facts.backlog !== null) lines.push(backlogLine(facts.backlog));

  return {
    schema: ANNOUNCEMENT_SCHEMA,
    kind: facts.kind,
    scope: facts.scope,
    subject: facts.subject,
    environment: facts.environment,
    service: facts.service,
    assessment: facts.assessment,
    transition: facts.transition,
    first_seen: facts.first_seen,
    sweep_count: facts.sweep_count,
    title,
    message: lines.join("\n"),
    priority: announcementPriority(facts.kind, facts.transition, priority),
    // A FRESH array per call. A shared one is a value two callers can mutate
    // into each other, which `triage-config.ts` records as the same hazard for
    // zod's by-reference defaults.
    tags: ["triage", facts.kind, facts.transition, facts.assessment],
    evidence: fenceEvidence(facts.evidence),
    evidence_ref: facts.evidence_ref,
    backlog: facts.backlog,
  };
}

// ---------------------------------------------------------------------------
// §13 task 5.6 — the adapters
// ---------------------------------------------------------------------------

/**
 * A rendered request, as a VALUE.
 *
 * `timeoutMs` and `signal` are BOTH forms of the deadline, on
 * `src/security/model-probe.ts:252`'s precedent — *"a host-side double honours
 * the signal; a containerized transport cannot be handed one and reads the
 * number instead."* `signal` is attached by {@link deliverAnnouncement}, which
 * keeps everything {@link renderRequest} produces assertable by value.
 */
export interface NotifyRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** §6.9 requirement 4: the actor reads the NAME's value from its own environment. */
export type NotifyEnvRead = (name: string) => string | undefined;

export interface RenderOptions {
  readonly env?: NotifyEnvRead;
}

const DEFAULT_ENV_READ: NotifyEnvRead = (name) => process.env[name];

/**
 * Turn an {@link Announcement} into a request through the closed adapter enum.
 *
 * ## The two things §13 task 5.6 says to get right
 *
 * **The URL is POSTed VERBATIM.** For ntfy the topic IS the path, so rewriting
 * the URL would publish to the wrong topic — or, worse, to the root, where the
 * next mistake becomes possible.
 *
 * **The `ntfy` body is plain text and never JSON.** The docs refuse JSON at a
 * topic url in a call-out box, and the failure is silent rather than loud: the
 * server accepts it and the JSON becomes the message text. A wrong
 * implementation here does not fail — it delivers garbage that looks like a
 * working notifier, which is why the anti-criterion sits in the same test as the
 * positive one.
 *
 * ## Why the title is asserted here rather than trusted
 *
 * {@link composeAnnouncement} already produces a safe title. This assertion is
 * for the OTHER caller — the one that has not been written yet — and for the
 * mutation that removes the sanitizer. §6.9: a violation is *"a composer defect
 * that fails the suite, never a delivery outcome"*, because ntfy answers an
 * oversized title with a `400` that would otherwise arrive looking like an
 * endpoint failure.
 */
export function renderRequest(
  announcement: Announcement,
  notify: NotifyConfig,
  opts?: RenderOptions,
): NotifyRequest {
  const titleIssue = headerSafeIssue(announcement.title, "title", TITLE_MAX_BYTES);
  if (titleIssue !== null) throw new NotifyCompositionError(titleIssue);

  const tags = announcement.tags.join(",");
  const tagsIssue = headerSafeIssue(tags, "tags", TAGS_MAX_BYTES);
  if (tagsIssue !== null) throw new NotifyCompositionError(tagsIssue);

  const env = opts?.env ?? DEFAULT_ENV_READ;
  const token = notify.token_env === null ? undefined : env(notify.token_env);
  const auth: Record<string, string> = token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` };

  if (notify.adapter === "json") {
    return {
      method: "POST",
      url: notify.endpoint,
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(announcement),
      timeoutMs: notify.timeout_ms,
    };
  }

  return {
    method: "POST",
    url: notify.endpoint,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: announcement.title,
      Priority: String(announcement.priority),
      Tags: tags,
      ...auth,
    },
    body: announcement.message,
    timeoutMs: notify.timeout_ms,
  };
}

/**
 * A loggable copy — §7.7's `~/.pifleet/triage.log` appends and is never
 * truncated, so a credential written there is a credential forever.
 *
 * §6.9's rejected alternatives are refused at the schema; this is the matching
 * refusal on the other end, where the value has already been read.
 */
export function redactRequest(req: NotifyRequest): NotifyRequest {
  if (req.headers.Authorization === undefined) return req;
  return { ...req, headers: { ...req.headers, Authorization: "<redacted>" } };
}

// ---------------------------------------------------------------------------
// §13 task 5.6a — the outcomes and the transport
// ---------------------------------------------------------------------------

/** §6.9 requirement 6's three classes, and they are not interchangeable. */
export type NotifyOutcomeStatus = "delivered" | "retryable" | "rejected";

/**
 * What ONE attempt produced.
 *
 * *"`delivered` is not `acknowledged`"* — a 200 is evidence the server accepted
 * bytes, not that a human read them, and `--status` uses the first word.
 */
export interface NotifyOutcome {
  readonly status: NotifyOutcomeStatus;
  /** Epoch ms, stamped by the ACTOR's clock. See {@link deliverAnnouncement}. */
  readonly at: number;
  readonly httpStatus: number | null;
  /** `null` on a delivery; a reason on everything else. */
  readonly reason: string | null;
}

/** §6.9 requirement 3's idiom, on `DockerPsRun`'s precedent (`src/monitor/read/docker.ts:122`). */
export type NotifyTransport = (req: NotifyRequest) => Promise<NotifyOutcome>;

/** The deadline factory. Injected so §12's bound can be proved without real time. */
export type NotifySignalFor = (timeoutMs: number) => AbortSignal;

/**
 * Classify one HTTP status. §6.9 requirement 6's table, as a function.
 *
 * The rule for `rejected` is written on the CLASS — *"any other non-2xx"* —
 * rather than on a number, because `docs.ntfy.sh` does not state which code an
 * auth failure returns and this file must not invent one. A 3xx lands here too:
 * a redirect on a notification endpoint is a misconfiguration, and re-sending
 * identical bytes will not fix it.
 *
 * **A `429` is retryable and is also a finding.** ntfy's limiter is a 60-request
 * burst against a console whose design target is single-digit messages a day, so
 * a `429` from this endpoint is evidence that §6.8's deduplication has broken.
 */
export function statusOutcome(status: number, at: number): NotifyOutcome {
  if (status >= 200 && status <= 299) return { status: "delivered", at, httpStatus: status, reason: null };
  const retryable = status === 429 || (status >= 500 && status <= 599);
  return {
    status: retryable ? "retryable" : "rejected",
    at,
    httpStatus: status,
    reason: `HTTP ${status}`,
  };
}

/**
 * Classify a thrown transport error.
 *
 * Always `retryable`, and that is the conservative direction rather than the lazy
 * one: §6.9 lists *"a timeout, a refused connection"* as retryable, and a
 * `rejected` fires `reporter_undelivered` on the FIRST occurrence. Guessing
 * `rejected` for an unrecognised throw would raise a misconfiguration alarm for
 * a network blip.
 */
export function errorOutcome(err: unknown, at: number): NotifyOutcome {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return { status: "retryable", at, httpStatus: null, reason: `${name}: ${message}` };
}

/**
 * The real transport, with `fetch` injected so the suite can drive it without a
 * packet.
 *
 * §12's rule is absolute — no test may reach the network, and
 * `https://ntfy.agileguy.ca/Alerts` is the operator's live endpoint. Taking
 * `fetch` as a parameter is what turns *"the default is untested"* into *"the
 * default's request shape and its whole status mapping are tested"*.
 */
export function fetchNotifyTransport(fetchImpl: typeof fetch = fetch): NotifyTransport {
  return async (req: NotifyRequest): Promise<NotifyOutcome> => {
    const timeoutMs = req.timeoutMs;
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: { ...req.headers },
        body: req.body,
        signal: req.signal ?? AbortSignal.timeout(timeoutMs),
      });
      return statusOutcome(res.status, Date.now());
    } catch (err) {
      return errorOutcome(err, Date.now());
    }
  };
}

/** The shipped default. Never exercised against a live endpoint by this suite. */
export const DEFAULT_NOTIFY_TRANSPORT: NotifyTransport = fetchNotifyTransport();

export interface DeliverDeps {
  readonly transport?: NotifyTransport;
  readonly now?: () => number;
  readonly env?: NotifyEnvRead;
  readonly signalFor?: NotifySignalFor;
}

const DEFAULT_SIGNAL_FOR: NotifySignalFor = (timeoutMs: number) => AbortSignal.timeout(timeoutMs);

/**
 * ONE bounded attempt. Returns a {@link NotifyOutcome} and NEVER `void`.
 *
 * §6.9 requirement 3 states the reason as a rule: *"a void-returning transport is
 * one whose failure is indistinguishable from its success at the call site,
 * which is the silent swallow this console exists to catch."*
 *
 * ## The bound is around the TRANSPORT, not only inside `fetch`
 *
 * §6.9 requirement 2: *"a half-open socket to an endpoint that accepted the
 * connection and will never answer has NO natural end at all: the pass blocks,
 * the loop blocks, the console stops sweeping, and the operator's only evidence
 * is silence from a console whose entire output is messages."* A signal handed to
 * `fetch` bounds `fetch`. It does not bound a transport that simply never
 * resolves — and §12 asks for exactly that fixture. So the signal is raced
 * against the call as well as passed into it.
 *
 * ## The ACTOR's clock stamps the outcome
 *
 * Whatever instant a transport reports is overwritten. A record's timestamps
 * must come from the process that owns the record, or a fixture — or, later, an
 * out-of-process transport — decides what time a delivery failed.
 */
export async function deliverAnnouncement(
  announcement: Announcement,
  notify: NotifyConfig,
  deps?: DeliverDeps,
): Promise<NotifyOutcome> {
  const now = deps?.now ?? Date.now;
  const transport = deps?.transport ?? DEFAULT_NOTIFY_TRANSPORT;
  const signalFor = deps?.signalFor ?? DEFAULT_SIGNAL_FOR;

  const rendered = renderRequest(announcement, notify, { env: deps?.env });
  const signal = signalFor(notify.timeout_ms);
  const req: NotifyRequest = { ...rendered, signal };

  const timedOut = new Promise<NotifyOutcome>((resolve) => {
    const fire = (): void =>
      resolve({
        status: "retryable",
        at: now(),
        httpStatus: null,
        reason: `timeout after ${notify.timeout_ms}ms`,
      });
    // An ALREADY-aborted signal never emits `abort`, so the listener alone would
    // hang on the one fixture written to prove this cannot hang.
    if (signal.aborted) fire();
    else signal.addEventListener("abort", fire, { once: true });
  });

  let attempt: Promise<NotifyOutcome>;
  try {
    attempt = Promise.resolve(transport(req));
  } catch (err) {
    return { ...errorOutcome(err, now()), at: now() };
  }

  const outcome = await Promise.race([attempt.catch((err: unknown) => errorOutcome(err, now())), timedOut]);
  return { ...outcome, at: now() };
}

// ---------------------------------------------------------------------------
// §13 task 5.6a — the sweep-unit backoff and the backlog
// ---------------------------------------------------------------------------

/** One lost message, retained for `--status` and NEVER replayed. */
export interface UndeliveredNote {
  readonly at: number;
  /** Retained so an operator can see WHAT was lost. Never re-sent as itself. */
  readonly title: string;
  readonly reason: string;
  readonly httpStatus: number | null;
}

/**
 * What the notifier carries between sweeps.
 *
 * Deliberately small, and deliberately NOT the incident record: §6.9 requirement
 * 7's corollary is that *"a transition is recorded before it is delivered, not
 * after"*, which is only true if the transition and the delivery touch different
 * fields on different objects.
 */
export interface DeliveryState {
  /** Consecutive `retryable` outcomes. Reset by any delivery. */
  readonly consecutive_retryable: number;
  /** Sweeps still to wait. `0` means this sweep may attempt. */
  readonly sweeps_until_retry: number;
  readonly undelivered: readonly UndeliveredNote[];
  /** §9.15: when the reporter last refused for a reason resending cannot fix. */
  readonly last_rejected_at: number | null;
}

/** A factory rather than a constant, so no two states alias one array. */
export function freshDeliveryState(): DeliveryState {
  return { consecutive_retryable: 0, sweeps_until_retry: 0, undelivered: [], last_rejected_at: null };
}

/**
 * §6.9 requirement 6's cadence-as-backoff, in SWEEP units.
 *
 * *"There is no retry loop, and the cadence is the backoff."* One attempt per
 * notification per pass, because a backoff loop inside a serial actor is the
 * stall §6.5 spent a paragraph avoiding — and a five-minute cadence is a longer
 * and better backoff than any client library would choose, at a cost of zero
 * lines.
 *
 * The doubling is read against `max_retry_sweeps` rather than against a literal,
 * so a console configured with a different cap gets a different sequence.
 */
export function backoffSweeps(consecutiveRetryable: number, maxRetrySweeps: number): number {
  if (consecutiveRetryable <= 0) return 0;
  return Math.min(2 ** (consecutiveRetryable - 1), maxRetrySweeps);
}

/** §6.9 requirement 6's *"count and a window"*, or `null` when nothing was lost. */
export function backlogWindow(state: DeliveryState): NotifyBacklog | null {
  if (state.undelivered.length === 0) return null;
  const ats = state.undelivered.map((n) => n.at);
  return { count: ats.length, from: Math.min(...ats), to: Math.max(...ats) };
}

/**
 * Fold one outcome into the state.
 *
 * Three arms, and the second and third differ in exactly the way §6.9 requires:
 * a `rejected` schedules NO backoff, because *"a credential refusal is not a
 * wedged endpoint, and must not be treated as one"* — the identical bytes cannot
 * succeed later — while a `retryable` doubles the wait.
 */
export function recordOutcome(
  state: DeliveryState,
  outcome: NotifyOutcome,
  announcement: Announcement,
  maxRetrySweeps: number,
  reporterOpen: boolean = reporterUndelivered(state),
): DeliveryState {
  if (outcome.status === "delivered") {
    return {
      consecutive_retryable: 0,
      sweeps_until_retry: 0,
      /*
       * §9.15 surface 4: *"the reporter was unable to deliver for N sweeps
       * between T1 and T2, and M notifications were LOST"*. The recovery that
       * carries those numbers can only be composed once the reporter has been
       * OBSERVED healthy again, which is one sweep after the channel first
       * answers — so a success while the reporter is still accused clears the
       * backoff and RETAINS the notes, and the message that is about them is the
       * one that spends them.
       *
       * Self-limiting rather than a leak: `reporterUndelivered` is false of the
       * state this branch returns, so the retention lasts exactly one sweep and
       * the next delivery clears it whether or not a recovery ever arrives.
       */
      undelivered: reporterOpen ? state.undelivered : [],
      last_rejected_at: null,
    };
  }
  const note: UndeliveredNote = {
    at: outcome.at,
    title: announcement.title,
    reason: outcome.reason ?? "unknown",
    httpStatus: outcome.httpStatus,
  };
  const undelivered = [...state.undelivered, note];
  if (outcome.status === "rejected") {
    return { consecutive_retryable: 0, sweeps_until_retry: 0, undelivered, last_rejected_at: outcome.at };
  }
  const n = state.consecutive_retryable + 1;
  return {
    consecutive_retryable: n,
    sweeps_until_retry: backoffSweeps(n, maxRetrySweeps),
    undelivered,
    last_rejected_at: state.last_rejected_at,
  };
}

/**
 * §9.15, as a value: does the delivery state assert that the REPORTER is the
 * thing that failed?
 *
 * *"It enters `firing` on the first `rejected` outcome and on the second
 * consecutive `retryable` one."* The asymmetry is §6.9 requirement 4's: a
 * misconfiguration that looks like a transient outage is a misconfiguration
 * nobody fixes, so it does not wait for §6.8a's confirmation.
 *
 * **This is the seam task 5.6b takes.** It maps this boolean onto the
 * `reporter_undelivered` console-health identity; this module deliberately
 * cannot reach that machine.
 */
export function reporterUndelivered(state: DeliveryState): boolean {
  return state.last_rejected_at !== null || state.consecutive_retryable >= 2;
}

/**
 * §9.15's one message whose subject is the console's own silence.
 *
 * Deliberately narrow — the ASSESSMENT *and* the TRANSITION, both. An `opened`
 * about the reporter is news that must wait its turn like anything else, and a
 * `recovered` about a service is not about the channel at all. A predicate that
 * matched either half alone would hoist messages this ordering has no claim on.
 */
export function isReporterRecovery(facts: AnnouncementFacts): boolean {
  return facts.assessment === "reporter_undelivered" && facts.transition === "recovered";
}

/**
 * §9.15 surface 4: *"that notification is delivered FIRST, ahead of the sweep's
 * own."*
 *
 * A stable partition and nothing more — §13 task 5.6b(d) is explicit that the
 * ordering *"needs no new machinery"*. Everything that is not the reporter's own
 * recovery keeps the order the caller supplied, because the caller is the actor
 * and the order it built is the order §6.8a's table produced.
 */
export function orderForDelivery(
  facts: readonly AnnouncementFacts[],
): readonly AnnouncementFacts[] {
  const recovery = facts.filter(isReporterRecovery);
  if (recovery.length === 0) return [...facts];
  return [...recovery, ...facts.filter((f) => !isReporterRecovery(f))];
}

/**
 * What the PASS decided, as opposed to what this call decided.
 *
 * Both members exist because §6.9 requirement 6 measures its backoff in SWEEPS
 * and a sweep may carry several announcements. A per-announcement reading of
 * either would turn a sweep-unit rule into an attempt-unit one, and the two are
 * the same number only on the console that never has two things to say at once.
 */
export interface PassOptions {
  /**
   * Does this call spend the pass's ONE countdown tick? {@link reportSweep} gives
   * it to the first announcement and to nothing else. Three announcements each
   * ticking would spend a twelve-sweep backoff in four sweeps.
   */
  readonly tick?: boolean;
  /**
   * Was the reporter already accused when the pass STARTED? Read once per pass,
   * because a delivery that clears the accusation mid-pass would otherwise let
   * the next announcement in the same pass spend the backlog the recovery is
   * about.
   */
  readonly reporterOpen?: boolean;
  /**
   * May this call reach the transport at all? Defaults to *"the countdown has
   * expired"*, which is the right answer for a pass carrying one announcement and
   * the wrong one for every other pass: the first announcement's own tick would
   * take the counter to zero and let the second attempt in the same sweep, and a
   * mid-pass failure's fresh backoff would be ignored by everything behind it.
   */
  readonly attempt?: boolean;
}

/** What one sweep did about one announcement. */
export type DeliveryDisposition = "attempted" | "held" | "disabled" | "nothing_to_send";

export interface DeliverySweepResult {
  readonly disposition: DeliveryDisposition;
  readonly state: DeliveryState;
  /** `null` on every disposition but `attempted`. Never `void`, never a bare boolean. */
  readonly outcome: NotifyOutcome | null;
  readonly announcement: Announcement | null;
  /**
   * What was rendered. Carries the credential when one is configured, so a
   * caller that logs it must go through {@link redactRequest} first.
   */
  readonly request: NotifyRequest | null;
}

/**
 * One sweep of the notifier: at most one attempt, and the state that carries the
 * backoff and the backlog forward.
 *
 * ## The order of the three decisions, and why it is this order
 *
 * 1. **A disabled channel does nothing at all** and returns the state
 *    UNCHANGED. §6.9 requirement 7: *"`notify: null` disables it. A console with
 *    no notifier still sweeps, still drives both state machines, and still
 *    records every transition."* A message not sent because the operator turned
 *    the channel off is not an undelivered message — *"quiet"* and *"could not
 *    speak"* must never become the same row.
 * 2. **The countdown elapses whether or not anything fired.** A wait measured in
 *    sweeps that only advanced on sweeps with news would never expire on a quiet
 *    console, which is the console this one is trying to be.
 * 3. **Only then is an attempt made**, with the backlog folded into the message
 *    that goes out.
 *
 * The rendered request is produced twice — once for the return value, once
 * inside {@link deliverAnnouncement}. That is deliberate: rendering is pure, and
 * ONE delivery code path is worth more than one saved allocation. Threading a
 * pre-rendered request through would give the sweep a way to deliver something
 * `deliverAnnouncement` never saw.
 */
export async function deliverySweep(
  facts: AnnouncementFacts | null,
  notify: NotifyConfig | null,
  state: DeliveryState,
  deps?: DeliverDeps,
  pass?: PassOptions,
): Promise<DeliverySweepResult> {
  if (notify === null) {
    return { disposition: "disabled", state, outcome: null, announcement: null, request: null };
  }
  const now = deps?.now ?? Date.now;
  const tick = pass?.tick ?? true;
  const reporterOpen = pass?.reporterOpen ?? reporterUndelivered(state);

  const waiting = state.sweeps_until_retry > 0;
  const holding = pass?.attempt === undefined ? waiting : !pass.attempt;

  if (holding) {
    const ticked: DeliveryState =
      tick && waiting ? { ...state, sweeps_until_retry: state.sweeps_until_retry - 1 } : state;
    if (facts === null) {
      return { disposition: "nothing_to_send", state: ticked, outcome: null, announcement: null, request: null };
    }
    // The announcement still HAPPENED. It joins the backlog rather than
    // vanishing, so the count the next delivered message carries is the number
    // of things the operator was not told.
    const held = composeAnnouncement({ ...facts, backlog: null }, notify.priority);
    const note: UndeliveredNote = {
      at: now(),
      title: held.title,
      reason: waiting
        ? `held by backoff (${state.sweeps_until_retry} sweep(s) remaining)`
        : "held: the channel already failed in this sweep",
      httpStatus: null,
    };
    return {
      disposition: "held",
      state: { ...ticked, undelivered: [...ticked.undelivered, note] },
      outcome: null,
      announcement: held,
      request: null,
    };
  }

  if (facts === null) {
    return { disposition: "nothing_to_send", state, outcome: null, announcement: null, request: null };
  }

  /*
   * §6.9 requirement 6, UNCONDITIONALLY: the backlog is *"appended to the next
   * message that does go out"*. Reserving it for the reporter's own recovery was
   * considered and refused — that would make the plainest sentence in the section
   * conditional on which announcement a sweep happened to carry, and §9.15's
   * recovery gets its count from the RETENTION in `recordOutcome` instead, which
   * contradicts nothing.
   */
  const announcement = composeAnnouncement({ ...facts, backlog: backlogWindow(state) }, notify.priority);
  const request = renderRequest(announcement, notify, { env: deps?.env });
  const outcome = await deliverAnnouncement(announcement, notify, deps);
  return {
    disposition: "attempted",
    state: recordOutcome(state, outcome, announcement, notify.max_retry_sweeps, reporterOpen),
    outcome,
    announcement,
    request,
  };
}

// ---------------------------------------------------------------------------
// §13 task 5.6b — §9.15's four surfaces
// ---------------------------------------------------------------------------

/**
 * §9.15 surface 3, as a value: what `pifleet triage --status` reports about the
 * CHANNEL.
 *
 * **There is no aggregate field here and there must never be one.** §6.9
 * requirement 7: *"the absence of notifications is never evidence of health, and
 * `--status` must not be readable that way … so 'quiet' and 'could not speak' are
 * never the same row."* A single `ok` boolean is exactly how those two become one
 * row, so this value reports the channel, the count, the window and the backoff
 * as separate numbers and leaves the reader to draw the conclusion.
 *
 * The other two of §12's three distinct fields — sweeps completed, and incidents
 * by state — belong to the actor, which holds the sweep counter and the record
 * set. This value is the third, and it is deliberately not aggregated with them.
 */
export interface ReporterStatus {
  /** `disabled` is a CONFIGURATION, not a failure. §6.9 requirement 7. */
  readonly channel: "enabled" | "disabled";
  readonly endpoint: string | null;
  /** How many notifications were lost. Never merged with the sweep count. */
  readonly undelivered: number;
  /** §6.9 requirement 6's window over those losses, or `null` when there are none. */
  readonly undelivered_window: NotifyBacklog | null;
  readonly consecutive_retryable: number;
  readonly sweeps_until_retry: number;
  readonly last_rejected_at: number | null;
  /** §9.15's own accusation, so the operator sees it without deriving it. */
  readonly reporter_undelivered: boolean;
}

export function reporterStatus(state: DeliveryState, notify: NotifyConfig | null): ReporterStatus {
  return {
    channel: notify === null ? "disabled" : "enabled",
    endpoint: notify === null ? null : notify.endpoint,
    undelivered: state.undelivered.length,
    undelivered_window: backlogWindow(state),
    consecutive_retryable: state.consecutive_retryable,
    sweeps_until_retry: state.sweeps_until_retry,
    last_rejected_at: state.last_rejected_at,
    reporter_undelivered: reporterUndelivered(state),
  };
}

/**
 * §9.15 surface 2, as a string: one line for `~/.pifleet/triage.log`.
 *
 * *"This is the only surface that is guaranteed to work, because it is a file on
 * the machine the actor is already running on."* It is also append-only and never
 * truncated (§7.7), so **a credential written here is a credential forever** —
 * which is why nothing from `headers` reaches this line and the request is
 * redacted before it is read at all.
 *
 * Every field is `key=value` and the title is quoted, because the title is the
 * one part composed from a subject: it is already flattened to a single line of
 * printable ASCII by {@link sanitizeToken}, so quoting is enough to keep the line
 * parseable rather than merely readable.
 */
export function deliveryLogLine(result: DeliverySweepResult): string {
  const safe = result.request === null ? null : redactRequest(result.request);
  const parts = [
    "triage-notify",
    `disposition=${result.disposition}`,
    `status=${result.outcome?.status ?? "-"}`,
    `http=${result.outcome?.httpStatus ?? "-"}`,
    `url=${safe?.url ?? "-"}`,
    `title="${result.announcement?.title ?? "-"}"`,
    `reason=${result.outcome?.reason ?? result.state.undelivered.at(-1)?.reason ?? "-"}`,
  ];
  return parts.join(" ");
}

/**
 * What one sweep's reporting pass produced, on all four of §9.15's surfaces.
 *
 * `state` is surface 1's input rather than surface 1 itself: the caller maps
 * {@link reporterUndelivered} onto `ConsoleHealthFacts.reporterUndelivered`, and
 * the incident machine — which this module cannot reach — does the rest.
 */
export interface SweepReport {
  readonly state: DeliveryState;
  /** One per announcement, in the order they were attempted. */
  readonly deliveries: readonly DeliverySweepResult[];
  /**
   * Surface 1's input: what the NEXT sweep's console-health facts should carry.
   * A value, not a decision — §6.9 requirement 7 keeps the deciding elsewhere.
   */
  readonly reporterUndelivered: boolean;
  /** Surface 2. Append these to `~/.pifleet/triage.log`; they carry no secret. */
  readonly log: readonly string[];
  /** Surface 3. */
  readonly status: ReporterStatus;
  /**
   * The titles this pass LOST, for the record's `undelivered[]`.
   *
   * That field is `string[]` and this is what fills it — the one thing a delivery
   * failure may write to a record, and it writes nothing else.
   */
  readonly lost: readonly string[];
}

/**
 * One sweep's whole reporting pass: order the announcements, attempt them under
 * the pass's single backoff decision, and return all four surfaces.
 *
 * ## The three rules that are pass-level rather than announcement-level
 *
 * 1. **§9.15 surface 4's ordering.** The reporter's own recovery is delivered
 *    FIRST, ahead of the sweep's own, because it is the only message that can
 *    carry the count and the window of what the outage lost — and the first
 *    successful delivery is what spends them.
 * 2. **One countdown tick per pass.** §6.9 requirement 6's backoff is measured in
 *    SWEEPS. Three announcements each ticking would spend a twelve-sweep wait in
 *    four sweeps, and the console would go back to hammering an endpoint it had
 *    already decided to back off from.
 * 3. **After the first failure in a pass, the rest are held.** Same arithmetic
 *    from the other side: `consecutive_retryable` is the exponent of a
 *    sweep-measured backoff, so five failures in one pass would set a
 *    sixteen-sweep wait for an outage that has lasted one sweep. The held
 *    announcements join the backlog rather than vanishing, which is what makes
 *    the count the operator eventually reads the number of things they were not
 *    told.
 *
 * ## Why an empty pass still calls through
 *
 * §6.9 requirement 6: *"the countdown elapses whether or not anything fired."* A
 * wait measured in sweeps that only advanced on sweeps with news would never
 * expire on a quiet console — which is the console this one is trying to be.
 *
 * This function never sees an incident record and could not write one if it
 * wanted to — this module cannot even name the type. It takes VALUES the caller
 * already translated, so §6.9 requirement 7's *"a transition is recorded before
 * it is delivered, not after"* is a property of the call graph rather than of
 * anyone's discipline.
 */
export async function reportSweep(
  facts: readonly AnnouncementFacts[],
  notify: NotifyConfig | null,
  state: DeliveryState,
  deps?: DeliverDeps,
): Promise<SweepReport> {
  const ordered = orderForDelivery(facts);
  const reporterOpen = reporterUndelivered(state);
  const deliveries: DeliverySweepResult[] = [];
  const lost: string[] = [];
  let current = state;

  if (ordered.length === 0) {
    const quiet = await deliverySweep(null, notify, current, deps, { tick: true, reporterOpen });
    deliveries.push(quiet);
    current = quiet.state;
  } else {
    // Rules 2 and 3, as one variable: the pass decides ONCE whether the channel
    // may be reached, and the first failure inside it revokes that for the rest.
    let mayAttempt = state.sweeps_until_retry === 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const before = current.undelivered.length;
      const result = await deliverySweep(ordered[i]!, notify, current, deps, {
        tick: i === 0,
        reporterOpen,
        attempt: mayAttempt,
      });
      deliveries.push(result);
      current = result.state;
      if (result.disposition === "attempted" && result.outcome?.status !== "delivered") {
        mayAttempt = false;
      }
      if (current.undelivered.length > before) {
        for (const note of current.undelivered.slice(before)) lost.push(note.title);
      }
    }
  }

  return {
    state: current,
    deliveries,
    reporterUndelivered: reporterUndelivered(current),
    log: deliveries.map(deliveryLogLine),
    status: reporterStatus(current, notify),
    lost,
  };
}
