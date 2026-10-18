# Codex 0.163.0 升级验证

日期：2026-10-18（Asia/Shanghai）。对应 [#64](https://github.com/yuzheng14/codex-web-ui/issues/64)。保留 stdio app-server 架构，单一已验证版本升级到 0.163.0；其他版本继续显示 unverified，并要求显式确认。本记录不覆盖历史 0.162.1 的实测结论。

## 验证层次

协议来源、747 个原始生成文件及已使用实验字段见 [协议审查](codex-0.163.0-protocol.md)。本轮没有修改依赖清单或锁文件。

本地回归使用真实子进程、SQLite 和 fixture：中断回执先于 terminal、结束后的追加拒绝、并行 item 交错、旧工具输出、旧终态、旧审批，以及旧终态先于新 turn 首个通知。修复两处实际复现的问题：旧 turn 不能改写新 turn 的会话状态；新执行尚无 turn ID 时，不能把既有 turn 的迟到事件绑定到该执行并释放占位。旧 turn 的输出仍保留在原轮历史，结束后的迟到审批直接失效。

`node --import tsx scripts/verify-codex-upgrade.ts --config <指定 0.163.0 binary 的配置> --output <报告>` 使用真实 0.163.0、全新的 CODEX_HOME、项目和本地 HTTP 模型 stub，不使用账户或真实推理。legacy 与 paginated 均验证：

- 从原生 RPC 创建并保存的会话冷恢复；保存只读、on-request、网络开启后，改磁盘默认为完全访问/never，恢复仍返回保存值。没有编辑 rollout 或数据库。
- 两独立进程占用时返回精确 writer conflict；原进程退出后恢复成功；显式只读/never 覆盖以返回值确认。
- Fork 返回新 ID、父 ID 与相同消息；继续对话可完成。
- 自动标题创建临时线程并返回名称；模型请求没有暴露 tools；内部线程不作为用户消息显示。使用本地 stub 的标题结果不等于模型质量或真实 gpt-5.6-luna 推理验证。

另观察到的边界：未命名 workspace-write、网络开启的保存快照，改默认为完全访问后，目标 binary 返回新的完全访问默认值。对照上游恢复实现，包含具体只读路径的未命名权限可能不作为可移植默认恢复；Web 始终以实际响应及更新通知显示结果，不重放保存权限、不用 UI 草稿冒充已恢复值。不能笼统承诺所有旧权限快照都会原样恢复。

- 命名 profile 从 workspace 收紧为 read-only 后按当前定义重新解析；自动标题继续继承该 profile 身份。
- 在不同于 app-server 启动目录的两个项目、受信任子目录读取配置，分别得到项目、子目录和用户默认模型。

## 实际推理

在独立 CODEX_HOME 中只复用现有认证，不复制默认历史、项目配置或 MCP 配置；不打印凭证。官方 CLI 和 Code Mode host 均来自 0.163.0 release，SHA-256 已核对。

`pnpm test:live -- --config <隔离配置> --inference --output <报告>` 已通过：版本/握手、账户与 7 个模型查询、创建会话、真实写入 smoke.txt 并核对精确内容、文件变更事件、继续对话、历史列表及无订阅期间 PID 不变。本任务没有 shell 命令输出，不能把文件变更当作命令输出验证。

`node --import tsx scripts/live-upgrade-interactions.ts --config <隔离配置> --inference --output <报告>` 专门验证真实追加、中断和人工审批；只运行隔离项目的等待命令并拒绝审批，不自动批准操作。已通过活动 nested shell 中的 expectedTurnId 追加、Code Mode 中断的真实终态、结束后追加拒绝、立即下一轮，以及人工命令审批拒绝和旧回复失效。

## 本地检查

- 最终类型检查、lint、生产构建及 778 项单元/集成测试通过。协议底层独立归档通过 775 项，中间行为层独立归档通过 778 项及对应浏览器用例。
- 同步 main 的 Tooltip 更新前，完整 302 项 Chromium 测试分六个临时副本运行，各自使用独立回环端口；测试中的固定回环 Origin 仅在副本中随端口替换。首轮 301 项通过，既有 desktop sticky prompt 滚动用例一次失败，独立复跑通过；第六分片完整复跑 49 项全部通过。没有因此修改无关 UI。同步 main 后再次通过 778 项测试、14 项取消/权限/运行设置浏览器回归、2 项 Tooltip 浏览器回归及隔离生产产物验证；最终浏览器清单为 304 项，由 GitHub 六分片 CI 核对。
- 实际 0.162.1 在新的无认证 CODEX_HOME 中完成诊断并被标为 unverified，版本确认门禁没有放宽。

## 部署与回退

升级前在服务配置中显式选择目标 binary。使用完整官方安装；单独下载 codex 可执行文件不包含 Code Mode host。本轮独立 CLI 的真实任务曾报告工具宿主缺失，模型虽然返回 completed，但并未写出目标文件；补齐同版 `codex-code-mode-host` 后通过。macOS arm64 host 附件 SHA-256：`031b73a18e868836eceb3772bef5d7fb3bfe147de0bcdd27a4141f263373117b`。不要把 RPC completed 等同于任务效果已验证。

0.163.0 不再捆绑 patched zsh；检查旧配置中依赖该 shell 或已退休 flags 的设置，按 CLI 的迁移提示处理。网关不自行改写用户 TOML、不自动安装或升级 CLI。更换 binary/home 后重启网关；旧确认绑定旧 epoch，不能沿用。

回退到 0.162.1 后会进入现有 unverified 确认流程，而不是继续显示已验证。确认不会重发任务或清空草稿。若需同时验证两个版本，必须另建双版本验证矩阵，不能直接放宽版本判断。

## 仍有边界的验证

受管策略收紧/冲突、模型受管限制、跨会话审批归属、重启后 request ID 复用与旧 epoch 回复失效，由仓库 fixture 回归覆盖。当前官方 release 没有提供把系统受管要求临时重定向到独立目录的生产参数；本轮没有修改 /etc 或 MDM，因此没有把这些模拟结果写成真实受管环境验证。保存的网络开启设置已做真实冷恢复；逐域网络授权与代理实际连通性的冷恢复仍需目标受管环境验证。

另用生产构建、真实网关和隔离的 0.163.0 从 Chromium 页面提交最小推理任务，收到真实完成回复；运行诊断为 verified，桌面与 390px 窄屏已截图。取消回归截图另来自显式 fixture，展示旧输出到达后下一轮仍等待自身审批、可正常中断。真实模型页面与 fixture 截图分别注明，不等于 Tunnel 验证。Cloudflare/Tailscale 的部署访问范围沿用历史记录，本轮未重新验证。
