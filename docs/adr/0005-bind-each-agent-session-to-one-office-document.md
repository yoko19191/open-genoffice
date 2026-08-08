# 每个 Agent Session 只绑定一个 Office 文档

一个 Pi `AgentSession` 在整个生命周期内只对应一个 Office 文档；同一文档可以拥有
多条独立 Session，但一条 Session 不在多个文档之间隐式切换。这个边界让 Office
Context、工具权限、附件和 rollback 始终有唯一归属，也避免项目级共享会话把不同
文档的修改历史混在一起。
