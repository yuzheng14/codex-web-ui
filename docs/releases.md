# Covro 发版

正式版本由 `release-please-action` v5.0.0 管理，固定提交 `45996ed1f6d02564a971a2fa1b5860e934307cf7`。main 的 checks 成功后更新 Release PR；合并 Release PR 后生成版本标签、CHANGELOG 和 GitHub Release，并显式触发 npm 发布。开发基线是 0.1.0，只纳入 bootstrap commit 之后的 Conventional Commits。

## 渠道与触发

| 渠道   | npm 标签 | 触发方式                                                                   |
| ------ | -------- | -------------------------------------------------------------------------- |
| stable | latest   | release-please 创建 GitHub Release 后发布确切标签                          |
| beta   | beta     | 手工运行 publish，指定已验证的 main commit 和 `X.Y.Z-beta.N`               |
| dev    | dev      | main 的 push 检查通过后，自动发布 `当前补丁版本 + 1-dev.CI运行ID.重跑次数` |

所有发布从同一仓库的 main 历史取源码，检查确切 commit 的 `verify` 结果，再构建 npm 包。GitHub Release 稳定标签必须与 package.json 版本和 commit 一致；开发标签不会因较旧 CI 迟到而退回旧源码。已发布版本不可覆盖，同版本重复运行会核对 commit 后跳过。

```sh
gh workflow run publish.yml --ref main -f channel=beta -f version=0.2.0-beta.1 -f source_ref=main
```

开发版只对 main 生效，不发布 fork、PR 分支或未通过完整检查的提交。普通 PR 和 Stacked PR 继续只运行 checks。发布包同时包含 CLI、前后端、迁移与独立升级工作进程，内嵌 commit 和渠道；首次安装开发版会默认订阅开发渠道，已有渠道偏好保留。

## 一次性配置

1. 在 npm 确认 `covro` 包所有权并完成首次发布。首次发布属于实际公开发布，应在 PR 审查完成后由维护者使用自己的 npm 身份执行；本改动不会上传账号凭证。
2. 在 npm 包设置创建 GitHub Actions Trusted Publisher：owner `yuzheng14`、repository `codex-web-ui`、workflow `publish.yml`。使用 GitHub hosted runner 和现有 Node 24 的 npm（OIDC 需要 npm >=11.5.1）；不新增长期 npm token。
3. 在仓库 Settings → Actions → General 允许 GitHub Actions 创建 PR。release-please 默认使用受限于该工作流的 GITHUB_TOKEN；也可配置已有的 `RELEASE_PLEASE_TOKEN`。不自动批准或合并 Release PR。
4. checks 提供 workflow_dispatch，release-please 会显式为生成的 PR 派发只读验证，避免依赖机器人 PR 的事件触发行为。稳定发布也显式派发 publish，不依赖 GITHUB_TOKEN 创建 Release 后的隐式事件。

首次发布、Trusted Publisher 绑定及权限设置需要 npm/GitHub 维护者完成；工作流未合并到 main 前，不执行真实发布。整个 Stack 的合并入口是栈顶发版 PR，所有层先审查并通过检查。

发布验证包括锁定依赖安装、生产启动检查和 npm 包文件白名单。`scripts/verify-package.ts` 确认 CLI、页面、迁移和升级工作进程均入包，并排除本地配置、数据库、测试和源码目录。`scripts/verify-upgrade.ts` 使用真实后台服务、升级工作进程与 SQLite，配合明确的本地 npm 分发夹具，验证成功切换、迁移后启动失败回滚、激活中断后的修复、仍在运行的旧服务修复，以及恢复写入后拒绝快照覆盖；候选包安装由夹具提供，不执行真实 npm 安装或发布。版本号与 commit 在构建前写入临时发布工作区，不回写开发分支。

参考：[release-please Action](https://github.com/googleapis/release-please-action)、[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)。
