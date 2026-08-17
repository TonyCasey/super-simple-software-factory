#!/usr/bin/env bun
/**
 * ADW SDLC→PR — the full simple-SDLC chain, then push the run branch and open
 * a draft PR. This is the ADW a ticket dispatch launches INSIDE the sandbox VM
 * (adw_ticket_ship → sandbox dispatch → this).
 *
 * Usage:
 *     bun adws/adw_sdlc_pr.ts "<prompt>" [--adw-id X] [--config ...]
 *         [--ticket ABC-123] [--ticket-title "..."] [--ticket-url https://...]
 *
 * Phases: [adw_simple_sdlc's exact chain, imported — zero duplication]
 *         -> code(push) -> code(create_pr)
 *
 * The push and the PR go through the exe.dev GitHub integration: the dispatch
 * set GH_HOST=github.int.exe.xyz in this VM's .env, the integration is
 * write-enabled, and no token material exists on this box. An unverified run
 * (red suite or unapproved review) opens NO PR — the chain's own gate stands:
 * red code has no business asking humans for review.
 *
 * `context_handoff/pr.json` is the contract with the host: adw_ticket_ship's
 * pr_readback reads exactly {url, number, branch} from it over ssh.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import { PhaseParams } from "./adw_modules/data_types.ts";
import * as git_helper from "./adw_modules/git_helper.ts";
import * as github_vm from "./adw_modules/github_vm.ts";
import * as session from "./adw_modules/session.ts";
import * as utils from "./adw_modules/utils.ts";
import { chain, REQUIRED_AGENTS } from "./adw_simple_sdlc.ts";

export interface TicketContext {
  ref: string; // ABC-123; "" when running ticketless
  title: string;
  url: string;
}

export async function main(
  prompt: string,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
  ticket: TicketContext = { ref: "", title: "", url: "" },
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adw_id);

  if (!cfg.remote.pr.include_workshop) {
    // Workshop artifacts (the plan spec, the app doc) inform the run and the
    // PR BODY, but do not ride in the PR as files. The chain's plan/docs
    // commits tolerate the resulting empty trees.
    const exclude = join(".git", "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    for (const dir of ["/specs/", "/app_docs/"]) {
      if (!current.includes(dir)) appendFileSync(exclude, `${dir}\n`);
    }
  }

  const result = await chain(run, prompt);
  if (!result.verified) {
    // No PR for unverified work — the branch (with the plan commit) stays in
    // the VM for harvest and diagnosis; asking a human to review red code is
    // exactly what the chain's gate exists to prevent.
    return run.finish(false, result.reason);
  }

  const branch = git_helper.current_branch();

  await run.phase(
    PhaseParams({
      name: "push",
      kind: "code",
      owner: "github",
      description: "Push the run branch through the integration — no token on this box",
    }),
    (ph) => {
      github_vm.push_branch(branch);
      ph.log({ pushed: branch });
    },
  );

  const pr = await run.phase(
    PhaseParams({
      name: "create_pr",
      kind: "code",
      owner: "github",
      description: "Open the draft PR the humans will review",
    }),
    (ph) => {
      const repo = github_vm.origin_repo();
      const base = cfg.remote.pr.base || github_vm.default_branch(repo);
      const title = ticket.ref
        ? `[${ticket.ref}] - ${ticket.title || prompt.split("\n")[0]}`
        : (prompt.split("\n")[0] ?? "SSSF run").slice(0, 90);
      // The documenter's write-up IS the PR description — it describes the
      // actual change. Fallback: the run's commit subjects.
      let description = "";
      if (existsSync("app_docs")) {
        const docs = readdirSync("app_docs")
          .filter((f) => f.endsWith(".md"))
          .map((f) => join("app_docs", f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (docs[0]) description = readFileSync(docs[0], "utf8").trim().slice(0, 20_000);
      }
      if (!description) {
        description = git_helper
          .log_subjects(`origin/${base}..${branch}`)
          .map((s) => `- ${s}`)
          .join("\n");
      }
      const body = [
        ticket.ref && ticket.url ? `Ticket: [${ticket.ref}](${ticket.url})\n` : "",
        description,
        "",
        "---",
        `🤖 Generated with SSSF sandbox dispatch — built, tested, and reviewed in ` +
          `\`${process.env.HOSTNAME ?? "vm"}\` (session \`${run.adw_id}\`)`,
      ]
        .filter((line, i) => line !== "" || i !== 0)
        .join("\n");
      const created = github_vm.create_pr({
        repo,
        head: branch,
        base,
        title,
        body,
        draft: cfg.remote.pr.draft,
        labels: cfg.remote.pr.labels,
        reviewers: cfg.remote.pr.reviewers,
      });
      const contract = { url: created.url, number: created.number, branch };
      writeFileSync(join(run.context_handoff_dir, "pr.json"), JSON.stringify(contract, null, 2));
      ph.log({ pr: created.url, base, draft: cfg.remote.pr.draft });
      return created;
    },
  );

  return run.finish(true, `PR ready: ${pr.url}`);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
      ticket: { type: "string", default: "" },
      "ticket-title": { type: "string", default: "" },
      "ticket-url": { type: "string", default: "" },
    },
    allowPositionals: true,
  });
  await session.cli(() =>
    main(
      utils.require_prompt(
        positionals,
        '"<prompt or path/to/prompt.md>" [--adw-id X] [--ticket ABC-123] [--ticket-title "..."] [--ticket-url URL]',
      ),
      values.config,
      values["adw-id"],
      { ref: values.ticket, title: values["ticket-title"], url: values["ticket-url"] },
    ),
  );
}
