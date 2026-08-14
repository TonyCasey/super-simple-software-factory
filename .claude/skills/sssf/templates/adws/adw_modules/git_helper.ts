/** Low-level git operations for code phases. All low-level logic lives in adw_modules. */

function _git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

export function current_branch(): string {
  return _git("rev-parse", "--abbrev-ref", "HEAD");
}

export function create_branch(name: string): string {
  _git("checkout", "-b", name);
  return name;
}

export function is_repo(): boolean {
  return Bun.spawnSync(["git", "rev-parse", "--git-dir"]).exitCode === 0;
}

/**
 * Absolute root of the codebase — where agents are spawned to work.
 *
 * The git toplevel when there is one, else the process cwd (ADWs run fine in a
 * non-git dir; only a commit phase requires a repo). Always absolute, so it is
 * safe to hand to a subprocess regardless of where the ADW was launched from.
 */
export function repo_root(): string {
  if (is_repo()) return _git("rev-parse", "--show-toplevel");
  return process.cwd();
}

/** Stage the working tree and commit it. Returns the new short sha. */
export function commit_all(message: string): string {
  if (!is_repo()) {
    throw new Error(
      "not a git repository — a commit phase needs one. Run `git init` in the " +
        "repo root (and make a first commit) before running an ADW that commits.",
    );
  }
  _git("add", "-A");
  if (!_git("status", "--porcelain")) {
    throw new Error("nothing to commit — the preceding phases changed no files");
  }
  _git("commit", "-m", message);
  return _git("rev-parse", "--short", "HEAD");
}

/**
 * commit_all, but an already-clean tree returns "" instead of throwing — the
 * PR flavor excludes workshop artifacts (specs/, app_docs/) from git, which
 * legitimately leaves the plan and docs commits with nothing to record.
 */
export function commit_all_if_changed(message: string): string {
  _git("add", "-A");
  if (!_git("status", "--porcelain")) return "";
  _git("commit", "-m", message);
  return _git("rev-parse", "--short", "HEAD");
}

export function changed_files(): string[] {
  return _git("status", "--porcelain")
    .split("\n")
    .filter((line) => line)
    .map((line) => line.slice(3));
}

// ── diff plumbing (composed into a ChangeSet by changes.ts) ──────────────────

/** True when `ref` resolves to a commit. Never throws — this is a question. */
export function ref_exists(ref: string): boolean {
  return (
    Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).exitCode === 0
  );
}

export function rev(ref = "HEAD"): string {
  return _git("rev-parse", ref);
}

/** Commit subjects in a range, newest first; [] when the range doesn't resolve. */
export function log_subjects(range: string): string[] {
  try {
    return _git("log", "--format=%s", range).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function short_sha(ref = "HEAD"): string {
  return _git("rev-parse", "--short", ref);
}

/**
 * The commit where `ref` and `other` diverged — the honest base of a branch.
 *
 * On the base branch itself this returns HEAD, which makes the diff exactly
 * "what is not committed yet". Off it, the diff is the whole branch plus the
 * working tree. One command covers both cases, so no ADW has to branch on it.
 */
export function merge_base(ref: string, other = "HEAD"): string {
  return _git("merge-base", ref, other);
}

export function is_dirty(): boolean {
  return Boolean(_git("status", "--porcelain"));
}

export function untracked_files(): string[] {
  return _git("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((line) => line);
}

/** Tracked files that differ between `base` and the working tree. */
export function diff_files(base: string): string[] {
  return _git("diff", "--name-only", base)
    .split("\n")
    .filter((line) => line);
}

export function diff_stat(base: string): string {
  return _git("diff", "--stat", base);
}

/** [insertions, deletions] across the diff. Binary files count as neither. */
export function diff_counts(base: string): [number, number] {
  let insertions = 0;
  let deletions = 0;
  for (const line of _git("diff", "--numstat", base).split("\n")) {
    const [added, removed] = line.split("\t");
    if (added && /^\d+$/.test(added)) insertions += Number(added);
    if (removed && /^\d+$/.test(removed)) deletions += Number(removed);
  }
  return [insertions, deletions];
}

export function diff_text(base: string): string {
  return _git("diff", base);
}
