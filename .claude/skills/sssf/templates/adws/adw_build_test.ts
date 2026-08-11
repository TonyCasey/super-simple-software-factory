#!/usr/bin/env bun
/**
 * ADW Build Test — implement, then verify; failures flow back into the builder.
 *
 * Usage:
 *     bun adws/adw_build_test.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *
 * Testing is CODE. The suite's command is written down in adw_modules/quality.ts,
 * so running it needs no judgement — only repairing it does. Failures reach the
 * builder as an envelope through `quality.as_envelope`, which is the same door an
 * agent's report came through, so the repair loop is unchanged.
 *
 * A failing suite does NOT fail its phase: the runner did its job, the code is
 * what failed. It fails the run, checked at the end, after the bounded fix loop
 * has had its chances.
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import type { QualityResult } from "./adw_modules/data_types.ts";
import { AgentCall, BuildOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as quality from "./adw_modules/quality.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["builder"];
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

  await run.phase(
    PhaseParams({
      name: "build",
      kind: "agent",
      owner: "builder",
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

    await run.phase(
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
            gates: [gates.diff_matches_claims],
          }),
        ),
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
