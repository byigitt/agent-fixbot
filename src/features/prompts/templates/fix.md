Work in two gated phases:

1. **Triage first.** Judge the issue against the code: is it real, in scope, actionable, and unambiguous enough to implement without guessing?
2. **Then either stop or fix.**
   - Triage says the issue needs answers from the reporter, is a duplicate, is not a bug, or is a maintainer decision → write .fixbot/findings.md with that verdict (and the questions, max 3) and STOP. No code changes, so no PR opens.
   - Triage says it is sensible and implementable → implement the fix in this checkout and produce a narrow, human-reviewable patch. The PR opens automatically from your diff.

Never half-commit: either a findings-only stop or a complete fix with its regression test.

Mode-specific edge cases:

- **Cannot reproduce**: do not fix blind. Write findings.md explaining what you tried, what the code says, and what information would unlock a repro; leave the tree clean so no PR opens.
- **The "fix" would be a behavior change users may depend on**: pick the interpretation that preserves existing documented behavior; flag the alternative as a maintainer decision in findings.md.
- **Fix is correct but a pre-existing test now fails**: decide whether the test pinned the bug (update it, and say so) or the test caught your regression (fix your patch). Never delete or skip a test to get green.
- **Nothing to change** (already fixed, not a bug, duplicate): findings.md carries the full explanation; make no code edits so no PR opens.
- **Partial fix only feasible**: ship the safe core with its regression test; enumerate the remaining cases in Limitations with file:line pointers.
- **New dependency seems needed**: it almost never is. Prefer stdlib or existing deps; a new dependency requires justification in the PR body naming what was rejected and why.
---
First, after reproducing and identifying the root cause, write .fixbot/findings.md: a short issue comment (5-15 lines) with the root cause and the exact evidence (file:line, failing test output). It is posted on the issue before the PR link, so write it as a standalone maintainer comment. Do not include the fix description there.

Then write .fixbot/result.md with these headings (internal report; use only the headings that earn their place):

## Summary
## Repro
## Cause
## Fix
## Verification
## Limitations

When source behavior changes, also write .fixbot/evidence.json with passing tests, changelog paths when applicable, and live service evidence only when explicitly allowed.

When you changed code, also write .fixbot/pr.md — it becomes the pull request verbatim:
- Line 1: the PR title in conventional-commit style, stating what the change solves, ending with the issue ref — e.g. `fix(cli): handle empty save names on submit (#12)`. Never a generic "address issue #N".
- Blank line, then the body with only these sections, each earning its place: `## Repro`, `## Cause`, `## Fix`, `## Verification`. Evidence-first, exact file:line references, real command output in Verification.
- End the body with `Fixes #N`. No summaries of what you were asked to do, no changed-file counts, no sign-off.
---
This job was auto-dispatched from a newly observed issue. A short opener comment was already posted on the issue; do not repeat a status line in any artifact — get straight to the findings.
