# Config Reference

The full `sssf.config.yaml` spec: every field, how defaults merge, and how model / thinking / tools / extensions map onto the coding agent.

It lives at **`adws/adw_sssf_config/sssf.config.yaml`** — the default path every `adw_*.ts` and the justfile resolve, and where `install.ts` / `make_config.ts` stamp it. Pass `--config <path>` to any ADW (or set `SSSF_CONFIG` for the justfile) to run against a different roster.

## Shape

```yaml
defaults:
  coding_agent: claude_code             # or `pi`
  model: sonnet                         # claude_code: alias or claude-* id
  thinking: medium
  harness_engineering: []
  tools: [read, bash, edit, write, grep, find, ls]
  data_dir: adws/adw_data

observability:
  db: adws/adw_data/sssf.db
  poll_ms: 500

agents:
  - name: planner
    model: fable                        # inherits coding_agent: claude_code
    thinking: high
    color: "#a78bfa"
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user: adws/adw_data/prompt_engineering/planner/user.md
    tools:
      - read
      - bash

  - name: challenger                    # a pi agent in the same roster
    coding_agent: pi
    model: openai/gpt-5.6-terra         # pi: ALWAYS provider/model-id
    thinking: high
    purpose: Review the build from outside the Claude family.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/challenger/system.md
      user: adws/adw_data/prompt_engineering/challenger/user.md
    harness_engineering:                # pi only
      - adws/adw_data/harness_engineering/subagents.ts
    tools:
      - read
      - bash
```

The starter roster `install.ts` stamps is subscription-billed across two CLIs — `fable` planner, `sonnet` builder and documenter and `haiku` scout on `claude_code`, plus a `gpt-5.5` reviewer on `codex` — so a fresh install needs `claude login` **and** `codex login`, and no API key at all. The `challenger` above ships commented out; uncomment it to add a third provider on pi.

## Fields

### `defaults`

| Field | Type | Meaning |
|---|---|---|
| `coding_agent` | `pi` \| `claude_code` \| `codex` | Which interface runs the agent. `pi` runs `pi -p --mode json` (`agent_pi.ts`); `claude_code` runs the `claude` CLI on the operator's **Claude Pro/Max subscription** (`agent_cc.ts`) — see [Claude Code agents](#claude-code-agents). |
| `model` | string | Model id. For Pi, any id registered in `~/.pi/agent/models.json`. For Claude Code, an alias (`opus`, `sonnet`, `haiku`, `fable`, `best`, `default`), a full `claude-*` id, or either with a `[1m]` long-context suffix. Default `sonnet`. |
| `thinking` | enum | Reasoning effort — see below. Default `medium`. |
| `color` | hex string | Lane color for every agent that does not set its own. Default empty — the visualizer falls back to its own palette. |
| `harness_engineering` | list[string] | Pi extension file paths. **Pi only** — a `claude_code` agent with a non-empty list fails `validate()` before anything spawns. |
| `tools` | list[string] | Roster-wide tool allowlist. Every agent that omits its own `tools` inherits this. Unset = all tools usable. |
| `protected_files` | list[string] | Paths **no** agent may modify unless it names them in its own `writes`. Default: `adws/adw_modules/`, `adws/adw_sssf_config/`, `adws/adw_*.ts` — an agent must not be able to edit the machinery that decides whether its work passed. |
| `data_dir` | path | Runtime home. Sessions land at `{data_dir}/sessions/{adw_id}/{agent_name}/`. Default `adws/adw_data`. |

### `observability`

| Field | Type | Meaning |
|---|---|---|
| `db` | path | SQLite trace db. `tracer.ts` writes it directly; the visualizer polls it. Default `adws/adw_data/sssf.db`. |
| `poll_ms` | int | Visualizer live-poll cadence in ms. History uses the same queries, lazy-paged. Default `500`. |

### `agents[]`

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The identifier ADW scripts use. **ADWs name agents, never models.** |
| `purpose` | yes | One sentence: what this agent is for. Should match its `system.md` Purpose. |
| `prompt_engineering.system` | yes | Path to the system prompt — who the agent is, its single purpose, its output contract. |
| `prompt_engineering.user` | yes | Path to the default user prompt — the task template with `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`. |
| `color` | no | Hex swatch (`"#a78bfa"`) for this agent's lane in the visualizer. Travels config → `agent_sessions.color` → `/api/sessions/:adw_id`, and rides the `agent_start` event so a lane is colored while the agent is still running. Unset = the UI's fallback palette. |
| `coding_agent`, `model`, `thinking`, `color`, `harness_engineering` | no | Override the corresponding `defaults` key. |
| `tools` | no | Allowlist. **Omitting the key means all tools usable.** A capability list, not a boundary — see `writes`. |
| `writes` | no | What this agent may modify **in the repo**, enforced after every call. Omitted = unrestricted (still barred from `protected_files`). `[]` = no repo writes at all. A list = only those paths: a trailing `/` is a directory prefix, `*` matches within one path segment, `**` crosses segments, anything else is an exact path. Naming a `protected_files` path here is what unlocks it. **The session runtime under `data_dir` is always writable** — `writes: []` means read-only with respect to the repo, not unable to write its own report. |

Output types are deliberately absent: config defines who an agent *is*; the ADW call site defines how it's *used*. One agent serves many calls — same system prompt, different user prompt + output type per call.

## Defaults merging

`agents.ts` merges each entry **over** `defaults`, key by key. An entry states only what differs; anything unset inherits. `agents.validate(cfg, REQUIRED_AGENTS)` then confirms every name an ADW declares exists, resolves to a usable coding agent + model, and has both prompt files present on disk. Any miss fails the run immediately — **no agent is ever spawned against a half-valid config.**

## Thinking levels

Pi's reasoning-effort ladder, lowest to highest:

```
off | minimal | low | medium | high | xhigh | max
```

Mapped to Pi's reasoning effort control and honored when the model is registered with `reasoning: true` in `~/.pi/agent/models.json`. On a non-reasoning model the setting is inert — no error, no effect. Rough guidance: `high`/`xhigh` for planners and reviewers, `medium` for builders, `low` for mechanical read-and-report agents.

On Claude Code the same field becomes `--effort`, one rung per name, with one wrinkle: **Claude Code has no `off`**, so `off` and `minimal` both map to `low`. An agent you meant to run without thinking still thinks a little.

## Model resolution

**This section is about `coding_agent: pi` agents.** Claude Code models are checked by shape, not against a catalog — see [Claude Code agents](#claude-code-agents) above.

**For pi, always write `model` as `provider/model-id`.** `agents.ts` hands the string to the Pi interface, which resolves it against pi's merged catalog — `~/.pi/agent/models.json` plus pi's built-in providers. The same model is usually carried by more than one provider (`gemini-3.6-flash` lives under `google` *and* under `openrouter` as `google/gemini-3.6-flash`), and a bare id that matches several **throws at resolution**:

```
agent 'scout': model pattern 'gemini-3.6-flash' is ambiguous:
  [('google', 'gemini-3.6-flash'), ('openrouter', 'google/gemini-3.6-flash'), ...]
```

That is `agents.validate()` doing its job — it fails before anything spawns rather than silently billing the wrong provider — but it means every agent in the roster inheriting that default is grounded until the pattern is qualified. Qualifying is the whole fix: `google/gemini-3.6-flash`, `openai/gpt-5.6-terra`, `fireworks/accounts/fireworks/models/kimi-k3`. The leading segment is matched against the provider list first, so the rest of the string can contain slashes.

Other consequences worth knowing:

- A model must be in the catalog before any agent can name it. An unknown id fails at resolution, before spawn. `pi --list-models` is the catalog the resolver actually reads.
- **Ambiguity can appear without you touching the config.** Registering a new provider that carries a model you already use turns a formerly-fine bare pattern ambiguous. If a roster stops validating and nobody edited it, that is why.
- Provider credentials come from the environment, not the config — the key that matches the provider you named (`GEMINI_API_KEY` for `google/...`, `OPENROUTER_API_KEY` for `openrouter/...`).
- The resolved model is recorded per session in `agent_map.json` and mirrored into the `agent_sessions` table. **Changing an agent's model invalidates its session**: a joined run starts that agent fresh instead of resuming a context window built by a different model.

## Claude Code agents

`coding_agent: claude_code` runs the agent through the `claude` CLI
(`claude -p --output-format stream-json --verbose`) instead of pi. Everything
downstream is unchanged — same envelopes, same gates, same `writes` enforcement,
same live tool-call stream in the trace and the visualizer.

**Billing is the reason it exists.** These agents run on the operator's Claude
Pro/Max **subscription**: authenticate once with `claude login`, or
`claude setup-token` for a headless box. To keep that true, `agent_cc.ts`
launches the CLI through `claude_env()`, which strips every credential that
outranks subscription OAuth in Claude Code's precedence order —
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the
Bedrock/Vertex switches. Bun loads `.env` into the process environment, so
without that scrub an `ANTHROPIC_API_KEY` you set for a *pi* agent's provider
would quietly move every Claude Code agent onto metered API billing. Set
`SSSF_CC_USE_API_KEY=1` if that is what you actually want.

Consequences of the scrub, and of the CLI's own behavior:

- **Subscription runs report `cost: 0.00`.** The CLI emits a `total_cost_usd`
  estimate of API-equivalent prices, but nothing was billed per token, so the
  factory suppresses it — `cost` means money actually charged, and a run total
  must not mix real dollars with imaginary ones. The decision uses the child's
  own `apiKeySource`, so opting into `SSSF_CC_USE_API_KEY=1` reports real spend
  in full. Token counts are exact either way; see `references/observability.md`.
- **`harness_engineering` must be empty.** pi extensions cannot load here, and
  `validate()` says so before anything spawns.
- **The target repo's `CLAUDE.md` auto-loads** into every Claude Code agent, the
  same as an interactive session. That is usually welcome — and it means an
  agent that can *edit* `CLAUDE.md` is editing the instructions later agents
  receive. The starter documenter's `writes` includes `**/*.md`, which covers
  it. Add `CLAUDE.md` to `defaults.protected_files` on a Claude Code roster
  unless you specifically want agents steering each other.
- **Operator settings are excluded by default.** The child loads
  `--setting-sources project,local`, so the personal hooks and output styles in
  your `~/.claude` do not change how a factory run behaves. Set
  `SSSF_CC_SETTING_SOURCES=user,project,local` to opt back in.
- **Missing credentials fail at startup.** `validate()` asks `claude auth status` once per run (only when the roster actually has a `claude_code` agent), under the same scrubbed environment the agents get. A container where the secret never got injected fails before anything spawns. The check is presence-only — an expired or malformed token still passes it and then fails on the first request with a named `HTTP 401`.
- **Sessions are mapped, not shared.** SSSF session ids are not UUIDs and
  `claude --session-id` requires one, so each agent's session dir holds a marker
  file pairing them. Delete the marker (or the agent's entry in
  `agent_map.json`) to force a fresh context. Claude Code garbage-collects
  transcripts after roughly 30 days; a resume that finds nothing fails loudly
  and names the marker rather than silently starting over mid-correction.

## Codex agents

`coding_agent: codex` runs the agent through `codex exec --json` on the
operator's **ChatGPT subscription** (`codex login`). It exists to break the
monoculture: a reviewer drawn from the same family as the builder shares its
blind spots, and this is the roster's cheapest way out of that.

- **Models are allowlisted, not shape-checked.** A ChatGPT plan serves a
  narrower set than the API does — `gpt-5.4` and `gpt-5.5` work; `gpt-5.2` and
  other older ids are accepted by the CLI and then **fail the turn after the
  session has opened**, mid-phase. `resolve_model` rejects them at `validate()`
  instead. Extend `SUBSCRIPTION_MODELS` in `agent_codex.ts` as plans change.
- **`writes` is enforced exactly as elsewhere** — by `permissions.ts`, after the
  call. Codex has sandbox modes rather than per-tool switches, and it is tempting
  to map `writes: []` onto `--sandbox read-only`; don't. Read-only also blocks
  the agent writing its own report into the session runtime, which SSSF
  guarantees every agent can always do, so a read-only reviewer fails its phase
  saying it could not write. Neither narrowing works either: `--add-dir` grants
  nothing under `read-only`, and `sandbox_workspace_write.writable_roots` only
  *adds* to an already-writable workspace, so it cannot subtract the repo. Every
  codex agent therefore runs `workspace-write`.
- **`tools` is inert here.** There is no per-tool allowlist to map it onto. The
  list still documents intent and still binds verbatim if you move the agent to
  pi or claude_code, but on codex nothing reads it.
- **No cost data.** `turn.completed` counts tokens and reports no dollars, so a
  codex agent's cost is always `$0.0000` and a mixed roster's run total omits it
  silently. Token counts are exact.
- **The system prompt is a user-turn preamble.** Codex has no system-prompt flag;
  overriding `base_instructions` would replace the built-in agent prompt that
  teaches it `apply_patch` and sandbox etiquette, and `AGENTS.md` is repo-wide
  when several agents share a repo. `agent_codex.ts` prepends `system.md` to the
  prompt on stdin instead, separated by a rule.
- **No API-key scrub is needed.** Unlike Claude Code, an `OPENAI_API_KEY` in the
  environment does **not** displace the ChatGPT login — verified against a live
  run — so there is no `codex_env()` and nothing to opt out of.
- **Operator config is excluded.** Runs pass `--ignore-user-config`, so a
  personal `~/.codex/config.toml` (often `sandbox_mode = "danger-full-access"`)
  cannot change how the factory behaves. Auth is unaffected; it lives in
  `CODEX_HOME`, not the config file.
- **Missing credentials fail at startup**, like claude_code: `validate()` runs
  `codex login status`, whose exit code is a clean 0/1 signal. Presence, not
  validity — an expired session passes and fails on the first request.

## Tools

`tools` maps to `pi --tools`. Pi's seven builtin tool names:

| Tool | Purpose | Pi's own default |
|---|---|---|
| `read` | read file contents | on |
| `bash` | execute bash commands | on |
| `edit` | find/replace edits | on |
| `write` | create/overwrite files | on |
| `grep` | search file contents | **off** |
| `find` | find files by glob | **off** |
| `ls` | list directory contents | **off** |

`grep`, `find`, and `ls` are off in bare Pi, so an agent that does not name them will shell out through `bash` to do the same work. The starter roster therefore sets `defaults.tools` to all seven and lets each agent narrow from there.

**Resolution order:** an agent's own `tools` list wins; an agent that omits the key inherits `defaults.tools`; if neither is set, `tools` stays `None` and all tools are usable. An empty list is not "all tools" — it is a tool-less agent, and it will stall.

**On Claude Code** the same seven names are translated to that CLI's tools and
passed as `--allowedTools`, so one roster reads the same whichever interface
runs it:

| SSSF | Claude Code |
|---|---|
| `read` | `Read` |
| `bash` | `Bash` |
| `edit` | `Edit` |
| `write` | `Write` |
| `grep` | `Grep` |
| `find` | `Glob` |
| `ls` | `Glob` |

`find` and `ls` share `Glob` because Claude Code has no separate
directory-listing tool; naming both is harmless. `TodoWrite` is appended to
every allowlist — it touches nothing in the repo, and omitting it only fills the
trace with denials. A name outside this table (a pi extension's tool, say) fails
`validate()` rather than quietly dropping out of the allowlist.

Two differences from pi are worth knowing. Pi's `--tools` **hides** everything
unlisted; Claude Code's allowlist leaves the rest **visible but denied**, so the
model can still try a tool it does not have and be refused. And `tools: null`
("all tools") becomes `--permission-mode bypassPermissions` — which is the same
posture as pi with no `--tools` flag, and the same reason it is safe: the real
fence is `permissions.ts` diffing the tree after every send, not the tool list.

## Write permissions — `writes` and `protected_files`

`tools` cannot express a safety boundary, because two of the tools are general
purpose. `bash` runs anything, including `git checkout`, which discards an
engineer's uncommitted work; `write` reaches any path, not only the one report
file an agent was granted it for. So "this agent changes nothing" is a claim a
tool list can state but never keep.

`adw_modules/permissions.ts` keeps it, the same way every other claim in this
system is kept — after the fact, against the repo. Before an agent's first
prompt the working tree's change-set is fingerprinted; after its last send
(including JSON retries and gate corrections) it is fingerprinted again. Any
path that appeared, vanished, or changed is attributed to that agent.

Comparing change-sets rather than watching writes is deliberate: a path that was
modified before the agent ran and is clean afterwards has been **reverted**, and
a reversion is a modification. That is what catches `git checkout`.

A breach is not a gate violation. Gates are for work an agent can be asked to
redo; a write has already happened, so re-prompting fixes nothing. Instead:

1. every unauthorized change the agent **introduced** is rolled back — tracked
   files with `git checkout --`, untracked files by deletion;
2. a path that was **already dirty** before the agent ran is left untouched. The
   operator had uncommitted work there, and discarding it to tidy up would be
   the same harm this module exists to prevent;
3. the phase fails and names every path with what happened to it.

```yaml
defaults:
  protected_files: [adws/adw_modules/, adws/adw_sssf_config/, "adws/adw_*.ts"]

agents:
  - name: builder      # no `writes` key -> unrestricted, minus protected_files
  - name: scout
    writes: []         # no repo writes; its findings still land in context_handoff/
  - name: planner
    writes: [specs/]
  - name: documenter
    writes: [app_docs/, docs/, "**/*.md", "*.md"]
```

**The session runtime under `data_dir` is always writable, for every agent.**
`context_handoff/` is how agents hand work to each other, and each agent's
prompts, `raw_output.jsonl`, and `envelope.json` sit beside it. That grant comes
from `data_dir` rather than from `.gitignore`: the runtime is normally ignored,
so it never even appears in a snapshot, but an agent's ability to record its own
work must not depend on a gitignore line someone can delete.

Narrow by role, not by reflex. Anything that must produce a `context_handoff/` artifact needs `write`, or it will resort to a `bash` heredoc. Withhold `edit`/`write` only where the restriction *is* the guarantee — a reviewer that cannot edit cannot quietly fix what it was asked to report.

### Extension tools must be named explicitly

`pi --tools` is an allowlist over **built-in, extension, and custom tools alike** — not just builtins. So the moment an agent has a `tools` list at all (its own, or one inherited from `defaults`), any tool registered by its `harness_engineering` extensions is **excluded unless it appears in that list by name**.

This fails quietly. The extension still loads, the run still succeeds, and the tool the extension exists to provide is simply never offered to the model — you find out by noticing the agent never called it.

```yaml
  - name: reviewer
    harness_engineering:
      - .pi/extensions/ast_query.ts     # registers tool: ast_query
    tools:
      - read
      - grep
      - find
      - ls
      - bash
      - ast_query                       # REQUIRED — the extension's tool, named or lost
```

Rule: **every entry in `harness_engineering` that registers a tool must have that tool name added to the agent's `tools` list.** Adding an extension is therefore a two-line change, never one. The alternative is dropping the `tools` key *and* leaving `defaults.tools` unset so the agent resolves to `None` (all tools) — but with a roster-wide `defaults.tools` in place, that escape hatch is closed; naming the tool is the only path.

## Harness engineering

`harness_engineering` entries are pi extension **file paths**, passed through as `pi -e <path>`, one flag per entry, scoped to that agent only. This is where per-agent harness changes live — e.g. an output-tightening extension for an agent that keeps wrapping its envelope in prose. The starter roster ships with none. **Pi only:** a `claude_code` agent that carries entries here fails `validate()` with the list quoted back at it, rather than loading nothing and failing later for a reason nobody can see.

**If the extension registers a tool, name that tool in the agent's `tools` list too** — `--tools` filters extension tools exactly like builtins, so an unnamed extension tool is silently unavailable no matter that the extension loaded fine. See [Extension tools must be named explicitly](#extension-tools-must-be-named-explicitly) above. Extensions that only shape output or add flags (no tool registration) need no `tools` change.
