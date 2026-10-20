# Covro 发版

PR 标题检查、squash 提交信息与 Conventional Commits type 的约定见[开发与 PR 约定](contributing.md)。发布依据是 main 上最终提交的信息；标题检查本身不会触发版本递增。

正式版本由 `release-please-action` v5.0.0 管理，固定提交 `45996ed1f6d02564a971a2fa1b5860e934307cf7`。main 的 checks 成功后更新 Release PR；合并 Release PR 后生成版本标签、CHANGELOG 和 GitHub Release，并显式触发 npm 发布。首个正式版本是 0.1.0，由包配置的 `initial-version` 指定；首发前 `.release-please-manifest.json` 保持空对象，表示没有已经发布的版本。清单中的版本代表上次发行，不能预填目标版本。首个 Release PR 合并后由 release-please 自动记录版本，后续按 Conventional Commits 递增；`initial-version` 不会锁住后续发行。

首版 CHANGELOG 从完整 main 历史收集 Conventional Commits，默认包含 Features、Bug Fixes 等可发布条目。不设置 `bootstrap-sha` 或 `last-release-sha` 截断首发历史，确保项目早期功能也能进入首版说明；后续正式版按上次发行边界生成增量。修正首发配置后，先合并配置变更，等待 main 的 checks 和 release-please 完成并更新现有 Release PR，核对 CHANGELOG 的历史范围与版本号后再合并 Release PR。

源码 `package.json.version` 已预设为 `0.1.0`，因此首个 Release PR 可以只修改 CHANGELOG 与发布清单，package.json 没有版本差异属于正常情况。Dev/Beta 版本在构建发布包时写入临时工作区，不回写 main 的源码版本；后续正式版本递增时再由 release-please 更新 package.json。

## 版本与 Codex 兼容契约

Covro 使用独立 SemVer，首个正式版本为 0.1.0：兼容修复使用 `fix:` 升 patch；功能或新增 Codex 适配使用 `feat:` 升 minor。缩小 Codex 支持集合、提高运行要求等属于破坏性变更，使用 `feat!:` / `BREAKING CHANGE`；0.x 阶段升 minor（现有 `bump-minor-pre-major`），1.0 后升 major。上游发新版本不自动改变 Covro 的版本，也不自动扩大兼容声明。

`package.json.covroCodex` 定义推荐、已验证及明确不支持的 Codex 确切版本。改动后执行 `pnpm compat:sync`；发布准备与包验证会检查 README 双语声明、兼容文档和生成协议基线同步，缺失或冲突的声明无法发布。稳定版 GitHub Release 在创建后，从其确切标签读取 package.json 并追加兼容信息；重跑会替换自己的区块，保留其他发布说明。beta/dev 同样携带 npm 元数据和 README 声明。

## 渠道与触发

| 渠道   | npm 标签 | 触发方式                                                                                            |
| ------ | -------- | --------------------------------------------------------------------------------------------------- |
| stable | latest   | release-please 创建 GitHub Release 后发布确切标签                                                   |
| beta   | beta     | 手动推送 `vX.Y.Z-beta.N` 标签，或发布带此标签的 GitHub Release                                      |
| dev    | dev      | main 的 push 检查通过后自动发布当前 main；首发前为 `0.1.0-dev.N`，首发后为 `当前补丁版本 + 1-dev.N` |

所有发布从同一仓库的 main 历史取源码，检查确切 commit 的 `verify` 结果，再构建 npm 包。GitHub Release 稳定标签必须与 package.json 版本和 commit 一致；Dev 只发布执行时仍为 main HEAD 的提交，较旧 CI 迟到或重跑会跳过。已发布版本不可覆盖，同一源码已存在 Dev 快照时不再分配新号；稳定版和 Beta 的同版本重跑核对 commit 后跳过。

### Dev 序号与发布可见性

`N` 来自 npm 完整版本历史：在同一个 `X.Y.Z-dev` 基线下，取已发布版本的最大数字序号加一。它不依赖 CI ID 的大小，也不只读取 `dev` 标签，因此移动或删除标签不会使旧序号被重新使用。旧格式 `0.1.0-dev.39202054561.1` 的首个数字段 `39202054561` 计入下限，下一版为 `0.1.0-dev.39202054562`；下个版本基线可重新从 `dev.1` 开始。无法数值递增的 Dev 格式或超过 npm 安全整数比较范围的序号会阻止发版。CI 运行 ID 和尝试次数保存在 npm 元数据 `covroRelease` 中用于追溯。

publish 工作流按 stable、beta、dev 分开串行，自动 Dev 不会取消排队中的手动 Beta 或正式版。`npm publish` 被接受后，任务继续持有本渠道的发布位置，每 15 秒查询一次公共 registry，确认确切版本、源码 commit 和渠道标签都可见后才成功，让后续发版从已更新的历史取号。此阶段最多等待 20 分钟；npm 审查延迟、registry 不可用或标签未同步会使验证失败，不能据此认定包未发布。排查时先检查版本历史和标签，再重跑；不要覆盖旧版本或把序号改回更小的数字。若任务在发布后被取消或超时，npm 中尚未可见的版本可能仍在审查，应等待其状态确定后再重试，npm 的不可变版本约束会拒绝重复占号。

从 Dev 切到同基线的正式版时，SemVer 顺序为 `0.1.0-dev.N < 0.1.0`；正式版之后的 Dev 基线变为 `0.1.1-dev.N`，大于 `0.1.0`。自动发版不会绕过已有的更高渠道版本或无法确认的源码历史。

### 通过标签或 GitHub Release 发布 Beta

Beta 版本由维护者手动指定，首次可用 `v0.1.0-beta.1`，后续递增为 `v0.1.0-beta.2`。选取已经进入 main 且完整 `checks/verify` 通过的提交，推送一个新标签即可：

```sh
git tag -a v0.1.0-beta.1 <verified-main-commit> -m "Covro 0.1.0-beta.1"
git push origin refs/tags/v0.1.0-beta.1
```

也可以在 GitHub 的 Releases 页面创建并发布带同名 Beta 标签的 Release，建议标记为 prerelease。草稿不会发版；监听 `published`，因此从草稿发布的 prerelease 也能触发。版本及渠道由标签名决定，不读取 Release 标题或 `target_commitish`；普通 `vX.Y.Z` Release 不走此入口，正式版继续由 release-please 派发。

标签推送和 Release 发布都由 `publish.yml` 的 Beta 路由解析标签，支持轻量和附注标签，将剥离后的确切 commit 派发给 main 上的同一个 `publish.yml`。后者重新核对 main 祖先关系、确切 Beta 版本标签与源码一致、该提交的成功 verify，再执行原有构建、验证、OIDC 发布与可见性等待。npm Trusted Publisher 仍只需绑定 `publish.yml`；路由仅有 `contents: read` / `actions: write`，不获取 npm 发布身份。

推标签后再发布同一 Release 会产生相同版本、相同 commit 的请求，发布端核对身份后跳过重复版本。已经使用的标签不要移动或强推；每轮使用一个新 Beta 号，并等待本轮完成再发布下一轮。GitHub 并发组只保留一个等待任务，连续提交多轮请求可能替换较早的排队请求。

标签提交需要包含本入口的 workflow 配置，故首次应选择本改动合并后的 main 提交。更早的标签不会自动获得新的 GitHub 触发规则；维护者可从 main 上手工补发，但目标源码必须包含发布验证脚本，缺失会在上传前被拒绝：

```sh
gh workflow run publish.yml --repo yuzheng14/covro --ref main -f channel=beta -f version=0.1.0-beta.1 -f source_ref=refs/tags/v0.1.0-beta.1
```

补发也要求确切的 `v0.1.0-beta.1` 标签指向该源码。同版本同 commit 跳过，已占号的不同 commit 被拒绝；低于当前 Beta 渠道的版本不会回退标签。通过 `GITHUB_TOKEN` 在其他工作流中创建标签或 Release 不会自动引起后续普通事件，机器人发布应显式派发上述入口。

用户使用 `npm install -g @covro/covro@beta` 首装，或 `covro update --channel beta` 切换。同一基线下 SemVer 的 `beta` 排在 `dev` 前面，从当前 Dev 切到首个 Beta 需显式加 `--allow-downgrade`，仍受数据库兼容性检查约束。

开发版只对 main 生效，不发布 fork、PR 分支或未通过完整检查的提交。普通 PR 和 Stacked PR 继续只运行 checks。发布包同时包含 CLI、前后端、迁移与独立升级工作进程，内嵌 commit 和渠道；首次安装开发版会默认订阅开发渠道，已有渠道偏好保留。

## 触发排查

合并后先查看 main 的 `checks`。publish/release-please 监听 `checks` 的 `workflow_run: completed`，不在合并瞬间启动；只有同仓库 main push 的完整检查通过后才执行。PR 检查通过不能代替合并提交的检查。可以用 `gh run list --workflow checks.yml --branch main`、`gh run list --workflow publish.yml` 和 `gh run list --workflow release-please.yml` 查看各阶段。

- release-please 报 “GitHub Actions is not permitted to create or approve pull requests”：仓库 Settings → Actions → General 的 “Allow GitHub Actions to create and approve pull requests” 尚未开启。该设置包含审批能力，需维护者明确同意；工作流本身不批准或合并 PR。
- publish 到 npm 返回 E404：检查 `@covro/covro` 是否已由当前账号完成首次发布，以及该包的 Trusted Publisher 是否精确绑定本仓库和 `publish.yml`。OIDC 不替代首次建立包所有权的流程，也不需要把 npm token 发给协作者或写进仓库。完成下方配置后可重跑失败的 publish。
- Checks 失败、取消或仍在排队：先处理 checks，后续不会绕过验证发版。

## 一次性配置

产品和 CLI 仍叫 Covro / `covro`，npm 包固定为 `@covro/covro`。未加 scope 的 `covro` 被 npm 相似包名检查拒绝；发布、渠道查询、候选安装与回滚身份校验均使用 scoped 名称。

1. 在 npm 确认 `@covro/covro` 包所有权并完成首次发布。维护者账号需要已开启 2FA，并有 `@covro` scope 的发布权限；使用 `npm publish <已验证的tgz> --access public --tag dev` 完成首次开发版发布。首次发布属于实际公开发布，应在 PR 审查完成后由维护者使用自己的 npm 身份执行；本改动不会上传账号凭证。
2. 在 npm 包设置创建 GitHub Actions Trusted Publisher：owner `yuzheng14`、repository `covro`、workflow `publish.yml`。Environment 留空，并允许直接 `npm publish`。使用 GitHub hosted runner 和现有 Node 24 的 npm（OIDC 需要 npm >=11.5.1）；不新增长期 npm token。
3. 在仓库 Settings → Actions → General 允许 GitHub Actions 创建 PR。release-please 默认使用受限于该工作流的 GITHUB_TOKEN；也可配置已有的 `RELEASE_PLEASE_TOKEN`。不自动批准或合并 Release PR。
4. checks 提供 workflow_dispatch，release-please 会显式为生成的 PR 派发只读验证，避免依赖机器人 PR 的事件触发行为。稳定发布也显式派发 publish，不依赖 GITHUB_TOKEN 创建 Release 后的隐式事件。

首次发布、Trusted Publisher 绑定及权限设置需要 npm/GitHub 维护者完成；工作流未合并到 main 前，不执行真实发布。整个 Stack 的合并入口是栈顶 PR，所有层先审查并通过检查。

确认首次 npm 发布可以安装后，在同一个 PR 中移除 `README.md` 与 `README.zh-CN.md` 的“首发准备中”提示，并将 npm 安装移到主上手路径。

发布验证包括锁定依赖安装、生产启动检查和 npm 包文件白名单。`scripts/verify-package.ts` 确认 CLI、页面、迁移和升级工作进程均入包，并排除本地配置、数据库、测试和源码目录。`scripts/verify-upgrade.ts` 使用真实后台服务、升级工作进程与 SQLite，配合明确的本地 npm 分发夹具，验证成功切换、迁移后启动失败回滚、激活中断后的修复、仍在运行的旧服务修复，以及恢复写入后拒绝快照覆盖；候选包安装由夹具提供，不执行真实 npm 安装或发布。版本号与 commit 在构建前写入临时发布工作区，不回写开发分支。

参考：[release-please Action](https://github.com/googleapis/release-please-action)、[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)。
