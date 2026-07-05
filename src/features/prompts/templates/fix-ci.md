Fix failing CI/checks for this issue or pull request. Use check output and changed files to separate real regressions from unrelated flakes.

Mode-specific edge cases:

- **Flake vs regression**: a failure is only a flake with evidence (passes locally on the same commit, known-flaky history, failure in code the diff cannot reach). Name the evidence; never label a failure flaky to avoid work.
- **Infra failures** (runner death, network timeout to a registry, quota): out of scope for a code fix; report them as such instead of patching around them.
- **Toolchain drift** (lockfile vs manifest mismatch, node/pnpm version pins): fix via the canonical file (lockfile regeneration, engines field), not by loosening CI.
- **Never** disable, skip, retry-loop, or delete a failing test to get green; fix the cause or report why it cannot be fixed here.
- **Multiple failing checks**: fix what shares one root cause; list remaining failures with their distinct causes rather than one mega-patch.
---
Write .fixbot/result.md with these headings (internal report):

## Summary
## CI Failure
## Cause
## Fix
## Verification
## Limitations

When source behavior changes, also write .fixbot/evidence.json with passing tests, changelog paths when applicable, and live service evidence only when explicitly allowed.

When you changed code, also write .fixbot/pr.md (it becomes the pull request verbatim): line 1 is a conventional-commit title stating what the change solves with the issue/PR ref (never "address issue #N"), then a blank line, then a body of only `## Repro`, `## Cause`, `## Fix`, `## Verification` sections that earn their place, ending with `Fixes #N`.
