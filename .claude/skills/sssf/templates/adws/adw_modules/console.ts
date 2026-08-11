/**
 * Console reporter: one narrative, two destinations.
 *
 * Every line an ADW prints ALSO lands in the db as a `log` event, so the swim-lane
 * UI reads the same story the terminal does. Both go through `_emit` — print and
 * trace cannot drift. Plain sequential lines only: no spinners, no live displays,
 * so a CI log reads exactly like a terminal.
 *
 * The markup below is the small `[bold cyan]...[/bold cyan]` dialect the Python
 * original used, rendered here by `markup()` rather than a library: every line
 * needs BOTH its styled form (for the terminal) and its plain form (for the
 * trace), and computing them together is what keeps the two from drifting.
 */

import type { EnvelopeBase, GateReport, Phase } from "./data_types.ts";
import type { Tracer } from "./tracer.ts";

const KIND_COLOR: Record<string, string> = {
  engineer: "cyan",
  agent: "magenta",
  code: "yellow",
};
const MAX_LINE = 160; // dynamic text (summaries, violations, errors) is clipped

const ANSI: Record<string, string> = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  magenta: "35",
  cyan: "36",
  white: "37",
};

/** Colour only when a human is looking. NO_COLOR is honoured, as it should be. */
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Escape text that must not be read as markup — the counterpart of rich's escape(). */
export function escape(text: string): string {
  return String(text).replaceAll("[", "\\[");
}

/**
 * Render the markup dialect to `{ ansi, plain }`.
 *
 * A `[...]` run is a tag only when every word in it is a known style (or it is
 * a closing tag); anything else is literal text, so a stray `[1]` in a summary
 * survives intact.
 */
export function markup(source: string): { ansi: string; plain: string } {
  const stack: string[][] = [];
  let ansi = "";
  let plain = "";
  let i = 0;

  const active = (): string => {
    const codes = stack.flat().map((style) => ANSI[style]!);
    return codes.length ? `[${codes.join(";")}m` : "";
  };

  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\" && source[i + 1] === "[") {
      plain += "[";
      ansi += "[";
      i += 2;
      continue;
    }
    if (char === "[") {
      const end = source.indexOf("]", i);
      const body = end === -1 ? null : source.slice(i + 1, end);
      if (body !== null) {
        const closing = body.startsWith("/");
        const words = body.replace(/^\//, "").split(/\s+/).filter(Boolean);
        const isTag = closing ? words.every((w) => w in ANSI) : words.length > 0 && words.every((w) => w in ANSI);
        if (isTag) {
          if (closing) stack.pop();
          else stack.push(words);
          if (COLOR) ansi += "[0m" + active();
          i = end + 1;
          continue;
        }
      }
    }
    plain += char;
    ansi += char;
    i += 1;
  }
  if (COLOR && stack.length) ansi += "[0m";
  return { ansi: COLOR ? ansi : plain, plain };
}

function _clip(text: unknown, limit: number = MAX_LINE): string {
  const collapsed = String(text).split(/\s+/).filter(Boolean).join(" ");
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}

/** A bordered box around already-styled rows, sized to its widest plain line. */
function panel(rows: string[], title: string, borderStyle: string): string {
  const rendered = rows.map((row) => markup(row));
  const heading = markup(title);
  // Inner width spans one padding space either side of the widest row.
  const inner =
    Math.max(heading.plain.length + 2, ...rendered.map((row) => row.plain.length)) + 2;
  const border = (text: string) => markup(`[${borderStyle}]${text}[/${borderStyle}]`).ansi;
  const bar = border("│");

  const top =
    border("╭─ ") +
    heading.ansi +
    border(" " + "─".repeat(Math.max(1, inner - 3 - heading.plain.length)) + "╮");
  const body = rendered.map(
    (row) => `${bar} ${row.ansi}${" ".repeat(inner - 2 - row.plain.length)} ${bar}`,
  );
  const bottom = border("╰" + "─".repeat(inner) + "╯");
  return [top, ...body, bottom].join("\n");
}

/** Bound to one run's tracer. Reachable as `run.console` everywhere. */
export class Console {
  private tracer: Tracer;
  private adw_id: string;
  private phase_id = ""; // current lane — log events attach to it
  private phase_name = "";
  private results: string[] = []; // phase statuses, for the summary
  private _finished = false; // the summary panel prints once

  constructor(tracer: Tracer, adw_id: string) {
    this.tracer = tracer;
    this.adw_id = adw_id;
  }

  // ── the one helper: print AND trace, always together ─────────────────────
  private _emit(source: string, level = "info", renderable?: string): void {
    const { ansi, plain } = markup(source);
    console.log(renderable !== undefined ? renderable : ansi);
    this.tracer.event({
      adw_id: this.adw_id,
      phase_id: this.phase_id,
      type: "log",
      name: this.phase_name || "console",
      payload: { message: plain, level },
    });
  }

  // ── session ───────────────────────────────────────────────────────────────
  session_started(adw_id: string, engineer: string): void {
    this._emit(
      `[bold cyan]adw_id:[/bold cyan] [bold]${escape(adw_id)}[/bold]` +
        `   [dim]engineer[/dim] ${escape(engineer)}`,
    );
  }

  session_finished(ok: boolean, tokens: number, cost: number, db_path: string): void {
    if (this._finished) return;
    this._finished = true;
    const passed = this.results.filter((r) => r === "success").length;
    const status = ok ? "[green]✓ success[/green]" : "[red]✗ fail[/red]";
    const rows = [
      ` [dim]status[/dim]   ${status}`,
      ` [dim]phases[/dim]   ${passed}/${this.results.length} passed`,
      ` [dim]tokens[/dim]   ${tokens.toLocaleString("en-US")}`,
      ` [dim]cost[/dim]     $${cost.toFixed(4)}`,
      ` [dim]adw_id[/dim]   ${escape(this.adw_id)}`,
      ` [dim]db[/dim]       ${escape(db_path)}`,
      ` [dim]next[/dim]     [bold]just phases ${escape(this.adw_id)}[/bold]`,
    ];
    const rendered = panel(rows, "[bold]ADW complete[/bold]", ok ? "green" : "red");
    const plain =
      `session ${this.adw_id} ${ok ? "success" : "fail"} · ` +
      `${passed}/${this.results.length} phases · ${tokens.toLocaleString("en-US")} tokens · $${cost.toFixed(4)}`;
    this._emit(escape(plain), ok ? "info" : "error", rendered);
  }

  // ── phases ────────────────────────────────────────────────────────────────
  phase_started(phase: Phase): void {
    this.phase_id = phase.phase_id;
    this.phase_name = phase.params.name;
    const p = phase.params;
    const color = KIND_COLOR[p.kind] ?? "white";
    let line =
      `[bold ${color}]▶ ${String(phase.seq).padStart(2, "0")} ${escape(p.name)}[/bold ${color}]` +
      `  [${color}]${p.kind}[/${color}] [dim]· ${escape(p.owner)}[/dim]`;
    if (p.description) line += `  [dim]${escape(_clip(p.description))}[/dim]`;
    this._emit(line);
  }

  phase_ended(phase: Phase, seconds: number): void {
    const ok = phase.status === "success";
    this.results.push(phase.status);
    let line = `  ${ok ? "[green]✓[/green]" : "[red]✗[/red]"} ${escape(phase.params.name)} [dim]${seconds.toFixed(1)}s[/dim]`;
    if (!ok && phase.error) line += `  [red]${escape(_clip(phase.error))}[/red]`;
    this._emit(line, ok ? "info" : "error");
    this.phase_id = "";
    this.phase_name = "";
  }

  /** Free-form detail inside the current phase — what `ph.log()` recorded. */
  note(message: string): void {
    this._emit(`  [dim]· ${escape(_clip(message))}[/dim]`);
  }

  // ── agents ────────────────────────────────────────────────────────────────
  agent_started(name: string, model: string, session_id: string): void {
    this._emit(
      `  [magenta]▸[/magenta] ${escape(name)} [dim]${escape(model)}[/dim]` +
        `  [dim]session ${escape(session_id)}[/dim]`,
    );
  }

  agent_finished(name: string, tokens: number, cost: number): void {
    this._emit(
      `  [dim]└ ${escape(name)} used ${tokens.toLocaleString("en-US")} tokens · $${cost.toFixed(4)}[/dim]`,
    );
  }

  retry(name: string, attempt: number, limit: number, reason: string): void {
    this._emit(
      `  [yellow]⟳[/yellow] ${escape(name)} retry ${attempt}/${limit} ` +
        `[dim]— same session · ${escape(_clip(reason))}[/dim]`,
      "warn",
    );
  }

  // ── verification ──────────────────────────────────────────────────────────
  /** A gate reports WHAT it checked, not just whether it passed. */
  gate_result(name: string, report: GateReport): void {
    const ok = report.passed;
    const mark = ok ? "[green]✓[/green]" : "[red]✗[/red]";
    const summary = ok
      ? `${report.checks.length} checked`
      : `[red]${report.violations.length} of ${report.checks.length} failed[/red]`;
    this._emit(
      `  ${mark} gate [dim]${escape(name)}[/dim] [dim]${summary}[/dim]`,
      ok ? "info" : "error",
    );
    for (const check of report.checks) {
      const style = check.ok ? "dim" : "dim red";
      const detail = check.note ? ` — ${_clip(check.note)}` : "";
      this._emit(
        `    [${style}]${check.ok ? "·" : "✗"} ${escape(_clip(check.item))}` +
          `${escape(detail)}[/${style}]`,
        check.ok ? "info" : "error",
      );
    }
  }

  envelope_summary(envelope: EnvelopeBase, type_name: string): void {
    const ok = envelope.status === "success";
    const line =
      `  ${ok ? "[green]✓[/green]" : "[red]✗[/red]"} ` +
      `${type_name} [dim]${escape(_clip(envelope.summary))}[/dim]`;
    this._emit(line, ok ? "info" : "error");
    if (envelope.artifacts.length) {
      this._emit(`    [dim]artifacts: ${escape(_clip(envelope.artifacts.join(", ")))}[/dim]`);
    }
  }
}
