/**
 * `credential: false` — a granted variable that is delivered but not swept.
 *
 * ## The defect, which is the detector's OPPOSITE failure
 *
 * ISC-333 was filed because `findCredentialLeaks` had nothing to look for: the
 * needle list was empty at every production call site, so the sweep could not
 * fire. This is the same defect with one sign flipped. `secrets:` is the only
 * per-worker delivery channel that exists, so `TICKET_BASE_URL` — a public
 * endpoint — has to be granted for the worker to receive it; it is over the
 * eight-byte floor; and it appears in EVERY command a ticket worker
 * legitimately records. So `parseTicketOpsArtifact` refused every
 * `ticket-ops.json` as carrying a credential, and every verdict clamped.
 *
 * A finding on every honest run carries no more information than a finding on
 * none, and it additionally trains an operator to disbelieve the detector on
 * the day it catches the real thing.
 *
 * ## What the flag is, and the two things it is not
 *
 * It says exactly one thing: **do not use this value as a needle.** It is not
 * a delivery change — the name is still granted, the worker still gets a 0444
 * file and a `<NAME>_FILE` pointer, and every reserved-name and allowlist check
 * applies unchanged. And it is not a heuristic: there is no property of a
 * VALUE that distinguishes a public endpoint from a token above the length
 * floor, so an operator says which, once, in the document that granted it.
 *
 * The tests below are paired on purpose. Every one that shows the URL is not
 * swept has a sibling showing the TOKEN still is, because a change that
 * disarmed the sweep wholesale would satisfy half of this file and is the
 * failure that matters.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretsSchema,
  nonCredentialSecretNames,
  secretGrantNames,
} from "../../src/config/schema.ts";
import { WorkerLaunchSchema, findCredentialLeaks, parseTicketOpsArtifact } from "../../src/contracts.ts";
import { resolveWorkerNeedles } from "../../src/harvest/needles.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";

const TOKEN = "tok-not-a-real-credential-0123456789";
const BASE_URL = "https://tickets.example.com/api/v2";

describe("the config surface", () => {
  test("a bare string is a credential, and the long form defaults to one too", () => {
    const parsed = SecretsSchema.parse({
      env_allowlist: ["TICKET_API_TOKEN", { name: "OTHER" }],
    });
    expect(secretGrantNames(parsed.env_allowlist)).toEqual(["TICKET_API_TOKEN", "OTHER"]);
    // THE DEFAULT IS THE SAFE ONE. An operator who reaches for the long form to
    // add a field must not silently disarm the sweep for that name.
    expect(nonCredentialSecretNames(parsed.env_allowlist)).toEqual([]);
  });

  test("credential: false names it, and the grant is unaffected", () => {
    const parsed = SecretsSchema.parse({
      env_allowlist: ["TICKET_API_TOKEN", { name: "TICKET_BASE_URL", credential: false }],
    });
    expect(secretGrantNames(parsed.env_allowlist)).toEqual(["TICKET_API_TOKEN", "TICKET_BASE_URL"]);
    expect(nonCredentialSecretNames(parsed.env_allowlist)).toEqual(["TICKET_BASE_URL"]);
  });

  /**
   * `[X, {name: X, credential: false}]` has no defensible reading — the sweep
   * would take whichever the implementation looked at first — so it is refused
   * rather than resolved by list order.
   */
  test("one name cannot answer twice", () => {
    expect(() =>
      SecretsSchema.parse({
        env_allowlist: ["TICKET_BASE_URL", { name: "TICKET_BASE_URL", credential: false }],
      }),
    ).toThrow(/twice with different credential settings/);
    // The same name twice with the SAME answer is a typo with one meaning, and
    // is accepted exactly as the duplicate bare strings always were.
    expect(() =>
      SecretsSchema.parse({ env_allowlist: ["TICKET_BASE_URL", "TICKET_BASE_URL"] }),
    ).not.toThrow();
  });

  test("the entry object is still strict", () => {
    expect(() =>
      SecretsSchema.parse({ env_allowlist: [{ name: "X", credentialz: false }] }),
    ).toThrow();
  });
});

describe("the needle supplier honours the run's own record", () => {
  async function rig(nonCredential: string[]): Promise<ReturnType<typeof workerPaths>> {
    const base = await mkdtemp(join(tmpdir(), "pifleet-needles-"));
    const run = runPaths("r-nc", join(base, "runs"));
    const wp = workerPaths(run, "tick-1");
    await mkdir(wp.secretsDir, { recursive: true });
    await writeFile(join(wp.secretsDir, "TICKET_API_TOKEN"), TOKEN, "utf8");
    await writeFile(join(wp.secretsDir, "TICKET_BASE_URL"), BASE_URL, "utf8");
    await writeFile(
      wp.launchJson,
      JSON.stringify(
        WorkerLaunchSchema.parse({
          kind: "container",
          argv: ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc"],
          container: "pifleet-r-nc-tick-1",
          image: "img",
          secret_names: ["TICKET_API_TOKEN", "TICKET_BASE_URL"],
          non_credential_secrets: nonCredential,
        }),
      ),
      "utf8",
    );
    return wp;
  }

  test("a declared non-credential is delivered but not swept", async () => {
    const wp = await rig(["TICKET_BASE_URL"]);
    const supply = await resolveWorkerNeedles(wp);
    expect(supply.names).toEqual(["TICKET_API_TOKEN"]);
    expect(supply.needles).toEqual([TOKEN]);
    // Not a degradation: nothing failed to resolve, so nothing is noted.
    expect(supply.note).toBeNull();
    await rm(wp.dir, { recursive: true, force: true });
  });

  /**
   * THE CONTROL, and it is the one that has to hold. One variable differs from
   * the test above — the recorded declaration — and the URL comes back as a
   * needle, which is what a change that disarmed the sweep wholesale could not
   * produce.
   */
  test("with nothing declared, both values are swept", async () => {
    const wp = await rig([]);
    const supply = await resolveWorkerNeedles(wp);
    expect(supply.names.sort()).toEqual(["TICKET_API_TOKEN", "TICKET_BASE_URL"]);
    expect(supply.needles.sort()).toEqual([TOKEN, BASE_URL].sort());
    await rm(wp.dir, { recursive: true, force: true });
  });

  /**
   * The record is INTERSECTED with the grant rather than trusted. A name the
   * worker never held cannot narrow a sweep, so a hand-edited or migrated run
   * directory cannot turn the detector off for something it was never about.
   */
  test("a declaration naming an ungranted variable changes nothing", async () => {
    const wp = await rig(["SOMETHING_ELSE"]);
    const supply = await resolveWorkerNeedles(wp);
    expect(supply.names.sort()).toEqual(["TICKET_API_TOKEN", "TICKET_BASE_URL"]);
    await rm(wp.dir, { recursive: true, force: true });
  });

  /**
   * Old records parse as "every grant is a credential".
   *
   * The conservative reading, and the one that keeps an existing run's sweep
   * exactly as wide as it was on the day it ran — a defaulted field that
   * defaulted the other way would silently narrow every historical harvest.
   */
  test("a record written before the field existed sweeps everything", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-needles-old-"));
    const run = runPaths("r-old", join(base, "runs"));
    const wp = workerPaths(run, "tick-1");
    await mkdir(wp.secretsDir, { recursive: true });
    await writeFile(join(wp.secretsDir, "TICKET_BASE_URL"), BASE_URL, "utf8");
    // Built through the schema and then STRIPPED, rather than hand-written: a
    // hand-written record that is merely invalid would be rejected by
    // `readWorkerLaunch` and the test would pass for the wrong reason — an
    // empty needle set proves nothing about a defaulted field.
    const current = WorkerLaunchSchema.parse({
      kind: "container",
      argv: ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc"],
      container: "pifleet-r-old-tick-1",
      image: "img",
      secret_names: ["TICKET_BASE_URL"],
    }) as Record<string, unknown>;
    delete current["non_credential_secrets"];
    expect(current["non_credential_secrets"]).toBeUndefined();
    await writeFile(wp.launchJson, JSON.stringify(current), "utf8");
    const supply = await resolveWorkerNeedles(wp);
    expect(supply.names).toEqual(["TICKET_BASE_URL"]);
    await rm(base, { recursive: true, force: true });
  });
});

/**
 * The consequence an operator actually sees, at the function that clamps the
 * verdict.
 *
 * This is the criterion rather than the mechanism: the mechanism could be
 * right at every seam above and still leave the artifact refused, which is the
 * shape ISC-380's join failure had.
 */
describe("the ticket-ops artifact the whole thing was clamping", () => {
  /**
   * A REAL artifact, in the schema's own shape — a `commands` list that names
   * the endpoint the worker was pointed at is the honest output this was
   * clamping, not a contrived one.
   */
  const artifact = {
    schema: "pifleet.ticket-ops/v1",
    task_id: "t-1",
    worker: "tick-1",
    epoch: 1,
    operation: "query" as const,
    ticket_host: "tickets.example.com",
    generated_at: new Date().toISOString(),
    no_change_needed: false,
    queried: [{ ticket: "T-9", fields: [{ field: "State", value: "Open" }] }],
    updates: [],
    commands: [`curl -H 'Authorization: Token <redacted>' ${BASE_URL}/defect/1`],
    verdict: "success" as const,
    notes: "queried one ticket",
  };

  test("an artifact naming the endpoint is accepted once it is declared", () => {
    // Both values as needles: the endpoint in the artifact is a "leak".
    expect(findCredentialLeaks(artifact, [TOKEN, BASE_URL]).length).toBeGreaterThan(0);
    // The needle set the supplier now produces for that same run.
    expect(findCredentialLeaks(artifact, [TOKEN])).toEqual([]);
    expect(() => parseTicketOpsArtifact(artifact, [TOKEN])).not.toThrow();
  });

  /**
   * AND THE TOKEN IS STILL CAUGHT. Without this, every assertion above is
   * satisfied by simply deleting the sweep.
   */
  test("a real credential in the same artifact is still refused", () => {
    // In `notes`, not in `commands`: the schema ALREADY refuses an un-elided
    // Authorization header, and a fixture that tripped that guard would prove
    // the schema works rather than the sweep. Prose is where a credential
    // actually escapes.
    const leaky = { ...artifact, notes: `retried with token ${TOKEN} and it worked` };
    expect(findCredentialLeaks(leaky, [TOKEN]).length).toBeGreaterThan(0);
    expect(() => parseTicketOpsArtifact(leaky, [TOKEN])).toThrow(/refusing to publish/);
  });
});

/**
 * `up` WRITES the declaration the harvester reads.
 *
 * Every probe above this line grades a READER or a pure function. None grades
 * the WRITER, and this field has exactly the shape that makes a missing write
 * SILENT: `WorkerLaunchSchema` defaults it to `[]`, and that default is correct
 * — a record written before the field existed must keep parsing, and must
 * describe a run where every grant was swept.
 *
 * The cost of the correct default is that "materialize forgot to write it" and
 * "this run predates the field" are the same bytes. The symptom would be the
 * original defect returning in full: every ticket-ops artifact refused, every
 * verdict clamped, and nothing in the failure naming `credential: false`. This
 * is the mutation that survived `pane_mode` and it is not being left to survive
 * twice.
 *
 * So the record is read BACK off disk, with `WorkerLaunchSchema.parse` running
 * between the write and the assertion — an assertion on the in-memory literal
 * would pass without proving the field survives the round trip the harvester
 * actually performs.
 *
 * Both directions, because one alone is half a probe: a writer hard-coded to
 * the declared name passes the first case, and the default passes the second
 * with no writer at all.
 */
describe("the launch record carries the declaration up resolved", () => {
  test("the declared name is on the record, and an undeclared grant is not", async () => {
    const { materializeWorkerInputs } = await import("../../src/run/materialize.ts");
    const { readWorkerLaunch } = await import("../../src/run/state.ts");
    const { parseConfig } = await import("../../src/config/load.ts");
    const { stringify } = await import("yaml");

    const dir = await mkdtemp(join(tmpdir(), "pifleet-noncred-write-"));
    const runsDir = join(dir, "runs");
    const prev = process.env["PIFLEET_RUNS_DIR"];
    const prevSkills = process.env["PIFLEET_SKILLS_DIR"];
    const prevToken = process.env["TICKET_API_TOKEN"];
    const prevUrl = process.env["TICKET_BASE_URL"];
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    delete process.env["PIFLEET_SKILLS_DIR"];
    process.env["TICKET_API_TOKEN"] = TOKEN;
    process.env["TICKET_BASE_URL"] = BASE_URL;
    try {
      await mkdir(join(dir, "roles"), { recursive: true });
      await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");

      const path = join(dir, "fleet.yaml");
      await writeFile(
        path,
        stringify({
          version: 2,
          name: "non-credential-fixture",
          docker: { pi_version: "0.79.6" },
          run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
          llm: { model: "FixtureModel" },
          roles: { eng: { append_system_prompt_file: "./roles/eng.md" } },
          secrets: {
            env_allowlist: [
              "TICKET_API_TOKEN",
              { name: "TICKET_BASE_URL", credential: false },
              // Declared on the fleet-wide ceiling and NOT requested by this
              // worker. It is here because the record must describe THIS
              // worker's grant: copying the fleet declaration wholesale would
              // put a variable in the run record that the run never delivered,
              // and that survived the first mutation battery.
              { name: "OTHER_BASE_URL", credential: false },
            ],
          },
          workers: [{ id: "tick-1", role: "eng", secrets: ["TICKET_API_TOKEN", "TICKET_BASE_URL"] }],
        }),
      );
      const loaded = await parseConfig(await Bun.file(path).text(), path);
      const run = runPaths("nc-run", runsDir);
      await mkdir(run.root, { recursive: true });
      await materializeWorkerInputs(loaded, run, ["tick-1"], async () => {}, {
        writeLaunchRecord: true,
      });

      const rec = await readWorkerLaunch(workerPaths(run, "tick-1"));
      expect(rec, "no launch record was written").not.toBeNull();
      // The GRANT is unchanged — both names still delivered.
      expect(rec!.secret_names.sort()).toEqual(["TICKET_API_TOKEN", "TICKET_BASE_URL"]);
      // And exactly one of them is excused from the sweep.
      expect(rec!.non_credential_secrets).toEqual(["TICKET_BASE_URL"]);
      expect(rec!.non_credential_secrets).not.toContain("TICKET_API_TOKEN");
      // INTERSECTED with the grant, not copied from the fleet: a name this
      // worker never held has nothing to say about this worker's sweep.
      expect(rec!.non_credential_secrets).not.toContain("OTHER_BASE_URL");
    } finally {
      for (const [k, v] of [
        ["PIFLEET_RUNS_DIR", prev],
        ["PIFLEET_SKILLS_DIR", prevSkills],
        ["TICKET_API_TOKEN", prevToken],
        ["TICKET_BASE_URL", prevUrl],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
