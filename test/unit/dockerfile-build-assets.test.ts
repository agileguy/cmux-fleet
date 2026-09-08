/**
 * Every `COPY` source in `docker/Dockerfile` is enrolled in `BUILD_CONTEXT_ASSETS`
 * (ISC-270).
 *
 * WHAT IS BROKEN TODAY: NOTHING, and that is the point. `BUILD_CONTEXT_ASSETS`
 * carries eight names; the Dockerfile reads seven distinct files out of the
 * build context — `docker/verbgate` (COPYed five times, once per gated cloud
 * binary), `docker/ticket-cli`, `docker/entrypoint.sh`, `docker/honeypot.cjs`,
 * and the three `docker/pi-extensions/*.ts` — and `Dockerfile` itself is the
 * eighth enrolled name, the one nothing COPYs because it IS the recipe. So the
 * array covers the build context exactly. This file is not a repair. It is the
 * thing that keeps the array correct once nobody remembers that it has to be.
 *
 * AND THAT PARAGRAPH HAS BEEN WRONG BEFORE, which is the more useful fact
 * about it. It read, until 2026-09-08: *"The array is `["Dockerfile",
 * "verbgate", "entrypoint.sh"]` and the only context sources in the Dockerfile
 * are `docker/verbgate` (lines 78-82) and `docker/entrypoint.sh` (line 164)"*.
 * Every clause of that was true when it was written and not one of them was
 * true when it was read: `honeypot.cjs`, `ticket-cli` and three pi-extensions
 * arrived after it, and both line numbers had moved by hundreds. A header that
 * enumerates is a header that rots, and a rotted header that still SOUNDS
 * authoritative is worse than none — it tells the next reader the array is
 * three names long while they are looking at eight. The enumerations that are
 * load-bearing are therefore the assertions below, which fail when they are
 * wrong; the count above is prose and no line number appears in it deliberately.
 *
 * THE FAIL-OPEN IT CLOSES. `configHash` hashes the content of every file in
 * `BUILD_CONTEXT_ASSETS` and nothing else, and the array is maintained BY HAND.
 * Add a file the Dockerfile `COPY`s without adding it to the array and the hash
 * does not move, the tag does not move, and a stale image is silently reused —
 * the build succeeds and the run succeeds, against the wrong bytes. ISC-160
 * proves a stale image is not reused after an ENROLLED file changes; it cannot
 * observe a file that was never enrolled, because the hash it checks never
 * reads one.
 *
 * WHY THE PARSE LIVES IN `test/support/dockerfile-copy.ts`. So that the
 * assertion below is not the only thing that has ever run it. A sweep that
 * cannot be shown to produce a non-empty result on demand is indistinguishable
 * from a sweep that matches nothing — `test/support/env-sweep.ts` documents the
 * one this repo already shipped in that state. The fixture cases here drive the
 * reader in BOTH directions, so `expect(offenders).toEqual([])` below is an
 * empty array the reader is demonstrably capable of filling.
 *
 * ENROLMENT IS NOT THE WHOLE CLAIM, and the last block in this file is the
 * other half. Everything above asks whether a name is IN a list. What ISC-270
 * actually protects is that the image TAG moves when an enrolled file's bytes
 * move, and those are different claims: the first is satisfied by an array
 * entry, the second by `configHash` reading that entry off disk and the tag
 * carrying the result. `test/unit/render.test.ts`'s ISC-160 block is the
 * closest existing mechanism, but it covers `Dockerfile`, `verbgate` and
 * `entrypoint.sh` only, and it moves a digest STRING inside an `ImageInputs`
 * record rather than moving bytes on disk. For every other name in the array
 * the strongest assertion anywhere is MEMBERSHIP: `ticket-cli.test.ts`,
 * `auto-trigger.test.ts` and `truncation-recovery.test.ts` each carry one
 * `expect(BUILD_CONTEXT_ASSETS).toContain(...)`, `honeypot.cjs` has only the
 * generic sweeps here and in `render.test.ts`, and `report-tools.ts` had
 * nothing at all before this file. The final block below
 * closes that for `pi-extensions/report-tools.ts` end to end: it calls the real
 * `imageTag` twice across a real edit to the real file and compares the twelve
 * hex characters. Delete the array entry and it goes red, which is the whole
 * point of writing it that way round.
 *
 * Two files off disk, no daemon, no image build: this runs in the fast `test`
 * job on every PR and does not wait on the `up` image gate that ISC-32 and
 * ISC-189 are blocked behind.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import {
  BUILD_CONTEXT_ASSETS,
  buildContextDigests,
  buildContextPath,
  dockerfilePath,
  imageTag,
} from "../../src/container/image.ts";
import {
  assetNameOf,
  buildContextSources,
  formatUnenrolled,
  parseCopySources,
  unenrolledSources,
} from "../support/dockerfile-copy.ts";

const DOCKERFILE = readFileSync(dockerfilePath(), "utf8");

describe("the real docker/Dockerfile against the real BUILD_CONTEXT_ASSETS", () => {
  test("every COPY/ADD source read from the build context is enrolled in the hash", () => {
    const offenders = unenrolledSources(DOCKERFILE, [...BUILD_CONTEXT_ASSETS]);
    // The message, not just the count: a bare length assertion here tells the
    // next person that something is wrong and nothing about what.
    expect(formatUnenrolled(offenders)).toBe("");
    expect(offenders).toEqual([]);
  });

  test("the reader actually read the Dockerfile — an empty parse would pass the check above", () => {
    // This is the anti-vacuity clause. `unenrolledSources` returns [] both when
    // the Dockerfile is clean and when the parse silently matched nothing, and
    // only one of those two is evidence.
    const sources = buildContextSources(DOCKERFILE);
    expect(sources.length).toBeGreaterThanOrEqual(7);

    const names = new Set(sources.map((s) => assetNameOf(s.source)));
    expect(names).toEqual(
      new Set([
        "verbgate",
        "entrypoint.sh",
        "honeypot.cjs",
        "ticket-cli",
        "pi-extensions/dispatch-trigger.ts",
        "pi-extensions/truncation-recovery.ts",
        "pi-extensions/report-tools.ts",
      ]),
    );
  });

  test("the enrolled names are the measured ones, so a silent shrink of the array is visible", () => {
    // Pinned to what was measured rather than derived from the array itself:
    // deriving it would make the assertion agree with any array at all.
    expect([...BUILD_CONTEXT_ASSETS]).toEqual([
      "Dockerfile",
      "verbgate",
      "entrypoint.sh",
      "honeypot.cjs",
      // Added 2026-09-01 with the ticket CLI. It is COPYed onto PATH as
      // `rally-cli` and turns four delivered `_FILE` paths into the CLI's
      // environment, so an image carrying a stale copy queries the wrong scope
      // — which returns rows rather than an error.
      "ticket-cli",
      // The auto-trigger extension (§9 Q4). Pi EXECUTES it in-process, and a
      // stale copy stops firing silently, so it is the one asset here whose
      // absence from the hash would produce no error anywhere.
      "pi-extensions/dispatch-trigger.ts",
      // Added 2026-09-04. The second in-process extension, and stale in the
      // same silent direction: it reads Pi's `BashToolDetails`, so a copy that
      // no longer matches those field names finds no truncation to report and
      // every clipped result goes back to looking exactly as it did when a
      // worker re-ran the same command twice and answered nothing.
      "pi-extensions/truncation-recovery.ts",
      // Added 2026-09-08. The third in-process extension, and the only one of
      // the three that does not fail by falling silent: `submit_report`
      // validates and only then writes, so a stale copy keeps emitting
      // well-formed `pifleet.result/v1` envelopes — against a rule set that has
      // moved, and reading `task_id`/`epoch` out of `/policy/task` by a recipe
      // that has moved. The harvester cannot tell the two apart.
      "pi-extensions/report-tools.ts",
    ]);
  });

  test("every enrolled asset exists on disk, so the hash cannot be over a name nobody ships", () => {
    for (const asset of BUILD_CONTEXT_ASSETS) {
      const path = buildContextPath(asset);
      expect(() => readFileSync(path, "utf8")).not.toThrow();
    }
  });

  test("Dockerfile is enrolled although nothing COPYs it — the recipe is an input too", () => {
    // States the one asymmetry in the subset assertion, so a future reader does
    // not "tidy" the check into an equality and turn the recipe into an offender.
    expect(BUILD_CONTEXT_ASSETS).toContain("Dockerfile");
    expect(buildContextSources(DOCKERFILE).map((s) => s.source)).not.toContain("docker/Dockerfile");
  });
});

describe("the reader itself — both directions, on fixtures", () => {
  const enrolled = ["Dockerfile", "verbgate", "entrypoint.sh"];

  test("an unenrolled COPY source is reported, with its line and a reason", () => {
    const text = ["FROM scratch", "COPY docker/somefile /x"].join("\n");
    const offenders = unenrolledSources(text, enrolled);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.source).toBe("docker/somefile");
    expect(offenders[0]?.line).toBe(2);
    expect(formatUnenrolled(offenders)).toContain("BUILD_CONTEXT_ASSETS");
  });

  test("an enrolled COPY source is not reported", () => {
    const text = ["FROM scratch", "COPY --chmod=0755 docker/verbgate /usr/local/bin/gcloud"].join("\n");
    expect(unenrolledSources(text, enrolled)).toEqual([]);
  });

  test("a source outside docker/ is reported — the array cannot express it", () => {
    const text = ["FROM scratch", "COPY src/cli/index.ts /app/index.ts"].join("\n");
    const offenders = unenrolledSources(text, enrolled);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.why).toContain("outside");
  });

  test("ADD of a local path is read like COPY — the same fail-open, one keyword away", () => {
    const text = ["FROM scratch", "ADD docker/somefile /x"].join("\n");
    expect(unenrolledSources(text, enrolled)).toHaveLength(1);
  });

  test("--from=<stage> is not build context and is not demanded", () => {
    const text = [
      "FROM alpine AS builder",
      "FROM scratch",
      "COPY --from=builder /out/binary /usr/local/bin/binary",
    ].join("\n");
    expect(unenrolledSources(text, enrolled)).toEqual([]);
  });

  test("ADD from the network has no file to hash and is not demanded", () => {
    const text = ["FROM scratch", "ADD https://example.invalid/x.tar /x"].join("\n");
    expect(unenrolledSources(text, enrolled)).toEqual([]);
  });

  test("the destination is never mistaken for a source", () => {
    const text = ["FROM scratch", "COPY docker/verbgate docker/entrypoint.sh /usr/local/bin/"].join("\n");
    const sources = buildContextSources(text).map((s) => s.source);
    expect(sources).toEqual(["docker/verbgate", "docker/entrypoint.sh"]);
  });

  test("a continued instruction is read whole and reported at the line it starts on", () => {
    const text = [
      "FROM scratch",
      "COPY --chmod=0755 \\",
      "  docker/somefile \\",
      "  /x",
    ].join("\n");
    const offenders = unenrolledSources(text, enrolled);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.line).toBe(2);
  });

  test("a comment inside a continuation does not split the instruction", () => {
    const text = ["FROM scratch", "COPY \\", "# why this exists", "  docker/somefile \\", "  /x"].join("\n");
    expect(unenrolledSources(text, enrolled)).toHaveLength(1);
  });

  test("a COPY that is only mentioned in a comment is not an instruction", () => {
    const text = ["FROM scratch", "# COPY docker/somefile /x"].join("\n");
    expect(parseCopySources(text)).toEqual([]);
  });

  test("the JSON-array form is read", () => {
    const text = ["FROM scratch", 'COPY ["docker/somefile", "/x"]'].join("\n");
    const offenders = unenrolledSources(text, enrolled);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.source).toBe("docker/somefile");
  });

  test("a quoted shell operand is unquoted before it is matched", () => {
    const text = ["FROM scratch", 'COPY "docker/verbgate" /x'].join("\n");
    expect(unenrolledSources(text, enrolled)).toEqual([]);
  });

  test("a leading ./ is not a different file", () => {
    expect(assetNameOf("./docker/verbgate")).toBe("verbgate");
    expect(assetNameOf("docker/verbgate")).toBe("verbgate");
    expect(assetNameOf("dockerfiles/verbgate")).toBeNull();
    expect(assetNameOf("docker/../src/x")).toBeNull();
  });

  test("lowercase instructions are Dockerfile-legal and are read", () => {
    const text = ["FROM scratch", "copy docker/somefile /x"].join("\n");
    expect(unenrolledSources(text, enrolled)).toHaveLength(1);
  });
});

/**
 * The acceptance ISC-270 is actually about: the TAG MOVES.
 *
 * Everything above is enrolment — a name is in a list, and a `COPY` has a
 * matching entry. That is necessary and it is not the claim. The claim is that
 * editing the file produces a different image tag, and enrolment only implies
 * it if `configHash` really reads the enrolled name off disk and the tag really
 * carries the result. Those are three functions and a filesystem, and the
 * membership assertions above exercise none of them.
 *
 * WHY THE FILE IS EDITED FOR REAL. `render.test.ts`'s ISC-160 block does this
 * for `Dockerfile`, `verbgate` and `entrypoint.sh` by taking `imageInputs()`
 * and appending `"-edited"` to one digest inside the returned record. That is a
 * good test of `configHash` and it deliberately stops short of the filesystem:
 * the string it substitutes is one `assetDigestAt` could never produce. The
 * gap it leaves is the one that matters here — whether `buildContextPath`
 * resolves this asset to the file the Dockerfile COPYs — so this test moves
 * bytes on disk and calls the real `imageTag` on both sides, which is the
 * end-to-end statement and the one the SRD asks for.
 *
 * THE EDIT IS APPEND-ONLY, RESTORED IN `finally`, AND THE RESTORE IS ASSERTED.
 * A test that mutates a tracked file owes the reader all three. The window is a
 * few microseconds inside one synchronous block, `bun test` runs files
 * serially, and the restore is checked by digest AFTER the `finally` rather
 * than assumed — a `finally` that silently failed to write would otherwise
 * leave the tree dirty and this test still green.
 */
describe("the tag moves when an enrolled file's bytes move (ISC-270 acceptance)", () => {
  const EXAMPLE = join(import.meta.dir, "..", "..", "fleet.example.yaml");
  const ASSET = "pi-extensions/report-tools.ts" as const;
  /** The last field of `<prefix>:<pi-version>-<toolchain>-<config-hash>`. */
  const TAG = /^(.*)-([0-9a-f]{12})$/;

  /** sha256 of raw bytes — for proving the restore, not for hashing content. */
  const bytesOf = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

  test("editing docker/pi-extensions/report-tools.ts changes imageTag's twelve hex characters", async () => {
    const { config } = await loadConfig(EXAMPLE);
    const path = buildContextPath(ASSET);
    const original = readFileSync(path);

    const before = imageTag(config, "base");
    let after: string;
    try {
      // Append-only, and content a source file would never carry by accident:
      // the point is a byte change, and the smallest honest one is a comment.
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n// ISC-270 tag-movement probe\n")]));
      after = imageTag(config, "base");
    } finally {
      writeFileSync(path, original);
    }

    // The restore, first and unconditionally: every assertion below is worth
    // less than a clean tree, and this is the one that reports a dirty one.
    expect(bytesOf(readFileSync(path))).toBe(bytesOf(original));

    // Both sides are real tags. Without this, "the hashes differ" would also be
    // satisfied by a garbage value or a truncated string.
    const b = TAG.exec(before);
    const a = TAG.exec(after);
    expect(b, `${before} is not in imageTag's format`).not.toBeNull();
    expect(a, `${after} is not in imageTag's format`).not.toBeNull();

    // The hash moved…
    expect(a![2]).not.toBe(b![2]);
    // …and ONLY the hash moved. The prefix carries the image name, the pi
    // version and the toolchain, none of which this edit touches — so pinning
    // it is what makes the inequality above a statement about the build
    // context rather than about two unrelated tags.
    expect(a![1]).toBe(b![1]);
  });

  test("the digest the hash records for the extension is the bytes on disk", () => {
    // Derived independently of `image.ts`, so this compares two separately
    // arrived-at values rather than a function against itself. Without it the
    // test above would still pass if `buildContextPath` resolved somewhere
    // else entirely and the edit happened to land in the hashed file anyway.
    const onDisk = createHash("sha256")
      .update(readFileSync(buildContextPath(ASSET), "utf8").replace(/\r\n/g, "\n"))
      .digest("hex");
    expect(buildContextDigests()[ASSET]).toBe(onDisk);
  });
});
