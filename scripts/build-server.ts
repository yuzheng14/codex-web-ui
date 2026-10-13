import { cp, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
const directories = ['src/server', 'src/shared', 'src/codex'];
const entries: string[] = [];
for (const directory of directories) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.parentPath.includes('/generated'))
      entries.push(`${entry.parentPath}/${entry.name}`);
  }
}
await build({
  entryPoints: entries,
  outdir: 'dist',
  outbase: 'src',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
