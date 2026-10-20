# macOS 后台会话验证（#188）

验证日期：2026-10-20。环境：macOS 26.6.2 arm64、Node.js 24.19.0、Codex CLI 0.163.0、GitHub CLI 2.102.0。使用隔离配置、数据目录和测试任务；未停止已有用户实例、修改钥匙串条目或全局 Codex 配置，未输出或保存令牌。

## 启动上下文的最小对照

使用系统 Security.framework 的 `SessionGetInfo` 与 `SecKeychainGetStatus` 读取状态，并将 `gh auth token` 的输出仅保留在进程内判断是否可读。临时 launchd 任务执行后卸载，不写入登录自启目录。

| 场景                                             | manager    | 图形访问 | 钥匙串解锁位 | 凭证读取 / GitHub API |
| ------------------------------------------------ | ---------- | -------- | ------------ | --------------------- |
| 桌面会话的普通子进程                             | Aqua       | true     | true         | 成功 / 成功           |
| 桌面会话的 detached 子进程，父进程已退出         | Aqua       | true     | true         | 成功 / 成功           |
| 临时 user 域 Background 任务                     | Background | false    | false        | 失败 / 失败           |
| 该 Background 任务的 detached 子进程             | Background | false    | false        | 失败 / 失败           |
| 从 Background 任务 bootstrap 到 GUI 域的临时任务 | Aqua       | true     | true         | 成功 / 成功           |

因此没有将 `detached: true` 本身认定为根因。POSIX session 与 Security session 是不同概念，见 [Apple 会话说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/SystemContexts.html)。原 issue 中的历史实例最初为何进入 Background，仍未被此最小实验确定；本次修复通过明确选择 GUI 域避免继续继承该启动上下文。

## 修复后的真实执行

- 从临时 Background 任务调用构建后的 `covro start`：实例报告 `launchContext.manager=Aqua`，已有存储凭证可读，`doctor` 的 GitHub 请求返回 200。网络偶发超时时返回 `request-failed`，仍报告凭证已读，不误报令牌失效。
- 从真实 PTY（`stdin.isTTY=true`）启动后关闭终端，再由独立进程检查：实例 PID 不变、仍为 Aqua、凭证可读、GitHub 返回 200。
- 真实 Codex app-server 的 Shell `command/exec` 和 Agent `exec_command` 都执行了同一只读探测：只输出 manager、凭证是否可读、退出码及是否设置令牌环境变量；未将令牌写入 Shell/Agent 输出。
- 受限的只读配置中，两条执行路径均仍为 Aqua，但凭证读取失败。权限允许的独立测试配置中，两条路径均能读取原钥匙串凭证，且没有令牌环境变量。测试仅切换临时 `CODEX_HOME` 的配置，没有关闭全局沙箱。
- Agent 使用本地 HTTP Responses stub 返回确定性的工具调用；命令由真实 Codex 二进制执行，没有外部模型推理或配额消耗。此验证不评估模型自主选择工具的行为。

## 自动化回归

构建后，在已登录桌面的 macOS 上显式运行：

```sh
pnpm build
COVRO_TEST_LAUNCHD=1 pnpm exec vitest run tests/integration/covro-macos-live.test.ts
```

该测试使用模拟 `gh`，验证真实 launchd 与真实构建产物的并发启动去重、启动进程退出后的存活、私有环境和工作目录传递、多配置隔离、停止后重启、升级共用入口、重复安装/停止/恢复/卸载登录服务，以及数据保留。模拟凭证用于检查环境传递和日志保密；它不能替代前述真实钥匙串检查。默认测试集跳过此桌面测试，避免在 CI 或未登录桌面的环境中操作 launchd。

常规测试覆盖 GUI 缺失、查询权限失败、bootstrap 失败清理、登录注册保留、plist 转义、私有 socket、旧版入口的环境继承，以及凭证不可读、HTTP 401/403、网络失败、GitHub CLI 缺失和令牌不泄露。`scripts/verify-upgrade.ts` 使用真实 daemon/worker/SQLite 和本地 npm fixture，验证升级、失败回滚、中断恢复及 Codex 兼容性拒绝；测试结束时卸载临时 GUI 任务。

## 尚需人工验收的边界

没有注销或重启当前用户的桌面，也没有在真实无桌面登录状态下执行 headless 验证。需要在独立测试账号或维护窗口中确认：显式安装的登录项在重新登录后进入新 Aqua 会话并读取已解锁钥匙串；临时后台任务不在重新登录后自动启动。当前仅验证了登录项文件、GUI 域 bootstrap 和重复启停，没有把这些结果记作真实重新登录已通过。

钥匙串实际锁定、条目 ACL 拒绝或用户取消授权时，即使进程处于 Aqua 也可能无法读取凭证；`doctor` 仅报告读取结果与可能原因，不依据 manager 值断言钥匙串状态或令牌有效性。CLI 源码变更没有修改 Agent/Shell 的权限请求或 Web 界面。
