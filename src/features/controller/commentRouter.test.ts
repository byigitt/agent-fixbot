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

const routedTo = (command: 'fix' | 'fix-ci' | 'address-review' | 'stop' | 'triage' | 'review'): RoutedCommand => ({
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
  { name: 'routes triage', event: event('@fixbot triage this crash'), botName: 'fixbot', expected: routedTo('triage') },
  { name: 'routes review', event: event('@fixbot review this change'), botName: 'fixbot', expected: routedTo('review') },
  { name: 'review command is case-insensitive', event: event('@FixBot REVIEW'), botName: 'fixbot', expected: routedTo('review') },
  { name: 'address review outranks plain review', event: event('@fixbot please address review notes'), botName: 'fixbot', expected: routedTo('address-review') },
  { name: 'stop outranks review', event: event('@fixbot stop the review'), botName: 'fixbot', expected: routedTo('stop') },
  { name: 'review substring (prefix) routes nothing', event: event('@fixbot previews are broken'), botName: 'fixbot', expected: undefined },
  { name: 'review substring (suffix) routes nothing', event: event('@fixbot reviewed and approved'), botName: 'fixbot', expected: undefined },
  { name: 'triage substring routes nothing', event: event('@fixbot triaged this yesterday'), botName: 'fixbot', expected: undefined },
];

for (const row of cases) {
  test(`routeComment ${row.name}`, () => {
    assert.deepStrictEqual(routeComment(row.event, row.botName), row.expected);
  });
}
