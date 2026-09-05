/**
 * ISC-530 (SRD §12, §6.8): no commit message, code comment, PR body, or
 * generated document this system produces may carry an AI or assistant
 * attribution line.
 *
 * `roles/engineer.md:28` and `roles/collator.md:419` already INSTRUCT this.
 * That is not a mechanism: a brief that says "don't" is exactly as effective
 * as a model that decides to anyway, and nothing short of grading the actual
 * output catches the difference. This file is the grading.
 *
 * Graded over REAL git history, not a string fixture — a fixture is a claim
 * about what a commit message looks like, and the property this criterion
 * protects is what git actually recorded. `git log --grep` is used rather
 * than reading `.git` by hand, for the same reason
 * `test/integration/git-config-forms.test.ts` asks `git config --get` rather
 * than parsing `.git/config` itself: grading against a second
 * implementation of git's own format is grading against an opinion, not the
 * artifact.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The four substrings §12's probe names, verbatim. Not a superset (a probe
 * that flags more than the criterion names is a probe nobody can appeal) and
 * not a subset (the vulnerability this criterion exists to close, only
 * quieter).
 */
const FORBIDDEN_PATTERNS = [
  "Co-Authored-By",
  "Claude",
  "AI-generated",
  "Generated with",
] as const;

/**
 * A hermetic git environment: the developer's own `~/.gitconfig` and hooks
 * held out exactly as `test/integration/git-config-forms.test.ts` holds them
 * out, so this test's verdict does not depend on whose machine runs it. The
 * identity here is a fixture author, not `run.git_identity` — ISC-528 and
 * ISC-529 (`test/unit/worker-env.test.ts`) already cover which identity a
 * worker commits under; this file is only about what the MESSAGE says.
 */
function hermeticGitEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "attribution-fixture",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "attribution-fixture@pifleet.invalid",
  };
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "attribution-fixture-"));
  await Bun.spawn(["git", "-C", dir, "init", "-q", "."], {
    stdout: "pipe",
    stderr: "pipe",
    env: hermeticGitEnv(),
  }).exited;
  return dir;
}

async function commit(dir: string, message: string): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", message], {
    stdout: "pipe",
    stderr: "pipe",
    env: hermeticGitEnv(),
  });
  const stderr = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) {
    throw new Error(`fixture commit failed: ${stderr}`);
  }
}

/**
 * The probe (ISC-530), integration-branch half: every commit reachable from
 * `ref`, scanned for the four forbidden substrings via git's OWN `--grep` —
 * so this grades against what git considers the message, not a
 * re-implementation of commit-message parsing. Returns the offending
 * `<hash> <subject>` lines, empty when clean.
 */
async function attributionHitsOnBranch(dir: string, ref: string): Promise<string> {
  const pattern = FORBIDDEN_PATTERNS.join("|");
  const p = Bun.spawn(
    ["git", "-C", dir, "log", ref, "--format=%H %s", "-E", `--grep=${pattern}`],
    { stdout: "pipe", stderr: "pipe", env: hermeticGitEnv() },
  );
  const out = (await new Response(p.stdout).text()).trim();
  const stderr = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) {
    throw new Error(`git log --grep failed: ${stderr}`);
  }
  return out;
}

/**
 * The probe (ISC-530), PR-body half: the same four substrings, applied to a
 * plain string. A PR body is never a commit, so `attributionHitsOnBranch`
 * above cannot cover it — §12 names both surfaces explicitly, and a probe
 * that only reads git history would leave the PR description unchecked.
 */
function attributionHitsInText(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter((p) => text.includes(p));
}

describe("ISC-530: no AI or assistant attribution on the integration branch or in a PR body", () => {
  test("a normal integration history is clean", async () => {
    const dir = await freshRepo();
    await commit(dir, "Container identity: deliver user.name/user.email via GIT_CONFIG_*");
    await commit(dir, "Merge worker branch eng-1 into integration");
    expect(await attributionHitsOnBranch(dir, "HEAD")).toBe("");
  });

  /**
   * Non-degenerate by construction: the fixture commits an ACTUAL forbidden
   * line into REAL history, so this test can only pass if the probe truly
   * reads git log and truly matches. A probe that always reported "clean"
   * would fail this test, not merely fail to fail it — which is the
   * property a hardcoded-string fixture could never establish.
   */
  test("a commit carrying an attribution line is caught, by hash", async () => {
    const dir = await freshRepo();
    await commit(dir, "Container identity: deliver user.name/user.email via GIT_CONFIG_*");
    await commit(
      dir,
      "Fix worker-env identity wiring\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    );
    const hits = await attributionHitsOnBranch(dir, "HEAD");
    expect(hits).not.toBe("");
    expect(hits.split("\n")).toHaveLength(1);
  });

  test("each forbidden substring is independently caught, one commit at a time", async () => {
    for (const phrase of FORBIDDEN_PATTERNS) {
      const dir = await freshRepo();
      await commit(dir, "unrelated baseline commit");
      await commit(dir, `Task complete. ${phrase} did the work.`);
      const hits = await attributionHitsOnBranch(dir, "HEAD");
      expect(hits, `"${phrase}" should have been caught`).not.toBe("");
    }
  });

  test("a clean commit history stays clean when a later commit is unrelated noise", async () => {
    const dir = await freshRepo();
    await commit(dir, "Container identity: deliver user.name/user.email via GIT_CONFIG_*");
    await commit(dir, "Add ISC-528/ISC-529 identity criteria to worker-env.test.ts");
    await commit(dir, "Merge worker branch eng-1 into integration");
    expect(await attributionHitsOnBranch(dir, "HEAD")).toBe("");
  });

  test("a PR body is checked too — the same four substrings, over a string, not commit history", () => {
    const clean =
      "## Summary\n- Delivers a configured git identity to worker containers.\n\n" +
      "## Test plan\n- bun test test/unit/worker-env.test.ts test/unit/attribution.test.ts";
    expect(attributionHitsInText(clean)).toEqual([]);

    const dirty = clean + "\n\n🤖 Generated with Claude Code";
    // Matched independent of the emoji or the product name around it — the
    // substring §12 names is "Generated with", not the whole footer.
    expect(attributionHitsInText(dirty)).toContain("Generated with");
  });

  // Anti (§12, this block's closing note): no criterion above requires a
  // real terminal, a real model, or the network — every fixture is a local
  // `git init` in a temp directory or a JS string. True by inspection of the
  // fixtures themselves; there is no runtime condition to assert without
  // inventing one that could not fail, which is the shape of test this
  // phase's own design constraints warn against.
});

/**
 * ISC-530, the half the fixtures above cannot supply: the probe pointed at
 * THIS repository's own integration branch.
 *
 * Everything above proves the MECHANISM — a grep that can catch an
 * attribution line, proven able to fail before it is trusted to pass. None of
 * it proves this branch is clean, and §12's criterion is about what this
 * system PRODUCES, not about whether a grep function works. A mechanism with
 * no live subject is documentation.
 *
 * ## Why this half cannot reuse `FORBIDDEN_PATTERNS`
 *
 * It was written to, and the first run failed — on a commit of our own:
 *
 *     c7f9b87  Phase 2 (2.2-2.4): deliver a configured git identity ...
 *
 * whose body describes the very check this file implements ("a PR-body string
 * for Co-Authored-By / Claude / AI-generated / Generated with"). The substring
 * probe §12 specifies cannot tell an attribution from a sentence ABOUT
 * attributions, so the commit that implements the criterion is the first thing
 * the criterion rejects. Loosening it to an allowlist of known-good hashes
 * would make the guard rot the first time history is rewritten.
 *
 * ## What replaced it, after a review round found the first attempt too narrow
 *
 * The first live guard was position-only: a line starting `Co-Authored-By:`,
 * `Claude-Session:`, or the emoji-prefixed `🤖 Generated with`. Two of the
 * three review lenses independently found the same hole, and the case they
 * built is decisive — `ATTRIBUTION_LINE.test("Generated with Claude Code")`
 * was FALSE. Requiring the robot emoji meant the plainest generated-by footer
 * there is walked straight through, and `AI-generated`, which §12 names, had
 * no alternative at all. The guard enforced a strict subset of the criterion
 * while claiming to enforce the criterion.
 *
 * The fix keeps both halves rather than choosing between them, because the
 * two failure modes live in different PLACES:
 *
 *   - **All four of §12's substrings, in the TRAILER BLOCK.** A real
 *     attribution is a footer: it is the last paragraph of the message, which
 *     is exactly where `Co-Authored-By`, `Claude`, `AI-generated` and
 *     `Generated with` mean what §12 says they mean. c7f9b87's mention sits
 *     in its BODY — its trailer block is a `bun test ...` result line — so
 *     the false positive that forced the narrowing does not recur, and no
 *     allowlist of hashes is needed to avoid it. This arm restores the bare
 *     `Claude` coverage the position-only guard dropped.
 *   - **Unambiguous forms line-anchored, ANYWHERE in the message.** An
 *     attribution that is not last — because a later paragraph was appended
 *     after it — is still an attribution. This arm carries only the forms
 *     that cannot occur by accident: the two trailer keys, and the
 *     emoji-prefixed footer.
 *
 * ### Why the line arm does NOT simply make the emoji optional
 *
 * That is the fix one lens proposed, and it was tried first. It reddens on
 * c7f9b87 — the same commit that motivated the whole exercise — because its
 * body wraps as:
 *
 *     and a PR-body string for Co-Authored-By / Claude / AI-generated /
 *     Generated with. Includes a fixture that commits an actual forbidden line
 *
 * and `^\s*Generated with` matches line 2 of a hard-wrapped sentence. A bare
 * generated-by phrase at the start of a line is a LINE BREAK, not a footer.
 * The phrase only means attribution in trailer position, and the trailer arm
 * is what covers it there — including the lens's own case,
 * `liveAttributionHits("Generated with Claude Code")`, which is a
 * single-paragraph message and therefore its own trailer block.
 *
 * Neither arm alone is sufficient, which is why both are asserted below and
 * why removing either reddens a test.
 */
const ATTRIBUTION_LINE = /^\s*(?:Co-Authored-By:|Claude-Session:|🤖\s*Generated with)/im;

/**
 * The last blank-line-separated paragraph of a commit message — where git's
 * own trailers live, and where an attribution footer lands. A single-paragraph
 * message is its own trailer block, which is the safe direction: it makes the
 * substring arm STRICTER on short messages, not laxer.
 */
function trailerBlockOf(body: string): string {
  const paras = body
    .trim()
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return paras.length === 0 ? "" : (paras[paras.length - 1] ?? "");
}

/** Both arms. Returns the reasons, empty when clean. */
function liveAttributionHits(body: string): string[] {
  const hits: string[] = [];
  const trailer = trailerBlockOf(body);
  for (const p of FORBIDDEN_PATTERNS) {
    if (trailer.includes(p)) hits.push(`trailer block contains "${p}"`);
  }
  if (ATTRIBUTION_LINE.test(body)) hits.push("a line begins with an attribution form");
  return hits;
}

/**
 * The commits this branch added — never the whole history. `main` is the
 * merge base every integration branch here is cut against, so `main..HEAD` is
 * exactly "what this system produced", which is the criterion's subject.
 */
async function integrationBranchMessages(): Promise<{ hash: string; body: string }[]> {
  const p = Bun.spawn(["git", "log", "main..HEAD", "--format=%H%x00%B%x01"], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`git log main..HEAD failed: ${stderr}`);
  return out
    .split("\x01")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => {
      const [hash, ...rest] = r.split("\x00");
      return { hash: hash ?? "", body: rest.join("\x00") };
    });
}

describe("ISC-530 (live): this branch's own commits carry no attribution", () => {
  test("no commit on main..HEAD carries an attribution", async () => {
    const offenders = (await integrationBranchMessages())
      .map((c) => ({ c, hits: liveAttributionHits(c.body) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.c.hash.slice(0, 8)} ${x.c.body.split("\n")[0]} — ${x.hits.join("; ")}`);
    expect(offenders).toEqual([]);
  });

  test("the trailer arm catches every substring §12 names, including a bare Claude", () => {
    for (const line of [
      "Co-Authored-By: Someone <x@example.com>",
      "Claude wrote the second half.",
      "This patch was AI-generated.",
      "Generated with [a tool](https://example.invalid)",
      "🤖 Generated with [a tool](https://example.invalid)",
    ]) {
      expect(liveAttributionHits(`A real subject\n\nA body paragraph.\n\n${line}`)).not.toEqual([]);
    }
  });

  /**
   * The review round's concrete case, kept as a test so the narrowing that
   * dropped it cannot come back quietly. Both were FALSE under the
   * position-only guard.
   */
  test("the two forms the first live guard let through are caught now", () => {
    // The review round's decisive case. The LINE arm still says false for
    // both — deliberately, see the docblock — and the composed guard, which
    // is what grades a commit, says caught.
    expect(ATTRIBUTION_LINE.test("Generated with Claude Code")).toBe(false);
    expect(liveAttributionHits("Generated with Claude Code")).not.toEqual([]);
    expect(liveAttributionHits("AI-generated, and proud of it")).not.toEqual([]);
  });

  test("a hard-wrapped sentence is not a footer, even when a line starts with the phrase", () => {
    const wrapped =
      "Subject\n\n" +
      "and a PR-body string for Co-Authored-By / Claude / AI-generated /\n" +
      "Generated with. Includes a fixture that commits an actual forbidden line.\n\n" +
      "bun test: 9 pass.";
    expect(liveAttributionHits(wrapped)).toEqual([]);
  });

  test("the line arm catches an attribution that is not the last paragraph", () => {
    const body =
      "A real subject\n\nA body.\n\nCo-Authored-By: Someone <x@example.com>\n\n" +
      "A later paragraph appended after the footer.";
    expect(trailerBlockOf(body)).not.toContain("Co-Authored-By");
    expect(liveAttributionHits(body)).toEqual(["a line begins with an attribution form"]);
  });

  test("a mention in prose is not an attribution", () => {
    // The exact shape that broke the substring probe: our own c7f9b87. The
    // mention is in the BODY and the trailer block is a test result, so
    // neither arm fires — while the whole-message substring probe still
    // flags it, which is the finding that forced this design.
    const body =
      "Phase 2: deliver a configured git identity\n\n" +
      "Grep-based probe over real git history and a PR-body string for\n" +
      "Co-Authored-By / Claude / AI-generated / Generated with. Includes a\n" +
      "fixture that commits an actual forbidden line.\n\n" +
      "bun test test/unit/attribution.test.ts: 9 pass, 0 fail.";
    expect(liveAttributionHits(body)).toEqual([]);
    expect(attributionHitsInText(body)).toContain("Co-Authored-By");
  });

  test("the range is non-empty, so a green result is not an empty set", async () => {
    expect((await integrationBranchMessages()).length).toBeGreaterThan(0);
  });
});
