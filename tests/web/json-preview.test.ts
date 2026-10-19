import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { formatJson } from '../../src/web/lib/json-preview';
import { localPreviewPath } from '../../src/web/lib/local-files';
import { JsonContent } from '../../src/web/components/JsonContent';
import { MarkdownContent } from '../../src/web/components/MarkdownContent';
import { FilePreviewProvider } from '../../src/web/components/FilePreview';

const text = (input: string) =>
  formatJson(input)
    .tokens?.map((token) => token.text)
    .join('');

it('indents nested objects and arrays while preserving numbers, duplicate keys and escapes', () => {
  const input =
    '\uFEFF{"名称":"中文","值":[true,false,null,{},[],{"n":9007199254740993,"n":1e400}],"转义":"\\u4e2d\\n\\""}\r\n';
  expect(text(input)).toBe(`{
  "名称": "中文",
  "值": [
    true,
    false,
    null,
    {},
    [],
    {
      "n": 9007199254740993,
      "n": 1e400
    }
  ],
  "转义": "\\u4e2d\\n\\""
}`);
});

it.each(['[]', '{}', 'null', 'false', '0', '-0', '1e+20', '"中文"'])(
  'supports JSON root values: %s',
  (input) => {
    expect(text(input)).toBe(input);
  },
);

it.each(['', '{"name":"中文",}', '[1,]', '{', '// comment\n{}', '{"a":NaN}', '\0'])(
  'keeps invalid input available: %s',
  (input) => {
    expect(formatJson(input).error).toContain('JSON 格式无效');
    const html = renderToStaticMarkup(createElement(JsonContent, { content: input }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-label="JSON 原文"');
  },
);

it('bounds depth, indentation expansion and highlight nodes', () => {
  for (const input of [
    '['.repeat(101) + '0' + ']'.repeat(101),
    JSON.stringify(Array.from({ length: 20_000 }, () => 0)),
    '['.repeat(90) +
      JSON.stringify(Array.from({ length: 14_000 }, () => 'a'.repeat(130))) +
      ']'.repeat(90),
  ])
    expect(formatJson(input).error).toContain('已保留原文');
});

it('highlights each value type and escapes HTML in string values', () => {
  const html = renderToStaticMarkup(
    createElement(JsonContent, { content: '{"字段":["<script>alert(1)</script>",2,true,null]}' }),
  );
  for (const kind of ['key', 'string', 'number', 'boolean', 'null'])
    expect(html).toContain(`class="json-${kind}"`);
  expect(html).not.toContain('<script>');
});

it('recognizes local JSON references and routes them relative to the open Markdown file', () => {
  expect(localPreviewPath('file:///work/项目%20配置.JSON#L2')).toBe('/work/项目 配置.JSON');
  expect(localPreviewPath('docs/config.json:12:3')).toBe('docs/config.json');
  for (const input of [
    'https://example.com/a.json',
    'file://remote/a.json',
    'docs/%00.json',
    'docs/%5c.json',
    '//host/a.json',
    'a.jsonc',
    'a.jsonl',
  ])
    expect(localPreviewPath(input)).toBeUndefined();
  const html = renderToStaticMarkup(
    createElement(FilePreviewProvider, {
      threadId: 'thread',
      children: createElement(MarkdownContent, {
        text: '[配置](<项目 配置.JSON>) [远程](https://example.com/a.json)',
        baseFile: '/work/docs/readme.md',
      }),
    }),
  );
  expect(html).toContain('/api/threads/thread/json?path=%2Fwork%2Fdocs%2F');
  expect(html).toContain('href="https://example.com/a.json"');
});
