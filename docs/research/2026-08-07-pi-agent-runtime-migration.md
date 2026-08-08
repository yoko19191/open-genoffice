# Pi Agent Runtime 迁移研究

<!-- markdownlint-disable MD013 MD028 -->

> 日期：2026-08-07
> 状态：迁移前技术调研，不含实现
> 证据范围：Pi 官方 GitHub 仓库、发布标签与官方 npm 元数据；Electron 兼容性只补充引用 Electron 官方版本资料。

> [!IMPORTANT]
> 本文保存早期技术证据，不是实施规格。其分阶段保留旧 Agent/云服务、采用
> main/utility process 等建议，已被后续产品决策取代。工程实现必须以
> [Pi Agent Platform 迁移规格与验收矩阵](../superpowers/specs/2026-08-07-pi-agent-platform-migration.md)
> 和 [`docs/adr`](../adr/) 为准：Pi `AgentSession` 是唯一运行时，Runtime 使用随
> Electron 交付的 `open-genoffice-pi-agent-runtime` sidecar，发行包必须彻底移除
> Genspark 依赖。

## 结论

Pi 适合成为 GenOffice 的**本地 Agent 运行时与多模型传输层**，却不是一套可以替换现有云端产品能力的平台。更稳妥的迁移边界是：用 `pi-agent-core` 接管 Agent 循环、事件、工具调度和内存状态，用 `pi-ai` 接管模型与 Provider 适配；会话树、压缩、Skills 和扩展加载可以从 `pi-coding-agent` 选择性复用。GenOffice 已有的账号与计费、搜索、文件转换、云项目以及 Office 语义工具仍应保留在自己的服务和包中。Pi 官方对三个核心包的定位本身就是“多 Provider LLM API / Agent runtime / coding-agent CLI”，并未把它们描述成托管云服务。[Pi 官方包边界](https://github.com/earendil-works/pi/blob/v0.84.0/README.md)

迁移时不应再新增 `@mariozechner/*` 依赖。该作用域下的三个包都已被发布者弃用，封版在 `0.73.1`，npm 的弃用信息明确要求改用 `@earendil-works/*`；截至本次核对，继任包为 `0.84.0`。[旧 `pi-agent-core` npm](https://www.npmjs.com/package/@mariozechner/pi-agent-core) · [旧 `pi-ai` npm](https://www.npmjs.com/package/@mariozechner/pi-ai) · [旧 `pi-coding-agent` npm](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) · [新 `pi-agent-core` npm](https://www.npmjs.com/package/@earendil-works/pi-agent-core) · [新 `pi-ai` npm](https://www.npmjs.com/package/@earendil-works/pi-ai) · [新 `pi-coding-agent` npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)

因此，下面的能力判断以当前继任实现 `@earendil-works/*@0.84.0` 为准，同时把旧作用域的封版状态单独列明。历史地址 `badlogic/pi-mono` 目前会跳转到新的官方仓库 `earendil-works/pi`；标签链接固定在 `v0.84.0`，避免 `main` 后续漂移。[历史仓库地址](https://github.com/badlogic/pi-mono) · [当前官方仓库](https://github.com/earendil-works/pi/tree/v0.84.0)

## 版本、运行环境与许可证

| 包 | 2026-08-07 官方状态 | Node 要求 | 许可证 |
| --- | --- | --- | --- |
| `@mariozechner/pi-agent-core` | `0.73.1`，已弃用 | `>=20.0.0` | MIT |
| `@mariozechner/pi-ai` | `0.73.1`，已弃用 | `>=20.0.0` | MIT |
| `@mariozechner/pi-coding-agent` | `0.73.1`，已弃用 | `>=20.6.0` | MIT |
| `@earendil-works/pi-agent-core` | `0.84.0` | `>=22.19.0` | MIT |
| `@earendil-works/pi-ai` | `0.84.0` | `>=22.19.0` | MIT |
| `@earendil-works/pi-coding-agent` | `0.84.0` | `>=22.19.0` | MIT |

旧包版本、Node 下限、许可证和弃用提示来自各自的官方 npm 元数据；新包的同类信息也写在发布包 manifest 中。[新 agent manifest](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/package.json) · [新 ai manifest](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/package.json) · [新 coding-agent manifest](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/package.json)

GenOffice 当前根 manifest 允许 Node `>=22.12.0`，低于 Pi `0.84.0` 要求的 `>=22.19.0`；迁移时应把安装与 CI 下限收紧到至少 `22.19.0`。[GenOffice 根 manifest](../../package.json) Electron Shell 使用 `electron ^43.3.0`，[Shell manifest](../../apps/shell/package.json) 而 Electron 43 官方说明其内置 Node 已进入 24.x，因此 Electron **main process** 的运行时版本满足 Pi 的最低要求。[Electron 43 官方发布说明](https://www.electronjs.org/blog/electron-43-0)

三个 Pi 包均为 ESM。`pi-ai` 明确支持浏览器打包，但 OAuth 登录和 Bedrock 是 Node-only，并警告不要在生产前端暴露 API key；在 GenOffice 中，模型凭据与 Agent 运行时应放在 Electron main process 或隔离的 utility process，renderer 只通过窄 IPC 接口收发事件。这是基于 Pi 官方浏览器边界与 Electron 架构做出的迁移建议。[`pi-ai` Browser Usage](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#browser-usage)

`pi-agent-core` 已把 Node SQLite 适配器拆到独立包，核心包不会默认引入 Node builtin 或原生 SQLite 依赖；这降低了 Electron 打包阻力。不过 `pi-coding-agent` 本身包含终端、文件系统、进程执行和资源安装逻辑，若采用其 SDK，也应只放在受信任的 main/utility process，而不是 renderer。[`pi-agent-core` SQLite 边界](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#sqlite-session-backends) · [`pi-coding-agent` manifest](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/package.json)

## `pi-agent-core` 能提供什么

### 运行时接口与状态

核心入口是有状态的 `Agent`。调用方注入 `initialState` 和 `streamFn`；状态包含 system prompt、当前模型、thinking level、工具列表、消息历史、流式中的临时消息、待执行工具以及最近错误。模型传输因此不是写死在 Agent 内部，而是由 `pi-ai` 或 GenOffice 自己的兼容传输提供。[`Agent` Quick Start](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#quick-start) · [`AgentState`](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#agent-state)

消息层支持标准 `user`、`assistant`、`toolResult`，也允许通过 TypeScript declaration merging 加入应用消息。每次送给模型前，`transformContext` 可做裁剪或注入上下文，`convertToLlm` 则负责过滤 UI-only 消息并转换成模型能理解的结构。这一点适合 GenOffice 把“文档快照、选择区、操作回执”等界面状态保留在本地消息树中，只把必要部分发给模型。[Message Flow](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#agentmessage-vs-llm-message) · [Custom Message Types](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#custom-message-types)

`Agent` 暴露 `prompt()`、`continue()`、`reset()`、`abort()`、`waitForIdle()`，并允许运行中加入 steering 或 follow-up 消息；模型、system prompt、thinking level、tools 和 messages 都可在状态上替换。`prompt()` 也能附带图片输入。[Methods](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#methods) · [Steering and Follow-up](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#steering-and-follow-up)

需要注意：基础 `Agent` 的消息状态本身是进程内状态；持久化要由上层 session 实现，或采用 Pi 另外提供的 session backend。不能把 `AgentState.messages` 误当作现成的云会话库。[Agent State](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#agent-state) · [SQLite session backends](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#sqlite-session-backends)

### 循环、事件与工具

一轮标准流程是：加入用户消息，开始一次 LLM turn，流式产生 assistant 消息；若 assistant 请求工具，运行工具并加入 `toolResult`，随后再进入下一次 LLM turn，直到模型不再调用工具。也可以绕过 `Agent`，直接消费低层 `agentLoop()` / `agentLoopContinue()` 的异步事件流。[Event Flow](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#event-flow) · [Low-Level API](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#low-level-api)

对 UI 有用的事件包括 `agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。`message_update` 携带流式 assistant delta，工具也可持续发进度；`Agent.subscribe()` 的监听器按注册顺序 await，`agent_end` 监听器完成后 `prompt()` / `waitForIdle()` 才真正结算，适合在结束屏障里持久化状态。[Event Types](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#event-types)

工具使用 TypeBox 参数 schema，`execute(toolCallId, params, signal, onUpdate)` 同时获得取消信号与增量更新回调。全局工具执行默认为并行，也可改为顺序；单个工具可以强制整批顺序执行。`beforeToolCall` 可做权限预检并阻止调用，`afterToolCall` 可审计或改写结果；工具抛出的异常会变成 `isError: true` 的工具结果回送模型。[Tools](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#tools) · [Agent Options](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md#agent-options)

这组接口能承载 GenOffice 的 Office 语义工具，但 Pi 不会替我们实现它们。迁移后仍应由 Docs / Sheets / Slides 引擎提供 `read_selection`、`replace_range`、`set_cell_values`、`insert_slide` 一类工具，并在 `beforeToolCall` 中实现文档权限、破坏性操作确认和运行上下文校验。

## `pi-ai` 的模型与 Provider 能力

`pi-ai` 把 Provider 定义成运行时单元：Provider 拥有模型目录、凭据解析和流式实现，`Models` 集合负责登记 Provider、查询模型并把请求路由到模型所属 Provider。官方内置 OpenAI、Anthropic、Google、Azure OpenAI、Bedrock、OpenRouter、Vertex、Mistral、Groq 等 Provider，并明确支持任意 OpenAI-compatible API，例如 Ollama、vLLM 和 LM Studio。[Providers and Models](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#providers-and-models) · [Supported Providers](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#supported-providers)

用户自定义模型与端点可以直接表达。应用可用 `createProvider()` 组合 Provider 身份、认证、模型列表和 API 实现；模型元数据含 `id`、`api`、`provider`、`baseUrl`、上下文窗口、最大 token、输入能力与成本。官方示例直接把 Ollama 的 `http://localhost:11434/v1` 登记为 `openai-completions` Provider，也展示了带 API key 的代理、混合 API Provider 和动态模型列表。[Custom Providers / `createProvider()`](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#custom-providers)

对 OpenAI-compatible 端点，Pi 会按已知 `baseUrl` 自动推断兼容参数；未知代理可用 `compat` 覆盖 developer role、reasoning effort、stream usage、strict tools、token 字段名、thinking 格式等差异。它适合承接 GenOffice 的“用户填写 Base URL + API key + model ID”设置，但设置 UI、密钥安全存储和端点可用性测试仍是 GenOffice 的职责。[OpenAI Compatibility Settings](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#openai-compatibility-settings)

凭据层提供统一解析和一个很小的 `CredentialStore` 合约：显式请求值优先，其次是调用方注入的持久凭据，再到环境变量或 Provider 自己的 OAuth/ambient credentials。Pi 默认只给内存 store，应用需要注入自己的持久实现；这正好允许 GenOffice 把 secret 留在 Electron main process 的安全存储中。[Auth Resolution](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#how-auth-resolves) · [Credential Store](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#credential-store)

`pi-ai` 还能在不同 Provider 之间保留并转换对话上下文，统一文本、thinking、工具调用与工具结果的消息表示；同时提供 token / cost 计数。这是客户端运行时能力，不等同于托管计费系统。[Cross-Provider Handoffs](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#cross-provider-handoffs) · [`Usage` 类型](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/src/types.ts)

## `pi-coding-agent`：哪些可复用，哪些不应照搬

官方 SDK 明确把“嵌入 web / desktop / mobile 自定义 UI”列为用例，因此从 `pi-coding-agent` 选择性拿会话与资源层是受支持的使用方式，不必把 CLI 当子进程黑盒。[SDK 概览](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md)

| 部分 | 对嵌入式 Office 的判断 | 迁移边界与依据 |
| --- | --- | --- |
| `AgentSession` | **可复用** | 管理 Agent 生命周期、消息、模型、压缩、重试和事件；能用 `SessionManager.inMemory()`，也能持久化。[AgentSession SDK](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#agentsession) |
| JSONL session tree | **可复用，但要适配存储键** | 每条记录有 `id/parentId`，支持树导航、fork、clone、compact，完整历史仍保留在 JSONL。默认按 `cwd` 放在本地目录；Office 应以 `documentId/projectId` 映射，不能直接暴露用户文件路径。[Sessions](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#sessions) · [Session Management SDK](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#session-management) |
| compaction / retry / steering | **可复用** | 长会话压缩、overflow 恢复、steering 与 follow-up 都属于通用 Agent 会话行为，与代码编辑无关。[Compaction](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#compaction) · [Prompting and Message Queueing](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#prompting-and-message-queueing) |
| Skills | **加载机制可复用，内容需 Office 化** | 遵循 Agent Skills 标准，可通过 `DefaultResourceLoader` 或 `skillsOverride` 注入。渐进加载默认依赖模型调用 `read` 打开完整 `SKILL.md`；若禁用文件读取，就要提供仅能访问受信 Skill 目录的读取工具，或由应用预加载内容。应只装载 GenOffice 审核过的 Office Skills，避免默认扫描任意用户目录。[Skills](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#skills) · [How Skills Work](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/skills.md#how-skills-work) · [Skills SDK](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#skills) |
| Extensions 的工具与事件部分 | **可复用，但必须建立信任边界** | inline extension 能注册工具、监听 Agent 事件并通过 event bus 通信。第三方 extension 是任意 TypeScript，官方明确警告其拥有完整系统访问；桌面应用必须 allowlist、签名或完全关闭外部发现。[Extensions SDK](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#extensions) · [Pi Packages 安全警告](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#pi-packages) |
| Extension 的 TUI 组件、命令、快捷键、theme | **不直接复用** | 这些接口服务终端编辑器与 Pi TUI，不会映射为 GenOffice 的 React 组件或 Electron 菜单。Office UI 应只消费 session/agent 事件，自行渲染。[Extensions 能力清单](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#extensions) |
| 内置工具 | **不作为 Office 编辑工具复用** | 内置集合只有 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，默认四项为 `read/bash/edit/write`，全部围绕代码与文件系统。嵌入时应 `noTools: "builtin"` 或显式 allowlist，再传入 Office `customTools`。[Tools SDK](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md#tools) · [官方工具源码清单](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/index.ts) |
| CLI / InteractiveMode / shell package manager | **coding-only** | cwd 扫描、终端输入、bash、项目包安装、theme 与 terminal rendering 都是 coding-agent 产品层；嵌入 GenOffice 只会扩大权限和打包面。[`pi-coding-agent` 定位](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/package.json) |

`DefaultResourceLoader` 可以通过 `noExtensions/noSkills/noContextFiles` 关闭自动发现，也可用 `extensionFactories`、`skillsOverride`、`agentsFilesOverride` 注入受控资源。对于桌面 Office，建议从“全部关闭，只显式注入”开始，而不是沿用 CLI 的 `~/.pi` / `.pi` 发现规则。[ResourceLoader options](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/resource-loader.ts)

## Pi 不替代哪些托管云能力

下面的“没有”特指**Pi 项目没有提供由 Pi 托管、可直接替代 GenOffice 后端的产品服务**，不是说 Agent 不能通过自定义工具调用这些服务。此判断依据官方包清单、内置工具清单和公开数据类型；属于对官方边界的归纳。

Pi `0.84.0` 确实另有实验性的 `pi-server/client/protocol`，可承载远程 session；只是官方明确说明它没有 standalone CLI 或 coding-agent service，应用必须自行实现 `PiServerService`，transport 的认证和授权也必须在连接交给 `PiServer` 前由应用完成。因此它是协议与服务骨架，不改变下面的托管云边界。[`pi-server` 官方说明](https://github.com/earendil-works/pi/blob/v0.84.0/packages/server/README.md)

| 能力 | Pi 实际提供 | GenOffice 仍需负责 |
| --- | --- | --- |
| 用户认证、租户与计费 | Provider API key / OAuth 的客户端解析、凭据 store 接口、token 与 cost 统计；凭据持久化由调用方注入。[Auth](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#auth) | GenOffice 用户账号、组织/租户、套餐、额度、支付、密钥托管、审计与服务端授权。Pi 的 cost 数字不是账单系统。 |
| Web 搜索与图片搜索 | 核心包没有搜索 Provider；coding-agent 内置工具只有本地文件/进程工具。[官方工具清单](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/index.ts) | 搜索 API、结果排序、图片版权过滤、抓取和缓存；继续由 GenOffice 的 `ai-search` 或后端实现。 |
| 图片生成 | 当前继任版 `pi-ai@0.84.0` **有客户端图片生成 API**，但目前内置只接 OpenRouter；调用方仍需上游 Provider 凭据。它不是 Pi 托管的生成服务。[Image Generation](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#image-generation) | Provider 采购与账单、模型策略、内容安全、资产下载/持久化和插入 Office 文档。若严格停留在已弃用的 `@mariozechner/pi-ai@0.73.1`，还拿不到后续新增的这层 API。 |
| 媒体分析 | chat 消息原生内容类型是文本与图片；可把图片交给具备 vision 的模型分析。官方消息类型没有音频或视频块。[Image Input](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md#image-input) · [消息类型源码](https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/src/types.ts) | 音频/视频上传、抽帧、转码、ASR、长媒体切片与专用分析 pipeline。 |
| 文件转换 | Pi 内置工具做文本/代码文件读写；coding-agent 只含为模型输入服务的图片归一化/缩放，不提供 PDF↔DOCX、PPTX 生成或 Office 文件转换服务。[工具列表](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#tool-options) | Office/PDF 解析、渲染、导出、格式保真、云端转换任务和产物存储。 |
| 云项目 | Pi session 是本地 JSONL 或调用方选择的内存/session backend；官方 session 功能是对话树、fork 与 compact，不是多租户云项目、协作空间或远端资产库。[Sessions](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#sessions) | 云项目列表、同步、权限、协作、版本与资产生命周期。 |

同样不能假定 Pi 会替应用提供权限弹窗。官方说明 Pi 默认按启动进程的完整权限运行，coding-agent 的理念章节也明确写着没有内置 permission popups；GenOffice 必须在 IPC 和 `beforeToolCall` 两层实施权限与确认策略。[Pi Permissions & Containerization](https://github.com/earendil-works/pi/blob/v0.84.0/README.md#permissions--containerization) · [Coding-agent Philosophy](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md#philosophy)

## 建议的迁移边界

建议先把 Pi 收敛在一个 GenOffice 自有 adapter 后面，不让 Docs / Sheets / Slides 直接依赖 Pi 类型。adapter 对上层只暴露 `startRun / cancelRun / subscribe / restoreSession` 与 GenOffice 自己的事件、工具回执和错误类型；内部再组合 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。这样可以隔离 Pi 仍处于 `0.x`、作用域刚迁移所带来的版本变化。

第一阶段只替换运行时，不迁移云服务：

1. 固定 `@earendil-works/pi-agent-core@0.84.0` 与 `@earendil-works/pi-ai@0.84.0`，将 Node 安装下限提高到 `22.19.0`。
2. 在 Electron main/utility process 创建 Provider registry 和 `Agent`，通过现有 preload/IPC 把结构化事件送到 renderer。
3. 把现有 Docs / Sheets / Slides 操作包装成 `AgentTool`；默认顺序执行所有会修改同一文档的工具，并用 `beforeToolCall` 实现权限、确认和文档上下文检查。
4. 保留 GenOffice 现有 auth、search、image/file conversion 与 cloud-project 路径，把它们作为服务或 Agent tools 接到运行时。
5. 只有确认需要会话分支与通用压缩后，再引入 `pi-coding-agent` 的 `AgentSession` / `SessionManager`；Skills 使用受控 `ResourceLoader` 注入，内置 coding tools 和 TUI 不进入产品。

最终判断是：**Agent loop 与 Provider 层可迁，coding-agent 资源层可选迁，云产品层不可迁。**

## 一手来源索引

- Pi 当前官方仓库与标签：<https://github.com/earendil-works/pi/tree/v0.84.0>
- 历史仓库入口（现重定向）：<https://github.com/badlogic/pi-mono>
- `pi-agent-core` README：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/README.md>
- `pi-agent-core` manifest：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/package.json>
- `pi-ai` README：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/README.md>
- `pi-ai` 类型源码：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/src/types.ts>
- `pi-ai` manifest：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/ai/package.json>
- `pi-coding-agent` README：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/README.md>
- `pi-coding-agent` SDK：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/docs/sdk.md>
- `pi-coding-agent` 工具源码：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/index.ts>
- `pi-coding-agent` ResourceLoader：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/resource-loader.ts>
- `pi-server` 实验性服务骨架：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/server/README.md>
- `pi-coding-agent` manifest：<https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/package.json>
- 旧 `@mariozechner` npm 包：<https://www.npmjs.com/package/@mariozechner/pi-agent-core> · <https://www.npmjs.com/package/@mariozechner/pi-ai> · <https://www.npmjs.com/package/@mariozechner/pi-coding-agent>
- 当前 `@earendil-works` npm 包：<https://www.npmjs.com/package/@earendil-works/pi-agent-core> · <https://www.npmjs.com/package/@earendil-works/pi-ai> · <https://www.npmjs.com/package/@earendil-works/pi-coding-agent>
- Electron 43 官方发布说明：<https://www.electronjs.org/blog/electron-43-0>
