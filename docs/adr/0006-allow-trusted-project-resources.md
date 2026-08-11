# 允许受信项目携带 .open-genoffice 资源

除了 `~/.open-genoffice` 中的全局资源，Office 项目可以携带项目级
`.open-genoffice` 配置与资源；平台必须先按项目根目录取得显式信任，才允许装载或
执行它们。这样保留可移植的项目工作流，同时不让打开一个陌生项目自动执行
Extension、启动 MCP server 或改变 Agent 工具集。
