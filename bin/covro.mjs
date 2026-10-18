#!/usr/bin/env node
import console from 'node:console';
import process from 'node:process';
import { main } from '../dist/cli/main.js';
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Covro failed');
  process.exitCode = 1;
});
