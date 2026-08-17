/**
 * exe.dev primitives: the only module that knows the sandbox provider exists.
 *
 * The exe.dev API is SSH — control plane `ssh exe.dev <verb>`, data plane
 * `ssh <vm>.exe.xyz "<cmd>"`. Everything here wraps those two shapes with the
 * quoting, detachment, and secret-handling rules measured on real VMs
 * (2026-08-13 spike, recorded in plans/sandbox-sdlc-exe-dev.md):
 *
 *   - `new --json` returns a FLAT object ({vm_name, https_url, ssh_dest, ...}).
 *   - ssh answers ~1s after `new`; 60s is a generous ready ceiling.
 *   - Detaching needs all three pieces (nohup, redirect, </dev/null) or ssh
 *     never returns; the OUTER </dev/null stops ssh eating the caller's stdin.
 *   - Secrets travel over the ssh pipe, never argv (argv is visible in ps).
 */

import { readFileSync } from "node:fs";

import { operator_env } from "./utils.ts";

export interface VmInfo {
  vm_name: string;
  https_url: string;
  ssh_dest: string;
  proxy_port: number; // internal port https_url forwards to; provider default 8000
}

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];

class ExeDevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExeDevError";
  }
}

function _run(argv: string[], opts: { stdin?: string; timeout_ms?: number } = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(argv, {
    env: operator_env(),
    stdin: opts.stdin === undefined ? undefined : Buffer.from(opts.stdin),
    timeout: opts.timeout_ms,
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Single-quote a string for a POSIX shell — the remote side re-parses argv. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function _host(vm: string): string {
  return vm.endsWith(".exe.xyz") ? vm : `${vm}.exe.xyz`;
}

// ── control plane ────────────────────────────────────────────────────────────

export function ls(): VmInfo[] {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "ls", "--json"]);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev ls failed: ${r.stderr.trim()}`);
  const parsed = JSON.parse(r.stdout) as { vms?: VmInfo[] };
  return parsed.vms ?? [];
}

/**
 * Reuse the VM when it exists (persistent disk = warm re-dispatch), else boot
 * one. Flags mirror `ssh exe.dev new`; empty/zero values are omitted so the
 * provider defaults apply. With a tag-scoped SSH key, `tag` is mandatory —
 * exe.dev refuses any other value, so the error is surfaced verbatim.
 */
export function ensure_vm(
  name: string,
  opts: { tag?: string; cpu?: number; memory?: string; disk?: string } = {},
): VmInfo {
  const existing = ls().find((vm) => vm.vm_name === name);
  if (existing) return existing;

  const argv = ["ssh", ...SSH_OPTS, "exe.dev", "new", "--name", name, "--json"];
  if (opts.tag) argv.push("--tag", opts.tag);
  if (opts.cpu) argv.push("--cpu", String(opts.cpu));
  if (opts.memory) argv.push("--memory", opts.memory);
  if (opts.disk) argv.push("--disk", opts.disk);

  const r = _run(argv);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev new ${name} failed: ${(r.stdout + r.stderr).trim()}`);
  // Verified flat shape; fall back to re-reading `ls` if it ever changes.
  const parsed = JSON.parse(r.stdout) as Partial<VmInfo>;
  if (parsed.vm_name) {
    return {
      vm_name: parsed.vm_name,
      https_url: parsed.https_url ?? `https://${parsed.vm_name}.exe.xyz`,
      ssh_dest: parsed.ssh_dest ?? `${parsed.vm_name}.exe.xyz`,
      proxy_port: parsed.proxy_port ?? 8000,
    };
  }
  const found = ls().find((vm) => vm.vm_name === name);
  if (!found) throw new ExeDevError(`created ${name} but cannot find it in 'ls --json'`);
  return found;
}

/** Destroy a VM AND its persistent disk. The one destructive call in this file. */
export function rm(name: string): void {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "rm", name]);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev rm ${name} failed: ${r.stderr.trim()}`);
}

// ── HTTPS proxy (web serving) ────────────────────────────────────────────────
// Every VM is fronted by an exe.dev TLS reverse proxy at `https_url`
// (`https://<name>.exe.xyz`) that forwards to ONE internal port — provider
// default 8000. These `share` verbs remap that port and set who may reach it;
// the tag-scoped key allows them (unlike billing / integrations attach).
// Measured 2026-08-14: a remap takes effect immediately and does not require the
// target port to be listening yet — the mapping is a setting, not a health check.

export interface WebShare {
  port: number; // the internal port the proxy currently forwards to
  status: string; // "public" (open) | "private" (exe.dev login required)
  url: string; // the public https_url
}

/** Point the VM's HTTPS proxy at `port` on the box. */
export function share_port(vm: string, port: number): void {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "share", "port", vm, String(port)]);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev share port ${vm} ${port} failed: ${(r.stdout + r.stderr).trim()}`);
}

/** Open the HTTPS proxy to anyone with the URL (no exe.dev auth). */
export function set_public(vm: string): void {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "share", "set-public", vm]);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev share set-public ${vm} failed: ${(r.stdout + r.stderr).trim()}`);
}

/** Restrict the HTTPS proxy to authenticated exe.dev users (the box's default). */
export function set_private(vm: string): void {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "share", "set-private", vm]);
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev share set-private ${vm} failed: ${(r.stdout + r.stderr).trim()}`);
}

/** Read the proxy's current port and access status. */
export function share_show(vm: string): WebShare {
  const r = _run(["ssh", ...SSH_OPTS, "exe.dev", "share", "show", vm, "--json"]);
  // exe.dev returns `{"error": ...}` on stdout, not stderr — surface both.
  if (r.code !== 0) throw new ExeDevError(`ssh exe.dev share show ${vm} failed: ${(r.stdout + r.stderr).trim()}`);
  const p = JSON.parse(r.stdout) as { port?: number; status?: string; url?: string };
  return { port: p.port ?? 0, status: p.status ?? "", url: p.url ?? `https://${vm}.exe.xyz` };
}

// ── data plane ───────────────────────────────────────────────────────────────

export function wait_ssh(vm: string, timeout_s = 60): number {
  const started = Date.now();
  while (Date.now() - started < timeout_s * 1000) {
    const r = _run(["ssh", ...SSH_OPTS, "-o", "ConnectTimeout=5", _host(vm), "true"]);
    if (r.code === 0) return Math.round((Date.now() - started) / 1000);
    Bun.sleepSync(2000);
  }
  throw new ExeDevError(`ssh never answered on ${_host(vm)} within ${timeout_s}s`);
}

/** Run a remote command synchronously; throws on non-zero with stderr attached. */
export function sh(vm: string, cmd: string, opts: { cwd?: string; timeout_ms?: number } = {}): string {
  const remote = opts.cwd ? `cd ${shq(opts.cwd)} && ${cmd}` : cmd;
  const r = _run(["ssh", ...SSH_OPTS, _host(vm), remote], { timeout_ms: opts.timeout_ms });
  if (r.code !== 0) {
    throw new ExeDevError(`ssh ${vm} '${cmd.slice(0, 120)}' exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r.stdout.trim();
}

/**
 * Pipe a whole script over stdin (`bash -s -- <args>`), so nothing in it has to
 * survive two layers of shell quoting. Args land as remote $1..$n.
 */
export function sh_script(
  vm: string,
  script: string,
  args: string[] = [],
  opts: { timeout_ms?: number } = {},
): string {
  const argv = ["ssh", ...SSH_OPTS, _host(vm), "bash", "-s", "--", ...args.map(shq)];
  const r = _run(argv, { stdin: script, timeout_ms: opts.timeout_ms });
  if (r.code !== 0) {
    throw new ExeDevError(`remote script on ${vm} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 4000)}`);
  }
  return r.stdout.trim();
}

/**
 * Launch a remote command detached and return its PID. All three detachment
 * pieces are mandatory or ssh never returns; `\$!` is expanded by the REMOTE
 * shell. `tail -n 1` guards the capture against stray remote stdout, and a
 * non-numeric answer means the remote printed an error where the PID should be.
 */
export function sh_detached(vm: string, cwd: string, cmd: string, log: string): number {
  const remote = `cd ${shq(cwd)} && ( nohup ${cmd} > ${shq(log)} 2>&1 < /dev/null & echo $! )`;
  const r = _run(["ssh", ...SSH_OPTS, _host(vm), remote], { stdin: "" });
  const pid = (r.stdout.trim().split("\n").pop() ?? "").trim();
  if (r.code !== 0 || !/^\d+$/.test(pid)) {
    throw new ExeDevError(`detached launch on ${vm} expected a PID, got: ${(pid || r.stderr.trim()).slice(0, 500)}`);
  }
  return Number(pid);
}

export function pid_alive(vm: string, pid: number): boolean {
  return _run(["ssh", ...SSH_OPTS, _host(vm), `kill -0 ${pid} 2>/dev/null`]).code === 0;
}

/**
 * Write `<dir>/.env` on the VM from key=value lines. The content travels over
 * the ssh pipe — never argv on either side, so never visible in ps — and umask
 * runs before the redirect so the file is never briefly world-readable.
 */
export function write_env(vm: string, dir: string, lines: string[]): void {
  const r = _run(
    ["ssh", ...SSH_OPTS, _host(vm), `umask 077 && mkdir -p ${shq(dir)} && cat > ${shq(`${dir}/.env`)}`],
    { stdin: lines.join("\n") + "\n" },
  );
  if (r.code !== 0) throw new ExeDevError(`writing ${dir}/.env on ${vm} failed: ${r.stderr.trim()}`);
  const stat = sh(vm, `stat -c '%a %s' ${shq(`${dir}/.env`)}`);
  if (!stat.startsWith("600")) throw new ExeDevError(`${dir}/.env on ${vm} has mode ${stat} — expected 600`);
}

/** Copy a single local file to the VM at mode 600, via the pipe (scp-free, argv-free). */
export function push_secret_file(vm: string, local_path: string, remote_path: string): void {
  const r = _run(
    [
      "ssh",
      ...SSH_OPTS,
      _host(vm),
      `umask 077 && mkdir -p $(dirname ${shq(remote_path)}) && cat > ${shq(remote_path)}`,
    ],
    { stdin: readFileSync(local_path, "utf8") },
  );
  if (r.code !== 0) throw new ExeDevError(`pushing ${remote_path} to ${vm} failed: ${r.stderr.trim()}`);
}

const RSYNC_EXCLUDES = ["node_modules", ".venv", "__pycache__", "adw_data/sessions", "sssf.db*"];

export function rsync_to(vm: string, src: string, dest: string, excludes: string[] = RSYNC_EXCLUDES): void {
  const argv = [
    "rsync",
    "-az",
    "-e",
    `ssh ${SSH_OPTS.join(" ")}`,
    ...excludes.flatMap((e) => ["--exclude", e]),
    src,
    `${_host(vm)}:${dest}`,
  ];
  const r = _run(argv);
  if (r.code !== 0) throw new ExeDevError(`rsync to ${vm}:${dest} failed: ${r.stderr.trim()}`);
}

export function rsync_from(vm: string, src: string, dest: string): void {
  const r = _run(["rsync", "-az", "-e", `ssh ${SSH_OPTS.join(" ")}`, `${_host(vm)}:${src}`, dest]);
  if (r.code !== 0) throw new ExeDevError(`rsync from ${vm}:${src} failed: ${r.stderr.trim()}`);
}

// ── remote trace readback ────────────────────────────────────────────────────

export interface RemoteSession {
  status: string; // running | success | fail
  total_tokens: number;
  total_cost: number;
  phases: number;
  latest_phase: string;
}

/** One sqlite3 query over ssh; null until the remote run has minted its session. */
export function remote_session(vm: string, dir: string, db: string, adw_id: string): RemoteSession | null {
  const sql =
    `select s.status, s.total_tokens, s.total_cost,` +
    ` (select count(*) from phases p where p.adw_id=s.adw_id),` +
    ` (select p.name from phases p where p.adw_id=s.adw_id order by p.seq desc limit 1)` +
    ` from sessions s where s.adw_id='${adw_id}'`;
  const r = _run([
    "ssh",
    ...SSH_OPTS,
    _host(vm),
    `cd ${shq(dir)} && test -f ${shq(db)} && sqlite3 -separator '|' ${shq(db)} ${shq(sql)}`,
  ]);
  const line = r.stdout.trim();
  if (r.code !== 0 || !line) return null;
  const [status, tokens, cost, phases, latest] = line.split("|");
  return {
    status: status ?? "",
    total_tokens: Number(tokens ?? 0),
    total_cost: Number(cost ?? 0),
    phases: Number(phases ?? 0),
    latest_phase: latest ?? "",
  };
}

/**
 * WAL-safe copy of the remote trace db: remote `.backup` first (a consistent
 * snapshot even mid-write), then rsync the snapshot home.
 */
export function sync_db_back(vm: string, dir: string, db: string, local_path: string): void {
  sh(vm, `sqlite3 ${shq(db)} ".backup /tmp/sssf-sync.db"`, { cwd: dir });
  rsync_from(vm, "/tmp/sssf-sync.db", local_path);
}
