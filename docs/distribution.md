# Covro 安装与运行

Covro 通过 npm 分发已构建的前后端与数据库迁移，用户使用现有 Node.js 24.19.x 和已登录的 Codex。npm 包名为 `covro`；正式发布前还需完成 npm 包所有权和发布身份配置。

```sh
npm install -g covro
covro
covro status
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

配置、数据库和项目文件不存放在 npm 安装目录，更新 npm 包不会替换业务数据。开发源码继续使用 `pnpm dev`，生产源码仍可使用 `pnpm build` 和 `pnpm start -- --config ...`。
