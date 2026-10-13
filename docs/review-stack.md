# PR 评审顺序

GitHub 原生 stack **#15**，14 个 PR 均已关联；`main` 未修改、未合并。每层基于上一层，各 PR 只展示自己的增量。点击任一 PR 可通过 GitHub 原生栈视图导航。

| 顺序 | PR                                                       | 内容                                                                   |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 01   | [#1](https://github.com/yuzheng14/codex-web-ui/pull/1)   | chore: establish TypeScript tooling and application contracts          |
| 02   | [#2](https://github.com/yuzheng14/codex-web-ui/pull/2)   | chore(codex): pin generated protocol from CLI 0.162.1                  |
| 03   | [#3](https://github.com/yuzheng14/codex-web-ui/pull/3)   | feat(codex): add bounded JSONL RPC transport and simulator             |
| 04   | [#4](https://github.com/yuzheng14/codex-web-ui/pull/4)   | feat(codex): manage app-server sessions turns and human requests       |
| 05   | [#5](https://github.com/yuzheng14/codex-web-ui/pull/5)   | feat(db): persist deduplicated operations and execution markers        |
| 06   | [#6](https://github.com/yuzheng14/codex-web-ui/pull/6)   | feat(server): validate configuration and canonical project identity    |
| 07   | [#7](https://github.com/yuzheng14/codex-web-ui/pull/7)   | feat(server): project turn state and replay bounded snapshots          |
| 08   | [#8](https://github.com/yuzheng14/codex-web-ui/pull/8)   | feat(server): coordinate task ownership approvals and reconciliation   |
| 09   | [#9](https://github.com/yuzheng14/codex-web-ui/pull/9)   | feat(server): serve authenticated HTTP and recoverable WebSockets      |
| 10   | [#10](https://github.com/yuzheng14/codex-web-ui/pull/10) | feat(web): recover per-thread streams and durable operation identities |
| 11   | [#11](https://github.com/yuzheng14/codex-web-ui/pull/11) | feat(web): add responsive workspace shell and runtime settings         |
| 12   | [#12](https://github.com/yuzheng14/codex-web-ui/pull/12) | feat(web): render conversations diffs approvals and execution controls |
| 13   | [#13](https://github.com/yuzheng14/codex-web-ui/pull/13) | feat(web): connect the workspace to real gateway operations            |
| 14   | [#14](https://github.com/yuzheng14/codex-web-ui/pull/14) | test: verify browser recovery and document production deployment       |

本地使用 `gh stack view` 查看、`gh stack switch` 导航。审核后从栈底向上合并；上层依赖未合并时不要单独重设 base 为 main。生成协议被标记为 generated，人工代码按职责评审。

初次交付时，前 13 层均通过独立归档的类型检查和适用测试；第 08 层的真实会话发现修复已重新独立验证（49 项），第 14 层已独立类型检查并构建。任务文本保真修复后，完整应用通过 75 项测试和 4 项 Chromium 验收；先前已通过隔离生产产物检查以及真实 Chromium + Codex 任务恢复。详见 [验证记录](verification.md)。
