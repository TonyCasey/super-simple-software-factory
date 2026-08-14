/**
 * GitHub operations for code that runs INSIDE a sandbox VM — push, PR, review
 * threads — all through the `gh` CLI so one auth story covers every call:
 *
 *   - In a sandbox: the secrets phase sets GH_HOST=github.int.exe.xyz and the
 *     exe.dev GitHub integration authenticates every call TOKENLESSLY (gh
 *     treats the host as GHES: REST at /api/v3, GraphQL at /api/graphql —
 *     both proxied; measured 2026-08-13, plans/sandbox-ticket-loop.md).
 *   - On a laptop with a normal `gh` login the same module works unchanged.
 *
 * Measured quirk: git ref DELETION through the integration proxy returns
 * HTTP 400 — branch cleanup is host-side work, deliberately absent here.
 */

import { operator_env } from "./utils.ts";

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

function _run(argv: string[], opts: { stdin?: string } = {}): string {
  const result = Bun.spawnSync(argv, {
    env: operator_env(),
    stdin: opts.stdin === undefined ? undefined : Buffer.from(opts.stdin),
  });
  if (result.exitCode !== 0) {
    throw new GitHubError(
      `${argv.slice(0, 3).join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 1500)}`,
    );
  }
  return result.stdout.toString().trim();
}

function _gh(args: string[], opts: { stdin?: string } = {}): string {
  return _run(["gh", ...args], opts);
}

/** owner/name of this checkout's origin remote (works for both clone hosts). */
export function origin_repo(): string {
  const url = _run(["git", "remote", "get-url", "origin"]);
  const match = url.match(/(?:github\.com|github\.int\.exe\.xyz)[:/]([^/]+\/[^/.\s]+)/);
  if (!match) throw new GitHubError(`cannot parse owner/repo from origin '${url}'`);
  return match[1]!;
}

export function default_branch(repo: string): string {
  return _gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
}

export function push_branch(branch: string): void {
  _run(["git", "push", "origin", branch]);
}

/**
 * Fetch origin and fast-forward the CURRENT branch onto it. Returns false when
 * the branch diverged (a human pushed to the PR while we worked) — the caller
 * must stand down and say so on the PR rather than force anything.
 */
export function ff_sync(branch: string): boolean {
  _run(["git", "fetch", "origin", branch]);
  const merge = Bun.spawnSync(["git", "merge", "--ff-only", `origin/${branch}`], { env: operator_env() });
  return merge.exitCode === 0;
}

export interface CreatedPr {
  url: string;
  number: number;
}

export function create_pr(args: {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
}): CreatedPr {
  const argv = [
    "pr", "create",
    "-R", args.repo,
    "--head", args.head,
    "--base", args.base,
    "--title", args.title,
    "--body", args.body,
  ];
  if (args.draft ?? true) argv.push("--draft");
  for (const label of args.labels ?? []) argv.push("--label", label);
  const url = _gh(argv).split("\n").pop() ?? "";
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
  if (!url.includes("/pull/") || !number) throw new GitHubError(`pr create returned no PR url: ${url}`);
  // Reviewers go through request_review, not --reviewer: Copilot is only
  // reachable via REST, and a failed reviewer must not fail the PR creation.
  try {
    request_review(args.repo, number, args.reviewers ?? []);
  } catch (error) {
    console.error(`(reviewer request failed, PR stands: ${error})`);
  }
  return { url, number };
}

export interface PrState {
  state: string; // OPEN | MERGED | CLOSED
  is_draft: boolean;
  review_decision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  merged_at: string; // "" when not merged
}

export function pr_state(repo: string, number: number): PrState {
  const raw = JSON.parse(
    _gh(["pr", "view", String(number), "-R", repo, "--json", "state,reviewDecision,isDraft,mergedAt"]),
  );
  return {
    state: raw.state ?? "",
    is_draft: Boolean(raw.isDraft),
    review_decision: raw.reviewDecision ?? "",
    merged_at: raw.mergedAt ?? "",
  };
}

export interface ReviewThread {
  thread_id: string; // GraphQL node id — resolve_thread takes this
  comment_id: number; // REST databaseId of the FIRST comment — reply takes this
  author: string;
  path: string;
  body: string; // first comment's body
  replies: number;
}

/** Unresolved review threads, exactly as the watcher consumes them. */
export function unresolved_threads(repo: string, number: number): ReviewThread[] {
  const [owner, name] = repo.split("/");
  const query =
    `query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) {` +
    ` reviewThreads(first: 50) { nodes { id isResolved path comments(first: 10) {` +
    ` nodes { databaseId author { login } body } } } } } } }`;
  const raw = JSON.parse(_gh(["api", "graphql", "-f", `query=${query}`]));
  const nodes = raw?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes
    .filter((n: any) => !n.isResolved && n.comments?.nodes?.length)
    .map((n: any) => ({
      thread_id: String(n.id),
      comment_id: Number(n.comments.nodes[0].databaseId ?? 0),
      author: String(n.comments.nodes[0].author?.login ?? "unknown"),
      path: String(n.path ?? ""),
      body: String(n.comments.nodes[0].body ?? ""),
      replies: n.comments.nodes.length - 1,
    }));
}

export function reply(repo: string, number: number, comment_id: number, body: string): void {
  _gh(
    ["api", `repos/${repo}/pulls/${number}/comments/${comment_id}/replies`, "-f", `body=${body}`],
  );
}

export function resolve_thread(thread_id: string): void {
  const mutation = `mutation { resolveReviewThread(input: {threadId: "${thread_id}"}) { thread { isResolved } } }`;
  const raw = JSON.parse(_gh(["api", "graphql", "-f", `query=${mutation}`]));
  if (raw?.data?.resolveReviewThread?.thread?.isResolved !== true) {
    throw new GitHubError(`resolveReviewThread(${thread_id}) did not resolve: ${JSON.stringify(raw).slice(0, 300)}`);
  }
}

/** The Copilot reviewer bot — requested via REST, unreachable by login. */
const COPILOT_BOT = "copilot-pull-request-reviewer[bot]";

export function is_copilot(reviewer: string): boolean {
  // Accept the config shorthand, the bot's full request name, and the login
  // GraphQL reports as review-thread author (no "[bot]" suffix there).
  const r = reviewer.toLowerCase();
  return r === "copilot" || r === COPILOT_BOT || r === "copilot-pull-request-reviewer";
}

export function request_review(repo: string, number: number, reviewers: string[]): void {
  const humans = reviewers.filter((r) => !is_copilot(r));
  const copilot = reviewers.some(is_copilot);
  if (humans.length) {
    const argv = ["pr", "edit", String(number), "-R", repo];
    for (const reviewer of humans) argv.push("--add-reviewer", reviewer);
    _gh(argv);
  }
  if (copilot) {
    // gh's --add-reviewer resolves BY LOGIN and cannot see the bot; the REST
    // endpoint takes it. NOTE: GitHub accepts this silently even when Copilot
    // code review is NOT enabled on the account — verify a request registered
    // if it matters.
    _gh(["api", `repos/${repo}/pulls/${number}/requested_reviewers`, "-f", `reviewers[]=${COPILOT_BOT}`]);
  }
}

/** A PR-level (non-thread) comment — the watcher's stand-down notices. */
export function comment_issue(repo: string, number: number, body: string): void {
  _gh(["pr", "comment", String(number), "-R", repo, "--body", body]);
}
