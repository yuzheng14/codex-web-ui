/** Navigation keys are distinct from persisted project identities. */
export const UNASSIGNED_SCOPE = '@unassigned';
export const scopeKey = (projectId: string | null): string => projectId ?? UNASSIGNED_SCOPE;
export const scopeApi = (scope: string): string =>
  scope === UNASSIGNED_SCOPE ? '/api/unassigned' : `/api/projects/${encodeURIComponent(scope)}`;
