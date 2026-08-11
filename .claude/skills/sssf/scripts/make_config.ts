#!/usr/bin/env bun
/**
 * make_config — generate adws/adw_sssf_config/sssf.config.yaml with great defaults.
 *
 * Usage:
 *     bun <skill>/scripts/make_config.ts [--force]
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const TEMPLATE = join(dirname(dirname(import.meta.path)), "templates", "sssf.config.yaml");

function main(): number {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { force: { type: "boolean", default: false } },
    allowPositionals: true,
  });

  const dest = join(process.cwd(), "adws", "adw_sssf_config", "sssf.config.yaml");
  if (existsSync(dest) && !values.force) {
    console.log(`${dest} already exists — use --force to overwrite`);
    return 1;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(TEMPLATE, dest);
  console.log(`wrote ${dest}`);
  return 0;
}

process.exit(main());
