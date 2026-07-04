function escapeRegex(value: string): string {
  return value.replace(/[.+*^${}()|[\]\\]/g, '\\$&');
}

export function minimatchLike(file: string, pattern: string): boolean {
  const normalizedFile = file.replaceAll('\\', '/');
  const normalizedPattern = pattern.replaceAll('\\', '/');
  const regex = '^' + escapeRegex(normalizedPattern)
    .replaceAll('\\*\\*/', '(?:.*/)?')
    .replaceAll('\\*\\*', '.*')
    .replaceAll('\\*', '[^/]*') + '$';
  return new RegExp(regex).test(normalizedFile);
}
