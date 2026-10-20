# Clone a project / 克隆项目

In **添加项目** (Add project), choose **克隆 Git 仓库** (Clone Git repository). Enter an HTTPS or SSH Git address, an absolute destination directory on the computer running Covro, and an optional project name. The destination's parent must already exist and be writable. The destination must be absent or an empty ordinary directory; nonempty directories, files and destination symlinks are refused. Existing project imports remain available under **已有目录** (Existing directory).

在「添加项目」中选择「克隆 Git 仓库」，填写 HTTPS 或 SSH 仓库地址、运行 Covro 的主机上的绝对目标目录和可选名称。父目录须已存在且可写；目标须不存在或为空的普通目录，不接受非空目录、文件或目标符号链接。已有本地项目仍通过「已有目录」添加。

## Git and authentication / Git 与认证

- Git must be installed and available in the **service's PATH**, which can differ from your terminal's PATH. Covro invokes Git directly on the host, independently of the Codex agent sandbox.
- HTTPS, `git@host:owner/repository.git`, and `ssh://git@host:port/owner/repository.git` are supported. HTTP, local/file URLs, Git remote helpers, URL passwords/tokens and query parameters are rejected.
- Configure the service user's existing Git credential helper or SSH keys first. Cloning does not prompt for passwords or accept new SSH host keys; configure host trust on the host beforehand. It inherits Git configuration and credential helpers; it does not use or copy Codex model-provider credentials.
- The UI exposes only recognized progress stages and fixed error messages. Raw Git output and repository URLs are not saved in Covro's project configuration or job history. Git itself records the remote in the checkout's `.git/config` as usual.

- 主机须安装 Git，且**服务的 PATH** 能找到它；后台服务与终端的 PATH 可能不同。克隆直接在主机运行，与 Codex Agent 的沙箱独立。
- 支持 HTTPS、`git@host:owner/repository.git` 和 `ssh://git@host:port/owner/repository.git`；不接受 HTTP、本地/file 地址、Git remote helper、URL 密码/令牌和查询参数。
- 请先为运行服务的用户配置 Git 凭据助手或 SSH 密钥。克隆不进行密码交互，也不会接受新的 SSH 主机密钥；请提前在主机配置 SSH 信任。沿用已有 Git 配置和凭据助手，不读取或复制 Codex 模型服务凭据。
- 页面只显示识别出的进度阶段和固定错误提示，不在 Covro 项目配置或任务记录中保存原始 Git 输出和仓库地址。Git 仍按其通常行为在检出目录的 `.git/config` 中记录远程地址。

## Progress, cancellation and recovery / 进度、取消与恢复

- Progress reports the current Git stage and its percentage when available. The percentage belongs to that stage, rather than the entire clone. Each clone has a 30-minute limit; at most four run at once. The same destination, its aliases, and overlapping active clone directories are locked against concurrent imports/clones.
- Closing or refreshing the browser does not cancel a clone. Reopen Add project → Clone Git repository in the same tab to recover its status. Click **取消克隆** to stop Git; a project is registered only after Git exits successfully. An application update waits for active clones to finish or be cancelled; stopping the service cancels them.
- Failed or cancelled clones are not registered. Covro does not delete leftover files. Inspect the displayed destination on the host, then retry with another absent/empty directory; do not import an incomplete checkout as a usable project.
- If cloning succeeds but registration fails, **重试添加项目** retries registration using that checkout without cloning again. You can also add its directory through Existing directory. After success, click **打开项目** to select it and start a conversation.
- Job records are transient: up to 100 recent jobs per service instance. After a service restart or an expired record, inspect the destination first. Add it through Existing directory only if cloning finished; otherwise retry into another absent/empty directory. Registered projects remain in SQLite across restarts.

- 进度显示 Git 当前阶段及其可用的百分比，百分比只代表该阶段。每次最多运行 30 分钟，同时最多克隆四个仓库。同一目标、路径别名及重叠的活动克隆目录不能并发导入或克隆。
- 关闭或刷新浏览器不会取消克隆。同一标签页重新打开「添加项目 → 克隆 Git 仓库」可核对状态；点击「取消克隆」停止 Git。仅在 Git 成功退出后注册项目。升级会等待活动克隆完成或取消，停止服务会取消活动克隆。
- 失败或取消不会注册项目，Covro 不删除残留文件。请先在主机检查显示的目标目录，再换一个不存在或为空的目录重试；不要将未完成的检出目录当作可用项目导入。
- 克隆成功但注册失败时，「重试添加项目」复用检出目录，只重试注册；也可切换「已有目录」添加。成功后点击「打开项目」，即可选中并开始会话。
- 克隆记录仅存在于当前服务实例内，最多保留最近 100 条。服务重启或记录过期后，先检查目标：确认克隆已完成再通过「已有目录」添加，否则换一个不存在或为空的目录重试。已注册项目仍持久保存在 SQLite 中。

## Verification / 验证

Integration and browser tests use a test-only transport wrapper to clone a real local Git repository through accepted HTTPS/SSH address forms. They cover directory conflicts, aliases, duplicate requests, progress/reload/cancellation, missing Git, authentication errors, and registration retry. They do not authenticate to a live private remote or validate a user's credential helper.

集成与浏览器测试通过仅测试使用的传输包装器，将合法 HTTPS/SSH 地址映射到真实本地 Git 仓库执行克隆，覆盖目录冲突、别名、重复请求、进度/刷新/取消、缺少 Git、认证错误和注册重试；不连接真实私有仓库认证，也不验证用户的凭据助手。
