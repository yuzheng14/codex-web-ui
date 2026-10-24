# Codex 0.164.0 协议审查

核对日期：2026-10-24（Asia/Shanghai）。对应 [#249](https://github.com/yuzheng14/covro/issues/249)，比较 `rust-v0.163.0 → rust-v0.164.0` 两个精确 tag。

## 来源与生成

使用官方 [0.164.0 release](https://github.com/openai/codex/releases/tag/rust-v0.164.0) 的 `codex-package-aarch64-apple-darwin.tar.gz` 完整包，SHA-256 为 `dd99e9092270691a67bdde7be04ac283dea9da8e86cbde356c2cc851a79205fa`，解压后报告 `codex-cli 0.164.0`。包内包含同版 Code Mode host；目标安装只用于隔离验证，没有替换全局 CLI。

通过现有 `pnpm codex:generate -- --config <显式选择目标 binary 的配置>` 生成稳定协议，仍先生成到空临时目录，成功后替换，不手改产物。稳定类型共 **751 个文件**，相对 0.163.0 新增 4 个、修改 9 个、无删除：

- 新增 `ImageGenerationInputImage`、`ApplicationStorageRequirements`、`FeedbackSaveParams`、`FeedbackSaveResponse`。
- `ImageGenerationItem` 改为 `{ fileId } | { result }`，并增加可选 `inputImages`。现有通用活动详情保留两种载荷，未因此增加图片下载或预览入口。
- `feedback/save` 加入客户端请求；账号计划增加 `sci`、`sci_plus`；hooks 增加模型请求前后事件；MCP 状态增加 `toolListMeta`；Desktop application requirements 增加 storage。其余为索引导出更新。
- InitializeParams、ThreadStart/Resume/Fork、TurnStart/Steer、ThreadSettings、ConfigRequirements、ServerRequest 和 ServerNotification 的稳定文件不变。类型一致不等于行为已经验证。

## 已使用实验字段

用本机 0.163.0 与目标 0.164.0 分别生成 `--experimental` 到临时目录比较。ThreadStartParams/Response、ThreadResumeParams/Response、ThreadSettings、ConfigRequirements 逐字节一致，现有权限 profile、审核方限制及自动标题的实验边界继续保留。

TurnStartParams 新增可选 `responsesapiClientMetadataPatch`；ThreadForkParams 新增 prediction MCP 禁用选项并调整 prediction config 覆盖说明。Covro 不发送这些新字段，也不启用新增 `thread/sample`。稳定生成策略保持不变。

自动标题的 `gpt-5.6-luna`、low effort 和 36 字符策略保持不变。上游移除的是 TUI 自动标题生成中的 spinner，未因此修改网页标题行为。

## Slash Command

对照精确 tag 的 [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/slash_command.rs) 与 [slash_dispatch.rs](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/chatwidget/slash_dispatch.rs)：

- 固定枚举 64 → 65，仅新增 `/presets`，提供 1–9、0 共十个槽；无行内参数，枚举允许运行中调用，仍受侧聊和线程状态检查。
- `/model` 增加模型、reasoning、speed 行内参数；`/permissions` 增加 profile 参数；`/title`、`/statusline` 增加行内及 session-only 配置。
- 无固定命令删除、重命名或显式别名变化；动态服务等级命令继续来自模型目录。
- `/worktree` 不再检查旧 `worktrees` feature flag，仍要求本地操作能力；权限选择期间阻止排队提示继续发送的上游修复已纳入状态边界核对。

支持矩阵维护于 [#69](https://github.com/yuzheng14/covro/issues/69)：Web 仍为十个入口；`/presets` 为 ⬜，`/permissions` 为 ⬜，保留 `/model`、终端 title/statusline 的 🚫 范围决定。升级 CLI 不等于新增这些网页命令。
