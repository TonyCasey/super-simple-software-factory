/** Prompt rendering: load system/user refs from config, replace {{placeholders}}. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensure_dir } from "./utils.ts";

export function render(template_path: string, variables: Record<string, string>): string {
  let text = readFileSync(template_path, "utf8");
  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll("{{" + key + "}}", value);
  }
  return text;
}

/** Save the exact prompt sent, before execution — the audit copy. */
export function save(directory: string, name: string, content: string): string {
  ensure_dir(directory);
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}
