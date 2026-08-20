/**
 * ISC-31 — no cloud provider key reaches any container's environment, and the
 * only key-shaped variable production is allowed to set at all is
 * `OMLX_API_KEY`.
 *
 * The criterion's wording names `docker inspect`, and the live half lives in
 * `test/integration/container-env.test.ts`, where a real container is really
 * inspected. This file is the half that runs on EVERY push with no daemon
 * anywhere, and it is the broader of the two in one specific way that matters:
 * `docker inspect` can only be pointed at a container that EXISTS, and today
 * `up` launches no worker container at all (nothing in `src/` execs
 * `buildDockerArgv`'s output — the mint/inject wiring is tracked as ISC-248).
 * So the integration side necessarily inspects a container a test authored,
 * while this side reads the argv PRODUCTION builds, for every producer in the
 * repo. Neither is sufficient alone.
 *
 * EVERY `docker run` argv builder in `src/` is enumerated here, not just the
 * worker one. A credential can only enter a container's environment through a
 * `-e`/`--env` flag or an `--env-file`, so the complete claim requires the
 * complete list of things that build such flags:
 *
 *   - `buildDockerArgv`      (config/render.ts)     — worker containers
 *   - `relayRunArgv`         (security/relay.ts)    — the egress relay
 *   - `containerProbeArgv`   (security/probe-transport.ts) — the model probe
 *
 * `container/image.ts` and `container/mounts.ts` also `docker run`, from argv
 * assembled inline rather than through an exported builder; they are covered
 * by the source-level sweep at the bottom, which is the only form available
 * for an argv that is not a value anything can import.
 *
 * ## The two rules, and why the second one is the sharp one
 *
 * A `-e` flag comes in two forms and they behave completely differently:
 *
 *   -e NAME=value   sets NAME to a literal. Auditable by reading it.
 *   -e NAME         PASSES THROUGH whatever NAME holds in the HOST's
 *                   environment, and names no value at all.
 *
 * The bare form is the one that turns "we never wrote a credential into argv"
 * into a false statement about the container: `-e AWS_SECRET_ACCESS_KEY` puts
 * the operator's real key inside the container and appears in `docker
 * inspect`, while the argv a reviewer reads contains nothing that looks like a
 * secret. It is also the form a well-meaning change reaches for first, because
 * it is shorter and it "just works" on the author's machine. So it is refused
 * outright rather than inspected: production sets env explicitly or not at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { stringify } from "yaml";
import { loadConfig } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { CREDENTIAL_ENV_VARS } from "../../src/security/adc.ts";
import {
  relayRunArgv,
  RELAY_DEFAULT_DIAL_HOST,
  type RelayTarget,
} from "../../src/security/relay.ts";
import { containerProbeArgv } from "../../src/security/probe-transport.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The ONE key production is permitted to put in a container, named by the
 * criterion itself.
 *
 * It is a local oMLX server credential, not a billing key for a cloud provider
 * (`docker/entrypoint.sh` says so at its definition, SRD §5.9) — which is
 * exactly why the criterion carves it out rather than banning every key.
 */
const PERMITTED_KEY = "OMLX_API_KEY";

/**
 * Names whose VALUE would be a cloud provider credential.
 *
 * The Google four come from `adc.ts`'s own `CREDENTIAL_ENV_VARS` rather than
 * being retyped, so this list cannot drift from the module that defines them.
 * The rest are the other providers' equivalents, which no code in this repo
 * references today — which is the point: the criterion is about what must
 * never appear, so a list containing only vars the repo already uses would be
 * a list that can never catch anything new.
 */
const CLOUD_KEY_NAMES = [
  ...CREDENTIAL_ENV_VARS,
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "GOOGLE_API_KEY",
  "GCP_SERVICE_ACCOUNT_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

/**
 * Structurally secret-shaped, for the names nobody thought to enumerate.
 *
 * `CLOUD_KEY_NAMES` catches what we predicted; this catches
 * `FOOCLOUD_API_KEY`. `_FILE` is excluded deliberately and is not a loophole:
 * `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` is a POINTER to a path, and the whole
 * §5.8 design is that the pointer travels in the environment while the token
 * travels through a tmpfs file `docker inspect` never shows. Treating the
 * pointer as a secret would make the criterion demand the removal of the
 * mechanism that keeps the secret out of the environment.
 */
function isSecretShaped(name: string): boolean {
  if (name === PERMITTED_KEY) return false;
  if (name.endsWith("_FILE")) return false;
  return /(^|_)(KEY|SECRET|TOKEN|CREDENTIALS?|PASSWORD|PASSWD)$/.test(name);
}

interface EnvFlag {
  /** The variable name. */
  name: string;
  /** The literal value, or null for the bare host-pass-through form. */
  value: string | null;
}

/**
 * Every environment variable an argv sets, with the bare form preserved as a
 * distinct case rather than normalised away.
 *
 * `docker run` treats the first bare `-e NAME` after the image name as a
 * command argument, not a flag, so only flags BEFORE the image count. That
 * distinction is load-bearing for the probe argv, whose trailing `node -e
 * <script>` is node's `-e`, not docker's — reading it as a docker flag would
 * report a variable named after the entire probe script.
 */
function envFlags(argv: readonly string[], imageIndex: number): EnvFlag[] {
  const out: EnvFlag[] = [];
  argv.forEach((a, i) => {
    if (i >= imageIndex) return;
    if (a !== "-e" && a !== "--env") return;
    const spec = argv[i + 1];
    if (spec === undefined) return;
    const sep = spec.indexOf("=");
    out.push(sep === -1 ? { name: spec, value: null } : { name: spec.slice(0, sep), value: spec.slice(sep + 1) });
  });
  return out;
}

/** Assert one production argv satisfies ISC-31. */
function expectCleanEnv(what: string, argv: readonly string[], imageIndex: number): EnvFlag[] {
  const flags = envFlags(argv, imageIndex);
  for (const f of flags) {
    // Rule 1: never a cloud provider credential, by name.
    expect(`${what}: ${f.name}`).not.toBe(`${what}: ${CLOUD_KEY_NAMES.find((n) => n === f.name)}`);
    expect(CLOUD_KEY_NAMES).not.toContain(f.name);
    // Rule 1b: nor anything else secret-shaped, whoever named it.
    expect(`${what} sets ${f.name} (secret-shaped: ${isSecretShaped(f.name)})`).toBe(
      `${what} sets ${f.name} (secret-shaped: false)`,
    );
    // Rule 2: never the bare host-pass-through form.
    expect(`${what} sets ${f.name} = ${f.value === null ? "<HOST PASS-THROUGH>" : "<literal>"}`).toBe(
      `${what} sets ${f.name} = <literal>`,
    );
  }
  return flags;
}

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
  delete process.env["PIFLEET_RUNS_DIR"];
});

/** A minimal but production-shaped fleet, with cloud access turned ON. */
async function fixture(): Promise<{ dir: string; runsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-env-"));
  cleanups.push(dir);
  // A SIBLING of the checkout, never a child — see ISC-127.
  const runsDir = await mkdtemp(join(tmpdir(), "pifleet-env-runs-"));
  cleanups.push(runsDir);
  process.env["PIFLEET_RUNS_DIR"] = runsDir;
  await mkdir(join(dir, "roles"), { recursive: true });
  await writeFile(join(dir, "roles", "eng.md"), "Engineer.\n");
  const doc = {
    version: 2,
    name: "env-fixture",
    docker: { pi_version: "0.79.6" },
    run: { root: "./decoy", repo: ".", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "M", api_key_env: PERMITTED_KEY },
    cloud: { adc: true, adc_mode: "token", kubeconfig: "./kube/filtered.yaml" },
    roles: {
      eng: { model: "M", append_system_prompt_file: "./roles/eng.md", cloud_access: true },
      plain: { model: "M", append_system_prompt_file: "./roles/eng.md" },
    },
    workers: [
      { id: "eng-1", role: "eng" },
      { id: "plain-1", role: "plain" },
    ],
  };
  await writeFile(join(dir, "fleet.yaml"), stringify(doc));
  return { dir, runsDir };
}

describe("no cloud provider key reaches a container environment (ISC-31)", () => {
  /**
   * The worker argv, for a `cloud_access: true` role and a plain one.
   *
   * The strongest true statement about it today is stronger than the
   * criterion: `buildDockerArgv` emits NO `-e` at all. Every worker variable
   * travels through `--env-file`, which is asserted separately and by a
   * different mechanism (the file's CONTENT, in render.test.ts's ISC-45
   * block). Asserting the count is zero rather than merely "none of them is a
   * key" is what makes a future `-e` — of any name — a decision someone has to
   * come here and make deliberately.
   *
   * Mutation check: adding `argv.push("-e", "AWS_SECRET_ACCESS_KEY")` to
   * `buildDockerArgv` turns this red. See the ISA close-out for the run.
   */
  test("no rendered worker argv sets any environment variable directly", async () => {
    const { dir } = await fixture();
    const loaded = await loadConfig(join(dir, "fleet.yaml"));
    for (const id of ["eng-1", "plain-1"]) {
      const r = await renderWorker(loaded, id);
      const imageIndex = r.docker.indexOf(r.image);
      expect(imageIndex).toBeGreaterThan(0);
      const flags = expectCleanEnv(`worker ${id}`, r.docker, imageIndex);
      expect(flags).toEqual([]);
      // The delivery path that IS used, pinned so "no -e" cannot be achieved
      // by a renderer that stopped delivering an environment at all.
      expect(r.docker).toContain("--env-file");
    }
  });

  /**
   * The relay. It DOES set a variable, so this is the case that proves the
   * assertions above are not passing merely because nothing ever sets one.
   *
   * `PIFLEET_RELAY_TARGETS` is a JSON forwarding table — hosts and ports, no
   * credential — and the relay is deliberately built so no key is needed:
   * `docker/egress-relay.cjs` forwards TCP and never reads a request body.
   */
  test("the relay sets exactly one variable, and it is a forwarding table", () => {
    const targets: RelayTarget[] = [
      { listenPort: 8000, host: RELAY_DEFAULT_DIAL_HOST, port: 8000, name: "omlx" },
    ];
    const argv = relayRunArgv("relay-x", "uplink-x", targets, "/repo/docker/egress-relay.cjs");
    // `relayRunArgv` omits the leading "docker", so the image is located by value.
    const imageIndex = argv.findIndex((a) => a.includes("node@sha256:") || a.includes("node:"));
    expect(imageIndex).toBeGreaterThan(0);
    const flags = expectCleanEnv("relay", argv, imageIndex);
    expect(flags.map((f) => f.name)).toEqual(["PIFLEET_RELAY_TARGETS"]);
    expect(flags[0]!.value).toContain("8000");
    expect(flags[0]!.value).not.toContain(PERMITTED_KEY);
  });

  /**
   * The model probe — the one container in the repo that handles a real API
   * key, which is precisely why it must set NO environment variable.
   *
   * The key travels on stdin (see `probe-transport.ts`'s header: argv is
   * visible in `ps` to every user on the host and is recorded by `docker
   * inspect` for the container's lifetime). This asserts the consequence:
   * nothing key-shaped is in the environment either, so both published
   * surfaces are clean and the key is on the one channel that is neither.
   */
  test("the model probe sets no environment variable, key included", () => {
    const argv = containerProbeArgv("pifleet-net");
    const imageIndex = argv.findIndex((a) => a.includes("node@sha256:") || a.includes("node:"));
    expect(imageIndex).toBeGreaterThan(0);
    expect(expectCleanEnv("probe", argv, imageIndex)).toEqual([]);
    // The probe's own `-e` is node's, AFTER the image — proof the scan above
    // stopped at the right index rather than finding nothing by accident.
    expect(argv.slice(imageIndex)).toContain("-e");
  });

  /**
   * The producers that build argv inline, swept at the source level.
   *
   * `container/image.ts` and `container/mounts.ts` `docker run` from array
   * literals rather than exported builders, so there is no value to inspect —
   * only the text. A source sweep is a weak instrument and is used here only
   * because it is the sole one available; it is scoped to the bare
   * pass-through form, which is a distinctive token sequence rather than a
   * general property, and which is the form that would let a host credential
   * into a container without any name appearing in this repo at all.
   */
  test("no source file in src/ passes a host variable through with a bare -e", async () => {
    const files = new Bun.Glob("**/*.ts").scan({ cwd: join(REPO_ROOT, "src") });
    const offenders: string[] = [];
    for await (const rel of files) {
      const text = await Bun.file(join(REPO_ROOT, "src", rel)).text();
      // `"-e",` followed by a string literal with no `=` in it, i.e. the
      // pass-through form. `node -e` and `bun -e` take a script as the next
      // element and are excluded by requiring a bare NAME-shaped token.
      for (const m of text.matchAll(/"-e",\s*\n?\s*"([A-Z][A-Z0-9_]*)"/g)) {
        offenders.push(`${rel}: -e ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
