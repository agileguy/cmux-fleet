/**
 * The dispatch request — SRD-REVIEW-CONSOLE §6.4, D7, D11, D12.
 *
 * This file is the console's ONLY inbound channel from a container to the host
 * that can cause work to happen. D1 removed every other one: no control socket,
 * no broker socket, nothing inbound. So a bug here is not "a malformed file was
 * accepted" — it is a worker choosing what the fleet does, which is the one
 * property §4.3 spends its length arguing must not exist.
 *
 * The suite is therefore shaped around the refusals rather than around the
 * happy path, and every fixture is ASYMMETRIC on purpose: each one is valid in
 * every respect except the single thing its test names. A fixture that would
 * also be refused for a second reason proves nothing about the rule in its
 * title, because the validator could have stopped at the other reason and the
 * test would still be green.
 *
 * The five hazards, and how each silently comes untrue:
 *
 * - **The reviewer set stops being a set.** Drop the membership check and a
 *   request naming `eng-1` dispatches to the engineering fleet — a console
 *   reaching out of its own console. Nothing downstream would refuse it: `eng-1`
 *   is a real worker with a real socket, so the dispatch SUCCEEDS and the only
 *   evidence is a task in a run nobody was looking at.
 * - **D7's two arms collapse into one.** A collator naming a collator is the
 *   nesting arm; a collator naming itself is the self-dispatch arm. Both refuse
 *   here, and the reason must say WHICH — because the self arm is also outside
 *   the reviewer set, so a validator that lost the D7 check would still refuse
 *   the self fixture, for the wrong reason, and a test asserting only "refused"
 *   would not notice. That is why every D7 assertion pins the CODE and the arm.
 * - **A request grows a field that means something.** D11's whole claim is that
 *   aspect assignment is not reachable from the request. It stays true only
 *   while the schema refuses `model`, `tools`, `deadline` and `acceptance` — and
 *   only while it refuses fields nobody has thought of yet, which is what the
 *   unknown-key test is for. Without it this list is a snapshot of 2026-09-04
 *   and the next field ships accepted.
 * - **The sender stops being structural.** The file's LOCATION is the sender's
 *   identity: a worker can only write its own outbox. Lose that check and the
 *   same bytes dispatch from any container in the fleet, and "any worker can
 *   dispatch" arrives exactly the way §6.10 says it does — by accident.
 * - **One bad entry gets dropped instead of poisoning the file.** §6.4 is
 *   explicit that the whole file is refused on any violation. A validator that
 *   filtered would turn a request for three reviews into a request for two and
 *   report `3/3` consensus over two readers.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_REVIEW_WORKERS } from "../../src/backends/cmux/operations-plan.ts";
import { workerOutboxDir } from "../../src/run/paths.ts";
import {
  ConsoleRosterError,
  DISPATCH_REQUEST_FILE,
  DISPATCH_REQUEST_SCHEMA,
  DispatchIdError,
  MAX_DISPATCH_ID_CHARS,
  MAX_DISPATCH_REQUEST_BYTES,
  MAX_DISPATCH_REQUEST_ITEMS,
  MAX_DISPATCH_TEXT,
  REVIEW_CONSOLE_ROSTER,
  type ConsoleRoster,
  type DispatchRequestContext,
  type DispatchRequestRead,
  dispatchRequestPath,
  parseDispatchRequest,
  readDispatchRequest,
} from "../../src/run/dispatch-request.ts";

const PARENT = "T-review-1";

/** The console as it actually ships: one collator, three reviewers. */
const CTX: DispatchRequestContext = {
  sender: "col-1",
  taskId: PARENT,
  roster: REVIEW_CONSOLE_ROSTER,
};

/**
 * A console with a SECOND collator.
 *
 * The shipping roster has one, so under it D7's nesting arm is unreachable and
 * only the self-dispatch arm can ever fire. The rule is written over the roster
 * rather than over the literal id `col-1` precisely so a second collator is a
 * config edit and not a code change — and this fixture is the only way to hold
 * that claim to a test today.
 */
const TWO_COLLATORS: ConsoleRoster = {
  collators: ["col-1", "col-2"],
  reviewers: REVIEW_CONSOLE_ROSTER.reviewers,
};

/**
 * A console with as many reviewers as `requests[]` can legally hold.
 *
 * Two tests need a document that is at the SHAPE limits and clean in every other
 * respect, and the shipping roster's three reviewers cannot express one: an
 * eight- or nine-entry array against three legal targets is refused for the
 * roster before its length or its size is ever the reason. Asymmetry is the
 * suite's rule (see the header) and this fixture is what buys it back.
 */
const MAX_ROSTER: ConsoleRoster = {
  collators: ["col-1"],
  reviewers: Array.from({ length: MAX_DISPATCH_REQUEST_ITEMS }, (_, i) => `rev-max-${i + 1}`),
};

/**
 * The most expensive single UTF-16 code unit a JSON document can carry.
 *
 * Spelled `String.fromCharCode` rather than as an escape in source because this
 * value is the entire point of the byte-cap arithmetic and a reader must not
 * have to trust that an invisible character in a string literal survived a copy,
 * an editor, or a patch. U+0001 has no shorthand escape, so `JSON.stringify`
 * emits its six-character form — the worst case the cap is computed against, and
 * strictly worse than any UTF-8 encoding (3 bytes/unit at most, 2 for an astral
 * pair).
 */
const WORST_CASE_UNIT = String.fromCharCode(1);

interface Item {
  worker: string;
  title: string;
  brief: string;
  [k: string]: unknown;
}

function item(worker: string, extra: Record<string, unknown> = {}): Item {
  return {
    worker,
    title: `review the collator dispatch schema (${worker})`,
    brief: "Read src/run/dispatch-request.ts and report what it refuses.",
    ...extra,
  };
}

/** The document §6.4 describes, with every field it is allowed to carry. */
function valid(): string {
  return JSON.stringify({
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: PARENT,
    requests: [item("rev-arch-1"), item("rev-ctx-1"), item("rev-lang-1")],
  });
}

async function runRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "dispatch-request-"));
}

/** Put bytes in `<run>/outbox/<worker>/<task>/dispatch-request.json`. */
async function stage(root: string, sender: string, taskId: string, body: string): Promise<string> {
  const dir = join(workerOutboxDir(root, sender), taskId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, DISPATCH_REQUEST_FILE);
  await writeFile(file, body);
  return file;
}

// ---------------------------------------------------------------------------

describe("the request plane accepts exactly the shape §6.4 specifies", () => {
  /**
   * The positive control, and the suite does not mean anything without it.
   *
   * Every other test here asserts a refusal. A validator that returned
   * `refused` unconditionally would pass all of them, and would also be a
   * console that can never dispatch anything. This is the test that fails on
   * that implementation, so it is the one that makes the other twenty
   * meaningful rather than vacuous.
   */
  test("accepts a collator's request for its three reviewers", () => {
    const read = parseDispatchRequest(valid(), CTX);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.request.parent_task_id).toBe(PARENT);
    expect(read.request.requests.map((r) => r.worker)).toEqual([
      "rev-arch-1",
      "rev-ctx-1",
      "rev-lang-1",
    ]);
    // The brief survives BYTE-IDENTICAL. It becomes the child's brief and is
    // staged into /policy/dispatch verbatim; a validator that trimmed or
    // re-wrapped it would brief a reviewer on a document subtly unlike the one
    // the collator wrote, and nothing downstream compares the two.
    expect(read.request.requests[0]!.brief).toBe(
      "Read src/run/dispatch-request.ts and report what it refuses.",
    );
  });

  /**
   * Without this the roster is a second spelling of the console's membership
   * and the two drift silently. `operations-plan.ts` decides which four workers
   * `scripts/review` STARTS; this module decides which of them may be
   * DISPATCHED TO. If a seat is renamed in one and not the other, the console
   * comes up with four healthy panes and every dispatch is refused as "outside
   * the console" — a failure whose message actively points away from its cause.
   */
  test("names the same four workers the review console actually starts", () => {
    const roster = [...REVIEW_CONSOLE_ROSTER.collators, ...REVIEW_CONSOLE_ROSTER.reviewers];

    expect([...roster].sort()).toEqual([...DEFAULT_REVIEW_WORKERS].sort());
    // Pane order is the plan's contract (the collator lands in pane 1), so the
    // collator half must be exactly the head of that list and not merely a
    // member of it.
    expect(REVIEW_CONSOLE_ROSTER.collators).toEqual([DEFAULT_REVIEW_WORKERS[0]!]);
  });

  /**
   * Without this the module computes `outbox/<worker>` itself and the mount
   * that CREATES that directory (`config/render.ts`) and the reader that polls
   * it have two independent spellings of one path. `paths.ts:438-452` records
   * what that costs: a divergence here does not throw — the poller finds an
   * empty directory forever and a collator that dispatched three reviews looks
   * like a collator that dispatched none.
   */
  test("resolves to the file inside the worker's own outbox mount", () => {
    expect(dispatchRequestPath("/runs/R-1", "col-1", PARENT)).toBe(
      join(workerOutboxDir("/runs/R-1", "col-1"), PARENT, DISPATCH_REQUEST_FILE),
    );
  });
});

describe("D7 — a request may not reach outside its console", () => {
  /**
   * Remove the membership check and this fixture DISPATCHES. `eng-1` is a real
   * worker id in the development console with a real control socket, so nothing
   * further down the path refuses it: the review console silently acquires the
   * ability to task the engineering fleet, and the only trace is a task record
   * in a run the operator was not watching.
   *
   * The fixture is asymmetric — `eng-1` is not a collator, the schema is
   * correct, the parent id matches, no forbidden field is present — so the only
   * rule that can fire is the one named in the title.
   */
  test("refuses a worker outside the reviewer set, naming the worker and the set", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("eng-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("worker_not_in_console");
    // BOTH halves are asserted because an operator holding only one of them
    // cannot act: the offending id says what to change, the allowed set says
    // what to change it to. A refusal carrying only "not permitted" sends them
    // to the source.
    expect(read.reason).toContain("eng-1");
    for (const rev of REVIEW_CONSOLE_ROSTER.reviewers) expect(read.reason).toContain(rev);
  });

  /**
   * The SELF-DISPATCH arm. Without it a collator hands itself its own follow-up
   * work and §6.6's two-task shape becomes a loop with no bound: the actor
   * dispatches `col-1`, `col-1` writes another request, and the only thing
   * between that and an unbounded fan-out is the collator's own judgement —
   * which is model output, which is the thing D1 exists not to trust.
   *
   * `col-1` is ALSO outside the reviewer set, and that overlap is structural
   * rather than sloppy: a collator id is by construction not a reviewer id, so
   * no asymmetric fixture for this arm exists. The test compensates by pinning
   * the CODE, which is only reachable through the D7 check — the membership
   * check would refuse the same fixture with a different code, and this
   * assertion is what tells the two apart.
   */
  test("refuses a collator naming ITSELF, and says that is what it did", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("col-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("collator_target");
    expect(read.reason).toContain("col-1");
    // Case-insensitive: the arm is the claim, and this file's prose capitalises
    // for emphasis. Pinning the styling would make a reworded comment a red
    // test and teach the next reader to weaken the assertion instead.
    expect(read.reason.toLowerCase()).toContain("itself");
  });

  /**
   * The NESTING arm, on a roster the shipping console does not have.
   *
   * D7 forbids "a collator may not dispatch to a collator" and the shipping
   * roster has exactly one collator, so on it that sentence is indistinguishable
   * from the self arm. Written against the literal id `col-1`, the rule would
   * appear correct today and silently lapse the moment a second collator is
   * added — a config edit, made by someone who has no reason to open this file.
   * This fixture is the difference between a rule about a roster and a rule
   * about a string.
   */
  test("refuses a collator naming ANOTHER collator, on a two-collator console", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("col-2")],
    });

    const read = parseDispatchRequest(body, { ...CTX, roster: TWO_COLLATORS });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("collator_target");
    expect(read.reason).toContain("col-2");
    // "nesting", not "itself" — the two arms of D7 have different remedies and
    // an operator reading the wrong one looks for the wrong mistake.
    expect(read.reason.toLowerCase()).toContain("nesting");
  });

  /**
   * §6.9's second argument, enforced rather than assumed.
   *
   * The consensus arithmetic of §1.3 counts INDEPENDENT readers: `3/3` is the
   * highest-confidence band because three different vendors agreed. A request
   * naming one reviewer twice produces two reports from one model, and a
   * collator summarising them reports agreement that is duplication. Without
   * this check the collator can manufacture consensus — which is exactly the
   * capability D11 removes at the aspect level, arriving through the door
   * D11 did not close.
   *
   * The fixture is asymmetric: every named worker is a legitimate reviewer and
   * the only defect is that one of them is named twice.
   */
  test("refuses the same reviewer named twice, because 2/2 would not be consensus", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("rev-arch-1"), item("rev-ctx-1"), item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("duplicate_target");
    expect(read.reason).toContain("rev-arch-1");
  });
});

describe("D11 — aspect assignment is not reachable from the request", () => {
  /**
   * Each of these four fields is a host-side or config-side fact. Accepting one
   * does not merely widen a schema — it moves a decision `up` already checked
   * into a document written by a model at run time:
   *
   * `model` is validated against `models_allowlist` before the fleet exists, so
   * a request naming one would name a model no gate has seen. `tools` is §12.1's
   * whole surface — the reviewer's `[read, grep, find, ls]` is what makes three
   * hosted vendors tolerable at all. `deadline`/`deadline_s` is §6.7's budget,
   * and a request that sets it can pin three of the largest models in the
   * catalogue open against the operator's API key. `acceptance` is D8's line:
   * a review is graded on structure and must not be spelled as acceptance.
   *
   * Every fixture is otherwise VALID — a legitimate reviewer, a correct schema
   * tag, a matching parent id — so the only reason any of them can be refused
   * is the field it carries.
   */
  const forbidden: Array<[string, unknown, string]> = [
    ["model", "ollama-cloud/kimi-k3", "models_allowlist"],
    ["tools", ["read", "bash"], "12.1"],
    ["deadline_s", 3_600, "6.7"],
    ["deadline", "1h", "6.7"],
    ["acceptance", ["bun test"], "D8"],
  ];

  for (const [field, value, mustSay] of forbidden) {
    test(`refuses a request carrying "${field}"`, () => {
      const body = JSON.stringify({
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: PARENT,
        requests: [item("rev-arch-1", { [field]: value })],
      });

      const read = parseDispatchRequest(body, CTX);

      expect(read.kind).toBe("refused");
      if (read.kind !== "refused") return;
      expect(read.code).toBe("schema");
      // The field is NAMED and the refusal says where the decision really
      // lives. `.strict()` alone would say "unrecognized key" — the same
      // sentence a typo gets — which teaches an operator nothing about a field
      // that exists, is spelled correctly, and is deliberately unavailable
      // here. `config/schema.ts:833-845` made this trade first.
      expect(read.reason).toContain(field);
      expect(read.reason).toContain(mustSay);
    });
  }

  /**
   * This is the test that makes the list above FUTURE-PROOF rather than a
   * snapshot of what anyone had thought of on 2026-09-04.
   *
   * Remove `.strict()` and every named field above still refuses — all five
   * tests stay green — while `aspect`, `thinking`, `isolation`, `skills`,
   * `append_system_prompt_file` and every field the config grows next year are
   * silently accepted and silently ignored. That failure is invisible from the
   * refusal side: the schema looks like it is holding the line, and the line
   * has moved. A permissive schema is also the worse half of the failure,
   * because an ignored field reads to its author as an honoured one.
   */
  test("refuses a key nobody has named, so the list above cannot rot", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("rev-arch-1", { aspect: "security" })],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
    expect(read.reason).toContain("aspect");
  });

  /**
   * The same guard on the OUTER object. The requests array is the obvious place
   * to smuggle a field and the envelope around it is the unwatched one — a
   * top-level `deadline_s` or `console` would be just as unreachable a decision
   * and is refused by a different `.strict()`, which is a different thing that
   * can be forgotten.
   */
  test("refuses an unknown key on the envelope, not only inside a request", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      console: "review",
      requests: [item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
  });
});

describe("the whole file is refused, never partially accepted", () => {
  /**
   * §6.4: "The actor validates against the schema and refuses the whole file on
   * any violation." The failure this forbids is not a crash — it is a SILENT
   * DOWNGRADE. A validator that dropped the bad entry would turn a request for
   * three independent reviews into a request for two, and the collator, which
   * never waits (D5) and never learns what was dispatched, would go on to
   * report agreement across "three" reports of which one does not exist.
   *
   * Two good entries and one bad one is the fixture that tells a refusing
   * validator from a filtering one; a single-entry fixture cannot, because
   * filtering it and refusing it produce the same empty outcome.
   */
  test("one bad entry among three poisons the file", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [item("rev-arch-1"), item("eng-1"), item("rev-lang-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("worker_not_in_console");
    // The refusal points at the entry, not just at the file: three requests
    // that differ only in `worker` are otherwise indistinguishable in a log.
    expect(read.reason).toContain("eng-1");
    expect(read.reason).toContain("request 2");
  });

  /**
   * The identity binding `harvest/outbox.ts:486-492` already applies to the
   * other direction. Without it a request file left in `T-old`'s directory —
   * by a re-dispatch, a copy, or a collator that reused a path — would fan out
   * under the WRONG parent, and every id derived from that parent (`T-arch`,
   * `T-collate`) would name a task chain that does not exist. The directory is
   * the authority because the host created it; the body is a claim.
   */
  test("refuses a body whose parent_task_id disagrees with the directory it sits in", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: "T-some-other-task",
      requests: [item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("parent_task_mismatch");
    expect(read.reason).toContain("T-some-other-task");
    expect(read.reason).toContain(PARENT);
  });

  /**
   * A wrong or missing schema tag is refused BY NAME rather than falling
   * through as a shape mismatch. Without the literal, `pifleet.task/v1` — a
   * document with a `worker` and a `title` and a `brief` — is close enough to
   * this shape that a future reader could plausibly hand one over, and the
   * refusal an operator would see would be about a missing `requests` array
   * rather than about the file being the wrong kind of file.
   */
  test("refuses a document that does not declare this schema", () => {
    const body = JSON.stringify({
      schema: "pifleet.task/v1",
      parent_task_id: PARENT,
      requests: [item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
    expect(read.reason).toContain(DISPATCH_REQUEST_SCHEMA);
  });

  /**
   * An empty list is refused rather than treated as "nothing to do". The
   * collator writes this file only when it wants a fan-out, so an empty one is
   * a caller bug — and under D5 the parent task SETTLES on writing it, so an
   * accepted empty request is a review that reports success having dispatched
   * nobody. Refusing costs nothing; accepting is indistinguishable from a
   * completed review until someone opens the report.
   */
  test("refuses an empty request list rather than treating it as a no-op", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
  });

  /**
   * Malformed JSON is a REFUSAL and not a throw. The actor reads this file on a
   * poll interval; an exception on a half-written document — and a document
   * written by a container is half-written on every tick that catches it
   * mid-write — would take down the process that performs every dispatch in the
   * console. `harvest/outbox.ts:440-445` reached the same conclusion about the
   * file in the other direction.
   */
  test("refuses unparseable JSON without throwing", () => {
    const read = parseDispatchRequest('{"schema": "pifleet.dispat', CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("not_json");
  });
});

describe("the sender is the directory, not a claim in the file", () => {
  /**
   * THE SAME BYTES, TWICE. This is the whole of §6.10's "refuses a request from
   * a worker whose role is not `collator`", and the pairing is what makes it a
   * proof rather than an assertion: the accepted call and the refused call
   * differ in exactly one thing, and it is not anything in the document.
   *
   * A worker can only write its own outbox — `render.ts:453` mounts
   * `<run-dir>/outbox/<worker>` at `/outbox` and nothing else — so the path a
   * request is FOUND at is an identity the container cannot forge. Lose this
   * check and every reviewer in the console gains the ability to dispatch:
   * `rev-arch-1` reads a repository, reads a prompt-injected instruction in a
   * source comment, writes this file, and the actor fans out on its behalf.
   * That is §4.3's argument arriving through the one channel D1 left open.
   *
   * Note that the refused call's document names `rev-arch-1` — the sender —
   * among its targets, and no other rule refuses a reviewer naming a reviewer.
   * The sender rule is the only thing standing between these two outcomes.
   */
  test("accepts from the collator's outbox and refuses the identical file from a reviewer's", async () => {
    const root = await runRoot();
    const body = valid();
    await stage(root, "col-1", PARENT, body);
    await stage(root, "rev-arch-1", PARENT, body);

    const fromCollator = await readDispatchRequest({ runRoot: root, ...CTX });
    const fromReviewer = await readDispatchRequest({
      runRoot: root,
      ...CTX,
      sender: "rev-arch-1",
    });

    expect(fromCollator.kind).toBe("ok");
    expect(fromReviewer.kind).toBe("refused");
    if (fromReviewer.kind !== "refused") return;
    expect(fromReviewer.code).toBe("sender_not_collator");
    expect(fromReviewer.reason).toContain("rev-arch-1");
  });

  /**
   * A reviewer with NO request file is `missing`, not `refused`, and the
   * ordering that produces that is deliberate.
   *
   * The actor polls. If the sender check ran before the file was known to
   * exist, every tick would produce three refusals for three reviewers that had
   * done nothing at all, and the one refusal that means something — a reviewer
   * that actually tried — would be indistinguishable from the noise. The
   * refusal has to fire exactly when a non-collator ATTEMPTED a dispatch, which
   * is what makes it worth logging loudly.
   */
  test("stays silent about a reviewer that wrote nothing", async () => {
    const root = await runRoot();
    await mkdir(join(workerOutboxDir(root, "rev-ctx-1"), PARENT), { recursive: true });

    const read = await readDispatchRequest({ runRoot: root, ...CTX, sender: "rev-ctx-1" });

    expect(read.kind).toBe("missing");
  });

  /**
   * The sender rule holds on the PARSE path too, not only when this module did
   * the reading.
   *
   * Without this the rule lives in `readDispatchRequest` alone, and the relay
   * actor (§6.5) — which does not exist yet, and whose author has no reason to
   * know that a rule about a document lives in a function about a file — can
   * read the bytes itself, call `parseDispatchRequest`, and dispatch on behalf
   * of any worker in the fleet. Every other test in this block would stay
   * green while that hole was open, because they all go through the reader.
   */
  test("refuses a non-collator sender even when the caller did its own reading", () => {
    const read = parseDispatchRequest(valid(), { ...CTX, sender: "rev-arch-1" });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("sender_not_collator");
  });

  /**
   * A worker in NEITHER half of the roster is refused as a sender for the same
   * reason a reviewer is. Without this the check reads "not a reviewer" instead
   * of "is a collator", and `eng-1` — which is in no roster at all — would fall
   * through whichever way the condition happened to be spelled.
   */
  test("refuses a sender the console has never heard of", async () => {
    const root = await runRoot();
    await stage(root, "eng-1", PARENT, valid());

    const read = await readDispatchRequest({ runRoot: root, ...CTX, sender: "eng-1" });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("sender_not_collator");
  });
});

describe("the file is untrusted input and is read like one", () => {
  /**
   * `missing` and `refused` are DISTINCT variants for `harvest/outbox.ts`'s
   * reason: a collator that dispatched nothing this tick is the normal state
   * and happens thousands of times per run; a collator that wrote something
   * wrong happened once and someone needs to know. Collapse them and the
   * actor's log is either silent about real refusals or screaming about
   * nothing.
   */
  test("reports an absent request as missing, not as a refusal", async () => {
    const root = await runRoot();
    await mkdir(join(workerOutboxDir(root, "col-1"), PARENT), { recursive: true });

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("missing");
  });

  /**
   * A symlinked request is refused without being followed. `harvest/outbox.ts`
   * spells out the primitive: the worker owns this directory, so
   * `dispatch-request.json -> /Users/dan/.env` is read by the host process, and
   * whatever it finds there lands in a refusal message, a log line, and from
   * there in an operator's terminal. `lstat` rather than `stat` is the entire
   * defence and it is one character.
   */
  test("refuses a symlinked request without following it", async () => {
    const root = await runRoot();
    const dir = join(workerOutboxDir(root, "col-1"), PARENT);
    await mkdir(dir, { recursive: true });
    const real = join(root, "elsewhere.json");
    await writeFile(real, valid());
    await symlink(real, join(dir, DISPATCH_REQUEST_FILE));

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("not_a_regular_file");
    // The link TARGET is a valid request, so a reader that followed it would
    // return `ok` and this assertion is what separates the two. That asymmetry
    // is what makes the fixture a test of O_NOFOLLOW rather than of the
    // refusal's spelling: drop the flag and the file parses, validates, and
    // dispatches.
    expect(read.reason.toLowerCase()).toContain("symlink");
  });

  /**
   * A FIFO, refused rather than waited on — and the budget is the assertion.
   *
   * This is the arm that CANNOT be tested by asserting a refusal alone, because
   * its failure is not a wrong answer, it is no answer. Without `O_NONBLOCK` the
   * `open` waits for a writer that never comes, holding a libuv threadpool slot;
   * the default pool is four, so four of these stop the actor dispatching AND
   * harvesting with no error, no log line and no timeout anywhere in the path. A
   * test that simply awaited the read would hang the whole suite instead of
   * failing it — a red that never arrives is not a red.
   *
   * So the read races a budget and the budget losing is the pass. If it wins,
   * the pending `open` is unblocked by opening the write end (a blocked reader
   * makes that return immediately) so the leaked promise settles and the runner
   * can exit, and only then does the test fail — loudly, and saying why.
   *
   * It also pins `!st.isFile()`, which is a separate rule: `O_NONBLOCK` gets the
   * FIFO PAST the open by design, so the fstat on the descriptor is the only
   * thing that refuses it. Remove that check and the read returns EAGAIN and the
   * code becomes `unreadable`, not `not_a_regular_file`.
   */
  test("refuses a FIFO instead of wedging the actor on it", async () => {
    const root = await runRoot();
    const dir = join(workerOutboxDir(root, "col-1"), PARENT);
    await mkdir(dir, { recursive: true });
    const fifo = join(dir, DISPATCH_REQUEST_FILE);
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);

    const BUDGET_MS = 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"wedged">((resolve) => {
      timer = setTimeout(() => resolve("wedged"), BUDGET_MS);
    });
    const outcome: DispatchRequestRead | "wedged" = await Promise.race([
      readDispatchRequest({ runRoot: root, ...CTX }),
      budget,
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === "wedged") {
      Bun.spawnSync(["sh", "-c", 'exec 3> "$1"; exec 3>&-', "sh", fifo]);
      throw new Error(
        `readDispatchRequest did not return within ${BUDGET_MS}ms on a FIFO. The open is ` +
          `blocking for a writer, which in the actor holds a libuv threadpool slot forever — ` +
          `four of these and the console silently stops dispatching and harvesting.`,
      );
    }
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("not_a_regular_file");
  });

  /**
   * A DIRECTORY named `dispatch-request.json`, which is the deterministic half
   * of the same rule.
   *
   * The FIFO test above pins `!st.isFile()` too, but it pins it through a race
   * and a subprocess. This one needs neither and cannot flake: `open` on a
   * directory succeeds on both platforms this fleet runs on, so the fstat is the
   * only thing between it and a read that fails with EISDIR under the wrong
   * refusal code. A worker owns this directory and `mkdir` is not a privileged
   * operation, so it is also the cheapest hostile shape to actually create.
   */
  test("refuses a directory standing where the request should be", async () => {
    const root = await runRoot();
    await mkdir(join(workerOutboxDir(root, "col-1"), PARENT, DISPATCH_REQUEST_FILE), {
      recursive: true,
    });

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("not_a_regular_file");
  });

  /**
   * The size is refused FROM THE STAT, before a byte is buffered. A schema
   * bound rejects an oversized field only after `JSON.parse` has materialised
   * the whole document, so a request file the size of a disk is an OOM in the
   * one host process that performs every dispatch in the console — and it is
   * authored by a container, which is what makes it reachable rather than
   * theoretical.
   *
   * **This fixture does NOT pin the boundary, and the comment that said it did
   * was wrong in the direction that matters.** `cap + 1` is refused by `>` and
   * by `>=` alike, so it is silent about which one is written — and `>=` is the
   * bug that costs something, because it refuses a document of exactly the legal
   * size as `too_large`. Mutating the comparison left this test green. The
   * boundary is pinned by its pair below; this one pins only that an oversized
   * file is refused at all, which is still worth having and is all it ever did.
   */
  test("refuses an oversized request from the stat, before reading it", async () => {
    const root = await runRoot();
    const dir = join(workerOutboxDir(root, "col-1"), PARENT);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, DISPATCH_REQUEST_FILE),
      "x".repeat(MAX_DISPATCH_REQUEST_BYTES + 1),
    );

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("too_large");
    expect(read.reason).toContain(String(MAX_DISPATCH_REQUEST_BYTES));
  });

  /**
   * EXACTLY the cap, and it is the pair to the test above rather than a
   * variation on it.
   *
   * A cap is two claims — everything above it is refused, and nothing at or
   * below it is — and the suite only ever asserted the first. `>` and `>=` are
   * one character apart and produce identical behaviour on every fixture except
   * this one, so mutating `>` to `>=` was invisible: 27 tests passed while a
   * legally-sized document was refused as `too_large`. That failure is the
   * expensive kind, because the refusal names a limit the document does not
   * exceed, and the remedy it suggests is raising the cap.
   *
   * The assertion is `not_json` rather than merely "not too_large", and the
   * extra precision is doing work: it proves the guard let the file through AND
   * that all 4,194,304 bytes were read and handed to the parser, so the fixture
   * covers the read path at full extent as well as the comparison.
   */
  test("accepts a file of exactly the cap, so > cannot silently become >=", async () => {
    const root = await runRoot();
    const dir = join(workerOutboxDir(root, "col-1"), PARENT);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, DISPATCH_REQUEST_FILE), "x".repeat(MAX_DISPATCH_REQUEST_BYTES));

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).not.toBe("too_large");
    expect(read.code).toBe("not_json");
  });

  /**
   * The reader and the parser share ONE set of rules. Without this test the
   * semantic checks could live only in `parseDispatchRequest` while
   * `readDispatchRequest` — the function the actor actually calls — validated
   * the schema and stopped, and every unit test above would still be green.
   * The refusal that matters is the one on the path that runs in production.
   */
  test("applies the roster rules on the disk path, not only the parse path", async () => {
    const root = await runRoot();
    await stage(
      root,
      "col-1",
      PARENT,
      JSON.stringify({
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: PARENT,
        requests: [item("eng-1")],
      }),
    );

    const read = await readDispatchRequest({ runRoot: root, ...CTX });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("worker_not_in_console");
  });
});

describe("a document that VALIDATES is a document that READS", () => {
  /**
   * The byte cap's whole defence, executed instead of asserted.
   *
   * `MAX_DISPATCH_REQUEST_BYTES` is only defensible while it sits above every
   * schema-legal document — a cap that can refuse a legal file is a bug that
   * presents as a policy, and the operator who meets it is told a limit that the
   * document does not exceed. The module used to claim that property in prose
   * and the claim was FALSE: the bounds multiplied out to 6.00 MiB against a
   * 4.00 MiB cap, so the maximal legal request was refused `too_large` — the
   * exact outcome the comment said "would read as a bug and be argued away".
   *
   * The old arithmetic was wrong twice. It counted UTF-16 code units and
   * compared them to a byte cap, and it said "even before JSON escaping" as
   * though escaping made a document smaller. Escaping is the dominant term: a
   * code unit costs at most 3 bytes as raw UTF-8 and 6 as an escape, so the
   * worst case is 6x the bound and it is reached by ordinary control characters.
   *
   * This test cannot be satisfied by prose. It builds the largest document the
   * schema will accept — every entry the array holds, every text field filled to
   * its bound with the most expensive character there is — measures it, and puts
   * it through the real reader. Any future edit to any of the three constants
   * either keeps the invariant or turns this red.
   */
  test("accepts the largest document the schema can express", async () => {
    const filler = WORST_CASE_UNIT.repeat(MAX_DISPATCH_TEXT);
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: MAX_ROSTER.reviewers.map((worker) => ({ worker, title: filler, brief: filler })),
    });

    // The fixture has to be genuinely large or it proves nothing — a maximal
    // document that came out at a few KiB would pass against any cap at all.
    const bytes = Buffer.byteLength(body, "utf8");
    expect(bytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_DISPATCH_REQUEST_BYTES);

    const root = await runRoot();
    await stage(root, "col-1", PARENT, body);
    const read = await readDispatchRequest({ runRoot: root, ...CTX, roster: MAX_ROSTER });

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    // Round-trip at full extent, which is a second thing worth pinning: the
    // reader fills a fixed `cap + 1` buffer through the descriptor, and a read
    // that returned short would truncate a legal document into a JSON syntax
    // error naming a problem the document does not have.
    expect(read.request.requests).toHaveLength(MAX_DISPATCH_REQUEST_ITEMS);
    expect(read.request.requests[0]!.brief.length).toBe(MAX_DISPATCH_TEXT);
    expect(read.request.requests.at(-1)!.title.length).toBe(MAX_DISPATCH_TEXT);
  });
});

describe("an id becomes a path only after it is held to a grammar", () => {
  /**
   * THE FINDING, as a fixture: a forged sender reaching a file outside its own
   * outbox.
   *
   * `sender` is trusted for exactly one reason — a container can write only its
   * own outbox, so the DIRECTORY a request is found in is an identity that
   * cannot be forged. That argument is about a path, and it was never enforced
   * on the value the path was built from. `join` resolves `..`; it does not
   * refuse it. So `sender: ".."` addressed `<run>/<task>/dispatch-request.json`
   * — out of the outbox subtree entirely, in the run directory that also holds
   * `control-auth.json` — and the host opened whatever was there.
   *
   * The fixture plants a real, entirely valid request at the escaped location,
   * so a reader without the grammar OPENS AND READS A FILE OUTSIDE THE MOUNT.
   * The assertion is on the CODE and that is the whole of its sensitivity:
   * `sender_not_collator` still fires afterwards, so a test asserting only
   * "refused" stays green while the host reads an arbitrary file every tick.
   * `unspellable_id` is reachable only before the path exists.
   */
  test("refuses a sender that would escape the outbox, before opening anything", async () => {
    const root = await runRoot();
    const escaped = join(root, PARENT);
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, DISPATCH_REQUEST_FILE), valid());
    // The location the traversal actually reaches, so the test fails if the
    // fixture stops being the trap it claims to be.
    expect(dirname(dirname(workerOutboxDir(root, "col-1")))).toBe(root);

    const read = await readDispatchRequest({ runRoot: root, ...CTX, sender: ".." });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("unspellable_id");
    expect(read.reason).toContain("sender");
  });

  /**
   * The same hole through `taskId`, which is the half a reader is likelier to
   * think is safe because the host creates task directories.
   *
   * It creates them from ids that arrive in envelopes, and `TaskEnvelopeSchema`
   * bounds a task id's LENGTH and nothing else — the same gap `replies.ts:124-142`
   * closes on the return half of this exchange, quoting the same reasoning. A
   * valid request is planted where `".."` lands so the escape is real rather
   * than notional.
   */
  test("refuses a taskId that would escape the worker's outbox", async () => {
    const root = await runRoot();
    const escaped = dirname(workerOutboxDir(root, "col-1"));
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, DISPATCH_REQUEST_FILE), valid());

    const read = await readDispatchRequest({ runRoot: root, ...CTX, taskId: ".." });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("unspellable_id");
    expect(read.reason).toContain("taskId");
  });

  /**
   * The builder refuses on its own, so a caller that never goes through
   * `readDispatchRequest` cannot obtain an escaped path either.
   *
   * `dispatchRequestPath(runRoot, sender, "../../../../../../etc")` returned
   * `/etc/dispatch-request.json`. Verified, and it is exported, and §6.5's relay
   * actor — which does not exist yet — is its second caller. A path builder that
   * can silently produce a path outside the subtree it is named for is a hole in
   * every caller including the ones nobody has written, so the refusal belongs
   * in the builder rather than in each caller's memory of it.
   */
  test("refuses to build a path at all from an id that cannot be spelled", () => {
    expect(() => dispatchRequestPath("/runs/R-1", "col-1", "../../../../../../etc")).toThrow(
      DispatchIdError,
    );
    expect(() => dispatchRequestPath("/runs/R-1", "../..", PARENT)).toThrow(DispatchIdError);
    // The legal case still builds, so the guard cannot be satisfied by refusing
    // everything — the same role the suite's positive control plays.
    expect(dispatchRequestPath("/runs/R-1", "col-1", PARENT)).toBe(
      join(workerOutboxDir("/runs/R-1", "col-1"), PARENT, DISPATCH_REQUEST_FILE),
    );
  });

  /**
   * `parent_task_id` is a field a CONTAINER writes, and it was
   * `z.string().max(MAX_SHORT)` — a length and nothing else, which accepts
   * `"../../control-auth.json"` exactly as `TaskEnvelopeSchema.task_id` does.
   *
   * The equality check against the directory makes this unreachable today, which
   * is precisely why it needs its own test: the field's safety was a property of
   * two other checks standing where they stand, and a bound that holds only
   * transitively lapses silently the day one of them moves.
   */
  test("refuses a parent_task_id that is a traversal rather than an id", () => {
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: "../../control-auth.json",
      requests: [item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    // `schema` is the assertion that carries the sensitivity, and the ordering
    // is why. The schema pass runs BEFORE the identity binding, so with the
    // grammar in place the field is refused for being a traversal. Delete the
    // regex and the document falls through to `parent_task_mismatch` — still
    // refused, so a test asserting only `kind` would stay green while the field
    // that reaches a host path stopped being checked.
    expect(read.code).toBe("schema");
    expect(read.reason).toContain("parent_task_id");
  });

  /**
   * The grammar half above and the LENGTH half here are two rules, and only a
   * fixture that is legal under one can pin the other. This id is entirely
   * ordinary characters — it satisfies `SESSION_ID_RE` completely — so the
   * only thing that can refuse it is the bound.
   */
  test("refuses a parent_task_id longer than an id may be", () => {
    const long = "a".repeat(MAX_DISPATCH_ID_CHARS + 1);
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: long,
      requests: [item("rev-arch-1")],
    });

    const read = parseDispatchRequest(body, CTX);

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
    expect(read.reason).toContain("parent_task_id");
  });
});

describe("the shape bounds are bounds, not decoration", () => {
  /**
   * `MAX_DISPATCH_REQUEST_ITEMS` carries seventeen lines of justification in the
   * module and had no test — the constant was exported and never imported here,
   * so deleting `.max(...)` outright left the suite entirely green.
   *
   * The bound exists to stop the loop BEFORE the roster is consulted, which is
   * also what makes it awkward to test honestly: against the shipping roster a
   * nine-entry array is refused for its targets whatever its length. So the
   * fixture runs on a roster with nine legal, distinct reviewers, leaving the
   * COUNT as the only thing wrong with it.
   */
  test("refuses more entries than requests[] may hold", () => {
    const roomy: ConsoleRoster = {
      collators: ["col-1"],
      reviewers: Array.from(
        { length: MAX_DISPATCH_REQUEST_ITEMS + 1 },
        (_, i) => `rev-many-${i + 1}`,
      ),
    };
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: roomy.reviewers.map((w) => item(w)),
    });

    const read = parseDispatchRequest(body, { ...CTX, roster: roomy });

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("schema");
    expect(read.reason).toContain(String(MAX_DISPATCH_REQUEST_ITEMS));
  });

  /**
   * `title` and `brief` are the only unbounded-alphabet fields in the document,
   * which makes them the only two that can drive its SIZE — so these bounds are
   * not tidiness, they are the term `MAX_DISPATCH_REQUEST_BYTES`'s headroom is
   * computed from. Delete either and the maximal-document test above becomes
   * unsatisfiable rather than merely wrong, which is the right coupling: the two
   * rules are one argument and they fail together.
   *
   * Each fixture is over the bound in exactly one field, so neither can pass on
   * the other's account.
   */
  for (const field of ["title", "brief"] as const) {
    test(`refuses a ${field} longer than the byte-cap arithmetic allows`, () => {
      const body = JSON.stringify({
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: PARENT,
        requests: [item("rev-arch-1", { [field]: "a".repeat(MAX_DISPATCH_TEXT + 1) })],
      });

      const read = parseDispatchRequest(body, CTX);

      expect(read.kind).toBe("refused");
      if (read.kind !== "refused") return;
      expect(read.code).toBe("schema");
      expect(read.reason).toContain(field);
    });
  }

  /**
   * And the boundary in the other direction, for the reason the byte cap needed
   * one: a bound tested only from above is silent about `>` versus `>=`, and the
   * off-by-one refuses a legal document.
   */
  test("accepts a title and brief of exactly the bound", () => {
    const at = "a".repeat(MAX_DISPATCH_TEXT);
    const body = JSON.stringify({
      schema: DISPATCH_REQUEST_SCHEMA,
      parent_task_id: PARENT,
      requests: [{ worker: "rev-arch-1", title: at, brief: at }],
    });

    expect(parseDispatchRequest(body, CTX).kind).toBe("ok");
  });
});

describe("the roster is checked before it is trusted", () => {
  /**
   * THE FINDING: a roster that reads as obviously correct and disables both of
   * this module's semantic guarantees.
   *
   * `roster` was a bare required parameter, so the author of §6.5's relay actor
   * has to answer "who may ask, and who may be asked?" — and the natural way to
   * answer it from inside a polling loop is to build it from what the loop
   * already has:
   *
   *     roster: { collators: [senderFromDirectory], reviewers: allWorkers }
   *
   * Every word of that reads right. It makes `checkSender` a TAUTOLOGY — the
   * roster was built from the sender, so every sender is a collator, including
   * `rev-arch-1` — and it admits `eng-1` as a target, which is the reach-outside-
   * the-console failure this whole module exists to prevent. Neither check
   * misbehaves; both run, both pass, and both mean nothing.
   *
   * Disjointness is what makes that roster unconstructible, and it has to throw
   * rather than refuse: a roster is a host argument, identical on every tick for
   * the life of the run, so a console with a broken one must not dispatch at all
   * rather than log a refusal the loop then continues around.
   */
  test("refuses a roster in which a worker is both a collator and a reviewer", () => {
    const tautology: ConsoleRoster = {
      collators: ["col-1"],
      reviewers: ["col-1", "rev-arch-1", "eng-1"],
    };

    expect(() => parseDispatchRequest(valid(), { ...CTX, roster: tautology })).toThrow(
      ConsoleRosterError,
    );
  });

  /**
   * The degenerate halves. `collators: []` refuses every dispatch and
   * `reviewers: []` refuses every target — in both cases a console that comes up
   * with four healthy panes and silently does nothing, which is the failure mode
   * this file's prose keeps naming as the expensive one because its symptom is
   * an ABSENCE.
   */
  test("refuses a roster with an empty half", () => {
    expect(() =>
      parseDispatchRequest(valid(), { ...CTX, roster: { collators: [], reviewers: ["rev-arch-1"] } }),
    ).toThrow(ConsoleRosterError);
    expect(() =>
      parseDispatchRequest(valid(), { ...CTX, roster: { collators: ["col-1"], reviewers: [] } }),
    ).toThrow(ConsoleRosterError);
  });

  /**
   * Case, and the asymmetry `paths.ts:710-741` argues from.
   *
   * Every comparison in this module is exact, and it should stay exact: folding
   * `checkSender` would make `Col-1` MATCH the collator `col-1` and admit a
   * sender that is not the collator — a false green manufactured by the fix.
   * The real hazard is one level up. `sender` is trustworthy only because a
   * container can write only its own outbox, and on a case-insensitive
   * filesystem — APFS by default, which is what this fleet develops on —
   * `outbox/col-1` and `outbox/Col-1` are ONE directory. `config/schema.ts`
   * dedupes worker ids case-SENSITIVELY, so both ids are legal in one fleet, and
   * two workers sharing an outbox is the module's entire premise failing: the
   * reviewer writes the file, the actor polls the collator, finds it, and every
   * check in this file correctly passes.
   *
   * That is undetectable once the file is on disk, and detectable exactly once —
   * here, while the ids are still two strings. Unconditional on every platform,
   * for the fourth of paths.ts's reasons: a `process.platform` branch would make
   * this test skip on Linux CI and leave the behaviour evidenced only by a run on
   * a maintainer's laptop.
   */
  test("refuses a roster holding two ids that differ only in case", () => {
    const twins: ConsoleRoster = {
      collators: ["col-1"],
      reviewers: ["Col-1", "rev-arch-1"],
    };

    expect(() => parseDispatchRequest(valid(), { ...CTX, roster: twins })).toThrow(
      ConsoleRosterError,
    );
    // Exact-case comparison is UNCHANGED and this is the half that says so: on
    // the shipping roster, `Col-1` is simply a sender the console has never
    // heard of. A fold applied to the comparison instead of to the roster would
    // turn this into an accepted dispatch.
    const read = parseDispatchRequest(valid(), { ...CTX, sender: "Col-1" });
    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.code).toBe("sender_not_collator");
  });

  /**
   * The default, which is the other half of the repair.
   *
   * A required parameter with exactly one correct answer is an invitation to
   * COMPUTE that answer, and computing it is how the tautology above arrives. So
   * omitting `roster` yields the console that ships — asserted in both
   * directions, because a default that refused everything would satisfy the
   * negative test alone and would also be a console that can never dispatch.
   */
  test("defaults to the shipping console when no roster is supplied", () => {
    const accepted = parseDispatchRequest(valid(), { sender: "col-1", taskId: PARENT });
    expect(accepted.kind).toBe("ok");

    const refused = parseDispatchRequest(
      JSON.stringify({
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: PARENT,
        requests: [item("eng-1")],
      }),
      { sender: "col-1", taskId: PARENT },
    );
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.code).toBe("worker_not_in_console");
  });

  /**
   * The default reaches the DISK path too. `readDispatchRequest` is the function
   * the actor actually calls, and a default wired into only the parser would
   * leave the caller that matters with the old required-parameter hazard.
   */
  test("defaults on the disk path as well as the parse path", async () => {
    const root = await runRoot();
    await stage(root, "col-1", PARENT, valid());

    const read = await readDispatchRequest({ runRoot: root, sender: "col-1", taskId: PARENT });

    expect(read.kind).toBe("ok");
  });
});
