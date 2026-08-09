# Office Tool 迁移目录

<!-- markdownlint-disable MD013 MD060 -->

状态：Contract Stable

主要读者：Docs、Sheets、Slides、PDF、Runtime、Electron main/preload、共享 Agent UI 与测试工程师。

本文把当前四个应用暴露给模型的工具逐项归档，再决定哪些能力继续作为 Office Tool，哪些迁入
Pi Skill、Extension、Provider Operation、Artifact Broker 或 Resource Catalog。它是代码迁移
目录，不重新设计 Pi Agent Runtime，也不允许为了保留旧工具名而保留第二套 Agent loop。

## 1. 目标与非目标

本文要固定五件事：

- 每个当前工具的 canonical ID、模型 alias、effect、actor policy 与 schema 迁移方式；
- 当前 executor、实时 Office Context、renderer/main 所有权和专用 preload channel；
- mutation 的顺序、幂等、Abort、snapshot、rollback 与不确定结果；
- 网络、Artifact、资源和用户交互能力从 Office executor 中拆出的边界；
- 每个应用切换后必须删除的旧 `AgentSkill`、transport、Genspark 和隐藏模型调用。

本文不负责：

- 重写 DOCX、XLSX、PPTX 或 PDF 领域引擎；
- 定义 Model Provider、MCP、Subagent、同步或 CredentialStore 的完整实现；
- 保留旧 `AgentToolCall` TypeScript 类型、旧 chat 历史或 Genspark 兼容层；
- 把第三方任意 Pi Extension 直接复制进安装包；依赖必须有许可、固定版本和 Activation 证据。

## 2. 盘点基线与约束

盘点基于分支 `features/pi-agent-platform-migration-spec`，业务代码仍来自
`9d37beaf57fa3eca92d60299877d248f6d1f381e`。截至 2026-08-09，四应用共有 **63 个模型可见
工具实例**：PDF 9 个，Docs 11 个，Sheets 9 个，Slides 34 个。这里按应用实例计数，因此
`web_search`、`image_search` 和 `read_attachment` 的重复实现会分别计入。

当前共同形态是 renderer 创建 `AgentSkill`，由本地 `AgentLoop` 直接调用 `buildContext()` 和
`executeTool()`。迁移后固定拆成：

```text
Pi AgentSession
  -> ToolDescriptor / model alias
  -> Runtime Office proxy
  -> Electron main OfficeToolBroker
  -> current ContextProvider + schema validation
  -> document queue / authorization / snapshot
  -> main-owned or renderer-owned ExecutorAdapter
  -> structured result + UI-only details + Tool Provenance
```

业务算法默认原样保留。只有出现以下任一条件时才允许改变 schema 或拆工具：

1. executor 同时执行网络请求和 Office mutation；
2. executor 内部启动隐藏 LLM/Agent loop；
3. executor 依赖 Genspark 登录、GSK CLI 或专有 endpoint；
4. 输入包含 renderer 不应看到的路径、URL、credential 或 Runtime 身份；
5. 现有 `mutated: boolean` 无法表达资源写入、UI 副作用或不确定 mutation outcome。

## 3. 候选冻结参数

下表是本轮代码盘点形成并已批准的稳定契约。

| ID     | 状态         | 推荐参数                                                                                                                                                                                                      | 主要权衡                                                                                   |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| OT-D01 | 已批准       | 内部 canonical ID 固定为 `office:<app>:<name>`；模型 alias 在不混合职责时沿用当前短名。App 切换完成后不保留旧 transport alias。                                                                               | 保留现有 prompt/test 资产，同时让授权与 provenance 不依赖短名。                            |
| OT-D02 | 已批准       | 每个应用 Electron main 持有唯一 Tool Catalog；Session 打开时把 descriptor snapshot 和 hash 交给 Runtime，main 在执行前用同源 TypeBox schema 再校验一次。                                                      | Runtime 不依赖 Office 业务包；renderer 也不能自行注册或扩大工具。                          |
| OT-D03 | 已批准       | 基础 `effect` 仍为 `read/mutation/external`，App 私有 metadata 增加 `scope`、`actorPolicy`、`freshness`、`retry` 和 `rollback`；wire 只投影执行所需字段。                                                     | 不修改已经冻结的通用 ToolDescriptor union，又能表达 view/resource 等真实副作用。           |
| OT-D04 | 已批准       | `goto_page` 等 view effect 仅 Parent Agent 可用；只读 Subagent 默认不能改变用户当前视图。资源 mutation 也仅 Parent 可用，首版不向 Subagent 发放资源写 Grant。                                                 | “不改文档”不等于“无用户可见副作用”；避免后台 Agent 抢焦点或改全局资产。                    |
| OT-D05 | 已批准       | Office executor 不接受外部 URL 或绝对路径。图片/附件先由 Artifact Broker 验证并签发 scope-bound `ArtifactRef`，Office Tool 只消费 `artifactId`。                                                              | `insert_image` schema 会破坏性变化，但可以彻底移除 renderer 下载、SSRF 和路径泄漏。        |
| OT-D06 | 已批准       | Docs block index、Sheets range/revision、Slides sourceId/slideIndex、PDF original page 全部使用 opaque `contextVersion` 做 freshness gate；失配返回 `stale_context`，不自动重试 mutation。                    | 把现有分散的 WeakMap/CAS/索引检查收敛成同一 Broker 契约。                                  |
| OT-D07 | 已批准       | 同文档 mutation 串行，readonly 按已冻结协议并行；所有结果按 `toolOrder` 回写。相同 `operationId + requestHash` 返回原 receipt，不同 payload 返回 `duplicate_operation_mismatch`。                             | 与文档 01/#5 一致，避免重放写入，同时不牺牲大文档并行读取。                                |
| OT-D08 | 已批准       | 每个 App 采用 catalog-complete 原子切换：缺任一必需工具、details、rollback 或 golden test 时，该 App 仍走旧入口；切换通过后同 commit 删除该 App 的旧 AgentLoop/transport，不保留 fallback。                   | 实现可以按工具族开发，生产切换仍不会出现同一文档两套运行时。                               |
| OT-D09 | 已批准       | Sheets `load_guide` 和 Slides `plan_deck` 不再作为 Office Tool；内容迁入 `open-genoffice/` 内置 Pi Skills，由 `DefaultResourceLoader` 与 Capability Snapshot 装载。                                           | 直接复用 Pi Skills，避免继续维护“为了加载 prompt 而存在的业务工具”。                       |
| OT-D10 | 已批准       | Slides `generate_deck/regenerate_slide` 的 Genspark executor 删除；首版改为内置 Slides Skill 生成受限 `SlidePageSpec`，本地 `commit_slide_page` 用 `pptxgenjs`/`pptx-engine` 构造、重开、审计并原子替换一页。 | JSON spec 比隐藏云 marker 易调试；需要新增一个窄 page renderer，但不需要新 Agent runtime。 |
| OT-D11 | 已批准       | Slides 视觉 QC 改为当前 Pi Session 的具名 Subagent；只有用户对该 actor、当前 run、文档及精确修复工具发放 Mutation Grant 后才可修改。拒绝授权时只运行确定性 QC，并明确不执行视觉自动修复。                     | 服从 Subagent 显式 mutation 授权；一次当前-run Grant 可覆盖该 QC actor 的多页修复。        |
| OT-D12 | 已由上位冻结 | 每个 Session 只绑定一个 Office 文档；最终安装包无 Genspark 登录、CLI、endpoint、文案或网络请求。                                                                                                              | 来源：迁移规格、实施规则与 GX-001～004。                                                   |

### 3.1 App 私有 descriptor metadata

`ToolDescriptor` 的通用字段沿用文档 03。每个 App 的 Catalog 在 Electron 内部还需要以下
metadata；它不会把 executor 函数或 secret 发送给 Runtime：

```ts
type OfficeToolMetadata = {
  scope: 'document' | 'view' | 'resource'
  actorPolicy: 'parent-and-readonly-subagent' | 'parent-only' | 'mutation-grant'
  freshness: 'none' | 'document' | 'selection'
  retry: 'same-operation-receipt-only' | 'safe-read'
  rollback: 'none' | 'run-snapshot' | 'tool-transaction' | 'resource-atomic-write'
  timeoutMs: number
  maxInputBytes: number
  maxOutputBytes: number
}
```

`effect=external` 只描述不会直接改变 Office 文件、但可能产生网络、view 或交互副作用的
调用。它不是绕过授权的“其他”类别；`scope` 和 `actorPolicy` 仍必须同时通过。

### 3.2 Context 与执行 receipt

ContextProvider 返回模型可见内容与不可见 freshness token：

```ts
type OfficeContextSnapshot = {
  documentId: string
  contextVersion: string
  selectionVersion?: string
  modelContent: string
  details?: unknown
}
```

模型不负责复制 `contextVersion`。Runtime 记录同 actor/run 最近一次成功 Context/read 结果，
Broker 在调用带 freshness gate 的工具时注入 token。executor 执行前再次对比实际文档版本；
用户编辑、renderer reload 或前序 mutation 使 token 失效时，返回 `stale_context`，要求重新读。

```ts
type OfficeMutationOutcome = 'not_started' | 'committed' | 'rolled_back' | 'unknown'

type OfficeToolReceipt = {
  operationId: string
  toolCallId: string
  toolId: string
  output: string
  details?: unknown
  artifacts?: ArtifactRef[]
  contextVersionAfter?: string
  mutationOutcome?: OfficeMutationOutcome
}
```

## 4. PDF 工具目录

当前来源：`apps/pdf/src/renderer/ai/pdf-skill.ts` 与 `tools.ts`。PDF editor state 仍由
renderer 持有，因此 main adapter 只通过 schema-checked preload channel 调用被动 executor。

| 当前 alias         | Target canonical ID           | Effect / actor               | 现有 executor 与迁移动作                                                  | Freshness / rollback    | 验收           |
| ------------------ | ----------------------------- | ---------------------------- | ------------------------------------------------------------------------- | ----------------------- | -------------- |
| `read_pages`       | `office:pdf:read_pages`       | read / parent+readonly-sub   | 保留 pdf.js page text 提取、10 页/24k 字符上限；结果不包含 page object。  | document / none         | OT-001/004     |
| `search_text`      | `office:pdf:search_text`      | read / parent+readonly-sub   | 保留本地 SearchIndex 与最多 40 个命中；索引未就绪返回稳定 unavailable。   | document / none         | OT-001/004     |
| `goto_page`        | `office:pdf:goto_page`        | external(view) / parent-only | 保留原始页号跳转；不标记文档 mutation，不允许后台 Subagent 抢占用户视图。 | document / none         | OT-001/005     |
| `markup_text`      | `office:pdf:markup_text`      | mutation / grant             | 保留精确文本匹配、rects 与 `all`；read-only PDF fail closed。             | document / run-snapshot | OT-002/003/004 |
| `list_form_fields` | `office:pdf:list_form_fields` | read / parent+readonly-sub   | 保留 Widget 聚合、radio export values 和当前 unsaved edit 投影。          | document / none         | OT-001/004     |
| `fill_form_field`  | `office:pdf:fill_form_field`  | mutation / grant             | 保留字段类型/选项校验；必须先有同 actor 的 field inventory freshness。    | document / run-snapshot | OT-002/003/004 |
| `rotate_page`      | `office:pdf:rotate_page`      | mutation / grant             | 保留 original page index 与 ±90°；删除页或 read-only 时拒绝。             | document / run-snapshot | OT-002/003/004 |
| `delete_page`      | `office:pdf:delete_page`      | mutation / grant             | 保留“至少一页”不变量和 unsaved delete；相同 operationId 不得重复删页。    | document / run-snapshot | OT-002/003/004 |
| `get_outline`      | `office:pdf:get_outline`      | read / parent+readonly-sub   | 保留本地 bookmark tree 展平；不把 pdf.js object 暴露跨进程。              | document / none         | OT-001/004     |

PDF Context 至少包含 file display name、原始页数、当前原始页号、read-only、outline presence
和删除页 generation。所有 mutation 使用原始页号解析，不能把当前可见页序号静默当成原始页号。

## 5. Docs 工具目录

当前来源：`apps/docs/src/renderer/ai/docs-skill.ts`、`tools.ts`、`commands.ts` 和
`protocol.ts`。ProseMirror/Tiptap executor 继续位于 renderer；`markDocSeen` 的 WeakMap 语义
迁入 `contextVersion`，不能成为新的第二套 freshness 真相源。

| 当前 alias             | Target canonical ID                | Effect / actor             | 现有 executor 与迁移动作                                                                                      | Freshness / rollback              | 验收           |
| ---------------------- | ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| `get_document_context` | `office:docs:get_document_context` | read / parent+readonly-sub | 保留 block list、selection、统计和 tracked-deletion 语义；返回新 contextVersion。                             | document / none                   | OT-001/004     |
| `read_blocks`          | `office:docs:read_blocks`          | read / parent+readonly-sub | 保留 restricted HTML、block range、24k 分页 offset；完整读取才更新 actor freshness。                          | document / none                   | OT-001/004     |
| `insert_content`       | `office:docs:insert_content`       | mutation / grant           | 保留 restricted HTML parser、空文档替换与 cursor scope；不能接收任意 ProseMirror JSON。                       | selection/document / run-snapshot | OT-002/003/004 |
| `replace_blocks`       | `office:docs:replace_blocks`       | mutation / grant           | 保留范围校验、tracked changes 与 block index shift 提示。                                                     | document / run-snapshot           | OT-002/003/004 |
| `apply_commands`       | `office:docs:apply_commands`       | mutation / grant           | 保留 command engine、顺序 batch、deleted target skip 和 changed count；Catalog 固定 command union/max batch。 | document / tool-transaction       | OT-001/002/003 |
| `web_search`           | `platform:web_search`              | external(network)          | 从 Docs Catalog 删除；复用 Runtime Extension alias，底层仅保留 Serper/DuckDuckGo 非 GSK 路径。                | none / none                       | MD-002/GX-003  |
| `image_search`         | `platform:image_search`            | external(network)          | 从 Docs Catalog 删除；搜索结果进入 UI details，选中图片先经 Artifact Broker。                                 | none / none                       | OT-005/GX-003  |
| `insert_image`         | `office:docs:insert_image`         | mutation / grant           | 保留尺寸计算和 docProtected image node；输入由 `url` 改为 `artifactId + maxWidthPx`，renderer 不再下载。      | selection/document / run-snapshot | OT-002/003/005 |
| `insert_chart`         | `office:docs:insert_chart`         | mutation / grant           | 保留 bar/line/pie、categories/series 校验与 native editable chart 写回。                                      | selection/document / run-snapshot | OT-001/002/003 |
| `edit_chart`           | `office:docs:edit_chart`           | mutation / grant           | 保留 native/generated chart 数据点约束、series 长度和 empty native point 保护。                               | document / run-snapshot           | OT-001/002/003 |

Docs executor 返回的 HTML、图片 bytes、chart cache 和完整文档正文默认只进入 Pi tool result，UI
details 只保留摘要、block range、chart/image metadata 与 Tool Provenance。

## 6. Sheets 工具目录

当前来源：`apps/sheets/src/renderer/ai/workbook-skill.ts`、`tools.ts`、`workbook-readers.ts`、
`domain/workbook-dsl.ts` 和既有 plan/apply transaction。当前 52 个 WorkbookOperation
discriminant 继续由单一 schema 约束；迁移到 TypeBox 后删除旧 Zod 声明，不能长期保留双份
union，也不能在 Runtime 另写一份宽松 schema。

| 当前 alias             | Target canonical ID                    | Effect / actor             | 现有 executor 与迁移动作                                                                                     | Freshness / rollback        | 验收               |
| ---------------------- | -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------ |
| `get_workbook_context` | `office:sheets:get_workbook_context`   | read / parent+readonly-sub | 保留 sheet id/name/data extent、selection、loaded viewport、merge/chart 摘要；revision 进入 contextVersion。 | document / none             | OT-001/004         |
| `read_range`           | `office:sheets:read_range`             | read / parent+readonly-sub | 保留 2000-cell cap、lazy load、data extent 防误判和 formula/value 输出。                                     | document / none             | OT-001/004         |
| `load_guide`           | `open-genoffice/sheets-workbook` Skill | 不再是 Tool                | guides 移入内置 Skill references，由 Pi ResourceLoader 读；旧 tool、guide state 和 prompt 拼接删除。         | run resource snapshot       | RS-004/OT-001      |
| `read_formats`         | `office:sheets:read_formats`           | read / parent+readonly-sub | 保留 200-cell cap 与 explicit-format-only 输出。                                                             | document / none             | OT-001/004         |
| `read_sheet_features`  | `office:sheets:read_sheet_features`    | read / parent+readonly-sub | 保留 filter/CF/DV/name/freeze/hidden/protected/visual/page setup inventory。                                 | document / none             | OT-001/004         |
| `read_cells`           | `office:sheets:read_cells`             | read / parent+readonly-sub | 保留 scattered-cell 100-address cap；地址规范化后再调用 executor。                                           | document / none             | OT-001/004         |
| `propose_operations`   | `office:sheets:propose_operations`     | mutation / grant           | alias 保留；schema 验证后直接走现有 plan/apply、结构类互斥、2000 expanded changes、formula read-back。       | document / tool-transaction | OT-001/002/003/004 |
| `web_search`           | `platform:web_search`                  | external(network)          | 删除 Sheets 独立 Skill；使用 Runtime 唯一 alias，数据 attribution 规则保留在内置 Sheets Skill。              | none / none                 | MD-002/GX-003      |

`propose_operations` 在 apply Promise 完成前不能返回 committed。apply 失败且 transaction 明确未
改变 workbook 时返回 `rolled_back`；renderer crash 或 IPC 断开导致是否写入未知时返回 `unknown`，
Broker 阻塞该文档后续 mutation，不能用公式 read-back 猜测提交成功。

## 7. Slides 工具目录

当前来源：`apps/slides/src/renderer/ai/slides-skill.ts`。Slides 同时混合本地 PPTX executor、
Genspark 单页生成、隐藏 LLM planning/style、图片/media Provider、用户问卷和样式资源，因此
不能把整个 `createSlidesSkill()` 原样包成一个 Office adapter。

### 7.1 保留的本地 Office executor

| 当前 alias              | Target canonical ID                   | Effect / actor             | 迁移动作与约束                                                                                                | Freshness / rollback        | 验收           |
| ----------------------- | ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------- |
| `get_deck_context`      | `office:slides:get_deck_context`      | read / parent+readonly-sub | 保留 deck outline、current page、selection；返回 deck generation。                                            | document / none             | OT-001/004     |
| `read_slide`            | `office:slides:read_slide`            | read / parent+readonly-sub | 保留 canvas、element IDs/geometry/text/color；不返回 archive object。                                         | document / none             | OT-001/004     |
| `set_element_text`      | `office:slides:set_element_text`      | mutation / grant           | 保留 paragraph/run schema与 group child 路由。                                                                | document / run-snapshot     | OT-002/003/004 |
| `set_element_style`     | `office:slides:set_element_style`     | mutation / grant           | 保留 font/paragraph style patch；unsupported native field fail closed。                                       | document / run-snapshot     | OT-002/003     |
| `set_element_transform` | `office:slides:set_element_transform` | mutation / grant           | 保留 pixel→EMU 与 connector update；同一 transaction 只生成一个 undo point。                                  | document / tool-transaction | OT-002/003     |
| `execute_slide_script`  | `office:slides:execute_slide_script`  | mutation / grant           | 保留 Acorn 受限解释器、25k step/64 depth、allowlist primitives 与 atomic geometry batch。                     | document / tool-transaction | OT-001/002/003 |
| `set_element_fill`      | `office:slides:set_element_fill`      | mutation / grant           | 保留 solid/no-fill 与 group child 路由。                                                                      | document / run-snapshot     | OT-002/003     |
| `set_element_stroke`    | `office:slides:set_element_stroke`    | mutation / grant           | 保留 color/width/remove 校验。                                                                                | document / run-snapshot     | OT-002/003     |
| `insert_web_image`      | `office:slides:insert_image`          | mutation / grant           | 旧 alias 删除；输入改为 `artifactId + slideIndex + box`，main 从 Artifact Broker 取 bytes 后调用 addPicture。 | document / run-snapshot     | OT-002/003/005 |
| `delete_slide`          | `office:slides:delete_slide`          | mutation / grant           | 保留至少一页、index shift 与 history。                                                                        | document / run-snapshot     | OT-002/003     |
| `add_slide`             | `office:slides:add_slide`             | mutation / grant           | 保留 clone-layout、clearText 和 returned slideIndex。                                                         | document / run-snapshot     | OT-002/003/004 |
| `add_text_box`          | `office:slides:add_text_box`          | mutation / grant           | 保留 editable paragraphs、box 和 returned sourceId；scratch quality 由 Skill/QC 而非 hidden cloud gate 管理。 | document / run-snapshot     | OT-001/002/003 |
| `add_shape`             | `office:slides:add_shape`             | mutation / grant           | 保留 shape/fill/stroke/text schema。                                                                          | document / run-snapshot     | OT-001/002/003 |
| `add_chart`             | `office:slides:add_chart`             | mutation / grant           | 保留 editable chart 与 data-source gate 所需 provenance。                                                     | document / run-snapshot     | OT-001/002/003 |
| `add_smartart`          | `office:slides:add_smartart`          | mutation / grant           | 保留已支持的布局 union；不承诺任意 SmartArt。                                                                 | document / run-snapshot     | OT-001/002/003 |
| `add_table`             | `office:slides:add_table`             | mutation / grant           | 保留 row/col/box/style 上限。                                                                                 | document / run-snapshot     | OT-001/002/003 |
| `edit_table_cell`       | `office:slides:edit_table_cell`       | mutation / grant           | 保留 cell bounds 与 paragraph schema。                                                                        | document / run-snapshot     | OT-002/003/004 |
| `edit_table_structure`  | `office:slides:edit_table_structure`  | mutation / grant           | 保留 add/delete row/column 与不可空表约束。                                                                   | document / tool-transaction | OT-002/003     |
| `edit_table_style`      | `office:slides:edit_table_style`      | mutation / grant           | 保留表格级 style patch。                                                                                      | document / run-snapshot     | OT-002/003     |
| `edit_chart`            | `office:slides:edit_chart`            | mutation / grant           | 保留 chart series/category/value 校验。                                                                       | document / run-snapshot     | OT-002/003/004 |
| `set_slide_background`  | `office:slides:set_slide_background`  | mutation / grant           | 保留 background fill；图片背景必须先成为 ArtifactRef。                                                        | document / run-snapshot     | OT-002/003/005 |
| `delete_element`        | `office:slides:delete_element`        | mutation / grant           | 保留 sourceId、locked element 和 connector 清理。                                                             | document / run-snapshot     | OT-002/003/004 |
| `ungroup_element`       | `office:slides:ungroup_element`       | mutation / grant           | 保留一层 group 约束和 returned child IDs。                                                                    | document / run-snapshot     | OT-002/003     |

当前 executor 还接受未注册的 `execute_layout_script` alias。它不进入新 Catalog，迁移后必须和
旧 prompt/test compatibility branch 一起删除，防止模型 alias 与 canonical ID 脱节。

### 7.2 从 Slides Office Catalog 拆出的能力

| 当前 alias             | Target owner / alias                        | 迁移动作                                                                                                                       | 验收               |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `web_search`           | Runtime Extension / `web_search`            | 与 Docs/Sheets 合并；底层删除 GSK first，保留 Serper/DuckDuckGo。                                                              | MD-002、GX-001/003 |
| `image_search`         | Runtime Extension / `image_search`          | 与 Docs 合并；候选 URL 只进安全 details，选中项经 Artifact Broker 下载。                                                       | OT-005、GX-001/003 |
| `generate_image`       | Image Provider / `generate_image`           | 使用 Codex OAuth 或用户显式配置的 Image Provider；结果是 ArtifactRef，不返回 Genspark URL。                                    | MD-004、GX-001/003 |
| `analyze_media`        | Model Media Provider / `analyze_media`      | 使用当前用户选择的模型能力与受限本地预处理；不新增隐藏账号。                                                                   | MD-002、GX-001/003 |
| `ask_clarification`    | built-in Pi Extension / `ask_user_question` | 复用 Pi Extension tool/details 模式，在共享 Agent UI 渲染；不在 Slides executor 内持有 Promise resolver。                      | AR-002、OT-005     |
| `plan_deck`            | `open-genoffice/slides-authoring` Skill     | Core Hook、style 与 page plan 变成 Skill workflow/structured text；不再把 renderer memory 当权威 plan state。                  | RS-004、AR-004     |
| `save_style_template`  | Resource Catalog / `save_style_template`    | effect=mutation、scope=resource、parent-only；写入 `~/.open-genoffice/assets/styles/slides/`，原子写并进入 Global Asset 同步。 | RS-003、SY-006     |
| `list_style_templates` | Resource Catalog / `list_style_templates`   | effect=read；列出 global/project eligible 资源并显示 provenance，不直接扫描 Electron `userData`。                              | RS-004、SY-006     |

Pi 官方 ResourceLoader/Extension factory、固定 Package、Subagent 和 tool details 能直接复用。
`pi-web` 的 Skills/Packages/Project Trust UI 行为可作为产品交互参考。仓外 `pi-config` 提供了
`ask_user_question`、web/image search、video 与 subagent 示例，但该仓当前未发现许可证，因此
只能参考协议形态，不能复制源代码或作为安装包依赖。

### 7.3 Slides 整页生成替代设计

`generate_deck` 与 `regenerate_slide` 不能直接适配。它们当前会在 renderer tool executor 内部：

1. 调用隐藏 LLM 生成 Style Skill 和 outline；
2. 调用 Genspark `/slide_generate` 生成单页 PPTX；
3. 把 `cloudpptx:<temp-path>` marker 传给 `slides:html-to-pptx`；
4. main 实际只读取云端 PPTX bytes 并 merge/replace，不再转换原始 HTML。

目标流程建议为：

```text
open-genoffice/slides-authoring Skill
  -> Parent Agent 或用户获准的具名 Slides Subagent
  -> 逐页生成受限 SlidePageSpec JSON
  -> office:slides:commit_slide_page
  -> schema / artifact / font / canvas validation
  -> pptxgenjs 生成单页 PPTX
  -> pptx-engine openPptx 重开
  -> deterministic layout + editable-text + image completeness audit
  -> 同一 transaction merge/replace
  -> 保存并再次 openPptx
  -> committed；任一步失败则保留原页
```

首版 `SlidePageSpec` 只允许确定性、可编辑的元素，不接受 HTML、JavaScript、任意 XML 或
本地路径：

```ts
type SlidePageSpec = {
  version: 1
  title: string
  canvas: { widthPx: 1280; heightPx: 720 }
  background: { color: string } | { artifactId: string }
  elements: Array<TextSpec | ShapeSpec | ImageSpec | ChartSpec | TableSpec | SmartArtSpec>
}
```

Catalog 新增：

| Target tool                       | Effect           | 用途                                                                                          |
| --------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `office:slides:commit_slide_page` | mutation / grant | `mode=append/insert/replace`，一次只提交一页；失败时 transaction rollback，原页和原文件不变。 |

`generate_deck/regenerate_slide` 旧模型 alias 和所有 cloud marker API 删除，用户意图由内置
Skill 编排多次 `commit_slide_page` 覆盖。这样长 deck 不再把所有页面塞进一次工具参数；Pi 的
Session/compaction/Subagent 是唯一调度来源。

SL-001 质量门必须全部通过才允许 commit：

- 保存后的 PPTX 能由 `openPptx` 重开；
- 所有期望文字仍是 text run，不得栅格化；
- `auditSlideLayout` 无越界、文本 overflow 和非白名单 overlap；
- 每个 ImageSpec 的 artifact hash、MIME、魔数和落地 relationship 完整；
- replace 失败时原页 bytes、索引、undo stack 和当前选择不变；
- append/insert 失败时不留下半页、临时 slide 或未引用 asset；
- 成功页产生一个 Office run rollback point，用户可恢复整个 run。

视觉 QC 不替代这些确定性门。用户授权具名 QC Subagent 后，它只能获得
`read_slide + execute_slide_script`，每页至多两轮修复；修复后重新经过同一确定性审计。

## 8. 跨应用 Artifact、附件与搜索

### 8.1 附件

Docs、Sheets、Slides 各自复制了一份 `read_attachment` Skill，当前以 renderer-visible
`path + index` 读取。迁移后只保留一个 Runtime tool：

| 当前实例               | Target                        | Effect / actor             | 迁移动作                                                                              |
| ---------------------- | ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| 三个 `read_attachment` | `platform:artifact:read_text` | read / parent+readonly-sub | 模型 alias 保留 `read_attachment`；输入改为 `artifactId + offset`，24k 分页行为保留。 |

Attachment picker 在 Electron main 注册文件并生成 ArtifactRef；Session context 只列出
artifactId、displayName、mediaType、byteLength。图片附件仍作为模型 image content，不把 base64
复制进 tool result。PDF 当前没有 attachment tool，第四阶段不顺便新增产品能力。

### 8.2 Web 与图片搜索

`packages/ai-search/src/index.ts` 可保留 Serper/DuckDuckGo 实现，但必须删除：

- `hasGskAuth()` 分支、`gskWebSearch()`、`gskImageSearch()`；
- `export * from './gsk'` 与 `export * from './genoffice-auth'`；
- `method: 'gsk'`、GSK env、登录文案和 fallback；
- renderer 的重复 IPC/Skill wrapper。

Runtime Extension 使用 Credential Reference 解析可选 Serper key；无 key 时 DuckDuckGo 是
显式 provider 状态，不把网络错误伪装成空结果。搜索结果的 title/url/snippet 可以进入 Pi
tool content，缩略图和 gallery metadata 进入 UI-only details；插图前仍必须下载成 ArtifactRef。

## 9. Authorization、并发与 rollback

| Tool 类别                 | Parent Agent             | 只读 Subagent            | 获 Grant Subagent                      | 默认队列/恢复                          |
| ------------------------- | ------------------------ | ------------------------ | -------------------------------------- | -------------------------------------- |
| document read             | 允许                     | 允许                     | 允许                                   | 可并行，按 toolOrder 回写              |
| document mutation         | 允许                     | 拒绝                     | 仅精确 actor/document/tool/current run | 同文档串行，首次 mutation run snapshot |
| view effect               | 允许                     | 拒绝                     | 首版仍拒绝                             | 不进 undo，但发布可见 details          |
| resource read             | 允许                     | Capability Snapshot 决定 | 同左                                   | 读取 run resource snapshot             |
| resource mutation         | 允许                     | 拒绝                     | 首版拒绝                               | 原子文件写，不使用 Office rollback     |
| provider/network external | Capability Snapshot 决定 | Capability Snapshot 决定 | 同左                                   | Provider 自有 lifecycle/usage policy   |

一个 Parent run 的第一次 **committed document mutation** 才创建 rollback point。验证失败、
`not_started` 或完整 `rolled_back` 不得制造空快照。多次 mutation 共用该 run snapshot；工具内部
需要全有或全无时再使用 `tool-transaction`。

Abort 只在安全边界生效：

- 尚未 dispatch：`not_started`；
- read tool：传播 AbortSignal，丢弃迟到结果；
- 可事务回滚的 mutation：回滚后返回 `rolled_back`；
- 已 commit：如实返回 `committed`，UI Stop 不能声称未修改；
- renderer/main 断连且无法证明结果：`unknown`，阻塞后续 mutation 并要求用户核对。

## 10. 稳定错误与重试

| Error code                   | 触发条件                                        | 自动重试                                             |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `tool_not_in_snapshot`       | 当前 run 未冻结该 descriptor                    | 否；下一 run 重新解析资源                            |
| `tool_alias_collision`       | canonical IDs 映射到同一 alias                  | 否；隔离冲突工具                                     |
| `invalid_tool_arguments`     | TypeBox/schema/size 失败                        | 否；模型修正参数                                     |
| `document_mismatch`          | Session/tool/document binding 不一致            | 否                                                   |
| `stale_context`              | freshness token 与当前编辑器 state 不一致       | 只允许重新 read 后用新 operationId                   |
| `mutation_grant_required`    | Subagent 调用 document mutation 且无精确 Grant  | 等用户授权；原调用不自动重放                         |
| `read_only_document`         | PDF/Office 文件不能修改                         | 否                                                   |
| `artifact_invalid`           | scope/hash/MIME/魔数/大小/path 校验失败         | 否；重新注册合法 artifact                            |
| `executor_unavailable`       | renderer reload、文档关闭或 main adapter 未注册 | read 可安全重试；mutation 只查询同 operation receipt |
| `mutation_outcome_unknown`   | 断连后无法证明写入或回滚                        | 禁止自动重试，阻塞文档 mutation queue                |
| `tool_timeout`               | 超出 descriptor budget                          | read 可由 Agent 决定重试；mutation 同上              |
| `unsupported_office_feature` | OOXML/编辑器不支持目标能力                      | 否；不得降级成破坏性重写                             |

## 11. 文件级迁移目录

建议的最小新边界：

```text
apps/{pdf,docs,sheets,slides}/src/main/agent-tools/
  catalog.ts                  # descriptor + TypeBox schema + metadata
  broker-adapter.ts           # document binding / ContextProvider / executor routing

apps/{pdf,docs,sheets}/src/renderer/agent-tools/
  context.ts                  # live editor context + contextVersion
  executor.ts                 # 现有领域函数的被动 adapter

apps/slides/src/main/agent-tools/
  executor.ts                 # main-owned PPTX mutation
  page-spec.ts                # SlidePageSpec schema
  page-renderer.ts            # pptxgenjs -> pptx-engine -> deterministic QC

apps/pi-agent-runtime/src/tools/
  office-proxy.ts
  artifact-tools.ts
  search-extension.ts

~/.open-genoffice/agent/skills/  # 安装时映射到内置只读资源，不写真实用户 HOME 源文件
  open-genoffice-sheets-workbook/
  open-genoffice-slides-authoring/
```

保留并迁入 adapter 的代码：

- PDF `tools.ts` 的 pdf.js/SearchIndex/form executor；
- Docs `protocol.ts`、`commands.ts` 与 ProseMirror mutations；
- Sheets `workbook-dsl.ts`、readers、plan/apply/transaction；
- Slides native edit、layout-script interpreter、layout audit、history 和 pptx-engine；
- 三应用附件的 24k 分页语义与 `packages/file-parse`。

新路径通过后删除：

- 四应用 `*skill.ts`、`transport.ts`、renderer `new AgentLoop()` 和旧 tool composition；
- Docs/Sheets/Slides 重复的 search/files Skill wrapper；
- Slides `generatePageCloud`、`cloudGeneratePage`、`slides:cloud-page-generate`、cloud marker set；
- Slides executor 内部 `runLlmOnce` planning/style/page generation 和独立 `slide-qc` AgentLoop；
- `ai:generate-image`、`ai:analyze-media`、`ai:gsk-*` 与 Genspark 文案；
- 最后一个 App 切换后的 `packages/agent-core` 与旧 `AgentTool*` 类型。

## 12. 测试与验收矩阵

| Gate ID | 场景                                                                  | 通过标准                                                                                  | 上位验收                   |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| OTC-001 | 从四个 Catalog 提取 descriptor manifest                               | 46 个保留 Office executor、重分类能力和 retired alias 与本文逐项一致；无未登记工具        | OT-001、GX-004             |
| OTC-002 | Runtime/main 对每个 accepted/rejected schema vector 双重校验          | 结果完全一致；超长 input、unknown field、NaN、路径、URL 注入 fail closed                  | OT-001、AR-010             |
| OTC-003 | PDF read/markup/form/rotate/delete E2E                                | 原始页语义、read-only、Abort、一次 run snapshot 和全 run rollback 通过                    | OT-002/003/004             |
| OTC-004 | Docs external edit/stale block/track changes/chart/image Artifact E2E | stale_context 可恢复；HTML 限制不放宽；图片无 renderer network；rollback 恢复原文         | OT-002/003/004/005         |
| OTC-005 | Sheets lazy read + 52 operation DSL + async apply failure             | plan/apply 单一入口；结构类互斥；失败不谎报 committed；公式 read-back 不掩盖 unknown      | OT-001/002/003/004         |
| OTC-006 | Slides native 23-tool manifest、group/table/chart/layout-script       | sourceId/freshness、script sandbox、history、connector 与 audit 保持现有行为              | OT-001/002/003/004         |
| OTC-007 | SlidePageSpec append/insert/replace 故障注入                          | PPTX 重开、文字可编辑、无越界/重叠、图片完整；任何失败原页 byte/hash/undo 不变            | SL-001、OT-003             |
| OTC-008 | QC Subagent grant/deny/revoke                                         | deny 时零 mutation；grant 仅当前 actor/run/工具；修复后重新 QC；终态撤销                  | SA-005、OT-002/003         |
| OTC-009 | 63 个旧实例的 source/network scan                                     | 无遗漏或死按钮；GSK/Genspark/cloud marker/renderer path/URL executor 全部消失             | GX-001/002/003/004         |
| OTC-010 | 同文档两 Session、并行 read、mutation、Stop、renderer crash           | read 结果按 toolOrder；mutation 不重复；unknown 阻塞；reload 后 receipt/provenance 可恢复 | RT-005/006/007/008、OT-002 |

保留现有测试作为 executor 行为基线，包括：

- `apps/pdf/tests/ai-tools.test.ts`；
- `apps/docs/tests/agent-docs.test.ts`、`ai-*-tools/test`、tracked revision tests；
- `apps/sheets/tests/workbook-skill-tools.test.ts`、`workbook-dsl.test.ts`、transaction tests；
- `apps/slides/tests/{table,layout,slide-script,slide-qc,generate-deck,regenerate-slide}.test.ts`。

旧 AgentLoop/transport 测试不能原封不动算新平台覆盖；只迁移领域断言。新增模块的 lines、
branches、functions 均需 ≥95%，并在应用切换前运行 typecheck、单元/集成、E2E、Markdown
契约校验与最终 Genspark bundle/network scan。

## 13. 应用切换与删除门

每个 App 的生产切换满足同一算法：

```text
catalog manifest 完整
  -> fake Runtime contract tests
  -> real editor read tools
  -> mutation + rollback + Abort
  -> shared Agent UI details
  -> app-specific golden E2E
  -> switch production entry
  -> delete that App AgentLoop/transport/search/files wrapper
  -> full app scan: no hidden fallback
```

推荐顺序为 PDF → Docs → Sheets → Slides native tools → Slides full-page generation。Slides
不能在 `commit_slide_page` 通过 SL-001 前删除旧整页能力；最终包也不能因为该阻塞而保留
Genspark，未完成时应阻止发行而不是静默降级。

## 14. 已批准 tracer bullets

以下拆票粒度与依赖已经批准，尚未发布到 Issue tracker：

| Local ID | Title                                                       | Type | Blocked by       | 覆盖验收                         |
| -------- | ----------------------------------------------------------- | ---- | ---------------- | -------------------------------- |
| OT-I01   | 在 PDF Panel 通过 Pi 完成读取、标注与整 run 回滚            | AFK  | #2、#4、#5       | OTC-001/002/003、OT-001～004     |
| OT-I02   | 在 Docs Panel 用 Artifact 图片与 freshness gate 完成编辑    | AFK  | #2、#4、#5、#25  | OTC-001/002/004、OT-001～005     |
| OT-I03   | 在 Sheets Panel 用内置 Skill 与 Workbook DSL 原子修改工作簿 | AFK  | #2、#4、#5、#18  | OTC-001/002/005、RS-004          |
| OT-I04   | 在 Slides Panel 迁移 23 个 native read/mutation executor    | AFK  | #2、#4、#5       | OTC-001/002/006、OT-001～005     |
| OT-I05   | 合并附件、Web/Image Search 与 ask-user 平台工具             | AFK  | #2、#8、#17、#18 | OTC-002/009、AR-002、OT-005      |
| OT-I06   | 用 SlidePageSpec 本地生成并原子替换一张可编辑整页           | AFK  | OT-I04、#18、#25 | OTC-007、SL-001、GX-001～004     |
| OT-I07   | 让获准 Slides QC Subagent 修复页面并在拒绝时保持只读        | HITL | OT-I06、#22、#23 | OTC-008、SA-005、SL-001          |
| OT-I08   | 切换四应用 Catalog 并删除 63 个旧注册点与全部 Genspark 路径 | AFK  | OT-I01～OT-I07   | OTC-009/010、AR-001、GX-001～004 |

`HITL` 只表示 OT-I07 的验收需要真实用户完成一次 Grant/deny 操作；自动化实现和大部分测试仍应
AFK。发布前需要再核对现有 Issues 是否已覆盖共享 Broker，避免重复创建 #5、#17 或 #23 的横向票。

## 15. Reader Test

无对话背景的工程师阅读本文后，应能回答：

1. 为什么当前 63 个工具实例迁移后不会对应 63 个 Office Tool？
2. 一个模型 alias 如何映射到 canonical ID，alias collision 为什么不能靠注册顺序覆盖？
3. Docs/Slides 插图为什么不能继续把 URL 交给 renderer executor？
4. Sheets `load_guide` 为什么应成为 Pi Skill，WorkbookOperation schema 的事实源在哪里？
5. `goto_page` 为什么不是 document mutation，却仍不能默认交给后台 Subagent？
6. Runtime crash 后一个不确定的 mutation 为什么不能用新 operationId 自动重试？
7. Slides 当前 `html-to-pptx` 为什么不能直接作为无 Genspark 的整页生成器？
8. `SlidePageSpec` 哪些输入被禁止，什么条件下页面才可以 commit？
9. 用户拒绝 QC Subagent Mutation Grant 后，产品还能保证什么、明确不保证什么？
10. 任一 App 切换成功后，哪些旧 `AgentSkill`、transport、IPC 和 Genspark 路径必须同批删除？
