#!/usr/bin/env bun
/**
 * ADW PR Watch — the in-VM review-iteration daemon.
 *
 * Usage (normally launched detached by adw_ticket_ship's start_watch):
 *     bun adws/adw_pr_watch.ts <pr-number> [--adw-id X] [--config ...] [--once]
 *
 * One long-lived process, one session in the VM's trace. Cycles are numbered
 * code phases (poll_1, classify_1, ...); SLEEPS HAPPEN BETWEEN PHASES so the
 * trace shows instant polls, never phases that lie about their duration.
 *
 * Per cycle: poll the PR's unresolved review threads (minus the ones already
 * handled) → comment_triager classifies every one exactly once (fix / reply /
 * clarify) → the builder executes the fix items → the repo's own test gate —
 * red work is never pushed → ff-sync + push → inline replies to every item,
 * resolving ONLY what is fixed, green, and pushed → re-request the reviewers
 * whose findings were fixed, once per reviewer per session.
 *
 * Boundaries, deliberate:
 *   - Never merges, approves, or closes; never touches ClickUp (no key here —
 *     the board is the host's). The human's verdict ends this loop.
 *   - A diverged branch (a human pushed to the PR) means STAND DOWN: say so
 *     on the PR and exit — two writers on one branch is how work gets lost.
 *   - Tapered idle polling 2m→5m→15m→60m (reset on activity), 48h ceiling,
 *     and a stand-down file: `touch ~/pr-watch.stop` on the VM.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import type { CommentTriageOutput as TriageT } from "./adw_modules/data_types.ts";
import { AgentCall, BuildOutput, CommentTriageOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as gates from "./adw_modules/gates.ts";
import * as git_helper from "./adw_modules/git_helper.ts";
import * as github_vm from "./adw_modules/github_vm.ts";
import * as quality from "./adw_modules/quality.ts";
import * as session from "./adw_modules/session.ts";
import { UsageError } from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["comment_triager", "builder"];
const TAPER_S = [120, 300, 900, 3600]; // idle backoff; last entry repeats
const CEILING_S = 48 * 60 * 60;
const STOP_FILE = `${process.env.HOME ?? "."}/pr-watch.stop`;

interface WatchState {
  handled_threads: string[]; // resolved or replied-to — never re-triaged
  rerequested: string[]; // reviewers pinged this session — once each
}

export async function main(
  pr_number: number,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  adw_id?: string | null,
  once = false,
): Promise<number> {
  const cfg = agents.load_config(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adw_id);
  const repo = github_vm.origin_repo();
  const branch = git_helper.current_branch();

  const state_path = join(run.session_dir, "pr_watch_state.json");
  const state: WatchState = existsSync(state_path)
    ? (JSON.parse(readFileSync(state_path, "utf8")) as WatchState)
    : { handled_threads: [], rerequested: [] };
  const save_state = () => writeFileSync(state_path, JSON.stringify(state, null, 2));

  const pr_author = JSON.parse(
    Bun.spawnSync(["gh", "pr", "view", String(pr_number), "-R", repo, "--json", "author"], {
      env: process.env as Record<string, string>,
    }).stdout.toString() || '{"author":{"login":""}}',
  ).author?.login as string;

  await run.phase(
    PhaseParams({
      name: "request",
      kind: "engineer",
      owner: run.engineer,
      description: "Watch a PR and iterate on review feedback until the humans decide",
    }),
    (ph) =>
      ph.log({
        input: `[pr-watch ${repo}#${pr_number} on ${branch}]`,
        taper: TAPER_S.join("/") + "s",
        ceiling_h: CEILING_S / 3600,
        resumed_handled: state.handled_threads.length,
      }),
  );

  const started = Date.now();
  let taper_index = 0;
  for (let cycle = 1; ; cycle++) {
    if (existsSync(STOP_FILE)) {
      return run.finish(true, "stood down by operator stop-file");
    }
    if ((Date.now() - started) / 1000 > CEILING_S) {
      github_vm.comment_issue(repo, pr_number, "[sssf pr-watch] 48h ceiling reached — watcher exiting. Re-start with `just ship-watch` or a fresh dispatch.");
      return run.finish(false, "watch ceiling reached with the PR still open");
    }

    const poll = await run.phase(
      PhaseParams({
        name: `poll_${cycle}`,
        kind: "code",
        owner: "github",
        description: "PR state + unresolved threads not yet handled",
      }),
      (ph) => {
        const pr = github_vm.pr_state(repo, pr_number);
        const threads = pr.state === "OPEN"
          ? github_vm.unresolved_threads(repo, pr_number).filter((t) => !state.handled_threads.includes(t.thread_id))
          : [];
        writeFileSync(join(run.context_handoff_dir, "pr_threads.json"), JSON.stringify(threads, null, 2));
        ph.log({ pr_state: pr.state, review_decision: pr.review_decision || "-", new_threads: threads.length });
        return { pr, threads };
      },
    );

    if (poll.pr.state !== "OPEN") {
      return run.finish(true, `PR is ${poll.pr.state} — the humans decided; watcher done`);
    }
    if (poll.threads.length === 0) {
      if (once) return run.finish(true, "single cycle (--once), nothing to handle");
      await Bun.sleep(TAPER_S[Math.min(taper_index++, TAPER_S.length - 1)]! * 1000);
      continue;
    }
    taper_index = 0; // activity resets the backoff

    const triage = await run.phase(
      PhaseParams({
        name: `classify_${cycle}`,
        kind: "agent",
        owner: "comment_triager",
        retries: 1,
        description: "Every unresolved thread becomes exactly one action",
      }),
      (ph) =>
        ph.call(
          AgentCall({
            output_type: CommentTriageOutput,
            prompt:
              `PR #${pr_number} on ${repo}, branch ${branch}. Classify the unresolved review threads ` +
              `in <context_handoff_dir>/pr_threads.json.`,
            gates: [gates.triage_covers(poll.threads.map((t) => t.thread_id))],
          }),
        ),
    );

    // Marry classifications back to thread metadata (comment ids for replies).
    const by_thread = new Map(poll.threads.map((t) => [t.thread_id, t]));
    const items = (triage as TriageT).items.map((item) => ({
      ...item,
      comment_id: by_thread.get(item.thread_id)?.comment_id ?? item.comment_id,
      author: by_thread.get(item.thread_id)?.author ?? "unknown",
    }));
    const fixes = items.filter((i) => i.kind === "fix");

    let fixes_green = false;
    if (fixes.length > 0) {
      await run.phase(
        PhaseParams({
          name: `respond_${cycle}`,
          kind: "agent",
          owner: "builder",
          retries: 1,
          description: "Execute the fix items exactly; nothing beyond them",
        }),
        (ph) =>
          ph.call(
            AgentCall({
              output_type: BuildOutput,
              prompt:
                "Apply exactly these review fixes — no unrelated changes:\n" +
                fixes.map((f, i) => `${i + 1}. [${f.thread_id}] ${f.fix_instruction}`).join("\n"),
              gates: [gates.diff_matches_claims],
            }),
          ),
      );

      let check = await run.phase(
        PhaseParams({
          name: `check_${cycle}`,
          kind: "code",
          owner: "quality",
          description: "The repo's own gate — red fixes are never pushed",
        }),
        async (ph) => {
          const result = await quality.run_tests(run);
          ph.log({ passed: result.passed });
          return result;
        },
      );

      if (!check.passed) {
        // One bounded repair, exactly like the SDLC's fix loop: the suite's
        // verbatim output goes back to the builder, then one retest.
        await run.phase(
          PhaseParams({
            name: `repair_${cycle}`,
            kind: "agent",
            owner: "builder",
            retries: 1,
            description: "One bounded repair from the suite's verbatim output",
          }),
          (ph) =>
            ph.call(
              AgentCall({
                output_type: BuildOutput,
                prompt: "Repair the code so the suite passes — never weaken the assertions.",
                previous: quality.as_envelope(check, "tests"),
                gates: [gates.diff_matches_claims],
              }),
            ),
        );
        check = await run.phase(
          PhaseParams({
            name: `recheck_${cycle}`,
            kind: "code",
            owner: "quality",
            description: "The repaired fix gets exactly one retest",
          }),
          async (ph) => {
            const result = await quality.run_tests(run);
            ph.log({ passed: result.passed });
            return result;
          },
        );
      }
      fixes_green = check.passed;

      if (fixes_green) {
        const shipped = await run.phase(
          PhaseParams({
            name: `ship_${cycle}`,
            kind: "code",
            owner: "git",
            description: "ff-sync (a diverged branch means stand down), commit, push",
          }),
          (ph) => {
            if (!github_vm.ff_sync(branch)) {
              ph.log({ diverged: "a human pushed to this branch — standing down" });
              return false;
            }
            const sha = git_helper.commit_all(
              `Address review feedback (${fixes.length} item${fixes.length === 1 ? "" : "s"})`,
            );
            github_vm.push_branch(branch);
            ph.log({ pushed: sha });
            return true;
          },
        );
        if (!shipped) {
          github_vm.comment_issue(
            repo,
            pr_number,
            "[sssf pr-watch] This branch received pushes from outside the sandbox — the watcher is standing down so two writers don't fight. Re-dispatch when ready.",
          );
          return run.finish(true, "stood down: branch diverged (human pushes)");
        }
      }
    }

    await run.phase(
      PhaseParams({
        name: `reply_${cycle}`,
        kind: "code",
        owner: "github",
        description: "Answer every thread; resolve only what is fixed, green, and pushed",
      }),
      (ph) => {
        let resolved = 0;
        for (const item of items) {
          const fixed_and_shipped = item.kind === "fix" && fixes_green;
          const text =
            item.kind === "fix" && !fixes_green
              ? `${item.reply}\n\n(The fix did not pass the test suite safely — leaving this unresolved for a human look.)`
              : item.reply;
          const signature = cfg.remote.pr.signature.trim();
          github_vm.reply(repo, pr_number, item.comment_id, signature ? `${text}\n\n${signature}` : text);
          if (fixed_and_shipped) {
            github_vm.resolve_thread(item.thread_id);
            resolved += 1;
          }
          state.handled_threads.push(item.thread_id);
        }
        save_state();
        ph.log({ replied: items.length, resolved });
      },
    );

    await run.phase(
      PhaseParams({
        name: `rerequest_${cycle}`,
        kind: "code",
        owner: "github",
        description: "Ping the reviewers whose findings were fixed — once each per session",
      }),
      (ph) => {
        const reviewers = [
          ...new Set(
            items
              .filter((i) => i.kind === "fix" && fixes_green)
              .map((i) => i.author)
              // Copilot is a bot we DO re-request (request_review normalizes
              // it); other bots and the PR author are skipped.
              .filter(
                (a) =>
                  a &&
                  a !== pr_author &&
                  (github_vm.is_copilot(a) || !a.endsWith("[bot]")) &&
                  !state.rerequested.includes(a),
              ),
          ),
        ];
        if (reviewers.length) {
          github_vm.request_review(repo, pr_number, reviewers);
          state.rerequested.push(...reviewers);
          save_state();
        }
        ph.log({ rerequested: reviewers.join(", ") || "(none — authors were the PR author, bots, or already pinged)" });
      },
    );

    if (once) return run.finish(true, "single cycle (--once) complete");
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      "adw-id": { type: "string" },
      once: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  await session.cli(() => {
    const number = Number(positionals[0] ?? 0);
    if (!number || positionals.length !== 1) {
      throw new UsageError("usage: bun adws/adw_pr_watch.ts <pr-number> [--adw-id X] [--config PATH] [--once]");
    }
    return main(number, values.config, values["adw-id"], values.once);
  });
}
