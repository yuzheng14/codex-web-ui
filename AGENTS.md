# 协作约定

## UI 更改验证

- 任何涉及 UI 的更改，都必须使用 browser use 或 Playwright 打开实际页面，并对对应变更区域截图。
- 必须将截图贴到对应 PR 的评论（PR comment）中，便于评审者直接查看改动效果。

## Slash Command 实现追踪

- [Issue #69：Slash Command 完整支持矩阵与后续实现追踪](https://github.com/yuzheng14/codex-web-ui/issues/69) 是本项目 Slash Command 支持情况的统一追踪入口。
- 每次适配新的 Codex 版本时，核对该版本的 Slash Command 新增、删除、重命名、别名、参数、行为及可用条件变更，并同步更新 #69 的命令清单、版本依据和支持状态。
- 新增、修改或移除 Slash Command 相关功能时，同步更新 #69 的对应条目、实现范围、剩余缺口和 PR 链接；实现仍在 PR 中时注明待合并，合并后再更新已落地状态。
- 状态统一使用：✅ 已经完全实现、🟡 部分实现、⬜ 未实现、🚫 不考虑实现。已有类似 UI 或上游协议定义不代表 Slash Command 已实现；明确不做命令入口时记录原因。
