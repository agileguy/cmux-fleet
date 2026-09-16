/**
 * `scripts/observe/characterise-docker` is TypeScript run by its `#!/usr/bin/env bun` shebang. It has
 * no `.ts` extension and nothing imports it, so `bun run typecheck` never opens it, and a type error in
 * it would ship unnoticed.
 *
 * This test copies the script into a temp directory as `characterise-docker.ts` and typechecks the copy
 * with a tsconfig that extends the repo's own, so the compiler options cannot drift from
 * `bun run typecheck`. `typeRoots` points at the repo's `node_modules` because `types: ["bun-types"]`
 * would otherwise resolve from the temp directory and fail with TS2688. The copy is a single file: if
 * the script ever gains a relative import, tsc reports TS2307 here, and the fix is to copy that import
 * too.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "observe", "characterise-docker"), "utf8");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Typechecks `source` as a lone `characterise-docker.ts` under the repo's compiler options. */
function typecheck(source: string): { exitCode: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "characterise-docker-typecheck-"));
  dirs.push(dir);
  writeFileSync(join(dir, "characterise-docker.ts"), source);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(ROOT, "tsconfig.json"),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules")] },
      include: ["characterise-docker.ts"],
    }),
  );
  const proc = Bun.spawnSync([TSC, "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode ?? -1, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

test("scripts/observe/characterise-docker typechecks under the repo's compiler options", () => {
  expect(typecheck(SCRIPT)).toEqual({ exitCode: 0, output: "" });
});

// Without this, a check that never opened the copy (an include that matched nothing) would look clean.
test("the same check fails a planted type error", () => {
  const r = typecheck(`${SCRIPT}\nconst planted: number = "no";\n`);
  expect(r.exitCode).toBe(2);
  expect(r.output).toContain("TS2322");
});
