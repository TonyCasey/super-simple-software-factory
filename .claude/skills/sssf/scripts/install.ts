#!/usr/bin/env bun
/**
 * /install — stamp the SSSF factory from the skill into the cwd. Idempotent.
 *
 * Usage:
 *     bun <skill>/scripts/install.ts [--force]
 *
 * Stamps: adws/ (modules + starter ADWs + package.json), adws/adw_data/prompt_engineering/
 * (5 starter agents), adws/adw_sssf_config/sssf.config.yaml, .env.sample,
 * .gitignore entries.
 * Existing files are skipped unless --force.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const TEMPLATES = join(dirname(dirname(import.meta.path)), "templates");

const GITIGNORE_ENTRIES = [
  "adws/adw_data/sessions/",
  "adws/adw_data/sssf.db*",
  ".env",
  // The ADWs are TypeScript and their one dependency is installed per stamped
  // repo, so the tree lands inside adws/. Chains that end in a commit phase call
  // `git add -A`, and without this the first such run would commit a whole
  // node_modules into the target repo.
  "adws/node_modules/",
  // Sandbox-dispatch runtime: per-VM records and harvested bundles, plus the
  // synced copies of remote trace dbs. State about runs, never repo content.
  "adws/adw_data/sandbox/",
  "adws/adw_data/remote/",
];

// Never stamped: build/install output that belongs to whoever ran the install,
// not to the skill.
const SKIP_NAMES = new Set(["node_modules", ".DS_Store"]);

function stamp(src: string, dest: string, force: boolean, stamped: string[], skipped: string[]): void {
  if (statSync(src).isDirectory()) {
    for (const child of readdirSync(src).sort()) {
      if (SKIP_NAMES.has(child)) continue;
      stamp(join(src, child), join(dest, child), force, stamped, skipped);
    }
    return;
  }
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  stamped.push(dest);
}

function ensure_gitignore(root: string, stamped: string[]): void {
  const gitignore = join(root, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8").split("\n") : [];
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length) {
    appendFileSync(gitignore, "\n# sssf runtime\n" + missing.join("\n") + "\n");
    stamped.push(`${gitignore} (+${missing.length} entries)`);
  }
}

/**
 * Install the ADW dependency tree.
 *
 * The stamped ADWs import zod, so a repo that skipped this fails on its first
 * run with a module-resolution error rather than anything about the factory.
 * A failure here is reported, not fatal: an offline machine can run the one
 * command later.
 */
function install_dependencies(root: string): string {
  const adws = join(root, "adws");
  if (!existsSync(join(adws, "package.json"))) return "skipped (no adws/package.json)";
  const result = Bun.spawnSync(["bun", "install"], { cwd: adws, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0
    ? "ok"
    : `FAILED — run it yourself: cd adws && bun install\n    ${result.stderr.toString().trim().slice(-400)}`;
}

function main(): number {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { force: { type: "boolean", default: false } },
    allowPositionals: true,
  });

  const root = process.cwd();
  const stamped: string[] = [];
  const skipped: string[] = [];

  stamp(join(TEMPLATES, "adws"), join(root, "adws"), values.force, stamped, skipped);
  stamp(
    join(TEMPLATES, "prompt_engineering"),
    join(root, "adws", "adw_data", "prompt_engineering"),
    values.force,
    stamped,
    skipped,
  );
  stamp(
    join(TEMPLATES, "harness_engineering"),
    join(root, "adws", "adw_data", "harness_engineering"),
    values.force,
    stamped,
    skipped,
  );
  stamp(
    join(TEMPLATES, "sssf.config.yaml"),
    join(root, "adws", "adw_sssf_config", "sssf.config.yaml"),
    values.force,
    stamped,
    skipped,
  );
  stamp(join(TEMPLATES, "env.sample"), join(root, ".env.sample"), values.force, stamped, skipped);
  // The recipes are part of the operating experience, and several cookbooks
  // plus the run banner tell you to use them, so a stamped repo has to have
  // them. Skipped like any other file if the repo already has a justfile.
  stamp(join(TEMPLATES, "justfile"), join(root, "justfile"), values.force, stamped, skipped);
  ensure_gitignore(root, stamped);

  console.log(`sssf installed into ${root}`);
  console.log(`  stamped: ${stamped.length} file(s)`);
  for (const s of stamped) console.log(`    + ${s}`);
  if (skipped.length) {
    console.log(`  skipped (already exist, use --force to overwrite): ${skipped.length}`);
  }
  console.log(`  deps: ${install_dependencies(root)}`);
  console.log("\nnext steps:");
  console.log("  1. cp .env.sample .env   # then set the key(s) your roster needs");
  console.log("  2. just demo             # two cheap read-only runs, end to end");
  console.log("  3. just sessions         # what just happened");
  console.log("  4. just obs              # the trace UI");
  console.log("\n  no just? the raw form of step 2 is:");
  console.log('     bun adws/adw_prompt.ts "say hello" --agent scout');
  return 0;
}

process.exit(main());
