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
}

/** Only operation identities and targets are durable. Prompts, answers and RPC credentials are not stored. */
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
      .map(({ clientOperationId, kind, target, createdAt }) => ({
        clientOperationId,
        kind,
        target,
        createdAt,
        status: 'unknown',
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
        operations.map(({ clientOperationId, kind, target, createdAt }) => ({
          clientOperationId,
          kind,
          target,
          createdAt,
        })),
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
