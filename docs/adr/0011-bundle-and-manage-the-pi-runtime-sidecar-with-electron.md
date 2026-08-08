# Pi Runtime Sidecar 随 Electron 交付和管理

`open-genoffice-pi-agent-runtime` 作为独立 sidecar 随 Electron 安装包交付，由桌面端
负责启动、版本握手、健康检查、崩溃恢复和退出回收。它不是 Electron
`utilityProcess`，也不是要求用户单独安装、升级或管理的常驻系统服务。

Runtime 的同一入口应可由工程师独立启动并连接测试客户端，以便调试 AgentSession、
MCP、Extension 和 Subagent；正式运行时只接受当前 Electron 实例建立的本地认证连接。
具体可执行文件封装与本地传输方式由实现 spike 决定，但不能改变唯一 Runtime Host
和窄 IPC 契约。
