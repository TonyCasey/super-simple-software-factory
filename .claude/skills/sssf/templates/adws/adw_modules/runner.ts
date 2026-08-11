/**
 * The Run object: config + adw_id + agent_map + tracer + console, bound once.
 *
 * `run.phase(PhaseParams(...), async (ph) => ...)` is the ONE phase primitive —
 * one wrapper for all three kinds (engineer, agent, code). Success must be
 * earned: every phase defaults to fail; only a clean return flips it (agent
 * phases additionally require a parsed envelope + green gates, enforced inside
 * ph.call).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as agents from "./agents.ts";
import { Console } from "./console.ts";
import type { AgentCall, Phase, PhaseParams, SSSFConfig } from "./data_types.ts";
import * as git_helper from "./git_helper.ts";
import type { Tracer } from "./tracer.ts";
import { ensure_dir, now_iso } from "./utils.ts";

export class PhaseHandle {
  constructor(
    readonly run: Run,
    readonly phase: Phase,
  ) {}

  log(payload: Record<string, unknown>): void {
    this.run.tracer.event({
      adw_id: this.run.adw_id,
      phase_id: this.phase.phase_id,
      type: "log",
      name: this.phase.params.name,
      payload,
    });
    this.run.console.note(
      Object.entries(payload)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    );
    if (this.phase.params.kind === "engineer" && "input" in payload) {
      this.run.tracer.session_request(this.run.adw_id, String(payload.input));
    }
  }

  call<T>(call: AgentCall<T>): Promise<T> {
    if (this.phase.params.kind !== "agent") {
      throw new Error("ph.call() is only valid inside an agent phase");
    }
    return agents.execute(this.run, this.phase, call);
  }
}

export class Run {
  readonly cfg: SSSFConfig;
  readonly adw_id: string;
  readonly tracer: Tracer;
  readonly console: Console;
  readonly engineer: string;
  readonly phases: Phase[] = [];
  tokens = 0;
  cost = 0;
  private _seq: number;
  readonly repo_root: string;
  readonly session_dir: string;
  readonly context_handoff_dir: string;
  private _agent_map_path: string;
  agent_map: Record<string, any>;

  constructor(cfg: SSSFConfig, adw_id: string, tracer: Tracer, engineer: string) {
    this.cfg = cfg;
    this.adw_id = adw_id;
    this.tracer = tracer;
    this.console = new Console(tracer, adw_id);
    this.engineer = engineer;
    this._seq = tracer.max_phase_seq(adw_id); // a joined run continues the sequence
    this.repo_root = git_helper.repo_root(); // where every agent is spawned to work
    this.session_dir = ensure_dir(join(cfg.defaults.data_dir, "sessions", adw_id));
    this.context_handoff_dir = ensure_dir(join(this.session_dir, "context_handoff"));
    this._agent_map_path = join(this.session_dir, "agent_map.json");
    this.agent_map = existsSync(this._agent_map_path)
      ? JSON.parse(readFileSync(this._agent_map_path, "utf8"))
      : {};
  }

  // ── agent map (adw_id -> per-agent coding-agent session ids) ──────────────
  save_agent_map(agent: string, entry: Record<string, unknown>): void {
    this.agent_map[agent] = entry;
    writeFileSync(this._agent_map_path, JSON.stringify(this.agent_map, null, 2));
  }

  // ── usage (run totals mirror what the tracer accumulates in sqlite) ───────
  add_usage(tokens: number, cost: number): void {
    this.tokens += tokens;
    this.cost += cost;
    this.tracer.session_add_usage(this.adw_id, tokens, cost);
  }

  // ── the phase primitive ───────────────────────────────────────────────────
  async phase<T>(params: PhaseParams, body: (ph: PhaseHandle) => Promise<T> | T): Promise<T> {
    this._seq += 1;
    const phase: Phase = {
      phase_id: `${this.adw_id}_${String(this._seq).padStart(2, "0")}_${params.name}`,
      adw_id: this.adw_id,
      seq: this._seq,
      params,
      status: "running",
      attempt: 0,
      error: null,
      started_at: now_iso(),
      ended_at: null,
    };
    this.phases.push(phase);
    this.tracer.phase_upsert(phase);
    this.tracer.event({
      adw_id: this.adw_id,
      phase_id: phase.phase_id,
      type: "phase_start",
      name: params.name,
      payload: { kind: params.kind, owner: params.owner, description: params.description },
    });
    this.console.phase_started(phase);
    const clock = performance.now();
    let value: T;
    try {
      value = await body(new PhaseHandle(this, phase));
    } catch (error) {
      phase.status = "fail"; // success must be earned
      phase.error = String(error instanceof Error ? error.message : error).slice(0, 1000);
      phase.ended_at = now_iso();
      this.tracer.event({
        adw_id: this.adw_id,
        phase_id: phase.phase_id,
        type: "error",
        name: params.name,
        payload: { error: phase.error },
      });
      this.tracer.event({
        adw_id: this.adw_id,
        phase_id: phase.phase_id,
        type: "phase_end",
        name: params.name,
        payload: { status: "fail" },
      });
      this.tracer.phase_upsert(phase);
      this.tracer.session_finish(this.adw_id, false);
      this.console.phase_ended(phase, (performance.now() - clock) / 1000);
      this.console.session_finished(false, this.tokens, this.cost, this.cfg.observability.db);
      throw error;
    }

    phase.status = "success";
    phase.ended_at = now_iso();
    this.tracer.event({
      adw_id: this.adw_id,
      phase_id: phase.phase_id,
      type: "phase_end",
      name: params.name,
      payload: { status: "success" },
    });
    this.tracer.phase_upsert(phase);
    this.console.phase_ended(phase, (performance.now() - clock) / 1000);
    return value;
  }

  // ── run outcome ───────────────────────────────────────────────────────────
  /**
   * Finalize the run and return its exit code. Call this exactly once.
   *
   * Two criteria, not one. Every phase must have passed, AND the ADW's own
   * acceptance test must hold. They are different questions on purpose: a
   * test phase that ran the suite did its job even when the suite came back
   * red, so the PHASE succeeds while the RUN must not.
   *
   * One call settles the db, the banner, and the exit code together, so the
   * three cannot disagree — a run whose suite never passed must not read green
   * in the trace and on the terminal while exiting 1.
   */
  finish(accepted = true, reason = ""): number {
    const phases_ok = this.phases.length > 0 && this.phases.every((p) => p.status === "success");
    const ok = phases_ok && accepted;
    if (phases_ok && !accepted) {
      const note = reason || "the run's acceptance criterion was not met";
      this.tracer.event({
        adw_id: this.adw_id,
        phase_id: this.phases.length ? this.phases[this.phases.length - 1]!.phase_id : "",
        type: "error",
        name: "not_accepted",
        payload: { reason: note },
      });
      this.console.note(`not accepted: ${note}`);
    }
    this.tracer.session_finish(this.adw_id, ok);
    this.console.session_finished(ok, this.tokens, this.cost, this.cfg.observability.db);
    return ok ? 0 : 1;
  }
}
