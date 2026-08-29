/**
 * The scrubber itself: what it matches, what it refuses to match, and what it
 * must never do to the log it is protecting.
 *
 * The WIRING — that `logEvent` actually calls this — is proved somewhere else
 * on purpose, in `test/integration/secret-redaction-wiring.test.ts`, which
 * never imports this module. A correct scrubber with no caller passes every
 * probe in this file.
 *
 * Every value here is synthetic. Nothing reads the real environment, so a
 * failure in CI cannot print an operator's credential.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRedactor,
  MIN_REDACTABLE_LENGTH,
  parseEnvFile,
  redactorForWorkerEnv,
  SECRET_NAMES_VAR,
  TRUNCATION_FLOOR,
} from "../../src/security/redact.ts";
import { buildWorkerEnv, writeWorkerSecretFiles } from "../../src/run/worker-env.ts";
import { parseConfig, resolveWorker } from "../../src/config/load.ts";
import { stringify } from "yaml";

const CANARY = "NOTAREALSECRET-pifleet-test-canary-000001";

function one(value: string, name = "TICKET_API_TOKEN") {
  return buildRedactor([[name, value]]);
}

describe("a granted value is removed from the serialised record", () => {
  test("the whole value goes, and the marker names the variable", () => {
    const line = JSON.stringify({ text: `token=${CANARY} done` });
    const out = one(CANARY).redact(line);
    expect(out).not.toContain(CANARY);
    expect(out).toContain("[redacted:TICKET_API_TOKEN]");
    // Still JSON, because the whole point is a log a reader can still parse.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("every occurrence goes, not just the first", () => {
    const line = JSON.stringify({ a: CANARY, b: CANARY, c: { d: CANARY } });
    const out = one(CANARY).redact(line);
    expect(out).not.toContain(CANARY);
    expect(out.split("[redacted:TICKET_API_TOKEN]")).toHaveLength(4);
  });

  /**
   * The one the wiring test found. `echo $TOKEN | head -c 20` was the actual
   * command, so a whole-value scrubber would have shipped a control that the
   * incident itself defeats.
   */
  test("a TRUNCATED value goes too, down to the floor", () => {
    const r = one(CANARY);
    for (const cut of [40, 20, TRUNCATION_FLOOR]) {
      const out = r.redact(JSON.stringify({ text: CANARY.slice(0, cut) }));
      expect(out).not.toContain(CANARY.slice(0, cut));
    }
  });

  test("the LONGEST surviving fragment is what gets replaced", () => {
    // A greedy pattern must not settle for the 12-character stem and leave the
    // rest of a 30-character fragment sitting beside the marker.
    const frag = CANARY.slice(0, 30);
    const out = one(CANARY).redact(JSON.stringify({ text: frag }));
    expect(out).toBe(JSON.stringify({ text: "[redacted:TICKET_API_TOKEN]" }));
  });

  test("a fragment BELOW the floor is left alone, deliberately", () => {
    const short = CANARY.slice(0, TRUNCATION_FLOOR - 1);
    const out = one(CANARY).redact(JSON.stringify({ text: short }));
    expect(out).toContain(short);
  });
});

describe("a short or empty secret must not become a scrubber that eats the log", () => {
  test("an empty value arms nothing and is reported as skipped", () => {
    const r = buildRedactor([["EMPTY", ""]]);
    expect(r.armed).toEqual([]);
    expect(r.skipped).toEqual(["EMPTY"]);
    const line = JSON.stringify({ text: "the quick brown fox" });
    expect(r.redact(line)).toBe(line);
  });

  test("a one-character value does not turn every matching char into a marker", () => {
    const r = buildRedactor([["TINY", "a"]]);
    expect(r.armed).toEqual([]);
    const line = JSON.stringify({ text: "a cat sat on a mat" });
    expect(r.redact(line)).toBe(line);
  });

  test(`values under ${MIN_REDACTABLE_LENGTH} characters are skipped by name`, () => {
    const r = buildRedactor([["SHORT", "a".repeat(MIN_REDACTABLE_LENGTH - 1)]]);
    expect(r.skipped).toEqual(["SHORT"]);
    expect(r.armed).toEqual([]);
  });

  test("a secret shorter than the truncation floor matches only in full", () => {
    // Otherwise an 8-character low-entropy value would carpet the log with
    // markers wherever its first 8 characters happened to appear.
    const value = "password".slice(0, MIN_REDACTABLE_LENGTH);
    const r = buildRedactor([["SHORTISH", value]]);
    expect(r.armed).toEqual(["SHORTISH"]);
    expect(r.redact(JSON.stringify({ text: value }))).not.toContain(value);
    expect(r.redact(JSON.stringify({ text: value.slice(0, 6) }))).toContain(value.slice(0, 6));
  });

  test("an unarmed redactor returns the identical string, not a copy of a no-op scan", () => {
    const r = buildRedactor([]);
    const line = JSON.stringify({ text: "nothing to do here" });
    expect(r.redact(line)).toBe(line);
    expect(r.armed).toEqual([]);
  });
});

describe("the scrubber cannot be out-flanked by shape or by escaping", () => {
  /**
   * The three fields the 2026-08-28 leak was found in are the ones OBSERVED,
   * not the ones that exist. Working on the serialised line is what makes a
   * shape nobody has seen yet safe, so the probe uses a shape nobody has seen.
   */
  test("a field nobody has ever seen is scrubbed the same as a known one", () => {
    const line = JSON.stringify({
      type: "some_event_pi_does_not_emit_yet",
      deeply: { nested: [{ unheard_of_field: CANARY }] },
    });
    expect(one(CANARY).redact(line)).not.toContain(CANARY);
  });

  test("a value needing JSON escaping is matched in its ESCAPED form", () => {
    const tricky = `line1\nquote"and\\slash-${"x".repeat(20)}`;
    const line = JSON.stringify({ text: `prefix ${tricky} suffix` });
    const out = buildRedactor([["TRICKY", tricky]]).redact(line);
    expect(out).toContain("[redacted:TRICKY]");
    // The result must still parse — a match that straddled an escape sequence
    // would leave a dangling backslash and a log no reader can load.
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual({ text: "prefix [redacted:TRICKY] suffix" });
  });

  test("a value embedded as PRE-SERIALISED JSON is still caught", () => {
    // Pi emits this whenever a tool result is itself a JSON document: the
    // value reaches the record double-encoded.
    const inner = JSON.stringify({ token: CANARY });
    const line = JSON.stringify({ text: inner });
    expect(one(CANARY).redact(line)).not.toContain(CANARY);
  });

  test("a name that is a prefix of another does not leave the longer one's tail", () => {
    const shortSecret = CANARY.slice(0, 20);
    const r = buildRedactor([
      ["SHORT_ONE", shortSecret],
      ["LONG_ONE", CANARY],
    ]);
    const out = r.redact(JSON.stringify({ text: CANARY }));
    expect(out).not.toContain(CANARY.slice(20));
    expect(out).toBe(JSON.stringify({ text: "[redacted:LONG_ONE]" }));
  });

  test("a marker never re-emits the value on a lookup miss", () => {
    const out = one(CANARY).redact(JSON.stringify({ a: CANARY }));
    expect(out).not.toContain("NOTAREALSECRET");
  });
});

describe("it stays cheap on the path a stderr flood takes", () => {
  /**
   * ISC-158's scenario floods a pipe with thousands of lines and every one of
   * them becomes a `stderr_line` event. A `RegExp` constructed per call would
   * put a compile in that loop.
   *
   * Measured structurally rather than by timing, because a wall-clock
   * assertion is the kind that goes flaky on a loaded CI box: the module is
   * read and every `new RegExp` in it is required to sit outside the returned
   * closure. `redact` is the closure; if the constructor moved inside it, this
   * fails.
   */
  test("no RegExp is constructed inside redact()", async () => {
    const src = await Bun.file(
      new URL("../../src/security/redact.ts", import.meta.url).pathname,
    ).text();
    const impl = src.indexOf("redact(serialised: string): string {");
    expect(impl).toBeGreaterThan(0);
    expect(src.slice(impl)).not.toContain("new RegExp");
    // And one IS built at construction, so the claim is not vacuous — a module
    // that stopped using a regex at all would otherwise pass this silently.
    expect(src.slice(0, impl)).toContain("new RegExp");
  });

  test("a flood of unrelated lines is returned untouched", () => {
    const r = one(CANARY);
    for (let i = 0; i < 2000; i++) {
      const line = JSON.stringify({ type: "stderr_line", line: `warning ${i} `.repeat(20) });
      expect(r.redact(line)).toBe(line);
    }
  });
});

describe("the names and the values travel in one file", () => {
  test("parseEnvFile is the exact inverse of the writer's format", () => {
    const m = parseEnvFile(`A=1\nB=has=equals\n\n#comment\nC=\n`);
    expect(m.get("A")).toBe("1");
    expect(m.get("B")).toBe("has=equals");
    expect(m.get("C")).toBe("");
    expect(m.has("#comment")).toBe(false);
  });

  test("a missing env file is an unarmed redactor that says why, not a throw", async () => {
    const r = await redactorForWorkerEnv(
      join(tmpdir(), "pifleet-no-such-env-file-xyz"),
      join(tmpdir(), "pifleet-no-such-secrets-dir-xyz"),
    );
    expect(r.source).toBe("absent");
    expect(r.armed).toEqual([]);
  });

  /**
   * ISC-345. THE REDACTOR FOLLOWS THE VALUES WHEN THE VALUES MOVE.
   *
   * ## This is a regression probe for a leak that actually happened
   *
   * ISC-337..342 moved granted secrets out of the environment and into one
   * 0444 file each. This function kept reading the env file, where the granted
   * name now resolves to nothing, and its `if (value === undefined) continue`
   * dropped every grant in silence. The redactor then reported itself ARMED
   * for names it could not see.
   *
   * It was not caught by review and it was not caught by CI. It was caught by
   * a live worker running `cat` on the curl config it had just built, putting
   * a real 41-character credential into `events.jsonl` five times, on a run
   * whose own first log line named that variable as protected.
   *
   * ## The store is built by the PRODUCTION writer
   *
   * `writeWorkerSecretFiles`, the same call `materializeWorkerInputs` makes, so
   * the layout under test is whatever the writer decides it is. A fixture that
   * hand-wrote the file names would prove this reader agrees with the fixture
   * rather than with the writer — which is the precise reason the original
   * defect survived: every test involved was green against its own idea of
   * where values live.
   *
   * THE CANARY IS SYNTHETIC. Nothing here touches a real credential store.
   */
  test("a secret delivered as a FILE is still scrubbed (ISC-345)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-redact-store-"));
    try {
      const envPath = join(dir, "env");
      const secretsDir = join(dir, "secrets");
      // The env file exactly as `buildWorkerEnv` renders it once delivery
      // moved: the names list, a POINTER, and no value anywhere.
      await writeFile(
        envPath,
        `${SECRET_NAMES_VAR}=TICKET_API_TOKEN\nTICKET_API_TOKEN_FILE=/secrets/TICKET_API_TOKEN\n`,
      );
      await writeWorkerSecretFiles(secretsDir, {
        secretNames: ["TICKET_API_TOKEN"],
        secretFiles: [{ name: "TICKET_API_TOKEN", value: CANARY }],
      } as never);

      const r = await redactorForWorkerEnv(envPath, secretsDir);
      expect(r.source, "the value must come from the store").toBe("store");
      expect(r.armed).toEqual(["TICKET_API_TOKEN"]);
      expect(r.unresolved, "nothing may be left unvalued").toEqual([]);
      // The assertion the leak would have failed.
      expect(r.redact(JSON.stringify({ out: CANARY }))).not.toContain(CANARY);
      // Not a truncated prefix either — `head -c 20` is how the first leak
      // reached the log, and a redactor that only matched whole values would
      // pass the line above while leaving that fragment behind.
      expect(r.redact(JSON.stringify({ out: CANARY.slice(0, 20) }))).not.toContain(
        CANARY.slice(0, 20),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The half that makes the probe above more than a happy path.
   *
   * A granted name with no value in EITHER layout must not be silently
   * dropped. That `continue` is what turned a blinded redactor into a quiet
   * one: the run said "protect TICKET_API_TOKEN", the redactor could not, and
   * nothing anywhere said so.
   */
  test("a granted name that cannot be valued is reported, not skipped (ISC-345)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-redact-blind-"));
    try {
      const envPath = join(dir, "env");
      // Armed by name, pointer only, and an EMPTY store — the exact on-disk
      // shape of the run that leaked.
      await writeFile(
        envPath,
        `${SECRET_NAMES_VAR}=TICKET_API_TOKEN\nTICKET_API_TOKEN_FILE=/secrets/TICKET_API_TOKEN\n`,
      );
      const r = await redactorForWorkerEnv(envPath, join(dir, "secrets"));
      expect(r.unresolved, "the blinding must be visible").toEqual(["TICKET_API_TOKEN"]);
      expect(r.armed, "and it must not claim to be armed for it").toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the redactor arms from a legacy env file that still carries values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-redact-unit-"));
    try {
      const p = join(dir, "env");
      await writeFile(p, `OTHER=plain\n${SECRET_NAMES_VAR}=TICKET_API_TOKEN\nTICKET_API_TOKEN=${CANARY}\n`);
      // No secret store beside it: a run directory written before delivery
      // moved. The fallback is what keeps those runs scrubbing.
      const r = await redactorForWorkerEnv(p, join(dir, "secrets"));
      expect(r.source).toBe("env-file");
      expect(r.armed).toEqual(["TICKET_API_TOKEN"]);
      expect(r.redact(JSON.stringify({ t: CANARY }))).not.toContain(CANARY);
      // A non-secret value in the same file must NOT become a needle: that is
      // how a base URL or a model id turns into a marker in every line.
      expect(r.redact(JSON.stringify({ t: "plain" }))).toContain("plain");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `buildWorkerEnv` is what fills the variable in. Without this the wire
   * format is pinned only by a test that writes the file by hand, so `up`
   * could stop populating it and every other probe would stay green.
   */
  test("buildWorkerEnv declares its granted names in the env file it writes", async () => {
    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "redact-fleet",
        docker: { pi_version: "0.79.6" },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "TestModel" },
        secrets: { env_allowlist: ["TICKET_API_TOKEN"] },
        roles: { ticketer: { secrets: ["TICKET_API_TOKEN"] } },
        workers: [{ id: "wt", role: "ticketer" }],
      }),
      "/tmp/fleet.yaml",
    );
    const apiKeyEnv = loaded.config.llm.api_key_env;
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wt"), {
      TICKET_API_TOKEN: CANARY,
      [apiKeyEnv]: `omlx-${CANARY}`,
    });
    const names = (plan.vars[SECRET_NAMES_VAR] ?? "").split(",");
    expect(names).toContain("TICKET_API_TOKEN");
    // The API key is a Class 1 credential no worker requested and every worker
    // carries, so it is on the redaction list while NOT being on `secretNames`.
    expect(names).toContain(apiKeyEnv);
    expect(plan.secretNames).toEqual(["TICKET_API_TOKEN"]);
    // The declaration carries NAMES only — never a value.
    expect(plan.vars[SECRET_NAMES_VAR]).not.toContain(CANARY);
  });
});
