import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { loadBackend } from "../../backends/registry.ts";
import { ConfigError, loadConfig, type LoadedConfig } from "../../config/load.ts";
import { resolveAllWorkers } from "../../config/load.ts";
import { imageTag } from "../../container/image.ts";
import { probeMountVisibility, type MountVisibility } from "../../container/mounts.ts";
import { realExec, type Exec } from "../../container/run.ts";
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

interface Probe {
  name: string;
  ok: boolean;
  required: boolean;
  version?: string;
  detail: string;
}

interface Diagnosis {
  name: string;
  message: string;
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
  return {
    name,
    ok,
    required,
    ...(version !== undefined ? { version } : {}),
    detail: ok ? (version ?? "") : `not available (${argv[0]} exited ${r.code ?? "on timeout"})`,
  };
}

interface CmuxReport {
  probe: Probe;
  socketMode: string | null;
  missingCommands: string[];
  diagnoses: Diagnosis[];
}

async function probeCmux(exec: Exec, env: Record<string, string | undefined>): Promise<CmuxReport> {
  const probe = await versionProbe(exec, "cmux", ["cmux", "--version"], false);
  const report: CmuxReport = { probe, socketMode: null, missingCommands: [], diagnoses: [] };
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
      if (c.required && !c.ok) report.missingCommands.push(c.name);
    }
  } catch (err) {
    report.diagnoses.push({
      name: "cmux-probe-failed",
      message: `cmux capability probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (report.missingCommands.length > 0) {
    report.diagnoses.push({
      name: "cmux-required-command-missing",
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
      message: 'socketControlMode is "allowAll" — any local process can drive cmux; use "password" mode',
    });
  } else if (report.socketMode === "cmuxOnly" && !insidePane) {
    report.diagnoses.push({
      name: "cmux-socket-unreachable",
      message:
        'socketControlMode is "cmuxOnly" and pifleet is running outside a pane — every socket call would be refused; use "password" mode',
    });
  }
  return report;
}

interface OmlxReport {
  ok: boolean;
  baseUrl: string;
  models: string[];
  /** GET /v1/models round-trip, milliseconds. */
  listLatencyMs: number | null;
  /** One tiny chat completion, milliseconds — the number that sizes max_concurrent. */
  completionLatencyMs: number | null;
  model: string | null;
  detail: string;
}

async function probeOmlx(loaded: LoadedConfig | null): Promise<OmlxReport> {
  const configured = loaded?.config.llm.base_url ?? "http://host.docker.internal:8000/v1";
  // Doctor runs on the host: the container-facing hostname does not resolve here.
  const baseUrl = configured.replace("host.docker.internal", "localhost");
  const keyEnv = loaded?.config.llm.api_key_env ?? "OMLX_API_KEY";
  const key = process.env[keyEnv] ?? "";
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const report: OmlxReport = {
    ok: false,
    baseUrl,
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

  // Measured single-request latency (ISC-55): one minimal completion against
  // the configured default model, or the first served model when no config.
  const model = loaded?.config.llm.model ?? report.models[0] ?? null;
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

      probes.push(
        await versionProbe(exec, "docker", ["docker", "version", "--format", "{{.Server.Version}}"], true),
      );
      probes.push(await versionProbe(exec, "git", ["git", "--version"], true));
      probes.push(await versionProbe(exec, "pi", ["pi", "--version"], false));
      probes.push(await versionProbe(exec, "tmux", ["tmux", "-V"], false));

      const cmux = await probeCmux(exec, process.env);
      probes.push(cmux.probe);
      diagnoses.push(...cmux.diagnoses);

      // Image status per toolchain the config actually uses (SRD §11 probe list).
      const images: { tag: string; present: boolean }[] = [];
      const dockerOk = probes[0]?.ok === true;
      if (loaded !== null && dockerOk) {
        const toolchains = [...new Set(resolveAllWorkers(loaded).map((w) => w.toolchain))];
        for (const tc of toolchains) {
          const tag = imageTag(loaded.config, tc);
          const r = await exec(["docker", "image", "inspect", tag, "--format", "{{.Id}}"]);
          images.push({ tag, present: r.code === 0 });
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
          diagnoses.push({ name: "runs-dir-not-mountable", message: r.detail });
        }
      } else {
        mount.detail = dockerOk ? "no worker image built yet" : "docker unavailable";
      }

      const omlx = await probeOmlx(loaded);

      for (const p of probes) {
        if (p.required && !p.ok) {
          diagnoses.push({ name: `${p.name}-unavailable`, message: p.detail });
        }
      }

      const backends = {
        cmux: cmux.probe.ok && cmux.missingCommands.length === 0,
        tmux: probes.find((p) => p.name === "tmux")?.ok ?? false,
        headless: true, // always available — the acceptance suite runs on it
      };

      const ok = diagnoses.length === 0;
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok,
              config: configDetail,
              probes,
              backends,
              cmux: { socket_mode: cmux.socketMode, missing_commands: cmux.missingCommands },
              images,
              mounts: { runs_dir: mount.dir, visible: mount.visible, detail: mount.detail },
              omlx: {
                ok: omlx.ok,
                base_url: omlx.baseUrl,
                models: omlx.models,
                list_latency_ms: omlx.listLatencyMs,
                completion_latency_ms: omlx.completionLatencyMs,
                probe_model: omlx.model,
                detail: omlx.detail,
              },
              diagnoses,
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
        for (const i of images) console.log(`image ${i.present ? "present" : "ABSENT "}: ${i.tag}`);
        console.log(`mounts: runs dir ${mount.visible ? "visible" : "NOT VISIBLE"} — ${mount.detail}`);
        console.log(
          `omlx: ${omlx.ok ? "ok" : "FAIL"} ${omlx.detail}` +
            (omlx.listLatencyMs !== null ? ` — /models ${omlx.listLatencyMs}ms` : "") +
            (omlx.completionLatencyMs !== null
              ? `, 1-token completion ${omlx.completionLatencyMs}ms (${omlx.model})`
              : ""),
        );
        for (const d of diagnoses) console.log(`DIAGNOSIS ${d.name}: ${d.message}`);
      }

      if (!ok) {
        throw new CliError(
          diagnoses.map((d) => `${d.name}: ${d.message}`).join("; "),
          EXIT.BACKEND_UNAVAILABLE,
        );
      }
    });
}
