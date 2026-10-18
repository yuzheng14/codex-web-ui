import { main } from '../../src/cli/main.ts';
await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
import console from 'node:console';
import process from 'node:process';
