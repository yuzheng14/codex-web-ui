import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { FilePreview } from './FilePreview';
import { DiffPreview, type DiffPreviewTarget } from './DiffPreview';

const PreviewContext = createContext<{
  threadId?: string;
  open: (path: string) => void;
  openDiff: (target: DiffPreviewTarget) => void;
}>({ open: () => {}, openDiff: () => {} });
export const useFilePreview = () => useContext(PreviewContext);
export const useDiffPreview = () => useContext(PreviewContext).openDiff;

export function FilePreviewProvider({
  threadId,
  getHistoryCursor,
  children,
}: {
  threadId?: string;
  getHistoryCursor?: (targetId: string) => string | undefined;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<
    { threadId: string } & (
      { kind: 'file'; path: string } | { kind: 'diff'; diff: DiffPreviewTarget }
    )
  >();
  useEffect(() => setTarget(undefined), [threadId]);
  const close = useCallback(() => setTarget(undefined), []);
  const context = useMemo(
    () => ({
      threadId,
      open: (path: string) => {
        if (threadId) setTarget({ threadId, kind: 'file', path });
      },
      openDiff: (diff: DiffPreviewTarget) => {
        if (threadId)
          setTarget({
            threadId,
            kind: 'diff',
            diff: { ...diff, cursor: getHistoryCursor?.(diff.id) },
          });
      },
    }),
    [threadId, getHistoryCursor],
  );
  return (
    <PreviewContext value={context}>
      {children}
      {target &&
        target.threadId === threadId &&
        (target.kind === 'file' ? (
          <FilePreview
            key={`${threadId}:${target.path}`}
            threadId={target.threadId}
            path={target.path}
            onClose={close}
          />
        ) : (
          <DiffPreview
            key={`${threadId}:${target.diff.id}`}
            threadId={target.threadId}
            target={target.diff}
            onClose={close}
          />
        ))}
    </PreviewContext>
  );
}
