#!/usr/bin/env bun
/**
 * ADW Plan Build Test Quality — full agent chain plus deterministic quality.
 *
 * Usage:
 *     bun adws/adw_plan_build_test_quality.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> [code(verify) -> code(test) -> builder(fix)] bounded -> git(commit)
 *
 * Verify and test are CODE, not agents. Their commands are known, so running them
 * needs no judgement — only repairing them does. A failing block does not fail its
 * phase: the runner did its job, the code is what failed. The failure becomes an
 * envelope and flows back into the builder, and only an exhausted repair loop
 * fails the run.
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
          gates: [gates.diff_matches_claims],
        }),
      ),
  );

  const record = (ph: PhaseHandle, result: QualityResult): void => {
    const passed = result.checks.filter((check) => check.passed).length;
    ph.log({
      passed: result.passed,
      checks: `${passed}/${result.checks.length}`,
      artifacts: result.artifacts.join(", "),
    });
  };

  let test_result: QualityResult | null = null;
  let quality_result: QualityResult | null = null;
  for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
    quality_result = await run.phase(
      PhaseParams({
        name: `verify_${i}`,
        kind: "code",
        owner: "quality",
        description: "Lint, typecheck, and build before testing",
      }),
      async (ph) => {
        const result = await quality.run_quality(run);
        record(ph, result);
        return result;
      },
    );

    // run_quality() already includes the test block; a repo that wants tests
    // in their own phase can split them out the way this comment does.
    test_result = quality_result;

    if (quality_result.passed && test_result.passed) break;
    if (i === MAX_FIX_LOOPS) break;

    // Whichever block failed becomes the builder's spec — verbatim command
    // output, no parser standing between the failure and the fix.
    const broken = quality_result.passed ? test_result : quality_result;
    const what = quality_result.passed ? "tests" : "verification";
    previous = await run.phase(
      PhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: `Resolve the reported ${what} failures`,
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: BuildOutput,
            prompt,
            previous: quality.as_envelope(broken, what),
            gates: [gates.diff_matches_claims],
          }),
        ),
    );
  }

  const verified = Boolean(quality_result?.passed && test_result?.passed);
  if (verified) {
    await run.phase(
      PhaseParams({
        name: "commit",
        kind: "code",
        owner: "git",
        description: "Commit the tested and quality-verified working tree",
      }),
      (ph) => {
        const message = previous.commit_message || `sssf(${run.adw_id}): ${previous.summary}`;
        ph.log({ sha: git_helper.commit_all(message), message });
      },
    );
  }

  return run.finish(
    verified,
    `verify/test never came back clean after ${MAX_FIX_LOOPS} fix attempt(s)`,
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
