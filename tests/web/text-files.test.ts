import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PLAIN_TEXT_EXTENSIONS } from '../../src/shared/file-preview';
import { localPreviewPath, localPreviewUrl } from '../../src/web/lib/local-files';
import { MarkdownContent } from '../../src/web/components/MarkdownContent';
import { FilePreviewProvider } from '../../src/web/components/FilePreviewProvider';

it.each(PLAIN_TEXT_EXTENSIONS)('routes local .%s links to the text reader', (extension) => {
  expect(localPreviewPath(`docs/说明%20文件.${extension.toUpperCase()}:12:3`)).toBe(
    `docs/说明 文件.${extension.toUpperCase()}`,
  );
  expect(localPreviewUrl('thread', `docs/sample.${extension}`)).toBe(
    `/api/threads/thread/text?path=docs%2Fsample.${extension}`,
  );
});

it.each([
  'https://example.com/a.txt',
  '//host/a.txt',
  'file://remote/a.txt',
  'javascript:alert(1).txt',
  '%68ttps%3A%2F%2Fexample.com/a.txt',
  'docs/%00.txt',
  'docs/%5C.txt',
  'docs/%ZZ.txt',
  'docs/a.txt.exe',
  'docs/a.html',
  'docs/a.pdf',
])('leaves unsafe and unsupported destinations outside the text reader: %s', (input) => {
  expect(localPreviewPath(input)).toBeUndefined();
});

it('supports local file URLs, relative links from Markdown and preserves external links', () => {
  const html = renderToStaticMarkup(
    createElement(FilePreviewProvider, {
      threadId: 'thread',
      children: createElement(MarkdownContent, {
        text: '[本地](file:///work/notes.TXT) [数据](data.tsv) [外部](https://example.com/a.txt)',
        baseFile: '/work/docs/readme.md',
      }),
    }),
  );
  expect(html).toContain('/api/threads/thread/text?path=%2Fwork%2Fnotes.TXT');
  expect(html).toContain('/api/threads/thread/text?path=%2Fwork%2Fdocs%2Fdata.tsv');
  expect(html).toContain('href="https://example.com/a.txt"');
  expect(html).not.toContain('href="file:');
});
