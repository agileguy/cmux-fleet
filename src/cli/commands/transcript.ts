/**
 * `pifleet transcript --worker <id> [--html f]` — A4 raw, A5 human-readable
 * (SRD §8.4, ISC-101).
 *
 * A4 is the session file verbatim; `--json` parses it through the harvest
 * reader instead. A5 is preferably Pi's own `export_html` RPC, reached through
 * the worker's control socket — but the transcript that most needs exporting
 * belongs to a worker that is DEAD, and a dead worker answers no RPC. So the
 * RPC path is attempted first and a local render from A4 is the fallback,
 * which is what makes ISC-101 hold for exactly the workers harvest exists for.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT, type WorkerState } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths, type RunPaths } from "../../run/paths.ts";
import { readWorkerState } from "../../run/state.ts";
import { controlCall } from "../../supervisor/launch.ts";
import {
  classifySession,
  isAssistantEntry,
  isCompactionEntry,
  isMessageEntry,
  readTranscript,
  reconstruct,
  type SessionPresence,
  type TranscriptReader,
  type TreeEntry,
} from "../../harvest/transcript.ts";

/** Resolve `(run, state)` for a worker, exiting 2 when the name names nothing. */
export async function resolveWorker(
  workerId: string | undefined,
  runId: string | undefined,
  command: string,
): Promise<{ run: RunPaths; state: WorkerState; workerId: string }> {
  if (workerId === undefined) {
    throw new CliError(`${command} requires --worker`, EXIT.USAGE);
  }
  const root = runsRoot();
  const resolved = runId ?? (await latestRunId(root));
  if (resolved === null) throw new CliError("no runs found", EXIT.USAGE);
  const run = runPaths(resolved, root);
  const state = await readWorkerState(workerPaths(run, workerId));
  if (state === null) {
    // A worker id that names nothing must not exit 0 — the ISC-177 lesson,
    // relearned on `wait`: an orchestrator that typo'd a worker id would
    // otherwise read the silence as success.
    throw new CliError(`worker ${workerId} has no state under run ${resolved}`, EXIT.USAGE);
  }
  return { run, state, workerId };
}

/** Why a non-`present` transcript is absent, in one operator-readable line. */
export function presenceLine(p: SessionPresence): string {
  switch (p) {
    case "present":
      return "transcript present";
    case "never_created":
      // ISC-96: legitimately absent — the file is created lazily on the first
      // assistant message, and the supervisor never saw it exist.
      return "no transcript: the worker died before its first assistant message";
    case "missing_after_present":
      // ISC-96, the other half: the supervisor confirmed this path existed,
      // so its absence now is a wrong path or a deleted file — a bug, not a
      // quiet worker.
      return "no transcript: the session file is missing at the recorded path (it was present before)";
    case "unrecorded":
      return "no transcript: get_state never reported a session path";
  }
}

// ---------------------------------------------------------------------------
// A5 local renderer — the fallback when no live worker can run export_html.
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Every string that reaches the page goes through here — transcript content
 * is worker-authored and worker-authored prose is data, never markup
 * (SRD §12.6). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    const block = b as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking") parts.push("[thinking]");
    else if (block.type === "toolCall" && typeof block.name === "string")
      parts.push(`[tool: ${block.name} ${JSON.stringify(block.arguments ?? {})}]`);
    else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function entryHtml(e: TreeEntry): string {
  if (isMessageEntry(e)) {
    const role = escapeHtml(e.message.role);
    const cls = isAssistantEntry(e) ? "assistant" : escapeHtml(e.message.role);
    const body = escapeHtml(blockText(e.message.content));
    const err =
      (e.message as { isError?: unknown }).isError === true
        ? ' <span class="err">error</span>'
        : "";
    return `<section class="msg ${cls}"><h2>${role}${err}</h2><pre>${body}</pre></section>`;
  }
  if (isCompactionEntry(e)) {
    return `<section class="msg compaction"><h2>compaction</h2><pre>${escapeHtml(e.summary)}</pre></section>`;
  }
  return `<section class="msg other"><h2>${escapeHtml(e.type)}</h2></section>`;
}

export function renderHtml(
  reader: Pick<TranscriptReader, "entries" | "header">,
  meta: { worker: string; runId: string; sessionPath: string },
): string {
  const title = escapeHtml(`pifleet transcript — ${meta.worker}`);
  const head =
    `<p class="meta">run ${escapeHtml(meta.runId)} · ` +
    `session <code>${escapeHtml(meta.sessionPath)}</code> · ` +
    `${reader.entries.length} entries</p>`;
  const body = reader.entries.map(entryHtml).join("\n");
  // Self-contained on purpose: no scripts, no external assets. The file must
  // open from disk on any machine (ISC-101), and transcript content is
  // untrusted, so the page carries no execution surface at all.
  return (
    "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
    `<title>${title}</title>` +
    "<style>body{font-family:ui-monospace,monospace;max-width:60rem;margin:2rem auto;padding:0 1rem}" +
    ".msg{border:1px solid #ccc;border-radius:4px;margin:1rem 0;padding:0 1rem 1rem}" +
    ".msg h2{font-size:0.9rem;text-transform:uppercase;letter-spacing:0.05em}" +
    ".assistant{background:#f4f8ff}.user{background:#f8f8f8}.compaction{background:#fffbe8}" +
    ".err{color:#b00}pre{white-space:pre-wrap;word-break:break-word;margin:0}</style>" +
    `</head><body><h1>${title}</h1>${head}\n${body}\n</body></html>\n`
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Register `pifleet transcript` (SRD §10, §8.4). */
export function register(program: Command): void {
  program
    .command("transcript")
    .description("Export a worker's session transcript")
    .option("-w, --worker <id>", "worker id")
    .option("--run <id>", "run id (default: latest)")
    .option("--html <path>", "write a standalone HTML export")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; html?: string; json?: boolean }) => {
      const { run, state, workerId } = await resolveWorker(opts.worker, opts.run, "transcript");
      const presence = await classifySession(state);

      if (presence !== "present") {
        if (opts.html !== undefined) {
          // An openable file was asked for and none can be produced. That is
          // a partial harvest, not a usage error — the request was
          // well-formed and the run is simply not in a state to satisfy it.
          throw new CliError(presenceLine(presence), EXIT.PARTIAL);
        }
        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              schema: "pifleet.transcript/v1",
              worker: workerId,
              run_id: run.runId,
              session_path: state.session_path,
              presence,
              entries: [],
              entry_count: 0,
            })}\n`,
          );
        } else {
          process.stdout.write(`${presenceLine(presence)}\n`);
        }
        return; // A pure read (§8.4): valid output emitted, exit 0.
      }

      const sessionPath = state.session_path as string; // non-null: presence === "present"

      if (opts.html !== undefined) {
        const source = await exportHtml(run, workerId, sessionPath, opts.html);
        const payload = { worker: workerId, html: opts.html, source };
        process.stdout.write(
          opts.json === true
            ? `${JSON.stringify(payload)}\n`
            : `wrote ${opts.html} (${source})\n`,
        );
        return;
      }

      if (opts.json === true) {
        const reader = await readTranscript(sessionPath);
        const rec = reconstruct(reader);
        process.stdout.write(
          `${JSON.stringify({
            schema: "pifleet.transcript/v1",
            worker: workerId,
            run_id: run.runId,
            session_path: sessionPath,
            presence,
            header: reader.header,
            entry_count: reader.entries.length,
            malformed: reader.malformed,
            truncated: reader.truncated,
            usage: rec.usage,
            entries: reader.entries,
          })}\n`,
        );
        return;
      }

      // A4 raw: the session file verbatim. Not re-serialized parsed records —
      // a re-serialization is a second opinion, and "raw" means the bytes Pi
      // wrote.
      process.stdout.write(await Bun.file(sessionPath).text());
    });
}

/**
 * A5: Pi's `export_html` via the supervisor when one is alive, local render
 * when not. Returns which path produced the file.
 */
async function exportHtml(
  run: RunPaths,
  workerId: string,
  sessionPath: string,
  outPath: string,
): Promise<"rpc" | "local"> {
  try {
    const reply = await controlCall(
      run,
      workerId,
      { cmd: "export_html", path: outPath },
      { timeoutMs: 10_000 },
    );
    // Trust the reply only as far as the filesystem confirms it: the file is
    // the deliverable (ISC-101), not the acknowledgement.
    if (reply["ok"] === true && (await Bun.file(outPath).exists())) return "rpc";
  } catch {
    // No live supervisor — the normal harvest case, not an error.
  }
  const reader = await readTranscript(sessionPath);
  await Bun.write(outPath, renderHtml(reader, { worker: workerId, runId: run.runId, sessionPath }));
  return "local";
}
