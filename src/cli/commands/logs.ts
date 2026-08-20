/**
 * `pifleet logs --worker <id>` (SRD §10): tail a worker's event stream.
 *
 * READ-ONLY, structurally. This process runs inside a pane, and a pane is a
 * view, never a channel (SRD §3.3): it reads `events.jsonl` (and, under
 * `--render`, `supervisor.log`) and writes to its own stdout, full stop. It
 * must not open the control socket, must not write anywhere under the run
 * directory, and must not import anything that could — a viewer able to
 * steer a worker turns the one surface that is NOT the control plane into
 * the control plane. The integration suite walks this file's source and its
 * import list to keep that true (same pattern as ISC-136), which is why the
 * imports below stay minimal and static.
 *
 * Three output modes:
 *  - default: verbatim lines, exactly what `tail` would show.
 *  - `--json`: raw event objects passed through unchanged, with the added
 *    promise that every stdout line parses — a complete line that does not
 *    is noted on stderr and skipped, never emitted into a machine stream.
 *  - `--render`: the pane-viewer view `up` currently fakes with
 *    `tail -F events.jsonl supervisor.log` — one legible line per event,
 *    control characters neutralized, because event payloads mirror
 *    worker-authored stderr and a raw escape sequence reaching the
 *    operator's terminal is line-forging (the ISC-245 failure class, on a
 *    different surface).
 *
 * `--follow` waits for files that do not exist yet — the supervisor creates
 * `events.jsonl` lazily, so a viewer started at `up` would die instantly
 * under `tail -f` semantics; that race is exactly why the placeholder used
 * `tail -F`.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT, SESSION_ID_RE } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { LineTooLongError, TailReader } from "../../util/jsonl.ts";

/** Longest rendered line; a giant tool result must not flood the pane. */
const RENDER_CLIP = 400;

/**
 * C0/C1 controls and DEL, tab excepted. Everything matched is replaced, not
 * stripped: a visible U+FFFD tells the operator content was withheld, where
 * silent removal would present doctored text as verbatim.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");

function sanitize(s: string): string {
  return s.replace(CONTROL_CHARS, "�");
}

function clip(s: string): string {
  return s.length > RENDER_CLIP ? `${s.slice(0, RENDER_CLIP - 1)}…` : s;
}

/**
 * One event line → one legible line, or `null` for a blank.
 *
 * Total by construction: malformed JSON, non-object JSON, and half-written
 * records all render as sanitized raw text rather than throwing. A partial
 * last line is NORMAL when tailing an append-only file — the splitter
 * usually withholds it, but this function must survive one anyway, because
 * a renderer that can crash on a byte sequence in the stream it watches is
 * a denial-of-view any worker could trigger.
 */
export function renderEventLine(line: string): string | null {
  const raw = line.trim();
  if (raw.length === 0) return null;

  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return clip(sanitize(raw));
  }
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    return clip(sanitize(raw));
  }
  const r = rec as Record<string, unknown>;

  const ts = typeof r["ts"] === "string" ? (r["ts"] as string) : "";
  // HH:MM:SS from an ISO timestamp; a record without one still renders.
  const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts) ? ts.slice(11, 19) : "--:--:--";
  const type = typeof r["type"] === "string" ? (r["type"] as string) : "?";

  switch (type) {
    case "event": {
      // The wrapped Pi RPC event — the line an operator watches for.
      const inner = r["event"];
      const innerType =
        typeof inner === "object" && inner !== null && !Array.isArray(inner)
          ? String((inner as Record<string, unknown>)["type"] ?? "?")
          : "?";
      const seq = typeof r["seq"] === "number" ? ` #${r["seq"]}` : "";
      return clip(sanitize(`${time} event${seq} ${innerType}`));
    }
    case "settled": {
      const reason =
        typeof r["reason"] === "string" && r["reason"] !== "" ? ` (${r["reason"]})` : "";
      return clip(
        sanitize(
          `${time} settled ${String(r["task_id"] ?? "?")} epoch ${String(r["epoch"] ?? "?")} → ${String(r["verdict"] ?? "?")}${reason}`,
        ),
      );
    }
    case "stderr_line":
      // Worker-authored bytes; the sanitize above is what makes this safe to
      // put on a terminal.
      return clip(sanitize(`${time} stderr │ ${String(r["line"] ?? "")}`));
    default: {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k !== "ts" && k !== "type") rest[k] = v;
      }
      const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      return clip(sanitize(`${time} ${type}${detail}`));
    }
  }
}

/** Rendered view of one supervisor.log line (crash text, not JSONL). */
function renderSupervisorLine(line: string): string | null {
  const raw = line.trim();
  if (raw.length === 0) return null;
  return clip(sanitize(`--:--:-- supervisor │ ${raw}`));
}

/**
 * Poll a TailReader, surviving an oversized line. The supervisor's ledger
 * appender bounds every record it emits, so this does not occur in a stream
 * the supervisor produced — but the file is on disk and anything can have
 * written to it, and a viewer that dies on hostile input is a
 * denial-of-view. The lines completed before the oversized one are still
 * delivered.
 */
async function pollSafe(reader: TailReader): Promise<string[]> {
  try {
    return await reader.poll();
  } catch (err) {
    if (err instanceof LineTooLongError) return [...err.completed];
    throw err;
  }
}

interface LogsOpts {
  worker?: string;
  run?: string;
  follow?: boolean;
  render?: boolean;
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command("logs")
    .description("Tail a worker's event stream")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("-f, --follow", "stream until interrupted")
    .option("--render", "render the pane viewer view")
    .option("--json", "emit machine-readable output")
    .action(async (opts: LogsOpts) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("logs requires --worker <id>", EXIT.USAGE);
      }
      // Same grammar the rest of the system enforces — and, here, the thing
      // that keeps a crafted worker id from walking the joined path out of
      // the run directory.
      if (!SESSION_ID_RE.test(opts.worker) || opts.worker.length > 64) {
        throw new CliError(`invalid worker id: ${sanitize(opts.worker)}`, EXIT.USAGE);
      }
      if (opts.render === true && opts.json === true) {
        throw new CliError("--render and --json are mutually exclusive", EXIT.USAGE);
      }

      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) {
        throw new CliError("no runs found", EXIT.USAGE);
      }
      const run = runPaths(runId, root);
      const wp = workerPaths(run, opts.worker);
      const follow = opts.follow === true;

      /**
       * Existence is checked only when NOT following. A follower must
       * tolerate everything being missing — the supervisor creates
       * `events.jsonl` lazily, and `up` may start the viewer first — so it
       * waits, like the `tail -F` it replaces. A one-shot read has no later
       * poll to recover on: silence about a typo'd worker would be
       * indistinguishable from a worker that emitted nothing, so the typo
       * must be loud.
       */
      if (!follow) {
        const { stat } = await import("node:fs/promises");
        if (opts.run !== undefined) {
          const runExists = await stat(run.runJson).then(
            () => true,
            () => false,
          );
          if (!runExists) throw new CliError(`no such run: ${runId}`, EXIT.USAGE);
        }
        const workerDir = await stat(wp.dir).then(
          (s) => s.isDirectory(),
          () => false,
        );
        if (!workerDir) {
          throw new CliError(`no such worker "${opts.worker}" in run ${runId}`, EXIT.USAGE);
        }
      }

      /**
       * Emit through one choke point so the EPIPE of a closed pane ends the
       * stream quietly. The pane can vanish at any moment — that is normal
       * teardown, not an error, and the alternative is a stack trace written
       * to a pipe nobody is reading.
       */
      let stdoutGone = false;
      const out = (line: string): void => {
        if (stdoutGone) return;
        try {
          process.stdout.write(`${line}\n`);
        } catch {
          stdoutGone = true;
        }
      };

      const emit = (lines: string[]): void => {
        for (const line of lines) {
          if (opts.render === true) {
            const rendered = renderEventLine(line);
            if (rendered !== null) out(rendered);
          } else if (opts.json === true) {
            // Raw objects, unchanged — but every emitted line must parse.
            // A malformed COMPLETE line (a partial one never reaches here;
            // the splitter withholds it) is noted and skipped rather than
            // injected into a stream a machine is consuming.
            try {
              JSON.parse(line);
            } catch {
              process.stderr.write("pifleet: skipped a malformed event line\n");
              continue;
            }
            out(line);
          } else {
            out(line);
          }
        }
      };

      const events = new TailReader(wp.eventsJsonl);
      // The render view also watches the supervisor log: it is where a crash
      // lands, and a pane that goes quiet should show why (measured: the log
      // is usually 0 bytes, so this contributes nothing until it matters).
      const supervisor = opts.render === true ? new TailReader(wp.supervisorLog) : null;

      const pollAll = async (): Promise<void> => {
        emit(await pollSafe(events));
        if (supervisor !== null) {
          for (const line of await pollSafe(supervisor)) {
            const rendered = renderSupervisorLine(line);
            if (rendered !== null) out(rendered);
          }
        }
      };

      /**
       * Follow until told to stop. SIGINT/SIGTERM resolve the race below so
       * the sleep is cut short, one final drain picks up lines written just
       * before the signal, and the action RETURNS — through main()'s ladder,
       * exit 0 — rather than calling process.exit from a handler. Nothing
       * here touches terminal modes, so there is no state to restore; a
       * clean return is the whole cleanup.
       */
      let stopped = false;
      let wake: (() => void) | null = null;
      const stop = (): void => {
        stopped = true;
        wake?.();
      };

      /**
       * REGISTERED BEFORE THE FIRST DRAIN, not after it (ISC-269).
       *
       * The handlers used to go up after `await pollAll()` had already
       * returned, which left the whole of that first drain unguarded. A
       * SIGINT arriving in that window got Bun's DEFAULT disposition —
       * terminate, exit 130 — and the window is exactly as long as the
       * backlog takes to render, so it is not a narrow one. Measured on the
       * unfixed code: a worker with 200 000 buffered events exits 130 on
       * five runs out of five, while a worker with one event exits 0 on five
       * out of five. The bug was never intermittent; it was proportional to
       * how much the follower had to catch up on, which is why the test that
       * caught it (`SIGINT also ends a follower cleanly`) read as flaky
       * rather than as the real Ctrl-C defect it was.
       *
       * Registering first is safe in both directions. A signal during the
       * drain now sets `stopped`, the drain finishes on its own, and the
       * loop below is skipped — the same "one final drain, then return
       * cleanly" behaviour the comment above describes, just applied to the
       * first drain as well as the last. The `finally` still removes both
       * listeners on every path, including the `!follow` early return.
       *
       * A signal arriving BEFORE this point — during argument parsing or the
       * `stat` calls above — still exits 130, and that is left alone
       * deliberately: nothing has been emitted yet, so there is no session to
       * end cleanly, and widening the guard to cover process startup would
       * mean catching signals before there is anything to catch them for.
       */
      if (follow) {
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }
      try {
        await pollAll();
        if (!follow) return;
        while (!stopped && !stdoutGone) {
          await Promise.race([
            Bun.sleep(150),
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
          ]);
          wake = null;
          await pollAll();
        }
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    });
}
