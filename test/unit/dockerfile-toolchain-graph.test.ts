/**
 * Every language toolchain is that language AND node.
 *
 * The rule exists because a toolchain that swaps one capability for another is
 * a trade the operator did not ask for. Measured 2026-09-04: the tester role
 * moved from `node` to `python` to get pytest, and silently lost `bun` — so
 * the same worker could no longer run this repository's own suite, or any bun
 * project's. Nothing reported that; the image simply came up without a binary
 * it used to have.
 *
 * Node is not a language choice here, it is the harness. The base image IS
 * `node:24-bookworm-slim`, so `node` was always present in every image — what
 * `toolchain-node` adds is `bun`. Building each language stage on
 * `toolchain-node` makes "python includes node" structural rather than a thing
 * each new stage has to remember, which is the property this file pins: a
 * `toolchain-rust` added later and based on `base` reddens here.
 */
import { describe, expect, test } from "bun:test";

const DOCKERFILE = await Bun.file(
  new URL("../../docker/Dockerfile", import.meta.url).pathname,
).text();

/** `FROM <parent> AS <stage>` pairs, comments stripped. */
export function stageParents(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/);
    if (m === null) continue;
    out.set(m[2]!, m[1]!);
  }
  return out;
}

/** Every `toolchain-*` stage except the `base` and `node` roots. */
function languageStages(parents: Map<string, string>): string[] {
  return [...parents.keys()].filter(
    (s) => s.startsWith("toolchain-") && s !== "toolchain-base" && s !== "toolchain-node",
  );
}

/** Walk `FROM` links to the set of stages a stage is built on. */
function ancestry(parents: Map<string, string>, stage: string): string[] {
  const seen: string[] = [];
  let at = parents.get(stage);
  while (at !== undefined && !seen.includes(at)) {
    seen.push(at);
    at = parents.get(at);
  }
  return seen;
}

describe("the toolchain stage graph", () => {
  const parents = stageParents(DOCKERFILE);

  test("the parser found the stages — control against a rotted regex", () => {
    // Without this a `FROM` syntax change would empty every assertion below
    // while leaving them green.
    expect(parents.get("toolchain-node")).toBe("base");
    expect(languageStages(parents).length).toBeGreaterThanOrEqual(2);
  });

  test("every language toolchain is built on toolchain-node", () => {
    const offenders = languageStages(parents).filter(
      (s) => !ancestry(parents, s).includes("toolchain-node"),
    );
    expect(
      offenders,
      `these language toolchains do not include node: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("python and go are named language toolchains, not aliases of base", () => {
    for (const s of ["toolchain-python", "toolchain-go"]) {
      expect(parents.has(s), `${s} is missing`).toBe(true);
      expect(ancestry(parents, s)).toContain("toolchain-node");
    }
  });

  test("full is the widest toolchain — it includes python, and so node", () => {
    const anc = ancestry(parents, "toolchain-full");
    expect(anc).toContain("toolchain-python");
    expect(anc).toContain("toolchain-node");
  });

  test("full does not restate its siblings' install lines", () => {
    /*
     * `full` used to be a third copy of every install, and the duplication was
     * already drifting: the bun-postinstall fix and `python3-pip` each had to
     * be written twice. A stage that restates its siblings is one that will
     * eventually disagree with them.
     */
    const from = DOCKERFILE.indexOf("FROM toolchain-python AS toolchain-full");
    expect(from).toBeGreaterThan(-1);
    const body = DOCKERFILE.slice(from, DOCKERFILE.indexOf("FROM toolchain-${TOOLCHAIN}"));
    expect(body).not.toContain("bun@");
    expect(body).not.toContain("python3-venv");
  });

  test("the final stage still selects by build arg", () => {
    expect(DOCKERFILE).toContain("FROM toolchain-${TOOLCHAIN} AS final");
  });
});

/**
 * Each toolchain ships its platform's TYPECHECKER and LINTER.
 *
 * A cloned checkout carries no installed dependencies, so a worker asked to
 * typecheck or lint one has nothing to run until it installs the project's
 * world. Global copies make the quick answer available; a project that vendors
 * its own still wins, because the local resolution comes first.
 */
describe("every toolchain carries its platform's typecheck and lint tools", () => {
  /** The text of one stage, from its `FROM` line to the next one. */
  function stageBody(stage: string): string {
    const from = DOCKERFILE.indexOf(`AS ${stage}\n`);
    expect(from, `stage ${stage} not found`).toBeGreaterThan(-1);
    const next = DOCKERFILE.indexOf("\nFROM ", from);
    return DOCKERFILE.slice(from, next === -1 ? undefined : next);
  }

  test("node has a typechecker and a linter", () => {
    const body = stageBody("toolchain-node");
    expect(body).toContain("typescript");
    expect(body).toContain("eslint");
  });

  test("python has a typechecker and a linter", () => {
    const body = stageBody("toolchain-python");
    expect(body).toContain("mypy");
    expect(body).toContain("ruff");
  });

  test("go has a linter beyond the vet and gofmt it ships with", () => {
    expect(stageBody("toolchain-go")).toContain("staticcheck");
  });

  /**
   * The measured failure, pinned.
   *
   * `UV_TOOL_BIN_DIR=/usr/local/bin` alone produced entry points that were
   * symlinks into `/root/.local/share/uv/tools/...`. The build succeeded, the
   * links existed, `command -v ruff` found one — and running it as uid 10001
   * reported command-not-found, because root's home is 0700 and the worker
   * cannot traverse to the target. A dangling permission is worse than a
   * missing tool, because every cheap check for presence passes.
   */
  test("uv's tool environments live somewhere a non-root worker can read", () => {
    const body = stageBody("toolchain-python");
    expect(body).toContain("UV_TOOL_DIR=");
    const dir = body.match(/UV_TOOL_DIR=(\S+)/)![1]!;
    expect(dir.startsWith("/root")).toBe(false);
    expect(dir.startsWith("/home")).toBe(false);
    // And the readability is made explicit rather than left to umask.
    expect(body).toMatch(/chmod -R a\+rX/);
  });
});
