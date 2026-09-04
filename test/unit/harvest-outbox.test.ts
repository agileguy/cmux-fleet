/**
 * A1 outbox contract (SRD §7.2, §12.5) — ISC-94, ISC-102, ISC-120..122.
 *
 * Every test imports the production module and drives it through real files
 * in a temp directory. Nothing here re-implements a containment check or a
 * schema; the assertions are about what `readResultEnvelope` / `scanOutboxFiles`
 * RETURN for inputs a hostile worker can actually write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_ITEMS } from "../../src/contracts.ts";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ENVELOPE_BYTES,
  MAX_HELD_DESCRIPTORS,
  closeOutboxScan,
  containerPathToHost,
  describeUnreadableEnvelope,
  readResultEnvelope,
  resolvedWithin,
  safeForReport,
  scanOutboxFiles,
  type OutboxFileScan,
  type OutboxLocation,
} from "../../src/harvest/outbox.ts";

let tmp: string;
let loc: OutboxLocation;

/**
 * Scans whose descriptors this file is holding, released in `afterEach`.
 *
 * `scanOutboxFiles` hands its caller open descriptors (ISC-246, as restated),
 * so a test that drops a scan leaks one fd per accepted artifact. That is the
 * tax the restatement charges, and the suite pays it in the same place a
 * production consumer would have to: a guaranteed release.
 */
const heldScans: OutboxFileScan[] = [];

/** `scanOutboxFiles`, with the descriptors registered for release. */
async function scanHeld(l: OutboxLocation): Promise<OutboxFileScan> {
  const s = await scanOutboxFiles(l);
  heldScans.push(s);
  return s;
}

/**
 * The accepted set, as PATHS.
 *
 * Deliberately a projection rather than a change of subject: every assertion
 * that read `scan.safe` as strings before descriptors reads it through here
 * now, so the containment and symlink tests keep asserting exactly what they
 * asserted before. Weakening one of them while its subject had no production
 * consumer is the specific mistake this projection exists to avoid.
 */
function paths(s: OutboxFileScan): string[] {
  return s.safe.map((f) => f.path);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-outbox-"));
  loc = {
    workerOutboxDir: join(tmp, "outbox", "w1"),
    taskId: "T-1",
    epoch: 1,
    containerWorkdir: "/workspace",
    hostWorkdir: join(tmp, "wt"),
  };
  await mkdir(join(loc.workerOutboxDir, "T-1"), { recursive: true });
  await mkdir(loc.hostWorkdir!, { recursive: true });
});

afterEach(async () => {
  for (const s of heldScans.splice(0)) await closeOutboxScan(s);
  await rm(tmp, { recursive: true, force: true });
});

/** A minimal envelope that passes the schema; overrides layer on top. */
function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "pifleet.result/v1",
    task_id: "T-1",
    epoch: 1,
    worker: "w1",
    status: "success",
    ...overrides,
  });
}

async function writeEnvelope(body: string): Promise<void> {
  await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), body);
}

describe("resolvedWithin", () => {
  // Would fail if containment regressed to a prefix string check: the sibling
  // directory shares the prefix "/o/w/T-1" and startsWith accepts it.
  test("a sibling directory sharing a name prefix is outside", () => {
    expect(resolvedWithin("/o/w/T-1", "/o/w/T-1-evil/x")).toBe(false);
  });

  // Would fail if the first-segment test regressed to rel.startsWith(".."):
  // a child literally named "..foo" yields rel === "..foo".
  test("a child named ..foo is inside", () => {
    expect(resolvedWithin("/o/w", "/o/w/..foo")).toBe(true);
  });

  // Would fail if `..` traversal stopped being resolved before comparison.
  test("dot-dot traversal out of the root is outside", () => {
    expect(resolvedWithin("/o/w/T-1", "/o/w/T-1/files/../../T-2")).toBe(false);
  });

  test("the root itself and a normal child are inside", () => {
    expect(resolvedWithin("/o/w/T-1", "/o/w/T-1")).toBe(true);
    expect(resolvedWithin("/o/w/T-1", "/o/w/T-1/files/a.md")).toBe(true);
  });
});

describe("containerPathToHost", () => {
  // Would fail if translation stopped requiring a path-segment boundary:
  // "/outboxes" startsWith "/outbox" but is a different mount.
  test("requires a segment boundary after the mount point", () => {
    expect(containerPathToHost("/outboxes/x", loc)).toBeNull();
    expect(containerPathToHost("/outbox/T-1/x", loc)).toBe(join(loc.workerOutboxDir, "T-1/x"));
  });

  // Would fail if unknown container paths were passed through as host paths —
  // the exact exfiltration primitive of §12.5.
  test("paths outside the mount table have no host translation", () => {
    expect(containerPathToHost("/Users/dan/.env", loc)).toBeNull();
    expect(containerPathToHost("/etc/passwd", loc)).toBeNull();
  });

  test("the workdir mount translates to the host worktree", () => {
    expect(containerPathToHost("/workspace/src/a.ts", loc)).toBe(join(loc.hostWorkdir!, "src/a.ts"));
  });
});

describe("readResultEnvelope — ISC-94 missing", () => {
  // Would fail if a missing envelope were folded into the refusal path: the
  // caller could no longer tell "worker died before writing" (fine, ISC-94)
  // from "worker wrote something hostile" (harvest-degrading).
  test("no result.json is 'missing', not an error and not a refusal", async () => {
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("missing");
  });
});

describe("readResultEnvelope — ISC-102 schema before dereference", () => {
  // Would fail if any field were dereferenced before safeParse: `artifacts`
  // here is a string, and `.map`/iteration over it before validation throws
  // instead of returning an answer.
  test("a wrong-shaped field is answered, not thrown on", async () => {
    await writeEnvelope(envelopeJson({ artifacts: "not-an-array" }));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") expect(r.unreadable.code).toBe("schema");
  });

  test("an unknown status value is caught by the schema", async () => {
    await writeEnvelope(envelopeJson({ status: "triumphant" }));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
  });

  test("non-JSON content is unreadable, not valid JSON", async () => {
    await writeEnvelope("}{ not json");
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") expect(r.unreadable.code).toBe("not_json");
  });
});

/**
 * ABSENT vs UNREADABLE — the `rev-lang-1` defect, reproduced from the artifact.
 *
 * ## The measured failure
 *
 * A live three-lens review lost a whole lens to one backslash. `rev-lang-1` was
 * asked to review REGEX CORRECTNESS, so it quoted a regex — `[\w\\-_]+` — into
 * its `summary`. `\w` is not a legal JSON escape, `JSON.parse` refused the
 * document at line 16 column 248, and every layer below behaved correctly:
 * the harvest could not parse it, the verdict settled `unknown`, the collation
 * brief said *"MISSING ASPECT: lang (rev-lang-1) — it settled `unknown` and
 * produced no report"*, and the collation recorded `reported: false`.
 *
 * The record therefore says the reviewer produced NOTHING. It produced 3906
 * bytes of genuine review that could not be read. Those are different facts,
 * and until this block existed nothing in the system could tell them apart.
 *
 * ## THE FIXTURE IS THE REAL ARTIFACT, BYTE FOR BYTE
 *
 * `test/fixtures/envelopes/rev-lang-1-unparseable-result.json` is a verbatim
 * copy of the file the live reviewer wrote, taken from the run directory and
 * not modified. A hand-typed `"{\\w}"` would prove the parser rejects a bad
 * escape — which was never in doubt — while saying nothing about a 3906-byte
 * document whose bad escape is 250 characters into line 16 of a real review.
 *
 * ## WHAT THESE PROBES CAN SEE, AND WHAT THEY CANNOT
 *
 * CAN SEE: that an existing-but-unparseable envelope is a DIFFERENT return
 * value from an absent one; that the value names the file, its size and the
 * parser's own complaint; that a syntax failure and a schema failure are told
 * apart; that nothing salvages content out of a document that did not parse.
 *
 * CANNOT SEE: whether anything downstream RENDERS any of it. These probes end
 * at `readResultEnvelope`'s return value. The wiring — that `harvestTask`
 * publishes a discrepancy an operator reads — is pinned in
 * `harvest-outbox-contract.test.ts`, deliberately in a file that drives the
 * production entry point, because a green unit suite over a value nothing
 * consumes is precisely the shape this repo keeps finding.
 *
 * CANNOT SEE, second: the sanitisation of `detail` is only partly reachable.
 * `ResultEnvelopeSchema` is NOT strict, so a hostile object KEY is stripped
 * rather than named in a zod message, and Bun's JSON parse errors name a
 * character class rather than echoing content. The one reachable path is the
 * oversized-array count, which interpolates a worker-chosen key — that is what
 * the sanitisation probe below uses, and it is the only one there is.
 *
 * ## THE ASYMMETRY, stated because this branch keeps losing it
 *
 * A fixture where absent and unreadable coincide would pass against an
 * implementation that never distinguished them. Two guard against that:
 *
 *   - the ZERO-BYTE envelope. It exists, and it holds nothing. An
 *     implementation that infers existence from content — or that treats an
 *     empty read as "no envelope" — answers `missing` and fails. It also makes
 *     `bytes: 0` a legal value, so no probe here may assert `bytes > 0`.
 *   - the SAME LOCATION, read twice in one test, once with no file and once
 *     with the real artifact. The two answers must differ. A constant-returning
 *     implementation of either kind fails one half.
 */
describe("readResultEnvelope — an envelope that exists and cannot be read", () => {
  /** The live artifact, verbatim. Read from disk so the bytes are never retyped. */
  const REAL_ARTIFACT = join(
    import.meta.dir,
    "../fixtures/envelopes/rev-lang-1-unparseable-result.json",
  );

  /** A distinctive phrase from inside the review that never parsed. */
  const REVIEW_TEXT = "Language-semantics review";

  async function writeRealArtifact(): Promise<number> {
    const bytes = await readFile(REAL_ARTIFACT);
    await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), bytes);
    return bytes.byteLength;
  }

  test("the real rev-lang-1 artifact is unreadable, and says so with the file's own facts", async () => {
    const size = await writeRealArtifact();
    const r = await readResultEnvelope(loc);

    expect(r.kind).toBe("unreadable");
    if (r.kind !== "unreadable") return;
    const u = r.unreadable;

    // The bytes are the file's ACTUAL size, asserted against the fixture rather
    // than against a literal: an implementation reporting 0, or the size of some
    // other file, fails. 3906 is what the live reviewer wrote.
    expect(size).toBe(3906);
    expect(u.bytes).toBe(size);

    // A reader must be able to FIND the file, so the path is not merely
    // asserted as a string — it is resolved. An implementation that returned
    // the directory, or a container-side `/outbox/...` spelling the host has no
    // way to open, fails here.
    expect(u.path).toBe(join(loc.workerOutboxDir, "T-1", "result.json"));
    const onDisk = await stat(u.path);
    expect(onDisk.size).toBe(u.bytes);

    // The parser's own complaint, not a generic word. "invalid" alone would
    // pass against an implementation that discarded the error.
    expect(u.code).toBe("not_json");
    expect(u.detail).toContain("Invalid escape character w");
  });

  /**
   * THE ASYMMETRIC FIXTURE. An empty file EXISTS; it just holds nothing.
   *
   * Would fail against any implementation that decides "is there an envelope?"
   * by looking at content rather than at the directory entry — including the
   * tempting `if (!text) return { kind: "missing" }`, which is exactly how a
   * worker killed mid-`write` would be misfiled as one that never reported.
   */
  test("a zero-byte envelope is unreadable, not missing", async () => {
    await writeEnvelope("");
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") {
      expect(r.unreadable.bytes).toBe(0);
      expect(r.unreadable.code).toBe("not_json");
    }
  });

  /**
   * The two states, from ONE location, in one test.
   *
   * Split across two tests this is much weaker: each half passes against an
   * implementation that answers its own kind unconditionally. Read back to
   * back against the same `loc`, only an implementation that actually looks at
   * the directory entry can satisfy both.
   */
  test("absent and unreadable are different answers from the same location", async () => {
    const absent = await readResultEnvelope(loc);
    expect(absent.kind).toBe("missing");

    await writeRealArtifact();
    const present = await readResultEnvelope(loc);
    expect(present.kind).toBe("unreadable");

    expect(present.kind).not.toBe(absent.kind);
    // And `missing` carries nothing to report, which is the whole reason it is
    // safe for ISC-94 to treat it as a non-failure.
    expect("unreadable" in absent).toBe(false);
  });

  /**
   * NO SALVAGE. The review is right there in the bytes and must stay unread.
   *
   * Re-parsing with a lenient reader, or regexing `summary` out of the text,
   * would let a document that failed validation put worker-authored prose into
   * an operator's report under the harvester's own authority — the fabrication
   * class §7.2 exists to refuse. An envelope that did not parse is not a parsed
   * envelope. This asserts on the WHOLE return value, so a salvaged field
   * smuggled in under any name fails.
   */
  test("nothing is salvaged out of a document that did not parse", async () => {
    await writeRealArtifact();
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
    expect(JSON.stringify(r)).not.toContain(REVIEW_TEXT);
  });

  /**
   * The two halves of "unreadable", told apart in ONE test.
   *
   * This is what justifies `code` existing at all. Asserted side by side
   * because separately each assertion passes against an implementation that
   * hard-codes one constant; together, only one that distinguishes "these bytes
   * are not JSON" from "this JSON is not an envelope" survives.
   */
  test("a syntax failure and a schema failure carry different codes", async () => {
    await writeRealArtifact();
    const syntax = await readResultEnvelope(loc);

    await writeEnvelope(envelopeJson({ status: "triumphant" }));
    const schema = await readResultEnvelope(loc);

    expect(syntax.kind).toBe("unreadable");
    expect(schema.kind).toBe("unreadable");
    if (syntax.kind !== "unreadable" || schema.kind !== "unreadable") return;

    expect(syntax.unreadable.code).toBe("not_json");
    expect(schema.unreadable.code).toBe("schema");
    expect(syntax.unreadable.code).not.toBe(schema.unreadable.code);

    // The schema half is still a real file with a real size, and the operator
    // needs both — a schema failure that reported `bytes: 0` would send them
    // looking for an empty file that is not what is on disk.
    expect(schema.unreadable.bytes).toBeGreaterThan(0);
    expect(schema.unreadable.path).toBe(join(loc.workerOutboxDir, "T-1", "result.json"));
  });

  /**
   * `detail` carries worker-controlled text on exactly one reachable path, and
   * that path is swept.
   *
   * The oversized-array count interpolates a KEY the worker chose. An ESC in
   * that key, printed raw into a report, writes colour codes into the terminal
   * of the operator judging the worker — the ISC-240 injection the sibling
   * `refuse` choke point already closes for `files/`. Would fail if `detail`
   * were stored as it arrived.
   */
  test("worker-chosen text in a detail is escaped, not passed through", async () => {
    const esc = String.fromCharCode(27);
    const key = `blo${esc}[31mckers`;
    const body = `{"schema":"pifleet.result/v1","task_id":"T-1","epoch":1,"worker":"w1","status":"success",${JSON.stringify(key)}:[${"1,".repeat(MAX_ITEMS + 5)}1]}`;
    await writeEnvelope(body);

    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("unreadable");
    if (r.kind !== "unreadable") return;
    expect(r.unreadable.detail).not.toContain(esc);
    expect(r.unreadable.detail).toContain("\\e");
  });

  /**
   * THE BOUNDARY. Not everything that fails is "unreadable", and the line is
   * load-bearing.
   *
   * `unreadable` means the bytes were in hand and could not be turned into an
   * envelope. A symlinked or oversized `result.json` is refused BEFORE any byte
   * is read — there is no parse error to report and no size that was parsed —
   * and a traversal in `artifacts[]` is refused AFTER a perfectly good parse.
   * Folding either into `unreadable` would describe a security refusal as a
   * formatting problem. Would fail if a later widening reclassified them.
   */
  test("refusals that are not readability failures keep their own kind", async () => {
    const outside = join(tmp, "outside.json");
    await writeFile(outside, envelopeJson());
    await symlink(outside, join(loc.workerOutboxDir, "T-1", "result.json"));
    expect((await readResultEnvelope(loc)).kind).toBe("refused");

    await rm(join(loc.workerOutboxDir, "T-1", "result.json"));
    await writeEnvelope(
      envelopeJson({ artifacts: [{ kind: "file", path: "/etc/passwd" }] }),
    );
    const traversal = await readResultEnvelope(loc);
    expect(traversal.kind).toBe("refused");
  });

  /** The rendered sentence B's half publishes carries all three facts. */
  test("the description names the path, the size and the parser's complaint", async () => {
    await writeRealArtifact();
    const r = await readResultEnvelope(loc);
    if (r.kind !== "unreadable") throw new Error("expected unreadable");
    const line = describeUnreadableEnvelope(r.unreadable);
    expect(line).toContain(r.unreadable.path);
    expect(line).toContain("3906");
    expect(line).toContain("Invalid escape character w");
    // It must not be sayable as "produced no report" — that is the sentence the
    // live run printed and the one this whole change exists to replace.
    expect(line).not.toContain("no report");
  });
});

describe("readResultEnvelope — identity binding", () => {
  // Would fail if the task_id check were dropped: a foreign task's envelope
  // would grade this one.
  test("an envelope for another task is refused", async () => {
    await writeEnvelope(envelopeJson({ task_id: "T-9" }));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  // Would fail if the epoch check were dropped: a stale attempt's envelope
  // (left on disk by epoch 1) could downgrade epoch 2's verdict.
  test("a stale epoch's envelope is refused", async () => {
    await writeEnvelope(envelopeJson({ epoch: 1 }));
    const r = await readResultEnvelope({ ...loc, epoch: 2 });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("stale");
  });
});

describe("readResultEnvelope — ISC-120 path containment", () => {
  // Would fail if artifact paths stopped being validated before use: the
  // §12.5 exfiltration primitive, verbatim.
  test("an artifact naming /Users/dan/.env is refused", async () => {
    await writeEnvelope(
      envelopeJson({ artifacts: [{ kind: "file", path: "/Users/dan/.env" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("/Users/dan/.env");
  });

  // Would fail if containment regressed to startsWith: "/outbox/T-1-evil"
  // shares the string prefix of this task's outbox but is another task's dir.
  test("a sibling task dir sharing a name prefix is refused", async () => {
    await mkdir(join(loc.workerOutboxDir, "T-1-evil"), { recursive: true });
    await writeEnvelope(
      envelopeJson({ artifacts: [{ kind: "file", path: "/outbox/T-1-evil/x" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  // Would fail if `..` segments survived translation unresolved.
  test("dot-dot traversal out of the outbox is refused", async () => {
    await writeEnvelope(
      envelopeJson({ artifacts: [{ kind: "file", path: "/outbox/T-1/../../w2/secret" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  // Would fail if files_changed paths stopped being checked: they are
  // repo-relative by contract, and "../../etc/passwd" escapes the worktree.
  test("a files_changed path escaping the worktree is refused", async () => {
    await writeEnvelope(
      envelopeJson({ files_changed: [{ path: "../../etc/passwd", change: "modified" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  test("an absolute files_changed path is refused", async () => {
    await writeEnvelope(
      envelopeJson({ files_changed: [{ path: "/etc/passwd", change: "modified" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  test("in-contract paths are accepted", async () => {
    await writeEnvelope(
      envelopeJson({
        artifacts: [{ kind: "file", path: "/outbox/T-1/files/report.md" }],
        files_changed: [{ path: "src/a.ts", change: "modified" }],
      }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("ok");
  });
});

/**
 * ISC-247 — a backslash is nothing here and a separator everywhere else.
 *
 * Both paths below pass every containment check above. node:path's POSIX
 * flavour treats `\` as an ordinary filename character, so
 * `/outbox/T-1/files/a\..\..\..\etc\passwd` is a SINGLE segment inside the
 * task outbox and `resolvedWithin` approves it — while any consumer that
 * normalizes separators (a Windows path parser, Go's `filepath`, a zip
 * extractor) reads the same bytes as traversal. That is the ISC-120 confusion
 * in a character the ISC-240 filter cannot see: 0x5C is not in C0.
 *
 * Every test here returns `ok` with the backslash refusal deleted, which is
 * the only thing that makes them mean anything.
 */
describe("readResultEnvelope — ISC-247 backslash is a separator elsewhere", () => {
  test("an artifact path containing a backslash is refused", async () => {
    await writeEnvelope(
      envelopeJson({
        artifacts: [{ kind: "file", path: "/outbox/T-1/files/a\\..\\..\\..\\etc\\passwd" }],
      }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("backslash");
  });

  test("a files_changed path containing a backslash is refused", async () => {
    await writeEnvelope(
      envelopeJson({ files_changed: [{ path: "src\\..\\..\\etc\\passwd", change: "modified" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("backslash");
  });

  /**
   * The refusal is SEPARATE from the control-character one, not folded into
   * it: `CONTROL_CHARS` never matches 0x5C, so widening that regex would be
   * the wrong fix and a shared message would misname what was found.
   */
  test("the refusal names the backslash, not a control character", async () => {
    await writeEnvelope(
      envelopeJson({ artifacts: [{ kind: "file", path: "/outbox/T-1/files/a\\b" }] }),
    );
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toContain("0x5c");
      expect(r.reason).not.toContain("control character");
    }
  });
});

describe("readResultEnvelope — ISC-122 size cap", () => {
  // Would fail if the lstat size gate were removed: the payload is NOT valid
  // JSON, so a cap-less implementation would read and parse it and return the
  // "not valid JSON" refusal instead of the size refusal asserted here.
  test("an oversized result.json is refused from the stat, unread", async () => {
    await writeEnvelope("x".repeat(MAX_ENVELOPE_BYTES + 1));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("ISC-122");
  });

  // Would fail if the envelope file itself stopped being lstat'd: a symlinked
  // result.json is the outbox-escape with no envelope content at all.
  test("a symlinked result.json is refused", async () => {
    const outside = join(tmp, "outside.json");
    await writeFile(outside, envelopeJson());
    await symlink(outside, join(loc.workerOutboxDir, "T-1", "result.json"));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("symlink");
  });

  // Would fail if the regular-file gate were removed — and it fails loudly:
  // opening a FIFO with no writer blocks, so a regression hangs the test
  // rather than passing it.
  test("a FIFO result.json is refused without being opened", async () => {
    const fifo = join(loc.workerOutboxDir, "T-1", "result.json");
    const p = Bun.spawn(["mkfifo", fifo]);
    expect(await p.exited).toBe(0);
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("regular file");
  });
});

describe("scanOutboxFiles — ISC-121 symlinks under files/", () => {
  // Would fail if the scan followed links before checking them (stat instead
  // of lstat/dirent): the escaping link would resolve to a readable file and
  // land in `safe`.
  test("a symlink escaping the outbox is refused; honest files pass", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "good.txt"), "fine");
    const secret = join(tmp, "secret.txt");
    await writeFile(secret, "hostile target");
    await symlink(secret, join(files, "evil"));

    const scan = await scanHeld(loc);
    expect(paths(scan)).toContain(join(files, "good.txt"));
    expect(paths(scan)).not.toContain(join(files, "evil"));
    expect(scan.refused.map((r) => r.path)).toContain(join(files, "evil"));
    expect(scan.refused[0]?.reason).toContain("escapes");
  });

  // Would fail if refusal became "all symlinks": an in-outbox link is a
  // legitimate reference and must stay harvestable.
  test("a symlink resolving inside the outbox is accepted", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "real.txt"), "content");
    await symlink(join(files, "real.txt"), join(files, "alias"));

    const scan = await scanHeld(loc);
    expect(paths(scan)).toContain(join(files, "alias"));
    expect(scan.refused).toHaveLength(0);
  });

  // Would fail if dangling links were treated as harmless: "cannot resolve"
  // is not "safe", and a link can be re-pointed between scan and read.
  test("a dangling symlink is refused", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await symlink(join(tmp, "does-not-exist"), join(files, "dangling"));

    const scan = await scanHeld(loc);
    expect(scan.safe).toHaveLength(0);
    expect(scan.refused[0]?.reason).toContain("resolved");
  });

  // Would fail if non-regular files stopped being refused: a FIFO under
  // files/ wedges any later reader (§12.5).
  test("a FIFO under files/ is refused", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    const p = Bun.spawn(["mkfifo", join(files, "pipe")]);
    expect(await p.exited).toBe(0);

    const scan = await scanHeld(loc);
    expect(scan.safe).toHaveLength(0);
    expect(scan.refused[0]?.reason).toContain("regular file");
  });
});

/**
 * SRD §12.5 containment, at the roots rather than the leaves.
 *
 * The per-entry symlink check was the only containment in `scanOutboxFiles`,
 * which left three ways past it — each confirmed against the real function:
 * the `files/` directory being a symlink (walked directly, so it never met the
 * per-entry branch), the task outbox being a symlink (realpath re-roots
 * containment onto the attacker's directory, after which escaping links are
 * APPROVED), and hard links (a second name for an inode that realpath cannot
 * distinguish from a real artifact).
 *
 * Each test asserts the escaping content is absent from `safe` — not merely
 * that something was refused. A scan that refuses the right path for the wrong
 * reason still passes a `refused.length > 0` assertion.
 */
describe("scanOutboxFiles — containment holds at the roots (§12.5)", () => {
  async function outboxWithSecret(): Promise<{ tmp: string; loc: OutboxLocation; secret: string }> {
    const tmp = await mkdtemp(join(tmpdir(), "pifleet-esc-"));
    const loc = {
      workerOutboxDir: join(tmp, "outbox", "w1"),
      taskId: "T-1",
      epoch: 1,
      hostWorkdir: join(tmp, "wt"),
      containerWorkdir: "/workspace",
    } as OutboxLocation;
    const secretDir = join(tmp, "private");
    await mkdir(secretDir, { recursive: true });
    const secret = join(secretDir, "id_rsa");
    await writeFile(secret, "PRIVATE KEY\n");
    return { tmp, loc, secret };
  }

  test("files/ being a symlink out does not launder the target into safe", async () => {
    const { tmp, loc, secret } = await outboxWithSecret();
    try {
      await mkdir(join(loc.workerOutboxDir, "T-1"), { recursive: true });
      await symlink(join(tmp, "private"), join(loc.workerOutboxDir, "T-1", "files"));
      const scan = await scanHeld(loc);
      expect(scan.safe).toEqual([]);
      expect(paths(scan).some((p) => p.includes("id_rsa"))).toBe(false);
      expect(await Bun.file(secret).exists()).toBe(true); // untouched, not read

      // The REASON is asserted, not just that something was refused. Two
      // independent controls can stop this attack — the root check and the
      // per-entry containment check — so an outcome-only assertion stays
      // green when either one is deleted, and the pair can be dismantled one
      // commit at a time with the suite passing throughout. Naming the root
      // check pins the root check.
      expect(scan.refused.map((r) => r.reason).join(" ")).toContain("files/ is a symlink");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("the task outbox being a symlink does not re-root containment", async () => {
    const { tmp, loc } = await outboxWithSecret();
    try {
      // The attacker's own tree, complete with a link escaping it. If the
      // scan re-roots onto `elsewhere`, that link reads as contained.
      const elsewhere = join(tmp, "elsewhere");
      await mkdir(join(elsewhere, "files"), { recursive: true });
      await symlink(join(tmp, "private", "id_rsa"), join(elsewhere, "files", "leak"));
      await mkdir(loc.workerOutboxDir, { recursive: true });
      await symlink(elsewhere, join(loc.workerOutboxDir, "T-1"));

      const scan = await scanHeld(loc);
      expect(scan.safe).toEqual([]);
      expect(JSON.stringify(paths(scan))).not.toContain("leak");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  /**
   * The attack, asserted as an OUTCOME — because which defence catches it is
   * not ours to choose.
   *
   * This test used to claim "realpath resolves this INSIDE the outbox — the
   * inode's other name is invisible from here", and pinned the `nlink`
   * refusal on the strength of it. That premise is only USUALLY true.
   * `realpath(3)` may return ANY of a hard-linked inode's names, and on
   * macOS/APFS it periodically returns the ORIGINAL one — at which point the
   * containment check fires first and the reason reads
   * `file escapes the outbox (→ …/private/id_rsa)`, which contains no
   * "link" at all. Measured, not inferred: over 60 fresh scans of this exact
   * fixture, 17 took the containment branch and 43 took `nlink` — 28%, which
   * is the ~25% suite flake this test had been contributing.
   *
   * Both branches are correct refusals of the same attack, so the outcome is
   * what is asserted here: nothing accepted, and the reason is one of the two
   * legitimate defences rather than an unrelated failure (EMFILE, "vanished",
   * the descriptor cap) that would refuse it for reasons that are not
   * security properties at all.
   *
   * The `nlink` check itself is NOT left unpinned — pinning it needs a
   * fixture where containment cannot fire, which is the test immediately
   * below.
   */
  test("a hard link to a file outside the outbox is refused", async () => {
    const { tmp, loc, secret } = await outboxWithSecret();
    try {
      const files = join(loc.workerOutboxDir, "T-1", "files");
      await mkdir(files, { recursive: true });
      await link(secret, join(files, "innocent.txt"));
      const scan = await scanHeld(loc);
      expect(scan.safe).toEqual([]);
      expect(scan.refused).toHaveLength(1);
      expect(
        scan.refused[0]!.reason,
        `refused, but by neither containment nor nlink: ${JSON.stringify(scan.refused)}`,
      ).toMatch(/^file has \d+ links;|^file escapes the outbox \(/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  /**
   * The `nlink` check, pinned on its own — the half the test above cannot
   * hold on to.
   *
   * Both names live INSIDE the outbox, so `realpath` resolves to a contained
   * path whichever one APFS hands back and the containment check CANNOT be
   * what refuses this. Only link count is left. Deleting the `nlink > 1`
   * branch turns both entries green here, which is the property the previous
   * single test was reaching for and dropped whenever the race went the other
   * way.
   *
   * That a second name inside the outbox is a less alarming scenario than a
   * stolen key is the point: `nlink` cannot tell the two apart, and this is
   * the fixture that proves the check reads link count rather than location.
   */
  test("link count alone refuses, with containment unable to fire", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "artifact.txt"), "content\n");
    await link(join(files, "artifact.txt"), join(files, "second-name.txt"));

    const scan = await scanHeld(loc);
    expect(scan.safe).toEqual([]);
    expect(scan.refused).toHaveLength(2);
    for (const r of scan.refused) {
      expect(r.reason, `not the nlink refusal: ${JSON.stringify(scan.refused)}`).toMatch(
        /^file has 2 links;/,
      );
    }
  });

  test("an ordinary artifact is still accepted — the fix is not a blanket refusal", async () => {
    const { tmp, loc } = await outboxWithSecret();
    try {
      const files = join(loc.workerOutboxDir, "T-1", "files");
      await mkdir(join(files, "sub"), { recursive: true });
      await writeFile(join(files, "note.md"), "real artifact\n");
      await writeFile(join(files, "sub", "deep.txt"), "also real\n");
      const scan = await scanHeld(loc);
      expect(scan.refused).toEqual([]);
      expect(paths(scan).map((p) => p.replace(files, "")).sort()).toEqual(["/note.md", "/sub/deep.txt"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * ISC-246 AS RESTATED — the scan validates and then HOLDS.
 *
 * The criterion as written asked for descriptors so that "a validated path
 * re-opened later" stops being a TOCTOU window. What is reachable in this
 * runtime is the LEAF half of that: each accepted artifact is opened during
 * the scan and the descriptor is what `safe` carries, so the inode that passed
 * `realpath`, `isFile` and `nlink` is the inode a consumer reads. There is no
 * second resolution for the authoring worker to race.
 *
 * WHAT THESE TESTS DO NOT COVER, and cannot:
 *
 * 1. The WALK IS STILL PATH-BASED. Node has no `openat` relative to a
 *    `FileHandle`, so `readdir` and the containment `realpath` re-resolve
 *    names from the root every time. A DIRECTORY swapped mid-walk is not
 *    caught by anything here, and holding leaf descriptors cannot catch it.
 * 2. "`nlink` is read from the DESCRIPTOR rather than from the path" is not
 *    behaviourally separable in-process: nothing can interleave a filesystem
 *    change between the `open` and the `fstat` from inside the same process,
 *    so a mutation swapping `handle.stat()` for `lstat(target)` leaves every
 *    behavioural test in this file green. It is pinned by the SOURCE GUARD at
 *    the end of this block instead, and that guard is a source scan — it
 *    checks the shape of the call, not the semantics of the result. Recorded
 *    rather than papered over.
 */
describe("scanOutboxFiles — accepted artifacts are HELD OPEN (ISC-246, restated)", () => {
  /** Would fail if `safe` went back to carrying names instead of descriptors. */
  test("an accepted artifact carries a readable descriptor, not just a name", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "note.md"), "real artifact\n");

    const scan = await scanHeld(loc);
    expect(scan.safe).toHaveLength(1);
    const held = scan.safe[0]!;
    expect(held.path).toBe(join(files, "note.md"));
    expect((await held.handle.readFile()).toString()).toBe("real artifact\n");
  });

  /**
   * THE CRITERION, stated as an observation rather than as a property.
   *
   * The path is replaced with hostile content AFTER the scan returns — the
   * exact "validated path re-opened later" the criterion names. A consumer
   * holding the descriptor still reads what was validated; a consumer holding
   * the NAME would read the replacement. Both halves are asserted, because
   * asserting only the first would stay green if the swap silently failed to
   * happen and the test would be pinning nothing.
   */
  test("the descriptor still reads the validated inode after the path is swapped", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    const artifact = join(files, "report.txt");
    await writeFile(artifact, "validated content\n");

    const scan = await scanHeld(loc);
    expect(scan.safe).toHaveLength(1);
    const held = scan.safe[0]!;

    // The worker acts between validation and use: same name, different inode.
    await rm(artifact);
    await writeFile(artifact, "hostile replacement\n");

    expect((await held.handle.readFile()).toString()).toBe("validated content\n");
    // The swap really happened — without this the assertion above is vacuous.
    expect(await Bun.file(artifact).text()).toBe("hostile replacement\n");
  });

  /**
   * The fd-exhaustion failure mode the restatement introduces, made into a
   * NAMED refusal rather than an errno.
   *
   * MEASURED, not assumed: holding one descriptor per entry hits
   * `EMFILE: too many open files` after 252 opens under a 256 soft limit,
   * which is forty times below `MAX_OUTBOX_ENTRIES`. Uncapped, a large outbox
   * would drain the process table out from under the rest of the harvest.
   */
  test("the held-descriptor budget refuses past the cap instead of exhausting the process", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    for (let i = 0; i < MAX_HELD_DESCRIPTORS + 10; i++) {
      await writeFile(join(files, `a${String(i).padStart(4, "0")}.txt`), "x");
    }

    const scan = await scanHeld(loc);
    expect(scan.safe).toHaveLength(MAX_HELD_DESCRIPTORS);
    // One refusal names the cause, not one per remaining entry.
    expect(scan.refused).toHaveLength(1);
    expect(scan.refused[0]!.reason).toContain("artifacts to hold open");
    expect(scan.refused[0]!.reason).toContain(String(MAX_HELD_DESCRIPTORS));
  });

  /**
   * The other half of the tax: someone has to release these.
   *
   * `safe` is emptied as it closes, so the second call is a no-op rather than
   * a double-close — asserted, because "idempotent" is the property a caller
   * putting this in a `finally` is relying on.
   */
  test("closeOutboxScan releases every descriptor and is idempotent", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(files, "one.txt"), "a");
    await writeFile(join(files, "two.txt"), "b");

    const scan = await scanOutboxFiles(loc);
    expect(scan.safe).toHaveLength(2);
    const handles = scan.safe.map((f) => f.handle);

    await closeOutboxScan(scan);
    expect(scan.safe).toEqual([]);
    for (const h of handles) {
      await expect(h.readFile()).rejects.toThrow(/bad file descriptor|EBADF|closed/i);
    }

    // Second call must not throw, and must not re-close a stranger's fd.
    await closeOutboxScan(scan);
    expect(scan.safe).toEqual([]);
  });

  /**
   * SOURCE GUARD, and its limits are stated where they will be read.
   *
   * See note 2 in this block's header: the fd-versus-path distinction is not
   * observable from behaviour in-process, so this scans the accept path's
   * SOURCE for the two properties that carry the restatement — the stat is
   * taken on the handle, and the open refuses to follow a link. It checks the
   * SHAPE of those calls, not what they return; a `handle.stat()` whose result
   * is then ignored would pass it. The behavioural tests above are what pin
   * the results.
   */
  test("the accept path stats the descriptor and opens with O_NOFOLLOW", async () => {
    const src = await Bun.file(new URL("../../src/harvest/outbox.ts", import.meta.url)).text();
    const start = src.indexOf("const holdIfSafe =");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("out.safe.push(", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain("handle.stat()");
    expect(body).toContain("O_NOFOLLOW");
    expect(body).toContain("O_NONBLOCK");
    // The defect this guards: re-statting the NAME after opening it, which
    // reintroduces the second resolution the descriptor exists to remove.
    expect(body).not.toContain("lstat(");
  });
});

/**
 * ISC-122's element-count limb.
 *
 * The byte cap does not bound validation COST. zod type-validates every
 * element and allocates one issue object per FAILING element before it
 * reports the length violation, so an envelope legal by bytes but packed with
 * invalid 2-byte elements cost 2.66 GB and 1.2 s to refuse — of which exactly
 * one issue is ever read.
 *
 * The valid/invalid distinction is the whole finding: the same element count
 * with VALID elements costs 127 MB, so an early measurement of that shape
 * alone made this look like a non-issue. The test uses invalid elements for
 * that reason.
 */
describe("readResultEnvelope — oversized arrays are refused before the schema", () => {
  test("an array past MAX_ITEMS is refused by count, naming the field", async () => {
    const body = `{"schema":"pifleet.result/v1","task_id":"T-1","epoch":1,"worker":"w1","status":"success","blockers":[${"1,".repeat(MAX_ITEMS + 5)}1]}`;
    await mkdir(join(loc.workerOutboxDir, "T-1"), { recursive: true });
    await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), body);
    const r = await readResultEnvelope(loc);
    // `schema`, not `not_json`: the bytes ARE valid JSON, and this count check
    // exists only because `.max(MAX_ITEMS)` inside the schema is too expensive
    // to reach (see the module docblock). It is a hoisted schema bound, so it
    // answers with the code the schema would have.
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") {
      expect(r.unreadable.code).toBe("schema");
      expect(r.unreadable.detail).toContain("blockers");
      expect(r.unreadable.detail).toContain("entries");
    }
  });

  /**
   * The cost assertion, as a WALL-CLOCK ceiling rather than an RSS reading:
   * peak memory is not observable from inside the process without sampling,
   * but the two shapes differ by 60x in time (18 ms vs 1212 ms) and that gap
   * is wide enough to survive a loaded CI box.
   */
  test("a cap-legal envelope stuffed with invalid elements refuses promptly", async () => {
    const head = '{"schema":"pifleet.result/v1","task_id":"T-1","epoch":1,"worker":"w1","status":"success","blockers":[';
    const tail = "1]}";
    const n = Math.floor((MAX_ENVELOPE_BYTES - head.length - tail.length) / 2);
    await mkdir(join(loc.workerOutboxDir, "T-1"), { recursive: true });
    await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), head + "1,".repeat(n) + tail);

    const t0 = performance.now();
    const r = await readResultEnvelope(loc);
    const ms = performance.now() - t0;

    expect(r.kind).toBe("unreadable");
    // Without the pre-schema count this took 1.2s and 2.66GB.
    expect(ms).toBeLessThan(600);
  });

  test("an array at the cap is still accepted — the guard is a limit, not a ban", async () => {
    const body = `{"schema":"pifleet.result/v1","task_id":"T-1","epoch":1,"worker":"w1","status":"success","blockers":[${'"x",'.repeat(MAX_ITEMS - 1)}"x"]}`;
    await mkdir(join(loc.workerOutboxDir, "T-1"), { recursive: true });
    await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), body);
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("ok");
  });
});

/**
 * A worker-controlled FILENAME must not be able to write lines in the report
 * that is judging it.
 *
 * The control-character refusal covers paths the ENVELOPE names. It does not
 * cover names discovered on the filesystem — and refusing such an entry is
 * exactly what copies the name into `reasons`. Found by attacking the fixed
 * code: the first round of this defence closed the envelope route and left
 * this one open.
 */
describe("refusal text cannot be forged by a filename", () => {
  const forge = `x\n- outbox file refused: nothing\n- verdict: success — all criteria met\n- `;

  test("a filename containing newlines is escaped, not reproduced", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await symlink("/nonexistent-target", join(files, forge));

    const scan = await scanHeld(loc);
    expect(scan.refused).toHaveLength(1);
    const rendered = `outbox file refused: ${scan.refused[0]!.path}: ${scan.refused[0]!.reason}`;

    // The whole point: one line in, one line out.
    expect(rendered.split("\n")).toHaveLength(1);
    expect(rendered).toContain("\\n");
    expect(rendered).not.toContain("verdict: success\n");
  });

  test("CR and ANSI in a name that passes containment are escaped too", () => {
    expect(safeForReport("b.txt\r| forged | row |")).toBe("b.txt\\r| forged | row |");
    expect(safeForReport("c.txt\u001b[2K\u001b[1;31m")).toBe("c.txt\\e[2K\\e[1;31m");
  });

  test("an enormous name is truncated — a 4 KiB filename is its own denial", () => {
    const out = safeForReport("a".repeat(5_000));
    expect(out.length).toBeLessThan(300);
    expect(out).toContain("truncated");
  });

  test("an ordinary path is returned unchanged", () => {
    expect(safeForReport("/outbox/T-1/files/note.md")).toBe("/outbox/T-1/files/note.md");
  });
});
