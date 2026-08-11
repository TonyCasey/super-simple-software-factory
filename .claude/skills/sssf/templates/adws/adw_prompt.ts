#!/usr/bin/env bun
/**
 * ADW Prompt — the smallest ADW: one agent, one prompt, traced end-to-end.
 *
 * Usage:
 *     bun adws/adw_prompt.ts "<prompt or path/to/prompt.md>" [--agent builder] [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> <agent>
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { AgentCall, GenericOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

export async function main(
  prompt: string,
  agent = "builder",
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, [agent]);
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
      name: "prompt",
      kind: "agent",
      owner: agent,
      description: `Send the request straight to ${agent} and parse its envelope`,
    }),
    (ph) => ph.call(AgentCall({ output_type: GenericOutput, prompt })),
  );

  return run.finish();
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      agent: { type: "string", default: "builder" },
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
    },
    allowPositionals: true,
  });
  await session.cli(() =>
    main(
      utils.require_prompt(positionals, "\"<prompt or path/to/prompt.md>\" [--agent builder] [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]"),
      values.agent,
      values.config,
      values["adw-id"],
    ),
  );
}
