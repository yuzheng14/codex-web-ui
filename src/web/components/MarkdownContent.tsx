import { Children, createContext, isValidElement, useContext, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localPreviewPath, localPreviewUrl, relativeToFile } from '../lib/local-files';
import { useFilePreview } from './FilePreviewProvider';
import { localImagePath, localImageUrl } from '../lib/local-images';
import { LocalImage, RemoteImage, useImagePreview } from './ImagePreview';
import { ControlHint } from './ControlHint';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MermaidBlock } from './MermaidBlock';
import { isClosedCodeFence } from '../lib/markdown-fence';

// Preserve the default protocol allowlist for ordinary links and remote images.
const transformUrl: UrlTransform = (url, key) =>
  localImagePath(url, key === 'src') || (key === 'href' && localPreviewPath(url))
    ? url
    : defaultUrlTransform(url);

const BaseFileContext = createContext<string | undefined>(undefined);
const ImageLinkContext = createContext(false);
const SourceContext = createContext({ text: '', streaming: false });

// Stable renderer identities preserve table focus and image state while streaming.
const markdownComponents: Components = {
  pre: function CodeBlock({ children, node }) {
    const { text, streaming } = useContext(SourceContext);
    const code = Children.toArray(children)[0];
    if (
      isValidElement<{ className?: string; children?: ReactNode }>(code) &&
      code.type === 'code' &&
      code.props.className?.toLowerCase() === 'language-mermaid'
    ) {
      const fenced = text.slice(node?.position?.start.offset, node?.position?.end.offset);
      return (
        <MermaidBlock
          source={String(code.props.children ?? '')}
          pending={streaming && !isClosedCodeFence(fenced)}
        />
      );
    }
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
  },
  a: function FileLink({ children, href, title }) {
    const { threadId, open } = useImagePreview();
    const baseFile = useContext(BaseFileContext);
    const preview = useFilePreview();
    const filePath = href ? localPreviewPath(href) : undefined;
    if (filePath && preview.threadId) {
      const path = relativeToFile(filePath, baseFile);
      return (
        <ImageLinkContext value={true}>
          <a
            href={localPreviewUrl(preview.threadId, path)}
            className="local-file-link"
            title={title || `预览文件：${path}`}
            onClick={(event) => {
              event.preventDefault();
              preview.open(path);
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

export function MarkdownContent({
  text,
  baseFile,
  streaming = false,
}: {
  text: string;
  baseFile?: string;
  streaming?: boolean;
}) {
  return (
    <BaseFileContext value={baseFile}>
      <SourceContext value={{ text, streaming }}>
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
      </SourceContext>
    </BaseFileContext>
  );
}
