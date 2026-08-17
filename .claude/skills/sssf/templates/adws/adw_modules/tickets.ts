/**
 * Ticket-tool drivers. ClickUp today; the exported surface is tool-agnostic so
 * Jira/Linear/GitHub can slot in later without touching an ADW.
 *
 * Facts this module is built on (measured 2026-08-13, recorded in
 * plans/sandbox-ticket-loop.md):
 *   - Custom task ids (ABC-123) resolve ONLY with
 *     `?custom_task_ids=true&team_id=<id>` on every task call.
 *   - Status ladders are LIST-level, not space-level — the real names must be
 *     fetched from the ticket's list at runtime, never assumed from config.
 *   - Auth is the raw personal token in the Authorization header (no Bearer).
 *
 * Policy: reads are free; every MUTATION honors SSSF_DRY_RUN=1 (log intent,
 * write nothing) so a rehearsal never touches a real board. A missing mapped
 * status degrades to a ticket comment instead of a transition — a factory that
 * cannot move a ticket must still tell the humans watching it why.
 */

import type { ProjectConfig, SSSFConfig, Ticket } from "./data_types.ts";
import { TicketSchema } from "./data_types.ts";

const API = "https://api.clickup.com/api/v2";

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketError";
  }
}

function _key(): string {
  const key = (process.env.CLICKUP_API_KEY || "").trim();
  if (!key) throw new TicketError("CLICKUP_API_KEY missing from .env — the project tool is clickup");
  return key;
}

function _team(cfg: SSSFConfig): string {
  // Settings live in sssf.config.yaml; .env carries only secrets. The env var
  // survives as a fallback for configs written before project.team_id existed.
  const team = (cfg.project.team_id || process.env.CLICKUP_TEAM_ID || "").trim();
  if (!team) throw new TicketError("project.team_id missing from sssf.config.yaml — custom task ids cannot resolve without it");
  return team;
}

function _dry_run(): boolean {
  return (process.env.SSSF_DRY_RUN || "").trim() === "1";
}

async function _api(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: _key(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new TicketError(
      `ClickUp ${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

/**
 * The task-call query string. With `custom_task_ids=true` ClickUp interprets
 * the id AS a custom id — so it must be sent only for ABC-123-shaped refs;
 * a raw task id (869ehvc2h) resolves only WITHOUT it.
 */
function _query(cfg: SSSFConfig, id: string): string {
  return /^[A-Za-z]+-\d+$/.test(id) ? `custom_task_ids=true&team_id=${_team(cfg)}` : "";
}

/** Fail fast, before any phase runs. Called by ADWs that need a ticket tool. */
export function validate(cfg: SSSFConfig): void {
  if (cfg.project.tool === "none") {
    throw new TicketError("project.tool is 'none' — set `project: {tool: clickup}` in sssf.config.yaml");
  }
  _key();
  _team(cfg);
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function fetch_ticket(cfg: SSSFConfig, id: string): Promise<Ticket> {
  const q = _query(cfg, id);
  const task = await _api(`/task/${encodeURIComponent(id)}?${q ? `${q}&` : ""}include_attachments=true`);
  const comments = await _api(`/task/${encodeURIComponent(id)}/comment?${q}`);
  return TicketSchema.parse({
    tool: cfg.project.tool,
    id: task.id,
    custom_id: task.custom_id ?? "",
    url: task.url ?? "",
    title: task.name ?? "",
    description: task.description ?? "",
    status: task.status?.status ?? "",
    list_id: task.list?.id ?? "",
    comments: (comments.comments ?? []).map((c: any) => ({
      author: c.user?.username ?? "unknown",
      text: c.comment_text ?? "",
    })),
    attachments: (task.attachments ?? []).map((a: any) => ({
      title: a.title ?? "attachment",
      url: a.url ?? "",
    })),
  });
}

/**
 * Download the ticket's attachments into `dir`; returns the written paths.
 * Host-side only — the sandbox never holds the ticket-tool credential.
 */
export async function download_attachments(_cfg: SSSFConfig, ticket: Ticket, dir: string): Promise<string[]> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const paths: string[] = [];
  if (!ticket.attachments.length) return paths;
  mkdirSync(dir, { recursive: true });
  for (const att of ticket.attachments) {
    if (!att.url) continue;
    const response = await fetch(att.url, { headers: { Authorization: _key() } });
    if (!response.ok) throw new TicketError(`attachment '${att.title}' -> HTTP ${response.status}`);
    const file = join(dir, att.title.replace(/[^\w.\-]/g, "_"));
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    paths.push(file);
  }
  return paths;
}

/** The list's real status names, in board order. Statuses are LIST-level. */
export async function list_statuses(_cfg: SSSFConfig, list_id: string): Promise<string[]> {
  const list = await _api(`/list/${list_id}`);
  return (list.statuses ?? []).map((s: any) => String(s.status));
}

// ── mutations (all honor SSSF_DRY_RUN=1) ─────────────────────────────────────

/** Returns the new comment's id ("" on dry-run) so callers can edit it later. */
export async function comment(cfg: SSSFConfig, id: string, body: string): Promise<string> {
  if (_dry_run()) {
    console.log(`[dry-run] ClickUp comment on ${id}: ${body.slice(0, 120)}`);
    return "";
  }
  const created = await _api(`/task/${encodeURIComponent(id)}/comment?${_query(cfg, id)}`, {
    method: "POST",
    body: JSON.stringify({ comment_text: body }),
  });
  return String(created.id ?? "");
}

/** Rewrite an existing comment in place — how the progress mirror stays ONE comment. */
export async function update_comment(_cfg: SSSFConfig, comment_id: string, body: string): Promise<void> {
  if (_dry_run()) {
    console.log(`[dry-run] ClickUp update comment ${comment_id}: ${body.slice(0, 120)}`);
    return;
  }
  await _api(`/comment/${encodeURIComponent(comment_id)}`, {
    method: "PUT",
    body: JSON.stringify({ comment_text: body }),
  });
}

/** A single comment's current text ("" if it no longer exists). */
export async function comment_text(cfg: SSSFConfig, task_id: string, comment_id: string): Promise<string> {
  const res = await _api(`/task/${encodeURIComponent(task_id)}/comment?${_query(cfg, task_id)}`);
  const hit = (res.comments ?? []).find((c: any) => String(c.id) === comment_id);
  return hit?.comment_text ?? "";
}

export interface TransitionResult {
  moved: boolean;
  from: string;
  to: string; // the real status name used, or "" when degraded to a comment
  note: string;
}

/**
 * Move the ticket along the generic ladder (todo | in_progress | in_review |
 * done | needs_info). The configured name is matched case-insensitively
 * against the ticket's LIST statuses; no match -> comment-only degradation.
 */
export async function transition(
  cfg: SSSFConfig,
  id: string,
  generic: keyof ProjectConfig["statuses"],
): Promise<TransitionResult> {
  const ticket = await fetch_ticket(cfg, id);
  const wanted = (cfg.project.statuses[generic] || "").trim();
  if (!wanted) {
    const note = `no '${generic}' status configured — leaving '${ticket.status}', commenting instead`;
    await comment(cfg, id, `[sssf] ${note}`);
    return { moved: false, from: ticket.status, to: "", note };
  }
  const real = await list_statuses(cfg, ticket.list_id);
  const match = real.find((s) => s.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const note =
      `status '${wanted}' does not exist on list ${ticket.list_id} ` +
      `(has: ${real.join(", ")}) — leaving '${ticket.status}', commenting instead`;
    await comment(cfg, id, `[sssf] ${note}`);
    return { moved: false, from: ticket.status, to: "", note };
  }
  if (_dry_run()) {
    console.log(`[dry-run] ClickUp transition ${id}: '${ticket.status}' -> '${match}'`);
    return { moved: true, from: ticket.status, to: match, note: "dry-run" };
  }
  const updated = await _api(`/task/${encodeURIComponent(id)}?${_query(cfg, id)}`, {
    method: "PUT",
    body: JSON.stringify({ status: match }),
  });
  const landed = updated.status?.status ?? "";
  if (landed.toLowerCase() !== match.toLowerCase()) {
    throw new TicketError(`transition to '${match}' did not stick — ticket reads '${landed}'`);
  }
  return { moved: true, from: ticket.status, to: landed, note: "" };
}

/** Every ADW stop mirrors to the ticket — the board must never lie by silence. */
export async function mirror_failure(
  cfg: SSSFConfig,
  id: string,
  stage: string,
  detail: string,
): Promise<void> {
  try {
    await comment(cfg, id, `[sssf] ${stage} failed: ${detail.slice(0, 800)}`);
  } catch (error) {
    // The mirror is best-effort: a ClickUp hiccup must not mask the real failure.
    console.error(`(ticket mirror failed: ${error})`);
  }
}
