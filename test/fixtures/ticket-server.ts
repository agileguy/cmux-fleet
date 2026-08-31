/**
 * A Rally-shaped ticket server, for probes that need the vendor's BEHAVIOUR
 * without the vendor.
 *
 * ## Why a fixture and not the real thing
 *
 * CI holds no Rally credential and should not: a probe that needs a live
 * write-capable token for a system of record other people read is a probe that
 * cannot run on a fork, cannot run offline, and puts a real credential in a
 * runner. What the criteria this serves actually assert is the WORKER's
 * contract — that it binds the task id it was dispatched under, that it writes
 * both halves of the artifact pair, and that it reconciles a count instead of
 * trusting the page it was handed. None of those is a fact about Rally.
 *
 * ## The three behaviours it reproduces on purpose
 *
 * Every one of these was measured against `rally1.rallydev.com` on 2026-08-30,
 * and every one of them is a trap a real worker fell into on its first run:
 *
 * 1. **The default page is smaller than the answer.** 33 defects exist, the
 *    default `pagesize` is 20. A worker that counts `Results.length` gets a
 *    confidently wrong number, which is exactly what happened: it reported 5
 *    open defects where there are 8.
 * 2. **An unrecognised parameter is IGNORED, not rejected.** The run guessed
 *    `startIndex`, got page one back, and concluded from that that "pagination
 *    is broken". Rally ignores it silently; so does this. A fixture that
 *    errored on an unknown parameter would be KINDER than the real server and
 *    would let that bug through.
 * 3. **A malformed query is a `200` with a non-empty `Errors` array.** Not a
 *    4xx. So `--fail-with-body` does not catch it, and a worker that checks
 *    only the HTTP status reads a broken filter as an empty result set.
 *
 * ## And one it reproduces because a document was wrong about it
 *
 * Authentication is the `ZSESSIONID` header. `Authorization: Token` — the
 * shape `skills/ticket-ops/SKILL.md` shipped until 2026-08-30 — gets a 401
 * whose body is an HTML login page, exactly as Rally answers it. That makes
 * the corrected header load-bearing in CI rather than a claim in a diff.
 */

const OPEN = "Submitted";
const CLOSED = "Closed";

export interface TicketServerHandle {
  /** `http://<host>:<port>` — no trailing slash, no path. */
  readonly baseUrl: string;
  readonly port: number;
  /** Every request line the server saw, newest last. Read after the run. */
  readonly requests: readonly TicketRequest[];
  close(): Promise<void>;
}

export interface TicketRequest {
  readonly path: string;
  readonly query: string | null;
  readonly start: number | null;
  readonly pagesize: number | null;
  readonly authenticated: boolean;
  /** True when the request carried `Authorization:` and no `ZSESSIONID:`. */
  readonly wrongAuthScheme: boolean;
}

export interface TicketServerOptions {
  /** The value the `ZSESSIONID` header must carry. */
  readonly token: string;
  /** Total defects. 33 by default, of which 8 are open — the measured shape. */
  readonly total?: number;
  readonly open?: number;
  /** Rally's default page. Deliberately smaller than `total`. */
  readonly defaultPageSize?: number;
  /** Bind address; `0.0.0.0` so a container can reach it. */
  readonly hostname?: string;
}

interface Defect {
  FormattedID: string;
  Name: string;
  State: string;
  "Owner.UserName": string;
}

const OWNER = "fixture.user@example.com";

function corpus(total: number, open: number): Defect[] {
  const out: Defect[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push({
      FormattedID: `DE${100000 + i}`,
      Name: `fixture defect ${i}`,
      // The OPEN ones are placed at the END, past the first page. A worker that
      // filters page one finds none of them, which is the sharpest version of
      // the trap: a wrong answer of zero reads as a clean result.
      State: i >= total - open ? OPEN : CLOSED,
      "Owner.UserName": OWNER,
    });
  }
  return out;
}

/** The one query grammar this understands: `((A) AND (B))`, or a single `(A)`. */
function matches(d: Defect, query: string): { ok: boolean; error: string | null } {
  const terms = [...query.matchAll(/\(([A-Za-z.]+)\s*(=|!=)\s*"([^"]*)"\)/g)];
  if (terms.length === 0) {
    return { ok: false, error: `Could not parse: ${query}` };
  }
  // A flat `AND` between bare terms is what Rally rejects: every binary
  // operator must be parenthesised, the whole expression included. `(A AND B)`
  // has one outer paren and two unwrapped operands, so its inner terms do not
  // match the pattern above and it lands in the `error` branch — which is what
  // the real server does, and what convinced a worker that AND was unsupported.
  for (const [, field, op, value] of terms) {
    const actual = (d as unknown as Record<string, string>)[field!];
    if (actual === undefined) return { ok: false, error: `Unknown field: ${field}` };
    const hit = op === "=" ? actual === value : actual !== value;
    if (!hit) return { ok: false, error: null };
  }
  return { ok: true, error: null };
}

export async function startTicketServer(opts: TicketServerOptions): Promise<TicketServerHandle> {
  const total = opts.total ?? 33;
  const open = opts.open ?? 8;
  const defaultPageSize = opts.defaultPageSize ?? 20;
  const data = corpus(total, open);
  const requests: TicketRequest[] = [];

  const server = Bun.serve({
    hostname: opts.hostname ?? "0.0.0.0",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const zsession = req.headers.get("zsessionid");
      const authenticated = zsession === opts.token;
      const wrongAuthScheme = zsession === null && req.headers.get("authorization") !== null;
      const query = url.searchParams.get("query");
      const startRaw = url.searchParams.get("start");
      const pageRaw = url.searchParams.get("pagesize");

      requests.push({
        path: url.pathname,
        query,
        start: startRaw === null ? null : Number(startRaw),
        pagesize: pageRaw === null ? null : Number(pageRaw),
        authenticated,
        wrongAuthScheme,
      });

      if (!authenticated) {
        // Rally's shape: an HTML login page, not a JSON error. A worker that
        // parses this as a ticket gets nonsense, which is the point.
        return new Response("<html><head><title>Login</title></head><body>…</body></html>", {
          status: 401,
          headers: { "content-type": "text/html" },
        });
      }

      if (!url.pathname.endsWith("/defect")) {
        return Response.json({ OperationResult: { Errors: ["Unknown type"], Warnings: [] } }, { status: 404 });
      }

      const errors: string[] = [];
      let hits = data;
      if (query !== null) {
        const probe = matches(data[0]!, query);
        if (probe.error !== null) {
          // 200 WITH Errors — see the header. `--fail-with-body` does not fire.
          return Response.json({
            QueryResult: { Errors: [probe.error], Warnings: [], TotalResultCount: 0, StartIndex: 1, Results: [] },
          });
        }
        hits = data.filter((d) => matches(d, query).ok);
      }

      // `start` is 1-BASED. Anything else an operator might guess — `startIndex`,
      // `offset`, `page` — is simply not read, so a wrong name yields page one.
      const start = Number.isInteger(Number(startRaw)) && Number(startRaw) >= 1 ? Number(startRaw) : 1;
      const pagesize =
        Number.isInteger(Number(pageRaw)) && Number(pageRaw) >= 1 ? Number(pageRaw) : defaultPageSize;
      const page = hits.slice(start - 1, start - 1 + pagesize);

      return Response.json({
        QueryResult: {
          Errors: errors,
          Warnings: [],
          TotalResultCount: hits.length,
          StartIndex: start,
          PageSize: pagesize,
          Results: page,
        },
      });
    },
  });

  const port = server.port ?? 0;
  return {
    baseUrl: `http://${opts.hostname ?? "0.0.0.0"}:${port}`,
    port,
    requests,
    async close() {
      await server.stop(true);
    },
  };
}

export const FIXTURE_OWNER = OWNER;
export const FIXTURE_OPEN_STATE = OPEN;
export const FIXTURE_CLOSED_STATE = CLOSED;
