/**
 * What an agent may CHANGE, enforced in code after the fact.
 *
 * `tools:` is a capability list, not a sandbox, and two holes make it
 * unenforceable on its own:
 *
 *   * `bash` runs anything. A builder handed bash to run a test suite can also
 *     run `git checkout adws/` — which is not hypothetical: one did, discarding
 *     uncommitted changes to the very quality check it was about to be judged by.
 *   * `write` reaches any path, not just the one report file an agent was given
 *     it for. A reviewer configured with "no edit, so it cannot quietly fix"
 *     could still rewrite the code it was reviewing.
 *
 * So permission is verified the way every other claim in this system is —
 * after the fact, against the repo itself. `snapshot()` fingerprints the working
 * tree's change-set before an agent runs; `enforce()` compares it afterwards and
 * fails the phase if the agent touched anything outside its allowlist.
 *
 * Comparing change-sets, rather than watching for writes, is what catches the
 * `git checkout` case: a path that was modified before the agent ran and is clean
 * afterwards has been reverted, and a reversion is a modification. Appearing,
 * disappearing, and changing all count.
 *
 * A breach is NOT a gate violation. Gates are for work an agent can be asked to
 * redo; a breach cannot be corrected by re-prompting, because the write already
 * happened. It aborts the phase and names every offending path.
 *
 * Two keys drive it, both in sssf.config.yaml:
 *     defaults.protected_files   paths no agent may touch unless it names them itself
 *     agents[].writes      null = unrestricted · [] = read-only · [...] = only these
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";

import type { AgentConfig, Phase, SSSFConfig } from "./data_types.ts";

/** An agent modified a path it was not permitted to modify. */
export class PermissionBreach extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionBreach";
  }
}

function _git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/**
 * Fingerprint every path the working tree currently differs on.
 *
 * Tracked files carry their numstat counts, so an edit to an already-dirty
 * file still registers as a change. Untracked files are listed by name.
 * Gitignored paths never appear, which is why the session runtime under
 * `data_dir` — where handoff files legitimately land — needs no special case.
 */
export function snapshot(run: any): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const line of _git(["diff", "HEAD", "--numstat"], run.repo_root).split("\n")) {
    const fields = line.split("\t");
    if (fields.length >= 3) {
      const path = fields[fields.length - 1]!.trim();
      fingerprints[path] = `${fields[0]},${fields[1]}`;
    }
  }
  for (const line of _git(
    ["ls-files", "--others", "--exclude-standard"],
    run.repo_root,
  ).split("\n")) {
    if (line.trim()) fingerprints[line.trim()] = "untracked";
  }
  return fingerprints;
}

/** Every path whose state differs — appeared, vanished, or was rewritten. */
export function changed_paths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p]).sort();
}

/**
 * Translate a pattern, with `*` stopping at a path separator.
 *
 * A permissive glob would let `*` cross `/`, which quietly widens every pattern:
 * `adws/adw_*.ts` would match `adws/adw_data/sessions/x/y.ts` as well as the
 * ADW scripts it means. `**` is the way to say "cross directories".
 */
function _glob(pattern: string): RegExp {
  const out: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (pattern.startsWith("**", i)) {
      out.push(".*");
      i += 2;
    } else if (char === "*") {
      out.push("[^/]*");
      i += 1;
    } else if (char === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      out.push(char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      i += 1;
    }
  }
  return new RegExp(`^(?:${out.join("")})$`);
}

function _matches(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern); // directory prefix
  if (pattern.includes("*") || pattern.includes("?")) return _glob(pattern).test(path);
  return path === pattern;
}

/**
 * The session runtime, which EVERY agent must be able to write.
 *
 * `context_handoff/` is the one place agents hand work to each other, and an
 * agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
 * Scout writes its findings there, the reviewer its review, the planner its
 * plan — a read-only agent is read-only with respect to the REPO, never with
 * respect to its own report.
 *
 * This is granted from `data_dir` rather than left to .gitignore. The runtime
 * is normally ignored, so it never even appears in a snapshot — but an agent's
 * ability to record its work must not hang on a gitignore entry that someone
 * can delete or that a changed `data_dir` can outgrow.
 */
export function always_writable(cfg: SSSFConfig): string[] {
  return [cfg.defaults.data_dir.replace(/\/+$/, "") + "/"];
}

/** Session runtime first, then the agent's own list, then what is protected. */
export function permitted(path: string, agent: AgentConfig, cfg: SSSFConfig): boolean {
  if (always_writable(cfg).some((p) => _matches(path, p))) return true;
  if ((agent.writes ?? []).some((p) => _matches(path, p))) return true;
  // naming a path is what unlocks a protected one
  if (cfg.defaults.protected_files.some((p) => _matches(path, p))) return false;
  return agent.writes === null; // null = unrestricted, [] = no repo writes
}

/**
 * Undo one unauthorized change. Returns a word describing what happened.
 *
 * Only changes the agent INTRODUCED are undone. A path that was already dirty
 * when the agent started is left exactly as it is: the operator had
 * uncommitted work there, and discarding it to tidy up would be the same harm
 * this module exists to prevent, committed by the cleanup instead of the agent.
 */
function _roll_back(
  run: any,
  path: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  if (path in before) {
    // Already dirty beforehand. If it is gone from the diff now, the agent
    // reverted an engineer's uncommitted work and the content is not ours
    // to reconstruct — say so loudly rather than pretend it was handled.
    return path in after
      ? "left as-is (was already modified)"
      : "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)";
  }
  if (after[path] === "untracked") {
    try {
      unlinkSync(join(run.repo_root, path));
      return "deleted";
    } catch (error) {
      return `could not delete (${error})`;
    }
  }
  const result = Bun.spawnSync(["git", "checkout", "--", path], { cwd: run.repo_root });
  return result.exitCode === 0 ? "rolled back" : "could not roll back";
}

/**
 * Compare the tree against `before`; undo and throw if the agent overstepped.
 *
 * Returns the paths it legitimately changed, so the trace records what an
 * agent actually touched rather than only what it claimed in its envelope.
 *
 * Detection alone would leave the repo holding the unauthorized change while
 * reporting a failure, so anything the agent introduced outside its allowlist
 * is rolled back before the phase dies. What it cannot undo, it names.
 */
export function enforce(
  run: any,
  _phase: Phase,
  agent: AgentConfig,
  before: Record<string, string>,
): string[] {
  const after = snapshot(run);
  const touched = changed_paths(before, after);
  const breaches = touched.filter((p) => !permitted(p, agent, run.cfg));
  if (!breaches.length) return touched;

  const outcomes = breaches.map((p) => [p, _roll_back(run, p, before, after)] as const);
  const scope =
    agent.writes === null
      ? `barred from ${JSON.stringify(run.cfg.defaults.protected_files)}`
      : agent.writes.length === 0
        ? "read-only"
        : `limited to ${JSON.stringify(agent.writes)}`;
  const detail = outcomes.map(([p, outcome]) => `  - ${p} — ${outcome}`).join("\n");
  throw new PermissionBreach(
    `${agent.name} is ${scope} but modified ${breaches.length} path(s):\n${detail}`,
  );
}
