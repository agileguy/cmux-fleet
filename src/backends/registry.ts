/**
 * The one place a `BackendKind` becomes a `FleetBackend`.
 *
 * Loaded DYNAMICALLY, by kind, and that is a design requirement rather than a
 * style choice. ISC-137 forbids any file outside `src/backends/cmux/` from
 * importing a cmux symbol, and a static `import { createCmuxBackend }` here
 * would violate it exactly as `up.ts` doing so did — the anti-criterion test
 * caught that within a minute of it being written.
 *
 * The rule earns its strictness from ISC-128: the full acceptance suite must
 * pass on `headless` with cmux not running. A static import pulls the cmux
 * module into every process that touches a backend, so a parse error or a
 * missing dependency in cmux code would break `headless` runs that never
 * intended to use it. Keyed lazy loading means the cmux module is read only
 * when someone asks for cmux, which is the property the criterion is really
 * protecting.
 *
 * The kind is validated against a literal allowlist before it reaches the
 * import specifier. It arrives from `--backend` — operator input — and an
 * unchecked value interpolated into a module path is a load-anything
 * primitive; the allowlist means the specifier can only ever be one of three
 * strings this file names itself.
 */

import type { BackendKind, FleetBackend } from "./types.ts";

const KINDS: readonly BackendKind[] = ["cmux", "tmux", "headless"];

export function isBackendKind(v: string): v is BackendKind {
  return (KINDS as readonly string[]).includes(v);
}

/**
 * Every backend module exposes exactly this, so the registry stays uniform.
 *
 * The options object is passed THROUGH, not interpreted. The first version of
 * this took no arguments, which quietly made every backend unconfigurable: the
 * tmux backend supports a `-L` private socket — the thing that keeps
 * concurrent fleets off each other's server — and there was no way to reach
 * it. A uniform signature is worth having; a uniform signature that drops
 * every option is just a narrower one.
 */
type BackendFactory = (opts?: Record<string, unknown>) => FleetBackend;

export async function loadBackend(
  kind: BackendKind,
  opts?: Record<string, unknown>,
): Promise<FleetBackend> {
  if (!isBackendKind(kind)) {
    // Unreachable through the CLI, which validates first — but this function
    // is the one that builds a module path, so it re-checks rather than
    // trusting a caller to have done it.
    throw new Error(`unknown backend kind ${JSON.stringify(String(kind))}`);
  }
  const mod = (await import(`./${kind}/index.ts`)) as Record<string, unknown>;
  const factoryName = `create${kind[0]!.toUpperCase()}${kind.slice(1)}Backend`;
  const factory = mod[factoryName];
  if (typeof factory !== "function") {
    // A backend module that does not export its factory under the expected
    // name is a wiring bug, and it must be loud here rather than surfacing
    // later as "the fleet started with no panes".
    throw new Error(`backend ${kind} does not export ${factoryName}`);
  }
  return (factory as BackendFactory)(opts);
}
