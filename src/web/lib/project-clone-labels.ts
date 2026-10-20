import type { ProjectClone } from '../../shared/types';
import { t } from '../i18n';

/** Older servers still show a localized lifecycle state without parsing their prose. */
export function cloneProgress(job: ProjectClone): string {
  const stage =
    job.progressStage ??
    (job.status === 'cloning'
      ? 'connecting'
      : job.status === 'registration-failed'
        ? 'registration_failed'
        : job.status);
  return t(`sidebar:clone_stage_${stage}`);
}
