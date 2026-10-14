# Codex Web UI

私人电脑上的 Codex 网页客户端。默认中文，单用户、单网关、单受管 `codex app-server`；支持本机、Tailscale Serve 或 Cloudflare Access 访问，页面、API 和 WebSocket 共用配置的访问入口。

项目规范：[codex-web-ui-mvp.md](codex-web-ui-mvp.md)。实现分层、验收结果与边界见 [architecture](docs/architecture.md)、[verification](docs/verification.md)、[compatibility](docs/compatibility.md)。

实现按 14 个小单元组织为 GitHub 原生 Stacked PR，见 [PR 评审顺序](docs/review-stack.md)。

## 安装与本机运行

要求 Node.js **24.19.0**（LTS）、pnpm **12.11.2**、已安装并登录的 Codex CLI。协议生成目标为 **0.162.1**。依赖版本固定于 `package.json` 和 `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile
cp config.example.json config.local.json
# 编辑 config.local.json：将 projects[].path 改为真实项目的绝对路径。
pnpm dev
```

开发页面为 <http://127.0.0.1:5173>，Vite 将 `/api` 和 `/ws` 代理至后端 8787。开发 origin 必须显式写入 `developmentOrigins`，只有 `--dev` 时启用。两端均仅监听回环地址。

生产构建与运行：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start -- --config ./config.local.json
```

生产页面可通过 `publicOrigin` 数组中的任一地址访问（示例配置同时允许 <http://127.0.0.1:8787> 和 <http://localhost:8787>）。可从任意目录以绝对路径启动：

```sh
node /absolute/path/codex-web-ui/dist/server/main.js --config /absolute/path/codex-web-ui/config.local.json
```

不要用开发服务器作为 Tunnel 的源服务。`dist/` 中包括浏览器产物、服务端模块和迁移；运行时还需要 `package.json` 及已安装的生产依赖。

## 配置与使用

- `projects` 注册允许访问的目录。浏览器只能提交项目 ID，不能覆盖 cwd。不可用目录会在项目列表标出；符号链接按 realpath 归一化。
- `codex.binary` 支持绝对路径。后台服务的 PATH 与终端不同，建议填绝对路径。可选 `codex.home` 只设置子进程的 CODEX_HOME；默认继承现有环境。应用不读取或返回登录令牌，不改全局 Codex 配置。
- `dataDir` 相对于配置文件所在目录解析。数据库在 `dataDir/app.sqlite`，目录权限 0700、数据库权限 0600。实例锁覆盖运行服务和显式迁移命令，异常退出后的锁约十秒可恢复。
- `publicOrigin` 是允许访问地址的非空数组，每项填写完整的 `协议://主机[:端口]`，不带路径、通配符、凭据、查询或片段。HTTP 与 WebSocket 都按此列表检查 Host / Origin；`localhost` 和 `127.0.0.1` 需要分别配置。旧配置的字符串需改为数组，例如 `"publicOrigin": ["http://127.0.0.1:8787"]`，修改后重启服务。
- `host` / `port` 控制实际监听地址；`local` 模式要求 `host` 为回环地址，可显式允许 Tailscale Serve 的 HTTPS 入口，由 Tailscale 控制访问身份。公开互联网入口使用 `cloudflare-access` 模式，所有 `publicOrigin` 项必须为 HTTPS，并通过同一 Access 应用的 JWT 校验。具体配置参见 [部署指南](docs/deployment.md)。
- 模型、推理强度、审批与沙箱默认继承 Codex 配置；显式选择通过版本适配层校验和映射。

本机升级 Codex 后，若运行版本尚未验证，页面会先提示可能无法正常使用，并要求明确“确认继续”。确认前不能新建、Fork、恢复或发送任务，但仍可查看诊断和中断已有任务。确认在同一服务与 Codex 实例内共享，刷新不会重复询问；重启或版本变化后需要重新确认。初始化失败或已知不支持的操作不能通过确认绕过，详见 [兼容性说明](docs/compatibility.md)。

左侧同时列出所有配置项目及各自的会话，可直接在对应项目下新建或打开会话。正在执行、等待审批和已完成的会话状态会实时更新；查看一个项目时，也能看到其他项目的进展。每个项目独立分页、重试加载，并支持搜索项目与已加载会话；手机上通过“打开项目与会话”展开导航。项目仍在配置文件的 `projects` 中维护。

会话草稿、未选会话时的项目草稿，以及各项目的模型/执行设置在当前页面内分别保留；切换项目不会混用。历史包括 CLI、app-server 与 VS Code 来源。首次恢复不受当前服务持有的历史会话时，需要明确确认原 CLI 已停止操作该会话。本应用不会接管或结束其他终端进程。

打开已有会话后点击“Fork 会话”，会复制 Codex 已保存的历史并切换到新会话，可以在副本上继续对话。空会话需先发送首条消息。“外部会话”及“提交结果尚未确认”提示也提供 Fork 入口，无需先停止原会话或完成交接；原会话保持不变。Fork 不复制未发送的草稿或待处理审批，也不会创建新的项目目录。新会话可与原会话在同一目录并行执行，原会话等待审批或状态待核对也不会阻塞它。Fork 回执丢失时先查询同一操作 ID，避免创建重复副本。

不同会话可以在同一目录或 checkout 同时执行任务。需要隔离文件改动时可自行使用 Git worktree；应用不会自动创建 worktree。执行中输入框变为追加要求；中断需要等待真实终态。工具命令、输出、文件变更和 diff 按所属 turn 展示。审批及结构化问题在人工请求区域处理；断线不会自动作答。

同一会话只启动一个活动 turn，执行中仍可通过追加要求指导当前任务。发送下一轮或刷新会话详情时，会核实上一轮的已知执行标记：仅在上游历史明确显示对应任务完成、失败或中断且没有其他活动任务时自动释放。无法核实的执行只保留本会话的待核对状态，不影响同目录的其他会话。

额外权限请求会列出网络访问和文件读取、写入范围，可选择仅允许本轮、本会话允许或拒绝。MCP 工具需要补充信息时会显示表单；需要到外部页面完成操作时会显示目标链接，由用户主动打开并确认。刷新或断线不会自动同意、拒绝或取消请求。不支持的表单会明确提示，并保留拒绝和取消入口。

输入框按 Enter 发送消息，Shift + Enter 换行；执行中按 Enter 会追加要求。输入法组合输入期间的 Enter 仅确认候选词，也可点击发送按钮提交。

关闭所有页面不取消任务。重新打开获取当前快照；保有对应会话内存投影时可按游标补发。界面连接状态与最后已知执行状态独立。网络提交失败后保留操作 ID，刷新先查询旧结果，避免自动重复执行。`acknowledged` 只表示上游接受操作，并非任务完成。

服务或 Codex 异常退出后，无法确认的操作为 `unknown`，包括已确认但尚无终态的执行占用。点击提示中的“核对提交”会展开状态诊断，先刷新会话历史，再查询提交回执，并显示核对进度与查询错误。受管会话的未知状态也会重新读取 Codex 历史；只有匹配轮次的历史明确结束，且本会话没有其他活动任务时，才会自动解除本会话的执行占用。若仍待核对，在操作卡片中核实旧运行已经结束、勾选确认后，点击“核对并解除旧占用”；完成后会刷新状态，保留原操作状态和未发送草稿。上游仍报告活动时不能用核对绕过，应正常中断。

## 数据迁移、测试与协议

```sh
pnpm db:generate                         # schema -> 新 SQL 迁移及完整元数据
pnpm db:migrate -- --config ./config.local.json
pnpm codex:generate -- --config ./config.local.json
pnpm exec playwright install chromium
pnpm test:e2e                            # 显式模拟子进程，浏览器闭环
pnpm test:live                           # 真实握手、认证及模型诊断
pnpm test:live -- --inference             # 临时项目真实任务，会使用 Codex 额度
node --import tsx scripts/live-browser-smoke.ts --inference  # 真实 Chromium + Codex；需先 build 和安装 Chromium
```

启动自动应用**已提交**迁移；不自动生成、不使用 `drizzle-kit push`。迁移失败阻止启动 Codex 和派发任务，不重建或删除数据库。修改 schema 后生成新迁移；已应用迁移不可改写。SQLite 仅保存本应用操作、执行标记、会话关联和偏好表，不复制 Codex 会话库，也不逐 token 写库。备份前停止网关，完整备份 dataDir；Codex 自己的历史与凭据仍由其管理。

`pnpm test` 和 CI 不使用真实账户推理。测试进程遵循已生成协议；模拟界面明确标识。生产启动失败显示诊断，不切换假数据。安装和启动均不重新生成协议、不升级全局 CLI。

输出默认每 item 2 MiB，事件缓存 16 MiB，连接发送缓冲 4 MiB，可通过 `limits.itemBytes/eventBytes/wsBytes` 修改。截断有标记；慢连接关闭后重新获取快照。Codex stderr 仅保留有界内存尾部，不输出凭据或完整环境。外部进程管理器的 stdout 日志需单独轮转。

首版不包含文件上传、交互终端、文件编辑器、Git 操作面板、队列、多用户及自动管理 worktree。电脑休眠或停机时无法保证运行状态；不提供唤醒功能。
