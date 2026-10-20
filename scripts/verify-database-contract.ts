import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { databaseCompatibilitySchema } from '../src/shared/database.js';
import { readMigrations } from '../src/server/db/history.js';

export function verifyDatabaseContract(root = '.') {
  const metadata = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
    covroDatabase?: unknown;
  };
  const contract = databaseCompatibilitySchema.parse(metadata.covroDatabase);
  if (readMigrations(`${root}/drizzle`).length !== contract.schemaVersion)
    throw new Error('DB Schema version must match the committed migration count');
  return contract;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  verifyDatabaseContract();
