import type { Operation } from '../../shared/types';
import { HttpError } from './api';
import { readableError } from './utils';

const STORAGE_KEY = 'codex-web.operations.v1';
export interface ThreadMutation {
  projectId: string;
  archived: boolean;
}

export interface SavedOperation {
  clientOperationId: string;
  kind: string;
  target: string;
  createdAt: number;
  status: Operation['status'];
  operation?: Operation;
  error?: string;
  lookupError?: { message: string; missing: boolean };
  projectId?: string;
  navigateToResult?: boolean;
  mutation?: ThreadMutation;
  /** Navigation when Fork was clicked, which can differ from its source row and project. */
  navigationSource?: { projectId: string; threadId: string | null };
}

export function operationLookupError(problem: unknown): NonNullable<SavedOperation['lookupError']> {
  const missing =
    problem instanceof HttpError &&
    problem.status === 404 &&
    problem.problem.code === 'OPERATION_NOT_FOUND';
  return {
    missing,
    message: missing
      ? '无法确认提交：当前服务未找到这笔提交记录（404 / OPERATION_NOT_FOUND）。请求可能未到达服务，或服务数据已更换；这不能证明任务没有执行。'
      : `无法确认提交：${readableError(problem)}`,
  };
}

/** A missing receipt is not a failed task. Only an explicit local decision can dismiss it. */
export function canDiscardMissingOperation(entry: SavedOperation) {
  return entry.lookupError?.missing === true && entry.status === 'unknown' && !entry.operation;
}

/** Persist operation identity and navigation intent, never prompts, answers or RPC credentials. */
export function readOperations(storage?: Pick<Storage, 'getItem'>): SavedOperation[] {
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is SavedOperation =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof entry.clientOperationId === 'string' &&
          typeof entry.target === 'string' &&
          typeof entry.kind === 'string' &&
          typeof entry.createdAt === 'number',
      )
      .map(
        ({
          clientOperationId,
          kind,
          target,
          createdAt,
          projectId,
          navigateToResult,
          navigationSource,
          mutation,
        }) => ({
          clientOperationId,
          kind,
          target,
          createdAt,
          status: 'unknown',
          ...(kind === 'archive' &&
          typeof mutation?.projectId === 'string' &&
          typeof mutation.archived === 'boolean'
            ? { mutation: { projectId: mutation.projectId, archived: mutation.archived } }
            : {}),
          ...((kind === 'fork' || kind === 'create') && typeof projectId === 'string'
            ? { projectId, navigateToResult: navigateToResult === true }
            : {}),
          ...(kind === 'fork' &&
          typeof navigationSource?.projectId === 'string' &&
          (navigationSource.threadId === null || typeof navigationSource.threadId === 'string')
            ? {
                navigationSource: {
                  projectId: navigationSource.projectId,
                  threadId: navigationSource.threadId,
                },
              }
            : {}),
        }),
      );
  } catch {
    return [];
  }
}

export function saveOperations(operations: SavedOperation[], storage?: Pick<Storage, 'setItem'>) {
  try {
    (storage ?? localStorage).setItem(
      STORAGE_KEY,
      JSON.stringify(
        operations.map(
          ({
            clientOperationId,
            kind,
            target,
            createdAt,
            projectId,
            navigateToResult,
            navigationSource,
            mutation,
          }) => ({
            clientOperationId,
            kind,
            target,
            createdAt,
            ...(kind === 'fork' || kind === 'create' ? { projectId, navigateToResult } : {}),
            ...(kind === 'archive' && mutation ? { mutation } : {}),
            ...(kind === 'fork' && navigationSource ? { navigationSource } : {}),
          }),
        ),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export function needsReconciliation(operation: SavedOperation) {
  return (
    operation.status === 'unknown' ||
    (operation.operation?.execution !== undefined && !operation.operation.execution.ended)
  );
}

export function isSettled(operation: Operation) {
  return (
    operation.status === 'failed' ||
    (operation.status === 'acknowledged' && (!operation.execution || operation.execution.ended))
  );
}

export function blocksTarget(entry: SavedOperation, target: string) {
  return (
    entry.target === target &&
    !entry.operation?.reconciliation &&
    !entry.operation?.execution?.ended &&
    ['accepted', 'dispatching', 'unknown'].includes(entry.status)
  );
}
