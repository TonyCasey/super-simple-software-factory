#!/usr/bin/env bun
/**
 * ADW Ticket Ship — a ClickUp ticket in, a reviewed PR out, hands-free.
 *
 * Usage:
 *     bun adws/adw_ticket_ship.ts ABC-123 [--config ...] [--fresh] [--no-watch] [--dry-run]
 *     bun adws/adw_ticket_ship.ts ABC-123 --watch-only        # re-enter finalize later
 *
 * Phases: engineer(request) -> code(fetch_ticket) -> triager(triage)
 *         -> code(gate1: unclear? questions to the ticket, needs-info, STOP)
 *         -> code(start_ticket) -> [the whole sandbox dispatch chain]
 *         -> code(pr_readback) -> code(handoff) -> code(start_watch)
 *         -> code(finalize: poll until MERGED -> done + teardown)
 *
 * The division of labor is deliberate:
 *   - TRIAGE RUNS BEFORE THE VM EXISTS. An unclear ticket costs one cheap
 *     haiku call and a ClickUp comment, never a box.
 *   - The ticket is the prompt. Title, description, and clarification
 *     comments compose the working brief — nobody retypes requirements.
 *   - ClickUp is HOST-ONLY. The key never ships to the VM; every board
 *     mutation (states, comments) happens here.
 *   - The PR is created IN the VM (adw_sdlc_pr, via the write-enabled exe.dev
 *     integration); this ADW reads the URL back over ssh.
 *   - `finalize` holds the system's ONE auto-teardown: after the human merges,
 *     the merge IS the sign-off — ticket to done, final harvest, VM destroyed.
 *     A closed-unmerged PR leaves the VM up; that human is mid-decision.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import * as agents from "./adw_modules/agents.ts";
import type { Ticket } from "./adw_modules/data_types.ts";
import { AgentCall, ClarityOutput, PhaseParams } from "./adw_modules/data_types.ts";
import * as exe_dev from "./adw_modules/exe_dev.ts";
import * as gates from "./adw_modules/gates.ts";
import * as github_vm from "./adw_modules/github_vm.ts";
import * as sandbox_dispatch from "./adw_modules/sandbox_dispatch.ts";
import { APP_DIR } from "./adw_modules/sandbox_dispatch.ts";
import * as session from "./adw_modules/session.ts";
import * as tickets from "./adw_modules/tickets.ts";
import { new_id, UsageError } from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["triager"]; // the VM run validates its own roster
const FINALIZE_POLL_S = 300; // merged-detection cadence — humans review in hours
const FINALIZE_CEILING_S = 72 * 60 * 60; // then exit and say how to re-enter

/**
 * The ticket's live progress feed: ONE comment, created on the first note and
 * rewritten in place after that — anyone on the board can see where the run
 * is and where it stuck, without a notification per phase. Notes are queued
 * on a promise chain (ClickUp writes stay ordered); flush() before finishing.
 * Best-effort throughout: visibility must never break the run.
 */
function progress_mirror(cfg: ReturnType<typeof agents.load_config>, ticket_ref: string) {
  const enabled = cfg.project.tool !== "none" && cfg.project.progress_comments;
  const lines: string[] = [];
  let comment_id = "";
  let chain: Promise<void> = Promise.resolve();
  const push = async () => {
    const body = "[sssf] progress\n" + lines.join("\n");
    try {
      if (comment_id) await tickets.update_comment(cfg, comment_id, body);
      else comment_id = await tickets.comment(cfg, ticket_ref, body);
    } catch (error) {
      console.error(`(progress mirror: ${error})`);
    }
  };
  return {
    note(line: string): void {
      if (!enabled) return;
      lines.push(`${new Date().toISOString().slice(11, 16)}  ${line}`);
      chain = chain.then(push);
    },
    /** Re-attach to a prior run's comment (--watch-only) and keep its history. */
    adopt(id: string, prior_body: string): void {
      comment_id = id;
      const prior = prior_body.split("\n").slice(1).filter(Boolean); // drop the header
      lines.unshift(...prior);
    },
    id(): string {
      return comment_id;
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}
type ProgressMirror = ReturnType<typeof progress_mirror>;

/** The ticket IS the prompt: title + description + clarification comments. */
function compose_prompt(ticket: Ticket, attachment_files: string[] = []): string {
  const ref = ticket.custom_id || ticket.id;
  const lines = [`# ${ref}: ${ticket.title}`, "", ticket.description.trim()];
  if (ticket.comments.length) {
    lines.push("", "## Ticket comments (clarifications from the humans)", "");
    for (const c of ticket.comments) lines.push(`- ${c.author}: ${c.text}`);
  }
  if (attachment_files.length) {
    lines.push(
      "",
      "## Ticket attachments (files, already available in the sandbox)",
      "",
      "The following files from the ticket are at `~/ticket_attachments/` — use them",
      "directly; do NOT try to download anything:",
      "",
    );
    for (const f of attachment_files) lines.push(`- ~/ticket_attachments/${f.split("/").pop()}`);
  }
  return lines.join("\n");
}

export async function main(
  ticket_ref: string,
  config = "adws/adw_sssf_config/sssf.config.yaml",
  flags: { fresh?: boolean; no_watch?: boolean; watch_only?: boolean } = {},
): Promise<number> {
  const cfg = agents.load_config(config);
  tickets.validate(cfg);
  if (!cfg.remote.pr.enabled) {
    throw new UsageError(
      "remote.pr.enabled is false — ticket-ship delivers through a PR. Enable it in sssf.config.yaml " +
        "(and write-enable the repo's exe.dev GitHub integration).",
    );
  }
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, null);

  // ── re-entry lane: the laptop closed, the PR lived on ──────────────────────
  if (flags.watch_only) {
    const record = sandbox_dispatch.find_record(cfg, ticket_ref);
    if (!record.pr_number) {
      throw new UsageError(`sandbox ${record.vm_name} has no PR on record — run the full ship first`);
    }
    await run.phase(
      PhaseParams({
        name: "request",
        kind: "engineer",
        owner: run.engineer,
        description: "Re-enter finalize for a shipped ticket",
      }),
      (ph) => ph.log({ input: `[ship --watch-only ${ticket_ref}]`, pr: record.pr_url ?? "" }),
    );
    const mirror = progress_mirror(cfg, ticket_ref);
    if (record.progress_comment_id) {
      const prior = await tickets.comment_text(cfg, ticket_ref, record.progress_comment_id).catch(() => "");
      if (prior) mirror.adopt(record.progress_comment_id, prior);
    }
    mirror.note("watch re-entered — awaiting the human verdict on the PR");
    const state = await finalize(run, cfg, ticket_ref, record, mirror);
    await mirror.flush();
    if (!record.progress_comment_id && mirror.id()) {
      record.progress_comment_id = mirror.id();
      sandbox_dispatch.save_record(cfg, record);
    }
    return run.finish(state === "merged", state === "merged" ? "" : `PR ended '${state}'`);
  }

  await run.phase(
    PhaseParams({
      name: "request",
      kind: "engineer",
      owner: run.engineer,
      description: "Capture the ticket to ship",
    }),
    (ph) => ph.log({ input: `[ship ${ticket_ref}]`, fresh: Boolean(flags.fresh) }),
  );

  const { ticket, prompt, attachment_files } = await run.phase(
    PhaseParams({
      name: "fetch_ticket",
      kind: "code",
      owner: "tickets",
      description: "Fetch the ticket and compose the working brief from it",
    }),
    async (ph) => {
      const t = await tickets.fetch_ticket(cfg, ticket_ref);
      const ticket_json = join(run.context_handoff_dir, "ticket.json");
      writeFileSync(ticket_json, JSON.stringify(t, null, 2));
      const files = await tickets.download_attachments(cfg, t, join(run.context_handoff_dir, "attachments"));
      const p = compose_prompt(t, files);
      ph.log({
        ticket: `${t.custom_id || t.id}: ${t.title}`,
        status: t.status,
        comments: t.comments.length,
        attachments: files.length,
        brief_chars: p.length,
      });
      return { ticket: t, prompt: p, attachment_files: files };
    },
  );

  const triage = await run.phase(
    PhaseParams({
      name: "triage",
      kind: "agent",
      owner: "triager",
      retries: 1,
      description: "Implementable as written, or exactly what must be asked — BEFORE any VM exists",
    }),
    (ph) =>
      ph.call(
        AgentCall({
          output_type: ClarityOutput,
          prompt,
          gates: [gates.clarity_consistent, gates.artifacts_exist],
        }),
      ),
  );

  const mirror = progress_mirror(cfg, ticket_ref);
  mirror.note(
    triage.clear
      ? `triage: clear (${triage.classification}) — dispatching a sandbox`
      : `triage: ${triage.questions.length} questions — needs info`,
  );

  if (!triage.clear) {
    await run.phase(
      PhaseParams({
        name: "gate1",
        kind: "code",
        owner: "tickets",
        description: "Unclear: post the questions, mark needs-info, stop — never guess",
      }),
      async (ph) => {
        const body =
          `[sssf] This ticket needs answers before the factory can start (${triage.classification}):\n` +
          triage.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
          `\n\nAnswer here, then re-run: just ship ${ticket_ref}`;
        await tickets.comment(cfg, ticket_ref, body);
        const moved = await tickets.transition(cfg, ticket_ref, "needs_info");
        ph.log({ questions: triage.questions.length, status: moved.moved ? moved.to : moved.note });
      },
    );
    await mirror.flush();
    return run.finish(false, "needs-info — questions posted to the ticket");
  }

  await run.phase(
    PhaseParams({
      name: "start_ticket",
      kind: "code",
      owner: "tickets",
      description: "The board reflects reality: work is starting",
    }),
    async (ph) => {
      const moved = await tickets.transition(cfg, ticket_ref, "in_progress");
      ph.log({ status: moved.moved ? `${moved.from} -> ${moved.to}` : moved.note });
    },
  );

  // The whole vm -> provision -> clone -> ... -> harvest chain, in this trace.
  const ref = ticket.custom_id || ticket_ref;
  const outcome = await sandbox_dispatch.dispatch_into(run, {
    ticket: ref,
    prompt,
    adw: "sdlc_pr",
    config_path: config,
    fresh: flags.fresh,
    extra_args: ["--ticket", ref, "--ticket-title", ticket.title, "--ticket-url", ticket.url],
    on_progress: (line) => mirror.note(line),
    handoff_files: attachment_files,
  });
  if (!outcome.accepted) {
    mirror.note(`FAILED: ${outcome.reason}`);
    await mirror.flush();
    await tickets.mirror_failure(cfg, ticket_ref, "sandbox run", outcome.reason);
    return run.finish(false, outcome.reason);
  }
  let record = outcome.record;
  await mirror.flush(); // the comment now exists — remember it for --watch-only re-entry
  record.progress_comment_id = mirror.id() || record.progress_comment_id;
  sandbox_dispatch.save_record(cfg, record);

  record = await run.phase(
    PhaseParams({
      name: "pr_readback",
      kind: "code",
      owner: "sandbox",
      description: "Read the PR the VM created out of its handoff dir",
    }),
    (ph) => {
      const path = `adws/adw_data/sessions/${record.remote_adw_id}/context_handoff/pr.json`;
      const raw = exe_dev.sh(record.vm_name, `cat ${path}`, { cwd: APP_DIR });
      const pr = JSON.parse(raw) as { url: string; number: number };
      if (!pr.url || !pr.number) throw new Error(`pr.json is malformed: ${raw.slice(0, 200)}`);
      record.pr_url = pr.url;
      record.pr_number = pr.number;
      sandbox_dispatch.save_record(cfg, record);
      ph.log({ pr: pr.url });
      return record;
    },
  );

  await run.phase(
    PhaseParams({
      name: "handoff",
      kind: "code",
      owner: "tickets",
      description: "Ticket to review, with the PR and the VM on it — the flow goes human here",
    }),
    async (ph) => {
      const moved = await tickets.transition(cfg, ticket_ref, "in_review");
      await tickets.comment(
        cfg,
        ticket_ref,
        `[sssf] Ready for review.\nPR: ${record.pr_url}\nSandbox: ${record.https_url}\n` +
          `Commits are also local under refs/sandbox/ via the harvest.`,
      );
      ph.log({ status: moved.moved ? moved.to : moved.note, pr: record.pr_url ?? "" });
    },
  );
  mirror.note(`PR ready for review: ${record.pr_url}`);

  if (flags.no_watch) {
    await mirror.flush();
    return run.finish(true);
  }

  await run.phase(
    PhaseParams({
      name: "start_watch",
      kind: "code",
      owner: "sandbox",
      description: "Start the in-VM review watcher against the PR",
    }),
    (ph) => {
      const present =
        exe_dev.sh(record.vm_name, "test -f adws/adw_pr_watch.ts && echo yes || echo no", { cwd: APP_DIR }) === "yes";
      if (!present) {
        ph.log({ watcher: "adws/adw_pr_watch.ts not in the clone — skipping (review iteration is manual)" });
        return;
      }
      const watch_id = new_id(8);
      const cmd = `bun adws/adw_pr_watch.ts ${record.pr_number} --adw-id ${watch_id}`;
      record.watch_pid = exe_dev.sh_detached(record.vm_name, APP_DIR, cmd, "../sssf-watch.log");
      record.watch_adw_id = watch_id; // finalize mirrors this session's cycles to the ticket
      sandbox_dispatch.save_record(cfg, record);
      ph.log({ watch_pid: record.watch_pid, watch_adw_id: watch_id, log: "just sandbox-cmd — tail ../sssf-watch.log" });
      mirror.note("review watcher running in the sandbox — feedback on the PR is handled automatically");
    },
  );

  const state = await finalize(run, cfg, ticket_ref, record, mirror);
  await mirror.flush();
  return run.finish(state === "merged", state === "merged" ? "" : `PR ended '${state}'`);
}

/**
 * Poll (with the LAPTOP's gh) until the human merges or closes. On MERGED:
 * ticket -> done, final harvest, and the system's one auto-teardown. On
 * CLOSED-unmerged: say so and leave the VM — the human is mid-decision.
 */
async function finalize(
  run: any,
  cfg: ReturnType<typeof agents.load_config>,
  ticket_ref: string,
  record: sandbox_dispatch.SandboxRecord,
  mirror: ProgressMirror,
): Promise<string> {
  return run.phase(
    PhaseParams({
      name: "finalize",
      kind: "code",
      owner: "sandbox",
      description: "Await the human verdict: merged -> done + teardown; closed -> stand down",
    }),
    async (ph: any) => {
      const started = Date.now();
      let last_watch_phase = "";
      for (;;) {
        // Mirror the in-VM watcher's cycles while we wait — review iteration
        // is otherwise invisible from the board.
        if (record.watch_adw_id) {
          try {
            const ws = exe_dev.remote_session(record.vm_name, APP_DIR, cfg.observability.db, record.watch_adw_id);
            if (ws?.latest_phase && ws.latest_phase !== last_watch_phase) {
              last_watch_phase = ws.latest_phase;
              mirror.note(`pr-watch: ${ws.latest_phase} (${ws.phases} phases, ${ws.status})`);
            }
          } catch {
            // the VM may be mid-teardown or unreachable; the PR poll decides
          }
        }
        const pr = github_vm.pr_state(record.repo, record.pr_number!);
        if (pr.state === "MERGED") {
          mirror.note("PR merged — ticket to done, sandbox torn down");
          const moved = await tickets.transition(cfg, ticket_ref, "done");
          await tickets.comment(cfg, ticket_ref, `[sssf] PR merged: ${record.pr_url} — sandbox torn down.`);
          const harvested = sandbox_dispatch.harvest(cfg, record);
          exe_dev.rm(record.vm_name);
          ph.log({
            merged: record.pr_url ?? "",
            ticket: moved.moved ? moved.to : moved.note,
            final_harvest: harvested.commits ? harvested.ref : "NOCOMMITS",
            teardown: `${record.vm_name} destroyed — the merge was the sign-off`,
          });
          return "merged";
        }
        if (pr.state === "CLOSED") {
          mirror.note("PR closed without merging — sandbox left up");
          await tickets.comment(
            cfg,
            ticket_ref,
            `[sssf] PR closed without merging: ${record.pr_url}. Sandbox ${record.vm_name} left up.`,
          );
          ph.log({ closed: record.pr_url ?? "", vm: `${record.vm_name} left up — your call` });
          return "closed";
        }
        if ((Date.now() - started) / 1000 > FINALIZE_CEILING_S) {
          mirror.note(`no verdict after ${FINALIZE_CEILING_S / 3600}h — watch exited; re-enter with just ship-watch`);
          ph.log({
            still_open: record.pr_url ?? "",
            note: `no verdict after ${FINALIZE_CEILING_S / 3600}h — re-enter with: just ship-watch ${record.ticket}`,
          });
          return "open";
        }
        await Bun.sleep(FINALIZE_POLL_S * 1000);
      }
    },
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      fresh: { type: "boolean", default: false },
      "no-watch": { type: "boolean", default: false },
      "watch-only": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  await session.cli(() => {
    const [ticket_ref, ...extra] = positionals;
    if (!ticket_ref || extra.length) {
      throw new UsageError(
        "usage: bun adws/adw_ticket_ship.ts <TICKET> [--config PATH] [--fresh] [--no-watch] [--watch-only] [--dry-run]",
      );
    }
    if (values["dry-run"]) process.env.SSSF_DRY_RUN = "1";
    return main(ticket_ref, values.config, {
      fresh: values.fresh,
      no_watch: values["no-watch"],
      watch_only: values["watch-only"],
    });
  });
}
