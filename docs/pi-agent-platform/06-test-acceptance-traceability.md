# 测试与验收追踪矩阵

状态：Scaffold

主要读者：所有实现 owner、QA、CI、发布负责人和 Reviewer。

## 目标

[待共同编写] 将迁移规格的每个验收 ID 映射到具体测试层、fixture、平台、CI job、证据
产物和 owner；没有映射的实现不能进入发布列车。

## 测试层级

[待共同编写] unit、schema/contract、integration、Electron E2E、native packaging、live
provider、security/failure injection、golden Office artifact 和 release audit 的职责。

## 验收 ID 追踪表

| ID        | 行为     | 测试/fixture | 平台/CI  | Owner    | 状态    | Issue |
| --------- | -------- | ------------ | -------- | -------- | ------- | ----- |
| AR        | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |
| OT        | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |
| MD/RS     | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |
| MCP/SA    | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |
| OCR/SY/SL | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |
| GX/PK/QA  | [待映射] | [待映射]     | [待映射] | [待确认] | Missing | -     |

## Fixture 与黄金样本目录

[待共同编写] fake Provider、MCP server、Subagent、四应用 Office 文件、MinerU 固定产物、
Codex 图片、WebDAV/S3、恶意项目与升级清理样本的来源、敏感性和更新规则。

## Mock、Live 与配额边界

[待共同编写] 普通 CI 禁止云上传/计费；哪些真实 Provider/OAuth/OCR/同步测试需要人工授权、
隔离账号和发行证据。

## 覆盖率与失败注入

[待共同编写] 新模块 lines/branches/functions ≥95%，取消、崩溃、断网、过期凭据、stale CAS、
renderer reload、进程树和磁盘失败矩阵。

## 候选 tracer bullets

[待 `to-issues` 提取] 测试随每个行为切片进入同一 Issue；这里只为跨切片测试基础设施、
黄金 fixture 治理和发行矩阵创建独立端到端票。

## Reader Test

[待编写] 读者应能从任一验收 ID 找到唯一证据，判断哪些测试可以自动运行、哪些需要人工
授权，以及失败会阻断哪个 gate。
