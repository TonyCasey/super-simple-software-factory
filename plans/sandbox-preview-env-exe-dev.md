# Sandbox preview environments: a warm-template VM a human logs into to evaluate a feature

## The target flow (user-described, 2026-08-14)

For the solv-platform project, every per-ticket VM is nearly identical, so we
stop rebuilding one from scratch each time. Instead:

1. **A golden template VM** exists, kept warm: local postgres (not Neon), the
   repo checked out, `node_modules` + the nx build cache present, the app built,
   and a demo workspace seeded so a human can log in.
2. **A ticket copies the template** (`ssh exe.dev cp`) into a per-ticket VM in
   seconds — no cold provision, install, or build.
3. **On boot the copy updates to latest staging**: fast-forward `staging`,
   branch off it, apply any new migrations, incrementally rebuild what changed.
4. **The ADW develops and tests the feature** on that branch, as today.
5. **A human goes to the VM's URL, logs in, and evaluates the running app** —
   not just the PR diff, the actual change behaving.
6. **The human merges the PR, and the merge tears the VM down.** Reviewing on the
   URL happens before merge, so the merge is the sign-off — exactly the ticket
   loop's existing merge→teardown, no separate approval step.

This is a per-ticket **preview environment**: the ticket loop's headless
run→PR orbit, plus a live app a human drives before the box dies.

## What exists vs what this plan adds

Built and verified (plans/sandbox-sdlc-exe-dev.md, plans/sandbox-ticket-loop.md):
the whole execution engine — dispatch phases, provisioning incl. postgres+seed,
tokenless clone/PR via the tag integration, credential shipping, detached
launch, monitor, harvest, teardown tooling — and the ticket orbit
(`adw_ticket_ship`: triage → VM SDLC → PR → watcher → merge → teardown).

Also built (branch `sandbox-dispatch`, 2026-08-14): **web serving** — every VM's
TLS proxy remapped per app with `share port`, gated public/private
(`remote.web {enabled,port,public}`; `exe_dev.ts` wraps
share_port/set_public/set_private/share_show; a `web` dispatch phase; a
`sandbox-web` CLI verb).

This plan adds three things on top:
- a **template lifecycle** — build a golden VM once, refresh it on a schedule;
- a **`cp`-based per-ticket path** — copy the template, update to staging, branch,
  instead of the cold provision→clone→install→build;
- a **human-evaluation gate** — serve the running app and hold teardown until a
  human signs off.

It does **not** replace the ticket loop; it is a mode of it. A ticket either
ships headless (today's path) or opens a preview a human evaluates (this path).

## Measured facts this plan stands on (spike-verified 2026-08-14, region `lon`)

**`ssh exe.dev cp <src> [name]` — the template primitive:**
- key-1 **allows** `cp` (permission probe `cp __fake__ x` returned "not found",
  not "command not allowed"). **No new SSH key is needed.** The only verbs key-1
  refuses — `billing`, `integrations attach`, `resize` — this workflow never uses.
- A copy **boots in ~4 s to sshable, independent of disk size** — `cp` is
  copy-on-write at the storage layer, so a 25 GB warm template copies as fast as
  a 1 GB one.
- The copy **keeps the source's warm disk** intact (files, directories, the
  inode-heavy `node_modules`-style trees), gets **its own `https_url` +
  `proxy_port` (8000 default)**, and with `--copy-tags` (default true) **keeps
  the tag** — so it inherits the tag's write-enabled GitHub integration
  (tokenless clone + PR) for free.
- **CRITICAL: `cp` snapshots the disk without quiescing the source.** A 1 GB file
  written without `sync` came back with a *different checksum* on the copy; after
  `sync` it matched byte-for-byte. So **before every `cp`: `sync` the source,
  `CHECKPOINT` (or stop) postgres, and ensure no build is mid-write** — or a copy
  can boot with a subtly corrupt `node_modules` or postgres data dir.
- exe.dev has **no stop/suspend/idle state** — confirmed in the CLI surface
  (`new/rm/restart/cp/rename/resize/comment`; `restart` only reboots) and the docs
  (no pause/hibernate/billing-idle slug). A VM either exists (billing) or is `rm`'d
  (disk gone); you **cannot power a VM off overnight and keep its disk**. A
  kept-warm template therefore bills continuously — managed here by a scheduled
  **`rm` at 00:00 + `template-build` at 06:00**, where the 06:00 build doubles as
  the daily staging refresh.

**Serving the real app (solv-platform = Twenty fork) through one public port:**
- Twenty is *two* services (server :3000, front :3001) but the exe.dev proxy
  exposes only **one** port. Solved by Twenty's production single-container mode:
  `twenty-server` serves the built front **and** the API on :3000, and env
  **`FRONT_AUTO_BASE_URL=true`** makes the served front resolve the API from the
  browser's origin (the proxy hostname) instead of a baked `SERVER_URL`.
- Build recipe (mirrors `packages/twenty-docker/twenty/Dockerfile`): **focused
  install** `yarn workspaces focus twenty twenty-front
  twenty-front-component-renderer twenty-ui twenty-shared twenty-sdk
  twenty-client-sdk twenty-server twenty-emails` — never full `yarn install`, it
  pulls storybook/website/zapier/e2e (+3.2 GB) and **ENOSPC**s the 25 GB disk;
  lingui extract+compile; `nx build twenty-front` (heap 6144, memory-intensive);
  `nx build twenty-server`; copy the front build → `twenty-server/dist/front`
  (server's `frontPath = join(__dirname,'front')`); `yarn database:init:prod`;
  `node dist/main` on :3000; then `share port <vm> 3000`.
- 2 cpu / 8 GB box; `resize` refused by the key. Warm cache build ≈ 5 min. A big
  swapfile eats the 25 GB disk — use ≤ 4 G, only for the front build.
- `database:init:prod` migrates but does **not** seed a demo workspace — sign-up
  on first visit works (email verification off). For the template we WILL seed,
  so evaluators land on a login, not an empty install.
- Default proxy access is **private** — an unauthenticated hit → HTTP 401 →
  `exe.dev/auth`. Good default for an in-development app holding seed data.

The full serve recipe is scripted; it becomes `sandbox/template.sh` (Stage D).

## Design decisions

- **Template = a golden VM, `cp` per ticket.** Not a custom OCI `--image` (a
  3 GB+ `node_modules` + postgres data in a registry is heavy and slow); `cp`
  clones a warm disk in seconds and is the grain of exe.dev.
- **Local postgres, not Neon, for preview VMs.** Ephemeral, isolated,
  disposable, pre-seeded — no shared-branch state, no Neon cost, instant login.
  Prod stays on Neon; preview VMs never touch it.
- **One public port via `FRONT_AUTO_BASE_URL`.** The two-service app serves
  behind the single proxied port with no per-hostname config.
- **`sync` + `CHECKPOINT` before every `cp`.** Non-negotiable — the verified
  corruption rule. Baked into the template's quiesce step (when it is idle).
- **Template torn down overnight, rebuilt for work hours.** No suspend exists, so
  the only way to stop paying is `rm`. A scheduled **`rm` at 00:00 and
  `template-build` at 06:00** gives ~6 billing-free hours a night; the 06:00 build
  *is* the daily refresh to latest staging, so it costs nothing extra. cp is free;
  per-ticket copies during work hours boot warm in seconds.
- **Human-evaluation gate before teardown.** Consistent with the ticket loop:
  auto-teardown only after human sign-off. Here the sign-off is the human having
  logged in and approved (via ticket status / PR approval / an explicit verb).
- **Eval URL private by default.** Gated behind exe.dev login; `set-public` only
  when an evaluator has no exe.dev access. An in-dev app with seed data is never
  exposed to the open internet by default.

## The two lifecycles

### A. Template — build once, refresh on a schedule

```
build:    new solv-template (tagged)
          → provision (node24, yarn4, redis, postgres)
          → clone solv-platform @ staging
          → focused install → build front+server → place front → seed demo workspace
          → quiesce (sync; psql CHECKPOINT) → leave WARM, not serving

overnight: 00:00  rm solv-template                       (zero billing until morning)
           06:00  template-build @ latest staging        (the daily refresh; ~6 min cold)

in-day:    (optional, template idle — cheaper than a rebuild if staging moved mid-day)
           git fetch; reset --hard origin/staging; yarn install iff lockfile moved;
           nx affected build; database:migrate:prod; quiesce (sync; CHECKPOINT); READY
```

The template does **not** run the server — it only holds warm artifacts + a
seeded DB on disk. Per-ticket copies start the server after updating.

### B. Per-ticket preview — cp → update → branch → develop → serve → gate → teardown

```
1. quiesce+cp:   on template: sync; CHECKPOINT   (idempotent, safe repeatedly)
                 cp solv-template sbx-plfm-123 --copy-tags   (~4 s)
2. update:       git fetch origin
                 git checkout staging && git reset --hard origin/staging
                 git checkout -b sbx/plfm-123
                 yarn install (iff lockfile changed) ; nx affected build ; database:migrate:prod
3. develop:      run the ADW on the branch  (reuse existing launch→monitor)
4. serve:        rebuild affected; place front; restart node dist/main on :3000
                 share port sbx-plfm-123 3000 ; set-private (or public)
5. serve+post:   ticket → In Review; comment VM URL + PR URL (app stays up)
6. merge=gate:   human reviews on the URL and merges the PR
                 → watcher finalize → ticket done → harvest → rm sbx-plfm-123
```

Steps 1–2 replace today's cold `vm+provision+clone+db_seed`. Step 4 is new.
Step 6 is the existing ticket-loop merge→finalize→teardown, unchanged — the
human's merge is the gate.

## Stage A — Spike (DONE, 2026-08-14)

`cp` semantics, warm-disk fidelity, boot time, tag inheritance, the sync gotcha,
and single-port serving are all measured (see "Measured facts"). All spike VMs
torn down. Nothing in this stage remains to do; it is recorded so later stages
do not re-litigate settled facts.

## Stage B — Config: `remote.template` + `remote.preview`

### `templates/adws/adw_modules/data_types.ts` (modify)

Reuse the existing `remote.web {enabled,port,public}` for expose semantics. Add:

```ts
RemoteTemplateSchema = {
  enabled:      boolean = false
  name:         string  = ""        // golden VM name, e.g. "solv-template"; "" = build cold per ticket
  branch:       string  = ""        // base branch the template tracks; "" = repo default
  build_cmds:   string[] = []       // build a servable app on the template (the template.sh recipe)
  seed_cmd:     string[] = []       // seed a demo workspace so evaluators land on a login
  quiesce_cmds: string[] = ["sync"] // run before every cp; append CHECKPOINT for postgres
}

RemotePreviewSchema = {
  enabled:      boolean = false
  from_template: string = ""        // cp source; "" falls back to a cold new VM (today's path)
  update_cmds:  string[] = []       // on-boot: fetch/ff staging, incremental install/build, migrate
  restart_cmd:  string  = ""        // restart the app so it reflects the branch
}
// No approval flag: the preview stays up serving the branch, and the human's PR
// merge is the gate — the existing watcher tears the VM down on merge.
```

`remote.web.port` (3000 for Twenty) and `remote.web.public` drive the serve step;
`template`/`preview` drive the cp lifecycle. Keep the three blocks orthogonal.

### `templates/sssf.config.yaml` (modify)

Documented, commented blocks under `remote:`, mirroring the `web:` block just
added, with the solv-platform values as the worked example (template name,
`branch: staging`, the focused-install/build `build_cmds`, the demo `seed_cmd`,
`quiesce_cmds: ["sync", "sudo -u postgres psql -c CHECKPOINT"]`).

## Stage C — `exe_dev.ts`: the `cp` wrapper

### `templates/adws/adw_modules/exe_dev.ts` (modify)

- `copy_vm(src, name, opts): VmInfo` — wraps `ssh exe.dev cp <src> <name>
  [--cpu --memory --disk] --json`, mirroring `ensure_vm`. **Verify the `cp --json`
  payload shape first** — in the spike a naive parse read null where `new --json`
  returns fields; capture the real shape (or fall back to `ls` by name, as
  `ensure_vm` already does).
- A quiesce helper is just `sh(vm, cmd)` over `remote.template.quiesce_cmds`; no
  new primitive needed. `share_port/set_public/set_private/share_show` already
  exist from the web-serving work.

## Stage D — Template build/refresh: `sandbox/template.sh` + a CLI verb

### `templates/adws/sandbox/template.sh` (new, stamped)

The verified serve recipe, made idempotent and re-runnable: provision → clone →
focused install → build front+server → place front → seed → quiesce. Two entry
modes: `build` (fresh template) and `refresh` (fetch/ff staging, incremental
install/build, migrate, re-quiesce, write READY). Never starts the server.

### `sandbox_dispatch.ts` (modify) + justfile

- `template-build` / `template-refresh <vm>` CLI verbs, run against the template.
- Two **scheduled jobs** (exe.dev routine / cron): `rm solv-template` at 00:00 and
  `template-build` at 06:00 (the daily refresh to staging). An optional in-day
  `template-refresh` handles a mid-day staging move without a full rebuild. Build
  and refresh write a READY sentinel; per-ticket cp refuses a template that is
  **absent or mid-build** (a lock the build holds) — so no one copies a half-built
  disk, and a ticket in the 00:00–06:00 window cleanly falls back to a cold
  per-ticket build (`from_template: ""`).

## Stage E — Per-ticket preview dispatch

### `templates/adws/adw_modules/sandbox_dispatch.ts` (modify)

A preview-mode branch of `dispatch_into`: when `remote.preview.enabled` and
`remote.preview.from_template` is set, the `vm/provision/clone/db_seed` phases are
replaced by:
- `template_quiesce` — run `remote.template.quiesce_cmds` on the template
  (sync + CHECKPOINT); refuse if the template is mid-refresh.
- `copy` — `copy_vm(template, preview_name)`; record it (teardown handle first,
  as always).
- `update` — `remote.preview.update_cmds`: fetch, ff staging, branch off it,
  conditional `yarn install`, nx affected build, `database:migrate:prod`.

Then the existing `launch → monitor → harvest` run on the branch, followed by:
- `serve` — `remote.preview.restart_cmd` (rebuild affected + restart on
  `remote.web.port`), then `expose_web()` (already built).

### `sandbox/preview-update.sh` (new, stamped)

The on-boot update body (fetch/ff/branch/install/build/migrate), piped over ssh
like `provision.sh` / `seed.sh`.

## Stage F — Human-evaluation gate + teardown

### `templates/adws/adw_ticket_ship.ts` (modify) / `adw_modules`

After develop+serve, the preview VM stays up serving the branch. **The merge is
the gate** — the human reviews the change *on the VM URL* and, satisfied, merges
the PR; there is no separate approval step. Concretely:
- transition the ticket to **In Review** and mirror the **VM URL + PR URL** into
  the ticket's evolving progress comment (reuse `project.progress_comments`);
- the existing VM watcher already detects the merge and runs finalize → ticket
  done → harvest → **`rm` the preview VM**. Nothing new is needed for the gate
  beyond serving the URL and posting it before merge.

The watcher's review-fix loop is unchanged — review comments still drive in-VM
fixes; the human now also has the running app to judge against, not just the diff.
An unmerged PR keeps the VM up; teardown only ever follows the merge.

## Stage G — Justfile recipes + docs

### `templates/justfile` (modify)

```
template-build            # build the golden VM (also the 06:00 daily refresh)
template-refresh          # optional in-day: fetch/ff staging, incremental rebuild, re-quiesce
preview TICKET            # cp template → update → develop → serve → post URL
preview-rm VM             # explicit teardown (confirms), like sandbox-rm
```

The scheduled `rm solv-template` (00:00) and `template-build` (06:00) are exe.dev
routines / cron, not `just` recipes a human runs. There is no `preview-approve` —
the human's PR merge is the gate, and the watcher tears the preview down.

### Docs

`sandbox/README.md` + `cookbooks/sandbox.md`: the preview flow, the template's
24/7 cost and the refresh cadence, the private-by-default eval URL, and the
`sync`+`CHECKPOINT`-before-`cp` rule as a first-class operational note.

## Stage H — Verification order

1. `copy_vm` wrapper against a fresh throwaway (confirm `cp --json` shape). Torn
   down after.
2. `template-build` end to end into `solv-template`; log in on its URL after a
   manual serve; confirm the demo workspace seeded.
3. One `preview` cycle on a real ticket: cp → update to a staging that has moved
   → branch → develop a trivial change → serve → log in and see the change →
   `preview-approve` → merge → teardown. Measure per-ticket wall-clock (target:
   copy ~4 s + update seconds-to-minutes, no cold build).
4. `template-refresh` after staging moves; confirm a subsequent preview's update
   step shrinks (fewer migrations, nx cache hits).
5. Corruption guard: a preview taken while the template is deliberately mid-write
   must be refused (lock), not silently copied.

## Cost model

| Item | Billing | Control |
|---|---|---|
| `solv-template` | ~18h/day (rm 00:00 → rebuild 06:00) | scheduled rm+build; the 06:00 build is also the staging refresh |
| per-ticket preview | until the PR merges | watcher `rm`s it on merge |
| `cp` itself | negligible (~4 s, CoW) | free to fan out |

The trade is: a template billing ~18h/day against a cold ~6-min build per ticket.
Overnight (00:00–06:00) the template is gone (zero billing) and rebuilt at 06:00 —
which also refreshes it to staging, so the refresh is free. In work hours,
per-ticket copies boot warm in seconds. A ticket started overnight has no template
and cold-builds — `from_template: ""` is exactly that path, so the config already
covers it.

## Risks / open questions

- **`cp --json` shape unverified.** Confirm field names before wrapping (Stage H.1);
  `ls`-by-name fallback already exists in `ensure_vm`.
- **Lockfile churn.** A moved `yarn.lock` forces a full focused install on the copy
  (minutes, not seconds). Unavoidable; nightly refresh keeps it rare. `update_cmds`
  should install only when the lockfile actually changed.
- **Migration/seed drift.** A migration that invalidates the template's seed could
  break login on a stale copy. The refresh re-seeds; per-ticket `database:migrate`
  handles additive migrations. Destructive ones are a refresh-cadence problem.
- **Concurrent cp during refresh.** Guarded by a refresh lock + READY sentinel; a
  cp that finds the template mid-refresh waits or errors, never copies a partial
  disk.
- **Postgres consistency on cp.** CHECKPOINT + sync is the verified pragmatic rule.
  Stopping postgres on the template during cp is stricter but competes with
  concurrent cps; CHECKPOINT+sync is the default, stop-postgres an option for a
  quiet template.
- **Eval URL exposure.** Private by default; seed data is synthetic. `set-public`
  is an explicit, per-VM, audited choice for evaluators without exe.dev access.
- **Overnight window & unmerged previews.** 00:00–06:00 there is no template, so a
  ticket then cold-builds (rare for this team). A preview VM whose PR sits unmerged
  overnight keeps billing until merge/`rm`; an optional idle-reaper (`rm` previews
  older than N hours with no PR activity) caps that — not built by default.
- **Template ownership vs `cp` permission.** `cp` and `share` are verified to work
  on VMs key-1 owns; the template is created by key-1, so copies stay in-scope.

## Critical files

- `plans/sandbox-preview-env-exe-dev.md` — this plan
- `templates/adws/adw_modules/data_types.ts` — `remote.template`, `remote.preview`
- `templates/adws/adw_modules/exe_dev.ts` — `copy_vm` (share_* already added)
- `templates/adws/adw_modules/sandbox_dispatch.ts` — preview-mode phases; template CLI verbs
- `templates/adws/adw_ticket_ship.ts` — human-evaluation gate
- `templates/adws/sandbox/template.sh` — build/refresh the golden VM (new)
- `templates/adws/sandbox/preview-update.sh` — on-boot update to staging (new)
- `templates/sssf.config.yaml` — documented `template:` / `preview:` blocks
- `templates/justfile` — `template-build`, `template-refresh`, `preview`, `preview-approve`, `preview-rm`
- scheduled `template-refresh` (exe.dev routine / cron)
