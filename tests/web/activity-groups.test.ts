import { describe, expect, it } from 'vitest';
import type { AutoReviewView, ItemView } from '../../src/shared/types';
import { groupConversationItems, summarizeActivities } from '../../src/web/lib/activity-groups';

const item = (id: string, type = 'commandExecution', status = 'completed'): ItemView => ({
  id,
  type,
  status,
});
const review = (id: string, status: AutoReviewView['status']): ItemView => ({
  ...item(id, 'autoApprovalReview'),
  autoReview: {
    reviewId: id,
    status,
    actionLabel: '执行命令',
    actionSummary: 'pwd',
    startedAtMs: 1,
  },
});

describe('conversation activity grouping', () => {
  it('preserves the original order and splits at every user or assistant message', () => {
    const input = [
      item('u', 'userMessage'),
      item('tool'),
      review('review', 'approved'),
      item('thinking', 'reasoning'),
      item('a', 'agentMessage'),
      item('plan', 'plan'),
      item('search', 'webSearch'),
      item('u2', 'userMessage'),
    ];
    const groups = groupConversationItems(input);
    expect(groups.map((group) => group.kind)).toEqual([
      'message',
      'activity',
      'message',
      'activity',
      'message',
    ]);
    expect(
      groups.flatMap((group) => (group.kind === 'message' ? [group.item] : group.items)),
    ).toEqual(input);
    expect(groups[1]).toEqual({
      kind: 'activity',
      key: 'activity:tool',
      items: input.slice(1, 4),
    });
    expect(groups[3]).toEqual({
      kind: 'activity',
      key: 'activity:plan',
      items: input.slice(5, 7),
    });
  });

  it('keeps single-item and growing groups keyed by the first activity through stream updates', () => {
    const first = item('first', 'commandExecution', 'inProgress');
    const initial = groupConversationItems([first]);
    const appended = groupConversationItems([
      { ...first, status: 'completed' },
      review('new-review', 'inProgress'),
    ]);
    expect(initial[0]?.kind).toBe('activity');
    expect(appended[0]?.key).toBe(initial[0]?.key);
    expect(initial).toEqual([{ kind: 'activity', key: 'activity:first', items: [first] }]);
  });

  it('keeps code review conclusions visible between activity groups', () => {
    const input = [
      item('started', 'enteredReviewMode'),
      item('inspection'),
      { ...item('result', 'exitedReviewMode'), text: 'Review complete' },
      item('followup'),
    ];
    expect(groupConversationItems(input)).toEqual([
      { kind: 'activity', key: 'activity:started', items: input.slice(0, 2) },
      { kind: 'message', key: 'message:result', item: input[2] },
      { kind: 'activity', key: 'activity:followup', items: input.slice(3) },
    ]);
  });

  it('keeps compaction records outside tool groups and preserves their boundaries', () => {
    const input = [
      item('before'),
      item('compact', 'contextCompaction', 'completed'),
      item('after'),
    ];
    expect(groupConversationItems(input)).toEqual([
      { kind: 'activity', key: 'activity:before', items: [input[0]] },
      { kind: 'message', key: 'message:compact', item: input[1] },
      { kind: 'activity', key: 'activity:after', items: [input[2]] },
    ]);
  });

  it('does not share groups between turns or mutate its input', () => {
    const first = Object.freeze(item('one'));
    const input = Object.freeze([first]);
    expect(groupConversationItems(input)).toEqual([
      { kind: 'activity', key: 'activity:one', items: [first] },
    ]);
    expect(groupConversationItems([item('two')])).toEqual([
      { kind: 'activity', key: 'activity:two', items: [item('two')] },
    ]);
    expect(groupConversationItems([])).toEqual([]);
  });
});

describe('collapsed activity status', () => {
  it('exposes failures, denials, pending work and uncertain audit outcomes alongside successes', () => {
    const summary = summarizeActivities([
      item('ok'),
      item('running', 'mcpToolCall', 'inProgress'),
      item('failed', 'commandExecution', 'failed'),
      item('declined', 'commandExecution', 'declined'),
      review('approved', 'approved'),
      review('denied', 'denied'),
      review('reviewing', 'inProgress'),
      review('timeout', 'timedOut'),
      review('aborted', 'aborted'),
      review('unknown', 'unknown'),
    ]);
    expect(summary).toEqual({
      total: 10,
      reviews: 6,
      running: 2,
      completed: 2,
      failed: 1,
      denied: 2,
      timedOut: 1,
      interrupted: 1,
      unknown: 1,
    });
  });

  it('counts an explicit error as failure and an incomplete review as uncertain', () => {
    const summary = summarizeActivities([
      { ...item('error'), error: 'Tool connection failed' },
      item('missing-review', 'autoApprovalReview'),
      { id: 'reasoning', type: 'reasoning', text: 'Thinking' },
      item('interrupted', 'commandExecution', 'interrupted'),
    ]);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.unknown).toBe(1);
    expect(summary.interrupted).toBe(1);
    expect(summary.total).toBe(4);
  });

  it('surfaces unsuccessful tool results preserved in opaque mapped details', () => {
    const summary = summarizeActivities([
      { ...item('mcp', 'mcpToolCall'), details: { error: { message: 'Tool connection failed' } } },
      { ...item('dynamic', 'dynamicToolCall'), details: { success: false } },
      { ...item('image', 'imageGeneration'), details: { failure: { type: 'usageLimitExceeded' } } },
      { ...item('ok', 'mcpToolCall'), details: { error: null } },
      { ...item('irrelevant'), details: { success: false } },
    ]);
    expect(summary.failed).toBe(3);
    expect(summary.completed).toBe(2);
  });

  it('does not silently hide unknown upstream statuses or mistake statusless reasoning for failure', () => {
    const summary = summarizeActivities([
      item('future', 'imageGeneration', 'new-upstream-state'),
      { id: 'reasoning', type: 'reasoning' },
      { id: 'plan', type: 'plan' },
    ]);
    expect(summary.unknown).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(0);
  });
});
