# Extend SSSF: ticket-ship + pr-watch ADWs, multi-tool tickets, exe.dev remote runs

## Context

Tony has two harnesses today:

- **SSSF** (`/Users/tony.casey/Tools/super-simple-software-factory`) — a TypeScript/Bun control plane stamped into target repos by `install.ts`. Deterministic ADW scripts own sequencing, retries, gates, and acceptance; coding agents (pi) are bounded nodes inside phases; everything is traced to `sssf.db` + visualizer. It has **zero** support today for ticket tools, PRs/remote git, polling loops, or remote execution.
- **agent-harness** (`fieldwork-api/.claude`) — markdown/prompt-driven workflows. Its two most-used, **ticket-ship** (ticket → implement → test → cross-model review → draft PR → close-out, 4 gates) and **pr-watch** (poll PR comments, fix, reply, resolve, re-request reviewers), encode excellent process but enforcement is prompt-convention only.

Goal: make SSSF the single harness by porting those two workflows as deterministic ADWs, and add **exe.dev** (SSH-controlled Ubuntu VMs: `ssh exe.dev new/ls/rm --json`, rsync file transfer) so runs execute headless on remote VMs.

### Decisions (user-confirmed)

1. **Tickets**: ClickUp first-class; Jira, Linear, GitHub Issues behind the same abstraction.
2. **exe.dev**: full remote runs — whole ADW runs dispatch to a VM; laptop dispatches + observes.
3. **Location**: everything in SSSF `templates/` so every stamped repo gets it (auto-picked-up by `install.ts` since it copies `templates/adws/` + `templates/prompt_engineering/` recursively).
4. **pr-watch**: detached daemon, tapered idle polling 2m → 5m → 15m → 60m (taper advances on idle cycles, resets to 2m on activity), hard cap 5 hours per watch.

Known agent-harness bugs are NOT ported: hardcoded `staging` base branch (resolve from repo default), `.local` template fallback bug, missing `CLICKUP_TEAM_ID` env key.

All paths below are under `.claude/skills/sssf/` in the SSSF repo.

---

## Part 1 — Shared plumbing (adw_modules)

### `templates/adws/adw_modules/data_types.ts` (modify)
- Domain interfaces: `ProjectTool` enum (`clickup|jira|linear|github`), `Ticket {tool,id,url,title,description,status,labels,raw}`, `PrState {number,url,state,is_draft,base_ref,head_ref,title,labels,author}`, `ReviewThread {thread_id,comment_id,author,body,path,line,is_resolved}`.
- New envelope types via the existing `outputType()` pattern:
  - `ClarityOutput` — `clear: bool`, `classification: bug|feature|chore`, `questions: string[]` (non-empty iff `!clear`).
  - `PrReviewOutput` — `approved: bool`, `findings: [{severity: blocking|suggestion|nitpick, file, note}]`.
  - `CommentTriageOutput` — `items: [{thread_id, comment_id, author, kind: fix|reply|clarify, reply, fix_instruction}]`.
- Extend `BuildOutput` with `rebuttals: [{finding, action: fixed|rebutted, response}]` (defaults `[]` → zero breakage for existing ADWs/prompts).
- Config schema: `SSSFConfigSchema` gains three `.prefault({})` blocks:
  - `project: {tool, key, base_url, pr_label (default "TEST"), statuses: {todo,in_progress,in_review,done,needs_info}}` (generic ladder → per-tool status names)
  - `remote: {vm_prefix (project slug, e.g. "solv-platform"; default repo name), cpu, memory, disk, repo, sync_interval_s, preview_cmd (default [])}`
  - `pr_watch: {taper_s: [120,300,900,3600], cap_hours: 5}`

### `templates/adws/adw_modules/tickets.ts` (new)
`TicketDriver` interface: `fetch(id)`, `comment(id, body)`, `statuses(id)` (fetched, never guessed), `set_status(id, status)`, `url(id)` (ClickUp `/t/ID`, Jira `/browse/ID`, Linear `/issue/ID`, GitHub `#N`). Plus:
- `validate(cfg)` — fail fast on missing tool-specific env keys (`ConfigError`); probes CLIs with `--version` where used.
- `normalize_ref(raw, cfg)` — bare `N` → `${key}-${N}` for Jira/Linear; pass-through for ClickUp custom IDs / GitHub.
- `transition(cfg, id, generic)` — maps via `cfg.project.statuses`, fetches valid statuses first, walks multi-hop when a direct jump is rejected, returns hops; if a mapped status doesn't exist (e.g. no "needs info"), warn + comment-only fallback.
- `mirror_failure(cfg, id, stage, detail)` — every ADW stop posts a ticket comment.
- All mutating calls honor `SSSF_DRY_RUN=1` (log intent, don't write).

Drivers: **ClickUp** (REST; ALWAYS `?custom_task_ids=true&team_id=$CLICKUP_TEAM_ID`; comments via `{comment_text}` or structured array for @mentions; statuses from `GET /list/$CLICKUP_LIST_ID`), **Jira** (`jira` CLI), **Linear** (`linear` CLI), **GitHub Issues** (`gh`; status = labels, documented).

### `templates/adws/adw_modules/github.ts` (new)
Remote git + PR ops (`git_helper.ts` stays local-only by contract): `repo_info()` (`gh repo view --json` → default branch), `fetch_ref`, `push(branch)`, `create_draft_pr({base,title,body,labels})`, `pr_view(ref)`, `verify_pr(pr, expect)` (**Gate 4 as code** — throws listing every mismatch: isDraft, base, `[TICKET] - ` title, label), `unresolved_threads(pr)` (GraphQL reviewThreads), `reply_inline`, `resolve_thread` (GraphQL `resolveReviewThread`), `request_review`, `normalize_reviewer` (Copilot → `copilot-pull-request-reviewer[bot]`), `pr_body({ticket,...})` (body with `## Linked Issues` using `tickets.url()`), `ensure_worktree(branch, repo_root)` (create/reuse sibling worktree, NEVER switch the user's checkout). Honors `SSSF_DRY_RUN`.

### `templates/adws/adw_modules/gates.ts` (modify — add 4)
`clarity_consistent` (clear=false ⇒ questions non-empty; clear=true ⇒ none), `pr_verdict_consistent` (approved ⇔ zero blocking findings), factory `triage_covers(thread_ids)` (every unresolved thread covered exactly once), factory `rebuttals_cover(blocking)` (every blocking finding fixed OR rebutted — never silently dropped).

### `templates/adws/adw_modules/git_helper.ts` (modify)
Add `checkout(ref)` and `branch_from(name, start)` (`git checkout -B name start`). Still local-only.

### `templates/adws/adw_modules/watch.ts` (new)
`stop_file(cfg, pr)` → `{data_dir}/pr_watch/stop-{pr}`; `stop_requested(cfg, pr)`; `class Taper(schedule_s)` (`next()`, `reset()`; last entry repeats); `class WatchState` persisted at `{session_dir}/pr_watch_state.json` — `rerequested: Set<login>`, `replied_comment_ids`, `taper_index`, `started_at` (5h cap survives crash-resume via `--adw-id` join).

### `templates/adws/adw_modules/exe_dev.ts` (new)
All via `ssh exe.dev ...` / `ssh <vm>` / rsync with `operator_env()`: `ls()`, `ensure_vm(name, cfg.remote)` (reuse by name — persistent disk = warm re-dispatch), `rm`, `sh(vm, cmd)`, `rsync_to/from`, `provision(vm)` (idempotent marker file; git/jq/sqlite3/bun/just/gh/pi; `bun install` in `adws/`), `push_secrets(vm, dir)` (`.env` + `~/.pi/agent/models.json` + pi auth), `clone_repo(vm, owner/name, dir)` (via `GH_TOKEN`), `run_detached(vm, dir, cmd, log)` (`setsid nohup ... & echo $!`), `remote_session_status(vm, dir, adw_id)` (sqlite3 query over ssh), `sync_db_back(vm, dir, local)` — **WAL-safe: remote `sqlite3 ".backup"` then rsync** to `adws/adw_data/remote/<vm>/sssf.db`, which the existing visualizer opens via `SSSF_DB` (chosen over port-forwarding, which dies with the terminal).

---

## Part 2 — New agents (synced triad: config entry + prompt dir + output type at call site)

Add to `templates/sssf.config.yaml` roster + `templates/prompt_engineering/<name>/{system,user}.md`, each `user.md` with a `## Report` JSON block mirroring its output type exactly:

1. **`triager`** → `ClarityOutput`. `writes: []`. Reads ticket JSON + scans repo; if an engineer couldn't implement without asking, emits concrete questions (posted verbatim to the ticket — never guess); classifies bug/feature/chore. Cheap model, `thinking: high`.
2. **`pr_reviewer`** → `PrReviewOutput`. `model: openai/gpt-5.6-terra`, `writes: []`. Reviewer with severity-classified findings; approve iff zero blocking. Cross-model vs builder is inherent — replaces the harness's codex gate. (New agent, not reuse of `reviewer`, because `reviewer/user.md` is triad-bound to `ReviewOutput`.)
3. **`comment_triager`** → `CommentTriageOutput`. `writes: []`. Classifies each unresolved thread from `<context_handoff_dir>/pr_threads.json` as fix/reply/clarify, drafts inline replies + precise fix instructions.
4. **`builder/user.md`** (modify): when `previous_envelope` carries review findings, every blocking finding must appear in `rebuttals` as fixed (what changed) or rebutted (the argument) — enforced by `rebuttals_cover`.

---

## Part 3 — `templates/adws/adw_ticket_ship.ts` (new)

`REQUIRED_AGENTS = ["triager","planner","builder","pr_reviewer"]`, `MAX_FIX_LOOPS = 3`, `MAX_REVIEW_ROUNDS = 2`. CLI: positional ticket ref, `--config`, `--adw-id`, `--base`, `--dry-run` (sets `SSSF_DRY_RUN=1`). Local helper `stop(stage, detail)` = `tickets.mirror_failure(...)` then `run.finish(false, detail)` — every stop is mirrored to the ticket.

Phases (each body = 1–2 module calls, thin-ADW rule):
1. `request` (engineer) — log ref, flags, baseline sha.
2. `detect` (code) — `tickets.validate`; `github.repo_info()`; base = `--base ?? default_branch`; `normalize_ref`.
3. `fetch_ticket` (code) — `driver.fetch(id)` → `context_handoff/ticket.json`; build `ticket_prompt`.
4. `triage` (triager, retries 1, gates `[clarity_consistent, artifacts_exist]`).
5. **GATE 1**: `!triage.clear` → comment questions, `transition(needs_info)`, `run.finish(false, "needs-info")`. Never guess.
6. `branch` (code) — `fetch_ref(base)`; `branch_from(id, "origin/"+base)` — branch named exactly the ticket id.
7. `start_ticket` (code) — `transition(in_progress)`, log hops.
8. `plan` (planner, `PlanOutput`) + `commit_plan` (code, adw_simple_sdlc's commit helper).
9. `build` (builder, `BuildOutput`, `diff_matches_claims`); prompt directive per classification: bug → failing test FIRST; feature → test stubs alongside.
10. **GATE 2 loop** (×3): `test_i` (code, `quality.run_tests`) / `fix_i` (builder, `previous: quality.as_envelope(...)`, prompt: "repair the code, never the assertions"). Still red → `wip_push` (code, `github.push(id)`) + `stop("tests", tail)` — WIP preserved, ticket told.
11. **GATE 3 loop** (×2): `review_i` (pr_reviewer, gates `[pr_verdict_consistent, artifacts_exist]`) / `revise_i` (builder, gates `[diff_matches_claims, rebuttals_cover(blocking)]`); `retest` (code) if revised. Unapproved after rounds → wip-push + `stop("review", blocking list)`.
12. `commit_build` (code) → `push` (code) → `create_pr` (code, `create_draft_pr` with `[${id}] - ` title, `pr_label`, `pr_body`).
13. `pr_gate` (code) — **GATE 4** `verify_pr`.
14. `handoff` (code) — `transition(in_review)`, comment PR link on ticket, `context_handoff/ship_summary.md`; `run.finish(true)`.

## Part 4 — `templates/adws/adw_pr_watch.ts` (new, detached daemon)

One long-lived process = one Run/session. **Cycles are numbered code phases** (`poll_k` …); sleeps happen BETWEEN phases so the trace shows instant polls; next wake logged. Detachment via justfile `nohup … & disown` — survives closing the Claude session; polite stop = stop-file; `session.ts`'s SIGTERM handler already finalizes the trace on kill; `--adw-id` + `WatchState` give crash-resume.

`REQUIRED_AGENTS = ["comment_triager","builder"]`. Flags: positional PR number, `--config`, `--adw-id`, `--once` (single cycle — the debug/test mode).

1. `request` — log PR, taper schedule, cap.
2. `resolve_workdir` (code) — on PR head branch already? use checkout; else `ensure_worktree` + `process.chdir`. Config paths (`data_dir`, `observability.db`) absolutized against origin repo BEFORE `session.ensure` (new small `utils.absolutize_config`) so the trace stays in the origin repo's `sssf.db` while agents/quality run in the worktree. Order: load config → absolutize → chdir → `session.ensure`.
3. Cycle loop (cap from `WatchState.started_at + cap_hours`, stop-file checked each cycle):
   - `poll_k` (code) — `pr_view`; MERGED/CLOSED → break; `unresolved_threads` minus already-replied → `context_handoff/pr_threads.json`. Empty → `taper.next()` sleep, continue. Activity → `taper.reset()`.
   - `classify_k` (comment_triager, gate `triage_covers(thread_ids)`).
   - `respond_k` (builder, only if any `fix` items; `diff_matches_claims`).
   - `check_k` (code, `quality.run_tests`; red → 1 bounded builder fix; still red → reply "could not safely fix", do NOT resolve, do NOT commit).
   - `ship_k` (code) — commit + `push`.
   - `reply_k` (code) — reply inline to every item; `resolve_thread` ONLY for fixed+green+shipped items; record comment ids.
   - `rerequest_k` (code) — fixed-comment authors, normalized, skip PR author/non-reviewer bots/already-rerequested (once per author per session); persist `WatchState`.
4. Exit — `run.finish(accepted, reason)`: accepted = merged/closed or no unresolved threads; stop-file/cap exits carry the reason.
5. `ticket_done` (code, only on MERGED exit) — derive ticket id from the PR head branch (branch = ticket id by ticket-ship convention; skip silently if it doesn't parse as one), then `tickets.transition(cfg, id, "done")` + comment "PR merged → <url>". This closes the ladder: needs_info → in_progress → in_review → done, all driven by the per-repo `project.statuses` map.

## Part 5 — exe.dev dispatch: `templates/adws/adw_dispatch.ts` (new)

Code-only ADW (dispatch itself traced in LOCAL sssf.db). Flags: positional target (ticket or PR), `--workflow ticket_ship|pr_watch`, `--detach`, `--vm`.

**VM naming convention (fixed, deterministic):** `vm_name = "${remote.vm_prefix}-${slug(ticket_id)}"` where `remote.vm_prefix` is per-repo config naming the project (e.g. `solv-platform`) and `slug()` lowercases + DNS-sanitizes the ticket id — so ticket `PLFM-1234` → VM `solv-platform-plfm-1234` → public URL `https://solv-platform-plfm-1234.exe.xyz`. Branch, VM, and URL all carry the ticket id: given any one, you can find the others. `vm_prefix` default falls back to the repo name. For a PR target, derive the ticket id from the PR head branch (branch = ticket id by convention); fall back to `pr-<n>` if it doesn't parse.

**Feature-branch preview (optional):** `remote.preview_cmd` (per-repo, e.g. `["bun","run","start"]` or `["docker","compose","up","-d"]`) — when set, dispatch runs it detached on the VM after a successful ticket-ship, serving the feature branch at the VM's public URL; the close-out ticket comment and PR body then include `Preview: https://<vm>.exe.xyz`. Empty (default) = no preview. VM reuse by name means re-shipping the same ticket refreshes the same preview URL.

Phases: `request` → `vm` (`ensure_vm(vm_name)`) → `provision` (idempotent) → `sync_repo` (`clone_repo`/pull) → `secrets` (`push_secrets`) → `launch` (`run_detached` with locally minted `remote_id` via `new_id(8)` and `--adw-id <remote_id>`) → `monitor` (skipped with `--detach`: every `sync_interval_s`, `sync_db_back` + log status until remote session done/fail) → `preview` (code, only if `preview_cmd` set and remote run accepted) → `run.finish`.
Observability: synced `.backup` copy at `adws/adw_data/remote/<vm>/sssf.db` readable by the existing visualizer (`SSSF_DB=...`); live text via `ssh <vm> tail -f .../events.jsonl`.

## Part 6 — Templates: config, env, justfile, docs

- **`templates/sssf.config.yaml`**: `project:`/`remote:`/`pr_watch:` blocks (commented defaults) + 3 agent entries.
- **`templates/env.sample`** (secrets only; tool/key/base_url live in yaml): `CLICKUP_API_KEY/TEAM_ID/LIST_ID`, `JIRA_BASE_URL/EMAIL/API_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN` (needed on VMs; local uses `gh` auth).
- **`templates/justfile`** recipes: `ship TICKET *ARGS`, `watch PR` (nohup+disown, log to `adws/adw_data/pr_watch/pr-N.log`), `watch-once PR`, `watch-stop PR` (touch stop-file), `remote-ship TICKET`, `remote-watch PR` (`--detach`), `remote-ls`, `remote-rm VM`, `remote-tail VM`, `obs-remote VM`.
- **Docs**: both new ADWs carry accurate docstring `Phases:` lines (SKILL.md startup parses them); new cookbooks `cookbooks/ticket_ship.md` + `cookbooks/remote.md` (ClickUp/gh/exe.dev setup, safety notes); SKILL.md routing table entries.

## Part 7 — SOLID & boundary enforcement (configurable per repo)

Port of agent-harness `pr-solid.md` + the clean-architecture boundary discipline, split by what can be deterministic:

### Config (per stamped repo — this is the strict/relaxed knob)
`SSSFConfigSchema` gains an `architecture:` block (`.prefault({})`):
```yaml
architecture:
  mode: strict          # strict | advisory | off   (default: advisory)
  boundaries_cmd: []    # optional deterministic check, e.g. ["bunx","dependency-cruiser","--validate",".dependency-cruiser.cjs","src"]
  layers:               # optional layer map, drives both the deterministic check fallback and the auditor prompt
    domain: ["src/domain/**"]
    application: ["src/app/**"]
    infrastructure: ["src/infra/**"]
    ui: ["src/ui/**"]
  # dependency direction is fixed: ui -> application -> domain; infrastructure implements domain interfaces; never upward
  thresholds: { max_file_lines: 300, max_class_deps: 5 }   # feed the auditor's severity guidance
```
Your repos set `strict`; work repos set `advisory` or `off`. Stamped default: `advisory` (audit runs and reports, never blocks).

### Deterministic half — `quality.ts` (modify)
- New check `boundaries` (`operation: "boundaries"`): runs `architecture.boundaries_cmd` if set; else, if `layers` is set, a built-in import scan (new `adw_modules/boundaries.ts`: parse import specifiers of changed files, resolve to a layer via the globs, flag upward imports — domain→infra etc.). Skipped when mode=off or neither cmd nor layers configured.
- Wired into `run_quality()` alongside lint/typecheck/build; failures feed back to the builder via the existing `quality.as_envelope` loop. In `advisory` mode a red boundaries check is reported (evidence + log event) but excluded from `QualityResult.passed`.

### Judged half — `solid_auditor` agent (new, synced triad)
- `SolidAuditOutput` in `data_types.ts`: `pass: bool`, `findings: [{principle: SRP|OCP|LSP|ISP|DIP|architecture, severity: high|medium|low, file, line, note, recommendation}]` — pr-solid's report format, typed.
- Gate `solid_verdict_consistent` in `gates.ts`: `pass` ⇔ zero high-severity findings.
- `prompt_engineering/solid_auditor/{system,user}.md`: audits ONLY the changed files (diff from `changes.capture` in the handoff dir) against the SOLID checklist + the severity taxonomy from pr-solid (high = boundary violations, hardcoded secrets, module-level mutable state, no-repository DB access; medium = 5+ deps, >300 lines, generic Error, duplication; low = docs/extraction nits). The config `layers` + `thresholds` are rendered into the prompt. `writes: []`, reviewer-class model.

### Where it runs
- **`adw_solid.ts`** (new standalone ADW, port of `ah pr solid`): request → `changes` code phase (`changes.capture` vs `--base`) → `solid_audit` agent phase → report written to `context_handoff/solid_audit.md` + evidence; `run.finish(mode==="strict" ? audit.pass : true, ...)`. Justfile: `solid *ARGS`.
- **`adw_ticket_ship.ts`**: after GATE 2 (tests green), a `solid_audit` phase when mode ≠ off. `strict`: high findings → bounded fix loop (builder, `previous: audit`, ×2) then re-audit; still failing → wip-push + `stop("solid", findings)`. `advisory`: findings appended to the ticket comment + PR body ("Architecture audit: N high / N medium — advisory"), never blocks.
- **`pr_reviewer`** prompt also receives the layer map so review and audit agree on the architecture vocabulary.

## Part 8 — Build & verify order

1. `data_types.ts` + `gates.ts` + `git_helper.ts` additions — `tsc --noEmit` in `templates/adws/` + `bun -e` unit checks of gates on hand-built envelopes.
2. `tickets.ts` ClickUp driver — verified standalone against a throwaway ClickUp task in a test list: fetch (custom_task_ids), comment, statuses, multi-hop transition + back. Then Jira/Linear/GitHub drivers.
3. `github.ts` — sandbox GitHub repo (`sssf-sandbox`: tiny bun app, one real test, SSSF installed, `quality.ts` → `bun test`); verify push/PR/threads on a hand-made PR.
4. Prompts + config — smoke each new agent solo via existing `adw_prompt.ts --agent triager "..."` (proves the triad parses before chain-wiring).
4b. `boundaries.ts` + `adw_solid.ts` — in the sandbox repo, add a deliberate layer violation (domain file importing infra) + a 400-line class; verify `just solid` flags both, strict mode fails the run, advisory mode passes with the report; remove violations, verify clean pass.
5. `adw_ticket_ship.ts` — (a) `--dry-run` full chain; (b) deliberately vague task → Gate 1 posts questions + exits, no git writes; (c) real run → draft PR labeled TEST in sandbox, Gate 4 green, ticket in review with link; then clean up.
6. `adw_pr_watch.ts` — hand-leave a review comment on the sandbox PR; `watch-once` foreground (classify→fix→reply→resolve→rerequest-dedupe); then detached `watch`, close terminal, confirm cycling via `just sessions`, `watch-stop`.
7. `exe_dev.ts` + `adw_dispatch.ts` — manual VM first (`ssh exe.dev new --name sssf-test --json`) to pin the pi install command, then `remote-ship` end-to-end; verify `obs-remote`; `remote-rm`.
8. Stamp a fresh temp dir with `install.ts` to confirm every new file lands; `tsc --noEmit` clean.

## Risks / notes

- **pi on the VM is the biggest unknown** — pin the exact install + auth files (`~/.pi/…`) by hand in step 7 before finalizing `provision()`.
- **ClickUp statuses are per-space** — `transition()` fetches real statuses and fails loudly; "needs info" may not exist → comment-only fallback.
- **`process.chdir` + absolutized config** is the one runtime bend (audit adw_modules for relative-path reads); avoids touching `agents.ts`/`permissions.ts`/`quality.ts`.
- **Existing stamped repos** need `install.ts --force` or manual merge (installer skips existing `justfile`/config/env.sample).
- **Secrets on third-party VMs**: `.env` + pi auth rsync'd to exe.dev — use a scoped `GH_TOKEN` and per-project keys.
- Long idle watches produce ~10–15 tiny poll phases in the visualizer — cosmetic only.

### Critical files
- `templates/adws/adw_modules/data_types.ts`, `gates.ts`, `git_helper.ts`, `quality.ts` (modify); `tickets.ts`, `github.ts`, `watch.ts`, `exe_dev.ts`, `boundaries.ts` (new)
- `templates/adws/adw_ticket_ship.ts`, `adw_pr_watch.ts`, `adw_dispatch.ts`, `adw_solid.ts` (new; pattern source: `adw_simple_sdlc.ts`, `adw_build_review.ts`)
- `templates/prompt_engineering/{triager,pr_reviewer,comment_triager,solid_auditor}/` (new), `builder/user.md` (modify)
- `templates/sssf.config.yaml`, `templates/env.sample`, `templates/justfile`, `SKILL.md`, `cookbooks/` (modify)
