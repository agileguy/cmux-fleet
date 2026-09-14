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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  buildWorkerEnv,
  writeWorkerEnvFile,
  writeWorkerSecretFiles,
} from "../../src/run/worker-env.ts";
import { parseConfig, resolveWorker } from "../../src/config/load.ts";
import { appendJsonl } from "../../src/util/jsonl.ts";
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
   * A FLEET-SET credential and a GRANTED one, delivered by different means,
   * must BOTH be scrubbed (ISC-345).
   *
   * This probe exists because the first version of the fix failed it. The
   * store and the env file do not hold two copies of one set: the store holds
   * `secrets:` grants, while the env file additionally carries fleet-set
   * credentials that were never grants and are still real variables —
   * `OMLX_API_KEY` chief among them, which is armed because it is a credential
   * but has no file in the store because it is not a `secrets:` entry.
   *
   * A resolver that took the store wholesale whenever the store was non-empty
   * therefore dropped the LLM key from redaction while fixing the grants. That
   * is a fix that trades one silent leak for another, and only a probe holding
   * both kinds at once can tell the difference.
   */
  test("a store-delivered grant and an env-delivered fleet key both scrub (ISC-345)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-redact-both-"));
    try {
      const envPath = join(dir, "env");
      const secretsDir = join(dir, "secrets");
      const FLEET_KEY = "omlx-FAKE-fleet-key-8f3a91c0";
      await writeFile(
        envPath,
        `${SECRET_NAMES_VAR}=OMLX_API_KEY,TICKET_API_TOKEN\n` +
          `OMLX_API_KEY=${FLEET_KEY}\n` +
          `TICKET_API_TOKEN_FILE=/secrets/TICKET_API_TOKEN\n`,
      );
      await writeWorkerSecretFiles(secretsDir, {
        secretNames: ["TICKET_API_TOKEN"],
        secretFiles: [{ name: "TICKET_API_TOKEN", value: CANARY }],
      } as never);

      const r = await redactorForWorkerEnv(envPath, secretsDir);
      expect(r.unresolved, "neither delivery may be dropped").toEqual([]);
      expect([...r.armed].sort()).toEqual(["OMLX_API_KEY", "TICKET_API_TOKEN"]);
      const line = JSON.stringify({ a: CANARY, b: FLEET_KEY });
      expect(r.redact(line)).not.toContain(CANARY);
      expect(r.redact(line), "the env-delivered key must not be lost").not.toContain(FLEET_KEY);
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

/**
 * A MULTI-LINE value, the kind `multiline: true` delivers (commit 8bcb1ed): an
 * OpenSSH private key, a known_hosts list, a targets list.
 *
 * ## The two defects these probes were written against, both measured
 *
 * The redactor was built for single-line tokens. For a value spanning lines it
 * compiled the whole value, escaped, as a truncatable stem of its first twelve
 * characters. That fails in both directions at once.
 *
 * It MISSES a leak. Inside JSON the value's LF is `\n`, so the whole-value form
 * is not a substring of a record that quotes one line of the key (`head -3`,
 * an ssh error echoing a line). The stem does not help: it is the value's
 * first twelve characters, which for a key are armor, not body.
 *
 * And it EATS honest text. That stem, `-----BEGIN O`, is public armor, the
 * same in every key of the type, so a log line saying a BEGIN OPENSSH PRIVATE
 * KEY block was rejected came back as a marker.
 *
 * ## The fixtures are synthetic, and say so
 *
 * The PEM body is base64 of fixture text, wrapped at 70 columns between armor
 * lines with a trailing newline: the layout `ssh-keygen` writes, not its
 * output. The known_hosts "keys" are base64 of fixture text too. Nothing here
 * is key material and nothing reads the real environment.
 */
describe("a multi-line value is scrubbed line by line, and its armor is left alone", () => {
  /** An invented base64-looking PEM body, wrapped at 70 columns. */
  function fakeBody(seed: string): string[] {
    return Buffer.from(
      Array.from({ length: 9 }, (_, i) => `pifleet-redact-fixture-${seed}-not-a-key-${i};`).join(""),
    )
      .toString("base64")
      .match(/.{1,70}/g)!;
  }

  function pemFake(label: string, seed: string): string {
    return [`-----BEGIN ${label}-----`, ...fakeBody(seed), `-----END ${label}-----`, ""].join("\n");
  }

  const KEY_NAME = "OBSERVER_DOCKER_SSH_KEY";
  const KEY = pemFake("OPENSSH PRIVATE KEY", "ssh");
  const KEY_MARKER = `[redacted:${KEY_NAME}]`;

  const KH_NAME = "OBSERVER_DOCKER_KNOWN_HOSTS";
  // A blank and a whitespace-only line in the middle, as a hand-edited file has.
  const KNOWN_HOSTS = [
    `gw-1.example.invalid ssh-ed25519 ${Buffer.from("pifleet-fixture-hostkey-gw-1-not-real").toString("base64")}`,
    "",
    "   ",
    `[bastion.example.invalid]:2222 ssh-ed25519 ${Buffer.from("pifleet-fixture-hostkey-bastion-not-real").toString("base64")}`,
    "",
  ].join("\n");

  const TARGETS_NAME = "OBSERVER_DOCKER_TARGETS";
  const TARGETS = "web-1 10.0.0.5 22 observer\nweb-1 10.0.0.5 22 observer-backup\n";

  /**
   * A line holding `"` and `\`, which JSON escapes. For base64 and host lines
   * the escaped and double-escaped forms are the same string, so without this
   * a probe of the double-escaped form could not tell the two apart.
   */
  const ESC_NAME = "SYNTHETIC_MULTILINE_ESCAPES";
  const ESCAPING = 'first-line-no-escapes-0001\nlabel="edge\\west" host-a.example.invalid\n';

  /**
   * The test's OWN statement of a secret line, written from the brief rather
   * than imported, so a helper that drifted would be caught rather than copied.
   */
  const TEST_ARMOR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;
  function secretLinesOf(value: string): string[] {
    const lines = value
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !TEST_ARMOR.test(l) && l.length >= MIN_REDACTABLE_LENGTH);
    return [...new Set(lines)];
  }

  const CASES: Array<[string, string]> = [
    [KEY_NAME, KEY],
    [KH_NAME, KNOWN_HOSTS],
    [ESC_NAME, ESCAPING],
  ];

  function jsonInner(s: string): string {
    return JSON.stringify(s).slice(1, -1);
  }

  test("the fixtures have the shape they claim", () => {
    const lines = KEY.split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(lines.at(-2)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(lines.at(-1)).toBe("");
    expect(secretLinesOf(KEY).length).toBeGreaterThanOrEqual(4);
    expect(secretLinesOf(KNOWN_HOSTS)).toHaveLength(2);
    expect(secretLinesOf(ESCAPING)).toHaveLength(2);
    // The escaping line really is different once double-escaped.
    const esc = secretLinesOf(ESCAPING)[1]!;
    expect(jsonInner(jsonInner(esc))).not.toBe(jsonInner(esc));
  });

  test("each secret line is scrubbed when quoted whole, and the marker names the variable", () => {
    for (const [name, value] of CASES) {
      const r = one(value, name);
      for (const line of secretLinesOf(value)) {
        const out = r.redact(JSON.stringify({ text: `ssh said: ${line} (rejected)` }));
        expect(out, `${name}: ${line.slice(0, 16)}`).toBe(
          JSON.stringify({ text: `ssh said: [redacted:${name}] (rejected)` }),
        );
      }
    }
  });

  /**
   * Down to the floor, in the escaped AND the double-escaped form. A cut is a
   * prefix of the RAW line, so its escaped form is a prefix of the line's
   * escaped form; cuts are chosen so the next raw character is not a quote or a
   * backslash, which keeps the expected record exact.
   */
  test("each secret line is scrubbed when TRUNCATED to the floor, escaped and double-escaped", () => {
    for (const [name, value] of CASES) {
      const r = one(value, name);
      const marker = `[redacted:${name}]`;
      for (const line of secretLinesOf(value)) {
        const cuts = [...new Set([line.length, line.length - 1, 20, TRUNCATION_FLOOR])].filter(
          (c) => c >= TRUNCATION_FLOOR && c <= line.length,
        );
        for (const cut of cuts) {
          const frag = line.slice(0, cut);
          const label = `${name} cut ${cut}: ${frag.slice(0, 16)}`;
          expect(r.redact(JSON.stringify({ text: frag })), label).toBe(
            JSON.stringify({ text: marker }),
          );
          expect(r.redact(JSON.stringify({ text: JSON.stringify({ line: frag }) })), label).toBe(
            JSON.stringify({ text: JSON.stringify({ line: marker }) }),
          );
        }
        // And below the floor, left alone, exactly as for a single-line value.
        // The floor counts ESCAPED characters, so the cut is the longest raw
        // prefix whose escaped form is still under it.
        let k = 0;
        while (jsonInner(line.slice(0, k + 1)).length < TRUNCATION_FLOOR) k++;
        const short = JSON.stringify({ text: line.slice(0, k) });
        expect(k).toBeGreaterThan(0);
        expect(r.redact(short)).toBe(short);
      }
    }
  });

  test("the whole value quoted in full is ONE marker, not a marker per line", () => {
    const r = one(KEY, KEY_NAME);
    // Exact, so this also pins ordering: were the line forms tried first, the
    // armor would survive between per-line markers.
    expect(r.redact(JSON.stringify({ text: `$ cat key\n${KEY}` }))).toBe(
      JSON.stringify({ text: `$ cat key\n${KEY_MARKER}` }),
    );
    expect(r.redact(JSON.stringify({ text: JSON.stringify({ key: KEY }) }))).toBe(
      JSON.stringify({ text: JSON.stringify({ key: KEY_MARKER }) }),
    );
  });

  test("a whole value missing its trailing newline still loses every secret line", () => {
    // `cat` output a tool trimmed: the whole-value form no longer matches, so
    // the per-line forms are what stands between the body and the log.
    const trimmed = KEY.trimEnd();
    const out = one(KEY, KEY_NAME).redact(JSON.stringify({ text: trimmed }));
    for (const line of secretLinesOf(KEY)) expect(out).not.toContain(line);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  /**
   * Armor is public. A record whose ONLY overlap with the key is armor comes
   * back byte-identical, for every common key type, including every leading
   * run of the whole value that stops before twelve characters of body.
   */
  test("honest armor text is byte-identical, for every key type and every armor stem", () => {
    const labels = [
      "OPENSSH PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "DSA PRIVATE KEY",
      "PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "PGP PRIVATE KEY BLOCK",
    ];
    for (const label of labels) {
      const value = pemFake(label, label.replaceAll(" ", "-"));
      const r = one(value, KEY_NAME);
      const begin = `-----BEGIN ${label}-----`;
      const end = `-----END ${label}-----`;
      const firstBody = value.split("\n")[1]!;
      const texts = [
        `sshd said: ${begin} block rejected`,
        begin,
        end,
        `${begin}\n${end}`,
        `${end}\n`,
        // Every leading run of the whole value up to the body, plus a body
        // fragment below the floor: the stems a truncated whole-value form
        // would have matched.
        ...Array.from({ length: begin.length + 1 }, (_, i) => value.slice(0, i + 1)),
        `${begin}\n${firstBody.slice(0, TRUNCATION_FLOOR - 1)}`,
      ];
      for (const text of texts) {
        for (const line of [
          JSON.stringify({ text }),
          JSON.stringify({ text: JSON.stringify({ text }) }),
        ]) {
          expect(r.redact(line), `${label}: ${JSON.stringify(text).slice(0, 40)}`).toBe(line);
        }
      }
    }
  });

  test("a multi-line name is armed once, not once per line, beside a single-line one", () => {
    const r = buildRedactor([
      [KEY_NAME, KEY],
      [KH_NAME, KNOWN_HOSTS],
      ["TICKET_API_TOKEN", CANARY],
    ]);
    expect(r.armed).toEqual([KEY_NAME, KH_NAME, "TICKET_API_TOKEN"]);
    expect(r.skipped).toEqual([]);
    const body = secretLinesOf(KEY)[2]!;
    const host = secretLinesOf(KNOWN_HOSTS)[1]!;
    expect(r.redact(JSON.stringify({ a: body, b: host, c: CANARY }))).toBe(
      JSON.stringify({ a: KEY_MARKER, b: `[redacted:${KH_NAME}]`, c: "[redacted:TICKET_API_TOKEN]" }),
    );
  });

  test("LONGEST FIRST holds between lines: a line that begins with another leaves no tail", () => {
    const r = one(TARGETS, TARGETS_NAME);
    expect(r.redact(JSON.stringify({ text: "web-1 10.0.0.5 22 observer-backup" }))).toBe(
      JSON.stringify({ text: `[redacted:${TARGETS_NAME}]` }),
    );
  });

  /**
   * THE COST, pinned so a change to it is deliberate. The redactor sees names
   * and values, not `credential: false`, so a targets list is scrubbed like a
   * key. Per-line matching means any leading run of twelve or more characters
   * of a targets line is replaced, and that includes a DIFFERENT host that
   * shares the first twelve characters.
   */
  test("the targets-file cost: any 12-character leading run of a target line is scrubbed", () => {
    const r = one(TARGETS, TARGETS_NAME);
    const m = `[redacted:${TARGETS_NAME}]`;
    const cases: Array<[string, string]> = [
      ["probe web-1 10.0.0.5 22 observer ok", `probe ${m} ok`],
      ["ssh-connect: web-1 10.0.0.5 22 refused", `ssh-connect: ${m}refused`],
      // The greedy tail takes the shared `.` too, so only the differing digit survives.
      ["unrelated host web-1 10.0.0.7 is up", `unrelated host ${m}7 is up`],
      // Under the floor, or not a leading run: untouched.
      ["web-1 10.0. is short", "web-1 10.0. is short"],
      ["10.0.0.5 22 observer", "10.0.0.5 22 observer"],
    ];
    for (const [input, expected] of cases) {
      expect(r.redact(JSON.stringify({ text: input }))).toBe(JSON.stringify({ text: expected }));
    }
  });

  /**
   * END TO END, with no hand-built plan: a config whose allowlist entries say
   * `multiline: true`, delivered by `buildWorkerEnv`, written by the two writers
   * `materialize.ts` calls, armed by `redactorForWorkerEnv`, and applied by
   * `appendJsonl` with the same `transform` the supervisor passes.
   */
  test("a key delivered through multiline: true is scrubbed line by line from events.jsonl", async () => {
    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "redact-multiline-fleet",
        docker: { pi_version: "0.79.6" },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "TestModel" },
        secrets: {
          env_allowlist: [
            { name: KEY_NAME, multiline: true },
            { name: KH_NAME, multiline: true },
            { name: TARGETS_NAME, credential: false, multiline: true },
          ],
        },
        roles: { dockerobs: { secrets: [KEY_NAME, KH_NAME, TARGETS_NAME] } },
        workers: [{ id: "wd", role: "dockerobs" }],
      }),
      "/tmp/fleet.yaml",
    );
    const apiKeyEnv = loaded.config.llm.api_key_env;
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "wd"), {
      [KEY_NAME]: KEY,
      [KH_NAME]: KNOWN_HOSTS,
      [TARGETS_NAME]: TARGETS,
      [apiKeyEnv]: `omlx-${CANARY}`,
    });

    const dir = await mkdtemp(join(tmpdir(), "pifleet-redact-multiline-"));
    try {
      const envPath = join(dir, "env");
      const secretsDir = join(dir, "secrets");
      const eventsPath = join(dir, "events.jsonl");
      await writeWorkerSecretFiles(secretsDir, plan);
      await writeWorkerEnvFile(envPath, plan);

      const r = await redactorForWorkerEnv(envPath, secretsDir);
      expect(r.source).toBe("store");
      expect(r.unresolved).toEqual([]);
      for (const name of [KEY_NAME, KH_NAME, TARGETS_NAME]) {
        expect(r.armed.filter((n) => n === name), name).toHaveLength(1);
      }

      // `head -3 key`, then an ssh error quoting a known_hosts line.
      const head3 = KEY.split("\n").slice(0, 3).join("\n");
      const host = secretLinesOf(KNOWN_HOSTS)[0]!;
      const record = {
        ts: "2026-09-14T00:00:00.000Z",
        type: "tool_execution_end",
        result: { content: [{ type: "text", text: `${head3}\nssh: bad host line ${host}` }] },
      };
      await appendJsonl(eventsPath, record, { transform: (line) => r.redact(line) });

      const onDisk = await readFile(eventsPath, "utf8");
      // CONTROL: the fixture really did put key material in the record.
      expect(JSON.stringify(record)).toContain(secretLinesOf(KEY)[0]!);
      for (const line of [...secretLinesOf(KEY).slice(0, 2), host]) {
        expect(onDisk).not.toContain(line);
      }
      const text = (JSON.parse(onDisk) as typeof record).result.content[0]!.text;
      expect(text).toBe(
        `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_MARKER}\n${KEY_MARKER}\n` +
          `ssh: bad host line [redacted:${KH_NAME}]`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
