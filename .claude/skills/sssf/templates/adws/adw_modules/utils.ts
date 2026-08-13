/** Small shared helpers. Anything bigger belongs in its own module. */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

// Bun reads `.env` from the project root before a single line of this runs, so
// there is no load-dotenv step. Keys named in .env reach every ADW, and every
// child process, for free.

/**
 * The engineer's own environment, as their shell would hand it over.
 *
 * Agents and quality blocks are meant to see exactly what the operator sees:
 * their PATH, their toolchains, their globally installed packages. Bun runs an
 * ADW directly rather than through a virtual environment, so a copy of
 * `process.env` already IS that environment — `bun`, `git`, `pytest` in an
 * agent's bash resolve exactly as they do in their terminal.
 *
 * It stays a function, and the single door every child process is launched
 * through, so scrubbing something later is one edit here rather than a hunt
 * through every spawn site.
 */
export function operator_env(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Everything that outranks subscription OAuth in Claude Code's auth precedence.
// Highest first: Bedrock/Vertex > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY >
// apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > subscription OAuth. Anything left in
// the child's environment above that last rung silently bills an API account
// instead of the subscription the operator is paying for.
const CLAUDE_AUTH_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
];

/**
 * The operator's environment with Claude Code's API-key rungs removed.
 *
 * The point of the `claude_code` interface is to run factory agents on a Claude
 * Pro/Max SUBSCRIPTION — `claude login` or `claude setup-token` — and the CLI
 * picks the highest-precedence credential it can see, not the one you meant.
 * Bun loads `.env` into `process.env` before an ADW runs, so an
 * `ANTHROPIC_API_KEY` set there for a pi agent's provider would otherwise
 * quietly redirect every Claude Code agent onto metered API billing. Scrubbing
 * the child env is what keeps a mixed roster honest.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` survives: it IS the subscription credential in
 * headless/CI runs, where there is no interactive login to fall back to.
 *
 * `SSSF_CC_USE_API_KEY=1` skips the scrub entirely, for operators who mean to
 * spend an API key (or who route Claude Code through a proxy via
 * `ANTHROPIC_BASE_URL`).
 */
export function claude_env(): Record<string, string> {
  const env = operator_env();
  if ((process.env.SSSF_CC_USE_API_KEY || "").trim() === "1") return env;
  for (const key of CLAUDE_AUTH_OVERRIDES) delete env[key];
  return env;
}

/**
 * A random hex id of exactly `length` characters.
 *
 * Rounds the byte count UP and slices, because hex is always 2 chars per byte:
 * rounding down would hand back a shorter id than asked for, silently, and an
 * id that is quietly 1 character shorter is an id with 16x less entropy.
 */
export function new_id(length = 8): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

/** UTC, milliseconds, offset-suffixed — the exact shape every stored timestamp has. */
export function now_iso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

export function ensure_dir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** CLI prompt arg: a file path resolves to its contents, else inline text. */
export function resolve_prompt(arg: string): string {
  try {
    if (statSync(arg).isFile()) return readFileSync(arg, "utf8");
  } catch {
    // not a path, or not readable — it is inline text
  }
  return arg;
}

/** A bad invocation. Printed as one line and exits 2, the way a CLI should. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The ADW's single positional argument, validated and resolved.
 *
 * A missing prompt is a usage error, never an empty one. An ADW that starts on
 * `""` still mints a session and spawns its agents against nothing — and in a
 * chain that ends in a commit phase, that means editing and committing a repo
 * over a request nobody made. Extra positionals are rejected for the same
 * reason: the second one would be silently dropped, so a quoting mistake would
 * run the wrong prompt rather than say so.
 *
 * `args_usage` is the argument half of the usage line, e.g.
 * `'"<prompt>" [--config PATH]'` — the script's own name is filled in here.
 */
export function require_prompt(positionals: string[], args_usage: string): string {
  const script = relative(process.cwd(), process.argv[1] ?? "adw.ts") || "adw.ts";
  const usage = `usage: bun ${script} ${args_usage}`;
  const [prompt, ...extra] = positionals;
  if (!prompt || !prompt.trim()) {
    throw new UsageError(`missing the required prompt argument.\n${usage}`);
  }
  if (extra.length) {
    throw new UsageError(
      `expected one prompt, got ${positionals.length} — ` +
        `${JSON.stringify(extra)} would have been ignored. Quote the whole prompt.\n${usage}`,
    );
  }
  return resolve_prompt(prompt);
}

export function engineer_name(): string {
  const name = (process.env.ENGINEER_NAME || "").trim();
  if (name) return name;
  try {
    const out = Bun.spawnSync(["git", "config", "user.name"]);
    const value = out.stdout.toString().trim();
    if (out.exitCode === 0 && value) return value;
  } catch {
    // no git, or no name configured
  }
  return process.env.USER || "engineer";
}
