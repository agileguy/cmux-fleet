/**
 * The supervisor -> entrypoint channel that produces `~/.pi/agent/models.json`,
 * asserted as a JOIN rather than as two independent halves.
 *
 * `run/worker-env.ts` decides what the worker's environment says, `config/
 * render.ts` decides what Pi's argv says, and `docker/entrypoint.sh` turns the
 * environment into the file Pi reads its provider configuration out of. Nothing
 * in the repo made those three agree, and two of them silently disagreed:
 *
 *   ISC-401 (Defect B) `render.ts` put the WORKER'S RESOLVED provider on
 *                      `pi --provider` while `worker-env.ts` put the FLEET-WIDE
 *                      one in `PIFLEET_LLM_PROVIDER`, which is the provider KEY
 *                      the entrypoint writes. A `provider/`-prefixed model
 *                      launched Pi naming a provider its own models.json did
 *                      not define.
 *   ISC-406 (Defect A) the entrypoint read the credential under a hardcoded
 *                      `${OMLX_API_KEY:-}` while `worker-env.ts` writes it under
 *                      `llm.api_key_env`, whatever the operator configured.
 *
 * Both are the same failure shape, and it is the shape that decides how these
 * tests are written. With ONE provider configured and the default variable name
 * the two sides agree BY COINCIDENCE — the same coincidence `relayGatePolicy`
 * was caught in by ISC-264 — so a test that pins either side to a constant is
 * green against the broken code. What is asserted here is that the two rendered
 * strings MATCH, with the expected value anchored separately to the literal a
 * human wrote in `fleet.yaml`. Mutating either side alone breaks the match;
 * mutating both breaks the anchor.
 *
 * ## D8 (SRD-INFERENCE-PROVIDERS §6.6) — the credential channel is now a FILE
 *
 * ISC-406's fix made the entrypoint follow `PIFLEET_LLM_API_KEY_ENV` to the
 * variable holding the value. D8 deletes that indirection rather than repairing
 * it: the value is written to `/secrets/<NAME>` at `0444` and the environment
 * carries `PIFLEET_LLM_API_KEY_FILE`, a fleet-owned FIXED name holding a PATH.
 *
 * **That is what makes Defect A permanent rather than patched**, and it is why
 * the two `api_key_env`-reaches-`apiKey` tests below were REPLACED rather than
 * kept alongside the new ones. Keeping an environment read as a fallback would
 * resurrect the defect the moment the pointer failed to arrive — the entrypoint
 * would silently read a different variable and render `apiKey: ""`, exit 0,
 * nothing on stderr. The name must stop participating, so it is asserted to
 * stop participating: `the credential no longer travels in the environment at
 * all` hands the entrypoint a fully-populated environment channel and requires
 * an EMPTY key out of it.
 *
 * The three failure branches — absent, empty, malformed pointer — are LOUD, per
 * SRD §5.9's standing doctrine (`config validate` refuses a bad `relay_upstream`
 * "so the failure becomes a sentence instead"). The reasoning is in the
 * entrypoint's own comment; what these tests pin is that the sentence and the
 * non-zero exit both actually happen, and that `models.json` is not written.
 *
 * ## Why the real script, and the real env plan
 *
 * These run `docker/entrypoint.sh` itself under the host's bash with `HOME`
 * redirected — the harness `entrypoint-theme.test.ts` and
 * `entrypoint-pane-mode.test.ts` use, and for the same reason: the property is
 * a property of the script's control flow, not of Docker. Re-implementing the
 * `jq -n` here would re-encode the very assumption that was wrong, and a fixture
 * environment written by hand would agree with the entrypoint by construction.
 * So the environment comes from `buildWorkerEnv` and the argv from
 * `buildPiArgv`: every string under test is one a real `up` would produce.
 *
 * `PIFLEET_HONEYPOT` is the one variable dropped from the plan before spawning,
 * and it is dropped rather than overridden so a reader sees the deletion. The
 * plan sets it to "1" for every worker (ISC-125), which makes the entrypoint
 * start `/usr/local/bin/pifleet-honeypot` and treat its death as fatal — on a
 * host that binary does not exist, so the script would poll for a socket and
 * `exit 71` ten seconds later. That is the supervisor at the bottom of the file;
 * everything under test here has already run by then.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stringify } from "yaml";

import { LlmSchema } from "../../src/config/schema.ts";
import { parseConfig, resolveWorker } from "../../src/config/load.ts";
import { buildPiArgv } from "../../src/config/render.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRYPOINT = join(REPO_ROOT, "docker", "entrypoint.sh");

const dirs: string[] = [];
afterAll(async () => {
  // chmod back before rm: the unreadable-file case leaves a 0000 file, and on a
  // non-root runner `rm -r` cannot traverse into a directory it cannot read.
  await Promise.all(
    dirs.splice(0).map(async (d) => {
      await chmod(d, 0o755).catch(() => {});
      await rm(d, { recursive: true, force: true });
    }),
  );
});

/**
 * A credential file on disk, standing in for what `materialize.ts` writes into
 * `WorkerPaths.secretsDir` and Docker mounts read-only at `/secrets`.
 *
 * NO TRAILING NEWLINE, and that is a property of the real writer rather than a
 * convenience here: `writeWorkerSecretFiles` writes "the RAW value and NOTHING
 * ELSE — no trailing newline, deliberately", because the documented
 * `skills/ticket-ops` call concatenates those bytes into a `curl --config`
 * header line. A fixture that added one would let a `read`-based entrypoint pass
 * a test the real mount would fail.
 */
async function keyFile(
  value: string,
  opts: { name?: string; mode?: number } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-cred-"));
  dirs.push(dir);
  const path = join(dir, opts.name ?? "OMLX_API_KEY");
  await writeFile(path, value);
  if (opts.mode !== undefined) await chmod(path, opts.mode);
  return path;
}

function baseDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "models-json-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel" },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
    ...over,
  };
}

interface ModelsJson {
  providers: Record<string, { name: string; baseUrl: string; apiKey: string; models: unknown[] }>;
}

/**
 * What one worker's `up` would actually produce, on both sides of the join.
 *
 * `hostEnv` is a parameter rather than `process.env` because `buildWorkerEnv`
 * is pure in it — the renamed-credential case needs a host that has
 * `OLLAMA_API_KEY` and emphatically does NOT have `OMLX_API_KEY`, and mutating
 * the real process environment to get that would leak between tests.
 */
async function render(
  doc: Record<string, unknown>,
  hostEnv: Record<string, string | undefined>,
  /**
   * Written over the plan's own vars, AFTER `buildWorkerEnv` produced them.
   *
   * This is how the D8 pointer arrives. `buildWorkerEnv` does not yet emit
   * `PIFLEET_LLM_API_KEY_FILE` — the host half of D8 is a separate change — so
   * the container half is exercised the way the entrypoint will actually meet
   * it: a fleet-owned name carrying a path, written over a real plan.
   *
   * It is also the only way left to hand the entrypoint a BAD pointer.
   * `config/schema.ts` refuses a malformed or reserved `api_key_env` at parse
   * time, so a doc cannot carry one this far, and the path guard is defence in
   * depth for the same reason the identifier guard was: the entrypoint reads an
   * ENVIRONMENT VARIABLE, not config, so a hand-assembled env file, a future
   * harness, or a supervisor bug can still hand it anything at all.
   */
  envOverride: Record<string, string> = {},
): Promise<{ argvProvider: string; models: ModelsJson | null; code: number; stderr: string }> {
  const loaded = await parseConfig(stringify(doc), "/tmp/fleet.yaml");
  const w = resolveWorker(loaded, "w1");
  const plan = buildWorkerEnv(loaded, w, hostEnv);

  const argv = buildPiArgv(w, false);
  const argvProvider = argv[argv.indexOf("--provider") + 1] ?? "";

  const dir = await mkdtemp(join(tmpdir(), "pifleet-modelsjson-"));
  dirs.push(dir);
  await mkdir(join(dir, ".pi", "agent"), { recursive: true });

  // Exits immediately: this file is about what the script wrote BEFORE the
  // launch, so the worker only has to not hang.
  const standIn = join(dir, "stand-in.sh");
  await writeFile(standIn, "#!/bin/sh\nexit 0\n");
  await chmod(standIn, 0o755);

  // Bun replaces the environment wholesale rather than merging, which is `env
  // -i` — and that is the point of §2.2's probe: nothing from the developer's
  // shell can supply a credential the supervisor did not deliver.
  const { PIFLEET_HONEYPOT: _dropped, ...planVars } = plan.vars;
  const env: Record<string, string> = {
    ...planVars,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: dir,
    PIFLEET_WORKER_BIN: standIn,
    ...envOverride,
  };

  const p = Bun.spawn(["bash", ENTRYPOINT], {
    env,
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  const raw = await readFile(join(dir, ".pi", "agent", "models.json"), "utf8").catch(() => null);
  return { argvProvider, models: raw === null ? null : (JSON.parse(raw) as ModelsJson), code, stderr };
}

describe("ISC-401: the resolved provider reaches Pi's argv AND models.json", () => {
  /**
   * THE ASSERTION THIS FILE WAS WRITTEN FOR.
   *
   * `ollama/gpt-oss:120b-cloud` is the SRD's own measured example, and the tag
   * matters: `120b-cloud` is not one of the six `ThinkingLevel` words, so
   * `decomposeModel` leaves it on the model id and this case exercises the
   * provider prefix without also tripping Defect C.
   *
   * Before the fix, measured: `--provider ollama` on the argv and `"omlx"` as
   * the only key in models.json. The prefix resolved to the flag and stopped.
   *
   * Three assertions, and none of them is redundant:
   *   - the two rendered strings match          (mutating EITHER side fails)
   *   - each equals the literal from fleet.yaml (mutating BOTH fails)
   * A single `toBe("ollama")` on one side would be green against the code that
   * shipped, because that side was never the broken one.
   */
  test("a provider/-prefixed model names one provider on both sides", async () => {
    const r = await render(
      baseDoc({ roles: { eng: { model: "ollama/gpt-oss:120b-cloud" } } }),
      { OMLX_API_KEY: "KEY-FOR-SELF-HOSTED" },
    );
    expect(r.models).not.toBeNull();
    const keys = Object.keys(r.models!.providers);
    expect(keys).toHaveLength(1);

    // The join: what Pi is launched naming, and what Pi's own config defines.
    expect(keys[0]).toBe(r.argvProvider);
    // The anchor: the provider the operator actually wrote, derived by neither
    // code path under test.
    expect(r.argvProvider).toBe("ollama");
    expect(keys[0]).toBe("ollama");

    // The prefix is consumed, not carried into the model id.
    expect(r.models!.providers["ollama"]!.models).toEqual([
      { id: "gpt-oss:120b-cloud", name: "gpt-oss:120b-cloud" },
    ]);
  });

  /**
   * The control, and the reason the test above cannot be replaced by it.
   *
   * With no prefix the two sides agree at "omlx" — which they did before the
   * fix as well. This is a regression guard for the common fleet, not a probe
   * of the defect, and saying so here keeps a future reader from mistaking it
   * for one.
   */
  test("an unprefixed model still agrees at the fleet-wide provider", async () => {
    const r = await render(baseDoc(), { OMLX_API_KEY: "KEY-FOR-SELF-HOSTED" });
    const keys = Object.keys(r.models!.providers);
    expect(keys[0]).toBe(r.argvProvider);
    expect(r.argvProvider).toBe("omlx");
  });
});

describe("D8/§6.6: models.json carries the key read from PIFLEET_LLM_API_KEY_FILE", () => {
  /**
   * THE ASSERTION D8 EXISTS FOR: the file's contents reach `apiKey`.
   *
   * §2.2's probe, inverted again and through the new channel. `hostEnv` is
   * EMPTY — no credential exists anywhere in the environment — so the only way
   * a non-empty key can appear in `models.json` is if the entrypoint opened the
   * file and read it. Bun replaces the environment wholesale (`env -i`), so
   * nothing from the developer's shell can supply one either.
   *
   * The value is deliberately not a plausible key: if this string appears, it
   * came from the file this test wrote and from nowhere else.
   */
  test("the credential is read from the file the pointer names", async () => {
    const path = await keyFile("KEY-FROM-THE-FILE");
    const r = await render(baseDoc(), {}, { PIFLEET_LLM_API_KEY_FILE: path });
    expect(r.code).toBe(0);
    expect(r.models).not.toBeNull();
    const provider = r.models!.providers["omlx"]!;
    expect(provider.apiKey).not.toBe("");
    expect(provider.apiKey).toBe("KEY-FROM-THE-FILE");
  });

  /**
   * DEFECT A IS GONE RATHER THAN MOVED, and this is the test that says so.
   *
   * The environment channel is fully populated — `buildWorkerEnv` writes
   * `OMLX_API_KEY=KEY-FROM-THE-ENVIRONMENT` and `PIFLEET_LLM_API_KEY_ENV=
   * OMLX_API_KEY`, exactly what a real `up` produces today — and there is NO
   * pointer. A correct D8 entrypoint renders an EMPTY key from that.
   *
   * Asserting the absence is the only way to keep the fix permanent. A read
   * that consults the file first and the environment second would pass every
   * other test in this describe and quietly restore the defect: the day the
   * pointer failed to arrive on a path that should set it, the entrypoint would
   * fall back to a variable that happens to be present and authenticate the
   * worker with the wrong credential — a 401 strictly harder to diagnose than
   * the empty-key one ISC-406 fixed.
   */
  test("the credential no longer travels in the environment at all", async () => {
    const r = await render(baseDoc(), { OMLX_API_KEY: "KEY-FROM-THE-ENVIRONMENT" });
    expect(r.code).toBe(0);
    expect(r.models).not.toBeNull();
    expect(r.models!.providers["omlx"]!.apiKey).toBe("");
  });

  /**
   * …and the operator's chosen NAME does not participate either, even when it
   * is present and holds a different value.
   *
   * This is the sharper arm of the test above: the pointer IS set and correct,
   * and the environment simultaneously offers a renamed credential the old code
   * path would have followed. The file has to win outright. An implementation
   * that preferred the environment, or that concatenated the two, is red here
   * while the previous test could still be green.
   */
  test("a populated api_key_env cannot override the file", async () => {
    const path = await keyFile("KEY-FROM-THE-FILE");
    const r = await render(
      baseDoc({ llm: { model: "TestModel", api_key_env: "OLLAMA_API_KEY" } }),
      { OLLAMA_API_KEY: "KEY-FROM-THE-ENVIRONMENT" },
      { PIFLEET_LLM_API_KEY_FILE: path },
    );
    expect(r.code).toBe(0);
    expect(r.models!.providers["omlx"]!.apiKey).toBe("KEY-FROM-THE-FILE");
  });

  /**
   * The credential does not travel twice — asserted as a PROPERTY, so §6.6 does
   * not have to rewrite it.
   *
   * ISC-31 is "`docker inspect` shows no cloud provider key in any container's
   * environment (only `OMLX_API_KEY`)". The shortest fix for the test above —
   * ALSO exporting the key under a fixed fleet-owned alias so the entrypoint
   * could keep reading a literal — puts one credential in the environment under
   * two names, doubling the surface of every `env` dump and crash
   * serialisation. That is why the channel carries a NAME instead, and this is
   * what stops the alias from being reintroduced quietly.
   *
   * "AT MOST ONE", not "exactly one", and the inequality is the whole point of
   * writing it this way. Today the count is 1. Under §6.6's D8 the key moves to
   * a `0444` file on the read-only `/secrets` mount with only
   * `PIFLEET_LLM_API_KEY_FILE` pointing at it, and the count becomes 0 — which
   * is ISC-407, a criterion this change does NOT satisfy and is not trying to.
   * Pinning `["OLLAMA_API_KEY"]` here would make this test fail on the day the
   * property it asserts gets STRONGER.
   *
   * Nothing about the pointer's spelling is asserted anywhere in this file for
   * the same reason: `PIFLEET_LLM_API_KEY_ENV` is a mechanism with a scheduled
   * replacement, and every other test here goes through the rendered
   * `models.json`, which D8 leaves unchanged.
   */
  test("at most one variable in the plan holds the credential value (ISC-31)", async () => {
    const loaded = await parseConfig(
      stringify(baseDoc({ llm: { model: "TestModel", api_key_env: "OLLAMA_API_KEY" } })),
      "/tmp/fleet.yaml",
    );
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w1"), {
      OLLAMA_API_KEY: "KEY-FOR-RENAMED",
    });
    const holdingTheValue = Object.entries(plan.vars)
      .filter(([, v]) => v === "KEY-FOR-RENAMED")
      .map(([k]) => k);
    expect(holdingTheValue.length).toBeLessThanOrEqual(1);
  });

  /**
   * A KEYLESS FLEET IS A SUPPORTED CONFIGURATION, and the absent POINTER is how
   * it is expressed. This is the distinction the whole failure design turns on.
   *
   * A local oMLX with no credential is legitimate — SRD §5.9's own default
   * shape — and `worker-env.ts` already states the convention for it: it "omits
   * the variable entirely rather than writing it blank". Under D8 the analogue
   * is to omit the POINTER. So an absent pointer means "no credential was
   * configured", renders an empty key, and exits 0.
   *
   * It is also the shape the non-supervisor callers take. `image verify` and
   * the acceptance containers run this script with no worker env file at all,
   * and `test/integration/image.test.ts` exercises exactly that. If an absent
   * pointer were fatal, `image verify` would stop working.
   *
   * A pointer that IS set and cannot be honoured is the opposite event and is
   * treated as such below: it means the host wrote a promise it did not keep.
   */
  test("no pointer at all is a keyless fleet, not a failure", async () => {
    const r = await render(baseDoc(), {});
    expect(r.code).toBe(0);
    expect(r.models!.providers["omlx"]!.apiKey).toBe("");
  });

  /**
   * THE ABSENT-FILE DECISION, pinned in both directions.
   *
   * A pointer naming a file that is not there is not "no credential" — it is
   * the host side failing to write what its own environment says it wrote.
   * Inheriting the empty-key behaviour would reproduce §2.2's silent failure
   * verbatim on a new channel: `models.json` still written, Pi still registers
   * the provider, the container still boots, `up` still reports success, and
   * the first symptom is an authentication error at generation time inside a
   * container on a worker that looks healthy.
   *
   * SRD §5.9 has a standing answer for this shape. A `relay_upstream` hostname
   * "produces a relay that starts cleanly, reports ready, and then fails every
   * connection with a resolution error no operator-facing surface shows.
   * `config validate` refuses it, so the failure becomes a sentence instead."
   * This is the same trade at the container's altitude.
   *
   * Three things are asserted, and dropping any one of them lets a plausible
   * wrong implementation through: the exit is non-zero, the sentence NAMES THE
   * PATH so an operator can act on it, and `models.json` IS NOT WRITTEN — a
   * refusal that still left a file behind would let Pi start against a
   * half-configured provider on the next container start.
   */
  test("a pointer at a file that is not there refuses loudly", async () => {
    const r = await render(baseDoc(), {}, {
      PIFLEET_LLM_API_KEY_FILE: "/nonexistent-pifleet-secrets/OMLX_API_KEY",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("/nonexistent-pifleet-secrets/OMLX_API_KEY");
    expect(r.stderr).toContain("PIFLEET_LLM_API_KEY_FILE");
    expect(r.models).toBeNull();
  });

  /**
   * An EMPTY file is the same event as a missing one, and it is called out
   * separately because it is the one an implementation is most likely to let
   * through: `cat` on an empty file succeeds, so every existence check passes
   * and the render proceeds with `apiKey: ""`.
   *
   * That is Defect A's exact output reached by a different route. The host's
   * convention is omit-don't-blank, so a file that exists and holds nothing is
   * a broken promise rather than a configured absence.
   */
  test("an empty credential file refuses loudly", async () => {
    const path = await keyFile("");
    const r = await render(baseDoc(), {}, { PIFLEET_LLM_API_KEY_FILE: path });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(path);
    expect(r.models).toBeNull();
  });

  /**
   * The refusal is INDEPENDENT OF THE RENDER GUARD, and that independence is
   * the structural half of the fix.
   *
   * §2.2's diagnosis of why Defect A was silent is precise: "the guard above
   * the block is `[ -n BASE_URL ] && [ -n MODELS ]` — it does not test the
   * key". Putting the credential check inside that guard would leave the
   * credential's health contingent on two unrelated variables, which is the
   * same coupling reached from the other side. A broken pointer is a broken
   * pointer whether or not this worker was going to render a provider.
   */
  test("a broken pointer refuses even when models.json would not be rendered", async () => {
    const r = await render(baseDoc(), {}, {
      PIFLEET_LLM_BASE_URL: "",
      PIFLEET_LLM_MODELS: "",
      PIFLEET_LLM_API_KEY_FILE: "/nonexistent-pifleet-secrets/OMLX_API_KEY",
    });
    expect(r.code).not.toBe(0);
    expect(r.models).toBeNull();
  });

  /**
   * THE PATH GUARD, and it replaces the identifier guard rather than joining
   * it — the same defence at the same altitude, against a strictly worse
   * consequence.
   *
   * The old guard tested a NAME and degraded a bad one to an empty key. A bad
   * PATH cannot be degraded the same way, because the failure it admits is not
   * "no value" but "SOME OTHER FILE'S value". `/secrets` is a shared namespace
   * — `secretFilePath()` puts every Class 3 grant at `/secrets/<name>` and D8
   * puts Class 1 in the same directory — and `models.json` lands on a named
   * volume that outlives `--rm`. A pointer that escapes the mount turns the
   * credential channel into a read primitive whose output is persisted.
   *
   * `..` is rejected as a SEGMENT rather than as a substring: a legitimate
   * secret name can contain dots, and a substring test would refuse it.
   *
   * EVERY PATH HERE RESOLVES TO A REAL, READABLE, NON-EMPTY FILE, and that is
   * the whole design of the fixture rather than an incidental detail. This test
   * was written first with the obvious spellings — `/secrets/../etc/hosts`,
   * `/secrets/..`, `../../etc/hosts` — and MEASURED VACUOUS: deleting the
   * traversal guard from the entrypoint left all 14 tests green. There is no
   * `/secrets` on a developer Mac or a CI runner, so those paths were being
   * refused by the existence check and the guard under test never ran. A
   * refusal test whose subject does not exist proves only that nothing exists.
   *
   * So each case below is one the entrypoint would happily read if its own
   * guard were removed, which is what makes removing the guard turn this red.
   * The `/secrets/...` spellings are gone rather than kept alongside: they
   * cannot fail here, and a case that cannot fail dilutes the ones that can.
   */
  test("a traversing, relative or non-file pointer refuses loudly", async () => {
    const real = await keyFile("KEY-REACHED-THE-WRONG-WAY");
    const credDir = dirname(real);
    const dir = await mkdtemp(join(tmpdir(), "pifleet-cred-dir-"));
    dirs.push(dir);
    // Relative, and resolves: `Bun.spawn` inherits THIS process's cwd, so from
    // the repo root that names a readable non-empty file and only the
    // absolute-path guard can refuse it.
    //
    // THE PRECONDITION IS ASSERTED RATHER THAN ASSUMED, and this line is the
    // whole reason: if a future harness change gives the spawn its own cwd,
    // this path stops resolving and the entrypoint refuses it as "not an
    // existing regular file" instead — the case would still pass, while
    // testing a completely different branch. That is exactly how the
    // `/secrets/..` spellings this fixture replaced were vacuous, so the same
    // mistake is made loud here instead of measured later.
    const relative = "docker/entrypoint.sh";
    const resolved = await stat(join(process.cwd(), relative)).catch(() => null);
    expect(
      resolved?.isFile() === true && resolved.size > 0,
      `${relative} does not resolve to a non-empty file from ${process.cwd()}, ` +
        `so the relative-path case would exercise the existence check rather ` +
        `than the absolute-path guard it was written for`,
    ).toBe(true);

    const bad = [
      // Traverses, and RESOLVES to the credential file. Only the `..` guard
      // can refuse this one — every other check passes.
      //
      // Concatenated rather than `join`ed on purpose: `path.join` NORMALISES,
      // so it collapses the `..` and hands the entrypoint a clean path. That
      // silently disarmed this case on the first attempt.
      `${credDir}/../${basename(credDir)}/OMLX_API_KEY`,
      relative,
      // Exists and is readable, but is not a regular file.
      dir,
    ];
    for (const p of bad) {
      const r = await render(baseDoc(), {}, { PIFLEET_LLM_API_KEY_FILE: p });
      expect(r.code, `${p} was accepted`).not.toBe(0);
      expect(r.models, `${p} rendered a provider`).toBeNull();
    }
  });

  /**
   * A SYMLINKED pointer is refused, mirroring the host's own rule.
   *
   * `materialize.ts` already calls `refuseSymlinkDestination` on the secrets
   * directory and on every file in it, so the host refuses to WRITE through a
   * link. This is the same rule applied at the read end, and it is not
   * redundant: the host guards the directory it creates, while the entrypoint
   * is handed a path by an environment variable and has no idea what produced
   * it. A link is how a shape-valid path reaches a file the shape check
   * cleared, so the two checks catch different things.
   */
  test("a symlinked pointer refuses loudly", async () => {
    const real = await keyFile("KEY-BEHIND-A-LINK", { name: "REAL_KEY" });
    const link = join(dirname(real), "LINKED_KEY");
    await symlink(real, link);
    const r = await render(baseDoc(), {}, { PIFLEET_LLM_API_KEY_FILE: link });
    expect(r.code).not.toBe(0);
    expect(r.models).toBeNull();
  });

  /**
   * An UNREADABLE file refuses loudly rather than rendering an empty key.
   *
   * HONEST LIMIT, stated rather than hidden: this asserts nothing when the test
   * runs as root, because root reads a `0000` file and the branch is never
   * entered. It is guarded rather than skipped silently so a reader can see the
   * condition, and the branch it covers is reachable in the real container —
   * the secrets mount is read-only and the worker does not run as root.
   *
   * (The spelling above is deliberate. `anti-criteria.test.ts`'s ISC-165 guard
   * chunks test files on the `test(` boundary, so a docstring lands in the
   * PRECEDING test's body; the literal mount-flag token in prose here made the
   * symlink test above read as a read-only-mount refusal that never reads back.
   * These tests are about a credential PATH, not about a mount, so the word is
   * spelled out rather than the guard loosened.)
   */
  test("an unreadable credential file refuses loudly", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const path = await keyFile("KEY-NOBODY-CAN-READ", { mode: 0o000 });
    const r = await render(baseDoc(), {}, { PIFLEET_LLM_API_KEY_FILE: path });
    // 73 SPECIFICALLY, not merely non-zero, and that is what makes the `if !`
    // around the read load-bearing. A bare assignment would also produce a
    // non-zero exit — `set -e` and cat's own status — but it would be cat's
    // code with bash's diagnostic, and the operator would get neither the
    // sentence nor a code distinguishable from the honeypot's 71 and the
    // missing-terminal 72.
    expect(r.code).toBe(73);
    expect(r.stderr).toContain(path);
    expect(r.models).toBeNull();
  });

  /** …and the same names are refused far earlier, where the operator is told. */
  test("config refuses the malformed and reserved names outright", () => {
    for (const bad of ["not-an-ident", "TARGET[0]", "PIFLEET_LLM_MODELS", "PATH"]) {
      const r = LlmSchema.safeParse({ model: "m", api_key_env: bad });
      expect(r.success, `schema accepted api_key_env: ${bad}`).toBe(false);
    }
    expect(LlmSchema.safeParse({ model: "m", api_key_env: "OLLAMA_API_KEY" }).success).toBe(true);
  });
});
