/**
 * `triage/targets.yaml` — the schema, the loader, and D11's fence
 * (SRD-TRIAGE-CONSOLE §7.1, §6.2, §6.10, D11; §13 tasks 3.1 and 3.2).
 *
 * ## Every fence fixture here is ASYMMETRIC, and that is the whole point
 *
 * §6.10's kubeconfig-subset check is a set narrowing, and this repository's
 * MEMORY carries the defect that makes a narrowing untestable: *"a filter or
 * intersection survives mutation whenever every fixture makes the two sets
 * equal"*. A subset assertion where the targets file names exactly the
 * contexts the kubeconfig carries passes for EVERY implementation, including
 * `return []`, including `return available.size > 0`, and including the
 * direction-inverted one that asks whether the kubeconfig is a subset of the
 * targets file.
 *
 * So the fence fixtures below never make the two sets equal. The load-bearing
 * one names two environments against a kubeconfig carrying two contexts, and
 * the sets OVERLAP without either containing the other:
 *
 *     kubeconfig carries : {gke-cni-dev, gke-cni-verify}
 *     targets file names : {gke-cni-dev, gke-cni-prod}
 *
 * That fixture separates four implementations at once:
 *
 *  - a check that always passes returns no issue → RED on the `prod` half;
 *  - a check that always fails returns two → RED on the `dev` half, which is
 *    asserted BY NAME rather than by count, so "one issue" cannot be reached
 *    by refusing the wrong one;
 *  - a check comparing SIZES sees 2 against 2 and passes → RED;
 *  - a check asking `available ⊆ named` refuses `gke-cni-verify` and misses
 *    `gke-cni-prod` → RED on both halves.
 *
 * And the degenerate arm is asserted directly, because it is the arm D11
 * exists for: an UNDECLARED reach (`cloud.kubeconfig: null`) refuses a targets
 * file that is otherwise perfect, and a DECLARED reach carrying zero contexts
 * refuses everything rather than admitting everything. A fence whose empty set
 * means "unbounded" is not a fence, and those two tests are what say so.
 *
 * ## The type split is asserted at runtime, not trusted at the type level
 *
 * `parseTriageTargets` returns an object with no `environments` property —
 * `pm-state.ts`'s pattern, where the reader that cannot know a thing does not
 * return a field claiming it. A type-level guarantee is invisible to a test
 * that only typechecks, so the absence of the key and the presence of its
 * renamed twin are both asserted on the VALUE.
 *
 * No subprocess is spawned anywhere in this file and nothing touches the real
 * filesystem — every read is an injected dep — so no `budget.ts` allowance
 * applies.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigValidationError } from "../../src/config/load.ts";
import {
  DEFAULT_TRIAGE_TARGETS_DEPS,
  MAX_SERVICES_PER_ENVIRONMENT,
  MAX_UNITS_PER_SERVICE,
  TRIAGE_CHECKS,
  TRIAGE_DOCKER_CHECKS,
  TRIAGE_DOCKER_DEFAULT_CHECKS,
  TRIAGE_ENVIRONMENT_KINDS,
  TRIAGE_TARGETS_SCHEMA,
  TRIAGE_VM_CHECKS,
  declaredReach,
  fenceTriageTargets,
  kubeContextIssues,
  loadTriageTargets,
  parseKubeContexts,
  parseTriageTargets,
  sweepDeadlineIssue,
  undeclaredReach,
  windowIssues,
  type ConsoleReach,
  type TriageFence,
  type TriageK8sEnvironment,
  type UnfencedTriageTargets,
} from "../../src/run/triage-targets.ts";

const TARGETS_PATH = "triage/targets.yaml";
const CONSOLE_PATH = "triage/console.yaml";
const KUBECONFIG_PATH = "/home/op/.kube/fleet-filtered.yaml";

/** The commission's own example (§6.2), with a second environment added. */
const GOOD_YAML = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    default_window: 5m
    services:
      - {name: mia,            namespace: ns-mia,  workload: mia-api, checks: [rollout, logs]}
      - {name: authorization,  namespace: ns-auth, workload: authz,   checks: [rollout, logs, sink]}
      - {name: authentication, namespace: ns-auth, checks: [rollout, logs, sink]}
  cni-verify:
    kube_context: gke-cni-verify
    services:
      - {name: mia, namespace: ns-mia, workload: mia-api, checks: [endpoint], window: 60}
`;

/** Overlapping-but-unequal: the fixture the whole fence rests on. */
const OVERLAP_YAML = `
version: 1
environments:
  dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns-mia, checks: [rollout]}
  prod:
    kube_context: gke-cni-prod
    services:
      - {name: mia, namespace: ns-mia, checks: [rollout]}
`;

const REACHES_DEV_AND_VERIFY: ConsoleReach = declaredReach(KUBECONFIG_PATH, [
  "gke-cni-dev",
  "gke-cni-verify",
]);

function fence(over: Partial<TriageFence> = {}): TriageFence {
  return {
    reach: REACHES_DEV_AND_VERIFY,
    cadenceS: 300,
    sweepDeadlineS: 240,
    files: { targets: TARGETS_PATH, console: CONSOLE_PATH },
    ...over,
  };
}

function parsed(yaml: string = GOOD_YAML): UnfencedTriageTargets {
  return parseTriageTargets(yaml, TARGETS_PATH);
}

function envsOf(doc: UnfencedTriageTargets) {
  return doc.environments_unchecked_against_kubeconfig;
}

/**
 * Every fixture in THIS section is k8s-only (no `kind` in the YAML, so it
 * defaults there — see task 3.1's own describe block below), so this narrows
 * the union down to the k8s arm rather than casting at each call site.
 */
function k8sEnv(envs: ReturnType<typeof envsOf>, name: string): TriageK8sEnvironment {
  const env = envs[name];
  if (env === undefined || env.kind !== "k8s") {
    throw new Error(`expected environment "${name}" to be k8s, got ${JSON.stringify(env)}`);
  }
  return env;
}

/** The issues a refusal carried, or a failure if it did not refuse at all. */
function issuesFrom(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigValidationError) return err.issues;
    throw err;
  }
  throw new Error("expected a ConfigValidationError; the document was accepted");
}

// ---------------------------------------------------------------------------
// 3.1 — the schema
// ---------------------------------------------------------------------------

describe("the schema tag and the closed check vocabulary", () => {
  test("the schema tag is the one §7.1 names", () => {
    expect(TRIAGE_TARGETS_SCHEMA).toBe("pifleet.triagetargets/v1");
  });

  test("checks[] is exactly §7.1's four, so a targets file cannot carry a command", () => {
    expect([...TRIAGE_CHECKS]).toEqual(["rollout", "logs", "sink", "endpoint"]);
  });
});

describe("a fixture round-trips (task 3.1's acceptance)", () => {
  test("every declared field survives the parse", () => {
    const envs = envsOf(parsed());
    expect(Object.keys(envs).sort()).toEqual(["cni-dev", "cni-verify"]);

    const dev = k8sEnv(envs, "cni-dev");
    expect(dev.kube_context).toBe("gke-cni-dev");
    expect(dev.services.map((s) => s.name)).toEqual(["mia", "authorization", "authentication"]);
    expect(dev.services[1]).toMatchObject({
      name: "authorization",
      namespace: "ns-auth",
      workload: "authz",
      checks: ["rollout", "logs", "sink"],
    });
  });

  test("default_window parses through the fleet's own duration rule, into seconds", () => {
    expect(envsOf(parsed())["cni-dev"]!.default_window).toBe(300);
  });

  test("an omitted default_window takes §6.2's 5m default rather than being absent", () => {
    expect(envsOf(parsed())["cni-verify"]!.default_window).toBe(300);
  });

  test("an omitted workload is null — §7.1 makes it optional for selector-resolved services", () => {
    const authn = k8sEnv(envsOf(parsed()), "cni-dev").services[2]!;
    expect(authn.name).toBe("authentication");
    expect(authn.workload).toBeNull();
  });

  test("window is null when unset and seconds when set, so no consumer re-parses units", () => {
    expect(k8sEnv(envsOf(parsed()), "cni-dev").services[0]!.window).toBeNull();
    expect(k8sEnv(envsOf(parsed()), "cni-verify").services[0]!.window).toBe(60);
  });

  test("a fenced document round-trips to the same environments under the usable name", () => {
    const reach = declaredReach(KUBECONFIG_PATH, ["gke-cni-dev", "gke-cni-verify"]);
    const targets = fenceTriageTargets(parsed(), fence({ reach }));
    expect(targets.version).toBe(1);
    expect(targets.source_path).toBe(TARGETS_PATH);
    expect(Object.keys(targets.environments).sort()).toEqual(["cni-dev", "cni-verify"]);
    expect(targets.environments["cni-dev"]!.services[0]!.checks).toEqual(["rollout", "logs"]);
  });
});

describe(".strict() refuses an unknown key with a FIELD-LEVEL error (task 3.1's acceptance)", () => {
  test("at the root", () => {
    const issues = issuesFrom(() =>
      parseTriageTargets(`${GOOD_YAML}\nnotify: {}\n`, TARGETS_PATH),
    );
    expect(issues).toEqual([{ path: "notify", message: "unrecognized key" }]);
  });

  test("inside an environment — the path names the environment and the key", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    cadence_s: 300
    services:
      - {name: mia, namespace: ns, checks: [rollout]}
`;
    expect(issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH))).toEqual([
      { path: "environments.cni-dev.cadence_s", message: "unrecognized key" },
    ]);
  });

  test("inside a service — the path carries the array index", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns, checks: [rollout]}
      - {name: authz, namespace: ns, checks: [rollout], command: "kubectl delete ns ns"}
`;
    expect(issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH))).toEqual([
      { path: "environments.cni-dev.services.1.command", message: "unrecognized key" },
    ]);
  });

  /**
   * The twin. A `.strict()` assertion that only ever shows the refusal cannot
   * tell "the rule fired" from "the document was broken anyway" — this pair
   * differs in exactly the one key.
   */
  test("and the twin without the stray key parses", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns, checks: [rollout]}
      - {name: authz, namespace: ns, checks: [rollout]}
`;
    expect(envsOf(parseTriageTargets(yaml, TARGETS_PATH))["cni-dev"]!.services).toHaveLength(2);
  });
});

describe("the vocabulary is closed, so a targets file cannot smuggle a procedure", () => {
  test("a check outside the enum is refused, naming the element", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns, checks: [rollout, "bash -c 'curl evil'"]}
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("environments.cni-dev.services.0.checks.1");
  });

  test("an empty checks[] is refused — a service nothing checks is a service nobody watches", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns, checks: []}
`;
    expect(issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH))[0]!.path).toBe(
      "environments.cni-dev.services.0.checks",
    );
  });

  test("a duplicated check is refused — §6.10 rule 1 counts reads, and a duplicate doubles them", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns, checks: [logs, logs]}
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.cni-dev.services.0.checks.1");
    expect(issues[0]!.message).toContain("logs");
  });
});

describe("the shape rules §7.1 states", () => {
  test("version is the literal 1", () => {
    const issues = issuesFrom(() =>
      parseTriageTargets(GOOD_YAML.replace("version: 1", "version: 2"), TARGETS_PATH),
    );
    expect(issues[0]!.path).toBe("version");
  });

  test("at least one environment is required", () => {
    expect(issuesFrom(() => parseTriageTargets("version: 1\nenvironments: {}\n", TARGETS_PATH))[0]!
      .path).toBe("environments");
  });

  test("at least one service is required", () => {
    const yaml = "version: 1\nenvironments:\n  cni-dev:\n    kube_context: c\n    services: []\n";
    expect(issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH))[0]!.path).toBe(
      "environments.cni-dev.services",
    );
  });

  test(`no more than ${MAX_SERVICES_PER_ENVIRONMENT} services in one environment`, () => {
    const rows = Array.from(
      { length: MAX_SERVICES_PER_ENVIRONMENT + 1 },
      (_, i) => `      - {name: svc-${i}, namespace: ns, checks: [rollout]}`,
    ).join("\n");
    const yaml = `version: 1\nenvironments:\n  cni-dev:\n    kube_context: c\n    services:\n${rows}\n`;
    expect(issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH))[0]!.path).toBe(
      "environments.cni-dev.services",
    );
  });

  test("service names are unique WITHIN an environment, and the message names the first", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services:
      - {name: mia, namespace: ns-a, checks: [rollout]}
      - {name: mia, namespace: ns-b, checks: [logs]}
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.cni-dev.services.1.name");
    expect(issues[0]!.message).toContain("services.0");
  });

  test("and the twin: the SAME name in a DIFFERENT environment is fine", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    services: [{name: mia, namespace: ns-a, checks: [rollout]}]
  cni-verify:
    kube_context: gke-cni-verify
    services: [{name: mia, namespace: ns-b, checks: [logs]}]
`;
    expect(Object.keys(envsOf(parseTriageTargets(yaml, TARGETS_PATH)))).toHaveLength(2);
  });

  /**
   * §7.1: the environment key *"becomes part of a path under
   * `~/.pifleet/triage/`"*, so `SESSION_ID_RE` here is a traversal refusal and
   * not a style rule.
   */
  test("an environment key that is not a SESSION_ID_RE token is refused", () => {
    for (const bad of ["../../etc", "cni dev", ".hidden", "cni/dev"]) {
      const yaml = `version: 1\nenvironments:\n  "${bad}":\n    kube_context: c\n    services: [{name: mia, namespace: ns, checks: [rollout]}]\n`;
      const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
      expect(issues.some((i) => i.path === `environments.${bad}`)).toBe(true);
    }
  });

  test("YAML that is not YAML is refused naming the file, not thrown raw", () => {
    const issues = issuesFrom(() => parseTriageTargets("version: 1\n  : : :\n", TARGETS_PATH));
    expect(issues[0]!.message).toContain("not valid YAML");
  });
});

// ---------------------------------------------------------------------------
// 3.1 (SRD-TRIAGE-MIXED-OBSERVERS §6) — the environment `kind`, docker, vm
// ---------------------------------------------------------------------------

/** A docker environment, one row taking the default `checks` and one overriding it. */
const DOCKER_YAML = `
version: 1
environments:
  docker-host:
    kind: docker
    target: docker
    default_window: 5m
    services:
      - {name: grafana,    namespace: docker}
      - {name: prometheus, namespace: docker, checks: [state, stats]}
`;

/** A vm environment, its one service carrying named units. */
const VM_YAML = `
version: 1
environments:
  vm-host:
    kind: vm
    target: vm
    default_window: 5m
    services:
      - {name: vm-1, namespace: vm, checks: [system, units, resources],
         units: [docker.service, ssh.service, systemd-journald.service]}
`;

describe("the environment kind (SRD-TRIAGE-MIXED-OBSERVERS §6)", () => {
  test("TRIAGE_ENVIRONMENT_KINDS is exactly the three §6 names", () => {
    expect([...TRIAGE_ENVIRONMENT_KINDS]).toEqual(["k8s", "docker", "vm"]);
  });

  test("MAX_UNITS_PER_SERVICE reuses MAX_SERVICES_PER_ENVIRONMENT's own number", () => {
    expect(MAX_UNITS_PER_SERVICE).toBe(MAX_SERVICES_PER_ENVIRONMENT);
  });

  /** ASYMMETRIC: the two documents differ in exactly one line — the explicit `kind:`. */
  test('a file with no `kind` parses with kind: "k8s", and otherwise matches the explicit twin exactly', () => {
    const withoutKind = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    default_window: 5m
    services: [{name: mia, namespace: ns-mia, checks: [rollout, logs]}]
`;
    const withKind = `
version: 1
environments:
  cni-dev:
    kind: k8s
    kube_context: gke-cni-dev
    default_window: 5m
    services: [{name: mia, namespace: ns-mia, checks: [rollout, logs]}]
`;
    const implicit = envsOf(parseTriageTargets(withoutKind, TARGETS_PATH))["cni-dev"];
    const explicit = envsOf(parseTriageTargets(withKind, TARGETS_PATH))["cni-dev"];
    expect(implicit?.kind).toBe("k8s");
    expect(implicit).toEqual(explicit);
  });

  test("a docker environment parses, and a service with no `checks` takes the skill's default", () => {
    const env = envsOf(parseTriageTargets(DOCKER_YAML, TARGETS_PATH))["docker-host"];
    if (env === undefined || env.kind !== "docker") throw new Error("expected a docker environment");
    expect(env.target).toBe("docker");
    expect(env.services[0]).toMatchObject({
      name: "grafana",
      namespace: "docker",
      checks: [...TRIAGE_DOCKER_DEFAULT_CHECKS],
    });
    expect(env.services[1]!.checks).toEqual(["state", "stats"]);
  });

  test("a vm environment with units parses", () => {
    const env = envsOf(parseTriageTargets(VM_YAML, TARGETS_PATH))["vm-host"];
    if (env === undefined || env.kind !== "vm") throw new Error("expected a vm environment");
    expect(env.target).toBe("vm");
    expect(env.services[0]).toMatchObject({
      name: "vm-1",
      namespace: "vm",
      checks: ["system", "units", "resources"],
      units: ["docker.service", "ssh.service", "systemd-journald.service"],
    });
  });

  test("a docker environment carrying kube_context is refused, its k8s twin (no kube_context) passes", () => {
    const bad = `
version: 1
environments:
  docker-host:
    kind: docker
    target: docker
    kube_context: gke-cni-dev
    default_window: 5m
    services: [{name: grafana, namespace: docker}]
`;
    const issues = issuesFrom(() => parseTriageTargets(bad, TARGETS_PATH));
    expect(issues).toEqual([{ path: "environments.docker-host.kube_context", message: "unrecognized key" }]);

    // The twin: the SAME document minus the stray key parses.
    expect(
      envsOf(parseTriageTargets(DOCKER_YAML, TARGETS_PATH))["docker-host"],
    ).not.toBeUndefined();
  });

  test("a k8s environment carrying `target` is refused, its docker twin (with target) passes", () => {
    const bad = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    target: docker
    default_window: 5m
    services: [{name: mia, namespace: ns, checks: [rollout]}]
`;
    const issues = issuesFrom(() => parseTriageTargets(bad, TARGETS_PATH));
    expect(issues).toEqual([{ path: "environments.cni-dev.target", message: "unrecognized key" }]);

    // The twin: a docker environment, where `target` belongs, parses fine.
    expect(envsOf(parseTriageTargets(DOCKER_YAML, TARGETS_PATH))["docker-host"]).not.toBeUndefined();
  });

  test("a docker environment missing target is refused", () => {
    const yaml = `
version: 1
environments:
  docker-host:
    kind: docker
    default_window: 5m
    services: [{name: grafana, namespace: docker}]
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues.some((i) => i.path === "environments.docker-host.target")).toBe(true);
  });

  test("an unknown kind is refused, naming the three allowed kinds", () => {
    const yaml = `
version: 1
environments:
  weird-host:
    kind: cloud
    target: x
    default_window: 5m
    services: [{name: a, namespace: x}]
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("environments.weird-host.kind");
    for (const kind of TRIAGE_ENVIRONMENT_KINDS) {
      expect(issues[0]!.message).toContain(kind);
    }
  });

  test("a docker check outside its own vocabulary is refused", () => {
    const yaml = `
version: 1
environments:
  docker-host:
    kind: docker
    target: docker
    default_window: 5m
    services: [{name: grafana, namespace: docker, checks: [rollout]}]
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.docker-host.services.0.checks.0");
  });

  test("and the twin: a k8s check outside ITS OWN vocabulary is refused too — the two vocabularies do not leak into each other", () => {
    const yaml = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    default_window: 5m
    services: [{name: mia, namespace: ns, checks: [state]}]
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.cni-dev.services.0.checks.0");
  });

  const vmYamlWithUnit = (unit: string) => `
version: 1
environments:
  vm-host:
    kind: vm
    target: vm
    default_window: 5m
    services: [{name: vm-1, namespace: vm, checks: [system], units: ["${unit}"]}]
`;

  test("a unit name starting with '-' is refused", () => {
    const issues = issuesFrom(() => parseTriageTargets(vmYamlWithUnit("-bad.service"), TARGETS_PATH));
    expect(issues.some((i) => i.path === "environments.vm-host.services.0.units.0")).toBe(true);
  });

  test("a 256-byte unit name is refused while a 255-byte one passes", () => {
    const issues = issuesFrom(() => parseTriageTargets(vmYamlWithUnit("a".repeat(256)), TARGETS_PATH));
    expect(issues.some((i) => i.path === "environments.vm-host.services.0.units.0")).toBe(true);

    const env = envsOf(parseTriageTargets(vmYamlWithUnit("a".repeat(255)), TARGETS_PATH))["vm-host"];
    if (env === undefined || env.kind !== "vm") throw new Error("expected a vm environment");
    expect(env.services[0]!.units[0]).toHaveLength(255);
  });

  test("a namespace different from the environment's target is refused on a docker row, the equal-namespace twin passes", () => {
    const bad = `
version: 1
environments:
  docker-host:
    kind: docker
    target: docker
    default_window: 5m
    services: [{name: grafana, namespace: not-docker}]
`;
    const issues = issuesFrom(() => parseTriageTargets(bad, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.docker-host.services.0.namespace");
    expect(issues[0]!.message).toContain("not-docker");
    expect(issues[0]!.message).toContain("docker");

    // The twin: namespace equal to target passes — DOCKER_YAML's own rows.
    expect(envsOf(parseTriageTargets(DOCKER_YAML, TARGETS_PATH))["docker-host"]).not.toBeUndefined();
  });

  test("a duplicate service name inside a docker environment is refused", () => {
    const yaml = `
version: 1
environments:
  docker-host:
    kind: docker
    target: docker
    default_window: 5m
    services:
      - {name: grafana, namespace: docker}
      - {name: grafana, namespace: docker, checks: [stats]}
`;
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));
    expect(issues[0]!.path).toBe("environments.docker-host.services.1.name");
  });

  test("kubeContextIssues over {k8s env naming a context the reach lacks, docker env} refuses only the k8s one", () => {
    const k8sEnvs = envsOf(parseTriageTargets(OVERLAP_YAML, TARGETS_PATH));
    const dockerEnvs = envsOf(parseTriageTargets(DOCKER_YAML, TARGETS_PATH));
    // `prod` names `gke-cni-prod`, which REACHES_DEV_AND_VERIFY does not carry.
    const combined = { prod: k8sEnvs["prod"]!, "docker-host": dockerEnvs["docker-host"]! };
    const issues = kubeContextIssues(combined, REACHES_DEV_AND_VERIFY);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("environments.prod.kube_context");
  });
});

// ---------------------------------------------------------------------------
// The sweep-wide total (SRD-TRIAGE-MIXED-OBSERVERS §5) — a bound the
// per-environment `.max(MAX_SERVICES_PER_ENVIRONMENT)` checks above cannot
// see, because it is a fact about the SUM, not about any one environment.
// ---------------------------------------------------------------------------

/** A k8s environment block naming `count` services, each unique within it. */
function k8sServicesBlock(env: string, context: string, count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `      - {name: ${env}-svc-${i}, namespace: ns, checks: [rollout]}`,
  ).join("\n");
  return `  ${env}:\n    kube_context: ${context}\n    services:\n${rows}\n`;
}

/** A docker environment block naming `count` services. */
function dockerServicesBlock(env: string, count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `      - {name: ${env}-svc-${i}, namespace: docker}`,
  ).join("\n");
  return `  ${env}:\n    kind: docker\n    target: docker\n    default_window: 5m\n    services:\n${rows}\n`;
}

/** A vm environment block naming `count` services. */
function vmServicesBlock(env: string, count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `      - {name: ${env}-svc-${i}, namespace: vm, checks: [system]}`,
  ).join("\n");
  return `  ${env}:\n    kind: vm\n    target: vm\n    default_window: 5m\n    services:\n${rows}\n`;
}

describe(`the sweep-wide total is bounded at MAX_SERVICES_PER_ENVIRONMENT too — one collation document carries every row of the sweep`, () => {
  test("17 services split across TWO environments, each under its own per-environment cap, is refused naming the total, the bound, and the one document", () => {
    const yaml =
      `version: 1\nenvironments:\n` +
      k8sServicesBlock("cni-dev", "gke-cni-dev", 9) +
      dockerServicesBlock("docker-host", 8);
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));

    expect(issues[0]!.path).toBe("environments");
    expect(issues[0]!.message).toContain("17");
    expect(issues[0]!.message).toContain(String(MAX_SERVICES_PER_ENVIRONMENT));
    expect(issues[0]!.message).toContain("triage.json");
    expect(issues[0]!.message).toContain("one collation document");
  });

  test("17 services split across THREE environments — one per kind — is refused the same way", () => {
    const yaml =
      `version: 1\nenvironments:\n` +
      k8sServicesBlock("cni-dev", "gke-cni-dev", 6) +
      dockerServicesBlock("docker-host", 6) +
      vmServicesBlock("vm-host", 5);
    const issues = issuesFrom(() => parseTriageTargets(yaml, TARGETS_PATH));

    expect(issues[0]!.path).toBe("environments");
    expect(issues[0]!.message).toContain("17");
    expect(issues[0]!.message).toContain(String(MAX_SERVICES_PER_ENVIRONMENT));
  });

  test(`${MAX_SERVICES_PER_ENVIRONMENT} services split across kinds — right at the bound — is accepted`, () => {
    // 9 + 5 + 2 = MAX_SERVICES_PER_ENVIRONMENT exactly.
    const yaml =
      `version: 1\nenvironments:\n` +
      k8sServicesBlock("cni-dev", "gke-cni-dev", 9) +
      dockerServicesBlock("docker-host", 5) +
      vmServicesBlock("vm-host", 2);
    const envs = envsOf(parseTriageTargets(yaml, TARGETS_PATH));
    const total = Object.values(envs).reduce((sum, e) => sum + e.services.length, 0);

    expect(total).toBe(MAX_SERVICES_PER_ENVIRONMENT);
  });

  test("the tracked triage/targets.yaml still parses", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "triage", "targets.yaml"), "utf8");
    const envs = envsOf(parseTriageTargets(text, "triage/targets.yaml"));
    const total = Object.values(envs).reduce((sum, e) => sum + e.services.length, 0);

    // 9 (do-cluster) + 5 (docker-host) + 1 (vm-host) = 15, inside the bound.
    expect(total).toBeLessThanOrEqual(MAX_SERVICES_PER_ENVIRONMENT);
  });
});

// ---------------------------------------------------------------------------
// 3.2 — D11's fence. The phase's highest-priority task.
// ---------------------------------------------------------------------------

describe("the kubeconfig-subset check (D11, §6.10)", () => {
  /**
   * THE fixture. The two sets overlap and neither contains the other, so the
   * assertion is about narrowing rather than about equality — see the header.
   */
  test("refuses ONLY the environment naming a context the kubeconfig does not carry", () => {
    const issues = kubeContextIssues(
      envsOf(parseTriageTargets(OVERLAP_YAML, TARGETS_PATH)),
      REACHES_DEV_AND_VERIFY,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("environments.prod.kube_context");
    expect(issues[0]!.message).toContain("gke-cni-prod");
    // The permitted half is not named — a check that refused both would
    // otherwise reach "one issue" by refusing the wrong one on a longer file.
    expect(issues[0]!.message).not.toContain("environments.dev");
  });

  test("the refusal names the kubeconfig and what it DOES carry, so the fix is visible", () => {
    const [issue] = kubeContextIssues(
      envsOf(parseTriageTargets(OVERLAP_YAML, TARGETS_PATH)),
      REACHES_DEV_AND_VERIFY,
    );
    expect(issue!.message).toContain(KUBECONFIG_PATH);
    expect(issue!.message).toContain("gke-cni-verify");
  });

  test("and the twin: a PROPER subset passes, so the check is not refusing everything", () => {
    const reach = declaredReach(KUBECONFIG_PATH, [
      "gke-cni-dev",
      "gke-cni-verify",
      "gke-cni-prod",
      "gke-saas-prod",
    ]);
    expect(kubeContextIssues(envsOf(parseTriageTargets(OVERLAP_YAML, TARGETS_PATH)), reach)).toEqual(
      [],
    );
  });

  /**
   * The degenerate arm, asserted directly. D11 makes `cloud.kubeconfig` a
   * REQUIREMENT for this console: unset, `kubectl` falls through to whatever
   * the image carries (`schema.ts:1756-1772`), which is the "environment
   * nobody wrote down" the fence exists to prevent.
   */
  test("an UNDECLARED reach refuses a targets file that is otherwise perfect", () => {
    const issues = kubeContextIssues(envsOf(parsed()), undeclaredReach());
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("");
    expect(issues[0]!.message).toContain("cloud.kubeconfig");
  });

  test("a DECLARED reach carrying ZERO contexts refuses everything, never admits everything", () => {
    const issues = kubeContextIssues(envsOf(parsed()), declaredReach(KUBECONFIG_PATH, []));
    expect(issues.map((i) => i.path).sort()).toEqual([
      "environments.cni-dev.kube_context",
      "environments.cni-verify.kube_context",
    ]);
  });

  test("fenceTriageTargets throws with the kubeconfig issue rather than returning a document", () => {
    const issues = issuesFrom(() =>
      fenceTriageTargets(parseTriageTargets(OVERLAP_YAML, TARGETS_PATH), fence()),
    );
    expect(issues.map((i) => i.path)).toEqual(["environments.prod.kube_context"]);
  });
});

describe("the two duration refusals (§6.10 rule 1, §7.8's cross-file note)", () => {
  const wide = (window: string) =>
    envsOf(
      parseTriageTargets(
        `version: 1\nenvironments:\n  cni-dev:\n    kube_context: gke-cni-dev\n    default_window: ${window}\n    services: [{name: mia, namespace: ns, checks: [logs]}]\n`,
        TARGETS_PATH,
      ),
    );
  const files = { targets: TARGETS_PATH, console: CONSOLE_PATH };

  test("default_window greater than the cadence is refused", () => {
    const issues = windowIssues(wide("6h"), 300, files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("environments.cni-dev.default_window");
  });

  /** §12: *"a refusal naming one file when two disagree sends the operator to the wrong editor."* */
  test("and the message names BOTH files", () => {
    const [issue] = windowIssues(wide("6h"), 300, files);
    expect(issue!.message).toContain(TARGETS_PATH);
    expect(issue!.message).toContain(CONSOLE_PATH);
    expect(issue!.message).toContain("cadence_s");
  });

  test("and the twin: a window EQUAL to the cadence is fine — §6.2's own worked example", () => {
    expect(windowIssues(wide("5m"), 300, files)).toEqual([]);
    expect(windowIssues(wide("60"), 300, files)).toEqual([]);
  });

  test("a per-service window override is fenced too — the override is the same 72x read", () => {
    const envs = envsOf(
      parseTriageTargets(
        `version: 1\nenvironments:\n  cni-dev:\n    kube_context: gke-cni-dev\n    default_window: 5m\n    services:\n      - {name: mia, namespace: ns, checks: [logs]}\n      - {name: authz, namespace: ns, checks: [logs], window: 6h}\n`,
        TARGETS_PATH,
      ),
    );
    const issues = windowIssues(envs, 300, files);
    expect(issues.map((i) => i.path)).toEqual(["environments.cni-dev.services.1.window"]);
  });

  /**
   * The override's own bound, resolved by the operator 2026-09-06.
   *
   * `withOverride` builds an environment whose `default_window` and per-service
   * `window` are BOTH given, so the two bounds can be separated. The band that
   * matters is `default_window < window <= cadence_s`: legal under §6.10 rule 1
   * and refused under §7.4's, and it is empty at shipped defaults (5m / 300s),
   * which is why it went unnoticed until the window echo was built.
   */
  const withOverride = (defaultWindow: string, override: string) =>
    envsOf(
      parseTriageTargets(
        `version: 1\nenvironments:\n  cni-dev:\n    kube_context: gke-cni-dev\n    default_window: ${defaultWindow}\n    services:\n      - {name: mia, namespace: ns, checks: [logs]}\n      - {name: authz, namespace: ns, checks: [logs], window: ${override}}\n`,
        TARGETS_PATH,
      ),
    );

  test("an override WIDER than default_window is refused, though the cadence allows it", () => {
    // The premise: this is the band the cadence rule cannot see. 5m <= 300s.
    expect(windowIssues(withOverride("5m", "5m"), 300, files)).toEqual([]);

    const issues = windowIssues(withOverride("2m", "5m"), 300, files);
    expect(issues.map((i) => i.path)).toEqual(["environments.cni-dev.services.1.window"]);
    expect(issues[0]!.message).toContain("default_window");
    expect(issues[0]!.message).toContain("window_opened_at");
  });

  test("and the twins: a NARROWER override is fine, and an EQUAL one is fine", () => {
    expect(windowIssues(withOverride("5m", "1m"), 300, files)).toEqual([]);
    expect(windowIssues(withOverride("5m", "5m"), 300, files)).toEqual([]);
  });

  /**
   * The tightening must not LOSE the refusal it replaces. `6h` against a 5m
   * default is still refused — now by the narrower bound, which is the more
   * actionable of the two — so no configuration that was refused before is
   * accepted now.
   */
  test("the 72x override is still refused, by the narrower bound", () => {
    const issues = windowIssues(withOverride("5m", "6h"), 300, files);
    expect(issues.map((i) => i.path)).toEqual(["environments.cni-dev.services.1.window"]);
    expect(issues[0]!.message).toContain("default_window");
  });

  /**
   * The cadence branch for an override is reachable ONLY when `default_window`
   * is itself out of bounds — asserted rather than left as a claim in the
   * docblock, because an unreachable branch and a wrong one look identical.
   * Both faults are named by path: the file is refused either way, and an
   * operator fixing one should not have to run `config validate` again to find
   * the other.
   */
  test("a broken default_window still lets the override report its own cadence fault", () => {
    const issues = windowIssues(withOverride("6h", "6h"), 300, files);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "environments.cni-dev.default_window",
      "environments.cni-dev.services.1.window",
    ]);
    const override = issues.find((i) => i.path.endsWith("services.1.window"))!;
    expect(override.message).toContain("cadence_s");
    expect(override.message).not.toContain("default_window of");
  });

  /**
   * §7.8 property 1 makes `sweep_deadline_s ≥ cadence_s` unreachable by
   * construction. This predicate is what says so rather than a comment
   * claiming it — the loader that holds both files applies it.
   */
  test("sweep_deadline_s >= cadence_s is refused, naming both files", () => {
    const issue = sweepDeadlineIssue(300, 300, files);
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain(TARGETS_PATH);
    expect(issue!.message).toContain(CONSOLE_PATH);
    expect(sweepDeadlineIssue(420, 300, files)).not.toBeNull();
  });

  test("and the twin: the computed 240 against a 300 cadence passes", () => {
    expect(sweepDeadlineIssue(240, 300, files)).toBeNull();
  });

  test("fenceTriageTargets carries both duration refusals, not just the first", () => {
    const issues = issuesFrom(() =>
      fenceTriageTargets(
        parseTriageTargets(
          `version: 1\nenvironments:\n  cni-dev:\n    kube_context: gke-cni-dev\n    default_window: 6h\n    services: [{name: mia, namespace: ns, checks: [logs]}]\n`,
          TARGETS_PATH,
        ),
        fence({ sweepDeadlineS: 300 }),
      ),
    );
    expect(issues.map((i) => i.path).sort()).toEqual(["", "environments.cni-dev.default_window"]);
  });
});

// ---------------------------------------------------------------------------
// The type split — pm-state.ts's pattern, asserted on the value
// ---------------------------------------------------------------------------

describe("a parsed-but-unfenced document cannot be mistaken for a fenced one", () => {
  test("parseTriageTargets returns NO `environments` property at all", () => {
    const doc = parsed();
    expect(Object.hasOwn(doc, "environments")).toBe(false);
    expect(Object.hasOwn(doc, "environments_unchecked_against_kubeconfig")).toBe(true);
  });

  test("only fenceTriageTargets produces the usable name", () => {
    const targets = fenceTriageTargets(parsed(), fence());
    expect(Object.hasOwn(targets, "environments")).toBe(true);
    expect(Object.hasOwn(targets, "environments_unchecked_against_kubeconfig")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The loader, and its injected reads
// ---------------------------------------------------------------------------

describe("parseKubeContexts", () => {
  test("takes the names out of a kubeconfig's contexts[]", () => {
    const kc = `
apiVersion: v1
kind: Config
contexts:
  - name: gke-cni-dev
    context: {cluster: a, user: b}
  - name: gke-cni-verify
    context: {cluster: c, user: d}
current-context: gke-cni-dev
`;
    expect(parseKubeContexts(kc, KUBECONFIG_PATH)).toEqual(["gke-cni-dev", "gke-cni-verify"]);
  });

  test("a kubeconfig with no contexts[] yields the EMPTY set, which refuses everything", () => {
    expect(parseKubeContexts("apiVersion: v1\nkind: Config\n", KUBECONFIG_PATH)).toEqual([]);
  });
});

describe("loadTriageTargets", () => {
  const deps = (yaml: string | null, contexts: readonly string[]) => ({
    readText: async () => yaml,
    readKubeContexts: async () => contexts,
  });

  const opts = {
    targetsPath: TARGETS_PATH,
    consolePath: CONSOLE_PATH,
    kubeconfigPath: KUBECONFIG_PATH,
    cadenceS: 300,
    sweepDeadlineS: 240,
  };

  test("reads, parses and fences through injected deps — no disk", async () => {
    const targets = await loadTriageTargets({
      ...opts,
      deps: deps(GOOD_YAML, ["gke-cni-dev", "gke-cni-verify", "gke-saas-prod"]),
    });
    expect(Object.keys(targets.environments).sort()).toEqual(["cni-dev", "cni-verify"]);
  });

  test("a MISSING targets file is an error naming it — unlike console.yaml, §7.8", async () => {
    await expect(
      loadTriageTargets({ ...opts, deps: deps(null, ["gke-cni-dev"]) }),
    ).rejects.toThrow(TARGETS_PATH);
  });

  test("kubeconfigPath null is D11's refusal, and the kubeconfig is never read", async () => {
    let read = 0;
    await expect(
      loadTriageTargets({
        ...opts,
        kubeconfigPath: null,
        deps: {
          readText: async () => GOOD_YAML,
          readKubeContexts: async () => {
            read += 1;
            return ["gke-cni-dev", "gke-cni-verify"];
          },
        },
      }),
    ).rejects.toThrow(/cloud\.kubeconfig/);
    expect(read).toBe(0);
  });

  test("the real deps exist and are the ones used when none are injected", () => {
    expect(typeof DEFAULT_TRIAGE_TARGETS_DEPS.readText).toBe("function");
    expect(typeof DEFAULT_TRIAGE_TARGETS_DEPS.readKubeContexts).toBe("function");
  });
});
