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
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';

type ImageSource = { path: string; url?: never } | { url: string; path?: never };
type ImageTarget = ImageSource & {
  label: string;
};
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
      {target && (target.url || threadId) && (
        <ImagePreviewDialog
          key={target.url || target.path}
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
function useImage(threadId: string | undefined, { path, url: remoteUrl }: ImageSource) {
  const [state, setState] = useState<ImageState>(() => ({ src: remoteUrl }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (remoteUrl) {
      setState({ src: remoteUrl });
      return;
    }
    if (!threadId || !path) return;
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
  }, [threadId, path, remoteUrl, attempt]);
  return {
    ...state,
    retry: () => {
      setState({});
      setAttempt((value) => value + 1);
    },
    fail: () =>
      setState({
        error: remoteUrl
          ? '图片加载失败，可能已失效、访问受限或网络不可用。'
          : '图片无法解码，文件可能已损坏或格式不受浏览器支持。',
      }),
  };
}

function ImageError({
  error,
  path,
  retry,
  url,
}: {
  error: string;
  path: string;
  retry?: () => void;
  url?: string;
}) {
  return (
    <span className="local-image-error" role="alert">
      <span>{error}</span>
      <code>{path}</code>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer">
          打开原图
        </a>
      )}
      {retry && (
        <button type="button" className="image-retry" onClick={retry}>
          重试加载图片
        </button>
      )}
    </span>
  );
}

function ReplyImage({
  source,
  alt,
  title,
  interactive = true,
}: {
  source: ImageSource;
  alt?: string;
  title?: string;
  interactive?: boolean;
}) {
  const { threadId, open } = useImagePreview();
  const image = useImage(threadId, source);
  const { path, url } = source;
  const label = alt || (path ? path.split('/').at(-1) : undefined) || '图片';
  const thumbnail = (
    <>
      <img
        className="local-image-thumbnail"
        src={image.src}
        alt={alt || label}
        referrerPolicy={url ? 'no-referrer' : undefined}
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
        <ImageError
          error={image.error}
          path={url ?? path}
          retry={interactive ? image.retry : undefined}
          url={interactive ? url : undefined}
        />
      ) : image.src ? (
        interactive ? (
          <ControlHint asChild content={title || '点击放大图片'}>
            <button
              type="button"
              className="local-image-open"
              aria-label={`预览图片：${label}`}
              onClick={() => open({ ...source, label })}
            >
              {thumbnail}
            </button>
          </ControlHint>
        ) : (
          <ControlHint asChild content={title}>
            <span className="local-image-open">{thumbnail}</span>
          </ControlHint>
        )
      ) : (
        <span className="local-image-loading" role="status">
          正在加载图片…<code>{url || path}</code>
        </span>
      )}
    </span>
  );
}

type ImageProps = { alt?: string; title?: string; interactive?: boolean };
export function LocalImage({ path, ...props }: ImageProps & { path: string }) {
  return <ReplyImage source={{ path }} {...props} />;
}
export function RemoteImage({ src, ...props }: ImageProps & { src: string }) {
  if (!src)
    return (
      <span className="local-image-error" role="alert">
        图片地址不可用。
      </span>
    );
  return <ReplyImage source={{ url: src }} {...props} />;
}

function ImagePreviewDialog({
  threadId,
  target,
  onClose,
}: {
  threadId?: string;
  target: ImageTarget;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useImage(threadId, target);
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
          <ImageError
            error={image.error}
            path={target.url ?? target.path}
            retry={image.retry}
            url={target.url}
          />
        ) : image.src ? (
          <div className="image-preview-canvas">
            <img
              src={image.src}
              referrerPolicy={target.url ? 'no-referrer' : undefined}
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
        <span>{target.url ? '原图链接' : '原始路径'}</span>
        {target.url ? (
          <a href={target.url} target="_blank" rel="noopener noreferrer">
            打开原图
          </a>
        ) : (
          <code>{target.path}</code>
        )}
      </p>
    </dialog>
  );
}
