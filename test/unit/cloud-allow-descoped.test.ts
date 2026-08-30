/**
 * ISC-366 — task-scoped cloud authorization is descoped, and refused rather
 * than ignored.
 *
 * ## The property, and why refusing is the whole of it
 *
 * `cloud_allow[]` was designed (SRD §5.10) and never built: `materialize.ts`
 * writes the mounted policy EMPTY at `up` and nothing rewrites it, so a value
 * an operator sets reaches the worker's PROMPT and never the verbgate. The
 * owner descoped the rewriter on 2026-08-30 rather than build it.
 *
 * A descope that leaves the field accepted-and-ignored is not a descope. The
 * operator writes `cloud_allow: ["kubectl scale"]`, the brief tells the worker
 * it may scale, the worker tries, and the gate refuses with exit 77 — an epoch
 * spent discovering that a grant the document offered does not exist. The
 * field must therefore FAIL, loudly, at the moment it is set.
 *
 * ## Both schemas, because they are two doors to the same room
 *
 * `TaskSpecSchema` is what an operator writes in a plan file. `TaskEnvelopeSchema`
 * is the wire format the supervisor parses over the control socket. Guarding
 * only the spec leaves the socket accepting a grant it cannot honour, and the
 * socket is the one an out-of-band caller reaches.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { TaskEnvelopeSchema, TaskSpecSchema } from "../../src/contracts.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

const SPEC = { id: "t-1", title: "t", brief: "b" };
const ENVELOPE = {
  schema: "pifleet.task/v1",
  task_id: "t-1",
  run_id: "r-1",
  epoch: 1,
  attempt: 1,
  worker: "eng-1",
  dispatched_at: "2026-08-30T00:00:00.000Z",
  title: "t",
  brief: "b",
  repo: "/repo",
  host_workdir: "/host/wt",
  container_workdir: "/workspace",
  branch: "b",
  base_ref: "0".repeat(40),
  outbox: "/outbox/t-1",
  deadline_s: 60,
};

describe("a non-empty cloud_allow is refused, not silently ignored", () => {
  test("the task spec refuses it, and the message says why rather than 'invalid'", () => {
    const r = TaskSpecSchema.safeParse({ ...SPEC, cloud_allow: ["kubectl scale"] });
    expect(r.success).toBe(false);
    const message = r.success ? "" : r.error.issues.map((i) => i.message).join(" ");
    // The message is the deliverable here: a bare "invalid input" would send
    // the operator looking for a typo in a field that is working as intended.
    expect(message).toContain("descoped");
    expect(message).toContain("impersonate_service_account");
  });

  test("the task ENVELOPE refuses it too — the control socket is the other door", () => {
    const r = TaskEnvelopeSchema.safeParse({ ...ENVELOPE, cloud_allow: ["kubectl delete"] });
    expect(r.success).toBe(false);
  });

  test("an absent or empty cloud_allow still parses, on both schemas", () => {
    expect(TaskSpecSchema.safeParse(SPEC).success).toBe(true);
    expect(TaskSpecSchema.safeParse({ ...SPEC, cloud_allow: [] }).success).toBe(true);
    expect(TaskEnvelopeSchema.safeParse(ENVELOPE).success).toBe(true);
    expect(TaskEnvelopeSchema.safeParse({ ...ENVELOPE, cloud_allow: [] }).success).toBe(true);
  });

  test("the default is still the empty array, so nothing downstream sees undefined", () => {
    const spec = TaskSpecSchema.parse(SPEC);
    expect(spec.cloud_allow).toEqual([]);
    const env = TaskEnvelopeSchema.parse(ENVELOPE);
    expect(env.cloud_allow).toEqual([]);
  });
});

describe("the policy file has exactly one writer, and it writes empty", () => {
  /**
   * The TRIPWIRE half. A descope is a decision, not a state, and the thing that
   * would quietly undo it is a second writer appearing — at which point the
   * SRD's "refuses EVERY mutating verb, for every worker, for the life of every
   * run" becomes false with no document changing.
   *
   * Pinned to the write CALL rather than to any mention of `cloudAllow`: the
   * path definition, the mount and the launch record all name it legitimately,
   * and a claim that counted those would be noise that nobody could act on.
   */
  test("materialize writes the policy empty and nothing else writes it", () => {
    const src = readFileSync(`${ROOT}src/run/materialize.ts`, "utf8");
    const writes = [...src.matchAll(/writeFile\(paths\.cloudAllow[^)]*\)/g)].map((m) => m[0]);
    expect(writes).toEqual(['writeFile(paths.cloudAllow, "")']);

    // And no OTHER module writes it at all.
    for (const rel of ["src/cli/commands/dispatch.ts", "src/supervisor/index.ts", "src/config/render.ts"]) {
      const text = readFileSync(`${ROOT}${rel}`, "utf8");
      expect(text, `${rel} must not write the cloud policy`).not.toMatch(/writeFile\([^)]*cloudAllow/);
    }
  });
});
