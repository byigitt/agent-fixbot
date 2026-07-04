import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n');
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value);
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}
