# Office Tool 迁移目录

状态：Scaffold

主要读者：Docs、Sheets、Slides、PDF、Runtime 与测试工程师。

## 目标

[待共同编写] 逐项映射现有约 60 个 Office 工具到 Pi custom tool，不重写领域 executor，
同时固定实时 Context、read/mutation、授权、顺序执行、UI details 和 rollback。

## 工具记录模板

每个工具至少记录：

| 字段              | 含义                                          |
| ----------------- | --------------------------------------------- |
| Tool ID / 应用    | Pi 稳定名称与适用编辑器                       |
| 现有 executor     | 当前实现和 owner                              |
| 输入/输出 schema  | 模型可见数据与 UI-only details 的边界         |
| Context           | 每轮需要的 selection/page/range/document 状态 |
| Effect            | read-only 或 mutation，是否可重试/幂等        |
| Authorization     | 主 Agent/Subagent/MCP actor 的允许条件        |
| Snapshot/Rollback | 首次 mutation 快照与失败恢复                  |
| Error/Cancel      | 稳定错误、Abort 和部分执行语义                |
| Acceptance IDs    | 对应测试与黄金 fixture                        |
| Cutover/Delete    | 新入口和应删除的旧类型/transport              |

## PDF 工具

[待代码盘点]

## Docs 工具

[待代码盘点]

## Sheets 工具

[待代码盘点]

## Slides 与 Slide QC 工具

[待代码盘点]

## 跨应用工具与附件

[待代码盘点]

## 候选 tracer bullets

[待 `to-issues` 提取] 按用户可完成的窄工作流切片，而不是每个工具一票；同一切片包含工具
schema、executor adapter、Agent 调用、UI details、回滚与黄金测试。

## Reader Test

[待编写] 读者应能选择任一工具并准确说出它读什么、改什么、谁能调用、失败如何恢复、
何时可以删除旧路径。
