/**
 * Run registry (SRD §7.7) and the control-plane socket layer.
 *
 * `registry.json` has a SINGLE writer — the daemon. Every mutation is an RPC
 * to it over a unix socket; readers read the file. Two supervisors writing
 * the registry directly would need cross-process file locking, which is
 * exactly the class of coordination the single-writer rule exists to avoid.
 *
 * Process identity is `(pid, started)` — pid plus `ps -o lstart=` start time —
 * never pid alone. Pids recycle: a registry that remembers only the number
 * will happily resurrect a dead supervisor when an unrelated process is
 * assigned its pid, and `down` would then SIGTERM an innocent bystander.
 *
 * The socket protocol is one JSON request line, one JSON response line, over
 * the same `LineSplitter` framing as everything else. Sockets live under
 * `os.tmpdir()` (see run/paths.ts for the 104-byte `sun_path` rationale).
 */

import { z } from "zod";
import { EXIT, type WorkerState } from "../contracts.ts";
import {
  AUTH_FIELD,
  checkAuth,
  ensureControlAuth,
  loadControlSecret,
} from "../security/control-auth.ts";
import {
  HeartbeatMonitor,
  reapStale,
  type ReaperOps,
  type ReapReport,
} from "../safety/reaper.ts";
// TYPE-ONLY, and it has to stay that way: `kill.ts` imports `processStartTime`
// from this module, so a value import here would close the documented
// `kill.ts -> run/registry.ts -> … -> safety/reaper.ts -> kill.ts` cycle from a
// second direction. A `import type` is erased before it can.
import type { KillOutcome } from "../safety/kill.ts";
import { writeJsonAtomic, LineSplitter, parseLine } from "../util/jsonl.ts";
import { workerPaths, type RunPaths } from "./paths.ts";
import { readWorkerState } from "./state.ts";

// ---------------------------------------------------------------------------
// Process identity — pid + start time, never pid alone.
// ---------------------------------------------------------------------------

export interface ProcessIdentity {
  pid: number;
  /** A `processStartTime` token. Empty string when nothing captured one. */
  started: string;
}

/**
 * The rendering `processStartTime` pins, and the tag it stamps on the result.
 *
 * `ps -o lstart=` RENDERS a timestamp; it does not report one. The rendering
 * is read from the calling process's own environment, so the same live pid at
 * the same instant produces different bytes in different shells — measured on
 * one pid, one instant, this machine:
 *
 *   TZ=UTC               "Thu 20 Aug 06:51:33 2026"
 *   TZ=America/Halifax   "Thu 20 Aug 03:51:33 2026"
 *   TZ=Asia/Tokyo        "Thu 20 Aug 15:51:33 2026"
 *   LC_TIME=de_DE.UTF-8  "Do. 20 Aug. 00:51:33 2026"
 *
 * An identity is captured in the LAUNCHER's environment and compared in the
 * OPERATOR's, and those are routinely different processes: `up` from a local
 * terminal and `down` over SSH (sshd forwards `LC_TIME` under its default
 * `AcceptEnv LANG LC_*`), `up` from launchd or cron with no `TZ` at all and
 * `down` from a shell that sets one, a containerised CLI against a
 * host-launched daemon. Every one of those made a LIVE supervisor compare
 * unequal to its own recorded identity — which the whole kill path reads as
 * "this process is gone". DST is not involved; the offset does not have to
 * change for the two renderings to differ.
 *
 * So the rendering is pinned at the source rather than compensated for at each
 * comparison. `TZ=UTC` fixes the instant, `LC_ALL=C` fixes the field order and
 * the month/weekday names; together they make the string a function of the
 * process alone.
 *
 * The tag is the other half, and it is what makes the format change SURVIVABLE
 * rather than silent. Pinning changes the bytes for every identity already on
 * disk — even on a machine that was already in UTC, because `LC_ALL=C` also
 * reorders the fields ("Thu Aug 20 …" against "Thu 20 Aug …"). An untagged
 * recorded value is therefore not comparable to a tagged one, and it is not a
 * MISMATCH either: "a stranger holds this pid" would be a false statement
 * about the world. Callers detect it with `isPinnedIdentity` and refuse
 * explicitly. See `down`'s `anchorIdentity` for the policy that rests on this.
 */
export const IDENTITY_FORMAT = "utc1";

/** Environment that makes `ps -o lstart=` a function of the process alone. */
const IDENTITY_PS_ENV = { TZ: "UTC", LC_ALL: "C" } as const;

/**
 * A `ps` read of a process's start time that did not produce one, for a reason
 * OTHER than the process being gone.
 *
 * THE IDENTITY HALF of the fact `GroupReadError` records for the group, and it
 * is the same defect one channel over rather than a new one. "The process is
 * not there" and "I could not find out" are different facts with opposite safe
 * answers, and `processStartTime` used to return `null` for both.
 *
 * What that `null` reaches. `down`'s `anchorIdentity` maps it to
 * `{kind: "gone"}` — the ONE anchor verdict that reports `stopped: true`, calls
 * `reapContainer()` (`docker rm -f`) and makes the worker PRUNABLE. So a
 * transient `ps` failure against a LIVE supervisor reported it stopped,
 * force-removed its container, and let `--prune` delete the checkout it was
 * still writing to. `processGroupId` was fixed for exactly this and the
 * identity channel was left carrying it, which is why this is a carry-in of the
 * Phase F review rather than a fresh finding.
 *
 * Thrown rather than returned, for the reason `GroupReadError` is: there is no
 * in-band value for a caller to forget to look at.
 *
 * CARRIES AN `exitCode` WHERE `GroupReadError` DOES NOT, and the asymmetry is
 * deliberate. Every `processGroupId` call goes through `confirmGroup`, which
 * catches and converts to `read_failed`, so its error never reaches the CLI.
 * This one has callers that do not catch (see `processStartTime` below), and an
 * error with no `exitCode` is reported by the entry point as `EXIT.INTERNAL` —
 * "a bug in pifleet itself". A `ps` that cannot be read is an environment
 * failure, so it takes `BACKEND_UNAVAILABLE`, the code `StateReadError` and
 * `RunPolicyUnreadableError` already use for unreadable control-plane state.
 */
export class IdentityReadError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly pid: number,
    detail: string,
  ) {
    super(
      `could not read the start time of pid ${pid}: ${detail}. This is NOT the process being ` +
        `gone — nothing here can tell whether it is alive, so nothing may be stopped, reaped or ` +
        `pruned on the strength of this read.`,
    );
    this.name = "IdentityReadError";
  }
}

/** The `ps` spawn, factored out ONLY so `proc`'s type can be named below. */
function spawnIdentityPs(pid: number) {
  return Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    // Explicitly, not inherited. This is the whole fix: without it the
      // token carries the caller's TZ and locale into a value that another
      // process, in another environment, compares byte-for-byte.
      env: { ...process.env, ...IDENTITY_PS_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Start time of a pid as a tagged, environment-independent token. `null` means
 * `ps` AFFIRMATIVELY reported no such process; a read that failed for any other
 * reason throws `IdentityReadError`.
 *
 * Never returns the empty string: `""` is the CAPTURE-FAILED sentinel that
 * callers persist via `?? ""`, and it must be read as exactly that and never as
 * an identity.
 *
 * WHAT "AFFIRMATIVELY GONE" LOOKS LIKE, measured on this machine (Darwin 25.5,
 * the base-system `ps`) for `-o lstart=` specifically rather than inherited
 * from the `-o pgid=` reading in `safety/kill.ts`. Same five readings twice:
 *
 *   a live pid                         exit 0  stdout "Fri Aug 21 04:14:42 2026"  stderr ""
 *   a pid that exited and was reaped   exit 1  stdout ""                          stderr ""
 *   pid 999999999, above the ceiling   exit 1  stdout ""                          stderr "ps: process id too large: 999999999"
 *   `-p not-a-number`                  exit 1  stdout ""                          stderr "ps: Invalid process id: not-a-number"
 *   an unknown flag                    exit 1  stdout ""                          stderr "ps: illegal option -- -"
 *
 * THE EXIT CODE IS NOT THE DISCRIMINATOR, and neither is stdout: a reaped pid
 * and a malformed invocation are byte-identical on both. The one thing that
 * separates them is that a genuinely-absent process is the case where `ps` says
 * NOTHING on all three channels. So stderr is captured rather than ignored —
 * `stderr: "ignore"` was the whole reason the old `exitCode !== 0 ||
 * out.length === 0` test could not have been written correctly — and silence
 * everywhere is what `null` means.
 *
 * EXIT 0 WITH EMPTY STDOUT THROWS TOO, and it is a separate branch rather than
 * a fold into the one above. `ps` claiming success and printing nothing is a
 * broken read, emphatically not "no such process"; the old condition's
 * `|| out.length === 0` swept it into the destructive answer.
 *
 * Linux `procps` was NOT probed, for the reason `processGroupId` records: a
 * platform whose `ps` writes a diagnostic for an absent pid degrades to a
 * throw, which REFUSES. The cost is a dead supervisor's container outliving it
 * until a later scan, never a live supervisor's container being destroyed.
 *
 * ## Every call site, checked — because a throw where a caller expected `null`
 * ## is a new crash rather than a fix
 *
 * CHECK SITES map `null` to "gone" or "dead" and are the ones this fix is for.
 * `down`'s `anchorIdentity`, `status`, `dispatch`'s liveness probe, `wait`,
 * `identityAlive` below, and `kill.ts`'s `realProcessOps.startTime` (and
 * through it `sameIdentity` and every rung of the ladder) all now REFUSE on an
 * unreadable `ps` instead of declaring the process gone. Every one of those is
 * fail-closed in the direction that matters. The per-worker verdict this
 * originally deferred now EXISTS: `down` reports `identity_read_failed`
 * alongside `group_read_failed`, `signalIfSame` and `runKillLadder` answer
 * `identity_unconfirmed`, and a broken `ps` on one worker therefore refuses
 * that worker instead of aborting the run. Review found the deferral was not
 * merely coarse — the whole worker loop sits outside a try, so an escaping
 * read took the command with it.
 *
 * CAPTURE SITES persist `?? ""` and genuinely want leniency:
 * `startRegistryDaemon` below, `supervisor/index.ts`, and `up.ts` for a pid
 * `launchDetached` has just returned. NOTE the third is weaker than the other
 * two and review said so: `up.ts`'s pid is a freshly-spawned CHILD, not
 * `process.pid`, so "alive by construction" does not strictly hold — it can be
 * reaped between launch and read. The consequence is the `""` sentinel, which
 * every reader already treats as capture-failed, so the leniency is still the
 * right call there; it is recorded rather than glossed. None is forced onto
 * the strict path and
 * none needed to be, because for all three the pid is alive BY CONSTRUCTION —
 * two of them read `process.pid` — so `ps` answers exit 0 with a start time and
 * neither the `null` nor the throw is reachable. The throw becomes reachable
 * for them only if `ps` itself is broken on the host, and aborting there is the
 * honest outcome rather than a regression: every identity the run would go on
 * to record is the capture-failed sentinel, so no later `down` could stop any of
 * its workers without `--force-identity`. Failing at launch beats creating a run
 * that cannot be safely stopped.
 *
 * @throws {IdentityReadError} `ps` could not be read.
 */
export async function processStartTime(pid: number): Promise<string | null> {
  /*
   * THE SPAWN ITSELF CAN THROW, and that is the likeliest real instance of
   * "the measuring instrument is broken": a minimal container image with no
   * procps. `Bun.spawn` raises `Error: Executable not found in $PATH: "ps"`
   * synchronously, with no `exitCode` — so without this wrapper the entry
   * point reports `EXIT.INTERNAL`, "a bug in pifleet itself", for an
   * environment failure. `down.ts` already wraps its `docker` spawn for
   * exactly this reason.
   */
  let proc: ReturnType<typeof spawnIdentityPs>;
  try {
    proc = spawnIdentityPs(pid);
  } catch (err) {
    throw new IdentityReadError(pid, `ps could not be started: ${String(err)}`);
  }
  // Both pipes concurrently. Draining one to EOF while the other fills its
  // buffer is how a tiny read becomes a deadlock on the day `ps` gets chatty —
  // and it does: the illegal-flag reading above is a five-line usage block.
  const [rawOut, rawErr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const out = rawOut.trim();
  const err = rawErr.trim();
  await proc.exited;

  if (proc.exitCode !== 0) {
    /*
     * A SIGNAL-KILLED `ps` IS NOT AN ABSENT PROCESS, and it looks exactly like
     * one on every channel this function reads. Measured on bun 1.3.11: a child
     * terminated by a signal reports `exitCode: null`, `signalCode: "SIGKILL"`,
     * and empty stdout AND stderr — so `exitCode !== 0` is true, both pipes are
     * silent, and the pre-fix condition below answered "affirmatively gone".
     *
     * That is the destructive answer. `gone` is the one verdict `down` may
     * report as a stop, act on with `docker rm -f`, and pass to the `--prune`
     * gate as prunable, so a `ps` killed by memory pressure, an OOM killer, a
     * cgroup limit or a stray `pkill` would have deleted the checkout of a
     * supervisor that was alive and mid-write.
     *
     * Worse, it defeats the identity re-check guard on ITS OWN stated threat
     * model: that guard exists because "the conditions that break one `ps` are
     * exactly the conditions that break the other", and under exactly that
     * pressure BOTH children are signal-killed, both read as absent, and the
     * guard concludes `gone` — the outcome it was built to prevent.
     *
     * So absence requires a NORMAL exit. `exitCode === null` means the child
     * never got to say anything about the process, which is the definition of
     * a failed read.
     */
    if (proc.exitCode !== null && out.length === 0 && err.length === 0) return null;
    throw new IdentityReadError(
      pid,
      err.length > 0
        ? err
        : proc.signalCode !== null
          ? `ps was killed by ${proc.signalCode} before it could answer`
          : `ps exited ${String(proc.exitCode)} without saying why`,
    );
  }
  if (out.length === 0) {
    // Exit 0 with nothing on stdout. `ps` claimed success and told us nothing.
    throw new IdentityReadError(pid, "ps exited 0 and printed no start time");
  }
  return `${IDENTITY_FORMAT} ${out}`;
}

/**
 * Whether a recorded `started` was written by a build that pinned the
 * rendering, and can therefore be compared at all.
 *
 * False for `""` (capture failed — see `processStartTime`) and for any value
 * written before the pin existed. No locale renders a weekday as `utc1`, so
 * the tag cannot collide with a legacy value.
 */
export function isPinnedIdentity(recorded: string): boolean {
  return recorded.startsWith(`${IDENTITY_FORMAT} `);
}

/**
 * True only if the pid is alive AND is still the same process we recorded.
 *
 * PROPAGATES `IdentityReadError` rather than folding it into `false`, which is
 * the same decision `processStartTime` makes one level down and it is load-
 * bearing here for the same reason. This function answers a two-valued question
 * about a three-valued world: "alive and ours", "not ours", and "could not
 * tell". Returning `false` for the third would report an unreadable `ps` as
 * "the supervisor we recorded is not there" — a statement about the world that
 * has not been established, and the one that every caller acts on destructively.
 *
 * @throws {IdentityReadError} `ps` could not be read for this pid.
 */
export async function identityAlive(id: ProcessIdentity): Promise<boolean> {
  const started = await processStartTime(id.pid);
  return started !== null && started === id.started;
}

// ---------------------------------------------------------------------------
// Registry schema
// ---------------------------------------------------------------------------

export const RegistryWorkerSchema = z.object({
  worker: z.string(),
  pid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  started: z.string(),
  registered_at: z.string(),
});

/**
 * The registry stamp THIS build reads, named once so the reader can quote it
 * back to an operator rather than restating the string in a message.
 *
 * Every write of `registry.json` in this tree goes through
 * `RegistrySchema.parse` before it reaches `writeJsonAtomic` (see `persist`
 * and the reaper's deregistration write below), so every registry file this
 * project has ever produced carries a stamp. That is what makes an ABSENT
 * stamp diagnostically different from a WRONG one — see `readRegistry`.
 */
export const REGISTRY_SCHEMA = "pifleet.registry/v1";

export const RegistrySchema = z.object({
  schema: z.literal(REGISTRY_SCHEMA),
  run_id: z.string(),
  daemon: z.object({ pid: z.number().int().nonnegative(), started: z.string() }),
  workers: z.record(z.string(), RegistryWorkerSchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

/**
 * `registry.json` carries a schema stamp this build does not read (ISC-192).
 *
 * THE POLICY IS REFUSAL BY DESIGN, and this class is the refusal being NAMED.
 * It is the same shape `down`'s `identity_legacy_format` already established
 * one channel over, and it is chosen for the same reason: an unrecognised
 * stamp is a fact about the world that an operator can act on, and reporting
 * it as a generic parse failure destroys the only information that makes it
 * actionable — which build wrote this file.
 *
 * REJECTED: accept-and-upgrade. A migration ladder (`v0 -> v1` upgraders)
 * would mean this build writing its own guesses into a file another build owns,
 * on no evidence beyond the stamp being lower. `registry.json` names live
 * supervisor pids and their launch identities; an upgrader that guessed a field
 * wrong would hand `down` a target it invented. The registry is also
 * SINGLE-WRITER by construction (see this module's header), and a reader that
 * rewrites the file is a second writer wearing a reader's name.
 *
 * REJECTED: degrading to `null` — "no registry". That is the conflation this
 * whole phase exists to remove, and here it is not merely misleading, it is
 * DESTRUCTIVE: `startRegistryDaemon` does `(await readRegistry(run)) ?? {…
 * workers: {} }` and then persists that, so a `null` for an unreadable file
 * would make the daemon OVERWRITE a foreign-stamped registry with an empty
 * one of its own — every worker it named forgotten in a single atomic write,
 * with nothing left on disk to say they ever existed.
 *
 * THE HATCH IS NAMED IN THE MESSAGE, because a refusal with no way forward is
 * how an operator learns to reach for whatever flag silences it. There are
 * exactly two honest ways out and both are stated: stop the run with the build
 * that wrote the file, or remove the run directory.
 */
export class RegistrySchemaError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly path: string,
    readonly found: string,
  ) {
    super(
      `${path} is stamped ${JSON.stringify(found)}, and this build reads ` +
        `${JSON.stringify(REGISTRY_SCHEMA)}. The file was written by a different build of pifleet, ` +
        `so nothing here can vouch for what its fields mean; refusing to read it rather than ` +
        `guessing. Stop this run with the build that wrote it, or remove the run directory ` +
        `${JSON.stringify(path)} if the run is over.`,
    );
    this.name = "RegistrySchemaError";
  }
}

/**
 * `registry.json` is present and cannot be read — and the stamp is NOT why.
 *
 * A SECOND ERROR RATHER THAN A DETAIL FIELD ON THE FIRST, because the two
 * diagnoses send an operator to different places. "Written by another build"
 * says there IS a build that understands this file and names the two ways back
 * to it. "Corrupt" says there is not: bad JSON, or valid JSON whose shape this
 * build's own stamp promised and did not deliver. Collapsing them would make
 * the message advise finding a build for a file no build ever wrote.
 *
 * Covers three inputs, all of which reached callers as raw library errors
 * before this existed — measured on this machine, matching what ISC-192
 * recorded: a truncated file threw a bare `SyntaxError`
 * ("JSON Parse error: Unexpected EOF"), and valid JSON of the wrong shape
 * threw a bare `ZodError` whose message begins with a lone `[`. Neither
 * carried an `exitCode`, so both left the CLI as a stack trace on exit 1 —
 * not a code on the SRD §10 ladder — from `status`, which is a command an
 * operator reaches for PRECISELY when a run is in a bad state.
 *
 * A registry with NO stamp at all lands here rather than in
 * `RegistrySchemaError`, and that is deliberate. Every write in this tree goes
 * through `RegistrySchema.parse` (see `REGISTRY_SCHEMA`), so no build of
 * pifleet has ever written a stampless registry; a file missing the key is
 * therefore hand-edited or damaged, and there is no build to send the operator
 * back to.
 */
export class RegistryReadError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`unreadable registry file ${path}: ${parseFailureDetail(cause)}`);
    this.name = "RegistryReadError";
  }
}

/**
 * A `ZodError`'s `message` is a pretty-printed JSON array, so its first line is
 * a bare `[` — useless as a diagnosis. Summarise the issues instead; the field
 * path is the whole diagnostic value.
 *
 * DELIBERATE DUPLICATION of the rendering inside `state.ts`'s `StateReadError`.
 * Sharing it means exporting a helper from `state.ts`, which is outside this
 * change's file set; the two errors describe different files and say different
 * things, and only this one rule is common to them. Worth folding together the
 * next time `state.ts` is open — recorded here so it is a known duplicate
 * rather than a rediscovered one.
 */
function parseFailureDetail(cause: unknown): string {
  const issues =
    typeof cause === "object" && cause !== null
      ? (cause as { issues?: Array<{ path: unknown[]; message: string }> }).issues
      : undefined;
  if (Array.isArray(issues)) {
    return issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
  }
  if (cause instanceof Error) return cause.message.split("\n")[0] ?? cause.message;
  return String(cause);
}

/**
 * The stamp a document carries when it is not the one this build reads, or
 * `null` when the stamp is absent, unreadable, or already correct.
 *
 * Reads the RAW parsed document rather than anything schema-validated, which
 * it must: the schema check is exactly what failed, so there is no validated
 * object to ask. Best-effort by construction, and typed to say so.
 */
function foreignStamp(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null) return null;
  const stamp = (doc as { schema?: unknown }).schema;
  if (typeof stamp !== "string" || stamp === REGISTRY_SCHEMA) return null;
  return stamp;
}

/**
 * The run's registry, or `null` when the run has never had one.
 *
 * ABSENT STAYS `null`; UNREADABLE THROWS. The asymmetry is the whole point of
 * this function's contract, and it is not the tidier of the two options — it
 * is the one that keeps two different facts apart.
 *
 * Absence is a REAL and legitimate state rather than a degraded one, and the
 * proof is in this module: `startRegistryDaemon` calls this before it has ever
 * written the file, so `null` is the answer on the very first line of every
 * run's life. It also covers a run directory assembled by hand in a test.
 * Answering it with an empty registry is correct, because an empty registry is
 * what is true.
 *
 * Unreadable is the opposite fact and must never borrow that answer. A file
 * EXISTS, something wrote it, and it names supervisors this process cannot
 * enumerate. `startRegistryDaemon`'s `?? { … workers: {} }` would take a `null`
 * from here and persist a fresh empty registry straight over it, so widening
 * the `null` to cover unreadable would turn a diagnosable file into a silent
 * erasure of every worker the run is actually running — and `down` and
 * `status` read this file to find out what to stop. That is the same
 * conflation `processStartTime` carries below and `StateReadError` was written
 * to remove; it is not repeated here.
 *
 * @throws {RegistrySchemaError} the file is stamped by a build this one does
 *   not read. Its own answer, never a generic parse failure, because "written
 *   by another build" and "corrupt" call for different actions.
 * @throws {RegistryReadError} the file is malformed — bad JSON, or valid JSON
 *   failing the schema for a reason OTHER than the stamp.
 */
export async function readRegistry(run: RunPaths): Promise<Registry | null> {
  const file = Bun.file(run.registryJson);
  if (!(await file.exists())) return null;

  const text = await file.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    // Carry the bytes, for the reason `state.ts`'s reader carries them: this
    // file is written tmp + fsync + rename, so a reader should see either the
    // whole previous file or the whole next one, and "Unexpected EOF" alone
    // says nothing about how that premise came to be wrong.
    throw new RegistryReadError(
      run.registryJson,
      `${String(err)} — ${text.length} bytes on disk, starting ${JSON.stringify(text.slice(0, 120))}`,
    );
  }

  const parsed = RegistrySchema.safeParse(doc);
  if (parsed.success) return parsed.data;

  // The stamp is asked about FIRST, because it is the one failure that names a
  // build. A wrong stamp also makes every other field's complaint meaningless:
  // those fields were described by a schema this build does not own, so
  // reporting `workers.w-1.pgid: expected number` about them would be a
  // sentence about the wrong document.
  const stamp = foreignStamp(doc);
  if (stamp !== null) throw new RegistrySchemaError(run.registryJson, stamp);
  throw new RegistryReadError(run.registryJson, parsed.error);
}

// ---------------------------------------------------------------------------
// JSONL request/response over a unix socket
// ---------------------------------------------------------------------------

export type SocketHandler = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SocketServer {
  stop(): Promise<void>;
}

/**
 * Serve a one-request-one-response JSONL protocol on a unix socket. A stale
 * socket file from a crashed predecessor is unlinked first: `bind` would
 * otherwise fail EADDRINUSE forever, since nothing cleans up after SIGKILL.
 *
 * The per-run secret is REQUIRED and enforced here, in the framing layer,
 * before any handler sees the request (SRD §12.7). Enforcing per verb inside
 * each handler is how `ping` — the verb everyone forgets — becomes an
 * unauthenticated oracle for whether a run exists; a gate at the framing
 * layer covers every verb any handler will ever add. A refusal is a normal
 * response, not a crash and not a hang: the caller gets a structured error
 * and the server keeps serving.
 */
export async function serveJsonlSocket(
  path: string,
  handler: SocketHandler,
  auth: { secret: string },
): Promise<SocketServer> {
  const { mkdir, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  try {
    await unlink(path);
  } catch {
    // Did not exist — the common case.
  }

  const splitters = new WeakMap<object, LineSplitter>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        let splitter = splitters.get(socket);
        if (splitter === undefined) {
          splitter = new LineSplitter();
          splitters.set(socket, splitter);
        }
        for (const line of splitter.push(chunk)) {
          void (async () => {
            let response: Record<string, unknown>;
            try {
              const msg = parseLine<Record<string, unknown>>(line);
              if (msg === undefined) return;
              const refusal = checkAuth(msg, auth.secret);
              if (refusal !== null) {
                response = refusal;
              } else {
                // The token is stripped before the handler runs: no handler
                // can echo it into a response, a ledger record or a log line,
                // which is rule 3 of security/control-auth.ts made structural.
                const { [AUTH_FIELD]: _token, ...verb } = msg;
                response = await handler(verb);
              }
            } catch (err) {
              response = { ok: false, error: String(err) };
            }
            try {
              socket.write(`${JSON.stringify(response)}\n`);
            } catch {
              // Peer went away mid-response; nothing to do.
            }
          })();
        }
      },
      error() {},
    },
  });

  return {
    async stop() {
      server.stop(true);
      try {
        await unlink(path);
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Whether the request provably never reached the listener.
 *
 * `connect_failed` is the only value that lets a caller retry elsewhere: the
 * socket was never opened, so nothing on the other side saw the message. A
 * timeout or a mid-request close says nothing of the sort — the supervisor
 * may have accepted the dispatch, persisted its fence and started the agent,
 * and merely answered late. Callers that treat those as "never happened" run
 * the same task twice.
 */
export type SocketFailure = "connect_failed" | "timeout" | "closed" | "error";

export class SocketRequestError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly failure: SocketFailure = "error",
  ) {
    super(`${message} (${path})`);
    this.name = "SocketRequestError";
  }

  /**
   * True only when the request cannot have been acted on. Everything else is
   * in doubt, and in doubt must never be retried on another worker.
   */
  get neverDelivered(): boolean {
    return this.failure === "connect_failed";
  }
}

/**
 * Send one request, await one response line, close.
 *
 * When `secret` is given it is stamped onto the outgoing message as the
 * `auth` field. Stamping at the transport keeps the token out of every
 * caller-built message — and therefore out of everything callers persist:
 * `dispatch` records its envelope verbatim in the inbox, and a token inside
 * it would be a secret in a ledger-adjacent file.
 */
export async function socketRequest(
  path: string,
  msg: Record<string, unknown>,
  opts: { timeoutMs?: number; secret?: string } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (opts.secret !== undefined) msg = { ...msg, [AUTH_FIELD]: opts.secret };
  const splitter = new LineSplitter();

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new SocketRequestError(path, `no response in ${timeoutMs}ms`, "timeout")));
    }, timeoutMs);

    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(msg)}\n`);
        },
        data(socket, chunk) {
          for (const line of splitter.push(chunk)) {
            const parsed = parseLine<Record<string, unknown>>(line);
            if (parsed === undefined) continue;
            finish(() => resolve(parsed));
            socket.end();
            return;
          }
        },
        close() {
          finish(() => reject(new SocketRequestError(path, "closed before responding", "closed")));
        },
        error(_socket, err) {
          finish(() => reject(new SocketRequestError(path, String(err), "error")));
        },
        connectError(_socket, err) {
          finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`, "connect_failed")));
        },
      },
    }).catch((err) => {
      finish(() => reject(new SocketRequestError(path, `connect failed: ${String(err)}`, "connect_failed")));
    });
  });
}

// ---------------------------------------------------------------------------
// The daemon: single writer of registry.json
// ---------------------------------------------------------------------------

export interface RegistryDaemon {
  stop(): Promise<void>;
  /**
   * One reaper scan (ISC-236). The interval calls this; tests call it directly
   * so a reap can be driven deterministically rather than waited for — a test
   * that races a timer is the anti-pattern this whole suite avoids.
   */
  reapOnce(): Promise<ReapReport[]>;
}

/**
 * Reaper wiring for the daemon (SRD §13.1, F31).
 *
 * The reaper module scans and kills; it deliberately does not deregister,
 * because `registry.json` has a single writer and that writer is here. So the
 * loop lives in the daemon: `reapStale` returns what it reaped, and the daemon
 * removes exactly those entries through the same serialized chain every other
 * mutation uses. A second write path to registry.json would reintroduce the
 * lost-update race the chain exists to prevent.
 */
export interface ReaperConfig {
  /** `run.heartbeat_interval`, in ms. Staleness is 3× this (§13.1). */
  heartbeatIntervalMs: number;
  /** Scan period. Defaults to the heartbeat interval. */
  scanIntervalMs?: number;
  ops?: ReaperOps;
  /** Overridable so tests need no real state files on disk. */
  readState?: (worker: string) => Promise<WorkerState | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  termGraceMs?: number;
  killGraceMs?: number;
  /**
   * Observability hook — the CLI writes these to the ledger.
   *
   * Called with EVERY reap attempted, including the ones that refused to stop
   * anything. A refusal is the fact an operator most needs to see: a live
   * supervisor that nothing in this run can prove it owns. Filtering those out
   * to keep the ledger tidy would hide exactly the case that needs a human.
   */
  onReap?: (reports: ReapReport[]) => void;
}

/**
 * Whether a reap report authorises removing the worker from the registry.
 *
 * DEREGISTRATION IS A CLAIM, not bookkeeping. `registry.json` is what `status`
 * and `down` read to find out what this run is running; deleting an entry
 * asserts there is no longer a supervisor behind that name. For an outcome that
 * means the supervisor is ALIVE — `group_unconfirmed`, `unconfirmed` — that
 * assertion is false, and it is false in the direction that loses things: the
 * worker becomes invisible to `down`, so nothing ever stops it, and invisible
 * to the reaper's next scan, so nothing ever tries again. It keeps its
 * container, its worktree and its token spend, and no process on the host names
 * it any more.
 *
 * A SECOND EXHAUSTIVE SWITCH, deliberately not a shared predicate with
 * `reaper.ts`'s `supervisorStopped`. The two answers agree today, and they are
 * still two different questions — "may this container be destroyed" and "may
 * this name be forgotten". An eighth `KillOutcome` has to be answered for both,
 * by someone looking at both, and a shared helper would answer the second one
 * silently from a decision made about the first. The `never`-typed default is
 * what forces that: the root cause of the defect this fixes was that adding a
 * union member is invisible to `tsc` for a consumer that only stores the value.
 */
function deregisterOnReap(outcome: KillOutcome): boolean {
  switch (outcome) {
    case "aborted":
    case "terminated":
    case "killed":
    case "already_gone":
      return true;
    case "unconfirmed":
    case "group_unconfirmed":
    case "identity_unconfirmed":
      return false;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled KillOutcome: ${String(unhandled)}`);
    }
  }
}

/**
 * Start the registry daemon in-process. Verbs are deliberately few: the
 * registry is thin by design (SRD §3.3) — it holds no RPC stream and owns no
 * container, so one crash cannot take the fleet.
 */
export async function startRegistryDaemon(
  run: RunPaths,
  opts: { onShutdown?: () => void; reaper?: ReaperConfig } = {},
): Promise<RegistryDaemon> {
  const started = (await processStartTime(process.pid)) ?? "";
  let registry: Registry = (await readRegistry(run)) ?? {
    schema: REGISTRY_SCHEMA,
    run_id: run.runId,
    daemon: { pid: process.pid, started },
    workers: {},
  };
  registry = { ...registry, daemon: { pid: process.pid, started } };

  /**
   * Registry writes are serialized through one chain.
   *
   * Each socket line is handled in its own detached async task, so N
   * supervisors registering during `up` land in one tick and interleave
   * read-modify-write on a shared object. Unique temp names stop the file from
   * TEARING, but not from losing an update: two handlers can both snapshot
   * `registry`, and the second write erases the first worker. The supervisor
   * already serializes its own state and fence writes for exactly this reason;
   * the daemon did not, and a lost registration silently downgrades liveness
   * detection to the pid-only path.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const persist = () =>
    serialized(() => writeJsonAtomic(run.registryJson, RegistrySchema.parse(registry)));

  await persist();
  await writeJsonAtomic(run.daemonPid, { pid: process.pid, started });

  let server: SocketServer | null = null;
  let onShutdown: (() => void) | null = null;

  // The run's control secret (SRD §12.7). `up` mints it before launching
  // anything, so this normally reads; the mint path exists for a daemon
  // started directly against a bare run directory (tests, debugging) and is
  // exclusive-create, so racing components converge on one value.
  const controlAuth = await ensureControlAuth(run);

  server = await serveJsonlSocket(run.daemonSock, async (msg) => {
    switch (msg["cmd"]) {
      case "ping":
        return { ok: true, pid: process.pid };
      case "register_worker": {
        const worker = RegistryWorkerSchema.parse(msg["entry"]);
        registry = {
          ...registry,
          workers: { ...registry.workers, [worker.worker]: worker },
        };
        await persist();
        return { ok: true };
      }
      case "deregister_worker": {
        const name = z.string().parse(msg["worker"]);
        const workers = { ...registry.workers };
        delete workers[name];
        registry = { ...registry, workers };
        await persist();
        return { ok: true };
      }
      case "get_registry":
        return { ok: true, registry };
      case "shutdown":
        queueMicrotask(() => onShutdown?.());
        return { ok: true };
      default:
        return { ok: false, error: `unknown cmd: ${String(msg["cmd"])}` };
    }
  }, { secret: controlAuth.secret });

  // -------------------------------------------------------------------------
  // Reaper loop (ISC-236)
  // -------------------------------------------------------------------------

  const monitor = new HeartbeatMonitor(opts.reaper?.now);
  const readState =
    opts.reaper?.readState ??
    ((worker: string) => readWorkerState(workerPaths(run, worker)));

  /**
   * A scan takes a SNAPSHOT of the worker set and reaps against it. Reaping is
   * slow — a kill ladder waits out two grace periods — and registrations land
   * during it, so the reports are applied by NAME against whatever the
   * registry holds at write time rather than by overwriting the snapshot. A
   * worker that registered mid-scan must not be erased by a scan that started
   * before it existed.
   *
   * Only the reports that PROVE the supervisor is gone remove anything;
   * `deregisterOnReap` says why. The rest are still announced, because a
   * refusal is a fact the ledger needs.
   */
  const reapOnce = async (): Promise<ReapReport[]> => {
    const cfg = opts.reaper;
    if (cfg === undefined) return [];
    const reports = await reapStale({
      registry,
      readState,
      monitor,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
      ops: cfg.ops,
      termGraceMs: cfg.termGraceMs,
      killGraceMs: cfg.killGraceMs,
      now: cfg.now,
      sleep: cfg.sleep,
    });
    const gone = reports.filter((r) => deregisterOnReap(r.supervisor));
    if (gone.length > 0) {
      await serialized(async () => {
        const workers = { ...registry.workers };
        for (const r of gone) delete workers[r.worker];
        registry = { ...registry, workers };
        await writeJsonAtomic(run.registryJson, RegistrySchema.parse(registry));
      });
    }
    if (reports.length > 0) cfg.onReap?.(reports);
    return reports;
  };

  let scanning = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.reaper !== undefined) {
    const period = opts.reaper.scanIntervalMs ?? opts.reaper.heartbeatIntervalMs;
    timer = setInterval(() => {
      // A scan outlasting its period must not stack: the ladder's grace
      // periods are seconds long, and overlapping scans would aim two kill
      // ladders at one pid — the second at whatever inherits it.
      if (scanning) return;
      scanning = true;
      void reapOnce()
        .catch((err: unknown) => {
          /*
           * A failed scan is not fatal to the daemon; the next one retries.
           * It must not be SILENT, though, and that distinction is newer than
           * this catch. A scan aborts mid-iteration, so the whole `reports`
           * array is discarded: workers already reaped in that pass get no
           * ledger record and no deregistration, while their staleness clocks
           * have already been dropped. If the cause is persistent — an
           * unreadable `ps`, a missing procps — every subsequent scan dies the
           * same way and reaping is disabled for the entire fleet with nothing
           * anywhere saying so.
           */
          process.stderr.write(`reaper: scan aborted, retrying next period: ${String(err)}\n`);
        })
        .finally(() => {
          scanning = false;
        });
    }, period);
    // The socket server already holds the loop open; the reaper must not be
    // the reason a daemon refuses to exit.
    timer.unref?.();
  }

  const daemon: RegistryDaemon = {
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await server?.stop();
      server = null;
    },
    reapOnce,
  };
  onShutdown = () => {
    void daemon.stop().then(() => opts.onShutdown?.());
  };
  return daemon;
}

/**
 * Client-side call to the daemon; tolerant of an absent daemon when asked.
 *
 * The run's secret is loaded from the run directory on every call and stamped
 * by the transport. A run with no auth record is as unreachable as one with
 * no daemon — under `optional` both degrade to null, because a best-effort
 * caller (supervisor registration) must not crash over either.
 */
export async function registryCall(
  run: RunPaths,
  msg: Record<string, unknown>,
  opts: { optional?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  try {
    const secret = await loadControlSecret(run);
    return await socketRequest(run.daemonSock, msg, { secret });
  } catch (err) {
    if (opts.optional) return null;
    throw err;
  }
}
