# Codex 0.164.0 升级验证

日期：2026-10-24（Asia/Shanghai）。对应 [#249](https://github.com/yuzheng14/covro/issues/249)。保留 stdio app-server 架构，将单一推荐和 verified 基线提升到 0.164.0；0.163.0 与其他版本继续走 unverified 确认，不推断相邻版本兼容。

## 协议与真实 binary + 本地模型 stub

来源、完整包 SHA-256、751 个原始生成文件和实验字段核对见 [协议审查](codex-0.164.0-protocol.md)。没有新增 npm 依赖或修改锁文件。

`node --import tsx scripts/verify-codex-upgrade.ts --config <隔离配置> --expected-version 0.164.0 --output <报告>` 严格核对目标版本；省略预期版本或实际版本不符时拒绝执行。legacy 与 paginated 均使用新的 CODEX_HOME、本地 HTTP 模型 stub 和原生 RPC 建立历史，不使用账户或真实推理：

- 最后一轮完成后通过 `thread/settings/update` 改模型、推理强度和 service tier，退出进程并更改全局默认值，冷恢复仍返回保存的设置、只读权限和网络开启状态。显式恢复覆盖能够生效，包括清空 service tier。
- 仅调整本测试由 CLI 新建的 rollout 文件 mtime，模拟超过七天的冷文件，再由原生 `rollout/compress` 压缩；不编写历史内容或数据库行。压缩后的 `thread/read` 与原轮次一致，后续按 ID 冷恢复成功，网页 Markdown 导出渲染可见保存的消息。
- 两独立进程的 writer conflict 精确映射、原进程退出后的恢复、Fork 的消息与父 ID，以及继续对话通过。
- 命名权限 profile 收紧后重新解析；自动标题使用禁用工具的临时线程，并保留 profile 身份。
- 本地模型 stub 故意失败时，原生压缩失败不增加部分摘要或丢失原消息，随后继续对话成功。
- 跨项目和受信任子目录的 `config/read` 使用显式 cwd，独立于 app-server 启动目录。

mtime 调整仅用于测试冷文件门槛，不等同真实存放七天。标题结果来自 stub，不代表标题模型质量。

## 实际推理与浏览器

隔离 CODEX_HOME 仅复用现有认证，不复制默认历史、项目配置或 MCP 配置，不打印凭证。官方完整包已包含同版 Code Mode host。

- `scripts/live-smoke.ts --config <隔离配置> --inference`：版本、握手、认证与七个模型查询通过；实际创建 smoke.txt 并核对精确内容，收到文件变更、继续对话、历史列表通过；无订阅期间 PID 不变。本轮文件任务没有命令输出，不能将其记为真实 shell 输出验证。
- `scripts/live-upgrade-interactions.ts --config <隔离配置> --expected-version 0.164.0 --inference`：实际 nested shell 运行中按 expectedTurnId 追加、Code Mode 中断终态、结束后追加拒绝、立即下一轮通过；人工命令审批被拒绝，迟到回复失效。没有自动批准人工请求。
- 在上述新建的真实会话中调用手动 `thread/compact/start`，收到压缩 item 生命周期及完成终态；压缩后的真实继续对话和历史查询通过。未单独触发真实自动后台压缩。
- 用生产构建、真实网关和 Chromium 提交最小任务，收到实际完成回复；刷新后恢复相同历史。桌面和 390px 窄屏的 `/status` 诊断显示运行版本、已验证版本均为 0.164.0，已截图。截图来自真实 0.164.0，不是 fixture。

范围明确的机器可读结果见 [results](codex-0.164.0-results.json)。本次不覆盖历史 0.163.0 的验证记录。

## 部署与保留边界

显式选择完整官方安装后重启网关；更换 binary/home 会产生新 epoch，旧确认不会沿用。回退到 0.163.0 进入 unverified 确认，不自动重放任务。若以后需要同时声明两个版本 verified，需分别验证。

受管策略及模型限制、跨会话审批归属和旧 epoch 回复由现有 fixture 回归覆盖；本次没有修改系统受管配置。逐域网络授权和代理的冷恢复、企业 MCP 认证、远程部署及 Cloudflare/Tailscale 访问没有重新实测。WebSocket 压缩、sampling/prediction 与新诊断导出接口不是本次 Web 功能范围。
