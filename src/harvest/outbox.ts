/**
 * A1 — the result envelope, read as UNTRUSTED input (SRD §7.2, §12.5).
 *
 * The envelope is authored by the actor being graded, and the harvester is the
 * first thing that reads it. Without constraints, `{"kind":"file","path":
 * "/Users/dan/.env"}` is an exfiltration primitive — read by the harvester,
 * written into report.md, and from there into the orchestrator's context. So
 * the order of operations here is the contract: size cap from `lstat` before
 * any read, schema validation before any field is dereferenced, and path
 * containment before any named path could ever be opened.
 */

export type OutboxRead = { kind: "missing" } | { kind: "todo" };
