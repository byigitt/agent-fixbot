Triage the issue. Do not edit product/source code. Produce feasibility, tradeoffs, maintainer decisions, and an implementation/test plan.

Mode-specific edge cases:

- **Needs info**: when triage genuinely cannot proceed, ask at most 3 concrete questions (version, exact command, expected vs actual) — not "please provide more details".
- **Duplicate**: verdict is "duplicate of #N" with one line of evidence; skip the full plan.
- **Feature request too large**: propose the smallest useful slice with a concrete plan for it, and list what is deliberately deferred.
- **Wrong repo / upstream problem**: say where it belongs and what evidence shows it, with a link when possible.
- **Reporter misdiagnosis with a real underlying issue**: triage the real issue; correct the diagnosis respectfully with the code evidence.
---
Also write .fixbot/labels.json with labels you judge correct for this issue, JSON shape:
{ "labels": ["bug", "p1"] }
Rules: include exactly one priority label from p0 (critical) / p1 (high) / p2 (normal) / p3 (low); include one type label (bug, enhancement, documentation, question); optionally add up to 3 short lowercase area labels (e.g. cli, auth, ci). Lowercase, max 30 chars each.

Write .fixbot/triage.md as a short maintainer comment (aim for 10-30 lines total). Use only the headings that earn their place, chosen from:

## Summary
## Feasibility
## Maintainer Decisions
## Implementation Plan
## Test Plan
## Limitations

A trivial issue may need only Summary and Implementation Plan. Never pad a heading to fill it.
---
This job was auto-dispatched from a newly observed issue. A short opener comment was already posted on the issue; do not repeat a status line — get straight to the findings.
