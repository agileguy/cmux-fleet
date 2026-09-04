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
 * - **The verbgate refuses to run when a reply file is writable.** *"Probe:
 *   chmod one and assert exit 78 — the existing loop, one path wider."*
 *
 * ## Why the gate is EXECUTED here rather than grepped
 *
 * `dispatch-policy.test.ts` pins the loop's SHAPE — every declared surface is a
 * looped path — and that probe cannot see the failure this one exists for.
 * `/replies` is a DIRECTORY where the other three surfaces are files, so a loop
 * that named `"${replies_dir}"` as a fourth literal would satisfy every
 * structural assertion in the repository while passing cleanly with every reply
 * inside it at 0644. Only running the gate against a writable reply tells the
 * two apart, so that is what the block at the bottom does.
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

  test("propagates a chmod failure that is NOT the file simply being absent", async () => {
    // A directory where the reply goes: chmod succeeds, writeFile fails EISDIR.
    // What is asserted is that the writer does not swallow it — a reply that
    // could not be written must be loud, because the collator's brief is about
    // to name a path with nothing behind it.
    const dir = await scratch();
    await createRepliesDir(dir);
    await chmod(dir, 0o755);
    await mkdir(replyHostPath(dir, "T-arch"));
    await expect(writeReply(dir, "T-arch", { x: 1 })).rejects.toThrow();
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
  test("is traversable, owner-writable, and closed to everyone else", async () => {
    const dir = join(await scratch(), "replies");
    await createRepliesDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await mode(dir)).toBe(0o755);
    // Group and other: read and traverse, never write. The owner bit is
    // deliberately NOT asserted away — the actor has to be able to deliver.
    expect((await mode(dir)) & 0o022).toBe(0);
    expect((await mode(dir)) & 0o055).toBe(0o055);
  });

  test("is idempotent, so a re-materialized worker does not fail on an existing directory", async () => {
    const dir = join(await scratch(), "replies");
    await createRepliesDir(dir);
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
 * The real `docker/verbgate`, with its four hard-coded surfaces re-rooted into a
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
  const swaps: [string, string][] = [
    ['"/policy/cloud-allow"', `"${join(sandbox, "policy", "cloud-allow")}"`],
    ['"/policy/task"', `"${join(sandbox, "policy", "task")}"`],
    ['"/policy/dispatch"', `"${join(sandbox, "policy", "dispatch")}"`],
    [`"${REPLIES_MOUNT}"`, `"${join(sandbox, "replies")}"`],
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
  // And nothing absolute survived. A fifth surface added to the gate without
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
 * bind-mount ownership to the container user, so a 0644 reply reads as
 * owner-writable INSIDE the container and only `:ro` stands between that and a
 * fleet-wide refusal. The probes below flip exactly that bit.
 */
async function gateSandbox(): Promise<{ dir: string; gate: string; replies: string }> {
  const dir = await scratch("verbgate-replies-");
  await mkdir(join(dir, "policy"), { recursive: true });
  for (const [name, body] of [
    ["cloud-allow", ""],
    ["task", "T-collate\n3\n"],
    ["dispatch", '{"schema":"pifleet.dispatch/v1","staged":false}\n'],
  ] as const) {
    const p = join(dir, "policy", name);
    await writeFile(p, body);
    await chmod(p, 0o444);
  }
  const replies = join(dir, "replies");
  await createRepliesDir(replies);
  // 0755 on the host is what `createRepliesDir` sets and what production keeps —
  // the actor writes into this directory. Asserted here so the emulation below
  // cannot quietly become the thing under test.
  expect(await mode(replies)).toBe(0o755);
  await writeReply(replies, "T-arch", { status: "success" });
  await writeReply(replies, "T-context", { status: "success" });
  await writeReply(replies, "T-lang", { status: "partial" });
  const gate = await sandboxGate(dir);
  await chmod(join(dir, "policy"), 0o555);
  await chmod(replies, 0o555);
  return { dir, gate, replies };
}

/** Run the sandboxed gate on a mutating verb and return its exit code. */
async function runGate(gate: string): Promise<number> {
  const p = Bun.spawn(["/bin/sh", gate, "delete", "deployment", "web"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return code;
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
  test("passes the integrity loop when every reply is 0444", async () => {
    const { gate } = await gateSandbox();
    expect(await runGate(gate)).toBe(REFUSED);
  });

  /**
   * THE HEADLINE PROBE (SRD §10): *"chmod one and assert exit 78"*.
   *
   * WHAT WOULD BREAK IF THIS WERE REMOVED: the reply plane's `:ro` is one
   * character in one `-v`, and dropping it has no other symptom — the macOS
   * Docker VM squashes bind-mount ownership to the container user, so the host's
   * 0444 reads as owner-owned INSIDE the container and the mode says nothing.
   * The gate's refusal is what turns a silently-writable evidence file into a
   * worker that cannot run a single gated verb.
   *
   * ONE file, not the directory: `dispatch-policy.test.ts` already pins that the
   * replies surface is a member of the loop, and a loop naming the DIRECTORY
   * alone would satisfy that probe while passing here at 0644. This is the
   * assertion that separates the two.
   */
  test("refuses every verb with 78 when ONE reply file is writable", async () => {
    const { gate, replies } = await gateSandbox();
    await chmod(replyHostPath(replies, "T-context"), 0o644);
    expect(await runGate(gate)).toBe(POLICY_WRITABLE);
  });

  test("refuses when the replies DIRECTORY is writable, even with no replies in it", async () => {
    // The other arm of the same `||`: an empty directory expands the glob to a
    // literal whose dirname is the directory, so the check does not disappear
    // when there is nothing to check. A worker that could create a reply is a
    // worker that could author one.
    const { dir, gate, replies } = await gateSandbox();
    await chmod(replies, 0o755);
    for (const id of ["T-arch", "T-context", "T-lang"]) {
      await chmod(replyHostPath(replies, id), 0o644);
      await rm(replyHostPath(replies, id));
    }
    await chmod(replies, 0o777);
    expect(await runGate(gate)).toBe(POLICY_WRITABLE);
    expect((await readFile(join(dir, "ledger.jsonl"), "utf8")).includes("policy_writable")).toBe(
      true,
    );
  });

  test("stays inert for a fleet with no replies mount at all", async () => {
    // Every fleet that is not a review console. An absent `/replies` fails both
    // arms of the test and the loop passes — so a gate shipped ahead of the
    // actor refuses nothing it did not already refuse.
    const { gate, replies } = await gateSandbox();
    await chmod(replies, 0o755);
    for (const id of ["T-arch", "T-context", "T-lang"]) {
      await chmod(replyHostPath(replies, id), 0o644);
      await rm(replyHostPath(replies, id));
    }
    await rm(replies, { recursive: true });
    expect(await runGate(gate)).toBe(REFUSED);
  });

  test("the loop reaches the replies directory through a glob, not as a bare path", async () => {
    // The structural companion to the behavioural probes above, and the reason
    // it is worth a line: `"${replies_dir}"` as a fourth literal satisfies
    // `dispatch-policy.test.ts`'s set-equality exactly, so that probe cannot see
    // the difference between checking the directory and checking what is in it.
    const gate = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
    const loop = gate.match(/^for policy_path in (.+); do$/m);
    expect(loop, "the integrity loop was not found — this probe has rotted").not.toBeNull();
    expect(loop![1]).toContain('"${replies_dir}"/*');
  });

  test("globbing is turned back off inside the loop, not after it", async () => {
    // `set -f` guards verb classification against an argv token of `*`
    // re-expanding against the CWD (the shim's own header records the attack: a
    // file named `describe` dropped beside the worker turns a `delete` into a
    // read). The glob above needs it off for exactly one word expansion, so the
    // restore belongs INSIDE the body — after `done` would leave it off for the
    // whole refusal path, including `log_ledger`'s handling of raw argv.
    const gate = await readFile(join(REPO_ROOT, "docker", "verbgate"), "utf8");
    expect(gate).toMatch(/set \+f\nfor policy_path in .+; do\n {2}set -f\n/);
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
