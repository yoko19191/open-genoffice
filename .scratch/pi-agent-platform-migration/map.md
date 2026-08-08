# Pi Agent Platform 迁移决策地图

## Destination

形成一份工程团队可以直接据此实施的、决策闭合的迁移规格：Pi AgentSession 是唯一
运行时，MCP、Skills、Subagent、同步和 Office 能力均有固定实现边界与可验证发布门。

## Notes

- 本地图只解决实施前的剩余决策和高风险事实，不承载业务代码实施。
- 领域语言以 [`CONTEXT.md`](../../CONTEXT.md) 为准。
- 架构与验收以[迁移规格](../../docs/superpowers/specs/2026-08-07-pi-agent-platform-migration.md)
  和 [`docs/adr`](../../docs/adr/) 为准。
- 固定边界包括：唯一 Pi Runtime、随 Electron 管理的 sidecar、一个 Session 对应一个
  Office 文档、Genspark-Free Build、默认只读 Subagent、WebDAV/S3、Global Asset
  同步和 `~/.open-genoffice` Resource Home。
- 研究应优先复用 Pi 上游或生态 Package；不得以第二运行时或 Genspark 服务回退。
- 所有候选依赖必须记录精确版本、许可证、维护状态、权限面、网络/子进程行为与打包结果。

## Decisions so far

<!-- 决策票据关闭后，只在这里追加一行摘要和链接。 -->

## Not yet specified

- MCP/Subagent 候选固定后，是否需要单独的兼容层版本策略与上游升级节奏。
- Sidecar 和同步原型完成后，三平台故障恢复指标及压力基线如何量化。
- MinerU 样本评估后，哪些 PDF 类型需要明确标注“不保证版式保真”。

## Out of scope

- 在本地图内实现或发布迁移代码。
- 迁移旧聊天、旧 Provider 凭据或保留 Genspark 兼容层。
- 与 Pi CLI、Pi Web 共享 Resource Home 或 Session。
- 首版客户端端到端同步加密。
- 复制 Pi Web 的代码工作台、终端、Git worktree 或 PWA UI。
