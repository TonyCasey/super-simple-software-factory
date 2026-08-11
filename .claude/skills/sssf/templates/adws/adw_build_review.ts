#!/usr/bin/env bun
/**
 * ADW Build Review — implement, then confirm it is what was asked for.
 *
 * Usage:
 *     bun adws/adw_build_review.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder -> reviewer [-> builder(revise) -> reviewer ... bounded]
 *
 * Review is not testing. Tests answer "does it run"; the reviewer answers "is this
 * the thing that was asked for" — it reads the spec (`plan.md` from a prior plan
 * phase if the session has one, else the prompt verbatim), reads the code that was
 * written, and rules on each requirement.
 *
 * Like the tester, the reviewer's phase succeeds when it RUNS and REPORTS. A
 * rejection does not fail the phase; it fails the run, checked at the end, after
 * the bounded revise loop has had its chances.
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import type { EnvelopeBase, ReviewOutput as ReviewOutputType } from "./adw_modules/data_types.ts";
import { AgentCall, BuildOutput, PhaseParams, ReviewOutput } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["builder", "reviewer"];
const MAX_REVISION_LOOPS = 3;

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

  let previous: EnvelopeBase = await run.phase(
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

  let review: ReviewOutputType | null = null;
  for (let i = 1; i <= MAX_REVISION_LOOPS; i++) {
    review = await run.phase(
      PhaseParams({
        name: `review_${i}`,
        kind: "agent",
        owner: "reviewer",
        description: "Rule on every requirement in the spec, against the code on disk",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: ReviewOutput,
            prompt,
            previous,
            gates: [gates.artifacts_exist, gates.verdict_consistent],
          }),
        ),
    );

    if (review.approved) break;
    if (i === MAX_REVISION_LOOPS) break;

    previous = await run.phase(
      PhaseParams({
        name: `revise_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Close every blocking finding the reviewer named",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: BuildOutput,
            prompt,
            previous: review,
            gates: [gates.diff_matches_claims],
          }),
        ),
    );
  }

  return run.finish(
    review !== null && review.approved,
    `the reviewer never approved after ${MAX_REVISION_LOOPS} revision(s)`,
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
    main(utils.require_prompt(positionals, "\"<prompt or path/to/prompt.md>\" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]"), values.config, values["adw-id"]),
  );
}
