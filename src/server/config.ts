import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
const origin = z
  .string()
  .regex(/^https?:\/\/[^/?#\\\s]+\/?$/i, 'Expected an exact HTTP(S) origin')
  .pipe(z.string().url())
  .transform((value, context) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.hostname.includes('*') ||
      value.includes('@') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Expected an exact HTTP(S) origin without wildcard, path, credentials, query or hash',
      });
      return z.NEVER;
    }
    return url.origin;
  });
const project = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1),
    path: z.string().refine(isAbsolute, 'Project path must be absolute'),
  })
  .strict();
export const configSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    publicOrigin: z
      .array(origin)
      .min(1)
      .default(['http://127.0.0.1:8787'])
      .transform((values) => [...new Set(values)]),
    developmentOrigins: z.array(origin).default([]),
    dataDir: z.string().min(1).default('./.local/codex-web'),
    codex: z
      .object({
        binary: z.string().min(1).default('codex'),
        home: z.string().refine(isAbsolute).optional(),
        requestTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
      })
      .strict()
      .default({ binary: 'codex', requestTimeoutMs: 30_000 }),
    auth: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('local') }).strict(),
        z
          .object({
            mode: z.literal('cloudflare-access'),
            issuer: z.string().url(),
            audience: z.string().min(1),
          })
          .strict(),
      ])
      .default({ mode: 'local' }),
    projects: z.array(project).min(1),
    limits: z
      .object({
        eventBytes: z
          .number()
          .int()
          .min(1024)
          .max(64 * 1024 * 1024)
          .default(16 * 1024 * 1024),
        wsBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024)
          .default(4 * 1024 * 1024),
        itemBytes: z
          .number()
          .int()
          .min(1024)
          .max(8 * 1024 * 1024)
          .default(2 * 1024 * 1024),
      })
      .strict()
      .default({
        eventBytes: 16 * 1024 * 1024,
        wsBytes: 4 * 1024 * 1024,
        itemBytes: 2 * 1024 * 1024,
      }),
  })
  .strict();
export type AppConfig = z.infer<typeof configSchema> & { demo: boolean };
export function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}
export function parseConfig(value: unknown, filename: string, development = false): AppConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_CONFIG', parsed.error.message);
  const config = parsed.data;
  if (new Set(config.projects.map((p) => p.id)).size !== config.projects.length)
    throw new AppError('INVALID_CONFIG', 'Project IDs must be unique');
  if (config.auth.mode === 'local' && !isLoopback(config.host))
    throw new AppError('INVALID_CONFIG', 'Local mode requires a loopback host');
  if (config.developmentOrigins.some((o) => !isLoopback(new URL(o).hostname)))
    throw new AppError('INVALID_CONFIG', 'Development origins must be loopback');
  if (config.auth.mode === 'cloudflare-access') {
    const issuer = new URL(config.auth.issuer);
    if (
      issuer.protocol !== 'https:' ||
      !issuer.hostname.endsWith('.cloudflareaccess.com') ||
      issuer.pathname !== '/' ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password
    )
      throw new AppError(
        'INVALID_CONFIG',
        'Access issuer must be https://<team>.cloudflareaccess.com',
      );
    if (config.publicOrigin.some((value) => new URL(value).protocol !== 'https:'))
      throw new AppError('INVALID_CONFIG', 'All Access public origins must use HTTPS');
    config.auth.issuer = issuer.origin;
  }
  return {
    ...config,
    developmentOrigins: development ? config.developmentOrigins : [],
    dataDir: resolve(dirname(filename), config.dataDir),
    demo: false,
  };
}
export function cliOptions(args = process.argv.slice(2)): {
  configPath: string;
  development: boolean;
} {
  const remaining = args.filter((arg) => arg !== '--');
  let configPath = 'config.local.json';
  let development = false;
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i];
    if (arg === '--dev') development = true;
    else if (arg === '--config' && remaining[i + 1]) configPath = remaining[++i]!;
    else throw new AppError('INVALID_ARGUMENT', `Unknown or incomplete argument: ${arg}`);
  }
  return { configPath: resolve(configPath), development };
}
export async function loadConfig(options = cliOptions()): Promise<AppConfig> {
  return parseConfig(
    JSON.parse(await readFile(options.configPath, 'utf8')),
    options.configPath,
    options.development,
  );
}
