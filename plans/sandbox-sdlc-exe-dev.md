# Sandbox SDLC: run `adw_simple_sdlc.ts` inside a fresh exe.dev VM via a `--sandbox` flag

> **STATUS: IMPLEMENTED AND E2E-VERIFIED 2026-08-13.** A full `sandbox-sdlc`
> dispatch ran green against a GitHub-hosted stamped repo
> (TonyCasey/sssf-sandbox-e2e, clone_via token): VM boot → provision (postgres
> seeded) → clone → factory → secrets → launch → the whole plan/build/test/
> review/document chain in-VM (658k tokens, $0.00 — Max subscription; reviewer
> gpt-5.5 keyless via the exe.dev gateway) → 3 commits harvested into
> refs/sandbox/. Four defects were found and fixed by the earlier attempts:
> codex auth.json rotation (→ `codex_auth: gateway` default), codex
> `--ignore-user-config` blanking the gateway provider (→ `SSSF_CODEX_BASE_URL`
> -c flags in agent_codex), the detached run log living inside the checkout and
> tripping read-only rosters' permissions gate (→ `../sssf-run.log`), and a
> monitor race against rejoined session ids (→ fresh remote id per launch +
> grace window).
>
> A second feature (E2E-2: /notes read/write endpoints against the seeded
> postgres) also ran green end to end and surfaced one latent HARNESS bug:
> codex `exec resume` runs read-only — it does not inherit the first turn's
> sandbox mode and rejects the `--sandbox` flag outright — so any second review
> round failed writing its report. Fixed in agent_codex.ts with
> `-c sandbox_mode="workspace-write"` on the resume argv; the fix is in the
> templates but has not yet been exercised by a live multi-round review.

## Context

Today every ADW runs on the engineer's machine, in the engineer's checkout. The goal: add a
dispatch mode so

```bash
just simple-sdlc "implement the CSV export described in ABC-123" --sandbox ABC-123
```

spins up an exe.dev VM named after the ticket, provisions it (bun, just, **postgres installed
and seeded**), clones the target repo, copies in the SSSF factory, launches the same SDLC
detached **inside** the VM, monitors it from the laptop, and pulls the commits home. The
laptop dispatches and observes; the VM does the work.

Reference implementation studied: `disler/inkwell-agent-sandboxes-and-software-factory`
(`.claude/skills/sandbox-exe-dev`, `.claude/skills/sssf-sandbox-orchestrator`,
`just/sandbox/`, `sandbox_mount/`). Its measured facts (ssh wait loop, the three detachment
pieces, bundle harvest, provision idempotency, "never auto-teardown") are ported; its
just-recipe architecture is not — here the control plane is TypeScript modules, same as the
rest of SSSF, and the dispatch is itself a traced run in the local `sssf.db`.

Relation to `plans/extend-sssf-ticket-ship-pr-watch-exe-dev.md`: this is a standalone,
narrower slice of that plan's Part 5. Shared names are kept identical (`remote:` config
block, `adw_modules/exe_dev.ts`, VM naming `<vm_prefix>-<ticket-slug>`) so implementing that
plan later extends this one instead of colliding with it.

## Spike findings (measured 2026-08-13, region `lon`, account tony@tonycasey.com)

The Part 7 step 1 spike has been run. Every unknown is now a measured fact; defaults below
are amended accordingly.

- **`ssh exe.dev new --json` payload**: a **flat object** — `{vm_name, tags, ssh_command,
  ssh_dest, ssh_host, ssh_port, https_url, proxy_port, shelley_url, vscode_url, xterm_url}`.
  No `{vm}`/`{vms}` nesting; `exe_dev.ts` parses it directly. Flags confirmed: `--name --cpu
  --memory --disk --image --tag --env --setup-script --integration --json`.
- **SSH keys can be scoped**, and this machine's is: tag-scoped to
  `tony-casey-solv-platform-2` (VM creation refused with any other tag) and command-scoped
  (`billing`, `integrations attach` refused; `new`, `ls`, `rm`, `integrations list` allowed).
  So `remote.tag` is a required concept, and per-project scoped keys are actually a *good*
  credential-boundary pattern, not an obstacle.
- **The box**: Ubuntu 24.04.4 LTS, exedev user, passwordless sudo, git/curl/python3
  preinstalled, ssh answers ~1s after `new`.
- **Postgres is cheap here**: apt update 9s + install 13s → PostgreSQL 16.14 running.
  The "takes minutes" fear was a `dal`-region measurement; from `lon` it is ~25s, first
  provision only. Role/db idempotent creation + password auth verified.
- **Toolchain installs**: bun 1s, just 1s, claude CLI 1s, codex CLI 1s (all via curl/bun).
  Codex's launcher needs `node`: **symlinking bun as `/usr/local/bin/node` works**
  (codex-cli 0.147.0 runs) — no node install needed.
- **The key-free LLM gateway works out of the box**: `ANTHROPIC_BASE_URL=https://llm.int.exe.xyz
  ANTHROPIC_API_KEY=implicit claude -p` answered with zero credentials on the VM. Every
  account gets a default `llm` integration attached `auto:all`. The Anthropic surface
  (`/v1/messages`, listable at `/anthropic/v1/models`) serves the full current lineup:
  claude-fable-5, claude-opus-5, claude-sonnet-5, claude-haiku-4-5, and the 4.x line — the
  whole starter roster. Billing is the **exe.dev subscription's monthly token allocation**
  (top-ups at exe.dev/user/shelley), not an Anthropic key. Note: Anthropic models do NOT
  appear on the OpenAI-style `/v1/models` listing — health checks must probe
  `/anthropic/v1/models`.
- **Gateway pricing is Anthropic list price, no markup** (checked against current
  Anthropic rates, 2026-08-13): fable $10/$50, opus-5 $5/$25, sonnet-5 $2/$10 (the
  current intro rate), haiku $1/$5 per MTok, with standard 0.1×/1.25× cache pricing.
  Billed against the exe.dev subscription's monthly token allocation — real API-priced
  spend, unlike the laptop roster's flat Claude Max subscription.
- **OAuth-token auth works on the VM** (verified 2026-08-13): with only
  `CLAUDE_CODE_OAUTH_TOKEN` set (no gateway, no API key), `claude -p` answered on
  claude-sonnet-5 — billing the Claude Max subscription like local runs. The CLI still
  prints an API-price *estimate*; nothing is billed per token (which is why agent_cc.ts
  suppresses that estimate for subscription agents).
- **Codex auth.json transplant is UNSAFE** (upgraded from "works" after the first E2E,
  2026-08-13): the one-shot spike passed, but OpenAI rotates refresh tokens, so a shared
  auth.json corrupts whichever side refreshes second — the E2E's review phase died on
  "refresh token was already used" AND invalidated the host's `codex login`. The default
  is now `codex_auth: gateway`: exe.dev's documented Codex recipe (`~/.codex/config.toml`
  provider at `llm.int.exe.xyz/v1`, `requires_openai_auth = false`) — keyless, bills the
  exe.dev allocation, or a connected ChatGPT provider source (device-code flow, web UI).
  The dispatch sets `SSSF_CODEX_SKIP_AUTH_PROBE=1` in-VM since no login exists for
  agent_codex's probe to find.
- **The GitHub integration replaces `GH_TOKEN`**: with a repo integration attached to the
  VM's tag, `git clone https://github.int.exe.xyz/<owner>/<repo>.git` works inside the VM
  with **no token on the box** (verified: private solv-platform clone, 75s). Integrations
  support `--readonly` — clone-only access, which preserves the bundle-harvest design.
  Managing integrations needs the web UI or an unscoped key; the scoped key can only list.

Net effect on the design: **no GitHub token on the VM at all** (integration clone), and a
billing choice for Claude: ship `CLAUDE_CODE_OAUTH_TOKEN` and bill the flat Max
subscription (the default — verified working), or go fully keyless via the gateway and pay
per token against the exe.dev allocation. Codex ships its auth file (ChatGPT plan) or uses
the keyless provider source.

## Design decisions

1. **The flag lives on the ADW, the logic lives in a module.** `adw_simple_sdlc.ts` gains
   `--sandbox <ticket>`; when present its entrypoint calls
   `sandbox_dispatch.dispatch({...})` instead of `main()`. Any other ADW adopts sandbox mode
   with the same three lines. No fork of the SDLC logic — the VM runs the *identical*
   `adw_simple_sdlc.ts`, minus the flag.
2. **VM name = `<vm_prefix>-<ticket-slug>`** (e.g. `myapp-abc-123`), DNS-lowercased, ≤63
   chars. `vm_prefix` from `remote.vm_prefix`, defaulting to the repo name. Ticket in the
   name means branch, VM, and `https://<vm>.exe.xyz` URL all carry the ticket id — given any
   one you can find the others.
3. **Reuse by name, `--fresh` to force new.** exe.dev VMs are persistent; re-dispatching the
   same ticket reuses the warm VM (provision is idempotent, clone fast-forwards). `--fresh`
   appends `-<6 hex>` and boots a new box.
4. **Credential boundary, inkwell-style.** The exe.dev account never leaves the host — the VM
   cannot dispatch VMs. The VM gets only: a **read-only** repo token (clone), agent
   credentials for the roster (see Part 4), and its own postgres. No push credential by
   default.
5. **Commits come home as a git bundle**, fetched into `refs/sandbox/<ticket>-<adw_id>` —
   non-destructive, credential-free, never touches the local working tree. The engineer
   reviews the ref and merges/pushes from the laptop. (An opt-in `--push` can come later; the
   run-branch naming `sbx/<ticket>-<adw_id>` is chosen to be correct under both.)
6. **Never auto-teardown.** Dispatch ends with the VM alive, its URL, the remote run's
   cost/tokens, and the exact `just sandbox-rm` command. A destroyed VM is evidence gone; a
   forgotten VM is only money — and it is printed, not silent.
7. **Fail = stop and report, VM stays up.** Every dispatch failure prints the ssh command to
   inspect the box. Nothing in the failure path destroys anything.

All paths below are under `.claude/skills/sssf/` unless noted. Everything lands in
`templates/` so `install.ts` stamps it into every target repo (its recursive copy of
`templates/adws/` picks the new files up with zero installer changes).

---

## Part 1 — Config: the `remote:` block

### `templates/adws/adw_modules/data_types.ts` (modify)

`SSSFConfigSchema` gains `remote: RemoteConfigSchema.prefault({})`:

```yaml
remote:
  vm_prefix: ""                # VM name prefix; default = repo directory name
  tag: ""                      # VM tag. REQUIRED with a tag-scoped SSH key (spike finding);
                               # also what tag-attached integrations (GitHub, LLM) bind to
  cpu: 2                       # `ssh exe.dev new` flags, all verified: --cpu --memory --disk
  memory: ""                   # e.g. "8GB"
  disk: ""                     # e.g. "20GB"
  repo: ""                     # owner/name; default derived from `git remote get-url origin`
  clone_via: integration       # integration (github.int.exe.xyz, no token on VM — default)
                               # | token (GH_TOKEN fallback for repos without an integration)
  sync_interval_s: 30          # monitor poll cadence
  adws_dirs:                   # what "copy in the sssf" copies when the clone lacks it
    - adws
    - justfile
  postgres:
    enabled: false             # true => install postgres 16 + create db + run seed
    db: app
    user: app
    password: app              # local-only VM db; not a secret worth a vault
    seed_cmd: []               # repo-specific, run in the clone root with DATABASE_URL set,
                               # e.g. ["bun", "run", "db:setup"] or ["psql", "-f", "seed.sql"]
  env_passthrough: []          # extra .env keys to copy host -> VM (beyond the defaults in Part 4)
```

Zod schema with these defaults; `.prefault({})` so every existing config parses unchanged.

### `templates/sssf.config.yaml` (modify)

Append the block above, commented, with a paragraph on the credential boundary and the
"VMs bill until you kill them" warning.

---

## Part 2 — `templates/adws/adw_modules/exe_dev.ts` (new)

Thin, synchronous-feeling primitives over `ssh` / `rsync` via `Bun.spawn`, all taking the VM
name, none reading config directly. This is the only file that knows exe.dev exists.

- `ls(): VmInfo[]` — `ssh exe.dev ls --json`; the one verified payload shape
  (`{vms:[{vm_name, https_url, ssh_dest, ...}]}`).
- `ensure_vm(name, remote): VmInfo` — reuse by name from `ls()`, else
  `ssh exe.dev new --name <name> --json` (parse defensively: inkwell found `new --json`'s
  shape unverified — accept `{vm}`, `{vms:[...]}`, or flat, then fall back to re-reading
  `ls`). Derive `https_url = https://<name>.exe.xyz` when absent.
- `wait_ssh(name, timeout_s = 60)` — loop `ssh -o BatchMode=yes -o ConnectTimeout=5
  <name>.exe.xyz true` every 2s. (Wildcard `*.exe.xyz` known_hosts entry documented as a
  one-time setup step in the cookbook, so BatchMode never stalls on a prompt.)
- `sh(name, cmd, opts?)` — synchronous remote command, `cd <dir> &&` when given; throws on
  non-zero with stderr attached.
- `sh_script(name, script, args)` — pipe a script over stdin
  (`ssh <vm> bash -s -- <args>`), so nothing has to survive two layers of shell quoting.
- `sh_detached(name, dir, cmd, log): number` — the inkwell detachment contract, all three
  pieces mandatory:
  `ssh <vm> "cd <dir> && ( nohup <cmd> > <log> 2>&1 < /dev/null & echo \$! )" < /dev/null`,
  `| tail -n 1`, reject non-numeric PIDs. The outer `< /dev/null` stops ssh eating the
  caller's stdin; the inner one detaches the remote child.
- `write_env(name, dir, lines)` — `printf ... | ssh <vm> 'umask 077 && cat > <dir>/.env &&
  chmod 600 <dir>/.env'`; secrets never in argv on either side, never echoed back.
- `rsync_to(name, src, dest, excludes?)` / `rsync_from(...)`.
- `sync_db_back(name, remote_db, local_path)` — **WAL-safe**: remote
  `sqlite3 <db> ".backup /tmp/sssf-sync.db"`, then rsync the backup. Local dest:
  `adws/adw_data/remote/<vm>/sssf.db` (the visualizer opens it via `SSSF_DB=`).
- `remote_session(name, dir, db, adw_id): {status, cost, tokens} | null` — one sqlite3 query
  over ssh; drives the monitor loop.
- `rm(name)` — `ssh exe.dev rm <name>`; called only from the explicit justfile recipe, never
  from dispatch.

All host-side spawns use `utils.operator_env()`, consistent with the rest of the modules.

---

## Part 3 — `templates/adws/adw_modules/sandbox_dispatch.ts` (new)

Exports `dispatch(opts): Promise<number>` where
`opts = {ticket, prompt, config_path, cfg, adw: "simple-sdlc", flags: {fresh, detach, keep_env}}`.
It runs a normal SSSF session (`session.ensure`) — **every phase `kind: "code"`, owner
`"sandbox"`** — so the dispatch is traced, visualized, and cost-reported like any run. The
in-VM run is a *second, independent* session in the VM's own `sssf.db`; the local one records
the dispatch itself.

### The dispatch record

`adws/adw_data/sandbox/<vm_name>.json` (gitignored with the rest of `adw_data` runtime):
`{ticket, vm_name, https_url, repo, pinned_sha, run_branch, remote_adw_id, pid, created_at,
last_synced_at}`. Written incrementally — record before VM, VM before launch — so a crash at
any point leaves `sandbox-ls` and `sandbox-rm` a handle (inkwell's create-ordering lesson).
`new_id(8)` mints `remote_adw_id` **locally, before launch**, so the monitor can join the
remote db by id.

### Phase sequence

| Phase | Does | Gate / notes |
|---|---|---|
| `request` | log ticket, prompt, flags, resolved vm_name, pinned host HEAD sha | vm_name must be a valid DNS label ≤63 chars |
| `vm` | write record → `ensure_vm` → `wait_ssh` | ssh answers within 60s |
| `provision` | `rsync_to` `adws/sandbox/` (guest scripts, Part 5) if the clone won't carry them yet, then `sh_script(provision.sh)` with postgres args from `remote.postgres` | script ends `[provision] READY`; idempotent, so re-dispatch is cheap |
| `clone` | clone `remote.repo` (default: origin URL) to `~/app` at the **pinned host HEAD sha**, using `GH_TOKEN` for private repos (`https://x-access-token:$TOKEN@...`, token passed via stdin-fed `git credential` helper — never in argv); create/switch run branch `sbx/<ticket>-<remote_adw_id>` at that sha (adds no commit — the harvest baseline stays exact) | remote HEAD == pinned sha |
| `factory` | if the clone has no `adws/`: rsync the host's stamped `remote.adws_dirs` into it ("copy in the sssf"); then `bun install` in `~/app/adws` | `bun adws/adw_prompt.ts --help` exits 0 |
| `secrets` | build the VM's `~/app/.env` via `write_env`: agent credentials + `DATABASE_URL` (Part 4) | file mode 600, size > 0 — verified by `stat`, contents never printed |
| `db_seed` | only if `postgres.enabled`: create role+db (idempotent `DO $$ ... $$`), run `seed_cmd` in the clone with `DATABASE_URL` exported | `psql -c 'select 1'` as the app user |
| `launch` | `sh_detached`: `bun adws/adw_<adw>.ts "<prompt>" --adw-id <remote_adw_id>` in `~/app`, log `~/app/run.log`; record pid | numeric PID |
| `monitor` | **skipped with `--detach`**: every `sync_interval_s`, `remote_session()` + `sync_db_back()`; log phase transitions as they appear; exit the loop on remote status `done`/`fail`, or when the pid is gone and the session row is terminal | remote session reached a terminal state |
| `harvest` | on the VM: `git bundle create /tmp/run.bundle <pinned_sha>..sbx/<ticket>-<id>`; rsync home to `adws/adw_data/sandbox/<vm>.bundle`; `git bundle verify`; `git fetch <bundle> 'refs/heads/sbx/*:refs/sandbox/<ticket>-<id>'` | bundle verifies; a branch tip equal to the pin logs `NOCOMMITS` instead of failing |
| `report` | print: ref to review, remote cost/tokens (from the synced db), `https_url`, run.log tail on failure, and — prominently — "VM is still running and billing: `just sandbox-rm <vm>`" | — |

`run.finish(accepted)` where accepted = remote session succeeded **and** harvest verified
(with `--detach`: launch succeeded; the engineer resumes with `just sandbox-watch <ticket>`,
which re-enters monitor→harvest→report by `--adw-id`).

Failures anywhere: report, leave everything up, print the inspect command
(`ssh <vm>.exe.xyz 'tail -50 app/run.log'`).

### Flag wiring — `templates/adws/adw_simple_sdlc.ts` (modify, entrypoint only)

```ts
options: { ..., sandbox: { type: "string" }, fresh: {type: "boolean"}, detach: {type: "boolean"} }
...
if (values.sandbox) {
  await session.cli(() => sandbox_dispatch.dispatch({
    ticket: values.sandbox!, prompt, config_path: values.config,
    adw: "simple-sdlc", flags: { fresh: values.fresh, detach: values.detach },
  }));
}
```

`main()` is untouched. In-VM the same file runs without the flag; even a mistaken `--sandbox`
inside the VM fails safe on the missing exe.dev account (credential boundary, not code).
Docstring gains the `--sandbox` usage line (SKILL.md startup parses docstrings).

---

## Part 4 — Agent credentials inside the VM

Spike-verified defaults — the VM carries one revocable credential:

- **claude_code → `CLAUDE_CODE_OAUTH_TOKEN` (default)**: the VM's `.env` gets the
  long-lived token from `claude setup-token` (host `.env`), so in-VM runs bill the Claude
  Max subscription exactly like local runs — spike-verified with an OAuth token and no
  other Anthropic config. The token is revocable and the cookbook says to revoke on
  teardown of the last sandbox. **Fallback — the key-free gateway** for zero-credential
  runs: `ANTHROPIC_BASE_URL=https://llm.int.exe.xyz`, `ANTHROPIC_API_KEY=implicit`,
  `SSSF_CC_USE_API_KEY=1` (agent_cc.ts strips the base URL by design; the flag lets it
  through). Works with no credential on the box (spike-verified, full Claude lineup
  served) but bills the exe.dev token allocation at Anthropic list rates — real per-token
  spend, so it is the fallback, not the default. Select via `remote.claude_auth:
  subscription|gateway`. Provision also pre-answers Claude Code onboarding in
  `~/.claude.json` (inkwell's 8b step) so an interactive `--resume` never blocks.
- **codex** → rsync `~/.codex/auth.json` host → VM (spike-verified: `codex exec` answers on
  the ChatGPT plan, with bun symlinked as `node`). Keyless alternative when preferred: a
  ChatGPT provider source on the LLM integration (device-code flow, one-time web/CLI setup).
- **pi** → copy the named provider keys from host `.env` + write `~/.pi/agent/models.json`
  (from the host's, if present).
- Plus `remote.env_passthrough` keys verbatim, and `DATABASE_URL` when postgres is enabled.

Repo access ships no token either: `clone_via: integration` uses the tag-attached GitHub
integration (`github.int.exe.xyz`, `--readonly` — spike-verified on a private repo). The
cookbook still states the residual risk plainly: `auth.json` is a real ChatGPT credential on
a third-party VM running an autonomous agent; prefer the keyless provider source when the
account allows it, and revoke on teardown otherwise.

### `templates/env.sample` (modify)

Add, commented: `GH_TOKEN` (fallback clone token when `clone_via: token`),
`CLAUDE_CODE_OAUTH_TOKEN` cross-reference (fallback when not using the gateway).

---

## Part 5 — Guest scripts: `templates/adws/sandbox/` (new, stamped into `adws/sandbox/`)

Stamped by the existing recursive copy, committed with the target repo, so the clone carries
them and re-provision needs no rsync.

### `provision.sh`

Idempotent, `set -euo pipefail`, step/trap error reporting, ends by touching
`/tmp/SSSF_PROVISION_READY` **as the last line** (the host polls for it — no other reliable
completion signal). Steps, each skip-if-present:

1. bun (curl installer) — **and symlink into `/usr/local/bin`**: each `ssh vm cmd` is a
   fresh non-interactive shell that reads no rc file, so a PATH export dies with the script
   (inkwell hit exactly this).
2. just (curl installer, `--to /usr/local/bin`).
3. `claude` / `codex` CLIs — only the interfaces the roster names (bun/npm global installs).
4. **postgres** (only with `--postgres`): `apt-get install -y postgresql` pinned to
   `postgres.version`, `systemctl enable --now postgresql`. This is the one deliberate apt
   dependency — inkwell measured apt at ~35s/package from the VM region, so provision prints
   a "this takes a few minutes, first boot only" notice. Then idempotent role + db creation
   as the `postgres` user.
5. Claude onboarding pre-answer (Part 4).
6. Print a version summary.

Args: `--postgres <version> <db> <user> <password>` (password local to the VM), passed by the
provision phase from `remote.postgres`. Seeding is **not** here — it needs the clone, so it
is the separate `db_seed` phase.

### `seed.sh`

Tiny wrapper the `db_seed` phase invokes: exports `DATABASE_URL`, runs `"$@"` (the
`seed_cmd`) in the repo root, prints the row-count of `pg_stat_user_tables` after as a
human-readable receipt.

Add `adws/sandbox/` to `defaults.protected_files` in the config template — the in-VM builder
must not be able to edit the scripts that provisioned its own box.

---

## Part 6 — Justfile recipes + docs

### `templates/justfile` (modify)

```just
# run the full SDLC in a fresh exe.dev VM named after the ticket
sandbox-sdlc TICKET *ARGS:
    bun adws/adw_simple_sdlc.ts --config {{config}} --sandbox {{TICKET}} "$@"

sandbox-ls:            # dispatch records × ssh exe.dev ls: name, state, url, remote run status
sandbox-watch TICKET:  # re-enter monitor→harvest→report for a --detach'd run
sandbox-cmd VM *CMD:   # escape hatch: ssh <vm>.exe.xyz 'cd app && <cmd>'
sandbox-tail VM:       # ssh tail -f app/run.log
sandbox-obs VM:        # sync_db_back once, then SSSF_DB=adws/adw_data/remote/<vm>/sssf.db just obs
sandbox-harvest TICKET:# harvest now, without waiting for the run to finish (safe, idempotent)
sandbox-rm VM:         # THE destructive one: confirms, then ssh exe.dev rm <vm>
```

`sandbox-ls` renders in TS (a small `runs_table` in `sandbox_dispatch.ts`), not a shell read
loop — inkwell's lesson about empty fields shifting columns.

### Docs

- `cookbooks/sandbox.md` (new): one-time setup (ssh key on exe.dev, wildcard known_hosts
  entry, `claude setup-token`, scoped `GH_TOKEN`), the dispatch walk-through, the credential
  boundary, the billing warning, reviewing `refs/sandbox/*`, teardown etiquette.
- `SKILL.md`: routing-table row ("run it in a sandbox / on a VM / remotely" →
  cookbooks/sandbox.md) and the `--sandbox` flag in the ADW table.
- `references/config.md`: the `remote:` block.

---

## Part 7 — Build & verify order

1. ~~Manual spike~~ **DONE 2026-08-13** — see "Spike findings" above. All unknowns
   measured; spike VM torn down. One setup item remains per target repo: create the
   `--readonly` GitHub integration + tag (web UI or an unscoped key — the scoped key
   cannot run `integrations add`).
2. `data_types.ts` `remote:` schema — `tsc --noEmit`; existing configs still parse.
3. `exe_dev.ts` against a live VM: ensure/wait/sh/detached-pid/write_env/rsync/db-backup.
   Kill the VM; `ensure_vm` boots a new one; re-run is warm.
4. `provision.sh` twice on one VM (second run near-instant, READY sentinel both times);
   postgres up, role/db idempotent.
5. `sandbox_dispatch.ts` phase-by-phase on a throwaway target repo (tiny bun app with one
   real test + a `db:setup` seed script, SSSF stamped): dispatch with a fake ticket
   `ABC-123`, watch the local trace in the visualizer, confirm the remote run in the synced
   db, review `refs/sandbox/abc-123-*`, `git log` shows exactly the run's three commits.
6. Failure paths: kill the remote pid mid-run (monitor reports fail, VM left up, run.log
   tail printed); break the seed_cmd (db_seed stops, later phases never run); `--detach`
   then `sandbox-watch`.
7. Re-dispatch the same ticket (warm reuse), then `--fresh` (new suffixed VM).
8. Stamp a fresh temp dir with `install.ts` — every new file lands; `tsc --noEmit` clean;
   `sandbox-rm` everything and confirm `ssh exe.dev ls` is empty.

## Risks / open questions

- ~~Headless subscription auth~~ **resolved by the spike**: claude_code runs keyless on the
  gateway; codex transplants (or goes keyless via a ChatGPT provider source).
- ~~`new --json` payload shape~~ **verified** (flat object; see Spike findings).
- ~~Postgres apt slowness~~ **measured at ~25s from `lon`** — no custom image needed.
- **Gateway spend is real but separate**: in-VM claude_code bills the exe.dev token
  allocation, so SSSF's per-run cost report and exe.dev's billing are two ledgers. The
  `report` phase should say so; if allocation exhaustion mid-run shows up in practice, add
  a gateway-quota probe to the health checks.
- **SSH key scoping cuts both ways**: the dispatch host's key must be allowed `new/ls/rm`
  and the target tag; per-repo integration setup needs the web UI or an unscoped key. The
  cookbook documents the per-project pattern (tag + scoped key + `--readonly` repo
  integration) as the recommended boundary.
- **Codex `auth.json` on a third-party VM** is the one real credential shipped by default:
  prefer the keyless ChatGPT provider source where enabled; otherwise revoke on teardown.
  The cookbook says this in bold.
- **Persistent VMs bill until killed** and dispatch never auto-tears-down by design — the
  report and `sandbox-ls` are the mitigation. If forgotten boxes become a pattern, add a
  `sandbox-reap` that lists VMs whose dispatch record shows a finished run.
- **Concurrent dispatches of the same ticket** collide on the VM name by design (reuse). Two
  *simultaneous* runs on one ticket are a user error the `launch` phase should detect (pid
  alive in the record → refuse without `--fresh`).

### Critical files

- Modify: `templates/adws/adw_modules/data_types.ts`, `templates/adws/adw_simple_sdlc.ts`,
  `templates/sssf.config.yaml`, `templates/env.sample`, `templates/justfile`, `SKILL.md`,
  `references/config.md`
- New: `templates/adws/adw_modules/exe_dev.ts`,
  `templates/adws/adw_modules/sandbox_dispatch.ts`,
  `templates/adws/sandbox/provision.sh`, `templates/adws/sandbox/seed.sh`,
  `cookbooks/sandbox.md`
