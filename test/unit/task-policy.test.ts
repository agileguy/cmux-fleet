/**
 * ISC-362 — the verbgate's task provenance.
 *
 * The behaviour under test is small; the failure it prevents is not. Before
 * this, `verbgate` read `PIFLEET_TASK_ID`/`PIFLEET_EPOCH`, which nothing in
 * `src/` set, so every ledger row in every run read `<none>`/`0`. The audit
 * trail recorded that a destructive verb was attempted and lost which task
 * attempted it.
 *
 * Three properties are worth a test each, and each has a specific way of
 * silently coming untrue:
 *
 * - **The inode survives a rewrite.** A bind mount pins the inode. Swap
 *   `writeFile` for the tmp-file + rename idiom that most "atomic write"
 *   advice recommends and the host sees a new file while the container reads
 *   the old one forever — with BOTH sides believing the policy changed. This
 *   is the one that cannot be caught by reading the code, because the wrong
 *   version looks more careful than the right one.
 * - **The file is 0444 when it is not being written.** The subject of an audit
 *   record must not hold write permission on it.
 * - **A task id cannot break the line format.** Line 1 is the id and line 2 is
 *   the epoch; an id containing a newline would push the epoch to line 3 and
 *   hand the gate an empty epoch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripComments } from "../support/source-structure.ts";
import { TASK_POLICY_MOUNT, TASK_POLICY_NONE, renderTaskPolicy, writeTaskPolicy } from "../../src/run/task-policy.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "task-policy-"));
}

describe("the task provenance file", () => {
  test("keeps its INODE across rewrites, because a bind mount pins it", async () => {
    const dir = await scratch();
    const file = join(dir, "task-policy");

    await writeTaskPolicy(file, "T-first", 1);
    const first = await stat(file);

    await writeTaskPolicy(file, "T-second", 2);
    const second = await stat(file);

    // The assertion is the inode, not the content: a rename-based writer
    // updates the content the HOST reads and leaves the container on the old
    // inode, so a content-only check passes while the container is stale.
    expect(second.ino).toBe(first.ino);
    expect(await readFile(file, "utf8")).toBe("T-second\n2\n");
  });

  test("is 0444 between writes, so the worker cannot rewrite its own provenance", async () => {
    const dir = await scratch();
    const file = join(dir, "task-policy");

    await writeTaskPolicy(file, "T-1", 1);
    expect((await stat(file)).mode & 0o777).toBe(0o444);

    // And the SECOND write still succeeds against that 0444 — on POSIX the
    // owner of a read-only file cannot open it for writing either, so a writer
    // that forgot to widen first would work exactly once per run.
    await writeTaskPolicy(file, "T-2", 2);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(await readFile(file, "utf8")).toBe("T-2\n2\n");
  });

  test("creates the file when it does not exist yet, without a pre-chmod", async () => {
    const dir = await scratch();
    const file = join(dir, "task-policy");
    await writeTaskPolicy(file, null, 0);
    expect(await readFile(file, "utf8")).toBe(`${TASK_POLICY_NONE}\n0\n`);
  });

  test("propagates a chmod failure that is NOT the file simply being absent", async () => {
    // A directory in place of the file: chmod succeeds, writeFile fails with
    // EISDIR. The point is that the writer does not swallow it — the ENOENT
    // catch is narrow, and a policy file that cannot be written must be loud.
    const dir = await scratch();
    const asDir = join(dir, "task-policy");
    await mkdir(asDir);
    await expect(writeTaskPolicy(asDir, "T-1", 1)).rejects.toThrow();
  });
});

describe("the provenance line format", () => {
  test("a task id carrying a newline cannot push the epoch onto line 3", async () => {
    const rendered = renderTaskPolicy("T-1\n99", 7);
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("T-199");
    expect(lines[1]).toBe("7");
    // Exactly two content lines and a trailing newline.
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
  });

  test("an absent or empty task id reads as the same <none> the gate falls back to", () => {
    expect(renderTaskPolicy(null, 0)).toBe(`${TASK_POLICY_NONE}\n0\n`);
    expect(renderTaskPolicy("", 0)).toBe(`${TASK_POLICY_NONE}\n0\n`);
    // An id that sanitizes away entirely must not leave the field blank.
    expect(renderTaskPolicy("\u0001\u0002", 0)).toBe(`${TASK_POLICY_NONE}\n0\n`);
  });

  test("a non-integer or negative epoch degrades to 0 rather than to broken JSON", () => {
    expect(renderTaskPolicy("T-1", -5)).toBe("T-1\n0\n");
    expect(renderTaskPolicy("T-1", Number.NaN)).toBe("T-1\n0\n");
    expect(renderTaskPolicy("T-1", 3.7)).toBe("T-1\n3\n");
  });

  test("the id is bounded, so one oversized field cannot dominate the ledger", () => {
    const long = "T-".concat("x".repeat(500));
    expect(renderTaskPolicy(long, 1).split("\n")[0]?.length).toBe(200);
  });
});

describe("the gate reads the file, not the environment", () => {
  test("verbgate takes task and epoch from the mounted policy path", async () => {
    const gate = await readFile("docker/verbgate", "utf8");

    // The mount path the shim reads must be the one `render` emits.
    expect(gate).toContain(`task_file="${TASK_POLICY_MOUNT}"`);

    // And no live read of the old environment carrier survives. The header
    // still NAMES the variables to explain why they went away, so this asserts
    // on the shell expansion rather than on the string.
    expect(gate).not.toContain("${PIFLEET_TASK_ID");
    expect(gate).not.toContain("${PIFLEET_EPOCH");
  });

  test("the provenance file is held to the same integrity bar as the allow file", async () => {
    const gate = await readFile("docker/verbgate", "utf8");
    // Both policy paths go through one writability refusal. A worker that can
    // write either one gets every verb refused, not just a warning.
    expect(gate).toContain('for policy_path in "${allow_file}" "${task_file}"');
    expect(gate).toContain("exit 78");
  });
});

/**
 * The ORDERING claim, probed structurally.
 *
 * `test/integration/` proves a dispatch works; it cannot show that provenance
 * was written BEFORE the prompt rather than after it, because both orders
 * produce a correct-looking ledger in a test where the worker does not race
 * the write. The failure only appears when a worker invokes a gated verb in
 * the instant after being prompted — which is precisely the case a test cannot
 * schedule reliably. So the property asserted is the one that IS observable in
 * the source, exactly as `supervisor-session-latch.test.ts` argues for the
 * session latch.
 *
 * Comment-stripped, for the reason that file gives: this module explains the
 * ordering in prose directly above the call, so a naive index-of on the raw
 * text would be satisfied by the COMMENT and stay green with the call deleted.
 */
describe("the supervisor stamps provenance at the right two moments", () => {
  const supervisor = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

  test("the dispatch write happens after the fence and before the worker is marked busy", () => {
    const fence = supervisor.indexOf("await persistFence();");
    const write = supervisor.indexOf("await writeTaskPolicy(wp.taskPolicy, envelope.task_id");
    const busy = supervisor.indexOf('state.phase = "busy";');

    expect(fence, "persistFence call not found — the probe has rotted").toBeGreaterThan(-1);
    expect(write, "no dispatch-time writeTaskPolicy call").toBeGreaterThan(-1);
    expect(busy, "busy transition not found — the probe has rotted").toBeGreaterThan(-1);

    expect(write).toBeGreaterThan(fence);
    expect(write).toBeLessThan(busy);
  });

  test("settle clears the provenance, so idle verbs are not attributed to a finished task", () => {
    const clear = supervisor.indexOf("await writeTaskPolicy(wp.taskPolicy, null, 0);");
    const idle = supervisor.indexOf("state.task_id = null;");
    expect(clear, "no settle-time writeTaskPolicy call").toBeGreaterThan(-1);
    expect(idle, "settle reset not found — the probe has rotted").toBeGreaterThan(-1);
    expect(clear).toBeLessThan(idle);
  });

  test("provenance is written in exactly the two places, so neither can cover for the other", () => {
    // Exactly two CALL sites. The import names the symbol without a paren, so
    // it does not count — a third match means a third place stamping
    // provenance, which is how one call site starts covering for a deleted
    // other and the pair of ordering probes above stops being able to fail.
    const calls = supervisor.split("writeTaskPolicy(").length - 1;
    expect(calls).toBe(2);
  });
});
