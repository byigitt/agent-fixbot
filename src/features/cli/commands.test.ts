import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './commands.js';
import { helpText } from './help.js';
import type { ParsedArgs } from './args.js';

function args(command: string, positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command, positional, flags };
}

async function inTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-cli-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

type Outcome = { resolved: string } | { rejected: Error };

async function invoke(parsed: ParsedArgs, cwd: string): Promise<Outcome> {
  try {
    return { resolved: await runCommand(parsed, cwd) };
  } catch (error) {
    return { rejected: error as Error };
  }
}

/** A command is recognized when it does real work or demands its missing input, instead of falling back to help. */
function isRecognized(outcome: Outcome): boolean {
  if ('rejected' in outcome) return /missing/i.test(outcome.rejected.message);
  return outcome.resolved !== helpText;
}

for (const alias of ['help', '--help', '-h']) {
  test(`runCommand ${alias} resolves to the help text`, async () => {
    await inTempCwd(async (cwd) => {
      assert.equal(await runCommand(args(alias), cwd), helpText);
    });
  });
}

test('runCommand falls back to the help text for an unknown command', async () => {
  await inTempCwd(async (cwd) => {
    assert.equal(await runCommand(args('frobnicate'), cwd), helpText);
  });
});

for (const command of ['prepare', 'fix', 'reproduce']) {
  test(`runCommand ${command} without a ref rejects with a usage error`, async () => {
    await inTempCwd(async (cwd) => {
      await assert.rejects(runCommand(args(command), cwd), /Missing issue ref/);
    });
  });
}

test('runCommand route-comment without an event file rejects with a usage error', async () => {
  await inTempCwd(async (cwd) => {
    await assert.rejects(runCommand(args('route-comment'), cwd), /Missing event JSON path/);
  });
});

for (const command of ['triage', 'review', 'address-review', 'fix-ci', 'stop']) {
  test(`runCommand recognizes ${command}`, async () => {
    await inTempCwd(async (cwd) => {
      const outcome = await invoke(args(command), cwd);
      assert.ok(
        isRecognized(outcome),
        `\`${command}\` must not fall through to the generic help screen; it must run or reject with a usage error naming the missing input`
      );
    });
  });
}

test('runCommand exposes a comment dispatch command (dispatch-comment or handle-comment)', async () => {
  await inTempCwd(async (cwd) => {
    const outcomes = await Promise.all(
      ['dispatch-comment', 'handle-comment'].map((command) => invoke(args(command), cwd))
    );
    assert.ok(outcomes.some(isRecognized), 'neither dispatch-comment nor handle-comment is wired into runCommand');
  });
});

function commentEvent(body: string): string {
  return JSON.stringify({
    comment: { body, user: { login: 'alice' } },
    issue: { number: 12 },
    repository: { full_name: 'acme/widgets' }
  });
}

test('runCommand route-comment emits the routed command as JSON', async () => {
  await inTempCwd(async (cwd) => {
    const eventFile = join(cwd, 'event.json');
    await writeFile(eventFile, commentEvent('@fixbot fix ci please'));
    const output = await runCommand(args('route-comment', [eventFile]), cwd);
    assert.deepStrictEqual(JSON.parse(output), {
      command: 'fix-ci',
      ref: { repo: 'acme/widgets', number: 12 },
      actor: 'alice'
    });
  });
});

test('runCommand route-comment emits null when the comment carries no command', async () => {
  await inTempCwd(async (cwd) => {
    const eventFile = join(cwd, 'event.json');
    await writeFile(eventFile, commentEvent('thanks for the quick turnaround'));
    const output = await runCommand(args('route-comment', [eventFile]), cwd);
    assert.equal(JSON.parse(output), null);
  });
});

test('runCommand route-comment honors the --bot flag', async () => {
  await inTempCwd(async (cwd) => {
    const eventFile = join(cwd, 'event.json');
    await writeFile(eventFile, commentEvent('@repair-bot fix the save path'));
    const output = await runCommand(args('route-comment', [eventFile], { bot: 'repair-bot' }), cwd);
    assert.deepStrictEqual(JSON.parse(output), {
      command: 'fix',
      ref: { repo: 'acme/widgets', number: 12 },
      actor: 'alice'
    });
  });
});

test('runCommand poll-comments without a repo rejects with a usage error', async () => {
  await inTempCwd(async (cwd) => {
    await assert.rejects(runCommand(args('poll-comments'), cwd), /Missing repo for poll-comments/);
  });
});

for (const command of ['prepare', 'fix', 'stop']) {
  test(`runCommand ${command} rejects a malformed issue ref`, async () => {
    await inTempCwd(async (cwd) => {
      await assert.rejects(runCommand(args(command, ['not-a-ref']), cwd), /Expected issue ref like owner\/repo#123/);
    });
  });
}

test('runCommand dispatch-comment without an event file rejects with a usage error', async () => {
  await inTempCwd(async (cwd) => {
    await assert.rejects(runCommand(args('dispatch-comment'), cwd), /Missing event JSON path/);
  });
});

test('runCommand dispatch-comment reports when the comment routes no bot command', async () => {
  await inTempCwd(async (cwd) => {
    const eventFile = join(cwd, 'event.json');
    await writeFile(eventFile, commentEvent('deploy notes updated'));
    assert.equal(await runCommand(args('dispatch-comment', [eventFile], { 'dry-run': true }), cwd), 'No bot command routed.\n');
  });
});
