# macOS 部署：Tailscale Serve 与 Cloudflare Tunnel

先完成本机生产构建和真实链路验证，再配置外部入口。本文提供用户执行步骤；项目不会配置 Tailscale、创建 Cloudflare 资源、登录账户、改全局 Codex 配置或加载系统服务。

## 本机与 Tailscale Serve 同时访问

在 `config.local.json` 中保留实际项目等配置，将监听地址与允许的访问地址设置为：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicOrigin": [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "https://your-machine.your-tailnet.ts.net"
  ],
  "auth": { "mode": "local" }
}
```

将示例 HTTPS 地址替换为自己的 Tailscale Serve 地址。`publicOrigin` 直接使用数组，即使只有一个地址也需要方括号；每项是完整 origin，不包含路径。数组只控制允许访问的地址，`host` 和 `port` 仍决定服务实际监听位置。

构建并启动生产服务后，运行：

```sh
tailscale serve --bg 8787
```

Serve 默认提供 HTTPS 入口并转发到本机 `http://127.0.0.1:8787`；首次启用时按 CLI 提示完成 HTTPS 设置。用命令输出的 HTTPS 地址更新数组并重启应用，然后可从本机地址或已连接 Tailscale 的设备访问。页面、API 和 WebSocket 共用同一入口。[Serve 官方说明](https://tailscale.com/docs/reference/tailscale-cli/serve)

`local` 模式不增加应用登录，访问身份由 tailnet 的访问策略控制；地址白名单本身不提供身份认证。公网入口使用下面的 Access 配置。

若出现 `INVALID_HOST`，检查浏览器地址的主机和端口是否已列入 `publicOrigin`；若写操作或 WebSocket 出现 `INVALID_ORIGIN`，还需检查协议是否一致。改配置后需重启应用，生产代码变更后先重新 `pnpm build`。

## 固定 Cloudflare Tunnel

1. 在 Cloudflare Zero Trust 创建 self-hosted Access 应用，域名例如 `codex.example.com`，覆盖该域名的所有路径。策略只允许你自己的身份。记录应用 AUD 与团队 issuer `https://<team>.cloudflareaccess.com`。先验证 Access 策略，再发布 Tunnel 路由。[官方步骤](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. 在私人电脑配置一个固定的命名 Tunnel。将 [cloudflared.example.yml](deploy/cloudflared.example.yml) 中 Tunnel UUID、凭据绝对路径和域名替换为实际值；源服务为 `http://127.0.0.1:8787`。在 DNS 将该域名路由至该 Tunnel。需要的创建/登录/路由命令通过 Cloudflare 官方界面或 CLI 由你执行。
3. 参考 [Access 配置](deploy/config.access.example.json) 设置 `publicOrigin` 数组、issuer、audience、Codex 绝对路径和项目路径。所有入口必须为 HTTPS，页面/API/WS 必须使用同一个 Access 应用，配置多个域名时均需受该应用保护。不要填 service token 到前端。
4. 运行生产服务，然后按已有 Tunnel 配置启动 cloudflared。可额外启用 cloudflared 的 Protect with Access；网关始终独立校验 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience、exp 与 nbf，JWKS 地址只能来自配置的团队域名。[JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
5. 未登录访问应进入 Access 登录；无 JWT 的直接业务请求应失败。登录后检查项目列表、真实小任务、审批、关闭页面后重开以及 WSS 断线重连。Access JWT 到期会断开 WS；重新登录再连接，任务不取消。

Cloudflare 可能关闭长连接，客户端会退避重连并恢复状态。[WebSockets](https://developers.cloudflare.com/network/websockets/)。Quick Tunnel 域名可变化，不作为固定入口部署验收。[Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 可选 launchd 用户服务

[示例 plist](deploy/com.example.codex-web-ui.plist) 只启动构建产物。替换 Node、项目、配置、日志等所有绝对路径；确认目录存在并可写，再按 macOS 的 launchd 用户服务流程安装/加载。应用不自动执行这些系统操作。

后台服务不会加载 shell 启动文件。通过 `codex.binary` 指定真正的 CLI 路径，配置 PATH 以找到 Git 与项目工具；必要时显式设置子进程 `codex.home`。保留当前用户权限，不以 root 运行。标准日志需配置轮转，建议保留七天并限制总量；应用本身不将令牌、环境或 Codex stderr 写到日志。

实例锁每两秒更新，十秒后可判断异常退出的陈旧锁。不要手工删除正在运行实例的锁，也不要按保存的 PID 杀进程。停止服务会先拒绝新操作、关闭 WebSocket、持久化未确定状态，并仅结束其创建的子进程。

### Codex 大历史响应与连接恢复

`codex.maxLineBytes` 控制 Codex 子进程 stdout 单条 JSONL 消息的字节上限，默认 64 MiB（`67108864`），允许配置 1 KiB 至 256 MiB；它与 `limits.itemBytes/eventBytes/wsBytes` 独立。分页历史先读取 turn 摘要，再按每页 20 个条目读取内容；恢复会话使用 `excludeTurns: true`，随后单独加载历史。旧格式历史仍需要完整读取，因此保留较大的有界消息上限。

运行中的 Codex 连接失败后，网关会结束旧子进程并自动重新初始化，重启失败时从 1 秒退避到最多 30 秒；主动停止服务不会触发重启。待处理请求仍返回结果不确定，网关不会重发任务或审批。恢复连接后重新打开会话确认任务状态。超限诊断包含已接收字节数、上限以及当时待处理请求的方法和 ID，不记录请求参数、响应或完整会话内容；待处理列表不代表已确认哪个请求触发了超限。

电脑需保持可工作状态。睡眠、电源管理、登录项及 Tunnel 常驻方式由用户决定，此项目不修改系统设置。
