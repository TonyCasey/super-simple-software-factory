#!/usr/bin/env bun
/**
 * ADW Quality — lint, typecheck, and build the project.
 *
 * Usage:
 *     bun adws/adw_quality.ts "<reason for the quality run>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> code(quality)
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { PhaseParams } from "./adw_modules/data_types.ts";
import * as quality from "./adw_modules/quality.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS: string[] = [];

export async function main(
  prompt: string,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adw_id);

  await run.phase(
    PhaseParams({
      name: "request",
      kind: "engineer",
      owner: run.engineer,
      description: "Capture why quality verification was requested",
    }),
    (ph) => ph.log({ input: prompt }),
  );

  await run.phase(
    PhaseParams({
      name: "quality",
      kind: "code",
      owner: "quality",
      description: "Run the deterministic quality blocks",
    }),
    async (ph) => {
      const result = await quality.run_quality(run);
      const passed = result.checks.filter((check) => check.passed).length;
      ph.log({
        passed: result.passed,
        checks: `${passed}/${result.checks.length}`,
        artifacts: result.artifacts.join(", "),
      });
      if (!result.passed) {
        throw new Error("quality failed: " + result.failures.join("; "));
      }
    },
  );

  return run.finish();
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
    },
    allowPositionals: true,
  });
  await session.cli(() =>
    main(utils.require_prompt(positionals, "\"<reason for the quality run>\" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]"), values.config, values["adw-id"]),
  );
}
