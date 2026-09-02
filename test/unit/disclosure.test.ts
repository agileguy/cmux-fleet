/**
 * The §7.3 disclosure row — ISC-414, ISC-415, and the half of ISC-417 that a
 * derivation can answer.
 *
 * ## What these are FOR, given that D10 reversed a refusal
 *
 * The draft SRD wanted `up` to refuse a `hosted: true` worker holding
 * `cloud_access: true` or a non-empty `secrets:`. The owner ruled against it
 * (D10): every role stays eligible and **the control is prominence rather than
 * prevention**. So the tests below are not testing a gate. They are testing
 * the only thing that now stands between an operator and a repository, a
 * Google identity or a ticket credential crossing to a vendor — the accuracy
 * of one printed list.
 *
 * That inverts what "a failing test" has to mean here. A gate's tests ask *did
 * it refuse*; these ask *did it UNDER-REPORT*, because every way this can be
 * wrong is a way of saying less than the truth: a hosted worker missing from
 * the list, a `cloud_access` that reads `false`, a granted secret name that is
 * not there. Each of the four is written as its own case for that reason,
 * rather than folded into one "the row is correct" assertion that a partial
 * regression could still satisfy.
 *
 * ## The equality pin at the bottom is the load-bearing one
 *
 * `disclosureFor` derives granted secret names from CONFIG ALONE, with no host
 * environment, which is what lets the banner print before `up` has created
 * anything. That is only sound because every path in `buildWorkerEnv`'s grant
 * loop that would EXCLUDE a requested name throws rather than skipping it. The
 * argument is correct today and is exactly the kind that rots: one `throw`
 * turned into a `continue` during some later refactor and this module starts
 * claiming a grant that never happened, silently, on the surface whose entire
 * job is not to be silent. `the granted names are buildWorkerEnv's` runs both
 * derivations against one config and compares.
 */

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, resolveWorker, type LoadedConfig } from "../../src/config/load.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";
import {
  disclosureFor,
  formatDisclosureBanner,
  type DisclosureRow,
} from "../../src/security/disclosure.ts";

const MODEL = "gpt-oss";
const CONFIG_DIR = join(tmpdir(), "pifleet-disclosure");
const CONFIG_PATH = join(CONFIG_DIR, "fleet.yaml");

/**
 * A sentinel VALUE that must never appear on any surface these tests read.
 *
 * `secretNames` is a `string[]` of names and cannot structurally hold a value,
 * so an assertion that the banner omits this is not testing an `if`. It is
 * testing that nothing downstream — a formatter change, a future field —
 * reintroduces the value channel that the type was chosen to close.
 */
const TICKET_VALUE = "sentinel-ticket-value-7c31";

const load = (d: Record<string, unknown>): Promise<LoadedConfig> =>
  parseConfig(stringify(d), CONFIG_PATH);

/** A two-provider document: one local, one hosted, workers on each. */
function doc(over: { workers?: Record<string, unknown>[] } = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "disclosure",
    docker: { pi_version: "0.79.6", network: "pifleet-disclosure" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: {
      model: MODEL,
      provider: "omlx",
      providers: {
        omlx: { hosted: false, base_url: "http://omlx.pifleet.internal:8000/v1", api_key_env: "LOCAL_KEY" },
        "ollama-cloud": { hosted: true, base_url: "https://ollama.com/v1", api_key_env: "CLOUD_KEY" },
      },
    },
    secrets: { env_allowlist: ["TICKET_API_TOKEN", "OTHER_TOKEN"] },
    roles: { plain: {} },
    workers: over.workers ?? [
      { id: "w-local", role: "plain" },
      { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}` },
    ],
    egress: { allow: [] },
  };
}

/**
 * The FLAT §6.1 shorthand — no `providers` map, so no `hosted` field exists to
 * set. Every pre-D7 `fleet.yaml` on the operator's disk is this shape.
 */
function flatDoc(): Record<string, unknown> {
  return {
    version: 2,
    name: "disclosure-flat",
    docker: { pi_version: "0.79.6", network: "pifleet-disclosure" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: MODEL, base_url: "http://omlx.pifleet.internal:8000/v1" },
    secrets: { env_allowlist: ["TICKET_API_TOKEN"] },
    roles: { plain: {} },
    workers: [
      {
        id: "w-flat",
        role: "plain",
        cloud_access: true,
        secrets: ["TICKET_API_TOKEN"],
      },
    ],
    egress: { allow: [] },
  };
}

const rowFor = async (d: Record<string, unknown>, id: string): Promise<DisclosureRow | null> => {
  const loaded = await load(d);
  return disclosureFor(loaded, resolveWorker(loaded, id));
};

// ---------------------------------------------------------------------------
// Who is on the list at all
// ---------------------------------------------------------------------------

describe("disclosureFor: membership tracks `hosted`, and only `hosted`", () => {
  test("a worker on a hosted provider produces a row naming its provider", async () => {
    const row = await rowFor(doc(), "w-cloud");
    expect(row).not.toBeNull();
    expect(row?.workerId).toBe("w-cloud");
    expect(row?.role).toBe("plain");
    expect(row?.provider).toBe("ollama-cloud");
  });

  /**
   * The anti-case, and it is the one a mutation reaches first: a formatter or
   * a predicate that put EVERY worker on the list would satisfy every
   * "the hosted worker appears" assertion above and would also disclose a
   * fleet's entire local roster as if it were leaving the machine. An
   * over-reporting banner is how §7.4's "the operator stops reading it"
   * failure begins.
   */
  test("a worker on a NON-hosted provider produces no row", async () => {
    expect(await rowFor(doc(), "w-local")).toBeNull();
  });

  /**
   * THE LOUDEST WRONG ANSWER. A flat fleet has no `hosted` field anywhere in
   * it, and this one holds BOTH credentials — `cloud_access: true` and a
   * granted secret. If `hosted` were inferred, or if a missing map defaulted
   * to anything but false, every existing fleet on the operator's disk would
   * begin printing a disclosure banner about an oMLX on their own machine,
   * and the banner would be scenery inside a week.
   */
  test("a flat pre-D7 fleet holding cloud_access AND a secret produces no row", async () => {
    expect(await rowFor(flatDoc(), "w-flat")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two fields D10 made load-bearing
// ---------------------------------------------------------------------------

describe("disclosureFor: the credentials D10 stopped refusing", () => {
  /**
   * ISC-414. §7.3: *"whether it holds `cloud_access`"*. Before D10 this
   * described a configuration `up` refused, so the row had no reason to carry
   * it; after D10 it describes a configuration that stands up, and this field
   * is the only notice the operator gets.
   */
  test("cloud_access is carried onto the row", async () => {
    const row = await rowFor(
      doc({
        workers: [
          { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}`, cloud_access: true },
        ],
      }),
      "w-cloud",
    );
    expect(row?.cloudAccess).toBe(true);
  });

  test("cloud_access reads false when the worker does not hold it", async () => {
    const row = await rowFor(doc(), "w-cloud");
    expect(row?.cloudAccess).toBe(false);
  });

  /**
   * ISC-415. §7.3: *"which `secrets:` names it was granted"*. NAMES, and the
   * second assertion is the one that matters more than it looks: the row is
   * serialized whole and searched for the VALUE, so a future field that
   * carried one would fail here rather than in an operator's scrollback.
   */
  test("the granted secret NAMES are carried, and no value is reachable", async () => {
    const row = await rowFor(
      doc({
        workers: [
          {
            id: "w-cloud",
            role: "plain",
            model: `ollama-cloud/${MODEL}`,
            secrets: ["TICKET_API_TOKEN", "OTHER_TOKEN"],
          },
        ],
      }),
      "w-cloud",
    );
    expect(row?.secretNames).toEqual(["TICKET_API_TOKEN", "OTHER_TOKEN"]);
    expect(JSON.stringify(row)).not.toContain(TICKET_VALUE);
  });

  test("a worker granted nothing carries an empty name list, not a missing one", async () => {
    const row = await rowFor(doc(), "w-cloud");
    expect(row?.secretNames).toEqual([]);
  });

  /**
   * `secrets: [X, X]` is a typo with one obvious meaning, and `buildWorkerEnv`
   * dedupes it silently. The banner must dedupe the same way or it invites the
   * reader to believe two things were granted — and, more sharply, ISC-417
   * compares this list against the record's and a duplicate on one side only
   * is a mismatch.
   */
  test("a duplicated request is deduped, first occurrence winning", async () => {
    const row = await rowFor(
      doc({
        workers: [
          {
            id: "w-cloud",
            role: "plain",
            model: `ollama-cloud/${MODEL}`,
            secrets: ["TICKET_API_TOKEN", "TICKET_API_TOKEN"],
          },
        ],
      }),
      "w-cloud",
    );
    expect(row?.secretNames).toEqual(["TICKET_API_TOKEN"]);
  });
});

// ---------------------------------------------------------------------------
// The repository — the largest surface (§7.3's own title)
// ---------------------------------------------------------------------------

describe("disclosureFor: the repository is the CONFIGURED path", () => {
  /**
   * Expanded against the config's own directory, not the process cwd. A
   * relative `run.repo` that reached the banner unexpanded would name a path
   * that is correct only if the operator happened to `cd` to the config's
   * directory first — and §7.3's whole point is that the operator can see
   * WHICH repository is going to the vendor.
   */
  test("worktree isolation names run.repo, expanded against the config dir", async () => {
    const row = await rowFor(doc(), "w-cloud");
    expect(row?.isolation).toBe("worktree");
    expect(row?.repo).toBe(join(CONFIG_DIR, "repo"));
  });

  test("shared-ro also sends source, so it names the repository too", async () => {
    const row = await rowFor(
      doc({
        workers: [
          { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}`, isolation: "shared-ro" },
        ],
      }),
      "w-cloud",
    );
    expect(row?.isolation).toBe("shared-ro");
    expect(row?.repo).toBe(join(CONFIG_DIR, "repo"));
  });

  /**
   * `isolation: none` is the one mode with no `/workspace` — `worker-env.ts`
   * draws the same line for its `safe.directory` block. A null here is what an
   * operator reads as "no source leaves the machine", so this branch is
   * asserted on its own: a path appearing where null belongs OVER-reports, and
   * a null appearing where a path belongs UNDER-reports, which is the failure
   * this whole module exists to prevent.
   */
  test("isolation: none has no repository to name", async () => {
    const row = await rowFor(
      doc({
        workers: [
          { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}`, isolation: "none" },
        ],
      }),
      "w-cloud",
    );
    expect(row?.isolation).toBe("none");
    expect(row?.repo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The equality that lets this run before anything exists
// ---------------------------------------------------------------------------

describe("disclosureFor: the granted names are buildWorkerEnv's", () => {
  /**
   * See this file's header. `disclosureFor` needs no host environment because
   * `buildWorkerEnv`'s grant loop THROWS on every name it would exclude — so
   * "requested, deduped" and "granted" are the same list. This runs both and
   * compares, so that turning any of those throws into a skip fails here
   * instead of quietly widening what the banner claims was granted.
   */
  test("both derivations produce the same names for the same worker", async () => {
    const d = doc({
      workers: [
        {
          id: "w-cloud",
          role: "plain",
          model: `ollama-cloud/${MODEL}`,
          secrets: ["TICKET_API_TOKEN", "TICKET_API_TOKEN", "OTHER_TOKEN"],
        },
      ],
    });
    const loaded = await load(d);
    const w = resolveWorker(loaded, "w-cloud");
    const plan = buildWorkerEnv(loaded, w, {
      CLOUD_KEY: "sentinel-cloud-key",
      TICKET_API_TOKEN: TICKET_VALUE,
      OTHER_TOKEN: "sentinel-other-value",
    });
    const row = disclosureFor(loaded, w);
    expect(row?.secretNames).toEqual(plan.secretNames);
    // Anti-vacuity: an equality of two empty lists would pass against a
    // `disclosureFor` that returned no names at all.
    expect(plan.secretNames.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

describe("formatDisclosureBanner", () => {
  /**
   * §7.4 names the habit this prevents: *"if an operator stops reading the
   * banner because it prints on every `up`, the reversal has stopped being a
   * loud grant and become a silent one"*. A banner that appeared on every run
   * saying nothing had happened is how that habit forms.
   */
  test("nothing leaving the machine prints nothing at all", () => {
    expect(formatDisclosureBanner([])).toBeNull();
  });

  test("every field §7.3 names appears in the text", async () => {
    const row = await rowFor(
      doc({
        workers: [
          {
            id: "w-cloud",
            role: "plain",
            model: `ollama-cloud/${MODEL}`,
            cloud_access: true,
            secrets: ["TICKET_API_TOKEN"],
          },
        ],
      }),
      "w-cloud",
    );
    const banner = formatDisclosureBanner([row as DisclosureRow]) ?? "";
    expect(banner).toContain("w-cloud");
    expect(banner).toContain("plain");
    expect(banner).toContain("ollama-cloud");
    expect(banner).toContain("worktree");
    expect(banner).toContain(join(CONFIG_DIR, "repo"));
    expect(banner).toContain("cloud_access=true");
    expect(banner).toContain("TICKET_API_TOKEN");
    // NAMES ONLY, on the surface with the widest audience — a terminal, then
    // scrollback, then a screen share or a support paste.
    expect(banner).not.toContain(TICKET_VALUE);
  });

  /**
   * §7.3: *"A credentialled worker on a hosted provider should be the most
   * conspicuous line `up` prints, because it is now permitted and nothing else
   * stops it."* The marker is what carries that, so a credentialled row and an
   * uncredentialled one must not render alike.
   */
  test("a credentialled row is marked and an uncredentialled one is not", async () => {
    const bare = (await rowFor(doc(), "w-cloud")) as DisclosureRow;
    const creds: DisclosureRow = { ...bare, workerId: "w-creds", cloudAccess: true };
    const banner = formatDisclosureBanner([bare, creds]) ?? "";
    const marked = banner
      .split("\n")
      .filter((l) => l.trimStart().startsWith("!!") && l.includes("role="));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("w-creds");
  });

  test("a secret alone marks the row, not only cloud_access", async () => {
    const bare = (await rowFor(doc(), "w-cloud")) as DisclosureRow;
    const withSecret: DisclosureRow = { ...bare, secretNames: ["TICKET_API_TOKEN"] };
    const banner = formatDisclosureBanner([withSecret]) ?? "";
    expect(banner.split("\n").some((l) => l.startsWith("!!") && l.includes("w-cloud"))).toBe(true);
  });

  test("the count in the header is the number of rows", async () => {
    const row = (await rowFor(doc(), "w-cloud")) as DisclosureRow;
    expect(formatDisclosureBanner([row]) ?? "").toContain("1 worker(s)");
    expect(formatDisclosureBanner([row, { ...row, workerId: "w-2" }]) ?? "").toContain(
      "2 worker(s)",
    );
  });
});
