import { displayMessage } from '../i18n/messages';
import { t, currentLocale } from '../i18n';
import { useMemo } from 'react';
import { formatJson } from '../lib/json-preview';

export function JsonContent({ content }: { content: string }) {
  const locale = currentLocale();
  const preview = useMemo(() => formatJson(content), [content, locale]);
  return preview.error !== undefined ? (
    <>
      <p className="json-preview-warning" role="alert">
        {displayMessage(preview.error)}
      </p>
      <pre className="file-preview-source" tabIndex={0} aria-label={t('workspace:json_source')}>
        {content}
      </pre>
    </>
  ) : (
    <pre
      className="file-preview-source json-preview"
      tabIndex={0}
      aria-label={t('workspace:formatted_json')}
    >
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
