import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchLocalImage } from '../lib/local-images';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';

interface ImageTarget {
  path: string;
  label: string;
}
const ImageContext = createContext<{
  threadId?: string;
  open: (target: ImageTarget) => void;
}>({ open: () => {} });

export function ImagePreviewProvider({
  threadId,
  children,
}: {
  threadId?: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<ImageTarget>();
  const context = useMemo(() => ({ threadId, open: setTarget }), [threadId]);
  return (
    <ImageContext value={context}>
      {children}
      {target && threadId && (
        <ImagePreviewDialog
          key={target.path}
          threadId={threadId}
          target={target}
          onClose={() => setTarget(undefined)}
        />
      )}
    </ImageContext>
  );
}

export function useImagePreview() {
  return useContext(ImageContext);
}

type ImageState = { src?: string; error?: string };
function useLocalImage(threadId: string | undefined, path: string) {
  const [state, setState] = useState<ImageState>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    let url: string | undefined;
    const timeout = setTimeout(() => {
      controller.abort();
      setState({ error: '图片加载超时，请重试。' });
    }, 35_000);
    setState({});
    void fetchLocalImage(threadId, path, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setState({ src: url });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ error: readableError(error) });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [threadId, path, attempt]);
  return {
    ...state,
    retry: () => setAttempt((value) => value + 1),
    fail: () => setState({ error: '图片无法解码，文件可能已损坏或格式不受浏览器支持。' }),
  };
}

function ImageError({ error, path, retry }: { error: string; path: string; retry?: () => void }) {
  return (
    <span className="local-image-error" role="alert">
      <span>{error}</span>
      <code>{path}</code>
      {retry && (
        <button type="button" className="image-retry" onClick={retry}>
          重试加载图片
        </button>
      )}
    </span>
  );
}

export function LocalImage({
  path,
  alt,
  title,
  interactive = true,
}: {
  path: string;
  alt?: string;
  title?: string;
  interactive?: boolean;
}) {
  const { threadId, open } = useImagePreview();
  const image = useLocalImage(threadId, path);
  const label = alt || path.split('/').at(-1) || '图片';
  const thumbnail = (
    <>
      <img
        className="local-image-thumbnail"
        src={image.src}
        alt={alt || label}
        onError={image.fail}
      />
      <span className="local-image-caption">
        {label}
        {interactive && <span aria-hidden="true"> ↗</span>}
      </span>
    </>
  );
  return (
    <span className="local-image">
      {image.error ? (
        <ImageError error={image.error} path={path} retry={interactive ? image.retry : undefined} />
      ) : image.src ? (
        interactive ? (
          <button
            type="button"
            className="local-image-open"
            aria-label={`预览图片：${label}`}
            title={title || '点击放大图片'}
            onClick={() => open({ path, label })}
          >
            {thumbnail}
          </button>
        ) : (
          <span className="local-image-open" title={title}>
            {thumbnail}
          </span>
        )
      ) : (
        <span className="local-image-loading" role="status">
          正在加载图片…<code>{path}</code>
        </span>
      )}
    </span>
  );
}

function ImagePreviewDialog({
  threadId,
  target,
  onClose,
}: {
  threadId: string;
  target: ImageTarget;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useLocalImage(threadId, target.path);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setBounds({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit =
    natural.width && bounds.width
      ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height)
      : 0;
  const loaded = Boolean(image.src && !image.error);
  return (
    <dialog
      ref={dialog}
      className="image-preview-dialog"
      aria-label="图片预览"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || !loaded) return;
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          setZoom((value) => Math.min(4, value + 0.25));
        } else if (event.key === '-') {
          event.preventDefault();
          setZoom((value) => Math.max(0.5, value - 0.25));
        } else if (event.key === '0') {
          event.preventDefault();
          setZoom(1);
        }
      }}
    >
      <div className="image-preview-heading">
        <h2>{target.label}</h2>
        <Button autoFocus variant="ghost" size="icon" aria-label="关闭图片预览" onClick={onClose}>
          <Icon name="close" size={19} />
        </Button>
      </div>
      <div className="image-preview-toolbar" aria-label="图片缩放">
        <Button
          variant="secondary"
          size="sm"
          aria-label="缩小图片"
          disabled={!loaded || zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          −
        </Button>
        <output aria-label="图片缩放比例">{Math.round(zoom * 100)}%</output>
        <Button
          variant="secondary"
          size="sm"
          aria-label="放大图片"
          disabled={!loaded || zoom >= 4}
          onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
        >
          ＋
        </Button>
        <Button variant="ghost" size="sm" disabled={!loaded} onClick={() => setZoom(1)}>
          适应窗口
        </Button>
        <span className="image-preview-shortcuts">＋ / − 缩放 · Esc 关闭</span>
      </div>
      <div className="image-preview-viewport" ref={viewport} tabIndex={0} aria-label="图片查看区域">
        {image.error ? (
          <ImageError error={image.error} path={target.path} retry={image.retry} />
        ) : image.src ? (
          <div className="image-preview-canvas">
            <img
              src={image.src}
              alt={target.label}
              style={
                fit
                  ? { width: natural.width * fit * zoom, height: natural.height * fit * zoom }
                  : { maxWidth: '100%' }
              }
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={image.fail}
            />
          </div>
        ) : (
          <span className="local-image-loading" role="status">
            正在加载图片…
          </span>
        )}
      </div>
      <p className="image-preview-path">
        <span>原始路径</span>
        <code>{target.path}</code>
      </p>
    </dialog>
  );
}
