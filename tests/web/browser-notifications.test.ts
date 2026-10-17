import { afterEach, expect, it, vi } from 'vitest';
import {
  completionNotification,
  notificationAccess,
  notificationsEnabled,
} from '../../src/web/lib/browser-notifications';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['completed', 'Agent 已完成'],
  ['failed', 'Agent 执行失败'],
  ['interrupted', 'Agent 已中断'],
] as const)('labels %s without treating every ending as success', (status, title) => {
  expect(
    completionNotification(
      {
        threadId: 'thread',
        turnId: 'turn',
        projectId: 'project',
        title: '检查变更',
        status,
      },
      '项目名称',
    ),
  ).toEqual({
    title,
    options: { body: '项目名称 · 检查变更', tag: '["thread","turn"]' },
  });
});

it('detects unsupported and insecure contexts without requesting permission', () => {
  vi.stubGlobal('window', { isSecureContext: false });
  expect(notificationAccess()).toBe('insecure');
  vi.stubGlobal('window', { isSecureContext: true });
  expect(notificationAccess()).toBe('unsupported');
  const notifications = { permission: 'denied', requestPermission: vi.fn() };
  vi.stubGlobal('window', { isSecureContext: true, Notification: notifications });
  vi.stubGlobal('Notification', notifications);
  expect(notificationAccess()).toBe('denied');
  expect(notifications.requestPermission).not.toHaveBeenCalled();
});

it('defaults to disabled when preferences cannot be read', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
  });
  expect(notificationsEnabled()).toBe(false);
});
