/**
 * The egress relay, against a real daemon (SRD §5.6, §5.9, §12.4;
 * ISC-50, ISC-51, ISC-57).
 *
 * `test/integration/egress.test.ts` proves the bridge DENIES; the unit suite
 * proves the argv and the matcher. Only this file proves the thing the two
 * halves exist for: that a container with NO special flags, attached to
 * nothing but the deny-all internal network, completes a real model-shaped
 * call to `host.docker.internal` — and still cannot reach the internet.
 *
 * That combination is the whole point, so both halves are asserted in ONE
 * test against ONE container. Splitting them would let a future change open
 * the internet in the same edit that fixes the relay and leave the suite
 * green.
 *
 * Each test also asserts the destination is unreachable BEFORE the relay
 * exists, from the same network and the same image. Without that, "the call
 * succeeded" proves only that curl works: an internal network that had never
 * actually been internal would pass every remaining assertion here.
 *
 * The primary test uses a STUB upstream in this process on an ephemeral port,
 * not the real oMLX server, so it runs anywhere Docker does. The real oMLX
 * server exists only on the maintainer's machine; the second test uses it
 * when it is there and skips cleanly when it is not.
 *
 * Gated exactly like the egress and verbgate suites: `PIFLEET_DOCKER=1`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { ensureEgressNetwork, ensureUplinkNetwork } from "../../src/security/network.ts";
import {
  ensureEgressRelay,
  inspectRelayContainer,
  relayContainerName,
  uplinkNetworkName,
  RELAY_IMAGE,
  type RelayTarget,
} from "../../src/security/relay.ts";

/** Client container image: needs bash + curl, same as the egress suite. */
const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] relay integration tests need a Docker daemon, ${IMAGE}, and node:24-bookworm-slim. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

/**
 * Is the maintainer's real oMLX server up? `401` counts — it means the TCP
 * path and the HTTP server are both there and only the key is missing, which
 * is exactly what a reachable oMLX looks like without credentials.
 */
async function omlxReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:8000/v1/models", {
      signal: AbortSignal.timeout(3_000),
    });
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

const OMLX_KEY = process.env.OMLX_API_KEY ?? "";
const OMLX_LIVE = DOCKER && OMLX_KEY !== "" && (await omlxReachable());
if (DOCKER && !OMLX_LIVE) {
  console.warn(
    "[skip] live oMLX relay test: needs a reachable http://localhost:8000 and OMLX_API_KEY.",
  );
}

/**
 * The ONLY models the live inference probe may send a completion to.
 *
 * An allowlist, not a filter, and the distinction is the whole point: every
 * rule of the form "pick the first id that is not X" has to be evaluated
 * against models nobody has run, and one of the models on the maintainer's
 * machine takes the entire inference server down when generation starts.
 * There is no ordering that is safe to guess. A name gets added here only
 * after someone has run a completion against it by hand.
 *
 * Measured 2026-08-19, both servers, `What is 2+2?` at `max_tokens: 8`:
 *
 *   local (localhost:8000) : HTTP 200, "4", 75.4s cold / 0.76s warm
 *   LAN   (192.168.86.49)  : HTTP 200, "4", 4.8s including a 4.2s load
 *
 * Being served by BOTH is why this entry in particular is here: it keeps the
 * probe working whichever upstream the relay ends up dialing (ISC-259).
 */
const SAFE_CHAT_MODELS = ["gemma-4-26b-a4b-it-4bit"] as const;

/**
 * Models this probe must NEVER send a completion to. Read before editing.
 *
 * `Qwen3.5-35B-A3B-4bit` needs 24.93GB against `com.pai.omlx`'s
 * `--max-model-memory 24GB`. It logs "Loading … without KV headroom" and then
 * SIGABRTs inside MLX's Metal completion handler DURING GENERATION, taking the
 * whole server down with it — it does not fail the request, it kills the
 * process. The cap is an owner decision and is not changing, so this will not
 * be fixed underneath this test.
 *
 * `SAFE_CHAT_MODELS` already excludes it by construction. This list exists so
 * that widening the allowlist means deleting a line that says, in words, that
 * this model crashes the server.
 */
const FORBIDDEN_CHAT_MODELS = ["Qwen3.5-35B-A3B-4bit"] as const;

let seq = 0;
function testNetName(): string {
  seq += 1;
  return `pifleet-relay-it-${process.pid}-${seq}`;
}

async function docker(
  args: string[],
  env?: Readonly<Record<string, string>>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  return { code, stdout, stderr };
}

/**
 * Containers come down before networks: Docker refuses to remove a network
 * that still has an endpoint attached, and the relay is attached to two.
 */
const cleanupContainers: string[] = [];
const cleanupNetworks: string[] = [];
afterEach(async () => {
  for (const c of cleanupContainers.splice(0)) await docker(["rm", "-f", c]);
  for (const n of cleanupNetworks.splice(0)) await docker(["network", "rm", n]);
});

/**
 * Register every artifact `ensureEgressRelay` will create BEFORE creating it,
 * so a test that fails halfway still cleans up after itself.
 */
function registerRelayArtifacts(net: string): void {
  cleanupNetworks.push(net);
  cleanupContainers.push(relayContainerName(net));
  cleanupNetworks.push(uplinkNetworkName(net));
}

/**
 * Run a script in the worker image attached to ONLY the internal network —
 * no `--add-host`, no extra networks, no capabilities. This is deliberately
 * the least-privileged container this project can produce, because the claim
 * under test is that an ordinary worker needs nothing special.
 */
async function onNetwork(
  net: string,
  script: string,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  // `-e NAME` with NO `=value` tells docker to copy the variable out of its own
  // environment. The value never appears in argv, so it is not in `ps`, not in
  // the ephemeral container's `docker inspect`, and not in a CI log that echoes
  // the command — which is what `-H "Authorization: Bearer <key>"` interpolated
  // into a shell string used to do with the real oMLX key.
  const envArgs: string[] = [];
  for (const name of Object.keys(env)) envArgs.push("-e", name);
  const r = await docker(
    ["run", "--rm", ...envArgs, "--network", net, "--entrypoint", "bash", IMAGE, "-c", script],
    env,
  );
  /**
   * A non-zero `docker run` is a BROKEN PROBE, not a measurement.
   *
   * This helper used to return `stdout + stderr` and never look at `r.code`,
   * which made every `not.toContain(...)` assertion built on it a vacuous
   * pass: if `docker run` failed outright — image missing, daemon hiccup,
   * network already gone — the returned string was an error message, and "this
   * error message does not contain `ip=0`" is true of every error message ever
   * written. The DENY half of ISC-51/57 rested entirely on assertions of that
   * shape, with nothing playing the role `toContain(nonce)` plays for the
   * reach half.
   *
   * The probe scripts all end in `echo`, so the container exits 0 even when the
   * curl inside it fails. A non-zero code here therefore always means the
   * container did not run — never that the probe observed a denial.
   */
  if (r.code !== 0) {
    throw new Error(
      `relay test: probe container exited ${r.code} — the probe did not run, so nothing was ` +
        `measured. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    );
  }
  return r.stdout + r.stderr;
}

/**
 * The least-privileged container this project can produce, on the INTERNAL
 * bridge specifically — no `--add-host`, no extra networks, no capabilities.
 * Most claims here are about what an ordinary worker can do, and an ordinary
 * worker gets exactly this.
 */
const onInternalNetwork = onNetwork;

/**
 * Bash that derives THIS container's gateway into `$GW` and prints it.
 *
 * No `ip` in the worker image (measured — see `PORT_SCAN` below for the full
 * tool inventory), so this comes from the one thing that is always there:
 * `/proc/net/route`.
 *
 * The gateway is the default route's gateway when there is one. On an
 * `--internal` bridge there is NO default route, so it is derived from the
 * single on-link route the way Docker assigns it — network address + 1.
 * `/proc/net/route` is little-endian hex, hence the byte reversal.
 */
// Deliberately written with no `${...}` bash parameter expansions: this is a
// JS template literal, and `${` would be interpolated by JavaScript before
// bash ever sees it. Only `$VAR` and `$(...)` forms appear below.
const GATEWAY_DERIVE = `
  hex2ip() {
    h=$1
    printf "%d.%d.%d.%d\\n" \\
      0x$(echo "$h" | cut -c7-8) 0x$(echo "$h" | cut -c5-6) \\
      0x$(echo "$h" | cut -c3-4) 0x$(echo "$h" | cut -c1-2)
  }
  GWHEX=$(awk '$2=="00000000" {print $3; exit}' /proc/net/route)
  if [ -n "$GWHEX" ] && [ "$GWHEX" != "00000000" ]; then
    GW=$(hex2ip "$GWHEX")
  else
    DEST=$(awk 'NR==2 {print $2; exit}' /proc/net/route)
    NET=$(hex2ip "$DEST")
    GW="$(echo "$NET" | cut -d. -f1-3).1"
  fi
  echo "gateway=$GW"
`;

/**
 * A COMPLETE TCP enumeration of one address: all 65535 ports, nothing sampled.
 *
 * This is the machinery ISC-261 asks for, and the reason it can exist at all
 * is a measured property of the worker image rather than an assumption. What
 * the image actually has, measured 2026-08-19 by running the image:
 *
 *     bash 5.2.15  timeout  xargs  awk        <- present
 *     nmap  nc  ncat  socat  ss  netstat  ip  <- ALL ABSENT
 *
 * So there is no scanner to install and no `ip` to parse. What there IS, and
 * what nothing in this repo had used before, is bash's `/dev/tcp` — compiled
 * in on this image (verified: a connect to a closed local port takes the
 * "connection refused" path rather than reporting "not supported"). One
 * `timeout 1 bash -c 'exec 3<>/dev/tcp/HOST/PORT'` per port, fanned out
 * through `xargs -P`, is a complete port scanner built from what is already
 * in the image, with nothing installed and no network access to install it.
 *
 * ## Why the constants are what they are — all measured, none guessed
 *
 *  - `-P 512`: the whole range in ~32 s against a bridge gateway. Accuracy at
 *    that fan-out is not assumed: the same scan re-run at `-P 128` returned
 *    the IDENTICAL set (one planted listener found, nothing else), so the
 *    parallelism is not buying speed at the cost of correctness.
 *  - `timeout 1`: a bridge gateway and a sibling container are both sub-
 *    millisecond away, so one second is about three orders of magnitude of
 *    headroom. It only binds on ports that DROP rather than RST; the worst
 *    case, if every port dropped, is 65535/512 x 1 s ~ 128 s, which is what
 *    the generous per-test timeouts below are sized for.
 *
 * A timeout counts as NOT open, which is the conservative direction for a deny
 * assertion — it can only ever understate the reachable set, never invent
 * reachability that is not there.
 */
const PORT_SCAN = `
  scan_all() {
    SCAN_TARGET=$1
    export SCAN_TARGET
    probe_one() {
      if timeout 1 bash -c "exec 3<>/dev/tcp/$SCAN_TARGET/$1" 2>/dev/null; then echo "$1"; fi
    }
    export -f probe_one
    echo "scanned=$SCAN_TARGET"
    echo "open=$(seq 1 65535 | xargs -P 512 -I{} bash -c "probe_one {}" | sort -n | tr "\\n" ",")"
  }
`;

function parseKv(out: string, key: string): string | null {
  const line = out.split("\n").find((l) => l.trim().startsWith(`${key}=`));
  return line === undefined ? null : line.trim().slice(key.length + 1);
}

/**
 * A `key=<comma-separated ports>` line, as a sorted numeric set.
 *
 * THROWS when the line is missing, rather than returning `[]`. An empty set is
 * a MEANINGFUL result here — "this address serves nothing" — and every
 * assertion below is a statement about set membership, so silently conflating
 * "the probe found nothing" with "the probe did not run" would turn each
 * subset assertion into a vacuous truth. That is precisely the failure mode
 * `onNetwork`'s exit-code check exists to prevent one level up, and it has to
 * be prevented again here because these probes can legitimately produce a
 * zero-length value.
 */
function parsePortList(out: string, key: string): number[] {
  const line = parseKv(out, key);
  if (line === null) {
    throw new Error(
      `relay test: the probe produced no '${key}=' line, so no port set was measured — this is ` +
        `a broken probe, not an empty result. Raw output: ${JSON.stringify(out)}`,
    );
  }
  return line
    .split(",")
    .filter((s) => s.trim() !== "")
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The Docker host's LISTENING SOCKETS, read from the kernel — never probed.
 *
 * This is the "independently known to serve" half of ISC-261, and it exists
 * because deriving the expected set from a probe of the same shape as the one
 * under test is circular in exactly the way ISC-253's `decide()` gate was:
 * `policyFromConfig` derived its rule from the same field the target came
 * from, so the two agreed BY CONSTRUCTION and the gate could not refuse
 * anything. A gateway test whose ground truth is "whatever a second scan
 * found" has the same defect — two probes that share a bug agree with each
 * other perfectly.
 *
 * So the ground truth here is not a probe at all. `/proc/net/tcp` and
 * `/proc/net/tcp6` ARE the kernel's socket table; state `0A` is `TCP_LISTEN`.
 * Read from a `--network host` container, that is the Docker host's own
 * account of what it is listening on, obtained without sending a single
 * packet. Nothing about the bridge, the isolation rules, or `/dev/tcp` can
 * influence the answer.
 *
 * The relation to the scanned sets is a STRICT subset, and measurably so
 * rather than in principle. Measured 2026-08-19 on this workstation:
 *
 *     listening (kernel socket table)  : 22, 53
 *     reachable (deny-all bridge scan) : 22
 *
 * Port 53 is a real listening socket that is NOT reachable from the bridge,
 * because the resolver binds a loopback address. If `reachable ⊆ listening`
 * were a tautology that gap could not exist, and the assertion would be
 * worthless. It exists, so the assertion has content.
 *
 * The ports are little-endian hex in the second field. `mawk` — which is what
 * this image ships, not `gawk` — has no `strtonum`, so the conversion is done
 * by bash `printf` rather than in awk. Measured: `strtonum` errors out here.
 */
const HOST_LISTEN_SOCKETS = `
  echo "listening=$(awk 'NR>1 && $4=="0A" {split($2,a,":"); print a[2]}' /proc/net/tcp /proc/net/tcp6 \\
    | sort -u \\
    | while read -r h; do printf "%d\\n" "0x$h"; done \\
    | sort -n | uniq | tr "\\n" ",")"
`;

/**
 * Bridge members that are NOT accounted for by the fleet.
 *
 * A pure function, so the RULE is inspectable rather than buried in an
 * `expect` that only ever sees the one arrangement a test happened to build.
 * Expected members are passed in explicitly: this project names workers
 * `pifleet-<runId>-<workerId>` (`src/config/render.ts`) and the relay
 * `pifleet-egress-relay-<network>` (`src/security/relay.ts`), but matching on
 * a `pifleet-` PREFIX would accept exactly the thing this is meant to catch —
 * a leftover from a crashed run wears a `pifleet-` name too.
 */
function unexpectedMembers(
  members: ReadonlyArray<{ name: string }>,
  expected: readonly string[],
): string[] {
  return members.map((m) => m.name).filter((n) => !expected.includes(n));
}

/**
 * A full `RelayConfigView` (= `EgressConfigView`).
 *
 * `ensureEgressRelay` now runs each target through `decide()` before it builds
 * argv (ISC-253), so it needs the `egress` half of the config as well as
 * `llm`. See `test/unit/relay.test.ts` for exactly how much that gate proves
 * today — including the documented case it does NOT catch.
 */
function cfg(base_url: string) {
  return {
    llm: { base_url },
    egress: { google_hosts: ["oauth2.googleapis.com"], allow: [] as Array<never> },
  };
}

/**
 * Poll a TCP port from THIS process until something accepts, or give up loudly.
 *
 * Used to confirm a beacon is actually listening before anything is enumerated
 * against it. Sleeping a guessed interval instead would make a slow start
 * indistinguishable from a beacon that never came up — and the assertions that
 * follow read an absent beacon as a containment RESULT, which is the one
 * misreading that must not be possible here.
 */
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = connect({ host, port });
        const done = (err?: Error) => {
          s.destroy();
          err === undefined ? resolve() : reject(err);
        };
        s.setTimeout(1_000);
        s.once("connect", () => done());
        s.once("timeout", () => done(new Error("connect timed out")));
        s.once("error", (e: Error) => done(e));
      });
      return;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(250);
    }
  }
  throw new Error(
    `relay test: nothing accepted a TCP connection on ${host}:${port} within ${timeoutMs}ms, so ` +
      `the beacon never came up and the enumeration that follows would measure nothing. ` +
      `Last error: ${String(lastErr)}`,
  );
}

/**
 * Every container attached to a Docker network, from the daemon itself.
 *
 * `docker network inspect` is AUTHORITATIVE for bridge membership rather than
 * a sample of it — a container is on the bridge if and only if it appears
 * here — which is what makes the sibling half of ISC-261 a complete
 * enumeration rather than a scan that could miss a quiet neighbour.
 */
async function networkMembers(net: string): Promise<Array<{ name: string; ip: string }>> {
  const r = await docker(["network", "inspect", net, "--format", "{{json .Containers}}"]);
  if (r.code !== 0) {
    throw new Error(`relay test: docker network inspect ${net} exited ${r.code}: ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout.trim() || "null") as Record<
    string,
    { Name?: string; IPv4Address?: string }
  > | null;
  return Object.values(parsed ?? {})
    .map((c) => ({ name: c.Name ?? "", ip: (c.IPv4Address ?? "").split("/")[0] ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One curl with a retry loop, printing a parseable `key=...` line. */
function curlProbe(key: string, url: string, header = ""): string {
  const h = header === "" ? "" : `-H ${JSON.stringify(header)}`;
  return `body=""
     for i in $(seq 1 30); do
       body=$(curl -sS -m 5 ${h} ${JSON.stringify(url)} 2>/dev/null) && break
       sleep 0.5
     done
     echo "${key}=$body"`;
}

/**
 * What the deny-all bridge ACTUALLY denies (M1; SRD §12.8; ISC-51, ISC-57).
 *
 * These replace sampling with enumeration, and they exist because the sampled
 * version did not catch the thing that was actually open. The old evidence
 * probed two destinations — `1.1.1.1` and `example.com` — concluded "no route
 * to the public internet", and never measured the bridge GATEWAY, which was
 * serving sshd the entire time.
 */
describe.skipIf(!DOCKER)("what the internal bridge denies — enumerated, not sampled", () => {
  test(
    "exactly one on-link route, no default route, and nothing off-subnet is reachable",
    async () => {
      const net = testNetName();
      cleanupNetworks.push(net);
      await ensureEgressNetwork(net);

      const out = await onInternalNetwork(
        net,
        `${GATEWAY_DERIVE}
         echo "routecount=$(($(wc -l < /proc/net/route) - 1))"
         echo "defaultroutes=$(awk '$2=="00000000"' /proc/net/route | wc -l)"
         echo "onlink=$(awk 'NR>1 && $3=="00000000"' /proc/net/route | wc -l)"
         curl -sS -m 4 https://1.1.1.1/          >/dev/null 2>&1; echo "pubip=$?"
         curl -sS -m 4 https://example.com/      >/dev/null 2>&1; echo "pubname=$?"
         curl -sS -m 4 http://192.168.86.49:8000/ >/dev/null 2>&1; echo "lan=$?"
         curl -sS -m 4 http://169.254.169.254/   >/dev/null 2>&1; echo "metadata=$?"
         curl -sS -m 4 http://192.168.5.2:22/    >/dev/null 2>&1; echo "limahost=$?"`,
      );

      // ENUMERATION, not sampling. One route, on-link, no default. This is the
      // structural claim — "nothing off the bridge subnet is routable" — and it
      // is strictly stronger than probing a handful of addresses, because it
      // bounds the whole address space rather than five points in it.
      expect(parseKv(out, "routecount")).toBe("1");
      expect(parseKv(out, "defaultroutes")).toBe("0");
      expect(parseKv(out, "onlink")).toBe("1");

      // The sampled probes are kept as corroboration, now as POSITIVE
      // assertions of a non-zero curl exit rather than `not.toContain("=0")`.
      // Note what each one actually proves: an IP literal proves the ROUTE is
      // absent; a NAME proves the resolver is too. The LAN address matters
      // because it is where oMLX is proposed to move (ISC-259), and the
      // metadata address because it is the classic container escape target.
      for (const key of ["pubip", "pubname", "lan", "metadata", "limahost"]) {
        expect(out).toMatch(new RegExp(`^${key}=[1-9][0-9]*$`, "m"));
      }
    },
    180_000,
  );

  test(
    "the gateway's reachable set is ENUMERATED over all 65535 ports, and is exactly the host-namespace listeners",
    async () => {
      /**
       * ISC-261, and the test that would have caught M1.
       *
       * ## What was wrong with the evidence this replaces
       *
       * The version here before it probed FIVE guessed ports — 22, 2375, 2376,
       * 111, 53 — and asserted that the set reachable from the internal bridge
       * equalled the set reachable from an ordinary one. That is still
       * sampling: it moved the sampling from the destination ADDRESS to the
       * destination PORT and inherited the same weakness, which is that it can
       * only ever find what someone thought to list. `{every port on the bridge
       * gateway}` is one of the three terms in the honest reachable set (SRD
       * §12.8), and a five-element guess does not bound a 65535-element term.
       *
       * This enumerates it. Nothing is guessed; the whole range is asked.
       *
       * ## Why it is not vacuous, and can never come out "inconclusive"
       *
       * The old test had an early-return path for a host whose gateway served
       * none of its five candidates — it logged `[inconclusive]` and PASSED,
       * which is a silent pass wearing a warning label. Worse, an
       * empty-set-equals-empty-set comparison is true of a scanner that is
       * simply broken.
       *
       * Both are fixed by PLANTING the evidence rather than hoping to find it.
       * Two beacons go up before either scan, and the residual is demonstrated
       * on ports this test put there:
       *
       *  - a HOST-NAMESPACE beacon (`--network host`), which is what the VM's
       *    sshd is — a listener in the Docker host's own network namespace;
       *  - a PUBLISHED beacon (`-p P:P`), a container port DNAT'd onto the
       *    host.
       *
       * Both must appear in the uplink scan. That single assertion proves the
       * scanner works, proves both beacons came up, and makes every set
       * relation below a statement about live data.
       *
       * ## What the enumeration actually found, and why it CHANGED this test
       *
       * Measured 2026-08-19, and it is not what the previous test asserted:
       *
       *     from an ordinary bridge : 22, 39778 (published), 39779 (host-ns)
       *     from the deny-all bridge: 22,                    39779 (host-ns)
       *
       * The published port is NOT reachable from the internal bridge. So
       * `reachable == served`, which the old test asserted, is FALSE in
       * general — it held only because all five of its guessed candidates
       * happened to be host-namespace services. Publish any container port
       * matching one of them and it would have gone red for what is actually
       * good containment news.
       *
       * The mechanism, and it is worth knowing: Docker's isolation rule
       *
       *   -A DOCKER-ISOLATION-STAGE-1 ! -d 172.18.0.0/16 -i br-<id> -j DROP
       *
       * lives in FORWARD, which is evaluated AFTER nat/PREROUTING has already
       * rewritten a published port's destination to the target container's
       * address. That address is outside the internal bridge's subnet, so the
       * DNAT'd packet meets the DROP and dies. A host-namespace listener is
       * never forwarded at all — it is delivered locally through INPUT (policy
       * ACCEPT) — and so it is reachable, relay or no relay.
       *
       * The residual in SRD §12.8 is therefore NARROWER than "every port the
       * Docker host listens on": it is every HOST-NAMESPACE listener. That is
       * a real tightening of a documented residual, and it was found by
       * enumerating rather than by reasoning about iptables.
       *
       * ## Why this is the test that would have caught M1
       *
       * M1 was the bridge gateway being wide open while ISC-51 read as "no
       * route to anything". Two probes at `1.1.1.1` and `example.com` can
       * never surface that, because neither is on the bridge. This test cannot
       * avoid surfacing it: it plants a listener in the host namespace and
       * asserts, in a line someone has to write down and mean, that the
       * deny-all bridge REACHES it. Under the original claim that assertion is
       * a contradiction, and you cannot write it without discovering M1.
       *
       * IF THE HOST-NAMESPACE ASSERTION FAILS, that is very likely GOOD NEWS:
       * the gateway was hardened and SRD §12.8, ISC-51 and ISC-57 should all
       * be tightened to match. Do not "fix" it by deleting the assertion.
       */
      const net = testNetName();
      const uplink = uplinkNetworkName(net);
      cleanupNetworks.push(net);
      cleanupNetworks.push(uplink);
      await ensureEgressNetwork(net);
      await ensureUplinkNetwork(uplink);

      // Two ports in the ephemeral range, derived from the pid so parallel
      // runs on one machine do not collide over them.
      const publishedPort = 39000 + (process.pid % 900);
      const hostNsPort = publishedPort + 1000;

      const publishedBeacon = `pifleet-relay-beacon-pub-${process.pid}`;
      const hostNsBeacon = `pifleet-relay-beacon-hostns-${process.pid}`;
      cleanupContainers.push(publishedBeacon, hostNsBeacon);

      // `RELAY_IMAGE` rather than the worker image: it is plain upstream Node
      // pinned by digest, CI already pulls it for the relay, and a beacon has
      // no business depending on `pifleet image build` having succeeded.
      const beacon = (port: number) =>
        `require("net").createServer((s) => s.end()).listen(${port}, "0.0.0.0")`;
      const startBeacon = async (label: string, args: string[]): Promise<void> => {
        const r = await docker(args);
        if (r.code !== 0) {
          throw new Error(
            `relay test: the ${label} beacon container did not start (exit ${r.code}), so the ` +
              `enumeration below would have nothing planted to find. stderr=${r.stderr}`,
          );
        }
      };
      await startBeacon("published", [
        "run", "-d", "--name", publishedBeacon,
        "-p", `${publishedPort}:${publishedPort}`,
        "--entrypoint", "node", RELAY_IMAGE, "-e", beacon(publishedPort),
      ]);
      await startBeacon("host-namespace", [
        "run", "-d", "--name", hostNsBeacon, "--network", "host",
        "--entrypoint", "node", RELAY_IMAGE, "-e", beacon(hostNsPort),
      ]);

      // Both beacons are Node servers with no readiness signal, so poll the
      // published one from THIS process — it is the only one reachable from
      // here — rather than sleeping a guessed interval.
      await waitForTcp("127.0.0.1", publishedPort, 30_000);

      const scan = `${GATEWAY_DERIVE}\n${PORT_SCAN}\nscan_all "$GW"`;

      // GROUND TRUTH, and deliberately not a probe: the Docker host's own
      // kernel socket table, read from its network namespace. See
      // `HOST_LISTEN_SOCKETS` for why the expected set must not come from a
      // second scan of the same shape as the one under test.
      const listening = parsePortList(await onNetwork("host", HOST_LISTEN_SOCKETS), "listening");

      // A corroborating probe from an ordinary bridge, where reaching the
      // gateway is expected and uncontroversial, over the same complete range.
      const fromUplink = await onNetwork(uplink, scan);
      const served = parsePortList(fromUplink, "open");

      const fromInternal = await onInternalNetwork(net, scan);
      const reachable = parsePortList(fromInternal, "open");

      console.log(
        `[enumerated] host kernel socket table listens on [${listening.join(", ")}]; gateway ` +
          `${parseKv(fromUplink, "gateway")} (ordinary bridge) serves [${served.join(", ")}]; ` +
          `gateway ${parseKv(fromInternal, "gateway")} (deny-all bridge) reaches ` +
          `[${reachable.join(", ")}].`,
      );

      // The probes are alive and both beacons are up. Everything below is a
      // statement about live data because of these lines.
      expect(listening).toContain(hostNsPort);
      expect(served).toContain(publishedPort);
      expect(served).toContain(hostNsPort);

      // ISC-261's core claim: the deny-all bridge reaches the gateway ONLY on
      // ports the host is INDEPENDENTLY known to serve — "independently" being
      // the kernel's own socket table, not another scan. Enumerated over the
      // whole range, so this bounds the entire term rather than five points in
      // it. Strict, not vacuous: 53 listens and is NOT reachable.
      for (const port of reachable) expect(listening).toContain(port);

      // And the same relation against the corroborating bridge scan, which
      // catches the narrower drift of the internal bridge reaching something
      // an ordinary bridge cannot.
      for (const port of reachable) expect(served).toContain(port);

      // The residual, demonstrated on a planted port so it is never
      // inconclusive: a host-namespace listener IS reachable from the
      // deny-all bridge. This is the M1-catching assertion.
      expect(reachable).toContain(hostNsPort);

      // And the containment that genuinely holds: a published container port
      // is NOT. Meaningful only because `served` above proves it was up.
      expect(reachable).not.toContain(publishedPort);

      // The gateways are DIFFERENT addresses on the same machine — the uplink
      // bridge and the internal bridge each have their own — which is what
      // makes this a statement about the host rather than about one IP.
      expect(parseKv(fromInternal, "gateway")).not.toBe(parseKv(fromUplink, "gateway"));
    },
    600_000,
  );

  test(
    "the relay opens exactly one port on the bridge, and every sibling on the bridge is an expected fleet member",
    async () => {
      /**
       * The other two terms of the reachable set (SRD §12.8; ISC-261):
       *
       *     {relay listen ports} ∪ ... ∪ {every port on every sibling container}
       *
       * Neither was bounded by any test. Both are enumerated here.
       *
       * TERM 1 — the relay. `omlxRelayTarget` derives ONE forward from
       * `llm.base_url`, but nothing checked that the running container exposes
       * only that. The relay is the single sanctioned hole in the deny-all
       * bridge; "it forwards what we asked for" and "it forwards ONLY what we
       * asked for" are different claims, and a full-range scan of the relay's
       * own bridge address is what separates them. A debug listener, a second
       * forward left behind by a config change, or an inherited port from the
       * base image all land here as an extra element.
       *
       * TERM 3 — the siblings. `docker network inspect` is AUTHORITATIVE for
       * bridge membership: a container is on the bridge if and only if it is
       * in that list, so this is a complete enumeration by construction rather
       * than a scan that might miss something. What it defends against is a
       * stray container — a leftover from a crashed run, something an operator
       * attached by hand — sitting on the fleet's bridge with every one of its
       * ports reachable by every worker.
       */
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const nonce = `stub-scan-${process.pid}-${Date.now()}`;
      const stub = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch: () => Response.json({ object: "list", data: [{ id: nonce }] }),
      });
      try {
        const relay = await ensureEgressRelay(
          cfg(`http://host.docker.internal:${stub.port}/v1`),
          net,
        );
        expect(relay.created).toBe(true);
        expect(relay.targets).toHaveLength(1);
        const listenPort = relay.targets[0]!.listenPort;

        // The IDLE case first, while only the relay is attached — the probe
        // containers below join this network and would otherwise show up as
        // siblings of themselves.
        const idle = await networkMembers(net);
        expect(idle.map((m) => m.name)).toEqual([relay.name]);
        expect(unexpectedMembers(idle, [relay.name])).toEqual([]);
        const relayIp = idle[0]!.ip;
        expect(relayIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

        // Wait for the forward to be live before enumerating, so a slow start
        // cannot read as "the relay opens no ports".
        await onInternalNetwork(
          net,
          curlProbe("models", `http://host.docker.internal:${stub.port}/v1/models`),
        );

        const relayScan = await onInternalNetwork(
          net,
          `${PORT_SCAN}\nscan_all ${JSON.stringify(relayIp)}`,
        );
        const relayPorts = parsePortList(relayScan, "open");
        console.log(
          `[enumerated] relay ${relay.name} at ${relayIp} listens on [${relayPorts.join(", ")}].`,
        );

        // EXACTLY the derived listen port. Not "contains", not "at least one".
        expect(relayPorts).toEqual([listenPort]);

        /**
         * Now the LIVE case, because the idle assertion above passes on a
         * network that has no siblings to get wrong — the vacuous-pass shape
         * M3 was filed about in PR #18. A test that only ever sees an empty
         * sibling set cannot distinguish a working enumeration from one that
         * returns nothing, and cannot show that an unexpected member would
         * actually be caught.
         *
         * So a sibling is PLANTED, exactly as the beacons are planted in the
         * gateway test above, and all three claims are then checked against a
         * bridge that genuinely has a neighbour on it: that the enumeration
         * sees it, that the rule flags it as unaccounted for, and that its
         * ports really are reachable from an ordinary worker — which is the
         * third term of SRD §12.8's reachable set, demonstrated rather than
         * asserted in prose.
         */
        const strayPort = 47000 + (process.pid % 900);
        const stray = `pifleet-relay-stray-${process.pid}`;
        cleanupContainers.push(stray);
        const started = await docker([
          "run", "-d", "--name", stray, "--network", net,
          "--entrypoint", "node", RELAY_IMAGE,
          "-e", `require("net").createServer((s) => s.end()).listen(${strayPort}, "0.0.0.0")`,
        ]);
        if (started.code !== 0) {
          throw new Error(
            `relay test: the planted sibling did not start (exit ${started.code}), so the live ` +
              `half of this test would have measured an idle bridge again. stderr=${started.stderr}`,
          );
        }

        const live = await networkMembers(net);
        const strayIp = live.find((m) => m.name === stray)?.ip ?? "";
        console.log(`[enumerated] bridge ${net} members: ${live.map((m) => `${m.name}@${m.ip}`).join(", ")}`);

        // The enumeration SEES the sibling — this is what the idle case cannot
        // show, and what makes the idle assertion meaningful rather than lucky.
        expect(live.map((m) => m.name).sort()).toEqual([relay.name, stray].sort());
        // And the rule has teeth: an unaccounted-for member is reported.
        expect(unexpectedMembers(live, [relay.name])).toEqual([stray]);
        expect(strayIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

        // Third term of the reachable set, measured: a worker on the deny-all
        // bridge reaches its siblings, on exactly the ports they serve. This
        // is a residual, not a bug — but it should be a NUMBER, not prose.
        const strayScan = await onInternalNetwork(
          net,
          `${PORT_SCAN}\nscan_all ${JSON.stringify(strayIp)}`,
        );
        expect(parsePortList(strayScan, "open")).toEqual([strayPort]);

        // Removing it returns the bridge to an accounted-for state, so the
        // rule is not simply reporting everything it is shown.
        expect((await docker(["rm", "-f", stray])).code).toBe(0);
        expect(unexpectedMembers(await networkMembers(net), [relay.name])).toEqual([]);
      } finally {
        stub.stop(true);
      }
    },
    600_000,
  );
});

describe.skipIf(!DOCKER)("egress relay", () => {
  test(
    "a worker on the deny-all bridge reaches oMLX through the relay and nothing else",
    async () => {
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      /**
       * A stand-in for oMLX, in THIS process, on an ephemeral port.
       *
       * Ephemeral rather than 8000 on purpose: the real oMLX server may well
       * be holding 8000 on the machine running this suite, and a hardcoded
       * port would then test the relay against the wrong server — or fail to
       * bind at all. It also proves the port is genuinely read from
       * `llm.base_url` rather than hardcoded anywhere in the path.
       */
      const nonce = `stub-${process.pid}-${Date.now()}`;
      const stub = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch(req) {
          const { pathname } = new URL(req.url);
          if (pathname !== "/v1/models") return new Response("nope", { status: 404 });
          return Response.json({ object: "list", data: [{ id: nonce, object: "model" }] });
        },
      });
      const port = stub.port;
      const url = `http://host.docker.internal:${port}/v1/models`;

      try {
        // BEFORE: the destination is unreachable from the bridge. This is the
        // failure the relay exists to fix, demonstrated rather than assumed —
        // and it is what makes the success below mean something.
        const before = await onInternalNetwork(
          net,
          `curl -sS -m 5 ${JSON.stringify(url)} >/dev/null 2>&1; echo "pre=$?"`,
        );
        // POSITIVE, not `not.toContain("pre=0")`. The negative form passes on
        // any string that fails to contain the token — including an error
        // message from a probe that never ran. This asserts curl actually
        // reported a NON-ZERO failure code, which is the measurement.
        expect(before).toMatch(/^pre=[1-9][0-9]*$/m);

        const relay = await ensureEgressRelay(cfg(`http://host.docker.internal:${port}/v1`), net);
        expect(relay.created).toBe(true);
        expect(relay.name).toBe(relayContainerName(net));
        // The relay records WHAT it would run and WHERE it would forward, on
        // every run, created or adopted — the only cross-run trace of a target
        // or script change, since adoption never compares them (S5/S8).
        expect(relay.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(relay.targets).toEqual([
          { listenPort: port, host: "host.docker.internal", port, name: "omlx" } as RelayTarget,
        ]);

        /**
         * AFTER, from a container attached to nothing but the internal bridge:
         *  - the oMLX-shaped call returns the STUB'S OWN body (ISC-50), and
         *    the nonce is what proves it came from the real upstream rather
         *    than from anything Docker synthesized;
         *  - a public IP literal and a public name both fail (ISC-51, ISC-57)
         *    — the IP proves the ROUTE is absent, not merely the resolver.
         */
        const after = await onInternalNetwork(
          net,
          `${curlProbe("models", url)}
           curl -sS -m 5 https://1.1.1.1/ >/dev/null 2>&1; echo "ip=$?"
           curl -sS -m 5 https://example.com/ >/dev/null 2>&1; echo "name=$?"`,
        );
        expect(after).toContain(nonce);
        expect(after).toContain(`"object":"list"`);
        // POSITIVE assertions for the DENY half, for the reason in
        // `onInternalNetwork`'s comment. `toContain(nonce)` already rescued the
        // REACH half from vacuity; nothing rescued these two, and they are
        // precisely ISC-51/57's evidence. Asserting a non-zero curl code is
        // strictly stronger than asserting the absence of `=0`, and still not
        // hostage to curl's exact error taxonomy (7 vs 6 vs 28).
        expect(after).toMatch(/^ip=[1-9][0-9]*$/m);
        expect(after).toMatch(/^name=[1-9][0-9]*$/m);

        // Idempotence, the property `up` depends on: a second ensure adopts
        // the running relay rather than rebuilding a shared resource other
        // fleets may be using right now.
        const again = await ensureEgressRelay(cfg(`http://host.docker.internal:${port}/v1`), net);
        expect(again).toEqual({
          name: relay.name,
          created: false,
          scriptSha256: relay.scriptSha256,
          targets: relay.targets,
        });
        const status = await inspectRelayContainer(relay.name);
        expect(status.running).toBe(true);
      } finally {
        stub.stop(true);
      }
    },
    180_000,
  );

  test(
    "a stopped relay is rebuilt, not adopted as healthy",
    async () => {
      // The quiet downgrade this module refuses: the relay is recognized by a
      // deterministic NAME, so a dead container wearing that name would be
      // adopted by every later `up` and the fleet would report a model path
      // that forwards nothing.
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const nonce = `stub-stop-${process.pid}-${Date.now()}`;
      const stub = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch: () => Response.json({ object: "list", data: [{ id: nonce }] }),
      });
      const base = `http://host.docker.internal:${stub.port}/v1`;
      try {
        const first = await ensureEgressRelay(cfg(base), net);
        expect(first.created).toBe(true);
        const stopped = await docker(["stop", "-t", "1", first.name]);
        expect(stopped.code).toBe(0);

        const second = await ensureEgressRelay(cfg(base), net);
        expect(second.created).toBe(true);
        expect((await inspectRelayContainer(second.name)).running).toBe(true);

        // And the rebuilt relay actually forwards — "running" is a claim, the
        // stub's own body is the fact.
        const out = await onInternalNetwork(
          net,
          curlProbe("models", `http://host.docker.internal:${stub.port}/v1/models`),
        );
        expect(out).toContain(nonce);
      } finally {
        stub.stop(true);
      }
    },
    180_000,
  );

  test(
    "a base_url pointing away from the Docker host is refused before anything is created",
    async () => {
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);
      await expect(
        ensureEgressRelay(cfg("http://10.0.0.5:8000/v1"), net),
      ).rejects.toThrow(/host\.docker\.internal/);
      // Nothing was built on the way to that refusal.
      expect((await inspectRelayContainer(relayContainerName(net))).exists).toBe(false);
    },
    120_000,
  );

  test.skipIf(!OMLX_LIVE)(
    "the REAL oMLX model list comes back through the relay, from inside the bridge",
    async () => {
      /**
       * The live counterpart to the stub test (ISC-50 proper): a genuine
       * `GET /v1/models` against the real local inference server, authenticated
       * with the real key, from a container that has no route to it except the
       * relay.
       *
       * Asserted as "both sides return a non-empty list of model ids", not as
       * an exact set: oMLX's loaded models change as the maintainer works, and
       * a test that pins today's model names would fail for reasons that have
       * nothing to do with egress.
       */
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const direct = (await (
        await fetch("http://localhost:8000/v1/models", {
          headers: { Authorization: `Bearer ${OMLX_KEY}` },
          signal: AbortSignal.timeout(10_000),
        })
      ).json()) as { data?: Array<{ id?: unknown }> };
      const directIds = (direct.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
      expect(directIds.length).toBeGreaterThan(0);

      const relay = await ensureEgressRelay(
        cfg("http://host.docker.internal:8000/v1"),
        net,
      );
      expect(relay.created).toBe(true);

      /**
       * The key is passed by NAME through docker's env plumbing and expanded
       * INSIDE the container — never interpolated into the argv.
       *
       * The previous form built `-H "Authorization: Bearer <the real key>"`
       * into a shell string handed to `docker run`, which put the live key in
       * `ps` output, in the ephemeral container's `docker inspect`, and in any
       * CI log that echoes commands. No leak had happened yet only because
       * this test has never run anywhere but the maintainer's machine — it
       * becomes a live exposure the moment ISC-257 wires this file into CI with
       * a real secret. `$OMLX_API_KEY` below is expanded by the container's own
       * bash, not by this process.
       */
      const out = await onInternalNetwork(
        net,
        curlProbe(
          "models",
          "http://host.docker.internal:8000/v1/models",
          "Authorization: Bearer $OMLX_API_KEY",
        ),
        { OMLX_API_KEY: OMLX_KEY },
      );
      const line = out.split("\n").find((l) => l.startsWith("models="));
      expect(line).toBeDefined();
      const body = JSON.parse(line!.slice("models=".length)) as { data?: Array<{ id?: unknown }> };
      const throughRelay = (body.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
      expect(throughRelay.length).toBeGreaterThan(0);
      // Same server, so the two lists must overlap — a relay pointed at some
      // other listener could still return a well-formed model list.
      expect(throughRelay.some((id) => directIds.includes(id))).toBe(true);
    },
    180_000,
  );

  test.skipIf(!OMLX_LIVE)(
    "a live INFERENCE round-trips through the relay, differentially against a host control",
    async () => {
      /**
       * ISC-258. A real completion — tokens generated by a real model — from a
       * container whose only route to the server is the relay.
       *
       * ## Why this was backed out once, and what is different now
       *
       * The first attempt turned a green suite red for reasons that had
       * nothing to do with egress, and took the maintainer's inference server
       * down with it. Every one of those causes is handled explicitly here
       * rather than hoped away, and each rule below is a measured fact, not a
       * precaution.
       *
       * MODEL SELECTION IS AN ALLOWLIST, NEVER A HEURISTIC. This is the trap
       * that killed the server. Measured on the local server 2026-08-19:
       *
       *   Qwen3-Embedding-4B-4bit-DWQ  first in /v1/models, HTTP 500 on chat
       *   Qwen3.5-35B-A3B-4bit         24.93GB against a 24GB cap; logs
       *                                "Loading … without KV headroom" and
       *                                SIGABRTs inside MLX's Metal completion
       *                                handler DURING GENERATION, taking the
       *                                whole server down
       *   gemma-4-26b-a4b-it-4bit      15.26GB, fine
       *
       * So `data[0]` is wrong, and "the first id that is not obviously an
       * embedding model" is WORSE — it walks straight into the 35B and kills
       * the server. There is no ordering rule that is safe. Only a name the
       * maintainer has already run can be safe, so only names on
       * `SAFE_CHAT_MODELS` are ever sent a completion, and if none of them is
       * served this probe declines to guess.
       *
       * The `--max-model-memory 24GB` cap is an owner decision and is staying,
       * so that trap is live indefinitely. `FORBIDDEN_CHAT_MODELS` names the
       * 35B explicitly as a second, independent guard: the allowlist alone
       * already excludes it, but a future edit that widens the allowlist
       * should have to delete a line that says "this crashes the server".
       *
       * ERROR SHAPES DO NOT GENERALIZE ACROSS HOSTS, which is the other reason
       * no heuristic is safe. The same embedding model, same request:
       *
       *   local  server : HTTP 500, opaque "Internal server error"
       *   LAN    server : HTTP 400, "is not an LLM / chat model"
       *
       * A probe that classified models by how they failed would be right on
       * one host and wrong on the other.
       *
       * ## The differential
       *
       * A local inference server is not a dependable fixture, so this test is
       * built to fail ONLY for the reason it is about — the relay — and to say
       * so plainly the rest of the time:
       *
       *  1. take a CONTROL completion directly from the host;
       *  2. if the control does not succeed and answer correctly, the fixture
       *     is not in a state to judge the relay: bail loudly, do not fail;
       *  3. take the same completion THROUGH the relay;
       *  4. if the relayed call fails, RE-CHECK THE CONTROL before blaming the
       *     relay — in the observed crash the server died BETWEEN the two
       *     calls, so a relayed failure with a control that has also gone away
       *     is a dead server, not a broken relay;
       *  5. only when the control still succeeds and the relayed call does not
       *     is this a real failure.
       *
       * Be honest about step 2 and step 4: they are passes with a warning, and
       * a pass is what the probe guard counts. That is a genuine limitation
       * and it is the price of exercising a fixture nothing else controls; the
       * alternative is a suite that goes red when an unrelated server is
       * restarted. ISC-258 is graded `[~]` in ISA.md and not `[x]` for exactly
       * this reason, alongside the CI skip.
       *
       * ## The key
       *
       * Read from the environment, passed to the container by NAME through
       * `-e OMLX_API_KEY`, and expanded by the container's own bash. It never
       * enters argv, so it is not in `ps`, not in the ephemeral container's
       * `docker inspect`, and not in a log that echoes commands. PR #18 fixed
       * that for the models roundtrip; this must not regress it.
       */
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const origin = "http://localhost:8000";
      const models = (await (
        await fetch(`${origin}/v1/models`, {
          headers: { Authorization: `Bearer ${OMLX_KEY}` },
          signal: AbortSignal.timeout(10_000),
        })
      ).json()) as { data?: Array<{ id?: unknown }> };
      const servedIds = (models.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");

      const model = SAFE_CHAT_MODELS.find((m) => servedIds.includes(m));
      if (model === undefined) {
        console.warn(
          `[bail] live inference probe: this server serves [${servedIds.join(", ")}], none of ` +
            `which is on SAFE_CHAT_MODELS [${SAFE_CHAT_MODELS.join(", ")}]. Declining to pick ` +
            `one by heuristic — that is what SIGABRTed the server last time. Add a model to ` +
            `SAFE_CHAT_MODELS only after running a completion against it by hand.`,
        );
        return;
      }
      // Belt and braces: the allowlist already excludes these, so reaching
      // here means someone widened it without reading why they are named.
      expect(FORBIDDEN_CHAT_MODELS).not.toContain(model);

      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: "What is 2+2? Reply with only the number." }],
        max_tokens: 8,
        temperature: 0,
      });
      // The body is embedded in a single-quoted bash string below, so an
      // apostrophe anywhere in it would end the quoting and corrupt the JSON.
      expect(body).not.toContain("'");

      /** One direct completion from this process. `null` when it did not answer correctly. */
      const control = async (): Promise<string | null> => {
        try {
          const r = await fetch(`${origin}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OMLX_KEY}`,
              "Content-Type": "application/json",
            },
            body,
            signal: AbortSignal.timeout(300_000),
          });
          if (!r.ok) return null;
          const j = (await r.json()) as {
            choices?: Array<{ message?: { content?: unknown } }>;
          };
          const text = j.choices?.[0]?.message?.content;
          return typeof text === "string" && text.includes("4") ? text : null;
        } catch {
          return null;
        }
      };

      const before = await control();
      if (before === null) {
        console.warn(
          `[bail] live inference probe: the DIRECT control completion against ${origin} with ` +
            `model ${model} did not return a correct answer, so this server is not in a state ` +
            `to judge the relay. Nothing is claimed about egress either way.`,
        );
        return;
      }

      const relay = await ensureEgressRelay(cfg("http://host.docker.internal:8000/v1"), net);
      expect(relay.created).toBe(true);

      // Cheap roundtrip first: it waits for the forward to come up, and its
      // model list PROVES the relay reaches the same server the control just
      // used. Without this the differential could be comparing two different
      // inference servers and calling the difference a relay bug — which
      // matters concretely, because the local server serves 3 models and the
      // LAN one serves 32.
      const listOut = await onInternalNetwork(
        net,
        curlProbe(
          "models",
          "http://host.docker.internal:8000/v1/models",
          "Authorization: Bearer $OMLX_API_KEY",
        ),
        { OMLX_API_KEY: OMLX_KEY },
      );
      const listLine = listOut.split("\n").find((l) => l.startsWith("models="));
      expect(listLine).toBeDefined();
      const relayed = JSON.parse(listLine!.slice("models=".length)) as {
        data?: Array<{ id?: unknown }>;
      };
      const relayedIds = (relayed.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      expect([...relayedIds].sort()).toEqual([...servedIds].sort());

      // THE INFERENCE, from a container attached to nothing but the deny-all
      // bridge. No --add-host, no extra networks, no capabilities.
      const started = Date.now();
      const out = await onInternalNetwork(
        net,
        `code=$(curl -sS -m 300 -o /tmp/chat.json -w '%{http_code}' \\
             -H "Authorization: Bearer $OMLX_API_KEY" \\
             -H 'Content-Type: application/json' \\
             --data '${body}' \\
             ${JSON.stringify("http://host.docker.internal:8000/v1/chat/completions")} \\
             2>/dev/null || echo "curl-failed")
         echo "code=$code"
         echo "reply=$(tr -d '\\n' < /tmp/chat.json)"`,
        { OMLX_API_KEY: OMLX_KEY },
      );
      const elapsed = Date.now() - started;

      const code = parseKv(out, "code");
      const replyRaw = parseKv(out, "reply") ?? "";
      let answer: string | null = null;
      if (code === "200") {
        try {
          const parsed = JSON.parse(replyRaw) as {
            model?: unknown;
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: { completion_tokens?: unknown };
          };
          const text = parsed.choices?.[0]?.message?.content;
          if (typeof text === "string" && text.includes("4")) {
            // It is the model we asked for, and it genuinely GENERATED — an
            // echoed empty string with a 200 is not an inference.
            expect(parsed.model).toBe(model);
            expect(Number(parsed.usage?.completion_tokens ?? 0)).toBeGreaterThan(0);
            answer = text;
          }
        } catch {
          answer = null;
        }
      }

      if (answer === null) {
        // Before blaming the relay, ask whether the server is still there at
        // all. This is the whole reason the control is a function rather than
        // a value: in the observed crash it died BETWEEN the two calls.
        const after = await control();
        if (after === null) {
          console.warn(
            `[bail] live inference probe: the relayed completion did not answer (code=${code}), ` +
              `AND the direct control that succeeded moments ago now fails too. The inference ` +
              `server went away between the two calls — that is a dead fixture, not a relay ` +
              `defect, and nothing is claimed about egress. Relayed body: ` +
              `${JSON.stringify(replyRaw.slice(0, 400))}`,
          );
          return;
        }
        throw new Error(
          `relay: a live inference FAILED through the relay while the direct control still ` +
            `succeeds — the control answered ${JSON.stringify(after)} both before and after, so ` +
            `the server is healthy and the relay is the difference. Relayed HTTP code=${code}, ` +
            `body=${JSON.stringify(replyRaw.slice(0, 400))}`,
        );
      }

      console.log(
        `[live] ${model}: relayed inference answered ${JSON.stringify(answer)} in ${elapsed}ms ` +
          `from inside the deny-all bridge (direct control: ${JSON.stringify(before)}).`,
      );
    },
    900_000,
  );
});
