# 将 Agent 资源隔离在 ~/.open-genoffice

GenOffice 不与 Pi CLI 或 Pi Web 共享 `~/.pi/agent`，全局 Agent 配置、会话和
资源默认归属 `~/.open-genoffice`。这牺牲了直接跨产品续接会话的能力，换取
独立的升级、信任、凭据和数据生命周期；GenOffice 仍采用 Pi 原生格式与加载
接口，但不会把另一款 Pi 客户端的全局资源隐式带入 Office 应用。
