/**
 * The ticket CLI pin is only as good as its agreement with the image.
 *
 * `src/config/ticket-cli.ts` names a commit and the release that commit is.
 * Nothing in TypeScript can see inside a Docker image, so the chain that makes
 * those values mean something runs through the Dockerfile:
 *
 *   TICKET_CLI_* (ticket-cli.ts)  ←this file→  Dockerfile  ←--version at build→  image
 *
 * This file is the first arrow. The second is the `rally-cli --version | grep`
 * in the Dockerfile, which fails the BUILD when the installed release is not
 * the pinned one — the only check in the chain a mistyped commit cannot
 * satisfy, because `pip install` of a git ref succeeds for any commit that
 * builds.
 *
 * Without both arrows the commit is a claim nothing re-reads, and an image
 * could ship a different tool under an unchanged tag.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TICKET_CLI_BIN,
  TICKET_CLI_COMMIT,
  TICKET_CLI_ENV,
  TICKET_CLI_VENV,
  TICKET_CLI_VERSION,
} from "../../src/config/ticket-cli.ts";
import { BUILD_CONTEXT_ASSETS } from "../../src/container/image.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DOCKERFILE = readFileSync(join(ROOT, "docker", "Dockerfile"), "utf8");
const SHIM = readFileSync(join(ROOT, "docker", "ticket-cli"), "utf8");

/**
 * The shim with its comments removed.
 *
 * Needed because the header DOCUMENTS the leaking spellings it exists to
 * prevent — `--apikey "$(cat …)"` is written out in full, as the thing not to
 * do. An absence assertion over the raw text therefore fires on the
 * explanation rather than on the code, which is what happened the first time
 * this file was run. Comments are prose about the code and must not be graded
 * as the code.
 */
const SHIM_CODE = SHIM.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const SKILL = readFileSync(join(ROOT, "skills", "ticket-ops", "SKILL.md"), "utf8");

describe("the pin agrees with the image that carries it", () => {
  it("pins the same commit in ticket-cli.ts and the Dockerfile", () => {
    const m = /ARG TICKET_CLI_COMMIT=([0-9a-f]+)/.exec(DOCKERFILE);
    expect(m, "the Dockerfile has no TICKET_CLI_COMMIT ARG").not.toBeNull();
    expect(m![1]).toBe(TICKET_CLI_COMMIT);
  });

  it("pins a full 40-character sha, not a prefix or a tag", () => {
    // A prefix is ambiguous by construction and git will happily resolve one;
    // a TAG is worse, because it is a moving reference — the same `v1.2.0` can
    // be re-pointed at new code, and an image rebuilt later would install it
    // under a Dockerfile whose bytes never changed. That is the exact drift
    // this pin exists to prevent, so the shape is asserted, not assumed.
    expect(TICKET_CLI_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("installs from the ARG rather than a second literal", () => {
    // A hardcoded ref on the install line would pass the check above and still
    // install something else — the same trap `themes.test.ts` pins for the
    // bundle version.
    expect(DOCKERFILE).toContain('"git+${TICKET_CLI_REPO}@${TICKET_CLI_COMMIT}"');
  });

  it("asserts the installed VERSION at build time, not mere presence", () => {
    const m = /ARG TICKET_CLI_VERSION=([^\s\\]+)/.exec(DOCKERFILE);
    expect(m, "the Dockerfile has no TICKET_CLI_VERSION ARG").not.toBeNull();
    expect(m![1]).toBe(TICKET_CLI_VERSION);
    // The grep is the load-bearing half: `pip install` of a git ref succeeds
    // for any commit that builds, so presence proves nothing about identity.
    expect(DOCKERFILE).toContain('--version | grep -qF "version ${TICKET_CLI_VERSION}"');
  });

  it("installs into its own venv, outside every mount the fleet makes", () => {
    expect(DOCKERFILE).toContain(`python3 -m venv ${TICKET_CLI_VENV}`);
    // NOT under /home/pi — `config/render.ts` mounts a named volume there, and
    // a volume masks whatever the image baked at its mountpoint. Baked there,
    // the CLI would be invisible in real runs and present in every probe that
    // mounts nothing, which is the worst way to be wrong.
    expect(TICKET_CLI_VENV.startsWith("/home/pi/")).toBe(false);
    expect(TICKET_CLI_VENV.startsWith("/opt/pifleet/")).toBe(true);
  });

  it("publishes the shim, not the venv binary, as the PATH name", () => {
    // The distinction is the whole security property: the venv binary reads
    // RALLY_APIKEY from an environment the fleet deliberately does not set, so
    // a symlink here would put the credential back in the worker's hands.
    expect(DOCKERFILE).toContain(
      `COPY --chmod=0755 docker/ticket-cli /usr/local/bin/${TICKET_CLI_BIN}`,
    );
    expect(DOCKERFILE).not.toMatch(
      new RegExp(`ln -s ${TICKET_CLI_VENV}/bin/${TICKET_CLI_BIN} /usr/local/bin/`),
    );
  });

  it("smoke-tests the REAL entry point, which needs no delivered config", () => {
    // The build has no secrets, so the shim refuses (exit 78) by design. A
    // smoke test aimed at the PATH name would fail every build — and "fix" it
    // by tempting someone to soften the shim's refusal, which is the guard.
    expect(DOCKERFILE).toContain(`${TICKET_CLI_VENV}/bin/${TICKET_CLI_BIN} --version >/dev/null`);
  });

  it("counts the shim as a build-context asset, so editing it moves the tag", () => {
    // An image hash that did not cover this file would let a stale shim ship
    // under an unchanged tag — and a stale shim is one that maps the project
    // to the wrong variable, which returns ROWS rather than an error.
    expect(BUILD_CONTEXT_ASSETS).toContain("ticket-cli");
  });
});

describe("the shim reads delivered files and never argv", () => {
  it("reads all four values from _FILE pointers", () => {
    for (const v of [
      "TICKET_API_TOKEN_FILE",
      "TICKET_BASE_URL_FILE",
      "TICKET_WORKSPACE_FILE",
      "TICKET_PROJECT_FILE",
    ]) {
      expect(SHIM, `the shim never reads ${v}`).toContain(v);
    }
  });

  it("exports exactly the variables the CLI reads", () => {
    for (const name of Object.values(TICKET_CLI_ENV)) {
      expect(SHIM, `the shim never sets ${name}`).toContain(name);
    }
    expect(SHIM).toMatch(/export RALLY_APIKEY RALLY_SERVER RALLY_WORKSPACE RALLY_PROJECT/);
  });

  it("never puts a value on a command line", () => {
    // The failure mode the shim exists to remove: `--apikey <value>` is argv,
    // and argv is what `ps` shows to every process on the box.
    expect(SHIM_CODE).not.toContain("--apikey");
    expect(SHIM_CODE).not.toContain("--workspace");
    expect(SHIM_CODE).not.toContain("--project");
  });

  /**
   * Refusal is FATAL, and the exit code matters.
   *
   * An unconfigured CLI does not fail — it succeeds at something else. With no
   * project it queries the whole workspace, which returns rows and reads as an
   * answer. A shim that defaulted anything would turn a delivery bug into a
   * wrong report nobody could distinguish from a right one.
   */
  it("exits non-zero on a missing or unreadable value rather than defaulting", () => {
    expect(SHIM).toContain("exit 78");
    expect(SHIM).toMatch(/\[ -n "\$\{path\}" \] \|\| die/);
    expect(SHIM).toMatch(/\[ -r "\$\{path\}" \] \|\| die/);
  });

  it("never interpolates a delivered VALUE into an error message", () => {
    // `die` takes one preformatted string and the call sites pass variable
    // NAMES and paths. A message that echoed the credential to explain that
    // the credential was wrong is the one disclosure this file prevents.
    expect(SHIM_CODE).not.toMatch(/die .*\$\{?RALLY_APIKEY/);
    expect(SHIM_CODE).not.toMatch(/echo.*\$\{?RALLY_APIKEY/);
  });

  it("execs, so no parent survives holding the credential", () => {
    expect(SHIM).toMatch(/^exec "\$\{REAL\}" "\$@"$/m);
  });
});

describe("the skill documents the CLI that actually ships", () => {
  /**
   * The document is the worker's whole knowledge of this tool, and its history
   * is the argument for checking it: it specified `Authorization: Token` for
   * months — a header Rally answers with an HTML login page — because nothing
   * re-ran the sentence. These are the claims a grep can hold.
   */
  it("tells the worker not to pass the credential itself", () => {
    expect(SKILL).toContain("You never handle the credential");
  });

  it("carries the stderr rule, which is the one that breaks JSON pipes", () => {
    // rally-cli fans some queries across artifact types and prints Rally's
    // rejection of the inapplicable ones to stderr BEFORE the JSON. Merged in,
    // it is a parse failure that reads like a broken query.
    expect(SKILL).toContain("2>/dev/null");
    expect(SKILL).not.toMatch(/--format json 2>&1 \|/);
  });

  it("names the CLI's own key spellings rather than Rally's WSAPI ones", () => {
    // `--format json` returns snake_case. Code written against FormattedID
    // gets nothing from every row and reports nothing wrong.
    expect(SKILL).toContain("formatted_id");
    expect(SKILL).toContain("snake_case");
  });

  it("still requires the artifact pair, which the transport change does not touch", () => {
    expect(SKILL).toContain("ticket-ops.json");
    expect(SKILL).toContain("A run that writes only `ticket-ops.md` FAILS");
  });
});
