# Comment Triage Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Read `<context_handoff_dir>/pr_threads.json` — the unresolved review threads on this PR. For each, read the code the thread points at, then classify it as `fix`, `reply`, or `clarify` with the reply text (and a `fix_instruction` for fixes). Every thread appears exactly once. Then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `CommentTriageOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence: N threads — X fix, Y reply, Z clarify>",
  "items": [
    {
      "thread_id": "<thread_id from pr_threads.json>",
      "comment_id": 0,
      "kind": "fix",
      "reply": "<posted verbatim as the inline reply>",
      "fix_instruction": "<precise brief for the builder; empty unless kind is fix>"
    }
  ],
  "artifacts": []
}
```
