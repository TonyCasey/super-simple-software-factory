#!/usr/bin/env bun
/**
 * ADW Plan Build Test — the full starter chain.
 *
 * Usage:
 *     bun adws/adw_plan_build_test.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded] -> git(commit)
 *
 * Testing is CODE: the suite's command lives in adw_modules/quality.ts, so no
 * agent spends a context window rediscovering it. Failures flow back to the
 * builder as an envelope, and only an exhausted fix loop fails the run.
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import type { BuildOutput as BuildOutputType, QualityResult } from "./adw_modules/data_types.ts";
import { AgentCall, BuildOutput, PhaseParams, PlanOutput } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git_helper from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["planner", "builder"];
const MAX_FIX_LOOPS = 3;

export async function main(
  prompt: string,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adw_id);

  const record = (ph: PhaseHandle, result: QualityResult): void => {
    const passed = result.checks.filter((check) => check.passed).length;
    ph.log({
      passed: result.passed,
      checks: `${passed}/${result.checks.length}`,
      artifacts: result.artifacts.join(", "),
    });
  };

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

  let previous: BuildOutputType = await run.phase(
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
          gates: [gates.artifacts_exist],
        }),
      ),
  );

  let test: QualityResult | null = null;
  for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
    test = await run.phase(
      PhaseParams({
        name: `test_${i}`,
        kind: "code",
        owner: "quality",
        description:
          "Run the suite — a known command, so code runs it and no agent has to rediscover it",
      }),
      async (ph) => {
        const result = await quality.run_tests(run);
        record(ph, result);
        return result;
      },
    );

    if (test.passed) break;

    previous = await run.phase(
      PhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Repair what the suite reported, from its verbatim output",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: BuildOutput,
            prompt,
            previous: quality.as_envelope(test!, "tests"),
            gates: [gates.artifacts_exist],
          }),
        ),
    );
  }

  // Only tested work gets committed — a red suite leaves the tree uncommitted.
  if (test !== null && test.passed) {
    await run.phase(
      PhaseParams({
        name: "commit",
        kind: "code",
        owner: "git",
        description: "Land the code only after the suite came back green",
      }),
      (ph) => {
        const message = previous.commit_message || `sssf(${run.adw_id}): ${previous.summary}`;
        ph.log({ sha: git_helper.commit_all(message), message });
      },
    );
  }

  return run.finish(
    test !== null && test.passed,
    `the suite still failed after ${MAX_FIX_LOOPS} fix attempt(s)`,
  );
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
