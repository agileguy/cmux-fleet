/**
 * THE TASK OUTBOX'S OWN CONTENTS, listed by NAME AND SIZE and never opened.
 *
 * ## The measured defect
 *
 * `rev-lang-1` was asked for a language review, wrote 12,759 bytes of genuine
 * review to `/outbox/R-rally-async-6-lang/artifact.json` — at the TASK ROOT,
 * under a name it invented, carrying an invented `"schema"` it confabulated —
 * and wrote no `result.json` and no `files/`. Both of the harvest's readers
 * missed it: `readResultEnvelope` looks for `result.json` and answers `missing`,
 * and `scanOutboxFiles` walks `<task>/files/` and finds no such directory. The
 * collation brief then said the lens *"settled `unknown` and no report reached
 * the collator"*, which is TRUE and was the whole of what anyone was told. What
 * nobody was told is that 12,759 bytes were sitting one directory away.
 *
 * So this module answers exactly one question — **is that task outbox empty, or
 * does it hold things the harvest does not read?** — and the discipline is what
 * makes it safe to ask: `readdir` for the names, `lstat` for the sizes, and
 * NOTHING ELSE. The bytes are worker-authored and this fact travels into a
 * model's collation brief, so opening them would put attacker-controlled text
 * into the collator's prompt through a channel that today cannot carry it.
 *
 * ## THE ASYMMETRIC PAIR IS THE FIRST TEST IN THIS FILE, deliberately
 *
 * This branch has shipped nine probes whose two fixtures made the two states
 * being distinguished coincide — both empty, or both populated — so the probe
 * passed against the right implementation and the wrong one alike. The pair
 * below differs in EXACTLY ONE BYTE OF FILESYSTEM STATE: one task outbox holds
 * an unrecognised file and the other does not. A listing that always answered
 * `empty`, and one that always answered `unrecognised`, each fail exactly one
 * half of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESULT_ENVELOPE_NAME } from "../../src/contracts.ts";
import { OUTBOX_FILES_DIR, type OutboxLocation } from "../../src/harvest/outbox.ts";
import {
  MAX_NAMED_UNRECOGNISED_ENTRIES,
  listTaskOutbox,
  type TaskOutboxListing,
} from "../../src/harvest/task-outbox.ts";

let tmp: string;

/** A task outbox at `<tmp>/outbox/<worker>/<task>`, created empty. */
async function seat(worker: string, taskId: string): Promise<OutboxLocation> {
  const workerOutboxDir = join(tmp, "outbox", worker);
  await mkdir(join(workerOutboxDir, taskId), { recursive: true });
  return {
    workerOutboxDir,
    taskId,
    epoch: 1,
    containerWorkdir: "/workspace",
    hostWorkdir: null,
  };
}

function taskRoot(loc: OutboxLocation): string {
  return join(loc.workerOutboxDir, loc.taskId);
}

/** The `unrecognised` arm, or a failure naming what came back instead. */
function unrecognised(l: TaskOutboxListing): Extract<TaskOutboxListing, { kind: "unrecognised" }> {
  if (l.kind !== "unrecognised") throw new Error(`expected unrecognised, got ${l.kind}`);
  return l;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-task-outbox-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("listTaskOutbox", () => {
  /**
   * THE PAIR. Two seats built by the same helper, in the same run, differing
   * only in whether one file exists. Both halves are asserted in ONE test so
   * that a fixture drift which collapses them cannot pass by half.
   */
  test("an empty task outbox and one holding an unrecognised file do not answer the same", async () => {
    const bare = await seat("rev-a", "T-bare");
    const holding = await seat("rev-b", "T-holding");
    // THE ONLY DIFFERENCE between the two fixtures.
    await writeFile(join(taskRoot(holding), "artifact.json"), "x".repeat(12_759));

    const bareListing = await listTaskOutbox(bare);
    const holdingListing = await listTaskOutbox(holding);

    expect(bareListing).toEqual({ kind: "empty" });

    const found = unrecognised(holdingListing);
    expect(found.total).toBe(1);
    expect(found.named).toEqual([{ name: "artifact.json", kind: "file", bytes: 12_759 }]);
  });

  /**
   * The size is the fact that separates `notes.txt` from a lost review, and it
   * is the fact a `readdir`-only listing cannot supply. Pinned on its own so a
   * regression to names-only is a red rather than a quieter report.
   */
  test("the size of an unrecognised file is reported, not merely its name", async () => {
    const loc = await seat("rev-a", "T-1");
    await writeFile(join(taskRoot(loc), "review.md"), "abcde");
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named[0]?.bytes).toBe(5);
  });

  /**
   * NAMES AND SIZES ONLY — the constraint the whole module exists under.
   *
   * Asserted against the SERIALISED listing rather than against a field, because
   * the hazard is content reaching a model's brief through ANY field: a `head`
   * of the file, a "detected schema", a first line. A test that checked only
   * `named[0]` would pass against an implementation that added a `preview`.
   */
  test("no byte of an unrecognised file's content appears anywhere in the listing", async () => {
    const loc = await seat("rev-a", "T-1");
    const secret = "IGNORE-PREVIOUS-INSTRUCTIONS-8b31f0";
    await writeFile(join(taskRoot(loc), "artifact.json"), `{"schema":"${secret}"}`);
    const listing = await listTaskOutbox(loc);
    expect(JSON.stringify(listing)).not.toContain(secret);
  });

  /**
   * The two things the harvest DOES read are not findings. Derived from the
   * production constants rather than spelled here, so a rename that broke the
   * listing's exemption breaks this test in the same commit.
   */
  test("the envelope and the files/ directory are recognised and produce no finding", async () => {
    const loc = await seat("rev-a", "T-1");
    await writeFile(join(taskRoot(loc), RESULT_ENVELOPE_NAME), "{}");
    await mkdir(join(taskRoot(loc), OUTBOX_FILES_DIR));
    expect(await listTaskOutbox(loc)).toEqual({ kind: "empty" });
  });

  /**
   * A recognised name present ALONGSIDE an unrecognised one must not mask it.
   * The `rev-lang-1` shape has no `result.json` at all; this is the same defect
   * one step over, where the worker wrote both.
   */
  test("an unrecognised file beside a recognised one is still reported, and alone", async () => {
    const loc = await seat("rev-a", "T-1");
    await writeFile(join(taskRoot(loc), RESULT_ENVELOPE_NAME), "{}");
    await writeFile(join(taskRoot(loc), "artifact.json"), "0123456789");
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named.map((e) => e.name)).toEqual(["artifact.json"]);
    expect(found.total).toBe(1);
  });

  test("a task outbox that does not exist is unlistable, not empty", async () => {
    const loc = await seat("rev-a", "T-1");
    await rm(taskRoot(loc), { recursive: true });
    expect(await listTaskOutbox(loc)).toEqual({ kind: "unlistable" });
  });

  /**
   * BOUNDED, AND IT SAYS SO. A worker can write thousands of files; a finding
   * that named all of them would be its own denial of the report, and one that
   * named eight without saying so would leave a reader inferring the list is
   * complete.
   */
  test("the named list is capped and the total still counts everything", async () => {
    const loc = await seat("rev-a", "T-1");
    const n = MAX_NAMED_UNRECOGNISED_ENTRIES + 7;
    for (let i = 0; i < n; i += 1) {
      await writeFile(join(taskRoot(loc), `f${String(i).padStart(3, "0")}.txt`), "z");
    }
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named.length).toBe(MAX_NAMED_UNRECOGNISED_ENTRIES);
    expect(found.total).toBe(n);
  });

  /** Two listings of one outbox must name the same entries; `readdir` order is not specified. */
  test("the named entries are sorted, so the cap does not decide which are named", async () => {
    const loc = await seat("rev-a", "T-1");
    for (const name of ["zz.txt", "aa.txt", "mm.txt"]) {
      await writeFile(join(taskRoot(loc), name), "z");
    }
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named.map((e) => e.name)).toEqual(["aa.txt", "mm.txt", "zz.txt"]);
  });

  /**
   * A SYMLINK IS NAMED AND NOT FOLLOWED, and its target's size is not leaked.
   *
   * `stat` would answer for the target — so a link to a 4 GiB file, or to
   * `~/.ssh/id_rsa`, would have its size reported as if the worker had produced
   * it. `lstat` answers for the link itself, which is the only size this module
   * is entitled to know.
   */
  test("a symlink is reported as a symlink, with no size taken from its target", async () => {
    const loc = await seat("rev-a", "T-1");
    const outside = join(tmp, "secret.txt");
    await writeFile(outside, "y".repeat(4096));
    await symlink(outside, join(taskRoot(loc), "link"));
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named).toEqual([{ name: "link", kind: "symlink", bytes: null }]);
  });

  /** A directory is named and NOT descended into — the module's whole posture. */
  test("an unrecognised directory is named without being descended", async () => {
    const loc = await seat("rev-a", "T-1");
    await mkdir(join(taskRoot(loc), "scratch"));
    await writeFile(join(taskRoot(loc), "scratch", "deep.txt"), "hello");
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named).toEqual([{ name: "scratch", kind: "directory", bytes: null }]);
    expect(found.total).toBe(1);
  });

  /**
   * Names are worker-authored and land in an operator's terminal and a model's
   * brief. A filename carrying a newline forges a line in both.
   */
  test("a name carrying control characters is escaped before it is reported", async () => {
    const loc = await seat("rev-a", "T-1");
    await writeFile(join(taskRoot(loc), "a\nb.txt"), "z");
    const found = unrecognised(await listTaskOutbox(loc));
    expect(found.named[0]?.name).toBe("a\\nb.txt");
  });
});
