import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ApiError } from '../../shared/types.js';

export const operations = sqliteTable(
  'operations',
  {
    clientOperationId: text('client_operation_id').primaryKey(),
    kind: text('kind').notNull(),
    target: text('target').notNull(),
    requestDigest: text('request_digest').notNull(),
    state: text('state', {
      enum: ['accepted', 'dispatching', 'acknowledged', 'failed', 'unknown'],
    }).notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error', { mode: 'json' }).$type<ApiError>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    reconciledAt: integer('reconciled_at'),
    reconciliationDecision: text('reconciliation_decision'),
  },
  (table) => [
    check(
      'operations_state_check',
      sql`${table.state} in ('accepted', 'dispatching', 'acknowledged', 'failed', 'unknown')`,
    ),
    index('operations_state_idx').on(table.state),
  ],
);

export const executionMarkers = sqliteTable(
  'execution_markers',
  {
    operationId: text('operation_id')
      .primaryKey()
      .references(() => operations.clientOperationId),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    workspaceKey: text('workspace_key').notNull(),
    codexEpoch: text('codex_epoch').notNull(),
    state: text('state', { enum: ['active', 'unknown', 'terminal', 'reconciled'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    endedAt: integer('ended_at'),
    reconciledAt: integer('reconciled_at'),
    reconciliationOperationId: text('reconciliation_operation_id').references(
      () => operations.clientOperationId,
    ),
  },
  (table) => [
    check(
      'execution_markers_state_check',
      sql`${table.state} in ('active', 'unknown', 'terminal', 'reconciled')`,
    ),
    uniqueIndex('execution_markers_active_thread')
      .on(table.threadId)
      .where(sql`${table.endedAt} is null`),
    uniqueIndex('execution_markers_active_workspace')
      .on(table.workspaceKey)
      .where(sql`${table.endedAt} is null`),
  ],
);

export const threadLinks = sqliteTable('thread_links', {
  threadId: text('thread_id').primaryKey(),
  projectId: text('project_id').notNull(),
  cwd: text('cwd').notNull(),
  source: text('source').notNull(),
  managedEpoch: text('managed_epoch'),
  updatedAt: integer('updated_at').notNull(),
});

export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});
