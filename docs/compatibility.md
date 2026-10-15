# Codex 协议兼容性

验证日期：2026-10-13（Asia/Shanghai）。目标可执行文件实际报告 `codex-cli 0.162.1`。

`src/codex/generated/` 是本机该版本执行 `codex app-server generate-ts --out ./src/codex/generated` 的原始产物，未手工修改。`src/codex/protocol-version.json` 记录来源。更新协议需显式执行 `pnpm codex:generate -- --config ./config.local.json`，使用配置中的 `codex.binary`；安装与启动不会更新 CLI 或重新生成协议。生成文件仅用于服务端适配和模拟器的静态类型约束，浏览器使用 `src/shared/types.ts`。

官方接口背景见 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。应用以本仓库生成的目标版本类型为准，重点差异如下。

| 项目       | 0.162.1 的实际映射                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 握手       | `initialize` 成功后发送 `initialized`，随后读认证和模型；`experimentalApi: true` 允许结构化用户请求                                                                   |
| 历史来源   | `thread/list.sourceKinds` 显式为 `cli`、`appServer`、`vscode`；省略只匹配原始字符串的 `cwd`，由服务层按 realpath 和目录边界筛选归属，保留符号链接别名和项目子目录历史 |
| 分页历史   | `Thread.historyMode` 可为 `paginated`；此时用 `thread/turns/list` 与必要的 `thread/items/list` 完整加载，不假定 `thread/read(includeTurns)` 覆盖所有历史              |
| 新建、恢复 | `thread/start`、`thread/resume` 只映射已定义设置；恢复附带服务端已校验的 `cwd`                                                                                        |
| 分叉会话   | `thread/fork` 使用源会话校验后的 `cwd`、`excludeTurns: true`，省略 `lastTurnId`；新 ID 再通过历史读取接口加载，保留 `forkedFromId`。运行中的源会话继续执行，分支记录已保存历史及中断状态 |
| 文本输入   | `input: [{ type: 'text', text, text_elements: [] }]`，追加要求使用 `turn/steer.expectedTurnId`                                                                        |
| 推理强度   | turn 使用 `effort`；新建和恢复通过协议支持的 `config.model_reasoning_effort` 设置；选项来自 `model/list`                                                              |
| 权限       | thread 使用 `sandbox` 枚举；turn 映射为 `sandboxPolicy` 对象，不直接透传浏览器字段                                                                                    |
| 审批       | command/file 使用各自 decision 枚举；命令规则和网络规则只能采用上游请求提供的具体 amendment                                                                           |
| 额外权限   | `item/permissions/requestApproval` 展示原始请求的网络及文件范围；允许本轮/本会话分别回复 `scope: turn/session`，拒绝回复空权限；浏览器不能提交或扩大权限范围 |
| MCP 交互   | `mcpServer/elicitation/request` 支持 `form`、`openai/form`、`openaiForm` 的平面表单及 `url` 模式；回复 `action/content/_meta`，拒绝与取消保持独立语义。URL 仅允许 HTTP/HTTPS，必须由用户主动打开 |
| 结构化问题 | `item/tool/requestUserInput`，回复为 `{ answers: { questionId: { answers: [...] } } }`；校验选项、自由输入和题目 ID，保留 `isBlocking` 语义                           |
| 回答确认   | 写入回复后保持 responding；`serverRequest/resolved` 才确认 answered，turn 结束或进程退出使遗留请求失效                                                                |
| 自动审核展示 | `item/autoApprovalReview/started`、`item/autoApprovalReview/completed` 按独立 `reviewId` 合并，只读展示操作、状态、风险和原因；不发送审批回复，也不据此判定任务完成 |
| 请求 ID    | 字符串与数字分别匹配，数字 `0` 有效；不依赖响应顺序                                                                                                                   |
| 新活动类型 | 保留稳定 item ID，以通用活动详情展示；未知交互请求显示兼容错误并回复 JSON-RPC `-32601`，不会自动同意                                                                  |

MCP 表单支持字符串、数字、整数、布尔值、单选和多选，以及必填、长度、数值范围、选项和数组长度约束。服务端在领取请求前校验回答，保留 `false`、`0` 和字符串空白；适配层发送前再次校验。不支持的结构或约束会显示说明并禁止接受，但仍允许明确拒绝或取消；不会默默忽略约束后授权。权限目标和表单控制信息不会随长会话输出一起被截断。

自动审核状态区分 `inProgress`、`approved`、`denied`、`timedOut` 和 `aborted`。本轮结束或运行进程退出时仍未收到结果的审核显示“结果未确认”，不推断为允许或拒绝；迟到的开始通知不会覆盖已收到的终态。记录保留在网关内存投影中，浏览器刷新和重连可恢复；当前协议的会话历史不含审核通知，因此不承诺网关重启后恢复。严格审核要求、Guardian 警告和 `thread/approveGuardianDeniedAction` 的人工再次授权入口尚未接入。

2026-10-14 的 Fork 检查使用真实 `0.162.1`、独立临时 `CODEX_HOME` 和人工构造的持久历史，无登录、无模型请求。已验证新 ID、父会话 ID、目录与消息复制、completed 状态保留，以及源历史文件逐字节不变；未结束的静态历史副本为 interrupted。真实运行中推理及真实分页 Fork 未在此检查中验证，相关行为由协议 fixture 覆盖。刚新建但未落盘的空会话会被 CLI 拒绝（`no rollout found`）。

历史列表保留上游分页游标。归属筛选后某页可能较少或为空，仍可通过“加载更多”继续下一页；不能将空页误判为历史结束。

默认 RPC 回执期限 30 秒，与 turn 执行时间分开。回执超时、写入失败、进程退出及协议错误均保留可能已执行的不确定性；不会自动重发 prompt。stdout 单行上限 8 MiB，stdin 待写上限 4 MiB，待确认 RPC 上限 256；stderr 只保存 64 KiB 内存尾部，不返回给浏览器。子进程只使用参数数组启动，继承用户环境；仅配置 `codex.home` 时覆盖子进程的 `CODEX_HOME`。关闭时只处理本服务持有的子进程，有限等待后强制结束。

版本相同时显示 verified；其他版本显示 unverified，不伪装验证成功。`initialize` 的客户端版本与能力开关不提供跨 CLI 版本的 schema 兼容保证；重新生成类型也不等于验证了运行行为。上游明确拒绝某方法为不支持后，该方法被禁用并显示原因。缺少认证、模型查询或初始化能力时保留明确诊断，不进入无限重启。

## 未验证版本的使用确认

已验证版本直接使用。未验证版本通过握手与基础查询后，页面显示运行版本、已验证版本和“部分功能可能无法正常使用”的提示，提供“暂不使用”和“确认继续”。取消后仍可查看历史与诊断，并从提示条重新打开确认；确认不会自动重放先前任务，也不会清空草稿。

`GET /api/system` 的 `compatibilityConfirmation` 为 `not-required`、`required` 或 `confirmed`。客户端通过 `POST /api/system/compatibility/confirm` 明确确认，提交新的 `clientOperationId`、当前 `codexEpoch`、`codexVersion`、`verifiedVersion` 和 `confirm: true`，返回可查询、可去重的标准操作回执。此接口使用与其他变更操作相同的身份、Origin、JSON 和请求体校验。

确认前，服务端阻止新建、Fork、恢复、发送、追加和回答人工请求，返回 `COMPATIBILITY_CONFIRMATION_REQUIRED`；新确认携带旧版本或旧运行实例时返回 `COMPATIBILITY_CHANGED`。重试相同操作 ID 只返回原回执，不重新授权。读取历史、查看诊断、正常中断和原有人工核对不受该确认门槛影响。确认只允许尝试尚未验证的版本，不能绕过初始化失败或已经禁用的方法。

确认在网关内存中绑定运行版本、已验证版本和 Codex 运行实例。同一实例内刷新、重连或打开其他标签页共享确认；网关或 Codex 重启、版本变化后重新确认。持久化操作回执仅用于审计和查询，不会在重启后重新授予确认。已确认的版本仍显示“尚未验证”，不会变为 verified。

确认请求结果不明时，可刷新确认状态；如果仍需确认，可显式“重新确认”。页面先重新读取当前运行状态，仅在版本与实例仍与提示一致时创建新的确认操作，保留旧审计记录。这不会自动重发任务，也不会以旧回执恢复授权。

## 实际验证

- 无账号模拟测试使用真实子进程，覆盖 UTF-8 跨字节、分片、多行、交错通知/请求/响应、字符串与数字 ID、回执延迟与超时、真实终态、命令/文件/网络审批、结构化问题、未知交互、异常退出、分页历史及不支持的方法。
- 本机真实 `0.162.1` 已通过版本检查、`initialize → initialized`、`account/read` 和 `model/list`；认证可用，返回 7 个模型。未打印账户内容或令牌。
- 当前开发沙箱直接启动 app-server 会返回 `Operation not permitted`；经执行环境允许的沙箱外运行完成上述真实诊断。这是开发环境限制，不会自动切换为模拟数据。
- `pnpm test:live` 默认只执行上述诊断，不发起模型推理。`pnpm test:live -- --inference` 显式使用额度，在独立临时目录创建 `smoke.txt`、核对内容、继续对话、检查历史，并验证无事件订阅期间 app-server PID 不变。可用 `--output /tmp/report.json` 保存范围明确的报告。
- 本机真实推理冒烟已完成：临时项目文件内容正确、收到实际文件变更、继续对话和历史查询通过；无需执行 shell，因此该轮没有命令输出，不能将此写成真实命令输出验证。网页断线恢复、实际人工审批及经 Cloudflare 的完整访问，须以 `docs/verification.md` 中对应实测记录为准；适配器的订阅测试不等同于浏览器或 Tunnel 验证。

本应用不更改全局 Codex 配置、不自动登录或升级、不编辑 Codex 的内部数据库或 rollout 文件。恢复会话时由 Codex 的跨进程写入锁判定占用。已用本机 0.162.1 的两个独立进程验证 legacy、paginated 历史：持有写入权时，另一进程的 `thread/read` 可返回 `notLoaded`，而 `thread/resume` 返回 `-32600` 和 `thread <当前 ID> already has an active writer`；原进程退出后恢复成功。适配层严格匹配错误码、当前 ID 和完整错误文本，再映射为 `THREAD_IN_USE`；其他错误不推断为占用。未来版本若改变错误格式，会显示原始恢复错误，不冒充占用。旧客户端的 `confirmExternalStopped` 参数继续接受，但不再作为恢复前提。
