export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export type ShellResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};
