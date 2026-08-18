/**
 * Two controls that the whole suite left unpinned.
 *
 * Both were found by mutation, not by reading: the guard was deleted, every
 * existing test stayed green, and nothing in the repo noticed. A guard with a
 * comment explaining exactly why it matters and no test behind it is one
 * refactor away from being tidied out — the comment reads like documentation
 * of a decision rather than a load-bearing invariant.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxBackend } from "../../src/backends/cmux/index.ts";
import { CmuxClient, listPanesArgv } from "../../src/backends/cmux/client.ts";
import { TmuxBackend } from "../../src/backends/tmux/index.ts";
import type { ExecResult } from "../../src/container/run.ts";

/**
 * An empty ref must be refused before tmux sees it.
 *
 * Mutating `id === null || id === ""` down to `id === null` survived twelve
 * passing integration tests plus the unit suite. It is reachable: `attach`
 * guards only `presentation.surface_ref === null`, so `""` passes the CLI
 * check and this is the only thing left standing. tmux treats an empty `-t`
 * as "the active pane", so the failure mode is not an error — it is
 * confidently acting on the wrong pane, which is the worst shape a bug can
 * take in a tool whose entire job is addressing the right one.
 */
describe("an empty surface ref never reaches tmux", () => {
  const seen: string[][] = [];
  const recorder = async (argv: string[]): Promise<ExecResult> => {
    seen.push(argv);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };

  test.each([
    ["focus", (b: TmuxBackend) => b.focus({ backend: "tmux", id: "" })],
    ["attachViewer", (b: TmuxBackend) => b.attachViewer({ backend: "tmux", id: "" }, ["tail", "-F", "/tmp/x"])],
    ["destroy", (b: TmuxBackend) => b.destroy({ backend: "tmux", id: "" }, { keepPanes: false })],
  ])("%s refuses an empty id", async (_name, call) => {
    seen.length = 0;
    const backend = new TmuxBackend({ exec: recorder, socketName: "pifleet-controls" });
    await expect(call(backend)).rejects.toThrow(/no id/);
    // The assertion that matters: tmux was never invoked at all. A guard that
    // threw after spawning would still satisfy `rejects.toThrow`.
    expect(seen).toEqual([]);
  });

  test("a real id is still accepted, so the guard is not simply refusing everything", async () => {
    seen.length = 0;
    const backend = new TmuxBackend({ exec: recorder, socketName: "pifleet-controls" });
    await backend.focus({ backend: "tmux", id: "%3" }).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).toContain("%3");
  });
});

/**
 * The socket password goes in the child's environment, never in argv.
 *
 * Moving it into argv survived all nine integration tests. A long comment in
 * the client justifies env delivery precisely because argv is world-readable
 * through `ps` — on a shared host, any local user could read the credential
 * that drives the operator's cmux. Nothing enforced it.
 */
describe("the cmux socket password stays out of argv", () => {
  const SECRET = "s3cr3t-cmux-password-4b1e";

  test("no argv element contains the password", async () => {
    const seen: string[][] = [];
    const client = new CmuxClient({
      password: SECRET,
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        return { code: 0, stdout: "[]", stderr: "", timedOut: false };
      },
    });
    await client.run(listPanesArgv("ws1"));
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) {
      for (const a of argv) {
        expect(a).not.toContain(SECRET);
      }
      // The flag alone is as damning as the value: `--password` in argv means
      // the secret is one element away regardless of what this fixture saw.
      expect(argv).not.toContain("--password");
    }
  });

  test("the password is delivered through the environment instead", async () => {
    let env: Record<string, string> | undefined;
    const client = new CmuxClient({
      password: SECRET,
      exec: async (_argv, opts): Promise<ExecResult> => {
        env = opts?.env;
        return { code: 0, stdout: "[]", stderr: "", timedOut: false };
      },
    });
    await client.run(listPanesArgv("ws1"));
    // Positive control: without this, a client that silently dropped the
    // password entirely would pass the test above.
    expect(JSON.stringify(env ?? {})).toContain(SECRET);
  });
});

/**
 * `respawn-pane`/`rename-tab` must carry the pane's WORKSPACE id in
 * `--workspace`, not its surface id transposed into that slot.
 *
 * Mutation-found during PR #8's review (ISC-129): swapping the two
 * same-typed string arguments at both call sites in
 * `src/backends/cmux/index.ts` — passing `surfaceId` for `workspaceId` —
 * typechecks, and the whole suite stayed green, because
 * `test/unit/cmux-client.test.ts` only pins the pure argv builders in
 * isolation and `test/unit/cmux-viewer-path.test.ts` only asserts filesystem
 * effects while letting the live cmux call fail. Neither test proved
 * `CmuxBackend` itself sends the right id in the right slot. This is the
 * exact "swap two ids and everything is still green" shape the WORKSPACE
 * field was added to fix in the first place.
 */
describe("cmux respawn-pane and rename-tab carry the pane's workspace id, not its surface id", () => {
  const scriptDirs: string[] = [];
  afterAll(async () => {
    for (const d of scriptDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  });

  test("attachViewer sends --workspace <workspaceId> --surface <surfaceId>, unswapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-backend-controls-"));
    scriptDirs.push(dir);
    const seen: string[][] = [];
    const backend = new CmuxBackend({
      viewerScriptDir: dir,
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    await backend.attachViewer({ backend: "cmux", id: "pane-1 surface-2 workspace-3" }, ["tail", "-F", "/tmp/x"]);

    const respawn = seen.find((argv) => argv.includes("respawn-pane"));
    expect(respawn).toBeDefined();
    expect(respawn![respawn!.indexOf("--workspace") + 1]).toBe("workspace-3");
    expect(respawn![respawn!.indexOf("--surface") + 1]).toBe("surface-2");
  });

  test("createPane's rename-tab sends --workspace <workspaceId> --surface <surfaceId>, unswapped", async () => {
    const seen: string[][] = [];
    const backend = new CmuxBackend({
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        if (argv.includes("list-panes")) {
          return {
            code: 0,
            stdout: JSON.stringify({ panes: [{ id: "existing-pane", selected_surface_id: "existing-surface", index: 0 }] }),
            stderr: "",
            timedOut: false,
          };
        }
        if (argv.includes("new-split")) {
          return {
            code: 0,
            stdout: JSON.stringify({ pane_id: "pane-9", surface_id: "surface-9" }),
            stderr: "",
            timedOut: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    await backend.createPane({ backend: "cmux", id: "workspace-7" }, { workerId: "eng-1", cwd: "/tmp" });

    const rename = seen.find((argv) => argv.includes("rename-tab"));
    expect(rename).toBeDefined();
    expect(rename![rename!.indexOf("--workspace") + 1]).toBe("workspace-7");
    expect(rename![rename!.indexOf("--surface") + 1]).toBe("surface-9");
  });
});
