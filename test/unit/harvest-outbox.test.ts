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
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ENVELOPE_BYTES,
  MAX_HELD_DESCRIPTORS,
  closeOutboxScan,
  containerPathToHost,
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
  // instead of returning a refusal.
  test("a wrong-shaped field is refused, not thrown on", async () => {
    await writeEnvelope(envelopeJson({ artifacts: "not-an-array" }));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("schema");
  });

  test("an unknown status value is refused by the schema", async () => {
    await writeEnvelope(envelopeJson({ status: "triumphant" }));
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
  });

  test("non-JSON content is refused as invalid JSON", async () => {
    await writeEnvelope("}{ not json");
    const r = await readResultEnvelope(loc);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("JSON");
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

  test("a hard link to a file outside the outbox is refused", async () => {
    const { tmp, loc, secret } = await outboxWithSecret();
    try {
      const files = join(loc.workerOutboxDir, "T-1", "files");
      await mkdir(files, { recursive: true });
      // realpath resolves this INSIDE the outbox — the inode's other name is
      // invisible from here, which is exactly why nlink is the check.
      await link(secret, join(files, "innocent.txt"));
      const scan = await scanHeld(loc);
      expect(scan.safe).toEqual([]);
      expect(scan.refused.map((r) => r.reason).join(" ")).toContain("link");
    } finally {
      await rm(tmp, { recursive: true, force: true });
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
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toContain("blockers");
      expect(r.reason).toContain("entries");
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

    expect(r.kind).toBe("refused");
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
