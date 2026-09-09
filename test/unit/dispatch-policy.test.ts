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
 * - **The gate checks every policy file, now four.** D4's recorded cost is that
 *   the integrity loop gains a path, and `docker/verbgate`'s exit-78 is the only
 *   thing enforcing read-only-ness. A mount added without a check is the
 *   failure, so the probe derives the expected set from the gate's own
 *   declarations rather than counting to three — which is what let ISC-1092's
 *   `/policy/replies` be added to that surface, and then to this loop, without
 *   the probe having to be rewritten to notice.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
/**
 * ISC-1092's constant, imported from the HOST rather than typed: the gate and
 * the renderer are asserted against one spelling of `/policy/replies`, and a
 * literal here would be a third that agrees with them until the day it does not.
 */
import { REPLIES_POLICY_MOUNT } from "../../src/run/replies-policy.ts";
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

  /**
   * THE WIDEN/NARROW WINDOW — the same hazard `replies.test.ts:206-241` closes
   * on the reply plane, carried to the drop it was copied from.
   *
   * `writeDispatchPolicy` widens to 0644, calls `writeFile` — whose default `w`
   * flag is `O_TRUNC` — and narrows back to 0444. A failure BETWEEN those two
   * leaves the drop writable and truncated, permanently, because the write that
   * would have repaired it is the stage that just failed. That is not one lost
   * dispatch: `/policy/dispatch` is one of the three paths `docker/verbgate`'s
   * integrity loop iterates, and a policy surface writable by the uid consulting
   * it refuses EVERY gated verb with exit 78 — so the worker loses `git`, `gh`
   * and the rest for the life of the container, and the brief it can now rewrite
   * is the brief it is graded against.
   *
   * A directory planted at the drop's path is the deterministic way to fail the
   * write between two chmods that both succeed — measured: `chmod` on it returns
   * 0 and leaves mode 0644, `writeFile` on it returns EISDIR. EISDIR is not the
   * interesting part and nothing here claims it is the only way in; ENOSPC and
   * EIO reach the same window through a filesystem this test cannot arrange.
   *
   * THE MODE IS THE ASSERTION, and this is precisely why the sibling test above
   * is not enough on its own: `rejects.toThrow()` passes with or without the
   * repair, which is how this window survived in this file while its twin was
   * being fixed next door.
   */
  test("narrows the drop back to 0444 even when the write itself fails", async () => {
    const dir = await scratch();
    const asDir = join(dir, "dispatch-policy");
    await mkdir(asDir);
    // Pre-set rather than left to the ambient umask: the assertion below is
    // "restored to 0444", so the starting mode has to be 0444 for the test to
    // be about the restore rather than about the runner.
    await chmod(asDir, 0o444);

    const err = await writeDispatchPolicy(asDir, IDENTITY, "# One\n").catch((e: unknown) => e);

    // The WRITE's error propagates — not a chmod's, which would tell the caller
    // the wrong thing about what went wrong and send them to the wrong file.
    expect((err as NodeJS.ErrnoException).code).toBe("EISDIR");
    // And the widen was undone. Without the restore this reads 0o644.
    expect((await stat(asDir)).mode & 0o777).toBe(0o444);
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
  /**
   * WHAT WOULD BREAK IF THIS WERE DELETED: a gated surface could be declared in
   * the shim and left out of the integrity loop, which is a mount whose `:ro`
   * has nothing checking it — and a dropped `:ro` is one character with no other
   * symptom.
   */
  test("every read-only surface the gate declares is a path its integrity loop checks", async () => {
    const gate = await readFile("docker/verbgate", "utf8");

    // DERIVED, not counted: the failure D4 records is a mount added without a
    // check, and a probe that asserted "three paths" would go green again the
    // moment a fourth was declared and not looped. So the expected set comes
    // from the gate's own declarations of the surfaces it is handed read-only.
    //
    // The alternation is ENUMERATED rather than widened to "any absolute path",
    // and that is what keeps it a probe. `ledger="/outbox/ledger/verbgate.jsonl"`
    // is a declaration too, and it is on a mount the worker legitimately WRITES
    // — a pattern loose enough to catch it would demand the loop refuse every
    // verb on every fleet. Adding a sixth surface therefore costs one word here,
    // deliberately, so that the addition is a decision rather than a default.
    const declared = [
      ...gate.matchAll(/^(\w+)="(\/(?:policy\/[A-Za-z0-9._-]+|replies))"$/gm),
    ].map((m) => m[1]!);

    /*
     * THE WHOLE INTEGRITY SECTION, not one `for` line, and the widening is
     * forced by a real asymmetry rather than by convenience.
     *
     * The four FILE surfaces are checked directly AND through their parent,
     * because a writable `/policy` replaces a 0444 `cloud-allow` wholesale. The
     * reply plane is a DIRECTORY: its own write bit already carries that, and
     * giving it the parent arm asks `[ -w / ]`, which is TRUE for root — the uid
     * `docker/Dockerfile`'s smoke-test layer runs these shims as, before its
     * `USER 10001:10001` line. Putting it in the loop failed the image build.
     * So it is checked beside the loop, and a probe that reads only the loop
     * line would now report the reply plane as uncovered when it is not.
     *
     * COMMENTS ARE STRIPPED FIRST. This section explains itself at length and
     * names every surface in prose; without the strip, a surface DECLARED and
     * then discussed but never tested would count as covered, which is the exact
     * failure the probe exists to catch.
     */
    const section = gate.match(
      /^# --- policy integrity -+$\n([\s\S]*?)^# --- collect leading non-flag tokens/m,
    );
    expect(section, "the integrity section was not found — the probe has rotted").not.toBeNull();
    const code = section![1]!
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const covered = [...new Set([...code.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!))].filter((n) =>
      declared.includes(n),
    );

    // CONTROL: five today — allow, task, drop, the DECLARED REPLY SET
    // (`/policy/replies`, SRD-WORKER-DISPATCH-EXTENSION §7.4), and the reply
    // plane (`/replies`, SRD-REVIEW-CONSOLE D6). The equality below is the
    // assertion; this line is what stops both extractors matching nothing.
    //
    // MOVED FROM FOUR RATHER THAN RELAXED, and the number is what makes the
    // move visible: the equality alone goes green for a surface that is neither
    // declared nor checked, so a declaration DELETED from the gate would read as
    // clean. Four to five is the record that a fifth arrived, and it is the arm
    // that reddens when the declaration goes away while the loop still names it.
    expect(declared.length).toBe(5);
    expect([...covered].sort()).toEqual([...declared].sort());
  });

  /**
   * WHAT WOULD BREAK IF THIS WERE DELETED: the surface above is DERIVED from the
   * gate's own text, so it is satisfied by any five declarations that are all
   * looped — including five that no longer include this one. The set criterion
   * cannot notice a path being renamed out from under the host; this row names
   * it, from the host's constant, at both ends of the one mount.
   *
   * ISC-1092, and the sibling of the drop's row below it. `/policy/replies` is
   * one word from `/replies` and they are different objects — a FILE naming
   * which replies count for this turn, against a DIRECTORY holding them — so the
   * path is asserted against the host's own constant rather than by eye, and the
   * FILE loop is named rather than "the integrity section".
   *
   * The renderer's half is deliberately NOT re-asserted here. `render.test.ts`
   * pins `${repliesPolicyHostPath(worker.dir)}:${REPLIES_POLICY_MOUNT}:ro`
   * against the renderer's real output, which is strictly stronger than a
   * `toContain` over its source, and a weaker second copy would be a spelling
   * that can disagree with it.
   */
  test("the gate holds the declared reply set in the FILE loop, at the host's constant", async () => {
    const gate = await readFile("docker/verbgate", "utf8");
    expect(gate).toContain(`="${REPLIES_POLICY_MOUNT}"`);
    // In the FILE loop and not beside it: its dirname is `/policy`, which the
    // other three arms already ask about, where `/replies`'s dirname is `/` and
    // is TRUE for the root the image build's smoke-test layer runs these shims
    // as. Putting the reply PLANE in this loop failed the build; putting the
    // declared SET in it costs nothing, and the two facts differ by one word.
    const loop = gate.match(/^for policy_path in (.+); do$/m);
    expect(loop, "the integrity loop was not found — this probe has rotted").not.toBeNull();
    // `/` needs no escaping in a RegExp built from a string, and the mount is a
    // constant of this repository rather than input — so it is interpolated
    // directly, which keeps the one spelling of the path the one being asserted.
    const declaredAs = gate.match(new RegExp(`^(\\w+)="${REPLIES_POLICY_MOUNT}"$`, "m"));
    expect(declaredAs, "the gate no longer declares the reply set").not.toBeNull();
    expect(loop![1]).toContain(`\${${declaredAs![1]!}}`);
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

/**
 * ISC-1114 — THE RESET RACE, pinned where it can only be broken deliberately.
 *
 * The behavioural half lives in `test/integration/supervisor.test.ts` ("a
 * settled epoch leaves the drop disarmed"): it boots a real supervisor, settles
 * a real task and reads the drop. What that test CANNOT see is the order of two
 * writes it only ever observes after both have happened — and the order is the
 * whole property.
 *
 * The console types `/new` only after `awaitSettled` returns, and `awaitSettled`
 * returns on the existence of the task record. So "record exists" must imply
 * "drop is idle". Clear after the record and that implication is false for a
 * window of one file write — which is the same window, in the same direction,
 * as the bug being fixed, just narrower. Narrower is not fixed.
 *
 * Structural for `materializeWorkerInputs`' reason one describe up: no unit test
 * can schedule a `/new` against a settle. What IS observable is that the clear
 * precedes the record write in the one function that performs both.
 */
describe("the supervisor disarms the drop BEFORE the record that unblocks the reset (ISC-1114)", () => {
  test("clearDispatchPolicy precedes writeTaskRecord inside settle", async () => {
    const src = await readFile("src/supervisor/index.ts", "utf8");
    /*
     * Scoped to `settle`, not to the file. `writeTaskRecord` is imported at the
     * top and the drop is also cleared at `up`; a whole-file `indexOf` would
     * compare an import line against a call in another function and pass for
     * reasons that have nothing to do with this ordering.
     */
    const from = src.indexOf("const settle = async (verdict: Verdict, reason: string)");
    expect(from, "settle() has been renamed — re-anchor this guard").toBeGreaterThan(-1);
    const body = src.slice(from);

    const clear = body.indexOf("await clearDispatchPolicy(wp.dispatchPolicy);");
    const record = body.indexOf("await writeTaskRecord(taskRecordPath(wp, settled.task_id)");
    expect(clear, "settle() no longer disarms the drop — ISC-1114 is back").toBeGreaterThan(-1);
    expect(record, "settle() no longer writes a task record").toBeGreaterThan(-1);
    expect(
      clear,
      "the drop is cleared AFTER the record that releases `awaitSettled`, so a `/new` can " +
        "land on a still-armed trigger and re-run the task that just settled",
    ).toBeLessThan(record);
  });

  /**
   * The failure must be VISIBLE, and this is the direction that is easy to lose.
   *
   * A settle may not be blocked by a file write, so the clear is wrapped. A bare
   * `catch {}` would then make "the trigger is still armed" and "the trigger was
   * disarmed" produce byte-identical output — an absence of evidence read as
   * evidence, which is precisely how this defect survived: a docblock asserted
   * the call site and nothing anywhere disagreed with it.
   */
  test("a clear that throws is logged rather than swallowed", async () => {
    const src = await readFile("src/supervisor/index.ts", "utf8");
    expect(src).toContain('type: "dispatch_drop_clear_failed"');
  });
});
