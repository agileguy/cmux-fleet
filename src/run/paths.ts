/**
 * Every run-directory path is computed here and nowhere else.
 *
 * The run dir is the durable record of a run: state files, ledgers, envelopes,
 * transcripts. Two rules shape this module:
 *
 * 1. **One source of truth.** A path computed in two places will eventually be
 *    computed differently in two places, and the supervisor and CLI would then
 *    read different files while believing they share state.
 *
 * 2. **Control sockets do not live in the run dir.** `sun_path` is capped at
 *    ~104 bytes on macOS. The runs root is configurable (`PIFLEET_RUNS_DIR`)
 *    and test scratch directories routinely exceed 100 characters on their
 *    own, so a socket at `<run-dir>/workers/<id>/control.sock` would fail to
 *    bind in exactly the environment the acceptance suite runs in. Sockets are
 *    therefore placed under `os.tmpdir()` with a hashed name that both the
 *    supervisor and the CLI can derive from `(run_id, worker)`.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bindMountSources } from "../container/docker-argv.ts";
import { EXIT } from "../contracts.ts";

/**
 * Root under which every run directory lives.
 *
 * The configured value is CANONICALIZED, never returned as authored.
 * `PIFLEET_RUNS_DIR` is operator input and every path below is derived from
 * it, ending up as the source half of `docker run -v` flags — and Docker does
 * not reject a relative source there. A `-v` source with no leading `/` is a
 * NAMED VOLUME, so an unresolved root gets the worker a fresh empty volume
 * where the run directory should be: `harvest` then reads an empty `/outbox`
 * and reports a task that produced artifacts as having produced none. Nothing
 * throws, which puts it in the same class as the divergence this module's
 * first rule exists to prevent.
 *
 * A leading `~` is expanded for the same reason and one more: nothing but a
 * shell expands it, so `~/runs` works when typed at a prompt and fails when
 * set from a launcher, a config file, or the detached daemon's env — which
 * are the three ways this variable is actually set. Expansion follows
 * `expandPath` in `config/load.ts`, the convention every other path in this
 * codebase already uses; a relative value resolves against the cwd, because
 * unlike a config path there is no document for it to be relative TO.
 *
 * Resolving HERE rather than at the call sites is what makes it hold: `up`
 * hands this exact string to the detached daemon as its `PIFLEET_RUNS_DIR`
 * and to each supervisor as `--runs-root`, and a relative value would
 * otherwise re-resolve against whatever cwd those inherit — a second answer
 * to the question this module exists to make singular.
 */
export function runsRoot(env: Record<string, string | undefined> = process.env): string {
  return rootFromEnv(env["PIFLEET_RUNS_DIR"], () => join(homedir(), ".pifleet", "runs"));
}

/**
 * Where per-role skill bundles are COPIED FROM (SRD §5.4).
 *
 * There is no config field for this and there should not be: a skill name in
 * `skills:` is a bundle NAME, and `--skill /skills/<name>` hard-codes the
 * container half, so the host half must be equally fixed. Resolved from this
 * module's own location so it survives being run from any cwd, exactly as
 * `up.ts`'s `CLI_ENTRY` does with `import.meta.dir` — `src/run/` is two levels
 * below the repo root, where `skills/` lives beside `src/`.
 *
 * `PIFLEET_SKILLS_DIR` overrides it — the packaging and test seam, the same
 * shape as `PIFLEET_RUNS_DIR` and `PIFLEET_SCRATCH_DIR`, and the only way a
 * test can plant a hostile bundle (a symlink, a missing name) without writing
 * into the repository's real `skills/`.
 */
export function skillsSourceRoot(env: Record<string, string | undefined> = process.env): string {
  return rootFromEnv(env["PIFLEET_SKILLS_DIR"], () =>
    resolve(import.meta.dir, "..", "..", "skills"),
  );
}

/**
 * The expansion every root-valued environment variable in this module gets.
 *
 * Factored out rather than copied because a second spelling of these four
 * lines is a second answer to what `~/x` and `./x` mean here, which is the
 * divergence this module's first rule exists to prevent. `fallback` is lazy so
 * each caller keeps its own default without computing it on the override path.
 */
function rootFromEnv(configured: string | undefined, fallback: () => string): string {
  // An exported-but-cleared variable arrives as "", which `??` passed
  // through; `join("", runId)` is then relative, i.e. the named-volume case
  // with nothing in the path to suggest a variable was ever set.
  if (configured === undefined || configured === "") return fallback();
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

/**
 * Run ids sort lexically because they begin with a UTC timestamp; `latestRunId`
 * depends on that property, so the format is fixed here.
 */
export function newRunId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const suffix = createHash("sha256")
    .update(`${now.getTime()}-${process.pid}-${Math.random()}`)
    .digest("hex")
    .slice(0, 4);
  return `${ts}-${suffix}`;
}

export interface RunPaths {
  runId: string;
  root: string;
  runJson: string;
  registryJson: string;
  /** Per-run control-socket secret (SRD §12.7), mode 0600. Never mounted. */
  controlAuthJson: string;
  daemonPid: string;
  daemonLog: string;
  daemonSock: string;
  ledgerDir: string;
  /**
   * Host-collected copies of the per-worker verbgate ledgers (ISC-172).
   *
   * A SIBLING of `ledgerDir`, emphatically not a shard inside it. The two hold
   * different things: `ledgerDir` holds pifleet's own ledger shards, every row
   * of which `mergeLedger` parses with `LedgerRecordSchema`, and Phase G just
   * pinned the behaviour that a malformed record lands in `errors`. Verbgate
   * rows have an entirely different shape, so filing them as a shard would
   * generate one merge error per gated verb the fleet ever ran — a working
   * audit trail expressed as a permanent stream of parse failures.
   *
   * Under the run dir and named in NO mount, which is the whole point: a
   * worker's writable reach into the run dir is `<run>/outbox/<id>` and
   * `<run>/sessions`, and this is neither. Note what does and does not hold
   * that up. `assertNoRunDirMount` refuses a mount that IS or CONTAINS the run
   * dir, so nothing can reach this by mounting an ancestor — but it
   * deliberately does not flag paths UNDER the run dir, because the entire
   * §5.5 mount table lives there. So the guarantee for this directory is that
   * the mount table does not name it, which is an ABSENCE, and an absence has
   * to be re-checked rather than assumed: `test/unit/render.test.ts` asserts it
   * against the argv `renderWorker` actually produces.
   */
  auditDir: string;
  inboxDir: string;
  sessionsDir: string;
  workersDir: string;
  /**
   * The scheduler's snapshot of the task graph (`ScheduledTask[]`).
   *
   * Named here rather than in either subsystem because two of them meet on
   * it: `dispatch --auto` writes it and `report` reads it. It was NOT in the
   * seam originally, and within one dispatch the two halves had diverged --
   * the reporter had invented a path and a tolerant parser for a file the
   * scheduler never wrote. That is the exact failure a shared seam exists to
   * prevent, and a path is as much a contract as a schema.
   *
   * Absence is normal: a run driven by manual `dispatch` calls has no
   * schedule, and `report` must still describe it.
   */
  scheduleJson: string;
  /**
   * The run's budget accounting (`BudgetState`), written by the scheduler.
   *
   * Named here for the same reason `scheduleJson` is: two subsystems meet on
   * it. `dispatch --auto` writes it on every admission and settle, and `wait`
   * reads it to fold `budgetExitCode` into its own ladder — so a
   * dispatch-then-wait pipeline reports the same integer as `--auto` did. The
   * module `budget.ts` described this file in a comment for an entire phase
   * while nothing created it and no path named it, which is exactly how the
   * reporter and the scheduler once ended up with two spellings of
   * `schedule.json`.
   *
   * A control-plane file like every other member here: it lives under the run
   * dir, beside `control-auth.json`, and is NEVER mounted into a container.
   * Nothing a worker can read needs the fleet's spend.
   *
   * What holds that up TODAY is an absence, and it is worth naming as one
   * rather than as a guard: no mount spec in `container/mounts.ts` names the
   * run dir, so nothing puts this file in front of a worker. That is a
   * property of the current mount set, not an assertion anything enforces —
   * `grep -rn assertNoRunDirMount src/` finds nothing on this branch. An
   * earlier draft of this comment cited "the run-dir exposure rules" as
   * though they existed here; they do not, they arrive with the run-dir
   * exposure work, and a docstring citing a guard its own tree does not
   * contain is exactly the defect the sibling review round exists to remove.
   *
   * Absence is normal and means the same thing `scheduleJson`'s does: no
   * scheduled run has happened yet.
   */
  budgetJson: string;
}

export function runPaths(runId: string, root: string = runsRoot()): RunPaths {
  const base = join(root, runId);
  return {
    runId,
    root: base,
    runJson: join(base, "run.json"),
    registryJson: join(base, "registry.json"),
    controlAuthJson: join(base, "control-auth.json"),
    daemonPid: join(base, "daemon.pid"),
    daemonLog: join(base, "daemon.log"),
    daemonSock: socketPath(runId, "@daemon"),
    ledgerDir: join(base, "ledger"),
    auditDir: join(base, "audit"),
    inboxDir: join(base, "inbox"),
    sessionsDir: join(base, "sessions"),
    workersDir: join(base, "workers"),
    scheduleJson: join(base, "schedule.json"),
    budgetJson: join(base, "budget.json"),
  };
}

export interface WorkerPaths {
  workerId: string;
  dir: string;
  stateJson: string;
  /**
   * Epoch fence (`ack_seq`, `last_seq`, high-water-mark, attempt dedup).
   * A sibling of `state.json` rather than a field inside it: the state schema
   * is the shared seam and the fence must be writable durably BEFORE a
   * dispatch without rewriting unrelated state.
   */
  fenceJson: string;
  presentationJson: string;
  eventsJsonl: string;
  supervisorLog: string;
  controlSock: string;
  tasksDir: string;
  /**
   * The attended record (`AttendedRecord`), written when a pane is handed to
   * a person and never removed afterwards.
   *
   * Beside state rather than inside it, like presentation: whether a human
   * typed into a pane is a fact ABOUT the run, and losing the pane must not
   * lose it. Named here because `steer`/`tui` write it and `report` reads it
   * — the last phase put a path in two places and the halves diverged
   * within a single dispatch.
   */
  attendedJson: string;
  /**
   * Append-only log of `CredentialInjection` records — every token this
   * worker was given, in order (ISC-248).
   *
   * A JSONL sibling rather than a field in `state.json` because the interesting
   * fact is the SEQUENCE: `state.credential` says what is true now, and one
   * value cannot distinguish "the initial injection worked" from "the refresh
   * loop has been running for six hours". Generation 1 appearing here is the
   * only durable evidence that the loop RE-INJECTED rather than merely having
   * been constructed, which is the half of the criterion no unit test reaches.
   *
   * Safe to keep: `CredentialInjection` has no token field by construction —
   * `recordInjection` takes the token's LABELS and never its value.
   */
  credentialsJsonl: string;
  /**
   * The four per-worker container INPUTS (SRD §5.5): the `--env-file`, the
   * concatenated briefing, the verbgate policy, and the filtered kubeconfig.
   *
   * Named here rather than joined at the mount site because `config/render.ts`
   * built all four from its own separately-computed run-dir string, which was
   * not the one `up` uses — so `render`, the command whose entire purpose is to
   * say what `up` will do, described four mounts at paths no run would ever
   * contain (ISC-188). Nothing writes these files yet; naming them now is what
   * stops the eventual writer from inventing a fifth spelling. `run/materialize.ts`
   * is now that writer for all four.
   */
  envFile: string;
  systemAppendMd: string;
  cloudAllow: string;
  /** Per-dispatch task provenance for the verbgate ledger (ISC-362). */
  taskPolicy: string;
  kubeconfig: string;
  /**
   * The per-worker secret store: one file per granted `secrets:` name, holding
   * that name's raw host value, bind-mounted read-only at `SECRETS_MOUNT`.
   *
   * A FIFTH container input, and a DIRECTORY rather than a fifth exact-path
   * file mount, because the set is per-worker and open-ended — `secrets:` is a
   * config list, so the mount cannot be a fixed name the way `cloud-allow` and
   * `kubeconfig` are.
   *
   * Named here for the reason the four above are (ISC-188): `config/render.ts`
   * emits the `-v` and `run/materialize.ts` writes the files, and a bind mount
   * whose two sides disagree does not fail — Docker creates the missing source
   * and the worker comes up with an empty `/secrets`, which is the quiet
   * failure this whole delivery change exists to remove rather than relocate.
   *
   * A SIBLING of `env`, not a child of anything else: the run directory is
   * where this worker's inputs live, and the secret store is an input. It is
   * `materialize.ts` that tightens `dir` to 0700 once this exists — see the
   * note there on why the container is unaffected by that.
   */
  secretsDir: string;
  /**
   * The LAUNCH RECORD: the exact `docker run` argv this worker's container is
   * started from, plus the container name and image (`WorkerLaunchSchema`).
   *
   * Written by `materializeWorkerInputs`, which is the one place that already
   * calls `renderWorker` on the `up` path — so the argv that launches is the
   * SAME object that was rendered, not a second rendering that has to agree
   * with the first. That is ISC-188's rule applied one layer up: the previous
   * failure was two `join()`s computing a run dir independently, and a
   * supervisor that re-rendered from config would be the identical shape with
   * a wider blast radius, because config resolution depends on cwd and env
   * that a detached supervisor does not share with the CLI that launched it.
   *
   * Absent for a run started against the `PIFLEET_PI_COMMAND` double, and that
   * absence IS the discriminator the supervisor branches on — see
   * `supervisor/index.ts`.
   */
  launchJson: string;
  /**
   * Where a live worker's `export_html` renders land before the CLI claims one
   * (ISC-276).
   *
   * **This directory IS the permitted set.** The criterion is that a path
   * accepted over the control socket cannot direct a worker's write outside a
   * defined permitted set, and the way it is met is that the caller's string
   * stops being a destination at all: the supervisor derives Pi's target from
   * `exportsDir` and a fresh UUID, so containment is a property of the
   * CONSTRUCTION rather than of a validator that has to be right about every
   * traversal, symlink and encoding a caller might spell. There is no input to
   * get wrong because there is no input.
   *
   * WHY IT IS NAMED HERE rather than joined at the one call site that writes
   * it. Two subsystems now meet on it — `supervisor/index.ts` renders into it,
   * and `test/integration/supervisor.test.ts` has to look INSIDE it to prove
   * an abandoned render landed here and not beside the operator's file. A path
   * a probe computes independently of the code it probes is the divergence
   * this module's first rule exists to prevent, and it fails in the direction
   * that matters least visibly: the probe would look in the wrong empty
   * directory and pass.
   *
   * A control-plane directory like `auditDir` and `budgetJson`, and it holds
   * up for the same reason theirs do — an ABSENCE, stated as one rather than
   * dressed up as a guard. No mount spec in `container/mounts.ts` names the
   * worker directory or anything under it except the four §5.5 container
   * inputs, which are file mounts by exact path. So a containerised worker
   * cannot read its own staged exports, let alone another worker's, and
   * `assertNoRunDirMount` refuses any mount that IS or CONTAINS the run dir.
   * That is a property of today's mount set; `test/unit/render.test.ts`
   * re-checks it against the argv `renderWorker` actually produces.
   *
   * Absence is normal and means only that this worker has never been asked to
   * export. `sweepStagedExport` in the supervisor reaps what it leaves behind.
   */
  exportsDir: string;
}

export function workerPaths(run: RunPaths, workerId: string): WorkerPaths {
  const dir = join(run.workersDir, workerId);
  return {
    workerId,
    dir,
    stateJson: join(dir, "state.json"),
    fenceJson: join(dir, "fence.json"),
    presentationJson: join(dir, "presentation.json"),
    eventsJsonl: join(dir, "events.jsonl"),
    supervisorLog: join(dir, "supervisor.log"),
    controlSock: socketPath(run.runId, workerId),
    tasksDir: join(dir, "tasks"),
    attendedJson: join(dir, "attended.json"),
    credentialsJsonl: join(dir, "credentials.jsonl"),
    envFile: join(dir, "env"),
    systemAppendMd: join(dir, "system-append.md"),
    cloudAllow: join(dir, "cloud-allow"),
    taskPolicy: join(dir, "task-policy"),
    kubeconfig: join(dir, "kubeconfig"),
    secretsDir: join(dir, "secrets"),
    launchJson: join(dir, "launch.json"),
    exportsDir: join(dir, "exports"),
  };
}

/**
 * Is `candidate` a path INSIDE the run tree rooted at `runRoot`? (ISC-276)
 *
 * The second half of the export containment, and deliberately the SMALLER
 * half. What actually keeps Pi's writes in the run directory is that the
 * supervisor builds its target from `exportsDir` and a UUID and never from a
 * caller's string — this predicate cannot be the guarantee, because a
 * predicate over a hostile string is exactly the thing that has to be right
 * about `..`, about a trailing slash, about NFC/NFD, about a symlinked
 * component, and about whatever the next decade's filesystem adds. Getting a
 * path validator wrong is the normal outcome; building the path yourself is
 * not.
 *
 * So this exists to FAIL CLOSED on a derivation that stopped being safe — a
 * future edit that reintroduces caller influence into the staging path, which
 * is precisely how ISC-276 arose the first time (a `path` validated as a
 * non-empty string and then interpolated). It is asserted on every export, on
 * a path that by construction always passes, so the day it starts failing is
 * the day something upstream changed and the export refuses instead of
 * writing.
 *
 * LEXICAL, NOT `realpath`. Both arguments are `resolve`d and compared as
 * prefixes; no symlink is followed. That is honest about what it can and
 * cannot see: because `candidate` is derived from `runRoot` itself, the two
 * share their entire prefix and a lexical answer is EXACT for the intended
 * use. It would not be exact for a directory inside the run tree that had been
 * replaced by a symlink pointing out — and that case is out of scope here for
 * the same reason `auditDir`'s comment gives: reaching it requires write
 * access to a directory no mount exposes. A `realpath` check would also be
 * TOCTOU against exactly the adversary who could arrange it, so it would buy
 * the appearance of a guarantee rather than one.
 */
export function isInsideRunTree(runRoot: string, candidate: string): boolean {
  const root = resolve(runRoot);
  const rel = relative(root, resolve(candidate));
  // `""` is the root itself, which is not INSIDE it. A leading `..` segment
  // escapes; an absolute result means the two share no root at all (different
  // drives on Windows, and the shape `relative` uses when it cannot express
  // the hop).
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Host directory mounted at `/outbox` for a worker (SRD §5.5).
 *
 * Both ends of the outbox contract need this path and they sit in different
 * subsystems: `config/render.ts` builds the `-v` mount that creates it, and
 * `harvest/` reads what the worker left behind in it. It was computed
 * independently in each — the exact hazard this module's first rule exists to
 * prevent, and a worse one than usual, because a divergence here does not
 * throw. Harvest would simply find an empty directory and report a task that
 * produced artifacts as having produced none (ISC-231).
 *
 * Takes the run ROOT rather than `RunPaths`: render works from a run-dir
 * string it is handed, and requiring the full struct there would have kept the
 * duplicate alive purely as a type accommodation.
 */
export function workerOutboxDir(runRoot: string, workerId: string): string {
  return join(runRoot, "outbox", workerId);
}

/**
 * Host directory mounted read-only at `/skills` (SRD §5.5).
 *
 * Keyed by ROLE, not worker: one host directory is shared by every worker of a
 * role. `skills:` is per-worker overridable, so those workers do NOT
 * necessarily load the same set — `run/materialize.ts` fills this directory
 * with the UNION of their lists and each worker's own `--skill` flags select
 * from it. The directory is therefore a superset of what any one worker asked
 * for; see `materializeRoleSkills` for why that is deliberate. Takes the run
 * root as a string for the same reason `workerOutboxDir` does.
 */
export function roleSkillsDir(runRoot: string, role: string): string {
  return join(runRoot, "skills", role);
}

/**
 * The container `--name` for a worker (SRD §5.6).
 *
 * Lives here, with the other path-shaped identities, because four subsystems
 * now need it and they are in different trees: `config/render.ts` puts it on
 * the argv, `run/materialize.ts` records it in the launch record,
 * `attended/mode.ts` builds the `docker exec` a person gets, and
 * `cli/commands/down.ts` removes it. Three of those four spelled it as their
 * own template literal — agreeing today, and one rename away from a `down`
 * that cleans up a container nobody launched. Same rule as `workerWorktree`:
 * the name has one definition, so disagreement is a compile error rather than
 * an orphaned container.
 */
export function workerContainerName(runId: string, workerId: string): string {
  return `pifleet-${runId}-${workerId}`;
}

/**
 * The per-worker code checkout mounted rw at `/workspace` (SRD §5.5, §9.1).
 *
 * Named here for the reason this module exists at all: `config/render.ts`
 * open-coded the `-v` source and `run/worktree.ts` is the thing that has to
 * CREATE that directory. Two `join()` calls agreeing today is not the same
 * property as one function, and a divergence here has the shape ISC-188 and
 * ISC-231 both had: Docker creates a missing bind-mount source rather than
 * refusing, so a worker pointed at a path nothing populated gets an empty
 * `/workspace` and reports as an agent that changed nothing rather than as a
 * mount fault.
 *
 * ## It lives under the RUN DIR, not beside the operator's checkout (ISC-298)
 *
 * This took the run root as of 2026-08-25. It previously took the REPO root
 * and returned `<repo>/.worktrees/<run-id>/<worker>`, and the reason recorded
 * for that placement was: *"git objects must be on the same filesystem the
 * container bind-mounts"*. **That reason was false, and had been since this
 * feature was built.** The mechanism underneath `isolation: worktree` is a
 * `git clone --no-hardlinks` (see `run/worktree.ts`), not a linked worktree —
 * every object is COPIED to a fresh inode, `.git` is a real directory inside
 * the mount, and nothing resolves outside `/workspace`. A clone has no
 * same-filesystem constraint at all; the sentence describes the hardlinking
 * design that module explicitly rejected, and it outlived the design it
 * described. It is recorded here rather than deleted because it is what a
 * reader who reaches for the obvious placement will re-derive.
 *
 * What actually forced the move is ISC-298. On a Linux Docker host a bind
 * mount passes host ownership through untouched, so the container's baked
 * uid 10001 cannot write a checkout owned by the operator: `EACCES` on every
 * `open(O_WRONLY)`, and `fatal: detected dubious ownership` from git, which
 * keys on ownership and ignores mode. macOS squashes bind-mount ownership to
 * the container user, which is why this was invisible for the whole life of
 * the project and arrived the first time the chain ran on `ubuntu-latest`.
 * The fix needs the mounted tree to be WIDENED, and widening it in place
 * would mean chmodding directories inside the operator's own repository.
 * Under the run root the same widening lands on a directory pifleet created
 * and owns — see `prepareWorktreePermissions` in `run/worktree.ts`.
 *
 * **A sibling of `<run>/outbox/<id>`, and allowed by the same rule.**
 * `assertNoRunDirMount` refuses a mount that IS the run dir or CONTAINS it;
 * `classifyRunDirExposure` returns `null` for a source strictly UNDER it,
 * which is what already lets the outbox be mounted. So this placement needs
 * no relaxation of that guard, and it must not get one: `control-auth.json`
 * (mode 0600, the control-socket secret), `ledger/` and `audit/` are siblings
 * of `worktrees/` and stay unmounted and unwidened. The widening is scoped to
 * `<run>/worktrees/<worker>` for exactly that reason — a `chmod -R` one level
 * higher would publish the run secret to every local user on the host.
 *
 * RUN-SCOPED as of ISC-295 (2026-08-24) and still so, now structurally: the
 * run id is a segment of the run root rather than a segment this function
 * appends, so two concurrent runs cannot resolve to one directory and a
 * crashed run's leftovers are removed with its run dir instead of lingering
 * in the operator's repo until someone deletes them by hand.
 */
export function workerWorktree(runRoot: string, workerId: string): string {
  return join(runRoot, "worktrees", workerId);
}

/**
 * The branch a worker commits on (SRD §9.1), honouring `run.branch_prefix`.
 *
 * `branch_prefix` sat in the schema with ZERO readers while
 * `cli/commands/dispatch.ts` hard-coded the literal `fleet/${runId}/${worker}`
 * into every envelope — so an operator who set `branch_prefix: exp` got a
 * config key that validated, documented itself in `fleet.example.yaml`, and
 * changed nothing. That is the same dead-field shape `models_allowlist` and
 * `--keep-panes` were each caught in, and the fix is the same one: a single
 * helper both the creator and the envelope builder call, so there is no second
 * spelling to drift.
 *
 * A name, not a path — but it belongs to this module's rule rather than to
 * either caller's, for exactly the reason the rule is stated in the header: a
 * value derived in two places will eventually be derived differently in two
 * places, and here the two places are the branch git checks out and the branch
 * the envelope tells the worker it is on.
 */
export function workerBranch(branchPrefix: string, runId: string, workerId: string): string {
  return `${branchPrefix}/${runId}/${workerId}`;
}

/** Ledger shards are per writer (SRD §7.7); the shard name is the writer id. */
export function ledgerShard(run: RunPaths, writerId: string): string {
  return join(run.ledgerDir, `${writerId}.jsonl`);
}

/**
 * The verbgate ledger the WORKER writes, as the HOST spells it (ISC-172).
 *
 * `docker/verbgate` writes `/outbox/ledger/verbgate.jsonl` and `/outbox` is
 * the bind mount `render.ts` pushes as `workerOutboxDir(run.root, w.id)`, so
 * this is the same file seen from the other side of the mount.
 *
 * It is derived from `workerOutboxDir` rather than re-joining `outbox/<id>`
 * for the reason that function's own header gives: a path duplicated in two
 * modules eventually diverges in one of them, and a bind-mount disagreement
 * does not throw — it silently produces an empty directory. Here the failure
 * would be quieter still: the collector would tail a path nothing writes and
 * report an empty audit trail for a worker that ran gated verbs all day.
 *
 * ABSENCE IS NORMAL and is not an error at any caller. Nothing on the host
 * creates `<outbox>/ledger/` — only verbgate's own `mkdir -p`, inside the
 * container, on the first gated verb. A worker that has invoked none, or a run
 * whose containers never started, legitimately has no such file.
 */
export function workerVerbgateLedger(runRoot: string, workerId: string): string {
  return join(workerOutboxDir(runRoot, workerId), "ledger", "verbgate.jsonl");
}

/**
 * The host-collected copy of one worker's verbgate ledger (ISC-172).
 *
 * The destination the worker cannot reach — see `RunPaths.auditDir` for why
 * this is a sibling of the ledger directory rather than a shard in it, and for
 * exactly what holds the unreachability up.
 *
 * Per worker, not one merged file: the collector's whole claim is about
 * custody, and two workers appending through one host handle would make each
 * one's trail depend on the other's volume. Sharding by writer is also what
 * `ledgerShard` does one function up, for the same reason (SRD §7.7).
 */
export function verbgateCollectedPath(run: RunPaths, workerId: string): string {
  return join(run.auditDir, `${workerId}.jsonl`);
}

/** Where `dispatch` records the full envelope it sent (SRD §7.1). */
export function inboxTaskPath(run: RunPaths, taskId: string): string {
  return join(run.inboxDir, `${taskId}.json`);
}

/** Terminal per-task record written by the supervisor at settle. */
export function taskRecordPath(worker: WorkerPaths, taskId: string): string {
  return join(worker.tasksDir, `${taskId}.json`);
}

/**
 * How one bind-mount source exposes the RUN DIRECTORY, or `null` (ISC-127).
 *
 * THREE relations, and the asymmetry with `classifyHostGcloudExposure` is the
 * whole content of this function. That one also has three, but a DIFFERENT
 * three, because NOTHING inside the gcloud store may be mounted. Here,
 * everything a worker legitimately gets
 * IS inside THIS run's dir — `<run>/outbox/<id>`, `<run>/sessions`,
 * `<run>/skills/<role>`, `<run>/workers/<id>/cloud-allow`, the briefing, the
 * kubeconfig — so an "inside-the-run-dir" relation would flag the entire §5.5
 * mount table and could only ever be satisfied by weakening it. The criterion
 * says the run DIR is not mounted, and mounting a named child of it is not
 * mounting it.
 *
 * What the two relations actually protect is everything in the run root that
 * is deliberately NOT in that table: `control-auth.json` — the 0600 per-run
 * control-socket secret whose entire threat model (`security/control-auth.ts`)
 * is that a worker cannot read it — plus `registry.json`, `ledger/`, `inbox/`
 * (full task envelopes), `run.json`, and every OTHER worker's `state.json`,
 * `events.jsonl` and outbox. Handing a worker the run root hands it all of
 * that, and hands it the key to the socket that commands its own supervisor.
 *
 * The CONTAINS direction is not hypothetical, and it is the one a mount table
 * built from literals cannot rule out. `run.repo` is operator-settable and is
 * mounted verbatim at `/workspace` under `isolation: shared-ro`; the runs root
 * moves independently via `PIFLEET_RUNS_DIR`. An operator who keeps runs
 * inside the checkout — `run.repo: ~/proj`, `PIFLEET_RUNS_DIR=~/proj/runs`, an
 * ordinary thing to want — mounts the live run directory into the container
 * with no flag anywhere in `render.ts` looking wrong. Measured on this
 * codebase before the guard below existed: the `/workspace` source was an
 * ancestor of `<run>/control-auth.json` and every ISC-127 assertion of the day
 * (there were none) would have stayed green.
 *
 * Comparison is on `resolve()`d paths — lexical, for the reason
 * `classifyHostGcloudExposure` gives: `buildDockerArgv` is synchronous and
 * pure by design and `realpath` is I/O. That closes `..` and trailing-slash
 * spellings and not symlinks. The symlink half is closed one level up, by
 * `assertNoRunDirMountResolved` on `renderWorker`'s async path; see its header
 * for why that gap is routine rather than adversarial.
 *
 * Boundaries use an explicit separator, so a sibling runs root named
 * `<run>-backup` is not flagged for a criterion that says nothing about it.
 * The separator is applied through `isUnder`, which special-cases the
 * filesystem root: `"/"` is the one directory whose children are NOT spelled
 * `${dir}/…`, and a bare `` `${s}/` `` prefix therefore tests `startsWith("//")`
 * and is false for every path in existence. That is how `-v /:/host` — the
 * MAXIMAL violation of this criterion, the entire host filesystem handed to a
 * worker — passed this function as shipped.
 *
 * ## Case, and why the fold is unconditional
 *
 * `resolve()` does not case-fold, so on a case-INSENSITIVE filesystem two
 * spellings of one directory compared unequal and the variant spelling was a
 * bypass. Measured against this function with `runDir = /Users/op/proj/runs/r-1`:
 * `/Users/op/proj/Runs` and `/USERS/OP/PROJ/RUNS/R-1` both returned `null`.
 * Those are the SAME directory on default APFS and Docker Desktop mounts them.
 *
 * The fold is applied on EVERY platform rather than behind
 * `process.platform === "darwin"`, and the reasoning is worth keeping because
 * the per-platform version is the obvious first answer:
 *
 *  1. `process.platform` is a PROXY for a filesystem's case behaviour, not the
 *     truth. APFS can be formatted case-sensitive and Linux routinely mounts
 *     case-insensitive volumes (exFAT, NTFS, a `+F` ext4 directory). A
 *     platform branch is wrong in both directions, just less often — and the
 *     direction it is wrong in on Linux is the one that lets a mount through.
 *  2. The two errors are not symmetric. A false RED is a refusal that names
 *     the offending source and the run dir, which an operator acts on in one
 *     move. A false GREEN hands a worker `control-auth.json` and with it the
 *     key to the socket that commands its own supervisor.
 *  3. The false-red cost that justified the explicit separator does not
 *     transfer. `<run>-backup` is an ordinary directory an operator really
 *     keeps; a case-twin of the runs root — `/data/Runs` beside `/data/runs`,
 *     both live, both distinct — is not an ordinary thing to have.
 *  4. Decisive: a per-platform predicate makes the case-variant TEST
 *     platform-conditional, so it would skip on this project's Linux CI and
 *     the only evidence for the darwin behaviour would be a run on the
 *     maintainer's laptop. This ISA does not count self-skipping evidence
 *     (ISC-266 reaches the same conclusion from the load direction), so the
 *     platform branch buys a marginally tighter predicate at the price of
 *     having no CI-executable proof that it works.
 *
 * The fold is for COMPARISON only. `RunDirMountError` echoes the operator's
 * own spelling, because a refusal that renames their path is a refusal they
 * have to decode.
 *
 * ## The third relation: another run's directory
 *
 * `is-another-run-dir` is the same bug one directory over. The guard is scoped
 * to the CURRENT run, so `<runsRoot>/<otherRunId>` is neither this run dir nor
 * an ancestor of it and passed cleanly — while holding THAT run's
 * `control-auth.json`, ledger, inbox and every worker state. The criterion
 * says the run dir is not mounted; a concurrent run's directory is a run dir.
 *
 * `runsRoot` defaults to `dirname(runDir)`, which is exact rather than a
 * guess: `runPaths` constructs every run root as `join(root, runId)`, so the
 * parent of a run dir IS the runs root by construction.
 */
export type RunDirExposure = "is-the-run-dir" | "contains-the-run-dir" | "is-another-run-dir";

export function classifyRunDirExposure(
  source: string,
  runDir: string,
  runsRoot: string = dirname(resolve(runDir)),
): RunDirExposure | null {
  const dir = resolve(runDir);
  const s = resolve(source);
  const root = resolve(runsRoot);
  if (pathsEqual(s, dir)) return "is-the-run-dir";
  if (isPathUnder(dir, s)) return "contains-the-run-dir";
  if (isPathUnder(s, root) && !isPathUnder(s, dir)) return "is-another-run-dir";
  return null;
}

/**
 * Case-fold for comparison. Not a normaliser: it is never applied to a path
 * that gets reported, stored or passed to the filesystem.
 */
function fold(p: string): string {
  return p.toLowerCase();
}

/**
 * Do these two paths name the same directory? Case-folded; see
 * `classifyRunDirExposure` for why the fold is unconditional.
 *
 * Exported so `classifyHostGcloudExposure` shares ONE definition of the
 * boundary with this module rather than keeping its own copy. Two copies is
 * how the two guards came to disagree: both had the root bug and both had it
 * independently, so neither could catch the other's.
 */
export function pathsEqual(a: string, b: string): boolean {
  return fold(resolve(a)) === fold(resolve(b));
}

/**
 * Is `child` strictly inside `ancestor`, comparing whole path SEGMENTS?
 *
 * The separator is what keeps `<run>-backup` and the `r-1`/`r-10` sibling pair
 * out of the relations. The root special-case is what keeps `/` IN them: `"/"`
 * is the one directory whose children are not spelled `${ancestor}/…`, so the
 * bare `` `${ancestor}/` `` prefix every caller had written tests
 * `startsWith("//")` and is false for every path that exists.
 */
export function isPathUnder(child: string, ancestor: string): boolean {
  const a = resolve(ancestor);
  const prefix = a === "/" ? "/" : `${a}/`;
  return fold(resolve(child)).startsWith(fold(prefix));
}

/** A `docker run` argv that would mount the run directory into a container. */
export class RunDirMountError extends Error {
  /**
   * A misconfigured `run.repo` or `PIFLEET_RUNS_DIR` is a USAGE failure, not a
   * crash — the same grade `ConfigError` carries, and for the same reason.
   *
   * Without it this class satisfies neither branch of `isExitCoded`, so
   * `exitCodeForError` fell through to `EXIT.INTERNAL` and the CLI printed
   * `pifleet: internal error: refusing to launch: …`. That directly defeats
   * the message's own purpose: the text exists so an operator can move the
   * runs root rather than guess, and "internal error" tells them the tool is
   * broken and there is nothing for them to fix. It also mislabels the failure
   * over the only channel a machine caller has, which is the confusion
   * ISC-216 records `EXIT.USAGE`-for-crashes causing in the other direction.
   */
  readonly exitCode = EXIT.USAGE;

  constructor(source: string, runDir: string, relation: RunDirExposure, resolvedAs?: string) {
    const how =
      relation === "is-the-run-dir"
        ? "IS the run directory"
        : relation === "contains-the-run-dir"
          ? "CONTAINS the run directory"
          : "IS ANOTHER RUN's directory under the same runs root as";
    // The operator's own spelling leads, because that is the string they will
    // search their config for. The resolved form is appended only when it
    // DIFFERS — i.e. when a symlink is the reason this is a refusal — because
    // otherwise it is the same path printed twice.
    const via =
      resolvedAs !== undefined && resolvedAs !== source ? ` (resolves to ${resolvedAs})` : "";
    super(
      `refusing to launch: bind-mount source ${source}${via} ${how} (${runDir}) — the run ` +
        `directory holds control-auth.json, the ledger, the inbox and every other ` +
        `worker's state, none of which is a worker's to read — SRD §5.5 / ISC-127`,
    );
    this.name = "RunDirMountError";
  }
}

/**
 * ISC-127 as a RUNTIME GUARD on the argv production actually launches.
 *
 * Deliberately shaped like `assertNoHostGcloudMount`, and for the reason that
 * one records: a predicate with no importer in `src/` closes nothing. It
 * documents an intention that holds exactly as long as someone remembers to
 * keep asserting it, and the offending path here does not come from a literal
 * in `render.ts` at all — it arrives from `run.repo` and `PIFLEET_RUNS_DIR`,
 * two operator-settable values whose relationship no reviewer reading the
 * mount table can see. Checking the FINISHED argv is the only altitude at
 * which that relationship is knowable.
 *
 * Throwing beats returning a flag: a launcher that ignores a returned warning
 * is the same launcher that would have shipped the mount.
 */
export function assertNoRunDirMount(
  argv: readonly string[],
  runDir: string,
  runsRoot?: string,
): void {
  for (const source of bindMountSources(argv)) {
    const relation = classifyRunDirExposure(source, runDir, runsRoot);
    if (relation !== null) throw new RunDirMountError(source, runDir, relation);
  }
}

/**
 * The same criterion with SYMLINKS closed, on the async path (ISC-127).
 *
 * `assertNoRunDirMount` above is lexical because `buildDockerArgv` is
 * synchronous and pure by design. That is a real constraint on THAT function
 * and it is not a constraint on the criterion: `renderWorker` is already
 * `async`, is the only production entry point that produces a worker argv, and
 * `materializeWorkerInputs` awaits it per worker BEFORE creating anything. A
 * `realpath` pre-flight there costs nothing architecturally and closes the one
 * evasion the lexical compare cannot see.
 *
 * ## The gap is routine, not adversarial
 *
 * This is worth stating because "a lexical compare does not close symlinks"
 * reads like a note about an attacker, and the live case is a tidy laptop.
 * Evasion needs `run.repo` and `PIFLEET_RUNS_DIR` spelled through different
 * symlink STATES, which different tools set at different times as a matter of
 * course. The routine instance: `~/repos` is a symlink to `/Volumes/Work/repos`
 * on a Mac with a small internal SSD, `fleet.yaml` says `run.repo: ~/repos/proj`
 * because that is what the operator types, and `PIFLEET_RUNS_DIR` comes from a
 * launcher that ran `pwd -P` and so holds `/Volumes/Work/repos/proj/runs`.
 * Neither value is unusual, neither is hostile, and lexically they share no
 * prefix at all — so the repo mounted at `/workspace` contains the live run
 * directory and the lexical guard reports clean.
 *
 * Both ends are resolved, not just the sources: resolving one side and
 * comparing it against an unresolved other side is the mistake ISC-127's
 * integration half already records, and it reads clean for every relation.
 *
 * Sources and run dirs that do not exist yet are normal here — `renderWorker`
 * runs before `materializeWorkerInputs` creates anything — so `realpathish`
 * resolves the deepest ancestor that DOES exist and re-appends the rest,
 * rather than giving up on `ENOENT` and falling back to the lexical spelling.
 * Giving up is what makes an assertion silently vacuous; the ISA records that
 * exact failure in this criterion's own integration test.
 */
export async function assertNoRunDirMountResolved(
  argv: readonly string[],
  runDir: string,
  runsRoot?: string,
): Promise<void> {
  const dirReal = await realpathish(runDir);
  const rootReal = await realpathish(runsRoot ?? dirname(resolve(runDir)));
  for (const source of bindMountSources(argv)) {
    const sourceReal = await realpathish(source);
    const relation = classifyRunDirExposure(sourceReal, dirReal, rootReal);
    if (relation !== null) throw new RunDirMountError(source, runDir, relation, sourceReal);
  }
}

/**
 * `realpath`, but defined for a path that does not exist yet.
 *
 * Resolves the deepest existing ancestor and re-appends the missing tail, so a
 * run directory under a symlinked root normalises correctly before anything
 * has created it. Plain `realpath(p).catch(() => p)` cannot do that: it
 * returns the UNRESOLVED path, which then compares unequal to every resolved
 * one and turns the comparison into a no-op precisely when a symlink is
 * present — the one condition the resolution existed to handle.
 */
async function realpathish(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    // `dirname("/") === "/"`: the recursion's floor, and the only path that is
    // its own parent.
    if (parent === abs) return abs;
    return join(await realpathish(parent), basename(abs));
  }
}

/**
 * Short, deterministic unix-socket path for a worker's control socket (or the
 * daemon's, keyed `@daemon`). Hashed rather than named so the total path stays
 * far below the 104-byte `sun_path` cap regardless of run id or worker id
 * length; deterministic so the CLI needs no lookup to find a live supervisor.
 */
export function socketPath(runId: string, workerId: string): string {
  const h = createHash("sha256").update(`${runId}\0${workerId}`).digest("hex").slice(0, 16);
  return join(tmpdir(), "pifleet", `${h}.sock`);
}

/**
 * Most recent run id under the root, by the lexical order the id format
 * guarantees. Only entries that actually contain a `run.json` count: the root
 * is a directory users can drop stray files into, and a stray name that sorts
 * after every timestamp would otherwise become "the latest run" and every
 * socket path derived from it would dangle (found by the e2e suite).
 */
export async function latestRunId(root: string = runsRoot()): Promise<string | null> {
  const { readdir, stat } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const runs: string[] = [];
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    try {
      await stat(join(root, e, "run.json"));
      runs.push(e);
    } catch {
      // Not a run directory.
    }
  }
  runs.sort();
  return runs.length > 0 ? runs[runs.length - 1]! : null;
}
