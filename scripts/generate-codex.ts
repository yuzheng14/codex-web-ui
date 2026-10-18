import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const configIndex = args.indexOf('--config');
const configPath = resolve(configIndex >= 0 ? args[configIndex + 1]! : 'config.local.json');
let binary = 'codex';
try {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { codex?: { binary?: string } };
  binary = config.codex?.binary ?? binary;
} catch (error) {
  if (configIndex >= 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const run = promisify(execFile);
const { stdout } = await run(binary, ['--version']);
const output = resolve('src/codex/generated');
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), '.generated-'));
try {
  // Generate into an empty tree so removed upstream types cannot survive an upgrade.
  // A failed generator leaves the previously checked-in protocol untouched.
  await run(binary, ['app-server', 'generate-ts', '--out', staging], {
    maxBuffer: 16 * 1024 * 1024,
  });
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
await writeFile(
  resolve('src/codex/protocol-version.json'),
  JSON.stringify(
    {
      version: stdout.trim(),
      generatedAt: new Date().toISOString(),
      command: 'codex app-server generate-ts --out ./src/codex/generated',
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`Generated protocol from ${stdout.trim()}\n`);
