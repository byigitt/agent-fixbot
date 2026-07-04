export class FixbotError extends Error {
  constructor(message: string, readonly code = 'FIXBOT_ERROR') {
    super(message);
    this.name = 'FixbotError';
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FixbotError(message, 'INVARIANT_FAILED');
}
