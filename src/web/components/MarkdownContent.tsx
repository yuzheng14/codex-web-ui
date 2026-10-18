import { createContext, useContext } from 'react';
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localMarkdownPath, relativeToFile } from '../lib/local-files';
import { useMarkdownPreview } from './MarkdownFilePreview';
import { localImagePath, localImageUrl } from '../lib/local-images';
import { LocalImage, RemoteImage, useImagePreview } from './ImagePreview';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';

// Preserve the default protocol allowlist for ordinary links and remote images.
const transformUrl: UrlTransform = (url, key) =>
  localImagePath(url, key === 'src') || (key === 'href' && localMarkdownPath(url))
    ? url
    : defaultUrlTransform(url);

const BaseFileContext = createContext<string | undefined>(undefined);
const ImageLinkContext = createContext(false);

// Stable renderer identities preserve table focus and image state while streaming.
const markdownComponents: Components = {
  pre: MarkdownCodeBlock,
  a: function FileLink({ children, href, title }) {
    const { threadId, open } = useImagePreview();
    const baseFile = useContext(BaseFileContext);
    const markdown = useMarkdownPreview();
    const markdownPath = href ? localMarkdownPath(href) : undefined;
    if (markdownPath && markdown.threadId) {
      const path = relativeToFile(markdownPath, baseFile);
      return (
        <ImageLinkContext value={true}>
          <a
            href={`/api/threads/${encodeURIComponent(markdown.threadId)}/markdown?${new URLSearchParams({ path })}`}
            className="local-markdown-link"
            title={title || `预览 Markdown：${path}`}
            onClick={(event) => {
              event.preventDefault();
              markdown.open(path);
            }}
          >
            {children}
          </a>
        </ImageLinkContext>
      );
    }
    const imagePath = href ? localImagePath(href) : undefined;
    const path = imagePath ? relativeToFile(imagePath, baseFile) : undefined;
    if (path && threadId) {
      return (
        <ImageLinkContext value={true}>
          <a
            href={localImageUrl(threadId, path)}
            title={title || `预览图片：${path}`}
            className="local-image-link"
            onClick={(event) => {
              event.preventDefault();
              open({
                path,
                label: typeof children === 'string' ? children : path.split('/').at(-1) || '图片',
              });
            }}
          >
            {children}
          </a>
        </ImageLinkContext>
      );
    }
    return (
      <ImageLinkContext value={true}>
        <a href={href} title={title} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      </ImageLinkContext>
    );
  },
  img: function MarkdownImage({ src, alt, title }) {
    const linked = useContext(ImageLinkContext);
    const baseFile = useContext(BaseFileContext);
    const imagePath = typeof src === 'string' ? localImagePath(src, true) : undefined;
    const path = imagePath ? relativeToFile(imagePath, baseFile) : undefined;
    return path ? (
      <LocalImage key={path} path={path} alt={alt} title={title} interactive={!linked} />
    ) : (
      <RemoteImage
        key={String(src)}
        src={typeof src === 'string' ? src : ''}
        alt={alt}
        title={title}
        interactive={!linked}
      />
    );
  },
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function MarkdownContent({ text, baseFile }: { text: string; baseFile?: string }) {
  return (
    <BaseFileContext value={baseFile}>
      <div className="markdown">
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={transformUrl}
        >
          {text}
        </Markdown>
      </div>
    </BaseFileContext>
  );
}
