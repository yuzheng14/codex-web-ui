import { useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import type { BrowserNotifications } from '../hooks/useBrowserNotifications';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function NotificationSettings({
  notifications,
  onClose,
}: {
  notifications: BrowserNotifications;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const { enabled, access, requesting, error } = notifications;
  const active = enabled && access === 'granted';
  const status = {
    default: '尚未授权',
    granted: '已授权',
    denied: '已被浏览器阻止',
    unsupported: '当前浏览器不支持',
    insecure: '需要安全连接',
  }[access];
  const unavailable = !['default', 'granted'].includes(access);
  return (
    <dialog
      ref={dialog}
      className="project-dialog notification-dialog"
      aria-labelledby="notification-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Bell size={20} aria-hidden="true" />
          <h2 id="notification-dialog-title">工作完成通知</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭通知设置" onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p>每轮工作结束时显示项目、会话及结果，点击通知可返回对应会话。</p>
      <div className="notification-control">
        <div>
          <strong>浏览器通知</strong>
          <span role="status">
            {status} · {active ? '已开启' : '未开启'}
          </span>
        </div>
        <Button
          role="switch"
          aria-label="浏览器通知"
          aria-checked={active}
          aria-describedby="notification-permission-help"
          variant={active ? 'secondary' : 'default'}
          size="sm"
          disabled={requesting || unavailable}
          onClick={() => void notifications.toggle()}
        >
          {requesting ? '等待授权…' : active ? '关闭通知' : '启用通知'}
        </Button>
      </div>
      <p id="notification-permission-help" className="notification-help">
        {access === 'denied'
          ? '请在浏览器的站点设置中允许通知，再回到此页面开启。'
          : access === 'insecure'
            ? '请使用 HTTPS 访问。localhost 或 127.0.0.1 可用于本机访问。'
            : access === 'unsupported'
              ? '请使用支持系统通知的桌面浏览器。页内状态与未读提示仍然可用。'
              : '只有点击启用后才会请求授权。此设置在当前浏览器的本站标签页间共享。'}
      </p>
      {enabled && access === 'granted' && (
        <Button variant="secondary" size="sm" onClick={notifications.test}>
          发送测试通知
        </Button>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="notification-background" aria-labelledby="notification-background-title">
        <h3 id="notification-background-title">后台通知与页面休眠</h3>
        <p>
          请保持页面和浏览器运行。普通后台状态可接收通知；页面被冻结或被回收期间，无法保证及时通知。恢复页面后会同步结果与未读提示。
        </p>
        <details>
          <summary>如何让本站保持活跃</summary>
          <ul>
            <li>
              Chrome：设置 → 性能 → 始终保持这些网站活跃，添加本站。
              <a
                href="https://support.google.com/chrome/answer/12929150?hl=zh-Hans"
                target="_blank"
                rel="noreferrer"
              >
                设置说明
              </a>
            </li>
            <li>
              Edge：设置 → 系统和性能 → 性能 →
              始终保持这些网站活跃（或「从不将这些网站置于睡眠状态」），添加本站。
              <a
                href="https://support.microsoft.com/edge/learn-about-performance-features-in-microsoft-edge"
                target="_blank"
                rel="noreferrer"
              >
                设置说明
              </a>
            </li>
          </ul>
          <p>需要在浏览器中手动设置，具体名称可能随版本变化。</p>
        </details>
      </section>
    </dialog>
  );
}
