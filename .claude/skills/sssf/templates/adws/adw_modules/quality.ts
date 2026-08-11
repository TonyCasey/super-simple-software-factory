/**
 * Deterministic lint, typecheck, build, and test blocks.
 *
 * A known command is not a judgement call. Anything whose invocation you can write
 * down belongs here as code — it runs in milliseconds, costs nothing, and returns
 * the same answer every time. Agents are for the parts that need reading and
 * deciding.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  REPLACE THE PLACEHOLDER COMMANDS BELOW.                                     ║
 * ║                                                                              ║
 * ║  Every block ships as an `echo` that exits 0 and announces it is fake. They   ║
 * ║  are placeholders on purpose: a stamped repo has no way to guess your test    ║
 * ║  runner, and a wrong-but-plausible command that silently passes is worse      ║
 * ║  than one that says so out loud.                                             ║
 * ║                                                                              ║
 * ║  For each block you want: swap `_placeholder(...)` for the real argv, e.g.    ║
 * ║      argv: ["bun", "test", "apps/web/server.test.ts"]                        ║
 * ║      argv: ["uv", "run", "pytest", "-q"]                                     ║
 * ║      argv: ["npm", "run", "lint"]                                            ║
 * ║  Delete the blocks you don't need, and drop them from run_quality()'s list.   ║
 * ║                                                                              ║
 * ║  Two rules when you write the real command:                                  ║
 * ║    1. argv ARRAY, never a shell string — no quoting bugs, no shell injection. ║
 * ║    2. Call binaries by BARE NAME. These blocks inherit the operator's         ║
 * ║       environment (see utils.operator_env), so `bun`, `uv`, `pytest` resolve  ║
 * ║       exactly as they do in their terminal. Never hard-code an absolute path  ║
 * ║       like /Users/you/.bun/bin/bun — that bakes your machine into the trace.  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  QualityCheckResult,
  QualityCheckSpec,
  QualityResult,
  VerifyOutput as VerifyOutputType,
} from "./data_types.ts";
import { ensure_dir, now_iso, operator_env } from "./utils.ts";

// How much of a failing command's output rides back inside the envelope. Enough
// for a builder to act on without opening the artifact; bounded so a runaway
// stack trace can't swamp the next agent's context.
const TAIL_CHARS = 4_000;

const DEFAULT_TIMEOUT_SECONDS = 120;

/** A command that does nothing and admits it. Replace every call to this. */
function _placeholder(name: string): string[] {
  return [
    "echo",
    `PLACEHOLDER ${name}: edit adws/adw_modules/quality.ts and ` +
      `replace this echo with the real ${name} command`,
  ];
}

/** Quote an argv for display only — the command itself is never shelled out. */
function shell_join(argv: string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`))
    .join(" ");
}

function _check_dir(run: any, name: string): string {
  const seq = run.phases.length ? run.phases[run.phases.length - 1].seq : 0;
  const path = join(
    run.context_handoff_dir,
    "quality",
    `${String(seq).padStart(2, "0")}_${name}`,
  );
  return ensure_dir(path);
}

async function _run(spec: QualityCheckSpec, run: any): Promise<QualityCheckResult> {
  const phase = run.phases[run.phases.length - 1];
  const output_dir = _check_dir(run, spec.name);
  const output_artifact = join(output_dir, "command.log");
  const command = shell_join(spec.argv);
  const timeout_seconds = spec.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;

  run.console.note(`quality ${spec.name}: ${command}`);
  const started_at = now_iso();
  const clock = performance.now();
  let stdout = "";
  let stderr = "";
  let returncode: number;

  try {
    const child = Bun.spawn(spec.argv, {
      cwd: run.repo_root,
      env: operator_env(), // the engineer's own shell environment
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeout_seconds * 1000,
    });
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    returncode = await child.exited;
    if (child.killed && returncode !== 0) {
      returncode = 124;
      stderr += `\nTimed out after ${timeout_seconds}s.`;
    }
  } catch (error) {
    // A missing binary lands here as exit 127 with the real message — no
    // pre-flight probe needed, and none wanted.
    returncode = 127;
    stderr = String(error);
  }

  const duration = (performance.now() - clock) / 1000;
  writeFileSync(
    output_artifact,
    `$ ${command}\nexit: ${returncode}\nduration_seconds: ${duration.toFixed(3)}\n` +
      `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  );
  const passed = returncode === 0;
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "tool_call",
    name: `quality:${spec.name}`,
    payload: {
      area: spec.area,
      operation: spec.operation,
      command,
      returncode,
      passed,
      output_artifact,
    },
    started_at,
    ended_at: now_iso(),
  });
  run.console.note(
    `quality ${spec.name}: ${passed ? "passed" : "failed"} ` +
      `(exit ${returncode}, ${duration.toFixed(1)}s)`,
  );
  return {
    name: spec.name,
    area: spec.area,
    operation: spec.operation,
    command,
    returncode,
    passed,
    duration_seconds: duration,
    output_artifact,
    output_tail: (stdout + stderr).slice(-TAIL_CHARS),
  };
}

// ── Blocks ───────────────────────────────────────────────────────────────────
// Replace every argv below. See the banner at the top of this file.

/** Run the project's test suite. The highest-value block to wire up first. */
export function test(run: any): Promise<QualityCheckResult> {
  return _run(
    {
      name: "test",
      area: "backend",
      operation: "build",
      argv: _placeholder("test"), // e.g. ["bun", "test"] or ["uv", "run", "pytest", "-q"]
      timeout_seconds: 600,
    },
    run,
  );
}

export function lint(run: any): Promise<QualityCheckResult> {
  return _run(
    {
      name: "lint",
      area: "backend",
      operation: "lint",
      argv: _placeholder("lint"), // e.g. ["bun", "x", "oxlint@1.36.0", "src"]
    },
    run,
  );
}

export function typecheck(run: any): Promise<QualityCheckResult> {
  return _run(
    {
      name: "typecheck",
      area: "backend",
      operation: "typecheck",
      argv: _placeholder("typecheck"), // e.g. ["bun", "x", "tsc", "--noEmit"]
    },
    run,
  );
}

export function build(run: any): Promise<QualityCheckResult> {
  return _run(
    {
      name: "build",
      area: "backend",
      operation: "build",
      argv: _placeholder("build"), // e.g. ["bun", "build", "src/index.ts", "--outdir", outputDir]
    },
    run,
  );
}

/**
 * The test suite alone, as a QualityResult — the deterministic test phase.
 *
 * This is what replaces a `tester` agent once the command is written down. An
 * agent rediscovering the runner on every run costs a fortune to learn what a
 * subprocess already knows; the repair loop is unchanged, because a failure
 * still reaches the builder through `as_envelope` below.
 */
export async function run_tests(run: any): Promise<QualityResult> {
  const check = await test(run);
  const failures = check.passed
    ? []
    : [
        `${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trimEnd(),
      ];
  return {
    passed: check.passed,
    checks: [check],
    failures,
    artifacts: [check.output_artifact],
  };
}

/**
 * Wrap a deterministic result so an agent can be handed it directly.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing lint or test run flows back into the
 * builder through exactly the same door an agent's report would — the ADW
 * script is the only thing that knows the difference.
 */
export function as_envelope(result: QualityResult, what: string): VerifyOutputType {
  return {
    status: result.passed ? "success" : "fail",
    summary: result.passed
      ? `${what}: all ${result.checks.length} check(s) passed`
      : `${what}: ${result.failures.length} of ${result.checks.length} check(s) failed`,
    artifacts: result.artifacts,
    notes_for_next_agent: result.passed
      ? ""
      : "Fix every failure below. The output is verbatim from the " +
        "command — trust it over any summary.",
    passed: result.passed,
    failures: result.failures,
  };
}

/**
 * Run every block and collect ALL failures — one pass tells you everything.
 *
 * Ordering contract for the caller: a failing block does NOT fail the phase.
 * The runner did its job; the CODE is what failed. Hand this result to the
 * builder and let the bounded repair loop decide the run's fate.
 */
export async function run_quality(run: any): Promise<QualityResult> {
  const blocks = [test, lint, typecheck, build];
  const checks: QualityCheckResult[] = [];
  for (const block of blocks) {
    checks.push(await block(run));
  }
  // A failure is the command, its exit code, and what it actually printed —
  // everything a builder needs to repair without opening a log or being told
  // what the error "means" by a parser that guessed.
  const failures = checks
    .filter((check) => !check.passed)
    .map((check) =>
      `${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trimEnd(),
    );
  return {
    passed: failures.length === 0,
    checks,
    failures,
    artifacts: checks.map((check) => check.output_artifact),
  };
}
