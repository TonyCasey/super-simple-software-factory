/**
 * Sandbox dispatch: run an ADW inside a per-ticket exe.dev VM.
 *
 * `dispatch()` is what an ADW's `--sandbox <ticket>` flag calls instead of its
 * local main(). It is itself a traced SSSF run — every step is a kind:"code"
 * phase in the LOCAL sssf.db — while the in-VM run is a second, independent
 * session in the VM's own trace db, joined by a locally-minted adw_id.
 *
 * Phase chain: request → vm → provision → clone → factory → secrets →
 * db_seed → launch → monitor → harvest → report. With --detach the chain stops
 * after launch; `sandbox-watch` re-enters monitor/harvest later.
 *
 * Design rules carried over from the plan (plans/sandbox-sdlc-exe-dev.md):
 *   - Record before VM, VM before launch: a crash at any point leaves
 *     `sandbox-ls` and `sandbox-rm` a handle to clean up with.
 *   - Nothing here ever destroys a VM. Failures report and leave the box up —
 *     it is the evidence. Teardown is `just sandbox-rm`, a human's call.
 *   - Commits come home as a git bundle fetched into refs/sandbox/<name>; the
 *     VM holds no push credential, deliberately.
 *   - Secrets travel over the ssh pipe, never argv, never the trace.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import * as agents from "./agents.ts";
import type { RemoteConfig, SSSFConfig } from "./data_types.ts";
import { PhaseParams } from "./data_types.ts";
import * as exe_dev from "./exe_dev.ts";
import { shq } from "./exe_dev.ts";
import * as git_helper from "./git_helper.ts";
import type { Run } from "./runner.ts";
import * as session from "./session.ts";
import { engineer_name, ensure_dir, new_id, now_iso, UsageError } from "./utils.ts";

export const APP_DIR = "app"; // where the repo lands on the VM, relative to $HOME
const MONITOR_CEILING_S = 4 * 60 * 60; // a run that outlives this is a hang, not work

// ── the dispatch record ──────────────────────────────────────────────────────
// One JSON file per VM under {data_dir}/sandbox/. Written incrementally so a
// crash between any two phases still leaves a handle. Runtime state, never
// committed (install.ts gitignores the directory).

export interface SandboxRecord {
  ticket: string;
  vm_name: string;
  https_url: string;
  repo: string; // owner/name
  pinned_sha: string; // harvest baseline: HEAD at run-branch creation
  run_branch: string; // sbx/<ticket>-<remote_adw_id>
  remote_adw_id: string;
  pid: number;
  created_at: string;
  updated_at: string;
  pr_url?: string; // set by adw_ticket_ship's pr_readback
  pr_number?: number;
  watch_pid?: number; // the in-VM pr-watch daemon, when started
  watch_adw_id?: string; // its session id — finalize mirrors its cycles to the ticket
  progress_comment_id?: string; // the ticket's evolving progress comment
  web_port?: number; // internal port the HTTPS proxy is pointed at (remote.web)
}

function record_dir(cfg: SSSFConfig): string {
  return ensure_dir(join(cfg.defaults.data_dir, "sandbox"));
}

function record_path(cfg: SSSFConfig, vm_name: string): string {
  return join(record_dir(cfg), `${vm_name}.json`);
}

function load_record(cfg: SSSFConfig, vm_name: string): SandboxRecord | null {
  const path = record_path(cfg, vm_name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SandboxRecord) : null;
}

export function save_record(cfg: SSSFConfig, record: SandboxRecord): SandboxRecord {
  record.updated_at = now_iso();
  writeFileSync(record_path(cfg, record.vm_name), JSON.stringify(record, null, 2));
  return record;
}

function all_records(cfg: SSSFConfig): SandboxRecord[] {
  const dir = record_dir(cfg);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SandboxRecord);
}

/** Accepts a VM name or a ticket; a ticket must match exactly one record. */
export function find_record(cfg: SSSFConfig, handle: string): SandboxRecord {
  const records = all_records(cfg);
  const by_vm = records.find((r) => r.vm_name === handle);
  if (by_vm) return by_vm;
  const by_ticket = records.filter((r) => r.ticket.toLowerCase() === handle.toLowerCase());
  if (by_ticket.length === 1) return by_ticket[0]!;
  if (by_ticket.length > 1) {
    throw new UsageError(
      `ticket '${handle}' matches ${by_ticket.length} sandboxes — use the VM name: ` +
        by_ticket.map((r) => r.vm_name).join(", "),
    );
  }
  throw new UsageError(`no sandbox record for '${handle}' — see: just sandbox-ls`);
}

// ── naming ───────────────────────────────────────────────────────────────────

/** DNS-label form of a ticket id: ABC-123 -> abc-123. */
export function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) throw new UsageError(`'${value}' does not reduce to a usable DNS label`);
  return s;
}

function vm_name_for(remote: RemoteConfig, ticket: string, fresh: boolean): string {
  const prefix = slug(remote.vm_prefix || basename(git_helper.repo_root()));
  const name = `${prefix}-${slug(ticket)}` + (fresh ? `-${new_id(6)}` : "");
  if (name.length > 63) {
    throw new UsageError(`VM name '${name}' exceeds the 63-char hostname limit — set a shorter remote.vm_prefix`);
  }
  return name;
}

/** owner/name of the repo to clone, from config or the origin remote. */
export function derive_repo(remote: RemoteConfig): string {
  if (remote.repo) return remote.repo;
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"]);
  const url = result.stdout.toString().trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/.\s]+)/);
  if (result.exitCode !== 0 || !match) {
    throw new UsageError(
      "cannot derive the repo to clone: no GitHub origin remote — set remote.repo (owner/name) in sssf.config.yaml",
    );
  }
  return match[1]!;
}

// ── guest scripts (piped over ssh from the host's stamped copies) ────────────

function guest_script(name: string): string {
  const path = join(git_helper.repo_root(), "adws", "sandbox", name);
  if (!existsSync(path)) throw new UsageError(`missing guest script ${path} — re-run /sssf install`);
  return readFileSync(path, "utf8");
}

/** Which coding-agent interfaces the roster actually uses. */
function roster_interfaces(cfg: SSSFConfig): Set<string> {
  const set = new Set<string>([cfg.defaults.coding_agent]);
  for (const agent of cfg.agents) set.add(agent.coding_agent);
  return set;
}

// ── clone (remote script, no host-side quoting hazards) ──────────────────────
// Prints exactly one machine-readable line: "<created|reused> <base> <head>".
// Args: repo_url pin branch git_name git_email use_token

export const CLONE_SCRIPT = String.raw`
set -euo pipefail
repo_url="$1"; pin="$2"; branch="$3"; git_name="$4"; git_email="$5"; use_token="$6"
if [ "$use_token" = "token" ]; then
  # The token was piped to ~/.gh-token beforehand; the helper reads it so the
  # secret never appears in argv. Shredded below the moment the clone is done.
  git config --global credential.helper '!f(){ echo username=x-access-token; echo "password=$(cat ~/.gh-token)"; }; f'
fi
if [ -d app/.git ]; then
  # A reused clone must FOLLOW a clone_via change — the origin URL decides
  # whether pushes ride the integration (tokenless write) or github.com.
  git -C app remote set-url origin "$repo_url"
  git -C app fetch --quiet origin || echo "WARN: fetch failed — using the clone as it stands" >&2
else
  rm -rf app
  git clone --quiet "$repo_url" app
fi
[ "$use_token" = "token" ] && shred -u ~/.gh-token 2>/dev/null || true
cd app
git config user.name "$git_name"
git config user.email "$git_email"
if [ -n "$pin" ] && git rev-parse --verify --quiet "$pin^{commit}" > /dev/null; then
  git checkout --quiet "$pin"
elif [ -n "$pin" ]; then
  echo "WARN: pin $pin is not in the clone (unpushed?) — using the remote HEAD instead" >&2
fi
base="$(git rev-parse HEAD)"
if git rev-parse --verify --quiet "refs/heads/$branch" > /dev/null; then
  git switch --quiet "$branch"
  # Switching back UNDOES the pin checkout — the branch still points where it
  # did, so a re-dispatch onto a newer pin would silently run the old code.
  # Advance ff-only: it can never move backwards over commits the run made; a
  # pin that is not a descendant is a real divergence, reported and kept.
  if [ -n "$pin" ] && git rev-parse --verify --quiet "$pin^{commit}" > /dev/null; then
    git merge --ff-only --quiet "$pin" 2>/dev/null \
      || echo "WARN: $branch cannot fast-forward to $pin — it carries this run's own commits" >&2
  fi
  echo "reused $base $(git rev-parse HEAD)"
else
  git switch --quiet -c "$branch"
  echo "created $base $(git rev-parse HEAD)"
fi
`;

// ── harvest ──────────────────────────────────────────────────────────────────

export interface HarvestResult {
  commits: number;
  ref: string; // refs/sandbox/<name>, "" when NOCOMMITS
  bundle: string; // local bundle path, "" when NOCOMMITS
}

/**
 * Pull the run branch home as a bundle and fetch it into refs/sandbox/.
 * Non-destructive and idempotent — safe to run at any moment, any number of
 * times. Never touches the local working tree or any local branch.
 */
export function harvest(cfg: SSSFConfig, record: SandboxRecord): HarvestResult {
  const range = `${record.pinned_sha}..${record.run_branch}`;
  const commits = Number(exe_dev.sh(record.vm_name, `git rev-list --count ${range}`, { cwd: APP_DIR }));
  if (commits === 0) return { commits: 0, ref: "", bundle: "" };

  exe_dev.sh(record.vm_name, `git bundle create /tmp/sbx.bundle ${range}`, { cwd: APP_DIR });
  const bundle = join(record_dir(cfg), `${record.vm_name}.bundle`);
  exe_dev.rsync_from(record.vm_name, "/tmp/sbx.bundle", bundle);

  const repo_root = git_helper.repo_root();
  // The VM pins to the REMOTE's head, which a stale host checkout may never
  // have fetched (measured live on PLFM-78) — fetch before declaring the
  // bundle unverifiable.
  const have_pin = Bun.spawnSync(["git", "cat-file", "-e", record.pinned_sha], { cwd: repo_root });
  if (have_pin.exitCode !== 0) {
    Bun.spawnSync(["git", "fetch", "origin"], { cwd: repo_root });
  }
  const verify = Bun.spawnSync(["git", "bundle", "verify", bundle], { cwd: repo_root });
  if (verify.exitCode !== 0) {
    throw new Error(`bundle verify failed: ${verify.stderr.toString().trim()}`);
  }
  const ref = `refs/sandbox/${record.run_branch.replace(/^sbx\//, "")}`;
  const fetch = Bun.spawnSync(
    ["git", "fetch", bundle, `+refs/heads/${record.run_branch}:${ref}`],
    { cwd: repo_root },
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`fetching the bundle failed: ${fetch.stderr.toString().trim()}`);
  }
  return { commits, ref, bundle };
}

// ── web exposure ─────────────────────────────────────────────────────────────

export interface WebExposure {
  url: string; // the public https_url
  port: number; // the internal port the proxy now forwards to
  public: boolean; // true = open to the world; false = gated behind exe.dev login
}

/**
 * Point the VM's built-in HTTPS proxy at the app's internal port and set its
 * access. Idempotent and independent of the run lifecycle — the mapping is a
 * control-plane setting that persists on the box, so it is safe to apply before
 * the app is even listening. `port: 0` leaves the provider default (8000)
 * untouched and only (re)asserts the public/private gate. Returns the effective
 * state, read back from the control plane.
 */
export function expose_web(remote: RemoteConfig, vm_name: string): WebExposure {
  const web = remote.web;
  if (web.port > 0) exe_dev.share_port(vm_name, web.port);
  // Assert the gate every time: a reused VM may carry a previous run's setting.
  if (web.public) exe_dev.set_public(vm_name);
  else exe_dev.set_private(vm_name);
  const show = exe_dev.share_show(vm_name);
  return { url: show.url, port: show.port, public: show.status === "public" };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export interface DispatchOptions {
  ticket: string;
  prompt: string;
  adw: string; // adws/adw_<adw>.ts is launched in the VM
  config_path: string;
  fresh?: boolean;
  detach?: boolean;
  extra_args?: string[]; // appended (quoted) to the in-VM ADW invocation
  on_progress?: (line: string) => void; // milestone notes (adw_ticket_ship mirrors them to the ticket)
  handoff_files?: string[]; // host files copied to ~/ticket_attachments/ in the VM (ticket attachments)
}

export interface DispatchOutcome {
  accepted: boolean;
  reason: string;
  detached: boolean;
  record: SandboxRecord;
  final: exe_dev.RemoteSession | null; // null when detached
  harvested: HarvestResult | null; // null when detached
}

/** Standalone entry (the ADW `--sandbox` flag): own session, own exit code. */
export async function dispatch(opts: DispatchOptions): Promise<number> {
  const cfg = agents.load_config(opts.config_path);
  const run = session.ensure(cfg, null);
  const outcome = await dispatch_into(run, opts);
  return run.finish(outcome.accepted, outcome.reason);
}

/**
 * The dispatch phases, run INSIDE an existing session — this is how composed
 * ADWs (adw_ticket_ship) get the whole vm→...→harvest chain in their own
 * trace and keep control of the run's acceptance afterwards.
 */
export async function dispatch_into(run: Run, opts: DispatchOptions): Promise<DispatchOutcome> {
  const cfg = run.cfg;
  const remote = cfg.remote;
  if (remote.pr.enabled && remote.clone_via !== "integration") {
    // The tokenless WRITE path exists only on the integration host — a
    // github.com origin cloned with a read token cannot push the run branch.
    throw new UsageError(
      "remote.pr.enabled requires remote.clone_via: integration — the PR is pushed through the " +
        "write-enabled exe.dev GitHub integration; a token clone's origin cannot push.",
    );
  }

  const vm_name = vm_name_for(remote, opts.ticket, Boolean(opts.fresh));
  const repo = derive_repo(remote);
  // Visibility must never break the run — every note is fire-and-forget.
  const prog = (line: string) => {
    try {
      opts.on_progress?.(line);
    } catch {}
  };
  const interfaces = roster_interfaces(cfg);
  const host_head = git_helper.is_repo() ? git_helper.rev("HEAD") : "";

  await run.phase(
    PhaseParams({
      name: "request",
      kind: "engineer",
      owner: run.engineer,
      description: "Capture the sandbox dispatch ask",
    }),
    (ph) =>
      ph.log({
        input: `[sandbox ${opts.ticket}] ${opts.prompt.slice(0, 300)}`,
        vm: vm_name,
        repo,
        adw: opts.adw,
        pin: host_head.slice(0, 7) || "(not a git repo)",
        detach: Boolean(opts.detach),
      }),
  );

  // vm — record first, then boot, so teardown always has a handle.
  let record = await run.phase(
    PhaseParams({
      name: "vm",
      kind: "code",
      owner: "sandbox",
      description: "Write the dispatch record, boot or reuse the VM, wait for ssh",
    }),
    (ph) => {
      let rec = load_record(cfg, vm_name);
      if (rec?.pid && exe_dev.ls().some((v) => v.vm_name === vm_name) && exe_dev.pid_alive(vm_name, rec.pid)) {
        throw new Error(
          `sandbox ${vm_name} is already running adw ${rec.remote_adw_id} (pid ${rec.pid}) — ` +
            `watch it (just sandbox-watch ${opts.ticket}) or dispatch a fresh VM (--fresh)`,
        );
      }
      rec = rec ?? {
        ticket: opts.ticket,
        vm_name,
        https_url: "",
        repo,
        pinned_sha: "",
        run_branch: "",
        remote_adw_id: "",
        pid: 0,
        created_at: now_iso(),
        updated_at: now_iso(),
      };
      save_record(cfg, rec);
      const vm = exe_dev.ensure_vm(vm_name, {
        tag: remote.tag,
        cpu: remote.cpu,
        memory: remote.memory,
        disk: remote.disk,
      });
      rec.https_url = vm.https_url;
      save_record(cfg, rec);
      const seconds = exe_dev.wait_ssh(vm_name);
      ph.log({ vm: vm.vm_name, url: vm.https_url, ssh_up_in: `${seconds}s` });
      return rec;
    },
  );
  prog(`sandbox ${vm_name} up — ${record.https_url}`);

  await run.phase(
    PhaseParams({
      name: "provision",
      kind: "code",
      owner: "sandbox",
      description: "Idempotent toolchain install: bun, just, sqlite3, agent CLIs, postgres",
    }),
    (ph) => {
      const args: string[] = [];
      if (interfaces.has("claude_code")) args.push("--claude");
      if (interfaces.has("codex")) args.push("--codex");
      if (remote.pr.enabled) args.push("--gh"); // push + PR via the integration
      if (remote.postgres.enabled) {
        args.push(
          "--postgres",
          String(remote.postgres.version),
          remote.postgres.db,
          remote.postgres.user,
          remote.postgres.password,
        );
      }
      const out = exe_dev.sh_script(vm_name, guest_script("provision.sh"), args, {
        timeout_ms: 600_000,
      });
      if (!out.includes("[provision] READY")) throw new Error("provision.sh finished without READY");
      exe_dev.sh(vm_name, "test -f /tmp/SSSF_PROVISION_READY");
      ph.log({ interfaces: [...interfaces].join(", "), postgres: remote.postgres.enabled });
    },
  );
  prog(`toolchain provisioned${remote.postgres.enabled ? " (with postgres)" : ""}`);

  if (remote.web.enabled) {
    record = await run.phase(
      PhaseParams({
        name: "web",
        kind: "code",
        owner: "sandbox",
        description: "Point the VM's HTTPS proxy at the app port; set public/private access",
      }),
      (ph) => {
        const web = expose_web(remote, vm_name);
        record.web_port = web.port;
        save_record(cfg, record);
        ph.log({
          url: web.url,
          proxy_port: web.port,
          access: web.public ? "public (open to the world)" : "private (exe.dev login required)",
        });
        return record;
      },
    );
    prog(`web exposed: ${record.https_url} -> :${record.web_port} (${remote.web.public ? "public" : "private"})`);
  }

  record = await run.phase(
    PhaseParams({
      name: "clone",
      kind: "code",
      owner: "sandbox",
      description: "Clone the repo at the pinned sha; create or rejoin the run branch",
    }),
    (ph) => {
      const remote_adw_id = record.remote_adw_id || new_id(8);
      const branch = record.run_branch || `sbx/${slug(opts.ticket)}-${remote_adw_id}`;
      let clone_url: string;
      if (remote.clone_via === "integration") {
        clone_url = `https://github.int.exe.xyz/${repo}.git`;
      } else {
        clone_url = `https://github.com/${repo}.git`;
        const token = (process.env.GH_TOKEN || "").trim();
        if (!token) {
          throw new Error("remote.clone_via is 'token' but GH_TOKEN is not set in the host .env");
        }
        // Token over the pipe into a 0600 file; the clone script shreds it.
        exe_dev.sh_script(vm_name, 'umask 077 && cat > ~/.gh-token <<EOF\n' + token + "\nEOF");
      }
      const out = exe_dev.sh_script(
        vm_name,
        CLONE_SCRIPT,
        [clone_url, host_head, branch, engineer_name(), "sssf-sandbox@users.noreply.github.com", remote.clone_via],
        { timeout_ms: 600_000 },
      );
      const line = out.split("\n").pop() ?? "";
      const [state, base, head] = line.split(" ");
      if (!base || !head) throw new Error(`clone script returned no shas: ${out.slice(-300)}`);
      record.remote_adw_id = remote_adw_id;
      record.run_branch = branch;
      // Harvest baseline. Fresh branch: the sha it was created at. Reused
      // branch that fast-forwarded cleanly to the pin: the pin — the branch
      // carries no run commits, so repo commits must not count as run output.
      // Reused branch that could NOT ff (it holds run commits): keep the old
      // baseline so those commits stay inside the harvest range.
      if (state === "created") record.pinned_sha = base;
      else if (head === host_head && host_head) record.pinned_sha = head;
      else if (!record.pinned_sha) record.pinned_sha = base;
      save_record(cfg, record);
      ph.log({ branch: `${branch} (${state})`, base: record.pinned_sha.slice(0, 7), head: head.slice(0, 7) });
      return record;
    },
  );
  prog(`repo cloned — branch ${record.run_branch}`);

  await run.phase(
    PhaseParams({
      name: "factory",
      kind: "code",
      owner: "sandbox",
      description: "Copy in the SSSF factory if the clone lacks it; install ADW dependencies",
    }),
    (ph) => {
      const has_factory = exe_dev.sh(vm_name, `test -d ${APP_DIR}/adws && echo yes || echo no`) === "yes";
      if (!has_factory) {
        for (const dir of remote.adws_dirs) {
          exe_dev.rsync_to(vm_name, join(git_helper.repo_root(), dir), `${APP_DIR}/`);
        }
        // A copied-in factory is workshop equipment, not the change: exclude
        // it from git or the run's commit phase sweeps all of it (including
        // adws/node_modules) into the PR. Committed factories skip this.
        const lines = remote.adws_dirs.map((d) => `/${d.replace(/\/+$/, "")}`).join("\\n");
        exe_dev.sh(vm_name, `printf '${lines}\\n' >> .git/info/exclude`, { cwd: APP_DIR });
      }
      exe_dev.sh(vm_name, "bun install --silent", { cwd: `${APP_DIR}/adws`, timeout_ms: 300_000 });
      // No args exits 2 (usage) — proof the module graph and deps resolve.
      exe_dev.sh(
        vm_name,
        `cd ${APP_DIR} && bun adws/adw_prompt.ts > /tmp/verify.log 2>&1; ` +
          `test $? -eq 2 && echo DEPS_OK || { cat /tmp/verify.log; exit 1; }`,
      );
      ph.log({ factory: has_factory ? "from clone" : `copied (${remote.adws_dirs.join(", ")})` });
    },
  );

  if (remote.setup_cmds.length > 0) {
    await run.phase(
      PhaseParams({
        name: "setup",
        kind: "code",
        owner: "sandbox",
        description: "Repo-specific toolchain: remote.setup_cmds, in order, in the clone",
      }),
      (ph) => {
        for (const cmd of remote.setup_cmds) {
          exe_dev.sh(vm_name, cmd, { cwd: APP_DIR, timeout_ms: 1_800_000 });
        }
        ph.log({ setup_cmds: remote.setup_cmds.length });
      },
    );
    prog("repo toolchain set up (setup_cmds)");
  }

  await run.phase(
    PhaseParams({
      name: "secrets",
      kind: "code",
      owner: "sandbox",
      description: "Write the VM's .env and agent credentials, over the pipe, never argv",
    }),
    (ph) => {
      const lines: string[] = [];
      const shipped: string[] = [];
      if (interfaces.has("claude_code")) {
        if (remote.claude_auth === "subscription") {
          const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim();
          if (!token) {
            throw new Error(
              "remote.claude_auth is 'subscription' but CLAUDE_CODE_OAUTH_TOKEN is not in the host .env — " +
                "run `claude setup-token` and add it, or set remote.claude_auth: gateway",
            );
          }
          lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${token}`);
          shipped.push("CLAUDE_CODE_OAUTH_TOKEN (Max subscription billing)");
        } else {
          lines.push(
            "ANTHROPIC_BASE_URL=https://llm.int.exe.xyz",
            "ANTHROPIC_API_KEY=implicit",
            "SSSF_CC_USE_API_KEY=1",
          );
          shipped.push("exe.dev gateway (keyless, bills the exe.dev allocation)");
        }
      }
      if (interfaces.has("codex")) {
        if (remote.codex_auth === "gateway") {
          // exe.dev's documented Codex recipe: point the CLI at the LLM
          // integration, no OpenAI credential on the VM. Bills the exe.dev
          // allocation (or a connected ChatGPT provider source, if configured).
          const config_toml = [
            'model_provider = "exe-llm"',
            "",
            "[model_providers.exe-llm]",
            'name = "exe-llm"',
            'base_url = "https://llm.int.exe.xyz/v1"',
            "requires_openai_auth = false",
            "",
          ].join("\n");
          // rm -f: a VM reused across a codex_auth mode switch may carry a
          // transplanted (and by now rotation-corrupted) auth.json — the CLI
          // must not find one to attempt a refresh with.
          exe_dev.sh_script(
            vm_name,
            `mkdir -p ~/.codex && rm -f ~/.codex/auth.json && cat > ~/.codex/config.toml <<'TOML'\n${config_toml}TOML`,
          );
          lines.push("SSSF_CODEX_SKIP_AUTH_PROBE=1"); // no login exists for the probe to find
          // agent_codex runs with --ignore-user-config, which blanks the
          // config.toml provider above (kept for interactive ssh use) — this is
          // what actually routes factory codex calls through the gateway.
          lines.push("SSSF_CODEX_BASE_URL=https://llm.int.exe.xyz/v1");
          shipped.push("codex -> exe.dev gateway (keyless)");
        } else {
          // auth_file: WHOEVER REFRESHES SECOND LOSES — OpenAI rotates refresh
          // tokens, so a shared auth.json eventually corrupts the host login
          // too. Opt-in only; the gateway mode above is the safe default.
          const auth = join(process.env.HOME || "~", ".codex", "auth.json");
          if (!existsSync(auth)) {
            throw new Error("remote.codex_auth is 'auth_file' but ~/.codex/auth.json is missing — run `codex login` first");
          }
          exe_dev.push_secret_file(vm_name, auth, ".codex/auth.json");
          shipped.push("~/.codex/auth.json (ChatGPT plan — WARNING: refresh-rotation race with the host login)");
        }
      }
      for (const key of ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "OPENAI_API_KEY", ...remote.env_passthrough]) {
        const value = (process.env[key] || "").trim();
        if (value) {
          lines.push(`${key}=${value}`);
          shipped.push(key);
        }
      }
      if (remote.postgres.enabled) {
        const pg = remote.postgres;
        lines.push(`DATABASE_URL=postgres://${pg.user}:${pg.password}@127.0.0.1:5432/${pg.db}`);
        shipped.push("DATABASE_URL");
      }
      if (remote.pr.enabled) {
        // Routes the VM's gh through the exe.dev integration: tokenless
        // push/PR/threads, provided the repo's integration is WRITE-enabled.
        lines.push("GH_HOST=github.int.exe.xyz");
        shipped.push("GH_HOST -> exe.dev GitHub integration (tokenless PR)");
      }
      exe_dev.write_env(vm_name, APP_DIR, lines);
      ph.log({ shipped: shipped.join("; ") || "(nothing — roster needs no credentials)" });
    },
  );

  if (remote.postgres.enabled && remote.postgres.seed_cmd.length > 0) {
    await run.phase(
      PhaseParams({
        name: "db_seed",
        kind: "code",
        owner: "sandbox",
        description: "Run the repo's seed command against the VM's postgres",
      }),
      (ph) => {
        const pg = remote.postgres;
        const url = `postgres://${pg.user}:${pg.password}@127.0.0.1:5432/${pg.db}`;
        const out = exe_dev.sh_script(
          vm_name,
          `cd "$HOME/${APP_DIR}" || exit 1\n` + guest_script("seed.sh"),
          [url, ...pg.seed_cmd],
          // Generous: a monorepo's seed may build the server first (nx
          // database:reset dependsOn build — measured on solv-platform).
          { timeout_ms: 1_800_000 },
        );
        if (!out.includes("[seed] DONE")) throw new Error("seed.sh finished without DONE");
        ph.log({ seed: pg.seed_cmd.join(" "), receipt: out.split("\n").slice(-4).join(" | ") });
      },
    );
    prog("postgres seeded");
  }

  if ((opts.handoff_files ?? []).length > 0) {
    await run.phase(
      PhaseParams({
        name: "attachments",
        kind: "code",
        owner: "sandbox",
        description: "Hand the ticket's files into the sandbox — the VM has no ticket-tool key",
      }),
      (ph) => {
        exe_dev.sh(vm_name, "rm -rf ~/ticket_attachments && mkdir -p ~/ticket_attachments");
        for (const file of opts.handoff_files!) {
          exe_dev.rsync_to(vm_name, file, "ticket_attachments/");
        }
        ph.log({ files: opts.handoff_files!.length, dest: "~/ticket_attachments/" });
      },
    );
    prog(`${opts.handoff_files!.length} ticket attachment(s) handed into the sandbox`);
  }

  record = await run.phase(
    PhaseParams({
      name: "launch",
      kind: "code",
      owner: "sandbox",
      description: "Start the ADW detached inside the VM; record its PID",
    }),
    (ph) => {
      // A FRESH session id per launch. Re-joining the previous attempt's id
      // looks attractive (one continuous trace) but races the monitor: the
      // stale row still reads 'fail' until the relaunched process upserts it,
      // and a poll landing in that gap declares the new run dead at birth.
      record.remote_adw_id = new_id(8);
      const extra = (opts.extra_args ?? []).map(shq).join(" ");
      const cmd =
        `bun adws/adw_${opts.adw}.ts ${shq(opts.prompt)} --adw-id ${record.remote_adw_id}` +
        (extra ? ` ${extra}` : "");
      // Log OUTSIDE the repo: a log growing inside the checkout reads as an
      // agent write and trips read-only rosters' permissions gate.
      const pid = exe_dev.sh_detached(vm_name, APP_DIR, cmd, "../sssf-run.log");
      record.pid = pid;
      save_record(cfg, record);
      ph.log({ pid, adw: opts.adw, remote_adw_id: record.remote_adw_id });
      return record;
    },
  );
  prog(`${opts.adw} started in the sandbox`);

  if (opts.detach) {
    await run.phase(
      PhaseParams({
        name: "report",
        kind: "code",
        owner: "sandbox",
        description: "Detached: hand back the handles and stop here",
      }),
      (ph) =>
        ph.log({
          vm: vm_name,
          url: record.https_url,
          web: remote.web.enabled
            ? `${record.https_url} -> :${record.web_port} (${remote.web.public ? "public" : "private"})`
            : undefined,
          watch: `just sandbox-watch ${opts.ticket}`,
          note: "VM is running and billing until `just sandbox-rm " + vm_name + "`",
        }),
    );
    return { accepted: true, reason: "", detached: true, record, final: null, harvested: null };
  }

  const final = await run.phase(
    PhaseParams({
      name: "monitor",
      kind: "code",
      owner: "sandbox",
      description: "Poll the remote trace until the in-VM run reaches a terminal state",
    }),
    async (ph) => {
      const outcome = await monitor(cfg, record, (note) => {
        ph.log(note);
        if (note.remote_phase) prog(`${opts.adw}: phase ${note.remote_phase}`);
        if (note.remote_terminal) prog(`${opts.adw} finished: ${note.remote_terminal}`);
      });
      return outcome;
    },
  );

  const harvested = await run.phase(
    PhaseParams({
      name: "harvest",
      kind: "code",
      owner: "sandbox",
      description: "Bundle the run's commits home into refs/sandbox/ — no push credential involved",
    }),
    (ph) => {
      const result = harvest(cfg, record);
      ph.log(
        result.commits === 0
          ? { harvest: "NOCOMMITS — the run committed nothing" }
          : { commits: result.commits, ref: result.ref, bundle: result.bundle },
      );
      return result;
    },
  );

  const accepted = final.status === "success";
  await run.phase(
    PhaseParams({
      name: "report",
      kind: "code",
      owner: "sandbox",
      description: "The run's outcome, cost, and the one decision left: teardown",
    }),
    (ph) => {
      const payload: Record<string, unknown> = {
        remote_status: final.status,
        remote_tokens: final.total_tokens,
        remote_cost: final.total_cost.toFixed(4),
        review: harvested.ref ? `git log ${harvested.ref}` : "(no commits to review)",
        url: record.https_url,
        teardown: `just sandbox-rm ${vm_name}   <- VM is still running and billing`,
      };
      if (remote.web.enabled) {
        payload.web = `${record.https_url} -> :${record.web_port} (${remote.web.public ? "public" : "private"})`;
      }
      if (!accepted) {
        payload.run_log_tail = exe_dev.sh(vm_name, "tail -n 15 ../sssf-run.log || true", { cwd: APP_DIR }).slice(-1500);
      }
      ph.log(payload);
    },
  );

  return {
    accepted,
    reason: `remote run ended '${final.status}'`,
    detached: false,
    record,
    final,
    harvested,
  };
}

// ── monitor loop (shared by dispatch and the watch CLI) ──────────────────────

async function monitor(
  cfg: SSSFConfig,
  record: SandboxRecord,
  log: (payload: Record<string, unknown>) => void,
): Promise<exe_dev.RemoteSession> {
  const local_db = join(ensure_dir(join(cfg.defaults.data_dir, "remote", record.vm_name)), "sssf.db");
  const started = Date.now();
  let last_phase = "";
  let seen_running = false;
  for (;;) {
    if ((Date.now() - started) / 1000 > MONITOR_CEILING_S) {
      throw new Error(`remote run still not terminal after ${MONITOR_CEILING_S / 3600}h — inspect: just sandbox-tail ${record.vm_name}`);
    }
    const rs = exe_dev.remote_session(record.vm_name, APP_DIR, cfg.observability.db, record.remote_adw_id);
    if (rs) {
      if (rs.status === "running") seen_running = true;
      if (rs.latest_phase && rs.latest_phase !== last_phase) {
        last_phase = rs.latest_phase;
        log({ remote_phase: `${rs.latest_phase} (#${rs.phases})`, tokens: rs.total_tokens });
      }
      try {
        exe_dev.sync_db_back(record.vm_name, APP_DIR, cfg.observability.db, local_db);
      } catch {
        // a sync miss is cosmetic; the next tick retries
      }
      if (rs.status !== "running") {
        // Fresh launches mint a new session id, but a watch re-attaching to an
        // id that was ever re-launched can still read a stale terminal row
        // before the process upserts it. A terminal status is only authoritative
        // once the run was SEEN running — or once the process is actually gone.
        if (!seen_running && (Date.now() - started) / 1000 < 90 && exe_dev.pid_alive(record.vm_name, record.pid)) {
          await Bun.sleep(cfg.remote.sync_interval_s * 1000);
          continue;
        }
        log({ remote_terminal: rs.status, synced_trace: local_db });
        return rs;
      }
    } else if (!exe_dev.pid_alive(record.vm_name, record.pid)) {
      const tail = exe_dev.sh(record.vm_name, "tail -n 15 ../sssf-run.log || true", { cwd: APP_DIR }).slice(-1500);
      throw new Error(`the in-VM ADW died before minting its session. run.log tail:\n${tail}`);
    }
    await Bun.sleep(cfg.remote.sync_interval_s * 1000);
  }
}

// ── management CLI (justfile sandbox-* recipes) ──────────────────────────────
// Untraced by design: ls/watch/harvest/sync are readbacks and pulls, not runs.

function cli_ls(cfg: SSSFConfig): void {
  const live = new Set(exe_dev.ls().map((vm) => vm.vm_name));
  const rows = all_records(cfg).map((r) => {
    const up = live.has(r.vm_name);
    const rs = up ? exe_dev.remote_session(r.vm_name, APP_DIR, cfg.observability.db, r.remote_adw_id) : null;
    return {
      VM: r.vm_name,
      TICKET: r.ticket,
      BOX: up ? "up" : "gone",
      RUN: rs ? `${rs.status} (${rs.phases} phases)` : r.remote_adw_id ? "?" : "-",
      CREATED: r.created_at.slice(0, 16),
    };
  });
  if (!rows.length) {
    console.log("no sandbox records. Dispatch one:  just sandbox-sdlc ABC-123 \"<prompt>\"");
    return;
  }
  console.table(rows);
  console.log("teardown is always explicit:  just sandbox-rm <VM>");
}

async function cli_watch(cfg: SSSFConfig, handle: string): Promise<number> {
  const record = find_record(cfg, handle);
  console.log(`watching ${record.vm_name} (adw ${record.remote_adw_id}) every ${cfg.remote.sync_interval_s}s ...`);
  const final = await monitor(cfg, record, (p) => console.log(new Date().toISOString(), p));
  const result = harvest(cfg, record);
  console.log(
    result.commits === 0
      ? "harvest: NOCOMMITS — the run committed nothing"
      : `harvest: ${result.commits} commit(s) -> ${result.ref}`,
  );
  console.log(`remote run: ${final.status}, ${final.total_tokens} tokens, $${final.total_cost.toFixed(4)}`);
  console.log(`VM is still running and billing:  just sandbox-rm ${record.vm_name}`);
  return final.status === "success" ? 0 : 1;
}

function cli_harvest(cfg: SSSFConfig, handle: string): void {
  const record = find_record(cfg, handle);
  const result = harvest(cfg, record);
  console.log(
    result.commits === 0
      ? "NOCOMMITS — the run branch has nothing past the baseline"
      : `${result.commits} commit(s) fetched into ${result.ref}\n  review:  git log ${result.ref}\n  bundle:  ${result.bundle}`,
  );
}

function cli_sync(cfg: SSSFConfig, handle: string): void {
  const record = find_record(cfg, handle);
  const local_db = join(ensure_dir(join(cfg.defaults.data_dir, "remote", record.vm_name)), "sssf.db");
  exe_dev.sync_db_back(record.vm_name, APP_DIR, cfg.observability.db, local_db);
  console.log(local_db);
}

/** Expose (or re-expose) a running VM's web app. CLI args override remote.web. */
function cli_web(
  cfg: SSSFConfig,
  handle: string,
  port_arg: string | undefined,
  want_public: boolean,
  want_private: boolean,
): number {
  if (want_public && want_private) {
    console.error("pass at most one of --public / --private");
    return 2;
  }
  const record = find_record(cfg, handle);
  const port = port_arg !== undefined ? Number(port_arg) : cfg.remote.web.port;
  if (port_arg !== undefined && (!Number.isInteger(port) || port <= 0)) {
    console.error(`port must be a positive integer, got '${port_arg}'`);
    return 2;
  }
  const is_public = want_public ? true : want_private ? false : cfg.remote.web.public;
  const web = expose_web({ ...cfg.remote, web: { enabled: true, port, public: is_public } }, record.vm_name);
  record.web_port = web.port;
  save_record(cfg, record);
  console.log(
    `${web.url} -> :${web.port} (${web.public ? "public — anyone with the URL" : "private — exe.dev login required"})`,
  );
  return 0;
}

function cli_rm(cfg: SSSFConfig, vm_name: string, yes: boolean): number {
  if (!all_records(cfg).some((r) => r.vm_name === vm_name)) {
    console.error(`no sandbox record for VM '${vm_name}' — sandbox-rm takes the exact VM name from sandbox-ls`);
    return 2;
  }
  if (!yes) {
    console.error(
      `sandbox-rm destroys ${vm_name} AND its disk — commits not harvested are gone.\n` +
        `Harvest first (just sandbox-harvest ${vm_name}), then re-run with --yes.`,
    );
    return 2;
  }
  exe_dev.rm(vm_name);
  console.log(`${vm_name} deleted. The dispatch record and any harvested refs/bundles remain.`);
  return 0;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", default: "adws/adw_sssf_config/sssf.config.yaml" },
      yes: { type: "boolean", default: false },
      public: { type: "boolean", default: false },
      private: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [command, handle] = positionals;
  const usage =
    "usage: bun adws/adw_modules/sandbox_dispatch.ts <ls | watch <ticket|vm> | harvest <ticket|vm> | " +
    "sync <ticket|vm> | web <ticket|vm> [port] [--public|--private] | rm <vm> --yes> [--config PATH]";
  await session.cli(async () => {
    const cfg = agents.load_config(values.config);
    switch (command) {
      case "ls":
        cli_ls(cfg);
        return 0;
      case "watch":
        if (!handle) throw new UsageError(usage);
        return await cli_watch(cfg, handle);
      case "harvest":
        if (!handle) throw new UsageError(usage);
        cli_harvest(cfg, handle);
        return 0;
      case "sync":
        if (!handle) throw new UsageError(usage);
        cli_sync(cfg, handle);
        return 0;
      case "web":
        if (!handle) throw new UsageError(usage);
        return cli_web(cfg, handle, positionals[2], values.public, values.private);
      case "rm":
        if (!handle) throw new UsageError(usage);
        return cli_rm(cfg, handle, values.yes);
      default:
        throw new UsageError(usage);
    }
  });
}
