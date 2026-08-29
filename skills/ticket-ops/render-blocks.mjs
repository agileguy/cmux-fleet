#!/usr/bin/env node
/**
 * Block list -> the ticket system's accepted HTML subset. Deterministic, total,
 * and fail-closed.
 *
 * WHY THIS EXISTS AT ALL. The rich-text fields on these objects are HTML. A
 * model asked to "write HTML" writes `<h2>`, `<code>`, `<table>` and a stray
 * unescaped `&`, and the server's sanitizer silently drops most of it — so the
 * write returns 200, the read-back returns something shorter, and the operator
 * finds out later. A model asked to "write markdown" produces a field rendering
 * as one collapsed paragraph with literal `#`, `*` and `-` still in it. Neither
 * failure is caught by asking more nicely. The fix is structural: the model
 * emits DATA describing intent, and this file is the only thing in the system
 * that emits a tag.
 *
 * Read on stdin, write on stdout:
 *
 *   echo '[{"type":"p","spans":[{"text":"hello"}]}]' | node render-blocks.mjs
 *   <p>hello</p>
 *
 * Exit 0 with HTML, or exit 2 with a diagnostic on stderr and NOTHING on
 * stdout. There is no partial render and no "best effort" — a block this file
 * does not understand is a bug in the caller, and emitting the parts it did
 * understand would put a silently truncated body into a system of record.
 */

/** The tags the server keeps. Everything else it strips, `<pre>`/`<code>` included. */
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * `&` first, or every entity this function just wrote gets re-escaped into
 * `&amp;lt;`. The order is the whole correctness argument.
 */
function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ESCAPES[c]);
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

function fail(msg) {
  process.stderr.write(`render-blocks: ${msg}\n`);
  process.exit(2);
}

/**
 * Only http and https reach an `href`.
 *
 * `javascript:` and `data:` are the reason. A ticket body is rendered in
 * someone else's browser, inside an authenticated session, and the model
 * composing this block list is working from ticket text it did not author —
 * which is untrusted input by the same rule the rest of the fleet applies to
 * repository content. A scheme allowlist is the control; refusing is correct
 * even when the link was innocent, because the caller can always say what it
 * meant in plain text instead.
 */
function checkHref(href) {
  if (typeof href !== "string" || href === "") fail("span.href must be a non-empty string");
  if (!/^https?:\/\//i.test(href)) fail(`span.href must be http(s), got ${JSON.stringify(href)}`);
  return href;
}

const SPAN_KEYS = new Set(["text", "bold", "italic", "href", "br"]);

function renderSpan(span, where) {
  if (span === null || typeof span !== "object" || Array.isArray(span)) {
    fail(`${where}: each span must be an object`);
  }
  for (const k of Object.keys(span)) {
    // An unknown key is a typo — `{"bolded":true}` would otherwise render
    // unbolded text and look like it worked.
    if (!SPAN_KEYS.has(k)) fail(`${where}: unknown span key ${JSON.stringify(k)}`);
  }
  if (span.br === true) {
    if ("text" in span) fail(`${where}: a br span carries no text`);
    return "<br/>";
  }
  if (typeof span.text !== "string") fail(`${where}: span.text must be a string`);

  let html = escapeText(span.text);
  // Innermost first: emphasis inside the anchor, so the link text carries it.
  if (span.italic === true) html = `<i>${html}</i>`;
  if (span.bold === true) html = `<b>${html}</b>`;
  if ("href" in span) html = `<a href="${escapeAttr(checkHref(span.href))}">${html}</a>`;
  return html;
}

function renderSpans(spans, where) {
  if (!Array.isArray(spans)) fail(`${where}: spans must be an array`);
  return spans.map((s, i) => renderSpan(s, `${where}[${i}]`)).join("");
}

function renderItems(items, tag, where) {
  if (!Array.isArray(items) || items.length === 0) {
    fail(`${where}: ${tag} needs a non-empty items array`);
  }
  const lis = items.map((spans, i) => `<li>${renderSpans(spans, `${where}.items[${i}]`)}</li>`);
  return `<${tag}>${lis.join("")}</${tag}>`;
}

function renderBlock(block, i) {
  const where = `block[${i}]`;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    fail(`${where}: each block must be an object`);
  }
  switch (block.type) {
    case "p":
      return `<p>${renderSpans(block.spans, where)}</p>`;
    /**
     * A heading degrades to a bold paragraph, on purpose.
     *
     * `<h1>`..`<h6>` are NOT in the kept subset — the server strips them and
     * the text inside survives as an unstyled run, which reads as a missing
     * line rather than a missing style. Emitting `<p><b>` here means the
     * caller's intent ("this is a section label") lands as something the
     * server keeps, and the round-trip check then passes on a value that is
     * genuinely what we sent.
     */
    case "h":
      return `<p><b>${renderSpans(block.spans, where)}</b></p>`;
    case "ul":
      return renderItems(block.items, "ul", where);
    case "ol":
      return renderItems(block.items, "ol", where);
    default:
      fail(`${where}: unknown block type ${JSON.stringify(block.type)}`);
  }
}

function render(blocks) {
  if (!Array.isArray(blocks)) fail("input must be a JSON array of blocks");
  if (blocks.length === 0) fail("input must contain at least one block");
  return blocks.map(renderBlock).join("");
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let blocks;
  try {
    blocks = JSON.parse(raw);
  } catch (e) {
    fail(`stdin is not valid JSON: ${e.message}`);
  }
  process.stdout.write(render(blocks));
}

main();
