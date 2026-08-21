/**
 * The durable-format refusal policy, and the guard that keeps it (ISC-192).
 *
 * ## What was decided
 *
 * An unrecognised schema stamp is a DIAGNOSED REFUSAL. Not an upgrade, not a
 * migration ladder, not a silent degradation to "no file" — a named answer that
 * says what was found, what this build expected, and what the operator can do
 * about it. This suite is that policy's test, which is the half ISC-157 asks
 * for and ISC-192 never had.
 *
 * The shape is not invented here. `down`'s `identity_legacy_format` set it one
 * channel over: an untagged identity gets its OWN refusal rather than being
 * reported as a mismatch, because saying "a stranger holds this pid" about a
 * value that merely predates a format change is a false statement about the
 * world. Same argument, same shape: `RegistrySchemaError` is not
 * `RegistryReadError` with a different sentence, it is a different fact.
 *
 * ## Why the guard is written the way it is
 *
 * `expect(readRegistry(…)).rejects.toThrow()` would pass against a bare
 * `ZodError` — which is exactly the state ISC-192 measured and this change
 * removes, so a test that cannot tell the two apart pins nothing. The
 * assertions below are therefore NEGATIVE first: no reader may leak a raw
 * `ZodError` or `SyntaxError`, whatever else it does. Delete the wrapper in
 * `readRegistry` and `notBareLibraryError` fails on the library error's own
 * name; keep a wrapper but drop its `exitCode` and the ladder assertion fails.
 * Both mutations are recorded in the commit that introduced this file.
 *
 * EVERY DURABLE READER IS DRIVEN, not just the one that changed.
 * `readWorkerState` and its `state.ts` neighbours were already wrapped by
 * `StateReadError`; including them is what makes this a suite-wide guard rather
 * than a regression test for one function. The wrapper that gets deleted next
 * is unlikely to be the one that was just written.
 *
 * No subprocess is spawned anywhere in this file — every case is a byte string
 * written to a temp directory — so no `budget.ts` allowance applies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import {
  REGISTRY_SCHEMA,
  RegistryReadError,
  RegistrySchemaError,
  readRegistry,
} from "../../src/run/registry.ts";
import { readFence, readTaskRecord, readWorkerState } from "../../src/run/state.ts";

let tmp: string;
let run: RunPaths;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-durable-"));
  run = runPaths("r-durable", tmp);
  await mkdir(workerPaths(run, "w-1").dir, { recursive: true });
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A well-formed registry, so each case can corrupt exactly one thing. */
function goodRegistry(): Record<string, unknown> {
  return {
    schema: REGISTRY_SCHEMA,
    run_id: "r-durable",
    daemon: { pid: 1, started: "" },
    workers: {},
  };
}

/**
 * Run `read`, returning whatever it threw. Fails the test if it threw nothing.
 *
 * The `returned` sentinel is why this is not a bare try/catch around a throw:
 * an in-`try` throw is caught by its OWN catch and handed back as the
 * "refusal", so a reader that degrades to `null` would be reported as a
 * missing `exitCode` rather than as the degradation it is. Written that way
 * first, and it turned M3 — the mutation that widens `null` to cover an
 * unreadable file, the single most important one in this file — into an
 * unreadable failure message. The diagnosis has to survive the mutation it
 * exists to describe.
 */
const NOTHING_THROWN = Symbol("nothing thrown");

async function refusalFrom(read: () => Promise<unknown>): Promise<unknown> {
  let returned: unknown = NOTHING_THROWN;
  try {
    returned = await read();
  } catch (err) {
    return err;
  }
  throw new Error(
    `expected a refusal, but the reader RETURNED ${JSON.stringify(returned) ?? String(returned)} — ` +
      `a reader that answers an unreadable file with a value is the exact conflation this suite ` +
      `exists to catch`,
  );
}

/**
 * The negative half, and the one that actually pins the criterion.
 *
 * A raw `ZodError` or `SyntaxError` reaching a caller is the defect: neither
 * carries an `exitCode`, so the CLI's diagnosed-failure protocol
 * (`contracts.ts`) does not recognise them and both leave as a stack trace on
 * exit 1 — a code that is not on the SRD §10 ladder at all.
 */
function notBareLibraryError(err: unknown, what: string): void {
  expect(err).toBeInstanceOf(Error);
  const e = err as Error;
  if (e instanceof z.ZodError || e.name === "ZodError") {
    throw new Error(`${what} leaked a bare ZodError — the wrapper is gone. message: ${e.message}`);
  }
  if (e instanceof SyntaxError || e.name === "SyntaxError") {
    throw new Error(`${what} leaked a bare SyntaxError — the wrapper is gone. message: ${e.message}`);
  }
  // A ZodError's message is a pretty-printed JSON array. A wrapper that merely
  // re-throws `String(zodError)` would pass the two checks above and still be
  // useless to an operator, so the rendering is pinned too.
  expect(e.message.trimStart().startsWith("[")).toBe(false);
  expect((e as { exitCode?: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
}

describe("readRegistry refuses, by name, per fact", () => {
  test("an unrecognised schema stamp is its own answer, and names the hatch", async () => {
    await writeFile(
      run.registryJson,
      JSON.stringify({ ...goodRegistry(), schema: "pifleet.registry/v0" }),
    );
    const err = await refusalFrom(() => readRegistry(run));
    notBareLibraryError(err, "readRegistry(v0 stamp)");

    // The distinct TYPE is the criterion: an operator handling "another build
    // wrote this" programmatically must not have to grep a message for it.
    expect(err).toBeInstanceOf(RegistrySchemaError);
    expect(err).not.toBeInstanceOf(RegistryReadError);
    expect((err as RegistrySchemaError).found).toBe("pifleet.registry/v0");

    const msg = (err as Error).message;
    expect(msg).toContain("pifleet.registry/v0"); // what was found
    expect(msg).toContain(REGISTRY_SCHEMA); // what this build reads
    expect(msg).toContain("build that wrote it"); // hatch 1
    expect(msg).toContain("remove the run directory"); // hatch 2
  });

  test("truncated JSON is a DIFFERENT answer, and carries the bytes", async () => {
    await writeFile(run.registryJson, '{"schema":"pifleet.registry/v1","run_id":');
    const err = await refusalFrom(() => readRegistry(run));
    notBareLibraryError(err, "readRegistry(truncated)");

    expect(err).toBeInstanceOf(RegistryReadError);
    expect(err).not.toBeInstanceOf(RegistrySchemaError);
    // "written by another build" and "corrupt" send an operator to different
    // places, so the corrupt diagnosis must NOT name a build to go back to.
    expect((err as Error).message).not.toContain("build that wrote it");
    expect((err as Error).message).toContain("bytes on disk");
  });

  test("a correct stamp with a wrong shape is malformed, not a stamp problem", async () => {
    const doc = goodRegistry();
    doc["workers"] = { "w-1": { worker: "w-1", pid: "not-a-number" } };
    await writeFile(run.registryJson, JSON.stringify(doc));
    const err = await refusalFrom(() => readRegistry(run));
    notBareLibraryError(err, "readRegistry(valid stamp, bad shape)");

    expect(err).toBeInstanceOf(RegistryReadError);
    // The zod issue PATH is the diagnosis; a summary that lost it would leave
    // an operator with "invalid input" and a file to read by hand.
    expect((err as Error).message).toContain("workers.w-1.pid");
  });

  test("a registry with NO stamp is malformed — no build wrote it to go back to", async () => {
    const { schema: _dropped, ...stampless } = goodRegistry();
    await writeFile(run.registryJson, JSON.stringify(stampless));
    const err = await refusalFrom(() => readRegistry(run));
    notBareLibraryError(err, "readRegistry(no stamp)");
    expect(err).toBeInstanceOf(RegistryReadError);
    expect(err).not.toBeInstanceOf(RegistrySchemaError);
  });

  test("a non-object document is malformed rather than crashing the stamp probe", async () => {
    // `foreignStamp` reads `.schema` off a document the schema check just
    // rejected, so it meets whatever bytes were on disk — including a bare
    // scalar or `null`, on which a naive property read throws.
    for (const body of ["null", "42", '"pifleet.registry/v0"', "[]"]) {
      await writeFile(run.registryJson, body);
      const err = await refusalFrom(() => readRegistry(run));
      notBareLibraryError(err, `readRegistry(${body})`);
      expect(err).toBeInstanceOf(RegistryReadError);
    }
  });

  test("ABSENT is still null — the one answer that is not a refusal", async () => {
    // The asymmetry this reader's contract rests on. `startRegistryDaemon`
    // calls `readRegistry` before it has ever written the file, so `null` is
    // the answer on the first line of every run's life; widening it to cover
    // unreadable would make the daemon persist an empty registry over a file
    // naming live supervisors.
    const fresh = runPaths("r-never-written", tmp);
    await mkdir(fresh.root, { recursive: true });
    expect(await readRegistry(fresh)).toBeNull();
  });
});

describe("no durable reader leaks a bare library error", () => {
  /**
   * The suite-wide half. Each entry is a reader, a path it reads, and the two
   * ways a durable file goes wrong — a stamp this build does not read, and
   * bytes that are not JSON at all.
   *
   * `readFence` and `readTaskRecord` are included even though they were never
   * the defect: the point is that the NEXT reader to lose its wrapper is
   * caught, and there is no reason to believe it will be the one just fixed.
   */
  const readers: Array<{
    name: string;
    path: () => string;
    read: () => Promise<unknown>;
    /** A document of the right shape but stamped by a build we do not read. */
    foreign: () => string;
  }> = [
    {
      name: "readRegistry",
      path: () => run.registryJson,
      read: () => readRegistry(run),
      foreign: () => JSON.stringify({ ...goodRegistry(), schema: "pifleet.registry/v0" }),
    },
    {
      name: "readWorkerState",
      path: () => workerPaths(run, "w-1").stateJson,
      read: () => readWorkerState(workerPaths(run, "w-1")),
      foreign: () =>
        JSON.stringify({
          schema: "pifleet.state/v0",
          worker: "w-1",
          run_id: "r-durable",
          pid: 1,
          pgid: 1,
          started_at: new Date().toISOString(),
          proc_started: "",
          container: null,
          phase: "starting",
          epoch: 0,
        }),
    },
    {
      name: "readFence",
      path: () => workerPaths(run, "w-1").fenceJson,
      read: () => readFence(workerPaths(run, "w-1")),
      foreign: () =>
        JSON.stringify({
          schema: "pifleet.fence/v0",
          worker: "w-1",
          last_accepted_epoch: 0,
          ack_seq: null,
          last_seq: 0,
          live: null,
          completed: [],
          attempts: {},
        }),
    },
    {
      name: "readTaskRecord",
      path: () => join(workerPaths(run, "w-1").dir, "task-record.json"),
      read: () => readTaskRecord(join(workerPaths(run, "w-1").dir, "task-record.json")),
      foreign: () =>
        JSON.stringify({
          schema: "pifleet.taskrecord/v0",
          task_id: "t-1",
          attempt_id: "a-1",
          worker: "w-1",
          run_id: "r-durable",
          epoch: 0,
          verdict: "success",
          reason: "",
          settled_at: new Date().toISOString(),
        }),
    },
  ];

  for (const r of readers) {
    test(`${r.name}: an unrecognised stamp refuses without leaking ZodError`, async () => {
      await writeFile(r.path(), r.foreign());
      notBareLibraryError(await refusalFrom(r.read), `${r.name}(foreign stamp)`);
    });

    test(`${r.name}: corrupt bytes refuse without leaking SyntaxError`, async () => {
      await writeFile(r.path(), '{"schema": "pifleet.');
      notBareLibraryError(await refusalFrom(r.read), `${r.name}(truncated)`);
    });
  }
});
