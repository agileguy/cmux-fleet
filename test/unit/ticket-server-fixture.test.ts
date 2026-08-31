/**
 * The fixture ticket server reproduces the four Rally behaviours it claims to.
 *
 * A fixture is a claim about a system nobody in CI can see. If it is kinder
 * than the real server — rejecting the bad parameter, erroring on the bad
 * query, paginating the way a reader would expect — then every probe built on
 * it passes while the same worker fails against Rally, and the fixture has
 * converted a real defect into a green build. So the fixture's own fidelity is
 * tested here, against numbers measured on `rally1.rallydev.com` on 2026-08-30.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { startTicketServer, type TicketServerHandle } from "../fixtures/ticket-server.ts";

const TOKEN = "fixture-token-8f2a";
const servers: TicketServerHandle[] = [];

async function server(): Promise<TicketServerHandle> {
  const s = await startTicketServer({ token: TOKEN, hostname: "127.0.0.1" });
  servers.push(s);
  return s;
}

afterAll(async () => {
  for (const s of servers) await s.close();
});

const get = async (s: TicketServerHandle, path: string, headers: Record<string, string> = {}) =>
  fetch(`${s.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5_000) });

interface QueryResult {
  TotalResultCount: number;
  StartIndex: number;
  Results: Array<{ FormattedID: string; State: string }>;
  Errors: string[];
}

const qr = async (r: Response): Promise<QueryResult> =>
  ((await r.json()) as { QueryResult: QueryResult }).QueryResult;

describe("authentication is ZSESSIONID, and the wrong scheme fails the way Rally fails", () => {
  test("no credential is a 401 carrying HTML, not JSON", async () => {
    const s = await server();
    const r = await get(s, "/defect");
    expect(r.status).toBe(401);
    // The body shape matters: a worker that parses this as a ticket gets
    // nonsense rather than an error, which is why the skill insists on
    // `--fail-with-body`.
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  test("Authorization: Token — the shape the skill shipped until 2026-08-30 — is refused", async () => {
    // This is what makes the corrected header load-bearing in CI. Revert
    // `skills/ticket-ops/SKILL.md` to `Authorization: Token` and the chain
    // probe built on this server goes red.
    const s = await server();
    const r = await get(s, "/defect", { Authorization: `Token ${TOKEN}` });
    expect(r.status).toBe(401);
    expect(s.requests.at(-1)!.wrongAuthScheme).toBe(true);
  });

  test("ZSESSIONID with the right value is accepted", async () => {
    const s = await server();
    expect((await get(s, "/defect", { ZSESSIONID: TOKEN })).status).toBe(200);
  });
});

describe("the page is smaller than the answer, which is the whole trap", () => {
  test("33 exist and 20 come back by default", async () => {
    const s = await server();
    const q = await qr(await get(s, "/defect", { ZSESSIONID: TOKEN }));
    expect(q.TotalResultCount).toBe(33);
    expect(q.Results.length).toBe(20);
  });

  test("the OPEN defects are past the first page, so filtering page one finds none", async () => {
    // The sharpest form of the trap: a worker that filters what it was handed
    // reports ZERO open defects, and zero reads as a clean answer rather than
    // as a truncation.
    const s = await server();
    const q = await qr(await get(s, "/defect", { ZSESSIONID: TOKEN }));
    expect(q.Results.filter((d) => d.State !== "Closed").length).toBe(0);
  });

  test("start is 1-based and returns the remainder", async () => {
    const s = await server();
    const q = await qr(await get(s, "/defect?start=21", { ZSESSIONID: TOKEN }));
    expect(q.StartIndex).toBe(21);
    expect(q.Results.length).toBe(13);
  });

  test("startIndex is IGNORED, not rejected — a wrong name yields page one forever", async () => {
    // Measured on Rally, and the reason a live run concluded "pagination is
    // broken". A fixture that 400'd here would be kinder than the real server
    // and would hide the bug.
    const s = await server();
    const q = await qr(await get(s, "/defect?startIndex=21", { ZSESSIONID: TOKEN }));
    expect(q.StartIndex).toBe(1);
    expect(q.Results[0]!.FormattedID).toBe("DE100000");
  });

  test("a big enough pagesize returns everything in one request", async () => {
    const s = await server();
    const q = await qr(await get(s, "/defect?pagesize=200", { ZSESSIONID: TOKEN }));
    expect(q.Results.length).toBe(33);
  });
});

describe("the query grammar is Rally's, parentheses and all", () => {
  test("a fully parenthesised compound query answers 8", async () => {
    const s = await server();
    const query = encodeURIComponent(
      '((Owner.UserName = "fixture.user@example.com") AND (State != "Closed"))',
    );
    const q = await qr(await get(s, `/defect?query=${query}&pagesize=200`, { ZSESSIONID: TOKEN }));
    expect(q.Errors).toEqual([]);
    expect(q.TotalResultCount).toBe(8);
    expect(q.Results.length).toBe(8);
  });

  test("a flat AND is a 200 with a non-empty Errors array, never a 4xx", async () => {
    // The one that turns a broken filter into an apparently empty result set.
    // Status alone cannot distinguish this from a real zero.
    const s = await server();
    const query = encodeURIComponent('(Owner.UserName = "x" AND State != "Closed")');
    const r = await get(s, `/defect?query=${query}`, { ZSESSIONID: TOKEN });
    expect(r.status).toBe(200);
    const q = await qr(r);
    expect(q.Errors.length).toBeGreaterThan(0);
    expect(q.Results.length).toBe(0);
  });

  test("an unknown field is an error rather than a silent no-match", async () => {
    const s = await server();
    const query = encodeURIComponent('(Nonesuch = "x")');
    const q = await qr(await get(s, `/defect?query=${query}`, { ZSESSIONID: TOKEN }));
    expect(q.Errors.length).toBeGreaterThan(0);
  });
});
