/**
 * THE ACTOR'S BOOKKEEPING IS PER-CONSOLE — SRD-TRIAGE-CONSOLE §6.4, §9.13, and
 * §12's anti-criterion *"the triage actor's record, log and lock are not the
 * review console's"*.
 *
 * `relayRecordPath`, `relayLogPath` and `relayLockPath` hard-coded the basenames
 * `review-relay.{json,log,lock}` beside the runs root, HOST-WIDE, and
 * `pifleet relay --console triage` shipped before this did. So a triage actor
 * started today wrote the review console's record and took the review console's
 * lock, and §9.13 names the consequence in the register that makes it worth a
 * round: *"the review console silently stops fanning out"*.
 *
 * ## What this file is built against, and why it is a SECOND file
 *
 * `review-console-relay.test.ts` is the review console's suite and its every
 * fixture is a review console. That is the shape round 4 measured on this branch:
 * a check deleted from one arm survived because every fixture took the other arm.
 * A suite in which both consoles are present but always agree is one console
 * tested twice, so **every probe here is asymmetric on exactly one field** —
 * console, run or worker set — with the other two held equal, and each opens with
 * the ACCEPTING case. Without the accepting arm, "refuses the other console" is
 * satisfied by a `servesConsole` that returns `false` for everything, which is
 * the same console-with-no-actor the comparison exists to prevent.
 *
 * The paths are asserted as CONCRETE STRINGS rather than as "they contain the
 * word triage". A pair of stems that were swapped — triage's actor writing
 * `review-relay.json` and vice versa — differs on every containment test and is
 * the bug itself.
 *
 * Hermetic: `PIFLEET_RUNS_DIR` points at a temp directory, so nothing here reads
 * or writes the operator's own `~/.pifleet`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONSOLES } from "../../src/cli/commands/relay.ts";
import {
  CONSOLE_NAMES,
  type ConsoleName,
  RelayRecordSchema,
  acquireRelayLock,
  readRelayStatus,
  relayLockPath,
  relayLogPath,
  relayRecordPath,
  servesConsole,
  writeRelayRecord,
} from "../../src/run/console-relay.ts";

/** The two consoles' worker sets. Disjoint, as the fleet's rosters are. */
const REVIEW_WORKERS = ["col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1"];
const TRIAGE_WORKERS = ["tri-1", "obs-t1", "obs-t2", "obs-t3"];

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true });
});

async function tempRunsDir(): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-console-relay-"));
  temps.push(root);
  return { PIFLEET_RUNS_DIR: join(root, "runs") };
}

/** A record for one console, with every other field free to be varied. */
function record(fields: {
  console: string;
  run_id: string;
  workers: readonly string[];
}): Parameters<typeof servesConsole>[0] {
  return RelayRecordSchema.parse({
    schema: "pifleet.consolerelay/v1",
    pid: 1,
    started: "utc1 x",
    console: fields.console,
    run_id: fields.run_id,
    pinned: null,
    workers: [...fields.workers],
    started_at: "2026-09-06T00:00:00.000Z",
    log_path: "/tmp/x.log",
  });
}

describe("the three bookkeeping paths are per-console (§9.13)", () => {
  /**
   * A FIXED runs dir rather than a temp one: the point of these six assertions
   * is the exact string, and a `mkdtemp` prefix would force them back into
   * containment checks — which is the assertion shape that cannot see a swap.
   */
  const ENV = { PIFLEET_RUNS_DIR: "/pf/runs" };

  test("the review console's three basenames are UNCHANGED by the parameterisation", () => {
    // Backward compatibility as a probe, not a claim. An operator upgrading has
    // a relay running right now; a rename would orphan its record and leave a
    // live actor nothing on disk names.
    expect(relayRecordPath("review", ENV)).toBe("/pf/review-relay.json");
    expect(relayLogPath("review", ENV)).toBe("/pf/review-relay.log");
    expect(relayLockPath("review", ENV)).toBe("/pf/review-relay.lock");
  });

  test("the triage console's three are its own, named concretely", () => {
    expect(relayRecordPath("triage", ENV)).toBe("/pf/triage-relay.json");
    expect(relayLogPath("triage", ENV)).toBe("/pf/triage-relay.log");
    expect(relayLockPath("triage", ENV)).toBe("/pf/triage-relay.lock");
  });

  /**
   * §12's anti-criterion in its own words — *"assert the three paths differ from
   * `relayRecordPath`/`relayLogPath`/`relayLockPath`'s review values"* — as a
   * disjointness check over the whole set rather than three pairs, so a THIRD
   * console that collided with either would be red here too.
   */
  test("no two consoles share any of the six paths", () => {
    const all = CONSOLE_NAMES.flatMap((c) => [
      relayRecordPath(c, ENV),
      relayLogPath(c, ENV),
      relayLockPath(c, ENV),
    ]);
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * THE TWO LISTS THAT MUST AGREE. `CONSOLE_NAMES` is a filename namespace and
   * `CONSOLES` is the roster registry, in a module this one cannot import
   * without a runtime cycle. Set equality both ways: a console registered with
   * no bookkeeping paths is an actor whose record no manager reads, and a name
   * here with no console is a file nobody writes.
   */
  test("every registered console has bookkeeping, and vice versa", () => {
    const bookkept: string[] = [...CONSOLE_NAMES].sort();
    expect(bookkept).toEqual(CONSOLES.map((c) => c.name).sort());
  });

  /**
   * THE GUARD THAT REACHES `scripts/`. `tsconfig.json` includes `src/**` and
   * `test/**` and nothing else, and `scripts/review` runs `main()` at import so
   * no test can pull it in either — so the ONLY production caller of these three
   * functions is a file the compiler never opens. `ConsoleName` disciplines this
   * suite; this refusal is what disciplines the console scripts.
   *
   * The traversal shape is the same check: the argument becomes a basename
   * beside `~/.pifleet`, and a `join` that silently escapes its own directory is
   * worth a throw.
   */
  test("a name no console registered is refused, never joined into a path", () => {
    for (const bad of ["triage-console", "", "../../etc/passwd", "review "]) {
      const name = bad as ConsoleName;
      expect(() => relayRecordPath(name, ENV)).toThrow(/not a console this actor keeps books for/);
      expect(() => relayLogPath(name, ENV)).toThrow();
      expect(() => relayLockPath(name, ENV)).toThrow();
    }
  });
});

/**
 * §9.13 ITSELF, exercised on disk rather than argued: *"a copy-paste actor
 * claims `review-relay.lock`"*.
 *
 * The lock is what makes "one starter at a time" true. Host-wide, it made that
 * true across CONSOLES as well — which is not mutual exclusion between two
 * starters of the same actor but a deadlock between two different consoles, and
 * the review console is the one that loses silently.
 */
describe("a triage actor does not touch the review console's files", () => {
  test("the triage lock leaves the review lock free to take", async () => {
    const env = await tempRunsDir();
    const triage = await acquireRelayLock(relayLockPath("triage", env));
    expect(triage).not.toBeNull();

    // THE ASSERTION THAT WAS FALSE BEFORE THIS CHANGE. With one host-wide lock
    // this is null and the review console starts no actor at all.
    const review = await acquireRelayLock(relayLockPath("review", env));
    expect(review).not.toBeNull();

    // And the exclusion each console does need is intact: a SECOND starter of
    // the same console is still refused. Without this arm, "both consoles can
    // lock" is satisfied by a lock that never excludes anybody.
    expect(await acquireRelayLock(relayLockPath("review", env))).toBeNull();

    await review!.release();
    await triage!.release();
  });

  test("a triage record does not appear at the review console's path", async () => {
    const env = await tempRunsDir();
    await writeRelayRecord(relayRecordPath("triage", env), {
      schema: "pifleet.consolerelay/v1",
      pid: process.pid,
      started: "utc1 whatever",
      console: "triage",
      run_id: "r-tri",
      pinned: null,
      workers: [...TRIAGE_WORKERS],
      started_at: new Date().toISOString(),
      log_path: relayLogPath("triage", env),
    });

    // `absent` is the ordinary state and says nothing ever started. Before this
    // change the review console read the triage actor's record here and either
    // adopted it or stopped it.
    expect((await readRelayStatus(relayRecordPath("review", env))).kind).toBe("absent");
    // The accepting arm: the record IS where triage put it.
    expect((await readRelayStatus(relayRecordPath("triage", env))).kind).not.toBe("absent");
  });

  /**
   * A record SAVED without a console is a copy-paste bug, not history — and the
   * caller that would forget is `scripts/triage`, which nothing typechecks.
   * The schema's `""` default is for records written before the field existed;
   * letting it fill in on a WRITE produces a live actor whose record no console
   * will ever adopt, which is a relay stopped and respawned on every run of the
   * script for a reason nothing prints.
   */
  test("writing a record that names no console is refused", async () => {
    const env = await tempRunsDir();
    const consoleless = {
      schema: "pifleet.consolerelay/v1",
      pid: process.pid,
      started: "utc1 whatever",
      run_id: "r-tri",
      pinned: null,
      workers: [...TRIAGE_WORKERS],
      started_at: new Date().toISOString(),
      log_path: "/tmp/x.log",
    } as unknown as Parameters<typeof writeRelayRecord>[1];
    await expect(
      writeRelayRecord(relayRecordPath("triage", env), consoleless),
    ).rejects.toThrow(/not a console this actor keeps books for/);
    expect((await readRelayStatus(relayRecordPath("triage", env))).kind).toBe("absent");
  });
});

/**
 * `servesConsole` ANSWERING THE QUESTION IT IS NAMED FOR.
 *
 * It compared `run_id` and the worker set and never looked at a console at all.
 * Both of those separate one review console from another review console; neither
 * separates a review console from a triage one.
 */
describe("servesConsole — the console name is part of the identity", () => {
  test("a record naming THIS console, with its run and its workers, is ours", () => {
    // THE ACCEPTING CASE FIRST, and it is load-bearing: every refusal below is
    // satisfied by a function that returns `false` unconditionally, which is a
    // console whose actor is stopped and restarted on every invocation.
    const triage = record({ console: "triage", run_id: "r-tri", workers: TRIAGE_WORKERS });
    expect(servesConsole(triage, { name: "triage", runId: "r-tri", workers: TRIAGE_WORKERS })).toBe(
      true,
    );
    const review = record({ console: "review", run_id: "r-rev", workers: REVIEW_WORKERS });
    expect(servesConsole(review, { name: "review", runId: "r-rev", workers: REVIEW_WORKERS })).toBe(
      true,
    );
  });

  /**
   * THE ASYMMETRIC PAIR THIS ROUND EXISTS FOR. Run id and worker set are held
   * EQUAL and only the console name differs, so nothing but the new comparison
   * can produce `false`. Deleting it makes exactly these two red and leaves
   * every other probe in both files green.
   */
  test("a record naming the OTHER console is refused, with run and workers identical", () => {
    const wearingReview = record({ console: "review", run_id: "r-x", workers: TRIAGE_WORKERS });
    expect(
      servesConsole(wearingReview, { name: "triage", runId: "r-x", workers: TRIAGE_WORKERS }),
    ).toBe(false);

    // And the mirror, so the refusal is not one-directional — a comparison
    // hard-coded to `record.console !== "review"` passes the first arm alone.
    const wearingTriage = record({ console: "triage", run_id: "r-x", workers: REVIEW_WORKERS });
    expect(
      servesConsole(wearingTriage, { name: "review", runId: "r-x", workers: REVIEW_WORKERS }),
    ).toBe(false);
  });

  /**
   * The other two fields, each varied ALONE with the console held equal, so the
   * new check cannot be what answers them. Without these, adding the console
   * comparison could have replaced the run and worker comparisons rather than
   * joined them, and two triage consoles would adopt each other's actors.
   */
  test("the same console in a different run is still not this console", () => {
    const other = record({ console: "triage", run_id: "r-old", workers: TRIAGE_WORKERS });
    expect(servesConsole(other, { name: "triage", runId: "r-new", workers: TRIAGE_WORKERS })).toBe(
      false,
    );
  });

  /**
   * ISC-1057 re-pinned this on a set the record does NOT serve.
   *
   * The arm's PURPOSE is unchanged and is what the block comment above states:
   * varied alone, with the console held equal, so the console comparison cannot
   * be what answers it. What changed is the rule — containment, not equality —
   * so the discriminating fixture has to name a seat the actor does not cover.
   * `["tri-1", "obs-t1"]` against a four-seat record is now an ADOPT, and the
   * test below is that case.
   */
  test("the same console and run with an UNSERVED worker is not this console", () => {
    const other = record({ console: "triage", run_id: "r-tri", workers: TRIAGE_WORKERS });
    expect(
      servesConsole(other, { name: "triage", runId: "r-tri", workers: ["tri-1", "obs-t9"] }),
    ).toBe(false);
  });

  /**
   * ISC-1057. `pifleet triage` has no `--workers`: its record is written from
   * the constant `TRIAGE_CONSOLE_ROSTER`, so an operator's `--workers` subset
   * could never equal it and `./scripts/triage --workers …` stopped a healthy
   * actor and started an identical one on every invocation. A restart cannot
   * change a constant, so refusing to adopt bought no convergence.
   */
  test("an actor serving a SUPERSET of the caller's seats is adopted", () => {
    const other = record({ console: "triage", run_id: "r-tri", workers: TRIAGE_WORKERS });
    expect(
      servesConsole(other, { name: "triage", runId: "r-tri", workers: ["tri-1", "obs-t1"] }),
    ).toBe(true);
    // The whole roster still adopts — containment is reflexive, so the default
    // path this console actually runs is unchanged.
    expect(
      servesConsole(other, { name: "triage", runId: "r-tri", workers: [...TRIAGE_WORKERS] }),
    ).toBe(true);
  });

  /** Order-insensitivity survives the rewrite: a Set compares elements, not a join. */
  test("the caller's order does not matter", () => {
    const other = record({ console: "triage", run_id: "r-tri", workers: TRIAGE_WORKERS });
    expect(
      servesConsole(other, { name: "triage", runId: "r-tri", workers: ["obs-t1", "tri-1"] }),
    ).toBe(true);
  });

  /**
   * The collision the U+0001 join was escaping is now unrepresentable rather
   * than escaped around: elements are compared as elements.
   */
  test("adjacent ids cannot collide by concatenation", () => {
    const other = record({ console: "triage", run_id: "r-tri", workers: ["ab", "c"] });
    expect(servesConsole(other, { name: "triage", runId: "r-tri", workers: ["a", "bc"] })).toBe(
      false,
    );
  });

  /**
   * THE UPGRADE RECORD. `console` defaults to `""` so a record written before the
   * field existed still PARSES — making it required would turn a running review
   * relay's record into `unreadable`, and `unreadable` is the one verdict that
   * refuses to signal or delete anything, so the console would be actorless until
   * a human cleared a file.
   *
   * `""` names no console, so it is adopted by NEITHER. That is the `workers:
   * []` precedent — a default whose value matches nothing — and `contracts.ts`'s
   * *"Empty string means 'not recorded' … Fail-closed is preserved."* The cost
   * is one automatic relay restart on upgrade.
   */
  test("a record written before the field existed is adopted by no console", () => {
    const legacy = RelayRecordSchema.parse({
      schema: "pifleet.consolerelay/v1",
      pid: 1,
      started: "utc1 x",
      run_id: "r-rev",
      pinned: null,
      workers: [...REVIEW_WORKERS],
      started_at: "2026-09-06T00:00:00.000Z",
      log_path: "/tmp/x.log",
    });
    expect(legacy.console).toBe("");
    // Its run and workers ARE the review console's — the field is the only thing
    // that can refuse it, and the review console is the one that wrote it.
    expect(servesConsole(legacy, { name: "review", runId: "r-rev", workers: REVIEW_WORKERS })).toBe(
      false,
    );
    expect(servesConsole(legacy, { name: "triage", runId: "r-rev", workers: REVIEW_WORKERS })).toBe(
      false,
    );
  });

  /**
   * A record naming a console THIS BUILD has never heard of is READABLE and
   * unadoptable, not `unreadable`. `z.enum(CONSOLE_NAMES)` would refuse to parse
   * it — the direction that leaves an actor running with no record any manager
   * will look at, which is the *"background process nobody can name"* the record
   * exists to prevent.
   */
  test("a record naming an unknown console parses and matches nobody", () => {
    const stranger = record({ console: "audit", run_id: "r-rev", workers: REVIEW_WORKERS });
    expect(stranger.console).toBe("audit");
    for (const name of CONSOLE_NAMES) {
      expect(servesConsole(stranger, { name, runId: "r-rev", workers: REVIEW_WORKERS })).toBe(false);
    }
  });
});

/**
 * THE ONE SEAM THE COMPILER CANNOT REACH, and this block exists because a
 * mutation battery over this round's change caught every mutation in `src/` and
 * **every mutation in `scripts/review` survived.**
 *
 * Making the console a required parameter was supposed to make the compiler find
 * every call site. It finds every call site it can OPEN — and `tsconfig.json`
 * includes `src/**` and `test/**` and nothing else, while `scripts/review` runs
 * `main()` at import, so no test can pull it into the program either. The only
 * production caller of the three path functions is therefore the one file with
 * neither a type error nor a test. Rewriting `const CONSOLE = "review"` to
 * `"triage"` left the whole suite green, and what that buys in production is
 * §9.13 pointed the other way: the REVIEW console's script writing
 * `triage-relay.json`, taking `triage-relay.lock`, and the triage console
 * silently ceasing to fan out.
 *
 * Read from the WORKING TREE and never from git — `console-restart.test.ts`'s
 * own posture for these same scripts. A probe that reads the committed blob
 * disagrees with the file in front of you for exactly as long as it takes to
 * mislead somebody.
 *
 * Every marker THROWS when it is missing rather than counting zero. "Every call
 * passes CONSOLE" is vacuously true of a file with no calls, which is the shape
 * a wiring assertion passes most confidently in exactly when the wiring has been
 * deleted.
 */
describe("scripts/review's console binding, which nothing typechecks", () => {
  const read = (): Promise<string> =>
    readFile(join(import.meta.dir, "..", "..", "scripts", "review"), "utf8");

  test("it declares itself the REVIEW console, once, as a constant", async () => {
    const src = await read();
    // The literal, so a script that renamed itself is red rather than merely
    // different. This is the mutation that survived.
    expect(src).toContain('const CONSOLE = "review";');
  });

  test("every bookkeeping path in it is taken through that constant", async () => {
    const src = await read();
    for (const fn of ["relayRecordPath", "relayLogPath", "relayLockPath"]) {
      const calls = [...src.matchAll(new RegExp(`${fn}\\(([^)]*)\\)`, "g"))];
      if (calls.length === 0) {
        throw new Error(`${fn} is called nowhere in scripts/review — the wiring is gone, not fixed`);
      }
      // `CONSOLE`, never a bare `"review"`: a hard-coded literal here is the
      // copy-paste §9.13 describes, one console-script away.
      for (const c of calls) expect(`${fn}(${c[1]})`).toBe(`${fn}(CONSOLE)`);
    }
  });

  test("the identity it compares and the record it writes both name the console", async () => {
    const src = await read();
    const compares = [...src.matchAll(/servesConsole\(([^;]*?)\)\)/g)];
    if (compares.length === 0) {
      throw new Error("scripts/review compares no console identity at all");
    }
    for (const c of compares) expect(c[1]).toContain("name: CONSOLE");

    /*
     * The written record. Without the field `writeRelayRecord` refuses at
     * runtime — but only AFTER the relay has been spawned, because the record
     * needs the pid. So the late refusal costs an unrecorded LIVE actor, which
     * is the one state this whole record exists to prevent. Cheaper to be red.
     */
    const write = src.indexOf("writeRelayRecord(");
    if (write === -1) throw new Error("scripts/review writes no relay record");
    expect(src.slice(write)).toContain("console: CONSOLE,");
  });
});
