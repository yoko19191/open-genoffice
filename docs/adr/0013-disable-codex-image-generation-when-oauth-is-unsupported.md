# Codex OAuth 不支持图片时禁用图片生成

Codex OAuth 图片生成必须经过真实账户兼容性 spike。若不存在受支持且可稳定依赖的图片
接口，GenOffice 仍可发布，但图片生成功能必须禁用并向用户明确说明原因；不得调用未
公开的 ChatGPT 内部接口，也不得用 OpenAI API key、OpenRouter 或其他计费通道静默
替代。后续只有在兼容性测试重新通过后才能开启该能力。
