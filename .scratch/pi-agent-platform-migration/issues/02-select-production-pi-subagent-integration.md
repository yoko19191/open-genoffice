# 选择生产级 Pi Subagent 集成路径

Type: research

Status: open

## Question

在 Pi 官方示例、`@agwab/pi-subagent`、`@agwab/pi-workflow` 和本地候选中，应固定哪个
实现承载生产级 Subagent？需要验证结构化事件、Parent/Child lineage、并发与预算、
级联取消、Session 恢复、只读默认值、Mutation Grant 接入、许可证和 Electron 打包，
并说明 GenOffice 必须保留的最小 `SubagentProvider` 适配边界。
