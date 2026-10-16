import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchLocalImage, localImagePath, localImageUrl } from '../../src/web/lib/local-images';
import { MarkdownContent } from '../../src/web/components/MarkdownContent';
import { ImagePreviewProvider } from '../../src/web/components/ImagePreview';

afterEach(() => vi.unstubAllGlobals());

describe('local image destinations', () => {
  it.each([
    ['/work/设计 稿.PNG', '/work/设计 稿.PNG'],
    ['./assets/发布%20图表.png', './assets/发布 图表.png'],
    ['assets/%E4%B8%AD%E6%96%87.webp', 'assets/中文.webp'],
    ['../preview/photo.JPEG?download=1#detail', '../preview/photo.JPEG'],
    ['file:///work/发布%20图表.png', '/work/发布 图表.png'],
    ['file://localhost/work/image.gif', '/work/image.gif'],
    ['assets/50%25%20done.png', 'assets/50% done.png'],
    ['assets/name%2520literal.png', 'assets/name%20literal.png'],
    ['assets/chart%3Fv%23x.png', 'assets/chart?v#x.png'],
    ['assets/diagram.svg', 'assets/diagram.svg'],
  ])('decodes one filesystem path from %s', (input, expected) => {
    expect(localImagePath(input)).toBe(expected);
  });

  it.each([
    'https://example.com/image.png',
    'http://localhost/image.png',
    '//example.com/image.png',
    '%2F%2Fexample.com/image.png',
    '%68ttps%3A%2F%2Fexample.com/image.png',
    'file://remote-host/share/image.png',
    'file:////remote-host/image.png',
    'file://user@localhost/image.png',
    'file:/work/image.png',
    'javascript:alert(1).png',
    'data:image/png;base64,AA==',
    'blob:https://example.com/image.png',
    'C:\\work\\image.png',
    '\\server\\image.png',
    'assets/%5Cimage.png',
    'assets/%00image.png',
    'assets/image\n.png',
    'assets/%0Aimage.png',
    'assets/invalid%ZZ.png',
    '#image.png',
    '?next=image.png',
    '',
  ])('does not reclassify URL or malformed path %s as a local image', (input) => {
    expect(localImagePath(input)).toBeUndefined();
    expect(localImagePath(input, true)).toBeUndefined();
  });

  it('leaves ordinary file links alone but lets explicit image syntax report unsupported files', () => {
    expect(localImagePath('docs/README.md')).toBeUndefined();
    expect(localImagePath('assets/output')).toBeUndefined();
    expect(localImagePath('assets/output', true)).toBe('assets/output');
    expect(localImagePath('assets/document.pdf', true)).toBe('assets/document.pdf');
  });

  it('encodes thread and filesystem path independently without losing filename punctuation', () => {
    const endpoint = localImageUrl('thread/a?b', './assets/中文 #1?%.png');
    const url = new URL(endpoint, 'https://gateway.example');
    expect(url.pathname).toBe('/api/threads/thread%2Fa%3Fb/images');
    expect(url.searchParams.get('path')).toBe('./assets/中文 #1?%.png');
    expect([...url.searchParams.keys()]).toEqual(['path']);
  });
});

describe('Markdown image routing', () => {
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(ImagePreviewProvider, {
        threadId: 'thread',
        children: createElement(MarkdownContent, { text }),
      }),
    );

  it('keeps local file URLs through sanitization and routes them through the authenticated endpoint', () => {
    const html = render('[查看截图](file:///work/发布%20图表.png)');
    expect(html).toContain(`href="${localImageUrl('thread', '/work/发布 图表.png')}"`);
    expect(html).toContain('>查看截图</a>');
    expect(html).not.toContain('href="file:');
  });

  it('starts explicit local Markdown images in an accessible loading state with a readable path', () => {
    const html = render('![项目图](<./assets/发布 图表.png>)');
    expect(html).toContain('role="status"');
    expect(html).toContain('./assets/发布 图表.png');
    expect(html).not.toContain('src="./assets/');
  });

  it('retains normal links, remote images and the default unsafe-protocol filter', () => {
    const html = render(
      '[文档](docs/README.md) [外部](https://example.com/image.png) ' +
        '![远程](https://example.com/image.png) [禁止](javascript:alert%281%29) ' +
        '[网络](//example.com/image.png)',
    );
    expect(html).toContain('href="docs/README.md"');
    expect(html).toContain('href="https://example.com/image.png"');
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain('href="//example.com/image.png"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('/api/threads/');
  });
});

describe('local image HTTP responses', () => {
  it('uses same-origin credentials and propagates abort while accepting supported image bytes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const blob = await fetchLocalImage('thread', '/work/image.png', controller.signal);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    expect(fetch).toHaveBeenCalledWith(
      localImageUrl('thread', '/work/image.png'),
      expect.objectContaining({ credentials: 'same-origin', signal: controller.signal }),
    );
  });

  it.each([
    [404, 'IMAGE_NOT_FOUND', '图片文件不存在或已被删除'],
    [403, 'IMAGE_UNREADABLE', '图片文件不可读取'],
    [415, 'UNSUPPORTED_IMAGE_TYPE', '仅支持 PNG、JPEG、WebP 和 GIF 图片'],
  ])('preserves actionable API errors (%s)', async (status, code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code, message } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(
      fetchLocalImage('thread', 'image.png', new AbortController().signal),
    ).rejects.toMatchObject({ status, message, problem: { code } });
  });

  it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])(
    'rejects a successful %s response before creating an image',
    async (type) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('not a supported image', {
            headers: { 'Content-Type': type },
          }),
        ),
      );
      await expect(
        fetchLocalImage('thread', 'image.png', new AbortController().signal),
      ).rejects.toThrow();
    },
  );
});
