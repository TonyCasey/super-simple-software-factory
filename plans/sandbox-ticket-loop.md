# Sandbox ticket loop: ClickUp ticket in → reviewed, merged PR out

## The target flow (user-confirmed, 2026-08-13)

From the target repo's terminal:

```bash
just ship PLFM-123
```

1. The ClickUp ticket is fetched; a host-side triager either confirms the
   requirements are implementable or posts clarifying questions to the ticket,
   moves it to "needs info", and stops. **Triage runs BEFORE the VM exists** —
   an unclear ticket never pays for a box.
2. On a clear ticket: the sandbox dispatch (built, E2E-verified) boots the
   per-ticket VM, provisions it, clones the repo, seeds postgres, and runs the
   full SDLC in-VM.
3. **The PR is created FROM THE VM** (user decision): the run branch is pushed
   and a draft PR opened through the exe.dev GitHub integration — still no
   GitHub token on the box.
4. The ClickUp ticket moves to "review" with the PR URL and the VM URL
   commented on it.
5. The human reviews the PR. **A VM-resident watcher iterates on review
   feedback** (user decision): polls unresolved threads, fixes, pushes,
   replies, re-requests review — until the human approves and merges.
6. On merge: ticket → "done", a final harvest, and **the VM is torn down** —
   the merge is the human sign-off that makes auto-teardown acceptable here.

## What exists vs what this plan adds

Built and verified (plans/sandbox-sdlc-exe-dev.md): the whole execution
engine — dispatch phases, provisioning incl. postgres+seed, tokenless clone,
credential shipping, detached launch, monitor, bundle harvest, teardown
tooling. This plan adds the ticket/PR orbit. It adapts
plans/extend-sssf-ticket-ship-pr-watch-exe-dev.md (Parts 1–4), superseding its
Part 5 (the dispatch is built) and changing two of its calls: PR creation and
fix-pushing move from the laptop into the VM.

## Measured facts this plan stands on

- The exe.dev GitHub integration supports the **gh CLI tokenlessly** from an
  attached VM: `export GH_HOST=github.int.exe.xyz`, then `gh pr ...` (doc:
  integrations-github → "Using the gh CLI"). Write operations require the
  integration to be write-enabled (web UI; `--act-as-user` attributes pushes
  to Tony rather than the bot). Tony's scoped key cannot edit integrations —
  the write toggle is a one-time web-UI act per repo.
- Tokenless clone + read via the integration verified live (solv-platform
  spike). Tokenless **push, `gh pr create`, and `gh api graphql`** are NOT yet
  verified — they are the Stage A spike.
- ClickUp: Tony's fieldwork agent-harness conventions carry over — custom
  task ids (`PLFM-123`) need `?custom_task_ids=true&team_id=$CLICKUP_TEAM_ID`
  on every call; statuses are per-space and must be fetched, never guessed.

## Credential layout (deliberate, asymmetric)

| Credential | Host | VM | Why |
|---|---|---|---|
| ClickUp API key | ✅ | ❌ never | All ticket transitions/comments run host-side (ticket_ship + finalizer). The VM's watcher touches only the PR. |
| GitHub write | via local `gh` login | via write-enabled integration (no token material on the box) | The VM can push the run branch and talk to its own PR; it cannot mint or exfiltrate a token because there isn't one. |
| Claude / codex / DATABASE_URL | as today | as today | Unchanged from the sandbox plan. |

Hard prerequisite this creates: **branch protection on the target repo's
default branch** (PRs required, no direct pushes count as merged review). The
integration grants push to any branch of that repo; protection is what makes
"the human merge is the gate" true.

---

## Stage A — Spike (measured facts before code; one VM, torn down after)

> **DONE 2026-08-13 — all five items green.** Measured on VM `sssf-stage-a`
> (torn down) with the `tonycasey-sssf-sandbox-e2e` read-write integration
> (act-as-user, currently attached `auto:all`):
>
> 1. **Tokenless push** through the integration clone: works.
> 2. **Tokenless `gh pr create --draft`** with `GH_HOST=github.int.exe.xyz`:
>    works, no placeholder token needed. gh treats the host as GHES — REST at
>    `/api/v3`, GraphQL at `/api/graphql`, **both proxied**. `gh` 2.45.0
>    installs via apt in seconds → provision.sh gains a `--gh` flag for
>    pr-enabled dispatches.
> 3. **GraphQL fully works through the integration**: `reviewThreads` query
>    and the `resolveReviewThread` mutation both succeeded; REST review
>    creation and thread replies too. The reply-only fallback is dead — the
>    full watcher design stands.
> 4. **State detection**: `gh pr view --json state,reviewDecision,isDraft,
>    mergedAt` works.
> 5. **ClickUp**: auth via raw token header; custom ids (`PLFM-1` etc.) fetch
>    with `custom_task_ids=true&team_id=90121693723` (Solv Property; Tony's
>    personal workspace is `2158290`). **Status ladders are LIST-level**, not
>    space-level — PLFM-1's list runs `backlog / in development / in review /
>    shipped / cancelled` (→ generic map: todo→backlog, in_progress→in
>    development, in_review→in review, done→shipped; `needs_info` absent →
>    comment-only fallback). Full write cycle (create, comment, transition
>    both ways, delete) verified against the personal "SSSF Tasks" list
>    (`901220296904`) — the designated Stage G test list.
>
> Quirks measured: **git ref DELETION through the integration proxy returns
> HTTP 400** — branch cleanup must run host-side (or be skipped); and the
> integration being `auto:all` means every VM on the account has write to the
> test repo — fine for now, tag-scope production repos' integrations.

On a VM tagged with a **write-enabled** integration for `sssf-sandbox-e2e`
(Tony creates the integration in the web UI first — read-write, attached to
the tag or to the spike VM):

1. `git push origin <branch>` through the integration clone — attribution
   (bot vs act-as-user), and whether protected-branch pushes are refused.
2. `GH_HOST=github.int.exe.xyz gh pr create --draft ...` — does PR creation
   work tokenlessly; capture the URL output shape.
3. `gh api graphql` for `reviewThreads` (isResolved, comment ids) and the
   `resolveReviewThread` mutation — the pr-watch loop lives or dies on this.
   Fallback if GraphQL is not proxied: REST review comments + reply-only (no
   thread resolution), noted honestly in the watcher's design.
4. `gh pr view --json state,reviews` — merged/approved detection.
5. ClickUp REST with Tony's key against a throwaway task in a test list:
   fetch by custom id, comment, read statuses, transition to "review" and
   back. Record the space's actual status names.

Findings land in this plan, as with the sandbox spike.

## Stage B — Shared plumbing (templates/adws/)

> **DONE 2026-08-13 — all modules live-tested.** ClickUp driver measured
> quirks: `custom_task_ids=true` makes ANY id parse as a custom id, so the
> query string is sent only for `PLFM-123`-shaped refs; statuses are
> LIST-level and matched case-insensitively at runtime; a missing mapped
> status degrades to a ticket comment. `SSSF_DRY_RUN=1` verified on all
> mutations.

### `adw_modules/data_types.ts` (modify)
- `TicketSchema` — `{tool, id, url, title, description, status, comments[]}`.
- `ClarityOutput` envelope — `clear: boolean`, `classification:
  bug|feature|chore`, `questions: string[]` (non-empty iff `!clear`).
- Config: `project:` block via `ProjectConfigSchema.prefault({})` —
  `{tool: "clickup"|"github"|"none" (default none), statuses: {todo,
  in_progress, in_review, done, needs_info}}` (generic ladder → per-space
  names, from Stage A's findings).
- `remote.pr:` block — `{enabled: bool (default false), base: "" (default:
  repo default branch), draft: true, labels: []}`.

### `adw_modules/tickets.ts` (new)
ClickUp driver behind a `TicketDriver` interface (other tools later):
`fetch(id)`, `comment(id, body)`, `statuses()`, `transition(id, generic)`
(fetch real statuses, map via config, multi-hop when a direct jump is
rejected, warn+comment-only when a mapped status doesn't exist),
`mirror_failure(id, stage, detail)` — every ADW stop posts to the ticket.
Always `custom_task_ids=true&team_id`. All mutations honor `SSSF_DRY_RUN=1`.
Env: `CLICKUP_API_KEY`, `CLICKUP_TEAM_ID` (validated up front, fail fast).

### `adw_modules/github_vm.ts` (new — the VM-side surface)
Everything speaks `gh` with `GH_HOST=github.int.exe.xyz` (set by the secrets
phase, not hardcoded, so the same module works with a plain `gh` login):
`default_branch()`, `push_branch(branch)`, `create_draft_pr({base, title,
body, labels})` → url+number, `pr_state(number)` → open/merged/closed +
approved, `unresolved_threads(number)` (GraphQL, per Stage A),
`reply(thread, body)`, `resolve_thread(thread)`, `request_review(reviewers)`.
PR title `[<TICKET>] - <summary>`; body links the ticket URL.

### Gates (`adw_modules/gates.ts`, modify)
- `clarity_consistent` — `clear=false ⇒ questions non-empty; clear=true ⇒ none`.
- `triage_covers(thread_ids)` factory — every unresolved thread classified
  exactly once (for the watcher).

### Agents (config + prompts, synced triads)
- **`triager`** → `ClarityOutput`. Reads the ticket JSON + scans the repo;
  "if a competent engineer couldn't start without asking, ask — never
  guess." Ticket comments are part of its context, so an answered
  needs-info round trip converges. `writes: []`, haiku, thinking high.
- **`comment_triager`** → `CommentTriageOutput` (`items: [{thread_id, kind:
  fix|reply|clarify, reply, fix_instruction}]`). `writes: []`, sonnet.

## Stage C — Host ADW: `templates/adws/adw_ticket_ship.ts` (new)

> **DONE 2026-08-13 — Gate 1 live-tested** on a deliberately vague ticket
> (869ehz9y7): triager produced 5 questions, they were posted as a ticket
> comment, the ticket moved to "needs info", and the run finished cleanly
> without a VM.

Thin chain; the ticket is the prompt source, so no positional prompt:

```
usage: bun adws/adw_ticket_ship.ts PLFM-123 [--config ...] [--fresh] [--no-watch]
```

1. `request` (engineer) — ticket ref, flags.
2. `fetch_ticket` (code) — `tickets.fetch` → `context_handoff/ticket.json`;
   compose the working prompt: title + description + a digest of
   clarification comments.
3. `triage` (agent, gates `[clarity_consistent, artifacts_exist]`).
4. **GATE 1** (code) — `!clear` → `tickets.comment(questions)`,
   `transition(needs_info)`, `run.finish(false, "needs-info")`. The human
   answers on the ticket and re-runs the same command.
5. `start_ticket` (code) — `transition(in_progress)`.
6. `dispatch` — the existing `sandbox_dispatch.dispatch()`, called with
   `adw: "sdlc_pr"` (Stage D) and the composed prompt. All its phases
   (vm → … → launch → monitor → harvest) appear in this run's trace as they
   do today. The monitor's terminal condition is extended: for a `sdlc_pr`
   run, "success" includes the PR URL landing in the remote handoff.
7. `pr_readback` (code) — read `context_handoff/pr.json` from the VM over
   ssh; store `pr_url`/`pr_number` in the sandbox record.
8. `handoff` (code) — `transition(in_review)`; ticket comment: PR URL, VM
   URL, harvest ref. This is the moment the flow goes human.
9. `start_watch` (code) — `exe_dev.sh_detached`: launch `adw_pr_watch.ts`
   (Stage E) inside the VM against the PR; record the watcher PID.
10. `finalize` (code; skipped with `--no-watch`) — host-side poll every 5
    min via **local** `gh pr view`: on MERGED → `transition(done)` + ticket
    comment, final `harvest()` (belt and braces), then **teardown** — the
    one auto-destroy in the system, justified because the human merge already
    signed off. On CLOSED-unmerged → ticket comment + leave the VM up (the
    human is mid-decision). `just ship-watch PLFM-123` re-enters this phase
    any time (laptop closed overnight, etc.).

Justfile: `ship TICKET *ARGS`, `ship-watch TICKET`.

## Stage D — VM ADW: `templates/adws/adw_sdlc_pr.ts` (new)

> **DONE 2026-08-13 — full ticket→PR run** on SF-36/869ehzjj9: triage →
> VM `sssf-e2e-sf-36` → SDLC green → PR #2, ticket to "in review" with PR +
> VM links. Defect found and fixed: with `clone_via: token` the origin
> can't push tokenlessly — `remote.pr.enabled` now REQUIRES
> `clone_via: integration` (validated at dispatch), and CLONE_SCRIPT
> re-asserts the origin URL on VM reuse.

`adw_simple_sdlc`'s exact chain (import and reuse its `main` if the seams
allow; otherwise the same phase list) plus two phases after `commit_docs`:

- `push` (code) — `github_vm.push_branch(run_branch)`.
- `create_pr` (code) — `create_draft_pr` with base = `remote.pr.base` or the
  repo default; write `context_handoff/pr.json` (`{url, number, branch}`)
  — the host's `pr_readback` reads exactly this file.

Secrets phase (sandbox_dispatch, modify): when `remote.pr.enabled`, add
`GH_HOST=github.int.exe.xyz` to the VM `.env`; refuse dispatch with a clear
error if `project.tool != none` but the ClickUp keys are missing host-side.

## Stage E — VM watcher: `templates/adws/adw_pr_watch.ts` (new, detached daemon)

> **DONE 2026-08-14 — both cycle shapes live-tested on PR #2.**
> Reply cycle: a human "are we open to SQL injection?" thread → classified
> `reply`, answered with code evidence, left unresolved for the human.
> Fix cycle: two real Copilot code-review findings → classified `fix`,
> built, tests green, pushed, both threads replied + resolved, Copilot
> re-requested. Learned: Copilot is unreachable by login — request via REST
> as `copilot-pull-request-reviewer[bot]`; GraphQL reports the thread
> author WITHOUT the `[bot]` suffix; Copilot reviews arrive async (~5 min)
> and the pending-reviewer entry vanishes once submitted. Replies are
> unsigned by default (`remote.pr.signature` opts in).

One long-lived in-VM process, its own session in the VM trace (visible via
`just sandbox-obs`). Cycles are numbered code phases; sleeps happen BETWEEN
phases so the trace reads honestly. Tapered idle polling 2m → 5m → 15m → 60m,
reset on activity; hard cap 48h (then it exits and says so on the PR).

Per cycle:
1. `poll_k` (code) — `pr_state`; MERGED/CLOSED → exit loop. Collect
   unresolved threads minus already-handled → `context_handoff/pr_threads.json`;
   none → taper sleep.
2. `classify_k` (comment_triager, gate `triage_covers`).
3. `respond_k` (builder, only for `fix` items; `diff_matches_claims`).
4. `check_k` (code) — the repo's test gate; red → one bounded builder fix;
   still red → reply "could not safely fix", do NOT resolve, do NOT push.
5. `ship_k` (code) — commit + `push_branch`.
6. `reply_k` (code) — inline replies to every item; `resolve_thread` ONLY for
   fixed+green+pushed items; record handled ids (state file in session dir,
   crash-resumable).
7. `rerequest_k` (code) — re-request reviewers whose findings were fixed,
   once per reviewer per session.

The watcher never touches ClickUp (no key on the VM) and never merges,
approves, or closes — those are the human's and the host finalizer's.
Exit states: merged (host finalizer takes over), closed, cap reached, or
stop-file (`sandbox-cmd <vm> 'touch ../pr-watch.stop'`).

## Stage F — Target repo onboarding (per repo; solv-platform's checklist)

> **DONE 2026-08-14 (one manual step left: write-enable the integration).**
> Fresh stamp on solv's `sssf-install` branch (replacing an untracked
> pi-era trial). quality.ts: `nx affected -t test|lint|typecheck
> --base=origin/staging` (e2e excluded). Config: Solv workspace
> `90121693723`, measured PLFM ladder backlog/in development/in review/
> shipped/cancelled (no needs-info status → comment degradation), remote
> block with `setup_cmds` (node 24 + corepack yarn + redis — a new factory
> hook added for this), Twenty-default postgres (`postgres:postgres@…/
> default`) and `nx database:reset --configuration=seed` as seed_cmd
> (db_seed timeout raised to 30m — it builds the server first). Verified
> live: config parses, PLFM-120 fetched by custom id, ladder matches.
> `staging` branch-protected via API (PRs required, 0 approvals — the
> merge stays the sign-off; no force-push/delete). Lesson paid for:
> `just demo` on a dirty tree while a concurrent commit cleans it →
> permissions enforcement reads vanished dirt as agent-destroyed work and
> fails the run. Keep git quiet while ADWs run.

1. `/sssf install` into solv-platform; wire its real test command in
   `quality.ts` (scoped path, not bare `bun test`); real `seed_cmd`
   (migrations + seed — likely the fiddliest single item).
2. `remote:` block: `tag: tony-casey-solv-platform-2`, `clone_via:
   integration`, postgres block, `pr.enabled: true`; `project:` block with
   the space's measured status names.
3. Web UI: make the solv-platform integration **read-write** (decide
   act-as-user vs bot attribution).
4. Branch protection on the default branch: PRs required.
5. `.env`: ClickUp keys + the existing sandbox credentials.

## Stage G — Verification order

> **DONE 2026-08-14 — the solv-platform pilot (PLFM-78) ran the whole loop
> on a real ticket**: write-probe green (integration must be attached to
> the TAG, not one VM — a web-UI step), triage passed on a favicon-scoped
> brief with the ticket's attached favicon.ico handed into the VM (new
> attachment pipeline), full SDLC on a fresh `solv-plfm-78` (node 24 +
> yarn + redis via setup_cmds, Twenty seed), draft PR #26 against
> protected `staging`, Tony's two inline "this file is not needed"
> comments handled by the watcher (fix → delete → green → push → resolve),
> merge → ticket "shipped" + harvest + auto-teardown. PLFM-82 exercised
> the needs-info stop on the real board first (3 sharp questions, no VM).
> Three live defects found and fixed: copied-in factories polluted PRs
> (now .git/info/exclude'd), harvest failed on pins the host never
> fetched (now fetches), and diff_matches_claims called deletions lies
> (now git-aware). Product changes from Tony's review: workshop
> artifacts stay out of PRs (doc becomes the PR body, 🤖 footer kept),
> watcher replies unsigned by default. Known gap: the watcher reads only
> inline review threads — plain PR conversation comments are invisible
> to it.

1. Stage A spike, findings recorded here.
2. `tickets.ts` alone against a throwaway ClickUp task (fetch, comment,
   ladder up and back). `SSSF_DRY_RUN` path tested.
3. `github_vm.ts` alone from a spike VM against a hand-made branch + PR on
   sssf-sandbox-e2e (push, create, threads, reply, resolve).
4. Triager solo via `adw_prompt.ts` on a deliberately vague ticket (Gate 1
   fires, questions land on the ticket, nothing else happens) and a clear one.
5. `just ship E2E-3` end-to-end on sssf-sandbox-e2e with a real ClickUp
   ticket: expect needs-info round trip OR straight through to a draft PR +
   ticket in review; hand-leave a review comment; watch the VM watcher fix,
   push, reply, resolve, re-request; approve and merge; watch finalize move
   the ticket to done and tear the VM down.
6. Then the solv-platform pilot on a real, small PLFM ticket.

## Risks / notes

- **GraphQL through the integration is the load-bearing unknown** (thread
  resolution). Stage A answers it; the reply-only fallback is acceptable but
  worse UX.
- **Write-enabled integration = any VM on that tag can push to that repo.**
  Mitigations: branch protection (mandatory), one integration per repo, and
  the watcher's own discipline (never force-push, never touch other
  branches). Consider a dedicated tag per repo for write integrations.
- **Two writers on one branch**: the human pushing review fixups to the PR
  branch while the watcher pushes would conflict. The watcher must
  fetch+rebase (ff-only) before each push and stand down with a PR comment if
  the branch diverged.
- **ClickUp statuses are per-space** — everything goes through the measured
  map; "needs info" may not exist → comment-only fallback.
- **Cost of long watches**: the taper caps polling; agent calls only happen
  on actual activity. The 48h cap prevents forgotten daemons; `ship-watch`
  restarts one cheaply.
- The extend plan's remaining parts (pr-watch on the laptop, worktrees,
  Jira/Linear drivers, SOLID gates) stay valid but are out of scope here.

### Critical files

- Modify: `adw_modules/data_types.ts`, `adw_modules/gates.ts`,
  `adw_modules/sandbox_dispatch.ts` (secrets + monitor + record),
  `templates/sssf.config.yaml`, `templates/env.sample`, `templates/justfile`,
  `SKILL.md`, `references/config.md`, `cookbooks/sandbox.md`
- New: `adw_modules/tickets.ts`, `adw_modules/github_vm.ts`,
  `templates/adws/adw_ticket_ship.ts`, `templates/adws/adw_sdlc_pr.ts`,
  `templates/adws/adw_pr_watch.ts`,
  `templates/prompt_engineering/{triager,comment_triager}/{system,user}.md`
