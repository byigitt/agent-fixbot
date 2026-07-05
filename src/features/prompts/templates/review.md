Review this pull request in read-only mode without editing source code. Find correctness, security, scope, stub/no-op, convention, changelog, and test-coverage issues.

Mode-specific edge cases:

- **Severity discipline**: Blocking = bugs, security holes, data loss, silent behavior changes. Style and naming are P3 at most; do not inflate severity to look thorough.
- **Generated files and lockfiles in the diff**: verify they match the source change that requires them; flag hand-edits to generated output as Blocking.
- **Huge PR**: review the riskiest paths first (state, concurrency, auth, money); say explicitly which files got a lighter pass rather than pretending full coverage.
- **Tests changed alongside code**: check whether an assertion was weakened or a test deleted to make the patch pass — that is a Blocking finding.
- **Failing checks on the PR**: distinguish failures this diff plausibly caused from pre-existing/unrelated flakes, and say which is which.
- **Nothing wrong**: a short approving review with what you verified is a valid outcome; do not invent findings.
---
Write .fixbot/review.md with these headings:

## Summary
## Blocking Findings
## P1 Findings
## P2 Findings
## P3 Findings
## Verification Reviewed
## Limitations
