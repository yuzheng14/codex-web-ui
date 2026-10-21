import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { Project } from '../../shared/types';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';

interface Props {
  projects: Project[];
  disabled: boolean;
  onReorder: (projectIds: string[]) => Promise<void>;
  onClose: () => void;
}

export function ProjectOrderList({ projects, disabled, onReorder, onClose }: Props) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; before: boolean }>();
  const blocked = disabled || saving;

  async function reorder(ids: string[]) {
    if (disabled || savingRef.current || ids.every((id, index) => id === projects[index]?.id))
      return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await onReorder(ids);
      setSaved(true);
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function move(index: number, offset: number) {
    const ids = projects.map((project) => project.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + offset, 0, id!);
    void reorder(ids);
  }

  function clearDrag() {
    setDragging(undefined);
    setDrop(undefined);
  }

  return (
    <section className="project-order" aria-label={t('sidebar:project_order')} aria-busy={saving}>
      <div className="project-order-header">
        <h2>{t('sidebar:project_order')}</h2>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
          {t('sidebar:order_done')}
        </Button>
      </div>
      <p className="project-order-help">{t('sidebar:order_help')}</p>
      <ol className="project-order-list" aria-label={t('sidebar:project_display_order')}>
        {projects.map((project, index) => (
          <li
            key={project.id}
            className="project-order-row"
            data-project-id={project.id}
            data-dragging={dragging === project.id || undefined}
            data-drop={drop?.id === project.id ? (drop.before ? 'before' : 'after') : undefined}
            draggable={!blocked}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', project.id);
              setDragging(project.id);
            }}
            onDragEnd={clearDrag}
            onDragOver={(event) => {
              if (!dragging || dragging === project.id || blocked) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              setDrop({ id: project.id, before: event.clientY < bounds.y + bounds.height / 2 });
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDrop(undefined);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!blocked && dragging && dragging !== project.id) {
                const ids = projects.map((entry) => entry.id).filter((id) => id !== dragging);
                const bounds = event.currentTarget.getBoundingClientRect();
                const before = event.clientY < bounds.y + bounds.height / 2;
                const target = ids.indexOf(project.id);
                if (target >= 0 && projects.some((entry) => entry.id === dragging)) {
                  ids.splice(target + (before ? 0 : 1), 0, dragging);
                  void reorder(ids);
                }
              }
              clearDrag();
            }}
          >
            <GripVertical className="project-order-grip" size={16} aria-hidden="true" />
            <span className="project-order-name" title={project.name}>
              {project.name}
            </span>
            <span className="sr-only">
              {t('sidebar:order_position', { v0: index + 1, v1: projects.length })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sidebar:order_move_up', { v0: project.name })}
              disabled={blocked || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sidebar:order_move_down', { v0: project.name })}
              disabled={blocked || index === projects.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      <p className="project-order-status" role="status">
        {t(
          saving
            ? 'sidebar:order_saving'
            : saved
              ? 'sidebar:order_saved'
              : 'sidebar:order_auto_save',
        )}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {t('sidebar:order_save_failed', { v0: displayMessage(error) })}
        </p>
      )}
    </section>
  );
}
