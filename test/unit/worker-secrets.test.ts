/**
 * `secrets:` and `egress_access` — the two config keys that were declared and
 * inert (ISC-304 .. ISC-313).
 *
 * `secrets.env_allowlist` shipped with exactly one occurrence in the tree: its
 * own declaration in `config/schema.ts`. Nothing read it, so an operator could
 * write it, `config validate` would accept it, and no variable would reach any
 * container — the field was documentation shaped like a control. The proxy
 * variables had the opposite defect: they worked, and they were reachable only
 * through `cloud_access`, so the cheap capability ("may reach an allowed host
 * through the CONNECT proxy") could only be bought at the price of the
 * expensive one ("holds a Google identity").
 *
 * These probes are on the env PLAN, which is what `--env-file` renders, for
 * the reason the ISC-263 block in `worker-env.test.ts` gives: a module that is
 * correct beside a path nothing exercises is the shape this repo has recorded
 * repeatedly, and the plan is the last point at which the decision is still
 * observable without a container.
 */
import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { parseConfig, resolveWorker, ConfigError } from "../../src/config/load.ts";
import {
  buildWorkerEnv,
  serializeEnvFile,
  SecretMissingFromHostError,
  SecretNotAllowlistedError,
  SecretReservedNameError,
} from "../../src/run/worker-env.ts";
import { CREDENTIAL_ENV_VARS } from "../../src/security/adc.ts";
import {
  PROXY_LISTEN_ALIAS,
  PROXY_LISTEN_PORT,
  RELAY_LISTEN_ALIAS,
} from "../../src/security/relay.ts";

/**
 * A value distinctive enough that a substring search for it means something.
 *
 * Every "never logged" assertion below is a `.toContain` against this string.
 * A short or wordlike value would make those assertions pass for the wrong
 * reason — a message that happens not to contain `"abc"` proves nothing.
 */
const CANARY = "canary-8f2a-4d1e-value-that-must-never-be-logged";

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "secrets-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel" },
    secrets: { env_allowlist: ["TICKET_TOKEN", "FEED_TOKEN", "UNREQUESTED_TOKEN"] },
    roles: {
      eng: {},
      cloudy: { cloud_access: true },
      // The route WITHOUT the grant — the shape ISC-309/ISC-310 exist for.
      router: { egress_access: true },
      ticketer: { secrets: ["TICKET_TOKEN"] },
    },
    workers: [
      { id: "w1", role: "eng" },
      { id: "wc", role: "cloudy" },
      { id: "wr", role: "router" },
      { id: "wt", role: "ticketer" },
    ],
    ...over,
  };
}

async function load(d: Record<string, unknown>) {
  return parseConfig(stringify(d), "/tmp/fleet.yaml");
}

describe("ISC-304: a secret arrives only when BOTH lists name it", () => {
  test("a name in the worker's request AND the fleet ceiling is delivered", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(plan.vars["TICKET_TOKEN"]).toBe(CANARY);
    expect(plan.secretNames).toEqual(["TICKET_TOKEN"]);
  });

  /**
   * The CEILING direction, and the half that would otherwise go unnoticed.
   *
   * `secrets.env_allowlist` naming a variable must not be enough to deliver
   * it. If it were, the fleet-wide field would be a GRANT rather than a
   * ceiling and every worker in the fleet would hold every listed secret —
   * exactly the blast radius the per-worker list exists to shrink. The host
   * environment HAS the value here, so the only thing keeping it out of the
   * plan is that the worker did not ask.
   */
  test("a name only the fleet ceiling carries is NOT delivered", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), {
      TICKET_TOKEN: CANARY,
      UNREQUESTED_TOKEN: CANARY,
    });
    expect(plan.vars["UNREQUESTED_TOKEN"]).toBeUndefined();
    expect(plan.secretNames).not.toContain("UNREQUESTED_TOKEN");
  });

  test("a worker that requests nothing gets nothing, with the ceiling non-empty", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), { TICKET_TOKEN: CANARY });
    expect(plan.secretNames).toEqual([]);
    expect(plan.vars["TICKET_TOKEN"]).toBeUndefined();
  });

  test("the delivered value survives serialization to the file docker reads", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(serializeEnvFile(plan.vars)).toContain(`TICKET_TOKEN=${CANARY}`);
  });

  /**
   * `serializeEnvFile`'s existing refusals still govern the new path, and a
   * secret is the value MOST likely to trip them: it comes from a shell where
   * a stray `$(cat key.pem)` is one keystroke away. Docker's `--env-file` has
   * no escaping, so the remainder of such a value would become a separate
   * variable declaration — env-var injection through a config value.
   */
  test("a secret carrying a newline is still refused by the serializer", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), {
      TICKET_TOKEN: "line1\nINJECTED=1",
    });
    expect(() => serializeEnvFile(plan.vars)).toThrow(ConfigError);
  });
});

describe("ISC-305: a request the fleet ceiling does not carry is refused", () => {
  const rogue = {
    roles: { rogue: { secrets: ["NOT_ON_THE_LIST"] } },
    workers: [{ id: "wx", role: "rogue" }],
  };

  test("refuses, naming the variable and the field to edit", async () => {
    const loaded = await load(doc(rogue));
    const w = resolveWorker(loaded, "wx");
    expect(() => buildWorkerEnv(loaded, w, { NOT_ON_THE_LIST: CANARY })).toThrow(
      SecretNotAllowlistedError,
    );
    try {
      buildWorkerEnv(loaded, w, { NOT_ON_THE_LIST: CANARY });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("NOT_ON_THE_LIST");
      expect((err as Error).message).toContain("secrets.env_allowlist");
    }
  });

  /**
   * Refused rather than DROPPED, asserted as the absence of the silent
   * alternative. A build that returned a plan without the variable is the
   * SRD §5.9 quiet failure this refusal exists to replace: the worker
   * launches, runs, and dies inside whatever call needed the value, minutes
   * later and nowhere near the config line that caused it.
   */
  test("the refusal is a throw, not a plan with the variable quietly missing", async () => {
    const loaded = await load(doc(rogue));
    let built = false;
    try {
      buildWorkerEnv(loaded, resolveWorker(loaded, "wx"), { NOT_ON_THE_LIST: CANARY });
      built = true;
    } catch {
      /* expected */
    }
    expect(built).toBe(false);
  });
});

describe("ISC-306: a permitted name the host environment lacks is refused", () => {
  test("unset in the host environment refuses", async () => {
    const loaded = await load(doc());
    expect(() => buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), {})).toThrow(
      SecretMissingFromHostError,
    );
  });

  /**
   * EMPTY counts as absent, on `missingApiKey`'s precedent in the same module:
   * writing `NAME=` hands the container an empty string, and every downstream
   * `[ -n "${…:-}" ]` guard then behaves as though the variable were set.
   */
  test("empty in the host environment refuses too", async () => {
    const loaded = await load(doc());
    expect(() => buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: "" })).toThrow(
      SecretMissingFromHostError,
    );
  });

  test("every missing name is reported in ONE refusal, not one per `up`", async () => {
    const loaded = await load(
      doc({
        roles: { greedy: { secrets: ["TICKET_TOKEN", "FEED_TOKEN"] } },
        workers: [{ id: "wg", role: "greedy" }],
      }),
    );
    try {
      buildWorkerEnv(loaded, resolveWorker(loaded, "wg"), {});
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("TICKET_TOKEN");
      expect((err as Error).message).toContain("FEED_TOKEN");
    }
  });

  /**
   * THE DELIBERATE NARROWING, asserted so it cannot be quietly widened later.
   *
   * The refusal is scoped to the INTERSECTION and not to the whole allowlist.
   * `UNREQUESTED_TOKEN` is on the fleet ceiling and is unset here, and that
   * must NOT refuse: a ceiling states what the fleet PERMITS, not that every
   * permitted name is set on every machine. Reading it the other way refuses
   * a run because of a variable nobody asked for — the dead-rule shape
   * `assertModelAllowed` already declines to ship ("an empty list constrains
   * nothing… refusing fleets nobody asked to refuse").
   */
  test("an allowlisted name NOBODY requested may be absent without refusing", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(plan.vars["TICKET_TOKEN"]).toBe(CANARY);
    expect(plan.secretNames).toEqual(["TICKET_TOKEN"]);
  });
});

describe("ISC-307: a secret's VALUE reaches the env file and no other surface", () => {
  /**
   * The guarantee is STRUCTURAL before it is behavioural, and this asserts the
   * structure. `secretNames` is the field every reporting surface reads — the
   * stderr note in `materialize.ts` interpolates it — and it is a list of
   * NAMES. A caller cannot log a value by accident, because the field it was
   * handed does not contain one.
   */
  test("the reportable field carries names and no values", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(plan.secretNames).toEqual(["TICKET_TOKEN"]);
    for (const entry of plan.secretNames) expect(entry).not.toContain(CANARY);
    // The CONTROL. Without it this passes for a build that delivered nothing,
    // which is the one reason a "the value is absent" assertion proves nothing.
    expect(plan.vars["TICKET_TOKEN"]).toBe(CANARY);
  });

  test("no refusal message quotes the value it refused", async () => {
    const loaded = await load(
      doc({
        roles: {
          rogue: { secrets: ["NOT_ON_THE_LIST"] },
          reserved: { secrets: ["CLOUDSDK_AUTH_ACCESS_TOKEN"] },
        },
        workers: [
          { id: "wx", role: "rogue" },
          { id: "wv", role: "reserved" },
        ],
      }),
    );
    // Both refusals fire on a name whose value IS present in the host
    // environment, which is the only arrangement under which a message could
    // leak one.
    const hostEnv = { NOT_ON_THE_LIST: CANARY, CLOUDSDK_AUTH_ACCESS_TOKEN: CANARY };
    for (const id of ["wx", "wv"]) {
      try {
        buildWorkerEnv(loaded, resolveWorker(loaded, id), hostEnv);
        throw new Error(`expected ${id} to be refused`);
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(CANARY);
        // Named, not silent — the other half of the same guarantee. A refusal
        // that said nothing would also pass the assertion above.
        expect(message).toContain(id === "wx" ? "NOT_ON_THE_LIST" : "CLOUDSDK_AUTH_ACCESS_TOKEN");
      }
    }
  });

  test("the value appears in the serialized env file exactly once", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    const text = serializeEnvFile(plan.vars);
    expect(text).toContain(CANARY);
    // Exactly once: a second occurrence means the value was copied into some
    // other variable, which is how a 0600 file's protection gets undone by
    // something that reads a different one.
    expect(text.split(CANARY).length - 1).toBe(1);
    expect(JSON.stringify(plan.secretNames)).not.toContain(CANARY);
  });
});

/**
 * ISC-308 — `env_allowlist`'s own comment says "NEVER provider keys — see
 * §12.4", and a comment is not a control.
 *
 * Each name below is one an operator could put on the ceiling and request from
 * a role, and each would hand a worker something `worker-env.ts`'s header
 * forbids it to carry — most sharply `CLOUDSDK_AUTH_ACCESS_TOKEN`, which would
 * put a Google credential in a file that lands in the run directory and is
 * read back by `status` and `report`, for a worker that was never granted
 * `cloud_access` at all.
 */
describe("ISC-308: `secrets:` is not a second route to §12.4 material", () => {
  const reservedCases: [string, string][] = [
    ["a Google access token", "CLOUDSDK_AUTH_ACCESS_TOKEN"],
    ["the ADC file pointer", "GOOGLE_APPLICATION_CREDENTIALS"],
    ["the provider key's own variable", "OMLX_API_KEY"],
    ["the honeypot switch", "PIFLEET_HONEYPOT"],
    ["git's ownership escape", "GIT_CONFIG_VALUE_0"],
    ["the proxy route", "HTTPS_PROXY"],
    ["the cleartext proxy this module never sets", "HTTP_PROXY"],
  ];

  for (const [what, name] of reservedCases) {
    test(`${what} (${name}) is refused even when allowlisted and requested`, async () => {
      const loaded = await load(
        doc({
          secrets: { env_allowlist: [name] },
          roles: { greedy: { secrets: [name] } },
          workers: [{ id: "wg", role: "greedy" }],
        }),
      );
      expect(() => buildWorkerEnv(loaded, resolveWorker(loaded, "wg"), { [name]: CANARY })).toThrow(
        SecretReservedNameError,
      );
    });
  }

  /**
   * The refusal must not depend on the worker HOLDING the capability whose
   * variables are named. A worker without `cloud_access` has no `CLOUDSDK_*`
   * in its plan to collide with, and one without `egress_access` has no proxy
   * variables — so a purely structural "is this key already set?" check would
   * leave both requestable on exactly the workers that must never have them.
   */
  test("refused for a worker that holds NEITHER grant", async () => {
    const loaded = await load(
      doc({
        secrets: { env_allowlist: ["CLOUDSDK_AUTH_ACCESS_TOKEN", "NO_PROXY"] },
        roles: {
          plain: { secrets: ["CLOUDSDK_AUTH_ACCESS_TOKEN"] },
          plain2: { secrets: ["NO_PROXY"] },
        },
        workers: [
          { id: "wp", role: "plain" },
          { id: "wp2", role: "plain2" },
        ],
      }),
    );
    for (const id of ["wp", "wp2"]) {
      const w = resolveWorker(loaded, id);
      expect(w.cloudAccess).toBe(false);
      expect(w.egressAccess).toBe(false);
      expect(() =>
        buildWorkerEnv(loaded, w, { CLOUDSDK_AUTH_ACCESS_TOKEN: CANARY, NO_PROXY: CANARY }),
      ).toThrow(SecretReservedNameError);
    }
  });
});

describe("ISC-309: `egress_access` grants the proxy route without the cloud grant", () => {
  test("all four proxy variables are set for egress_access with cloud_access false", async () => {
    const loaded = await load(doc());
    const w = resolveWorker(loaded, "wr");
    expect(w.egressAccess).toBe(true);
    expect(w.cloudAccess).toBe(false);
    const plan = buildWorkerEnv(loaded, w, {});
    expect(plan.vars["HTTPS_PROXY"]).toBe(`http://${PROXY_LISTEN_ALIAS}:${PROXY_LISTEN_PORT}`);
    expect(plan.vars["https_proxy"]).toBe(plan.vars["HTTPS_PROXY"]);
    expect(plan.vars["NO_PROXY"]!.split(",")).toContain(RELAY_LISTEN_ALIAS);
    expect(plan.vars["no_proxy"]).toBe(plan.vars["NO_PROXY"]);
  });

  test("HTTP_PROXY stays unset on the route-only path too", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wr"), {});
    expect(plan.vars["HTTP_PROXY"]).toBeUndefined();
    expect(plan.vars["http_proxy"]).toBeUndefined();
  });

  test("a cloud_access worker still gets the route — the split lost nothing", async () => {
    const loaded = await load(doc());
    const w = resolveWorker(loaded, "wc");
    expect(w.egressAccess).toBe(false);
    const plan = buildWorkerEnv(loaded, w, {});
    expect(plan.vars["HTTPS_PROXY"]).toBe(`http://${PROXY_LISTEN_ALIAS}:${PROXY_LISTEN_PORT}`);
  });

  /**
   * The RESTATEMENT of the pre-existing assertion in `worker-env.test.ts`,
   * which reads "a cloud_access: false worker gets no proxy route at all".
   * That sentence is now false as a general claim — `wr` is exactly such a
   * worker and holds the route — and it is the NEITHER case that carries the
   * meaning it was written for.
   */
  test("a worker with NEITHER grant gets no proxy route at all", async () => {
    const loaded = await load(doc());
    const w = resolveWorker(loaded, "w1");
    expect(w.cloudAccess).toBe(false);
    expect(w.egressAccess).toBe(false);
    const plan = buildWorkerEnv(loaded, w, {});
    for (const k of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      expect(plan.vars[k]).toBeUndefined();
    }
  });
});

/**
 * ISC-310 — THE ANTI-CRITERION, and the one that decides whether this change
 * was SAFE rather than merely useful.
 *
 * Splitting the route out of `if (w.cloudAccess)` is a change to the block
 * carrying the observability invariant: `cloud_access: false` must be
 * observable as the absence of the ENTIRE `CREDENTIAL_ENV_VARS` set, not of
 * whichever variable today's default mode happens to use. The failure mode of
 * a careless split is that some Google variable rides out with the proxy four
 * — and it would be INVISIBLE, because every proxy assertion above would stay
 * green while a worker that was never granted an identity carried one.
 *
 * So this asserts the ABSENCE, on the exact worker the change created: route
 * held, grant withheld. Both probes carry a control, because an absence
 * assertion against an empty plan proves nothing.
 */
describe("ISC-310: an egress_access worker without cloud_access holds NO Google variable", () => {
  test("every CREDENTIAL_ENV_VARS name is absent", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wr"), {});
    // The CONTROL: this worker really does hold the route, so the absences
    // below are about the grant and not about an empty plan.
    expect(plan.vars["HTTPS_PROXY"]).toBeDefined();
    expect(CREDENTIAL_ENV_VARS.length).toBeGreaterThan(0);
    for (const name of CREDENTIAL_ENV_VARS) {
      expect(plan.vars[name]).toBeUndefined();
    }
  });

  test("CLOUDSDK_CORE_PROJECT is absent even when the fleet configures one", async () => {
    const loaded = await load(doc({ cloud: { quota_project: "some-project" } }));
    const routed = buildWorkerEnv(loaded, resolveWorker(loaded, "wr"), {});
    expect(routed.vars["CLOUDSDK_CORE_PROJECT"]).toBeUndefined();
    // The control in the other direction: the fleet DID configure one, and a
    // cloud_access worker gets it. Without this, a config whose quota_project
    // reached nothing at all would satisfy the assertion above.
    const granted = buildWorkerEnv(loaded, resolveWorker(loaded, "wc"), {});
    expect(granted.vars["CLOUDSDK_CORE_PROJECT"]).toBe("some-project");
  });
});

describe("ISC-311: both new keys honour defaults <- roles <- worker", () => {
  test("defaults reach a worker whose role and entry say nothing", async () => {
    const loaded = await load(
      doc({
        defaults: { egress_access: true, secrets: ["TICKET_TOKEN"] },
        roles: { plain: {} },
        workers: [{ id: "wd", role: "plain" }],
      }),
    );
    const w = resolveWorker(loaded, "wd");
    expect(w.egressAccess).toBe(true);
    expect(w.secrets).toEqual(["TICKET_TOKEN"]);
  });

  test("a role overrides defaults, and a worker overrides the role", async () => {
    const loaded = await load(
      doc({
        defaults: { egress_access: true, secrets: ["TICKET_TOKEN"] },
        roles: { mid: { egress_access: false, secrets: ["FEED_TOKEN"] } },
        workers: [
          { id: "wrole", role: "mid" },
          { id: "wover", role: "mid", egress_access: true, secrets: ["TICKET_TOKEN", "FEED_TOKEN"] },
        ],
      }),
    );
    const byRole = resolveWorker(loaded, "wrole");
    expect(byRole.egressAccess).toBe(false);
    expect(byRole.secrets).toEqual(["FEED_TOKEN"]);
    const byWorker = resolveWorker(loaded, "wover");
    expect(byWorker.egressAccess).toBe(true);
    expect(byWorker.secrets).toEqual(["TICKET_TOKEN", "FEED_TOKEN"]);
  });

  /**
   * Arrays REPLACE, they do not union (§6.1 rule 1). Asserted because union
   * is the intuitive reading for a capability list and is the wrong one: it
   * would make a grant written at `defaults` impossible to take away at the
   * worker level, and taking a capability AWAY is the direction that must stay
   * easy.
   */
  test("a worker's empty secrets list empties the role's, rather than unioning", async () => {
    const loaded = await load(
      doc({
        roles: { mid: { secrets: ["TICKET_TOKEN"] } },
        workers: [{ id: "wempty", role: "mid", secrets: [] }],
      }),
    );
    const w = resolveWorker(loaded, "wempty");
    expect(w.secrets).toEqual([]);
    const plan = buildWorkerEnv(loaded, w, { TICKET_TOKEN: CANARY });
    expect(plan.vars["TICKET_TOKEN"]).toBeUndefined();
  });
});
