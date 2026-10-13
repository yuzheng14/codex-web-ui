# macOS 与固定 Cloudflare Tunnel

先完成本机生产构建和真实链路验证，再配置外部入口。本文提供用户执行步骤；项目不会创建 Cloudflare 资源、登录账户、改全局 Codex 配置或加载系统服务。

1. 在 Cloudflare Zero Trust 创建 self-hosted Access 应用，域名例如 `codex.example.com`，覆盖该域名的所有路径。策略只允许你自己的身份。记录应用 AUD 与团队 issuer `https://<team>.cloudflareaccess.com`。先验证 Access 策略，再发布 Tunnel 路由。[官方步骤](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. 在私人电脑配置一个固定的命名 Tunnel。将 [cloudflared.example.yml](deploy/cloudflared.example.yml) 中 Tunnel UUID、凭据绝对路径和域名替换为实际值；源服务为 `http://127.0.0.1:8787`。在 DNS 将该域名路由至该 Tunnel。需要的创建/登录/路由命令通过 Cloudflare 官方界面或 CLI 由你执行。
3. 参考 [Access 配置](deploy/config.access.example.json) 设置 `publicOrigin`、issuer、audience、Codex 绝对路径和项目路径。页面/API/WS 必须使用同一个 Access 应用与域名。不要填 service token 到前端。
4. 运行生产服务，然后按已有 Tunnel 配置启动 cloudflared。可额外启用 cloudflared 的 Protect with Access；网关始终独立校验 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience、exp 与 nbf，JWKS 地址只能来自配置的团队域名。[JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
5. 未登录访问应进入 Access 登录；无 JWT 的直接业务请求应失败。登录后检查项目列表、真实小任务、审批、关闭页面后重开以及 WSS 断线重连。Access JWT 到期会断开 WS；重新登录再连接，任务不取消。

Cloudflare 可能关闭长连接，客户端会退避重连并恢复状态。[WebSockets](https://developers.cloudflare.com/network/websockets/)。Quick Tunnel 域名可变化，不作为固定入口部署验收。[Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 可选 launchd 用户服务

[示例 plist](deploy/com.example.codex-web-ui.plist) 只启动构建产物。替换 Node、项目、配置、日志等所有绝对路径；确认目录存在并可写，再按 macOS 的 launchd 用户服务流程安装/加载。应用不自动执行这些系统操作。

后台服务不会加载 shell 启动文件。通过 `codex.binary` 指定真正的 CLI 路径，配置 PATH 以找到 Git 与项目工具；必要时显式设置子进程 `codex.home`。保留当前用户权限，不以 root 运行。标准日志需配置轮转，建议保留七天并限制总量；应用本身不将令牌、环境或 Codex stderr 写到日志。

实例锁每两秒更新，十秒后可判断异常退出的陈旧锁。不要手工删除正在运行实例的锁，也不要按保存的 PID 杀进程。停止服务会先拒绝新操作、关闭 WebSocket、持久化未确定状态，并仅结束其创建的子进程。

电脑需保持可工作状态。睡眠、电源管理、登录项及 Tunnel 常驻方式由用户决定，此项目不修改系统设置。
