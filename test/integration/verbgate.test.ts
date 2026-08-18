/**
 * verbgate behaviour, probed against a real built image (SRD §5.10).
 *
 * These run only with a Docker daemon and a built worker image. They are gated
 * rather than deleted because the gate's whole value is what it does in a real
 * container — a mocked version of this test would assert on our own beliefs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeDaemonScratch, makeWorkerAccessible } from "../../src/container/mounts.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] verbgate integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

const scratches: string[] = [];
afterEach(async () => {
  await Promise.all(scratches.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * A task-scoped policy on a READ-ONLY mount plus a writable outbox — the real
 * deployment shape. The policy path and the ledger path are constants inside
 * the shim now: they used to come from the environment, which let the worker
 * point the gate at its own allow file and its ledger at /dev/null. A test that
 * configures them through env would be testing a control that no longer exists.
 */
async function makeSandbox(allow = "kubectl rollout restart\n"): Promise<{
  host: string;
  mounts: string[];
  ledger: () => Promise<string>;
}> {
  const host = await makeDaemonScratch("verbgate");
  scratches.push(host);
  await mkdir(join(host, "outbox", "ledger"), { recursive: true });
  await mkdir(join(host, "policy"), { recursive: true });
  // The scratch root's mode does not descend. `mkdir` gives 0755, so on Linux —
  // where a bind mount passes host ownership through untouched — the worker's
  // uid 10001 cannot create the ledger file and every gate decision is lost
  // with an ENOENT nobody sees. macOS squashes ownership and hides it.
  await makeWorkerAccessible(join(host, "outbox"), true);
  await makeWorkerAccessible(join(host, "outbox", "ledger"), true);
  const policy = join(host, "policy", "cloud-allow");
  await writeFile(policy, allow);
  await chmod(policy, 0o444);
  return {
    host,
    mounts: ["-v", `${join(host, "outbox")}:/outbox`, "-v", `${policy}:/policy/cloud-allow:ro`],
    ledger: () =>
      readFile(join(host, "outbox", "ledger", "verbgate.jsonl"), "utf8").catch(() => ""),
  };
}

/** Run a shell script inside the worker image and return its stdout. */
async function inImage(script: string, mounts: string[] = []): Promise<string> {
  const p = Bun.spawn(
    ["docker", "run", "--rm", ...mounts, "--entrypoint", "bash", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

const PRELUDE = `export PIFLEET_TASK_ID=T-004 PIFLEET_EPOCH=1`;

describe.skipIf(!DOCKER)("verbgate", () => {
  /**
   * ISC-103. The exit code alone was vacuous: `kubectl version --client` exits
   * 0 whether or not the gate exists, so deleting verbgate entirely left this
   * passing. The ledger row is the part that proves the SHIM handled it rather
   * than the binary being reached directly.
   */
  test("a read verb passes through and is recorded as a read", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}\nkubectl version --client >/dev/null 2>&1; echo "rc=$?"`, sb.mounts);
    expect(out).toContain("rc=0");
    const rows = (await sb.ledger()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("allow_read");
    expect(rows[0].verb).toBe("version");
  });

  // ISC-104
  test("a mutating verb absent from cloud_allow exits 77", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}\nkubectl delete deployment web >/dev/null 2>&1; echo "rc=$?"`, sb.mounts);
    expect(out).toContain("rc=77");
  });

  /**
   * ISC-105 — a non-77 code means the gate handed off; the real binary then
   * fails for its own reasons (no cluster), which is not the gate's business.
   *
   * Paired with a negative in the SAME sandbox: asserting only that the
   * allow-listed verb gets through is satisfied by a gate that allows
   * everything, so a different mutating verb must still be refused under the
   * identical policy for this to mean anything.
   */
  test("cloud_allow admits the named verb and nothing else", async () => {
    const sb = await makeSandbox();
    const out = await inImage(
      `${PRELUDE}
       kubectl rollout restart deployment/web >/dev/null 2>&1; echo "allowed=$?"
       kubectl delete deployment web >/dev/null 2>&1; echo "other=$?"
       kubectl scale deployment/web --replicas=0 >/dev/null 2>&1; echo "scale=$?"`,
      sb.mounts,
    );
    expect(out).not.toContain("allowed=77");
    expect(out).toContain("other=77");
    expect(out).toContain("scale=77");
  });

  // Matching on verb tokens rather than the whole command line is what makes
  // this pointless; a substring match would be defeated by the reordering.
  test("a verb hidden behind leading flags fails closed", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}\nkubectl --namespace prod delete deployment web >/dev/null 2>&1; echo "rc=$?"`, sb.mounts);
    expect(out).toContain("rc=77");
  });

  test("helm and gcloud are gated on the same rules as kubectl", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}
       helm uninstall api >/dev/null 2>&1; echo "helm=$?"
       helm list >/dev/null 2>&1; echo "helm_read=$?"
       gcloud compute instances delete vm-1 >/dev/null 2>&1; echo "gcloud=$?"`, sb.mounts);
    expect(out).toContain("helm=77");
    expect(out).not.toContain("helm_read=77");
    expect(out).toContain("gcloud=77");
  });

  /**
   * ISC-107 regression.
   *
   * The ledger previously dropped every invocation whose argv contained a flag:
   * jq 1.6's `--args` does not stop option parsing, so `kubectl version
   * --client` made jq exit "Unknown option", and the logger's own error
   * suppression swallowed it. The gate still refused correctly — only the
   * record disappeared, including for the flags-before-verb evasion pattern.
   * Counting rows against invocations is what catches that; asserting on any
   * single row does not.
   */
  test("every invocation reaches the ledger, including flag-bearing ones", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}
       kubectl version --client >/dev/null 2>&1
       kubectl delete deployment web >/dev/null 2>&1
       kubectl --namespace prod delete deployment web >/dev/null 2>&1
       kubectl rollout restart deployment/web --timeout=30s >/dev/null 2>&1
       helm uninstall api >/dev/null 2>&1
       wc -l < /outbox/ledger/verbgate.jsonl`, sb.mounts);
    expect(Number(out.trim())).toBe(5);
  });

  // ISC-106
  test("a permitted mutating verb is recorded with task id and argv", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}
       kubectl rollout restart deployment/web --timeout=30s >/dev/null 2>&1
       jq -c 'select(.decision=="allow_listed") | {task_id, epoch, verb, argv}' /outbox/ledger/verbgate.jsonl`, sb.mounts);
    const row = JSON.parse(out.trim());
    expect(row.task_id).toBe("T-004");
    expect(row.epoch).toBe(1);
    expect(row.verb).toBe("rollout restart deployment/web");
    expect(row.argv).toContain("--timeout=30s");
  });

  /**
   * Adversarial regressions. Each of the three below was a reproduced bypass
   * that routed a mutating verb to the real binary.
   */
  describe("round-2 review findings", () => {
    /**
     * Audit forgery through the printf fallback.
     *
     * `log_ledger` prefers jq, which escapes everything, and falls back to a
     * raw `printf` when jq fails (an oversized argv makes jq exit E2BIG). That
     * fallback sanitized only `verb` — `task_id` and `epoch` are worker-owned
     * environment and went in raw. A task id containing `","decision":"…`
     * appends a duplicate key, and `JSON.parse` keeps the LAST one, so a
     * refused destructive verb reads back from the audit trail as permitted.
     *
     * jq is stubbed out rather than argv inflated: inflating it enough to break
     * jq also breaks `exec` itself (rc=126), so the fallback would never run and
     * the test would pass without reaching the code under test.
     */
    const FORGE_TASK = 'T-1","decision":"allow_read","forged":"yes';
    const FORGE_EPOCH = '0,"decision":"allow_listed","forged":true';
    const STUB_JQ =
      'mkdir -p /tmp/stub && printf "#!/bin/sh\\nexit 1\\n" > /tmp/stub/jq && ' +
      "chmod +x /tmp/stub/jq && export PATH=/tmp/stub:$PATH";

    test("a forged task id cannot rewrite the decision in the fallback row", async () => {
      const sb = await makeSandbox();
      await inImage(
        `export PIFLEET_TASK_ID='${FORGE_TASK}' PIFLEET_EPOCH=1\n${STUB_JQ}\n` +
          `kubectl delete pod x >/dev/null 2>&1; echo "rc=$?"`,
        sb.mounts,
      );
      const rows = (await sb.ledger())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { decision: string; forged?: unknown });
      expect(rows).toHaveLength(1);
      // The decision the gate actually made, not the one the worker injected.
      expect(rows[0]!.decision).toBe("refuse");
      expect(rows[0]!.forged).toBeUndefined();
    });

    test("a forged epoch cannot break the row or inject a key", async () => {
      const sb = await makeSandbox();
      await inImage(
        `export PIFLEET_TASK_ID=T-2 PIFLEET_EPOCH='${FORGE_EPOCH}'\n${STUB_JQ}\n` +
          `kubectl delete pod y >/dev/null 2>&1; echo "rc=$?"`,
        sb.mounts,
      );
      const rows = (await sb.ledger())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { decision: string; epoch: number; forged?: unknown });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe("refuse");
      expect(rows[0]!.epoch).toBe(0); // digits-only, never the injected text
      expect(rows[0]!.forged).toBeUndefined();
    });

    /**
     * `gcloud auth print-access-token` matched the `print-*` read glob and was
     * therefore an ALLOW-LISTED read. curl is in the image, so a worker could
     * mint a bearer token and issue any mutating REST call — no gate row, no
     * refusal, containment inverted by a glob. It is also the obvious next move
     * for an agent that just took a 77.
     */
    test("credential-minting verbs are refused despite matching the read glob", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         gcloud auth print-access-token >/dev/null 2>&1;   echo "access=$?"
         gcloud auth print-identity-token >/dev/null 2>&1; echo "identity=$?"
         gcloud container clusters get-credentials c >/dev/null 2>&1; echo "creds=$?"`,
        sb.mounts,
      );
      expect(out).toContain("access=77");
      expect(out).toContain("identity=77");
      expect(out).toContain("creds=77");
    });

    /**
     * The negative half: the narrowing must not have swallowed genuine reads,
     * or the gate becomes something operators route around.
     */
    test("genuine gcloud reads still reach the real binary", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         gcloud compute instances list >/dev/null 2>&1;        echo "list=$?"
         gcloud compute instances describe vm >/dev/null 2>&1; echo "describe=$?"`,
        sb.mounts,
      );
      expect(out).not.toContain("list=77");
      expect(out).not.toContain("describe=77");
      const rows = (await sb.ledger())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { decision: string });
      expect(rows.every((r) => r.decision === "allow_read")).toBe(true);
    });
  });

  describe("bypasses", () => {
    /**
     * The gcloud arm scanned EVERY leading token for a read keyword, so a
     * positional argument named `list` turned a delete into a read. It now
     * classifies on the first recognized verb and stops.
     */
    test("a read-keyword POSITIONAL cannot outvote a mutating verb", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         gcloud compute instances delete real-vm list >/dev/null 2>&1; echo "positional=$?"
         gcloud compute instances describe vm-1 >/dev/null 2>&1; echo "describe=$?"`,
        sb.mounts,
      );
      expect(out).toContain("positional=77");
      // The control: a genuine read still passes, so the fix is not "refuse everything".
      expect(out).not.toContain("describe=77");
    });

    /**
     * The classifier iterated an unquoted expansion, so an argument of `*`
     * re-expanded against the CWD. Dropping a file named `describe` beside the
     * invocation made a delete classify as a read.
     */
    test("a glob argument cannot re-expand into a read keyword", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         mkdir -p /tmp/g && cd /tmp/g && : > describe && : > list
         gcloud compute instances delete prod-db "*" >/dev/null 2>&1; echo "glob=$?"`,
        sb.mounts,
      );
      expect(out).toContain("glob=77");
    });

    /**
     * gsutil and bq ship with google-cloud-cli, share its credentials, and are
     * fully mutating — and were simply on PATH un-wrapped. `gsutil rm -r` is as
     * destructive as `kubectl delete`.
     */
    test("gsutil and bq are gated, not merely present", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         gsutil rm -r gs://prod-bucket/ >/dev/null 2>&1; echo "gsutil_rm=$?"
         bq rm -f -t proj:dataset.table >/dev/null 2>&1; echo "bq_rm=$?"
         gsutil ls gs://b/ >/dev/null 2>&1; echo "gsutil_ls=$?"`,
        sb.mounts,
      );
      expect(out).toContain("gsutil_rm=77");
      expect(out).toContain("bq_rm=77");
      expect(out).not.toContain("gsutil_ls=77");
    });

    /**
     * The policy is the worker's own constraint, so a worker that can rewrite
     * it has no constraint. It used to live in the worker-owned /outbox.
     */
    test("the worker cannot rewrite its own policy", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         printf '*\\n' > /policy/cloud-allow 2>/dev/null; echo "tamper=$?"
         kubectl delete deployment web >/dev/null 2>&1; echo "after=$?"`,
        sb.mounts,
      );
      expect(out).not.toContain("tamper=0");
      expect(out).toContain("after=77");
    });

    /**
     * ISC-219 — the test above attempts the path the FIX uses. It never
     * attempted the one the DEFECT used.
     *
     * `/policy/cloud-allow` is read-only by construction, so "the worker
     * cannot rewrite its own policy" passes against a shim reading somewhere
     * else entirely — including one that regressed to reading the
     * worker-owned `/outbox`, which is the bug that moved the policy in the
     * first place (`render.ts`: "It used to be read out of /outbox, which the
     * worker owns — so the subject of the policy could rewrite the policy").
     * The mutation the old test cannot see is precisely the one that matters.
     *
     * Both `/outbox`-rooted candidates are attempted, because the exact
     * pre-fix constant is not recoverable: the shim landed already-fixed in
     * the Phase 1 squash, so no revision of `docker/verbgate` names it. The
     * criterion is that the gate ignores a policy written anywhere the worker
     * owns, and covering both roots states that more strongly than guessing
     * one.
     *
     * Three assertions, and every one is load-bearing:
     *   - the writes SUCCEED, so this is a genuine attempt rather than one
     *     the filesystem happened to block;
     *   - the injected `*` grants nothing;
     *   - the REAL policy is still in force, which is what separates "the
     *     gate ignored the forgery" from "the gate is broken and refuses
     *     everything" — the refusal alone is satisfied by both.
     */
    test("a policy planted at the pre-fix /outbox path grants nothing", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         mkdir -p /outbox/policy 2>/dev/null
         printf '*\\n' > /outbox/cloud-allow 2>/dev/null;        echo "flat=$?"
         printf '*\\n' > /outbox/policy/cloud-allow 2>/dev/null; echo "nested=$?"
         kubectl delete deployment web >/dev/null 2>&1;          echo "after=$?"
         kubectl rollout restart deployment/web >/dev/null 2>&1; echo "allowed=$?"
         rm -rf /outbox/policy /outbox/cloud-allow`,
        sb.mounts,
      );
      // The forgery was really written — /outbox is the worker's own mount.
      expect(out).toContain("flat=0");
      expect(out).toContain("nested=0");
      // And it bought nothing: the verb it "allowed" is still refused…
      expect(out).toContain("after=77");
      // …while the read-only policy the gate actually reads still admits its
      // own verb, so the refusal above is discrimination, not breakage.
      expect(out).not.toContain("allowed=77");
    });

    /**
     * And if the policy IS writable — a misconfigured mount — the gate refuses
     * everything rather than consulting a policy its subject controls.
     */
    test("a writable policy file refuses every verb with 78", async () => {
      const host = await makeDaemonScratch("verbgate-rw");
      scratches.push(host);
      await mkdir(join(host, "outbox", "ledger"), { recursive: true });
      await mkdir(join(host, "policy"), { recursive: true });
      await makeWorkerAccessible(join(host, "outbox"), true);
      await makeWorkerAccessible(join(host, "outbox", "ledger"), true);
      await writeFile(join(host, "policy", "cloud-allow"), "*\n");
      await chmod(join(host, "policy", "cloud-allow"), 0o666);
      await chmod(join(host, "policy"), 0o777);
      const out = await inImage(
        `${PRELUDE}\nkubectl get pods --request-timeout=1s >/dev/null 2>&1; echo "rc=$?"`,
        ["-v", `${join(host, "outbox")}:/outbox`, "-v", `${join(host, "policy")}:/policy`],
      );
      expect(out).toContain("rc=78");
    });

    /**
     * Second-order availability defect: `kubectl -n <ns> get …` is the most
     * common form there is, and refusing it trained operators to wildcard
     * cloud_allow[] or route around the shim — dismantling the control. Global
     * flags are parsed past; unknown flag shapes still fail closed.
     */
    test("global flags before a read verb do not force a refusal", async () => {
      const sb = await makeSandbox();
      const out = await inImage(
        `${PRELUDE}
         kubectl -n kube-system get pods --request-timeout=1s >/dev/null 2>&1; echo "ns=$?"
         kubectl --context prod get pods --request-timeout=1s >/dev/null 2>&1; echo "ctx=$?"
         kubectl --namespace=prod get pods --request-timeout=1s >/dev/null 2>&1; echo "eq=$?"
         kubectl -n prod delete pod web >/dev/null 2>&1; echo "mutate=$?"`,
        sb.mounts,
      );
      expect(out).not.toContain("ns=77");
      expect(out).not.toContain("ctx=77");
      expect(out).not.toContain("eq=77");
      // Skipping global flags must not skip the gate.
      expect(out).toContain("mutate=77");
    });

    /**
     * The printf fallback interpolated raw argv into a JSON string. jq fails on
     * an oversized argv, so a token containing a newline split one row in two
     * and let a forged row through the crack.
     */
    test("a newline in a verb token cannot forge a ledger row", async () => {
      const sb = await makeSandbox();
      await inImage(
        `${PRELUDE}
         BIG=$(head -c 100000 /dev/zero | tr '\\0' 'x')
         FORGE=$(printf 'delete\\n{"decision":"allow_read","forged":true}')
         kubectl "$FORGE" $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG \\
           $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG $BIG >/dev/null 2>&1
         true`,
        sb.mounts,
      );
      const raw = await sb.ledger();
      for (const line of raw.split("\n").filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(raw).not.toContain('"forged":true');
    });
  });

  test("refusal names the verb and the task so the block is actionable", async () => {
    const sb = await makeSandbox();
    const p = Bun.spawn(
      ["docker", "run", "--rm", ...sb.mounts, "--entrypoint", "bash", IMAGE, "-c", `${PRELUDE}\nkubectl delete deployment web`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const err = await new Response(p.stderr).text();
    await p.exited;
    expect(err).toContain("not authorized");
    expect(err).toContain("T-004");
    expect(err).toContain("cloud_allow");
  });
});

describe.skipIf(!DOCKER)("worker image toolchain", () => {
  // ISC-33..37 — presence is not enough; the relocation once produced an image
  // where all five were on PATH and every one of them exited 127.
  test("gcloud, kubectl, helm, jq and curl all execute", async () => {
    const out = await inImage(
      `for c in "gcloud version" "kubectl version --client" "helm version" "jq --version" "curl --version"; do
         $c >/dev/null 2>&1 && echo "ok:$c" || echo "FAIL:$c"
       done`,
    );
    expect(out).not.toContain("FAIL:");
    expect(out.match(/ok:/g)).toHaveLength(5);
  });

  test("the relocated real binaries are not dangling symlinks", async () => {
    const out = await inImage(
      `for f in /usr/local/libexec/*.real; do test -e "$f" || echo "DANGLING:$f"; done; echo done`,
    );
    expect(out).not.toContain("DANGLING:");
  });

  /**
   * ISC-25, ISC-38. `readlink -f` prints its argument and exits 0 for a path
   * that does not exist, so asserting on its output proved nothing — the test
   * passed against an image with no tini at all. Test executability instead.
   */
  test("runs as uid 10001 under a tini that actually exists", async () => {
    const out = await inImage(
      `id -u; test -x /usr/bin/tini && echo "tini=executable" || echo "tini=MISSING"`,
    );
    expect(out).toContain("10001");
    expect(out).toContain("tini=executable");
  });
});
