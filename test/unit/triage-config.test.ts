/**
 * `triage/console.yaml` — the contract, the defaults, and the credential refusal
 * (SRD-TRIAGE-CONSOLE §7.8, §6.9; §13 tasks 3.3 and 3.4).
 *
 * ## Three things this file asserts that a weaker version would not
 *
 * **1. The defaults are asserted as a WHOLE OBJECT, not field by field.**
 * §12 asks for *"every field of §7.8's table"*, and a per-field battery grows a
 * hole the moment someone adds a tenth knob: the new field has a default nobody
 * checked, which is the exact failure §7.8 was written against — *"a default
 * with no contract is a default that becomes a literal in whichever module reads
 * it first."* `toEqual` on the whole document fails when a field is ADDED as
 * well as when one changes, so the contract cannot grow silently.
 *
 * **2. Every accept fixture is a NEAR MISS of a refuse fixture.** This
 * repository's MEMORY carries the defect that makes a filter untestable — *"a
 * filter or intersection survives mutation whenever every fixture makes the two
 * sets equal"* — and the endpoint refusal is a filter. So the accepted endpoints
 * here are not just the default: `http://localhost:8080/Alerts` is accepted
 * (which kills `raw === DEFAULT_NOTIFY_ENDPOINT`), `https://host/Alerts` with a
 * bare `?` is accepted (which kills `raw.includes("?")`), and both a
 * username-only and a password-only URL are refused (which kills a check
 * written on `url.username` alone — the half a single fixture would never
 * reach).
 *
 * **3. The refusals are asserted NOT to echo the secret.** A message that
 * quotes `?auth=tk_live_…` back is a credential in `~/.pifleet/triage.log`,
 * which is one of the three places §7.8 property 3 exists to keep it out of. So
 * the credential fixtures use a distinctive token and the assertion is that the
 * refusal does not contain it — the refusal and the leak are separable, and
 * only one of them is tested by "does it throw".
 *
 * ## What the `token_env` tests are actually for
 *
 * They assert the message is `envVarNameIssue`'s **exact output**, computed by
 * calling that function in the test rather than pasted as a literal. That is
 * §12's *"driving the shared function, not a copy of its rules"*, and it is the
 * one assertion here whose red comes from mutating a DIFFERENT file: change
 * `src/config/schema.ts:672` and these go red, which is what a copy of the rules
 * would not do.
 *
 * No subprocess is spawned anywhere in this file and nothing touches the real
 * filesystem — the one read is an injected dep — so no `budget.ts` allowance
 * applies.
 */

import { describe, expect, test } from "bun:test";

import { ConfigValidationError, type FieldIssue } from "../../src/config/load.ts";
import { envVarNameIssue } from "../../src/config/schema.ts";
import {
  DEFAULT_NOTIFY,
  DEFAULT_NOTIFY_ENDPOINT,
  DEFAULT_TRIAGE_CONFIG_DEPS,
  NotifyConfigSchema,
  TRIAGE_CONSOLE_SCHEMA,
  TriageConsoleConfigSchema,
  defaultTriageConsoleConfig,
  loadTriageConsoleConfig,
  notifyEndpointIssue,
  parseTriageConsoleConfig,
  reserveFitsCadenceIssue,
  sweepDeadlineS,
  type TriageConsoleConfig,
} from "../../src/run/triage-config.ts";

const CONSOLE_PATH = "triage/console.yaml";

/**
 * §7.8's table, written out once so `toEqual` can fail on an ADDED field too.
 *
 * Annotated `TriageConsoleConfig` rather than inferred, so a tenth knob is
 * caught by `bun run typecheck` as well as by the assertions — a missing
 * property is a type error here, and a default that changed is a `toEqual`
 * failure below. Two independent alarms on the same drift.
 */
const DOCUMENTED_DEFAULTS: TriageConsoleConfig = {
  version: 1,
  cadence_s: 300,
  reserve_s: 60,
  max_consecutive_skips: 3,
  recycle_after_sweeps: 48,
  flap_threshold: 3,
  flap_window_s: 3_600,
  renotify_after_s: 21_600,
  notify: {
    endpoint: "https://ntfy.agileguy.ca/Alerts",
    adapter: "ntfy",
    timeout_ms: 5_000,
    token_env: null,
    max_retry_sweeps: 12,
    priority: { open: 4, recover: 3, flapping: 3, console_health: 4 },
  },
};

function parse(yaml: string): TriageConsoleConfig {
  return parseTriageConsoleConfig(yaml, CONSOLE_PATH);
}

/** The issues a refusal carried, or a failure saying the parse succeeded. */
function issuesFor(yaml: string): FieldIssue[] {
  try {
    parseTriageConsoleConfig(yaml, CONSOLE_PATH);
  } catch (err) {
    if (err instanceof ConfigValidationError) return err.issues;
    throw err;
  }
  throw new Error(`expected ${CONSOLE_PATH} to be refused, but it parsed`);
}

/** One issue BY PATH — never by index, so "some issue fired" cannot pass for the right one. */
function issueAt(yaml: string, path: string): FieldIssue {
  const issues = issuesFor(yaml);
  const found = issues.find((i) => i.path === path);
  if (found === undefined) {
    throw new Error(
      `expected an issue at "${path}"; got ${JSON.stringify(issues.map((i) => i.path))}`,
    );
  }
  return found;
}

/** A `notify:` block with one field overridden, as YAML. */
function withEndpoint(endpoint: string): string {
  return `version: 1\nnotify:\n  endpoint: ${JSON.stringify(endpoint)}\n`;
}

// ---------------------------------------------------------------------------

describe("the console config contract (§7.8)", () => {
  test("the document tag is checked by name", () => {
    expect(TRIAGE_CONSOLE_SCHEMA).toBe("pifleet.triageconsole/v1");
  });

  test("a written file round-trips, and unwritten fields take the documented defaults", () => {
    const cfg = parse(`
version: 1
cadence_s: 600
renotify_after_s: 0
notify:
  endpoint: https://ntfy.example.test/Ops
  adapter: json
  token_env: NTFY_TOKEN
  priority:
    open: 5
`);
    expect(cfg.cadence_s).toBe(600);
    expect(cfg.renotify_after_s).toBe(0);
    // Untouched knobs keep the table's values rather than becoming undefined.
    expect(cfg.reserve_s).toBe(60);
    expect(cfg.flap_window_s).toBe(3_600);
    expect(cfg.notify).toEqual({
      endpoint: "https://ntfy.example.test/Ops",
      adapter: "json",
      timeout_ms: 5_000,
      token_env: "NTFY_TOKEN",
      max_retry_sweeps: 12,
      // The three unwritten priorities default; only `open` moved.
      priority: { open: 5, recover: 3, flapping: 3, console_health: 4 },
    });
  });

  test("an unknown key is a FIELD-LEVEL error naming the key, never an ignored typo", () => {
    const issue = issueAt("version: 1\ncadance_s: 300\n", "cadance_s");
    expect(issue.message).toContain("unrecognized key");
  });

  test("a version this build does not implement is refused", () => {
    expect(issueAt("version: 2\n", "version").message).toBeTruthy();
  });

  test("a file that says anything must declare its version", () => {
    expect(issueAt("cadence_s: 600\n", "version").message).toBeTruthy();
  });

  test("a refusal names the file it came from", () => {
    let caught: unknown;
    try {
      parse("version: 1\nnope: 1\n");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect((caught as ConfigValidationError).file).toBe(CONSOLE_PATH);
    expect((caught as ConfigValidationError).message).toContain(CONSOLE_PATH);
  });

  test("a file that is not YAML is refused with the file named", () => {
    const issue = issueAt("version: 1\n  bad: [\n", "");
    expect(issue.message).toContain("not valid YAML");
  });

  test("each field's bounds are the documented ones", () => {
    expect(issueAt("version: 1\ncadence_s: 59\n", "cadence_s").message).toBeTruthy();
    expect(issueAt("version: 1\ncadence_s: 3601\n", "cadence_s").message).toBeTruthy();
    expect(issueAt("version: 1\nreserve_s: 14\n", "reserve_s").message).toBeTruthy();
    expect(issueAt("version: 1\nflap_threshold: 1\n", "flap_threshold").message).toBeTruthy();
    expect(issueAt("version: 1\ncadence_s: 300.5\n", "cadence_s").message).toBeTruthy();
    expect(
      issueAt("version: 1\nnotify:\n  timeout_ms: 999\n", "notify.timeout_ms").message,
    ).toBeTruthy();
    expect(
      issueAt("version: 1\nnotify:\n  adapter: slack\n", "notify.adapter").message,
    ).toBeTruthy();
    expect(
      issueAt("version: 1\nnotify:\n  priority:\n    open: 6\n", "notify.priority.open").message,
    ).toBeTruthy();
    expect(
      issueAt("version: 1\nnotify:\n  priority:\n    urgent: 5\n", "notify.priority.urgent")
        .message,
    ).toContain("unrecognized key");
  });
});

describe("sweep_deadline_s is COMPUTED and is not a field (§7.8 property 1)", () => {
  test("Anti: writing the key is a field-level error naming it", () => {
    const issue = issueAt("version: 1\nsweep_deadline_s: 240\n", "sweep_deadline_s");
    expect(issue.message).toContain("unrecognized key");
    // The message teaches the fix rather than merely refusing the key.
    expect(issue.message).toContain("cadence_s - reserve_s");
    expect(issue.message).toContain("reserve_s");
  });

  test("sweepDeadlineS is the subtraction, and it tracks BOTH fields", () => {
    expect(sweepDeadlineS({ cadence_s: 300, reserve_s: 60 })).toBe(240);
    // A second pair, because `=> 240` and `=> cadence_s - 60` both pass the first.
    expect(sweepDeadlineS({ cadence_s: 600, reserve_s: 120 })).toBe(480);
    expect(sweepDeadlineS({ cadence_s: 600, reserve_s: 60 })).toBe(540);
  });

  test("the shipped defaults compute §6.5's 240-second deadline", () => {
    expect(sweepDeadlineS(defaultTriageConsoleConfig())).toBe(240);
  });

  test("§6.5's `deadline >= cadence` arm is unreachable across the whole field range", () => {
    // `reserve_s.min(15)` is what makes this true; it is asserted, not claimed.
    for (const cadence_s of [60, 300, 3_600]) {
      for (const reserve_s of [15, 60, 59]) {
        if (reserve_s >= cadence_s) continue;
        expect(sweepDeadlineS({ cadence_s, reserve_s })).toBeLessThan(cadence_s);
      }
    }
  });
});

describe("reserve_s must fit inside the cadence (§6.5)", () => {
  test("a reserve wider than the cadence is refused, and the message names both fields", () => {
    const issue = issueAt("version: 1\ncadence_s: 60\nreserve_s: 600\n", "reserve_s");
    expect(issue.message).toContain("reserve_s");
    expect(issue.message).toContain("cadence_s");
    expect(issue.message).toContain("sweep_deadline_s");
  });

  test("EQUAL is refused — a zero-second deadline is not a deadline", () => {
    expect(issueAt("version: 1\ncadence_s: 60\nreserve_s: 60\n", "reserve_s").message).toBeTruthy();
  });

  test("one second under is accepted, so the bound is `<` and not something looser", () => {
    const cfg = parse("version: 1\ncadence_s: 60\nreserve_s: 59\n");
    expect(sweepDeadlineS(cfg)).toBe(1);
  });

  test("the pure function is the refusal, and it is total over the field ranges", () => {
    expect(reserveFitsCadenceIssue(300, 60)).toBeNull();
    expect(reserveFitsCadenceIssue(60, 59)).toBeNull();
    expect(reserveFitsCadenceIssue(60, 60)).not.toBeNull();
    expect(reserveFitsCadenceIssue(60, 600)).not.toBeNull();
  });
});

describe("the shipped defaults are the documented ones (§7.8's table)", () => {
  test("an EMPTY file resolves to every value in the table", () => {
    expect(parse("")).toEqual(DOCUMENTED_DEFAULTS);
  });

  test("a comments-only file is the same empty document", () => {
    expect(parse("# nothing configured yet\n")).toEqual(DOCUMENTED_DEFAULTS);
  });

  test("a file carrying only `version: 1` — §13 task 3.6's tracked example — is the same", () => {
    expect(parse("version: 1\n")).toEqual(DOCUMENTED_DEFAULTS);
  });

  test("the default endpoint is the SPELLING that was measured, not the commission's typo", () => {
    // `agleguy.ca` is NXDOMAIN (§6.9, measured 2026-09-06). One missing `i`
    // would have failed DNS on every notification forever.
    expect(DEFAULT_NOTIFY_ENDPOINT).toBe("https://ntfy.agileguy.ca/Alerts");
    expect(DEFAULT_NOTIFY.endpoint).toBe("https://ntfy.agileguy.ca/Alerts");
  });

  test("token_env defaults to null, so the shipped default REFUSES rather than carrying a key", () => {
    // §11 Q11: an anonymous read of that topic returned 403. The console ships
    // needing a credential it does not have, and that is the design.
    expect(DEFAULT_NOTIFY.token_env).toBeNull();
  });

  test("defaultTriageConsoleConfig hands out a fresh document each time", () => {
    const a = defaultTriageConsoleConfig();
    const b = defaultTriageConsoleConfig();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.cadence_s = 999;
    expect(defaultTriageConsoleConfig().cadence_s).toBe(300);
  });

  test("a parsed config never aliases the exported DEFAULT_NOTIFY, at ANY depth", () => {
    /*
     * The NESTED assertion is the one that earns its place, and it was added
     * because the shallow version passed under mutation. Measured on zod 4.1:
     * `.default(value)` SHALLOW-copies — the returned `notify` is a fresh
     * object, so `not.toBe` and a top-level write both pass — but
     * `notify.priority` is the very same object the constant holds. So a caller
     * writing `cfg.notify.priority.open = 5` would rewrite the exported
     * constant and every subsequent parse in the process.
     */
    const cfg = parse("version: 1\n");
    expect(cfg.notify).toEqual(DEFAULT_NOTIFY);
    expect(cfg.notify).not.toBe(DEFAULT_NOTIFY);
    expect(cfg.notify!.priority).not.toBe(DEFAULT_NOTIFY.priority);

    cfg.notify!.timeout_ms = 1_234;
    cfg.notify!.priority.open = 1;
    expect(DEFAULT_NOTIFY.timeout_ms).toBe(5_000);
    expect(DEFAULT_NOTIFY.priority.open).toBe(4);
    expect(parse("version: 1\n").notify!.timeout_ms).toBe(5_000);
    expect(parse("version: 1\n").notify!.priority.open).toBe(4);
  });

  test("DEFAULT_NOTIFY is the schema's own output, so the two doors cannot drift", () => {
    // `notify:` absent takes DEFAULT_NOTIFY; `notify: {}` takes the field
    // defaults. A literal DEFAULT_NOTIFY would let those two spellings of "the
    // default block" diverge by one field.
    expect(parse("version: 1\nnotify: {}\n").notify).toEqual(DEFAULT_NOTIFY);
    expect(parse(withEndpoint(DEFAULT_NOTIFY_ENDPOINT)).notify).toEqual(DEFAULT_NOTIFY);
    expect(NotifyConfigSchema.parse({})).toEqual(DEFAULT_NOTIFY);
  });

  test("a notify block that changes only the token keeps the default endpoint", () => {
    // §11 Q11's edit: the shipped endpoint needs a credential, so `token_env`
    // alone is the most likely thing anyone ever writes into this block.
    const notify = parse("version: 1\nnotify:\n  token_env: NTFY_TOKEN\n").notify!;
    expect(notify.endpoint).toBe(DEFAULT_NOTIFY_ENDPOINT);
    expect(notify.token_env).toBe("NTFY_TOKEN");
  });
});

describe("`notify: null` disables; `notify:` absent enables the default (§6.9 requirement 7)", () => {
  test("null is a disabled channel, not a missing one", () => {
    expect(parse("version: 1\nnotify: null\n").notify).toBeNull();
  });

  test("absent is the default block", () => {
    expect(parse("version: 1\n").notify).toEqual(DOCUMENTED_DEFAULTS.notify);
  });

  test("the two are never the same value", () => {
    // `FreshDispatchDeps.quiesce`'s docblock records this exact confusion —
    // "an omitted optional field and a console that genuinely has no relay look
    // identical at the call site". Here they must not.
    expect(parse("version: 1\nnotify: null\n").notify).not.toEqual(
      parse("version: 1\n").notify,
    );
  });

  test("a disabled channel does not disable the console's other knobs", () => {
    const cfg = parse("version: 1\nnotify: null\ncadence_s: 900\n");
    expect(cfg.notify).toBeNull();
    expect(cfg.cadence_s).toBe(900);
    expect(sweepDeadlineS(cfg)).toBe(840);
  });
});

describe("notify.token_env is guarded by the fleet's own function (§6.9 requirement 4)", () => {
  /*
   * Each expected message is COMPUTED by calling `envVarNameIssue`, never
   * pasted. That is what separates "this field is guarded" from "this field has
   * a copy of the guard's rules": mutate `src/config/schema.ts:672` and these
   * go red, which a pasted literal would not.
   */
  test("a reserved PREFIX is refused with the shared function's message", () => {
    const issue = issueAt("version: 1\nnotify:\n  token_env: PIFLEET_X\n", "notify.token_env");
    expect(issue.message).toBe(envVarNameIssue("PIFLEET_X", "notify.token_env")!);
  });

  test("a reserved NAME is refused with the shared function's message", () => {
    const issue = issueAt("version: 1\nnotify:\n  token_env: PATH\n", "notify.token_env");
    expect(issue.message).toBe(envVarNameIssue("PATH", "notify.token_env")!);
  });

  test("a non-identifier is refused with the shared function's message", () => {
    const issue = issueAt("version: 1\nnotify:\n  token_env: 'tk-live'\n", "notify.token_env");
    expect(issue.message).toBe(envVarNameIssue("tk-live", "notify.token_env")!);
  });

  test("the message says the value is read from the environment and never written in config", () => {
    const issue = issueAt("version: 1\nnotify:\n  token_env: 'tk-live'\n", "notify.token_env");
    expect(issue.message).toContain("never written in config");
  });

  test("a plain name is accepted", () => {
    expect(parse("version: 1\nnotify:\n  token_env: NTFY_TOKEN\n").notify!.token_env).toBe(
      "NTFY_TOKEN",
    );
  });

  test("the other reserved prefixes reach this door too", () => {
    // `GIT_CONFIG_` carries its trailing underscore, so the bare `GIT_CONFIG`
    // is NOT reserved — a fixture list written from memory got that wrong once
    // here, which is itself evidence these run against the shared rules.
    expect(envVarNameIssue("GIT_CONFIG", "notify.token_env")).toBeNull();
    for (const name of [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_CORE_PROJECT",
      "GIT_CONFIG_GLOBAL",
      "HOME",
    ]) {
      const issue = issueAt(
        `version: 1\nnotify:\n  token_env: ${name}\n`,
        "notify.token_env",
      );
      expect(issue.message).toBe(envVarNameIssue(name, "notify.token_env")!);
    }
  });
});

describe("Anti: notify.endpoint cannot carry a credential (§7.8 property 3; task 3.4)", () => {
  /** §12's three fixtures. The query one is the priority — ntfy documents it. */
  const QUERY_FIXTURE = "https://host.test/Alerts?auth=tk_LEAKED_SECRET";
  const USERINFO_FIXTURE = "https://ops:tk_LEAKED_SECRET@host.test/Alerts";
  const SCHEME_FIXTURE = "ftp://host.test/Alerts";

  test("a QUERY STRING is refused at load, and the message says why ntfy makes it likely", () => {
    const issue = issueAt(withEndpoint(QUERY_FIXTURE), "notify.endpoint");
    expect(issue.message).toContain("query string");
    expect(issue.message).toContain("auth=");
    expect(issue.message).toContain("token_env");
  });

  test("the query refusal does not itself write the token to the log it protects", () => {
    // The refusal is printed by `config validate` and appended to
    // ~/.pifleet/triage.log (§7.7). Echoing the value back would put the
    // credential in the file the refusal exists to keep it out of.
    const issue = issueAt(withEndpoint(QUERY_FIXTURE), "notify.endpoint");
    expect(issue.message).not.toContain("tk_LEAKED_SECRET");
    expect(notifyEndpointIssue(QUERY_FIXTURE)).not.toContain("tk_LEAKED_SECRET");
  });

  test("USERINFO is refused at load, and the message names it as a credential in a tracked file", () => {
    const issue = issueAt(withEndpoint(USERINFO_FIXTURE), "notify.endpoint");
    expect(issue.message).toContain("userinfo");
    expect(issue.message).toContain("triage/console.yaml");
    expect(issue.message).toContain("token_env");
  });

  test("the userinfo refusal masks the secret but keeps the host and path readable", () => {
    const message = notifyEndpointIssue(USERINFO_FIXTURE)!;
    expect(message).not.toContain("tk_LEAKED_SECRET");
    expect(message).toContain("***@host.test/Alerts");
  });

  test("BOTH halves of userinfo are refused, not just the username", () => {
    // A check written on `url.username` alone passes the password-only URL,
    // which is the half a single `user:pass@` fixture can never reach.
    expect(notifyEndpointIssue("https://ops@host.test/Alerts")).not.toBeNull();
    expect(notifyEndpointIssue("https://:tk_LEAKED_SECRET@host.test/Alerts")).not.toBeNull();
    expect(notifyEndpointIssue("https://:tk_LEAKED_SECRET@host.test/Alerts")).not.toContain(
      "tk_LEAKED_SECRET",
    );
  });

  test("a non-HTTP SCHEME is refused at load, and the message says the value is dialed", () => {
    const issue = issueAt(withEndpoint(SCHEME_FIXTURE), "notify.endpoint");
    expect(issue.message).toContain("http: or https:");
    expect(issue.message).toContain("ftp:");
  });

  test("the schemes a well-formedness check would have admitted are refused", () => {
    // `z.string().url()` accepts every one of these — measured. The rule is
    // about what `fetch` will be asked to do, not about well-formedness.
    for (const raw of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gopher://host.test/Alerts",
      "data:text/plain,hello",
    ]) {
      expect(notifyEndpointIssue(raw)).not.toBeNull();
    }
  });

  test("a string that is not a URL is refused, and nothing of it is quoted back", () => {
    const message = notifyEndpointIssue("tk_LEAKED_SECRET not a url")!;
    expect(message).toContain("not a URL");
    expect(message).not.toContain("tk_LEAKED_SECRET");
  });

  test("the endpoints an operator legitimately wants are ACCEPTED", () => {
    // Near misses of the three refusals, so the filter cannot be "anything but
    // the default" or "anything without a ?" or "https only".
    for (const raw of [
      DEFAULT_NOTIFY_ENDPOINT,
      "http://localhost:8080/Alerts",
      "https://ntfy.sh/my-topic",
      "https://host.test:8443/Alerts",
      "https://host.test/Alerts?",
      "https://host.test/Alerts#frag",
    ]) {
      expect(notifyEndpointIssue(raw)).toBeNull();
      expect(parse(withEndpoint(raw)).notify!.endpoint).toBe(raw);
    }
  });

  test("the endpoint is stored VERBATIM — the path is the ntfy topic (§6.9)", () => {
    // §6.9: the adapter "never rewrites the configured URL", because POSTing
    // JSON to a topic URL is silently accepted and becomes the message text.
    const raw = "https://ntfy.example.test/a/b/Alerts";
    expect(parse(withEndpoint(raw)).notify!.endpoint).toBe(raw);
  });

  test("an empty endpoint is refused rather than defaulted", () => {
    expect(issuesFor("version: 1\nnotify:\n  endpoint: ''\n").length).toBeGreaterThan(0);
  });
});

describe("loading: a missing file is the defaults, and it is the SAME code path", () => {
  function readingNull(): { deps: { readText: (p: string) => Promise<string | null> }; seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      deps: {
        readText: async (p: string) => {
          seen.push(p);
          return null;
        },
      },
    };
  }

  test("a missing file resolves to exactly what an empty file resolves to", async () => {
    const { deps } = readingNull();
    const loaded = await loadTriageConsoleConfig({ configPath: CONSOLE_PATH, deps });
    expect(loaded).toEqual(DOCUMENTED_DEFAULTS);
    expect(loaded).toEqual(parse(""));
  });

  test("the read is given the path it was asked for", async () => {
    const { deps, seen } = readingNull();
    await loadTriageConsoleConfig({ configPath: "/etc/pifleet/console.yaml", deps });
    expect(seen).toEqual(["/etc/pifleet/console.yaml"]);
  });

  test("a present file is parsed, not defaulted", async () => {
    const loaded = await loadTriageConsoleConfig({
      configPath: CONSOLE_PATH,
      deps: { readText: async () => "version: 1\ncadence_s: 1200\n" },
    });
    expect(loaded.cadence_s).toBe(1_200);
  });

  test("an INVALID file is an error — a console on half a config has a cadence nobody knows", async () => {
    const load = loadTriageConsoleConfig({
      configPath: CONSOLE_PATH,
      deps: { readText: async () => `version: 1\nnotify:\n  endpoint: "${"ftp://h/A"}"\n` },
    });
    await expect(load).rejects.toThrow(ConfigValidationError);
  });

  test("a credential written into the file is refused at LOAD, not discovered in a log later", async () => {
    const load = loadTriageConsoleConfig({
      configPath: CONSOLE_PATH,
      deps: {
        readText: async () =>
          'version: 1\nnotify:\n  endpoint: "https://h.test/Alerts?auth=tk_LEAKED_SECRET"\n',
      },
    });
    await expect(load).rejects.toThrow(ConfigValidationError);
    await load.catch((err: unknown) => {
      expect((err as ConfigValidationError).message).not.toContain("tk_LEAKED_SECRET");
    });
  });

  test("the default deps are a real read, taken through the ports object", () => {
    expect(typeof DEFAULT_TRIAGE_CONFIG_DEPS.readText).toBe("function");
  });
});

describe("the schema objects are exported for `config validate` to reach (task 3.5)", () => {
  test("the document schema parses a minimal document directly", () => {
    expect(TriageConsoleConfigSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(TriageConsoleConfigSchema.safeParse({ version: 1, sweep_deadline_s: 1 }).success).toBe(
      false,
    );
  });

  test("the notify schema is usable on its own", () => {
    expect(NotifyConfigSchema.safeParse({ endpoint: "https://h.test/A?auth=x" }).success).toBe(
      false,
    );
    expect(NotifyConfigSchema.safeParse({ endpoint: "https://h.test/A" }).success).toBe(true);
  });
});
