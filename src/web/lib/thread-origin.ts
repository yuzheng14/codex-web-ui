interface ThreadOriginInput {
  originator?: string | null;
  source: string;
}

export function threadOrigin(thread: ThreadOriginInput): { label: string; description: string } {
  const { originator, source } = thread;
  if (originator?.trim()) {
    switch (originator) {
      case 'codex_web_ui':
        return { label: 'Web', description: '由 Codex Web UI（本网页）创建。' };
      case 'codex-tui':
        return { label: 'CLI', description: '由 Codex 终端命令行创建。' };
      // Exact client names verified in Codex rust-v0.162.1:
      // app-server-protocol/src/protocol/common.rs and
      // app-server/src/request_processors/initialize_processor.rs.
      case 'codex_vscode':
        return { label: 'VS Code', description: '由 VS Code 中的 Codex 扩展创建。' };
      case 'Codex Desktop':
        return { label: 'Codex Desktop', description: '由 Codex 桌面应用创建。' };
      default:
        return { label: originator, description: `创建方记录为「${originator}」。` };
    }
  }

  // Session source describes a Codex runtime category, not always the creating client.
  switch (source) {
    case 'cli':
      return { label: 'CLI', description: '记录为 Codex 终端命令行来源。' };
    case 'vscode':
      return {
        label: '交互客户端',
        description:
          'Codex 仅记录了交互来源分类，可能来自网页、终端或 IDE，无法确认具体创建客户端。',
      };
    // Codex's public appServer value maps to its core MCP session source.
    case 'appServer':
    case 'mcp':
      return { label: 'MCP', description: '记录为 Codex MCP 服务来源。' };
    case 'exec':
      return { label: '命令行任务', description: '记录为 Codex 非交互命令行任务来源。' };
    default:
      return {
        label: '来源未确认',
        description:
          source && source !== 'unknown'
            ? `缺少可识别的创建方信息，Codex 来源记录为「${source}」。`
            : '缺少可识别的创建方信息。',
      };
  }
}
