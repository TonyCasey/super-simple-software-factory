# SSSF Sandbox Dispatch

Run a full AI developer workflow (ADW) inside a throwaway [exe.dev](https://exe.dev)
VM named after a ticket, instead of on your machine:

```bash
just sandbox-sdlc ABC-123 "add a /health endpoint that reports db connectivity"
```

The laptop dispatches and observes; the VM does the work; the commits come home
as `refs/sandbox/abc-123-<id>` for you to review and merge. Nothing collides
with your checkout, your ports, or your git state — and five agents can grind
away on a ticket while you keep working.

Operator setup lives in the skill's `cookbooks/sandbox.md`; per-repo knobs in
the `remote:` block of `sssf.config.yaml`. This file explains what actually
happens when you dispatch.

## One script, two modes

There is no separate "remote SDLC" implementation. The `--sandbox` flag is a
switch inside the one ADW:

```
laptop:  bun adws/adw_simple_sdlc.ts --sandbox ABC-123 "<prompt>"
             │  flag present → the dispatch runs (the phases below)
             │  ...its launch phase starts, inside the VM:
             ▼
VM:      bun adws/adw_simple_sdlc.ts "<prompt>" --adw-id <fresh-id>
             flag absent → main() runs: plan → build → test → review → document
```

Your prompt is typed once and carried through verbatim. The `--adw-id` is a
session id the laptop mints so its monitor can find the run in the VM's trace
database. Because the VM runs the identical script, the sandbox can never
drift from what `just simple-sdlc` does locally.

## The dispatch, phase by phase

Every step is a traced phase in your **local** `sssf.db` (`just obs`); the
in-VM run writes its own trace, mirrored home as it goes.

1. **record** — a JSON handle (`adws/adw_data/sandbox/<vm>.json`) is written
   *before any resource exists*, so a crash at any later point leaves
   `sandbox-ls` / `sandbox-rm` something to clean up with.
2. **vm** — `ssh exe.dev new` boots (or reuses, warm) a VM named
   `<prefix>-<ticket>`, public URL `https://<vm>.exe.xyz`. ssh answers in
   about a second.
3. **provision** — `provision.sh` (this directory) is piped over ssh: bun,
   just, sqlite3, the agent CLIs your roster names, and — when
   `remote.postgres.enabled` — PostgreSQL with the configured role and
   database. Idempotent; ~30s cold, ~2s warm.
4. **clone** — the VM clones the repo pinned to your current HEAD and creates
   the run branch `sbx/<ticket>-<id>`. The pin becomes the **harvest
   baseline**: the run's output is measured from it. Re-dispatches
   fast-forward the branch to a newer pin; a branch carrying run commits is
   never moved backwards.
5. **factory** — if the clone lacks `adws/`, your stamped factory is rsynced
   in; `bun install` runs; the ADW module graph is verified loadable.
6. **secrets** — the VM's `.env` is written **over the ssh pipe** (never argv,
   never logs): Claude auth, codex routing, provider keys, `DATABASE_URL`.
7. **db_seed** — your repo's own `remote.postgres.seed_cmd` runs against the
   VM's postgres (`seed.sh`, this directory) and prints a row-count receipt.
8. **launch** — the same ADW script starts *detached* inside the VM under a
   freshly minted session id; its PID is recorded. The VM is now autonomous.
9. **monitor** — the laptop polls the VM's trace every `sync_interval_s`,
   mirrors it to `adws/adw_data/remote/<vm>/sssf.db` (viewable with
   `just sandbox-obs`), and logs each remote phase transition. `--detach`
   skips this; re-attach later with `just sandbox-watch`.
10. **harvest** — when the remote run ends, the VM bundles
    `baseline..run-branch` (a few KB), the laptop pulls it, verifies it, and
    fetches it into `refs/sandbox/<ticket>-<id>`. **No push ever happens** —
    the VM holds no credential that could push.
11. **report** — outcome, tokens, cost, the ref to review, and a reminder
    that the VM is still up and billing.

Inside the VM, the factory runs exactly as it would locally: planner spec
(committed), builder implementation, the code-owned test gate, cross-family
review with bounded revision rounds, code committed only after both gates are
green, then the documenter's write-up (committed). Three commits, three work
products, each in its author's own words.

## Credentials and billing

| What | Where it lives | Bills |
|---|---|---|
| Claude Code agents | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) shipped to the VM's `.env` — default `claude_auth: subscription` | Claude Max plan, flat |
| | or keyless gateway (`claude_auth: gateway`) — zero credentials on the box | exe.dev token allocation, Anthropic list rates |
| Codex agents | **no credential** — keyless provider at `llm.int.exe.xyz`, injected per-invocation (`codex_auth: gateway`, default) | exe.dev token allocation, OpenAI list rates |
| Repo clone | exe.dev GitHub integration (`clone_via: integration`, no token on the VM) or `GH_TOKEN`, piped over and shredded right after the clone | — |
| The VM itself | persistent until `just sandbox-rm` | exe.dev subscription |

Never set `codex_auth: auth_file` casually: OpenAI rotates refresh tokens, so
a `~/.codex/auth.json` shared with a VM corrupts whichever side refreshes
second — including your local `codex login`. (Measured.)

## Day-to-day commands

```bash
just sandbox-sdlc <TICKET> "<prompt>"   # the whole thing
just sandbox-ls                         # every sandbox: record, box up/gone, run status
just sandbox-tail <vm>                  # follow the in-VM run log
just sandbox-cmd <vm> 'git log -3'      # anything, inside the clone
just sandbox-obs <TICKET>               # visualizer on the mirrored remote trace
just sandbox-watch <TICKET>             # re-attach to a --detach'd run
just sandbox-harvest <TICKET>           # pull commits home NOW (idempotent, any time)
just sandbox-rm <vm>                    # THE destructive one — confirms first
```

Landing the work is deliberately human:

```bash
git log refs/sandbox/abc-123-<id>              # review what the run committed
git merge --ff-only refs/sandbox/abc-123-<id>  # land it (or branch + PR)
git push
just sandbox-rm <vm>                           # then, and only then, tear down
```

## Design spine

- The record exists before the VM; the VM exists before any credential ships.
- Every phase is idempotent — re-running a failed dispatch is always safe.
- Nothing in the machinery ever destroys a VM; a failed run leaves the box up
  because the box is the evidence.
- Commits travel home over a credential-free bundle, into `refs/sandbox/`,
  touching no local branch or working tree.
- The two irreversible acts — merging the work and destroying the VM — belong
  to the engineer alone.

The whole surface was verified end to end against a live stamped repo
(2026-08-13): two features built, reviewed, harvested, and merged entirely
from inside sandboxes. Design history and measured facts:
`plans/sandbox-sdlc-exe-dev.md` in the SSSF repo.
