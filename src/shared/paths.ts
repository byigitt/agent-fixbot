import path from 'node:path';

export function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function resolveInside(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes root: ${resolved}`);
  }
  return resolved;
}

export function quoteForDisplay(value: string): string {
  return value.includes(' ') ? JSON.stringify(value) : value;
}
