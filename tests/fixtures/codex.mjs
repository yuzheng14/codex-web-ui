#!/usr/bin/env node
// Repository-owned protocol fixture launcher, including the CLI version handshake.
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

if (process.argv.includes('--version')) console.log('codex-cli 0.163.0');
else {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./app-server.ts', import.meta.url)),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 1));
}
