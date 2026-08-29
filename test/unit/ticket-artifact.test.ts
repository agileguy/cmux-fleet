/**
 * The ticket-ops artifact contract (ISC-322, ISC-323, ISC-324, ISC-325).
 *
 * WHAT THIS FILE IS DEFENDING. The artifact is the only durable account of what
 * a worker did to a system of record that other people read, and the
 * orchestrator cannot check it — it holds no credential for that API and has no
 * route to it. So the checks have to be structural, at parse time, against the
 * document itself. Three of them matter enough to be named:
 *
 *   1. `match` is re-derived from `sent` and `read_back` rather than believed.
 *   2. A verdict may be downgraded below its evidence, never upgraded above it.
 *   3. A credential cannot be in the document, in either of the two shapes a
 *      schema can see or as the literal secret value.
 *
 * Every test here is a MUTATION-PROVED test: each was confirmed to go red with
 * the corresponding refinement removed from `src/contracts.ts`. A schema test
 * that passes against a schema with the rule deleted is asserting the shape of
 * its own fixture, not the contract.
 */

import { describe, expect, test } from "bun:test";
import {
  TicketOpsArtifactSchema,
  findCredentialLeaks,
  parseTicketOpsArtifact,
  type TicketOpsArtifact,
} from "../../src/contracts.ts";

const BODY = "<p>Root cause: the probe targets 8080.</p>";

/** A minimal artifact that parses, so each test can perturb exactly one thing. */
function artifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "pifleet.ticket-ops/v1",
    task_id: "T-004",
    worker: "tick-1",
    epoch: 1,
    operation: "update",
    ticket_host: "tickets.example.test",
    generated_at: "2026-08-28T10:00:00.000Z",
    updates: [
      {
        ticket: "ISSUE-412",
        requested: "Replace the description with the root-cause writeup.",
        fields: [{ field: "description", mode: "replace", sent: BODY, read_back: BODY, match: "exact" }],
        verdict: "success",
      },
    ],
    verdict: "success",
    ...over,
  };
}

/** Replace the single field of the single update, keeping everything else valid. */
function withField(field: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return artifact({
    updates: [
      {
        ticket: "ISSUE-412",
        requested: "Replace the description.",
        fields: [field],
        verdict: "success",
        ...over,
      },
    ],
    ...(over["artifactVerdict"] ? { verdict: over["artifactVerdict"] } : {}),
  });
}

describe("ticket-ops artifact: the round trip is re-derived, not believed", () => {
  test("a clean update artifact parses", () => {
    const a: TicketOpsArtifact = TicketOpsArtifactSchema.parse(artifact());
    expect(a.updates[0]!.fields[0]!.match).toBe("exact");
    expect(a.no_change_needed).toBe(false);
  });

  test('match "exact" is refused when read_back differs from sent', () => {
    // The core claim-vs-measurement check. Without it a worker records
    // `exact` beside two values that disagree and the artifact reads as a
    // verified write.
    const r = TicketOpsArtifactSchema.safeParse(
      withField({ field: "description", mode: "replace", sent: BODY, read_back: BODY + "old", match: "exact" }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("read_back differs from sent");
  });

  test('match "sanitized" or "mismatch" is refused when read_back EQUALS sent', () => {
    for (const m of ["sanitized", "mismatch"]) {
      const r = TicketOpsArtifactSchema.safeParse(
        withField(
          { field: "description", mode: "replace", sent: BODY, read_back: BODY, match: m, detail: "d" },
          { verdict: "partial", artifactVerdict: "partial" },
        ),
      );
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("read_back equals sent");
    }
  });

  test("a null read_back and a match other than unverified cannot coexist", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      withField({ field: "description", mode: "replace", sent: BODY, read_back: null, match: "mismatch", detail: "d" }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("disagree");
  });

  test('"unverified" with a non-null read_back is equally refused — the rule runs both ways', () => {
    const r = TicketOpsArtifactSchema.safeParse(
      withField({ field: "description", mode: "replace", sent: BODY, read_back: BODY, match: "unverified", detail: "d" }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("disagree");
  });

  test("a non-exact match must say what differed", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      withField(
        { field: "description", mode: "replace", sent: BODY, read_back: "<p>x</p>", match: "sanitized", detail: "   " },
        { verdict: "partial", artifactVerdict: "partial" },
      ),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("needs a detail");
  });
});

describe("ticket-ops artifact: a verdict may be downgraded, never upgraded", () => {
  test("an unverified read-back forces the ticket verdict to failed", () => {
    const bad = TicketOpsArtifactSchema.safeParse(
      withField(
        { field: "description", mode: "replace", sent: BODY, read_back: null, match: "unverified", detail: "GET timed out" },
        { verdict: "partial", artifactVerdict: "partial" },
      ),
    );
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("outranks its own read-backs");

    const good = TicketOpsArtifactSchema.safeParse(
      withField(
        { field: "description", mode: "replace", sent: BODY, read_back: null, match: "unverified", detail: "GET timed out" },
        { verdict: "failed", artifactVerdict: "failed" },
      ),
    );
    expect(good.success).toBe(true);
  });

  test("a sanitized field caps the ticket verdict at partial", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      withField({
        field: "description",
        mode: "replace",
        sent: BODY,
        read_back: "<p>Root cause: the probe targets 8080.</p>x",
        match: "sanitized",
        detail: "server dropped <code>",
      }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("outranks its own read-backs");
  });

  test("downgrading BELOW the evidence is allowed — the rule is one-directional", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      artifact({
        updates: [
          {
            ticket: "ISSUE-412",
            requested: "Replace the description.",
            fields: [{ field: "description", mode: "replace", sent: BODY, read_back: BODY, match: "exact" }],
            verdict: "failed",
          },
        ],
        verdict: "failed",
      }),
    );
    expect(r.success).toBe(true);
  });

  test("the artifact verdict cannot outrank its worst ticket verdict", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      artifact({
        updates: [
          {
            ticket: "ISSUE-412",
            requested: "Replace the description.",
            fields: [{ field: "description", mode: "replace", sent: BODY, read_back: BODY, match: "exact" }],
            verdict: "failed",
          },
        ],
        verdict: "success",
      }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("outranks its worst ticket verdict");
  });
});

describe("ticket-ops artifact: query, update, and doing nothing on purpose", () => {
  test("a query artifact carries ticket details and no updates", () => {
    const a = TicketOpsArtifactSchema.parse(
      artifact({
        operation: "query",
        updates: [],
        queried: [
          { ticket: "ISSUE-412", fields: [{ field: "state", value: "Open" }, { field: "owner", value: null }] },
        ],
      }),
    );
    expect(a.queried[0]!.fields).toHaveLength(2);
  });

  test("a query artifact that records an update is refused", () => {
    const r = TicketOpsArtifactSchema.safeParse(artifact({ operation: "query" }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("a query artifact records no updates");
  });

  test('"no change was needed" is a first-class success, not an empty failure', () => {
    // The criterion this defends: a role rewarded for producing changes will
    // produce changes. `no_change_needed` gives the honest outcome a place to
    // be recorded that is not indistinguishable from having done nothing.
    const a = TicketOpsArtifactSchema.parse(
      artifact({ updates: [], no_change_needed: true, verdict: "success" }),
    );
    expect(a.no_change_needed).toBe(true);
    expect(a.verdict).toBe("success");
  });

  test("an update artifact with no updates and no flag is refused", () => {
    const r = TicketOpsArtifactSchema.safeParse(artifact({ updates: [] }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("must set no_change_needed");
  });

  test("no_change_needed alongside recorded updates is refused", () => {
    const r = TicketOpsArtifactSchema.safeParse(artifact({ no_change_needed: true }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("no_change_needed is set but updates were recorded");
  });
});

describe("ticket-ops artifact: the credential is never in it", () => {
  const SECRET = "tkn_live_9f2b7c41aa8e4d6f";

  test("a populated Authorization header anywhere in the document is refused", () => {
    const r = TicketOpsArtifactSchema.safeParse(
      artifact({ commands: [`curl -H "Authorization: Token ${SECRET}" https://tickets.example.test/i/1`] }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("must be elided as <redacted>");
  });

  test("the same command with the value elided is accepted", () => {
    const a = TicketOpsArtifactSchema.parse(
      artifact({ commands: ['curl -H "Authorization: Token <redacted>" https://tickets.example.test/i/1'] }),
    );
    expect(a.commands[0]).toContain("<redacted>");
  });

  test("a credential-bearing query parameter is refused", () => {
    for (const q of ["?token=abc", "&api_key=abc", "?access_token=abc", "&password=abc"]) {
      const r = TicketOpsArtifactSchema.safeParse(
        artifact({ commands: [`curl https://tickets.example.test/i/1${q}`] }),
      );
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("credential-bearing query parameter");
    }
  });

  test("the secret VALUE is found wherever it is hidden, and its path is named", () => {
    // The half a schema cannot do: the token pasted into a free-text field,
    // in no recognisable shape at all.
    const leaked = artifact({ notes: `retried with ${SECRET} and it worked` });
    expect(findCredentialLeaks(leaked, [SECRET])).toEqual(["notes"]);

    const deep = artifact({
      updates: [
        {
          ticket: "ISSUE-412",
          requested: "Replace the description.",
          fields: [{ field: "description", mode: "replace", sent: `<p>${SECRET}</p>`, read_back: `<p>${SECRET}</p>`, match: "exact" }],
          verdict: "success",
        },
      ],
    });
    expect(findCredentialLeaks(deep, [SECRET])).toEqual([
      "updates[0].fields[0].sent",
      "updates[0].fields[0].read_back",
    ]);
  });

  test("parseTicketOpsArtifact refuses a document holding a known secret", () => {
    expect(() => parseTicketOpsArtifact(artifact({ notes: SECRET }), [SECRET])).toThrow(
      /contains a credential at: notes/,
    );
    // …and returns the parsed value when it does not.
    expect(parseTicketOpsArtifact(artifact(), [SECRET]).verdict).toBe("success");
  });

  test("an empty or blank secret is not treated as a needle that matches everywhere", () => {
    // An empty needle is `includes("")` — true for every string — so a naive
    // scan would report the whole document as a leak and be switched off.
    expect(findCredentialLeaks(artifact(), ["", "   "])).toEqual([]);
    expect(findCredentialLeaks(artifact(), [])).toEqual([]);
  });
});
