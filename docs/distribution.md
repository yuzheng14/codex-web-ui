# Covro 安装与运行

Covro 通过 npm 分发已构建的前后端与数据库迁移，用户使用现有 Node.js 24.19.x 和已登录的 Codex。npm 包名为 `@covro/covro`，命令为 `covro`；正式发布前还需完成 npm 包所有权和发布身份配置。

```sh
npm install -g @covro/covro
covro
covro status
covro doctor
covro logs
covro stop
covro run
covro service install
covro service uninstall
```

默认命令等同 `start`，后台启动后输出版本、进程、访问地址与配置位置，重复启动返回同一实例。`run` 在前台运行。安装 npm 包本身不启动进程、不创建登录项。

默认配置是 `~/.covro/config.json`，数据保存在该配置旁的 `data/`；`COVRO_HOME` 可调整应用管理目录。所有管理命令支持 `--config /absolute/path/config.json`，原来的配置文件及相对 dataDir 解析规则保持兼容。不同配置使用不同管理 socket，但同一 dataDir 仍受实例锁保护。

首次运行写入回环地址和空项目列表；在页面添加项目。CLI 不登录或升级 Codex，后台环境需要通过 `codex.binary` 指定 Codex 的绝对路径，并确保 PATH 包含项目使用的工具。

macOS 使用当前用户的 launchd，Linux 使用 `systemd --user`，`service install` 显式启用登录自启并启动服务。它记录当前 Node、CLI 的绝对路径及 PATH；移动 Node 安装后需要重新安装该服务。日志由 `covro logs` 显示末尾 64 KiB，外部日志轮转仍由运行环境管理。Windows 支持前台和后台运行，登录自启尚未提供。

<a id="macos-sessions-and-credentials"></a>

## macOS 会话与凭证诊断

有桌面登录会话时，默认后台启动使用 `gui/<uid>` 的临时 Aqua LaunchAgent。任务定义保存在当前实例状态目录，退出桌面会话后不会在下次登录自动启动；只有 `covro service install` 才会写入 `~/Library/LaunchAgents` 并启用登录自启。`covro stop` 正常关闭实例并卸载任务，但保留显式安装的登录项供下次登录使用。不同配置的任务与生命周期锁互相独立。

临时后台启动通过权限为 `0600` 的本地 socket 在内存中继承调用进程的环境和工作目录，启动完成即移除 socket，不把 `GH_TOKEN`、API key 等环境凭证写入 plist 或日志。登录自启没有可继承的终端环境，因此只记录 Node/CLI 绝对路径、`PATH`、`COVRO_HOME` 和已设置的 `CODEX_HOME`；其他环境配置应遵循原有系统服务的部署方式。升级、回滚和 `update repair` 复用相同启动逻辑；旧版已运行的实例需要在安装修复后执行一次 `covro stop` 和 `covro start`。

没有 GUI 登录会话时，未安装登录服务的实例仍可 headless 后台运行，但不保证能够读取桌面钥匙串。GUI 域查询或加载失败会直接报错，不会静默切换到另一种安全会话。登录服务需要桌面登录会话，不能作为系统启动前的 LaunchDaemon 使用。

`covro status` 的 `launchContext` 来自运行实例。`covro doctor` 同样通过私有控制 socket 在实例内部执行检查，而不是检查当前终端；它尝试读取 GitHub 凭证，并仅在读取成功后请求 `github.com/user`，不输出令牌、原始命令输出或账户资料：

| `result`                  | 含义与下一步                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `authenticated`           | 实例普通子进程的凭证读取与认证请求成功                                              |
| `credential-unavailable`  | 凭证读取失败；分别检查启动会话、钥匙串/沙箱访问和是否配置了凭证，尚不能判断令牌失效 |
| `authentication-rejected` | 凭证已读取，但 GitHub 返回 401；检查撤销、失效或环境变量覆盖                        |
| `request-forbidden`       | GitHub 返回 403；检查权限、组织策略或限额                                           |
| `request-failed`          | 凭证已读取，但网络、代理或服务请求未成功；不能据此判断令牌失效                      |
| `gh-unavailable`          | 运行实例的 `PATH` 中没有 GitHub CLI                                                 |

`credentialSource=stored` 表示读取 GitHub CLI 已保存的凭证，不区分钥匙串与内联配置；`environment` 表示设置了优先使用的 `GH_TOKEN` 或 `GITHUB_TOKEN`。macOS 的 `manager=Background` 等非 Aqua 值说明启动上下文可能限制钥匙串访问；它本身不证明钥匙串已锁定或令牌无效。

诊断结果的 `scope=daemon-child-process`、`sandbox=not-tested` 明确限定检查范围。Agent 和 Shell 继续使用 Codex 原有权限策略。若实例诊断成功，而只有受限命令读取失败，应继续检查该命令的实际沙箱与审批环境；不要通过关闭全局沙箱、保存明文令牌或反复登录来代替定位。关于原始复现与验证边界，见 [macOS 后台会话验证](macos-background-verification.md)。

配置、数据库和项目文件不存放在 npm 安装目录，更新 npm 包不会替换业务数据。开发源码继续使用 `pnpm dev`，生产源码仍可使用 `pnpm build` 和 `pnpm start -- --config ...`。

## 更新与发布渠道

首发成功后，开发渠道可用 `npm install -g @covro/covro@dev` 安装。

```sh
covro update status
covro update
covro update --channel dev
covro update --channel stable --allow-downgrade
covro update --allow-unverified-codex
covro update repair
```

稳定版、预览版、开发版分别解析 npm 官方 registry 的 `latest`、`beta`、`dev` 标签；解析后固定到确切版本安装，标签移动不会改变正在执行的升级目标。每 30 分钟检查一次；自动安装默认关闭，可从网页开启。失败的同一目标不会后台无限重试，可人工重试或等待下一版本。

升级前核对目标包的 Codex 兼容声明。自动安装仅接受已验证的确切组合；未知版本、缺失/无效声明及明确不支持的版本都会阻止升级。未验证组合需在网页明确勾选，或在 CLI 使用 `--allow-unverified-codex`；此选项只确认本次检查得到的 Codex 与目标 Covro，版本变化时必须重新检查。它不能绕过明确不支持或缺失声明，也不会自动升级全局 Codex。详情见[兼容声明](compatibility.md#发行版兼容声明)。

完整 CLI 与服务一起作为一个 npm 包发布。macOS/Linux 的 npm 全局安装支持受管升级：先将同一 npm 包安装到私有候选 prefix，检查入口与原生 SQLite 模块，再核对候选迁移是否覆盖当前已应用的完整历史。所有配置共用该 npm 安装时，需先停止其他实例。源码、容器、pnpm 全局等安装方式只展示版本检查和原部署方式提示；Windows 暂不提供受管自动升级。

候选准备期间旧版继续服务。升级等待所有受管任务、审批、输入、在途及待核对操作结束；同步关闭新操作入口后才停止服务。旧 npm 安装、SQLite 文件和配置快照保留在应用管理目录及 npm 包旁的私有备份目录。新版迁移和就绪验证期间拒绝业务写入，确认提交后才重新开放。启动失败会恢复旧安装及快照；确认响应丢失时先检查持久提交记录，不回退已开放写入的数据。Codex 历史与实际项目文件不参与应用数据库回退。

后台工作进程不依赖浏览器连接，升级进度与最终结果在重启后可读取。使用了登录自启的实例由原系统服务重新启动，普通后台实例由升级进程启动。若进程异常失联，等待陈旧锁释放后使用 `covro update repair`；备份不会被失败重试自动删除。数据库历史不兼容时拒绝降级，改用兼容版本或独立测试配置，不重建数据库。

若系统恰好在两次目录切换之间中断，npm 的 `covro` 入口可能暂时不可用。保留在应用管理目录中的独立工作进程仍可恢复；根据该安装的 `context.json` 确认目录后执行（自定义 `COVRO_HOME` 时替换路径）：

```sh
covro_update_dir="$HOME/.covro/updates/<安装ID>"
node "$covro_update_dir/worker.cjs" "$covro_update_dir" --repair
```

修复会验证备份身份并等待旧服务就绪。若服务已经恢复业务写入，会拒绝用旧快照覆盖现有数据，保留现场供检查。未完成激活且恢复失败的候选版本不能直接作为普通服务启动。

首版保留每次升级的安装与数据库备份，不自动轮转。确认新版本稳定后可清理不再需要的旧备份，保留最近一次以供修复；频繁使用开发渠道时需要自行管理这部分磁盘占用。
