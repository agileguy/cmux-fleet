/**
 * The monitor's entire relationship with Docker (SRD-FLEET-MONITOR §6.7, D7).
 *
 * ## Why this file is a frozen array and a nullary function
 *
 * §4.2 argues that the monitor's read-only property has to be STRUCTURAL, and
 * the structure it names for every other source is an import graph: a viewer
 * that never imports `rpc/client.ts` cannot open a control socket, and the
 * walk that proves it is mechanical. **A subprocess spawn walks straight past
 * that guard.** `docker` is a binary with the authority to delete every
 * container on the host, so the moment this pane can spawn it, "read-only" has
 * stopped being a property of the import list.
 *
 * D7 replaces the walk with a narrower guard, and this file is that guard's
 * whole surface: **the argv is constructed in exactly one function, that
 * function takes no parameters, and the array it returns is frozen.**
 *
 * The parameterlessness is the load-bearing half, not the freezing. An argv
 * builder that accepts a container name is one review-sized edit away from
 * accepting a subcommand — `dockerArgv(name)` widens to `dockerArgv(verb,
 * name)` without ever looking like a security change in a diff — whereas a
 * builder with an empty parameter list cannot be handed anything at all, and
 * widening it is a signature change every reviewer sees. That is the same
 * containment shape `run/paths.ts:395-410` argues for export paths: build the
 * value yourself rather than validate a caller's, because getting a path (or
 * an argv) validator wrong is the normal outcome and building it yourself is
 * not.
 *
 * The precedents are `container/interrupt.ts:134`'s `interruptArgv` and
 * `security/relay.ts:1976-1984`'s `relayInspectArgv`. This file is
 * deliberately STRICTER than both: those take a container name because they
 * act on one named container, and this one acts on the daemon.
 *
 * ## Two refusals, and they are refusals rather than omissions
 *
 * - **No `docker inspect`.** One process per container per tick, to learn
 *   something the `ps` line mostly already carries (§6.7).
 * - **No `docker stats`, in either form.** `--no-stream` samples over a window
 *   per container by design and the streaming form never returns; §9 Q2 holds
 *   the measurement, which is to say there is not one. An unknown cost on a
 *   standing pane is the wrong kind of unknown.
 *
 * Neither verb appears in this file, and the argv is asserted byte-for-byte by
 * a test — so adding one is a failing test rather than a code review.
 *
 * ## Why `container/run.ts`'s `Exec` seam is NOT reused here
 *
 * `container/run.ts:27` already defines almost exactly the runner type this
 * module wants, and importing it would be ordinary reuse anywhere else in this
 * tree. It is refused here for one reason: that module is the one that builds
 * and runs `docker run` argv, so importing it for a type would put the
 * container LAUNCHER on the monitor's transitive import list — the precise
 * fact D3's import walk exists to detect. A nine-line local type costs less
 * than making the read-only assertion argue about which exports of an imported
 * module are dangerous. Reuse is the default in this repo; this is the
 * exception, and it is exceptional because of what the import would DRAG, not
 * because of what it declares.
 *
 * ## The runner seam takes no argv either
 *
 * {@link DockerPsRun} is a nullary function. A test double substitutes the
 * SPAWN, never the command line — so the injectable seam cannot be used to run
 * something else, which would have re-opened this file's hole from the one
 * direction the argv assertion does not watch.
 */

import { monotonicMs } from "../../util/clock.ts";
import { failed, ok, type Region } from "../model.ts";

/**
 * The one Docker command line this process will ever run.
 *
 * The format string is pinned by §6.7 and both halves are load-bearing:
 * `{{.Names}}` is the join key against `workerContainerName`
 * (`run/paths.ts:484`), and `{{.Status}}` is what §6.5's degradation ladder
 * drops SECOND — so a format that omitted it would make that ladder
 * unbuildable without a second Docker call, and the second call is exactly
 * what D7 refuses.
 *
 * A frozen module-level constant rather than a fresh array per call: a caller
 * that mutates the returned array must fail loudly under strict mode instead
 * of quietly editing the next tick's command line.
 */
const DOCKER_PS_ARGV: readonly string[] = Object.freeze([
  "docker",
  "ps",
  "--format",
  "{{.Names}}\t{{.Status}}",
]);

/**
 * The frozen `docker ps` argv. **Takes no parameters, and that is the
 * criterion** (D7): there is no caller input to influence, so there is nothing
 * to validate and nothing a validator could get wrong.
 */
export function dockerPsArgv(): readonly string[] {
  return DOCKER_PS_ARGV;
}

/** One `docker ps` row, as the pinned format emits it. */
export interface DockerPsRow {
  readonly name: string;
  /** `Up 9 hours`, `Exited (0) 3 minutes ago` — verbatim, never reinterpreted. */
  readonly status: string;
}

/**
 * How `docker ps` finished. A local shape rather than `container/run.ts`'s
 * `ExecResult`, for the reason the header gives.
 *
 * `code === null` means killed rather than exited, and it is kept distinct
 * from a non-zero code because "the daemon refused" and "we stopped waiting"
 * are different sentences on an operator's screen.
 */
export interface DockerPsResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The spawn, and nothing but the spawn. Nullary by design — see the header. */
export type DockerPsRun = () => Promise<DockerPsResult>;

/**
 * How long the daemon gets before the pane gives up on it.
 *
 * Chosen against the ONLY measurement this design has: §2.6 recorded `docker
 * ps` returning nine containers "in well under a second" on this host on
 * 2026-09-02. Five seconds is therefore a bound on a pathological daemon, not
 * a tuned value, and it is stated as such rather than presented as measured.
 *
 * It matters because it sits inside the SLOW clock's 30 s budget: an unbounded
 * hang here is a pane that stops repainting, and §4.3 holds that a viewer
 * which lies is worse than one that admits it cannot see.
 */
export const DOCKER_PS_TIMEOUT_MS = 5_000;

const realDockerPs: DockerPsRun = async () => {
  const argv = dockerPsArgv();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    /**
     * `Bun.spawn` THROWS when the binary is not on `$PATH` — it does not
     * return 127 the way a shell does (`container/run.ts:104-107` records the
     * same surprise from the other side). A laptop with no Docker installed is
     * an ORDINARY state for this pane, so it has to arrive as a result the
     * region layer renders, never as an exception that takes the frame down.
     */
    return { code: null, stdout: "", stderr: String(err) };
  }

  const killer = setTimeout(() => proc.kill("SIGKILL"), DOCKER_PS_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
};

/**
 * Parse the pinned format. Pure, so every part of the Docker plane except the
 * spawn itself is exercisable with no daemon and no container (ISC-491).
 *
 * TOTAL by construction, on `cli/commands/logs.ts:57-66`'s reasoning applied
 * one source over: a line without a tab is skipped rather than thrown on.
 * Container names are partly worker-derived territory — a run id and a worker
 * id reach the name through `workerContainerName` — and a parser that can
 * throw on a byte sequence in its own input is a denial-of-view.
 */
export function parseDockerPs(stdout: string): readonly DockerPsRow[] {
  const rows: DockerPsRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab);
    if (name.length === 0) continue;
    rows.push({ name, status: line.slice(tab + 1) });
  }
  return rows;
}

/**
 * The container names `docker ps` reported, shaped for `FleetModel.containers`
 * (`monitor/model.ts:158`).
 *
 * **A failed `docker ps` is a region-level failure, never a throw** (§6.7).
 * The daemon not running is an ordinary laptop state, and `failed` carries
 * that onto the screen as `docker unavailable` — which is itself information,
 * since it means every container in the fleet is gone.
 *
 * Returning `ok([])` there is the specific lie this shape exists to prevent.
 * An empty container set and an unreachable daemon would then render
 * identically, and the second one would mark every live worker
 * `container-gone` (`monitor/model.ts:114`) — a monitor inventing the single
 * most actionable finding in the whole design, on no evidence.
 *
 * `now` is read AFTER the command finishes, never before it starts: `readAt`
 * is the time the read SUCCEEDED (`monitor/model.ts:44`), and stamping it at
 * dispatch would report a five-second-old answer as current.
 */
export async function readDockerContainers(opts?: {
  readonly run?: DockerPsRun;
  readonly now?: () => number;
}): Promise<Region<readonly string[]>> {
  const run = opts?.run ?? realDockerPs;
  const now = opts?.now ?? monotonicMs;

  let result: DockerPsResult;
  try {
    result = await run();
  } catch (err) {
    return failed(dockerUnavailable(String(err)), now());
  }

  if (result.code !== 0) {
    /**
     * The daemon's own FIRST line, not the whole of stderr: `docker` prints a
     * multi-line hint about starting Docker Desktop, and a region reason is
     * one cell on a strip. `logs.ts:39`'s `RENDER_CLIP` makes the same trade
     * at the same place, and this is tighter because the strip is narrower
     * than the log pane.
     */
    const detail = (result.stderr.split("\n")[0] ?? "").trim();
    return failed(
      dockerUnavailable(
        detail.length > 0 ? detail : result.code === null ? "killed" : `exit ${result.code}`,
      ),
      now(),
    );
  }

  return ok(
    parseDockerPs(result.stdout).map((r) => r.name),
    now(),
  );
}

/**
 * The wording §6.7 names, with the diagnosis appended rather than substituted.
 * The prefix is what an operator scans for; the detail is what they act on,
 * and dropping it leaves "docker unavailable" unable to distinguish a stopped
 * daemon from a missing binary — two states with different fixes.
 */
function dockerUnavailable(detail: string): string {
  return `docker unavailable: ${detail}`;
}
