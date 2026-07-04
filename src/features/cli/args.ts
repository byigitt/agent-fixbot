export type ParsedArgs = { command: string; positional: string[]; flags: Record<string, string | boolean> };

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}
