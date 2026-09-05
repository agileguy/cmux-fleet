/**
 * The refusal that did not fire, and the gate that replaces it.
 *
 * `roles/collator.md` has always said: if the target's remote is Broadcom GHE or
 * either AppNeta org, refuse the review and report `blocked`. On 2026-09-04
 * three full reviews of `github.com/dan-elliott-appneta/rally-cli` went to three
 * hosted vendors with that sentence in the collator's own briefing. The owner
 * had in fact authorised that specific repository — but nothing in the fleet
 * knew it, and nothing would have stopped the next one.
 *
 * It could not have fired. The document named a CONDITION and never named the
 * PROBE, to a worker with no `bash` and no `git`. (The remote is legible at
 * `/workspace/.git/config`, measured — so the rule was not even unenforceable,
 * merely unenforced.) These probes cover the mechanical replacement.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  SENSITIVE_REMOTE_PATTERNS,
  hostedRepoRefusal,
  originRemote,
  sensitiveRemote,
} from "../../src/security/sensitive-repo.ts";

const CARRIERS = [{ workerId: "rev-arch-1", provider: "ollama-cloud" }] as const;
const RALLY = "https://github.com/dan-elliott-appneta/rally-cli.git";

describe("which remotes are sensitive", () => {
  test("all three patterns match in the https spelling", () => {
    expect(sensitiveRemote("https://github.gwd.broadcom.net/dockcp/x.git")).toBe(
      "github.gwd.broadcom.net",
    );
    expect(sensitiveRemote("https://github.com/appneta/x.git")).toBe("github.com/appneta/");
    expect(sensitiveRemote(RALLY)).toBe("github.com/dan-elliott-appneta/");
  });

  /**
   * The SSH arm exists because a pattern list that only modelled `https://`
   * would pass every SSH checkout on the machine — which is most of them, and
   * the failure would be silent in the direction that matters.
   */
  test("the ssh spelling matches too", () => {
    expect(sensitiveRemote("git@github.com:appneta/secret-svc.git")).toBe("github.com/appneta/");
    expect(sensitiveRemote("git@github.gwd.broadcom.net:ESD/thing.git")).toBe(
      "github.gwd.broadcom.net",
    );
  });

  test("an unrelated remote is not sensitive", () => {
    expect(sensitiveRemote("https://github.com/agileguy/cmux-fleet.git")).toBeNull();
    // `appneta` as a substring of some other org must not match: the pattern
    // carries the trailing slash for exactly this reason.
    expect(sensitiveRemote("https://github.com/appnetascan/tool.git")).toBeNull();
  });

  /**
   * NAMED, NOT COVERED. A repository whose origin was removed classifies as not
   * sensitive, because there is nothing left to classify. This asserts the hole
   * rather than pretending it is closed — a probe that claimed otherwise would
   * be the same defect as the role file's unenforceable sentence.
   */
  test("no remote is not sensitive, and that is a stated hole", () => {
    expect(sensitiveRemote(null)).toBeNull();
    expect(sensitiveRemote("")).toBeNull();
  });
});

describe("the refusal, and what consent does and does not cover", () => {
  test("a sensitive repo with hosted carriers and no consent refuses", () => {
    const r = hostedRepoRefusal({ repoRoot: "/r", remote: RALLY, carriers: CARRIERS, consent: null });
    expect(r).not.toBeNull();
    expect(r).toContain("REFUSED");
    expect(r, "the refusal does not name the carrier").toContain("rev-arch-1");
    expect(r, "the refusal does not say how to consent").toContain("hosted_repo_consent");
  });

  test("the exact echoed remote allows it", () => {
    expect(
      hostedRepoRefusal({ repoRoot: "/r", remote: RALLY, carriers: CARRIERS, consent: RALLY }),
    ).toBeNull();
  });

  /**
   * THE ARM THE WHOLE DESIGN EXISTS FOR, and the one a boolean would fail.
   *
   * The launch directory overrides `run.repo`, so one `fleet.yaml` sends
   * whichever repository the operator `cd`-ed into. Consent to rally-cli must
   * not become consent to a different AppNeta repository — with a boolean it
   * silently would, and the operator would never see a second prompt.
   */
  test("consent to one repo does not cover a different sensitive repo", () => {
    const r = hostedRepoRefusal({
      repoRoot: "/r",
      remote: "git@github.com:appneta/secret-svc.git",
      carriers: CARRIERS,
      consent: RALLY,
    });
    expect(r).not.toBeNull();
    expect(r, "the operator is not shown which consent was on file").toContain(RALLY);
  });

  test("a non-sensitive repo is never refused, consent or not", () => {
    const ordinary = "https://github.com/agileguy/cmux-fleet.git";
    for (const consent of [null, RALLY]) {
      expect(
        hostedRepoRefusal({ repoRoot: "/r", remote: ordinary, carriers: CARRIERS, consent }),
      ).toBeNull();
    }
  });

  /**
   * No hosted carrier means nothing leaves the machine, so there is nothing to
   * refuse. A gate that fired on a wholly local fleet would be refusing a run
   * that cannot commit the harm — and would train the operator to set consent
   * on repositories that never needed it.
   */
  test("a sensitive repo with only local workers is allowed", () => {
    expect(
      hostedRepoRefusal({ repoRoot: "/r", remote: RALLY, carriers: [], consent: null }),
    ).toBeNull();
  });
});

describe("origin is read from git, not guessed", () => {
  test("a repo with no origin reads as null rather than throwing", async () => {
    const fail = async () => ({ code: 1, stdout: "", stderr: "no such remote" }) as never;
    expect(await originRemote("/r", fail)).toBeNull();
  });

  test("the url is trimmed", async () => {
    const ok = async () => ({ code: 0, stdout: `${RALLY}\n`, stderr: "" }) as never;
    expect(await originRemote("/r", ok)).toBe(RALLY);
  });
});

/**
 * THE DRIFT PROBE, and it is the one that would have mattered.
 *
 * The rule lived in prose only, so nothing noticed when the prose was the only
 * copy. Now that the matcher exists, the two can disagree instead — a pattern
 * added to the code and not the briefing, or a remote the collator still claims
 * to refuse that the gate no longer knows about. Both directions are checked.
 */
describe("the role document and the matcher name the same remotes", () => {
  const COLLATOR = readFileSync("roles/collator.md", "utf8");

  test("every pattern the gate enforces is named in the collator's briefing", () => {
    for (const p of SENSITIVE_REMOTE_PATTERNS) {
      expect(COLLATOR, `the briefing never names ${p}`).toContain(p);
    }
  });

  test("the briefing says the gate refuses before the worker is asked", () => {
    expect(COLLATOR).toContain("hosted_repo_consent");
  });

  /*
   * NEITHER BRIEFING MAY SEND A MODEL TO `.git/config` FOR THIS FACT, and the
   * probe is the mechanism of a measured failure rather than a style rule.
   *
   * The gate is host-side and consults `run.hosted_repo_consent`, which is not
   * mounted into any container. A worker told to read the remote and refuse on
   * a match is therefore computing a DIFFERENT function from the gate's, on
   * strictly less information, and it can differ in exactly one direction:
   * refusing a review the operator authorised.
   *
   * MEASURED BOTH WAYS on 2026-09-04, which is why this is pinned rather than
   * argued. With the instruction absent, three reviews of an AppNeta repository
   * reached three hosted vendors. With it present and told where to look, a
   * collator read the config, matched `dan-elliott-appneta`, reported `blocked`
   * and dispatched nobody — on the one repository this console exists to review,
   * with consent already recorded. Adding the instruction fixed neither case;
   * the host-side gate fixed both.
   *
   * The path string is the assertion because it is the mechanism. A briefing
   * may still NAME the patterns — the test above requires it — and may tell the
   * worker to mention a match in its report. What it may not do is hand a model
   * the file it would need to re-derive the refusal.
   */
  const REVIEWER = readFileSync("roles/reviewer.md", "utf8");

  test("no briefing tells a worker to re-derive the gate from the working tree", () => {
    for (const [name, doc] of [
      ["roles/collator.md", COLLATOR],
      ["roles/reviewer.md", REVIEWER],
    ] as const) {
      /*
       * THE PATH, ANYWHERE — not the imperative "read `…`".
       *
       * The first draft of this probe matched the instruction form, and the
       * document passed it while still printing the path one paragraph below,
       * inside the sentence describing the failure. A model reading its own
       * briefing has no way to tell a worked example from an instruction; this
       * repo has already been bitten by exactly that, when a failure narrative
       * naming container paths was read as one. So the assertion is the path
       * itself: the briefing must not tell a worker where the fact lives, in
       * any grammatical mood.
       */
      expect(doc, `${name} names the file a worker would re-derive the gate from`).not.toContain(
        "/workspace/.git/config",
      );
    }
  });

  test("both briefings still name every pattern, so a match is reportable", () => {
    for (const p of SENSITIVE_REMOTE_PATTERNS) {
      const trimmed = p.replace(/\/$/, "");
      expect(REVIEWER, `roles/reviewer.md never names ${p}`).toContain(trimmed);
    }
  });
});
