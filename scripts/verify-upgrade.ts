/** Real daemon/worker/SQLite verification; npm transport is an explicit local fixture. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { control, stopAndWait } from '../src/cli/control.js';
import { paths } from '../src/cli/paths.js';
import { saveJson } from '../src/updates/files.js';
import type { UpdateRun } from '../src/shared/updates.js';
import { transactionPaths } from '../src/updates/transaction.js';
const metadata = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const [major, minor, patch] = metadata.version.split('-')[0]!.split('.');

for (const mode of ['success', 'failure', 'repair', 'repair-live', 'repair-resumed'] as const) {
  const failure = mode !== 'success';
  const repair = mode.startsWith('repair');
  const directory = await mkdtemp('/private/tmp/covro-verify-').catch(async () => {
    const { tmpdir } = await import('node:os');
    return mkdtemp(join(tmpdir(), 'cv-'));
  });
  const root = join(directory, 'npm/lib/node_modules/covro');
  const home = join(directory, 'home');
  const config = join(directory, 'config.json');
  const priorHome = process.env.COVRO_HOME;
  process.env.COVRO_HOME = home;
  const location = paths(config);
  process.env.COVRO_HOME = priorHome;
  if (priorHome === undefined) delete process.env.COVRO_HOME;
  let child: ReturnType<typeof spawn> | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  const candidate = join(directory, 'candidate');
  const target = `${major}.${minor}.${BigInt(patch!) + 1n}-dev.${failure ? 2 : 1}`;
  try {
    await mkdir(root, { recursive: true });
    for (const entry of ['bin', 'dist', 'package.json'])
      await cp(resolve(entry), join(root, entry), { recursive: true });
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    await cp(root, candidate, { recursive: true });
    const next = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    next.version = target;
    next.covroChannel = 'dev';
    await saveJson(join(candidate, 'package.json'), next);
    if (failure) {
      const journalFile = join(candidate, 'dist/drizzle/meta/_journal.json');
      const journal = JSON.parse(await readFile(journalFile, 'utf8'));
      const last = journal.entries.at(-1);
      journal.entries.push({
        ...last,
        idx: last.idx + 1,
        when: last.when + 1,
        tag: '9999_upgrade_probe',
      });
      await saveJson(journalFile, journal);
      await writeFile(
        join(candidate, 'dist/drizzle/9999_upgrade_probe.sql'),
        'CREATE TABLE covro_upgrade_probe (id TEXT);',
      );
      const daemonFile = join(candidate, 'dist/cli/daemon.js');
      const daemon = await readFile(daemonFile, 'utf8');
      const marker = 'runtime = await startGateway(config, { updates, maintenance });';
      if (!daemon.includes(marker)) throw new Error('Missing readiness fixture insertion point');
      await writeFile(
        daemonFile,
        daemon.replace(
          marker,
          `${marker}\nthrow new Error('Simulated candidate readiness failure');`,
        ),
      );
    }
    const commands = join(directory, 'commands');
    await mkdir(commands);
    const npm = join(commands, 'npm');
    await writeFile(
      npm,
      `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]==='root')console.log(${JSON.stringify(join(directory, 'npm/lib/node_modules'))});else if(args[0]==='install'){const prefix=args[args.indexOf('--prefix')+1];fs.mkdirSync(prefix,{recursive:true});fs.cpSync(${JSON.stringify(candidate)},path.join(prefix,'lib/node_modules/covro'),{recursive:true});}else process.exit(2);\n`,
    );
    await chmod(npm, 0o700);
    const env = { ...process.env, PATH: `${commands}:${process.env.PATH}`, COVRO_HOME: home };
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Expected port');
    await new Promise<void>((done) => probe.close(() => done()));
    const origin = `http://127.0.0.1:${address.port}`;
    await saveJson(config, {
      port: address.port,
      publicOrigin: [origin],
      dataDir: './data',
      codex: { binary: join(directory, 'missing-codex') },
    });
    child = spawn(process.execPath, [join(root, 'bin/covro.mjs'), 'run', '--config', config], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 120; i++) {
      try {
        await control(location, 'status');
        break;
      } catch {
        if (i === 119) throw new Error('Old daemon did not start');
      }
      await setTimeout(100);
    }
    const post = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ path: directory, name: 'Preserved project' }),
    });
    if (!post.ok) throw new Error('Could not register original project');
    const updateDir = join(
      home,
      'updates',
      createHash('sha256')
        .update(root + '/')
        .digest('hex')
        .slice(0, 16),
    );
    // packageRoot from URL includes a trailing slash; preserve the production installation identity.
    const context = {
      location,
      root: root + '/',
      dataDir: join(directory, 'data'),
      directory: updateDir,
    };
    await mkdir(updateDir, { recursive: true });
    await saveJson(join(updateDir, 'context.json'), context);
    const id = randomUUID();
    await saveJson(join(updateDir, 'run.json'), {
      id,
      from: metadata.version,
      target,
      channel: 'dev',
      phase: mode === 'repair' ? 'verifying' : repair ? 'failed' : 'installing',
      message: 'Fixture npm transport',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (mode === 'repair') {
      // Model a process crash after candidate migrations, before activation was committed.
      const admission = await control<{ ready: boolean }>(location, 'prepare-update');
      if (!admission.ready) throw new Error('Original service did not close admission');
      await stopAndWait(location);
      const snapshot = transactionPaths(
        root,
        id,
        context.dataDir,
        config,
        join(updateDir, `backup-${id}`),
      );
      await mkdir(snapshot.backup, { recursive: true });
      await cp(join(context.dataDir, 'app.sqlite'), join(snapshot.backup, 'app.sqlite'));
      await cp(config, join(snapshot.backup, 'config.json'));
      await saveJson(join(snapshot.backup, 'snapshot.json'), { complete: true });
      await rename(root, snapshot.previous);
      await cp(candidate, root, { recursive: true });
      const interrupted = new Database(join(context.dataDir, 'app.sqlite'));
      interrupted.exec('CREATE TABLE covro_upgrade_probe (id TEXT)');
      interrupted.close();
    }
    if (mode === 'repair-resumed') {
      // A previous recovery resumed writes but left an old package backup behind.
      const snapshot = transactionPaths(
        root,
        id,
        context.dataDir,
        config,
        join(updateDir, `backup-${id}`),
      );
      await cp(root, snapshot.previous, { recursive: true });
      const saved = await fetch(`${origin}/api/projects`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ path: commands, name: 'Must retain resumed data' }),
      });
      if (!saved.ok) throw new Error('Could not write resumed-service data');
    }
    worker = spawn(
      process.execPath,
      [resolve('dist/update-worker.cjs'), updateDir, ...(repair ? ['--repair'] : [])],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let errors = '';
    worker.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const exit = await Promise.race([
      once(worker, 'exit'),
      setTimeout(100_000, undefined, { ref: false }).then(() => {
        throw new Error('Upgrade worker timed out');
      }),
    ]);
    const record = JSON.parse(await readFile(join(updateDir, 'run.json'), 'utf8')) as UpdateRun;
    if (
      exit[0] !== (mode === 'repair-resumed' ? 1 : 0) ||
      record.phase !== (mode === 'repair-resumed' ? 'failed' : failure ? 'rolledBack' : 'succeeded')
    )
      throw new Error(`Unexpected upgrade outcome: ${JSON.stringify(record)} ${errors}`);
    const current = await control<{ version: string; maintenance: boolean }>(location, 'status');
    if (current.version !== (failure ? metadata.version : target) || current.maintenance)
      throw new Error('Service activation did not settle');
    const projects = (await (await fetch(`${origin}/api/projects`)).json()) as {
      data: { name: string }[];
    };
    if (!projects.data.some((project) => project.name === 'Preserved project'))
      throw new Error('Project data was lost');
    if (
      mode === 'repair-resumed' &&
      !projects.data.some((project) => project.name === 'Must retain resumed data')
    )
      throw new Error('Resumed-service data was overwritten');
    const db = new Database(join(directory, 'data/app.sqlite'), { readonly: true });
    try {
      if (
        failure &&
        db.prepare("SELECT name FROM sqlite_master WHERE name='covro_upgrade_probe'").get()
      )
        throw new Error('Failed candidate migration was not rolled back');
    } finally {
      db.close();
    }
    console.log(
      `PASS: real worker ${mode === 'repair-resumed' ? 'refused snapshot restore after the original service resumed writes' : repair ? 'repaired an interrupted activation and verified the restored service' : failure ? 'restored package, database and project after failed migration/readiness' : 'activated exact candidate and reopened task admission'} (fixture npm transport)`,
    );
  } finally {
    await stopAndWait(location).catch(() => {});
    for (const process of [worker, child])
      if (process && process.exitCode === null) {
        process.kill('SIGTERM');
        await once(process, 'exit');
      }
    await rm(directory, { recursive: true, force: true });
  }
}
