/**
 * ISC-1073 — the check three SRD passages said existed and that never did.
 *
 * ## What this closes
 *
 * All three files in `docker/pi-extensions/` declare Pi's extension surface
 * STRUCTURALLY — each writes its own `interface ExtensionAPI` naming the members
 * it calls — because `@earendil-works/pi-coding-agent` is installed in the IMAGE
 * and is not a dependency of this repository. Nothing can typecheck those
 * declarations against the package, so nothing did: a `0.79.x` bump renaming
 * `registerTool`, or retiring the `tool_result` event, would leave every unit
 * test green and every worker silently short of the behaviour the extension was
 * written for. `dispatch-trigger.ts` and `truncation-recovery.ts` carried that
 * exposure from the day they were written.
 *
 * `Docs/SRD-WORKER-DISPATCH-EXTENSION.md` asserted three times that
 * `test/integration/auto-trigger-image.test.ts` already read the real `.d.ts`
 * and checked for exactly this drift, and that the design copied that pattern
 * "wholesale, including the integration test". **There was no such file.** The
 * only `@earendil-works` string anywhere in `test/` asserted that a `.js` PATH
 * appears in a shim — a file name, not a type. The docblock on
 * `report-tools.ts`'s own `ExtensionAPI` repeated the claim about THIS file.
 * This is that file, written rather than cited.
 *
 * ## Why a subset and not an equality
 *
 * The real `ExtensionAPI` has dozens of members and Pi adds more across minors;
 * an equality would go red on every upgrade that added a capability nobody here
 * uses, which is noise that trains a reader to re-baseline without looking. The
 * question worth asking is narrower and is the one that actually breaks a
 * worker: **is every member and every event name these three files depend on
 * still there?** So the assertion is containment, and its failure message names
 * the missing spelling.
 *
 * ## Why the image and not a checked-in copy
 *
 * A vendored `.d.ts` would answer a question about this repository. The workers
 * run the package baked into the tag, so the tag is what has to be read — and
 * reading it through `docker run` means the file under test is the one a worker
 * would load, at the version the tag is a hash of.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import { buildImage, imageTag } from "../../src/container/image.ts";
import { realExec, repoRoot } from "../../src/container/run.ts";
import { containerBudget } from "../support/budget.ts";

const DOCKER = process.env.PIFLEET_DOCKER === "1";
if (!DOCKER) {
  console.warn(
    "[skip] test/integration/extension-declarations-image.test.ts needs a Docker daemon. " +
      "Run with PIFLEET_DOCKER=1 after 'pifleet image build'.",
  );
}

const it = test.skipIf(!DOCKER);

const BUILD_TIMEOUT = 2_400_000;
const TOOLCHAIN = "base" as const;

/**
 * Where the package's extension types live inside the image, verified
 * 2026-09-08 in `0.79.6-base-72c16f4efb2f` and again in `…-932a6f7d32dd`.
 *
 * A path is exactly the kind of thing that moves across a minor, so a MISSING
 * file is reported as its own failure below rather than surfacing as "no
 * members found", which would read as a parse bug in this file.
 */
const TYPES_PATH =
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts";

/** Same virtual config the other image tests use: independent of `fleet.yaml` edits. */
const CONFIG_YAML = `
version: 2
name: extension-declarations-test
docker:
  pi_version: "0.79.6"
run:
  repo: .
  budget:
    tokens_ceiling: 1000000
llm:
  model: TestModel
roles:
  eng: { toolchain: node }
workers:
  - { id: w1, role: eng }
`;

/** The three files under test, and the event each subscribes to. */
const EXTENSIONS = ["report-tools", "dispatch-trigger", "truncation-recovery"] as const;

/**
 * Strip block and line comments before parsing.
 *
 * Not tidiness: these files are heavily commented and several docblocks name the
 * very members being counted — `registerTool`, `sendUserMessage`, `"agent_end"`.
 * Parsing with the comments in place would find members that are only discussed,
 * which is the ISC-572 shape (a probe satisfied by prose about the thing rather
 * than the thing) reached from the other side.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The balanced-brace body of `interface <name> {` … `}`, or null. */
function interfaceBody(src: string, name: string): string | null {
  const m = new RegExp(`interface\\s+${name}\\s*\\{`).exec(src);
  if (m === null) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index + m[0].length, i);
    }
  }
  return null;
}

/**
 * Member names declared at the TOP LEVEL of an interface body.
 *
 * Split into declarations on depth-0 semicolons, then take each one's leading
 * identifier. Two hand-rolled character scanners got this wrong first — one
 * collected the PARAMETER names of `truncation-recovery.ts`'s four-line `on`,
 * the other dropped a leading character and reported `vent` missing from Pi's
 * API. **A parser bug that reads as a finding is worse than no check**, because
 * the failure message is confident, specific and wrong; splitting on the
 * separator the language already uses removes the class.
 */
function memberNames(body: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  let start = 0;
  const decls: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if ("{([<".includes(ch)) depth++;
    else if ("})]>".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      decls.push(body.slice(start, i));
      start = i + 1;
    }
  }
  decls.push(body.slice(start));
  for (const d of decls) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*[<(?:]/.exec(d);
    if (m !== null) names.add(m[1]!);
  }
  return names;
}

/** Every `"literal"` appearing in an `event:` position. */
function eventNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(/event\s*:\s*([^;)]+)/g)) {
    for (const lit of m[1]!.matchAll(/"([a-z_]+)"/g)) names.add(lit[1]!);
  }
  return names;
}

describe("the extensions' structural Pi declarations against the image's own .d.ts", () => {
  let real = "";
  let realApi = "";

  beforeAll(async () => {
    if (!DOCKER) return;
    const loaded: LoadedConfig = await parseConfig(
      CONFIG_YAML,
      "/virtual/extension-declarations/fleet.yaml",
    );
    const tag = imageTag(loaded.config, TOOLCHAIN);
    await buildImage(loaded.config, { toolchain: TOOLCHAIN, timeoutMs: BUILD_TIMEOUT });

    const r = await realExec(
      [
        "docker", "run", "--rm", "--read-only", "--network", "none",
        "--entrypoint", "/bin/cat", tag, TYPES_PATH,
      ],
      { timeoutMs: containerBudget(1) },
    );
    if (r.code !== 0) {
      throw new Error(
        `${TYPES_PATH} could not be read out of ${tag} (exit ${r.code}). The package's ` +
          `layout moved, which is itself the drift this file exists to catch: ${r.stderr.trim()}`,
      );
    }
    real = r.stdout;
    realApi = interfaceBody(stripComments(real), "ExtensionAPI") ?? "";
  }, BUILD_TIMEOUT);

  /**
   * The premise, asserted before anything rests on it. A parse that silently
   * returned nothing would make every containment check below vacuously true —
   * the empty set is a subset of everything — so the one failure this file must
   * never produce quietly is "found no members".
   */
  it("the image's ExtensionAPI is found and is not empty", () => {
    expect(real.length).toBeGreaterThan(1000);
    expect(realApi).not.toBe("");
    const members = memberNames(realApi);
    expect(members.size).toBeGreaterThan(5);
    expect(members).toContain("on");
  }, containerBudget(1));

  for (const name of EXTENSIONS) {
    it(`${name}.ts declares only members the image's ExtensionAPI has`, async () => {
      const src = stripComments(
        await readFile(join(repoRoot(), "docker", "pi-extensions", `${name}.ts`), "utf8"),
      );
      const declared = interfaceBody(src, "ExtensionAPI");
      expect(declared, `${name}.ts declares no interface ExtensionAPI`).not.toBeNull();

      const want = memberNames(declared!);
      expect(want.size).toBeGreaterThan(0);
      const have = memberNames(realApi);
      const missing = [...want].filter((m) => !have.has(m));
      expect(
        missing,
        `${name}.ts calls ${missing.join(", ")}, which the image's ExtensionAPI no longer ` +
          `declares — a Pi upgrade renamed or removed it and nothing else would have said so`,
      ).toEqual([]);
    }, containerBudget(1));

    it(`${name}.ts subscribes only to events the image still emits`, async () => {
      const src = stripComments(
        await readFile(join(repoRoot(), "docker", "pi-extensions", `${name}.ts`), "utf8"),
      );
      /*
       * The CALL SITES, not the declaration. A file could declare
       * `on(event: "agent_end")` and subscribe to something else entirely, and
       * the declaration is the half this repository controls — so the names that
       * matter are the ones actually passed to `pi.on(...)`.
       */
      const subscribed = new Set(
        [...src.matchAll(/\bpi\.on\(\s*"([a-z_]+)"/g)].map((m) => m[1]!),
      );
      expect(subscribed.size).toBeGreaterThan(0);

      const emitted = eventNames(realApi);
      expect(emitted.size).toBeGreaterThan(5);
      const gone = [...subscribed].filter((e) => !emitted.has(e));
      expect(
        gone,
        `${name}.ts subscribes to ${gone.join(", ")}, which the image's ExtensionAPI has no ` +
          `overload for — the handler would never fire and nothing would report it`,
      ).toEqual([]);
    }, containerBudget(1));
  }

  /**
   * The four members SRD §7.6 names as the declared surface, asserted by NAME
   * rather than only through the loop above.
   *
   * The loop compares the repository against the image and would stay green if
   * a future edit deleted a member from an extension — fewer declarations is
   * still a subset. This says which spellings the design depends on, so
   * `registerTool` disappearing from Pi is named here even if some refactor has
   * meanwhile stopped `report-tools.ts` from declaring it.
   */
  it("the image still declares the four members §7.6 names", () => {
    const have = memberNames(realApi);
    for (const m of ["registerTool", "on", "sendUserMessage", "appendEntry"]) {
      expect(have, `the image's ExtensionAPI no longer declares ${m}`).toContain(m);
    }
  }, containerBudget(1));

  /** The three events this fleet's extensions are built on, by name. */
  it("the image still emits the four events these extensions subscribe to", () => {
    const emitted = eventNames(realApi);
    for (const e of ["agent_end", "tool_call", "tool_result", "session_start"]) {
      expect(emitted, `the image's ExtensionAPI has no ${e} overload`).toContain(e);
    }
  }, containerBudget(1));
});
