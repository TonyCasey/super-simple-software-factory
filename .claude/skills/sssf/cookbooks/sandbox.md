# Sandbox: run the SDLC in a per-ticket exe.dev VM

`just sandbox-sdlc ABC-123 "<prompt>"` runs the whole `adw_simple_sdlc` chain
inside a throwaway exe.dev VM named after the ticket, instead of on the
engineer's machine. The laptop dispatches and observes; the VM does the work;
the commits come home as `refs/sandbox/<ticket>-<id>`. Nothing collides with
your checkout, your ports, or your git state.

Two facts govern everything here:

1. **exe.dev VMs are persistent and BILL until destroyed.** Nothing in the
   dispatch ever destroys one — a failed run leaves the box up because the box
   is the evidence. Teardown is always your explicit `just sandbox-rm <vm>`.
2. **The VM can never push.** It clones read-only and holds no git credential;
   commits travel home as a git bundle into `refs/sandbox/`, and you merge or
   push from the laptop after review.

## One-time setup

1. **exe.dev account + SSH key.** `ssh exe.dev whoami` must answer. If your key
   is tag-scoped (common for per-project keys), set that tag as `remote.tag` in
   `sssf.config.yaml` — VM creation is refused with any other tag.
2. **Repo access for the clone.** The default (`clone_via: integration`) needs
   an exe.dev **GitHub integration** for the repo, attached to your `remote.tag`
   (create it in the exe.dev web UI; **read-only is enough** — the sandbox never
   pushes). The VM then clones `https://github.int.exe.xyz/<owner>/<repo>.git`
   with no token on the box. Fallback: `clone_via: token` + a fine-grained
   `GH_TOKEN` in `.env` scoped to the one repo, Contents: Read.
3. **Claude billing.** Default (`claude_auth: subscription`): run
   `claude setup-token` once and put the output in `.env` as
   `CLAUDE_CODE_OAUTH_TOKEN=` — in-VM runs then bill your Claude plan, flat.
   Alternative (`claude_auth: gateway`): zero credentials on the box, but every
   run bills your exe.dev token allocation at API list rates.
4. **Codex** (if the roster uses it): nothing to do — the default
   (`codex_auth: gateway`) writes a keyless provider config on the VM pointing
   at exe.dev's LLM gateway, billing your exe.dev token allocation. To bill a
   ChatGPT subscription instead, connect it as a provider source on the exe.dev
   LLM integration (device-code flow, web UI) — same VM config, different
   billing. **Do not use `codex_auth: auth_file`** unless you accept that
   OpenAI's refresh-token rotation can corrupt your local `codex login` — a
   shared auth.json breaks whichever side refreshes second (measured).
5. **Postgres** (if the app needs it): set `remote.postgres.enabled: true` and
   a repo-specific `seed_cmd` in `sssf.config.yaml`.

Credential honesty: `CLAUDE_CODE_OAUTH_TOKEN` and `~/.codex/auth.json` are real
credentials on a third-party VM running an autonomous agent. Both are revocable
— revoke them if a box you no longer trust outlives its run.

## Dispatch

```bash
just sandbox-sdlc ABC-123 "add a /health endpoint that reports db connectivity"
```

What happens, phase by phase (all traced in your LOCAL sssf.db — `just obs`):

| Phase | What it does |
|---|---|
| `vm` | Writes the dispatch record, boots or reuses `<prefix>-abc-123`, waits for ssh (~1s) |
| `provision` | Idempotent: bun, just, sqlite3, the roster's agent CLIs, postgres if enabled (~30s cold, ~2s warm) |
| `clone` | Clones the repo pinned to your current HEAD, creates run branch `sbx/abc-123-<id>` |
| `factory` | Copies in `adws/` + `justfile` if the clone lacks them; `bun install`; verifies the ADW graph loads |
| `secrets` | Writes the VM's `.env` over the ssh pipe (never argv): Claude auth, codex auth, provider keys, `DATABASE_URL` |
| `db_seed` | Runs your `seed_cmd` against the VM's postgres, prints a row-count receipt |
| `launch` | Starts `bun adws/adw_simple_sdlc.ts "<prompt>"` detached in the VM; records the PID |
| `monitor` | Polls the remote trace every `sync_interval_s`, mirrors it to `adws/adw_data/remote/<vm>/sssf.db` |
| `harvest` | Bundles `pinned_sha..sbx/...` home, fetches into `refs/sandbox/abc-123-<id>` |
| `report` | Outcome, tokens/cost, the review ref, and the teardown command |

Flags: `--detach` returns right after launch (re-attach with
`just sandbox-watch ABC-123`); `--fresh` boots a new suffixed VM instead of
reusing the ticket's (two simultaneous runs on one ticket are refused without
it). A pin warning ("pin not in the clone") means your HEAD isn't pushed — the
run uses the remote HEAD instead, which is fine unless you needed local commits.

## While it runs / after

```bash
just sandbox-ls                    # every sandbox: record, box up/gone, run status
just sandbox-tail <vm>             # follow the in-VM sssf-run.log
just sandbox-cmd <vm> 'git log --oneline -5'   # anything, inside the clone
just sandbox-obs ABC-123           # visualizer on the synced remote trace
just sandbox-harvest ABC-123       # pull commits home NOW (idempotent, run any time)
```

Review and land the work from the laptop:

```bash
git log refs/sandbox/abc-123-<id>          # what the run committed
git diff main...refs/sandbox/abc-123-<id>  # the whole change
git switch -c feature/abc-123 refs/sandbox/abc-123-<id>   # make it a branch, PR as usual
```

## Teardown — your call, never the harness's

```bash
just sandbox-harvest ABC-123   # belt and braces: commits home first
just sandbox-rm <vm>           # confirms, then destroys the VM AND its disk
```

Run `just sandbox-ls` at the end of a working day — every `up` row is a box
that is still billing.

## When something fails

- **A dispatch phase fails** → the VM stays up. `just sandbox-tail <vm>` and
  `just sandbox-cmd <vm> '...'` are your inspection tools; re-running the same
  `sandbox-sdlc` command is safe (every phase is idempotent; the run branch and
  harvest baseline are preserved).
- **The remote run fails** → the report phase prints the run-log tail; the
  synced trace opens in `just sandbox-obs`. Fix and re-dispatch onto the same
  VM — provision and clone are warm.
- **`sandbox-rm` on a box with unharvested commits** is the one irreversible
  mistake available here, which is why the recipe confirms and the CLI refuses
  without `--yes`. Harvest is free — run it first, always.
