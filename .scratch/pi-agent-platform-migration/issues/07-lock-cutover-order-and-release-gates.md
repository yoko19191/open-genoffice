# 锁定迁移切换顺序与发布门

Type: grilling

Status: resolved

Resolved after: 01, 02, 03, 04, 05, 06

## Question

在 MCP、Subagent、Codex OAuth 图片、Runtime sidecar、MinerU 和同步原型都给出结论后，
工程团队应按什么顺序切换 PDF、Docs、Sheets、Slides/Slide QC，并在哪些节点删除旧
Agent core、Provider 与 Genspark 路径？需要把各原型结论转成阶段入口/退出条件、功能
禁用口径、回滚边界和最终 Genspark-Free Build 发布门。

## Answer

最终顺序和质量门已固化到
[Pi Agent Platform 最终实施规则](../../../docs/superpowers/specs/2026-08-09-pi-agent-platform-implementation-rules.md)。

主线固定为基线/锁版本 → Sidecar/IPC → Session/模型/Resource Home →
Skills/Extensions/MCP/Subagent → PDF → Docs → Sheets → Slides/Slide QC → 共享旧层和
Genspark 删除 → 三平台发布。同步 Provider 在 Session/Project Store schema 固定后可并行，
但必须在共享旧层删除前合流。

每个应用先在开发构建完成 Pi 纵向切片和故障 E2E，再让生产入口只指向 Pi，并在进入下一
应用前删除该应用的旧 IPC、transport、AgentLoop 与 Genspark 能力入口。Slides 与 Slide
QC 原子切换。共享 `packages/agent-core` 和 `packages/ai-provider` 只有在最后一个应用通过
后删除；正式安装包不允许双运行时或 Genspark 回退。

运行时失败只禁用 Agent UI，图片协议失败只禁用图片，MinerU 失败保留原 PDF 且不降级，
同步失败保持本地 current，Slides 候选页失败保持原页。同包内没有旧 Runtime 回滚；唯一
回滚方式是安装上一版签名产物。

最终发布必须在 macOS、Windows、Linux 原生 runner 通过 Sidecar/MCP/Subagent 进程树
回收、签名/公证/installer、全验收矩阵、覆盖率、SBOM/license/notices、Genspark 静态与
网络清零。任一硬门失败即阻断发布，不设临时豁免。
