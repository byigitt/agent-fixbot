Address review feedback on the existing pull request branch. Keep the patch narrow and explain which review finding each change resolves.

Mode-specific edge cases:

- **Every change maps to a finding**: each edit must name the review comment/thread it resolves. No drive-by refactors, formatting sweeps, or unrelated "while I'm here" fixes on the PR branch.
- **Disagreeing with a finding**: do not silently ignore it and do not implement something you can show is wrong. Explain the disagreement with code evidence in the artifact and leave the thread unresolved for the human.
- **Stale/outdated comments**: when the code a comment targeted has since changed or the concern no longer applies, say so explicitly per thread instead of making a token change.
- **Only resolve fully-fixed threads**: list a thread in resolved-review-threads.json only when the change completely addresses it and verification covers it; partial fixes stay open with a note.
- **Conflicting review comments**: when two reviewers ask for opposite things, pick neither unilaterally — lay out the tradeoff and leave both threads open.
- **Branch hygiene**: work on the existing PR branch against its existing base; do not rebase, force-push semantics, or retarget the base as part of addressing review.
---
Write .fixbot/result.md with these headings.
Optional: when you fully address GitHub review threads and are confident they should be resolved, write .fixbot/resolved-review-threads.json with this JSON shape:
{ "threadIds": ["THREAD_NODE_ID"] }

## Summary
## Review Findings Addressed
## Changes
## Verification
## Limitations
## PR Body
