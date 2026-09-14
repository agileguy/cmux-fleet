/**
 * The forced command run for real (SRD-OBSERVER-ROLES §5.4): every verb, against a throwaway daemon,
 * under that image's `/bin/sh`, once per docker CLI version in
 * `test/fixtures/observe/docker-forced-command-rendered.json`.
 *
 * `observe-docker-forced-command.test.ts` runs the script against a fake `docker` and pins the argv it
 * builds. That cannot see a template a real CLI refuses to render. The `ps` template once named
 * `HealthStatus`, which docker CLIs before 29.5.0 do not have, and every `ps` on such a target exited 1
 * while all of those tests passed. This file reads what real CLIs did with the real script.
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
  exit: number;
  timed_out: boolean;
  lines: number;
  key_sets: string[][] | null;
  canaries_seen: string[];
  state_keys?: string[] | null;
  health?: unknown;
  timestamp_prefix_bytes?: number;
  actions?: string[];
  containers_seen?: string[];
};

type RenderedRun = {
  measured_with: { client_version: string; uncommitted_changes_to_measured_files: string[] | null };
  forced_command_sha256: string;
  shell: string;
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

    test("events returned only allowlisted actions, and container= kept to that container", () => {
      for (const c of cases("events")) for (const action of c.actions ?? []) expect(ALLOWED_ACTIONS).toContain(action);
      expect(one("events since=120s container=char-hc").containers_seen).toEqual(["char-hc"]);
    });

    test("ran under busybox sh, the shell this fixture covers", () => {
      expect(run.shell).toContain("busybox");
    });

    // The skill tells a worker to check every returned name because neither filter is exact. `name=w.b`
    // matching all four names separates a regular expression from a substring match, which would match none.
    test("events container= matches a name prefix, and ps name= an unanchored regular expression", () => {
      expect(run.matching.events_container_filter).toEqual({
        "container=web": ["web", "web-2", "webhook"],
        "container=eb": [],
      });
      expect(run.matching.ps_name_filter).toEqual({
        "name=web": ["myweb", "web", "web-2", "webhook"],
        "name=w.b": ["myweb", "web", "web-2", "webhook"],
        "name=eb": ["myweb", "web", "web-2", "webhook"],
      });
    });
  });
}
