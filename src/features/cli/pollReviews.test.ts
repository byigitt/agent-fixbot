import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '../../shared/fs.js';
import { runCommand } from './commands.js';
import type { ParsedArgs } from './args.js';

const REPO = 'acme/widgets';
const BOT = 'repair-bot';
// The only comment that counts: a plain human conversation comment on the bot PR.
const PLAIN_COMMENT_AT = '2026-07-01T10:00:00.000Z';

// PR #5 conversation (`gh api repos/acme/widgets/issues/5/comments`): one plain
// human comment that must restart the loop, plus two newer comments that must
// not — a bot mention (the comment router's job) and the bot's own status comment.
const conversationComments = [
  {
    body: 'Could you also handle the empty-name case here?',
    user: { login: 'reporter' },
    updated_at: PLAIN_COMMENT_AT
  },
  {
    body: `@${BOT} stop`,
    user: { login: 'reporter' },
    updated_at: '2026-07-01T11:00:00Z'
  },
  {
    body: 'Fix up at https://github.com/acme/widgets/pull/5.',
    user: { login: BOT },
    updated_at: '2026-07-01T12:00:00Z'
  }
];

type Harness = { root: string; cwd: string; callsFile: string };

// Fake `gh` serving one open bot PR with no review activity and the fixture
// conversation, logging every invocation and rejecting any mutation.
async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-poll-reviews-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const conversationFile = join(root, 'conversation.json');
  const callsFile = join(root, 'gh-calls.log');
  await writeFile(conversationFile, JSON.stringify(conversationComments));
  await writeFile(callsFile, '');
  const script = `#!/bin/sh
all="$*"
printf '%s\\n' "$all" >> "${callsFile}"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
case "$all" in
  *"--method POST"*|*"--method PATCH"*|*"--method PUT"*|*"--method DELETE"*) fail "review poll must not mutate GitHub" ;;
esac
case "$all" in
  "pr list"*"--state open"*) printf '%s' '[{"number":5,"author":{"login":"${BOT}"},"headRefName":"fixbot/issue-3-widget"}]' ;;
  *"repos/acme/widgets/pulls/5/reviews"*) echo "[]" ;;
  *"repos/acme/widgets/pulls/5/comments"*) echo "[]" ;;
  *"repos/acme/widgets/issues/5/comments"*) cat "${conversationFile}" ;;
  *) fail "unexpected gh call" ;;
esac
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, cwd, callsFile };
}

function poll(flags: ParsedArgs['flags']): ParsedArgs {
  return { command: 'poll-reviews', positional: [REPO], flags: { bot: BOT, ...flags } };
}

test('poll-reviews restarts the loop on plain PR conversation comments', async (t) => {
  const h = await makeHarness();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(h.root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const stateFile = join(h.cwd, '.fixbot', 'review-state', 'acme-widgets.json');
  const queueFile = join(h.cwd, '.fixbot', 'queue', 'acme-widgets.json');
  try {
    await t.test('review loop stays off without autoDispatch', async () => {
      const out = await runCommand(poll({}), h.cwd);
      assert.ok(out.includes('review loop off'), out);
      assert.equal((await readFile(h.callsFile, 'utf8')).trim(), '', 'disabled loop must not call gh');
    });

    await t.test('dry-run previews the queue without persisting anything', async () => {
      await writeFile(join(h.cwd, '.fixbot.json'), JSON.stringify({ autoDispatch: { enabled: true } }));
      const out = await runCommand(poll({ 'dry-run': true }), h.cwd);
      // The activity timestamp is the plain comment's, proving the newer bot
      // comment and bot mention were not counted as feedback.
      assert.ok(out.includes(`Would queue address-review for ${REPO}#5 (activity ${PLAIN_COMMENT_AT})`), out);
      assert.equal(await pathExists(stateFile), false, 'dry-run wrote review state');
      assert.equal(await pathExists(queueFile), false, 'dry-run wrote the job queue');
    });

    await t.test('real pass queues address-review and advances the cursor', async () => {
      const out = await runCommand(poll({}), h.cwd);
      assert.ok(out.includes(`Queued address-review for ${REPO}#5`), out);
      const queue = JSON.parse(await readFile(queueFile, 'utf8')) as { items?: { number: number; mode: string }[] };
      assert.equal(queue.items?.length, 1, JSON.stringify(queue));
      assert.equal(queue.items?.[0]?.number, 5);
      assert.equal(queue.items?.[0]?.mode, 'address-review');
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as { prs?: Record<string, string> };
      assert.equal(state.prs?.['5'], PLAIN_COMMENT_AT);
    });

    await t.test('already-seen comments do not restart the loop', async () => {
      const out = await runCommand(poll({}), h.cwd);
      assert.ok(out.includes('No new review activity.'), out);
      const queue = JSON.parse(await readFile(queueFile, 'utf8')) as { items?: unknown[] };
      assert.equal(queue.items?.length, 1, 'stale activity re-enqueued a job');
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(h.root, { recursive: true, force: true });
  }
});
