/**
 * Every `COPY` source in `docker/Dockerfile` is enrolled in `BUILD_CONTEXT_ASSETS`
 * (ISC-270).
 *
 * WHAT IS BROKEN TODAY: NOTHING, and that is the point. The array is
 * `["Dockerfile", "verbgate", "entrypoint.sh"]` and the only context sources in
 * the Dockerfile are `docker/verbgate` (lines 78-82) and `docker/entrypoint.sh`
 * (line 164), so it covers the build context exactly. This file is not a
 * repair. It is the thing that keeps the array correct once nobody remembers
 * that it has to be.
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
 * Two files off disk, no daemon, no image build: this runs in the fast `test`
 * job on every PR and does not wait on the `up` image gate that ISC-32 and
 * ISC-189 are blocked behind.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BUILD_CONTEXT_ASSETS, buildContextPath, dockerfilePath } from "../../src/container/image.ts";
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
    expect(sources.length).toBeGreaterThanOrEqual(6);

    const names = new Set(sources.map((s) => assetNameOf(s.source)));
    expect(names).toEqual(new Set(["verbgate", "entrypoint.sh"]));
  });

  test("the enrolled names are the measured ones, so a silent shrink of the array is visible", () => {
    // Pinned to what was measured rather than derived from the array itself:
    // deriving it would make the assertion agree with any array at all.
    expect([...BUILD_CONTEXT_ASSETS]).toEqual(["Dockerfile", "verbgate", "entrypoint.sh"]);
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
