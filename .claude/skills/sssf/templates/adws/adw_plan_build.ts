#!/usr/bin/env bun
/**
 * ADW Plan Build — two-agent chain: planner -> envelope -> builder.
 *
 * Usage:
 *     bun adws/adw_plan_build.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> git(commit)
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { AgentCall, BuildOutput, PhaseParams, PlanOutput } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git_helper from "./adw_modules/git_helper.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["planner", "builder"];

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

  const plan = await run.phase(
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

  const build = await run.phase(
    PhaseParams({
      name: "build",
      kind: "agent",
      owner: "builder",
      description: "Implement the plan exactly",
    }),
    (ph) =>
      ph.call(
        AgentCall({
          output_type: BuildOutput,
          prompt,
          previous: plan,
          gates: [gates.diff_matches_claims],
        }),
      ),
  );

  await run.phase(
    PhaseParams({
      name: "commit",
      kind: "code",
      owner: "git",
      description: "Land the builder's changes, using the message it wrote",
    }),
    (ph) => {
      const message = build.commit_message || `sssf(${run.adw_id}): ${build.summary}`;
      ph.log({ sha: git_helper.commit_all(message), message });
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
    main(utils.resolve_prompt(positionals[0] ?? ""), values.config, values["adw-id"]),
  );
}
