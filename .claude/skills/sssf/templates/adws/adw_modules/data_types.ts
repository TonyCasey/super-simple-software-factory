/**
 * Concrete data types for the SSSF ADW system.
 *
 * RULE (four-param rule): any function that takes more than 4 parameters takes
 * ONE of these objects instead. AgentCall and PhaseParams are the pattern.
 *
 * Every agent call declares a concrete output type — an EnvelopeBase extension —
 * that its final JSON response is parsed against. No untyped handoffs.
 *
 * Envelope FIELD NAMES are snake_case on purpose. They are quoted verbatim in
 * every agent's `user.md` `## Report` section and land in the trace db, so they
 * are a wire contract with the models and the UI, not a TypeScript style choice.
 */

import { z } from "zod";

export const PhaseKindSchema = z.enum(["engineer", "agent", "code"]);
export type PhaseKind = z.infer<typeof PhaseKindSchema>;

export const PhaseStatusSchema = z.enum(["queued", "running", "success", "fail"]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

// ── Phases ───────────────────────────────────────────────────────────────────

/** Everything run.phase() needs. Passed as one object, never loose params. */
export interface PhaseParams {
  name: string; // short id, unique within the run: "plan", "build"
  kind: PhaseKind; // which lane the block renders in
  owner: string; // engineer's name, "git", or an agent name from config
  description: string; // REQUIRED: what this phase does and why — see below
  retries: number; // agent phases: gate-failure retries via continue
}

const PhaseParamsSchema = z.object({
  name: z.string(),
  kind: PhaseKindSchema,
  owner: z.string(),
  description: z.string(),
  retries: z.number().int().default(0),
});

/**
 * Build a validated PhaseParams. A phase name identifies; a description explains.
 * Both are required.
 *
 * The description is the only sentence the trace, the console, and the phase
 * block in the UI ever show about intent — everything else is ids, statuses,
 * and timings. `commit_plan: "Commit the plan"` tells a reader nothing they
 * could not already see, so an echo is rejected the same way a blank one is.
 * This throws at construction on purpose: it fires before the phase opens, not
 * after a run is already in the trace.
 */
export function PhaseParams(params: z.input<typeof PhaseParamsSchema>): PhaseParams {
  const parsed = PhaseParamsSchema.parse(params);
  const text = parsed.description.split(/\s+/).filter(Boolean).join(" ");
  if (!text) {
    throw new Error(
      `phase ${JSON.stringify(parsed.name)}: description is required — one sentence on ` +
        `what this phase does and why. It is what the trace and the UI show.`,
    );
  }
  if (
    text.replace(/\.+$/, "").toLowerCase() ===
    parsed.name.replaceAll("_", " ").toLowerCase()
  ) {
    throw new Error(
      `phase ${JSON.stringify(parsed.name)}: description ${JSON.stringify(text)} only ` +
        `restates the phase name — say what it does and why instead.`,
    );
  }
  return { ...parsed, description: text };
}

/** The persisted phase record — PhaseParams plus lifecycle. */
export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number;
  params: PhaseParams;
  status: PhaseStatus; // success must be earned
  attempt: number;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

// ── Envelopes (agent output types) ───────────────────────────────────────────

/** Base of every agent's final JSON response. Output types extend this. */
export const EnvelopeBaseSchema = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string().default(""),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(""),
});
export type EnvelopeBase = z.infer<typeof EnvelopeBaseSchema>;

/**
 * A named output type: the schema an envelope is parsed against, plus the name
 * the trace, the correction prompt, and the db column all refer to it by.
 *
 * The name is carried explicitly because a schema is a value, not a class —
 * there is no `__name__` to read off it. Keeping it here means `output_type=`
 * at a call site, the type in this file, and the `## Report` example in the
 * agent's user.md stay one greppable string.
 */
export interface OutputType<S extends z.ZodObject<any> = z.ZodObject<any>> {
  readonly name: string;
  readonly schema: S;
  readonly fields: string[];
}

function outputType<S extends z.ZodObject<any>>(name: string, schema: S): OutputType<S> {
  return { name, schema, fields: Object.keys(schema.shape) };
}

/** The parsed shape an OutputType yields. */
export type Envelope<T> = T extends OutputType<infer S> ? z.infer<S> : never;

export const GenericOutput = outputType("GenericOutput", EnvelopeBaseSchema.extend({}));
export type GenericOutput = z.infer<typeof GenericOutput.schema>;

export const PlanOutput = outputType(
  "PlanOutput",
  EnvelopeBaseSchema.extend({
    // Subject for committing the PLAN — the spec file the planner wrote, not the
    // implementation it describes. Each agent's commit_message covers its own
    // work product, so a chain that commits per step never reuses one agent's
    // words for another agent's diff.
    commit_message: z.string().default(""),
  }),
);
export type PlanOutput = z.infer<typeof PlanOutput.schema>;

export const BuildOutput = outputType(
  "BuildOutput",
  EnvelopeBaseSchema.extend({
    changed_files: z.array(z.string()).default([]),
    commit_message: z.string().default(""), // consumed by the git commit phase
  }),
);
export type BuildOutput = z.infer<typeof BuildOutput.schema>;

export const ScoutFindingSchema = z.object({
  file: z.string(),
  note: z.string().default(""),
});

export const ScoutOutput = outputType(
  "ScoutOutput",
  EnvelopeBaseSchema.extend({
    findings: z.array(ScoutFindingSchema).default([]),
  }),
);
export type ScoutOutput = z.infer<typeof ScoutOutput.schema>;

/** One thing the request (or plan) asked for, and whether it is there. */
export const ReviewFindingSchema = z.object({
  requirement: z.string(), // the ask, in the requester's words
  met: z.boolean(),
  evidence: z.string().default(""), // where it lives, or what is missing
});

/** Confirmation that what was built is what was asked for — not a test run. */
export const ReviewOutput = outputType(
  "ReviewOutput",
  EnvelopeBaseSchema.extend({
    approved: z.boolean().default(false),
    findings: z.array(ReviewFindingSchema).default([]),
    blocking: z.array(z.string()).default([]), // what must change before approval
  }),
);
export type ReviewOutput = z.infer<typeof ReviewOutput.schema>;

/** Where the write-up of a completed change landed. */
export const DocumentOutput = outputType(
  "DocumentOutput",
  EnvelopeBaseSchema.extend({
    document_path: z.string().default(""), // the doc in the repo, e.g. app_docs/<adw_id>_<slug>.md
    documented_files: z.array(z.string()).default([]),
    commit_message: z.string().default(""),
  }),
);
export type DocumentOutput = z.infer<typeof DocumentOutput.schema>;

// ── Deterministic quality blocks ─────────────────────────────────────────────

export type QualityArea = "frontend" | "backend";
export type QualityOperation = "lint" | "typecheck" | "build";

/** One deterministic quality command. */
export interface QualityCheckSpec {
  name: string;
  area: QualityArea;
  operation: QualityOperation;
  argv: string[];
  timeout_seconds?: number;
}

/** Captured evidence from one quality command. */
export interface QualityCheckResult {
  name: string;
  area: QualityArea;
  operation: QualityOperation;
  command: string;
  returncode: number;
  passed: boolean;
  duration_seconds: number;
  output_artifact: string;
  // The tail of stdout+stderr, verbatim and unparsed. A failure has to travel
  // back to the builder as an envelope, and the builder cannot open a log file
  // it was never handed — so the evidence rides along. Deliberately raw: every
  // runner formats failures differently and a generic parser would be
  // confidently wrong. The full log is always at output_artifact.
  output_tail: string;
}

/** Aggregate result from a quality block: every check it ran, and the verdict. */
export interface QualityResult {
  passed: boolean;
  checks: QualityCheckResult[];
  failures: string[];
  artifacts: string[];
}

// ── Change capture (git diff, deterministic) ─────────────────────────────────

/** Everything changes.capture() needs. One object, never loose params. */
export interface ChangeCapture {
  base?: string; // the ref the work is measured against
  max_diff_lines?: number; // the diff artifact is truncated past this
  include_untracked?: boolean; // a brand-new file is part of the change
}

export const CHANGE_CAPTURE_DEFAULTS = {
  base: "main",
  max_diff_lines: 2000,
  include_untracked: true,
} as const;

/**
 * The commit a change is measured from, and why that one.
 *
 * `reason` is the line the trace shows. A diff is only as trustworthy as the
 * thing it was taken against, so the ADW records that choice instead of
 * leaving the reader to infer it.
 */
export class BaseRef {
  ref: string; // what was asked for: "main", or a pinned sha
  commit: string; // the commit actually diffed against
  reason: string;

  constructor(ref: string, commit: string, reason = "") {
    this.ref = ref;
    this.commit = commit;
    this.reason = reason;
  }

  /** Display form — a named ref as itself, a pinned raw sha shortened. */
  get label(): string {
    if (this.ref.length === 40 && /^[0-9a-f]+$/.test(this.ref)) return this.ref.slice(0, 7);
    return this.ref;
  }
}

/** What changed since the base commit — pure git facts, no judgement. */
export class ChangeSet {
  base: BaseRef;
  files: string[];
  untracked: string[];
  insertions: number;
  deletions: number;
  stat: string; // `git diff --stat` output, verbatim
  diff_path: string; // the full diff, written into context_handoff/
  truncated: boolean;

  constructor(init: {
    base: BaseRef;
    files?: string[];
    untracked?: string[];
    insertions?: number;
    deletions?: number;
    stat?: string;
    diff_path?: string;
    truncated?: boolean;
  }) {
    this.base = init.base;
    this.files = init.files ?? [];
    this.untracked = init.untracked ?? [];
    this.insertions = init.insertions ?? 0;
    this.deletions = init.deletions ?? 0;
    this.stat = init.stat ?? "";
    this.diff_path = init.diff_path ?? "";
    this.truncated = init.truncated ?? false;
  }

  get empty(): boolean {
    return this.files.length === 0 && this.untracked.length === 0;
  }
}

/**
 * A ChangeSet shaped as an envelope so an agent can be handed it directly.
 *
 * Same adapter idea as VerifyOutput: code computes the diff, the documenter
 * consumes it through the one door every agent handoff uses.
 */
export const ChangesOutput = outputType(
  "ChangesOutput",
  EnvelopeBaseSchema.extend({
    base: z.string().default(""), // "<ref> @ <commit> — <reason>"
    changed_files: z.array(z.string()).default([]),
    insertions: z.number().default(0),
    deletions: z.number().default(0),
    stat: z.string().default(""),
    diff_path: z.string().default(""), // read this for the full diff
  }),
);
export type ChangesOutput = z.infer<typeof ChangesOutput.schema>;

/**
 * A deterministic result, shaped as an envelope so an agent can consume it.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing lint or test run flows back into the
 * builder through exactly the same door a tester agent's report used to —
 * the ADW script is the only thing that knows the difference.
 */
export const VerifyOutput = outputType(
  "VerifyOutput",
  EnvelopeBaseSchema.extend({
    passed: z.boolean().default(false),
    failures: z.array(z.string()).default([]),
  }),
);
export type VerifyOutput = z.infer<typeof VerifyOutput.schema>;

// ── Agent calls ──────────────────────────────────────────────────────────────

/**
 * One thing a gate looked at, and what it found.
 *
 * `note` is the evidence — "exists, 2.1KB", "exit 0", "not in the diff". On a
 * failed check it doubles as the reason, so it is what the agent is told.
 */
export interface GateCheck {
  item: string; // what was checked: a path, a command, a test
  ok: boolean;
  note: string;
}

/**
 * What every gate returns: the checks it ran. Violations are derived.
 *
 * Authoring stays a one-liner per item — `report.check(...)` appends and
 * returns itself, so a gate is a loop and a return.
 */
export class GateReport {
  checks: GateCheck[] = [];

  check(item: string, ok: boolean, note = ""): GateReport {
    this.checks.push({ item, ok, note });
    return this;
  }

  get violations(): string[] {
    return this.checks.filter((c) => !c.ok).map((c) => `${c.item}: ${c.note || "failed"}`);
  }

  get passed(): boolean {
    return this.violations.length === 0;
  }
}

/** gate(envelope, run) -> GateReport. Named, because the trace records which one ran. */
export type Gate = (envelope: any, run: any) => GateReport | Promise<GateReport>;

/** One agent invocation: prompt in, typed envelope out, gates verified. */
export interface AgentCall<T = any> {
  output_type: OutputType<z.ZodObject<any>> & { schema: z.ZodType<T> };
  prompt: string;
  previous: EnvelopeBase | null;
  gates: Gate[];
}

export function AgentCall<S extends z.ZodObject<any>>(args: {
  output_type: OutputType<S>;
  prompt: string;
  previous?: EnvelopeBase | null;
  gates?: Gate[];
}): AgentCall<z.infer<S>> {
  return {
    output_type: args.output_type as any,
    prompt: args.prompt,
    previous: args.previous ?? null,
    gates: args.gates ?? [],
  };
}

// ── Config ───────────────────────────────────────────────────────────────────

export const PromptEngineeringSchema = z.object({
  system: z.string(), // path to system.md
  user: z.string(), // path to user.md
});

export const AgentConfigSchema = z.object({
  name: z.string(),
  coding_agent: z.enum(["pi", "claude_code", "codex"]).default("pi"),
  model: z.string().default("google/gemini-3.6-flash"),
  thinking: z.string().default("medium"), // off | minimal | low | medium | high | xhigh | max
  color: z.string().default(""), // hex swatch for this agent's lane in the UI
  purpose: z.string().default(""),
  prompt_engineering: PromptEngineeringSchema,
  harness_engineering: z.array(z.string()).default([]),
  tools: z.array(z.string()).nullable().default(null), // allowlist; null = all tools usable
  // What this agent may MODIFY in the repo, enforced in code after every call
  // (see adw_modules/permissions.ts). `tools` cannot express this: `bash` runs
  // anything and `write` reaches any path, so an agent's capability list is a
  // statement of intent that nothing checks.
  //   null  -> unrestricted, except the roster-wide `protected_files` paths
  //   []    -> read-only: may modify nothing tracked
  //   [...] -> only these. A trailing "/" means a directory prefix; a "*"
  //            makes it a glob; anything else is an exact path.
  writes: z.array(z.string()).nullable().default(null),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ConfigDefaultsSchema = z.object({
  coding_agent: z.enum(["pi", "claude_code", "codex"]).default("pi"),
  model: z.string().default("google/gemini-3.6-flash"),
  thinking: z.string().default("medium"),
  color: z.string().default(""),
  harness_engineering: z.array(z.string()).default([]),
  tools: z.array(z.string()).nullable().default(null), // roster-wide allowlist; null = all tools usable
  // Off-limits to every agent that has not named them in its own `writes`.
  // The factory's own code is the default: an agent must not be able to edit
  // the machinery that decides whether its work passed.
  protected_files: z
    .array(z.string())
    .default(["adws/adw_modules/", "adws/adw_sssf_config/", "adws/adw_*.ts"]),
  data_dir: z.string().default("adws/adw_data"),
});
export type ConfigDefaults = z.infer<typeof ConfigDefaultsSchema>;

export const ObservabilityConfigSchema = z.object({
  db: z.string().default("adws/adw_data/sssf.db"),
  poll_ms: z.number().int().default(500),
});

export const SSSFConfigSchema = z.object({
  defaults: ConfigDefaultsSchema.prefault({}),
  observability: ObservabilityConfigSchema.prefault({}),
  agents: z.array(AgentConfigSchema).default([]),
});
export type SSSFConfig = z.infer<typeof SSSFConfigSchema>;

// ── Tracing ──────────────────────────────────────────────────────────────────

/** One traced event, always logged against adw_id + phase. */
export interface EventRecord {
  adw_id: string;
  phase_id?: string;
  /** phase_start | agent_start | tool_call | handoff | gate_pass | gate_fail | log | agent_end | phase_end | error */
  type: string;
  name?: string;
  payload?: Record<string, any>;
  parent_id?: string;
  tokens?: number | null;
  // Spans: set both when an event covers real elapsed time (a tool call), so
  // the UI lays it out on a time axis without parsing payload JSON. Left unset,
  // the tracer stamps started_at with the moment the event was recorded.
  started_at?: string | null;
  ended_at?: string | null;
}

// ── Coding agent interface ───────────────────────────────────────────────────

/** Everything one non-interactive pi run needs. */
export interface PiRequest {
  prompt: string;
  system_prompt: string;
  model: string; // registry pattern, resolved to provider + id
  thinking: string;
  session_id: string; // pi --session-id: creates or continues
  session_dir: string;
  raw_output_path: string; // JSONL stream lands here
  tools: string[] | null;
  extensions: string[];
  cwd: string; // set from run.repo_root — the codebase root agents work in
  // The agent's `writes` config, passed through for interfaces that can enforce
  // it BEFORE the call rather than after. Optional because most cannot: pi and
  // Claude Code both leave the boundary entirely to permissions.ts, which diffs
  // the tree afterwards; Codex turns `writes: []` into a read-only sandbox the
  // agent cannot write through in the first place. The post-hoc fence still
  // runs either way — this only narrows what has to reach it.
  writes?: string[] | null;
}

/**
 * Tokens and the dollars they cost, per component, summed over a call.
 *
 * Mirrors pi's `usage` shape one-for-one so the numbers reconcile with what
 * pi itself reports: `input` EXCLUDES cache reads, which bill at their own
 * (cheaper) rate — add them to learn the size of the prompt that was sent.
 */
export class UsageBreakdown {
  input_tokens = 0;
  output_tokens = 0;
  cache_read_tokens = 0;
  cache_write_tokens = 0;
  // Thinking tokens. NOT a fifth component: measured across every session on
  // disk, reasoning is always <= output and the four components above always
  // sum to totalTokens, so reasoning is the thinking SHARE of output, billed
  // at the output rate. Report it nested under output, never added to it.
  reasoning_tokens = 0;
  total_tokens = 0;
  input_cost = 0;
  output_cost = 0;
  cache_read_cost = 0;
  cache_write_cost = 0;
  total_cost = 0;

  /**
   * Fold in one pi `message_end` usage object.
   *
   * `total_tokens` is passed in rather than re-derived: the caller already
   * computes it pi's way (totalTokens, else the sum of the parts).
   */
  add_turn(usage: Record<string, any>, total_tokens: number): void {
    const cost = usage.cost || {};
    this.input_tokens += usage.input || 0;
    this.output_tokens += usage.output || 0;
    this.cache_read_tokens += usage.cacheRead || 0;
    this.cache_write_tokens += usage.cacheWrite || 0;
    this.reasoning_tokens += usage.reasoning || 0;
    this.total_tokens += total_tokens;
    this.input_cost += cost.input || 0;
    this.output_cost += cost.output || 0;
    this.cache_read_cost += cost.cacheRead || 0;
    this.cache_write_cost += cost.cacheWrite || 0;
    this.total_cost += cost.total || 0;
  }

  /** Add another call's usage — a phase that retries spends more than once. */
  merge(other: UsageBreakdown): void {
    for (const field of Object.keys(this) as (keyof UsageBreakdown)[]) {
      if (typeof this[field] === "number") {
        (this as any)[field] += other[field] as number;
      }
    }
  }

  /** Plain object for the trace payload — the same snake_case field names. */
  dump(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(this)) {
      if (typeof value === "number") out[key] = value;
    }
    return out;
  }
}

export interface PiResult {
  text: string;
  returncode: number;
  session_id: string;
  tokens: number;
  cost: number;
  usage: UsageBreakdown;
  // Context occupancy after the LAST turn — not a sum. `tokens` bills every
  // turn; this is how full the window is right now, which is what the
  // visualizer's context bar measures against `context_window`.
  context_tokens: number;
  context_window: number; // 0 when the registry declares no ceiling
}

/**
 * Coding-agent-neutral names for the request/result wire shapes.
 *
 * PiRequest/PiResult stay the canonical DECLARATIONS — they are the wire
 * contract the tracer, the visualizer, and every envelope already speak, and
 * renaming them would rewrite that contract for a second adapter's benefit.
 * Adapters other than pi (`agent_cc.ts`) use these aliases instead, so nothing
 * in a Claude Code file has to claim to be pi.
 *
 * One field shifts meaning across adapters: `session_dir`. For pi it is where
 * the sessions themselves live; for Claude Code the transcripts live under
 * `~/.claude` and the directory holds only this run's session-id marker and the
 * rendered system prompt.
 */
export type AgentRequest = PiRequest;
export type AgentResult = PiResult;

/**
 * The four symbols every coding-agent module exports. `agents.ts` dispatches on
 * `coding_agent` through a map typed by this, so a half-built adapter is a
 * compile error rather than a runtime surprise mid-run.
 */
export interface CodingAgent {
  resolve_model(pattern: string): [string, string];
  context_window(provider: string, model_id: string): number;
  ToolCallTracker: new () => {
    observe(event: Record<string, any>): Record<string, any> | null;
  };
  run(
    request: AgentRequest,
    on_event?: (event: Record<string, any>) => void,
    on_spawn?: (pid: number) => void,
    on_exit?: (pid: number) => void,
  ): Promise<AgentResult>;
}
