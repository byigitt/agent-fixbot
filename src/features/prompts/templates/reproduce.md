Create a deterministic failing reproduction for the issue without fixing product/source code.
---
Phase 1 is reproduction-only. Do not fix source code yet.
Only add or edit tests, specs, fixtures, or files under .fixbot/.
Write .fixbot/reproduction.json with this JSON shape:

{
  "status": "ready",
  "summary": "what fails and why this proves the issue",
  "commands": [
    { "command": "pnpm", "args": ["run", "test", "path/to/test"], "expect": "fail", "description": "new failing regression" }
  ]
}

Use status "needs-info", "no-repro", or "blocked" when a deterministic local reproduction is not possible:

- "needs-info": the report is missing something only the reporter has (exact input, version, environment). List the questions in the artifact.
- "no-repro": you followed the report faithfully on this base and the behavior is correct; cite what you ran and observed.
- "blocked": reproduction requires something this environment cannot provide (credentials, a specific platform, a paid service). Name the exact missing piece and add a contract test where feasible.
- Timing/race reports: a reproduction that fails only sometimes is not "ready"; make it deterministic (deferred promises, fake timers, barriers) or report what nondeterminism remains.

## Summary
## Reproduction Attempt
## Commands
## Limitations
---
This job was auto-dispatched from a newly observed issue. A short opener comment was already posted on the issue; do not repeat a status line — get straight to the reproduction findings.
