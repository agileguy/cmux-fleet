/**
 * `/policy/replies` — the DECLARED reply set
 * (SRD-WORKER-DISPATCH-EXTENSION §7.4, D6, failure mode 9.6).
 *
 * The behaviour is small; what it prevents is Finding E. `/replies` is one
 * directory per worker per RUN and a standing console publishes into it every
 * sweep, so a `get_replies` that listed the directory would hand sweep 5's
 * collator sweeps 1 through 5 — five answers to five different questions, each
 * of which reads like a good answer to the one being asked. The set cannot be
 * discovered, so it is declared, and this file is the declaration.
 *
 * Properties worth a test each, and how each silently comes untrue:
 *
 * - **The inode survives a rewrite.** A bind mount pins the inode. Swap
 *   `writeFile` for the tmp-file + rename idiom that most "atomic write" advice
 *   recommends and the host sees a new file while the container reads the old
 *   one forever — with BOTH sides believing the declaration changed, which is
 *   9.6 with no symptom at all. This is the one that cannot be caught by reading
 *   the code, because the wrong version looks more careful than the right one.
 *   **It is also the exact inverse of the rule `report-tools.test.ts` asserts for
 *   the result envelope**, which is REPLACED so a host reading it mid-delivery
 *   never sees a half-written file. Both are deliberate; the readers differ.
 * - **The file is 0444 when it is not being written.** A worker that can write
 *   the record of which evidence it may read is a worker that can widen it —
 *   and `docker/verbgate` answers a writable policy surface by refusing every
 *   gated verb, so the cost is the whole worker either way.
 * - **The declared `path` is `replies.ts`'s path**, not a second spelling of it.
 *   Declaring and publishing are one act only if they cannot disagree about
 *   where the file is.
 * - **The declaration's `task_id` is spelled as `/policy/task` spells it.** 9.6
 *   is answered by an equality against that file; two different normalizations
 *   of one id fail that equality on the HONEST path, reporting staleness for a
 *   set that is perfectly fresh.
 * - **An empty array is a value.** `replies: []` is what lets the tool say
 *   "nothing was declared" rather than "the directory is empty".
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DuplicateReplyError,
  REPLIES_POLICY_MOUNT,
  REPLIES_POLICY_SCHEMA,
  renderRepliesPolicy,
  repliesPolicyHostPath,
  writeRepliesPolicy,
  type DeclaredReply,
  type RepliesPolicy,
} from "../../src/run/replies-policy.ts";
import { REPLIES_MOUNT, replyMountPath, writeReply } from "../../src/run/replies.ts";
import { TASK_POLICY_NONE, renderTaskPolicy } from "../../src/run/task-policy.ts";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "replies-policy-"));
}

const ONE: DeclaredReply[] = [{ task_id: "T-slice1", worker: "obs-t1", aspect: "slice1" }];

function parsed(text: string): RepliesPolicy {
  return JSON.parse(text) as RepliesPolicy;
}

describe("the declared reply set on disk", () => {
  test("keeps its INODE across rewrites, because a bind mount pins it", async () => {
    const dir = await scratch();
    const file = join(dir, "replies-policy");

    await writeRepliesPolicy(file, "T-sweep-1", ONE);
    const first = await stat(file);

    await writeRepliesPolicy(file, "T-sweep-2", [
      { task_id: "T-slice2", worker: "obs-t1", aspect: "slice2" },
    ]);
    const second = await stat(file);

    // The assertion is the inode, not the content: a rename-based writer updates
    // what the HOST reads and leaves the container pinned to the old inode, so a
    // content-only check passes while the worker is stale — which is 9.6
    // exactly, and silent.
    expect(second.ino).toBe(first.ino);
    expect(parsed(await readFile(file, "utf8")).task_id).toBe("T-sweep-2");
  });

  test("is 0444 between writes, so the worker cannot widen its own reply set", async () => {
    const dir = await scratch();
    const file = join(dir, "replies-policy");

    await writeRepliesPolicy(file, "T-1", ONE);
    expect((await stat(file)).mode & 0o777).toBe(0o444);

    // And the SECOND write still succeeds against that 0444 — on POSIX the owner
    // of a read-only file cannot open it for writing either, so a writer that
    // forgot to widen first would work exactly once per run and then declare a
    // permanently stale set.
    await writeRepliesPolicy(file, "T-2", []);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(parsed(await readFile(file, "utf8")).task_id).toBe("T-2");
  });

  test("creates the file when it does not exist yet, without a pre-chmod", async () => {
    const dir = await scratch();
    const file = join(dir, "replies-policy");
    await writeRepliesPolicy(file, null, []);
    expect(parsed(await readFile(file, "utf8"))).toEqual({
      schema: REPLIES_POLICY_SCHEMA,
      task_id: TASK_POLICY_NONE,
      replies: [],
    });
  });

  test("propagates a chmod failure that is NOT the file simply being absent", async () => {
    // A directory in place of the file: chmod succeeds, writeFile fails with
    // EISDIR. The point is that the writer does not swallow it — the ENOENT
    // catch is narrow, and a policy file that cannot be written must be loud.
    const dir = await scratch();
    const asDir = join(dir, "replies-policy");
    await mkdir(asDir);
    await expect(writeRepliesPolicy(asDir, "T-1", [])).rejects.toThrow();
  });

  /**
   * The render-before-touch ordering, which is the reason `renderRepliesPolicy`
   * is called on the first line of `writeRepliesPolicy` rather than inside the
   * widen/narrow window.
   *
   * A writer that widened first and only then discovered the set was malformed
   * would leave the PREVIOUS turn's declaration behind at 0644 — stale, and
   * writable by the worker it is about. That is 9.6 and a verbgate refusal in
   * one artifact, produced by a dispatch that reported an error and looked
   * handled.
   */
  test("a refused set leaves the previous declaration byte-identical and still 0444", async () => {
    const dir = await scratch();
    const file = join(dir, "replies-policy");
    await writeRepliesPolicy(file, "T-good", ONE);
    const before = await readFile(file, "utf8");
    const beforeStat = await stat(file);

    await expect(
      writeRepliesPolicy(file, "T-bad", [
        { task_id: "T-slice1", worker: "obs-t1", aspect: "slice1" },
        { task_id: "T-slice1", worker: "obs-t2", aspect: "slice2" },
      ]),
    ).rejects.toBeInstanceOf(DuplicateReplyError);

    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect((await stat(file)).ino).toBe(beforeStat.ino);
  });
});

describe("the declaration's shape", () => {
  test("carries the schema tag a pinned-image reader checks before it believes a byte", () => {
    expect(parsed(renderRepliesPolicy("T-1", [])).schema).toBe(REPLIES_POLICY_SCHEMA);
    expect(REPLIES_POLICY_SCHEMA).toBe("pifleet.replies/v1");
  });

  /**
   * The empty array is a VALUE and the distinction is the whole reason the file
   * exists on a turn that declares nothing. A `readdir` cannot make it: an empty
   * directory and an undeclared turn look identical from inside the container.
   */
  test("an empty set is an empty array present, not an absent key", () => {
    const doc = parsed(renderRepliesPolicy("T-1", []));
    expect(Object.hasOwn(doc, "replies")).toBe(true);
    expect(doc.replies).toEqual([]);
  });

  test("each entry's path is replies.ts's path, not a second spelling of it", () => {
    const doc = parsed(
      renderRepliesPolicy("T-collate", [
        { task_id: "T-slice1", worker: "obs-t1", aspect: "slice1" },
        { task_id: "T-slice2", worker: "obs-t2", aspect: "slice2" },
      ]),
    );
    expect(doc.replies.map((r) => r.path)).toEqual([
      replyMountPath("T-slice1"),
      replyMountPath("T-slice2"),
    ]);
    // Stated a second way, against the mount root rather than the function, so
    // a `replyMountPath` that lost its prefix could not satisfy both.
    for (const r of doc.replies) expect(r.path.startsWith(`${REPLIES_MOUNT}/`)).toBe(true);
    // The attribution fields survive verbatim — they are what the collator uses
    // to say whose reply it is quoting.
    expect(doc.replies[0]).toEqual({
      task_id: "T-slice1",
      worker: "obs-t1",
      aspect: "slice1",
      path: replyMountPath("T-slice1"),
    });
  });

  /**
   * Declaring and publishing are one act, checked at the level this task owns:
   * the NAME. The composition-root set equality is §12's criterion and belongs
   * to the writer that does both (task 5.3); what is provable here is that the
   * path the declaration hands the worker is the file `writeReply` actually
   * created, rather than two derivations that happen to agree today.
   */
  test("the declared path names the file writeReply actually creates", async () => {
    const dir = await scratch();
    const hostFile = await writeReply(dir, "T-slice1", { verdict: "ok" });
    const doc = parsed(renderRepliesPolicy("T-collate", ONE));

    expect(await readdir(dir)).toEqual([basename(hostFile)]);
    expect(basename(doc.replies[0]!.path)).toBe(basename(hostFile));
  });

  test("a child task id that cannot be a filename is refused, not declared", () => {
    // `replies.ts` holds the id to a path-segment grammar because the id becomes
    // a host filename in a run directory that also holds `control-auth.json`. A
    // declaration naming a path no publish could create is worse than a refusal:
    // the collator answers a missing file by inventing what it thinks it said.
    expect(() =>
      renderRepliesPolicy("T-1", [{ task_id: "../../control-auth", worker: "w", aspect: "a" }]),
    ).toThrow();
    expect(() =>
      renderRepliesPolicy("T-1", [{ task_id: "", worker: "w", aspect: "a" }]),
    ).toThrow();
  });

  test("two entries naming one child are refused rather than silently collapsed", () => {
    // The `path` is derived from the id, so a duplicate names ONE file with two
    // attributions — and only the second publish survives, since `writeReply`
    // truncates. Deduplicating would hide the same bug one layer down.
    const dup: DeclaredReply[] = [
      { task_id: "T-slice1", worker: "obs-t1", aspect: "slice1" },
      { task_id: "T-slice1", worker: "obs-t2", aspect: "slice2" },
    ];
    expect(() => renderRepliesPolicy("T-1", dup)).toThrow(DuplicateReplyError);
    // The id is in the message, because the operator's remedy is to fix the
    // request that produced it and a message without the id names no request.
    expect(() => renderRepliesPolicy("T-1", dup)).toThrow(/T-slice1/);
  });
});

/**
 * The freshness equality of failure mode 9.6, at its one fragile joint.
 *
 * `get_replies` refuses a declaration whose `task_id` disagrees with
 * `/policy/task`. That comparison is only meaningful if both ends spell the id
 * the same way, and `renderTaskPolicy` does not write ids verbatim — it strips
 * control characters and bounds the length. A declaration that wrote the RAW id
 * would disagree with the gate's file for exactly those ids, forever, on the
 * honest path: a stale-set report for a set that is perfectly fresh.
 */
describe("the declaration's task_id is spelled as /policy/task spells it", () => {
  const cases: Array<[string, string | null]> = [
    ["an ordinary id", "T-sweep-7-collate"],
    ["an id carrying a control character", "T-1\n99"],
    ["an id longer than the provenance bound", `T-${"x".repeat(500)}`],
    ["an id built only of control characters", String.fromCharCode(1, 2)],
    ["no task at all", null],
    ["an empty id", ""],
  ];

  for (const [name, id] of cases) {
    test(name, () => {
      const [gateLine] = renderTaskPolicy(id, 0).split("\n");
      expect(parsed(renderRepliesPolicy(id, [])).task_id).toBe(gateLine!);
    });
  }

  test("an idle turn reads as the same <none> the gate falls back to", () => {
    expect(parsed(renderRepliesPolicy(null, [])).task_id).toBe(TASK_POLICY_NONE);
  });
});

/**
 * WIRED UP — the two ends of one mount, asserted against the same constant.
 *
 * A module nothing calls is not a feature. `dispatch-policy.test.ts` makes this
 * check for its own mount and for the reason it gives: a `-v` that dropped `:ro`
 * would leave the file writable INSIDE the container regardless of its 0444 on
 * the host under the macOS ownership squash, and `docker/verbgate` would then
 * refuse every verb — a whole worker lost to three missing characters.
 *
 * Source text rather than a render, because what is claimed is the SPELLING: the
 * renderer must ask this module for the host path instead of joining a second
 * basename of its own. `render.test.ts` asserts the emitted argv; this asserts
 * that there is exactly one place the name comes from.
 */
describe("the renderer mounts the declaration read-only at the constant this module names", () => {
  test("render.ts emits the mount from this module's own path function", async () => {
    const render = await readFile("src/config/render.ts", "utf8");
    expect(render).toContain(
      "`${repliesPolicyHostPath(opts.worker.dir)}:${REPLIES_POLICY_MOUNT}:ro`",
    );
  });

  test("the container path is a sibling of the other two policy files", () => {
    expect(REPLIES_POLICY_MOUNT).toBe("/policy/replies");
    // Not under `/replies`. The reply PLANE and the declared reply SET are
    // different objects with different integrity rules, and a declaration that
    // landed inside the plane would be a policy file inside the data it governs.
    expect(REPLIES_POLICY_MOUNT.startsWith(`${REPLIES_MOUNT}/`)).toBe(false);
  });

  test("the host path is a named child of the worker directory, beside task-policy", () => {
    const workerDir = "/runs/r-1/workers/obs-t1";
    expect(repliesPolicyHostPath(workerDir)).toBe(`${workerDir}/replies-policy`);
  });
});
