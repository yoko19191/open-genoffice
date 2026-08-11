# Pi Agent Platform 端到端实施 Goal Prompt

将下面整个 Prompt 复制到一个新的 Codex 窗口。它授权新窗口创建实施分支、发布已批准的
Issues、按纵向切片提交并推送代码，以及在完成全部发行门后创建 ready-for-review PR；不授权
合并 PR、推广 stable release、使用真实付费服务或上传用户文件。

```text
你在本地仓库 /Users/guchen/repo_fork/open-genoffice 中工作。请创建并持续执行一个 Goal：

将 Open GenOffice 从现有自研 Agent/Genspark 路径完整迁移到唯一的 Pi Agent Runtime，交付
MCP、Skills、Packages、Subagent、用户配置模型、Codex OAuth 图片、可选 MinerU OCR、
WebDAV/S3 同步、四个 Office 应用切换和三平台安装包验收。只有所有已冻结验收门都满足、
旧 Agent/Genspark 生产路径全部删除、实施分支已推送且 ready-for-review PR 已创建时，Goal
才算完成。

第一步调用 create_goal，objective 使用上面这段目标，不设置 token budget。随后维护一个
可执行 plan；上下文压缩或单次会话结束不改变 Goal，继续从仓库、Issue 和证据文件恢复。

## 权威输入

开始编辑前完整读取仓库 AGENTS.md，然后按以下顺序读取：

1. docs/superpowers/specs/2026-08-09-pi-agent-platform-implementation-rules.md
2. docs/pi-agent-platform/README.md 与 01～07 七份执行文档
3. CONTEXT.md
4. docs/adr/0001～0017
5. docs/superpowers/specs/2026-08-07-pi-agent-platform-migration.md

冲突时按 AGENTS.md → 最终实施规则 → 执行文档 → ADR → 迁移规格的顺序处理。早期 research、
.scratch 原型和聊天记录只可作为证据线索，不能覆盖已经冻结的契约。遇到真正的契约冲突时
停止修改，指出冲突的两个精确位置并请求用户决定。

## 已授权操作

- 获取 origin 最新状态，从 origin/features/pi-agent-platform-migration-spec 创建并推送
  features/pi-agent-platform-implementation；若分支已存在则安全接续，不覆盖他人提交。
- 安装仓库依赖，创建/修改/删除本迁移范围内的源码、测试、fixture、构建和文档文件。
- 使用 gh 发布文档 04、06、07 中已批准但尚未发布的 OT-I01～OT-I08、QA-I01～QA-I04、
  PK-I01～PK-I06；发布前读取 #1～#26，避免重复，按真实 Issue 编号回写执行文档。
- 按纵向切片运行测试、生成脱敏验收证据、创建中文 conventional commits，并在每个 gate
  通过后推送实施分支。
- 在全部门禁通过后创建 ready-for-review PR；不得自行合并或推广 beta/stable。

保留工作区中与本 Goal 无关的用户改动，不 restore、reset、重排或顺手重构它们。删除仅限
冻结文档明确列出的旧 Agent/Genspark 路径和由当前改动产生的死代码。

## 不可改变的范围

- Pi `AgentSession` 是唯一 Agent Runtime；进程名固定为
  `open-genoffice-pi-agent-runtime`，不得使用 Electron `utilityProcess`、系统 Node、SEA、
  `npx`、常驻 daemon 或第二套 AgentLoop。
- 一条 Pi Session 只绑定一个 Office 文档。旧聊天、旧 Provider 凭据和 Genspark 数据直接
 幂等删除，不做 migration、兼容层或只读入口。
- Runtime 随 Electron 安装包交付。正式 IPC 为 macOS/Linux UDS、Windows Named Pipe 和
  inherited bootstrap 一次性 token；renderer 不直连 Runtime，不接触 secret。
- 全局资源只位于 ~/.open-genoffice；项目只使用受 Project Trust 保护的 .open-genoffice。
  不扫描或写入 ~/.pi、.pi、~/.codex、.mcp.json 或其他 Agent 客户端目录。
- 优先复用已锁定 Pi 生态：Pi 0.84.0、官方 MCP client 2.0.0、
  @agwab/pi-subagent 0.4.8、Pi DefaultResourceLoader/Package/Extension API。版本保持精确，
  不引入浮动依赖或另一套 MCP/Subagent runtime。
- Subagent 默认只读。Mutation Tool 只有在用户对精确 actor、当前 run、当前文档和精确工具
  签发 Mutation Grant 后可见；父 Agent 不能自授权。
- Office 领域 executor 原位复用，不重写 DOCX/XLSX/PPTX/PDF 引擎，不预建统一 Office
  domain model。renderer 只保留被动 ContextProvider/ExecutorAdapter。
- MinerU 叫“OCR 服务商”，默认关闭；首次开启需上传披露和持续授权。PDF→DOCX 首版只走
  精准解析，不以 Pandoc、Agent 轻量解析或其他服务静默回退。
- Codex OAuth 图片只走已批准的 Codex Responses `image_generation` 设计；协议不兼容只禁用
  图片，不借用 API key、OpenRouter、Sub2API 或其他计费通道。
- WebDAV/S3 同步保持 Local Current，本地文件不被远端静默覆盖；分叉生成旧 Conflict Copy，
  用户选择产生双 parent resolution。凭据、Trust 和设备设置不进入同步。
- Slides 使用受限 `SlidePageSpec`、本地 page renderer 和原子 `commit_slide_page`。PPTX 可
  打开、文字可编辑、无越界/非预期重叠、图片完整后才 commit；失败保留原页。Slides 与 QC
  Subagent 同一 gate 切换。
- 最终 production source、lockfile、安装包、i18n、日志模板和网络路径均不包含 Genspark
  登录、CLI、endpoint、专有依赖、fallback 或死按钮。ADR/迁移历史可以保留名称。

## 执行顺序

严格按最终实施规则 G0 → G9 推进。同步 Provider 只在 G2 的 document/project schema 冻结后
并行；Office 应用生产切换顺序固定为 PDF → Docs → Sheets → Slides/Slide QC。

每个切片执行同一个 tight loop：

1. 读取对应 Issue、执行文档、ADR 和现有代码，列出假设、改动边界、删除点和验收 ID。
2. 先增加能使目标 contract 变红的测试或 accepted/rejected vector，再做最小实现。
3. 贯通需要的 schema、Runtime、Electron main/preload、共享 UI、Office executor 和测试；
   不拆成只能单独存在的水平层。
4. 运行该模块 unit/contract/integration/Electron E2E、覆盖率、typecheck 与 lint；新增平台模块
   lines/branches/functions 各自达到 95% 以上。
5. 只在新路径通过后删除该切片对应旧入口，随后运行 source/dependency/bundle/network scan。
6. 生成或更新 evidence manifest，记录 commit、platform、arch、protocolVersion、catalogHash、
   fixture hash、命令和脱敏报告。测试报告不得包含 prompt、正文、token、URL 或用户路径。
7. 复核 diff 只服务当前 Issue，创建一个中文 conventional commit，推送分支，再进入下一票。

不要因为工作量大、测试首次失败、缺少实现细节、上下文压缩或预计需要多个提交而停止。使用
仓库证据、失败输出和已冻结契约继续修复；安全且在范围内的依赖安装、fixture 生成、CI 等待
和代码调整无需反复请求确认。

## 阶段验收

- G0：精确 lockfile、Runtime manifest/schema、fake Provider、Catalog 基线和禁止项 CI。
- G1：安装资源启动唯一 Runtime；UDS/Named Pipe 认证、Session create/stream/abort/recover，
  shutdown/crash/父 stdin EOF 后无遗留进程与 socket。
- G2：一 Session 一文档、Pi JSONL、CredentialStore、云模型、本地 OpenAI-compatible、Codex
  OAuth、~/.open-genoffice 和旧数据幂等清理；renderer/IPC/log/session 无 secret。
- G3：Skills/Extensions/Packages、Project Trust、MCP stdio/HTTP/OAuth、只读 Subagent、预算、
  取消、恢复和精确 Mutation Grant 全链路。
- G4～G7：四应用按顺序完成 Catalog、实时 Context、顺序 mutation、rollback、Artifact、共享
  AI Panel、fake/真实模型和故障 E2E；每个 App 切换后同批删除自身旧路径。
- 同步线：WebDAV、MinIO/AWS S3 复用同一 contract；Session/Global Asset 同步、Conflict Copy、
  新设备重新 Activation 和 10,000-path 压力门通过。
- G8：删除 packages/agent-core、packages/ai-provider、63 个旧注册点及所有 Genspark 生产路径；
  GX-001～GX-004 全部通过。
- G9：macOS arm64、Windows x64、Linux x64 glibc 原生包完成安装、首次启动、Agent/MCP/
  Subagent、退出、崩溃、升级、卸载与签名/权限检查；SBOM/license/notices 和网络审计通过。

顶层 AR/OT/MD/RS/MCP/SA/OCR/SY/SL/GX/PK/QA 共 56 个验收 ID 必须全部有当前 commit 的
有效 evidence；文档 04 的 OTC-001～OTC-010 也必须进入对应 App Issue。完整映射以文档 06
为准，不在 Prompt 中维护第二份测试清单。

## 需要用户参与的停止条件

只有出现以下情形才暂停当前切片并请求用户：

1. 权威文档彼此冲突，或现有代码证明已批准架构无法实现，需要新增/修改 ADR。
2. 需要上传真实文件、消耗真实模型/MinerU 配额、使用 OAuth 测试账号、AWS/真实 WebDAV
   凭据、Apple Developer ID、notarization 或 Windows Authenticode 证书。先完成 mock、unsigned
   package 和所有不依赖该凭据的工作，再准确说明所需授权、预计外部影响和验证命令。
3. 删除目标超出已列出的旧 Agent/Genspark 路径，可能触及用户 Office 文件、项目资产、
   ~/.open-genoffice 或其他不可恢复数据。
4. upstream 在实施期间发生会改变协议、依赖或产品边界的实质漂移，无法通过局部适配处理。
5. 目标平台原生 runner 或外部服务连续三次阻塞同一验收门，且不存在仍可推进的 mock、代码、
   测试或文档工作。

暂停时保持 Goal active；报告已完成内容、准确阻塞证据、剩余可执行项和需要用户做出的一个
具体决定。只有同一外部阻塞满足三次连续 Goal turn 的条件且已经没有有意义的工作可推进时，
才把 Goal 标为 blocked。

## 完成条件

只有同时满足以下条件才调用 update_goal(status="complete")：

- G0～G9 全部关闭，56 个顶层验收 ID 与 OTC-001～OTC-010 有有效证据；
- 新平台模块三维覆盖率均 ≥95%，全仓 test、typecheck、lint、build、license、notices 通过；
- 三平台目标架构的原生 RC 证据齐全，Runtime/MCP/Subagent 无孤儿进程；
- 四应用只走 Pi Runtime，旧聊天/Provider 数据幂等清理，Genspark 四类审计零未解释命中；
- 所有实施提交已推送，执行文档回写真实 Issue/证据状态，ready-for-review PR 已创建；
- PR 中没有真实 secret、用户文档、live-results、签名 URL、OAuth account ID 或临时豁免。

最终回复只总结完成的 gates、测试与证据、commit/PR、仍需人工执行的 release promotion；不要
把“代码已写”“单平台通过”或“PR 已创建”误报为整个 Goal 完成。
```
