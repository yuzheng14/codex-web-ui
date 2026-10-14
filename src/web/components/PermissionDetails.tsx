import type { PermissionRequest } from '../../shared/types';

const accessLabels: Record<string, string> = {
  read: '读取',
  write: '写入',
  deny: '禁止访问',
};

export function PermissionDetails({ request }: { request: PermissionRequest }) {
  const fileSystem = request.fileSystem;
  const entries = [
    ...(fileSystem?.read.map((path) => ({ path, access: 'read' })) ?? []),
    ...(fileSystem?.write.map((path) => ({ path, access: 'write' })) ?? []),
    ...(fileSystem?.entries ?? []),
  ];
  return (
    <div className="permission-details">
      {request.network !== undefined && (
        <div className="permission-network">
          <strong>网络访问</strong>
          <span>
            {request.network === true
              ? '允许访问网络'
              : request.network === false
                ? '不开放额外网络访问'
                : '未指定网络访问变更'}
          </span>
        </div>
      )}
      {entries.length > 0 && (
        <div>
          <h4>文件与目录</h4>
          <ul className="permission-paths">
            {entries.map((entry, index) => (
              <li key={`${entry.access}-${entry.path}-${index}`}>
                <span className={`permission-access permission-access-${entry.access}`}>
                  {accessLabels[entry.access] ?? entry.access}
                </span>
                <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fileSystem?.globScanMaxDepth !== undefined && (
        <p>目录匹配搜索深度：{fileSystem.globScanMaxDepth}</p>
      )}
      {request.network === undefined && entries.length === 0 && (
        <p>未请求额外网络或文件访问权限。</p>
      )}
    </div>
  );
}
