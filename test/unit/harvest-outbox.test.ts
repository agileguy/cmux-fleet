/**
 * A1 outbox contract (SRD §7.2, §12.5) — ISC-94, ISC-102, ISC-120..122.
 *
 * Every test imports the production module and drives it through real files
 * in a temp directory. Nothing here re-implements a containment check or a
 * schema; the assertions are about what `readResultEnvelope` / `scanOutboxFiles`
 * RETURN for inputs a hostile worker can actually write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ENVELOPE_BYTES,
  containerPathToHost,
  readResultEnvelope,
  resolvedWithin,
  scanOutboxFiles,
  type OutboxLocation,
} from "../../src/harvest/outbox.ts";

let tmp: string;
let loc: OutboxLocation;

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

    const scan = await scanOutboxFiles(loc);
    expect(scan.safe).toContain(join(files, "good.txt"));
    expect(scan.safe).not.toContain(join(files, "evil"));
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

    const scan = await scanOutboxFiles(loc);
    expect(scan.safe).toContain(join(files, "alias"));
    expect(scan.refused).toHaveLength(0);
  });

  // Would fail if dangling links were treated as harmless: "cannot resolve"
  // is not "safe", and a link can be re-pointed between scan and read.
  test("a dangling symlink is refused", async () => {
    const files = join(loc.workerOutboxDir, "T-1", "files");
    await mkdir(files, { recursive: true });
    await symlink(join(tmp, "does-not-exist"), join(files, "dangling"));

    const scan = await scanOutboxFiles(loc);
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

    const scan = await scanOutboxFiles(loc);
    expect(scan.safe).toHaveLength(0);
    expect(scan.refused[0]?.reason).toContain("regular file");
  });
});
