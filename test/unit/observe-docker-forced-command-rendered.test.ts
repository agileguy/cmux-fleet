/**
 * The forced command run for real (SRD-OBSERVER-ROLES §5.4): every verb, against a throwaway daemon,
 * under that image's `/bin/sh`, once per docker CLI version in
 * `test/fixtures/observe/docker-forced-command-rendered.json`.
 *
 * `observe-docker-forced-command.test.ts` runs the script against a fake `docker` and pins the argv it
 * builds — it cannot see a template a real CLI refuses to render, such as a field a given docker
 * version's `ps` formatter does not have (`HealthStatus`, absent before 29.5.0, exits 1 rather than
 * rendering null). This file guards against that: it reads what real CLIs did with the real script.
 *
 * The fixture is MEASURED by `scripts/observe/characterise-docker --write-rendered` and never edited by
 * hand. Each run records the sha256 of the forced command it ran, so any edit to that file fails here
 * until it has been measured again on every version.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FORCED_COMMAND = join(ROOT, "scripts", "observe", "docker-forced-command");
const SRC = readFileSync(FORCED_COMMAND, "utf8");
const SRC_SHA256 = createHash("sha256").update(SRC).digest("hex");

type Case = {
  command: string;
  env?: string[];
  exit: number;
  timed_out: boolean;
  lines: number;
  key_sets: string[][] | null;
  canaries_seen: string[];
  state_keys?: string[] | null;
  health?: unknown;
  timestamp_prefix_bytes?: number;
  actions?: string[];
  actions_raw?: string[];
  containers_seen?: string[];
};

type TemplateRun = { template: string; exit: number; stderr_first_line: string };

type DockerError = { command: string; env?: string[]; user?: string; exit: number; timed_out: boolean; stderr_first_line: string };

type RenderedRun = {
  measured_with: { client_version: string; uncommitted_changes_to_measured_files: string[] | null };
  forced_command_sha256: string;
  shell: string;
  default_ps_key_set: string[];
  ps_health_status: string;
  ps_healthstatus_template: TemplateRun;
  inspect_health_forms: { if_form: TemplateRun; index_form: TemplateRun };
  docker_errors: Record<"daemon_unreachable" | "socket_permission_denied" | "no_such_container", DockerError>;
  events_prefix_match: Record<string, string[]>;
  cases: Case[];
  matching: { events_container_filter: Record<string, string[]>; ps_name_filter: Record<string, string[]> };
};

/** MEASURED, never hand-typed. */
const RENDERED = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "observe", "docker-forced-command-rendered.json"), "utf8"),
) as { runs: Record<string, RenderedRun> };
const SHAPES = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "observe", "docker-cli-shapes.json"), "utf8")) as {
  events: { action_allowlist: { filters: string[] } };
};

/** Reads a `NAME='...'` single-quoted shell assignment out of the real script. */
function extractSingleQuoted(varName: string): string {
  const value = SRC.match(new RegExp(`${varName}='([^']*)'`))?.[1];
  if (value === undefined) throw new Error(`could not find ${varName}='...' in ${FORCED_COMMAND}`);
  return value;
}

/** A template's output with every `{{json ...}}` as null: `{{with}}` blocks take their `{{else}}` branch. */
function templateShape(template: string): Record<string, unknown> {
  const flat = template.replace(/\{\{with [^}]*\}\}.*?\{\{else\}\}(.*?)\{\{end\}\}/g, "$1").replace(/\{\{json [^}]*\}\}/g, "null");
  return JSON.parse(flat) as Record<string, unknown>;
}

/** The keys of the object a template's first `{{with}}` block renders when its value is present. */
function withBranchKeys(template: string): string[] {
  const branch = template.match(/\{\{with [^}]*\}\}(.*?)\{\{else\}\}/)?.[1];
  if (branch === undefined) throw new Error("the template has no {{with}} block");
  return Object.keys(JSON.parse(branch.replace(/\{\{json [^}]*\}\}/g, "null")) as object).sort();
}

const sortedKeys = (value: unknown): string[] => Object.keys(value as object).sort();

/** True when docker version `a` is older than `b`, comparing major, minor and patch. */
function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((p) => Number.parseInt(p, 10));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

const PS_SHAPE = templateShape(extractSingleQuoted("PS_FORMAT"));
const INSPECT_FORMAT = extractSingleQuoted("INSPECT_FORMAT");
const INSPECT_SHAPE = templateShape(INSPECT_FORMAT);
const INFO_SHAPE = templateShape(extractSingleQuoted("INFO_FORMAT"));
const ALLOWED_ACTIONS = SHAPES.events.action_allowlist.filters.filter((w) => w.startsWith("event=")).map((w) => w.slice("event=".length));
/** Where docker CLIs stopped lacking `HealthStatus` in `ps`: coverage must straddle it. */
const PS_HEALTHSTATUS_ADDED_IN = "29.5.0";

const runs = Object.entries(RENDERED.runs);

test("the fixture covers a docker CLI older than 29.5.0 and one at or after it", () => {
  const versions = runs.map(([, run]) => run.measured_with.client_version);
  expect(versions.some((v) => olderThan(v, PS_HEALTHSTATUS_ADDED_IN))).toBe(true);
  expect(versions.some((v) => !olderThan(v, PS_HEALTHSTATUS_ADDED_IN))).toBe(true);
});

for (const [version, run] of runs) {
  const cases = (prefix: string) => {
    const found = run.cases.filter((c) => c.command === prefix || c.command.startsWith(`${prefix} `));
    if (found.length === 0) throw new Error(`docker ${version}: no "${prefix}" case in the fixture`);
    return found;
  };
  const one = (command: string) => {
    const found = run.cases.find((c) => c.command === command);
    if (!found) throw new Error(`docker ${version}: no "${command}" case in the fixture`);
    return found;
  };

  describe(`docker ${version}`, () => {
    test("measured the forced command as it is now (after any edit, re-run characterise-docker --write-rendered on each version)", () => {
      expect(run.forced_command_sha256).toBe(SRC_SHA256);
      expect(run.measured_with.uncommitted_changes_to_measured_files).toEqual([]);
    });

    test("every allowed verb exited 0 and the refused restart exited 77, none by timeout", () => {
      for (const c of run.cases) {
        expect({ command: c.command, exit: c.exit, timed_out: c.timed_out }).toEqual({
          command: c.command,
          exit: c.command.startsWith("restart ") ? 77 : 0,
          timed_out: false,
        });
      }
      for (const verb of ["ps", "inspect", "logs", "stats", "top", "events", "info", "version", "restart"]) cases(verb);
    });

    test("no case returned an environment value, a bind-mount target or command-line text", () => {
      for (const c of run.cases) expect({ command: c.command, canaries_seen: c.canaries_seen }).toEqual({ command: c.command, canaries_seen: [] });
    });

    test("ps rows carry exactly the ps template's keys", () => {
      for (const c of cases("ps")) expect(c.key_sets).toEqual([sortedKeys(PS_SHAPE)]);
    });

    test("docker's own ps row has HealthStatus only from 29.5.0, so the template leaves it out and Status shows health", () => {
      const hasField = !olderThan(run.measured_with.client_version, PS_HEALTHSTATUS_ADDED_IN);
      expect(run.default_ps_key_set.includes("HealthStatus")).toBe(hasField);
      const template = run.ps_healthstatus_template;
      expect({ renders: template.exit === 0, no_such_field: template.stderr_first_line.includes("can't evaluate field HealthStatus") }).toEqual({
        renders: hasField,
        no_such_field: !hasField,
      });
      expect(Object.keys(PS_SHAPE)).not.toContain("HealthStatus");
      expect(run.ps_health_status).toContain("(healthy)");
    });

    test("the caller's IFS did not change the ps result", () => {
      const [plain, withIfs, ...rest] = run.cases.filter((c) => c.command === "ps all name=char-plain label=char.label=one");
      expect(rest).toEqual([]);
      expect(plain?.env).toBeUndefined();
      expect(withIfs?.env).toEqual(["IFS=:"]);
      expect({ exit: withIfs?.exit, lines: withIfs?.lines, key_sets: withIfs?.key_sets }).toEqual({
        exit: 0,
        lines: plain?.lines,
        key_sets: plain?.key_sets,
      });
    });

    test("inspect reads Health with index, because the if form fails on a container without a healthcheck", () => {
      const { if_form, index_form } = run.inspect_health_forms;
      expect(if_form.exit).not.toBe(0);
      expect(if_form.stderr_first_line).toContain('map has no entry for key "Health"');
      expect({ exit: index_form.exit, stderr_first_line: index_form.stderr_first_line }).toEqual({ exit: 0, stderr_first_line: "" });
      expect(if_form.template).toContain("{{if .State.Health}}");
      expect(index_form.template).toContain('{{with index .State "Health"}}');
      expect(INSPECT_FORMAT).toContain('{{with index .State "Health"}}');
    });

    test("inspect carries exactly the inspect template's keys, health included", () => {
      for (const c of cases("inspect")) {
        expect(c.key_sets).toEqual([sortedKeys(INSPECT_SHAPE)]);
        expect(c.state_keys).toEqual(sortedKeys(INSPECT_SHAPE.state));
      }
      expect(one("inspect char-plain").health).toBeNull();
      expect(one("inspect char-exited").health).toBeNull();
      expect(sortedKeys(one("inspect char-hc").health)).toEqual(withBranchKeys(INSPECT_FORMAT));
    });

    test("info carries exactly the info template's keys", () => {
      expect(one("info").key_sets).toEqual([sortedKeys(INFO_SHAPE)]);
    });

    test("logs returned the five lines tail=5 asked for, each behind a 31-byte timestamp prefix", () => {
      const logs = one("logs char-logs since=600s tail=5");
      expect(logs.lines).toBe(5);
      expect(logs.timestamp_prefix_bytes).toBe(31);
    });

    test("logs read tail=08 as decimal under busybox sh: eight lines", () => {
      expect(one("logs char-logs since=600s tail=08").lines).toBe(8);
    });

    test("docker's own failures exit 1, and each probe hit the failure it is named for", () => {
      const { daemon_unreachable, socket_permission_denied, no_such_container } = run.docker_errors;
      for (const e of [daemon_unreachable, socket_permission_denied, no_such_container]) {
        expect({ command: e.command, exit: e.exit, timed_out: e.timed_out }).toEqual({ command: e.command, exit: 1, timed_out: false });
      }
      expect(daemon_unreachable.stderr_first_line).toMatch(/failed to connect to the docker API|Cannot connect to the Docker daemon/);
      expect(socket_permission_denied.user).toBe("nobody");
      expect(socket_permission_denied.stderr_first_line).toContain("permission denied while trying to connect to the");
      expect(no_such_container.stderr_first_line).toContain("No such container: char-nosuch");
    });

    test("events returned only allowlisted actions, and container= kept to that container", () => {
      for (const c of cases("events")) for (const action of c.actions ?? []) expect(ALLOWED_ACTIONS).toContain(action);
      expect(one("events since=120s container=char-hc").containers_seen).toEqual(["char-hc"]);
    });

    test("every events case recorded start and health_status actions", () => {
      // The allowlist check above walks `c.actions ?? []`, so an empty array would pass it.
      for (const c of cases("events")) {
        expect(c.actions).toContain("start");
        expect(c.actions).toContain("health_status");
        expect(c.actions_raw?.some((a) => a.startsWith("health_status: "))).toBe(true);
      }
    });

    test("beside event=health_status the daemon matches event= values as prefixes", () => {
      expect(run.events_prefix_match["event=exec"]).toEqual([]);
      expect(run.events_prefix_match["event=exec event=health_status"]).toEqual(
        expect.arrayContaining(["exec_create", "exec_start", "exec_die"]),
      );
    });

    test("ran under busybox sh, the shell this fixture covers", () => {
      expect(run.shell).toContain("busybox");
    });

    // The skill tells a worker to check every returned name because neither filter is exact. `name=w.b`
    // matching all four names separates a regular expression from a substring match, which would match none;
    // `container=w.b` matching none shows container= is not one, and an id prefix shows it also reads ids.
    test("events container= matches a name or id prefix, and ps name= an unanchored regular expression over names", () => {
      expect(run.matching.events_container_filter).toEqual({
        "container=web": ["web", "web-2", "webhook"],
        "container=ebh": [],
        "container=w.b": [],
        "container=<first 12 characters of web's id>": ["web"],
      });
      expect(run.matching.ps_name_filter).toEqual({
        "name=web": ["myweb", "web", "web-2", "webhook"],
        "name=w.b": ["myweb", "web", "web-2", "webhook"],
        "name=eb": ["myweb", "web", "web-2", "webhook"],
        "name=<first 12 characters of web's id>": [],
      });
    });
  });
}
