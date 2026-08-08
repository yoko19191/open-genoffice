# Subagent 默认只读

新建 Subagent 默认只能读取被授予的 Office Context，不能获得任何 Mutation Tool。
这一默认值把并发分析与文档修改隔开，避免多个独立上下文同时改变同一文档；未来若
允许 Editor Subagent，必须由用户针对具体 Subagent、绑定文档和工具能力作出显式
Mutation Grant。父 Agent 不能代替用户授权或扩大授权范围；所有获准修改仍进入父
Session 的顺序执行、审计与统一 rollback 边界。Grant 只对当前 Subagent run 有效，
并在 Subagent 结束、取消或绑定文档关闭时自动撤销。
