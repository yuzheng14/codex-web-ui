import { describe, expect, it } from 'vitest';
import { mapAutoReview } from '../../src/codex/auto-review.js';
import type { GuardianApprovalReviewAction } from '../../src/codex/generated/v2/GuardianApprovalReviewAction.js';
import { Projection } from '../../src/server/projection.js';
import { compactThreadForTransport } from '../../src/server/snapshot.js';
import type { AutoReviewView, ThreadView } from '../../src/shared/types.js';

const review = (overrides: Partial<AutoReviewView> = {}): AutoReviewView => ({
  reviewId: 'review-1',
  targetItemId: 'command-1',
  status: 'inProgress',
  actionLabel: '命令执行',
  actionSummary: 'curl https://example.com',
  startedAtMs: 100,
  ...overrides,
});
const thread = (id = 'thread-1'): ThreadView => ({
  id,
  projectId: 'project',
  cwd: '/workspace',
  source: 'appServer',
  title: 'Task',
  managed: true,
  status: 'running',
  actions: [],
  turns: [{ id: 'turn-1', threadId: id, status: 'running', items: [] }],
});
const reviews = (projection: Projection, threadId = 'thread-1') =>
  projection.get(threadId)!.turns.flatMap((turn) => turn.items.filter((item) => item.autoReview));

describe('automatic review notification mapping', () => {
  it('keeps the independent review identity, decision and exact rationale', () => {
    expect(
      mapAutoReview({
        threadId: 'thread-1',
        turnId: 'turn-1',
        reviewId: 'network-review',
        targetItemId: null,
        startedAtMs: 100,
        completedAtMs: 200,
        decisionSource: 'agent',
        action: {
          type: 'networkAccess',
          target: 'example.com:443',
          host: 'example.com',
          protocol: 'https',
          port: 443,
        },
        review: {
          status: 'denied',
          rationale: '请求会上传私人数据。\n需要明确授权。',
          riskLevel: 'high',
          userAuthorization: 'low',
        },
      }),
    ).toEqual({
      reviewId: 'network-review',
      status: 'denied',
      startedAtMs: 100,
      completedAtMs: 200,
      actionLabel: '网络访问',
      actionSummary: 'https://example.com:443\nexample.com:443',
      rationale: '请求会上传私人数据。\n需要明确授权。',
      riskLevel: 'high',
      userAuthorization: 'low',
    });
  });

  it.each([
    [{ type: 'command', source: 'shell', command: 'ls -la', cwd: '/workspace' }, 'ls -la'],
    [
      {
        type: 'execve',
        source: 'shell',
        program: '/bin/ls',
        argv: ['ls', '-la'],
        cwd: '/workspace',
      },
      '/bin/ls',
    ],
    [
      {
        type: 'writeStdin',
        approvalId: 'approval-1',
        processId: '42',
        stdin: 'yes\n',
        cwd: '/workspace',
      },
      'yes\n',
    ],
    [{ type: 'applyPatch', cwd: '/workspace', files: ['/workspace/a.txt'] }, '/workspace/a.txt'],
    [
      {
        type: 'mcpToolCall',
        server: 'github',
        toolName: 'upload',
        connectorId: null,
        connectorName: 'GitHub',
        toolTitle: '上传附件',
      },
      'github/upload',
    ],
    [
      {
        type: 'requestPermissions',
        reason: '需要保存截图',
        permissions: {
          network: { enabled: true },
          fileSystem: { read: null, write: ['/workspace/screenshots'] },
        },
      },
      '/workspace/screenshots',
    ],
  ] as const)(
    'summarizes the reviewed action without changing authorization: %j',
    (action, expected) => {
      const mapped = mapAutoReview({
        threadId: 'thread-1',
        turnId: 'turn-1',
        reviewId: 'review-1',
        targetItemId: 'command-1',
        startedAtMs: 100,
        action: action as unknown as GuardianApprovalReviewAction,
        review: { status: 'inProgress', rationale: null, riskLevel: null, userAuthorization: null },
      });
      expect(mapped.actionSummary).toContain(expected);
      expect(mapped.status).toBe('inProgress');
      expect(mapped.rationale).toBeUndefined();
    },
  );
});

describe('automatic review projection', () => {
  it('keeps multiple reviews of the same tool separate from its execution state', () => {
    const projection = new Projection();
    projection.thread(thread());
    projection.item('thread-1', 'turn-1', {
      id: 'command-1',
      type: 'commandExecution',
      status: 'inProgress',
    });
    projection.autoReview(
      'thread-1',
      'turn-1',
      review({ status: 'denied', completedAtMs: 200, rationale: 'Not authorized' }),
    );
    projection.autoReview(
      'thread-1',
      'turn-1',
      review({ reviewId: 'review-2', status: 'approved', completedAtMs: 210 }),
    );
    projection.item('thread-1', 'turn-1', {
      id: 'command-1',
      type: 'commandExecution',
      status: 'completed',
    });
    expect(reviews(projection).map((item) => item.autoReview?.status)).toEqual([
      'denied',
      'approved',
    ]);
    expect(projection.get('thread-1')!.turns[0]!.items[0]!.status).toBe('completed');
    expect(projection.get('thread-1')!.status).toBe('running');
    expect(projection.get('thread-1')!.actions).toEqual([]);
    projection.thread(thread());
    expect(reviews(projection)).toHaveLength(2);
  });

  it('accepts completed-only events and ignores duplicates, late starts and older completions', () => {
    const projection = new Projection();
    projection.thread(thread());
    const denied = review({
      status: 'denied',
      completedAtMs: 300,
      rationale: '用户没有授权上传文件',
    });
    expect(projection.autoReview('thread-1', 'turn-1', denied)).toBe(true);
    expect(projection.autoReview('thread-1', 'turn-1', denied)).toBe(false);
    expect(projection.autoReview('thread-1', 'turn-1', review())).toBe(false);
    expect(
      projection.autoReview(
        'thread-1',
        'turn-1',
        review({ status: 'approved', completedAtMs: 200 }),
      ),
    ).toBe(false);
    expect(reviews(projection)).toHaveLength(1);
    expect(reviews(projection)[0]!.autoReview).toEqual(denied);
  });

  it('buffers early events by thread, turn and review identity without leaking to another thread', () => {
    const projection = new Projection();
    const completed = review({
      status: 'denied',
      completedAtMs: 300,
      rationale: 'Private request',
    });
    projection.autoReview('thread-1', 'turn-1', completed);
    projection.autoReview('thread-1', 'turn-1', review());
    projection.autoReview('thread-1', 'turn-2', review({ reviewId: 'review-2' }));
    projection.thread(thread('thread-2'));
    expect(reviews(projection, 'thread-2')).toEqual([]);
    projection.thread(thread());
    expect(reviews(projection).map((item) => item.autoReview)).toEqual([completed]);
    projection.turn('thread-1', {
      id: 'turn-2',
      threadId: 'thread-1',
      status: 'running',
      items: [],
    });
    expect(reviews(projection)).toHaveLength(2);
  });

  it('bounds early review count and total bytes', () => {
    const projection = new Projection();
    for (let index = 0; index < 130; index++)
      projection.autoReview('thread-1', 'turn-1', review({ reviewId: `review-${index}` }));
    projection.thread(thread());
    expect(reviews(projection)).toHaveLength(128);
    expect(reviews(projection)[0]!.autoReview?.reviewId).toBe('review-2');
    const byteBounded = new Projection();
    const long = 'x'.repeat(1.5 * 1024 * 1024);
    byteBounded.autoReview(
      'thread-1',
      'turn-1',
      review({ reviewId: 'old', actionSummary: long, rationale: long }),
    );
    byteBounded.autoReview(
      'thread-1',
      'turn-1',
      review({ reviewId: 'new', actionSummary: long, rationale: long }),
    );
    byteBounded.thread(thread());
    expect(reviews(byteBounded).map((item) => item.autoReview?.reviewId)).toEqual(['new']);
  });

  it('marks unfinished reviews unknown when a turn ends and accepts an eventual real decision', () => {
    const projection = new Projection();
    projection.thread(thread());
    projection.autoReview('thread-1', 'turn-1', review());
    projection.turn('thread-1', {
      id: 'turn-1',
      threadId: 'thread-1',
      status: 'interrupted',
      items: [],
    });
    expect(reviews(projection)[0]!.autoReview?.status).toBe('unknown');
    projection.autoReview('thread-1', 'turn-1', review());
    expect(reviews(projection)[0]!.autoReview?.status).toBe('unknown');
    projection.autoReview(
      'thread-1',
      'turn-1',
      review({ status: 'denied', completedAtMs: 300, rationale: 'Explicit reason' }),
    );
    expect(reviews(projection)[0]!.autoReview?.status).toBe('denied');
    expect(projection.get('thread-1')!.status).toBe('interrupted');
  });

  it('preserves terminal decisions but marks visible and buffered unfinished reviews unknown on reset', () => {
    const projection = new Projection();
    projection.thread(thread());
    projection.autoReview('thread-1', 'turn-1', review());
    projection.autoReview(
      'thread-1',
      'turn-1',
      review({ reviewId: 'finished', status: 'approved', completedAtMs: 300 }),
    );
    projection.autoReview('thread-2', 'turn-1', review());
    projection.runtimeReset();
    expect(reviews(projection).map((item) => item.autoReview?.status)).toEqual([
      'unknown',
      'approved',
    ]);
    projection.thread(thread('thread-2'));
    expect(reviews(projection, 'thread-2')[0]!.autoReview?.status).toBe('unknown');
  });

  it('bounds display strings while retaining identity/status and labels the truncation', () => {
    const projection = new Projection(32);
    projection.thread(thread());
    const original = review({
      status: 'denied',
      rationale: '拒绝原因'.repeat(50),
      completedAtMs: 300,
    });
    projection.autoReview('thread-1', 'turn-1', original);
    const item = reviews(projection)[0]!;
    expect(item.autoReview?.reviewId).toBe(original.reviewId);
    expect(item.autoReview?.status).toBe('denied');
    expect(item.autoReview?.rationale).toContain('[输出已截断]');
    expect(item.truncated).toBe(true);
    expect(original.rationale).not.toContain('截断');
  });

  it('compacts review text for WebSocket transport without changing the retained HTTP projection', () => {
    const projection = new Projection();
    projection.thread(thread());
    projection.autoReview(
      'thread-1',
      'turn-1',
      review({
        status: 'denied',
        completedAtMs: 300,
        rationale: '原因'.repeat(1000),
        actionSummary: 'command '.repeat(1000),
      }),
    );
    const result = compactThreadForTransport(projection.get('thread-1')!, 5000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(5000);
    expect(result.turns[0]!.items[0]!.autoReview?.rationale).toContain('内容已截断');
    expect(result.turns[0]!.items[0]!.autoReview?.status).toBe('denied');
    expect(reviews(projection)[0]!.autoReview?.rationale).toBe('原因'.repeat(1000));
  });
});
