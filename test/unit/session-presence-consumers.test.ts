/**
 * ISC-281's second arm: no money path reads `session_present`.
 *
 * ## Why this arm and not the first
 *
 * The criterion offers two ways to close: make the flag never report `false`
 * for a worker whose transcript exists, OR ensure no consumer that must not
 * lose money treats `session_present === false` as evidence the worker never
 * spent.
 *
 * The first arm cannot be made airtight, and saying so is more useful than
 * pretending otherwise. `session_present` is latched by SAMPLING — the
 * supervisor stats the recorded path and flips the flag when the file is
 * there. ISC-281 tightened that materially: the check moved out of the 250 ms
 * heartbeat and into `flushState`'s write chain, so every state.json a reader
 * can observe after any activity carries a flag computed at that write. But a
 * reader polling in the gap between two writes can still see a value that
 * went stale after the last one, and no amount of polling closes that. A
 * criterion graded on "the window is smaller now" would be graded on a
 * measurement that any change to timing can quietly invalidate.
 *
 * The second arm is a fact about the SOURCE, and it holds regardless of
 * timing. This file pins it.
 *
 * ## What "money path" means here, precisely
 *
 * `dispatch.ts` is the file that decides how much a run has already spent and
 * whether it may spend more. Its own comment records why it stopped trusting
 * the flag — the measurement that a worker holding a 400-token transcript
 * reads `session_present: false` at the instant `dispatch --auto` exits — and
 * resolves the ambiguity where the information actually exists. That decision
 * is currently correct and NOTHING KEEPS IT SO. A future edit that reaches for
 * the flag as "the ISC-96 discriminator", exactly as its own documentation
 * invites, would re-introduce the defect with no test in its way. This is that
 * test.
 *
 * ## Why it reads comment-stripped source
 *
 * `dispatch.ts` names `session_present` eight times in prose, explaining at
 * length why it does not use it. A plain grep for the identifier therefore
 * fails on the CORRECT file. Everything below runs on text with comments
 * removed — the same trick, and for the same reason, as
 * `control-auth-comparator.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { functionBody, stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * The modules that decide spend. Named individually rather than globbed: a
 * glob would silently start covering a new file (good) or silently stop
 * covering a renamed one (not good), and this list is short enough to be
 * maintained deliberately.
 */
const MONEY_MODULES = [
  "src/cli/commands/dispatch.ts",
  "src/safety/budget.ts",
  "src/orchestrate/scheduler.ts",
  "src/cli/commands/wait.ts",
] as const;

/** The flag, and the classifier whose `never_created` answer rests on it. */
const FORBIDDEN = ["session_present", "classifySession"] as const;

function offendingReads(source: string): string[] {
  const stripped = stripComments(source);
  return FORBIDDEN.filter((name) => stripped.includes(name));
}

describe("ISC-281: no consumer that must not lose money reads session_present", () => {
  for (const rel of MONEY_MODULES) {
    test(`${rel} decides spend without consulting the flag`, () => {
      const source = readFileSync(`${ROOT}${rel}`, "utf8");
      expect(
        offendingReads(source),
        `${rel} reads a session-presence signal that LAGS the transcript it describes. ` +
          `A worker mid-lag reads session_present:false with 400 tokens already spent, so a ` +
          `spend decision resting on it calls a real degradation innocent. Resolve the ambiguity ` +
          `where the information exists — is there published spend to lose? — as this file's own ` +
          `openingBalance/taskTokens comment describes.`,
      ).toEqual([]);
    });
  }

  /**
   * The guard above is a claim about ABSENCE, which is exactly the shape that
   * passes when the thing it guards has been deleted. These two assertions are
   * what stop it going vacuous: the spend decisions must still be in the file
   * the guard reads.
   */
  test("the spend decisions this guards are still here to guard", () => {
    const stripped = stripComments(readFileSync(`${ROOT}src/cli/commands/dispatch.ts`, "utf8"));
    expect(functionBody(stripped, "openingBalance"), "openingBalance moved or was renamed").not.toBeNull();
    // `taskTokens` is an object METHOD, not a declaration, so `functionBody`
    // does not see it — asserted by name instead, which is what a rename
    // would break.
    expect(stripped).toContain("taskTokens");
  });

  /**
   * And the analysis can CONDEMN. An assertion that has only ever been run
   * against passing input is not evidence that it can fail — including the
   * comment-stripping, which is the half most likely to regress silently.
   */
  test("a module that DOES read the flag is condemned, prose or not", () => {
    const guilty = `
      export async function chargeRun(state: WorkerState): Promise<number> {
        if (!state.session_present) return 0;
        return await readSpend(state.session_path);
      }
    `;
    expect(offendingReads(guilty)).toEqual(["session_present"]);

    const guiltyViaClassifier = `
      export async function chargeRun(state: WorkerState): Promise<number> {
        const presence = await classifySession(state);
        return presence === "never_created" ? 0 : await readSpend(state.session_path);
      }
    `;
    expect(offendingReads(guiltyViaClassifier)).toEqual(["classifySession"]);

    // The correct file's shape: the identifier appears ONLY in prose. If
    // `stripComments` ever regressed, this is the assertion that catches it,
    // because the guard above would then condemn every clean module.
    const innocentButDocumented = `
      /** session_present looks like the answer AND IT LAGS; classifySession too. */
      export function chargeRun(): number {
        return 0; // session_present is not consulted
      }
    `;
    expect(offendingReads(innocentButDocumented)).toEqual([]);
  });
});
