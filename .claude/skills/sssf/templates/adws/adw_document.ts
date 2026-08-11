#!/usr/bin/env bun
/**
 * ADW Document — write up the work that was just done, from the diff.
 *
 * Usage:
 *     bun adws/adw_document.ts "<prompt or path/to/prompt.md>" [--base main] [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> code(changes) -> documenter
 *
 * This runs AFTER a build, and the guard is structural rather than advisory: the
 * change capture is a code phase, and an empty diff throws there — before the
 * documenter is ever spawned. There is nothing to document until something was
 * built, and the phase says so instead of paying an agent to discover it.
 *
 * `git diff` against `--base` (main by default) is what "the latest changes"
 * means here; see adw_modules/changes.ts for how the base commit is resolved on a
 * branch, on main, and on a clean tree right after a chain committed.
 */

import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import * as changes from "./adw_modules/changes.ts";
import { AgentCall, DocumentOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["documenter"];

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the " +
  "diff shows, then copy the write-up into app_docs/ as your task " +
  "describes.";

export async function main(
  prompt: string,
  base = "main",
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

  const changeset = await run.phase(
    PhaseParams({
      name: "changes",
      kind: "code",
      owner: "git",
      description: `Diff the working tree against ${base} — the change to be written up`,
    }),
    (ph) => {
      const captured = changes.capture(run, { base });
      ph.log({
        base: `${captured.base.label} @ ${captured.base.commit.slice(0, 7)}`,
        reason: captured.base.reason,
        files: captured.files.length + captured.untracked.length,
        lines: `+${captured.insertions} -${captured.deletions}`,
        diff: captured.diff_path,
      });
      if (captured.empty) {
        throw new Error(
          `nothing changed since ${captured.base.label} (${captured.base.reason}) ` +
            `— documenting runs after a build. Build something first, or point ` +
            `--base at the ref the work should be measured from.`,
        );
      }
      return captured;
    },
  );

  await run.phase(
    PhaseParams({
      name: "document",
      kind: "agent",
      owner: "documenter",
      retries: 1,
      description: "Turn the captured diff into a write-up an engineer can read",
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

  return run.finish();
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      base: { type: "string", default: "main" },
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
    },
    allowPositionals: true,
  });
  await session.cli(() =>
    main(
      utils.resolve_prompt(positionals[0] ?? ""),
      values.base,
      values.config,
      values["adw-id"],
    ),
  );
}
