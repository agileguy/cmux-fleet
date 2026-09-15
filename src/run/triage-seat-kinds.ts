/**
 * The triage-only lookup from a seat's worker id to the environment kind it
 * observes (SRD-TRIAGE-MIXED-OBSERVERS §5, D2).
 *
 * `AspectSeat` (`task-ids.ts`) stays `{worker, aspect}` — it is shared with the
 * review console, which has no notion of "kind" at all — so a triage seat's
 * kind lives here instead of on the shared shape. Three callers need it: task
 * 3.3 splits one sweep's dispatch and settlement per kind, Phase 4.1 reuses it
 * for the per-kind partition, and Phase 5 picks the reply filename per kind.
 */

import { TRIAGE_CONSOLE_ASPECTS, type AspectSeat } from "./task-ids.ts";
import type { TriageEnvironmentKind } from "./triage-targets.ts";

/**
 * Every triage seat's kind, by worker id — the six seats `TRIAGE_CONSOLE_ASPECTS`
 * names today: `obs-t1`/`obs-t2`/`obs-t3` are `"k8s"`, `obs-td1`/`obs-td2` are
 * `"docker"`, `obs-tv1` is `"vm"`.
 *
 * **The collator `tri-1` is deliberately absent.** It observes no environment
 * itself — it collates what the observers report — so it has no kind to name,
 * and {@link seatKind} answers `null` for it rather than a guessed default.
 *
 * Frozen so nothing can reassign a seat's kind at runtime.
 */
export const TRIAGE_SEAT_KINDS: Readonly<Record<string, TriageEnvironmentKind>> = Object.freeze({
  "obs-t1": "k8s",
  "obs-t2": "k8s",
  "obs-t3": "k8s",
  "obs-td1": "docker",
  "obs-td2": "docker",
  "obs-tv1": "vm",
});

/**
 * The kind a triage seat observes, or `null` for any worker id this table
 * does not name — the collator, a review-console seat, a docker worker that
 * is not a triage seat at all, or a typo.
 *
 * **There is no default kind.** A caller that receives `null` must refuse
 * rather than guess: guessing a kind for an unrecognised worker would let a
 * misconfigured or mistyped id silently join whichever kind the guess landed
 * on, instead of surfacing as the unrecognised seat it actually is.
 *
 * **Own properties only.** `TRIAGE_SEAT_KINDS` is a plain object literal —
 * source-legible, the same reason every seat table in this codebase is one —
 * and a plain object's prototype chain carries members like `toString`,
 * `constructor` and `__proto__` that a bracket lookup finds even though this
 * table never wrote them. `worker` is a string a container chose, not one
 * this table wrote, so `Object.hasOwn` is what keeps `seatKind("toString")`
 * answering `null` instead of quietly returning `Object.prototype.toString`
 * typed — and accepted downstream — as a `TriageEnvironmentKind`.
 */
export function seatKind(worker: string): TriageEnvironmentKind | null {
  if (!Object.hasOwn(TRIAGE_SEAT_KINDS, worker)) return null;
  return TRIAGE_SEAT_KINDS[worker] ?? null;
}

/**
 * The seats of one kind, in the order `seats` gives them (default:
 * `TRIAGE_CONSOLE_ASPECTS`, the console's shipped seat list).
 *
 * A seat `TRIAGE_SEAT_KINDS` does not name is excluded from every kind's
 * result — it is not a member of `"k8s"`, `"docker"` or `"vm"`, because it
 * has no kind at all rather than an unspecified one. Routed through
 * {@link seatKind} rather than a bracket lookup of its own, so a seat whose
 * worker id collides with an inherited `Object.prototype` member is excluded
 * here for the same reason it is excluded there.
 */
export function seatsOfKind(
  kind: TriageEnvironmentKind,
  seats: readonly AspectSeat[] = TRIAGE_CONSOLE_ASPECTS,
): readonly AspectSeat[] {
  return seats.filter((seat) => seatKind(seat.worker) === kind);
}

/**
 * The given worker ids whose kind is `kind`, in the order `workers` gives
 * them.
 *
 * For computing `observerBlocked` per environment: a sweep's join reports one
 * flat blocked-worker list, and splitting it through this function per kind is
 * what keeps a blocked k8s seat from counting against the docker or vm
 * environment. Routed through {@link seatKind} for the same own-property
 * reason {@link seatsOfKind} is.
 */
export function workersOfKind(
  kind: TriageEnvironmentKind,
  workers: readonly string[],
): readonly string[] {
  return workers.filter((worker) => seatKind(worker) === kind);
}
