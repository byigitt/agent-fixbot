import test from 'node:test';
import assert from 'node:assert/strict';
import { minimatchLike } from './minimatchLike.js';

const cases: Array<{ name: string; file: string; pattern: string; expected: boolean }> = [
  { name: 'literal pattern matches the exact path', file: 'package.json', pattern: 'package.json', expected: true },
  { name: 'literal pattern is anchored to the full path', file: 'src/package.json', pattern: 'package.json', expected: false },
  { name: '* matches within a single segment', file: 'src/a.ts', pattern: 'src/*.ts', expected: true },
  { name: '* does not cross directory separators', file: 'src/lib/a.ts', pattern: 'src/*.ts', expected: false },
  { name: 'trailing ** matches direct children', file: '.github/workflows/ci.yml', pattern: '.github/workflows/**', expected: true },
  { name: 'trailing ** matches nested descendants', file: '.github/workflows/deploy/prod.yml', pattern: '.github/workflows/**', expected: true },
  { name: 'directory prefix must match a whole segment', file: 'scripts/releases/notes.md', pattern: 'scripts/release/**', expected: false },
  { name: 'pattern is anchored at the path start', file: 'vendor/.github/workflows/ci.yml', pattern: '.github/workflows/**', expected: false },
  { name: 'leading **/ matches at the repo root', file: '.env', pattern: '**/.env*', expected: true },
  { name: 'leading **/ matches at any depth', file: 'apps/web/.env.local', pattern: '**/.env*', expected: true },
  { name: 'trailing * still requires the literal stem', file: 'config/environment.ts', pattern: '**/.env*', expected: false },
  { name: 'interior **/ may match zero directories', file: 'src/fixtures/a.json', pattern: 'src/**/fixtures/*.json', expected: true },
  { name: 'interior **/ may match many directories', file: 'src/x/y/fixtures/a.json', pattern: 'src/**/fixtures/*.json', expected: true },
  { name: 'windows separators in the file are normalized', file: 'scripts\\release\\publish.ts', pattern: 'scripts/release/**', expected: true },
  { name: 'regex metacharacters in the pattern stay literal', file: 'docs/aXb.md', pattern: 'docs/a.b.md', expected: false },
  { name: 'escaped dot still matches a literal dot', file: 'docs/a.b.md', pattern: 'docs/a.b.md', expected: true }
];

for (const row of cases) {
  test(`minimatchLike ${row.name}`, () => {
    assert.strictEqual(minimatchLike(row.file, row.pattern), row.expected, `${row.pattern} vs ${row.file}`);
  });
}
