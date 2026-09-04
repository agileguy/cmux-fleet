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

  /** Both extensions coexist on an auto-triggered tui worker. */
  test("it does not displace the auto-trigger extension", () => {
    const argv = buildPiArgv(worker(), false);
    expect(argv.filter((a) => a === "--extension")).toHaveLength(2);
    expect(argv).toContain("/opt/pifleet/dispatch-trigger.ts");
    expect(argv).toContain(TRUNCATION_RECOVERY_PATH);
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
