import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueRef, type IssueRef } from './ref.js';
import { FixbotError } from '../../shared/errors.js';

const accepted: Array<{ name: string; input: string; expected: IssueRef }> = [
  { name: 'shorthand owner/repo#N', input: 'acme/widgets#123', expected: { repo: 'acme/widgets', number: 123 } },
  { name: 'shorthand with surrounding whitespace', input: '  acme/widgets#5\n', expected: { repo: 'acme/widgets', number: 5 } },
  { name: 'issue URL', input: 'https://github.com/acme/widgets/issues/42', expected: { repo: 'acme/widgets', number: 42 } },
  { name: 'pull request URL', input: 'https://github.com/acme/widgets/pull/7', expected: { repo: 'acme/widgets', number: 7 } },
  {
    name: 'issue URL with trailing fragment',
    input: 'https://github.com/acme/widgets/issues/42#issuecomment-99',
    expected: { repo: 'acme/widgets', number: 42 }
  }
];

for (const row of accepted) {
  test(`parseIssueRef accepts ${row.name}`, () => {
    assert.deepStrictEqual(parseIssueRef(row.input), row.expected);
  });
}

const rejected: Array<{ name: string; input: string }> = [
  { name: 'repo without an issue number', input: 'acme/widgets' },
  { name: 'shorthand with empty number', input: 'acme/widgets#' },
  { name: 'shorthand with non-numeric number', input: 'acme/widgets#12x' },
  { name: 'shorthand without an owner', input: 'widgets#12' },
  { name: 'non-https URL', input: 'http://github.com/acme/widgets/issues/42' },
  { name: 'URL for a non-issue resource', input: 'https://github.com/acme/widgets/releases/42' },
  { name: 'empty string', input: '' }
];

for (const row of rejected) {
  test(`parseIssueRef rejects ${row.name}`, () => {
    assert.throws(
      () => parseIssueRef(row.input),
      (error: unknown) => error instanceof FixbotError && error.code === 'BAD_REF'
    );
  });
}
