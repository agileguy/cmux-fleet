import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT, type ExitCode } from "../../contracts.ts";
import { loadBackend } from "../../backends/registry.ts";
import { ConfigError, loadConfig, type LoadedConfig } from "../../config/load.ts";
import { resolveAllWorkers } from "../../config/load.ts";
import type { FleetConfig, Toolchain } from "../../config/schema.ts";
import { imageTag } from "../../container/image.ts";
import { probeMountVisibility, type MountVisibility } from "../../container/mounts.ts";
import { EXEC_NOT_FOUND, realExec, type Exec } from "../../container/run.ts";
import { chatProbeModel } from "../../security/model-probe.ts";
import { runsRoot } from "../../run/paths.ts";

/**
 * `pifleet doctor` (SRD §10, §11): probe docker, cmux, tmux, pi, git, and
 * oMLX; report versions, backends, cmux socket mode, image status, and a
 * measured single-request oMLX latency (ISC-54/55) — `max_concurrent` is set
 * from evidence, not guessed (SRD §5.9).
 *
 * Exit 3 when a `required` cmux CLI command is missing (ISC-133), when the
 * socket mode is `allowAll` (over-permissive — pifleet never writes it), or
 * `cmuxOnly` while running outside a pane (the socket would refuse every
 * pifleet call). cmux being entirely absent is NOT an error: tmux and
 * headless remain, and the acceptance suite runs on headless by design.
 */

/**
 * Which KIND of problem a diagnosis describes (ISC-159).
 *
 * Every finding used to land in one untyped array, so the only thing that
 * distinguished "docker is not installed" from "docker is installed and
 * stopped" was English prose in a message — and even that was absent, because
 * both rendered as `not available (docker exited 1)`. Those have opposite
 * fixes. An operator told the first when the second is true reinstalls a
 * Docker they already have and ends up exactly where they started.
 *
 * The classes are named for what the operator must DO, which is the only
 * partition that earns its own tag:
 *
 *   missing-binary  install it        (absent from PATH, or unrunnable)
 *   wrong-version   upgrade it        (present, below the floor pifleet needs)
 *   absent-daemon   start it          (present and current; its service is down)
 *   misconfigured   change a setting  (present, current, running — and in a
 *                                      state that would refuse pifleet's calls)
 *
 * `misconfigured` is the residual on purpose. It is not "everything else we
 * could not be bothered to classify": it is the set whose fix is a
 * configuration change rather than an installation change, which is what the
 * socket-mode, mount-visibility and unreadable-build-context findings all are.
 */
export type DiagnosisClass = "missing-binary" | "wrong-version" | "absent-daemon" | "misconfigured";

/** A version floor's verdict for one probe. Absent when the tool has no floor. */
interface VersionFloor {
  /** The minimum from `VERSION_FLOORS`. */
  min: string;
  /**
   * `unreadable` is a THIRD answer and not a rounding of the other two. A
   * banner that will not parse is not evidence the tool is current, and it is
   * not evidence the tool is stale either; folding it into `ok` reports health
   * on no evidence, and folding it into `below` sends an operator to upgrade
   * something that may already be current.
   */
  status: "ok" | "below" | "unreadable";
}

interface Probe {
  name: string;
  ok: boolean;
  required: boolean;
  version?: string;
  floor?: VersionFloor;
  /**
   * The probe command's exit code, as `realExec` reports it.
   *
   * Carried because `EXEC_NOT_FOUND` (127) is how `run.ts` signals that the
   * SPAWN failed — not on PATH, or not executable — which is a different
   * diagnosis from a tool that ran and refused. Without it `doctor` is back to
   * reading the distinction out of a message string.
   */
  code: number | null;
  detail: string;
}

export interface Diagnosis {
  name: string;
  class: DiagnosisClass;
  message: string;
}

/**
 * Minimum versions of the third-party tools pifleet's own code depends on.
 *
 * Nothing in `Docs/SRD.md` or `fleet.example.yaml` states a floor for any of
 * these, so none of these numbers is quoted — each is the earliest release
 * carrying a feature this repository already calls, found by reading what the
 * code does rather than by picking a round number. Raising one is a real
 * change to what pifleet will run on and belongs in the SRD; inventing one
 * silently is how a floor ends up rejecting a machine for no reason.
 *
 * docker 23.0.0 — `docker/Dockerfile` uses `COPY --chmod=` (six times), which
 *   is a BuildKit frontend feature, and `container/image.ts` shells out to a
 *   plain `docker build` without ever setting `DOCKER_BUILDKIT=1`. BuildKit
 *   became `docker build`'s default builder in Engine 23.0; on 22.x and
 *   earlier the classic builder runs and rejects `--chmod` outright, so no
 *   worker image can be built at all. The probe reads `{{.Server.Version}}`,
 *   which is the Engine version this claim is about.
 *
 * git 2.32.0 — `harvest/git.ts`'s `HERMETIC_GIT_ENV` neutralises a
 *   developer's global and system config against an UNTRUSTED repository with
 *   `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`. Those variables were
 *   introduced in git 2.32. Older git does not reject them — it IGNORES them,
 *   so the hardening fails open, silently, and nothing downstream can observe
 *   that it did. A security control that fails that way is the strongest case
 *   in this file for enforcing a floor rather than reporting one.
 *
 * tmux 2.4.0 — `backends/tmux/argv.ts` sets `pane-border-status` and
 *   `select-pane -T` (both landed in tmux 2.3) and calls `respawn-pane -c`
 *   (2.4); 2.4 is the earliest release carrying all three. Deliberately
 *   conservative — every tmux in circulation is far past it — because tmux is
 *   probed `required: false` and this floor only withdraws a backend.
 */
const VERSION_FLOORS: Readonly<Record<string, string>> = {
  docker: "23.0.0",
  git: "2.32.0",
  tmux: "2.4.0",
};

/**
 * The leading `major.minor[.patch]` of a version banner, or null.
 *
 * Three formats have to land in one parser and none of them agree:
 * `git version 2.43.0`, `tmux 3.6a`, and docker's `{{.Server.Version}}`,
 * which is a bare `28.0.1`. So the parse is "first dotted numeric run", not a
 * `split(".")` — which would produce `NaN` on tmux's letter suffix and on
 * git's `(Apple Git-154)` vendor tail.
 *
 * A two-field banner reads as patch `0`. tmux's point releases are letters
 * (`3.6a` is a patch of `3.6`), so this can only ever under-report a version,
 * which is the safe direction for a floor.
 *
 * Named `…Triple` because `backends/tmux/argv.ts` exports its own
 * `parseVersion` over the SAME tmux banner, answering a different question:
 * it returns the raw token (`"3.6a"`, `"master"`) for display and for a
 * present/absent test, where this one returns numbers for a comparison. On
 * `tmux master` they legitimately disagree — `"master"` there, `null` here —
 * and while both are right for their own caller, two same-named exports that
 * disagree on one input is how a later "de-duplicate these" pass deletes the
 * wrong one. Distinct names make that pass read the difference first.
 */
export function parseVersionTriple(raw: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * Is `raw` at or above `min`? `null` when the banner could not be parsed.
 *
 * Numeric field-by-field, because the obvious `>=` on strings ranks `2.9`
 * above `2.10` — and every tool floored here has shipped a two-digit minor,
 * so that is a live bug rather than a hypothetical one.
 */
export function versionAtLeast(raw: string, min: string): boolean | null {
  const got = parseVersionTriple(raw);
  const want = parseVersionTriple(min);
  if (got === null || want === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const g = got[i] ?? 0;
    const w = want[i] ?? 0;
    if (g !== w) return g > w;
  }
  return true;
}

/**
 * The required-command list lives in `src/backends/cmux/capabilities.ts` and
 * is reached through the backend's own `probe()`, NOT copied here.
 *
 * It was copied here, and the two copies had already diverged: the backend's
 * list carries `respawn-pane` — how a viewer starts in a split pane, without
 * which panes are empty shells and ISC-129 is unmeetable — and this file's did
 * not. So `doctor` would report a clean cmux that `up` then failed on, which
 * is the exact failure `doctor` exists to prevent. Two lists that must agree,
 * in two files, with nothing comparing them, agree only until someone edits
 * one.
 *
 * `doctor` cannot import the cmux module directly (ISC-137), which is what
 * made copying tempting. It goes through the registry instead — the same
 * kind-keyed load `up` uses — so there is one list and one prober.
 */

async function versionProbe(
  exec: Exec,
  name: string,
  argv: string[],
  required: boolean,
): Promise<Probe> {
  const r = await exec(argv, { timeoutMs: 15_000 });
  const ok = r.code === 0;
  const version = ok ? (r.stdout.trim().split("\n")[0] ?? "") : undefined;

  // The floor is only knowable when the tool answered. A probe that failed has
  // a diagnosis of its own, and stacking "and also its version is unreadable"
  // on top of "it is not installed" tells the operator nothing new.
  const min = VERSION_FLOORS[name];
  let floor: VersionFloor | undefined;
  let floorDetail = "";
  if (min !== undefined && version !== undefined) {
    const verdict = versionAtLeast(version, min);
    const status = verdict === null ? "unreadable" : verdict ? "ok" : "below";
    floor = { min, status };
    if (status === "below") floorDetail = ` — below the ${min} minimum pifleet requires`;
    if (status === "unreadable") floorDetail = ` — could not verify the ${min} minimum from this banner`;
  }

  return {
    name,
    ok,
    required,
    ...(version !== undefined ? { version } : {}),
    ...(floor !== undefined ? { floor } : {}),
    code: r.code,
    detail: ok
      ? `${version ?? ""}${floorDetail}`
      : `not available (${argv[0]} exited ${r.code ?? "on timeout"})`,
  };
}

/**
 * The diagnosis for a required probe that did not answer at all.
 *
 * Both branches are `missing-binary`, and that is `realExec`'s own reading
 * rather than a shrug: its header records that `ENOENT` (not installed) and
 * `EACCES` (installed and unusable) both surface as `EXEC_NOT_FOUND`, so the
 * code genuinely cannot separate them. The names differ because the operator
 * can — the second one's `detail` carries the spawn error verbatim — but the
 * remediation is the same shape, which is what the class is for.
 */
function unavailableDiagnosis(p: Probe): Diagnosis {
  if (p.code === EXEC_NOT_FOUND) {
    return {
      name: `${p.name}-not-installed`,
      class: "missing-binary",
      message: `${p.name} is not on PATH, or is present but not executable — install ${p.name} and re-run`,
    };
  }
  return {
    name: `${p.name}-unusable`,
    class: "missing-binary",
    message: `${p.name} is on PATH but could not be run (${p.detail}) — repair or reinstall ${p.name}`,
  };
}

/**
 * The diagnosis for a probe that answered from below its floor, if any.
 *
 * Optional tools never produce one. tmux is probed `required: false` because
 * the fleet runs on headless by design and an absent tmux has never been a
 * diagnosis; "absent is fine, but stale is fatal" would be incoherent, and it
 * would fail a whole machine over a backend the operator may never select.
 * A stale optional tool withdraws its backend instead — see `backends` below,
 * which is the same reported-never-required shape `read-screen` already has.
 */
function floorDiagnosis(p: Probe): Diagnosis | null {
  if (p.floor === undefined || p.floor.status === "ok" || !p.required) return null;
  const got = p.version ?? "";
  if (p.floor.status === "below") {
    return {
      name: `${p.name}-version-below-minimum`,
      class: "wrong-version",
      message: `${p.name} ${got} is below the ${p.floor.min} minimum pifleet requires — upgrade ${p.name} to >= ${p.floor.min} and re-run`,
    };
  }
  /**
   * `misconfigured`, not `wrong-version`.
   *
   * `wrong-version` means "present, below the floor" — a real, parsed number
   * that lost a comparison, whose fix is an upgrade. Nothing was parsed here,
   * so nothing lost a comparison: the tool may well be current. What is known
   * is that the probed name on this PATH does not answer with a version banner
   * pifleet recognises, which is a property of the environment rather than of
   * the tool's release. The message has always ended "check what `x` resolves
   * to on PATH" — a configuration change, which is this class's definition —
   * so the tag was contradicting the remediation it shipped with, and an
   * operator filtering on `wrong-version` was being sent to upgrade on no
   * evidence. Wrapper scripts, shims and version managers land here.
   */
  return {
    name: `${p.name}-version-unreadable`,
    class: "misconfigured",
    message: `${p.name} reported a version pifleet could not parse ("${got}"), so the >= ${p.floor.min} minimum could not be verified — check what \`${p.name}\` resolves to on PATH`,
  };
}

/**
 * docker, with the daemon separated from the CLI (ISC-159).
 *
 * `docker version --format {{.Server.Version}}` is one command answering two
 * questions, and it failed identically for both: the binary is absent, or the
 * binary is fine and the daemon behind it is not running. `doctor` printed
 * `not available (docker exited 1)` for each, which is the report an operator
 * with a stopped Docker Desktop least needs — it sends them to reinstall.
 *
 * `realExec` already distinguishes a failed SPAWN (`EXEC_NOT_FOUND`) from a
 * command that ran and failed, so the first half is free. The confirming
 * `docker --version` earns its subprocess anyway: it is client-only — it never
 * opens the socket — so its success is positive evidence that the CLI works
 * and the DAEMON is the missing piece, and it puts the installed client
 * version into the message. Inferring that from an exit code alone would be
 * the same "read it out of the failure shape" guess this function exists to
 * replace.
 *
 * Order matters. An absent binary and a dead daemon both make the server
 * version unknowable, so neither can be followed by a version-floor verdict —
 * the floor is checked only on the branch where the daemon actually answered.
 */
async function probeDocker(exec: Exec): Promise<{ probe: Probe; diagnoses: Diagnosis[] }> {
  const server = await versionProbe(
    exec,
    "docker",
    ["docker", "version", "--format", "{{.Server.Version}}"],
    true,
  );
  if (server.ok) {
    const floor = floorDiagnosis(server);
    return { probe: server, diagnoses: floor === null ? [] : [floor] };
  }

  const client = await exec(["docker", "--version"], { timeoutMs: 15_000 });
  if (client.code !== 0) {
    return { probe: server, diagnoses: [unavailableDiagnosis(server)] };
  }

  const banner = client.stdout.trim().split("\n")[0] ?? "";
  return {
    probe: {
      name: "docker",
      ok: false,
      required: true,
      code: server.code,
      detail: `daemon unreachable — CLI present (${banner})`,
    },
    diagnoses: [
      {
        name: "docker-daemon-unreachable",
        class: "absent-daemon",
        message: `the docker CLI is installed (${banner}) but its daemon did not answer \`docker version\` — start Docker (Docker Desktop, Colima, or \`systemctl start docker\`) and re-run`,
      },
    ],
  };
}

/**
 * The exit code for a set of diagnoses (ISC-159).
 *
 * Every class exits `BACKEND_UNAVAILABLE`, and that is a decision rather than
 * an omission. The tempting reading of "a missing binary, a wrong version, and
 * an absent daemon" is three exit codes; it is the wrong one, for two reasons
 * the ladder in `contracts.ts` makes concrete.
 *
 * An exit code is ONE number, and `doctor` routinely trips several classes in
 * a single run — an absent tmux, a stale git and a dead daemon are all
 * findable at once. Encoding the class in the code forces a `worstExit`-style
 * collapse to whichever ranks highest, which DESTROYS exactly the distinction
 * the criterion is asking for. The report carries all of them; the scalar
 * cannot carry two.
 *
 * And `EXIT.INTERNAL` — the one precedent for widening the ladder — was split
 * from `EXIT.USAGE` because a machine caller must take a categorically
 * different action: rewrite your arguments, versus stop, pifleet is broken.
 * Answering the first with the second produced an orchestrator that retried
 * forever. These three do not diverge that way. Every one of them tells a
 * caller the same thing — the host is not ready, fix it and re-run — and
 * differ only in what a HUMAN then types, which is precisely what the
 * criterion asks to be put in the message.
 *
 * SRD §11 already fixes the number: "Any missing `required` capability → exit
 * 3 with a named diagnosis". The work ISC-159 names is making the diagnosis
 * carry the class, not making the ladder wider.
 */
export function exitForDiagnoses(diagnoses: readonly Diagnosis[]): ExitCode {
  return diagnoses.length === 0 ? EXIT.SUCCESS : EXIT.BACKEND_UNAVAILABLE;
}

/**
 * Image presence for one toolchain — or a diagnosis of why it is unknowable.
 *
 * `imageTag` reads the build context off disk to hash it, so an unreadable
 * `docker/Dockerfile` makes it THROW. Called bare, that throw escaped the whole
 * `doctor` action and took every probe already collected with it: the operator
 * asking "what is wrong with my machine" got a one-line failure instead of the
 * report, and the answer to their question was the very thing that suppressed
 * it. `doctor` exists so a broken machine is still diagnosable, so a broken
 * checkout has to be a ROW, not an abort.
 *
 * `tagFor` is injected only so the unreadable-context path can be exercised
 * without deleting a file out of the developer's own checkout.
 */
export async function imageStatus(
  config: FleetConfig,
  toolchain: Toolchain,
  exec: Exec,
  tagFor: (c: FleetConfig, t: Toolchain) => string = imageTag,
): Promise<{ image: { tag: string; present: boolean } | null; diagnosis: Diagnosis | null }> {
  let tag: string;
  try {
    tag = tagFor(config, toolchain);
  } catch (err) {
    return {
      image: null,
      diagnosis: {
        name: "image-tag-uncomputable",
        // The build context is part of how the image is configured, and the
        // fix is to repair the checkout — not to install or upgrade anything.
        class: "misconfigured",
        message: `toolchain "${toolchain}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const r = await exec(["docker", "image", "inspect", tag, "--format", "{{.Id}}"]);
  return { image: { tag, present: r.code === 0 }, diagnosis: null };
}

interface CmuxReport {
  probe: Probe;
  socketMode: string | null;
  missingCommands: string[];
  /**
   * Optional capabilities, REPORTED and never required (ISC-132).
   * `read-screen` is the one that matters: it is diagnostics-only, so the run
   * must succeed identically whether or not it exists — and the operator still
   * has to be told which they have, or they cannot tell a missing diagnostic
   * from a broken one.
   */
  optional: Array<{ name: string; ok: boolean; detail: string }>;
  /**
   * True when the capability probe THREW rather than reporting.
   *
   * Distinct from `missingCommands.length > 0`: a probe that failed to run
   * tells us nothing about which commands exist, and the empty list must not
   * be read as "none missing". Without this the report could say
   * `backends.cmux: true` beside a `cmux-probe-failed` diagnosis.
   */
  probeFailed: boolean;
  diagnoses: Diagnosis[];
}

async function probeCmux(exec: Exec, env: Record<string, string | undefined>): Promise<CmuxReport> {
  const probe = await versionProbe(exec, "cmux", ["cmux", "--version"], false);
  const report: CmuxReport = {
    probe,
    socketMode: null,
    missingCommands: [],
    optional: [],
    probeFailed: false,
    diagnoses: [],
  };
  if (!probe.ok) return report;

  // Ask the BACKEND what it requires, rather than restating it. `probe()`
  // returns one `Capability` per required command (checked against `--help`
  // text, because cmux commits to CLI stability and not to socket method
  // names — SRD §4.1). A backend that cannot even run its probe counts as
  // missing everything, which is the honest reading: we cannot say it is
  // healthy.
  try {
    const caps = await (await loadBackend("cmux")).probe();
    for (const c of caps) {
      if (c.required && !c.ok) {
        // `detail` carries WHICH commands are absent — the capability itself
        // is an aggregate (`cmux-cli-commands`). Reporting the name alone
        // tells an operator a category failed and not what to install, which
        // is a worse message than the per-command loop this replaced.
        report.missingCommands.push(c.detail !== undefined && c.detail !== "" ? `${c.name} (${c.detail})` : c.name);
      }
      if (!c.required) report.optional.push({ name: c.name, ok: c.ok, detail: c.detail ?? "" });
    }
  } catch (err) {
    report.probeFailed = true;
    report.diagnoses.push({
      name: "cmux-probe-failed",
      class: "misconfigured",
      message: `cmux capability probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (report.missingCommands.length > 0) {
    /**
     * `wrong-version` even though nothing here parsed a version number.
     *
     * cmux's floor is `>= 0.64.20` and it is checked by CAPABILITY — which
     * commands `--help` lists — not by its `--version` banner, because SRD
     * §4.1 has cmux committing to CLI stability rather than to version
     * numbers. That makes it a strictly better check than the banner floors
     * above: it tests the thing pifleet actually needs instead of a proxy for
     * it, and it does not misjudge a fork or a dev build. The CLASS is the
     * same either way, because the operator's fix is the same — upgrade cmux —
     * and the class exists to name the fix, not the measurement.
     */
    report.diagnoses.push({
      name: "cmux-required-command-missing",
      class: "wrong-version",
      message: `cmux is missing required CLI command(s): ${report.missingCommands.join(", ")} — need cmux >= 0.64.20`,
    });
  }

  // Socket mode is a config key, not an environment variable (SRD §4.1).
  try {
    const raw = await Bun.file(join(homedir(), ".config", "cmux", "cmux.json")).text();
    const parsed = JSON.parse(raw) as { automation?: { socketControlMode?: string } };
    report.socketMode = parsed.automation?.socketControlMode ?? "cmuxOnly";
  } catch {
    report.socketMode = "cmuxOnly"; // cmux's documented default
  }

  const insidePane = env["CMUX_WORKSPACE_ID"] !== undefined || env["CMUX_SURFACE_ID"] !== undefined;
  if (report.socketMode === "allowAll") {
    report.diagnoses.push({
      name: "cmux-socket-over-permissive",
      class: "misconfigured",
      message: 'socketControlMode is "allowAll" — any local process can drive cmux; use "password" mode',
    });
  } else if (report.socketMode === "cmuxOnly" && !insidePane) {
    report.diagnoses.push({
      name: "cmux-socket-unreachable",
      class: "misconfigured",
      message:
        'socketControlMode is "cmuxOnly" and pifleet is running outside a pane — every socket call would be refused; use "password" mode',
    });
  }
  return report;
}

/**
 * The container-facing hostname a worker-facing `llm.base_url` is written
 * with. Named here so the vantage diagnosis can recognise it.
 */
const CONTAINER_HOSTNAME = "host.docker.internal";

interface OmlxReport {
  ok: boolean;
  baseUrl: string;
  /**
   * WHERE these numbers were measured from. Always `"host"`, and now STATED
   * rather than left to be assumed (ISC-260).
   *
   * `doctor` runs in this process, so everything below is the host's view of
   * the endpoint. That used to be quietly untrue: the base URL was pushed
   * through `hostFacingBaseUrl` first, which rewrote a worker-facing
   * `host.docker.internal` to `localhost` — so `doctor` measured whatever
   * answered on the LOCAL machine and presented it as the configured
   * endpoint's health. On a Docker-host-local oMLX the two coincide and the
   * substitution is invisible. Off it, the rewrite INVENTS an endpoint nobody
   * configured, and the latency reported describes a server the fleet does not
   * use.
   *
   * A latency figure whose vantage is ambiguous is the same class of problem
   * as a criterion whose evidence is ambiguous, so the field is emitted in
   * `--json` and printed in the text output rather than being documented and
   * forgotten.
   *
   * What the WORKERS can reach is a DIFFERENT question, deliberately not
   * answered here. `up`'s ISC-53 gate answers it, from inside the egress
   * network, which is the whole of ISC-260. `doctor` does not duplicate that:
   * the bridge only exists once `up` has built it, and `doctor` is a read-only
   * diagnostic that must not create one to measure it.
   */
  vantage: "host";
  models: string[];
  /** GET /v1/models round-trip, milliseconds. */
  listLatencyMs: number | null;
  /** One tiny chat completion, milliseconds — the number that sizes max_concurrent. */
  completionLatencyMs: number | null;
  model: string | null;
  detail: string;
}

/**
 * Explain a host-vantage failure that is not an outage.
 *
 * `llm.base_url` is written for the WORKERS, so the default names
 * `host.docker.internal` — a name that resolves only on the egress bridge,
 * where the relay puts it. `doctor` runs on the host and cannot resolve it, so
 * without this the report reads "oMLX unreachable" on a perfectly healthy
 * machine and sends the operator to restart a server that is fine.
 *
 * `hostFacingBaseUrl` used to prevent that by rewriting the name to
 * `localhost`. That was the wrong fix: it answered a question nobody asked
 * (can this host reach SOME oMLX) in place of the one that was asked, and it
 * silently stopped being even approximately right the moment the server was
 * not on this box. Saying what happened costs one diagnosis and lies about
 * nothing.
 */
function omlxVantageDiagnosis(report: OmlxReport, network: string | null): Diagnosis | null {
  if (report.ok) return null;
  let hostname: string;
  try {
    hostname = new URL(report.baseUrl).hostname;
  } catch {
    // A base_url that will not parse is a config defect, not a vantage
    // problem, and the schema's `z.string().url()` already refuses it.
    return null;
  }
  if (hostname !== CONTAINER_HOSTNAME) return null;
  return {
    name: "omlx-unreachable-from-host",
    class: "misconfigured",
    message:
      `llm.base_url names ${CONTAINER_HOSTNAME}, which resolves only inside the egress ` +
      `network${network === null ? "" : ` (${network})`} — where the relay publishes it. ` +
      `doctor probes from the HOST, so it cannot reach that name and the numbers above are ` +
      `absent for that reason, not because oMLX is down. This is not a fault to fix: the ` +
      `field is written for the workers. Whether the workers can actually reach it is ` +
      `checked by \`up\`'s native-tool-call gate, which probes from inside that network.`,
  };
}

async function probeOmlx(loaded: LoadedConfig | null): Promise<OmlxReport> {
  /**
   * VERBATIM — no rewriting of any kind. See `OmlxReport.vantage`.
   *
   * The consequence is deliberate: when `llm.base_url` names the
   * container-facing hostname (the default), this probe cannot resolve it and
   * says so, and `omlxVantageDiagnosis` turns that into an explanation rather
   * than leaving it looking like an outage.
   */
  const baseUrl = loaded?.config.llm.base_url ?? `http://${CONTAINER_HOSTNAME}:8000/v1`;
  const keyEnv = loaded?.config.llm.api_key_env ?? "OMLX_API_KEY";
  const key = process.env[keyEnv] ?? "";
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const report: OmlxReport = {
    ok: false,
    baseUrl,
    vantage: "host",
    models: [],
    listLatencyMs: null,
    completionLatencyMs: null,
    model: null,
    detail: "",
  };

  try {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    report.listLatencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      report.detail = `GET /models → HTTP ${res.status}${key ? "" : ` (no ${keyEnv} in environment)`}`;
      return report;
    }
    const body = (await res.json()) as { data?: { id?: string }[] };
    report.models = (body.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  } catch (err) {
    report.detail = `oMLX unreachable at ${baseUrl}: ${(err as Error).message}`;
    return report;
  }

  /**
   * Measured single-request latency (ISC-55): one minimal completion against
   * the configured default model, or — with no config — the first served model
   * that does not NAME itself an embedding model.
   *
   * The filter is not cosmetic. This host currently serves
   * `Qwen3-Embedding-4B-4bit-DWQ` first, and a chat completion against it
   * returns HTTP 500 (measured), so the old `report.models[0]` fallback left
   * `completion_latency_ms` null and ISC-55's whole number unreported on the
   * default `doctor` invocation — the one someone runs when they have no
   * config yet, which is precisely when they need it to size `max_concurrent`.
   */
  const model = chatProbeModel(loaded?.config.llm.model ?? null, report.models);
  report.model = model;
  if (model !== null) {
    try {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        await res.json();
        report.completionLatencyMs = Math.round(performance.now() - t0);
      } else {
        report.detail = `completion probe → HTTP ${res.status}`;
      }
    } catch (err) {
      report.detail = `completion probe failed: ${(err as Error).message}`;
    }
  }

  report.ok = report.models.length > 0;
  if (report.ok && report.detail === "") report.detail = `${report.models.length} models served`;
  return report;
}

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Probe docker/cmux/tmux/pi/git/oMLX and report backend readiness")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { config?: string; json?: boolean }) => {
      const exec = realExec;
      const probes: Probe[] = [];
      const diagnoses: Diagnosis[] = [];

      // Config is optional for doctor: a broken machine should still be diagnosable.
      let loaded: LoadedConfig | null = null;
      let configDetail = "no config found (probing with defaults)";
      try {
        loaded = await loadConfig(opts.config);
        configDetail = loaded.path;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        configDetail = err.message.split("\n")[0] ?? "config unreadable";
      }

      const docker = await probeDocker(exec);
      probes.push(docker.probe);
      diagnoses.push(...docker.diagnoses);
      probes.push(await versionProbe(exec, "git", ["git", "--version"], true));
      probes.push(await versionProbe(exec, "pi", ["pi", "--version"], false));
      probes.push(await versionProbe(exec, "tmux", ["tmux", "-V"], false));

      const cmux = await probeCmux(exec, process.env);
      probes.push(cmux.probe);
      diagnoses.push(...cmux.diagnoses);

      // Image status per toolchain the config actually uses (SRD §11 probe list).
      const images: { tag: string; present: boolean }[] = [];
      const dockerOk = docker.probe.ok;
      if (loaded !== null && dockerOk) {
        const toolchains = [...new Set(resolveAllWorkers(loaded).map((w) => w.toolchain))];
        for (const tc of toolchains) {
          const status = await imageStatus(loaded.config, tc, exec);
          if (status.diagnosis !== null) diagnoses.push(status.diagnosis);
          if (status.image !== null) images.push(status.image);
        }
      }

      // Mount visibility (see container/mounts.ts). An unshared runs root does
      // not fail a `docker run` — it mounts empty, so every worker writes an
      // outbox the harvester will never see and still exits 0. Probing needs a
      // built image; without one there is nothing to run the check inside.
      let mount: MountVisibility & { dir: string } = {
        visible: false,
        detail: "not probed",
        dir: runsRoot(),
      };
      const probeTag = images.find((i) => i.present)?.tag;
      if (dockerOk && probeTag !== undefined) {
        await mkdir(mount.dir, { recursive: true });
        const r = await probeMountVisibility(mount.dir, probeTag, exec);
        mount = { ...r, dir: mount.dir };
        if (!r.visible) {
          // Docker is installed, current and running; what is wrong is which
          // paths its daemon has been given permission to see.
          diagnoses.push({ name: "runs-dir-not-mountable", class: "misconfigured", message: r.detail });
        }
      } else {
        mount.detail = dockerOk ? "no worker image built yet" : "docker unavailable";
      }

      const omlx = await probeOmlx(loaded);
      // Why the host could not reach a worker-facing URL, when that is what
      // happened. Pushed here rather than inside `probeOmlx` because that
      // function reports a measurement and this is an interpretation of one.
      const vantage = omlxVantageDiagnosis(omlx, loaded?.config.docker.network ?? null);
      if (vantage !== null) diagnoses.push(vantage);

      // docker classified itself above — it is the one probe whose failure has
      // two possible causes and needs a second command to tell them apart.
      for (const p of probes) {
        if (p.name === "docker") continue;
        if (p.required && !p.ok) diagnoses.push(unavailableDiagnosis(p));
        const floor = floorDiagnosis(p);
        if (floor !== null) diagnoses.push(floor);
      }

      /**
       * `cmux: true` must not survive a probe that threw.
       *
       * The flag was `probe.ok && missingCommands.length === 0`, and the
       * catch around the capability probe pushes a `cmux-probe-failed`
       * diagnosis while leaving `missingCommands` empty — so `--json` could
       * report `backends.cmux: true` directly beside a diagnosis saying the
       * probe failed. Whichever a reader believed, one of them was lying.
       */
      /**
       * A below-floor tmux is not a tmux backend. An UNVERIFIABLE one still is.
       *
       * This is where the optional floors land instead of in `diagnoses`. An
       * absent tmux has always answered `false` here without failing the run;
       * a tmux too old to take `respawn-pane -c` would fail at `up` rather
       * than at `doctor`, which is the report-a-clean-machine-that-then-breaks
       * failure `doctor` exists to prevent. `ok` is left alone deliberately —
       * flipping it would re-conflate "not installed" with "too old", the
       * exact merge ISC-159 is about.
       *
       * The test is `!== "below"` and NOT `=== "ok"`, which is the whole point
       * of `unreadable` being a third status. `=== "ok"` folds `unreadable` in
       * with `below` and withdraws the backend — but `floorDiagnosis` returns
       * null for an optional tool, so nothing is pushed to `diagnoses` to say
       * why. A working tmux therefore vanished from `backends` with no finding
       * anywhere in the report and an exit of 0: the operator is told the
       * backend is unavailable, and given no sentence explaining it.
       *
       * A git-built tmux prints `tmux master`, which has no dotted numeric run
       * and so parses to null here. That is not evidence the binary is stale —
       * it is newer than every numbered release. `TmuxBackend.probe()` agrees
       * and reports `ok: true` for it (it keeps the banner token as a string
       * rather than comparing it), so the `=== "ok"` gate had `doctor` calling
       * a tmux dead that `up --backend tmux` then drove perfectly well. Only a
       * confirmed `below` — a version that actually parsed and actually lost
       * the comparison — is evidence enough to withdraw a backend.
       */
      const tmuxProbe = probes.find((p) => p.name === "tmux");
      const backends = {
        cmux: cmux.probe.ok && !cmux.probeFailed && cmux.missingCommands.length === 0,
        tmux: tmuxProbe?.ok === true && tmuxProbe.floor?.status !== "below",
        headless: true, // always available — the acceptance suite runs on it
      };

      const ok = diagnoses.length === 0;
      // Sorted and de-duplicated so a machine caller can branch on WHICH kinds
      // of problem were found without walking the array — the question the
      // exit code deliberately does not answer (see `exitForDiagnoses`).
      const diagnosisClasses = [...new Set(diagnoses.map((d) => d.class))].sort();
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok,
              config: configDetail,
              probes,
              backends,
              cmux: {
                socket_mode: cmux.socketMode,
                missing_commands: cmux.missingCommands,
                // Reported, never required (ISC-132): the run succeeds
                // identically either way, but the operator must be able to
                // tell a missing diagnostic from a broken one.
                optional_capabilities: cmux.optional,
              },
              images,
              mounts: { runs_dir: mount.dir, visible: mount.visible, detail: mount.detail },
              omlx: {
                ok: omlx.ok,
                base_url: omlx.baseUrl,
                // Which vantage the numbers below were measured from
                // (ISC-260). A consumer that treats them as the fleet's view
                // of oMLX is now wrong in a way it can detect.
                vantage: omlx.vantage,
                models: omlx.models,
                list_latency_ms: omlx.listLatencyMs,
                completion_latency_ms: omlx.completionLatencyMs,
                probe_model: omlx.model,
                detail: omlx.detail,
              },
              diagnoses,
              diagnosis_classes: diagnosisClasses,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`config: ${configDetail}`);
        for (const p of probes) {
          console.log(`${p.ok ? "ok  " : "MISS"} ${p.name}${p.required ? " (required)" : ""}: ${p.detail}`);
        }
        console.log(`backends: ${Object.entries(backends).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(" ")}`);
        if (cmux.probe.ok) console.log(`cmux socket mode: ${cmux.socketMode}`);
        for (const c of cmux.optional) {
          console.log(`cmux ${c.name}: ${c.ok ? "available" : "unavailable"}${c.detail ? ` — ${c.detail}` : ""}`);
        }
        for (const i of images) console.log(`image ${i.present ? "present" : "ABSENT "}: ${i.tag}`);
        console.log(`mounts: runs dir ${mount.visible ? "visible" : "NOT VISIBLE"} — ${mount.detail}`);
        console.log(
          `omlx (from ${omlx.vantage}): ${omlx.ok ? "ok" : "FAIL"} ${omlx.detail}` +
            (omlx.listLatencyMs !== null ? ` — /models ${omlx.listLatencyMs}ms` : "") +
            (omlx.completionLatencyMs !== null
              ? `, 1-token completion ${omlx.completionLatencyMs}ms (${omlx.model})`
              : ""),
        );
        // The class leads, so the terminal reader sorts findings by what they
        // have to DO about them without reading every message to the end.
        for (const d of diagnoses) console.log(`DIAGNOSIS [${d.class}] ${d.name}: ${d.message}`);
      }

      if (!ok) {
        throw new CliError(
          diagnoses.map((d) => `[${d.class}] ${d.name}: ${d.message}`).join("; "),
          exitForDiagnoses(diagnoses),
        );
      }
    });
}
