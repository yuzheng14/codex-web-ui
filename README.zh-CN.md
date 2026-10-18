<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/covro-logo-dark.svg" />
    <img src="docs/assets/covro-logo.svg" alt="Covro" width="266" height="64" />
  </picture>
</p>

<h1 align="center">你的 Codex，随处打开。</h1>

<p align="center">
  给电脑上的 Codex，一个浏览器工作台。<br />
  在桌前发起任务，用手机跟进进展，带着上下文继续工作。
</p>

<p align="center"><strong>自行部署 · 电脑与手机 · 沿用 Codex 登录 · MIT 开源</strong></p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#你可以做什么">功能介绍</a> ·
  <a href="#从其他设备访问">远程访问</a> ·
  <a href="README.md">English</a>
</p>

![Covro 桌面工作台：会话与 Markdown 文档并排阅读](docs/assets/workspace-desktop.png)

<p align="center"><sub>截图来自实际运行的应用，使用示例项目与测试夹具生成的会话。</sub></p>

## 你可以做什么

- **把多个项目放在眼前。** 在项目与会话间切换，让独立任务并行执行，随时知道哪些工作需要你处理。
- **接着已有的 Codex 工作。** 浏览历史、恢复会话、Fork 新方向，为会话命名，完成后归档。
- **保留你的控制权。** 查看工具活动与文件变更，处理权限审批，在浏览器中回答 Codex 的问题。
- **阅读时不丢上下文。** 查看 Markdown、表格、代码、图片和本地 Markdown 文档；电脑上分屏讨论，手机上全屏阅读。
- **带着工作上下文切换。** 每个会话分别保留当前页面中的草稿、粘贴图片和模型设置；完成后可以复制或导出结果。
- **方便地跟上新版本。** 选择稳定、预览或开发渠道，在网页检查和升级。受管升级会等待任务结束、重启服务，并沿用固定数据目录。

<details>
  <summary><strong>手机上也能舒服地使用</strong></summary>
  <p>查看结果、回答问题、补充下一步要求，不必每次都回到电脑前。</p>
  <img src="docs/assets/workspace-mobile.png" alt="手机屏幕上的 Covro 会话" width="320" />
</details>

## 开始使用

需要 **Node.js 24.x，版本不低于 24.19**，以及已经安装、登录的 **Codex CLI**。界面目前使用简体中文。

<!-- codex-compatibility:start -->

推荐 Codex CLI：**0.163.0**。已验证版本：`0.163.0`。

<!-- codex-compatibility:end -->

### 从源码运行

先准备好 **pnpm 12.11.2**：

```sh
git clone https://github.com/yuzheng14/codex-web-ui.git covro
cd covro
pnpm install --frozen-lockfile
cp config.example.json config.local.json
pnpm build
pnpm start -- --config ./config.local.json
```

打开 **<http://127.0.0.1:8787>**，点击 **添加项目**，填写运行 Covro 的电脑上的项目目录，然后打开会话或发送第一条任务。

本地开发可以改用 `pnpm dev`，打开 <http://127.0.0.1:5173>。

### npm 安装

首个公开 npm 版本正在准备中。`covro` 发布前，请使用上面的源码步骤；发布后可以运行：

```sh
npm install -g covro
covro
```

`covro` 默认在后台启动。关掉终端后，仍可继续通过浏览器工作。

| 命令                      | 用途                                 |
| ------------------------- | ------------------------------------ |
| `covro status`            | 查看运行实例与访问地址               |
| `covro logs`              | 查看最近的服务日志                   |
| `covro stop`              | 停止服务                             |
| `covro run`               | 在前台运行                           |
| `covro service install`   | 在 macOS 或 Linux 上主动启用登录自启 |
| `covro service uninstall` | 移除登录自启                         |

npm CLI 默认使用 `~/.covro/config.json`，数据目录固定在配置文件旁。可以通过 `covro --config /absolute/path/config.json` 沿用已有配置。

## 从其他设备访问

Covro 运行在你的电脑上，浏览器是操作入口。关闭页面不会取消任务；重新打开后会连接到服务。运行服务的电脑需要保持唤醒并在线。

| 使用方式                      | 连接方法                                                 |
| ----------------------------- | -------------------------------------------------------- |
| 在运行服务的电脑上            | 打开本机地址                                             |
| 通过 Tailscale 访问自己的设备 | 配置 Tailscale Serve，并将 HTTPS 地址加入 `publicOrigin` |
| 通过 Cloudflare 访问          | 使用 Tunnel、Cloudflare Access 及 Covro 的 JWT 校验      |

完整配置见[部署指南](docs/deployment.md)。新安装默认只监听回环地址，远程访问需单独配置。在手机上添加项目时，填写的仍是运行服务的电脑上的目录。

## 更新与版本渠道

点击侧栏的 **Covro**，可以检查版本、选择渠道、启用空闲时自动升级，或一键升级并重启。CLI 使用同一个升级引擎：

```sh
covro update status
covro update
covro update --channel dev
```

| 渠道   | npm 标签 | 适合                        |
| ------ | -------- | --------------------------- |
| 稳定版 | `latest` | 日常使用                    |
| 预览版 | `beta`   | 维护者选定的预览版本        |
| 开发版 | `dev`    | CI 通过后的 main 分支新功能 |

每个发行版声明推荐和已验证的 Codex CLI 版本，更新面板会同时显示当前与目标组合。自动升级只接受已验证组合；未验证组合需要对确切目标明确确认。版本未知、声明缺失/无效或明确不支持的组合会阻止受管升级。CLI 可通过 `covro update --allow-unverified-codex` 明确尝试同一组合。Covro 不会自动升级你的 Codex CLI。

自动安装默认关闭。受管升级支持 **macOS 和 Linux 的 npm 全局安装**；源码、链接、容器和 Windows 安装沿用原更新方式。候选版本失败时，会在重新开放业务写入前回滚；降级需通过数据库兼容检查。旧备份会保留，暂不自动轮转。

详细说明见[分发与恢复](docs/distribution.md)、[发版操作](docs/releases.md)。

## 你的电脑，你的工作台

Covro 是围绕已有 Codex 环境构建的单用户应用。代码通过 `codex app-server` 在运行服务的电脑上执行。项目与 Codex 历史留在那里；Covro 使用 SQLite 保存自身的项目注册和操作记录。它不提供单独的托管账号，也不会把 Codex 登录信息复制到浏览器。Codex 本身仍会访问你配置的模型提供方。

浏览器用于跟进工作、处理请求和继续对话。交互终端、文件编辑器、Git 图形界面与多人团队管理不在当前范围内。

## 开发与参与

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

浏览器测试需要现有 Playwright 依赖所对应的 Chromium。测试与 CI 使用明确的测试夹具，不发起真实模型请求。

遇到问题或有想法，欢迎[提交 Issue](https://github.com/yuzheng14/codex-web-ui/issues)，附上操作系统、Node.js 与 Codex 版本、安装方式和复现步骤。也欢迎范围明确的小 PR。修改面向使用者的事实或安装步骤时，请同步更新 `README.md` 和 `README.zh-CN.md`。

## 文档导航

| 指南                                 | 内容                                 |
| ------------------------------------ | ------------------------------------ |
| [详细使用指南](docs/usage.zh-CN.md)  | 项目、会话、审批、通知、图片和恢复   |
| [部署](docs/deployment.md)           | 本机、Tailscale 与 Cloudflare Access |
| [分发](docs/distribution.md)         | CLI、服务、数据位置、升级与修复      |
| [兼容性](docs/compatibility.md)      | 已验证的 Codex 版本与行为边界        |
| [Slash 命令](docs/slash-commands.md) | 支持的命令和用法                     |
| [架构](docs/architecture.md)         | 网关、Codex 适配器与浏览器的协作方式 |
| [验证记录](docs/verification.md)     | 测试范围与真实环境检查记录           |
| [品牌素材](docs/brand.md)            | 可编辑的 SVG 图标与完整标识          |

## 许可证

[MIT](LICENSE)。Covro 是独立项目，与 OpenAI 无隶属关系。
