import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type ProcId } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readRunWorktrees, readWorkerState } from "../../run/state.ts";
import { pruneWorkerWorktree, type PruneOutcome } from "../../run/worktree.ts";
import { loadBackend } from "../../backends/registry.ts";
import type { BackendKind } from "../../backends/types.ts";
import {
  IDENTITY_FORMAT,
  isPinnedIdentity,
  processStartTime,
  readRegistry,
  registryCall,
} from "../../run/registry.ts";
import {
  confirmGroup,
  realProcessOps,
  sameIdentity,
  signalIfSame,
  type SignalOutcome,
} from "../../safety/kill.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { Stopwatch } from "../../rpc/client.ts";

const GRACEFUL_WAIT_MS = 5_000;
const TERM_WAIT_MS = 2_000;

/**
 * Register `pifleet down` (SRD §10, §9.3): quiesce, then stop, then verify.
 *
 * Order matters: graceful shutdown over the control socket first (abort →
 * settle → close stdin, §13 F3), the signal ladder only for supervisors that
 * stopped listening. Signals go to the process GROUP — the supervisor is its
 * group's leader, so `-pgid` takes the Pi child with it and leaves no orphan
 * (ISC-72/73).
 *
 * Every rung addresses a `(pid, started)` pair, never a bare pid (ISC-191).
 * This is the one kill path an operator runs BY HAND, which makes it the one
 * where the recorded pid is most likely to be stale: a bare `pifleet down`
 * resolves the LATEST run, and after a reboot the latest run is a dead one
 * whose pids the machine has long since handed out again. `anchorIdentity`
 * below is the gate, and it refuses rather than signalling when the recorded
 * identity is missing, unreadable, or disagrees with the OS.
 *
 * And every rung addresses a `pgid` that was recorded at LAUNCH and CONFIRMED
 * against the OS (ISC-272). It used to pass `state.pgid` straight through —
 * an integer read from a file `down` reads precisely because it may be stale,
 * checked against nothing, and aimed at a whole process group rather than one
 * process. That is a wider blast radius than an unvalidated pid, not a
 * narrower one: `-pgid` reaches every member. `confirmGroup` accepts a group
 * only when the launch record agrees with the OS and the identity-validated
 * supervisor LEADS it, which is what makes the group's identity the leader's
 * identity — already checked — instead of a number nobody can vouch for.
 *
 * MIGRATION POLICY for the pinned identity rendering (ISC-192's territory,
 * decided here rather than discovered by an operator).
 *
 * `registry.ts` now pins `ps` to `TZ=UTC LC_ALL=C` and tags the result
 * `utc1 …`. That CHANGES THE BYTES of every `started` already on disk — not
 * only on a machine whose timezone differed, but on one that was already in
 * UTC, because `LC_ALL=C` also reorders the fields ("Thu Aug 20 …" against
 * "Thu 20 Aug …"). So on the first `down` after this upgrade, every identity
 * recorded by the previous build fails to compare.
 *
 * The policy is TAG, REFUSE, AND NAME THE HATCH:
 *
 *  - Values this build writes carry the `utc1 ` tag, so they are recognisable
 *    as comparable. No locale renders a weekday as `utc1`, so the tag cannot
 *    collide with a legacy value.
 *  - An UNTAGGED recorded value is reported `identity_legacy_format` — its
 *    own answer, distinct from `identity_mismatch`. Reporting it as a
 *    mismatch would assert something false about the world ("a stranger holds
 *    this pid") and would train an operator to reach for the override
 *    reflexively, which is precisely the reflex that must not be trained on
 *    the one flag that re-opens the fail-open.
 *  - `--force-identity` completes such a run using the pre-fix weak anchor.
 *
 * REJECTED: silently auto-upgrading a legacy value by rewriting it from the
 * pid as it reads NOW. That value is derived from the present, not from
 * launch, so it would launder an unverified anchor into a verified-LOOKING
 * one — the fail-open being removed, wearing the fix's clothes. Nothing on
 * disk can convert a legacy rendering into the pinned one, because the legacy
 * string does not record which timezone or locale produced it.
 *
 * REJECTED: accepting a match under either rendering. The legacy value was
 * rendered in the LAUNCHER's environment, and `down` can only re-render in
 * the OPERATOR's, so "try both" does not reconstruct the launcher's string —
 * it just re-admits the ambiguity the pin exists to remove.
 *
 * BLAST RADIUS: a run started before the upgrade and stopped after it. New
 * runs are unaffected; a run started and stopped on one build is unaffected.
 *
 * `--prune` is the second phase, and only ever reached per worker whose
 * supervisor is CONFIRMED dead. `down` deleting a checkout a container is
 * still writing to is the corruption §9.3 names in as many words, and
 * "confirmed dead" here is the same identity comparison the kill ladder above
 * already computed — not a timeout, not an assumption that SIGKILL worked,
 * and not the bare liveness test it used to be, which called a checkout
 * unprunable because SOMETHING held the pid.
 *
 * The flag was DECLARED and unread for a whole phase, with a docstring on this
 * very function saying "Worktree pruning is Phase 2; nothing here deletes
 * data" — the second instance of the dead-flag pattern this file already
 * caught once with `--keep-panes` (see the teardown block below). A documented
 * flag that nothing reads is indistinguishable from a working one until an
 * operator relies on it.
 */
export function register(program: Command): void {
  program
    .command("down")
    .description("Quiesce the run, stop containers and optionally prune worktrees")
    .option("--run <id>", "run id")
    .option("--keep-panes", "leave panes open")
    .option("--prune", "remove worktrees and branches")
    .option("--force", "prune a checkout that still holds work")
    .option(
      "--force-identity",
      "signal a supervisor whose recorded launch identity or process group could not be " +
        "confirmed; the signal goes to that process alone, never to an unconfirmed group",
    )
    .option("--json", "emit machine-readable output")
    .action(async (opts: {
      run?: string;
      json?: boolean;
      keepPanes?: boolean;
      prune?: boolean;
      force?: boolean;
      forceIdentity?: boolean;
    }) => {
      if (opts.force === true && opts.prune !== true) {
        throw new CliError("--force has no meaning without --prune", EXIT.USAGE);
      }
      /**
       * `--force-identity` is deliberately NOT gated on `--prune`, unlike
       * `--force`. It changes what gets SIGNALLED, not what gets deleted, so
       * it has a meaning on its own: an operator whose run predates the
       * pinned identity rendering needs it to stop the run at all.
       */
      const forceIdentity = opts.forceIdentity === true;
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);
      const ledger = new LedgerWriter(run, `cli-down-${process.pid}`);

      /**
       * ONLY `ENOENT` MEANS "NO WORKERS".
       *
       * This `catch` used to be bare, and a bare catch here is a data-loss
       * path rather than a tidy default. `readRunWorktrees` reads `run.json`
       * and is entirely independent of `workersDir`, so `recorded.byWorker`
       * stays FULLY POPULATED when the listing fails. With `workerIds = []`
       * the three consequences compound:
       *
       *  - no supervisor is signalled, because the ladder below iterates
       *    `workerIds`. Every one of them keeps running.
       *  - `report` is `[]`, so `report.every(r => r.stopped)` is VACUOUSLY
       *    TRUE. `clean: true`, exit 0 — `down` reports success over a fleet
       *    it never touched.
       *  - under `--prune`, `workerOutcome` is empty, so `row === undefined`
       *    for every worker in `recorded.byWorker` and each falls straight
       *    through to `pruneWorkerWorktree`. EVERY LIVE WORKER'S CHECKOUT IS
       *    DELETED — the §9.3 corruption reached through a broken measuring
       *    instrument, which is the same failure `group_read_failed` exists
       *    to refuse one channel over.
       *
       * `ENOENT` is the one errno that genuinely means what the old catch
       * assumed: no `workers/` directory was ever created, which is the
       * documented prunable case below (a run that recorded checkouts before
       * any supervisor launched). `EACCES`, `EMFILE`, `ENOTDIR`, `EIO` and
       * their neighbours all describe a directory that EXISTS and could not
       * be read, and the honest answer to those is "unknown", not "empty".
       *
       * The refusal is deliberately not a `throw` here. `down` still has real
       * work it can do without the listing — the daemon rung, the control
       * socket, the ledger — and the SRD's order is quiesce, stop, then
       * VERIFY. What the refusal must guarantee is the verify half: `clean`
       * is false, the prune phase never runs, and the exit code is non-zero.
       * An empty `report` produced by a FAILED listing must never read as
       * clean, exactly as `stopped: false` must survive an anchor refusal.
       */
      let workerIds: string[] = [];
      let listingRefusal: string | null = null;
      try {
        workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        if (code !== "ENOENT") {
          listingRefusal =
            `${run.workersDir} exists but could not be listed (${code}), so 'down' cannot enumerate ` +
            `the supervisors this run launched: none was signalled, none can be shown to have stopped, ` +
            `and the checkouts recorded in run.json must not be deleted on the strength of a listing ` +
            `that failed — fix the directory's readability (permissions, mounts, open-file limits) and ` +
            `run 'down' again`;
        }
      }

      /**
       * The launch-time identities, for the rung-0 anchor below.
       *
       * `register_worker` records `(pid, pgid, started)` per supervisor — its
       * own comment says "identity is (pid, start-time) so pid reuse cannot
       * resurrect us later" — and `readRegistry` reads that off disk without
       * needing the daemon to still be listening, which is exactly the case
       * `down` runs in. A missing or unparseable registry is not an error
       * here: it degrades the anchor, and `anchorIdentity` says what that
       * costs.
       */
      const registry = await readRegistry(run).catch(() => null);

      const report: Array<{ id: string; stopped: boolean; how: string; forced_identity?: true }> = [];
      for (const id of workerIds.sort()) {
        const wp = workerPaths(run, id);
        const state = await readWorkerState(wp);
        if (state === null) {
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }
        const recorded = registry?.workers[id];
        /**
         * TWO launch-time sources, checked in that order, and the second is
         * why a daemon-less run is stoppable at all.
         *
         * Registration is `{ optional: true }` by design — the supervisor's
         * own comment says it "must also work alone (integration tests, daemon
         * crash)" — so `registry.json` is absent for a whole class of ordinary
         * runs. Anchoring only on it made every one of those refuse
         * `identity_unrecorded` and leave its workers running: `down` reported
         * a refusal for a supervisor whose identity was recorded at launch and
         * merely had nowhere daemon-independent to be written down.
         *
         * `state.proc_started` is that place, written by the supervisor from
         * the SAME `processStartTime(process.pid)` reading the registry call
         * carries, so the two agree by construction rather than by luck.
         *
         * This does NOT re-open the fail-open. Both sources hold a pinned
         * `utc1 …` rendering and both are compared by `anchorIdentity`
         * identically; a state file from an older build carries `""`, which
         * `isPinnedIdentity` rejects, so it refuses exactly as an absent
         * registry entry does. The weak `processStartTime(state.pid) !== null`
         * liveness gate this function replaced is not reachable from here.
         */
        const stateAnchor = state.proc_started !== "" ? state.proc_started : null;
        const anchor = await anchorIdentity(
          state.pid,
          // A registry entry for a DIFFERENT pid than `state.json` names is
          // not this supervisor's identity — supervisor relaunched, or one of
          // the two files is stale — so it is not offered as one. It falls
          // through to the state file's own record, and refuses like any other
          // unrecorded worker if that is absent too (ISC-272).
          recorded !== undefined && recorded.pid === state.pid
            ? recorded.started
            : stateAnchor,
          /**
           * The LAUNCH-RECORDED group, handed to the anchor to be confirmed —
           * not to the ladder to be trusted (ISC-272).
           *
           * `state.pgid` is written once by the supervisor about itself, from
           * the same `pgidOf(process.pid)` reading that goes into the registry
           * entry, so the two agree by construction and there is nothing to
           * choose between them. What made it unsafe was never where it came
           * from — it was that no rung ever asked the OS whether it was still
           * true. `anchorIdentity` asks, once, before anything is signalled,
           * and `signalIfSame` asks again at every rung.
           */
          state.pgid,
          { force: forceIdentity },
        );
        /**
         * The container rung, shared by the two paths that are entitled to it.
         *
         * Defined here rather than inline at the bottom because the bottom is
         * not the only exit: a supervisor that is already `gone` `continue`s
         * past it, and that is the case that needs this MOST. A dead
         * supervisor is precisely how a container is orphaned — `--rm` is a
         * client-side action and the client was the supervisor — so skipping
         * cleanup for "nothing to stop" leaves the container running forever
         * with nothing on the host pointing at it.
         */
        const reapContainer = async (): Promise<void> => {
          if (state.container === null) return;
          const removed = await removeContainer(state.container.name);
          await ledger.append("worker_container_removed", {
            worker: id,
            detail: { container: state.container.name, removed },
          });
        };

        // Nothing holds that pid: genuinely gone, nothing to stop — but its
        // container may still be running, which is the orphan case.
        if (anchor.kind === "gone") {
          await reapContainer();
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }
        /**
         * A REFUSAL, reported as one.
         *
         * `stopped: false` is the load-bearing half. It makes the refusal
         * visible in `--json`, non-zero at exit, and — the reason this is a
         * data-loss fix rather than a reporting nicety — it makes the prune
         * gate below refuse the checkout, because that gate acts only on
         * `stopped`. Reported as `stopped: true` (which is what
         * `already_gone` did), a live-but-unverifiable supervisor was classed
         * PRUNABLE and `--prune` deleted the checkout its container was still
         * writing to: the §9.3 corruption, measured end to end.
         */
        /*
         * A refusal deliberately does NOT reap the container either, and the
         * asymmetry with `gone` above is the point. `refused` means the
         * supervisor's identity could not be verified, so it may be ALIVE and
         * mid-task; killing its container out from under it would be doing by
         * the back door exactly what the refusal declined to do at the front,
         * and would corrupt the worktree the prune gate below is refusing to
         * touch for the same reason.
         */
        if (anchor.kind === "refused") {
          report.push({ id, stopped: false, how: anchor.how });
          await ledger.append("worker_down_refused", {
            worker: id,
            detail: { how: anchor.how, reason: anchor.detail, pid: state.pid },
          });
          if (opts.json !== true) {
            process.stderr.write(
              `  ${id}: refused to signal pid ${state.pid} — ${anchor.detail}; ` +
                `re-run with --force-identity to signal it anyway\n`,
            );
          }
          continue;
        }
        const target = anchor.target;

        // Phase 1: graceful, via the control socket.
        try {
          await controlCall(run, id, { cmd: "shutdown" }, { timeoutMs: 2_000 });
        } catch {
          // Socket dead but process alive — fall through to the ladder.
        }
        let how = "graceful";
        if (!(await waitGone(target, GRACEFUL_WAIT_MS))) {
          /**
           * Phase 2: SIGTERM the process GROUP — the CONFIRMED one.
           *
           * `anchor.group`, not `state.pgid`. The supervisor leads its group
           * (`launchDetached` spawns it detached), and `confirmGroup` has just
           * established that from the OS rather than from the file, so `-pgid`
           * takes the Pi child with it and reaches nothing else. Where the
           * group could not be confirmed the anchor already refused above, and
           * where none was recorded at all this is `null` and the signal goes
           * to the validated leader alone.
           */
          how = "sigterm";
          /**
           * THE OUTCOME DECIDES `how`, and it has to.
           *
           * `signalIfSame` re-confirms the group before EVERY rung, so a
           * signal this ladder asked for is not a signal that was sent: a
           * group that stops confirming mid-climb returns `group_unconfirmed`
           * and NOTHING is delivered. `signalGuarded` used to discard that
           * answer, so `how` stayed `"sigterm"`/`"sigkill"` and the operator
           * was told `STILL RUNNING (sigkill)` — and, via the prune gate,
           * "its supervisor survived the kill ladder" — about a process no
           * signal ever reached. This function says elsewhere, in as many
           * words, that such a sentence is "a plain falsehood"; it produced
           * one here.
           *
           * Recording it as a GROUP REFUSAL is what makes the rest of the
           * command tell the truth for free: `isAnchorRefusal` and
           * `isGroupRefusal` both cover it, so the stdout verdict reads
           * REFUSED, the prune reason takes the group-refusal wording, and the
           * final error names `--force-identity` — which really is the answer
           * here, exactly as it is for a group refused at the anchor.
           */
          const termOutcome = await signalGuarded(target, "SIGTERM", anchor.group);
          if (termOutcome === "group_unconfirmed") {
            how = LADDER_GROUP_UNCONFIRMED;
          } else if (termOutcome === "identity_unconfirmed") {
            /*
             * The identity read FAILED at the rung — `ps` could not be read at
             * all, so nothing is known about the target and nothing was sent.
             * Kept apart from the group refusal above because the two send an
             * operator somewhere different: one says the recorded group could
             * not be vouched for, this one says the measuring instrument is
             * broken. Collapsing them would tell somebody to edit a record
             * that is fine.
             */
            how = LADDER_IDENTITY_UNCONFIRMED;
          } else if (!(await waitGone(target, TERM_WAIT_MS))) {
            // Phase 3: SIGKILL — the same confirmed group, no survivors.
            how = "sigkill";
            /**
             * A group that failed to confirm at SIGTERM will not confirm at
             * SIGKILL either — re-confirmation reads the same OS — so the
             * climb STOPS rather than paying another `TERM_WAIT_MS` waiting
             * for a signal that was never sent to take effect. That is the
             * same shape `runKillLadder` already uses (`if (term ===
             * "group_unconfirmed") return "group_unconfirmed"`), applied to the
             * ladder `down` runs by hand.
             */
            const killOutcome = await signalGuarded(target, "SIGKILL", anchor.group);
            if (killOutcome === "group_unconfirmed") {
              how = LADDER_GROUP_UNCONFIRMED;
            } else if (killOutcome === "identity_unconfirmed") {
              // Same reasoning as the SIGTERM rung, and the same stop: a `ps`
              // that cannot be read at SIGTERM will not read at SIGKILL.
              how = LADDER_IDENTITY_UNCONFIRMED;
            } else {
              await waitGone(target, TERM_WAIT_MS);
            }
          }
        }
        // Identity, not liveness: a pid that was recycled after the ladder
        // killed the supervisor would read as STILL RUNNING on a bare
        // `processStartTime`, and `down` would exit WORKER_DIED over a
        // stranger it never touched.
        /*
         * A read that fails HERE must not abort the command, and must not be
         * reported as a stop. `stopped: false` with the identity refusal is
         * the same answer the rungs above produce, and it is what blocks the
         * prune gate below — the property the whole branch exists for.
         */
        const held = await identityHolds(target);
        const stopped = held === false;
        if (held === null) how = LADDER_IDENTITY_UNCONFIRMED;
        report.push({ id, stopped, how, ...(anchor.forced ? { forced_identity: true } : {}) });
        await ledger.append("worker_down", {
          worker: id,
          detail: { how, stopped, forced_identity: anchor.forced },
        });
        /**
         * The container, and why `--rm` does not already cover this.
         *
         * `--rm` is implemented by the docker CLIENT, for a foreground run: it
         * removes the container after the container EXITS and the client is
         * still there to do it. The supervisor IS that client, so every rung of
         * the ladder above except a graceful shutdown kills it — and a killed
         * client removes nothing, while the container keeps running under
         * dockerd, which owns it and never noticed. That is the orphan this
         * removes: a live container holding `--name pifleet-<run>-<worker>`,
         * still writing to the worktree the `--prune` gate below may be about
         * to delete, and guaranteeing a name collision on the next `up` of the
         * same run id.
         *
         * Gated on the launch record's own field, so a run started against the
         * `PIFLEET_PI_COMMAND` double issues no docker call at all.
         */
        await reapContainer();
        try {
          await unlink(wp.controlSock);
        } catch {
          // Graceful shutdown already removed it.
        }
      }

      // The daemon last: it must outlive the workers it deregisters.
      await registryCall(run, { cmd: "shutdown" }, { optional: true });
      /**
       * The daemon rung, and the one place a BARE pid was still reachable.
       *
       * `daemon.pid` records BOTH halves of the identity — `{pid, started}`,
       * written in one call by `startRegistryDaemon`. This rung read the file,
       * took the pid and threw the start time away, so a run directory left
       * behind by a reboot signalled whatever now held the number. The
       * recorded half is right here; use it.
       *
       * This rung passes `pgid: null`, so `signalIfSame` addresses
       * `target.pid` directly. That makes the anchor the ONLY thing standing
       * between a stale `daemon.pid` and `kill(<some stranger's pid>)` — no
       * group indirection to raise ESRCH by luck, which is how the empty-string
       * hole stayed invisible while a group-addressed worker rung looked safe.
       *
       * A refusal here is recorded and printed but does NOT fail the command.
       * The daemon holds no checkout, so no `--prune` decision rests on it and
       * there is no data-loss path to close; a run whose registry daemon is
       * unidentifiable is a run whose workers were already reported on their
       * own terms above.
       */
      let daemonReport: { stopped: boolean; how: string } | null = null;
      try {
        const pidFile = JSON.parse(await Bun.file(run.daemonPid).text()) as {
          pid: number;
          started?: unknown;
        };
        const anchor = await anchorIdentity(
          pidFile.pid,
          typeof pidFile.started === "string" ? pidFile.started : null,
          // `null`, and it is a DECLARATION rather than a gap: `daemon.pid`
          // records no group, so this rung addresses the validated leader and
          // nothing else. Distinct from a worker whose recorded group came
          // back `0`, which means a capture that should have happened failed
          // (ISC-272).
          null,
          { force: forceIdentity },
        );
        if (anchor.kind === "refused") {
          daemonReport = { stopped: false, how: anchor.how };
          await ledger.append("daemon_down_refused", {
            detail: { how: anchor.how, reason: anchor.detail, pid: pidFile.pid },
          });
          if (opts.json !== true) {
            process.stderr.write(
              `  daemon: refused to signal pid ${pidFile.pid} — ${anchor.detail}; ` +
                `re-run with --force-identity to signal it anyway\n`,
            );
          }
        } else if (anchor.kind === "gone") {
          daemonReport = { stopped: true, how: "already_gone" };
        } else {
          const target = anchor.target;
          let how = "graceful";
          if (!(await waitGone(target, TERM_WAIT_MS))) {
            how = "sigterm";
            /*
             * The outcome was DISCARDED here, and the worker rung's fix did
             * not reach this one. `signalGuarded` can answer
             * `group_unconfirmed`, `identity_unconfirmed` or `errored`, and
             * every one means NO SIGNAL WAS SENT — so keeping `how = "sigterm"`
             * printed `daemon: STILL RUNNING (sigterm)`, claiming a ladder was
             * climbed that never ran. That is the same falsehood this file
             * removed for workers, left standing three hundred lines down.
             */
            const outcome = await signalGuarded(target, "SIGTERM", anchor.group);
            if (outcome === "group_unconfirmed") how = LADDER_GROUP_UNCONFIRMED;
            else if (outcome === "identity_unconfirmed") how = LADDER_IDENTITY_UNCONFIRMED;
            else await waitGone(target, TERM_WAIT_MS);
          }
          const daemonHeld = await identityHolds(target);
          if (daemonHeld === null) how = LADDER_IDENTITY_UNCONFIRMED;
          daemonReport = { stopped: daemonHeld === false, how };
        }
      } catch {
        // No daemon ever ran (integration setups) — nothing to stop.
      }
      try {
        await unlink(run.daemonSock);
      } catch {
        // Already gone.
      }

      /**
       * Phase 2: the checkouts (SRD §9.3).
       *
       * Before the view is torn down rather than after, for the reason the
       * teardown block below states about ordering: a pane is the surface a
       * failure is READ on, so anything that can fail loudly should fail while
       * one is still open.
       *
       * Refusals, none of which is an error in the run:
       *
       *  - a supervisor LAUNCHED and confirmed still alive. §9.3's own words:
       *    pruning a checkout whose container is still writing would corrupt
       *    it. The kill ladder above already computed the answer as
       *    `!sameIdentity(target)`, so this reuses that fact rather than
       *    asking a second, differently-shaped question. Identity and not
       *    liveness, deliberately: the bare `processStartTime(pid) === null`
       *    this used to read called a checkout unprunable whenever ANY
       *    process held the recorded number, so a reused pid could pin a
       *    checkout that nothing had been writing to for days. A worker id
       *    with NO supervisor state at all is NOT this case — nothing was
       *    ever writing into that checkout, so the corruption hazard this
       *    gate exists to enforce does not apply, and it falls through to the
       *    dirt check below like any other checkout (see the loop for why).
       *  - a checkout that still holds work. `run/worktree.ts` defines what
       *    that means for a clone with no upstream — uncommitted paths, or
       *    commits past the recorded `baseSha`. `--force` overrides it.
       *  - no record, or a record `readRunWorktrees` could not fully read. A
       *    run whose `run.json` never recorded checkouts has nothing to reap
       *    and says so. A run whose record COULD NOT BE READ is different and
       *    must NOT read as the same "nothing to reap" success: real clones
       *    and remotes may still be on disk with nothing left naming them,
       *    which is exactly the loop-reaper data loss `EXIT.PARTIAL` exists
       *    to prevent elsewhere in this function — silently exiting 0 here
       *    with `pruned: []` would tell a script reaping runs in a loop that
       *    this run left nothing behind, when the honest answer is "unknown".
       */
      const pruned: PruneOutcome[] = [];
      let pruneRefusals = 0;
      /**
       * THE PRUNE PHASE IS BLOCKED OUTRIGHT when the worker listing failed.
       *
       * Not merely degraded, and not left to the per-worker gate below: that
       * gate keys off `workerOutcome`, which is built from `report`, which is
       * empty for precisely this reason. Every checkout would read as
       * "no supervisor was ever writing here" and be deleted. The refusal has
       * to be taken before the loop, because inside the loop the evidence it
       * would need is exactly the evidence that is missing.
       */
      if (opts.prune === true && listingRefusal !== null) {
        await ledger.append("prune_skipped", { detail: { reason: listingRefusal } });
        if (opts.json !== true) process.stderr.write(`  cannot prune: ${listingRefusal}\n`);
        pruneRefusals++;
      } else if (opts.prune === true) {
        const recorded = await readRunWorktrees(run);
        if (recorded.note !== null) {
          await ledger.append("prune_skipped", { detail: { reason: recorded.note } });
          if (opts.json !== true) process.stderr.write(`  cannot prune: ${recorded.note}\n`);
          pruneRefusals++;
        }
        for (const note of recorded.perWorkerNotes) {
          const workerId = note.split(":")[0] ?? "unknown";
          await ledger.append("prune_skipped", { worker: workerId, detail: { reason: note } });
          if (opts.json !== true) process.stderr.write(`  cannot prune ${workerId}: ${note}\n`);
          pruned.push({
            workerId,
            path: "(unreadable record)",
            pruned: false,
            reason: `run.json's checkout record for this worker could not be read (${note}); refusing to guess at a path to delete`,
          });
          pruneRefusals++;
        }
        const workerOutcome = new Map(report.map((r) => [r.id, r]));
        const byWorkerSorted = [...recorded.byWorker.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [id, wt] of byWorkerSorted) {
          if (recorded.repo === null) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              reason: "run.json does not record the parent repository; refusing to guess at one",
            });
            pruneRefusals++;
            continue;
          }
          // A supervisor confirmed to have SURVIVED the kill ladder blocks
          // its own prune — the §9.3 corruption hazard. Absent from the
          // report entirely (no `workers/<id>` state file — a supervisor
          // never launched under this id in this run, most likely because
          // `up` failed partway through: the clone succeeded and was
          // recorded, but daemon launch never reached this worker) is NOT
          // the same fact and must not be treated as it: nothing was ever
          // writing into the checkout, so it is exactly as prunable as one
          // whose supervisor exited cleanly, subject to the same dirt check.
          const row = workerOutcome.get(id);
          if (row !== undefined && !row.stopped) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              // An anchor refusal is a DIFFERENT refusal from surviving the
              // ladder, and saying "survived the kill ladder" for it would be
              // a plain falsehood — no ladder ran. Both refuse, for the same
              // §9.3 reason, but only one of them has a `--force-identity`
              // answer, and an operator cannot pick it if the message hides
              // which case they are in.
              //
              // The GROUP refusals get their own words for the same reason
              // again (ISC-272). "Could not be identified" is false for them:
              // the supervisor WAS identified, and what could not be shown is
              // that the process group `down` was about to signal is the one
              // this run launched. An operator told the wrong fact reaches for
              // the wrong fix.
              reason: isGroupRefusal(row.how)
                ? `its supervisor was identified, but the process group 'down' would have signalled ` +
                  `could not be shown to be that supervisor's own (${row.how}), so no signal was sent ` +
                  `and it cannot be shown to have stopped writing here; a live container writing here ` +
                  `would be corrupted by a delete (--force-identity signals the supervisor alone, ` +
                  `never an unconfirmed group)`
                : isAnchorRefusal(row.how)
                  ? `its supervisor could not be identified (${row.how}), so 'down' refused to signal it ` +
                    `and cannot show it is not still writing here; a live container writing here would be ` +
                    `corrupted by a delete (--force-identity anchors on whatever holds the pid)`
                  : "its supervisor survived the kill ladder; a live container writing here would be corrupted by a delete",
            });
            pruneRefusals++;
            continue;
          }
          let outcome: PruneOutcome;
          try {
            outcome = await pruneWorkerWorktree({
              repo: recorded.repo,
              worktree: wt,
              force: opts.force === true,
            });
          } catch (err) {
            // A prune that throws must not take down a `down` that already
            // stopped every process it set out to stop — the same argument
            // the workspace-teardown block makes. Recorded, never swallowed.
            outcome = {
              workerId: id,
              path: wt.path,
              pruned: false,
              reason: `prune failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          pruned.push(outcome);
          if (!outcome.pruned) pruneRefusals++;
          await ledger.append(outcome.pruned ? "worktree_pruned" : "worktree_prune_refused", {
            worker: id,
            detail: { path: outcome.path, reason: outcome.reason },
          });
        }
      }

      /**
       * The view, last of all (ISC-129).
       *
       * `down` tore down every process and left the workspace standing: a
       * real `up --backend tmux` followed by `down` reported `clean: true`
       * while its tmux session and both panes were still alive, so every run
       * leaked a session that only `tmux kill-server` would ever reclaim.
       * `FleetBackend.destroy` existed and was tested the whole time and had
       * no production caller — the same dead-subsystem shape found twice
       * before in this project, and a green suite is exactly what makes it
       * look finished. `--keep-panes` was the tell: a documented flag that
       * nothing read, because the teardown it modifies was never wired.
       *
       * Panes are destroyed AFTER the processes are gone. A pane whose
       * process is still running would be killed out from under it, and the
       * SRD's ordering is quiesce, then stop, then verify — the view is the
       * last thing to go, so a failure anywhere above it is still readable
       * on screen.
       */
      const keepPanes = opts.keepPanes === true;
      const workspaces = new Map<string, { backend: BackendKind; id: string }>();
      for (const id of workerIds) {
        const p = await readPresentation(workerPaths(run, id));
        // headless has no view to destroy, and a null ref means the pane
        // never got created — `up` records the failure rather than aborting.
        if (p === null || p.backend === "headless" || p.workspace_ref === null) continue;
        workspaces.set(`${p.backend}:${p.workspace_ref}`, {
          backend: p.backend,
          id: p.workspace_ref,
        });
      }
      for (const w of workspaces.values()) {
        try {
          const backend = await loadBackend(w.backend);
          await backend.destroy({ backend: w.backend, id: w.id }, { keepPanes });
          await ledger.append("workspace_down", {
            detail: { backend: w.backend, workspace: w.id, kept: keepPanes },
          });
        } catch (err) {
          /**
           * Not fatal, and deliberately so: presentation is not the control
           * plane. A backend that has already died cannot make `down` report
           * that the workers it really did stop are still running. Recorded,
           * never swallowed.
           */
          await ledger.append("workspace_down_failed", {
            detail: {
              backend: w.backend,
              workspace: w.id,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          if (opts.json !== true) {
            process.stderr.write(`  could not destroy ${w.backend} workspace ${w.id}: ${String(err)}\n`);
          }
        }
      }

      await ledger.append("run_down", {});

      /**
       * `clean` is an ASSERTION ABOUT THE FLEET, so it cannot be derived from
       * an enumeration that failed.
       *
       * `report.every(...)` over an empty array is `true` — the vacuous truth
       * that let a failed listing report success over a fleet nothing
       * touched. The listing refusal is therefore a first-class term here
       * rather than a message printed beside a `clean: true`: a caller
       * parsing `--json` reads this field and nothing else.
       */
      const allStopped = listingRefusal === null && report.every((r) => r.stopped);
      const refused = report.filter((r) => isAnchorRefusal(r.how));
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            workers: report,
            clean: allStopped,
            // Why `workers` is empty, when it is empty because nothing could
            // be read. Absent on the healthy path, so `workers: []` on a run
            // that genuinely had none stays exactly what it was.
            ...(listingRefusal !== null ? { workers_unlistable: listingRefusal } : {}),
            // Additive, and non-fatal by design — see the daemon rung above.
            // Present so `--json` carries the fact at all: a refusal there
            // used to be indistinguishable from a daemon that was never running.
            ...(daemonReport !== null ? { daemon: daemonReport } : {}),
            ...(opts.prune === true ? { pruned } : {}),
          })}\n`,
        );
      } else {
        process.stdout.write(`run ${runId} down\n`);
        // Printed BEFORE the (empty) worker list, because it is the reason
        // the list is empty. Underneath it, an absent list reads as "this run
        // had no workers", which is the false reading this whole path exists
        // to prevent.
        if (listingRefusal !== null) process.stdout.write(`  REFUSED: ${listingRefusal}\n`);
        for (const r of report) {
          // REFUSED reads differently from STILL RUNNING on purpose. "Still
          // running" says a ladder was climbed and lost; a refusal says no
          // signal was ever sent, which is a different thing to do next.
          const verdict = r.stopped ? "stopped" : isAnchorRefusal(r.how) ? "REFUSED" : "STILL RUNNING";
          process.stdout.write(`  ${r.id}: ${verdict} (${r.how})\n`);
        }
        if (daemonReport !== null && !daemonReport.stopped) {
          // The SAME distinction the worker line above draws, and for the same
          // reason. `daemonReport.stopped` is false in two unrelated cases: the
          // anchor refused, and the ladder ran and lost (`how === "sigterm"`,
          // set at the daemon rung). Printing REFUSED for both announced a
          // daemon that had been SIGTERMed and outlived it as one that was
          // never signalled — the plain falsehood, on the one rung this file
          // had not widened `isAnchorRefusal` onto.
          const verdict = isAnchorRefusal(daemonReport.how) ? "REFUSED" : "STILL RUNNING";
          process.stdout.write(`  daemon: ${verdict} (${daemonReport.how})\n`);
        }
        for (const p of pruned) {
          process.stdout.write(`  ${p.workerId}: ${p.pruned ? "pruned" : "KEPT"} — ${p.reason}\n`);
        }
      }
      /**
       * Not stopped is not stopped, whichever way it got there — but the two
       * ways need different words, because they need different next actions.
       * A survivor was signalled and outlived it; a refusal was never
       * signalled at all, and `--force-identity` is the answer to exactly one
       * of those. The old single sentence claimed a ladder had been climbed
       * for both.
       */
      /**
       * The listing refusal takes its OWN exit before the ladder's, and takes
       * a different code (ISC-192 carry-in).
       *
       * `WORKER_DIED` below means "a ladder ran and something outlived it" —
       * a fact about the RUN. A directory that cannot be read is a fact about
       * the MACHINE, and it is the same class of failure `StateReadError` and
       * `RunPolicyUnreadableError` already answer with
       * `BACKEND_UNAVAILABLE`. An operator handed exit 6 goes looking for a
       * stuck supervisor; the thing to fix here is a mount, a permission or
       * an open-file limit.
       *
       * Placed after the report is written, not before, so `clean: false` and
       * the reason are on stdout by the time this throws — the diagnosis is
       * the point, and a caller that only sees an exit code still gets an
       * accurate `clean`.
       */
      if (listingRefusal !== null) {
        throw new CliError(listingRefusal, EXIT.BACKEND_UNAVAILABLE);
      }
      if (!allStopped) {
        const survivors = report.filter((r) => !r.stopped && !isAnchorRefusal(r.how));
        const parts: string[] = [];
        if (survivors.length > 0) parts.push(`${survivors.length} supervisor(s) survived the kill ladder`);
        if (refused.length > 0) {
          /*
           * `--force-identity` IS the answer for a record that disagrees with
           * the world, and is NOT the answer for a `ps` that cannot be read:
           * forcing re-anchors on whatever holds the pid, measured with the
           * same instrument that just failed, and the anchor already succeeded
           * anyway or this rung would not have been reached. Offering it there
           * sends an operator to disable the identity check to fix a broken
           * machine. The two remedies are therefore split by which refusals
           * are actually present.
           */
          const hows = [...new Set(refused.map((r) => r.how))].sort();
          const forcible = refused.filter((r) => r.how !== LADDER_IDENTITY_UNCONFIRMED);
          parts.push(
            `${refused.length} were never signalled because their recorded launch identity or ` +
              `process group could not be confirmed (${hows.join(", ")})` +
              (forcible.length > 0
                ? `; --force-identity signals the supervisor alone, never an unconfirmed group`
                : `; \`ps\` could not be read on this machine — --force-identity cannot help, ` +
                  `because it re-anchors using the same reading that failed`),
          );
        }
        throw new CliError(parts.join("; "), EXIT.WORKER_DIED);
      }
      /**
       * A refused prune is a non-zero exit, and deliberately so.
       *
       * `--prune` is a request to leave nothing behind. A run that stopped
       * cleanly but kept three checkouts full of uncommitted work has NOT done
       * what was asked, and exiting 0 would let a script that reaps runs in a
       * loop delete the run directory while the work it points at stays on
       * disk with nothing left naming it. `PARTIAL` is the code for exactly
       * this — the operation did some of what it was asked — and the reasons
       * are already on stdout above.
       */
      if (pruneRefusals > 0) {
        throw new CliError(
          `${pruneRefusals} checkout(s) were kept rather than pruned; see the reasons above ` +
            `(--force prunes one that still holds work)`,
          EXIT.PARTIAL,
        );
      }
    });
}

/**
 * Why an anchor declined to hand out a target.
 *
 * SEVEN DIFFERENT facts about the world (three about the identity, four about
 * the group), kept apart deliberately. They were all reported as
 * `already_gone, stopped: true` — the same words used for
 * "nothing holds this pid" — and that collapse is what let a LIVE supervisor
 * be reported as stopped, exit 0, and then have its checkout deleted by
 * `--prune`, because the prune gate refuses only when `stopped` is false.
 * Only "nothing holds this pid" is a success; the rest are refusals to act,
 * and an operator who is not told the difference cannot act on it either.
 */
export type AnchorRefusal =
  | "identity_mismatch"
  | "identity_unrecorded"
  | "identity_legacy_format"
  /**
   * The GROUP half (ISC-272). Four more facts, kept apart from each other and
   * from the identity three for the same reason those three are kept apart:
   * they have different causes, and only some of them mean anything is wrong
   * with the process itself.
   *
   *  - `group_unrecorded` — the launcher never captured a process group, so
   *    `state.pgid` holds the capture-failed sentinel (`0`). Nothing is known
   *    to be wrong with the supervisor; what is missing is the record.
   *  - `group_mismatch` — the recorded group disagrees with the group the OS
   *    puts this (identity-validated) process in. The state file is stale or
   *    edited, which is the premise `down` operates under.
   *  - `group_not_led` — record and OS agree, and the group is led by some
   *    OTHER process. `-pgid` would reach that leader and every one of its
   *    children. This is the case that once SIGTERMed the test runner.
   */
  | "group_unrecorded"
  | "group_mismatch"
  | "group_not_led"
  /**
   * `ps` COULD NOT BE READ — the fourth group fact, and the one that must
   * never be confused with the first three.
   *
   * `confirmGroup` used to answer a failed read and an affirmative "no such
   * process" with the same verdict. They are opposite statements about the
   * world: one says the supervisor is gone, the other says we do not know. The
   * first is the anchor's single SUCCESS answer — it reports `stopped: true`,
   * it reaps the container with `docker rm -f`, and it makes the checkout
   * PRUNABLE. Letting an unreadable `ps` arrive there would delete a live
   * supervisor's worktree on the strength of a command that failed, which is
   * the §9.3 corruption reached through a broken measurement instead of a
   * stale record.
   *
   * So it is a refusal, with its own words, and the words say the group could
   * not be READ rather than that it disagreed. An operator told "the record is
   * stale" about a `ps` that never ran goes and edits a file that is fine.
   */
  | "group_read_failed"
  /**
   * The identity READ failed — `ps` could not be run or could not be believed.
   * Unlike the four above, this says nothing about the record; the instrument
   * broke. Shares the string with the ladder's own verdict so one refusal
   * reads the same wherever it is produced.
   */
  | typeof LADDER_IDENTITY_UNCONFIRMED;

/**
 * The ladder's OWN identity refusal, the twin of `LADDER_GROUP_UNCONFIRMED`.
 *
 * `signalIfSame` re-reads the identity before every signal, and since ISC-192
 * that read can FAIL rather than answer: `processStartTime` refuses a `ps` it
 * cannot read instead of reporting the process absent. A rung that meets that
 * failure sends nothing and says so here.
 *
 * It is an IDENTITY refusal, not a group one, and the distinction is the whole
 * point of having two sets: `--force-identity` is the right pointer for a
 * group that cannot be confirmed, and the WRONG one here — forcing past a
 * broken `ps` would anchor on whatever holds the pid, measured with the same
 * instrument that just failed. Kept out of `AnchorRefusal` for the reason
 * `LADDER_GROUP_UNCONFIRMED` is: no anchor can produce it.
 */
const LADDER_IDENTITY_UNCONFIRMED = "identity_read_failed";

const IDENTITY_REFUSALS = new Set<string>([
  "identity_mismatch",
  "identity_unrecorded",
  "identity_legacy_format",
  LADDER_IDENTITY_UNCONFIRMED,
]);

/**
 * The ladder's OWN group refusal, which no anchor produces.
 *
 * `anchorIdentity` confirms the group once, before anything is signalled;
 * `signalIfSame` confirms it again at every rung, because each grace period is
 * a window in which the world can change. A group that confirms at the anchor
 * and stops confirming at the SIGTERM or SIGKILL rung yields no signal at all,
 * and this is the `how` that records it. It is a member of `GROUP_REFUSALS`
 * because it IS one — the group `down` was about to signal could not be shown
 * to be the supervisor's own — and because every operator-facing consequence
 * of that fact (the REFUSED verdict, the prune reason, the `--force-identity`
 * pointer) is already keyed off that set.
 *
 * Kept out of `AnchorRefusal` on purpose: that union is what an ANCHOR may
 * answer, and widening it to hold a value anchors cannot produce would make
 * the type describe less than it does now.
 */
const LADDER_GROUP_UNCONFIRMED = "group_unconfirmed";

const GROUP_REFUSALS = new Set<string>([
  "group_unrecorded",
  "group_mismatch",
  "group_not_led",
  "group_read_failed",
  LADDER_GROUP_UNCONFIRMED,
]);

/**
 * True for a `how` that means NO SIGNAL WAS SENT — because an anchor refused
 * to hand out a target, or because a rung of the ladder declined to address an
 * unconfirmed group.
 *
 * EXPORTED for `down-prune.test.ts`, which grades the classification directly.
 * The alternative is to reach every member through a live fixture, and one of
 * them (`group_read_failed`) requires `ps` itself to fail on a running
 * process — a state this suite cannot produce without breaking the machine it
 * runs on. A classification nothing checks is how a new refusal silently
 * acquires the wrong operator-facing words.
 */
export function isAnchorRefusal(how: string): boolean {
  return IDENTITY_REFUSALS.has(how) || GROUP_REFUSALS.has(how);
}

/**
 * True for the subset of refusals that are about the GROUP, not the leader.
 *
 * EXPORTED for the same reason `isAnchorRefusal` is: this set is what routes
 * an operator to `--force-identity`, so a refusal landing in it by accident
 * offers a remedy that cannot work. Graded directly rather than through a
 * fixture, because the members that matter most need `ps` itself to fail.
 */
export function isGroupRefusal(how: string): boolean {
  return GROUP_REFUSALS.has(how);
}

type Anchor =
  | { kind: "gone" }
  /**
   * `group` is the ONLY pgid any rung is allowed to address, and it is either
   * a number `confirmGroup` vouched for or `null` — never the raw `state.pgid`
   * the caller handed in. `null` means "address the validated leader and
   * nothing else", which is what the daemon rung has always meant and what
   * `--force-identity` now degrades to.
   */
  | { kind: "target"; target: ProcId; group: number | null; forced: boolean }
  | { kind: "refused"; how: AnchorRefusal; detail: string };

/**
 * Resolve the `(pid, started)` pair this ladder is allowed to signal (ISC-191).
 *
 * A pid is not an identity — `safety/kill.ts`'s header argues the general
 * case. `down` is where it bites hardest, because `down` is the one kill path
 * an operator runs BY HAND, typically against a run directory whose
 * supervisors died some time ago. A bare `pifleet down` resolves the latest
 * run, and after a reboot the latest run is a stale one whose recorded pids
 * now belong to whatever the machine started since.
 *
 * FAIL-CLOSED, in all three refusal directions:
 *
 *  - `identity_mismatch` — a comparable launch-time identity exists and
 *    disagrees with the OS. The process we meant to kill is gone and this pid
 *    belongs to a stranger.
 *  - `identity_unrecorded` — nothing comparable was recorded. This covers
 *    `null` (no registry entry, or one whose pid disagrees with `state.json`)
 *    AND the empty string, which is NOT a neutral value: `""` is precisely
 *    what both writers persist when their own capture failed
 *    (`(await processStartTime(process.pid)) ?? ""` in `startRegistryDaemon`
 *    and in `supervisor/index.ts`), and `RegistryWorkerSchema.started` is a
 *    bare `z.string()` so a truncated or hand-edited file yields it too —
 *    and stale files of unknown provenance are the entire premise of `down`.
 *    Treating `""` as "no constraint" made a failed capture DOWNGRADE to the
 *    rung-0 self-anchor, which on the daemon rung means `signalGuarded(…,
 *    null)` and therefore `signalIfSame` addressing `target.pid`: a bare pid,
 *    the literal thing ISC-191 forbids. Measured before this change, with a
 *    live `sleep` recorded as `{"pid":N,"started":""}`: `down` exited 0 with
 *    `clean: true` and the process was dead afterwards. Identical result with
 *    the field absent entirely.
 *  - `identity_legacy_format` — something was recorded, but before the
 *    rendering was pinned (`registry.ts`'s `IDENTITY_FORMAT`), so it is not
 *    comparable to anything this build can read off the OS. See the migration
 *    note in `register` for why this is its own answer and not a mismatch.
 *
 * THE GROUP IS ANCHORED HERE TOO (ISC-272), and it is the second half of the
 * same argument. Identity was validated on the LEADER while every signal was
 * delivered to `-state.pgid` — a number read from a state file `down` reads
 * precisely because it may be stale, reaching every process in that group
 * rather than one. `recordedPgid` is therefore not passed through to the
 * ladder: it is handed to `confirmGroup`, which accepts it only when it was
 * captured at launch, still agrees with the OS, and names a group LED by the
 * process whose identity was just validated. A group led by an
 * already-validated process has an identity we have already checked; a group
 * the target merely belongs to does not.
 *
 * `recordedPgid` distinguishes two things a caller can mean by "no group":
 *
 *  - `null` — this rung addresses no group BY DESIGN. The daemon rung means
 *    this: `daemon.pid` records `{pid, started}` and no group, so there is no
 *    group to get wrong, and the signal goes to the validated leader alone.
 *    That is the narrowest blast radius available, not a degradation.
 *  - `0` — a worker's launch record exists and says the capture FAILED
 *    (`supervisor/index.ts`). Something should have been recorded and was not,
 *    so this refuses (`group_unrecorded`) rather than quietly narrowing.
 *
 * `force` is `--force-identity`: it restores the pre-fix weak anchor for the
 * cases above — whatever holds the pid NOW becomes the target, every LATER
 * rung is still identity-checked, but rung 0 cannot tell a supervisor from a
 * stranger. It exists so a refusal is never a dead end, and it is a flag
 * rather than a default because typing it is the operator asserting the run
 * directory is theirs.
 *
 * FORCE NEVER RESTORES A GROUP, and that is a deliberate asymmetry rather than
 * an oversight. Before ISC-272 the flag aimed SIGTERM and then SIGKILL at
 * `-state.pgid` on nothing but the operator's word, which is the widest
 * possible reading of "signal it anyway" — the operator asserts the run
 * directory is theirs, not that some integer in it names a group they are
 * willing to destroy. So a forced anchor addresses the leader and only the
 * leader. It is also the only coherent reading: `confirmGroup` derives the
 * group's identity FROM the validated leader, so on a path where the leader's
 * identity is unverified there is nothing left for a group check to rest on.
 */
async function anchorIdentity(
  pid: number,
  recorded: string | null,
  recordedPgid: number | null,
  opts: { force: boolean },
): Promise<Anchor> {
  /*
   * THE FIRST READ IN THE WHOLE COMMAND, and therefore the first place a
   * broken `ps` can escape. Since ISC-192 `processStartTime` refuses rather
   * than reporting absence, and the worker loop that calls this is not inside
   * a try — so an unguarded throw here aborts `down` entirely before any
   * report row exists, which is why the ladder's own refusal branches below
   * were unreachable in exactly the case they were written for.
   *
   * It becomes the same refusal the rungs produce: `stopped: false`, no
   * signal, prune gate blocked. `--force-identity` is deliberately NOT offered
   * — it would re-anchor on whatever holds the pid using the reading that just
   * failed, which is the fail-open this refusal exists to keep shut.
   */
  let current: string | null;
  try {
    current = await processStartTime(pid);
  } catch (err) {
    return {
      kind: "refused",
      how: LADDER_IDENTITY_UNCONFIRMED,
      detail: `the launch identity of pid ${pid} could not be read: ${String(err)}`,
    };
  }
  // Nothing holds the pid. The one genuine success among these answers, and
  // the only one that may report `stopped: true`.
  if (current === null) return { kind: "gone" };

  const have = recorded !== null && recorded !== "" ? recorded : null;
  let refusal: { how: AnchorRefusal; detail: string } | null = null;
  if (have === null) {
    refusal = {
      how: "identity_unrecorded",
      detail:
        `nothing recorded a launch-time identity for pid ${pid}, so whatever holds that pid now ` +
        `cannot be shown to be the process this run launched`,
    };
  } else if (!isPinnedIdentity(have)) {
    refusal = {
      how: "identity_legacy_format",
      detail:
        `the identity recorded for pid ${pid} predates the pinned '${IDENTITY_FORMAT}' rendering, ` +
        `so it was written in whatever timezone and locale the launcher happened to have and is ` +
        `not comparable to what this build reads from the OS`,
    };
  } else if (have !== current) {
    refusal = {
      how: "identity_mismatch",
      detail: `pid ${pid} is held by a different process than the one this run recorded`,
    };
  }

  const target: ProcId = { pid, started: current };
  if (refusal !== null) {
    // Forced: the leader, and never a group. See the header above.
    if (opts.force) return { kind: "target", target, group: null, forced: true };
    return { kind: "refused", ...refusal };
  }

  // The identity holds. Now the group the signal would actually reach.
  if (recordedPgid === null) return { kind: "target", target, group: null, forced: false };

  const group = await confirmGroup(target, recordedPgid, realProcessOps);
  if (group.ok) return { kind: "target", target, group: group.pgid, forced: false };
  /**
   * `gone` — and ONLY `gone` — may take the success exit.
   *
   * The leader died between the identity read and the group read. Racing that
   * window is not a refusal: it is the `gone` answer arriving a moment late,
   * and reporting it as anything else would fail a `down` that has nothing
   * left to do.
   *
   * This is also the narrowest gate in the function and the reason the
   * comparison is spelled out rather than folded into `groupRefusal`'s
   * fallthrough. `{kind: "gone"}` is the one anchor verdict that reports
   * `stopped: true`, calls `reapContainer()` (`docker rm -f`), and makes the
   * worker PRUNABLE. Every OTHER verdict — including one this build has never
   * heard of — must refuse.
   */
  const why: string = group.why;
  if (why === "gone") return { kind: "gone" };
  if (opts.force) return { kind: "target", target, group: null, forced: true };
  return { kind: "refused", ...groupRefusal(why, pid, recordedPgid) };
}

/**
 * Turn a `confirmGroup` verdict into the operator-facing fact it stands for.
 *
 * `why` is typed `string`, not `GroupRefusal`, and that WIDENING IS THE POINT
 * rather than a lapse. `safety/kill.ts` owns the verdict set and grows it —
 * `read_failed` is being split out of `gone` there as this is written — and a
 * narrowly-typed parameter would not make this function handle a new member,
 * it would only make the day it appears a compile error in one file and a
 * silently wrong SENTENCE in another. The final branch below is what actually
 * protects the operator: anything unrecognised refuses in its own words rather
 * than borrowing a neighbour's.
 *
 * EXPORTED for `down-prune.test.ts`. Its two most important branches —
 * `read_failed` and the unrecognised fallthrough — describe states this suite
 * cannot summon from a live process, and a refusal message nothing reads is
 * how the wrong one ships.
 */
export function groupRefusal(
  why: string,
  pid: number,
  recordedPgid: number,
): { how: AnchorRefusal; detail: string } {
  if (why === "unrecorded") {
    return {
      how: "group_unrecorded",
      detail:
        `no process group was recorded when pid ${pid} launched (the state file holds the ` +
        `capture-failed sentinel ${recordedPgid}), so there is no group this run can show it owns`,
    };
  }
  if (why === "mismatch") {
    return {
      how: "group_mismatch",
      detail:
        `the process group recorded for pid ${pid} (${recordedPgid}) is not the group the OS ` +
        `puts that process in, so the record is stale and signalling it would reach a group ` +
        `this run never launched`,
    };
  }
  if (why === "not_led") {
    return {
      how: "group_not_led",
      detail:
        `pid ${pid} is a MEMBER of group ${recordedPgid} but does not lead it, so that group is ` +
        `led by some other process and signalling it would reach that process and all of its ` +
        `children rather than this run's supervisor`,
    };
  }
  if (why === "read_failed") {
    return {
      how: "group_read_failed",
      detail:
        `the process group of pid ${pid} could not be READ — 'ps' failed or answered nothing ` +
        `usable — so nothing is known about the group recorded for it (${recordedPgid}); this is ` +
        `NOT the record disagreeing with the OS and NOT the process being gone, and the ` +
        `supervisor may well be alive and mid-task`,
    };
  }
  /**
   * A verdict this build does not recognise. FAIL CLOSED, in its own words.
   *
   * This branch used to be `not_led`'s: the function ended on that return, so
   * every unhandled verdict inherited a sentence asserting a specific, checked
   * fact about who leads a process group — a fact nothing had established. The
   * whole design of these messages is that an operator told the wrong fact
   * reaches for the wrong fix, and an invented one is the worst version of
   * that.
   *
   * Reported as `group_read_failed` because that is what is true here: the
   * group could not be established. The detail names the verdict verbatim so
   * the gap is traceable to the version skew that caused it rather than
   * looking like a `ps` failure.
   */
  return {
    how: "group_read_failed",
    detail:
      `the process group of pid ${pid} could not be established: 'confirmGroup' returned the ` +
      `verdict ${JSON.stringify(why)}, which this build of 'down' does not recognise, so the ` +
      `group recorded for it (${recordedPgid}) cannot be shown to be this supervisor's own`,
  };
}

/**
 * Signal a re-validated identity and a re-confirmed group, never a bare pid
 * and never a group taken on trust.
 *
 * `signalIfSame` re-reads the pair and compares it before every signal, and
 * swallows the ESRCH of a target that died inside the check-then-signal
 * window. Anything else — EPERM, most plausibly — is swallowed HERE instead:
 * `down` must still stop the remaining workers, the daemon and the view, and
 * then report this worker as STILL RUNNING, which the identity read after the
 * ladder already does. Throwing out of the loop would skip all of that.
 *
 * The `pgid` handed in is always `anchor.group` — a value `confirmGroup`
 * already vouched for, or `null`. `signalIfSame` confirms it AGAIN before each
 * signal, which is what makes "every rung" true rather than "the top rung".
 *
 * THE OUTCOME IS RETURNED, and an earlier revision of this docstring argued at
 * length that it should not be. That argument was wrong in its conclusion and
 * instructive in its premise. The premise was right: a group that stops
 * confirming mid-climb means no signal was sent, so the target is still alive
 * and `stopped: false` blocks the prune gate. What it missed is that
 * `stopped: false` is only half of what the operator is shown. The other half
 * is `how`, which drives the stdout verdict, the prune REASON, and the closing
 * error — and with the outcome discarded, all three described a kill ladder
 * that had been climbed and lost, about a process nothing had signalled.
 *
 * Nor is the branch unreachable: `down-prune.test.ts` reaches it with a
 * fixture that leaves its recorded process group between the anchor's check
 * and the SIGTERM rung, which is exactly the `setpgid`-between-two-rungs case
 * the old text called hypothetical.
 *
 * A thrown error is still swallowed and still reported by the caller's
 * identity read — that half is unchanged.
 */
/**
 * `docker rm -f <name>`, reported rather than thrown.
 *
 * Never fatal to `down`. The overwhelmingly common outcome is "No such
 * container" — a graceful shutdown let `--rm` do its job — and treating the
 * absence of a container as a failure would turn the normal path into a
 * non-zero exit. Equally, a docker daemon that is not running is not a reason
 * to leave the rest of the teardown undone: the supervisor is already stopped
 * by the time this runs, which is the part that matters for the prune gate.
 *
 * Returns whether the container was actually removed, so the ledger records
 * what happened instead of that it was attempted.
 */
async function removeContainer(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "rm", "-f", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    // No docker on PATH at all. Same disposition as a dead daemon.
    return false;
  }
}

async function signalGuarded(
  target: ProcId,
  signal: "SIGTERM" | "SIGKILL",
  pgid: number | null,
): Promise<SignalOutcome | "errored"> {
  try {
    return await signalIfSame(target, signal, { pgid });
  } catch {
    // EPERM, most plausibly. Distinguished from every `SignalOutcome` so a
    // caller cannot mistake "the call threw" for "the group did not confirm";
    // both leave the target alive, and only one of them has --force-identity
    // as an answer. Reported as `stopped: false` by the caller's identity read.
    return "errored";
  }
}

/** True once the recorded identity is gone — dead, or replaced by a stranger. */
/**
 * `sameIdentity`, with a FAILED READ as a third answer rather than a throw.
 *
 * Since ISC-192 `processStartTime` refuses a `ps` it cannot read instead of
 * reporting the process absent, so every bare `sameIdentity` here became a
 * throw site — and the worker loop is not inside a try. An escape there aborts
 * the WHOLE command: remaining workers unsignalled, the daemon rung skipped,
 * `--json` never emitted, and no report row for the worker whose read failed.
 * That is worse than the answer it replaced.
 *
 * `null` is "could not tell", and every caller turns it into a refusal that
 * reports `stopped: false` — which is what blocks the prune gate.
 */
async function identityHolds(target: ProcId): Promise<boolean | null> {
  try {
    return await sameIdentity(target, realProcessOps);
  } catch {
    return null;
  }
}

async function waitGone(target: ProcId, budgetMs: number): Promise<boolean> {
  const clock = new Stopwatch();
  for (;;) {
    // `null` (unreadable) must NOT return true: `true` here means "it is gone",
    // which the caller reports as a graceful stop. Falling through to the
    // budget makes an unreadable `ps` look like a survivor, and the rung's own
    // re-check then produces the refusal.
    if ((await identityHolds(target)) === false) return true;
    if (clock.elapsedMs() > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
