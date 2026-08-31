/**
 * The TICKETING chain, in one motion: `up` -> container -> a real credentialed
 * HTTP call -> the artifact pair -> harvest.
 *
 * ## Why this exists
 *
 * ISC-349 and ISC-350 are both `[~]`, and both for the same stated reason:
 * what shipped in response to each was an INSTRUCTION, and nothing
 * reproducible watches a worker obey one. ISC-349's measurement was a worker
 * writing its output to `/outbox/list-tickets-2026-08-29/` — a slug of the job
 * it thought it had done — while the id it was dispatched under was
 * `my-iteration-2`. ISC-350's is a worker writing only the `.md` half of a pair
 * that must be both files. `full-chain.test.ts` closed ISC-290 by running the
 * whole chain for the ENGINEER role; this is the same argument for the one
 * role whose entire output is an artifact rather than a diff.
 *
 * Two live runs against Rally on 2026-08-30 got both right. Two runs is not a
 * guard. This is.
 *
 * ## Why a fixture server rather than Rally
 *
 * CI holds no ticket credential and should not — see
 * `test/fixtures/ticket-server.ts`, which also records which Rally behaviours
 * it reproduces and why each one is a trap rather than a detail. Nothing these
 * criteria assert is a fact about Rally: they are about the worker's contract.
 * What the fixture adds over the real thing is DETERMINISM in the exact place
 * the criteria care about — it always holds 33 defects of which 8 are open,
 * and it always places the open ones past the first page, so a worker that
 * filters what it was handed reports zero rather than a plausible-looking
 * number.
 *
 * ## What each assertion is for
 *
 * | assertion | criterion | what it catches |
 * |---|---|---|
 * | the outbox dir is the dispatched id, and is the only one | ISC-349 | a slug invented from the title |
 * | both halves of the pair exist | ISC-350 | the measured `.md`-only run |
 * | `queried` holds 8 | ISC-344 | a count the server contradicts |
 * | every `curl` in `commands` carries `--max-time` | ISC-344 | an unbounded request, which HANGS rather than fails |
 * | the server saw `ZSESSIONID` and never `Authorization` | — | the skill's auth header, which was a different vendor's until 2026-08-30 |
 * | the server saw a `query` parameter | — | download-and-grep, which the role forbids and which produced a wrong answer live |
 *
 * The count assertion is the one worth reading twice. 8 is not "the number the
 * model said"; it is the number the fixture will confirm, and the fixture puts
 * every one of those 8 on the SECOND page. There is no way to arrive at it by
 * filtering the response to a default request.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { spawnCli, type CliResult } from "../support/spawn-cli.ts";
import { gateBudget } from "../support/budget.ts";
import { daemonScratchRoot } from "../../src/container/mounts.ts";
import { TicketOpsArtifactSchema } from "../../src/contracts.ts";
import { startTicketServer, FIXTURE_OWNER, type TicketServerHandle } from "../fixtures/ticket-server.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";
const BASE_URL = process.env["PIFLEET_OMLX_BASE_URL"] ?? "http://localhost:8000/v1";
const OMLX_KEY = process.env["OMLX_API_KEY"] ?? "";

/** Lifted from `full-chain.test.ts` rather than respelled: one answer to "is oMLX there". */
async function omlxReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3_000) });
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

const CHAIN_LIVE = DOCKER && OMLX_KEY !== "" && (await omlxReachable());

if (!DOCKER) {
  console.warn(
    "[skip] the ticketing chain needs a Docker daemon and a built BASE worker image. " +
      "Run with PIFLEET_DOCKER=1 after 'pifleet image build --toolchain base'.",
  );
} else if (!CHAIN_LIVE) {
  console.warn(`[skip] the ticketing chain needs a reachable ${BASE_URL} and OMLX_API_KEY.`);
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * The id the worker must bind, and it is deliberately UNLIKE any slug of the
 * title. ISC-349's measured failure was a worker deriving
 * `list-tickets-2026-08-29` from what it thought the job was; an id that a
 * plausible slug could collide with would let that failure pass.
 */
const TASK_ID = "tk-9c3f-1";
const TASK_TITLE = "Count the open fixture defects";
const TICKET_TOKEN = "fixture-token-8f2a-4d1e";
const EXPECTED_OPEN = 8;

const TASK_DEADLINE_S = 420;
const UP_GATE_MS = 300_000;
const DISPATCH_GATE_MS = TASK_DEADLINE_S * 1_000 + 120_000;
const DOWN_GATE_MS = 120_000;

/**
 * How the WORKER addresses the fixture, and why it is an address rather than a
 * name.
 *
 * The obvious choice is `host.docker.internal`, and it fails in a way that
 * takes a while to see. Measured on 2026-08-30: the worker container is on the
 * `internal: true` egress bridge, gets NO `--add-host`, and its `NO_PROXY`
 * reads `omlx.pifleet.internal,host.docker.internal,localhost,127.0.0.1`. So a
 * request to that name is excluded from the proxy by policy and then has no
 * route of its own — the fixture recorded **zero requests** while the worker
 * produced a confident artifact reporting zero results.
 *
 * The working path is the one the design intends: dial a host the proxy is
 * allowed to reach, and let `HTTPS_PROXY` carry it. The egress proxy sits on
 * the non-internal uplink network, from which the host's own LAN address is
 * reachable (verified from a container on `pifleet-egress-uplink`), and that
 * address is not on `NO_PROXY`, so the request actually goes through the
 * allowlist it is supposed to go through.
 *
 * Auto-detected rather than hardcoded so this works on a runner as well as a
 * laptop; overridable for a host whose first non-internal interface is not the
 * one a container can see.
 */
function hostAddress(): string {
  const override = process.env["PIFLEET_TEST_HOST_ADDRESS"];
  if (override !== undefined && override !== "") return override;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  throw new Error("no non-internal IPv4 interface found; set PIFLEET_TEST_HOST_ADDRESS");
}

const CONTAINER_HOST = hostAddress();

interface Rig {
  base: string;
  runsRoot: string;
  configPath: string;
  tasksPath: string;
  runId: string;
}

const rigs: Rig[] = [];
const servers: TicketServerHandle[] = [];

afterAll(async () => {
  for (const rig of rigs) {
    if (rig.runId !== "") {
      await spawnCli(["down", "--run", rig.runId], {
        env: { PIFLEET_RUNS_DIR: rig.runsRoot, PIFLEET_PI_COMMAND: "" },
      }).catch(() => undefined);
    }
    await rm(rig.base, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const s of servers) await s.close();
});

function cli(rig: Rig, args: readonly string[], env: Record<string, string> = {}): Promise<CliResult> {
  return spawnCli(args, {
    env: {
      PIFLEET_RUNS_DIR: rig.runsRoot,
      // EMPTY, not absent: a non-empty value selects the Pi double, which
      // writes a process launch record and never starts a container — a green
      // result having tested nothing this file is about.
      PIFLEET_PI_COMMAND: "",
      ...env,
    },
  });
}

async function makeRig(): Promise<Rig> {
  const scratch = daemonScratchRoot();
  await mkdir(scratch, { recursive: true });
  const base = await mkdtemp(join(scratch, "pifleet-ticketing-"));
  const rig: Rig = {
    base,
    runsRoot: join(base, "runs"),
    configPath: join(base, "fleet.yaml"),
    tasksPath: join(base, "tasks.json"),
    runId: "",
  };
  rigs.push(rig);
  return rig;
}

/**
 * A config with ONE ticketing worker, built by editing the shipped example so
 * the schema that validates it is the real one.
 */
async function writeConfig(rig: Rig, model: string, ticketPort: number): Promise<void> {
  const example = parseYaml(
    await readFile(join(REPO_ROOT, "fleet.example.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const section = (key: string): Record<string, unknown> => {
    const v = example[key];
    if (typeof v !== "object" || v === null) {
      throw new Error(`fleet.example.yaml has no \`${key}:\` section to override`);
    }
    return v as Record<string, unknown>;
  };

  example["name"] = "ticketing-chain";
  const runCfg = section("run");
  // `isolation: none` on the role means no worktree, but `run.repo` is still
  // read at `up`; the checkout itself is never mounted for this role.
  runCfg["repo"] = REPO_ROOT;
  runCfg["max_concurrent"] = 1;

  const llmCfg = section("llm");
  llmCfg["model"] = model;
  llmCfg["models_allowlist"] = [model];

  const allow: Array<{ host: string; port: number }> = [
    // The fixture. Without this the worker has a proxy route and no permitted
    // destination, which is a refusal rather than a hang — the shape an
    // operator should get for a missing allow rule.
    { host: CONTAINER_HOST, port: ticketPort },
  ];
  const upstream = process.env["PIFLEET_TEST_RELAY_UPSTREAM"] ?? "";
  if (upstream !== "") {
    const [host, port] = upstream.split(":");
    if (host === undefined || port === undefined || !/^\d+$/.test(port)) {
      throw new Error(`PIFLEET_TEST_RELAY_UPSTREAM must be host:port, got "${upstream}"`);
    }
    llmCfg["relay_upstream"] = upstream;
    allow.push({ host, port: Number(port) });
  }
  example["egress"] = { allow };

  section("cloud")["adc"] = false;
  example["secrets"] = { env_allowlist: ["TICKET_API_TOKEN", "TICKET_BASE_URL"] };

  const ticketing = section("roles")["ticketing"] as Record<string, unknown>;
  ticketing["append_system_prompt_file"] = join(REPO_ROOT, "roles", "ticketing.md");
  // The ROLE's model is what `defaults <- roles <- worker` resolves to, so
  // setting only `llm.model` would leave the example's and fail the allowlist
  // gate — measured in `full-chain.test.ts` and not rediscovered here.
  ticketing["model"] = model;
  example["roles"] = { ticketing };
  example["workers"] = [{ id: "tick-1", role: "ticketing" }];

  await writeFile(rig.configPath, stringifyYaml(example), "utf8");
}

async function writeTaskList(rig: Rig): Promise<void> {
  await writeFile(
    rig.tasksPath,
    JSON.stringify(
      {
        schema: "pifleet.tasklist/v1",
        tasks: [
          {
            id: TASK_ID,
            title: TASK_TITLE,
            worker: "tick-1",
            brief:
              `This is a QUERY. Make no writes of any kind.\n\n` +
              `Ask the ticket API how many defects owned by ${FIXTURE_OWNER} are NOT in state ` +
              `"Closed", and list every one of them. The type segment is \`defect\`. Filter ` +
              `SERVER-SIDE and reconcile your count against TotalResultCount — the default page ` +
              `is smaller than the total, and the ones you want are not on it.\n\n` +
              `Write the ticket-ops pair to your outbox as the ticket-ops skill describes. Put ` +
              `one entry in \`queried\` for each defect you found, and record the actual curl ` +
              `command lines you ran in \`commands\`.`,
            acceptance: [
              "ticket-ops.json and ticket-ops.md both exist in the outbox",
              "every open defect is listed, reconciled against TotalResultCount",
              "no writes were made",
            ],
            deadline_s: TASK_DEADLINE_S,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("the ticketing chain, in one motion (ISC-349, ISC-350)", () => {
  test.skipIf(!CHAIN_LIVE)(
    "a ticketing worker binds its dispatched id, writes the pair, and reconciles a paged count",
    async () => {
      const model = process.env["PIFLEET_OMLX_MODEL"] ?? "";
      expect(
        model,
        "PIFLEET_OMLX_MODEL must name the model to run this chain against; it is deliberately " +
          "not inferred (see full-chain.test.ts).",
      ).not.toBe("");

      const ticket = await startTicketServer({ token: TICKET_TOKEN, hostname: "0.0.0.0" });
      servers.push(ticket);

      const rig = await makeRig();
      await writeConfig(rig, model, ticket.port);
      await writeTaskList(rig);

      const credentials = {
        TICKET_API_TOKEN: TICKET_TOKEN,
        TICKET_BASE_URL: `http://${CONTAINER_HOST}:${ticket.port}`,
      };

      const up = await cli(
        rig,
        ["up", "--config", rig.configPath, "--backend", "headless", "--json"],
        credentials,
      );
      expect(up.code, `up failed:\n${up.stdout}\n${up.stderr}`).toBe(0);
      const upPayload = JSON.parse(up.stdout.trim()) as { run_id: string; workers: Array<{ id: string }> };
      expect(upPayload.workers.map((w) => w.id)).toEqual(["tick-1"]);
      rig.runId = upPayload.run_id;

      const dispatch = await cli(
        rig,
        ["dispatch", "--auto", "--tasks", rig.tasksPath, "--run", rig.runId, "--json"],
        credentials,
      );
      expect(dispatch.code, `dispatch failed:\n${dispatch.stdout}\n${dispatch.stderr}`).toBe(0);

      // --- ISC-349: the outbox directory is the id the worker was DISPATCHED
      //     under, and nothing else is there.
      const outboxRoot = join(rig.runsRoot, rig.runId, "outbox", "tick-1");
      const entries = (await readdir(outboxRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name !== "ledger")
        .map((e) => e.name)
        .sort();
      expect(
        entries,
        `the worker wrote to ${JSON.stringify(entries)}; it was dispatched under ` +
          `"${TASK_ID}". A directory named after the JOB rather than the ID is ISC-349's ` +
          `measured failure — the harvester opens one directory and no other, so a ` +
          `plausible name is a run recorded as having produced nothing.`,
      ).toEqual([TASK_ID]);

      // --- ISC-350: BOTH halves of the pair. The `.md` alone is the measured
      //     failure, and it is the half nothing inspects.
      const files = (await readdir(join(outboxRoot, TASK_ID, "files"))).sort();
      expect(files, `the outbox held ${JSON.stringify(files)}`).toContain("ticket-ops.json");
      expect(files, `the outbox held ${JSON.stringify(files)}`).toContain("ticket-ops.md");

      // --- the artifact parses under the SHIPPED schema, not a local copy.
      const raw = JSON.parse(
        await readFile(join(outboxRoot, TASK_ID, "files", "ticket-ops.json"), "utf8"),
      );
      const artifact = TicketOpsArtifactSchema.parse(raw);
      expect(artifact.task_id, "the artifact names a different task than the one dispatched").toBe(
        TASK_ID,
      );
      expect(artifact.operation).toBe("query");
      expect(artifact.updates, "a QUERY task must make no writes").toEqual([]);

      // --- ISC-344, first half: a count the SERVER contradicts. Every one of
      //     the 8 is past the first page, so this number cannot be reached by
      //     filtering a default response.
      /**
       * The failure message carries the SERVER'S LOG, not just the number.
       *
       * "expected 8, got 0" names the symptom and leaves the two causes
       * indistinguishable: a worker that filtered page one, and a worker whose
       * query was malformed and got the `200`-with-`Errors` that Rally answers
       * a bad filter with. Those need opposite fixes, and the request log is
       * the only place the difference is visible.
       */
      const log = ticket.requests
        .map((r, i) => `  [${i}] query=${JSON.stringify(r.query)} start=${r.start} pagesize=${r.pagesize}`)
        .join("\n");
      expect(
        artifact.queried.length,
        `the artifact reports ${artifact.queried.length} tickets; the fixture holds ` +
          `${EXPECTED_OPEN} open ones and puts every one of them past the default page. A ` +
          `smaller number is a worker that filtered the page it was handed — the failure ` +
          `roles/ticketing.md was written against, and the one a live Rally run reproduced.\n` +
          `What the server was actually asked (${ticket.requests.length} requests):\n${log}`,
      ).toBe(EXPECTED_OPEN);

      // --- ISC-344, second half: the recorded calls are BOUNDED. An unbounded
      //     request inside a container does not fail, it hangs, and the only
      //     signal reaching the supervisor is silence.
      const curls = artifact.commands.filter((c) => c.includes("curl"));
      expect(
        curls.length,
        `the artifact's \`commands\` recorded no curl at all: ${JSON.stringify(artifact.commands)}. ` +
          `A live run wrote the prose "Rally WSAPI query for open defects" into this field, ` +
          `which is a description where the evidence goes.`,
      ).toBeGreaterThanOrEqual(1);
      for (const c of curls) {
        expect(c, `unbounded request recorded: ${c}`).toContain("--max-time");
      }

      // --- the server's own view, which no artifact can fake.
      const seen = ticket.requests;
      expect(seen.length, "the fixture server was never called").toBeGreaterThanOrEqual(1);
      expect(
        seen.some((r) => r.authenticated),
        "no request authenticated; the skill's ZSESSIONID header did not reach the server",
      ).toBe(true);
      expect(
        seen.filter((r) => r.wrongAuthScheme).length,
        "a request arrived with `Authorization:` and no `ZSESSIONID:` — the header shape the " +
          "skill shipped until 2026-08-30, which Rally answers with an HTML login page",
      ).toBe(0);
      expect(
        seen.some((r) => r.query !== null && r.query !== ""),
        "no request carried a `query` parameter: the worker downloaded a collection and " +
          "searched it locally, which is what roles/ticketing.md forbids and what produced a " +
          "confidently wrong total on a live run",
      ).toBe(true);

      const down = await cli(rig, ["down", "--run", rig.runId]);
      expect(down.code, `down failed:\n${down.stdout}\n${down.stderr}`).toBe(0);
      rig.runId = "";
    },
    gateBudget([UP_GATE_MS, DISPATCH_GATE_MS, DOWN_GATE_MS]),
  );
});
