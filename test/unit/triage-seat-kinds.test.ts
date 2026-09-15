/**
 * `triage-seat-kinds.ts` — the seat-to-kind lookup (SRD-TRIAGE-MIXED-OBSERVERS
 * §5, D2; §13 task 3.3, pulled forward from Phase 4.1).
 *
 * Every fixture below is ASYMMETRIC on purpose: a filter survives mutation
 * whenever every fixture makes the filtered and unfiltered sets equal. None of
 * the checks here would pass a do-nothing
 * implementation (`{}`, `() => null`, `() => []`) or a constant one (`() =>
 * "k8s"`, `() => seats`) — each assertion is built so a wrong answer differs
 * from a right one on at least one case.
 */
import { describe, expect, test } from "bun:test";

import { parseConfig } from "../../src/config/load.ts";
import { OBSERVER_K8S_ROLE } from "../../src/config/schema.ts";
import { TRIAGE_CONSOLE_ASPECTS, type AspectSeat } from "../../src/run/task-ids.ts";
import {
  seatKind,
  seatsOfKind,
  TRIAGE_SEAT_KINDS,
  workersOfKind,
} from "../../src/run/triage-seat-kinds.ts";
import { TRIAGE_ENVIRONMENT_KINDS, type TriageEnvironmentKind } from "../../src/run/triage-targets.ts";
import { ROOT, exampleConfig } from "../support/role-docs.ts";

describe("TRIAGE_SEAT_KINDS coverage", () => {
  /*
   * 1. Coverage as a SET equality in both directions. Sorted-array comparison
   * on `toEqual`, the same set-equality pattern `dispatch-request.test.ts`
   * uses for the roster. A seat added to TRIAGE_CONSOLE_ASPECTS
   * with no matching kind reddens the right-hand side missing an entry; a
   * stale kind with no seat reddens the left-hand side carrying an extra one.
   */
  test("the table's keys equal TRIAGE_CONSOLE_ASPECTS' workers, as a set", () => {
    const kindKeys = Object.keys(TRIAGE_SEAT_KINDS).sort();
    const aspectWorkers = TRIAGE_CONSOLE_ASPECTS.map((seat) => seat.worker).sort();
    expect(kindKeys).toEqual(aspectWorkers);
  });

  /*
   * 2. Agreement with the tracked fleet.example.yaml, BY ROLE — the same
   * `parseConfig(exampleConfig(), ...)` call `dispatch-request.test.ts`'s
   * "names every seat the tracked example declares" test makes (read there:
   * `${ROOT}fleet.example.yaml` as the path, `config.workers.map((w) =>
   * [w.id, w.role])` as the role lookup).
   *
   * `expected` is built from `TRIAGE_CONSOLE_ASPECTS` — a list fixed in
   * `task-ids.ts`, independent of `TRIAGE_SEAT_KINDS` — so the loop always
   * has six iterations regardless of what `TRIAGE_SEAT_KINDS` actually holds.
   * A loop built from `Object.keys(TRIAGE_SEAT_KINDS)` instead would pass
   * over zero entries (and report success) the moment that table went empty,
   * which is exactly the "loop that could pass over an empty set" the brief
   * warns against. The comparison itself is one whole-object `toEqual`
   * against the real `TRIAGE_SEAT_KINDS`, not six separate per-key
   * assertions.
   */
  test("agrees with fleet.example.yaml's declared role for every seat", async () => {
    const { config } = await parseConfig(exampleConfig(), `${ROOT}fleet.example.yaml`);
    const roles = new Map(config.workers.map((w) => [w.id, w.role]));
    const ROLE_KIND: Readonly<Record<string, TriageEnvironmentKind>> = {
      [OBSERVER_K8S_ROLE]: "k8s",
      "observer-docker": "docker",
      "observer-vm": "vm",
    };

    const expected: Record<string, TriageEnvironmentKind> = {};
    for (const seat of TRIAGE_CONSOLE_ASPECTS) {
      const role = roles.get(seat.worker);
      expect(role, `fleet.example.yaml names no role for "${seat.worker}"`).toBeDefined();
      const kind = ROLE_KIND[role as string];
      expect(kind, `"${seat.worker}"'s role "${role}" has no observer-k8s/docker/vm mapping`)
        .toBeDefined();
      expected[seat.worker] = kind as TriageEnvironmentKind;
    }

    expect(expected).toEqual(TRIAGE_SEAT_KINDS);
  });
});

describe("seatKind", () => {
  test("names each of the three kinds for a seat of that kind", () => {
    expect(seatKind("obs-t1")).toBe("k8s");
    expect(seatKind("obs-t2")).toBe("k8s");
    expect(seatKind("obs-t3")).toBe("k8s");
    expect(seatKind("obs-td1")).toBe("docker");
    expect(seatKind("obs-td2")).toBe("docker");
    expect(seatKind("obs-tv1")).toBe("vm");
  });

  /*
   * 3. `null` for the collator, a review-console seat, and the asymmetric case
   * that matters: `obs-d1` is a real, live docker-role worker — just not a
   * TRIAGE seat — so a `seatKind` that fell back to inferring a kind from a
   * role naming convention (rather than consulting this table alone) would
   * wrongly answer `"docker"` for it.
   */
  test("refuses the collator, a review seat, and a same-role worker that isn't a triage seat", () => {
    expect(seatKind("tri-1")).toBeNull();
    expect(seatKind("rev-arch-1")).toBeNull();
    expect(seatKind("obs-d1")).toBeNull();
  });

  /*
   * 4. `TRIAGE_SEAT_KINDS` is a plain object literal, so a bracket lookup
   * alone (`TRIAGE_SEAT_KINDS[worker]`) resolves an inherited
   * `Object.prototype` member for a worker id that happens to collide with
   * one — even though this table never named that worker. A container picks
   * `worker`, not this table, so these three ids must all read as "no kind"
   * rather than as whatever `Object.prototype` carries under that name.
   */
  test("refuses inherited Object.prototype members disguised as worker ids", () => {
    expect(seatKind("toString")).toBeNull();
    expect(seatKind("constructor")).toBeNull();
    expect(seatKind("__proto__")).toBeNull();
  });
});

describe("seatsOfKind", () => {
  test("over the default aspects, each kind gives exactly its seats in order", () => {
    expect(seatsOfKind("k8s").map((seat) => seat.worker)).toEqual(["obs-t1", "obs-t2", "obs-t3"]);
    expect(seatsOfKind("docker").map((seat) => seat.worker)).toEqual(["obs-td1", "obs-td2"]);
    expect(seatsOfKind("vm").map((seat) => seat.worker)).toEqual(["obs-tv1"]);
  });

  test("over a custom seats list in a different order, the result follows that order", () => {
    const reordered: readonly AspectSeat[] = [
      { worker: "obs-t3", aspect: "slice3" },
      { worker: "obs-td2", aspect: "docker2" },
      { worker: "obs-t1", aspect: "slice1" },
      { worker: "obs-td1", aspect: "docker1" },
      { worker: "obs-t2", aspect: "slice2" },
    ];
    expect(seatsOfKind("k8s", reordered).map((seat) => seat.worker)).toEqual([
      "obs-t3",
      "obs-t1",
      "obs-t2",
    ]);
    expect(seatsOfKind("docker", reordered).map((seat) => seat.worker)).toEqual([
      "obs-td2",
      "obs-td1",
    ]);
  });

  test("the three kinds' results partition the default aspects: every seat once, none twice", () => {
    const byKind = TRIAGE_ENVIRONMENT_KINDS.flatMap((kind) =>
      seatsOfKind(kind).map((seat) => seat.worker),
    );
    expect([...byKind].sort()).toEqual(
      [...TRIAGE_CONSOLE_ASPECTS.map((seat) => seat.worker)].sort(),
    );
    expect(new Set(byKind).size).toBe(byKind.length);
  });

  /*
   * A seat list a container built, so a worker id colliding with an
   * inherited `Object.prototype` member must be excluded from every kind —
   * the same guarantee `seatKind` makes, carried through the filter.
   */
  test("excludes a seat whose worker id is an inherited Object.prototype member", () => {
    const seats: readonly AspectSeat[] = [
      { worker: "obs-t1", aspect: "slice1" },
      { worker: "toString", aspect: "bogus" },
      { worker: "constructor", aspect: "bogus" },
    ];
    expect(seatsOfKind("k8s", seats).map((seat) => seat.worker)).toEqual(["obs-t1"]);
  });
});

describe("workersOfKind", () => {
  test("filters a flat worker-id list per kind, preserving the given order", () => {
    const workers = ["obs-t2", "obs-tv1", "tri-1", "obs-td1", "obs-t1"];
    expect(workersOfKind("k8s", workers)).toEqual(["obs-t2", "obs-t1"]);
    expect(workersOfKind("docker", workers)).toEqual(["obs-td1"]);
    expect(workersOfKind("vm", workers)).toEqual(["obs-tv1"]);
  });

  test("on an empty list, every kind gives []", () => {
    expect(workersOfKind("k8s", [])).toEqual([]);
    expect(workersOfKind("docker", [])).toEqual([]);
    expect(workersOfKind("vm", [])).toEqual([]);
  });

  /* Same guarantee as `seatKind`'s own-property test, carried through the filter. */
  test("excludes an inherited Object.prototype member from a flat worker-id list", () => {
    expect(workersOfKind("k8s", ["obs-t1", "toString", "__proto__"])).toEqual(["obs-t1"]);
  });
});

describe("the table only ever names real kinds, and covers all three", () => {
  /*
   * 6. Both directions: every value TRIAGE_SEAT_KINDS carries must be one of
   * the three real kinds (catches a typo'd or invented kind name), and every
   * one of the three real kinds must be covered by at least one seat (catches
   * a kind silently dropped from the table). Owner decisions 4 and 5 both
   * depend on the console covering all three.
   */
  test("every value is a member of TRIAGE_ENVIRONMENT_KINDS", () => {
    for (const kind of Object.values(TRIAGE_SEAT_KINDS)) {
      expect(TRIAGE_ENVIRONMENT_KINDS).toContain(kind);
    }
  });

  test("every member of TRIAGE_ENVIRONMENT_KINDS has at least one seat", () => {
    const covered = new Set(Object.values(TRIAGE_SEAT_KINDS));
    for (const kind of TRIAGE_ENVIRONMENT_KINDS) {
      expect(covered.has(kind), `no seat in TRIAGE_SEAT_KINDS names kind "${kind}"`).toBe(true);
    }
  });
});
