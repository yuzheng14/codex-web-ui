import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('removes retired protocol types and preserves the previous protocol when generation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-generate-'));
  try {
    const binary = join(root, 'fixture-cli.mjs');
    await writeFile(
      binary,
      `#!${process.execPath}\nimport { mkdirSync, writeFileSync, existsSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log('codex-cli 0.163.0');\nelse { const out = process.argv[process.argv.indexOf('--out') + 1]; mkdirSync(out, { recursive: true }); writeFileSync(out + '/Current.ts', 'export type Current = string;'); if (existsSync('${root}/fail')) process.exit(1); }\n`,
    );
    await chmod(binary, 0o755);
    await writeFile(join(root, 'config.json'), JSON.stringify({ codex: { binary } }));
    const generated = join(root, 'src/codex/generated');
    await mkdir(generated, { recursive: true });
    await writeFile(join(generated, 'Retired.ts'), 'old');
    const run = () =>
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          resolve('scripts/generate-codex.ts'),
          '--config',
          join(root, 'config.json'),
        ],
        { cwd: root },
      );
    await run();
    expect(await readdir(generated)).toEqual(['Current.ts']);
    const metadata = await readFile(join(root, 'src/codex/protocol-version.json'), 'utf8');
    expect(JSON.parse(metadata)).toMatchObject({ version: 'codex-cli 0.163.0' });
    await writeFile(join(root, 'fail'), '');
    await expect(run()).rejects.toThrow();
    expect(await readFile(join(root, 'src/codex/protocol-version.json'), 'utf8')).toBe(metadata);
    expect(await readdir(generated)).toEqual(['Current.ts']);
    expect(await readdir(join(root, 'src/codex'))).toEqual(['generated', 'protocol-version.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
