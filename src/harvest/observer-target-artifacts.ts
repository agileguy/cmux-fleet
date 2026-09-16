/**
 * The two observer TARGET artifacts, as contracts the harvest validates
 * (SRD-OBSERVER-ROLES §5.6, §6.7, Phase 2).
 *
 * `observer-docker` writes `observer-docker-ops.json` and `observer-vm` writes
 * `observer-vm-ops.json`. `reconcile.ts` selects each by its file NAME, parses
 * it through the entry point below, and clamps the task to `failed` when the
 * parse refuses. That is the rule `ticket-ops.json` already runs under, for the
 * reasons `TICKET_OPS_ARTIFACT_NAME` gives.
 *
 * ## Same fields as `observer-ops.json`, and a declared kind on top
 *
 * Both documents keep the document fields and row gate fields the k8s
 * observer's document carries (`skills/observer-ops/SKILL.md`). So `assessment`,
 * `coverage[].result` and the four evidence fields mean the same thing in all
 * three roles. What each adds is a `schema` literal. The name SELECTS the
 * document and the literal CONFIRMS it, so a file at the right name that lost
 * its declaration is a schema failure rather than a skip.
 *
 * `coverage[].channel` is the one field closed differently per target, because
 * the channels are what a target can actually be asked. A docker host has no
 * systemd units and a VM has no container health check.
 *
 * ## Why the enums live here and not in the triage console
 *
 * The triage console defines the k8s observer's vocabulary. Importing it would
 * give the harvest a dependency on the console, and the SRD rules that out. The
 * four-member enums are short, so they are spelled here.
 *
 * ## No filesystem API, on purpose
 *
 * This module imports only zod and the pure contracts module, and names no
 * filesystem API. That is a claim about this file, not about `reconcile.ts`'s
 * import graph: `reconcile.ts` imports `./outbox.ts`, which imports `open` from
 * `node:fs/promises`. What the ISA pins for `reconcile.ts` (ISC-246, ISC-333)
 * is narrower, that the file itself names no filesystem API. The parse it
 * delegates here keeps that property. `test/unit/observer-target-artifacts.test.ts`
 * holds this file's import list to exactly those two modules, and its code to
 * none of a list of runtime, process, network and filesystem globals.
 */

import { z } from "zod";
import { MAX_ITEMS, MAX_SHORT, workerId } from "../contracts.ts";

/** The same bound `contracts.ts` puts on a short field of `TicketOpsArtifactSchema`. */
const shortStr = z.string().max(MAX_SHORT);

/**
 * A service's health, as the observer graded it. The closed four-member enum
 * of `skills/observer-ops/SKILL.md`. `failed` is a TASK status and is refused
 * here, because a fifth token is exactly the mistake that skill measured.
 */
export const ObserverAssessmentSchema = z.enum(["healthy", "degraded", "unhealthy", "indeterminate"]);

/** What asking one channel produced. The closed four-member enum of the same skill. */
export const ObserverCoverageResultSchema = z.enum([
  "answered",
  "unreachable",
  "forbidden",
  "not_attempted",
]);

/** What a docker observer can ask of a container (§5.6). */
export const ObserverDockerChannelSchema = z.enum(["state", "health", "logs", "stats", "events"]);

/** What a VM observer can ask of a VM (§6.7). */
export const ObserverVmChannelSchema = z.enum([
  "reachability",
  "system",
  "units",
  "logs",
  "resources",
  "cloud",
]);

/**
 * The row fields every observer target shares, less `coverage`, whose channel
 * enum is the per-target part.
 *
 * One object spread into both rows, so the two documents cannot drift apart on
 * the fields the SRD says they share.
 */
const sharedRowFields = {
  name: shortStr,
  /** The TARGET TOKEN: the named scope the service lives in on this target. */
  namespace: shortStr,
  assessment: ObserverAssessmentSchema,
  selector: shortStr,
  window: shortStr,
  evidence_ref: z.array(shortStr).max(MAX_ITEMS),
};

/**
 * The document fields every observer target shares, less `schema` and
 * `services`.
 *
 * `sweep_id` and `window_opened_at` are REQUIRED KEYS whose value may be
 * `null`. A missing key is refused. The skill treats a missing `sweep_id` as a
 * reason to discard the whole artifact, so an absent key must not read as a
 * deliberate `null`.
 */
const sharedDocumentFields = {
  worker: workerId,
  sweep_id: shortStr.nullable(),
  window_opened_at: shortStr.nullable(),
};

/** The file `observer-docker` writes to `/outbox/<task-id>/files/`. */
export const OBSERVER_DOCKER_OPS_ARTIFACT_NAME = "observer-docker-ops.json";

/** §5.6's document. One row is one container. */
export const ObserverDockerOpsArtifactSchema = z.object({
  schema: z.literal("pifleet.observer-docker-ops/v1"),
  ...sharedDocumentFields,
  services: z
    .array(
      z.object({
        ...sharedRowFields,
        coverage: z
          .array(z.object({ channel: ObserverDockerChannelSchema, result: ObserverCoverageResultSchema }))
          .max(MAX_ITEMS),
        container_id: shortStr.optional(),
        image: shortStr.optional(),
        restart_count: z.number().int().nonnegative().optional(),
      }),
    )
    .max(MAX_ITEMS),
});
export type ObserverDockerOpsArtifact = z.infer<typeof ObserverDockerOpsArtifactSchema>;

/** The file `observer-vm` writes to `/outbox/<task-id>/files/`. */
export const OBSERVER_VM_OPS_ARTIFACT_NAME = "observer-vm-ops.json";

/** §6.7's document. One row is one VM. */
export const ObserverVmOpsArtifactSchema = z.object({
  schema: z.literal("pifleet.observer-vm-ops/v1"),
  ...sharedDocumentFields,
  services: z
    .array(
      z.object({
        ...sharedRowFields,
        coverage: z
          .array(z.object({ channel: ObserverVmChannelSchema, result: ObserverCoverageResultSchema }))
          .max(MAX_ITEMS),
        uptime_s: z.number().nonnegative().optional(),
        system_state: shortStr.optional(),
        /** Unit names from `failed` output, quoted verbatim. */
        failed_units: z.array(shortStr).max(MAX_ITEMS).optional(),
      }),
    )
    .max(MAX_ITEMS),
});
export type ObserverVmOpsArtifact = z.infer<typeof ObserverVmOpsArtifactSchema>;

/**
 * `text` with every known secret value replaced by `<redacted>`.
 *
 * Blank needles are skipped, for the reason `findCredentialLeaks` skips them:
 * an empty needle matches everywhere.
 *
 * ## Every match is found in the ORIGINAL text, then each overlap is replaced once
 *
 * Replacing needle by needle cannot hide overlaps. Once the first needle is
 * gone, a second needle that shared characters with it no longer matches, and
 * part of it stays visible. The overlap test in
 * `test/unit/observer-target-artifacts.test.ts` uses two 12-character needles,
 * `a` and `b`, that share four characters. The old per-needle replacement left
 * `<redacted>` plus the last eight characters of `b` for the order `[a, b]`,
 * and the first eight characters of `a` plus `<redacted>` for `[b, a]`. A
 * needle that overlaps its own next occurrence loses its tail the same way.
 *
 * So the matches of all needles are collected first, overlapping spans merge,
 * and each merged span becomes one `<redacted>`. A secret containing a shorter
 * secret, two secrets sharing characters, and a self-overlapping secret are all
 * hidden whole. Matches that only touch stay two markers, as before.
 *
 * The search steps one character past each match so overlaps are found. One
 * needle's overlapping matches fold into a single span as they are found, so a
 * long run of a SELF-OVERLAPPING repeated secret costs one span, not one per
 * offset. A repeated secret that does not overlap itself still costs one
 * span per occurrence, because consecutive copies only touch.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const spans: Array<[start: number, end: number]> = [];
  for (const n of secrets) {
    if (typeof n !== "string" || n.trim() === "") continue;
    let start = -1;
    let end = -1;
    for (let i = text.indexOf(n); i !== -1; i = text.indexOf(n, i + 1)) {
      if (i >= end) {
        if (start !== -1) spans.push([start, end]);
        start = i;
      }
      end = i + n.length;
    }
    if (start !== -1) spans.push([start, end]);
  }
  if (spans.length === 0) return text;

  spans.sort((x, y) => x[0] - y[0]);
  let out = "";
  /** Everything before this index is already in `out`. */
  let emitted = 0;
  let [start, end] = spans[0]!;
  for (const [s, e] of spans) {
    if (s < end) {
      end = Math.max(end, e);
      continue;
    }
    out += `${text.slice(emitted, start)}<redacted>`;
    emitted = end;
    start = s;
    end = e;
  }
  return `${out}${text.slice(emitted, start)}<redacted>${text.slice(end)}`;
}

/**
 * How many levels deep the raw sweep walks. Objects and arrays count alike, and
 * the document itself is level 1.
 *
 * A safety bound on hostile input. Past it, both walks throw `RangeError` with
 * a fixed message that quotes nothing from the document and claims no
 * credential; `reconcile.ts` catches it like any other throw and clamps the task
 * to `failed`. The walks keep their own stack, so the bound is this number and
 * not however much call stack the caller has left.
 *
 * It sits above what the recursive sweep this replaced survived. Measured at
 * 1b9628e, in a bare script: about 13,900 nested arrays and 24,500 nested
 * objects. So no document that sweep accepted is refused now. Bun 1.3.11's
 * `JSON.parse` accepts 2,000,000 levels of either, so the bound is reachable.
 */
const MAX_SWEEP_DEPTH = 32_768;

/** How many hits a refusal names. The rest are counted, not named. */
const MAX_NAMED_LEAKS = 5;

/**
 * The longest a named hit may be, in characters, before it is cut.
 *
 * Not lower. `reconcile.ts` cuts its finding at 512 characters, and
 * `harvest-reconcile.test.ts` proves that cut safe with a sweep path up to
 * about 552 characters long. A path cut shorter here would stop that test
 * exercising what it is there for.
 */
const MAX_LEAK_PATH = 1024;

/** What follows a named hit that was cut. */
const PATH_CUT = "…[path truncated]";

/** One container the sweep is inside, and how far through its children it is. */
type Frame = {
  /** The key or index this container sits under. `null` for the document itself. */
  seg: string | number | null;
  /** The container, when it is an array. */
  array: readonly unknown[] | null;
  /** The container's `Object.entries`, taken once, when it is an object. */
  entries: ReadonlyArray<[string, unknown]> | null;
  /** The next child to visit. */
  next: number;
};

/** Push a frame for `node`, refusing a document deeper than `MAX_SWEEP_DEPTH`. */
function enter(stack: Frame[], node: object, seg: string | number | null, kind: string): Frame {
  if (stack.length >= MAX_SWEEP_DEPTH) {
    throw new RangeError(
      `${kind} artifact is nested more than ${MAX_SWEEP_DEPTH} levels deep, past the depth the secret sweep walks`,
    );
  }
  const frame: Frame = Array.isArray(node)
    ? { seg, array: node, entries: null, next: 0 }
    : { seg, array: null, entries: Object.entries(node), next: 0 };
  stack.push(frame);
  return frame;
}

/**
 * The dotted path to child `last` of the innermost frame, or to the innermost
 * frame itself when `last` is `null`. The spelling `findCredentialLeaks` uses,
 * so `services[0].selector` reads the same as it always has.
 *
 * Called only for a hit the refusal will name. The walks never build a path
 * for anything else.
 */
function spellPath(stack: readonly Frame[], last: string | number | null): string {
  const parts: string[] = [];
  let empty = true;
  const add = (seg: string | number | null): void => {
    if (seg === null) return;
    if (typeof seg === "number") {
      parts.push(`[${seg}]`);
      empty = false;
    } else if (empty) {
      parts.push(seg);
      empty = seg === "";
    } else {
      parts.push(`.${seg}`);
    }
  };
  for (const f of stack) add(f.seg);
  add(last);
  return parts.join("");
}

/** The hits a refusal names, and how many more it only counts. */
type Leaks = { named: string[]; more: number };

/**
 * A function that records one hit into `leaks`, given a way to spell it.
 *
 * The path is spelled only while the refusal still has room to name it, so a
 * document with a million hits costs five paths. Named paths are deduplicated
 * within one walk, as `findCredentialLeaks` and the old key sweep deduplicated
 * theirs. Once the names are full a hit is counted without being spelled, so
 * the count can include a hit whose path would repeat a named one.
 */
function recorder(leaks: Leaks): (spell: () => string) => void {
  const seen = new Set<string>();
  return (spell) => {
    if (leaks.named.length >= MAX_NAMED_LEAKS) {
      leaks.more++;
      return;
    }
    const path = spell();
    if (seen.has(path)) return;
    seen.add(path);
    leaks.named.push(path);
  };
}

/**
 * Where a known secret appears in a string VALUE of `raw`, recorded in document
 * order, in the order and spelling `findCredentialLeaks` reports.
 *
 * ## Why not `findCredentialLeaks` itself
 *
 * `contracts.ts`'s walk spells a path for EVERY string before it looks at one,
 * recurses, and returns every hit, and the refusal used to name them all. For a
 * chain of objects `d` deep with a needle at each level and `L`-character keys,
 * the paths total L·d²/2 characters. Measured at 1b9628e: a 562 KiB chain with
 * d=4000 and L=100 cost +2,324 MiB RSS, 540 ms and an 807,810,053-character
 * message. A 97 KiB document with 1000 needles under a spine 64 objects deep
 * with 1000-character keys cost +185 MiB and a 64,069,943-character message.
 * Ticket-ops still uses that function, on documents its schema has bounded.
 *
 * Here the walk keeps one frame per level and a cursor into each, spells a path
 * only through `record`, and needs `needles` already filtered of blanks.
 */
function findSecretValues(
  raw: unknown,
  needles: readonly string[],
  kind: string,
  record: (spell: () => string) => void,
): void {
  const holds = (s: string): boolean => needles.some((n) => s.includes(n));
  if (typeof raw === "string") {
    if (holds(raw)) record(() => "<root>");
    return;
  }
  if (raw === null || typeof raw !== "object") return;
  const stack: Frame[] = [];
  enter(stack, raw, null, kind);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const i = top.next++;
    let seg: string | number;
    let v: unknown;
    if (top.array !== null) {
      if (i >= top.array.length) {
        stack.pop();
        continue;
      }
      seg = i;
      v = top.array[i];
    } else {
      if (i >= top.entries!.length) {
        stack.pop();
        continue;
      }
      [seg, v] = top.entries![i]!;
    }
    if (typeof v === "string") {
      if (holds(v)) record(() => spellPath(stack, seg) || "<root>");
    } else if (v !== null && typeof v === "object") {
      enter(stack, v, seg, kind);
    }
  }
}

/**
 * Where a known secret appears as an object KEY in `raw`, named by the path of
 * the object that holds the key.
 *
 * `findSecretValues` walks string VALUES only. `{"<secret>": "x"}` passes it,
 * the schema then strips the unknown key, and the parse succeeds. The file
 * still holds the key. The harvest inventories that file by path, bytes and
 * sha256, and `src/run/relay.ts` reads `harvest.derived.artifacts` back, up to
 * a byte budget, and inlines each file's text into the reply it returns. A key
 * the parse never saw would reach whoever reads that reply.
 *
 * The finding names the PARENT, in the path spelling `findCredentialLeaks` uses,
 * and never the key, because the key is the secret. A parent path is built from
 * worker-authored keys too, so the caller still redacts it.
 *
 * `needles` must already be filtered of blanks: a blank needle matches every
 * key, which would refuse every document.
 *
 * ## The order is the one the old key sweep reported
 *
 * That sweep pushed every container child and popped the last one first, so it
 * visited each object before its children and the children last to first. This
 * walk counts each cursor DOWN to report hits in that same order.
 *
 * ## One frame per level, and no path until a hit is named
 *
 * Keys live only in objects, so a scalar can hold none, and a scalar costs
 * nothing here but a step of the cursor. The stack holds one frame per level of
 * nesting, never one entry per waiting child, and a path is spelled only for a
 * hit `record` still has room to name. The old sweep spelled a path for every
 * container it pushed, which is the same L·d²/2 cost `findSecretValues`
 * describes: measured at 1b9628e, a 555 KiB chain with a needle key at each of
 * 4000 levels cost +2,324 MiB RSS and an 807,850,060-character message.
 *
 * ## Depth
 *
 * Neither walk recurses, so depth cannot exhaust the call stack. Both refuse a
 * document deeper than `MAX_SWEEP_DEPTH` with a `RangeError`, and that
 * constant's docblock says why the bound is where it is.
 */
function findSecretKeys(
  raw: unknown,
  needles: readonly string[],
  kind: string,
  record: (spell: () => string) => void,
): void {
  if (raw === null || typeof raw !== "object") return;
  const stack: Frame[] = [];
  const visit = (node: object, seg: string | number | null): void => {
    const frame = enter(stack, node, seg, kind);
    if (frame.entries !== null && frame.entries.some(([k]) => needles.some((n) => k.includes(n)))) {
      record(() => `a key under ${spellPath(stack, null) || "<root>"}`);
    }
    frame.next = (frame.array ?? frame.entries!).length - 1;
  };
  visit(raw, null);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next < 0) {
      stack.pop();
      continue;
    }
    const i = top.next--;
    let seg: string | number;
    let v: unknown;
    if (top.array !== null) {
      seg = i;
      v = top.array[i];
    } else {
      [seg, v] = top.entries![i]!;
    }
    if (v !== null && typeof v === "object") visit(v, seg);
  }
}

/**
 * The refusal message: at most `MAX_NAMED_LEAKS` paths, each at most
 * `MAX_LEAK_PATH` characters plus `PATH_CUT`, then a count of the rest.
 *
 * ## A long path is redacted BEFORE it is cut
 *
 * A cut that lands inside a secret key leaves the secret's head, and
 * exact-match redaction cannot find a head. Redacted first, the secret is
 * already `<redacted>` wherever the cut lands. A path no longer than the cap is
 * left as it is, so the one pass over the joined list below redacts it exactly
 * as before.
 *
 * ## The joined list is redacted again
 *
 * That pass is the one the refusal always had. It also catches a secret that
 * runs across the `, ` between two paths.
 */
function refusalMessage(kind: string, leaks: Leaks, secrets: readonly string[]): string {
  const shown = leaks.named.map((path) => {
    if (path.length <= MAX_LEAK_PATH) return path;
    const redacted = redactSecrets(path, secrets);
    return redacted.length <= MAX_LEAK_PATH ? redacted : `${redacted.slice(0, MAX_LEAK_PATH)}${PATH_CUT}`;
  });
  const more = leaks.more > 0 ? ` (and ${leaks.more} more)` : "";
  return `${kind} artifact contains a credential at: ${redactSecrets(shown.join(", "), secrets)}${more}`;
}

/**
 * Sweep, then parse. The shared body of both entry points.
 *
 * ## The sweep runs over the RAW document, and it runs FIRST
 *
 * `parseTicketOpsArtifact` sweeps the parsed value. That misses a secret in a
 * key the schema does not know, because zod strips the key from the value it
 * returns while the file keeps it. The file is what travels: the harvest
 * inventories it by path, bytes and sha256, and `src/run/relay.ts` inlines the
 * text of each inventoried artifact into its reply. Sweeping the raw value
 * covers every string the file holds, and `findSecretKeys` covers every key.
 *
 * Running it before the schema means a document that is both malformed and
 * leaky is refused for the leak. Its schema messages are then never produced.
 *
 * ## The sweep's cost follows the document's size, not its shape
 *
 * The raw document is worker-authored and has no schema bounding it yet. Both
 * walks are iterative and bounded in depth, a path is spelled only for a hit
 * that will be named, and at most `MAX_NAMED_LEAKS` are named. Each named path
 * is built whole before it is redacted and cut, so the most a refusal builds is
 * `MAX_NAMED_LEAKS` paths, each a small multiple of the document's length.
 *
 * ## A refusal is a finding, not a filter
 *
 * Nothing here withholds the file. The throw becomes a finding in the harvest
 * report and clamps the task to `failed`, and the file stays in the inventory.
 * So the message says what was found and where, and claims no more than that.
 *
 * ## The refusal names PATHS, and the paths are redacted too
 *
 * A path over the raw value is built from worker-authored keys. A document that
 * uses the secret as a key would otherwise put the secret into this message.
 */
function sweepThenParse<T>(
  schema: z.ZodType<T>,
  kind: string,
  raw: unknown,
  secrets: readonly string[],
): T {
  const needles = secrets.filter((s) => typeof s === "string" && s.trim() !== "");
  if (needles.length > 0) {
    const leaks: Leaks = { named: [], more: 0 };
    findSecretValues(raw, needles, kind, recorder(leaks));
    findSecretKeys(raw, needles, kind, recorder(leaks));
    if (leaks.named.length > 0) throw new Error(refusalMessage(kind, leaks, secrets));
  }
  return schema.parse(raw);
}

/**
 * Parse an `observer-docker-ops.json` document and refuse it if a known secret
 * is inside.
 *
 * One entry point rather than two calls a caller has to remember to pair,
 * because forgetting the second is how a credential gets published into a
 * harvested artifact.
 */
export function parseObserverDockerOpsArtifact(
  raw: unknown,
  secrets: readonly string[] = [],
): ObserverDockerOpsArtifact {
  return sweepThenParse(ObserverDockerOpsArtifactSchema, "observer-docker-ops", raw, secrets);
}

/** The VM twin of `parseObserverDockerOpsArtifact`, for `observer-vm-ops.json`. */
export function parseObserverVmOpsArtifact(
  raw: unknown,
  secrets: readonly string[] = [],
): ObserverVmOpsArtifact {
  return sweepThenParse(ObserverVmOpsArtifactSchema, "observer-vm-ops", raw, secrets);
}
