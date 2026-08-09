# 测试与验收追踪矩阵

<!-- markdownlint-disable MD013 MD060 -->

状态：Contract Stable

主要读者：所有实现 owner、QA、CI、发布负责人和 Reviewer。

本文为迁移规格中的每个验收 ID 指定测试层、fixture、执行环境和证据所有权。功能代码、测试
和旧路径删除必须在同一纵向 Issue 或其直接阻塞票中完成；没有可重复证据的行为不视为完成。

## 1. 验收原则

1. **确定性优先**：schema、状态机、Office 文件不变量、授权和删除扫描必须由确定性断言
   判定，不能让模型或人工视觉判断替代。
2. **测试跟随行为**：每个 tracer bullet 同时交付 unit、contract、integration、E2E 与删除
   断言；不在切换后另开“补测试”票。
3. **真实服务最小化**：普通 PR CI 不上传文件、不消耗模型/OCR 配额、不读取个人凭据。真实
   OAuth、MinerU、WebDAV/S3 和签名包只在隔离的手动发行 job 中运行。
4. **原生证据不可替代**：macOS、Windows、Linux 的 Runtime、socket、权限、签名、安装、
   进程树和卸载必须在目标平台 runner 实跑；交叉构建只算静态预检。
5. **证据可追溯**：每个结果关联 commit、platform、arch、protocolVersion、catalogHash、
   fixture hash 和验收 ID。prompt、正文、secret、签名 URL 与图片 base64 不进入证据。
6. **失败即关门**：安全、数据完整性、Genspark-Free、进程回收和 Slides 原页保留不接受
   flaky retry、已知问题豁免或手工 override。

## 2. 测试层与职责

| 层级                | 主要职责                                                                | 不能证明什么                                      |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Unit                | parser、resolver、policy、state reducer、hash、queue、retry/rollback    | Electron 边界、真实进程、安装包                   |
| Schema/contract     | TypeBox accepted/rejected vectors、wire 版本、双端校验一致              | Office executor 实际改变文件                      |
| Integration         | Runtime ↔ Electron main、Credential broker、MCP/Subagent、Object Store | renderer 行为、系统签名、真实服务兼容             |
| Electron E2E        | Panel、preload、Session、Office Context、授权、reload、Stop             | 安装后路径、目标平台进程监督                      |
| Golden Office       | DOCX/XLSX/PPTX/PDF 保存、重开、可编辑、未触及内容保留、失败原件不变    | 模型服务的认证和配额                              |
| Security/fault      | 恶意输入、路径/URL、token、crash、断网、未知 mutation、archive bomb    | 第三方服务当前可用性                              |
| Native package      | manifest/hash/arch、UDS/Named Pipe、Job Object、sign/install/uninstall | 云 Provider 业务正确性                            |
| Live provider       | OAuth、Responses 图片、MinerU、真实 WebDAV/AWS 的当前协议               | 普通 PR 的回归稳定性                              |
| Release audit       | lockfile、SBOM、license/notices、bundle 字符串/依赖/网络清零            | 单个领域 executor 的细节正确性                    |

旧 `AgentLoop`、transport 或 Genspark mock 测试不能原样计入新平台覆盖。可复用的是 Office 领域断言、
合法 fixture 和未修改内容保留规则。

## 3. CI 与手动验证作业

现有 `.github/workflows/ci.yml` 继续承担 Linux lint、typecheck、unit、fixture drift、Sheets
compatibility 与 Electron Shell E2E。实现时在不削弱现有 job 的前提下增加：

| Job/工作流                 | 触发                   | 内容与输出                                                               |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `ci / contract`            | 每个 PR                | protocol/schema vectors、fake Provider、Catalog snapshots、policy tests |
| `ci / coverage`            | 每个 PR                | 新平台模块 lines/branches/functions 报告与 95% 门                       |
| `ci / genspark-source`     | 每个 PR                | 生产 source/dependency/lockfile/route/i18n 禁止项扫描                    |
| `ci / electron-e2e`        | 每个 PR                | Linux xvfb 下共享 Panel、Office bridge、fake MCP/Subagent/Provider       |
| `native-runtime-smoke`     | PR label 或 merge train | macOS/Windows/Linux 原生 Runtime、IPC、进程树与 unsigned package smoke  |
| `live-provider-evidence`   | 手动、受保护环境       | 云/本地模型、Codex OAuth 图片、MinerU；上传脱敏 evidence manifest        |
| `sync-provider-evidence`   | 手动、受保护环境       | MinIO/AWS S3、loopback 与两种真实 WebDAV contract                       |
| `release-candidate-audit`  | RC tag                 | 签名安装包、升级/卸载、SBOM、license/notices、Genspark network audit    |

手动作业必须限制到受保护 environment，运行前显示将使用的第三方服务和是否上传测试文件。任何个人
OAuth cache、MinerU token 或用户文档不得作为 runner cache/artifact 保存。

## 4. 验收 ID 追踪表

### 4.1 Runtime 与 Office Bridge

| ID     | 权威测试/fixture                                             | 环境                       | Owner / 证据                         |
| ------ | ------------------------------------------------------------ | -------------------------- | ------------------------------------ |
| AR-001 | production import graph、构造器 spy、bundle dependency scan  | contract + release audit   | Runtime；唯一 `AgentSession` 证明    |
| AR-002 | fake Provider 固定 message/thinking/tool/compaction 序列     | unit + Electron E2E        | Runtime/UI；ordered event manifest   |
| AR-003 | 长模型、Office tool、MCP、Subagent 的统一 Abort fixture      | integration + native smoke | Runtime；2s/5s 时限与进程树证据      |
| AR-004 | renderer reload、应用重启、Runtime crash 后恢复              | Electron E2E               | Session/UI；无重复 cursor/message    |
| AR-005 | 同文档 fork、独立 fork、navigate 与 writer lease            | integration                | Session Store；branch DAG snapshot   |
| AR-006 | 长上下文、tool-call/result 配对、恢复后再次调用 Office tool  | contract + Electron E2E    | Runtime；compaction transcript hash  |
| AR-008 | 多版本 legacy userData fixture 连续执行两次清理              | upgrade E2E                | Electron/Data；删除与幂等清单        |
| AR-009 | spawn、ready、shutdown、crash、父 stdin EOF、独立 debug      | 三平台 native smoke        | Electron utils；process/socket census |
| AR-010 | token/version/parent PID/replay/renderer direct-connect 拒绝 | 三平台 native smoke        | Protocol/Security；拒绝码矩阵        |
| OT-001 | 四 App Catalog manifest 与 accepted executor vector         | contract + app integration | App owner；catalogHash 与 46 个 executor |
| OT-002 | 同文档并发写、跨文档并行、toolOrder receipt                 | integration + Electron E2E | Broker；无竞态/重复 mutation         |
| OT-003 | 第一次 committed snapshot、全 run rollback、unknown block   | Golden Office E2E          | App owner；输入/输出/回滚 hash       |
| OT-004 | selection/page/range/sourceId 外部变化与 stale_context      | Electron E2E               | App owner；freshness vector          |
| OT-005 | image/link/text/summary details 与模型 content 分离         | UI contract                | UI；serialized projection snapshot   |

### 4.2 模型、资源、MCP 与 Subagent

| ID      | 权威测试/fixture                                             | 环境                          | Owner / 证据                         |
| ------- | ------------------------------------------------------------ | ----------------------------- | ------------------------------------ |
| MD-001  | fake + 一个隔离云 Provider 的 stream/thinking/tool sequence  | PR mock + live provider       | Runtime Provider；能力清单/receipt   |
| MD-002  | 本地 OpenAI-compatible fixture 与 Ollama/vLLM/LM Studio 之一 | integration + 手动 smoke      | Provider；endpoint/tool result       |
| MD-003  | renderer/IPC/session/log/config secret canary scan           | security E2E                  | Credential；零命中报告               |
| MD-004  | Codex OAuth login/refresh/expiry/logout，不读外部 Agent home | fake broker + live OAuth      | Credential/Provider；脱敏状态序列    |
| MD-005  | Codex Responses complete/partial/401/429/400/Abort/schema drift | mock + live OAuth + package | Image Provider；asset hash/usage     |
| RS-001  | 临时 HOME 与 filesystem access recorder                     | integration + package smoke   | Resource；只创建 `.open-genoffice`  |
| RS-002  | Skill discover/load/disable/update/hash change              | ResourceLoader integration    | Resource；snapshot diff              |
| RS-003  | Package install/enable/disable/uninstall 与资源计数         | Package integration           | Resource；lock/resource manifest     |
| RS-004  | 未受信项目、路径逃逸、同名内置/global/project 资源          | security fixture              | Trust；隔离原因矩阵                  |
| RS-005  | exact npm/fixed Git/local hash accepted，range/ref rejected | contract                      | Package；lockfile vectors            |
| MCP-001 | stdio fixture 的 discover/call/cancel/restart/stderr/exit   | integration + native Windows  | MCP；tool provenance/process census  |
| MCP-002 | Streamable HTTP mock 的 OAuth/timeout/reconnect/result unknown | integration                 | MCP；server state/receipt            |
| MCP-003 | UI 启停 server/tool、alias collision、provenance           | Electron E2E                  | MCP/UI；Capability Snapshot diff     |
| MCP-004 | secret canary、env allowlist、actor policy、renderer attack | security E2E                  | MCP/Security；零泄漏/拒绝证据        |
| SA-001  | 两层 Subagent 的 lineage/status/model/duration/result        | fake Subagent E2E             | Subagent/UI；run tree snapshot       |
| SA-002  | concurrency/depth/token/time/tool budget 边界               | deterministic unit/E2E        | Subagent；结构化 budget terminal     |
| SA-003  | Parent cancel 对并行后代与内部 tool 的 child-first 取消     | integration + native smoke    | Subagent；终态与进程树               |
| SA-004  | 新 Subagent 工具快照不含 mutation、越权 canonical ID 调用   | policy E2E                    | Authorization；拒绝事件              |
| SA-005  | 用户 grant/deny，actor/document/run/tool 精确匹配           | UI + policy E2E               | Authorization/UI；Grant audit        |
| SA-006  | complete/fail/cancel/close/reload 后撤销及父 run rollback   | Electron E2E                  | Authorization/App；撤销/回滚 hash    |

### 4.3 OCR、同步、Slides 与发布

| ID      | 权威测试/fixture                                               | 环境                         | Owner / 证据                          |
| ------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| OCR-001 | clean install、OCR off、network recorder                        | Electron E2E + package smoke | OCR/UI；零 MinerU 请求                |
| OCR-002 | 首次开启披露、接受/拒绝、持续授权、关闭                         | UI E2E                       | OCR/UI；授权状态序列                  |
| OCR-003 | 精准解析 signed upload/poll/download 与唯一 DOCX 校验           | mock + live MinerU           | OCR；原 PDF/DOCX hash                 |
| OCR-004 | timeout/quota/expired URL/fail/local cancel/restart capsule     | provider integration         | OCR；状态与后续网络停止证据           |
| OCR-005 | token/URL/task/document canary 的 IPC/session/log 扫描           | security E2E                 | OCR/Security；零命中报告              |
| OCR-006 | 正文/公式/表格/图片/扫描黄金语料与并排 UI                       | fixed result + live regression | OCR/QA；rubric 与限制文案            |
| SY-001  | loopback + 两种真实 WebDAV 的 ETag/CAS/CRUD/retry/progress       | contract + live sync         | Sync；provider compatibility report  |
| SY-002  | MinIO + AWS S3 的 conditional put/config/path-style/encryption  | contract + live sync         | Sync；同一 repository suite          |
| SY-003  | 双客户端同 parent 分叉、Local Current、Conflict Copy、resolve   | deterministic E2E            | Reconciler；revision DAG/hash         |
| SY-004  | offline queue、disable、secret/trust/device exclusion           | integration + package inspect | Sync/Security；namespace manifest    |
| SY-005  | 跨设备拉取绑定 Session、documentId、fork 与 writer lease         | two-client E2E               | Session/Sync；恢复 transcript hash    |
| SY-006  | Global Assets/Skills/Extensions/Prompts/lock/MCP config 增量同步 | two-client E2E               | Sync/Resource；namespace diff         |
| SY-007  | 新设备/hash 变化后可执行与联网资源重新 Activation                | security E2E                 | Trust/Resource；禁用/授权序列         |
| SY-008  | 拒绝 HTTP、TLS interception、SSE-S3/SSE-KMS 配置                | network security + live S3   | Sync/Security；transport report       |
| SL-001  | SlidePageSpec golden + 每阶段故障注入                            | PPTX engine + Electron E2E   | Slides；重开/QC/原页 hash             |
| GX-001  | package/lockfile/node_modules/asar/unpacked dependency scan     | PR + release audit           | Build；禁止依赖零命中                 |
| GX-002  | production source/i18n/resource/bundle string allowlist scan    | PR + release audit           | Build/Product；仅历史文档白名单       |
| GX-003  | 全功能 E2E DNS/HTTP recorder 拒绝 Genspark endpoint             | package network audit        | Security；网络零命中                  |
| GX-004  | 旧云能力→替代/删除 UI 路由快照                                  | product acceptance           | Product/QA；无 dead button            |
| PK-001  | Node bundle/manifest/hash/arch/ESM/Extension/MCP/native module   | 三平台原生安装包             | Release；安装与首次启动 evidence      |
| PK-002  | nested signing、Named Pipe/Job Object、executable bit、退出回收  | 三平台 RC                    | Release/Security；签名与 process census |
| QA-001  | 新模块三维覆盖率、全仓 test/typecheck/lint/license/notices       | PR + RC                      | QA；报告与命令清单                    |

### 4.4 Office Tool Catalog 局部门

文档 04 的 `OTC-001`～`OTC-010` 是 OT/SL/GX 的更细粒度前置门。它们分别由 `OT-I01`～
`OT-I08` 所有，必须出现在对应 Issue 的 evidence manifest；不得因为上位 `OT-*` 通过而省略
Catalog 数量、双端 schema、每应用 golden、QC Grant、63 实例清理或 unknown receipt 测试。

## 5. Fixture 与黄金样本目录

实现时按 owner 把可执行 fixture 放在测试旁，不在 `docs/` 维护第二份数据：

```text
packages/agent-runtime-protocol/tests/vectors/
  envelopes/ office-tools/ receipts/ errors/
apps/pi-agent-runtime/tests/fixtures/
  fake-provider/ fake-home/ mcp-stdio/ mcp-http/ subagents/ provider-operations/
apps/{pdf,docs,sheets,slides}/tests/fixtures/agent/
  accepted/ rejected/ failure-injection/
apps/slides/tests/fixtures/page-spec/
  accepted/ rejected/ golden/
packages/project-store/tests/fixtures/sync/
  manifests/ forks/ tombstones/ malicious/
e2e/fixtures/agent-platform/
  legacy-user-data/ project-trust/ attachments/
```

继续复用已有 Office fixture 与生成器，特别是 `fixtures/generated`、Sheets compatibility
fixtures 和 `packages/pptx-engine/tests/fixtures`。新增 fixture 必须：

- 使用合成内容或拥有可再分发许可的文件，并在目录 README 记录来源、许可证与预期断言；
- 由生成器产生时固定 zip entry time、随机种子、排序和格式版本，CI 重生成后必须零 diff；
- rejected vector 每个文件只表达一个拒绝原因并断言稳定错误码；
- golden 输出较大时保存输入、生成脚本与结构/hash 断言，不盲目提交整批截图或云结果；
- MinerU、Codex 图片和真实同步输出先脱敏，保存协议 fixture 需移除 token、URL query、task ID、
  account ID、用户文本和供应商可能返回的追踪 header。

`SlidePageSpec` 至少覆盖：CJK 标题/正文、full-bleed 图片、chart/table、合法重叠白名单、无图页，
以及越界、overflow、非法 overlap、缺失 Artifact、MIME/魔数/hash 不符、未知 spec version、
不支持字体和每个原子提交阶段失败。

## 6. Mock、Live 与配额边界

| 能力             | 普通 CI                                             | 手动/RC                                                     |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| Model Provider   | fake SSE/Responses、固定 usage、错误/取消           | 隔离云账号 + 一个本地 OpenAI-compatible endpoint            |
| Codex OAuth      | fake Credential broker 与固定 Responses events     | 测试账号登录/刷新/退出和一张 `gpt-image-2` 图片              |
| MinerU           | signed URL/poll/archive mock + 脱敏固定结果         | 经授权上传合成黄金 PDF，精准解析，一文件一批                 |
| MCP              | repo-local stdio 与 loopback HTTP/OAuth             | RC 不要求第三方 MCP；原生平台必须跑进程与 socket             |
| WebDAV           | loopback server                                     | 至少两个真实实现，不使用个人文件                             |
| S3               | MinIO                                               | 隔离 AWS bucket，生命周期规则自动清理测试 prefix             |
| Office 模型 E2E  | fake Provider 决定性 tool calls                     | 云/本地模型各一个代表性流程，不用模型主观判断文件正确性      |

live job 失败必须区分“产品回归”“供应商不可用”“凭据/配额前置条件失败”。后两者不能被误报为通过，
也不能阻塞普通 PR；RC 发布时所有必需 live evidence 必须在规定有效期内重新取得。

## 7. 覆盖率、压力与失败注入

新增平台模块和新 App adapter 的 lines、branches、functions 各自不低于 95%。门槛按 changed
module 计算，不用仓库平均值掩盖未测试文件；纯类型文件可排除，但必须有 consumer contract
test。生成代码只在生成器与输入受测时排除。

发行候选还需通过：

- Runtime cold-ready p95 ≤5 秒，crash recovery ready p95 ≤8 秒；
- 连续 100 次 Runtime 启停、50 次 renderer reload，无重复事件、遗留进程或 socket；
- cooperative Abort ≤2 秒，不协作子进程强制回收 ≤5 秒；
- 同一 Runtime 同时打开 20 个 Session，文档、事件和 mutation queue 不串线；
- WebDAV/S3 各处理 10,000 path、1,000 unchanged blob、100 组分叉并随机断网；
- 磁盘满、只读目录、rename 失败、Runtime/main/renderer crash、网络 partial body、过期凭据、
  stale CAS、archive bomb、路径穿越和不确定 mutation outcome 均有稳定终态。

阈值变化必须先有性能证据和 ADR，不能在发布 PR 中临时放宽。

## 8. Evidence Manifest

每个 CI job 生成 `evidence.json` 并与原始测试报告一起上传，最小字段为：

```ts
type AcceptanceEvidence = {
  schemaVersion: 1
  commit: string
  acceptanceIds: string[]
  platform: 'linux' | 'macos' | 'windows'
  arch: string
  protocolVersion?: string
  runtimeVersion?: string
  catalogHashes?: Record<string, string>
  fixtureHashes: Record<string, string>
  commands: string[]
  results: Array<{ suite: string; status: 'passed' | 'failed'; report: string }>
  artifactHashes?: Record<string, string>
  redactionCheck: 'passed'
}
```

manifest 由测试工具生成，不接受人工编辑为 `passed`。RC 汇总器必须证明每个验收 ID 至少有一
条满足指定平台与时效的证据，并拒绝 commit 不同、fixture 漂移、缺 report、redaction 未过或
状态非 passed 的条目。

## 9. 跨切片实施票

以下只有真正被多个纵向切片共享的测试设施可以独立成票，拆票已批准、待发布：

| ID     | Title                                                        | Type | Blocked by | 覆盖验收                     |
| ------ | ------------------------------------------------------------ | ---- | ---------- | ---------------------------- |
| QA-I01 | 用 fake Provider 与协议向量建立可重复的 Agent contract/coverage gate | AFK  | #1、#2     | AR-001/002/006、QA-001       |
| QA-I02 | 生成 Catalog/Receipt evidence manifest 并汇总验收 ID         | AFK  | QA-I01、#5 | OT-001～005、OTC-001/002/010 |
| QA-I03 | 在安装包网络沙箱中审计 Genspark 依赖、字符串与请求           | AFK  | OT-I08     | GX-001～004                  |
| QA-I04 | 用隔离账号收集 Codex OAuth、MinerU 与同步 Provider 发行证据  | HITL | #12、#13、#24、#25 | MD-004/005、OCR、SY      |

App、MCP、Subagent、同步和 Slides 的测试仍归各自行为 Issue，不重复创建测试专票。

## 10. Reader Test

读者应能回答：

1. 为什么模型成功返回工具调用不能证明 Office mutation 正确？
2. 哪些测试能在普通 PR 运行，哪些必须取得上传或真实账号授权？
3. 一个 accepted schema vector 为什么必须同时经过 Runtime 与 Electron main？
4. 何时可以复用旧测试，何时旧 AgentLoop 测试必须删除？
5. 95% 覆盖率按什么边界计算，为什么仓库平均值不够？
6. 什么证据能证明 Windows 子进程已由 Job Object 或等价机制回收？
7. Slides 视觉截图为什么不能替代结构化 `SL-001` 断言？
8. live Provider 暂时不可用时，普通 PR 与 RC 分别如何处理？
9. Evidence Manifest 如何避免拿另一个 commit 或旧 fixture 的结果放行？
10. 哪些验收项绝不能 flaky retry 或人工豁免？
