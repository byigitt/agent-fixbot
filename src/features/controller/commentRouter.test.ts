import test from 'node:test';
import assert from 'node:assert/strict';
import { routeComment, type CommentEvent, type RoutedCommand } from './commentRouter.js';

function event(body: string, overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    comment: { body, user: { login: 'alice' } },
    issue: { number: 12 },
    repository: { full_name: 'acme/widgets' },
    ...overrides
  };
}

const routedTo = (command: 'fix' | 'fix-ci' | 'address-review' | 'stop'): RoutedCommand => ({
  command,
  ref: { repo: 'acme/widgets', number: 12 },
  actor: 'alice'
});

const cases: Array<{ name: string; event: CommentEvent; botName: string; expected: RoutedCommand }> = [
  { name: 'routes fix', event: event('@fixbot fix the flaky save path'), botName: 'fixbot', expected: routedTo('fix') },
  { name: 'fix ci outranks plain fix', event: event('@fixbot fix ci for this branch'), botName: 'fixbot', expected: routedTo('fix-ci') },
  { name: 'routes address-review', event: event('@fixbot address review feedback'), botName: 'fixbot', expected: routedTo('address-review') },
  { name: 'stop outranks fix', event: event('@fixbot stop fixing this'), botName: 'fixbot', expected: routedTo('stop') },
  { name: 'mention and command are case-insensitive', event: event('@FixBot FIX CI'), botName: 'fixbot', expected: routedTo('fix-ci') },
  { name: 'custom bot name matches case-insensitively', event: event('@Repair-Bot fix'), botName: 'repair-bot', expected: routedTo('fix') },
  { name: 'bare mention routes nothing', event: event('@fixbot thanks for the report'), botName: 'fixbot', expected: undefined },
  { name: 'comment without a mention routes nothing', event: event('please fix this soon'), botName: 'fixbot', expected: undefined },
  { name: 'mention of a different bot routes nothing', event: event('@fixbot fix'), botName: 'repairbot', expected: undefined },
  { name: 'missing repository routes nothing', event: event('@fixbot fix', { repository: {} }), botName: 'fixbot', expected: undefined },
  { name: 'missing issue number routes nothing', event: event('@fixbot fix', { issue: {} }), botName: 'fixbot', expected: undefined },
  { name: 'missing comment body routes nothing', event: event('@fixbot fix', { comment: { user: { login: 'alice' } } }), botName: 'fixbot', expected: undefined },
  { name: 'lookalike bot mention routes nothing', event: event('@fixbotty please fix'), botName: 'fixbot', expected: undefined },
  { name: 'command substring routes nothing', event: event('@fixbot prefix looks wrong'), botName: 'fixbot', expected: undefined },
  { name: 'bot mention suffix routes nothing', event: event('@repair-bot-extra fix'), botName: 'repair-bot', expected: undefined },
];

for (const row of cases) {
  test(`routeComment ${row.name}`, () => {
    assert.deepStrictEqual(routeComment(row.event, row.botName), row.expected);
  });
}
