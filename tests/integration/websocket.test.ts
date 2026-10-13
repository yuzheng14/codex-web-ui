import { expect, it } from 'vitest';
import { sendBounded, type SocketSink } from '../../src/server/websocket.js';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
function socket(bufferedAmount = 0) {
  const sent: string[] = [];
  const closed: number[] = [];
  let terminated = false;
  const sink: SocketSink = {
    readyState: 1,
    bufferedAmount,
    send: (text) => sent.push(text),
    close: (code) => closed.push(code),
    terminate: () => {
      terminated = true;
    },
  };
  return { sink, sent, closed, isTerminated: () => terminated };
}
it('isolates a slow consumer from a fast browser, including runtime broadcasts', () => {
  const slow = socket(4080),
    fast = socket();
  const event: ServerMessage = {
    type: 'error',
    error: { code: 'RUNTIME_RESET', message: '重新读取运行状态' },
  };
  sendBounded(slow.sink, event, 4096);
  sendBounded(fast.sink, event, 4096);
  expect(slow.closed).toEqual([4008]);
  expect(slow.sent).toEqual([]);
  expect(slow.isTerminated()).toBe(true);
  expect(fast.sent).toHaveLength(1);
});
it('restores control state with bounded large-output snapshots without mutating history', () => {
  const thread: ThreadView = {
    id: 'thread',
    projectId: 'p',
    cwd: '/tmp',
    source: 'appServer',
    title: 'Test',
    status: 'waitingApproval',
    managed: true,
    turns: [
      {
        id: 'turn',
        threadId: 'thread',
        status: 'waitingApproval',
        items: Array.from({ length: 4 }, (_, i) => ({
          id: String(i),
          type: 'commandExecution',
          output: 'x'.repeat(2 * 1024 * 1024),
        })),
      },
    ],
    actions: [
      {
        actionId: 'action',
        codexEpoch: 'epoch',
        rpcId: 0,
        kind: 'command',
        threadId: 'thread',
        turnId: 'turn',
        status: 'pending',
        title: 'Approve command',
        options: [{ id: 'accept', label: '允许' }],
      },
    ],
  };
  const fast = socket();
  sendBounded(
    fast.sink,
    {
      type: 'snapshot',
      cursor: { serverEpoch: 'server', seq: 1 },
      threadId: 'thread',
      data: thread,
    },
    4 * 1024 * 1024,
  );
  expect(fast.closed).toEqual([]);
  expect(Buffer.byteLength(fast.sent[0]!)).toBeLessThan(4 * 1024 * 1024);
  const restored = JSON.parse(fast.sent[0]!);
  expect(restored.data.actions[0].rpcId).toBe(0);
  expect(restored.data.historyTruncated).toBe(true);
  expect(thread.turns[0]?.items[0]?.output?.length).toBe(2 * 1024 * 1024);
});
