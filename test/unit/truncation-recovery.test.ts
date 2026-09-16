/**
 * The truncation-recovery extension, and the measured failure it closes.
 *
 * ## What was broken
 *
 * `tick-1` ran one correct command, got 56,268 bytes back, and answered
 * nothing. Pi kept the last 50KB via `truncateTail` and wrote the whole output
 * to `/tmp/pi-bash-<id>.log`. 89% of the bytes reached the model and none of
 * the meaning did, because tail-truncating a JSON document drops the opening
 * delimiter first: what arrives cannot be parsed at any size. The worker
 * re-ran the identical command — the one action that reproduces the truncation
 * exactly — consulted `--help`, re-ran it a second time, and quiesced with no
 * result envelope. Harvest graded it `unknown`.
 *
 * ## What these tests pin, and why each is here
 *
 * The fix is small enough that the interesting risk is not "does it work" but
 * "does a later edit quietly spend one of its three properties". So the
 * assertions are written against the three separately:
 *
 * - **Position.** The banner is FIRST. Pi's own footer already carried the
 *   path and was ignored; being after 50KB is the whole reason. A refactor
 *   that appends instead of prepends would pass any content-based assertion
 *   and restore the bug, so position is asserted directly.
 * - **The structural warning.** Only fires when the COMPLETE output parses.
 *   That is the case where the visible bytes actively mislead.
 * - **The pass-through.** Untruncated results and non-bash tools come back
 *   `undefined`, byte-identical to what Pi produced.
 * - **The refusal of the other extension's tool.** `report-tools.ts` puts
 *   `submit_report` into the same tool path (SRD §11 Q9), and this file's
 *   handler sees every result in it. A delivery receipt must come back
 *   `undefined` — and must do so because of the tool NAME, not by coincidence.
 *
 * The fixtures are deliberately ASYMMETRIC: the truncated text and the
 * complete file never share content, so an implementation that banners the
 * wrong one, or that reads the file when it should read the event, fails
 * rather than coincidentally passing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type BashDetails,
  describeShape,
  formatSize,
  recoveryBanner,
  recoveryCommand,
  rewriteBashResult,
  type ToolResultEventLike,
  type Truncation,
} from "../../docker/pi-extensions/truncation-recovery.ts";
import { buildPiArgv, TRUNCATION_RECOVERY_PATH } from "../../src/config/render.ts";
import { BUILD_CONTEXT_ASSETS } from "../../src/container/image.ts";
import type { ResolvedWorker } from "../../src/config/load.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** The measured case: 56,268 bytes clipped to 50KB, tail kept. */
const MEASURED: Truncation = {
  truncated: true,
  truncatedBy: "bytes",
  totalLines: 1331,
  totalBytes: 56268,
  outputLines: 1204,
  outputBytes: 51200,
  maxBytes: 51200,
  maxLines: 2000,
  lastLinePartial: true,
};

const untruncated: Truncation = { ...MEASURED, truncated: false, truncatedBy: null };

/**
 * A bash result event. `text` is what the model can SEE; it is never the same
 * string as any complete-output fixture, so the two cannot be confused.
 */
const bashEvent = (details: BashDetails | undefined, text = "VISIBLE-TAIL"): ToolResultEventLike => ({
  type: "tool_result",
  toolName: "bash",
  content: [{ type: "text", text }],
  details,
});

/** A reader that serves one path and fails for every other, like the real one. */
const serving = (path: string, body: string) => (p: string) => (p === path ? body : null);
const unreadable = () => null;

const textOf = (r: { content: { type: "text"; text: string }[] } | undefined): string => {
  if (r === undefined) throw new Error("expected a replacement, got undefined");
  return r.content.map((c) => c.text).join("");
};

const worker = (over: Partial<ResolvedWorker> = {}): ResolvedWorker =>
  ({
    id: "tui-1",
    paneMode: "tui",
    autoTrigger: true,
    provider: "omlx",
    model: "m",
    skills: [],
    ...over,
  }) as ResolvedWorker;

describe("results this extension does not touch", () => {
  test("a non-bash tool is passed through", () => {
    const e: ToolResultEventLike = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: "x" }],
      details: { truncation: MEASURED },
    };
    expect(rewriteBashResult(e, unreadable)).toBeUndefined();
  });

  test("an untruncated bash result is passed through", () => {
    expect(rewriteBashResult(bashEvent({ truncation: untruncated }), unreadable)).toBeUndefined();
  });

  test("a bash result with no details at all is passed through", () => {
    expect(rewriteBashResult(bashEvent(undefined), unreadable)).toBeUndefined();
  });

  /**
   * `truncated: false` with a `fullOutputPath` set is a real shape — Pi writes
   * the temp file whether or not the cap was hit. Bannering on the path's
   * presence rather than on the flag would fire on every long-running command.
   */
  test("a path without a truncation does not trigger a banner", () => {
    const e = bashEvent({ truncation: untruncated, fullOutputPath: "/tmp/pi-bash-x.log" });
    expect(rewriteBashResult(e, serving("/tmp/pi-bash-x.log", "{}"))).toBeUndefined();
  });
});

/**
 * SRD §11 Q9 — the two extensions meeting in the tool path.
 *
 * `report-tools.ts` registers `submit_report`; this file registers a
 * `tool_result` middleware, and `docker/Dockerfile` loads both into every
 * worker. They meet on every delivery. A middleware that rewrote a delivery
 * receipt would be editing the one result the host counts, so the question is
 * which branch such a result takes.
 *
 * It takes the first one: `rewriteBashResult` opens with
 *
 *     if (event.toolName !== "bash") return undefined;
 *
 * and `undefined` is Pi's "no opinion" — the result reaches the model exactly
 * as `submit_report` returned it. No fix was needed; what follows pins that.
 *
 * **The shape below is a LITERAL, transcribed from SRD §6.2.1 (line 709):**
 *
 *     { content: [{ type: "text", text: "Report delivered: <n> bytes at <path>." }],
 *       details: { path, bytes, status }, terminate: true }
 *
 * not an import. `report-tools.ts` is being written in parallel with this
 * block, and importing it would make the answer to a question about THIS file
 * depend on that one compiling. `terminate` is absent from the fixtures because
 * it is not part of a `tool_result` event — it is on the tool's return value.
 * The three fields this handler can see are `toolName`, `content` and
 * `details`.
 *
 * **Two guards refuse a real `submit_report` result independently** — the tool
 * name, and then `details.truncation` — and a test that passes for two reasons
 * proves neither. So each is pinned with a fixture that isolates it.
 */
describe("a submit_report result is not rewritten — SRD §11 Q9", () => {
  const RECEIPT_PATH = "/outbox/T-q9/result.json";
  const LOG = "/tmp/pi-bash-q9.log";
  const JSON_FULL = JSON.stringify({ success: true, data: [{ id: 1 }], error: null });

  /** §6.2.1's `details: { path, bytes, status }`, filled with one delivery. */
  const SUBMIT_REPORT_DETAILS = { path: RECEIPT_PATH, bytes: 812, status: "success" };

  const submitReportResult = (): ToolResultEventLike => ({
    type: "tool_result",
    toolName: "submit_report",
    content: [{ type: "text", text: `Report delivered: 812 bytes at ${RECEIPT_PATH}.` }],
    details: SUBMIT_REPORT_DETAILS,
  });

  /** THE ANSWER TO Q9: the receipt the host counts comes back untouched. */
  test("the delivery receipt is passed through unchanged", () => {
    expect(rewriteBashResult(submitReportResult(), unreadable)).toBeUndefined();
  });

  /**
   * The tool-name guard, isolated — and the reason this test carries a fixture
   * `submit_report` would never produce.
   *
   * Handed §6.2.1's own details the handler refuses TWICE, so deleting the name
   * check leaves the test above green and proves nothing about the name. These
   * details are a real truncation over a readable, parseable complete output:
   * the event is one the handler would banner, with a shape line and a `jq`
   * suggestion, the instant the name stopped matching. The second assertion is
   * the positive control — the same details on a `bash` result DO banner, so
   * the pass-through above cannot be an artefact of an inert fixture.
   */
  test("it is the tool NAME that refuses it, not the absence of a truncation", () => {
    const rewritable = { truncation: MEASURED, fullOutputPath: LOG };
    const e: ToolResultEventLike = { ...submitReportResult(), details: rewritable };
    expect(rewriteBashResult(e, serving(LOG, JSON_FULL))).toBeUndefined();
    expect(
      textOf(rewriteBashResult({ ...e, toolName: "bash" }, serving(LOG, JSON_FULL))),
    ).toContain("valid JSON");
  });

  /**
   * The truncation guard, isolated: `submit_report`'s own details on a `bash`
   * event, so the name check is already satisfied and only `details.truncation`
   * is left to refuse it.
   *
   * This is the "details it does not recognise" case, and it is distinct from
   * the two beside it — `bashEvent(undefined)` has no details object at all,
   * and the `untruncated` fixture has a `truncation` this handler reads and
   * rejects. Here the object is present, populated, and carries no field this
   * file knows. Silence is the only correct answer: a banner assembled from
   * absent numbers would report a size and a clipped end that nothing measured.
   */
  test("a details object with no truncation field is not enough to banner", () => {
    const e: ToolResultEventLike = {
      type: "tool_result",
      toolName: "bash",
      content: [{ type: "text", text: `Report delivered: 812 bytes at ${RECEIPT_PATH}.` }],
      details: SUBMIT_REPORT_DETAILS,
    };
    expect(rewriteBashResult(e, unreadable)).toBeUndefined();
  });
});

describe("the banner is FIRST — the whole point of the fix", () => {
  /**
   * THE CRITERION. Pi already appended `Full output: <path>` at the END and the
   * worker ignored it; 50KB of preceding text is why. An implementation that
   * appends the same words would satisfy every content assertion in this file
   * and reproduce the measured failure exactly, so position is pinned on its
   * own.
   */
  test("the warning precedes the truncated bytes, not follows them", () => {
    const out = textOf(
      rewriteBashResult(
        bashEvent({ truncation: MEASURED, fullOutputPath: "/tmp/pi-bash-x.log" }),
        unreadable,
      ),
    );
    expect(out.indexOf("OUTPUT TRUNCATED")).toBeLessThan(out.indexOf("VISIBLE-TAIL"));
    expect(out.startsWith("⚠️")).toBe(true);
  });

  test("the truncated bytes are kept, not replaced", () => {
    const out = textOf(
      rewriteBashResult(bashEvent({ truncation: MEASURED }, "LINE-A\nLINE-B"), unreadable),
    );
    expect(out).toContain("LINE-A\nLINE-B");
  });

  /** A result with no text block still gets the banner rather than losing it. */
  test("a bash result with no text block gets the banner as its own block", () => {
    const e: ToolResultEventLike = {
      type: "tool_result",
      toolName: "bash",
      content: [],
      details: { truncation: MEASURED },
    };
    expect(textOf(rewriteBashResult(e, unreadable))).toContain("OUTPUT TRUNCATED");
  });

  /** Two text blocks must not get two banners. */
  test("only the first text block is prefixed", () => {
    const e: ToolResultEventLike = {
      type: "tool_result",
      toolName: "bash",
      content: [
        { type: "text", text: "FIRST" },
        { type: "text", text: "SECOND" },
      ],
      details: { truncation: MEASURED },
    };
    const out = textOf(rewriteBashResult(e, unreadable));
    expect(out.split("OUTPUT TRUNCATED")).toHaveLength(2);
    expect(out).toContain("SECOND");
  });
});

describe("what the banner says", () => {
  const banner = (d: BashDetails, read = unreadable): string => {
    const b = recoveryBanner(d, read);
    if (b === null) throw new Error("expected a banner");
    return b;
  };

  test("it names both sizes, using Pi's own rounding", () => {
    const b = banner({ truncation: MEASURED });
    expect(b).toContain("50.0KB");
    expect(b).toContain("54.9KB");
  });

  test("it names which end was cut", () => {
    expect(banner({ truncation: MEASURED })).toContain("clipped from the FRONT");
  });

  test("it names the complete-output path", () => {
    const b = banner({ truncation: MEASURED, fullOutputPath: "/tmp/pi-bash-abc.log" });
    expect(b).toContain("/tmp/pi-bash-abc.log");
  });

  /**
   * The measured loop, addressed by name. `tick-1` ran the same command twice.
   */
  test("it says re-running will not help", () => {
    expect(banner({ truncation: MEASURED })).toContain("Re-running the same command");
  });

  test("a line-limit truncation reports lines, not bytes", () => {
    const b = banner({ truncation: { ...MEASURED, truncatedBy: "lines" } });
    expect(b).toContain("2000 lines");
  });
});

describe("the structural warning fires only when the visible bytes mislead", () => {
  const P = "/tmp/pi-bash-x.log";
  const JSON_FULL = JSON.stringify({ success: true, data: [{ id: 1 }, { id: 2 }], error: null });

  test("complete output that parses gets the shape and the do-not-parse warning", () => {
    const b = recoveryBanner({ truncation: MEASURED, fullOutputPath: P }, serving(P, JSON_FULL));
    expect(b).toContain("valid JSON");
    expect(b).toContain('"success", "data", "error"');
    expect(b).toContain("DO NOT");
    // `.data` is the single array-valued key, so the filter names it — the
    // banner does not fall back to a generic `jq .` of a 56KB document.
    expect(b).toContain(`jq '.data[0]' ${P}`);
  });

  /**
   * A log truncated from the front is still a log. Claiming its bytes are
   * unparseable would be noise, and noise in a banner is how a banner starts
   * being skipped — which is the failure mode this file exists to fix.
   */
  test("non-JSON complete output gets no shape line and no parse warning", () => {
    const b = recoveryBanner(
      { truncation: MEASURED, fullOutputPath: P },
      serving(P, "2026-09-04 INFO started\n2026-09-04 INFO done\n"),
    );
    expect(b).not.toContain("valid JSON");
    expect(b).not.toContain("DO NOT");
    expect(b).toContain(`tail -n 200 ${P}`);
  });

  /**
   * Output that LOOKS like JSON but does not parse gets silence about shape.
   * Saying "not JSON" would be a claim about the command, which this file
   * cannot support — it only ever saw a fragment.
   */
  test("output that starts with a brace but does not parse says nothing about shape", () => {
    const b = recoveryBanner({ truncation: MEASURED, fullOutputPath: P }, serving(P, '{"a": '));
    expect(b).not.toContain("valid JSON");
  });

  test("an unreadable complete output still banners, without a shape line", () => {
    const b = recoveryBanner({ truncation: MEASURED, fullOutputPath: P }, unreadable);
    expect(b).toContain("OUTPUT TRUNCATED");
    expect(b).not.toContain("valid JSON");
  });

  /**
   * The asymmetric fixture. The visible bytes are a JSON FRAGMENT and the file
   * holds a DIFFERENT, complete document. An implementation that ran
   * `describeShape` over `event.content` instead of over the file would find no
   * shape and silently drop the one warning that matters.
   */
  test("the shape comes from the file, never from the visible fragment", () => {
    const e = bashEvent({ truncation: MEASURED, fullOutputPath: P }, '  "iteration": "S3",\n  "x": 1');
    const out = textOf(rewriteBashResult(e, serving(P, JSON_FULL)));
    expect(out).toContain("valid JSON");
    expect(out).toContain('"iteration": "S3"');
  });
});

describe("describeShape: the sentence", () => {
  const text = (s: string): string => {
    const d = describeShape(s);
    if (d === null) throw new Error("expected a shape");
    return d.text;
  };

  test("an array reports its length", () => {
    expect(text("[1,2,3]")).toContain("array of 3 elements");
  });

  test("a one-element array is not pluralised", () => {
    expect(text("[1]")).toContain("1 element");
    expect(text("[1]")).not.toContain("elements");
  });

  test("an object reports its keys", () => {
    expect(text('{"a":1,"b":2}')).toContain('"a", "b"');
  });

  test("a wide object truncates the key list and says how many are hidden", () => {
    const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    expect(text(JSON.stringify(wide))).toContain("+4 more");
  });

  test("empty, non-JSON and malformed input all describe nothing", () => {
    expect(describeShape("")).toBeNull();
    expect(describeShape("   ")).toBeNull();
    expect(describeShape("hello")).toBeNull();
    expect(describeShape("{oops")).toBeNull();
  });

  /**
   * An empty container still parses, and the count is the useful thing to say:
   * "the complete output is an empty array" tells a worker its query matched
   * nothing, which is a different problem from truncation and worth not
   * confusing with it.
   */
  test("an empty array reports zero rather than describing nothing", () => {
    expect(text("[]")).toContain("array of 0 elements");
  });
});

/**
 * The narrowing filter, which is chosen from the PARSED value rather than
 * guessed.
 *
 * MEASURED 2026-09-04 on the live probe, and the reason this block exists. The
 * first version emitted a fixed `jq '.data[].name'`, lifted from the rally-cli
 * case. Against an object with keys `ok`/`rows`/`done` the worker read that
 * example, improvised `jq -n 'keys'` — wrong, `-n` reads no input — got "not
 * valid JSON", and needed a second call to recover. A confident wrong example
 * costs more than no example.
 */
describe("describeShape: the filter it suggests", () => {
  const filter = (s: string): string => {
    const d = describeShape(s);
    if (d === null) throw new Error("expected a shape");
    return d.filter;
  };

  test("a top-level array offers its first element", () => {
    expect(filter("[{\"a\":1},{\"a\":2}]")).toBe(".[0]");
  });

  /**
   * The recurring shape: a wrapper object around the rows. `rally-cli` returns
   * `{success, data, error}`, `kubectl -o json` returns `{apiVersion, items,
   * kind}`, and the live probe returned `{ok, rows, done}`. Exactly one
   * array-valued key means the rows are unambiguous.
   */
  test("an object with exactly one array-valued key names that key", () => {
    const d = describeShape('{"success":true,"data":[1,2,3],"error":null}');
    expect(d?.filter).toBe(".data[0]");
    expect(d?.hint).toContain("3");
  });

  test("the live probe's own payload resolves to its rows", () => {
    expect(filter('{"ok":true,"rows":[{"i":0}],"done":null}')).toBe(".rows[0]");
  });

  /** Two array keys is ambiguous, so it commits to nothing. */
  test("an object with two array-valued keys falls back to keys", () => {
    expect(filter('{"a":[1],"b":[2]}')).toBe("keys");
  });

  test("an object with no array-valued key falls back to keys", () => {
    expect(filter('{"a":1,"b":"x"}')).toBe("keys");
  });
});

describe("formatSize matches Pi's own", () => {
  test("bytes, KB and MB thresholds", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(51200)).toBe("50.0KB");
    expect(formatSize(56268)).toBe("54.9KB");
    expect(formatSize(8 * 1024 * 1024)).toBe("8.0MB");
  });
});

describe("recoveryCommand", () => {
  const shape = { text: "t", filter: ".rows[0]", hint: "the first of 9 in \"rows\"" };

  test("no path means no command to offer", () => {
    expect(recoveryCommand(undefined, shape)).toBeNull();
  });

  test("a known shape becomes a jq line carrying its own filter", () => {
    const cmd = recoveryCommand("/tmp/a.log", shape);
    expect(cmd).toContain("jq '.rows[0]' /tmp/a.log");
    expect(cmd).toContain("the first of 9");
  });

  test("an unknown shape falls back to tail, never to a jq guess", () => {
    const cmd = recoveryCommand("/tmp/a.log", null);
    expect(cmd).toContain("tail");
    expect(cmd).not.toContain("jq");
  });
});

describe("the argv that loads it", () => {
  /**
   * UNCONDITIONAL, and that is the difference from the auto-trigger beside it.
   * A staged brief is a `tui` concept; a 50KB cap is not. An rpc worker
   * truncates identically and its operator is a program that will not read a
   * footer.
   */
  test("a tui worker loads it", () => {
    expect(buildPiArgv(worker(), false)).toContain(TRUNCATION_RECOVERY_PATH);
  });

  test("an rpc worker loads it too", () => {
    expect(buildPiArgv(worker({ paneMode: "rpc" }), false)).toContain(TRUNCATION_RECOVERY_PATH);
  });

  test("a worker with auto_trigger off still loads it", () => {
    expect(buildPiArgv(worker({ autoTrigger: false }), false)).toContain(TRUNCATION_RECOVERY_PATH);
  });

  /**
   * The discovery denial is not relaxed to make room for it. `--no-extensions`
   * disables DISCOVERY only; explicit paths still load. Dropping it to "make
   * the extension work" would execute repo-supplied `.pi/extensions/*.ts`
   * (SRD §12.2).
   */
  test("--no-extensions stays on the same argv", () => {
    const argv = buildPiArgv(worker({ autoTrigger: false }), false);
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain(TRUNCATION_RECOVERY_PATH);
  });

  /**
   * All four extensions coexist on an auto-triggered tui worker.
   *
   * The count was 2 until SRD-WORKER-DISPATCH-EXTENSION task 2.4 put
   * `report-tools.ts` on the same argv unconditionally, then 3 until the
   * 2026-09-15 stall measurement put `output-token-cap.ts` there the same way,
   * and it is still spelled as a count rather than relaxed to `toContain`s: the
   * claim this test makes is that nothing DISPLACED anything, and only a total
   * can say that. Moving the number is the correct maintenance when an
   * extension is added on purpose — the failure it exists to catch is the
   * number moving on its own.
   */
  test("it does not displace the auto-trigger extension", () => {
    const argv = buildPiArgv(worker(), false);
    expect(argv.filter((a) => a === "--extension")).toHaveLength(4);
    expect(argv).toContain("/opt/pifleet/dispatch-trigger.ts");
    expect(argv).toContain(TRUNCATION_RECOVERY_PATH);
    expect(argv).toContain("/opt/pifleet/report-tools.ts");
    expect(argv).toContain("/opt/pifleet/output-token-cap.ts");
  });
});

describe("the image cannot go stale without the tag moving", () => {
  /**
   * A stale copy of this extension fails SILENTLY — it finds no `truncation`
   * field it recognises, returns `undefined`, and every truncated result goes
   * back to looking exactly as it did on the day the measured failure happened.
   * `BUILD_CONTEXT_ASSETS` is what ties the image tag to these bytes.
   */
  test("the extension is a build-context asset", () => {
    expect(BUILD_CONTEXT_ASSETS).toContain("pi-extensions/truncation-recovery.ts");
  });

  test("the Dockerfile COPYs it to the path the argv names", () => {
    const dockerfile = readFileSync(`${ROOT}docker/Dockerfile`, "utf8");
    expect(dockerfile).toContain(
      `docker/pi-extensions/truncation-recovery.ts ${TRUNCATION_RECOVERY_PATH}`,
    );
    // 0444 and root-owned: Pi executes this in-process with the full extension
    // API, so a writable copy is a worker that can rewrite its own tool results.
    expect(dockerfile).toContain("--chmod=0444 docker/pi-extensions/truncation-recovery.ts");
  });
});
