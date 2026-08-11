#!/usr/bin/env bun
/**
 * ADW Build — one-shot implementation workflow.
 *
 * Usage:
 *     bun adws/adw_build.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { AgentCall, BuildOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["builder"];

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
      description: "Capture the incoming ask",
    }),
    (ph) => ph.log({ input: prompt }),
  );

  await run.phase(
    PhaseParams({
      name: "build",
      kind: "agent",
      owner: "builder",
      retries: 1,
      description: "Implement the request",
    }),
    (ph) =>
      ph.call(
        AgentCall({
          output_type: BuildOutput,
          prompt,
          gates: [gates.diff_matches_claims],
        }),
      ),
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
    main(utils.require_prompt(positionals, "\"<prompt or path/to/prompt.md>\" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]"), values.config, values["adw-id"]),
  );
}
