#!/usr/bin/env bun
/**
 * A `localhost:8000` on a CI runner that behaves like the operator's oMLX.
 *
 * ## Why this exists
 *
 * Four live-inference probes in `test/integration/model-probe.test.ts` and the
 * relay's live probe in `test/integration/relay.test.ts` have never run in CI.
 * `ci.yml` said why, and said it correctly for as long as it was true: "they
 * need a real Apple-silicon inference server, which no GitHub-hosted runner has
 * and none ever will".
 *
 * The runner does not need to HAVE one. It needs to REACH one. A Cloudflare
 * tunnel now publishes the maintainer's oMLX at an HTTPS hostname, so the
 * missing piece is transport, not hardware.
 *
 * ## Why a proxy and not `socat`
 *
 * The obvious shim is a TLS-terminating TCP forwarder — `socat TCP-LISTEN:8000
 * ... OPENSSL:<host>:443`. It does not work here, and the reason is worth
 * writing down because it is invisible until it 404s.
 *
 * Cloudflare Tunnel routes to an origin by matching the request's **Host
 * header** against the `hostname:` rule in the tunnel's ingress. A TCP
 * forwarder copies bytes; it cannot rewrite HTTP. So a client dialling
 * `http://localhost:8000/v1/models` sends `Host: localhost:8000`, which matches
 * no ingress rule and falls through to the tunnel's `http_status:404`
 * catch-all. TLS would be terminated perfectly and the request would still fail
 * — with an error that looks like a broken server rather than a broken shim.
 *
 * An HTTP-level proxy rewrites Host as a side effect of re-issuing the request
 * against the upstream URL, which is what makes the ingress match.
 *
 * ## Why this shape, and not a change to the fleet
 *
 * Nothing in `src/` changes. The worker's `llm.base_url` stays
 * `http://host.docker.internal:8000/v1`; `relay_upstream` keeps its default of
 * `host.docker.internal:<port>`; the relay keeps emitting `--add-host
 * host.docker.internal:host-gateway` so it resolves the runner. Every hop
 * downstream of this process sees exactly what it sees on the maintainer's Mac,
 * because the thing that changed is what is listening on the host's port 8000
 * — not how the fleet talks to it.
 *
 * That property is the point. A CI path that differs from the operator's path
 * proves the CI path. This one keeps them identical, so what CI re-checks is
 * the thing that actually ships.
 *
 * ## What it deliberately does not do
 *
 * It does not inject a credential. The probes supply their own `Authorization`
 * and this process forwards it unread, so a missing key still produces the 401
 * the suites already know how to classify, rather than a silently-authenticated
 * request that hides a misconfigured secret.
 *
 * It does not follow redirects (`redirect: "manual"`). `model-probe.ts` went to
 * some trouble in ISC-291 to stop a redirect carrying the operator's model
 * credential to a host it did not choose; a proxy that quietly followed one
 * would put that hazard back underneath the probes that test for it.
 */

const HOST = process.env["OMLX_HOST"];
if (HOST === undefined || HOST === "") {
  console.error("omlx-shim: OMLX_HOST is not set — nothing to proxy to.");
  process.exit(2);
}

/**
 * A hostname, not a URL. Taking only the host keeps the secret's shape narrow:
 * there is no scheme for a caller to downgrade to `http:` and no path for one
 * to point somewhere else on the same origin.
 */
if (!/^[a-z0-9.-]+$/i.test(HOST)) {
  console.error(`omlx-shim: OMLX_HOST is not a bare hostname: ${JSON.stringify(HOST)}`);
  process.exit(2);
}

const PORT = Number(process.env["OMLX_SHIM_PORT"] ?? "8000");
const UPSTREAM = `https://${HOST}`;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Bun's ceiling. A cold model load on the far side measured 19.4s for a 4-bit
  // MoE and the allowlist includes an 8-bit 35B, so the generous end of this is
  // the load, not the tokens.
  idleTimeout: 255,
  async fetch(req: Request): Promise<Response> {
    const incoming = new URL(req.url);
    const target = new URL(incoming.pathname + incoming.search, UPSTREAM);

    const headers = new Headers(req.headers);
    // Let `fetch` derive Host from `target`. Copying the client's
    // `Host: localhost:8000` through is the exact failure this file exists to
    // avoid — see the header comment.
    headers.delete("host");
    // The upstream is fronted by Cloudflare, which runs bot heuristics the
    // operator's LAN oMLX does not. MEASURED, not guessed: with an otherwise
    // identical request, `User-Agent: Python-urllib/3.13` returns 403 and a
    // Cloudflare interstitial, while `Bun/1.3.12`, `node`, `undici`,
    // `openai-python/1.0`, `curl/8.7.1`, a bare token and no UA at all all
    // return 200. Bun is what the fleet dials with, so nothing in `src/` is
    // blocked today — but leaving the header client-controlled makes CI red
    // for a reason no one could find, on a rule change nobody here made.
    // Pinning it keeps the far side's heuristics out of the fleet's results.
    headers.set("user-agent", "pifleet-omlx-shim");
    // Ask the upstream not to compress. Paired with the response-side strip
    // below; see there for why the pair is load-bearing.
    headers.set("accept-encoding", "identity");

    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        // Streaming request bodies require the half-duplex opt-in.
        duplex: "half",
      } as RequestInit);
    } catch (e) {
      // Report as a gateway failure rather than letting the socket die: the
      // suites distinguish "oMLX unreachable" from "oMLX said no", and an
      // aborted connection reads as the former even when the far side is fine.
      const why = e instanceof Error ? e.message : String(e);
      console.error(`omlx-shim: upstream ${target.pathname} failed: ${why}`);
      return new Response(JSON.stringify({ error: { message: `omlx-shim upstream: ${why}` } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    // `fetch` DECODES the response body. Copying the upstream's
    // `content-encoding` through therefore labels already-decoded bytes as
    // still-encoded, and the client fails trying to decode them a second time.
    //
    // MEASURED, not theorised: with these two lines absent, Cloudflare answered
    // `content-encoding: zstd`, and all four live probes failed with
    // `ZstdDecompressionError fetching "http://localhost:8000/v1/models"` —
    // an error that names the shim's own address and looks for all the world
    // like a broken oMLX. `content-length` goes for the same reason: it counts
    // encoded bytes and no longer matches the body being sent.
    //
    // The request-side `accept-encoding: identity` above usually prevents the
    // situation arising at all. This strip is what makes correctness not depend
    // on the far side honouring that.
    const outHeaders = new Headers(res.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");

    // `res.body` is passed through unbuffered so SSE deltas arrive as deltas.
    // Buffering here would still pass the probes and would quietly make every
    // streaming assertion in the suite meaningless.
    return new Response(res.body, { status: res.status, headers: outHeaders });
  },
});

console.log(`omlx-shim: 127.0.0.1:${server.port} -> ${UPSTREAM}`);
