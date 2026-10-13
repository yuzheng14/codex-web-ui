# PR 评审顺序

GitHub 原生 stack **#15**。#1、#2 已由用户合并，剩余层已同步到最新 `main`，从 #3 继续评审。每层基于上一层，各 PR 只展示自己的增量。点击任一 PR 可通过 GitHub 原生栈视图导航。

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
| 15   | [#16](https://github.com/yuzheng14/codex-web-ui/pull/16) | feat: require explicit consent for unverified Codex versions           |

本地使用 `gh stack view` 查看、`gh stack switch` 导航。审核后从栈底向上合并；上层依赖未合并时不要单独重设 base 为 main。生成协议被标记为 generated，人工代码按职责评审。

初次交付时，前 13 层均通过独立归档的类型检查和适用测试；第 08 层的真实会话发现修复已重新独立验证（49 项），第 14 层已独立类型检查并构建。加入兼容性确认后，完整应用通过 104 项测试和 10 项 Chromium 验收，以及类型检查、Lint、构建和隔离生产产物检查。先前已验证真实 Chromium + Codex 任务恢复，详见 [验证记录](verification.md)。

## 第 3 个 PR 的 review 重点

本层向上提供 JSONL RPC 传输能力，主要评审调用者观察到的行为：

- UTF-8 字符和 JSONL 消息被拆成多段、同一块包含多条消息时，不丢字、不串消息。
- 请求回执可乱序；数字 `0` 与字符串 `"0"` 分开匹配，通知和服务端人工请求互不混淆。
- RPC 回执只表示该次调用得到响应，不表示任务已经结束。
- 超时、写入失败或 EOF 时明确保留“可能已执行”的不确定性，不自动重发任务；迟到回执不触发重复执行。
- 无效消息、超长单行、积压请求与待写缓冲都有明确边界；连接失败后挂起请求得到清理。

页面重连、审批卡片和任务终态投影由后续层负责；本层重点检查上述传输契约和故障测试。
