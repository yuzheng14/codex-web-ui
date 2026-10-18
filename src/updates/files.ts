import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
export async function readJson<T>(filename: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function saveJson(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}
