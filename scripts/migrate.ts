import { join } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { acquireInstanceLock } from '../src/server/instance-lock.js';
import { openDatabase } from '../src/server/db/index.js';
import { migrateDatabase } from '../src/server/db/migrate.js';
const config = await loadConfig();
const release = await acquireInstanceLock(config.dataDir);
try {
  const db = openDatabase(join(config.dataDir, 'app.sqlite'));
  try {
    migrateDatabase(db.database);
    console.log('Database migrations applied.');
  } finally {
    db.close();
  }
} finally {
  await release();
}
