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
import { makeDaemonScratch, makeWorkerAccessible, WORKER_UID } from "../../src/container/mounts.ts";
import { runPaths, workerOutboxDir, workerVerbgateLedger } from "../../src/run/paths.ts";
import { createRepliesDir } from "../../src/run/replies.ts";
import { readCollectedVerbgate, VerbgateCollector } from "../../src/run/verbgate-collect.ts";
import { cliBudget, containerBudget } from "../support/budget.ts";

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
async function makeSandbox(
  allow = "kubectl rollout restart\n",
  provenance: { task: string; epoch: string } = { task: "T-004", epoch: "1" },
): Promise<{
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
  /**
   * Provenance is a MOUNTED FILE now, not environment (ISC-362). The tests
   * below that used to `export PIFLEET_TASK_ID` were the only place in the
   * repo that variable was ever set, which was the defect: the gate read a
   * value nothing in production supplied.
   *
   * It is parameterised because the forgery probes need to poison it. The gate
   * does not trust this file even though the host writes it — a gate that
   * trusts an input because of where it came from is one mount error away from
   * trusting the worker — so the sanitisation those probes cover still has to
   * be proved, now against a hostile FILE rather than a hostile environment.
   */
  const taskPolicy = join(host, "policy", "task");
  await writeFile(taskPolicy, `${provenance.task}\n${provenance.epoch}\n`);
  await chmod(taskPolicy, 0o444);
  return {
    host,
    mounts: [
      "-v",
      `${join(host, "outbox")}:/outbox`,
      "-v",
      `${policy}:/policy/cloud-allow:ro`,
      "-v",
      `${taskPolicy}:/policy/task:ro`,
    ],
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

// Provenance arrives through the mounted policy file, so the prelude has
// nothing to export. Kept as a named constant because every probe below
// composes it, and inlining an empty string reads like an omission.
const PRELUDE = `:`;

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
  }, cliBudget(1));

  // ISC-104
  test("a mutating verb absent from cloud_allow exits 77", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}\nkubectl delete deployment web >/dev/null 2>&1; echo "rc=$?"`, sb.mounts);
    expect(out).toContain("rc=77");
  }, cliBudget(1));

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
  }, cliBudget(1));

  // Matching on verb tokens rather than the whole command line is what makes
  // this pointless; a substring match would be defeated by the reordering.
  test("a verb hidden behind leading flags fails closed", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}\nkubectl --namespace prod delete deployment web >/dev/null 2>&1; echo "rc=$?"`, sb.mounts);
    expect(out).toContain("rc=77");
  }, cliBudget(1));

  test("helm and gcloud are gated on the same rules as kubectl", async () => {
    const sb = await makeSandbox();
    const out = await inImage(`${PRELUDE}
       helm uninstall api >/dev/null 2>&1; echo "helm=$?"
       helm list >/dev/null 2>&1; echo "helm_read=$?"
       gcloud compute instances delete vm-1 >/dev/null 2>&1; echo "gcloud=$?"`, sb.mounts);
    expect(out).toContain("helm=77");
    expect(out).not.toContain("helm_read=77");
    expect(out).toContain("gcloud=77");
  }, cliBudget(1));

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
  }, cliBudget(1));

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
  }, cliBudget(1));

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
      const sb = await makeSandbox(undefined, { task: FORGE_TASK, epoch: "1" });
      await inImage(
        `${STUB_JQ}\nkubectl delete pod x >/dev/null 2>&1; echo "rc=$?"`,
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
    }, cliBudget(1));

    test("a forged epoch cannot break the row or inject a key", async () => {
      const sb = await makeSandbox(undefined, { task: "T-2", epoch: FORGE_EPOCH });
      await inImage(
        `${STUB_JQ}\nkubectl delete pod y >/dev/null 2>&1; echo "rc=$?"`,
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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));
  });

  /**
   * SRD-DEPLOY-OPS §5.3/§10.1a/§12 D5. `gcloud logging read` is the only log
   * channel that survives a `Forbidden` `kubectl logs` or a down VPN tunnel,
   * and it exited 77 because neither `logging` nor `read` matched either
   * classification set. `read` now joins the read set.
   *
   * The three refusals ride in the SAME test as the new allowance, on
   * purpose: a widening that admits `logging read` but ALSO reopens
   * `print-access-token` (mints a bearer token), `get-credentials` (writes a
   * kubeconfig), or lets a POSITIONAL outvote a preceding verb would pass a
   * test that checked the new allowance alone. The last of the three replays
   * this file's own header defect — `gcloud compute instances delete
   * real-vm list` once classified as a read because a positional was named
   * `list` — with `read` in the positional's place, since `read` is now a
   * recognized token too and is the one this change could plausibly widen.
   */
  test("D5 — gcloud logging read is admitted without loosening credential-minting or positional-verb refusals", async () => {
    const sb = await makeSandbox();
    const out = await inImage(
      `${PRELUDE}
       gcloud logging read "resource.type=k8s_container" --limit=1 >/dev/null 2>&1; echo "logging=$?"
       gcloud auth print-access-token >/dev/null 2>&1;                              echo "token=$?"
       gcloud container clusters get-credentials demo-cluster >/dev/null 2>&1;      echo "creds=$?"
       gcloud compute instances delete real-vm read >/dev/null 2>&1;                echo "positional=$?"`,
      sb.mounts,
    );
    expect(out).not.toContain("logging=77");
    expect(out).toContain("token=77");
    expect(out).toContain("creds=77");
    expect(out).toContain("positional=77");

    const rows = (await sb.ledger())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tool: string; verb: string; decision: string });
    const loggingRow = rows.find((r) => r.tool === "gcloud" && r.verb.startsWith("logging read"));
    expect(loggingRow?.decision).toBe("allow_read");
  }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));

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
    }, cliBudget(1));
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
  }, cliBudget(1));
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
  }, cliBudget(1));

  test("the relocated real binaries are not dangling symlinks", async () => {
    const out = await inImage(
      `for f in /usr/local/libexec/*.real; do test -e "$f" || echo "DANGLING:$f"; done; echo done`,
    );
    expect(out).not.toContain("DANGLING:");
  }, cliBudget(1));

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
  }, cliBudget(1));

  /**
   * ISC-172's LAST MILE, and the reason every other probe of the collector
   * cannot reach it: they write the source ledger themselves, at the host path
   * `workerVerbgateLedger` names. What that proves is that the collector reads
   * the path the HELPER names. It does not prove this is the path
   * `docker/verbgate` actually writes through the `/outbox` bind mount. Two
   * different claims; only one of them was tested, and the untested one is the
   * one a worker's real trail depends on.
   *
   * THE SUFFIX IS WHERE THEY CAN DISAGREE. `workerVerbgateLedger` appends
   * `ledger/verbgate.jsonl` in TypeScript; `docker/verbgate` hardcodes
   * `/outbox/ledger/verbgate.jsonl` in shell. Nothing links them — no shared
   * constant, no generated header, no import — so a rename on either side
   * leaves BOTH sides internally consistent and every existing test green,
   * while the collector tails a path nothing writes and reports an empty audit
   * trail for a worker that ran gated verbs all day. A silent empty is the
   * worst failure an audit trail has, because it is indistinguishable from
   * good news.
   *
   * WHAT THIS DOES NOT PROVE, stated so the next reader does not over-read it:
   * that production mounts this directory at `/outbox`. The mount ROOT is
   * shared by construction — `src/config/render.ts` and this test both call
   * `workerOutboxDir` — and it is `container-env.test.ts` that reads the real
   * mount table back out of `docker inspect`. The claim here is the narrower,
   * previously untested half: the suffix agrees, through a real bind mount,
   * into a real run tree, with the real shim doing the writing.
   *
   * A REFUSED verb is used rather than a permitted one deliberately. A refusal
   * is the row the trail exists to carry, it needs nothing from the allow file
   * to be produced, and it does not depend on the wrapped binary succeeding.
   */
  test("verbgate writes where the collector looks, through a real bind mount", async () => {
    const root = await makeDaemonScratch("vgpath");
    scratches.push(root);
    const run = runPaths(`r-vgp-${process.pid.toString(36)}`, root);
    const worker = "eng-1";

    // The run tree as `up` leaves it, with `ledger/` pre-created and opened
    // for the same reason `makeSandbox` does it — and the reason is CLEANUP,
    // not the shim. On Linux a bind mount passes host ownership through, so a
    // `ledger/` created by verbgate belongs to uid 10001 at the container's
    // umask and the runner cannot unlink the file inside it; `afterEach` then
    // fails with EACCES having asserted everything correctly. macOS squashes
    // ownership and hides it, which is how this reached CI green locally.
    //
    // Pre-creating it does NOT weaken the claim. A helper/shim disagreement on
    // the DIRECTORY name still surfaces: the shim would `mkdir -p` its own
    // name and write there, and the read below — which takes its whole path
    // from `workerVerbgateLedger` — would miss it exactly as before.
    const outbox = workerOutboxDir(run.root, worker);
    await mkdir(join(outbox, "ledger"), { recursive: true });
    await makeWorkerAccessible(outbox, true);
    await makeWorkerAccessible(join(outbox, "ledger"), true);

    const policy = join(root, "policy", "cloud-allow");
    await mkdir(join(root, "policy"), { recursive: true });
    await writeFile(policy, "kubectl rollout restart\n");
    await chmod(policy, 0o444);

    await inImage(`${PRELUDE}\nkubectl delete pod doomed >/dev/null 2>&1; echo "rc=$?"`, [
      "-v",
      `${outbox}:/outbox`,
      "-v",
      `${policy}:/policy/cloud-allow:ro`,
    ]);

    // Half one. The path is taken from the helper and never re-joined here, so
    // a suffix disagreement surfaces as ENOENT naming the path it looked at.
    const rows = (await readFile(workerVerbgateLedger(run.root, worker), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("refuse");

    // Half two. The collector discovers the worker from the outbox directory on
    // disk and copies the row out — driven against this same real run tree,
    // not a hand-built fixture.
    const reports = await new VerbgateCollector(run).collectOnce();
    expect(reports.map((r) => r.worker)).toContain(worker);
    const collected = await readCollectedVerbgate(run, worker);
    expect(collected.filter((r) => r.kind === "row")).toHaveLength(1);
  }, containerBudget(1));

  /**
   * ISC-172 PROVED BY ATTACK, which is the only way this criterion can be
   * proved at all. Everything else about the collector is a test of OUR code
   * doing what we meant; this is a test of what a hostile worker can still do
   * to the trail, run from inside the container with the worker's own uid and
   * the worker's own writable mount.
   *
   * The attack is the one the criterion names: the worker truncates its own
   * ledger. It runs `: >` (the redirect, which is `open(O_TRUNC)`) — not a
   * host-side `writeFile`, because the whole question is whether the thing
   * with write access to the mount can erase what has already been observed.
   *
   * THREE ASSERTIONS, AND THEY ARE NOT THE SAME CLAIM:
   *   1. the pre-truncation row is STILL IN THE COLLECTED COPY afterwards —
   *      custody survived the attack;
   *   2. a truncation MARK is present — the attack is recorded, not merely
   *      survived, so an operator can tell "quiet worker" from "worker that
   *      wiped its trail", which is the distinction ISC-125 will later need;
   *   3. the post-truncation row is collected too — the collector recovers and
   *      keeps following, rather than wedging on the offset it lost.
   * A collector that copied everything but noticed nothing would pass 1 and 3
   * and fail 2; one that detected the shrink and then gave up would pass 1 and
   * 2 and fail 3.
   *
   * WHAT IT DOES NOT PROVE, and the owner decision said so up front: TAIL AND
   * COPY loses rows written AND truncated between two passes. That window is
   * real, it is the accepted cost of not changing the transport, and no
   * assertion here should be read as closing it.
   */
  test("a worker that truncates its own ledger cannot erase what was collected", async () => {
    const root = await makeDaemonScratch("vgtrunc");
    scratches.push(root);
    const run = runPaths(`r-vgt-${process.pid.toString(36)}`, root);
    const worker = "eng-1";
    const outbox = workerOutboxDir(run.root, worker);
    // Same Linux ownership reason as the probe above and as `makeSandbox`.
    await mkdir(join(outbox, "ledger"), { recursive: true });
    await makeWorkerAccessible(outbox, true);
    await makeWorkerAccessible(join(outbox, "ledger"), true);

    const policy = join(root, "policy", "cloud-allow");
    await mkdir(join(root, "policy"), { recursive: true });
    await writeFile(policy, "kubectl rollout restart\n");
    await chmod(policy, 0o444);
    const mounts = ["-v", `${outbox}:/outbox`, "-v", `${policy}:/policy/cloud-allow:ro`];

    // Pass 1: one refused verb, then the host takes custody of it.
    await inImage(`${PRELUDE}\nkubectl delete pod first >/dev/null 2>&1 || true`, mounts);
    const collector = new VerbgateCollector(run);
    expect((await collector.collectOnce()).map((r) => r.worker)).toContain(worker);

    // THE ATTACK, from inside the container, as the worker uid. `: >` is
    // open(O_TRUNC) — the same call a worker would reach for to hide a verb.
    // The second verb after it is what a worker would do next, and it is also
    // what proves the collector did not simply stop.
    const out = await inImage(
      `${PRELUDE}\n: > /outbox/ledger/verbgate.jsonl; echo "truncated=$?"; ` +
        `wc -l < /outbox/ledger/verbgate.jsonl; ` +
        `kubectl delete pod second >/dev/null 2>&1 || true`,
      mounts,
    );
    // The attack must actually have landed, or the rest of this test is
    // asserting against a worker that never managed to truncate anything.
    expect(out).toContain("truncated=0");
    expect(out).toContain("0");

    await collector.collectOnce();
    const collected = await readCollectedVerbgate(run, worker);
    // `line` is the worker's own row, byte for byte, so the pod name in the
    // refused argv is what distinguishes the pre- from the post-attack row.
    const lines = collected.filter((r) => r.kind === "row").map((r) => r.line).join("\n");

    // 1 — the erased row is still in the host's copy.
    expect(lines).toContain("first");
    // 2 — and the erasure itself is on the record, with the reason that fired.
    const marks = collected.filter((r) => r.kind === "truncation");
    expect(marks).toHaveLength(1);
    // `tail_rewritten` SPECIFICALLY, not merely "some reason". This attack
    // defeats the other three by construction — the file regrew past the old
    // offset, the inode survived the in-place truncate, and verbgate's
    // second-granular timestamps make the two rows' first 64 bytes identical —
    // so asserting the generic mark would let the probe pass on a signal that
    // cannot fire here, which is how it read green before the frontier check
    // existed.
    expect(marks[0]?.reasons).toContain("tail_rewritten");
    // 3 — and collection continued past it.
    expect(lines).toContain("second");
  }, containerBudget(2));
});

/**
 * The reply plane's `:ro`, against a real mount (SRD-REVIEW-CONSOLE §6.4, D6).
 *
 * `test/unit/replies.test.ts` runs this same gate under `/bin/sh` with its
 * absolute paths re-rooted into a temp sandbox, and that is a sound probe of
 * the SCRIPT. It cannot be a probe of the MOUNT: the host harness has no `:ro`
 * to drop, because the process running it owns every path, so it emulates
 * read-only-ness with 0555 parent directories and says so in its header. That
 * establishes the loop reacts to a writable reply. It establishes nothing about
 * whether Docker's `:ro` is what makes the reply unwritable, which is the whole
 * claim `render.ts` makes when it appends the flag.
 *
 * The gap runs the wrong way on this platform, which is why it is worth closing
 * rather than assuming. The VM squashes bind-mount FILE ownership to the
 * container user, so a reply the host wrote 0444 appears inside the container
 * OWNED BY uid 10001 — and an owner may chmod. The MODE protects nothing here.
 * `:ro` is the only thing left, and the row below that mounts a 0644 reply
 * read-only is the one that says so.
 *
 * ORDER IS LOAD-BEARING. `the mount is real` runs first and is not setup: when
 * the daemon cannot see the host path it does not fail, it invents an EMPTY
 * directory at the mount source (ISC-288, and re-encountered while writing
 * this). Measured against a deliberately unshared scratch root, THREE of these
 * rows still passed on the empty mount and only the anti-vacuity check and the
 * 78 row went red. Without the first test this block would report a property it
 * never observed.
 *
 * ## Two corrections, and the second is why the rows are worded as they are
 *
 * **The fixture used production's mode only by accident, and got it wrong.** The
 * helper below opened the directory to 0777 (`makeWorkerAccessible(dir, true)`),
 * where `createRepliesDir` gives 0755. 0777 grants "other" write, so on LINUX —
 * where a bind mount passes host ownership through untouched and uid 10001 is
 * "other" — the dropped-`:ro` row went 78 on a permission production never
 * grants. It called the production mode by calling `createRepliesDir` now, which
 * is what these rows must be measured against or they are measuring the harness.
 *
 * **With the real mode, the 78 outcome is PLATFORM-SPECIFIC, and asserting it
 * unconditionally would be false on CI.** Measured at uid 10001 with a 0755
 * directory bind-mounted read-write: macOS answers `access(W_OK)` TRUE on the
 * mount point regardless of its mode and root ownership, because the VM's shared
 * filesystem answers rather than ordinary DAC; Linux answers false, because uid
 * 10001 is "other" against a 0755 directory the runner owns.
 *
 * That is not a hole in the gate, and the rows do not paper over it — it is
 * coherent, and stating it is what makes them honest. On Linux a dropped `:ro`
 * does not GRANT the worker write in the first place, so there is nothing for
 * the gate to catch. The invariant that holds on both is therefore the one the
 * rows assert: **a reply plane the worker can actually write is a reply plane
 * that costs it every gated verb.** Each row measures the worker's real write
 * capability in the container and asserts the exit code that must accompany it,
 * so neither platform gets a hard-coded answer and a daemon whose behaviour
 * changed would fail here rather than silently invert the claim.
 */
describe.skipIf(!DOCKER)("the reply plane is held read-only by the mount, not by the mode", () => {
  /** The gate's own codes: 77 = verb declined, 78 = a gated surface is writable. */
  const REFUSED = 77;
  const POLICY_WRITABLE = 78;

  /**
   * A `/replies` holding one reply at `mode`, shaped the way the actor leaves it.
   *
   * `createRepliesDir` and NOT `makeWorkerAccessible(dir, true)`: the production
   * directory is 0755, and the 0777 this used to set is the difference between
   * probing the shipped surface and probing a wider one that happens to make the
   * assertions convenient. See the block header.
   */
  async function replies(mode: number): Promise<string> {
    const dir = await makeDaemonScratch("verbgate-replies");
    scratches.push(dir);
    await createRepliesDir(dir);
    const file = join(dir, "T-arch.json");
    await writeFile(file, `${JSON.stringify({ status: "success" }, null, 2)}\n`);
    await chmod(file, mode);
    return dir;
  }

  /**
   * Whether the WORKER can actually write the reply plane, measured by trying it
   * inside the container as uid 10001 rather than by reasoning about modes.
   *
   * This is the antecedent of every conditional row below, and measuring it
   * beats deriving it from `process.platform`: a platform check encodes today's
   * belief about Docker, while this reads what the daemon in front of us does.
   */
  async function workerCanWriteReplies(dir: string): Promise<boolean> {
    const out = await inImage(
      `if touch /replies/forged.json 2>/dev/null; then echo CAN_WRITE; else echo READ_ONLY; fi`,
      ["-v", `${dir}:/replies`],
    );
    return out.includes("CAN_WRITE");
  }

  /**
   * A verb no allow list contains, so a gate whose integrity loop PASSED lands
   * on 77 rather than on success. Deliberately a destructive one: if the gate
   * ever failed open, this exits 0 against a real `gcloud` rather than quietly
   * looking like a pass.
   */
  const DENIED = "gcloud compute instances delete pifleet-nonexistent";

  async function gateExit(replyMount: string[]): Promise<number> {
    const sb = await makeSandbox();
    const p = Bun.spawn(
      ["docker", "run", "--rm", ...sb.mounts, ...replyMount,
       "--entrypoint", "bash", IMAGE, "-c", `${PRELUDE}\n${DENIED}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    return await p.exited;
  }

  test("the mount is real — without this every row below is green on an empty mount", async () => {
    const dir = await replies(0o444);
    const seen = await inImage("ls -1 /replies", ["-v", `${dir}:/replies:ro`]);
    expect(seen.trim()).toBe("T-arch.json");
  }, containerBudget(1));

  test("CONTROL: :ro with a 0444 reply leaves the gate intact — the verb is merely declined", async () => {
    const dir = await replies(0o444);
    expect(await gateExit(["-v", `${dir}:/replies:ro`])).toBe(REFUSED);
  }, containerBudget(1));

  test(":ro holds a 0644 reply read-only, which the mode alone does NOT do here", async () => {
    const dir = await replies(0o644);
    expect(await gateExit(["-v", `${dir}:/replies:ro`])).toBe(REFUSED);
  }, containerBudget(1));

  /**
   * THE ROW THE PLANE'S `:ro` EXISTS FOR, stated as the invariant that holds on
   * both platforms rather than as one platform's answer.
   *
   * A writable reply plane is a collator authoring the evidence it is about to
   * quote, so it must cost the worker every gated verb. Where a dropped `:ro`
   * does NOT make the plane writable — Linux, where host ownership passes
   * through and uid 10001 is "other" against a 0755 directory — there is nothing
   * to catch and 77 is the correct answer, not a miss.
   *
   * Both branches assert. Neither is a skip, and the antecedent is measured in
   * the same container shape the gate then runs in, so a daemon that changed its
   * behaviour flips which branch runs instead of quietly falsifying the claim.
   */
  test("a reply plane the worker can write costs it every verb; one it cannot, does not", async () => {
    // HALF ONE — the production directory mode with `:ro` dropped. Whether that
    // is writable to uid 10001 is the platform-dependent half: the macOS VM
    // answers W_OK true on a read-write mount point regardless of its mode and
    // root ownership, Linux answers false because host ownership passes through.
    // So the writability is MEASURED and the exit code asserted against it.
    const dropped = await replies(0o644);
    const writable = await workerCanWriteReplies(dropped);
    expect(await gateExit(["-v", `${dropped}:/replies`])).toBe(
      writable ? POLICY_WRITABLE : REFUSED,
    );

    // HALF TWO — the same read-write mount over a directory closed to 0555,
    // which the worker cannot write on EITHER platform. Measured: on this VM a
    // 0555 host directory bind-mounted read-write reads `[ -w ] -> false` and
    // `touch` fails, where the 0755 above reads true.
    //
    // This half exists so the "cannot write, therefore 77" branch RUNS
    // everywhere instead of only on Linux. Without it each platform exercises
    // one branch and neither exercises both, which is how the row this replaces
    // came to assert 78 unconditionally and would have gone red on CI.
    const closed = await replies(0o444);
    await chmod(closed, 0o555);
    try {
      expect(await workerCanWriteReplies(closed)).toBe(false);
      expect(await gateExit(["-v", `${closed}:/replies`])).toBe(REFUSED);
    } finally {
      // Reopened for `afterEach`: `rm -rf` cannot unlink through a 0555 parent,
      // and a cleanup failure would be reported against whichever test ran next.
      await chmod(closed, 0o755);
    }
  }, containerBudget(4));

  test("a fleet with no reply plane at all is unaffected by the new loop entry", async () => {
    expect(await gateExit([])).toBe(REFUSED);
  }, containerBudget(1));

  test("on a read-write plane the mode is never the control — ownership or :ro is", async () => {
    /*
     * The platform fact the rows above rest on, asserted rather than commented,
     * and asserted as a DISJUNCTION because the two platforms reach it by
     * different routes and hard-coding either one breaks the other's CI:
     *
     *   macOS — the VM squashes bind-mount FILE ownership to the container user,
     *   so the worker OWNS a reply the host wrote 0444, and an owner may chmod.
     *   The mode is decorative and `:ro` is the entire control.
     *
     *   Linux — host ownership passes through, the worker is "other", and 0444
     *   denies it. That is OWNERSHIP doing the work, still not the mode, and
     *   still not something a dropped `:ro` would have taken away.
     *
     * Either way the conclusion the block's header depends on holds: nothing
     * here is protected by the 0444 itself. A Docker release that stopped
     * squashing would move this from the first branch to the second rather than
     * making the surrounding rows silently tautological.
     */
    const dir = await replies(0o444);
    const out = await inImage(
      `stat -c '%u' /replies/T-arch.json; ` +
        `if chmod 0644 /replies/T-arch.json 2>/dev/null; then echo CHMOD_OK; else echo CHMOD_DENIED; fi`,
      ["-v", `${dir}:/replies`],
    );
    const [owner, chmodResult] = out.trim().split("\n");
    if (owner === String(WORKER_UID)) {
      expect(chmodResult).toBe("CHMOD_OK");
    } else {
      expect(chmodResult).toBe("CHMOD_DENIED");
    }
  }, containerBudget(1));
});
