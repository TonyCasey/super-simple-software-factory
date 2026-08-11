# Install

`/sssf install` — stamp the entire factory out of the skill and into the current working directory.

## Run it

```bash
bun .claude/skills/sssf/scripts/install.ts
```

Run from the **target repo root** — the cwd is where everything lands. If the skill lives in your user scope, the path is `~/.claude/skills/sssf/scripts/install.ts`.

## What gets stamped

`install.ts` copies `templates/` into the cwd:

| Stamped | From | Tracked? |
|---|---|---|
| `adws/adw_sssf_config/sssf.config.yaml` | `templates/sssf.config.yaml` | yes — the agent roster |
| `.env.sample` | `templates/env.sample` | yes |
| `adws/adw_*.ts` | `templates/adws/` | yes — the twelve starter ADWs |
| `adws/adw_modules/` | `templates/adws/adw_modules/` | yes — all low-level logic |
| `adws/package.json`, `adws/tsconfig.json` | `templates/adws/` | yes — the one dependency (zod) and the TS config |
| `adws/adw_data/prompt_engineering/{planner,builder,scout,reviewer,documenter}/` | `templates/prompt_engineering/` | yes — **the user-owned home for prompts** |
| `adws/adw_data/harness_engineering/` | `templates/harness_engineering/` | yes — **the user-owned home for pi extensions** |
| `justfile` | `templates/justfile` | yes — starter recipes: `just demo`, the workflows, the trace reads, `just obs` |
| `adws/adw_data/sessions/`, `adws/adw_data/sssf.db` | created at runtime | no — gitignored |

The two `*_engineering` dirs mirror the two config keys of the same name: `prompt_engineering` is what an agent is told, `harness_engineering` is what its harness can do. Both are yours the moment they are stamped. Edit them in `adws/adw_data/`, never back inside the skill.

`harness_engineering/` ships with `subagents.ts` — the pi extension backing `subagent_create` / `_continue` / `_list` / `_remove`, wired to the planner and scout in the starter roster.

## Idempotency

Re-running is safe. `install.ts` skips **every** file that already exists — your config, your prompts, and previously stamped code alike — and reports what it skipped, so a second run doubles as a drift check. To refresh stamped code (`adw_modules/`, the starter `adw_*.ts`) to the skill's current version, run with `--force` — but know that `--force` overwrites ALL existing stamped files, including `sssf.config.yaml` and `prompt_engineering/`, so commit or back up user-owned edits first.

## Post-install checklist

1. **Env** — `cp .env.sample .env`, then set `OPENROUTER_API_KEY` in `.env`. (v1 runs Pi; `ANTHROPIC_API_KEY` / `CLAUDE_CODE_PATH` are only needed once Claude Code lands in v2.)
2. **Pi is installed and on PATH** — `pi --version`. Set `PI_PATH` in `.env` if it is not.
3. **The model resolves** — the config's default `gemini-3.6-flash` must be a registered id in `~/.pi/agent/models.json`. Check with `pi --list-models` or read the file directly; see `references/config.md` for model resolution.
4. **Dependencies** — `install.ts` runs `bun install` inside `adws/` for you and reports `deps: ok`. If it says FAILED (no network at install time), run `cd adws && bun install` yourself; the ADWs import zod and will not start without it.
5. **Gitignore** — `install.ts` appends `adws/adw_data/sessions/`, `adws/adw_data/sssf.db*`, `.env`, and `adws/node_modules/` for you; confirm they landed. The first three are runtime or secrets, the fourth would otherwise be swept into the first commit phase's `git add -A`.
6. **Git repo** — ADWs that end in a commit phase call `git_helper.commit_all`, which throws if the cwd is not a git repository. Run `git init` and make a first commit before using `adw_plan_build.ts`, `adw_plan_build_test.ts`, or `adw_simple_sdlc.ts`. `adw_document.ts` needs one too: it measures the change with `git diff` against a base ref (`main` by default, `--base` to override).
7. **Smoke test** — `just demo` runs two cheap read-only workflows back to back, or run the smallest ADW directly:

```bash
just demo                                                    # both, end to end
bun adws/adw_prompt.ts "reply with a one-line summary of this repo"   # the raw form
```

Green means the whole path works: config validated, session minted, Pi ran, envelope parsed, events landed in `adws/adw_data/sssf.db`. Verify the trace exists before trusting anything larger:

```bash
sqlite3 adws/adw_data/sssf.db "select adw_id, status from sessions order by started_at desc limit 1;"
```

If the smoke test fails, fix it before composing chains — every multi-agent ADW rides on this exact path.
