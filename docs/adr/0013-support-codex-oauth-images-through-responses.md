# 通过 Codex Responses 支持 OAuth 图片生成

Codex OAuth token 不能直接作为公开 OpenAI Images API 的 Bearer token，但真实账户 spike
已经证明：同一凭据可以请求 ChatGPT Codex Responses，并通过原生
`image_generation` 工具生成 `gpt-image-2` 图片。

GenOffice 因此提供一等 `CodexOAuthImageProvider`。它复用 Pi `openai-codex` 的登录、刷新
和 CredentialStore，以 `gpt-5.4-mini` 作为外层 Responses 模型，以 `gpt-image-2` 作为
图片工具模型。`gpt-image-2` 不进入普通对话模型选择器。

该接口不是公开 OpenAI API 合约，必须隔离在独立 Provider 中：固定 endpoint 与请求 schema，
设置兼容性 smoke、300 秒硬超时、AbortSignal、用量展示和 fail-closed 错误状态。任何
partial image 之后都不得自动重试。若协议回归，只禁用图片 Provider 并明确提示，不影响
其他 Agent 能力，也不得静默切换 API key、OpenRouter、Sub2API 或其他计费渠道。

Sub2API 只作为协议行为参考，不复制其 LGPL 源码、不随 Electron 安装包交付，也不成为
Agent Runtime。用户显式配置的 Sub2API/OpenAI-compatible Images endpoint 属于另一项
Provider 配置。

证据见
[`03-validate-codex-oauth-image-contract.md`](../../.scratch/pi-agent-platform-migration/issues/03-validate-codex-oauth-image-contract.md)。
