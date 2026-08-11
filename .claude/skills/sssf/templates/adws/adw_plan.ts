#!/usr/bin/env bun
/**
 * ADW Plan — one-shot planning workflow.
 *
 * Usage:
 *     bun adws/adw_plan.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { AgentCall, PhaseParams, PlanOutput } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["planner"];

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
      name: "plan",
      kind: "agent",
      owner: "planner",
      description: "Turn the request into an implementable plan",
    }),
    (ph) =>
      ph.call(
        AgentCall({
          output_type: PlanOutput,
          prompt,
          gates: [gates.artifacts_exist, gates.files_non_empty],
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
    main(utils.resolve_prompt(positionals[0] ?? ""), values.config, values["adw-id"]),
  );
}
