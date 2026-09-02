/**
 * The task drop — SRD-TUI-DISPATCH §6.2 and D4.
 *
 * `/policy/dispatch` is a SIBLING of `/policy/task`, not an extension of it,
 * and every property worth a test here is a property it inherits from that
 * sibling relationship rather than one it invents. So the tests are shaped like
 * `task-policy.test.ts`'s deliberately: a reader comparing the two files should
 * see the same four hazards guarded the same four ways, because the moment they
 * diverge is the moment one of the two policy files stops being covered by the
 * argument that covers the other.
 *
 * Five properties, and each has a specific way of silently coming untrue:
 *
 * - **The inode survives a rewrite.** A bind mount pins the inode. Swap the
 *   in-place write for the tmp-file + rename idiom that most "atomic write"
 *   advice recommends and the host sees a new file while the container reads
 *   the old one forever — with BOTH sides believing a new task was staged. This
 *   is the one that cannot be caught by reading the code, because the wrong
 *   version looks more careful than the right one.
 * - **The file is 0444 when it is not being written.** A worker that can write
 *   its own brief can rewrite the task it was given and then report on the task
 *   it wrote. `docker/verbgate` refuses every verb when it is writable, which
 *   makes the mode load-bearing for the gate as well as for the drop.
 * - **The two halves come back apart.** The drop is the only route on which the
 *   prompt is delivered as a FILE rather than as bytes typed at a pty, so
 *   "byte-identical to what the rpc route renders" (§10, Staging) is checkable
 *   here and nowhere else. A split that trimmed, normalised or re-wrapped
 *   anything would pass a `toContain` and fail the criterion.
 * - **A prompt cannot forge the split.** The brief is operator text and may
 *   quote this file's own format — an SRD excerpt about the drop is the obvious
 *   case, and this test suite's own fixtures are the next one.
 * - **The gate checks all three policy files.** D4's recorded cost is that the
 *   integrity loop gains a path, and `docker/verbgate:120-127`'s exit-78 is the
 *   only thing enforcing read-only-ness. A mount added without a check is the
 *   failure, so the probe derives the expected set from the gate's own
 *   declarations rather than counting to three.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISPATCH_POLICY_MOUNT,
  DISPATCH_POLICY_SEPARATOR,
  DispatchPolicyTooLargeError,
  MAX_DISPATCH_POLICY_BYTES,
  clearDispatchPolicy,
  renderDispatchPolicy,
  splitDispatchPolicy,
  writeDispatchPolicy,
} from "../../src/run/dispatch-policy.ts";
import { TASK_POLICY_NONE } from "../../src/run/task-policy.ts";
import { renderPrompt } from "../../src/supervisor/index.ts";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "dispatch-policy-"));
}

const IDENTITY = {
  task_id: "T-stage-1",
  run_id: "R-2026-09-02",
  worker: "eng-1",
  epoch: 3,
  attempt: 1,
  outbox: "/outbox/T-stage-1",
  dispatched_at: "2026-09-02T10:00:00.000Z",
} as const;

describe("the task drop file", () => {
  test("keeps its INODE across rewrites, because a bind mount pins it", async () => {
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");

    await writeDispatchPolicy(file, IDENTITY, "# First\n\nbrief one\n");
    const first = await stat(file);

    await writeDispatchPolicy(file, { ...IDENTITY, task_id: "T-stage-2", epoch: 4 }, "# Second\n");
    const second = await stat(file);

    // The assertion is the inode, not the content: a rename-based writer
    // updates the content the HOST reads and leaves the container on the old
    // inode, so a content-only check passes while the container is stale.
    expect(second.ino).toBe(first.ino);
    expect(splitDispatchPolicy(await readFile(file, "utf8")).prompt).toBe("# Second\n");
  });

  test("is 0444 between writes, so the worker cannot rewrite its own brief", async () => {
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");

    await writeDispatchPolicy(file, IDENTITY, "# One\n");
    expect((await stat(file)).mode & 0o777).toBe(0o444);

    // And the SECOND write still succeeds against that 0444 — on POSIX the
    // owner of a read-only file cannot open it for writing either, so a writer
    // that forgot to widen first would work exactly once per run. That is the
    // shape the cloud-allow file was found in (materialize.ts:849-860), and it
    // costs a whole launch rather than one dispatch.
    await writeDispatchPolicy(file, { ...IDENTITY, epoch: 4 }, "# Two\n");
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(splitDispatchPolicy(await readFile(file, "utf8")).prompt).toBe("# Two\n");
  });

  test("creates the file when it does not exist yet, without a pre-chmod", async () => {
    // `materialize.ts` calls this before `docker run` so the mount has an inode
    // to pin: a bind-mount source that does not exist makes Docker create a
    // DIRECTORY at the host path, and the drop can then never have content.
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");
    await clearDispatchPolicy(file);
    expect((await stat(file)).isFile()).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
  });

  test("propagates a chmod failure that is NOT the file simply being absent", async () => {
    // A directory in place of the file: chmod succeeds, the write fails with
    // EISDIR. The point is that the writer does not swallow it — the ENOENT
    // catch is narrow, and a policy file that cannot be written must be loud
    // rather than leaving a worker staged against a brief nobody wrote.
    const dir = await scratch();
    const asDir = join(dir, "dispatch-policy");
    await mkdir(asDir);
    await expect(writeDispatchPolicy(asDir, IDENTITY, "# One\n")).rejects.toThrow();
  });
});

describe("the drop's two halves", () => {
  test("a rendered drop splits back into the identity and the byte-identical prompt", () => {
    const prompt = renderPrompt({
      title: "Re-check the DR filter",
      brief: "The warm filter applies to phase 2 only.\n\nRead the script first.",
      acceptance: ["the filter is asserted", "the assertion can fail"],
      task_id: IDENTITY.task_id,
      outbox: IDENTITY.outbox,
      worker: IDENTITY.worker,
      epoch: IDENTITY.epoch,
    });

    // `renderPrompt` and not a hand-built string, because the criterion §10
    // states is that the staged prompt is byte-identical to what the RPC route
    // would render for the same envelope. A fixture of this file's own
    // invention could satisfy a round-trip while the real document — fenced
    // blocks, blank lines, a trailing sentence with no newline — did not.
    const { identity, prompt: recovered } = splitDispatchPolicy(
      renderDispatchPolicy(IDENTITY, prompt),
    );
    expect(recovered).toBe(prompt);
    expect(identity).toEqual({ schema: "pifleet.dispatch/v1", staged: true, ...IDENTITY });
  });

  test("the identity half is ONE line, so the separator is always line 2", () => {
    // The constructive guarantee the split rests on. `JSON.stringify` escapes
    // every newline inside a string value, so no operator-supplied field can
    // introduce a second line into the header — which is what makes "the first
    // separator line is the real one" a fact rather than a hope.
    const rendered = renderDispatchPolicy(
      { ...IDENTITY, task_id: "T-1\nT-2", outbox: `/outbox/x\n${DISPATCH_POLICY_SEPARATOR}\ny` },
      "body\n",
    );
    const lines = rendered.split("\n");
    expect(lines[1]).toBe(DISPATCH_POLICY_SEPARATOR);
    expect(JSON.parse(lines[0]!)).toMatchObject({ task_id: "T-1\nT-2" });
  });

  test("a prompt that QUOTES the separator still splits at the real one", () => {
    // Operator text, and the obvious case is a brief that excerpts §6.2 of the
    // SRD describing this very file. The split takes the FIRST occurrence and
    // the header cannot contain one, so the first is always the real one and
    // the quoted copy survives into the prompt verbatim.
    const hostile =
      `Read the drop format:\n\n${DISPATCH_POLICY_SEPARATOR}\n\nand then fix it.\n`;
    const { prompt } = splitDispatchPolicy(renderDispatchPolicy(IDENTITY, hostile));
    expect(prompt).toBe(hostile);
    expect(prompt).toContain(DISPATCH_POLICY_SEPARATOR);
  });

  test("an unstaged drop says so in a field, not in prose a brief could imitate", () => {
    const rendered = renderDispatchPolicy(null, "");
    const { identity, prompt } = splitDispatchPolicy(rendered);
    expect(identity).toEqual({ schema: "pifleet.dispatch/v1", staged: false });
    // The prompt half reads as the same "nothing" the verbgate's own fallback
    // and `/policy/task` spell, so an idle worker and a missing mount are one
    // string rather than two.
    expect(prompt).toBe(`${TASK_POLICY_NONE}\n`);
  });

  test("a body with no separator is refused rather than read as an empty prompt", () => {
    // The reader's half of the contract. A truncated or hand-edited drop must
    // not degrade to "a task with an empty brief", which is a task the worker
    // would attempt.
    expect(() => splitDispatchPolicy("{}\n")).toThrow();
  });
});

describe("the size cap", () => {
  test("refuses an oversized drop by a NAMED error, before the file is touched", async () => {
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");
    await clearDispatchPolicy(file);
    const before = await readFile(file, "utf8");
    const beforeStat = await stat(file);

    const huge = "x".repeat(MAX_DISPATCH_POLICY_BYTES + 1);
    await expect(writeDispatchPolicy(file, IDENTITY, huge)).rejects.toThrow(
      DispatchPolicyTooLargeError,
    );

    // NOT MODIFIED is the assertion, and it is the whole reason the cap is
    // checked before the first chmod: a writer that widened, wrote, and then
    // discovered the size would leave a half-written brief at 0644 — a drop the
    // worker can both read wrong and write, which is worse than the refusal.
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("the refusal names the measured size and the limit, so it is actionable", async () => {
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");
    const huge = "x".repeat(MAX_DISPATCH_POLICY_BYTES + 1);
    const err = await writeDispatchPolicy(file, IDENTITY, huge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchPolicyTooLargeError);
    const e = err as DispatchPolicyTooLargeError;
    expect(e.bytes).toBeGreaterThan(MAX_DISPATCH_POLICY_BYTES);
    expect(e.limit).toBe(MAX_DISPATCH_POLICY_BYTES);
    expect(e.message).toContain(IDENTITY.task_id);
  });

  test("measures BYTES and not characters, so a non-ASCII brief is bounded too", async () => {
    // "…" is three bytes in UTF-8 and one JavaScript character, so this brief
    // is comfortably UNDER the cap by `.length` and over it by `byteLength`. It
    // has to be refused, and the refusal is what makes the distinction testable
    // — asserting the two measurements differ would document the fact without
    // probing the writer, and a writer switched to `.length` would stay green.
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");
    const justUnderInChars = "…".repeat(Math.floor(MAX_DISPATCH_POLICY_BYTES / 2));
    const rendered = renderDispatchPolicy(IDENTITY, justUnderInChars);
    expect(rendered.length).toBeLessThan(MAX_DISPATCH_POLICY_BYTES);
    expect(Buffer.byteLength(rendered, "utf8")).toBeGreaterThan(MAX_DISPATCH_POLICY_BYTES);

    await expect(writeDispatchPolicy(file, IDENTITY, justUnderInChars)).rejects.toThrow(
      DispatchPolicyTooLargeError,
    );
  });

  test("a drop at the schema maximum for title and brief is NOT refused", async () => {
    // The cap has to admit everything the envelope schema admits in the two
    // fields the prompt is built from (`MAX_TEXT` each), or a task that
    // validates would be unstageable and the refusal would read as a bug.
    const dir = await scratch();
    const file = join(dir, "dispatch-policy");
    const prompt = renderPrompt({
      title: "t".repeat(65_536),
      brief: "b".repeat(65_536),
      acceptance: [],
      task_id: IDENTITY.task_id,
      outbox: IDENTITY.outbox,
      worker: IDENTITY.worker,
      epoch: IDENTITY.epoch,
    });
    await writeDispatchPolicy(file, IDENTITY, prompt);
    expect(splitDispatchPolicy(await readFile(file, "utf8")).prompt).toBe(prompt);
  });
});

describe("the gate holds the drop to the same integrity bar as the other two", () => {
  test("every /policy file the gate declares is a path its integrity loop checks", async () => {
    const gate = await readFile("docker/verbgate", "utf8");

    // DERIVED, not counted: the failure D4 records is a mount added without a
    // check, and a probe that asserted "three paths" would go green again the
    // moment a fourth was declared and not looped. So the expected set comes
    // from the gate's own `*_file="/policy/..."` declarations.
    const declared = [...gate.matchAll(/^(\w+)="(\/policy\/[A-Za-z0-9._-]+)"$/gm)].map(
      (m) => m[1]!,
    );
    const loop = gate.match(/^for policy_path in (.+); do$/m);
    expect(loop, "the integrity loop was not found — the probe has rotted").not.toBeNull();
    const covered = [...loop![1]!.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!);

    // CONTROL: three today — allow, task, drop. The equality below is the
    // assertion; this line is what stops both extractors matching nothing.
    expect(declared.length).toBe(3);
    expect([...covered].sort()).toEqual([...declared].sort());
  });

  test("the gate reads the drop at the path the renderer mounts it on", async () => {
    const gate = await readFile("docker/verbgate", "utf8");
    expect(gate).toContain(`="${DISPATCH_POLICY_MOUNT}"`);
    expect(gate).toContain("exit 78");
  });

  test("the renderer mounts the drop read-only at the constant the gate names", async () => {
    // The two ends of one mount, asserted against the same constant. A `-v`
    // that dropped `:ro` would leave the file writable INSIDE the container
    // regardless of its 0444 on the host under the macOS ownership squash, and
    // the gate would then refuse every verb — a whole worker lost to a missing
    // three characters.
    const render = await readFile("src/config/render.ts", "utf8");
    expect(render).toContain("`${opts.worker.dispatchPolicy}:${DISPATCH_POLICY_MOUNT}:ro`");
  });
});

describe("materialize establishes the drop before the container starts", () => {
  test("the inode is created beside the task policy, from the same establishing block", async () => {
    // Structural, for `task-policy.test.ts`'s reason: what must be true is an
    // ORDER — the file exists before `docker run` — and no unit test can
    // schedule a container against a materialize. What IS observable is that
    // the call sits in `materializeWorkerInputs` alongside the sibling whose
    // ordering is already established, and that the symlink refusal precedes it.
    const src = await readFile("src/run/materialize.ts", "utf8");
    const refuse = src.indexOf("await refuseSymlinkDestination(paths.dispatchPolicy);");
    const write = src.indexOf("await clearDispatchPolicy(paths.dispatchPolicy);");
    expect(refuse, "no symlink refusal for the drop").toBeGreaterThan(-1);
    expect(write, "no establishing write for the drop").toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(write);
  });
});
