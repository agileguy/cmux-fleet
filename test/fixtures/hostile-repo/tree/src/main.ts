/**
 * Ordinary code. The fixture is not 100% payload on purpose: a hostile repo
 * that is ONLY hazards is easy to spot and easy to accidentally special-case.
 * A real one looks like work with four files added.
 */
export function add(a: number, b: number): number {
  return a + b;
}
