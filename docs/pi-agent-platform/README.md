# Pi Agent Platform 执行文档索引

<!-- markdownlint-disable MD013 MD060 -->

状态：Contract Stable

本目录把已经批准的迁移规格转换为工程契约、纵向切片和发布证据。架构决策仍以
[迁移规格](../superpowers/specs/2026-08-07-pi-agent-platform-migration.md)、
[最终实施规则](../superpowers/specs/2026-08-09-pi-agent-platform-implementation-rules.md)、
[`CONTEXT.md`](../../CONTEXT.md) 与 `docs/adr/` 为准；这里不重新讨论已经关闭的选型。

## 文档集合

| 顺序 | 文档                                                              | 当前状态        | Issue 检查点                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [Runtime IPC 与 Session 契约](01-runtime-ipc-session-contract.md) | Contract Stable | [#1](https://github.com/yoko19191/open-genoffice/issues/1)–[#7](https://github.com/yoko19191/open-genoffice/issues/7) 已发布                                                                 |
| 2    | [数据、配置与安全契约](02-data-config-security-contract.md)       | Contract Stable | [#8](https://github.com/yoko19191/open-genoffice/issues/8)–[#16](https://github.com/yoko19191/open-genoffice/issues/16)、[#24](https://github.com/yoko19191/open-genoffice/issues/24) 已发布 |
| 3    | [子系统详细设计](03-subsystem-designs.md)                         | Contract Stable | [#17](https://github.com/yoko19191/open-genoffice/issues/17)–[#26](https://github.com/yoko19191/open-genoffice/issues/26) 已发布                                                             |
| 4    | [Office Tool 迁移目录](04-office-tool-migration-catalog.md)       | Contract Stable | 63 个现有工具实例与 OT-D01～OT-D12 已冻结；OT-I01～OT-I08 已发布为 [#29](https://github.com/yoko19191/open-genoffice/issues/29)～[#36](https://github.com/yoko19191/open-genoffice/issues/36) |
| 5    | [应用切换手册](05-application-cutover-playbooks.md)               | Contract Stable | PDF → Docs → Sheets → Slides/Slide QC 原子切换、删除与证据门已冻结；复用 [#29](https://github.com/yoko19191/open-genoffice/issues/29)～[#36](https://github.com/yoko19191/open-genoffice/issues/36) |
| 6    | [测试与验收追踪矩阵](06-test-acceptance-traceability.md)          | Contract Stable | 全部验收已映射；QA-I01～02 为 [#27](https://github.com/yoko19191/open-genoffice/issues/27)～[#28](https://github.com/yoko19191/open-genoffice/issues/28)，QA-I03～04 为 [#37](https://github.com/yoko19191/open-genoffice/issues/37)～[#38](https://github.com/yoko19191/open-genoffice/issues/38) |
| 7    | [打包、升级与运维手册](07-packaging-upgrade-operations.md)        | Contract Stable | Runtime bundle、三平台、升级/卸载与发布门已冻结；PK-I01～PK-I06 已发布为 [#39](https://github.com/yoko19191/open-genoffice/issues/39)～[#44](https://github.com/yoko19191/open-genoffice/issues/44) |

七份执行文档已经按 `01 → 02 → 03 → 04 → 05 → 06 → 07` 全部达到
`Contract Stable`。RT、DS、SS、OT、QA 与 PK 切片均已按依赖顺序发布；实施从 G0 的协议与
fake Provider 基线进入实际代码，测试和删除证据随每个纵向切片交付，不在功能完成后补写。

Slides 整页生成的实现选择由
[ADR 0017](../adr/0017-replace-cloud-slide-generation-with-local-slide-page-spec.md) 固定；
[ADR 0016](../adr/0016-set-the-first-release-quality-gate-for-full-page-slides.md) 继续作为质量门。

需要在独立窗口持续执行整个迁移时，直接使用
[端到端实施 Goal Prompt](implementation-goal-prompt.md)。它授权创建实施分支、按切片提交和
推送，并把真实云服务、签名与破坏性边界保留为 HITL 停止点。

## 共创状态

每份文档依次经过：

```text
Scaffold -> Draft -> Contract Stable -> Reader Tested -> Approved for Implementation
```

- `Scaffold`：只固定结构和输入材料。
- `Draft`：正在逐节共同编写，仍允许改变接口。
- `Contract Stable`：关键接口、状态、错误与验收门已经冻结，可以提取实施票。
- `Reader Tested`：无对话背景的读者能正确回答使用和实现问题。
- `Approved for Implementation`：用户确认，Issue 已发布并回写真实编号。

## `to-issues` 工作流

每份文档不等全部完成才拆票：

1. Scaffold 完成时记录候选 tracer bullet，但不发布。
2. Contract Stable 时把契约拆成端到端纵向切片；每票必须贯穿必要的 schema、Runtime、
   Electron/UI、测试和清理路径，并能独立演示或验证。
3. 向用户展示编号化切片，标记 `AFK/HITL`、`Blocked by` 和覆盖的验收 ID，校准粒度、
   依赖和是否需要合并/拆分。
4. 用户批准后按依赖顺序发布 GitHub Issues。当前沿用仓库的 `enhancement` 标签，执行模式
   写入 Issue 正文；不擅自增加标签。
5. 将真实 Issue 编号、状态和依赖回写对应文档及本索引。

Issue 必须描述完整用户行为，不创建“只写 schema”“只做 UI”“只补测试”这类无法独立
验收的横向票。HITL 只用于确实需要用户决策或人工发行凭据的切片，其余优先 AFK。

## 统一章节要求

每份执行文档至少回答：目标与非目标、当前代码落点、权威数据和进程边界、接口/状态机、
错误/取消/恢复、安全与隐私、文件级影响、测试与验收 ID、迁移/删除/回滚、Issue 切片和
Reader Test 问题。未知内容标记 `[待共同确认]`，不能用实现阶段再说代替契约。
