/**
 * Artifact reconciliation — A1's claims against what the outbox holds
 * (SRD §7.2, §8.4, §12.5; ISC-246's consumer).
 *
 * ## What this file is actually pinning, and why the emphasis is odd
 *
 * The obvious half is the comparison: a claim with no file, a file with no
 * claim, and a matching pair that must produce silence. Those are easy and
 * they are not what this file exists for.
 *
 * The half that matters is that the reconciler reads through the DESCRIPTOR
 * the scan is holding, and never through the name. That distinction has a
 * measured history in this repo: a revision that closed each handle before
 * pushing it shipped in `ec9cf7e` with the accepted list full of dead file
 * descriptors, and EVERY containment and symlink test stayed green, because
 * they all read the accepted entries through a path projection and a path is
 * still correct when the fd behind it is not. Only assertions that
 * DEREFERENCE the descriptor caught it.
 *
 * So the load-bearing test here is the swap: the file on disk is replaced
 * after the scan returns, and the digest must still describe the inode that
 * passed validation. A reconciler that read by path would produce the
 * replacement's bytes and digest, and would pass every other test in this
 * file.
 *
 * ## The second emphasis: proving a NEGATIVE about dereferencing
 *
 * §12.5 names `{"kind":"file","path":"/Users/dan/.env"}` as an exfiltration
 * primitive. "The reconciler did not read that file" is an absence, and an
 * absence asserted as "no exception was thrown" is worth very little. So the
 * probes here plant a real file with known content at the claimed path and
 * assert its SHA256 appears nowhere in the result — not in the inventory, not
 * in a discrepancy string. If a future edit starts dereferencing claims, the
 * digest of the planted secret is what shows up, and these go red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MAX_ITEMS, MAX_SHORT, findCredentialLeaks } from "../../src/contracts.ts";
import {
  closeOutboxScan,
  safeForReport,
  scanOutboxFiles,
  type OutboxFileScan,
  type OutboxLocation,
} from "../../src/harvest/outbox.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_RECONCILED_BYTES,
  reconcileArtifactClaims,
  type ArtifactClaim,
  type ArtifactReconciliation,
} from "../../src/harvest/reconcile.ts";

let tmp: string;
let loc: OutboxLocation;
let files: string;

/** Scans whose descriptors this file is holding, released in `afterEach`. */
const heldScans: OutboxFileScan[] = [];

/** `scanOutboxFiles`, with the descriptors registered for release. */
async function scanHeld(l: OutboxLocation = loc): Promise<OutboxFileScan> {
  const s = await scanOutboxFiles(l);
  heldScans.push(s);
  return s;
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A claim list, typed so a bad `kind` is a compile error rather than a skip. */
function claims(...refs: ArtifactClaim[]): ArtifactClaim[] {
  return refs;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-reconcile-"));
  loc = {
    workerOutboxDir: join(tmp, "outbox", "w1"),
    taskId: "T-1",
    epoch: 1,
    containerWorkdir: "/workspace",
    hostWorkdir: join(tmp, "wt"),
  };
  files = join(loc.workerOutboxDir, "T-1", "files");
  await mkdir(files, { recursive: true });
  await mkdir(loc.hostWorkdir!, { recursive: true });
});

afterEach(async () => {
  for (const s of heldScans.splice(0)) await closeOutboxScan(s);
  await rm(tmp, { recursive: true, force: true });
});

describe("reconcileArtifactClaims — the two directions of disagreement", () => {
  test("a matching claim produces no discrepancy at all", async () => {
    await writeFile(join(files, "note.md"), "real artifact\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/note.md" }),
      loc,
    );

    expect(r.discrepancies).toEqual([]);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]!.path).toBe(join(files, "note.md"));
    expect(r.artifacts[0]!.bytes).toBe("real artifact\n".length);
    expect(r.artifacts[0]!.sha256).toBe(sha256("real artifact\n"));
  });

  /**
   * THE VALIDATOR AND THE RECONCILER MUST READ A PATH THE SAME WAY.
   *
   * `artifactPathProblem` accepts a relative artifact path, resolving it
   * against the task outbox; this pass used to resolve only through the mount
   * table, which answers null for anything non-absolute. The result was an
   * accepted envelope whose report contradicted itself twice about one file:
   * "outside the container mount table" here, and "does not claim" from the
   * reverse pass immediately after. Both assertions below fail on that code —
   * the discrepancy list is not empty and the claim never matches.
   */
  test("a relative claim reconciles against the same file an absolute one names", async () => {
    await writeFile(join(files, "review.md"), "the lost review\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "files/review.md" }),
      loc,
    );

    expect(r.discrepancies).toEqual([]);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]!.path).toBe(join(files, "review.md"));
    expect(r.artifacts[0]!.sha256).toBe(sha256("the lost review\n"));
  });

  /**
   * The other half of reading it the same way: agreeing on a relative path
   * does NOT mean agreeing to follow one out of `files/`. The containment
   * check is unchanged and still refuses, and it must refuse with the reason
   * that is true — the old mount-table sentence was accurate about neither
   * where the path went nor why it was rejected.
   */
  test("a relative claim that climbs out of files/ is refused by containment, not by the mount table", async () => {
    await writeFile(join(files, "review.md"), "the lost review\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "../result.json" }),
      loc,
    );

    expect(r.discrepancies).toHaveLength(2);
    const claimLine = r.discrepancies.find((d) => d.includes("result.json"));
    expect(claimLine).toContain("not under the task outbox files/ directory");
    expect(claimLine).not.toContain("mount table");
    // And the real artifact, unclaimed by this envelope, is still reported.
    expect(r.discrepancies.some((d) => d.includes("review.md") && d.includes("does not claim"))).toBe(
      true,
    );
  });

  /**
   * The claim the harvester previously had no opinion about: a worker naming
   * an artifact it never wrote. `artifactPathProblem` accepts it — the path is
   * inside the outbox and lexically legal — so nothing before this rejected it.
   */
  test("a claimed artifact that is not in the outbox is a discrepancy", async () => {
    await writeFile(join(files, "note.md"), "real artifact\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims(
        { kind: "file", path: "/outbox/T-1/files/note.md" },
        { kind: "file", path: "/outbox/T-1/files/imaginary.md" },
      ),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("imaginary.md");
    expect(r.discrepancies[0]).toContain("did not accept");
    // The real one still reconciled; a hostile claim does not void the batch.
    expect(r.artifacts).toHaveLength(1);
  });

  test("an artifact in the outbox that the envelope never claims is a discrepancy", async () => {
    await writeFile(join(files, "claimed.md"), "declared\n");
    await writeFile(join(files, "smuggled.md"), "undeclared\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/claimed.md" }),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("smuggled.md");
    expect(r.discrepancies[0]).toContain("does not claim");
    // Both are still inventoried: an unclaimed artifact is a finding, not a
    // refusal, and it passed every containment check the scan applies.
    expect(r.artifacts.map((a) => a.path).sort()).toEqual(
      [join(files, "claimed.md"), join(files, "smuggled.md")].sort(),
    );
  });

  /**
   * The evasion an earlier revision of the reconciler was open to, kept as a
   * test because the fix is an ORDERING and orderings drift back.
   *
   * "Unclaimed" is a fact about two sets and must not depend on the content
   * read succeeding. When the finding was emitted from the digest loop's
   * success branch, an artifact larger than the per-artifact cap took its own
   * concealment finding off the report on the way past.
   */
  test("an oversized unclaimed artifact is still reported as unclaimed", async () => {
    await writeFile(join(files, "big.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(scan, claims(), loc);

    const joined = r.discrepancies.join("\n");
    expect(joined).toContain("does not claim");
    expect(joined).toContain("per-artifact cap");
    expect(r.artifacts).toEqual([]);
  });

  /**
   * `kind` is a content hint, not a switch that decides whether a path is
   * real. `readResultEnvelope` contains EVERY artifact path through
   * `artifactPathProblem` regardless of kind, so a `log` names an outbox file
   * exactly as much as a `file` does — and reconciling only `file` would
   * report a correctly-labelled build log as unclaimed.
   */
  test("kinds other than file are reconciled too, and the kind is reported", async () => {
    await writeFile(join(files, "build.log"), "compiling\n");
    const scan = await scanHeld();

    const matched = await reconcileArtifactClaims(
      scan,
      claims({ kind: "log", path: "/outbox/T-1/files/build.log" }),
      loc,
    );
    expect(matched.discrepancies).toEqual([]);

    const missing = await reconcileArtifactClaims(
      scan,
      claims(
        { kind: "log", path: "/outbox/T-1/files/build.log" },
        { kind: "note", path: "/outbox/T-1/files/absent.txt" },
      ),
      loc,
    );
    expect(missing.discrepancies).toHaveLength(1);
    expect(missing.discrepancies[0]).toContain("kind note");
  });

  /**
   * A missing or refused envelope is not an envelope that claimed nothing.
   *
   * ISC-94 is explicit that a worker dying before it writes `result.json` is
   * not a failure, and the harvest already records that absence once. Emitting
   * "not claimed" per artifact would restate it once per file — forty lines
   * that all mean the same thing — so the reverse direction stays silent while
   * the inventory is still built.
   */
  test("no envelope means no findings in either direction, but still an inventory", async () => {
    await writeFile(join(files, "orphan.md"), "written before the crash\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(scan, null, loc);

    expect(r.discrepancies).toEqual([]);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]!.sha256).toBe(sha256("written before the crash\n"));
  });

  test("an envelope claiming nothing while the outbox holds files is not the same case", async () => {
    await writeFile(join(files, "orphan.md"), "written before the crash\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(scan, claims(), loc);

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("does not claim");
  });

  test("a claimed artifact that exists but is empty is a discrepancy", async () => {
    await writeFile(join(files, "report.md"), "");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/report.md" }),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("present but empty");
    expect(r.artifacts[0]!.bytes).toBe(0);
    expect(r.artifacts[0]!.sha256).toBe(sha256(""));
  });
});

/**
 * §12.5's exfiltration primitive, and the assertion that it stayed shut.
 *
 * Each probe plants a REAL file with known content at the place the claim
 * names, so "nothing was read" is falsifiable: if the reconciler ever
 * dereferences a claimed path, the planted content's digest is what appears in
 * the result. Asserting only that no exception escaped would pass against a
 * reconciler that read the file and quietly hashed it into the report.
 */
describe("reconcileArtifactClaims — a claimed path is never dereferenced", () => {
  test("a claim outside the mount table is refused and the file is not read", async () => {
    const secretDir = join(tmp, "home");
    await mkdir(secretDir, { recursive: true });
    const secret = join(secretDir, ".env");
    const body = "ANTHROPIC_API_KEY=sk-do-not-read-me\n";
    await writeFile(secret, body);

    await writeFile(join(files, "note.md"), "real artifact\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims(
        { kind: "file", path: secret },
        { kind: "file", path: "/etc/passwd" },
        { kind: "file", path: "/outbox/T-1/files/note.md" },
      ),
      loc,
    );

    expect(r.discrepancies).toHaveLength(2);
    for (const d of r.discrepancies) expect(d).toContain("outside the container mount table");

    // The inventory is the outbox's own artifact and nothing else.
    expect(r.artifacts.map((a) => a.path)).toEqual([join(files, "note.md")]);

    // The load-bearing negative: the planted secret was never digested, and
    // its content never reached a report string.
    const everything = JSON.stringify(r);
    expect(everything).not.toContain(sha256(body));
    expect(everything).not.toContain("sk-do-not-read-me");
  });

  /**
   * The subtler case, and the reason the reconciler re-derives containment
   * instead of trusting that `readResultEnvelope` filtered for it.
   *
   * `artifactPathProblem` permits a claim anywhere under the task outbox OR
   * the worktree — a worker referencing a file it edited is legitimate — so
   * `/outbox/T-1/result.json` and `/workspace/.env` both reach this function
   * in production. Neither is an outbox artifact, and the worktree in
   * particular is a whole repository of things that must not be hashed into a
   * report. Only `files/` is a candidate.
   */
  test("a claim inside the mount table but outside files/ is refused and not read", async () => {
    const worktreeSecret = join(loc.hostWorkdir!, ".env");
    const body = "DATABASE_URL=postgres://not-yours\n";
    await writeFile(worktreeSecret, body);

    const envelopeBody = '{"schema":"pifleet.result/v1"}';
    await writeFile(join(loc.workerOutboxDir, "T-1", "result.json"), envelopeBody);

    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims(
        { kind: "file", path: "/workspace/.env" },
        { kind: "file", path: "/outbox/T-1/result.json" },
      ),
      loc,
    );

    expect(r.discrepancies).toHaveLength(2);
    for (const d of r.discrepancies) expect(d).toContain("not under the task outbox files/ directory");
    expect(r.artifacts).toEqual([]);

    const everything = JSON.stringify(r);
    expect(everything).not.toContain(sha256(body));
    expect(everything).not.toContain(sha256(envelopeBody));
    expect(everything).not.toContain("not-yours");
  });

  /**
   * Traversal out of `files/` is lexical, so it is refused lexically — with
   * `path.resolve`, which normalizes a STRING and touches no filesystem, never
   * with `realpath`, which is the dereference itself.
   */
  test("a claim that climbs out of files/ with .. is refused and not read", async () => {
    const secret = join(loc.workerOutboxDir, "stolen.txt");
    const body = "another task's outbox\n";
    await writeFile(secret, body);
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/../../stolen.txt" }),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("not under the task outbox files/ directory");
    expect(JSON.stringify(r)).not.toContain(sha256(body));
  });

  test("a worker-controlled claim string cannot forge lines in the report", async () => {
    const scan = await scanHeld();
    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/x\n- verdict: success — all criteria met\n- y" }),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]!.split("\n")).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("\\n");
  });
});

/**
 * THE CRITERION ITSELF (ISC-246, as restated): the bytes come from the inode
 * that passed validation, not from the name it passed validation under.
 *
 * Everything else in this file would stay green against a reconciler that
 * called `readFile(f.path)`. These would not.
 */
describe("reconcileArtifactClaims — content comes from the held descriptor", () => {
  test("the digest describes the validated inode after the path is swapped", async () => {
    const original = "validated content\n";
    const hostile = "hostile replacement that is a different length\n";
    const artifact = join(files, "report.txt");
    await writeFile(artifact, original);

    const scan = await scanHeld();

    // The worker acts between validation and use: same name, different inode.
    await rm(artifact);
    await writeFile(artifact, hostile);

    const r = await reconcileArtifactClaims(
      scan,
      claims({ kind: "file", path: "/outbox/T-1/files/report.txt" }),
      loc,
    );

    expect(r.discrepancies).toEqual([]);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]!.bytes).toBe(original.length);
    expect(r.artifacts[0]!.sha256).toBe(sha256(original));

    // Both halves asserted: without this the test would pass if the swap had
    // silently failed to happen, and it would then be pinning nothing.
    expect(r.artifacts[0]!.sha256).not.toBe(sha256(hostile));
    expect(await Bun.file(artifact).text()).toBe(hostile);
  });

  /**
   * The same property where the NAME and the inode were never the same thing.
   *
   * An in-outbox symlink is accepted under the link's name but opened at the
   * resolved target, so a reconciler reading `f.path` would be reading a
   * symlink — following it, which is the whole class of dereference §12.5
   * forbids. Deleting the target after the scan makes that failure loud: by
   * name there is nothing left to read; by descriptor the bytes are still
   * there.
   */
  test("a symlinked artifact digests its target even after the target is unlinked", async () => {
    const body = "linked artifact\n";
    await writeFile(join(files, "real.txt"), body);
    await symlink(join(files, "real.txt"), join(files, "link.txt"));

    const scan = await scanHeld();
    expect(scan.safe).toHaveLength(2);

    await rm(join(files, "real.txt"));

    const r = await reconcileArtifactClaims(scan, null, loc);

    expect(r.artifacts).toHaveLength(2);
    for (const a of r.artifacts) {
      expect(a.bytes, `${a.path} did not read the validated inode`).toBe(body.length);
      expect(a.sha256).toBe(sha256(body));
    }
  });

  /**
   * The production detector for the defect that reached `main` under ISC-246's
   * M1: descriptors validated, then closed before being handed over.
   *
   * The accepted list came back full of dead fds and the whole suite stayed
   * green, because nothing dereferenced one. A reconciler that reads by path
   * would ALSO stay green here — the file is still on disk — which is exactly
   * why the finding is worth a line in the harvest report.
   */
  test("a descriptor that cannot be read is a named discrepancy, not a throw", async () => {
    await writeFile(join(files, "note.md"), "content\n");
    const scan = await scanHeld();

    // Precisely the M1 state: the entry is in the accepted list, its path is
    // still correct, and its handle is dead.
    await scan.safe[0]!.handle.close();

    const r = await reconcileArtifactClaims(scan, null, loc);

    expect(r.artifacts).toEqual([]);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("could not be read through its held descriptor");
    expect(r.discrepancies[0]).toContain("note.md");
  });
});

/**
 * The byte caps §12.5 asks for ("cap harvested bytes per task and per run").
 *
 * Both refuse BY NAME rather than by exception or by OOM, and neither emits a
 * partial digest: a sha256 over a truncated prefix published in a field called
 * `sha256` is a wrong answer, not an approximate one.
 */
describe("reconcileArtifactClaims — the byte caps refuse by name", () => {
  test("an artifact past the per-artifact cap is named and left out of the inventory", async () => {
    await writeFile(join(files, "huge.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x62));
    await writeFile(join(files, "small.txt"), "fine\n");
    const scan = await scanHeld();

    const r = await reconcileArtifactClaims(
      scan,
      claims(
        { kind: "file", path: "/outbox/T-1/files/huge.bin" },
        { kind: "file", path: "/outbox/T-1/files/small.txt" },
      ),
      loc,
    );

    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("huge.bin");
    expect(r.discrepancies[0]).toContain("per-artifact cap");
    expect(r.discrepancies[0]).toContain(String(MAX_ARTIFACT_BYTES));

    // The oversized one is absent rather than partially digested; its
    // well-behaved neighbour is unaffected.
    expect(r.artifacts.map((a) => a.path)).toEqual([join(files, "small.txt")]);
  });

  /**
   * The per-TASK cap, which the per-artifact cap does not imply:
   * `MAX_HELD_DESCRIPTORS` is 128, so 128 artifacts just under the per-artifact
   * cap is about a gigabyte of reads for one task, and `harvestAll` loops over
   * every task in the run.
   */
  test("reconciliation stops at the per-task cap and says so once", async () => {
    const each = MAX_ARTIFACT_BYTES;
    const n = MAX_RECONCILED_BYTES / each;
    expect(Number.isInteger(n)).toBe(true);
    for (let i = 0; i < n; i++) {
      await writeFile(join(files, `a${String(i).padStart(2, "0")}.bin`), Buffer.alloc(each, 0x63));
    }
    // Three more, so "one finding, not one per remaining artifact" is testable.
    for (const extra of ["z1.bin", "z2.bin", "z3.bin"]) {
      await writeFile(join(files, extra), "over the line\n");
    }

    const scan = await scanHeld();
    const r = await reconcileArtifactClaims(scan, null, loc);

    expect(r.artifacts).toHaveLength(n);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain("per-task cap");
    expect(r.discrepancies[0]).toContain(String(MAX_RECONCILED_BYTES));
    // The line declares its own truncation, so the partial inventory above it
    // is not mistaken for the whole outbox.
    expect(r.discrepancies[0]).toContain("not digested");
  }, 30_000);
});

/**
 * THE OBSERVER TARGET ARTIFACTS (SRD-OBSERVER-ROLES §5.6, §6.7; Phase 2 tasks
 * 2.1 and 2.2).
 *
 * `observer-docker-ops.json` and `observer-vm-ops.json` are held to the rule
 * `ticket-ops.json` already is. Each is selected on the file's NAME and parsed
 * through one entry point that pairs the schema with the credential sweep. Each
 * clamps the task to `failed` when it will not parse, will not validate,
 * carries a known secret, or is refused by a byte cap.
 *
 * The names are SPELLED here rather than imported, for the reason
 * `harvest-ticket-ops-wiring.test.ts` gives. A test that imports the
 * selector's own constant cannot tell a correct selection from a constant and
 * a selection that drifted together.
 *
 * Every clamp is measured against a CONTROL through the same helper, and the
 * control demonstrably reaches `verdictCeiling: null`. A "clamps to failed"
 * assertion on a fixture that could never reach `null` would pin nothing.
 */
const DOCKER_OPS = "observer-docker-ops.json";
const VM_OPS = "observer-vm-ops.json";

/**
 * An identifier-shaped secret, on purpose. The JSON parser quotes a bare
 * identifier token in full in its error message, so this needle is one a
 * not-JSON finding would echo if nothing redacted it.
 */
const NEEDLE = "ghp_obsNeedle7f3a9c2e41";

/** §5.6's document, well formed, so each probe perturbs exactly one thing. */
function dockerDoc(): Record<string, unknown> {
  return {
    schema: "pifleet.observer-docker-ops/v1",
    worker: "obs-d1",
    sweep_id: null,
    window_opened_at: null,
    services: [
      {
        name: "web-1",
        namespace: "docker-host-a",
        assessment: "healthy",
        coverage: [
          { channel: "state", result: "answered" },
          { channel: "health", result: "answered" },
          { channel: "logs", result: "answered" },
          { channel: "stats", result: "not_attempted" },
          { channel: "events", result: "forbidden" },
        ],
        selector: "name=web-1",
        window: "300s",
        evidence_ref: [
          "observe-docker docker-host-a inspect web-1: State.Status=running, Health=healthy, RestartCount=0",
        ],
        container_id: "4f1c2b9d8e7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e",
        image: "nginx:1.27",
        restart_count: 0,
      },
    ],
  };
}

/** §6.7's document, well formed. */
function vmDoc(): Record<string, unknown> {
  return {
    schema: "pifleet.observer-vm-ops/v1",
    worker: "obs-v1",
    sweep_id: null,
    window_opened_at: null,
    services: [
      {
        name: "vm-1",
        namespace: "vm-fleet-a",
        assessment: "degraded",
        coverage: [
          { channel: "reachability", result: "answered" },
          { channel: "system", result: "answered" },
          { channel: "units", result: "answered" },
          { channel: "logs", result: "answered" },
          { channel: "resources", result: "unreachable" },
          { channel: "cloud", result: "not_attempted" },
        ],
        selector: "host=vm-1.example.com",
        window: "300s",
        evidence_ref: ["observe-vm vm-fleet-a vm-1 systemctl --failed: 1 unit"],
        uptime_s: 86_400.5,
        system_state: "degraded",
        failed_units: ["nginx.service"],
      },
    ],
  };
}

/** The first row of a document, for a probe to perturb. */
function firstRow(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc["services"] as Array<Record<string, unknown>>)[0]!;
}

/**
 * Write `body` at `rel` under a FRESH `files/`, claim exactly that file, and
 * reconcile.
 *
 * Fresh because several probes share one test. A file left over from the
 * previous probe would be unclaimed by this one's envelope and add a finding
 * that has nothing to do with the document under test.
 */
async function reconcileNamed(
  rel: string,
  body: string | Buffer,
  secrets?: readonly string[],
): Promise<ArtifactReconciliation> {
  await rm(files, { recursive: true, force: true });
  await mkdir(dirname(join(files, rel)), { recursive: true });
  await writeFile(join(files, rel), body);
  const scan = await scanHeld();
  return reconcileArtifactClaims(
    scan,
    claims({ kind: "file", path: `/outbox/T-1/files/${rel}` }),
    loc,
    secrets === undefined ? {} : { secrets },
  );
}

/** The control: the document passed, and the outbox's contents raised no ceiling. */
function expectClean(r: ArtifactReconciliation, label: string): void {
  expect(r.discrepancies, label).toEqual([]);
  expect(r.verdictCeiling, label).toBeNull();
  expect(r.verdictCeilingReason, label).toBeNull();
}

/**
 * A clamp, attributed to ITS file and worded for an observer.
 *
 * The finding must open with the artifact's own name, so the name comes from
 * the text and not from the path that happens to follow it. The reason must
 * name the file and say what cannot be known. Neither may mention tickets:
 * existing tests filter findings on `"ticket-ops"`, and an observer finding
 * that matched would pollute them.
 */
function expectClamped(r: ArtifactReconciliation, name: string, label: string): void {
  expect(r.discrepancies, label).toHaveLength(1);
  expect(r.discrepancies[0]!.startsWith(`${name} artifact `), `${label}: ${r.discrepancies[0]}`).toBe(
    true,
  );
  expect(r.discrepancies[0], label).not.toContain("ticket-ops");
  expect(r.verdictCeiling, label).toBe("failed");
  expect(r.verdictCeilingReason, label).toContain(name);
  expect(r.verdictCeilingReason, label).toContain("what the observer saw");
  expect(r.verdictCeilingReason, label).not.toContain("ticket");
}

describe("reconcileArtifactClaims — observer target artifacts are validated by name", () => {
  test("a well-formed observer-docker-ops.json passes cleanly", async () => {
    expectClean(await reconcileNamed(DOCKER_OPS, JSON.stringify(dockerDoc())), "full row");

    // The three optional row fields really are optional.
    const bare = dockerDoc();
    for (const k of ["container_id", "image", "restart_count"]) delete firstRow(bare)[k];
    expectClean(await reconcileNamed(DOCKER_OPS, JSON.stringify(bare)), "no optional fields");

    // `sweep_id` and `window_opened_at` may carry a value as well as null.
    const swept = dockerDoc();
    swept["sweep_id"] = "sweep-17";
    swept["window_opened_at"] = "2026-09-13T10:00:00.000Z";
    expectClean(await reconcileNamed(DOCKER_OPS, JSON.stringify(swept)), "string sweep fields");
  });

  test("a well-formed observer-vm-ops.json passes cleanly", async () => {
    expectClean(await reconcileNamed(VM_OPS, JSON.stringify(vmDoc())), "full row");

    const bare = vmDoc();
    for (const k of ["uptime_s", "system_state", "failed_units"]) delete firstRow(bare)[k];
    expectClean(await reconcileNamed(VM_OPS, JSON.stringify(bare)), "no optional fields");
  });

  test("a malformed observer-docker-ops.json clamps to failed", async () => {
    // THE CONTROL, FIRST: the same helper and the same name reach no ceiling.
    expectClean(await reconcileNamed(DOCKER_OPS, JSON.stringify(dockerDoc())), "control");

    const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
      ["assessment is a task status", (d) => (firstRow(d)["assessment"] = "failed")],
      [
        "a channel outside the five",
        (d) => (firstRow(d)["coverage"] = [{ channel: "rollout", result: "answered" }]),
      ],
      [
        "a coverage result outside the four",
        (d) => (firstRow(d)["coverage"] = [{ channel: "state", result: "failed" }]),
      ],
      ["the VM twin's schema literal", (d) => (d["schema"] = "pifleet.observer-vm-ops/v1")],
      ["the k8s observer's schema literal", (d) => (d["schema"] = "pifleet.observer-ops/v1")],
      ["no schema literal", (d) => delete d["schema"]],
      ["a missing sweep_id key", (d) => delete d["sweep_id"]],
      ["a missing window_opened_at key", (d) => delete d["window_opened_at"]],
      ["a worker that is not a worker id", (d) => (d["worker"] = "obs d1\n")],
      ["no services", (d) => delete d["services"]],
      ["a row with no evidence_ref", (d) => delete firstRow(d)["evidence_ref"]],
      ["a row with no selector", (d) => delete firstRow(d)["selector"]],
      ["a row with no coverage", (d) => delete firstRow(d)["coverage"]],
      ["a negative restart_count", (d) => (firstRow(d)["restart_count"] = -1)],
      ["a fractional restart_count", (d) => (firstRow(d)["restart_count"] = 1.5)],
      ["an unbounded selector", (d) => (firstRow(d)["selector"] = "x".repeat(MAX_SHORT + 1))],
      [
        "more rows than MAX_ITEMS",
        (d) => (d["services"] = Array.from({ length: MAX_ITEMS + 1 }, () => firstRow(dockerDoc()))),
      ],
    ];
    for (const [label, perturb] of cases) {
      const doc = dockerDoc();
      perturb(doc);
      const r = await reconcileNamed(DOCKER_OPS, JSON.stringify(doc));
      expectClamped(r, DOCKER_OPS, label);
      expect(r.discrepancies[0], label).toContain("validation");
    }
  });

  test("a malformed observer-vm-ops.json clamps to failed", async () => {
    expectClean(await reconcileNamed(VM_OPS, JSON.stringify(vmDoc())), "control");

    const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
      ["assessment is a task status", (d) => (firstRow(d)["assessment"] = "failed")],
      [
        "a channel outside the six",
        (d) => (firstRow(d)["coverage"] = [{ channel: "rollout", result: "answered" }]),
      ],
      ["the docker twin's schema literal", (d) => (d["schema"] = "pifleet.observer-docker-ops/v1")],
      ["no schema literal", (d) => delete d["schema"]],
      ["a missing sweep_id key", (d) => delete d["sweep_id"]],
      ["a missing window_opened_at key", (d) => delete d["window_opened_at"]],
      ["a row with no namespace", (d) => delete firstRow(d)["namespace"]],
      ["a row with no window", (d) => delete firstRow(d)["window"]],
      ["a negative uptime_s", (d) => (firstRow(d)["uptime_s"] = -1)],
      ["a non-string system_state", (d) => (firstRow(d)["system_state"] = 42)],
      ["a failed unit that is not a string", (d) => (firstRow(d)["failed_units"] = [7])],
      ["failed_units that is not a list", (d) => (firstRow(d)["failed_units"] = "nginx.service")],
    ];
    for (const [label, perturb] of cases) {
      const doc = vmDoc();
      perturb(doc);
      const r = await reconcileNamed(VM_OPS, JSON.stringify(doc));
      expectClamped(r, VM_OPS, label);
      expect(r.discrepancies[0], label).toContain("validation");
    }
  });

  /**
   * The two channel vocabularies are CLOSED PER TARGET, not pooled. A pooled
   * enum would accept `units` from a docker observer, which has no systemd to
   * ask, and grade a row on a channel that cannot exist there.
   */
  test("each target's channels are refused by the other target's document", async () => {
    const dockerWithUnits = dockerDoc();
    firstRow(dockerWithUnits)["coverage"] = [{ channel: "units", result: "answered" }];
    expectClamped(
      await reconcileNamed(DOCKER_OPS, JSON.stringify(dockerWithUnits)),
      DOCKER_OPS,
      "units in a docker document",
    );

    const vmWithUnits = vmDoc();
    firstRow(vmWithUnits)["coverage"] = [{ channel: "units", result: "answered" }];
    expectClean(await reconcileNamed(VM_OPS, JSON.stringify(vmWithUnits)), "units in a VM document");

    const vmWithState = vmDoc();
    firstRow(vmWithState)["coverage"] = [{ channel: "state", result: "answered" }];
    expectClamped(
      await reconcileNamed(VM_OPS, JSON.stringify(vmWithState)),
      VM_OPS,
      "state in a VM document",
    );

    const dockerWithState = dockerDoc();
    firstRow(dockerWithState)["coverage"] = [{ channel: "state", result: "answered" }];
    expectClean(
      await reconcileNamed(DOCKER_OPS, JSON.stringify(dockerWithState)),
      "state in a docker document",
    );
  });

  test("an observer target artifact that is not JSON is reported, not thrown", async () => {
    for (const name of [DOCKER_OPS, VM_OPS]) {
      const r = await reconcileNamed(name, "{ this is not json");
      expectClamped(r, name, `${name} not JSON`);
      expect(r.discrepancies[0]).toContain("not parseable JSON");
    }
  });

  /**
   * SELECTION IS BY EXACT BASENAME, and `observer-ops.json` is not selected.
   *
   * SRD §3.3 keeps the k8s observer's document out of harvest validation, so
   * the old name must stay silent. A name that merely CONTAINS a selected name
   * must stay silent too. The subdirectory case is the other half: the scan
   * walks `files/` recursively, so the basename decides, not the full path.
   */
  test("the same malformed body under another name is not validated", async () => {
    const bad = dockerDoc();
    firstRow(bad)["assessment"] = "failed";
    const body = JSON.stringify(bad);

    // Control: this body DOES clamp under the selected name.
    expectClamped(await reconcileNamed(DOCKER_OPS, body), DOCKER_OPS, "control");

    for (const other of [
      "observer-ops.json",
      "coverage.json",
      "my-observer-docker-ops.json",
      "observer-docker-ops.json.bak",
      "observer-vm-ops.jsonl",
    ]) {
      expectClean(await reconcileNamed(other, body), other);
    }

    expectClamped(
      await reconcileNamed(`nested/${DOCKER_OPS}`, body),
      DOCKER_OPS,
      "selected name in a subdirectory",
    );
  });

  /**
   * THE SWEEP RUNS INSIDE THE PARSE, and the finding never carries the value.
   *
   * The control is the same document with no needles, which passes. That shows
   * the refusal comes from the sweep and not from some accident of the fixture.
   */
  test("a known secret inside an observer target artifact is refused without being repeated", async () => {
    const leaky = dockerDoc();
    firstRow(leaky)["evidence_ref"] = [`docker login used ${NEEDLE}`];
    const body = JSON.stringify(leaky);

    expectClean(await reconcileNamed(DOCKER_OPS, body), "control: no needles supplied");

    const r = await reconcileNamed(DOCKER_OPS, body, [NEEDLE]);
    expectClamped(r, DOCKER_OPS, "needle in evidence_ref");
    expect(r.discrepancies[0]).toContain("credential");
    expect(JSON.stringify(r)).not.toContain(NEEDLE);

    const vmLeaky = vmDoc();
    firstRow(vmLeaky)["failed_units"] = [NEEDLE];
    const vr = await reconcileNamed(VM_OPS, JSON.stringify(vmLeaky), [NEEDLE]);
    expectClamped(vr, VM_OPS, "needle in failed_units");
    expect(JSON.stringify(vr)).not.toContain(NEEDLE);
  });

  /**
   * THE PUBLISHED FILE IS EVERY BYTE, not the parsed subset.
   *
   * The schema strips a key it does not know, so a sweep over the PARSED value
   * would never see a token sitting in an extra field. The file on disk still
   * holds it, and the harvest digests and publishes that file whole.
   */
  test("a secret in a field the schema does not know is still refused", async () => {
    const extra = dockerDoc();
    firstRow(extra)["notes"] = `pasted ${NEEDLE} by mistake`;
    const body = JSON.stringify(extra);

    expectClean(await reconcileNamed(DOCKER_OPS, body), "control: the extra field is legal");

    const r = await reconcileNamed(DOCKER_OPS, body, [NEEDLE]);
    expectClamped(r, DOCKER_OPS, "needle in an unknown field");
    expect(JSON.stringify(r)).not.toContain(NEEDLE);
  });

  /**
   * A finding names PATHS, and a path is built from worker-authored keys. A
   * document that uses the secret as a key as well as a value would put the
   * secret into the path list, so the value has to be kept out of that too.
   */
  test("a secret used as a key is not repeated through the path it names", async () => {
    const keyed = dockerDoc();
    keyed[NEEDLE] = NEEDLE;
    const r = await reconcileNamed(DOCKER_OPS, JSON.stringify(keyed), [NEEDLE]);
    expectClamped(r, DOCKER_OPS, "needle as key and value");
    expect(JSON.stringify(r)).not.toContain(NEEDLE);
  });

  test("a not-JSON document does not repeat a secret through the parser's message", async () => {
    const body = `{"services": ${NEEDLE}}`;
    // The premise, measured: the parser's own message carries the needle.
    expect(() => JSON.parse(body)).toThrow(NEEDLE);

    const r = await reconcileNamed(VM_OPS, body, [NEEDLE]);
    expectClamped(r, VM_OPS, "needle in a not-JSON body");
    expect(r.discrepancies[0]).toContain("not parseable JSON");
    expect(JSON.stringify(r)).not.toContain(NEEDLE);
  });

  /**
   * A cap refusal is a REPORTED gap and still clamps. Otherwise "make it
   * bigger than the cap" would be the way to switch validation off. The
   * well-formed controls above use the same names and reach no ceiling.
   */
  test("an observer target artifact refused by the per-artifact cap still clamps", async () => {
    for (const name of [DOCKER_OPS, VM_OPS]) {
      expectClean(
        await reconcileNamed(name, JSON.stringify(name === DOCKER_OPS ? dockerDoc() : vmDoc())),
        `${name} control`,
      );

      const r = await reconcileNamed(name, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x20));
      const own = r.discrepancies.filter((d) => d.startsWith(`${name} artifact `));
      expect(own, name).toHaveLength(1);
      expect(own[0]).toContain("declined to read");
      expect(own[0]).toContain("too_large");
      expect(r.discrepancies.join("\n")).not.toContain("ticket-ops");
      expect(r.verdictCeiling, name).toBe("failed");
      expect(r.verdictCeilingReason, name).toContain(name);
      expect(r.verdictCeilingReason, name).toContain("what the observer saw");
      expect(r.verdictCeilingReason, name).not.toContain("ticket");
    }
  }, 30_000);
});

/**
 * THE KEY-ONLY SECRET (the gap Phase 2 round 1 named).
 *
 * `findCredentialLeaks` walks string VALUES. A document whose only copy of the
 * secret is a KEY, `{"<secret>": "x"}`, passed it untouched, and the schema
 * strips the unknown key, so the parse passed too. The harvest still publishes
 * the whole file, key included.
 *
 * Each case runs twice through the same helper. With no needles it is clean,
 * so the extra key is legal and nothing else about the body clamps. With the
 * needle it clamps, so the refusal can only have come from the sweep.
 */
describe("reconcileArtifactClaims — a secret used only as a key is refused", () => {
  test("a known secret that appears only as a key clamps, and the finding never repeats it", async () => {
    const cases: Array<[string, string, () => Record<string, unknown>, string]> = [
      [
        "a root key",
        DOCKER_OPS,
        () => {
          const d = dockerDoc();
          d[NEEDLE] = "x";
          return d;
        },
        "<root>",
      ],
      [
        "a key inside a row",
        DOCKER_OPS,
        () => {
          const d = dockerDoc();
          firstRow(d)[NEEDLE] = "x";
          return d;
        },
        "services[0]",
      ],
      [
        "a key that merely contains the secret",
        VM_OPS,
        () => {
          const d = vmDoc();
          firstRow(d)[`note-${NEEDLE}-pasted`] = "x";
          return d;
        },
        "services[0]",
      ],
    ];
    for (const [label, name, build, where] of cases) {
      const body = JSON.stringify(build());
      // The premise: the needle occurs exactly once in the body, as the key, so
      // no VALUE carries it.
      expect(body.split(NEEDLE).length - 1, label).toBe(1);
      expect(body, label).toContain(`"x"`);

      expectClean(await reconcileNamed(name, body), `${label} control: no needles supplied`);

      const r = await reconcileNamed(name, body, [NEEDLE]);
      expectClamped(r, name, label);
      expect(r.discrepancies[0], label).toContain("credential");
      // It names WHERE the key sits, and never the key itself.
      expect(r.discrepancies[0], label).toContain(where);
      expect(JSON.stringify(r), label).not.toContain(NEEDLE);
      expect(JSON.stringify(r), label).not.toContain(NEEDLE.slice(0, 12));
    }
  });
});

/**
 * THE ORPHANED-DOCUMENT PASS, generalised to all three pairs (Phase 2 task 2.3).
 *
 * `ticket-ops.md` with no `ticket-ops.json` beside it already clamps, because
 * the `.md` half opts nothing in: no schema runs on it and no credential sweep
 * does either. `observer-docker-ops.md` and `observer-vm-ops.md` are the same
 * hole for the two observer targets.
 *
 * Every name is SPELLED here rather than imported, for the reason the block
 * above gives. Every clamp sits beside a control through the same helper that
 * demonstrably reaches no ceiling.
 */
const DOCKER_MD = "observer-docker-ops.md";
const VM_MD = "observer-vm-ops.md";
const TICKET_JSON = "ticket-ops.json";
const TICKET_MD = "ticket-ops.md";
const PROSE = "# what the worker saw\n\nall quiet\n";

/** A well-formed `ticket-ops.json`, so a pairing control is not clamped for its content. */
function ticketOpsDoc(): string {
  return JSON.stringify({
    schema: "pifleet.ticket-ops/v1",
    task_id: "T-1",
    worker: "w1",
    epoch: 1,
    operation: "query",
    ticket_host: "tickets.example.invalid",
    generated_at: "2026-09-13T10:00:00.000Z",
    no_change_needed: false,
    queried: [{ ticket: "T-9", fields: [{ field: "State", value: "Open" }] }],
    updates: [],
    commands: ["curl -H 'Authorization: Token <redacted>' https://tickets.example.invalid/T-9"],
    verdict: "success",
    notes: "queried T-9 and read its State field back",
  });
}

/**
 * Write every entry under a FRESH `files/`, claim all of them, and reconcile.
 *
 * All claimed, so the reverse-direction pass stays silent and the only findings
 * are the ones under test.
 */
async function reconcileFiles(
  entries: Record<string, string | Buffer>,
  secrets?: readonly string[],
): Promise<ArtifactReconciliation> {
  await rm(files, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(entries)) {
    await mkdir(dirname(join(files, rel)), { recursive: true });
    await writeFile(join(files, rel), body);
  }
  const scan = await scanHeld();
  return reconcileArtifactClaims(
    scan,
    Object.keys(entries).map((rel) => ({ kind: "file" as const, path: `/outbox/T-1/files/${rel}` })),
    loc,
    secrets === undefined ? {} : { secrets },
  );
}

/**
 * An observer orphan, reported in ITS target's words.
 *
 * The finding names its own document and its own missing `.json`, and says what
 * did not run. The reason names the document and what cannot be known about
 * the target. Neither mentions tickets, and the reason must not claim a
 * validation failed, because nothing was parsed.
 */
function expectOrphaned(
  r: ArtifactReconciliation,
  document: string,
  artifact: string,
  target: string,
  label: string,
): void {
  expect(r.discrepancies, label).toHaveLength(1);
  const finding = r.discrepancies[0]!;
  expect(finding, label).toContain(`holds ${document} at `);
  expect(finding, label).toContain(`no ${artifact} beside it`);
  expect(finding, label).toContain("credential sweep");
  expect(finding, label).toContain("unchecked, not clean");
  expect(finding, label).not.toContain("ticket");
  expect(r.verdictCeiling, label).toBe("failed");
  expect(r.verdictCeilingReason, label).toContain(`${document} with no ${artifact} beside it`);
  expect(r.verdictCeilingReason, label).toContain(`what the observer saw on that ${target}`);
  expect(r.verdictCeilingReason, label).not.toContain("ticket");
  expect(r.verdictCeilingReason, label).not.toContain("failed validation");
}

describe("reconcileArtifactClaims — an observer .md with no .json beside it clamps", () => {
  test("an observer-vm-ops.md alone clamps, and beside its .json it does not", async () => {
    expectClean(await reconcileFiles({ [VM_MD]: PROSE, [VM_OPS]: JSON.stringify(vmDoc()) }), "vm pair");
    expectOrphaned(await reconcileFiles({ [VM_MD]: PROSE }), VM_MD, VM_OPS, "VM", "vm .md alone");
  });

  test("an observer-docker-ops.md alone clamps, and beside its .json it does not", async () => {
    expectClean(
      await reconcileFiles({ [DOCKER_MD]: PROSE, [DOCKER_OPS]: JSON.stringify(dockerDoc()) }),
      "docker pair",
    );
    expectOrphaned(
      await reconcileFiles({ [DOCKER_MD]: PROSE }),
      DOCKER_MD,
      DOCKER_OPS,
      "docker host",
      "docker .md alone",
    );
  });

  /**
   * PAIRING IS PER DIRECTORY. A `.json` two directories away is a different
   * document, and accepting it would let one validated file vouch for any number
   * of unvalidated ones. Both directions, because a check that ignored
   * directories passes one and a check that demanded the top level passes the
   * other.
   */
  test("a .json in another directory does not pair", async () => {
    const vmJson = JSON.stringify(vmDoc());
    expectClean(
      await reconcileFiles({ [`sub/${VM_MD}`]: PROSE, [`sub/${VM_OPS}`]: vmJson }),
      "both halves in one subdirectory",
    );
    expectOrphaned(
      await reconcileFiles({ [VM_MD]: PROSE, [`sub/${VM_OPS}`]: vmJson }),
      VM_MD,
      VM_OPS,
      "VM",
      ".md at the top, .json in a subdirectory",
    );
    expectOrphaned(
      await reconcileFiles({ [`sub/${VM_MD}`]: PROSE, [VM_OPS]: vmJson }),
      VM_MD,
      VM_OPS,
      "VM",
      ".md in a subdirectory, .json at the top",
    );
  });

  /**
   * PAIRS DO NOT CROSS-VOUCH. Each `.md` is vouched for by its own `.json` and
   * nothing else. A valid document of another kind beside it is still no
   * examination of this one.
   */
  test("a mismatched pair still clamps", async () => {
    const dockerJson = JSON.stringify(dockerDoc());
    const vmJson = JSON.stringify(vmDoc());
    // Controls: each vouching `.json` is valid on its own terms.
    expectClean(await reconcileFiles({ [TICKET_MD]: PROSE, [TICKET_JSON]: ticketOpsDoc() }), "ticket pair");
    expectClean(await reconcileFiles({ [DOCKER_MD]: PROSE, [DOCKER_OPS]: dockerJson }), "docker pair");
    expectClean(await reconcileFiles({ [VM_MD]: PROSE, [VM_OPS]: vmJson }), "vm pair");

    expectOrphaned(
      await reconcileFiles({ [DOCKER_MD]: PROSE, [VM_OPS]: vmJson }),
      DOCKER_MD,
      DOCKER_OPS,
      "docker host",
      "docker .md beside a VM .json",
    );
    expectOrphaned(
      await reconcileFiles({ [VM_MD]: PROSE, [DOCKER_OPS]: dockerJson }),
      VM_MD,
      VM_OPS,
      "VM",
      "VM .md beside a docker .json",
    );
    expectOrphaned(
      await reconcileFiles({ [DOCKER_MD]: PROSE, [TICKET_JSON]: ticketOpsDoc() }),
      DOCKER_MD,
      DOCKER_OPS,
      "docker host",
      "docker .md beside a ticket-ops.json",
    );

    // And the ticket-ops half is not vouched for by an observer document either.
    const r = await reconcileFiles({ [TICKET_MD]: PROSE, [DOCKER_OPS]: dockerJson });
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain(`no ${TICKET_JSON} beside it`);
    expect(r.verdictCeiling).toBe("failed");
  });

  /**
   * Three orphans at once report three findings, each in its own words. One
   * shared sentence would describe two of them wrongly.
   */
  test("several orphans each report their own document", async () => {
    const r = await reconcileFiles({ [TICKET_MD]: PROSE, [DOCKER_MD]: PROSE, [VM_MD]: PROSE });
    expect(r.discrepancies).toHaveLength(3);
    const own = (doc: string) => r.discrepancies.filter((d) => d.includes(`holds ${doc} at `));
    expect(own(TICKET_MD)).toHaveLength(1);
    expect(own(DOCKER_MD)).toHaveLength(1);
    expect(own(VM_MD)).toHaveLength(1);
    expect(own(DOCKER_MD)[0]).not.toContain("observer-vm-ops");
    expect(own(VM_MD)[0]).not.toContain("observer-docker-ops");
    expect(r.verdictCeiling).toBe("failed");
  });

  /**
   * THE TICKET-OPS ORPHAN KEEPS ITS EXACT TEXT. `harvest-outbox-contract.test.ts`
   * and `harvest/index.ts` refer to it, so generalising the pass must not
   * reword it by one byte.
   */
  test("the ticket-ops orphan finding and reason are byte-identical", async () => {
    expectClean(await reconcileFiles({ [TICKET_MD]: PROSE, [TICKET_JSON]: ticketOpsDoc() }), "control");

    const r = await reconcileFiles({ [TICKET_MD]: PROSE });
    expect(r.discrepancies).toEqual([
      `the outbox holds ticket-ops.md at ${join(files, TICKET_MD)} with no ticket-ops.json beside ` +
        `it, so the ticket-ops schema validation and the credential sweep DID NOT RUN on it; this ` +
        `document is unchecked, not clean`,
    ]);
    expect(r.verdictCeiling).toBe("failed");
    expect(r.verdictCeilingReason).toBe(
      "the outbox holds ticket-ops.md with no ticket-ops.json beside it, so neither the schema " +
        "validation nor the credential sweep ran on the worker's account of what it did to the " +
        "ticket system",
    );
  });
});

/**
 * NOTHING FROM A GRANTED SECRET REACHES AN OBSERVER FINDING (Phase 2 fix round
 * FP2-1, task A).
 *
 * Three holes, each measured at e8655f7 before the fix:
 *
 * 1. The sweep ran over the PARSED value only. A duplicate key whose later value
 *    wins, a needle held as a number, and a body that will not parse at all all
 *    carry the secret in the bytes the harvest publishes, and none of them was
 *    reported as a credential.
 * 2. The not-JSON finding quoted the parser's message, and Bun's message quotes
 *    the offending token CUT SHORT: at the first `/ + - .`, or after 200
 *    characters. Exact-match redaction cannot see a prefix, so the head of the
 *    secret reached the report. `NEEDLE` above never showed it, because it is
 *    identifier-shaped and short.
 * 3. A path is worker-authored, and a directory named after the secret put the
 *    secret into every observer finding that names the file.
 *
 * Every case is its own test, so a red run names the case rather than the first
 * one a loop happened to reach. Every clamp sits beside a control through the
 * same helper.
 */

/** The text an observer's secret must never reach: its findings and its clamp reason. */
function observerText(r: ArtifactReconciliation): string {
  return JSON.stringify({ discrepancies: r.discrepancies, reason: r.verdictCeilingReason });
}

/** Neither the needle nor its twelve-character head appears in `text`. */
function expectNoNeedle(text: string, needle: string, label: string): void {
  expect(text, `${label}: the whole needle`).not.toContain(needle);
  expect(text, `${label}: the needle's head`).not.toContain(needle.slice(0, 12));
}

/** A synthetic numeric grant, for the needle a string sweep cannot see. */
const NUMERIC_NEEDLE = "918273645501";

describe("reconcileArtifactClaims — a secret in the bytes is a credential finding", () => {
  const withNumber = (doc: Record<string, unknown>, field: string): string => {
    firstRow(doc)[field] = Number(NUMERIC_NEEDLE);
    return JSON.stringify(doc);
  };
  const duplicated = (doc: Record<string, unknown>): string => {
    const clean = JSON.stringify(doc);
    const body = clean.replace('"sweep_id":null', `"sweep_id":"${NEEDLE}","sweep_id":null`);
    expect(body, "the duplicate key was spliced in").not.toBe(clean);
    return body;
  };

  /**
   * Parseable bodies. The PREMISE is asserted per case: the body holds the
   * needle, the parse succeeds, and no string in the parsed value holds it, so
   * the parsed sweep alone has nothing to find.
   */
  const parseable: Array<[string, string, () => string, string]> = [
    ["a duplicate sweep_id whose later null wins", DOCKER_OPS, () => duplicated(dockerDoc()), NEEDLE],
    ["a duplicate sweep_id whose later null wins", VM_OPS, () => duplicated(vmDoc()), NEEDLE],
    ["a numeric grant written as restart_count", DOCKER_OPS, () => withNumber(dockerDoc(), "restart_count"), NUMERIC_NEEDLE],
    ["a numeric grant written as uptime_s", VM_OPS, () => withNumber(vmDoc(), "uptime_s"), NUMERIC_NEEDLE],
  ];
  for (const [what, name, build, needle] of parseable) {
    test(`${name}: ${what} clamps as a credential`, async () => {
      const body = build();
      expect(body, "premise: the bytes hold the needle").toContain(needle);
      expect(findCredentialLeaks(JSON.parse(body), [needle]), "premise: the parsed value does not").toEqual([]);

      expectClean(await reconcileNamed(name, body), "control: no needles supplied");

      const r = await reconcileNamed(name, body, [needle]);
      expectClamped(r, name, what);
      expect(r.discrepancies[0], what).toContain("contains a credential");
      expectNoNeedle(JSON.stringify(r), needle, what);
    });
  }

  /** A body that is not JSON at all: a leading BOM before a leaky document. */
  for (const [name, build] of [
    [DOCKER_OPS, () => {
      const d = dockerDoc();
      firstRow(d)["evidence_ref"] = [`docker login used ${NEEDLE}`];
      return d;
    }],
    [VM_OPS, () => {
      const d = vmDoc();
      firstRow(d)["failed_units"] = [NEEDLE];
      return d;
    }],
  ] as const) {
    test(`${name}: a leaky document behind a BOM clamps as a credential, not only as not-JSON`, async () => {
      const body = `${String.fromCharCode(0xfeff)}${JSON.stringify(build())}`;
      expect(() => JSON.parse(body), "premise: the BOM makes it unparseable").toThrow();

      // The control: the same bytes with no needles are a plain not-JSON finding.
      const control = await reconcileNamed(name, body);
      expectClamped(control, name, "control: no needles supplied");
      expect(control.discrepancies[0]).toContain("not parseable JSON");
      expect(control.discrepancies[0]).not.toContain("credential");

      const r = await reconcileNamed(name, body, [NEEDLE]);
      expectClamped(r, name, "BOM");
      expect(r.discrepancies[0]).toContain("not parseable JSON");
      expect(r.discrepancies[0]).toContain("contains a credential");
      expectNoNeedle(JSON.stringify(r), NEEDLE, "BOM");
    });
  }

  /**
   * THE PARSED SWEEP'S OWN FINDING SURVIVES. When the parse finds the leak, its
   * finding names the PATH, and that is more useful than "somewhere in the
   * bytes". `harvest-credential-sweep-wiring.test.ts` pins the same through
   * `harvestTask`; this pins it at the module, where the ordering lives.
   */
  test("a leak the parsed sweep finds keeps its path-naming finding", async () => {
    const leaky = dockerDoc();
    firstRow(leaky)["evidence_ref"] = [`docker login used ${NEEDLE}`];
    const r = await reconcileNamed(DOCKER_OPS, JSON.stringify(leaky), [NEEDLE]);
    expectClamped(r, DOCKER_OPS, "evidence_ref leak");
    expect(r.discrepancies[0]).toContain("contains a credential");
    expect(r.discrepancies[0]).toContain("evidence_ref");
    expectNoNeedle(JSON.stringify(r), NEEDLE, "evidence_ref leak");
  });
});

describe("reconcileArtifactClaims — a not-JSON observer finding quotes nothing from the document", () => {
  const cases: Array<[string, string]> = [
    ["a needle containing /", "SynthKeyAlpha9Q/zz+TailBravo77"],
    ["an identifier-only needle longer than 200 characters", `SynthLong${"Q".repeat(230)}`],
  ];
  for (const [what, needle] of cases) {
    for (const name of [DOCKER_OPS, VM_OPS]) {
      test(`${name}: ${what}`, async () => {
        const body = `{"services": ${needle}}`;
        // The premise, measured: the parser quotes the head and NOT the whole
        // needle, so redacting the needle by exact match would leave the head.
        let message = "";
        try {
          JSON.parse(body);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, "premise: the parser quotes the head").toContain(needle.slice(0, 12));
        expect(message, "premise: but not the whole needle").not.toContain(needle);

        const r = await reconcileNamed(name, body, [needle]);
        expectClamped(r, name, what);
        expect(r.discrepancies[0]).toContain("not parseable JSON");
        expectNoNeedle(JSON.stringify(r), needle, what);
      });
    }
  }
});

/**
 * EVERY OBSERVER FINDING LINE AND CLAMP REASON IS REDACTED WHOLE, path included.
 *
 * Asserted on the findings and the reason, NOT on the whole result:
 * `artifacts[].path` keeps the raw path on purpose (`src/run/relay.ts` reads it),
 * so a needle in a directory name is still in the inventory. Each arm has a
 * control with no needles that shows the path DOES reach the finding, so the
 * redaction is what removed it.
 */
describe("reconcileArtifactClaims — a secret in a directory name never reaches an observer finding", () => {
  const malformed = (): string => {
    const d = dockerDoc();
    firstRow(d)["assessment"] = "failed";
    return JSON.stringify(d);
  };

  test("the validation arm", async () => {
    const rel = `${NEEDLE}/${DOCKER_OPS}`;
    const control = await reconcileNamed(rel, malformed());
    expect(control.discrepancies[0], "control: the path reaches the finding").toContain(NEEDLE);

    const r = await reconcileNamed(rel, malformed(), [NEEDLE]);
    expectClamped(r, DOCKER_OPS, "validation arm");
    expect(r.discrepancies[0]).toContain("validation");
    expectNoNeedle(observerText(r), NEEDLE, "validation arm");
  });

  test("the cap-refusal arm", async () => {
    const rel = `${NEEDLE}/${VM_OPS}`;
    const own = (r: ArtifactReconciliation) => r.discrepancies.filter((d) => d.startsWith(`${VM_OPS} artifact `));
    const oversized = Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x20);

    const control = await reconcileNamed(rel, oversized);
    expect(own(control)[0], "control: the path reaches the finding").toContain(NEEDLE);

    const r = await reconcileNamed(rel, oversized, [NEEDLE]);
    expect(own(r)).toHaveLength(1);
    expect(own(r)[0]).toContain("declined to read");
    expect(r.verdictCeiling).toBe("failed");
    expectNoNeedle(JSON.stringify({ own: own(r), reason: r.verdictCeilingReason }), NEEDLE, "cap arm");
  }, 30_000);

  test("the orphaned-document arm", async () => {
    const rel = `${NEEDLE}/${DOCKER_MD}`;
    const control = await reconcileFiles({ [rel]: PROSE });
    expect(control.discrepancies[0], "control: the path reaches the finding").toContain(NEEDLE);

    const r = await reconcileFiles({ [rel]: PROSE }, [NEEDLE]);
    expectOrphaned(r, DOCKER_MD, DOCKER_OPS, "docker host", "orphan in a needle directory");
    expectNoNeedle(observerText(r), NEEDLE, "orphan arm");
  });

  /**
   * REDACTED BEFORE IT IS TRUNCATED. `safeForReport` cuts a path at 256
   * characters, so a needle straddling the cut arrives as a prefix, and a
   * redaction applied only to the finished line cannot match a prefix. The
   * needle starts 16 characters before the cut, so its twelve-character head
   * survives the cut and only an earlier redaction removes it.
   */
  test("a needle straddling the report's truncation point", async () => {
    const start = 240;
    const pad = "p".repeat(start - files.length - 2);
    expect(pad.length, "the padding directory is a legal name").toBeGreaterThan(0);
    expect(pad.length).toBeLessThan(256);
    const rel = `${pad}/${NEEDLE}/${DOCKER_MD}`;
    const shown = safeForReport(join(files, rel));
    expect(shown.indexOf(NEEDLE.slice(0, 12)), "premise: the head survives the cut").toBe(start);
    expect(shown, "premise: the whole needle does not").not.toContain(NEEDLE);

    const r = await reconcileFiles({ [rel]: PROSE }, [NEEDLE]);
    expectOrphaned(r, DOCKER_MD, DOCKER_OPS, "docker host", "orphan past the cut");
    expectNoNeedle(observerText(r), NEEDLE, "orphan past the cut");
  });
});

/**
 * THE BYTE BUDGET CANNOT SWITCH OBSERVER VALIDATION OFF (FP2-1, task B).
 *
 * When `MAX_RECONCILED_BYTES` stops the digest loop, an observer target artifact
 * the loop never reached was neither parsed nor swept. At e8655f7 that returned
 * out of the whole function: eight full-size files and one byte in front of a
 * leaky document gave `verdictCeiling: null` and a single "stopped after" line.
 *
 * `ticket-ops.json` and `collation.json` have the same hole, which predates this
 * phase and is left for the operator to decide. So this pins the observer
 * artifacts only.
 */
describe("reconcileArtifactClaims — an observer artifact past the per-task budget still clamps", () => {
  test("every unvisited observer target artifact is named and clamps", async () => {
    const leaky = dockerDoc();
    firstRow(leaky)["evidence_ref"] = [`docker login used ${NEEDLE}`];
    const leakyBody = JSON.stringify(leaky);

    // THE CONTROL: the same document alone clamps.
    expectClamped(await reconcileNamed(DOCKER_OPS, leakyBody, [NEEDLE]), DOCKER_OPS, "control: alone");

    expect(8 * MAX_ARTIFACT_BYTES, "premise: eight full-size files fill the budget").toBe(
      MAX_RECONCILED_BYTES,
    );
    const entries: Record<string, string | Buffer> = {};
    for (let i = 0; i < 8; i++) entries[`a${i}.bin`] = Buffer.alloc(MAX_ARTIFACT_BYTES, 0x63);
    entries["b.txt"] = "x";
    entries[DOCKER_OPS] = leakyBody;
    entries[`${NEEDLE}/${VM_OPS}`] = JSON.stringify(vmDoc());
    // Premise: both observer artifacts sort after the byte that tips the budget.
    const sorted = Object.keys(entries).sort();
    expect(sorted.indexOf("b.txt")).toBeLessThan(sorted.indexOf(DOCKER_OPS));
    expect(sorted.indexOf("b.txt")).toBeLessThan(sorted.indexOf(`${NEEDLE}/${VM_OPS}`));

    const r = await reconcileFiles(entries, [NEEDLE]);

    expect(r.discrepancies.filter((d) => d.includes("per-task cap"))).toHaveLength(1);
    for (const name of [DOCKER_OPS, VM_OPS]) {
      const own = r.discrepancies.filter((d) => d.startsWith(`${name} artifact `));
      expect(own, name).toHaveLength(1);
      expect(own[0], name).toContain("could not be validated");
      expect(own[0], name).not.toContain("ticket");
    }
    expect(r.verdictCeiling).toBe("failed");
    expect(r.verdictCeilingReason).toContain("what the observer saw");
    expect(r.verdictCeilingReason).not.toContain("ticket");
    expectNoNeedle(observerText(r), NEEDLE, "budget");
    expect(r.artifacts).toHaveLength(8);
  }, 60_000);
});
