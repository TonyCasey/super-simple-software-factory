/** Small shared helpers. Anything bigger belongs in its own module. */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";

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

export function new_id(length = 8): string {
  return randomBytes(Math.floor(length / 2)).toString("hex");
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
