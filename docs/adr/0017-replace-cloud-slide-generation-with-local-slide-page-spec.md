# ADR 0017：以本地 SlidePageSpec 流程取代云端整页生成

日期：2026-08-09

状态：Accepted

## 背景

现有 Slides `generate_deck` 与 `regenerate_slide` 并不是普通 Office executor。它们会在
renderer 内启动隐藏模型规划，经 Genspark `slide_generate` 取得单页 PPTX，再用
`cloudpptx:<temp-path>` marker 交给 main process 合并或替换页面。这条路径同时拥有 Agent
编排、外部网络、临时文件和文档 mutation，无法纳入 Pi `AgentSession` 的唯一运行时、
Artifact Broker、Subagent 授权和 Office rollback 契约。

首版 Slides 整页质量门已经由
[ADR 0016](0016-set-the-first-release-quality-gate-for-full-page-slides.md) 固定，但仍需决定模型
产物的形态、页面构造的所有权，以及视觉 QC 是否可以直接修改文档。

## 决策

删除 `generate_deck`、`regenerate_slide`、Genspark `slide_generate`、cloud marker 和隐藏
Slides/Slide QC AgentLoop。用户的“生成整套演示文稿”或“重做当前页”意图由内置
`open-genoffice/slides-authoring` Pi Skill 编排，模型每次只生成一页受限、带版本的
`SlidePageSpec`。

`SlidePageSpec` 只接受可确定性构造、可编辑和可审计的元素。首版允许文本、形状、图片、
图表、表格与已支持的 SmartArt；拒绝 HTML、JavaScript、任意 OOXML、任意本地路径、外部
URL、未登记字体和未验证的图片 bytes。图片只能通过当前文档和 run 可见的 `ArtifactRef`
引用。

Electron main 拥有 `office:slides:commit_slide_page`。它按以下顺序执行：

```text
validate SlidePageSpec and ArtifactRef
  -> render one candidate page with pptxgenjs
  -> reopen with pptx-engine
  -> deterministic layout/editability/image audit
  -> append, insert or replace in one transaction
  -> save and reopen the complete PPTX
  -> commit one run rollback point
```

任一步失败都不得改变原页、页序、当前选择或 undo stack。append/insert 失败不得留下临时页或
未引用 asset；replace 失败必须证明原页 bytes/hash 保持不变。只有 ADR 0016 的全部确定性质量
门通过，receipt 才能报告 `committed`。

视觉 QC 是当前 Pi Session 的具名 Subagent，而不是第二套 Agent Runtime。它默认只读，只能
读取当前页面和确定性审计结果。只有用户针对该 actor、当前 run、当前文档与精确修复工具
签发 Mutation Grant 后，Runtime 才向其暴露 `execute_slide_script`。首版每页最多两轮修复，
每轮后必须重新执行同一确定性审计；拒绝、撤销或过期时不发生 mutation。

## 被拒绝的方案

### 保留云端单页生成并只替换账号层

该方案仍把页面质量、临时文件和网络 mutation 隐藏在外部服务中，无法满足最终安装包无
Genspark 网络依赖，也不能形成可离线复现的验收证据。

### 让模型直接生成 HTML、JavaScript 或 OOXML

这类输出表达力高，却扩大脚本执行、文件访问和格式注入边界，也很难证明文字可编辑、图片
关系完整及失败不改原页。已有 `html-to-pptx` 路径不能作为新运行时的可信页面协议。

### 只暴露底层 add_text_box/add_shape 等工具

底层工具适合增量编辑，却会把一页生成拆成大量不可原子提交的 mutation。中途取消、模型
失败或 compaction 后难以恢复完整页面，也无法在替换前统一执行质量门。

### 允许 QC Subagent 自动获得写权限

视觉检查不等于用户授权。自动继承 Parent Agent 权限会破坏 Subagent 默认只读与精确
Mutation Grant 的平台不变量。

## 结果

- 新增一个窄的本地 page renderer 和 `commit_slide_page`，但不新增 Agent runtime。
- `SlidePageSpec` 的 TypeBox 定义随实现放在 Slides Catalog 附近，并由代码生成 JSON Schema
  与 accepted/rejected vectors；文档不维护第二份手写 schema。
- 长 deck 由 Pi Session、Skill、compaction 与 Subagent 编排多次单页提交；一次工具调用不再
  携带整套演示文稿。
- 确定性审计是 commit 前硬门，视觉 QC 只能补充，不能覆盖或绕过硬门。
- 正式构建在新路径未通过前阻止发行；不得保留 Genspark 或旧 AgentLoop 作为回退。

## 验证

- `OTC-007`：append/insert/replace 的 accepted/rejected vectors 与故障注入。
- `OTC-008`：QC Subagent 的 grant、deny、revoke 与终态撤销。
- `SL-001`：PPTX 可打开、文字可编辑、无越界和非预期重叠、图片完整、失败保留原页。
- `GX-001`～`GX-004`：依赖、文本、网络与旧能力入口全部清零。

实现细节与删除清单见
[Office Tool 迁移目录](../pi-agent-platform/04-office-tool-migration-catalog.md)。
