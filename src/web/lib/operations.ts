import type { Operation } from '../../shared/types';

const STORAGE_KEY = 'codex-web.operations.v1';
export interface SavedOperation {
  clientOperationId: string;
  kind: string;
  target: string;
  createdAt: number;
  status: Operation['status'];
  operation?: Operation;
  error?: string;
  projectId?: string;
  navigateToResult?: boolean;
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
      .map(({ clientOperationId, kind, target, createdAt, projectId, navigateToResult }) => ({
        clientOperationId,
        kind,
        target,
        createdAt,
        status: 'unknown',
        ...((kind === 'fork' || kind === 'create') && typeof projectId === 'string'
          ? { projectId, navigateToResult: navigateToResult === true }
          : {}),
      }));
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
          ({ clientOperationId, kind, target, createdAt, projectId, navigateToResult }) => ({
            clientOperationId,
            kind,
            target,
            createdAt,
            ...(kind === 'fork' || kind === 'create' ? { projectId, navigateToResult } : {}),
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
    ['accepted', 'dispatching', 'unknown'].includes(entry.status)
  );
}
