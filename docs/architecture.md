# 架构与 review 边界

浏览器以 HTTP 提交操作，以 WebSocket 接收有界事件流；网关持续持有一个 Codex 子进程。浏览器断线只删除连接订阅。没有任意上游 RPC 透传接口。

| 层       | 位置                                          | 责任                                                 |
| -------- | --------------------------------------------- | ---------------------------------------------------- |
| 应用合同 | `src/shared`                                  | 浏览器可用 DTO、请求校验、统一错误                   |
| 上游适配 | `src/codex`                                   | CLI 生成协议、UTF-8 JSONL、RPC、握手、活动与审批映射 |
| 持久化   | `src/server/db`、`drizzle`                    | Drizzle 同步事务、唯一操作 ID、执行占用、迁移        |
| 领域服务 | `projects`、`service`、`projection`、`events` | 路径归属、任务协调、状态投影、人工请求、恢复         |
| 网络入口 | `config`、`auth`、`http`、`websocket`、`main` | 校验、Access、静态产物、连接上限、生命周期           |
| 浏览器   | `src/web`                                     | HTTP、按会话恢复、持久操作引用、视图与交互           |

派发 turn 前，操作记录与执行标记在同一短 SQLite 事务中提交；提交后才写上游。数据库事务中没有 await。操作 ID 冲突走唯一约束，内容摘要不同拒绝；相同内容返回原记录。超时或退出后不重发原 prompt。

执行标记保留启动操作 ID、threadId、turnId、workspaceKey、codexEpoch。真实终态释放对应标记；人工核对只解除原标记，不能解除后来任务。RPC 回执和任务终态分别处理。

投影按上游 thread/turn/item ID 合并。完整 item 替换内容，增量按顺序追加。快照、订阅注册及补发在一个同步边界内完成；服务端单调序号与 serverEpoch 构成恢复游标。前端仅为仍持有同会话投影的连接发送 after，刷新不复用单独残留游标。全局运行状态与会话游标分开跟踪。

`GET /api/projects/:projectId/threads` 返回分页会话摘要与读取开始时的事件游标。摘要只包括身份、项目、标题、来源、状态、更新时间、待处理数量及最后一轮状态，不包含正文、工具内容或审批参数；原有会话列表与详情 API 保持不变。`/ws?overview=1` 显式订阅跨项目摘要变化，普通 `/ws` 维持原有消息合同。摘要使用独立监听通道，不占详情重放缓存，重连后由 HTTP 列表恢复；详情仍只订阅当前会话。`unsubscribe` 清理详情订阅，保留运行状态和已启用的摘要订阅。

Git checkout 根目录决定工作区互斥，不使用 git common-dir，因此不同 worktree 可以并行。此锁只约束本网关，不阻止用户在终端改文件。

`POST /api/threads/:threadId/fork` 接受 `{ clientOperationId, settings? }`，返回标准操作回执，成功结果为 `{ threadId, forkedFromId }`。服务端只读源会话并校验注册项目归属，再将其 canonical cwd 交给适配层调用 `thread/fork`；客户端不能指定目录。新 ID 注册为当前进程持有的会话，历史由 Codex 保存，无需新增数据库表。

Fork 可以用于外部、运行中或结果未知的会话，不要求先完成原会话交接，也不会 resume、interrupt 或解除原执行标记。新会话使用原目录，后续发送任务仍经过同一 checkout 的互斥检查。省略 `lastTurnId` 复制当前已保存历史；不提供指定历史位置或创建 worktree 的功能。相同操作 ID 去重；上游 Fork 成功但历史加载失败时保留 `unknown`，错误详情包含已知的新 ID，不自动重发。

评审顺序按照提交链由基础合同、真实生成协议、传输适配、持久化、协调服务、网络安全到浏览器与交付。生成文件单独成层，GitHub 将其标记为 generated；人工代码按职责分层评审。使用 GitHub 原生 Stacked PR 关联依赖，按栈底向上合并。
