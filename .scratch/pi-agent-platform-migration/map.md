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

- Codex OAuth 不能直连公开 Images API，但已实测可通过 ChatGPT Codex Responses 的
  `image_generation` 工具生成 `gpt-image-2` 图片；首版实现独立 Provider，禁止隐式计费
  回退（[票据 03](issues/03-validate-codex-oauth-image-contract.md)）。
- Subagent 固定为 Pi `0.84.0` 上的 `@agwab/pi-subagent@0.4.8` 执行引擎，由 GenOffice
  `SubagentProvider` 独占 lineage、预算、Mutation Grant、级联取消和目录隔离
  （[票据 02](issues/02-select-production-pi-subagent-integration.md)）。
- MCP 固定官方 `@modelcontextprotocol/client@2.0.0` + Pi inline Extension 薄桥；
  `pi-mcp-adapter@2.21.1` 因要求 Pi `0.84.1` 暂不采用
  （[票据 01](issues/01-select-production-pi-mcp-integration.md)）。
- Runtime Sidecar 固定为目标平台 Node `22.19.0` + `extraResources` 中 unpacked ESM
  bundle；macOS/arm64 与 Linux/arm64 glibc 完整实跑通过，Windows/x64 静态封装通过且
  必须补 `windows-2025` Named Pipe gate；不采用 SEA、`utilityProcess` 或系统 Node
  （[票据 04](issues/04-validate-runtime-sidecar-packaging.md)）。
- WebDAV/S3 固定共用内容寻址 revision store：immutable blob/revision + 单一 CAS
  `head.json`；冲突保持本地 current，用户选择后创建双 parent resolution revision；
  复用 `webdav@5.10.0` 与 `@aws-sdk/client-s3@3.1106.0`（[票据 06](issues/06-validate-shared-webdav-s3-revision-model.md)）。
- MinerU 固定以精准解析 Standard API 作为默认关闭的 PDF→DOCX OCR 服务；五类合成
  PDF 5/5 转换成功，但公式结构、原栏布局/页数、图内可搜索文字与扫描底图不属于首版
  保真承诺，Agent 轻量解析不得作为静默回退（[票据 05](issues/05-calibrate-mineru-docx-fidelity.md)）。
- 实施顺序固定为 Sidecar/Session/生态底座后，按 PDF → Docs → Sheets → Slides/Slide QC
  原子切换；每个应用切换后立即删除自身旧路径，最后删除共享 Agent/Provider/Genspark，
  只允许回滚到上一版签名安装包（[票据 07](issues/07-lock-cutover-order-and-release-gates.md)）。

## Not yet specified

六个实施前 Spike 与切换顺序均已关闭。剩余事项都是实施期验收证据，不再改变架构。

## Out of scope

- 在本地图内实现或发布迁移代码。
- 迁移旧聊天、旧 Provider 凭据或保留 Genspark 兼容层。
- 与 Pi CLI、Pi Web 共享 Resource Home 或 Session。
- 首版客户端端到端同步加密。
- 复制 Pi Web 的代码工作台、终端、Git worktree 或 PWA UI。
