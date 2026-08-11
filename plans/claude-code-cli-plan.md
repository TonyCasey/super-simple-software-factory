# Implement `agent_cc.ts` — the Claude Code coding agent for SSSF v2

## Context

SSSF v1 runs exactly one coding agent: Pi (`agent_pi.ts`, spawned as `pi -p --mode json`, JSONL tailed off stdout). The Claude Code agent was specced but never built — `agent_cc.ts` is a 14-line stub that throws, `agents.validate()` hard-rejects `coding_agent: claude_code` (`agents.ts:84-89`), and the docs promise it "lands in v2" (`references/config.md:45`, `sssf.config.yaml:2`, `SKILL.md:76`, `README.md:376`). The same stub existed in the Python v1 — it has never been implemented anywhere.

**Goal:** implement `agent_cc.ts` so factory agents run through the `claude` CLI, billed to a Claude Pro/Max subscription via OAuth (`claude login` or `claude setup-token`), not an API key. The architecture already fits perfectly: agents are CLI subprocesses streaming JSONL (no SDK anywhere; only runtime dep is zod), so this is a second adapter behind the same 4-symbol contract plus one dispatch seam in `agents.ts`. Nothing else changes — runner, session, permissions, gates, quality, tracer, all `adw_*.ts` entry scripts, and the visualizer are agent-agnostic (the UI already renders `coding_agent` and ships `/models/claude.png`).

## The contract (from `agent_pi.ts`)

```ts
export function resolve_model(pattern: string): [string, string];   // ["anthropic", model_id]
export function context_window(provider: string, model_id: string): number;
export class ToolCallTracker { observe(event): Record<string, any> | null }
export async function run(request: AgentRequest, on_event?, on_spawn?, on_exit?): Promise<AgentResult>;
```

`ToolCallTracker.observe` emits one record per completed tool call: `{tool, tool_call_id, args, ok, label, result_snippet?, started_at, ended_at, duration_ms?}` — verified against `agents.ts:_event_forwarder` (destructures `{label, started_at, ended_at, ...payload}`) and the visualizer's `shared/types.ts:216-222` (`result_snippet`/`duration_ms` explicitly optional).

## Verified Claude Code CLI facts (official docs)

- **Headless:** `claude -p --output-format stream-json --verbose` (`--verbose` required). Prompt via argv or stdin (≤10MB).
- **Events:** `system/init {session_id, model, tools}` → assistant messages (content blocks text/`tool_use` `{id,name,input}`, per-turn usage `{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`) → user messages carrying `tool_result {tool_use_id, content, is_error}` → terminal result `{result, session_id, usage, total_cost_usd, num_turns, is_error, subtype, modelUsage}`. Envelope shape varies by CLI version (`{"type":"assistant","message":{...}}` vs newer nested event wrapper) — normalize both. `modelUsage` is keyed by model id, not flat.
- **Sessions:** `--session-id` must be a valid UUID (SSSF ids `sssf-…` are not); `--resume <uuid>` continues; resume behavior (stable id vs fork) is version-dependent.
- **System prompt:** `--system-prompt` / `--system-prompt-file` (full replace) and `--append-system-prompt` both exist in `-p` mode.
- **Permissions:** default mode blocks in `-p` mode; `--permission-mode dontAsk` auto-denies non-allowlisted; `bypassPermissions` approves all. Tool names: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, ….
- **Thinking:** Claude 5-family / Opus 4.7+ → `--effort low|medium|high|xhigh|max`; 4.6-family → `MAX_THINKING_TOKENS` env.
- **Auth precedence** (highest first): Bedrock/Vertex env > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > subscription OAuth. So subscription billing requires scrubbing API-key vars from the child env. `--bare` disables subscription OAuth — never use it. `total_cost_usd` is a notional client-side estimate under subscription. Programmatic Pro/Max use is permitted.
- **Models:** aliases `fable|opus|sonnet|haiku|best|default`, full `claude-*` ids, `[1m]` context suffix. Exit codes 0/1/143.

## Design

**Invocation** (in `agent_cc.ts`, self-contained, mirrors `agent_pi.ts` structure; duplicate the small `_clip`/`_label`/`_text_of` helpers per the one-adapter-one-file pattern):

```
claude -p --output-format stream-json --verbose
--model <id> [--effort <mapped>]
--system-prompt-file <session_dir>/system_prompt.md
(--session-id <uuid> | --resume <uuid>)
[--allowedTools <mapped> --permission-mode dontAsk | --permission-mode bypassPermissions]
```

- Prompt rides stdin (`stdin: new Blob([prompt])` — definite EOF, no hang; the `agent_pi` stdin lesson was about inheriting the parent's TTY, which this is not). Removes the ~128KB `MAX_ARG_STRLEN` ceiling that correction prompts quoting diffs would blow. System prompt goes via `--system-prompt-file` written to the session dir (only one thing can ride stdin). Comment in the adapter says why this diverges from pi's argv delivery.
- Stream stdout line-by-line exactly like pi: raw line to `raw_output_path` first, then parse, normalize the version-dependent envelope shape once, accumulate, and forward the normalized event to `on_event`.
- Start draining stderr before the stdout loop (`new Response(child.stderr).text()`), await after — avoids the 64KB stderr-pipe deadlock latent in the pi adapter.
- Throw only on nonzero exit AND no text (pi parity). No `--max-turns`. An `is_error` result with empty result falls back to last assistant text, reproducing pi's failure envelope; corrections then resume the session.

### Sessions — SSSF id → UUID mapping with stream-refreshed markers

- Marker file `${request.session_dir}/${sssf_session_id}.json` holds "the UUID to resume next time".
- Marker absent → mint `crypto.randomUUID()`, pass `--session-id <uuid>`. Marker present → `--resume <uuid>`.
- Write/refresh the marker when `system/init` arrives (the session then verifiably exists, with its authoritative id) and again from the terminal result event's `session_id`. This survives both resume semantics (stable and fork-on-resume), keeps the correction/gate-retry sends inside one `execute()` chained correctly, and a first-spawn failure (no init event) leaves no marker so the retry re-creates.
- If `--resume` exits nonzero with zero events: throw an error naming the marker file ("delete it or the agent_map entry to start a fresh context") — never silently re-create mid-correction-loop. (Claude Code garbage-collects transcripts after ~30 days.)
- ADW-resume works unchanged via `agent_map.json`; a model switch already mints a fresh SSSF id (`agents.ts:330`) → no marker → create path.

### Auth (the actual subscription feature)

- New `claude_env()` in `utils.ts` beside `operator_env()` (whose docstring promises exactly this edit point): drop `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` (+ Vertex/Bedrock companions). `CLAUDE_CODE_OAUTH_TOKEN` passes through for headless/CI. Escape hatch: `SSSF_CC_USE_API_KEY=1` skips the scrub (also restoring `ANTHROPIC_BASE_URL` for proxy users).
- Note in `env.sample`: Bun auto-loads `.env` into `process.env`, and the scrub runs on the child env — an `ANTHROPIC_API_KEY` in `.env` for pi's other providers does NOT leak into `claude_code` runs.

### Models

`resolve_model` accepts aliases, full `claude-*` ids, `[1m]` suffix; strips `anthropic/` prefix; returns `["anthropic", id]`; throws on unrecognized AND on 4.6-family ids (clear "model too old for --effort" message — v2 scope is effort-capable models). Fails fast (cached) if `claude --version` fails, honoring `CLAUDE_CODE_PATH` (default `"claude"`, mirrors `PI_PATH`). `context_window`: static table (200k; 1M for `[1m]`), refined at runtime from the result event's keyed `modelUsage[<id>].contextWindow`.

### Tools

Map pi-flavored config names `{read→Read, bash→Bash, edit→Edit, write→Write, grep→Grep, find→Glob, ls→Glob}`, dedupe, always append `TodoWrite` (touches nothing in the repo; avoids denial noise). `tools: [...]` → `--allowedTools <mapped> --permission-mode dontAsk`; `tools: null` → `--permission-mode bypassPermissions` (pi parity — `permissions.ts` post-hoc enforcement is the real fence, "agent proposes, code disposes", verified hole-free: snapshot/enforce/rollback are pure git-vs-config). Document: unlike pi's `--tools`, denied CC tools are visible-but-denied, not hidden.

### Validation

In `agents.ts` `validate()`, fail-fast — not runtime warnings: for a `claude_code` agent, error on non-empty `harness_engineering` (pi extensions can't load; the starter planner/scout rosters carry `subagents.ts` + `subagent_*` tools, which would otherwise validate green and fail at runtime) and error on tool names outside the mapping table.

### Thinking

`off|minimal|low → low`, `medium|high|xhigh|max → same`, via `--effort`. Document "CC has no off; off ⇒ low" in `config.md`.

### Usage/cost

Per assistant turn, translate usage to pi's camelCase shape `{input, output, cacheRead, cacheWrite}` and call `UsageBreakdown.add_turn`; `context_tokens` = last assistant turn with nonzero usage (CC has no per-message `stopReason`). At the result event: `result.cost = total_cost_usd` AND `result.usage.total_cost += total_cost_usd` — without the latter, the `agent_end` trace payload and console banner show $0 while the session total doesn't. Per-component costs stay 0 (CC reports only a total). Document cost as notional under subscription (`env.sample` + `config.md` + one line in `observability.md` about mixed real/notional rosters).

### ToolCallTracker (CC variant)

`tool_use` blocks in assistant messages announce `(id, name, input` — starts the clock); `tool_result` blocks in user messages emit the record; `ok = !is_error`; `tool_result.content` is polymorphic (string OR block array) — handle both or `result_snippet` vanishes. `duration_ms` includes model latency between announce and execution (no `tool_execution_start` equivalent) — comment says so.

### Typing seam

Keep `PiRequest`/`PiResult` declarations canonical (wire-contract doctrine in `data_types.ts` header); add `export type AgentRequest = PiRequest`, `AgentResult = PiResult`, and a `CodingAgent` interface for the 4-symbol contract to type the dispatch map. `agent_cc.ts` uses the neutral aliases; one comment noting `session_dir`'s meaning shift (pi: sessions live there; cc: markers + `system_prompt.md` live there).

### Dispatch (`agents.ts`)

`const RUNNERS: Record<"pi"|"claude_code", CodingAgent> = {pi: agent_pi, claude_code: agent_cc}`. Delete the v1 rejection (84-89) in the same change as the new cc validation above; `validate()` line 99 → `RUNNERS[agent.coding_agent].resolve_model`; `execute()` line 161 session-dir seam → `"pi_sessions"` / `"cc_sessions"` by `coding_agent`; line 167 → `runner.run`; `_event_forwarder(run, phase, agent_name, runner)` constructs new `runner.ToolCallTracker()`.

## Known accepted behaviors (documented, not coded around)

Target-repo `CLAUDE.md` auto-loads into CC agents (and the documenter's `writes: ["**/*.md"]` includes it — worth a `config.md` sentence suggesting `CLAUDE.md` in `protected_files` for cc rosters, since an agent that edits it steers later agents); operator's `~/.claude` settings/hooks apply to child runs (check installed CLI for `--setting-sources` to exclude user-level hooks — verify at implementation time, not in the given facts).

## Implementation order

1. **`data_types.ts`** — add `AgentRequest`/`AgentResult` aliases + `CodingAgent` interface. Pure additions. Verify: `bun run typecheck` in `templates/adws/`.
2. **`utils.ts`** — add `claude_env()` (delegates to `operator_env()`, applies scrub list, honors `SSSF_CC_USE_API_KEY=1`).
3. **`agent_cc.ts`** — the full adapter (structure-checked against `CodingAgent` via a `satisfies`/const check). Verify standalone before wiring: drive `run()` directly with `bun -e` and a hand-built request against a scratch dir, prompt reply with `{"ok":true}` on haiku — check `raw_output.jsonl`, marker file, result fields; second call with the same SSSF session id must flip to `--resume` and remember turn one.
4. **`agents.ts`** — dispatch map + validation swap (one commit with step 3's adapter — never route to a half-built adapter or delete the rejection without the `harness_engineering` guard).
5. **Config/docs** — `templates/sssf.config.yaml` (header line 2 + commented `claude_code` example agent: no `harness_engineering`, mapped-vocabulary tools only); `templates/env.sample` (`CLAUDE_CODE_PATH`, `CLAUDE_CODE_OAUTH_TOKEN`, scrub/`.env` note, `SSSF_CC_USE_API_KEY`); `references/config.md` (:45, :49, :88, :200 + `CLAUDE.md` note); `references/observability.md` (notional-cost line); `SKILL.md:76`; `README.md:151, :376`; `cookbooks/install.md:39` (currently says `ANTHROPIC_API_KEY` is needed for v2 — wrong for subscription; flip to "run `claude login` or `claude setup-token`; do NOT put `ANTHROPIC_API_KEY` in `.env` if you want subscription billing"); `cookbooks/create_config.md:21`; `cookbooks/sssf_overview.md:26, :40`; `cookbooks/update_modules.md:17`.

## Collision note

`plans/extend-sssf-ticket-ship-pr-watch-exe-dev.md` (approved, unimplemented) also edits `data_types.ts`, `sssf.config.yaml`, `env.sample`, `justfile`. Land this adapter first or rebase carefully.

## Verification (end-to-end)

- `bun run typecheck` in `templates/adws/` (strict tsc, `noUnusedLocals`/`Parameters`).
- Regression: run an existing pi ADW unchanged.
- Stamp a scratch repo via `scripts/install.ts`; flip one agent to `coding_agent: claude_code`, `model: sonnet`; run `bun adws/adw_prompt.ts "<trivial prompt>"`. Confirm: streaming `tool_call` events land in the tracer/db while the run is live (`name=label`, `args`/`ok`/`result_snippet` payloads); envelope parses; `agent_sessions` row has nonzero `context_tokens`/`context_window`; `agent_end` payload cost is nonzero; `raw_output.jsonl` fills live.
- Force a gate failure (temporary always-fail gate) to exercise the correction → `--resume` path; confirm the model retains prior context.
- Subscription-auth proof: with `ANTHROPIC_API_KEY=sk-invalid` in `.env`, the `claude_code` run still succeeds (scrub worked, OAuth billed); with `SSSF_CC_USE_API_KEY=1` it fails (escape hatch works).
