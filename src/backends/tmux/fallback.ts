/**
 * Backend selection with visible fallback (SRD §11, ISC-131).
 *
 * `up --backend cmux --backend-fallback tmux` must land on a WORKING tmux
 * fleet when cmux is unreachable — and must say so, loudly, in two places: the
 * run ledger (the durable record) and stderr (the operator's terminal). A
 * silent fallback is the worst outcome this module can produce: the operator
 * believes they are watching cmux panes that do not exist, and nothing
 * anywhere records why the fleet looks wrong.
 *
 * This module deliberately owns the visibility side effects instead of
 * returning a "fellBack" flag for the caller to announce. A flag can be
 * dropped on the floor by any future caller; an append inside the resolver
 * cannot be forgotten.
 *
 * The no-fallback path — primary unavailable, nothing to fall back to — exits
 * 3 via the structural `exitCode` protocol (contracts.ts): the thrown error
 * carries the code, the CLI entry point prints the message. That keeps this
 * file free of any dependency on the CLI layer.
 */

import { EXIT } from "../../contracts.ts";
import type { Capability, FleetBackend } from "../types.ts";

/**
 * Structural subset of `LedgerWriter` — just enough to record the event.
 * Structural on purpose: this module must not force its caller to construct a
 * real ledger in unit tests, and must not import run-dir machinery to type it.
 */
export interface FallbackLedger {
  append(event: string, fields: { detail?: Record<string, unknown> }): Promise<unknown>;
}

export interface ResolveBackendOptions {
  primary: FleetBackend;
  /** From `--backend-fallback`; absent means "unavailable primary is fatal". */
  fallback?: FleetBackend;
  ledger: FallbackLedger;
  /** Injectable for tests; defaults to the real stderr. */
  writeStderr?: (line: string) => void;
}

export interface BackendResolution {
  backend: FleetBackend;
  /** True when the returned backend is not the one the operator asked for. */
  fellBack: boolean;
  /** The primary's failed required capabilities when fellBack is true. */
  primaryFailures: Capability[];
}

/** A diagnosed failure (contracts.ts): the CLI maps `exitCode` straight through. */
class BackendUnavailableError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;
}

function failedRequired(caps: Capability[]): Capability[] {
  return caps.filter((c) => c.required && !c.ok);
}

function describe(failures: Capability[]): string {
  return failures.map((c) => `${c.name}: ${c.detail ?? "unavailable"}`).join("; ");
}

/**
 * Probe the primary; return it when healthy. Otherwise probe the fallback,
 * record the switch in the ledger AND on stderr, and return the fallback —
 * or throw exit 3 with a named diagnosis when there is nothing left to try.
 *
 * The probe itself throwing (not just reporting a failed capability) counts
 * as the backend being unavailable: a prober that cannot even run its checks
 * is not a backend we can hand the fleet to.
 */
export async function resolveBackendWithFallback(
  opts: ResolveBackendOptions,
): Promise<BackendResolution> {
  const writeStderr = opts.writeStderr ?? ((line: string) => process.stderr.write(line));

  let primaryFailures: Capability[];
  try {
    primaryFailures = failedRequired(await opts.primary.probe());
  } catch (err) {
    primaryFailures = [
      {
        name: opts.primary.kind,
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
  if (primaryFailures.length === 0) {
    return { backend: opts.primary, fellBack: false, primaryFailures: [] };
  }

  if (opts.fallback === undefined) {
    throw new BackendUnavailableError(
      `backend '${opts.primary.kind}' unavailable (${describe(primaryFailures)}) ` +
        `and no --backend-fallback was given`,
    );
  }

  let fallbackFailures: Capability[];
  try {
    fallbackFailures = failedRequired(await opts.fallback.probe());
  } catch (err) {
    fallbackFailures = [
      {
        name: opts.fallback.kind,
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
  if (fallbackFailures.length > 0) {
    // Both broken: name both diagnoses. "cmux down, so we tried tmux, also
    // down" is a much faster morning than "backend unavailable".
    throw new BackendUnavailableError(
      `backend '${opts.primary.kind}' unavailable (${describe(primaryFailures)}); ` +
        `fallback '${opts.fallback.kind}' also unavailable (${describe(fallbackFailures)})`,
    );
  }

  // Ledger first: if the process dies between these two writes, the durable
  // record is the one that must exist.
  await opts.ledger.append("backend_fallback", {
    detail: {
      from: opts.primary.kind,
      to: opts.fallback.kind,
      reasons: primaryFailures.map((c) => ({ name: c.name, detail: c.detail ?? "" })),
    },
  });
  writeStderr(
    `WARNING: backend '${opts.primary.kind}' unavailable (${describe(primaryFailures)}); ` +
      `falling back to '${opts.fallback.kind}'\n`,
  );

  return { backend: opts.fallback, fellBack: true, primaryFailures };
}
