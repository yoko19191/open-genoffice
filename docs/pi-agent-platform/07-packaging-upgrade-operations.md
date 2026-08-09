# 打包、升级与运维手册

<!-- markdownlint-disable MD013 MD060 -->

状态：Contract Stable

主要读者：Electron 构建、发布、安全、支持与值班工程师。

本文固定 `open-genoffice-pi-agent-runtime` 随 Electron 安装包交付后的资源布局、三平台证据、
升级清理、诊断与发布门。它以当前 `apps/shell/electron-builder.cjs`、CI 和 updater 为改造
基线，不把 Spike 目录或开发机 `node_modules` 当作生产资源。

## 1. 当前基线与必须修复的缺口

当前 Shell 已用 `extraResources` 携带四个应用模块和 XLSX sidecar，并有 macOS DMG/ZIP、
Windows NSIS、Linux AppImage 配置。现有构建仍显式校验和复制 `@genspark/cli`、nested
`commander` 与 `ws`；notices 工具也把 GSK 作为独立携带树。`promote-stable.yml` 只重指向
已发布的 macOS/Windows beta，不负责构建或验证，也没有 Linux stable promotion。

因此 G9 不是“再复制一个可执行文件”，而是同时完成：

- 用按目标平台构建的 Node/Pi Runtime tree 取代 GSK extraResources；
- 在 `beforePack` 前 fail closed 校验全树，打包后再次从解包/安装路径验证；
- 将 Runtime/MCP/Subagent 纳入签名、进程监督、升级和卸载证据；
- 建立 Linux 发行路径与三平台 RC evidence，stable promotion 只消费已验收产物；
- 让安装包、lockfile、notices、日志模板和运行时网络成为 Genspark-Free Build。

## 2. 已批准的发行决策

| ID      | 决策                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| PK-D01  | Runtime 是完整复制、无 symlink 的 Node `22.19.0` + unpacked ESM tree；不使用系统 Node、SEA、`npx` 或下载首启。 |
| PK-D02  | 每个安装包只携带自身 platform/arch 的 Runtime，不把三平台二进制塞入同一个包。                                |
| PK-D03  | 首版原生发行证据矩阵为 macOS arm64、Windows x64、Linux x64 glibc AppImage；增加架构需完整重跑同一 gate。       |
| PK-D04  | macOS/Linux 使用 UDS，Windows 使用 Named Pipe；stdio 仅用于 bootstrap 与 debug/test，不是正式业务传输。       |
| PK-D05  | Windows Runtime、MCP 与 Subagent 必须进入 kill-on-close Job Object 或经等价原生证据的监督边界。               |
| PK-D06  | Runtime tree、manifest、license/notices 与 app 属于一个不可拆分版本；禁止首启或后台静默更新其中一部分。       |
| PK-D07  | 同包没有旧 Runtime fallback；Runtime 故障只禁用 Agent，Office 本地编辑继续。                                  |
| PK-D08  | stable promotion 不重建；它只能推广同一 hash、已签名并具有完整 evidence manifest 的 RC artifact。            |
| PK-D09  | 首个 Pi 版本直接删除旧聊天、Provider/Genspark 凭据和云缓存，不迁移；清理器必须精确、幂等、可审计。            |
| PK-D10  | 卸载默认保留用户 Office 文件和 `~/.open-genoffice`；删除应用数据必须由用户另行明确确认。                       |

macOS x64、Linux arm64 或 Windows arm64 不因为 npm lock 中存在相应 optional package 就被视为
支持。目标架构只有在 Node hash、原生模块、安装、IPC、MCP/Subagent 和退出回收均由原生 runner
通过后才能加入发布矩阵。

## 3. Runtime bundle 与 manifest

### 3.1 安装包资源布局

目标布局固定为：

```text
resources/
├── modules/{docs,sheets,slides,pdf}/
├── native/xlsx-sidecar[.exe]
├── pi-agent-runtime/
│   ├── manifest.json
│   ├── node/
│   │   ├── open-genoffice-pi-agent-runtime[.exe]
│   │   └── <Node distribution support files>
│   ├── app/
│   │   ├── main.mjs
│   │   ├── chunks/
│   │   └── node_modules/
│   ├── built-in/
│   │   ├── skills/
│   │   ├── extensions/
│   │   └── prompts/
│   ├── LICENSE.node.txt
│   └── THIRD-PARTY-NOTICES.txt
├── THIRD-PARTY-NOTICES.txt
└── LICENSES.chromium.html
```

`app/`、Pi packages、Extension worker、MCP client、Subagent engine 和目标平台 `.node` 全部位于
asar 外。Electron app 的 JS 可以继续进入 `app.asar`，但 Runtime 不从 asar 虚拟路径执行、
不借用 Electron 内部 Node，也不解析开发机 workspace。

### 3.2 Manifest

`manifest.json` 至少包含：

```ts
type RuntimeBundleManifest = {
  manifestVersion: 1
  runtimeName: 'open-genoffice-pi-agent-runtime'
  runtimeVersion: string
  protocolVersion: string
  nodeVersion: '22.19.0'
  piVersion: '0.84.0'
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
  libc?: 'glibc'
  executable: string
  entry: string
  treeSha256: string
  files: Array<{ path: string; sha256: string; size: number; mode?: string }>
  noticesSha256: string
  generatedFromLockSha256: string
}
```

file path 必须是规范化相对路径并排序；hash 覆盖路径、mode、size 与 bytes。manifest 自身使用
独立 canonical serialization hash 放入外层 package evidence，避免自引用。tree 中出现
symlink、hardlink 逃逸、重复归一化路径、绝对路径、错误大小写或未登记文件时 fail closed。

### 3.3 构建工具落点

实现时新增以下窄工具，不把逻辑塞进 `electron-builder.cjs`：

```text
tools/build-pi-runtime-bundle.mjs
tools/verify-pi-runtime-bundle.mjs
tools/audit-genspark-free.mjs
tools/collect-acceptance-evidence.mjs
```

builder 只从根 `package-lock.json` 和固定 Node distribution 输入生成 Runtime tree；verifier 在
打包前、解包后和安装后复用同一校验。下载 Node 的步骤校验官方 `SHASUMS256.txt` 中的精确
SHA-256，缓存 key 必须包含 version/platform/arch/hash，不能信任文件名命中。

## 4. 可复制的构建顺序

发行 job 的逻辑顺序固定为：

```text
npm ci
  -> npm run licenses
  -> build/typecheck/test Runtime and protocol
  -> acquire and verify target Node 22.19.0
  -> build a fully copied Runtime tree
  -> generate and verify runtime manifest + notices + SBOM
  -> npm run build:all
  -> npm run notices
  -> electron-builder beforePack verification
  -> platform signing and installer creation
  -> unpack/install and verify the packaged tree again
  -> first launch + Agent/MCP/Subagent + shutdown/crash smoke
  -> Genspark static/network audit
  -> emit evidence.json and immutable artifact hashes
```

根 `package.json` 应增加显式、可本地复用的 `runtime:bundle:<platform>`、`runtime:verify`、
`audit:genspark-free` 和 `acceptance:evidence` scripts。release workflow 调用这些脚本，不在 YAML
中复制实现逻辑。缺 secret 的 contributor build 可以生成 unsigned artifact，但必须清楚标记，
且不能上传到 beta/stable feed。

`beforePack` 同时验证四应用 module tree、XLSX sidecar、Runtime tree、Chromium license、SBOM
与 notices。electron-builder 对缺失 `extraResources` 可能只警告，因此所有必需资源必须由
自有 verifier 主动 fail closed。

## 5. 平台矩阵

### 5.1 macOS arm64

- 使用官方 macOS arm64 Node `22.19.0`，Runtime executable 和所有 Mach-O/`.node` 架构必须
  为 arm64；不能夹带 x64 optional package。
- UDS 位于本次启动创建的私有短路径目录，目录 `0700`、socket `0600`；退出后目录移除。
- outer `.app` 签名前完成 Runtime executable、native `.node`/library 的 nested signing，随后
  签 app、生成 DMG/ZIP、公证并 staple；签名后不得再修改 Runtime tree。
- 安装 smoke 从 `/Applications` 启动，完成 fake Agent、stdio MCP、Subagent、Stop、显式退出、
  crash recovery、父进程强退和重启；`codesign --verify --deep --strict` 与 Gatekeeper 检查通过。

### 5.2 Windows x64

- 使用官方 `node-v22.19.0-win-x64.zip`；Node executable、`.node` 和 DLL 必须是 x64 PE。
- Named Pipe 名只含随机 96-bit 以上 nonce，不含用户、路径或文档；ACL 仅允许当前用户与
  必需系统主体。一次性握手 token、父 PID 与版本校验在真实 pipe 上运行。
- Runtime、每个 MCP/Subagent child 进入 kill-on-close Job Object。若第三方 server 再派生
  child，关闭 Electron、崩溃和 installer upgrade 后仍必须由原生 process census 证明清零。
- 先签 Runtime PE/native DLL，再签 Electron app 与 NSIS installer；签名后运行安装、可变
  安装目录、首次启动、upgrade、uninstall 和 `Get-AuthenticodeSignature` 检查。
- 静态 PE 检查、Wine 或 macOS 交叉构建不替代 `windows-2025` runner 的 Named Pipe/Job Object
  证据。

### 5.3 Linux x64 glibc AppImage

- 使用官方 Linux x64 Node `22.19.0` glibc distribution；首版不支持 musl/Alpine。
- Runtime、MCP 与 Subagent 进入独立 process group，正常退出先 cooperative shutdown，超时后
  只回收受管进程树；禁止 MCP daemonize。
- Node、Runtime entry 与 AppImage 内相关文件保留 `0755` executable bit；解包后的 manifest
  hash、ELF arch、glibc baseline、desktop entry、file association 和安装路径通过。
- 在受支持的 glibc runner 从 AppImage 完成首次启动、Agent/MCP/Subagent、crash recovery、
  upgrade 和退出回收。Linux stable feed 增加 versioned AppImage、checksum 与对应 update
  metadata；在该路径完成前不能宣称 Linux 自动升级可用。

## 6. 安装与首次启动

首次启动顺序为：

1. Electron 在不执行 Runtime 的情况下校验 bundle manifest、协议与目标架构；失败时 Panel
   显示 `runtime_bundle_invalid`，Office 编辑器仍可用。
2. 初始化或校验 `~/.open-genoffice/schema.json`、权限和目录。不得扫描 `~/.pi`、`.pi`、
   `~/.codex` 或 `.mcp.json`。
3. 运行精确 legacy cleanup manifest；先记录将删除的已知 key/path 结果，再幂等删除旧聊天、
   Provider/Genspark 凭据和云缓存，保留 Office 文件、项目资产与无关 app settings。
4. Electron 创建私有 endpoint 和 256-bit 一次性 token，经 inherited stdin 启动 Runtime；ready
   前不把 socket/token 暴露给 renderer。
5. Runtime 校验 parent PID、token、protocol/runtime version，获取 Credential broker 与 Resource
   Home capability，随后恢复文档 Session。
6. 干净安装保持 MinerU、项目资源、MCP 与同步默认关闭；没有用户配置时不发送任何第三方网络
   请求，更新检查遵循现有 updater channel 设置。

首次启动失败不得循环重启。supervisor 使用有界退避和 crash budget，超过阈值后保持 Office
可编辑、禁用 Agent 并提供诊断动作；不能切换旧 Runtime。

## 7. 升级、降级与旧数据清理

### 7.1 升级事务

installer 升级先要求各 app 停止新 run，取消 Provider/MCP/Subagent，查询所有 mutation receipt，
落盘 Session 和 Resume Capsule，再关闭 Runtime 与受管进程树。无法证明 mutation outcome 时
提示用户核对文档，不能为了升级自动重放。

新安装包把 app、Runtime、manifest 和 built-in resources 作为一个版本替换。首次启动依次
执行：bundle verify → schema compatibility → cleanup/migration journal → Runtime start。任一步
失败保留原 Resource Home，并提供回滚上一签名版本所需的诊断；不得半更新 Runtime tree。

### 7.2 Schema 与降级

- `schemaVersion` 只在数据形态不兼容时递增；migration 逐版本、幂等并记录在
  `state/migrations.json`，不能跨版本猜测。
- Pi 首版不迁移旧聊天或旧 Provider 凭据；它们由精确 cleanup manifest 删除。
- 新版本写入的未知文件/字段必须让上一受支持版本安全忽略；若旧版会误写或破坏数据，安装器
  必须阻止降级并说明原因。
- Provider Operation Resume Capsule 只能继续同一远端任务。升级后无法解密或版本不兼容时
  标记 `interrupted`，绝不重新提交计费请求。
- sync revision、Office 文件和 Conflict Copy 使用稳定普通格式；升级失败不能删除或把远端
  分叉覆盖到 Local Current。

### 7.3 Cleanup manifest

清理器只接受审核过的显式相对路径和 JSON key，不接受 HOME、`~`、递归根、glob、正则路径
替换或 follow-symlink。每条规则声明 owner、introducedBefore、action、expected type 和
preserve siblings；执行前 realpath 必须仍位于 Electron userData。

`GX` 扫描可以为该集中升级模块维护最小历史 key allowlist，但正式 bundle 中不能保留 Genspark
登录 UI、网络 endpoint、CLI、模型或 credits 文案。

## 8. 退出、崩溃与卸载

正常退出按 child-first 顺序：停止接收 prompt → Abort active runs → 取消 Subagent descendants →
关闭 MCP → 保存 Session/operation state → Runtime shutdown → 等待进程退出 → 清理 endpoint/temp。
cooperative 操作 2 秒内停止；不协作受管子进程最迟 5 秒强制回收。

父 stdin EOF、Electron crash、操作系统注销和 installer upgrade 必须触发等价回收。Runtime
不能 daemonize，也不能在所有 Electron app 退出后常驻。多窗口/多文档由当前 Electron app
instance 的一个 Runtime 管理；另一个 app process 拥有自己的 Runtime 和 lease，不能双写同一
Session。

卸载默认删除 app、Runtime、installer cache、socket/temp 和非用户诊断缓存，保留：

- 用户的 DOCX/XLSX/PPTX/PDF 与项目目录；
- `~/.open-genoffice` 中的 Session、Assets、Conflict Copy、配置与同步历史；
- OS CredentialStore 中仍被保留配置引用的 credential。

“同时删除 Agent 数据”必须是单独的用户确认动作，逐项说明将删除 Resource Home 与凭据；
不得把普通 Office 项目目录或项目级 `.open-genoffice` 一并递归删除。

## 9. 诊断与支持包

Runtime metadata 日志位于 `~/.open-genoffice/agent/logs/`，有界轮转、不可同步。日志只记录
时间、runtime/protocol/provider/server/tool ID、状态、耗时、错误类别和 correlation ID；不记录
prompt、正文、工具参数/结果、token、完整 URL、路径、图片 base64 或 signed URL。

Panel 的“导出诊断”生成用户可预览的压缩包，默认包含：

- app/runtime/protocol/platform/arch 版本与 manifest hash；
- bundle verify、Resource Home 权限、Session lease、MCP/Subagent process census；
- 脱敏的 Provider/MCP/OCR/Sync 状态与最近错误类别；
- coverage/acceptance 不属于用户诊断包，生产日志也不包含 Office 内容。

导出前运行 secret/path/URL canary scanner；发现无法可靠脱敏的文件就排除并列出原因。支持人员
不应要求用户发送 CredentialStore、Pi JSONL Session、Office 文件或完整 `.open-genoffice`。

常见故障的产品动作固定为：

| 故障                         | 用户可见动作                                                     |
| ---------------------------- | ---------------------------------------------------------------- |
| bundle hash/arch/signature   | 禁用 Agent，显示重装与导出诊断；不尝试网络修复 Runtime tree      |
| IPC handshake/version        | 有界重启；持续失败后禁用 Agent，不放宽 token/version             |
| Runtime crash budget exhausted | Office 继续编辑，保存诊断，等待用户重启应用                     |
| MCP/Subagent orphan          | 强制回收受管树并将 RC 标为失败；不静默忽略                       |
| Credential unavailable       | 只禁用对应 Provider，提示重新登录/配置                           |
| MinerU/同步不可用            | 保留原 PDF/Local Current/已下载 artifact，不切换服务或覆盖文件    |
| mutation outcome unknown     | 阻塞该文档 mutation queue，引导用户核对，不自动重试              |

## 10. 发布、推广与回滚

### 10.1 RC 硬门

发行汇总器必须验证同一 commit 和 artifact hash 的：

- 文档 06 中全部 `AR/OT/MD/RS/MCP/SA/OCR/SY/SL/GX/PK/QA` evidence；
- 三平台原生安装、首次启动、fake Agent、stdio MCP、Subagent、退出、崩溃、升级与卸载；
- macOS notarization、Windows Authenticode、Linux executable/glibc/AppImage；
- runtime manifest、asar/unpacked、SBOM、license、notices 与 lockfile 一致；
- Genspark source/dependency/string/bundle/network 四类审计零未解释命中；
- 干净 HOME 只创建 `.open-genoffice`，MinerU/MCP/同步默认关闭；
- Slides `SL-001`、旧数据幂等清理和同步 Local Current 不变量。

任何一项失败都不得生成可推广的 release manifest，也不能以 `force` 绕过。现有 stable
promotion 的 `force` 只允许有审计记录地选择较旧、已经完整验收的版本，不允许推广未通过门禁
的新 artifact。

### 10.2 产物与推广

RC 产物命名包含 product/version/platform/arch，旁挂 SHA-256、SBOM、notices、签名信息与
`evidence.json`。beta/stable feed 引用不可变 versioned artifact；marketing alias 只在 promotion
后更新。推广不重新构建、不重新签名、不替换 Runtime bundle。

Linux 加入与 macOS/Windows 同等的 beta/stable manifest 校验和版本保护。在实现前，现有
`promote-stable.yml` 不能被视为完整三平台发行流程。

### 10.3 回滚

回滚选择上一版完整验收和签名的 versioned artifact，并重新指向 feed；不得重打包旧版本。
回滚前检查 Resource Home schema compatibility，安装后重跑 bundle verify、Runtime start、
Session open 与 Office 文件 smoke。回滚不恢复 Genspark、旧 AgentLoop、旧聊天或旧凭据。

## 11. 实施切片

以下拆票已经批准，按依赖顺序发布：

| ID     | Title                                                           | Type | Blocked by                | 覆盖验收                 |
| ------ | --------------------------------------------------------------- | ---- | ------------------------- | ------------------------ |
| PK-I01 | 构建并校验当前平台 Runtime bundle，随 unsigned Electron 包首次启动 | AFK  | #1、QA-I01               | AR-009/010、PK-001       |
| PK-I02 | 在 macOS arm64 签名、公证并回收 Runtime/MCP/Subagent 进程树       | HITL | PK-I01、#20、#22         | AR-003/009/010、PK-002   |
| PK-I03 | 在 Windows x64 以 Named Pipe 与 Job Object 完成安装升级退出       | HITL | PK-I01、#20、#22         | AR-003/009/010、PK-001/2 |
| PK-I04 | 在 Linux x64 glibc AppImage 完成安装升级退出和 feed 产物          | AFK  | PK-I01、#20、#22         | AR-003/009/010、PK-001/2 |
| PK-I05 | 幂等清理旧 Agent 数据并验证升级、降级、卸载保留边界              | AFK  | #11、PK-I01              | AR-008、GX-002、PK-002   |
| PK-I06 | 汇总验收、SBOM 与 Genspark-Free 审计后推广同一 RC artifact        | HITL | OT-I08、QA-I03/04、PK-I02～05 | GX-001～004、QA-001 |

HITL 表示需要发行证书、受保护环境或用户确认；实现与无签名 smoke 仍应尽量由 AFK Agent 完成。

## 12. Reader Test

读者应能回答：

1. 为什么 Runtime 必须是完整复制的 unpacked tree，而不能使用 Electron Node 或首次启动下载？
2. manifest 的 tree hash 如何避免 symlink、漏文件和错误架构被打进安装包？
3. macOS nested signing、Windows Job Object、Linux executable bit 分别在哪一步验证？
4. 为什么 Windows 静态 PE 检查不能替代 Named Pipe 与进程回收实跑？
5. installer 升级前遇到 `mutationOutcome=unknown` 应如何处理？
6. 旧聊天与凭据为何直接清理，哪些 Office/项目数据必须保留？
7. 用户诊断包为什么不能包含 Pi Session 或整个 `.open-genoffice`？
8. stable promotion 为什么不能重建或重新签名 RC？
9. `force` 可以回滚到什么版本，又绝不能绕过哪些门？
10. 一个新 platform/arch 何时才可以宣称受到支持？
