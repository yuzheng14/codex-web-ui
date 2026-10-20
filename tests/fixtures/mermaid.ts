export const flowchart =
  'flowchart LR\n  A[收到任务] --> B{需要审批?}\n  B -->|是| C[人工确认]\n  B -->|否| D[执行任务]\n  C --> D\n';
export const sequence =
  'sequenceDiagram\n  participant U as 用户\n  participant C as Covro\n  participant A as Codex\n  U->>C: 发送任务\n  C->>A: 开始执行\n  A-->>C: 流式回复\n  C-->>U: 显示图表\n';
export const invalidDiagram = 'flowchart LR\n  A[未闭合节点\n';
export const diagramDocument = `# Mermaid 文档预览\n\n流程图与会话共用渲染器。\n\n\`\`\`mermaid\n${flowchart}\`\`\`\n\n\`\`\`mermaid\n${sequence}\`\`\`\n`;
export const mermaidChunks = [
  '## 任务执行流程\n\n```mermaid\nflowchart LR\n  A[收到任务] --> B{需要',
  `审批?}\n  B -->|是| C[人工确认]\n  B -->|否| D[执行任务]\n  C --> D\n\`\`\`\n\n## 消息时序\n\n\`\`\`mermaid\n${sequence}`,
  `\`\`\`\n\n[阅读图表文档](docs/mermaid.md)\n\n## 语法错误示例\n\n\`\`\`mermaid\n${invalidDiagram}\`\`\`\n\n其他正文仍然可读。行内代码 \`mermaid\` 和普通代码块保持原样。\n\n\`\`\`text\nflowchart LR\nA --> B\n\`\`\``,
];
