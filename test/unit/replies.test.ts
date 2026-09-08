/**
 * The REPLY PLANE — `/replies`, SRD-REVIEW-CONSOLE §6.4 and D6.
 *
 * SRD §10 asks for exactly two properties here, and each has a specific way of
 * silently coming untrue:
 *
 * - **`/replies` is 0444, mounted `:ro`, and REWRITTEN IN PLACE.** *"Probe:
 *   assert the inode is unchanged across two writes; a rename fails."* This is
 *   the one that cannot be caught by reading the code, because the wrong version
 *   looks MORE careful than the right one: tmp-file + rename is what nearly all
 *   "atomic write" advice recommends, and against a bind mount it swaps the file
 *   the HOST sees while the container keeps reading the old inode for the life
 *   of the container — with both sides believing the reply changed.
 * - **The verbgate refuses to run when the reply plane is writable.** SRD §10
 *   words this as *"chmod one and assert exit 78 — the existing loop, one path
 *   wider"*, and the wording outran the mechanism. What the gate can actually
 *   observe is measured at `docker/verbgate`'s integrity loop: a writable reply
 *   DIRECTORY, which is the entire observable of a dropped `:ro`. A writable
 *   reply FILE beneath a closed directory is not reachable from any mode this
 *   module writes, so the block at the bottom asserts that LIMIT rather than
 *   asserting past it.
 *
 * ## Why the gate is EXECUTED here rather than grepped
 *
 * `dispatch-policy.test.ts` pins the loop's SHAPE — every declared surface is a
 * looped path — and a shape probe cannot tell a loop that CHECKS `/replies` from
 * one that merely mentions it. Running the real gate against a writable reply
 * directory is what tells those apart.
 *
 * THE REFUSAL'S TEXT IS ASSERTED, NOT ONLY ITS EXIT CODE, and that is a repair
 * rather than a flourish. This block previously read the integer alone, and the
 * integer could not see its own defect: with the sandbox ROOT left at mkdtemp's
 * 0700, `dirname` of the replies directory was writable, so a gate naming
 * `/replies` and a gate naming one reply INSIDE it both exited 78 — for two
 * different reasons, one of which was the harness. The gate names the offending
 * path in its own refusal, so the probe reads that instead. The sandbox below
 * nests every gated surface under a 0555 intermediate that plays the container's
 * read-only `/`, which is what removes the harness from the answer.
 *
 * The gate's paths are CONSTANTS, deliberately (`docker/verbgate`'s header: *"a
 * control the subject can reconfigure is not a control"*), so a host-side probe
 * has to rewrite them. That rewrite is the probe's own weakest point — a renamed
 * constant would produce a gate still pointing at `/policy/...`, which does not
 * exist on the host, so every `[ -w ]` reads false and the test goes GREEN while
 * checking nothing. `sandboxGate` therefore asserts that every substitution
 * landed and that no absolute policy path survives it. Without that control this
 * whole block is decorative.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPLIES_MOUNT,
  REPLY_SUFFIX,
  ReplyNameError,
  createRepliesDir,
  replyFileName,
  replyHostPath,
  replyMountPath,
  writeReply,
} from "../../src/run/replies.ts";
import { EXIT } from "../../src/contracts.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) {
    // Everything this file writes is deliberately 0444 under a 0555 directory,
    // which `rm -rf` cannot remove without help. Reopening first is the tidy-up
    // and not part of any assertion.
    await Bun.spawn(["chmod", "-R", "u+rwX", dir], { stdout: "ignore", stderr: "ignore" }).exited;
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix = "replies-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

// ---------------------------------------------------------------------------
// The write recipe
// ---------------------------------------------------------------------------

describe("a reply file", () => {
  /**
   * THE HEADLINE PROBE (SRD §10).
   *
   * WHAT WOULD BREAK IF THIS ASSERTION WERE REMOVED: nothing visible, and that
   * is the point. Swap `writeFile` for write-to-temp + `rename` and the CONTENT
   * assertion below still passes — the host reads the new bytes — while the
   * container reads the original inode until it dies. There is no error, no log
   * line, and no other test in the repository that can tell the two apart. The
   * inode is the only observable difference between the correct writer and the
   * one that looks more careful.
   */
  test("keeps its INODE across rewrites, because a bind mount pins it", async () => {
    const dir = await scratch();
    await createRepliesDir(dir);

    const first = await writeReply(dir, "T-arch", { status: "success", findings: 1 });
    const before = await stat(first);

    const second = await writeReply(dir, "T-arch", { status: "partial", findings: 2 });
    const after = await stat(second);

    expect(second).toBe(first);
    expect(after.ino).toBe(before.ino);
    // The content check is the CONTROL, not the assertion: without it, a writer
    // that did nothing at all would also keep the inode.
    expect(JSON.parse(await readFile(first, "utf8"))).toEqual({
      status: "partial",
      findings: 2,
    });
  });

  /**
   * WHAT WOULD BREAK IF THIS WERE REMOVED: the second write is the assertion.
   * On POSIX the OWNER of a 0444 file cannot open it for writing either, so a
   * writer that forgot the widen works exactly once — which every single-write
   * test in this file would fail to notice, and which in production means the
   * FIRST reply is delivered and every re-delivery is an unexplained EACCES.
   */
  test("is 0444 between writes, and a second write still lands", async () => {
    const dir = await scratch();
    await createRepliesDir(dir);

    const file = await writeReply(dir, "T-lang", { n: 1 });
    expect(await mode(file)).toBe(0o444);
    expect((await mode(file)) & 0o222).toBe(0);

    await writeReply(dir, "T-lang", { n: 2 });
    expect(await mode(file)).toBe(0o444);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 2 });
  });

  test("creates the file when it does not exist yet, without a pre-chmod", async () => {
    // The ENOENT catch is what makes the FIRST write work at all — the widen is
    // skipped only for a file that has no inode yet. A catch any wider would
    // swallow the EACCES that says a reply could not be reopened.
    const dir = await scratch();
    await createRepliesDir(dir);
    const file = await writeReply(dir, "T-context", { fresh: true });
    expect((await stat(file)).isFile()).toBe(true);
    expect(await mode(file)).toBe(0o444);
  });

  /**
   * THE ENOENT DISCRIMINATION, probed where it actually lives.
   *
   * This test used to plant a DIRECTORY at the reply path and describe it as
   * "chmod succeeds, writeFile fails EISDIR" — which is an accurate account of
   * that fixture and a probe of the wrong statement. `chmod` on a directory
   * SUCCEEDS, so the rejection came from `writeFile`, which is OUTSIDE the try
   * block the test claimed to be exercising. Deleting the ENOENT discrimination
   * from `writeReply` entirely left the file at 25 pass / 0 fail.
   *
   * A chmod that fails for a reason OTHER than absence needs the chmod itself to
   * fail. An existing reply under a parent with no execute bit does it: path
   * resolution needs `x` on every directory component, the owner class is
   * checked first and has none, so `chmod` returns EACCES rather than ENOENT.
   * Measured on this platform before being relied on.
   *
   * THE ASSERTION IS ON `syscall`, NOT ON `code`, AND THAT IS THE WHOLE PROBE.
   * Measured: a writer that widened its catch to `void err` swallows the chmod,
   * falls through to `writeFile`, and fails there — with the SAME `EACCES`, on
   * the SAME path, because the missing execute bit denies both calls. Asserting
   * the code left that mutant alive at 94 pass / 0 fail. The two are
   * distinguishable only by which call raised:
   *
   *     chmod  -> code=EACCES  syscall=chmod
   *     write  -> code=EACCES  syscall=open
   *
   * So `syscall === "chmod"` is the assertion, and it says exactly what the test
   * name claims: the error propagated FROM THE CHMOD, rather than the chmod
   * being swallowed and something later failing to look similar.
   */
  test("propagates a chmod failure that is NOT the file simply being absent", async () => {
    const dir = await scratch();
    await createRepliesDir(dir);
    const file = await writeReply(dir, "T-arch", { real: true });
    // Read and write, but NO execute: the reply is now unreachable by name to
    // its own owner, and `chmod` on it is EACCES.
    await chmod(dir, 0o644);

    const err = await writeReply(dir, "T-arch", { x: 1 }).catch((e: unknown) => e);
    // Restore before asserting, so a failed expectation cannot leave the
    // directory untraversable for the rest of the file.
    await chmod(dir, 0o755);

    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
    expect((err as NodeJS.ErrnoException).syscall).toBe("chmod");
    // And the reply it could not reopen is untouched — still 0444, still the
    // payload the last successful write left.
    expect(await mode(file)).toBe(0o444);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ real: true });
  });

  /**
   * THE WIDEN/NARROW WINDOW.
   *
   * `writeReply` widens to 0644, calls `writeFile` — whose default `w` flag is
   * `O_TRUNC` — and narrows back to 0444. A failure BETWEEN those two used to
   * leave the reply writable and truncated, permanently, with no further write
   * scheduled to repair it. That is the exact state this module's docblock spends
   * a paragraph explaining costs a whole worker: the collator can author the
   * evidence it is about to quote, and the verbgate answers a writable reply
   * plane by refusing every gated verb the worker attempts.
   *
   * A directory planted at the reply path is the deterministic way to fail the
   * write between two chmods that both succeed — measured: `chmod` on it returns
   * 0 and leaves mode 0644, `writeFile` on it returns EISDIR. EISDIR is not the
   * interesting part and nothing here asserts it is the only way in; ENOSPC and
   * EIO reach the same window through a filesystem this test cannot arrange.
   *
   * THE MODE IS THE ASSERTION. `rejects.toThrow()` passes with or without the
   * repair, which is why the old version of this fixture could sit in the file
   * without ever noticing the missing restore.
   */
  test("narrows the reply back to 0444 even when the write itself fails", async () => {
    const dir = await scratch();
    await createRepliesDir(dir);
    const at = replyHostPath(dir, "T-arch");
    await mkdir(at);
    await chmod(at, 0o444);

    const err = await writeReply(dir, "T-arch", { x: 1 }).catch((e: unknown) => e);

    // The write's own error propagates — not a chmod's, which would tell the
    // caller the wrong thing about what went wrong.
    expect((err as NodeJS.ErrnoException).code).toBe("EISDIR");
    // And the widen was undone. Without the restore this reads 0o644.
    expect(await mode(at)).toBe(0o444);
  });

  /**
   * WHAT WOULD BREAK IF THIS WERE REMOVED: `JSON.stringify(undefined)` returns
   * the VALUE `undefined`, and template-interpolating it writes the four
   * characters "undefined" into a `.json` file. A reply that parses as nothing
   * and reads as a word is worse than an absent one, because the absent one is
   * the case a collation brief can describe.
   */
  test("refuses a payload that does not serialise, without touching the file", async () => {
    const dir = await scratch();
    await createRepliesDir(dir);
    const file = await writeReply(dir, "T-arch", { real: true });
    const before = await stat(file);

    await expect(writeReply(dir, "T-arch", undefined)).rejects.toThrow(TypeError);

    // Unmodified AND still 0444: the refusal happens before the first chmod, so
    // a rejected write cannot leave a widened stale reply behind for the worker
    // to edit — and cannot leave the verbgate refusing every verb.
    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await mode(file)).toBe(0o444);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ real: true });
  });
});

describe("the reply directory", () => {
  /**
   * WHAT WOULD BREAK IF THIS WERE REMOVED: a `makeWorkerAccessible(dir, true)`
   * here — one boolean, copied from the outbox block next door — makes this
   * 0777, which is world-writable on the host and, through the verbgate's
   * `[ -w "$(dirname …)" ]` arm, every gated verb refused with exit 78 the
   * moment anything goes wrong with the mount. It also publishes the directory
   * holding the console's evidence to every account on the box.
   *
   * 0755, exactly like `roleSkillsDir` and for its reason: the OWNER writes it
   * (that is pifleet's actor delivering a reply) and nobody else may. What stops
   * the WORKER writing it is the `:ro` mount and not this mode — the macOS
   * Docker VM squashes bind-mount ownership to the container user, so inside the
   * container uid 10001 reads as the owner of a 0755 directory. Saying that
   * plainly is the point: the mode is the host-side control and `:ro` is the
   * container-side one, and confusing the two is how a `-v` loses three
   * characters without anybody noticing.
   */
  /**
   * THE DIRECTORY IS PRE-CREATED AT 0700, and that is what makes this a probe of
   * the CODE rather than of the runner's umask.
   *
   * `mkdir` under the umask 022 that every developer shell and `ubuntu-latest`
   * hands out already yields 0755, so a test that only called `createRepliesDir`
   * and asserted 0755 could not see `makeWorkerAccessible(dir, false)` being
   * deleted from it: measured at 75 pass / 0 fail with the chmod removed. The
   * same mutant fails 6 under `umask 077`, which is the tell — the assertion was
   * reading the ambient umask, and CI shares the blind spot rather than covering
   * it.
   *
   * Pinning it with a 0700 pre-create rather than by setting a umask inside the
   * test keeps the suite umask-INDEPENDENT: it now passes under either umask and
   * fails under either one if the chmod goes away, instead of trading one
   * environmental dependency for its opposite.
   */
  test("is repaired to traversable, owner-writable, and closed to everyone else", async () => {
    const dir = join(await scratch(), "replies");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    expect(await mode(dir)).toBe(0o700);

    await createRepliesDir(dir);

    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await mode(dir)).toBe(0o755);
    // Group and other: read and traverse, never write. The owner bit is
    // deliberately NOT asserted away — the actor has to be able to deliver.
    expect((await mode(dir)) & 0o022).toBe(0);
    expect((await mode(dir)) & 0o055).toBe(0o055);
  });

  test("is idempotent, so a re-materialized worker does not fail on an existing directory", async () => {
    // Same 0700 pre-create for the same reason, and here it also makes the
    // SECOND call the thing under test: a `createRepliesDir` whose chmod ran
    // only on a freshly created directory would leave this at 0700.
    const dir = join(await scratch(), "replies");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    await createRepliesDir(dir);
    await chmod(dir, 0o700);
    await createRepliesDir(dir);
    expect(await mode(dir)).toBe(0o755);
  });
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe("a child task id has to be a filename", () => {
  /**
   * WHAT WOULD BREAK IF THIS WERE REMOVED: `TaskEnvelopeSchema.task_id` is
   * `shortStr` — a length bound and nothing else — and the id on this path
   * arrives from a dispatch request the COLLATOR wrote. Without the grammar
   * check, `writeReply(dir, "../../control-auth.json", …)` is a `writeFile` and
   * a `chmod` on the run directory's control-socket secret, from a string a
   * container authored.
   */
  test.each([
    ["..", "the parent directory"],
    [".", "the directory itself, which a containment check calls contained"],
    ["../escape", "an ordinary traversal"],
    ["a/b", "a separator, which stays inside the root and is still not a name"],
    ["", "the empty string"],
    ["-leading", "a name that does not begin alphanumeric"],
    ["with space", "a name outside the segment grammar"],
    ["T\u0000arch", "an embedded NUL, which a syscall truncates at rather than refuses"],
  ])("refuses %p — %s", (id) => {
    expect(() => replyFileName(id)).toThrow(ReplyNameError);
    expect(() => replyMountPath(id)).toThrow(ReplyNameError);
  });

  test("refuses an id longer than a path segment ought to be", () => {
    expect(() => replyFileName("T-".concat("x".repeat(200)))).toThrow(ReplyNameError);
  });

  test("the refusal is a USAGE failure, not an internal one", () => {
    // ISC-216's shape: an orchestrator answers `INTERNAL` by retrying the
    // identical document forever. The remedy for a malformed id is to fix the
    // request that carried it, which is the operator's move.
    const err = ((): unknown => {
      try {
        replyFileName("..");
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ReplyNameError);
    expect((err as ReplyNameError).exitCode).toBe(EXIT.USAGE);
  });

  test("an ordinary id becomes one file under the mount the renderer emits", () => {
    expect(replyFileName("T-arch")).toBe(`T-arch${REPLY_SUFFIX}`);
    expect(replyMountPath("T-arch")).toBe(`${REPLIES_MOUNT}/T-arch${REPLY_SUFFIX}`);
    // The container path is derived from the SAME constant `render.ts` mounts,
    // so a brief that names a reply and the `-v` that delivers it cannot drift.
    expect(replyMountPath("T-arch").startsWith(`${REPLIES_MOUNT}/`)).toBe(true);
    expect(replyHostPath("/host/replies/rev-1", "T-arch")).toBe(
      `/host/replies/rev-1/T-arch${REPLY_SUFFIX}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The real `docker/verbgate`, with its five hard-coded surfaces re-rooted into a
 * host sandbox.
 *
 * Every substitution is CHECKED. A renamed constant would otherwise leave the
 * gate pointing at `/policy/cloud-allow` — a path that does not exist on a
 * developer's Mac or on CI — where `[ -w ]` reads false, the loop passes, and
 * every assertion below turns into "the gate did not refuse", which is what a
 * green run looks like. The counting is the difference between this block being
 * evidence and being decoration.
 */
async function sandboxGate(sandbox: string): Promise<string> {
  const source = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
  const root = join(sandbox, "root");
  const swaps: [string, string][] = [
    ['"/policy/cloud-allow"', `"${join(root, "policy", "cloud-allow")}"`],
    ['"/policy/task"', `"${join(root, "policy", "task")}"`],
    ['"/policy/dispatch"', `"${join(root, "policy", "dispatch")}"`],
    // ISC-1092's fourth file surface. Added here because the assertion below is
    // designed to force it: a surface declared in the gate and missing from
    // `swaps` would be checked against the real `/policy/replies`, which is
    // absent on a developer's Mac and on CI and therefore reads as clean.
    ['"/policy/replies"', `"${join(root, "policy", "replies")}"`],
    [`"${REPLIES_MOUNT}"`, `"${join(root, "replies")}"`],
    // The ledger stays OUTSIDE `root/`, because `/outbox` is writable in
    // production and `root/` is standing in for the read-only container root.
    // A ledger under it cannot be appended to, and the gate's own refusal path
    // writes a row before it exits 78 — so putting it there turns every probe
    // below into a test of a gate that could not log.
    ['"/outbox/ledger/verbgate.jsonl"', `"${join(sandbox, "ledger.jsonl")}"`],
  ];
  let text = source;
  for (const [from, to] of swaps) {
    expect(
      source.split(from).length - 1,
      `docker/verbgate no longer declares ${from} — this probe has rotted and would ` +
        `pass vacuously against the real, unreachable container paths`,
    ).toBe(1);
    text = text.replace(from, to);
  }
  // And nothing absolute survived. A sixth surface added to the gate without
  // being added to `swaps` would be checked against a real host path — usually
  // absent, which reads as clean, and occasionally present, which does not.
  expect(text).not.toMatch(/^\w+="\/(?:policy|replies)/m);

  // Named `kubectl` because `tool=$(basename "$0")` is what selects the verb
  // grammar; a script named `verbgate` classifies nothing and reaches the
  // mutating path by a different route.
  const file = join(sandbox, "kubectl");
  await writeFile(file, text);
  await chmod(file, 0o755);
  return file;
}

/**
 * A sandbox in the shape a launched worker sees, with ONE deliberate difference
 * that has to be stated rather than glossed.
 *
 * In a container every one of these surfaces arrives through a `:ro` bind mount,
 * and `access(W_OK)` returns EROFS on a read-only filesystem regardless of mode
 * or ownership — which is what makes `[ -w ]` false for a `/skills` directory
 * that is 0755 on the host. A host-side probe has no `:ro` to borrow, and the
 * process running it OWNS every path, so 0755 here would read as writable and
 * the gate would refuse before any test had said anything.
 *
 * The containing DIRECTORIES are therefore closed to 0555, which is what the
 * mount flag provides in production. **This is an emulation and it is the
 * probe's boundary:** it exercises the loop's logic and it cannot prove that
 * Docker's `:ro` behaves as described — that claim belongs to
 * `test/integration/verbgate.test.ts`, which runs the shim inside the real image
 * and is gated on a built one.
 *
 * The FILES keep the 0444 `writeReply` gave them, un-emulated, because that is
 * the mode production actually depends on: the macOS Docker VM squashes
 * bind-mount FILE ownership to the container user, so a 0644 reply reads as
 * owner-writable INSIDE the container and only `:ro` stands between that and a
 * fleet-wide refusal.
 *
 * EVERY GATED SURFACE NESTS UNDER `root/`, WHICH IS CLOSED TO 0555, and that
 * intermediate is the fix for a real defect rather than tidiness. The gate's
 * integrity check is `[ -w "$path" ] || [ -w "$(dirname "$path")" ]`, so the
 * PARENT of each surface is part of the answer. Production's parents are `/` and
 * `/policy` inside a container the worker cannot write; a flat sandbox's parent
 * was `mkdtemp`'s 0700, owned by the test process and therefore writable — which
 * made the second arm fire for the harness's own reason and returned 78 no
 * matter what the loop actually named. `root/` plays the container's read-only
 * `/`. The ledger deliberately stays outside it: `/outbox` IS writable in
 * production, and a gate that cannot append its row cannot reach its exit.
 */
async function gateSandbox(): Promise<{
  dir: string;
  gate: string;
  replies: string;
  policy: string;
}> {
  const dir = await scratch("verbgate-replies-");
  const root = join(dir, "root");
  await mkdir(join(root, "policy"), { recursive: true });
  for (const [name, body] of [
    ["cloud-allow", ""],
    ["task", "T-collate\n3\n"],
    ["dispatch", '{"schema":"pifleet.dispatch/v1","staged":false}\n'],
    // The declared reply set, ISC-1092's addition to the same loop. Present so
    // this sandbox is the production shape: an ABSENT path reads `[ -w ]` false
    // and would let the loop pass for the wrong reason.
    ["replies", '{"schema":"pifleet.replies/v1","task_id":"T-collate","replies":[]}\n'],
  ] as const) {
    const p = join(root, "policy", name);
    await writeFile(p, body);
    await chmod(p, 0o444);
  }
  const replies = join(root, "replies");
  // Pre-created at 0700 so the 0755 asserted next is `createRepliesDir`'s chmod
  // and not the ambient umask — the same pin the reply-directory block uses, and
  // for the same measured reason. Under umask 022 a bare `mkdir` already gives
  // 0755, so without this the assertion is satisfied by a `createRepliesDir`
  // with no chmod in it at all.
  await mkdir(replies, { recursive: true });
  await chmod(replies, 0o700);
  await createRepliesDir(replies);
  // 0755 on the host is what `createRepliesDir` sets and what production keeps —
  // the actor writes into this directory. Asserted here so the emulation below
  // cannot quietly become the thing under test.
  expect(await mode(replies)).toBe(0o755);
  await writeReply(replies, "T-arch", { status: "success" });
  await writeReply(replies, "T-context", { status: "success" });
  await writeReply(replies, "T-lang", { status: "partial" });
  const gate = await sandboxGate(dir);
  await chmod(join(root, "policy"), 0o555);
  await chmod(replies, 0o555);
  // LAST, and it must be last: closing `root/` first would deny the writes above.
  await chmod(root, 0o555);
  return { dir, gate, replies, policy: join(root, "policy", "cloud-allow") };
}

/**
 * Run the sandboxed gate on a mutating verb.
 *
 * STDERR IS RETURNED, not read and dropped. The gate names the offending path in
 * its own refusal, and the exit code alone cannot say WHICH surface fired —
 * which is how a harness artefact previously passed for the property under test.
 */
async function runGate(gate: string): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn(["/bin/sh", gate, "delete", "deployment", "web"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, stderr };
}

/**
 * 77 is "this verb is not on the allow list" and 78 is "the policy surface is
 * writable, so nothing will be classified at all". The distinction is the whole
 * of this block: an assertion of "non-zero" would be satisfied by both, and 77
 * is what an intact gate returns for the verb these probes use.
 */
const REFUSED = 77;
const POLICY_WRITABLE = 78;

describe("the verbgate holds a reply to the same integrity bar as a policy file", () => {
  /**
   * THE CONTROL, and it comes first because without it the refusal below proves
   * nothing. A gate that exits 78 unconditionally — a broken sandbox, a rewrite
   * that missed, a loop that refuses on any path it cannot stat — satisfies the
   * next test perfectly. This one is what makes that refusal DISCRIMINATION.
   */
  test("passes the integrity loop when the reply plane is closed", async () => {
    const { gate } = await gateSandbox();
    const { code, stderr } = await runGate(gate);
    expect(stderr).not.toContain("refusing every verb");
    expect(code).toBe(REFUSED);
  });

  /**
   * THE HEADLINE PROBE (SRD §10), stated as what the gate can actually observe.
   *
   * WHAT WOULD BREAK IF THIS WERE REMOVED: the reply plane's `:ro` is one
   * character in one `-v`, and dropping it has no other symptom. Under the macOS
   * VM a read-write bind mount answers `access(W_OK)` TRUE on the mount point
   * whatever its mode and ownership say, so the host's careful 0755 buys nothing
   * inside the container and the mount flag is the whole control. This refusal is
   * what turns a silently-writable evidence plane into a worker that cannot run a
   * single gated verb — loud, at the first verb, instead of silent forever.
   *
   * THE PATH IS ASSERTED, NOT ONLY THE CODE, and the negative half is the
   * load-bearing one. 78 says "some gated surface is writable"; it does not say
   * which, and this file previously shipped a probe whose 78 came from the
   * sandbox root rather than from anything the loop named. Requiring the message
   * to name the replies directory AND not the policy file is what makes this
   * discrimination: delete `"${replies_dir}"` from the loop and the gate exits 77
   * with no message at all.
   */
  test("refuses every verb with 78 when the reply DIRECTORY is writable", async () => {
    const { dir, gate, replies, policy } = await gateSandbox();
    await chmod(replies, 0o755);

    const { code, stderr } = await runGate(gate);
    expect(code).toBe(POLICY_WRITABLE);
    expect(stderr).toContain(replies);
    // Not some other surface, and not the harness: the three policy files are
    // still 0444 under a 0555 parent, so naming one of them would mean the
    // sandbox leaked rather than that the loop worked.
    expect(stderr).not.toContain(policy);
    expect((await readFile(join(dir, "ledger.jsonl"), "utf8")).includes("policy_writable")).toBe(
      true,
    );
  });

  /**
   * THE SAME LOOP, ONE OF THE OTHER THREE SURFACES — the control that says the
   * message names whichever path actually fired rather than a fixed string.
   *
   * Without this, `toContain(replies)` above is satisfied by a gate that prints
   * the replies path unconditionally, which is exactly the class of bug the
   * whole "assert the path, not the code" repair exists to catch.
   */
  test("the refusal names the surface that is writable, whichever one it is", async () => {
    const { gate, replies, policy } = await gateSandbox();
    await chmod(policy, 0o644);

    const { code, stderr } = await runGate(gate);
    expect(code).toBe(POLICY_WRITABLE);
    expect(stderr).toContain(policy);
    expect(stderr).not.toContain(`${replies} `);
  });

  /**
   * THE MEASURED LIMIT, asserted rather than assumed — and it is a tripwire.
   *
   * SRD §10 asks for *"chmod one and assert exit 78"*, and an earlier version of
   * this loop iterated `"${replies_dir}"/*` to try to deliver exactly that. It
   * could not: measured inside the real worker image at uid 10001, with the only
   * modes this codebase writes (`createRepliesDir` 0755, `makeWorkerReadable`
   * 0444 or 0644), there is no mount configuration in which a reply FILE is
   * writable and its DIRECTORY is not. Under `:ro` both are EROFS; on a dropped
   * `:ro` under macOS the directory answers TRUE first; on Linux neither answers
   * TRUE, and that row is coherent because host ownership passes through there,
   * so the worker never gained write to catch. `docker/verbgate`'s loop carries
   * the full table.
   *
   * So this asserts 77 — the gate does NOT refuse — for a writable reply beneath
   * a closed directory. Asserting a limit is worth a test here because the glob
   * is the obvious thing to reach for a second time: re-add it and this row goes
   * red, and whoever re-added it has to produce the reachable configuration that
   * was missing the first time.
   */
  test("a writable reply FILE under a closed directory is NOT what the gate detects", async () => {
    const { gate, replies } = await gateSandbox();
    await chmod(replies, 0o755);
    await chmod(replyHostPath(replies, "T-context"), 0o644);
    // The directory closed again: only the FILE is writable now.
    await chmod(replies, 0o555);

    const { code, stderr } = await runGate(gate);
    expect(code).toBe(REFUSED);
    expect(stderr).not.toContain("refusing every verb");
  });

  test("stays inert for a fleet with no replies mount at all", async () => {
    // Every fleet that is not a review console. An absent `/replies` fails the
    // direct arm, and its `dirname` is the container's read-only root, which
    // fails the second — so a gate shipped ahead of the actor refuses nothing it
    // did not already refuse.
    const { dir, gate, replies } = await gateSandbox();
    await chmod(join(dir, "root"), 0o755);
    await chmod(replies, 0o755);
    for (const id of ["T-arch", "T-context", "T-lang"]) {
      await chmod(replyHostPath(replies, id), 0o644);
      await rm(replyHostPath(replies, id));
    }
    await rm(replies, { recursive: true });
    await chmod(join(dir, "root"), 0o555);

    const { code } = await runGate(gate);
    expect(code).toBe(REFUSED);
  });

  test("the reply plane is checked directly, with no glob and no parent arm", async () => {
    /*
     * The structural companion to the behavioural probes above, and it pins BOTH
     * halves of a reversal.
     *
     * `"${replies_dir}"/*` was shipped first, on the argument that a bare
     * directory check "passes with every reply inside it at 0644" — a state
     * measured to be unreachable from any mode this codebase writes. The glob's
     * cost was real: a `set +f` window in a script whose header explains why
     * globbing is off everywhere else, one `dirname` fork per reply file on the
     * refusal path of every gated verb in every fleet, and dotfiles unchecked.
     *
     * The SECOND half is why this asserts the absence of a parent arm rather
     * than membership of the loop. Moving `"${replies_dir}"` into the file loop
     * gives it `[ -w "$(dirname "/replies")" ]`, which is `[ -w / ]` — true for
     * root, and `docker/Dockerfile` runs these shims as root in its smoke-test
     * layer, before its `USER 10001:10001` line. That variant exits 78 on every
     * verb and fails the image build. It was not caught by reasoning; the build
     * failed. This assertion is what stops it being rediscovered that way twice.
     */
    const gate = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
    // Comments stripped before the NEGATIVE assertions. This file's own prose
    // names both rejected spellings in order to explain why they were rejected,
    // and a probe that searched the whole text would be red for the explanation
    // rather than for the code — which would teach the next reader to delete the
    // explanation.
    const code = gate
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    const loop = code.match(/^for policy_path in (.+); do$/m);
    expect(loop, "the integrity loop was not found — this probe has rotted").not.toBeNull();
    // The FILE surfaces, and the reply plane is not among them.
    expect(loop![1]).not.toContain("replies_dir");

    // Checked on its own, directly, with no glob suffix and no parent arm.
    expect(code).toMatch(/^if \[ -w "\$\{replies_dir\}" \]; then$/m);
    expect(code).not.toContain('"${replies_dir}"/');
    expect(code).not.toContain('dirname "${replies_dir}"');
  });

  test("globbing stays off for the whole script, with no window anywhere", async () => {
    // `set -f` guards verb classification against an argv token of `*`
    // re-expanding against the CWD — the shim's own header records the attack: a
    // file named `describe` dropped beside the worker turns a `delete` into a
    // read. With the glob gone there is no longer any reason to reopen that
    // window, so the assertion is the strong one: `set -f` once at the top and
    // `set +f` nowhere at all. That is strictly easier to check, and to keep
    // true, than "the restore is inside the loop body rather than after it".
    const gate = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
    expect(gate).toMatch(/^set -f$/m);
    expect(gate).not.toMatch(/^\s*set \+f\b/m);
  });
});

// ---------------------------------------------------------------------------
// The two ends of the mount
// ---------------------------------------------------------------------------

describe("the renderer and the gate name one mount", () => {
  test("the renderer mounts the reply plane read-only at the constant the gate names", async () => {
    // Both ends asserted against the same constant. A `-v` that dropped `:ro`
    // would leave every reply writable INSIDE the container regardless of its
    // 0444 on the host under the macOS ownership squash — and the gate would
    // then refuse every verb, which is a whole worker lost to three characters.
    const render = await readFile(join(REPO_ROOT, "src", "config", "render.ts"), "utf8");
    expect(render).toContain(
      "`${workerRepliesDir(opts.run.root, w.id)}:${REPLIES_MOUNT}:ro`",
    );
    const gate = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
    expect(gate).toContain(`replies_dir="${REPLIES_MOUNT}"`);
  });
});
