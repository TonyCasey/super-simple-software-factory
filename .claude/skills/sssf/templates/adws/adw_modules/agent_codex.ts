/**
 * Codex coding agent interface.
 *
 * Runs `codex exec --json` and tails its JSONL stdout line by line, forwarding
 * each event to a callback WHILE the agent works — the same streaming shape
 * `agent_pi.ts` and `agent_cc.ts` have, behind the same four exported symbols
 * (`resolve_model`, `context_window`, `ToolCallTracker`, `run`), so `agents.ts`
 * dispatches between all three on `coding_agent` alone.
 *
 * This is the roster's way out of a monoculture. Every other interface here
 * reaches a model that reviews the way its siblings write; a Codex reviewer
 * disagrees with a Claude builder in ways an Opus reviewer structurally cannot.
 * It runs on the operator's ChatGPT subscription via `codex login`.
 *
 * Three things differ from the Claude Code adapter, all forced by the CLI:
 *
 *   - **No system-prompt flag.** Codex's own `base_instructions` config key
 *     REPLACES the built-in agent prompt — the one teaching it `apply_patch`,
 *     sandbox etiquette and parallel tool calls — so writing an SSSF prompt
 *     there would cost more than it buys, and `AGENTS.md` is repo-wide when a
 *     roster runs several agents in one repo. The system prompt is therefore
 *     prepended to the user prompt on stdin. Verified: a reviewer briefed this
 *     way returns a clean, parseable envelope first try.
 *   - **No per-tool allowlist.** Codex has sandbox MODES, not tool switches, so
 *     `writes` decides the mode (see `_sandbox_for`). For a read-only agent this
 *     is a stronger fence than either sibling gives — enforced before the call
 *     rather than rolled back after it.
 *   - **No cost data.** `turn.completed.usage` counts tokens and reports no
 *     dollars, so `result.cost` stays 0 here. Token counts are exact.
 */

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentRequest, AgentResult } from "./data_types.ts";
import { UsageBreakdown } from "./data_types.ts";
import { ensure_dir, now_iso, operator_env } from "./utils.ts";

const CODEX_PATH = process.env.CODEX_PATH || "codex";

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip only guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not be handed cut-off data
const LABEL_CHARS = 80; // "shell: <command>" shown as the event name

// Codex publishes no per-model context ceiling, so the visualizer's context bar
// gets a documented constant rather than a fabricated one. Override per model
// as the CLI starts reporting it.
const DEFAULT_CONTEXT_WINDOW = 400_000;

/**
 * Model ids a ChatGPT subscription can actually run.
 *
 * This is an allowlist rather than a shape check, because the failure it
 * prevents is invisible until spend has happened: `gpt-5.2` is a real model
 * that the API serves and a ChatGPT account does NOT, and asking for it returns
 * a 400 *after* the session exists — mid-phase, with the roster already moving.
 * Verified against a live subscription; extend as the plans change.
 */
const SUBSCRIPTION_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);

/** SSSF thinking levels -> Codex's `model_reasoning_effort`. */
const REASONING_EFFORT: Record<string, string> = {
  off: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

let _cli_ok: boolean | null = null;

/** Fail fast, and once: a missing CLI must surface in validate(), not mid-run. */
function _require_cli(): void {
  if (_cli_ok === null) {
    try {
      const probe = Bun.spawnSync([CODEX_PATH, "--version"], {
        env: operator_env(),
        timeout: 30_000,
      });
      _cli_ok = probe.exitCode === 0;
    } catch {
      _cli_ok = false;
    }
  }
  if (!_cli_ok) {
    throw new Error(
      `the Codex CLI (${JSON.stringify(CODEX_PATH)}) is not runnable — ` +
        "install it and run `codex login`, or set CODEX_PATH to its location",
    );
  }
}

let _auth_problem: string | null | undefined;

/**
 * A definite "no Codex credential here" verdict, or null.
 *
 * `codex login status` exits 0 when authenticated and 1 when not — a cleaner
 * signal than its Claude Code counterpart, which reports success for a
 * credential that is merely PRESENT. This still proves presence rather than
 * validity (an expired ChatGPT session passes and fails on the first request),
 * and it fails OPEN: anything but a definite non-zero exit passes, because
 * blocking a working factory over a misfired probe is the worse error.
 */
export function unauthenticated_reason(): string | null {
  if (_auth_problem !== undefined) return _auth_problem;
  _auth_problem = null;
  try {
    const probe = Bun.spawnSync([CODEX_PATH, "login", "status"], {
      env: operator_env(),
      timeout: 30_000,
    });
    if (probe.exitCode !== 0) {
      _auth_problem =
        "no Codex credential — run `codex login` to sign in with the ChatGPT " +
        "account whose subscription should pay, or `codex login --with-api-key` " +
        "to spend an OpenAI API key instead.";
    }
  } catch {
    // Fail open — see above.
  }
  return _auth_problem;
}

/**
 * Resolve a model pattern to an explicit `[provider, model_id]` pair.
 *
 * The provider is always "openai" — the only one this CLI serves on a
 * subscription. `openai/` is accepted and stripped so a roster can write its
 * models the same provider/id way pi's does.
 */
export function resolve_model(pattern: string): [string, string] {
  _require_cli();
  let model_id = (pattern ?? "").trim();
  if (model_id.startsWith("openai/")) model_id = model_id.slice("openai/".length);
  if (SUBSCRIPTION_MODELS.has(model_id)) return ["openai", model_id];
  throw new Error(
    `model ${JSON.stringify(pattern)} is not runnable on a ChatGPT subscription — ` +
      `use one of ${JSON.stringify([...SUBSCRIPTION_MODELS])}. Older ids such as ` +
      `"gpt-5.2" are API-key only: Codex accepts them, then fails the turn with ` +
      `"not supported when using Codex with a ChatGPT account".`,
  );
}

/** The model's context ceiling. Static — the CLI reports none to refine it from. */
export function context_window(_provider: string, _model_id: string): number {
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * The sandbox mode an agent's `writes` earns it.
 *
 * Codex trades SSSF's per-tool allowlist for something coarser and stronger: a
 * read-only agent physically cannot write, where pi and Claude Code rely on
 * `permissions.ts` diffing the tree afterwards and rolling the damage back. The
 * post-hoc fence still runs — this narrows what has to reach it.
 *
 * `writes: null` (unrestricted) still gets `workspace-write`, never
 * `danger-full-access`: "unrestricted" in a roster means the repo, and an agent
 * that has no business leaving the workspace should not be able to.
 */
function _sandbox_for(writes: string[] | null | undefined): string {
  return writes !== null && writes !== undefined && writes.length === 0
    ? "read-only"
    : "workspace-write";
}

function _clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

/** One-line human name for a tool call: `shell: rg -n slugify src`. */
function _label(tool: string, args: Record<string, any>): string {
  const value = String(args?.command ?? args?.path ?? args?.query ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return value ? `${tool}: ${_clip(value, LABEL_CHARS)}` : tool;
}

/**
 * Folds Codex's item stream into ONE normalized record per completed tool call.
 *
 * Codex reports a finished unit of work as `item.completed`, carrying the whole
 * call — command, output and exit code together — so unlike the sibling
 * adapters there is no announce/result pairing to reconcile. The trade is that
 * `started_at` is only known when the item lands, so the span is a point rather
 * than a duration; the tracer records it and the UI lays it out accordingly.
 */
export class ToolCallTracker {
  private _pending: Record<string, any>[] = [];

  /** Returns the record for a finished tool call, else null. */
  observe(event: Record<string, any>): Record<string, any> | null {
    if (event?.type === "item.completed") {
      const record = this._complete(event.item ?? {});
      if (record) this._pending.push(record);
    }
    return this._pending.shift() ?? null;
  }

  private _complete(item: Record<string, any>): Record<string, any> | null {
    const kind = String(item.type ?? "");
    // `agent_message` is the answer, not a tool call, and `reasoning` is
    // thinking. Neither belongs in the tool-call lane of the trace.
    if (kind === "agent_message" || kind === "reasoning") return null;

    const tool = kind === "command_execution" ? "shell" : kind || "tool";
    const args: Record<string, any> = {};
    for (const key of ["command", "path", "query", "changes"]) {
      if (item[key] !== undefined) {
        args[key] = typeof item[key] === "string" ? _clip(item[key], ARG_VALUE_CHARS) : item[key];
      }
    }
    const record: Record<string, any> = {
      tool,
      tool_call_id: String(item.id ?? ""),
      args,
      // `status` is absent on item types that cannot fail; only an explicit
      // failure signal counts against a call.
      ok: item.exit_code === undefined ? item.status !== "failed" : item.exit_code === 0,
      label: _label(tool, args),
    };
    const output = item.aggregated_output ?? item.output ?? item.message;
    if (typeof output === "string" && output) {
      record.result_snippet = _clip(output, RESULT_SNIPPET_CHARS);
    }
    record.started_at = now_iso();
    record.ended_at = record.started_at;
    return record;
  }
}

/** The thread id to resume for an SSSF session id, or null to create one. */
function _read_marker(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const id = JSON.parse(readFileSync(path, "utf8"))?.thread_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function _write_marker(path: string, sssf_session_id: string, thread_id: string): void {
  writeFileSync(
    path,
    JSON.stringify({ sssf_session_id, thread_id, updated_at: now_iso() }, null, 2),
  );
}

/**
 * Run one non-interactive Codex turn.
 *
 * `on_spawn(pid)` and `on_exit(pid)` bracket the child process so the caller
 * can record it as killable — a hung coding agent is otherwise a pid you have
 * to hunt for in `ps` while the run sits there.
 */
export async function run(
  request: AgentRequest,
  on_event?: (event: Record<string, any>) => void,
  on_spawn?: (pid: number) => void,
  on_exit?: (pid: number) => void,
): Promise<AgentResult> {
  const [provider, model_id] = resolve_model(request.model);
  if (request.extensions.length) {
    throw new Error(
      "harness_engineering is a pi-only field: " +
        `${JSON.stringify(request.extensions)} cannot load into codex`,
    );
  }

  ensure_dir(request.session_dir);
  ensure_dir(dirname(request.raw_output_path));

  const marker_path = join(request.session_dir, `${request.session_id}.json`);
  const resume_thread = _read_marker(marker_path);

  // The system prompt leads the stdin payload — see the header for why it is
  // not a flag. The separator is explicit so the agent can tell the standing
  // brief from the turn's task rather than reading one run-on wall of text.
  const prompt = resume_thread
    ? request.prompt
    : `${request.system_prompt}\n\n---\n\n${request.prompt}`;

  // `--ignore-user-config` keeps the operator's ~/.codex/config.toml out of
  // factory runs — theirs may well say `sandbox_mode = "danger-full-access"`,
  // and a run must behave the same on every machine. Auth is unaffected: it
  // lives in CODEX_HOME, not in the config file.
  const reasoning = REASONING_EFFORT[request.thinking] ?? "medium";
  const cmd = resume_thread
    ? [
        CODEX_PATH, "exec", "resume",
        "--json",
        "--model", model_id,
        "-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`,
        "--skip-git-repo-check",
        "--ignore-user-config",
        resume_thread,
        "-", // prompt on stdin
      ]
    : [
        CODEX_PATH, "exec",
        "--json",
        "--model", model_id,
        "-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`,
        "--sandbox", _sandbox_for(request.writes),
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-",
      ];

  const result: AgentResult = {
    text: "",
    returncode: 0,
    session_id: request.session_id,
    tokens: 0,
    cost: 0, // Codex reports no dollars — see the header.
    usage: new UsageBreakdown(),
    context_tokens: 0,
    context_window: context_window(provider, model_id),
  };

  const child = Bun.spawn(cmd, {
    stdin: new Blob([prompt]), // a definite EOF: the child reads it and moves on
    stdout: "pipe",
    stderr: "pipe",
    cwd: request.cwd, // `resume` takes no --cd, so the process cwd carries it for both paths
    env: operator_env(),
  });
  on_spawn?.(child.pid);

  // Drained from the start, not after the stdout loop: stderr is a 64KB pipe,
  // and a child that fills it while nobody reads blocks forever.
  const stderr_text = new Response(child.stderr).text();

  let turn_usage: Record<string, any> | null = null;
  let failure: string | null = null;
  let saw_thread = false;

  const decoder = new TextDecoder();
  const raw = openSync(request.raw_output_path, "a");
  let buffer = "";
  const handle = (raw_line: string): void => {
    writeSync(raw, raw_line);
    const line = raw_line.trim();
    if (!line) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const etype = event.type ?? "";
    if (etype === "thread.started" && event.thread_id) {
      saw_thread = true;
      // The thread provably exists now. Recorded here and not at the end so a
      // run killed mid-turn still resumes instead of starting over.
      _write_marker(marker_path, request.session_id, event.thread_id);
    } else if (etype === "item.completed" && event.item?.type === "agent_message") {
      const text = String(event.item.text ?? "");
      if (text.trim()) result.text = text; // last agent message wins
    } else if (etype === "turn.completed") {
      turn_usage = event.usage ?? null;
    } else if (etype === "turn.failed" || etype === "error") {
      failure = String(event.error?.message ?? event.message ?? "").slice(0, 600);
    }
    on_event?.(event);
  };

  try {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handle(buffer.slice(0, newline + 1));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer) handle(buffer);
  } finally {
    closeSync(raw);
  }

  const stderr = await stderr_text;
  result.returncode = await child.exited;
  on_exit?.(child.pid);

  // Cast because the assignment happens inside the stream closure, which the
  // compiler cannot see from here — it narrows the variable to its initial null.
  const usage = turn_usage as Record<string, any> | null;
  if (usage) {
    const parts = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cached_input_tokens || 0,
      cacheWrite: usage.cache_write_input_tokens || 0,
      reasoning: usage.reasoning_output_tokens || 0,
    };
    // Codex's `input_tokens` is the whole prompt INCLUDING the cached share,
    // unlike the Anthropic shape where the two are disjoint. Adding cacheRead
    // to the total here would double-count it.
    const total = parts.input + parts.output + parts.cacheWrite;
    result.tokens = total;
    result.usage.add_turn(parts, total);
    // The prompt the model just saw, plus what it wrote: occupancy after this
    // turn, which is what the visualizer's context bar measures.
    result.context_tokens = parts.input + parts.output;
  }

  // A turn that failed reports it in-band and still exits 0 — the JSON stream
  // is the status channel, not the exit code. Left unchecked, the failure text
  // would reach the envelope parser and burn every JSON-fix retry on a session
  // that never produced an envelope at all.
  if (failure && !result.text) {
    throw new Error(`codex turn failed: ${failure}`);
  }
  if (result.returncode !== 0 && !result.text) {
    if (resume_thread && !saw_thread) {
      throw new Error(
        `codex could not resume thread ${resume_thread} (exit ${result.returncode}): ` +
          `${stderr.trim().slice(-400)}\nDelete ${marker_path} (or this agent's entry in ` +
          "agent_map.json) to start a fresh context.",
      );
    }
    throw new Error(`codex exited ${result.returncode}: ${stderr.trim().slice(-800)}`);
  }
  return result;
}
