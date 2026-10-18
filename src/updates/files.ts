import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { cp, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    await syncDirectory(dirname(filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function copyDurable(source: string, target: string) {
  await cp(source, target);
  const file = await open(target, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(target));
}
