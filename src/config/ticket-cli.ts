/**
 * The ticket CLI baked into every worker image — what is pinned, and where it
 * lives.
 *
 * ## Why the image carries one now
 *
 * `skills/ticket-ops/SKILL.md` used to open by refusing exactly this: "there is
 * no ticket CLI in the image and there is not going to be one", because baking
 * one "puts a vendor's name in the image hash and in a public repository" and
 * pins the fleet to whatever that CLI calls an update.
 *
 * The first ground is spent. This repository is private, and the skill has
 * named `rally1.rallydev.com` in its own table since 2026-08-30 — the vendor is
 * already here, and a CLI adds no disclosure the endpoint did not.
 *
 * The second is real, and is answered by the pin rather than by abstention. See
 * `TICKET_CLI_COMMIT`.
 *
 * WHAT THE CHANGE ACTUALLY BUYS is the argument the refusal did not weigh: the
 * hand-rolled `curl` path had to be TAUGHT the vendor. Which URL segment is a
 * user story (`hierarchicalrequirement`, which the URL does not spell "story"),
 * that a `FormattedID` is not an object id and cannot be substituted into a
 * path, which fields must appear in `fetch=` or the reply is tens of kilobytes
 * of JSON. Every one of those was a sentence in a document that nothing re-ran,
 * and the document was WRONG about the most important one for months: it
 * specified `Authorization: Token`, which Rally answers with a 401 and an HTML
 * login page, and nothing caught it because no credential existed on any
 * machine that ran this fleet. A CLI turns that class of error into a command
 * that fails loudly with a message about the thing that is actually wrong.
 *
 * ## The three-way agreement this module is the middle of
 *
 *   the pin (here)  ←test→  the Dockerfile's ARGs  ←build→  the image
 *
 * `test/unit/ticket-cli.test.ts` asserts the first arrow. The Dockerfile
 * asserts the second by running `rally-cli --version` and grepping for the
 * pinned version at build time, so an image built from a mistyped commit FAILS
 * TO BUILD rather than shipping a worker running something else. That second
 * arrow is why the version here is a fact rather than a claim — exactly the
 * shape `src/config/themes.ts` argues for, and for the same reason.
 */

/**
 * The commit the image installs. MUST match the Dockerfile's
 * `TICKET_CLI_COMMIT`.
 *
 * A COMMIT and not a tag, and that is the whole answer to "a CLI pins you to
 * whatever it decides an update is". A git tag is a moving reference: the same
 * `v1.2.0` can be re-pointed at new code, and an image rebuilt a month later
 * would install it under a Dockerfile whose bytes never changed — so the
 * config hash would be unmoved and two workers on "the same image" would run
 * different tools. A commit sha cannot be re-pointed. Bumping it is a diff
 * someone reviews, which is the property the refusal wanted and the mechanism
 * it did not consider.
 */
export const TICKET_CLI_COMMIT = "38a3b5e462393259c215ddc6babae505d62be1e2";

/**
 * The release that commit is, as `rally-cli --version` prints it.
 *
 * Carried SEPARATELY from the commit because it is what the build-time check
 * can actually observe: `pip install` of a git ref succeeds for any commit that
 * builds, so presence proves nothing about identity. The Dockerfile greps this
 * string out of `--version`, which is the only assertion in the chain that a
 * wrong sha cannot satisfy.
 */
export const TICKET_CLI_VERSION = "1.2.0";

/** The published entry point, on `PATH` inside every worker container. */
export const TICKET_CLI_BIN = "rally-cli";

/**
 * The virtualenv the CLI is installed into, INSIDE the container.
 *
 * Its own venv rather than the system python, so the `python` toolchain
 * variant's site-packages stay the operator's. `textual`, `httpx` and
 * `pydantic` are this tool's dependencies and not the fleet's, and a worker
 * doing Python work must not find them already resolved at versions it did not
 * choose. Only `TICKET_CLI_BIN` is published onto `PATH`.
 *
 * Under `/opt/pifleet` for the reason `THEMES_DIR` is: it is outside every
 * mount this fleet makes, so nothing baked here can be masked at run time by a
 * named volume — which would be invisible in real runs and visible in every
 * probe that mounts nothing.
 */
export const TICKET_CLI_VENV = "/opt/pifleet/rally-cli";

/**
 * The environment variables the CLI reads its configuration from.
 *
 * Named here because the SKILL has to bridge two vocabularies: the fleet
 * delivers `TICKET_*` (see `fleet.example.yaml`'s `env_allowlist`, which is
 * deliberately vendor-neutral) and the CLI reads `RALLY_*`. That mapping is a
 * fact about the tool, so it lives beside the pin rather than only in prose.
 *
 * `RALLY_APIKEY` is the credential and is the reason the skill writes a `.env`
 * file instead of exporting anything: `pydantic-settings` reads `.env` from the
 * working directory, which is the same "file to process, never through a shell
 * variable or an argv" route the old `curl --config` construction took.
 */
export const TICKET_CLI_ENV = {
  apikey: "RALLY_APIKEY",
  server: "RALLY_SERVER",
  workspace: "RALLY_WORKSPACE",
  project: "RALLY_PROJECT",
} as const;
