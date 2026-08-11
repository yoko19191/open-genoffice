# 使用 Pi AgentSession 作为唯一 Agent 运行时

GenOffice 将以 `@earendil-works/pi-coding-agent` 的 `AgentSession` 作为
Agent 编排、消息历史、工具事件、压缩与会话恢复的唯一事实源，并删除自研
`@genoffice/agent-core` 及 Provider 消息转换层。Office 编辑器仍拥有领域工具、
实时上下文和撤销能力，但不再维护另一套 Agent 循环或会话协议；这样才能复用
Pi 的 Skills、Packages、Extensions 与后续生态，而不是在 Pi 外再造兼容层。
