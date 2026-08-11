# 将 Codex OAuth 作为模型 Provider 登录方式

GenOffice 的模型 Provider 必须支持用户通过 ChatGPT/Codex OAuth 登录，并将凭据交给
Pi `openai-codex` Provider 使用。凭据由 `~/.open-genoffice` 对应的安全
CredentialStore 独立持有，不读取或复用 `~/.pi`、`~/.codex` 中其他产品的登录状态。
OAuth 登录、刷新、退出和撤销必须有完整的 UI 与错误状态；它不能退化成要求用户手工
粘贴 OpenAI API key。

同一 CredentialStore 也服务于独立的 `CodexOAuthImageProvider`。图片 Provider 不把
OAuth token 发送到公开 Images API，而是按 ADR 0013 中已经实测的 Codex Responses
`image_generation` 契约运行；对话模型选择与图片模型选择保持分离。
