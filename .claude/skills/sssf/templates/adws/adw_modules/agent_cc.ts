/**
 * Claude Code coding agent interface.
 *
 * Runs `claude -p --output-format stream-json --verbose` and tails its JSONL
 * stdout line by line, forwarding each event to a callback WHILE the agent
 * works — the same streaming shape `agent_pi.ts` has, behind the same four
 * exported symbols (`resolve_model`, `context_window`, `ToolCallTracker`,
 * `run`), so `agents.ts` dispatches between them on `coding_agent` alone.
 *
 * The point of this interface is SUBSCRIPTION billing: agents run on the
 * operator's Claude Pro/Max plan via `claude login` (or `claude setup-token`),
 * not on a metered API key. That is why every child process launches through
 * `claude_env()` — see utils.ts for the precedence rules it defends.
 *
 * Two things diverge from pi and are deliberate:
 *   - the prompt rides STDIN, not argv (pi puts it in argv). A gate correction
 *     that quotes a diff blows past `MAX_ARG_STRLEN` (~128KB) as an argument
 *     but is nothing as a pipe. Passing a Blob gives the child a definite EOF,
 *     so the hang that made pi use `stdin: "ignore"` cannot happen here.
 *   - the system prompt therefore goes via `--system-prompt-file` (only one
 *     thing can ride stdin), written into the session dir next to the marker.
 */

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { AgentRequest, AgentResult } from "./data_types.ts";
import { UsageBreakdown } from "./data_types.ts";
import { claude_env, ensure_dir, now_iso } from "./utils.ts";

const CLAUDE_PATH = process.env.CLAUDE_CODE_PATH || "claude";

// Which settings files the child loads. The operator's own `~/.claude` hooks,
// output styles and permission rules are personal to their interactive
// sessions; a factory run must behave the same on every machine, so `user` is
// left out by default. Set SSSF_CC_SETTING_SOURCES=user,project,local to opt
// back in. Auth is unaffected — the OAuth credential is not a setting source.
const SETTING_SOURCES = process.env.SSSF_CC_SETTING_SOURCES || "project,local";

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip only guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not be handed cut-off data
const LABEL_CHARS = 80; // "Bash: <command>" shown as the event name

// The arg that identifies a call at a glance, in the order tools tend to use.
const PRIMARY_ARGS = ["command", "path", "file_path", "pattern", "query", "url"];

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000; // the `[1m]` model-id suffix

/** Model aliases the CLI resolves to "the latest model of that family". */
const MODEL_ALIASES = new Set(["fable", "opus", "sonnet", "haiku", "best", "default"]);

/**
 * SSSF's pi-flavored tool vocabulary, mapped to Claude Code's tool names.
 *
 * Config stays written in one vocabulary across both interfaces — an agent's
 * `tools:` list does not change when its `coding_agent` does. `find` and `ls`
 * both land on Glob because Claude Code has no separate directory-listing tool;
 * the mapped list is deduped, so naming both is harmless.
 */
const TOOL_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

// Bookkeeping only: it writes nothing to the repo, and leaving it out of an
// allowlist produces a stream of denied-tool noise in every trace.
const ALWAYS_ALLOWED = ["TodoWrite"];

/** SSSF thinking levels -> `--effort`. Claude Code has no "off": the floor is low. */
const EFFORT_LEVELS: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

let _cli_ok: boolean | null = null;

/** Fail fast, and once: a missing CLI must surface in validate(), not mid-run. */
function _require_cli(): void {
  if (_cli_ok === null) {
    try {
      const probe = Bun.spawnSync([CLAUDE_PATH, "--version"], {
        env: claude_env(),
        timeout: 30_000,
      });
      _cli_ok = probe.exitCode === 0;
    } catch {
      _cli_ok = false;
    }
  }
  if (!_cli_ok) {
    throw new Error(
      `the Claude Code CLI (${JSON.stringify(CLAUDE_PATH)}) is not runnable — ` +
        "install it and run `claude login`, or set CLAUDE_CODE_PATH to its location",
    );
  }
}

let _auth_problem: string | null | undefined;

/**
 * A definite "no Claude Code credential here" verdict, or null.
 *
 * The CLI is asked under `claude_env()`, not the operator's own environment, so
 * it answers the question that actually matters: what will the AGENTS see once
 * the API-key scrub has run? An `ANTHROPIC_API_KEY` only the operator can see is
 * not a credential from an agent's point of view, and checking the unscrubbed
 * environment would cheerfully pass a container that is about to fail.
 *
 * Two limits, both deliberate:
 *
 *   - It proves PRESENCE, never validity. `claude auth status` reports
 *     `loggedIn: true` for an expired or malformed token — verified — and only a
 *     real request finds out otherwise. The HTTP-401 guard in `run()` is what
 *     catches that; this catches "the secret was never injected", which is the
 *     common container failure.
 *   - It fails OPEN. Anything other than an explicit `loggedIn: false` — a spawn
 *     error, unparseable output, an older CLI without the subcommand — passes.
 *     Blocking a working factory over a probe that misfired is worse than
 *     missing a preflight. Note the exit code is 0 either way, so the JSON field
 *     is the only signal.
 */
export function unauthenticated_reason(): string | null {
  if (_auth_problem !== undefined) return _auth_problem;
  _auth_problem = null;
  try {
    const probe = Bun.spawnSync([CLAUDE_PATH, "auth", "status", "--json"], {
      env: claude_env(),
      timeout: 30_000,
    });
    if (JSON.parse(probe.stdout.toString())?.loggedIn === false) {
      _auth_problem =
        "no Claude Code credential is visible to the agents — run `claude login`, " +
        "or `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN on a headless box. " +
        "An ANTHROPIC_API_KEY on its own does NOT count: it is scrubbed from the " +
        "child environment so the subscription is what pays. Set " +
        "SSSF_CC_USE_API_KEY=1 if spending that key is what you actually want.";
    }
  } catch {
    // Fail open — see above.
  }
  return _auth_problem;
}

/**
 * Resolve a model pattern to an explicit `[provider, model_id]` pair.
 *
 * Claude Code has no `--list-models`, so this is a shape check rather than a
 * catalog lookup: an alias, or a full `claude-*` id, either optionally carrying
 * the `[1m]` long-context suffix. An `anthropic/` prefix is accepted and
 * stripped so a roster can write its models the same provider/id way pi's does.
 * The provider is always "anthropic" — that is the only one this CLI serves on
 * a subscription.
 */
export function resolve_model(pattern: string): [string, string] {
  _require_cli();
  let model_id = (pattern ?? "").trim();
  if (model_id.startsWith("anthropic/")) model_id = model_id.slice("anthropic/".length);
  const base = model_id.endsWith("[1m]") ? model_id.slice(0, -4) : model_id;
  if (MODEL_ALIASES.has(base) || base.startsWith("claude-")) return ["anthropic", model_id];
  throw new Error(
    `model ${JSON.stringify(pattern)} is not a Claude Code model — use an alias ` +
      `(${[...MODEL_ALIASES].join(", ")}), a full claude-* id, or either with a [1m] suffix`,
  );
}

/**
 * The model's context ceiling.
 *
 * A static table, because the CLI exposes no catalog before a run. It is a
 * floor, not a guess: `run()` overwrites it from the terminal event's
 * `modelUsage[<id>].contextWindow`, which is the number the CLI itself used.
 */
export function context_window(_provider: string, model_id: string): number {
  return model_id.endsWith("[1m]") ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** Config tool names that this interface cannot express. Used by agents.validate(). */
export function unsupported_tools(tools: string[] | null): string[] {
  return (tools ?? []).filter((name) => !(name in TOOL_NAMES));
}

/** The `--allowedTools` value for a config tool list; null means "all tools". */
export function map_tools(tools: string[] | null): string[] | null {
  if (tools === null) return null;
  const mapped = tools.map((name) => TOOL_NAMES[name]).filter((name): name is string => !!name);
  return [...new Set([...mapped, ...ALWAYS_ALLOWED])];
}

/**
 * Unwrap the nested envelope some CLI versions put around each event.
 *
 * The shape has been both `{type: "assistant", message: {...}}` and a wrapper
 * carrying the real event under `event`. Normalizing once, here, means the rest
 * of this file — and every consumer downstream of `on_event` — sees one shape.
 */
function _normalize(event: Record<string, any>): Record<string, any> {
  const inner = event?.event;
  if (inner && typeof inner === "object" && !event.message && typeof inner.type === "string") {
    return { ...inner, session_id: inner.session_id ?? event.session_id };
  }
  return event;
}

/** Join the text blocks of anything shaped as {content: [...]}. */
function _text_of(container: Record<string, any>): string {
  const content = container?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part: any) => part && typeof part === "object" && part.type === "text")
    .map((part: any) => part.text ?? "")
    .join("");
}

function _clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

/** One-line human name for a tool call: `Bash: ls -la src`. */
function _label(tool: string, args: Record<string, any>): string {
  let value =
    PRIMARY_ARGS.map((key) => args?.[key]).find(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    ) ?? "";
  if (!value) {
    value = Object.values(args ?? {}).find((v) => typeof v === "string" && v.trim()) ?? "";
  }
  value = String(value).split(/\s+/).filter(Boolean).join(" ");
  return value ? `${tool}: ${_clip(value, LABEL_CHARS)}` : tool;
}

/** Anthropic per-turn usage -> pi's camelCase component shape. */
function _usage_of(usage: Record<string, any>): Record<string, number> {
  return {
    input: usage?.input_tokens || 0,
    output: usage?.output_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
    cacheWrite: usage?.cache_creation_input_tokens || 0,
    reasoning: usage?.output_tokens_details?.thinking_tokens || 0,
  };
}

/** How full the window is after a turn: everything the model saw, plus what it wrote. */
function _occupancy(usage: Record<string, any>): number {
  const parts = _usage_of(usage);
  return parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
}

/**
 * Folds Claude Code's tool stream into ONE normalized record per completed call.
 *
 * A `tool_use` block in an assistant message announces the call; the matching
 * `tool_result` block, which arrives as a USER message, completes it. Only the
 * result carries the outcome, so that is where a record is emitted — one trace
 * event per real tool call, the moment it returns.
 *
 * `duration_ms` is announce-to-result, so unlike pi's it includes the model
 * latency between the tool being requested and the CLI running it. Claude Code
 * has no `tool_execution_start` equivalent to measure execution alone.
 */
export class ToolCallTracker {
  private _open = new Map<string, { tool: string; args: any; started_at: string; clock: number }>();
  // Every observed CLI version emits one content block per event, so this holds
  // at most zero entries in practice. It exists so a version that batches
  // several tool_results into one user message drops none of them: extras queue
  // here and drain on the following events (there is always at least a terminal
  // result event behind them).
  private _pending: Record<string, any>[] = [];

  /** Returns the record for a finished tool call, else null. */
  observe(event: Record<string, any>): Record<string, any> | null {
    const normalized = _normalize(event);
    const etype = normalized.type ?? "";
    const blocks = normalized.message?.content;

    if (etype === "assistant" && Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          this._announce(block.id, block.name, block.input);
        }
      }
    } else if (etype === "user" && Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object" && block.type === "tool_result") {
          this._pending.push(this._complete(block));
        }
      }
    }
    return this._pending.shift() ?? null;
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

  private _complete(block: Record<string, any>): Record<string, any> {
    const call_id = String(block.tool_use_id ?? "");
    const opened = this._open.get(call_id);
    this._open.delete(call_id);
    const tool = String(opened?.tool || "tool");
    const args = opened?.args || {};
    const record: Record<string, any> = {
      tool,
      tool_call_id: call_id,
      args: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string" ? _clip(value, ARG_VALUE_CHARS) : value,
        ]),
      ),
      ok: !block.is_error,
      label: _label(tool, args),
    };
    // `content` is polymorphic: a plain string for most tools, a block array
    // when the result carries images or several parts. Both must yield text or
    // the snippet silently disappears from the trace.
    const result_text = _text_of(block);
    if (result_text) record.result_snippet = _clip(result_text, RESULT_SNIPPET_CHARS);
    record.ended_at = now_iso();
    if (opened?.clock) record.duration_ms = Math.trunc(performance.now() - opened.clock);
    if (opened?.started_at) record.started_at = opened.started_at;
    return record;
  }
}

/**
 * The UUID to resume for an SSSF session id, or null to create one.
 *
 * SSSF session ids (`sssf-<adw>-<agent>-<hex>`) are not UUIDs and `--session-id`
 * demands one, so the mapping lives in a marker file beside the session dir.
 * Absent marker = first run for this agent; present = resume that conversation.
 */
function _read_marker(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const uuid = JSON.parse(readFileSync(path, "utf8"))?.uuid;
    return typeof uuid === "string" && uuid ? uuid : null;
  } catch {
    return null;
  }
}

function _write_marker(path: string, sssf_session_id: string, uuid: string): void {
  writeFileSync(
    path,
    JSON.stringify({ sssf_session_id, uuid, updated_at: now_iso() }, null, 2),
  );
}

/**
 * Run one non-interactive Claude Code turn.
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
        `${JSON.stringify(request.extensions)} cannot load into Claude Code`,
    );
  }

  ensure_dir(request.session_dir);
  ensure_dir(dirname(request.raw_output_path));

  // Only one thing can ride stdin, and that is the prompt — so the system
  // prompt lands on disk next to the marker instead.
  const system_prompt_path = join(request.session_dir, "system_prompt.md");
  writeFileSync(system_prompt_path, request.system_prompt);

  const marker_path = join(request.session_dir, `${request.session_id}.json`);
  const resume_uuid = _read_marker(marker_path);

  const cmd = [
    CLAUDE_PATH,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose", // required by stream-json in print mode
    "--model",
    model_id,
    "--effort",
    EFFORT_LEVELS[request.thinking] ?? "medium",
    "--system-prompt-file",
    system_prompt_path,
    "--setting-sources",
    SETTING_SOURCES,
  ];
  if (resume_uuid) cmd.push("--resume", resume_uuid);
  else cmd.push("--session-id", randomUUID());

  // `tools: null` means "all tools", which under Claude Code's permission model
  // means approving them — the same posture pi's missing `--tools` gives. The
  // real fence is post-hoc: permissions.ts diffs the tree after every send and
  // rolls back anything the agent was not allowed to write. Agent proposes,
  // code disposes. Note the asymmetry with pi: a tool left out of the allowlist
  // here is visible-but-denied, not hidden, so the model can still try it.
  const allowed = map_tools(request.tools);
  if (allowed) cmd.push("--allowedTools", allowed.join(","), "--permission-mode", "dontAsk");
  else cmd.push("--permission-mode", "bypassPermissions");

  const result: AgentResult = {
    text: "",
    returncode: 0,
    session_id: request.session_id,
    tokens: 0,
    cost: 0,
    usage: new UsageBreakdown(),
    context_tokens: 0,
    context_window: context_window(provider, model_id),
  };

  const child = Bun.spawn(cmd, {
    stdin: new Blob([request.prompt]), // a definite EOF: the child reads it and moves on
    stdout: "pipe",
    stderr: "pipe",
    cwd: request.cwd,
    env: claude_env(), // subscription billing lives or dies here
  });
  on_spawn?.(child.pid);

  // Drained from the start, not after the stdout loop: stderr is a 64KB pipe,
  // and a child that fills it while nobody reads blocks forever — with the
  // stdout loop waiting on a process that is waiting on us.
  const stderr_text = new Response(child.stderr).text();

  const turn_usage = new Map<string, Record<string, any>>(); // message id -> its latest usage
  let last_message_id = "";
  let result_event: Record<string, any> | null = null;
  let saw_init = false;
  let api_key_source = "";

  const decoder = new TextDecoder();
  const raw = openSync(request.raw_output_path, "a");
  let buffer = "";
  const handle = (raw_line: string): void => {
    // Written as it happens: events land on disk while the agent still works,
    // so a run that hangs later still has everything up to that point.
    writeSync(raw, raw_line);
    const line = raw_line.trim();
    if (!line) return;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const event = _normalize(parsed);
    const etype = event.type ?? "";
    if (etype === "system" && event.subtype === "init") {
      saw_init = true;
      // The CLI names the credential it authenticated with: "none" means no API
      // key was involved, i.e. the subscription paid. Taken from the event
      // rather than inferred from the environment, because this is the child's
      // own account of what happened after the scrub.
      api_key_source = String(event.apiKeySource ?? "");
      // The session provably exists now, and this is its authoritative id.
      // Refreshing here (and again from the terminal event) keeps the marker
      // correct whether this CLI version resumes in place or forks a new id.
      if (event.session_id) _write_marker(marker_path, request.session_id, event.session_id);
    } else if (etype === "assistant") {
      const message = event.message ?? {};
      const text = _text_of(message);
      if (text.trim()) result.text = text; // last assistant text wins
      const id = String(message.id ?? "");
      // One event per content block, each repeating the SAME message's usage —
      // keyed by message id so a two-block turn is not billed twice.
      if (id && message.usage) {
        turn_usage.set(id, message.usage);
        last_message_id = id;
      }
    } else if (etype === "result") {
      result_event = event;
      if (event.session_id) _write_marker(marker_path, request.session_id, event.session_id);
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

  const terminal = result_event as Record<string, any> | null;
  if (terminal) {
    // The terminal event's usage is the authoritative total for the whole call.
    // The per-turn numbers streamed above are mid-flight snapshots — their
    // output counts are whatever had been generated when the block was emitted,
    // so summing them undercounts badly. They are kept only for occupancy,
    // which is dominated by the prompt side and correct as streamed.
    const parts = _usage_of(terminal.usage ?? {});
    const total = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
    // Cost is what was BILLED, not what the tokens would have been worth.
    //
    // Under a subscription nothing is metered per token, so `total_cost_usd` —
    // a client-side estimate of API prices — is money that was never charged.
    // Reporting it would make a run total silently mix real dollars with
    // imaginary ones, and there is no way to tell them apart downstream: the
    // console banner, the `agent_end` payload and the visualizer's Cost panel
    // all just add them up. So a subscription run reports 0.00 and the token
    // counts carry the usage signal, which is what they were always better at.
    //
    // `apiKeySource` is the child's own account of which credential paid:
    // "none" means no API key was involved. Anything else — the operator opted
    // out of the scrub with SSSF_CC_USE_API_KEY=1 — is real metered spend and
    // is reported in full.
    const billed = Boolean(api_key_source) && api_key_source !== "none";
    const cost = billed ? terminal.total_cost_usd || 0 : 0;
    result.tokens = total;
    // Per-component costs stay 0 even when billed: the CLI reports one total,
    // never a breakdown. The total is set on BOTH `cost` and `usage.total_cost`
    // — the console banner reads the first, the agent_end payload the second.
    result.usage.add_turn({ ...parts, cost: { total: cost } }, total);
    result.cost = cost;
    if (typeof terminal.result === "string" && terminal.result.trim()) {
      result.text = terminal.result;
    }
    // `modelUsage` is keyed by resolved model id and routinely holds MORE than
    // the model we asked for — the CLI bills small internal errands (titles,
    // summaries) to Haiku alongside them. So prefer our own key when we passed a
    // full id, and otherwise take the widest window on offer: an alias like
    // "opus" never matches "claude-opus-5", and every main model's window is at
    // least as wide as the errand model's.
    const usage_by_model = (terminal.modelUsage ?? {}) as Record<string, any>;
    const exact = usage_by_model[model_id]?.contextWindow;
    const window = exact
      ? Math.trunc(exact)
      : Math.max(
          0,
          ...Object.values(usage_by_model).map((entry: any) => Math.trunc(entry?.contextWindow || 0)),
        );
    if (window > 0) result.context_window = window;
  } else {
    // No terminal event (killed, crashed): fall back to the streamed turns so a
    // partial run still reports something rather than a confident zero.
    for (const usage of turn_usage.values()) {
      const parts = _usage_of(usage);
      const total = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
      result.tokens += total;
      result.usage.add_turn(parts, total);
    }
  }

  const last_turn = turn_usage.get(last_message_id);
  if (last_turn) result.context_tokens = _occupancy(last_turn);

  // A provider-side failure — 401 on bad credentials, 429, a 5xx — arrives as a
  // terminal event whose `result` reads exactly like assistant text ("Invalid
  // API key · Fix external API key"), with `subtype` still "success" and an
  // `api_error_status` next to it. Left to flow on, that sentence reaches the
  // envelope parser, fails it, and spends every JSON-fix retry re-hitting the
  // same 401 before blaming the model for bad JSON. It is not model output, so
  // it does not get to look like some.
  const api_error = terminal?.api_error_status;
  if (api_error) {
    throw new Error(
      `claude request failed with HTTP ${api_error}: ${String(terminal?.result ?? "").trim()}`,
    );
  }

  if (result.returncode !== 0 && !result.text) {
    // A resume that never got as far as `system/init` means the transcript is
    // gone — Claude Code garbage-collects them after about 30 days. Say so by
    // name instead of silently minting a fresh session: this call may be the
    // third correction in a gate loop, and starting over with no context there
    // looks like the model suddenly forgetting the task.
    if (resume_uuid && !saw_init) {
      throw new Error(
        `claude could not resume session ${resume_uuid} (exit ${result.returncode}): ` +
          `${stderr.trim().slice(-400)}\nDelete ${marker_path} (or this agent's entry in ` +
          "agent_map.json) to start a fresh context.",
      );
    }
    throw new Error(`claude exited ${result.returncode}: ${stderr.trim().slice(-800)}`);
  }
  return result;
}
