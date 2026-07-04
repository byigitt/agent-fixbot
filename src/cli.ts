#!/usr/bin/env node
import { parseArgs } from './features/cli/args.js';
import { runCommand } from './features/cli/commands.js';

try {
  const output = await runCommand(parseArgs(process.argv.slice(2)), process.cwd());
  process.stdout.write(output);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
