/**
 * Ticket-tool drivers. ClickUp today; the exported surface is tool-agnostic so
 * Jira/Linear/GitHub can slot in later without touching an ADW.
 *
 * Facts this module is built on (measured 2026-08-13, recorded in
 * plans/sandbox-ticket-loop.md):
 *   - Custom task ids (PLFM-123) resolve ONLY with
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

function _team(): string {
  const team = (process.env.CLICKUP_TEAM_ID || "").trim();
  if (!team) throw new TicketError("CLICKUP_TEAM_ID missing from .env — custom task ids cannot resolve without it");
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
 * the id AS a custom id — so it must be sent only for PLFM-123-shaped refs;
 * a raw task id (869ehvc2h) resolves only WITHOUT it.
 */
function _query(id: string): string {
  return /^[A-Za-z]+-\d+$/.test(id) ? `custom_task_ids=true&team_id=${_team()}` : "";
}

/** Fail fast, before any phase runs. Called by ADWs that need a ticket tool. */
export function validate(cfg: SSSFConfig): void {
  if (cfg.project.tool === "none") {
    throw new TicketError("project.tool is 'none' — set `project: {tool: clickup}` in sssf.config.yaml");
  }
  _key();
  _team();
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function fetch_ticket(cfg: SSSFConfig, id: string): Promise<Ticket> {
  const task = await _api(`/task/${encodeURIComponent(id)}?${_query(id)}`);
  const comments = await _api(`/task/${encodeURIComponent(id)}/comment?${_query(id)}`);
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
  });
}

/** The list's real status names, in board order. Statuses are LIST-level. */
export async function list_statuses(_cfg: SSSFConfig, list_id: string): Promise<string[]> {
  const list = await _api(`/list/${list_id}`);
  return (list.statuses ?? []).map((s: any) => String(s.status));
}

// ── mutations (all honor SSSF_DRY_RUN=1) ─────────────────────────────────────

export async function comment(_cfg: SSSFConfig, id: string, body: string): Promise<void> {
  if (_dry_run()) {
    console.log(`[dry-run] ClickUp comment on ${id}: ${body.slice(0, 120)}`);
    return;
  }
  await _api(`/task/${encodeURIComponent(id)}/comment?${_query(id)}`, {
    method: "POST",
    body: JSON.stringify({ comment_text: body }),
  });
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
  const updated = await _api(`/task/${encodeURIComponent(id)}?${_query(id)}`, {
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
