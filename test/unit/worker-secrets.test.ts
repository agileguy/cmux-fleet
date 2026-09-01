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
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, parseConfig, resolveWorker, ConfigError } from "../../src/config/load.ts";
import {
  buildWorkerEnv,
  serializeEnvFile,
  SecretMissingFromHostError,
  SecretNotAllowlistedError,
  SecretReservedNameError,
  secretContainerPath,
  secretPointerName,
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
  /**
   * The DELIVERY moved under this criterion (ISC-337) and the RULE did not,
   * which is why the assertion is rewritten here rather than deleted. What
   * ISC-304 is about — a value reaches a worker only through the intersection
   * — is unchanged; what changed is that "reaches" now means a file plus a
   * pointer rather than a variable holding the value. Asserting on all three
   * of `secretNames`, the pointer and `secretFiles` keeps this non-vacuous in
   * both directions: a build that stopped delivering entirely would fail on
   * `secretFiles`, and one that regressed to putting the value back in the
   * environment would fail on the pointer.
   */
  test("a name in the worker's request AND the fleet ceiling is delivered", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(plan.vars[secretPointerName("TICKET_TOKEN")]).toBe(secretContainerPath("TICKET_TOKEN"));
    expect(plan.secretFiles).toEqual([{ name: "TICKET_TOKEN", value: CANARY }]);
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
    expect(plan.vars[secretPointerName("UNREQUESTED_TOKEN")]).toBeUndefined();
    expect(plan.secretNames).not.toContain("UNREQUESTED_TOKEN");
    expect(plan.secretFiles.map((f) => f.name)).not.toContain("UNREQUESTED_TOKEN");
  });

  test("a worker that requests nothing gets nothing, with the ceiling non-empty", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), { TICKET_TOKEN: CANARY });
    expect(plan.secretNames).toEqual([]);
    expect(plan.secretFiles).toEqual([]);
    expect(plan.vars["TICKET_TOKEN"]).toBeUndefined();
    expect(plan.vars[secretPointerName("TICKET_TOKEN")]).toBeUndefined();
  });

  test("the delivered POINTER survives serialization to the file docker reads", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    expect(serializeEnvFile(plan.vars)).toContain("TICKET_TOKEN_FILE=/secrets/TICKET_TOKEN");
  });

  /**
   * The newline refusal SURVIVED the delivery change, and this test is what
   * proves it did rather than lapsing quietly.
   *
   * It used to be `serializeEnvFile`'s: a secret is the value most likely to
   * carry a newline, because it comes from a shell where a stray
   * `$(cat key.pem)` is one keystroke away, and docker's `--env-file` has no
   * escaping — so the remainder became a separate variable declaration. Under
   * file delivery the value never enters `vars` at all, so the serializer
   * would never see it and the guarantee would have disappeared silently along
   * with the path that carried it. `buildWorkerEnv` refuses it one step
   * earlier now, and the refusal matters for a second reason as well:
   * `skills/ticket-ops/SKILL.md` concatenates the file's bytes into a curl
   * `header = "..."` line, which a newline would end mid-quote.
   */
  test("a secret carrying a newline is still refused, now before it reaches a file", async () => {
    const loaded = await load(doc());
    expect(() =>
      buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), {
        TICKET_TOKEN: "line1\nINJECTED=1",
      }),
    ).toThrow(ConfigError);
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
    expect(plan.vars[secretPointerName("TICKET_TOKEN")]).toBe(secretContainerPath("TICKET_TOKEN"));
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
    // It reads `secretFiles` since ISC-337, because that is now the only field
    // of the plan a value can be in.
    expect(plan.secretFiles).toEqual([{ name: "TICKET_TOKEN", value: CANARY }]);
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

  /**
   * SUPERSEDED BY ISC-337, and the direction of the change is the point.
   *
   * This assertion used to read `expect(text).toContain(CANARY)` and then
   * `exactly once` — the env file was where a secret was SUPPOSED to be, and
   * the count guarded against it being copied into a second variable. File
   * delivery removes the premise: the value is not in the env file at all, so
   * "exactly once" became "exactly zero" and the guard became the criterion.
   *
   * Rewritten rather than deleted because ISC-307's OTHER half — that no
   * reporting surface carries a value — is unchanged and still graded, and
   * because a count assertion that flipped from one to zero is the clearest
   * available record that the delivery moved. The definitive form of this,
   * driven by `fleet.example.yaml` rather than by a synthetic document, is in
   * `test/unit/worker-secret-files.test.ts`.
   */
  test("the value appears in the serialized env file ZERO times, and the pointer once", async () => {
    const loaded = await load(doc());
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), { TICKET_TOKEN: CANARY });
    const text = serializeEnvFile(plan.vars);
    expect(text).not.toContain(CANARY);
    // The CONTROL for the line above: without it, a build that delivered
    // NOTHING would satisfy the absence assertion perfectly.
    const pointer = `${secretPointerName("TICKET_TOKEN")}=${secretContainerPath("TICKET_TOKEN")}`;
    expect(text).toContain(pointer);
    expect(text.split(pointer).length - 1).toBe(1);
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

/**
 * The SHIPPED EXAMPLE's ticketing worker, and the reason this block exists at
 * all (ISC-330).
 *
 * Everything above drives synthetic config documents, which is the right way
 * to probe the intersection rule — a hand-built doc can hold the exact shape a
 * criterion is about. But it cannot answer the question ISC-330 actually asks,
 * which is not "does the mechanism work" but "does the worker an operator
 * copies out of this repo receive what the role needs, and nothing else".
 *
 * That question is only answerable against `fleet.example.yaml` itself, and it
 * was unanswerable on the branch that wrote the role: `secrets:` and
 * `egress_access` did not parse yet, so the example shipped them commented and
 * ISC-330 was graded `[~]` with the uncommenting named as what would close it.
 * This is that closure, so the assertions are deliberately the two the entry
 * named — the token arrives, the Google credentials do not — plus the route,
 * because a credential granted for a path that does not exist is the failure
 * the ISC-263 comment in `worker-env.ts` was written about.
 */
describe("the shipped example's ticketing worker (ISC-330)", () => {
  const EXAMPLE = join(import.meta.dir, "..", "..", "fleet.example.yaml");
  const TOKEN = "tok-example-not-a-real-credential";

  async function ticketingPlan() {
    const loaded = await loadConfig(EXAMPLE);
    return buildWorkerEnv(loaded, resolveWorker(loaded, "tick-1"), {
      TICKET_API_TOKEN: TOKEN,
      TICKET_BASE_URL: "https://tickets.example.com",
      TICKET_WORKSPACE: "WS-Example",
      TICKET_PROJECT: "PR-Example",
    });
  }

  /**
   * "Receives" means a POINTER since ISC-337. The grant is unchanged and the
   * shape of it is not: the worker is handed `TICKET_API_TOKEN_FILE` naming a
   * path, and the value travels to that path instead of into its environment.
   * Both halves are asserted so this cannot pass for a worker that was granted
   * nothing.
   */
  test("it receives the ticket credential it asked for, as a path", async () => {
    const plan = await ticketingPlan();
    expect(plan.vars[secretPointerName("TICKET_API_TOKEN")]).toBe(
      secretContainerPath("TICKET_API_TOKEN"),
    );
    expect(plan.secretFiles).toContainEqual({ name: "TICKET_API_TOKEN", value: TOKEN });
    expect(plan.secretNames).toEqual([
      "TICKET_API_TOKEN",
      "TICKET_BASE_URL",
      "TICKET_WORKSPACE",
      "TICKET_PROJECT",
    ]);
  });

  /**
   * THE ANTI-CRITERION, and the one worth breaking on purpose.
   *
   * `cloud_access: false` on this worker has to remain observable as the
   * absence of the WHOLE credential set, not merely of whichever variable the
   * current ADC mode happens to use. Asserting over `CREDENTIAL_ENV_VARS`
   * rather than naming `GOOGLE_APPLICATION_CREDENTIALS` is what keeps that
   * non-vacuous when a mode is added.
   */
  test("it receives no Google credential of any kind", async () => {
    const plan = await ticketingPlan();
    for (const name of CREDENTIAL_ENV_VARS) expect(plan.vars[name]).toBeUndefined();
    expect(plan.vars["CLOUDSDK_CORE_PROJECT"]).toBeUndefined();
  });

  test("it receives a route to the proxy despite holding no cloud grant", async () => {
    const plan = await ticketingPlan();
    expect(plan.vars["HTTPS_PROXY"]).toBeDefined();
    expect(plan.vars["https_proxy"]).toBe(plan.vars["HTTPS_PROXY"] as string);
    expect(plan.vars["HTTP_PROXY"]).toBeUndefined();
  });
});

/**
 * The observer role's own secrets, at the config-validation altitude §13
 * asks for (SRD-OBSERVER-001 §6.5, §13's "Config." bullet): a `secrets:`
 * naming something the fleet-wide ceiling omits refuses at `up`, by name.
 *
 * Reuses ISC-305's mechanism rather than re-deriving it — `buildWorkerEnv` is
 * role-agnostic — and is worth its own block anyway because `observer` is the
 * role §13 names explicitly, and because it doubles as the positive control
 * for the `credential: false` trap (SRD §6.5): the base URLs must be
 * DELIVERED and must NOT be swept, which the ticket-ops precedent already
 * covers generically but this exercises against observer's own three pairs.
 */
describe("the observer role's secrets ceiling (SRD-OBSERVER-001 §6.5, §13)", () => {
  // Mirrors what `env_allowlist` actually accepts. Typing this `string[]`
  // compiles until the first entry uses the object form, which is the only
  // form that can carry `credential: false` — so the narrower type rejects
  // precisely the case these tests exist to cover.
  type CeilingEntry = string | { name: string; credential: boolean };
  const observerDoc = (allowlist: CeilingEntry[]) => ({
    secrets: { env_allowlist: allowlist },
    roles: {
      observer: {
        secrets: [
          "CI_CD_TOKEN",
          "CI_CD_BASE_URL",
          "CI_BUILD_TOKEN",
          "CI_BUILD_BASE_URL",
          "GRAFANA_TOKEN",
          "GRAFANA_BASE_URL",
        ],
      },
    },
    workers: [{ id: "obs-1", role: "observer" }],
  });

  const FULL_CEILING = [
    "CI_CD_TOKEN",
    { name: "CI_CD_BASE_URL", credential: false },
    "CI_BUILD_TOKEN",
    { name: "CI_BUILD_BASE_URL", credential: false },
    "GRAFANA_TOKEN",
    { name: "GRAFANA_BASE_URL", credential: false },
  ];

  test("a fleet ceiling missing one of observer's six names refuses at up, naming it", async () => {
    // The ceiling omits GRAFANA_TOKEN — one name short of what the role asks for.
    const short = FULL_CEILING.filter(
      (e) => (typeof e === "string" ? e : e.name) !== "GRAFANA_TOKEN",
    );
    const loaded = await load(doc(observerDoc(short)));
    const w = resolveWorker(loaded, "obs-1");
    let caught: Error | null = null;
    try {
      buildWorkerEnv(loaded, w, {
        CI_CD_TOKEN: CANARY,
        CI_CD_BASE_URL: "http://ci-cd.example.com",
        CI_BUILD_TOKEN: CANARY,
        CI_BUILD_BASE_URL: "http://ci-build.example.com",
        GRAFANA_TOKEN: CANARY,
        GRAFANA_BASE_URL: "http://grafana.example.com",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(SecretNotAllowlistedError);
    // BY NAME — the one omitted variable, not a generic "some secret missing".
    expect(caught!.message).toContain("GRAFANA_TOKEN");
    expect(caught!.message).toContain("secrets.env_allowlist");
    expect(caught!.message).toContain("obs-1");
  });

  test("with the full ceiling present, all six names are delivered as files, none as values", async () => {
    const loaded = await load(doc(observerDoc(FULL_CEILING)));
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "obs-1"), {
      CI_CD_TOKEN: CANARY,
      CI_CD_BASE_URL: "http://ci-cd.example.com",
      CI_BUILD_TOKEN: CANARY,
      CI_BUILD_BASE_URL: "http://ci-build.example.com",
      GRAFANA_TOKEN: CANARY,
      GRAFANA_BASE_URL: "http://grafana.example.com",
    });
    expect(plan.secretNames.sort()).toEqual(
      [
        "CI_CD_TOKEN",
        "CI_CD_BASE_URL",
        "CI_BUILD_TOKEN",
        "CI_BUILD_BASE_URL",
        "GRAFANA_TOKEN",
        "GRAFANA_BASE_URL",
      ].sort(),
    );
    for (const name of plan.secretNames) {
      expect(plan.vars[name]).toBeUndefined();
      expect(plan.vars[secretPointerName(name)]).toBe(secretContainerPath(name));
    }
  });

  /**
   * The `credential: false` trap, asserted as a POSITIVE (SRD §6.5): the
   * three base URLs are exactly the subset the fleet declared non-credential,
   * and the three tokens are exactly the subset that is NOT. Regressing
   * either direction — a token marked `credential: false` by accident, or a
   * base URL left swept — fails here rather than surfacing later as every
   * observer-ops.json being refused for carrying "a credential" that was
   * actually the endpoint it was pointed at (the TICKET_BASE_URL failure this
   * role inherits at three times the surface).
   */
  test("exactly the three base URLs are marked credential: false, never the tokens", async () => {
    const loaded = await load(doc(observerDoc(FULL_CEILING)));
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "obs-1"), {
      CI_CD_TOKEN: CANARY,
      CI_CD_BASE_URL: "http://ci-cd.example.com",
      CI_BUILD_TOKEN: CANARY,
      CI_BUILD_BASE_URL: "http://ci-build.example.com",
      GRAFANA_TOKEN: CANARY,
      GRAFANA_BASE_URL: "http://grafana.example.com",
    });
    expect(plan.nonCredentialSecretNames.sort()).toEqual(
      ["CI_CD_BASE_URL", "CI_BUILD_BASE_URL", "GRAFANA_BASE_URL"].sort(),
    );
    for (const token of ["CI_CD_TOKEN", "CI_BUILD_TOKEN", "GRAFANA_TOKEN"]) {
      expect(plan.nonCredentialSecretNames).not.toContain(token);
    }
  });
});
