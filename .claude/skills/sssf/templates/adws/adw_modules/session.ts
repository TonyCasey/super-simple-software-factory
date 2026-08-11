/**
 * Session lifecycle: pin-or-create an adw_id, build the Run object.
 *
 * `ensure(cfg, adw_id)` joins the session if it exists or creates it under
 * exactly that id (pinned ids for repeatable runs); omitted, a fresh id is
 * minted and printed so the next ADW can pick it up.
 */

import { basename, extname } from "node:path";

import type { SSSFConfig } from "./data_types.ts";
import { Run } from "./runner.ts";
import { Tracer } from "./tracer.ts";
import { engineer_name, new_id } from "./utils.ts";

/**
 * A killed run still closes its own trace.
 *
 * The default SIGTERM handling exits without unwinding, so `just kill` (or any
 * `kill <pid>`) would leave the session reading `running` forever and its
 * process rows open — the trace would claim work is in flight that is already
 * dead. Finalizing in the handler closes the session before the exit lands.
 */
function _finalize_when_killed(run: Run): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      run.tracer.session_finish(run.adw_id, false); // also closes process rows
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** The ADW script's own name, which the trace records per session. */
function _adw_name(): string {
  const entry = process.argv[1] ?? "";
  return entry ? basename(entry, extname(entry)) : "adw";
}

export function ensure(cfg: SSSFConfig, adw_id?: string | null): Run {
  const id = adw_id || new_id(8);
  const tracer = new Tracer(
    cfg.observability.db,
    `${cfg.defaults.data_dir}/sessions/${id}/events.jsonl`,
  );
  const run = new Run(cfg, id, tracer, engineer_name());
  tracer.session_start(id, run.engineer, _adw_name());
  // This process is the run. Record it before any phase opens, so a run that
  // hangs in its first agent call is still killable by adw_id.
  tracer.process_start(
    id,
    "adw",
    "",
    process.pid,
    [basename(process.argv[1] ?? "adw"), ...process.argv.slice(2)].join(" "),
  );
  _finalize_when_killed(run);
  run.console.session_started(id, run.engineer);
  return run;
}

/**
 * Run an ADW's `main` and exit with its code.
 *
 * A bad invocation or a config problem is a message, not a stack trace — both
 * are the engineer's typo, and the fix is in the command line or in
 * sssf.config.yaml. A usage error exits 2, the conventional CLI code for
 * "you called this wrong". Anything else is a real fault and prints in full,
 * because that one you have to debug.
 */
export async function cli(main: () => Promise<number>): Promise<never> {
  try {
    process.exit(await main());
  } catch (error) {
    const named = error as { name?: string; message?: string };
    if (named?.name === "UsageError") {
      console.error(named.message);
      process.exit(2);
    }
    console.error(named?.name === "ConfigError" ? named.message : error);
    process.exit(1);
  }
}
