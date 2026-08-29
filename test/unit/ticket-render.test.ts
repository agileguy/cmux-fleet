/**
 * The rich-text block renderer (ISC-320, ISC-321).
 *
 * WHY THIS IS TESTED BY SPAWNING IT rather than by importing a function. The
 * renderer is a file in a MOUNTED skill bundle, not a module in `src/` — the
 * worker reaches it as `node /skills/ticket-ops/render-blocks.mjs` and pipes
 * JSON through it. Importing the logic would test something the worker never
 * runs. Spawning the actual file with actual stdin/stdout is the only shape
 * that covers the seam that exists.
 *
 * TWO RUNTIMES, DELIBERATELY. The container runs it under node (every worker
 * image is `FROM node:24-bookworm-slim`, `docker/Dockerfile:20`); the test host
 * always has bun, because bun is running this file. Both are exercised where
 * both are present, so a divergence between them is caught here rather than in
 * a ticket body. The bun arm is ungated so the criterion has evidence on any
 * host; the node arm is skipped only if node is genuinely absent.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { which } from "bun";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RENDERER = join(REPO_ROOT, "skills", "ticket-ops", "render-blocks.mjs");

const NODE = which("node");

/** Runtime name -> executable. bun is always present; node usually is. */
const RUNTIMES: Array<[string, string]> = [["bun", process.execPath]];
if (NODE) RUNTIMES.push(["node", NODE]);

async function render(exe: string, input: string) {
  const p = Bun.spawn([exe, RENDERER], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(input);
  await p.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

describe.each(RUNTIMES)("render-blocks under %s", (_name, exe) => {
  test("a paragraph of plain text renders as one <p>", async () => {
    const r = await render(exe, JSON.stringify([{ type: "p", spans: [{ text: "hello" }] }]));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("<p>hello</p>");
  });

  test("&, < and > in content are entity-escaped, and & is escaped first", async () => {
    // The ordering bug this pins: escaping `<` before `&` turns the `&lt;` it
    // just wrote into `&amp;lt;`, and the field renders the entity as text.
    const r = await render(
      exe,
      JSON.stringify([{ type: "p", spans: [{ text: "a < b && c > d" }] }]),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("<p>a &lt; b &amp;&amp; c &gt; d</p>");
    expect(r.stdout).not.toContain("&amp;lt;");
  });

  test("bold, italic and link nest with the emphasis inside the anchor", async () => {
    const r = await render(
      exe,
      JSON.stringify([
        {
          type: "p",
          spans: [{ text: "PR 12", bold: true, italic: true, href: "https://example.test/12" }],
        },
      ]),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<p><a href="https://example.test/12"><b><i>PR 12</i></b></a></p>');
  });

  test("a heading degrades to a bold paragraph, because the server strips <h*>", async () => {
    const r = await render(exe, JSON.stringify([{ type: "h", spans: [{ text: "Root cause" }] }]));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("<p><b>Root cause</b></p>");
    expect(r.stdout).not.toMatch(/<h[1-6]/);
  });

  test("bullets and numbered lists render as ul/ol with li children", async () => {
    const blocks = [
      { type: "ul", items: [[{ text: "one" }], [{ text: "two" }, { br: true }, { text: "cont" }]] },
      { type: "ol", items: [[{ text: "first" }]] },
    ];
    const r = await render(exe, JSON.stringify(blocks));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("<ul><li>one</li><li>two<br/>cont</li></ul><ol><li>first</li></ol>");
  });

  test("only the server's kept subset is ever emitted — no pre, code, div or style", async () => {
    // The whole output surface, exercised at once. `<pre>`/`<code>` are the
    // two a model reaches for when it wants to show a command, and they are
    // exactly the two the server strips.
    const blocks = [
      { type: "h", spans: [{ text: "H" }] },
      { type: "p", spans: [{ text: "p", bold: true }, { text: "i", italic: true }, { br: true }] },
      { type: "ul", items: [[{ text: "u", href: "https://x.test/" }]] },
      { type: "ol", items: [[{ text: "o" }]] },
    ];
    const r = await render(exe, JSON.stringify(blocks));
    expect(r.code).toBe(0);
    const tags = [...r.stdout.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
    expect([...new Set(tags)].sort()).toEqual(["a", "b", "br", "i", "li", "ol", "p", "ul"]);
  });

  test("a non-http href is refused, with nothing on stdout", async () => {
    const r = await render(
      exe,
      JSON.stringify([{ type: "p", spans: [{ text: "x", href: "javascript:alert(1)" }] }]),
    );
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("must be http(s)");
  });

  test("a double quote in an href is attribute-escaped, not left to close the attribute", async () => {
    const r = await render(
      exe,
      JSON.stringify([{ type: "p", spans: [{ text: "x", href: 'https://x.test/"onmouseover=1' }] }]),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("&quot;");
    expect(r.stdout).toBe('<p><a href="https://x.test/&quot;onmouseover=1">x</a></p>');
  });

  test("an unknown block type is refused outright, not partially rendered", async () => {
    // The point is the EMPTY stdout. A renderer that emitted the blocks it
    // understood would put a silently truncated body into a system of record,
    // and the read-back check would then compare two values that agree.
    const r = await render(
      exe,
      JSON.stringify([{ type: "p", spans: [{ text: "kept?" }] }, { type: "code", spans: [] }]),
    );
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('unknown block type "code"');
  });

  test("an unknown span key is refused rather than silently ignored", async () => {
    const r = await render(
      exe,
      JSON.stringify([{ type: "p", spans: [{ text: "x", bolded: true }] }]),
    );
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('unknown span key "bolded"');
  });

  test("empty input and non-JSON input are refused", async () => {
    expect((await render(exe, "[]")).code).toBe(2);
    expect((await render(exe, "not json")).code).toBe(2);
    expect((await render(exe, '{"type":"p"}')).code).toBe(2);
  });
});
