/**
 * `scripts/observe/characterise-vm` is TypeScript run by its `#!/usr/bin/env bun` shebang. It has no
 * `.ts` extension and nothing imports it, so `bun run typecheck` never opens it, and a type error in it
 * would ship unnoticed. The VM twin of `characterise-docker-typecheck.test.ts`, with the same method:
 * the script is copied into a temp directory as `characterise-vm.ts` and typechecked with a tsconfig
 * that extends the repo's own. If the script ever gains a relative import, tsc reports TS2307 here, and
 * the fix is to copy that import too.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "observe", "characterise-vm"), "utf8");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Typechecks `source` as a lone `characterise-vm.ts` under the repo's compiler options. */
function typecheck(source: string): { exitCode: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "characterise-vm-typecheck-"));
  dirs.push(dir);
  writeFileSync(join(dir, "characterise-vm.ts"), source);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(ROOT, "tsconfig.json"),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules")] },
      include: ["characterise-vm.ts"],
    }),
  );
  const proc = Bun.spawnSync([TSC, "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode ?? -1, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

test("scripts/observe/characterise-vm typechecks under the repo's compiler options", () => {
  expect(typecheck(SCRIPT)).toEqual({ exitCode: 0, output: "" });
});

// Without this, a check that never opened the copy (an include that matched nothing) would look clean.
test("the same check fails a planted type error", () => {
  const r = typecheck(`${SCRIPT}\nconst planted: number = "no";\n`);
  expect(r.exitCode).toBe(2);
  expect(r.output).toContain("TS2322");
});
