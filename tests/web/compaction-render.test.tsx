import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { RunStatus, ThreadView } from '../../src/shared/types';
import { Conversation } from '../../src/web/components/Conversation';

function renderCompaction(status: RunStatus, itemStatus = 'inProgress') {
  const thread: ThreadView = {
    id: 'thread',
    projectId: 'project',
    cwd: '/project',
    source: 'web',
    title: 'Compaction',
    status,
    managed: true,
    actions: [],
    turns: [
      {
        id: 'turn',
        threadId: 'thread',
        status,
        items: [{ id: 'compact', type: 'contextCompaction', status: itemStatus }],
      },
    ],
  };
  return renderToStaticMarkup(<Conversation thread={thread} offline={false} />);
}

it.each([
  ['completed', '已完成'],
  ['failed', '失败'],
  ['interrupted', '已中止'],
  ['unknown', '结果未确认'],
] as const)('uses the %s turn state when compaction has no terminal item event', (status, label) => {
  const html = renderCompaction(status);
  expect(html).toContain('activity-group-status');
  expect(html).toContain(label);
  expect(html).not.toContain('activity-group-running');
  expect(html).not.toContain('正在压缩上下文');
  expect(html).not.toContain('activity-status">执行中');
});

it('keeps a completed automatic compaction finished while its parent turn continues', () => {
  const html = renderCompaction('running', 'completed');
  expect(html).toContain('上下文压缩已结束');
  expect(html).not.toContain('activity-group-running');
  expect(html).toContain('activity-status">已完成');
});
