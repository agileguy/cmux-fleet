import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { ConfigError, loadConfig } from "../../config/load.ts";
import { ToolchainSchema, type Toolchain } from "../../config/schema.ts";
import {
  buildImage,
  gcImages,
  imageTag,
  listImages,
  verifyImage,
} from "../../container/image.ts";
import { dockerAvailable } from "../../container/run.ts";

/**
 * Register `pifleet image` (SRD §5.7, §10): build | list | verify | gc.
 *
 * `verify` failing is load-bearing: `up` refuses to start on it, so a run
 * never silently uses an image whose Pi differs from the §4.2 protocol pin.
 */
export function register(program: Command): void {
  program
    .command("image <action>")
    .description("Build, list, verify or garbage-collect worker images")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--toolchain <name>", "toolchain layer: base|node|python|go|full", "base")
    .option("--pi-version <v>", "override the configured Pi version pin")
    .option("--tag <t>", "explicit image tag")
    .option("--keep <n>", "gc: newest tags to keep", "3")
    .option("--json", "emit machine-readable output")
    .action(
      async (
        action: string,
        opts: {
          config?: string;
          toolchain: string;
          piVersion?: string;
          tag?: string;
          keep: string;
          json?: boolean;
        },
      ) => {
        const tc = ToolchainSchema.safeParse(opts.toolchain);
        if (!tc.success) {
          throw new CliError(`unknown toolchain "${opts.toolchain}" (base|node|python|go|full)`, EXIT.USAGE);
        }
        const toolchain: Toolchain = tc.data;

        let loaded;
        try {
          loaded = await loadConfig(opts.config);
        } catch (err) {
          if (err instanceof ConfigError) throw new CliError(err.message, EXIT.USAGE);
          throw err;
        }
        const config = loaded.config;

        if (!(await dockerAvailable())) {
          throw new CliError("docker daemon is not reachable", EXIT.BACKEND_UNAVAILABLE);
        }

        switch (action) {
          case "build": {
            const result = await buildImage(config, {
              toolchain,
              piVersion: opts.piVersion,
              tag: opts.tag,
            });
            if (!result.ok) {
              throw new CliError(`image build failed for ${result.tag}:\n${result.stderr}`, EXIT.BACKEND_UNAVAILABLE);
            }
            if (opts.json) console.log(JSON.stringify({ built: result.tag }));
            else console.log(`built ${result.tag}`);
            return;
          }
          case "list": {
            const images = await listImages(config);
            if (opts.json) console.log(JSON.stringify(images, null, 2));
            else if (images.length === 0) console.log("no worker images");
            else for (const i of images) console.log(`${i.tag}\t${i.size}\t${i.created}`);
            return;
          }
          case "verify": {
            const tag = opts.tag ?? imageTag(config, toolchain);
            const expected = opts.piVersion ?? config.docker.pi_version;
            const result = await verifyImage(tag, expected);
            if (opts.json) console.log(JSON.stringify(result, null, 2));
            else {
              for (const c of result.checks) {
                console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
              }
            }
            if (!result.ok) {
              throw new CliError(`image ${tag} failed verification`, EXIT.BACKEND_UNAVAILABLE);
            }
            return;
          }
          case "gc": {
            const keep = Number.parseInt(opts.keep, 10);
            if (!Number.isInteger(keep) || keep < 0) {
              throw new CliError(`--keep must be a non-negative integer, got "${opts.keep}"`, EXIT.USAGE);
            }
            const result = await gcImages(config, keep);
            if (opts.json) console.log(JSON.stringify(result, null, 2));
            else console.log(`kept ${result.kept.length}, removed ${result.removed.length}`);
            return;
          }
          default:
            throw new CliError(`unknown image action "${action}" (build|list|verify|gc)`, EXIT.USAGE);
        }
      },
    );
}
