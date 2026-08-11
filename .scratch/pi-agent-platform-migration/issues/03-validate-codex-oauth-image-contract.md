# 验证 Codex OAuth 图片生成契约

Type: prototype

Status: resolved

## Question

使用 GenOffice 自己完成的 ChatGPT/Codex OAuth 登录，能否参考 Sub2API 的桥接设计，
直接通过 ChatGPT Codex Responses 的 `image_generation` 工具生成图片，并作为一等
`ImageProvider` 接入？原型必须用真实账户验证请求、流事件、图片、错误与用量边界，
同时保留公开 OpenAI API 直连作为负向对照。

## Comments

### 2026-08-09 — 公开契约与探针准备

- 固定检查 Pi Web 使用的 `@earendil-works/pi-ai@0.84.0`；本地 Pi 源码 commit
  `3911d6f5cde8335c576e14051578eeffe812ed53` 对应较旧的 `0.78.0`，只用于交叉阅读。
  Pi 的 ChatGPT/Codex OAuth Provider 把
  access token 用于 `https://chatgpt.com/backend-api`；Pi Images API 当前唯一内置
  Provider 是 OpenRouter，没有 Codex OAuth Images adapter。
- OpenAI 的[公开 API 鉴权契约](https://developers.openai.com/api/reference/overview#authentication)
  只列出标准 API key 与 workload identity access token；
  [`gpt-image-2` 文档](https://developers.openai.com/api/docs/models/gpt-image-2)把公开图片
  端点定义为 `/v1/images/generations`。没有文档把 ChatGPT/Codex 用户 OAuth token
  声明为公开 Images API 凭据。
- OpenAI 对[使用 ChatGPT 计划的 Codex](https://help.openai.com/en/articles/11369540/)
  明确区分 Codex agentic usage 与 ChatGPT 图片生成限制，不能据此推断 OAuth 图片权限。
- 已创建不读取、不保存现有客户端凭据的
  [兼容性探针](../prototypes/codex-oauth-image/README.md)。默认只对公开模型端点做免费
  鉴权检查，只有用户显式加入 `--allow-billable-image-call` 才允许请求一张低质量测试图。
- 真实账户 device-code 登录完成。免费鉴权请求返回 HTTP `403`，OpenAI request ID 为
  `8192ddcb-6ecd-4440-9ae2-df5714d0bbdf`；探针未进入计费图片调用。需要先核对 Pi
  `0.84.0` 与 `0.78.0` 的 OAuth scope/endpoint 是否一致，再给出最终关闭结论。

### 2026-08-09 — Pi 0.84 对齐复核

- Pi `0.84.0` 仍使用与实测版本相同的 OAuth client ID、`auth.openai.com`
  device-code endpoint 和 `openid profile email offline_access` scope；
  `openai-codex` Provider 仍指向 `https://chatgpt.com/backend-api`。因此实测 token
  与目标版本属于同一凭据契约。
- 原型已改用 Pi Web 同版本的公开 `ModelRuntime.login()`，并注入
  `InMemoryCredentialStore`、`modelsPath: null` 与隔离 HOME。`--check-runtime` 验证通过，
  没有创建隔离 HOME，也不读取或写入真实 `~/.pi`、`~/.codex`。
- 公开 API 在图片调用前已经拒绝该 token，继续验证 token refresh、图片 usage 和付费请求
  不会改变兼容性结论，反而只会扩大凭据与费用风险，因此按失败快路径停止。

### 2026-08-09 — 参考 Sub2API 后重新打开并实测

- 用户提供的 Sub2API `/v1/models` 已只读验证，包含 `gpt-image-2`。这枚下游 API key
  不是 Codex OAuth token；Sub2API 在内部保存上游 OAuth 账号并负责协议转换，因此不能
  用公开 API 的 `403` 否定该路径。
- 参考 Sub2API commit `cc67b1aca1d3b590609abef2fcd3a6ca31c5c651` 的行为：外层
  Responses 模型为 `gpt-5.4-mini`，`gpt-image-2` 位于 `image_generation` tool 中，最终
  base64 从流式 `image_generation_call` 事件提取。没有复制其 LGPL 源码。
- 新增[直接 Codex Responses 探针](../prototypes/codex-oauth-image/README.md)，继续使用
  Pi `0.84.0` 的公开 OAuth 登录和内存 CredentialStore。探针以 `originator: pi` 运行，
  没有伪装官方 Codex CLI，不输出 token、account ID 或图片 base64。
- 首次请求返回 `400 unknown_parameter: tools[0].n`；Sub2API 只在 `n > 1` 时传该字段。
  单图请求省略 `n` 后，真实账户请求返回 HTTP `200`，完整收到 generating、partial image、
  output item done 与 completed 事件。
- 生成文件是可解码 PNG，1254×1254、651446 bytes，SHA-256 为
  `7147b4fc7343432a29a7302859b6f3bd71a6df1178a554d6c1ae61ac9cc5bb68`；图片工具
  usage 为 input 44、output 229、total 273 tokens。隔离 HOME 未创建，凭据未落盘。

## Answer

可行。生产实现应增加 `CodexOAuthImageProvider`，复用 Pi `openai-codex` OAuth 登录、
刷新和 CredentialStore，但不调用公开 `/v1/images/generations`。Provider 直接请求固定的
ChatGPT Codex Responses endpoint，以 `gpt-5.4-mini` 作为外层模型，将
`gpt-image-2` 作为 `{ type: "image_generation", action: "generate" }` 的工具模型。

`gpt-image-2` 属于图片能力选择器，不进入普通对话模型列表。首版一次只生成一张图并省略
`n`；监听 `image_generation_call` 生命周期，从 final event 提取 base64，校验 MIME、魔数、
实际尺寸、字节上限和 SHA-256 后原子写入项目资产。请求尺寸仅是意图，UI 必须展示真实
输出尺寸。

Provider 通过 `ModelRuntime.getAuth("openai-codex")` 触发 Pi 的刷新语义，再从刷新后的 JWT
解析 ChatGPT account ID。token、account ID、base64 和完整 prompt 不得进入 renderer、
Session 或日志。网络只允许 HTTPS 精确主机 `chatgpt.com`；Agent Stop 连接到同一个
AbortSignal，默认硬超时 300 秒。

收到任一 partial image 后，不得自动重试，以免重复用量；流中断时只保留标记为 incomplete
的诊断 artifact。401 只允许在尚未收到图像事件前刷新一次，429 显示 Codex usage limit，
400 unknown parameter 进入 `provider_contract_incompatible`。若实时兼容性检查失败，只禁用
图片 Provider 并明确提示，不能静默改用 API key、OpenRouter、Sub2API 或其他计费渠道。

Sub2API 只作为协议与测试设计参考，不随 Electron 安装包交付，也不是 Agent Runtime。
用户仍可另行配置 OpenAI-compatible Images Provider 指向 Sub2API，但它是独立、显式的
Provider 配置，不是 Codex OAuth Provider 的隐式回退。

证据原型见[Codex OAuth 图片兼容性探针](../prototypes/codex-oauth-image/README.md)。
