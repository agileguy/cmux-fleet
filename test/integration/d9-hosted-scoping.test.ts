/**
 * D9's scoping is ENFORCED, not defaulted (ISC-427, SRD-INFERENCE-PROVIDERS §6.7).
 *
 * §6.7 relaxes the IP-literal rule for `hosted: true` providers only, and it is
 * explicit that the scoping is the whole of the decision: *"a non-hosted
 * provider's block still refuses a hostname at `config validate`, so the
 * stronger property is not merely the default — it is enforced, and an operator
 * cannot opt their oMLX into the weaker one by editing a field."*
 *
 * ## Why this is a PAIR and not a refusal test
 *
 * The obvious probe — write a hostname on a `hosted: false` block, assert the
 * refusal — is worthless on its own, and worthless in a way that is easy to
 * miss because it is GREEN. It passes identically against a validator that
 * refuses hostnames EVERYWHERE, including on the hosted blocks D9 exists to
 * permit. That validator satisfies this criterion's letter while breaking
 * ISC-426 outright, and a suite in which both are green would report D9 as
 * built while the feature does not exist.
 *
 * So the assertion is DIFFERENTIAL: the same `relay_upstream` hostname is
 * refused on one document and accepted on the other, and `hosted` is the only
 * thing that differs between them. The refusal alone proves a rule exists; the
 * pair proves the rule is SCOPED, which is the sentence §6.7 actually makes.
 *
 * ## Why the one-line diff is asserted rather than described
 *
 * "Flipping `hosted` is the ONLY edit that changes the verdict" is a claim
 * about the two INPUTS, and a comment asserting it decays the first time
 * someone edits one fixture and not the other — at which point the pair still
 * passes and no longer discriminates anything, because the two documents could
 * by then differ in the field that actually caused the refusal. Both documents
 * are therefore rendered from ONE template with a single substitution, and the
 * test asserts a one-line diff whose two sides are the `hosted` line. The
 * discriminating property is then checked by the machine, not promised by prose.
 *
 * ## Why this drives the real binary
 *
 * The criterion says "at `config validate`", and the verb is load-bearing. A
 * unit test on the schema proves the refinement refuses; it does not prove
 * `config validate` ever REACHES that refinement for a `providers` map. That
 * exact gap is on record in this tree — `cli-exit-codes.test.ts` documents
 * ISC-402, where `validate` loaded the document and stopped, printing `ok:` for
 * configs `up` then refused. The operator-visible fact is the exit code, so the
 * exit code is what is asserted.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { cliBudget } from "../support/budget.ts";
import { spawnCli } from "../support/spawn-cli.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * The one hostname both documents carry.
 *
 * A reserved documentation name, on the rule `fleet.example.yaml` states for
 * `egress.allow`: it resolves nowhere, so nothing here can reach a real host
 * even if a future edit made this fixture do more than parse. It also must NOT
 * be an mDNS/`.local` name — the refusal message mentions those, and a fixture
 * that used one would leave "is it refused for being a hostname, or for being
 * unresolvable?" open, which is the ambiguity this pair exists to remove.
 */
const UPSTREAM_NAME = "inference.example.com";

/**
 * Render a full, otherwise-valid fleet document whose single provider block
 * differs only in `hosted`.
 *
 * Built from `fleet.example.yaml` by REPLACING the whole `llm:` block rather
 * than patching lines into it, because the flat keys and a `providers` map are
 * two spellings of one value (§6.1) and the schema refuses a document carrying
 * both. Splicing `providers:` in beside the example's flat `base_url` produces
 * three collision errors and a test that would go green on the wrong refusal.
 */
async function renderConfig(hosted: boolean): Promise<string> {
  const lines = (await readFile(join(REPO_ROOT, "fleet.example.yaml"), "utf8")).split("\n");
  const llmStart = lines.findIndex((l) => l.startsWith("llm:"));
  const llmEnd = lines.findIndex((l) => l.startsWith("cloud:"));
  if (llmStart === -1 || llmEnd === -1 || llmEnd <= llmStart) {
    throw new Error("fleet.example.yaml no longer has an `llm:` block followed by `cloud:`");
  }
  const llm = [
    "llm:",
    "  provider: omlx",
    "  model: Qwen3-Coder-30B-A3B-Instruct-4bit",
    "  thinking: medium",
    "  require_native_tool_calls: true",
    "  providers:",
    "    omlx:",
    `      hosted: ${hosted}`,
    "      base_url: http://omlx.pifleet.internal:8000/v1",
    "      api_key_env: OMLX_API_KEY",
    `      relay_upstream: ${UPSTREAM_NAME}:443`,
    "      models_allowlist:",
    "        - Qwen3-Coder-30B-A3B-Instruct-4bit",
    "",
  ];
  return [...lines.slice(0, llmStart), ...llm, ...lines.slice(llmEnd)].join("\n");
}

describe("D9 scoping is enforced, not defaulted (ISC-427)", () => {
  /**
   * `cliBudget(2)` — two spawns, one per document. Both are `config validate`
   * on a static file: no daemon, no container, no network, so the whole cost is
   * this project's CLI startup, which is precisely what `cliBudget` models.
   */
  test(
    "the same hostname relay_upstream is REFUSED on hosted:false and ACCEPTED on hosted:true",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pifleet-d9-"));
      try {
        const nonHostedDoc = await renderConfig(false);
        const hostedDoc = await renderConfig(true);

        // The discriminator, checked rather than claimed: these two documents
        // differ on exactly one line, and that line is `hosted`. Without this,
        // the pair below could be passing because of some OTHER difference and
        // would silently stop testing the scoping.
        const a = nonHostedDoc.split("\n");
        const b = hostedDoc.split("\n");
        expect(a.length).toBe(b.length);
        const differing = a.map((l, i) => [i, l, b[i]] as const).filter(([, l, r]) => l !== r);
        expect(differing.length).toBe(1);
        expect(differing[0]![1].trim()).toBe("hosted: false");
        expect(differing[0]![2]!.trim()).toBe("hosted: true");

        const nonHostedPath = join(dir, "non-hosted.yaml");
        const hostedPath = join(dir, "hosted.yaml");
        await writeFile(nonHostedPath, nonHostedDoc);
        await writeFile(hostedPath, hostedDoc);

        // HALF ONE — the operator's own oMLX keeps the stronger property. The
        // field is NAMED, because "2 validation errors" tells an operator
        // nothing about which line to edit.
        const refused = await spawnCli(["config", "validate", "-c", nonHostedPath], {
          cwd: REPO_ROOT,
        });
        expect(refused.code).toBe(EXIT.USAGE);
        expect(refused.stderr).toContain("relay_upstream");
        expect(refused.stderr).toContain(UPSTREAM_NAME);
        expect(refused.stderr).toContain("is a hostname");

        // HALF TWO — and this is the half that makes the criterion discriminate.
        // A validator that refused hostnames everywhere would pass HALF ONE and
        // fail here, which is the whole reason both are in one test: they cannot
        // be separated, skipped, or left half-written.
        const accepted = await spawnCli(["config", "validate", "-c", hostedPath], {
          cwd: REPO_ROOT,
        });
        expect(accepted.code).toBe(EXIT.SUCCESS);
        expect(accepted.stderr).not.toContain("is a hostname");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    cliBudget(2),
  );
});
