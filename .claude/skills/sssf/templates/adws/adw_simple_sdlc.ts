#!/usr/bin/env bun
/**
 * ADW Simple SDLC — plan, build, test, review, document, committing as it goes.
 *
 * Usage:
 *     bun adws/adw_simple_sdlc.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *     bun adws/adw_simple_sdlc.ts "<prompt>" --sandbox ABC-123 [--fresh] [--detach]
 *
 * `--sandbox <ticket>` runs this exact chain inside a per-ticket exe.dev VM
 * instead of on this machine: the harness boots the VM, provisions it (incl.
 * postgres when configured), clones the repo, copies in the factory, launches
 * this same script detached in there, and pulls the commits home into
 * refs/sandbox/. See adw_modules/sandbox_dispatch.ts and cookbooks/sandbox.md.
 *
 * Phases: engineer(request) -> planner -> git(commit_plan)
 *         -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> reviewer [-> builder(revise) -> reviewer ... bounded]
 *         -> code(retest, only if a revision changed code)
 *         -> git(commit_build) -> code(changes) -> documenter -> git(commit_docs)
 *
 * Three commits, three work products, three authors. The plan, the code, and the
 * write-up each land in their own commit, and each commit message is the words of
 * the agent that produced it — `commit_message` on PlanOutput describes the spec,
 * on BuildOutput the code, on DocumentOutput the write-up. No agent's sentence is
 * ever reused for another agent's diff.
 *
 * Testing is CODE, not an agent. `bun test` is a command, not a judgement call:
 * an agent rediscovering it every run costs a million tokens to learn what a
 * subprocess already knows. Failures travel back to the builder as an envelope,
 * so the repair loop is unchanged — only the runner became free and repeatable.
 *
 * Two different questions still get asked, in order. The suite asks "does it
 * run"; the reviewer asks "is this what was asked for", against `plan.md` — and
 * neither can answer the other's. A revision that closes a review finding
 * re-enters the suite, so the tree that gets committed is the tree that was both
 * tested and approved.
 *
 * The code commit lands after verification, not straight after the build: fixes
 * and revisions are part of the same work product, and red code has no business
 * on the branch. A run that fails verification therefore leaves the plan
 * committed and the working tree dirty — the spec is a real artifact either way,
 * and the unfinished code stays where the engineer can see it.
 *
 * The documenter measures against the commit this run STARTED from, not against
 * `main`, because by then the run has moved `main` itself. That baseline is
 * pinned before the first commit phase and printed in the request phase.
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import * as changes from "./adw_modules/changes.ts";
import type {
  BuildOutput as BuildOutputType,
  QualityResult,
  ReviewOutput as ReviewOutputType,
} from "./adw_modules/data_types.ts";
import {
  AgentCall,
  BuildOutput,
  DocumentOutput,
  PhaseParams,
  PlanOutput,
  ReviewOutput,
} from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git_helper from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";
import * as sandbox_dispatch from "./adw_modules/sandbox_dispatch.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

export const REQUIRED_AGENTS = ["planner", "builder", "reviewer", "documenter"];
const MAX_FIX_LOOPS = 3;
const MAX_REVISION_LOOPS = 2;

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the " +
  "diff shows, then copy the write-up into app_docs/ as your task " +
  "describes.";

export async function main(
  prompt: string,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adw_id);
  const result = await chain(run, prompt);
  return run.finish(result.verified, result.reason);
}

/**
 * The SDLC phase chain, runnable inside any existing session — this is how
 * adw_sdlc_pr reuses the exact same plan/build/test/review/document sequence
 * and appends its push/PR phases after it, with zero duplicated logic.
 */
export async function chain(
  run: import("./adw_modules/runner.ts").Run,
  prompt: string,
): Promise<{ verified: boolean; reason: string }> {
  const baseline = git_helper.rev("HEAD"); // pinned before this run commits anything

  /** Commit what the preceding phase produced, in that agent's own words. */
  const commit = (ph: PhaseHandle, envelope: { commit_message: string; summary: string }): void => {
    const message = envelope.commit_message || `sssf(${run.adw_id}): ${envelope.summary}`;
    ph.log({ sha: git_helper.commit_all(message), message });
  };

  /** Log a deterministic block's verdict — the same shape every ADW uses. */
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
    (ph) => ph.log({ input: prompt, baseline: git_helper.short_sha(baseline) }),
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

  await run.phase(
    PhaseParams({
      name: "commit_plan",
      kind: "code",
      owner: "git",
      description: "Put the spec on record before any code exists to blur it",
    }),
    (ph) => commit(ph, plan),
  );

  let build: BuildOutputType = await run.phase(
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

    build = await run.phase(
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

  let review: ReviewOutputType | null = null;
  let revised = false;
  for (let i = 1; i <= MAX_REVISION_LOOPS; i++) {
    review = await run.phase(
      PhaseParams({
        name: `review_${i}`,
        kind: "agent",
        owner: "reviewer",
        description: "Confirm the build matches the plan",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: ReviewOutput,
            prompt,
            previous: build,
            gates: [gates.artifacts_exist, gates.verdict_consistent],
          }),
        ),
    );

    if (review.approved || i === MAX_REVISION_LOOPS) break;

    build = await run.phase(
      PhaseParams({
        name: `revise_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Close the reviewer's blocking findings",
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
    revised = true;
  }

  // A revision edited code after the suite last ran, so the green light is
  // stale. Re-run it rather than commit on a result that predates the change.
  if (revised && review !== null && review.approved) {
    test = await run.phase(
      PhaseParams({
        name: "retest",
        kind: "code",
        owner: "quality",
        description: "Re-run the suite — the revision changed code after the last green result",
      }),
      async (ph) => {
        const result = await quality.run_tests(run);
        record(ph, result);
        return result;
      },
    );
  }

  // Red tests or a rejected review stop the chain here: the code stays
  // uncommitted and nothing is documented, because there is nothing worth
  // describing yet. The plan commit stands — it is a record of what was asked.
  const verified = Boolean(test?.passed && review?.approved);
  if (verified) {
    await run.phase(
      PhaseParams({
        name: "commit_build",
        kind: "code",
        owner: "git",
        description: "Land the code only now: green suite, approved review",
      }),
      (ph) => commit(ph, build),
    );

    const changeset = await run.phase(
      PhaseParams({
        name: "changes",
        kind: "code",
        owner: "git",
        description: "Diff the whole run against its pinned baseline, for the documenter",
      }),
      (ph) => {
        const captured = changes.capture(run, { base: baseline });
        ph.log({
          base: `${captured.base.label} @ ${captured.base.commit.slice(0, 7)}`,
          reason: captured.base.reason,
          files: captured.files.length + captured.untracked.length,
          lines: `+${captured.insertions} -${captured.deletions}`,
          diff: captured.diff_path,
        });
        if (captured.empty) {
          throw new Error(
            `nothing changed since ${captured.base.label} ` +
              `(${captured.base.reason}) — there is nothing to document.`,
          );
        }
        return captured;
      },
    );

    const document = await run.phase(
      PhaseParams({
        name: "document",
        kind: "agent",
        owner: "documenter",
        retries: 1,
        description: "Write up the completed change",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: DocumentOutput,
            prompt,
            previous: changes.as_envelope(changeset, DOCUMENT_NOTES),
            gates: [gates.artifacts_exist, gates.files_non_empty],
          }),
        ),
    );

    await run.phase(
      PhaseParams({
        name: "commit_docs",
        kind: "code",
        owner: "git",
        description: "Ship the write-up in its own commit, beside the code it describes",
      }),
      (ph) => commit(ph, document),
    );
  }

  return { verified, reason: "the suite or the review never came back clean" };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
      sandbox: { type: "string" }, // ticket id — run the whole chain in a per-ticket exe.dev VM
      fresh: { type: "boolean", default: false }, // force a new VM instead of reusing the ticket's
      detach: { type: "boolean", default: false }, // launch and return; watch later with sandbox-watch
    },
    allowPositionals: true,
  });
  await session.cli(() => {
    const prompt = utils.require_prompt(
      positionals,
      "\"<prompt or path/to/prompt.md>\" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4] [--sandbox ABC-123 [--fresh] [--detach]]",
    );
    return values.sandbox
      ? sandbox_dispatch.dispatch({
          ticket: values.sandbox!,
          prompt,
          adw: "simple_sdlc",
          config_path: values.config,
          fresh: values.fresh,
          detach: values.detach,
        })
      : main(prompt, values.config, values["adw-id"]);
  });
}
