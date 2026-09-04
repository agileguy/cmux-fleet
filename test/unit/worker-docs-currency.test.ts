/**
 * ISC-364 — the documents MOUNTED INTO WORKERS agree with the code.
 *
 * ## Why these documents get their own probe
 *
 * The 2026-08-30 audit found that documentation currency tracks proximity to
 * executing code, and drew the wrong conclusion from it by half. `skills/` and
 * `roles/` were current because they are mounted and CI-built — but "mounted"
 * only guarantees a worker READS them, not that what it reads is true. Three
 * of the audit's findings were in exactly these files, and they are the worst
 * place to be wrong:
 *
 * - `SKILL.md` told workers a guessed outbox directory is "not reported" and
 *   that "nothing goes looking for it". ISC-346..348 had built exactly that
 *   reporting.
 * - It said "a half-written envelope is read as a missing one". It is
 *   *refused*, which records a discrepancy and caps the harvest at `partial` —
 *   the opposite of harmless.
 * - `roles/ticketing.md` said writing only `ticket-ops.md` "reports clean". It
 *   clamps to `failed`.
 *
 * An SRD that is wrong misleads a human who can push back. A `SKILL.md` that
 * is wrong is an instruction executed by an agent that cannot.
 *
 * ## What is checkable here, and what is not
 *
 * Most of a worker document is guidance — judgement, and not decidable. Two
 * things in it are neither, and both are load-bearing: the STATUS VALUES a
 * worker is told to write, and the CONTAINER PATHS it is told it has. A worker
 * that writes a status outside the schema has its envelope refused; a worker
 * told it has a mount it was not given wastes an epoch discovering otherwise.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { StatusSchema } from "../../src/contracts.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SKILL = readFileSync(`${ROOT}skills/pifleet-worker/SKILL.md`, "utf8");
const RENDER = readFileSync(`${ROOT}src/config/render.ts`, "utf8");

describe("the worker skill enumerates the same statuses the schema accepts", () => {
  /**
   * The claim is one sentence in the document and one `z.enum` in the code, so
   * the probe is a set comparison in both directions. Pinned to the SENTENCE
   * that instructs the worker, not to the whole file — the status words appear
   * throughout the prose explaining when each applies, and a probe satisfied by
   * that prose would stay green with the instruction itself deleted. That is
   * the decorative-probe failure ISC-351 and ISC-357 were each caught by.
   */
  function documentedStatuses(): string[] {
    const line = SKILL.split("\n").find((l) => l.includes("`status` is exactly one of"));
    expect(line, "the `status` instruction sentence is gone — the probe has rotted").toBeDefined();
    // Only the ENUMERATION, which ends at the first full stop. The sentence
    // continues "`aborted` and `timed_out` are not yours to report", and
    // sweeping the whole line would read those two as things the worker is
    // told to write — the exact inversion of what the text says.
    const enumeration = line!.slice(line!.indexOf("one of")).split(". ")[0]!;
    return [...enumeration.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
  }

  test("every status the schema accepts is one the worker is told to write", () => {
    const documented = new Set(documentedStatuses());
    const schema = StatusSchema.options;
    expect(schema.length).toBeGreaterThanOrEqual(4);
    const missing = schema.filter((s) => !documented.has(s));
    expect(
      missing,
      `the schema accepts these and SKILL.md does not list them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("every status the worker is told to write is one the schema accepts", () => {
    const schema = new Set<string>(StatusSchema.options);
    const documented = documentedStatuses();
    // CONTROL: an extractor matching nothing would make the filter below empty.
    expect(documented.length, "status extractor found nothing — the sentence shape changed").toBe(4);
    const bogus = documented.filter((s) => !schema.has(s));
    expect(
      bogus,
      `SKILL.md tells workers to write these and the schema refuses them: ${bogus.join(", ")}`,
    ).toEqual([]);
  });
});

describe("the worker documents only name container paths a worker actually has", () => {
  /**
   * Ordinary container directories, present in any image and not mounts. They
   * are allowlisted rather than matched loosely because the interesting failure
   * is a document naming a MOUNT the worker does not get — `/secrets` for a
   * role granted none, `/policy` which no worker is told about — and a loose
   * match would let those through.
   */
  const ORDINARY = new Set(["/tmp", "/run", "/etc", "/usr", "/var", "/home", "/dev", "/proc"]);

  function mountedPaths(): Set<string> {
    const found = new Set<string>();
    for (const m of RENDER.matchAll(/argv\.push\("-v",\s*`[^`]*?:(\/[A-Za-z0-9/._-]+)(?::ro)?`\)/g)) {
      found.add(m[1]!);
    }
    for (const m of RENDER.matchAll(/argv\.push\("-v",\s*`[^`]*?:\$\{([A-Z][A-Z0-9_]*)\}(?::ro)?`\)/g)) {
      const decl = readFileSync(`${ROOT}src/run/task-policy.ts`, "utf8")
        .concat(RENDER, readFileSync(`${ROOT}src/run/worker-env.ts`, "utf8"))
        .match(new RegExp(`${m[1]!}\\s*=\\s*"(/[^"]+)"`));
      if (decl !== null) found.add(decl[1]!);
    }
    /*
     * A destination computed by a FUNCTION, which the two forms above cannot
     * see because there is no literal and no bare constant to read.
     *
     * `-v ${src}:${cloneSourceMount(src)}:ro` mounts the operator's working
     * directory under a name derived from its basename, so the only fixed part
     * — and the only part a document can cite — is the root the function
     * builds on. Resolved from `mounts.ts` rather than allowlisted here, so
     * that removing either the mount or the constant reddens this instead of
     * leaving a stale permission behind.
     */
    if (RENDER.includes("cloneSourceMount(")) {
      const root = readFileSync(`${ROOT}src/container/mounts.ts`, "utf8").match(
        /WORKER_CLONE_SRC_ROOT\s*=\s*"(\/[^"]+)"/,
      );
      if (root !== null) found.add(root[1]!);
    }
    return found;
  }

  test("every top-level path named in a worker document is a mount or an ordinary dir", () => {
    const mounts = mountedPaths();
    expect(mounts.size, "mount extractor found nothing — the regex has rotted").toBeGreaterThanOrEqual(7);

    const docs = ["skills/pifleet-worker/SKILL.md", "skills/ticket-ops/SKILL.md"];
    const offenders: string[] = [];
    let examined = 0;
    /**
     * The TOP-LEVEL segment is the unit compared, and the character class
     * admits `<` and `>`.
     *
     * The first version of this probe matched only `[A-Za-z0-9/._-]` and was
     * DECORATIVE: every interesting path in these documents carries a
     * placeholder — `/outbox/<task-id>/result.json` is the one the whole
     * envelope contract turns on — and a `<` ended the match before the
     * closing backtick, so none of them was ever examined. Rewriting the
     * document's most important path to `/policy/<task-id>/result.json` left
     * the probe GREEN. Found by mutating, not by reading.
     *
     * Comparing top-level segments also removes the need to reason about
     * whether a cited subpath exists: `/outbox/<task-id>` is the worker's
     * business, `/outbox` being mounted at all is pifleet's.
     */
    for (const rel of docs) {
      const text = readFileSync(`${ROOT}${rel}`, "utf8");
      for (const m of text.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)) {
        const cited = m[1]!;
        examined += 1;
        const top = `/${cited.split("/")[1]!}`;
        if (ORDINARY.has(top)) continue;
        if ([...mounts].some((mp) => top === mp || mp.startsWith(`${top}/`))) continue;
        offenders.push(`${rel}: ${cited}`);
      }
    }
    // CONTROL: the failure this replaces was an extractor that examined almost
    // nothing while reporting no offenders.
    expect(examined, "path extractor examined almost nothing — the regex has rotted").toBeGreaterThanOrEqual(15);
    expect(
      offenders,
      `worker documents name paths that are neither a mount nor an ordinary container dir:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

/**
 * The `epoch` the worker is told to write is one it is told to READ (ISC-433's
 * finding, at a second field).
 *
 * ## The defect, and why it looked harmless for so long
 *
 * The field rules used to say the epoch was "not currently delivered to you"
 * and instruct the worker to write `1`, on the reasoning that the first
 * dispatch to a worker is epoch 1 and guessing right is the common case. Both
 * halves were false by the time they were read: `renderPrompt` emits an
 * `epoch:` line in the fenced `## This task` block on every route, and a worker
 * takes more than one task.
 *
 * `harvest/outbox.ts` REFUSES an envelope whose epoch differs from the inbox
 * record's. So a hard-coded `1` is not a small inaccuracy — it is a task that
 * did all of its work correctly and harvests as though the container produced
 * nothing, carrying a stale-epoch discrepancy instead of a result.
 *
 * **It survived because it was true by coincidence twice.** On the old pane
 * route both sides of the comparison were the placeholder 0, so the gate passed
 * without comparing anything. On the staged route a worker's FIRST task
 * allocates 1, and the hard-coded 1 matches. The failure only appears on a
 * second task, a re-stage after a cancel, or any replay — which is also why a
 * test that only ever allocates epoch 1 cannot see it, and why the probes
 * elsewhere in this block allocate something else on purpose.
 *
 * Pinned at BOTH ends, because either alone is satisfiable while the pair is
 * broken: the instruction must point at the delivered value, and the renderer
 * must still deliver it.
 */
describe("the worker is told to read the epoch, not to guess it", () => {
  test("the stale 'not delivered' instruction is gone", () => {
    expect(SKILL).not.toContain("the value is not currently delivered to you");
    // The specific bad advice, which is what actually reached the outbox.
    expect(SKILL).not.toContain("Until it is, write");
  });

  test("the instruction points at the block that carries it", () => {
    const rules = SKILL.slice(SKILL.indexOf("Field rules"));
    const bullet = rules.slice(rules.indexOf("- `epoch`"));
    expect(bullet).toContain("## This task");
    expect(bullet).toContain("/policy/dispatch");
    expect(bullet).toContain("never guess it");
  });

  /**
   * THE OTHER END. An instruction to read a value the renderer stopped emitting
   * is the same defect facing the other way, and the skill file alone cannot
   * detect it.
   */
  test("renderPrompt still emits the epoch line the instruction names", () => {
    const supervisor = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");
    expect(supervisor).toContain("`epoch:   ${envelope.epoch}\\n`");
  });
});

/**
 * The clone mounts are NAMED, not merely present.
 *
 * This block exists because of a measured failure of the opposite assumption.
 * `WORKER_SCRATCH_DIR`'s docblock claimed that putting the scratch at `~/repos`
 * — where an agent would already reach — meant the capability "needs no prompt
 * engineering to be discovered". The next run refuted it: with both mounts
 * live, `tst-1` was asked to run another repository's tests, never looked at
 * `/repos-src`, grepped its own `/workspace` for that repository's name, found
 * unrelated source mentioning it, and wrote `{"success":true}`.
 *
 * A mount nothing mentions does not exist as far as an agent is concerned. So
 * the mounts being in the argv is not the property worth testing — the worker
 * document naming them is.
 */
describe("the worker is told about the paths it can clone from and into", () => {
  test("the read-only source root is named", () => {
    expect(SKILL).toContain("/repos-src");
  });

  test("the writable scratch is named, by the constant's own value", () => {
    // Read from the source so a change to `WORKER_SCRATCH_DIR` that leaves the
    // document behind reddens here rather than shipping a doc that lies.
    const decl = readFileSync(`${ROOT}src/container/mounts.ts`, "utf8").match(
      /WORKER_SCRATCH_DIR\s*=\s*`\$\{WORKER_HOME\}(\/[^`]+)`/,
    );
    expect(decl, "WORKER_SCRATCH_DIR declaration not found — this probe has rotted").not.toBeNull();
    expect(SKILL).toContain(decl![1]!);
  });

  test("it is told NOT to clone from a URL", () => {
    // Egress is an allowlist and a forge is not on it; and a remote clone
    // would fetch the pushed state rather than the working copy under test.
    expect(SKILL).toMatch(/Do not `git clone` from a URL/);
  });

  /*
   * TWO GUARDS WERE REMOVED HERE, AND THE REASON MATTERS.
   *
   * They required the document to say `git clone /repos-src/...` and
   * "Searching your own `/workspace` ... is not doing the task". Both pinned
   * the FIRST repair attempted for a worker testing the wrong repository:
   * mount the real project read-only beside `/workspace` and instruct the
   * worker to go and find it.
   *
   * That repair did not work. Measured three times across two images and three
   * fresh sessions, the worker read the brief, listed `/workspace`, found
   * cmux-fleet and tested cmux-fleet — with the `/repos-src` section present
   * and readable in its own mounted skill each time. The launch directory is
   * now the run's repository (see the launch-repo block in
   * `test/integration/up-wiring.test.ts`), so `/workspace` IS the project and
   * the second guard asserted the exact opposite of the correct behaviour.
   *
   * Deleted rather than inverted-and-kept, because a guard that survives the
   * design it was written for is how a document keeps its stalest sentence.
   */
  test("a host path in a brief is explained as naming /workspace", () => {
    expect(SKILL).toMatch(/names \*\*your `\/workspace`\*\*/);
  });

  test("the wrong-project case is a `blocked` result, not a hunt for a better repo", () => {
    // The failure this replaces was a worker that kept looking until it found
    // SOMETHING testable. Stopping has to be the named action.
    expect(SKILL).toMatch(/stop and say so/);
    expect(SKILL).toMatch(/launched from the wrong directory/);
  });
});
