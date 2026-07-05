export const debugEnabled = ['1', '2', 'true'].includes(process.env.FIXBOT_DEBUG ?? '');

export function debugLog(message: string): void {
  if (debugEnabled) process.stderr.write(`[${new Date().toISOString()}] [debug] ${message}\n`);
}
