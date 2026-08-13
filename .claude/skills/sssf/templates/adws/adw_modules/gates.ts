/**
 * Validation gates: verify the envelope's CLAIMS, never guesses.
 *
 * A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
 * Violations are derived from the failed checks and sent back to the SAME agent
 * session as a correction. Every check is recorded either way, so a green gate
 * says WHAT it verified instead of only that it passed.
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 */

import { readFileSync, statSync } from "node:fs";

import type { EnvelopeBase, Gate } from "./data_types.ts";
import { GateReport } from "./data_types.ts";

const TAIL_CHARS = 1000; // command output kept as evidence on a failure

function _stat(path: string): { size: number; isFile: boolean } | null {
  try {
    const info = statSync(path);
    return { size: info.size, isFile: info.isFile() };
  } catch {
    return null;
  }
}

function _size(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

export function artifacts_exist(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const info = _stat(a);
    report.check(
      a,
      info !== null,
      info ? `exists, ${_size(info.size)}` : "declared artifact does not exist",
    );
  }
  return report;
}

export function files_non_empty(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const info = _stat(a);
    if (!info?.isFile) continue; // existence is artifacts_exist's job
    const empty = info.size === 0;
    report.check(a, !empty, empty ? "declared artifact is empty" : _size(info.size));
  }
  return report;
}

export function json_parses(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    if (!a.endsWith(".json") || !_stat(a)) continue;
    try {
      const parsed = JSON.parse(readFileSync(a, "utf8"));
      report.check(a, true, `parses, ${Array.isArray(parsed) ? "list" : typeof parsed}`);
    } catch (error) {
      report.check(a, false, `declared JSON artifact does not parse: ${error}`);
    }
  }
  return report;
}

/** Every file claimed changed must exist on disk. */
export function diff_matches_claims(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  for (const f of (envelope as any).changed_files ?? []) {
    const info = _stat(f);
    report.check(
      f,
      info !== null,
      info ? `exists, ${_size(info.size)}` : "claimed changed file does not exist",
    );
  }
  return report;
}

/**
 * A review's verdict must agree with the findings it just wrote down.
 *
 * Nothing here judges the code — that is the reviewer's job. This checks the
 * envelope against itself: an approval that ships blocking items, or a
 * rejection that names no problem, is a claim the harness can refute without
 * reading a line of the diff.
 */
export function verdict_consistent(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  const approved = Boolean((envelope as any).approved);
  const blocking: string[] = (envelope as any).blocking ?? [];
  const unmet: string[] = ((envelope as any).findings ?? [])
    .filter((f: any) => !f.met)
    .map((f: any) => f.requirement);

  report.check(
    "approved vs blocking",
    !(approved && blocking.length > 0),
    !blocking.length
      ? "no blocking items"
      : approved
        ? `${blocking.length} blocking item(s) while approved=true`
        : `${blocking.length} blocking item(s), not approved`,
  );
  report.check(
    "approved vs findings",
    !(approved && unmet.length > 0),
    !unmet.length
      ? "every requirement met"
      : approved
        ? `${unmet.length} unmet requirement(s) while approved=true`
        : `${unmet.length} unmet requirement(s), not approved`,
  );
  report.check(
    "rejection names a problem",
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length || unmet.length
      ? "verdict is supported"
      : "approved=false but no blocking item or unmet requirement was given",
  );
  return report;
}

/** Gate factory: the given shell command must exit 0. */
export function tests_pass(command: string): Gate {
  const gate = (_envelope: EnvelopeBase, _run: any): GateReport => {
    const result = Bun.spawnSync(["sh", "-c", command]);
    const ok = result.exitCode === 0;
    let note = `exit ${result.exitCode}`;
    if (!ok) {
      note +=
        "\n" + (result.stdout.toString() + result.stderr.toString()).slice(-TAIL_CHARS);
    }
    return new GateReport().check(command, ok, note);
  };
  // The trace records WHICH gate ran, so a factory-built one has to say which
  // command it was — an anonymous closure would log every suite as the same gate.
  Object.defineProperty(gate, "name", { value: `tests_pass(${command})` });
  return gate;
}

// ── ticket-loop gates ────────────────────────────────────────────────────────

/**
 * A triage verdict must be internally consistent: unclear demands questions,
 * clear forbids them. An agent that says "unclear" with nothing to ask has
 * produced a verdict nobody can act on.
 */
export function clarity_consistent(envelope: EnvelopeBase, _run: any): GateReport {
  const report = new GateReport();
  const e = envelope as EnvelopeBase & { clear?: boolean; questions?: string[] };
  const questions = e.questions ?? [];
  if (e.clear === false) {
    report.check(
      "questions_present",
      questions.length > 0,
      questions.length ? `${questions.length} question(s) to post` : "clear=false but no questions — nothing to ask the ticket",
    );
  } else {
    report.check(
      "no_dangling_questions",
      questions.length === 0,
      questions.length ? "clear=true yet questions remain — pick one" : "clear verdict, no questions",
    );
  }
  return report;
}

/**
 * Factory: every unresolved review thread classified exactly once. A thread
 * the triage skipped is review feedback silently dropped; one classified twice
 * would be answered twice.
 */
export function triage_covers(thread_ids: string[]): Gate {
  return function triage_covers(envelope: EnvelopeBase, _run: any): GateReport {
    const report = new GateReport();
    const items = ((envelope as any).items ?? []) as { thread_id: string }[];
    const seen = new Map<string, number>();
    for (const item of items) seen.set(item.thread_id, (seen.get(item.thread_id) ?? 0) + 1);
    for (const id of thread_ids) {
      const count = seen.get(id) ?? 0;
      report.check(
        id,
        count === 1,
        count === 0 ? "unresolved thread not classified" : count === 1 ? "classified once" : `classified ${count} times`,
      );
    }
    for (const [id, count] of seen) {
      if (!thread_ids.includes(id)) {
        report.check(id, false, `classified a thread that is not unresolved (${count}x)`);
      }
    }
    return report;
  };
}
