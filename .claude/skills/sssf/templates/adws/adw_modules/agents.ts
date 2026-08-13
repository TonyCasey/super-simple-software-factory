/**
 * Config loading/validation and agent execution.
 *
 * Every ADW validates its agents before running (fail fast, nothing spawns
 * against a half-valid config). Every agent call parses against a concrete
 * output type; parse failures and gate violations re-prompt the SAME session
 * with a correction — context intact, bounded retries. Agent proposes, code
 * disposes.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolve_path } from "node:path";
import { z } from "zod";

import * as agent_cc from "./agent_cc.ts";
import * as agent_codex from "./agent_codex.ts";
import * as agent_pi from "./agent_pi.ts";
import type {
  AgentCall,
  AgentConfig,
  AgentRequest,
  AgentResult,
  CodingAgent,
  EnvelopeBase,
  Phase,
  SSSFConfig,
} from "./data_types.ts";
import { GateReport, SSSFConfigSchema, UsageBreakdown } from "./data_types.ts";
import * as permissions from "./permissions.ts";
import * as prompts from "./prompts.ts";
import { ensure_dir, new_id } from "./utils.ts";

const JSON_FIX_ATTEMPTS = 2; // continue-with-correction attempts for malformed JSON

/**
 * The one place `coding_agent` becomes a decision. Both adapters export the
 * same four symbols, so everything downstream — the runner, gates, the tracer,
 * the visualizer — never learns which one ran.
 */
const RUNNERS: Record<AgentConfig["coding_agent"], CodingAgent> = {
  pi: agent_pi,
  claude_code: agent_cc,
  codex: agent_codex,
};

/** Where each interface keeps its per-agent session state, under the agent dir. */
const SESSION_DIRS: Record<AgentConfig["coding_agent"], string> = {
  pi: "pi_sessions", // pi's sessions themselves
  claude_code: "cc_sessions", // id markers + the rendered system prompt
  codex: "codex_sessions", // thread-id markers
};

export class GateFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateFailure";
  }
}

/** A required agent is missing or unusable — the run must not start. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── config ───────────────────────────────────────────────────────────────────

export function load_config(path = "adws/adw_sssf_config/sssf.config.yaml"): SSSFConfig {
  const raw = (Bun.YAML.parse(readFileSync(path, "utf8")) ?? {}) as Record<string, any>;
  const defaults = raw.defaults ?? {};
  for (const agent of raw.agents ?? []) {
    for (const key of ["coding_agent", "model", "thinking", "color", "tools", "writes"]) {
      if (key in defaults && !(key in agent)) agent[key] = defaults[key];
    }
    if (!("harness_engineering" in agent)) {
      agent.harness_engineering = defaults.harness_engineering ?? [];
    }
  }
  return SSSFConfigSchema.parse(raw);
}

export function resolve(cfg: SSSFConfig, name: string): AgentConfig {
  for (const agent of cfg.agents) {
    if (agent.name === name) return agent;
  }
  throw new ConfigError(
    `agent ${JSON.stringify(name)} is not defined in the config — ` +
      `available: ${JSON.stringify(cfg.agents.map((a) => a.name))}`,
  );
}

/** Fail fast: every required name must resolve to a usable agent. */
export function validate(cfg: SSSFConfig, required: string[]): void {
  const problems: string[] = [];
  let needs_claude_auth = false;
  let needs_codex_auth = false;
  for (const name of required) {
    let agent: AgentConfig;
    try {
      agent = resolve(cfg, name);
    } catch (error) {
      problems.push(String(error instanceof Error ? error.message : error));
      continue;
    }
    if (agent.coding_agent === "claude_code") {
      needs_claude_auth = true;
      // Both of these validate green and then fail at RUN time, which is the
      // worst place to learn about them: harness_engineering entries are pi
      // extension files that Claude Code has no way to load (the starter
      // planner and scout carry them), and a tool name outside the mapping
      // table would silently vanish from the allowlist the agent runs with.
      if (agent.harness_engineering.length) {
        problems.push(
          `agent ${JSON.stringify(name)}: harness_engineering is pi-only — ` +
            `${JSON.stringify(agent.harness_engineering)} cannot load into claude_code`,
        );
      }
      const unsupported = agent_cc.unsupported_tools(agent.tools);
      if (unsupported.length) {
        problems.push(
          `agent ${JSON.stringify(name)}: tools ${JSON.stringify(unsupported)} have no ` +
            "claude_code equivalent — use read, bash, edit, write, grep, find, ls",
        );
      }
    }
    if (agent.coding_agent === "codex") {
      needs_codex_auth = true;
      // Same trap as claude_code: pi extensions cannot load, and an agent whose
      // prompt assumes tools its harness never registered flails at run time.
      if (agent.harness_engineering.length) {
        problems.push(
          `agent ${JSON.stringify(name)}: harness_engineering is pi-only — ` +
            `${JSON.stringify(agent.harness_engineering)} cannot load into codex`,
        );
      }
    }
    for (const [label, ref] of [
      ["system", agent.prompt_engineering.system],
      ["user", agent.prompt_engineering.user],
    ] as const) {
      if (!existsSync(ref) || !statSync(ref).isFile()) {
        problems.push(`agent ${JSON.stringify(name)}: ${label} prompt not found: ${ref}`);
      }
    }
    try {
      RUNNERS[agent.coding_agent].resolve_model(agent.model);
    } catch (error) {
      problems.push(
        `agent ${JSON.stringify(name)}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  // Roster-wide, and asked once however many claude_code agents there are: a
  // container where the secret never got injected otherwise validates clean and
  // dies at the first agent, halfway into a chain.
  if (needs_claude_auth) {
    const reason = agent_cc.unauthenticated_reason();
    if (reason) problems.push(`claude_code agents: ${reason}`);
  }
  if (needs_codex_auth) {
    const reason = agent_codex.unauthenticated_reason();
    if (reason) problems.push(`codex agents: ${reason}`);
  }
  if (problems.length) {
    throw new ConfigError("config validation failed:\n- " + problems.join("\n- "));
  }
}

// ── execution ────────────────────────────────────────────────────────────────

/** One agent call: render prompts -> agent run -> typed parse -> gates -> envelope. */
export async function execute<T>(run: any, phase: Phase, call: AgentCall<T>): Promise<T> {
  const agent = resolve(run.cfg, phase.params.owner);
  const agent_dir = ensure_dir(join(run.session_dir, agent.name));
  const runner = RUNNERS[agent.coding_agent];

  const variables = {
    prompt: call.prompt,
    previous_envelope: call.previous ? JSON.stringify(call.previous, null, 2) : "(none)",
    context_handoff_dir: run.context_handoff_dir,
  };
  const system_text = prompts.render(agent.prompt_engineering.system, variables);
  const user_text = prompts.render(agent.prompt_engineering.user, variables);
  prompts.save(join(agent_dir, "prompts"), "system.md", system_text);
  prompts.save(join(agent_dir, "prompts"), "user.md", user_text);

  const session_id = _agent_session_id(run, agent);
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "agent_start",
    name: agent.name,
    payload: {
      model: agent.model,
      thinking: agent.thinking,
      color: agent.color,
      session_id,
      coding_agent: agent.coding_agent,
      purpose: agent.purpose,
      tools: agent.tools, // null = all tools
      harness_engineering: agent.harness_engineering,
    },
  });
  run.console.agent_started(agent.name, agent.model, session_id);

  // Parse retries and gate corrections re-enter the SAME agent session, so the
  // last send is the one whose context occupancy is current — while spend is
  // the opposite: every send costs, so usage accumulates across all of them.
  let latest: AgentResult | null = null;
  const spent = new UsageBreakdown();

  const send = async (prompt_text: string): Promise<AgentResult> => {
    const request: AgentRequest = {
      prompt: prompt_text,
      system_prompt: system_text,
      model: agent.model,
      thinking: agent.thinking,
      session_id,
      // absolute: these are read by the agent subprocess, which runs in repo_root
      session_dir: resolve_path(join(agent_dir, SESSION_DIRS[agent.coding_agent])),
      raw_output_path: resolve_path(join(agent_dir, "raw_output.jsonl")),
      tools: agent.tools,
      extensions: agent.harness_engineering,
      cwd: run.repo_root,
    };
    const result = await runner.run(
      request,
      _event_forwarder(run, phase, agent.name, runner),
      (pid: number) =>
        run.tracer.process_start(
          run.adw_id,
          "agent",
          agent.name,
          pid,
          `${agent.coding_agent} ${agent.name} ${agent.model}`,
        ),
      (pid: number) => run.tracer.process_end(run.adw_id, pid),
    );
    run.add_usage(result.tokens, result.cost);
    spent.merge(result.usage);
    latest = result;
    return result;
  };

  // What the tree looked like before this agent got its hands on it. Every
  // send in this phase — first prompt, JSON retries, gate corrections — is
  // measured against this one baseline.
  const tree_before = permissions.snapshot(run);

  let result = await send(user_text);
  let parsed = await _parse_with_retries(run, phase, call, result, send);
  let envelope = parsed.envelope;
  let attempt = parsed.attempt;

  // claim gates — violations flow back into the SAME session as corrections
  for (
    let gate_attempt = 1;
    gate_attempt <= Math.max(1, phase.params.retries + 1);
    gate_attempt++
  ) {
    const violations: string[] = [];
    for (const gate of call.gates) {
      const report = _as_report(await gate(envelope, run));
      const found = report.violations;
      run.tracer.gate_row(phase, gate.name, report, gate_attempt);
      run.tracer.event({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: found.length ? "gate_fail" : "gate_pass",
        name: gate.name,
        payload: { attempt: gate_attempt, violations: found, checks: report.checks },
      });
      run.console.gate_result(gate.name, report);
      violations.push(...found);
    }
    if (!violations.length) break;
    if (gate_attempt > phase.params.retries) {
      throw new GateFailure(
        `${agent.name} failed gates after ${gate_attempt} attempt(s):\n- ` + violations.join("\n- "),
      );
    }
    phase.attempt = gate_attempt;
    run.console.retry(
      agent.name,
      gate_attempt,
      phase.params.retries,
      `${violations.length} gate violation(s)`,
    );
    const correction =
      "Your previous response failed validation:\n- " +
      violations.join("\n- ") +
      "\n\nFix these problems, then re-emit ONLY your Report JSON.";
    result = await send(correction);
    parsed = await _parse_with_retries(run, phase, call, result, send);
    envelope = parsed.envelope;
    attempt = parsed.attempt;
  }

  // Permission is checked after every send is done, and before the envelope is
  // accepted: an agent does not get to report success on a phase in which it
  // wrote somewhere it was not allowed to.
  let touched: string[];
  try {
    touched = permissions.enforce(run, phase, agent, tree_before);
  } catch (breach) {
    if (breach instanceof permissions.PermissionBreach) {
      run.tracer.event({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: "error",
        name: "permission_breach",
        payload: {
          agent: agent.name,
          error: breach.message,
          writes: agent.writes,
          protected_files: run.cfg.defaults.protected_files,
        },
      });
    }
    throw breach;
  }
  if (touched.length) {
    run.tracer.event({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "log",
      name: "paths_touched",
      payload: { agent: agent.name, paths: touched },
    });
  }

  _persist_envelope(run, phase, agent.name, call, envelope, attempt, true);
  run.console.envelope_summary(envelope, call.output_type.name);
  const context = (latest ?? result) as AgentResult;
  run.tracer.agent_session_row(
    run.adw_id,
    agent,
    session_id,
    context.context_tokens,
    context.context_window,
  );
  run.save_agent_map(agent.name, {
    session_id,
    model: agent.model,
    coding_agent: agent.coding_agent,
  });
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "handoff",
    name: agent.name,
    payload: { artifacts: envelope.artifacts, summary: envelope.summary },
  });
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "agent_end",
    name: agent.name,
    // Phase totals, not the last send's: a retried phase paid for every attempt.
    tokens: spent.total_tokens,
    payload: {
      cost: spent.total_cost,
      usage: spent.dump(),
      context_tokens: context.context_tokens,
      context_window: context.context_window,
    },
  });
  run.console.agent_finished(agent.name, spent.total_tokens, spent.total_cost);
  if (envelope.status !== "success") {
    throw new Error(
      `${agent.name} reported status=${JSON.stringify(envelope.status)}: ${envelope.summary}`,
    );
  }
  return envelope as T;
}

// ── internals ────────────────────────────────────────────────────────────────

/** Accept a GateReport, or a legacy gate that returned a violations list. */
function _as_report(result: unknown): GateReport {
  if (result instanceof GateReport) return result;
  const report = new GateReport();
  for (const violation of (result as string[]) ?? []) report.check(String(violation), false);
  return report;
}

function _agent_session_id(run: any, agent: AgentConfig): string {
  const entry = run.agent_map[agent.name];
  if (entry && entry.model === agent.model) return entry.session_id; // rejoin the existing context window
  return `sssf-${run.adw_id}-${agent.name}-${new_id(4)}`;
}

/** One tool_call event per real tool call, with its exact args and result. */
function _event_forwarder(run: any, phase: Phase, agent_name: string, runner: CodingAgent) {
  const tracker = new runner.ToolCallTracker();

  return (event: Record<string, any>): void => {
    const record = tracker.observe(event);
    if (record === null) return;
    // The call's span rides the columns; duration_ms stays in the payload as
    // the coding agent's own authoritative number.
    const { label, started_at, ended_at, ...payload } = record;
    run.tracer.event({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "tool_call",
      name: label,
      started_at: started_at ?? null,
      ended_at: ended_at ?? null,
      payload: { ...payload, agent: agent_name },
    });
  };
}

function _extract_json(text: string): unknown {
  let candidate = text;
  if (text.includes("```")) {
    const parts = text.split("```");
    for (let i = 1; i < parts.length; i += 2) {
      const block = parts[i]!.replace(/^json/, "").trim();
      if (block.startsWith("{")) {
        candidate = block;
        break;
      }
    }
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in the response");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Parse the final response against the declared output type; on failure,
 * continue the SAME session with a correction (bounded).
 */
async function _parse_with_retries<T>(
  run: any,
  phase: Phase,
  call: AgentCall<T>,
  result: AgentResult,
  send: (prompt: string) => Promise<AgentResult>,
): Promise<{ envelope: EnvelopeBase & T; attempt: number }> {
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    try {
      const payload = _extract_json(result.text);
      const envelope = call.output_type.schema.parse(payload) as EnvelopeBase & T;
      return { envelope, attempt };
    } catch (error) {
      const detail =
        error instanceof z.ZodError ? z.prettifyError(error) : String(error instanceof Error ? error.message : error);
      _persist_envelope(run, phase, phase.params.owner, call, null, attempt, false, result.text);
      if (attempt > JSON_FIX_ATTEMPTS) {
        throw new Error(
          `${phase.params.owner} never produced valid ` +
            `${call.output_type.name} JSON: ${detail}`,
        );
      }
      run.console.retry(
        phase.params.owner,
        attempt,
        JSON_FIX_ATTEMPTS,
        `invalid ${call.output_type.name} JSON: ${detail}`,
      );
      const fields = call.output_type.fields.join(", ");
      result = await send(
        `Your response was not valid JSON for the required structure ` +
          `(${detail}). Respond again with ONLY a JSON object with these ` +
          `fields: ${fields}. No prose, no code fences.`,
      );
    }
  }
  // Unreachable: the loop either returns an envelope or throws on its last attempt.
  throw new Error(`${phase.params.owner} never produced valid ${call.output_type.name} JSON`);
}

function _persist_envelope(
  run: any,
  phase: Phase,
  agent_name: string,
  call: AgentCall<any>,
  envelope: EnvelopeBase | null,
  attempt: number,
  valid: boolean,
  raw = "",
): void {
  const payload_json = envelope
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify({ raw: raw.slice(-2000) });
  run.tracer.envelope_row(phase, agent_name, call.output_type.name, payload_json, valid, attempt);
  if (envelope) {
    const record = {
      agent_name,
      purpose: resolve(run.cfg, agent_name).purpose,
      output_type: call.output_type.name,
      attempt,
      ...envelope,
    };
    writeFileSync(
      join(run.session_dir, agent_name, "envelope.json"),
      JSON.stringify(record, null, 2),
    );
  }
}
