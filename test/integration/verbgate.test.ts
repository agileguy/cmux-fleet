/**
 * verbgate behaviour, probed against a real built image (SRD §5.10).
 *
 * These run only with a Docker daemon and a built worker image. They are gated
 * rather than deleted because the gate's whole value is what it does in a real
 * container — a mocked version of this test would assert on our own beliefs.
 */

import { describe, expect, test } from "bun:test";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] verbgate integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

/** Run a shell script inside the worker image and return its stdout. */
async function inImage(script: string): Promise<string> {
  const p = Bun.spawn(["docker", "run", "--rm", "--entrypoint", "bash", IMAGE, "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/**
 * Preamble giving each script a task-scoped allow file and a private ledger.
 * `kubectl rollout restart` is the one authorized mutating verb.
 */
const PRELUDE = `
mkdir -p /tmp/ob/ledger
export PIFLEET_VERBGATE_LEDGER=/tmp/ob/ledger/v.jsonl
export PIFLEET_CLOUD_ALLOW_FILE=/tmp/ob/allow
export PIFLEET_TASK_ID=T-004 PIFLEET_EPOCH=1
printf 'kubectl rollout restart\\n' > /tmp/ob/allow
`;

describe.skipIf(!DOCKER)("verbgate", () => {
  // ISC-103
  test("a read verb passes through to the real binary", async () => {
    const out = await inImage(`${PRELUDE}\nkubectl version --client >/dev/null 2>&1; echo "rc=$?"`);
    expect(out).toContain("rc=0");
  });

  // ISC-104
  test("a mutating verb absent from cloud_allow exits 77", async () => {
    const out = await inImage(`${PRELUDE}\nkubectl delete deployment web >/dev/null 2>&1; echo "rc=$?"`);
    expect(out).toContain("rc=77");
  });

  // ISC-105 — a non-77 code means the gate handed off; the real binary then
  // fails for its own reasons (no cluster), which is not the gate's business.
  test("a mutating verb named in cloud_allow reaches the real binary", async () => {
    const out = await inImage(
      `${PRELUDE}\nkubectl rollout restart deployment/web >/dev/null 2>&1; echo "rc=$?"`,
    );
    expect(out).not.toContain("rc=77");
  });

  // Matching on verb tokens rather than the whole command line is what makes
  // this pointless; a substring match would be defeated by the reordering.
  test("a verb hidden behind leading flags fails closed", async () => {
    const out = await inImage(
      `${PRELUDE}\nkubectl --namespace prod delete deployment web >/dev/null 2>&1; echo "rc=$?"`,
    );
    expect(out).toContain("rc=77");
  });

  test("helm and gcloud are gated on the same rules as kubectl", async () => {
    const out = await inImage(
      `${PRELUDE}
       helm uninstall api >/dev/null 2>&1; echo "helm=$?"
       helm list >/dev/null 2>&1; echo "helm_read=$?"
       gcloud compute instances delete vm-1 >/dev/null 2>&1; echo "gcloud=$?"`,
    );
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
    const out = await inImage(
      `${PRELUDE}
       kubectl version --client >/dev/null 2>&1
       kubectl delete deployment web >/dev/null 2>&1
       kubectl --namespace prod delete deployment web >/dev/null 2>&1
       kubectl rollout restart deployment/web --timeout=30s >/dev/null 2>&1
       helm uninstall api >/dev/null 2>&1
       wc -l < /tmp/ob/ledger/v.jsonl`,
    );
    expect(Number(out.trim())).toBe(5);
  });

  // ISC-106
  test("a permitted mutating verb is recorded with task id and argv", async () => {
    const out = await inImage(
      `${PRELUDE}
       kubectl rollout restart deployment/web --timeout=30s >/dev/null 2>&1
       jq -c 'select(.decision=="allow_listed") | {task_id, epoch, verb, argv}' /tmp/ob/ledger/v.jsonl`,
    );
    const row = JSON.parse(out.trim());
    expect(row.task_id).toBe("T-004");
    expect(row.epoch).toBe(1);
    expect(row.verb).toBe("rollout restart deployment/web");
    expect(row.argv).toContain("--timeout=30s");
  });

  test("refusal names the verb and the task so the block is actionable", async () => {
    const p = Bun.spawn(
      ["docker", "run", "--rm", "--entrypoint", "bash", IMAGE, "-c", `${PRELUDE}\nkubectl delete deployment web`],
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

  // ISC-25, ISC-38
  test("runs as uid 10001 under tini", async () => {
    const out = await inImage(`id -u; readlink -f /usr/bin/tini`);
    expect(out).toContain("10001");
    expect(out).toContain("/usr/bin/tini");
  });
});
