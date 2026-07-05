import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSafeArgs } from './exec.js';

test('renderSafeArgs shows safe args in full', () => {
  assert.equal(renderSafeArgs('omp', ['-p', '/tmp/prompt.md']), 'omp -p /tmp/prompt.md');
  assert.equal(
    renderSafeArgs('gh', ['api', '--method', 'GET', 'repos/acme/widgets/issues', '-f', 'per_page=50']),
    'gh api --method GET repos/acme/widgets/issues -f per_page=50'
  );
});

test('renderSafeArgs redacts payload flags and field values', () => {
  assert.equal(renderSafeArgs('gh', ['issue', 'comment', '5', '--body', 'secret text']), 'gh issue comment 5 --body [redacted]');
  assert.equal(renderSafeArgs('gh', ['api', '-f', 'body=long payload']), 'gh api -f body=[redacted]');
  assert.equal(renderSafeArgs('gh', ['api', '--raw-field', 'query=query{...}']), 'gh api --raw-field query=[redacted]');
  assert.equal(renderSafeArgs('gh', ['pr', 'create', '--body=inline payload']), 'gh pr create --body=[redacted]');
  assert.equal(renderSafeArgs('gh', ['api', '-f=body=inline payload']), 'gh api -f=body=[redacted]');
});

test('renderSafeArgs scrubs token-like strings and truncates long args', () => {
  assert.match(renderSafeArgs('git', ['push', 'https://ghp_abc123@github.com/a/b.git']), /\[redacted\]@github\.com/);
  assert.ok(renderSafeArgs('x', ['y'.repeat(300)]).length < 200);
});
