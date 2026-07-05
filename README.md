# agent-fixbot

A local CLI runner that operates a **normal GitHub bot account** (no GitHub App) to triage, reproduce, and fix issues, and to review or repair pull requests. It polls a repository with the `gh` CLI, routes `@bot` mentions to commands, prepares an isolated workspace, runs a configured coding agent (`omp` by default) against a rendered prompt, and — only when every safety guard passes — publishes the result as a PR, comment, or label update.

The agent process never sees a GitHub token: all GitHub mutations go through the wrapper via the `gh` CLI.

## How it works

```
poll-comments / poll-issues / dispatch-comment
        │
        ▼
routeComment ──► runCommand (triage | reproduce | fix | fix-ci | review | address-review)
        │
        ▼
gh CLI: issue/PR context, labels, checks, review threads
        │
        ▼
workspace checkout (.workspaces/<owner>-<repo>) ──► rendered prompt (.fixbot/prompt.md)
        │
        ▼
configured agent (omp/pi) writes .fixbot/ artifacts (findings.md, result.md, pr.md, evidence.json)
        │
        ▼
guards: diff size, blocked paths, allowed commands, evidence ──► PR / comment / status label
```

Each mode is two-gated: the agent first triages the issue against the code; it either stops with a findings-only comment (no diff, so no PR) or ships a complete fix with a regression test.

## Requirements

`node`, `pnpm`, `git`, and an authenticated `gh` CLI — verify with:

```bash
pnpm install
pnpm build
node dist/cli.js doctor
```

Log the `gh` CLI into the bot account (see [docs/roboomp-operations.md](docs/roboomp-operations.md) for the full machine-user setup):

```bash
gh auth login --hostname github.com --git-protocol ssh --web --scopes repo
```

## Quick start

```bash
# keep polling issues and comments for a repo until Ctrl+C
pnpm dev -- owner/repo --bot fixbot

# or run individual commands against the built CLI
node dist/cli.js triage owner/repo#123 --dry-run
node dist/cli.js fix owner/repo#123 --dry-run
```

`--dry-run` runs the full pipeline but publishes nothing. Real pushes additionally require `policy.allowPush: true` in `.fixbot.json` — the default is `false`.

## Commands

| Command | Purpose |
| --- | --- |
| `doctor` | Check local tool availability (`node`, `pnpm`, `git`, `gh`). |
| `daemon <owner/repo>` | Poll comments and issues on an interval until Ctrl+C. Alias: `watch`. |
| `prepare <owner/repo#issue>` | Create job and prompt files without running an agent. |
| `triage <owner/repo#issue>` | Run a no-edit triage phase and optionally publish a status comment. |
| `reproduce <owner/repo#issue>` | Run a reproduction-only agent phase and verify its failing test plan. |
| `fix <owner/repo#issue>` | Prepare workspace, run the agent, and publish the PR result. |
| `fix-ci <owner/repo#issue-or-pr>` | Fix failing CI/checks with PR check context when available. |
| `review <owner/repo#pull>` | Review a pull request without editing source code. |
| `address-review <owner/repo#pull>` | Check out an existing PR branch, address review feedback, and push back. |
| `poll-issues <owner/repo>` | Read recently opened/updated issues and apply configured auto labels. |
| `poll-comments <owner/repo>` | Poll recent issue comments and dispatch bot mentions once. |
| `route-comment <event.json>` | Parse a GitHub `issue_comment` payload into a safe bot command. |
| `dispatch-comment <event.json>` | Route and execute a single `issue_comment` payload. |
| `stop <owner/repo#issue-or-pr>` | Stop a running local job for the ref if this host started it. |

Run `node dist/cli.js --help` for flags.

## Bot mentions

Commenting on an issue or PR with a mention of the configured bot name dispatches a command (matched in this order, see `src/features/controller/commentRouter.ts`):

- `@fixbot fix ci` → `fix-ci`
- `@fixbot address review` → `address-review`
- `@fixbot stop` → `stop`
- `@fixbot review` → `review`
- `@fixbot triage` → `triage`
- `@fixbot fix` → `fix`

## Configuration

Optional `.fixbot.json` in the working directory; every field has a default. See [`.fixbot.example.json`](.fixbot.example.json) for the full shape. Highlights:

- `agent` — the coding agent command; default `omp -p @{prompt}`. Point `command`/`args` at `pi` or any CLI agent.
- `autoLabel` — keyword rules applied to newly polled issues.
- `autoDispatch` — automatically start `triage`/`reproduce`/`fix` on new issues (off by default, rate-limited by `maxPerPoll`, gated by `requireLabels`/`skipWhenLabels`).
- `policy` — the safety profile: `allowPush` (default `false`), `maxChangedFiles`, `maxDiffLines`, `blockedPaths`, `allowedCommands`, evidence requirements, and per-outcome status labels.

## Safety model

- **No push by default.** `policy.allowPush: false` keeps every run a dry run against GitHub.
- **Guarded publishing.** The diff is rejected when it exceeds `maxChangedFiles`/`maxDiffLines`, touches `blockedPaths`, or lacks required evidence (`.fixbot/evidence.json`).
- **Token isolation.** The agent only edits files in its workspace; the wrapper performs all GitHub mutations through the `gh` CLI.
- **Single-flight jobs.** A per-ref job lock prevents concurrent runs for the same issue/PR.

## Development

```bash
pnpm typecheck
pnpm test        # builds, then runs node --test against dist/**/*.test.js
```

## Further reading

- [docs/roboomp-operations.md](docs/roboomp-operations.md) — operating the bot as a machine user (Turkish).
- [docs/roboomp-capability-audit.md](docs/roboomp-capability-audit.md) — capability comparison audit (Turkish).
