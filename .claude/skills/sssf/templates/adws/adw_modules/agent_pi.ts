/**
 * Pi coding agent interface — v1's only coding agent.
 *
 * Runs `pi -p --mode json` and tails its JSONL stdout line by line, forwarding
 * each event to a callback WHILE the agent works (the streaming crack, solved
 * by construction). `--session-id` creates-or-continues, so running and
 * continuing an agent are the same call: same session id = same context window.
 */

import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PiRequest, PiResult } from "./data_types.ts";
import { UsageBreakdown } from "./data_types.ts";
import { ensure_dir, now_iso, operator_env } from "./utils.ts";

const PI_PATH = process.env.PI_PATH || "pi";
const MODELS_JSON = process.env.PI_MODELS_PATH || join(homedir(), ".pi", "agent", "models.json");

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip only guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not be handed cut-off data
const LABEL_CHARS = 80; // "bash: <command>" shown as the event name

// The arg that identifies a call at a glance, in the order tools tend to use.
const PRIMARY_ARGS = ["command", "path", "file_path", "pattern", "query", "url"];

/** Parse pi's compact model-list counts (`272K`, `1.0M`). */
function _count(value: string): number {
  const suffixes: Record<string, number> = { K: 1_000, M: 1_000_000 };
  const suffix = value.slice(-1).toUpperCase();
  if (suffix in suffixes) {
    const scaled = Number(value.slice(0, -1)) * suffixes[suffix]!;
    if (Number.isNaN(scaled)) throw new Error(`not a count: ${value}`);
    return Math.trunc(scaled);
  }
  const plain = Number(value);
  if (!Number.isInteger(plain)) throw new Error(`not a count: ${value}`);
  return plain;
}

let _catalog_cache: [string, string, number][] | null = null;

/** Read pi's merged catalog, including built-in providers and custom models. */
function _pi_catalog(): [string, string, number][] {
  if (_catalog_cache !== null) return _catalog_cache;
  let result;
  try {
    result = Bun.spawnSync([PI_PATH, "--list-models"], {
      env: operator_env(),
      timeout: 30_000,
    });
  } catch {
    _catalog_cache = [];
    return _catalog_cache;
  }
  if (result.exitCode !== 0) {
    _catalog_cache = [];
    return _catalog_cache;
  }
  const rows: [string, string, number][] = [];
  for (const line of result.stdout.toString().split("\n").slice(1)) {
    const columns = line.split(/\s+/).filter(Boolean);
    if (columns.length < 3) continue;
    try {
      rows.push([columns[0]!, columns[1]!, _count(columns[2]!)]);
    } catch {
      continue;
    }
  }
  _catalog_cache = rows;
  return rows;
}

/**
 * Resolve a model pattern to an explicit `[provider, model_id]` pair.
 *
 * Pi's catalog merges built-in models with `~/.pi/agent/models.json`. Using
 * that same merged view lets SSSF target direct providers such as
 * `openai/gpt-5.6-terra` without re-registering built-in models locally.
 */
export function resolve_model(pattern: string): [string, string] {
  const catalog = _pi_catalog().map(([provider, model_id]) => [provider, model_id] as const);
  if (pattern.includes("/")) {
    const index = pattern.indexOf("/");
    const provider = pattern.slice(0, index);
    const model_id = pattern.slice(index + 1);
    if (catalog.some(([p, m]) => p === provider && m === model_id)) return [provider, model_id];
  }
  const matches = catalog.filter(([, model_id]) => pattern === model_id || model_id.includes(pattern));
  const exact = matches.filter(([, model_id]) => model_id === pattern || model_id.endsWith("/" + pattern));
  if (exact.length === 1) return [exact[0]![0], exact[0]![1]];
  if (matches.length === 1) return [matches[0]![0], matches[0]![1]];
  if (!matches.length) {
    throw new Error(
      `model pattern ${JSON.stringify(pattern)} not found in pi --list-models — ` +
        "authenticate/register it or fix the config",
    );
  }
  throw new Error(
    `model pattern ${JSON.stringify(pattern)} is ambiguous: ${JSON.stringify(matches)}`,
  );
}

/**
 * Tokens occupying the window after a turn.
 *
 * Mirrors pi's own `calculateContextTokens` (coding-agent
 * `core/compaction/compaction.ts`), which is what pi compacts against and
 * shows in its footer: prefer the provider's `totalTokens`, else sum the
 * parts. Cache reads count — cached prompt is still prompt.
 */
function _context_tokens(usage: Record<string, any>): number {
  const total = usage.totalTokens || 0;
  if (total) return Math.trunc(total);
  return ["input", "output", "cacheRead", "cacheWrite"].reduce(
    (sum, part) => sum + (usage[part] || 0),
    0,
  );
}

/** The model's context ceiling from pi's merged model catalog. */
export function context_window(provider: string, model_id: string): number {
  try {
    const registry = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
    for (const model of registry?.providers?.[provider]?.models ?? []) {
      if (model?.id === model_id) return Math.trunc(model.contextWindow || 0);
    }
  } catch {
    // No local models.json is normal — the merged catalog below still answers.
  }
  for (const [listed_provider, listed_model, window] of _pi_catalog()) {
    if (listed_provider === provider && listed_model === model_id) return window;
  }
  return 0;
}

/**
 * Join the text blocks of anything pi shapes as {content: [...]} — a
 * message or a tool result.
 */
function _text_of(container: Record<string, any>): string {
  return (container?.content ?? [])
    .filter((part: any) => part && typeof part === "object" && part.type === "text")
    .map((part: any) => part.text ?? "")
    .join("");
}

function _clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

/** One-line human name for a tool call: `bash: ls -la src`. */
function _label(tool: string, args: Record<string, any>): string {
  let value =
    PRIMARY_ARGS.map((key) => args?.[key]).find(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    ) ?? "";
  if (!value) {
    value =
      Object.values(args ?? {}).find((v) => typeof v === "string" && v.trim()) ?? "";
  }
  value = String(value).split(/\s+/).filter(Boolean).join(" ");
  return value ? `${tool}: ${_clip(value, LABEL_CHARS)}` : tool;
}

/**
 * Folds pi's tool stream into ONE normalized record per completed call.
 *
 * pi announces a call as a `toolCall` content block, then emits
 * tool_execution_start / _update / _end for it. Only the end carries the
 * result, so that is where a record is emitted — one trace event per real
 * tool call, the moment it returns, instead of three shapeless ones.
 *
 * The record carries the call's real span (`started_at`/`ended_at`), which the
 * tracer writes to columns so the UI can lay tool calls on a time axis without
 * parsing every payload.
 */
export class ToolCallTracker {
  private _open = new Map<string, { tool: string; args: any; started_at: string; clock: number }>();

  /** Returns the record for a finished tool call, else null. */
  observe(event: Record<string, any>): Record<string, any> | null {
    const etype = event.type ?? "";
    if (etype === "message_end") {
      for (const block of event.message?.content ?? []) {
        if (block && typeof block === "object" && block.type === "toolCall") {
          this._announce(block.id, block.name, block.arguments);
        }
      }
      return null;
    }
    if (etype === "tool_execution_start") {
      this._announce(event.toolCallId, event.toolName, event.args);
      return null;
    }
    if (etype !== "tool_execution_end") return null;

    const call_id = String(event.toolCallId ?? "");
    const opened = this._open.get(call_id);
    this._open.delete(call_id);
    const tool = String(event.toolName || opened?.tool || "tool");
    const args = event.args || opened?.args || {};
    const record: Record<string, any> = {
      tool,
      tool_call_id: call_id,
      args: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string" ? _clip(value, ARG_VALUE_CHARS) : value,
        ]),
      ),
      ok: !event.isError,
      label: _label(tool, args),
    };
    const result_text = _text_of(event.result || {});
    if (result_text) record.result_snippet = _clip(result_text, RESULT_SNIPPET_CHARS);
    record.ended_at = now_iso();
    if (opened?.clock) record.duration_ms = Math.trunc(performance.now() - opened.clock);
    if (opened?.started_at) record.started_at = opened.started_at;
    return record;
  }

  /** First sighting starts the clock; a later sighting only fills gaps. */
  private _announce(call_id: any, tool: any, args: any): void {
    if (!call_id) return;
    const key = String(call_id);
    const known = this._open.get(key);
    this._open.set(key, {
      tool: tool || known?.tool || "",
      args: args || known?.args || {},
      started_at: known?.started_at || now_iso(), // wall clock, for the row
      clock: known?.clock || performance.now(), // monotonic, for duration
    });
  }
}

/**
 * Run one non-interactive pi turn.
 *
 * `on_spawn(pid)` and `on_exit(pid)` bracket the child process so the caller
 * can record it as killable — a hung coding agent is otherwise a pid you have
 * to hunt for in `ps` while the run sits there.
 */
export async function run(
  request: PiRequest,
  on_event?: (event: Record<string, any>) => void,
  on_spawn?: (pid: number) => void,
  on_exit?: (pid: number) => void,
): Promise<PiResult> {
  const [provider, model_id] = resolve_model(request.model);
  const cmd = [
    PI_PATH,
    "-p",
    "--mode",
    "json",
    "--provider",
    provider,
    "--model",
    model_id,
    "--thinking",
    request.thinking,
    "--session-id",
    request.session_id,
    "--session-dir",
    request.session_dir,
    "--system-prompt",
    request.system_prompt,
  ];
  if (request.tools?.length) cmd.push("--tools", request.tools.join(","));
  for (const extension of request.extensions) cmd.push("-e", extension);
  cmd.push(request.prompt);

  ensure_dir(dirname(request.raw_output_path));

  const result: PiResult = {
    text: "",
    returncode: 0,
    session_id: request.session_id,
    tokens: 0,
    cost: 0,
    usage: new UsageBreakdown(),
    context_tokens: 0,
    context_window: context_window(provider, model_id),
  };

  // stdin is ignored, deliberately. The prompt travels in argv, so the child
  // never needs stdin — but inheriting the parent's means pi sees a non-TTY
  // and can sit forever waiting for piped input that will never arrive or
  // EOF. That failure is silent and total: no request goes out, no bytes come
  // back, and the ADW blocks on a read loop with nothing to read. Observed as
  // a run that sat idle at 0% CPU with an empty raw_output.jsonl.
  const child = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: request.cwd,
    env: operator_env(),
  });
  on_spawn?.(child.pid);

  const decoder = new TextDecoder();
  const raw = openSync(request.raw_output_path, "a");
  let buffer = "";
  const handle = (raw_line: string): void => {
    // Written as it happens: events land on disk while the agent still works,
    // so a run that hangs later still has everything up to that point.
    writeSync(raw, raw_line);
    const line = raw_line.trim();
    if (!line) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "message_end") {
      const message = event.message ?? {};
      if (message.role === "assistant") {
        const text = _text_of(message);
        if (text) result.text = text; // last assistant message wins
        const usage = message.usage ?? {};
        const turn = _context_tokens(usage);
        result.tokens += turn;
        result.usage.add_turn(usage, turn);
        // Occupancy is read off the last VALID assistant turn, the
        // way pi does it — an aborted or errored turn reports usage
        // you can't trust, so it must not overwrite a good reading.
        if (turn && message.stopReason !== "aborted" && message.stopReason !== "error") {
          result.context_tokens = turn;
        }
        // Real metered spend: pi runs on provider API keys, so every token
        // here was billed. The factory-wide rule is that `cost` is money
        // actually charged — subscription-billed interfaces report 0.00 rather
        // than a notional API-price estimate (see agent_cc.ts).
        result.cost += usage.cost?.total || 0;
      }
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

  const stderr = await new Response(child.stderr).text();
  result.returncode = await child.exited;
  on_exit?.(child.pid);
  if (result.returncode !== 0 && !result.text) {
    throw new Error(`pi exited ${result.returncode}: ${stderr.trim().slice(-800)}`);
  }
  return result;
}
