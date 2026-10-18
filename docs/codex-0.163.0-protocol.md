# Codex 0.163.0 协议审查

核对日期：2026-10-18。对应 [#64](https://github.com/yuzheng14/codex-web-ui/issues/64)，比较目标为 `rust-v0.162.1 → rust-v0.163.0`，不是 release notes 的 0.162.0 起点。

## 来源与生成

使用官方 [0.163.0 release](https://github.com/openai/codex/releases/tag/rust-v0.163.0) 的 `codex-aarch64-apple-darwin.tar.gz`，SHA-256 为 `61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10`。解压后实际报告 `codex-cli 0.163.0`；没有替换全局 CLI。

`pnpm codex:generate -- --config <显式指定该 binary 的配置>` 生成 747 个稳定类型文件。生成器先写入空临时目录，成功后替换旧目录，防止旧类型残留；生成失败不替换原目录或版本记录。产物与同一二进制再次生成的空目录逐文件一致，未手工修改。`protocol-version.json` 只记录类型来源，运行时是否 verified 由适配器和真实验证单独决定。

稳定产物相对 0.162.1 新增 4 个文件、修改 11 个文件，没有删除文件：

- `thread/list.excludedThreadIds` 为可选过滤字段；当前列表逻辑无需改变。
- `thread/readState/changed` 通知及 4 个相关类型加入产物。Web 暂不接入持久已读状态；未知非交互通知不会授权任何操作。
- `TurnToolOutput.retain`、响应项的加密内容和状态、输出文本的 annotations/logprobs 为新增可选字段。
- Realtime voice 枚举更新。ThreadListResponse、ThreadReadResponse 的差异仅为生成格式。

## 已使用实验字段

分别用现有 0.162.1 与目标 0.163.0 生成 `--experimental` 到临时目录后比较，保留仓库稳定产物策略。以下类型逐字节一致：ThreadStartParams/Response、ThreadResumeParams/Response、TurnStartParams、ThreadSettings、ConfigRequirements。

现有权限 profile、审核方限制、runtime workspace roots，以及自动标题使用的 permissions、environments、dynamicTools、selectedCapabilityRoots 仍可用。ThreadForkParams 只新增可选 `experimentalPredictionMode`；现有持久 Fork 不启用它。新增实验接口 `thread/items/read` 和 `thread/readState/update` 不影响现有分页历史实现，也没有因此增加 Web 功能入口。

自动标题仍按 [0.163.0 thread_title.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/app/thread_title.rs) 的 `gpt-5.6-luna`、low effort、36 字符策略；没有因升级而更换模型。真实二进制与本地模型 stub 的工具禁用及临时线程检查见升级验证记录；它们不等于真实模型推理。

## Slash Command 核对

逐项比较精确 tag 的 [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/slash_command.rs)、[slash_dispatch.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/chatwidget/slash_dispatch.rs) 和菜单/服务等级入口：

- 固定枚举从 63 项增为 64 项，仅新增 `/config`，不可在任务运行中调用，打开配置面板后停止排队命令消费；没有固定命令删除、重命名或别名变化。
- 现有命令的参数和 dispatch 路径未变。`/config` 保持 ⬜ 未实现；Web 现有配置控件不等于完成该命令。
- `/keymap` 增加 leader key、`/daemon` 支持后台服务重启、`/side` 返回已有侧聊，以及 Daybreak 对合资格账户默认开启属于上游行为/条件变化；保留 #69 的现有范围和状态。
- `/cwd`、`/pet`、`/clean` 仍是显式别名；动态服务等级入口继续依赖模型目录，不增加固定命令计数。Web `/stop` 仍中断当前 turn；不改为 CLI 的后台终端清理。

支持状态统一维护于 [#69](https://github.com/yuzheng14/codex-web-ui/issues/69)。
