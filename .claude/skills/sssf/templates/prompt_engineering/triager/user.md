# Triage Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

`prompt` contains a ticket (title, description, and any comments). Read `<context_handoff_dir>/ticket.json` for the full structured ticket. Scan the repo for the context the ticket assumes. Decide: implementable as written, or not without answers. Write your triage note to `<context_handoff_dir>/triage.md`, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ClarityOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence: the verdict and why>",
  "clear": false,
  "classification": "feature",
  "questions": [
    "<a concrete question the ticket author must answer — empty array when clear is true>"
  ],
  "artifacts": ["<context_handoff_dir>/triage.md"]
}
```
