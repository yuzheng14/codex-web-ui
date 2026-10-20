import { t } from '../i18n';
import type { PermissionRequest } from '../../shared/types';

const accessLabels: Record<string, string> = {
  get read() {
    return t('approvals:read');
  },
  get write() {
    return t('approvals:write');
  },
  get deny() {
    return t('approvals:deny_access');
  },
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
          <strong>{t('approvals:network_access')}</strong>
          <span>
            {request.network === true
              ? t('approvals:network_access_allowed')
              : request.network === false
                ? t('approvals:no_additional_network_access')
                : t('approvals:no_network_access_changes_specified')}
          </span>
        </div>
      )}
      {entries.length > 0 && (
        <div>
          <h4>{t('approvals:files_and_directories')}</h4>
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
        <p>{t('approvals:directory_matching_depth', { v0: fileSystem.globScanMaxDepth })}</p>
      )}
      {request.network === undefined && entries.length === 0 && (
        <p>{t('approvals:no_additional_network_or_file_access_requested')}</p>
      )}
    </div>
  );
}
