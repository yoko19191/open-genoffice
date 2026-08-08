# 将 Codex OAuth 作为模型 Provider 登录方式

GenOffice 的模型 Provider 必须支持用户通过 ChatGPT/Codex OAuth 登录，并将凭据交给
Pi `openai-codex` Provider 使用。凭据由 `~/.open-genoffice` 对应的安全
CredentialStore 独立持有，不读取或复用 `~/.pi`、`~/.codex` 中其他产品的登录状态。
OAuth 登录、刷新、退出和撤销必须有完整的 UI 与错误状态；它不能退化成要求用户手工
粘贴 OpenAI API key。

这项决定只覆盖 Codex 模型 Provider。OAuth 凭据能否通过受支持接口生成图片必须先由
兼容性 spike 证明，不能把未公开的 ChatGPT 内部接口当成已承诺契约。
