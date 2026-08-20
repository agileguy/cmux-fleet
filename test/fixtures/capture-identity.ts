/**
 * A stand-in LAUNCHER, for identity tests that need two different environments.
 *
 * Prints what the production capture path — `run/registry.ts`'s
 * `processStartTime` — records for a pid, in whatever timezone and locale THIS
 * process was started with. Nothing else: one line, no trailing newline.
 *
 * It has to be a separate process. `ps` renders its timestamp from the
 * environment it is handed, and a test that mutates `process.env.TZ` in-place
 * does NOT change what an inherited-environment child sees — measured, and it
 * makes the raw pre-fix renderings compare EQUAL, so a test built that way
 * passes whether the fix is present or not. The two environments have to be
 * real ones.
 *
 * Usage: `bun test/fixtures/capture-identity.ts <pid>`, with TZ / LC_ALL /
 * LC_TIME set on the spawn.
 */
import { processStartTime } from "../../src/run/registry.ts";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) {
  process.stderr.write(`capture-identity: expected a pid, got ${String(process.argv[2])}\n`);
  process.exit(2);
}
process.stdout.write((await processStartTime(pid)) ?? "");
