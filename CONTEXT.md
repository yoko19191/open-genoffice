# GenOffice Agent Platform

本上下文定义 GenOffice 内嵌智能体平台及其与 Office 编辑能力之间的语言边界。它用来避免把 Agent 编排、Office 领域操作和外部能力连接混成同一个概念。

## Language

**Agent Platform**:
GenOffice 中负责模型、会话、工具、资源和委派能力的统一平台，其唯一运行时是 Pi Agent Runtime。
_Avoid_: AI 层、AgentLoop、Genspark Agent

**Agent Session**:
一次可持久化、可恢复和可分支的 Agent 交互历史，以 Pi `AgentSession` 为唯一事实源，并且只绑定一个 Office 文档。
_Avoid_: 聊天记录、AI 对话缓存、Office Session

**Runtime Host**:
拥有并驱动 Agent Session、模型凭据和扩展执行环境的受信进程边界。
_Avoid_: AI 后端、Agent 服务

**Runtime Sidecar**:
名为 `open-genoffice-pi-agent-runtime` 的独立运行单元，承载 Runtime Host；
以目标平台 Node.js `22.19.0` executable 和 unpacked ESM bundle 随 Electron
`extraResources` 交付，并由 Electron 负责启停、恢复与回收。
_Avoid_: utility process、第二运行时

**Model Provider**:
由 Runtime Host 通过 Pi ModelRuntime 管理认证、模型发现、能力声明和推理请求的可替换
模型来源；它不拥有 Agent Session，也不等同于 Image Provider 或 OCR 服务商。
_Avoid_: 模型接口、AI Provider、LLM proxy

**Resource Home**:
GenOffice Agent Platform 的全局配置、会话、Skills、Packages 和运行数据根目录，默认为 `~/.open-genoffice`。
_Avoid_: Pi Home、`~/.pi/agent`

**Credential Reference**:
配置中可持久化和同步的非敏感槽位标识，用来在当前设备解析安全 CredentialStore 中的
API Key、OAuth token 或服务密码；它本身不是凭据，目标设备可以保留空槽位。
_Avoid_: API Key、Token、加密后的 Secret

**Global Asset**:
用户跨项目复用并允许同步的资产总称，包括图片、附件、模板、Skills、Extensions、
Prompts 和脱敏后的 MCP 配置。同步 Global Asset 不等于同步凭据或信任结论。
_Avoid_: Credential、Project Trust、设备设置

**Agent Actor**:
发起模型、工具或外部能力调用的具体主体，是 Parent Agent 或某个 Subagent；授权按 Actor
身份、绑定文档和当前 run 独立判定，不能只凭父子关系自动继承。
_Avoid_: 用户、模型、Session

**Capability Snapshot**:
某个 Agent Actor 在一次 run 开始时获得的模型、资源、工具与权限的不可变集合；配置、
连接或授权变化只影响后续 run，撤销与紧急禁用除外。
_Avoid_: 工具列表、全局设置、权限缓存

**Office Context**:
某一轮 Agent 执行时，来自当前文档、选择区、工作簿或幻灯片的最新可见状态。
_Avoid_: Skill 内容、静态 Prompt、文档缓存

**Office Tool**:
由 GenOffice 编辑器提供、注册到 Pi Agent Session 的受控领域能力。
_Avoid_: Pi 内置工具、Skill、编辑器命令

**Tool Provenance**:
一次工具结果携带的不可变来源链，至少标识 Agent Actor、run、工具命名空间以及 Office
executor 或 MCP server；它用于授权、审计和 UI 解释，不把原始参数或结果复制成日志。
_Avoid_: 工具日志、调用栈、遥测事件

**Image Provider**:
由 Runtime Host 管理认证、请求、用量和资产落盘，把提示词转换为图片资产的可替换能力；
图片模型不等同于 Agent Session 的对话模型。
_Avoid_: 图片工具、聊天模型、Genspark 图片接口

**Codex OAuth Image Provider**:
复用 Pi `openai-codex` CredentialStore，通过 ChatGPT Codex Responses 的
`image_generation` 服务端工具生成图片的 Image Provider。
_Avoid_: 公开 OpenAI Images API、Sub2API 隐式回退、`gpt-image-2` 对话模型

**Provider Operation**:
由 Image Provider、OCR 服务商或模型媒体分析发起的一次可取消外部操作；它通过稳定状态
和 Artifact Reference 返回结果，但不直接修改 Office 文档，也不是 Agent Session。
_Avoid_: Agent Run、后台任务、Office Tool

**Resume Capsule**:
Provider Operation 为跨 Runtime 重启继续查询或下载同一个远端任务而保存的本机加密状态；
它不能表示重新提交请求，也不进入同步。
_Avoid_: 重试请求、任务日志、Credential

**Mutation Tool**:
会改变 Office 文档或项目状态，并必须进入权限、顺序执行和撤销边界的 Office Tool。
_Avoid_: 写工具、危险工具

**Agent Resource**:
由 Pi ResourceLoader 或 PackageManager 发现和装载的 Skill、Extension、Prompt 或 Package。
_Avoid_: 插件文件、Agent 配置

**Project Resource**:
由某个 Office 项目携带、只有在项目通过信任确认后才会进入 Agent Platform 的配置或资源。
_Avoid_: 本地插件、项目脚本

**Project Trust**:
用户在当前设备针对 canonical project root 作出的持续授权，使该根目录中的 Project
Resource 可以被发现、装载或连接；授权不进入同步，项目被复制、移动到新根目录或到达新设备时必须重新确认。
_Avoid_: Resource Activation、一次工具授权、同步凭据

**Resource Activation**:
用户在当前设备针对某个具体内容 hash 作出的可执行或联网授权，主要用于同步得到的
Extension、带脚本 Skill、Package 和 stdio/HTTP MCP 配置；内容 hash 变化后自动失效。
_Avoid_: Project Trust、全局启用开关

**MCP Connection**:
由 GenOffice 管理生命周期和权限、向 Agent Session 暴露远端工具的 MCP 服务连接。
_Avoid_: MCP 插件、外部工具地址

**Subagent**:
由父 Agent 委派、拥有独立上下文与生命周期、其结果回到父 Agent Session 的子执行单元。
_Avoid_: 工具调用、后台任务、子线程

**Read-only Subagent**:
只能读取被授予的 Office Context、不能获得 Mutation Tool 的默认 Subagent。
_Avoid_: 安全 Subagent、分析任务

**Mutation Grant**:
用户针对特定 Subagent、文档、工具能力和有效期作出的显式写权限授予；不得由父 Agent 自行扩大。
_Avoid_: 编辑模式、全局写权限

**Project Sync Provider**:
把本地 Office Project 同步到 WebDAV 或 S3 Bucket 的可替换传输边界，不拥有 Agent Session 的执行语义。
_Avoid_: 云项目运行时、Pi 云会话

**Sync Revision**:
由内容 hash、canonical path、parent、tombstone 和作者设备组成的不可变内容寻址节点；
它表达同步历史，但不使用 wall-clock 决定冲突胜者。
_Avoid_: 文件修改时间、远端 ETag、自动备份

**Local Current**:
当前设备 Office 工作路径上正在编辑的 revision；reconcile 检测到远端分叉时它仍保持主路径，
直到用户显式选择产生新的 resolution revision。
_Avoid_: last-write-wins 时间戳、Conflict Copy

**Sync Conflict**:
本地与远端基于同一版本分别发生修改、不能安全自动覆盖的项目状态。
_Avoid_: 上传失败、版本落后

**Conflict Copy**:
Sync Conflict 中被主路径替换或暂不接受的旧 revision；它保留原始内容和来源，等待用户比较、恢复或删除。
_Avoid_: 自动备份、当前文件

**OCR 服务商**:
由用户显式开启、通过云接口提供 OCR 与文档转换能力的 Provider；MinerU 是首个实现，默认关闭。
_Avoid_: PDF 引擎、默认云服务、DocumentConversionProvider

**Genspark-Free Build**:
安装包、运行时配置和网络路径均不包含 Genspark 登录、CLI、服务地址或专有依赖的发布产物。
_Avoid_: 无需登录版、本地模型版
