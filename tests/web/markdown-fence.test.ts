import { describe, expect, it } from 'vitest';
import { isClosedCodeFence } from '../../src/web/lib/markdown-fence';

describe('streaming Markdown fences', () => {
  it.each([
    '```mermaid\nflowchart LR\nA --> B\n```',
    '~~~mermaid\nsequenceDiagram\nA->>B: Hello\n~~~~\n',
    '```mermaid\n> flowchart LR\n> A --> B\n> ```',
    '```mermaid\r\nflowchart LR\r\nA --> B\r\n```\r\n',
  ])('recognizes a complete fence: %s', (source) => {
    expect(isClosedCodeFence(source)).toBe(true);
  });

  it.each([
    '```mermaid',
    '```mermaid\nflowchart LR\nA --> B',
    '```mermaid\nflowchart LR\nA --> B\n``',
    '````mermaid\nflowchart LR\nA --> B\n```',
    '```mermaid\nflowchart LR\nA --> B\n~~~',
    '```mermaid\nflowchart LR\nA --> B\n``` trailing content',
  ])('waits for the matching closing fence: %s', (source) => {
    expect(isClosedCodeFence(source)).toBe(false);
  });
});
