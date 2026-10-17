import { describe, expect, it } from 'vitest';
import { threadOrigin } from '../../src/web/lib/thread-origin';

describe('thread origin', () => {
  it.each([
    ['codex_web_ui', 'Web', '由 Codex Web UI（本网页）创建。'],
    ['codex-tui', 'CLI', '由 Codex 终端命令行创建。'],
    ['codex_vscode', 'VS Code', '由 VS Code 中的 Codex 扩展创建。'],
    ['Codex Desktop', 'Codex Desktop', '由 Codex 桌面应用创建。'],
  ])(
    'prefers recorded client %s over conflicting session source',
    (originator, label, description) => {
      expect(threadOrigin({ originator, source: 'appServer' })).toEqual({ label, description });
    },
  );

  it('identifies this web client even when Codex reports the vscode source', () => {
    expect(threadOrigin({ originator: 'codex_web_ui', source: 'vscode' }).label).toBe('Web');
  });

  it.each([undefined, null, '', ' \t '])(
    'does not mistake the vscode runtime category for the creating client when originator is %s',
    (originator) => {
      expect(threadOrigin({ originator, source: 'vscode' })).toEqual({
        label: '交互客户端',
        description:
          'Codex 仅记录了交互来源分类，可能来自网页、终端或 IDE，无法确认具体创建客户端。',
      });
    },
  );

  it.each([
    'custom-client',
    'codex_desktop',
    'codex_cli_rs',
    'CODEX_WEB_UI',
    '<script>custom</script>',
  ])('preserves unknown client %s without guessing an identity from source', (originator) => {
    expect(threadOrigin({ originator, source: 'vscode' })).toEqual({
      label: originator,
      description: `创建方记录为「${originator}」。`,
    });
  });

  it.each([
    ['cli', 'CLI'],
    ['appServer', 'MCP'],
    ['mcp', 'MCP'],
    ['exec', '命令行任务'],
  ])('uses the known %s category only when the client is missing', (source, label) => {
    expect(threadOrigin({ source }).label).toBe(label);
  });

  it.each(['unknown', ''])('keeps missing source %s unconfirmed', (source) => {
    expect(threadOrigin({ source })).toEqual({
      label: '来源未确认',
      description: '缺少可识别的创建方信息。',
    });
  });

  it('includes an unrecognized source as neutral metadata', () => {
    expect(threadOrigin({ source: 'custom-source' })).toEqual({
      label: '来源未确认',
      description: '缺少可识别的创建方信息，Codex 来源记录为「custom-source」。',
    });
  });
});
