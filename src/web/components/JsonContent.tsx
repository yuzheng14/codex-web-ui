import { useMemo } from 'react';
import { formatJson } from '../lib/json-preview';

export function JsonContent({ content }: { content: string }) {
  const preview = useMemo(() => formatJson(content), [content]);
  return preview.error !== undefined ? (
    <>
      <p className="json-preview-warning" role="alert">
        {preview.error}
      </p>
      <pre className="file-preview-source" tabIndex={0} aria-label="JSON 原文">
        {content}
      </pre>
    </>
  ) : (
    <pre className="file-preview-source json-preview" tabIndex={0} aria-label="格式化 JSON">
      <code>
        {preview.tokens.map((token, index) =>
          token.kind ? (
            <span key={index} className={`json-${token.kind}`}>
              {token.text}
            </span>
          ) : (
            token.text
          ),
        )}
      </code>
    </pre>
  );
}
