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
 *
 * `[ \t]*`, not `\s*`: `\s` matches a newline, so `^\s*` under the `m` flag
 * could anchor on one line and consume blank lines to reach a match on
 * another — "leading whitespace" where the claim is "leading spaces on THIS
 * line". Raised by the review round's F3. The `i` flag stays: git's own
 * `interpret-trailers` matches trailer keys case-insensitively, so
 * `co-authored-by:` is a trailer git and GitHub would both honour.
 */
const ATTRIBUTION_LINE = /^[ \t]*(?:Co-Authored-By:|Claude-Session:|🤖[ \t]*Generated with)/im;

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
/**
 * The addresses a co-author trailer may name and still be dropped before the
 * base branch's tip is graded.
 *
 * **An allowlist of PEOPLE, not a denylist of vendors, and the direction is the
 * whole point.** The first version of this narrowing enumerated AI vendors
 * (`claude|anthropic|openai|copilot|gpt|[bot]`) and kept only the lines that
 * matched, which fails OPEN: every model this fleet actually runs —
 * `deepseek-v4-pro`, `qwen3.5:397b`, `glm-5.3`, `gemma-4-26b` — is absent from
 * that list, so a commit authored under `user.name = "Qwen"` and squash-merged
 * would have been dropped as a person and graded clean. Two reviewers found
 * that independently and both proposed this inversion.
 *
 * Listing humans instead fails CLOSED. A co-author this file does not recognise
 * survives into `liveAttributionHits` and reddens the base arm, so the failure
 * mode is a false positive on a new human contributor — visible, one line to
 * fix, and the direction every other assertion in this file already takes.
 *
 * It also retires two problems at once. There is no second definition of "what
 * counts as an AI" to drift out of step with `FORBIDDEN_PATTERNS`, and a HUMAN
 * named Claude is judged by their address rather than by their name, so the
 * guard cannot go permanently red over somebody's given name.
 *
 * These are the addresses git has actually recorded as this repository's author
 * in its own history — the local identity commits are made under, and the
 * account address GitHub attributes a squash to.
 */
const HUMAN_CO_AUTHORS: ReadonlySet<string> = new Set([
  "the.daddy.magoo@gmail.com",
  "agile.guy@hotmail.com",
]);

/**
 * `body` with recognised-human co-author trailers removed and everything else
 * intact — including a co-author line this file does not recognise, which is
 * exactly the line the caller needs to see.
 *
 * Lifted to module scope so the narrowing has fixture tests of its own: the arm
 * that uses it runs ONLY on the base branch, so on every branch where somebody
 * might edit it, it is code no assertion touches.
 */
export function withoutKnownHumanCoAuthors(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const m = /^[ \t]*co-authored-by:[^<]*<([^>]+)>/i.exec(line);
      return m === null || !HUMAN_CO_AUTHORS.has(m[1]!.trim().toLowerCase());
    })
    .join("\n");
}

function liveAttributionHits(body: string): string[] {
  const hits: string[] = [];
  const trailer = trailerBlockOf(body);
  for (const p of FORBIDDEN_PATTERNS) {
    if (trailer.includes(p)) hits.push(`trailer block contains "${p}"`);
  }
  if (ATTRIBUTION_LINE.test(body)) hits.push("a line begins with an attribution form");
  return hits;
}

const REPO_ROOT = import.meta.dir + "/../..";

/**
 * Where this branch was cut from, tried in order.
 *
 * `main` is the local branch a developer has; `origin/main` is what a CI
 * checkout has, and often the developer too. **Neither is guaranteed**, and
 * that is not hypothetical: `actions/checkout@v4` defaults to `fetch-depth: 1`,
 * so the job held ONE commit, no `main`, no `origin/main`, and this guard
 * failed every pull request with `fatal: ambiguous argument 'main..HEAD'`.
 * **A guard that reddens on every PR is a guard somebody deletes**, which is
 * the same way the two-dot hazard inspect nearly went. CI now asks for the
 * full history (`.github/workflows/ci.yml`), and this list is the belt to that
 * braces: a checkout configured differently degrades to a NAMED failure.
 */
const BASE_REF_CANDIDATES = ["origin/main", "main"] as const;

async function git(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

/**
 * The first candidate that resolves, or a throw naming every one it tried.
 *
 * **It deliberately does not fall back to `HEAD`.** That would make the guard
 * grade the repository's entire history — green today, and red the first time
 * anyone imports an old commit, for a reason with nothing to do with this
 * criterion. An unresolvable base is a broken checkout, and the honest report
 * is to say so.
 */
async function resolveBaseRef(): Promise<string> {
  for (const ref of BASE_REF_CANDIDATES) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
  }
  throw new Error(
    `none of ${BASE_REF_CANDIDATES.join(", ")} resolves in ${REPO_ROOT}, so "what this branch added" ` +
      "has no second end. A shallow checkout is the usual cause — CI needs fetch-depth: 0.",
  );
}

/**
 * The commits this branch added — never the whole history. `main` is the
 * merge base every integration branch here is cut against, so `<base>..HEAD`
 * is exactly "what this system produced", which is the criterion's subject.
 */
async function integrationBranchMessages(): Promise<{ hash: string; body: string }[]> {
  const base = await resolveBaseRef();
  const { code, out, err } = await git(["log", `${base}..HEAD`, "--format=%H%x00%B%x01"]);
  if (code !== 0) throw new Error(`git log ${base}..HEAD failed: ${err}`);
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
  test("no commit this branch added carries an attribution", async () => {
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

  /**
   * THE PREMISE, AND THE ONE CASE WHERE AN EMPTY RANGE IS THE TRUTH.
   *
   * The check above is vacuously green on an empty range — the empty set has no
   * offenders — so something has to assert that it actually scanned commits.
   * The first version asserted that unconditionally, and **it made `main`
   * permanently red**: on the base branch `main..HEAD` is empty BY DEFINITION,
   * so every push to `main` from 2026-09-06 onward failed this line while every
   * other job passed. That is worse than a missing check. A branch that is always
   * red teaches a reader to ignore its colour, and a real failure on `main` would
   * then look exactly like the noise.
   *
   * **The fix is not to loosen the assertion** — that would delete the premise
   * and restore the vacuous green this test exists to refuse. It is to say which
   * of the two empty ranges we are looking at, and they are distinguishable by
   * one comparison: standing ON the base, `HEAD` and the base ref are the same
   * commit. Empty with `HEAD` BEHIND the base is a stale checkout or a
   * misresolved base and still fails, loudly, which is the case worth keeping.
   *
   * **And on the base branch it now grades something rather than nothing**,
   * which NARROWS a hole this file had either way. A squash-merge writes a NEW
   * commit whose message is the PR title and body — text no branch run ever saw,
   * because it did not exist while the branch was being graded. If that message
   * carried an attribution, the branch was green, `main` scanned an empty range,
   * and nothing anywhere looked at the one commit that has it. So the base-branch
   * arm reads the tip's own message through the same live matcher.
   *
   * **Narrows, not closes, and the residue is named rather than left to be
   * found.** This reads `log -1`: ONE commit. GitHub fires one push event per
   * push, not per commit, so k commits pushed straight to `main` in one push are
   * graded at the tip and the other k−1 are graded by nothing anywhere. Closing
   * that needs a remembered last-seen tip, which a fresh CI checkout cannot
   * supply without new state this file does not own. The ordinary path — a
   * branch, a PR, a squash — has k = 1 and is covered.
   */
  /**
   * The narrowing's own fixture, because the arm that uses it runs ONLY on the
   * base branch — on every branch where somebody might edit it, it is dead code
   * that no assertion touches. The one failure it must never produce is dropping
   * a line that names an AI, so that direction is asserted first.
   */
  describe("withoutKnownHumanCoAuthors keeps everything it does not recognise", () => {
    const KNOWN = "Co-authored-by: agileguy <the.daddy.magoo@gmail.com>";

    test("a recognised human leaves nothing to grade", () => {
      const graded = withoutKnownHumanCoAuthors(`Squashed thing (#1)\n\n${KNOWN}`);
      expect(graded).not.toContain("agileguy");
      expect(liveAttributionHits(graded)).toEqual([]);
    });

    /**
     * THE CASE THE VENDOR LIST GOT WRONG, and the reason this is an allowlist.
     * Every one of these is a model this fleet runs today, and every one of them
     * passed the enumeration that preceded this — see `HUMAN_CO_AUTHORS`.
     */
    test("an unrecognised co-author survives and reddens, whoever it names", () => {
      for (const who of [
        "Claude Opus 5 <noreply@anthropic.com>",
        "Qwen <qwen@example.invalid>",
        "deepseek-v4-pro <ds@example.invalid>",
        "glm-5.3 <glm@example.invalid>",
        "gemma <g@example.invalid>",
        "Some New Model Nobody Listed <x@example.invalid>",
      ]) {
        const graded = withoutKnownHumanCoAuthors(`Squashed thing (#1)\n\n${KNOWN}\nCo-authored-by: ${who}`);
        expect(graded, `${who} was dropped as a person`).toContain(who.split(" <")[0]!);
        expect(
          liveAttributionHits(graded),
          `${who} survived the filter but produced no hit`,
        ).not.toEqual([]);
      }
    });

    test("every other attribution form is untouched by the filter", () => {
      for (const line of [
        "Claude-Session: https://example.invalid/x",
        "🤖 Generated with [a tool](https://example.invalid)",
        "This patch was AI-generated.",
      ]) {
        const graded = withoutKnownHumanCoAuthors(`Squashed thing (#1)\n\n${KNOWN}\n${line}`);
        expect(graded, `the filter removed ${JSON.stringify(line)}`).toContain(line);
      }
    });

    /** A malformed trailer has no address to recognise, so it fails closed. */
    test("a co-author line with no address is kept", () => {
      expect(withoutKnownHumanCoAuthors("x\n\nCo-authored-by: nobody")).toContain("nobody");
    });
  });

  test("the range is empty only when HEAD is the base, and the base's own tip is graded", async () => {
    const base = await resolveBaseRef();
    const baseSha = (await git(["rev-parse", `${base}^{commit}`])).out.trim();
    const headSha = (await git(["rev-parse", "HEAD^{commit}"])).out.trim();
    const n = (await integrationBranchMessages()).length;

    if (headSha !== "" && headSha === baseSha) {
      expect(n, `HEAD is ${base}, so ${base}..HEAD must be empty`).toBe(0);
      /*
       * THE EXIT CODE IS CHECKED, unlike the first version of this line. Every
       * other git call in this file checks it; this one discarded it, and a
       * failed `log` returns an empty string whose hit list is `[]` — so a tip
       * this checkout could not read graded as CLEAN. That was the one seam in a
       * premise check that fails closed everywhere else.
       */
      const tipRead = await git(["log", "-1", "--format=%B"]);
      if (tipRead.code !== 0) {
        throw new Error(
          `git log -1 failed on the base branch, so its tip could not be graded: ${tipRead.err.trim()}`,
        );
      }
      const tip = tipRead.out;
      /*
       * ONE NARROWING, AND ONLY ON THIS ARM: a co-author trailer that names no AI.
       *
       * `FORBIDDEN_PATTERNS` refuses EVERY `Co-Authored-By`, not only Claude's,
       * because "no co-author trailers at all" is a rule a branch author can
       * follow and cannot evade by renaming. That rule is ours to keep while we
       * are writing commits, and the arm above keeps it.
       *
       * **The base branch's tip is not written by us.** GitHub's squash-merge
       * composes it and appends `Co-authored-by:` for the squashed commits'
       * author, which is how this arm failed on its first run against `main`
       * (`8f8f134`: `Co-authored-by: agileguy <the.daddy.magoo@gmail.com>`).
       * Refusing that would make the base arm permanently red and recreate the
       * exact disease this test was just fixed for, one layer down.
       *
       * A first attempt compared the trailer against the merge commit's own
       * `%ae`/`%ce` and did not work, for a reason worth recording: GitHub sets
       * the squash's author to the PR author's ACCOUNT email
       * (`agile.guy@hotmail.com`), its committer to `noreply@github.com`, and
       * the co-author to the local git identity the branch committed under
       * (`the.daddy.magoo@gmail.com`). Three different addresses for one person,
       * none derivable from the others, and the squashed commits that carried
       * the third are gone from this history.
       *
       * So the narrowing is by SUBJECT rather than by identity, which is also
       * what the governing rule actually says: the prohibition is on attributing
       * the work to an AI. A co-author line naming a human is dropped; one
       * naming Claude, Anthropic, Copilot or a `[bot]` account is not, and every
       * other pattern — `Claude` anywhere in the trailer block, `Claude-Session:`,
       * the 🤖 footer, `AI-generated` — still fires untouched.
       */
      const graded = withoutKnownHumanCoAuthors(tip);
      expect(
        liveAttributionHits(graded),
        "the tip of the base branch carries an attribution — a squash-merge writes its own " +
          "message, so this is the one commit no branch run could have graded",
      ).toEqual([]);
      return;
    }
    expect(
      n,
      `${base}..HEAD is empty while HEAD (${headSha.slice(0, 8)}) is not ${base} ` +
        `(${baseSha.slice(0, 8)}) — the base resolved wrongly or this checkout is behind it, ` +
        "so a green result above would mean nothing was scanned",
    ).toBeGreaterThan(0);
  });
});
