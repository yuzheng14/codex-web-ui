import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { upgradeWebSocket, type HttpBindings } from '@hono/node-server';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';
import { IMAGE_REQUEST_BYTES } from '../shared/images.js';
import * as schemas from '../shared/validation.js';
import type { Operation } from '../shared/types.js';
import type { AppConfig } from './config.js';
import { createAuthenticator, type Authenticator, type Identity } from './auth.js';
import type { GatewayService } from './service.js';
import { socketHandlers } from './websocket.js';
export interface HttpDependencies {
  config: AppConfig;
  service: GatewayService;
  staticDir: string;
  authenticate?: Authenticator;
}
export function createApp({
  config,
  service,
  staticDir,
  authenticate = createAuthenticator(config),
}: HttpDependencies) {
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { identity: Identity; operationId?: string };
  }>();
  app.onError((error, c) => {
    const failure =
      error instanceof AppError
        ? error
        : error instanceof ZodError || error instanceof SyntaxError
          ? new AppError('VALIDATION_FAILED', 'Invalid request data', 400)
          : new AppError('INTERNAL_ERROR', 'An internal error occurred', 500);
    return c.json({ error: failure.toJSON(c.get('operationId')) }, failure.status as 400);
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('*', async (c, next) => {
    c.set('identity', await authenticate(c.req.raw, c.req.path === '/ws'));
    await next();
  });
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize: /^\/api\/threads\/[^/]+\/(turns|steer)$/.test(c.req.path)
        ? IMAGE_REQUEST_BYTES
        : 512 * 1024,
      onError: () => {
        throw new AppError('BODY_TOO_LARGE', 'Request body exceeds limit', 413);
      },
    })(c, next),
  );
  const id = (value: string) => schemas.idSchema.parse(value);
  const parse = async <T>(
    c: { req: { json: () => Promise<unknown> }; set: (key: 'operationId', value: string) => void },
    schema: ZodType<T>,
  ): Promise<T> => {
    const value: unknown = await c.req.json();
    if (
      value &&
      typeof value === 'object' &&
      'clientOperationId' in value &&
      typeof value.clientOperationId === 'string'
    )
      c.set('operationId', value.clientOperationId);
    return schema.parse(value);
  };
  const status = (op: Operation) =>
    op.status === 'dispatching' || op.status === 'accepted' ? (202 as const) : (200 as const);
  app.get('/api/system', (c) => c.json(service.getSystem()));
  app.post('/api/system/compatibility/confirm', async (c) => {
    const op = await service.confirmCompatibility(
      await parse(c, schemas.confirmCompatibilitySchema),
    );
    return c.json(op, status(op));
  });
  app.get('/api/projects', async (c) => c.json({ data: await service.listProjects() }));
  app.get('/api/projects/:projectId/runtime-settings', async (c) =>
    c.json(await service.readRuntimeSettings(id(c.req.param('projectId')))),
  );
  app.post('/api/projects/:projectId/model-defaults', async (c) => {
    const op = await service.saveModelDefaults(
      id(c.req.param('projectId')),
      await parse(c, schemas.saveModelDefaultsSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/projects', async (c) =>
    c.json(service.addProject(await parse(c, schemas.createProjectSchema))),
  );
  app.post('/api/projects/:projectId/rename', async (c) =>
    c.json(
      service.renameProject(
        id(c.req.param('projectId')),
        await parse(c, schemas.renameProjectSchema),
      ),
    ),
  );
  app.post('/api/projects/:projectId/remove', async (c) => {
    await parse(c, schemas.removeProjectSchema);
    return c.json(service.removeProject(id(c.req.param('projectId'))));
  });
  app.get('/api/projects/:projectId/threads', async (c) =>
    c.json(
      await service.listThreadSummaries(
        id(c.req.param('projectId')),
        c.req.query('cursor') === undefined
          ? undefined
          : schemas.cursorSchema.parse(c.req.query('cursor')),
        schemas.archivedQuerySchema.parse(c.req.query('archived')),
      ),
    ),
  );
  app.get('/api/threads', async (c) =>
    c.json(
      await service.listThreads(
        id(c.req.query('projectId') ?? ''),
        c.req.query('cursor') === undefined
          ? undefined
          : schemas.cursorSchema.parse(c.req.query('cursor')),
        schemas.archivedQuerySchema.parse(c.req.query('archived')),
      ),
    ),
  );
  app.post('/api/threads/:threadId/archive', async (c) => {
    return c.json(
      await service.setThreadArchived(
        id(c.req.param('threadId')),
        await parse(c, schemas.archiveThreadSchema),
      ),
    );
  });
  app.get('/api/threads/:threadId', async (c) =>
    c.json(await service.getThread(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/metadata', async (c) =>
    c.json(await service.getThreadMetadata(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/export', async (c) => {
    const exported = await service.exportThread(id(c.req.param('threadId')));
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Export-Completeness', exported.partial ? 'partial' : 'saved-history');
    return c.body(exported.markdown);
  });
  app.get('/api/threads/:threadId/images', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    const image = await service.getThreadImage(id(c.req.param('threadId')), c.req.query('path'));
    return c.body(image.bytes, 200, {
      'Content-Type': image.contentType,
      'Content-Length': String(image.bytes.length),
    });
  });
  app.get('/api/operations/:operationId', (c) =>
    c.json(service.getOperation(id(c.req.param('operationId')))),
  );
  app.post('/api/projects/:projectId/threads', async (c) => {
    const op = await service.createThread(
      id(c.req.param('projectId')),
      await parse(c, schemas.createThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/resume', async (c) => {
    const op = await service.resumeThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.resumeThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/fork', async (c) => {
    const op = await service.forkThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.forkThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/rename', async (c) => {
    const op = await service.renameThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.renameThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/turns', async (c) => {
    const op = await service.startTurn(
      id(c.req.param('threadId')),
      await parse(c, schemas.startTurnSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/review', async (c) => {
    const op = await service.startReview(
      id(c.req.param('threadId')),
      await parse(c, schemas.startReviewSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/steer', async (c) => {
    const op = await service.steer(
      id(c.req.param('threadId')),
      await parse(c, schemas.steerSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/compact', async (c) => {
    const op = await service.compactThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.operationSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/interrupt', async (c) => {
    const op = await service.interrupt(
      id(c.req.param('threadId')),
      await parse(c, schemas.interruptSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/actions/:actionId/resolve', async (c) => {
    const op = await service.resolveAction(
      id(c.req.param('actionId')),
      await parse(c, schemas.resolveActionSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/operations/:operationId/reconcile', async (c) => {
    const op = await service.reconcileOperation(
      id(c.req.param('operationId')),
      await parse(c, schemas.reconcileSchema),
    );
    return c.json(op, status(op));
  });
  app.get(
    '/ws',
    upgradeWebSocket((c) =>
      socketHandlers(service, config, c.get('identity'), c.req.query('overview') === '1'),
    ),
  );
  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', 'API route not found', 404);
  });
  app.all('/api', () => {
    throw new AppError('NOT_FOUND', 'API route not found', 404);
  });
  app.all('/ws/*', () => {
    throw new AppError('NOT_FOUND', 'WebSocket route not found', 404);
  });
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      // Remote Markdown images load directly in the browser, including HTTPS redirects.
      // Keep scripts, connections and all other resource policies restricted as before.
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    await next();
  });
  app.get('*', serveStatic({ root: staticDir }));
  app.get('*', async (c, next) => {
    if (!c.req.header('accept')?.includes('text/html') || /\.[^/]+$/.test(c.req.path))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404);
    return serveStatic({ path: `${staticDir}/index.html` })(c, next);
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404));
  return app;
}
