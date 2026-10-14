import { describe, expect, it } from 'vitest';
import {
  blocksTarget,
  readOperations,
  saveOperations,
  type SavedOperation,
} from '../../src/web/lib/operations';

describe('durable operation identity', () => {
  it('persists uncertain IDs and targets across refresh without persisting prompts or projections', () => {
    let data = '';
    const storage = {
      setItem: (_key: string, value: string) => {
        data = value;
      },
      getItem: () => data,
    };
    const entry: SavedOperation = {
      clientOperationId: 'operation-id',
      kind: 'send',
      target: 'thread-id',
      createdAt: 1,
      status: 'acknowledged',
      operation: {
        clientOperationId: 'operation-id',
        kind: 'turn.start',
        target: 'thread-id',
        status: 'acknowledged',
        result: { sensitive: 'prompt should not persist' },
        createdAt: 1,
        updatedAt: 2,
      },
    };
    expect(saveOperations([entry], storage)).toBe(true);
    expect(data).not.toContain('sensitive');
    expect(readOperations(storage)).toEqual([
      {
        clientOperationId: 'operation-id',
        kind: 'send',
        target: 'thread-id',
        createdAt: 1,
        status: 'unknown',
      },
    ]);
  });
  it('handles disabled storage and corrupt prior preferences without crashing', () => {
    expect(
      saveOperations([], {
        setItem: () => {
          throw new Error('disabled');
        },
      }),
    ).toBe(false);
    expect(readOperations({ getItem: () => '{invalid' })).toEqual([]);
    expect(readOperations({ getItem: () => '[null, {"target":123}]' })).toEqual([]);
  });
  it('preserves fork identity and cancelled navigation while discarding response projections', () => {
    let data = '';
    const storage = {
      setItem: (_key: string, value: string) => {
        data = value;
      },
      getItem: () => data,
    };
    const entry: SavedOperation = {
      clientOperationId: 'fork-id',
      kind: 'fork',
      target: 'source-thread',
      projectId: 'project',
      createdAt: 1,
      status: 'unknown',
      navigateToResult: false,
      error: 'Response details are not durable',
    };
    expect(saveOperations([entry], storage)).toBe(true);
    expect(readOperations(storage)).toEqual([{ ...entry, error: undefined }]);
    expect(data).not.toContain('Response details');
    expect(blocksTarget(readOperations(storage)[0]!, 'source-thread')).toBe(true);
  });
  it('retains unknown audit state without blocking new work after explicit reconciliation', () => {
    const entry: SavedOperation = {
      clientOperationId: 'old',
      kind: 'send',
      target: 'thread',
      createdAt: 1,
      status: 'unknown',
    };
    expect(blocksTarget(entry, 'thread')).toBe(true);
    entry.operation = {
      clientOperationId: 'old',
      kind: 'turn.start',
      target: 'thread',
      status: 'unknown',
      createdAt: 1,
      updatedAt: 2,
      reconciliation: { at: 2, decision: 'confirmed-ended' },
    };
    expect(blocksTarget(entry, 'thread')).toBe(false);
    expect(entry.operation.status).toBe('unknown');
  });
});
