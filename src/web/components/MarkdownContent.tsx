import { createContext, useContext } from 'react';
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localImagePath, localImageUrl } from '../lib/local-images';
import { LocalImage, RemoteImage, useImagePreview } from './ImagePreview';
import { ControlHint } from './ControlHint';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';

// Preserve the default protocol allowlist for ordinary links and remote images.
const transformUrl: UrlTransform = (url, key) =>
  localImagePath(url, key === 'src') ? url : defaultUrlTransform(url);

const ImageLinkContext = createContext(false);

// Stable renderer identities preserve table focus and image state while streaming.
const markdownComponents: Components = {
  pre: MarkdownCodeBlock,
  a: function ImageLink({ children, href, title }) {
    const { threadId, open } = useImagePreview();
    const path = href ? localImagePath(href) : undefined;
    if (path && threadId) {
      return (
        <ImageLinkContext value={true}>
          <ControlHint asChild content={title || `预览图片：${path}`}>
            <a
              href={localImageUrl(threadId, path)}
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
          </ControlHint>
        </ImageLinkContext>
      );
    }
    return (
      <ImageLinkContext value={true}>
        <ControlHint asChild content={title}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        </ControlHint>
      </ImageLinkContext>
    );
  },
  img: function MarkdownImage({ src, alt, title }) {
    const linked = useContext(ImageLinkContext);
    const path = typeof src === 'string' ? localImagePath(src, true) : undefined;
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

export function MarkdownContent({ text }: { text: string }) {
  return (
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
  );
}
