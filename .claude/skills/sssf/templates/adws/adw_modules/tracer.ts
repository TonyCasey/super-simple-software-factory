/**
 * Tracer: every event lands in JSONL and SQLite AS IT HAPPENS.
 *
 * Files are the raw record; sssf.db is the queryable mirror the UI polls.
 * No push transport — the flow is always: agents -> sqlite -> web ui.
 * WAL mode so the UI can read while ADW processes write.
 */

import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentConfig, EventRecord, GateReport, Phase } from "./data_types.ts";
import { ensure_dir, new_id, now_iso } from "./utils.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,                -- ADW script(s) run, e.g. "adw_plan + adw_build_test"
  request       TEXT,
  status        TEXT,
  engineer      TEXT,
  started_at    TEXT, ended_at TEXT,
  total_tokens  INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  archived      INTEGER DEFAULT 0   -- review triage, set by the UI; never by a run
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  parent_id     TEXT,
  type          TEXT,
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,
  checks_json   TEXT,               -- [{item, ok, note}] — WHAT the gate verified
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,                -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid was, so a recycled pid is not killed by mistake
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT REFERENCES sessions,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,
  session_id    TEXT,
  context_tokens INTEGER,           -- window occupancy after the agent's last turn
  context_window INTEGER,           -- the model's ceiling; 0/NULL = unknown
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
`;

// Columns added after a schema shipped. CREATE TABLE IF NOT EXISTS never
// revisits an existing table, so additive changes need an explicit ALTER.
const MIGRATIONS: [string, string, string][] = [
  ["agent_sessions", "color", "TEXT"],
  ["gate_results", "checks_json", "TEXT"],
  ["sessions", "adw_name", "TEXT"],
  ["agent_sessions", "context_tokens", "INTEGER"],
  ["agent_sessions", "context_window", "INTEGER"],
  ["sessions", "archived", "INTEGER DEFAULT 0"],
];

export class Tracer {
  readonly db_path: string;
  readonly events_jsonl: string;
  readonly conn: Database;

  constructor(db_path: string, events_jsonl: string) {
    ensure_dir(dirname(db_path));
    this.db_path = db_path;
    this.events_jsonl = events_jsonl;
    ensure_dir(dirname(events_jsonl));
    this.conn = new Database(this.db_path);
    this.conn.exec("PRAGMA journal_mode=WAL;");
    this.conn.exec("PRAGMA synchronous=NORMAL;");
    this.conn.exec("PRAGMA busy_timeout=5000;");
    this.conn.exec(SCHEMA);
    this._migrate();
  }

  /** Additive column migrations, so a db from an older SSSF still opens. */
  private _migrate(): void {
    for (const [table, column, decl] of MIGRATIONS) {
      const columns = new Set(
        this.conn.query(`PRAGMA table_info(${table})`).all().map((row: any) => row.name),
      );
      if (!columns.has(column)) {
        this.conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  event(record: EventRecord): string {
    const event_id = `evt_${new_id(12)}`;
    const ts = now_iso();
    const payload = record.payload ?? {};
    const line = {
      event_id,
      ts,
      adw_id: record.adw_id,
      phase_id: record.phase_id ?? "",
      type: record.type,
      name: record.name ?? "",
      payload,
      parent_id: record.parent_id ?? "",
      tokens: record.tokens ?? null,
      started_at: record.started_at ?? null,
      ended_at: record.ended_at ?? null,
    };
    appendFileSync(this.events_jsonl, JSON.stringify(line) + "\n");
    this.conn.run(
      "INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name," +
        " payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        event_id,
        record.adw_id,
        record.phase_id ?? "",
        record.parent_id ?? "",
        record.type,
        record.name ?? "",
        JSON.stringify(payload),
        record.tokens ?? null,
        record.started_at || ts,
        record.ended_at ?? null,
      ],
    );
    return event_id;
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  session_start(adw_id: string, engineer: string, adw_name?: string): void {
    this.conn.run(
      "INSERT INTO sessions (adw_id, status, engineer, started_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(adw_id) DO UPDATE SET status='running'",
      [adw_id, "running", engineer, now_iso()],
    );
    if (!adw_name) return;
    // A joined session chains ADWs — record each distinct one, in run order.
    const row = this.conn
      .query("SELECT adw_name FROM sessions WHERE adw_id=?")
      .get(adw_id) as { adw_name: string | null } | null;
    const names = row?.adw_name ? row.adw_name.split(" + ") : [];
    if (!names.includes(adw_name)) {
      names.push(adw_name);
      this.conn.run("UPDATE sessions SET adw_name=? WHERE adw_id=?", [names.join(" + "), adw_id]);
    }
  }

  session_request(adw_id: string, request: string): void {
    this.conn.run("UPDATE sessions SET request=? WHERE adw_id=?", [request.slice(0, 500), adw_id]);
  }

  session_finish(adw_id: string, ok: boolean): void {
    this.conn.run("UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?", [
      ok ? "success" : "fail",
      now_iso(),
      adw_id,
    ]);
    this.processes_end_all(adw_id); // nothing of this run is alive any more
  }

  session_add_usage(adw_id: string, tokens: number, cost: number): void {
    this.conn.run(
      "UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+? WHERE adw_id=?",
      [tokens, cost, adw_id],
    );
  }

  // ── processes (adw_id → pid, so a hung run can be found and killed) ────────
  /**
   * Record a live process for this run.
   *
   * A coding agent that hangs produces no events at all, which is exactly
   * when you need its pid — and `ps` cannot tell you which adw_id it
   * belongs to. Writing it here makes the trace the answer to "what is this
   * run running, and how do I stop it".
   */
  process_start(adw_id: string, kind: string, name: string, pid: number, command: string): void {
    this.conn.run(
      "INSERT INTO processes (adw_id, kind, name, pid, command, started_at) VALUES (?,?,?,?,?,?)",
      [adw_id, kind, name, pid, command.slice(0, 500), now_iso()],
    );
  }

  /** Mark the newest live row for this pid as finished. */
  process_end(adw_id: string, pid: number): void {
    this.conn.run(
      "UPDATE processes SET ended_at=? WHERE id = (" +
        "  SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL" +
        "  ORDER BY id DESC LIMIT 1)",
      [now_iso(), adw_id, pid],
    );
  }

  /** Close out every live row for a run — called when the session ends. */
  processes_end_all(adw_id: string): void {
    this.conn.run("UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL", [
      now_iso(),
      adw_id,
    ]);
  }

  // ── phases ────────────────────────────────────────────────────────────────
  /**
   * Highest seq already recorded for this session; 0 when it is new.
   *
   * A joined run continues the sequence instead of restarting at 1 — which
   * would collide with the first run's phases on both `seq` (breaking
   * ordering) and `phase_id` (silently overwriting a row through the
   * phase_upsert conflict clause).
   */
  max_phase_seq(adw_id: string): number {
    const row = this.conn
      .query("SELECT MAX(seq) AS seq FROM phases WHERE adw_id = ?")
      .get(adw_id) as { seq: number | null } | null;
    return row?.seq ?? 0;
  }

  phase_upsert(phase: Phase): void {
    const p = phase.params;
    this.conn.run(
      "INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description," +
        " status, attempt, retries, error, started_at, ended_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status," +
        " attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at",
      [
        phase.phase_id,
        phase.adw_id,
        phase.seq,
        p.name,
        p.kind,
        p.owner,
        p.description,
        phase.status,
        phase.attempt,
        p.retries,
        phase.error,
        phase.started_at,
        phase.ended_at,
      ],
    );
  }

  // ── envelopes / gates / agent sessions ────────────────────────────────────
  envelope_row(
    phase: Phase,
    agent: string,
    output_type: string,
    payload_json: string,
    valid: boolean,
    attempt: number,
  ): void {
    this.conn.run(
      "INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type," +
        " payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        `env_${new_id(12)}`,
        phase.adw_id,
        phase.phase_id,
        agent,
        output_type,
        payload_json,
        valid ? 1 : 0,
        attempt,
        now_iso(),
      ],
    );
  }

  /** The report carries both the verdict and the evidence behind it. */
  gate_row(phase: Phase, gate: string, report: GateReport, attempt: number): void {
    this.conn.run(
      "INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed," +
        " violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        phase.adw_id,
        phase.phase_id,
        attempt,
        gate,
        report.passed ? 1 : 0,
        JSON.stringify(report.violations),
        JSON.stringify(report.checks),
        now_iso(),
      ],
    );
  }

  /**
   * The agent's config row is the source of truth for its label and color.
   *
   * Context is carried here rather than derived from events because the lane
   * wants one number per agent — the latest — and a session that runs the
   * same agent twice overwrites it, exactly like model and session_id.
   */
  agent_session_row(
    adw_id: string,
    agent: AgentConfig,
    session_id: string,
    context_tokens = 0,
    context_window = 0,
  ): void {
    const ts = now_iso();
    this.conn.run(
      "INSERT INTO agent_sessions (adw_id, agent, coding_agent, model, color," +
        " session_id, context_tokens, context_window, created_at, last_used_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(adw_id, agent) DO UPDATE SET model=excluded.model," +
        " color=excluded.color, session_id=excluded.session_id," +
        " context_tokens=excluded.context_tokens," +
        " context_window=excluded.context_window," +
        " last_used_at=excluded.last_used_at",
      [
        adw_id,
        agent.name,
        agent.coding_agent,
        agent.model,
        agent.color,
        session_id,
        context_tokens,
        context_window,
        ts,
        ts,
      ],
    );
  }
}
