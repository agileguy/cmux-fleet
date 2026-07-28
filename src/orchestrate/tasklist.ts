/**
 * Task-list loading and validation (SRD §9.3, §14).
 *
 * A task list is authored by an operator before the run exists, so everything
 * here is validation of OPERATOR input — refused up front, before a single
 * envelope is built. The failure this file prevents is the half-dispatched
 * list: a cycle or a typo'd dependency discovered on task four, after tasks
 * one through three are already running on real workers, leaves a fleet doing
 * work whose downstream consumers can never run. §9.3 is explicit that a
 * cycle is exit 2, and exit 2 is only honest if nothing was dispatched first.
 */

import { z } from "zod";
import { EXIT, TaskListSchema, type ExitCode, type TaskList, type TaskSpec } from "../contracts.ts";

/**
 * A rejected task list. Carries `exitCode` so the CLI's ladder recognises it
 * structurally (`ExitCoded` in contracts.ts) — this module must not import the
 * CLI to signal a usage error, or every unit test of it would drag the whole
 * commander program in behind it.
 */
export class TaskListError extends Error {
  readonly exitCode: ExitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "TaskListError";
  }
}

/** Read, parse and validate a task list file; every refusal names its cause. */
export async function loadTaskList(path: string): Promise<TaskList> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (err) {
    throw new TaskListError(`cannot read task list ${path}: ${String(err)}`);
  }
  return parseTaskList(raw, path);
}

/**
 * Validate task-list text. Split from `loadTaskList` so tests exercise every
 * refusal without a filesystem, and so a future stdin path reuses it.
 */
export function parseTaskList(raw: string, source: string): TaskList {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new TaskListError(`task list ${source} is not valid JSON: ${String(err)}`);
  }

  let list: TaskList;
  try {
    list = TaskListSchema.parse(doc);
  } catch (err) {
    throw new TaskListError(`task list ${source} is invalid: ${zodSummary(err)}`);
  }

  // Duplicate ids are refused before dependency checks: `depends_on` names
  // ids, and a name that matches two tasks makes every check after this one
  // report against whichever duplicate it happened to see first.
  const seen = new Set<string>();
  for (const t of list.tasks) {
    if (seen.has(t.id)) {
      throw new TaskListError(`task list ${source}: duplicate task id '${t.id}'`);
    }
    seen.add(t.id);
  }

  // An unknown id in depends_on is a task that will wait forever — the
  // dependency it names can never settle because it does not exist. Named
  // per-edge: "unknown dependency" without the referring task sends the
  // operator to diff their own file by eye.
  for (const t of list.tasks) {
    for (const dep of t.depends_on) {
      if (!seen.has(dep)) {
        throw new TaskListError(
          `task list ${source}: task '${t.id}' depends on unknown task '${dep}'`,
        );
      }
      if (dep === t.id) {
        throw new TaskListError(`task list ${source}: task '${t.id}' depends on itself`);
      }
    }
  }

  const cycle = findCycle(list.tasks);
  if (cycle !== null) {
    // The cycle is PRINTED, in edge order, ending where it began. "dependency
    // cycle detected" alone leaves the operator re-deriving by hand the one
    // fact this code just computed (SRD §9.3: a cycle is exit 2).
    throw new TaskListError(`task list ${source}: dependency cycle: ${cycle.join(" -> ")}`);
  }

  return list;
}

/**
 * First dependency cycle in the list, as `[a, b, …, a]`, or null.
 *
 * Iterative DFS with an explicit color map — a list can legally hold
 * MAX_ITEMS (1,000) tasks chained end to end, and a recursive walk at that
 * depth is a stack overflow presented to the operator as a crash instead of
 * exit 2. Deterministic: tasks are visited in list order and edges in
 * `depends_on` order, so the same list always names the same cycle.
 */
export function findCycle(tasks: readonly TaskSpec[]): string[] | null {
  const deps = new Map<string, readonly string[]>(tasks.map((t) => [t.id, t.depends_on]));
  // 0 = unvisited, 1 = on the current path, 2 = fully explored.
  const color = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string>();

  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) !== 0) continue;
    // Each frame remembers which edge it will try next, so a node is pushed
    // once and its edges resume where they left off.
    const stack: Array<{ id: string; next: number }> = [{ id: t.id, next: 0 }];
    color.set(t.id, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = deps.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const dep = edges[frame.next]!;
      frame.next++;
      const c = color.get(dep) ?? 0;
      if (c === 1) {
        // Back edge: walk the parent chain from the referrer to the node we
        // hit, then close the loop for the operator's eyes.
        const cycle = [dep];
        for (let at = frame.id; at !== dep; at = parent.get(at)!) cycle.push(at);
        cycle.push(dep);
        // The chain was collected child-first; reverse into edge order.
        return cycle.reverse();
      }
      if (c === 0) {
        color.set(dep, 1);
        parent.set(dep, frame.id);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  return null;
}

/** One-line summary of a ZodError; its raw `message` is a JSON blob. */
function zodSummary(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
