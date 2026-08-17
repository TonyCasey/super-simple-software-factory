# Prune Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Remove comments that only restate the code, across the files the builder changed (`previous_envelope.changed_files`). Keep every comment that explains *why*, and every comment a machine reads. Change comments only — never code.

1. Read each file in `previous_envelope.changed_files`.
2. Remove the restating comments; keep the load-bearing ones (see your system prompt). When unsure, keep it.
3. Confirm each edited file still compiles/runs.
4. Emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence: what you removed and from how many files>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line subject; unused — the pruner's edits fold into the build commit>",
  "notes_for_next_agent": "<any comment you were unsure about and kept>"
}
```

`changed_files` must list exactly the files you edited — the gate diffs it against the working tree, and a file you touched but did not declare (or declared but did not touch) fails the run.
